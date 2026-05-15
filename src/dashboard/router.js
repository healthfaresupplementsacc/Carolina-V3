'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db');
const tasks = require('../tasks');
const { generateDashboard, generateEodSummary } = require('./template');

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
        _pin = pin;
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
        _pin = pin;
        document.getElementById('pin-overlay').style.display = 'none';
        reload();
      } catch (err) { document.getElementById('pin-err').textContent = 'Erro de conexão'; }
    }
    document.getElementById('pin-input').addEventListener('keypress', e => { if (e.key === 'Enter') unlock(); });

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
        _pin = pin;
        document.getElementById('pin-overlay').style.display = 'none';
        load();
      } catch (err) { document.getElementById('pin-err').textContent = 'Erro de conexão'; }
    }
    document.getElementById('pin-input').addEventListener('keypress', e => { if (e.key === 'Enter') unlock(); });

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
    SELECT oal.activity_type, oal.started_at, oal.ended_at, oal.duration_seconds,
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

  const fmtT = (ts) => ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) : '—';
  const fmtD = (s) => s == null ? '—' : (s >= 3600 ? `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m` : `${Math.floor(s/60)}min`);
  const w = week.rows[0] || { worked: 0, brk: 0, phases: 0 };

  const rows = timeline.rows.map((r) => {
    const what = r.phase_name
      ? `${r.phase_name}${r.product_name ? ' · ' + r.product_name : ''}${r.batch_number ? ' #' + r.batch_number : ''}`
      : (r.task_name || (r.activity_type === 'break' ? '☕ break' : r.activity_type));
    const roleTag = r.role ? ` <span style="color:#6b7280">(${r.role})</span>` : '';
    return `<tr><td>${fmtT(r.started_at)}–${fmtT(r.ended_at)}</td>
      <td>${what}${roleTag}</td><td>${fmtD(r.duration_seconds)}</td></tr>`;
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
<h1>${op.name}${op.role ? ` <span style="font-size:14px;color:#6b7280">· ${op.role}</span>` : ''}</h1>

<div class="card">
  <span class="stat"><b>${fmtD(w.worked)}</b>trabalhado (semana)</span>
  <span class="stat"><b>${fmtD(w.brk)}</b>break (semana)</span>
  <span class="stat"><b>${w.phases}</b>fases concluídas (semana)</span>
</div>

<h2>Timeline de ${date}</h2>
<div class="card"><table>${rows || '<tr><td colspan="3" style="color:#6b7280">Sem atividade nesse dia</td></tr>'}</table></div>

<h2>Médias por fase (semana)</h2>
<div class="card"><table>
  <tr><td><b>Fase</b></td><td><b>Qtd</b></td><td><b>Média</b></td></tr>
  ${byPhase.rows.map((p)=>`<tr><td>${p.phase_name}</td><td>${p.n}</td><td>${p.avg_min} min</td></tr>`).join('') || '<tr><td colspan="3" style="color:#6b7280">Sem dados</td></tr>'}
</table></div>
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
 _pin=p;document.getElementById('pin-ov').style.display='none';load();}
document.getElementById('pin').addEventListener('keypress',e=>{if(e.key==='Enter')unlock();});
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
 _pin=p;document.getElementById('pin-ov').style.display='none';load();}
document.getElementById('pin').addEventListener('keypress',e=>{if(e.key==='Enter')unlock();});
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
