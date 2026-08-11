# CAROLINA CHROME — launcher fixo do navegador da Carolina (Bruno 07-28).
#
# Sobe UMA janela do Chrome num PERFIL DEDICADO e PERSISTENTE, com a porta de
# debug (CDP) ligada, pra EU (Claude Code) ler o Slack e responder como Carolina.
#
# LOGIN FIXO: o perfil fica em %LOCALAPPDATA%\hf-carolina-chrome. Você loga como
# Carolina UMA VEZ nesta janela; a sessão (cookies) fica salva PRA SEMPRE naquele
# perfil. Toda vez que este launcher rodar, a Carolina já vem logada — não precisa
# logar de novo. É o "login fixo que sempre sabe se logar" que o Bruno pediu.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\analyst\carolina-chrome.ps1
#   (ou o watch/monitor chama isto se a porta 9222 não estiver de pé)

$ErrorActionPreference = 'Stop'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error 'chrome.exe nao encontrado'; exit 1 }

$profile = "$env:LOCALAPPDATA\hf-carolina-chrome"   # perfil FIXO/persistente
if (-not (Test-Path $profile)) { New-Item -ItemType Directory -Path $profile -Force | Out-Null }
$port = 9222

# já está de pé? (não reabre à toa)
try {
  $v = Invoke-RestMethod -Uri "http://localhost:$port/json/version" -TimeoutSec 3
  Write-Output "JA RODANDO -> $($v.Browser)"
  exit 0
} catch { }

Start-Process $chrome -ArgumentList `
  "--remote-debugging-port=$port", `
  "--user-data-dir=`"$profile`"", `
  "--no-first-run", "--no-default-browser-check", `
  "--restore-last-session", `
  "https://app.slack.com/client"

Start-Sleep -Seconds 3
try {
  $v = Invoke-RestMethod -Uri "http://localhost:$port/json/version" -TimeoutSec 5
  Write-Output "SUBIU -> $($v.Browser) (porta $port, perfil $profile)"
} catch {
  Write-Output "chrome subindo... (porta $port)"
}
