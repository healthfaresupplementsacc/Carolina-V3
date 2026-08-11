# Session Report — 11 Aug 2026

Autonomous cleanup + documentation session on branch `v3-reset`. All hard limits
respected: no production DB access, no migrations, no data-writing scripts, no file
deletions (archived instead), no edits under `src/workers/`, `src/v3/`, or
`src/dashboard/` beyond documentation, no `-v2`/`-new`/`-fixed` files, and `npm test`
passing before every commit.

## What was committed

| Part | Hash | What |
| --- | --- | --- |
| 1 | `6987201` | Archived dated one-off scripts + snapshots (moved to `..\healthfare-archive\`, deleted from tree via `git`). |
| 2 | `91fe470` | `CLAUDE.md`: resolved the 5 legacy-vs-v3 TODO cells with runtime evidence from `wire.js` + `index.js`. |
| 3 | `fed6d2d` | Fixed the failing `op-redesign.test.js` — added 4 real endpoints to the test's `REAL` whitelist. |
| 4 | `fe24ae5` | Added `docs/ARCHITECTURE.md` (runtime trace, 10 domains, NOT REACHABLE / BROKEN LINKS / UNCERTAIN). |
| 5 | `6b73129` | `CLAUDE.md`: added `docs/ARCHITECTURE.md` to the "Before you do anything" list. |

Test state at end: **205 suites pass, 2502 tests pass, 2 skipped, 0 fail.**
(Started the session at 204 passing suites with 1 failing; Part 3 brought it to 205.)

## What the op-redesign endpoint problem turned out to be

The test `op-redesign.test.js` › "todo /api/v3/op/ usado é endpoint REAL" scans
`src/op/app.js` (the operator-page frontend) for every `/api/v3/op/` URL it calls and
asserts each maps to a real backend route in a hardcoded `REAL` array.

**Neither the frontend nor the backend was wrong.** The 4 URLs it flagged —
`/api/v3/op/picklist`, `/api/v3/op/stock/recent`, `/api/v3/op/stock-gaps`,
`/api/v3/op/stock/take` — are all **real, registered backend routes** in
`src/routes/op.js` (lines 293, 303, 314, 332), added by the 08-06 "P&P Workspace" work.
The frontend calls them correctly and the backend serves them.

The bug was that the **test's `REAL` whitelist was stale** — it was never updated when
those 4 legitimate endpoints were added. The smallest correct fix was to add the 4
real routes to the whitelist (side changed: the **test**, not the frontend or backend).
Committed in `fed6d2d`.

## Findings marked BROKEN LINKS (in ARCHITECTURE.md)

These are the concrete "what is not synchronizing" items. None were fixed this session
(the instructions scoped this session to documentation + the one test); they are the
backlog to work through one at a time.

1. **`v3.events.ended_at` — 5+ independent writers** (op.js raw SQL, EventService,
   attendance-sync, ems-activity-sync, plus admin/CommandHandler/Observer/BatchService/
   merge/workflow-engine). The `EventService.js:5-21` "single write-door" invariant is
   not enforced against op.js.
2. **`v3.production_counts` — 3 writers** (ProductionCountService canonical, op.js direct,
   admin.js). op.js bypasses the dedup/supersede logic. The `wire.js:180` "one write path"
   comment only covers the followup-total path.
3. **`v3.stock_movements` — dual-path ledger** (StockService idempotent door vs raw kiosk
   INSERT `op.js:324` that skips bin/box qty updates and idempotency).
4. **`SupplyService.consumeForSize` — no production caller** (the label-print → supply-
   deduct edge is defined but only reachable from tests; the loop is not closed).
5. **Orders count double source** — operator-typed `production_counts kind='orders'`
   (`op.js:1739`) vs the Veeqo line mirror (`v3.pnp_order_lines`). `print-divergence-
   watchdog` reconciles them at noon; working as intended but two sources of one truth.

## Findings marked UNCERTAIN

- `v3.admin_chats`: no writer found in the V3 LLM path; likely not an AI-owned table
  (admin-chat is legacy `src/slack/admin-chat.js`). Not confirmed either way.
- `src/routes/admin.js` writes to production_counts / product_batches / events were cited
  from grep, not a full read of that file. Exact lines/semantics partially verified.
- The `ended_at` write lines inside `CommandHandler.js` and `Observer.js` were grep-
  cross-referenced, not confirmed by a full read.
- The 7 "genuinely unreferenced" files in NOT REACHABLE were checked for
  `require('...basename')` + `<script>`/static mounts only. A file loaded by an unusual
  dynamic path could be mislabeled. Confidence high, not absolute.

## What I chose NOT to do, and why

- **Did not fix any BROKEN LINKS item.** The instructions scoped this session to Parts
  1–6 (archive, docs, one test). The dual-writer fixes touch `src/routes/op.js`,
  `src/v3/services/*`, and `src/workers/*` — live files that need their own scoped task
  with a stated file list and confirmation, per `CLAUDE.md` working rules. Documenting
  them first (which this session did) is the correct precursor.
- **Did not delete the 7 unreferenced files.** Hard limit: never delete. Also, some may
  be intentional spares (e.g. `FallbackProvider.js`) or test-only. Left in place, flagged.
- **Did not remove the legacy `.legacy` frontend files** (`op/app.legacy.js`,
  `op/sw.legacy.js`) even though only the unserved `index.legacy.html` references them —
  same no-delete limit; they are archivable in a future scoped task if desired.
- **Did not touch `src/routes/admin.js` to confirm its production_counts writes** — would
  have required reading a 2000+ line file the CLAUDE.md marks as too-large; left as
  UNCERTAIN rather than guess.
- **Did not run the legacy→ISA-88 migration or any script under `scripts/`** — production
  safety limit.

## Notes

- The `CLAUDE.md` and `RUN_THIS.md` line-ending warnings (LF→CRLF) during `git add` are
  cosmetic Windows warnings, not errors; every commit exited 0.
- `git push` was run only in the earlier STEP 1 (before this autonomous session); this
  session's Parts 1–6 are committed locally on `v3-reset` and were not pushed (the
  instructions did not ask for a push after each part).
