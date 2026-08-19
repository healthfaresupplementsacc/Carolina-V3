# RELATIONSHIPS — traced connections between elements

Each edge is numbered (stable). Direction is `FROM → TO` as evidenced. Types:
**VERIFIED** (traced in code) · **PARTIAL** (one side traced) · **INDIRECT** (via an intermediary) ·
**SHARED-DEP** (both use the same thing) · **AMBIGUOUS** · **DUPLICATE-PATH** (two paths do the same job) ·
**DISCONNECTED** (expected edge does NOT exist).

IDs refer to `STRUCTURE_INDEX.md`. Mermaid uses the same R-ids as edge labels where space allows.

## Boot / hosting
| R | From → To | Type | Evidence |
|---|---|---|---|
| R001 | S01.01 → S01.01.01…S01.01.12 (sequence) | VERIFIED | `src/index.js:66-181` |
| R002 | S01.01.11 → S04.* (starts every worker/timer) | VERIFIED | `index.js:164` → `wire.js:250-633` |
| R003 | S01.01.09 → S04.28.* (starts 7 legacy crons unless `V2_DISABLED=1`) | VERIFIED | `index.js:136-154`; `scheduler.js` |
| R004 | S01.03 (`wire.mount`) → S02.04–S02.15 | VERIFIED | `index.js:51`; `wire.js:96-232` |
| R005 | S01.02 → S02.* (global middleware precedes all routers) | VERIFIED | `index.js:24-42` |
| R006 | S01.05 (Dockerfile) → S07.07 screenshot (Chromium for Puppeteer) | VERIFIED | `Dockerfile`; `src/screenshot.js:26` |
| R007 | S10.10 Railway healthcheck → S01.06 `/api/health` | VERIFIED | `railway.toml` |
| R008 | S01.07 SIGTERM → closes S08.04 only; S08.03 NOT closed | DISCONNECTED | `index.js:184-194` |

## HTTP ingress → backend
| R | From → To | Type | Evidence |
|---|---|---|---|
| R010 | S10.01 Slack → S02.01 (`/slack/events`) → S07.01 interactive/home/dm | VERIFIED | `events.js:67-125` |
| R011 | S10.01 Slack → S02.04 (`/slack/events-v2`) → `v3.messages` → S04.02 Observer | VERIFIED | `events-v2.js:283-287`; `Observer.js:810` |
| R012 | S02.04 → S06.13 CommandHandler (mentions, ✅ confirm) | VERIFIED | `events-v2.js:150-156,235` |
| R013 | S02.04 → S06.15 NotificationHandler (reactions) | VERIFIED | `events-v2.js:143-147` |
| R014 | S02.04 → S04.30 alert-gate (mute/unmute commands, no LLM) | VERIFIED | `events-v2.js:201-234` |
| R015 | S02.04 → S05.01 EventService.softDelete on `message_deleted` | VERIFIED | `events-v2.js:257-268` |
| R016 | S04.28.01 poller AND S02.04 webhook both read production channel | DUPLICATE-PATH | poller writes `public.messages`; webhook writes `v3.messages` |
| R017 | S03.01 dashboard-v4 → S02.10 `/api/v3/data` | VERIFIED | `adapters/from-api.js:11` |
| R018 | S03.01 → S02.09 `/api/adminpanel` | VERIFIED | `adapters/admin-api.js:15` |
| R019 | S03.01.02 → S02.12 `/api/cam` | VERIFIED | `CamerasPage.jsx` |
| R020 | S03.01.03 → S02.10.04 SSE ← S09.06 print-stream ← S02.08.03 | VERIFIED | `router.js:1741`; `print-stream.js:21`; `op.js:584` |
| R021 | S03.02 /op → S02.08.02 `/api/v3/op/*` | VERIFIED | `src/op/app.js` fetches |
| R022 | S03.02 → S02.07 `/api/v3/architect/person/` (operator token scope) | VERIFIED | `app.js`; `architect.js:122-143` |
| R023 | S03.02, S03.04, S11.01.03 → S02.08.01 `/op/config.js` (page token) | VERIFIED | `op.js:89`; `print/index.html:29`; `printlock.py:155` |
| R024 | S03.04 /print → S02.08.02 (`auth/login`, `event/start`) + S02.08.04 | VERIFIED | `print.js` |
| R025 | S11.01 .28 → S02.08.03 (`/api/print-*`, `PRINT_EVENT_TOKEN`) | VERIFIED | `printlock.py:22`; `op.js:418-691` |
| R026 | S03.03 /admin → S02.09 only | VERIFIED | `src/admin/app.js` (~50 endpoints) |
| R027 | S03.05 legacy pages → S02.02, S02.03 (`/api/admin/*?pin=`) | VERIFIED | `dashboard/router.js:231` |
| R028 | S03.07 /foto → S02.11 → S10.01 `#images` | VERIFIED | `foto/index.html:179`; `images/router.js` |
| R029 | S03.08 cameras pages → S02.12 → S10.08 (Tailscale) | VERIFIED | `cameras.js:302-355` |
| R030 | S02.14 `GET /` shadows S02.13 `/` | VERIFIED | `index.js:57` vs `dashboard/router.js:24` |
| R031 | S02.15.05 `/admin` SPA shadows S02.13 `/admin`, `/admin/audit` | VERIFIED | `wire.js:174` vs `router.js:86,424` |
| R032 | S02.15.06 `/dashboard` → S03.06 (dir missing) | DISCONNECTED | `wire.js:206`; `ls public/` |
| R033 | S02.16 createRouter → (nothing) | DISCONNECTED | only tests import it |
| R034 | S02.06 admin-v3 → S02.10.03 `buildRepos` | VERIFIED | `admin-v3/routes.js:20` |
| R035 | S02.05 security middleware → S02.08, S02.09, S02.07, S03.02, S03.03 prefixes only | VERIFIED | `wire.js:116-128` |
| R036 | S02.05 ✗ S02.10, S03.01, S02.12, S02.02 (not covered) | DISCONNECTED | `security.js:5-7` |
| R037 | S02.12 own brute-force guard ↔ S02.05 guard share `v3.blocked_ips` only | SHARED-DEP | `cameras.js:76`; `wire.js:120` |

