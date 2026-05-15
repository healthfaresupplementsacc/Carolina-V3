'use strict';
/**
 * Task engine: processes parsed messages into S->F task pairs,
 * production counts, and triggers Slack replies when needed.
 */

const db = require('./db');
const slackClient = require('./slack/client');
const config = require('./config');
const { extractSupplement } = require('./parser');
const { isAfterSixPmEt } = require('./eod');

// ─── Message variation helpers ───────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const UNKNOWN_SUPP_MSGS = [
  (who) => `${who}qual suplemento é esse?`,
  (who) => `${who}que produto é esse que você tá fazendo?`,
  (who) => `${who}não peguei o suplemento — qual é?`,
  (who) => `${who}me diz o nome do suplemento`,
  (who) => `${who}qual é o suplemento?`,
  (who) => `${who}eita, qual suplemento é esse?`,
  (who) => `${who}que suplemento você iniciou?`,
  (who) => `${who}não reconheci — qual produto é esse?`,
  (who) => `${who}qual é o nome do suplemento que você tá produzindo?`,
  (who) => `${who}oi, qual suplemento é esse?`,
  (who) => `${who}perdão, qual o suplemento?`,
  (who) => `${who}não entendi o suplemento — qual é o nome?`,
  (who) => `${who}que produto é esse?`,
  (who) => `${who}e o suplemento, qual é?`,
  (who) => `${who}qual é o suplemento que você tá fazendo?`,
  (who) => `${who}não identifiquei o produto — qual é?`,
  (who) => `${who}qual suplemento é esse aí?`,
  (who) => `${who}que produto você iniciou?`,
  (who) => `${who}oi, qual é o suplemento?`,
  (who) => `${who}me passa o nome do suplemento`,
  (who) => `${who}não peguei o produto — qual é o nome?`,
  (who) => `${who}qual produto você tá produzindo?`,
  (who) => `${who}não reconheci o suplemento — me diz qual é`,
  (who) => `${who}qual o nome do produto?`,
  (who) => `${who}não captei o suplemento — pode repetir?`,
  (who) => `${who}qual suplemento você começou?`,
  (who) => `${who}me diz qual é o produto`,
  (who) => `${who}oi, que produto é esse?`,
  (who) => `${who}não identifiquei — qual é o suplemento?`,
  (who) => `${who}qual produto é esse que você iniciou?`,
];

const WHO_IS_POSTING_MSGS = [
  'ei, quem tá postando? Ana ou Bruno?',
  'quem é? Ana ou Bruno?',
  'oi, você é a Ana ou o Bruno?',
  'quem tá na linha agora, Ana ou Bruno?',
  'coloca o nome antes da mensagem — Ana ou Bruno?',
  'quem tá falando aqui?',
  'Ana ou Bruno?',
  'ei, coloca seu nome aí que eu não sei quem é',
  'oi! quem tá postando por aqui?',
  'quem tá aí, Ana ou Bruno?',
  'me diz quem é, Ana ou Bruno?',
  'tô confusa — quem tá postando?',
  'ei, qual de vocês tá postando agora?',
  'me identifica aí — Ana ou Bruno?',
  'não sei quem é — Ana ou Bruno?',
  'coloca o nome antes — Ana ou Bruno?',
  'oi, quem é você aí?',
  'Ana ou Bruno, qual dos dois?',
  'quem é que tá postando?',
  'ei, se identifica — Ana ou Bruno?',
  'oi, qual de vocês é?',
  'coloca o nome que eu não reconheço — Ana ou Bruno?',
  'Ana ou Bruno, me diz',
  'ô, quem tá aqui?',
  'ei, me identifica — você é a Ana ou o Bruno?',
  'quem é você? Ana ou Bruno?',
  'coloca o nome aí — não sei quem é',
  'você é a Ana ou o Bruno?',
  'tô sem saber quem é — Ana ou Bruno?',
  'oi, antes de tudo — quem é você?',
];

const TAG_PROMPT_MSGS = [
  (who) => `${who}tá fazendo algo? manda S: [suplemento] quando começar`,
  (who) => `${who}começou alguma coisa? manda S: [suplemento] [lote] pra eu registrar`,
  (who) => `${who}não esqueça o S: quando iniciar e o F: quando terminar`,
  (who) => `${who}se começou uma produção, manda S: com o nome do suplemento`,
  (who) => `${who}pode registrar com S: [suplemento] quando iniciar`,
  (who) => `${who}manda S: [suplemento] quando começar, tá?`,
  (who) => `${who}S: pra iniciar, F: pra fechar — não esquece`,
  (who) => `${who}registra com S: quando começar`,
  (who) => `${who}começou produção? manda S: com o suplemento pra eu anotar`,
  (who) => `${who}não esqueça de registrar com S: quando iniciar`,
  (who) => `${who}pode mandar S: [suplemento] pra eu pegar aqui`,
  (who) => `${who}manda S: pra iniciar e F: pra finalizar`,
  (who) => `${who}registra aí com S: quando começar, por favor`,
  (who) => `${who}começou algo? S: [suplemento] pra iniciar`,
  (who) => `${who}não esqueça o S: quando começar`,
  (who) => `${who}iniciou alguma coisa? coloca S: [suplemento]`,
  (who) => `${who}manda S: com o nome do suplemento quando começar`,
  (who) => `${who}tá produzindo algo? não esquece o S:`,
  (who) => `${who}S: [suplemento] pra eu registrar`,
  (who) => `${who}se tiver produzindo, manda o S: pra eu anotar`,
  (who) => `${who}começou alguma produção? manda o S:`,
  (who) => `${who}não esquece: S: pra começar, F: pra fechar`,
  (who) => `${who}manda o S: com o suplemento quando iniciar`,
  (who) => `${who}registra com S: [suplemento] quando começar`,
  (who) => `${who}iniciou algo? manda S: [suplemento] pra eu pegar`,
  (who) => `${who}coloca S: [suplemento] quando começar a produção`,
  (who) => `${who}pra eu registrar, manda S: com o suplemento`,
  (who) => `${who}tá produzindo? manda S: pra eu anotar`,
  (who) => `${who}não deixa de mandar S: quando começar`,
  (who) => `${who}lembra: S: pra iniciar, F: quando terminar`,
];
// ─── Conflict / task-type messages (less carioca, professional tone) ─────────

