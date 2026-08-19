'use strict';
/**
 * Peso vira contagem (S15 Fase 3, Bruno 08-18).
 *  1. calibração: (bruto − tara) / nº de garrafas, com a tara descontada certa
 *  2. compute: qty arredondada + RESÍDUO + confiança (high/medium/low)
 *  3. sem peso unitário → qty null e confiança 'low' (nunca chuta um total)
 *  4. o repo grava peso/tara e NUNCA toca qty de bin/caixa
 * DB mockado; nenhum banco, nenhuma rede.
 */
const { WeightsRepo, computeQty, calibrateUnitWeight } = require('../v3/warehouse/weights');

describe('calibrateUnitWeight', () => {
  test('10 garrafas + caixa de 780g pesando 5180g → 440g por garrafa', () => {
    expect(calibrateUnitWeight({ sample_gross_g: 5180, sample_count: 10, sample_tare_g: 780 })).toBe(440);
  });

  test('sem tara informada, usa 0', () => {
    expect(calibrateUnitWeight({ sample_gross_g: 4400, sample_count: 10 })).toBe(440);
  });

  test('arredonda em 4 casas (não perde precisão de amostra pequena)', () => {
    expect(calibrateUnitWeight({ sample_gross_g: 1000, sample_count: 3 })).toBe(333.3333);
  });

  test('contagem inválida e líquido negativo explodem com mensagem em PT-BR', () => {
    expect(() => calibrateUnitWeight({ sample_gross_g: 500, sample_count: 0 })).toThrow(/sample_count/);
    expect(() => calibrateUnitWeight({ sample_gross_g: 0, sample_count: 5 })).toThrow(/sample_gross_g/);
    expect(() => calibrateUnitWeight({ sample_gross_g: 100, sample_count: 5, sample_tare_g: 200 }))
      .toThrow(/tara/);
  });
});

describe('computeQty', () => {
  test('exato: 48 garrafas de 440g + tara 780g → 48, resíduo 0, confiança alta', () => {
    const r = computeQty({ gross_g: 48 * 440 + 780, tare_g: 780, unit_weight_g: 440 });
    expect(r.qty).toBe(48);
    expect(r.net_g).toBe(21120);
    expect(r.residual_g).toBe(0);
    expect(r.confidence).toBe('high');
  });

  test('resíduo pequeno (< 25% de uma garrafa) continua confiança alta', () => {
    const r = computeQty({ gross_g: 48 * 440 + 780 + 40, tare_g: 780, unit_weight_g: 440 });
    expect(r.qty).toBe(48);
    expect(r.residual_g).toBe(40);
    expect(r.confidence).toBe('high');
  });

  test('resíduo médio (25% a 60%) → medium: confere antes de aprovar', () => {
    const r = computeQty({ gross_g: 48 * 440 + 150, tare_g: 0, unit_weight_g: 440 });
    expect(r.qty).toBe(48);
    expect(r.residual_g).toBe(150);
    expect(r.confidence).toBe('medium');
  });

  test('meia garrafa sobrando → low (tara errada ou tem coisa a mais na caixa)', () => {
    const r = computeQty({ gross_g: 48 * 440 + 220, tare_g: 0, unit_weight_g: 440 });
    expect(r.confidence).toBe('low');
  });

  test('sem peso unitário: qty null, confiança low, nunca inventa número', () => {
    const r = computeQty({ gross_g: 5000, tare_g: 780, unit_weight_g: null });
    expect(r.qty).toBeNull();
    expect(r.residual_g).toBeNull();
    expect(r.confidence).toBe('low');
    expect(r.net_g).toBe(4220);
  });

  test('bruto igual à tara → 0 garrafas com confiança alta (o bin está vazio mesmo)', () => {
    const r = computeQty({ gross_g: 780, tare_g: 780, unit_weight_g: 440 });
    expect(r.qty).toBe(0);
    expect(r.confidence).toBe('high');
  });

  test('tara maior que o bruto → 0 e confiança low (recipiente errado, avisa)', () => {
    const r = computeQty({ gross_g: 500, tare_g: 780, unit_weight_g: 440 });
    expect(r.qty).toBe(0);
    expect(r.confidence).toBe('low');
  });

  test('gross negativo é rejeitado', () => {
    expect(() => computeQty({ gross_g: -1, tare_g: 0, unit_weight_g: 440 })).toThrow(/gross_g/);
  });
});

