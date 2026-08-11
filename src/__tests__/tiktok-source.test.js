'use strict';
// TikTok source ENCAPSULADO (Bruno 08-04) — o contrato que permite trocar
// CSV→API sem tocar downstream: parseSellerCenterCsv → shape normalizado →
// ingestLines. CSV de teste = shape REAL do export do Seller Center
// ([[smoke-must-match-real-backend]] — mock com shape de mentira = false-green).
const { mode, parseSellerCenterCsv, ingestLines } = require('../v3/services/tiktok-source');

// header real do export "Order" do Seller Center US (colunas principais)
const CSV = '﻿"Order ID","Order Status","Order Substatus","SKU ID","Seller SKU","Product Name","Variation","Quantity","Created Time"\n'
  + '"576461234567890123","To ship","Awaiting shipment","1729384756","HF-MELA-60","Melatonin Fast Absorption 60mg","Default","2","08/03/2026 9:14:22 AM"\n'
  + '"576461234567890123","To ship","Awaiting shipment","1729384757","HF-VITD-5000","Vitamin D3 5,000 IU | Immune Support","Default","1","08/03/2026 9:14:22 AM"\n'
  + '"576469999999999999","Cancelled","Cancelation completed","1729384756","HF-MELA-60","Melatonin Fast Absorption 60mg","Default","1","08/02/2026 7:01:00 PM"\n'
  + '"576468888888888888","Shipped","In transit","1729380000","HF-BENF-300","Benfotiamine 300mg, with ""quotes""","Default","3","08/01/2026 11:59:00 PM"\n';

describe('tiktok-source — parseSellerCenterCsv', () => {
  test('parseia shape real: BOM, aspas, aspas duplas escapadas, datas AM/PM', () => {
    const { lines } = parseSellerCenterCsv(CSV);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      order_id: '576461234567890123', line_id: 'HF-MELA-60', sku: 'HF-MELA-60',
      qty: 2, status: 'pending', order_date: '2026-08-03',
    });
    expect(lines[1].sku).toBe('HF-VITD-5000');
    expect(lines[2].status).toBe('cancelled');
    expect(lines[3].status).toBe('shipped');
    expect(lines[3].title).toContain('with "quotes"');
  });

  test('mesma ordem + mesmo SKU 2× → line_id ganha sufixo :2 (idempotência não colide)', () => {
    const dup = CSV + '"576461234567890123","To ship","Awaiting shipment","1729384756","HF-MELA-60","Melatonin","Default","1","08/03/2026 9:14:22 AM"\n';
    const { lines } = parseSellerCenterCsv(dup);
    expect(lines[4].line_id).toBe('HF-MELA-60:2');
  });

  test('delimitador tab e ponto-e-vírgula também parseiam', () => {
    const tsv = 'Order ID\tSeller SKU\tQuantity\tOrder Status\nX1\tHF-A\t2\tTo ship\n';
    expect(parseSellerCenterCsv(tsv).lines[0]).toMatchObject({ order_id: 'X1', qty: 2 });
    const semi = 'Order ID;Seller SKU;Quantity;Order Status\nX2;HF-B;1;Shipped\n';
    expect(parseSellerCenterCsv(semi).lines[0]).toMatchObject({ order_id: 'X2', status: 'shipped' });
  });

  test('CSV sem as colunas mínimas → erro claro', () => {
    expect(() => parseSellerCenterCsv('Foo,Bar\n1,2\n')).toThrow(/Order ID/);
  });
});

describe('tiktok-source — ingestLines (funil único CSV/API)', () => {
  const mkDb = () => {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT sku, product_id FROM v3.product_skus/.test(sql)) {
          return { rows: [{ sku: 'HF-MELA-60', product_id: 129 }] };
        }
        return { rows: [] };
      }),
    };
  };

  test('mapeado → product_id; sem mapa → quarentena (error_note); rank de status no upsert', async () => {
    const db = mkDb();
    const { lines } = parseSellerCenterCsv(CSV);
    const out = await ingestLines(db, lines);
    expect(out.imported).toBe(4);
    expect(out.unmapped).toBe(2);              // HF-VITD-5000 + HF-BENF-300 sem mapa
    const inserts = db.calls.filter((c) => /INSERT INTO v3.pnp_order_lines/.test(c.sql));
    expect(inserts).toHaveLength(4);
    const mela = inserts[0].params;
    expect(mela[0]).toBe('576461234567890123'); // external_order_id
    expect(mela[3]).toBe(129);                  // product_id resolvido
    expect(mela[8]).toBeNull();                 // sem error_note
    const vitd = inserts[1].params;
    expect(vitd[3]).toBeNull();
    expect(vitd[8]).toMatch(/sem mapeamento/);
    // source='tiktok' hardcoded no SQL; status nunca regride (CASE com rank)
    expect(inserts[0].sql).toContain(`'tiktok'`);
    expect(inserts[0].sql).toContain('ON CONFLICT (source, external_order_id, external_line_id)');
    expect(inserts[0].sql).toMatch(/status = CASE/);
  });

  test('modo: default csv; TIKTOK_SOURCE=api → api', () => {
    const prev = process.env.TIKTOK_SOURCE;
    delete process.env.TIKTOK_SOURCE;
    expect(mode()).toBe('csv');
    process.env.TIKTOK_SOURCE = 'api';
    expect(mode()).toBe('api');
    if (prev === undefined) delete process.env.TIKTOK_SOURCE; else process.env.TIKTOK_SOURCE = prev;
  });
});
