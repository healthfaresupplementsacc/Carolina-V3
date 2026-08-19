'use strict';
/**
 * HEALTHFARE V3 — Operator stock handlers (S15 Fase 2, Bruno 08-18).
 *
 * TODA a lógica de estoque do /op mora aqui. src/routes/op.js só CHAMA
 * (arquivo grande demais, regra do CLAUDE.md: nada de linha nova lá).
 *
 * REGRAS DO BRUNO (estudo S15 §0/§10):
 *  - "Peguei do estoque" NÃO escreve movimento. Vira PROPOSTA pendente
 *    (StockRequestService.propose kind 'take' direction 'out'); o admin aprova
 *    e aí sim o StockService.pick deduz de verdade. O INSERT cru que existia em
 *    op.js:314-329 (R076, o caminho duplo do livro-razão) morre com este arquivo.
 *  - "Danificada" é FATO FÍSICO: aplica na hora via StockService.separate
 *    (a garrafa já está de lado, esconder isso seria mentir pro estoque).
 *  - REGRA #0: propor nunca é bloqueado. Só validação de forma (produto, qty).
 *  - Sandbox → is_test em tudo (proposta e issue), nunca contamina o real.
 *
 * createOpStock({db, stock, requests}) → {take, propose, recent}
 *   db       pool pg (leitura do "Registrado hoje")
 *   stock    StockService (porta única de escrita — o mesmo do kiosk)
 *   requests StockRequestService (fila de aprovação)
 * Cada função recebe (session, body) e devolve {status?, body} — quem responde
 * é o route handler, então este módulo não conhece Express.
 */

const PROPOSE_KINDS = ['entrada', 'count', 'return_in'];
const SEPARATE_REASONS = ['label', 'seal'];   // resto cai em 'other'
const RECENT_HOURS = 16;
const RECENT_MAX = 30;

