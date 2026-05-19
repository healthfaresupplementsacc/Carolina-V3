'use strict';
/**
 * DM Handler — lets Bruno and Thassio talk to Carolina via Slack DMs.
 * Reads new DMs, calls Claude API with production context, responds as Carolina.
 */

const config = require('../config');
const db = require('../db');

const BOSS_IDS = [config.slack.brunoUserId, config.slack.thassioUserId].filter(Boolean);
const STATE_KEY_PREFIX = 'dm_last_ts_';

// ── Conversation memory (manager channel) ─────────────────────────────
// Carries the tool-use transcript (incl. get_state results) across the
// admin's consecutive messages, so "fecha o que está aberto" can be
// resolved from the get_state Carolina just ran. Bounded + freshness-
// gated so stale state never resurfaces.
const MGR_HISTORY_KEY = 'manager_chat_history';
const HISTORY_FRESH_MS = 30 * 60 * 1000; // 30 min
const HISTORY_MAX_TURNS = 6;             // last N real admin exchanges

// Trim at REAL-user (string content) boundaries only — never split a
// tool_use/tool_result pair or start the slice on an orphan tool_use.
function trimHistory(messages, maxTurns = HISTORY_MAX_TURNS) {
  if (!Array.isArray(messages)) return [];
  const userIdx = [];
  messages.forEach((m, i) => {
    if (m && m.role === 'user' && typeof m.content === 'string') userIdx.push(i);
  });
  if (userIdx.length <= maxTurns) return messages.slice();
  return messages.slice(userIdx[userIdx.length - maxTurns]);
}

async function loadManagerHistory() {
  try {
    const r = await db.query(`SELECT value FROM app_state WHERE key = $1`, [MGR_HISTORY_KEY]);
    if (!r.rows[0]) return [];
    const parsed = JSON.parse(r.rows[0].value);
    if (!parsed || !parsed.ts || (Date.now() - parsed.ts) > HISTORY_FRESH_MS) return [];
    return trimHistory(parsed.messages || []);
  } catch (_) { return []; }
}

async function saveManagerHistory(messages) {
  try {
    const trimmed = trimHistory(messages);
    await db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [MGR_HISTORY_KEY, JSON.stringify({ ts: Date.now(), messages: trimmed })]
    );
  } catch (_) { /* memory is best-effort */ }
}

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
    // BUG AMPM — Carolina repeats these times verbatim; render them in
    // the admin's chosen format (12h AM/PM default) so she never says
    // "marcou 17:24" when the floor talks in "5:24 PM".
    const { formatTime } = require('../utils/time');
    const _tf = await require('../app-state').getTimeFormat();
    const fmtTime = (ts) => formatTime(ts, { format: _tf, empty: '--' });

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
  update_break_retroactive.

FUSO HORÁRIO: a fábrica fica na Flórida. TODOS os horários — os que
você recebe das tools e os que você fala — estão em horário do leste
dos EUA (ET, America/New_York), já convertidos. NUNCA mencione "UTC",
nunca mencione "Brasília"/"Brasil", nunca faça conversão de fuso. Se um
horário chega como "2026-05-16 09:41" isso JÁ é 09:41 ET. Ao FALAR
horário pro pessoal use 12h AM/PM (o jeito da fábrica na Flórida): diga
"9:41 AM" / "5:24 PM", não "09:41" / "17:24" (a não ser que o admin
peça 24h).

MEMÓRIA: você TEM o histórico recente desta conversa, incluindo os
RESULTADOS das tools que você já chamou (ex: o get_state com a lista de
fases abertas: cada uma com id e nome). USE esse histórico — não peça de
novo o que você acabou de ver.

RESOLUÇÃO DE REFERÊNCIA: ordens vagas como "fecha o que está aberto",
"fecha a fase aberta", "fecha essa", "encerra a fase que tá rolando",
"aquela", "a que tá aberta" referem-se ao que está no get_state mais
recente do histórico. Procedimento:
- Se NÃO tem um get_state recente no histórico (ou pode estar
  desatualizado), chama get_state primeiro.
