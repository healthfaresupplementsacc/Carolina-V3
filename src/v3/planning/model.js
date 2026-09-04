'use strict';
/**
 * HEALTHFARE V3 — PLANEJAMENTO — o funil de produção (Bruno 09-04).
 *
 * A correção do Bruno (09-04, verbatim): "o planejamento nao eh so baseado no
 * veeqo e no stock do P&P, ele eh baseado em toda a producao do EMS e pra
 * gente saber oq tem pra revisao que ainda nao foi revisado... como se fosse
 * uma tabela de to-dos: Formulating / Encapsulating / Waiting to be Revised /
 * Being Revised / Ready to go to Production / Produced / Boxed".
 *
 * Este módulo computa o QUADRO (as 7 colunas) — leitura pura, nada de escrita.
 * Universo: todo lote com linha no v3.ems_activity_cache nos últimos 60 dias
 * (última linha por batch_number decide o estágio EMS) + a fila viva do EMS
 * via pipeline() quando disponível. Lotes da Austisol ENTRAM: a marca do
 * Henrique é fabricada aqui — a exclusão Austisol vale só pra venda/estoque.
 *
 * REGRAS DE ESTÁGIO (cada uma visível aqui e testada em planning-model.test.js).
 * Precedência do mais completo pro menos completo — determinístico, sem
 * meio-termo (um lote meio-revisado aparece em Pronto e o humano arrasta de
 * volta no PLANO, que é a área de override humano):
 *   7. Encaixotado  — EXISTS v3.stock_boxes com o batch_number (automático:
 *      acende sozinho quando a carga física começar) OU manual_boxed marcado
 *      no quadro (linha-flag plan_date NULL em production_plan_items).
 *   6. Produzido    — existe evento production_line pro lote (garrafas de
 *      production_counts quando houver).
 *   4. Em revisão   — existe evento review ABERTO (ended_at IS NULL): mostra
 *      quem e desde quando. Escolha deliberada: Produzido vence Em revisão
 *      (re-revisão depois da linha é anomalia; completude manda).
 *   5. Pronto pra produção — existe review, nenhum aberto, zero production_line.
 *   3. Esperando revisão — estágio EMS JÁ PASSOU da encapsuladora
 *      (yield_review | to_separate | label_printing | finalized) E zero
 *      eventos de review. CRÍTICO: 'finalized' = fabricação EMS pronta, NÃO
 *      produzido — finalizado com zero review é exatamente "esperando revisão".
 *   2. Encapsulando — estágio EMS 'encapsulating' (quem está nele quando há
 *      evento encapsulation aberto).
 *   1. Formulando   — estágio EMS weighing | weighed (+ lotes só na fila do
 *      pipeline() vivo, marcados na_fila; estágio desconhecido cai aqui, o
 *      começo honesto do funil).
 */
const EDT = 'America/New_York';

const COLUMNS = [
  { id: 'formulating',   title: 'Formulando' },
  { id: 'encapsulating', title: 'Encapsulando' },
  { id: 'waiting',       title: 'Esperando revisão' },
  { id: 'revising',      title: 'Em revisão' },
  { id: 'ready',         title: 'Pronto pra produção' },
  { id: 'produced',      title: 'Produzido' },
  { id: 'boxed',         title: 'Encaixotado' },
];

const FORMULATING_STAGES = ['weighing', 'weighed'];
const PAST_ENCAPSULATION_STAGES = ['yield_review', 'to_separate', 'label_printing', 'finalized'];

/**
 * Classifica UM lote nas 7 colunas. Pura, sem IO — o alvo dos testes.
 * @param {object} b  { stage, review_count, review_open, line_count,
 *                      boxed_auto, manual_boxed }
 * @returns {string} id da coluna
 */