// When operator starts new task while a DIFFERENT task is still open
const CONFIRM_CLOSE_MSGS = [
  (op, task) => `${op}, a ${task} ainda está em aberto. Já terminou?`,
  (op, task) => `${op}, a ${task} está registrada como em andamento. Terminou?`,
  (op, task) => `${op}, a ${task} está aberta ainda — já finalizou?`,
  (op, task) => `${op}, notei que a ${task} ainda está em aberto. Já concluiu?`,
  (op, task) => `${op}, a ${task} ainda aparece como ativa aqui. Terminou?`,
  (op, task) => `${op}, a ${task} não foi fechada ainda. Já concluiu?`,
  (op, task) => `${op}, a ${task} ainda está em andamento no sistema. Finalizou?`,
  (op, task) => `${op}, a ${task} continua em aberto. Terminou essa?`,
  (op, task) => `${op}, a ${task} está ativa ainda aqui. Já encerrou?`,
  (op, task) => `${op}, a ${task} segue em aberto. Já terminou?`,
  (op, task) => `${op}, não fechei a ${task} ainda. Terminou?`,
  (op, task) => `${op}, a ${task} ainda aparece aberta. Concluiu?`,
  (op, task) => `${op}, a ${task} ainda não foi encerrada. Finalizou?`,
  (op, task) => `${op}, a ${task} ainda está no ar aqui. Terminou?`,
  (op, task) => `${op}, a ${task} segue registrada como em andamento. Já terminou?`,
];

// When they confirm yes (closed old task)
const CONFIRM_CLOSE_YES_MSGS = [
  (task) => `Fechei a ${task}. Pode continuar.`,
  (task) => `Ok, registrei o encerramento da ${task}.`,
  (task) => `Fechei a ${task} agora.`,
  (task) => `Pronto, a ${task} está fechada.`,
  (task) => `Ok, encerrando a ${task}.`,
  (task) => `Registrado. A ${task} foi encerrada.`,
  (task) => `Fechei a ${task} aqui.`,
  (task) => `A ${task} está encerrada agora.`,
  (task) => `Beleza, fechei a ${task}.`,
  (task) => `Ok, ${task} encerrada.`,
];

// When they say no (old task stays open)
const CONFIRM_CLOSE_NO_MSGS = [
  (task) => `Ok, a ${task} continua em aberto.`,
  (task) => `Tudo bem, deixei a ${task} aberta.`,
  (task) => `Entendido, a ${task} segue em andamento.`,
  (task) => `Ok, a ${task} ainda está ativa.`,
  (task) => `Combinado, ${task} continua em aberto.`,
];

// When someone says "revisao" without saying which supplement
const ASK_REVISAO_MSGS = [
  (who) => `${who}revisão de qual suplemento?`,
  (who) => `${who}qual suplemento está em revisão?`,
  (who) => `${who}pode informar qual suplemento está sendo revisado?`,
  (who) => `${who}revisão de qual produto?`,
  (who) => `${who}qual é o suplemento da revisão?`,
  (who) => `${who}qual produto você está revisando?`,
  (who) => `${who}para registrar a revisão, qual é o suplemento?`,
  (who) => `${who}revisando qual suplemento?`,
  (who) => `${who}qual suplemento entra na revisão?`,
  (who) => `${who}informe o suplemento em revisão, por favor.`,
];

const ASK_LABEL_MSGS = [
  (who) => `${who}qual label você está colocando?`,
  (who) => `${who}label de qual suplemento?`,
  (who) => `${who}pode me dizer qual label é esse?`,
  (who) => `${who}qual é o suplemento do label?`,
  (who) => `${who}colocando label em qual produto?`,
  (who) => `${who}qual suplemento vai receber o label?`,
  (who) => `${who}label de qual produto?`,
  (who) => `${who}me diz qual suplemento é o label`,
  (who) => `${who}label em qual suplemento?`,
  (who) => `${who}qual produto está recebendo o label?`,
];

