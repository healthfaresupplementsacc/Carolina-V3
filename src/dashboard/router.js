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

// Admin page
router.get('/admin', async (req, res) => {
  const ops = await db.query('SELECT * FROM operators ORDER BY name');
  const state = await db.query('SELECT * FROM app_state');
  const stateMap = Object.fromEntries(state.rows.map(r => [r.key, r.value]));

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Admin - HealthFare</title>
  <style>
    body { font-family: -apple-system, sans-serif; padding: 24px; max-width: 600px; margin: 0 auto; color: #1f2937; }
    h1 { color: #1d4f91; margin-bottom: 24px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin: 24px 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-weight: 600; }
    .btn { background: #1d4f91; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .btn-red { background: #ef4444; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; background: #d1fae5; color: #065f46; }
    input[type=text] { padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
    .state-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
    a { color: #1d4f91; }
    .back { display: inline-block; margin-bottom: 20px; color: #1d4f91; text-decoration: none; }
  </style>
</head>
<body>
  <a href="/" class="back">← Voltar ao dashboard</a>
  <h1>Admin</h1>

  <h2>Operadores</h2>
  <table>
    <thead><tr><th>Nome</th><th>Slack ID</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${ops.rows.map(op => `
        <tr>
          <td>${op.name}</td>
          <td>${op.slack_user_id || '-'}</td>
          <td><span class="pill">${op.active ? 'Ativo' : 'Inativo'}</span></td>
          <td>
            <form method="POST" action="/admin/operator/${op.id}/toggle" style="display:inline">
              <button class="btn ${op.active ? 'btn-red' : ''}" type="submit">${op.active ? 'Desativar' : 'Ativar'}</button>
            </form>
          </td>
        </tr>`).join('')}
    </tbody>
  </table>

  <h2>Adicionar Operador</h2>
  <form method="POST" action="/admin/operator/add" style="display:flex;gap:8px">
    <input type="text" name="name" placeholder="Nome" required>
    <input type="text" name="slack_user_id" placeholder="Slack ID (opcional)">
    <button class="btn" type="submit">Adicionar</button>
  </form>

  <h2>Estado do Sistema</h2>
  ${Object.entries(stateMap).map(([k, v]) => `
    <div class="state-row"><span>${k}</span><span>${v}</span></div>`).join('')}
</body>
</html>`);
});

// Admin actions
router.post('/admin/operator/:id/toggle', async (req, res) => {
  await db.query('UPDATE operators SET active = NOT active WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
});

router.post('/admin/operator/add', async (req, res) => {
  const { name, slack_user_id } = req.body;
  await db.query(
    'INSERT INTO operators (name, slack_user_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [name.trim(), slack_user_id?.trim() || null]
  );
  res.redirect('/admin');
});

module.exports = router;
