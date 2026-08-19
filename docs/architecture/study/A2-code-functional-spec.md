# FUNCTIONAL SPEC — Warehouse Inventory + P&P + Picklist + Print + Stock (as-built, 2026-08-18)

Project root: `c:\Claude Projects\Supplements Production Line\healthfare-tracker`. All paths below are relative to it unless absolute.

---

## A. Operator workspace "Central de P&P & Estoque" (`src/op/app.js`)

### A.1 Gating / open / close rules
| Rule | Code |
|---|---|
| Task slugs that own the workspace: `WS_SLUGS = { order_printing:1, order_printing_2:1, stock_organization:1 }` | `src/op/app.js:455` |
| `wsAllowed()` = `CFG.workspace === true \|\| isSandbox()`; `CFG.workspace` comes from `/op/config.js` → `process.env.OP_WORKSPACE_ENABLED === 'true'` | `app.js:456`, `src/routes/op.js:89-97` |
| `wsTask()` = first open task in `S.myTasks` whose slug is in WS_SLUGS **or** whose activity type meta has `counts_as_pp` | `app.js:457` |
| Banner `wsBanner()` renders on home only if `wsAllowed() && wsTask()`; inserted after pause banner in `homeInner` | `app.js:458-466`, `:750` |
| Auto-open: after a **live** (non-retroactive) `event/start` succeeds and `WS_SLUGS[f.slug]` → `S.workspaceOpen = true; loadWorkspace()` | `app.js:1907-1909` |
| Manual open: `ACT.openWorkspace` (banner "Abrir" button) | `app.js:1588` |
| Close: `ACT.closeWorkspace` ("← Voltar"), `endSession()` (logout), and **auto-close** on `loadData()` when `S.workspaceOpen && !wsTask()` → toast "Tarefa concluída — Central fechada" | `app.js:1589`, `:1834`, `:1521` |
| While open with a WS task: auto-logoff timer is kept refreshed (`S.logoffLeft = auto_logoff_seconds`) | `app.js:2252` |
| Day-rollover reload and version reload are suppressed while workspace open | `app.js:2271`, `:2278` |
| Layer: `#lyr-workspace` absolute inset:0, z-index 35 (above home=3, below flow=40) | `src/op/style.css:77`, mounted `app.js:303` |
| State: `S.ws = { picklist, recent, q, sel, qty:'1', kind:'pick', reason:'', busy, gaps }` | `app.js:468` |
| Re-render key `workspaceKey()` = q, sel.id, qty, kind, busy, picklist totals, recent length | `app.js:610-616` |

### A.2 Banner (home)
`app.js:460-465`: gradient card `linear-gradient(135deg,#0d1f3c,#1a3a6b)`, radius 20, padding 18×20, shadow `0 22px 44px -20px rgba(13,31,60,.6)`; icon box 50×50 radius 16 `rgba(255,255,255,.12)` with 📦; title Georgia serif 21px white "Central de *P&P & Estoque*" (em `#7fd696` italic); subtitle 13px `rgba(255,255,255,.75)` "Picklist do dia, registrar saída de estoque e organização"; white pill button "Abrir" (h46, padding 0 26, Sora 800 15px, color `#0d1f3c`).

### A.3 Data loading (`loadWorkspace`, `app.js:467-473`)
Three parallel calls, each renders independently:
- `GET /api/v3/op/picklist` → `S.ws.picklist` (fallback `{groups:[], total_orders:0}`)
- `GET /api/v3/op/stock/recent` → `S.ws.recent = r.items`
- `GET /api/v3/op/stock-gaps` → `S.ws.gaps` (fallback `{items:[]}`)

### A.4 Screen layout (`workspaceInner`, `app.js:617-738`)
- Root: absolute inset 0, column flex, ground `#f4f8fc` + dot-grid `radial-gradient(circle,rgba(26,58,107,.06) 1px,transparent 1px)` size 26px.
- Header (padding 22px 34px 8px, gap 16): "← Voltar" secondary pill (border `#d4e2f0`, white, h42, Sora 700 14px `#1c2b3a`); eyebrow DM Mono 10px `.14em` uppercase `#2e8b3c` "● HEALTHFARE P&P · CENTRAL"; H1 DM Serif Display 30px `#0d1f3c` "Central de *P&P & Estoque*" (em `#2e8b3c`); sandbox chip (teal `rgba(10,154,166,.12)`/`#06707a` "sandbox · não conta no estoque real"); **PRINT** pill (navy `#0d1f3c`, h46, padding 0 26, Sora 800 15, "🖨 PRINT").
- Body: `.hf-scroll` padding 14px 34px 40px; grid `1.2fr 1fr`, gap 20, max-width 1240 centered.
- **Stock-gaps card** (grid-column 1/-1, shown while loading or when items exist): white card border `#d4e2f0` (or `#f5cdc7` if `critical_count>0`), radius 18, shadow `0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05)`, padding 16×20; mlabel "Falta de estoque pro P&P de hoje"; count chips `N zerado(s)` (bad: `#fdeeec`/`#a02c20` inset ring `#f5cdc7`) and `N baixo(s)` (warn: `#fdf6e3`/`#6b4c07` ring `#eeddad`); body `wsGapsHtml()` (`app.js:476-495`): loading "verificando estoque…", empty "✓ Tudo que precisa hoje tem estoque." (`#1e6b2e` 600), else per item a tinted row (crit → bg `#fdeeec` border `#f5cdc7` text `#a02c20`; else `#fdf6e3`/`#eeddad`/`#6b4c07`) with product name 800 13.5px, DM Mono 11px `#54687c` "precisa N · tem M", `ZERADO` solid pill (`#a02c20` white DM Mono 10 700) when `status==='out'`, advice line 12.5px.
- **Column 1 — PICKLIST card** (`app.js:645-687`): white card as above, padding 18×20. Header row: mlabel "Imprimir ordem · picklist de hoje" + "Atualizar" small pill (h30, `#f7fafd`, border `#d4e2f0`, 12px 700). States: `!picklist` → "Carregando picklist…"; empty → "Nenhum pedido pendente pra separar agora." (`#6b7f92` 13px). Otherwise:
  - Totals row of 3 neutral chips (h24, `#eaf0fb`/`#1a3a6b`, inset ring `#d4e2f0`, DM Mono 11): `{total_orders} pedidos`, `{total_bottles} garrafas`, `{product_count||groups.length} produtos`.
  - **Envelope chips row** (only if `envelopes` has keys or `envelopes_unknown`): mlabel "Envelopes:" (DM Mono 10 `.08em` `#6b7f92`); sizes sorted numerically with `BX` last (`parseFloat` compare, `app.js:660`); each a **navy solid chip** (h26, `#0d1f3c` white, DM Mono 12 700, count `<b>` 14px); pending `+N sem tamanho` warn chip when `envelopes_unknown + envelopes_mixed > 0`.
  - **Group rows** (per product; no per-order rows): `border-top:1px dotted #c6d7e8`, padding 10×2, column gap 3. Row 1: `SKU:` label + DM Mono 14 700 `#0d1f3c` sku, spacer, `QTY:` label + DM Mono 16 800 `#0d1f3c` total bottles (sum of `orders[].bottles`). Row 2: `Title:` + 13.5px 600 `#1c2b3a` ellipsis `wsShortTitle(g)`. Row 3: `Location:` + DM Mono 12 600 `#1a3a6b` "SHELF x · BIN y · PALLET z" or `#6b7f92` "local a definir". Labels via `lbl()` = DM Mono 10 `.08em` uppercase `#6b7f92` (`app.js:674`).
  - **Walking order = server order** (see B.1); no client sort.
