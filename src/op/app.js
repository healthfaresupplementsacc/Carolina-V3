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
  // Fase F — POST de event/note pode ser enfileirado offline (fluxo online intocado).
  const Q = window.HFOfflineQueue;
  const queueable = (path) => /\/api\/v3\/op\/(event|note)/.test(path);
  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const h = { Authorization: 'Bearer ' + CFG.pageToken, ...headers };
    if (session) h['X-Session-Token'] = session.token;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    // offline + enfileirável → guarda e segue (sincroniza quando voltar)
    if (Q && method === 'POST' && queueable(path) && typeof navigator !== 'undefined' && navigator.onLine === false) {
      Q.enqueue({ path, body, sessionToken: session && session.token });
      updateConn();
      return { queued: true };
    }
    let r;
    try {
      r = await fetch(path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (netErr) {
      if (Q && method === 'POST' && queueable(path)) { Q.enqueue({ path, body, sessionToken: session && session.token }); updateConn(); return { queued: true }; }
      throw netErr;
    }
    let j = null; try { j = await r.json(); } catch (_) { /* vazio */ }
    if (r.status === 401 && session && path.indexOf('/auth/login') < 0) { endSession(); throw new Error('Sessão expirou — entra de novo'); }
    if (!r.ok) { const e = new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  // ── conectividade + sync (Fase F) ───────────────────────────
  function updateConn() {
    const ind = $('conn'); if (!ind) return;
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const pending = Q ? Q.size() : 0;
    ind.textContent = online ? (pending ? '🟢 ' + pending + ' p/ sincronizar' : '🟢') : ('🔴 offline' + (pending ? ' (' + pending + ')' : ''));
  }
  async function syncQueue() {
    if (!Q || !Q.size()) { updateConn(); return; }
    const res = await Q.flush(async (path, { body, sessionToken }) => {
      const r = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + CFG.pageToken, 'X-Session-Token': sessionToken || '', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok && r.status !== 409) throw new Error('retry'); // 409 (já fechado) conta como entregue
    });
    if (res.sent) toast('✅ ' + res.sent + ' registro(s) sincronizado(s)');
    updateConn();
    if (state === 'IDLE') refreshIdle().catch(() => {});
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { updateConn(); syncQueue(); });
    window.addEventListener('offline', updateConn);
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
      // Fase 4 — colegas que passaram do horário e seguem logados
      if (r.forgotten_check_prompts && r.forgotten_check_prompts.length) {
        showForgottenPrompts(r.forgotten_check_prompts.slice(), 'login');
      }
    } catch (e) {
      $('pin-error').textContent = e.status === 429 ? 'Muitas tentativas — espera 1 min' : 'PIN errado';
    }
  }

  // ── Fase 4: pergunta sobre colegas que talvez esqueceram o checkout ──
  function showForgottenPrompts(queue, via) {
    if (!queue.length) return;
    const p = queue.shift();
    const ov = el('div', 'fc-overlay');
    const card = el('div', 'fc-card');
    card.appendChild(el('div', 'fc-q', p.prompt_text));
    const meta = [p.last_activity_at ? 'última atividade ' + p.last_activity_at : null, p.expected_end_time ? 'saída prevista ' + p.expected_end_time : null].filter(Boolean).join(' · ');
    if (meta) card.appendChild(el('div', 'fc-meta', meta));
    const resolve = async (stillWorking) => {
      try { await api('/api/v3/op/forgotten-checkout/resolve', { method: 'POST', body: { person_id: p.person_id, still_working: stillWorking, discovered_via: via } }); }
      catch (e) { toast('❌ ' + e.message); }
      ov.remove();
      showForgottenPrompts(queue, via); // próximo
    };
    const yes = el('button', 'btn-big btn-primary', '✅ Sim, ainda está trabalhando');
    yes.onclick = () => resolve(true);
    const no = el('button', 'btn-big', '❌ Não, fazer checkout dela');
    no.onclick = () => { if (window.confirm(`Tem certeza? ${p.person_name} será deslogada automaticamente.`)) resolve(false); };
    card.appendChild(yes); card.appendChild(no);
    ov.appendChild(card);
    document.body.appendChild(ov);
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
    for (const q of DATA.quick || []) {
      if (q.slug === slug) return q.icon + ' ' + q.label;
    }
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
    // quick actions (ex.: Almoço) — pulam a escolha de grupo
    (DATA.quick || []).forEach((q) => {
      const b = el('button', 'btn-big btn-primary', q.icon + '<br>' + q.label);
      b.onclick = () => {
        dispatch('PICK_GROUP', { key: 'quick', icon: q.icon, label: q.label, types: [q] });
        dispatch('PICK_TYPE', q);
      };
      grid.appendChild(b);
    });
    modal('O que vai fazer?', grid, [cancelBtn()]);
  }
  // ── time picker inline (Bruno's design) — hora 1-12 / min / AM-PM ──
  function todayIso(h12, min, ampm) {
    let h = h12 % 12; if (ampm === 'PM') h += 12;
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), h, min, 0, 0).toISOString();
  }
  function fmtIsoTime(iso) {
    const d = new Date(iso); let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  // container, onValid(iso), onClear(), opts{minIso}. Validação ao vivo.
  function buildTimePicker(container, onValid, onClear, opts) {
    const minIso = opts && opts.minIso;
    const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
    const hSel = el('select', 'tp-h'); hSel.appendChild(opt('', 'h'));
    for (let i = 1; i <= 12; i++) hSel.appendChild(opt(String(i), String(i)));
    const mSel = el('select', 'tp-m');
    ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].forEach((m) => mSel.appendChild(opt(m, ':' + m)));
    let ampm = (new Date()).getHours() >= 12 ? 'PM' : 'AM';
    const apBtn = el('button', 'tp-ap', ampm); apBtn.type = 'button';
    apBtn.onclick = () => { ampm = ampm === 'AM' ? 'PM' : 'AM'; apBtn.textContent = ampm; validate(); };
    const status = el('div', 'tp-status');
    function validate() {
      if (!hSel.value) { status.textContent = ''; status.className = 'tp-status'; onClear(); return; }
      const iso = todayIso(parseInt(hSel.value, 10), parseInt(mSel.value, 10), ampm);
      if (new Date(iso).getTime() > Date.now()) {
        status.textContent = '⛔ Não pode ser no futuro'; status.className = 'tp-status bad'; onClear();
      } else if (minIso && new Date(iso).getTime() <= new Date(minIso).getTime()) {
        status.textContent = '⛔ Tem que ser depois do início'; status.className = 'tp-status bad'; onClear();
      } else {
        status.textContent = '✅ ' + fmtIsoTime(iso); status.className = 'tp-status ok'; onValid(iso);
      }
    }
    hSel.onchange = validate; mSel.onchange = validate;
    const row = el('div', 'tp-row');
    row.appendChild(hSel); row.appendChild(mSel); row.appendChild(apBtn);
    container.appendChild(row); container.appendChild(status);
  }

  function renderPickType() {
    const grid = el('div', 'grid2');
    ((draft.group && draft.group.types) || []).forEach((t) => {
      // "Outro (…)" de cada grupo (e o catch-all especial) ganham destaque visual
      const isOther = /_other$/.test(t.slug) || t.slug === 'special_task';
      const b = el('button', 'btn-big' + (isOther ? ' btn-outro' : ''), t.label);
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
    const timerEl = el('span', 'rec-timer');
    let rec = null;          // SpeechRecognition (transcrição)
    let recorder = null;     // MediaRecorder (áudio)
    let stream = null; let chunks = []; let startMs = 0; let timerInt = null; let autoStop = null;

    function stopAll() {
      try { if (rec) rec.stop(); } catch (_) {}
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
      clearInterval(timerInt); clearTimeout(autoStop);
      mic.classList.remove('rec'); timerEl.textContent = '';
    }
    function startSpeech() {
      if (!SR) return;
      try {
        rec = new SR(); rec.lang = voiceLang; rec.continuous = true; rec.interimResults = true;
        const baseText = textarea.value;
        rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; textarea.value = (baseText ? baseText + ' ' : '') + t; };
        rec.onend = () => { rec = null; };
        rec.onerror = (ev) => { rec = null; const m = Object.prototype.hasOwnProperty.call(VOICE_ERR, ev.error) ? VOICE_ERR[ev.error] : null; if (m) toast(m, 4500); };
        rec.start();
      } catch (_) { rec = null; }
    }
    async function onStop() {
      const mime = (recorder && recorder.mimeType) || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      const dur = Math.round((Date.now() - startMs) / 1000);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      if (!blob.size) return;
      // pergunta salvar
      const ok = window.confirm('Salvar essa gravação de voz? (' + dur + 's)\nO texto já foi pra nota.');
      if (!ok) return;
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(blob); });
        await api('/api/v3/op/voice/upload', { method: 'POST', body: {
          audio_base64: b64, audio_mime: mime.split(';')[0],
          transcript: textarea.value || null, language: voiceLang, duration_seconds: dur,
        } });
        toast('✅ Voz salva (' + dur + 's)');
      } catch (e) {
        toast('⚠️ Áudio não salvo (' + (e.message || 'rede') + ') — mas o texto ficou na nota');
      }
    }
    mic.onclick = async () => {
      if (rec || recorder) { stopAll(); return; }
      startSpeech();
      const hasRec = (typeof navigator !== 'undefined' && navigator.mediaDevices && window.MediaRecorder);
      if (!hasRec) {
        if (!SR) toast('🎤 Este navegador não grava — usa o Chrome ou Edge (ou digita)');
        else { mic.classList.add('rec'); } // só transcrição
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(stream); chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = onStop;
        recorder.start(); startMs = Date.now();
        mic.classList.add('rec');
        timerInt = setInterval(() => { timerEl.textContent = '🔴 ' + Math.round((Date.now() - startMs) / 1000) + 's'; }, 500);
        autoStop = setTimeout(stopAll, 60000); // limite 60s
      } catch (e) {
        mic.classList.remove('rec'); recorder = null;
        const m = e && e.name === 'NotAllowedError' ? VOICE_ERR['not-allowed'] : ('🎤 microfone: ' + (e && e.name || 'erro'));
        toast(m || '🎤 erro', 4500);
      }
    };
    row.appendChild(mic); row.appendChild(lang); row.appendChild(timerEl);
    return row;
  }

  function renderConfirm() {
    const box = el('div');
    let startedOverride = null; // ISO se "Esqueci de marcar" com hora válida; null = Agora
    const lines = [
      labelOf(draft.type && draft.type.slug),
      draft.supplement ? '📦 ' + draft.supplement.canonical_name : null,
      draft.batch ? '🔢 Lote ' + draft.batch.batch_number : null,
    ].filter(Boolean);
    box.appendChild(el('div', 'card mine', '<div class="grow"><div class="title">' + lines.join('</div><div class="sub">') + '</div></div>'));

    // ⏰ Quando começou? (ENTRE o card e o cowork) — Agora (default) | Esqueci
    box.appendChild(el('h2', null, '⏰ Quando começou?'));
    const modeRow = el('div', 'grid2');
    const bNow = el('button', 'btn-big btn-primary', '▶️ Agora');
    const bForgot = el('button', 'btn-big', '🕐 Esqueci de marcar');
    const picker = el('div', 'inline-picker hidden');
    let pickerBuilt = false;
    const refreshGo = () => { go.textContent = startedOverride ? ('▶ COMEÇAR ÀS ' + fmtIsoTime(startedOverride).toUpperCase()) : '▶ COMEÇAR'; };
    const setMode = (forgot) => {
      bNow.classList.toggle('btn-primary', !forgot);
      bForgot.classList.toggle('btn-primary', forgot);
      if (forgot) {
        if (!pickerBuilt) { pickerBuilt = true; buildTimePicker(picker, (iso) => { startedOverride = iso; refreshGo(); }, () => { startedOverride = null; refreshGo(); }); }
        picker.classList.remove('hidden');
      } else { picker.classList.add('hidden'); startedOverride = null; refreshGo(); }
    };
    bNow.onclick = () => setMode(false);
    bForgot.onclick = () => setMode(true);
    modeRow.appendChild(bNow); modeRow.appendChild(bForgot);
    box.appendChild(modeRow); box.appendChild(picker);

    // cowork
    box.appendChild(el('h2', null, '👥 Tem alguém junto?'));
    const cwBox = el('div');
    team.filter((o) => o.id !== session.person.id).forEach((o) => {
      const l = el('label', 'chk');
      const c = el('input'); c.type = 'checkbox'; c.value = o.id;
      c.checked = draft.cowork.includes(o.id);
      c.onchange = () => { draft.cowork = c.checked ? [...draft.cowork, o.id] : draft.cowork.filter((x) => x !== o.id); };
      l.appendChild(c);
      l.appendChild(el('span', null, o.display_name + (o.online ? ' 🟢' : ' ⚪') + (o.current_slug ? ' (em ' + labelOf(o.current_slug) + ')' : '')));
      cwBox.appendChild(l);
    });
    box.appendChild(cwBox);
    // quantidade de ordens (order_printing*) — obrigatória
    const ordersRequired = !!(draft.type && draft.type.orders_required);
    let ordersInput = null;
    if (ordersRequired) {
      box.appendChild(el('h2', null, '🔢 Quantas ordens vai imprimir?'));
      ordersInput = el('input'); ordersInput.type = 'number'; ordersInput.min = '1'; ordersInput.placeholder = 'ex: 206';
      ordersInput.oninput = () => { draft.orders_printed = ordersInput.value; };
      box.appendChild(ordersInput);
    }
    // nota + voz
    const noteRequired = !!(draft.type && draft.type.note_required);
    box.appendChild(el('h2', null, noteRequired ? '📝 Motivo (OBRIGATÓRIO)' : '📝 Nota (opcional)'));
    const ta = el('textarea');
    ta.placeholder = noteRequired ? 'Conta o que está fazendo (obrigatório) — ou usa o 🎤' : 'Escreve ou usa o microfone…';
    ta.value = draft.note || '';
    ta.oninput = () => { draft.note = ta.value; };
    box.appendChild(ta);
    box.appendChild(voiceRow(ta));

    const baseBody = () => ({
      activity_slug: draft.type.slug,
      batch_number: draft.batch ? draft.batch.batch_number : null,
      cowork_with: draft.cowork,
      note: ta.value.trim() || null,
      orders_printed: ordersRequired ? parseInt(ordersInput.value, 10) : undefined,
    });
    async function doSubmit(endedOverride) {
      try {
        if (startedOverride) {
          await api('/api/v3/op/event/retroactive', { method: 'POST', body: Object.assign(baseBody(), { started_at: startedOverride, ended_at: endedOverride || null }) });
          toast('✅ Task adicionada (' + fmtIsoTime(startedOverride) + ')');
        } else {
          await api('/api/v3/op/event/start', { method: 'POST', body: baseBody() });
          toast('✅ Tarefa iniciada!');
        }
        dispatch('CONFIRM_OK');
        refreshIdle().catch(() => {});
      } catch (e) {
        const M = { started_at_future: 'Hora no futuro', started_at_not_today: 'Só dá pra hoje (dias anteriores: fala com o admin)', ended_at_invalid: 'Hora de fim inválida', note_required: 'Precisa de nota', orders_printed_required: 'Precisa da quantidade' };
        toast('❌ ' + (M[e.message] || e.message));
        throw e;
      }
    }
    // "Já terminou?" — só quando started_at customizado (design: pergunta APÓS COMEÇAR)
    function askFinished() {
      const b = el('div');
      b.appendChild(el('div', 'card mine', '<div class="title">' + labelOf(draft.type.slug) + ' · começou ' + fmtIsoTime(startedOverride) + '</div>'));
      b.appendChild(el('h2', null, '✔ Já terminou essa task?'));
      const endPick = el('div', 'inline-picker hidden');
      let endedOverride = null; let built = false; let mode = 'no';
      const row = el('div', 'grid2');
      const yes = el('button', 'btn-big', 'Sim — escolher hora de fim');
      const no = el('button', 'btn-big btn-primary', 'Não — ainda fazendo');
      yes.onclick = () => { mode = 'yes'; if (!built) { built = true; buildTimePicker(endPick, (iso) => { endedOverride = iso; }, () => { endedOverride = null; }, { minIso: startedOverride }); } endPick.classList.remove('hidden'); yes.classList.add('btn-primary'); no.classList.remove('btn-primary'); };
      no.onclick = () => { mode = 'no'; endedOverride = null; endPick.classList.add('hidden'); no.classList.add('btn-primary'); yes.classList.remove('btn-primary'); };
      row.appendChild(yes); row.appendChild(no);
      b.appendChild(row); b.appendChild(endPick);
      const confirm = el('button', 'btn-primary', '✔ Adicionar');
      confirm.onclick = async () => {
        if (mode === 'yes' && !endedOverride) { toast('Escolhe a hora de fim (ou marca "ainda fazendo")'); return; }
        confirm.disabled = true;
        try { await doSubmit(endedOverride); } catch (_) { confirm.disabled = false; }
      };
      const back = el('button', 'btn-sm', '← Voltar'); back.onclick = () => renderConfirm();
      modal('Já terminou?', b, [back, confirm]);
    }

    const go = el('button', 'btn-primary', '▶ COMEÇAR');
    go.onclick = async () => {
      if (noteRequired && !ta.value.trim()) { toast('📝 Conta o que está acontecendo (ou usa 🎤) antes de começar'); ta.focus(); return; }
      const ordersN = ordersInput ? parseInt(ordersInput.value, 10) : null;
      if (ordersRequired && (!Number.isFinite(ordersN) || ordersN <= 0)) { toast('🔢 Informe quantas ordens (número maior que 0)'); if (ordersInput) ordersInput.focus(); return; }
      if (startedOverride) { askFinished(); return; } // pergunta "já terminou?" antes de inserir
      go.disabled = true;
      try { await doSubmit(null); } catch (_) { go.disabled = false; }
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

  // ── PWA: service worker + add-to-home (Fase F) ──────────────
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/op/sw.js').catch(() => {});
  }
  let _installPrompt = null;
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); _installPrompt = e;
      const b = $('btn-install'); if (b && !sessionStorage.getItem('hf_install_dismissed')) b.classList.remove('hidden');
    });
  }
  if ($('btn-install')) {
    $('btn-install').onclick = async () => {
      $('btn-install').classList.add('hidden');
      sessionStorage.setItem('hf_install_dismissed', '1');
      if (_installPrompt) { _installPrompt.prompt(); _installPrompt = null; }
    };
  }

  buildKeypad(); renderPin(); render(); updateConn();
  if (typeof navigator !== 'undefined' && navigator.onLine !== false) syncQueue();
}());
