# S15 · WAREHOUSE INVENTORY — how the whole system works, and the page that runs it

**Status:** STUDY for Bruno's review (2026-08-18). Nothing here is built. Decisions marked **DECIDED** come from the chat/Obsidian on 08-17/18; anything marked **OPEN** needs Bruno before build.
**Sources digested (appendices):** `A1-design-intent-digest.md` (every Obsidian note + memory, chronological, with 14 contradictions flagged), `A2-code-functional-spec.md` (every screen/endpoint/table/worker as built, with file:line), `A3-industry-patterns.md` (Salesforce Omnichannel Inventory + WMS reference model, with sources).
**Map:** section S15 in `docs/architecture/` (`maps/S15-warehouse-inventory.mmd`, `STRUCTURE_INDEX.md` S15.01–S15.15).

---

## 0. The model in ten lines (DECIDED)

1. Two flows, never mixed: **① Production line → fulfillment centers** (FNSKU, UPS) and **② P&P → straight to the customer** (Veeqo channels, USPS/DHL/UPS). **The warehouse inventory is flow ② only.** Fulfilled/FBA stock is out of scope.
2. A batch of supplement X ends → **an admin or manager enters the number of X that goes into the warehouse** (the rest went to fulfillment; not our number).
3. Bottles live in two kinds of place: **shelves** (bins, ~48 bottles, next to the P&P operator) and **boxes** (>110, numbered, on pallets by area). **Product total = shelf + box.** That total is THE control number. Shelf/box are only physical organization.
4. Shelf empties → refill from that product's box (a **move**, total unchanged, operator does it, applies immediately, logged).
5. An order arrives in Veeqo → its lines are **reserved** against the product automatically (derived from open, unshipped lines). **Available = total − reserved.**
6. The shipping label is printed **in Veeqo** → Veeqo marks the order **shipped** → we **deduct** our ledger (shelf first, box second, once per order line, idempotent). We never write to Veeqo on print; Veeqo already deducts itself. **Veeqo is the only deduction signal for now** (TikTok later; the .28 physical print event is not a stock signal).
7. Damaged / problem / returned bottles go to a **secondary bucket per product, "Separadas"** — physically here, never counted as sellable — until an admin decides: back to stock (approval), relabel, or discard (approval).
8. **Operators propose, admins/managers decide**: anything that changes the product total (add, remove, count correction, return re-entry, Separadas back to sellable) waits for approval. Shelf↔box moves and putting a bottle into Separadas are physical facts and apply at once (logged, reversible).
9. **Nothing auto-overwrites anything**: a nightly reconciliation compares Veeqo vs our totals and **alerts**; a human decides. Our ledger = physical truth; Veeqo = sales truth.
10. Channel inventories (Amazon/eBay/Walmart/TikTok pages) are **deferred**; first we organize the actual warehouse. Planejamento + Produto stay untouched and move next to Metas under Operação; **P&P + Picklist live together in a P&P subsection under the Warehouse section.**

---

## 1. Actors and what each may do (RBAC by function, never by name)

| Role (v3.app_roles) | Sees | May do |
|---|---|---|
| **admin** (100) | everything | everything below + approve/reject, config, Veeqo write, retire locations |
| **manager** (50) | Warehouse section, P&P, Picklist | enter warehouse-in, approve/reject proposals, adjust with reason, resolve Separadas, move, count, register returns |
| **operator** (10, kiosk `/op`) | own operator page (Central de P&P & Estoque) | picklist, print picklist, move box→shelf (immediate), put bottle in Separadas (immediate), **propose**: took from stock / count / return received / entrada; never sees costs, drift math, or other people's proposals |

RBAC functions already seeded (mig 065) and to be USED (today none of the stock endpoints check them): `view_stock`, `manage_stock`, `product_setup`, `do_pnp`, `print_labels`. Approvals will require `manage_stock`. Every proposal carries the operator's `person_id` (kiosk session); every decision carries the approver's login (`app_logins`, linked to a person).

---

## 2. The end-to-end process, stage by stage

Legend: **[E]** exists as built · **[P]** planned/decided, not built · **[⚠]** exists but wrong vs the model.

