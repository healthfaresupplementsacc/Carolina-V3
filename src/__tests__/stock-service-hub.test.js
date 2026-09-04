'use strict';
/**
 * StockService — as operações do Warehouse hub (S15 Fase 1, Bruno 08-18):
 *  1. storeIn SEM bin/caixa → bucket "a organizar" (v3.stock_unplaced)
 *  2. place: a organizar → prateleira/caixa, floor no que existe + discrepância
 *  3. move: transferência genérica, total do produto NÃO muda
 *  4. separate: label/seal/other deduz a prateleira; 'return' NÃO deduz nada
 *  5. resolveIssue: restocked devolve pro estoque (idempotente por issue:<id>)
 *  6. pick allow_box: prateleira primeiro, caixa depois
 *  7. overview: total/reservado/pendente/disponível/separadas + regras de status
 * Mini-DB em memória com o shape REAL das tabelas 058/060/071
 * ([[smoke-must-match-real-backend]]) — mesmo padrão do stock-service.test.js.
 */
const { StockService } = require('../v3/services/StockService');

/** Mini-DB em memória: interpreta as queries do StockService (058 + 060 + 071). */
function makeDb() {
  const state = {
    movements: [], bins: new Map(), boxes: new Map(), boxSeq: 100,
    issues: [], audit: [], unplaced: new Map(),
    products: [], skus: [], lines: [], requests: [], thresholds: new Map(),
    nextId: 1, inTx: false,
  };
  const clone = (o) => (o ? { ...o } : o);
  const snap = () => JSON.stringify({
    m: state.movements, i: state.issues, b: [...state.bins], x: [...state.boxes], u: [...state.unplaced],
  });
  const api = {
    state,
    async connect() { return api; },
    release() {},
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      if (q === 'BEGIN') { state.inTx = true; state._snapshot = snap(); return { rows: [] }; }
      if (q === 'COMMIT') { state.inTx = false; state._snapshot = null; return { rows: [] }; }
      if (q === 'ROLLBACK') {
        if (state._snapshot) {
          const s = JSON.parse(state._snapshot);
          state.movements = s.m; state.issues = s.i;
          state.bins = new Map(s.b); state.boxes = new Map(s.x); state.unplaced = new Map(s.u);
        }
        state.inTx = false; return { rows: [] };
      }
      // ── movimentos ──────────────────────────────────────────
      if (q.startsWith('SELECT * FROM v3.stock_movements WHERE source')) {
        const found = state.movements.find((m) => m.source === params[0] && m.source_ref === params[1]);
        return { rows: found ? [clone(found)] : [], rowCount: found ? 1 : 0 };
      }
      if (q.startsWith('INSERT INTO v3.stock_movements')) {
        const [kind, product_id, qty, bin_id, box_id, person_id, source, source_ref] = params;
        if (source_ref && state.movements.some((m) => m.source === source && m.source_ref === source_ref)) {
          return { rows: [], rowCount: 0 };   // ON CONFLICT DO NOTHING
        }
        const row = { id: state.nextId++, kind, product_id, qty, bin_id, box_id, person_id,
          source, source_ref, note: params[9], is_test: params[10] };
        state.movements.push(row);
        return { rows: [clone(row)], rowCount: 1 };
      }
      // ── bins ────────────────────────────────────────────────
      if (/SELECT \* FROM v3\.stock_bins WHERE id = \$1/.test(q)) {
        const b = state.bins.get(params[0]);
        return { rows: b ? [clone(b)] : [] };
      }
      if (/SELECT \* FROM v3\.stock_bins WHERE product_id = \$1/.test(q)) {
        const c = [...state.bins.values()].filter((b) => b.product_id === params[0] && b.active !== false)
          .sort((a, b) => b.qty - a.qty);
        return { rows: c.length ? [clone(c[0])] : [] };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET qty')) {
        const b = state.bins.get(params[0]); if (b) b.qty = params[1]; return { rows: [] };
      }
      if (q.startsWith('UPDATE v3.stock_bins SET product_id')) {
        const b = state.bins.get(params[0]); if (b) b.product_id = params[1]; return { rows: [] };
      }
      // ── caixas ──────────────────────────────────────────────
      if (/SELECT \* FROM v3\.stock_boxes WHERE id = \$1/.test(q)) {
        const b = state.boxes.get(params[0]);
        return { rows: b ? [clone(b)] : [] };
      }
      if (/SELECT \* FROM v3\.stock_boxes WHERE product_id = \$1 AND status = 'in_storage'/.test(q)) {
        const c = [...state.boxes.values()]
          .filter((b) => b.product_id === params[0] && b.status === 'in_storage')
          .sort((a, b) => b.qty - a.qty);
        return { rows: c.length ? [clone(c[0])] : [] };
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET qty')) {
        const b = state.boxes.get(params[0]); if (b) { b.qty = params[1]; b.status = params[2]; }
        return { rows: [] };
      }
      if (q.startsWith('UPDATE v3.stock_boxes SET product_id')) {
        const b = state.boxes.get(params[0]); if (b) b.product_id = params[1]; return { rows: [] };
      }
      // ── a organizar ─────────────────────────────────────────
      if (/SELECT \* FROM v3\.stock_unplaced WHERE product_id = \$1/.test(q)) {
        const u = state.unplaced.get(params[0]);
        return { rows: u == null ? [] : [{ product_id: params[0], qty: u }] };
      }
      if (q.startsWith('INSERT INTO v3.stock_unplaced')) {
        state.unplaced.set(params[0], params[1]); return { rows: [] };
      }
      // ── separadas ───────────────────────────────────────────
      if (q.startsWith('INSERT INTO v3.stock_issues (product_id, qty, reason, bin_id, person_id, note, is_test, order_number)')) {
        const row = { id: state.nextId++, product_id: params[0], qty: params[1], reason: 'return',
          bin_id: params[2], person_id: params[3], note: params[4], is_test: params[5],
          order_number: params[6], status: 'separated' };
        state.issues.push(row); return { rows: [clone(row)] };
      }
      if (q.startsWith('INSERT INTO v3.stock_issues')) {
        const row = { id: state.nextId++, product_id: params[0], qty: params[1], reason: params[2],
          bin_id: params[3], person_id: params[4], note: params[5], is_test: params[6],
          order_number: null, status: 'separated' };
        state.issues.push(row); return { rows: [clone(row)] };
      }
      if (/SELECT \* FROM v3\.stock_issues WHERE id = \$1/.test(q)) {
        const i = state.issues.find((x) => x.id === params[0]);
        return { rows: i ? [clone(i)] : [] };
      }
      if (q.startsWith('UPDATE v3.stock_issues SET status')) {
        const i = state.issues.find((x) => x.id === params[0]);
        if (i) { i.status = params[1]; i.resolved_by_person_id = params[2]; i.note = params[3] || i.note; }
        return { rows: i ? [clone(i)] : [] };
      }
      if (q.startsWith('UPDATE v3.stock_issues SET order_number')) {
        const i = state.issues.find((x) => x.id === params[0]);
        if (i) i.order_number = params[1];
        return { rows: [] };
      }
      if (q.startsWith('INSERT INTO v3.audit_log')) { state.audit.push({ action: params[2] }); return { rows: [] }; }

      // ── OVERVIEW (agregados) ────────────────────────────────
      if (/FROM v3\.products p/.test(q) && /shelf_qty/.test(q)) {
        const only = params[0] || null;
        const sum = (arr, f) => arr.reduce((n, x) => n + (Number(f(x)) || 0), 0);
        return { rows: state.products.filter((p) => !only || p.id === only).map((p) => {
          const bins = [...state.bins.values()].filter((b) => b.product_id === p.id && b.active !== false);
          const boxes = [...state.boxes.values()].filter((b) => b.product_id === p.id && b.status === 'in_storage');
          const openLines = state.lines.filter((l) => l.product_id === p.id
            && !['shipped', 'cancelled'].includes(l.status));
          const reserved = sum(openLines, (l) => {
            const sk = state.skus.find((s) => s.channel === l.source
              && String(s.sku).toUpperCase() === String(l.sku).toUpperCase());
            return l.qty * ((sk && sk.units_per_pack) || 1);
          });
          const pend = (dir) => sum(state.requests.filter((r) => r.product_id === p.id
            && r.status === 'pending' && r.direction === dir), (r) => r.qty);
          const th = state.thresholds.get(p.id) || {};
          // VELOCIDADE (Bruno 08-19): só linhas 'shipped', em GARRAFAS
          // (qty × units_per_pack), dentro da janela de shipped_at. Mesmas regras
          // do LEFT JOIN sv do overview.
          const packOf = (l) => {
            const sk = state.skus.find((s) => s.channel === l.source
              && String(s.sku).toUpperCase() === String(l.sku).toUpperCase());
            return (sk && sk.units_per_pack) || 1;
          };
          const agoDays = (l) => (l.shipped_at == null ? Infinity
            : (Date.now() - new Date(l.shipped_at).getTime()) / 86400000);
          const shipped = state.lines.filter((l) => l.product_id === p.id && l.status === 'shipped');
          const sold = (days) => sum(shipped.filter((l) => agoDays(l) <= days), (l) => l.qty * packOf(l));
          return {
            sold_7d: sold(7), sold_30d: sold(30),
            product_id: p.id, canonical_name: p.canonical_name, nickname: p.nickname,
            bottle_color: p.bottle_color || null,
            shelf_qty: sum(bins, (b) => b.qty), box_qty: sum(boxes, (b) => b.qty),
            unplaced_qty: state.unplaced.get(p.id) || 0,
            reserved,
            separated: sum(state.issues.filter((i) => i.product_id === p.id && i.status === 'separated'), (i) => i.qty),
            pending_out: pend('out'), pending_in: pend('in'),
            min_units: th.min_units == null ? null : th.min_units,
            restock_bins: bins.filter((b) => b.min_qty > 0 && b.qty <= b.min_qty).length,
          };
        }) };
      }
      if (/FROM v3\.stock_bins WHERE active AND product_id IS NOT NULL/.test(q)) {
        return { rows: [...state.bins.values()].filter((b) => b.active !== false && b.product_id)
          .map((b) => clone(b)) };
      }
      if (/FROM v3\.stock_boxes WHERE status = 'in_storage' AND product_id IS NOT NULL/.test(q)) {
        return { rows: [...state.boxes.values()].filter((b) => b.status === 'in_storage' && b.product_id)
          .map((b) => clone(b)) };
      }
      if (/FROM v3\.product_skus ORDER BY/.test(q)) {
        return { rows: state.skus.map((s) => clone(s)) };
      }
      // detail (não exercitado aqui, devolve vazio)
      if (/FROM v3\.pnp_order_lines l/.test(q)) return { rows: [] };
      if (/FROM v3\.stock_movements m/.test(q)) return { rows: [] };
      if (/FROM v3\.stock_issues i/.test(q)) return { rows: [] };
      if (/FROM v3\.stock_change_requests q/.test(q)) return { rows: [] };
      throw new Error('query não mapeada no mock: ' + q.slice(0, 110));
    },
  };
  return api;
}

