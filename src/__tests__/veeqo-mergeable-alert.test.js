'use strict';
const { VeeqoMergeableAlert } = require('../workers/veeqo-mergeable-alert');

// helper: order with recipient name + address (+ optional suite/mergeable_id/channel)
const O = (num, first, last, opts = {}) => ({
  id: num, number: num,
  mergeable_id: opts.mid || null,
  channel: { name: opts.channel || 'Ebay' },
  cancel_reason: opts.cancel || null,
  deliver_to: {
    first_name: first, last_name: last,
    address1: opts.street || '10 Main St',
    address2: opts.suite || '',
    city: 'X', state: 'CA', zip: opts.zip || '90001',
  },
});

// Two real same-name customers (should merge) + a freight forwarder with different names (must NOT).
const ORDERS = [
  O('A1', 'Greg', 'H', { mid: 'US90001', street: '10 Main St', zip: '90001' }),
  O('A2', 'Greg', 'H', { mid: 'US90001', street: '10 Main St', zip: '90001', channel: 'Amazon' }), // same person, mixed channel
  // freight forwarder: same street, different people, different suites, SAME ZIP (same mergeable_id!)
  O('F1', 'Edgar', 'Torres', { mid: 'US33018', street: '4221 W 91st Pl', suite: 'STE 900-A', zip: '33018' }),
  O('F2', 'Axel', 'Florew', { mid: 'US33018', street: '4221 W 91st Pl', suite: 'STE 900-G', zip: '33018' }),
  O('S1', 'Solo', 'One', { mid: 'US10000', street: '5 Oak', zip: '10000' }),  // lonely
];

function make(overrides = {}) {
  let posted = null;
  const w = new VeeqoMergeableAlert({
    enabled: true, startHour: 0, endHour: 24, channelId: 'CADMIN',
    veeqo: { configured: () => true, getOrdersPage: async ({ page }) => (page === 1 ? ORDERS : []) },
    db: { query: async () => ({ rowCount: 0, rows: [] }) },
    slack: { postAs: async (m) => { posted = m; } },
    ...overrides,
  });
  return { w, posted: () => posted };
}

describe('veeqo-mergeable-alert', () => {
  test('agrupa SÓ por nome exato; posta Greg (2 pedidos) com pacientes + ordens + lembretes', async () => {
    const { w, posted } = make();
    const r = await w.tick();
    expect(r.posted).toBe(true);
    expect(r.groups).toBe(1);                          // só Greg (mesmo nome). Forwarder NÃO agrupa.
    const p = posted();
    expect(p.channel).toBe('CADMIN');
    expect(p.text).toContain('Greg H');
    expect(p.text).toContain('A1, A2');
    expect(p.text).toContain('canais diferentes');     // Greg = Ebay + Amazon
    expect(p.text).toMatch(/cancelamento PENDENTE no eBay/i);
    expect(p.text).toMatch(/NUNCA.*mergear/i);          // aviso de despachante
  });

  test('SEGURANÇA: nomes diferentes no mesmo endereço (forwarder) NUNCA são agrupados', async () => {
    const { w, posted } = make();
    await w.tick();
    const p = posted();
    // Edgar e Axel dividem rua+ZIP (mesmo mergeable_id US33018) mas são pessoas diferentes.
    expect(p.text).not.toContain('Edgar');
    expect(p.text).not.toContain('Axel');
    expect(p.text).not.toContain('F1');
    expect(p.text).not.toContain('F2');
    expect(p.text).not.toContain('Solo One');          // grupo de 1 não entra
  });

  test('SEGURANÇA: mesmo nome NUM forwarder só junta se a SUITE bater', async () => {
    // Dois "Greg H" na mesma rua-forwarder (2 nomes distintos lá → é forwarder),
    // suites diferentes → NÃO junta; suites iguais → junta.
    const fwdStreet = '4221 W 91st Pl', zip = '33018';
    const base = [
      O('X1', 'Other', 'Guy', { street: fwdStreet, suite: 'STE 1', zip }),   // torna a rua um forwarder
      O('G1', 'Greg', 'H', { street: fwdStreet, suite: 'STE 5', zip }),
      O('G2', 'Greg', 'H', { street: fwdStreet, suite: 'STE 9', zip }),      // suite != → não junta
    ];
    const w1 = new VeeqoMergeableAlert({
      enabled: true, startHour: 0, endHour: 24, channelId: 'C',
      veeqo: { configured: () => true, getOrdersPage: async ({ page }) => (page === 1 ? base : []) },
      db: { query: async () => ({ rowCount: 0 }) }, slack: { postAs: async () => {} },
    });
    expect((await w1.computeGroups()).length).toBe(0);

    const base2 = [
      O('X1', 'Other', 'Guy', { street: fwdStreet, suite: 'STE 1', zip }),
      O('G1', 'Greg', 'H', { street: fwdStreet, suite: 'STE 5', zip }),
      O('G2', 'Greg', 'H', { street: fwdStreet, suite: 'STE 5', zip }),      // suite igual → junta
    ];
    const w2 = new VeeqoMergeableAlert({
      enabled: true, startHour: 0, endHour: 24, channelId: 'C',
      veeqo: { configured: () => true, getOrdersPage: async ({ page }) => (page === 1 ? base2 : []) },
      db: { query: async () => ({ rowCount: 0 }) }, slack: { postAs: async () => {} },
    });
    const g2 = await w2.computeGroups();
    expect(g2.length).toBe(1);
    expect(g2[0].forwarder).toBe(true);
    expect(g2[0].orders.sort()).toEqual(['G1', 'G2']);
  });

  test('fora da janela da manhã → não posta', async () => {
    const { w, posted } = make({ startHour: 7, endHour: 8 });
    w._ny = () => ({ hour: 15, date: '2026-08-02' });
    const r = await w.tick();
    expect(r.skipped).toBe('off_window');
    expect(posted()).toBeNull();
  });

  test('já alertou hoje → não posta de novo', async () => {
    const { w, posted } = make({
      db: { query: async (sql) => (/action = 'mergeable_alert'/.test(sql) ? { rowCount: 1 } : { rowCount: 0, rows: [] }) },
    });
    const r = await w.tick();
    expect(r.skipped).toBe('already_today');
    expect(posted()).toBeNull();
  });

  test('sem grupos de mesmo nome → não posta', async () => {
    const { w, posted } = make({
      veeqo: { configured: () => true, getOrdersPage: async ({ page }) => (page === 1 ? [O('Z1', 'Only', 'One')] : []) },
    });
    const r = await w.tick();
    expect(r.groups).toBe(0);
    expect(posted()).toBeNull();
  });

  test('disabled → skip', async () => {
    const { w } = make({ enabled: false });
    expect((await w.tick()).skipped).toBe(true);
  });
});
