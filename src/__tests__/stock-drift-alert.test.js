'use strict';
/**
 * stock-drift-alert (S15 Fase 3, Bruno 08-18).
 *  1. divergência NOVA avisa uma vez; no tick seguinte NÃO repete (dedupe/produto/dia)
 *  2. dia novo → avisa de novo (o dedupe é por dia NY, não pra sempre)
 *  3. 08:00 NY manda o resumo, 1× por dia; antes das 8h não manda
 *  4. NUNCA escreve estoque: só lê o drift e posta
 *  5. estilo: sem em dash, no máximo 1 emoji
 * DB e Slack mockados; relógio injetado.
 */
const { StockDriftAlert } = require('../workers/stock-drift-alert');

function makeDb(state) {
  return {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ q, params });
      if (/action = 'stock_drift_alert'/.test(q) && q.startsWith('SELECT')) {
        const hit = state.marks.some((m) => m.action === 'stock_drift_alert'
          && String(m.product_id) === params[0] && m.ny_date === params[1]);
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      if (/action = 'stock_drift_digest'/.test(q) && q.startsWith('SELECT')) {
        const hit = state.marks.some((m) => m.action === 'stock_drift_digest' && m.ny_date === params[0]);
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      if (/INSERT INTO v3\.audit_log/.test(q)) {
        const meta = JSON.parse(params[params.length - 1]);
        state.marks.push({ action: /stock_drift_digest/.test(q) ? 'stock_drift_digest' : 'stock_drift_alert', ...meta });
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const DRIFT = [
  { product_id: 10, nickname: 'BENF-300', name: 'Benfotiamine 300 mg', ours: 226, veeqo: 214, delta: -12 },
  { product_id: 11, nickname: 'MAG-CIT', name: 'Magnesium Citrate', ours: 40, veeqo: 55, delta: 15 },
];

/** Relógio fixo em NY: dia + hora escolhidos. */
function atNy(dateStr, hour) {
  // meio-dia UTC do dia pedido, ajustado pra bater a hora NY (UTC-4 no verão)
  return () => new Date(Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10)),
    hour + 4, 30, 0));
}

/** avisos de divergência (o resumo das 8h é outra mensagem, contada à parte) */
const alerts = (state) => state.posts.filter((p) => p.text.includes('Estoque divergente'));
const digests = (state) => state.posts.filter((p) => p.text.includes('Resumo do estoque'));

function boot({ drift = DRIFT, date = '2026-08-18', hour = 10 } = {}) {
  const state = { queries: [], marks: [], posts: [] };
  const worker = new StockDriftAlert({
    db: makeDb(state),
    getDrift: jest.fn(async () => drift),
    slack: { postAs: jest.fn(async (m) => { state.posts.push(m); }) },
    channelId: 'C_ADMIN',
    enabled: true,
    now: atNy(date, hour),
  });
  return { state, worker };
}

