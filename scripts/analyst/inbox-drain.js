'use strict';
/* Lê mensagens NOVAS do inbox do watchdog e imprime pro Claude (usado no /loop).
 * Guarda um cursor (_watch/cursor.txt = quantas linhas já foram lidas) pra só
 * mostrar o que chegou desde a última vez. Sem args: drena e avança o cursor.
 * `node inbox-drain.js peek` = mostra sem avançar o cursor. */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '_watch');
const INBOX = path.join(DIR, 'inbox.jsonl');
const CUR = path.join(DIR, 'cursor.txt');
const peek = process.argv[2] === 'peek';

let lines = [];
try { lines = fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean); } catch (_) {}
let cursor = 0;
try { cursor = parseInt(fs.readFileSync(CUR, 'utf8'), 10) || 0; } catch (_) {}

const fresh = lines.slice(cursor);
if (!fresh.length) { console.log('NADA_NOVO'); process.exit(0); }
console.log('NOVAS_MENSAGENS: ' + fresh.length);
for (const l of fresh) {
  try { const m = JSON.parse(l); console.log(`- [${m.at}] (${m.channel}) ${m.sender}: ${m.text}`); }
  catch (_) { console.log('- ' + l); }
}
if (!peek) { try { fs.writeFileSync(CUR, String(lines.length)); } catch (_) {} }
