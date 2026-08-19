# MASTER SYSTEM MAP — how to read, edit, and keep it true

Source diagram: [`MASTER_SYSTEM_MAP.mmd`](MASTER_SYSTEM_MAP.mmd) · Editor: [`MASTER_SYSTEM_MAP.html`](MASTER_SYSTEM_MAP.html) (open locally in a browser) ·
Drill-downs: [`maps/`](maps/) (incl. **`S15-warehouse-inventory.mmd`** — the Warehouse Inventory domain section, current vs PLANNED) · Index: [`STRUCTURE_INDEX.md`](STRUCTURE_INDEX.md) · Edges: [`RELATIONSHIPS.md`](RELATIONSHIPS.md) ·
Unknowns: [`UNCERTAINTIES.md`](UNCERTAINTIES.md) · Old generations: [`GENERATIONS.md`](GENERATIONS.md)

Generated 2026-08-14 by tracing from `src/index.js` (branch `v3-reset`). Every node/edge has evidence in the index files. **No application code was changed** to produce this.

## The system in one paragraph

One Node/Express process on Railway (**S01**) boots a legacy V2 stack and a V3 stack side by side. HTTP (**S02**, ~370 routes) serves seven browser surfaces (**S03**): the canonical **dashboard-v4** SPA, the operator kiosk **/op**, the print kiosk **/print**, an older **/admin** SPA, partially-alive legacy server-rendered pages, `/foto`, and camera pages. `wire.js` (**S01.03**) starts ~24 background processes (**S04**) plus 7 legacy crons; they use V3 write-gate services (**S05**) and Carolina's Gemini LLM path (**S06**), while the legacy Carolina V2 (**S07**: poller, regex parser, ISA-88 engine) is still live. All of it lands in one Postgres with two schemas and two pools (**S08**). A handful of glue modules cross every domain (**S09**). External systems (**S10**: Slack, EMS, Veeqo, NGTeco, Gemini, Tailscale cameras) and satellites (**S11**: the .28 print PC's Python set, Bruno's PC scheduled tasks/analyst pipeline, an unverified .246) sit around it. Auth is three PIN systems plus tokens (**S12**). Tests/docs/tooling (**S13**) and stray files (**S14**) round it out.

## Legend