function classify(b) {
  const stage = String(b.stage || '').toLowerCase();
  // 7. Encaixotado: caixa física com o lote OU marcado na mão no quadro
  if (b.boxed_auto || b.manual_boxed) return 'boxed';
  // 6. Produzido: a linha já rodou (existe evento production_line)
  if (Number(b.line_count) > 0) return 'produced';
  // 4. Em revisão: review ABERTO agora (quem/desde quando vem no cartão)
  if (Number(b.review_open) > 0) return 'revising';
  // 5. Pronto pra produção: já teve review, nenhum aberto, linha nunca rodou.
  //    (Meio-revisado cai aqui de propósito — o humano corrige arrastando no plano.)
  if (Number(b.review_count) > 0) return 'ready';
  // 3. Esperando revisão: EMS passou da encapsuladora e NINGUÉM revisou ainda.
  //    'finalized' = fábrica pronta, não produzido — é exatamente este caso.
  if (PAST_ENCAPSULATION_STAGES.includes(stage)) return 'waiting';
  // 2. Encapsulando
  if (stage === 'encapsulating') return 'encapsulating';
  // 1. Formulando: weighing/weighed, fila do pipeline, ou estágio desconhecido
  return 'formulating';
}

/** Desde quando o lote está no estágio atual (a data certa por coluna). */
function stageSince(col, b) {
  const pick = (...xs) => xs.find((x) => x != null) || null;
  if (col === 'boxed') return pick(b.boxed_at, b.line_last_start, b.last_synced_at);
  if (col === 'produced') return pick(b.line_last_start, b.last_synced_at);
  if (col === 'revising') return pick(b.review_open_since, b.last_synced_at);
  if (col === 'ready') return pick(b.review_last_end, b.last_synced_at);
  if (col === 'waiting') return pick(b.ems_ended_at, b.last_synced_at);
  // formulando/encapsulando: quando a última linha EMS começou
  return pick(b.ems_started_at, b.first_seen_at, b.last_synced_at);
}

function daysBetween(since, now) {
  if (!since) return null;
  const ms = now - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Number((ms / 86400000).toFixed(1));
}

class PlanningBoard {
  constructor(deps = {}) {
    this.db = deps.db;
    this.ems = deps.ems || null;      // cliente src/v3/services/ems-api (opcional)
    this.windowDays = deps.windowDays || 60;
  }

  /** Última linha do cache EMS por lote (últimos 60 dias) — o estágio EMS. */
  async _latestEms() {
    const r = await this.db.query(`
      SELECT DISTINCT ON (c.batch_number)
             c.batch_number, c.stage, c.supplement_name,
             c.target_bottles, c.actual_bottles,
             c.started_at AS ems_started_at, c.ended_at AS ems_ended_at,
             c.first_seen_at, c.last_synced_at
        FROM v3.ems_activity_cache c
       WHERE c.batch_number IS NOT NULL
         AND c.last_synced_at > NOW() - ($1 || ' days')::interval
       ORDER BY c.batch_number, c.last_synced_at DESC`, [this.windowDays]);
    return r.rows;
  }

  /** Agregado dos NOSSOS eventos por lote (review / production_line / encapsulation). */
  async _oursByBatch() {
    const r = await this.db.query(`
      SELECT pb.batch_number,
             MIN(pb.product_id) AS product_id,
             COUNT(*) FILTER (WHERE at.slug = 'review') AS review_count,
             COUNT(*) FILTER (WHERE at.slug = 'review' AND e.ended_at IS NULL) AS review_open,
             MIN(e.started_at) FILTER (WHERE at.slug = 'review' AND e.ended_at IS NULL) AS review_open_since,
             MAX(e.ended_at) FILTER (WHERE at.slug = 'review') AS review_last_end,
             COUNT(*) FILTER (WHERE at.slug = 'production_line') AS line_count,
             MAX(e.started_at) FILTER (WHERE at.slug = 'production_line') AS line_last_start
        FROM v3.product_batches pb
        JOIN v3.events e ON e.product_batch_id = pb.id AND e.deleted_at IS NULL
        JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE pb.deleted_at IS NULL
         AND at.slug IN ('review', 'production_line', 'encapsulation')
       GROUP BY pb.batch_number`);
    return new Map(r.rows.map((x) => [x.batch_number, x]));
  }

