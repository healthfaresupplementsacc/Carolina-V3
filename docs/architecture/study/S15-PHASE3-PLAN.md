# S15 · Phase 3 PLAN — Veeqo import · labels · scanner (phone-paired) · weigh-to-count · operator warehouse hub · continuous drift alerts (Bruno 2026-08-18: "go and do it all, make sure the hub is awesome")

Rules in force: StockService = only writer of quantities · no lines added to too-large files (`src/routes/op.js`, `src/op/app.js`, `src/v3/data/router.js`) · new modules · every new route/table/worker → ARCHITECTURE.md + map S15 + process-registry · `npm test` green · no em dashes · PT-BR UI.

## Decisions (Bruno round 3/4)
- Product total = Veeqo total for now (import), later our system controls Veeqo (Stage 1 live deduction mirror; Stage 2 push entradas/adjustments).
- Reconciliation is CONTINUOUS (every 10 min via veeqo cache); Slack alert immediately on NEW drift (dedupe 1/product/day) + 08:00 NY digest; never auto-overwrite.
- Scanning: phone paired to a computer (pairing QR), every scan pushed live to that computer; manual entry always possible; also works with a USB HID scanner (just types).
- Counting: weigh-to-count with unit weight per product + tare per empty bin/box; manual count always possible; count-at-zero; blind cycle counts.
- Locations: `A03B2` style codes, boxes `BX-0451` never reused, labels = big code + Code 128 + small QR; boxes labeled with product + qty (+ lot) and sealed.

## Schema — migration `072_warehouse_ops.sql` (+down)
- `v3.products` ADD `unit_weight_g NUMERIC(8,2)`, `unit_weight_samples INT DEFAULT 0`, `unit_weight_updated_at TIMESTAMPTZ`.
- `v3.stock_bins` ADD `tare_g NUMERIC(8,2)`, `capacity INT` (default 48); `v3.stock_boxes` ADD `tare_g NUMERIC(8,2)`, `batch_number TEXT`, `sealed BOOLEAN DEFAULT false`, `label_printed_at TIMESTAMPTZ`.
- `v3.tare_presets` (id, name UNIQUE, kind 'bin'|'box', tare_g, active) — reusable empty weights.
- `v3.stock_change_requests` ADD `meta JSONB` (weigh details: gross_g, tare_g, unit_weight_g, computed_qty, residual_g).
- `v3.scan_pairs` (code TEXT PK 6-char, session_token TEXT (kiosk), person_id, created_at, expires_at (15 min renewable), last_seen_at, phone_ua TEXT).
- `v3.stock_movements` kind CHECK + `import` (Veeqo initial import).
- Indexes as sensible.

## Backend contracts
### Warehouse API (admin) `/api/v3/warehouse/*` — additions
- `POST import-veeqo {product_id?}` (manage_stock): for each product with a base veeqo SKU: `delta = veeqo.physical − our_total`; if delta > 0 → `StockService.storeIn` into unplaced (`source:'veeqo_import'`, `source_ref:'veeqo_import:<sku>:<yyyy-mm-dd>'`, idempotent per day, kind 'import'); if delta < 0 → do NOT deduct automatically; return it in `negative:[{product_id, delta}]` for manual review; if delta == 0 skip. Response `{data:{imported:[{product_id, delta}], negative:[...], skipped:n}}`. Bulk when no product_id (cap 500). Also refresh veeqo cache first.
- `GET weights` → `{data:{products:[{product_id, name, nickname, unit_weight_g, samples, updated_at}], tares:[{id,name,kind,tare_g,active}], bins:[{id,bin_code,tare_g,capacity}], boxes:[{id,box_number,tare_g,batch_number,sealed}]}}`
- `POST weights/product/:id {unit_weight_g?, sample_gross_g?, sample_count?, sample_tare_g?}` — direct set OR calibrate from a sample (unit = (gross−tare)/count; store samples count) · `POST weights/tare {name, kind, tare_g}` (upsert) · `POST weights/bin/:id {tare_g?, capacity?}` · `POST weights/box/:id {tare_g?, batch_number?, sealed?}`.
- `POST count/compute {product_id, gross_g, tare_g?, bin_id?|box_id?}` → `{data:{unit_weight_g, tare_g, net_g, qty, residual_g, confidence:'high'|'medium'|'low'}}` (confidence by residual/unit ratio; low if no unit weight).
- `GET labels?bins=1,2&boxes=3` → `{data:{labels:[{kind:'bin'|'box', code, line2 (shelf/area or product), line3 (qty/lot), url}]}}` — the dashboard renders Code128+QR client-side and prints 4×6.
- `POST locations/box/:id/label-printed` → stamps `label_printed_at`.
- `POST skus/import-upc` (manage_stock): copy Veeqo `upc_code` into `product_skus.barcode` for mapped SKUs → `{data:{updated:n}}`.
- `GET drift` → current drift list (products with veeqo_match drift, delta) — for the Slack worker + hub.

