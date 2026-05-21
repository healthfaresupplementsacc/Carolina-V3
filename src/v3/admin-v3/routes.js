'use strict';
/**
 * HEALTHFARE V3 — endpoints HTML /api/admin/v3/* (inspeção shadow)
 *
 * Read-only. Auth via PIN. HTML simples, sem framework.
 *
 * Bloco 0 / Etapa 3 — DESACOPLADO: os handlers NÃO têm mais SQL inline.
 * Consomem os MESMOS repos de leitura (src/v3/data/*) que a API JSON
 * /api/v3/data/*. Uma fonte de verdade de leitura; os handlers só
 * renderizam HTML a partir do `data` do repo (princípio motherboard).
 *
 * Exceção: /divergences faz 1 cross-ref ao LEGADO (public.tasks /
 * public.phase_instances) — não é dado v3, fica fora da camada de
 * repos; some no cutover.
 *
 * GET /api/admin/v3/overview · messages-shadow · events-shadow ·
 *     timeline · divergences · vocabulary-pending · llm-metrics · health
 */

const { buildRepos } = require('../data/router');
const { nyDate } = require('../data/ny-date');

const CONF_COLOR = { high: '#16a34a', medium: '#ca8a04', low: '#ea580c', unconfirmed: '#dc2626' };
const CAT_BG = { production_phase: '#1e3a8a', support: '#78350f', meta: '#4c1d95' };
const PAGES = [
  ['overview', 'Overview'],
  ['messages-shadow', 'Mensagens'], ['events-shadow', 'Events'], ['timeline', 'Timeline'],
  ['divergences', 'Divergências'], ['vocabulary-pending', 'Vocabulário'],
  ['llm-metrics', 'Métricas'], ['health', 'Saúde'],
];

/** Segundos → "Xh Ym" / "Ym". */
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** ISO (NY, vindo do repo) → "YYYY-MM-DDThh:mm:ss". */
function fmtTs(iso) {
  return iso ? String(iso).slice(0, 19) : '—';
}
/** ISO (NY) → "hh:mm". */
function fmtTime(iso) {
  return iso ? String(iso).slice(11, 16) : '?';
}

