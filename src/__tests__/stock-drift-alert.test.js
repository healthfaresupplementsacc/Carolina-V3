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
      if (/action = 'pnp_typed_drift'/.test(q) && q.startsWith('SELECT')) {
        const hit = state.marks.some((m) => m.action === 'pnp_typed_drift' && m.ny_date === params[0]);
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      if (/action = 'deduct_shortfall'/.test(q) && q.startsWith('SELECT')) {
        return { rows: [state.shortfalls || { lines: 0, missing: 0 }], rowCount: 1 };
      }
      if (/FROM v3\.stock_bins WHERE active/.test(q) && /SUM/.test(q)) {
        // total físico do armazém (modo quieto): número injetável pelo teste
        return { rows: [{ total: state.warehouseTotal != null ? state.warehouseTotal : 100 }] };
      }
      if (/orders_printed/.test(q)) {
        return { rows: [{ total: state.typed != null ? state.typed : 0 }] };
      }
      if (/FROM v3\.shipment_costs/.test(q)) {
        return { rows: [{ n: state.shippedCosts != null ? state.shippedCosts : 0 }] };
      }
      if (/FROM v3\.pnp_order_lines/.test(q)) {
        return { rows: [{ n: state.shippedLines != null ? state.shippedLines : 0 }] };
      }
      if (/INSERT INTO v3\.audit_log/.test(q)) {
        const meta = JSON.parse(params[params.length - 1]);
        const action = /pnp_typed_drift/.test(q) ? 'pnp_typed_drift'
          : (/stock_drift_digest/.test(q) ? 'stock_drift_digest' : 'stock_drift_alert');
        state.marks.push({ action, ...meta });
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

function boot({ drift = DRIFT, date = '2026-08-18', hour = 10,
  warehouseTotal = 100, shortfalls = null, typed = 0, shippedCosts = 0, shippedLines = 0 } = {}) {
  const state = { queries: [], marks: [], posts: [],
    warehouseTotal, shortfalls, typed, shippedCosts, shippedLines };
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

  test('NUNCA escreve estoque: nenhum INSERT/UPDATE/DELETE toca movimento, bin ou caixa', async () => {
    const { state, worker } = boot();
    await worker.tick();
    // o worker LÊ o total do armazém (modo quieto) mas nunca escreve quantidade
    const writes = state.queries.filter((x) =>
      /^(INSERT|UPDATE|DELETE)/i.test(x.q)
      && /stock_movements|stock_bins|stock_boxes|stock_unplaced/i.test(x.q));
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

describe('modo quieto (armazem fisico todo zerado, Fase 0)', () => {
  test('armazem 0: NENHUM aviso por produto, resumo vira 1 linha, 1x por dia', async () => {
    const { state, worker } = boot({ warehouseTotal: 0 });
    const out = await worker.tick();
    expect(out.quiet).toBe(true);
    expect(out.alerted).toBe(0);
    expect(alerts(state).length).toBe(0);
    const quietPosts = state.posts.filter((p) => p.text.includes('Estoque fisico ainda nao carregado'));
    expect(quietPosts.length).toBe(1);
    expect(quietPosts[0].text).toContain('(2 produtos difeririam hoje)');
    expect(quietPosts[0].text).toContain('Volta sozinha quando a carga comecar.');
    expect(quietPosts[0].channel).toBe('C_ADMIN');
    // segundo tick: nada repete
    await worker.tick();
    expect(state.posts.length).toBe(1);
  });

  test('armazem 0 antes da hora do resumo: silencio total', async () => {
    const { state, worker } = boot({ warehouseTotal: 0, hour: 6 });
    const out = await worker.tick();
    expect(out.alerted).toBe(0);
    expect(state.posts.length).toBe(0);
  });

  test('a primeira garrafa carregada devolve os avisos NO MESMO tick (sem flag)', async () => {
    const { state, worker } = boot({ warehouseTotal: 0, hour: 6 });
    await worker.tick();
    expect(state.posts.length).toBe(0);
    state.warehouseTotal = 5;                 // o mutirao comecou
    const out = await worker.tick();
    expect(out.quiet).toBe(false);
    expect(out.alerted).toBe(2);              // dedupe nunca foi marcado no silencio
    expect(alerts(state).length).toBe(1);
  });

  test('falha na query do total = fail-open (comporta como carregado, alerta normal)', async () => {
    const { state, worker } = boot({ warehouseTotal: null, hour: 6 });
    // warehouseTotal null -> mock devolve rows[{total:null}] -> worker trata como carregado
    const out = await worker.tick();
    expect(out.quiet).toBe(false);
    expect(out.alerted).toBe(2);
  });

  test('estilo da 1 linha: sem em dash, no maximo 1 emoji', async () => {
    const { state, worker } = boot({ warehouseTotal: 0 });
    await worker.tick();
    for (const p of state.posts) {
      expect(p.text).not.toMatch(/\u2014/);
      expect((p.text.match(/:[a-z_]+:/g) || []).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('furos de deducao no resumo (audit_log deduct_shortfall)', () => {
  test('houve furo: o resumo ganha 1 linha com linhas e garrafas faltando', async () => {
    const { state, worker } = boot({ shortfalls: { lines: 3, missing: 41 } });
    await worker.tick();
    const digest = digests(state)[0];
    expect(digest.text).toContain('Deducao incompleta em 3 linhas hoje, faltaram 41 garrafas.');
  });

  test('sem furo: nenhuma linha extra', async () => {
    const { state, worker } = boot();
    await worker.tick();
    expect(digests(state)[0].text).not.toContain('Deducao incompleta');
  });

  test('modo quieto tambem carrega o furo (nunca silencioso)', async () => {
    const { state, worker } = boot({ warehouseTotal: 0, shortfalls: { lines: 1, missing: 4 } });
    await worker.tick();
    const quiet = state.posts.find((p) => p.text.includes('Estoque fisico ainda nao carregado'));
    expect(quiet.text).toContain('Deducao incompleta em 1 linha hoje, faltaram 4 garrafas.');
  });
});

describe('comparador P&P digitado vs enviado (17h NY)', () => {
  test('fora da tolerancia: 1 linha no admin-orin com os numeros do dia real 09-03', async () => {
    const { state, worker } = boot({ hour: 17, typed: 130, shippedCosts: 219 });
    const out = await worker.tick();
    expect(out.pnp).toEqual({ typed: 130, shipped: 219, delta: -89, posted: true });
    const post = state.posts.find((p) => p.text.startsWith('P&P do dia'));
    expect(post.text).toBe('P&P do dia: digitado 130, enviado na Veeqo 219, diferenca de 89. Vale conferir os registros de impressao.');
    expect(post.channel).toBe('C_ADMIN');
  });

  test('dentro da tolerancia max(10, 15%): nada e postado, mas o dia fica marcado', async () => {
    const { state, worker } = boot({ hour: 17, typed: 210, shippedCosts: 219 });
    const out = await worker.tick();
    expect(out.pnp.posted).toBe(false);
    expect(state.posts.some((p) => p.text.startsWith('P&P do dia'))).toBe(false);
    expect(state.marks.some((m) => m.action === 'pnp_typed_drift')).toBe(true);
  });

  test('dedupe 1x por dia: segundo tick nao recompara nem reposta', async () => {
    const { state, worker } = boot({ hour: 17, typed: 130, shippedCosts: 219 });
    await worker.tick();
    const out = await worker.tick();
    expect(out.pnp).toBeUndefined();
    expect(state.posts.filter((p) => p.text.startsWith('P&P do dia')).length).toBe(1);
  });

  test('antes das 17h NY nao roda', async () => {
    const { state, worker } = boot({ hour: 16, typed: 130, shippedCosts: 219 });
    const out = await worker.tick();
    expect(out.pnp).toBeUndefined();
    expect(state.posts.some((p) => p.text.startsWith('P&P do dia'))).toBe(false);
  });

  test('espelho shipment_costs vazio: cai pro espelho de linhas pnp_order_lines', async () => {
    const { state, worker } = boot({ hour: 17, typed: 130, shippedCosts: 0, shippedLines: 219 });
    const out = await worker.tick();
    expect(out.pnp.shipped).toBe(219);
    expect(out.pnp.posted).toBe(true);
  });

  test('dia sem nada (fds): 0 digitado, 0 enviado, nenhum post', async () => {
    const { state, worker } = boot({ hour: 17, drift: [], typed: 0, shippedCosts: 0 });
    const out = await worker.tick();
    expect(out.pnp.posted).toBe(false);
    expect(state.posts.some((p) => p.text.startsWith('P&P do dia'))).toBe(false);
  });
});
