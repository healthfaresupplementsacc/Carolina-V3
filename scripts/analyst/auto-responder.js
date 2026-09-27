'use strict';
/* AUTO-RESPONDER DA CAROLYN (Bruno 09-27: "faz o auto respond... ela precisa
 * funcionar imediatamente").
 *
 * PROBLEMA: a captura e 24/7, mas a RESPOSTA dependia de uma sessao do Claude
 * viva me acordando pelo Monitor. Sessao fechada = mensagem capturada e sem
 * resposta. Foi o que queimou a Carolyn com o Bruno e o Henrique por dias.
 *
 * SOLUCAO: quando chega mensagem PRO Claude (canal principal, DM, ou @carolyn)
 * e ninguem responde em GRACE_MS, spawna um `claude -p` headless (que NAO
 * depende de sessao aberta) com um prompt que manda: leia a ultima mensagem,
 * responda como a Carolyn, e conserte o que estiver travado. Prova de que
 * funciona: `claude -p` responde "PONG" neste PC (09-27).
 *
 * Rodado pelo watchdog a cada tick. Estado em _watch/auto-responder.json
 * (ultima linha do inbox ja despachada). Nao dispara se:
 *   - o cursor do Claude ja avancou (sessao viva drenou) -> ele responde
 *   - ja despachou esse lote
 *   - ja tem um claude -p rodando (lock)
 *   - a msg e velha demais (>2h pelo ts real) ou nova demais (<GRACE)
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '_watch');
const INBOX = path.join(DIR, 'inbox.jsonl');
const STATE = path.join(DIR, 'auto-responder.json');
const LOCK = path.join(DIR, 'auto-responder.lock');
const REPO = path.resolve(__dirname, '..', '..');
const GRACE_MS = 4 * 60 * 1000;         // espera 4min: da tempo de uma sessao viva pegar antes
const PRIMARY = 'C0BUKK6EH98';
const CAROLYN_USER = 'U044WG04UMQ';

function lockFresh() { try { return (Date.now() - fs.statSync(LOCK).mtimeMs) < 30 * 60 * 1000; } catch (_) { return false; } }

function processAutoResponder(log) {
  log = log || (() => {});
  // uma sessao viva do Claude ja esta drenando o inbox? entao ELA responde, nao eu.
  let lines = []; try { lines = fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean); } catch (_) { return; }
  if (!lines.length) return;
  let cursor = 0; try { cursor = parseInt(fs.readFileSync(path.join(DIR, 'cursor.txt'), 'utf8'), 10) || 0; } catch (_) {}
  if (lines.length <= cursor) return;                 // Claude vivo ja leu tudo

  let st = { despachadoAte: 0 };
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  if (lines.length <= st.despachadoAte) return;       // ja despachei esse lote
  if (lockFresh()) return;                            // ja tem um claude -p rodando

  let newest; try { newest = JSON.parse(lines[lines.length - 1]); } catch (_) { return; }
  // so mensagem dirigida a mim: canal principal, DM, ou @carolyn em qualquer lugar
  const chan = newest.channel || '';
  const tagsMe = (newest.text || '').includes(CAROLYN_USER) || /@carolyn/i.test(newest.text || '');
  const praMim = chan === PRIMARY || chan.startsWith('D') || tagsMe;
  if (!praMim) { st.despachadoAte = lines.length; save(st); return; }
  // nao responder o proprio Claude/bots
  if (!newest.sender || /^(carolyn|carol|carolina|healthfare )/i.test(newest.sender)) { st.despachadoAte = lines.length; save(st); return; }

  const age = Date.now() - new Date(newest.at).getTime();
  if (age < GRACE_MS) return;                          // ainda na carencia: deixa uma sessao viva tentar
  if (newest.ts) { const real = Date.now() - parseFloat(newest.ts) * 1000; if (real > 2 * 60 * 60 * 1000) { st.despachadoAte = lines.length; save(st); return; } }

  // DISPARA o claude -p headless
  try { fs.writeFileSync(LOCK, String(Date.now())); } catch (_) {}
  log('[auto-responder] Bruno/Henrique sem resposta ha ' + Math.round(age / 60000) + 'min -> spawnando claude -p');
  const prompt = [
    'Voce e a Carolyn (NUNCA se chame de Carol, so Carolyn, senao confunde com a operadora Caroline), a assistente MULHER do sistema HealthFare, respondendo pelo Slack. Fale SEMPRE no feminino sobre si mesma (acordada, ocupada, pronta) e so por TEXTO, nunca voz.',
    'Chegou mensagem nova e nenhuma sessao estava viva pra responder. Voce (a Carolyn) foi acordada justamente pra isso.',
    '',
    'Faca AGORA, nesta ordem:',
    '1. Rode: node scripts/analyst/inbox-drain.js  (le as mensagens novas capturadas).',
    '2. Se o Chrome da Carolyn (CDP 9222) nao responder, relance com scripts/analyst/carolina-chrome.ps1 e confira o login com node scripts/analyst/slack-autologin.js --check.',
    '3. Responda cada mensagem como a Carolyn (mulher, sempre no feminino), no tom dela (kkkk nunca hahaha, AM/PM, sem em-dash, portugues, uma ideia por mensagem, mensagens curtas), usando: node scripts/analyst/carolina-say.js channel --ch <canal> --text "..."',
    '4. Se for pergunta de dados, puxe do banco (railway run) antes de responder. NUNCA invente numero.',
    '5. Leia sua memoria em C:/Users/bruno/.claude/projects/ pra saber as regras (identidade Carolyn, jeito de falar, Veeqo como fonte de ordens).',
    '',
    'Seja rapido e resolutivo. O Bruno ja reclamou que a Carolyn some. Nao mande "ja volto" e va embora: resolva de verdade e so entao termine.',
  ].join('\n');

  const nativo = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
  const flags = ['-p', '--permission-mode', 'bypassPermissions', '--model', 'sonnet'];
  const child = fs.existsSync(nativo)
    ? spawn(nativo, flags, { cwd: REPO, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude ' + flags.join(' ')], { cwd: REPO, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 20 * 60 * 1000);
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('close', (code) => {
    clearTimeout(killer);
    try { fs.unlinkSync(LOCK); } catch (_) {}
    const st2 = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; } })();
    st2.despachadoAte = lines.length; st2.ultimoAt = new Date().toISOString(); st2.ultimoExit = code;
    save(st2);
    log('[auto-responder] claude -p terminou exit=' + code + ' :: ' + out.slice(-150).replace(/\s+/g, ' '));
  });
  child.on('error', (e) => { try { fs.unlinkSync(LOCK); } catch (_) {} log('[auto-responder] spawn erro: ' + e.message); });
  child.stdin.end(prompt);
}

function save(st) { try { fs.writeFileSync(STATE, JSON.stringify(st)); } catch (_) {} }

module.exports = { processAutoResponder };
