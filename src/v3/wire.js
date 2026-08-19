'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.12 — wiring do V3 no app legado.
 *
 * ADITIVO: monta 2 rotas novas e starta o Observer worker. NÃO
 * altera nenhuma rota ou comportamento legado.
 *   POST /slack/events-v2     webhook Events API v2
 *   GET  /api/admin/v3/*      inspeção shadow
 *   Observer worker           mode='shadow' (não reage/posta/DM)
 *
 * Pool próprio (makeV3Pool, search_path=v3,public). Em shadow e
 * com v3.messages vazia, o worker só dá heartbeat — zero custo de
 * LLM até chegar mensagem (webhook ligado ou backfill rodado).
 */
const { makeV3Pool } = require('./utils/v3-pool');
const { getProductionProvider } = require('./llm/LLMProvider');
const { PersonResolver } = require('./services/PersonResolver');
const { PromptBuilder } = require('./llm/prompt-builder');
const { EventService } = require('./services/EventService');
const { BatchService } = require('./services/BatchService');
const { ProductionCountService } = require('./services/ProductionCountService');
const { GoalService } = require('./services/GoalService');
const { Observer } = require('./llm/Observer');
const { CommandHandler } = require('./services/CommandHandler');
const slackSender = require('./slack/sender');
const { eventsV2Handler } = require('./slack/events-v2');
const adminV3 = require('./admin-v3/routes');
const dataApi = require('./data/router');
const imagesApi = require('./images/router');
const architectApi = require('../routes/architect');
const opApi = require('../routes/op');

let _pool = null;
let _svc = null;
let _observer = null;

