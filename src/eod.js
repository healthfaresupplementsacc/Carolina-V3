'use strict';
/**
 * End-of-day (EOD) logic for HealthFare production line.
 *
 * Responsibilities:
 *  1. After 6 PM ET: send one EOD open-tasks review to the production channel
 *     (unless a production summary was already received).
 *  2. Handle incoming production summary messages ("Producao de hoje: ...").
 *  3. Monitor cleaning sessions — alert after 60 minutes (any time of day).
 */

const db = require('./db');
const slackClient = require('./slack/client');
const config = require('./config');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** Current ET hour (0-23) */
function nowEtHour() {
  return parseInt(
    new Date().toLocaleString('en-US', {
      hour: 'numeric', hour12: false, timeZone: 'America/New_York',
    }),
    10
  );
}

/** Today's date string in ET, 'YYYY-MM-DD' */
function todayEt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Returns true when the ET clock is at or past 6 PM */
function isAfterSixPmEt() {
  return nowEtHour() >= 18;
}
module.exports.isAfterSixPmEt = isAfterSixPmEt;

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  });
}

function fmtElapsed(startedAt) {
  const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h${m > 0 ? m + 'min' : ''}`;
  return `${m}min`;
}

function taskLabel(task) {
  if (task.task_type === 'limpeza') return 'limpeza';
  if (task.task_type === 'revisao') {
    return task.supplement_name ? `revisao do ${task.supplement_name}` : 'revisao';
  }
  return task.supplement_name ? task.supplement_name : 'tarefa';
}

// ─── Admin notifications ──────────────────────────────────────────────────────

async function notifyAdmin(text) {
  try {
    await slackClient.postToChannel(config.slack.managerChannelId, text);
    console.log(`[EOD] Admin notified: ${text.slice(0, 80)}`);
  } catch (err) {
    console.error('[EOD] Admin notify error:', err.message);
  }
}
module.exports.notifyAdmin = notifyAdmin;

// ─── Production summary handler ───────────────────────────────────────────────

const PROD_SUMMARY_REPLIES = [
  (total) => `ok tenho anotado entao ${total} no total de hoje ` + String.fromCodePoint(0x1F44D) + ` me avisa se tiver algo pra atualizar`,
  (total) => `anotei! total do dia: ${total} bottles. qualquer ajuste e so falar`,
  (total) => `registrado -- ${total} bottles hoje. alguma correcao?`,
  (total) => `beleza, ${total} bottles hoje, to anotando. me avisa se mudar algo`,
  (total) => `ok! ${total} no total -- se tiver alguma coisa errada me fala`,
  (total) => `anotei aqui, ${total} bottles no dia. me deixa saber se precisar corrigir`,
  (total) => `tenho anotado entao ${total} pra hoje. alguma atualizacao?`,
  (total) => `${total} bottles hoje, registrado! qualquer coisa e so me falar`,
  (total) => `registrei -- ${total} de total hoje. se precisar corrigir algo e so falar`,
  (total) => `anotado: ${total} bottles no total. me chama se tiver mudanca`,
  (total) => `ok, ${total} bottles -- guardei aqui. me fala se precisar ajustar`,
];

/**
 * Called when a production_summary message is detected.
 * Saves the data, replies with total, cross-checks against DB counts.
 */
async function handleProductionSummary(parsed) {
  const { operator, items = [], totalBottles, ts } = parsed;
  const today = todayEt();

  // Persist so EOD check knows we got it
  await db.query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [`prod_summary_${today}`, JSON.stringify({ operator, totalBottles, items, ts })]
  );

  // Format with comma separator
  const totalFmt = parseInt(totalBottles).toLocaleString('en-US');
  await slackClient.postMessage(pick(PROD_SUMMARY_REPLIES)(totalFmt));

  // Cross-check each item vs what we recorded in DB
  await checkSummaryVsDb(items, today);

  console.log(`[EOD] Production summary: ${totalBottles} bottles total (by ${operator || 'unknown'})`);
}
module.exports.handleProductionSummary = handleProductionSummary;

async function checkSummaryVsDb(items, today) {
  for (const item of items) {
    if (!item.supplement || !item.count) continue;
    const res = await db.query(
      `SELECT supplement_name, bottles FROM tasks
       WHERE (started_at AT TIME ZONE 'America/New_York')::date = $1::date
         AND status = 'closed'
         AND task_type NOT IN ('limpeza', 'revisao')
         AND supplement_name ILIKE $2
       ORDER BY ended_at DESC LIMIT 1`,
      [today, `%${item.supplement}%`]
    );
    if (!res.rows.length) continue;
    const dbBottles = parseInt(res.rows[0].bottles) || 0;
    const reported  = parseInt(item.count) || 0;
    if (dbBottles > 0 && Math.abs(dbBottles - reported) > 15) {
      await notifyAdmin(
        `Warning: Production summary mismatch -- *${item.supplement}*: they reported *${reported}* bottles but DB shows *${dbBottles}*. Worth double-checking!`
      );
    }
  }
}

// ─── EOD open-tasks review ────────────────────────────────────────────────────

const EOD_VARIANTS = [
  (body) => `galera, ${body} me atualizem aqui e me deixem saber`,
  (body) => `oi pessoal -- ${body} podem me dar um update?`,
  (body) => `ei gente, ${body} ta todo mundo ok?`,
  (body) => `pessoal, ${body} me avisem quando fechar tudo por ai`,
  (body) => `oi, ${body} me falam o que ta acontecendo?`,
  (body) => `galera, ${body} qualquer update e so me chamar`,
];

/**
 * Runs on every poll cycle after 6 PM.
 * Sends the EOD open-tasks message once per day (unless summary already received).
 */
async function checkEod() {
  if (!isAfterSixPmEt()) return;
  const today = todayEt();

  // Already sent EOD message today?
  const eodKey = `eod_sent_${today}`;
  const eodSent = await db.query('SELECT value FROM app_state WHERE key = $1', [eodKey]);
  if (eodSent.rows.length > 0) return;

  // Already got a production summary? If yes, skip open-tasks nag
  const summaryKey = `prod_summary_${today}`;
  const summaryRecv = await db.query('SELECT value FROM app_state WHERE key = $1', [summaryKey]);

  // Fetch all open tasks for today
  const openRes = await db.query(
    `SELECT id, operator, supplement_name, task_type, started_at, helpers
     FROM tasks
     WHERE status = 'open'
       AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date
     ORDER BY started_at ASC`,
    [today]
  );
  const openTasks = openRes.rows;

  // Fetch the last completed supplement task (context for the message)
  const lastClosedRes = await db.query(
    `SELECT supplement_name FROM tasks
     WHERE status = 'closed'
       AND task_type NOT IN ('limpeza', 'revisao')
       AND supplement_name IS NOT NULL
       AND (started_at AT TIME ZONE 'America/New_York')::date = $1::date
     ORDER BY ended_at DESC LIMIT 1`,
    [today]
  );
  const lastSupplement = lastClosedRes.rows[0]?.supplement_name;

  // Build the body parts -- skip tasks with no useful label
  const parts = [];

  for (const t of openTasks) {
    if (!t.supplement_name && !t.task_type) continue;
    const elapsed  = fmtElapsed(t.started_at);
    const time     = fmtTime(t.started_at);
    const label    = taskLabel(t);
    const op       = t.operator || 'alguem';
    const opPhrase = t.operator ? `o(a) ${op} iniciou` : 'foi iniciada';
    parts.push(`ainda ta aqui em aberto a *${label}* que ${opPhrase} as ${time} e ja tem ${elapsed} rodando`);
  }

  if (!summaryRecv.rows.length) {
    if (lastSupplement) {
      parts.push(`a ultima producao que registrei foi do *${lastSupplement}* -- ainda nao recebi o total do dia`);
    } else {
      parts.push(`ainda nao recebi o total de producao do dia`);
    }
  }

  // Nothing to say -- all closed and summary received
  if (parts.length === 0) return;

  const bodyText = parts.join(', e tambem ');
  const msg      = pick(EOD_VARIANTS)(bodyText);
  await slackClient.postMessage(msg);

  // Also send a copy to admin so they have visibility
  await notifyAdmin(`Revisao fim de dia (${todayEt()})\n${msg}`);

  // Mark as sent so we don't repeat
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, 'sent', NOW())
     ON CONFLICT (key) DO UPDATE SET value = 'sent', updated_at = NOW()`,
    [eodKey]
  );

  console.log('[EOD] EOD review sent');
}
module.exports.checkEod = checkEod;

