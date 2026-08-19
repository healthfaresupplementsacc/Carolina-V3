'use strict';
/**
 * HEALTHFARE V3 — REVISÃO (dia) — service (Bruno 08-19).
 *
 * A pergunta do Bruno, inteira: "segunda-feira Bruno e Simone revisaram Charcoal:
 * quantas garrafas conseguiram revisar, quanto tempo levaram, e o Charcoal já
 * rodou na linha de produção?" — mais uma lista lateral com TUDO que está
 * esperando revisão (já saiu da encapsuladora e ainda não passou pela linha).
 *
 * Três leituras, três fontes, uma regra cada:
 *
 *  1. DIA (`day`)      — v3.events slug 'review'. É o nosso registro do trabalho
 *                        humano: quem, quando, quanto tempo, quantas garrafas.
 *  2. CALENDÁRIO (`calendar`) — os mesmos eventos agregados por data NY, pro
 *                        mini calendário saber quais dias têm revisão (dia vazio
 *                        não deve nem ser clicável).
 *  3. ESPERANDO (`waiting`)  — o EMS, não o nosso banco. Um lote que a
 *                        encapsuladora terminou e ninguém revisou AINDA NÃO TEM
 *                        evento nenhum aqui: se a fila saísse dos nossos eventos,
 *                        ela mostraria exatamente os lotes que já foram tratados
 *                        e esconderia os esquecidos — o oposto do pedido.
 *
 * GARRAFAS: `events.quantity` quando a pessoa disse quantas revisou (unidade
 * 'bottle'), senão `product_batches.target_bottles` (a meta do lote). Os dois
 * números significam coisas diferentes — quanto SAIU vs quanto era pra sair — e
 * a tela precisa saber qual está vendo, então cada linha carrega
 * `bottles_source: 'evento' | 'lote'`. Somar sem distinguir viraria uma média
 * que não é nem uma coisa nem outra.
 *
 * TEMPO: WORK_SEC = (ended_at − started_at) − total_paused_seconds, a MESMA
 * fórmula do flow-views-repo.reviewRate e do /admin. Fonte única: se este
 * módulo inventasse a própria conta, o widget e o popup dele mostrariam
 * durações diferentes pro mesmo trabalho.
 *
 * REGRA #0 — registrar a realidade: revisão sem lote vinculado APARECE na lista
 * (batch_number null, garrafas do evento ou null). O trabalho aconteceu; o que
 * falta é o vínculo, e esconder a linha esconde justamente o que precisa de
 * conserto.
 *
 * NUNCA ESCREVE. Só SELECT + leitura read-only do EMS.
 */

const { toNyIso } = require('../data/ny-date');

// Fonte única da duração de trabalho (ver cabeçalho). Muda aqui = muda em todo
// lugar que este módulo responde.
const WORK_SEC = `GREATEST(0, EXTRACT(EPOCH FROM (e.ended_at - e.started_at)) - COALESCE(e.total_paused_seconds, 0))`;

const TZ = 'America/New_York';

/** Cache do EMS: 120 s em processo. O /pipeline é a mesma foto pra todo mundo e
 *  a barra lateral reabre a cada clique no popup — sem isso, cada abertura do
 *  Bruno viraria duas chamadas externas. */
const EMS_TTL_MS = 120000;

// ── Estágios do EMS ────────────────────────────────────────────────────────
// O que "esperando revisão" quer dizer, em termos do EMS: passou da
// encapsulação e ainda não foi finalizado. `on_line` entra na lista mas
// separado — está na linha AGORA, não é fila.
const WAITING_STAGES = ['yield_review', 'to_separate', 'to_count', 'label_printing', 'ready_for_line'];
const ON_LINE_STAGE = 'on_line';

