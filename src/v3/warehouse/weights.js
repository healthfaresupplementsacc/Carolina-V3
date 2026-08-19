'use strict';
/**
 * HEALTHFARE V3 — Warehouse hub — PESO vira CONTAGEM (S15 Fase 3, Bruno 08-18).
 *
 * O problema real: contar garrafa a garrafa é o que ninguém termina. A balança
 * resolve — desde que o sistema saiba duas coisas:
 *   1. o peso de UMA garrafa do produto (unit_weight_g), calibrado de uma amostra
 *   2. a TARA do recipiente (o bin/caixa vazio, ou um preset reusável)
 * Aí:  qty = arredonda((bruto − tara) / unitário)
 *
 * O RESÍDUO é o que separa uma contagem boa de um chute. Se sobra meia garrafa de
 * peso, ou a tara está errada, ou tem coisa a mais na caixa, ou o peso unitário
 * está velho. Por isso toda contagem por peso devolve `confidence`:
 *   high   resíduo < 25% de uma garrafa   → pode aprovar batendo o olho
 *   medium resíduo < 60%                  → confere antes
 *   low    resíduo >= 60%, ou sem peso unitário cadastrado → conta na mão
 * Nunca escondemos um número ruim: a proposta vai com o resíduo junto (RULE #0
 * registra sempre; quem decide é o admin, com o número na frente).
 *
 * Este módulo NÃO escreve quantidade de estoque. Ele calcula e guarda peso/tara
 * (products.unit_weight_g, stock_bins.tare_g, stock_boxes.tare_g, tare_presets).
 * Quem mexe em qty continua sendo só o StockService (porta única).
 */

// O resíduo NUNCA passa de meia garrafa (arredondamos pro inteiro mais perto), então
// a escala útil é 0 a 0.5. Perto de 0.5 a leitura é ambígua por definição: 48 e 49
// pesariam quase a mesma coisa. Por isso o corte do 'medium' fica ABAIXO de meio.
const HIGH_RESIDUAL = 0.25;    // < 25% de uma garrafa sobrando = contagem confiável
const MEDIUM_RESIDUAL = 0.40;  // 25% a 40% dá pra usar conferindo; acima disso, conta na mão

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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

/**
 * Peso bruto → quantidade. Sem peso unitário devolve qty null e confiança 'low'
 * (não inventamos um número: a tela manda contar na mão).
 * @returns {{unit_weight_g:number|null, tare_g:number, net_g:number,
 *            qty:number|null, residual_g:number|null, confidence:'high'|'medium'|'low'}}
 */
function computeQty({ gross_g, tare_g, unit_weight_g }) {
  const gross = num(gross_g);
  const tare = num(tare_g) || 0;
  const unit = num(unit_weight_g);
  if (gross == null || gross < 0) throw new Error('gross_g inválido (0 ou mais)');
  if (tare < 0) throw new Error('tare_g inválido (0 ou mais)');
  const net = Math.round((gross - tare) * 100) / 100;
  if (unit == null || unit <= 0) {
    return { unit_weight_g: null, tare_g: tare, net_g: net, qty: null, residual_g: null, confidence: 'low' };
  }
  // líquido negativo = tara maior que o bruto (recipiente errado). Zero, não negativo.
  if (net <= 0) {
    return { unit_weight_g: unit, tare_g: tare, net_g: net, qty: 0,
      residual_g: Math.round(Math.abs(net) * 100) / 100,
      confidence: net === 0 ? 'high' : 'low' };
  }
  const exact = net / unit;
  const qty = Math.round(exact);
  const residual = Math.round(Math.abs(net - qty * unit) * 100) / 100;
  const ratio = residual / unit;
  const confidence = ratio < HIGH_RESIDUAL ? 'high' : (ratio < MEDIUM_RESIDUAL ? 'medium' : 'low');
  return { unit_weight_g: unit, tare_g: tare, net_g: net, qty, residual_g: residual, confidence };
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
   * Resolve a tara de uma pesagem: a informada ganha; senão a do bin/caixa;
   * senão 0 (e a confiança cai sozinha pelo resíduo).
   */
  async resolveTare({ tare_g, bin_id, box_id }) {
    const given = num(tare_g);
    if (given != null) return given;
    if (bin_id) {
      const r = await this.db.query('SELECT tare_g FROM v3.stock_bins WHERE id = $1', [Number(bin_id)]);
      if (!r.rows[0]) throw new Error('bin não existe: ' + bin_id);
      return num(r.rows[0].tare_g) || 0;
    }
    if (box_id) {
      const r = await this.db.query('SELECT tare_g FROM v3.stock_boxes WHERE id = $1', [Number(box_id)]);
      if (!r.rows[0]) throw new Error('caixa não existe: ' + box_id);
      return num(r.rows[0].tare_g) || 0;
    }
    return 0;
  }

  /**
   * Pesagem completa: resolve tara + peso unitário do produto e calcula.
   * p: {product_id, gross_g, tare_g?, bin_id?, box_id?}
   */
  async compute(p = {}) {
    const productId = Number(p.product_id);
    if (!productId) throw new Error('product_id inválido');
    const [unit, tare] = await Promise.all([
      this.unitWeightOf(productId),
      this.resolveTare(p),
    ]);
    return computeQty({ gross_g: p.gross_g, tare_g: tare, unit_weight_g: unit });
  }
}

module.exports = {
  WeightsRepo, computeQty, calibrateUnitWeight,
  HIGH_RESIDUAL, MEDIUM_RESIDUAL,
};
