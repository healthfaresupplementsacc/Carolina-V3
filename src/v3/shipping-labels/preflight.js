'use strict';
/**
 * HEALTHFARE V3 — PREFLIGHT DAS ETIQUETAS DE ENVIO (S15.50, Bruno 09-04).
 *
 * O PROBLEMA: os checks que já existem (duplicata de envio, mergeable, frete
 * caro) rodam como alertas de Slack em janelas fixas — o dup-detector fala às
 * 13h, DEPOIS que o papel saiu. O botão "Imprimir etiquetas de envio" da
 * Central não consultava nada: apertou, imprimiu, e o aviso chegava tarde.
 *
 * A RESPOSTA: os MESMOS checks, na MESMA regra de segurança, rodando no
 * momento que importa — antes do papel sair. Este módulo reusa a parte pura
 * dos workers (nunca reimplementa a regra de merge: NOME exato, mergeable_id
 * da Veeqo é armadilha de ZIP, forwarder exige suite — ver
 * [[merge-safety-rules]]) e devolve um objeto `checks` que o preview anexa
 * quando a Central pede `?checks=1`.
 *
 * REGRA #0, escrita em código: NADA aqui bloqueia. Check que falha vira
 * `failed[]` e conta como ok; o resumo `summary.ok` só fica falso quando um
 * check RODOU e achou algo. A Central mostra a lista âmbar com "imprimir
 * assim mesmo" — o operador decide, o sistema informa.
 *
 * OS 8 CHECKS (a ordem do plano, Fase 4.2):
 *   1. veeqo_ok        — o preview carregou (se chegou aqui, carregou)
 *   2. dedupe          — quantas já impressas serão PULADAS (estrutural,
 *                        a UNIQUE(source,shipment_id) garante; informativo)
 *   3. duplicates      — 2+ caixas pro MESMO cliente hoje (dup-shipment)
 *   4. merge_pending   — pedidos aguardando que deviam ser juntados ANTES
 *                        da próxima compra de etiqueta (mergeable-alert)
 *   5. price_outliers  — frete acima do normal COM cotação mais barata
 *                        válida (base do pedido de reembolso)
 *   6. envelope_unknown— pedido sem envelope resolvível (sem cor / misto)
 *   7. sku_unmapped    — SKU que não virou produto (rodapé sai cru)
 *   8. sem_local       — sem prateleira/bin (INFORMATIVO até a carga do
 *                        estoque físico: hoje quase tudo é sem local, e um
 *                        aviso que grita sempre ensina a ignorar avisos)
 *
 * Read-only puro: nenhuma escrita, nenhum Slack. Quantidade é do StockService.
 */

const { VeeqoDupShipmentDetector } = require('../../workers/veeqo-dup-shipment-detector');
const { VeeqoMergeableAlert } = require('../../workers/veeqo-mergeable-alert');
const freight = require('../freight/service');

/** Quantos checks o preflight cobre (a Central escreve "8 checks ok"). */
const CHECKS_TOTAL = 8;
/** Mesma margem do copiloto: mais barata de verdade, não por centavos. */
const QUOTE_MARGIN = freight.QUOTE_MARGIN != null ? freight.QUOTE_MARGIN : 0.25;

/**
 * Duplicatas DENTRO do dia que está pra imprimir: mesmo cliente (NOME EXATO)
 * + mesmo endereço com 2+ trackings distintos e sem merge. É a parte pura do
 * veeqo-dup-shipment-detector aplicada aos pedidos que o preview JÁ buscou
 * (o worker refaz o pull da Veeqo; aqui os pedidos já estão na mão).
 * Normalizadores = os DO detector (estáticos), pra regra nunca divergir.
 *
 * @param {Array} orders  pedidos crus da Veeqo (deliver_to + allocations)
 * @returns {Array<{patient, orders, tracks, forwarder}>}
 */
function dupsAmongOrders(orders) {
  const D = VeeqoDupShipmentDetector;
  const all = orders || [];

  // 1) forwarders no conjunto: mesma rua+ZIP hospedando 2+ nomes diferentes
  const namesByStreet = new Map();
  for (const o of all) {
    const s = D._street(o); const z = D._zip(o);
    if (!s) continue;
    const k = s + '|' + z;
    if (!namesByStreet.has(k)) namesByStreet.set(k, new Set());
    namesByStreet.get(k).add(D._name(o));
  }
  const isForwarder = (o) => {
    const set = namesByStreet.get(D._street(o) + '|' + D._zip(o));
    return !!set && set.size >= 2;
  };

  // 2) agrupar por NOME EXATO + rua + ZIP (+ suite quando forwarder)
  const byKey = new Map();
  for (const o of all) {
    const name = D._name(o);
    if (!name) continue;                       // sem nome nunca agrupa
    const fwd = isForwarder(o);
    const key = [name, D._street(o), D._zip(o), fwd ? D._suite(o) : ''].join('|');
    if (!byKey.has(key)) byKey.set(key, { orders: [], forwarder: fwd });
    byKey.get(key).orders.push(o);
  }

  const dups = [];
  for (const { orders: g, forwarder } of byKey.values()) {
    if (g.length < 2) continue;
    const tracks = [...new Set(g.flatMap((o) => D._tracks(o)))];
    const anyMerged = g.some((o) => o.merged_to_id || o.merged_order);
    if (tracks.length < 2 || anyMerged) continue;   // 1 tracking ou merged = ok
    dups.push({
      patient: D._nameDisplay(g[0]),
      forwarder,
      orders: g.map((o) => o.number || String(o.id)),
      tracks: tracks.length,
    });
  }
  dups.sort((a, b) => b.orders.length - a.orders.length || a.patient.localeCompare(b.patient));
  return dups;
}

