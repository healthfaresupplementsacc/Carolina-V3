'use strict';
/* HEALTHFARE Operator Page — app principal (vanilla JS).
   Identidade real = PIN→sessão. pageToken só habilita a API.
   Estados/transições: state-machine.js. Dados estáticos: fuse-data.js. */
(function () {
  const CFG = window.HF_OP_CONFIG || { pageToken: '' };
  const DATA = window.HF_DATA || { supplements: [], groups: [], recent_batches: [] };
  const SM = window.HFStateMachine;

  let state = SM.INITIAL;
  let draft = SM.emptyDraft();
  let session = null;            // { token, person:{id,display_name,count_exempt}, auto_logoff_seconds }
  let pinBuf = '';
  let myTasks = [];
  let team = [];
  let logoffLeft = null;
  let timers = { hb: null, logoff: null, poll: null };
  let voiceLang = 'pt-BR';

  // ── helpers ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }
  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const h = { Authorization: 'Bearer ' + CFG.pageToken, ...headers };
    if (session) h['X-Session-Token'] = session.token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) { /* vazio */ }
    if (r.status === 401 && session && path.indexOf('/auth/login') < 0) { endSession(); throw new Error('Sessão expirou — entra de novo'); }
    if (!r.ok) { const e = new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  function dispatch(event, payload) {
    const r = SM.transition(state, event, { draft }, payload);
    state = r.state; draft = r.draft; render();
  }

  // ── sessão / timers ──────────────────────────────────────────
  function startTimers() {
    stopTimers();
    timers.hb = setInterval(() => { if (session) api('/api/v3/op/auth/heartbeat', { method: 'POST' }).catch(() => {}); }, 5000);
    timers.poll = setInterval(() => { if (state === 'IDLE') refreshIdle().catch(() => {}); }, 12000);
    if (session && session.auto_logoff_seconds != null) {
      logoffLeft = session.auto_logoff_seconds;
      timers.logoff = setInterval(() => {
        logoffLeft -= 1; renderHeaderTimer();
        if (logoffLeft <= 0) doLogout('auto_timeout');
      }, 1000);
    } else { logoffLeft = null; renderHeaderTimer(); }
  }
  function stopTimers() { Object.keys(timers).forEach((k) => { clearInterval(timers[k]); timers[k] = null; }); }
  function resetLogoff() { if (session && session.auto_logoff_seconds != null) { logoffLeft = session.auto_logoff_seconds; renderHeaderTimer(); } }
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((evt) => document.addEventListener(evt, resetLogoff, { passive: true }));

  function endSession() { session = null; stopTimers(); dispatch('LOGOUT'); }
  async function doLogout(reason) {
    const s = session;
    try { if (s) await api('/api/v3/op/auth/logout', { method: 'POST', body: { reason: reason === 'auto_timeout' ? 'auto_timeout' : 'manual' } }); } catch (_) {}
    endSession();
    if (reason === 'auto_timeout') toast('⏱ Saiu automático (sem atividade)');
  }

  // ── LOGIN ────────────────────────────────────────────────────
  function buildKeypad() {
    const kp = $('keypad'); kp.innerHTML = '';
    ['1','2','3','4','5','6','7','8','9','⌫','0','✓'].forEach((k) => {
      const b = el('button', null, k);
      b.onclick = () => {
        if (k === '⌫') pinBuf = pinBuf.slice(0, -1);
        else if (k === '✓') { if (pinBuf.length === 4) submitPin(); }
        else if (pinBuf.length < 4) pinBuf += k;
        renderPin();
        if (pinBuf.length === 4 && k !== '✓') submitPin();
      };
      kp.appendChild(b);
    });
  }
  function renderPin() {
    $('pin-dots').textContent = (pinBuf.replace(/./g, '●') + '····').slice(0, 4).split('').join(' ');
  }
  async function submitPin() {
    const pin = pinBuf; pinBuf = ''; renderPin();
    try {
      const r = await api('/api/v3/op/auth/login', { method: 'POST', body: { pin } });
      session = { token: r.session_token, person: r.person, auto_logoff_seconds: r.auto_logoff_seconds };
      $('pin-error').textContent = '';
      dispatch('LOGIN_OK');
      startTimers();
      refreshIdle().catch(() => {});
    } catch (e) {
      $('pin-error').textContent = e.status === 429 ? 'Muitas tentativas — espera 1 min' : 'PIN errado';
    }
  }

  // ── IDLE data ────────────────────────────────────────────────
  async function refreshIdle() {
    if (!session) return;
    const [mine, ops] = await Promise.all([
      api('/api/v3/architect/person/' + session.person.id + '/today', { headers: { 'X-Operator-Id': String(session.person.id) } }),
      api('/api/v3/op/active-operators'),
    ]);
    myTasks = (mine.events || []).filter((e) => !e.ended_at);
    team = ops.operators || [];
    if (state === 'IDLE') renderIdle();
  }

  // ── render raiz ──────────────────────────────────────────────
  function render() {
    $('view-login').classList.toggle('hidden', state !== 'LOGGED_OUT');
    $('view-idle').classList.toggle('hidden', state !== 'IDLE');
    $('hdr').classList.toggle('hidden', state === 'LOGGED_OUT');
    const inModal = ['PICK_GROUP', 'PICK_TYPE', 'PICK_SUPPLEMENT', 'PICK_BATCH', 'CONFIRM', 'CLOCK_OUT'].includes(state);
    $('modal').classList.toggle('hidden', !inModal);
    if (session) $('hdr-user').textContent = '👤 ' + session.person.display_name;
    renderHeaderTimer();
    if (state === 'IDLE') renderIdle();
    if (state === 'PICK_GROUP') renderPickGroup();
    if (state === 'PICK_TYPE') renderPickType();
    if (state === 'PICK_SUPPLEMENT') renderPickSupplement();
    if (state === 'PICK_BATCH') renderPickBatch();
    if (state === 'CONFIRM') renderConfirm();
    // CLOCK_OUT renderiza no fluxo próprio (openClockOut)
  }
  function renderHeaderTimer() {
    $('hdr-timer').textContent = (session && logoffLeft != null) ? ('logoff em ' + logoffLeft + 's') : '';
  }

  function fmtDur(startIso) {
    const m = Math.max(0, Math.floor((Date.now() - Date.parse(startIso)) / 60000));
    return m >= 60 ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : m + 'min';
  }

  function renderIdle() {
    const my = $('my-tasks'); my.innerHTML = '';
    if (!myTasks.length) my.appendChild(el('div', 'muted', 'Nenhuma tarefa aberta.'));
    myTasks.forEach((t) => {
      const c = el('div', 'card mine');
      const g = el('div', 'grow');
      g.appendChild(el('div', 'title', labelOf(t.slug)));
      g.appendChild(el('div', 'sub', (t.batch_number ? t.batch_number + ' · ' : '') + 'há ' + fmtDur(t.started_at)));
      c.appendChild(g);
      const b = el('button', 'btn-danger', '✔ Finalizar');
      b.onclick = () => finishTask(t);
      c.appendChild(b);
      my.appendChild(c);
    });
    const tt = $('team-tasks'); tt.innerHTML = '';
    const others = team.filter((o) => o.id !== session.person.id && o.current_event_id);
    if (!others.length) tt.appendChild(el('div', 'muted', 'Ninguém com tarefa aberta agora.'));
    others.forEach((o) => {
      const c = el('div', 'card');
      const g = el('div', 'grow');
      g.appendChild(el('div', 'title', o.display_name + (o.online ? ' 🟢' : '')));
      g.appendChild(el('div', 'sub', labelOf(o.current_slug) + (o.current_batch ? ' · ' + o.current_batch : '') + ' · há ' + fmtDur(o.current_started_at)));
      c.appendChild(g);
      const inCw = Array.isArray(o.current_cowork) && o.current_cowork.includes(session.person.id);
      const b = el('button', inCw ? 'btn-sm' : 'btn-primary', inCw ? 'Já junto' : '🤝 Entrar');
      if (!inCw) b.onclick = () => joinTask(o);
      c.appendChild(b);
      tt.appendChild(c);
    });
  }
  function labelOf(slug) {
    for (const grp of DATA.groups || []) {
      const t = (grp.types || []).find((x) => x.slug === slug);
      if (t) return grp.icon + ' ' + t.label;
    }
    return slug || '—';
  }

  // ── modal helpers ───────────────────────────────────────────
  function modal(title, bodyEl, footButtons) {
    $('modal-title').textContent = title;
    const mb = $('modal-body'); mb.innerHTML = ''; mb.appendChild(bodyEl);
    const mf = $('modal-foot'); mf.innerHTML = '';
    (footButtons || []).forEach((b) => mf.appendChild(b));
  }
  const backBtn = () => { const b = el('button', 'btn-sm', '← Voltar'); b.onclick = () => dispatch('BACK'); return b; };
  const cancelBtn = () => { const b = el('button', 'btn-sm', '✕ Cancelar'); b.onclick = () => dispatch('CANCEL'); return b; };

  // ── fluxo start ─────────────────────────────────────────────
  function renderPickGroup() {
    const grid = el('div', 'grid2');
    (DATA.groups || []).forEach((g) => {
      const b = el('button', 'btn-big', g.icon + '<br>' + g.label);
      b.onclick = () => dispatch('PICK_GROUP', g);
      grid.appendChild(b);
    });
    modal('O que vai fazer?', grid, [cancelBtn()]);
  }
  function renderPickType() {
    const grid = el('div', 'grid2');
    ((draft.group && draft.group.types) || []).forEach((t) => {
      const b = el('button', 'btn-big', t.label);
      b.onclick = () => dispatch('PICK_TYPE', t);
      grid.appendChild(b);
    });
    modal((draft.group ? draft.group.icon + ' ' + draft.group.label : ''), grid, [backBtn(), cancelBtn()]);
  }
  function renderPickSupplement() {
    const box = el('div');
    const inp = el('input'); inp.type = 'text'; inp.placeholder = 'Nome do suplemento…'; inp.autocomplete = 'off';
    const list = el('div', 'list-pick');
    const draw = () => {
      list.innerHTML = '';
      SM.searchSupplements(DATA.supplements, inp.value).forEach((p) => {
        const b = el('button', null, p.canonical_name);
        b.onclick = () => dispatch('PICK_SUPPLEMENT', p);
        list.appendChild(b);
      });
    };
    inp.oninput = draw;
    box.appendChild(inp); box.appendChild(list); draw();
    modal('Qual suplemento?', box, [backBtn(), cancelBtn()]);
    setTimeout(() => inp.focus(), 50);
  }
  function renderPickBatch() {
    const box = el('div');
    const inp = el('input'); inp.type = 'tel'; inp.placeholder = 'Lote — 4 números (ex: 0190)'; inp.maxLength = 12;
    box.appendChild(inp);
    const recents = (DATA.recent_batches || []).filter((b) => !draft.supplement || b.product_id === draft.supplement.id).slice(0, 6);
    if (recents.length) {
      box.appendChild(el('h2', null, 'Recentes:'));
      const list = el('div', 'list-pick');
      recents.forEach((b) => {
        const bt = el('button', null, b.batch_number);
        bt.onclick = () => dispatch('PICK_BATCH', { batch_number: b.batch_number });
        list.appendChild(bt);
      });
      box.appendChild(list);
    }
    const ok = el('button', 'btn-primary', 'OK');
    ok.onclick = () => { if (inp.value.trim()) dispatch('PICK_BATCH', { batch_number: inp.value.trim() }); };
    const skip = el('button', 'btn-sm', 'Sem lote');
    skip.onclick = () => dispatch('SKIP_BATCH');
    modal('Qual lote?', box, [backBtn(), skip, ok]);
    setTimeout(() => inp.focus(), 50);
  }

  // voice note row (Web Speech API; pt-BR default, es-ES / en-US fallback manual)
  function voiceRow(textarea) {
    const row = el('div', 'voice-row');
    const mic = el('button', 'mic', '🎤');
    const lang = el('select', 'voice-lang');
    [['pt-BR', 'Português'], ['es-ES', 'Español'], ['en-US', 'English']].forEach(([v, l]) => {
      const o = el('option', null, l); o.value = v; lang.appendChild(o);
    });
    lang.value = voiceLang;
    lang.onchange = () => { voiceLang = lang.value; };
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    // Sem suporte (Firefox/Brave/iOS antigo): botão CLICÁVEL com explicação —
    // disabled silencioso parece "quebrado" (bug reportado 12/jun).
    const VOICE_ERR = {
      'not-allowed': '🎤 Permissão negada — toca no cadeado 🔒 da barra e libera o Microfone',
      'service-not-allowed': '🎤 Voz bloqueada pelo navegador — libera o microfone nas configurações',
      'audio-capture': '🎤 Nenhum microfone encontrado neste aparelho',
      network: '🎤 Sem conexão com o serviço de voz — verifica a internet',
      'no-speech': '🎤 Não ouvi nada — tenta de novo falando mais perto',
      aborted: null, // stop manual, sem aviso
    };
    let rec = null;
    mic.onclick = () => {
      if (!SR) { toast('🎤 Este navegador não tem voz — usa o Chrome ou Edge (ou digita)'); return; }
      if (rec) { rec.stop(); return; }
      try {
        rec = new SR();
        rec.lang = voiceLang; rec.continuous = true; rec.interimResults = true;
        const baseText = textarea.value;
        rec.onresult = (ev) => {
          let txt = '';
          for (const res of ev.results) txt += res[0].transcript;
          textarea.value = (baseText ? baseText + ' ' : '') + txt;
        };
        rec.onend = () => { mic.classList.remove('rec'); rec = null; };
        rec.onerror = (ev) => {
          mic.classList.remove('rec'); rec = null;
          const msg = Object.prototype.hasOwnProperty.call(VOICE_ERR, ev.error)
            ? VOICE_ERR[ev.error]
            : ('🎤 erro: ' + (ev.error || 'desconhecido') + ' — tenta de novo ou digita');
          if (msg) toast(msg, 4500);
        };
        mic.classList.add('rec');
        rec.start();
      } catch (e) {
        mic.classList.remove('rec'); rec = null;
        toast('🎤 não consegui iniciar (' + e.name + ') — tenta de novo ou digita', 4000);
      }
    };
    row.appendChild(mic); row.appendChild(lang);
    return row;
  }

  function renderConfirm() {
    const box = el('div');
    const lines = [
      labelOf(draft.type && draft.type.slug),
      draft.supplement ? '📦 ' + draft.supplement.canonical_name : null,
      draft.batch ? '🔢 Lote ' + draft.batch.batch_number : null,
    ].filter(Boolean);
    box.appendChild(el('div', 'card mine', '<div class="grow"><div class="title">' + lines.join('</div><div class="sub">') + '</div></div>'));
    // cowork A
    box.appendChild(el('h2', null, '👥 Tem alguém junto?'));
    const cwBox = el('div');
    team.filter((o) => o.id !== session.person.id).forEach((o) => {
      const l = el('label', 'chk');
      const c = el('input'); c.type = 'checkbox'; c.value = o.id;
      c.checked = draft.cowork.includes(o.id);
      c.onchange = () => {
        draft.cowork = c.checked ? [...draft.cowork, o.id] : draft.cowork.filter((x) => x !== o.id);
      };
      l.appendChild(c);
      l.appendChild(el('span', null, o.display_name + (o.online ? ' 🟢' : ' ⚪') + (o.current_slug ? ' (em ' + labelOf(o.current_slug) + ')' : '')));
      cwBox.appendChild(l);
    });
    box.appendChild(cwBox);
    // nota + voz
    box.appendChild(el('h2', null, '📝 Nota (opcional)'));
    const ta = el('textarea'); ta.placeholder = 'Escreve ou usa o microfone…';
    ta.value = draft.note || '';
    ta.oninput = () => { draft.note = ta.value; };
    box.appendChild(ta);
    box.appendChild(voiceRow(ta));

    const go = el('button', 'btn-primary', '▶ COMEÇAR');
    go.onclick = async () => {
      go.disabled = true;
      try {
        await api('/api/v3/op/event/start', { method: 'POST', body: {
          activity_slug: draft.type.slug,
          batch_number: draft.batch ? draft.batch.batch_number : null,
          cowork_with: draft.cowork,
          note: ta.value.trim() || null,
        } });
        toast('✅ Tarefa iniciada!');
        dispatch('CONFIRM_OK');
        refreshIdle().catch(() => {});
      } catch (e) { go.disabled = false; toast('❌ ' + e.message); }
    };
    modal('Confirma?', box, [backBtn(), cancelBtn(), go]);
  }

  // ── finalizar / join / nota ─────────────────────────────────
  function finishTask(t) {
    const needsCount = ['production_line', 'encapsulation'].includes(t.slug);
    const box = el('div');
    let inp = null;
    if (needsCount) {
      box.appendChild(el('div', null, 'Quantos bottles saíram? (pode deixar vazio)'));
      inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.placeholder = 'ex: 746';
      box.appendChild(inp);
    }
    const ta = el('textarea'); ta.placeholder = 'Nota final (opcional)';
    box.appendChild(ta); box.appendChild(voiceRow(ta));
    const ok = el('button', 'btn-danger', '✔ Finalizar');
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api('/api/v3/op/event/' + t.id + '/end', { method: 'POST', body: {
          bottles: inp && inp.value ? parseInt(inp.value, 10) : null,
          note: ta.value.trim() || null,
        } });
        toast('✅ Finalizada!');
        $('modal').classList.add('hidden');
        refreshIdle().catch(() => {});
      } catch (e) { ok.disabled = false; toast('❌ ' + e.message); }
    };
    const close = el('button', 'btn-sm', '✕');
    close.onclick = () => $('modal').classList.add('hidden');
    modal('Finalizar: ' + labelOf(t.slug), box, [close, ok]);
    $('modal').classList.remove('hidden');
  }

  function joinTask(o) {
    const box = el('div', null, 'Você quer entrar na tarefa de <b>' + o.display_name + '</b>?<br><span class="muted">' + labelOf(o.current_slug) + (o.current_batch ? ' · ' + o.current_batch : '') + '</span>');
    const ok = el('button', 'btn-primary', '🤝 Entrar');
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        await api('/api/v3/op/event/' + o.current_event_id + '/join', { method: 'POST', body: {} });
        toast('✅ Você entrou!');
        $('modal').classList.add('hidden');
        refreshIdle().catch(() => {});
      } catch (e) { ok.disabled = false; toast('❌ ' + e.message); }
    };
    const close = el('button', 'btn-sm', '✕');
    close.onclick = () => $('modal').classList.add('hidden');
    modal('Entrar junto?', box, [close, ok]);
    $('modal').classList.remove('hidden');
  }

  function openNote() {
    const box = el('div');
    const ta = el('textarea'); ta.placeholder = 'Fala ou escreve a nota…';
    box.appendChild(ta); box.appendChild(voiceRow(ta));
    const ok = el('button', 'btn-primary', '💾 Salvar');
    ok.onclick = async () => {
      if (!ta.value.trim()) return;
      ok.disabled = true;
      try {
        await api('/api/v3/op/note', { method: 'POST', body: { text: ta.value.trim() } });
        toast('✅ Nota salva');
        $('modal').classList.add('hidden');
      } catch (e) { ok.disabled = false; toast('❌ ' + e.message); }
    };
    const close = el('button', 'btn-sm', '✕');
    close.onclick = () => $('modal').classList.add('hidden');
    modal('📝 Nota', box, [close, ok]);
    $('modal').classList.remove('hidden');
  }

  // ── clock-out (P5) ──────────────────────────────────────────
  async function openClockOut() {
    let info;
    try { info = await api('/api/v3/op/missing-bottle-counts'); }
    catch (e) { toast('❌ ' + e.message); return; }
    dispatch('OPEN_CLOCK_OUT');
    renderClockOut(info);
  }
  function renderClockOut(info) {
    const box = el('div');
    const rows = [];
    if (!info.missing.length) {
      box.appendChild(el('div', null, '✅ Todas as produções de hoje têm contagem.<br>Pode sair tranquilo.'));
    } else {
      box.appendChild(el('div', null, '📊 Antes de sair — produções de hoje <b>sem contagem</b>:'));
      info.missing.forEach((m) => {
        const r = el('div', 'missing-row');
        r.appendChild(el('div', 'title', (m.product || '?') + ' ' + (m.batch_number || '') + ' <span class="muted">(' + m.display_name + ', terminou ' + m.finalized_at_edt + ')</span>'));
        const inp = el('input'); inp.type = 'number'; inp.min = '0'; inp.placeholder = 'Quantos bottles?';
        const l = el('label', 'chk');
        const c = el('input'); c.type = 'checkbox';
        l.appendChild(c); l.appendChild(el('span', null, '🤷 Não sei'));
        c.onchange = () => { inp.disabled = c.checked; if (c.checked) inp.value = ''; };
        r.appendChild(inp); r.appendChild(l);
        rows.push({ m, inp, chk: c });
        box.appendChild(r);
      });
      if (info.is_last_operator && !info.can_skip) {
        box.appendChild(el('div', 'muted', '⚠️ Você é o último a sair: preenche os números ou marca "Não sei".'));
      }
    }
    const out = el('button', 'btn-warn', '🚪 Confirmar e sair');
    out.onclick = async () => {
      const counts = []; const unknown = [];
      let incomplete = false;
      rows.forEach(({ m, inp, chk }) => {
        if (chk.checked) unknown.push(m.event_id);
        else if (inp.value !== '' && parseInt(inp.value, 10) >= 0) counts.push({ event_id: m.event_id, bottles: parseInt(inp.value, 10) });
        else incomplete = true;
      });
      if (incomplete && info.is_last_operator && !info.can_skip) { toast('Preenche tudo ou marca "Não sei"'); return; }
      out.disabled = true;
      try {
        await api('/api/v3/op/clock-out', { method: 'POST', body: { counts, unknown_event_ids: unknown } });
        session = null; stopTimers();
        dispatch('CLOCK_OUT_DONE');
        toast('👋 Até amanhã!');
      } catch (e) {
        out.disabled = false;
        if (e.status === 422 && e.body && e.body.missing) { renderClockOut({ ...e.body, is_last_operator: true, can_skip: false, missing: e.body.missing }); }
        else toast('❌ ' + e.message);
      }
    };
    const foot = [backBtn(), out];
    if (info.can_skip && info.missing.length) {
      const skip = el('button', 'btn-sm', 'Pular e sair');
      skip.onclick = async () => {
        skip.disabled = true;
        try {
          await api('/api/v3/op/clock-out', { method: 'POST', body: { counts: [], unknown_event_ids: [] } });
          session = null; stopTimers();
          dispatch('CLOCK_OUT_DONE');
          toast('👋 Até amanhã!');
        } catch (e) { skip.disabled = false; toast('❌ ' + e.message); }
      };
      foot.splice(1, 0, skip);
    }
    modal('🚪 Fim do dia', box, foot);
  }

  // ── bindings ────────────────────────────────────────────────
  $('btn-new').onclick = () => dispatch('START_NEW');
  $('btn-note').onclick = openNote;
  $('btn-clockout').onclick = openClockOut;
  $('btn-switch').onclick = () => doLogout('manual');

  buildKeypad(); renderPin(); render();
}());