const svc = (db, onDiscrepancy) => new StockService({ db, onDiscrepancy });

describe('StockService — "A organizar" (bucket 071)', () => {
  test('storeIn sem bin e sem caixa cai no bucket a organizar', async () => {
    const db = makeDb();
    const s = svc(db);
    const r = await s.storeIn({ product_id: 10, qty: 80, person_id: 2, source: 'warehouse_hub' });
    expect(r.applied).toBe(80);
    expect(db.state.unplaced.get(10)).toBe(80);
    const mv = db.state.movements[0];
    expect(mv.kind).toBe('store_in');
    expect(mv.bin_id).toBeFalsy();
    expect(mv.box_id).toBeFalsy();
    expect(mv.note).toMatch(/a organizar/);
  });

  test('place: a organizar → prateleira; total não muda, bucket cai', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: null, qty: 0, min_qty: 0, active: true });
    const s = svc(db);
    await s.storeIn({ product_id: 10, qty: 80, source: 'warehouse_hub' });
    const r = await s.place({ product_id: 10, qty: 48, bin_id: 1, person_id: 2, source: 'warehouse_hub' });
    expect(r.applied).toBe(48);
    expect(db.state.unplaced.get(10)).toBe(32);
    expect(db.state.bins.get(1).qty).toBe(48);
    expect(db.state.bins.get(1).product_id).toBe(10);   // bin vazio adota o produto
    expect(db.state.movements.some((m) => m.kind === 'place')).toBe(true);
  });

  test('place além do que existe: floor no bucket + discrepância (avisa, não trava)', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 0, min_qty: 0, active: true });
    const flags = [];
    const s = svc(db, async (d) => flags.push(d));
    await s.storeIn({ product_id: 10, qty: 5, source: 'warehouse_hub' });
    const r = await s.place({ product_id: 10, qty: 20, bin_id: 1, source: 'warehouse_hub' });
    expect(r.applied).toBe(5);
    expect(db.state.unplaced.get(10)).toBe(0);
    expect(db.state.bins.get(1).qty).toBe(5);
    expect(flags.map((f) => f.kind)).toContain('unplaced_short');
  });

  test('place exige um destino', async () => {
    const s = svc(makeDb());
    await expect(s.place({ product_id: 10, qty: 5, source: 'x' })).rejects.toThrow('bin_id ou box_id');
  });
});

