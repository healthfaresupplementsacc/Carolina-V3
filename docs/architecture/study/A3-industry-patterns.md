# Big-business inventory model → small D2C supplement warehouse

Sources actually fetched: Salesforce Omnichannel Inventory glossary (https://help.salesforce.com/s/articleView?id=sf.inv_omnichannel_inventory_glossary.htm), Trailhead "Explore Omnichannel Inventory APIs" (https://trailhead.salesforce.com/content/learn/modules/omnichannel-inventory/explore-omnichannel-inventory-apis), Trailhead "Use the Omnichannel Inventory App" (https://trailhead.salesforce.com/content/learn/modules/omnichannel-inventory/use-the-omnichannel-inventory-app). Generic WMS concepts (bins, cycle counts, RMA quarantine, waves, ledgers, controls) are from general knowledge.

## 1. Canonical quantity fields and formulas

Salesforce Omnichannel Inventory (OCI) definitions, verbatim from the glossary: **On Hand** = physical inventory available, not including future quantity; **Quantity Reserved** = inventory reserved for fulfillment; **Reservation** = inventory added to a cart or order when created (reduces ATF/ATO immediately); **Safety Stock Count** = intentionally held back, excluded from ATF/ATO; **Future Quantity** = expected/incoming (pre-order/backorder), included only in ATO; **Location** = physical place holding inventory; **Location Group** = set of locations with an aggregated availability view.

Formulas (Trailhead):

```
ATF (Available to Fulfill) = on_hand - reserved - safety_stock
ATO (Available to Order)   = on_hand + future - reserved - safety_stock
```

Generic WMS adds a **hold/quarantine** bucket that is physically present but not sellable, and a **reorder point** for replenishment. Practical set for the supplement warehouse:

| Field | Stored or derived | Note |
|---|---|---|
| `on_hand` per SKU per location | DERIVED from ledger (sum of moves) — or stored + rebuilt from ledger | Never hand-edited; changes only via a move/adjustment record |
| `reserved` | DERIVED = Σ open Veeqo order lines not yet shipped | Recompute on each Veeqo sync; don't persist as truth |
| `on_hold` (quarantine/damaged/returned) | DERIVED = on_hand of the "Separadas" location | It IS on hand physically, but excluded from sellable |
| `safety_stock` | STORED per SKU (config) | Buffer that ATF ignores |
| `incoming` / future | DERIVED from open POs / production batches expected | Only used for ATO / planning |
| `available (ATF)` | DERIVED = sellable_on_hand − reserved − safety_stock | sellable = on_hand minus hold bucket |
| `reorder_point`, `reorder_qty` | STORED per SKU | Alert when ATF (or ATO) ≤ reorder_point |
| `last_counted_at`, `variance` | STORED on the count record | Feeds cycle-count KPI |

Rule of thumb: everything physical is a **movement**; everything sellable is a **formula**. Only config (safety stock, reorder point) is typed by a human.

## 2. Standard record hierarchy

```
Product (nickname, color, size)
 └─ SKU (per channel mapping: Amazon FNSKU / TikTok / eBay / Walmart / Shopify)
     └─ InventoryLevel (SKU × Location)  ← on_hand, derived fields
          Locations: Shelf/bin S-01… (≈48 bottles), Box B-01… (>110), "Separadas" (hold), optionally "Pack station"
          Location Groups: "Sellable" = shelves + boxes ; "Hold" = Separadas
 └─ StockMove (ledger, append-only): id, sku, from_location, to_location, qty, reason, ref_type/ref_id (veeqo_order, count, batch, rma), actor, ts, idempotency_key
 └─ AdjustmentRequest: sku, location, delta or counted_qty, reason, photo/note, requested_by, status (pending/approved/rejected), approved_by → on approval writes a StockMove
 └─ Reservation (virtual): derived from Veeqo open order lines; released when shipped/cancelled
 └─ Return / RMA: order ref, sku, qty, condition (resellable / damaged / expired), received into "Separadas" first, then a disposition move: → shelf (restock) or → write-off
 └─ CycleCount: location, sku, expected, counted, variance, counter, status; variance ≠ 0 becomes an AdjustmentRequest
 └─ Alert: low stock, negative, drift vs Veeqo, count overdue, pending approval aging
```

Every quantity change type is a reason code on StockMove: `receive_batch`, `transfer` (box → shelf), `ship` (Veeqo shipped), `return_in`, `restock_from_hold`, `write_off`, `count_adjust`, `manual_adjust`, `sample/internal_use`.

## 3. UX patterns of the main inventory screen (ops manager)

OCI's console shows, per location and location group, exactly six numbers: ATF, ATO, on hand, future, reservations, safety stock — and the availability view is read-only; changes come through imports/adjustments/reservations. Enterprise WMS/OMS screens follow the same "numbers you can't type over" pattern.

**List page**
- KPI strip: total sellable units, SKUs at/below reorder point, units on hold, open reservations (units / orders), pending approvals, count overdue, drift vs channel (Δ units).
- Product table, one row per product/SKU: On hand · Reserved · Available (ATF) · Hold · Incoming · Days of cover (ATF ÷ avg daily sales) · status badge (OK / Low / Out / Negative / Drift / Count due).
- Filters: status, location group, channel; sort by available ascending by default (problems on top).
- Row actions gated by role: Transfer, Adjust (creates request), Count, View ledger.

**Record page (drill-in)** — header with the six numbers, then related lists:
1. Locations: each shelf/box/Separadas with qty, last counted, last move.
2. Open orders: Veeqo order lines reserving this SKU (order no., channel, qty, age).
3. Movements: ledger, newest first, with reason, ref, actor.
4. Holds: units in Separadas with condition and disposition status.
5. Pending approvals: adjustment requests awaiting sign-off.
6. Alerts: active + resolved.
7. Config: safety stock, reorder point, channel SKU map.

## 4. Operators vs managers

| Operators (pick/pack, shelf) | Managers/admin |
|---|---|
| Location-level view: what's on this shelf/box, what to pick | SKU-level totals, ATF, drift, KPIs |
| Actions: transfer box→shelf, record count, put in Separadas, "peguei X do estoque" quick exit, receive batch | Approve/reject adjustments, set safety stock/reorder point, write-off, restock from hold, resolve drift |
| See own alerts (count due, pick shortage) | See all alerts, approvals aging, ledger audit, reconciliation report |
| Never see: cost, drift math, other people's adjustments | Full ledger with actor names |

Operators create **facts** (moves, counts); managers create **decisions** (approvals, config). Nothing an operator does should be blocked (record now, review later), but anything that changes on_hand without a physical reason goes to the approval queue.

## 5. Failure modes and controls

| Failure | Cause | Control |
|---|---|---|
| Double deduction | Veeqo webhook + poll both process "shipped"; retries | Idempotency key on StockMove = `veeqo_order_id:line_id:shipped`; unique index; reprocess is a no-op |
| Negative stock | Shipped more than recorded; missed receipt/transfer | Floor at zero on the sellable location, but WRITE the move anyway (reality first) and raise a "Negative" alert + auto AdjustmentRequest to explain |
| Drift with channel (Veeqo/Amazon) | Manual edits in Veeqo, missed webhooks, returns not entered | Nightly reconciliation report: our ATF vs Veeqo available per SKU; Δ ≠ 0 → alert with drill-in; one system is master (ours), the other is pushed |
| Silent adjustments | Someone types a new quantity | No editable quantity fields; adjustments only via request with reason + approver; ledger append-only; every move has actor |
| Phantom availability | Hold units counted as sellable | Separadas is its own location, excluded from ATF by location group |
| Oversell during picking | Reservation created only at ship time | Reserve at order creation (open lines), release on cancel, convert to ship move on shipped |
| Count rot | Nobody counts | Cycle counting: ABC by velocity, "count due" badge, count overdue KPI |
| Missing returns | Return arrives, goes on shelf unrecorded | Return always enters Separadas first; disposition later; RMA count vs Veeqo returns reconciled |
| Lost visibility of transfers | Box opened, bottles moved to shelf, nothing recorded | Transfer is a one-tap operator action from the shelf view; picking from an empty shelf triggers "restock from box" prompt |

## 6. Mapping table

| Salesforce / WMS concept | This model |
|---|---|
| Product / SKU | Product (nickname+color) → channel SKUs (Amazon/TikTok/eBay/Walmart/Shopify) |
| Location | Shelf/bin (~48), Box (>110), Separadas, (Pack station) |
| Location Group "Sellable" | Shelves + Boxes |
| Location Group "Hold" | Separadas |
| Quantity on Hand | Σ moves per SKU across all locations |
| Sellable on hand | Σ shelves + boxes (excludes Separadas) |
| Quantity Reserved / Reservation | Open Veeqo order lines not yet shipped (derived, refreshed on sync) |
| ATF (Available to Fulfill) | sellable_on_hand − reserved − safety_stock |
| ATO / Future Quantity | ATF + incoming (batches in production/expected POs) |
| Safety Stock Count | Per-SKU config |
| Reorder point | Per-SKU config → Low badge + alert |
| Fulfill reservation → adjust on hand | Veeqo "shipped" → StockMove `ship` (shelf → out), idempotent per order line |
| Transfer / move | Box → shelf `transfer` move |
| Inventory adjustment (with approval) | AdjustmentRequest → approved → StockMove `count_adjust`/`manual_adjust` |
| Cycle count | CycleCount per location; variance → AdjustmentRequest |
| Returns / RMA quarantine | Return received into Separadas; disposition = restock or write-off |
| Damaged / hold bucket | Separadas location |
| Audit ledger | StockMove append-only with actor, reason, ref, idempotency key |
| Reconciliation with channel | Nightly ours-vs-Veeqo per SKU report + Drift alert |
| Pick list / wave / pack / ship | Veeqo owns picking and shipping; our system reserves at open, deducts at shipped |
| Alerts | Low, Out, Negative, Drift, Count due, Approval aging |
