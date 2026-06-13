# Admin Roles (RBAC) — HealthFare V3

O painel `/admin/` usa **PIN individual por admin** (scrypt) + sessão no DB
(`v3.admin_sessions`, 8h). Dois tiers de permissão.

## Quem é quem
| Admin | Role | Observação |
|---|---|---|
| Bruno Camp | **owner** | acesso total |
| Thassio | **owner** | acesso total |
| Henrique Monteiro | **manager** | operacional |

PINs ficam **só em env var** no Railway (`ADMIN_PIN_BRUNO`, `ADMIN_PIN_THASSIO`,
`ADMIN_PIN_HENRIQUE`) — nunca no código. Trocar PIN: pela aba "👥 Admins" (owner)
ou rodando o seed de novo com a env atualizada.

## Matriz de permissões
| Recurso | Owner 👑 | Manager 🛡️ |
|---|---|---|
| Operadores (CRUD, PIN, logoff, schedule) | ✅ | ✅ |
| Notificações (inbox) | ✅ | ✅ |
| Analytics / Métricas (Hoje, Tasks, Targets, Tendências, Anomalias, Rankings, Insights) | ✅ | ✅ |
| **Finance** (custo/hora, ROI) | ✅ | ❌ 403 |
| **Gerenciar Admins** (criar/PIN/role/ativar) | ✅ | ❌ 403 |
| Histórico — ações operacionais | ✅ | ✅ |
| Histórico — ações **sensíveis** (login admin, finance, role/pin change, brute-force) | ✅ | ❌ ocultas |
| Export CSV do histórico | ✅ | ❌ 403 |
| Aplicar target de task | ✅ | ✅ |

## Regras de segurança (server-side, não só UI — G14)
- Manager **não escala privilégio**: qualquer rota owner-only responde **403**.
- Owner **não muda a própria role** nem **se desativa**.
- **Não dá pra remover/rebaixar o último owner ativo** (400 `last_owner`).
- PIN não pode colidir com o de outro admin ativo.

## Fallback de emergência
`ADMIN_PASSWORD` (env) só loga **enquanto não existe nenhum admin ativo**
(antes do seed). Depois do seed → `password_disabled`, só PIN. Serve pra não
travar o primeiro acesso / recuperação.

## Como adicionar/gerenciar
Aba **👥 Admins** (owner): mudar PIN, alternar role owner↔manager, ativar/desativar.
Criar um admin novo do zero: adicionar ao `scripts/v3-seed-admin-users.js` + env
var do PIN, rodar `railway run node scripts/v3-seed-admin-users.js` (idempotente).

## Política de PIN
4 a 8 dígitos numéricos. Recomendado 6. Hash scrypt (igual operadores). Sessão 8h.
