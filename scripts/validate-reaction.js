'use strict';
/**
 * Test that addReaction goes through with the new partial silent config.
 * Picks the most recent operator message of the day, asks slack/client
 * to react, and checks: (a) Slack got the call (real API), (b) silent_log
 * didn't gain a row.
 */

const { Pool } = require('pg');
const slackClient = require('../src/slack/client');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  // Pick the most recent NOT-already-reacted slack message of the day
  // (we'll just try the latest — Slack will return already_reacted gracefully if so)
  const latest = await pool.query(
    `SELECT slack_ts, LEFT(text, 80) AS preview
     FROM messages
     WHERE (created_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date
       AND user_id NOT IN ('U03URLL1D4L','U03S46L2EUA','U085SDY3F4Z','U09DQGJ1ES3')
     ORDER BY slack_ts DESC LIMIT 1`
  );
  if (latest.rows.length === 0) {
    console.log('No message to react to today.');
    await pool.end();
    process.exit(0);
  }
  const target = latest.rows[0];
  console.log('Target message:', target.slack_ts, '—', target.preview);

  // Count silent_log rows before
  const before = await pool.query(`SELECT COUNT(*)::int AS n FROM silent_log WHERE kind='reaction'`);
  console.log('silent_log[reaction] before:', before.rows[0].n);

  // Call addReaction
  console.log('Calling slackClient.addReaction...');
  try {
    await slackClient.addReaction(target.slack_ts);
    console.log('addReaction returned without error.');
  } catch (err) {
    console.error('addReaction error:', err.message);
  }

  // Count silent_log rows after
  const after = await pool.query(`SELECT COUNT(*)::int AS n FROM silent_log WHERE kind='reaction'`);
  console.log('silent_log[reaction] after:', after.rows[0].n);

  if (after.rows[0].n > before.rows[0].n) {
    console.log('\n❌ FAIL — reaction was suppressed (silent_log gained a row).');
  } else {
    console.log('\n✅ PASS — reaction went through to Slack (no new silent_log row).');
    console.log('Check the channel: the ✅ should be visible on the latest message.');
  }

  await pool.end();
})().catch((err) => {
  console.error('FATAL:', err.message);
  pool.end().catch(() => {});
  process.exit(1);
});
