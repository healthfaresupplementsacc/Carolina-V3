'use strict';
/**
 * HEALTHFARE V4 — Freight cost watch: lógica pura + repo (Bruno 08-28).
 *
 * O PROBLEMA (palavras do Bruno): "o customer coloca que precisa receber ate tal
 * dia, mesmo que eles recebam antes o veeqo coloca uma data ainda antes e a
 * gente acaba sendo cobrado mto pelo carrier... como que eu vou saber q o
 * sistema ta pegando o valor certo sempre?".
 *
 * A RESPOSTA: cada etiqueta comprada vira uma linha em v3.shipment_costs; o
 * custo é julgado contra a MEDIANA MÓVEL de 30 dias. V2 (state-aware): quando o
 * DESTINO (faixa + estado) tem amostra suficiente em 30d, a régua é a mediana do
 * próprio estado; senão, a da faixa inteira (serviço + faixa de peso), como no
 * v1. Motivo: etiqueta pro Havaí é cara porque é Havaí, não porque a Veeqo
 * errou; medido em produção, 51 de 317 "outliers" de 30d eram zona legítima.
 * O zip fica guardado pra refinar por zona de verdade depois.
 *
 * Este módulo NÃO fala com Slack nem com a Veeqo: funções puras (bandOf, judge)
 * + repo (expectedFor, upsertShipments, summary, todayOutliers). Quem orquestra
 * é o worker freight-watch. NUNCA escreve estoque.
 */

const EDT = 'America/New_York';
const OZ_G = 28.3495;              // 1 oz em gramas
const LB_G = 16 * OZ_G;            // 1 lb = 453.592 g

// Regra do julgamento (por que estes números):
//  - 30% OU $1.50 acima da mediana, o que for MAIOR: em faixa barata ($5-6) o
//    percentual sozinho gritaria por centavos de zona; em faixa cara o valor
//    fixo sozinho gritaria por variação normal. Os dois juntos = só grita
//    quando é dinheiro de verdade.
//  - MIN_SAMPLES=8: uma faixa fina (3 amostras) tem mediana de brinquedo e
//    gritaria no primeiro dia; alerta falso treina as pessoas a ignorar o
//    alerta verdadeiro. Menos de 8 amostras = nunca outlier pela faixa.
//  - TETO ABSOLUTO $12 pra <1lb: mesmo sem histórico nenhum, $12 num pacote de
//    menos de meio quilo é sempre errado (o histórico todo de <1lb tem máximo
//    $8.40). Esse guarda vale independente de amostras.
const OUTLIER_PCT = 0.30;
const OUTLIER_ABS = 1.50;
const MIN_SAMPLES = 8;
// MIN_STATE_SAMPLES=5: com 5+ etiquetas pro MESMO estado na mesma faixa em 30d,
// a mediana do estado já separa "destino caro" (Havaí) de "Veeqo errou". Menos
// que isso a mediana estadual é ruído e a faixa inteira julga, como no v1.
const MIN_STATE_SAMPLES = 5;
const CEILING_COST = 12.00;
const CEILING_MAX_WEIGHT_G = LB_G;   // teto vale só pra pacote < 1lb

/** Serviço da Veeqo (service_name livre) → chave normalizada. */
function serviceKey(service) {
  const s = String(service || '').trim().toLowerCase();
  if (!s) return 'desconhecido';
  if (/ground\s*advantage/.test(s)) {
    return /cubic/.test(s) ? 'usps_ga_cubic' : 'usps_ga';
  }
  if (/priority\s*mail\s*express/.test(s)) return 'usps_pme';
  if (/priority\s*mail/.test(s)) return 'usps_pm';
  if (/first\s*class/.test(s)) return 'usps_fc';
  if (/ground\s*saver/.test(s)) return 'ups_ground_saver';
  if (/ups\s*ground/.test(s)) return 'ups_ground';
  // desconhecido: vira slug estável (mesmo serviço = mesma faixa, sempre)
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'desconhecido';
}

/** Peso em gramas → faixa. Bordas: 4oz vai pra faixa DE CIMA (4-8oz), 8oz pra
 *  8-16oz, 16oz (1lb) pra 1-2lb, 32oz (2lb) pra >2lb. */
