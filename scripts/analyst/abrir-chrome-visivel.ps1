# Abre o Chrome da Carolyn NA SESSAO DO BRUNO (janela visivel) pra ele logar.
# Uso: clicar com o botao direito > "Executar com o PowerShell" (ou rodar elevado).
# Mata o Chrome invisivel (S4U) e sobe um novo aqui, onde da pra ver e clicar.
$ErrorActionPreference = 'Continue'
$perfil = "$env:LOCALAPPDATA\hf-carolina-chrome"

Write-Host "1) derrubando o Chrome invisivel..."
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { [string]$_.CommandLine -match 'hf-carolina-chrome' -or -not $_.CommandLine } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 5
Remove-Item "$perfil\lockfile" -Force -ErrorAction SilentlyContinue

Write-Host "2) abrindo o Chrome VISIVEL no mesmo perfil..."
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" }
Start-Process $chrome -ArgumentList `
  '--remote-debugging-port=9222', `
  "--user-data-dir=`"$perfil`"", `
  '--no-first-run', '--no-default-browser-check', `
  'https://usgsteamworkspace.slack.com/'

Start-Sleep -Seconds 15
try {
  $v = (Invoke-RestMethod http://localhost:9222/json/version -TimeoutSec 6).Browser
  Write-Host ("   OK, Chrome no ar: " + $v)
} catch { Write-Host "   (subindo...)" }

Write-Host ""
Write-Host "AGORA: na janela que abriu, clique em Google e escolha carolprographics@gmail.com"
Write-Host "Depois volte no Claude e diga 'loguei'."
