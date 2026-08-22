'use strict';
/**
 * HEALTHFARE V3 — vínculo pessoa ↔ relógio de ponto (NGTeco). Bruno 08-21.
 *
 * Bruno: "quando eu cadastro um funcionário novo o sistema tem que procurar
 * ele sozinho na API do NGTeco e vincular, conferindo nome e sobrenome".
 *
 * O vínculo é persons.clock_code = employee_code do NGTeco. Sem ele a pessoa
 * não aparece no PONTO do dashboard nem entra no attendance-sync (foi o caso
 * da Caroline Braga, criada sem código).
 *
 * REGRA de match (conservadora de propósito — relógio tem 3 "Ana"):
 *   - nomes normalizados: minúsculas, sem acento, tokens por espaço;
 *   - o 1º token digitado TEM que ser o 1º token do nome no relógio;
 *   - TODOS os tokens digitados têm que existir no nome completo do relógio
 *     ("Caroline Braga" ⊆ "Caroline Braga de Almeida" ✓);
 *   - nome de UM token só (ex: "Simone") NUNCA vincula sozinho — pede o
 *     sobrenome (double-check exigido pelo Bruno) → status needs_full_name;
 *   - mais de um candidato → ambiguous; nenhum → not_found;
 *   - código já usado por outra pessoa ativa → code_taken (nunca rouba).
 *
 * REGRA #0: quem chama trata falha do NGTeco como "não vinculou ainda" —
 * a criação do funcionário nunca pode ser bloqueada por isso.
 */

const ngteco = require('./ngteco');

/** minúsculas, sem acento, tokens. "Braga de Almeida" → ['braga','de','almeida'] */
function tokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().split(/\s+/).filter(Boolean);
}

/** Roster do relógio normalizado: [{code, name, toks}]. */
async function roster() {
  const rows = await ngteco.currentDay();
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const code = String(r.employee_code || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
      || String(r.employee_name || '').trim();
    out.push({ code, name, toks: tokens(name) });
  }
  return out;
}

/**
 * Match do displayName contra o roster.
 * takenCodes: Set de clock_codes já usados por OUTRAS pessoas (nunca reusa).
 * → { status: 'matched'|'needs_full_name'|'ambiguous'|'not_found'|'code_taken',
 *     match?: {code,name}, candidates: [{code,name}] }
 */
function matchName(displayName, rosterRows, takenCodes) {
  const taken = takenCodes || new Set();
  const dtoks = tokens(displayName);
  if (!dtoks.length) return { status: 'not_found', candidates: [] };

  const hits = (rosterRows || []).filter((r) => r.toks.length
    && r.toks[0] === dtoks[0]
    && dtoks.every((t) => r.toks.includes(t)));
  const candidates = hits.map((r) => ({ code: r.code, name: r.name, taken: taken.has(r.code) }));

  if (!hits.length) return { status: 'not_found', candidates: [] };
  if (dtoks.length < 2) return { status: 'needs_full_name', candidates };
  if (hits.length > 1) return { status: 'ambiguous', candidates };
  if (taken.has(hits[0].code)) return { status: 'code_taken', candidates };
  return { status: 'matched', match: { code: hits[0].code, name: hits[0].name }, candidates };
}

/** clock_codes já usados por pessoas vivas (menos a própria, se informada). */
async function takenCodes(db, exceptPersonId) {
  const r = await db.query(
    `SELECT clock_code FROM v3.persons
      WHERE clock_code IS NOT NULL AND clock_code <> '' AND deleted_at IS NULL
        AND ($1::int IS NULL OR id <> $1)`, [exceptPersonId || null]);
  return new Set(r.rows.map((x) => String(x.clock_code).trim()));
}

/**
 * Procura displayName no relógio e devolve o resultado do match (não escreve
 * nada no banco — quem grava é a rota, com audit). Lança se o NGTeco falhar.
 */
async function lookup(db, displayName, exceptPersonId) {
  const [rows, taken] = await Promise.all([roster(), takenCodes(db, exceptPersonId)]);
  return { ...matchName(displayName, rows, taken), roster: rows.map((r) => ({ code: r.code, name: r.name, taken: taken.has(r.code) })) };
}

module.exports = { lookup, matchName, roster, takenCodes, tokens, configured: ngteco.configured };