## Workers → data / services / external
| R | From → To | Type | Evidence |
|---|---|---|---|
| R040 | S04.02 Observer → S06.01 provider → S10.05 Gemini | VERIFIED | `wire.js:42,334` |
| R041 | S04.02 → S05.01/S05.02/S05.03/S05.04 (writes) | VERIFIED | `Observer.js` dispatch |
| R042 | S04.02 → `v3.llm_metrics`, `v3.vocabulary`, `v3.notifications`, `v3.settings` | VERIFIED | `Observer.js:554,496,662,761` |
| R043 | S04.07 ems-sync → S05.15 → S10.02 EMS | VERIFIED | `wire.js:389` |
| R044 | S04.07 → `v3.events`, `v3.ems_activity_cache`, `v3.persons`, `v3.products`, `v3.product_batches` | VERIFIED | `ems-activity-sync.js:190-458` |
| R045 | S04.07 → S09.01 presence, S09.05 ems-confirm | VERIFIED | requires |
| R046 | S04.08 veeqo-order-sync → S05.16 → S10.03; → S05.08 StockService | VERIFIED | `wire.js:400-422` |
| R047 | S04.09/S04.10/S04.11/S04.14 → S05.16 Veeqo | VERIFIED | `wire.js:426,438,451,500` |
| R048 | S04.12 stock-gap-alert → S02.10.02 ENDPOINTS handler in-process → S05.13 | VERIFIED | `wire.js:471-476` |
| R049 | S04.15 attendance-sync → S05.17 → S10.04 NGTeco | VERIFIED | `wire.js:513` |
| R050 | S04.15 → `v3.att_punch/att_state` (no migration) | PARTIAL | S08.06 |
| R051 | S04.16 total-worker → own GeminiProvider (bypass QuotaChain) → S05.03 | VERIFIED | `wire.js:531-546` |
| R052 | S04.25 note-analyzer → own GeminiProvider; triggered by S02.08 | VERIFIED | `wire.js:145`; `op.js:1778,2890` |
| R053 | S04.17 absence-alert → S09.01, S09.03, S04.30; writes sessions/action_log/notifications | VERIFIED | `absence-alert.js:11-13,146-182` |
| R054 | S04.18 encap-monitor → S09.03, S04.30 | VERIFIED | requires |
| R055 | S04.01 watchdog ← S04.29 registry (watch list) | VERIFIED | `wire.js:261` |
| R056 | S04.29 registry ↔ reality (intervals, missing entries) | AMBIGUOUS | see U-05 |
| R057 | S04.06 sandbox-cleanup heartbeat decoupled from tick | AMBIGUOUS | `wire.js:381` |
| R058 | S04.21 dedupe heartbeat decoupled | AMBIGUOUS | `wire.js:616` |
| R059 | S04.19 → S08.08 matview refresh | VERIFIED | `wire.js:578` |
| R060 | S04.22 → S06.13 `expireOldPending` | VERIFIED | `wire.js:620-628` |
| R061 | S04.23 ← S05.03 (incident callback) → S10.01 admin | VERIFIED | `wire.js:62-81` |
| R062 | S04.31 CAROLINA_SILENT_MODE gates S04.02 alerts, S04.03, S04.21 only | VERIFIED | `wire.js:329,339,613` |
| R063 | S04.30 alert-gate used by S02.08, S02.04, S04.15, S04.17, S04.18, S04.11, S04.12 | SHARED-DEP | grep |
| R064 | S04.28.02 EOD → S03.05 `/eod-summary` (Puppeteer) → S10.01 image | VERIFIED | `scheduler.js:230-335` |
| R065 | S04.28.06 detect → S07.05 ai/detect → `public.carolina_proposals` | VERIFIED | `scheduler.js:159` |
| R066 | S04.28.03 daily cleanup → `scripts/` (cleanup-ghost-workflows, expire-helpers) | VERIFIED | `scheduler.js:209,216` |
| R067 | All S04.* Slack egress → S06.17 sender → S10.01 | VERIFIED | `wire.js` deps |

## Services ↔ data
| R | From → To | Type | Evidence |
|---|---|---|---|
| R070 | S05.01 → `v3.events` (claimed sole gate) | VERIFIED | `EventService.js:5-21` |
| R071 | S02.08 op.js raw SQL → `v3.events.ended_at` (unguarded :1662,1669,1680; TOCTOU :1395,1419,1519) | VERIFIED | grep + read | 
| R072 | S02.09 admin.js → `v3.events`, `v3.production_counts` raw | VERIFIED | `admin.js:1013` |
| R073 | S06.13 CommandHandler → `v3.events` raw | VERIFIED | `CommandHandler.js` |
| R074 | R070+R071+R072+R073 = multiple writers to one table | DUPLICATE-PATH | ARCHITECTURE.md BROKEN LINKS Claim 1 |
| R075 | S05.03 + S02.08 (×4) + S02.09 → `v3.production_counts` (6 writers) | DUPLICATE-PATH | Claim 2 |
| R076 | ~~S05.08 StockService + S02.08 raw INSERT (`op.js:324`) → `v3.stock_movements`~~ **RESOLVED 08-18 (Phase 2): raw INSERT removed; `stock/take` now creates a request via `op-stock.js` → StockRequestService; StockService is the only writer again** | RESOLVED | `op.js` grep = none |
| R077 | S05.09 `consumeForSize` ← (no production caller) | DISCONNECTED | Claim 4 |
| R078 | S02.08 `orders` count (`production_counts kind='orders'`) vs S04.08 `v3.pnp_order_lines` (Veeqo mirror), reconciled by S04.11 at noon | DUPLICATE-PATH | Claim 5 |
| R079 | S05.02 → `v3.product_batches`, `events.product_batch_id` | VERIFIED | `BatchService.js:159,195` |
| R080 | S02.10.03 sender-profiles-repo → `v3.sender_profiles` (write from read layer) | VERIFIED | `sender-profiles-repo.js` |
| R081 | S05.12 → S06.17 (audited post) | VERIFIED | `SenderService.js` |
| R082 | S07.08 legacy migrate() → S08.07 27 tables (every boot) | VERIFIED | `db/index.js:32-657` |
| R083 | S07.03 dispatcher + S07.04 engine → ISA-88 `public.*` tables | VERIFIED | `engine.js:283,520` |
| R084 | S08.07 `public.production_counts`/`messages` vs S08.05 v3 same names | AMBIGUOUS | name collision |
| R085 | S08.02 migrations ← (no runner in `src/`); applied via `scripts/` | DISCONNECTED | grep "migrations" in src |
| R086 | S08.06 tables ← `scripts/create-*.js` only; 2 tables no DDL anywhere | PARTIAL | agent §A.3 |
| R087 | S02.10 data-router → S05.* via `buildServices` | VERIFIED | `router.js:387-411` |
| R088 | S11.04 context.js → S02.10.03 repos (imports backend code) | VERIFIED | `context.js:22-25` |

