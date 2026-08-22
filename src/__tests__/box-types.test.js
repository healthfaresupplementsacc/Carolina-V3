'use strict';
/**
 * Tipos de caixa (S15.43, Bruno 08-22): a caixa é registrada pelo TAMANHO
 * ("20x20x20"); pesa-se ~10 vazias e a MÉDIA vira a tara do tipo, com o
 * espalhamento real entre elas (min..max).
 *  1. needsRecalibration: nunca calibrado ou 60+ dias → hora de re-pesar
 *  2. BoxTypesRepo: create/update/calibrate (lista de pesos OU total÷contagem),
 *     spread_g = max − min, NUNCA toca quantidade
 *  3. rotas /box-types: leitura com view_stock, escrita com manage_stock, audit
 *  4. overview: aviso "Precisamos re-pesar as caixas X" na lista de atenção —
 *     aviso que NUNCA bloqueia e cuja falha NUNCA derruba o hub
 * DB mockado; nenhum banco, nenhuma rede. PINs FICTÍCIOS.
 */
const express = require('express');
const { BoxTypesRepo, needsRecalibration, RECAL_DAYS } = require('../v3/warehouse/weights');
const { createWarehouseRouter } = require('../v3/warehouse/router');

const ADMIN_PIN = '111111';   // fictício: manage_stock
const VIEWER_PIN = '222222';  // fictício: só view_stock

const DAY = 86400000;

describe('needsRecalibration', () => {
  test('nunca calibrado → precisa', () => {
    expect(needsRecalibration(null)).toBe(true);
  });
  test('calibrado há pouco → não precisa; 60+ dias → precisa', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    expect(needsRecalibration(new Date(now.getTime() - 10 * DAY).toISOString(), now)).toBe(false);
    expect(needsRecalibration(new Date(now.getTime() - (RECAL_DAYS + 1) * DAY).toISOString(), now)).toBe(true);
  });
});

// ── mock do banco: emula v3.box_types em memória ───────────────
function makeDb(state) {
  const shapeFull = (t) => ({ ...t });
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/FROM v3\.app_logins l/.test(q)) {
        const map = {
          [ADMIN_PIN]: { id: 1, name: 'Henrique', role: 'manager', rank: 50, functions: ['view_stock', 'manage_stock'] },
          [VIEWER_PIN]: { id: 2, name: 'Visitante', role: 'viewer', rank: 20, functions: ['view_stock'] },
        };
        const l = map[params[0]];
        return { rows: l ? [l] : [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[1], target: params[2] }); return { rows: [] }; }
      if (q.startsWith('INSERT INTO v3.box_types')) {
        const [name, l, w, h] = params;
        let t = state.types.find((x) => x.name === name);
        if (t) {
          if (l != null) t.length_cm = l;
          if (w != null) t.width_cm = w;
          if (h != null) t.height_cm = h;
          t.active = true;
        } else {
          t = { id: state.nextId++, name, length_cm: l, width_cm: w, height_cm: h,
            tare_g: null, tare_samples: 0, tare_min_g: null, tare_max_g: null,
            last_calibrated_at: null, active: true };
          state.types.push(t);
        }
        return { rows: [shapeFull(t)] };
      }
      if (q.startsWith('UPDATE v3.box_types SET tare_g')) {
        const t = state.types.find((x) => x.id === params[0]);
        if (!t) return { rows: [] };
        t.tare_g = params[1]; t.tare_samples = params[2];
        t.tare_min_g = params[3]; t.tare_max_g = params[4];
        t.last_calibrated_at = new Date().toISOString();
        return { rows: [shapeFull(t)] };
      }
      if (q.startsWith('UPDATE v3.box_types SET name')) {
        const t = state.types.find((x) => x.id === params[0]);
        if (!t) return { rows: [] };
        if (params[1] != null) t.name = params[1];
        if (params[2] != null) t.active = params[2];
        if (params[3] != null) t.length_cm = params[3];
        if (params[4] != null) t.width_cm = params[4];
        if (params[5] != null) t.height_cm = params[5];
        return { rows: [shapeFull(t)] };
      }
      if (/FROM v3\.box_types t LEFT JOIN.*WHERE t\.id = \$1/.test(q)) {
        const t = state.types.find((x) => x.id === params[0]);
        return { rows: t ? [{ ...shapeFull(t), boxes_count: state.boxCounts[t.id] || 0 }] : [] };
      }
      if (/FROM v3\.box_types t LEFT JOIN/.test(q)) {
        return { rows: state.types.map((t) => ({ ...shapeFull(t), boxes_count: state.boxCounts[t.id] || 0 })) };
      }
      if (/FROM v3\.box_types WHERE active/.test(q)) {
        const cut = Date.now() - RECAL_DAYS * DAY;
        return { rows: state.types
          .filter((t) => t.active && (!t.last_calibrated_at || new Date(t.last_calibrated_at).getTime() < cut))
          .map((t) => ({ id: t.id, name: t.name, last_calibrated_at: t.last_calibrated_at })) };
      }
      return { rows: [] };
    },
  };
}

