'use strict';
/**
 * Urgency system.
 * Checks open tasks against expected duration baselines and posts
 * tiered check-in messages to Slack.
 *
 * Tiers:
 *   0: 0-100%   - blue timer, no message
 *   1: 100-130% - amber, casual check-in
 *   2: 130-160% - red, stronger nudge
 *   3: 160%+    - red flashing, direct appeal
 */

const db = require('./db');
const slackClient = require('./slack/client');
const tasks = require('./tasks');
const config = require('./config');

function getTier(elapsed, avg) {
  if (!avg || avg <= 0) return 0; // No baseline -> no pressure
  const ratio = elapsed / avg;
  if (ratio >= config.urgency.critical) return 3;
  if (ratio >= config.urgency.red) return 2;
  if (ratio >= config.urgency.amber) return 1;
  return 0;
}

async function getNotifiedTier(taskId) {
  const res = await db.query(
    'SELECT MAX(tier) as max_tier FROM urgency_notifications WHERE task_id = $1',
    [taskId]
  );
  return res.rows[0]?.max_tier ?? -1;
}

async function recordNotification(taskId, tier, slackTs) {
  await db.query(
    'INSERT INTO urgency_notifications (task_id, tier, slack_ts) VALUES ($1, $2, $3)',
    [taskId, tier, slackTs]
  );
  await db.query(
    'UPDATE tasks SET urgency_tier = $1, updated_at = NOW() WHERE id = $2',
    [tier, taskId]
  );
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildMessage(tier, task) {
  const n = task.supplement_name || 'isso aí';
  const op = task.operator || 'pessoal';

  if (tier === 1) {
    return pick([
      `oi, como tá o ${n}?`,
      `como tá indo o ${n}?`,
      `${n} tá bem?`,
      `tudo certo com o ${n}?`,
      `e o ${n}, como tá?`,
      `oi, e o ${n}?`,
      `como vai o ${n}?`,
      `${n}, tudo bem?`,
      `atualização do ${n}?`,
      `como tá a produção do ${n}?`,
      `oi, ${op} — como tá o ${n}?`,
      `${n} ainda em andamento?`,
      `tá tudo certo com o ${n}?`,
      `${op}, como vai o ${n}?`,
      `e aí, ${n} indo bem?`,
      `como tá o ritmo do ${n}?`,
      `${n} no caminho certo?`,
      `tudo tranquilo com o ${n}?`,
      `oi ${op}, e o ${n}?`,
      `${n} correndo bem?`,
      `alguma novidade do ${n}?`,
      `${op}, tudo bem com o ${n}?`,
      `como vai o ${n}, ${op}?`,
      `${n} ainda rolando?`,
      `e o ${n}, tá indo?`,
      `oi, ${n} tá bem?`,
      `${op}, o ${n} tá bem?`,
      `atualiza aí — ${n}?`,
      `${n} tranquilo?`,
      `como tá esse ${n}?`,
    ]);
  }

  if (tier === 2) {
    return pick([
      `${op}, esse ${n} tá demorando mais que o normal — tudo certo?`,
      `oi ${op}, ${n} tá demorando um pouco — aconteceu algo?`,
      `${n} tá além do tempo esperado, ${op} — tá tudo bem?`,
      `${op}, dá uma atualização do ${n} — tá mais lento hoje?`,
      `${n} tá tomando mais tempo que o usual, ${op}`,
      `${op}, tudo bem com o ${n}? tá levando um tempo`,
      `oi ${op}, notei que o ${n} tá demorando — algum problema?`,
      `${n} passou do tempo normal, ${op} — precisa de ajuda?`,
      `${op}, o ${n} tá indo mais devagar hoje`,
      `${n} tá além da média, ${op} — tudo certo por aí?`,
      `${op}, demorou mais que o normal no ${n} — o que aconteceu?`,
      `${n} tá além do esperado, ${op}`,
      `oi ${op}, esse ${n} tá demorando — precisa de alguma coisa?`,
      `${op}, atualiza o ${n} — tá levando mais tempo`,
      `${n} além do ritmo normal, ${op} — tudo bem?`,
      `${op}, esse ${n} parece estar mais devagar — tudo certo?`,
      `oi, ${n} tá além do tempo — alguma coisa diferente hoje, ${op}?`,
      `${n} passou do normal, ${op} — tá tudo ok?`,
      `${op}, o ${n} tá demorando um pouco mais que o habitual`,
      `${n} além do ritmo hoje, ${op}`,
      `${op}, tô vendo que o ${n} tá demorando — tá bem?`,
      `${n} além do tempo médio, ${op} — aconteceu algo?`,
      `oi ${op}, esse ${n} tá tomando mais tempo — tá bem?`,
      `${op}, ${n} demorando — precisa de ajuda com alguma coisa?`,
      `${n} tá além do esperado hoje, ${op} — pode me atualizar?`,
      `${op}, o ${n} tá levando mais tempo — tudo certo?`,
      `oi ${op}, ${n} além do normal — tudo bem aí?`,
      `${n} passou do tempo, ${op} — algum problema?`,
      `${op}, esse ${n} tá além do habitual hoje`,
      `${n} demorando mais que o normal, ${op} — o que aconteceu?`,
    ]);
  }

  if (tier === 3) {
    return pick([
      `${op}, já passou bastante do tempo no ${n} — me manda um F quando terminar`,
      `ó ${op}, o ${n} tá muito além do tempo — precisa de ajuda?`,
      `${op}, o ${n} tá há muito tempo em aberto — tá tudo bem?`,
      `${op}, o ${n} tá demorando demais — o que tá acontecendo aí?`,
      `ó ${op}, o ${n} tá muito além do normal — preciso de uma atualização`,
      `${op}, quanto tempo mais pro ${n}? tá muito acima do esperado`,
      `${op}, o ${n} tá em aberto há muito tempo — vai fechar logo?`,
      `ó ${op}, ${n} há muito tempo em andamento — tá tudo certo?`,
      `${op}, o ${n} passou muito do tempo normal — precisa de apoio?`,
      `ó ${op}, esse ${n} tá fora do padrão de tempo — o que houve?`,
      `${op}, muito tempo no ${n} — pode me dar um retorno?`,
      `${op}, o ${n} tá em aberto há muito — precisa de alguma coisa?`,
      `ó ${op}, ${n} demais no relógio — tá tudo bem aí?`,
      `${op}, o ${n} tá há muito em andamento — quando fecha?`,
      `ó ${op}, preciso de uma atualização do ${n} — tá demorando muito`,
      `${op}, ${n} além do tempo esperado há bastante tempo — o que houve?`,
      `ó ${op}, esse ${n} tá muito além do padrão`,
      `${op}, o ${n} tá rodando há muito — precisa de algum suporte?`,
      `${op}, muito tempo nesse ${n} — tudo bem ou precisa de ajuda?`,
      `ó ${op}, ${n} há muito tempo em aberto — me fala o que tá acontecendo`,
      `${op}, preciso de uma atualização do ${n} — tá muito além do normal`,
      `ó ${op}, esse ${n} tá muito além do ritmo habitual`,
      `${op}, o ${n} tá aberto há muito tempo — tá tudo certo?`,
      `ó ${op}, muito tempo no ${n} — precisa de reforço aí?`,
      `${op}, o ${n} tá longe de fechar? tá além do esperado`,
      `${op}, pode me atualizar sobre o ${n}? tá demorando muito`,
      `ó ${op}, o ${n} continua em aberto — o que tá acontecendo?`,
      `${op}, o ${n} tá rodando há bastante tempo — tudo bem?`,
      `ó ${op}, esse ${n} tá muito além do normal — me diz o que tá acontecendo`,
      `${op}, o ${n} tá em aberto demais — preciso de retorno`,
    ]);
  }

  return null;
}

/**
 * Run urgency check for all open tasks.
 * Called every polling cycle.
 */
async function checkUrgency() {
  const openTasks = await tasks.getOpenTasks();

  for (const task of openTasks) {
    const { id, elapsed_seconds, avg_duration_seconds, run_count } = task;

    // No baseline on first run
    if (!run_count || parseInt(run_count) === 0) continue;
    if (!avg_duration_seconds) continue;

    const tier = getTier(parseFloat(elapsed_seconds), parseFloat(avg_duration_seconds));
    if (tier === 0) continue;

    const alreadyNotified = await getNotifiedTier(id);
    if (tier <= alreadyNotified) continue; // Already sent this tier or higher

    const message = buildMessage(tier, task);
    if (!message) continue;

    try {
      const slackTs = await slackClient.postMessage(message); // no thread_ts — post to main channel
      await recordNotification(id, tier, slackTs);
      console.log(`[Urgency] Tier ${tier} message sent for task #${id} (${task.supplement_name})`);
    } catch (err) {
      console.error(`[Urgency] Error sending message for task #${id}:`, err.message);
    }
  }
}

module.exports = { checkUrgency, getTier };