## Legacy V2 internal
| R | From → To | Type | Evidence |
|---|---|---|---|
| R090 | S07.01 interactive → S07.02 parser → S07.03 dispatcher → S07.04 engine | VERIFIED | `interactive.js:68,160-161`; `canonical-dispatcher.js:29` |
| R091 | S07.01 dm-handler/admin-chat → S07.05 admin-tools → S07.03 | VERIFIED | `dm-handler.js:638`; `admin-chat.js:128`; `admin-tools.js:708` |
| R092 | S07.06 scheduler → S07.01 poller, S07.07 eod/urgency, S07.05 detect, S07.04 activity-freshness | VERIFIED | `scheduler.js` |
| R093 | S07.07 app-state ← 13 requirers (S02.02, S07.06, S07.05, S07.01…) | SHARED-DEP | grep |
| R094 | S07.05 note-classifier → S10.07 Anthropic (`AI_NOTE_CLASSIFIER_ENABLED`) | PARTIAL | `note-classifier.js:56` |
| R095 | S07.09 master doc → S13.01 smoke.e2e | VERIFIED | `smoke.e2e.test.js:4` |

## Satellites / external
| R | From → To | Type | Evidence |
|---|---|---|---|
| R100 | S11.03 drift task → `claude -p` → `docs/DRIFT-*.md` → `post-drift-to-slack.js` → S10.01 DM Bruno | VERIFIED | `drift-check.ps1`; verified 08-11 run |
| R101 | S11.04 watch.js → S10.01 (read) → Claude Code → reply.js → S10.01 | VERIFIED | `watch.js`, `reply.js` |
| R102 | S11.01.02 epson_status → EPSON CW-C8000u USB → S02.08.03 `/api/printer-status` | VERIFIED | `epson_status.py:6-21` |
| R103 | S11.05 Simone .246 → (nothing in code) | UNKNOWN | U-02 |
| R104 | S11.02 cameras PC → S10.08 Tailscale → S02.12 | PARTIAL | gateway code out of repo |
| R105 | S02.12 → S09.03 workday (weekend on-demand) | VERIFIED | `cameras.js:60-74` |
| R106 | S06.05 Anthropic ← `LLM_PROVIDER=anthropic` only | PARTIAL | `LLMProvider.js:137` |
| R107 | S06.09 FallbackProvider, S06.06 OpenAIProvider ← nothing | DISCONNECTED | grep |
| R108 | S09.11 audit.js/idempotency.js stubs ← nothing | DISCONNECTED | files empty |
| R109 | S13.03 compute-task-targets ← manual only → `analysis_output.json` → `scripts/v3-seed-task-targets.js` | PARTIAL | header comment |
| R110 | S14.03 foto-link.txt token == S12.08 | VERIFIED | value matches env name |
| R111 | S13.02 drift test guards ARCHITECTURE.md but not map set (docs/architecture) | DISCONNECTED | test reads only ARCHITECTURE.md |

## Duplicate / overlapping surfaces (feeds GENERATIONS.md)
| R | From ↔ To | Type | Evidence |
|---|---|---|---|
| R120 | S03.01.06 (dashboard-v4 admin pages) ↔ S03.03 (/admin SPA) both on S02.09 | DUPLICATE-PATH | same API, two UIs |
| R121 | S03.05 legacy pages ↔ S03.01 (metas/producao/operator) | DUPLICATE-PATH | root redirect made v4 canonical |
| R122 | S03.10 admin-v3 shadow pages ↔ S03.01.06 SystemHealth/messages views | DUPLICATE-PATH | inspection surface predates v4 |
| R123 | S07 (Carolina V2 crons/poller/parser) ↔ S06 (Carolina V3 Observer/CommandHandler) | DUPLICATE-PATH | two ingestion + two write models |
| R124 | S03.02.04 op .legacy ↔ S03.02 | DUPLICATE-PATH | dead copy |
| R125 | S06.02 GeminiProvider ×3 instantiations | DUPLICATE-PATH | `wire.js:42,145,532` |
| R126 | S12.01 ↔ S12.02 ↔ S12.03 three PIN systems | DUPLICATE-PATH | agent §E.7 |
| R127 | S03.01.04 inventory pages ↔ S02.08 `/op` stock endpoints (`STOCK_UI_ENABLED`) ↔ S05.08 | SHARED-DEP | two UIs, one service (plus one raw path R076) |

