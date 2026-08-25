'use strict';
/**
 * HEALTHFARE V4 — REGISTRO DE SINAIS EXTERNOS (Bruno 08-25).
 *
 * POR QUE ISSO EXISTE
 * O push de câmera do PC .28 (POST /api/machine-state → v3.settings 'machine_state')
 * PAROU em 2026-08-23T23:39:15Z e ninguém percebeu por 42 horas. Consequência: o
 * encap-monitor trata sinal velho como "não sei" e LIBERA o alarme, então os
 * operadores levaram "Encapsulação parada há 1h04" com a máquina rodando.
 *
 * O servidor NÃO alcança o .28 (ARCHITECTURE.md: nenhuma porta aberta, o .28 sempre
 * inicia a conversa). Logo o único jeito de saber que um sinal morreu é medir a
 * AUSÊNCIA dele do nosso lado. Este arquivo é a lista única do que TEM que
 * continuar chegando.
 *
 * Este módulo é DADO PURO + leitura. Não posta, não escreve, não decide. Quem
 * decide é src/workers/signal-watchdog.js.
 *
 * Campos de cada sinal:
 *   key             id estável (vira dedupe no audit_log e código do incidente)
 *   label           nome humano (PT-BR)
 *   how             1 frase: o que alimenta esse sinal
 *   source          quem produz ('.28 machinemon', 'worker ems_sync', ...)
 *   read(db)        async → { at: Date|null, detail: object }  (só SELECT)
 *   stale_after_min idade que já é problema
 *   window          null = 24/7  |  { startHour, endHour, workdaysOnly } em NY
 *   severity        'alta' | 'média'
 *   fix_hint        PT-BR: a PRIMEIRA coisa que uma pessoa deve conferir
 *
 * ADICIONAR UM SINAL NOVO = UM object literal no array. Nada mais.
 */

const EDT = 'America/New_York';

/** Hora NY (0-23), dia da semana NY (0=dom) e data NY de um Date. */
function nyParts(now) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: EDT, hour12: false, hour: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const hour = Number((f.find((p) => p.type === 'hour') || {}).value || 0) % 24;
  const wdName = String((f.find((p) => p.type === 'weekday') || {}).value || '');
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wdName);
  const date = now.toLocaleDateString('en-CA', { timeZone: EDT });
  return { hour, dow, date };
}

/** Estamos DENTRO da janela em que esse sinal deve estar vivo? */
function inWindow(win, now) {
  if (!win) return true;                       // 24/7
  const { hour, dow } = nyParts(now);
  if (win.workdaysOnly && (dow === 0 || dow === 6)) return false;
  const s = win.startHour != null ? win.startHour : 0;
  const e = win.endHour != null ? win.endHour : 24;
  return hour >= s && hour < e;
}

/** SELECT de um timestamp só, tolerante a tabela/coluna inexistente. */
async function _maxAt(db, sql, params) {
  try {
    const r = await db.query(sql, params || []);
    const row = (r && r.rows && r.rows[0]) || null;
    const v = row ? (row.at != null ? row.at : row.m) : null;
    return v ? new Date(v) : null;
  } catch (_) { return null; }   // erro de leitura vira "desconhecido", nunca crash
}