### Operator API `/api/v3/op/*` — additions (all handlers in NEW `src/v3/warehouse/op-warehouse.js`; op.js only registers thin routes; op.js line count must not increase — compress or move existing helper lines to the new module if needed)
- `POST scan/pair` (session) → `{ok, code, expires_at, url:'/scan/?c=<code>'}`; `GET scan/stream?code=` (SSE, kiosk side; auth = page token + session; keeps alive; events `{type:'scan', code:'<barcode>', symbology, at}`); `POST scan/push {code, barcode, symbology?}` (PHONE side: NO kiosk session; auth = the pair code itself; 410 if expired) → broadcast to the kiosk stream; `POST scan/keepalive {code}`; `GET scan/resolve?barcode=` (session) → `{ok, kind:'bin'|'box'|'product'|'unknown', bin?|box?|product?}` (matches bin_code, box_number, product_skus.barcode/UPC, sku, or the QR URL forms).
- `POST stock/organize {product_id, qty, bin_id?|box_id?}` (session; operator move from unplaced → location = `StockService.place`, IMMEDIATE, source 'op_kiosk') → `{ok, applied, product}`.
- `POST stock/count/weigh {product_id, bin_id?|box_id?, gross_g, tare_g?}` (session) → computes qty (same as count/compute) and creates a request kind 'count' with `meta` (weigh details) → `{ok, request_id, qty, confidence}`; `POST stock/count/manual {product_id, bin_id?|box_id?, qty}` → request kind 'count'. Both are proposals (RULE: total-changing waits approval); zero-count (qty 0) allowed = count-at-zero.
- `GET stock/tasks` (session) → today's suggested cycle counts (2 bins: oldest last-count/highest velocity) + bins with needs_restock + unplaced products → `{ok, counts:[...], restock:[...], organize:[...]}`.
- `GET stock/lookup?q=` (session) → products (name/nickname/sku/barcode) for manual entry.
- `POST stock/box/new {product_id, qty, batch_number?, area?}` (session; PROPOSAL kind 'entrada' with meta box; when approved, StockRequestService creates the box + storeIn) — box number is allocated at approval time. Also `GET stock/box/label?box_id=` (session) → label data for the operator hub to print.

### Worker `src/workers/stock-drift-alert.js` (opt-in `WORKER_STOCK_DRIFT_ENABLED='true'`, 10 min): reads `/drift` logic (call the router's drift function directly, not HTTP), alerts admin-orin on NEW drift (dedupe per product per NY day via audit_log action `stock_drift_alert`), and at 08:00 NY posts a digest of all drifting products. Message style memory: short, no em dash, 1 emoji max. Register in `src/v3/process-registry.js` (key `stock_drift`, where railway, tickMs 600000, heartbeat true, enabledEnv, staleMin 30) and wire in `wire.js` like the other opt-in workers.

