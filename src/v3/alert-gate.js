'use strict';
/**
 * HEALTHFARE V3 — Alert Gate (Bruno 07-05).
 *
 * FONTE ÚNICA da resposta pra "posso incomodar o canal dos operadores AGORA?".
 * Nasceu do flood: cada worker de alerta postava no canal de produção por conta
 * própria, sem (a) um botão de desligar pro admin e (b) sem noção de "tem alguém
 * aqui agora?". Resultado: encap-monitor gritando "MÁQUINA PARADA, registrem AGORA"
 * de hora em hora até 19h — DEPOIS que o próprio sistema já tinha dado checkout
 * automático em todo mundo às 15h. Este módulo centraliza os dois gates:
 *
 *   1. isMuted(db)        — kill-switch do admin (persistido em v3.settings).
 *                           O admin fala "pausa os avisos" no canal admin.
 *   2. anyonePresent(db)  — tem operador logado (sessão aberta) OU task aberta hoje?
 *                           Se NÃO, "máquina parada" é esperado → não alerta.
 *
 * Stateless: recebe o pool `db`. Cada worker só faz require e chama.
 * O parser de comando (parseMuteCommand) é DETERMINÍSTICO — não depende do LLM
 * (que vive estourando cota); um comando de controle tem que ser instantâneo e
 * 100% confiável.
 */
const EDT = 'America/New_York';
const MUTE_KEY = 'operator_alerts_muted_until';

// ── timezone helpers (sem libs) ────────────────────────────────
/** offset (NY − UTC) em ms no instante `ms`. Julho = −4h (EDT). */
function nyOffsetMs(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: EDT, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of dtf.formatToParts(new Date(ms))) o[p.type] = p.value;
  let hh = +o.hour; if (hh === 24) hh = 0; // Intl às vezes devolve 24 à meia-noite
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, hh, +o.minute, +o.second);
  return asUTC - ms;
}
/** UTC-ms do relógio de parede NY (hoje+dayOffset) às hh:mm. */
function nyWallMs(nowMs, dayOffset, hh, mm) {
  const dca = new Intl.DateTimeFormat('en-CA', { timeZone: EDT, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = dca.format(new Date(nowMs)).split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d + dayOffset, hh, mm, 0);
  return naive - nyOffsetMs(naive);
}
/** hora NY atual (0–23). */
function nyHour(nowMs) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: EDT, hour12: false, hour: '2-digit' }).format(new Date(nowMs)), 10);
}
/** próxima ocorrência de hh:00 NY estritamente depois de agora. */
function nextNyHour(nowMs, hh) {
  const today = nyWallMs(nowMs, 0, hh, 0);
  return today > nowMs ? today : nyWallMs(nowMs, 1, hh, 0);
}

// ── estado do mute (v3.settings) ───────────────────────────────
async function getMute(db) {
  try {
    const r = await db.query('SELECT value FROM v3.settings WHERE key = $1', [MUTE_KEY]);
    if (!r.rows.length) return null;
    const v = r.rows[0].value || {};
    const iso = typeof v === 'string' ? v : v.until;
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return { untilMs: t, until: iso, reason: v.reason || null, by: v.by || null };
  } catch (_) { return null; } // settings indisponível → não bloqueia nada
}
async function isMuted(db, nowMs = Date.now()) {
  const m = await getMute(db);
  return !!(m && nowMs < m.untilMs);
}
async function setMute(db, { untilMs, reason, by }) {
  const val = JSON.stringify({ until: new Date(untilMs).toISOString(), reason: reason || null, by: by || null });
  await db.query(
    `INSERT INTO v3.settings (key, value, description) VALUES ($1, $2::jsonb, 'kill-switch dos avisos do canal de operadores (Bruno 07-05)')
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`, [MUTE_KEY, val]);
}
async function clearMute(db) {
  await db.query('DELETE FROM v3.settings WHERE key = $1', [MUTE_KEY]);
}

// ── presença ───────────────────────────────────────────────────
/** Tem operador logado (sessão aberta) OU task aberta começada hoje? */
async function anyonePresent(db) {
  const r = await db.query(
    `SELECT (
       EXISTS (SELECT 1 FROM v3.operator_sessions s JOIN v3.persons p ON p.id = s.person_id
               WHERE s.logged_out_at IS NULL AND p.role = 'operator'
                 AND p.active = true AND COALESCE(p.is_sandbox, false) = false)
       OR EXISTS (SELECT 1 FROM v3.events e
                  WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
                    AND (e.started_at AT TIME ZONE '${EDT}')::date = (NOW() AT TIME ZONE '${EDT}')::date)
     ) AS present`);
  return !!(r.rows[0] && r.rows[0].present);
}

// ── parser de comando (canal admin) ────────────────────────────
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const DOW = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

