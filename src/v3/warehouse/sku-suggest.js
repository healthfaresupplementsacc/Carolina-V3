'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — SUGESTÕES de parentesco de SKU (Bruno 08-19).
 *
 * O problema, no print do Bruno: 190+ linhas no hub onde 'AKKERM-INULIN' aparece
 * duas vezes, 'Apple Cider Vinegar' tem só um SKU "x4 kit" e 'Banaba Leaf 3000mg'
 * não tem SKU nenhum. Cada listagem da Veeqo que ganhou linha própria virou um
 * produto separado, e fisicamente é a MESMA garrafa na MESMA prateleira.
 *
 * Este módulo NÃO junta nada. Ele só propõe grupos, com o MOTIVO em português, e
 * um humano confirma. Merge errado é desastre de expedição (memória
 * 'merge-safety-rules'): juntar dois produtos parecidos que na verdade são doses
 * diferentes manda a garrafa errada pro cliente. Por isso:
 *
 *   • NUNCA auto-merge. A resposta é uma proposta, ponto.
 *   • Dose diferente NUNCA agrupa: "Berberine 1000mg" e "Berberine 6000mg" são
 *     produtos distintos de verdade. A dose entra na chave de normalização.
 *   • Só agrupa produto que ainda não foi absorvido por outro.
 *
 * Os quatro sinais, do mais forte pro mais fraco:
 *   1) MESMO CÓDIGO DE BARRAS (UPC): a garrafa é literalmente a mesma → 'alta'.
 *   2) MESMO SKU BASE antes do sufixo de pacote (-C2/-C3/-C4, 'x3 kit') → 'alta'.
 *   3) KIT da Veeqo com nome derivado de uma variante base existente → 'média'.
 *   4) MESMO NOME normalizado ignorando pacote (a dose FICA) → 'média'/'baixa'.
 */

// Teto da resposta: a tela é pra decidir, não pra ler 500 grupos. 200 é bem mais
// do que os ~190 produtos do hub inteiro, então na prática nunca corta nada real.
const MAX_GROUPS = 200;