## Added / corrected by the 2nd (completeness) pass
| R | From → To | Type | Evidence |
|---|---|---|---|
| R003 (corrected) | S01.01.09 → 5 start calls (`startPolling`, `startEodJob`, `startGreetingJob`, `startDetectJob`, `startActivityCheckJob`); 7 cron tasks result because `startEodJob()` registers 2 more inside (`scheduler.js:75,83`) | VERIFIED | `index.js:141-154`; `scheduler.js:70-87` |
| R067 (corrected) | NOT all worker egress goes through S06.17: S04.16 production-total-worker calls `https://slack.com` with raw `fetch` | VERIFIED | `production-total-worker.js:59` |
| R128 | S03.01.12 CameraGrid → S03.08 (`window.open('/cameras/pip?cam=…#t=<token>')`, `href="/cameras"`) — token in URL fragment | VERIFIED | `CameraGrid.jsx:195,501` |
| R129 | S03.01 Shell/App → S03.02 (`href="/op/"`) | VERIFIED | `Shell.jsx:205`; `App.jsx:129` |
| R130 | S03.01.03 PrintingPage → S02.10.04 via `EventSource('/api/v3/data/print-stream?pin=…')` — dashboard-v4 is the party putting the PIN in the URL | VERIFIED | `PrintingPage.jsx:98` |
| R131 | S03.02 → S02.15.03 (`fetch('/op/products.json')`; `/op/assets/bottles/<slug>.png` built at runtime) | VERIFIED | `src/op/app.js`; `src/op/products.json` |
| R132 | S03.04 → S02.15.03 (`/op/style.css`, `/op/assets/healthfare-logo.png`) + S02.15.02 (`/shared/hf-design.css`) | VERIFIED | `src/print/index.html:11-13` |
| R133 | S09.05 ems-confirm → S09.01 presence (`hasManualCheckinToday`, `EDT`) | VERIFIED | `ems-confirm.js:28` |
| R134 | S02.12 cameras.js → S01.03 `require('../v3/wire')` — a router reaching back into the hub (**circular**) | VERIFIED | `cameras.js:46` |
| R135 | S02.12 cameras.js → S06.17 sender (posts to Slack, try/catch) | VERIFIED | `cameras.js:53` |
| R136 | S02.10 data/router.js → S04.09 `require('../../workers/stock-alerts')` — router imports a WORKER (inverted layering; used as calc lib) | VERIFIED | `data/router.js:39,408` |
| R137 | S02.02 api.js → S04.28 (`rescheduleJobs()`, `runEod`) — legacy HTTP mutates cron schedules at runtime | VERIFIED | `api.js:316,954` |
| R138 | S02.02 api.js → S07.01 admin-chat | VERIFIED | `api.js:2077,2108` |
| R139 | S02.02 `POST /api/backfill` (unauth, S12.12) → S04.28.01 poller | VERIFIED | `api.js:415` |
| R140 | S02.09 admin.js ✗ S05.* — admin.js requires ZERO V3 services (only `lib/op-auth`, `middleware/security`); it is a pure raw-SQL surface | DISCONNECTED | `admin.js:27-28` |
| R141 | S04.16 → S10.01 direct (`fetch https://slack.com/…`), bypassing S06.17 | VERIFIED | `production-total-worker.js:59` |
| R142 | S04.04 forgotten-dm gets a THIRD channel `ordersChannel = V3_ORDERS_CHANNEL` with NO default (undefined if unset → silent fail) | VERIFIED | `wire.js:359` |
| R143 | S02.08 op.js posts to production channel via its OWN env read (`V3_PRODUCTION_CHANNEL ‖ 'C09UNBXFRKK'`) — wire passes only `adminChannelId` | VERIFIED | `wire.js:149-155`; `op.js:49,51,1100,1935,1951,2832` |
| R144 | S02.10 data router → S06.17 (`postAs` admin) — 2 call sites | VERIFIED | `data/router.js:1870-1875,1920-1923` |
| R145 | S02.09 admin.js → S06.17 → S10.01 (admin ch `:559`; production ch via own env `:1020-1026`) | VERIFIED | `wire.js:166-170`; `admin.js:559,1023` |
| R146 | S01.03 wire → S02.08, S02.10 via **DI closure `recordTotal`** over one `ProductionCountService` (the "one write path" mechanism; invisible to require-graphs) | VERIFIED | `wire.js:181-200` |
| R147 | Writer edges previously missing: S02.08 → `op_notes` (:2888), `voice_recordings` (:3109,3121), `machine_custody` (:1340-1558), `activity_gaps` (:2874), `daily_totals_log` (:2812); S02.09 → `voice_recordings` (:865), `task_targets` (:1369); S02.10 → `envelope_mix` (:1180), `packing_questions` UPDATE-only (:1196) | VERIFIED | as cited |
| R148 | NO writer in `src/` → ORPHANED tables: `admin_chats`, `carolina_personalities/config/channel_personality/prompt_versions/signals/learning_cycles`, `raw_material_coas`; `product_catalog` populated only by `scripts/import-supplement-catalog.js` | DISCONNECTED | grep |
| R149 | S02.04 → S02.04.01 saturday_idle_check → writes `v3.operator_sessions`; S02.04 → S02.04.02 noclockin_ask (owner/manager only) — evaluated BEFORE S06.15 | VERIFIED | `events-v2.js:80-120` |
| R150 | S03.01.17 dashboard-v4 `.cjs` utils ← S13.01 backend Jest (`v4-day-stats.test.js:17`) — cross-boundary test dependency | VERIFIED | as cited |
| R151 | S09.02 alert-gate is required TWICE by wire under two aliases (`attAlertGate` :514, `totalAlertGate` :528) | SHARED-DEP | `wire.js:514,528` |
| R152 | S02.07.02 architect-audit writes AFTER `res.on('finish')` (fire-and-forget) | PARTIAL | `architect-audit.js:24` |