describe('divergência nova', () => {
  test('avisa uma vez, com produto, os dois números e a diferença', async () => {
    const { state, worker } = boot({ hour: 6 });          // antes das 8h: só o aviso
    const out = await worker.tick();
    expect(out.alerted).toBe(2);
    expect(alerts(state).length).toBe(1);
    const post = alerts(state)[0];
    expect(post.channel).toBe('C_ADMIN');
    expect(post.text).toContain('BENF-300: Veeqo 214, aqui 226, diferença de -12');
    expect(post.text).toContain('MAG-CIT: Veeqo 55, aqui 40, diferença de +15');
    expect(post.text).toContain('Nada foi alterado.');
  });

  test('no tick seguinte NÃO repete (dedupe 1x por produto por dia)', async () => {
    const { state, worker } = boot();
    await worker.tick();
    const out = await worker.tick();
    expect(out.alerted).toBe(0);
    expect(alerts(state).length).toBe(1);
  });

  test('produto NOVO divergindo no mesmo dia avisa sozinho', async () => {
    const { state, worker } = boot({ drift: [DRIFT[0]] });
    await worker.tick();
    worker.getDrift = async () => DRIFT;                 // o 11 apareceu depois
    const out = await worker.tick();
    expect(out.alerted).toBe(1);
    expect(alerts(state).length).toBe(2);
    expect(alerts(state)[1].text).toContain('MAG-CIT');
    expect(alerts(state)[1].text).not.toContain('BENF-300');
  });

  test('dia novo em NY → avisa de novo (o dedupe é por dia, não pra sempre)', async () => {
    const { state, worker } = boot();
    await worker.tick();
    worker.now = atNy('2026-08-19', 10);
    const out = await worker.tick();
    expect(out.alerted).toBe(2);
    expect(alerts(state).length).toBe(2);
  });

  test('sem divergência → nenhum aviso de divergência', async () => {
    const { state, worker } = boot({ drift: [], hour: 6 });
    const out = await worker.tick();
    expect(out.alerted).toBe(0);
    expect(state.posts.length).toBe(0);
  });

  test('lista longa é cortada com "e mais N" (não vira parede de texto)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ product_id: 100 + i,
      nickname: 'P' + i, ours: 10, veeqo: 11, delta: 1 }));
    const { state, worker } = boot({ drift: many, hour: 6 });
    await worker.tick();
    const text = alerts(state)[0].text;
    expect(text).toContain('e mais 8');
    expect(text.split('\n').length).toBeLessThan(20);
  });
});

describe('resumo das 8h NY', () => {
  test('às 10h manda o resumo (>= 8h) uma vez só', async () => {
    const { state, worker } = boot();
    const out = await worker.tick();
    expect(out.digest).toBe(2);
    expect(digests(state)[0].text).toContain('2 produtos divergindo');

    const again = await worker.tick();
    expect(again.digest).toBe(0);
    expect(digests(state).length).toBe(1);
  });

  test('antes das 8h NY não manda resumo (mas avisa divergência nova)', async () => {
    const { state, worker } = boot({ hour: 6 });
    const out = await worker.tick();
    expect(out.digest).toBe(0);
    expect(state.posts.some((p) => p.text.includes('Resumo do estoque'))).toBe(false);
    expect(out.alerted).toBe(2);
  });

  test('tudo batendo: o resumo diz isso, sem lista', async () => {
    const { state, worker } = boot({ drift: [] });
    await worker.tick();
    expect(state.posts[0].text).toContain('Tudo batendo hoje.');
  });

  test('resumo do dia seguinte sai de novo', async () => {
    const { state, worker } = boot({ drift: [] });
    await worker.tick();
    worker.now = atNy('2026-08-19', 9);
    await worker.tick();
    expect(state.posts.length).toBe(2);
  });
});

describe('garantias', () => {
  test('desligado (opt-in) não faz nada', async () => {
    const { state, worker } = boot();
    worker.enabled = false;
    expect(await worker.tick()).toEqual({ skipped: true });
    expect(state.posts.length).toBe(0);
    expect(worker.getDrift).not.toHaveBeenCalled();
  });

  test('NUNCA escreve estoque: nenhuma query toca movimento, bin ou caixa', async () => {
    const { state, worker } = boot();
    await worker.tick();
    const writes = state.queries.filter((x) =>
      /stock_movements|stock_bins|stock_boxes|stock_unplaced/i.test(x.q));
    expect(writes).toEqual([]);
  });

  test('estilo: sem em dash e no máximo 1 emoji por mensagem', async () => {
    const { state, worker } = boot();
    await worker.tick();
    for (const p of state.posts) {
      expect(p.text).not.toMatch(/—/);
      expect((p.text.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
    }
  });

  test('Slack fora do ar não derruba o tick (dedupe segue marcado)', async () => {
    const { state, worker } = boot();
    worker.slack = { postAs: async () => { throw new Error('slack down'); } };
    const out = await worker.tick();
    expect(out.alerted).toBe(2);
    expect(state.marks.length).toBeGreaterThan(0);
  });

  test('start/stop não deixam timer pendurado', () => {
    const { worker } = boot();
    worker.start(1000);
    expect(worker._t).not.toBeNull();
    worker.stop();
    expect(worker._t).toBeNull();
    expect(worker._kick).toBeNull();
  });
});
