# Deploy no Railway - Passo a Passo

## O que você precisa antes de começar

### 1. Slack Token
Você precisa de um **Slack Bot Token** para o backend poder ler e postar no canal de forma autônoma.

**Como conseguir:**
1. Acesse https://api.slack.com/apps
2. Clique em "Create New App" → "From scratch"
3. Nome: `HealthFare Tracker`, Workspace: USGS Team
4. No menu lateral, vá em **OAuth & Permissions**
5. Role até **Bot Token Scopes** e adicione:
   - `channels:history` — ler mensagens do canal
   - `chat:write` — postar mensagens
   - `chat:write.customize` — postar com nome customizado (Bryce)
   - `files:write` — subir o screenshot EOD
   - `im:write` — enviar DMs (para Bruno/Henrique)
   - `users:read` — resolver IDs de usuário
6. Clique em **Install to Workspace** → Authorize
7. Copie o **Bot User OAuth Token** (começa com `xoxb-...`)
8. **Adicione o bot ao canal:** no Slack, vá em #orders-and-inventory → Integrações → Adicionar app → HealthFare Tracker

### 2. Railway CLI
```powershell
# No PowerShell (como Administrador)
npm install -g @railway/cli
railway login
```

---

## Deploy

### Passo 1: Adicionar Postgres no Railway
1. Acesse https://railway.app/project/d6740892-c575-44aa-b0cc-f9f7a6102e59
2. Clique em **"+ New"** → **"Database"** → **"Add PostgreSQL"**
3. Aguarde o Postgres subir (fica verde em ~30s)
4. O Railway configura `DATABASE_URL` automaticamente no projeto

### Passo 2: Deploy do código
Abra o PowerShell na pasta do projeto:
```powershell
cd "C:\Users\bruno\OneDrive\Documents\Claude Projects\Supplements Production Line\healthfare-tracker"

# Login e link com o projeto
railway login
railway link d6740892-c575-44aa-b0cc-f9f7a6102e59

# Deploy
railway up
```

### Passo 3: Configurar variáveis de ambiente
Ainda no PowerShell (ou pelo dashboard do Railway → Variables):
```powershell
railway variables set SLACK_BOT_TOKEN=xoxb-SEU-TOKEN-AQUI
railway variables set NODE_ENV=production
```
O `DATABASE_URL` já é preenchido automaticamente pelo Railway.

### Passo 4: Pegar a URL pública
```powershell
railway domain
```
Copie a URL gerada (ex: `https://healthfare-tracker-production.up.railway.app`) e me passe para eu configurar o `RAILWAY_PUBLIC_DOMAIN`.

---

## Verificação
Depois do deploy, acesse:
- `https://SUA-URL/api/health` → deve retornar `{"status":"ok"}`
- `https://SUA-URL/` → dashboard principal

---

## Notas
- O backfill histórico começa automaticamente na primeira inicialização
- O polling do Slack começa imediatamente após o boot
- EOD summary: todo dia às 19:00 EDT
