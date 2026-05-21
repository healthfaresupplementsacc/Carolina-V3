'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.10 — endpoints /api/admin/v3/* (inspeção shadow)
 *
 * Read-only. Auth via PIN (mesmo do legado, ADMIN_PIN). HTML simples,
 * sem framework. É por aqui que o Bruno decide se o V3 está pronto
 * pro cutover — foco em legibilidade.
 *
 * GET /api/admin/v3/overview          visão consolidada do dia (ao vivo)
 * GET /api/admin/v3/messages-shadow   o que o V3 entendeu de cada msg
 * GET /api/admin/v3/events-shadow     events criados (timeline por pessoa)
 * GET /api/admin/v3/timeline          preview do dashboard V3
 * GET /api/admin/v3/divergences       V3 vs legado
 * GET /api/admin/v3/vocabulary-pending  termos novos p/ confirmar
 * GET /api/admin/v3/llm-metrics       custo / confiança / erro
 * GET /api/admin/v3/health            worker / fila / erros
 *
 * Princípio #24: queries v3.* schema-qualificadas.
 */

const { BatchService } = require('../services/BatchService');

const CONF_COLOR = { high: '#16a34a', medium: '#ca8a04', low: '#ea580c', unconfirmed: '#dc2626' };
// cor de fundo dos blocos da timeline por categoria de atividade.
const CAT_BG = { production_phase: '#1e3a8a', support: '#78350f', meta: '#4c1d95' };
const PAGES = [
  ['overview', 'Overview'],
  ['messages-shadow', 'Mensagens'], ['events-shadow', 'Events'], ['timeline', 'Timeline'],
  ['divergences', 'Divergências'], ['vocabulary-pending', 'Vocabulário'],
  ['llm-metrics', 'Métricas'], ['health', 'Saúde'],
];