function boot() {
  const state = { queries: [], audit: [], types: [], boxCounts: {}, nextId: 1 };
  return { state, repo: new BoxTypesRepo({ db: makeDb(state) }) };
}

describe('BoxTypesRepo', () => {
  test('create pelo nome, dimensões opcionais; nome vazio é recusado', async () => {
    const { repo } = boot();
    const t = await repo.create({ name: '20x20x20', length_cm: 20, width_cm: 20, height_cm: 20 });
    expect(t).toMatchObject({ name: '20x20x20', length_cm: 20, tare_g: null,
      tare_samples: 0, spread_g: 0, needs_recalibration: true, active: true });
    await expect(repo.create({ name: '' })).rejects.toThrow(/name/);
  });

  test('calibrar com a LISTA de pesos: média, min, max e amostras reais', async () => {
    const { repo } = boot();
    const t = await repo.create({ name: '20x20x20' });
    const out = await repo.calibrate(t.id, { weights_g: [780, 760, 800, 790, 770] });
    expect(out.tare_g).toBe(780);
    expect(out.tare_min_g).toBe(760);
    expect(out.tare_max_g).toBe(800);
    expect(out.tare_samples).toBe(5);
    expect(out.spread_g).toBe(40);
    expect(out.needs_recalibration).toBe(false);    // acabou de calibrar
  });

  test('calibrar com total ÷ contagem: min = max = média (pesou tudo junto)', async () => {
    const { repo } = boot();
    const t = await repo.create({ name: 'BX' });
    const out = await repo.calibrate(t.id, { total_g: 7800, count: 10 });
    expect(out.tare_g).toBe(780);
    expect(out.tare_min_g).toBe(780);
    expect(out.tare_max_g).toBe(780);
    expect(out.tare_samples).toBe(10);
    expect(out.spread_g).toBe(0);
  });

  test('re-calibrar SUBSTITUI a estatística (re-pesagem periódica)', async () => {
    const { repo } = boot();
    const t = await repo.create({ name: 'BX' });
    await repo.calibrate(t.id, { weights_g: [700, 900] });
    const out = await repo.calibrate(t.id, { weights_g: [780, 790] });
    expect(out.tare_g).toBe(785);
    expect(out.tare_min_g).toBe(780);
    expect(out.tare_max_g).toBe(790);
    expect(out.tare_samples).toBe(2);
  });

  test('calibração inválida explode em PT-BR, nada gravado', async () => {
    const { repo, state } = boot();
    const t = await repo.create({ name: 'BX' });
    await expect(repo.calibrate(t.id, {})).rejects.toThrow(/total_g/);
    await expect(repo.calibrate(t.id, { weights_g: [780, 0] })).rejects.toThrow(/weights_g/);
    await expect(repo.calibrate(t.id, { total_g: 100, count: 0 })).rejects.toThrow(/count/);
    await expect(repo.calibrate(999, { total_g: 100, count: 1 })).rejects.toThrow(/não existe/);
    expect(state.types[0].tare_g).toBeNull();
  });

  test('update: nome, ativo e dimensões (dims ou achatado)', async () => {
    const { repo } = boot();
    const t = await repo.create({ name: 'BX' });
    const out = await repo.update(t.id, { name: '20x20x20', dims: { length_cm: 20 }, active: false });
    expect(out).toMatchObject({ name: '20x20x20', length_cm: 20, active: false });
    await expect(repo.update(999, { name: 'x' })).rejects.toThrow(/não existe/);
  });

  test('nenhuma query do repo mexe em qty (tipo de caixa é só metadado físico)', async () => {
    const { repo, state } = boot();
    const t = await repo.create({ name: 'BX' });
    await repo.calibrate(t.id, { weights_g: [780] });
    await repo.update(t.id, { active: true });
    expect(state.queries.filter((x) => /\bqty\b/i.test(x.q))).toEqual([]);
  });
});

// ── rotas ──────────────────────────────────────────────────────
function baseRow(over = {}) {
  return {
    product_id: 10, name: 'Benfotiamine 300 mg', nickname: 'BENF-300', bottle_color: 'black',
    base_sku: 'HF-BENF-300',
    skus: [{ id: 1, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, role: 'base', veeqo_type: null, confirmed: true }],
    shelf_qty: 46, box_qty: 180, unplaced_qty: 0, total: 226,
    reserved: 12, pending_out: 0, pending_in: 0, available: 214, separated: 0,
    min_units: null, days_cover: null, veeqo: null, veeqo_match: 'unknown',
    status: ['ok'], bins: [], boxes: [],
    ...over,
  };
}

let server, base, state;

