# Decisão FASE 0 — slack_user_id do Bruno Camp PENDENTE

Status: **PENDENTE** (resolver na Fase 1). `operators` id=333 fica com
`slack_user_id = NULL` temporariamente.

## Por que não foi possível descobrir agora (EVIDENCIADO)

1. **Admin chat não é persistido.** `SELECT DISTINCT user_id FROM messages
   WHERE channel_id='C0B36DR5MP1' AND user_id <> 'U0B3EQLPEPL'` → **0 linhas**.
   O sistema só ingere/grava o canal de produção (`C09UNBXFRKK`). O
   método "Bruno Camp = quem mais posta no admin chat" é inviável: não
   há nenhuma mensagem do admin chat no banco.
2. **Bot Slack não resolve DMs privados.** `auth.test` OK (bot =
   `healthfare_tracker` / `U0B3EQLPEPL`), mas `conversations.info` /
   `conversations.members` nos `D...` fornecidos falha — são DMs
   privados entre o Bruno e cada pessoa; o bot não é membro, logo não
   consegue ler nem resolver o user-id.
3. Não há mensagem identificável do Bruno Camp no canal de produção
   pra cruzar via `raw_json` (ele é dono, não opera a linha).

**Não foi inventado nenhum user-id.** Gravar um id chutado
reintroduziria o bug L-08 (atribuição ao operador errado). id=333
permanece `slack_user_id=NULL` — seguro: Bruno Camp é owner, fica
fora do board e não recebe atividade.

## Como resolve na Fase 1

Quando a **ingestão do admin chat (C0B36DR5MP1)** for adicionada
(Fase 1), as mensagens do Bruno Camp passarão a existir em `messages`
com o `user_id` real. Aí:
- `user_id` mais frequente no admin chat (excluindo o bot
  `U0B3EQLPEPL`) = Bruno Camp (dono, posta mais).
- Atualizar `operators` id=333 `slack_user_id` com auditoria
  `operator.update_slack_user_id` `source='fase1_admin_chat_ingest'`.

Alternativa imediata (se necessário antes da Fase 1): um permalink de
qualquer mensagem do Bruno Camp → extrair o `ts` → cruzar com
`messages.raw_json` (se for do canal de produção) ou `users.info` se o
bot tiver o user-id por outra via.

## Escopo
- Não muda parser/dispatcher/silent_text.
- id=333 inalterado nesta rodada (continua NULL, owner, active).
