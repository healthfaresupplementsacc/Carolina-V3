'use strict';
/**
 * B6 / C8 — universal audit-coverage guard (BLOCO B lock).
 *
 * (a) Every admin WRITE endpoint (POST/PUT/DELETE '/admin/...') in
 *     routes/api.js + routes/workflow.js MUST call auditAction(). Same
 *     scan logic as the L1 guard, re-asserted over the current code so
 *     that ANY new admin endpoint that forgets the audit row fails the
 *     build — including everything added by BLOCO B (C1–C7).
 *
 * (b) The Config-Carolina write endpoints must additionally be audited
 *     with their SPECIFIC action key, so the audit row can never be
 *     silently dropped or renamed during a future refactor.
 *
 * Allow-list = admin writes that legitimately mutate nothing of their
 * own (audit happens in a delegate, or it is a pure re-parse).
 */
const fs = require('fs');
const path = require('path');

const FILES = ['routes/api.js', 'routes/workflow.js'].map(
  (f) => path.join(__dirname, '..', f)
);

const ALLOW = [
  "post('/admin/rescan-summary'", // re-parse only
  "post('/admin/migrate-legacy'", // audited inside the migrator
  "post('/admin/task/merge'",     // audited inside mergeTasks()
  // FASE 1 P10 — audited inside adminChat.resolveBySourceId()
  // (action 'operator.reassign_retroactive'), same delegate pattern.
  "post('/admin/dispatcher/reassign-operator'",
];

function endpoints(src) {
  const re = /router\.(post|put|delete)\(\s*'(\/admin\/[^']+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push({ method: m[1], path: m[2], index: m.index });
  return out;
}

function handlerBlock(src, index) {
  const rest = src.slice(index + 1);
  const nextIdx = rest.search(/router\.(post|put|delete|get)\(/);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

describe('B6/C8 — universal audit-coverage guard', () => {
  describe('(a) every admin write endpoint funnels through auditAction()', () => {
    let total = 0;
    for (const file of FILES) {
      const src = fs.readFileSync(file, 'utf8');
      for (const ep of endpoints(src)) {
        const sig = `${ep.method}('${ep.path}'`;
        if (ALLOW.some((a) => sig.includes(a))) continue;
        total++;
        test(`${ep.method.toUpperCase()} ${ep.path} → auditAction()`, () => {
          expect(handlerBlock(src, ep.index)).toMatch(/auditAction\s*\(/);
        });
      }
    }
    test('guard actually scanned a meaningful number of endpoints', () => {
      expect(total).toBeGreaterThanOrEqual(20);
    });
  });

  describe('(b) BLOCO B Config-Carolina writes keep their specific action key', () => {
    const apiSrc = fs.readFileSync(FILES[0], 'utf8');
    const eps = endpoints(apiSrc);
    const EXPECTED = [
      { method: 'post',   path: '/admin/carolina-config/app-name',       action: 'carolina_config.app_name' },
      { method: 'post',   path: '/admin/carolina-config/toggle',         action: 'carolina_config.toggle' },
      { method: 'post',   path: '/admin/carolina-config/schedule',       action: 'carolina_config.schedule' },
      { method: 'post',   path: '/admin/carolina-config/persona',        action: 'carolina_config.persona' },
      { method: 'post',   path: '/admin/carolina-config/variations',     action: 'carolina_config.variation_create' },
      { method: 'put',    path: '/admin/carolina-config/variations/:id', action: 'carolina_config.variation_edit' },
      { method: 'delete', path: '/admin/carolina-config/variations/:id', action: 'carolina_config.variation_delete' },
    ];
    for (const { method, path: epath, action } of EXPECTED) {
      test(`${method.toUpperCase()} ${epath} audited as '${action}'`, () => {
        const ep = eps.find((e) => e.method === method && e.path === epath);
        expect(ep).toBeDefined();
        const block = handlerBlock(apiSrc, ep.index);
        expect(block).toMatch(/auditAction\s*\(/);
        expect(block).toMatch(new RegExp(`action:\\s*'${action.replace('.', '\\.')}'`));
      });
    }
  });
});