const SIGNALS = [
  {
    key: 'machine_state',
    label: 'Câmera das máquinas (.28)',
    how: 'O machinemon do PC .28 manda o estado das máquinas a cada 30s.',
    source: '.28 machinemon',
    // Push a cada ~30s (src/routes/op.js:534, POST /api/machine-state, auth
    // x-print-token). Grava v3.settings key 'machine_state' = { machines, at, source }.
    // 10 min = 20 pushes perdidos: não é soluço de rede, é o serviço morto.
    stale_after_min: 10,
    window: { startHour: 8, endHour: 20, workdaysOnly: false },
    severity: 'alta',
    fix_hint: 'Conferir no PC .28 se o machinemon está rodando e se o PC tem rede. O servidor não consegue chamar o .28: ele é quem tem que mandar.',
    async read(db) {
      try {
        const r = await db.query("SELECT value FROM v3.settings WHERE key='machine_state'");
        const v = (r.rows[0] && r.rows[0].value) || null;
        if (!v) return { at: null, detail: { missing: true } };
        return {
          at: v.at ? new Date(v.at) : null,
          detail: {
            payload: v,
            machines: Array.isArray(v.machines) ? v.machines.length : 0,
            source: v.source || null,
          },
        };
      } catch (_) { return { at: null, detail: { error: 'read_failed' } }; }
    },
  },
  {
    key: 'print_event',
    label: 'Estação de impressão (.28)',
    how: 'Cada job impresso no PC .28 vira POST /api/print-event e uma linha em v3.print_jobs.',
    source: '.28 printmon',
    // LIVENESS = MAX(created_at) de v3.print_jobs (src/routes/op.js:474 é o único
    // INSERT nessa tabela).
    // CUIDADO COM O LIMIAR: impressão é EM RAJADA. Tem dia inteiro sem imprimir
    // label nenhum, e isso é NORMAL. Se eu usasse "3h sem job = morto", o alerta
    // gritaria em todo dia calmo e viraria ruído; e ruído é exatamente o que faz
    // gente ignorar o alerta de verdade. Por isso 26h + janela de expediente em
    // dia útil: só reclama quando passou um DIA INTEIRO de trabalho sem nenhuma
    // impressão, o que na prática só acontece se o printmon morreu. Falso negativo
    // (dia realmente parado) é muito mais barato que falso positivo aqui.
    stale_after_min: 26 * 60,
    window: { startHour: 10, endHour: 18, workdaysOnly: true },
    severity: 'média',
    fix_hint: 'Conferir no .28 se o printmon está rodando. O watchdog do .28 costuma revivê-lo; se nem ele responde, o PC pode estar desligado ou fora da rede.',
    async read(db) {
      const at = await _maxAt(db, 'SELECT MAX(created_at) AS at FROM v3.print_jobs');
      let detail = {};
      try {
        const r = await db.query(
          'SELECT id, document, printer, computer, created_at FROM v3.print_jobs ORDER BY created_at DESC LIMIT 1');
        detail = { last_job: r.rows[0] || null };
      } catch (_) { detail = { error: 'read_failed' }; }
      return { at, detail };
    },
  },
  {
    key: 'ems_sync',
    label: 'Sincronização do EMS',
    how: 'O worker ems_sync lê a API do EMS a cada 45s e carimba last_synced_at no cache.',
    source: 'worker ems_sync (railway)',
    // LIVENESS = MAX(last_synced_at) de v3.ems_activity_cache (coluna criada em
    // src/v3/schema/migrations/038_ems_activity_cache.sql:26, escrita por
    // src/workers/ems-activity-sync.js:210). Tick de 45s; 60min sem carimbo = o
    // worker morreu ou a API do EMS caiu de vez.
    stale_after_min: 60,
    window: { startHour: 7, endHour: 20, workdaysOnly: false },
    severity: 'média',
    fix_hint: 'Ver se o worker ems_sync está com heartbeat na página Sistema e se a API do EMS respondeu (chave EMS_PRODUCTION_API_KEY no Railway).',
    async read(db) {
      const at = await _maxAt(db, 'SELECT MAX(last_synced_at) AS at FROM v3.ems_activity_cache');
      let detail = {};
      try {
        const r = await db.query(
          "SELECT COUNT(*)::int AS ativos FROM v3.ems_activity_cache WHERE sync_status = 'active'");
        detail = { ativos: r.rows[0] ? r.rows[0].ativos : null };
      } catch (_) { detail = { error: 'read_failed' }; }
      return { at, detail };
    },
  },
  {
    key: 'veeqo_sync',
    label: 'Sincronização de pedidos da Veeqo',
    how: 'O worker veeqo_orders espelha os pedidos da Veeqo por linha e carimba synced_at.',
    source: 'worker veeqo_orders (railway)',
    // LIVENESS = MAX(synced_at) de v3.pnp_order_lines (tabela de
    // src/v3/schema/migrations/059_pnp_order_lines.sql, coluna escrita em
    // src/workers/veeqo-order-sync.js:57 `synced_at = NOW()`). Tick de 5min;
    // 90min dá folga pra API da Veeqo tossir sem virar alarme.
    stale_after_min: 90,
    window: { startHour: 8, endHour: 20, workdaysOnly: false },
    severity: 'média',
    fix_hint: 'Ver o worker veeqo_orders na página Sistema e se a VEEQO_API_KEY continua válida. Sem esse sinal o pick sheet do dia congela.',
    async read(db) {
      const at = await _maxAt(db, 'SELECT MAX(synced_at) AS at FROM v3.pnp_order_lines');
      let detail = {};
      try {
        const r = await db.query(
          "SELECT COUNT(*)::int AS linhas FROM v3.pnp_order_lines WHERE synced_at > NOW() - INTERVAL '24 hours'");
        detail = { linhas_24h: r.rows[0] ? r.rows[0].linhas : null };
      } catch (_) { detail = { error: 'read_failed' }; }
      return { at, detail };
    },
  },
  {
    key: 'ngteco_clock',
    label: 'Relógio de ponto (NGTeco)',
    how: 'O worker de ponto puxa as batidas do relógio e grava em v3.att_punch.',
    source: 'worker attendance (railway) via relógio NGTeco',
    // LIVENESS = MAX(punch_time) de v3.att_punch (INSERT em
    // src/workers/attendance-sync.js:438).
    // CUIDADO COM O LIMIAR: batida é EM RAJADA. Entrada, almoço, volta, saída.
    // Entre a volta do almoço e a saída passam horas sem batida nenhuma e o
    // relógio está perfeito. Por isso 8h + janela 10h-18h em dia útil: às 10h já
    // devia existir a entrada de todo mundo, e 8h sem NENHUMA batida dentro do
    // expediente é relógio ou worker morto, não gente almoçando.
    stale_after_min: 8 * 60,
    window: { startHour: 10, endHour: 18, workdaysOnly: true },
    severity: 'média',
    fix_hint: 'Ver o worker attendance na página Sistema e se o relógio NGTeco está ligado e na rede. Sem batida o checkout autoritativo não fecha as tarefas.',
    async read(db) {
      const at = await _maxAt(db, 'SELECT MAX(punch_time) AS at FROM v3.att_punch');
      let detail = {};
      try {
        const r = await db.query(
          "SELECT COUNT(*)::int AS batidas FROM v3.att_punch WHERE punch_time > NOW() - INTERVAL '24 hours'");
        detail = { batidas_24h: r.rows[0] ? r.rows[0].batidas : null };
      } catch (_) { detail = { error: 'read_failed' }; }
      return { at, detail };
    },
  },
];

