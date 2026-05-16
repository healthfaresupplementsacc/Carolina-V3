'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const tasks = require('../tasks');
const { generateDashboard, generateEodSummary } = require('./template');

// BUG PIN — shared 10-min admin session across the dashboard and every
// /admin/* page. Same localStorage key/shape/TTL as the dashboard's A2
// (hf_admin = {pin, ts}, 10 min, sliding). Injected at the end of each
// admin page's script: defines hfAdminSave/hfAdminClear and, if a valid
// session exists, pre-fills the PIN and auto-unlocks (server still
// PIN-checks every request). The countdown is shared because it derives
// from the single hf_admin.ts.
const ADMIN_SESSION_JS = "(function(){var K='hf_admin',T=600000;"
  + "function rd(){try{var s=JSON.parse(localStorage.getItem(K)||'null');"
  + "return (s&&s.pin&&Date.now()-s.ts<T)?s:null;}catch(e){return null;}}"
  + "window.hfAdminSave=function(p){try{localStorage.setItem(K,JSON.stringify({pin:p,ts:Date.now()}));}catch(e){}};"
  + "window.hfAdminClear=function(){try{localStorage.removeItem(K);}catch(e){}};"
  + "var s=rd();if(s){var pi=document.getElementById('pin-input')||document.getElementById('pin');if(pi)pi.value=s.pin;"
  + "var f=window.unlock||window.unlockAdmin;if(typeof f==='function'){try{f();}catch(e){}}}})();";

// Main dashboard page
router.get('/', (req, res) => {
  res.send(generateDashboard());
});