function weightBand(weightG) {
  const w = Number(weightG);
  if (!Number.isFinite(w) || w <= 0) return 'sem_peso';
  const oz = w / OZ_G;
  if (oz < 4) return '<4oz';
  if (oz < 8) return '4-8oz';
  if (oz < 16) return '8-16oz';
  if (oz < 32) return '1-2lb';
  return '>2lb';
}

/** Faixa completa: 'usps_ga|4-8oz'. É a chave da mediana. */
function bandOf(service, weightG) {
  return serviceKey(service) + '|' + weightBand(weightG);
}

/** Mediana móvel de 30d (custo>0: Walmart/etiqueta de fora nunca entra).
 *  Com dest_state e 5+ amostras de (faixa, estado) em 30d, a régua é a mediana
 *  do ESTADO (scope 'estado'); senão, a da faixa inteira (scope 'banda'),
 *  exatamente como no v1. Chamada com 2 argumentos continua igual ao v1.
 *  @returns {{expected:number|null, samples:number, scope:'estado'|'banda'}} */
async function expectedFor(db, band, destState) {
  if (destState) {
    const rs = await db.query(
      `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost) AS median,
              COUNT(*)::int AS samples
         FROM v3.shipment_costs
        WHERE band = $1 AND dest_state = $2 AND cost > 0
          AND bought_at > NOW() - INTERVAL '30 days'`, [band, destState]);
    const srow = (rs.rows && rs.rows[0]) || {};
    const ssamples = Number(srow.samples || 0);
    if (ssamples >= MIN_STATE_SAMPLES && srow.median != null) {
      return { expected: Number(srow.median), samples: ssamples, scope: 'estado' };
    }
  }
  const r = await db.query(
    `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost) AS median,
            COUNT(*)::int AS samples
       FROM v3.shipment_costs
      WHERE band = $1 AND cost > 0
        AND bought_at > NOW() - INTERVAL '30 days'`, [band]);
  const row = (r.rows && r.rows[0]) || {};
  const median = row.median != null ? Number(row.median) : null;
  return { expected: median, samples: Number(row.samples || 0), scope: 'banda' };
}

/**
 * O custo desta etiqueta está acima do normal?
 * @param {{cost:number, expected:number|null, samples:number, weight_g?:number}} x
 * @returns {{outlier:boolean, reason:string|null}}
 */
function judge(x) {
  const cost = Number(x.cost);
  if (!Number.isFinite(cost) || cost <= 0) return { outlier: false, reason: null };
  // Teto absoluto PRIMEIRO: não depende de amostra nenhuma. $12 num pacote de
  // menos de 1lb é sempre errado, mesmo no dia 1 de uma faixa nova.
  const w = Number(x.weight_g);
  if (cost >= CEILING_COST && Number.isFinite(w) && w > 0 && w < CEILING_MAX_WEIGHT_G) {
    return { outlier: true, reason: 'teto_absoluto' };
  }
  // Faixa fina (menos de 8 amostras) NUNCA vira outlier: mediana de 3 números é
  // ruído, e alerta de ruído ensina o admin a ignorar o alerta que importa.
  const samples = Number(x.samples || 0);
  const expected = x.expected != null ? Number(x.expected) : null;
  if (samples < MIN_SAMPLES || expected == null) return { outlier: false, reason: null };
  const threshold = Math.max(expected * (1 + OUTLIER_PCT), expected + OUTLIER_ABS);
  if (cost > threshold) return { outlier: true, reason: 'acima_da_faixa' };
  return { outlier: false, reason: null };
}

/**
 * Upsert idempotente por shipment_id. alerted_at NUNCA regride (uma etiqueta já
 * avisada não volta a ser "não avisada" só porque o tick releu o pedido).
 * @param {Array<object>} rows  linhas já normalizadas (shipment_id obrigatório)
 * @returns {Promise<Array<object>>} linhas atuais, cada uma com `inserted` bool
 */
