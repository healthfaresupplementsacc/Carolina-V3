# Instala o Slack Watchdog 24/7 como Scheduled Task (roda no logon do Bruno,
# reinicia sozinho se cair, mantem o Chrome do Claude vivo + captura msgs do Slack).
# Rodar UMA vez (elevado nao e necessario; usa a conta do usuario atual).
$ErrorActionPreference = 'Stop'
$TaskName = 'HealthFare Slack Watchdog'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Here 'slack-watchdog.js'
$LogDir = Join-Path $Here '_watch'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'watchdog.log'

# node.exe resolvido do PATH do usuario
$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'node.exe' }

# Comando: roda o watchdog e joga stdout/stderr no log (append). cmd /c pra ter redirecionamento.
$Inner = "`"$Node`" `"$Script`" >> `"$Log`" 2>&1"
$Action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $Inner"

# Gatilhos: no logon do usuario + no boot (caso rode como servico depois). Um basta.
$TrigLogon = New-ScheduledTaskTrigger -AtLogOn

# Settings: reinicia se falhar, roda mesmo em bateria, sem timeout, 1 instancia.
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Remove versao antiga se existir
try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $TrigLogon `
  -Settings $Settings -Principal $Principal -Description 'Mantem o Chrome do Claude vivo e captura mensagens do Slack (supplements-dashboard) 24/7.' | Out-Null

# Sobe agora
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$t = Get-ScheduledTask -TaskName $TaskName
$i = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("TASK: {0}  STATE: {1}  LASTRESULT: {2}" -f $t.TaskName, $t.State, $i.LastTaskResult)
Write-Host ("LOG:  {0}" -f $Log)
