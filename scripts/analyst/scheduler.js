'use strict';
/* AGENDADOR INDEPENDENTE DA SESSAO (Bruno 09-08: "make sure next time all
 * automations start on its own... even after reboot").
 * Le _watch/tasks.json e dispara cada tarefa no horario, chamando o Claude
 * headless (claude -p). Nao depende de nenhuma sessao aberta.
 *
 * A prova de reboot: sobe pelo Startup folder (start-watchdog-hidden.vbs) e,
 * ao subir, roda o CATCH-UP: se uma tarefa do dia ja passou da hora e nao rodou
 * (state.json), dispara na hora, contanto que ainda esteja dentro da janela de
 * 3h. Assim reboot as 8:40am nao perde a checagem das 8:33am.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '_watch');
const REPO = path.resolve(__dirname, '..', '..');
const TASKS = path.join(DIR, 'tasks.json');
const STATE = path.join(DIR, 'scheduler-state.json');
const LOG = path.join(DIR, 'scheduler.log');
const ALIVE = path.join(DIR, 'scheduler-alive.txt');
const CATCHUP_MIN = 180;           // roda atrasado ate 3h depois (reboot tardio)
const CHECK_MS = 60000;

const log = (...a) => {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
};
const loadJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } };
const saveState = (s) => { try { fs.writeFileSync(STATE, JSON.stringify(s, null, 1)); } catch (_) {} };

// chave do dia em NY (a fabrica roda em NY, nao em UTC)
function nyParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const p = {};
  f.formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: p.year + '-' + p.month + '-' + p.day, min: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10), dow: dowMap[p.weekday] };
}
const hhmmToMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

function runTask(task, why) {
  const state = loadJson(STATE, {});
  const { date } = nyParts();
  state[task.id] = state[task.id] || {};
  if (state[task.id].lastRun === date) { log('SKIP', task.id, 'ja rodou hoje'); return; }
  state[task.id].lastRun = date;
  state[task.id].startedAt = new Date().toISOString();
  saveState(state);
  log('DISPARANDO', task.id, '(' + why + ')');
  // claude headless: --print roda e sai. Permissoes liberadas pra poder consultar
  // o banco e postar como Carol sem prompt interativo.
  const args = ['-p', task.prompt, '--permission-mode', 'bypassPermissions'];
  const child = spawn('claude', args, { cwd: REPO, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('close', (code) => {
    const st = loadJson(STATE, {});
    st[task.id] = st[task.id] || {};
    st[task.id].exit = code;
    st[task.id].finishedAt = new Date().toISOString();
    st[task.id].tail = out.slice(-400);
    saveState(st);
    log('FIM', task.id, 'exit=' + code, out.slice(-160).replace(/\s+/g, ' '));
  });
  child.on('error', (e) => log('ERRO ao rodar', task.id, e.message));
}

function tick(isBoot) {
  try { fs.writeFileSync(ALIVE, new Date().toISOString()); } catch (_) {}
  const tasks = loadJson(TASKS, []);
  const state = loadJson(STATE, {});
  const now = nyParts();
  for (const t of tasks) {
    if (Array.isArray(t.days) && !t.days.includes(now.dow)) continue;
    if ((state[t.id] || {}).lastRun === now.date) continue;
    const due = hhmmToMin(t.at);
    const late = now.min - due;
    if (late >= 0 && late <= (isBoot ? CATCHUP_MIN : 5)) {
      runTask(t, isBoot ? 'catch-up pos-boot, ' + late + 'min atrasado' : 'no horario');
    }
  }
}

const _t = loadJson(TASKS, []);
log('scheduler ligado. tarefas:', _t.map((t) => t.id + '@' + t.at).join(', ') || '(nenhuma)');
try { fs.writeFileSync(path.join(DIR, 'scheduler-loaded.json'), JSON.stringify({ at: new Date().toISOString(), tasks: _t.map((t) => ({ id: t.id, at: t.at, days: t.days })) }, null, 1)); } catch (_) {}
tick(true);                                  // catch-up imediato ao subir (reboot)
setInterval(() => tick(false), CHECK_MS);    // depois, a cada minuto
