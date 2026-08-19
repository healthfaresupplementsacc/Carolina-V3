'use strict';
/* ============================================================
   HEALTHFARE Operator · PAUSA — "Você estava nisso desde o começo?"

   Bruno 08-19: "ask at the moment they join to the Pause 'did you work with him
   from the beginning or started just now to work on it?' and then give them 2
   options and so you will be able to know and how to address it properly."

   POR QUE ESTE ARQUIVO EXISTE
   Quem entra numa pausa JÁ EM ANDAMENTO tem duas histórias possíveis e só a
   pessoa sabe qual é. O sistema não adivinha: pergunta, com dois botões grandes,
   e a resposta decide de QUANDO o relógio dela parou.

   DOIS MOMENTOS, A MESMA PERGUNTA
   1. NA HORA — a pessoa toca "entrar" numa pausa de um colega. O backend devolve
      pause_join_question e a pergunta abre como overlay, antes de qualquer coisa
      ser congelada.
   2. DEPOIS — o admin anexou a pessoa à pausa pelo dashboard e ela NÃO estava no
      kiosk (o caso exato do evento 3583, 19/08). O congelamento já rodou com o
      padrão CONSERVADOR ('agora'), e a pergunta fica pendente no topo do /op. O
      card diz, em português claro, o que foi assumido. Se ela responder "desde o
      começo", os números são corrigidos. REGRA #0: nada trava esperando resposta.

   app.js só chama daqui:
     HF_PAUSE.init(deps) uma vez, e depois
     HF_PAUSE.card() / HF_PAUSE.overlay() / HF_PAUSE.key() /
     HF_PAUSE.load() / HF_PAUSE.acts()

   Visual = STYLE-KIT: card 18px, DM Mono na micro-label, DM Serif Display no
   título com UMA palavra em itálico verde, pills navy, chips tonais. Sem em dash.
   Este arquivo NÃO toca o DOM ao carregar (dá pra testar em node).
   ============================================================ */
