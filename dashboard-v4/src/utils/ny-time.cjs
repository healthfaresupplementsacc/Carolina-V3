'use strict';
/**
 * Util de fuso New York pro V4 — funções puras testáveis.
 * Resolve os 2 bugs do E7-refine3:
 *   1. liveNowMin lendo mock NOW_MIN (14:34) ao invés do relógio NY real.
 *   2. DatePicker usando `new Date('YYYY-MM-DD')` que parseia como UTC midnight
 *      → getDay()/getDate() caem no dia anterior em qualquer TZ negativa.
 *
 * Tudo aqui é puro (sem React, sem fetch). Dual-loadable:
 *   - Jest faz require()         (testes em src/__tests__/ny-time.test.js)
 *   - Vite resolve via .cjs      (helpers.js + Shell.jsx)
 */

const TZ = 'America/New_York';

/** Minuto-do-dia (0..1439, com fração de segundo) do "agora" em NY.
 *  Independente da TZ do navegador do usuário — usa Intl pra converter
 *  o instante absoluto (Date.now()) pro wall clock NY. */
function nyNowMinutes() {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
  const [hh, mm, ss] = s.split(':').map(Number);
  return hh * 60 + mm + (ss / 60);
}

/** YYYY-MM-DD do "hoje" em NY (usa Date.now() absoluto). */
function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Parse YYYY-MM-DD → Date local-noon. Funciona pra getDay/getDate/getMonth
 *  retornarem os valores certos pra o YMD (sem cair no dia anterior por
 *  causa de UTC midnight). Não preserva fuso, só os pedaços y/m/d. */
function parseYmdLocal(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

/** Desloca N dias num YYYY-MM-DD interpretado em NY, robusto contra DST.
 *  Constrói o noon UTC do (y, m-1, d+n) — noon evita ambiguidade DST —
 *  e re-formata na TZ NY pra extrair o YMD canônico. */
function shiftNyDate(ymd, n) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  // noon UTC do dia desejado — ainda cai dentro do mesmo dia NY mesmo em DST switch
  const noonUtc = Date.UTC(y, m - 1, d + n, 16); // 16Z aprox EDT noon NY; serve pra qualquer mês
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(noonUtc));
}

/** Day-of-week index pra um YYYY-MM-DD (0=Dom..6=Sáb). Usa parseYmdLocal. */
function ymdDayOfWeek(ymd) {
  const d = parseYmdLocal(ymd);
  return d ? d.getDay() : null;
}

/** Offset NY pro dado dia ('-04:00' EDT ou '-05:00' EST). */
function nyOffsetFor(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '-05:00';
  // noon UTC do dia → cai sempre dentro do dia NY do mesmo y-m-d
  const [y, m, d] = ymd.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, timeZoneName: 'short',
  }).formatToParts(noonUtc).find((p) => p.type === 'timeZoneName').value;
  return tzName === 'EDT' ? '-04:00' : '-05:00';
}

/** Converte minuto-do-dia + YMD → ISO com offset NY: '2026-05-27T15:30:00-04:00'.
 *  Usado pra construir started_at/ended_at no client antes de PATCH/POST. */
function minutesToNyIso(ymd, minutes) {
  if (minutes == null) return null;
  const m = Math.max(0, Math.round(minutes));
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${ymd}T${hh}:${mm}:00${nyOffsetFor(ymd)}`;
}

module.exports = { TZ, nyNowMinutes, nyToday, parseYmdLocal, shiftNyDate, ymdDayOfWeek, nyOffsetFor, minutesToNyIso };