/** Rótulo em português de cada estágio (a tela não deve traduzir nada). */
const STAGE_LABELS = {
  yield_review: 'cápsulas prontas',
  to_separate: 'separar / revisar',
  to_count: 'contar',
  label_printing: 'imprimir labels',
  ready_for_line: 'pronto pra linha',
  on_line: 'na linha',
};

/** Ordem de exibição dentro do grupo "não revisado" — segue o fluxo da fábrica. */
const STAGE_ORDER = {
  yield_review: 0, to_separate: 1, to_count: 2, label_printing: 3, ready_for_line: 4, on_line: 5,
};

// ── Normalização de nome (mesma família do stock-gap-service) ───────────────
// O /pipeline do EMS não traz SKU, só nome; e o nome do EMS não é igual ao
// nosso canonical_name. Normaliza dos dois lados pra casar produto.
const norm = (s) => String(s || '').toLowerCase()
  .replace(/healthfare|healtfare/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Chave de casamento de lote: o número do lote sem ruído de formatação. */
const batchKey = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Número inteiro ou null — nunca NaN vazando pro JSON. */
function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Divisão que devolve null em vez de Infinity/NaN quando não dá pra dividir. */
function ratio(a, b, dp) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return +(a / b).toFixed(dp);
}

/**
 * Garrafas de uma linha de revisão.
 * `quantity` só vale como garrafas quando a unidade diz que são garrafas — o
 * mesmo campo guarda 'order' e 'box' em outros fluxos, e contar caixa como
 * garrafa estragaria toda a média de tempo por garrafa.
 */
function bottlesOf(row) {
  const unit = String(row.quantity_unit || '').toLowerCase();
  const q = intOrNull(row.quantity);
  if (q != null && q > 0 && (unit === 'bottle' || unit === 'bottles' || unit === 'garrafa' || unit === '')) {
    return { bottles: q, source: 'evento' };
  }
  const target = intOrNull(row.target_bottles);
  if (target != null && target > 0) return { bottles: target, source: 'lote' };
  return { bottles: null, source: null };
}

/** Dias inteiros entre um instante e agora (null se não houver instante). */
function daysSince(at, now) {
  if (!at) return null;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return +Math.max(0, (now - t) / 86400000).toFixed(1);
}

/** Achata pipeline[grupo] (objeto-de-arrays por sub-stage) numa lista.
 *  Igual ao worker ems-activity-sync: o EMS entrega
 *  `{ yield_review:[...], to_separate:[...] }`, não um array plano. */
function flattenStage(node) {
  if (Array.isArray(node)) return node.slice();
  if (node && typeof node === 'object') {
    const out = [];
    for (const sub of Object.keys(node)) {
      const arr = node[sub];
      if (Array.isArray(arr)) {
        for (const b of arr) {
          if (b && typeof b === 'object') out.push(b.status ? b : Object.assign({}, b, { status: sub }));
        }
      }
    }
    return out;
  }
  return [];
}

class ReviewService {
  constructor(deps = {}) {
    this.db = deps.db;
    this.ems = deps.ems || null;
    this.now = deps.now || (() => Date.now());
    this._emsCache = null; // { at, items }
    this._emsTtl = deps.emsTtlMs != null ? deps.emsTtlMs : EMS_TTL_MS;
  }