// ── repo ───────────────────────────────────────────────────────
function makeDb(state) {
  return {
    calls: state.calls,
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.calls.push(q);
      if (/SELECT unit_weight_g FROM v3\.products/.test(q)) {
        const p = state.products.find((x) => x.id === params[0]);
        return { rows: p ? [{ unit_weight_g: p.unit_weight_g }] : [] };
      }
      if (q.startsWith('UPDATE v3.products SET unit_weight_g')) {
        const p = state.products.find((x) => x.id === params[0]);
        if (!p) return { rows: [] };
        p.unit_weight_g = params[1]; p.unit_weight_samples = params[2];
        return { rows: [{ product_id: p.id, name: p.name, nickname: p.nickname,
          unit_weight_g: p.unit_weight_g, samples: p.unit_weight_samples, updated_at: 'now' }] };
      }
      if (q.startsWith('INSERT INTO v3.tare_presets')) {
        const row = { id: 9, name: params[0], kind: params[1], tare_g: params[2], active: params[3] };
        state.tares.push(row); return { rows: [row] };
      }
      if (q.startsWith('UPDATE v3.stock_bins')) {
        const b = state.bins.find((x) => x.id === params[0]);
        if (!b) return { rows: [] };
        if (params[1] != null) b.tare_g = params[1];
        if (params[2] != null) b.capacity = params[2];
        return { rows: [{ id: b.id, bin_code: b.bin_code, tare_g: b.tare_g, capacity: b.capacity }] };
      }
      if (q.startsWith('UPDATE v3.stock_boxes')) {
        const b = state.boxes.find((x) => x.id === params[0]);
        if (!b) return { rows: [] };
        if (params[1] != null) b.tare_g = params[1];
        if (params[2] != null) b.batch_number = params[2];
        if (params[3] != null) b.sealed = params[3];
        return { rows: [{ id: b.id, box_number: b.box_number, tare_g: b.tare_g,
          batch_number: b.batch_number, sealed: b.sealed }] };
      }
      if (/SELECT tare_g FROM v3\.stock_bins/.test(q)) {
        const b = state.bins.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g }] : [] };
      }
      if (/SELECT tare_g FROM v3\.stock_boxes/.test(q)) {
        const b = state.boxes.find((x) => x.id === params[0]);
        return { rows: b ? [{ tare_g: b.tare_g }] : [] };
      }
      if (/FROM v3\.products p WHERE p\.active/.test(q)) {
        return { rows: state.products.map((p) => ({ product_id: p.id, name: p.name, nickname: p.nickname,
          unit_weight_g: p.unit_weight_g, samples: p.unit_weight_samples, updated_at: null })) };
      }
      if (/FROM v3\.tare_presets/.test(q)) return { rows: state.tares };
      if (/FROM v3\.stock_bins WHERE active/.test(q)) return { rows: state.bins };
      if (/FROM v3\.stock_boxes WHERE status/.test(q)) return { rows: state.boxes };
      return { rows: [] };
    },
  };
}