- **Column 2** (`app.js:690-734`): stacked cards gap 16:
  1. **Registrar saída de estoque** (see A.6).
  2. **Registrado hoje**: mlabel; "carregando…" / "Nada registrado ainda." / list rows (`border-top:1px dotted #c6d7e8`, padding 7×2, 13px): name (`nickname||product`, 600 `#1c2b3a`, ellipsis) + DM Mono 12 700 `×{qty}` + chip: damaged → bad chip "danificada" (`#fdeeec`/`#a02c20`), else ok chip "saiu" (`#e8f7ea`/`#1e6b2e` ring `#c8ecce`).

### A.5 Title/location helpers (`app.js:504-555`)
- `wsCleanName(g)`: prefer `g.product` (canonical); else `title.split('|')[0]` cut at first `\d+(mg|mcg)` or `\d+ (caps|tablets|…)`; strip "healthfare", `-C\d` suffix, mg/mcg tokens, non-alnum.
- `wsMg`, `wsCaps` (from `content_desc` first, then title), `wsPack` (`\bC(\d+)\b` from sku/product).
- `wsShortTitle` = `clean + ' mg' + ' caps' + ' · C2'`; `wsPrintTitle` = `CLEAN.toUpperCase() + ' 300mg' + '/200caps' + ' C2'`.
- `wsLocation` = `SHELF s · BIN b · PALLET p` or `LOCAL A DEFINIR`.

### A.6 "Registrar saída de estoque" flow (`app.js:691-717`, handlers `:1592-1616`)
1. Intro text: "Pegou garrafa fora de um pedido? Registra aqui em 3 segundos. Nunca trava, só registra."
2. Search input `data-input="wsQ"` (placeholder "busque o suplemento…", 15px, `#f7fafd`, radius 12). `wsSupps()` (`app.js:496-503`) filters **client-side static** `DATA.supplements` (from `/op/fuse-data.js`, `window.HF_DATA`) by `canonical_name` or `aliases` contains q (min 2 chars), max 8. Results as full-width text buttons `data-act="wsPick"` (14.5px 600, dotted separator). No match → `nada com "q"`.
3. Selected: pill panel with DM Serif 19px name + "trocar" (`wsClear`).
4. Qty stepper: `−` / input `wsQty` (90px, 22px 800, `inputmode=numeric`) / `+` (52×52 buttons), min 1 (`wsQtyDelta`, `app.js:1598-1602`), label "garrafas".
5. Kind segmented control (`wsKind`): "Peguei do estoque" (`kind='pick'`, active navy `#0d1f3c`) / "Danificada" (`kind='damaged'`, active red `#a02c20`).
6. Reason input `wsReason` (placeholder differs by kind: "o que aconteceu? (opcional)" vs "motivo · ex.: extra pro pedido 12-345 (opcional)").
7. Submit pill "Registrar saída" (h52, navy, Sora 800 16). `wsSubmit` validates qty ≥ 1, POSTs `/api/v3/op/stock/take` `{product_id, qty, kind, reason|null}`; success toast "Garrafa danificada registrada" / "Saída registrada — obrigado!", resets sel/qty/reason, refetches `stock/recent`. Error → toast `Erro: e.message`.
- **Effect** (see B.2): raw INSERT into `v3.stock_movements` with `qty = -qty`, `source='op_kiosk'`, no bin/box, no StockService, no idempotency, no bin qty change.

### A.7 PRINT 4×6 (`wsPrint`, `app.js:573-608`)
Opens `window.open('', '_blank')`, writes a full HTML doc, `window.onload → window.print()`. Toast "Picklist vazia" if no groups; "Popup bloqueado — libera popup pra imprimir" if blocked. Exact printed layout:
- `@page { size: 4in 6in; margin: 0.12in }`; body Arial/Helvetica, black.
- `.hdr` (10px bold, 2px black bottom border, padding 1px 0 3px): `PICKLIST · dd/mm/yyyy · {total_orders} ORDENS · {total_bottles} BOTTLES`.
- `.env` block via `wsEnvelopesHtml(pl)` (`app.js:558-570`; only if sizes or unknown): 11px 900, 2px bottom border, padding 3px 0 4px, mb 3: `.ttl` "ENVELOPES:" 8.5px bold `.06em`; each `.e` inline (mr 10) `{size} <b>{n}</b>` with `b` 15px; `.warn` block 8.5px bold "+ N outras a definir" (unknown+mixed).
- One `.row` per group (`break-inside: avoid`, 1.5px black bottom border, padding 4px 0 5px):
  - `.id` line 10px lh 1.15: `<span.sku>` Consolas bold `{sku}` + `<span.nm>` bold `{wsPrintTitle}` (e.g. `HF-BENF-300 BENFOTIAMINE 300mg/200caps`).
  - `.big` flex space-between baseline, mt 2: `.loc` 17px 900 `.01em` (`SHELF … · BIN … · PALLET …` / `LOCAL A DEFINIR`) + `.qty` 14px 900 nowrap ml 8 `QTY <b>{tot}</b>` with `b` 22px.
- No per-order rows, no customer names, no channels printed.

### A.8 CSS the workspace uses
- `src/op/style.css`: `#lyr-workspace` (`:77`), `.hf-layer/.hf-layer.on` cross-fade (`:59-66`), `.hf-scroll` thin scrollbar (`:83-85`), global `button:active{scale(.97)}` (`:106`), body font Manrope + color `#0c2545` (`:12`). Everything else is inline styles.
- `src/shared/hf-design.css` tokens (`:11-41`): `--hf-blue-deep #0f4c92`, `--hf-green-dark #0e7a4e`, `--hf-text-primary #0c2545`, `--hf-font-body Manrope`, `--hf-font-display Sora`, radii `--hf-r-sm 8 / md 14 / lg 20 / xl 26 / pill 34`, `.hf-glass`, `.hf-btn-*`, `.hf-chip-*` (`:78-100`). **The workspace does not use these classes**; it uses the STYLE-KIT palette inline (see H).

---

## B. Backend picklist + operator stock endpoints

### B.1 `GET /api/v3/data/picklist` (`src/v3/data/router.js:1009-1122`)
Auth: data-router PIN middleware (`router.js:1736`, `auth.js:56-73`) — any valid `v3.app_logins` PIN or `ADMIN_PIN` fallback; **no per-function check**.
Inputs: none. Data sources: `veeqoNamesByOrder()` (SWR 10 min, awaiting_fulfillment pages ≤20, `router.js:189-212`), `veeqoStockBySku()` (SWR 10 min via `veeqo.listSellables()`, `:168-184`), SQL over `v3.pnp_order_lines l WHERE l.status='pending'` (`:1015-1043`) LEFT JOIN `v3.product_skus ps ON ps.channel=l.source AND UPPER(ps.sku)=UPPER(l.sku)`, `v3.products p`, `best_bin` (DISTINCT ON product_id, active, qty DESC), `best_box` (in_storage, qty DESC), catalog `content_desc`. `bottles = qty * COALESCE(units_per_pack,1)`.
Grouping key: `'p:'+product_id` or `'sku:'+sku` (`:1048`). Per group orders sorted single-first then by order_number (`:1071`); `multi_summary`, `single_count`, `multi_count`, `order_count`. Group order = **walking order**: groups with `shelf+bin` first, `localeCompare(shelf+bin)` then product name; unlocated last (`:1083-1088`).
Envelopes (`:1092-1117`): 1 per **order** — sum bottles across the order's lines, collect `bottle_color`s; `colors.size>1` → `envelopes_mixed++`; no color → `envelopes_unknown++`; else find tier in `v3.bottle_size_tiers` with `bottle_color===color && min≤bottles≤max` → `envelopes[package_size]++`, no tier → unknown. **NOTE**: default tiers with `bottle_color IS NULL` are never matched (comparison is `x.bottle_color === color`).
Output:
```json
{ "groups":[{ "key","product","nickname","sku","bottle_color","content_desc","product_id",
  "veeqo_stock": number|null, "location":{"shelf","bin","pallet","area"}, "title","mapped":bool,
  "orders":[{"order_number","channel","sku","qty","bottles","multi":bool,"picker":null,"packer":null,"patient":string|null}],
  "multi_summary":[{"bottles","orders"}], "single_count","multi_count","order_count" }],
  "total_orders":int, "total_bottles":int, "product_count":int,
  "envelopes":{"<size>":n}, "envelopes_unknown":int, "envelopes_mixed":int, "names_loading":bool }
```
(`total_orders` is actually the number of pending **lines**, `:1089`.)