  // ────────────────────────────────────────────────────────────────────────
  // (1) O DIA
  // ────────────────────────────────────────────────────────────────────────
  /**
   * Todas as revisões de UMA data (NY), com tempo, garrafas e se o lote já
   * rodou na linha.
   * @param {string} date YYYY-MM-DD (já validada pelo router)
   */
  async day(date) {
    const rows = await this._dayRows(date);
    const batchIds = [...new Set(rows.map((r) => r.product_batch_id).filter((x) => x != null))];
    const line = await this._lineByBatch(batchIds);
    const emsStages = await this._emsStageByBatch();

    const revisions = rows.map((r) => {
      const { bottles, source } = bottlesOf(r);
      const workSec = Math.round(Number(r.work_sec) || 0);
      const upb = intOrNull(r.units_per_bottle);
      const capsules = bottles != null && upb != null && upb > 0 ? bottles * upb : null;
      const ln = (r.product_batch_id != null && line.get(r.product_batch_id)) || null;
      return {
        event_id: r.event_id,
        product_id: r.product_id != null ? r.product_id : null,
        product: r.product || 'Sem produto vinculado',
        nickname: r.nickname || null,
        batch_number: r.batch_number || null,
        operator_id: r.operator_id != null ? r.operator_id : null,
        operator: r.operator || null,
        started_at: toNyIso(r.started_at),
        ended_at: toNyIso(r.ended_at),
        work_sec: workSec,
        bottles,
        bottles_source: source,
        capsules,
        capsules_per_sec: capsules != null ? ratio(capsules, workSec, 2) : null,
        sec_per_bottle: bottles != null && bottles > 0 ? ratio(workSec, bottles, 1) : null,
        on_line: !!ln,
        on_line_at: ln ? toNyIso(ln.at) : null,
        line_bottles: ln && ln.bottles != null ? ln.bottles : null,
        ems_stage: (r.batch_number && emsStages.get(batchKey(r.batch_number))) || null,
      };
    });

    return {
      date,
      revisions,
      totals: this._totals(revisions),
      by_person: this._groupBy(revisions, 'operator_id', 'operator'),
      by_product: this._groupBy(revisions, 'product_id', 'product', true),
    };
  }

  /** As linhas cruas do dia. Tudo que é 'review', terminado e não apagado. */
  async _dayRows(date) {
    // LEFT JOIN no lote de propósito: revisão sem lote vinculado continua na
    // lista (regra #0). O INNER JOIN do reviewRate serve pra média de
    // produtividade, onde uma linha sem garrafas não teria o que medir; aqui a
    // pergunta é "o que aconteceu neste dia", e a resposta inclui o que ficou
    // pela metade.
    const sql = `
      SELECT e.id AS event_id, e.started_at, e.ended_at, e.quantity, e.quantity_unit,
             e.product_batch_id,
             ${WORK_SEC} AS work_sec,
             p.id AS operator_id, p.display_name AS operator,
             pb.batch_number, pb.target_bottles, pb.units_per_bottle,
             pb.product_id, pr.canonical_name AS product, pr.nickname
        FROM v3.events e
        JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.slug = 'review'
        JOIN v3.persons p ON p.id = e.person_id
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id AND pb.deleted_at IS NULL
        LEFT JOIN v3.products pr ON pr.id = pb.product_id
       WHERE e.deleted_at IS NULL
         AND e.ended_at IS NOT NULL
         AND (e.started_at AT TIME ZONE '${TZ}')::date = $1
       ORDER BY e.started_at ASC
       LIMIT 500`;
    try {
      const r = await this.db.query(sql, [date]);
      return r.rows || [];
    } catch (e) {
      // Coluna ausente / banco fora: dia vazio, nunca 500 na cara do Bruno.
      return [];
    }
  }