/** Um sinal → { ...entry, at, age_min, stale, in_window, detail }. Nunca lança. */
async function checkOne(db, entry, now) {
  const t = now || new Date();
  let at = null, detail = {};
  try {
    const got = (await entry.read(db)) || {};
    at = got.at ? new Date(got.at) : null;
    detail = got.detail || {};
  } catch (e) { detail = { error: e && e.message }; }
  const valid = at && Number.isFinite(at.getTime());
  const ageMin = valid ? Math.round((t.getTime() - at.getTime()) / 60000) : null;
  // sem timestamp nenhum = nunca chegou = velho por definição
  const stale = ageMin == null ? true : ageMin > entry.stale_after_min;
  return {
    key: entry.key, label: entry.label, how: entry.how, source: entry.source,
    stale_after_min: entry.stale_after_min, window: entry.window || null,
    severity: entry.severity, fix_hint: entry.fix_hint,
    at: valid ? at : null,
    age_min: ageMin, stale, in_window: inWindow(entry.window, t), detail,
  };
}

/** Todos os sinais, na ordem do registro. */
async function checkAll(db, now) {
  const t = now || new Date();
  const out = [];
  for (const s of SIGNALS) out.push(await checkOne(db, s, t));
  return out;
}

module.exports = { SIGNALS, checkAll, checkOne, inWindow, nyParts };
