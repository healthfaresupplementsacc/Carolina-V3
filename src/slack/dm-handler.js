'use strict';
/**
 * DM Handler — lets Bruno and Thassio talk to Carolina via Slack DMs.
 * Reads new DMs, calls Claude API with production context, responds as Carolina.
 */

const config = require('../config');
const db = require('../db');

const BOSS_IDS = [config.slack.brunoUserId, config.slack.thassioUserId].filter(Boolean);
const STATE_KEY_PREFIX = 'dm_last_ts_';

let WebClient;
let Anthropic;

function getSlackClient() {
  if (!WebClient) ({ WebClient } = require('@slack/web-api'));
  return new WebClient(config.slack.token);
}

function getAnthropic() {
  if (!Anthropic) {
    const sdk = require('@anthropic-ai/sdk');
    Anthropic = sdk.default || sdk;
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Fetch current production context for Claude's system prompt.
 */
async function getProductionContext() {
  try {
    const [openRes, todayRes, opsRes] = await Promise.all([
      db.query(`
        SELECT supplement_name, operator, batch_number, started_at,
          EXTRACT(EPOCH FROM (NOW() - started_at))::int as elapsed_seconds
        FROM tasks WHERE status = 'open' ORDER BY started_at ASC
      `),
      db.query(`
        SELECT t.supplement_name, t.operator, t.closed_by, t.batch_number,
          t.active_duration_seconds, t.started_at, t.ended_at, pc.count as bottles
        FROM tasks t
        LEFT JOIN production_counts pc ON pc.task_id = t.id
        WHERE (t.started_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date
          AND t.status = 'closed'
        ORDER BY t.ended_at DESC
      `),
      db.query(`
        SELECT name,
          (SELECT COUNT(*) FROM tasks WHERE operator = o.name
            AND (started_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date
            AND status = 'closed') as tasks_today,
          (SELECT COALESCE(SUM(pc.count),0) FROM production_counts pc
            JOIN tasks t ON t.id = pc.task_id WHERE t.operator = o.name
            AND (pc.reported_at AT TIME ZONE 'America/New_York')::date = (NOW() AT TIME ZONE 'America/New_York')::date) as bottles_today
        FROM operators o WHERE active = true ORDER BY name
      `),
    ]);

    const fmt = (s) => {
      if (!s) return '--';
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}h${String(m).padStart(2,'0')}m` : `${m}m`;
    };
    const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '--';

    let ctx = `=== CONTEXTO DA LINHA DE PRODUCAO (${new Date().toLocaleString('pt-BR', { timeZone: 'America/New_York' })}) ===\n\n`;

    ctx += `TAREFAS EM ANDAMENTO (${openRes.rows.length}):\n`;
    if (openRes.rows.length === 0) ctx += '  Nenhuma\n';
    openRes.rows.forEach(t => {
      ctx += `  - ${t.supplement_name || '?'} (${t.batch_number || '?'}) • ${t.operator || '?'} • há ${fmt(t.elapsed_seconds)}\n`;
    });

    ctx += `\nTAREFAS FINALIZADAS HOJE (${todayRes.rows.length}):\n`;
    if (todayRes.rows.length === 0) ctx += '  Nenhuma\n';
    todayRes.rows.forEach(t => {
      ctx += `  - ${t.supplement_name || '?'} (${t.batch_number || '?'}) • Abriu: ${t.operator || '?'} ${fmtTime(t.started_at)} → Fechou: ${t.closed_by || t.operator || '?'} ${fmtTime(t.ended_at)} • Duração: ${fmt(t.active_duration_seconds)} • Garrafas: ${t.bottles || '—'}\n`;
    });

    ctx += `\nOPERADORES HOJE:\n`;
    opsRes.rows.forEach(op => {
      ctx += `  - ${op.name}: ${op.tasks_today} tarefa(s), ${op.bottles_today} garrafas\n`;
    });

    return ctx;
  } catch (err) {
    return `[Erro ao buscar contexto: ${err.message}]`;
  }
}

/**
 * Call Claude and get a response as Carolina.
 */
async function askClaude(userMessage, senderName, productionContext) {
  const anthropic = getAnthropic();

  const systemPrompt = `Você é a Carolina, assistente da linha de produção da HealthFare Clinic. Carioca, profissional e séria — mas não é robô. De vez em quando solta uma gracinha, mas quando precisa chamar atenção ela não tem papas na língua: vai direto ao ponto, sem rodeio e sem frescura.

Você responde no Slack do Bruno Camp e do Thassio (donos), e também no canal dos gerentes. O que eles pedirem, você faz — eles mandam.

Estilo:
- Português carioca informal mas profissional. "tá", "né", "cara", "olha", "ó" — natural, sem forçar.
- Frases curtas. Sem enrolação. Sem "claro!", "com certeza!", "ótimo!" — isso é robô.
- Quando a coisa tá errada ou atrasada, fala com firmeza: "ó, isso tá errado", "já tá na hora de fechar essa tarefa", "alguém precisa me dar um F aí".
- Uma pitada de humor quando a situação deixa: uma ironia leve, um comentário seco — nada exagerado.
- Máximo 1 emoji por mensagem, só quando faz sentido. Nunca enfeitar à toa.
- Nunca pergunta mais de uma coisa por mensagem.

Você conhece o time: Ana, Vitor, Simone, Bruno (trabalhador), e os donos Bruno Camp e Thassio.

Estado atual da linha de produção:
${productionContext}

Use esses dados quando perguntarem sobre tarefas, operadores, ritmo ou produção do dia. Se pedirem algo que não dá pra fazer pelo Slack (mexer em arquivo, rodar código), fala que precisa ser pelo computador no Cowork.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: `${senderName}: ${userMessage}` }],
  });

  return response.content[0]?.text || 'não entendi, pode repetir?';
}