describe('StockService — move', () => {
  test('caixa → bin: total do produto não muda', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 2, min_qty: 10, active: true });
    db.state.boxes.set(5, { id: 5, box_number: 'BOX-045', product_id: 10, qty: 100, status: 'in_storage' });
    const s = svc(db);
    const r = await s.move({ product_id: 10, qty: 40, from: { box_id: 5 }, to: { bin_id: 1 },
      person_id: 2, source: 'warehouse_hub' });
    expect(r.applied).toBe(40);
    expect(db.state.boxes.get(5).qty).toBe(60);
    expect(db.state.bins.get(1).qty).toBe(42);
    expect(db.state.boxes.get(5).qty + db.state.bins.get(1).qty).toBe(102);   // total intacto
    expect(db.state.movements.some((m) => m.kind === 'move')).toBe(true);
  });

  test('bin → bin com origem curta: aplica o que dá + discrepância', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 6, min_qty: 0, active: true });
    db.state.bins.set(2, { id: 2, bin_code: 'A04', product_id: 10, qty: 0, min_qty: 0, active: true });
    const flags = [];
    const s = svc(db, async (d) => flags.push(d));
    const r = await s.move({ qty: 10, from: { bin_id: 1 }, to: { bin_id: 2 }, source: 'warehouse_hub' });
    expect(r.applied).toBe(6);
    expect(db.state.bins.get(1).qty).toBe(0);
    expect(db.state.bins.get(2).qty).toBe(6);
    expect(flags.map((f) => f.kind)).toContain('move_short');
  });

  test('origem e destino iguais rejeitam', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 6, active: true });
    const s = svc(db);
    await expect(s.move({ qty: 1, from: { bin_id: 1 }, to: { bin_id: 1 }, source: 'x' }))
      .rejects.toThrow('iguais');
  });
});