/**
 * Normalização de nome (ideia do norm() do stock-gap-service + normProductName do
 * ems-activity-sync, juntas num lugar só).
 *
 * ATENÇÃO: a DOSE FICA. O ems normProductName tira "400mg" porque lá o objetivo é
 * deduplicar o mesmo produto escrito de dois jeitos. Aqui tirar a dose faria
 * "Berberine 1000mg" e "Berberine 6000mg" caírem no mesmo grupo, e alguém ia
 * confirmar no automático. O que sai é só o que descreve EMBALAGEM.
 */
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/healthfare|healtfare/g, '')
    // sufixos de casepack: "- C4", "c3", "x3 kit", "3 pack", "pack of 2", "kit"
    .replace(/\bpack\s+of\s+\d+\b/g, ' ')
    .replace(/\bx\s*\d+\s*(kit|pack)?\b/g, ' ')
    .replace(/\b\d+\s*(pack|pk|kit|ct\s*pack)\b/g, ' ')
    .replace(/\bc\d+\b/g, ' ')
    .replace(/\bkit\b/g, ' ')
    .replace(/\b(bottles?|units?|count)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Quantas unidades o nome/SKU diz que vem no pacote, ou null se não diz nada.
 * "BEET-2000-C3" → 3 · "Beet Root 2000mg - C4" → 4 · "Apple Cider Vinegar x4 kit" → 4
 */
function packOf(s) {
  const t = String(s || '').toLowerCase();
  let m = t.match(/[-_\s]c(\d+)\b/);            if (m) return Number(m[1]);
  m = t.match(/\bx\s*(\d+)\s*(kit|pack)\b/);    if (m) return Number(m[1]);
  m = t.match(/\bpack\s+of\s+(\d+)\b/);         if (m) return Number(m[1]);
  m = t.match(/\b(\d+)\s*(pack|pk|kit)\b/);     if (m) return Number(m[1]);
  return null;
}

/**
 * Raiz do SKU: tira o sufixo de casepack. 'BEET-2000-C3' → 'BEET-2000'.
 * Sem sufixo devolve o próprio SKU normalizado (o base é raiz de si mesmo).
 */
function skuRoot(sku) {
  const s = String(sku || '').trim().toUpperCase();
  if (!s) return '';
  return s
    .replace(/[-_\s]*C\d+$/, '')
    .replace(/[-_\s]*X\d+(KIT|PACK)?$/, '')
    .replace(/[-_\s]*(KIT|PACK)$/, '')
    .replace(/[-_\s]+$/, '');
}

/** Sinal (score) → rótulo PT-BR que o humano lê antes de confirmar. */
function confidenceOf(score) {
  if (score >= 90) return 'alta';
  if (score >= 60) return 'média';
  return 'baixa';
}

/**
 * O PAI sugerido de um grupo: a garrafa avulsa. Escolha, em ordem:
 *   1) quem tem SKU com units_per_pack = 1 (é a unidade de verdade);
 *   2) quem tem estoque físico (o local já é dele; mover menos garrafa é melhor);
 *   3) o menor product_id (mais antigo = o cadastro original).
 * Empate resolvido sempre do mesmo jeito: a sugestão não pode mudar a cada F5.
 */
function pickParent(members) {
  const rank = (m) => (
    (m.min_units_per_pack === 1 ? 0 : 100)
    + (m.has_stock ? 0 : 10)
  );
  return members.slice().sort((a, b) => (rank(a) - rank(b)) || (a.product_id - b.product_id))[0];
}

/**
 * Monta os grupos a partir das linhas do overview (uma por produto físico vivo).
 *
 * @param {Array} rows linhas do StockService.overview (com skus[], total, etc.)
 * @param {object} bySku mapa do veeqo-cache: SKU→{type,wh,upc}
 * @returns {{groups:Array, counts:object}}
 */
function suggest(rows = [], bySku = {}) {
  // 1) achata: um "membro" por produto, já com o que os quatro sinais precisam
  const members = [];
  for (const r of rows) {
    if (r.retired || r.merged_into_product_id) continue;   // fantasma não entra
    const skus = Array.isArray(r.skus) ? r.skus : [];
    const packs = skus.map((s) => Number(s.units_per_pack) || 1);
    const upcs = new Set();
    let anyKit = false;
    for (const s of skus) {
      const info = bySku[String(s.sku).trim().toUpperCase()] || null;
      const upc = (s.barcode || (info && info.upc) || '').toString().trim();
      if (upc) upcs.add(upc);
      if ((info && info.type === 'kit') || (Number(s.units_per_pack) || 1) > 1) anyKit = true;
    }
    members.push({
      product_id: r.product_id,
      name: r.name,
      nickname: r.nickname || r.name,
      sku: r.base_sku || (skus[0] ? skus[0].sku : null),
      skus,
      units_per_pack: packs.length ? Math.min(...packs) : 1,
      min_units_per_pack: packs.length ? Math.min(...packs) : 1,
      veeqo_qty: r.veeqo && r.veeqo.physical != null ? Number(r.veeqo.physical) : null,
      has_stock: Number(r.total) > 0,
      is_kit_only: anyKit && (!packs.length || Math.min(...packs) > 1),
      upcs: Array.from(upcs),
      norm_name: normName(r.name),
      norm_nick: normName(r.nickname || ''),
      sku_roots: Array.from(new Set(skus.map((s) => skuRoot(s.sku)).filter(Boolean))),
    });
  }

  // 2) indexa por cada sinal. Um produto pode cair em mais de um índice; a
  //    deduplicação vem depois (o grupo mais forte ganha o produto).
  const index = (keyFn) => {
    const m = new Map();
    for (const x of members) {
      for (const k of keyFn(x)) {
        if (!k) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(x);
      }
    }
    return m;
  };

  const byUpc = index((x) => x.upcs);
  const byRoot = index((x) => x.sku_roots);
  const byName = index((x) => [x.norm_name, x.norm_nick].filter(Boolean));

  // 3) candidatos, do sinal mais forte pro mais fraco
  const candidates = [];
  const push = (list, score, reason) => {
    if (!list || list.length < 2) return;
    candidates.push({ list, score, reason });
  };

  for (const [upc, list] of byUpc) {
    push(list, 100, `mesmo código de barras ${upc}: é a mesma garrafa`);
  }
  for (const [root, list] of byRoot) {
    // só vale como sinal se os SKUs realmente DIFEREM (senão é o mesmo produto)
    const distinct = new Set(list.map((x) => x.product_id));
    if (distinct.size < 2) continue;
    const anyPack = list.some((x) => x.skus.some((s) => packOf(s.sku) || (Number(s.units_per_pack) || 1) > 1));
    push(list, anyPack ? 92 : 85,
      anyPack ? `mesmo SKU base "${root}" com casepack (-C2/-C3/-C4): o casepack não existe fisicamente`
        : `mesmo SKU base "${root}"`);
  }
  for (const [nm, list] of byName) {
    if (!nm) continue;
    // SEGURANÇA: o apelido pode ser um rótulo curto e repetido ("ACV", "X"), e
    // dois produtos diferentes com o mesmo apelido não são a mesma garrafa. Só
    // aceita o sinal de nome quando o NOME CANÔNICO normalizado bate — que é
    // onde a dose está e onde "Berberine 1000mg" ≠ "Berberine 6000mg".
    const list2 = list.filter((x) => x.norm_name === nm);
    if (list2.length < 2) continue;
    const kitDerived = list2.some((x) => x.is_kit_only) && list2.some((x) => !x.is_kit_only);
    push(list2, kitDerived ? 70 : 55,
      kitDerived ? `nome igual "${nm}" e um dos dois só tem SKU de kit: kit derivado da avulsa`
        : `mesmo nome ignorando o pacote: "${nm}"`);
  }

  // 4) resolve: cada produto entra em UM grupo só, o de maior score. Grupos
  //    empatados saem em ordem estável (menor product_id) — a lista não pode
  //    dançar entre um F5 e outro, senão ninguém confia nela.
  candidates.sort((a, b) => (b.score - a.score)
    || (Math.min(...a.list.map((x) => x.product_id)) - Math.min(...b.list.map((x) => x.product_id))));

  const taken = new Set();
  const groups = [];
  for (const c of candidates) {
    const free = c.list.filter((x) => !taken.has(x.product_id));
    // dedup dentro do próprio grupo (o mesmo produto pode ter 2 SKUs na chave)
    const uniq = [];
    const seen = new Set();
    for (const x of free) {
      if (seen.has(x.product_id)) continue;
      seen.add(x.product_id); uniq.push(x);
    }
    if (uniq.length < 2) continue;
    for (const x of uniq) taken.add(x.product_id);
    const parent = pickParent(uniq);
    groups.push({
      suggested_parent: { product_id: parent.product_id, name: parent.name,
        nickname: parent.nickname, sku: parent.sku },
      members: uniq.map((x) => ({
        product_id: x.product_id, name: x.name, nickname: x.nickname, sku: x.sku,
        units_per_pack: x.units_per_pack, veeqo_qty: x.veeqo_qty,
        has_stock: !!x.has_stock, sku_count: x.skus.length,
      })),
      reason: c.reason,
      confidence: confidenceOf(c.score),
      score: c.score,
    });
    if (groups.length >= MAX_GROUPS) break;
  }

  const counts = {
    groups: groups.length,
    products: groups.reduce((n, g) => n + g.members.length, 0),
    alta: groups.filter((g) => g.confidence === 'alta').length,
    media: groups.filter((g) => g.confidence === 'média').length,
    baixa: groups.filter((g) => g.confidence === 'baixa').length,
    scanned: members.length,
    capped: groups.length >= MAX_GROUPS,
  };
  return { groups, counts };
}

module.exports = { suggest, normName, packOf, skuRoot, MAX_GROUPS };