  /**
   * O lote já rodou na linha? Duas evidências, nesta ordem:
   *   a) evento 'production_line' no MESMO product_batch_id (alguém trabalhou);
   *   b) linha em v3.production_counts pro lote (saiu número).
   * Uma só já basta pro check verde: (a) sem (b) é linha rodando e ninguém
   * contou ainda; (b) sem (a) é contagem lançada pelo /op sem evento aberto.
   * Exigir as duas deixaria metade dos lotes reais sem check.
   */
  async _lineByBatch(batchIds) {
    const out = new Map();
    if (!batchIds.length) return out;
    try {
      const r = await this.db.query(
        `SELECT e.product_batch_id AS batch_id, MIN(e.started_at) AS at
           FROM v3.events e
           JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.slug = 'production_line'
          WHERE e.deleted_at IS NULL AND e.product_batch_id = ANY($1::int[])
          GROUP BY e.product_batch_id`, [batchIds]);
      for (const row of r.rows || []) out.set(row.batch_id, { at: row.at, bottles: null });
    } catch (_) { /* sem eventos de linha: cai pra contagem */ }
    try {
      // production_counts referencia o lote por product_batch_id (nullable),
      // não por batch_number — verificado na migração 001 §8.
      const r = await this.db.query(
        `SELECT pc.product_batch_id AS batch_id, SUM(pc.bottles)::int AS bottles,
                MIN(pc.reported_at) AS at
           FROM v3.production_counts pc
          WHERE pc.product_batch_id = ANY($1::int[])
          GROUP BY pc.product_batch_id`, [batchIds]);
      for (const row of r.rows || []) {
        const prev = out.get(row.batch_id);
        out.set(row.batch_id, {
          at: (prev && prev.at) || row.at,
          bottles: row.bottles != null ? Number(row.bottles) : null,
        });
      }
    } catch (_) { /* sem contagens: o evento sozinho já responde */ }
    return out;
  }

  /** Totais do dia. `products` conta produtos DISTINTOS, não linhas. */
  _totals(revisions) {
    const products = new Set();
    let bottles = 0; let workSec = 0; let onLine = 0;
    for (const r of revisions) {
      products.add(r.product_id != null ? 'p' + r.product_id : 'n' + (r.product || ''));
      if (r.bottles != null) bottles += r.bottles;
      workSec += r.work_sec || 0;
      if (r.on_line) onLine += 1;
    }
    return {
      revisions: revisions.length,
      bottles,
      work_sec: workSec,
      products: revisions.length ? products.size : 0,
      on_line: onLine,
    };
  }

  /** Agrupa por pessoa ou por produto. `withLine` marca o check do produto. */
  _groupBy(revisions, idKey, nameKey, withLine) {
    const m = new Map();
    for (const r of revisions) {
      const key = r[idKey] != null ? String(r[idKey]) : 'x:' + (r[nameKey] || '');
      if (!m.has(key)) {
        m.set(key, { [nameKey]: r[nameKey], n: 0, bottles: 0, work_sec: 0, on_line: false });
      }
      const g = m.get(key);
      g.n += 1;
      if (r.bottles != null) g.bottles += r.bottles;
      g.work_sec += r.work_sec || 0;
      if (r.on_line) g.on_line = true;
    }
    const out = [...m.values()];
    if (!withLine) out.forEach((g) => { delete g.on_line; });
    return out.sort((a, b) => b.bottles - a.bottles || b.n - a.n);
  }

