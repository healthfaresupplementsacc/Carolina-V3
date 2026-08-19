# S15 · Phase 2 PLAN — operator proposals + full STYLE-KIT theme (Bruno 2026-08-18: "termina a fase 2, termina tudo, bora")

## Decisions in force (from the study §0/§10)
- Operator "Peguei do estoque" = **pending proposal, provisionally deducted** (excluded from Disponível at once, shown as −N pendente); admin approves → real `pick` (shelf first, box second) / rejects → restored. RULE #0: never blocks, always records.
- Operator "Danificada" = **Separadas immediately** (physical fact) via `StockService.separate` (reason 'other' unless label/seal given).
- Operator **shelf↔box moves (Repor prateleira) apply immediately** (`StockService.restock`), logged, admin-reversible.
- Operator **Entrada / Contagem / Devolução recebida** = proposals (`StockRequestService.propose`), wait for approval.
- The raw `INSERT INTO v3.stock_movements` at `op.js:314-329` (R076) is REMOVED by this phase (replaced by the request).

## Operator API contract (`/api/v3/op/*`, Bearer page token + kiosk session as today)
- `POST stock/take {product_id, qty(1..5000), kind:'pick'|'damaged', reason?}` →
  - kind `pick`: creates request `{kind:'take', direction:'out'}` → `{ok:true, request_id, status:'pending', kind:'take'}`
  - kind `damaged`: `StockService.separate({reason:'other', note: reason})` (is_test = sandbox) → `{ok:true, issue_id, applied, kind:'damaged'}`
- `POST stock/propose {product_id, kind:'entrada'|'count'|'return_in', qty, bin_id?, box_id?, reason?}` → `{ok:true, request_id, status:'pending'}` (direction: entrada/return_in = 'in', count = 'in' with note 'contagem: found=<qty>' — approve applies `count` on the given bin/box when provided; if no location, applies as `adjust`? NO — count without location = proposal note only, approve = `storeIn` to unplaced when direction in… keep simple: `count` requires bin_id or box_id in the UI).
- `POST stock/restock {bin_id, box_id, qty, found_bin_qty?, found_box_qty?, note?}` — existing handler; **gate becomes session-only** (any logged operator), no `STOCK_UI_ENABLED` needed. Same for `GET stock/context` (read-only lists needed by the operator page). `stock/store` and `stock/count` keep the old gate (admin/kiosk-only paths).
- `GET stock/recent` → `{ok:true, items:[{id, kind:'take'|'damaged'|'restock'|'entrada'|'count'|'return_in', qty, note, created_at, product, nickname, status:'pending'|'approved'|'rejected'|'applied'}]}` — this operator's last 16h: requests (by `proposed_by_person_id`, is_test = sandbox) + issues created by them (damaged, status applied) + restock movements by them (applied). Newest first, max 30.
- All handlers live in NEW `src/v3/warehouse/op-stock.js` (`createOpStock({db, stock, requests})` returning functions); `src/routes/op.js` only calls them — **op.js line count must not increase** (replace the raw-insert block and the recent query with calls; verify `wc -l` before/after).

## Operator UI (`src/op`)
- Workspace rendering + handlers move to NEW `src/op/ws.js` (loaded by `index.html` before `app.js`, added to `sw.js` shell cache with a version bump); `app.js` keeps only thin calls → its line count must NOT increase.
- Column 2 "Registrar" (was "Registrar saída de estoque"): segmented `Peguei do estoque` · `Danificada` · `Entrada` · `Contagem`; qty stepper; reason; for Entrada/Contagem an optional destination (bin/box from `stock/context`); submit → per contract; toasts: pick → "Registrado. Vai pra aprovação do admin, já saiu do disponível." (short, no em dash), damaged → "Danificada registrada (Separadas)", entrada/count → "Enviado pra aprovação".
- New card "Repor prateleira": bins with `needs_restock` (from `stock/context`) with the product's boxes; one tap → `stock/restock` (qty default = min(box qty, bin capacity gap or box qty)); toast "Prateleira reposta".
- "Registrado hoje": each item shows a state chip: pendente (warn) / aprovado (ok) / recusado (bad) / aplicado (neutral).
- Keep the picklist, PRINT and stock-gaps exactly as they are. Style = same STYLE-KIT tokens already used inline in the workspace.

## Dashboard: STYLE-KIT 100% (Bruno: "segue todo o tema do novo estilo 100% aplica pra tudo urgente")
- Remove the `--drop-hl` "water-drop" overlays (`.card::before`, `.sidebar::before`, `.kpi.attn::before`) in BOTH themes — they wash out the top rows of tables ("letras claras em cima, escuras embaixo").
- Every dashboard-v4 page uses kit tokens/classes: cards 18px, DM Serif page titles with one italic green word, DM Mono micro-labels, tonal chips, navy pill buttons, dotted rows, kit tables, kit inputs. Old palette vars fully mapped or replaced. Dark theme: keep functional (kit tokens re-mapped to a dark set) but light is the priority.
