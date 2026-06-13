'use strict';
/* Patch "outros por grupo": garante que cada grupo (exceto o catch-all
   "outros", que já tem special_task) tem um "*_other" no GROUPS de
   build-fuse-data.js e que todos entram em NOTE_REQUIRED. O arquivo roda
   main() ao ser required (conecta no DB), então validamos o SOURCE como texto. */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'build-fuse-data.js'), 'utf8');
const OTHERS = ['production_line_other', 'formulation_other', 'cleaning_other', 'packaging_other', 'shipping_other'];

describe('outros por grupo — config build-fuse-data', () => {
  test('os 5 slugs *_other estão no GROUPS (1 por grupo, exceto "outros")', () => {
    OTHERS.forEach((slug) => {
      expect(SRC).toContain(`'${slug}'`);
    });
  });
  test('cada *_other aparece na linha do seu grupo esperado', () => {
    const groupOf = {
      production_line_other: "key: 'linha'",
      formulation_other: "key: 'formulacao'",
      cleaning_other: "key: 'limpeza'",
      packaging_other: "key: 'embalagem'",
      shipping_other: "key: 'envio'",
    };
    // checa que o slug aparece DEPOIS da abertura do seu grupo e ANTES do próximo "key:"
    for (const [slug, marker] of Object.entries(groupOf)) {
      const start = SRC.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const nextKey = SRC.indexOf("key: '", start + marker.length);
      const segment = SRC.slice(start, nextKey === -1 ? undefined : nextKey);
      expect(segment).toContain(`'${slug}'`);
    }
  });
  test('todos os *_other estão em NOTE_REQUIRED', () => {
    const m = SRC.match(/const NOTE_REQUIRED = new Set\(\[([\s\S]*?)\]\)/);
    expect(m).toBeTruthy();
    OTHERS.forEach((slug) => expect(m[1]).toContain(`'${slug}'`));
  });
  test('grupo "outros" NÃO ganhou um *_other (special_task é o catch-all)', () => {
    const start = SRC.indexOf("key: 'outros'");
    // limita ao bloco do grupo (até o fim do array GROUPS / início do QUICK),
    // senão pega o NOTE_REQUIRED lá embaixo que lista os *_other
    const segment = SRC.slice(start, SRC.indexOf('const QUICK'));
    OTHERS.forEach((slug) => expect(segment).not.toContain(`'${slug}'`));
  });
});
