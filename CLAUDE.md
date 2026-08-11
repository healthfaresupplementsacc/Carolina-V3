# healthfare-tracker

Production floor system for HealthFare. Tracks people, attendance, tasks, production
line phases, stock, orders, printing and cameras. Talks to Slack. Node + Express +
Postgres.

## Before you do anything

Read these two files at the start of any structural task:
- `docs/system-context.md`
- `INTEGRATION_PLAN.md`

If your task touches duplicated concepts, also read
`docs/investigacao/05-modelos-duplicados.md` and
`docs/investigacao/10-proposta-arquitetura-unificada.md`. Do not re-derive
conclusions that are already written there.

## Entry point

`src/index.js` is the only entry point. `npm start` runs it. Anything not reachable
from `src/index.js` is not running in production.

## Two generations, both live

This codebase has a legacy layer (`src/`) and a newer layer (`src/v3/`). BOTH ARE
LIVE. `src/v3/wire.js` bridges them. Do not delete, archive, or "consolidate" either
tree without explicit instruction.

Where the same concern exists twice:

| Concern | Legacy | V3 | Which to use for new work |
| --- | --- | --- | --- |
| Slack | `src/slack/` | `src/v3/slack/` | TODO: confirm |
| Data access | `src/db/` | `src/v3/data/` | TODO: confirm |
| AI / LLM | `src/ai/` | `src/v3/llm/` | TODO: confirm |
| Admin | `src/admin/` | `src/v3/admin-v3/` | TODO: confirm |
| Utils | `src/utils/` | `src/v3/utils/` | TODO: confirm |

Bruno: fill in the right-hand column. Until it is filled in, Claude will keep
guessing, and guessing is what caused the drift.

## Schema

`src/v3/schema/migrations/` is the single source of truth for the database. Numbered
sequentially with matching `.down.sql` files. Never write DDL anywhere else. Never
edit an existing migration; add a new numbered one.

## Dashboard

`dashboard-v4/` is the current dashboard source. It builds into
`public/dashboard-v4/assets/`.

`dashboard/` and `public/dashboard/` are the previous generation.
`src/dashboard/template.js` is a separate server-rendered surface.

Do not edit built assets under `public/`. Edit the source in `dashboard-v4/src/` and
rebuild.

## Tests

Jest. `npm test`. Tests live in `src/__tests__/` plus module-local `__tests__/`
folders.

Run the relevant tests after every change. For anything touching integration between
modules, run at minimum:
- `src/__tests__/v3-integration.test.js`
- `src/__tests__/smoke.e2e.test.js`
- `src/__tests__/workflow.e2e.test.js`

A change is not done until the tests pass. Do not report success without running them.

## Files that are too large

These exceed what can be reasonably held in context. Read only the specific functions
you need. Never load two of them in the same task.

- `src/routes/op.js` (3457)
- `src/dashboard/template.js` (2844)
- `src/op/fuse-data.js` (2417)
- `src/op/app.js` (2331)
- `src/routes/api.js` (2119)
- `src/v3/data/router.js` (2106)

Do not add lines to these files. New behaviour goes in a new module.

## scripts/ is an archive, not code

`scripts/` contains several hundred dated one-off diagnostic and migration scripts
from past incidents (`v3-diag-*`, `v3-fix-*`, `v3-apply-migration-*`, `smoke-*`).

Do not read these when searching for how the system works. Do not use them as
examples of current patterns. Do not modify them. Exclude `scripts/` from any
codebase-wide search unless the task is explicitly about a script.

The same applies to `snapshots/`, `scripts/archive/`, `scripts/analyst/_backup/`, and
`docs/investigacao/_raw/`.

## Production safety

This project connects to a live production database used by the warehouse daily.

- Never run a script that writes to production without explicit confirmation in the
  current conversation.
- Never run migrations unprompted.
- Never wipe, reset, or bulk-delete data.
- `scripts/backup-prod-db.js` exists. Suggest it before any destructive operation.

## Working rules

- When a task spans more than one module, state the full list of files you will
  change BEFORE changing any of them, and wait for confirmation.
- When you find the same concept defined in two places, report it. Do not silently
  pick one.
- Do not create a new version of an existing module (`-v2`, `-new`, `-final`). Modify
  the existing one or explain why you cannot.
- Portuguese is used in some docs and Slack copy. Keep existing language; do not
  translate.
