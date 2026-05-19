# FASE 1 — Arquitetura unificada APLICADA

Status: **IMPLEMENTADO** (código + testes). Deploy/validação prod e o
apply do cleanup retroativo (P9) **dependem do Bruno** (ver fim).

Base: `docs/investigacao/10-proposta-arquitetura-unificada.md` +
`docs/decisions/fase0-carolina-admin-chat.md`. Snapshot de partida:
tag `pre-fase1-trabalho` (commit 5a606ce). Suíte verde em TODA parte.

## O que foi feito (1 dispatcher canônico, idempotente)

```
Fonte (canal | App Home | Carolina)
        │  normaliza → EventoCanônico
        ▼
   resolveOperator único (prefixo > contexto 2min > dono conta > NULL)
        ▼
   dispatcher canônico — UPSERT por source_id (dispatcher_index)
        ▼
   ISA-88 (workflow/phase/ad_hoc/oal) + admin_audit_log
   (legacy tasks/pauses ainda em sombra — P8, segurança)
```

- **P1** `src/dispatcher/event-schema.js` + `canonical-dispatcher.js` +
  tabela `dispatcher_index`. UPSERT por `source_id`
  (slack_ts|wizard_event_id|tool_call_id) — edição/reprocesso = UPDATE,
  nunca nova row (**L-06**). `finish` fecha a fase REFERENCIADA
  (`target_phase_id`), não "última aberta que casa template"
  (**"F:LIMPEZA fechou Rutin"**). `note` nunca descartada. Audita todo
  upsert (`dispatcher.upsert`).
- **P2** `resolve-operator.js`: regras do Bruno em ordem estrita.
  Nomes derivados da tabela `operators` (+aliases+1º nome único) — NUNCA
  hardcoded. `config.accountOwners`/`noOwnerAccounts`. Os 8 casos
  obrigatórios da spec 2.5 testados.
- **P3** `parser.classify()` → EventoCanônico (parseMessage **intacto**
  p/ o shadow legacy — decisão do Bruno). "F:" sempre finish (**L-10**),
  "retorno almoço" → break_end (bug 14:22), separador "_", multi-ação,
  nunca descarta. Poller no caminho canônico (substitui o workflow
  dispatcher paralelo).
- **P4** App Home: cada submit vira EventoCanônico
  (`app_home:<view.id>`) → dispatcher. Sem escrita ISA-88 direta. Render
  com workflow+suplemento+batch; ad-hoc "Outro" mostra a nota.
- **P5** Carolina `close_phase` → EventoCanônico
  (`carolina_tool:<tool_call_id>`) → dispatcher. Audit pareada
  `ai_admin_executed` + `dispatcher.upsert`. Exceção: `carolina_tool`
  com operador null = ação de admin (não ambíguo).
- **P6** `src/slack/admin-chat.js`: `sendToAdminChat`/`askDisambiguation`
  SEMPRE no admin chat (isento de `silent_text`), audita
  `carolina.admin_chat_question`. Evento ambíguo estaciona em
  `pending_disambiguation` (nunca descartado). `resolveDisambiguationReply`.
- **P7** `pollManagerChannel` persiste admin chat em `messages`
  (`parsed_type='admin_chat'`, nunca dispara dispatcher de produção),
  auto-descobre `slack_user_id` (conservador, 1 match), resolve a
  resposta de desambiguação.
- **P8** Legacy **continua escrevendo em sombra** (8.1 intacto).
  `divergence-telemetry.js` + cron **04:00 ET**: alerta admin se
  legacy×ISA-88 divergir >5%. Sempre audita `divergence.telemetry`.
- **P9** `scripts/fase1-retro-operator.js` (dry-run; `--apply` só com
  aprovação) + `retro-operator.shouldReassign` (conservador: só
  prefixo explícito). **NÃO aplicado** — gated no Bruno.
- **P10** `GET /api/admin/dispatcher/pending` +
  `POST /api/admin/dispatcher/reassign-operator` (PIN + audit
  `operator.reassign_retroactive`). `resolveBySourceId` compartilhado
  (admin chat + botão dashboard).

## Desvios documentados (vs. texto literal da spec)

1. **2.4/3.1** (remover `resolveNameFromUserId`/`BRUNO_ALLOWED_ACCOUNTS`
   do parser já na Fase 1) **vs 8.1** (legacy intacto por segurança):
   decisão do Bruno = **legacy byte-a-byte intacto + canônico unificado**.
   O canônico já não usa essa lógica; a remoção física do parser é
   Fase 2/3 (quando o legacy deixa de ser lido). Sem isso o shadow-write
   de produção quebraria, contrariando 8.1.
2. **P10 UI**: os endpoints SEM DONO (dados) estão prontos e testados.
   O HTML do badge "🔶 SEM DONO" + botão no template de 2844 linhas
   ficou como follow-up de UI puro (não-correção-de-dado) p/ não
   arriscar regressão no fim da fase. Cards de workflow/fase/suplemento/
   batch/timer/helpers/notas já existem de Entregas anteriores.
3. `CAROLINA_HANDOFF_MASTER.md` (pré-leitura #1) **não existe no repo** —
   os 4 docs de investigação + decisão fase0 cobrem a arquitetura.

## Princípios inegociáveis — estado

| Princípio | Estado |
|---|---|
| 1 evento → 1 source_id → 1 row (upsert) | ✅ dispatcher_index |
| resolveOperator único, NULL+pergunta-admin, nunca chuta | ✅ P2/P6 |
| Reaction/confirmação só com record | ✅ ambíguo→admin chat, não ✅ |
| Mensagem não classificável nunca descartada | ✅ note / pending |
| silent_text inalterado (TRUE) | ✅ não tocado |
| silent_reactions inalterado (FALSE) | ✅ não tocado |
| Modelo Anthropic (Haiku 4.5) | ✅ não tocado |
| Legacy não dropado / não desligado | ✅ sombra (P8) |