// When someone starts "linha de producao" and there's one other open task — check if joining
const CONFIRM_JOIN_MSGS = [
  (op, partner, supp) => `${op}, você está trabalhando com ${partner} no ${supp}?`,
  (op, partner, supp) => `${op}, vai ajudar ${partner} com o ${supp}?`,
  (op, partner, supp) => `${op}, está junto com ${partner} no ${supp}?`,
  (op, partner, supp) => `${op}, você se juntou a ${partner} no ${supp}?`,
  (op, partner, supp) => `${op}, trabalho conjunto com ${partner} no ${supp}?`,
  (op, partner, supp) => `${op}, está na mesma linha que ${partner} — ${supp}?`,
  (op, partner, supp) => `${op}, vai trabalhar com ${partner} no ${supp}?`,
  (op, partner, supp) => `${op}, confirmando — você está com ${partner} no ${supp}?`,
  (op, partner, supp) => `${op}, você entrou no ${supp} junto com ${partner}?`,
  (op, partner, supp) => `${op}, está colaborando com ${partner} no ${supp}?`,
];

// Confirmation that someone was added as helper
const JOIN_YES_MSGS = [
  (op, supp) => `Registrado — ${op} e o colega estão no ${supp}.`,
  (op, supp) => `Ok, incluí ${op} no ${supp}.`,
  (op, supp) => `Certo, ${op} está junto no ${supp}.`,
  (op, supp) => `Registrado, ${op} no ${supp} com o colega.`,
  (op, supp) => `Ok, ${op} adicionado ao ${supp}.`,
];

// B8: announce automatic Linha de Produção join
const JOIN_PRODUCAO_ANNOUNCE = [
  (op, partner, supp) => `🤝 ${op} entrou na Linha de Produção do ${supp} junto com ${partner}.`,
  (op, partner, supp) => `🤝 ${op} está ajudando ${partner} na Linha de Produção do ${supp}.`,
  (op, partner, supp) => `🤝 Registrei ${op} na Linha de Produção do ${supp} com ${partner}.`,
  (op, partner, supp) => `🤝 ${op} entrou na linha junto com ${partner} — ${supp}.`,
  (op, partner, supp) => `🤝 ${op} agora também tá no ${supp} com ${partner}.`,
];
// ─────────────────────────────────────────────────────────────────────────────

// ─── Pending question helpers (stored in app_state) ───────────────────────

function pendingKey(operator) { return `pending_q_${operator}`; }

async function storePendingQuestion(operator, data) {
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h
  const value = JSON.stringify({ ...data, askedAt: new Date().toISOString(), expiresAt });
  await db.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [pendingKey(operator), value]
  );
}

async function getPendingQuestion(operator) {
  if (!operator) return null;
  const res = await db.query('SELECT value FROM app_state WHERE key = $1', [pendingKey(operator)]);
  if (!res.rows[0]?.value) return null;
  try {
    const q = JSON.parse(res.rows[0].value);
    if (new Date(q.expiresAt) < new Date()) {
      await clearPendingQuestion(operator);
      return null;
    }
    return q;
  } catch { return null; }
}

async function clearPendingQuestion(operator) {
  await db.query('DELETE FROM app_state WHERE key = $1', [pendingKey(operator)]);
}

function isAffirmative(text) {
  const t = text.toLowerCase().trim();
  return (
    /\b(?:sim|s[iíì]m?|yes|yep|já|ja|ok|tá|ta|pode|certo|claro|terminei|acabei|finalizei|pronto|conclu[ií])\b/i.test(t) ||
    /j[aá][hh]+/i.test(t) ||         // "jahh", "jaaah"
    /kb[ae][iu]/i.test(t) ||          // "kbei", "kbai"
    /\bj[aá]\s+kbei\b/i.test(t) ||   // "já kbei"
    /\bterminei\b/i.test(t) ||
    /\bacabei\b/i.test(t)
  );
}

function isNegative(text) {
  return /\b(?:n[aã]o|nope|ainda\s+n[aã]o|n[aã]o\s+ainda|ainda\s+t[oô]|n[aã]o\s+terminei|n[aã]o\s+acabei)\b/i.test(text.toLowerCase());
}

/**
 * Try to resolve a pending question using the operator's reply.
 * Returns true if the message was consumed (handled as a response to pending question).
 * Returns false if no pending question or response was unclear — process message normally.
 */