### B.2 `GET /api/v3/data/stock-gaps` (`router.js:1206-1213`)
Calls the picklist handler, then `new StockGapService({db, ems}).analyze(pl.data)` (D.3). Output `{ items:[{product_id,sku,product,nickname,needed,stock,status:'out'|'low',action,advice,severity:'critical'|'warn',ems_batch}], out_count, low_count, critical_count }`.

### B.3 Operator endpoints (`src/routes/op.js`)
All under Bearer `OPERATOR_PAGE_TOKEN` gate (`op.js:100-104`) + `requireSession` (kiosk session).
| Route | Line | Gate | Does |
|---|---|---|---|
| `GET /api/v3/op/picklist` | 293-299 | session | lazily requires data-router `ENDPOINTS`, runs picklist handler with `buildServices(db)`, returns `{ok:true, ...data}` |
| `GET /api/v3/op/stock-gaps` | 303-309 | session | same for stock-gaps handler |
| `POST /api/v3/op/stock/take` | 314-329 | session | body `{product_id:int, qty:1..5000, kind:'pick'\|'damaged', reason≤300}` → **raw** `INSERT INTO v3.stock_movements (kind, product_id, qty=-qty, person_id, source='op_kiosk', note, is_test=is_sandbox)`; returns `{ok, movement_id}` |
| `GET /api/v3/op/stock/recent` | 332-343 | session | last 20 of the operator's `op_kiosk` movements in 16h, `is_test = is_sandbox`; `{ok, items:[{id,kind,qty(positive),note,created_at,product,nickname}]}` |
| `GET /api/v3/op/stock/context` | 2963-2978 | `stockUiAllowed` | `{enabled:false}` when off; else `{enabled:true, products:[{id,name}], bins:[{id,bin_code,shelf_code,area,qty,min_qty,product_id,product,needs_restock}], boxes:[{id,box_number,area,qty,product_id,product}]}` |
| `POST /api/v3/op/stock/store` | 2981-3013 | `stockUiAllowed` (403 `stock_ui_disabled`) | body `{product_id, qty>0, bin_code \| box_number(+area), authorized_by?, note?}`; resolves bin (400 `bin_unknown`) or upserts box (`status='in_storage'`); `StockService.storeIn(source:'op_kiosk', actor_type:'operator', is_test)`; actionLog `stock_store`; `{ok, movement_id, applied}` |
| `POST /api/v3/op/stock/restock` | 3016-3032 | same | `{bin_id, box_id, qty, found_bin_qty?, found_box_qty?, note?}` → `StockService.restock`; `{ok, applied, box_left, bin_now}` |
| `POST /api/v3/op/stock/damaged` | 3035-3047 | same | `{product_id, qty(def 1), reason('label'\|'seal'\|'other'), bin_id?, note?}` → `StockService.damaged`; `{ok, issue_id, applied}` |
| `POST /api/v3/op/stock/count` | 3050-3064 | same | `{bin_id \| box_id, found≥0, note?}` → `StockService.count`; `{ok, delta}` |
`stockUiAllowed(s)` (`op.js:2956-2961`): `STOCK_UI_ENABLED==='true'` OR `s.is_sandbox` OR `person_id ∈ STOCK_UI_ALLOWLIST` (comma list). `stockKiosk` StockService instance with `onDiscrepancy → INSERT v3.data_incidents kind='stock_<kind>' severity 'warning'` (`op.js:2941-2955`). **The /op client currently calls none of context/store/restock/damaged/count** (grep of `src/op/app.js` shows only picklist/stock-gaps/stock/take/stock/recent).

**Why `stock/take` is a raw INSERT** (`op.js:311-329`): comment "Ledger append-only (v3.stock_movements), RULE #0: nunca bloqueia, só registra." It bypasses StockService because it has no bin/box target (product-level only) and must never fail; consequence: it does **not** decrement any `stock_bins.qty`, has no `(source,source_ref)` idempotency, no audit_log row, no `stock_issues` row for `damaged`, and is invisible to `StockRepo.movements()` only via `is_test` filter (it *is* visible there since is_test=false for real operators, `stock-repo.js:76-90`).

### B.4 Admin data-router stock endpoints (`router.js`)
Reads (`:759-782`): `/stock/bins`, `/stock/boxes`, `/stock/summary`, `/stock/issues`, `/stock/movements?limit&product_id`, `/stock/picksheet?date`, `/stock/restock-list`, `/stock/skus`, `/stock/planner` (→ `StockAlerts.compute()`).
Writes (`:786-890`): `POST /stock/bins` (upsert by bin_code, raw SQL), `POST /stock/boxes` (upsert, raw), `POST /stock/store|restock|count` → `StockService.*` with `source: b.source||'admin', actor_type:'admin'`; `POST /stock/adjust` → `StockService.adjust`; `POST /stock/issues/:id/resolve {status: relabeled|restocked|discarded}` (raw UPDATE `WHERE status='separated'`; if `restocked` and `bin_id` → `storeIn(source:'issue_resolve', source_ref:'issue:<id>')`); `POST /stock/skus/confirm {product_id, sku, channel='veeqo', units_per_pack=1, barcode}` (upsert with confirmed_at=NOW()); `POST /stock/thresholds {product_id, min_days, min_units}`.
Others: `GET /product-setup` (`:896-932`), `GET /stock-overview` (`:937-970`), `POST /stock/veeqo-set` (`:978-1004`, guard SKU must be `channel='veeqo'` mapped to product; `veeqo.setStock({sku,mode:'set'|'add',qty})` writes **only warehouse 108841**; audit `veeqo_stock_set`; invalidates `_stockCache`), `GET /inventory-settings` (`:1128-1146`), `POST /inventory-settings/tier|mix|question/:id` (`:1149-1202`), `GET /product-setup/tiers`, `POST /stock/tiktok-orders-csv` (`:1226-1235`), `GET /product-setup/channel-skus?channel` (`:1243-1279`), `POST /product-setup/:id {nickname?, bottle_color?}` (`:1282-1297`), `POST /product-setup/:id/sku {sku, channel, units_per_pack}` (`:1300-1317`), `POST /product-setup/sku/:skuId/detach` (`:1320-1326`), `GET /supplies`, `POST /supplies/item`, `POST /supplies/:id/change {kind:restock|adjust|count, qty}`, `POST /supplies/mapping` (`:1330-1403`), `GET /inventory` (legacy fuzzy matcher, SWR, `:2071-2079`, `_computeInventory` `:249-339`).
Gates: **only** `/rbac*` checks `hasFunction(req.login,'manage_users')` (`:1409, :1427, :1444`). No stock/picklist endpoint checks `view_stock`/`manage_stock`/`product_setup`. Error mapping: message containing "não existe" → 404, "obrigatóri|inválid|…" → 400, else 500 (`:2089-2097`). Envelope `{meta:{version:'v3',tz,generated_at,...}, data}` (`:438-445`).

---

## C. Dashboard pages (`dashboard-v4/src`)

