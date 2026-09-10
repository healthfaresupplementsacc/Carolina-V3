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
// 09-09: nunca dois agendadores (so no modo daemon; --test/--run sao manuais)
const MANUAL = process.argv.includes('--test') || process.argv.includes('--run');
if (!MANUAL) require('./single-instance')('scheduler', 'scheduler-alive.txt');

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

// Roda o Claude headless com o prompt via STDIN (09-09). ANTES o prompt ia como
// argumento com shell:true e o cmd.exe picava o texto nos espacos/aspas: o
// "--ch C0BUKK6EH98" de dentro do prompt virava opcao do proprio claude
// ("unknown option '--ch'") e o meio-dia chegou como uma palavra so ("VIGIA"),
// que o Claude respondeu pedindo esclarecimento. Nenhum toque saiu em 09-09.
const CLAUDE_TIMEOUT_MS = 25 * 60 * 1000;
function runClaude(prompt, onDone) {
  // Qual claude: o NATIVO (~/.local/bin/claude.exe, instalador oficial, se
  // atualiza sozinho) tem prioridade; o npm global ficou preso em 2.1.142
  // porque o npm deste PC esta quebrado, e 2.1.142 recusa o modelo padrao
  // ("version 2.1.251 or newer is required", visto em 09-09). Exe direto, sem
  // shell; o .cmd do npm so como ultimo recurso via cmd.exe.
  const nativo = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
  const flags = ['-p', '--permission-mode', 'bypassPermissions'];
  const child = fs.existsSync(nativo)
    ? spawn(nativo, flags, { cwd: REPO, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude ' + flags.join(' ')], { cwd: REPO, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let done = false;
  let killer = null;
  const finish = (code) => { if (done) return; done = true; clearTimeout(killer); onDone(code, out); };
  killer = setTimeout(() => { out += '\n[scheduler] TIMEOUT ' + (CLAUDE_TIMEOUT_MS / 60000) + 'min, matando'; try { child.kill(); } catch (_) {} finish('timeout'); }, CLAUDE_TIMEOUT_MS);
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('close', (code) => finish(code));
  child.on('error', (e) => { out += '\n[scheduler] ERRO spawn: ' + e.message; finish('spawn-error'); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return child;
}

let rodando = 0;
function runTask(task, why) {
  const state = loadJson(STATE, {});
  const { date } = nyParts();
  state[task.id] = state[task.id] || {};
  if (state[task.id].lastRun === date && why !== 'manual') { log('SKIP', task.id, 'ja rodou hoje'); return; }
  state[task.id].lastRun = date;
  state[task.id].startedAt = new Date().toISOString();
  saveState(state);
  log('DISPARANDO', task.id, '(' + why + ')');
  rodando++;
  runClaude(task.prompt, (code, out) => {
    rodando--;
    const st = loadJson(STATE, {});
    st[task.id] = st[task.id] || {};
    st[task.id].exit = code;
    st[task.id].finishedAt = new Date().toISOString();
    st[task.id].tail = out.slice(-400);
    saveState(st);
    log('FIM', task.id, 'exit=' + code, out.slice(-160).replace(/\s+/g, ' '));
  });
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

// Modos manuais (09-09):
//   node scheduler.js --test          -> prova que o claude headless recebe o prompt inteiro
//   node scheduler.js --run <taskId>  -> dispara uma tarefa agora (grava no state)
if (process.argv.includes('--test')) {
  const prova = 'Teste do agendador. Responda EXATAMENTE com a frase: PROMPT INTEIRO RECEBIDO --ch C0BUKK6EH98 "aspas ok"';
  console.log('[teste] mandando prompt via stdin...');
  runClaude(prova, (code, out) => { console.log('[teste] exit=' + code + '\n' + out.trim()); process.exit(0); });
} else if (process.argv.includes('--run')) {
  const id = process.argv[process.argv.indexOf('--run') + 1];
  const t = loadJson(TASKS, []).find((x) => x.id === id);
  if (!t) { console.log('tarefa nao existe: ' + id); process.exit(1); }
  runTask(t, 'manual');
} else {
  const _t = loadJson(TASKS, []);
  log('scheduler ligado. tarefas:', _t.map((t) => t.id + '@' + t.at).join(', ') || '(nenhuma)');
  try { fs.writeFileSync(path.join(DIR, 'scheduler-loaded.json'), JSON.stringify({ at: new Date().toISOString(), tasks: _t.map((t) => ({ id: t.id, at: t.at, days: t.days })) }, null, 1)); } catch (_) {}
  // recarrega sozinho quando o codigo muda (sem UAC): so entre tarefas
  require('./self-reload')(['scheduler.js', 'single-instance.js', 'self-reload.js'], { busy: () => rodando > 0 });
  tick(true);                                  // catch-up imediato ao subir (reboot)
  setInterval(() => tick(false), CHECK_MS);    // depois, a cada minuto
}
