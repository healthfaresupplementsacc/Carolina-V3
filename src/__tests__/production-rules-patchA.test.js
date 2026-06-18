'use strict';
/* Patch A — mudanças de regra/UX que NÃO dependem do EMS:
   #3/#6 Embalagem (rename + sem lote), #4 Envio (Walmart/Amazon), #5 machine_downtime nota.
   build-fuse-data + fuse-data gerado + op.js (server). #1 cowork e #2 fim-do-dia
   ficam pra patch seguinte (premissas do spec divergiam do modelo real). */
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const BUILD = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'build-fuse-data.js'), 'utf8');
const FUSE = read('op/fuse-data.js');
const OP = read('routes/op.js');

describe('Patch A — build-fuse-data (fonte)', () => {
  test('#5 machine_downtime entra em NOTE_REQUIRED', () => {
    const m = BUILD.match(/const NOTE_REQUIRED = new Set\(\[([\s\S]*?)\]\)/);
    expect(m[1]).toContain("'machine_downtime'");
  });
  test('#3 NO_PRODUCT_OVERRIDE cobre labeling/packaging/marketplace_prep', () => {
    const m = BUILD.match(/const NO_PRODUCT_OVERRIDE = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    ['labeling', 'packaging', 'marketplace_prep'].forEach((s) => expect(m[1]).toContain("'" + s + "'"));
    expect(BUILD).toContain('NO_PRODUCT_OVERRIDE.has(slug) ? false');
  });
  test('#3/#6 grupo embalagem vira "Embalagem" (sem "/ Ordens")', () => {
    expect(BUILD).toContain("label: 'Embalagem',");
    expect(BUILD).not.toContain('Embalagem / Ordens');
  });
  test('#4 Envio tem Walmart + Amazon e NÃO lista o slug genérico shipping', () => {
    const start = BUILD.indexOf("key: 'envio'");
    const seg = BUILD.slice(start, BUILD.indexOf("key: 'outros'"));
    expect(seg).toContain("'shipping_walmart'");
    expect(seg).toContain("'shipping_amazon'");
    expect(seg).not.toContain("['shipping', 'Envio']"); // genérico saiu do menu
    expect(seg).toContain("'shipping_other'"); // catch-all permanece
  });
});

describe('Patch A — op.js (validação server)', () => {
  test('#5 machine_downtime em NOTE_REQUIRED_SLUGS', () => {
    const m = OP.match(/NOTE_REQUIRED_SLUGS = new Set\(\[([\s\S]*?)\]\)/);
    expect(m[1]).toContain("'machine_downtime'");
  });
});

describe('Patch A — fuse-data.js (gerado)', () => {
  test('#5 machine_downtime note_required true', () => {
    const seg = FUSE.slice(FUSE.indexOf('"slug": "machine_downtime"'), FUSE.indexOf('"slug": "machine_downtime"') + 200);
    expect(seg).toContain('"note_required": true');
  });
  test('#3 packaging/labeling/marketplace_prep sem lote (requires_product false)', () => {
    ['packaging', 'labeling', 'marketplace_prep'].forEach((s) => {
      const i = FUSE.indexOf('"slug": "' + s + '"');
      expect(i).toBeGreaterThan(-1);
      expect(FUSE.slice(i, i + 160)).toContain('"requires_product": false');
    });
  });
  test('#4 envio: walmart/amazon presentes, slug shipping genérico ausente', () => {
    expect(FUSE).toContain('"slug": "shipping_walmart"');
    expect(FUSE).toContain('"slug": "shipping_amazon"');
    expect(FUSE).not.toContain('"slug": "shipping",');
  });
  test('#3/#6 sem "Embalagem / Ordens" no gerado', () => {
    expect(FUSE).not.toContain('Embalagem / Ordens');
  });
});

describe('Patch A — migration 032', () => {
  test('insere shipping_walmart + shipping_amazon (idempotente) + down', () => {
    const up = fs.readFileSync(path.join(__dirname, '..', 'v3', 'schema', 'migrations', '032_shipping_marketplaces.sql'), 'utf8');
    expect(up).toContain("'shipping_walmart'");
    expect(up).toContain("'shipping_amazon'");
    expect(up).toContain('ON CONFLICT (slug) DO NOTHING');
    const down = fs.readFileSync(path.join(__dirname, '..', 'v3', 'schema', 'migrations', '032_shipping_marketplaces.down.sql'), 'utf8');
    expect(down).toContain('DELETE FROM v3.activity_types');
  });
});
