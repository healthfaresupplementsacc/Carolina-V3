# Segurança — HealthFare V3

Aplicado às rotas novas (`/op`, `/admin`, `/api/v3/op`, `/api/v3/architect`,
`/api/adminpanel`). O dashboard V4 legado (`/dashboard-v4`) NÃO é tocado.

## Headers (todas as respostas das rotas novas)
- **Content-Security-Policy**: `default-src 'self'`; scripts só de `self` +
  `cdn.jsdelivr.net` (Chart.js); `frame-ancestors 'none'`.
- **X-Frame-Options: DENY** · **X-Content-Type-Options: nosniff**
- **Referrer-Policy: same-origin** · **Strict-Transport-Security** (HSTS 1 ano)
- **Permissions-Policy**: `microphone=(self)` (voice da /op), camera/geo bloqueados.

## Autenticação
| Quem | Como | Sessão |
|---|---|---|
| Operadores (/op) | PIN 4 dígitos → **scrypt** (`persons.pin_hash/salt`) | token em `operator_sessions`, idle máx 16h, auto-logoff por operador (default 30s) |
| Admin (/admin) | `ADMIN_PASSWORD` (env) → token HMAC | cookie HttpOnly 8h |
| Architect API | Bearer `ARCHITECT_API_TOKEN` (full) / `OPERATOR_PAGE_TOKEN` (escopo) | — |

Tokens/PINs/keys **só via env var no Railway** (nunca no repo; histórico
varrido). PINs e senha nunca aparecem em respostas de API.

## Rate limits (por IP, em memória)
- Login operador: 5/min · Login admin: 3/5min
- PIN change: 5/min · Notifications: 30/min · Analytics: 60/min
- Architect operator_page: 60/min · Heartbeat: pela sessão

## Brute-force
10 falhas de login do mesmo IP em 1h → **ban 24h** + Carolina alerta o
`#admin-orin` + audit `login_bruteforce_ban`. Sucesso limpa o contador.
- **Persistência** (`v3.blocked_ips`, migration 023): o ban é gravado no DB e
  re-hidratado no boot, então **sobrevive a restart/redeploy** do Railway
  (antes vivia só em memória). `block_count` conta reincidências.
- **Gate global**: IP banido recebe **403** em qualquer rota nova (`/op`,
  `/admin`, `/api/v3/op`, `/api/adminpanel`, architect) — não só no login.
  Expiração é preguiçosa + limpeza dos vencidos no boot.

## RBAC admin (Fase 1 bloco final)
- `/admin` usa **PIN individual** (scrypt) por admin + sessão no DB
  (`v3.admin_sessions`, 8h). Roles **owner** / **manager** — ver
  [ADMIN_ROLES.md](ADMIN_ROLES.md).
- `requireRole('owner')` server-side em Finance, Gerenciar Admins, export CSV
  e ações sensíveis do audit. Manager → **403** (não escala privilégio).
- Guards: não rebaixar/desativar o último owner; não mudar a própria role; não
  se autodesativar.
- PINs só em env var (`ADMIN_PIN_*`), nunca no código. `ADMIN_PASSWORD` é
  fallback de emergência só enquanto não há admin ativo.

## Finance — salário nunca persiste (G12/G13)
- Salário/hora é input temporário; **não é gravado no banco nem em log**.
- Audit registra só o fato do acesso (`finance_calculation`: quem, operador, range).

## Sessões
- Operador: cleanup automático 1×/h fecha sessões ociosas >8h
  (`logoff_reason=session_expired_cleanup`). Auto-logoff fino é client-side.
- Admin: sessão DB 8h (`admin_sessions`); logout marca `logged_out_at`.
  Fallback de emergência usa token HMAC stateless.

## Auditoria
Todo write/login/ação sensível → `v3.audit_log` (visível na aba 📋 Histórico
do /admin). `actor_type` no CHECK: admin/llm_observer/llm_assistant/system/
app_home/operator_page/admin_via_slack/dedupe_worker.

## Como reportar incidente
Avisar o Bruno no Slack. Pra rotacionar credencial comprometida: Railway →
Variables → substituir (`GEMINI_API_KEY`, `ADMIN_PASSWORD`, `ARCHITECT_API_TOKEN`,
`OPERATOR_PAGE_TOKEN`) → redeploy. PIN de operador: aba Operadores do /admin.
