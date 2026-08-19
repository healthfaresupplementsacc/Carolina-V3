# GENERATIONS — where the older Dashboard / Carolina / Kiosk / Inventory versions stand

Evidence-based status of every generation of each surface, as of 2026-08-14. Status vocabulary:
**LIVE-CANONICAL** (the current one) · **LIVE-DUPLICATE** (still served, overlaps canonical) ·
**LIVE-PARTIAL** (some routes alive, some shadowed) · **DEAD-SHADOWED** (code exists, unreachable by routing) ·
**DEAD-MISSING** (mount exists, files don't) · **DEAD-UNLINKED** (files exist, nothing routes/links) ·
**BACKEND-ONLY** (no UI, still writes).

Decisions (keep / fold / retire) are Bruno's. Column "Integration observation" states only what the code makes possible.

---

## G-D — Dashboard generations

| Gen | ID | What | Status | Evidence | Overlaps with | Integration observation |
|---|---|---|---|---|---|---|
| D1 | S03.05 / S02.13 | Server-rendered dashboard (`src/dashboard/template.js` 2844 ln + `router.js`), PIN overlay client-side | **LIVE-PARTIAL** — alive: `/eod-summary`, `/archive/:date`, `/operator/:id`, `/admin/silent-log`, `/admin/carolina-config`, `/admin/workflows`, `/admin/ad-hoc-tasks`; dead-shadowed: `/`, `/admin`, `/admin/audit` | `index.js:57,63`; `wire.js:174`; `router.js:24-1459` | S03.01 (`#hoje/#producao/#pessoas`), S03.03 (`/admin`) | `/eod-summary` is still the Puppeteer source for the V2 EOD Slack image (R064). The four `/admin/*` legacy utility pages have no v4 equivalent found (Carolina config, silent log, workflows, ad-hoc tasks) → either port to v4 or accept as legacy admin. |
| D2 | S03.06 / S02.15.06 | `public/dashboard` SPA (the "E-series" migration target of INTEGRATION_PLAN) | **DEAD-MISSING** | `wire.js:206` mount; `ls public/` has no `dashboard/`; not in git; `docs/ARCHITECTURE.md:33` still lists it | — | Nothing to fold; it never shipped (or was removed). Only a dead mount + a stale doc line remain. |
| D3 | S03.01 | **dashboard-v4** React/Vite (root redirect target; hash routes; RBAC) | **LIVE-CANONICAL** | `index.js:57`; `App.jsx:423-463`; build committed `public/dashboard-v4/` | — | This is the final dashboard base. Missing vs D1: Carolina config / silent-log / workflows / ad-hoc admin pages. |
| D4 | S03.03 | **`/admin` static SPA** (`src/admin/`; tabs Operadores, Notificações, Analytics, Métricas, Lotes, EMS, Gaps, Logs, Voices, Admins, Histórico; Chart.js CDN) | **LIVE-DUPLICATE** | `wire.js:172-176`; calls S02.09 only | S03.01.06 (`#admin`, `#operadores`, `#usuarios`, `#sistema`) also on S02.09 | Same backend (`/api/adminpanel`), two UIs. v4 already hosts AdminPanel/OperatorsTab/UsersPage/SystemHealth. Tabs with no clear v4 twin from what was traced: Notificações, Analytics, Métricas (v4 has `METRICS_GUIDE` tab? not verified), Lotes, EMS, Gaps, Logs, Voices, Histórico → parity check needed before retiring. |
| D5 | S03.10 / S02.06 | admin-v3 shadow HTML pages (`/api/admin/v3/overview|messages-shadow|events-shadow|timeline|divergences|vocabulary-pending|llm-metrics|health`) | **LIVE-DUPLICATE (inspection)** | `admin-v3/routes.js:379-400` | S03.01.06 SystemHealth, S02.10 `messages`, `metrics`, `health`, `vocabulary` endpoints | Pure read/inspection views built before v4; the same repos feed v4 endpoints. Candidate to retire once v4 shows the same (Observer shadow, divergences, vocabulary-pending). |
| D6 | S03.01.11 | `dashboard-v4/build/` orphan | **DEAD-UNLINKED** | wrong base path, stale hashes | — | Stray artifact. |
| D7 | S03.08 | Cameras pages `/cameras`, `/pip`, `/tag` (inline HTML) | LIVE (specialized) | `cameras.js:366-541` | S03.01.02 `#cameras` | v4 already embeds cameras; `/tag` (zone tagging) and `/pip` have no v4 twin found. |

**Net for the "final dashboard":** D3 is the base. D1 (4 admin utility pages + eod renderer), D4 (11 tabs), D5 (8 shadow pages), D7 (`/tag`, `/pip`) are the only places with functionality not confirmed present in D3. Everything else is dead or duplicate.

## G-C — Carolina generations

| Gen | ID | What | Status | Evidence | Overlaps with | Observation |
|---|---|---|---|---|---|---|
| C1 | S07 | **Carolina V2** — poller (`src/slack/poller.js`), regex parser, canonical-dispatcher, ISA-88 workflow engine, `src/ai/*` (admin-tools, detect, persona, proposals, note-classifier, supplement-corrector), 7 node-cron jobs, `public.*` tables, `carolina_master_doc.md` spec | **LIVE (backend), crons gated by `V2_DISABLED`** — webhook `/slack/events` + interactivity/App-Home + `/api/*` legacy routes + boot seeds/migrations run regardless | `index.js:45-48,63,70-105,136-154`; `interactive.js:160`; `engine.js` | S06 (V3 Observer/CommandHandler) — two ingestion paths, two write models | `V2_DISABLED=1` stops only the 7 timers. Parser→dispatcher→engine still fires from Slack interactivity and legacy `/api`. Whether its output is still read by anyone is U-11 (needs a read-only data check). |
| C2 | S06 | **Carolina V3** — Observer (Gemini QuotaChain, shadow mode), CommandHandler (@mentions, ✅ confirm), PersonResolver, NotificationHandler, note-analyzer, V3 workers, `v3.*` tables | **LIVE-CANONICAL** | `wire.js:324-335`; `events-v2.js` | — | Canonical. Two of three Gemini instantiations bypass the QuotaChain (R125). |
| C3 | S11.04 | "Analyst" pipeline (Claude Code answers admin data questions; watch→context→reply) + "Carol speaks" CDP track | LIVE (out-of-process, on Bruno's PC) | `scripts/analyst/*` | C2 CommandHandler (fallback when Claude Code absent) | Complementary, not duplicate: uses backend repos for numbers. |
| C4 | S07.05 note-classifier + S06.05 AnthropicProvider | Anthropic paths (legacy flag `AI_NOTE_CLASSIFIER_ENABLED`; V3 rollback `LLM_PROVIDER=anthropic`) | DORMANT | `note-classifier.js:56`; `LLMProvider.js:127-137` "ANTHROPIC OUT" | — | Kept as rollback by decision. |

**Net:** C2 is Carolina. C1's *Slack-timer* half is switchable off by env; C1's *synchronous* half (interactivity, legacy API, boot seeds, `public.*` schema) is not switchable and still runs every boot. Retiring C1 fully = removing `src/slack/events.js` mount, `/api` legacy routers, boot steps S01.01.01–.06/.08, and freezing `public.*` — a scoped project, not a flag.

## G-K — Kiosk (operator page) generations

| Gen | ID | What | Status | Evidence | Observation |
|---|---|---|---|---|---|
| K1 | S03.02.04 | `/op` `.legacy` set (`index.legacy.html`, `app.legacy.js`, `sw.legacy.js`, `style.legacy.css`) | **DEAD-UNLINKED** | no route/link; `docs/design/SHELL_QUEUE.md:58-61` | Retained deliberately (SESSION-REPORT). Nothing to fold. |
| K2 | S03.02 | `/op` current PWA (`app.js`, `fuse-data.js`, state-machine, offline-queue, sw v39) | **LIVE-CANONICAL** | `wire.js:161`; `op/index.html:30-35` | Final kiosk base. `OP_WORKSPACE_ENABLED` and `STOCK_UI_ENABLED(+ALLOWLIST)` gate optional panels. |
| K3 | S03.04 | `/print` print-station kiosk (browser half of .28) | LIVE (specialized) | `wire.js:163`; `print.js:87-100` | Shares design + page token with K2; not a duplicate (different device role). |

## G-I — Inventory / stock surfaces

| Gen | ID | What | Status | Evidence | Observation |
|---|---|---|---|---|---|
| I1 | S03.01.04 | dashboard-v4 pages: `#picklist`, `#estoque-geral` StockOverview, `#config-estoque` InventorySettings, `#inventory` InventoryPage, `#produto-setup` ProductSetup, `#pp` | **LIVE-CANONICAL (admin/manager)** | `App.jsx`; `S02.10` stock/product-setup/inventory-settings/supplies endpoints | Backed by S05.08 StockService (single write door) + S02.10 reads. |
| I2 | S02.08 stock endpoints (`/api/v3/op/stock/*`, `/picklist`, `/stock-gaps`) + `/op` panel | LIVE-GATED (`STOCK_UI_ENABLED`, allowlist) | `op.js:293-332, 2957-3050` | Operator-side kiosk stock actions. Uses StockService at `op.js:2941` **but also** a raw `INSERT INTO v3.stock_movements` at `op.js:324` (R076) that skips bin/box qty + idempotency. |
| I3 | S04.08/S04.09/S04.12/S04.13 | Veeqo order sync, stock-alerts planner, stock-gap-alert, unusual-sku (all opt-in) + S05.14 TikTok CSV | BACKEND (opt-in) | `wire.js:400-489` | Feed I1/I2 with Veeqo mirror + alerts. |
| I4 | S05.09 SupplyService `consumeForSize` | BACKEND-ONLY, loop open | no production caller (R077) | Label-print → supply deduction edge defined, never fired. |

**Home for all of this going forward: map section S15 (Warehouse Inventory)** — current pieces + Bruno's planned admin/operator pages and flow automations, with open questions U-27…U-31.

**Net for "final inventory pages":** I1 is the admin UI; I2 is the operator UI. One service (S05.08) plus one raw path (`op.js:324`) — that raw path is the only structural duplicate. I4 is an unfinished edge.

---

## Summary table (what is dead / duplicate / needs decision)

| Kind | Items |
|---|---|
| **Dead, nothing to fold** | D2 `public/dashboard` mount, D6 `dashboard-v4/build/`, K1 `/op .legacy`, S02.16 events-v2 createRouter, S06.06 OpenAIProvider, S06.09 FallbackProvider, S09.11 empty stubs, S14.01 `NOW()-INTERVAL` |
| **Live duplicates over the same backend** | D4 `/admin` SPA vs v4 admin group (S02.09); D5 admin-v3 shadow vs v4 (S02.10 repos); D7 cameras pages vs `#cameras`; three PIN systems (S12.01/02/03); Gemini ×3 (R125) |
| **Live legacy with unique features (needs parity check before retiring)** | D1 pages `/admin/silent-log`, `/admin/carolina-config`, `/admin/workflows`, `/admin/ad-hoc-tasks`, `/operator/:id`, `/eod-summary` (Puppeteer source); D4 tabs Notificações/Analytics/Métricas/Lotes/EMS/Gaps/Logs/Voices/Histórico; D7 `/cameras/tag`, `/pip` |
| **Legacy backend still writing** | C1 parser→dispatcher→engine (`public.*` ISA-88), boot seeds/migrations, poller backfill (U-11) |
| **Duplicate write paths (data integrity)** | R071–R078: `v3.events.ended_at`, `v3.production_counts` (6 writers), `v3.stock_movements` raw INSERT, orders count vs Veeqo mirror |
