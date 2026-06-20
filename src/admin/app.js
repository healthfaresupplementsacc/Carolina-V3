'use strict';
/* HEALTHFARE Admin Panel — operadores + inbox de notificações.
   Auth: cookie HttpOnly setado pelo /api/adminpanel/auth/login. */
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  function toast(m, ms) { const t = $('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms || 2600); }

  let view = 'login'; // login | ops | op-edit | notifs | analytics | voices | admins | audit
  let ops = []; let editing = null; let notifPoll = null;
  let me = null; // { id, name, role } do admin logado (RBAC)
  function isOwner() { return me && me.role === 'owner'; }
  function applyRole() {
    const badge = me ? (me.role === 'owner' ? '👑 Owner' : '🛡️ Manager') : '';
    $('who').textContent = me ? `${me.name} · ${badge}` : '';
    // aba Admins só pra owner
    $('tab-admins').classList.toggle('hidden', !isOwner());
  }

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
    $('view-analytics').classList.toggle('hidden', v !== 'analytics');
    $('view-metrics').classList.toggle('hidden', v !== 'metrics');
    $('view-batches').classList.toggle('hidden', v !== 'batches');
    $('view-ems').classList.toggle('hidden', v !== 'ems');
    $('view-gaps').classList.toggle('hidden', v !== 'gaps');
    $('view-logs').classList.toggle('hidden', v !== 'logs');
    $('view-voices').classList.toggle('hidden', v !== 'voices');
    $('view-admins').classList.toggle('hidden', v !== 'admins');
    $('view-audit').classList.toggle('hidden', v !== 'audit');
    $('hdr').classList.toggle('hidden', v === 'login');
    $('tab-ops').classList.toggle('active', v === 'ops' || v === 'op-edit');
    $('tab-notifs').classList.toggle('active', v === 'notifs');
    $('tab-analytics').classList.toggle('active', v === 'analytics');
    $('tab-metrics').classList.toggle('active', v === 'metrics');
    $('tab-batches').classList.toggle('active', v === 'batches');
    $('tab-ems').classList.toggle('active', v === 'ems');
    $('tab-gaps').classList.toggle('active', v === 'gaps');
    $('tab-logs').classList.toggle('active', v === 'logs');
    $('tab-voices').classList.toggle('active', v === 'voices');
    $('tab-admins').classList.toggle('active', v === 'admins');
    $('tab-audit').classList.toggle('active', v === 'audit');
  }

  // ── login ───────────────────────────────────────────────────
  $('btn-login').onclick = async () => {
    try {
      const val = $('pw').value.trim();
      // PIN (só dígitos) vai como pin; qualquer outra coisa = senha de emergência
      const body = /^\d{4,8}$/.test(val) ? { pin: val } : { password: val };
      const r = await api('/api/adminpanel/auth/login', { method: 'POST', body });
      me = r.admin || null; applyRole();
      $('pw').value = ''; $('login-err').textContent = '';
      show('ops'); await loadOps(); refreshBadge();
    } catch (e) {
      const M = { wrong_pin: 'PIN incorreto', wrong_password: 'PIN incorreto', password_disabled: 'Senha de emergência desativada — use seu PIN', too_many_attempts: 'Muitas tentativas — espera 5min' };
      $('login-err').textContent = M[e.message] || e.message;
    }
  };
  $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-login').click(); });
  $('btn-logout').onclick = async () => { try { await api('/api/adminpanel/auth/logout', { method: 'POST' }); } catch (_) {} me = null; applyRole(); show('login'); };
  $('tab-admins').onclick = async () => { show('admins'); await loadAdmins(); };
  $('tab-ops').onclick = async () => { show('ops'); await loadOps(); };
  $('tab-notifs').onclick = async () => { show('notifs'); await loadNotifs(); };
  $('tab-analytics').onclick = async () => { show('analytics'); await loadAnalytics(); };
  $('a-range').onchange = loadAnalytics;
  $('tab-voices').onclick = async () => { show('voices'); await loadVoices(); };
  $('v-apply').onclick = () => loadVoices();
  $('tab-metrics').onclick = async () => { show('metrics'); await loadMetrics(metricsSub); };
  $('tab-batches').onclick = async () => { show('batches'); await loadUnknownBatches(); };
  $('tab-ems').onclick = async () => { show('ems'); await loadEms(); };
  $('tab-gaps').onclick = async () => { show('gaps'); await loadGaps(); };
  $('tab-logs').onclick = async () => { show('logs'); await loadActionLog(); };
  if ($('log-apply')) $('log-apply').onclick = () => loadActionLog();
  $('tab-audit').onclick = async () => { show('audit'); auditOffset = 0; await loadAudit(false); };
  $('au-actor').onchange = async () => { auditOffset = 0; await loadAudit(false); };
  let _auDeb = null;
  $('au-action').oninput = () => { clearTimeout(_auDeb); _auDeb = setTimeout(async () => { auditOffset = 0; await loadAudit(false); }, 400); };
  $('au-q').oninput = () => { clearTimeout(_auDeb); _auDeb = setTimeout(async () => { auditOffset = 0; await loadAudit(false); }, 400); };
  $('au-sensitive').onchange = async () => { auditOffset = 0; await loadAudit(false); };
  $('au-export').onclick = () => { window.location.href = '/api/adminpanel/audit/export.csv?' + auditQS().toString(); };
  $('au-more').onclick = () => loadAudit(true);
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
    const addBtn = el('button', 'btn-big btn-primary', '➕ Adicionar Operador');
    addBtn.onclick = openCreate;
    box.appendChild(addBtn);
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

    // remover (soft-delete) (Fase E)
    const fRm = el('div', 'field');
    const btRm = el('button', 'btn-big btn-danger', '🗑️ Remover operador');
    btRm.onclick = async () => {
      if (!window.confirm(`Remover ${o.display_name}? Será desativado e os events históricos ficam. Confirma?`)) return;
      if (!window.confirm('Tem CERTEZA? Essa ação desativa o operador permanentemente.')) return;
      try { await api(`/api/adminpanel/operators/${o.id}`, { method: 'DELETE' }); toast('🗑️ Removido'); show('ops'); await loadOps(); }
      catch (e) { toast('❌ ' + e.message); }
    };
    fRm.appendChild(btRm); box.appendChild(fRm);

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

    // schedule 7 dias (Fase 3)
    const fSc = el('div', 'field');
    const btSc = el('button', 'btn-big', '🕐 Editar schedule (dias da semana)');
    const scBox = el('div');
    btSc.onclick = async () => {
      if (scBox.childNodes.length) { scBox.innerHTML = ''; return; } // toggle
      try { await renderSchedule(o, scBox); } catch (e) { toast('❌ ' + e.message); }
    };
    fSc.appendChild(btSc); fSc.appendChild(scBox); box.appendChild(fSc);

    // retroactive — adicionar task em nome do operador (Parte B)
    const fRetro = el('div', 'field');
    const btRetro = el('button', 'btn-big', `🕐 Adicionar task pra ${o.display_name}`);
    const retroBox = el('div');
    btRetro.onclick = async () => {
      if (retroBox.childNodes.length) { retroBox.innerHTML = ''; return; }
      try { await renderRetroForm(o, retroBox); } catch (e) { toast('❌ ' + e.message); }
    };
    fRetro.appendChild(btRetro); fRetro.appendChild(retroBox); box.appendChild(fRetro);
  }

  async function renderRetroForm(o, box) {
    const cat = await api('/api/adminpanel/activity-types');
    box.innerHTML = '';
    box.appendChild(el('div', 'sub', 'Adiciona uma task que não foi registrada (até 7 dias atrás). Exige justificativa — fica no audit.'));
    const sel = el('select'); sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: '— tarefa —' }));
    cat.activities.forEach((a) => { const op = document.createElement('option'); op.value = a.slug; op.textContent = a.display_name; op._a = a; sel.appendChild(op); });
    const cond = el('div');
    const batchInp = el('input'); batchInp.placeholder = 'Lote (4 dígitos)';
    const noteInp = el('input'); noteInp.placeholder = 'Nota';
    const ordersInp = el('input'); ordersInp.type = 'number'; ordersInp.min = '1'; ordersInp.placeholder = 'qtd ordens';
    let curA = null;
    const fld = (lbl, inp) => { const f = el('div', 'field'); f.appendChild(el('label', null, lbl)); f.appendChild(inp); return f; };
    sel.onchange = () => {
      curA = (cat.activities.find((a) => a.slug === sel.value)) || null;
      cond.innerHTML = '';
      if (curA && curA.requires_product) cond.appendChild(fld('Lote', batchInp));
      if (curA && curA.note_required) cond.appendChild(fld('Nota (obrigatória)', noteInp));
      if (curA && curA.orders_required) cond.appendChild(fld('Qtd ordens', ordersInp));
    };
    const dateInp = el('input'); dateInp.type = 'date';
    const startInp = el('input'); startInp.type = 'time';
    const endInp = el('input'); endInp.type = 'time';
    const just = el('input'); just.placeholder = 'Justificativa (ex: sistema não registrou check-in da Ana às 9:15)';
    box.appendChild(fld('Tarefa', sel)); box.appendChild(cond);
    box.appendChild(fld('Data', dateInp)); box.appendChild(fld('Início (hora)', startInp));
    box.appendChild(fld('Fim (hora, opcional)', endInp)); box.appendChild(fld('Justificativa', just));
    const go = el('button', 'btn-big btn-primary', '✔ Adicionar');
    go.onclick = async () => {
      if (!curA) { toast('Escolhe a tarefa'); return; }
      if (!dateInp.value || !startInp.value) { toast('Data e hora de início'); return; }
      if (!just.value.trim()) { toast('Justificativa obrigatória'); return; }
      if (curA.note_required && !noteInp.value.trim()) { toast('Nota obrigatória'); return; }
      const startIso = new Date(dateInp.value + 'T' + startInp.value).toISOString();
      const endIso = endInp.value ? new Date(dateInp.value + 'T' + endInp.value).toISOString() : null;
      try {
        await api(`/api/adminpanel/operators/${o.id}/retroactive-event`, { method: 'POST', body: {
          activity_slug: curA.slug,
          batch_number: (curA.requires_product && batchInp.value.trim()) ? batchInp.value.trim() : undefined,
          note: noteInp.value.trim() || undefined,
          orders_printed: curA.orders_required ? parseInt(ordersInp.value, 10) : undefined,
          started_at: startIso, ended_at: endIso, admin_justification: just.value.trim(),
        } });
        toast('✅ Task adicionada'); box.innerHTML = '';
      } catch (e) {
        const M = { too_old: 'Máximo 7 dias atrás', started_at_future: 'Hora no futuro', ended_at_invalid: 'Fim inválido', justification_required: 'Justificativa obrigatória', unknown_batch: 'Lote não encontrado' };
        toast('❌ ' + (M[e.message] || e.message));
      }
    };
    box.appendChild(go);
  }

  const DOW_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  async function renderSchedule(o, scBox) {
    const r = await api(`/api/adminpanel/operators/${o.id}/schedule`);
    scBox.innerHTML = '';
    const todayDow = new Date().getDay();
    const rows = [];
    r.days.forEach((d) => {
      const row = el('div', 'sched-row' + (d.day_of_week === todayDow ? ' sched-today' : ''));
      row.appendChild(el('span', 'sched-day', DOW_LABELS[d.day_of_week]));
      const start = el('input'); start.type = 'time'; start.value = d.expected_start_time || '';
      const end = el('input'); end.type = 'time'; end.value = d.expected_end_time || '';
      const wk = el('input'); wk.type = 'checkbox'; wk.checked = d.is_workday !== false;
      const note = el('input'); note.type = 'text'; note.placeholder = 'nota'; note.value = d.notes || ''; note.className = 'sched-note';
      row.appendChild(start); row.appendChild(end);
      const wkL = el('label', 'chk'); wkL.appendChild(wk); wkL.appendChild(el('span', null, 'trabalha')); row.appendChild(wkL);
      row.appendChild(note);
      scBox.appendChild(row);
      rows.push({ dow: d.day_of_week, start, end, wk, note });
    });
    const save = async (list) => {
      for (const x of list) {
        const body = { expected_start_time: x.start.value || null, expected_end_time: x.end.value || null, is_workday: x.wk.checked, notes: x.note.value || null };
        await api(`/api/adminpanel/operators/${o.id}/schedule/${x.dow}`, { method: 'PUT', body });
      }
    };
    const bSave = el('button', 'btn-primary', '💾 Salvar schedule');
    bSave.onclick = async () => { try { await save(rows); toast('✅ schedule salvo'); } catch (e) { toast('❌ ' + ({ end_before_start: 'Fim antes do início', bad_time: 'Hora inválida' }[e.message] || e.message)); } };
    const bCopy = el('button', 'btn-sm', '📋 Aplicar Seg→Sex (copia Segunda)');
    bCopy.onclick = async () => {
      const mon = rows.find((x) => x.dow === 1);
      [2, 3, 4, 5].forEach((dw) => { const t = rows.find((x) => x.dow === dw); if (t && mon) { t.start.value = mon.start.value; t.end.value = mon.end.value; t.wk.checked = mon.wk.checked; } });
      toast('Copiado da Segunda (revise e salve)');
    };
    scBox.appendChild(bCopy); scBox.appendChild(bSave);
  }

  // ── notificações (inbox) ────────────────────────────────────
  const ICONS = { slack_event_not_on_page: '🔔', unfilled_bottle_count: '📊', dead_letter: '⚠️', operator_long_idle: '💤', event_stale_no_close: '⏰', bottle_count_anomaly: '📊' };
  function notifSummary(n) {
    const p = n.payload || {};
    if (n.type === 'slack_event_not_on_page') return `<b>${p.person || '?'}</b> postou no Slack: "${(p.raw_slack_text || p.slug || '')}" — sem task na página`;
    if (n.type === 'unfilled_bottle_count') return `<b>${p.who_left || '?'}</b> saiu sem contar bottles de ${p.product || '?'} ${p.batch || ''}`;
    if (n.type === 'dead_letter') return `Msg em dead-letter (${p.attempts}x): "${p.text || ''}" — ${p.error || ''}`;
    if (n.type === 'operator_long_idle') return `<b>${p.person || '?'}</b> logado sem atividade há ${p.idle_min}min`;
    if (n.type === 'event_stale_no_close') return `Task ev${p.event_id} de <b>${p.person || '?'}</b> (${p.slug || '?'}) aberta há ${p.h_open}h`;
    if (n.type === 'bottle_count_anomaly') return `Count anômalo: ${p.product || '?'} = ${p.bottles} bottles (média ${p.avg}, ${p.deviation_pct > 0 ? '+' : ''}${p.deviation_pct}%)`;
    return JSON.stringify(p).slice(0, 140);
  }
  async function loadNotifs() {
    const status = $('f-status').value; const type = $('f-type').value;
    const origin = $('f-origin') ? $('f-origin').value : 'all';
    const r = await api(`/api/adminpanel/notifications?status=${status}&type=${type}&origin=${origin}`);
    updateBadge(r.pending_total);
    const box = $('notifs-list'); box.innerHTML = '';
    if (!r.notifications.length) box.appendChild(el('div', 'sub', 'Nada por aqui. 🎉'));
    r.notifications.forEach((n) => {
      const c = el('div', 'card');
      const dm = n.delivery_method === 'admin_inbox_only' ? ' <span class="pill warn" title="silenciado — não foi pro Slack">🔕 só inbox</span>'
        : n.delivery_method === 'slack_and_inbox' ? ' <span class="pill on" title="Carolina postou no Slack">📢</span>' : '';
      c.appendChild(el('div', 'row', `<span class="title">${ICONS[n.type] || '🔸'} ${n.type.replace(/_/g, ' ')}${dm}</span><span class="sub">${n.created_edt} · ${n.status}</span>`));
      c.appendChild(el('div', 'sub', notifSummary(n)));
      if (n.status === 'pending') {
        const act = el('div', 'actions');
        const callAction = (verb, confirmMsg) => async () => {
          if (confirmMsg && !window.confirm(confirmMsg)) return;
          try { await api(`/api/adminpanel/notifications/${n.id}/${verb}`, { method: 'POST', body: {} }); toast('✅'); loadNotifs(); }
          catch (e) { toast('❌ ' + e.message); }
        };
        // ações específicas por tipo
        if (n.type === 'operator_long_idle') {
          const ok = el('button', 'ok', '✅ ok'); ok.onclick = callAction('accept');
          const fl = el('button', 'no', '💤 Force logout'); fl.onclick = callAction('force-logout', 'Forçar logout dessa sessão?');
          act.appendChild(ok); act.appendChild(fl);
          c.appendChild(act); box.appendChild(c); return;
        }
        if (n.type === 'event_stale_no_close') {
          const ig = el('button', 'ok', '✅ ignora'); ig.onclick = callAction('accept');
          const cl = el('button', 'no', '⏱️ fecha agora'); cl.onclick = callAction('close-event', 'Fechar essa task agora (ended_at=agora)?');
          act.appendChild(ig); act.appendChild(cl);
          c.appendChild(act); box.appendChild(c); return;
        }
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
  if ($('f-origin')) $('f-origin').onchange = loadNotifs;

  function updateBadge(n) {
    const b = $('notif-badge');
    b.textContent = n;
    b.classList.toggle('hidden', !n);
  }
  async function refreshBadge() {
    try { const r = await api('/api/adminpanel/notifications?status=pending&limit=1'); updateBadge(r.pending_total); } catch (_) {}
    refreshExcBadge();
    refreshBatchBadge();
  }
  async function refreshExcBadge() {
    const b = $('exc-badge'); if (!b) return;
    try { const r = await api('/api/adminpanel/metrics/exceptions-count'); b.textContent = r.count; b.classList.toggle('hidden', !r.count); } catch (_) {}
  }
  async function refreshBatchBadge() {
    const b = $('batch-badge'); if (!b) return;
    try { const r = await api('/api/adminpanel/metrics/unknown-batches-count'); b.textContent = r.count; b.classList.toggle('hidden', !r.count); } catch (_) {}
  }
  // 🟡 lotes desconhecidos: confirma (vira válido) ou marca erro (soft-delete)
  async function loadUnknownBatches() {
    const box = $('batches-list'); box.innerHTML = '';
    let r;
    try { r = await api('/api/adminpanel/unknown-batches'); } catch (e) { box.appendChild(el('div', 'sub', '❌ ' + e.message)); return; }
    if (!r.batches.length) { box.appendChild(el('div', 'sub', 'Nenhum lote desconhecido pendente. 🎉')); return; }
    r.batches.forEach((b) => {
      const card = el('div', 'card');
      card.appendChild(el('div', 'row', `<span class="title">${b.batch_number}</span><span class="sub">${b.product || '⚠️ produto não identificado'}</span>`));
      card.appendChild(el('div', 'sub', `Criado por ${b.created_by || '?'} · ${b.created_at_edt || ''} · ${b.events_count} task(s)`));
      const act = el('div', 'actions');
      const ok = el('button', 'ok', '✅ Confirmar válido');
      const no = el('button', 'no', '🗑️ Marcar erro');
      ok.onclick = async () => { ok.disabled = no.disabled = true; try { await api(`/api/adminpanel/unknown-batches/${b.id}/confirm`, { method: 'POST', body: {} }); toast('✅ lote confirmado'); refreshBatchBadge(); loadUnknownBatches(); } catch (e) { ok.disabled = no.disabled = false; toast('❌ ' + e.message); } };
      no.onclick = async () => { if (!window.confirm('Marcar como erro? O lote será removido (soft-delete).')) return; no.disabled = ok.disabled = true; try { await api(`/api/adminpanel/unknown-batches/${b.id}/reject`, { method: 'POST', body: {} }); toast('🗑️ lote removido'); refreshBatchBadge(); loadUnknownBatches(); } catch (e) { no.disabled = ok.disabled = false; toast('❌ ' + e.message); } };
      act.appendChild(ok); act.appendChild(no); card.appendChild(act);
      box.appendChild(card);
    });
  }
  // 🏭 atividade EMS (espelho local, 1 sistema). Auto-refresh enquanto a aba está aberta.
  let emsPoll = null;
  function fmtSecs(s) { const m = Math.floor((s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}min`; }
  async function loadEms() {
    let r;
    try { r = await api('/api/adminpanel/ems-activity'); } catch (e) { $('ems-active').innerHTML = ''; $('ems-active').appendChild(el('div', 'sub', '❌ ' + e.message)); return; }
    const act = $('ems-active'); act.innerHTML = '';
    if (!r.active.length) act.appendChild(el('div', 'sub', 'Nenhuma atividade EMS ativa agora.'));
    r.active.forEach((a) => {
      const who = a.tracker_name || a.employee_ems_name || '—';
      act.appendChild(el('div', 'card', `<div class="row"><span class="title">${a.machine || a.process_type} · ${a.supplement_name || '?'}</span><span class="sub">${fmtSecs(a.elapsed_seconds)}</span></div><div class="sub">${who} · ${a.process_type}${a.stage ? ' (' + a.stage + ')' : ''} · lote ${a.batch_number || '—'}${a.target_bottles ? ' · meta ' + a.target_bottles : ''}</div>`));
    });
    const mb = $('ems-machine'); mb.innerHTML = '';
    if (!r.by_machine.length) mb.appendChild(el('div', 'sub', '—'));
    r.by_machine.forEach((m) => mb.appendChild(el('div', 'card', `<div class="row"><span class="title">${m.machine}</span><span class="sub">${fmtSecs(m.total_seconds)} · ${m.runs}x</span></div>`)));
    const eb = $('ems-employee'); eb.innerHTML = '';
    if (!r.by_employee.length) eb.appendChild(el('div', 'sub', '—'));
    r.by_employee.forEach((e2) => eb.appendChild(el('div', 'card', `<div class="row"><span class="title">${e2.name}</span><span class="sub">${fmtSecs(e2.total_seconds)} · ${e2.runs}x</span></div>`)));
    clearInterval(emsPoll);
    emsPoll = setInterval(() => { if (view === 'ems') loadEms().catch(() => {}); else clearInterval(emsPoll); }, 60000);
  }
  // ⏱️ gaps de atividade do dia (resumo por operador + lista justificada)
  async function loadGaps() {
    const sumBox = $('gaps-summary'); const box = $('gaps-list'); sumBox.innerHTML = ''; box.innerHTML = '';
    let r;
    try { r = await api('/api/adminpanel/gaps'); } catch (e) { box.appendChild(el('div', 'sub', '❌ ' + e.message)); return; }
    (r.summary || []).forEach((s) => {
      sumBox.appendChild(el('div', 'card', `<div class="row"><span class="title">${s.display_name}</span><span class="sub">${s.gaps} gap(s) · ${s.total_min} min · média ${s.avg_min} min</span></div>`));
    });
    if (!r.gaps.length) { box.appendChild(el('div', 'sub', 'Nenhum gap registrado hoje. 🎉')); return; }
    r.gaps.forEach((g) => {
      const card = el('div', 'card');
      card.appendChild(el('div', 'row', `<span class="title">${g.display_name} · ${g.gap_minutes} min</span><span class="sub">${g.justification_type || '—'} · ${g.created_edt}</span>`));
      card.appendChild(el('div', 'sub', `“${g.justification_note || ''}”`));
      box.appendChild(card);
    });
  }
  // 📜 action_log: rede de segurança (5 dias). Filtra por dia + busca livre.
  async function loadActionLog() {
    const box = $('logs-list'); box.innerHTML = '';
    const day = $('log-day') && $('log-day').value ? $('log-day').value : '';
    const q = $('log-q') && $('log-q').value ? $('log-q').value.trim() : '';
    const qs = [day ? 'day=' + day : '', q ? 'q=' + encodeURIComponent(q) : ''].filter(Boolean).join('&');
    let r;
    try { r = await api('/api/adminpanel/action-log' + (qs ? '?' + qs : '')); } catch (e) { box.appendChild(el('div', 'sub', '❌ ' + e.message)); return; }
    if (!r.entries.length) { box.appendChild(el('div', 'sub', 'Nenhum registro. 🤷')); return; }
    const ICON = { login: '🔑', task_start: '▶️', task_finish: '✅', cowork_join: '👥', gap_justify: '⏱️', end_of_day: '📊', admin_action: '🛠️', slack_message: '💬' };
    r.entries.forEach((e) => {
      const card = el('div', 'card');
      const test = e.is_test ? ' <span style="color:#0a9aa6">🧪</span>' : '';
      card.appendChild(el('div', 'row', `<span class="title">${ICON[e.action_type] || '•'} ${e.person_name || '?'} · ${e.action_type}${test}</span><span class="sub">${e.at_edt} · ${e.source}</span>`));
      const pay = e.payload && Object.keys(e.payload).length ? JSON.stringify(e.payload) : (e.raw_text || '');
      if (pay) card.appendChild(el('div', 'sub', `<code style="font-size:11px;word-break:break-all">${String(pay).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).slice(0, 300)}</code>`));
      box.appendChild(card);
    });
  }
  notifPoll = setInterval(() => { if (view === 'notifs') loadNotifs().catch(() => {}); else if (view !== 'login') refreshBadge(); }, 30000);

  // ── analytics (Fase B) ──────────────────────────────────────
  const charts = {};
  function drawChart(id, cfg) {
    if (!window.Chart) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new window.Chart($(id).getContext('2d'), cfg);
  }
  async function loadAnalytics() {
    let s;
    try { s = await api('/api/adminpanel/analytics/summary?range=' + $('a-range').value); }
    catch (e) { toast('❌ ' + e.message); return; }
    $('a-cards').innerHTML = '';
    const metric = (big, lbl) => { const d = el('div', 'metric'); d.appendChild(el('div', 'big', String(big))); d.appendChild(el('div', 'lbl', lbl)); return d; };
    $('a-cards').appendChild(metric(s.total_events_count, 'Eventos'));
    $('a-cards').appendChild(metric(s.total_bottles.toLocaleString('pt-BR'), 'Bottles'));
    $('a-cards').appendChild(metric(s.top_operators.length, 'Operadores ativos'));
    const totHours = s.daily_breakdown.reduce((a, d) => a + Number(d.hours), 0);
    $('a-cards').appendChild(metric(Math.round(totHours) + 'h', 'Horas trabalhadas'));

    drawChart('chart-bottles', {
      type: 'line',
      data: { labels: s.daily_breakdown.map((d) => String(d.day).slice(5)), datasets: [{ label: 'Bottles/dia', data: s.daily_breakdown.map((d) => d.bottles), borderColor: '#0e7a4e', backgroundColor: 'rgba(14,122,78,.15)', fill: true, tension: .3 }] },
      options: { plugins: { title: { display: true, text: '🍶 Bottles produzidos por dia' } } },
    });
    drawChart('chart-ops', {
      type: 'bar',
      data: { labels: s.top_operators.map((o) => o.display_name), datasets: [{ label: 'Horas', data: s.top_operators.map((o) => Number(o.hours)), backgroundColor: '#2c505f' }] },
      options: { indexAxis: 'y', plugins: { title: { display: true, text: '👷 Horas por operador' } } },
    });
    drawChart('chart-slugs', {
      type: 'doughnut',
      data: { labels: s.avg_task_duration_minutes_by_slug.slice(0, 8).map((x) => x.slug || '?'), datasets: [{ data: s.avg_task_duration_minutes_by_slug.slice(0, 8).map((x) => x.n), backgroundColor: ['#0e7a4e', '#2c505f', '#b35c00', '#b3261e', '#6b46c1', '#0891b2', '#65a30d', '#9333ea'] }] },
      options: { plugins: { title: { display: true, text: '🧩 Eventos por tipo de tarefa' } } },
    });
    if (s.voice_usage) $('a-cards').appendChild(metric('🎤 ' + s.voice_usage.count, Math.round((s.voice_usage.total_seconds || 0) / 60) + ' min de voz'));
    let html = '<table class="dt"><tr><th>Dia</th><th>Eventos</th><th>Bottles</th><th>Horas</th></tr>';
    s.daily_breakdown.slice().reverse().forEach((d) => { html += `<tr><td>${d.day}</td><td>${d.events}</td><td>${d.bottles}</td><td>${d.hours}</td></tr>`; });
    if (s.minutes_per_order && s.minutes_per_order.length) {
      html += '</table><h2>⏱️ Min por ordem impressa</h2><table class="dt"><tr><th>Tipo</th><th>Ordens</th><th>Min/ordem</th></tr>';
      s.minutes_per_order.forEach((o) => { html += `<tr><td>${o.slug}</td><td>${o.total_orders}</td><td>${o.min_por_ordem || '—'}</td></tr>`; });
    }
    $('a-table').innerHTML = html + '</table>';
    // notas de voz recentes (player) — Fase 0 / addition C
    try {
      const v = await api('/api/adminpanel/voice/recent?limit=20');
      if (v.voice && v.voice.length) {
        const vb = el('div'); vb.appendChild(el('h2', null, '🎤 Notas de voz recentes'));
        v.voice.forEach((rec) => {
          const c = el('div', 'card');
          c.appendChild(el('div', 'sub', `${rec.person} · ${rec.created_edt} · ${rec.audio_duration_seconds || '?'}s · ${rec.transcript_language || ''}`));
          const au = document.createElement('audio'); au.controls = true; au.preload = 'none'; au.src = '/api/adminpanel/voice/' + rec.id; au.style.width = '100%';
          c.appendChild(au);
          if (rec.transcript) c.appendChild(el('div', 'sub', '“' + rec.transcript + '”'));
          vb.appendChild(c);
        });
        $('a-table').appendChild(vb);
      }
    } catch (_) { /* sem voz */ }
  }

  // ── métricas (Fase 5) ───────────────────────────────────────
  let metricsSub = 'hoje';
  let linhaTimer = null; // auto-refresh da aba Linha (60s)
  const mchart = {};
  function mDrawChart(id, cfg) { if (!window.Chart) return; if (mchart[id]) mchart[id].destroy(); mchart[id] = new window.Chart($(id).getContext('2d'), cfg); }
  function mMetric(big, lbl) { const d = el('div', 'metric'); d.appendChild(el('div', 'big', String(big))); d.appendChild(el('div', 'lbl', lbl)); return d; }
  async function loadMetrics(sub) {
    metricsSub = sub || 'hoje';
    clearInterval(linhaTimer); // sai da aba Linha → para o auto-refresh
    const SUBS = [['hoje', '🎯 Hoje'], ['linha', '🏭 Linha'], ['operador', '👤 Operador'], ['tasks', '📋 Tasks'], ['unfinished', '⚠️ Não finalizadas'], ['revisao', '🔬 Revisão'], ['cleaning', '🧽 Limpeza'], ['targets', '📊 Targets'], ['tendencias', '📈 Tendências'], ['anomalias', '🔥 Anomalias'], ['rankings', '🏆 Rankings'], ['insights', '🤖 Insights']];
    if (isOwner()) SUBS.push(['finance', '💰 Finance']);
    const nav = $('metrics-subnav'); nav.innerHTML = '';
    SUBS.forEach(([k, lbl]) => { const b = el('button', 'subtab' + (k === metricsSub ? ' active' : ''), lbl); b.onclick = () => loadMetrics(k); nav.appendChild(b); });
    const c = $('metrics-content'); c.innerHTML = '<div class="sub">carregando…</div>';
    try { await M_RENDER[metricsSub](c); } catch (e) { c.innerHTML = ''; c.appendChild(el('div', 'err', e.message)); }
  }
  // FASE 6 (P6.3) — card "P&P" navegável (Ontem/Hoje). Lê pp-today?date=.
  async function renderPpCard(box, dateStr) {
    box.innerHTML = '<div class="sub">carregando P&P…</div>';
    let pp; try { pp = await api('/api/adminpanel/metrics/pp-today' + (dateStr ? '?date=' + dateStr : '')); } catch (e) { box.innerHTML = ''; return; }
    if (!pp) { box.innerHTML = ''; return; }
    const COL = { green: '#0e7a4e', yellow: '#b35c00', red: '#b3261e' };
    const cut = pp.cutoff_color ? (COL[pp.cutoff_color] || '#5a6e87') : '#5a6e87';
    const secO = pp.sec_per_order != null ? pp.sec_per_order + 's/ordem' : '—';
    const mins = Math.round((pp.work_seconds || 0) / 60);
    const yStr = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    box.innerHTML = '';
    const card = el('div', 'card'); card.style.borderLeft = '4px solid ' + cut;
    const cutTxt = pp.cutoff_color ? `corte 1pm: ${pp.cutoff_color.toUpperCase()}${pp.open_pp_tasks ? ' · ' + pp.open_pp_tasks + ' aberta(s)' : ''}` : '';
    let html = `<div class="row"><span class="title">📦 P&P · ${pp.is_past ? pp.date : 'hoje'}</span><span class="sub" style="color:${cut};font-weight:700;">${cutTxt}</span></div>`;
    html += `<div class="sub">${Number(pp.total_orders).toLocaleString('pt-BR')} ordens · ${mins}min · ${secO} · ${pp.total_tasks} tarefa(s) — clínica NÃO conta</div>`;
    if ((pp.by_marketplace || []).length) html += '<div class="sub">marketplace: ' + pp.by_marketplace.map((m) => `${m.marketplace}: ${m.orders}`).join(' · ') + '</div>';
    if ((pp.by_operator || []).length) html += '<div class="sub">operador: ' + pp.by_operator.map((o) => `${o.operator}: ${o.orders}`).join(' · ') + '</div>';
    card.innerHTML = html;
    const nav = el('div', 'row');
    const bY = el('button', 'subtab' + (pp.is_past ? ' active' : ''), '◂ Ontem');
    const bT = el('button', 'subtab' + (pp.is_past ? '' : ' active'), 'Hoje ▸');
    bY.onclick = () => renderPpCard(box, yStr);
    bT.onclick = () => renderPpCard(box, null);
    nav.appendChild(bY); nav.appendChild(bT);
    card.appendChild(nav); box.appendChild(card);
  }
  const M_RENDER = {
    // ITEM 3 — limpeza das máquinas (do EMS)
    cleaning: async (c) => {
      const r = await api('/api/adminpanel/metrics/cleaning');
      c.innerHTML = '';
      c.appendChild(el('h2', null, '🧽 Última limpeza por máquina'));
      if (!(r.per_machine || []).length) { c.appendChild(el('div', 'sub', 'Sem registros de limpeza ainda.')); }
      (r.per_machine || []).forEach((m) => {
        const ok = m.status === 'passed' || m.inspection_result === 'pass';
        c.appendChild(el('div', 'card', `<div class="row"><span class="title">${ok ? '✅' : '⚠️'} ${m.machine}</span><span class="sub">${m.cleaning_type || ''} · ${m.cleaned_by_name || '?'} · ${m.cleaned_at || '—'}${m.previous_formula ? ' · após ' + m.previous_formula : ''}</span></div>`));
      });
      if ((r.recent || []).length) {
        c.appendChild(el('h2', null, '🗒️ Limpezas recentes'));
        r.recent.forEach((x) => c.appendChild(el('div', 'card', `<div class="sub">${x.log_number} · ${x.machine} · ${x.cleaning_type || ''} · ${x.cleaned_by_name || '?'} · ${x.cleaned_at || '—'} · ${x.status || ''}</div>`)));
      }
    },
    // ITEM 2 — taxa de revisão (cápsulas/seg, frascos/min) + estimativa
    revisao: async (c) => {
      const r = await api('/api/adminpanel/metrics/review-rate?range=30d');
      c.innerHTML = ''; const cards = el('div', 'metric-cards');
      cards.appendChild(mMetric(r.avg_capsules_per_sec != null ? r.avg_capsules_per_sec : '—', '🔬 Cápsulas/seg (méd)'));
      cards.appendChild(mMetric(r.avg_bottles_per_min != null ? r.avg_bottles_per_min : '—', '🔬 Frascos/min (méd)'));
      cards.appendChild(mMetric(r.n, 'Revisões medidas (30d)'));
      c.appendChild(cards);
      if (r.avg_capsules_per_sec) {
        c.appendChild(el('div', 'sub', `Estimativa: revisar 1 frasco de 200 cáps ≈ ${Math.round(200 / r.avg_capsules_per_sec)}s · 1 frasco de 400 ≈ ${Math.round(400 / r.avg_capsules_per_sec)}s`));
      }
      c.appendChild(el('h2', null, 'Revisões recentes'));
      if (!(r.runs || []).length) c.appendChild(el('div', 'sub', 'Sem revisões com lote+fórmula vinculados ainda (precisa do produto linkado).'));
      (r.runs || []).slice(0, 15).forEach((x) => c.appendChild(el('div', 'card', `<div class="row"><span class="title">${x.operator} · ${x.product || x.batch}</span><span class="sub">${x.bottles} frascos · ${Number(x.capsules).toLocaleString('pt-BR')} cáps · ${Math.round(x.work_sec / 60)}min · ${x.capsules_per_sec} cáps/s · ${x.bottles_per_min} frasco/min</span></div>`)));
    },
    // FASE 6 (P6.4) — tarefas não finalizadas (pausa que virou o dia): admin
    // resolve finalizando ou reatribuindo a outro operador (que continua/fecha).
    unfinished: async (c) => {
      const [r, opsR] = await Promise.all([
        api('/api/adminpanel/metrics/unfinished'),
        api('/api/adminpanel/operators').catch(() => ({ operators: [] })),
      ]);
      c.innerHTML = '';
      c.appendChild(el('h2', null, '⚠️ Tarefas não finalizadas (pausa que virou o dia)'));
      const list = r.unfinished || [];
      if (!list.length) { c.appendChild(el('div', 'sub', 'Nenhuma tarefa pendente. ✅')); return; }
      const opts = (opsR.operators || []).filter((o) => o.is_active !== false).map((o) => `<option value="${o.id}">${o.display_name}</option>`).join('');
      list.forEach((u) => {
        const mins = Math.round((u.worked_seconds || 0) / 60);
        const card = el('div', 'card');
        card.appendChild(el('div', 'row', `<span class="title">${u.operator} · ${u.task || u.slug || '?'}</span><span class="sub">${(u.product || '')}${u.batch_number ? ' · ' + u.batch_number : ''} · trabalhou ${mins}min antes da pausa</span>`));
        const actions = el('div', 'row');
        const sel = el('select'); sel.innerHTML = opts; sel.style.marginRight = '8px';
        const reBtn = el('button', 'subtab', 'Reatribuir →');
        const finBtn = el('button', 'subtab', 'Finalizar');
        finBtn.onclick = async () => {
          if (!window.confirm('Finalizar esta tarefa (fecha sem contagem)?')) return;
          finBtn.disabled = reBtn.disabled = true;
          try { await api(`/api/adminpanel/metrics/unfinished/${u.id}/resolve`, { method: 'POST', body: { action: 'finalize' } }); toast('✅ finalizada'); loadMetrics('unfinished'); }
          catch (e) { finBtn.disabled = reBtn.disabled = false; toast('❌ ' + e.message); }
        };
        reBtn.onclick = async () => {
          const to = parseInt(sel.value, 10); if (!(to > 0)) { toast('Escolha um operador'); return; }
          finBtn.disabled = reBtn.disabled = true;
          try { await api(`/api/adminpanel/metrics/unfinished/${u.id}/resolve`, { method: 'POST', body: { action: 'reassign', assignee_person_id: to } }); toast('✅ reatribuída — vira tarefa ativa do operador'); loadMetrics('unfinished'); }
          catch (e) { finBtn.disabled = reBtn.disabled = false; toast('❌ ' + e.message); }
        };
        actions.appendChild(sel); actions.appendChild(reBtn); actions.appendChild(finBtn);
        card.appendChild(actions); c.appendChild(card);
      });
    },
    hoje: async (c) => {
      const r = await api('/api/adminpanel/metrics/realtime');
      c.innerHTML = ''; const cards = el('div', 'metric-cards');
      cards.appendChild(mMetric(r.logged_in_operators.length, 'Logados agora'));
      cards.appendChild(mMetric(Number(r.bottles_today).toLocaleString('pt-BR'), 'Bottles hoje'));
      cards.appendChild(mMetric(Number(r.orders_today).toLocaleString('pt-BR'), 'Ordens hoje (P&P)'));
      cards.appendChild(mMetric(r.hours_today + 'h', 'Horas hoje (desc. pausa)'));
      c.appendChild(cards);
      // FASE 6 (P6.3) — card "📦 P&P" com navegação Ontem/Hoje (clínica NÃO conta)
      const ppBox = el('div'); c.appendChild(ppBox); renderPpCard(ppBox, null);
      c.appendChild(el('h2', null, '👷 Operadores logados'));
      r.logged_in_operators.forEach((o) => {
        const sem = o.idle_min > 120 ? '🔴' : o.idle_min > 30 ? '🟡' : '🟢';
        c.appendChild(el('div', 'card', `<div class="row"><span class="title">${sem} ${o.display_name}</span><span class="sub">${o.current_task || 'sem task'} · ocioso ${o.idle_min}min</span></div>`));
      });
      if (r.tasks_open_long.length) {
        c.appendChild(el('h2', null, '⏰ Tasks abertas há +1h'));
        r.tasks_open_long.forEach((t) => c.appendChild(el('div', 'card', `<div class="sub">ev${t.id} · ${t.display_name} · ${t.task || '?'} · ${t.hours_open}h</div>`)));
      }
    },
    linha: async (c) => {
      const draw = async () => {
        const r = await api('/api/adminpanel/metrics/production-line');
        c.innerHTML = '';
        const cards = el('div', 'metric-cards');
        cards.appendChild(mMetric(r.goals_in_progress.length, '🎯 Metas em curso'));
        cards.appendChild(mMetric(Number(r.production_today.total).toLocaleString('pt-BR'), '📦 Bottles hoje'));
        cards.appendChild(mMetric(r.throughput.avg_bpm == null ? '—' : r.throughput.avg_bpm, '⚡ Bottles/min (méd)'));
        cards.appendChild(mMetric(r.throughput.avg_bph == null ? '—' : r.throughput.avg_bph, '⚡ Bottles/hora (méd)'));
        c.appendChild(cards);
        // 🎯 Metas em curso
        c.appendChild(el('h2', null, '🎯 Metas em Curso'));
        if (!r.goals_in_progress.length) c.appendChild(el('div', 'sub', 'Nenhuma linha de produção aberta agora.'));
        r.goals_in_progress.forEach((g) => c.appendChild(el('div', 'card', `<div class="row"><span class="title">${g.product || '?'} · ${g.batch_number || '—'}</span><span class="sub">${g.operator} · há ${g.elapsed_min} min</span></div>`)));
        // 📦 Produção hoje por produto
        if (r.production_today.by_product.length) {
          c.appendChild(el('h2', null, '📦 Produção Hoje · por produto'));
          r.production_today.by_product.forEach((p) => c.appendChild(el('div', 'card', `<div class="row"><span class="title">${p.product}</span><span class="sub">${Number(p.total).toLocaleString('pt-BR')} bottles</span></div>`)));
        }
        // ⚡ Throughput por operador
        if (r.throughput.by_operator.length) {
          c.appendChild(el('h2', null, '⚡ Bottles/Minuto · por operador'));
          c.appendChild(el('div', 'sub', `Pico: ${r.throughput.peak_bpm == null ? '—' : r.throughput.peak_bpm} b/min · ${r.throughput.runs} corridas hoje`));
          r.throughput.by_operator.forEach((o) => c.appendChild(el('div', 'card', `<div class="row"><span class="title">${o.operator}</span><span class="sub">${o.avg_bpm == null ? '—' : o.avg_bpm} b/min · ${Math.round((o.avg_bpm || 0) * 60)} b/h · ${o.runs}x</span></div>`)));
        }
        // ⚠️ Exceções hoje
        c.appendChild(el('h2', null, '⚠️ Exceções Hoje · sem contagem'));
        if (!r.exceptions.length) c.appendChild(el('div', 'sub', 'Nenhuma exceção pendente hoje. 🎉'));
        r.exceptions.forEach((ex) => {
          const card = el('div', 'card');
          card.appendChild(el('div', 'row', `<span class="title">${ex.product || '?'} · ${ex.batch_number || '—'}</span><span class="sub">${ex.operator} · ${ex.ended_at}</span>`));
          card.appendChild(el('div', 'sub', `Motivo: “${ex.exception_reason || ''}”`));
          const act = el('div', 'actions');
          const addBtn = el('button', 'ok', '➕ Adicionar contagem');
          // form inline (clica direto no event e adiciona — sem modal separado)
          const inStyle = 'width:100%; min-height:44px; margin-bottom:8px; padding:8px 12px; border:1px solid #cdd8e3; border-radius:10px; font-size:15px;';
          const form = el('div'); form.style.cssText = 'display:none; margin-top:10px;';
          const inB = document.createElement('input'); inB.type = 'number'; inB.min = '0'; inB.placeholder = 'Quantos bottles? (ex: 754)'; inB.style.cssText = inStyle;
          const inN = document.createElement('input'); inN.type = 'text'; inN.placeholder = 'Nota: como você obteve a contagem'; inN.style.cssText = inStyle;
          const fa = el('div', 'actions');
          const save = el('button', 'ok', '✓ Registrar');
          const cancel = el('button', 'no', 'Cancelar');
          fa.appendChild(cancel); fa.appendChild(save);
          form.appendChild(inB); form.appendChild(inN); form.appendChild(fa);
          addBtn.onclick = () => { const open = form.style.display !== 'none'; form.style.display = open ? 'none' : 'block'; if (!open) inB.focus(); };
          cancel.onclick = () => { form.style.display = 'none'; };
          save.onclick = async () => {
            const n = parseInt(inB.value, 10);
            if (!(n >= 0)) { toast('❌ informe um número válido'); inB.focus(); return; }
            save.disabled = true;
            try { await api(`/api/adminpanel/exceptions/${ex.id}/resolve`, { method: 'POST', body: { bottles_count: n, admin_note: inN.value || '' } }); toast('✅ contagem registrada'); refreshExcBadge(); draw(); }
            catch (e) { save.disabled = false; toast('❌ ' + e.message); }
          };
          act.appendChild(addBtn); card.appendChild(act); card.appendChild(form);
          c.appendChild(card);
        });
      };
      await draw();
      clearInterval(linhaTimer); // auto-refresh 60s só enquanto a aba Linha está aberta
      linhaTimer = setInterval(() => { if (view === 'metrics' && metricsSub === 'linha') draw().catch(() => {}); else clearInterval(linhaTimer); }, 60000);
    },
    operador: async (c) => {
      if (!ops.length) { try { ops = (await api('/api/adminpanel/operators')).operators; } catch (_) {} }
      c.innerHTML = '';
      const sel = el('select'); sel.appendChild(el('option', null, '— escolha o operador —'));
      ops.forEach((o) => { const op = document.createElement('option'); op.value = o.id; op.textContent = o.display_name; sel.appendChild(op); });
      const out = el('div'); c.appendChild(sel); c.appendChild(out);
      sel.onchange = async () => {
        if (!sel.value) return; out.innerHTML = '<div class="sub">…</div>';
        const m = await api(`/api/adminpanel/metrics/operator/${sel.value}?range=30d`);
        out.innerHTML = ''; const cards = el('div', 'metric-cards');
        cards.appendChild(mMetric(m.total_events, 'Events 30d'));
        cards.appendChild(mMetric(m.total_hours + 'h', 'Horas'));
        cards.appendChild(mMetric(m.active_days, 'Dias ativos'));
        cards.appendChild(mMetric(m.energy_drain_ratio == null ? '—' : m.energy_drain_ratio, 'Energia tarde/manhã'));
        cards.appendChild(mMetric('🎤 ' + m.voice_recordings_count, 'Notas de voz'));
        out.appendChild(cards);
        let html = '<table class="dt"><tr><th>Task</th><th>Qtd</th><th>Média (min)</th></tr>';
        m.by_slug.forEach((s) => { html += `<tr><td>${s.task_name || s.slug}</td><td>${s.n}</td><td>${s.avg_min}</td></tr>`; });
        out.appendChild(el('div', null, html + '</table>'));
      };
    },
    tasks: async (c) => {
      const cmp = await api('/api/adminpanel/metrics/targets-comparison');
      c.innerHTML = ''; c.appendChild(el('h2', null, '📋 Tasks (target vs real 30d)'));
      let html = '<table class="dt"><tr><th>Slug</th><th>Target</th><th>Real médio</th><th>Δ%</th><th>N</th></tr>';
      cmp.targets.forEach((t) => { const d = t.delta_pct; const col = d == null ? '' : d > 20 ? 'style="color:#b3261e"' : d < -10 ? 'style="color:#0e7a4e"' : ''; html += `<tr><td>${t.slug}</td><td>${t.target_minutes}</td><td>${t.actual_avg ?? '—'}</td><td ${col}>${d == null ? '—' : (d > 0 ? '+' : '') + d + '%'}</td><td>${t.n}</td></tr>`; });
      c.appendChild(el('div', null, html + '</table>'));
    },
    targets: async (c) => {
      const cmp = await api('/api/adminpanel/metrics/targets-comparison');
      c.innerHTML = ''; c.appendChild(el('div', 'sub', 'Aplica um novo target (minutos) por slug. Registrado no audit.'));
      cmp.targets.forEach((t) => {
        const row = el('div', 'card'); row.appendChild(el('div', 'row', `<span class="title">${t.slug}</span><span class="sub">atual ${t.target_minutes}min · real ${t.actual_avg ?? '—'}</span>`));
        const inp = el('input'); inp.type = 'number'; inp.min = '1'; inp.placeholder = String(t.target_minutes); inp.style.width = '90px';
        const b = el('button', 'btn-sm', 'Aplicar');
        b.onclick = async () => { const v = parseInt(inp.value, 10); if (!(v > 0)) { toast('minutos > 0'); return; } try { await api(`/api/adminpanel/metrics/targets/${t.slug}`, { method: 'POST', body: { custom_minutes: v, method_applied: 'manual' } }); toast('✅ target salvo'); loadMetrics('targets'); } catch (e) { toast('❌ ' + e.message); } };
        const act = el('div', 'actions'); act.appendChild(inp); act.appendChild(b); row.appendChild(act); c.appendChild(row);
      });
    },
    tendencias: async (c) => {
      const t = await api('/api/adminpanel/metrics/trends?range=30d');
      c.innerHTML = ''; c.appendChild(el('div', 'chart-box', '<canvas id="m-trend"></canvas>'));
      c.appendChild(el('div', 'chart-box', '<canvas id="m-bottles"></canvas>'));
      mDrawChart('m-trend', { type: 'line', data: { labels: t.productivity_daily.map((d) => String(d.day).slice(5)), datasets: [{ label: 'Horas/dia', data: t.productivity_daily.map((d) => Number(d.hours)), borderColor: '#2c505f', tension: .3 }] }, options: { plugins: { title: { display: true, text: '📈 Horas trabalhadas/dia (30d)' } } } });
      mDrawChart('m-bottles', { type: 'bar', data: { labels: t.bottles_daily.map((d) => String(d.day).slice(5)), datasets: [{ label: 'Bottles/dia', data: t.bottles_daily.map((d) => d.bottles), backgroundColor: '#0e7a4e' }] }, options: { plugins: { title: { display: true, text: '🍶 Bottles/dia (30d)' } } } });
    },
    anomalias: async (c) => {
      const a = await api('/api/adminpanel/metrics/anomalies');
      c.innerHTML = ''; const cards = el('div', 'metric-cards');
      cards.appendChild(mMetric(a.forgotten_pending, 'Forgotten pendentes'));
      cards.appendChild(mMetric(a.idle_operators.length, 'Ociosos +2h'));
      cards.appendChild(mMetric(a.stale_events.length, 'Tasks presas +3h'));
      c.appendChild(cards);
      if (a.idle_operators.length) { c.appendChild(el('h2', null, '💤 Ociosos')); a.idle_operators.forEach((o) => c.appendChild(el('div', 'card', `<div class="sub">${o.display_name} · ${o.idle_min}min</div>`))); }
      if (a.stale_events.length) { c.appendChild(el('h2', null, '⏰ Tasks presas')); a.stale_events.forEach((s) => c.appendChild(el('div', 'card', `<div class="sub">ev${s.id} · ${s.display_name} · ${s.hours_open}h</div>`))); }
    },
    rankings: async (c) => {
      const r = await api('/api/adminpanel/metrics/rankings?period=month');
      c.innerHTML = ''; c.appendChild(el('div', 'sub', '⚠️ Visível só pra admin. Não mostre aos operadores.'));
      const medal = (i) => ['🥇', '🥈', '🥉'][i] || '·';
      const block = (title, rows, fmt) => { c.appendChild(el('h2', null, title)); rows.forEach((x, i) => c.appendChild(el('div', 'card', `<div class="sub">${medal(i)} ${fmt(x)}</div>`))); };
      block('📦 Volume (events)', r.volume_leaders, (x) => `${x.person_name} — ${x.events}`);
      block('⏱️ Horas', r.hours_leaders, (x) => `${x.person_name} — ${x.hours}h`);
      block('🤝 Mais ajudou (cowork)', r.most_helpful_cowork, (x) => `${x.person_name} — ${x.helped}`);
    },
    insights: async (c) => {
      const r = await api('/api/adminpanel/metrics/insights');
      c.innerHTML = ''; if (!r.insights.length) { c.appendChild(el('div', 'sub', 'Sem insights ainda.')); return; }
      r.insights.forEach((i) => c.appendChild(el('div', 'card', `<div class="row"><span class="pill warn">${i.category}</span></div><div class="sub">${i.text}</div>`)));
    },
    finance: async (c) => {
      c.innerHTML = '';
      c.appendChild(el('div', 'err', '💰 Salário inserido aqui NÃO é salvo. Saindo da tela, os dados somem. Só o fato do acesso é auditado.'));
      if (!ops.length) { try { ops = (await api('/api/adminpanel/operators')).operators; } catch (_) {} }
      const sel = el('select'); sel.appendChild(el('option', null, '— operador —'));
      ops.forEach((o) => { const op = document.createElement('option'); op.value = o.id; op.textContent = o.display_name; sel.appendChild(op); });
      const sal = el('input'); sal.type = 'number'; sal.min = '0'; sal.step = '0.5'; sal.placeholder = 'salário/hora';
      const rng = el('select'); ['30d', '7d', '90d'].forEach((x) => { const o = document.createElement('option'); o.value = x; o.textContent = x; rng.appendChild(o); });
      const go = el('button', 'btn-primary', 'Calcular'); const out = el('div');
      go.onclick = async () => {
        if (!sel.value || !(Number(sal.value) > 0)) { toast('escolha operador e salário/hora'); return; }
        try {
          const m = await api('/api/adminpanel/metrics/financial/calculate', { method: 'POST', body: { person_id: parseInt(sel.value, 10), hourly_salary: Number(sal.value), range_days: parseInt(rng.value, 10) } });
          out.innerHTML = ''; const cards = el('div', 'metric-cards');
          cards.appendChild(mMetric(m.hours_worked + 'h', 'Horas'));
          cards.appendChild(mMetric(m.total_cost, 'Custo total'));
          cards.appendChild(mMetric(m.cost_per_bottle ?? '—', 'Custo/bottle'));
          cards.appendChild(mMetric(m.cost_per_task ?? '—', 'Custo/task'));
          cards.appendChild(mMetric((m.productive_pct ?? '—') + '%', 'Tempo produtivo'));
          out.appendChild(cards);
        } catch (e) { toast('❌ ' + e.message); }
      };
      const form = el('div', 'actions'); form.appendChild(sel); form.appendChild(sal); form.appendChild(rng); form.appendChild(go);
      c.appendChild(form); c.appendChild(out);
    },
  };

  // ── gerenciar admins (RBAC, owner-only) ─────────────────────
  async function loadAdmins() {
    let r;
    try { r = await api('/api/adminpanel/admins'); } catch (e) { toast('❌ ' + e.message); return; }
    const box = $('admins-list'); box.innerHTML = '';
    box.appendChild(el('div', 'sub', '👑 Owner = acesso total (finance, gerenciar admins). 🛡️ Manager = operacional, sem finance.'));
    r.admins.forEach((a) => {
      const isMe = r.me && r.me.id === a.id;
      const badge = a.role === 'owner' ? '<span class="pill on">👑 owner</span>' : '<span class="pill warn">🛡️ manager</span>';
      const status = a.is_active ? '' : ' <span class="pill off">🔴 inativo</span>';
      const c = el('div', 'card');
      c.appendChild(el('div', 'row', `<span class="title">${a.name}${isMe ? ' (você)' : ''}</span>${badge}${status}`));
      c.appendChild(el('div', 'sub', `Último login: ${a.last_login_edt || 'nunca'} · Sessões ativas: ${a.active_session_count}`));
      const act = el('div', 'actions');
      // mudar PIN
      const bPin = el('button', null, '🔑 Mudar PIN');
      bPin.onclick = async () => {
        const pin = window.prompt(`Novo PIN de ${a.name} (4-8 dígitos):`, '');
        if (pin == null) return;
        if (!/^\d{4,8}$/.test(pin)) { toast('PIN: 4-8 dígitos'); return; }
        try { await api(`/api/adminpanel/admins/${a.id}/pin`, { method: 'POST', body: { pin } }); toast('✅ PIN atualizado'); }
        catch (e) { toast('❌ ' + ({ pin_taken: 'PIN já usado', bad_pin_format: 'PIN inválido' }[e.message] || e.message)); }
      };
      act.appendChild(bPin);
      // mudar role (não pra si mesmo)
      if (!isMe) {
        const bRole = el('button', null, a.role === 'owner' ? '⬇️ Tornar manager' : '⬆️ Tornar owner');
        bRole.onclick = async () => {
          const role = a.role === 'owner' ? 'manager' : 'owner';
          if (!window.confirm(`Mudar ${a.name} para ${role}?`)) return;
          try { await api(`/api/adminpanel/admins/${a.id}/role`, { method: 'PUT', body: { role } }); toast('✅ role alterada'); loadAdmins(); }
          catch (e) { toast('❌ ' + ({ last_owner: 'Não dá: é o único owner ativo' }[e.message] || e.message)); }
        };
        act.appendChild(bRole);
        // ativar/desativar (não pra si mesmo)
        const bAct = el('button', a.is_active ? 'no' : 'ok', a.is_active ? '🔴 Desativar' : '🟢 Reativar');
        bAct.onclick = async () => {
          if (a.is_active && !window.confirm(`Desativar ${a.name}? Derruba as sessões dele.`)) return;
          try { await api(`/api/adminpanel/admins/${a.id}/active`, { method: 'PUT', body: { active: !a.is_active } }); toast('✅ feito'); loadAdmins(); }
          catch (e) { toast('❌ ' + ({ last_owner: 'Não dá: é o único owner ativo' }[e.message] || e.message)); }
        };
        act.appendChild(bAct);
      }
      c.appendChild(act);
      box.appendChild(c);
    });
  }

  // ── voices (Fase 0.7 — aba dedicada 🎤) ─────────────────────
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function voiceCard(rec) {
    const c = el('div', 'card');
    c.appendChild(el('div', 'row',
      `<span class="title">🎤 ${escapeHtml(rec.person)}${rec.event_id ? ' · ev' + rec.event_id : ''}</span>` +
      `<span class="sub">${rec.created_edt} · ${rec.audio_duration_seconds || '?'}s · ${rec.transcript_language || ''}</span>`));
    const au = document.createElement('audio'); au.controls = true; au.preload = 'none';
    au.src = '/api/adminpanel/voice/' + rec.id; au.style.width = '100%';
    c.appendChild(au);
    if (rec.transcript) c.appendChild(el('div', 'sub', '“' + escapeHtml(rec.transcript) + '”'));
    const act = el('div', 'actions');
    const dl = el('button', 'btn-sm', '📥 Baixar');
    dl.onclick = () => { const a = document.createElement('a'); a.href = '/api/adminpanel/voice/' + rec.id; a.download = 'voz-' + rec.id + '.webm'; a.click(); };
    const rm = el('button', 'no', '🗑️ Apagar');
    rm.onclick = async () => {
      if (!window.confirm('Apagar essa gravação? (soft-delete; transcrição fica no histórico)')) return;
      try { await api('/api/adminpanel/voice/' + rec.id, { method: 'DELETE' }); toast('🗑️ apagada'); loadVoices(); }
      catch (e) { toast('❌ ' + e.message); }
    };
    act.appendChild(dl); act.appendChild(rm); c.appendChild(act);
    return c;
  }
  async function loadVoices() {
    // popula dropdown de operadores (1x)
    const sel = $('v-person');
    if (sel.options.length <= 1) {
      try {
        if (!ops.length) { const r = await api('/api/adminpanel/operators'); ops = r.operators; }
        ops.forEach((o) => { const opt = document.createElement('option'); opt.value = o.id; opt.textContent = o.display_name; sel.appendChild(opt); });
      } catch (_) {}
    }
    const qs = new URLSearchParams({ limit: '50' });
    if (sel.value) qs.set('person_id', sel.value);
    if ($('v-from').value) qs.set('date_from', $('v-from').value);
    if ($('v-to').value) qs.set('date_to', $('v-to').value);
    let r;
    try { r = await api('/api/adminpanel/voice?' + qs.toString()); } catch (e) { toast('❌ ' + e.message); return; }
    const box = $('voices-list'); box.innerHTML = '';
    if (!r.voice.length) { box.appendChild(el('div', 'sub', 'Nenhuma gravação de voz.')); return; }
    r.voice.forEach((rec) => box.appendChild(voiceCard(rec)));
  }

  // ── criar operador (Fase E) ─────────────────────────────────
  function openCreate() {
    show('op-edit');
    const box = $('op-edit'); box.innerHTML = '';
    box.appendChild(el('h1', null, '➕ Novo operador'));
    const fields = {};
    const addField = (label, input) => { const f = el('div', 'field'); f.appendChild(el('label', null, label)); f.appendChild(input); box.appendChild(f); return input; };
    fields.name = addField('Nome', Object.assign(el('input'), { type: 'text', placeholder: 'ex: João Silva' }));
    fields.pin = addField('PIN (4 dígitos)', Object.assign(el('input'), { type: 'tel', maxLength: 4, placeholder: '••••' }));
    fields.logoff = addField('Auto-logoff (segundos, vazio = desligado)', Object.assign(el('input'), { type: 'number', min: 5, max: 3600, value: 30 }));
    const fEx = el('div', 'field'); const cEx = el('input'); cEx.type = 'checkbox';
    const lEx = el('label', 'chk'); lEx.appendChild(cEx); lEx.appendChild(el('span', null, 'Pode pular contagem de bottles'));
    fEx.appendChild(lEx); box.appendChild(fEx);
    const go = el('button', 'btn-big btn-primary', 'Criar');
    go.onclick = async () => {
      if (!fields.name.value.trim()) { toast('Nome obrigatório'); return; }
      if (!/^\d{4}$/.test(fields.pin.value)) { toast('PIN precisa de 4 dígitos'); return; }
      try {
        await api('/api/adminpanel/operators', { method: 'POST', body: {
          display_name: fields.name.value.trim(), pin: fields.pin.value,
          auto_logoff_seconds: fields.logoff.value === '' ? null : parseInt(fields.logoff.value, 10),
          count_exempt: cEx.checked,
        } });
        toast('✅ Operador criado'); show('ops'); await loadOps();
      } catch (e) {
        const M = { name_taken: 'Nome já existe', pin_taken: 'PIN já usado por outro operador', bad_pin_format: 'PIN inválido' };
        toast('❌ ' + (M[e.message] || e.message));
      }
    };
    box.appendChild(go);
    const back = el('button', 'btn-sm', '← Cancelar'); back.onclick = async () => { show('ops'); await loadOps(); };
    box.appendChild(back);
  }

  // ── audit log (Fase C) ──────────────────────────────────────
  let auditOffset = 0;
  const ACTION_LABEL = {
    'person.pin_changed': (m) => 'Mudou PIN de ' + (m.target_id ? '#' + m.target_id : ''),
    'person.pin_set': () => 'Definiu PIN',
    'event.deleted': (m) => 'Apagou evento ev' + m.target_id,
    'event.closed_via_carolina': (m) => 'Fechou ev' + m.target_id + ' (via Carolina)',
    'carolina_admin_command': (m) => 'Comando Carolina',
    'message_dead_lettered': (m) => 'Mensagem foi pra dead-letter',
    'voice_uploaded': () => '🎤 Voz gravada',
    'voice_deleted': (m) => '🎤 Voz apagada' + (m.target_id ? ' #' + m.target_id : ''),
    'login_bruteforce_ban': (m) => '⚠️ IP bloqueado por brute-force' + (m.ip ? ' (' + m.ip + ')' : ''),
    'dedupe_matched': () => 'Match dedupe Slack↔página',
    'dedupe_orphan_notified': () => 'Slack órfão → notificou admin',
    'operator.auto_logoff_set': (m) => 'Ajustou auto-logoff',
    'operator.active_set': (m) => 'Ativou/desativou operador',
    'operator.force_logout': () => 'Forçou logout',
    'notification_accepted': () => 'Aceitou notificação',
    'notification_rejected': () => 'Ignorou notificação',
    'notification_edited': () => 'Editou via notificação',
    'admin_login_success': () => 'Login admin OK',
    'admin_login_failed': () => 'Login admin falhou',
    'op_login_success': () => 'Operador logou',
    'op_clock_out': () => 'Operador saiu (fim do dia)',
  };
  function actionText(e) {
    const f = ACTION_LABEL[e.action];
    const base = f ? f({ ...e, ...(e.metadata || {}) }) : e.action.replace(/[._]/g, ' ');
    return base;
  }
  function auditQS() {
    const qs = new URLSearchParams();
    if ($('au-actor').value) qs.set('actor_type', $('au-actor').value);
    if ($('au-action').value.trim()) qs.set('action', $('au-action').value.trim());
    if ($('au-q').value.trim()) qs.set('q', $('au-q').value.trim());
    if (isOwner() && $('au-sensitive').checked) qs.set('sensitive_only', '1');
    return qs;
  }
  async function loadAudit(append) {
    if (!append) auditOffset = 0;
    // controles owner-only
    $('au-sens-wrap').style.display = isOwner() ? '' : 'none';
    $('au-export').style.display = isOwner() ? '' : 'none';
    const qs = auditQS();
    qs.set('limit', '50'); qs.set('offset', String(auditOffset));
    let r;
    try { r = await api('/api/adminpanel/audit?' + qs.toString()); } catch (e) { toast('❌ ' + e.message); return; }
    const box = $('audit-list');
    if (!append) box.innerHTML = '';
    if (!r.entries.length && !append) box.appendChild(el('div', 'sub', 'Nenhum registro.'));
    r.entries.forEach((e) => {
      const c = el('div', 'card');
      const who = e.actor_name ? e.actor_name : e.actor_type;
      c.appendChild(el('div', 'row', `<span class="title">${actionText(e)}</span><span class="sub" title="${e.created_at}">${e.created_edt}</span>`));
      c.appendChild(el('div', 'sub', `${who} · ${e.actor_type}${e.target_type ? ' · ' + e.target_type + (e.target_id ? ' #' + e.target_id : '') : ''}`));
      if (e.target_type === 'voice' && e.target_id && e.action !== 'voice_deleted') {
        const au = document.createElement('audio'); au.controls = true; au.preload = 'none';
        au.src = '/api/adminpanel/voice/' + e.target_id; au.style.cssText = 'width:100%;margin-top:6px';
        c.appendChild(au);
      }
      if (e.metadata && Object.keys(e.metadata).length) {
        const det = el('button', 'btn-sm', 'ver detalhes');
        const pre = el('pre', 'sub', ''); pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;display:none;margin-top:8px';
        pre.textContent = JSON.stringify(e.metadata, null, 2);
        det.onclick = () => { pre.style.display = pre.style.display === 'none' ? 'block' : 'none'; };
        c.appendChild(det); c.appendChild(pre);
      }
      box.appendChild(c);
    });
    auditOffset += r.entries.length;
    $('au-more').classList.toggle('hidden', r.entries.length < 50);
  }

  // ── link da página dos operadores (pros admins acharem fácil) ──
  (function initOpLink() {
    const opUrl = window.location.origin + '/op/';
    if ($('op-url')) $('op-url').textContent = opUrl;
    if ($('op-open')) $('op-open').href = opUrl;
    if ($('op-link-hdr')) $('op-link-hdr').href = opUrl;
    const copyBtn = $('op-copy');
    if (copyBtn) copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(opUrl); toast('✅ Link copiado'); }
      catch (_) { window.prompt('Copia o link:', opUrl); }
    };
  }());

  show('login');
}());