async function upsertShipments(db, rows) {
  const out = [];
  for (const s of rows || []) {
    if (s == null || s.shipment_id == null) continue;
    const r = await db.query(
      `INSERT INTO v3.shipment_costs
         (shipment_id, order_id, order_number, channel, service, weight_g, cost,
          currency, bought_at, due_date, dispatch_date, dest_state, dest_zip, ny_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'USD'),$9,$10,$11,$12,$13,$14)
       ON CONFLICT (shipment_id) DO UPDATE SET
         order_id      = COALESCE(EXCLUDED.order_id, v3.shipment_costs.order_id),
         order_number  = COALESCE(EXCLUDED.order_number, v3.shipment_costs.order_number),
         channel       = COALESCE(EXCLUDED.channel, v3.shipment_costs.channel),
         service       = COALESCE(EXCLUDED.service, v3.shipment_costs.service),
         weight_g      = COALESCE(EXCLUDED.weight_g, v3.shipment_costs.weight_g),
         cost          = COALESCE(EXCLUDED.cost, v3.shipment_costs.cost),
         due_date      = COALESCE(EXCLUDED.due_date, v3.shipment_costs.due_date),
         dispatch_date = COALESCE(EXCLUDED.dispatch_date, v3.shipment_costs.dispatch_date),
         dest_state    = COALESCE(EXCLUDED.dest_state, v3.shipment_costs.dest_state),
         dest_zip      = COALESCE(EXCLUDED.dest_zip, v3.shipment_costs.dest_zip),
         alerted_at    = v3.shipment_costs.alerted_at
       RETURNING *, (xmax = 0) AS inserted`,
      [s.shipment_id, s.order_id || null, s.order_number || null, s.channel || null,
        s.service || null, s.weight_g != null ? s.weight_g : null,
        s.cost != null ? s.cost : null, s.currency || null,
        s.bought_at || null, s.due_date || null, s.dispatch_date || null,
        s.dest_state || null, s.dest_zip || null, s.ny_day || null]);
    if (r.rows && r.rows[0]) out.push(r.rows[0]);
  }
  return out;
}

/** Grava o julgamento numa linha (band, expected, outlier). Não mexe em alerted_at. */
async function saveJudgement(db, shipmentId, { band, expected_cost, outlier, outlier_reason }) {
  await db.query(
    `UPDATE v3.shipment_costs
        SET band = $2, expected_cost = $3, outlier = $4, outlier_reason = $5
      WHERE shipment_id = $1`,
    [shipmentId, band || null, expected_cost != null ? expected_cost : null,
      !!outlier, outlier_reason || null]);
}

// FASE A (copiloto): "mais barata" só quando a diferença é dinheiro de gente,
// não centavo de arredondamento. $0.25 abaixo do pago é o piso pra dizer "tem
// opção mais barata" — abaixo disso a recompra dá mais trabalho do que salva.
const QUOTE_MARGIN = 0.25;

/** Grava a cotação do copiloto numa linha (Fase A: conselho, nunca compra).
 *  quoted_at = NOW() carimba "cotei", mesmo quando best é null (cotou e não
 *  tinha nenhuma válida). Nunca mexe em julgamento nem alerted_at. */
async function saveQuote(db, shipmentId, { quoted_best_cost, quoted_best_service, quoted_valid_count }) {
  await db.query(
    `UPDATE v3.shipment_costs
        SET quoted_best_cost = $2, quoted_best_service = $3,
            quoted_valid_count = $4, quoted_at = NOW()
      WHERE shipment_id = $1`,
    [shipmentId,
      quoted_best_cost != null ? quoted_best_cost : null,
      quoted_best_service || null,
      quoted_valid_count != null ? quoted_valid_count : null]);
}

/** Etiquetas recentes ainda SEM cotação (o que o copiloto vai cotar neste
 *  tick). Mais velhas primeiro; cost>0 (Walmart custo 0 não tem o que cotar);
 *  dest_zip obrigatório (sem CEP não existe cotação — pular aqui evita ficar
 *  re-tentando pra sempre uma linha incotável). */
async function unquoted(db, { hours = 48, limit = 25 } = {}) {
  const h = Math.max(1, Math.min(168, Number(hours) || 48));
  const n = Math.max(1, Math.min(100, Number(limit) || 25));
  const r = await db.query(
    `SELECT shipment_id, order_number, cost, weight_g, dest_state, dest_zip, due_date, bought_at
       FROM v3.shipment_costs
      WHERE quoted_at IS NULL AND cost > 0 AND dest_zip IS NOT NULL
        AND bought_at > NOW() - INTERVAL '${h} hours'
      ORDER BY bought_at ASC
      LIMIT ${n}`);
  return r.rows || [];
}