### Stage A — Bottles enter the warehouse
- Trigger: production batch of X finished (flow ①); the operator's production count is *not* the warehouse number.
- **[P] Entrada** — admin/manager opens the product, clicks *Entrada*, types the number of bottles of X entering the warehouse and where they go: shelf (bin) and/or box (new box number or existing). Two-step confirm (Revisar → Confirmar) showing product + SKU + preview of the new total, same protection pattern as today's Veeqo edit. Result: `storeIn` movements (exists **[E]** in StockService), product total rises.
- **[P] Operator proposal** — if an operator physically stores the bottles first, they *propose* the entrada from the operator page; the number appears in the product row as **"+N pendente"** and only enters the total when a manager approves.
- Momentum Guard / "sent to fulfilled" is out of scope for the number; the total is what physically entered the warehouse.

### Stage B — Organizing: shelves vs boxes
- **[E]** Locations: `stock_bins` (bin_code, shelf_code, area, one product, qty, min_qty), `stock_boxes` (box_number, area, product, qty, in_storage/empty). **0 bins and 0 boxes registered today** — this is Blocker #1 in every note; without it the picklist prints "LOCAL A DEFINIR".
- **[P] Locais** subpage — quick registration of shelves/bins/boxes (code, area, product, min qty), and per product: which shelf, which boxes.
- **[E] Move box → shelf** = `restock` (immediate). Operators do it from the operator page ("Repor prateleira"); admins from the product record.
- **[E] Restock alerts**: bins with qty ≤ min_qty appear in `restock-list`; the operator page will show "prateleiras pra repor" (from Bruno's 08-01 request: "prateleiras x,y,z precisam de reposição, as garrafas estão nas caixas x,y,z").

### Stage C — Orders arrive → reservation
- **[E]** `veeqo-order-sync` (every 5 min) mirrors every order line into `pnp_order_lines` (status pending → … → shipped/cancelled, never regresses); unmapped SKUs are quarantined (product_id NULL) and warned, never dropped from the picklist.
- **[P] Reserved(X)** = Σ qty×units_per_pack of open lines (status not shipped/cancelled) mapped to X. **Available(X) = total − reserved.** Derived at read time; no table, no manual reserve.
- Picklist rule (Bruno 08-06): print EVERYTHING allocated to HealthFare Warehouse that day, never filter; unusual SKU → warn admin-orin, item stays.

### Stage D — Picking & printing (P&P, 09:30 → 13:00, "nada pode deixar isso mais lento")
- **[E]** Picklist (dashboard `#picklist` on-screen; operator workspace with SKU/Title/Location/QTY + PRINT 4x6 paper: envelopes to separate on top, per product SKU + full name small, LOCATION and QTY big). Walking order by shelf+bin; single-bottle first, multi at the end; envelope per order by bottle color + count.
- Shipping labels today print from the Veeqo UI on Simone's PC (.246). Printing from OUR system (compiled PDF with footer nickname ×qty · size · Shelf·Bin·Pallet · Pick ID Pack ID) is Phase 2 of the label project — not part of this page's first build.
- **Strict P&P rules (Bruno):** never print an order already shipped or cancelled; catalog HOLD blocks printing; reprint = supervisor; re-verify at source before printing.
- **[E]** "Ordens impressas" typed by the operator when starting Impressão de ordens; noon watchdog compares with Veeqo shipped and asks only if |diff| > 20.

### Stage E — Label printed → deduction
- **[E]** Veeqo marks the order shipped → `veeqo-order-sync` calls `StockService.pick()` per line, idempotent by `(veeqo_ship, order:line)`, floor at zero + incident, marks `deducted_at`. **[⚠] Only when `STOCK_DEDUCT_MODE=live`; default is `dry` (shadow).** Flipping to live is a deliberate switch after SKUs are confirmed (today 3 of 141 confirmed).
- **[P] shelf first, box second**: `pick()` today targets an explicit bin/box; the sync must choose the product's shelf bin first and fall back to a box (small change in the worker, no new rule in the service).
- Nothing else deducts. TikTok (outside Veeqo) later. The .28 print event is not a stock signal.

### Stage F — Outside orders: taken from stock, damaged, returns
- **[⚠] "Registrar saída de estoque" (operator, today):** raw INSERT, product-level, applies immediately, no bin, no idempotency, no approval → must become a **proposal** (took N of X, reason) that shows as "−N pendente" until approved. Damaged → **Separadas** immediately (physical fact) via `damaged()` **[E]** (deducts the shelf, opens `stock_issues`).
- **[P] Returns:** a return arrives → operator or manager registers it → lands in **Separadas with reason `return`** (new reason; today label/seal/other). Nothing enters sellable until a manager decides: back to stock (approval → `storeIn`), relabel, or discard.
- **[E]** Cycle counts (`count`) exist in the service; **[P]** operator counts become proposals when the delta ≠ 0.

### Stage G — Approvals (the queue)
- **[P] `stock_change_requests`**: who, when, product, kind (entrada / saída / count / return-in / separadas-back / adjust), qty, from/to, reason, photo?, status pending/approved/rejected, decided_by, decided_at, applied movement id. Approve = StockService applies it (single write door preserved), audit both. Aging alert to admin-orin if pending > N hours (RULE #0: the operator is never blocked; the manager is nagged).
- What does **not** need approval: shelf↔box moves; putting a bottle into Separadas; picklist print; the Veeqo deduction.

### Stage H — Veeqo two-way and reconciliation (later)
- **[E]** one write exists: `setStock` to warehouse 108841 (used by "Ver estoque → editar", 2-step protected modal).
- **[P]** after production: ADD to Veeqo; on adjustments: REMOVE. **[P] nightly reconciliation** per SKU/product: Veeqo available vs our total → **alert only**, human decides. Two "truths" by design: ours = physical, Veeqo = sales.

### Stage I — Alerts and watchdogs (all exist, all opt-in today)
stock-alerts planner (days of stock vs EMS lead time → "rodar na linha ASAP" / "adicionar à lista de fabricação"), stock-gap-alert (10 min after first print of the day: what's needed today vs what we have), unusual-sku, print-divergence (noon), Veeqo mergeable/dup-shipment. The hub page must surface the same facts on screen (no second logic).

---

## 3. The numbers per product (what is stored, what is computed)

| Number | Meaning | Source | Stored / derived |
|---|---|---|---|
| **Prateleira** (shelf) | bottles on the product's bins | Σ `stock_bins.qty` (active) | stored per bin (moved only by ledger) |
| **Caixas** (box) | bottles in the product's boxes | Σ `stock_boxes.qty` (in_storage) | stored per box |
| **Total** = shelf + box | THE control number | derived | — |
| **Reservado** | open Veeqo lines not shipped/cancelled | Σ `pnp_order_lines.qty × units_per_pack` | derived, refreshed by the 5-min sync |
| **Disponível** = total − reservado | can we supply the orders? | derived | — |
| **Separadas** | damaged / problem / returned, per product | Σ `stock_issues.qty` status separated | stored (own bucket, never sellable) |
| **Pendente** (±) | operator proposals not yet approved | Σ `stock_change_requests` pending | derived; shown next to total, never inside it |
| **Mín** | restock trigger per bin; low threshold per product | `stock_bins.min_qty`, `stock_thresholds` (min_days/min_units) | stored (config) |
| **Dias** | days of cover = available ÷ 14-day velocity | stock-alerts compute | derived (optional column) |
| **Veeqo** | Veeqo's own stock for the mapped SKU(s) | Veeqo sellables | comparison column ONLY, never summed (Bruno 08-04); Δ vs total feeds the drift alert |
| **Status** | ok · baixo · zerado · negativo · drift · aprovação pendente · sem local · SKU não mapeado | rules over the above | derived |

Salesforce mapping (A3): shelf+box = Sellable location group; Separadas = Hold location group; Reservado = Reservations; Disponível = ATF; Veeqo = the channel system we reconcile with; ledger = StockMove; approval queue = AdjustmentRequest. Everything physical is a movement; everything sellable is a formula; only config is typed by a human.

---

## 4. Locations model and physical constraints
- **Shelf/bin**: 1 product per bin, ~48 bottles max; codes short (`A03`, shelf `S2`), area; `min_qty` restock trigger. **Box**: numbered (`BOX-045`), area/pallet, one product, >110. **Separadas**: a virtual per-product bucket (not a physical code) — physically a tray/shelf the team knows.
- Deep-Study code rules: ≤8–10 chars, `A-Z 0-9 -`, never encode the product in the code, deprecate not reuse.
- The picklist "walking order" needs bins to exist. **Registering the real bins/boxes + the first admin entrada is the first thing the hub must make easy** (Locais + Entrada), otherwise every number is zero.

---

## 5. Pages and subpages — the complete section (proposed IA)

Menu (Shell): **Estoque · Warehouse Inventory ▾**
```
Estoque (hub)                    #estoque              NEW  — the page this study designs
  ├ Produto (record)             #estoque/p/:id        NEW  — drill-in (side panel first, full record page later)
  ├ Aprovações                   #estoque/aprovacoes   NEW  — proposals inbox (manage_stock)
  ├ Locais                       #estoque/locais       NEW  — shelves/bins/boxes registry (replaces Bins + Caixas tabs)
  ├ Separadas                    #estoque/separadas    NEW  — hold bucket per product, resolve (replaces Separadas tab)
  ├ Movimentos                   #estoque/movimentos   NEW  — ledger with filters (exists as /stock/movements)
  └ Reconciliação Veeqo          #estoque/veeqo        LATER
Ver estoque                      #estoque-geral        KEEP for now → its Veeqo column + protected edit modal move INTO the hub; then retire
Estoque detalhado                #inventory            KEEP for now → tabs Bins/Caixas/Separadas/Planner/SKUs/Suprimentos migrate to subpages / Product Setup; then retire
Product Setup                    #produto-setup        KEEP (SKUs, nickname, color, tiers, channel SKUs, HOLD)
Configurações                    #config-estoque       KEEP (tiers, envelope mix, packing questions, supplies map)
Suprimentos                      #estoque/suprimentos  LATER (envelopes/boxes own inventory; today a tab)
P&P ▾
  Pick & Pack                    #pp                   MOVE here (from Operação)
  Picklist                       #picklist             MOVE here (from Operação)
  End Of Day Shipment            #pp/eod               PLANNED
  4x6 Printer Settings           #pp/impressora        PLANNED
Operação: Hoje · Roadmap · Produção · Metas · Planejamento · Produto · Pessoas   (Planejamento + Produto moved next to Metas, untouched)
```
Channel pages (Amazon · eBay · Walmart · TikTok): deferred, not in the menu now.

**Operator page (Central de P&P & Estoque, /op)** — evolves, same layout: Picklist + PRINT (unchanged) · "Falta de estoque hoje" (unchanged) · **Repor prateleira** (box→shelf, immediate) · **Registrar** (took from stock / damaged / return received / entrada / count) → creates a proposal (damaged goes to Separadas at once) · "Registrado hoje" shows each item with its state: *aplicado* / *pendente* / *aprovado* / *recusado*.

---

## 6. THE HUB PAGE — "Estoque" (`#estoque`), Picklist layout style

Style: STYLE-KIT tokens scoped under `.wh-root` (same as `.pl-root`): dot-grid ground, eyebrow DM Mono green, DM Serif title with one italic green word, 18px cards, navy pills, tonal chips (neutral/ok/warn/bad/dispute), DM Mono for ids/labels/numbers, dotted row separators, no em dashes. Light only.

```
● HEALTHFARE P&P · ESTOQUE                                            [ Entrada ] [ Aprovações (3) ] [ Locais ]
Estoque do <em>armazém</em>
Total = prateleira + caixa. Reservado vem dos pedidos abertos da Veeqo. Separadas nunca contam.

┌ Garrafas ┐ ┌ Reservadas ┐ ┌ Disponíveis ┐ ┌ Separadas ┐ ┌ Prateleiras p/ repor ┐ ┌ Aprovações ┐ ┌ Δ Veeqo ┐
│  4 812   │ │    136     │ │   4 676     │ │    23     │ │         5            │ │     3      │ │  −12    │
└──────────┘ └────────────┘ └─────────────┘ └───────────┘ └──────────────────────┘ └────────────┘ └─────────┘

┌ Precisa de atenção hoje ─────────────────────────────────────────────────────────────────────── (full width) ┐
│ ● ZERADO  Berberine 500 · precisa 14 hoje, tem 0 · caixa BOX-012 tem 110 → repor prateleira A03            │
│ ● BAIXO   Ashwagandha · disponível 6, pedidos 5 · lote EMS em revisão                                       │
│ ● PENDENTE  Simone propôs −3 Chlorophyll (extra pro pedido 12-345) há 2h  [Aprovar] [Recusar]              │
│ ● DRIFT   Benfotiamine 300 · Veeqo 214 · aqui 226 · Δ +12  [ver]                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

[ Buscar produto / SKU ]  Status: [todos ▾]  Área: [todas ▾]  ☐ só com pedido hoje  ☐ só com pendências     ordenar: disponível ↑

PRODUTO                        TOTAL  PRATEL.  CAIXA  RESERV.  DISPON.  SEPAR.  VEEQO   DIAS   STATUS            ⋯
Benfotiamine 300 mg            226    46       180    12       214      2       214     38     ● ok              [Entrada][Mover][Ajustar]
  HF-BENF-300 · S2 A03 · BOX-004                                                                                 
Berberine 500 mg               110    0        110    14       96       0       98      12     ● zerado na prat. [Repor A03]
Chlorophyll                     41    41         0     3       38 (−3 pend.)  1   40     9     ● pendente        [Aprovar]
Collagen                        0      0         0     4       −4       0       0       0     ● negativo         [Entrada]
…
```
- **KPI strip**: serif 34px numbers, mono labels; each KPI is a filter (click "Aprovações" → the table filters to rows with pending proposals).
- **Attention card**: the same facts the watchdogs post to Slack, on screen, with the action inline (no second logic — it consumes `stock-gaps`, restock-list, pending requests, drift).
- **Table**: one row per product; nickname big + second line SKU chips + location chips (mono); numbers tabular; Veeqo column visually separated (left border) and never summed; row status chip; row actions gated by `manage_stock`. Sorted by *Disponível* ascending by default (problems first). Search + status/area filters. Products with no location get a "sem local" chip and the *Locais* shortcut.
- **Row click → Produto record (side panel first)**:
  - Header: the 6 numbers + status + SKU chips.
  - Related lists (tabs or stacked cards): **Locais** (each bin/box: qty, min, last count, last movement; buttons Repor / Contar / Mover), **Pedidos abertos** (order no., channel, qty, age; the reservation, read-only), **Movimentos** (ledger newest first: kind, ±qty, from/to, who, source, note), **Separadas** (reason, qty, who, when → Voltar ao estoque (approval) / Relabel / Descartar (approval)), **Pendências** (proposals for this product with Aprovar/Recusar), **Config** (min per bin, thresholds, SKUs → link to Product Setup, Veeqo stock + protected edit).
- **Actions (modals, all 2-step Revisar → Confirmar, showing product + exact SKU + preview of the new numbers)**: **Entrada** (qty → shelf/box), **Mover** (bin ↔ box, qty), **Ajustar** (± with mandatory reason), **Separar** (qty, reason label/seal/other/return), **Registrar devolução** (qty, order no. optional → Separadas), **Aprovar / Recusar** (with note). Every action = a StockService call; nothing writes SQL from the page.
- **Empty state (day 1)**: "Nenhuma prateleira ou caixa cadastrada ainda. Cadastre em Locais e faça a primeira Entrada." with the two buttons — because today the numbers are all zero.
- **Operators never see this page** (RBAC); managers see it without Veeqo edit unless `manage_stock`.

### Aprovações (`#estoque/aprovacoes`)
List of pending proposals: who · when · product · kind · qty · reason · photo (if any) · age; approve/reject with note; history tab. Aging badge; the same list feeds the KPI and the admin-orin nag.

### Locais (`#estoque/locais`)
Two tables (Prateleiras/bins, Caixas) with inline add: code, shelf, area, product, min; boxes: number, area, product, qty; "sem produto" bins; deprecate (never delete). This is Blocker #1's cure.

---

## 7. Contradictions between sources — resolved for this build
(from A1 §7; the later decision wins unless stated)
1. 9x12 white capacity: **8** (memory 08-07 wins over 08-06 notes).
2. Envelope tier letters A/Y/B: **were placeholders**; real sizes 4x8/7x10/9x12/15x19/BX. Never seed examples as config.
3. Deduction trigger: **Veeqo shipped only** (08-18) — not our label print, not the .28 event; TikTok later. Reservation = open lines automatically (not "at picklist print").
4. Ledger shape: what's built (`stock_movements` + StockService) is the base; the Deep-Study `stock_moves` design is superseded.
5. Who enters quantity: **admin/manager** (08-18); operators propose (initial-load-by-operator idea from 08-01 becomes a proposal too).
6. Veeqo write-back: our deduction mirrors Veeqo's shipped (physical warehouse only, no double count); ADD/REMOVE to Veeqo later; alerts only on drift.
7. Planejamento/Produto: **stay untouched, move next to Metas** (Bruno 08-18).
8. Channel pages: **deferred**.
9. Shipping labels print on **.246** (Simone); .28 = bottle labels only.
10. Picker/Packer: **decided** = dashboard employee ID from active P&P tasks (footer, Phase 2 of labels).
11. Picklist scope: **print everything allocated to the warehouse, never filter, only warn**.
12. Snapshot counts in notes are dated; nothing hard-coded.
13. Veeqo column: **comparison only, never summed** into total.
14. Envelope basis: 1 per order on the paper; supply deduction per label — equal only when 1 label per order (merged/multi-package orders differ) → note for the supplies phase.

---

## 8. OPEN — must be answered before build
| # | Question | My recommendation |
|---|---|---|
| O1 | Reservation counts which line statuses? | every mirrored line not shipped/cancelled (pending, picklisted, printed) |
| O2 | "Registrar saída" (took N outside an order): proposal that waits, or immediate + review? Bruno's rule says approval; RULE #0 says never block. | proposal; the row shows "−N pendente" so nobody is misled; managers get a nag if pending > 2h. Damaged/Separar stays immediate. |
| O3 | Ver estoque page: fold the Veeqo column + protected edit into the hub and retire it? | yes, after parity (Phase 1 keeps it reachable) |
| O4 | Estoque detalhado tabs → subpages (Locais, Separadas, Movimentos, Suprimentos), SKUs → Product Setup, Planner → keep as "Planejamento de estoque" inside the hub? | yes, staged; retire only after Bruno used the new ones for a week |
| O5 | Side panel vs full record page for the product drill-in? | side panel in Phase 1 (fast, keeps the list), full page later if needed |
| O6 | Show "Dias de estoque" and "Veeqo" columns in Phase 1? | Veeqo yes (comparison, drives drift), Dias optional toggle |
| O7 | Approver identity: today admin logins are shared PINs (Admin/Henrique). Is per-person login needed before approvals go live? | record `app_logins.name` + person link; add per-manager logins later (RBAC roles-not-names) |
| O8 | Approval aging threshold and where the nag goes | 2h, admin-orin, once per proposal |
| O9 | First real data: who registers bins/boxes and the first entrada, and when? | Bruno/Henrique via Locais + Entrada on the new hub (day 1 task) |
| O10 | `STOCK_DEDUCT_MODE` in Railway (cannot read env) | confirm value; keep dry until SKUs confirmed, then live |

---

## 9. Build plan (after Bruno approves this study)
**Phase 1 (hub + queue):** migration 071 (`stock_change_requests`; `stock_issues.reason` + `return`); `StockRequestService` (propose/approve/reject → StockService); `StockService.separate/resolveIssue` + `warehouseByProduct` with reserved/available/separated/pending; new router `src/v3/warehouse/router.js` (`/api/v3/warehouse/overview | product/:id | requests | returns | issues/:id/resolve`, RBAC `view_stock`/`manage_stock`); `veeqo-order-sync` shelf-first pick; dashboard: Shell nav (Warehouse section + P&P subsection + Planejamento/Produto next to Metas), `WarehousePage` (hub + side panel + modals), `ApprovalsPage`, `LocationsPage`; tests; ARCHITECTURE.md + map S15 rows → CURRENT; Obsidian; roadmap card (with OK).
**Phase 2 (operator):** Central de P&P & Estoque: Repor prateleira, Registrar → proposals, states in "Registrado hoje".
**Phase 3:** Separadas/Movimentos/Suprimentos subpages; retire Ver estoque + Estoque detalhado after parity; nightly Veeqo reconciliation (alerts only); ADD/REMOVE to Veeqo; End Of Day Shipment; 4x6 Printer Settings; then labels Phase 2 (print from our system at .246 with footer).

---

## 10. Bruno's answers, round 2 (2026-08-18) — DECIDED, and one thing to verify

**O2 DECIDED — "took N outside an order" = pending, provisionally deducted.** The proposal is created immediately; the qty is shown as *deduzido provisoriamente*, stops counting toward Disponível at once, appears as **−N pendente** on the row and in Aprovações; approve → real movement (shelf first, box second); reject → restored. Danificada / return received → Separadas immediately (physical fact); *back to stock* needs approval.

**O3/O4 DECIDED — ONE page manages the entire inventory.** "Ver estoque" and "Estoque detalhado" merge into the hub. Per product the hub must show and let us manage: **Units on hand** (our total), **Prateleira/bin**, **Caixa/box**, **Total no armazém**, and **Veeqo confirms the total** — Veeqo's total should ALWAYS match the product total; mismatch = a status, not a silent difference.

**NEW — "A organizar" (unassigned) bucket.** Bruno: "if we have a qty in the warehouse total but none on bins or boxes, we need to organize them and separate them." So the total is not only shelf + box: bottles can be in the warehouse **not yet placed** (just received from production, on a pallet). Model update:

> **Total no armazém = Prateleira + Caixa + A organizar.** Entrada may land in *A organizar*; the hub flags the product with status **organizar** until an admin/manager (or an approved operator move) places the bottles into shelves/boxes. Separadas stays outside the total (never sellable). Reservado/Disponível keep working on the total.

**NEW — SKU management lives on the hub too.** It must be easy to: **merge SKUs** into one product; **set a SKU family** (e.g. `LCAR-1500-C1, -C2, -C3, -C4`) and mark them **dependent**: the C1 bottle is the physical unit, C2 needs 2 bottles of C1, C3 needs 3, etc.; the multipacks are *built* from C1's quantity. Bruno: "think of it properly, because it should be smooth to manage this system and right now it's pretty complicated."
- What exists: `product_skus.units_per_pack` (per SKU, per channel) and `veeqo-order-sync` already deducts `qty × units_per_pack` bottles from the **product**. So the physical model already is "bottles of the base product"; a `-C2` order reserves/deducts 2 bottles. What's missing is the **UI**: a Family panel on the product record — base SKU, member SKUs with units per pack, per channel, "merge into this product", "detach", and the derived numbers per member SKU: *available packs = floor(available bottles ÷ units per pack)*.
- **⚠ Contradiction #15 (resolved):** memory 08-08 says "HF-BENF-300 ≠ -C2 ≠ -C4: different products, different stocks; never sum base + casepack." That rule is about **matching/duplicates** (they are different listings, never treat as dup). Inventory-wise Bruno now defines them as **one family over one physical stock**. Both hold: distinct SKUs, one bottle inventory.
- **MUST VERIFY with Veeqo before build (V1):** how do the casepack sellables behave in Veeqo — are `-C2/-C4` **Veeqo kits/bundles** (Veeqo derives their stock from the base sellable automatically, and shipping a C2 decrements the base by 2), or **independent sellables** with their own stock (then Veeqo's C1 and C2 stocks are set separately from the same bottles, shipping a C2 decrements only C2, and "Veeqo confirms the total" must be computed as *base + Σ member × units*, which double-counts unless someone keeps them in sync)? This decides how the **Veeqo ✓ column** and the future ADD/REMOVE to Veeqo are computed. It is a read-only API check (`listSellables` fields for bundle/kit); I will do it and report before we build the Veeqo column logic.

**NEW — light theme of the WHOLE dashboard = STYLE-KIT.** Not just the new page: dashboard-v4's light theme must follow `STYLE-KIT.html` (Kinto editorial: dot-grid ground, floating white pill navbar, DM Serif titles with one italic green word, navy pills, tonal chips, 18px cards, DM Mono micro-labels, no em dashes). Today only Picklist, InventorySettings, Roadmap and the operator Central follow it; the rest of dashboard-v4 uses older tokens/components. This is its own workstream (Phase 0/parallel): global tokens + Shell (pill navbar) + shared components (cards, chips, buttons, tables, KPI) → pages inherit; per-page inline styles adjusted progressively, verified by screenshot (design-fidelity rule).

### 10.1 Hub table — updated columns
```
PRODUTO (nickname · família/SKUs · locais)   TOTAL   PRATEL.  CAIXA  A ORG.  RESERV.  PEND.  DISPON.  SEPAR.   VEEQO ✓    STATUS
Benfotiamine 300 · HF-BENF-300 (+C2,C4)      226     46       180    0       12       0      214      2        226 ✓      ● ok
Berberine 500                                110     0        110    0       14       0      96       0        110 ✓      ● repor prat.
Chlorophyll                                   41     41         0    0        3      −3      35       1        41 ✓       ● pendente
L-Carnitine 1500 (família C1..C4)            300     48       252    0       20 (=C1 8 + C2 6×2)   0   280   0   ??         ● verificar Veeqo (V1)
NAC 600                                       80     0          0   80        0       0       80      0        80 ✓       ● organizar
```
- **A ORG.** > 0 → status *organizar* + action **Organizar** (place into shelf/box).
- **PEND.** = net of pending proposals (−took, +entrada) already excluded from DISPON.
- **VEEQO ✓** = Veeqo total for the product (family-aware once V1 is answered) with ✓ when it equals TOTAL, else Δ in bad chip → status *drift* (alert only, human decides).
- Row actions: Entrada · Organizar · Mover · Ajustar · Separar · Devolução · Família/SKUs · Veeqo (protected edit).

### 10.2 Product record — Family/SKUs panel (new)
Base SKU (physical bottle) · member SKUs with channel + units per pack (C2=2, C3=3, C4=4) · per member: Veeqo stock, derived available packs · buttons: *Adicionar SKU à família* (from the channel SKU list, same picker as Product Setup), *Mesclar produto* (merge another product's SKUs/stock into this one, 2-step confirm), *Desvincular*. This replaces the scattered SKU tab + Product Setup chip editing for day-to-day use (Product Setup keeps nickname/color/tiers/HOLD).

### 10.3 Remaining OPEN after round 2
| # | Question | Recommendation |
|---|---|---|
| V1 | Veeqo casepacks: kits/bundles or independent sellables? | I verify read-only via API and report |
| O5 | Side panel vs full record page | side panel first |
| O7 | Approver identity with shared admin PINs | record login name + person now; per-manager logins soon (roles-not-names) |
| O8 | Approval aging nag | 2h → admin-orin |
| O9 | Who registers bins/boxes + first entrada, when | Bruno/Henrique on the new Locais + Entrada, day 1 |
| O10 | `STOCK_DEDUCT_MODE` in Railway | confirm; dry until SKUs confirmed |
| O11 | STYLE-KIT for the whole dashboard: do it before, alongside, or after the hub? | alongside: tokens + Shell + shared components first (1 pass), hub built on them, other pages follow |

### 10.4 V1 VERIFIED (read-only Veeqo API, 2026-08-18): casepacks are Veeqo **Kits**
Probe of `/products?query=LCAR` (warehouse 108841): `HF-LCAR-1500` = `type:"ProductVariant"`, physical 180 / allocated 0 / available 180. `HF-LCAR-1500-C2` = `type:"Kit"` available **90** (=180÷2), `-C3` Kit **60** (=180÷3), `-C4` Kit **45** (=180÷4). Same for `HF-CHRO-1000` (available 133) → `-C2` Kit 66. **Veeqo derives kit availability from the base sellable and, on shipping a kit, decrements the base by units.** Consequences (all consistent with what we already built):
- **The physical stock of a family lives on the base SKU (the bottle).** Our product = the bottle; member SKUs carry `units_per_pack` (already in `product_skus`); the sync already deducts `qty × units_per_pack` bottles when a kit line ships. Nothing to change in the ledger model.
- **"Veeqo confirms the total"** = compare our product TOTAL with the base sellable's `physical_stock_level` (never sum kits). Bonus: Veeqo's `allocated` ≈ our Reservado and `available` ≈ our Disponível → the hub can show a three-way check (total↔physical, reservado↔allocated, disponível↔available) per product; mismatch → drift status (alert only).
- **ADD/REMOVE to Veeqo (later)** writes the **base sellable only**; kits follow automatically ("kits not writable" in the Deep Study is exactly this).
- **Family panel UI**: base SKU (ProductVariant) + members (Kit, units per pack) per channel; derived *available packs* per member = floor(available bottles ÷ units). "Merge SKUs" = attach a channel SKU to this product with its units per pack (Kit) or as base (ProductVariant); Veeqo type is shown as a chip so a wrong mapping is visible.
- Contradiction #15 stands resolved: distinct listings for matching, one bottle inventory for stock — and Veeqo agrees.
