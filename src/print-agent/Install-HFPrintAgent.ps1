# =============================================================================
#  Install-HFPrintAgent.ps1 — instala o HF-PrintAgent no PC .246   (S15.52)
#
#  Rodar como ADMIN, na pasta que contém:
#    HF-PrintAgent.ps1
#    print-agent.config.json        (feito a partir do .example; TEM o token)
#    SumatraPDF.exe                 (portable, 64-bit; este instalador NÃO baixa
#                                    nada da internet de propósito — baixar
#                                    binário em produção é vetor de suprimento.
#                                    Pegar em https://www.sumatrapdfreader.org,
#                                    versão portable, e colocar do lado.)
#
#  O QUE FAZ:
#    1. Copia tudo pra C:\ProgramData\HealthFare\print-agent
#    2. Registra a tarefa agendada 'HFPrintAgent' (SYSTEM):
#       - dispara no BOOT e a cada 5 minutos (rede de segurança dupla: se o
#         processo morrer, no máximo 5 min depois volta; o mutex do agente
#         garante instância única)
#       - ExecutionTimeLimit = PT0S (SEM limite). *** LIÇÃO DE 08-25: o limite
#         default de 72h do Task Scheduler MATOU o MachinePush do .28 depois de
#         3 dias rodando e ninguém percebeu por 42h. Um agente de loop infinito
#         TEM que declarar PT0S explicitamente. ***
#       - RestartOnFailure: 3 tentativas, 1 min de intervalo
#
#  Verificar depois: Get-ScheduledTask HFPrintAgent | Get-ScheduledTaskInfo
#  Log do agente:    C:\ProgramData\HealthFare\print-agent\agent.log
# =============================================================================

$ErrorActionPreference = 'Stop'

$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = 'C:\ProgramData\HealthFare\print-agent'
$TaskName = 'HFPrintAgent'

# ── Pré-checagens: instalar pela metade é pior que não instalar ──────────────
$agentSrc = Join-Path $Src 'HF-PrintAgent.ps1'
$cfgSrc = Join-Path $Src 'print-agent.config.json'
$sumatraSrc = Join-Path $Src 'SumatraPDF.exe'
if (-not (Test-Path $agentSrc)) { throw "HF-PrintAgent.ps1 não está em $Src" }
if (-not (Test-Path $cfgSrc)) { throw "print-agent.config.json não está em $Src (copie o .example e preencha url/token/printer)" }
if (-not (Test-Path $sumatraSrc)) { throw "SumatraPDF.exe não está em $Src (baixar portable e colocar do lado — este script não baixa nada)" }

# config mínimo válido?
$cfg = Get-Content -Raw $cfgSrc | ConvertFrom-Json
if (-not $cfg.url -or -not $cfg.token -or -not $cfg.printer) {
    throw 'print-agent.config.json precisa de url, token e printer preenchidos'
}
if ($cfg.token -like '*COLOQUE*' -or $cfg.token -like '*XXXX*') {
    throw 'print-agent.config.json ainda está com o token de exemplo'
}

# a impressora existe neste PC?
$pr = Get-Printer -Name $cfg.printer -ErrorAction SilentlyContinue
if (-not $pr) {
    Write-Warning "Impressora '$($cfg.printer)' não encontrada neste PC — instalando mesmo assim (confira o nome em Get-Printer)."
}

# ── 1. Copiar ────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force $agentSrc (Join-Path $Dest 'HF-PrintAgent.ps1')
Copy-Item -Force $cfgSrc (Join-Path $Dest 'print-agent.config.json')
Copy-Item -Force $sumatraSrc (Join-Path $Dest 'SumatraPDF.exe')
Write-Host "Arquivos copiados pra $Dest"

# ── 2. Tarefa agendada ───────────────────────────────────────────────────────
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dest 'HF-PrintAgent.ps1') + '"')

# Dois gatilhos: boot + repetição de 5 min o dia inteiro. A repetição tenta
# relançar mesmo que o processo tenha morrido de um jeito que o RestartOnFailure
# não pega (ex.: alguém fechou no Task Manager); o mutex do agente descarta as
# cópias extras na hora.
$trigBoot = New-ScheduledTaskTrigger -AtStartup
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # PT0S — a lição de 08-25, ver cabeçalho

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# re-registrar limpo se já existir
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarefa $TaskName antiga removida"
}
Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($trigBoot, $trigRepeat) -Settings $settings -Principal $principal `
    -Description 'HealthFare HF-PrintAgent: imprime a fila de etiquetas na Rollo (poll do tracker a cada 15s). ExecutionTimeLimit PT0S de propósito — limite de 72h matou o MachinePush em 08-25.' | Out-Null

# Cinto e suspensório: o XML gerado às vezes traduz TimeSpan.Zero errado em
# versões velhas do módulo. Confirma que ficou PT0S de verdade.
$task = Get-ScheduledTask -TaskName $TaskName
if ($task.Settings.ExecutionTimeLimit -ne 'PT0S') {
    $task.Settings.ExecutionTimeLimit = 'PT0S'
    Set-ScheduledTask -TaskName $TaskName -Settings $task.Settings | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Write-Host "Tarefa $TaskName registrada e iniciada. Log: $Dest\agent.log"