describe('StockService — separate (danificada vs devolução)', () => {
  test('reason label deduz a prateleira e abre a Separada', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 12, active: true });
    const s = svc(db);
    const r = await s.separate({ product_id: 10, qty: 2, reason: 'label', person_id: 3, source: 'warehouse_hub' });
    expect(r.applied).toBe(2);
    expect(db.state.bins.get(1).qty).toBe(10);
    expect(db.state.issues[0].reason).toBe('label');
    expect(db.state.issues[0].status).toBe('separated');
  });

  test('reason return NÃO deduz nada: a garrafa voltou de fora', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 12, active: true });
    const s = svc(db);
    const r = await s.separate({ product_id: 10, qty: 3, reason: 'return', order_number: '12-345',
      person_id: 3, source: 'warehouse_hub' });
    expect(r.applied).toBe(0);
    expect(r.movement).toBeNull();
    expect(db.state.bins.get(1).qty).toBe(12);                 // prateleira intacta
    expect(db.state.movements.length).toBe(0);                 // nenhum movimento
    expect(db.state.issues[0].reason).toBe('return');
    expect(db.state.issues[0].order_number).toBe('12-345');
    expect(db.state.issues[0].status).toBe('separated');
  });
});

describe('StockService — resolveIssue', () => {
  test('restocked devolve as garrafas (bin) e fecha a issue', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 12, active: true });
    const s = svc(db);
    const sep = await s.separate({ product_id: 10, qty: 2, reason: 'seal', source: 'warehouse_hub' });
    expect(db.state.bins.get(1).qty).toBe(10);
    const r = await s.resolveIssue({ issue_id: sep.issue.id, action: 'restocked', bin_id: 1,
      person_id: 4, source: 'warehouse_hub' });
    expect(r.applied).toBe(2);
    expect(db.state.bins.get(1).qty).toBe(12);
    expect(r.issue.status).toBe('restocked');
  });

  test('restocked sem destino cai no bucket a organizar', async () => {
    const db = makeDb();
    const s = svc(db);
    const sep = await s.separate({ product_id: 10, qty: 5, reason: 'return', source: 'warehouse_hub' });
    const r = await s.resolveIssue({ issue_id: sep.issue.id, action: 'restocked', source: 'warehouse_hub' });
    expect(r.applied).toBe(5);
    expect(db.state.unplaced.get(10)).toBe(5);
  });

  test('resolver duas vezes não devolve o estoque de novo', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 12, active: true });
    const s = svc(db);
    const sep = await s.separate({ product_id: 10, qty: 2, reason: 'seal', source: 'warehouse_hub' });
    await s.resolveIssue({ issue_id: sep.issue.id, action: 'restocked', bin_id: 1, source: 'warehouse_hub' });
    const again = await s.resolveIssue({ issue_id: sep.issue.id, action: 'restocked', bin_id: 1, source: 'warehouse_hub' });
    expect(again.duplicate).toBe(true);
    expect(db.state.bins.get(1).qty).toBe(12);                 // não somou de novo
  });

  test('relabeled/discarded só fecham a issue', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 12, active: true });
    const s = svc(db);
    const sep = await s.separate({ product_id: 10, qty: 2, reason: 'label', source: 'warehouse_hub' });
    const r = await s.resolveIssue({ issue_id: sep.issue.id, action: 'discarded', source: 'warehouse_hub' });
    expect(r.applied).toBe(0);
    expect(r.issue.status).toBe('discarded');
    expect(db.state.bins.get(1).qty).toBe(10);                 // segue deduzido
  });

  test('action inválido rejeita', async () => {
    const db = makeDb();
    db.state.issues.push({ id: 9, product_id: 10, qty: 1, status: 'separated' });
    const s = svc(db);
    await expect(s.resolveIssue({ issue_id: 9, action: 'sei_la' })).rejects.toThrow('action inválido');
  });
});

