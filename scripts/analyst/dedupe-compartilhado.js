'use strict';
/* DEDUPE COMPARTILHADO entre o watchdog (DOM) e o listener (socket).
 *
 * PROBLEMA REAL (09-10): a MESMA mensagem do Thassio entrou 2x no inbox — uma
 * pelo socket (com ts) as 8:36am e outra pela raspagem de DOM (SEM ts) as
 * 1:26pm. Cada processo tinha seu proprio arquivo de vistos E um formato de
 * chave diferente (`canal:ts` no listener, `canal|remetente|texto` no
 * watchdog), entao nenhum reconhecia a captura do outro. Resultado: eu era
 * acordada de novo por conversa ja respondida.
 *
 * SOLUCAO: chave por CONTEUDO (canal + remetente normalizado + texto
 * normalizado), num arquivo unico que os dois leem e escrevem. Nao depende de
 * ts, que a raspagem de DOM nem sempre tem.
 *
 * O arquivo e append-only com trava simples: cada processo relê antes de
 * gravar, entao um nao apaga o que o outro acabou de ver.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '_watch', 'seen-shared.json');
const MAX = 4000;

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/<@[a-z0-9]+>/gi, '@')      // mencao vira token generico
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 300);                       // texto longo: prefixo ja identifica

function chave(canal, remetente, texto) {
  return norm(canal) + '|' + norm(remetente).replace(/\s*\(.*$/, '') + '|' + norm(texto);
}

function carregar() {
  try { return new Set(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_) { return new Set(); }
}

/** ja vi essa mensagem (por qualquer um dos dois caminhos)? */
function jaVisto(canal, remetente, texto) {
  return carregar().has(chave(canal, remetente, texto));
}

/** marca como vista, relendo antes pra nao apagar o que o outro processo gravou */
function marcar(canal, remetente, texto) {
  const s = carregar();
  s.add(chave(canal, remetente, texto));
  try {
    fs.writeFileSync(FILE, JSON.stringify([...s].slice(-MAX)));
  } catch (_) {}
}

module.exports = { jaVisto, marcar, chave };