Common: `usePoll(path, deps, ms)` / `apiGet/apiPost` add header `x-admin-pin` (`adapters/from-api.js:52-81, 104-121`); `can(fn)` reads `sessionStorage.v3login.functions` (`:45-49`); `V4_ALLOW_WRITES` default ON via `VITE_V4_ALLOW_WRITES` (`flags.js`). Nav (`components/Shell.jsx:18-56`): section **Operação** = Hoje, Roadmap, Produção, Metas, Pessoas, **P&P** (`pp`), **Picklist** (`picklist`); section **Estoque & Produtos** = Ver estoque (`estoque-geral`), Estoque detalhado (`inventory`), Product Setup (`produto-setup`), Configurações (`config-estoque`), Planejamento (`planejamento`, placeholder), Produto (`produto`); Admin items carry `fn` and are filtered by `can()` (`Shell.jsx:88`) — **no stock/picklist item is RBAC-gated**. Routes in `App.jsx:428-443`.

### C.1 `PicklistPage.jsx` (LAYOUT REFERENCE, 150 lines)
- Data: `usePoll('/picklist', [], 15000)` (`:76`).
- Scoped STYLE-KIT tokens under `.pl-root` (`:12-63`): `--primary #1a3a6b`, `--primary-deep #0d1f3c`, `--green-d #2e8b3c`, `--ground #f4f8fc`, `--surface #fff`, `--surface-2 #f7fafd`, `--line #d4e2f0`, `--line-strong #b9cbe2`, `--dotline #c6d7e8`, `--ink #1c2b3a`, `--ink-dim #54687c`, `--ink-faint #6b7f92`, ok `#e8f7ea/#c8ecce/#1e6b2e`, warn `#fdf6e3/#eeddad/#6b4c07`, neutral `#eaf0fb/#d4e2f0`, fonts DM Sans / DM Serif Display / DM Mono (Google `@import`), `--r-lg 18`, `--r-pill 999`, `--shadow-card`. Root padding 34px 30px 60px, dot-grid ground.
- Classes: `.pl-eyebrow` (DM Mono 500 10px `.14em` upper green), `.pl-h1` (serif 400 clamp(26,2.6vw,34) navy-deep, `em` italic green), `.pl-sub` (ink-dim 13.5), `.pl-mlabel` (mono 10 upper ink-faint), `.pl-card` (white, 1px line, r18, shadow-card), `.pl-kpi` (serif 34 navy tabular), `.pl-btn` (pill h38 pad 0 22 navy-deep white 600 13; `.sec` white+line), `.pl-chip` (h22 pad 0 10 pill mono 500 11; `.neutral/.warn/.ok` inset ring), `.pl-divider` (r18, 1px line-strong, gradient white→surface-2, pad 16×18, mt 22, `.name` serif 26 navy-deep, `.loc` mono 600 15 primary `.02em`), `.pl-orders` (border-top line), `.pl-order` (flex gap 12 pad 9×14 dotted bottom; `.onum` mono 500 13 min-w 180; `.who` ink-dim 12.5 flex 1), `.pl-warn` (600 12.5 warn-deep on warn-bg, r12, pad 8×12).
- Print CSS (`:55-62`): `@page 4in 6in margin .18in`; `.pl-noprint` hidden; `.pl-product{break-before:page}` except first; divider shadow off.
- Structure: header (`pl-noprint`): eyebrow "● HEALTHFARE P&P · PICKLIST", H1 "O que *separar hoje*", sub "Pedidos pendentes, agrupados por produto na ordem de caminhada. Single primeiro, multi no fim.", button "Imprimir / Baixar (4×6)" → `window.print()` (`:91`). KPI row (`pl-noprint`): 3 cards Pedidos / Garrafas / Produtos (`total_orders`, `total_bottles`, `product_count`, `—` fallback). Loading card "Carregando picklist…"; empty card "Nenhum pedido pendente pra separar agora." Per group `.pl-product`: `.pl-divider` with `.name`=nickname, warn chip "SKU não mapeado" if `!mapped`, spacer, neutral chip "N pedido(s)"; `.loc` = `loc(g)` (SHELF/BIN/PALLET or area; else ink-faint 400 "local a definir"); if `multi_count>0` `.pl-warn` "NO FIM · N pedidos de B garrafas · …". Then `.pl-orders` list: `.onum` order_number, `.who` = patient bold or italic "carregando nome…"/"sem nome" (by `names_loading`), neutral chip channel, warn chip "N garrafas" (multi, row bg warn) or ok chip "1 garrafa".
- No filters, no search, no RBAC gate, no writes.

### C.2 `InventoryPage.jsx` (580 lines) — "Estoque detalhado"
Polls (`:89-97`): `/inventory` 20s (legacy matcher SWR), `/stock/summary` 60s, `/stock-overview` 60s, `/stock/bins` 30s, `/stock/boxes` 60s, `/stock/planner` 120s only when tab=planner, `/stock/issues` 60s, `/stock/skus` once, `/supplies` 30s. Local components: `Tab({id,active,onClick,count,tone})` navy-700 active pill-ish button (`:25-41`), `StatChip({label,value,tone})` `.card` 10.5px upper label + `.mono` 20px 800 value (`:43-50`), `Th/Td/Table` (`:52-67`), `ZonePill` (`:69-72`), `inferPack(sku)` (`-C\d` → units) (`:75-78`).
Header: `.section-title` "Estoque · armazém · bins, caixas, planner, SKUs". Stat chips: Garrafas no armazém (sum summary total_qty), Bins p/ restock, Separadas (abertas), Urgentes (planner), SKUs confirmados `x/y`, Suprimentos baixos.
Toolbar: tabs `stock`(count ovRows) / `bins` / `boxes` / `planner` / `issues` / `supplies` / `matched` / `ours` / `veeqo` / `plans`; "⬆ TikTok CSV" file label → `apiPost('/stock/tiktok-orders-csv',{csv})` (`:229-247`); filter input `q` (client filter per tab keys).
Tabs:
- **stock**: SWR banner "Carregando estoque do Veeqo em segundo plano…"; empty "Sem produtos."; table Produto | Bins | Caixas | Armazém (total) | Veeqo; "BAIXO" tag when `has_veeqo_sku && veeqo_stock<=10`; footnote pointing to "Ver estoque" for edits.
- **bins**: empty "Nenhum bin cadastrado. Cadastre via POST /stock/bins (ou a tela de admin que vem na Fase B)."; cols Bin | Prateleira | Área | Produto | Qty | Mín | Status (RESTOCK pill).
- **boxes**: empty "Nenhuma caixa registrada."; cols Caixa | Área/palete | Produto | Qty | Status (vazia/em estoque).
- **planner**: empty text about 2 weeks history; cols Zona | Produto | Armazém | Marketplace | Vende/dia | Dias | Lead (d) | Batch EMS.
- **issues**: empty "Nenhuma garrafa separada…"; cols Produto | Qty | Motivo (label/lacre/outro) | Bin | Quem | Quando | Status | Ação — buttons "↩ estoque"(restocked) / "label ok"(relabeled) / "descarte"(discarded) → `apiPost('/stock/issues/:id/resolve',{status})` (`:128-133`).
- **supplies**: add-supply form (name + kind envelope/box/other) → `POST /supplies/item`; size→supply select per tier → `POST /supplies/mapping`; table Suprimento | Tipo | Tamanhos | Qty | Mín | Status | Ações (+ reabastecer / contar / mín via `window.prompt` → `POST /supplies/:id/change` or `/supplies/item`).
- **matched**: SWR notice; table Nosso produto | SKU Veeqo | Título | Match (exato/base/nome pill) | Confirmação (`confirmSku` → `POST /stock/skus/confirm {product_id, sku, channel:'veeqo', units_per_pack:inferPack}`).
- **ours** / **veeqo** / **plans**: read-only tables.
Gating: every write checks `V4_ALLOW_WRITES` else `ack('preview · …')`. No RBAC.

