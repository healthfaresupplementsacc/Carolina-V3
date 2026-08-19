'use strict';
/* ============================================================
   HEALTHFARE · FILA DE IMPRESSÃO DO CELULAR (/shared/print-queue-card.js)

   O admin aperta "Mandar pro computador da impressora" no celular; o pedido
   entra em v3.print_queue; QUEM tem papel (a Central do /op, o hub de Estoque e
   a estação /print) puxa a fila e imprime. O celular nunca fala com impressora:
   quem tem papel é que inicia a conversa, igual ao print-event do .28.

   Este módulo é a peça compartilhada pelas TRÊS telas: mesmo cartão, mesmos
   textos, mesma máquina de estados. Sem ele seriam três cópias divergindo.

   Uso:
     var Q = window.HF_PRINT_QUEUE.create({
       api: fn(path, opts) -> Promise,       // o api() da própria tela
       by: fn() -> 'Nome de quem está logado',
       onChange: fn(),                        // pede re-render
       toast: fn(msg),
       openWindow: fn() -> window|null,       // janela de impressão
       printPicklist: fn() -> bool,           // Central: usa o print() dela
     });
     Q.start(); Q.stop(); Q.html(); Q.act(id) / Q.jobs
   PT-BR, sem em dash. Não toca o DOM ao carregar.
   ============================================================ */