function bad(error, detail) { return { status: 400, body: detail ? { error, detail } : { error } }; }
function intOf(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function textOf(v, max) { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null; }

function createOpStock(deps = {}) {
  const db = deps.db;
  const stock = deps.stock;
  const requests = deps.requests;

  /** POST stock/take {product_id, qty, kind:'pick'|'damaged', reason?} */
  async function take(session, body) {
    const b = body || {};
    const productId = intOf(b.product_id);
    const qty = intOf(b.qty);
    const kind = b.kind === 'damaged' ? 'damaged' : 'pick';
    if (productId == null) return bad('product_id obrigatório', 'Escolha o produto.');
    if (qty == null || qty <= 0 || qty > 5000) return bad('quantidade inválida', 'Quantidade entre 1 e 5000.');
    const reason = textOf(b.reason, 300);

    if (kind === 'damaged') {
      // fato físico: a garrafa já saiu do vendável. Aplica agora (Separadas).
      const out = await stock.separate({
        product_id: productId, qty,
        reason: SEPARATE_REASONS.includes(b.reason) ? b.reason : 'other',
        bin_id: b.bin_id || null, person_id: session.person_id,
        source: 'op_kiosk', note: reason, actor_type: 'operator',
        is_test: !!session.is_sandbox,
      });
      return { body: { ok: true, kind: 'damaged', issue_id: out.issue ? out.issue.id : null, applied: out.applied || 0 } };
    }

    // pick: PROPOSTA. Sai do Disponível na hora, do total só quando aprovarem.
    const req = await requests.propose({
      product_id: productId, kind: 'take', direction: 'out', qty,
      reason, note: reason, person_id: session.person_id,
      login: session.display_name || null, is_test: !!session.is_sandbox,
    });
    return { body: { ok: true, kind: 'take', request_id: req.id, status: 'pending' } };
  }

  /** POST stock/propose {product_id, kind:'entrada'|'count'|'return_in', qty, bin_id?, box_id?, reason?} */
  async function propose(session, body) {
    const b = body || {};
    const productId = intOf(b.product_id);
    const qty = intOf(b.qty);
    const kind = String(b.kind || '');
    if (!PROPOSE_KINDS.includes(kind)) return bad('kind_invalid', 'Tipo inválido: ' + PROPOSE_KINDS.join(', '));
    if (productId == null) return bad('product_required', 'Escolha o produto.');
    if (qty == null || qty <= 0 || qty > 100000) return bad('qty_required', 'Quantidade maior que 0.');
    const binId = intOf(b.bin_id);
    const boxId = intOf(b.box_id);
    // contagem sem lugar não diz nada: contou O QUE, onde? (plano S15 §contrato)
    if (kind === 'count' && binId == null && boxId == null) {
      return bad('location_required', 'Diga a prateleira ou a caixa que você contou.');
    }
    const reason = textOf(b.reason, 300);
    const req = await requests.propose({
      product_id: productId, kind, direction: 'in', qty,
      bin_id: binId, box_id: boxId,
      reason, note: kind === 'count' ? 'contagem: found=' + qty : reason,
      person_id: session.person_id, login: session.display_name || null,
      is_test: !!session.is_sandbox,
    });
    return { body: { ok: true, kind, request_id: req.id, status: 'pending' } };
  }

  /**
   * GET stock/recent → o que ESTE operador registrou nas últimas 16h, com o
   * estado de cada linha. Três fontes, uma lista só:
   *   propostas (pendente/aprovado/recusado) + danificadas (aplicado) +
   *   reposições de prateleira (aplicado).
   */
  async function recent(session) {
    const personId = session.person_id;
    const isTest = !!session.is_sandbox;
    const [reqs, issues, moves] = await Promise.all([
      db.query(
        `SELECT q.id, q.kind, q.qty, COALESCE(q.reason, q.note) AS note, q.created_at, q.status,
                p.canonical_name AS product, p.nickname
           FROM v3.stock_change_requests q JOIN v3.products p ON p.id = q.product_id
          WHERE q.proposed_by_person_id = $1 AND q.is_test = $2
            AND q.created_at > NOW() - INTERVAL '${RECENT_HOURS} hours'
          ORDER BY q.created_at DESC LIMIT ${RECENT_MAX}`,
        [personId, isTest]),
      db.query(
        `SELECT i.id, i.qty, i.note, i.created_at, i.reason,
                p.canonical_name AS product, p.nickname
           FROM v3.stock_issues i JOIN v3.products p ON p.id = i.product_id
          WHERE i.person_id = $1 AND i.is_test = $2
            AND i.created_at > NOW() - INTERVAL '${RECENT_HOURS} hours'
          ORDER BY i.created_at DESC LIMIT ${RECENT_MAX}`,
        [personId, isTest]),
      db.query(
        `SELECT m.id, m.qty, m.note, m.created_at,
                p.canonical_name AS product, p.nickname
           FROM v3.stock_movements m LEFT JOIN v3.products p ON p.id = m.product_id
          WHERE m.person_id = $1 AND m.is_test = $2 AND m.kind = 'restock'
            AND m.created_at > NOW() - INTERVAL '${RECENT_HOURS} hours'
          ORDER BY m.created_at DESC LIMIT ${RECENT_MAX}`,
        [personId, isTest]),
    ]);
    const items = [];
    for (const r of reqs.rows) {
      items.push({ id: 'req:' + r.id, kind: r.kind, qty: Math.abs(Number(r.qty) || 0),
        note: r.note || null, created_at: r.created_at, product: r.product,
        nickname: r.nickname || null, status: r.status });
    }
    for (const r of issues.rows) {
      items.push({ id: 'issue:' + r.id, kind: 'damaged', qty: Math.abs(Number(r.qty) || 0),
        note: r.note || r.reason || null, created_at: r.created_at, product: r.product,
        nickname: r.nickname || null, status: 'applied' });
    }
    for (const r of moves.rows) {
      items.push({ id: 'mov:' + r.id, kind: 'restock', qty: Math.abs(Number(r.qty) || 0),
        note: r.note || null, created_at: r.created_at, product: r.product || null,
        nickname: r.nickname || null, status: 'applied' });
    }
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { body: { ok: true, items: items.slice(0, RECENT_MAX) } };
  }

  return { take, propose, recent };
}

module.exports = { createOpStock, PROPOSE_KINDS, RECENT_HOURS, RECENT_MAX };