### C.3 `StockOverviewPage.jsx` (211 lines) — "Ver estoque"
`usePoll('/stock-overview', [], 60000)`. Chips (`Chip` = same as StatChip): Armazém (bins+caixas), Estoque Veeqo (total), Baixo no Veeqo (≤10). Search + "só estoque baixo" checkbox + count. Table (`:169-203`): Produto | Nickname | Bins | Caixas | Armazém (total) | **Veeqo** (border-left 2px separator; "…" if `has_veeqo_sku` and null; "—" no SKU; BAIXO tag ≤10) | `editar` button (disabled if `!V4_ALLOW_WRITES`; "sem SKU Veeqo" otherwise). Footnote explains bins+caixas=Armazém, Veeqo separate.
`EditStockModal` (`:25-111`): shows product + nickname, SKU (single fixed / select if several), mode segmented **Contar (=)** `set` / **Somar (+)** `add`, numeric input, preview "Estoque Veeqo: cur → preview", two-step **Revisar…** then red **Confirmar: {sku} → {preview}** → `apiPost('/stock/veeqo-set',{product_id, sku, mode, qty})`; on success optimistic `localStock[id]=res.after`, flash "✓ sku: before → after no Veeqo". Text under confirm: "Isso grava no Veeqo (armazém HealthFare)."

### C.4 `ProductSetupPage.jsx` (313 lines)
`usePoll('/product-setup', [], 0)` + `apiGet('/product-setup/tiers')`. Search over name/nickname/skus; counters "N sem nickname", "N sem cor"; `(somente leitura)` when `!V4_ALLOW_WRITES`. Tier info card lists default tiers (`bottle_color` null) as "1–1 → A · 2–6 → Y …". Table (`:299-310`): Produto (inactive tag, **HOLD — NÃO IMPRIMIR** pill from catalog `on_hold`) | Nickname (input, suggested = SKU minus `HF-`/`HFC-` prefix, save on Enter/blur → `POST /product-setup/:id {nickname}`) | Cor da garrafa (`ColorPicker`: —/Black/White/Other… text → `{bottle_color}`) | Estoque Veeqo (sum of veeqo SKUs; red ≤0) | Validade (rótulo) (MM/YYYY; red <6 months, amber <12) | SKUs (por canal) (`SkuChips`: colored chips per channel `CH_COLOR`, "×" detach → `POST /product-setup/sku/:id/detach`; "+ SKU" → channel select + `SkuPicker` searchable dropdown fed by `/product-setup/channel-skus?channel=` cached 10 min, taken SKUs disabled "já → product", free-text fallback → `POST /product-setup/:id/sku {sku, channel}`). **No image column/upload exists** (images not implemented on this page).

### C.5 `InventorySettingsPage.jsx` (234 lines)
`usePoll('/inventory-settings', [], 0)`. Scoped `.is-*` STYLE-KIT tokens (adds bad `#fdeeec/#f5cdc7/#a02c20`) (`:12-49`). Header eyebrow "● HEALTHFARE · CONFIGURAÇÕES", H1 "Configurações de *inventário*". **Section A "Ordens e impressão"**: pending `packing_questions` card (warn tinted; chip "perguntada Nx", answer chip, button "Já resolvido, desligar" → `POST /inventory-settings/question/:id {active:false}`); "Tamanho do envelope por cor de garrafa" table Cor | De | Até | Envelope (inputs on blur → `POST /inventory-settings/tier {id, min_bottles|max_bottles}`); "Mistura de cores no mesmo envelope" table Envelope | Pretas | Brancas (até) | Status (confirmado/suposição) (blur → `POST /inventory-settings/mix {package_size, black_qty, white_max, confirmed:true}`); "Suprimentos e mapa tamanho → suprimento" (todo box if none; else read table Suprimento | Tipo | Qtd | Mínimo | Tamanho ligado). **Section B "Inventário e estoque"**: chips "N bins cadastrados", "N limiares", and an explicit TODO list (Bins e locais, Limiares, Cycle counting, Botão "peguei do estoque", Reconciliação) (`:212-231`). Writes gated by `V4_ALLOW_WRITES` (`ro`).

### C.6 `OtherPages.jsx` `PickPackPage` (`:314-417`)
Source `raw.pp` from `/api/v3/data/pp` (flow-views `pnpByDay`, `src/v3/data/flow-views-repo.js:381-405`). Renders `.section-title` "Pick & Pack do dia"; `CountdownCard` Correio if `pp.deadline_min`; 3 `KPI`: Tempo total (união) + live count, Ordens (`pp.orders`), Tempo/ordem; Sub-passos list (`sub_steps` sorted by wall_seconds; shows parede + pessoa-hora + "(cowork)"); Carga por pessoa grid (`person_seconds`); cowork count footer. Empty: "Nenhum sub-passo de P&P registrado em {date}." Read-only.

### C.7 `CommandCenter.jsx` P&P card (`:795-884`)
`KPI label="P&P do dia"` value `fmtDur(pp.total_minutes)`; foot: **ordens** (`pp.orders_reset` → old total struck + new red + "editado", else `pp.orders`), **Veeqo** (`usePoll('/veeqo-today',[],180000)`, `:300`) `total_orders` and diff `digitado − Veeqo` colored ✓/+n/−n, **seg/ordem**, **corte** (correio deadline, red "vencido"), tempo por pessoa pills + soma + média/pacote; gear `EditPopover` "Editar P&P · correio" → `writes.patchDeadline(id,{time_of_day})` gated by `V4_ALLOW_WRITES && writes`. Separate KPI "Pedidos hoje · VEEQO" from `raw.veeqo` (`shippedByDay`: total_orders, total_units, by_channel, by_product) (`:889-934`).

Reusable dashboard CSS (`dashboard-v4/src/styles.css`): `.card` (`:399`, r16, `--surface`, `--border`, `--shadow`), `.pill` (`:450`, h22 pad 0 9 pill 11.5 600; variants `.prod .pnp .support .warn .bad .ok .live`), `.mono` (`:137` JetBrains Mono tabular), `.section-title` (`:560-570`), tokens `--hf-navy-500 #2855ad`, `--hf-navy-700 #1a3375`, `--hf-leaf-600 #18934c`, `--hf-leaf-700 #14773f`, `--flow-pnp #d97706`, `--warn #d97706`, `--bad #dc2626`, `--surface-2 #f7f9fc`, `--border #e3e8f0`, `--text-2 #35425e`, `--text-3 #4d5b78` (`:16-66`, dark overrides `:92-100`). `.alert-row` in `extras.css`.

---

## D. Data + services

### D.1 `StockService` (`src/v3/services/StockService.js`)
`KINDS = ['store_in','pick','restock','adjust','damaged','count']` (`:23`). Every op runs in a tx (`_withTx` `:39-53`), writes `v3.stock_movements` via `_insertMovement` with `ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING` → `{movement, duplicate}` (`:75-89`), updates bin/box qty in same tx, writes `v3.audit_log target_type='stock_movement'` (`:55-64`), and calls `onDiscrepancy` (never throws, `:122-125`).
| Method | Params | Rules | Returns |
|---|---|---|---|
| `storeIn` `:134-170` | `{product_id, qty>0, bin_id XOR box_id, person_id, source, source_ref?, authorized_by?, note?, is_test?, actor_type?}` | dup → `applied:0`; bin with different product → discrepancy `bin_product_mismatch` (still applies); empty bin/box adopts product; qty += | `{movement, duplicate, applied}` |
| `pick` `:178-218` | `{product_id, qty, bin_id?, person_id?, source!, source_ref, note?}` | idempotent by (source,source_ref) → `applied:0`; no bin_id → active bin with max qty `FOR UPDATE`; `applied=min(have,qty)`; movement qty `-applied`; short → `insufficient_stock` discrepancy | `{movement, duplicate, applied, bin}` |
| `restock` `:227-279` | `{box_id, bin_id, qty, person_id, found_bin_qty?, found_box_qty?, note?, is_test?}` | product mismatch → `restock_product_mismatch`; found_* ≠ system → `_countInternal` first; `applied=min(boxQty,qty)`; short → `restock_box_short`; box→'empty' at 0 | `{…, applied, box_left, bin_now}` |
| `damaged` `:286-318` | `{product_id, qty, reason label\|seal\|other, bin_id?, person_id, note?, is_test?}` | deducts bin (min), inserts `v3.stock_issues status 'separated'` | `{…, applied, issue}` |
| `adjust` `:324-351` | `{product_id?, qty signed ≠0, bin_id\|box_id, person_id, note!}` | floors at 0; movement qty = after−before; audit before/after | `{…, applied}` |
| `count` `:359-378` / `_countInternal` `:381-408` | `{bin_id\|box_id, found≥0, person_id, source?, note?, is_test?}` | delta = found−expected → movement 'count', qty set to found; delta≠0 → `count_variance` | `{…, applied:delta}` |
| `warehouseByProduct` `:413-427` | — | bins(active)+boxes(in_storage) per product, >0 only | rows |
`onDiscrepancy` wiring: data-router (`router.js:393-406`), op kiosk (`op.js:2942-2955`), veeqo worker (`wire.js:405-418`) — all insert `v3.data_incidents (kind='stock_<kind>', severity 'warning', title 'Estoque: <kind>', explanation, product_id, amount=wanted, where_json{bin_id,box_id,applied})`.