/** minutos → rótulo pt legível (ex.: 150 → "2h30"). */
function fmtUntil(untilMs, nowMs) {
  const mins = Math.max(0, Math.round((untilMs - nowMs) / 60000));
  const dur = mins >= 60 ? Math.floor(mins / 60) + 'h' + (mins % 60 ? String(mins % 60).padStart(2, '0') : '') : mins + 'min';
  const clock = new Intl.DateTimeFormat('pt-BR', { timeZone: EDT, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(untilMs));
  return { dur, clock };
}

/**
 * Interpreta uma mensagem do canal admin como comando de mute/unmute/status.
 * DETERMINÍSTICO (sem LLM). Retorna { action, untilMs?, label? } ou {action:null}.
 * @param {string} text  texto cru da mensagem (mentions já podem estar dentro)
 * @param {number} nowMs
 */
function parseMuteCommand(text, nowMs = Date.now()) {
  const t = strip(text).replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 160) return { action: null }; // comando é curto; texto longo = conversa

  const NOUN = /(aviso|alerta|alert|notif|mensage|lembrete|cobranca|spam|avisar|avisando)/;
  const muteVerb = /(pausa|pause|parar|para de|parem|silencia|silencio|muta|mutar|mute|calar|cala|desliga|suspende|segura|chega de|nao avisa|stop|shh|quiet)/;
  const unmuteVerb = /(volta|voltar|religa|religar|retoma|retomar|reativa|reativar|reata|liga de novo|ligar de novo|unmute|pode avisar|pode voltar|continua|reabr|desmuta|desmutar)/;
  // verbo de mute FORTE no INÍCIO (não precisa de substantivo — "pausa até segunda")
  const strongMuteStart = /^(pausa|pausar|pause|muta|mutar|mute|silencia|silenciar|silencio|shh+|suspende|suspender)\b/;

  // STATUS primeiro: PERGUNTA ("?") com adjetivo de estado, ou "status/situação"
  const stateAdj = /(pausad|ativ|ligad|desligad|mutad|silenciad|calad)/;
  const isQuestion = /\?\s*$/.test(t);
  const isStatus = /^(status|situacao)\b/.test(t)
    || (isQuestion && stateAdj.test(t) && NOUN.test(t))
    || /(aviso|alerta)s?\s+(estao|esta|continuam|seguem)\s+(pausad|ativ|ligad|mutad)/.test(t);
  if (isStatus) return { action: 'status' };

  // exatos curtos (não precisam do substantivo)
  const exactMute = /^(mute|silencio|shh+|pausar avisos|parar avisos|para os avisos|calar avisos|muta os avisos|muta avisos)$/.test(t);
  const exactUnmute = /^(unmute|voltar avisos|religar avisos|retomar avisos|voltar a avisar|pode avisar|liga os avisos|desmutar avisos|reativar avisos)$/.test(t);

  // "pausa" seguido de um OBJETO DE PRODUÇÃO ≠ mutar avisos ("pausa a linha")
  const otherObject = /(linha|producao|produc|maquina|equipamento|lote|encapsul|mistura|formula|ordem|pedido|tarefa|task|sistema|processo|trabalho|reuniao)/;
  // regras "fuzzy" (verbo+substantivo) só valem em mensagem CURTA — um comando é
  // curto; frase longa que por acaso contém "pausar"+"avisar" é conversa, não comando.
  const short = t.length <= 70;
  const wantsUnmute = exactUnmute || (short && unmuteVerb.test(t) && NOUN.test(t));
  const wantsMute = exactMute
    || (short && muteVerb.test(t) && NOUN.test(t))
    || (short && strongMuteStart.test(t) && !otherObject.test(t));

  // unmute tem prioridade sobre mute quando ambos batem ("voltar a avisar" contém "avisar")
  if (wantsUnmute && !wantsMute) return { action: 'unmute' };
  if (wantsUnmute && wantsMute) return { action: 'unmute' };
  if (!wantsMute) return { action: null };

  // ── duração ──
  let untilMs = null; let label = null;
  let m;
  if ((m = t.match(/por\s+(\d+)\s*(h|hr|hora|horas)\b/)) || (m = t.match(/(\d+)\s*(h|hora|horas)\b(?!\w)/))) {
    untilMs = nowMs + Number(m[1]) * 3600 * 1000; label = m[1] + 'h';
  } else if ((m = t.match(/por\s+(\d+)\s*(m|min|minuto|minutos)\b/)) || (m = t.match(/(\d+)\s*(min|minutos)\b/))) {
    untilMs = nowMs + Number(m[1]) * 60 * 1000; label = m[1] + 'min';
  } else if (/ate\s+amanha| amanha/.test(t)) {
    untilMs = nyWallMs(nowMs, 1, 7, 0); label = 'amanhã de manhã';
  } else if ((m = t.match(/ate\s+(domingo|segunda|terca|quarta|quinta|sexta|sabado)/))) {
    const target = DOW[m[1]]; const cur = new Date(nowMs).getUTCDay();
    // aproxima o dia da semana NY: acha o próximo `target` a partir de amanhã
    let off = 1; for (let i = 0; i < 8; i++) { const d = new Intl.DateTimeFormat('en-US', { timeZone: EDT, weekday: 'short' }).format(new Date(nyWallMs(nowMs, off, 7, 0))); if (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][target] === d) break; off++; }
    untilMs = nyWallMs(nowMs, off, 7, 0); label = 'até ' + m[1]; void cur;
  } else if (/resto do dia|o dia todo|hoje|fim do dia/.test(t)) {
    const nine = nyWallMs(nowMs, 0, 21, 0); untilMs = nine > nowMs ? nine : nextNyHour(nowMs, 7); label = 'resto do dia';
  } else if (/indefinid|ate eu (voltar|mandar|dizer|liberar)|segunda ordem|permanente|ate segunda ordem/.test(t)) {
    untilMs = nowMs + 30 * 24 * 3600 * 1000; label = 'até você religar';
  } else {
    // default: até amanhã de manhã (cobre a noite/madrugada — o caso do flood)
    untilMs = nextNyHour(nowMs, 7); label = 'até amanhã de manhã';
  }
  return { action: 'mute', untilMs, label };
}

module.exports = {
  MUTE_KEY, EDT,
  isMuted, getMute, setMute, clearMute, anyonePresent,
  parseMuteCommand, fmtUntil,
  nyOffsetMs, nyWallMs, nyHour, nextNyHour,
};
