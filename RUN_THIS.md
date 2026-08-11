# RUN THIS — healthfare-tracker

Top to bottom. Do not skip. Total hands-on time about 40 minutes, plus waiting
on Claude Code.

Project root: `C:\Claude Projects\Supplements Production Line\healthfare-tracker`

Open PowerShell there:

```powershell
cd "C:\Claude Projects\Supplements Production Line\healthfare-tracker"
```

---

## STEP 1 — Save your work (2 minutes, do not skip)

```powershell
Remove-Item files.txt, modules.txt, range-check-tmp.js -ErrorAction SilentlyContinue
Move-Item "public\dashboard" "..\healthfare-archive\public-dashboard" -ErrorAction SilentlyContinue
git add -A
git commit -m "checkpoint: all work through 11 Aug 2026"
git push
```

If `git push` errors, keep going anyway. The local commit is what matters.

---

## STEP 2 — Clear the search noise (3 minutes)

```powershell
New-Item -ItemType Directory -Force "..\healthfare-archive\old-scripts"
Move-Item "scripts\v3-diag-*"            "..\healthfare-archive\old-scripts\" -Force
Move-Item "scripts\v3-fix-*"             "..\healthfare-archive\old-scripts\" -Force
Move-Item "scripts\v3-apply-migration-*" "..\healthfare-archive\old-scripts\" -Force
Move-Item "scripts\archive"              "..\healthfare-archive\old-scripts\" -Force
Move-Item "snapshots"                    "..\healthfare-archive\" -Force
npm test
```

Expect the same result as before: 204 suites pass, `op-redesign.test.js` fails.
If anything ELSE now fails, move the folders back and stop.

Then commit:

```powershell
git add -A
git commit -m "archive dated one-off scripts and snapshots"
```

---

## STEP 3 — Install CLAUDE.md and let it finish itself

Save the `CLAUDE.md` file into the project root. Then open Claude Code in the
project folder and paste:

> Read `CLAUDE.md` in the project root. It has a table of legacy-vs-v3 pairs
> with five TODO cells.
>
> Read `src/v3/wire.js` and `src/index.js` in full to determine, for each pair,
> which implementation actually handles requests at runtime and which is
> superseded. Then edit `CLAUDE.md` and replace each TODO with the correct
> answer plus a one-line reason citing the file and line that proves it.
>
> If you cannot determine one of them with confidence from the code, write
> UNRESOLVED rather than guessing, and say what would settle it.
>
> Change nothing else. Do not modify any file other than `CLAUDE.md`.

Read what it wrote. This file now loads automatically at the start of every
future session.

---

## STEP 4 — Fix the one failing test

Paste:

> `src/__tests__/op-redesign.test.js` fails on the check that every
> `/api/v3/op/` URL used maps to a real endpoint. Both this test and
> `src/routes/op.js` were modified today.
>
> Run the test. Identify the exact URL that has no matching backend route, the
> file and line that calls it, and where the nearest real endpoint is defined.
> Report all three. Do not fix anything yet.

Read the answer, then tell it to fix that one thing. Run `npm test`. Commit.

Get this green before Step 5. It is your drift detector and it needs to work.

---

## STEP 5 — The map you actually wanted

This is the deliverable. Paste:

> Read this project and produce `docs/ARCHITECTURE.md`. Do not modify any code.
>
> Start from `src/index.js` and trace what actually runs: every route mounted,
> every cron job scheduled, every worker started, every Slack listener attached.
>
> Then, for each domain — attendance, tasks, production line, stock, orders,
> printing, cameras, slack, admin, ai — document:
>
> 1. Which files own it.
> 2. Which database tables it reads and which it writes.
> 3. What it receives from other domains, and from which exact file.
> 4. What it sends to other domains, and to which exact file.
> 5. Where its state lives, and whether that same state is also written
>    anywhere else in the system.
>
> Then add three final sections:
>
> - NOT REACHABLE: every `.js` file under `src/` that nothing imports, with
>   line count.
> - BROKEN LINKS: anything emitted with no consumer, any consumer waiting on
>   something nothing emits, any state written in two places that could
>   disagree.
> - UNCERTAIN: anything you could not determine. Be honest here.
>
> Cite file and line for every claim. Exclude `scripts/`, `public/`, and
> `docs/investigacao/_raw/`.
>
> Do not recommend deletions.

This takes a while. Let it run.

When it finishes, read BROKEN LINKS. That section is the literal answer to
"what is not synchronizing." Everything after this is fixing those items one at
a time.

Then add this line to `CLAUDE.md` under "Before you do anything":

```
- `docs/ARCHITECTURE.md`
```

Commit.

---

## STEP 6 — The rule that keeps it from happening again

From now on, every task in Claude Code starts with this sentence:

> Before changing anything, tell me every file you will modify and why, and
> wait for my confirmation.

And ends with `npm test` passing in front of you.

That is it. Those two habits plus `CLAUDE.md` plus `ARCHITECTURE.md` are the
whole fix.

---

## Do not do these

- Do not delete `src/v3/` or `src/dashboard/`. Both are mounted and live.
- Do not delete anything in `src/workers/`. They run on cron.
- Do not ask for cleanup and refactoring in one prompt.
- Do not accept "everything is synchronized" without seeing tests pass.