### D.2 `SupplyService` (`src/v3/services/SupplyService.js`)
`KINDS=['consume','restock','adjust','count']`. `supplyForSize(size)` (`:50-58`) via `v3.package_size_supply` JOIN `supply_items`. `consumeForSize({size, person_id, source='label_print', source_ref, note, is_test})` (`:65-100`): idempotent by (source,source_ref); unmapped size → `onDiscrepancy` + `{unmapped:true, applied:0}`; deducts `qty_per` floored at 0; `onLow` when crossing `min_qty`. `change({supply_item_id, kind, qty, …})` (`:103-125`): count sets, restock adds |qty|, adjust signed floored 0. **No caller of `consumeForSize` exists in routes/workers yet** (label print integration pending).

### D.3 `StockGapService` (`src/v3/services/stock-gap-service.js`)
`LOW_THRESHOLD=25` (`:21`). `emsByProduct()` (`:73-105`): EMS pipeline stages → `{kind: queue|line|capsules|finalized, product, sku (from EMS /products name→internal_sku), batch, qty, at}`. `analyze(picklist)` (`:111-189`): per group `need = Σ bottles`, `have = g.veeqo_stock` (skip if null); `out = have<=0`, `low = have<need || have<=25`; match EMS by SKU first else `nameMatches` (casepack-aware, first token must match, `:44-60`); action/advice/severity: `capsules_ready`(warn) → `on_line`(warn) → `recently_made`(warn) → `queued`(warn) → `no_production` (critical if out, warn if low). Sorted critical then out. Note: the SQL at `:117-126` (`LEFT JOIN LATERAL (SELECT 0 …)`) is a no-op leftover.

### D.4 `tiktok-source.js`
`mode()` = `TIKTOK_SOURCE==='api' ? 'api' : 'csv'` (`:32`). `parseSellerCenterCsv` (`:38-113`) tolerant delimiter/BOM; columns order id / seller sku / quantity / status / created time / product name; status map cancel→cancelled, deliver|complet|shipped|in transit→shipped, else pending; line_id = sku (+`:n` for repeats). `ingestLines(db, lines)` (`:117-148`): sku map from `product_skus channel='tiktok'`; upsert into `pnp_order_lines (source='tiktok', channel='TikTok Shop')` with rank-based non-regressing status; unmapped → `error_note 'SKU sem mapeamento (canal tiktok)'`; returns `{imported, unmapped}`. **Zero deduction.**

### D.5 `StockRepo` (`src/v3/data/stock-repo.js`)
`bins()` (active, needs_restock), `boxes()` (in_storage or empty ≤7d), `summary()` (bins+boxes per product), `issues()` (is_test=false, separated or ≤14d, limit 200), `movements({limit≤500, product_id})` (is_test=false), `picksheet(date)` (`:97-131`: pending/picklisted lines by `order_date`, grouped product+sku, best bin/box, `unmapped`, `bin_short`), `restockList()` (bins with qty ≤ min_qty>0 + FIFO boxes), `skus()`.

### D.6 Tables (columns)
- **v3.product_skus** (058:14-26; 063 widens channel): `id, product_id FK, sku, channel ∈ (veeqo,tiktok,shopify,ebay,amazon,walmart,other) default 'veeqo', units_per_pack ≥1 default 1, barcode, confirmed_by_person_id, confirmed_at, created_at`; UNIQUE(channel, sku).
- **v3.stock_bins** (058:32-46): `id, bin_code UNIQUE, shelf_code, area, product_id, qty ≥0, min_qty, cam, overlay_box JSONB, active, created_at, updated_at`.
- **v3.stock_boxes** (058:49-62): `id, box_number UNIQUE, product_id, qty ≥0, area, status ∈ (in_storage,empty), created_by_person_id, created_at, updated_at`.
- **v3.stock_movements** (058:68-90): `id, kind ∈ (store_in,pick,restock,adjust,damaged,count), product_id, qty (signed), bin_id, box_id, person_id, source NOT NULL, source_ref, snapshot_url, note, is_test, created_at`; unique partial `(source, source_ref) WHERE source_ref IS NOT NULL`.
- **v3.stock_thresholds** (058:93-99): `product_id PK, min_days NUMERIC, min_units, set_by_person_id, updated_at`.
- **v3.pnp_order_lines** (059:10-35): `id, source ∈ (veeqo,tiktok,shopify), external_order_id, external_line_id, order_number, channel, sku, product_id, qty, status ∈ (pending,picklisted,printed,shipped,cancelled,error), order_date DATE, synced_at, printed_at, shipped_at, deducted_at, error_note, raw JSONB`; UNIQUE(source, external_order_id, external_line_id).
- **v3.stock_issues** (060:8-24): `id, product_id NOT NULL, qty >0, reason ∈ (label,seal,other), bin_id, person_id, status ∈ (separated,relabeled,restocked,discarded) default separated, resolved_by_person_id, resolved_at, note, is_test, created_at`. **No 'return' reason.**
- **v3.products** additions (063:17-18): `nickname TEXT, bottle_color TEXT`.
- **v3.bottle_size_tiers** (063:44-63): `id, bottle_color (NULL=default), min_bottles ≥1, max_bottles, package_size, is_box, created_at`; seed default A(1) Y(2–6) B(7–9) BX(10+).
- **v3.supply_items** (064:12-23): `id, name UNIQUE, kind ∈ (envelope,box,other), qty, min_qty, active, note, created_at, updated_at`. **v3.package_size_supply**: `package_size PK, supply_item_id, qty_per ≥1, updated_at`. **v3.supply_movements**: `id, kind ∈ (consume,restock,adjust,count), supply_item_id, qty signed, package_size, person_id, source, source_ref, note, is_test, created_at` + unique (source,source_ref).
- **v3.envelope_mix** (070:7-16): `id, package_size, black_qty, white_max, confirmed, note, updated_at`; UNIQUE(package_size, black_qty); seed 9x12: 0/8, 1/6, 2/4 confirmed; 3/2 unconfirmed. **v3.packing_questions** (070:20-32): `id, key UNIQUE, question, context, active, asked_count, last_asked_at, answer, answered_by, answered_at, created_at`; seed `mix_9x12_3black`.
- **v3.product_catalog** (066): `catalog_name, family, status ∈ (active,multipack,hold), content_desc, serving_size, servings_per_container, potency, expiry_date, batch_number, …, product_id, match_kind` (used by product-setup for expiry/on_hold/content_desc).
- **v3.print_divergence_log** (069): `ny_date UNIQUE, operator_total, veeqo_total, diff, asked, question_ts, question_channel, answer_text, answer_by, answered_at`.
- **RBAC** (065): `v3.app_functions(key,label,category)`, `v3.app_roles(id,key,name,rank,active)`, `v3.role_functions(role_id,function_key)`, `v3.app_logins(id,name,role_id,pin,person_id,active)`. Functions seeded: `admin_page, config_page, config_cameras, manage_users, manage_system, view_stock, manage_stock, product_setup, view_production, manage_people, do_pnp, print_labels, watch_formulation, printing_page, cameras_view, assistant`. Roles: admin(100, all), manager(50, all minus admin block), operator(10: do_pnp, print_labels, view_production, cameras_view). Logins: Admin 150000, Henrique 510510. `hasFunction(login, fn)` (`auth.js:45-49`) honors `'*'`; **used only for `manage_users`** in router.

