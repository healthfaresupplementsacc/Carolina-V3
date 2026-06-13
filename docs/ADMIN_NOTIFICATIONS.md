# Notificações da Carolina — Manual do Admin (#admin-orin)

Desde o Deploy 3 (12/jun/2026), a Carolina cruza o que entra pelo
**Slack** com o que entra pela **Operator Page** (dedupe, cron 60s) e
avisa no **#admin-orin** quando algo precisa de decisão humana.

## Tipos de notificação

### 🔔 Registro do Slack sem correspondente na página
Alguém postou "S: ..." no canal de produção, o Observer criou o event,
e **2 minutos depois** ainda não havia registro igual na página
(mesma pessoa + mesma atividade + lote compatível). A Carolina posta:

> 🔔 **Vitor** postou no Slack:
> > S: Iniciando linha producao Glycinate 0190
> (production_line · BR-2026-0190) — sem task correspondente na página.
> ✅ Aceita (mantém o registro)   ❌ Ignora (apaga)   📝 Editar

**Reage NA MENSAGEM da Carolina:**
| Reação | Efeito |
|---|---|
| ✅ (`:white_check_mark:`/`:+1:`) | Registro do Slack vira oficial. Nada é apagado. |
| ❌ (`:x:`/`:no_entry_sign:`) | Registro do Slack é apagado (soft-delete, com audit). |
| 📝 (`:memo:`/`:pencil:`) | A Carolina te orienta a mandar o ajuste por comando. |

A própria mensagem da Carolina é **editada** com o resultado
("✅ Aceito por Bruno Camp ...") — o canal não enche de repost.

### 📝 Como editar (depois do 📝)
Manda o ajuste **mencionando a Carolina** — o que você escrever é a
entrada final (ela mostra preview e você confirma com ✅):
```
@Carolina muda o batch do ev900 pra 0181
@Carolina ajusta started_at do ev900 pra 11:15 AM
```
(É o mesmo fluxo de comando admin já existente, com confirmação.)

### 📊 Bottle count em aberto (clock-out)
Quando um operador sai marcando "🤷 Não sei" na contagem:
> 📊 Ana saiu sem contar bottles de Apple Cider 0181 (finalizada 11:30). Verifica?

Resolve direto no dashboard (ou via `@Carolina` corrigindo o count).

## Notas
- Quando o Slack e a página registram a MESMA coisa, o dedupe casa os
  dois sozinho (sem te avisar): o do Slack fica oculto
  (`superseded_by_event_id`), o da página vale. Audit em
  `v3.audit_log` (`actor_type='dedupe_worker'`).
- Pendências ficam em `v3.notifications` (status `pending`). UI de
  admin pra listar é TODO futuro.
- Só **admins** (owner/manager) podem reagir — reação de operador é ignorada.
