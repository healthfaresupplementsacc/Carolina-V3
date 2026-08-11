'use strict';
const { VeeqoDupShipmentDetector } = require('../workers/veeqo-dup-shipment-detector');

const DAY = '2026-08-03';
const shipISO = DAY + 'T17:30:00Z';   // NY afternoon same day

// order w/ recipient + tracking; shipped same day by default
const O = (num, first, last, trk, opts = {}) => ({
  id: num, number: num,
  channel: { name: opts.channel || 'Ebay' },
  shipped_at: opts.shipped || shipISO,
  merged_to_id: opts.merged ? 999 : null,
  allocations: [{ shipment: { tracking_number: { tracking_number: trk } } }],
  deliver_to: {
    first_name: first, last_name: last,
    address1: opts.street || '10 Main St', address2: opts.suite || '',
    city: 'X', state: 'CA', zip: opts.zip || '90001',
  },
});

function makeWorker(orders, over = {}) {
  return new VeeqoDupShipmentDetector({
    enabled: true, startHour: 0, endHour: 24, channelId: 'CADMIN', lookbackDays: 0,
    veeqo: { configured: () => true, getOrdersPage: async ({ page }) => (page === 1 ? orders : []) },
    db: { query: async () => ({ rowCount: 0 }) }, slack: { postAs: async () => {} },
    ...over,
  });
}

describe('veeqo-dup-shipment-detector', () => {
  test('mesmo nome + endereço + dia, 2 trackings distintos → DUPLICATA', async () => {
    const w = makeWorker([
      O('A1', 'Fabian', 'Garcia', 'TRK1'),
      O('A2', 'Fabian', 'Garcia', 'TRK2', { channel: 'Amazon' }),
    ]);
    w._ny = () => ({ hour: 15, date: DAY });
    const dups = await w.computeDuplicates();
    expect(dups.length).toBe(1);
    expect(dups[0].patient).toBe('Fabian Garcia');
    expect(dups[0].tracks.sort()).toEqual(['TRK1', 'TRK2']);
  });

  test('mesma pessoa mas MESMO tracking (mergeado de fato) → NÃO é dup', async () => {
    const w = makeWorker([
      O('A1', 'Fabian', 'Garcia', 'SAME'),
      O('A2', 'Fabian', 'Garcia', 'SAME'),
    ]);
    w._ny = () => ({ hour: 15, date: DAY });
    expect((await w.computeDuplicates()).length).toBe(0);
  });

  test('merged_to_id setado → NÃO é dup mesmo com 2 trackings', async () => {
    const w = makeWorker([
      O('A1', 'Fabian', 'Garcia', 'TRK1', { merged: true }),
      O('A2', 'Fabian', 'Garcia', 'TRK2', { merged: true }),
    ]);
    w._ny = () => ({ hour: 15, date: DAY });
    expect((await w.computeDuplicates()).length).toBe(0);
  });

  test('SEGURANÇA: nomes diferentes no mesmo endereço (forwarder) NUNCA viram dup', async () => {
    const w = makeWorker([
      O('F1', 'Edgar', 'Torres', 'T1', { street: '4221 W 91st Pl', suite: 'STE 900-A', zip: '33018' }),
      O('F2', 'Axel', 'Florew', 'T2', { street: '4221 W 91st Pl', suite: 'STE 900-G', zip: '33018' }),
    ]);
    w._ny = () => ({ hour: 15, date: DAY });
    expect((await w.computeDuplicates()).length).toBe(0);
  });

  test('SEGURANÇA: mesmo nome num forwarder só é dup se a SUITE bater', async () => {
    // rua vira forwarder por causa do "Other Guy"; Fabian em suites diferentes → não é dup
    const diff = makeWorker([
      O('X', 'Other', 'Guy', 'TX', { street: '4221 W 91st Pl', suite: 'STE 1', zip: '33018' }),
      O('A1', 'Fabian', 'Garcia', 'T1', { street: '4221 W 91st Pl', suite: 'STE 5', zip: '33018' }),
      O('A2', 'Fabian', 'Garcia', 'T2', { street: '4221 W 91st Pl', suite: 'STE 9', zip: '33018' }),
    ]);
    diff._ny = () => ({ hour: 15, date: DAY });
    expect((await diff.computeDuplicates()).length).toBe(0);

    const same = makeWorker([
      O('X', 'Other', 'Guy', 'TX', { street: '4221 W 91st Pl', suite: 'STE 1', zip: '33018' }),
      O('A1', 'Fabian', 'Garcia', 'T1', { street: '4221 W 91st Pl', suite: 'STE 5', zip: '33018' }),
      O('A2', 'Fabian', 'Garcia', 'T2', { street: '4221 W 91st Pl', suite: 'STE 5', zip: '33018' }),
    ]);
    same._ny = () => ({ hour: 15, date: DAY });
    const d = await same.computeDuplicates();
    expect(d.length).toBe(1);
    expect(d[0].forwarder).toBe(true);
  });

  test('mesma pessoa em DIAS diferentes → NÃO é dup (não dava pra mergear)', async () => {
    const w = makeWorker([
      O('A1', 'Fabian', 'Garcia', 'T1', { shipped: '2026-08-03T17:30:00Z' }),
      O('A2', 'Fabian', 'Garcia', 'T2', { shipped: '2026-08-01T17:30:00Z' }),
    ]);
    w._ny = () => ({ hour: 15, date: DAY });        // lookbackDays:0 → só hoje entra na janela
    expect((await w.computeDuplicates()).length).toBe(0);
  });

  test('fora da janela → não posta; disabled → skip', async () => {
    const w = makeWorker([], { startHour: 13, endHour: 20 });
    w._ny = () => ({ hour: 6, date: DAY });
    expect((await w.tick()).skipped).toBe('off_window');
    const w2 = makeWorker([], { enabled: false });
    expect((await w2.tick()).skipped).toBe(true);
  });
});