  /** Quem está AGORA em cada lote (eventos abertos, com nome). */
  async _whoByBatch() {
    const r = await this.db.query(`
      SELECT pb.batch_number, at.slug, p.name, e.started_at
        FROM v3.events e
        JOIN v3.activity_types at ON at.id = e.activity_type_id
             AND at.slug IN ('review', 'production_line', 'encapsulation')
        JOIN v3.product_batches pb ON pb.id = e.product_batch_id AND pb.deleted_at IS NULL
        JOIN v3.persons p ON p.id = e.person_id
       WHERE e.ended_at IS NULL AND e.deleted_at IS NULL`);
    const out = new Map();
    for (const x of r.rows) {
      if (!out.has(x.batch_number)) out.set(x.batch_number, []);
      out.get(x.batch_number).push({ name: x.name, slug: x.slug, since: x.started_at });
    }
    return out;
  }

  /** Garrafas contadas por lote (production_counts vivos, não supersedidos). */
  async _bottlesByBatch() {
    const r = await this.db.query(`
      SELECT pb.batch_number, SUM(pc.bottles)::int AS bottles
        FROM v3.production_counts pc
        JOIN v3.product_batches pb ON pb.id = pc.product_batch_id AND pb.deleted_at IS NULL
       WHERE pc.deleted_at IS NULL AND pc.superseded_by IS NULL
       GROUP BY pb.batch_number`);
    return new Map(r.rows.map((x) => [x.batch_number, Number(x.bottles)]));
  }

  /** Lotes com caixa física (acende Encaixotado sozinho quando a carga começar). */
  async _boxedByBatch() {
    const r = await this.db.query(`
      SELECT batch_number, MAX(created_at) AS boxed_at
        FROM v3.stock_boxes
       WHERE batch_number IS NOT NULL
       GROUP BY batch_number`);
    return new Map(r.rows.map((x) => [x.batch_number, x.boxed_at]));
  }

  /** Flags manuais do quadro (linhas plan_date NULL de production_plan_items). */
  async _manualFlags() {
    const r = await this.db.query(`
      SELECT batch_number, manual_boxed
        FROM v3.production_plan_items
       WHERE plan_date IS NULL AND batch_number IS NOT NULL`);
    return new Map(r.rows.map((x) => [x.batch_number, !!x.manual_boxed]));
  }

  /** Nomes bonitos: nickname > canonical_name (por product_id). */
  async _productNames(ids) {
    if (!ids.length) return new Map();
    const r = await this.db.query(
      'SELECT id, canonical_name, nickname FROM v3.products WHERE id = ANY($1)', [ids]);
    return new Map(r.rows.map((x) => [x.id, x.nickname || x.canonical_name]));
  }

  /** Fila viva do EMS (pipeline) — enriquece Formulando com lotes que ainda
   *  nem chegaram no cache. Melhor esforço: EMS fora → segue só com o cache. */
  async _liveQueue(knownBatches) {
    if (!this.ems || (this.ems.configured && !this.ems.configured())) {
      return { ok: false, items: [] };
    }
    try {
      const p = await this.ems.pipeline();
      const sections = [];
      if (p && Array.isArray(p.pending_queue)) sections.push(p.pending_queue);
      if (p && p.pending_queue && Array.isArray(p.pending_queue.items)) sections.push(p.pending_queue.items);
      const items = [];
      for (const arr of sections) {
        for (const it of arr) {
          const bn = it && (it.batch_number || it.batchNumber || it.batch);
          const name = (it && (it.supplement_name || it.supplement || it.product_name || it.name)) || null;
          if (!bn || knownBatches.has(String(bn))) continue;
          items.push({ batch_number: String(bn), product: name });
        }
      }
      return { ok: true, items };
    } catch (_) {
      return { ok: false, items: [] };
    }
  }