describe('StockService — pick prateleira primeiro, caixa depois', () => {
  test('allow_box: prateleira vazia → deduz a caixa com mais garrafas', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 0, active: true });
    db.state.boxes.set(5, { id: 5, box_number: 'BOX-012', product_id: 10, qty: 110, status: 'in_storage' });
    const s = svc(db);
    const r = await s.pick({ product_id: 10, qty: 4, source: 'veeqo_ship', source_ref: '1:1', allow_box: true });
    expect(r.applied).toBe(4);
    expect(db.state.boxes.get(5).qty).toBe(106);
    expect(db.state.bins.get(1).qty).toBe(0);
    expect(db.state.movements[0].box_id).toBe(5);
  });

  test('sem allow_box a prateleira vazia continua sendo floor 0 + aviso', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 0, active: true });
    db.state.boxes.set(5, { id: 5, box_number: 'BOX-012', product_id: 10, qty: 110, status: 'in_storage' });
    const flags = [];
    const s = svc(db, async (d) => flags.push(d));
    const r = await s.pick({ product_id: 10, qty: 4, source: 'veeqo_ship', source_ref: '2:1' });
    expect(r.applied).toBe(0);
    expect(db.state.boxes.get(5).qty).toBe(110);              // caixa intocada
    expect(flags[0].kind).toBe('insufficient_stock');
  });

  test('prateleira com estoque tem prioridade sobre a caixa', async () => {
    const db = makeDb();
    db.state.bins.set(1, { id: 1, bin_code: 'A03', product_id: 10, qty: 20, active: true });
    db.state.boxes.set(5, { id: 5, box_number: 'BOX-012', product_id: 10, qty: 110, status: 'in_storage' });
    const s = svc(db);
    await s.pick({ product_id: 10, qty: 6, source: 'veeqo_ship', source_ref: '3:1', allow_box: true });
    expect(db.state.bins.get(1).qty).toBe(14);
    expect(db.state.boxes.get(5).qty).toBe(110);
  });
});