function boot() {
  const state = {
    calls: [],
    products: [{ id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', unit_weight_g: 440, unit_weight_samples: 10 },
      { id: 11, name: 'Sem peso', nickname: 'SEMPESO', unit_weight_g: null, unit_weight_samples: 0 }],
    tares: [], bins: [{ id: 1, bin_code: 'A03B2', tare_g: 120, capacity: 48 }],
    boxes: [{ id: 5, box_number: 'BX-0451', tare_g: 780, batch_number: null, sealed: false }],
  };
  return { state, repo: new WeightsRepo({ db: makeDb(state) }) };
}

describe('WeightsRepo', () => {
  test('list devolve produtos, taras, bins e caixas com números (não string do pg)', async () => {
    const { repo } = boot();
    const out = await repo.list();
    expect(out.products[0]).toMatchObject({ product_id: 10, nickname: 'BENF-300', unit_weight_g: 440 });
    expect(out.bins[0]).toEqual({ id: 1, bin_code: 'A03B2', tare_g: 120, capacity: 48 });
    expect(out.boxes[0]).toMatchObject({ box_number: 'BX-0451', tare_g: 780, sealed: false });
  });

  test('setUnitWeight direto grava o valor com samples 1', async () => {
    const { state, repo } = boot();
    const row = await repo.setUnitWeight({ product_id: 10, unit_weight_g: 455 });
    expect(row.unit_weight_g).toBe(455);
    expect(state.products[0].unit_weight_samples).toBe(1);
  });

  test('setUnitWeight calibrando guarda quantas garrafas foram na amostra', async () => {
    const { state, repo } = boot();
    const row = await repo.setUnitWeight({ product_id: 10, sample_gross_g: 5180, sample_count: 10, sample_tare_g: 780 });
    expect(row.unit_weight_g).toBe(440);
    expect(state.products[0].unit_weight_samples).toBe(10);
  });

  test('nenhuma query do repo mexe em qty de bin ou caixa', async () => {
    const { state, repo } = boot();
    await repo.setUnitWeight({ product_id: 10, unit_weight_g: 440 });
    await repo.setBin(1, { tare_g: 130, capacity: 60 });
    await repo.setBox(5, { tare_g: 800, batch_number: 'L-77', sealed: true });
    await repo.upsertTare({ name: 'Caixa grande', kind: 'box', tare_g: 780 });
    const touchesQty = state.calls.filter((q) => /SET .*\bqty\b/i.test(q));
    expect(touchesQty).toEqual([]);
  });

  test('setBin/setBox validam e devolvem a linha atualizada', async () => {
    const { repo } = boot();
    expect(await repo.setBin(1, { tare_g: 130 })).toMatchObject({ tare_g: 130, capacity: 48 });
    expect(await repo.setBox(5, { batch_number: 'L-77', sealed: true }))
      .toMatchObject({ batch_number: 'L-77', sealed: true, tare_g: 780 });
    await expect(repo.setBin(1, { tare_g: -1 })).rejects.toThrow(/tare_g/);
    await expect(repo.setBin(999, { tare_g: 10 })).rejects.toThrow(/não existe/);
  });

  test('upsertTare exige kind bin|box', async () => {
    const { repo } = boot();
    expect(await repo.upsertTare({ name: 'Caixa grande', kind: 'box', tare_g: 780 }))
      .toMatchObject({ name: 'Caixa grande', kind: 'box', tare_g: 780 });
    await expect(repo.upsertTare({ name: 'x', kind: 'palete', tare_g: 1 })).rejects.toThrow(/kind/);
    await expect(repo.upsertTare({ name: '', kind: 'box', tare_g: 1 })).rejects.toThrow(/name/);
  });

  test('resolveTare: informada ganha da cadastrada; sem nada é 0', async () => {
    const { repo } = boot();
    expect(await repo.resolveTare({ tare_g: 99, bin_id: 1 })).toBe(99);
    expect(await repo.resolveTare({ bin_id: 1 })).toBe(120);
    expect(await repo.resolveTare({ box_id: 5 })).toBe(780);
    expect(await repo.resolveTare({})).toBe(0);
  });

  test('compute usa a tara da caixa e o peso do produto de ponta a ponta', async () => {
    const { repo } = boot();
    const r = await repo.compute({ product_id: 10, gross_g: 48 * 440 + 780, box_id: 5 });
    expect(r).toMatchObject({ qty: 48, tare_g: 780, unit_weight_g: 440, confidence: 'high' });
  });

  test('compute de produto sem peso cadastrado devolve qty null (a tela manda contar)', async () => {
    const { repo } = boot();
    const r = await repo.compute({ product_id: 11, gross_g: 5000, bin_id: 1 });
    expect(r.qty).toBeNull();
    expect(r.confidence).toBe('low');
  });
});
