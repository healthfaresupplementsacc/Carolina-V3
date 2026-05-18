# 10 — Proposta de arquitetura unificada

> Proposta. Nenhum código escrito nesta rodada. Decisões marcadas **[DECISÃO BRUNO]**.

## 10.1 Modelo único definitivo
**Manter ISA-88, matar o legacy.** ISA-88 (`workflow_instances → phase_instances`/`ad_hoc_task_instances` + `operator_activity_log`) já modela tudo (workflow, fase, ad-hoc, cowork, break via oal). O legacy (`tasks`/`pauses`/`production_counts`, operador TEXTO) é a fonte de metade da duplicação.
- **Operador sempre por `operator_id` (FK).** Banir operador-texto.
- **Break:** só `oal activity_type='break'` (+ `pauses` vira read-only legado, depois drop).
- **Suplemento:** eleger `supplement_catalog` como único; `supplements` read-only→drop. **[DECISÃO BRUNO]** qual é o canônico.
- Migrar dados de hoje/históricos do legacy → ISA-88 por `slack_ts` (chave de idempotência) antes do drop.
- Tabelas a dropar (futuro, fase 3): `tasks`, `pauses`, `production_counts`, `supplements`, `formulation_sessions` (vira workflow "Formulação"), `orders_sessions` (vira workflow "Picking & Packing"). Manter read-only ~30 dias.

## 10.2 Pipeline único evento → persistência
Hoje há **4 escritores** (parser-legacy, parser-ISA88, App Home, Carolina) — doc 04. Proposta: **1 dispatcher canônico** que TODOS chamam.
```
Fonte (canal | App Home | Carolina) ──► normaliza p/ EventoCanônico
   { slack_ts | source_id, operator_id, type, supplement?, batch?, phase?, raw_text }
                          │
                          ▼
            dispatcher único (idempotente por source_id)
                          │  upsert (NUNCA insert cego)
                          ▼
        ISA-88 (workflow/phase/ad_hoc/oal)  + audit
```
- **Idempotência:** chave `source_id` (`slack_ts` no canal; `wizard_event_id` no App Home; `tool_call_id` na Carolina). Reprocesso/edição = **UPDATE** da row daquele `source_id`, nunca nova. Resolve L-06.
- Parser vira só **classificador** (texto → EventoCanônico); não escreve. App Home monta EventoCanônico direto. Carolina idem. Um só caminho de escrita.
- Fechamento de fase: pela **fase que o EventoCanônico referencia** (operador+tipo+supplement/batch), não "última aberta que casa template". Resolve "F: LIMPEZA fechou Rutin".

## 10.3 Resolução de operador unificada (uma função, um lugar)
`resolveOperator(evento)` no **dispatcher** (não no parser), regras do Bruno, nesta ordem:
1. **Prefixo de nome** explícito no texto ("ANA-", "bruno:") manda — inclusive sobre o dono da conta.
2. **Contexto recente:** próximas/últimas 3 msgs em ≤2 min da mesma conta herdam o operador resolvido.
3. **Dono padrão da conta** por `slack_user_id` (Simone/Vitor têm; **PC compartilhado `U0AU8N8FA00` NÃO tem dono** → nunca auto-atribui).
4. Sem nada → `operator_id = NULL` + Carolina pergunta no **admin chat** (não no canal, p/ não depender de silent_text). Nunca chutar, nunca "próximo ativo".
- **Cadastrar Bruno Sarmento** com `slack_user_id` real. **[DECISÃO BRUNO]:** confirmar o user-id do Bruno Sarmento e do Bruno Camp (hoje `D03UL80GDRB` é DM-id inválido). Remover `BRUNO_ALLOWED_ACCOUNTS` (lista quebrada) e o mapping fixo `resolveNameFromUserId` → tudo via tabela `operators.slack_user_id`.
- Onde roda: **só no dispatcher**. Parser não resolve operador (hoje resolve e erra).

## 10.4 Persistência de reaction ("no reaction without record")
- Toda confirmação visual (✅ ou texto) **vinculada a uma row criada/atualizada** (id no audit). Se o dispatcher não persistiu, **não confirma** — em vez disso pergunta.
- `silent_text` continua valendo p/ ruído, **mas pergunta de desambiguação da Carolina vai pro admin chat** (canal nunca silenciado) — assim a ambiguidade some sem violar a regra do canal. **[DECISÃO BRUNO]:** ok perguntas irem só pro admin chat? (hoje 19 perguntas/dia morrem no silent_log).

## 10.5 App Home mostra tudo
- Render usa nome real: workflow + fase + suplemento + batch; ad-hoc usa `notes`/nome escolhido, nunca só "Outro".
- Wizard mapeia escolha pro template específico (ex.: "limpeza" → template "Limpeza"), não "Outro"+nota.

## 10.6 Plano de migração em fases (estimativas grosseiras)
- **Fase 0 (1 dia):** congelar; snapshot+backup; este relatório aprovado pelo Bruno. **Rollback:** tag `pre-investigacao`.
- **Fase 1 — dispatcher único + idempotência por source_id (3–5 dias):** parser vira classificador; App Home/Carolina chamam o mesmo dispatcher; resolveOperator unificado; **sem dropar nada** (legacy ainda escrito em paralelo só p/ comparação/telemetria). Testes comportamentais. Rollback: tag `pre-fase1`.
- **Fase 2 — leituras só ISA-88 (2–3 dias):** dashboard/App Home/Carolina/`getOperatorStats`/`getProductionContext` leem só ISA-88. Legacy vira somente-escrita-sombra. Rollback: tag `pre-fase2`.
- **Fase 3 — migrar histórico + drop legacy (3–4 dias + janela):** backfill legacy→ISA-88 por `slack_ts`; parar escrita legacy; manter tabelas read-only 30d; depois drop. Rollback: backup restaurável (validar restore antes — ver doc 11).
- **Total estimado:** ~2–3 semanas de trabalho focado + janelas de validação com o time. **ACHISMO** (depende de quanto o parser/App Home precisam mudar).

## 10.7 Princípios inegociáveis do desenho novo
1. 1 evento → 1 source_id → 1 row (upsert idempotente).
2. 1 resolveOperator, no dispatcher, regras do Bruno, NULL+pergunta-admin como fallback (nunca chute).
3. Reaction/confirmação só com row gravada.
4. Sem modelo duplo: ISA-88 único.
5. Mensagem não classificável **nunca** descartada: vira nota + pergunta no admin chat.
