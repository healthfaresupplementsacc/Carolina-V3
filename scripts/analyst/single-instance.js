'use strict';
/* GUARDA DE INSTANCIA UNICA (09-09). Por que existe: a Scheduled Task
 * "HealthFare Claude Autostart" dispara no BOOT e no LOGON; o VBS sai na hora,
 * entao o "IgnoreNew" da task nao segura nada e cada satelite (watchdog,
 * listener, scheduler) subia DUAS vezes (visto ao vivo em 09-09: dois sets de
 * wrappers, 17:20:59 e 17:21:25). Dois watchdogs brigando pela mesma aba do
 * Slack = autologin falhando; dois schedulers = risco de toque duplicado.
 *
 * Regra: o segundo a chegar sai com exit 42 e o wrapper .cmd honra o 42
 * (nao reinicia). O primeiro fica. Decisao de "o outro esta vivo" precisa de
 * TRES sinais, senao um PID reaproveitado depois do reboot trancaria tudo:
 *   1) o PID do lock responde (kill 0; EPERM conta como vivo — S4U e elevado);
 *   2) o lock e deste boot (boot time gravado no lock; reboot => lock velho);
 *   3) o heartbeat do outro e fresco (<180s) — e quem pega o lock toca o
 *      heartbeat na hora, pra cobrir a janela boot->logon de ~30s.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '_watch');
const FRESH_MS = 180 * 1000;

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
function bootMs() { return Math.round(Date.now() - os.uptime() * 1000); }
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} }
function fresh(file) { try { return Date.now() - fs.statSync(file).mtimeMs < FRESH_MS; } catch (_) { return false; } }

module.exports = function singleInstance(name, heartbeatFile) {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  const lock = path.join(DIR, name + '.pid');
  const hb = heartbeatFile ? path.join(DIR, heartbeatFile) : null;
  const mine = JSON.stringify({ pid: process.pid, boot: bootMs(), at: new Date().toISOString() });
  for (let i = 0; i < 4; i++) {
    try { fs.writeFileSync(lock, mine, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') break;                     // sem lock nao se bloqueia ninguem
      let other = null;
      try { other = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (_) {}
      if (!other || !other.pid) { sleepSync(700); try { other = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (_) {} }
      const sameBoot = !!(other && Math.abs((other.boot || 0) - bootMs()) < 60 * 1000);
      const vivo = !!(other && other.pid !== process.pid && pidAlive(other.pid) && sameBoot && (!hb || fresh(hb)));
      if (vivo) {
        console.log('[' + name + '] ja existe uma instancia viva (pid ' + other.pid + ', desde ' + other.at + '); esta sai (exit 42)');
        process.exit(42);
      }
      try { fs.unlinkSync(lock); } catch (_) {}          // lock morto/velho: assume
    }
  }
  if (hb) { try { fs.writeFileSync(hb, new Date().toISOString()); } catch (_) {} }
  const bye = () => { try { const o = JSON.parse(fs.readFileSync(lock, 'utf8')); if (o.pid === process.pid) fs.unlinkSync(lock); } catch (_) {} };
  process.on('exit', bye);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
};
