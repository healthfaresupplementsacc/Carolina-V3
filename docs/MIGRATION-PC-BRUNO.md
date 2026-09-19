# Migration of the Claude satellites from PC "B" to a new PC

Audit date: 2026-09-18. Full runbook (inventory, storage map, move plan, contact channels):
https://claude.ai/code/artifact/1e88a2c3-3865-4a2f-bf3c-55a1ea39270a

## What runs on B and moves

| Item | File | Moves? |
| --- | --- | --- |
| Scheduled task "HealthFare Claude Autostart" (boot+logon, S4U) | scripts/analyst/install-autostart.ps1 -> start-watchdog-hidden.vbs | reinstall |
| Slack watchdog | scripts/analyst/slack-watchdog.js | yes |
| Socket Mode listener | scripts/analyst/slack-socket-listener.js | yes (needs _watch/tokens.json) |
| Scheduler + 4 tasks | scripts/analyst/scheduler.js + _watch/tasks.json | yes |
| Scheduled task "HealthFare drift check" (Sun 06:00) | drift-check.ps1 | recreate |
| Carolyn Chrome profile %LOCALAPPDATA%\hf-carolina-chrome | - | NO, DPAPI. One human login on the new PC |
| scripts/analyst/_watch/ (gitignored: tokens, creds, tasks, q-*.js, state) | - | copy by hand, skip *.log *.png *.jsonl |
| Claude memory %USERPROFILE%\.claude\projects\c--Claude-Projects-Supplements-Production-Line\memory | - | copy, keep the SAME project path |
| ~/.ssh/hf-tracker-cam (+.pub) | - | copy |
| Logins: Claude Code, Railway CLI, git/GitHub, Tailscale, Google Drive (G:) | - | re-login |

Dead on B, delete: hf-carol-ana-checkout-0730 (one-shot, fired 07-30), TasksPageBackup-8AM/8PM (point at an old OneDrive path; tasks-page now lives in C:\Claude Projects\tasks-page).

Cutover rule: disable the autostart task on B and kill its node processes BEFORE starting the task on the new PC. Two machines = duplicate Slack replies and duplicate scheduled posts.

## Handoff folder on Google Drive (added 09-18, after Bruno's OK)

`G:\My Drive\Clinic\Obsidian Bruno\HealthFare\Production Line Tracker\_handoff\` is mirrored from PC B every hour by the scheduled task "HealthFare handoff mirror" (scripts/analyst/handoff-mirror.ps1, registry key handoff_mirror). It holds everything that is NOT in git: `_watch/` (secrets, tasks, query helpers, state), `claude-memory/`, `claude/settings.json`, `ssh/hf-tracker-cam(.pub)`, this runbook and the setup script. `LAST-MIRROR.txt` says when and from which PC. Never share that folder: it contains Carolyn's Slack login and the app tokens.

The code itself stays on the local disk and travels through GitHub (branch v3-reset). Do not put the repo on Drive: the autostart task runs at boot before Drive mounts G:, and git + node_modules do not survive Drive sync.

### On the new PC, in this order

1. Sign in to Google Drive for desktop and wait for G:. Open the `_handoff` folder.
2. Double-click `setup-new-pc.cmd`. It installs Git, Node, Chrome, Tailscale, Drive, Claude Code and the Railway CLI, clones the repo to `C:\Claude Projects\Supplements Production Line\healthfare-tracker`, copies the handoff files into place, and prints a check table. It does NOT install the autostart task.
3. Log in by hand: `railway login`, Tailscale, run `claude` once.
4. On PC B: disable the task "HealthFare Claude Autostart" and kill its node processes (restart-satellites.ps1 -KillChrome -NoStart, elevated). Both PCs running = Carolyn answers twice.
5. In the repo folder run `claude` and paste the prompt above.

## Prompt for Claude Code on the new PC

Open a terminal in C:\Claude Projects\Supplements Production Line\healthfare-tracker, run `claude`, paste:

```
You are Claude Code on Bruno's NEW computer. This PC is taking over the Claude satellites of the HealthFare Supplements Production Line system from the old PC "B" (Tailscale 100.101.211.121). Railway runs the app, the database and all backend workers; the print PCs .28 and .246 talk to Railway directly. Nothing there changes. Only the pieces that ran on B move here.

