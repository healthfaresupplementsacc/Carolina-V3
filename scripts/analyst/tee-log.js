'use strict';
/* TEE DE LOG (09-09). Desde que os wrappers .cmd pararam de redirecionar com
 * ">>" (duas instancias travavam o arquivo), o console.log do watchdog e do
 * listener ia pro nada: watchdog.log parado desde 09-08 13:47 enquanto o
 * processo seguia vivo. Aqui cada linha vai pro console E pro arquivo, com
 * carimbo de hora, em append curto (abre/escreve/fecha) e rotacao em 2MB. */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '_watch');
const MAX = 2 * 1024 * 1024;

module.exports = function teeLog(fileName) {
  const file = path.join(DIR, fileName);
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a && a.stack) return a.stack;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  };
  const write = (args) => {
    const line = '[' + new Date().toISOString() + '] ' + args.map(fmt).join(' ') + '\n';
    try {
      try {
        if (fs.statSync(file).size > MAX) { try { fs.unlinkSync(file + '.1'); } catch (_) {} fs.renameSync(file, file + '.1'); }
      } catch (_) {}
      fs.appendFileSync(file, line);
    } catch (_) { /* log nunca derruba o processo */ }
  };
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { origLog(...a); write(a); };
  console.error = (...a) => { origErr(...a); write(a); };
};
