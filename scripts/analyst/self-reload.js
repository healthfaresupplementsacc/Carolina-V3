'use strict';
/* AUTO-RELOAD (09-09). Os satelites sobem pela Scheduled Task em S4U, e
 * processo S4U nao morre com taskkill sem elevacao ("Access is denied").
 * Resultado: cada correcao de codigo exigia UAC pra reiniciar. Agora cada
 * satelite vigia o mtime do PROPRIO arquivo (e dos modulos irmaos que ele
 * usa) e, quando muda, sai com exit 0 — o wrapper .cmd relanca em ~5s com
 * o codigo novo. Sem UAC, sem sessao, sem esquecer.
 *
 * Espera 20s depois da mudanca antes de sair (arquivo pode estar sendo
 * escrito) e nunca sai no meio de um "trabalho" se o chamador passar
 * `busy()` que devolva true.
 */
const fs = require('fs');
const path = require('path');

module.exports = function selfReload(files, opts = {}) {
  const list = (Array.isArray(files) ? files : [files]).map((f) => path.isAbsolute(f) ? f : path.join(__dirname, f));
  const busy = typeof opts.busy === 'function' ? opts.busy : () => false;
  const stamp = () => list.map((f) => { try { return String(fs.statSync(f).mtimeMs); } catch (_) { return '0'; } }).join('|');
  const inicial = stamp();
  let mudouEm = 0;
  const t = setInterval(() => {
    const agora = stamp();
    if (agora === inicial) { mudouEm = 0; return; }
    if (!mudouEm) { mudouEm = Date.now(); console.log('[self-reload] codigo mudou; saio em 20s pro wrapper relancar'); return; }
    if (Date.now() - mudouEm < 20000) return;
    if (busy()) { console.log('[self-reload] ocupado, adio a saida'); return; }
    console.log('[self-reload] saindo (exit 0) pra carregar o codigo novo');
    process.exit(0);
  }, 10000);
  if (t.unref) t.unref();
};
