'use strict';
/**
 * Horário de funcionamento das câmeras (Bruno 07-10). As câmeras são de
 * SUPERVISÃO, então seguem o horário de trabalho: ligam 7:00 e desligam 20:30
 * (8:30pm), de segunda a sábado. Domingo ficam DESLIGADAS o dia todo (ninguém
 * trabalha). Fora desse horário o gateway responde como "fora do ar" e a página
 * mostra o estado normal de "reconectando" (igual a um restart do servidor) —
 * sem tela preta, sem erro especial.
 *
 * Tudo em America/New_York (a fábrica é na Flórida). Configurável por env:
 *   CAM_ON_HHMM=07:00  CAM_OFF_HHMM=20:30  CAM_OFF_DAYS=Sunday  CAM_TZ=America/New_York
 */
function hhmmToMin(s, def) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return def;
  const h = parseInt(m[1], 10); const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return def;
  return h * 60 + mi;
}

// Config lida A CADA CHAMADA (não no load): assim dá pra mudar o horário só
// trocando a env no Railway + restart, sem deploy de código — e é testável.
function cfg() {
  return {
    tz: process.env.CAM_TZ || 'America/New_York',
    onMin: hhmmToMin(process.env.CAM_ON_HHMM, 7 * 60),         // 07:00 → 420
    offMin: hhmmToMin(process.env.CAM_OFF_HHMM, 20 * 60 + 30), // 20:30 → 1230
    // Sáb E dom desligados por padrão (Bruno 07-11: serviço de fds é EXTRA/sob
  // demanda — o cameras.js liga sob demanda se alguém trabalha / o admin avisa).
  offDays: String(process.env.CAM_OFF_DAYS != null ? process.env.CAM_OFF_DAYS : 'Saturday,Sunday')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

/** Dia da semana (em inglês) + minutos desde meia-noite, no fuso da fábrica. */
function nyClock(date = new Date(), tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || cfg().tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => { const f = parts.find((x) => x.type === t); return f ? f.value : ''; };
  return { weekday: get('weekday'), minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

/** As câmeras devem estar LIGADAS agora? (dentro do horário de trabalho). */
function isCamerasOn(date = new Date()) {
  const c = cfg();
  const { weekday, minutes } = nyClock(date, c.tz);
  if (c.offDays.includes(String(weekday).toLowerCase())) return false; // domingo etc
  return minutes >= c.onMin && minutes < c.offMin;                     // [07:00, 20:30)
}

const pad = (n) => String(n).padStart(2, '0');
function scheduleInfo() {
  const c = cfg();
  return {
    tz: c.tz,
    on: `${pad(Math.floor(c.onMin / 60))}:${pad(c.onMin % 60)}`,
    off: `${pad(Math.floor(c.offMin / 60))}:${pad(c.offMin % 60)}`,
    off_days: c.offDays,
  };
}

module.exports = { isCamerasOn, nyClock, scheduleInfo };