/**
 * Grupos mergeáveis AGUARDANDO na Veeqo, pelo check do worker de verdade
 * (computeGroups é a parte pura + o pull; sem Slack, sem banco). Se o próximo
 * lote de etiquetas for comprado sem juntar, vira duplicata amanhã.
 */
async function mergePending(veeqo) {
  const alert = new VeeqoMergeableAlert({ veeqo, enabled: false });
  const groups = await alert.computeGroups();
  return groups.map((g) => ({
    patient: g.patient,
    channels: g.channels,
    orders: g.orders,
    forwarder: !!g.forwarder,
    cancelled_signal: !!g.cancelledSignal,
  }));
}

/**
 * Outliers de frete de HOJE que tinham opção VÁLIDA mais barata na cotação
 * (margem $0.25): a lista que vira pedido de reembolso. Outlier sem opção
 * mais barata não entra — "era caro mesmo" não é acionável na hora do print.
 */
async function priceOutliers(db, day) {
  const rows = await freight.outliersOf(db, day || null);
  return (rows || [])
    .filter((r) => r.quoted_best_cost != null
      && Number(r.quoted_best_cost) < Number(r.cost) - QUOTE_MARGIN)
    .map((r) => ({
      shipment_id: String(r.shipment_id),
      order_number: r.order_number || null,
      cost: Number(r.cost),
      quoted_best_cost: Number(r.quoted_best_cost),
      quoted_best_service: r.quoted_best_service || null,
      saving: Math.round((Number(r.cost) - Number(r.quoted_best_cost)) * 100) / 100,
    }));
}

/** Itens do preview (a imprimir) cujo envelope não dá pra resolver. */
function envelopeUnknown(items) {
  const out = [];
  for (const it of items || []) {
    if (it.printed_at) continue;               // já saiu, não vai de novo
    if (it.envelope === 'misto?') {
      out.push({ order_number: it.order_number, reason: 'misto',
        skus: (it.products || []).map((p) => p.sku) });
    } else if (it.envelope == null) {
      out.push({ order_number: it.order_number, reason: 'sem_cor',
        skus: (it.products || []).map((p) => p.sku) });
    }
  }
  return out;
}

/** Itens com SKU que não resolveu produto: o rodapé sai com o SKU cru. */
function skuUnmapped(items) {
  const out = [];
  for (const it of items || []) {
    if (it.printed_at) continue;
    const orphans = (it.products || []).filter((p) => p.product_id == null).map((p) => p.sku);
    if (orphans.length) out.push({ order_number: it.order_number, skus: orphans });
  }
  return out;
}

/** Quantos itens a imprimir não têm local nenhum (informativo até a carga). */
function semLocal(items) {
  let n = 0;
  for (const it of items || []) {
    if (it.printed_at) continue;
    const p = (it.products && it.products[0]) || {};
    if (!p.area && !p.shelf_code && !p.bin_code) n += 1;
  }
  return n;
}

/**
 * Roda os 8 checks e monta o objeto que o preview devolve. Cada check roda
 * dentro do próprio try: um que falhar vira `failed[]` e NUNCA derruba os
 * outros nem o preview (REGRA #0 — o pior preflight ainda deixa imprimir).
 *
 * @param {object} p {db, veeqo, orders (crus), items (preview.ready), day}
 * @returns {Promise<object>} checks
 */
async function runChecks(p = {}) {
  const failed = [];
  const run = async (name, fn, fallback) => {
    try { return await fn(); } catch (e) {
      failed.push({ check: name, reason: e && e.message ? e.message : String(e) });
      return fallback;
    }
  };

  const items = p.items || [];
  const checks = {
    veeqo_ok: true,                                            // 1: chegou aqui = carregou
    dedupe: { skipped_printed: items.filter((x) => x.printed_at).length },  // 2
    duplicates: await run('duplicates', async () => dupsAmongOrders(p.orders), []),        // 3
    merge_pending: await run('merge_pending', () => mergePending(p.veeqo), []),            // 4
    price_outliers: await run('price_outliers', () => priceOutliers(p.db, p.day), []),     // 5
    envelope_unknown: await run('envelope_unknown', async () => envelopeUnknown(items), []), // 6
    sku_unmapped: await run('sku_unmapped', async () => skuUnmapped(items), []),           // 7
    sem_local: await run('sem_local', async () => semLocal(items), 0),                     // 8
  };
  checks.failed = failed;

  // âmbar = check que RODOU e achou algo. sem_local e dedupe são informativos:
  // âmbar permanente treina o operador a ignorar o cartão (anti-SPAM).
  const amber = ['duplicates', 'merge_pending', 'price_outliers', 'envelope_unknown', 'sku_unmapped']
    .filter((k) => Array.isArray(checks[k]) && checks[k].length > 0).length;
  checks.summary = {
    total: CHECKS_TOTAL,
    amber,
    ok: amber === 0,
    checked: CHECKS_TOTAL - failed.length,
  };
  return checks;
}

module.exports = {
  runChecks, dupsAmongOrders, mergePending, priceOutliers,
  envelopeUnknown, skuUnmapped, semLocal, CHECKS_TOTAL,
};
