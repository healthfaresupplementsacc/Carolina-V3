'use strict';
const { UnusualSkuWatch } = require('../workers/unusual-sku-watch');

function make(over = {}) {
  const posted = [];
  const marked = [];
  const db = {
    query: async (sql, params) => {
      if (/FROM v3.pnp_order_lines/.test(sql)) return { rows: over.rows || [] };
      if (/action = 'unusual_sku'/.test(sql) && /SELECT 1/.test(sql)) {
        return { rowCount: (over.warned || []).includes(params[0]) ? 1 : 0 };
      }
      if (/INSERT INTO v3.audit_log/.test(sql)) { marked.push(JSON.parse(params[0]).sku); return { rows: [] }; }
      return { rows: [], rowCount: 0 };
    },
  };
  const w = new UnusualSkuWatch({
    enabled: true, db, channelId: 'CADMIN',
    slack: { postAs: async (m) => { posted.push(m); } },
  });
  return { w, posted, marked };
}

describe('unusual-sku-watch', () => {
  test('SKUs sem mapa → 1 msg agrupada no admin, marca dedupe', async () => {
    const { w, posted, marked } = make({ rows: [
      { sku: 'HEAFA-XXX-NAO-MAPEADO', channel: 'Amazon', unmapped: true, fba_wfs: true, lines: 2 },
      { sku: 'XX-NOVO-999', channel: 'Ebay', unmapped: true, fba_wfs: false, lines: 1 },
    ] });
    const r = await w.tick();
    expect(r.warned).toBe(2);
    expect(posted).toHaveLength(1);
    expect(posted[0].channel).toBe('CADMIN');
    expect(posted[0].text).toContain('HEAFA-XXX-NAO-MAPEADO');
    expect(posted[0].text).toContain('XX-NOVO-999');
    expect(posted[0].text).toContain('sem produto mapeado');
    expect(posted[0].text).toMatch(/segue NA picklist/i);   // nunca remove da fila
    expect(marked.sort()).toEqual(['HEAFA-XXX-NAO-MAPEADO', 'XX-NOVO-999']);
  });

  test('já avisado hoje → não repete', async () => {
    const { w, posted } = make({
      rows: [{ sku: 'HEAFA-XXX-NAO-MAPEADO', channel: 'Amazon', unmapped: true, fba_wfs: true, lines: 1 }],
      warned: ['HEAFA-XXX-NAO-MAPEADO'],
    });
    const r = await w.tick();
    expect(r.warned).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test('fila limpa → silêncio', async () => {
    const { w, posted } = make({ rows: [] });
    const r = await w.tick();
    expect(r.warned).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test('disabled → skip', async () => {
    const { w } = make();
    w.enabled = false;
    expect((await w.tick()).skipped).toBe(true);
  });
});
