# =============================================================================
#  HF-PrintAgent — agente de impressão do PC de packing (.246)   (S15.52, 09-04)
#
#  O QUE FAZ: faz poll da fila de impressão do tracker a cada 15s e imprime na
#  Rollo ("Label Printer 4x6", USB004) todo job que já vem como PDF pronto
#  (etiquetas de envio compostas pelo servidor) — ZERO cliques de gente.
#
#  MODELO PULL (regra da casa): o servidor NUNCA alcança a LAN. Este script é
#  quem liga pra fora, igual o printmon do .28. O próprio poll é o heartbeat:
#  cada request com x-print-token carimba v3.settings['print_agent_246'] no
#  servidor, e o signal-watchdog abre incidente no admin-orin se o carimbo
#  envelhecer (a lição das 42h do machine_state em 08-23).
#
#  FLUXO POR JOB:
#    1. GET  /api/v3/print-queue?status=queued           (x-print-token)
#    2. filtra kinds do config (shipping_labels|bin_labels|box_label)
#    3. GET  /:id/file  → PDF pra %TEMP%. Sem PDF (404) = job desenhado no
#       navegador (bin/box de hoje): pula e deixa pra página /print — NUNCA
#       toma um job que não consegue imprimir.
#    4. POST /:id/take  (409 = outra estação ganhou a corrida: segue em frente)
#    5. SumatraPDF.exe -print-to "<printer>" -silent <pdf>
#    6. POST /:id/done  (é o /done que carimba printed_at — imprimir é isso)
#       ou POST /:id/error com a mensagem, pro admin ver o motivo na fila.
#
#  REQUISITOS NO PC: SumatraPDF.exe (portable) na MESMA pasta deste script;
#  print-agent.config.json na mesma pasta (ver print-agent.config.example.json).
#  PowerShell 5.1 puro, sem módulos.
#
#  INSTALAÇÃO: Install-HFPrintAgent.ps1 (tarefa agendada HFPrintAgent, SYSTEM,
#  boot + repetição 5min, ExecutionTimeLimit PT0S — ver a lição 08-25 lá).
# =============================================================================

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ── Instância única: a tarefa agendada dispara no boot E a cada 5 min (pra
# reviver depois de crash); o mutex garante que só UMA cópia roda de verdade. ──
$mutex = New-Object System.Threading.Mutex($false, 'Global\HFPrintAgent')
if (-not $mutex.WaitOne(0)) { exit 0 }   # já tem um rodando: sai quieto

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir 'print-agent.config.json'
$LogPath = Join-Path $ScriptDir 'agent.log'
$LogMaxBytes = 1MB

function Write-Log([string]$msg) {
    $line = ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg)
    try {
        if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt $LogMaxBytes) {
            # rotação simples: guarda 1 geração
            Move-Item -Force $LogPath ($LogPath + '.1')
        }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch { }
    Write-Host $line
}

# ── Config ───────────────────────────────────────────────────────────────────
if (-not (Test-Path $ConfigPath)) {
    Write-Log "FATAL: config não encontrado em $ConfigPath (copie print-agent.config.example.json)"
    exit 1
}
$cfg = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$BaseUrl  = $cfg.url.TrimEnd('/')
$Token    = $cfg.token
$Printer  = $cfg.printer
$PollSec  = 15
if ($cfg.poll_sec) { $PollSec = [int]$cfg.poll_sec }
$Kinds    = @('shipping_labels', 'bin_labels', 'box_label')
if ($cfg.kinds) { $Kinds = @($cfg.kinds) }
$AgentId  = 'hf-printagent-246'
if ($cfg.agent_id) { $AgentId = $cfg.agent_id }
$ByName   = 'HF-PrintAgent .246'
if ($cfg.by) { $ByName = $cfg.by }

$Sumatra = Join-Path $ScriptDir 'SumatraPDF.exe'
if ($cfg.sumatra_path) { $Sumatra = $cfg.sumatra_path }
if (-not (Test-Path $Sumatra)) {
    Write-Log "FATAL: SumatraPDF.exe não encontrado em $Sumatra"
    exit 1
}
if (-not $BaseUrl -or -not $Token -or -not $Printer) {
    Write-Log 'FATAL: config precisa de url, token e printer'
    exit 1
}

$Headers = @{ 'x-print-token' = $Token; 'x-agent-id' = $AgentId }
$QueueBase = "$BaseUrl/api/v3/print-queue"

# Jobs SEM PDF (bin/box desenhados no navegador): lembrados aqui pra não baixar
# 404 a cada 15s. Só memória — reinício do agente re-testa, e tudo bem.
$SkipNoPdf = @{}