/**
 * Resumo do copiloto pra UM dia NY (o bloco da Central + a frase do digest).
 * with_cheaper = outliers com cotação VÁLIDA mais barata que o pago (margem
 * $0.25); best_already = outliers cotados onde o pago já era o melhor;
 * unquoted = outliers ainda sem cotação (falha ou fila do tick).
 * @returns {{day, labeled, total_cost, outliers, with_cheaper:{n,saving}, best_already:{n}, unquoted:{n}}}
 */
async function copilotSummary(db, nyDay) {
  const r = await db.query(
    `SELECT COUNT(*) FILTER (WHERE cost > 0)::int AS labeled,
            COALESCE(SUM(cost) FILTER (WHERE cost > 0), 0)::numeric AS total_cost,
            COUNT(*) FILTER (WHERE outlier)::int AS outliers,
            COUNT(*) FILTER (WHERE outlier AND quoted_best_cost IS NOT NULL
              AND quoted_best_cost < cost - ${QUOTE_MARGIN})::int AS cheaper_n,
            COALESCE(SUM(cost - quoted_best_cost) FILTER (WHERE outlier
              AND quoted_best_cost IS NOT NULL
              AND quoted_best_cost < cost - ${QUOTE_MARGIN}), 0)::numeric AS cheaper_saving,
            COUNT(*) FILTER (WHERE outlier AND quoted_at IS NOT NULL
              AND NOT (quoted_best_cost IS NOT NULL
                AND quoted_best_cost < cost - ${QUOTE_MARGIN}))::int AS best_n,
            COUNT(*) FILTER (WHERE outlier AND quoted_at IS NULL)::int AS unquoted_n
       FROM v3.shipment_costs
      WHERE ny_day = $1::date`, [nyDay]);
  const row = (r.rows && r.rows[0]) || {};
  return {
    day: nyDay,
    labeled: Number(row.labeled || 0),
    total_cost: Number(row.total_cost || 0),
    outliers: Number(row.outliers || 0),
    with_cheaper: { n: Number(row.cheaper_n || 0), saving: Number(row.cheaper_saving || 0) },
    best_already: { n: Number(row.best_n || 0) },
    unquoted: { n: Number(row.unquoted_n || 0) },
  };
}

/** Carimba alerted_at (só se ainda nulo: 1 alerta por etiqueta, pra sempre). */
async function markAlerted(db, shipmentId) {
  const r = await db.query(
    `UPDATE v3.shipment_costs SET alerted_at = NOW()
      WHERE shipment_id = $1 AND alerted_at IS NULL
      RETURNING shipment_id`, [shipmentId]);
  return (r.rowCount || 0) > 0;
}

/**
 * Resumo por dia (últimos N dias) + média 30d de comparação.
 * labeled = etiquetas com custo (>0); walmart_zero = custo 0/nulo (etiqueta de
 * fora, Walmart) — CONTADA mas nunca dentro da média.
 */