What ran on B and must run here identically:
1. Scheduled task "HealthFare Claude Autostart" (boot + logon, S4U, no session needed) that runs scripts/analyst/start-watchdog-hidden.vbs, which launches three hidden loops: run-watchdog.cmd (slack-watchdog.js), run-listener.cmd (slack-socket-listener.js), run-scheduler.cmd (scheduler.js).
2. Scheduled task "HealthFare drift check", weekly Sunday 06:00, action: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude Projects\Supplements Production Line\healthfare-tracker\drift-check.ps1".
3. The Carolyn Chrome profile at %LOCALAPPDATA%\hf-carolina-chrome, opened with remote debugging on port 9222, logged into Slack workspace usgsteamworkspace as Carolyn.

Read first, before touching anything: src/v3/process-registry.js (entries with where: 'pc-bruno'), scripts/analyst/install-autostart.ps1, scripts/analyst/start-watchdog-hidden.vbs, scripts/analyst/scheduler.js, scripts/analyst/_watch/tasks.json, and your memory index MEMORY.md. Do not rewrite these scripts; they are the source of truth and already work.

Do, in this order, and stop to report if any check fails:
1. Verify the path is exactly C:\Claude Projects\Supplements Production Line\healthfare-tracker. If not, stop and tell Bruno; memory and the scheduler depend on it.
2. Verify: node -v is 24.x; %USERPROFILE%\.local\bin\claude.exe exists; railway whoami says healthfare supplements; git remote -v shows Carolina-V3; scripts/analyst/_watch/tokens.json, slack-creds.json, tasks.json and q-packing.js exist; %USERPROFILE%\.claude\projects\c--Claude-Projects-Supplements-Production-Line\memory\MEMORY.md exists; %USERPROFILE%\.ssh\hf-tracker-cam exists; G:\My Drive\Clinic\Work From Home\Carol is reachable; Tailscale is up. Print a table of these checks.
3. Run npm install if node_modules is missing.
4. Ask Bruno to confirm that on PC B the task "HealthFare Claude Autostart" is DISABLED and its node processes are dead. Do not continue until he confirms. Two machines running the satellites means duplicate Slack replies.
5. Ask Bruno to log Carolyn into Slack by hand: run scripts/analyst/carolina-chrome.ps1 so Chrome opens with port 9222, then he logs in in that window. Never type the Google password from a script. Confirm login by taking a screenshot through CDP and looking at it, not by checking a cookie or selector.
6. Run, elevated: powershell -ExecutionPolicy Bypass -File scripts/analyst/install-autostart.ps1. Then start the task. Within 60 seconds scripts/analyst/_watch/heartbeat.txt, listener-alive.txt and scheduler-alive.txt must have fresh timestamps. Show them.
7. Run node scripts/analyst/scheduler.js --test and confirm it reaches claude.exe.
8. Create the weekly drift check task described above.
9. Send ONE test message with node scripts/analyst/carolina-say.js to the admin channel only (ask Bruno which), then delete it. Never post tests in employee channels.
10. Update src/v3/process-registry.js: the four 'pc-bruno' entries now say which machine they run on (this PC's hostname and Tailscale IP). Add a Build log entry in Obsidian (G:\My Drive\Clinic\Obsidian Bruno\HealthFare\Production Line Tracker) and a line on the Roadmap board. Commit with a clear message; do not push or deploy unless Bruno says so.
11. Start a session reachable from other machines: in this folder run claude --remote-control and leave it open, so Claude on other computers can message this one.

Rules that apply here exactly as on B: your name in Slack is Carolyn; short human messages, no em dashes, kkkk not hahaha, AM/PM times; never post tests in operator channels; never go through a Google login by script; record everything, never block the operator.
```

## Reaching the new PC

- Claude Code Remote Control: on the new PC run `claude --remote-control` in the repo; the session shows up in other sessions' agent list on this account and accepts messages. Goes through Anthropic, not Tailscale; dies with the terminal.
- SSH over Tailscale: enable OpenSSH Server on the new PC, sshd Automatic, add hf-tracker-cam.pub to C:\ProgramData\ssh\administrators_authorized_keys. From another machine: `ssh -i ~/.ssh/hf-tracker-cam <user>@<tailscale ip>`. Same pattern as .246/.28.
