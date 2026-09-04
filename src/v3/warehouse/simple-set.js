'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — MODO SIMPLES: quantidade ABSOLUTA por escopo
 * (Fase 1 do MASTER-SYNC-PLAN, mutirão da carga física, Bruno 09-04).
 *
 * A página do mutirão precisa de UMA operação: "Berberine, 23 na prateleira,
 * 88 na caixa" digitado direto na linha. POST /api/v3/warehouse/simple/set
 * recebe a quantidade ABSOLUTA contada de um escopo (shelf | box | unplaced),
 * calcula o delta contra o sistema e aplica SÓ verbos do StockService (porta
 * única de quantidade — NUNCA SQL cru de estoque):
 *
 *   delta > 0  →  storeIn (entra no "a organizar") + place até o local do
 *                 escopo (mesmo par da porta da carga, load.js)
 *   delta < 0  →  shelf/caixa: count(found = alvo), o verbo ABSOLUTO que já
 *                 existe (contagem física é a única autoridade que corrige o
 *                 livro); a organizar: adjust com o branch unplaced
 *   delta = 0  →  nada a fazer (e é exatamente isso que torna o retry seguro)
 *
 * MODO SIMPLES = UM local por tipo. Produto com 2+ prateleiras ou 2+ caixas
 * volta 409 multi_location com a dica de usar o Modo completo — o simples não
 * pode chutar em qual das prateleiras a contagem foi feita.
 *
 * Locais nascem AQUI quando não existem (é a página que carrega o zero):
 *  - prateleira: bin_code obrigatório na primeira vez; cria via LocationsRepo
 *    (qty nasce 0, só o StockService enche);
 *  - caixa: número alocado pelo MESMO alocador da aprovação
 *    (StockRequestService._allocateBoxNumber, 'BX-0451' sequencial) — dois
 *    formatos de número de caixa seria drift na certa.
 *
 * Idempotente por client_ref (uuid): source_ref 'simpleset:<uuid>'. O retry
 * recalcula o delta (já aplicado → 0 → no-op) e, se o mundo mudou no meio, o
 * ON CONFLICT do StockService recusa a repetição do mesmo ref sozinho.
 */

const { StockRequestService } = require('../services/StockRequestService');
const { UUID_RE, QTY_MAX } = require('./load');

const SCOPES = ['shelf', 'box', 'unplaced'];
const SCOPE_PT = { shelf: 'prateleira', box: 'caixa', unplaced: 'a organizar' };

const intOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * O MESMO alocador de número de caixa da aprovação (S15 F3). Chamado no
 * prototype de propósito: um alocador só no sistema inteiro; o método não usa
 * `this`, só o client/pool que recebe.
 */
const allocateBoxNumber = (client) =>
  StockRequestService.prototype._allocateBoxNumber.call(null, client);

/**
 * O placar do mutirão (contrato B do overview): quantos produtos já batem com
 * a Veeqo e quantas garrafas já foram contadas. Sai das MESMAS Rows do hub —
 * nenhuma conta paralela pra divergir um dia.
 * @param {Array} rows Rows já enriquecidas (veeqo_total presente)
 * @returns {{products:number, matching:number, bottles_counted:number, veeqo_bottles:number}}
 */
function simpleProgress(rows = []) {
  let matching = 0; let bottles = 0; let veeqoBottles = 0;
  for (const r of rows) {
    const total = Number(r.total) || 0;
    bottles += total;
    if (r.veeqo_total != null) {
      veeqoBottles += Number(r.veeqo_total) || 0;
      if (Number(r.veeqo_total) === total) matching += 1;
    }
  }
  return { products: rows.length, matching,
    bottles_counted: bottles, veeqo_bottles: veeqoBottles };
}

/**
 * @param {object} deps
 *   deps.db            pool pg (SÓ leitura de locais; quantidade é StockService)
 *   deps.stock         StockService (a ÚNICA escrita de quantidade)
 *   deps.locations     LocationsRepo (cadastro de bin/caixa, nunca qty)
 *   deps.rowsWithVeeqo (productId|null) → Rows enriquecidas (mesmas do hub)
 */