describe('StockService — overview (os números do hub)', () => {
  function seed() {
    const db = makeDb();
    db.state.products.push({ id: 10, canonical_name: 'Benfotiamine 300 mg', nickname: 'BENF-300' });
    db.state.bins.set(1, { id: 1, product_id: 10, bin_code: 'A03', shelf_code: 'S2', area: 'A',
      qty: 46, min_qty: 10, active: true });
    db.state.boxes.set(5, { id: 5, product_id: 10, box_number: 'BOX-004', area: 'P1', qty: 180, status: 'in_storage' });
    db.state.skus.push(
      { id: 1, product_id: 10, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, confirmed_at: '2026-08-01' },
      { id: 2, product_id: 10, sku: 'HF-BENF-300-C2', channel: 'veeqo', units_per_pack: 2, confirmed_at: '2026-08-01' });
    db.state.lines.push(
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 8, status: 'pending' },
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300-C2', qty: 2, status: 'picklisted' },
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 50, status: 'shipped' },
      { product_id: null, source: 'veeqo', sku: 'DESCONHECIDO', qty: 99, status: 'pending' });
    return db;
  }

  test('total = prateleira + caixa + a organizar; reservado usa units_per_pack', async () => {
    const db = seed();
    db.state.unplaced.set(10, 20);
    const rows = await svc(db).overview();
    const r = rows[0];
    expect(r.shelf_qty).toBe(46);
    expect(r.box_qty).toBe(180);
    expect(r.unplaced_qty).toBe(20);
    expect(r.total).toBe(246);
    expect(r.reserved).toBe(12);            // 8×1 + 2×2, shipped fora, linha sem produto fora
    expect(r.available).toBe(234);
    expect(r.status).toContain('organizar');
    // contrato B (Modo simples): o local "de casa" de cada tipo sai na Row
    expect(r.home_bin).toEqual({ id: 1, bin_code: 'A03' });
    expect(r.main_box).toEqual({ id: 5, box_number: 'BOX-004' });
  });

  test('pendente sai do disponível mas nunca do total', async () => {
    const db = seed();
    db.state.requests.push(
      { product_id: 10, status: 'pending', direction: 'out', qty: 3 },
      { product_id: 10, status: 'pending', direction: 'in', qty: 50 },
      { product_id: 10, status: 'approved', direction: 'out', qty: 99 });
    const rows = await svc(db).overview();
    const r = rows[0];
    expect(r.total).toBe(226);              // pendências nunca entram no total
    expect(r.pending_out).toBe(3);
    expect(r.pending_in).toBe(50);
    expect(r.available).toBe(226 - 12 - 3);
    expect(r.status).toContain('pendente');
  });

  test('separadas contam à parte e nunca no total', async () => {
    const db = seed();
    db.state.issues.push(
      { id: 1, product_id: 10, qty: 2, status: 'separated' },
      { id: 2, product_id: 10, qty: 9, status: 'discarded' });
    const rows = await svc(db).overview();
    expect(rows[0].separated).toBe(2);
    expect(rows[0].total).toBe(226);
  });

  test('status repor quando o bin está no mínimo; base_sku é o veeqo units=1', async () => {
    const db = seed();
    db.state.bins.get(1).qty = 8;           // mínimo 10
    const rows = await svc(db).overview();
    const r = rows[0];
    expect(r.status).toContain('repor');
    expect(r.bins[0].needs_restock).toBe(true);
    expect(r.base_sku).toBe('HF-BENF-300');
    expect(r.skus.find((s) => s.units_per_pack === 1).role).toBe('base');
    expect(r.skus.find((s) => s.units_per_pack === 2).role).toBe('member');
  });

  test('status low quando disponível <= min_units do threshold', async () => {
    const db = seed();
    db.state.thresholds.set(10, { min_units: 500 });
    const rows = await svc(db).overview();
    expect(rows[0].status).toContain('low');
    expect(rows[0].min_units).toBe(500);
  });

  test('produto sem estoque nenhum: out + sku_nao_mapeado, sem sem_local', async () => {
    const db = makeDb();
    db.state.products.push({ id: 20, canonical_name: 'Collagen', nickname: 'COLL' });
    const rows = await svc(db).overview();
    const r = rows[0];
    expect(r.total).toBe(0);
    expect(r.status).toContain('out');
    expect(r.status).toContain('sku_nao_mapeado');
    expect(r.status).not.toContain('sem_local');   // sem_local só quando HÁ garrafas
  });

  test('garrafas sem local nenhum: sem_local + organizar', async () => {
    const db = makeDb();
    db.state.products.push({ id: 30, canonical_name: 'NAC 600', nickname: 'NAC-600' });
    db.state.skus.push({ id: 9, product_id: 30, sku: 'HF-NAC-600', channel: 'veeqo', units_per_pack: 1, confirmed_at: 'x' });
    db.state.unplaced.set(30, 80);
    const rows = await svc(db).overview();
    const r = rows[0];
    expect(r.total).toBe(80);
    expect(r.status).toContain('sem_local');
    expect(r.status).toContain('organizar');
  });

  test('disponível negativo vira status negative', async () => {
    const db = seed();
    db.state.lines.push({ product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 400, status: 'pending' });
    const rows = await svc(db).overview();
    expect(rows[0].available).toBeLessThan(0);
    expect(rows[0].status).toContain('negative');
  });

  test('produto redondo fica só com ok', async () => {
    const db = seed();
    const rows = await svc(db).overview();
    expect(rows[0].status).toEqual(['ok']);
  });
});

