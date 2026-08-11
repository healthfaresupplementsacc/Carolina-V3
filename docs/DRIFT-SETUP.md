# Drift check — scheduled task setup

The weekly architecture-drift check is registered as a Windows Scheduled Task on
Bruno's machine.

## Status (2026-08-11)

**Registered successfully — no elevation was required.**

- Task name: `HealthFare drift check`
- State: Ready / Enabled
- Trigger: Weekly, **Sunday 06:00** (America/New_York)
- Next run at registration: 2026-08-16 06:00
- Action: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Claude Projects\Supplements Production Line\healthfare-tracker\drift-check.ps1"`

## What it does

`drift-check.ps1` runs `claude -p` to re-trace the running system from `src/index.js`,
writes `docs/DRIFT-<yyyy-MM-dd>.md` (only differences from `docs/ARCHITECTURE.md`, or
exactly `no drift`), then runs `scripts/post-drift-to-slack.js` under `railway run` to
DM the result to Bruno. All output is appended to `drift-log.txt`. Both `drift-log.txt`
and `docs/DRIFT-*.md` are gitignored.

## Re-registering (if the task is ever removed)

Run this in PowerShell (no admin needed, as it registers under the current user):

```powershell
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Claude Projects\Supplements Production Line\healthfare-tracker\drift-check.ps1"'
$trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 6:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "HealthFare drift check" -Action $action -Trigger $trigger -Settings $settings -Description "Weekly architecture-drift check; writes docs/DRIFT-<date>.md and DMs Bruno on Slack." -Force
```

## If registration ever fails on permissions

Run the same block from an **elevated** PowerShell (Run as Administrator), or add
`-User "SYSTEM"` / `-RunLevel Highest` to `Register-ScheduledTask`. As of 2026-08-11
this was not necessary.

## Verify / run manually

```powershell
Get-ScheduledTask -TaskName "HealthFare drift check"
Start-ScheduledTask -TaskName "HealthFare drift check"   # run now
```
