'use strict';
/**
 * HealthFare Clinic Production Dashboard HTML template.
 * Branding: primary #1d4f91 (blue), accent #2ea84a (green).
 * Supports EN/PT toggle and admin PIN edit mode (PIN: 510510).
 * Layout: Orders (compact top) → Em Andamento → Produção → Formulação → Entries → Timeline → Operadores → Arquivo
 */

function generateDashboard() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HealthFare Clinic - Linha de Produção</title>
  <style>
    :root {
      --blue: #1d4f91;
      --blue-light: #2563c4;
      --blue-dark: #163a6b;
      --green: #2ea84a;
      --green-light: #38c75a;
      --amber: #f59e0b;
      --red: #ef4444;
      --gray: #6b7280;
      --bg: #f0f4f8;
      --card: #ffffff;
      --text: #1f2937;
      --text-light: #6b7280;
      --border: #e5e7eb;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }

    /* ===== HEADER ===== */
    .header {
      background: var(--blue);
      color: white;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 64px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }

    .header-logo { display: flex; align-items: center; gap: 12px; }

    .logo-icon { width: 40px; height: 40px; }

    .logo-text { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }

    .logo-sub { font-size: 11px; opacity: 0.75; letter-spacing: 2px; text-transform: uppercase; font-weight: 500; }

    .header-right { display: flex; align-items: center; gap: 10px; }

    .live-badge {
      display: flex; align-items: center; gap: 6px;
      background: rgba(255,255,255,0.15);
      padding: 4px 10px; border-radius: 20px;
      font-size: 12px; font-weight: 600;
    }

    .live-dot {
      width: 7px; height: 7px;
      background: var(--green); border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.85); }
    }

    .header-date { font-size: 13px; opacity: 0.85; }

    .lang-btn {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      color: white; padding: 5px 10px; border-radius: 8px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: background 0.15s; white-space: nowrap;
    }
    .lang-btn:hover { background: rgba(255,255,255,0.28); }

    .lock-btn {
      background: rgba(255,255,255,0.15);
      border: 1px solid rgba(255,255,255,0.3);
      color: white; padding: 5px 9px; border-radius: 8px;
      font-size: 15px; cursor: pointer; transition: background 0.15s;
      line-height: 1;
    }
    .lock-btn:hover { background: rgba(255,255,255,0.28); }
    .lock-btn.unlocked { background: rgba(46,168,74,0.3); border-color: rgba(46,168,74,0.5); }

    /* ===== MAIN LAYOUT ===== */
    .main { max-width: 1280px; margin: 0 auto; padding: 24px; }

    @media (max-width: 480px) { .main { padding: 12px; } }

    /* ===== PRODUCTION HERO ===== */
    .prod-hero {
      background: var(--blue);
      border-radius: 14px; padding: 20px 24px 18px;
      margin-bottom: 14px;
      display: flex; align-items: center; justify-content: space-between;
      gap: 16px; flex-wrap: wrap;
      box-shadow: 0 4px 16px rgba(29,79,145,0.25);
    }

    .prod-hero-main { display: flex; flex-direction: column; gap: 2px; }

    .prod-hero-label {
      font-size: 11px; color: rgba(255,255,255,0.7);
      text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;
    }

    .prod-hero-number {
      font-size: 56px; font-weight: 900; color: white;
      line-height: 1; font-variant-numeric: tabular-nums;
    }

    .prod-hero-trend {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 14px; font-weight: 700; margin-top: 4px;
      padding: 3px 10px; border-radius: 20px;
    }
    .trend-up   { background: rgba(46,168,74,0.25); color: #4ade80; }
    .trend-down { background: rgba(239,68,68,0.25); color: #f87171; }
    .trend-flat { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.7); }

    .prod-hero-stats {
      display: flex; gap: 24px; flex-wrap: wrap; align-items: center;
    }

    .prod-hero-stat { display: flex; flex-direction: column; align-items: center; }
    .prod-hero-stat-label { font-size: 10px; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
    .prod-hero-stat-val   { font-size: 26px; font-weight: 800; color: white; line-height: 1.1; font-variant-numeric: tabular-nums; }
    .prod-hero-stat-sub   { font-size: 10px; color: rgba(255,255,255,0.55); margin-top: 1px; }

    .prod-hero-divider { width: 1px; height: 50px; background: rgba(255,255,255,0.18); }

    /* ===== METRIC CARDS ===== */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }

    @media (max-width: 900px) { .metrics-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 480px) { .metrics-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; } }

    .metric-card {
      background: var(--card);
      border-radius: 12px; padding: 14px 16px;
      border: 1px solid var(--border);
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }

    .metric-label {
      font-size: 10px; color: var(--text-light);
      text-transform: uppercase; letter-spacing: 0.8px;
      font-weight: 600; margin-bottom: 4px;
    }

    .metric-value { font-size: 28px; font-weight: 800; color: var(--blue); line-height: 1; }

    .metric-sub { font-size: 10px; color: var(--text-light); margin-top: 3px; }

    /* ===== EST COMPLETION BADGE ===== */
    .est-completion {
      font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 10px;
      white-space: nowrap;
    }
    .est-ok       { background: #d1fae5; color: #065f46; }
    .est-late     { background: #fee2e2; color: #991b1b; }
    .est-unknown  { background: #f3f4f6; color: var(--gray); }

    /* ===== SECTION ===== */
    .section {
      background: var(--card);
      border-radius: 12px; border: 1px solid var(--border);
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      margin-bottom: 18px; overflow: hidden;
    }

    .section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 13px 20px; border-bottom: 1px solid var(--border);
      background: var(--bg);
    }

    .section-title {
      font-size: 13px; font-weight: 700; color: var(--blue);
      text-transform: uppercase; letter-spacing: 0.8px;
    }

    .section-body { padding: 16px 20px; }

    /* ===== ORDERS (compact top section) ===== */
    .section-orders .section-header { background: #f0fdf4; }
    .section-orders .section-title { color: #166534; }

    .orders-compact { display: flex; flex-direction: column; gap: 8px; }

    .order-chip {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px; border-radius: 8px;
      background: var(--bg); border: 1px solid var(--border);
      border-left: 4px solid var(--green);
    }

    .order-batch-label {
      font-size: 13px; font-weight: 700; color: var(--text);
      min-width: 80px; flex-shrink: 0;
    }

    .order-chip-center {
      flex: 1; display: flex; flex-wrap: wrap;
      align-items: center; gap: 6px 12px;
    }

    .order-op { font-size: 12px; font-weight: 700; color: var(--blue); }
    .order-count-text { font-size: 13px; color: var(--text); }
    .order-time-text { font-size: 12px; color: var(--text-light); }

    .order-rate-badge {
      font-size: 11px; background: #d1fae5; color: #065f46;
      padding: 2px 7px; border-radius: 10px; font-weight: 600;
    }

    .status-badge-open {
      padding: 2px 7px; border-radius: 6px;
      font-size: 10px; font-weight: 700;
      background: #fef3c7; color: #92400e;
    }

    /* ===== EM ANDAMENTO ===== */
    .task-card {
      display: flex; align-items: center; gap: 16px;
      padding: 14px 16px; border-radius: 10px;
      border: 2px solid var(--border); margin-bottom: 10px;
      transition: border-color 0.3s, background 0.3s;
    }

    .task-card.normal  { border-color: #93c5fd; background: #eff6ff; }
    .task-card.amber   { border-color: var(--amber); background: #fffbeb; animation: pulseAmber 2s infinite; }
    .task-card.red     { border-color: var(--red); background: #fef2f2; animation: shakeRed 1.5s infinite; }
    .task-card.critical{ border-color: var(--red); background: #fef2f2; animation: shakeCritical 0.8s infinite; }

    @keyframes pulseAmber {
      0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
      50% { box-shadow: 0 0 0 4px rgba(245,158,11,0.2); }
    }
    @keyframes shakeRed {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-2px); }
      40% { transform: translateX(2px); }
      60% { transform: translateX(-2px); }
      80% { transform: translateX(1px); }
    }
    @keyframes shakeCritical {
      0%, 100% { transform: translateX(0); }
      10% { transform: translateX(-3px); }
      30% { transform: translateX(3px); }
      50% { transform: translateX(-3px); }
      70% { transform: translateX(3px); }
      90% { transform: translateX(-2px); }
    }

    .task-timer {
      font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums;
      min-width: 86px; text-align: center; border-radius: 8px; padding: 6px 10px;
    }
    .task-card.normal   .task-timer { color: var(--blue); background: #dbeafe; }
    .task-card.amber    .task-timer { color: #92400e; background: #fde68a; }
    .task-card.red      .task-timer,
    .task-card.critical .task-timer { color: #991b1b; background: #fee2e2; }

    .task-info { flex: 1; }
    .task-name { font-size: 15px; font-weight: 700; color: var(--text); }
    .task-meta { font-size: 12px; color: var(--text-light); margin-top: 2px; }

    .task-badge {
      display: inline-block; padding: 3px 10px; border-radius: 20px;
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .badge-normal { background: #dbeafe; color: var(--blue); }
    .badge-amber  { background: #fde68a; color: #92400e; }
    .badge-red    { background: #fee2e2; color: #991b1b; }
    .badge-first  { background: #d1fae5; color: #065f46; }

    /* ===== PRODUCAO DO DIA ===== */
    .prod-card {
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 10px; padding: 14px 16px; margin-bottom: 10px;
    }

    .prod-card-header {
      display: flex; align-items: flex-start;
      justify-content: space-between; gap: 10px; margin-bottom: 6px;
    }

    .prod-name  { font-size: 15px; font-weight: 700; color: var(--text); }
    .prod-batch { font-size: 12px; color: var(--text-light); margin-left: 6px; font-weight: 500; }
    .prod-attr  { font-size: 12px; color: var(--text-light); margin-bottom: 6px; }
    .attr-op    { font-weight: 600; color: var(--blue); }

    .pause-row { font-size: 11px; color: var(--amber); margin-bottom: 4px; padding-left: 4px; }

    .prod-comps { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }

    .cbadge { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
    .cbadge-first { background: #e0e7ff; color: #3730a3; }
    .cbadge-fast  { background: #dcfce7; color: #166534; }
    .cbadge-slow  { background: #fee2e2; color: #991b1b; }
    .cbadge-same  { background: #f3f4f6; color: var(--gray); }

    .prod-stats {
      display: flex; gap: 20px; margin-top: 8px;
      padding-top: 8px; border-top: 1px solid var(--border);
    }

    .prod-stat { display: flex; flex-direction: column; gap: 2px; }
    .stat-label { font-size: 10px; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-val   { font-size: 15px; font-weight: 700; color: var(--text); }

    /* ===== FORMULATION ===== */
    .form-card {
      background: var(--bg); border-radius: 10px;
      padding: 14px 16px; margin-bottom: 10px;
      border-left: 4px solid var(--amber);
      border: 1px solid var(--border); border-left-width: 4px;
    }

    .form-card-row1 { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .form-title { font-weight: 700; font-size: 15px; }
    .form-meta  { font-size: 13px; color: var(--text-light); }

    /* ===== ENTRIES FEED ===== */
    .entries-list { max-height: 340px; overflow-y: auto; }

    .entry-row {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 0; border-bottom: 1px solid var(--border);
      flex-wrap: nowrap;
    }
    .entry-row:last-child { border-bottom: none; }

    .entry-time { font-size: 11px; color: var(--text-light); min-width: 40px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .entry-op   { font-size: 11px; font-weight: 700; color: var(--blue); min-width: 54px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry-type-badge { flex-shrink: 0; padding: 2px 6px; border-radius: 5px; font-size: 10px; font-weight: 600; white-space: nowrap; }
    .entry-text { font-size: 12px; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ===== ON BREAK BANNER ===== */
    .break-banner {
      background: #fffbeb; border: 2px solid var(--amber);
      border-radius: 12px; padding: 14px 20px; margin-bottom: 18px;
      display: flex; align-items: center; gap: 14px;
      box-shadow: 0 2px 8px rgba(245,158,11,0.15);
      animation: pulseAmber 2s infinite;
    }
    .break-banner-icon { font-size: 28px; flex-shrink: 0; }
    .break-banner-label {
      font-size: 13px; font-weight: 800; color: #92400e;
      text-transform: uppercase; letter-spacing: 1px;
    }
    .break-banner-names { font-size: 15px; font-weight: 700; color: #78350f; margin-top: 2px; }
    .break-banner-time  { font-size: 12px; color: #92400e; margin-top: 1px; }

    /* ===== POR OPERADOR ===== */
    .operator-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }

    .operator-card { background: var(--bg); border-radius: 10px; padding: 16px; border: 1px solid var(--border); }
    .operator-name { font-size: 14px; font-weight: 700; color: var(--blue); margin-bottom: 10px; }
    .operator-stat { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-light); margin-bottom: 4px; }
    .operator-stat strong { color: var(--text); }

    /* ===== ARCHIVE ===== */
    .archive-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }

    .archive-thumb {
      border-radius: 8px; overflow: hidden; border: 1px solid var(--border);
      text-decoration: none; color: var(--text); transition: box-shadow 0.2s;
    }
    .archive-thumb:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
    .archive-thumb img { width: 100%; height: 100px; object-fit: cover; object-position: top; }
    .archive-date { font-size: 11px; padding: 6px 8px; text-align: center; background: var(--bg); font-weight: 600; }

    /* ===== ADMIN EDIT BUTTON ===== */
    .edit-btn {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 3px 9px; border-radius: 6px;
      background: #f3f4f6; border: 1px solid #d1d5db;
      font-size: 11px; color: var(--text-light);
      cursor: pointer; transition: background 0.15s;
    }
    .edit-btn:hover { background: #e5e7eb; color: var(--text); }

    /* ===== MODAL ===== */
    .modal-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.55);
      z-index: 500; display: none;
      align-items: center; justify-content: center;
    }
    .modal-box {
      background: white; border-radius: 16px; padding: 28px 32px;
      max-width: 380px; width: 90%;
      box-shadow: 0 24px 60px rgba(0,0,0,0.25);
    }
    .modal-title { font-size: 17px; font-weight: 700; color: var(--blue); margin-bottom: 6px; }
    .modal-desc  { font-size: 13px; color: var(--text-light); margin-bottom: 18px; }

    .modal-input {
      width: 100%; padding: 10px 14px;
      border: 2px solid var(--border); border-radius: 8px;
      font-size: 15px; outline: none; margin-bottom: 10px;
      transition: border-color 0.15s;
    }
    .modal-input:focus { border-color: var(--blue); }
    .pin-input { text-align: center; letter-spacing: 6px; font-size: 20px; }

    .modal-error  { color: var(--red); font-size: 12px; text-align: center; min-height: 18px; margin-bottom: 10px; }
    .modal-label  { font-size: 11px; font-weight: 600; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: block; }
    .modal-field  { margin-bottom: 14px; }

    .modal-actions { display: flex; gap: 8px; margin-top: 4px; }

    .btn-cancel {
      flex: 1; padding: 10px; border: 1px solid var(--border);
      background: white; border-radius: 8px; font-size: 14px; cursor: pointer;
    }
    .btn-save {
      flex: 1; padding: 10px; background: var(--blue); color: white;
      border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .btn-save:hover { background: var(--blue-light); }

    /* ===== EMPTY STATE ===== */
    .empty { text-align: center; padding: 32px; color: var(--text-light); }
    .empty-icon { font-size: 28px; margin-bottom: 8px; }
    .empty-text { font-size: 13px; }

    .admin-link { display: inline-block; font-size: 11px; color: var(--text-light); text-decoration: none; padding: 4px 8px; border-radius: 4px; }
    .admin-link:hover { background: var(--border); }

    /* ===== LOADING ===== */
    #loading-overlay {
      position: fixed; inset: 0; background: rgba(255,255,255,0.9);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000; transition: opacity 0.3s;
    }
    .spinner {
      width: 40px; height: 40px; border: 3px solid var(--border);
      border-top-color: var(--blue); border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>

<!-- Loading overlay -->
<div id="loading-overlay"><div class="spinner"></div></div>

<!-- URGENT kill switch banner — shown when silent_mode is on -->
<div id="silent-banner" style="display:none;background:#dc2626;color:#fff;padding:10px 18px;text-align:center;font-weight:600;font-size:14px;position:sticky;top:0;z-index:60">
  🔇 Modo silencioso ativo — Carolina não está postando no canal de produção.
  <a href="/admin/silent-log" target="_blank" style="color:#fff;text-decoration:underline;margin-left:12px">ver mensagens retidas</a>
</div>

<!-- Floating merge bar (admin only — Entrega 2 commit 13) -->
<div id="merge-bar" style="display:none;position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1d4f91;color:#fff;padding:10px 18px;border-radius:24px;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:50;font-size:14px">
  <span id="merge-bar-count" style="margin-right:12px"></span>
  <button class="btn" style="background:#fff;color:#1d4f91;padding:6px 14px;border:none;border-radius:6px;font-weight:600;cursor:pointer" onclick="mergeSelected()">Mesclar</button>
  <button class="btn" style="background:transparent;color:#fff;padding:6px 8px;border:1px solid rgba(255,255,255,0.4);border-radius:6px;margin-left:6px;cursor:pointer" onclick="clearMergeSel()">Cancelar</button>
</div>

<!-- PIN MODAL -->
<div id="pin-modal" class="modal-overlay">
  <div class="modal-box">
    <div class="modal-title" id="pin-modal-title">Admin</div>
    <div class="modal-desc" id="pin-modal-desc">Digite o PIN de administrador</div>
    <input id="pin-input" class="modal-input pin-input" type="password"
      inputmode="numeric" placeholder="• • • • • •" maxlength="6">
    <div class="modal-error" id="pin-error"></div>
    <div class="modal-actions">
      <button class="btn-cancel" id="pin-cancel-btn" onclick="closePinModal()">Cancelar</button>
      <button class="btn-save"   id="pin-save-btn"   onclick="submitPin()">Entrar</button>
    </div>
  </div>
</div>

<!-- EDIT MODAL -->
<div id="edit-modal" class="modal-overlay">
  <div class="modal-box">
    <div class="modal-title" id="edit-modal-title">Editar</div>
    <div id="edit-fields"></div>
    <div class="modal-error" id="edit-error"></div>
    <div class="modal-actions">
      <button class="btn-cancel" id="edit-cancel-btn" onclick="closeEditModal()">Cancelar</button>
      <button class="btn-save"   id="edit-save-btn"   onclick="submitEdit()">Salvar</button>
    </div>
  </div>
</div>

<!-- HEADER -->
<header class="header">
  <div class="header-logo">
    <svg class="logo-icon" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="40" height="40" rx="10" fill="white" fill-opacity="0.15"/>
      <text x="5" y="28" font-family="Arial" font-weight="900" font-size="24" fill="white">H</text>
      <path d="M26 22 Q32 16 34 8" stroke="#2ea84a" stroke-width="2.5" stroke-linecap="round" fill="none"/>
      <ellipse cx="30" cy="14" rx="4" ry="3" fill="#2ea84a" opacity="0.9" transform="rotate(-30 30 14)"/>
    </svg>
    <div>
      <div class="logo-text">HealthFare</div>
      <div class="logo-sub">Clinic</div>
    </div>
  </div>
  <div class="header-right">
    <span class="header-date" id="header-date"></span>
    <input type="date" id="date-picker" title="Ver dia anterior"
      style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);
             color:white;padding:4px 8px;border-radius:8px;font-size:12px;cursor:pointer;
             color-scheme:dark">
    <button class="lang-btn" onclick="toggleLang()" id="lang-btn">🇧🇷 PT</button>
    <a id="admin-link" href="/admin" target="_blank" title="Painel admin" style="display:none;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 10px;border-radius:8px;font-size:12px;text-decoration:none">Admin</a>
    <a id="audit-link" href="/admin/audit" target="_blank" title="Log de auditoria" style="display:none;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 10px;border-radius:8px;font-size:12px;text-decoration:none">Audit</a>
    <button id="silent-text-btn" onclick="toggleSilent('text')" title="Bloqueia mensagens de texto da Carolina" style="display:none;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 10px;border-radius:8px;font-size:12px;cursor:pointer">🔇 Texto: <span id="silent-text-state">…</span></button>
    <button id="silent-reactions-btn" onclick="toggleSilent('reactions')" title="Bloqueia reações ✅ da Carolina" style="display:none;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:white;padding:4px 10px;border-radius:8px;font-size:12px;cursor:pointer">✅ Reactions: <span id="silent-reactions-state">…</span></button>
    <button class="lock-btn" onclick="toggleAdmin()" id="lock-btn" title="Admin">🔒</button>
    <div class="live-badge" id="live-badge">
      <div class="live-dot" id="live-dot"></div>
      <span id="live-label">Ao vivo</span>
    </div>
  </div>
</header>

<!-- HISTORICAL MODE BANNER -->
<div id="history-banner" style="display:none;background:#1d4f91;color:white;text-align:center;padding:8px 16px;font-size:13px;font-weight:600;position:sticky;top:64px;z-index:99">
  📅 <span id="history-banner-date"></span>
  &nbsp;&nbsp;
  <button onclick="goToToday()" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:white;padding:3px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600">← Voltar para hoje</button>
</div>

<!-- BACKUP REMINDER BANNER (admin only, shown when data >= 15 days old) -->
<div id="backup-reminder" style="display:none;background:#7c2d12;color:white;align-items:center;justify-content:space-between;padding:10px 24px;gap:12px;flex-wrap:wrap;position:sticky;top:64px;z-index:98">
  <span style="font-size:13px;font-weight:600">⚠️ <span id="backup-reminder-text"></span></span>
  <button onclick="downloadBackup()" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:white;padding:5px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:700;white-space:nowrap">💾 Fazer Backup Agora</button>
</div>

<!-- MAIN CONTENT -->
<main class="main">

  <!-- OPERATOR PANEL STRIP (Entrega 3 Fase 7.2) -->
  <div id="operator-strip" style="display:flex;gap:10px;overflow-x:auto;margin-bottom:14px;padding-bottom:4px"></div>

  <!-- PRODUCTION HERO -->
  <div class="prod-hero">
    <div class="prod-hero-main">
      <div class="prod-hero-label" id="hero-label">Produção de Hoje</div>
      <div class="prod-hero-number" id="hero-bottles">-</div>
      <div id="hero-trend" class="prod-hero-trend trend-flat" style="display:none"></div>
    </div>
    <div class="prod-hero-stats">
      <div class="prod-hero-stat">
        <div class="prod-hero-stat-label" id="hero-yday-label">Ontem</div>
        <div class="prod-hero-stat-val" id="hero-yday">-</div>
        <div class="prod-hero-stat-sub">bottles</div>
      </div>
      <div class="prod-hero-divider"></div>
      <div class="prod-hero-stat">
        <div class="prod-hero-stat-label">Semana</div>
        <div class="prod-hero-stat-val" id="hero-week">-</div>
        <div class="prod-hero-stat-sub">bottles</div>
      </div>
    </div>
  </div>


  <!-- ADMIN: Production Total Panel (admin only) -->
  <div id="admin-totals-panel" style="display:none;background:white;border-radius:12px;border:1px solid #e5e7eb;padding:16px 20px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
    <div style="font-size:12px;font-weight:700;color:#1d4f91;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px">⚙️ Total de Produção</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Buscar total do Slack</div>
        <button id="rescan-btn" class="btn-save" style="padding:8px 14px;font-size:13px" onclick="rescanSummary()">🔄 Refazer</button>
      </div>
      <div style="flex:1;min-width:180px">
        <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Definir total manualmente</div>
        <div style="display:flex;gap:6px">
          <input id="manual-total-input" type="number" class="modal-input" placeholder="ex: 1250" style="margin:0;flex:1;max-width:140px">
          <button class="btn-save" style="padding:8px 14px;font-size:13px;white-space:nowrap" onclick="submitManualTotal()">Salvar</button>
        </div>
      </div>
      <div id="rescan-error" style="font-size:12px;color:#ef4444;width:100%"></div>
      <div id="manual-total-error" style="font-size:12px;color:#ef4444;width:100%"></div>
    </div>
  </div>

  <!-- METRIC CARDS (compact) -->
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-label" data-i18n="tasksDone">Tarefas Concluídas</div>
      <div class="metric-value" id="metric-tasks">-</div>
      <div class="metric-sub" data-i18n="today">hoje</div>
    </div>
    <div class="metric-card">
      <div class="metric-label" data-i18n="openTasksLabel">Em Andamento</div>
      <div class="metric-value" id="metric-open">-</div>
      <div class="metric-sub" data-i18n="openTasksSub">tarefas abertas</div>
    </div>
    <div class="metric-card">
      <div class="metric-label" data-i18n="pauses">Paradas</div>
      <div class="metric-value" id="metric-pauses">-</div>
      <div class="metric-sub" data-i18n="today">hoje</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Ordens</div>
      <div class="metric-value" id="metric-orders">-</div>
      <div class="metric-sub">picking hoje</div>
    </div>
  </div>

  <!-- SECTION 1: ORDERS (compact, always visible at top) -->
  <div class="section section-orders">
    <div class="section-header">
      <span class="section-title" data-i18n="orders">Ordens — Picking &amp; Packing</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="orders-total-label" style="font-size:12px;color:#166534;font-weight:600"></span>
        <button id="create-order-btn" style="display:none;background:#dcfce7;border-color:#86efac;color:#166534" class="edit-btn" onclick="openCreateOrder()">+ Criar Ordem</button>
      </div>
    </div>
    <div class="section-body" id="orders-body">
      <div class="empty"><div class="empty-icon">🗂️</div><div class="empty-text" data-i18n="noOrders">Sem ordens registradas ainda</div></div>
    </div>
  </div>

  <!-- ON BREAK BANNER -->
  <div id="break-banner" class="break-banner" style="display:none">
    <div class="break-banner-icon">☕</div>
    <div>
      <div class="break-banner-label">On Break</div>
      <div class="break-banner-names" id="break-names"></div>
      <div class="break-banner-time" id="break-time"></div>
    </div>
  </div>
  <!-- BREAK ADMIN LIST (admin only — Entrega 2 commit 10) -->
  <div id="break-admin-list" style="display:none;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:13px"></div>

  <!-- CREATE TASK MODAL (admin only) -->
  <div id="create-task-modal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-title">Nova Tarefa</div>
      <div id="create-task-fields">
        <div class="modal-field">
          <label class="modal-label">Suplemento</label>
          <input id="ct-supp" class="modal-input" type="text" placeholder="ex: Chlorophyll">
        </div>
        <div class="modal-field">
          <label class="modal-label">Lote</label>
          <input id="ct-batch" class="modal-input" type="text" placeholder="ex: 0127">
        </div>
        <div class="modal-field">
          <label class="modal-label">Operador</label>
          <input id="ct-operator" class="modal-input" type="text" placeholder="ex: Ana">
        </div>
        <div class="modal-field">
          <label class="modal-label">Horário de início (ET)</label>
          <input id="ct-started-at" class="modal-input" type="datetime-local">
        </div>
      </div>
      <div class="modal-error" id="create-task-error"></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeCreateTask()">Cancelar</button>
        <button class="btn-save" onclick="submitCreateTask()">Criar</button>
      </div>
    </div>
  </div>

  <!-- CREATE ORDER MODAL (admin only) -->
  <div id="create-order-modal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-title">Nova Ordem de Packing</div>
      <div>
        <div class="modal-field">
          <label class="modal-label">Operador</label>
          <input id="co-operator" class="modal-input" type="text" placeholder="ex: Simone">
        </div>
        <div class="modal-field">
          <label class="modal-label">Qtd de Ordens</label>
          <input id="co-count" class="modal-input" type="number" min="0" placeholder="ex: 453">
        </div>
        <div class="modal-field">
          <label class="modal-label">Turno (morning / afternoon)</label>
          <input id="co-batch" class="modal-input" type="text" placeholder="morning ou afternoon">
        </div>
        <div class="modal-field">
          <label class="modal-label">Início ET (ex: 2026-05-13 09:00)</label>
          <input id="co-start" class="modal-input" type="datetime-local">
        </div>
        <div class="modal-field">
          <label class="modal-label">Fim ET (vazio = em aberto)</label>
          <input id="co-end" class="modal-input" type="datetime-local">
        </div>
      </div>
      <div class="modal-error" id="co-error"></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeCreateOrder()">Cancelar</button>
        <button class="btn-save" onclick="submitCreateOrder()">Criar</button>
      </div>
    </div>
  </div>

  <!-- SECTION 2: EM ANDAMENTO (open supplement tasks) -->
  <div class="section">
    <div class="section-header">
      <span class="section-title" data-i18n="inProgress">Em Andamento</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="open-count" style="font-size:12px;color:var(--text-light)"></span>
        <button id="create-task-btn" style="display:none;background:#dbeafe;border-color:#93c5fd;color:var(--blue)" class="edit-btn" onclick="openCreateTask()">+ Nova Tarefa</button>
      </div>
    </div>
    <div class="section-body" id="open-tasks-body">
      <div class="empty"><div class="empty-icon">✅</div><div class="empty-text" data-i18n="noTasks">Nenhuma tarefa em andamento</div></div>
    </div>
  </div>

  <!-- SECTION 2b: PRODUCAO DO DIA (closed supplement tasks) -->
  <div class="section">
    <div class="section-header">
      <span class="section-title" data-i18n="production">Produção do Dia</span>
    </div>
    <div class="section-body" id="prod-body">
      <div class="empty"><div class="empty-icon">📦</div><div class="empty-text" data-i18n="noProd">Sem produções registradas ainda</div></div>
    </div>
  </div>

  <!-- SECTION 3: FORMULAÇÃO -->
  <div class="section" id="formulation-section" style="display:none">
    <div class="section-header">
      <span class="section-title" data-i18n="formulation">Formulação do Dia</span>
      <span id="formulation-count-label" style="font-size:12px;color:var(--text-light)"></span>
    </div>
    <div class="section-body" id="formulation-body">
      <div class="empty"><div class="empty-icon">⚗️</div><div class="empty-text" data-i18n="noForm">Sem formulações registradas ainda</div></div>
    </div>
  </div>

  <!-- SUPPLEMENT DAILY SIDEBAR -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">📊 Resumo por Suplemento</span>
    </div>
    <div class="section-body" style="padding:8px 14px">
      <div id="supp-sidebar" style="min-height:32px"></div>
    </div>
  </div>

  <!-- NOTES -->
  <div class="section" id="notes-section" style="display:none">
    <div class="section-header">
      <span class="section-title" data-i18n="notes">Notas do Dia</span>
      <span id="notes-count" style="font-size:12px;color:var(--text-light)"></span>
    </div>
    <div class="section-body" style="padding:8px 20px">
      <div id="notes-body">
        <div class="empty"><div class="empty-icon">📝</div><div class="empty-text" data-i18n="noNotes">Sem notas hoje</div></div>
      </div>
    </div>
  </div>

  <!-- ENTRIES FEED -->
  <div class="section">
    <div class="section-header">
      <span class="section-title" data-i18n="entries">Mensagens de Hoje</span>
      <span id="entries-count" style="font-size:12px;color:var(--text-light)"></span>
    </div>
    <div class="section-body" style="padding: 8px 20px">
      <div class="entries-list" id="entries-body">
        <div class="empty"><div class="empty-icon">💬</div><div class="empty-text" data-i18n="noMessages">Sem mensagens hoje</div></div>
      </div>
    </div>
  </div>

  <!-- POR OPERADOR -->
  <div class="section">
    <div class="section-header">
      <span class="section-title" data-i18n="byOperator">Por Operador</span>
    </div>
    <div class="section-body">
      <div class="operator-grid" id="operator-grid">
        <div class="empty"><div class="empty-text" data-i18n="noData">Sem dados ainda</div></div>
      </div>
    </div>
  </div>

  <!-- SUPPLEMENT CATALOG (admin only) -->
  <div class="section" id="supp-catalog-section" style="display:none">
    <div class="section-header">
      <span class="section-title">💊 Catálogo de Suplementos</span>
      <span id="supp-catalog-count" style="font-size:12px;color:var(--text-light)"></span>
    </div>
    <div class="section-body">
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <input id="new-supp-name" class="modal-input" type="text" placeholder="Nome (ex: Elderberry)" style="flex:1;min-width:150px;margin:0">
        <input id="new-supp-aliases" class="modal-input" type="text" placeholder="Apelidos (ex: elderberries, sabugueiro)" style="flex:2;min-width:180px;margin:0">
        <button class="btn-save" style="padding:10px 16px;white-space:nowrap" onclick="addSupplement()">+ Adicionar</button>
      </div>
      <div class="modal-error" id="supp-catalog-error" style="text-align:left;margin-bottom:8px"></div>
      <div id="supp-catalog-list" style="display:flex;flex-wrap:wrap;gap:6px"></div>
    </div>
  </div>

  <!-- BROADCAST (admin only) -->
  <div class="section" id="broadcast-section" style="display:none">
    <div class="section-header">
      <span class="section-title">📢 Enviar Mensagem no Canal</span>
    </div>
    <div class="section-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <textarea id="broadcast-text" class="modal-input" rows="2"
          placeholder="Escreva a mensagem que Carolina vai enviar no canal..."
          style="flex:1;min-width:220px;margin:0;resize:vertical;font-family:inherit;font-size:14px"></textarea>
        <button class="btn-save" style="padding:10px 18px;align-self:flex-end;white-space:nowrap" onclick="sendBroadcast()">📤 Enviar</button>
      </div>
      <div class="modal-error" id="broadcast-error" style="text-align:left;margin-top:8px"></div>
      <div id="broadcast-ok" style="font-size:13px;color:var(--green);margin-top:6px;display:none">Mensagem enviada!</div>
    </div>
  </div>

  <!-- ARCHIVE -->
  <div class="section">
    <div class="section-header">
      <span class="section-title" data-i18n="archive">Arquivo</span>
      <a href="/admin" class="admin-link">⚙️ Admin</a>
    </div>
    <div class="section-body">
      <div class="archive-grid" id="archive-grid">
        <div class="empty"><div class="empty-text" data-i18n="noArchive">Sem snapshots anteriores</div></div>
      </div>
    </div>
  </div>

</main>

<script>
// ===== TRANSLATIONS =====
const TRANS = {
  pt: {
    live: 'Ao vivo',
    orders: 'Ordens — Picking & Packing',
    inProgress: 'Em Andamento',
    production: 'Produção do Dia',
    formulation: 'Formulação do Dia',
    entries: 'Mensagens de Hoje',
    timeline: 'Timeline do Dia',
    byOperator: 'Por Operador',
    archive: 'Arquivo',
    totalBottles: 'Total de Bottles',
    tasksDone: 'Tarefas Concluídas',
    openTasksLabel: 'Em Andamento',
    openTasksSub: 'tarefas abertas',
    pauses: 'Paradas',
    today: 'hoje',
    noTasks: 'Nenhuma tarefa em andamento',
    noProd: 'Sem produções registradas ainda',
    noForm: 'Sem formulações registradas ainda',
    noOrders: 'Sem ordens registradas ainda',
    noMessages: 'Sem mensagens hoje',
    noTimeline: 'Sem eventos hoje',
    noData: 'Sem dados ainda',
    noArchive: 'Sem snapshots anteriores',
    badgeNormal: 'Normal', badgeAmber: 'Atenção', badgeRed: 'Atrasado', badgeCritical: 'Urgente',
    tasks: 'tarefa(s)', sessions: 'sessão(ões)', ordersTotal: 'pedidos',
    morning: '🌅 Manhã', afternoon: '☀️ Tarde',
    inProgressLabel: 'em andamento', pendingCount: 'contagem pendente',
    ordersPerHour: 'pedidos/h', activeDuration: 'Duração ativa',
    bottles: 'Garrafas', pace: 'Ritmo', firstRun: '1ª corrida',
    editBtn: '✏️', saveBtn: 'Salvar', cancelBtn: 'Cancelar',
    supplement: 'Suplemento', batch: 'Lote', orderCount: 'Qtd Pedidos',
    bottlesEdit: 'Garrafas (contagem)', startedAtEdit: 'Horário de início (ET)',
    tasksToday: 'Tarefas hoje', bottlesToday: 'Bottles hoje', activeTime: 'Tempo ativo',
    enterPin: 'Digite o PIN de administrador', wrongPin: 'PIN incorreto. Tente novamente.',
    adminMode: 'Modo Admin',
    notes: 'Notas do Dia', noNotes: 'Sem notas hoje',
    notesSub: 'nota(s)', notesWord: 'notas',
    typeStart: 'Início', typeFinish: 'Fim', typeCount: 'Contagem', typeNote: 'Nota',
    typeOrdersStart: 'Ordens↑', typeOrdersFinish: 'Ordens✓',
    typeFormStart: 'Form↑', typeFormFinish: 'Form✓', typeUnknown: '—',
    messages: 'mensagens',
    openedBy: 'Abriu:', closedBy: 'Fechou:', startedAt: 'Iniciado',
  },
  en: {
    live: 'Live',
    orders: "Orders — Picking & Packing",
    inProgress: 'In Progress',
    production: "Today's Production",
    formulation: "Today's Formulation",
    entries: "Today's Messages",
    timeline: "Today's Timeline",
    byOperator: 'By Operator',
    archive: 'Archive',
    totalBottles: 'Total Bottles',
    tasksDone: 'Tasks Completed',
    openTasksLabel: 'In Progress',
    openTasksSub: 'open tasks',
    pauses: 'Pauses',
    today: 'today',
    noTasks: 'No tasks in progress',
    noProd: 'No production recorded yet',
    noForm: 'No formulations recorded yet',
    noOrders: 'No orders recorded yet',
    noMessages: 'No messages today',
    noTimeline: 'No events today',
    noData: 'No data yet',
    noArchive: 'No previous snapshots',
    badgeNormal: 'Normal', badgeAmber: 'Warning', badgeRed: 'Late', badgeCritical: 'Urgent',
    tasks: 'task(s)', sessions: 'session(s)', ordersTotal: 'orders',
    morning: '🌅 Morning', afternoon: '☀️ Afternoon',
    inProgressLabel: 'in progress', pendingCount: 'count pending',
    ordersPerHour: 'orders/h', activeDuration: 'Active Duration',
    bottles: 'Bottles', pace: 'Pace', firstRun: '1st run',
    editBtn: '✏️', saveBtn: 'Save', cancelBtn: 'Cancel',
    supplement: 'Supplement', batch: 'Batch', orderCount: 'Order Count',
    bottlesEdit: 'Bottles (count)', startedAtEdit: 'Start time (ET)',
    tasksToday: 'Tasks today', bottlesToday: 'Bottles today', activeTime: 'Active time',
    enterPin: 'Enter admin PIN', wrongPin: 'Wrong PIN. Try again.',
    adminMode: 'Admin Mode',
    notes: "Today's Notes", noNotes: 'No notes today',
    notesSub: 'note(s)', notesWord: 'notes',
    typeStart: 'Start', typeFinish: 'Finish', typeCount: 'Count', typeNote: 'Note',
    typeOrdersStart: 'Orders↑', typeOrdersFinish: 'Orders✓',
    typeFormStart: 'Form↑', typeFormFinish: 'Form✓', typeUnknown: '—',
    messages: 'messages',
    openedBy: 'Opened by:', closedBy: 'Closed by:', startedAt: 'Started',
  },
};

// ===== STATE =====
let lang = 'pt';
let adminUnlocked = false;
let _adminPin = '';
let _editTarget = null;
let _lastData = null;
let openTaskStartTimes = {};
let breakStartTimes = {};

function tr(key) { return TRANS[lang][key] || key; }

// ===== LANGUAGE TOGGLE =====
function toggleLang() {
  lang = lang === 'pt' ? 'en' : 'pt';
  document.getElementById('lang-btn').textContent = lang === 'pt' ? '🇧🇷 PT' : '🇺🇸 EN';
  document.querySelector('html').lang = lang === 'pt' ? 'pt-BR' : 'en';
  document.getElementById('live-label').textContent = tr('live');
  document.getElementById('pin-modal-desc').textContent = tr('enterPin');
  document.getElementById('pin-modal-title').textContent = tr('adminMode');
  document.getElementById('edit-cancel-btn').textContent = tr('cancelBtn');
  document.getElementById('edit-save-btn').textContent = tr('saveBtn');
  document.getElementById('pin-cancel-btn').textContent = tr('cancelBtn');
  document.getElementById('pin-save-btn').textContent = tr('saveBtn');
  // Update data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = tr(el.getAttribute('data-i18n'));
  });
  updateDate();
  if (_lastData) renderAll(_lastData);
}

// ===== TIME HELPERS =====
function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return \`\${h}:\${String(m).padStart(2,'0')}:\${String(s).padStart(2,'0')}\`;
  return \`\${String(m).padStart(2,'0')}:\${String(s).padStart(2,'0')}\`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString(lang === 'en' ? 'en-US' : 'pt-BR',
    { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
}

function fmtMins(secs) {
  if (!secs) return '?';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
  return h > 0 ? h + 'h' + String(m).padStart(2,'0') + 'm' : m + 'min';
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateDate() {
  document.getElementById('header-date').textContent = new Date().toLocaleDateString(
    lang === 'en' ? 'en-US' : 'pt-BR',
    { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/New_York' }
  );
}

function toggleAdmin() {
  if (adminUnlocked) {
    adminUnlocked = false;
    _adminPin = '';
    const btn = document.getElementById('lock-btn');
    btn.textContent = '🔒';
    btn.classList.remove('unlocked');
    btn.title = 'Admin';
    const ctBtn = document.getElementById('create-task-btn');
    if (ctBtn) ctBtn.style.display = 'none';
    document.getElementById('supp-catalog-section').style.display = 'none';
    document.getElementById('broadcast-section').style.display = 'none';
    const adminLink = document.getElementById('admin-link'); if (adminLink) adminLink.style.display = 'none';
    const auditLink = document.getElementById('audit-link'); if (auditLink) auditLink.style.display = 'none';
    const stBtn = document.getElementById('silent-text-btn'); if (stBtn) stBtn.style.display = 'none';
    const srBtn = document.getElementById('silent-reactions-btn'); if (srBtn) srBtn.style.display = 'none';
    const mergeBar = document.getElementById('merge-bar'); if (mergeBar) mergeBar.style.display = 'none';
    const ctBtn2 = document.getElementById('create-task-btn');
    if (ctBtn2) ctBtn2.style.display = 'inline-flex';
    document.getElementById('supp-catalog-section').style.display = '';
    document.getElementById('broadcast-section').style.display = '';
    loadSuppCatalog();
    if (_lastData) renderAll(_lastData);
  } else {
    document.getElementById('pin-error').textContent = '';
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-modal-desc').textContent = tr('enterPin');
    document.getElementById('pin-modal-title').textContent = tr('adminMode');
    showModal('pin-modal');
    setTimeout(() => document.getElementById('pin-input').focus(), 120);
  }
}

function showModal(id) {
  const m = document.getElementById(id);
  m.style.display = 'flex';
}

function hideModal(id) {
  document.getElementById(id).style.display = 'none';
}

function closePinModal() { hideModal('pin-modal'); }

function submitPin() {
  const pin = document.getElementById('pin-input').value.trim();
  if (pin === '510510') {
    adminUnlocked = true;
    _adminPin = pin;
    hideModal('pin-modal');
    const btn = document.getElementById('lock-btn');
    btn.textContent = '🔓';
    btn.classList.add('unlocked');
    btn.title = 'Admin ativo — clique para sair';
    const adminLink = document.getElementById('admin-link'); if (adminLink) adminLink.style.display = 'inline-block';
    const auditLink = document.getElementById('audit-link'); if (auditLink) auditLink.style.display = 'inline-block';
    const stBtn = document.getElementById('silent-text-btn'); if (stBtn) stBtn.style.display = 'inline-block';
    const srBtn = document.getElementById('silent-reactions-btn'); if (srBtn) srBtn.style.display = 'inline-block';
    const ctBtn = document.getElementById('create-task-btn');
    if (ctBtn) ctBtn.style.display = 'none';
    document.getElementById('supp-catalog-section').style.display = 'none';
    document.getElementById('broadcast-section').style.display = 'none';
    const ctBtn2 = document.getElementById('create-task-btn');
    if (ctBtn2) ctBtn2.style.display = 'inline-flex';
    document.getElementById('supp-catalog-section').style.display = '';
    document.getElementById('broadcast-section').style.display = '';
    loadSuppCatalog();
    if (_lastData) renderAll(_lastData);
  } else {
    document.getElementById('pin-error').textContent = tr('wrongPin');
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-input').focus();
  }
}

document.getElementById('pin-input').addEventListener('keypress', e => {
  if (e.key === 'Enter') submitPin();
});

// ===== EDIT MODAL =====
function openEdit(type, id, currentVals) {
  _editTarget = { type, id };
  document.getElementById('edit-error').textContent = '';
  document.getElementById('edit-save-btn').textContent = tr('saveBtn');
  document.getElementById('edit-cancel-btn').textContent = tr('cancelBtn');

  let fieldsHtml = '';
  if (type === 'task') {
    document.getElementById('edit-modal-title').textContent = tr('production');
    fieldsHtml = \`
      <div class="modal-field">
        <label class="modal-label">\${tr('supplement')}</label>
        <input id="ef-supp" class="modal-input" type="text" value="\${escHtml(currentVals.supplement_name || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">\${tr('batch')}</label>
        <input id="ef-batch" class="modal-input" type="text" value="\${escHtml(currentVals.batch_number || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Operador</label>
        <input id="ef-task-op" class="modal-input" type="text" value="\${escHtml(currentVals.operator || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">In\xedcio</label>
        <input id="ef-task-start" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.started_at || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Fim</label>
        <input id="ef-task-end" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.ended_at || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Helpers (separados por vírgula)</label>
        <input id="ef-task-helpers" class="modal-input" type="text" value="\${escHtml(currentVals.helpers || '')}" placeholder="ex: Ana, Bruno">
      </div>
      <div class="modal-field">
        <label class="modal-label">Tipo</label>
        <select id="ef-task-type" class="modal-input">
          <option value="">(sem alterar)</option>
          <option value="producao">Produção</option>
          <option value="revisao">Revisão</option>
          <option value="limpeza">Limpeza</option>
          <option value="label">Label</option>
          <option value="outro">Outro</option>
        </select>
      </div>
      <div class="modal-field">
        <label class="modal-label">Observação</label>
        <input id="ef-task-desc" class="modal-input" type="text" value="\${escHtml(currentVals.description || '')}">
      </div>
      \${!currentVals.ended_at ? '<button onclick="closeTask(' + id + ');closeEditModal();" style="margin-top:8px;width:100%;background:#e53e3e;color:#fff;border:none;border-radius:8px;padding:10px;font-size:14px;cursor:pointer;font-weight:600">✅ Fechar Tarefa Agora</button>' : ''}\`;
  } else if (type === 'order') {
    document.getElementById('edit-modal-title').textContent = tr('orders');
    fieldsHtml = \`
      <div class="modal-field">
        <label class="modal-label">\${tr('orderCount')}</label>
        <input id="ef-orders" class="modal-input" type="number" min="0" value="\${currentVals.order_count || ''}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Operador</label>
        <input id="ef-ord-op" class="modal-input" type="text" value="\${escHtml(currentVals.operator || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Lote</label>
        <input id="ef-ord-batch" class="modal-input" type="text" value="\${escHtml(currentVals.batch_label || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">In\xedcio</label>
        <input id="ef-ord-start" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.started_at || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Fim</label>
        <input id="ef-ord-end" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.ended_at || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Helpers (separados por vírgula)</label>
        <input id="ef-ord-helpers" class="modal-input" type="text" value="\${escHtml(currentVals.helpers || '')}" placeholder="ex: Ana, Bruno">
      </div>\`;
  } else if (type === 'count') {
    document.getElementById('edit-modal-title').textContent = 'Contagem';
    fieldsHtml = \`
      <div class="modal-field">
        <label class="modal-label">Suplemento</label>
        <input id="ef-cnt-supp" class="modal-input" type="text" value="\${escHtml(currentVals.supplement_name || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Lote</label>
        <input id="ef-cnt-batch" class="modal-input" type="text" value="\${escHtml(currentVals.batch_number || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Quantidade (bottles)</label>
        <input id="ef-cnt-count" class="modal-input" type="number" min="0" value="\${currentVals.count || 0}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Operador</label>
        <input id="ef-cnt-op" class="modal-input" type="text" value="\${escHtml(currentVals.operator || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Reportado em</label>
        <input id="ef-cnt-ts" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.reported_at || '')}">
      </div>\`;
  } else if (type === 'pause') {
    document.getElementById('edit-modal-title').textContent = 'Break';
    fieldsHtml = \`
      <div class="modal-field">
        <label class="modal-label">Operador</label>
        <input id="ef-pause-op" class="modal-input" type="text" value="\${escHtml(currentVals.operator || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Motivo</label>
        <input id="ef-pause-reason" class="modal-input" type="text" value="\${escHtml(currentVals.reason || '')}" placeholder="almoço, banheiro, manutenção...">
      </div>
      <div class="modal-field">
        <label class="modal-label">Início</label>
        <input id="ef-pause-start" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.started_at || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Fim (opcional — deixa vazio se ainda em break)</label>
        <input id="ef-pause-end" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.ended_at || '')}">
      </div>\`;
  } else if (type === 'formulation') {
    document.getElementById('edit-modal-title').textContent = tr('formulation');
    fieldsHtml = \`
      <div class="modal-field">
        <label class="modal-label">\${tr('supplement')}</label>
        <input id="ef-form-supp" class="modal-input" type="text" value="\${escHtml(currentVals.supplement_name || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">\${tr('batch')}</label>
        <input id="ef-form-batch" class="modal-input" type="text" value="\${escHtml(currentVals.batch_number || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Operador</label>
        <input id="ef-form-op" class="modal-input" type="text" value="\${escHtml(currentVals.operator || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">In\xedcio</label>
        <input id="ef-form-start" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.started_at || '')}">
      </div>
      <div class="modal-field">
        <label class="modal-label">Fim</label>
        <input id="ef-form-end" class="modal-input" type="datetime-local" value="\${escHtml(currentVals.ended_at || '')}">
      </div>\`;
  }

  document.getElementById('edit-fields').innerHTML = fieldsHtml;
  showModal('edit-modal');
  const first = document.querySelector('#edit-fields input');
  if (first) setTimeout(() => first.focus(), 80);
}

function closeEditModal() { hideModal('edit-modal'); }

async function submitEdit() {
  if (!_editTarget) return;
  const { type, id } = _editTarget;
  let body = { pin: _adminPin };
  let endpoint = '';

  if (type === 'task') {
    body.supplement_name = (document.getElementById('ef-supp')?.value || '').trim();
    body.batch_number    = (document.getElementById('ef-batch')?.value || '').trim();
    body.operator        = (document.getElementById('ef-task-op')?.value || '').trim();
    body.helpers         = (document.getElementById('ef-task-helpers')?.value || '').trim();
    const taskTypeVal    = (document.getElementById('ef-task-type')?.value || '').trim();
    if (taskTypeVal)     body.task_type = taskTypeVal;
    body.description     = (document.getElementById('ef-task-desc')?.value || '');
    const taskStart      = (document.getElementById('ef-task-start')?.value || '').trim();
    const taskEnd        = (document.getElementById('ef-task-end')?.value || '').trim();
    if (taskStart) body.started_at = taskStart;
    if (taskEnd)   body.ended_at   = taskEnd;
    endpoint = \`/api/admin/task/\${id}\`;
  } else if (type === 'order') {
    body.order_count  = parseInt(document.getElementById('ef-orders')?.value) || null;
    body.operator     = (document.getElementById('ef-ord-op')?.value || '').trim();
    body.helpers      = (document.getElementById('ef-ord-helpers')?.value || '').trim();
    body.batch_label  = (document.getElementById('ef-ord-batch')?.value || '').trim();
    const ordStart    = (document.getElementById('ef-ord-start')?.value || '').trim();
    const ordEnd      = (document.getElementById('ef-ord-end')?.value || '').trim();
    if (ordStart) body.started_at = ordStart;
    if (ordEnd)   body.ended_at   = ordEnd;
    endpoint = \`/api/admin/order/\${id}\`;
  } else if (type === 'count') {
    body.supplement_name = (document.getElementById('ef-cnt-supp')?.value || '').trim();
    body.batch_number    = (document.getElementById('ef-cnt-batch')?.value || '').trim();
    body.count           = parseInt(document.getElementById('ef-cnt-count')?.value);
    body.operator        = (document.getElementById('ef-cnt-op')?.value || '').trim();
    const cntTs          = (document.getElementById('ef-cnt-ts')?.value || '').trim();
    if (cntTs) body.reported_at = cntTs;
    endpoint = \`/api/admin/count/\${id}\`;
  } else if (type === 'formulation') {
    body.supplement_name = (document.getElementById('ef-form-supp')?.value || '').trim();
    body.batch_number    = (document.getElementById('ef-form-batch')?.value || '').trim();
    body.operator        = (document.getElementById('ef-form-op')?.value || '').trim();
    const formStart      = (document.getElementById('ef-form-start')?.value || '').trim();
    const formEnd        = (document.getElementById('ef-form-end')?.value || '').trim();
    if (formStart) body.started_at = formStart;
    if (formEnd)   body.ended_at   = formEnd;
    endpoint = \`/api/admin/formulation/\${id}\`;
  } else if (type === 'pause') {
    body.operator   = (document.getElementById('ef-pause-op')?.value || '').trim();
    body.reason     = (document.getElementById('ef-pause-reason')?.value || '').trim();
    const ps        = (document.getElementById('ef-pause-start')?.value || '').trim();
    const pe        = (document.getElementById('ef-pause-end')?.value || '').trim();
    if (ps) body.started_at = ps;
    if (pe) body.ended_at   = pe;
    endpoint = \`/api/admin/pause/\${id}\`;
  }

  try {
    const res = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('edit-error').textContent = data.error || 'Erro';
      return;
    }
    closeEditModal();
    await fetchAndRender();
  } catch (err) {
    document.getElementById('edit-error').textContent = 'Erro de conexão';
  }
}

document.getElementById('edit-modal').addEventListener('keypress', e => {
  if (e.key === 'Enter') submitEdit();
});

// Close modals on backdrop click
['pin-modal','edit-modal'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal(id);
  });
});

// ===== URGENCY HELPERS =====

// ===== CLOSE TASK (admin) =====
async function closeTask(id) {
  if (!adminUnlocked) return;
  if (!confirm('Fechar essa tarefa agora?')) return;
  try {
    const res = await fetch('/api/admin/task/' + id + '/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Erro'); return; }
    await fetchAndRender();
  } catch (err) {
    alert('Erro de conexão');
  }
}

// ===== Entrega 2 admin actions =====
// Generic helper that POSTs/DELETEs an admin endpoint with the PIN,
// confirms first, and refreshes the dashboard on success.
async function adminAction(opts) {
  if (!adminUnlocked) return;
  if (opts.confirm && !confirm(opts.confirm)) return;
  try {
    const fetchOpts = {
      method: opts.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (opts.method !== 'DELETE') {
      fetchOpts.body = JSON.stringify({ pin: _adminPin, ...(opts.body || {}) });
    }
    const url = opts.method === 'DELETE'
      ? opts.url + (opts.url.includes('?') ? '&' : '?') + 'pin=' + encodeURIComponent(_adminPin)
      : opts.url;
    const res = await fetch(url, fetchOpts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.error || ('Erro ' + res.status)); return; }
    await fetchAndRender();
  } catch (err) {
    alert('Erro de conexão');
  }
}

async function reopenTask(id) {
  return adminAction({ method: 'POST', url: '/api/admin/task/' + id + '/reopen',
                       confirm: 'Reabrir essa tarefa?' });
}
async function deleteTask(id) {
  return adminAction({ method: 'DELETE', url: '/api/admin/task/' + id,
                       confirm: 'Apagar essa tarefa? (soft delete — pode ser revertido pelo banco)' });
}
async function deleteOrders(id) {
  return adminAction({ method: 'PUT', url: '/api/admin/order/' + id,
                       body: { status: 'deleted' },
                       confirm: 'Apagar essa sessão de ordens?' });
}
async function closePause(id) {
  return adminAction({ method: 'POST', url: '/api/admin/pause/' + id + '/close',
                       confirm: 'Encerrar esse break agora?' });
}
async function deletePause(id) {
  return adminAction({ method: 'DELETE', url: '/api/admin/pause/' + id,
                       confirm: 'Apagar esse break?' });
}
async function deleteCount(id) {
  return adminAction({ method: 'DELETE', url: '/api/admin/count/' + id,
                       confirm: 'Apagar essa contagem?' });
}

// ===== Merge UI (commit 13) =====
function onMergeSelChange() {
  const checks = document.querySelectorAll('.task-merge-check:checked');
  const bar = document.getElementById('merge-bar');
  const count = checks.length;
  if (count >= 2) {
    bar.style.display = '';
    document.getElementById('merge-bar-count').textContent = count + ' tarefas selecionadas';
  } else {
    bar.style.display = 'none';
  }
}
function clearMergeSel() {
  document.querySelectorAll('.task-merge-check:checked').forEach(c => { c.checked = false; });
  document.getElementById('merge-bar').style.display = 'none';
}
async function toggleSilent(kind) {
  if (!adminUnlocked) return;
  const stateEl = document.getElementById('silent-' + kind + '-state');
  const cur = stateEl?.textContent === 'ON';
  const next = !cur;
  const label = kind === 'text' ? 'Texto (postMessage)' : 'Reactions (✅)';
  if (!confirm(next ? 'ATIVAR silenciamento de ' + label + '?'
                    : 'DESATIVAR silenciamento de ' + label + '?')) return;
  try {
    const res = await fetch('/api/admin/silent-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin, kind, value: next ? 'on' : 'off' }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Erro'); return; }
    await fetchAndRender();
  } catch (err) { alert('Erro de conexão'); }
}

async function mergeSelected() {
  if (!adminUnlocked) return;
  const ids = Array.from(document.querySelectorAll('.task-merge-check:checked'))
    .map(c => parseInt(c.dataset.id))
    .filter(n => !isNaN(n));
  if (ids.length < 2) { alert('Selecione 2 ou mais tarefas'); return; }
  if (!confirm('Mesclar ' + ids.length + ' tarefas? A mais antiga será a sobrevivente; as outras serão deletadas.')) return;
  try {
    const res = await fetch('/api/admin/task/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin, taskIds: ids }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || ('Erro ' + res.status)); return; }
    clearMergeSel();
    let msg = 'Sobrevivente: #' + data.survivor_id + '. Deletadas: ' + (data.merged_ids||[]).join(', ');
    if (data.learned_aliases && data.learned_aliases.length) {
      msg += '\\nSinônimos aprendidos: ' + data.learned_aliases.map(a => a.canonical + ' ↔ ' + a.alias).join('; ');
    }
    alert(msg);
    await fetchAndRender();
  } catch (err) { alert('Erro de conexão'); }
}

// ===== CREATE TASK (admin) =====
function openCreateTask() {
  document.getElementById('create-task-error').textContent = '';
  document.getElementById('ct-supp').value = '';
  document.getElementById('ct-batch').value = '';
  document.getElementById('ct-operator').value = '';
  const nowEt = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T').slice(0, 16);
  document.getElementById('ct-started-at').value = nowEt;
  showModal('create-task-modal');
  setTimeout(() => document.getElementById('ct-supp').focus(), 80);
}

function closeCreateTask() { hideModal('create-task-modal'); }

async function submitCreateTask() {
  const supp = document.getElementById('ct-supp').value.trim();
  if (!supp) { document.getElementById('create-task-error').textContent = 'Suplemento é obrigatório'; return; }
  const body = {
    pin: _adminPin,
    supplement_name: supp,
    batch_number: document.getElementById('ct-batch').value.trim() || null,
    operator: document.getElementById('ct-operator').value.trim() || null,
    started_at: document.getElementById('ct-started-at').value || null,
  };
  try {
    const res = await fetch('/api/admin/task/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('create-task-error').textContent = data.error || 'Erro'; return; }
    closeCreateTask();
    await fetchAndRender();
  } catch (err) {
    document.getElementById('create-task-error').textContent = 'Erro de conexão';
  }
}

// ===== CREATE ORDER MODAL =====
function openCreateOrder() {
  const nowEt = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);
  document.getElementById('co-operator').value = 'Simone';
  document.getElementById('co-count').value = '';
  document.getElementById('co-batch').value = 'afternoon';
  document.getElementById('co-start').value = nowEt;
  document.getElementById('co-end').value = '';
  document.getElementById('co-error').textContent = '';
  showModal('create-order-modal');
  setTimeout(() => document.getElementById('co-count').focus(), 80);
}

function closeCreateOrder() { hideModal('create-order-modal'); }

async function submitCreateOrder() {
  const startedAt = document.getElementById('co-start').value.trim();
  if (!startedAt) { document.getElementById('co-error').textContent = 'Início é obrigatório'; return; }
  const body = {
    pin: _adminPin,
    operator:    document.getElementById('co-operator').value.trim() || null,
    order_count: parseInt(document.getElementById('co-count').value) || null,
    batch_label: document.getElementById('co-batch').value.trim() || 'afternoon',
    started_at:  startedAt,
    ended_at:    document.getElementById('co-end').value.trim() || undefined,
  };
  try {
    const res = await fetch('/api/admin/order/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('co-error').textContent = data.error || 'Erro'; return; }
    closeCreateOrder();
    await fetchAndRender();
  } catch (err) {
    document.getElementById('co-error').textContent = 'Erro de conexão';
  }
}

// ===== BREAK BANNER =====
function renderBreakBanner(breaks) {
  const banner = document.getElementById('break-banner');
  const adminList = document.getElementById('break-admin-list');
  if (!breaks || breaks.length === 0) {
    banner.style.display = 'none';
    if (adminList) adminList.style.display = 'none';
    breakStartTimes = {};
    return;
  }
  banner.style.display = 'flex';
  const names = breaks.map(b => escHtml(b.operator || '?')).join(', ');
  document.getElementById('break-names').textContent = names;
  breakStartTimes = {};
  breaks.forEach(b => { breakStartTimes[b.id] = new Date(b.started_at).getTime(); });
  updateBreakTime();

  // Admin-only: per-break list with close/edit/delete buttons (B17)
  if (adminList) {
    if (adminUnlocked) {
      adminList.style.display = 'block';
      adminList.innerHTML = '<div style="font-weight:600;margin-bottom:6px">⚠️ Breaks ativos (admin)</div>' +
        breaks.map(b => {
          const startedLocal = b.started_at
            ? new Date(b.started_at).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T').slice(0,16)
            : '';
          const editPayload = JSON.stringify({
            operator: b.operator || '',
            reason: b.reason || '',
            started_at: startedLocal,
            ended_at: '',
          });
          return \`<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid #fde68a">
            <span style="flex:1">\${escHtml(b.operator || '?')} · iniciado \${formatTime(b.started_at)}\${b.reason ? ' · ' + escHtml(b.reason) : ''}</span>
            <button class="edit-btn" onclick='openEdit("pause",\${b.id},\${editPayload})'>\${tr('editBtn')}</button>
            <button class="edit-btn" style="background:#10b981;color:#fff;border:none" onclick="closePause(\${b.id})">Encerrar</button>
            <button class="edit-btn" style="background:#ef4444;color:#fff;border:none" onclick="deletePause(\${b.id})">Excluir</button>
          </div>\`;
        }).join('');
    } else {
      adminList.style.display = 'none';
    }
  }
}

function updateBreakTime() {
  const ids = Object.keys(breakStartTimes);
  if (!ids.length) return;
  const durations = ids.map(id => Math.floor((Date.now() - breakStartTimes[id]) / 1000));
  const maxSecs = Math.max(...durations);
  document.getElementById('break-time').textContent = 'há ' + fmtMins(maxSecs);
}

// Close modals on backdrop click
['pin-modal','edit-modal','create-task-modal'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target === e.currentTarget) hideModal(id);
  });
});

function getUrgencyClass(task) {
  const t = task.urgency_tier;
  if (t >= 3) return 'critical';
  if (t >= 2) return 'red';
  if (t >= 1) return 'amber';
  return 'normal';
}
function getBadgeClass(uc) {
  return { normal:'badge-normal', amber:'badge-amber', red:'badge-red', critical:'badge-red' }[uc] || 'badge-normal';
}
function getBadgeLabel(uc) {
  return { normal: tr('badgeNormal'), amber: tr('badgeAmber'), red: tr('badgeRed'), critical: tr('badgeCritical') }[uc] || tr('badgeNormal');
}

// ===== RENDER: ORDERS (compact) =====
function renderOrders(sessions) {
  const body = document.getElementById('orders-body');
  const totalEl = document.getElementById('orders-total-label');

  const totalOrders = (sessions || []).reduce((sum, s) => sum + (parseInt(s.order_count) || 0), 0);
  totalEl.textContent = totalOrders > 0 ? totalOrders + ' ' + tr('ordersTotal') : '';

  if (!sessions || sessions.length === 0) {
    body.innerHTML = \`<div class="empty"><div class="empty-icon">🗂️</div><div class="empty-text">\${tr('noOrders')}</div></div>\`;
    return;
  }

  body.innerHTML = \`<div class="orders-compact">\` + sessions.map(s => {
    const batchLabel = s.batch_label === 'morning' ? tr('morning') : tr('afternoon');
    const statusBadge = s.status === 'open'
      ? \`<span class="status-badge-open">\${tr('inProgressLabel').toUpperCase()}</span>\`
      : '';
    const dur = s.duration_seconds ? fmtMins(s.duration_seconds) : (s.status === 'open' ? tr('inProgressLabel') : '?');
    const countTxt = s.order_count
      ? \`<strong>\${s.order_count}</strong> \${tr('ordersTotal')}\`
      : tr('pendingCount');
    const rateTxt = s.orders_per_hour
      ? \`<span class="order-rate-badge">\${s.orders_per_hour} \${tr('ordersPerHour')}</span>\`
      : '';
    const adminBtns = adminUnlocked
      ? \`<button class="edit-btn" onclick='openEdit("order",\${s.id},{order_count:\${s.order_count||0},operator:\${JSON.stringify(s.operator||"")},batch_label:\${JSON.stringify(s.batch_label||"afternoon")},started_at:\${JSON.stringify(s.started_at?new Date(s.started_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace("T"," ").slice(0,16):"")},ended_at:\${JSON.stringify(s.ended_at?new Date(s.ended_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace("T"," ").slice(0,16):"")}})'>\${tr('editBtn')}</button>
         <button class="edit-btn" style="background:#ef4444;color:#fff;border:none" onclick="deleteOrders(\${s.id})">Excluir</button>\`
      : '';
    return \`
      <div class="order-chip">
        <div class="order-batch-label">\${batchLabel} \${statusBadge}</div>
        <div class="order-chip-center">
          <span class="order-op">\${escHtml(s.operator || '?')}</span>
          <span class="order-count-text">\${countTxt}</span>
          <span class="order-time-text">\${formatTime(s.started_at)}\${s.ended_at ? ' → ' + formatTime(s.ended_at) : ''} · \${dur}</span>
          \${rateTxt}
        </div>
        <span style="display:inline-flex;gap:4px">\${adminBtns}</span>
      </div>\`;
  }).join('') + \`</div>\`;
}

// ===== RENDER: OPEN TASKS =====
function renderOpenTasks(tasks) {
  const body = document.getElementById('open-tasks-body');
  const countEl = document.getElementById('open-count');
  document.getElementById('metric-open').textContent = tasks.length;
  countEl.textContent = tasks.length ? \`\${tasks.length} \${tr('tasks')}\` : '';

  if (!tasks.length) {
    body.innerHTML = \`<div class="empty"><div class="empty-icon">✅</div><div class="empty-text">\${tr('noTasks')}</div></div>\`;
    return;
  }

  openTaskStartTimes = {};
  body.innerHTML = tasks.map(task => {
    const startedAt = new Date(task.started_at);
    openTaskStartTimes[task.id] = startedAt.getTime();
    const elapsed = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const urgClass = getUrgencyClass(task);
    const batchLabel = task.batch_number ? \` #\${task.batch_number}\` : '';
    const operatorLabel = task.operator ? \` • \${task.operator}\` : '';
    // Bug A: items from the ISA-88 model have a string id ('ph-418' /
    // 'ah-5') and a _source tag. The legacy admin buttons call
    // tasks-table endpoints (closeTask/deleteTask/openEdit("task",...))
    // which don't apply to phase_instances AND would emit invalid JS
    // (onclick="closeTask(ph-418)" — unquoted, breaks the card). For
    // workflow items: render the card normally (so it shows in EM
    // ANDAMENTO and counts in the metric) but swap the task-admin
    // buttons for a phase badge + link to the workflow admin page.
    const isWf = !!task._source;
    const phaseTag = isWf
      ? \`<span class="task-badge" style="background:#e0e7ff;color:#3730a3">\${escHtml(task.task_type || (task._source === 'workflow_adhoc' ? 'avulsa' : 'fase'))} · App Home</span>\`
      : '';
    const adminBtns = (adminUnlocked && !isWf)
      ? \`<input type="checkbox" class="task-merge-check" data-id="\${task.id}" onchange="onMergeSelChange()" title="Selecionar para mesclar">
         <button class="edit-btn" onclick='openEdit("task",\${task.id},\${JSON.stringify({supplement_name:task.supplement_name,batch_number:task.batch_number,operator:task.operator||"",started_at:task.started_at?new Date(task.started_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace(" ","T").slice(0,16):"",ended_at:""})})'>\${tr('editBtn')}</button>
         <button class="edit-btn" style="background:#10b981;color:#fff;border:none" onclick="closeTask(\${task.id})">Fechar</button>
         <button class="edit-btn" style="background:#ef4444;color:#fff;border:none" onclick="deleteTask(\${task.id})">Excluir</button>\`
      : (adminUnlocked && isWf
        ? \`<a class="edit-btn" style="background:#1d4f91;color:#fff;border:none;text-decoration:none" href="/admin/workflows" target="_blank">Gerenciar</a>\`
        : '');
    return \`
      <div class="task-card \${urgClass}" id="task-\${escHtml(String(task.id))}">
        <div class="task-timer" id="timer-\${escHtml(String(task.id))}">\${formatDuration(elapsed)}</div>
        <div class="task-info">
          <div class="task-name">\${escHtml(task.supplement_name || task.task_type || '?')}\${escHtml(batchLabel)}</div>
          <div class="task-meta">\${tr('startedAt')} \${formatTime(task.started_at)}\${escHtml(operatorLabel)}</div>
        </div>
        \${isWf ? phaseTag : \`<span class="task-badge \${getBadgeClass(urgClass)}">\${getBadgeLabel(urgClass)}</span>\`}
        \${adminBtns}
      </div>\`;
  }).join('');
}

function tickTimers() {
  for (const [id, startMs] of Object.entries(openTaskStartTimes)) {
    const el = document.getElementById(\`timer-\${id}\`);
    if (el) {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      el.textContent = formatDuration(elapsed);
    }
  }
}

// ===== RENDER: PRODUCTION =====
function renderProd(tasks, counts) {
  const body = document.getElementById('prod-body');
  let totalBottles = 0;

  if (!tasks.length) {
    body.innerHTML = \`<div class="empty"><div class="empty-icon">📦</div><div class="empty-text">\${tr('noProd')}</div></div>\`;
    document.getElementById('metric-tasks').textContent = '0';
    document.getElementById('metric-bottles').textContent = '0';
    return;
  }

  document.getElementById('metric-tasks').textContent = tasks.length;

  body.innerHTML = tasks.map(task => {
    const bottles = parseInt(task.bottles) || 0;
    totalBottles += bottles;

    const suppLabel = escHtml(task.supplement_name || '—');
    const batchLabel = escHtml(task.batch_number || task.prod_batch || '—');
    const startedBy = escHtml(task.operator || '—');
    const finishedBy = escHtml(task.closed_by || task.operator || '—');
    const startTime = task.started_at ? formatTime(task.started_at) : '—';
    const endTime   = task.ended_at   ? formatTime(task.ended_at)   : '—';
    const dur  = formatDuration(task.active_duration_seconds);
    const rate = task.bottles_per_hour ? \`\${task.bottles_per_hour}/h\` : '—';
    const comp = task.comparison;

    const sameOp = startedBy === finishedBy;
    const attrLine = sameOp
      ? \`<span class="attr-op">\${startedBy}</span> · \${startTime} → \${endTime}\`
      : \`\${tr('openedBy')} <span class="attr-op">\${startedBy}</span> \${startTime} → \${tr('closedBy')} <span class="attr-op">\${finishedBy}</span> \${endTime}\`;

    let pauseHtml = '';
    if (task.pauses && task.pauses.length > 0) {
      pauseHtml = task.pauses.map(p => {
        const ps = formatTime(p.started_at);
        const pe = p.ended_at ? formatTime(p.ended_at) : '?';
        const pdur = p.duration_seconds ? \`\${Math.round(p.duration_seconds/60)}min\` : '';
        return \`<div class="pause-row">⏸ \${tr('pauses').replace(/s$/,'')} \${ps}–\${pe}\${pdur ? ' (' + pdur + ')' : ''}</div>\`;
      }).join('');
    }

    let compHtml = '';
    if (!comp || comp.isFirst) {
      compHtml = \`<span class="cbadge cbadge-first">\${tr('firstRun')}</span>\`;
    } else {
      if (comp.pctVsLast !== null) {
        const sign = comp.pctVsLast > 0 ? '+' : '';
        const cls  = comp.pctVsLast > 5 ? 'cbadge-slow' : comp.pctVsLast < -5 ? 'cbadge-fast' : 'cbadge-same';
        const arrow = comp.pctVsLast > 5 ? '▲' : comp.pctVsLast < -5 ? '▼' : '=';
        compHtml += \`<span class="cbadge \${cls}">\${arrow} \${sign}\${comp.pctVsLast.toFixed(0)}% vs última</span>\`;
      }
      if (comp.pctVsAvg !== null && comp.totalRuns >= 2) {
        const sign = comp.pctVsAvg > 0 ? '+' : '';
        const cls  = comp.pctVsAvg > 5 ? 'cbadge-slow' : comp.pctVsAvg < -5 ? 'cbadge-fast' : 'cbadge-same';
        const avgFmt = formatDuration(comp.avgDuration);
        compHtml += \`<span class="cbadge \${cls}">\${sign}\${comp.pctVsAvg.toFixed(0)}% vs média (\${comp.totalRuns}x · \${avgFmt})</span>\`;
      }
    }

    const adminBtns = adminUnlocked
      ? \`<input type="checkbox" class="task-merge-check" data-id="\${task.id}" onchange="onMergeSelChange()" title="Selecionar para mesclar">
         <button class="edit-btn" onclick='openEdit("task",\${task.id},\${JSON.stringify({supplement_name:task.supplement_name,batch_number:task.batch_number,operator:task.operator||"",started_at:task.started_at?new Date(task.started_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace(" ","T").slice(0,16):"",ended_at:task.ended_at?new Date(task.ended_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace(" ","T").slice(0,16):""})})'>\${tr('editBtn')}</button>
         <button class="edit-btn" style="background:#3b82f6;color:#fff;border:none" onclick="reopenTask(\${task.id})">Reabrir</button>
         <button class="edit-btn" style="background:#ef4444;color:#fff;border:none" onclick="deleteTask(\${task.id})">Excluir</button>\`
      : '';

    return \`
      <div class="prod-card">
        <div class="prod-card-header">
          <div>
            <span class="prod-name">\${suppLabel}</span>
            <span class="prod-batch">#\${batchLabel}</span>
          </div>
          <div class="prod-comps">\${compHtml}\${adminBtns ? '<span style="margin-left:6px;display:inline-flex;gap:4px">' + adminBtns + '</span>' : ''}</div>
        </div>
        <div class="prod-attr">\${attrLine}</div>
        \${pauseHtml}
        <div class="prod-stats">
          <div class="prod-stat"><span class="stat-label">\${tr('activeDuration')}</span><span class="stat-val">\${dur}</span></div>
          <div class="prod-stat"><span class="stat-label">\${tr('bottles')}</span><span class="stat-val">\${bottles || '—'}</span></div>
          <div class="prod-stat"><span class="stat-label">\${tr('pace')}</span><span class="stat-val">\${rate}</span></div>
        </div>
      </div>\`;
  }).join('');

  document.getElementById('metric-bottles').textContent = totalBottles;
}

// ===== RENDER: FORMULATION =====
function renderFormulations(sessions) {
  const section = document.getElementById('formulation-section');
  const body    = document.getElementById('formulation-body');
  if (!sessions || sessions.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  document.getElementById('formulation-count-label').textContent = sessions.length + ' ' + tr('sessions');
  renderSuppSidebar(_lastData);

  body.innerHTML = sessions.map(s => {
    const statusBadge = s.status === 'open'
      ? \`<span class="status-badge-open">\${tr('inProgressLabel').toUpperCase()}</span>\`
      : '';
    const dur  = s.duration_seconds ? fmtMins(s.duration_seconds) : (s.status === 'open' ? tr('inProgressLabel') : '?');
    const supp = s.supplement_name
      ? \`<strong>\${escHtml(s.supplement_name)}</strong>\${s.batch_number ? ' ' + escHtml(s.batch_number) : ''}\`
      : (lang === 'pt' ? 'suplemento não identificado' : 'supplement not identified');
    const editBtn = adminUnlocked
      ? \`<button class="edit-btn" onclick='openEdit("formulation",\${s.id},\${JSON.stringify({supplement_name:s.supplement_name,batch_number:s.batch_number,operator:s.operator||"",started_at:s.started_at?new Date(s.started_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace(" ","T").slice(0,16):"",ended_at:s.ended_at?new Date(s.ended_at).toLocaleString("sv-SE",{timeZone:"America/New_York"}).replace(" ","T").slice(0,16):""})})'>\${tr('editBtn')}</button>\`
      : '';
    return \`
      <div class="form-card">
        <div class="form-card-row1">
          <span class="form-title">⚗️ \${supp} \${statusBadge}</span>
          <span class="form-meta">\${formatTime(s.started_at)}\${s.ended_at ? ' → ' + formatTime(s.ended_at) : ''}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;color:var(--text-light)">\${escHtml(s.operator || '?')} · \${dur}</span>
          \${editBtn}
        </div>
      </div>\`;
  }).join('');
}

// ===== RENDER: NOTES =====
function renderNotes(notes) {
  const section = document.getElementById('notes-section');
  const body    = document.getElementById('notes-body');
  const countEl = document.getElementById('notes-count');
  if (!notes || notes.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';
  countEl.textContent = notes.length + ' ' + tr('notesSub');

  body.innerHTML = notes.map(n => \`
    <div class="entry-row">
      <span class="entry-time">\${formatTime(n.ts)}</span>
      <span class="entry-op">\${escHtml((n.operator || '?').substring(0, 10))}</span>
      <span class="entry-type-badge" style="background:#fef3c7;color:#78350f">📝 \${tr('typeNote')}</span>
      <span class="entry-text" title="\${escHtml(n.text)}">\${escHtml(n.text || '')}</span>
    </div>\`).join('');
}

// ===== RENDER: ENTRIES FEED =====
const TYPE_STYLE = {
  start:             { bg: '#dbeafe', color: '#1e40af' },
  finish:            { bg: '#d1fae5', color: '#065f46' },
  count:             { bg: '#ede9fe', color: '#5b21b6' },
  note:              { bg: '#f3f4f6', color: '#6b7280' },
  pause:             { bg: '#fef3c7', color: '#92400e' },
  orders_start:      { bg: '#dcfce7', color: '#166534' },
  orders_finish:     { bg: '#bbf7d0', color: '#14532d' },
  formulation_start: { bg: '#fef3c7', color: '#78350f' },
  formulation_finish:{ bg: '#fde68a', color: '#78350f' },
  unknown:           { bg: '#f3f4f6', color: '#9ca3af' },
  ignore:            { bg: '#f9fafb', color: '#d1d5db' },
};
const TYPE_LABEL_KEY = {
  start: 'typeStart', finish: 'typeFinish', count: 'typeCount', note: 'typeNote',
  orders_start: 'typeOrdersStart', orders_finish: 'typeOrdersFinish',
  formulation_start: 'typeFormStart', formulation_finish: 'typeFormFinish',
};

function renderEntries(messages) {
  const body    = document.getElementById('entries-body');
  const countEl = document.getElementById('entries-count');

  if (!messages || messages.length === 0) {
    countEl.textContent = '';
    body.innerHTML = \`<div class="empty"><div class="empty-icon">💬</div><div class="empty-text">\${tr('noMessages')}</div></div>\`;
    return;
  }

  countEl.textContent = messages.length + ' ' + tr('messages');

  body.innerHTML = messages.map(m => {
    const style = TYPE_STYLE[m.type] || TYPE_STYLE.unknown;
    const labelKey = TYPE_LABEL_KEY[m.type];
    const labelText = labelKey ? tr(labelKey) : tr('typeUnknown');
    const badge = \`<span class="entry-type-badge" style="background:\${style.bg};color:\${style.color}">\${labelText}</span>\`;
    return \`
      <div class="entry-row">
        <span class="entry-time">\${formatTime(m.ts)}</span>
        <span class="entry-op">\${escHtml((m.operator || '?').substring(0, 10))}</span>
        \${badge}
        <span class="entry-text" title="\${escHtml(m.text)}">\${escHtml(m.text || '')}</span>
      </div>\`;
  }).join('');
}

// ===== RENDER: TIMELINE =====
function renderTimeline(events) {
  const body = document.getElementById('timeline-body');
  if (!events.length) {
    body.innerHTML = \`<div class="empty"><div class="empty-icon">⏱️</div><div class="empty-text">\${tr('noTimeline')}</div></div>\`;
    return;
  }

  const dotClass = { start:'dot-start', finish:'dot-finish', count:'dot-count', note:'dot-note', pause:'dot-pause' };

  body.innerHTML = events.map(e => \`
    <div class="timeline-item">
      <div class="timeline-dot \${dotClass[e.type] || 'dot-note'}"></div>
      <div class="timeline-content">
        <div class="timeline-text">\${escHtml(e.text)}</div>
        <div class="timeline-time">\${formatTime(e.ts)}\${e.operator ? ' • ' + escHtml(e.operator) : ''}</div>
      </div>
    </div>\`).join('');
}

// ===== RENDER: OPERATORS =====
function renderOperators(operators) {
  const grid = document.getElementById('operator-grid');
  if (!operators.length) {
    grid.innerHTML = \`<div class="empty"><div class="empty-text">\${tr('noData')}</div></div>\`;
    return;
  }

  grid.innerHTML = operators.map(op => \`
    <div class="operator-card">
      <div class="operator-name">\${escHtml(op.name)}</div>
      <div class="operator-stat"><span>\${tr('tasksToday')}</span><strong>\${op.tasks_today || 0}</strong></div>
      <div class="operator-stat"><span>\${tr('bottlesToday')}</span><strong>\${op.bottles_today || 0}</strong></div>
      <div class="operator-stat"><span>\${tr('activeTime')}</span><strong>\${formatDuration(op.active_seconds_today)}</strong></div>
    </div>\`).join('');
}

// ===== RENDER: ARCHIVE =====
function renderArchive(snapshots) {
  const grid = document.getElementById('archive-grid');
  if (!snapshots.length) {
    grid.innerHTML = \`<div class="empty"><div class="empty-text">\${tr('noArchive')}</div></div>\`;
    return;
  }

  grid.innerHTML = snapshots.map(s => {
    const dateLabel = new Date(s.snapshot_date + 'T12:00:00Z').toLocaleDateString(
      lang === 'en' ? 'en-US' : 'pt-BR', { day:'2-digit', month:'2-digit' }
    );
    const imgSrc = s.screenshot_path || '';
    return \`
      <a href="/archive/\${s.snapshot_date}" class="archive-thumb">
        \${imgSrc
          ? \`<img src="\${imgSrc}" alt="\${dateLabel}" loading="lazy">\`
          : \`<div style="height:100px;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-light);font-size:24px">📅</div>\`}
        <div class="archive-date">\${dateLabel}</div>
      </a>\`;
  }).join('');
}


// ===== SUPPLEMENT CATALOG =====
async function loadSuppCatalog() {
  const section = document.getElementById('supp-catalog-section');
  if (!adminUnlocked) { section.style.display = 'none'; return; }
  section.style.display = '';
  try {
    const res = await fetch('/api/supplements');
    const supps = await res.json();
    document.getElementById('supp-catalog-count').textContent = supps.length + ' suplementos';
    const list = document.getElementById('supp-catalog-list');
    list.innerHTML = supps.map(s => \`
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;display:flex;align-items:center;gap:8px">
        <span style="font-weight:700;color:var(--text)">\${escHtml(s.canonical)}</span>
        \${s.aliases ? '<span style="color:var(--text-light)">' + escHtml(s.aliases) + '</span>' : ''}
      </div>\`).join('');
  } catch(e) {
    document.getElementById('supp-catalog-list').innerHTML = '<span style="color:var(--text-light);font-size:12px">Erro ao carregar</span>';
  }
}

async function addSupplement() {
  const name = document.getElementById('new-supp-name').value.trim();
  const aliases = document.getElementById('new-supp-aliases').value.trim();
  const errEl = document.getElementById('supp-catalog-error');
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Nome é obrigatório'; return; }
  try {
    const res = await fetch('/api/admin/supplement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin, canonical_name: name, aliases }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Erro'; return; }
    document.getElementById('new-supp-name').value = '';
    document.getElementById('new-supp-aliases').value = '';
    await loadSuppCatalog();
  } catch(e) { errEl.textContent = 'Erro de rede'; }
}

// ===== BROADCAST =====
async function sendBroadcast() {
  const text = document.getElementById('broadcast-text').value.trim();
  const errEl = document.getElementById('broadcast-error');
  const okEl  = document.getElementById('broadcast-ok');
  errEl.textContent = '';
  okEl.style.display = 'none';
  if (!text) { errEl.textContent = 'Escreva uma mensagem'; return; }
  try {
    const res = await fetch('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin, message: text }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Erro'; return; }
    document.getElementById('broadcast-text').value = '';
    okEl.style.display = 'block';
    setTimeout(() => { okEl.style.display = 'none'; }, 4000);
  } catch(e) { errEl.textContent = 'Erro de conexão'; }
}

document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('broadcast-text');
  if (ta) ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBroadcast();
  });
});


// ===== ADMIN: RESCAN + MANUAL TOTAL =====
async function rescanSummary() {
  const btn = document.getElementById('rescan-btn');
  const errEl = document.getElementById('rescan-error');
  if (btn) btn.disabled = true;
  if (btn) btn.textContent = 'Buscando...';
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch('/api/admin/rescan-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin }),
    });
    const data = await res.json();
    if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Erro'; }
    else {
      if (btn) btn.textContent = '✅ Feito!';
      fetchAndRender();
      setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '🔄 Refazer'; } }, 3000);
      return;
    }
  } catch(e) { if (errEl) errEl.textContent = 'Erro de conexão'; }
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Refazer'; }
}

async function submitManualTotal() {
  const val = document.getElementById('manual-total-input')?.value.trim();
  const errEl = document.getElementById('manual-total-error');
  if (!val || isNaN(parseInt(val))) { if (errEl) errEl.textContent = 'Número inválido'; return; }
  if (errEl) errEl.textContent = '';
  try {
    const res = await fetch('/api/admin/set-total', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: _adminPin, bottles: parseInt(val) }),
    });
    const data = await res.json();
    if (!res.ok) { if (errEl) errEl.textContent = data.error || 'Erro'; return; }
    document.getElementById('manual-total-input').value = '';
    fetchAndRender();
  } catch(e) { if (errEl) errEl.textContent = 'Erro de conexão'; }
}

// ===== RENDER ALL =====
function renderAll(data) {
  // Silent mode chips + banner. Each sub-flag has its own chip; banner
  // appears if EITHER is on (silentModeActive aggregates both).
  const silentBanner = document.getElementById('silent-banner');
  if (silentBanner) silentBanner.style.display = data.silentModeActive ? 'block' : 'none';

  const tBtn = document.getElementById('silent-text-btn');
  const tState = document.getElementById('silent-text-state');
  if (tState) tState.textContent = data.silentText ? 'ON' : 'OFF';
  if (tBtn) {
    tBtn.style.background  = data.silentText ? '#dc2626' : 'rgba(255,255,255,0.15)';
    tBtn.style.borderColor = data.silentText ? '#fff' : 'rgba(255,255,255,0.3)';
  }

  const rBtn = document.getElementById('silent-reactions-btn');
  const rState = document.getElementById('silent-reactions-state');
  if (rState) rState.textContent = data.silentReactions ? 'ON' : 'OFF';
  if (rBtn) {
    rBtn.style.background  = data.silentReactions ? '#dc2626' : 'rgba(255,255,255,0.15)';
    rBtn.style.borderColor = data.silentReactions ? '#fff' : 'rgba(255,255,255,0.3)';
  }

  // Hero: prefer prodSummaryBottles (operator-reported), fall back to todayBottles
  const heroBottles = data.prodSummaryBottles != null ? data.prodSummaryBottles : (data.todayBottles || 0);
  const heroEl = document.getElementById('hero-bottles');
  if (heroEl) heroEl.textContent = heroBottles.toLocaleString();

  const heroLabel = document.getElementById('hero-label');
  if (heroLabel) {
    if (data.prodSummaryBottles != null) {
      heroLabel.textContent = lang === 'pt' ? 'Total do Dia (confirmado)' : 'Day Total (confirmed)';
      heroLabel.style.color = 'rgba(255,255,255,0.9)';
    } else {
      heroLabel.textContent = lang === 'pt' ? 'Produção de Hoje' : "Today's Production";
      heroLabel.style.color = '';
    }
  }

  const trendEl = document.getElementById('hero-trend');
  if (trendEl && data.trendPct != null) {
    const pct = Math.abs(data.trendPct);
    const dir = data.trendPct > 0 ? '▲' : data.trendPct < 0 ? '▼' : '—';
    trendEl.textContent = dir + ' ' + pct + '% vs ontem';
    trendEl.className = 'prod-hero-trend ' + (data.trendPct > 0 ? 'trend-up' : data.trendPct < 0 ? 'trend-down' : 'trend-flat');
    trendEl.style.display = 'inline-flex';
  } else if (trendEl) {
    trendEl.style.display = 'none';
  }

  const ydayEl = document.getElementById('hero-yday');
  if (ydayEl) ydayEl.textContent = (data.yesterdayBottles || 0).toLocaleString();
  const weekEl = document.getElementById('hero-week');
  if (weekEl) weekEl.textContent = (data.weekBottles || 0).toLocaleString();

  const mTasks = document.getElementById('metric-tasks');
  if (mTasks) mTasks.textContent = (data.todayTasks || []).length;
  const mOpen = document.getElementById('metric-open');
  if (mOpen) mOpen.textContent = (data.openTasks || []).length;
  const mPauses = document.getElementById('metric-pauses');
  if (mPauses) mPauses.textContent = data.pauseCount || 0;
  const mOrders = document.getElementById('metric-orders');
  if (mOrders) mOrders.textContent = (data.todayOrders || []).length;

  const openCount = document.getElementById('open-count');
  if (openCount) {
    const n = (data.openTasks || []).length;
    openCount.textContent = n > 0 ? n + ' ' + tr('openTasksSub') : '';
  }

  const adminPanel = document.getElementById('admin-totals-panel');
  if (adminPanel) adminPanel.style.display = adminUnlocked ? 'block' : 'none';
  const createOrderBtn = document.getElementById('create-order-btn');
  if (createOrderBtn) createOrderBtn.style.display = adminUnlocked ? 'inline-block' : 'none';

  renderBreakBanner(data.activeBreaks || []);
  renderOrders(data.todayOrders || []);
  renderOpenTasks(data.openTasks || []);
  renderProd(data.todayTasks || [], data.counts || []);
  renderFormulations(data.todayFormulations || []);
  renderNotes(data.todayNotes || []);
  renderEntries(data.todayMessages || []);
  renderTimeline(data.timeline || []);
  renderOperators(data.operators || []);
  renderArchive(data.archive || []);
}

// ===== CALENDAR / HISTORY =====
let _viewingDate = null;  // null = today (live), 'YYYY-MM-DD' = historical

function goToToday() {
  _viewingDate = null;
  document.getElementById('date-picker').value = '';
  document.getElementById('history-banner').style.display = 'none';
  document.getElementById('live-dot').style.display = '';
  document.getElementById('live-label').textContent = lang === 'pt' ? 'Ao vivo' : 'Live';
  fetchAndRender();
}

document.getElementById('date-picker').addEventListener('change', function() {
  const val = this.value; // YYYY-MM-DD
  if (!val) { goToToday(); return; }
  _viewingDate = val;
  const [y, m, d] = val.split('-');
  const label = \`\${d}/\${m}/\${y}\`;
  document.getElementById('history-banner-date').textContent = 'Visualizando: ' + label;
  document.getElementById('history-banner').style.display = 'block';
  document.getElementById('live-dot').style.display = 'none';
  document.getElementById('live-label').textContent = label;
  fetchAndRender();
});

// ===== FETCH =====
_lastData = {};

function renderSuppSidebar(data) {
  const el = document.getElementById('supp-sidebar');
  if (!el) return;
  const allTasks = [...(data.todayTasks || []), ...(data.openTasks || [])];
  if (!allTasks.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:12px;text-align:center;padding:8px">Sem dados ainda</div>'; return; }
  const map = {};
  allTasks.forEach(t => {
    const name = t.supplement_name || (t.task_type === 'limpeza' ? 'Limpeza' : t.task_type === 'label' ? 'Label' : t.task_type === 'revisao' ? 'Revisão' : 'Outro');
    if (!map[name]) map[name] = { secs: 0, bottles: 0, open: false };
    map[name].secs    += parseFloat(t.active_duration_seconds || t.elapsed_seconds || 0);
    map[name].bottles += parseInt(t.bottles) || 0;
    if (t.status === 'open') map[name].open = true;
  });
  const entries = Object.entries(map).sort((a, b) => b[1].secs - a[1].secs);
  el.innerHTML = entries.map(([name, d]) => {
    const h = Math.floor(d.secs / 3600);
    const m = Math.floor((d.secs % 3600) / 60);
    const timeStr = h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    const bottleStr = d.bottles > 0 ? '<span style="font-weight:700;color:#166534">' + d.bottles + ' un</span>' : '<span style="color:#cbd5e1">—</span>';
    const dot = d.open ? '<span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:4px;vertical-align:middle"></span>' : '';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:12px;gap:8px">'
      + '<span style="font-weight:600;color:#1e293b;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + dot + escHtml(name) + '</span>'
      + '<span style="display:flex;gap:8px;align-items:center;flex-shrink:0;color:#64748b;font-size:11px">'
      + '<span>⏱ ' + timeStr + '</span>' + bottleStr
      + '</span></div>';
  }).join('');
}

async function fetchAndRender() {
  if (_viewingDate && document.hidden) return;
  try {
    const url = _viewingDate ? \`/api/dashboard?date=\${_viewingDate}\` : '/api/dashboard';
    const res = await fetch(url);
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    _lastData = data;
    // U1: render the operator strip FIRST and independently. It has its
    // own fetch + try/catch, so a renderAll() exception (renderAll is
    // large and changed often) can no longer prevent the strip from
    // showing — that was the U1 bug.
    renderOperatorStrip();
    try {
      renderAll(data);
    } catch (e) {
      console.error('renderAll error (strip already rendered):', e);
    }
    if (adminUnlocked && !_viewingDate && !window._backupChecked) {
      window._backupChecked = true;
      checkBackupStatus();
    }
  } catch (err) {
    console.error('Dashboard fetch error:', err);
    // Last-resort: still attempt the strip even if /api/dashboard failed.
    try { renderOperatorStrip(); } catch (_) {}
  }
}

// ===== OPERATOR STRIP (Entrega 3 Fase 7.2) =====
async function renderOperatorStrip() {
  const el = document.getElementById('operator-strip');
  if (!el) return;
  try {
    const url = _viewingDate ? \`/api/operator-panel?date=\${_viewingDate}\` : '/api/operator-panel';
    const res = await fetch(url);
    if (!res.ok) { el.style.display = 'none'; return; }
    const ops = await res.json();
    if (!Array.isArray(ops) || ops.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    const dot = (s) => s === 'phase' || s === 'ad_hoc' ? '🟢'
                     : s === 'break' ? '⏸' : '🔘';
    const fmt = (secs) => {
      const m = Math.floor((secs || 0) / 60);
      return m >= 60 ? \`\${Math.floor(m/60)}h\${(m%60).toString().padStart(2,'0')}m\` : \`\${m}min\`;
    };
    el.innerHTML = ops.map(o => {
      const cur = o.current
        ? \`\${dot(o.status)} \${escHtml(o.current.label)}\`
        : '🔘 sem atividade';
      return \`<a href="/operator/\${o.operator_id}" target="_blank" style="flex:0 0 auto;min-width:160px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px;text-decoration:none;color:#1f2937">
        <div style="font-weight:700;font-size:13px">\${escHtml(o.name)}</div>
        <div style="font-size:12px;margin:4px 0;color:#374151">\${cur}</div>
        <div style="font-size:11px;color:#6b7280">⏱ \${fmt(o.today.worked_seconds)} · ☕ \${fmt(o.today.break_seconds)} · 📦 \${o.today.bottles}</div>
      </a>\`;
    }).join('');
  } catch (err) {
    el.style.display = 'none';
  }
}

// ===== BACKUP STATUS CHECK =====
async function checkBackupStatus() {
  try {
    const res = await fetch(\`/api/admin/backup-status?pin=\${_adminPin}\`);
    if (!res.ok) return;
    const data = await res.json();
    const banner = document.getElementById('backup-reminder');
    if (!banner) return;
    if (data.needsBackup) {
      const days = data.daysSinceBackup !== null
        ? \`Último backup há \${data.daysSinceBackup} dias.\`
        : 'Nenhum backup realizado ainda.';
      document.getElementById('backup-reminder-text').textContent = days + ' Dados acumulados há ' + data.daysSinceOldest + ' dias.';
      banner.style.display = 'flex';
    }
  } catch(e) { /* ignore */ }
}

function downloadBackup() {
  window.open(\`/api/admin/export?pin=\${_adminPin}\`, '_blank');
  document.getElementById('backup-reminder').style.display = 'none';
  window._backupChecked = false;
}

// ===== BOOT =====
updateDate();
const _todayEt = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
document.getElementById('date-picker').max = _todayEt;

fetchAndRender().finally(() => {
  document.getElementById('loading-overlay').style.opacity = '0';
  setTimeout(() => { document.getElementById('loading-overlay').style.display = 'none'; }, 300);
});

setInterval(() => {
  if (!_viewingDate) { tickTimers(); updateBreakTime(); }
}, 1000);
setInterval(() => {
  if (!_viewingDate) { updateDate(); fetchAndRender(); }
}, 30000);
</script>
</body>
</html>`;
}

function generateEodSummary(data) {
  const { tasks = [], totalBottles = 0, date = '', openTasks = [] } = data;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resumo - ${date}</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f0f4f8; padding: 16px; color: #1f2937; }
    .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid #e5e7eb; }
    .header { background: #1d4f91; color: white; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; text-align: center; }
    .header h1 { font-size: 18px; margin: 0 0 4px; }
    .header p { font-size: 12px; opacity: 0.8; margin: 0; }
    .metric { text-align: center; }
    .metric-val { font-size: 48px; font-weight: 800; color: #1d4f91; }
    .metric-lbl { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; }
    .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .row:last-child { border-bottom: none; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; }
    .pill-green { background: #d1fae5; color: #065f46; }
    .pill-red { background: #fee2e2; color: #991b1b; }
    h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; margin: 0 0 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>HealthFare Clinic</h1>
    <p>Resumo de Producao - ${date}</p>
  </div>
  <div class="card metric">
    <div class="metric-val">${totalBottles}</div>
    <div class="metric-lbl">bottles produzidos</div>
  </div>
  <div class="card">
    <h3>Por Suplemento</h3>
    ${tasks.map(t => `
      <div class="row">
        <span><strong>${t.supplement_name}</strong> ${t.batch_number ? '#' + t.batch_number : ''}</span>
        <span>${t.bottles || 0} bottles ${t.bottles_per_hour ? `• ${t.bottles_per_hour}/h` : ''}</span>
      </div>`).join('')}
    ${!tasks.length ? '<div style="text-align:center;color:#6b7280;padding:20px">Sem tarefas concluidas</div>' : ''}
  </div>
  ${openTasks.length ? `
  <div class="card">
    <h3>Em Aberto</h3>
    ${openTasks.map(t => `
      <div class="row">
        <span>${t.supplement_name} (${t.operator || '?'})</span>
        <span class="pill pill-red">Sem F:</span>
      </div>`).join('')}
  </div>` : ''}
</body>
</html>`;
}

module.exports = { generateDashboard, generateEodSummary };
