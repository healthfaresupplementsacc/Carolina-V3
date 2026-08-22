'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — PESO vira CONTAGEM (S15 Fase 3, Bruno 08-18;
 * regra do ceil + tipos de caixa S15.43, Bruno 08-22).
 *
 * O problema real: contar garrafa a garrafa é o que ninguém termina. A balança
 * resolve — desde que o sistema saiba duas coisas:
 *   1. o peso de UMA garrafa do produto (unit_weight_g), calibrado de uma amostra
 *   2. a TARA do recipiente (caixa, tipo de caixa, bin, ou informada na hora)
 *
 * REGRA DO CEIL (Bruno 08-22): meia garrafa CONTA como garrafa — nunca subcontar.
 *   qty = max(0, ceil(net/unit − 0.15))
 * A folga de 0.15 engole o ruído da balança: só acima de 15% de uma garrafa o
 * número sobe. MAS resíduo grande sem explicação = RECONTAGEM: a tela mostra a
 * faixa ("dá 109 a 111") e sugere contar na mão em vez de gravar número duvidoso.
 *
 * O RESÍDUO é a distância da leitura pro inteiro MAIS PERTO (o quanto ela é
 * ambígua). Toda contagem por peso devolve `confidence`:
 *   high   resíduo < 25% de uma garrafa   → pode aprovar batendo o olho
 *   medium resíduo < 40%                  → confere antes
 *   low    resíduo >= 40%, ou sem peso unitário cadastrado → conta na mão
 * E `recount_suggested` quando resíduo > 0.35, quando a incerteza da tara do
 * tipo de caixa abre a faixa em 1+ garrafa (qty_max − qty_min >= 1), ou quando
 * não há peso unitário. Nunca escondemos um número ruim: a proposta vai com o
 * resíduo junto (RULE #0 registra sempre; quem decide vê o número na frente).
 *
 * TIPO DE CAIXA (v3.box_types): a caixa é registrada pelo TAMANHO ("20x20x20").
 * Pesa-se ~10 vazias; a MÉDIA vira a tara do tipo e o espalhamento real entre
 * elas (tare_min_g..tare_max_g) vira a incerteza da contagem (qty_min..qty_max).
 * Calibração velha (60+ dias) gera o aviso "Precisamos re-pesar as caixas X" —
 * aviso que NUNCA bloqueia.
 *
 * Este módulo NÃO escreve quantidade de estoque. Ele calcula e guarda peso/tara
 * (products.unit_weight_g, stock_bins.tare_g, stock_boxes.tare_g, tare_presets,
 * box_types). Quem mexe em qty continua sendo só o StockService (porta única).
 */

// O resíduo é a distância pro inteiro mais perto, então a escala útil é 0 a 0.5.
// Perto de 0.5 a leitura é ambígua por definição: 48 e 49 pesariam quase a mesma
// coisa. Por isso os cortes ficam ABAIXO de meio.
const HIGH_RESIDUAL = 0.25;    // < 25% de uma garrafa sobrando = contagem confiável
const MEDIUM_RESIDUAL = 0.40;  // 25% a 40% dá pra usar conferindo; acima disso, conta na mão
const RECOUNT_RESIDUAL = 0.35; // acima disso a tela sugere contar na mão (Bruno 08-22)
const UNDERCOUNT_GUARD = 0.15; // folga do ceil: só acima de 15% de garrafa o número sobe
const RECAL_DAYS = 60;         // calibração de tipo de caixa mais velha que isso pede re-pesagem

// confiança em PT-BR pro contrato do /count/compute (a UI nova fala português)
const CONF_PT = { high: 'alta', medium: 'média', low: 'baixa' };

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Calibra o peso unitário a partir de uma amostra pesada.
 * (bruto − tara) ÷ nº de garrafas. Ex.: 10 garrafas + caixa 780g pesando 5.180g
 * → (5180 − 780) / 10 = 440 g por garrafa.
 * @returns {number} gramas por garrafa (4 casas)
 */
function calibrateUnitWeight({ sample_gross_g, sample_count, sample_tare_g }) {
  const gross = num(sample_gross_g);
  const count = num(sample_count);
  const tare = num(sample_tare_g) || 0;
  if (gross == null || gross <= 0) throw new Error('sample_gross_g inválido (maior que 0)');
  if (count == null || count <= 0 || !Number.isInteger(count)) {
    throw new Error('sample_count inválido (inteiro maior que 0)');
  }
  if (tare < 0) throw new Error('sample_tare_g inválido (0 ou mais)');
  const net = gross - tare;
  if (net <= 0) throw new Error('peso líquido da amostra ficou zero ou negativo, confira a tara');
  return Math.round((net / count) * 10000) / 10000;
}

/** Calibração do tipo velha (ou nunca feita) → hora de re-pesar as caixas. */
function needsRecalibration(lastCalibratedAt, now = new Date()) {
  if (!lastCalibratedAt) return true;
  const t = new Date(lastCalibratedAt).getTime();
  return !Number.isFinite(t) || (now.getTime() - t) > RECAL_DAYS * 86400000;
}

/** A regra do ceil isolada: net → qty (nunca subconta, nunca negativa). */
function ceilQty(net, unit) {
  if (net == null || unit == null || unit <= 0 || net <= 0) return 0;
  // arredonda o exato em 6 casas ANTES da folga: 48.15 de garrafas tem que dar
  // exatamente 48, não 49 por causa de 1e-14 de ponto flutuante
  const exact = Math.round((net / unit) * 1e6) / 1e6;
  return Math.max(0, Math.ceil(exact - UNDERCOUNT_GUARD));
}

/**
 * Peso bruto → quantidade, com a faixa de incerteza da tara.
 * Sem peso unitário devolve qty null e confiança 'low' (não inventamos um
 * número: a tela manda contar na mão).
 * @param {object} p {gross_g, tare_g?, unit_weight_g, tare_spread_g?}
 *   tare_spread_g = espalhamento real do tipo de caixa (tare_max − tare_min);
 *   qty_min/qty_max saem da MESMA conta com tara ± metade do espalhamento.
 * @returns {{unit_weight_g, tare_g, tare_spread_g, net_g, qty, qty_min, qty_max,
 *            residual_g, residual_fraction, confidence:'high'|'medium'|'low',
 *            recount_suggested:boolean}}
 */
function computeQty({ gross_g, tare_g, unit_weight_g, tare_spread_g }) {
  const gross = num(gross_g);
  const tare = num(tare_g) || 0;
  const unit = num(unit_weight_g);
  const spread = Math.max(0, num(tare_spread_g) || 0);
  if (gross == null || gross < 0) throw new Error('gross_g inválido (0 ou mais)');
  if (tare < 0) throw new Error('tare_g inválido (0 ou mais)');
  const net = round2(gross - tare);
  const base = { unit_weight_g: unit, tare_g: tare, tare_spread_g: spread, net_g: net };
  if (unit == null || unit <= 0) {
    return { ...base, unit_weight_g: null, qty: null, qty_min: null, qty_max: null,
      residual_g: null, residual_fraction: null, confidence: 'low',
      recount_suggested: true };
  }
  // líquido zero/negativo = caixa vazia, ou tara maior que o bruto (recipiente
  // errado). Zero, nunca negativo — e negativo pede recontagem.
  if (net <= 0) {
    const residual = round2(Math.abs(net));
    return { ...base, qty: 0, qty_min: 0,
      qty_max: spread > 0 ? ceilQty(round2(gross - (tare - spread / 2)), unit) : 0,
      residual_g: residual,
      residual_fraction: Math.round((residual / unit) * 10000) / 10000,
      confidence: net === 0 ? 'high' : 'low',
      recount_suggested: net !== 0 };
  }
  const exact = Math.round((net / unit) * 1e6) / 1e6;
  const qty = Math.max(0, Math.ceil(exact - UNDERCOUNT_GUARD));
  // resíduo = distância pro inteiro MAIS PERTO: é a ambiguidade da leitura, não
  // a diferença pro qty escolhido (o ceil sobe de propósito, isso não é erro)
  const frac = exact - Math.floor(exact);
  const residualFraction = Math.round(Math.min(frac, 1 - frac) * 10000) / 10000;
  const residual = round2(residualFraction * unit);
  const confidence = residualFraction < HIGH_RESIDUAL ? 'high'
    : (residualFraction < MEDIUM_RESIDUAL ? 'medium' : 'low');
  // faixa: a MESMA conta com tara ± metade do espalhamento entre caixas do tipo
  const qtyMin = Math.min(qty, ceilQty(round2(gross - (tare + spread / 2)), unit));
  const qtyMax = Math.max(qty, ceilQty(round2(gross - (tare - spread / 2)), unit));
  return { ...base, qty, qty_min: qtyMin, qty_max: qtyMax,
    residual_g: residual, residual_fraction: residualFraction, confidence,
    recount_suggested: residualFraction > RECOUNT_RESIDUAL || (qtyMax - qtyMin) >= 1 };
}

/**
 * Repo de pesos e taras. Nenhuma query aqui toca qty de bin/caixa.
 */
class WeightsRepo {
  constructor(deps = {}) { this.db = deps.db; }

  /** Tudo que a tela de pesos precisa: produtos, presets, bins e caixas. */
  async list() {
    const [products, tares, bins, boxes] = await Promise.all([
      this.db.query(`
        SELECT p.id AS product_id, p.canonical_name AS name, p.nickname,
               p.unit_weight_g, COALESCE(p.unit_weight_samples, 0) AS samples,
               p.unit_weight_updated_at AS updated_at
          FROM v3.products p
         WHERE p.active
         ORDER BY COALESCE(p.nickname, p.canonical_name)`),
      this.db.query(`
        SELECT id, name, kind, tare_g, active FROM v3.tare_presets
         ORDER BY kind, name`),
      this.db.query(`
        SELECT id, bin_code, tare_g, capacity FROM v3.stock_bins
         WHERE active ORDER BY bin_code`),
      this.db.query(`
        SELECT id, box_number, tare_g, batch_number, sealed FROM v3.stock_boxes
         WHERE status = 'in_storage' ORDER BY box_number`),
    ]);
    const n = (v) => (v == null ? null : Number(v));
    return {
      products: products.rows.map((r) => ({
        product_id: r.product_id, name: r.name, nickname: r.nickname || r.name,
        unit_weight_g: n(r.unit_weight_g), samples: Number(r.samples) || 0,
        updated_at: r.updated_at || null,
      })),
      tares: tares.rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, tare_g: n(r.tare_g), active: !!r.active })),
      bins: bins.rows.map((r) => ({ id: r.id, bin_code: r.bin_code, tare_g: n(r.tare_g), capacity: r.capacity == null ? null : Number(r.capacity) })),
      boxes: boxes.rows.map((r) => ({ id: r.id, box_number: r.box_number, tare_g: n(r.tare_g),
        batch_number: r.batch_number || null, sealed: !!r.sealed })),
    };
  }

  /** Peso unitário de um produto (null quando nunca calibrado). */
  async unitWeightOf(productId) {
    const r = await this.db.query(
      'SELECT unit_weight_g FROM v3.products WHERE id = $1', [Number(productId)]);
    if (!r.rows[0]) throw new Error('produto não existe: ' + productId);
    return num(r.rows[0].unit_weight_g);
  }

  /**
   * Grava o peso unitário: direto (unit_weight_g) OU calibrado da amostra.
   * p: {product_id, unit_weight_g?, sample_gross_g?, sample_count?, sample_tare_g?}
   */
  async setUnitWeight(p = {}) {
    const id = Number(p.product_id);
    if (!id) throw new Error('product_id inválido');
    let unit = num(p.unit_weight_g);
    let samples = 1;
    if (unit == null) {
      unit = calibrateUnitWeight(p);
      samples = Number(p.sample_count) || 1;
    } else if (unit <= 0) {
      throw new Error('unit_weight_g inválido (maior que 0)');
    }
    const r = await this.db.query(
      `UPDATE v3.products
          SET unit_weight_g = $2, unit_weight_samples = $3, unit_weight_updated_at = NOW()
        WHERE id = $1
      RETURNING id AS product_id, canonical_name AS name, nickname,
                unit_weight_g, unit_weight_samples AS samples, unit_weight_updated_at AS updated_at`,
      [id, unit, samples]);
    if (!r.rows[0]) throw new Error('produto não existe: ' + id);
    const row = r.rows[0];
    return { ...row, unit_weight_g: num(row.unit_weight_g), samples: Number(row.samples) || 0 };
  }

  /** Preset de tara reusável (upsert pelo nome). p: {name, kind, tare_g, active?} */
  async upsertTare(p = {}) {
    const name = String(p.name || '').trim();
    if (!name) throw new Error('name obrigatório');
    const kind = p.kind === 'box' ? 'box' : (p.kind === 'bin' ? 'bin' : null);
    if (!kind) throw new Error('kind inválido (bin ou box)');
    const tare = num(p.tare_g);
    if (tare == null || tare < 0) throw new Error('tare_g inválido (0 ou mais)');
    const r = await this.db.query(
      `INSERT INTO v3.tare_presets (name, kind, tare_g, active)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET kind = EXCLUDED.kind, tare_g = EXCLUDED.tare_g,
             active = EXCLUDED.active, updated_at = NOW()
       RETURNING id, name, kind, tare_g, active`,
      [name, kind, tare, p.active === undefined ? true : !!p.active]);
    const row = r.rows[0];
    return { ...row, tare_g: num(row.tare_g) };
  }

  /** Tara/capacidade de um bin. Nunca toca qty. p: {tare_g?, capacity?} */
  async setBin(id, p = {}) {
    const binId = Number(id);
    if (!binId) throw new Error('bin_id inválido');
    const tare = p.tare_g === undefined ? null : num(p.tare_g);
    const cap = p.capacity === undefined ? null : num(p.capacity);
    if (tare != null && tare < 0) throw new Error('tare_g inválido (0 ou mais)');
    if (cap != null && (cap < 0 || !Number.isInteger(cap))) throw new Error('capacity inválido (inteiro 0 ou mais)');
    const r = await this.db.query(
      `UPDATE v3.stock_bins
          SET tare_g = COALESCE($2, tare_g), capacity = COALESCE($3, capacity), updated_at = NOW()
        WHERE id = $1 RETURNING id, bin_code, tare_g, capacity`,
      [binId, tare, cap]);
    if (!r.rows[0]) throw new Error('bin não existe: ' + binId);
    const row = r.rows[0];
    return { ...row, tare_g: num(row.tare_g), capacity: row.capacity == null ? null : Number(row.capacity) };
  }

  /** Tara/lote/lacre de uma caixa. Nunca toca qty. p: {tare_g?, batch_number?, sealed?} */
  async setBox(id, p = {}) {
    const boxId = Number(id);
    if (!boxId) throw new Error('box_id inválido');
    const tare = p.tare_g === undefined ? null : num(p.tare_g);
    if (tare != null && tare < 0) throw new Error('tare_g inválido (0 ou mais)');
    const batch = p.batch_number === undefined ? null : (String(p.batch_number || '').trim() || null);
    const sealed = p.sealed === undefined ? null : !!p.sealed;
    const r = await this.db.query(
      `UPDATE v3.stock_boxes
          SET tare_g = COALESCE($2, tare_g),
              batch_number = COALESCE($3, batch_number),
              sealed = COALESCE($4, sealed),
              updated_at = NOW()
        WHERE id = $1 RETURNING id, box_number, tare_g, batch_number, sealed`,
      [boxId, tare, batch, sealed]);
    if (!r.rows[0]) throw new Error('caixa não existe: ' + boxId);
    const row = r.rows[0];
    return { ...row, tare_g: num(row.tare_g), sealed: !!row.sealed };
  }

  /**
   * Resolve a tara de uma pesagem, COM a incerteza (Bruno 08-22):
   *   informada > tara da própria caixa > tara do TIPO da caixa >
   *   tipo informado direto (box_type_id) > tara do bin > 0
   * spread_g só existe quando a tara veio de um TIPO (média de várias caixas):
   * é o espalhamento real entre as caixas pesadas, e vira qty_min..qty_max.
   * @returns {Promise<{tare_g:number, spread_g:number, source:string}>}
   */
  async resolveTareInfo({ tare_g, bin_id, box_id, box_type_id }) {
    const given = num(tare_g);
    if (given != null) return { tare_g: given, spread_g: 0, source: 'informada' };
    const spreadOf = (row) => {
      const min = num(row.tare_min_g); const max = num(row.tare_max_g);
      return min != null && max != null ? Math.max(0, round2(max - min)) : 0;
    };
    if (box_id) {
      const r = await this.db.query(
        `SELECT x.tare_g, t.tare_g AS type_tare_g, t.tare_min_g, t.tare_max_g
           FROM v3.stock_boxes x
           LEFT JOIN v3.box_types t ON t.id = x.box_type_id
          WHERE x.id = $1`, [Number(box_id)]);
      if (!r.rows[0]) throw new Error('caixa não existe: ' + box_id);
      const row = r.rows[0];
      if (num(row.tare_g) != null) return { tare_g: num(row.tare_g), spread_g: 0, source: 'caixa' };
      if (num(row.type_tare_g) != null) {
        return { tare_g: num(row.type_tare_g), spread_g: spreadOf(row), source: 'tipo' };
      }
    }
    if (box_type_id) {
      const r = await this.db.query(
        'SELECT tare_g, tare_min_g, tare_max_g FROM v3.box_types WHERE id = $1',
        [Number(box_type_id)]);
      if (!r.rows[0]) throw new Error('tipo de caixa não existe: ' + box_type_id);
      const row = r.rows[0];
      if (num(row.tare_g) != null) {
        return { tare_g: num(row.tare_g), spread_g: spreadOf(row), source: 'tipo' };
      }
    }
    if (bin_id) {
      const r = await this.db.query('SELECT tare_g FROM v3.stock_bins WHERE id = $1', [Number(bin_id)]);
      if (!r.rows[0]) throw new Error('bin não existe: ' + bin_id);
      return { tare_g: num(r.rows[0].tare_g) || 0, spread_g: 0, source: 'bin' };
    }
    return { tare_g: 0, spread_g: 0, source: 'nenhuma' };
  }

  /** Compat: só o número da tara (a confiança cai sozinha pelo resíduo). */
  async resolveTare(p = {}) {
    return (await this.resolveTareInfo(p)).tare_g;
  }

  /**
   * Pesagem completa: resolve tara (+ incerteza do tipo) + peso unitário do
   * produto e calcula com a regra do ceil.
   * p: {product_id, gross_g, tare_g?, bin_id?, box_id?, box_type_id?}
   */
  async compute(p = {}) {
    const productId = Number(p.product_id);
    if (!productId) throw new Error('product_id inválido');
    const [unit, tareInfo] = await Promise.all([
      this.unitWeightOf(productId),
      this.resolveTareInfo(p),
    ]);
    return computeQty({ gross_g: p.gross_g, tare_g: tareInfo.tare_g,
      tare_spread_g: tareInfo.spread_g, unit_weight_g: unit });
  }
}