// ─── 8 AM morning reminder ────────────────────────────────────────────────────

const MORNING_GUIDE_MSG =
  'bom dia gente! \u2600\uFE0F lembrando como funciona o registro de tarefas aqui no canal:\n\n' +
  '*S* = inicio -- manda quando comecar uma tarefa\n' +
  '*F* = fim -- manda quando terminar\n' +
  '*P* = producao -- a quantidade de potes feita no fim\n' +
  '*N* = observacao -- qualquer coisa que aconteceu\n\n' +
  '*Formato:*\n' +
  'S: nome do suplemento numero do lote\n' +
  'F: nome do suplemento numero do lote\n' +
  'P: nome do suplemento numero do lote quantidade de potes\n' +
  'N: o que aconteceu\n\n' +
  '*Exemplo completo:*\n' +
  'S: Graviola 0124\n' +
  'F: Graviola 0124\n' +
  'P: Graviola 0124 300\n\n' +
  'Se demorou ou aconteceu algo, coloca o N separado:\n' +
  'F: Graviola 0124\n' +
  'N: demorei pq tive que fazer manutencao na maquina\n\n' +
  '*Sobre o nome:* sempre que voce nao for o dono da conta que ta usando, coloca seu nome antes de tudo -- seja no computador do Production Line, no do Vitor ou no da Simone.\n' +
  'Exemplo: Ana - S: Graviola 0124\n\n' +
  'qualquer duvida me chama aqui! \u{1F60A}';

