# HealthFare Tracker - Deploy Script (PowerShell)
# Rode como: .\deploy.ps1 -SlackToken "xoxb-..."

param(
    [Parameter(Mandatory=$true)]
    [string]$SlackToken
)

$ProjectId = "d6740892-c575-44aa-b0cc-f9f7a6102e59"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== HealthFare Tracker Deploy ===" -ForegroundColor Cyan
Write-Host ""

# Check Railway CLI
if (-not (Get-Command railway -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando Railway CLI..." -ForegroundColor Yellow
    npm install -g @railway/cli
}

# Change to project directory
Set-Location $ScriptDir

Write-Host "Fazendo login no Railway..." -ForegroundColor Yellow
railway login

Write-Host "Linkando com o projeto..." -ForegroundColor Yellow
railway link $ProjectId

Write-Host "Configurando variaveis de ambiente..." -ForegroundColor Yellow
railway variables set SLACK_BOT_TOKEN=$SlackToken
railway variables set NODE_ENV=production
railway variables set POLL_INTERVAL_MS=90000

Write-Host "Iniciando deploy..." -ForegroundColor Yellow
railway up

Write-Host ""
Write-Host "=== Deploy concluido! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Pegando URL do servico..."
railway domain

Write-Host ""
Write-Host "Copie a URL acima e passe pro Claude para finalizar a configuracao."