/** Data YYYY-MM-DD no fuso America/New_York. */
function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Segundos → "Xh Ym" / "Ym". */
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function checkPin(req) {
  const pin = (req.query && req.query.pin) || (req.headers && req.headers['x-admin-pin']);
  return String(pin || '') === String(process.env.ADMIN_PIN || '510510');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clampLimit(v, def = 50, max = 200) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function confBadge(c) {
  return `<span style="background:${CONF_COLOR[c] || '#64748b'};color:#fff;`
    + `padding:1px 6px;border-radius:4px;font-size:11px">${esc(c || '?')}</span>`;
}

function page(title, pin, body, opts = {}) {
  const nav = PAGES.map(([slug, label]) =>
    `<a href="/api/admin/v3/${slug}?pin=${encodeURIComponent(pin || '')}">${label}</a>`).join(' · ');
  const refresh = opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : '';
  return '<!doctype html><html><head><meta charset="utf-8">' + refresh
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>V3 — ' + esc(title) + '</title>'
    + '<style>body{font-family:system-ui,sans-serif;margin:18px;background:#0f172a;color:#e2e8f0}'
    + 'h1{font-size:18px}h2{font-size:15px;margin:20px 0 8px;border-bottom:1px solid #334155;padding-bottom:3px}'
    + 'a{color:#38bdf8;text-decoration:none}nav{margin:8px 0 16px;font-size:13px}'
    + 'table{border-collapse:collapse;width:100%;font-size:12px}'
    + 'th,td{border:1px solid #334155;padding:5px 7px;text-align:left;vertical-align:top}'
    + 'th{background:#1e293b}tr:nth-child(even){background:#172033}'
    + 'input,select{background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:3px}'
    + '.muted{color:#64748b}.big{font-size:22px;font-weight:700}</style></head><body>'
    + '<h1>HealthFare V3 (shadow) — ' + esc(title) + '</h1><nav>' + nav + '</nav>'
    + body + '</body></html>';
}

const deny = () => ({ status: 403, contentType: 'text/plain', body: 'PIN inválido' });

// ── handlers ──────────────────────────────────────────────────

async function handleMessagesShadow(req, deps) {
  if (!checkPin(req)) return deny();
  const limit = clampLimit(req.query.limit);
  const date = req.query.date;
  const where = date ? 'WHERE m.created_at::date = $2' : '';
  const params = date ? [limit, date] : [limit];
  const r = await deps.db.query(
    `SELECT m.id, m.slack_ts, m.slack_user_id, m.raw_text, m.created_at,
            m.llm_result, m.llm_provider_used, m.processing_error, p.display_name AS person_name
     FROM v3.messages m LEFT JOIN v3.persons p ON p.id = m.person_id
     ${where} ORDER BY m.created_at DESC LIMIT $1`, params);
  const rows = r.rows.map((m) => {
    const lr = m.llm_result || {};
    const conf = lr.confidence_overall || (lr.skipped ? 'skipped' : '?');
    return `<tr><td class="muted">${esc((m.created_at || '').toString().slice(0, 19))}</td>`
      + `<td>${esc(m.slack_user_id)}</td><td>${esc(m.raw_text)}</td>`
      + `<td>${esc(m.person_name || '—')}</td>`
      + `<td>${esc(lr.interpretation || lr.skipped || (m.processing_error ? 'ERRO: ' + m.processing_error : '—'))}</td>`
      + `<td>${esc(lr.categorization || '—')}</td>`
      + `<td>${(lr.actions || []).length}</td>`
      + `<td>${confBadge(conf)}</td>`
      + `<td class="muted">$${Number(lr.cost_estimate_usd || 0).toFixed(5)}</td></tr>`;
  }).join('');
  const body = `<p class="muted">${r.rows.length} mensagens${date ? ' em ' + esc(date) : ''}.</p>`
    + '<table><tr><th>hora</th><th>conta</th><th>texto</th><th>autor V3</th>'
    + '<th>interpretação</th><th>categoria</th><th>#ações</th><th>conf</th><th>custo</th></tr>'
    + (rows || '<tr><td colspan="9" class="muted">vazio</td></tr>') + '</table>';
  return { status: 200, contentType: 'text/html', body: page('Mensagens (shadow)', req.query.pin, body) };
}

async function handleEventsShadow(req, deps) {
  if (!checkPin(req)) return deny();
  const limit = clampLimit(req.query.limit);
  const date = req.query.date;
  const where = date ? 'AND e.started_at::date = $2' : '';
  const params = date ? [limit, date] : [limit];
  const r = await deps.db.query(
    `SELECT e.id, e.person_id, e.started_at, e.ended_at, e.confidence, e.cowork_with,
            e.source_message_ts, e.product_batch_id, p.display_name AS person_name,
            at.display_name AS activity
     FROM v3.events e
     LEFT JOIN v3.persons p ON p.id = e.person_id
     LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
     WHERE e.deleted_at IS NULL ${where}
     ORDER BY p.display_name, e.started_at DESC LIMIT $1`, params);
  const byPerson = new Map();
  for (const e of r.rows) {
    const k = e.person_name || ('person ' + e.person_id);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(e);
  }
  let body = `<p class="muted">${r.rows.length} events em ${byPerson.size} pessoa(s).</p>`;
  for (const [person, evs] of byPerson) {
    body += `<h3>${esc(person)}</h3><table><tr><th>atividade</th><th>início</th><th>fim</th>`
      + '<th>conf</th><th>cowork</th><th>batch</th><th>src ts</th></tr>'
      + evs.map((e) => `<tr><td>${esc(e.activity || '(não classif.)')}</td>`
        + `<td>${esc((e.started_at || '').toString().slice(0, 19))}</td>`
        + `<td>${esc((e.ended_at || '').toString().slice(0, 19)) || '<span class="muted">ativo</span>'}</td>`
        + `<td>${confBadge(e.confidence)}</td>`
        + `<td>${(e.cowork_with || []).join(', ') || '—'}</td>`
        + `<td>${e.product_batch_id || '—'}</td>`
        + `<td class="muted">${esc(e.source_message_ts || '—')}</td></tr>`).join('')
      + '</table>';
  }
  return { status: 200, contentType: 'text/html', body: page('Events (shadow)', req.query.pin, body || '<p>vazio</p>') };
}

async function handleTimeline(req, deps) {
  if (!checkPin(req)) return deny();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const r = await deps.db.query(
    `SELECT e.person_id, e.started_at, e.ended_at, e.cowork_with,
            p.display_name AS person_name, at.display_name AS activity
     FROM v3.events e
     LEFT JOIN v3.persons p ON p.id = e.person_id
     LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
     WHERE e.deleted_at IS NULL AND e.started_at::date = $1
     ORDER BY p.display_name, e.started_at`, [date]);
  const byPerson = new Map();
  for (const e of r.rows) {
    const k = e.person_name || ('person ' + e.person_id);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(e);
  }
  let body = `<p class="muted">Preview do dashboard V3 — ${esc(date)}. `
    + 'O dashboard final (bonito) é o Sprint 3.</p>';
  for (const [person, evs] of byPerson) {
    body += `<h3>${esc(person)}</h3><p>` + evs.map((e) => {
      const hh = (e.started_at || '').toString().slice(11, 16);
      const cw = (e.cowork_with || []).length ? ' 🔗' : '';
      return '<span style="background:#1e293b;border:1px solid #334155;padding:3px 8px;'
        + `border-radius:4px;margin:2px;display:inline-block">${hh} ${esc(e.activity || '?')}${cw}</span>`;
    }).join(' ') + '</p>';
  }
  if (!byPerson.size) body += '<p class="muted">Nenhum event nesse dia.</p>';
  return { status: 200, contentType: 'text/html', body: page('Timeline', req.query.pin, body) };
}

async function handleDivergences(req, deps) {
  if (!checkPin(req)) return deny();
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const v3n = await deps.db.query(
    'SELECT COUNT(*) c FROM v3.events WHERE deleted_at IS NULL AND started_at::date = $1', [date]);
  let legacy = { tasks: 0, phases: 0 };
  try {
    const lt = await deps.db.query('SELECT COUNT(*) c FROM public.tasks WHERE started_at::date = $1', [date]);
    const lp = await deps.db.query('SELECT COUNT(*) c FROM public.phase_instances WHERE started_at::date = $1', [date]);
    legacy = { tasks: parseInt(lt.rows[0].c, 10), phases: parseInt(lp.rows[0].c, 10) };
  } catch (_) { /* legado pode não casar a coluna — comparação coarse */ }
  const v3count = parseInt(v3n.rows[0].c, 10);
  const evs = await deps.db.query(
    `SELECT e.started_at, p.display_name AS person_name, at.display_name AS activity
     FROM v3.events e
     LEFT JOIN v3.persons p ON p.id = e.person_id
     LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
     WHERE e.deleted_at IS NULL AND e.started_at::date = $1
     ORDER BY e.started_at LIMIT 100`, [date]);
  const body = `<p>Dia <b>${esc(date)}</b>. V3 criou <span class="big">${v3count}</span> events. `
    + `Legado: tasks=${legacy.tasks}, phase_instances=${legacy.phases}.</p>`
    + '<p class="muted">Comparação coarse (contagem do dia). O legado está praticamente '
    + 'morto — divergência alta é ESPERADA (V3 captando o que o legado perdeu). '
    + 'Matching per-mensagem fica pro dashboard do Sprint 3.</p>'
    + '<table><tr><th>início</th><th>pessoa</th><th>atividade</th><th>origem</th></tr>'
    + evs.rows.map((e) => `<tr><td class="muted">${esc((e.started_at || '').toString().slice(0, 19))}</td>`
      + `<td>${esc(e.person_name || '—')}</td><td>${esc(e.activity || '—')}</td>`
      + '<td><span style="color:#38bdf8">V3-only</span></td></tr>').join('')
    + '</table>';
  return { status: 200, contentType: 'text/html', body: page('Divergências', req.query.pin, body) };
}

async function handleVocabularyPending(req, deps) {
  if (!checkPin(req)) return deny();
  const r = await deps.db.query(
    `SELECT term, occurrence_count, context_examples, meaning, first_seen_at
     FROM v3.vocabulary
     WHERE occurrence_count >= 3 AND admin_confirmed = false
     ORDER BY occurrence_count DESC`);
  const body = `<p class="muted">${r.rows.length} termo(s) com 3+ ocorrências aguardando confirmação.</p>`
    + '<table><tr><th>termo</th><th>ocorrências</th><th>significado inferido</th><th>1º visto</th></tr>'
    + (r.rows.map((v) => `<tr><td><b>${esc(v.term)}</b></td><td>${v.occurrence_count}</td>`
      + `<td>${esc(v.meaning || '(não inferido)')}</td>`
      + `<td class="muted">${esc((v.first_seen_at || '').toString().slice(0, 19))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">nenhum</td></tr>')
    + '</table>';
  return { status: 200, contentType: 'text/html', body: page('Vocabulário pendente', req.query.pin, body) };
}

async function handleLlmMetrics(req, deps) {
  if (!checkPin(req)) return deny();
  const from = req.query.from || null;
  const to = req.query.to || null;
  const cond = [];
  const params = [];
  if (from) { params.push(from); cond.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); cond.push(`created_at <= $${params.length}`); }
  const filter = cond.length ? cond.join(' AND ') + ' AND ' : '';
  const r = await deps.db.query(
    `SELECT llm_result, processing_error FROM v3.messages
     WHERE ${filter}(llm_processed_at IS NOT NULL OR processing_error IS NOT NULL)`, params);
  const m = { total: 0, byConf: {}, byCat: {}, cost: 0, errors: 0 };
  for (const row of r.rows) {
    if (row.processing_error) { m.errors++; continue; }
    m.total++;
    const lr = row.llm_result || {};
    const c = lr.confidence_overall || lr.skipped || '?';
    m.byConf[c] = (m.byConf[c] || 0) + 1;
    const cat = lr.categorization || (lr.skipped ? 'skipped' : '?');
    m.byCat[cat] = (m.byCat[cat] || 0) + 1;
    m.cost += Number(lr.cost_estimate_usd || 0);
  }
  const kv = (o) => Object.entries(o).map(([k, v]) => `${esc(k)}: <b>${v}</b>`).join(' &nbsp; ') || '—';
  const body = `<p>Processadas: <span class="big">${m.total}</span> &nbsp; `
    + `Erros/retry: <b>${m.errors}</b> &nbsp; Custo total: <b>$${m.cost.toFixed(4)}</b> &nbsp; `
    + `Custo médio/msg: <b>$${(m.total ? m.cost / m.total : 0).toFixed(5)}</b></p>`
    + `<p>Por confiança: ${kv(m.byConf)}</p><p>Por categorização: ${kv(m.byCat)}</p>`
    + '<p class="muted">Período: ' + esc(from || 'início') + ' → ' + esc(to || 'agora') + '</p>';
  return { status: 200, contentType: 'text/html', body: page('Métricas LLM', req.query.pin, body) };
}

async function handleHealth(req, deps) {
  if (!checkPin(req)) return deny();
  const queue = await deps.db.query('SELECT COUNT(*) c FROM v3.messages WHERE llm_processed_at IS NULL');
  const last = await deps.db.query('SELECT MAX(llm_processed_at) mx FROM v3.messages');
  const errs = await deps.db.query('SELECT COUNT(*) c FROM v3.messages WHERE processing_error IS NOT NULL');
  let provider = '?';
  let mode = '?';
  let lastTick = null;
  try {
    const ps = await deps.db.query(
      "SELECT key, value FROM v3.settings WHERE key IN ('llm_provider','llm_observer_mode','observer_last_tick_at')");
    for (const row of ps.rows) {
      const val = typeof row.value === 'string' ? row.value.replace(/"/g, '') : row.value;
      if (row.key === 'llm_provider') provider = val;
      if (row.key === 'llm_observer_mode') mode = val;
      if (row.key === 'observer_last_tick_at') lastTick = val;
    }
  } catch (_) { /* settings ausente */ }
  const lastTs = last.rows[0].mx;
  // worker vivo = heartbeat (observer_last_tick_at) recente. Fallback:
  // recência da última msg processada (caso o heartbeat não exista).
  const tickAgeSec = lastTick ? Math.round((Date.now() - new Date(lastTick).getTime()) / 1000) : null;
  const alive = tickAgeSec != null
    ? tickAgeSec < 120
    : (lastTs != null && (Date.now() - new Date(lastTs).getTime()) < 15 * 60000);
  const aliveLabel = alive ? '🟢 ativo'
    : (tickAgeSec != null ? '🔴 sem tick há ' + tickAgeSec + 's' : '🔴 sem heartbeat');
  const body = `<p>Worker: <b>${aliveLabel}</b> `
    + `<span class="muted">(heartbeat: ${esc((lastTick || 'nunca').toString().slice(0, 19))})</span></p>`
    + `<p>Fila (não-processadas): <span class="big">${queue.rows[0].c}</span></p>`
    + `<p>Última msg processada: ${esc((lastTs || 'nunca').toString().slice(0, 19))}</p>`
    + `<p>Mensagens com erro: <b>${errs.rows[0].c}</b></p>`
    + `<p>Provider: <b>${esc(provider)}</b> &nbsp; Modo do Observer: <b>${esc(mode)}</b></p>`;
  return { status: 200, contentType: 'text/html', body: page('Saúde do V3', req.query.pin, body) };
}

/**
 * Overview — visão consolidada do dia, dados ao vivo. Temporário,
 * pros 2-3 dias de validação do shadow. NÃO é o dashboard final.
 * Read-only; data no fuso America/New_York; auto-refresh 60s.
 */
async function handleOverview(req, deps) {
  if (!checkPin(req)) return deny();
  const db = deps.db;
  const date = req.query.date || nyDate();
  const pin = req.query.pin;

  // ── mensagens do dia (base das seções 1, 5, 6) ──
  const msgs = (await db.query(
    `SELECT m.created_at, m.slack_user_id, m.raw_text, m.llm_result,
            m.llm_processed_at, m.processing_error
     FROM v3.messages m
     WHERE (m.created_at AT TIME ZONE 'America/New_York')::date = $1
     ORDER BY m.created_at`, [date])).rows;

  // ── events do dia (seção 2) ──
  const events = (await db.query(
    `SELECT e.person_id, e.started_at, e.ended_at, e.cowork_with, e.confidence,
            p.display_name AS person_name, at.display_name AS activity, at.category
     FROM v3.events e
     LEFT JOIN v3.persons p ON p.id = e.person_id
     LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
     WHERE e.deleted_at IS NULL
       AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
     ORDER BY p.display_name, e.started_at`, [date])).rows;

  // ── produção do dia (seção 3) ──
  const counts = (await db.query(
    `SELECT pc.bottles, pc.reported_at, pc.confidence,
            pr.canonical_name AS product, pb.batch_number,
            per.display_name AS reporter
     FROM v3.production_counts pc
     JOIN v3.products pr ON pr.id = pc.product_id
     LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
     LEFT JOIN v3.persons per ON per.id = pc.reported_by_person_id
     WHERE pc.production_date = $1 AND pc.superseded_by IS NULL AND pc.deleted_at IS NULL
     ORDER BY pr.canonical_name, pc.reported_at`, [date])).rows;

  // ── lotes ativos AGORA (seção 4) — independe da data ──
  const activeBatches = (await db.query(
    `SELECT pb.id, pb.batch_number, pb.started_at, pr.canonical_name AS product
     FROM v3.product_batches pb
     JOIN v3.products pr ON pr.id = pb.product_id
     WHERE pb.status = 'in_progress' AND pb.deleted_at IS NULL
     ORDER BY pb.started_at`)).rows;
  const batchService = deps.batchService || new BatchService({ db });
  const batches = [];
  for (const b of activeBatches) {
    let summary = null;
    try { summary = await batchService.getSummary(b.id); } catch (_) { /* batch sumiu */ }
    batches.push({ batch: b, summary });
  }

  // ── derivações ──
  const processed = msgs.filter((m) => m.llm_processed_at);
  const withConf = processed.filter((m) => (m.llm_result || {}).confidence_overall);
  const highMed = withConf.filter((m) => ['high', 'medium'].includes(m.llm_result.confidence_overall));
  const pct = withConf.length ? Math.round((highMed.length / withConf.length) * 100) : null;
  const cost = msgs.reduce((s, m) => s + Number((m.llm_result || {}).cost_estimate_usd || 0), 0);

  const dist = {};
  for (const m of processed) {
    const lr = m.llm_result || {};
    const c = lr.confidence_overall || (lr.skipped ? 'skipped' : (m.processing_error ? 'erro' : 'outro'));
    dist[c] = (dist[c] || 0) + 1;
  }

  const attention = msgs.filter((m) => {
    const lr = m.llm_result || {};
    return ['low', 'unconfirmed'].includes(lr.confidence_overall) || lr.categorization === 'unclear';
  });

  // ── render ──
  const card = (label, value, sub) =>
    '<div style="display:inline-block;background:#1e293b;border:1px solid #334155;border-radius:8px;'
    + 'padding:12px 18px;margin:4px;min-width:120px">'
    + `<div class="muted" style="font-size:11px;text-transform:uppercase">${esc(label)}</div>`
    + `<div class="big">${esc(value)}</div>`
    + (sub ? `<div class="muted" style="font-size:11px">${esc(sub)}</div>` : '') + '</div>';

  const enc = encodeURIComponent(pin || '');
  let body = `<form style="margin-bottom:10px">`
    + `<input type="hidden" name="pin" value="${esc(pin || '')}">`
    + `dia: <input type="date" name="date" value="${esc(date)}" onchange="this.form.submit()"> `
    + `<span class="muted">America/New_York · atualiza sozinho a cada 60s · </span>`
    + `<a href="?pin=${enc}&date=${esc(date)}">atualizar agora</a></form>`;

  // SEÇÃO 1
  body += '<h2>Resumo do dia</h2><div>'
    + card('Mensagens lidas', msgs.length)
    + card('Events criados', events.length)
    + card('Alta+média confiança', pct == null ? '—' : pct + '%',
      withConf.length + ' c/ confiança')
    + card('Custo do dia', '$' + cost.toFixed(4))
    + '</div>';

  // SEÇÃO 2 — timeline por pessoa
  body += '<h2>Timeline por pessoa</h2>';
  const byPerson = new Map();
  for (const e of events) {
    const k = e.person_name || ('person ' + e.person_id);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(e);
  }
  if (!byPerson.size) {
    body += '<p class="muted">Nenhum event nesse dia.</p>';
  } else {
    for (const [person, evs] of byPerson) {
      const blocks = evs.map((e) => {
        const hh = (e.started_at || '').toString().slice(11, 16);
        const cw = (e.cowork_with || []).length ? ' 🔗' : '';
        const live = e.ended_at ? '' : ' •';
        const bg = CAT_BG[e.category] || '#1e293b';
        return `<span title="${esc(e.category || 'atividade')} — início ${esc(hh)}"`
          + ` style="background:${bg};border:1px solid #475569;padding:3px 8px;border-radius:4px;`
          + `margin:2px;display:inline-block;font-size:12px">${esc(hh)} ${esc(e.activity || '?')}${cw}${live}</span>`;
      }).join(' ');
      body += `<div style="margin:6px 0;padding:8px;background:#172033;border-radius:6px">`
        + `<b>${esc(person)}</b><br>${blocks}</div>`;
    }
    body += '<p class="muted" style="font-size:11px">'
      + `<span style="background:${CAT_BG.production_phase};padding:1px 6px;border-radius:3px">fase de produção</span> `
      + `<span style="background:${CAT_BG.support};padding:1px 6px;border-radius:3px">apoio</span> `
      + `<span style="background:${CAT_BG.meta};padding:1px 6px;border-radius:3px">pausa/almoço</span> `
      + ' &nbsp; 🔗 cowork &nbsp; • em andamento</p>';
  }

  // SEÇÃO 3 — produção
  body += '<h2>Produção do dia</h2>';
  if (!counts.length) {
    body += '<p class="muted">Nenhuma contagem reportada nesse dia.</p>';
  } else {
    const totByProd = {};
    for (const c of counts) totByProd[c.product] = (totByProd[c.product] || 0) + Number(c.bottles || 0);
    body += '<table><tr><th>produto</th><th>lote</th><th>garrafas</th><th>reportado por</th><th>hora</th></tr>'
      + counts.map((c) => `<tr><td>${esc(c.product)}</td><td>${esc(c.batch_number || '—')}</td>`
        + `<td>${esc(c.bottles)}</td><td>${esc(c.reporter || '—')}</td>`
        + `<td class="muted">${esc((c.reported_at || '').toString().slice(11, 16))}</td></tr>`).join('')
      + '</table>'
      + '<p>Total por produto: ' + Object.entries(totByProd)
        .map(([p, n]) => `${esc(p)}: <b>${n}</b>`).join(' &nbsp;·&nbsp; ') + '</p>';
  }

  // SEÇÃO 4 — lotes ativos
  body += '<h2>Lotes ativos</h2>';
  if (!batches.length) {
    body += '<p class="muted">Nenhum lote in_progress.</p>';
  } else {
    body += '<table><tr><th>produto</th><th>lote</th><th>iniciado</th>'
      + '<th>pessoas que tocaram</th><th>tempo total</th></tr>'
      + batches.map(({ batch, summary }) => {
        const people = summary && summary.people.length
          ? summary.people.map((p) => esc(p.display_name || ('#' + p.person_id))).join(', ')
          : '—';
        const dur = summary ? fmtDur(summary.total_seconds) : '—';
        return `<tr><td>${esc(batch.product)}</td><td>${esc(batch.batch_number)}</td>`
          + `<td class="muted">${esc((batch.started_at || '').toString().slice(0, 16))}</td>`
          + `<td>${people}</td><td>${esc(dur)}</td></tr>`;
      }).join('') + '</table>'
      + '<p class="muted" style="font-size:11px">tempo total com dedup de cowork (BatchService).</p>';
  }

  // SEÇÃO 5 — distribuição de confiança
  body += '<h2>Distribuição de confiança (do dia)</h2>';
  const order = ['high', 'medium', 'low', 'unconfirmed', 'skipped', 'erro', 'outro'];
  const totalDist = Object.values(dist).reduce((a, b) => a + b, 0);
  const distRows = order.filter((k) => dist[k]).map((k) => {
    const n = dist[k];
    const w = totalDist ? Math.round((n / totalDist) * 100) : 0;
    const col = CONF_COLOR[k] || '#64748b';
    return `<div style="margin:3px 0"><span style="display:inline-block;width:96px">${esc(k)}</span>`
      + `<span style="display:inline-block;background:${col};height:14px;`
      + `width:${Math.max(w * 2, 6)}px;border-radius:3px;vertical-align:middle"></span> `
      + `<b>${n}</b> <span class="muted">(${w}%)</span></div>`;
  }).join('');
  body += distRows || '<p class="muted">Nada processado nesse dia.</p>';

  // SEÇÃO 6 — atenção
  body += '<h2>Atenção — precisa de revisão</h2>';
  body += `<p class="muted">${attention.length} mensagem(ns) com confiança low/unconfirmed `
    + 'ou categorização unclear.</p>';
  body += '<table><tr><th>hora</th><th>conta</th><th>texto</th><th>interpretação</th><th>conf</th></tr>'
    + (attention.map((m) => {
      const lr = m.llm_result || {};
      const c = lr.confidence_overall || (lr.categorization === 'unclear' ? 'unclear' : '?');
      return `<tr><td class="muted">${esc((m.created_at || '').toString().slice(11, 19))}</td>`
        + `<td>${esc(m.slack_user_id)}</td><td>${esc(m.raw_text)}</td>`
        + `<td>${esc(lr.interpretation || '—')}</td><td>${confBadge(c)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">nada — dia limpo</td></tr>')
    + '</table>';

  return {
    status: 200, contentType: 'text/html',
    body: page('Overview — ' + date, pin, body, { refresh: 60 }),
  };
}

const HANDLERS = {
  overview: handleOverview,
  'messages-shadow': handleMessagesShadow,
  'events-shadow': handleEventsShadow,
  timeline: handleTimeline,
  divergences: handleDivergences,
  'vocabulary-pending': handleVocabularyPending,
  'llm-metrics': handleLlmMetrics,
  health: handleHealth,
};

function createRouter(deps) {
  const express = require('express');
  const router = express.Router();
  for (const [slug, handler] of Object.entries(HANDLERS)) {
    router.get('/api/admin/v3/' + slug, async (req, res) => {
      try {
        const out = await handler(req, deps);
        res.status(out.status).type(out.contentType || 'text/html').send(out.body);
      } catch (e) {
        res.status(500).type('text/plain').send('erro: ' + e.message);
      }
    });
  }
  return router;
}

module.exports = {
  checkPin, createRouter, HANDLERS, nyDate, fmtDur,
  handleOverview, handleMessagesShadow, handleEventsShadow, handleTimeline,
  handleDivergences, handleVocabularyPending, handleLlmMetrics, handleHealth,
};