(function (root, factory) {
  var P = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
  if (root) root.HF_PAUSE = P;
}(typeof window !== 'undefined' ? window : null, function () {

  // ── deps injetadas pelo app.js (nunca importadas) ───────────
  var D = {
    S: null,
    api: function () { return Promise.resolve(null); },
    toast: function () {},
    render: function () {},
    esc: function (s) { return String(s == null ? '' : s); },
    loadData: function () { return Promise.resolve(null); },
  };

  // ── tokens STYLE-KIT (mesmos valores de /op/ws.js) ──────────
  var T = {
    ink: '#0d1f3c', muted: '#54687c', mute2: '#6b7f92', line: '#d4e2f0',
    green: '#2e8b3c', navy: '#12305c',
    warnBg: '#fdf6e3', warnFg: '#6b4c07', warnLn: '#eeddad',
    neuBg: '#eaf0fb', neuFg: '#1a3a6b', neuLn: '#d4e2f0',
  };
  var MONO = '\'DM Mono\',monospace';
  var SORA = '\'Sora\',sans-serif';
  var SERIF = '\'DM Serif Display\',Georgia,serif';
  var CARD = 'background:#fff; border:1px solid ' + T.line + '; border-radius:18px; box-shadow:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05);';

  function microLbl(t) {
    return '<div style="font-family:' + MONO + '; font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:' + T.mute2 + '; font-weight:600;">' + t + '</div>';
  }
  // título editorial: serif, com UMA palavra em itálico verde (regra do STYLE-KIT)
  function title(plain, italic, tail) {
    return '<div style="font-family:' + SERIF + '; font-size:25px; line-height:1.2; color:' + T.ink + '; margin-top:6px;">'
      + D.esc(plain) + ' <em style="font-style:italic; color:' + T.green + ';">' + D.esc(italic) + '</em>' + D.esc(tail || '') + '</div>';
  }
  function chip(txt, bg, fg, ln) {
    return '<span style="display:inline-flex; align-items:center; gap:6px; background:' + bg + '; color:' + fg + '; border:1px solid ' + ln + '; border-radius:999px; padding:5px 11px; font-size:12px; font-weight:600; font-family:' + SORA + ';">' + txt + '</span>';
  }
  // botão pill navy (primário) / contorno (secundário) — os dois grandes, kiosk
  function pill(act, arg, label, sub, primary, busy) {
    var base = 'display:flex; flex-direction:column; align-items:flex-start; gap:3px; width:100%; text-align:left; cursor:pointer; border-radius:14px; padding:15px 17px; font-family:' + SORA + '; font-weight:700; font-size:16px;';
    var skin = primary
      ? 'border:0; background:' + T.navy + '; color:#fff; box-shadow:0 10px 24px -14px rgba(18,48,92,.85);'
      : 'border:1px solid ' + T.line + '; background:#fff; color:' + T.ink + ';';
    return '<button data-act="' + act + '" data-arg="' + D.esc(arg) + '"' + (busy ? ' disabled' : '')
      + ' style="' + base + skin + (busy ? ' opacity:.55;' : '') + '"><span>' + D.esc(label) + '</span>'
      + (sub ? '<span style="font-family:' + MONO + '; font-size:11px; font-weight:500; letter-spacing:.04em; opacity:.75;">' + D.esc(sub) + '</span>' : '')
      + '</button>';
  }

  // ── texto da pergunta (única fonte; overlay e card usam o mesmo) ──
  // "Você estava nisso desde o começo?" + os dois horários reais.
  function optionLabels(q) {
    var ini = q && q.pause_hhmm ? q.pause_hhmm : '--:--';
    var ago = q && q.joined_hhmm ? q.joined_hhmm : '--:--';
    return {
      inicio: 'Desde o começo (' + ini + ')',
      agora: 'Comecei agora (' + ago + ')',
      inicioSub: 'A pausa parou o meu relógio desde as ' + ini,
      agoraSub: 'Meu relógio parou só a partir das ' + ago,
    };
  }

  // ── 1. CARD PENDENTE (topo do /op) ─────────────────────────
  // Aparece quando a pessoa foi anexada à pausa sem estar no kiosk. Diz o que já
  // foi assumido, e deixa ela concordar ou corrigir. Nunca bloqueia a tela.
  function card() {
    var q = D.S && D.S.pauseQ;
    if (!q) return '';
    var L = optionLabels(q);
    var who = q.starter_name ? D.esc(q.starter_name) : 'um colega';
    var busy = !!(D.S && D.S.pauseBusy);
    var h = '<div style="' + CARD + ' padding:18px 20px; display:flex; flex-direction:column; gap:14px;">';
    h += '<div>' + microLbl('Pausa · preciso saber') + title('Você estava nisso desde o', 'começo', '?') + '</div>';
    h += '<div style="font-size:14px; color:' + T.muted + '; line-height:1.5;">Você entrou na pausa de <b>' + who + '</b>'
      + (q.note ? ' (' + D.esc(q.note) + ')' : '') + '. Ela começou às <b>' + D.esc(q.pause_hhmm || '--:--') + '</b>'
      + ' e você entrou às <b>' + D.esc(q.joined_hhmm || '--:--') + '</b>.</div>';
    h += '<div>' + chip('Por enquanto contei a partir das ' + D.esc(q.joined_hhmm || '--:--'), T.warnBg, T.warnFg, T.warnLn) + '</div>';
    h += '<div style="display:flex; flex-direction:column; gap:10px;">'
      + pill('pauseAnswer', q.event_id + ':inicio', L.inicio, L.inicioSub, true, busy)
      + pill('pauseAnswer', q.event_id + ':agora', L.agora, L.agoraSub, false, busy)
      + '</div>';
    h += '<div style="font-size:11.5px; color:' + T.mute2 + '; line-height:1.45;">Se você estava desde o começo eu ajusto o tempo, nada se perde.</div>';
    h += '</div>';
    return h;
  }

  // ── 1b. BANNER "VOCÊ ESTÁ EM PAUSA" (veio do app.js, Bruno 08-19) ──
  // Aparência IDÊNTICA à de antes (âmbar, ⏸️, botão verde "Voltar ao trabalho");
  // mudou de casa só pra pausa ter um dono só. Quem termina a pausa termina PRO
  // GRUPO: o backend descongela todo mundo e cada colega recebe o "continuar ou
  // finalizar?" no kiosk dele.
  function banner() {
    var S = D.S || {};
    var pt = (S.myTasks || []).find(function (t) { return t.slug === 'break'; });
    if (!pt) return '';
    var note = (pt.description || '').replace(/\s*\|\s*fim:.*/i, '').trim();
    var frozen = (S.myTasks || []).filter(function (t) { return t.is_paused; }).length;
    var play = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    var h = '<div style="background:linear-gradient(135deg,rgba(217,145,0,.16),rgba(217,145,0,.07)); border:1px solid rgba(217,145,0,.4); border-radius:20px; padding:16px 18px; display:flex; flex-direction:column; gap:12px;">';
    h += '<div style="display:flex; align-items:center; gap:12px;"><span style="flex:none; width:46px; height:46px; border-radius:14px; background:rgba(217,145,0,.18); color:#8a5a00; display:flex; align-items:center; justify-content:center; font-size:24px;">⏸️</span><div style="flex:1; min-width:0;"><div style="font-family:' + SORA + '; font-weight:800; font-size:18px; color:#0c2545;">Você está em pausa</div>'
      + (note ? '<div style="font-size:13.5px; color:#8a5a00; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + D.esc(note) + '</div>' : '')
      + (frozen ? '<div style="font-size:12px; color:#8a5a00; margin-top:2px;">' + frozen + ' tarefa(s) congelada(s) · o relógio parou</div>' : '') + '</div></div>';
    h += '<button data-act="resumeWork" data-arg="' + pt.id + '" ' + (S.resumeBusy ? 'disabled' : '') + ' style="border:0; cursor:pointer; border-radius:14px; padding:14px; background:linear-gradient(135deg,#1aa06a,#0e7a4e); color:#fff; font-weight:800; font-size:16px; font-family:' + SORA + '; box-shadow:0 14px 30px -16px rgba(14,122,78,.7); display:flex; align-items:center; justify-content:center; gap:8px;">' + play + (S.resumeBusy ? 'Retomando…' : 'Voltar ao trabalho') + '</button>';
    h += '</div>';
    return h;
  }

  // ── 2. OVERLAY NA HORA (a pessoa tocou "entrar" numa pausa) ──
  // Mesma pergunta, sem o aviso de "assumi" porque nada foi assumido ainda.
  function overlay() {
    var o = D.S && D.S.overlay;
    if (!o || o.type !== 'pauseJoin') return '';
    var q = o.q || {};
    var L = optionLabels(q);
    var busy = !!(D.S && D.S.pauseBusy);
    var h = '<div style="' + CARD + ' padding:20px 22px; display:flex; flex-direction:column; gap:14px; max-width:520px; margin:0 auto;">';
    h += '<div>' + microLbl('Entrar na pausa') + title('Você estava nisso desde o', 'começo', '?') + '</div>';
    h += '<div style="font-size:14px; color:' + T.muted + '; line-height:1.5;">A pausa começou às <b>' + D.esc(q.pause_hhmm || '--:--') + '</b>. Escolha uma das duas para eu parar o seu relógio na hora certa.</div>';
    h += '<div style="display:flex; flex-direction:column; gap:10px;">'
      + pill('pauseJoinPick', q.pause_event_id + ':inicio', L.inicio, L.inicioSub, true, busy)
      + pill('pauseJoinPick', q.pause_event_id + ':agora', L.agora, L.agoraSub, false, busy)
      + '</div>';
    h += '<button data-act="closeOverlay" style="border:0; background:transparent; cursor:pointer; color:' + T.mute2 + '; font-size:12.5px; font-family:' + SORA + '; padding:4px;">Agora não</button>';
    h += '</div>';
    return h;
  }

  // chave de render (evita repintar a tela toda a cada tick)
  function key() {
    var q = D.S && D.S.pauseQ;
    var o = D.S && D.S.overlay;
    return 'pz|' + (q ? q.event_id : '') + '|' + ((o && o.type === 'pauseJoin') ? (o.q && o.q.pause_event_id) : '') + '|' + ((D.S && D.S.pauseBusy) ? 1 : 0);
  }

  // ── dados ───────────────────────────────────────────────────
  // pergunta pendente. Falhar aqui NUNCA pode derrubar o /op (REGRA #0): erro
  // vira "sem pergunta" e a tela segue normal.
  function load() {
    return D.api('/api/v3/op/pause/pending')
      .then(function (r) { D.S.pauseQ = (r && r.question) || null; return D.S.pauseQ; })
      .catch(function () { D.S.pauseQ = null; return null; });
  }

  // arg = "<event_id>:inicio" | "<event_id>:agora"
  function answer(arg) {
    var p = String(arg || '').split(':');
    var id = parseInt(p[0], 10); var since = p[1];
    if (!isFinite(id) || (since !== 'inicio' && since !== 'agora')) return;
    if (D.S.pauseBusy) return;
    D.S.pauseBusy = true; D.render();
    D.api('/api/v3/op/pause/answer', { method: 'POST', body: { event_id: id, since: since } })
      .then(function (r) {
        D.S.pauseBusy = false; D.S.pauseQ = null;
        var add = r && r.credited_seconds ? Math.round(r.credited_seconds / 60) : 0;
        if (since === 'inicio' && add > 0) D.toast('Ajustado: mais ' + add + ' min de pausa descontados ✓');
        else D.toast('Anotado, obrigado ✓');
        D.loadData();
      })
      .catch(function () { D.S.pauseBusy = false; D.toast('Não consegui registrar, tento de novo depois'); D.render(); });
  }

  // arg = "<pause_event_id>:inicio" | "<pause_event_id>:agora"
  function joinPick(arg) {
    var p = String(arg || '').split(':');
    var id = parseInt(p[0], 10); var since = p[1];
    if (!isFinite(id) || (since !== 'inicio' && since !== 'agora')) return;
    if (D.S.pauseBusy) return;
    D.S.pauseBusy = true; D.render();
    D.api('/api/v3/op/pause/join', { method: 'POST', body: { pause_event_id: id, since: since } })
      .then(function () {
        D.S.pauseBusy = false; D.S.overlay = null; D.S.pauseQ = null;
        D.toast('Você entrou na pausa ✓');
        D.loadData();
      })
      .catch(function () { D.S.pauseBusy = false; D.toast('Não consegui entrar na pausa'); D.render(); });
  }

  // abre o overlay a partir da resposta do /event/:id/join (pause_join_question)
  function askJoin(res, hhmm) {
    if (!res || !res.pause_join_question) return false;
    D.S.overlay = {
      type: 'pauseJoin',
      q: {
        pause_event_id: res.pause_event_id,
        pause_hhmm: hhmm || fmtHHMM(res.pause_started_at),
        joined_hhmm: fmtHHMM(new Date()),
      },
    };
    D.render();
    return true;
  }
  function fmtHHMM(t) {
    if (t == null || t === '') return '--:--'; // new Date(null) é época 0, não "inválido"
    try {
      var d = t instanceof Date ? t : new Date(t);
      if (isNaN(d.getTime())) return '--:--';
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
    } catch (e) { return '--:--'; }
  }

  // ações que o app.js despacha (data-act)
  function acts() {
    return { pauseAnswer: answer, pauseJoinPick: joinPick };
  }

  function init(deps) {
    Object.keys(deps || {}).forEach(function (k) { D[k] = deps[k]; });
    return P;
  }

  var P = {
    init: init, acts: acts,
    card: card, banner: banner, overlay: overlay, key: key, load: load,
    answer: answer, joinPick: joinPick, askJoin: askJoin,
    // helpers puros (testes)
    _: { optionLabels: optionLabels, fmtHHMM: fmtHHMM, title: title, pill: pill, chip: chip },
  };
  return P;
}));