async function bootServer(opts = {}) {
  if (server) await new Promise((r) => server.close(r));
  state = { queries: [], audit: [], types: opts.types || [], boxCounts: opts.boxCounts || {}, nextId: 50 };
  const db = makeDb(state);
  const { createVeeqoCache } = require('../v3/warehouse/veeqo-cache');
  const veeqoCache = createVeeqoCache({ veeqo: { listSellables: async () => [
    { sku: 'HF-BENF-300', type: 'variant', wh: { physical: 226, allocated: 12, available: 214 } }] } });
  await veeqoCache.warm();
  const stock = {
    overview: async () => [baseRow()],
    productDetail: async () => null,
    storeIn: jest.fn(), place: jest.fn(),
  };
  const app = express();
  app.use('/', createWarehouseRouter({ db, stock,
    requests: { list: async () => [], propose: async () => ({}) },
    veeqoCache, boxTypes: opts.boxTypes }));
  server = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, path, body, pin) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(pin ? { 'x-admin-pin': pin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('rotas /box-types', () => {
  test('criar, calibrar e listar de ponta a ponta, com audit', async () => {
    await bootServer();
    const c = await call('POST', '/api/v3/warehouse/box-types',
      { name: '20x20x20', length_cm: 20, width_cm: 20, height_cm: 20 }, ADMIN_PIN);
    expect(c.status).toBe(200);
    const id = c.body.data.type.id;
    expect(c.body.data.type.needs_recalibration).toBe(true);

    const cal = await call('POST', `/api/v3/warehouse/box-types/${id}/calibrate`,
      { weights_g: [780, 760, 800] }, ADMIN_PIN);
    expect(cal.status).toBe(200);
    expect(cal.body.data.type).toMatchObject({ tare_g: 780, tare_min_g: 760, tare_max_g: 800,
      tare_samples: 3, needs_recalibration: false });
    expect(cal.body.data.spread_g).toBe(40);

    const list = await call('GET', '/api/v3/warehouse/box-types', undefined, VIEWER_PIN);
    expect(list.status).toBe(200);
    expect(list.body.data.types[0]).toMatchObject({ name: '20x20x20', spread_g: 40, boxes_count: 0 });

    expect(state.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['warehouse.box_type_create', 'warehouse.box_type_calibrate']));
  });

  test('update por POST /box-types/:id (nome, dims, active)', async () => {
    await bootServer();
    const c = await call('POST', '/api/v3/warehouse/box-types', { name: 'BX' }, ADMIN_PIN);
    const id = c.body.data.type.id;
    const u = await call('POST', `/api/v3/warehouse/box-types/${id}`,
      { name: '15x15x15', dims: { height_cm: 15 }, active: false }, ADMIN_PIN);
    expect(u.status).toBe(200);
    expect(u.body.data.type).toMatchObject({ name: '15x15x15', height_cm: 15, active: false });
  });

  test('view_stock lê mas não escreve (403); calibração total÷contagem funciona', async () => {
    await bootServer();
    expect((await call('POST', '/api/v3/warehouse/box-types', { name: 'X' }, VIEWER_PIN)).status).toBe(403);
    const c = await call('POST', '/api/v3/warehouse/box-types', { name: 'X' }, ADMIN_PIN);
    const cal = await call('POST', `/api/v3/warehouse/box-types/${c.body.data.type.id}/calibrate`,
      { total_g: 7800, count: 10 }, ADMIN_PIN);
    expect(cal.body.data.type.tare_g).toBe(780);
    expect(cal.body.data.spread_g).toBe(0);
  });

  test('erros viram 400/404 em PT-BR', async () => {
    await bootServer();
    expect((await call('POST', '/api/v3/warehouse/box-types', {}, ADMIN_PIN)).status).toBe(400);
    const missing = await call('POST', '/api/v3/warehouse/box-types/999/calibrate',
      { total_g: 100, count: 1 }, ADMIN_PIN);
    expect(missing.status).toBe(404);
  });
});

describe('aviso de re-pesagem no overview', () => {
  test('tipo com calibração velha entra na atenção como repesar_caixas (nunca bloqueia)', async () => {
    await bootServer({ types: [{ id: 7, name: '20x20x20', length_cm: 20, width_cm: null, height_cm: null,
      tare_g: 780, tare_samples: 10, tare_min_g: 760, tare_max_g: 800,
      last_calibrated_at: new Date(Date.now() - 90 * DAY).toISOString(), active: true }] });
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    const item = r.body.data.attention.find((a) => a.kind === 'repesar_caixas');
    expect(item).toMatchObject({ box_type_id: 7,
      text: 'Precisamos re-pesar as caixas 20x20x20',
      action: { type: 'repesar', box_type_id: 7 } });
  });

  test('falha na consulta dos tipos NUNCA derruba o overview', async () => {
    await bootServer({ boxTypes: { recalibrationWarnings: async () => { throw new Error('boom'); },
      list: async () => [] } });
    const r = await call('GET', '/api/v3/warehouse/overview', undefined, ADMIN_PIN);
    expect(r.status).toBe(200);
    expect(r.body.data.attention.filter((a) => a.kind === 'repesar_caixas')).toEqual([]);
  });
});
