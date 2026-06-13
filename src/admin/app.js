'use strict';
/* HEALTHFARE Admin Panel — operadores + inbox de notificações.
   Auth: cookie HttpOnly setado pelo /api/adminpanel/auth/login. */
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  function toast(m, ms) { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms || 2600); }

  let view = 'login'; // login | ops | op-edit | notifs
  let ops = []; let editing = null; let notifPoll = null;

  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(path, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    if (r.status === 401 && view !== 'login') { show('login'); throw new Error('Sessão expirou — entra de novo'); }
    if (!r.ok) throw new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status));
    return j;
  }

  function show(v) {
    view = v;
    $('view-login').classList.toggle('hidden', v !== 'login');
    $('view-ops').classList.toggle('hidden', v !== 'ops');
    $('view-op-edit').classList.toggle('hidden', v !== 'op-edit');
    $('view-notifs').classList.toggle('hidden', v !== 'notifs');
    $('hdr').classList.toggle('hidden', v === 'login');
    $('tab-ops').classList.toggle('active', v === 'ops' || v === 'op-edit');
    $('tab-notifs').classList.toggle('active', v === 'notifs');
  }

  // ── login ───────────────────────────────────────────────────
  $('btn-login').onclick = async () => {
    try {
      await api('/api/adminpanel/auth/login', { method: 'POST', body: { password: $('pw').value } });
      $('pw').value = ''; $('login-err').textContent = '';
      show('ops'); await loadOps(); refreshBadge();
    } catch (e) { $('login-err').textContent = e.message === 'wrong_password' ? 'Senha errada' : e.message; }
  };
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click(); });
  $('btn-logout').onclick = async () => { try { await api('/api/adminpanel/auth/logout', { method: 'POST' }); } catch (_) {} show('login'); };
  $('tab-ops').onclick = async () => { show('ops'); await loadOps(); };
  $('tab-notifs').onclick = async () => { show('notifs'); await loadNotifs(); };
  $('btn-back').onclick = async () => { show('ops'); await loadOps(); };

  // ── operadores ──────────────────────────────────────────────
  function rel(ts) {
    if (!ts) return 'nunca';
    const m = Math.floor((Date.now() - Date.parse(ts)) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return 'há ' + m + 'min';
    if (m < 1440) return 'há ' + Math.floor(m / 60) + 'h';
    return 'há ' + Math.floor(m / 1440) + 'd';
  }
  async function loadOps() {
    const r = await api('/api/adminpanel/operators');
    ops = r.operators;
    const box = $('ops-list'); box.innerHTML = '';
    ops.forEach((o) => {
      const status = !o.is_active ? '<span class="pill off">🔴 inativo</span>'
        : !o.has_pin ? '<span class="pill warn">🟡 sem PIN</span>'
          : '<span class="pill on">🟢 ativo</span>';
      const c = el('div', 'card');
      c.appendChild(el('div', 'row', `<span class="title">${o.display_name}</span>${status}`));
      c.appendChild(el('div', 'sub',
        `Auto-logoff: <b>${o.auto_logoff_seconds == null ? 'desligado' : o.auto_logoff_seconds + 's'}</b> · ` +
        `Pula contagem: <b>${o.count_exempt ? 'sim' : 'não'}</b> · ` +
        `Sessões ativas: <b>${o.active_session_count}</b><br>` +
        `Último login página: ${rel(o.last_page_login_at)} · Último event: ${rel(o.last_event_at)}`));
      const act = el('div', 'actions');
      const edit = el('button', null, '⚙️ Gerenciar');
      edit.onclick = () => openEdit(o);
      act.appendChild(edit);
      c.appendChild(act);
      box.appendChild(c);
    });
  }

  function openEdit(o) {
    editing = o;
    show('op-edit');
    const box = $('op-edit'); box.innerHTML = '';
    box.appendChild(el('h1', null, o.display_name));

    // PIN
    const fPin = el('div', 'field');
    fPin.appendChild(el('label', null, '🔑 Novo PIN (4 dígitos)'));
    const rowPin = el('div', 'inline');
    const inPin = el('input'); inPin.type = 'tel'; inPin.maxLength = 4; inPin.placeholder = '••••';
    const btPin = el('button', 'btn-sm', 'Atualizar PIN');
    btPin.onclick = async () => {
      if (!/^\d{4}$/.test(inPin.value)) { toast('PIN precisa de 4 dígitos'); return; }
      try { await api(`/api/adminpanel/operators/${o.id}/pin`, { method: 'POST', body: { pin: inPin.value } }); toast('✅ PIN atualizado'); inPin.value = ''; }
      catch (e) { toast('❌ ' + e.message); }
    };
    rowPin.appendChild(inPin); rowPin.appendChild(btPin); fPin.appendChild(rowPin); box.appendChild(fPin);

    // auto-logoff
    const fLg = el('div', 'field');
    fLg.appendChild(el('label', null, '⏱️ Auto-logoff (segundos; vazio = desligado)'));
    const rowLg = el('div', 'inline');
    const inLg = el('input'); inLg.type = 'number'; inLg.min = 5; inLg.max = 3600;
    inLg.value = o.auto_logoff_seconds == null ? '' : o.auto_logoff_seconds;
    const btLg = el('button', 'btn-sm', 'Salvar');
    btLg.onclick = async () => {
      const v = inLg.value === '' ? null : parseInt(inLg.value, 10);
      try { await api(`/api/adminpanel/operators/${o.id}/auto-logoff`, { method: 'PUT', body: { seconds: v } }); toast('✅ Auto-logoff salvo'); }
      catch (e) { toast('❌ ' + e.message); }
    };
    rowLg.appendChild(inLg); rowLg.appendChild(btLg); fLg.appendChild(rowLg); box.appendChild(fLg);

    // count exempt
    const fEx = el('div', 'field');
    const btEx = el('button', 'btn-big', (o.count_exempt ? '✅' : '⬜') + ' Pode pular contagem de bottles (count exempt)');
    btEx.onclick = async () => {
      try {
        const r = await api(`/api/adminpanel/operators/${o.id}/count-exempt`, { method: 'PUT', body: { exempt: !o.count_exempt } });
        o.count_exempt = r.count_exempt; btEx.innerHTML = (o.count_exempt ? '✅' : '⬜') + ' Pode pular contagem de bottles (count exempt)';
        toast('✅ salvo');
      } catch (e) { toast('❌ ' + e.message); }
    };
    fEx.appendChild(btEx); box.appendChild(fEx);

    // ativo + force logout
    const fAct = el('div', 'field');
    const btAct = el('button', 'btn-big ' + (o.is_active ? 'btn-danger' : 'btn-primary'),
      o.is_active ? '🔴 Desativar operador' : '🟢 Reativar operador');
    btAct.onclick = async () => {
      const msg = o.is_active
        ? `Vai desativar ${o.display_name} e forçar logout de ${o.active_session_count} sessão(ões). Confirma?`
        : `Reativar ${o.display_name}?`;
      if (!window.confirm(msg)) return;
      try {
        await api(`/api/adminpanel/operators/${o.id}/active`, { method: 'PUT', body: { active: !o.is_active } });
        toast('✅ feito'); show('ops'); await loadOps();
      } catch (e) { toast('❌ ' + e.message); }
    };
    fAct.appendChild(btAct); box.appendChild(fAct);

    const fFl = el('div', 'field');
    const btFl = el('button', 'btn-big btn-warn', '🚪 Forçar logout agora (mantém ativo)');
    btFl.onclick = async () => {
      try { const r = await api(`/api/adminpanel/operators/${o.id}/force-logout`, { method: 'POST', body: {} }); toast(`✅ ${r.sessions_closed} sessão(ões) encerrada(s)`); }
      catch (e) { toast('❌ ' + e.message); }
    };
    fFl.appendChild(btFl); box.appendChild(fFl);

    // timeline 7d
    const fTl = el('div', 'field');
    const btTl = el('button', 'btn-big', '📅 Ver timeline 7 dias');
    const tlBox = el('div', 'cards');
    btTl.onclick = async () => {
      try {
        const r = await api(`/api/adminpanel/operators/${o.id}/events`);
        tlBox.innerHTML = '';
        if (!r.events.length) tlBox.appendChild(el('div', 'sub', 'Nenhum event nos últimos 7 dias.'));
        r.events.forEach((ev) => tlBox.appendChild(el('div', 'card',
          `<div class="title">${ev.slug || '?'}${ev.batch_number ? ' · ' + ev.batch_number : ''}</div>` +
          `<div class="sub">${ev.started_edt} → ${ev.ended_edt || (ev.is_long_running ? 'rodando (bg)' : 'ABERTO')} · fonte: ${ev.source}</div>`)));
      } catch (e) { toast('❌ ' + e.message); }
    };
    fTl.appendChild(btTl); fTl.appendChild(tlBox); box.appendChild(fTl);
  }

  // ── notificações (inbox) ────────────────────────────────────
  const ICONS = { slack_event_not_on_page: '🔔', unfilled_bottle_count: '📊', dead_letter: '⚠️', operator_long_idle: '💤' };
  function notifSummary(n) {
    const p = n.payload || {};
    if (n.type === 'slack_event_not_on_page') return `<b>${p.person || '?'}</b> postou no Slack: "${(p.raw_slack_text || p.slug || '')}" — sem task na página`;
    if (n.type === 'unfilled_bottle_count') return `<b>${p.who_left || '?'}</b> saiu sem contar bottles de ${p.product || '?'} ${p.batch || ''}`;
    if (n.type === 'dead_letter') return `Msg em dead-letter (${p.attempts}x): "${p.text || ''}" — ${p.error || ''}`;
    return JSON.stringify(p).slice(0, 140);
  }
  async function loadNotifs() {
    const status = $('f-status').value; const type = $('f-type').value;
    const r = await api(`/api/adminpanel/notifications?status=${status}&type=${type}`);
    updateBadge(r.pending_total);
    const box = $('notifs-list'); box.innerHTML = '';
    if (!r.notifications.length) box.appendChild(el('div', 'sub', 'Nada por aqui. 🎉'));
    r.notifications.forEach((n) => {
      const c = el('div', 'card');
      c.appendChild(el('div', 'row', `<span class="title">${ICONS[n.type] || '🔸'} ${n.type.replace(/_/g, ' ')}</span><span class="sub">${n.created_edt} · ${n.status}</span>`));
      c.appendChild(el('div', 'sub', notifSummary(n)));
      if (n.status === 'pending') {
        const act = el('div', 'actions');
        const ok = el('button', 'ok', '✅ Aceitar');
        ok.onclick = async () => { if (!window.confirm('Aceitar?')) return; try { await api(`/api/adminpanel/notifications/${n.id}/accept`, { method: 'POST', body: {} }); toast('✅'); loadNotifs(); } catch (e) { toast('❌ ' + e.message); } };
        const no = el('button', 'no', '❌ Ignorar');
        no.onclick = async () => { if (!window.confirm('Ignorar (apaga o registro relacionado)?')) return; try { await api(`/api/adminpanel/notifications/${n.id}/reject`, { method: 'POST', body: {} }); toast('✅'); loadNotifs(); } catch (e) { toast('❌ ' + e.message); } };
        act.appendChild(ok); act.appendChild(no);
        if (n.type === 'slack_event_not_on_page') {
          const ed = el('button', null, '📝 Editar');
          ed.onclick = async () => {
            const batch = window.prompt('Novo lote (4 dígitos; vazio = não mexe):', (n.payload && n.payload.batch) || '');
            if (batch === null) return;
            const note = window.prompt('Nota (vazio = não mexe):', '');
            const nd = {};
            if (batch && batch.trim()) nd.batch = batch.trim();
            if (note && note.trim()) nd.note = note.trim();
            if (!Object.keys(nd).length) { toast('nada a mudar'); return; }
            try { await api(`/api/adminpanel/notifications/${n.id}/edit`, { method: 'POST', body: { new_data: nd } }); toast('✅ editado'); loadNotifs(); }
            catch (e) { toast('❌ ' + e.message); }
          };
          act.appendChild(ed);
        }
        c.appendChild(act);
      }
      box.appendChild(c);
    });
  }
  $('f-status').onchange = loadNotifs;
  $('f-type').onchange = loadNotifs;

  function updateBadge(n) {
    const b = $('notif-badge');
    b.textContent = n;
    b.classList.toggle('hidden', !n);
  }
  async function refreshBadge() {
    try { const r = await api('/api/adminpanel/notifications?status=pending&limit=1'); updateBadge(r.pending_total); } catch (_) {}
  }
  notifPoll = setInterval(() => { if (view === 'notifs') loadNotifs().catch(() => {}); else if (view !== 'login') refreshBadge(); }, 30000);

  show('login');
}());