function checkPin(req) {
  const pin = (req.query && req.query.pin) || (req.headers && req.headers['x-admin-pin']);
  return String(pin || '') === String(process.env.ADMIN_PIN || '510510');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    + 'h3{font-size:13px;margin:14px 0 4px}'
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
const ok = (title, pin, body, opts) => ({
  status: 200, contentType: 'text/html', body: page(title, pin, body, opts),
});

// ── handlers ──────────────────────────────────────────────────
// Todos consomem deps.repos (a mesma camada da API /api/v3/data/*).

async function handleMessagesShadow(req, deps) {
  if (!checkPin(req)) return deny();
  const out = await deps.repos.messages.messagesByDay(req.query.date, { limit: req.query.limit });
  const rows = out.messages.map((m) =>
    `<tr><td class="muted">${esc(fmtTs(m.created_at))}</td>`
    + `<td>${esc(m.slack_user_id)}</td><td>${esc(m.raw_text)}</td>`
    + `<td>${esc((m.person && m.person.display_name) || '—')}</td>`
    + `<td>${esc(m.interpretation || m.skipped
      || (m.processing_error ? 'ERRO: ' + m.processing_error : '—'))}</td>`
    + `<td>${esc(m.categorization || '—')}</td>`
    + `<td>${m.action_count}</td>`
    + `<td>${confBadge(m.confidence)}</td>`
    + `<td class="muted">$${Number(m.cost_estimate_usd || 0).toFixed(5)}</td></tr>`).join('');
  const body = `<p class="muted">${out.messages.length} mensagens em ${esc(out.date)}.</p>`
    + '<table><tr><th>hora</th><th>conta</th><th>texto</th><th>autor V3</th>'
    + '<th>interpretação</th><th>categoria</th><th>#ações</th><th>conf</th><th>custo</th></tr>'
    + (rows || '<tr><td colspan="9" class="muted">vazio</td></tr>') + '</table>';
  return ok('Mensagens (shadow)', req.query.pin, body);
}

async function handleEventsShadow(req, deps) {
  if (!checkPin(req)) return deny();
  const out = await deps.repos.timeline.eventsByDay(req.query.date);
  const total = out.people.reduce((s, p) => s + p.events.length, 0);
  let body = `<p class="muted">${total} events em ${out.people.length} pessoa(s) — ${esc(out.date)}.</p>`;
  for (const p of out.people) {
    body += `<h3>${esc(p.display_name || ('person ' + p.person_id))}</h3>`
      + '<table><tr><th>atividade</th><th>início</th><th>fim</th>'
      + '<th>conf</th><th>cowork</th><th>batch</th><th>src ts</th></tr>'
      + p.events.map((e) => `<tr><td>${esc(e.activity ? e.activity.display_name : '(não classif.)')}</td>`
        + `<td>${esc(fmtTs(e.started_at))}</td>`
        + `<td>${e.ended_at ? esc(fmtTs(e.ended_at)) : '<span class="muted">ativo</span>'}</td>`
        + `<td>${confBadge(e.confidence)}</td>`
        + `<td>${(e.cowork_with || []).join(', ') || '—'}</td>`
        + `<td>${e.product_batch_id || '—'}</td>`
        + `<td class="muted">${esc(e.source_message_ts || '—')}</td></tr>`).join('')
      + '</table>';
  }
  return ok('Events (shadow)', req.query.pin, body || '<p>vazio</p>');
}

async function handleTimeline(req, deps) {
  if (!checkPin(req)) return deny();
  const out = await deps.repos.timeline.eventsByDay(req.query.date);
  let body = `<p class="muted">Preview do dashboard V3 — ${esc(out.date)}. `
    + 'O dashboard final (bonito) é o Sprint 3.</p>';
  for (const p of out.people) {
    body += `<h3>${esc(p.display_name || ('person ' + p.person_id))}</h3><p>`
      + p.events.map((e) => {
        const cw = (e.cowork_with || []).length ? ' 🔗' : '';
        const name = e.activity ? e.activity.display_name : '?';
        return '<span style="background:#1e293b;border:1px solid #334155;padding:3px 8px;'
          + `border-radius:4px;margin:2px;display:inline-block">${esc(fmtTime(e.started_at))} `
          + `${esc(name)}${cw}</span>`;
      }).join(' ') + '</p>';
  }
  if (!out.people.length) body += '<p class="muted">Nenhum event nesse dia.</p>';
  return ok('Timeline', req.query.pin, body);
}

async function handleDivergences(req, deps) {
  if (!checkPin(req)) return deny();
  const out = await deps.repos.timeline.eventsByDay(req.query.date);
  const date = out.date;
  const evs = [];
  for (const p of out.people) {
    for (const e of p.events) evs.push({ started_at: e.started_at, person: p.display_name, activity: e.activity });
  }
  evs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const v3count = evs.length;

  // cross-ref ao LEGADO — NÃO é dado v3 (fora da camada de repos);
  // some no cutover. Query inline assumida e documentada.
  let legacy = { tasks: 0, phases: 0 };
  try {
    const lt = await deps.db.query('SELECT COUNT(*) c FROM public.tasks WHERE started_at::date = $1', [date]);
    const lp = await deps.db.query('SELECT COUNT(*) c FROM public.phase_instances WHERE started_at::date = $1', [date]);
    legacy = { tasks: parseInt(lt.rows[0].c, 10), phases: parseInt(lp.rows[0].c, 10) };
  } catch (_) { /* legado pode não casar a coluna — comparação coarse */ }

  const body = `<p>Dia <b>${esc(date)}</b>. V3 criou <span class="big">${v3count}</span> events. `
    + `Legado: tasks=${legacy.tasks}, phase_instances=${legacy.phases}.</p>`
    + '<p class="muted">Comparação coarse (contagem do dia). O legado está praticamente '
    + 'morto — divergência alta é ESPERADA (V3 captando o que o legado perdeu). '
    + 'Matching per-mensagem fica pro dashboard do Sprint 3.</p>'
    + '<table><tr><th>início</th><th>pessoa</th><th>atividade</th><th>origem</th></tr>'
    + evs.slice(0, 100).map((e) => `<tr><td class="muted">${esc(fmtTs(e.started_at))}</td>`
      + `<td>${esc(e.person || '—')}</td><td>${esc(e.activity ? e.activity.display_name : '—')}</td>`
      + '<td><span style="color:#38bdf8">V3-only</span></td></tr>').join('')
    + '</table>';
  return ok('Divergências', req.query.pin, body);
}

async function handleVocabularyPending(req, deps) {
  if (!checkPin(req)) return deny();
  const out = await deps.repos.vocabulary.pending();
  const body = `<p class="muted">${out.terms.length} termo(s) com 3+ ocorrências aguardando confirmação.</p>`
    + '<table><tr><th>termo</th><th>ocorrências</th><th>significado inferido</th><th>1º visto</th></tr>'
    + (out.terms.map((v) => `<tr><td><b>${esc(v.term)}</b></td><td>${v.occurrence_count}</td>`
      + `<td>${esc(v.meaning || '(não inferido)')}</td>`
      + `<td class="muted">${esc(fmtTs(v.first_seen_at))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">nenhum</td></tr>')
    + '</table>';
  return ok('Vocabulário pendente', req.query.pin, body);
}

async function handleLlmMetrics(req, deps) {
  if (!checkPin(req)) return deny();
  const from = req.query.from || null;
  const to = req.query.to || null;
  const m = await deps.repos.metrics.metricsRange(from, to);
  const kv = (o) => Object.entries(o).map(([k, v]) => `${esc(k)}: <b>${v}</b>`).join(' &nbsp; ') || '—';
  const body = `<p>Processadas: <span class="big">${m.total_processed}</span> &nbsp; `
    + `Erros/retry: <b>${m.errors}</b> &nbsp; Custo total: <b>$${Number(m.cost_estimate_usd).toFixed(4)}</b> &nbsp; `
    + `Custo médio/msg: <b>$${Number(m.avg_cost_per_msg).toFixed(5)}</b></p>`
    + `<p>Por confiança: ${kv(m.by_confidence)}</p><p>Por categorização: ${kv(m.by_categorization)}</p>`
    + '<p class="muted">Período: ' + esc(from || 'início') + ' → ' + esc(to || 'agora') + '</p>';
  return ok('Métricas LLM', req.query.pin, body);
}

async function handleHealth(req, deps) {
  if (!checkPin(req)) return deny();
  const h = await deps.repos.health.workerHealth();
  const tickAge = h.worker.tick_age_seconds;
  const aliveLabel = h.worker.alive ? '🟢 ativo'
    : (tickAge != null ? '🔴 sem tick há ' + tickAge + 's' : '🔴 sem heartbeat');
  const body = `<p>Worker: <b>${aliveLabel}</b> `
    + `<span class="muted">(heartbeat: ${esc(fmtTs(h.worker.last_tick_at) || 'nunca')})</span></p>`
    + `<p>Fila (não-processadas): <span class="big">${h.queue}</span></p>`
    + `<p>Última msg processada: ${esc(fmtTs(h.last_processed_at) || 'nunca')}</p>`
    + `<p>Mensagens com erro: <b>${h.errors}</b></p>`
    + `<p>Provider: <b>${esc(h.provider || '?')}</b> &nbsp; Modo do Observer: <b>${esc(h.mode || '?')}</b></p>`;
  return ok('Saúde do V3', req.query.pin, body);
}

/**
 * Overview — visão consolidada do dia, dados ao vivo. Temporário,
 * pros 2-3 dias de validação do shadow. NÃO é o dashboard final.
 * Consome os repos; data no fuso America/New_York; auto-refresh 60s.
 */
async function handleOverview(req, deps) {
  if (!checkPin(req)) return deny();
  const date = req.query.date || nyDate();
  const pin = req.query.pin;
  const repos = deps.repos;

  const [msgsOut, timeline, countsOut, batchesOut] = await Promise.all([
    repos.messages.messagesByDay(date, { limit: 500 }),
    repos.timeline.eventsByDay(date),
    repos.counts.countsByDay(date),
    repos.batches.activeBatches(),
  ]);
  const msgs = msgsOut.messages;
  const eventCount = timeline.people.reduce((s, p) => s + p.events.length, 0);

  // ── derivações (seções 1, 5, 6) ──
  const processed = msgs.filter((m) => m.processed);
  const CONF = ['high', 'medium', 'low', 'unconfirmed'];
  const withConf = processed.filter((m) => CONF.includes(m.confidence));
  const highMed = withConf.filter((m) => ['high', 'medium'].includes(m.confidence));
  const pct = withConf.length ? Math.round((highMed.length / withConf.length) * 100) : null;
  const cost = msgs.reduce((s, m) => s + Number(m.cost_estimate_usd || 0), 0);

  const dist = {};
  for (const m of processed) {
    const c = CONF.includes(m.confidence) ? m.confidence
      : (m.confidence === 'skipped' ? 'skipped' : (m.processing_error ? 'erro' : 'outro'));
    dist[c] = (dist[c] || 0) + 1;
  }
  const attention = msgs.filter((m) =>
    ['low', 'unconfirmed'].includes(m.confidence) || m.categorization === 'unclear');

  // ── render ──
  const card = (label, value, sub) =>
    '<div style="display:inline-block;background:#1e293b;border:1px solid #334155;border-radius:8px;'
    + 'padding:12px 18px;margin:4px;min-width:120px">'
    + `<div class="muted" style="font-size:11px;text-transform:uppercase">${esc(label)}</div>`
    + `<div class="big">${esc(value)}</div>`
    + (sub ? `<div class="muted" style="font-size:11px">${esc(sub)}</div>` : '') + '</div>';

  const enc = encodeURIComponent(pin || '');
  let body = '<form style="margin-bottom:10px">'
    + `<input type="hidden" name="pin" value="${esc(pin || '')}">`
    + `dia: <input type="date" name="date" value="${esc(date)}" onchange="this.form.submit()"> `
    + '<span class="muted">America/New_York · atualiza sozinho a cada 60s · </span>'
    + `<a href="?pin=${enc}&date=${esc(date)}">atualizar agora</a></form>`;

  // SEÇÃO 1
  body += '<h2>Resumo do dia</h2><div>'
    + card('Mensagens lidas', msgs.length)
    + card('Events criados', eventCount)
    + card('Alta+média confiança', pct == null ? '—' : pct + '%', withConf.length + ' c/ confiança')
    + card('Custo do dia', '$' + cost.toFixed(4))
    + '</div>';

  // SEÇÃO 2 — timeline por pessoa
  body += '<h2>Timeline por pessoa</h2>';
  if (!timeline.people.length) {
    body += '<p class="muted">Nenhum event nesse dia.</p>';
  } else {
    for (const p of timeline.people) {
      const blocks = p.events.map((e) => {
        const hh = fmtTime(e.started_at);
        const cw = (e.cowork_with || []).length ? ' 🔗' : '';
        const live = e.ended_at ? '' : ' •';
        const cat = e.activity ? e.activity.category : null;
        const name = e.activity ? e.activity.display_name : '?';
        const bg = CAT_BG[cat] || '#1e293b';
        return `<span title="${esc(cat || 'atividade')} — início ${esc(hh)}"`
          + ` style="background:${bg};border:1px solid #475569;padding:3px 8px;border-radius:4px;`
          + `margin:2px;display:inline-block;font-size:12px">${esc(hh)} ${esc(name)}${cw}${live}</span>`;
      }).join(' ');
      body += '<div style="margin:6px 0;padding:8px;background:#172033;border-radius:6px">'
        + `<b>${esc(p.display_name || ('person ' + p.person_id))}</b><br>${blocks}</div>`;
    }
    body += '<p class="muted" style="font-size:11px">'
      + `<span style="background:${CAT_BG.production_phase};padding:1px 6px;border-radius:3px">fase de produção</span> `
      + `<span style="background:${CAT_BG.support};padding:1px 6px;border-radius:3px">apoio</span> `
      + `<span style="background:${CAT_BG.meta};padding:1px 6px;border-radius:3px">pausa/almoço</span> `
      + ' &nbsp; 🔗 cowork &nbsp; • em andamento</p>';
  }

  // SEÇÃO 3 — produção
  body += '<h2>Produção do dia</h2>';
  if (!countsOut.counts.length) {
    body += '<p class="muted">Nenhuma contagem reportada nesse dia.</p>';
  } else {
    body += '<table><tr><th>produto</th><th>lote</th><th>garrafas</th><th>reportado por</th><th>hora</th></tr>'
      + countsOut.counts.map((c) => `<tr><td>${esc(c.product.canonical_name)}</td>`
        + `<td>${esc(c.batch ? c.batch.batch_number : '—')}</td>`
        + `<td>${esc(c.bottles)}</td>`
        + `<td>${esc(c.reporter ? c.reporter.display_name : '—')}</td>`
        + `<td class="muted">${esc(fmtTime(c.reported_at))}</td></tr>`).join('')
      + '</table>'
      + '<p>Total por produto: ' + Object.entries(countsOut.totals_by_product)
        .map(([p, n]) => `${esc(p)}: <b>${n}</b>`).join(' &nbsp;·&nbsp; ') + '</p>';
  }

  // SEÇÃO 4 — lotes ativos
  body += '<h2>Lotes ativos</h2>';
  if (!batchesOut.active.length) {
    body += '<p class="muted">Nenhum lote in_progress.</p>';
  } else {
    body += '<table><tr><th>produto</th><th>lote</th><th>iniciado</th>'
      + '<th>pessoas que tocaram</th><th>tempo total</th></tr>'
      + batchesOut.active.map((b) => {
        const people = b.people.length
          ? b.people.map((p) => esc(p.display_name || ('#' + p.person_id))).join(', ')
          : '—';
        return `<tr><td>${esc(b.product.canonical_name)}</td><td>${esc(b.batch_number)}</td>`
          + `<td class="muted">${esc(fmtTs(b.started_at))}</td>`
          + `<td>${people}</td><td>${esc(fmtDur(b.total_seconds))}</td></tr>`;
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
      const c = m.confidence || (m.categorization === 'unclear' ? 'unclear' : '?');
      return `<tr><td class="muted">${esc(fmtTime(m.created_at))}</td>`
        + `<td>${esc(m.slack_user_id)}</td><td>${esc(m.raw_text)}</td>`
        + `<td>${esc(m.interpretation || '—')}</td><td>${confBadge(c)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">nada — dia limpo</td></tr>')
    + '</table>';

  return ok('Overview — ' + date, pin, body, { refresh: 60 });
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

/**
 * Router Express. Constrói os repos uma vez (buildRepos) e injeta em
 * todos os handlers — a mesma camada de leitura da API JSON.
 */
function createRouter(deps = {}) {
  const express = require('express');
  const router = express.Router();
  const repos = deps.repos || buildRepos(deps.db);
  const handlerDeps = { db: deps.db, repos };
  for (const [slug, handler] of Object.entries(HANDLERS)) {
    router.get('/api/admin/v3/' + slug, async (req, res) => {
      try {
        const out = await handler(req, handlerDeps);
        res.status(out.status).type(out.contentType || 'text/html').send(out.body);
      } catch (e) {
        res.status(500).type('text/plain').send('erro: ' + e.message);
      }
    });
  }
  return router;
}

module.exports = {
  checkPin, createRouter, HANDLERS, fmtDur, fmtTs, fmtTime,
  handleOverview, handleMessagesShadow, handleEventsShadow, handleTimeline,
  handleDivergences, handleVocabularyPending, handleLlmMetrics, handleHealth,
};