---

## E. Workers (all opt-in via env; wired in `src/v3/wire.js:396-491`)

| Worker | Env | Cadence | Computes / posts |
|---|---|---|---|
| `veeqo-order-sync.js` `VeeqoOrderSync` | `WORKER_VEEQO_ORDERS_ENABLED=true`; `STOCK_DEDUCT_MODE` (`'dry'` default) | 5 min (first at 20 s), maxPages 15×100 per status, window `updated_at_min = now−48h` | `_skuMap()` = `product_skus channel='veeqo' AND confirmed_at IS NOT NULL` (`:79-86`). Syncs `awaiting_fulfillment→pending`, `shipped→shipped`, `cancelled→cancelled` (`:148-152`). `_upsertLine` (`:50-76`): rank non-regressing (`pending0<picklisted1<printed2<shipped3`), cancelled overrides unless shipped, `product_id = COALESCE(existing, new)`, `error_note 'SKU sem mapeamento confirmado' / 'linha sem SKU'` (quarantine = product_id NULL). **Deduction** (`:120-132`) only when `mappedStatus==='shipped' && deductMode==='live' && stock && !row.deducted_at && map` → `StockService.pick({product_id, qty: qty*units_per_pack, source:'veeqo_ship', source_ref:'<order_id>:<line_id>', note})` then `UPDATE pnp_order_lines SET deducted_at=NOW()`. In `dry` nothing is deducted (lines still mirrored). |
| `stock-alerts.js` `StockAlerts` | `WORKER_STOCK_ALERTS_ENABLED=true`; channel `STOCK_ALERTS_CHANNEL\|\|V3_ADMIN_CHANNEL\|\|C0B36DR5MP1` | 30 min | `compute()` (`:152-199`) per product: warehouse (bins+boxes) + marketplace (Veeqo via confirmed SKUs, base SKU preferred, `:48-72`), velocity 14d from shipped lines (`:75-86`), lead days = median EMS batch duration (`:89-103`), threshold `stock_thresholds` or lead+3, zone `out/low/plan/ok`, `velocity_reliable` (≥7 days). `tick()` posts (dedupe 24h via audit_log `stock_low_alert`/`stock_plan_alert`): plan → "Planejar produção…", low/out with EMS batch → ":rotating_light: Rodar na linha ASAP", without → ":red_circle: Adicionar à lista de fabricação … <!here>". Also reused read-only as `/stock/planner` (`router.js:408`). |
| `stock-gap-alert.js` `StockGapAlert` | `WORKER_STOCK_GAP_ALERT_ENABLED=true` | 5 min | (1) ≥10 min after first non-test `order_printing*` start today → gaps text to admin-orin and (if not muted) `#orders-and-inventory` (`C09UNBXFRKK`); (2) daily ≥8h NY → admin-orin summary. Dedupe per day via audit_log `stock_gap_alert`. Format: ":red_circle: PRECISA RESOLVER JÁ" / ":warning: Dá pra resolver hoje" bullets "*product* (precisa N, tem M). advice". |
| `unusual-sku-watch.js` `UnusualSkuWatch` | `WORKER_UNUSUAL_SKU_ENABLED=true` | 15 min | pending lines whose sku has no `product_skus` row (case-insensitive) → one grouped admin-orin message ":mag: SKU incomum na fila de P&P de hoje…", dedupe per SKU/day (`unusual_sku`). Never removes from picklist. |
| `print-divergence-watchdog.js` | `WORKER_PRINT_DIVERGENCE_ENABLED=true` | 15 min | 12:00–15:00 NY: `operator_total = Σ events.orders_printed` (order_printing/_2, non-test, today) vs `veeqo.shippedByDay(date).total_orders`; if `|diff|>20` and operator_total>0 and not muted → asks Simone in `#orders-and-inventory` citing only the difference; logs every day in `v3.print_divergence_log`; captures first human thread reply. |

---

## F. Print / labels / P&P counts

- **P&P task slugs**: `WS_SLUGS` = `order_printing` ("Impressão de ordens"), `order_printing_2` ("2ª impressão"), `stock_organization` ("Organização de Stock (Inventário)", counts_as_pp=false) (`src/op/fuse-data.js:219-245`). `counts_as_pp=true` (mig 039:28-30 minus 051 `labeling`): `order_printing, order_printing_2, packaging, packaging_other, marketplace_prep`; `clinic_shipment` false (own metric), `box_closing`/shipping_* flow production (054).
- **"Ordens impressas" count** = `v3.production_counts` rows with `kind='orders'`, `unit='orders'`, `deleted_at IS NULL`, `superseded_by IS NULL`, `production_date = today NY`. Written by:
  - `insertOrdersCount` (`op.js:1158-1165`) at **event start** for the **first** open `order_printing*` today (`isFirstOrderOpen`, `:1580-1596`; qty required, 400 `orders_printed_required`), joiners optional/no count; `clinic_shipment` → `kind='clinic'` (`:1738-1742`, `:1787-1791`).
  - `/event/:id/end` when `needOrders` (`requires_order_count` and NOT order_printing/clinic) (`op.js:2060`, `:2247-2256`), i.e. packaging/packaging_other/marketplace_prep.
  - `POST /api/v3/op/orders/adjust` (`op.js:2898-2934`): `{mode:'additional'|'reset', quantity>0, source_event_id?}`; additional inserts a row (`adjustment_kind='additional'`); reset inserts new row and marks all other live today rows `superseded_by=new.id`, posts Slack warning to `production` channel (non-sandbox), audit `orders.adjust`, actionLog; returns `{ok, mode, old_total, new_total}`. Client only offers it on `packaging_other` (`app.js:1895-1904`).
  - Retroactive `event/retroactive` requires `orders_printed` for order_printing slugs but stores it only on `events.orders_printed` — **no production_counts row** (`op.js:1805-1809`, `:1837-1845`).
- Consumers: `flow-views-repo.pnpByDay` (`:312-322` canonical SUM joined to `counts_as_pp` events; `orders_inputs`, `orders_reset` `:342-373`), CommandCenter card (C.7), admin `/admin` (`admin.js:1086-1134`).
- **`POST /api/print-event`** (`op.js:418-528`, token `PRINT_EVENT_TOKEN`): ingests Windows spooler jobs from `.28` into `v3.print_jobs` (product/batch resolved from document text, operator from `print_station_operator` setting or open `label_printing` event, dedupe per computer+job_id+NY date and per doc/90 s, admin-orin Slack for EPSON/Graphtec, SSE broadcast). This is **production label printing (FNSKU/bottle labels)**, not P&P shipping labels; it does not touch P&P counts. Shipping-label counts come from Veeqo `shippedByDay` (`/veeqo-today`, worker E). Print-station login opens a `label_printing` event (`op.js:276-283`).

---

## G. What is MISSING vs the decided model

