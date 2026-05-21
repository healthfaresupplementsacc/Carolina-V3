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

/**
 * Converte um instante (Date ou string parseável) em ISO 8601 COM o
 * offset de New York — ex.: "2026-05-21T12:18:10-04:00" (EDT) ou
 * "...-05:00" (EST). Mantém o mesmo instante, só troca a apresentação
 * de UTC pro fuso operacional. Toda a camada de dados emite assim.
 * Valor nulo/inválido → null (nunca lança).
 */
function toNyIso(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const hh = parts.hour === '24' ? '00' : parts.hour; // meia-noite em alguns runtimes
  // offset = diferença entre o "wall time" NY e o instante UTC.
  const wallUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +hh, +parts.minute, +parts.second);
  const offMin = Math.round((wallUTC - d.getTime()) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
}

module.exports = { TZ, nyDate, isValidDate, resolveDate, toNyIso };
