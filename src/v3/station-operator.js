// Station operator — ÚNICA fonte de verdade de "quem está na estação de impressão (.28) agora".
//
// Bruno 07-27: informação incorreta destrói a nossa credibilidade. Duas atribuições
// erradas hoje (Simone "bateu o dedo", Simone "consertou a impressora" quando era a
// Ana) vieram de LER dados velhos: a setting `print_station_operator` guarda só o
// login ATUAL e era usada sem checar frescor. A regra do Bruno é simples e é a certa:
// "quem foi o ÚLTIMO a logar É a pessoa da estação — sincroniza ela em qualquer aviso."
//
// Então: a verdade vem da TABELA DE HISTÓRICO `v3.print_station_login_log` (append em
// todo login por PIN), não da setting mutável. Pegamos o ÚLTIMO login. E somos
// HONESTOS sobre frescor: se o login é velho e não há atividade (heartbeat), devolvemos
// `stale=true` — o chamador NÃO deve afirmar nome nenhum. Melhor "não sabemos quem
// está" do que afirmar a pessoa errada.

const LOGIN_MAX_AGE_MS = 8 * 3600 * 1000;   // login vale por um turno (8h)
const ACTIVE_HB_MS = 2 * 60 * 1000;         // heartbeat < 2min = mexendo no PC agora

// Devolve { person_id, name, since, active_now, active_sec, last_seen_sec, stale }
// ou null se não há login recente NENHUM.
async function stationOperatorNow(db) {
  // 1) ÚLTIMO login real na estação (append-only, à prova de sobrescrita).
  let last = null;
  try {
    last = (await db.query(
      `SELECT person_id, person_name, logged_in_at
         FROM v3.print_station_login_log
        ORDER BY logged_in_at DESC
        LIMIT 1`)).rows[0] || null;
  } catch (_) { /* tabela pode não existir ainda em ambientes antigos */ }

  // 2) Heartbeat + active_sec vêm da setting (o printlock.py atualiza updated_at a cada
  //    ~20s e grava active_sec). É telemetria de PRESENÇA, não de identidade.
  let setting = null;
  try {
    setting = (await db.query(
      "SELECT value, updated_at FROM v3.settings WHERE key='print_station_operator'")).rows[0] || null;
  } catch (_) { /* ok */ }

  // Fallback: sem histórico (ex.: primeiro deploy), usa a setting como identidade.
  const ident = last
    ? { person_id: last.person_id, name: last.person_name, since: last.logged_in_at }
    : (setting && setting.value && setting.value.at
        ? { person_id: setting.value.person_id || null, name: setting.value.name || null, since: setting.value.at }
        : null);
  if (!ident || !ident.since) return null;

  const sinceMs = Date.now() - new Date(ident.since).getTime();
  if (sinceMs > LOGIN_MAX_AGE_MS) return null;   // login velho demais → ninguém

  const hbMs = setting && setting.updated_at ? Date.now() - new Date(setting.updated_at).getTime() : Infinity;
  const activeNow = hbMs < ACTIVE_HB_MS;
  const activeSec = setting && setting.value && setting.value.active_sec != null
    ? Number(setting.value.active_sec) : null;

  // STALE: login não é recente (>20min) E ninguém mexendo no PC. A identidade pode
  // estar velha (a pessoa saiu sem deslogar). Chamador deve evitar afirmar o nome.
  const stale = !activeNow && sinceMs > 20 * 60 * 1000;

  return {
    person_id: ident.person_id || null,
    name: ident.name || null,
    since: ident.since,
    active_now: activeNow,
    active_sec: activeSec,
    last_seen_sec: Number.isFinite(hbMs) ? Math.round(hbMs / 1000) : null,
    stale,
  };
}

module.exports = { stationOperatorNow, LOGIN_MAX_AGE_MS, ACTIVE_HB_MS };