const MORNING_GUIDE_DAYS = 5; // Send for this many weekdays then stop

/**
 * Runs once between 08:00-08:59 ET on weekdays.
 * Sends a friendly guide for the first MORNING_GUIDE_DAYS weekdays, then a short nudge.
 */
async function checkMorningReminder() {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
  if (hour < 8 || hour >= 9) return; // Only fire in the 08:xx window

  const day = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  if (day === 'Sat' || day === 'Sun') return; // Skip weekends

  const today = todayEt();
  const key = 'morning_reminder_' + today;

  const already = await db.query('SELECT value FROM app_state WHERE key = $1', [key]);
  if (already.rows.length > 0) return;

  // Don't send if bom dia was already sent today (poller handles that)
  const bomDia = await db.query('SELECT value FROM app_state WHERE key = $1', ['bom_dia_' + today]);
  if (bomDia.rows.length > 0) return;

  // Check how many times guide has been sent
  const countRes = await db.query('SELECT value FROM app_state WHERE key = $1', ['morning_guide_count']);
  const guideCount = countRes.rows.length > 0 ? parseInt(countRes.rows[0].value) || 0 : 0;

  if (guideCount < MORNING_GUIDE_DAYS) {
    await slackClient.postMessage(MORNING_GUIDE_MSG);
    const newCount = guideCount + 1;
    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('morning_guide_count', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [String(newCount)]
    );
    console.log(`[EOD] Morning guide sent (day ${newCount}/${MORNING_GUIDE_DAYS})`);
  } else {
    console.log('[EOD] Morning guide already sent for all guide days, skipping');
  }

  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, 'sent', NOW())
     ON CONFLICT (key) DO NOTHING`,
    [key]
  );
}
module.exports.checkMorningReminder = checkMorningReminder;

// ─── 6 PM production total reminder ──────────────────────────────────────────

const TOTAL_REMINDER_VARIANTS = [
  'gente, preciso da quantidade total de bottles de hoje! por favor envie nesse formato:\n*Seu nome - suplemento (batch) - quantidade total*\npra eu conseguir anotar, obrigada',
  'oi pessoal! ainda nao recebi o total de producao do dia. me mandem assim:\n*Nome - suplemento (lote) - quantidade de bottles*\npra eu registrar aqui',
  'galera, me falta o total de hoje ainda! pode mandar assim:\n*Nome - suplemento (batch) - quantidade*\nqualquer ordem ta bom, so preciso desses tres dados',
  'oi! preciso do total de production de hoje. formato:\n*Seu nome - suplemento (batch) - quantidade total*\nobrigada!',
];

/**
 * Runs once between 18:00-18:59 ET.
 * If no production summary was received today, sends a reminder asking for the total.
 */
async function checkSixPmReminder() {
  const hour = nowEtHour();
  if (hour < 18 || hour >= 19) return; // Only fire in the 18:xx window

  const today = todayEt();
  const reminderKey = `prod_reminder_${today}`;

  // Already sent today?
  const already = await db.query('SELECT value FROM app_state WHERE key = $1', [reminderKey]);
  if (already.rows.length > 0) return;

  // Already got a production summary?
  const summaryKey = `prod_summary_${today}`;
  const summaryRecv = await db.query('SELECT value FROM app_state WHERE key = $1', [summaryKey]);
  if (summaryRecv.rows.length > 0) return; // they already sent it, no need to ask

  await slackClient.postMessage(pick(TOTAL_REMINDER_VARIANTS));

  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, 'sent', NOW())
     ON CONFLICT (key) DO NOTHING`,
    [reminderKey]
  );

  console.log('[EOD] 6pm production total reminder sent');
}
module.exports.checkSixPmReminder = checkSixPmReminder;

