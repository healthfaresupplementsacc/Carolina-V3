'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.10 — endpoints /api/admin/v3/* (inspeção shadow)
 *
 * Read-only. Auth via PIN (mesmo do legado, ADMIN_PIN). HTML simples,
 * sem framework. É por aqui que o Bruno decide se o V3 está pronto
 * pro cutover — foco em legibilidade.
 *
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

const CONF_COLOR = { high: '#16a34a', medium: '#ca8a04', low: '#ea580c', unconfirmed: '#dc2626' };
const PAGES = [
  ['messages-shadow', 'Mensagens'], ['events-shadow', 'Events'], ['timeline', 'Timeline'],
  ['divergences', 'Divergências'], ['vocabulary-pending', 'Vocabulário'],
  ['llm-metrics', 'Métricas'], ['health', 'Saúde'],
];

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

function page(title, pin, body) {
  const nav = PAGES.map(([slug, label]) =>
    `<a href="/api/admin/v3/${slug}?pin=${encodeURIComponent(pin || '')}">${label}</a>`).join(' · ');
  return '<!doctype html><html><head><meta charset="utf-8"><title>V3 — ' + esc(title) + '</title>'
    + '<style>body{font-family:system-ui,sans-serif;margin:18px;background:#0f172a;color:#e2e8f0}'
    + 'h1{font-size:18px}a{color:#38bdf8;text-decoration:none}nav{margin:8px 0 16px;font-size:13px}'
    + 'table{border-collapse:collapse;width:100%;font-size:12px}'
    + 'th,td{border:1px solid #334155;padding:5px 7px;text-align:left;vertical-align:top}'
    + 'th{background:#1e293b}tr:nth-child(even){background:#172033}'
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

const HANDLERS = {
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
  checkPin, createRouter, HANDLERS,
  handleMessagesShadow, handleEventsShadow, handleTimeline, handleDivergences,
  handleVocabularyPending, handleLlmMetrics, handleHealth,
};
