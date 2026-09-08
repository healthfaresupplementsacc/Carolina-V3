# Instala o AUTOSTART dos processos do Claude no PC do Bruno (watchdog + socket
# listener + agendador) como Scheduled Task, pra que TUDO volte sozinho depois de
# reboot — sem depender de ninguem abrir sessao.
#
# POR QUE (Bruno 09-07: "make sure next time all automations start on its own after reboot"):
# antes disso o unico gatilho era um ATALHO na pasta Startup, que so dispara no
# LOGON interativo. Reboot sem alguem logar = tudo parado, calado, e o Claude
# perde as mensagens do Slack sem ninguem perceber.
#
# O QUE MUDA: a task roda no BOOT (SYSTEM nao serve aqui — o watchdog precisa do
# perfil do Chrome do usuario — entao usa a conta do Bruno com -LogonType S4U,
# que NAO exige sessao aberta) e TAMBEM no logon, com RestartCount alto.
# Os proprios .cmd ja tem auto-heal (loop + timeout), entao a task e a ultima
# camada: se o cmd inteiro morrer, o Windows sobe de novo.
#
# Rodar UMA vez, ELEVADO (S4U + AtStartup exigem admin):
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
$ErrorActionPreference = 'Stop'

$TaskName = 'HealthFare Claude Autostart'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vbs      = Join-Path $Here 'start-watchdog-hidden.vbs'

if (-not (Test-Path $Vbs)) { throw "nao achei $Vbs" }
New-Item -ItemType Directory -Force -Path (Join-Path $Here '_watch') | Out-Null

# O .vbs ja sobe os TRES (watchdog + listener + scheduler) em janela oculta.
# Reaproveitar ele mantem UMA fonte da verdade de "o que precisa subir".
$Action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ("`"$Vbs`"")

# Dois gatilhos: boot (reboot sem logon) e logon (cobre o caso de a task ter sido
# parada a mao). MultipleInstances IgnoreNew impede subir duas vezes se os dois
# gatilhos baterem junto.
$TrigBoot  = New-ScheduledTaskTrigger -AtStartup
$TrigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

# S4U = roda com a conta do Bruno SEM precisar de senha guardada e SEM sessao
# aberta. RunLevel Highest porque o boot precisa disso pra nao ficar preso.
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType S4U -RunLevel Highest

try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($TrigBoot, $TrigLogon) `
  -Settings $Settings -Principal $Principal `
  -Description 'Sobe watchdog + socket listener + agendador do Claude no boot e no logon (nao depende de sessao aberta).' | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
Write-Host ("TASK: {0}  STATE: {1}" -f $t.TaskName, $t.State)
Write-Host ("TRIGGERS: {0}" -f (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))
Write-Host ''
Write-Host 'Pra testar sem reiniciar:  Start-ScheduledTask -TaskName "HealthFare Claude Autostart"'
