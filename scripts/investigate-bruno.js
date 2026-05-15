'use strict';
/**
 * Why is Bruno occasionally ignored?
 *
 * Hypothesis space:
 *   H1 — Message has 'Bruno' in body but parser resolved operator to
 *        someone else (account owner usually). We fixed N1 yesterday but
 *        regressions may exist.
 *   H2 — BRUNO_ALLOWED_ACCOUNTS check kicks in and bruno is blocked
 *        (returned ignore) because the message was sent from Bruno Camp's
 *        owner account, which is correctly disallowed.
 *   H3 — Prefix didn't match because of unusual punctuation (the prefix
 *        regex requires '-' or ':' separator).
 *   H4 — Bruno appears inside the body but not as a prefix, and the
 *        parser legitimately attributed to the account owner.
 *
 * Approach:
 *   - Pull every message of the last 30 days where text contains 'Bruno'
 *     (case-insensitive).
 *   - For each, re-parse with the CURRENT parser code.
 *   - Compare the parser's resolved operator with what we'd expect from
 *     the prefix.
 *   - Bucket the results and show top examples per bucket.
 */

const { Pool } = require('pg');
const parser = require('../src/parser');

const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const rows = await p.query(
    `SELECT slack_ts, user_id, user_name, text, parsed_type
     FROM messages
     WHERE created_at >= NOW() - INTERVAL '30 days'
       AND text ILIKE '%bruno%'
     ORDER BY slack_ts DESC
     LIMIT 500`
  );
  console.log(`Messages mentioning 'Bruno' in last 30d: ${rows.rows.length}\n`);

  const buckets = {
    'bruno_prefix_resolved_bruno':        { n: 0, examples: [] },
    'bruno_prefix_resolved_other':        { n: 0, examples: [] },
    'bruno_prefix_blocked_owner_account': { n: 0, examples: [] },
    'bruno_mentioned_no_prefix':          { n: 0, examples: [] },
    'parse_failed_no_operator':           { n: 0, examples: [] },
    'parsed_as_ignore':                   { n: 0, examples: [] },
  };

  const BRUNO_PREFIX_RE = /^(?:\s*)bruno(?:[-:;/]|\s+[-:;/]|\s)/i;
  const BRUNO_OWNER_ID = 'U03URLL1D4L'; // Bruno Camp (admin, not worker)

  for (const row of rows.rows) {
    const text = row.text || '';
    const parsed = parser.parseMessage({
      ts: row.slack_ts, user: row.user_id || '', text, username: row.user_name || '',
    });
    const expected = BRUNO_PREFIX_RE.test(text.replace(/^[\s ]+/, '')) ? 'Bruno' : null;
    const actual = parsed?.operator || null;
    const ptype = parsed?.type || 'null';

    let bucket;
    if (ptype === 'ignore') {
      // Bruno-blocked case: parser returned type='ignore' due to brunoBlocked.
      // We can detect by checking userId.
      if (row.user_id === BRUNO_OWNER_ID && expected === 'Bruno') {
        bucket = 'bruno_prefix_blocked_owner_account';
      } else {
        bucket = 'parsed_as_ignore';
      }
    } else if (expected === 'Bruno' && actual === 'Bruno') {
      bucket = 'bruno_prefix_resolved_bruno';
    } else if (expected === 'Bruno' && actual !== 'Bruno') {
      bucket = 'bruno_prefix_resolved_other';
    } else if (expected === null) {
      bucket = 'bruno_mentioned_no_prefix';
    } else {
      bucket = 'parse_failed_no_operator';
    }

    buckets[bucket].n++;
    if (buckets[bucket].examples.length < 5) {
      buckets[bucket].examples.push({
        ts: row.slack_ts,
        userId: row.user_id || '?',
        text: text.slice(0, 100).replace(/\n/g, ' '),
        type: ptype,
        actualOp: actual,
        expectedOp: expected,
      });
    }
  }

  console.log('Bucket breakdown:\n');
  for (const [name, b] of Object.entries(buckets)) {
    console.log(`  [${String(b.n).padStart(3)}x] ${name}`);
    for (const e of b.examples) {
      console.log(`         ↳ user=${e.userId} parsed=${e.type} op=${e.actualOp} (expected=${e.expectedOp})`);
      console.log(`           "${e.text}"`);
    }
  }

  await p.end();
})().catch((err) => {
  console.error('FATAL:', err.message);
  p.end().catch(() => {});
  process.exit(1);
});
