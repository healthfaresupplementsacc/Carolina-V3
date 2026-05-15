'use strict';
/**
 * Wraps scripts/reprocess-day.js for each of the last 7 days. Spawns one
 * child process per day, captures its summary, aggregates.
 *
 * Usage:
 *   railway run --service ProductionLineService node scripts/reprocess-7days.js [--dry-run]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const dryRun = process.argv.includes('--dry-run');
const SCRIPT = path.join(__dirname, 'reprocess-day.js');

function etDate(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

const agg = {
  examined: 0,
  parsed_type_changed: 0,
  handlers_invoked: 0,
  already_processed: 0,
  ignore_unknown: 0,
  errors: 0,
  handlers_by_type: {},
  changes_by_day: {},
};

console.log(`reprocess-7days.js — mode: ${dryRun ? 'DRY RUN' : 'REAL'}\n`);

for (let n = 6; n >= 0; n--) {
  const day = etDate(n);
  console.log(`\n━━━ ${day} ${n === 0 ? '(hoje)' : '(' + n + 'd atrás)'} ━━━`);
  const args = [SCRIPT, '--date=' + day];
  if (dryRun) args.push('--dry-run');
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const out = (result.stdout || '') + (result.stderr || '');
  // Parse the summary block
  const exam = (out.match(/Examined\s+:\s+(\d+)/) || [])[1];
  const ptch = (out.match(/Parsed type changed:\s+(\d+)/) || [])[1];
  const hand = (out.match(/Handlers invoked\s+:\s+(\d+)/) || [])[1];
  const alr  = (out.match(/Already processed\s+:\s+(\d+)/) || [])[1];
  const ign  = (out.match(/Ignore\/unknown\s+:\s+(\d+)/) || [])[1];
  const err  = (out.match(/Errors\s+:\s+(\d+)/) || [])[1];

  console.log(`  examined=${exam || '?'} parseChanged=${ptch || '?'} handlers=${hand || '?'} alreadyProcessed=${alr || '?'} ignored=${ign || '?'} errors=${err || '?'}`);

  agg.examined            += parseInt(exam) || 0;
  agg.parsed_type_changed += parseInt(ptch) || 0;
  agg.handlers_invoked    += parseInt(hand) || 0;
  agg.already_processed   += parseInt(alr) || 0;
  agg.ignore_unknown      += parseInt(ign) || 0;
  agg.errors              += parseInt(err) || 0;

  const handlerSection = out.split('Handlers by type:')[1]?.split('\n\n')[0] || '';
  for (const line of handlerSection.split('\n')) {
    const m = line.match(/\s+(\w+):\s+(\d+)/);
    if (m) agg.handlers_by_type[m[1]] = (agg.handlers_by_type[m[1]] || 0) + parseInt(m[2]);
  }

  if (parseInt(ptch) > 0 || parseInt(hand) > 0) {
    agg.changes_by_day[day] = { parseChanged: parseInt(ptch) || 0, handlers: parseInt(hand) || 0 };
  }

  if (result.status !== 0) {
    console.log('  ❌ child exited with code', result.status);
    if (result.stderr) console.log('    stderr (first 300 chars):', result.stderr.slice(0, 300));
  }
}

console.log('\n══════════════ AGGREGATE (7 days) ══════════════');
console.log(`Total examined           : ${agg.examined}`);
console.log(`Parsed type changed      : ${agg.parsed_type_changed}`);
console.log(`Handlers invoked         : ${agg.handlers_invoked} ${dryRun ? '(would invoke)' : ''}`);
console.log(`Already processed (skip) : ${agg.already_processed}`);
console.log(`Ignore/unknown           : ${agg.ignore_unknown}`);
console.log(`Errors                   : ${agg.errors}`);
console.log('\nHandlers by type:');
for (const [t, n] of Object.entries(agg.handlers_by_type)) console.log(`  ${t}: ${n}`);
console.log('\nDays with changes:');
for (const [day, c] of Object.entries(agg.changes_by_day)) {
  console.log(`  ${day}: ${c.handlers} handlers + ${c.parseChanged} parsed_type changes`);
}
if (dryRun) console.log('\n(dry run — nothing was written)');