/**
 * Repo dos TIPOS de caixa (S15.43). Só metadado físico: dimensões e estatística
 * da tara (média/min/max/amostras). NUNCA quantidade.
 */
class BoxTypesRepo {
  constructor(deps = {}) { this.db = deps.db; }

  _shape(row) {
    const n = (v) => (v == null ? null : Number(v));
    const min = n(row.tare_min_g); const max = n(row.tare_max_g);
    return {
      id: row.id, name: row.name,
      length_cm: n(row.length_cm), width_cm: n(row.width_cm), height_cm: n(row.height_cm),
      tare_g: n(row.tare_g), tare_samples: Number(row.tare_samples) || 0,
      tare_min_g: min, tare_max_g: max,
      spread_g: min != null && max != null ? Math.max(0, round2(max - min)) : 0,
      last_calibrated_at: row.last_calibrated_at || null,
      needs_recalibration: needsRecalibration(row.last_calibrated_at),
      active: !!row.active,
      boxes_count: Number(row.boxes_count) || 0,
    };
  }

  /** Todos os tipos, com quantas caixas físicas apontam pra cada um. */
  async list() {
    const r = await this.db.query(`
      SELECT t.id, t.name, t.length_cm, t.width_cm, t.height_cm, t.tare_g,
             t.tare_samples, t.tare_min_g, t.tare_max_g, t.last_calibrated_at, t.active,
             COALESCE(x.n, 0) AS boxes_count
        FROM v3.box_types t
        LEFT JOIN (SELECT box_type_id, COUNT(*)::int AS n FROM v3.stock_boxes
                    WHERE box_type_id IS NOT NULL GROUP BY box_type_id) x
          ON x.box_type_id = t.id
       ORDER BY t.active DESC, t.name`);
    return r.rows.map((row) => this._shape(row));
  }