function _init() {
  if (_pool) return;
  _pool = makeV3Pool();
  // Pivot 12/jun: LLM_PROVIDER=gemini (default) com fallback Anthropic
  // automático; LLM_PROVIDER=anthropic = rollback de 1 env var.
  const provider = getProductionProvider();
  console.log('[V3] LLM provider: ' + provider.name);
  const eventService = new EventService({ db: _pool });
  const batchService = new BatchService({ db: _pool });
  // Bloco 30/mai-noite — CommandHandler pra comandos admin via @Carolina.
  const commandHandler = new CommandHandler({
    db: _pool, provider, eventService, batchService,
    slack: { postAs: slackSender.postAs, addReaction: slackSender.addReaction },
    productionChannelId: process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK',
    adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
  });
  // Deploy 3 — notificações do dedupe (✅/❌/📝 no admin-orin).
  const { NotificationHandler } = require('./services/NotificationHandler');
  const notificationHandler = new NotificationHandler({
    db: _pool,
    slack: { postAs: slackSender.postAs, updateMessage: slackSender.updateMessage },
    adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
  });
  // avisa o admin-orin quando um incidente de dados (duplicata) é detectado (Bruno 07-23)
  const _incidentAdminChannel = process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
  const _onDataIncident = async (incidentId) => {
    try {
      const r = await _pool.query('SELECT * FROM v3.data_incidents WHERE id=$1', [incidentId]);
      const inc = r.rows[0]; if (!inc) return;
      const w = inc.where_json || {};
      await slackSender.postAs({
        channel: _incidentAdminChannel, sender: { name: 'HealthFare Tracker', icon: ':rotating_light:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false,
        text: `:rotating_light: *INCIDENTE DE DADOS — ${inc.title}*\n`
          + `${inc.explanation}\n\n`
          + `*Diagnóstico:* ${inc.diagnosis}\n`
          + `_1ª (mantida): ${w.original ? w.original.channel + ' · ' + w.original.person : '?'}_\n`
          + `_2ª (duplicata): ${w.duplicate ? w.duplicate.channel + ' · ' + w.duplicate.person : '?'}_\n`
          + `Já corrigi automaticamente (a 2ª não soma mais). Detalhes na caixa de incidentes do dashboard.`,
      });
    } catch (e) { console.error('[incident] slack:', e.message); }
  };
  _svc = {
    provider, eventService, batchService, commandHandler, notificationHandler,
    productionCountService: new ProductionCountService({ db: _pool, onIncident: _onDataIncident }),
    goalService: new GoalService({ db: _pool }),
    personResolver: new PersonResolver({ db: _pool, provider }),
    promptBuilder: new PromptBuilder({ db: _pool }),
  };
}

/** Síncrono — registra as rotas v3. Chamar ANTES do dashboardRouter. */
function mount(app) {
  _init();
  const productionChannelId = process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
  const adminChannelId = process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';

  // webhook — reaproveita req.rawBody que o middleware /slack legado
  // já captura (rawBodySaver). Não usa express.raw próprio.
  app.post('/slack/events-v2', async (req, res) => {
    try {
      const out = await eventsV2Handler(req.rawBody || '', req.headers || {}, {
        db: _pool,
        productionChannelId,
        adminChannelId,
        eventService: _svc.eventService,
        commandHandler: _svc.commandHandler,
        notificationHandler: _svc.notificationHandler,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      });
      res.status(out.status).send(out.body);
    } catch (e) {
      console.error('[V3] events-v2 erro:', e.message);
      res.status(500).send('erro');
    }
  });

  // Fase D — headers de segurança SÓ nas rotas novas (V4 legado intocado).
  const { securityHeaders, makeBruteForceGuard } = require('../middleware/security');
  for (const prefix of ['/op', '/admin', '/api/v3/op', '/api/v3/architect', '/api/adminpanel']) {
    app.use(prefix, securityHeaders);
  }
  // brute-force guard compartilhado (login admin + operador)
  const bruteForce = makeBruteForceGuard({
    db: _pool, slack: { postAs: slackSender.postAs }, adminChannelId,
  });
  // Fase D — re-hidrata bans persistidos (v3.blocked_ips) no boot e aplica gate
  // global 403 nas rotas novas: IP banido não acessa NADA, não só o login.
  bruteForce.hydrate().then((n) => { if (n) console.log(`[V3] brute-force: ${n} IP(s) banido(s) re-hidratado(s)`); }).catch(() => {});
  for (const prefix of ['/op', '/admin', '/api/v3/op', '/api/v3/architect', '/api/adminpanel']) {
    app.use(prefix, bruteForce.globalGate);
  }

  // endpoints de inspeção shadow
  app.use('/', adminV3.createRouter({ db: _pool }));
  // Fase 1 (Operator Page bloco) — Architect API read-only. Auth por
  // ARCHITECT_API_TOKEN / OPERATOR_PAGE_TOKEN (env). Sem env setada,
  // nenhum token autentica (rotas respondem 401) — seguro deployar antes
  // de setar as vars.
  app.use('/', architectApi.createArchitectRouter({ db: _pool }));
  // Deploy 2 — Operator Page: API de writes estruturados (sem LLM) + UI
  // estática em /op. config.js dinâmico vem ANTES do static (precedência).
  // ③ Gemini lê motivos/notas (contido, gated por NOTE_LLM_ENABLED). Caminho
  // separado do Observer shadow; só age quando relevante (admin / qtd não registrada).
  let _noteAnalyzer = null;
  try {
    const { NoteAnalyzer } = require('./llm/note-analyzer');
    const GeminiProvider = require('./llm/providers/GeminiProvider');
    _noteAnalyzer = new NoteAnalyzer({ db: _pool, slack: { postAs: slackSender.postAs }, provider: new GeminiProvider({}), adminChannelId });
    console.log('[V3] note-analyzer ' + (_noteAnalyzer.enabled ? 'ON' : 'OFF (NOTE_LLM_ENABLED!=true)'));
  } catch (e) { console.error('[V3] note-analyzer não iniciou:', e.message); }

  app.use('/', opApi.createOpRouter({
    db: _pool,
    slack: { postAs: slackSender.postAs },
    adminChannelId: adminChannelId,
    noteAnalyzer: _noteAnalyzer,
    bruteForce,
  }));
  {
    const express2 = require('express');
    const path2 = require('path');
    // Redesign: design system compartilhado (/op, /admin, /admin/metrics, /dashboard-v4).
    app.use('/shared', express2.static(path2.join(process.cwd(), 'src', 'shared')));
    app.use('/op', express2.static(path2.join(process.cwd(), 'src', 'op')));
    // Estação de Impressão (.28) — "User Screen" kiosk (login PIN igual /op). Bruno 07-16.
    app.use('/print', express2.static(path2.join(process.cwd(), 'src', 'print')));
    // Scanner do CELULAR (S15 Fase 3, Bruno 08-18) — página pareada por QR. Sem
    // login: o código do pareamento é a credencial (curto, 15 min, renovável).
    // Empurra cada leitura pro kiosk via POST /api/v3/scan/push.
    app.use('/scan', express2.static(path2.join(process.cwd(), 'src', 'scan')));
    // ADMIN MOBILE (S15.29, Bruno 08-19) — o inventário e a impressão inteiros no
    // iPhone. Estático como /scan e /print: página de celular não precisa de build,
    // e um bundle de dashboard no 4G do armazém é um começo lento toda vez. Auth =
    // o MESMO x-admin-pin de sempre, guardado 12h no localStorage do telefone.
    app.use('/m', express2.static(path2.join(process.cwd(), 'src', 'm')));
    // Fases B+C — Admin Panel (path NOVO; dashboard V4 intocado).
    const adminPanel = require('../routes/admin');
    app.use('/', adminPanel.createAdminRouter({
      db: _pool,
      slack: { postAs: slackSender.postAs, updateMessage: slackSender.updateMessage },
      bruteForce,
    }));
    const adminDir = path2.join(process.cwd(), 'src', 'admin');
    app.use('/admin', express2.static(adminDir));
    // SPA: /admin/operators e /admin/notifications servem o mesmo index
    app.get(['/admin', '/admin/operators', '/admin/notifications', '/admin/analytics', '/admin/metrics', '/admin/voices', '/admin/audit'], (_req, res) => {
      res.sendFile(path2.join(adminDir, 'index.html'));
    });
  }
  // recordTotal — grava o total de produção na contagem canônica (com dedup do
  // ProductionCountService). COMPARTILHADO pelo worker conversacional E pela caixa
  // admin do dashboard (Bruno 07-27). Um só caminho de gravação = sem divergência.
  const _totalCountSvc = new ProductionCountService({ db: _pool });
  const recordTotal = async ({ followup, bottles, via, byPersonId }) => {
    if (!followup.product_id) return;   // sem produto → o admin resolve manualmente
    const prodDate = (await _pool.query(
      `SELECT (started_at AT TIME ZONE 'America/New_York')::date::text d FROM v3.events WHERE id=$1`, [followup.event_id])).rows[0];
    await _totalCountSvc.record({
      product_id: followup.product_id,
      product_batch_id: null,
      bottles,
      reported_by_person_id: byPersonId || followup.person_id,
      production_date: (prodDate && prodDate.d) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      source_event_id: followup.event_id,
      actor_type: via === 'admin_dashboard' ? 'admin' : 'operator',
      confidence: 'high',
      notes: 'total via followup (' + (via || '?') + ')',
    });
  };

  // Bloco 0 — API de dados JSON (contrato pros clientes). Aditivo.
  app.use('/', dataApi.createDataRouter({ db: _pool, recordTotal,
    slack: { postAs: slackSender.postAs }, adminChannelId }));
  // Warehouse hub (Bruno 08-18, S15 Fase 1) — /api/v3/warehouse/*. Módulo novo,
  // não encosta no data router (arquivo grande demais). Mesma porta única de
  // escrita: StockService + StockRequestService; divergência vira data_incident
  // igual ao resto do estoque.
  const warehouseApi = require('./warehouse/router');
  const { StockService: WhStockService } = require('./services/StockService');
  const { StockRequestService } = require('./services/StockRequestService');
  const { veeqo: whVeeqo } = require('./services/veeqo-api');
  const whStock = new WhStockService({
    db: _pool,
    onDiscrepancy: async (d) => {
      try {
        await _pool.query(
          `INSERT INTO v3.data_incidents (kind, severity, title, explanation, product_id, amount, where_json)
           VALUES ($1, 'warning', $2, $3, $4, $5, $6::jsonb)`,
          ['stock_' + (d.kind || 'desync'), 'Estoque: ' + (d.kind || 'divergência'),
            d.note || 'divergência de estoque detectada', d.product_id || null,
            d.wanted != null ? d.wanted : null,
            JSON.stringify({ bin_id: d.bin_id || null, box_id: d.box_id || null, applied: d.applied != null ? d.applied : null })]);
      } catch (e) { console.error('[stock] incidente falhou:', e.message); }
    },
  });
  const whRequests = new StockRequestService({ db: _pool, stock: whStock });
  // FILA DE IMPRESSÃO (S15.34, Bruno 08-19) — o celular pede, a estação puxa. O
  // service é COMPARTILHADO: o warehouse router enfileira (mobile/print/submit) e o
  // print-queue router é onde a estação toma/conclui. Uma instância, uma fila.
  const printQueueApi = require('./print-queue/router');
  const { PrintQueueService } = require('./print-queue/service');
  const printQueue = new PrintQueueService({ db: _pool });
  app.use('/', printQueueApi.createPrintQueueRouter({ db: _pool, queue: printQueue }));
  app.use('/', warehouseApi.createWarehouseRouter({
    db: _pool, stock: whStock, requests: whRequests, veeqo: whVeeqo,
    printQueue, adminChannelId }));
  // Bloco 3 — SPA do dashboard (cliente puro da API). Estática,
  // buildada em public/dashboard/. Aditivo — não toca nada.
  const express = require('express');
  const path = require('path');
  app.use('/dashboard', express.static(path.join(process.cwd(), 'public', 'dashboard')));
  // V4 (redesign, E4) — SPA paralela em /dashboard-v4. Cliente puro do
  // mesmo /api/v3/data/* (PIN-authed). dashboard/ atual segue intacto.
  // Switch de URL (E8) só rola quando a lista de paridade estiver verde.
  // PERF (Bruno 08-04): assets com hash no nome (/assets/index-XXXX.js/.css) NUNCA
  // mudam sem rebuild → cache imutável de 1 ano (o browser nem revalida, carrega da
  // cache local instantâneo). Antes vinha max-age=0 → o bundle de 146KB era baixado/
  // revalidado a CADA abertura, o que fazia o dashboard "demorar toda vez". O
  // index.html (sem hash) fica no-cache pra que deploy novo apareça na hora.
  const V4_DIR = path.join(process.cwd(), 'public', 'dashboard-v4');
  app.use('/dashboard-v4', express.static(V4_DIR, {
    etag: true, lastModified: true,
    setHeaders(res, filePath) {
      // tudo em /assets/ tem hash no nome → imutável 1 ano. index.html → no-cache.
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (/index\.html$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  // FOTO — page standalone pra Simone subir foto pro #images (C0B6AQX6LJV).
  // SLACK_BOT_TOKEN no backend; cliente envia base64 com token leve `?k=`.
  // 503 enquanto IMAGES_UPLOAD_TOKEN não tiver no env (Bruno seta no Railway).
  // Lateral total — não toca v3.events/messages/Observer/dashboard.
  app.use('/foto', express.static(path.join(process.cwd(), 'public', 'foto')));
  app.use('/', imagesApi.createImagesRouter({}));
  console.log('[V3] rotas montadas: /slack/events-v2 + /api/admin/v3/* + /api/v3/data/* + /api/v3/warehouse/* + /api/v3/print-queue/* + /m + /dashboard + /dashboard-v4 + /foto + /api/images/upload');
}

/** Assíncrono — resolve o bot user id e starta o Observer worker. */
async function startWorker() {
  _init();
  // ── FIX 07-03 (bug que MATOU os avisos da Ana): `productionChannelId` só
  // existia no escopo do mount() → ReferenceError aqui no startWorker → o boot
  // dos workers ABORTAVA na primeira referência e absence-alert / carolina-dm /
  // ems-sync / crons NUNCA subiam (log: "[Boot] V3 worker start error").
  const productionChannelId = process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK';
  const adminChannelForOps = process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';

  // ── WATCHDOG DE WORKERS (Bruno 07-03: "um worker que fica checando") ──
  // Cada worker crítico bate um heartbeat em v3.settings a cada tick; este vigia
  // roda a cada 10min e DENUNCIA no canal ADMIN qualquer worker sem batida dentro
  // do esperado (falha silenciosa nunca mais). Montado ANTES de tudo — se
  // qualquer bloco abaixo explodir, o vigia sobrevive e reporta a ausência.
  const bootAt = Date.now();
  const beat = (name) => _pool.query(
    `INSERT INTO v3.settings (key, value, description) VALUES ($1, to_jsonb(NOW()), 'heartbeat do worker')
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb(NOW()), updated_at = NOW()`,
    ['worker_tick_' + name]).catch(() => {});
  // FONTE ÚNICA (Bruno 07-28): o watchdog deriva a lista do REGISTRO de processos.
  // Vigia todo processo do Railway que está LIGADO e tem heartbeat. Adicionar um
  // worker novo no registro = ele passa a ser vigiado automaticamente. O observer
  // bate numa chave própria (observer_last_tick_at) — mapeado aqui.
  const _registry = require('./process-registry');
  const EXPECTED_WORKERS = _registry.watchedProcesses().map((p) => ({
    name: p.key,
    tickKey: p.heartbeatKey === 'observer_last_tick_at' ? 'observer_last_tick_at' : p.key,
    staleMin: p.staleMin || 10,
  }));
  const _wdLastAlert = new Map(); // name -> ts (não spamma: 1 alerta/60min por worker)
  setInterval(async () => {
    try {
      if (Date.now() - bootAt < 12 * 60 * 1000) return; // graça pós-boot
      const r = await _pool.query("SELECT key, value FROM v3.settings WHERE key LIKE 'worker_tick_%' OR key='observer_last_tick_at'");
      const ticks = new Map(r.rows.map((x) => [x.key.startsWith('worker_tick_') ? x.key.replace('worker_tick_', '') : x.key, new Date(JSON.parse(JSON.stringify(x.value))).getTime()]));
      for (const w of EXPECTED_WORKERS) {
        const last = ticks.get(w.tickKey) || 0;
        const staleFor = Math.round((Date.now() - last) / 60000);
        if (staleFor < w.staleMin) continue;
        const lastAlert = _wdLastAlert.get(w.name) || 0;
        if (Date.now() - lastAlert < 60 * 60 * 1000) continue;
        _wdLastAlert.set(w.name, Date.now());
        console.error(`[V3][watchdog] worker "${w.name}" SEM heartbeat há ${last ? staleFor + 'min' : 'desde o boot'}`);
        // alerta OPERACIONAL no canal admin — deliberado, exento do silent mode
        // (é o vigia denunciando falha do sistema, não a Carolina conversando).
        try {
          await slackSender.postAs({
            channel: adminChannelForOps,
            sender: { name: 'HealthFare Tracker (Vigia)', icon: ':rotating_light:' },
            thread_ts: null, unfurl_links: false, unfurl_media: false,
            text: `:rotating_light: *Worker "${w.name}" parou de rodar* — sem heartbeat ${last ? 'há *' + staleFor + ' min*' : 'desde o último deploy'}.\n` +
              'Isso significa que os avisos automáticos dele (ausência/checkout/EMS) NÃO estão saindo. Checar logs do Railway.',
          });
        } catch (_) {}
        try {
          await _pool.query(`INSERT INTO v3.notifications (type, payload, status) VALUES ('worker_down', $1::jsonb, 'pending')`,
            [JSON.stringify({ worker: w.name, stale_min: last ? staleFor : null, since_boot: !last })]);
        } catch (_) {}
      }
    } catch (e) { console.error('[V3][watchdog] erro:', e.message); }
  }, 10 * 60 * 1000);
  console.log('[V3] watchdog de workers ligado (' + EXPECTED_WORKERS.map((w) => w.name).join(', ') + ')');
  let botUserId = process.env.V3_BOT_USER_ID || null;
  if (!botUserId) {
    try {
      const { WebClient } = require('@slack/web-api');
      const auth = await new WebClient(process.env.SLACK_BOT_TOKEN).auth.test();
      botUserId = auth && auth.user_id;
    } catch (e) {
      console.error('[V3] auth.test falhou (bot_self via cross-ref ainda funciona):', e.message);
    }
  }
  // ── ITEM 1 — MASTER KILL-SWITCH: Carolina NUNCA posta autonomamente ──
  // Default ON (silencioso) enquanto o sistema não está 100% estável. Sobrescreve
  // qualquer worker autônomo. Só posts SÍNCRONOS (disparados por ação do operador,
  // voz "HealthFare Tracker (Sistema)") seguem — esses NÃO passam por aqui.
  const carolinaSilent = process.env.CAROLINA_SILENT_MODE !== 'false';
  async function auditSilentBlocked(worker) {
    try {
      await _pool.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('system', NULL, 'carolina.silent_mode.blocked', 'worker', NULL, $1::jsonb)`,
        [JSON.stringify({ worker, suppressed_at_startup: true })]);
    } catch (e) { /* best-effort */ }
  }
  if (carolinaSilent) console.log('[V3] 🤫 CAROLINA_SILENT_MODE ON — workers autônomos NÃO postam no Slack');

  _observer = new Observer(Object.assign({
    db: _pool, botUserId, mode: 'shadow',
    // Bloco 29/mai-noite #3 — alertas Slack quando worker bate em
    // billing/rate-limit. Default ON em prod. Pode desligar via env
    // WORKER_ALERTS_DISABLED=1. Silenciado também pelo kill-switch Carolina.
    enableWorkerAlerts: process.env.WORKER_ALERTS_DISABLED !== '1' && !carolinaSilent,
    // REVIEW MODE (Bruno 06-22): manda o que interpreta do Slack pro canal admin
    // pra revisar antes de liberar no grupo normal. Liga via OBSERVER_ADMIN_REVIEW=true.
    reviewToAdmin: process.env.OBSERVER_ADMIN_REVIEW === 'true',
    slack: { postAs: slackSender.postAs, addReaction: slackSender.addReaction },
  }, _svc));
  _observer.start(5000);
  console.log('[V3] Observer worker SHADOW ligado (tick 5s, bot=' + (botUserId || '?') + ')');

  // Fase G — alertas proativos (idle/stale/anomaly). Liga via flag E só se NÃO-silent.
  if (process.env.WORKER_PROACTIVE_ALERTS_ENABLED === 'true' && !carolinaSilent) {
    const { ProactiveAlerts } = require('../workers/proactive-alerts');
    new ProactiveAlerts({
      db: _pool, slack: { postAs: slackSender.postAs },
      adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
    }).start(30 * 60 * 1000);
  } else if (process.env.WORKER_PROACTIVE_ALERTS_ENABLED === 'true' && carolinaSilent) {
    auditSilentBlocked('proactive-alerts'); // queria rodar mas o kill-switch barrou
  }

  // Carolina cobra no PRÓXIMO DIA ÚTIL quem esqueceu o checkout (regra Bruno 06-24:
  // chamar a atenção sempre que esquecerem). É um lembrete operacional DELIBERADO —
  // EXENTO do silent mode (ao contrário da conversa autônoma da Carolina). Off por
  // padrão (WORKER_FORGOTTEN_DM_ENABLED) até o Bruno habilitar.
  if (process.env.WORKER_FORGOTTEN_DM_ENABLED === 'true') {
    try {
      const { CarolinaForgottenDM } = require('../workers/carolina-forgotten-dm');
      new CarolinaForgottenDM({
        db: _pool, slack: { postAs: slackSender.postAs, postDm: slackSender.postDm },
        operatorsChannel: productionChannelId, // cobrança aparece NO CANAL DOS OPERADORES
        ordersChannel: process.env.V3_ORDERS_CHANNEL,
        adminChannelId: adminChannelForOps,
        heartbeat: () => beat('forgotten_dm'),
      }).start(10 * 60 * 1000);
    } catch (e) { console.error('[V3] carolina-forgotten-dm não iniciou:', e.message); }
  }

  // FASE 1.5 — action_log APPEND-ONLY: retém 5 dias, limpa 1×/dia (só > 5 dias).
  // NÃO toca registros recentes; é a rede de segurança de investigação.
  setInterval(async () => {
    try {
      const r = await _pool.query("DELETE FROM v3.operator_action_log WHERE created_at < NOW() - INTERVAL '5 days' RETURNING id");
      if (r.rowCount > 0) console.log('[V3] action_log cleanup: ' + r.rowCount + ' registros > 5 dias removidos');
    } catch (e) { console.error('[V3] action_log cleanup erro:', e.message); }
  }, 24 * 60 * 60 * 1000);

  // Item A — sandbox cleanup: HARD-delete dos dados de teste a cada 5s (no-op
  // barato se não houver operador sandbox). Off só via WORKER_SANDBOX_CLEANUP_ENABLED=false.
  if (process.env.WORKER_SANDBOX_CLEANUP_ENABLED !== 'false') {
    const { SandboxCleanup } = require('../workers/sandbox-cleanup');
    new SandboxCleanup({ db: _pool }).start(5000);
    // heartbeat leve (Bruno 07-28): o painel de saúde precisa saber que está vivo.
    setInterval(() => beat('sandbox_cleanup'), 30000); beat('sandbox_cleanup');
  }

  // FASE 2 — EMS activity sync: espelha /line + /pipeline em v3.ems_activity_cache
  // a cada 45s (no-op se EMS sem chave/down). Off via WORKER_EMS_SYNC_ENABLED=false.
  if (process.env.WORKER_EMS_SYNC_ENABLED !== 'false') {
    try {
      const { EmsActivitySync } = require('../workers/ems-activity-sync');
      const { ems } = require('./services/ems-api');
      new EmsActivitySync({ db: _pool, ems, heartbeat: () => beat('ems_sync'),
        slack: { postAs: slackSender.postAs },
        adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1' }).start(45000);
    } catch (e) { console.error('[V3] ems-activity-sync não iniciou:', e.message); }
  }

  // CENTRO DE ESTOQUE (Bruno 08-01) — Fase A, OPT-IN (só liga com env=true;
  // as tabelas 058/059/060 precisam existir antes). Zero-disrupção: nada aqui
  // toca operador; alertas vão pro canal do env (sandbox em teste, admin-orin
  // em produção). Dedução default 'dry' (shadow) até o launch.
  if (process.env.WORKER_VEEQO_ORDERS_ENABLED === 'true') {
    try {
      const { VeeqoOrderSync } = require('../workers/veeqo-order-sync');
      const { veeqo } = require('./services/veeqo-api');
      const { StockService } = require('./services/StockService');
      const stockSvc = new StockService({
        db: _pool,
        onDiscrepancy: async (d) => {
          try {
            await _pool.query(
              `INSERT INTO v3.data_incidents (kind, severity, title, explanation, product_id, amount, where_json)
               VALUES ($1, 'warning', $2, $3, $4, $5, $6::jsonb)`,
              ['stock_' + (d.kind || 'desync'), 'Estoque: ' + (d.kind || 'divergência'),
                d.note || 'divergência de estoque', d.product_id || null,
                d.wanted != null ? d.wanted : null,
                JSON.stringify({ bin_id: d.bin_id || null, box_id: d.box_id || null, applied: d.applied != null ? d.applied : null })]);
          } catch (e) { console.error('[stock] incidente falhou:', e.message); }
        },
      });
      new VeeqoOrderSync({ db: _pool, veeqo, stock: stockSvc,
        heartbeat: () => beat('veeqo_orders') }).start(5 * 60 * 1000);
    } catch (e) { console.error('[V3] veeqo-order-sync não iniciou:', e.message); }
  }
  if (process.env.WORKER_STOCK_ALERTS_ENABLED === 'true') {
    try {
      const { StockAlerts } = require('../workers/stock-alerts');
      const { veeqo } = require('./services/veeqo-api');
      new StockAlerts({ db: _pool, veeqo, slack: { postAs: slackSender.postAs },
        channelId: process.env.STOCK_ALERTS_CHANNEL || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        heartbeat: () => beat('stock_alerts') }).start(30 * 60 * 1000);
    } catch (e) { console.error('[V3] stock-alerts não iniciou:', e.message); }
  }
  // Divergência de estoque vs Veeqo (S15 Fase 3, Bruno 08-18): reconciliação
  // CONTÍNUA a cada 10min. Chama computeDrift do warehouse router DIRETO (mesma
  // conta do hub, sem HTTP). Divergência nova → admin-orin (1×/produto/dia); 8h NY
  // → resumo. NUNCA sobrescreve estoque. OPT-IN: WORKER_STOCK_DRIFT_ENABLED=true.
  if (process.env.WORKER_STOCK_DRIFT_ENABLED === 'true') {
    try {
      const { StockDriftAlert } = require('../workers/stock-drift-alert');
      const { computeDrift } = require('./warehouse/router');
      const { createVeeqoCache } = require('./warehouse/veeqo-cache');
      const { StockService: DriftStockService } = require('./services/StockService');
      const { veeqo: driftVeeqo } = require('./services/veeqo-api');
      const driftCache = createVeeqoCache({ veeqo: driftVeeqo });
      const driftStock = new DriftStockService({ db: _pool });   // só LEITURA (overview)
      new StockDriftAlert({
        db: _pool, slack: { postAs: slackSender.postAs },
        channelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        getDrift: () => computeDrift({ stock: driftStock, veeqoCache: driftCache }),
        heartbeat: () => beat('stock_drift'),
      }).start(10 * 60 * 1000);
    } catch (e) { console.error('[V3] stock-drift-alert não iniciou:', e.message); }
  }

  // Mergeable orders (Bruno 08-02): de manhã, lista no admin-orin os pedidos da
  // Veeqo que precisam ser mergeados (mesmo comprador+endereço via mergeable_id
  // nativo). READ-ONLY. OPT-IN: WORKER_MERGEABLE_ALERT_ENABLED=true.
  if (process.env.WORKER_MERGEABLE_ALERT_ENABLED === 'true') {
    try {
      const { VeeqoMergeableAlert } = require('../workers/veeqo-mergeable-alert');
      const { veeqo } = require('./services/veeqo-api');
      new VeeqoMergeableAlert({ db: _pool, veeqo, slack: { postAs: slackSender.postAs },
        channelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        heartbeat: () => beat('mergeable_alert') }).start(30 * 60 * 1000);
    } catch (e) { console.error('[V3] veeqo-mergeable-alert não iniciou:', e.message); }
  }

  // Divergência de impressão (Bruno 08-06): 12pm NY compara (1ª+2ª impressão
  // digitadas) vs Veeqo impresso; divergiu → pergunta pra Simone no
  // #orders-and-inventory citando SÓ a diferença; grava a resposta da thread.
  if (process.env.WORKER_PRINT_DIVERGENCE_ENABLED === 'true') {
    try {
      const { PrintDivergenceWatchdog } = require('../workers/print-divergence-watchdog');
      const { veeqo } = require('./services/veeqo-api');
      const { WebClient: _WC } = require('@slack/web-api');
      new PrintDivergenceWatchdog({
        db: _pool, veeqo, slack: { postAs: slackSender.postAs },
        slackWeb: process.env.SLACK_BOT_TOKEN ? new _WC(process.env.SLACK_BOT_TOKEN) : null,
        channelId: process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK',
        heartbeat: () => beat('print_divergence'),
      }).start(15 * 60 * 1000);
    } catch (e) { console.error('[V3] print-divergence-watchdog não iniciou:', e.message); }
  }

  // Falta de estoque pro P&P (Bruno 08-06): 10min após iniciar a impressão avisa
  // admin-orin + orders-and-inventory; e todo dia 8h NY manda o resumo no admin-orin.
  if (process.env.WORKER_STOCK_GAP_ALERT_ENABLED === 'true') {
    try {
      const { StockGapAlert } = require('../workers/stock-gap-alert');
      new StockGapAlert({
        db: _pool, slack: { postAs: slackSender.postAs },
        adminChannel: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        opsChannel: process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK',
        getGaps: async () => {
          const { ENDPOINTS, buildServices } = require('./data/router');
          const ep = ENDPOINTS.find((e) => e.path === '/api/v3/data/stock-gaps');
          const out = await ep.handler({ query: {}, params: {} }, {}, buildServices(_pool));
          return out.data;
        },
        heartbeat: () => beat('stock_gap_alert'),
      }).start(5 * 60 * 1000);
    } catch (e) { console.error('[V3] stock-gap-alert não iniciou:', e.message); }
  }

  // SKU incomum na fila de P&P (Bruno 08-06): FBA/WFS ou sem mapa → avisa admin-orin
  // (SEM tirar da picklist — regra: imprimimos TUDO do HealthFare Warehouse).
  if (process.env.WORKER_UNUSUAL_SKU_ENABLED === 'true') {
    try {
      const { UnusualSkuWatch } = require('../workers/unusual-sku-watch');
      new UnusualSkuWatch({ db: _pool, slack: { postAs: slackSender.postAs },
        channelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        heartbeat: () => beat('unusual_sku') }).start(15 * 60 * 1000);
    } catch (e) { console.error('[V3] unusual-sku-watch não iniciou:', e.message); }
  }

  // Duplicatas de envio (Bruno 08-03): rede de segurança PÓS-envio. À tarde, detecta
  // no admin-orin clientes (MESMO nome+endereço+dia) que saíram em CAIXAS SEPARADAS
  // (2+ trackings, sem merge) — base pra claim de reembolso. Mesmo gate anti-despachante
  // do merge-alert (nome exato; nunca mergeable_id). OPT-IN: WORKER_DUP_SHIPMENT_ENABLED=true.
  if (process.env.WORKER_DUP_SHIPMENT_ENABLED === 'true') {
    try {
      const { VeeqoDupShipmentDetector } = require('../workers/veeqo-dup-shipment-detector');
      const { veeqo } = require('./services/veeqo-api');
      new VeeqoDupShipmentDetector({ db: _pool, veeqo, slack: { postAs: slackSender.postAs },
        channelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        heartbeat: () => beat('dup_shipment') }).start(60 * 60 * 1000);
    } catch (e) { console.error('[V3] veeqo-dup-shipment-detector não iniciou:', e.message); }
  }

  // Relógio de ponto NGTeco (Bruno 07-22): punches → att_punch/att_state; chegada/
  // saída → admin-orin; volta do almoço fecha o almoço; nudges. No-op sem creds
  // (NGTECO_USER/PASS). Off via WORKER_ATTENDANCE_ENABLED=false.
  if (process.env.WORKER_ATTENDANCE_ENABLED !== 'false') {
    try {
      const { AttendanceSync } = require('../workers/attendance-sync');
      const ngteco = require('./services/ngteco');
      const attAlertGate = require('./alert-gate');
      new AttendanceSync({ db: _pool, ngteco, heartbeat: () => beat('attendance'),
        slack: { postAs: slackSender.postAs }, alertGate: { isMuted: (db) => attAlertGate.isMuted(db) },
        adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        operatorChannelId: process.env.V3_PRODUCTION_CHANNEL || 'C09UNBXFRKK' }).start(60000);
    } catch (e) { console.error('[V3] attendance-sync não iniciou:', e.message); }
  }

  // PRODUCTION TOTAL WORKER (Bruno 07-27): a linha de produção SEMPRE tem que
  // terminar com um total. Fechou sem número → o sistema conversa com o operador
  // no Slack até ter o total OU escalar pro admin. Off via WORKER_TOTAL_ENABLED=false.
  if (process.env.WORKER_TOTAL_ENABLED !== 'false') {
    try {
      const { ProductionTotalWorker } = require('../workers/production-total-worker');
      const totalAlertGate = require('./alert-gate');
      // provider + recordTotal são criados AQUI (escopo do startWorker): o `provider`
      // do _init() e o `recordTotal` do mount() NÃO alcançam este escopo.
      const GeminiProvider = require('./llm/providers/GeminiProvider');
      const totalProvider = new GeminiProvider({});
      const totalCountSvc = new ProductionCountService({ db: _pool });
      const recordTotalWk = async ({ followup, bottles, via, byPersonId }) => {
        if (!followup.product_id) return;
        const pd = (await _pool.query(
          `SELECT (started_at AT TIME ZONE 'America/New_York')::date::text d FROM v3.events WHERE id=$1`, [followup.event_id])).rows[0];
        await totalCountSvc.record({
          product_id: followup.product_id, product_batch_id: null, bottles,
          reported_by_person_id: byPersonId || followup.person_id,
          production_date: (pd && pd.d) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
          source_event_id: followup.event_id,
          actor_type: via === 'admin_dashboard' ? 'admin' : 'operator',
          confidence: 'high', notes: 'total via followup (' + (via || '?') + ')',
        });
      };
      new ProductionTotalWorker({
        db: _pool,
        slack: { postAs: slackSender.postAs },
        botToken: process.env.SLACK_BOT_TOKEN || null,
        provider: totalProvider,
        productionChannel: productionChannelId,
        adminChannel: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
        alertGate: { isMuted: (db) => totalAlertGate.isMuted(db) },
        recordTotal: recordTotalWk,
        heartbeat: () => beat('total'),
      }).start(30000);
      console.log('[V3] production-total-worker ligado (tick 30s)');
    } catch (e) { console.error('[V3] production-total-worker não iniciou:', e.message); }
  }

  // Absence alert: operador logado sem função (foreground) há > 15min → avisa no
  // grupo dos operadores (#orders-and-inventory). Gated por ABSENCE_ALERT_ENABLED.
  try {
    const { AbsenceAlert } = require('../workers/absence-alert');
    new AbsenceAlert({ db: _pool, slack: { postAs: slackSender.postAs, postDm: slackSender.postDm }, channelId: productionChannelId, heartbeat: () => beat('absence') }).start(5 * 60 * 1000);
  } catch (e) { console.error('[V3] absence-alert não iniciou:', e.message); }

  // Encap monitor (Bruno 07-02): encapsulação parada ≥1h entre 8h–20h em dia ativo
  // → alerta o grupo dos operadores e REPETE por hora, com o total parado do dia.
  // É emergência operacional → sempre ON (desliga só via ENCAP_MONITOR_ENABLED=false).
  try {
    const { EncapMonitor } = require('../workers/encap-monitor');
    new EncapMonitor({ db: _pool, slack: { postAs: slackSender.postAs }, channelId: productionChannelId, adminChannelId: (process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1'), heartbeat: () => beat('encap') }).start(10 * 60 * 1000);
  } catch (e) { console.error('[V3] encap-monitor não iniciou:', e.message); }

  // Fase 5 — refresh da matview de métricas a cada 10min (best-effort).
  setInterval(async () => {
    try { await _pool.query('SELECT v3.refresh_events_enriched()'); }
    catch (e) { console.error('[V3] refresh events_enriched erro:', e.message); }
  }, 10 * 60 * 1000);

  // Fase D — session cleanup: fecha operator_sessions ociosas >8h (hard limit),
  // 1×/h. Não derruba sessões legítimas (last_activity < 8h). Loga quantas.
  setInterval(async () => {
    try {
      const r = await _pool.query(
        `UPDATE v3.operator_sessions
         SET logged_out_at = NOW(), logoff_reason = 'session_expired_cleanup'
         WHERE logged_out_at IS NULL AND last_activity_at < NOW() - INTERVAL '8 hours'
         RETURNING id`);
      if (r.rowCount > 0) {
        await _pool.query(
          `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
           VALUES ('system', NULL, 'session_cleanup', 'api', NULL, $1::jsonb)`,
          [JSON.stringify({ closed: r.rowCount })]);
        console.log('[V3] session cleanup: ' + r.rowCount + ' sessões ociosas fechadas');
      }
    } catch (e) { console.error('[V3] session cleanup erro:', e.message); }
  }, 60 * 60 * 1000);

  // Bloco 30/mai-noite — cron de expiração de pending_commands.
  // Roda a cada 60s; marca status='expired' os com expires_at < NOW()
  // e posta timeout reply na thread. Pode desligar via env.
  // Deploy 3 — dedupe watcher (Slack ↔ Operator Page). Liga só com a flag.
  if (process.env.WORKER_DEDUPE_ENABLED === 'true') {
    const { DedupeWatcher } = require('../workers/dedupe-watcher');
    const watcher = new DedupeWatcher({
      db: _pool,
      slack: { postAs: slackSender.postAs },
      adminChannelId: process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
      // kill-switch Carolina força inbox-only (sem Slack); captura info, não spamma
      silentMode: carolinaSilent || (process.env.WORKER_DEDUPE_NOTIFICATIONS_SILENT_MODE === 'true'),
    });
    watcher.start(60 * 1000);
    setInterval(() => beat('dedupe'), 60000); beat('dedupe');   // heartbeat (Bruno 07-28)
  }

  if (process.env.V3_PENDING_COMMANDS_CRON_DISABLED !== '1') {
    setInterval(async () => {
      try {
        beat('pending_commands');   // heartbeat (Bruno 07-28)
        const n = await _svc.commandHandler.expireOldPending();
        if (n > 0) console.log(`[V3] pending_commands cron: ${n} comandos expirados`);
      } catch (e) {
        console.error('[V3] pending_commands cron erro:', e.message);
      }
    }, 60 * 1000);
    console.log('[V3] pending_commands cron ligado (tick 60s)');
  }
}

module.exports = { mount, startWorker, getObserver: () => _observer, getPool: () => _pool };