async function handlePendingResponse(operator, rawMsg) {
  const pending = await getPendingQuestion(operator);
  if (!pending) return false;

  const text = rawMsg.text || '';

  switch (pending.questionType) {
    case 'confirm_close': {
      if (isAffirmative(text)) {
        const taskLabel = pending.taskLabel || 'tarefa';
        // Close the old task at the time of this reply
        const msgTs = rawMsg.ts;
        const endedAt = new Date(parseFloat(msgTs) * 1000).toISOString();
        await db.query(
          `UPDATE tasks SET
             status = 'closed',
             ended_at = $1,
             duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int,
             active_duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - started_at))::int),
             updated_at = NOW()
           WHERE id = $2 AND status = 'open'`,
          [endedAt, pending.closingTaskId]
        );
        await clearPendingQuestion(operator);
        await slackClient.postMessage(pick(CONFIRM_CLOSE_YES_MSGS)(taskLabel));
        // Now execute the deferred start
        if (pending.pendingStart) {
          await handleStart(pending.pendingStart, rawMsg);
        }
        return true;
      }
      if (isNegative(text)) {
        const taskLabel = pending.taskLabel || 'tarefa';
        await clearPendingQuestion(operator);
        await slackClient.postMessage(pick(CONFIRM_CLOSE_NO_MSGS)(taskLabel));
        // Start new task anyway (both tasks run in parallel)
        if (pending.pendingStart) {
          await handleStart(pending.pendingStart, rawMsg);
        }
        return true;
      }
      return false;  // Unclear answer — let message process normally
    }

    case 'confirm_join': {
      if (isAffirmative(text)) {
        const { joiningTaskId, joiningTaskSupplement, joiningTaskOperator } = pending;
        // Add operator as helper to the other person's task
        const taskRes = await db.query('SELECT helpers FROM tasks WHERE id = $1', [joiningTaskId]);
        const existingHelpers = taskRes.rows[0]?.helpers || '';
        const helpers = existingHelpers
          ? existingHelpers.split(',').map(s => s.trim()).concat([operator]).filter(Boolean).join(', ')
          : operator;
        await db.query('UPDATE tasks SET helpers = $1 WHERE id = $2', [helpers, joiningTaskId]);
        await clearPendingQuestion(operator);
        await slackClient.postMessage(pick(JOIN_YES_MSGS)(operator, joiningTaskSupplement));
        return true;
      }
      if (isNegative(text)) {
        // Not joining — ask which supplement they're doing
        await clearPendingQuestion(operator);
        const who = operator ? `${operator}, ` : '';
        await slackClient.postMessage(pick(UNKNOWN_SUPP_MSGS)(who));
        return true;
      }
      return false;
    }

    case 'identify_supplement': {
      // Operator is responding to "revisão de qual suplemento?" or similar
      const supplement = extractSupplement(text);
      if (supplement) {
        await clearPendingQuestion(operator);
        const startData = { ...(pending.pendingStart || {}), operator, supplement };
        await handleStart(startData, rawMsg);
        return true;
      }
      // No supplement found — keep question alive, don't spam
      return false;
    }

    case 'identify_label': {
      const supplement = extractSupplement(text);
      if (supplement) {
        await clearPendingQuestion(operator);
        const startData = { ...(pending.pendingStart || {}), operator, supplement };
        await handleStart(startData, rawMsg);
        return true;
      }
      return false;
    }

    default:
      return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main handler called after parsing.
 */
async function handleParsed(parsed, rawMsg) {
  const { type } = parsed;

  if (parsed.needsOperatorClarification) {
    // Shared account message with no name prefix - ask who's posting
    await askWhoIsPosting();
    return;
  }

  switch (type) {
    case 'start':
      await handleStart(parsed, rawMsg);
      break;
    case 'finish':
      await handleFinish(parsed, rawMsg);
      break;
    case 'count':
      await handleCount(parsed, rawMsg);
      break;
    case 'pause_start':
      await handlePauseStart(parsed, rawMsg);
      break;
    case 'pause_end':
      await handlePauseEnd(parsed, rawMsg);
      break;
    case 'join_producao':
      await handleJoinProducao(parsed, rawMsg);
      break;
    case 'note':
      // Notes are stored but not tracked
      break;
    case 'unknown':
      // Could be a status update with no tag - prompt to use tag format
      if (!parsed.freetext && looksLikeStatusUpdate(parsed.raw)) {
        await promptForTag(parsed.operator);
      }
      break;
  }
}

/**
 * Human-readable label for a task (used in conflict messages).
 */
function taskLabel(taskType, supplementName) {
  if (taskType === 'limpeza') return 'Limpeza';
  if (taskType === 'revisao') return supplementName ? `Revisão — ${supplementName}` : 'Revisão';
  if (taskType === 'label') return supplementName ? `Label — ${supplementName}` : 'Colocando Label';
  return supplementName || 'tarefa atual';
}

/**
 * Handle S: (start) message - open a new task.
 */
async function handleStart(parsed, rawMsg) {
  const { operator, supplement, batch, description, ts } = parsed;
  const tType = parsed.taskType || null; // 'limpeza' | 'revisao' | 'producao' | null

  // Use original S: timestamp (parsed.ts) when available — critical for deferred starts
  // so the task records when the operator first started, not when they confirmed.
  const msgTs = ts || rawMsg?.ts;

  // B6: if this operator has an open break, the new activity implicitly ends it.
  if (operator && msgTs) {
    await closeOpenBreakFor(operator, new Date(parseFloat(msgTs) * 1000).toISOString(), 'auto_new_task');
  }

  // ─── Step 1: Check for any OTHER open task for this operator ────────────────
  if (operator) {
    const anyOpen = await db.query(
      `SELECT id, supplement_name, task_type FROM tasks
       WHERE status = 'open' AND operator = $1
       ORDER BY started_at DESC LIMIT 1`,
      [operator]
    );

    if (anyOpen.rows.length > 0) {
      const existing = anyOpen.rows[0];
      const existingLabel = taskLabel(existing.task_type, existing.supplement_name);
      const newLabel = taskLabel(tType, supplement);

      // Duplicate? Same label = same task, silently skip
      if (existingLabel === newLabel) {
        console.warn(`[Tasks] Duplicate S: — ${operator} already has "${existingLabel}" open, ignoring`);
        return;
      }

      // Different task → ask if they finished the old one, then defer the new start
      const who = operator ? `${operator}, ` : '';
      const msgFn = pick(CONFIRM_CLOSE_MSGS);
      try {
        await slackClient.postMessage(msgFn(who, existingLabel));
        await storePendingQuestion(operator, {
          questionType: 'confirm_close',
          closingTaskId: existing.id,
          taskLabel: existingLabel,
          pendingStart: { operator, supplement, batch, description, taskType: tType, ts: msgTs },
        });
        console.log(`[Tasks] Conflict: ${operator} has "${existingLabel}" open → deferred new start "${newLabel}"`);
      } catch (err) {
        console.error('[Tasks] Error sending conflict question:', err.message);
      }
      return; // Don't create the new task yet — wait for confirmation
    }
  }

  // ─── Step 2: Limpeza — no supplement needed ─────────────────────────────────
  if (tType === 'limpeza') {
    const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();
    await db.query(
      `INSERT INTO tasks (operator, supplement_name, batch_number, description, started_at, status, task_type, slack_start_ts)
       VALUES ($1, NULL, $2, $3, $4, 'open', 'limpeza', $5)`,
      [operator, batch, description, startedAt, msgTs]
    );
    console.log(`[Tasks] Started: ${operator} - Limpeza`);
    return;
  }

  // ─── Step 2.5: Label — requires supplement; ask if missing ────────────────────
  if (tType === 'label') {
    if (!supplement) {
      if (!isAfterSixPmEt()) {
        const who = operator ? `${operator}, ` : '';
        try {
          await slackClient.postMessage(pick(ASK_LABEL_MSGS)(who));
          await storePendingQuestion(operator, {
            questionType: 'identify_label',
            pendingStart: { operator, supplement: null, batch, description, taskType: 'label', ts: msgTs },
          });
        } catch (err) {
          console.error('[Tasks] Error asking for label supplement:', err.message);
        }
        return;
      }
      // After 6 PM: log without supplement, no question
    }
    const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();
    const desc = supplement ? `Colocando label — ${supplement}` : (description || 'Colocando label');
    await db.query(
      `INSERT INTO tasks (operator, supplement_name, batch_number, description, started_at, status, task_type, slack_start_ts)
       VALUES ($1, $2, $3, $4, $5, 'open', 'label', $6)`,
      [operator, supplement || null, batch, desc, startedAt, msgTs]
    );
    console.log(`[Tasks] Label started: ${operator} — ${supplement || '?'}`);
    return;
  }

  // ─── Step 3: Revisão — requires supplement; ask if missing (but not after 6 PM) ──
  if (tType === 'revisao' && !supplement) {
    if (!isAfterSixPmEt()) {
      const who = operator ? `${operator}, ` : '';
      try {
        await slackClient.postMessage(pick(ASK_REVISAO_MSGS)(who));
        await storePendingQuestion(operator, {
          questionType: 'identify_supplement',
          pendingStart: { operator, supplement: null, batch, description, taskType: 'revisao', ts: msgTs },
        });
      } catch (err) {
        console.error('[Tasks] Error asking for revisao supplement:', err.message);
      }
      return;
    }
    // After 6 PM: just log the revisão without supplement, no question asked
    const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();
    await db.query(
      `INSERT INTO tasks (operator, supplement_name, batch_number, description, started_at, status, task_type, slack_start_ts)
       VALUES ($1, NULL, $2, $3, $4, 'open', 'revisao', $5)`,
      [operator, batch, description, startedAt, msgTs]
    );
    console.log(`[Tasks] After-hours revisao started: ${operator} (no supplement)`);
    return;
  }

  // ─── Step 4: Producao / generic — supplement missing → check joining or ask ─
  if (!supplement) {
    // Check if exactly one other operator has an open production task → maybe joining
    const openByOthers = await db.query(
      `SELECT id, operator, supplement_name, task_type FROM tasks
       WHERE status = 'open'
         AND (task_type IS NULL OR task_type = 'producao')
         AND supplement_name IS NOT NULL
         AND ($1::text IS NULL OR operator != $1)
       ORDER BY started_at DESC`,
      [operator || null]
    );

    // After 6 PM: don't ask anything — just skip the unidentified start silently
    if (isAfterSixPmEt()) {
      console.log(`[Tasks] After-hours S: with no supplement from ${operator} — skipped (no questions after 6 PM)`);
      return;
    }

    if (openByOthers.rows.length === 1) {
      // During working hours: ask if they're joining the other person's task
      const other = openByOthers.rows[0];
      const op = operator ? `${operator}, ` : '';
      const msgFn = pick(CONFIRM_JOIN_MSGS);
      try {
        await slackClient.postMessage(msgFn(op.trim().replace(', ', ''), other.operator, other.supplement_name));
        await storePendingQuestion(operator, {
          questionType: 'confirm_join',
          joiningTaskId: other.id,
          joiningTaskSupplement: other.supplement_name,
          joiningTaskOperator: other.operator,
          pendingStart: null,
        });
      } catch (err) {
        console.error('[Tasks] Error asking about joining:', err.message);
      }
      return;
    }

    // No clear partner — ask which supplement
    const who = operator ? `${operator}, ` : '';
    try {
      await slackClient.postMessage(pick(UNKNOWN_SUPP_MSGS)(who));
      await slackClient.postToChannel(
        config.slack.managerChannelId,
        `⚠️ suplemento não reconhecido — ${operator || 'alguém'} postou S: mas eu não identifiquei o produto.\nMensagem original: "${rawMsg?.text || ''}"`
      );
    } catch (err) {
      console.error('[Tasks] Error asking for supplement name:', err.message);
    }
    return;
  }

  // ─── Step 5: Create the task ─────────────────────────────────────────────────
  const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();
  const resolvedType = tType || 'producao';

  await db.query(
    `INSERT INTO tasks (operator, supplement_name, batch_number, description, started_at, status, task_type, slack_start_ts)
     VALUES ($1, $2, $3, $4, $5, 'open', $6, $7)`,
    [operator, supplement, batch, description, startedAt, resolvedType, msgTs]
  );

  console.log(`[Tasks] Started: ${operator} - ${supplement || '?'} (${resolvedType}) ${batch || ''}`);
}

/**
 * Handle F: (finish) message - close the most recent matching open task.
 */
async function handleFinish(parsed, rawMsg) {
  const { operator, supplement, batch, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const endedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  // Find the most recent open task matching operator+supplement
  let taskQuery = `
    SELECT id, started_at, slack_start_ts FROM tasks
    WHERE status = 'open'
  `;
  const params = [];
  let paramIdx = 1;

  if (operator) {
    taskQuery += ` AND operator = $${paramIdx++}`;
    params.push(operator);
  }
  if (supplement) {
    taskQuery += ` AND supplement_name = $${paramIdx++}`;
    params.push(supplement);
  }

  taskQuery += ` ORDER BY started_at DESC LIMIT 1`;

  let result = await db.query(taskQuery, params);

  // Cross-operator fallback: "Vitor F: Fenugreek" closes Bruno's open Fenugreek task.
  // Also handles: supplement name only (no operator found) — close most recent open with that supplement.
  if (result.rows.length === 0 && supplement) {
    console.log(`[Tasks] Trying cross-operator fallback for ${supplement}`);
    result = await db.query(
      `SELECT id, started_at, slack_start_ts FROM tasks
       WHERE status = 'open' AND supplement_name = $1
       ORDER BY started_at DESC LIMIT 1`,
      [supplement]
    );
  }

  // Last-resort fallback: operator sends F: with no supplement — close their most recent open task
  if (result.rows.length === 0 && !supplement && operator) {
    console.log(`[Tasks] No supplement in F: — closing most recent open task for ${operator}`);
    result = await db.query(
      `SELECT id, started_at, slack_start_ts FROM tasks
       WHERE status = 'open' AND operator = $1
       ORDER BY started_at DESC LIMIT 1`,
      [operator]
    );
  }

  if (result.rows.length === 0) {
    console.warn(`[Tasks] No open task found for ${operator} - ${supplement}`);
    return;
  }

  const task = result.rows[0];
  const startedAt = new Date(task.started_at);
  const endedAtDate = new Date(endedAt);
  const durationSeconds = Math.round((endedAtDate - startedAt) / 1000);

  // Calculate active duration (subtract pauses)
  const pausesResult = await db.query(
    `SELECT SUM(EXTRACT(EPOCH FROM (ended_at - started_at))) as pause_seconds
     FROM pauses WHERE task_id = $1 AND ended_at IS NOT NULL`,
    [task.id]
  );
  const pauseSeconds = Math.round(parseFloat(pausesResult.rows[0]?.pause_seconds || 0));
  const activeDuration = Math.max(0, durationSeconds - pauseSeconds);

  await db.query(
    `UPDATE tasks SET
       ended_at = $1,
       duration_seconds = $2,
       active_duration_seconds = $3,
       status = 'closed',
       slack_end_ts = $4,
       closed_by = $5,
       updated_at = NOW()
     WHERE id = $6`,
    [endedAt, durationSeconds, activeDuration, msgTs, operator || null, task.id]
  );

  console.log(`[Tasks] Finished: task #${task.id}, ${durationSeconds}s (${activeDuration}s active)`);

  // Compound message: operator said "terminei + estou fazendo [new supplement]"
  // Auto-open the next supplement so they don't have to send a second message
  if (parsed.nextSupplement) {
    console.log(`[Tasks] Auto-starting next: ${parsed.nextSupplement} for ${operator || '?'}`);
    await handleStart({
      operator: operator || null,
      supplement: parsed.nextSupplement,
      batch: parsed.nextBatch || null,
      description: parsed.description,
      ts: parsed.ts,
    }, rawMsg);
  }
}

/**
 * Handle P: (production count) message.
 */
async function handleCount(parsed, rawMsg) {
  const { operator, supplement, batch, count, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const reportedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  // B6: producing bottles is also an "activity" — close any pending break.
  if (operator) {
    await closeOpenBreakFor(operator, reportedAt, 'auto_new_task');
  }

  // Try to link to a closed task
  let taskId = null;
  if (supplement) {
    const taskResult = await db.query(
      `SELECT id FROM tasks
       WHERE supplement_name = $1 AND status = 'closed'
       ORDER BY ended_at DESC LIMIT 1`,
      [supplement]
    );
    taskId = taskResult.rows[0]?.id || null;
  }

  await db.query(
    `INSERT INTO production_counts (supplement_name, batch_number, count, operator, reported_at, slack_ts, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [supplement, batch, count, operator, reportedAt, msgTs, taskId]
  );

  // If count > 0, also ensure supplement exists
  if (supplement) {
    await db.query(
      `INSERT INTO supplements (name, canonical_name) VALUES ($1, $1)
       ON CONFLICT (name) DO NOTHING`,
      [supplement]
    );
  }

  console.log(`[Tasks] Count: ${supplement} ${batch} = ${count} bottles`);
}

/**
 * Handle pause_start — operator is stepping away.
 * Creates a pause record linked to their current open task.
 */
async function handlePauseStart(parsed, rawMsg) {
  const { operator, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const startedAt = new Date(parseFloat(msgTs) * 1000).toISOString();

  // Find the open task for this operator
  const taskResult = await db.query(
    `SELECT id FROM tasks
     WHERE status = 'open' AND operator = $1
     ORDER BY started_at DESC LIMIT 1`,
    [operator]
  );

  if (taskResult.rows.length === 0) {
    console.log(`[Pause] No open task found for ${operator} — recording anonymous break`);
    // Still record the break, linked to no task
  }

  const taskId = taskResult.rows[0]?.id || null;

  // Close any existing open pause first (in case they forgot to say they were back)
  if (taskId) {
    await db.query(
      `UPDATE pauses SET ended_at = $1 WHERE task_id = $2 AND ended_at IS NULL`,
      [startedAt, taskId]
    );
  }

  await db.query(
    `INSERT INTO pauses (task_id, operator, started_at, slack_ts) VALUES ($1, $2, $3, $4)`,
    [taskId, operator, startedAt, msgTs]
  );

  console.log(`[Pause] Break started: ${operator || '?'} (task #${taskId || 'none'})`);
}

/**
 * Handle pause_end — operator is back.
 * Closes any open pause record for this operator.
 */
async function handlePauseEnd(parsed, rawMsg) {
  const { operator, ts } = parsed;
  const msgTs = rawMsg.ts || ts;
  const endedAt = new Date(parseFloat(msgTs) * 1000).toISOString();
  if (!operator) {
    console.log('[Pause] pause_end with no operator — skipping');
    return false;
  }
  return closeOpenBreakFor(operator, endedAt, 'manual_return');
}

/**
 * B8: handle a joiner declaring they're helping on Linha de Produção.
 * No supplement question — Linha de Produção only runs one supplement at a time,
 * so we attach the joiner to the most recent open producao task.
 */
async function handleJoinProducao(parsed, rawMsg) {
  const { operator, ts } = parsed;
  const msgTs = rawMsg?.ts || ts;
  if (!operator) return false;

  const result = await db.query(
    `SELECT id, operator, supplement_name, helpers FROM tasks
     WHERE status = 'open' AND task_type = 'producao'
     ORDER BY started_at DESC LIMIT 1`
  );
  if (result.rows.length === 0) {
    console.log(`[Tasks] ${operator} sent join_producao but no open Linha de Produção`);
    return false;
  }
  const task = result.rows[0];
  if (task.operator === operator) {
    console.log(`[Tasks] join_producao: ${operator} is already the starter — skip`);
    return false;
  }

  const existing = task.helpers
    ? task.helpers.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (existing.includes(operator)) {
    console.log(`[Tasks] join_producao: ${operator} already in helpers — skip`);
    return false;
  }
  existing.push(operator);
  await db.query(
    'UPDATE tasks SET helpers = $1, updated_at = NOW() WHERE id = $2',
    [existing.join(', '), task.id]
  );

  // Closing any open break for the joiner — they're now working.
  if (msgTs) {
    await closeOpenBreakFor(operator, new Date(parseFloat(msgTs) * 1000).toISOString(), 'auto_new_task');
  }

  const supp = task.supplement_name || 'Linha de Produção';
  try {
    await slackClient.postMessage(pick(JOIN_PRODUCAO_ANNOUNCE)(operator, task.operator, supp));
  } catch (err) {
    console.error('[Tasks] join_producao announce error:', err.message);
  }
  console.log(`[Tasks] ${operator} joined Linha de Produção (${supp}) with ${task.operator}`);
  return true;
}

/**
 * B5/B6: close any open break for an operator. Used both for explicit "voltei"
 * messages (handlePauseEnd) and implicit close-via-new-activity (called from
 * handleStart, handleCount, handleOrdersStart, handleFormulationStart).
 *
 * Looks up open breaks either by pauses.operator (denormalized) or by joining
 * tasks.operator. Returns true if a break was closed.
 */
async function closeOpenBreakFor(operator, endedAtIso, reason) {
  if (!operator) return false;
  // Prefer the denormalized pauses.operator column; fall back to task JOIN
  // for legacy rows that pre-date the denormalization.
  const result = await db.query(
    `UPDATE pauses SET ended_at = $1
     WHERE id = (
       SELECT p.id FROM pauses p
       LEFT JOIN tasks t ON t.id = p.task_id
       WHERE p.ended_at IS NULL
         AND (p.operator = $2 OR t.operator = $2)
       ORDER BY p.started_at DESC LIMIT 1
     )
     RETURNING id, started_at`,
    [endedAtIso, operator]
  );

  if (result.rows.length > 0) {
    const tag = reason === 'manual_return' ? 'returned' : 'auto-closed (new activity)';
    console.log(`[Pause] Break ${tag}: ${operator} (id=${result.rows[0].id})`);
    return true;
  }
  if (reason === 'manual_return') {
    console.log(`[Pause] No open break found for ${operator} to close`);
  }
  return false;
}

/**
 * Ask "quem tá postando?" — posted to the channel directly so everyone sees it.
 */
async function askWhoIsPosting() {
  try {
    await slackClient.postMessage(pick(WHO_IS_POSTING_MSGS));
  } catch (err) {
    console.error('[Tasks] Error asking who is posting:', err.message);
  }
}

/**
 * Prompt operator to use S:/F: tag — posted to channel so Bruno and others see it.
 */
async function promptForTag(operatorName) {
  try {
    const who = operatorName ? `${operatorName}, ` : '';
    const msgFn = pick(TAG_PROMPT_MSGS);
    await slackClient.postMessage(msgFn(who));
  } catch (err) {
    console.error('[Tasks] Error prompting for tag:', err.message);
  }
}

function looksLikeStatusUpdate(text) {
  return /\b(rodar|rodando|formul|produ|limpeza|batch|f[oó]rmula|pesagem|pesando|ajudando|encapsul|envasa|embala|iniciando|come[çc]ando)\b/i.test(text) && text.length > 15;
}

// Owners/logistics excluded from production tracking.
// NOTE: 'Bruno' is NOT here — Bruno the worker posts from the shared Production Line
// account with "Bruno -" prefix and MUST appear on the dashboard.
// Bruno Camp (the owner) is filtered in poller.js by Slack userId before tasks are created.
const NON_OPERATOR_NAMES = ['Thassio', 'Henrique'];

/**
 * Get all currently open tasks (for urgency checks / live dashboard).
 * When date is provided (historical view), returns tasks that were open on that date.
 * @param {string|null} date - 'YYYY-MM-DD' ET, or null for live
 */
async function getOpenTasks(date) {
  if (date) {
    // Historical: tasks started on that date that are still open OR were open during it
    const result = await db.query(
      `SELECT t.*, t.active_duration_seconds AS elapsed_seconds, NULL AS avg_duration_seconds, 0 AS run_count
       FROM tasks t
       WHERE (t.started_at AT TIME ZONE 'America/New_York')::date = $1::date
         AND t.status = 'open'
         AND (t.operator IS NULL OR t.operator NOT IN ('Thassio', 'Henrique'))
       ORDER BY t.started_at ASC`,
      [date]
    );
    return result.rows;
  }
  const result = await db.query(
    `SELECT t.*,
       EXTRACT(EPOCH FROM (NOW() - t.started_at)) AS elapsed_seconds,
       (SELECT AVG(active_duration_seconds) FROM tasks
        WHERE supplement_name = t.supplement_name AND status = 'closed'
        AND active_duration_seconds > 0) AS avg_duration_seconds,
       (SELECT COUNT(*) FROM tasks
        WHERE supplement_name = t.supplement_name AND status = 'closed') AS run_count
     FROM tasks t
     WHERE t.status = 'open'
       AND (t.operator IS NULL OR t.operator NOT IN ('Thassio', 'Henrique'))
     ORDER BY t.started_at ASC`
  );
  return result.rows;
}

/**
 * Get finished tasks with production counts, pauses, and historical avg.
 * @param {string|null} date - 'YYYY-MM-DD' ET, or null for today
 */
async function getTodayTasks(date) {
  const dateExpr = date
    ? `'${date}'::date`
    : `(NOW() AT TIME ZONE 'America/New_York')::date`;
  const result = await db.query(
    `SELECT t.*,
       pc.count as bottles,
       pc.batch_number as prod_batch,
       ROUND(pc.count::numeric / NULLIF(t.active_duration_seconds / 3600.0, 0), 1) as bottles_per_hour,
       (
         SELECT json_agg(json_build_object(
           'started_at', p.started_at,
           'ended_at', p.ended_at,
           'duration_seconds', EXTRACT(EPOCH FROM (p.ended_at - p.started_at))::int
         ) ORDER BY p.started_at)
         FROM pauses p WHERE p.task_id = t.id AND p.ended_at IS NOT NULL
       ) as pauses,
       (SELECT ROUND(AVG(t2.active_duration_seconds))
        FROM tasks t2
        WHERE t2.supplement_name = t.supplement_name
          AND t2.status = 'closed'
          AND t2.active_duration_seconds > 0
          AND t2.id != t.id) as avg_duration_seconds,
       (SELECT COUNT(*) FROM tasks t2
        WHERE t2.supplement_name = t.supplement_name
          AND t2.status = 'closed'
          AND t2.id != t.id) as total_run_count
     FROM tasks t
     LEFT JOIN production_counts pc ON pc.task_id = t.id
     WHERE (t.started_at AT TIME ZONE 'America/New_York')::date = ${dateExpr}
       AND t.status = 'closed'
       AND (t.operator IS NULL OR t.operator NOT IN ('Thassio', 'Henrique'))
     ORDER BY t.ended_at DESC`
  );
  return result.rows;
}

/**
 * Get last N runs of a supplement for comparison.
 */
async function getSupplementHistory(supplementName, limit = 5) {
  const result = await db.query(
    `SELECT t.started_at, t.ended_at, t.active_duration_seconds,
       pc.count as bottles,
       ROUND(pc.count::numeric / NULLIF(t.active_duration_seconds / 3600.0, 0), 1) as bottles_per_hour
     FROM tasks t
     LEFT JOIN production_counts pc ON pc.task_id = t.id
     WHERE t.supplement_name = $1 AND t.status = 'closed' AND t.active_duration_seconds > 0
     ORDER BY t.started_at DESC
     LIMIT $2`,
    [supplementName, limit]
  );
  return result.rows;
}

module.exports = {
  handleParsed,
  handlePauseStart,
  handlePauseEnd,
  handlePendingResponse,
  handleJoinProducao,
  getPendingQuestion,
  clearPendingQuestion,
  closeOpenBreakFor,
  getOpenTasks,
  getTodayTasks,
  getSupplementHistory,
};