/**
 * Get last processed DM timestamp for a user.
 */
async function getLastTs(userId) {
  const res = await db.query(
    `SELECT value FROM app_state WHERE key = $1`,
    [`${STATE_KEY_PREFIX}${userId}`]
  );
  return res.rows[0]?.value || null;
}

async function setLastTs(userId, ts) {
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [`${STATE_KEY_PREFIX}${userId}`, ts]
  );
}

/**
 * Process DMs from one boss user.
 */
async function processBossDMs(userId, displayName) {
  const slack = getSlackClient();

  // Open DM channel
  const dm = await slack.conversations.open({ users: userId });
  const dmChannelId = dm.channel.id;

  const lastTs = await getLastTs(userId);
  const params = { channel: dmChannelId, limit: 10 };
  if (lastTs) params.oldest = lastTs;

  const result = await slack.conversations.history(params);
  const messages = (result.messages || [])
    .filter(m => m.user === userId && (!lastTs || parseFloat(m.ts) > parseFloat(lastTs)))
    .reverse(); // oldest first

  if (messages.length === 0) return;

  const productionContext = await getProductionContext();

  for (const msg of messages) {
    if (!msg.text || msg.text.trim() === '') continue;

    console.log(`[DM] ${displayName}: ${msg.text}`);

    try {
      const reply = await askClaude(msg.text, displayName, productionContext);
      await slack.chat.postMessage({
        channel: dmChannelId,
        text: reply,
        username: 'Carolina',
      });
      console.log(`[DM] Respondeu ${displayName}: ${reply.substring(0, 80)}`);
    } catch (err) {
      console.error(`[DM] Erro ao responder ${displayName}:`, err.message);
    }

    await setLastTs(userId, msg.ts);
  }

  // Update to latest ts even if no messages
  if (messages.length > 0) {
    await setLastTs(userId, messages[messages.length - 1].ts);
  }
}

/**
 * Main poll — check DMs from all bosses.
 */
async function pollBossDMs() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[DM] ANTHROPIC_API_KEY not set, skipping DM poll');
    return;
  }
  if (!config.slack.token) return;

  const bosses = [
    { id: config.slack.brunoUserId, name: 'Bruno' },
    { id: config.slack.thassioUserId, name: 'Thassio' },
  ].filter(b => b.id);

  for (const boss of bosses) {
    try {
      await processBossDMs(boss.id, boss.name);
    } catch (err) {
      console.error(`[DM] Erro ao processar DMs de ${boss.name}:`, err.message);
    }
  }
}

/**
 * Resolve a Slack user ID to a display name.
 */
async function resolveSlackName(slack, userId) {
  try {
    const res = await slack.users.info({ user: userId });
    return res.user?.real_name || res.user?.profile?.display_name || res.user?.name || userId;
  } catch {
    return userId;
  }
}

/**
 * Poll the private manager channel (#bryce-managers) and reply to every new message.
 * Bruno, Thassio, and Henrique can ask anything — Carolina responds with live production data.
 */
async function pollManagerChannel() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  if (!config.slack.managerChannelId || !config.slack.token) return;

  const slack = getSlackClient();
  const STATE_KEY = 'manager_channel_last_ts';

  // Get last processed timestamp
  const lastTsRes = await db.query(
    `SELECT value FROM app_state WHERE key = $1`,
    [STATE_KEY]
  );
  const lastTs = lastTsRes.rows[0]?.value || null;

  const params = { channel: config.slack.managerChannelId, limit: 20 };
  if (lastTs) params.oldest = lastTs;

  const result = await slack.conversations.history(params);
  const messages = (result.messages || [])
    .filter(m => !m.bot_id && !m.subtype && m.text && m.text.trim() &&
                 (!lastTs || parseFloat(m.ts) > parseFloat(lastTs)))
    .reverse(); // oldest first

  if (messages.length === 0) return;

  const productionContext = await getProductionContext();

  for (const msg of messages) {
    const senderName = await resolveSlackName(slack, msg.user);
    console.log(`[Manager] ${senderName}: ${msg.text.substring(0, 80)}`);

    try {
      const reply = await askClaude(msg.text, senderName, productionContext);
      await slack.chat.postMessage({
        channel: config.slack.managerChannelId,
        text: reply,
        username: 'Carolina',
      });
      console.log(`[Manager] Replied to ${senderName}`);
    } catch (err) {
      console.error(`[Manager] Error replying to ${senderName}:`, err.message);
    }
  }

  // Save latest timestamp
  const newLastTs = messages[messages.length - 1].ts;
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [STATE_KEY, newLastTs]
  );
}

module.exports = { pollBossDMs, pollManagerChannel };
