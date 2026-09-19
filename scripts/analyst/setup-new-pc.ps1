# setup-new-pc.ps1 - prepara um PC NOVO pra assumir os satelites do Claude (Bruno 09-18).
# Rode de dentro da pasta _handoff do Google Drive (setup-new-pc.cmd). NAO instala a task de
# autostart: isso e o ultimo passo, feito pelo Claude no PC novo DEPOIS do PC antigo ser desligado.
$ErrorActionPreference = 'Continue'
$Handoff = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base = 'C:\Claude Projects\Supplements Production Line'
$Repo = Join-Path $Base 'healthfare-tracker'
$Mem  = "$env:USERPROFILE\.claude\projects\c--Claude-Projects-Supplements-Production-Line\memory"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Step 'Programas (winget, pula o que ja existe)'
foreach ($id in 'Git.Git','OpenJS.NodeJS.LTS','Google.Chrome','Tailscale.Tailscale','Google.GoogleDrive') {
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Select-Object -Last 1
}
Step 'Claude Code (instalador nativo -> %USERPROFILE%\.local\bin\claude.exe)'
if (-not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")) {
  try { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression } catch { Write-Host "  instalador do Claude falhou: $_" -ForegroundColor Yellow }
}
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
Step 'Railway CLI'
if (-not (Get-Command railway -ErrorAction SilentlyContinue)) { npm install -g @railway/cli 2>&1 | Select-Object -Last 1 }

Step "Repositorio em $Repo (mesmo caminho do PC antigo, obrigatorio)"
New-Item -ItemType Directory -Force -Path $Base | Out-Null
if (-not (Test-Path "$Repo\.git")) { git clone https://github.com/healthfaresupplementsacc/Carolina-V3.git $Repo }
Set-Location $Repo
git checkout v3-reset 2>&1 | Select-Object -Last 1
git pull 2>&1 | Select-Object -Last 1
if (-not (Test-Path "$Repo\node_modules")) { npm install 2>&1 | Select-Object -Last 2 }

Step 'Arquivos fora do git (da pasta _handoff)'
robocopy "$Handoff\_watch" "$Repo\scripts\analyst\_watch" /E /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Directory -Force -Path $Mem, "$env:USERPROFILE\.claude", "$env:USERPROFILE\.ssh" | Out-Null
robocopy "$Handoff\claude-memory" $Mem /E /R:1 /W:1 /NFL /NDL /NJH /NJS | Out-Null
if (-not (Test-Path "$env:USERPROFILE\.claude\settings.json")) { Copy-Item "$Handoff\claude\settings.json" "$env:USERPROFILE\.claude\" -Force }
Copy-Item "$Handoff\ssh\hf-tracker-cam*" "$env:USERPROFILE\.ssh\" -Force

Step 'Conferencia'
$checks = [ordered]@{
  'node 24'            = ((node -v 2>$null) -like 'v24*')
  'claude.exe nativo'  = (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")
  'railway cli'        = [bool](Get-Command railway -ErrorAction SilentlyContinue)
  'repo clonado'       = (Test-Path "$Repo\src\v3\process-registry.js")
  '_watch/tokens.json' = (Test-Path "$Repo\scripts\analyst\_watch\tokens.json")
  '_watch/tasks.json'  = (Test-Path "$Repo\scripts\analyst\_watch\tasks.json")
  'memoria MEMORY.md'  = (Test-Path "$Mem\MEMORY.md")
  'chave ssh'          = (Test-Path "$env:USERPROFILE\.ssh\hf-tracker-cam")
  'tailscale'          = (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')
  'G: montado'         = (Test-Path 'G:\My Drive\Clinic')
}
foreach ($c in $checks.GetEnumerator()) {
  if ($c.Value) { Write-Host ("  OK     {0}" -f $c.Key) -ForegroundColor Green } else { Write-Host ("  FALTA  {0}" -f $c.Key) -ForegroundColor Red }
}

Step 'Agora, na mao'
Write-Host '  1. railway login       (conta healthfaresupplements@gmail.com)'
Write-Host '  2. tailscale: entrar na mesma conta; Google Drive: entrar e esperar o G:'
Write-Host '  3. Desligar a task "HealthFare Claude Autostart" no PC ANTIGO antes de seguir'
Write-Host "  4. cd `"$Repo`"  ->  claude  ->  colar o prompt de docs\MIGRATION-PC-BRUNO.md"