function Invoke-Api([string]$method, [string]$path, $body) {
    $req = @{ Method = $method; Uri = ($QueueBase + $path); Headers = $Headers; TimeoutSec = 30 }
    if ($null -ne $body) {
        $req.Body = ($body | ConvertTo-Json -Compress)
        $req.ContentType = 'application/json'
    }
    return Invoke-RestMethod @req
}

function Get-JobFile([int]$jobId, [string]$outFile) {
    # @returns 'ok' | 'no_pdf' | 'fail'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri ("$QueueBase/$jobId/file") -Headers $Headers -OutFile $outFile -TimeoutSec 60 | Out-Null
    } catch {
        $status = 0
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        if ($status -eq 404 -or $status -eq 503) { return 'no_pdf' }
        Write-Log "job ${jobId}: download falhou ($status): $($_.Exception.Message)"
        return 'fail'
    }
    # sanidade: é PDF mesmo? (as etiquetas são bytea no banco; um HTML de erro não pode ir pra impressora)
    try {
        $fs = [System.IO.File]::OpenRead($outFile)
        $buf = New-Object byte[] 4
        $null = $fs.Read($buf, 0, 4)
        $fs.Close()
        if ([System.Text.Encoding]::ASCII.GetString($buf) -ne '%PDF') { return 'no_pdf' }
    } catch { return 'fail' }
    return 'ok'
}

function Print-Pdf([string]$pdfPath) {
    # SumatraPDF portable imprime silencioso e sai. -exit-when-done é implícito
    # com -print-to; exit code 0 = mandou pro spooler.
    $p = Start-Process -FilePath $Sumatra -ArgumentList @('-print-to', ('"' + $Printer + '"'), '-silent', ('"' + $pdfPath + '"')) -PassThru -Wait -WindowStyle Hidden
    return $p.ExitCode
}

function Process-Job($job) {
    $id = [int]$job.id
    if ($SkipNoPdf.ContainsKey($id)) { return }
    $tmp = Join-Path $env:TEMP ("hf-print-{0}.pdf" -f $id)

    $got = Get-JobFile $id $tmp
    if ($got -eq 'no_pdf') {
        # sem PDF no servidor = job da página /print (desenho no navegador). Não é nosso.
        $SkipNoPdf[$id] = $true
        if ($SkipNoPdf.Count -gt 500) { $SkipNoPdf.Clear() }   # nunca crescer pra sempre
        return
    }
    if ($got -ne 'ok') { return }   # falha transitória: tenta no próximo poll

    # tomar SÓ depois de ter o PDF na mão: um take sem impressão é a fila mentindo
    try {
        $null = Invoke-Api 'POST' "/$id/take" @{ by = $ByName }
    } catch {
        # 409 = outra estação tomou; 404 = sumiu. Os dois casos: segue o baile.
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
        return
    }

    Write-Log "job ${id} ($($job.kind)): tomado, imprimindo em '$Printer'"
    $code = -1
    $printErr = $null
    try { $code = Print-Pdf $tmp } catch { $printErr = $_.Exception.Message }

    if ($code -eq 0) {
        try {
            $null = Invoke-Api 'POST' "/$id/done" @{ by = $ByName }
            Write-Log "job ${id}: done"
        } catch {
            Write-Log "job ${id}: IMPRIMIU mas o /done falhou: $($_.Exception.Message) (fica taken; retake em 10min resolve)"
        }
    } else {
        $note = "SumatraPDF exit $code"
        if ($printErr) { $note = $printErr }
        try {
            $null = Invoke-Api 'POST' "/$id/error" @{ by = $ByName; note = ('HF-PrintAgent .246: ' + $note) }
        } catch { }
        Write-Log "job ${id}: ERRO de impressão: $note"
    }
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}

# ── Loop principal. Toda exceção é engolida e logada: o agente NUNCA morre por
# um poll ruim (rede piscou, servidor reiniciando). Quem o mata, o scheduler
# revive; quem percebe a morte de verdade é o signal-watchdog do servidor. ──
Write-Log "HF-PrintAgent iniciado. url=$BaseUrl printer='$Printer' poll=${PollSec}s kinds=$($Kinds -join ',')"
while ($true) {
    try {
        $resp = Invoke-Api 'GET' '?status=queued' $null
        $jobs = @()
        if ($resp -and $resp.data -and $resp.data.jobs) { $jobs = @($resp.data.jobs) }
        foreach ($job in $jobs) {
            if ($Kinds -contains $job.kind) { Process-Job $job }
        }
    } catch {
        Write-Log "poll falhou: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $PollSec
}
