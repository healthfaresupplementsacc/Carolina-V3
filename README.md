# HealthFare Production / Carolina V3

Rastreador de produção de suplementos (Fort Lauderdale, FL). Mede o que
cada pessoa da fábrica realmente faz — pra trocar chute por dados.

## Arquitetura (jun/2026)

```
OPERADORES                          ADMINS (Bruno/Thassio/Henrique)
   │                                     │
   ├─ /op (Operator Page, PIN)           ├─ /admin (painel: operadores+inbox+📊analytics+📋auditoria)
   │    botões touch → writes DIRETOS    ├─ /dashboard-v4 (timeline/metas)
   │    em v3.events (SEM LLM, $0)       ├─ #admin-orin (@Carolina comandos)
   │                                     └─ /api/v3/architect/* (read-only,
   └─ Slack #orders-and-inventory             token — pro architect/claude.ai)
        │ (input ALTERNATIVO)
        ▼
   Observer worker (tick 5s) ── LLM: Gemini 2.5 Flash (free, $0)
        │                          └─ fallback automático: Anthropic Sonnet
        │  dead-letter: 3 falhas → fora da fila + aviso admin
        ▼
   Postgres schema v3  ◄── dedupe-watcher (60s): Slack ↔ página
        │                   match → superseded_by; órfão → Carolina
        ▼                   pergunta no #admin-orin (✅/❌/📝)
   Dashboard V4 / snapshot / audit_log
```

- **Stack:** Node 20 + Express + Postgres (Railway). Zero build de front
  (páginas estáticas vanilla). Tests: jest (~2000, behavioral).
- **Custo LLM:** ~$0/mês (Gemini free tier; era ~$102/mês no Sonnet).
- **Identidade:** operadores por PIN (scrypt); admin por ADMIN_PASSWORD;
  APIs por tokens (env). Tudo auditado em `v3.audit_log`.

## Docs
- [docs/HEALTHFARE_HANDOFF_V3.md](docs/HEALTHFARE_HANDOFF_V3.md) — handoff completo (+adendos)
- [docs/OPERATOR_PAGE.md](docs/OPERATOR_PAGE.md) · [docs/OPERATOR_CARD.html](docs/OPERATOR_CARD.html) — manual do operador
- [docs/ADMIN_QUICK_REFERENCE.md](docs/ADMIN_QUICK_REFERENCE.md) · [docs/ADMIN_NOTIFICATIONS.md](docs/ADMIN_NOTIFICATIONS.md) — admin
- [INTEGRATION_PLAN.md](INTEGRATION_PLAN.md) — histórico de blocos + TODOs

## Operação
```bash
npm test                                   # suite completa
railway up --service ProductionLineService --ci   # deploy
railway run --service ProductionLineService node scripts/v3-apply-migration-0XX.js
```
Migrations: `src/v3/schema/migrations/*.sql` (UP+DOWN) + script idempotente.
Env vars principais: `DATABASE_URL, SLACK_BOT_TOKEN, GEMINI_API_KEY,
ANTHROPIC_API_KEY, LLM_PROVIDER, ARCHITECT_API_TOKEN, OPERATOR_PAGE_TOKEN,
ADMIN_PASSWORD, WORKER_DEDUPE_ENABLED, V2_DISABLED=1`.

## Watchdog da Carolina no Slack

O watchdog inicia no logon pela tarefa `HealthFare Claude Autostart` e mantém o
Chrome da Carolina, o listener Slack e o agendador ativos. Quando a sessão do
Slack expira, ele usa o workspace `usgsteamworkspace`, escolhe login com Google
e reutiliza a sessão Google; se o Google pedir senha, lê a credencial local.
O launcher abre somente a página atual do Slack; não restaura sessões antigas de
abas, pois telas de login acumuladas podem deixar a automação sem resposta.

As credenciais ficam somente em `scripts/analyst/_watch/slack-creds.json`, que
é ignorado pelo Git. Nunca coloque e-mail, senha, tokens ou cookies neste README
nem em arquivos versionados. Para checar a sessão sem abrir o fluxo de login:

```bash
node scripts/analyst/slack-autologin.js --check
```
