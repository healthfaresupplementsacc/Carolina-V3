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

// BLOCO C — agentic tool-use loop. Carolina decides when to call a tool.
// Read tools run freely; mutation tools execute (an admin order in the
// chat IS the explicit confirmation — Part 5); dismiss/retro answer
// pending questions. Manual loop with a hard iteration cap (anti-loop).
const ADMIN_TASK_PROMPT_TAIL = `
FERRAMENTAS: você tem ferramentas pra ler o estado (get_state,
get_operator_timeline, search_messages, list_proposals) e pra AGIR quando
o admin te mandar (close_phase, approve_adhoc, approve_supplement, rename,
merge_tasks, move_operator, create_workflow). Há também
dismiss_pending_question (quando mandarem "ignora/esquece/deixa" e houver
pergunta pendente) e update_break_retroactive (quando passarem um horário
pra uma pergunta de break).

REGRAS:
- Ordem direta clara do admin ("fecha a fase #5", "renomeia #10 pra X")
  = confirmação explícita: chama a ferramenta e confirma o que fez.
- Ordem AMBÍGUA ("fecha essa" com várias fases abertas): NÃO chama
  ferramenta — pergunta qual, pedindo número ou descrição.
- Pergunta/análise: usa as read tools e responde, sem agir.
- Depois de executar, confirma curto: "Fechei a fase #5 (X), durou 1h45."
- Nunca inventa id. Se não souber, pergunta ou usa get_state/search.
- COEXISTÊNCIA: se o bloco PENDÊNCIAS indicar que tem pergunta esperando
  e o admin falar de OUTRA coisa (pergunta, ordem), você atende
  normalmente E no fim acrescenta UMA linha curta lembrando da pendência
  (ex: "(ah, e ainda tô esperando o horário do break do Bruno — ou manda
  'ignora')"). Não repita a pergunta inteira; não trave a conversa nela.
- Se o admin claramente quer descartar a pendência ("ignora", "esquece",
  "fecha essa", "deixa", "cancela", "para com isso", "deleta"), chama
  dismiss_pending_question. Se passar um horário, chama
  update_break_retroactive.`;

async function askClaude(userMessage, senderName, productionContext, deps = {}) {
  const anthropic = deps.anthropic || getAnthropic();
  const adminTools = deps.adminTools || require('../ai/admin-tools');
  const { withPersona } = require('../ai/persona');

  const systemText = withPersona(`Você responde no canal dos gerentes (admin) e nas DMs do Bruno Camp e do Thassio. O que eles pedirem, você faz — eles mandam.

Estilo:
- Português carioca informal mas profissional. "tá", "né", "cara", "olha", "ó" — natural, sem forçar.
- Frases curtas. Sem enrolação. Sem "claro!", "com certeza!", "ótimo!".
- Quando a coisa tá errada ou atrasada, fala com firmeza.
- Máximo 1 emoji por mensagem. Nunca pergunta mais de uma coisa por mensagem.

Você conhece o time: Ana, Vitor, Simone, Bruno (trabalhador), e os donos Bruno Camp e Thassio.

Estado atual da linha de produção:
${productionContext}

Se pedirem algo que não dá pra fazer (mexer em arquivo, rodar código), fala que precisa ser feito no Claude Code.${ADMIN_TASK_PROMPT_TAIL}`, 'admin');

  // Prompt caching: stable persona+context as a single cached system
  // block (tools render before it and are deterministic, so the whole
  // prefix caches across the admin's rapid follow-ups).
  const system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: `${senderName}: ${userMessage}` }];
  const MAX_ITERS = 4;
  let finalText = '';

  for (let i = 0; i < MAX_ITERS; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system,
      tools: adminTools.TOOL_DEFS,
      messages,
    });
    const blocks = response.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) finalText = text;
    if (response.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      let out; let isErr = false;
      try {
        out = await adminTools.runTool(b.name, b.input || {}, deps);
      } catch (e) {
        out = { error: e.message }; isErr = true;
      }
      results.push({
        type: 'tool_result', tool_use_id: b.id,
        content: JSON.stringify(out).slice(0, 3000), is_error: isErr,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return finalText || 'não entendi, pode repetir?';
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
      let reply;
      // A1 — retro-break: ONLY intercept when the message is essentially
      // a time answer ("14:30"). Any other message (questions, "fecha
      // essa", "ignora", orders) must NOT be swallowed/repeated here —
      // it falls through to the dismiss pre-parse + the tool-use loop,
      // which sees the pending question in context. Bugfix for use-case 3.
      const btr = require('../workflow/break-time-reply');
      if (btr.looksLikeTimeReply(msg.text)) {
        const retro = await btr.handleAdminRetroReply(msg.text);
        if (retro.handled && retro.outcome === 'created') {
          await require('../workflow/announce').retroBreakDone({
            operatorName: retro.operatorName, when: retro.when });
          continue; // retroBreakDone already posted to admin
        }
        if (retro.handled && retro.outcome === 'ignored') {
          await slack.chat.postMessage({ channel: config.slack.managerChannelId,
            text: `Ok, deixei o break de ${retro.operatorName} como não-rastreado.`, username: 'Carolina' });
          continue;
        }
        // 'unparsed' (rare, since we gated on looksLikeTimeReply) or
        // not handled → do NOT repeat the question; fall through.
      }
      // W6 — if a propose-then-confirm action is pending, the admin's
      // reply (sim/não/ajuste) resolves it before normal chat.
      const adminTools = require('../ai/admin-tools');
      const pending = await adminTools.getProposal();
      if (pending) {
        const r = await adminTools.resolveProposal(msg.text);
        // P3 — keep the carolina_proposals ledger in sync when a
        // cron-mirrored proposal is accepted/rejected.
        if (r.handled && (r.outcome === 'executed' || r.outcome === 'cancelled')) {
          try {
            const proposals = require('../ai/proposals');
            const status = r.outcome === 'executed' ? 'accepted' : 'rejected';
            if (pending.carolina_proposal_id) await proposals.resolve(pending.carolina_proposal_id, status, 'slack_admin');
            else await proposals.resolveLatest(status, 'slack_admin');
          } catch (_) {}
        }
        if (r.handled && r.outcome === 'executed') {
          reply = `Feito ✅ (${r.kind}). ${JSON.stringify(r.result).slice(0, 180)}`;
        } else if (r.handled && r.outcome === 'cancelled') {
          reply = 'Beleza, deixei pra lá então.';
        } else if (r.handled && r.outcome === 'error') {
          reply = `Tentei mas deu ruim: ${r.error}. Não executei.`;
        } else if (r.handled && r.outcome === 'adjust') {
          // keep context, let the normal chat re-reason with the adjustment
          reply = await askClaude(
            `[ajuste à proposta pendente "${pending.kind}"]: ${msg.text}`,
            senderName, productionContext);
        }
      }
      // P2 — deterministic direct-order pre-parse: "ignora / esquece /
      // deixa pra lá" with something pending → dismiss, no LLM round-trip.
      if (reply === undefined) {
        const direct = await adminTools.interpretDirectOrder(msg.text);
        if (direct.handled) reply = direct.reply;
      }
      if (reply === undefined) {
        // P2 — give the loop awareness of what's pending so it routes
        // "fecha essa" / ambiguity correctly.
        let ctxFull = productionContext;
        try { ctxFull += '\n\n' + (await adminTools.pendingContextLine()); } catch (_) {}
        reply = await askClaude(msg.text, senderName, ctxFull);
      }
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

module.exports = { pollBossDMs, pollManagerChannel, askClaude, getProductionContext };
