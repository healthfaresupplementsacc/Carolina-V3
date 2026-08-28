'use strict';
/*
 * ARCHITECTURE DRIFT TEST — pure static analysis.
 *
 * Reads files from disk ONLY. Never touches a database or the network.
 * Its job: fail the moment the running system diverges from docs/ARCHITECTURE.md,
 * so the doc cannot silently rot.
 *
 * What it asserts:
 *   1. Every worker started in src/v3/wire.js is named in ARCHITECTURE.md.
 *   2. Every route surface mounted in src/index.js / src/v3/wire.js is named in ARCHITECTURE.md.
 *   3. Every table created by a migration is named in ARCHITECTURE.md — EXCEPT a
 *      baseline of tables the summary intentionally omits (KNOWN_UNDOCUMENTED_TABLES).
 *      A NEW migration table that is neither documented nor in the baseline fails here.
 *   4. The set of src/ files that write v3.events.ended_at / v3.production_counts /
 *      v3.stock_movements matches the verified set from ARCHITECTURE.md BROKEN LINKS
 *      (2026-08-11). A new writer file appearing fails immediately.
 *
 * Every failure names the offending file and says docs/ARCHITECTURE.md needs updating.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const DOC_PATH = path.join(ROOT, 'docs', 'ARCHITECTURE.md');
const DOC = fs.readFileSync(DOC_PATH, 'utf8');

const NEEDS_UPDATE = 'docs/ARCHITECTURE.md needs updating.';

// ── helpers ──────────────────────────────────────────────────────────────
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (/__tests__|node_modules/.test(p)) continue; walk(p, acc); }
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) acc.push(p);
  }
  return acc;
}
const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, '/');

// ── 1. workers ─────────────────────────────────────────────────────────────
describe('drift: workers started in wire.js are documented', () => {
  const wire = read('src/v3/wire.js');
  const workers = [...wire.matchAll(/require\('\.\.\/workers\/([a-z-]+)'\)/g)].map((m) => m[1]);
  const unique = [...new Set(workers)];
  test.each(unique)('worker "%s" is named in ARCHITECTURE.md', (w) => {
    // doc references workers by filename (e.g. "attendance-sync") in the runtime list.
    expect(DOC.includes(w) ? true : `worker src/workers/${w}.js started in wire.js but not in ARCHITECTURE.md. ${NEEDS_UPDATE}`).toBe(true);
  });
});

// ── 2. route surfaces ───────────────────────────────────────────────────────
describe('drift: route surfaces mounted are documented', () => {
  // The specific, load-bearing mounts the doc must name (not the generic '/').
  // Derived from src/index.js and src/v3/wire.js app.use/app.post/require targets.
  const EXPECTED_ROUTE_MARKERS = [
    '/slack/events-v2',   // wire.js:96
    '/api/v3/data',       // wire.js:200 (data router)
    '/api/v3/op',         // wire.js:149 (op router)
    '/api/admin/v3',      // wire.js:131 (admin-v3 shadow)
    '/dashboard-v4',      // wire.js:216
    '/api/images/upload', // wire.js:232
    '/foto',              // wire.js:231
    '/api/v3/print-queue', // wire.js:234 (S15.34 print queue, pulled by the .28)
    '/api/v3/prefs',      // per-account preferences (2026-08-19), documented §4
    '/api/v3/review',     // review day/calendar/waiting (2026-08-19), documented §2 + §4
    '/api/v3/freight',    // freight cost watch (2026-08-28), documented §2 + §4
  ];
  test.each(EXPECTED_ROUTE_MARKERS)('route surface "%s" is named in ARCHITECTURE.md', (r) => {
    expect(DOC.includes(r) ? true : `route surface ${r} is mounted but not in ARCHITECTURE.md. ${NEEDS_UPDATE}`).toBe(true);
  });
  // Guard: if a NEW require of a router file appears in index.js/wire.js, and it is
  // not one of the known mounted routers, fail so someone documents it.
  const KNOWN_ROUTER_REQUIRES = new Set([
    './dashboard/router', './routes/api', './routes/workflow', './slack/poller',
    './slack/events', './routes/cameras', './slack/client',
    './admin-v3/routes', './data/router', './images/router', '../routes/architect',
    '../routes/op', '../routes/admin',
    './warehouse/router',   // Warehouse hub /api/v3/warehouse/* — wire.js:236 (documented §4 Stock)
    './print-queue/router', // Print queue /api/v3/print-queue/* — wire.js:234 (documented §4 Stock + §6 Printing)
    './prefs/router',       // Per-account preferences /api/v3/prefs/* (documented §2 routes + §4 tables)
    './review/router',      // Review day/calendar/waiting /api/v3/review/* (documented §2 routes + §4 modules)
    './health/router',      // Signal health /api/v3/health/* (documented §2 routes + §4 modules)
    './freight/router',     // Freight cost watch /api/v3/freight/* (documented §2 routes + §4 modules)
  ]);
  const idx = read('src/index.js');
  const wire = read('src/v3/wire.js');
  const routerReqs = [
    ...idx.matchAll(/require\('(\.\/routes\/[a-z]+|\.\/dashboard\/router|\.\/slack\/[a-z]+)'\)/g),
    ...wire.matchAll(/require\('(\.\.?\/[a-z0-9/-]*(?:routes?|router)[a-z0-9/-]*)'\)/g),
  ].map((m) => m[1]);
  test('no undocumented router require in index.js / wire.js', () => {
    const unknown = [...new Set(routerReqs)].filter((r) => !KNOWN_ROUTER_REQUIRES.has(r));
    expect(unknown.length === 0 ? true
      : `new router require(s) ${unknown.join(', ')} not in the known set — add to ARCHITECTURE.md and this test. ${NEEDS_UPDATE}`).toBe(true);
  });
});

// ── 3. migration tables ──────────────────────────────────────────────────────
describe('drift: migration tables are documented', () => {
  // Tables the summary intentionally omits (baseline snapshot 2026-08-11). A NEW
  // migration table that is neither documented nor here will fail — forcing a decision.
  const KNOWN_UNDOCUMENTED_TABLES = new Set([
    'activity_gaps', 'admin_sessions', 'admin_users', 'app_functions', 'app_logins',
    'app_roles', 'bottle_size_tiers', 'carolina_channel_personality', 'carolina_config',
    'carolina_learning_cycles', 'carolina_personalities', 'carolina_prompt_versions',
    'carolina_signals', 'daily_totals_log', 'deadlines', 'dedupe_links', 'envelope_mix',
    'flows', 'llm_corrections', 'machine_custody', 'op_notes', 'packing_questions',
    'person_language_profile', 'prefix_resolution_log', 'product_catalog',
    'raw_material_coas', 'roadmap_areas', 'roadmap_cards', 'roadmap_comments',
    'roadmap_sketches', 'role_functions', 'sender_profiles', 'shared_account_users',
    'shared_accounts', 'task_targets', 'vocabulary', 'voice_recordings', 'proposals',
  ]);
  const migDir = path.join(SRC, 'v3', 'schema', 'migrations');
  const tables = new Set();
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql'))) {
    const t = fs.readFileSync(path.join(migDir, f), 'utf8');
    for (const m of t.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?v3\.([a-z_]+)/gi)) tables.add(m[1]);
  }
  test.each([...tables])('table v3.%s is documented or in the known-undocumented baseline', (tbl) => {
    const documented = DOC.includes('v3.' + tbl) || DOC.includes(' ' + tbl + ' ') || KNOWN_UNDOCUMENTED_TABLES.has(tbl);
    expect(documented ? true
      : `table v3.${tbl} is created by a migration but is neither in ARCHITECTURE.md nor the known-undocumented baseline. Document it (or add to the baseline). ${NEEDS_UPDATE}`).toBe(true);
  });
});

// ── 4. writers of sensitive tables ───────────────────────────────────────────
describe('drift: writer sets for tracked tables match the verified findings', () => {
  const allFiles = walk(SRC, []);
  function writerFiles(matcher) {
    return allFiles.filter((f) => matcher(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  }
  // EXPECTED sets are the verified findings from ARCHITECTURE.md BROKEN LINKS (2026-08-11).
  const cases = [
    {
      table: 'v3.events.ended_at',
      // A file writes events.ended_at if it has an `UPDATE v3.events` AND either sets
      // `ended_at =` literally OR lists 'ended_at' in a dynamic field set (EventService._patch).
      matcher: (t) => /UPDATE\s+v3\.events/i.test(t) && (/ended_at\s*=/i.test(t) || /'ended_at'/.test(t)),
      expected: [
        'src/routes/admin.js',
        'src/routes/op.js',
        'src/v3/data/router.js',
        'src/v3/services/CommandHandler.js',
        'src/v3/services/EventService.js',
        'src/workers/attendance-sync.js',
        'src/workers/ems-activity-sync.js',
      ],
    },
    {
      table: 'v3.production_counts',
      matcher: (t) => /INSERT\s+INTO\s+v3\.production_counts/i.test(t),
      expected: [
        'src/routes/admin.js',
        'src/routes/op.js',
        'src/v3/services/ProductionCountService.js',
      ],
    },
    {
      table: 'v3.stock_movements',
      matcher: (t) => /INSERT\s+INTO\s+v3\.stock_movements/i.test(t),
      // S15 Fase 2 (2026-08-18): o INSERT cru do kiosk (op.js, R076) FOI REMOVIDO.
      // "Peguei do estoque" virou proposta (StockRequestService) e só o
      // StockService escreve o livro-razão. Porta única de escrita = UMA agora.
      expected: [
        'src/v3/services/StockService.js',
      ],
    },
  ];
  test.each(cases)('$table writer set is unchanged', ({ table, matcher, expected }) => {
    const actual = writerFiles(matcher);
    const added = actual.filter((f) => !expected.includes(f));
    const removed = expected.filter((f) => !actual.includes(f));
    const msg = [];
    if (added.length) msg.push('NEW writer file(s): ' + added.join(', '));
    if (removed.length) msg.push('writer file(s) gone: ' + removed.join(', '));
    expect(msg.length === 0 ? true
      : `${table} writers changed — ${msg.join('; ')}. Update the BROKEN LINKS section. ${NEEDS_UPDATE}`).toBe(true);
  });
});