// EOD summary page (for screenshot)
router.get('/eod-summary', async (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todayTasks = await tasks.getTodayTasks();
  const openTasks = await tasks.getOpenTasks();

  // Filter out null supplement names from both lists
  const filteredTasks = todayTasks.filter(t => t.supplement_name && t.supplement_name !== 'null');
  const filteredOpen = openTasks.filter(t => t.supplement_name && t.supplement_name !== 'null');

  // Prefer prod_summary from app_state (operator-reported total), fall back to production_counts
  let totalBottles = 0;
  const summaryRow = await db.query(
    `SELECT value FROM app_state WHERE key = $1`,
    [`prod_summary_${date}`]
  );
  if (summaryRow.rows.length > 0) {
    try {
      const summary = JSON.parse(summaryRow.rows[0].value);
      totalBottles = parseInt(summary.totalBottles) || 0;
    } catch (_) {}
  }
  if (!totalBottles) {
    const countResult = await db.query(
      `SELECT SUM(count) as total FROM production_counts WHERE reported_at::date = $1::date`,
      [date]
    );
    totalBottles = parseInt(countResult.rows[0]?.total || 0);
  }

  const formattedDate = new Date(date + 'T12:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  res.send(generateEodSummary({ tasks: filteredTasks, totalBottles, date: formattedDate, openTasks: filteredOpen }));
});

// Archive day view
router.get('/archive/:date', async (req, res) => {
  const { date } = req.params;
  const snap = await db.query('SELECT * FROM eod_snapshots WHERE snapshot_date = $1', [date]);
  if (!snap.rows.length) return res.status(404).send('Snapshot não encontrado');

  const s = snap.rows[0];
  const data = s.data_json || {};
  const formattedDate = new Date(date + 'T12:00:00Z').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  res.send(generateEodSummary({
    tasks: data.tasks || [],
    totalBottles: s.total_bottles || 0,
    date: formattedDate,
    openTasks: data.openTasks || [],
  }));
});

// Admin page — Entrega 2 commit 12: full CRUD for operators + supplements
// served as a separate page so the main dashboard stays focused on the
// production-line view. PIN gate is handled client-side via fetch to
// the existing /api/admin/* endpoints (which already enforce the PIN
// and write to admin_audit_log).
router.get('/admin', async (req, res) => {
  const state = await db.query('SELECT key, value, updated_at FROM app_state ORDER BY key');
  const stateRows = state.rows;

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Admin — HealthFare</title>
  <style>
    body { font-family: -apple-system, sans-serif; padding: 24px; max-width: 980px; margin: 0 auto; color: #1f2937; background:#f5f7fb; }
    h1 { color: #1d4f91; margin-bottom: 24px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin: 28px 0 12px; }
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:16px; margin-bottom:16px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
    th { background: #f9fafb; font-weight: 600; font-size:11px; text-transform:uppercase; color:#6b7280; }
    .btn { background: #1d4f91; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
    .btn-red { background: #ef4444; }
    .btn-green { background: #10b981; }
    .btn-gray { background: #6b7280; }
    .pill-on  { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; background: #d1fae5; color: #065f46; }
    .pill-off { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; background: #fee2e2; color: #991b1b; }
    input[type=text], input[type=number], select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; width: 100%; box-sizing: border-box; }
    .state-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f3f4f6; font-size: 12px; }
    .state-row code { background:#f3f4f6; padding:1px 6px; border-radius:3px; }
    a { color: #1d4f91; }
    .back { display: inline-block; margin-bottom: 20px; color: #1d4f91; text-decoration: none; }
    .row { display:grid; grid-template-columns: 130px 130px 1fr 100px 80px 120px; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid #f3f4f6; }
    .row-head { font-size:11px; text-transform:uppercase; color:#6b7280; font-weight:600; }
    .form-add { display:grid; grid-template-columns: 130px 130px 1fr 100px 80px 120px; gap:8px; align-items:center; padding-top:8px; }
    #pin-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
    #pin-overlay .box { background:#fff; padding:24px; border-radius:10px; min-width:280px; }
    #pin-overlay input { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:14px; margin:8px 0; }
    .err { color:#ef4444; font-size:12px; margin-top:6px; min-height:14px; }
    .hint { color:#6b7280; font-size:11px; margin-top:4px; }
  </style>
</head>
<body>
  <div id="pin-overlay">
    <div class="box">
      <strong>Admin PIN</strong>
      <input id="pin-input" type="password" autocomplete="off" placeholder="••••••" autofocus>
      <div class="err" id="pin-err"></div>
      <button class="btn" onclick="unlockAdmin()" style="width:100%">Entrar</button>
    </div>
  </div>

  <a href="/" class="back">← Voltar ao dashboard</a>
  <h1>Admin</h1>

  <div class="card">
    <h2 style="margin-top:0">Ferramentas</h2>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <a class="btn" style="text-decoration:none" href="/admin/carolina-config">⚙️ Config Carolina</a>
      <a class="btn btn-gray" style="text-decoration:none" href="/admin/workflows">Workflows</a>
      <a class="btn btn-gray" style="text-decoration:none" href="/admin/ad-hoc-tasks">Tarefas avulsas</a>
      <a class="btn btn-gray" style="text-decoration:none" href="/admin/audit">Auditoria</a>
      <a class="btn btn-gray" style="text-decoration:none" href="/admin/silent-log">Silent log</a>
    </div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Operadores</h2>
    <div class="row row-head">
      <span>Nome</span><span>Slack ID</span><span>Aliases (sep. ,)</span>
      <span>Role</span><span>Ativo</span><span>Ações</span>
    </div>
    <div id="ops-list">Carregando...</div>

    <div class="form-add">
      <input id="new-op-name" type="text" placeholder="Nome">
      <input id="new-op-slack" type="text" placeholder="Slack ID">
      <input id="new-op-aliases" type="text" placeholder="aliases">
      <input id="new-op-role" type="text" placeholder="role">
      <span></span>
      <button class="btn btn-green" onclick="createOperator()">+ Adicionar</button>
    </div>
    <div class="err" id="new-op-err"></div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Suplementos custom</h2>
    <div class="hint">A lista padrão de 73 suplementos vem hardcoded no parser. Aqui você só vê os adicionados manualmente.</div>
    <table>
      <thead><tr><th style="width:200px">Canonical</th><th>Aliases (sep. ,)</th><th style="width:140px">Ações</th></tr></thead>
      <tbody id="supps-list"><tr><td colspan="3">Carregando...</td></tr></tbody>
    </table>

    <div style="display:grid; grid-template-columns: 200px 1fr 120px; gap:8px; align-items:center; margin-top:8px">
      <input id="new-supp-name" type="text" placeholder="Canonical (ex: Chlorella)">
      <input id="new-supp-aliases" type="text" placeholder="aliases (ex: chlorela, clorella)">
      <button class="btn btn-green" onclick="createSupplement()">+ Adicionar</button>
    </div>
    <div class="err" id="new-supp-err"></div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Estado do Sistema (read-only)</h2>
    ${stateRows.map(r => `<div class="state-row"><code>${r.key}</code><span style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.value||'').replace(/"/g,'&quot;')}">${(r.value||'').slice(0,80)}${(r.value||'').length>80?'…':''}</span></div>`).join('')}
  </div>

  <script>
    let _pin = '';

    async function unlockAdmin() {
      const pin = document.getElementById('pin-input').value.trim();
      // Light validation: hit GET /api/admin/operators which requires the PIN.
      try {
        const r = await fetch('/api/admin/operators?pin=' + encodeURIComponent(pin));
        if (r.status === 403) {
          document.getElementById('pin-err').textContent = 'PIN incorreto';
          return;
        }
        if (!r.ok) {
          document.getElementById('pin-err').textContent = 'Erro ' + r.status;
          return;
        }
        _pin = pin; try { hfAdminSave(pin); } catch (e) {}
        document.getElementById('pin-overlay').style.display = 'none';
        loadOperators();
        loadSupplements();
      } catch (err) {
        document.getElementById('pin-err').textContent = 'Erro de conexão';
      }
    }
    document.getElementById('pin-input').addEventListener('keypress', e => {
      if (e.key === 'Enter') unlockAdmin();
    });
    ${ADMIN_SESSION_JS}

    function esc(s) { return String(s||'').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

    async function loadOperators() {
      const r = await fetch('/api/admin/operators?pin=' + encodeURIComponent(_pin));
      const ops = await r.json();
      document.getElementById('ops-list').innerHTML = ops.map(o => \`
        <div class="row" data-id="\${o.id}">
          <input type="text" value="\${esc(o.name)}" id="op-name-\${o.id}">
          <input type="text" value="\${esc(o.slack_user_id||'')}" id="op-slack-\${o.id}" placeholder="-">
          <input type="text" value="\${esc(o.aliases||'')}" id="op-aliases-\${o.id}">
          <input type="text" value="\${esc(o.role||'')}" id="op-role-\${o.id}">
          <span>\${o.active ? '<span class="pill-on">Ativo</span>' : '<span class="pill-off">Inativo</span>'}</span>
          <span style="display:flex;gap:4px">
            <button class="btn" onclick="saveOperator(\${o.id})">Salvar</button>
            <button class="btn \${o.active ? 'btn-red' : 'btn-green'}" onclick="toggleOperator(\${o.id}, \${o.active})">\${o.active ? 'Desativar' : 'Ativar'}</button>
          </span>
        </div>
      \`).join('');
    }

    async function saveOperator(id) {
      const body = {
        pin: _pin,
        name:          document.getElementById('op-name-'+id).value.trim(),
        slack_user_id: document.getElementById('op-slack-'+id).value.trim(),
        aliases:       document.getElementById('op-aliases-'+id).value.trim(),
        role:          document.getElementById('op-role-'+id).value.trim(),
      };
      const r = await fetch('/api/admin/operator/'+id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { alert(data.error || ('Erro ' + r.status)); return; }
      loadOperators();
    }

    async function toggleOperator(id, active) {
      if (active) {
        if (!confirm('Desativar esse operador?')) return;
        const r = await fetch('/api/admin/operator/'+id+'?pin='+encodeURIComponent(_pin), { method: 'DELETE' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { alert(data.error || 'Erro'); return; }
      } else {
        // Reactivate via PUT { active: true }
        const r = await fetch('/api/admin/operator/'+id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: _pin, active: true }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) { alert(data.error || 'Erro'); return; }
      }
      loadOperators();
    }

    async function createOperator() {
      const body = {
        pin: _pin,
        name:          document.getElementById('new-op-name').value.trim(),
        slack_user_id: document.getElementById('new-op-slack').value.trim() || null,
        aliases:       document.getElementById('new-op-aliases').value.trim(),
        role:          document.getElementById('new-op-role').value.trim() || null,
      };
      if (!body.name) {
        document.getElementById('new-op-err').textContent = 'Nome é obrigatório';
        return;
      }
      const r = await fetch('/api/admin/operator/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { document.getElementById('new-op-err').textContent = data.error || 'Erro'; return; }
      document.getElementById('new-op-err').textContent = '';
      ['new-op-name','new-op-slack','new-op-aliases','new-op-role'].forEach(id => document.getElementById(id).value = '');
      loadOperators();
    }

    async function loadSupplements() {
      // GET /api/supplements is public; custom-only is what we want
      const r = await fetch('/api/supplements');
      const allSupps = await r.json();
      // The endpoint returns hardcoded + custom; we don't have a way to
      // distinguish on the frontend, so list everything but only show
      // delete on items NOT in the hardcoded set. For simplicity here,
      // show everything and let the DELETE endpoint decide.
      document.getElementById('supps-list').innerHTML = allSupps.map(s => \`
        <tr>
          <td><strong>\${esc(s.canonical)}</strong></td>
          <td style="font-size:11px;color:#6b7280">\${esc(s.aliases || '')}</td>
          <td><button class="btn btn-red" onclick="deleteSupplement('\${esc(s.canonical)}')">Excluir custom</button></td>
        </tr>
      \`).join('') || '<tr><td colspan="3" style="color:#6b7280;padding:12px">Nenhum suplemento</td></tr>';
    }

    async function createSupplement() {
      const body = {
        pin: _pin,
        canonical_name: document.getElementById('new-supp-name').value.trim(),
        aliases:        document.getElementById('new-supp-aliases').value.trim(),
      };
      if (!body.canonical_name) {
        document.getElementById('new-supp-err').textContent = 'Nome é obrigatório';
        return;
      }
      const r = await fetch('/api/admin/supplement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { document.getElementById('new-supp-err').textContent = data.error || 'Erro'; return; }
      document.getElementById('new-supp-err').textContent = '';
      document.getElementById('new-supp-name').value = '';
      document.getElementById('new-supp-aliases').value = '';
      loadSupplements();
    }

    async function deleteSupplement(name) {
      if (!confirm('Excluir suplemento custom "' + name + '"? (não afeta os 73 padrão)')) return;
      const r = await fetch('/api/admin/supplement/' + encodeURIComponent(name) + '?pin=' + encodeURIComponent(_pin), { method: 'DELETE' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { alert(data.error || 'Erro'); return; }
      loadSupplements();
    }
  </script>
</body>
</html>`);
});

// Audit log viewer — Entrega 2 commit 13
router.get('/admin/audit', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Audit Log — HealthFare</title>
  <style>
    body { font-family: -apple-system, sans-serif; padding: 24px; max-width: 1100px; margin: 0 auto; color: #1f2937; background:#f5f7fb; }
    h1 { color: #1d4f91; margin-bottom: 24px; }
    .filters { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:12px 16px; display:flex; gap:8px; align-items:end; flex-wrap:wrap; margin-bottom:16px; }
    .filters label { display:flex; flex-direction:column; font-size:11px; color:#6b7280; text-transform:uppercase; font-weight:600; }
    .filters input, .filters select { padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; margin-top:4px; }
    .btn { background:#1d4f91; color:white; border:none; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
    .row { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:10px 14px; margin-bottom:8px; font-size:13px; }
    .row-head { display:flex; gap:12px; align-items:center; }
    .action-pill { background:#eef2ff; color:#3730a3; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:700; }
    .action-pill.delete { background:#fee2e2; color:#991b1b; }
    .action-pill.create { background:#d1fae5; color:#065f46; }
    .action-pill.merge  { background:#fef3c7; color:#92400e; }
    .ts { color:#6b7280; font-size:11px; }
    .entity { font-weight:600; }
    .details { margin-top:8px; font-size:11px; color:#374151; max-height:160px; overflow:auto; white-space:pre-wrap; background:#f9fafb; padding:8px; border-radius:4px; display:none; }
    .row.open .details { display:block; }
    a { color: #1d4f91; }
    .back { display: inline-block; margin-bottom: 20px; color: #1d4f91; text-decoration: none; }
    .pager { display:flex; justify-content:center; gap:8px; padding:16px 0; }
    .pager span { color:#6b7280; font-size:13px; align-self:center; }
    #pin-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
    #pin-overlay .box { background:#fff; padding:24px; border-radius:10px; min-width:280px; }
    #pin-overlay input { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:14px; margin:8px 0; }
    .err { color:#ef4444; font-size:12px; margin-top:6px; min-height:14px; }
  </style>
</head>
<body>
  <div id="pin-overlay">
    <div class="box">
      <strong>Admin PIN</strong>
      <input id="pin-input" type="password" autocomplete="off" autofocus>
      <div class="err" id="pin-err"></div>
      <button class="btn" onclick="unlock()" style="width:100%">Entrar</button>
    </div>
  </div>

  <a href="/" class="back">← Voltar ao dashboard</a>
  <h1>Audit Log</h1>

  <div class="filters">
    <label>Entidade
      <select id="f-entity">
        <option value="">(todas)</option>
        <option>task</option>
        <option>pause</option>
        <option>orders_session</option>
        <option>production_count</option>
        <option>operator</option>
        <option>supplement</option>
        <option>note</option>
        <option>formulation_session</option>
        <option>app_state</option>
        <option>broadcast</option>
        <option>cleanup</option>
      </select>
    </label>
    <label>Ação
      <input id="f-action" type="text" placeholder="ex: task.edit">
    </label>
    <label>ID
      <input id="f-id" type="text" placeholder="ex: 42">
    </label>
    <label>Desde
      <input id="f-since" type="date">
    </label>
    <button class="btn" onclick="reload()">Filtrar</button>
    <button class="btn" style="background:#6b7280" onclick="clearFilters()">Limpar</button>
  </div>

  <div id="results">Carregando...</div>
  <div class="pager">
    <button class="btn" onclick="prev()" id="prev-btn">← Anterior</button>
    <span id="page-info">—</span>
    <button class="btn" onclick="next()" id="next-btn">Próxima →</button>
  </div>

  <script>
    let _pin = '';
    let _offset = 0;
    const PAGE = 50;
    let _total = 0;

    async function unlock() {
      const pin = document.getElementById('pin-input').value.trim();
      try {
        const r = await fetch('/api/admin/audit?pin=' + encodeURIComponent(pin) + '&limit=1');
        if (r.status === 403) { document.getElementById('pin-err').textContent = 'PIN incorreto'; return; }
        if (!r.ok) { document.getElementById('pin-err').textContent = 'Erro ' + r.status; return; }
        _pin = pin; try { hfAdminSave(pin); } catch (e) {}
        document.getElementById('pin-overlay').style.display = 'none';
        reload();
      } catch (err) { document.getElementById('pin-err').textContent = 'Erro de conexão'; }
    }
    document.getElementById('pin-input').addEventListener('keypress', e => { if (e.key === 'Enter') unlock(); });
    ${ADMIN_SESSION_JS}

    function esc(s) { return String(s||'').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
    function classFor(action) {
      if (/delete|deactivate/.test(action)) return 'delete';
      if (/create/.test(action))            return 'create';
      if (/merge/.test(action))             return 'merge';
      return '';
    }

    function reload() { _offset = 0; load(); }
    function prev() { if (_offset > 0) { _offset -= PAGE; load(); } }
    function next() { if (_offset + PAGE < _total) { _offset += PAGE; load(); } }

    function clearFilters() {
      ['f-entity','f-action','f-id','f-since'].forEach(id => document.getElementById(id).value = '');
      reload();
    }

    async function load() {
      const params = new URLSearchParams({ pin: _pin, limit: PAGE, offset: _offset });
      const ent  = document.getElementById('f-entity').value;
      const act  = document.getElementById('f-action').value.trim();
      const id   = document.getElementById('f-id').value.trim();
      const sin  = document.getElementById('f-since').value;
      if (ent) params.set('entity_type', ent);
      if (act) params.set('action', act);
      if (id)  params.set('entity_id', id);
      if (sin) params.set('since', sin);

      try {
        const r = await fetch('/api/admin/audit?' + params.toString());
        const data = await r.json();
        if (!r.ok) { document.getElementById('results').innerHTML = '<div style="color:#ef4444">Erro: ' + (data.error || r.status) + '</div>'; return; }
        _total = data.total;
        document.getElementById('page-info').textContent =
          (_total === 0 ? '0 resultados' : (_offset + 1) + '–' + Math.min(_offset + PAGE, _total) + ' de ' + _total);
        document.getElementById('prev-btn').disabled = _offset === 0;
        document.getElementById('next-btn').disabled = _offset + PAGE >= _total;

        if (data.rows.length === 0) {
          document.getElementById('results').innerHTML = '<div style="text-align:center;color:#6b7280;padding:32px">Nenhum evento</div>';
          return;
        }

        document.getElementById('results').innerHTML = data.rows.map(row => {
          const cls = classFor(row.action);
          const when = new Date(row.created_at).toLocaleString('pt-BR', { timeZone: 'America/New_York' });
          // before/after come back already as JSON objects (pg JSONB)
          const beforeStr = row.before_data ? JSON.stringify(row.before_data, null, 2) : '(null)';
          const afterStr  = row.after_data  ? JSON.stringify(row.after_data,  null, 2) : '(null)';
          return \`
            <div class="row" id="row-\${row.id}">
              <div class="row-head" onclick="document.getElementById('row-\${row.id}').classList.toggle('open')" style="cursor:pointer">
                <span class="action-pill \${cls}">\${esc(row.action)}</span>
                <span class="entity">\${esc(row.entity_type)}\${row.entity_id ? ' #' + esc(row.entity_id) : ''}</span>
                <span style="flex:1"></span>
                <span class="ts">\${esc(when)}</span>
              </div>
              <div class="details"><strong>Before:</strong>
\${esc(beforeStr)}

<strong>After:</strong>
\${esc(afterStr)}</div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        document.getElementById('results').innerHTML = '<div style="color:#ef4444">Erro de conexão</div>';
      }
    }
  </script>
</body>
</html>`);
});

// Silent-mode log viewer — what Carolina WOULD have posted during kill switch
router.get('/admin/silent-log', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Silent Log — HealthFare</title>
  <style>
    body { font-family: -apple-system, sans-serif; padding: 24px; max-width: 1000px; margin: 0 auto; color: #1f2937; background:#f5f7fb; }
    h1 { color: #dc2626; margin-bottom: 8px; }
    .sub { color:#6b7280; margin-bottom: 20px; font-size:13px; }
    .filters { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:12px 16px; display:flex; gap:8px; align-items:end; flex-wrap:wrap; margin-bottom:16px; }
    .filters label { display:flex; flex-direction:column; font-size:11px; color:#6b7280; text-transform:uppercase; font-weight:600; }
    .filters input, .filters select { padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; margin-top:4px; }
    .btn { background:#1d4f91; color:white; border:none; padding:6px 14px; border-radius:6px; cursor:pointer; font-size:13px; }
    .row { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:10px 14px; margin-bottom:8px; font-size:13px; }
    .pill { background:#fef3c7; color:#92400e; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:700; }
    .ts { color:#6b7280; font-size:11px; float:right; }
    .text { margin-top:6px; white-space:pre-wrap; color:#374151; }
    .ref { color:#6b7280; font-size:11px; font-family:monospace; }
    a { color: #1d4f91; }
    .back { display: inline-block; margin-bottom: 16px; color: #1d4f91; text-decoration: none; }
    #pin-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
    #pin-overlay .box { background:#fff; padding:24px; border-radius:10px; min-width:280px; }
    #pin-overlay input { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:14px; margin:8px 0; }
    .err { color:#ef4444; font-size:12px; margin-top:6px; min-height:14px; }
  </style>
</head>
<body>
  <div id="pin-overlay">
    <div class="box">
      <strong>Admin PIN</strong>
      <input id="pin-input" type="password" autocomplete="off" autofocus>
      <div class="err" id="pin-err"></div>
      <button class="btn" onclick="unlock()" style="width:100%">Entrar</button>
    </div>
  </div>

  <a href="/" class="back">← Voltar ao dashboard</a>
  <h1>🔇 Silent Log</h1>
  <div class="sub">Mensagens que Carolina <strong>NÃO postou</strong> no canal de produção enquanto o modo silencioso estava ativo.</div>

  <div class="filters">
    <label>Últimas
      <select id="f-hours">
        <option value="1">1 hora</option>
        <option value="6">6 horas</option>
        <option value="24" selected>24 horas</option>
        <option value="72">72 horas</option>
        <option value="168">7 dias</option>
      </select>
    </label>
    <label>Ação
      <select id="f-action">
        <option value="">(todas)</option>
        <option value="postMessage">postMessage</option>
        <option value="addReaction">addReaction</option>
        <option value="postImage">postImage</option>
        <option value="postToChannel">postToChannel</option>
      </select>
    </label>
    <button class="btn" onclick="load()">Filtrar</button>
    <span id="count-label" style="color:#6b7280;font-size:13px"></span>
  </div>

  <div id="results">Carregando...</div>

  <script>
    let _pin = '';
    async function unlock() {
      const pin = document.getElementById('pin-input').value.trim();
      try {
        const r = await fetch('/api/admin/silent-log?pin=' + encodeURIComponent(pin) + '&limit=1');
        if (r.status === 403) { document.getElementById('pin-err').textContent = 'PIN incorreto'; return; }
        if (!r.ok) { document.getElementById('pin-err').textContent = 'Erro ' + r.status; return; }
        _pin = pin; try { hfAdminSave(pin); } catch (e) {}
        document.getElementById('pin-overlay').style.display = 'none';
        load();
      } catch (err) { document.getElementById('pin-err').textContent = 'Erro de conexão'; }
    }
    document.getElementById('pin-input').addEventListener('keypress', e => { if (e.key === 'Enter') unlock(); });
    ${ADMIN_SESSION_JS}

    function esc(s) { return String(s||'').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

    async function load() {
      const hours  = document.getElementById('f-hours').value;
      const action = document.getElementById('f-action').value;
      const params = new URLSearchParams({ pin: _pin, hours, limit: 500 });
      if (action) params.set('action', action);

      try {
        const r = await fetch('/api/admin/silent-log?' + params.toString());
        const data = await r.json();
        if (!r.ok) { document.getElementById('results').innerHTML = '<div style="color:#ef4444">' + (data.error || r.status) + '</div>'; return; }
        document.getElementById('count-label').textContent = data.total + ' mensagens retidas';
        if (data.rows.length === 0) {
          document.getElementById('results').innerHTML = '<div style="text-align:center;color:#6b7280;padding:32px">Nenhuma mensagem retida no período.</div>';
          return;
        }
        document.getElementById('results').innerHTML = data.rows.map(row => {
          const when = new Date(row.created_at).toLocaleString('pt-BR', { timeZone: 'America/New_York' });
          const text = row.intended_text ? '<div class="text">' + esc(row.intended_text) + '</div>' : '';
          const ref  = row.would_have_replied_to_ts ? '<span class="ref">→ ts ' + esc(row.would_have_replied_to_ts) + '</span>' : '';
          return '<div class="row">' +
                 '<span class="pill">' + esc(row.intended_action) + '</span> ' +
                 '<span class="ref">' + esc(row.intended_channel || '?') + '</span> ' +
                 ref +
                 '<span class="ts">' + esc(when) + '</span>' +
                 text +
                 '</div>';
        }).join('');
      } catch (err) {
        document.getElementById('results').innerHTML = '<div style="color:#ef4444">Erro de conexão</div>';
      }
    }
  </script>
</body>
</html>`);
});

// BLOCO B — Painel Config Carolina. PIN-gated, mirrors the silent-log
// page pattern. Sections grow over BLOCO B (app name now; toggles,
// variações, horários, persona land in C4/C5/C6/C7).
router.get('/admin/carolina-config', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Config Carolina — HealthFare</title>
  <style>
    body { font-family: -apple-system, sans-serif; padding: 24px; max-width: 860px; margin: 0 auto; color: #1f2937; background:#f5f7fb; }
    h1 { color: #1d4f91; margin-bottom: 6px; }
    .sub { color:#6b7280; margin-bottom: 22px; font-size:13px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin: 0 0 12px; }
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:18px; margin-bottom:16px; }
    label.fld { display:block; font-size:11px; color:#6b7280; text-transform:uppercase; font-weight:600; margin-bottom:6px; }
    input[type=text] { width:100%; padding:8px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:14px; box-sizing:border-box; }
    .btn { background:#1d4f91; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:13px; margin-top:12px; }
    .btn:disabled { opacity:.5; cursor:default; }
    .preview { margin-top:14px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:12px 14px; font-size:15px; font-weight:700; color:#065f46; }
    .ok { color:#059669; font-size:12px; margin-top:8px; min-height:14px; }
    .err { color:#ef4444; font-size:12px; margin-top:8px; min-height:14px; }
    .hint { color:#6b7280; font-size:11px; margin-top:6px; }
    a { color: #1d4f91; }
    .back { display: inline-block; margin-bottom: 16px; color: #1d4f91; text-decoration: none; }
    #pin-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:100; }
    #pin-overlay .box { background:#fff; padding:24px; border-radius:10px; min-width:280px; }
    #pin-overlay input { width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:14px; margin:8px 0; }
  </style>
</head>
<body>
  <div id="pin-overlay">
    <div class="box">
      <strong>Admin PIN</strong>
      <input id="pin-input" type="password" autocomplete="off" autofocus>
      <div class="err" id="pin-err"></div>
      <button class="btn" onclick="unlock()" style="width:100%">Entrar</button>
    </div>
  </div>

  <a href="/admin" class="back">← Voltar ao Admin</a>
  <h1>⚙️ Config Carolina</h1>
  <div class="sub">Configurações do comportamento da Carolina. Toda alteração é registrada no log de auditoria.</div>

  <div class="card">
    <h2>Nome do app</h2>
    <label class="fld" for="app-name">Usado no cabeçalho da App Home e na identidade da Carolina</label>
    <input id="app-name" type="text" maxlength="80" placeholder="Carregando…" disabled>
    <div class="hint">Aparece como <code>🌿 &lt;nome&gt;</code> na App Home e em "Você trabalha na &lt;nome&gt;" na persona.</div>
    <div class="preview" id="preview">🌿 …</div>
    <button class="btn" id="save-btn" onclick="saveName()" disabled>Salvar nome</button>
    <div class="ok" id="ok-msg"></div>
    <div class="err" id="err-msg"></div>
  </div>

  <div class="card">
    <h2>Tipos de mensagem</h2>
    <div class="hint">Desligar suprime aquele tipo (registrado no silent log). O chat admin nunca é silenciado.</div>
    <div id="toggles" style="margin-top:10px">Carregando…</div>
    <div class="ok" id="tog-msg"></div>
  </div>

  <div class="card">
    <h2>Horários e janelas</h2>
    <div class="hint">Horário em ET (America/New_York). Mudança de horário re-agenda o cron na hora.</div>
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:10px">
      <label class="fld">Saudação de manhã<br><input id="sc-greeting" type="time" style="margin-top:4px"></label>
      <label class="fld">Resumo EOD<br><input id="sc-eod" type="time" style="margin-top:4px"></label>
      <label class="fld">Janela pergunta pendente (min)<br><input id="sc-pend" type="number" min="1" max="240" style="margin-top:4px;width:90px"></label>
    </div>
    <div class="fld" style="margin-top:12px">Dias ativos</div>
    <div id="sc-days" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"></div>
    <button class="btn" onclick="saveSchedule()" style="margin-top:14px">Salvar horários</button>
    <div class="ok" id="sc-msg"></div>
    <div class="err" id="sc-err"></div>
  </div>

  <div class="card">
    <h2>Formato de hora</h2>
    <div class="hint">Como os horários aparecem no dashboard, na App Home e nas respostas da Carolina. O banco continua em UTC — isso muda só a exibição. (Flórida usa AM/PM.)</div>
    <div id="tf-wrap" style="display:flex;gap:18px;margin-top:12px;font-size:14px">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="tf" value="12h" onchange="saveTimeFormat('12h')"> 12h — AM/PM <span style="color:#6b7280">(5:24 PM)</span></label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="radio" name="tf" value="24h" onchange="saveTimeFormat('24h')"> 24h — militar <span style="color:#6b7280">(17:24)</span></label>
    </div>
    <div class="ok" id="tf-msg"></div>
    <div class="err" id="tf-err"></div>
  </div>

  <div class="card">
    <h2>Variações de mensagem</h2>
    <div class="hint">A Carolina sorteia uma variação a cada envio. Placeholders entre chaves (ex: <code>{nome}</code>) são preenchidos na hora.</div>
    <label class="fld" for="var-type" style="margin-top:10px">Conjunto</label>
    <select id="var-type" onchange="loadVariations()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px"></select>
    <div id="var-ph" class="hint" style="margin-top:6px"></div>
    <div id="var-list" style="margin-top:12px">—</div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input id="var-new" type="text" maxlength="500" placeholder="Nova variação (use {placeholders})" style="flex:1">
      <button class="btn" onclick="addVariation()" style="margin-top:0">+ Adicionar</button>
    </div>
    <div class="ok" id="var-msg"></div>
    <div class="err" id="var-err"></div>
  </div>

  <div class="card">
    <h2>Persona da Carolina</h2>
    <div class="hint">Edite IDENTIDADE e PERSONALIDADE. Vazio = volta ao padrão do código. As <b>REGRAS CRÍTICAS</b> são travadas e sempre aplicadas — a Carolina nunca admite ser IA no canal de produção / DM com operadores.</div>
    <label class="fld" style="margin-top:12px">IDENTIDADE</label>
    <textarea id="ps-identity" rows="5" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit"></textarea>
    <label class="fld" style="margin-top:12px">PERSONALIDADE</label>
    <textarea id="ps-personality" rows="6" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit"></textarea>
    <label class="fld" style="margin-top:12px">🔒 REGRAS CRÍTICAS (travadas, não editáveis — sempre anexadas no canal/DM de operadores)</label>
    <pre id="ps-rules" style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px;font-size:12px;white-space:pre-wrap;color:#7f1d1d;margin:4px 0 0"></pre>
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="btn" onclick="savePersona()" style="margin-top:0">Salvar persona</button>
      <button class="btn btn-gray" onclick="previewPersona()" style="margin-top:0;background:#6b7280">Preview (prompt montado)</button>
    </div>
    <div class="ok" id="ps-msg"></div>
    <div class="err" id="ps-err"></div>
    <pre id="ps-preview" style="display:none;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:10px;font-size:12px;white-space:pre-wrap;margin-top:10px;max-height:340px;overflow:auto"></pre>
  </div>

  <script>
    const TOGGLE_LABELS = {
      greeting: 'Saudação de manhã', eod: 'Lembrete EOD',
      urgency: 'Pergunta de urgência', conflict: 'Pergunta de conflito',
      task: 'Anúncio de início/fim de tarefa', bottles: 'Anúncio de bottles produzidos',
      break: 'Anúncio de break/voltei',
    };
    let _pin = '';
    function esc(s) { return String(s||'').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

    async function unlock() {
      const pin = document.getElementById('pin-input').value.trim();
      try {
        const r = await fetch('/api/admin/carolina-config?pin=' + encodeURIComponent(pin));
        if (r.status === 403) { document.getElementById('pin-err').textContent = 'PIN incorreto'; return; }
        if (!r.ok) { document.getElementById('pin-err').textContent = 'Erro ' + r.status; return; }
        const data = await r.json();
        _pin = pin; try { hfAdminSave(pin); } catch (e) {}
        document.getElementById('pin-overlay').style.display = 'none';
        const inp = document.getElementById('app-name');
        inp.value = data.app_name || '';
        inp.disabled = false;
        document.getElementById('save-btn').disabled = false;
        renderPreview();
        renderToggles(data.toggles || {});
        initTimeFormat(data.time_format || '12h');
        initVariations(data.variation_types || []);
        initSchedule(data.schedule || {});
        initPersona(data.persona || {});
      } catch (e) { document.getElementById('pin-err').textContent = 'Erro de conexão'; }
    }
    document.getElementById('pin-input').addEventListener('keypress', e => { if (e.key === 'Enter') unlock(); });
    ${ADMIN_SESSION_JS}

    function renderPreview() {
      const v = document.getElementById('app-name').value.trim() || '…';
      document.getElementById('preview').textContent = '🌿 ' + v;
    }
    document.getElementById('app-name').addEventListener('input', () => {
      renderPreview();
      document.getElementById('ok-msg').textContent = '';
    });

    async function saveName() {
      const name = document.getElementById('app-name').value.trim();
      const ok = document.getElementById('ok-msg'); const err = document.getElementById('err-msg');
      ok.textContent = ''; err.textContent = '';
      if (!name) { err.textContent = 'Nome não pode ser vazio'; return; }
      const btn = document.getElementById('save-btn'); btn.disabled = true;
      try {
        const r = await fetch('/api/admin/carolina-config/app-name', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: _pin, app_name: name }),
        });
        const data = await r.json();
        if (!r.ok) { err.textContent = data.error || ('Erro ' + r.status); btn.disabled = false; return; }
        document.getElementById('app-name').value = data.app_name;
        renderPreview();
        ok.textContent = 'Salvo. Já vale na App Home e na persona.';
      } catch (e) { err.textContent = 'Erro de conexão'; }
      btn.disabled = false;
    }

    function initTimeFormat(fmt) {
      const v = fmt === '24h' ? '24h' : '12h';
      document.querySelectorAll('input[name="tf"]').forEach(r => { r.checked = (r.value === v); });
    }
    async function saveTimeFormat(fmt) {
      const ok = document.getElementById('tf-msg'); const err = document.getElementById('tf-err');
      ok.textContent = ''; err.textContent = '';
      try {
        const r = await fetch('/api/admin/carolina-config/time-format', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: _pin, format: fmt }),
        });
        const data = await r.json();
        if (!r.ok) { err.textContent = data.error || ('Erro ' + r.status); return; }
        initTimeFormat(data.time_format);
        ok.textContent = data.time_format === '24h'
          ? 'Salvo. Agora mostra 24h (17:24) em todo lugar.'
          : 'Salvo. Agora mostra 12h AM/PM (5:24 PM) em todo lugar.';
      } catch (e) { err.textContent = 'Erro de conexão'; }
    }

    function renderToggles(t) {
      const order = ['greeting','eod','urgency','conflict','task','bottles','break'];
      document.getElementById('toggles').innerHTML = order.map(type => {
        const on = t[type] !== false;
        return '<label style="display:flex;align-items:center;justify-content:space-between;'
          + 'padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px">'
          + '<span>' + esc(TOGGLE_LABELS[type] || type) + '</span>'
          + '<input type="checkbox" data-type="' + type + '"' + (on ? ' checked' : '')
          + ' onchange="setToggle(this)" style="width:18px;height:18px;cursor:pointer"></label>';
      }).join('');
    }

    async function setToggle(el) {
      const type = el.getAttribute('data-type');
      const enabled = el.checked;
      const msg = document.getElementById('tog-msg');
      msg.textContent = '';
      el.disabled = true;
      try {
        const r = await fetch('/api/admin/carolina-config/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: _pin, type, enabled }),
        });
        const data = await r.json();
        if (!r.ok) { el.checked = !enabled; msg.textContent = data.error || ('Erro ' + r.status); }
        else { msg.textContent = (TOGGLE_LABELS[type] || type) + ': ' + (enabled ? 'ligado' : 'desligado'); }
      } catch (e) { el.checked = !enabled; msg.textContent = 'Erro de conexão'; }
      el.disabled = false;
    }

    // ----- C5: message variations -----
    let _varTypes = [];
    function initVariations(types) {
      _varTypes = types || [];
      var sel = document.getElementById('var-type');
      sel.innerHTML = _varTypes.map(function (t) {
        return '<option value="' + esc(t.type) + '">' + esc(t.label) + ' (' + t.default_count + ')</option>';
      }).join('');
      if (_varTypes.length) loadVariations();
    }
    function curMeta() {
      var ty = document.getElementById('var-type').value;
      for (var i = 0; i < _varTypes.length; i++) { if (_varTypes[i].type === ty) return _varTypes[i]; }
      return null;
    }
    function previewOf(tpl) {
      var m = curMeta(); var ex = (m && m.example) || {};
      return String(tpl).replace(/\\{(\\w+)\\}/g, function (_, k) {
        return (ex[k] !== undefined && ex[k] !== null) ? ex[k] : ('{' + k + '}');
      });
    }
    function setVarMsg(ok, err) {
      document.getElementById('var-msg').textContent = ok || '';
      document.getElementById('var-err').textContent = err || '';
    }
    async function loadVariations() {
      var ty = document.getElementById('var-type').value;
      var m = curMeta();
      document.getElementById('var-ph').textContent = (m && m.placeholders && m.placeholders.length)
        ? ('Placeholders: ' + m.placeholders.map(function (p) { return '{' + p + '}'; }).join('  '))
        : 'Sem placeholders.';
      document.getElementById('var-list').textContent = 'Carregando…';
      setVarMsg('', '');
      try {
        var r = await fetch('/api/admin/carolina-config/variations?pin=' + encodeURIComponent(_pin) + '&type=' + encodeURIComponent(ty));
        var data = await r.json();
        if (!r.ok) { document.getElementById('var-list').textContent = data.error || ('Erro ' + r.status); return; }
        renderVarList(data.variations || []);
      } catch (e) { document.getElementById('var-list').textContent = 'Erro de conexão'; }
    }
    function renderVarList(rows) {
      var box = document.getElementById('var-list');
      if (!rows.length) { box.textContent = 'Nenhuma variação cadastrada (usando defaults do código).'; return; }
      box.innerHTML = rows.map(function (v) {
        return '<div style="border-bottom:1px solid #f3f4f6;padding:8px 0">'
          + '<input id="vt_' + v.id + '" type="text" value="' + esc(v.template) + '" oninput="onVarInput(' + v.id + ')" '
          +   'style="width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:13px' + (v.active ? '' : ';opacity:.55') + '">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;font-size:12px">'
          +   '<span class="hint" id="vp_' + v.id + '">▶ ' + esc(previewOf(v.template)) + '</span>'
          +   '<span style="white-space:nowrap">'
          +     '<label class="hint" style="margin-right:10px"><input type="checkbox" ' + (v.active ? 'checked' : '') + ' onchange="toggleVariation(' + v.id + ',this.checked)"> ativa</label>'
          +     '<button class="btn" style="margin-top:0;padding:4px 10px" onclick="saveVariation(' + v.id + ')">Salvar</button> '
          +     '<button class="btn" style="margin-top:0;padding:4px 10px;background:#ef4444" onclick="delVariation(' + v.id + ')">Excluir</button>'
          +   '</span>'
          + '</div></div>';
      }).join('');
    }
    function onVarInput(id) {
      document.getElementById('vp_' + id).textContent = '▶ ' + previewOf(document.getElementById('vt_' + id).value);
    }
    async function varPut(id, body) {
      body.pin = _pin; setVarMsg('', '');
      try {
        var r = await fetch('/api/admin/carolina-config/variations/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        var data = await r.json();
        if (!r.ok) { setVarMsg('', data.error || ('Erro ' + r.status)); return false; }
        setVarMsg('Salvo.', ''); return true;
      } catch (e) { setVarMsg('', 'Erro de conexão'); return false; }
    }
    function saveVariation(id) { return varPut(id, { template: document.getElementById('vt_' + id).value }); }
    function toggleVariation(id, active) { return varPut(id, { active: active }); }
    async function addVariation() {
      var inp = document.getElementById('var-new'); var t = inp.value.trim();
      setVarMsg('', '');
      if (!t) { setVarMsg('', 'Texto não pode ser vazio'); return; }
      try {
        var r = await fetch('/api/admin/carolina-config/variations', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: _pin, type: document.getElementById('var-type').value, template: t }),
        });
        var data = await r.json();
        if (!r.ok) { setVarMsg('', data.error || ('Erro ' + r.status)); return; }
        inp.value = ''; setVarMsg('Adicionada.', ''); loadVariations();
      } catch (e) { setVarMsg('', 'Erro de conexão'); }
    }
    async function delVariation(id) {
      if (!confirm('Excluir esta variação?')) return;
      setVarMsg('', '');
      try {
        var r = await fetch('/api/admin/carolina-config/variations/' + id + '?pin=' + encodeURIComponent(_pin), { method: 'DELETE' });
        var data = await r.json();
        if (!r.ok) { setVarMsg('', data.error || ('Erro ' + r.status)); return; }
        setVarMsg('Excluída.', ''); loadVariations();
      } catch (e) { setVarMsg('', 'Erro de conexão'); }
    }

    // ----- C6: schedules & windows -----
    var DOW = [['0','Dom'],['1','Seg'],['2','Ter'],['3','Qua'],['4','Qui'],['5','Sex'],['6','Sáb']];
    function initSchedule(s) {
      document.getElementById('sc-greeting').value = s.greeting_time || '08:00';
      document.getElementById('sc-eod').value = s.eod_time || '19:00';
      document.getElementById('sc-pend').value = s.pending_window_minutes || 20;
      var active = s.active_weekdays || [0,1,2,3,4,5,6];
      document.getElementById('sc-days').innerHTML = DOW.map(function (d) {
        var on = active.indexOf(parseInt(d[0],10)) !== -1;
        return '<label class="hint"><input type="checkbox" class="sc-day" value="' + d[0] + '"' + (on ? ' checked' : '') + '> ' + d[1] + '</label>';
      }).join('');
    }
    async function saveSchedule() {
      var ok = document.getElementById('sc-msg'); var err = document.getElementById('sc-err');
      ok.textContent = ''; err.textContent = '';
      var days = [];
      var cbs = document.querySelectorAll('.sc-day');
      for (var i = 0; i < cbs.length; i++) { if (cbs[i].checked) days.push(parseInt(cbs[i].value, 10)); }
      if (!days.length) { err.textContent = 'Selecione pelo menos um dia'; return; }
      var body = {
        pin: _pin,
        greeting_time: document.getElementById('sc-greeting').value,
        eod_time: document.getElementById('sc-eod').value,
        pending_window_minutes: parseInt(document.getElementById('sc-pend').value, 10) || 20,
        active_weekdays: days,
      };
      try {
        var r = await fetch('/api/admin/carolina-config/schedule', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        var data = await r.json();
        if (!r.ok) { err.textContent = data.error || ('Erro ' + r.status); return; }
        ok.textContent = 'Salvo. Crons re-agendados.';
      } catch (e) { err.textContent = 'Erro de conexão'; }
    }

    // ----- C7: persona (IDENTITY/PERSONALITY editáveis; rules travadas) -----
    function initPersona(p) {
      document.getElementById('ps-identity').value = p.identity || p.identity_default || '';
      document.getElementById('ps-personality').value = p.personality || p.personality_default || '';
      document.getElementById('ps-rules').textContent =
        '[PRODUÇÃO / DM operadores]\\n' + (p.prod_rules || '') +
        '\\n\\n[ADMIN C0B36DR5MP1]\\n' + (p.admin_rules || '');
    }
    async function savePersona() {
      var ok = document.getElementById('ps-msg'); var err = document.getElementById('ps-err');
      ok.textContent = ''; err.textContent = '';
      var body = {
        pin: _pin,
        identity: document.getElementById('ps-identity').value,
        personality: document.getElementById('ps-personality').value,
      };
      try {
        var r = await fetch('/api/admin/carolina-config/persona', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        var data = await r.json();
        if (!r.ok) { err.textContent = data.error || ('Erro ' + r.status); return; }
        ok.textContent = 'Persona salva. (Vazio = padrão do código. Guardrails seguem travados.)';
      } catch (e) { err.textContent = 'Erro de conexão'; }
    }
    async function previewPersona() {
      var err = document.getElementById('ps-err'); err.textContent = '';
      var pre = document.getElementById('ps-preview');
      try {
        var r = await fetch('/api/admin/carolina-config/persona/preview?pin=' + encodeURIComponent(_pin));
        var data = await r.json();
        if (!r.ok) { err.textContent = data.error || ('Erro ' + r.status); return; }
        pre.style.display = 'block';
        pre.textContent = '===== PROD (canal / DM operadores) =====\\n' + data.prod
          + '\\n\\n===== ADMIN (C0B36DR5MP1) =====\\n' + data.admin;
      } catch (e) { err.textContent = 'Erro de conexão'; }
    }
  </script>
</body>
</html>`);
});

// Individual operator page — Entrega 3 Fase 7.1
// Timeline of today + week stats + insights, read from operator_activity_log.
router.get('/operator/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('id inválido');
  const opRes = await db.query('SELECT id, name, role FROM operators WHERE id = $1', [id]);
  if (opRes.rows.length === 0) return res.status(404).send('Operador não encontrado');
  const op = opRes.rows[0];
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const timeline = await db.query(`
    SELECT oal.id, oal.activity_type, oal.started_at, oal.ended_at, oal.duration_seconds,
           oal.role, pi.phase_name, wi.product_name, wi.batch_number,
           ati.task_name
    FROM operator_activity_log oal
    LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
    LEFT JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
    LEFT JOIN ad_hoc_task_instances ati ON ati.id = oal.ad_hoc_task_instance_id
    WHERE oal.operator_id = $1
      AND (oal.started_at AT TIME ZONE 'America/New_York')::date = $2::date
    ORDER BY oal.started_at ASC
  `, [id, date]);

  // B7 — current open activity, shown highlighted at the TOP of the
  // timeline ("AGORA: ...") before the closed entries.
  let current = { rows: [] };
  try {
    current = await db.query(`
      SELECT oal.activity_type, oal.started_at, oal.role,
             pi.phase_name, wi.product_name, wi.batch_number,
             wt.name AS workflow_name, ati.task_name
      FROM operator_activity_log oal
      LEFT JOIN phase_instances pi ON pi.id = oal.phase_instance_id
      LEFT JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
      LEFT JOIN workflow_templates wt ON wt.id = wi.workflow_template_id
      LEFT JOIN ad_hoc_task_instances ati ON ati.id = oal.ad_hoc_task_instance_id
      WHERE oal.operator_id = $1 AND oal.ended_at IS NULL
      ORDER BY oal.id DESC LIMIT 1`, [id]);
  } catch (_) { current = { rows: [] }; }

  const week = await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN activity_type IN ('phase','ad_hoc') THEN duration_seconds ELSE 0 END),0)::int AS worked,
      COALESCE(SUM(CASE WHEN activity_type='break' THEN duration_seconds ELSE 0 END),0)::int AS brk,
      COUNT(*) FILTER (WHERE activity_type='phase' AND ended_at IS NOT NULL)::int AS phases
    FROM operator_activity_log
    WHERE operator_id = $1
      AND started_at >= date_trunc('week', NOW() AT TIME ZONE 'America/New_York')
  `, [id]);

  const byPhase = await db.query(`
    SELECT pi.phase_name,
           COUNT(*)::int AS n,
           ROUND(AVG(oal.duration_seconds)/60.0)::int AS avg_min
    FROM operator_activity_log oal
    JOIN phase_instances pi ON pi.id = oal.phase_instance_id
    WHERE oal.operator_id = $1 AND oal.duration_seconds IS NOT NULL
      AND oal.started_at >= date_trunc('week', NOW() AT TIME ZONE 'America/New_York')
    GROUP BY pi.phase_name
    ORDER BY n DESC
  `, [id]);

  // F2 — this operator's notes for the week (App Home + admin sourced)
  let weekNotes = { rows: [] };
  try {
    weekNotes = await db.query(`
      SELECT n.text, n.created_at, n.source, pi.phase_name, wi.product_name
      FROM operator_notes n
      LEFT JOIN phase_instances pi ON pi.id = n.linked_phase_instance_id
      LEFT JOIN workflow_instances wi ON wi.id = n.linked_workflow_instance_id
      WHERE n.operator_id = $1 AND n.deleted_at IS NULL
        AND n.created_at >= date_trunc('week', NOW() AT TIME ZONE 'America/New_York')
      ORDER BY n.created_at DESC`, [id]);
  } catch (_) { weekNotes = { rows: [] }; }

  // BUG AMPM — operator timeline clock in the admin's chosen format.
  const _tf = await require('../app-state').getTimeFormat();
  const { formatTime } = require('../utils/time');
  const fmtT = (ts) => formatTime(ts, { format: _tf, empty: '—' });
  const fmtD = (s) => s == null ? '—' : (s >= 3600 ? `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m` : `${Math.floor(s/60)}min`);
  const w = week.rows[0] || { worked: 0, brk: 0, phases: 0 };

  const rows = timeline.rows.map((r) => {
    const what = r.phase_name
      ? `${r.phase_name}${r.product_name ? ' · ' + r.product_name : ''}${r.batch_number ? ' #' + r.batch_number : ''}`
      : (r.task_name || (r.activity_type === 'break' ? '☕ break' : r.activity_type));
    const roleTag = r.role ? ` <span style="color:#6b7280">(${r.role})</span>` : '';
    // A1 — admin action buttons per row (hidden until PIN unlock)
    const adminTd = `<td class="adm" style="display:none;white-space:nowrap">
      <button onclick="oalEdit(${r.id})" style="font-size:11px;padding:3px 7px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;background:#fff">Editar</button>
      <button onclick="oalDel(${r.id})" style="font-size:11px;padding:3px 7px;border:none;border-radius:5px;cursor:pointer;background:#ef4444;color:#fff">Excluir</button>
    </td>`;
    return `<tr><td>${fmtT(r.started_at)}–${fmtT(r.ended_at)}</td>
      <td>${what}${roleTag}</td><td>${fmtD(r.duration_seconds)}</td>${adminTd}</tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>${op.name} — HealthFare</title>
<style>
  body{font-family:-apple-system,sans-serif;padding:24px;max-width:760px;margin:0 auto;color:#1f2937;background:#f5f7fb}
  h1{color:#1d4f91} h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin:24px 0 10px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:13px} td{padding:7px 10px;border-bottom:1px solid #f3f4f6}
  .stat{display:inline-block;margin-right:24px}.stat b{display:block;font-size:22px;color:#1d4f91}
  a{color:#1d4f91;text-decoration:none}.back{display:inline-block;margin-bottom:18px}
</style></head><body>
<a href="/" class="back">← Dashboard</a>
<h1 style="display:flex;align-items:center;gap:10px">${op.name}${op.role ? ` <span style="font-size:14px;color:#6b7280">· ${op.role}</span>` : ''}
  <button id="lock" onclick="toggleLock()" title="Admin" style="font-size:13px;padding:4px 10px;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;background:#fff">🔒</button>
  <span id="adm-timer" style="display:none;font-size:11px;color:#059669"></span>
</h1>

<div class="card">
  <span class="stat"><b>${fmtD(w.worked)}</b>trabalhado (semana)</span>
  <span class="stat"><b>${fmtD(w.brk)}</b>break (semana)</span>
  <span class="stat"><b>${w.phases}</b>fases concluídas (semana)</span>
</div>

${(() => {
  const c = current.rows[0];
  if (!c) return '';
  const what = c.phase_name
    ? `${c.workflow_name ? c.workflow_name + ' · ' : ''}${c.product_name || ''}${c.batch_number ? ' #' + c.batch_number : ''} → ${c.phase_name}`
    : (c.task_name || (c.activity_type === 'break' ? '☕ break' : c.activity_type));
  return `<div class="card" style="background:#ecfdf5;border-color:#6ee7b7">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#059669;font-weight:700">AGORA</div>
    <div style="font-size:15px;font-weight:700;margin-top:3px">${String(what).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}</div>
    <div style="font-size:12px;color:#047857;margin-top:2px">iniciou ${fmtT(c.started_at)}${c.role ? ' · ' + c.role : ''}</div>
  </div>`;
})()}

<h2>Timeline de ${date}</h2>
<div class="card"><table>${rows || '<tr><td colspan="3" style="color:#6b7280">Sem atividade nesse dia</td></tr>'}</table></div>

<h2>Médias por fase (semana)</h2>
<div class="card"><table>
  <tr><td><b>Fase</b></td><td><b>Qtd</b></td><td><b>Média</b></td></tr>
  ${byPhase.rows.map((p)=>`<tr><td>${p.phase_name}</td><td>${p.n}</td><td>${p.avg_min} min</td></tr>`).join('') || '<tr><td colspan="3" style="color:#6b7280">Sem dados</td></tr>'}
</table></div>

<h2>Notas da semana</h2>
<div class="card"><table>
  ${weekNotes.rows.map((n)=>`<tr><td style="white-space:nowrap;color:#6b7280">${fmtT(n.created_at)}</td><td>${String(n.text||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}${n.phase_name?` <span style="color:#6b7280">· ${n.phase_name}${n.product_name?' '+n.product_name:''}</span>`:''}</td></tr>`).join('') || '<tr><td colspan="2" style="color:#6b7280">Nenhuma nota essa semana</td></tr>'}
</table></div>

<div id="adm-retro" class="card" style="display:none">
  <h2 style="margin-top:0">+ Entrada retroativa (admin)</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;align-items:end">
    <label style="font-size:11px;color:#6b7280">Tipo
      <select id="re-type" style="width:100%;padding:5px"><option value="phase">phase</option><option value="ad_hoc">ad_hoc</option><option value="break">break</option><option value="idle">idle</option></select></label>
    <label style="font-size:11px;color:#6b7280">Início (ET)
      <input id="re-start" type="datetime-local" style="width:100%;padding:5px"></label>
    <label style="font-size:11px;color:#6b7280">Fim (opcional)
      <input id="re-end" type="datetime-local" style="width:100%;padding:5px"></label>
    <label style="font-size:11px;color:#6b7280">phase_instance_id
      <input id="re-pi" type="number" style="width:100%;padding:5px"></label>
    <label style="font-size:11px;color:#6b7280">notes
      <input id="re-notes" type="text" style="width:100%;padding:5px"></label>
    <button onclick="oalCreate()" style="padding:7px 12px;background:#1d4f91;color:#fff;border:none;border-radius:6px;cursor:pointer">Adicionar</button>
  </div>
  <div id="re-err" style="color:#ef4444;font-size:12px;margin-top:6px"></div>
</div>

<div id="pin-ov" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:100">
  <div style="background:#fff;padding:24px;border-radius:10px;min-width:260px">
    <strong>Admin PIN</strong>
    <input id="pin-in" type="password" autocomplete="off" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin:8px 0">
    <div id="pin-er" style="color:#ef4444;font-size:12px;min-height:14px"></div>
    <button onclick="doUnlock()" style="width:100%;padding:8px;background:#1d4f91;color:#fff;border:none;border-radius:6px;cursor:pointer">Entrar</button>
  </div>
</div>

<script>
  var OP_ID = ${id};
  var SESS_MS = 10*60*1000;
  function _admGet(){ try { return JSON.parse(localStorage.getItem('hf_admin')||'null'); } catch(_) { return null; } }
  function _admPin(){ var s=_admGet(); return (s && (Date.now()-s.ts)<SESS_MS) ? s.pin : null; }
  function _touch(){ var s=_admGet(); if(s){ s.ts=Date.now(); localStorage.setItem('hf_admin',JSON.stringify(s)); } }
  var _admInt=null;
  function applyAdmin(on){
    document.querySelectorAll('.adm').forEach(function(e){ e.style.display = on?'':'none'; });
    var r=document.getElementById('adm-retro'); if(r) r.style.display = on?'':'none';
    var l=document.getElementById('lock'); if(l){ l.textContent = on?'🔓':'🔒'; }
    var t=document.getElementById('adm-timer'); if(t) t.style.display = on?'':'none';
    if(on){ if(_admInt) clearInterval(_admInt); _admInt=setInterval(tickTimer,1000); tickTimer(); }
    else if(_admInt){ clearInterval(_admInt); _admInt=null; }
  }
  function tickTimer(){
    var s=_admGet(); var t=document.getElementById('adm-timer');
    if(!s){ applyAdmin(false); return; }
    var left=SESS_MS-(Date.now()-s.ts);
    if(left<=0){ localStorage.removeItem('hf_admin'); applyAdmin(false); return; }
    if(t){ var m=Math.floor(left/60000),x=Math.floor((left%60000)/1000); t.textContent='Admin '+m+':'+(x<10?'0':'')+x; }
  }
  function toggleLock(){
    if(_admPin()){ localStorage.removeItem('hf_admin'); applyAdmin(false); }
    else { document.getElementById('pin-ov').style.display='flex'; setTimeout(function(){document.getElementById('pin-in').focus();},100); }
  }
  async function doUnlock(){
    var pin=document.getElementById('pin-in').value.trim();
    var r=await fetch('/api/admin/operators?pin='+encodeURIComponent(pin));
    if(r.status===403){ document.getElementById('pin-er').textContent='PIN incorreto'; return; }
    if(!r.ok){ document.getElementById('pin-er').textContent='Erro '+r.status; return; }
    localStorage.setItem('hf_admin',JSON.stringify({pin:pin,ts:Date.now()}));
    document.getElementById('pin-ov').style.display='none';
    applyAdmin(true);
  }
  document.getElementById('pin-in').addEventListener('keypress',function(e){ if(e.key==='Enter') doUnlock(); });
  async function oalDel(id){
    var pin=_admPin(); if(!pin){ applyAdmin(false); return; }
    if(!confirm('Excluir essa entrada da timeline?')) return;
    _touch();
    var r=await fetch('/api/admin/operator-activity-log/'+id+'?pin='+encodeURIComponent(pin),{method:'DELETE'});
    if(r.ok) location.reload(); else alert('Erro');
  }
  async function oalEdit(id){
    var pin=_admPin(); if(!pin){ applyAdmin(false); return; }
    var ns=prompt('Novo started_at ET (YYYY-MM-DD HH:MM) — deixa vazio p/ não mudar:');
    var body={pin:pin}; if(ns) body.started_at=ns;
    var nn=prompt('Notes (vazio = não mudar):'); if(nn) body.notes=nn;
    if(!ns && !nn) return;
    _touch();
    var r=await fetch('/api/admin/operator-activity-log/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.ok) location.reload(); else alert('Erro');
  }
  async function oalCreate(){
    var pin=_admPin(); if(!pin){ applyAdmin(false); return; }
    var body={pin:pin,operator_id:OP_ID,activity_type:document.getElementById('re-type').value,
      started_at:document.getElementById('re-start').value,
      ended_at:document.getElementById('re-end').value||null,
      phase_instance_id:parseInt(document.getElementById('re-pi').value)||null,
      notes:document.getElementById('re-notes').value||null};
    if(!body.started_at){ document.getElementById('re-err').textContent='Início obrigatório'; return; }
    _touch();
    var r=await fetch('/api/admin/operator-activity-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.ok) location.reload(); else { var d=await r.json().catch(function(){return{};}); document.getElementById('re-err').textContent=d.error||'Erro'; }
  }
  // Restore A2 session on load
  if(_admPin()) applyAdmin(true);
</script>
</body></html>`);
});

// ─── Bug 5: workflow + phase template management (Princípio D) ──────────
router.get('/admin/workflows', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Workflows — Admin</title><style>
 body{font-family:-apple-system,sans-serif;padding:24px;max-width:1000px;margin:0 auto;color:#1f2937;background:#f5f7fb}
 h1{color:#1d4f91}h2{font-size:13px;text-transform:uppercase;color:#6b7280;margin:22px 0 10px}
 .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px}
 table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 9px;border-bottom:1px solid #f3f4f6;text-align:left}
 th{font-size:11px;text-transform:uppercase;color:#6b7280}
 input,select{padding:4px 7px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;box-sizing:border-box}
 .btn{background:#1d4f91;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px}
 .btn-red{background:#ef4444}.btn-green{background:#10b981}.btn-gray{background:#6b7280}
 a{color:#1d4f91}.back{display:inline-block;margin-bottom:18px}
 #pin-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:99}
 #pin-ov .b{background:#fff;padding:24px;border-radius:10px;min-width:280px}.err{color:#ef4444;font-size:12px;min-height:14px}
 .phase-row{display:grid;grid-template-columns:1fr 60px 70px 70px 90px 110px;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6}
</style></head><body>
<div id="pin-ov"><div class="b"><strong>Admin PIN</strong>
<input id="pin" type="password" style="width:100%;padding:8px;margin:8px 0"><div class="err" id="pe"></div>
<button class="btn" style="width:100%" onclick="unlock()">Entrar</button></div></div>
<a href="/" class="back">← Dashboard</a> &nbsp; <a href="/admin/ad-hoc-tasks" class="back">Tarefas avulsas →</a>
<h1>Workflows & Fases</h1>
<div id="root">Carregando…</div>
<script>
let _pin='';
async function unlock(){const p=document.getElementById('pin').value.trim();
 const r=await fetch('/api/workflow-templates');if(!r.ok){document.getElementById('pe').textContent='erro';return;}
 // validate pin via an admin GET that requires it
 const t=await fetch('/api/admin/audit?pin='+encodeURIComponent(p)+'&limit=1');
 if(t.status===403){document.getElementById('pe').textContent='PIN incorreto';return;}
 _pin=p; try{hfAdminSave(p);}catch(e){} document.getElementById('pin-ov').style.display='none';load();}
document.getElementById('pin').addEventListener('keypress',e=>{if(e.key==='Enter')unlock();});
${ADMIN_SESSION_JS}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function load(){
 const wts=await (await fetch('/api/workflow-templates?include_inactive=1')).json();
 let html='';
 for(const w of wts){
  const phs=(await (await fetch('/api/workflow-templates/'+w.id)).json()).phases||[];
  html+='<div class="card"><h2 style="margin-top:0">'+esc(w.name)+(w.is_active?'':' <span style="color:#ef4444">(inativo)</span>')+'</h2>'+
   '<div style="font-size:12px;color:#6b7280;margin-bottom:8px">'+esc(w.description||'')+' · allows_product='+w.allows_product+'</div>'+
   '<div class="phase-row" style="font-weight:600;color:#6b7280;font-size:11px"><span>Fase</span><span>Seq</span><span>Req</span><span>Paral</span><span>Soft pré</span><span>Ações</span></div>';
  for(const p of phs){
   html+='<div class="phase-row" data-pid="'+p.id+'">'+
    '<input value="'+esc(p.name)+'" id="pn'+p.id+'">'+
    '<input type="number" value="'+p.sequence_order+'" id="ps'+p.id+'" style="width:55px">'+
    '<input type="checkbox" '+(p.is_required?'checked':'')+' id="pr'+p.id+'">'+
    '<input type="checkbox" '+(p.can_run_parallel?'checked':'')+' id="pp'+p.id+'">'+
    '<input type="checkbox" '+(p.soft_prereq?'checked':'')+' id="psp'+p.id+'">'+
    '<span><button class="btn" onclick="savePhase('+p.id+')">Salvar</button> '+
    '<button class="btn btn-red" onclick="delPhase('+p.id+')">Del</button></span></div>';
  }
  html+='<div style="margin-top:10px;display:flex;gap:6px;align-items:center">'+
   '<input id="np'+w.id+'" placeholder="Nova fase (nome)"><input id="nps'+w.id+'" type="number" placeholder="seq" style="width:60px">'+
   '<button class="btn btn-green" onclick="addPhase('+w.id+')">+ Fase</button>'+
   '<button class="btn '+(w.is_active?'btn-red':'btn-green')+'" onclick="toggleWf('+w.id+','+w.is_active+')">'+(w.is_active?'Desativar':'Ativar')+' workflow</button></div></div>';
 }
 html+='<div class="card"><h2 style="margin-top:0">Novo workflow</h2>'+
  '<input id="nwn" placeholder="Nome"> <input id="nwd" placeholder="Descrição" style="width:280px"> '+
  '<label><input type="checkbox" id="nwap"> allows_product</label> '+
  '<button class="btn btn-green" onclick="addWf()">+ Criar</button></div>';
 document.getElementById('root').innerHTML=html;
}
async function api(method,url,body){const o={method,headers:{'Content-Type':'application/json'}};
 if(method!=='DELETE')o.body=JSON.stringify({pin:_pin,...(body||{})});
 const u=method==='DELETE'?url+(url.includes('?')?'&':'?')+'pin='+encodeURIComponent(_pin):url;
 const r=await fetch(u,o);const d=await r.json().catch(()=>({}));if(!r.ok){alert(d.error||('erro '+r.status));return false;}return true;}
async function savePhase(id){const ok=await api('PUT','/api/admin/phase-templates/'+id,{
 name:document.getElementById('pn'+id).value.trim(),
 sequence_order:parseInt(document.getElementById('ps'+id).value)||0,
 is_required:document.getElementById('pr'+id).checked,
 can_run_parallel:document.getElementById('pp'+id).checked,
 soft_prereq:document.getElementById('psp'+id).checked});if(ok)load();}
async function delPhase(id){if(!confirm('Deletar fase?'))return;if(await api('DELETE','/api/admin/phase-templates/'+id))load();}
async function addPhase(wid){const n=document.getElementById('np'+wid).value.trim();if(!n)return;
 if(await api('POST','/api/admin/phase-templates',{workflow_template_id:wid,name:n,sequence_order:parseInt(document.getElementById('nps'+wid).value)||0}))load();}
async function toggleWf(id,active){if(active){if(!confirm('Desativar workflow?'))return;if(await api('DELETE','/api/admin/workflow-templates/'+id))load();}
 else{if(await api('PUT','/api/admin/workflow-templates/'+id,{is_active:true}))load();}}
async function addWf(){const n=document.getElementById('nwn').value.trim();if(!n)return;
 if(await api('POST','/api/admin/workflow-templates',{name:n,description:document.getElementById('nwd').value.trim(),allows_product:document.getElementById('nwap').checked}))load();}
</script></body></html>`);
});

router.get('/admin/ad-hoc-tasks', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Tarefas avulsas — Admin</title><style>
 body{font-family:-apple-system,sans-serif;padding:24px;max-width:760px;margin:0 auto;color:#1f2937;background:#f5f7fb}
 h1{color:#1d4f91}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px}
 .row{display:grid;grid-template-columns:1fr 90px 90px 170px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6}
 input{padding:4px 7px;border:1px solid #d1d5db;border-radius:4px;font-size:13px}
 .btn{background:#1d4f91;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px}
 .btn-red{background:#ef4444}.btn-green{background:#10b981}
 .pend{background:#fef3c7;color:#92400e;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:700}
 a{color:#1d4f91}.back{display:inline-block;margin-bottom:18px}
 #pin-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:99}
 #pin-ov .b{background:#fff;padding:24px;border-radius:10px;min-width:280px}.err{color:#ef4444;font-size:12px;min-height:14px}
</style></head><body>
<div id="pin-ov"><div class="b"><strong>Admin PIN</strong>
<input id="pin" type="password" style="width:100%;padding:8px;margin:8px 0"><div class="err" id="pe"></div>
<button class="btn" style="width:100%" onclick="unlock()">Entrar</button></div></div>
<a href="/" class="back">← Dashboard</a> &nbsp; <a href="/admin/workflows" class="back">← Workflows</a>
<h1>Tarefas avulsas</h1><div class="card" id="root">Carregando…</div>
<script>
let _pin='';
async function unlock(){const p=document.getElementById('pin').value.trim();
 const t=await fetch('/api/admin/audit?pin='+encodeURIComponent(p)+'&limit=1');
 if(t.status===403){document.getElementById('pe').textContent='PIN incorreto';return;}
 _pin=p; try{hfAdminSave(p);}catch(e){} document.getElementById('pin-ov').style.display='none';load();}
document.getElementById('pin').addEventListener('keypress',e=>{if(e.key==='Enter')unlock();});
${ADMIN_SESSION_JS}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function load(){
 const ts=await (await fetch('/api/ad-hoc-tasks?include_inactive=1')).json();
 let h='<div class="row" style="font-weight:600;color:#6b7280;font-size:11px"><span>Nome</span><span>Ativo</span><span>Aprovado</span><span>Ações</span></div>';
 for(const t of ts){
  h+='<div class="row"><input value="'+esc(t.name)+'" id="n'+t.id+'">'+
   '<span>'+(t.is_active?'sim':'não')+'</span>'+
   '<span>'+(t.admin_approved?'sim':'<span class=\\'pend\\'>pendente</span>')+'</span>'+
   '<span><button class="btn" onclick="save('+t.id+')">Salvar</button> '+
   (t.admin_approved?'':'<button class="btn btn-green" onclick="approve('+t.id+')">Aprovar</button> ')+
   '<button class="btn btn-red" onclick="deact('+t.id+')">'+(t.is_active?'Desativar':'Ativar')+'</button></span></div>';
 }
 h+='<div style="margin-top:12px"><input id="nn" placeholder="Nova tarefa avulsa"> <button class="btn btn-green" onclick="add()">+ Criar</button></div>';
 document.getElementById('root').innerHTML=h;
}
async function api(method,url,body){const o={method,headers:{'Content-Type':'application/json'}};
 if(method!=='DELETE')o.body=JSON.stringify({pin:_pin,...(body||{})});
 const u=method==='DELETE'?url+'?pin='+encodeURIComponent(_pin):url;
 const r=await fetch(u,o);const d=await r.json().catch(()=>({}));if(!r.ok){alert(d.error||('erro '+r.status));return false;}return true;}
async function save(id){if(await api('PUT','/api/admin/ad-hoc-tasks/'+id,{name:document.getElementById('n'+id).value.trim()}))load();}
async function approve(id){if(await api('PUT','/api/admin/ad-hoc-tasks/'+id,{admin_approved:true}))load();}
async function deact(id){if(await api('PUT','/api/admin/ad-hoc-tasks/'+id,{is_active:false}))load();}
async function add(){const n=document.getElementById('nn').value.trim();if(!n)return;
 if(await api('POST','/api/admin/ad-hoc-tasks',{name:n}))load();}
</script></body></html>`);
});

module.exports = router;