// ─── Cleaning duration monitor ────────────────────────────────────────────────

const CLEANING_ALERT_PROD = [
  (op, time, elapsed) => `ei ${op}, a limpeza que comecou as ${time} ja tem ${elapsed} -- tudo bem por ai? se terminou, manda o *F: limpeza*`,
  (op, time, elapsed) => `${op}, a limpeza iniciada as ${time} ta com ${elapsed} -- ainda em andamento ou esqueceu de registrar o fim?`,
  (op, time, elapsed) => `${op}, a limpeza das ${time} ja passou de ${elapsed} -- se terminou, manda F: limpeza pra eu fechar aqui`,
  (op, time, elapsed) => `oi ${op}! a limpeza das ${time} ja tem ${elapsed} -- ta tudo ok? me avisa quando fechar`,
];

const CLEANING_ALERT_ADMIN = [
  (op, time, elapsed) => `Cleaning alert -- ${op}'s cleaning session (started at ${time}) has been running for ${elapsed}. Is it taking longer than usual or did someone forget to close it?`,
  (op, time, elapsed) => `*Cleaning alert* -- ${op} started a cleaning at ${time} and it's been ${elapsed}. Please check in.`,
  (op, time, elapsed) => `Warning: ${op}'s cleaning session (${time}) has been open for ${elapsed} -- is everything ok over there?`,
  (op, time, elapsed) => `*Heads up* -- ${op} has had a cleaning session open since ${time} (${elapsed} ago). Worth checking.`,
];

async function checkCleaningDuration() {
  const res = await db.query(
    `SELECT id, operator, started_at FROM tasks
     WHERE status = 'open' AND task_type = 'limpeza'
     ORDER BY started_at ASC`
  );

  for (const task of res.rows) {
    const elapsedMs = Date.now() - new Date(task.started_at).getTime();
    if (elapsedMs < 60 * 60 * 1000) continue; // < 60 min, skip

    const alertKey = `cleaning_alert_${task.id}`;
    const already  = await db.query('SELECT value FROM app_state WHERE key = $1', [alertKey]);
    if (already.rows.length > 0) continue; // already alerted for this task

    const op      = task.operator || 'alguem';
    const time    = fmtTime(task.started_at);
    const elapsed = fmtElapsed(task.started_at);

    // Alert in production channel
    await slackClient.postMessage(pick(CLEANING_ALERT_PROD)(op, time, elapsed));

    // Alert in admin channel
    await notifyAdmin(pick(CLEANING_ALERT_ADMIN)(op, time, elapsed));

    // Mark alert sent so it doesn't repeat
    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, 'sent', NOW())
       ON CONFLICT (key) DO NOTHING`,
      [alertKey]
    );

    console.log(`[EOD] Cleaning alert sent for task #${task.id}: ${op}, ${elapsed}`);
  }
}
module.exports.checkCleaningDuration = checkCleaningDuration;
