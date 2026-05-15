'use strict';
/**
 * Runner for Bug 3 legacy-orphan cleanup.
 *   railway run --service ProductionLineService node scripts/legacy-cleanup.js            (DRY RUN)
 *   railway run --service ProductionLineService node scripts/legacy-cleanup.js --apply    (REAL)
 */
const { Pool } = require('pg');
const args = process.argv.slice(2);
const apply = args.includes('--apply');

// point the engine module's db at a real pool
process.env.DATABASE_URL = process.env.DATABASE_URL;
const { cleanupLegacyOrphans } = require('../src/workflow/legacy-cleanup');

(async () => {
  const r = await cleanupLegacyOrphans({ dryRun: !apply, olderThanHours: 24 });
  console.log(JSON.stringify(r, null, 2));
  if (!apply) console.log('\n(dry run — nothing written. add --apply to execute)');
  // db pool is shared via src/db; close it
  try { require('../src/db').pool.end(); } catch (_) {}
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