  async byId(id) {
    const typeId = Number(id);
    if (!typeId) throw new Error('box_type_id inválido');
    const r = await this.db.query(`
      SELECT t.*, COALESCE(x.n, 0) AS boxes_count
        FROM v3.box_types t
        LEFT JOIN (SELECT box_type_id, COUNT(*)::int AS n FROM v3.stock_boxes
                    WHERE box_type_id IS NOT NULL GROUP BY box_type_id) x
          ON x.box_type_id = t.id
       WHERE t.id = $1`, [typeId]);
    if (!r.rows[0]) throw new Error('tipo de caixa não existe: ' + typeId);
    return this._shape(r.rows[0]);
  }

  /** Cria um tipo pelo nome ("20x20x20"). p: {name, length_cm?, width_cm?, height_cm?} */
  async create(p = {}) {
    const name = String(p.name || '').trim();
    if (!name) throw new Error('name obrigatório');
    const d = (v) => {
      const x = num(v);
      if (x != null && x <= 0) throw new Error('dimensão inválida (maior que 0)');
      return x;
    };
    const r = await this.db.query(
      `INSERT INTO v3.box_types (name, length_cm, width_cm, height_cm)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET length_cm = COALESCE(EXCLUDED.length_cm, v3.box_types.length_cm),
             width_cm  = COALESCE(EXCLUDED.width_cm,  v3.box_types.width_cm),
             height_cm = COALESCE(EXCLUDED.height_cm, v3.box_types.height_cm),
             active = true
       RETURNING *`,
      [name, d(p.length_cm), d(p.width_cm), d(p.height_cm)]);
    return this._shape({ ...r.rows[0], boxes_count: 0 });
  }