async function summary(db, { days = 14 } = {}) {
  const n = Math.max(1, Math.min(60, Number(days) || 14));
  const r = await db.query(
    `SELECT ny_day::text AS day,
            COUNT(*)::int AS shipments,
            COUNT(*) FILTER (WHERE cost > 0)::int AS labeled,
            COUNT(*) FILTER (WHERE cost IS NULL OR cost = 0)::int AS walmart_zero,
            COALESCE(SUM(cost) FILTER (WHERE cost > 0), 0)::numeric AS total_cost,
            COUNT(*) FILTER (WHERE outlier)::int AS outliers,
            COALESCE(SUM(cost - expected_cost)
              FILTER (WHERE outlier AND expected_cost IS NOT NULL), 0)::numeric AS outlier_excess,
            COUNT(*) FILTER (WHERE quoted_at IS NOT NULL)::int AS quoted,
            COUNT(*) FILTER (WHERE outlier AND quoted_best_cost IS NOT NULL
              AND quoted_best_cost < cost - ${QUOTE_MARGIN})::int AS with_cheaper,
            COALESCE(SUM(cost - quoted_best_cost) FILTER (WHERE outlier
              AND quoted_best_cost IS NOT NULL
              AND quoted_best_cost < cost - ${QUOTE_MARGIN}), 0)::numeric AS cheaper_saving
       FROM v3.shipment_costs
      WHERE ny_day >= ((NOW() AT TIME ZONE '${EDT}')::date - INTERVAL '${n - 1} days')::date
      GROUP BY ny_day ORDER BY ny_day DESC`);
  const daysOut = (r.rows || []).map((d) => ({
    day: d.day,
    shipments: Number(d.shipments),
    labeled: Number(d.labeled),
    walmart_zero: Number(d.walmart_zero),
    total_cost: Number(d.total_cost),
    avg_cost: Number(d.labeled) > 0 ? Number(d.total_cost) / Number(d.labeled) : null,
    outliers: Number(d.outliers),
    outlier_excess: Number(d.outlier_excess),
    // copiloto (Fase A): quantas do dia já cotadas e quantos outliers tinham
    // alternativa válida mais barata (margem $0.25), com a economia possível
    quoted: Number(d.quoted || 0),
    with_cheaper: Number(d.with_cheaper || 0),
    cheaper_saving: Number(d.cheaper_saving || 0),
  }));
  const r30 = await db.query(
    `SELECT COALESCE(SUM(cost), 0)::numeric AS total, COUNT(*)::int AS labeled
       FROM v3.shipment_costs
      WHERE cost > 0 AND bought_at > NOW() - INTERVAL '30 days'`);
  const t30 = (r30.rows && r30.rows[0]) || { total: 0, labeled: 0 };
  return {
    days: daysOut,
    avg_30d: Number(t30.labeled) > 0 ? Number(t30.total) / Number(t30.labeled) : null,
    labeled_30d: Number(t30.labeled || 0),
  };
}

/** Outliers de um dia NY (default hoje), com tudo que o alerta/card precisa. */
async function outliersOf(db, day) {
  const params = [];
  let dayExpr = `(NOW() AT TIME ZONE '${EDT}')::date`;
  if (day) { params.push(day); dayExpr = '$1::date'; }
  const r = await db.query(
    `SELECT shipment_id, order_id, order_number, channel, service, weight_g,
            cost, expected_cost, band, outlier_reason, bought_at, due_date,
            dest_state, dest_zip, alerted_at, ny_day::text AS ny_day,
            quoted_best_cost, quoted_best_service, quoted_valid_count, quoted_at
       FROM v3.shipment_costs
      WHERE outlier = true AND ny_day = ${dayExpr}
      ORDER BY (cost - COALESCE(expected_cost, 0)) DESC`, params);
  return r.rows || [];
}

async function todayOutliers(db) { return outliersOf(db, null); }

/** Medianas atuais por faixa ("como eu sei que o número é o certo": mostrando). */
async function bands(db) {
  const r = await db.query(
    `SELECT band,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost) AS median,
            MIN(cost)::numeric AS min, MAX(cost)::numeric AS max,
            COUNT(*)::int AS samples
       FROM v3.shipment_costs
      WHERE cost > 0 AND band IS NOT NULL
        AND bought_at > NOW() - INTERVAL '30 days'
      GROUP BY band ORDER BY COUNT(*) DESC`);
  return (r.rows || []).map((b) => ({
    band: b.band,
    median: b.median != null ? Number(b.median) : null,
    min: Number(b.min), max: Number(b.max),
    samples: Number(b.samples),
    judging: Number(b.samples) >= MIN_SAMPLES,   // faixa fina ainda não julga
  }));
}

module.exports = {
  bandOf, serviceKey, weightBand, judge,
  expectedFor, upsertShipments, saveJudgement, markAlerted,
  saveQuote, unquoted, copilotSummary,
  summary, outliersOf, todayOutliers, bands,
  MIN_SAMPLES, MIN_STATE_SAMPLES, OUTLIER_PCT, OUTLIER_ABS, CEILING_COST,
  QUOTE_MARGIN,
};