## Dashboard (dashboard-v4)
- Hub: header button **"Importar da Veeqo"** (bulk, 2-step confirm showing how many products/deltas; result toast: imported / negative for review) + per-row action "Importar Veeqo" for one product; drift KPI links to the drift list.
- Locais: bins/boxes tables gain **tare** and **capacity/batch/sealed** fields; **"Imprimir etiquetas"** (select bins/boxes → print page: 4×6 per label: big code, Code 128 (client-side SVG encoder, no CDN), small QR (npm `qrcode` bundled in dashboard-v4), line2/line3) ; box label variant with product + qty + lot; stamp label-printed.
- Product Setup: **unit weight** column with "Calibrar" (gross of N bottles + tare → unit) and manual set.
- Config (Configurações de inventário): **tare presets** section.
- Aprovações: show `meta` weigh details on count requests (gross, tare, unit, computed, confidence).
- Hub product drawer → Config tab shows unit weight + tares.

## Operator warehouse hub `/op/estoque/` (NEW static page under the existing `/op` mount: `src/op/estoque.html`, `src/op/estoque.js`, shares `/op/style.css` + STYLE-KIT inline tokens like the Central; login = same PIN flow as /op via `/api/v3/op/auth/login` + `/op/config.js` page token; PWA-friendly)
- Home: big buttons **Organizar · Contar · Repor · Entrada (caixa nova) · Devolução · Danificada** + "Parear celular" (shows pairing QR + code; status "celular conectado"); scan input always focused (USB scanner types here) + manual search.
- **Organizar**: scan bin (or pick) → scan bottle/box (UPC / box label) → qty → `stock/organize` (immediate). Shows unplaced qty for that product and where its home shelf is.
- **Contar**: scan bin/box → choose Pesar (gross g; tare auto from bin/box or preset; shows computed qty + confidence; confirm → `stock/count/weigh`) or Contagem manual (qty → `stock/count/manual`); "Está vazio" one-tap = count 0.
- **Repor**: same as Central's Repor prateleira (reuse endpoint).
- **Entrada (caixa nova)**: product (scan UPC) + qty + lot (batch) → proposal; after approval the box gets a number; "Imprimir etiqueta" prints the box label from the hub (browser print 4×6).
- **Devolução / Danificada**: existing endpoints (`stock/take` damaged; `stock/propose` return_in).
- Tarefas de hoje card from `stock/tasks`.
- Every action: toast + "Registrado hoje" list with states (reuse recent).
- **Phone page `/scan/`** (NEW static: `src/scan/index.html` + `scan.js`, mounted at `/scan` in wire.js next to `/print`): opens camera, decodes with `BarcodeDetector` when available else a vendored decoder (`src/scan/vendor/zxing.min.js`, MIT — copy from node_modules if `@zxing/library` is installable in dashboard-v4 devDeps and copy the UMD; otherwise vendor `jsQR` for QR + rely on BarcodeDetector for 1D), pairs via `?c=` from the QR, POSTs `scan/push`, shows a green flash + the code; keepalive; works offline-tolerant (retries). No login on the phone (pair code is the credential; short-lived, renewable from the kiosk).

## Tests
Backend: `warehouse-router-phase3.test.js` (import-veeqo delta rules incl. negative not applied, weights calibrate math, count/compute confidence, labels data, drift), `op-warehouse.test.js` (pair/push/stream contract with a fake SSE sink, resolve barcode, organize immediate, count weigh proposal with meta, tasks), `stock-drift-alert.test.js` (dedupe/day + digest hour). Dashboard: harness screenshots (hub import button, Locais labels page, Product Setup unit weight, Aprovações meta). Operator hub + phone: puppeteer harness `docs/architecture/_qa/qa-op-estoque.js` (login, organize flow with typed scans, count weigh math, pairing QR renders). Root jest green; op-redesign whitelist updated for new endpoints (scan file too).

## Docs (RULE #2): ARCHITECTURE.md (routes, tables, worker), map S15 (new rows S15.23+), process-registry, Obsidian, memory.
