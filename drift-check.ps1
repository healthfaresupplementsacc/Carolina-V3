# drift-check.ps1 — weekly architecture-drift check for healthfare-tracker.
#
# 1. cd to the project.
# 2. Run `claude -p` to re-trace the running system from src/index.js and write
#    docs/DRIFT-<yyyy-MM-dd>.md listing ONLY differences from docs/ARCHITECTURE.md
#    (or exactly "no drift").
# 3. Post the result to Bruno on Slack via scripts/post-drift-to-slack.js, run under
#    `railway run` so SLACK_BOT_TOKEN comes from the project's env (never hardcoded).
#
# All stdout/stderr is appended to drift-log.txt. Never touches the database or code.

$ErrorActionPreference = 'Continue'
$proj = 'C:\Claude Projects\Supplements Production Line\healthfare-tracker'
Set-Location $proj
$log = Join-Path $proj 'drift-log.txt'
$today = Get-Date -Format 'yyyy-MM-dd'

function Append-Log([string]$msg) {
  $line = "[{0}] drift-check: {1}" -f (Get-Date -Format 's'), $msg
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Output $line
}

Append-Log "=== run start ($today) ==="

$prompt = @'
Read CLAUDE.md and docs/ARCHITECTURE.md. Re-trace what actually runs starting from src/index.js. Write docs/DRIFT-<yyyy-MM-dd>.md listing ONLY differences from the architecture doc: anything running the doc does not describe, anything the doc claims no longer exists, any table with a new writer. If there are no differences write exactly 'no drift' and nothing else. Modify no other file. Do not touch code or the database.
'@
# Substitute today's date into the filename the model should write.
$prompt = $prompt -replace '<yyyy-MM-dd>', $today

# --- Step 1: run claude -p, capture all output to the log ---
try {
  Append-Log "invoking claude -p ..."
  $out = & claude -p $prompt 2>&1 | Out-String
  Add-Content -Path $log -Value $out -Encoding utf8
  Append-Log "claude -p finished (exit $LASTEXITCODE)"
} catch {
  Append-Log ("claude -p FAILED: " + $_.Exception.Message)
}

# --- Step 2: post the newest DRIFT file to Slack (railway run injects SLACK_BOT_TOKEN) ---
try {
  Append-Log "posting drift result to Slack ..."
  $post = & railway run --service ProductionLineService node scripts/post-drift-to-slack.js 2>&1 | Out-String
  Add-Content -Path $log -Value $post -Encoding utf8
  Append-Log "slack post step finished (exit $LASTEXITCODE)"
} catch {
  Append-Log ("slack post step FAILED (non-fatal): " + $_.Exception.Message)
}

Append-Log "=== run end ==="