## Added 2026-08-18 (Warehouse hub, Phase 1 build)
| R | From → To | Type | Evidence |
|---|---|---|---|
| R160 | S01.03 wire → S15.17 warehouse router (mount) with StockService + StockRequestService instances | VERIFIED | `wire.js:206-228` |
| R161 | S03.01 WarehousePage/Approvals/Locations → S15.17 `/api/v3/warehouse/*` (adapter warehouse-api.js) | VERIFIED | `dashboard-v4/src/adapters/warehouse-api.js` |
| R162 | S15.17 router → S15.19 StockService (all quantity writes) · → S15.18 StockRequestService (queue) · → S05.16 veeqo (cache) | VERIFIED | `router.js` |
| R163 | S15.18 approve → S15.19 StockService (source 'request', source_ref request:<id>) | VERIFIED | `StockRequestService.js:120-175` |
| R164 | S04.08 veeqo-order-sync → `pick({allow_box:true})` shelf first, box second | VERIFIED | `veeqo-order-sync.js:124` |
| R165 | S15.20 migration 071 → S08.05.05 (+2 tables, widened CHECKs) | VERIFIED | migration file |
| R167 | S02.08 op.js `stock/take|propose|recent` → S15 `src/v3/warehouse/op-stock.js` → S15.18 StockRequestService / S15.19 StockService.separate; `stock/context`+`stock/restock` session-only | VERIFIED | `op-stock.js`; `op.js:311-345` |
| R168 | S03.02 /op `ws.js` (workspace) → `/api/v3/op/stock/take|propose|restock|context|recent` | VERIFIED | `src/op/ws.js`; `op-redesign.test.js` REAL list |
| R170 | S15.24 import-veeqo → StockService.storeIn (unplaced, kind import, source veeqo_import, idempotent per day) | VERIFIED | router.js importVeeqo |
| R171 | Phone `/scan/` → `POST /api/v3/scan/push` (pair code) → scan-hub → SSE `GET /api/v3/scan/stream?code&t=` → operator hub (`estoque.js`) | VERIFIED | op-warehouse.js; estoque.js streamUrl |
| R172 | S15.26 operator hub → `/api/v3/op/stock/organize` (place, immediate) · `stock/count/weigh|manual` (proposal with meta) · `stock/box/new` (proposal; box allocated on approval by StockRequestService) · `stock/tasks` · `stock/lookup` | VERIFIED | op.js:326-339 |
| R173 | S15.28 drift worker → computeDrift (same numbers as hub) → Slack admin (dedupe audit_log) | VERIFIED | stock-drift-alert.js |
| R174 | S15.32 operator nav (`src/op/nav.js`) ← loaded by `/op/index.html` + `/op/estoque.html`; home strip rendered through `ws.js banner()`; Central "Iniciar Impressão de ordens" → `POST /api/v3/op/event/start {activity_slug:'order_printing'}` (same body as app.js postStart) → `D.loadData()` | VERIFIED | ws.js, nav.js |
| R175 | S15.33 Shell badge Aprovações + hub notice card + KPI Aprovações ← `GET /api/v3/warehouse/overview.pending_summary` (single source; router sets `kpis.pending_requests = pending.count`) | VERIFIED | Shell.jsx usePendingCount, router.js overview |
| R176 | S15.33 Locais "Criar várias" → `POST /api/v3/warehouse/locations/bins/bulk` → `locations-repo.bulkBins` (ON CONFLICT DO NOTHING; never qty) | VERIFIED | LocationsPage.jsx BulkBinsCard, router.js |
| R186 | S15.36 Central + hub + /print station → poll `GET /api/v3/print-queue?status=queued` (Bearer page token + X-Session-Token) → take → `HF_LABELS.sheetHtml(payload.labels)` print window or Central print() for picklist → done/error | VERIFIED | print-queue-card.js |
| R187 | S15.36 dashboard Etiquetas → `POST /api/v3/warehouse/mobile/print/submit`; Impressão panel → `GET /api/v3/print-queue`, `POST /:id/cancel` (x-admin-pin) | VERIFIED | warehouse-api.js adapter |
| R193 | S03.01.09 PontoStrip (topbar #hoje) → `GET /api/v3/data/attendance` (30 s) · power → `POST operator/:id/logoff` (kiosk) or `POST operator/:id/checkout` (saída manual) | VERIFIED | PontoStrip.jsx |
| R166 | S03.01 Shell nav: P&P + Picklist moved under Estoque; Planejamento + Produto after Metas | VERIFIED | `Shell.jsx`; `v4-nav-warehouse.test.js` |
| R177 | S01.03 wire → S15.29 static `/m` (next to `/scan` and `/print`) · → S15.34 print-queue router · shared `PrintQueueService` instance also injected into S15.17 warehouse router | VERIFIED | `wire.js` static block + warehouse/print-queue mounts |
| R178 | S15.29 `/m/` page → S15.35 `warehouse/mobile/*` (bootstrap · scan/resolve · print/submit · printers), header `x-admin-pin` | VERIFIED | `src/m/`; `mobile.js` |
| R179 | S15.35 mobile → S15.17 router internals `rowsWithVeeqo` · `kpisFrom` · `attentionFrom` · `pendingSummary` · `labelsFor` — one computation, so phone and dashboard cannot disagree | VERIFIED | `router.js` createMobile deps; `warehouse-mobile.test.js` compares bootstrap vs overview |
| R180 | S15.35 `mobile/scan/resolve` → S15.25 `op-warehouse.resolveBarcode` direct call, no HTTP, no duplicated resolution order | VERIFIED | `mobile.js` createOpWarehouse |
| R181 | S15.35 `mobile/print/submit` → S15.34 `PrintQueueService.enqueue` with labels resolved and frozen at request time | VERIFIED | `mobile.js printSubmit`; `router.js` mount |
| R182 | S11.01 print station .28 → S15.34 `/api/v3/print-queue` poll `take` → `done` `x-print-token` = `PRINT_EVENT_TOKEN`, same secret as `print-event`; kiosk alternative `Bearer OPERATOR_PAGE_TOKEN` + `X-Session-Token` | VERIFIED | `print-queue/router.js identify`; `print-queue.test.js` |
| R183 | S15.34 `done` on a box job → `v3.stock_boxes.label_printed_at` same UPDATE as `POST warehouse/locations/box/:id/label-printed` | VERIFIED | `service.stampBoxes`; `print-queue.test.js` stamp cases |
| R184 | S15.34 every state change → `v3.audit_log` action `print_queue_queued|taken|done|error|cancelled` | VERIFIED | `service._audit` |
| R188 | S15.37 `ShippingLabelsService.compose` → S09 Veeqo `getLabelPdf(shipment_id)` (`GET /shipping/labels?shipment_ids[]=` with `accept: application/pdf`, one 4x6 page per shipment); a label Veeqo refuses is skipped into `payload.failed`, never aborting the batch | VERIFIED | `veeqo-api.js getLabelPdf`; `shipping-labels.test.js` "não derruba as outras" |
| R189 | S15.37 `compose` → `v3.print_files` (PDF bytes) → `v3.print_queue` job kind `shipping_labels` carrying `file_id` + `shipment_ids` | VERIFIED | `service.compose`; `shipping-labels.test.js` "enfileira kind shipping_labels" |
| R190 | S15.37 `POST /api/v3/print-queue/:id/done` on a `shipping_labels` job → `markPrinted` stamps `v3.shipping_label_prints.printed_at` + `v3.pnp_order_lines.printed_at` (status untouched: Veeqo already said `shipped` when the label was bought) | VERIFIED | `print-queue/router.js` done hook; `shipping-labels.test.js` markPrinted; `print-queue.test.js` "done de etiqueta de envio carimba" |
| R191 | S15.37 `preview`/`compose` → `v3.product_skus` + `v3.products` (nickname, bottle_color) + `v3.stock_bins`/`stock_boxes` (best bin/box, walking order), same resolution shape as the S15 picklist | VERIFIED | `service.productsBySku`; mirrors `data/router.js:1015` |
| R192 | S15.37 `envelope.js` ← COPY of the perfect-bag rule in `data/router.js:1092-1117` (`v3.bottle_size_tiers`, per order, by bottle colour; mixed → `misto?`). Copied because `data/router.js` is on the do-not-grow list; the two must change together | PARTIAL | `envelope.js` header; `shipping-labels.test.js` envelope cases | duplicated rule by necessity |
| R193 | S15.37 footer picker ids ← open P&P events (`v3.events.ended_at IS NULL`, slugs `order_printing`, `order_printing_2`, `stock_organization`, `packaging%`); packer ← kiosk session person. Both are `v3.persons.id` (the dashboard employee ID; no other roster exists) | VERIFIED | `service.pickerIds`; `print-queue/router.js` identify person_id |
| R194 | S15.37 `GET /api/v3/print-queue/:id/file` accepts `?t=` (kiosk session) or `?pin=` (admin) — the ONLY route with credentials in the query, because `window.open` cannot send headers | VERIFIED | `print-queue/router.js` file route; `print-queue.test.js` "?t=", "?pin=", 401 cases |
## Added 2026-08-19 (Preferências por conta)
| R | From → To | Type | Evidence |
|---|---|---|---|
| R195 | S03.01.20 `useAccountPref` → S02.17 `/api/v3/prefs/:key` — GET na montagem, PUT com debounce de 600 ms coalescido. A CONTA vence o localStorage na carga; o localStorage vira cache de abertura. Exceção deliberada: com a flag `<localKey>.dirty` ligada (a pessoa mexeu e deu F5 antes do debounce) o LOCAL vence e sobe, senão o ajuste dela sumiria na frente dela | VERIFIED | `hooks/useAccountPref.js`; `qa-dashboard-hoje.js` grupo "conta" (conta vence · PUT no arraste · F5 antes do debounce) |
| R196 | S02.17 → S08.05.13 `v3.user_prefs` — ESCRITA ÚNICA, um `INSERT … ON CONFLICT (login_id, key) DO UPDATE`. `login_id` vem de `req.login.id` (S09.01 `resolveLogin`), NUNCA do corpo: é o que garante que um login só alcança as próprias linhas. Login de emergência (sem id) não gera linha nenhuma | VERIFIED | `prefs/router.js`; `prefs-router.test.js` "emergência NUNCA grava linha órfã" + "o layout do Henrique não vaza pra Simone" |
| R197 | S03.01.09 Hoje (grade de widgets) → S03.01.20 com a chave `hoje.layout` e `localKey` `hf-hoje-layout-v2` — o mesmo objeto `{grid, stack}` de antes, agora seguindo a pessoa em vez do navegador; o valor local que já existia sobe como primeira gravação da conta (migração sem "importar configurações") | VERIFIED | `CommandCenter.jsx` `useAccountPref(PREF_KEY, loadLayout, …)`; harness "o layout da conta é reescrito no cache do navegador" |

## Added 2026-08-19 (Revisão do dia)
| R | From → To | Type | Evidence |
|---|---|---|---|
| R198 | S02.18 `GET review/waiting` → S10.02 EMS `/pipeline` + `/products` — a fila NASCE no EMS, não em `v3.events`. Um lote que ninguém revisou não tem evento nenhum aqui, então uma fila derivada dos nossos eventos listaria exatamente os lotes já tratados e esconderia os esquecidos. Cache de 120 s em processo, e a FALHA também é cacheada (EMS fora do ar não leva uma chamada por request). Sem chave ou inacessível → `ems_ok:false` + fallback `v3.ems_activity_cache` (`sync_status='active'`), nunca 500 e nunca barra lateral em branco — regra #0 | VERIFIED | `review/service.js` `_emsBatches`/`_waitingFromCache`; `review-router.test.js` "EMS explode → ems_ok:false + espelho local" · "duas chamadas seguidas batem no EMS uma vez só" |
| R199 | S02.18 `review/day` → S02.10.03 `flow-views-repo.reviewRate` (SHARED-DEP) — a MESMA fórmula `WORK_SEC` (`ended_at − started_at − total_paused_seconds`), copiada como constante única no topo do service. O widget da Hoje e o popup dele respondem sobre o mesmo turno; duas cópias da aritmética deixariam os dois discordarem sobre a mesma tarde | SHARED-DEP | `review/service.js` `WORK_SEC`; `flow-views-repo.js:488` |
| R200 | S02.18 `on_line` ← S08 `v3.events` slug `production_line` **OU** `v3.production_counts.product_batch_id` — qualquer uma das duas já acende o check. Evento sem contagem = linha rodando antes de alguém contar; contagem sem evento = lançamento do `/op` sem tarefa aberta. Exigir as duas deixaria metade dos lotes reais sem check; `production_counts` também é quem traz `line_bottles` | VERIFIED | `review/service.js` `_lineByBatch`; migração 001 §8 (`production_counts.product_batch_id`); `review-router.test.js` "CHECK DA LINHA: Charcoal já rodou, Berberine não" |

| R185 | S15.34 migration 073 index → S15.30 velocity LEFT JOIN on `pnp_order_lines (product_id, shipped_at) WHERE status='shipped'`, now also read by `mobile/bootstrap` | VERIFIED | `073_print_queue.sql`; `StockService.overview` |

## Added 2026-08-19 (SKU parenting — uma linha por produto físico)
| R | From → To | Type | Evidence |
|---|---|---|---|
| R201 | S15.38 `family-repo.merge` → S15.19 `StockService.moveProduct` — o merge NÃO escreve quantidade: ele PEDE ao StockService. Bins, caixas, "a organizar" e Separadas do fantasma passam pro pai como PAR de movimentos (−origem, +destino, mesmo bin/caixa) com `source 'sku_merge'`, então a soma no livro-razão é ZERO e o total do armazém não muda. Idempotente por peça (`sku_merge:<from>:<into>:bin<id>:out|in`, `:box<id>:`, `:unplaced:`): merge em lote reenviado não move nada duas vezes. **A porta única de escrita continua sendo UMA** (o `architecture-drift` writer-set de `v3.stock_movements` segue com só `StockService.js`) | VERIFIED | `family-repo.merge`; `StockService.moveProduct`; `stock-service-parenting.test.js` "a soma dos movimentos é ZERO" + idempotência; `architecture-drift.test.js` |
| R202 | S15.38 migration 077 `v3.products.merged_into_product_id` → TODA leitura do hub, num lugar só: `StockService.overview` acrescenta `p.merged_into_product_id IS NULL` no WHERE (pulado quando pedem um `product_id` específico, senão a ficha do absorvido não abriria). O fantasma é RETIRADO, nunca apagado — `stock_movements`, `product_batches` e `pnp_order_lines` antigos continuam apontando pra ele e não podem virar órfãos | VERIFIED | `077_sku_parent.sql`; `StockService.overview` `notRetired`; `stock-service-parenting.test.js` "produto absorvido não aparece" + "pedindo por id, o absorvido vem" |
| R203 | S15.38 `POST family/unmerge` → `v3.audit_log` `warehouse.family_merge.after_data.sku_ids` — o desfazer lê do próprio rastro do merge quais SKUs devolver. Sem esse rastro o produto volta VAZIO em vez de adivinhar "os que parecem dele": merge errado manda a garrafa errada pro cliente (memória `merge-safety-rules`), então chutar na volta é pior que não devolver | VERIFIED | `family-repo.unmerge`; `warehouse/router.js` grava `sku_ids` no audit do merge; `family-parenting.test.js` "unmerge devolve o produto e os SKUs"; `warehouse-router-parenting.test.js` audit `sku_ids` |
| R204 | S15.38 `veeqo_total` da Row ← SÓ o SKU base do cache Veeqo, NUNCA a soma dos filhos. Kit é a mesma garrafa do base contada de novo (V1: no Veeqo o kit deriva do ProductVariant), então somar base + kits dobraria o estoque na tela de comparação. Mesma regra que `computeDrift` e `importVeeqo` já usavam pro `base_sku` | VERIFIED | `router.js` `enrich`; `warehouse-router-parenting.test.js` "veeqo_total é SÓ o base (140, NÃO 186)" |
| R205 | S15.38 `sku-suggest.js` ← ideias de normalização do S15 `stock-gap-service.norm()` + `ems-activity-sync.normProductName()`, com UMA divergência deliberada: a **DOSE FICA**. O `normProductName` tira "400mg" porque lá o objetivo é deduplicar o mesmo produto escrito de dois jeitos; aqui tirar a dose faria "Berberine 1000mg" e "Berberine 6000mg" caírem no mesmo grupo e alguém confirmaria no automático. Só sai o que descreve EMBALAGEM (`-C3`, `x4 kit`, `pack of 2`) | VERIFIED | `sku-suggest.normName`; `family-parenting.test.js` "DOSE DIFERENTE NUNCA agrupa" + "pacote sai, dose fica" | cópia por necessidade, como R192 |
| R206 | S15.38 `GET sku-suggestions` → NADA escreve. A resposta é proposta pura (grupos + `reason` PT-BR + `confidence`); o merge só acontece quando um humano chama `family/merge` ou `merge-bulk` | VERIFIED | `warehouse/router.js` rota `read`; `warehouse-router-parenting.test.js` "nenhum merge foi chamado" |

## Added 2026-08-19 (PAUSA do grupo + "Você estava nisso desde o começo?")
| R | From → To | Type | Evidence |
|---|---|---|---|
| R210 | S02.08 `freezeActiveFor` → S09.15 `pause.freezeFor(personIds, exceptEventIds)` — **a pausa passou a ser do GRUPO**. O laço de INSERT do cowork (`op.js:1716-1726`) sempre criou 1 evento por participante, mas o freeze rodava UMA vez, pro starter: no evento 3583 o `break` do Vitor (11:18:36 → 12:43:07) congelou o evento dele com `total_paused_seconds = 5071` exato, e a revisão do Bruno Sarmento (#3575, 09:50 → 13:05) seguiu contando com 0. Agora `op.js` passa `cw` (colegas) e `pauseIds` (os breaks de todos, que ficam de fora do congelamento: pausa não congela pausa) | VERIFIED | `op.js` linha do freeze no ramo cowork; `pause/service.freezeFor`; `op-pause-group.test.js` "congela os eventos de TODOS"; `pause-service.test.js` "não só do starter" |
| R211 | S02.08 `/event/:id/end` → S09.15 `endPauseFor(pauseEventId)` → `resumeFor` de CADA participante — quem termina a pausa termina PRO GRUPO, igual ao fim de cowork que já existia. `resumePausedFor(personId)` descongelava uma pessoa só, então o colega ficava congelado pra sempre e nunca via o "continuar ou finalizar?". A resposta agora leva `resumed_tasks` (as de quem pediu) **e** `resumed_group` (por pessoa, pro kiosk de cada colega perguntar a dele) | VERIFIED | `op.js` `resumePausedFor(s.person_id, ev.id)`; `pause/service.endPauseFor`; `op-pause-group.test.js` "descongela o GRUPO e devolve resumed_group" |
| R212 | S02.08 `/event/:id/end` ramos de cowork → `resumed`/`resumed_tasks`/`resumed_group` — **furo colateral do mesmo bug**: os dois `return` de cowork (`isCowork && !isLast` e `isCowork && isLast`) montavam a resposta SEM os campos de retomada, então terminar uma pausa feita a dois nunca abria o "continuar ou finalizar?" em ninguém, nem no starter. Os dois caminhos agora espalham o mesmo objeto | VERIFIED | `op.js` `const rz = {...}` nos dois returns; `op-pause-group.test.js` |
| R213 | S02.08 `/event/:id/join` → S09.15 `joinPause` — entrar numa pausa **em andamento** deixou de ser um join cego. Sem `since` no corpo a rota devolve `{pause_join_question:true, pause_event_id, pause_started_at}` (200, nunca 4xx) e o kiosk faz a pergunta do Bruno; com `since` ∈ `inicio\|agora` o serviço congela do ponto certo. Tarefa normal segue pelo caminho de cowork de sempre — só `PAUSE_SLUGS` desvia | VERIFIED | `op.js` bloco `if (PAUSE_SLUGS.has(ev.slug))` no join; `op-pause-group.test.js` "recebe pause_join_question com o horário" |
| R214 | S03.02 `/op` → S09.16 `HF_PAUSE` → `GET /api/v3/op/pause/pending` (junto do `loadData`) e `POST /api/v3/op/pause/answer` — **a pergunta PENDENTE**, que é o caso exato do 3583: o admin anexou o Bruno Sarmento à pausa às 11:57:53 pelo dashboard e ele não estava no kiosk. O evento de pausa dele nasce com `joined_since` NULL, vale o conservador `agora`, e a pergunta aparece no topo do `/op` no próximo toque, dizendo em português o que foi assumido. Responder `inicio` CORRIGE os números depois (REGRA #0: nada trava esperando resposta) | VERIFIED | `app.js` `PZ.load()` no `Promise.all`; `pause-ui.js` `answer()`; `pause/service.pendingQuestionFor`/`answerPending`; harness `qa-op-pausa.js` 21/21 |
| R215 | S09.15 `participantsOf` → união de `cowork_group_id` **E** `cowork_with[]` — ler só uma das duas é o que deixou o Bruno Sarmento de fora. Quando o admin corrige `cowork_with` num evento em andamento (`data/router` PATCH → `EventService.correct`), a pessoa entra no array mas NÃO ganha evento de pausa próprio; o serviço trata esse participante como `pause_event_id: null` e o `joinPause` cria o evento dele no mesmo grupo na hora | VERIFIED | `pause/service.participantsOf`; `pause-service.test.js` "junta o grupo E o cowork_with" |
| R216 | S09.15 `repairPauseOverlap` → `v3.events.total_paused_seconds` (só com `apply:true`) — o conserto do histórico. Mede a interseção REAL de cada evento do participante com a janela da pausa, subtrai o que já está descontado, e **nunca remove desconto** (`would_add` piso 0), então rodar duas vezes não faz nada na segunda. Dry-run por padrão: o relatório `{event_id, person, current_paused, would_add, new_paused}` é lido por um humano antes de qualquer escrita | VERIFIED | `pause/service.repairPauseOverlap`; `pause-service.test.js` bloco "REPARO do evento 3583 (dados reais)" — 3575 would_add 5071, 3576 2484, 3577 (já certo) 0 |
| R217 | S09.15 → `v3.events` — **escreve SÓ o relógio**: `paused_at`, `total_paused_seconds`, `joined_since`, `joined_at`, `join_assumed`. Não fecha evento (`ended_at` continua sendo do `op.js`) e não toca estoque, de propósito: o writer-set de `v3.events.ended_at` e de `v3.stock_movements` do `architecture-drift` fica intacto | VERIFIED | `pause/service.js` (sem `ended_at =` em nenhuma query); `architecture-drift.test.js` verde |
| R218 | S09.16 `pause-ui.banner()` ← S03.02 `app.js pauseBanner()` — o banner "Você está em pausa" MUDOU DE CASA (markup idêntico, mesmo `data-act="resumeWork"`), pra pausa ter um dono só e pra `app.js` não crescer. `app.js` ficou em 2028 linhas | VERIFIED | `app.js` `function pauseBanner() { return PZ ? PZ.banner() : ''; }`; `pause-ui.test.js` bloco do banner |

**Totals after 2nd pass (machine-counted):** **134 unique R-ids** (R001–R152 with intentional gaps in numbering; R003 and R067 corrected in place, not renumbered) — VERIFIED 106 · PARTIAL 10 · SHARED-DEP 6 · DUPLICATE-PATH 12 · AMBIGUOUS 5 · DISCONNECTED 12 · UNKNOWN 1 (by primary tag; a few edges carry two tags).