- Olha a lista 'phases' (e 'adhoc'/'workflows' quando fizer sentido):
  • Exatamente 1 que casa → chama close_phase com o id dela e confirma
    ("Fechei a fase #5 Encapsulação."). NÃO peça o id ao admin.
  • Várias → lista curtinha (id + nome) e pergunta qual.
  • Zero → diz que não tem fase aberta agora.

OPERADOR ESPECÍFICO (regra dura — não pule):
Toda vez que a pergunta for sobre UM operador citado pelo nome ("que
horas a Simone marcou o break", "o que o Vitor fez hoje", "quando a Ana
voltou") você SEMPRE chama get_operator_timeline com operator = o NOME
citado ANTES de responder. NUNCA infira horário/atividade de operador a
partir de get_state, do CONTEXTO ou de listas gerais — essas são
agregadas, podem ter linhas duplicadas e misturar operadores (foi assim
que você já respondeu o horário do Vitor quando perguntaram da Simone).
- get_operator_timeline retorna { operator, operator_id, entries }: só
  responda usando 'entries' e confirme o nome em 'operator'. Se
  found=false (nome não encontrado), pergunte o nome ao admin — não chute.
- Pra "quem está em break agora" use a lista 'breaks' do get_state (tem
  nome + horário). Pra o horário do break DE alguém, sempre a timeline.
- Pra breaks do dia / "quem ficou muito tempo" use get_breaks_today.

BREAK COM DURAÇÃO SUSPEITA (não recite como fato):
As tools marcam duration_suspicious=true / has_suspicious=true em break
acima de 90min. Break de 3-5h é impossível — o operador esqueceu de
marcar "Voltei". Quando listar/responder e houver suspeito, NÃO entregue
os horários como se fossem normais: aponte. Ex: "olha, esses breaks de
3-5h não fazem sentido — provavelmente alguém esqueceu de marcar Voltei
na hora certa. Quer que eu corrija o horário ou descarte essa entry?".
Ofereça as duas ações (corrigir manualmente OU descartar a entry).

POSTAR NO CANAL (você TEM essa capacidade):
Quando o admin (Bruno, Thassio, Henrique) pedir pra você mandar/avisar/
postar/escrever/pedir desculpas "lá no canal" / "na produção", USE a
tool post_to_production_channel. NUNCA recuse. NUNCA diga "não tenho
acesso", "não consigo postar", "só consigo ler lá" — isso é MENTIRA,
você posta saudação, EOD e anúncios todo dia pelo mesmo caminho.
- Escreva a mensagem na SUA voz humana (você é a Carolina da produção);
  não revele que foi o admin que pediu.
- Depois confirma curto: "Mandei lá." — ou, se a tool voltar silent,
  "Mandei (modo silencioso, foi pro log)."

HIERARQUIA (saiba quem manda — não precisa anunciar):
- Bruno Camp e Thassio são os OWNERS (donos). Henrique Monteiro é o
  MANAGER. Os demais (Ana, Vitor, Simone) são operadores.
- Ordem de owner ou manager: você OBEDECE, sem questionar e sem pedir
  confirmação extra (a ordem já é a confirmação).
- Trate todos pelo NOME próprio (Bruno, Thassio, Henrique). NUNCA
  use "presidente", "chefe", "patrão" como vocativo — Bruno NÃO é
  "presidente".
- Não mencione a hierarquia espontaneamente; só use esse conhecimento
  pra saber de quem aceitar ordem.

SUAS CAPACIDADES (você TEM estas ferramentas — use-as):
- Postar no canal de produção: post_to_production_channel
- Fechar fase: close_phase
- Fechar break ativo: close_active_break (um operador) /
  close_all_active_breaks (todos)
- Aprovar avulsa/suplemento, renomear, mesclar, mover operador,
  criar workflow: approve_adhoc, approve_supplement, rename,
  merge_tasks, move_operator, create_workflow
- Ler estado/timeline/breaks: get_state, get_operator_timeline,
  get_breaks_today, search_messages

PROIBIDO MENTIR SOBRE CAPACIDADE:
NUNCA diga "não tenho ferramenta", "não consigo", "só leio", "não
escrevi nada" sobre algo que está na lista de tools acima. Antes de
recusar, VERIFIQUE suas tools. Se existe tool pro que pediram, USE.
Só peça esclarecimento se realmente não houver tool — e aí pergunte
o que falta, sem alegar incapacidade.

COMBO DE AÇÕES (execute tudo antes de responder):
Quando o admin pede várias coisas numa ordem ("fecha o break dos 2 E
anuncia no chat que fechei"), execute TODAS as ferramentas em sequência
ANTES de responder. NÃO pergunte "quer que eu faça?" — é ordem, então
faz. Só depois confirma o conjunto, curto e específico: "Fechei os 2
breaks (Simone 5:24 PM, Vitor 6:29 PM) e mandei o anúncio lá."

GESTÃO DE FUNCIONÁRIOS:
- Admin pede pra adicionar/contratar/criar funcionário novo → use
  create_operator. ANTES de criar, PERGUNTE: é permanente ou helper
  temporário? Se helper, qual a data fim (default 30 dias). Só chame a
  tool depois de saber. Ex: "Contrata o João" → "Permanente ou helper
  temporário?" → "permanente, operator" → create_operator(name:"João").
- Admin diz que alguém saiu da empresa / pra remover/desligar →
  deactivate_operator. NUNCA delete físico — só desativa pra preservar
  o histórico (timeline, breaks antigos). Confirma: "Desativei o Pedro,
  histórico preservado."
- Voltou à empresa → reactivate_operator. Helper que virou fixo →
  promote_helper.

ATIVIDADE PARADA (auto-check de hora em hora):
Um cron horário detecta fase/ad-hoc aberta há +1h SEM nenhum oal do
operador responsável e te faz uma pergunta no canal admin ("X tá em Y
há +1h sem atividade... sim / fechar / pausa"). NÃO aja sozinha —
espere a resposta do admin. Quando o admin responder, chame
resolve_activity_check:
- "sim"/"ok"/"tá"/"continua" → action="keep" (mantém aberto; não
  repergunta por 2h)
- "fechar"/"encerra" → action="close" (fecha no horário do último oal)
- "pausa"/"break" → action="break" (break retroativo desde o último oal)
Se o bloco PENDÊNCIAS indicar verificação de atividade aguardando e o
admin ainda não respondeu, lembre-o (o cron já repergunta de hora em
hora; não invente nem feche por conta própria).`;

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

Você conhece o time: Ana, Vitor, Simone (operadores), Henrique Monteiro (manager) e os donos Bruno Camp e Thassio.

Estado atual da linha de produção:
${productionContext}

Se pedirem algo que não dá pra fazer (mexer em arquivo, rodar código), fala que precisa ser feito no Claude Code.${ADMIN_TASK_PROMPT_TAIL}`, 'admin');

  // Prompt caching: stable persona+context as a single cached system
  // block (tools render before it and are deterministic, so the whole
  // prefix caches across the admin's rapid follow-ups).
  const system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
  // Prior transcript (tool results included) so references like "fecha
  // o aberto" resolve from the get_state Carolina just ran.
  const prior = Array.isArray(deps.history) ? deps.history.slice() : [];
  const messages = [...prior, { role: 'user', content: `${senderName}: ${userMessage}` }];
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
    if (response.stop_reason !== 'tool_use') {
      messages.push({ role: 'assistant', content: blocks }); // close transcript
      break;
    }

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

  // Keep the transcript valid for the next turn (must not end on a
  // dangling tool_result user turn after MAX_ITERS).
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && Array.isArray(last.content)) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: finalText || '...' }] });
  }

  if (typeof deps.saveHistory === 'function') {
    try { await deps.saveHistory(messages); } catch (_) {}
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

// FASE 1 P7 — persist an admin-chat message into `messages` (same
// schema as the production channel). parsed_type='admin_chat' marks it
// as NON-production: the production poller never reads this channel, so
// these rows can never trigger the canonical/legacy production
// dispatcher. They exist for the audit trail + user-id discovery.
async function persistAdminMessage(msg, senderName) {
  await db.query(
    `INSERT INTO messages (slack_ts, channel_id, user_id, user_name, text, raw_json, parsed_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'admin_chat')
     ON CONFLICT (slack_ts) DO NOTHING`,
    [String(msg.ts), config.slack.managerChannelId, msg.user || null,
     senderName || msg.user || null, msg.text || null, JSON.stringify(msg)]
  );
}

// FASE 1 P7.3 — when an admin posts in the admin chat and their Slack
// user id isn't registered against ANY operator, but exactly one active
// operator with a NULL slack_user_id matches their name, adopt it.
// Conservative (single unambiguous match), audited.
async function autodiscoverSlackId(slack, msg, senderName) {
  if (!msg.user || msg.bot_id) return;
  const taken = await db.query(
    `SELECT 1 FROM operators WHERE slack_user_id = $1 LIMIT 1`, [msg.user]);
  if (taken.rows.length) return; // id already mapped — nothing to do
  const name = senderName || (await resolveSlackName(slack, msg.user));
  const first = String(name || '').trim().split(/\s+/)[0];
  if (!first) return;
  const cand = await db.query(
    `SELECT id, name FROM operators
      WHERE slack_user_id IS NULL AND (active = TRUE OR is_active = TRUE)
        AND ( LOWER(name) = LOWER($1)
           OR LOWER(name) LIKE LOWER($2) || ' %'
           OR LOWER(name) = LOWER($2) )`,
    [name, first]);
  if (cand.rows.length !== 1) return; // ambiguous or none → never guess
  const op = cand.rows[0];
  await db.query(
    `UPDATE operators SET slack_user_id = $1, updated_at = NOW() WHERE id = $2`,
    [msg.user, op.id]);
  try {
    const { auditAction } = require('../admin/audit');
    await auditAction({
      action: 'operator.update_slack_user_id', entityType: 'operator',
      entityId: op.id, source: 'admin_chat_autodiscover',
      before: { name: op.name, slack_user_id: null },
      after: { slack_user_id: msg.user, via: 'admin_chat_post', resolved_name: name },
    });
  } catch (_) { /* audit best-effort */ }
  console.log(`[Manager] auto-discovered slack_user_id ${msg.user} → operator "${op.name}" (#${op.id})`);
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

    // FASE 1 P7 — persist the admin-chat message to `messages` (audit +
    // future user-id discovery). These rows NEVER trigger the production
    // dispatcher (only the production-channel poller does), they're for
    // Carolina to interpret + the audit trail.
    try { await persistAdminMessage(msg, senderName); } catch (e) {
      console.error('[Manager] persist error:', e.message);
    }
    // P7.3 — auto-discover slack_user_id of any admin who posts here when
    // their operator row still has NULL (resolves the Bruno-Camp-style
    // pending generically).
    try { await autodiscoverSlackId(slack, msg, senderName); } catch (e) {
      console.error('[Manager] autodiscover error:', e.message);
    }

    try {
      let reply;
      // Conversation memory: prior tool-use transcript (get_state etc.)
      // so the loop can resolve "fecha o aberto" from what it just saw.
      const chatDeps = { history: await loadManagerHistory(), saveHistory: saveManagerHistory };
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
            senderName, productionContext, chatDeps);
        }
      }
      // FASE 1 P7/P6 — the admin's reply may be the answer to a
      // pending disambiguation ("foi a Ana"). Resolve it: re-dispatch
      // the parked event WITH the operator (creates the real ISA-88 row
      // + updates dispatcher_index) before falling to the normal loop.
      if (reply === undefined) {
        try {
          const adminChat = require('./admin-chat');
          const dis = await adminChat.resolveDisambiguationReply(msg.text);
          if (dis.handled) reply = dis.reply;
        } catch (e) { console.error('[Manager] disambig resolve error:', e.message); }
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
        reply = await askClaude(msg.text, senderName, ctxFull, chatDeps);
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

module.exports = {
  pollBossDMs, pollManagerChannel, askClaude, getProductionContext,
  trimHistory, loadManagerHistory, saveManagerHistory,
  persistAdminMessage, autodiscoverSlackId, resolveSlackName,
};
