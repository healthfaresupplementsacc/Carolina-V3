'use strict';
/**
 * HEALTHFARE V3 — Bloco 0 — datas no fuso operacional.
 *
 * A HealthFare é na Florida; o time pensa em horário local. TODA a
 * camada de dados (src/v3/data/*) filtra e rotula datas em
 * America/New_York (DST-aware). Centraliza aqui pra não repetir
 * `Intl.DateTimeFormat` espalhado.
 */

const TZ = 'America/New_York';

/** Data YYYY-MM-DD de um Date (default: agora) no fuso NY. */
function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** true se `s` é uma string de data YYYY-MM-DD válida. */
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

/** Devolve `s` se for data válida; senão, hoje (NY). Nunca lança. */
function resolveDate(s) {
  return isValidDate(s) ? s : nyDate();
}

module.exports = { TZ, nyDate, isValidDate, resolveDate };