1. **Reservation per product from open Veeqo lines / "available"** — none. Picklist computes `needed` per product only inside `StockGapService` and compares against `veeqo_stock`; there is no `reserved`, `available = on_hand − reserved`, no reservation table/state, and pending lines are never marked `picklisted` (status stays `pending` until Veeqo says shipped; `deducted_at` only in live mode).
2. **Approval queue for total-changing operator actions** — none. `stock/take` writes immediately (raw insert, no bin effect); `orders/adjust reset` supersedes immediately (Slack warning only); `count`/`adjust` apply instantly (discrepancy → `data_incidents` after the fact). No pending/approved state anywhere.
3. **Returns reason in `stock_issues`** — reason CHECK is `label|seal|other` (060:12); no `return`, no link to order/customer, no restock-from-return flow.
4. **Admin actions on a hub page** — no single P&P/stock hub: bins/boxes creation only via raw `POST /stock/bins|boxes` (InventoryPage empty state literally says "Cadastre via POST /stock/bins"); issue resolution is on InventoryPage tab; Veeqo write is on StockOverviewPage; settings on InventorySettingsPage; supplies on InventoryPage. No admin view of operator `stock/take` movements (they are product-level, `StockRepo.movements` shows them without bin).
5. **P&P / Picklist menu placement** — Picklist and P&P sit under **Operação** (`Shell.jsx:25-26`), while stock pages sit under **Estoque & Produtos**; no "P&P & Estoque" hub group; nothing RBAC-gated (`view_stock`, `manage_stock`, `product_setup`, `do_pnp` are seeded but unused by nav and by the API).
6. **Planejamento/Produto next to Metas** — `planejamento` (placeholder `PlanPage`, `OtherPages.jsx:677`) and `produto` are in Estoque & Produtos, not adjacent to `metas` in Operação.
7. Other gaps observed: `stock/take` bypasses StockService (no bin decrement, no idempotency, no issue for damaged, no audit); default `bottle_color NULL` tiers never match in envelope calc; `stock_organization` open task never triggers stock-gap alert; `SupplyService.consumeForSize` has no caller (envelope consumption not wired to label printing); ProductSetup has no images; retroactive order-printing does not create `production_counts`; picklist `total_orders` counts lines not orders; op client does not use `stock/context|store|restock|damaged|count` (kiosk stock UI unbuilt); `packing_questions` are never asked to operators (only toggled in settings); the pnp_order_lines `printed/picklisted` states are unused.

---

## H. PICKLIST LAYOUT STYLE guide (copy for new pages)

Source of truth: `G:\My Drive\Clinic\Obsidian Bruno\HealthFare\STYLE-KIT.html` (`:root` lines 20-46) as applied in `PicklistPage.jsx:12-63`, `InventorySettingsPage.jsx:12-49`, `src/op/app.js:617-736`.

**Tokens (scope under a page root class, light only):**
```
--primary:#1a3a6b; --primary-deep:#0d1f3c; --green-d:#2e8b3c;
--ground:#f4f8fc; --surface:#fff; --surface-2:#f7fafd;
--line:#d4e2f0; --line-strong:#b9cbe2; --dotline:#c6d7e8;
--ink:#1c2b3a; --ink-dim:#54687c; --ink-faint:#6b7f92;
--ok-bg:#e8f7ea; --ok-line:#c8ecce; --ok-deep:#1e6b2e;
--warn-bg:#fdf6e3; --warn-line:#eeddad; --warn-deep:#6b4c07;
--bad-bg:#fdeeec; --bad-line:#f5cdc7; --bad-deep:#a02c20;
--neutral-bg:#eaf0fb; --neutral-line:#d4e2f0;
--font:'DM Sans',system-ui,sans-serif; --font-display:'DM Serif Display',Georgia,serif; --font-mono:'DM Mono',monospace;
--r-lg:18px; --r-pill:999px; --shadow-card:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05);
```
(In /op the same hexes are inline; fonts there are DM Mono / DM Serif Display / Sora for buttons; body Manrope.)

**Ground:** `background:#f4f8fc; background-image:radial-gradient(circle,rgba(26,58,107,.06) 1px,transparent 1px); background-size:26px 26px;` page padding ≈ 34px 30px 60px (dashboard) / 22px 34px (op).

**Header block:** eyebrow `● HEALTHFARE P&P · <SECTION>` = DM Mono 500 10px, letter-spacing .14em, uppercase, `#2e8b3c`; H1 DM Serif Display 400 clamp(26px,2.6vw,34px) `#0d1f3c` with **one** italic word in `#2e8b3c` (`<em>`); sub 13.5px `#54687c`; primary action = navy pill (`#0d1f3c`, white, 600 13px DM Sans, h38, padding 0 22, radius 999; op uses h46 Sora 800 15). Secondary pill = white, 1px `#d4e2f0`, `#1c2b3a`.

**KPI cards:** `.card` white, 1px `#d4e2f0`, radius 18, shadow-card, padding 14×18, min-width 130; label = mlabel (DM Mono 500 10px .14em uppercase `#6b7f92`); number = DM Serif Display 34px `#0d1f3c` tabular.

**Chips:** inline-flex, h22 (op: 24–26), padding 0 10, radius 999, DM Mono 500 11px; `neutral` `#eaf0fb`/`#1a3a6b` inset ring `#d4e2f0`; `ok` `#e8f7ea`/`#1e6b2e` ring `#c8ecce`; `warn` `#fdf6e3`/`#6b4c07` ring `#eeddad`; `bad` `#fdeeec`/`#a02c20` ring `#f5cdc7`; solid navy chip for envelope counts (`#0d1f3c` white, bold count 14px); solid red `ZERADO` (`#a02c20`).

**Product divider (the "label" block):** radius 18, 1px `#b9cbe2`, `linear-gradient(180deg,#fff,#f7fafd)`, padding 16×18, mt 22, gap 6, `break-inside:avoid`; name DM Serif 26px `#0d1f3c` lh 1.05; location DM Mono 600 15px `#1a3a6b` .02em, uppercase tokens `SHELF · BIN · PALLET` joined by ` · `; unlocated = `#6b7f92` 400 "local a definir"; multi-bottle warning box: 600 12.5 `#6b4c07` on `#fdf6e3` border `#eeddad` radius 12 padding 8×12 "NO FIM · …".

**Order rows / list rows:** flex, gap 12, padding 9×14, `border-bottom:1px dotted #c6d7e8` (op rows: `border-top:1px dotted #c6d7e8`, padding 10×2, column gap 3); mono ids DM Mono 500 13; person 12.5 `#54687c`; multi rows tinted `#fdf6e3`.

**Micro-labels in rows (op):** `SKU:` `QTY:` `Title:` `Location:` = DM Mono 10px .08em uppercase `#6b7f92`; SKU value DM Mono 14 700 `#0d1f3c`; QTY DM Mono 16 800 `#0d1f3c`; title 13.5 600 `#1c2b3a` ellipsis; location DM Mono 12 600 `#1a3a6b`.

**Cards / columns:** cards `background:#fff; border:1px solid #d4e2f0; border-radius:18px; box-shadow:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05); padding:18px 20px`; two-column grid `1.2fr 1fr`, gap 20, max-width 1240 centered; full-width alert card spans `grid-column:1/-1` and switches border to `#f5cdc7` when critical.

**Inputs:** radius 12, 1px `#d4e2f0`, `#f7fafd` bg, 14–15px, `#1c2b3a`; segmented control = inline-flex, 1px `#d4e2f0`, radius 10, active navy `#0d1f3c` white (destructive active `#a02c20`); stepper buttons 52×52 radius 12.

**Print (4×6):** `@page size 4in 6in; margin .12–.18in`; header 10px bold with 2px black rule; per-product row 1.5px black rule, id line 10px (Consolas SKU + bold NAME mg/caps), big line = location 17px 900 + `QTY <b>22px</b>`; `.pl-product{break-before:page}` on the dashboard variant.

**Rules:** no em dashes in UI text; semantic colors only for status; navy pills for primary actions; DM Serif for titles + big numbers; DM Mono for eyebrows/labels/ids/chips; light theme only.
