# REINICIA OS SATELITES DO PC DO BRUNO (09-09). Precisa rodar ELEVADO: os
# processos sobem pela Scheduled Task (S4U) e taskkill/Stop-Process sem
# elevacao da "Access is denied".
#   powershell -Verb RunAs -File restart-satellites.ps1
# O que faz: mata TODOS os wrappers (cmd.exe rodando run-*.cmd) e os node dos
# tres satelites (slack-watchdog, slack-socket-listener, scheduler) e dispara a
# task "HealthFare Claude Autostart" de novo, que sobe UM set com o codigo atual.
# NAO mexe no Chrome da Carolyn (a sessao do Slack vive la).
#   -KillChrome : mata tambem o Chrome da Carolyn (perfil hf-carolina-chrome). Use
#                 quando ele subiu em S4U (boot, sem sessao = janela INVISIVEL) e
#                 um humano precisa ver a tela (captcha do Google, 09-09).
#   -NoStart    : nao dispara a task; quem chamou sobe os processos do jeito que quer.
param([switch]$KillChrome, [switch]$NoStart)
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here '_watch\restart-satellites.log'
function L($m) { $line = "[" + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + "] " + $m; Write-Host $line; Add-Content -Path $log -Value $line }

# Sob S4U a CommandLine vem vazia: identifica pela ARVORE (cmd cujo filho e node,
# ou node cujo pai e cmd) e pelo caminho do executavel.
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('cmd.exe', 'node.exe') }
$byPid = @{}; foreach ($p in $procs) { $byPid[[int]$p.ProcessId] = $p }
$targets = New-Object System.Collections.Generic.List[int]
foreach ($p in $procs) {
  $cl = [string]$p.CommandLine
  if ($cl -match 'scripts\\analyst\\(run-|slack-watchdog|slack-socket-listener|scheduler)') { $targets.Add([int]$p.ProcessId); continue }
  if ($p.Name -eq 'cmd.exe' -and -not $cl) {
    $kids = $procs | Where-Object { $_.ParentProcessId -eq $p.ProcessId -and $_.Name -eq 'node.exe' }
    if ($kids) { $targets.Add([int]$p.ProcessId); foreach ($k in $kids) { $targets.Add([int]$k.ProcessId) } }
  }
  if ($p.Name -eq 'node.exe' -and -not $cl -and $byPid.ContainsKey([int]$p.ParentProcessId) -and $byPid[[int]$p.ParentProcessId].Name -eq 'cmd.exe') { $targets.Add([int]$p.ProcessId) }
  # netos: node filho de node (autologin --check) — morre junto
  if ($p.Name -eq 'node.exe' -and $byPid.ContainsKey([int]$p.ParentProcessId) -and $byPid[[int]$p.ParentProcessId].Name -eq 'node.exe') { $targets.Add([int]$p.ProcessId) }
}
$targets = $targets | Sort-Object -Unique
L ("matando: " + ($targets -join ','))
foreach ($t in $targets) { try { Stop-Process -Id $t -Force -ErrorAction Stop; L "  killed $t" } catch { L "  FALHOU $t : $($_.Exception.Message)" } }
Start-Sleep -Seconds 2
Remove-Item (Join-Path $here '_watch\*.pid') -Force -ErrorAction SilentlyContinue
if ($KillChrome) {
  $chromes = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and ([string]$_.CommandLine -match 'hf-carolina-chrome' -or -not $_.CommandLine) }
  # o processo-pai em S4U vem com CommandLine vazia; os filhos mostram o perfil
  $pais = @($chromes | Where-Object { [string]$_.CommandLine -match 'hf-carolina-chrome' } | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique)
  $alvos = @($chromes | Where-Object { [string]$_.CommandLine -match 'hf-carolina-chrome' -or $pais -contains $_.ProcessId } | ForEach-Object { $_.ProcessId })
  L ("matando Chrome da Carolyn: " + ($alvos -join ','))
  foreach ($t in $alvos) { try { Stop-Process -Id $t -Force -ErrorAction Stop } catch { L "  chrome $t : $($_.Exception.Message)" } }
  Start-Sleep -Seconds 2
}
if ($NoStart) { L "NoStart: nao disparo a task"; exit 0 }
L "disparando a task HealthFare Claude Autostart"
try { Start-ScheduledTask -TaskName 'HealthFare Claude Autostart' -ErrorAction Stop; L "  task disparada" } catch { L "  Start-ScheduledTask FALHOU: $($_.Exception.Message) -> subindo pelo VBS direto"; Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $here 'start-watchdog-hidden.vbs') + '"') }
Start-Sleep -Seconds 12
$after = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('cmd.exe', 'node.exe') }
L ("depois: cmd=" + (@($after | Where-Object Name -eq 'cmd.exe').Count) + " node=" + (@($after | Where-Object Name -eq 'node.exe').Count))