(function (root, factory) {
  var M = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  if (root) root.HF_PRINT_QUEUE = M;
}(typeof window !== 'undefined' ? window : null, function () {

  var BASE = '/api/v3/print-queue';
  var POLL_MS = 30000;
  /* Um job "taken" que ficou preso (quem pegou fechou a aba, o popup foi
     bloqueado, o PC dormiu) não pode segurar a etiqueta pra sempre. Depois de
     10 minutos ele volta a ser oferecido, avisando que estava travado. */
  var STUCK_MIN = 10;

  var KIND_LABEL = {
    bin_labels: 'Etiquetas de prateleira',
    box_label: 'Etiqueta de caixa',
    picklist: 'Picklist de hoje',
  };
  function kindLabel(k) { return KIND_LABEL[String(k || '')] || 'Impressão'; }

  /** Quantas etiquetas esse job manda pro papel. Picklist = 1 folha. */
  function jobCount(job) {
    var p = (job && job.payload) || {};
    if (Array.isArray(p.labels)) return p.labels.length;
    if (String(job && job.kind) === 'picklist') return 1;
    return 0;
  }

  /** "agora mesmo" · "há 2 min" · "há 1 h 5 min". Minuto é o que o operador lê. */
  function ageText(min) {
    var m = Math.max(0, Math.round(Number(min) || 0));
    if (m < 1) return 'agora mesmo';
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return 'há ' + h + ' h' + (r ? ' ' + r + ' min' : '');
  }

  /** Esse job está livre pra eu pegar? queued sempre; taken só se travou. */
  function isTakeable(job) {
    if (!job) return false;
    var st = String(job.status || '');
    if (st === 'queued') return true;
    if (st !== 'taken') return false;
    return (Number(job.age_min) || 0) >= STUCK_MIN;
  }

  /** O que o botão diz. Job travado avisa que vai ser uma 2ª tentativa. */
  function actionLabel(job) {
    if (job && String(job.status) === 'taken') return 'Tentar de novo';
    return 'Imprimir';
  }
  /** Linha de estado embaixo do job (só aparece quando tem o que dizer). */
  function stateNote(job) {
    if (!job) return '';
    var st = String(job.status || '');
    if (st === 'taken') {
      var m = Math.round(Number(job.age_min) || 0);
      return m >= STUCK_MIN ? 'travado há ' + m + ' min · tentar de novo' : 'imprimindo em ' + (job.taken_by || 'outro computador');
    }
    if (st === 'error') return job.error_note ? 'deu erro: ' + job.error_note : 'deu erro na última tentativa';
    return '';
  }

  /**
   * Motivo do erro em texto de gente, pro POST /error e pro admin ler no
   * celular. O api() do kiosk monta a Error com `j.detail || j.error`, e o
   * backend da fila responde {error:{code,message}}: sem esta peneira o admin
   * receberia "[object Object]" em vez de saber o que houve.
   */
  function errNote(e) {
    if (!e) return 'falhou na estação';
    var body = e.body || {};
    var be = body.error;
    if (be && typeof be === 'object' && be.message) return String(be.message).slice(0, 200);
    if (typeof be === 'string' && be) return be.slice(0, 200);
    if (body.detail) return String(body.detail).slice(0, 200);
    var m = e.message ? String(e.message) : '';
    if (!m || m === '[object Object]') return 'falhou na estação';
    return m.slice(0, 200);
  }

  /** Só o que interessa mostrar: fila + travados. done/cancelled somem. */
  function visibleJobs(list) {
    return (list || []).filter(function (j) {
      var st = String(j && j.status);
      if (st === 'queued') return true;
      if (st === 'taken') return true;   // mostra quem está imprimindo, e libera se travar
      return false;
    });
  }

  function create(deps) {
    var D = deps || {};
    var api = D.api || function () { return Promise.resolve(null); };
    var by = D.by || function () { return ''; };
    var onChange = D.onChange || function () {};
    var toast = D.toast || function () {};
    var openWindow = D.openWindow || function () {
      return (typeof window !== 'undefined') ? window.open('', '_blank', 'width=520,height=760') : null;
    };
    var printPicklist = D.printPicklist || null;

    var S = { jobs: [], busy: null, timer: null, on: false };

    function labelsRenderer() {
      var W = typeof window !== 'undefined' ? window : null;
      return (W && W.HF_LABELS) || (typeof global !== 'undefined' && global.HF_LABELS) || null;
    }

    function load() {
      if (!S.on) return Promise.resolve(null);
      return api(BASE + '?status=queued&limit=50')
        .then(function (j) {
          var list = (j && j.data && j.data.jobs) || (j && j.jobs) || [];
          var before = S.jobs.length;
          S.jobs = visibleJobs(list);
          if (S.jobs.length !== before || S.jobs.length) onChange();
          return S.jobs;
        })
        .catch(function () {
          /* fila fora do ar não pode atrapalhar quem está trabalhando: some o
             cartão e a tela segue igual (REGRA #0). */
          if (S.jobs.length) { S.jobs = []; onChange(); }
          return [];
        });
    }

    function start() {
      if (S.on) return;
      S.on = true;
      load();
      S.timer = setInterval(load, POLL_MS);
    }
    function stop() {
      S.on = false;
      if (S.timer) { clearInterval(S.timer); S.timer = null; }
    }

    /** Abre a janela com as etiquetas do job. Devolve true se foi pro papel. */
    function printLabels(job) {
      var HL = labelsRenderer();
      var labels = ((job && job.payload) || {}).labels || [];
      if (!HL) { toast('O desenho da etiqueta não carregou nesta tela. Recarregue a página e tente de novo.'); return false; }
      if (!labels.length) { toast('Esse pedido chegou sem etiqueta. Peça de novo pelo celular.'); return false; }
      var win = openWindow();
      if (!win) { toast('O navegador bloqueou a janela. Libere os popups deste site e toque de novo.'); return false; }
      try {
        win.document.write(HL.sheetHtml(labels, { title: kindLabel(job.kind) }));
        win.document.close();
      } catch (e) { return false; }
      return true;
    }

    /**
     * Fluxo de um job: take → imprime → done. Deu ruim no meio? error, com o
     * motivo, pra quem pediu no celular ver o que houve em vez de ficar
     * esperando papel que não vem.
     */
    function take(id) {
      if (S.busy) return Promise.resolve(null);
      var job = S.jobs.find(function (j) { return String(j.id) === String(id); });
      if (!job) return Promise.resolve(null);
      var who = by() || 'estação';
      S.busy = job.id; onChange();

      return api(BASE + '/' + encodeURIComponent(job.id) + '/take', { method: 'POST', body: { by: who } })
        .then(function () {
          var ok = String(job.kind) === 'picklist'
            ? (printPicklist ? printPicklist() : printLabels(job))
            : printLabels(job);
          if (!ok) throw new Error('não deu pra abrir a janela de impressão');
          return api(BASE + '/' + encodeURIComponent(job.id) + '/done', { method: 'POST', body: { by: who } })
            .then(function () {
              S.busy = null;
              S.jobs = S.jobs.filter(function (j) { return String(j.id) !== String(job.id); });
              toast('Impresso. Pode tirar do papel.');
              onChange();
              load();
            });
        })
        .catch(function (e) {
          S.busy = null;
          var note = errNote(e);
          /* 409 = outro computador pegou antes. Não é erro do job, é corrida
             normal com duas telas abertas: só atualiza a lista e diz o porquê. */
          if (e && e.status === 409) {
            toast('Outro computador pegou esse pedido primeiro.');
            onChange(); load();
            return null;
          }
          return api(BASE + '/' + encodeURIComponent(job.id) + '/error', { method: 'POST', body: { by: who, note: note } })
            .catch(function () {})
            .then(function () {
              toast('Não deu pra imprimir agora. Quem pediu no celular já foi avisado.');
              onChange(); load();
            });
        });
    }

    return {
      start: start, stop: stop, load: load, take: take,
      get jobs() { return S.jobs; },
      get busy() { return S.busy; },
      state: S,
    };
  }

  return {
    create: create,
    BASE: BASE, POLL_MS: POLL_MS, STUCK_MIN: STUCK_MIN,
    kindLabel: kindLabel, jobCount: jobCount, ageText: ageText,
    isTakeable: isTakeable, actionLabel: actionLabel, stateNote: stateNote,
    visibleJobs: visibleJobs, errNote: errNote,
  };
}));