| Visual | Meaning |
|---|---|
| green box | VERIFIED |
| amber box | PARTIAL |
| red dashed box | ORPHANED (dead / missing / unlinked) |
| purple dotted box | UNKNOWN |
| blue dashed box | PLANNED (does not exist yet; Bruno's target — S15 only) |
| blue box | External system |
| teal box | Satellite machine / out-of-process |
| navy box | Hub (`wire.js`) |
| `-->` | VERIFIED edge |
| `-.->` | PARTIAL / conditional / DISCONNECTED (label says which) |
| `==>` | DUPLICATE-PATH (two things doing one job) |
| edge label `Rnnn` | row in `RELATIONSHIPS.md` |

Node ID = element ID with `_` instead of `.` (`S02_08` ≡ S02.08). Group nodes like `S04_ATT` bundle several IDs and say so in their label; the drill-down splits them.

## How Bruno edits the map (and how I read it back)

1. Open `MASTER_SYSTEM_MAP.html` in a browser (double-click). Left = source, right = live render. Edit freely; the page autosaves a draft in the browser and lets you **Download** the edited `.mmd`.
2. Put your changes **below the line** `%% ==== HUMAN EDITS BELOW` in `MASTER_SYSTEM_MAP.mmd`, either as Mermaid lines (using existing IDs) or as directives:

```
%% CONNECT    S03_03 --> S03_01_06   fold /admin tabs into v4 admin group
%% DISCONNECT S02_15_06 --> S03_06   remove dead /dashboard mount
%% MOVE       S09_09 UNDER S02_10    attendance-markers only serves data router
%% SAME       S03_10 == S03_01_06    shadow pages are the same concept as v4 admin
%% FEEDS      S05_09 --> S02_08_03   label print should consume supplies
%% WRONG      R036                    data API SHOULD be under securityHeaders
%% REORG      S04                     group workers by domain, not by gate
%% NOTE       S11_05                  .246 posts labels via X (fill in)
```
3. Save the file back to `docs/architecture/MASTER_SYSTEM_MAP.mmd` (overwrite) **or** drop the downloaded copy anywhere and tell me. I parse the HUMAN EDITS section first on any future scan and act on it. **Rescans regenerate only the GENERATED section**; your section is never overwritten.
4. IDs are permanent. If something is truly new, I assign the next free ID in its family; if you say `SAME`, both IDs stay and the index records the equivalence.

## Rendering notes

- The page applies a **render-time compact layout** (checkbox `compact`, on by default): long labels are wrapped at ~34 chars and sibling nodes inside each subgraph are stacked in columns of 6 with invisible links. The `.mmd` sources stay clean (one-line labels, no layout hacks) so they remain easy to edit; only the on-screen layout changes. Measured with real Mermaid: master 25070×2641 → ~18400×5200; drill-downs from up to 33:1 down to 1.6–3.1:1. Uncheck `compact` to see the raw layout.
- Rendered elsewhere (GitHub, Obsidian), the raw `.mmd` files will look wide; the HTML page is the intended viewer.
- QA: `node docs/architecture/_qa/qa-map.js` (62 checks: all 10 tabs render, live edit/localStorage/reset/download/directive insert/pan/zoom/fit/node click/error handling, search, class filter, human-edit panel, self-containment). Screenshots land in `docs/architecture/_qa/`.

## Rule that keeps this true

**RULE #2 (CLAUDE.md, memory):** any addition/change to the system must update this map set and Obsidian in the same session. `architecture-drift.test.js` currently guards `docs/ARCHITECTURE.md` only (see U-20 for extending it to `STRUCTURE_INDEX.md`).

## Reference tables (compressed; full detail in the index)

### Mount order (Express first-match wins)
`/slack` rawBody → json 10mb → `/archive` static → `/slack/events` (legacy) → `/api` legacy → `/api` workflow → **wire.mount**: `/slack/events-v2`, security mw (5 prefixes), admin-v3, architect, **op.js**, `/shared`, `/op`, `/print`, **admin.js**, `/admin` static+SPA, **data router**, `/dashboard` (dead), `/dashboard-v4`, `/foto`, images → `GET /` redirect → cameras → legacy dashboard router (last).

### Workers (default ON): watchdog · Observer · sandbox-cleanup · ems-activity-sync · attendance-sync · production-total · absence-alert · encap-monitor · pending-commands cron · action_log cleanup · matview refresh · session cleanup.
### Workers (opt-in `=== 'true'`): proactive-alerts · forgotten-dm · veeqo-order-sync · stock-alerts · mergeable-alert · print-divergence · stock-gap-alert · unusual-sku · dup-shipment · dedupe-watcher · note-analyzer.
### Legacy crons (`V2_DISABLED` ≠ `'1'`): polling · EOD · daily cleanup · divergence telemetry · greeting · detect · activity-freshness.

### Env vars by domain (names only)
- Infra: `DATABASE_URL PORT NODE_ENV TIMEZONE RAILWAY_* PUPPETEER_EXECUTABLE_PATH SKIP_LEGACY_MIGRATION`
- Slack: `SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACK_CHANNEL_ID V3_PRODUCTION_CHANNEL V3_ADMIN_CHANNEL V3_ORDERS_CHANNEL STOCK_ALERTS_CHANNEL IMAGES_UPLOAD_CHANNEL MANAGER_CHANNEL_ID V3_BOT_USER_ID *_USER_ID POLL_INTERVAL_MS EOD_HOUR_EDT ANALYST_CHANNELS`
- LLM: `LLM_PROVIDER GEMINI_API_KEY[_2..5] GEMINI_MODEL[_2] GEMINI_TIER ANTHROPIC_API_KEY OPENROUTER_API_KEY OPENROUTER_MODEL V3_OBSERVER_CONCURRENCY V3_RATE_* V3_PROMPT_CACHE_ENABLED NOTE_LLM_ENABLED AI_NOTE_CLASSIFIER_ENABLED AI_SUPPLEMENT_CORRECTOR_ENABLED`
- EMS: `EMS_PRODUCTION_API_KEY EMS_PRODUCTION_API_BASE EMS_AUTO_CHECKIN_ENABLED EMS_AUTO_CHECKIN_WINDOW_MIN EMS_CATALOG_SYNC_ENABLED EMS_CONFIRM_ESCALATE_MIN`
- Veeqo: `VEEQO_API_KEY VEEQO_API_BASE STOCK_DEDUCT_MODE VEEQO_WAREHOUSE_ID`
- NGTeco: `NGTECO_USER NGTECO_PASS`
- Cameras: `CAM_TUNNEL_URL CAM_TOKEN CAM_VIEW_PIN CAM_TZ CAM_ON_HHMM CAM_OFF_HHMM CAM_OFF_DAYS`
- Auth: `ADMIN_PASSWORD ADMIN_PIN OPERATOR_PAGE_TOKEN ARCHITECT_API_TOKEN PRINT_EVENT_TOKEN IMAGES_UPLOAD_TOKEN V3_SNAPSHOT_TOKEN`
- Kill-switches: `V2_DISABLED CAROLINA_SILENT_MODE CAROLINA_SILENT OBSERVER_ADMIN_REVIEW V3_PENDING_COMMANDS_CRON_DISABLED WORKER_ALERTS_DISABLED`
- Workers: `WORKER_SANDBOX_CLEANUP_ENABLED WORKER_EMS_SYNC_ENABLED WORKER_ATTENDANCE_ENABLED WORKER_TOTAL_ENABLED ABSENCE_ALERT_ENABLED ENCAP_MONITOR_ENABLED WORKER_PROACTIVE_ALERTS_ENABLED WORKER_FORGOTTEN_DM_ENABLED WORKER_VEEQO_ORDERS_ENABLED WORKER_STOCK_ALERTS_ENABLED WORKER_MERGEABLE_ALERT_ENABLED WORKER_PRINT_DIVERGENCE_ENABLED WORKER_STOCK_GAP_ALERT_ENABLED WORKER_UNUSUAL_SKU_ENABLED WORKER_DUP_SHIPMENT_ENABLED WORKER_DEDUPE_ENABLED WORKER_DEDUPE_NOTIFICATIONS_SILENT_MODE ABSENCE_THRESHOLD_MIN ABSENCE_REPEAT_MIN`
- UI: `OP_WORKSPACE_ENABLED STOCK_UI_ENABLED STOCK_UI_ALLOWLIST PRINTER_LABELS PRINT_EPSON_LABELS_PER_SEC PRINT_TEST_MAX TIKTOK_SOURCE`
