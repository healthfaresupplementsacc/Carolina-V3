'use strict';
/**
 * L1 — every admin WRITE endpoint must funnel through auditAction().
 * Source-level guard: scans api.js + workflow.js, finds each
 * router.post/put/delete('/admin/...') block and asserts an
 * auditAction( call exists before the next route definition.
 *
 * Read-only endpoints (GET) and pure list/non-mutating POSTs are
 * allow-listed.
 */
const fs = require('fs');
const path = require('path');

const FILES = ['routes/api.js', 'routes/workflow.js'].map(
  (f) => path.join(__dirname, '..', f)
);

// Admin write endpoints that legitimately don't mutate domain state
// (so no audit row is expected).
const ALLOW = [
  "post('/admin/rescan-summary'",   // re-parse only; writes app_state, audited inside
  "post('/admin/migrate-legacy'",   // audited (verified) — keep in case path changes
  // delegates to mergeTasks() in src/admin/merge.js which calls
  // auditAction({action:'task.merge'}) — verified + covered by
  // admin-validate + admin.smoke tests.
  "post('/admin/task/merge'",
];

function endpoints(src) {
  const re = /router\.(post|put|delete)\(\s*'(\/admin\/[^']+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    out.push({ method: m[1], path: m[2], index: m.index });
  }
  return out;
}

describe('L1 — universal audit retrofit guard', () => {
  for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    const eps = endpoints(src);
    test(`${path.basename(file)} has admin write endpoints`, () => {
      expect(eps.length).toBeGreaterThan(0);
    });
    for (const ep of eps) {
      const sig = `${ep.method}('${ep.path}'`;
      if (ALLOW.some((a) => sig.includes(a))) continue;
      test(`${ep.method.toUpperCase()} ${ep.path} calls auditAction`, () => {
        // slice from this endpoint to the next router. definition
        const rest = src.slice(ep.index + 1);
        const nextIdx = rest.search(/router\.(post|put|delete|get)\(/);
        const block = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
        expect(block).toMatch(/auditAction\s*\(/);
      });
    }
  }
});