  /** O quadro inteiro: { columns:[{id,title,count,cards:[…]}], generated_at, ems_ok }. */
  async board() {
    const [ems, ours, who, bottles, boxed, flags] = await Promise.all([
      this._latestEms(), this._oursByBatch(), this._whoByBatch(),
      this._bottlesByBatch(), this._boxedByBatch(), this._manualFlags(),
    ]);
    const now = Date.now();
    const known = new Set(ems.map((r) => r.batch_number));
    // lotes que só existem no NOSSO lado (evento sem cache — raro, mas real)
    for (const bn of ours.keys()) {
      if (!known.has(bn)) { known.add(bn); ems.push({ batch_number: bn, stage: null }); }
    }

    const pids = [...new Set(ems.map((r) => (ours.get(r.batch_number) || {}).product_id).filter(Boolean))];
    const names = await this._productNames(pids);
    const queue = await this._liveQueue(known);

    const cards = ems.map((r) => {
      const o = ours.get(r.batch_number) || {};
      const b = {
        stage: r.stage,
        review_count: o.review_count || 0,
        review_open: o.review_open || 0,
        review_open_since: o.review_open_since || null,
        review_last_end: o.review_last_end || null,
        line_count: o.line_count || 0,
        line_last_start: o.line_last_start || null,
        boxed_auto: boxed.has(r.batch_number),
        boxed_at: boxed.get(r.batch_number) || null,
        manual_boxed: flags.get(r.batch_number) === true,
        ems_started_at: r.ems_started_at, ems_ended_at: r.ems_ended_at,
        first_seen_at: r.first_seen_at, last_synced_at: r.last_synced_at,
      };
      const col = classify(b);
      return {
        batch_number: r.batch_number,
        product: (o.product_id && names.get(o.product_id)) || r.supplement_name || r.batch_number,
        product_id: o.product_id || null,
        column: col,
        ems_stage: r.stage || null,
        days_in_stage: daysBetween(stageSince(col, b), now),
        who: who.get(r.batch_number) || [],
        bottles: bottles.get(r.batch_number) != null ? bottles.get(r.batch_number)
          : (r.actual_bottles != null && col === 'produced' ? Number(r.actual_bottles) : null),
        boxed_auto: b.boxed_auto,
        manual_boxed: b.manual_boxed,
        na_fila: false,
      };
    });
    for (const q of queue.items) {
      cards.push({
        batch_number: q.batch_number, product: q.product || q.batch_number,
        product_id: null, column: 'formulating', ems_stage: null,
        days_in_stage: null, who: [], bottles: null,
        boxed_auto: false, manual_boxed: false, na_fila: true,
      });
    }

    const columns = COLUMNS.map((c) => {
      const cs = cards.filter((x) => x.column === c.id);
      // mais tempo parado primeiro dentro da coluna (fila em pé)
      cs.sort((a, bb) => (bb.days_in_stage || 0) - (a.days_in_stage || 0));
      return { id: c.id, title: c.title, count: cs.length, cards: cs };
    });
    return { columns, generated_at: new Date().toISOString(), ems_ok: queue.ok };
  }
}

function createPlanningBoard(deps = {}) { return new PlanningBoard(deps); }

/* ── COMPAT (não remover sem checar): src/v3/stock/interim-days.js — usado
 * pelo warehouse router (D-6, days_of_stock unificado no interino) — chama
 * createPlanningModel({db})._velocityByProduct(). A conta abaixo é a MESMA de
 * sempre (média 14d por produto das linhas shipped); o resto do antigo modelo
 * de reposição (compute/suggestions) saiu com a correção de direção do Bruno
 * 09-04: o Planejamento agora é o funil do EMS, não sugestão de compra. */
class PlanningModel {
  constructor(deps = {}) { this.db = deps.db; }
  /** Velocidade (unidades-garrafa/dia, média 14d) por produto, das linhas shipped. */
  async _velocityByProduct() {
    const r = await this.db.query(`
      SELECT l.product_id,
             SUM(l.qty * COALESCE(ps.units_per_pack, 1))::numeric / 14 AS per_day,
             COUNT(DISTINCT l.order_date) AS days_seen
        FROM v3.pnp_order_lines l
        LEFT JOIN v3.product_skus ps ON ps.channel = l.source AND ps.sku = l.sku
       WHERE l.status = 'shipped' AND l.product_id IS NOT NULL
         AND l.order_date > (NOW() AT TIME ZONE '${EDT}')::date - 14
       GROUP BY l.product_id`);
    return new Map(r.rows.map((x) => [x.product_id, { perDay: Number(x.per_day), daysSeen: Number(x.days_seen) }]));
  }
}
function createPlanningModel(deps = {}) { return new PlanningModel(deps); }

module.exports = {
  PlanningBoard, createPlanningBoard, classify, stageSince, daysBetween, COLUMNS,
  FORMULATING_STAGES, PAST_ENCAPSULATION_STAGES,
  PlanningModel, createPlanningModel,
};
