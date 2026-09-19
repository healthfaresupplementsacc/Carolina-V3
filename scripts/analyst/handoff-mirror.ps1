# handoff-mirror.ps1 - espelha pro Google Drive tudo que roda neste PC e NAO esta no git,
# pra outro PC poder assumir os satelites do Claude (Bruno 09-18, "ok do it git and all").
# Roda de hora em hora pela Scheduled Task "HealthFare handoff mirror". Se o G: nao estiver
# montado (Drive fechado, ninguem logado), sai quieto e tenta na proxima hora.
# Segredos (tokens.json, slack-creds.json) VAO junto: o Drive e privado do Bruno, nunca compartilhar a pasta.
$ErrorActionPreference = 'Continue'
$Dest = 'G:\My Drive\Clinic\Obsidian Bruno\HealthFare\Production Line Tracker\_handoff'
if (-not (Test-Path 'G:\My Drive\Clinic')) { exit 0 }
$Repo = 'C:\Claude Projects\Supplements Production Line\healthfare-tracker'
$Here = Join-Path $Repo 'scripts\analyst'
New-Item -ItemType Directory -Force -Path $Dest, "$Dest\ssh", "$Dest\claude" | Out-Null
robocopy "$Here\_watch" "$Dest\_watch" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /XF *.log *.log.* *.png *.jsonl *.pid /XD obsidian-pendente | Out-Null
robocopy "$env:USERPROFILE\.claude\projects\c--Claude-Projects-Supplements-Production-Line\memory" "$Dest\claude-memory" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
Copy-Item "$env:USERPROFILE\.claude\settings.json" "$Dest\claude\settings.json" -Force -ErrorAction SilentlyContinue
Copy-Item "$env:USERPROFILE\.ssh\hf-tracker-cam", "$env:USERPROFILE\.ssh\hf-tracker-cam.pub" "$Dest\ssh\" -Force -ErrorAction SilentlyContinue
Copy-Item "$Repo\docs\MIGRATION-PC-BRUNO.md", "$Here\setup-new-pc.ps1", "$Here\setup-new-pc.cmd" $Dest -Force -ErrorAction SilentlyContinue
"$(Get-Date -Format 's') from $env:COMPUTERNAME" | Set-Content "$Dest\LAST-MIRROR.txt" -Encoding utf8