  // ────────────────────────────────────────────────────────────────────────
  // (2) O CALENDÁRIO
  // ────────────────────────────────────────────────────────────────────────
  /**
   * Quais dias do mês tiveram revisão, e quanto. Alimenta o mini calendário:
   * dia sem revisão não vira botão clicável.
   * @param {string} month YYYY-MM (já validado pelo router)
   */
  async calendar(month) {
    // Agrupa pela data NY do INÍCIO — o mesmo critério do `day()`, senão um
    // turno que atravessa a meia-noite apareceria num dia no calendário e no
    // outro ao clicar.
    const sql = `
      SELECT (e.started_at AT TIME ZONE '${TZ}')::date AS d,
             COUNT(*)::int AS revisions,
             COALESCE(SUM(
               CASE WHEN e.quantity IS NOT NULL AND e.quantity > 0
                     AND (e.quantity_unit IS NULL OR lower(e.quantity_unit) IN ('bottle','bottles','garrafa'))
                    THEN e.quantity
                    ELSE COALESCE(pb.target_bottles, 0) END
             ), 0)::int AS bottles
        FROM v3.events e
        JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.slug = 'review'
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id AND pb.deleted_at IS NULL
       WHERE e.deleted_at IS NULL
         AND e.ended_at IS NOT NULL
         AND to_char((e.started_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM') = $1
       GROUP BY 1
       ORDER BY 1`;
    let rows = [];
    try {
      const r = await this.db.query(sql, [month]);
      rows = r.rows || [];
    } catch (_) { rows = []; }
    const days = rows.map((x) => ({
      date: x.d instanceof Date
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x.d)
        : String(x.d).slice(0, 10),
      revisions: Number(x.revisions) || 0,
      bottles: Number(x.bottles) || 0,
    }));
    return { month, days };
  }

  // ────────────────────────────────────────────────────────────────────────
  // (3) A FILA — o que está esperando revisão
  // ────────────────────────────────────────────────────────────────────────
  /**
   * Tudo que saiu da encapsuladora e ainda não passou pela linha, com o que o
   * NOSSO banco sabe de cada lote (já revisado? por quem? já foi pra linha?).
   *
   * A fila vem do EMS porque um lote esquecido não tem evento nenhum aqui — a
   * lista tem que existir ANTES de qualquer trabalho nosso, senão ela só mostra
   * o que já foi feito (ver cabeçalho).
   */
  async waiting() {
    const now = this.now();
    const ems = await this._emsBatches();
    let items = ems.items;

    // EMS fora do ar ou sem chave: cai no espelho local (v3.ems_activity_cache,
    // que o worker ems-activity-sync atualiza a cada 45 s). Dado velho e
    // marcado como velho é melhor do que uma barra lateral em branco — REGRA #0.
    if (!ems.ok) items = await this._waitingFromCache();

    const enriched = await this._enrich(items, now);

    // Ordem: quem ninguém tocou primeiro, e dentro disso o mais velho no topo —
    // a fila do topo é exatamente a lista de trabalho do dia.
    const rank = (x) => (x.on_line ? 2 : (x.reviewed ? 1 : 0));
    enriched.sort((a, b) => rank(a) - rank(b)
      || (STAGE_ORDER[a.ems_stage] || 9) - (STAGE_ORDER[b.ems_stage] || 9)
      || (b.waiting_days == null ? -1 : 1) - (a.waiting_days == null ? -1 : 1)
      || (b.waiting_days || 0) - (a.waiting_days || 0)
      || String(a.batch_number || '').localeCompare(String(b.batch_number || '')));

    return {
      generated_at: toNyIso(new Date(now)),
      ems_ok: ems.ok,
      items: enriched,
      counts: {
        waiting: enriched.length,
        not_reviewed: enriched.filter((x) => !x.reviewed && !x.on_line).length,
        reviewed_waiting_line: enriched.filter((x) => x.reviewed && !x.on_line).length,
        on_line: enriched.filter((x) => x.on_line).length,
      },
    };
  }

  /**
   * batch_number normalizado → estágio atual no EMS, pras linhas do dia
   * mostrarem em que pé o lote está agora ("já foi pra linha?", "ainda falta
   * contar?"). Usa o MESMO cache de 120 s da fila: uma foto da fábrica por
   * request, não duas. EMS fora do ar → mapa vazio, e o campo vira null; o dia
   * inteiro não pode depender de um sistema externo estar de pé.
   */
  async _emsStageByBatch() {
    const out = new Map();
    let ems;
    try { ems = await this._emsBatches(); } catch (_) { return out; }
    if (!ems.ok) return out;
    for (const b of ems.items) {
      if (b.batch_number) out.set(batchKey(b.batch_number), b.ems_stage || null);
    }
    return out;
  }

  /** Lotes do EMS nos estágios que interessam, com cache de 120 s. */
  async _emsBatches() {
    const cached = this._emsCache;
    if (cached && this.now() - cached.at < this._emsTtl) {
      return { ok: cached.ok, items: cached.items };
    }
    if (!this.ems || typeof this.ems.configured !== 'function' || !this.ems.configured()) {
      const miss = { ok: false, items: [], at: this.now() };
      this._emsCache = miss;
      return miss;
    }
    let pipeline = null;
    try {
      pipeline = await this.ems.pipeline();
    } catch (_) {
      const down = { ok: false, items: [], at: this.now() };
      this._emsCache = down; // não martela um EMS fora do ar a cada request
      return down;
    }
    const skuByName = await this._emsSkuByName();
    const stages = pipeline && pipeline.production_line ? pipeline.production_line : {};
    const items = [];
    for (const stage of WAITING_STAGES.concat([ON_LINE_STAGE])) {
      for (const b of flattenStage(stages[stage])) {
        const product = (b.product && b.product.name) || (b.formula && b.formula.name) || '';
        const tl = b.timeline || {};
        items.push({
          batch_number: b.batch_record_number || null,
          product,
          sku: skuByName.get(norm(product)) || null,
          target_bottles: intOrNull(b.target_qty_bottles),
          actual_bottles: intOrNull(b.actual_yield_bottles),
          ems_stage: b.status || stage,
          encapsulated_at: (tl.encapsulating && tl.encapsulating.completed_at) || null,
          stage_at: (tl.production && (tl.production.started_at || tl.production.completed_at)) || b.updated_at || null,
        });
      }
    }
    const fresh = { ok: true, items, at: this.now() };
    this._emsCache = fresh;
    return fresh;
  }

  /** nome do produto no EMS → internal_sku (mesma leitura do stock-gap-service). */
  async _emsSkuByName() {
    const m = new Map();
    try {
      const prods = await this.ems.products();
      const list = Array.isArray(prods) ? prods : (prods.products || prods.items || prods.data || []);
      for (const x of list) {
        const nm = norm(x.name || x.product_name);
        const sku = x.internal_sku || x.sku;
        if (nm && sku) m.set(nm, String(sku).trim().toUpperCase());
      }
    } catch (_) { /* sem catálogo: casa por nome */ }
    return m;
  }

  /** Fallback: o espelho local do EMS quando o EMS não responde. */
  async _waitingFromCache() {
    try {
      const r = await this.db.query(
        `SELECT batch_number, supplement_name, stage, target_bottles, actual_bottles,
                started_at, ended_at, last_synced_at
           FROM v3.ems_activity_cache
          WHERE sync_status = 'active' AND stage = ANY($1::text[])
          ORDER BY started_at ASC NULLS LAST
          LIMIT 200`, [WAITING_STAGES.concat([ON_LINE_STAGE])]);
      return (r.rows || []).map((x) => ({
        batch_number: x.batch_number || null,
        product: x.supplement_name || '',
        sku: null,
        target_bottles: intOrNull(x.target_bottles),
        actual_bottles: intOrNull(x.actual_bottles),
        ems_stage: x.stage || null,
        encapsulated_at: x.ended_at || null,
        stage_at: x.started_at || x.last_synced_at || null,
      }));
    } catch (_) { return []; }
  }

  /**
   * Cruza cada lote do EMS com o NOSSO banco: já tem revisão? quem fez? já foi
   * pra linha? O casamento é por batch_number (o mesmo número impresso no lote
   * dos dois lados) e o produto por nome normalizado — batch_number é a chave
   * forte, o nome só preenche nickname/product_id quando o lote não existe aqui.
   */
  async _enrich(items, now) {
    const keys = [...new Set(items.map((x) => x.batch_number).filter(Boolean))];
    const byBatch = new Map();
    if (keys.length) {
      try {
        const r = await this.db.query(
          `SELECT pb.id, pb.batch_number, pb.product_id,
                  pr.canonical_name AS product, pr.nickname,
                  rv.n_reviews, rv.reviewers, rv.first_at, rv.bottles,
                  ln.line_at, ln.line_bottles
             FROM v3.product_batches pb
             LEFT JOIN v3.products pr ON pr.id = pb.product_id
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS n_reviews,
                      array_agg(DISTINCT p.display_name) AS reviewers,
                      MIN(e.started_at) AS first_at,
                      COALESCE(SUM(CASE WHEN e.quantity IS NOT NULL AND e.quantity > 0
                                         AND (e.quantity_unit IS NULL OR lower(e.quantity_unit) IN ('bottle','bottles','garrafa'))
                                        THEN e.quantity ELSE 0 END), 0)::int AS bottles
                 FROM v3.events e
                 JOIN v3.activity_types at ON at.id = e.activity_type_id AND at.slug = 'review'
                 JOIN v3.persons p ON p.id = e.person_id
                WHERE e.product_batch_id = pb.id AND e.deleted_at IS NULL
             ) rv ON true
             LEFT JOIN LATERAL (
               SELECT MIN(x.at) AS line_at, SUM(x.bottles)::int AS line_bottles FROM (
                 SELECT MIN(e2.started_at) AS at, NULL::int AS bottles
                   FROM v3.events e2
                   JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id AND at2.slug = 'production_line'
                  WHERE e2.product_batch_id = pb.id AND e2.deleted_at IS NULL
                 UNION ALL
                 SELECT MIN(pc.reported_at) AS at, SUM(pc.bottles)::int AS bottles
                   FROM v3.production_counts pc
                  WHERE pc.product_batch_id = pb.id
               ) x
             ) ln ON true
            WHERE pb.deleted_at IS NULL AND pb.batch_number = ANY($1::text[])`, [keys]);
        for (const row of r.rows || []) byBatch.set(batchKey(row.batch_number), row);
      } catch (_) { /* sem lotes casados: a fila continua, só sem o cruzamento */ }
    }

    // Produtos nossos por nome normalizado — pra dar nickname/product_id a lote
    // que o EMS conhece e o nosso banco ainda não registrou.
    const byName = new Map();
    try {
      const r = await this.db.query(
        'SELECT id, canonical_name, nickname FROM v3.products WHERE active');
      for (const p of r.rows || []) byName.set(norm(p.canonical_name), p);
    } catch (_) { /* sem catálogo: nickname fica null */ }

    return items.map((x) => {
      const hit = x.batch_number ? byBatch.get(batchKey(x.batch_number)) : null;
      const prod = hit || byName.get(norm(x.product)) || null;
      const reviewed = !!(hit && hit.n_reviews > 0);
      const onLine = !!(hit && hit.line_at);
      return {
        batch_number: x.batch_number,
        product: x.product || (prod && prod.product) || (prod && prod.canonical_name) || 'Sem nome',
        nickname: (prod && prod.nickname) || null,
        product_id: (prod && (prod.product_id != null ? prod.product_id : prod.id)) || null,
        sku: x.sku || null,
        target_bottles: x.target_bottles,
        actual_bottles: x.actual_bottles,
        ems_stage: x.ems_stage,
        ems_stage_label: STAGE_LABELS[x.ems_stage] || x.ems_stage || null,
        encapsulated_at: toNyIso(x.encapsulated_at),
        stage_at: toNyIso(x.stage_at),
        waiting_days: daysSince(x.encapsulated_at || x.stage_at, now),
        reviewed,
        reviewed_by: (hit && hit.reviewers ? hit.reviewers.filter(Boolean) : []),
        reviewed_at: reviewed ? toNyIso(hit.first_at) : null,
        revised_bottles: reviewed && hit.bottles > 0 ? hit.bottles : null,
        on_line: onLine,
        on_line_at: onLine ? toNyIso(hit.line_at) : null,
      };
    });
  }
}

module.exports = {
  ReviewService,
  WORK_SEC,
  WAITING_STAGES,
  ON_LINE_STAGE,
  STAGE_LABELS,
  bottlesOf,
  flattenStage,
  norm,
  batchKey,
  EMS_TTL_MS,
};