function createSimpleSet(deps = {}) {
  const { db, stock, locations, rowsWithVeeqo } = deps;

  const binsOf = async (productId) => (await db.query(
    `SELECT id, bin_code, product_id, qty FROM v3.stock_bins
      WHERE product_id = $1 AND active ORDER BY id`, [productId])).rows;

  const boxesOf = async (productId) => (await db.query(
    `SELECT id, box_number, box_type_id, product_id, qty FROM v3.stock_boxes
      WHERE product_id = $1 AND status = 'in_storage' ORDER BY id`, [productId])).rows;

  const unplacedOf = async (productId) => {
    const r = await db.query(
      'SELECT qty FROM v3.stock_unplaced WHERE product_id = $1', [productId]);
    return r.rows[0] ? Number(r.rows[0].qty) || 0 : 0;
  };

  /** 409 do contrato: 2+ locais do mesmo tipo → o simples não chuta qual. */
  function multiLocation(scope, list) {
    const nome = scope === 'shelf' ? 'prateleiras' : 'caixas';
    const codes = list.map((l) => l.bin_code || l.box_number).join(', ');
    const e = new Error(`Este produto tem ${list.length} ${nome} (${codes}). ` +
      'O Modo simples trabalha com um local só de cada tipo: use o Modo completo para escolher onde ajustar.');
    e.code = 'multi_location';
    e.status = 409;
    return e;
  }

  /** A resposta do contrato A: números frescos + o check da Veeqo + os locais. */
  async function summaryOf(productId, homeBin, mainBox) {
    const rows = await rowsWithVeeqo(Number(productId));
    const r = rows[0];
    if (!r) throw new Error('produto não existe: ' + productId);
    const total = Number(r.total) || 0;
    const veeqoTotal = r.veeqo_total != null ? Number(r.veeqo_total) : null;
    return {
      product_id: r.product_id,
      veeqo_total: veeqoTotal,
      shelf_qty: Number(r.shelf_qty) || 0,
      box_qty: Number(r.box_qty) || 0,
      unplaced_qty: Number(r.unplaced_qty) || 0,
      total,
      delta_veeqo: veeqoTotal == null ? null : total - veeqoTotal,
      match: veeqoTotal != null && total === veeqoTotal,
      home_bin: homeBin ? { id: homeBin.id, bin_code: homeBin.bin_code } : null,
      main_box: mainBox ? { id: mainBox.id, box_number: mainBox.box_number,
        box_type_id: mainBox.box_type_id != null ? mainBox.box_type_id : null } : null,
    };
  }

  /**
   * A operação. body: {product_id, scope ('shelf'|'box'|'unplaced'),
   * qty (int >= 0, ABSOLUTO), bin_code? (só shelf sem prateleira ainda),
   * box_type_id? (só box sem caixa ainda), client_ref (uuid)}.
   * ctx: {person_id, login} de quem está logado.
   * @returns {{applied:number, duplicate:boolean, summary:object}}
   */
  async function set(body = {}, ctx = {}) {
    const productId = intOf(body.product_id);
    if (!productId || productId <= 0) throw new Error('product_id inválido');
    const scope = String(body.scope || '');
    if (!SCOPES.includes(scope)) {
      throw new Error('scope inválido (shelf, box ou unplaced)');
    }
    const qty = intOf(body.qty);
    if (qty == null || qty < 0 || qty > QTY_MAX) {
      throw new Error(`qty inválido (inteiro de 0 a ${QTY_MAX}, a quantidade ABSOLUTA contada)`);
    }
    const clientRef = String(body.client_ref || '').trim();
    if (!UUID_RE.test(clientRef)) {
      throw new Error('client_ref inválido (uuid, é a idempotência do clique)');
    }

    const ref = 'simpleset:' + clientRef.toLowerCase();
    const who = ctx.login || 'admin';
    const common = {
      product_id: productId, person_id: ctx.person_id || null,
      actor_type: 'admin', source: 'warehouse_simple',
    };

    let applied = 0; let duplicate = false;
    const noteFor = (current) =>
      `[${who}] Modo simples: ${SCOPE_PT[scope]} contada ${qty}, sistema tinha ${current}`;

    if (scope === 'unplaced') {
      const current = await unplacedOf(productId);
      const delta = qty - current;
      if (delta > 0) {
        // sem bin e sem caixa o storeIn cai no bucket "a organizar"
        const stored = await stock.storeIn({ ...common, qty: delta,
          source_ref: ref, note: noteFor(current) });
        applied = stored.applied || 0; duplicate = !!stored.duplicate;
      } else if (delta < 0) {
        // o único verbo que DESCE o "a organizar" sem mover pra local: o branch
        // unplaced do adjust (fix da célula que nunca salvava, plano tarefa 0.4)
        const adj = await stock.adjust({ ...common, qty: delta, unplaced: true,
          source_ref: ref, note: noteFor(current) });
        applied = adj.applied || 0; duplicate = !!adj.duplicate;
      }
    } else if (scope === 'shelf') {
      const bins = await binsOf(productId);
      if (bins.length > 1) throw multiLocation('shelf', bins);
      let bin = bins[0] || null;
      if (!bin) {
        const code = String(body.bin_code || '').trim().toUpperCase();
        if (!code) {
          throw new Error('bin_code obrigatório: este produto ainda não tem prateleira; ' +
            'informe o código para criar a primeira (ex.: A03B2)');
        }
        const up = await locations.upsertBin({ bin_code: code, product_id: productId });
        if (up.product_id && Number(up.product_id) !== productId) {
          throw new Error(`bin_code inválido: a prateleira ${code} já pertence a outro produto`);
        }
        bin = up;
      }
      const current = Number(bin.qty) || 0;
      const delta = qty - current;
      if (delta > 0) {
        const stored = await stock.storeIn({ ...common, qty: delta,
          source_ref: ref, note: noteFor(current) });
        applied = stored.applied || 0; duplicate = !!stored.duplicate;
        await stock.place({ ...common, qty: delta, bin_id: bin.id,
          source_ref: ref + ':place', note: noteFor(current) });
      } else if (delta < 0) {
        // count é o verbo ABSOLUTO que já existe: seta a prateleira no contado
        const counted = await stock.count({ bin_id: bin.id, found: qty,
          person_id: common.person_id, actor_type: 'admin',
          source: common.source, source_ref: ref, note: noteFor(current) });
        applied = counted.applied || 0; duplicate = !!counted.duplicate;
      }
    } else {                                          // scope === 'box'
      const boxes = await boxesOf(productId);
      if (boxes.length > 1) throw multiLocation('box', boxes);
      let box = boxes[0] || null;
      if (!box) {
        const number = await allocateBoxNumber(db);
        box = await locations.upsertBox({ box_number: number, product_id: productId,
          box_type_id: intOf(body.box_type_id) || null });
      }
      const current = Number(box.qty) || 0;
      const delta = qty - current;
      if (delta > 0) {
        const stored = await stock.storeIn({ ...common, qty: delta,
          source_ref: ref, note: noteFor(current) });
        applied = stored.applied || 0; duplicate = !!stored.duplicate;
        await stock.place({ ...common, qty: delta, box_id: box.id,
          source_ref: ref + ':place', note: noteFor(current) });
      } else if (delta < 0) {
        const counted = await stock.count({ box_id: box.id, found: qty,
          person_id: common.person_id, actor_type: 'admin',
          source: common.source, source_ref: ref, note: noteFor(current) });
        applied = counted.applied || 0; duplicate = !!counted.duplicate;
      }
    }

    // locais frescos (inclui o que acabou de nascer), números frescos
    const [binsNow, boxesNow] = await Promise.all([binsOf(productId), boxesOf(productId)]);
    const summary = await summaryOf(productId, binsNow[0] || null, boxesNow[0] || null);
    return { applied, duplicate, summary };
  }

  return { set, summaryOf };
}

module.exports = { createSimpleSet, simpleProgress, SCOPES, SCOPE_PT };
