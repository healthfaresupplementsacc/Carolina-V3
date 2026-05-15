'use strict';
/**
 * Slack channel poller.
 * Polls #orders-and-inventory every N seconds, parses new messages,
 * persists them to the DB, and triggers downstream logic (urgency, etc.).
 */

const db = require('../db');
const slackClient = require('./client');
const { parseMessage } = require('../parser');
const taskEngine = require('../tasks');
const ordersEngine = require('../orders');
const formulationEngine = require('../formulation');
const eodEngine = require('../eod');
const config = require('../config');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

let lastProcessedTs = null;
let isRunning = false;
let isBackfilling = false;

async function getLastTs() {
  if (lastProcessedTs) return lastProcessedTs;
  const res = await db.query(
    "SELECT value FROM app_state WHERE key = 'last_processed_ts'"
  );
  return res.rows[0]?.value || null;
}

async function setLastTs(ts) {
  lastProcessedTs = ts;
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('last_processed_ts', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [ts]
  );
}

async function processMessage(msg) {
  const { ts, user, text } = msg;
  if (!text) return;

  // Skip bot messages, our own messages, and non-operator accounts
  const NON_OPERATORS = [
    config.slack.bryceUserId,
    config.slack.brunoUserId,
    config.slack.thassioUserId,
    config.slack.henriqueUserId,
  ].filter(Boolean);
  if (msg.bot_id || NON_OPERATORS.includes(user)) return;

  // Check if already processed
  const existing = await db.query(
    'SELECT id, text, edited_at FROM messages WHERE slack_ts = $1',
    [ts]
  );

  // B4: detect Slack edits — when text differs OR Slack `edited` field changed.
  if (existing.rows.length > 0) {
    const stored = existing.rows[0];
    const incomingEditedTs = msg.edited?.ts || null;
    const textChanged = stored.text !== text;
    const editedTsChanged = incomingEditedTs && stored.edited_at !== incomingEditedTs;
    if (!textChanged && !editedTsChanged) return; // unchanged, skip

    console.log(`[Poller] Message ${ts} was edited; reprocessing`);
    await db.query(
      `UPDATE messages SET previous_text = $1, text = $2, edited_at = $3, raw_json = $4 WHERE slack_ts = $5`,
      [stored.text, text, incomingEditedTs || String(Date.now() / 1000), JSON.stringify(msg), ts]
    );
    // Fall through to re-parse and re-dispatch handlers with the new text.
  }

  const parsed = parseMessage(msg);
  const parsedType = parsed?.type || 'unknown';

  // Store raw message (skip insert on edit — already updated above)
  if (existing.rows.length === 0) {
    const userName = msg.username || msg.user_profile?.display_name || user;
    await db.query(
      `INSERT INTO messages (slack_ts, channel_id, user_id, user_name, text, raw_json, parsed_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slack_ts) DO NOTHING`,
      [ts, config.slack.channelId, user, userName, text, JSON.stringify(msg), parsedType]
    );
  } else {
    await db.query('UPDATE messages SET parsed_type = $1 WHERE slack_ts = $2', [parsedType, ts]);
  }

  // Bom dia response — only the first greeting of the day, never during backfill
  if (!isBackfilling && /^bom\s*dia\b/i.test(text.trim())) {
    await maybeSendBomDia();
  }

  if (!parsed || parsedType === 'ignore') return;

  const TRACKED_TYPES = ['start', 'finish', 'count', 'orders_start', 'orders_finish', 'orders_continue', 'formulation_start', 'formulation_finish', 'pause_start', 'pause_end'];
  if (!isBackfilling && TRACKED_TYPES.includes(parsedType)) {
    await slackClient.addReaction(ts);
  }

  // Pending question interception
  const EXPLICIT_COMMAND_TYPES = ['start', 'finish', 'orders_start', 'orders_finish', 'formulation_start', 'formulation_finish'];
  if (!isBackfilling && parsed.operator) {
    if (EXPLICIT_COMMAND_TYPES.includes(parsedType)) {
      await taskEngine.clearPendingQuestion(parsed.operator);
    } else if (parsedType === 'unknown') {
      const handled = await taskEngine.handlePendingResponse(parsed.operator, msg);
      if (handled) {
        await slackClient.addReaction(ts);
        return;
      }
    }
  }

  // Route production summary (EOD total report)
  if (parsedType === 'production_summary') {
    if (!isBackfilling) {
      await eodEngine.handleProductionSummary(parsed);
      await slackClient.addReaction(msg.ts);
    }
    return;
  }

  // Route orders to orders engine
  if (parsedType === 'orders_start') {
    await ordersEngine.handleOrdersStart(parsed, msg);
    await setOrdersState('open', parsed.operator);
    return;
  }
  if (parsedType === 'orders_finish') {
    await ordersEngine.handleOrdersFinish(parsed, msg);
    await setOrdersState('closed', parsed.operator);
    return;
  }
  if (parsedType === 'orders_continue') {
    await setOrdersState('open', parsed.operator);
    const askKey = `orders_asked_${todayEt()}`;
    await db.query(`DELETE FROM app_state WHERE key = $1`, [askKey]);
    // If no count included, ask how many were printed in the second run
    if (!parsed.orderCount && parsed.operator && !isBackfilling) {
      const countKey = `orders_count_asked_${todayEt()}`;
      const alreadyAsked = await db.query('SELECT value FROM app_state WHERE key = $1', [countKey]);
      if (!alreadyAsked.rows.length) {
        const q = pick(ASK_SECOND_COUNT_MSGS)(parsed.operator);
        await slackClient.postMessage(q);
        await db.query(
          `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [countKey, parsed.operator]
        );
        console.log(`[Orders] Asked ${parsed.operator} for second print count`);
      }
    }
    return;
  }

  // Handle reply to second-print count question
  if (!isBackfilling && parsedType === 'unknown' && parsed.operator) {
    const countKey = `orders_count_asked_${todayEt()}`;
    const pendingCount = await db.query('SELECT value FROM app_state WHERE key = $1', [countKey]);
    if (pendingCount.rows.length && pendingCount.rows[0].value === parsed.operator) {
      const numMatch = text.trim().match(/^(\d+)\s*$/);
      if (numMatch) {
        const orderCount = parseInt(numMatch[1]);
        // Create a new orders session for the second print
        const ordersEngine = require('../orders');
        await ordersEngine.handleOrdersStart({ operator: parsed.operator, orderCount, ts: msg.ts }, msg);
        await db.query(`DELETE FROM app_state WHERE key = $1`, [countKey]);
        await slackClient.addReaction(ts);
        console.log(`[Orders] Second print count recorded: ${parsed.operator} — ${orderCount}`);
        return;
      }
    }
  }

  // Orders context check: ask if still doing orders when new function starts
  if (!isBackfilling && ['start', 'finish', 'count'].includes(parsedType)) {
    await checkOrdersContext(parsed, msg);
  }

  if (parsedType === 'formulation_start') {
    await formulationEngine.handleFormulationStart(parsed, msg);
    return;
  }
  if (parsedType === 'formulation_finish') {
    await formulationEngine.handleFormulationFinish(parsed, msg);
    return;
  }

  // Route production tasks to task engine
  await taskEngine.handleParsed(parsed, msg);

  // Entrega 3 Fase 5.1 — also dispatch to the new workflow engine.
  // Runs in parallel with the legacy path; failures are swallowed so a
  // bug in the new code can never break production.
  if (!isBackfilling) {
    try {
      const workflowDispatcher = require('../workflow/dispatcher');
      await workflowDispatcher.safeDispatch(parsed, msg);
    } catch (_) { /* extremely defensive */ }
  }
}

async function poll() {
  if (isRunning) return;
  isRunning = true;

  try {
    const since = await getLastTs();
    const messages = await slackClient.fetchMessages(since, 100);

    if (messages.length > 0) {
      console.log(`[Poller] Processing ${messages.length} new messages`);

      // Bug N2: advance last_processed_ts only past messages that ACTUALLY
      // succeeded. If a message in the middle of the batch throws, we stop
      // there and the next poll re-fetches from the last good ts — instead
      // of skipping every message after the failure. Dedup downstream relies
      // on the full-precision Slack ts (string, decimals included) stored as
      // VARCHAR(30) UNIQUE in messages.slack_ts, so re-fetched-but-already-
      // processed messages are a cheap no-op.
      let lastSuccessTs = null;
      for (const msg of messages) {
        try {
          await processMessage(msg);
          lastSuccessTs = msg.ts;
        } catch (err) {
          console.error(
            `[Poller] Error processing ${msg.ts}, halting batch (will retry next poll):`,
            err.message
          );
          break;
        }
      }

      if (lastSuccessTs) {
        await setLastTs(lastSuccessTs);
      }
    }

    // B4: also scan recent messages for edits. Slack's `oldest=since` query
    // only returns brand-new messages — edits to older messages are missed.
    await pollEdits();
  } catch (err) {
    console.error('[Poller] Poll cycle error:', err.message);
  } finally {
    isRunning = false;
  }

  try {
    await eodEngine.checkMorningReminder();
    await eodEngine.checkCleaningDuration();
    await eodEngine.checkSixPmReminder();
    await eodEngine.checkEod();
  } catch (err) {
    console.error('[Poller] EOD check error:', err.message);
  }
}

/**
 * B4: Detect edits to messages we've already processed.
 * Fetches the most recent ~50 messages (regardless of `last_processed_ts`)
 * and lets `processMessage` compare against stored DB state. When text or
 * the Slack `edited` field changed, `processMessage` updates the row and
 * re-runs parser + handler dispatch.
 */
async function pollEdits() {
  if (isBackfilling) return; // don't run edit detection during initial backfill
  try {
    const recent = await slackClient.fetchRecentMessages(50);
    let editsFound = 0;
    for (const msg of recent) {
      if (!msg.edited) continue; // only re-check messages Slack flagged as edited
      try {
        // processMessage internally detects unchanged-and-already-processed
        // and bails out, so calling it on edited messages is safe and cheap.
        await processMessage(msg);
        editsFound++;
      } catch (err) {
        console.error(`[Poller] Edit re-process error for ${msg.ts}:`, err.message);
      }
    }
    if (editsFound > 0) {
      console.log(`[Poller] Re-checked ${editsFound} edited messages`);
    }
  } catch (err) {
    console.error('[Poller] pollEdits error:', err.message);
  }
}

async function backfill(startTs) {
  isBackfilling = true;
  console.log(`[Backfill] Starting from ts=${startTs}`);
  let processed = 0;

  try {
    const messages = await slackClient.fetchMessages(startTs, 5000);
    console.log(`[Backfill] Found ${messages.length} messages to process`);

    for (const msg of messages) {
      try {
        await processMessage(msg);
        processed++;
      } catch (err) {
        console.error(`[Backfill] Error on msg ${msg.ts}:`, err.message);
      }
    }

    if (messages.length > 0) {
      const latestTs = messages[messages.length - 1].ts;
      await setLastTs(latestTs);
    }

    isBackfilling = false;
    console.log(`[Backfill] Done. Processed ${processed} messages.`);
    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('backfill_done', 'true', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW()`
    );
  } catch (err) {
    console.error('[Backfill] Fatal error:', err.message);
  }

  return processed;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayEt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function setOrdersState(status, operator) {
  const key = `orders_open_${todayEt()}`;
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify({ status, operator })]
  );
}

const ORDERS_STILL_OPEN_QUESTIONS = [
  (name) => `${name}, vc ainda ta fazendo as ordens ou ja acabou? me confirma aqui`,
  (name) => `oi ${name} — as ordens de hoje ja foram concluidas?`,
  (name) => `${name} me faz um favor: as ordens ainda tao em aberto?`,
  (name) => `${name}, terminou as ordens ou ainda ta no packing?`,
  (name) => `ei ${name}, as ordens ja foram fechadas ou ainda ta rolando?`,
  (name) => `${name} — ordens: ainda aberto ou ja finalizado?`,
  (name) => `${name}, preciso saber: as ordens ja foram concluidas hoje?`,
  (name) => `oi ${name}, as ordens do dia ja fecharam?`,
  (name) => `${name} ainda ta no packing ou ja terminou tudo?`,
  (name) => `${name}, me confirma: terminou de embalar as ordens?`,
  (name) => `${name} — ainda fazendo as ordens ou ja liberou?`,
  (name) => `oi ${name}! as ordens ainda tao abertas, certo? ou ja fechou?`,
  (name) => `${name}, ordens concluidas ou ainda em andamento?`,
  (name) => `${name} as ordens ja foram? me confirma ai`,
  (name) => `ei ${name} — terminou as ordens ou ainda ta rodando?`,
  (name) => `${name}, pode me confirmar o status das ordens?`,
  (name) => `${name} — finalizou o packing ou ainda tem ordens pra fazer?`,
  (name) => `oi ${name}, as ordens de hoje ja foram concluidas ou ainda em aberto?`,
  (name) => `${name}, me avisa quando terminar as ordens, ainda ta fazendo ne?`,
  (name) => `${name} — ainda ta com as ordens abertas? manda um F: ordens quando fechar`,
];

const ASK_SECOND_COUNT_MSGS = [
  (name) => `${name}, quantos você imprimiu na segunda impressão?`,
  (name) => `${name}, me diz quantas ordens vieram na segunda rodada`,
  (name) => `${name} — quantas ordens na segunda impressão?`,
  (name) => `oi ${name}, quantas vieram na segunda impressão?`,
  (name) => `${name}, quantas ordens você imprimiu agora?`,
  (name) => `${name} me conta: quantas ordens na segunda rodada?`,
  (name) => `${name}, qual foi a quantidade da segunda impressão?`,
  (name) => `${name} — segunda impressão: quantas ordens?`,
  (name) => `oi ${name}! quantas ordens essa segunda rodada?`,
  (name) => `${name}, me passa a quantidade da segunda impressão`,
];

async function checkOrdersContext(parsed, msg) {
  try {
    const today = todayEt();
    const ordersRow = await db.query('SELECT value FROM app_state WHERE key = $1', [`orders_open_${today}`]);
    if (!ordersRow.rows.length) return;

    let ordersState;
    try { ordersState = JSON.parse(ordersRow.rows[0].value); } catch { return; }
    if (ordersState.status !== 'open') return;

    const askKey = `orders_asked_${today}`;
    const alreadyAsked = await db.query('SELECT updated_at FROM app_state WHERE key = $1', [askKey]);
    if (alreadyAsked.rows.length > 0) {
      const askedAt = new Date(alreadyAsked.rows[0].updated_at);
      if (Date.now() - askedAt.getTime() < 3 * 60 * 60 * 1000) return;
    }

    const operator = ordersState.operator || 'pessoal';
    const q = ORDERS_STILL_OPEN_QUESTIONS;
    const question = q[Math.floor(Math.random() * q.length)](operator);
    await slackClient.postMessage(question);

    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, 'sent', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'sent', updated_at = NOW()`,
      [askKey]
    );
    console.log(`[Orders] Asked "${operator}" if still doing orders`);
  } catch (err) {
    console.error('[Orders] checkOrdersContext error:', err.message);
  }
}

const BOM_DIA_RESPONSES = [
  'bom dia! vamos nessa',
  'bom diaaaa pessoal',
  'oi gente, bom dia! to de olho aqui',
  'bom dia! nao esquece o S: quando comecar, ta?',
  'bom dia! dia de producao, bora',
  'oi! bom dia — me avisa quando comecar',
  'bom diaaaa! ja to aqui registrando tudo',
  'bom dia pessoal!',
  'oi, bom dia! nao some nao que eu to vendo',
  'bom dia! vamos que vamos, sem enrolacao',
];

async function maybeSendBomDia() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const key = `bom_dia_${today}`;
    const existing = await db.query('SELECT value FROM app_state WHERE key = $1', [key]);
    if (existing.rows.length > 0) return;

    const response = BOM_DIA_RESPONSES[Math.floor(Math.random() * BOM_DIA_RESPONSES.length)];
    await slackClient.postMessage(response);

    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, 'sent', NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key]
    );
    console.log(`[Poller] Bom dia sent: ${response}`);
  } catch (err) {
    console.error('[Poller] Bom dia error:', err.message);
  }
}

async function isBackfillDone() {
  const res = await db.query("SELECT value FROM app_state WHERE key = 'backfill_done'");
  return res.rows[0]?.value === 'true';
}

module.exports = { poll, backfill, isBackfillDone };
