# HF-PrintAgent (.246) — S15.52

Agente de impressão silenciosa do PC de packing (10.1.10.246). Faz poll da fila
`GET /api/v3/print-queue?status=queued` a cada 15s com `x-print-token`
(= `PRINT_EVENT_TOKEN`, o mesmo segredo do `/api/print-event` — nenhuma
credencial nova), baixa o PDF de `GET /:id/file` e imprime na Rollo
("Label Printer 4x6", USB004) via SumatraPDF portable. Zero cliques.

Job sem PDF guardado (etiqueta bin/box desenhada no navegador) é PULADO e fica
pra página `/print` — o agente nunca toma o que não consegue imprimir.

## Instalar no .246 (via SSH ou na mão)

1. Copiar esta pasta pra qualquer lugar do PC (ex.: `C:\temp\print-agent\`).
2. Baixar o **SumatraPDF portable 64-bit** (https://www.sumatrapdfreader.org)
   e colocar `SumatraPDF.exe` na MESMA pasta. O instalador NÃO baixa nada de
   propósito (binário baixado em produção é vetor de ataque de suprimento).
3. `copy print-agent.config.example.json print-agent.config.json` e preencher:
   - `url`: a URL do tracker no Railway
   - `token`: o valor de `PRINT_EVENT_TOKEN` (Railway → Variables)
   - `printer`: o nome EXATO em `Get-Printer` (hoje: `Label Printer 4x6`)
4. Em PowerShell **como admin**: `.\Install-HFPrintAgent.ps1`

O instalador copia tudo pra `C:\ProgramData\HealthFare\print-agent` e registra
a tarefa agendada `HFPrintAgent` (SYSTEM, boot + repetição 5min,
`ExecutionTimeLimit PT0S` — o limite default de 72h matou o MachinePush em
08-25; está codificado no instalador pra nunca mais).

## Conferir que está vivo

- No PC: `Get-Content C:\ProgramData\HealthFare\print-agent\agent.log -Tail 20`
- No servidor: o poll do agente carimba `v3.settings['print_agent_246']`;
  o sinal `print_agent_246` aparece na página Sistema (`/api/v3/health/signals`)
  e o signal-watchdog abre incidente no admin-orin se ficar >10min sem carimbo
  dentro do expediente (dias úteis 10h–18h NY).

## Teste manual (roteiro pro deploy)

1. `powershell -NoProfile -ExecutionPolicy Bypass -File .\HF-PrintAgent.ps1`
   direto no console: deve logar `HF-PrintAgent iniciado...` e um poll por 15s.
2. Compor etiquetas de envio pela Central (ou `POST /shipping-labels` sem
   `take`): em até 15s o log mostra `tomado, imprimindo` e o papel sai na Rollo.
3. Conferir no dashboard que o job foi pra `done` e o `printed_at` carimbou.
4. Desligar a tarefa (`Stop-ScheduledTask HFPrintAgent` + matar o processo) em
   horário de expediente: em ~10min o admin-orin recebe o incidente do sinal.
