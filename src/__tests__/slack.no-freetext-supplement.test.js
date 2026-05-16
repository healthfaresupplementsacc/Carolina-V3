'use strict';
/**
 * F7 — there must be NO free-text supplement input anywhere in the App
 * Home. Supplements are only ever chosen via supplementSelectBlock
 * (external_select autocomplete, Bug B). This is a source-level guard
 * so a future modal change can't silently reintroduce a typed field.
 */
const fs = require('fs');
const path = require('path');

const interactiveSrc = fs.readFileSync(
  path.join(__dirname, '..', 'slack', 'interactive.js'), 'utf8'
);

describe('F7 — no free-text supplement input', () => {
  test('only supplementSelectBlock produces the product/supp fields', () => {
    // both supplement-bearing blocks use the autocomplete helper
    expect(interactiveSrc).toMatch(/supplementSelectBlock\('product'/);
    expect(interactiveSrc).toMatch(/supplementSelectBlock\('supp'/);
  });

  test("no plain_text_input is wired to a supplement/produto block_id", () => {
    // crude but effective: there must be no block_id 'product'/'supp'
    // line that also declares a plain_text_input on the same logical block
    const offenders = [];
    const lines = interactiveSrc.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/block_id:\s*'(product|supp|suplemento|supplement)'/.test(lines[i])) {
        const windowText = lines.slice(i, i + 4).join(' ');
        if (/plain_text_input/.test(windowText)) offenders.push(lines[i].trim());
      }
    }
    expect(offenders).toEqual([]);
  });

  test('supplementSelectBlock is an external_select with autocomplete', () => {
    expect(interactiveSrc).toMatch(/type:\s*'external_select'/);
    expect(interactiveSrc).toMatch(/action_id:\s*'supplement_select'/);
    expect(interactiveSrc).toMatch(/min_query_length:\s*0/);
  });
});