/* ── VELOCIDADE: sold_7d / sold_30d / days_of_stock (Bruno 08-19) ──────────
   O número que responde "isso acaba quando?". Sai só de linha JÁ ENVIADA,
   em garrafas, e vira dias dividindo o disponível pelo ritmo da semana.  */
describe('StockService — overview: velocidade e dias de estoque', () => {
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

  function seedVel() {
    const db = makeDb();
    db.state.products.push({ id: 10, canonical_name: 'Benfotiamine 300 mg', nickname: 'BENF-300' });
    db.state.bins.set(1, { id: 1, product_id: 10, bin_code: 'A03', qty: 140, min_qty: 0, active: true });
    db.state.skus.push(
      { id: 1, product_id: 10, sku: 'HF-BENF-300', channel: 'veeqo', units_per_pack: 1, confirmed_at: 'x' },
      { id: 2, product_id: 10, sku: 'HF-BENF-300-C2', channel: 'veeqo', units_per_pack: 2, confirmed_at: 'x' });
    return db;
  }

  test('conta em GARRAFAS (units_per_pack) e só o que foi enviado', async () => {
    const db = seedVel();
    db.state.lines.push(
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 10, status: 'shipped', shipped_at: daysAgo(2) },
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300-C2', qty: 5, status: 'shipped', shipped_at: daysAgo(3) },
      // pendente não é venda: ainda pode ser cancelado
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 99, status: 'pending' });
    const r = (await svc(db).overview())[0];
    expect(r.sold_7d).toBe(20);        // 10×1 + 5×2
    expect(r.sold_30d).toBe(20);
  });

  test('a janela de 30 dias contém a de 7; o que é mais velho fica fora das duas', async () => {
    const db = seedVel();
    db.state.lines.push(
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 14, status: 'shipped', shipped_at: daysAgo(1) },
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 30, status: 'shipped', shipped_at: daysAgo(20) },
      { product_id: 10, source: 'veeqo', sku: 'HF-BENF-300', qty: 500, status: 'shipped', shipped_at: daysAgo(60) });
    const r = (await svc(db).overview())[0];
    expect(r.sold_7d).toBe(14);
    expect(r.sold_30d).toBe(44);
  });

  test('days_of_stock = disponível ÷ (sold_7d ÷ 7), uma casa decimal', async () => {
    const db = seedVel();
    db.state.lines.push({ product_id: 10, source: 'veeqo', sku: 'HF-BENF-300',
      qty: 14, status: 'shipped', shipped_at: daysAgo(1) });
    const r = (await svc(db).overview())[0];
    expect(r.available).toBe(140);
    expect(r.sold_7d).toBe(14);
    expect(r.days_of_stock).toBe(70);       // 140 ÷ 2 por dia
    expect(r.days_cover).toBe(70);          // nome antigo, mesmo número
  });

  test('arredonda pra uma casa, não devolve dízima na tela', async () => {
    const db = seedVel();
    db.state.bins.get(1).qty = 100;
    db.state.lines.push({ product_id: 10, source: 'veeqo', sku: 'HF-BENF-300',
      qty: 21, status: 'shipped', shipped_at: daysAgo(2) });
    const r = (await svc(db).overview())[0];
    expect(r.sold_7d).toBe(21);
    expect(r.days_of_stock).toBe(33.3);     // 100 ÷ 3 = 33.333...
  });

  test('sem venda na semana days_of_stock é null, NUNCA infinito nem zero', async () => {
    const db = seedVel();
    db.state.lines.push({ product_id: 10, source: 'veeqo', sku: 'HF-BENF-300',
      qty: 30, status: 'shipped', shipped_at: daysAgo(20) });
    const r = (await svc(db).overview())[0];
    expect(r.sold_7d).toBe(0);
    expect(r.sold_30d).toBe(30);
    expect(r.days_of_stock).toBeNull();
    expect(Number.isFinite(r.days_of_stock)).toBe(false);
  });

  test('produto que nunca vendeu: zeros e null, sem quebrar a linha', async () => {
    const db = seedVel();
    const r = (await svc(db).overview())[0];
    expect(r.sold_7d).toBe(0);
    expect(r.sold_30d).toBe(0);
    expect(r.days_of_stock).toBeNull();
  });
});