  /** Atualiza nome/dimensões/ativo. p: {name?, active?, dims?:{length_cm,width_cm,height_cm}} */
  async update(id, p = {}) {
    const typeId = Number(id);
    if (!typeId) throw new Error('box_type_id inválido');
    const dims = p.dims || {};
    const name = p.name === undefined ? null : String(p.name || '').trim();
    if (name !== null && !name) throw new Error('name inválido (não pode ficar vazio)');
    const d = (v) => (v === undefined ? null : num(v));
    const r = await this.db.query(
      `UPDATE v3.box_types
          SET name      = COALESCE($2, name),
              active    = COALESCE($3, active),
              length_cm = COALESCE($4, length_cm),
              width_cm  = COALESCE($5, width_cm),
              height_cm = COALESCE($6, height_cm)
        WHERE id = $1 RETURNING *`,
      [typeId, name, p.active === undefined ? null : !!p.active,
        d(dims.length_cm != null ? dims.length_cm : p.length_cm),
        d(dims.width_cm != null ? dims.width_cm : p.width_cm),
        d(dims.height_cm != null ? dims.height_cm : p.height_cm)]);
    if (!r.rows[0]) throw new Error('tipo de caixa não existe: ' + typeId);
    return this.byId(typeId);
  }

  /**
   * CALIBRAR a tara do tipo (Bruno 08-22): pesa ~10 caixas vazias.
   *   {weights_g:[...]} uma a uma → média/min/max reais, samples = quantas
   *   {total_g, count} todas juntas → média = total/count, min = max = média
   * SUBSTITUI a estatística anterior (re-pesagem periódica) e carimba
   * last_calibrated_at. Nunca bloqueia nada — é só o número ficando novo.
   */
  async calibrate(id, p = {}) {
    const typeId = Number(id);
    if (!typeId) throw new Error('box_type_id inválido');
    let mean, min, max, samples;
    const list = Array.isArray(p.weights_g) ? p.weights_g.map(num) : null;
    if (list && list.length) {
      if (list.some((w) => w == null || w <= 0)) {
        throw new Error('weights_g inválido (todos os pesos maiores que 0)');
      }
      samples = list.length;
      mean = Math.round((list.reduce((a, b) => a + b, 0) / samples) * 100) / 100;
      min = round2(Math.min(...list));
      max = round2(Math.max(...list));
    } else {
      const total = num(p.total_g); const count = num(p.count);
      if (total == null || total <= 0) throw new Error('weights_g ou total_g obrigatório (maior que 0)');
      if (count == null || count <= 0 || !Number.isInteger(count)) {
        throw new Error('count inválido (inteiro maior que 0)');
      }
      samples = count;
      mean = round2(total / count);
      min = mean; max = mean;    // pesou tudo junto: não dá pra saber o espalhamento
    }
    const r = await this.db.query(
      `UPDATE v3.box_types
          SET tare_g = $2, tare_samples = $3, tare_min_g = $4, tare_max_g = $5,
              last_calibrated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [typeId, mean, samples, min, max]);
    if (!r.rows[0]) throw new Error('tipo de caixa não existe: ' + typeId);
    return this.byId(typeId);
  }

  /** Tipos ativos precisando de re-pesagem (aviso, nunca bloqueio). */
  async recalibrationWarnings() {
    const r = await this.db.query(`
      SELECT id, name, last_calibrated_at FROM v3.box_types
       WHERE active AND (last_calibrated_at IS NULL
                         OR last_calibrated_at < NOW() - INTERVAL '${RECAL_DAYS} days')
       ORDER BY name`);
    return r.rows.map((row) => ({ box_type_id: row.id, name: row.name,
      last_calibrated_at: row.last_calibrated_at || null }));
  }
}

module.exports = {
  WeightsRepo, BoxTypesRepo, computeQty, calibrateUnitWeight, needsRecalibration,
  HIGH_RESIDUAL, MEDIUM_RESIDUAL, RECOUNT_RESIDUAL, UNDERCOUNT_GUARD, RECAL_DAYS,
  CONF_PT,
};
