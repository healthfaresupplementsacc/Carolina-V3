# 04 — As 3 fontes de evento e seus pipelines

## 4.1 Parser do canal (`src/parser/index.js` + `src/slack/poller.js`)

Tipos que `parseMessage` produz (EVIDENCIADO, parser/index.js:511–703):
`production_summary, orders_start, orders_finish, formulation_start, formulation_finish, pause_end, pause_start, join_producao, count, start, finish, ignore, unknown`.

Pipeline por mensagem (poller.js — **dois caminhos rodam em paralelo p/ a MESMA mensagem**):
1. **Legacy** (poller.js:11-12 `taskEngine`, `ordersEngine`; `src/tasks.js`, `src/orders.js`, `src/formulation.js`): grava em `tasks`, `orders_sessions`, `formulation_sessions`, `pauses`, `production_counts`. operador = TEXTO.
2. **ISA-88** (poller chama `workflow/dispatcher.safeDispatch`): grava em `workflow_instances`+`phase_instances`+`ad_hoc_task_instances`+`operator_activity_log`. operador = `operator_id`.
- `note`: persiste via `engine.addNote` → `operator_notes` (engine.js:705,729) **OU** via taskEngine (legacy). **EVIDENCIADO:** hoje `operator_notes` tem só 1 linha (do App Home); as ~8 notes da Ana via parser **não estão em `operator_notes`** → vão pro caminho legacy/silenciadas. **ACHISMO:** destino exato da note do parser (não reli tasks.js a fundo).
- Reaction (✅): emitida por `slack/client.addReaction`, **gated por `isSilent('reactions')`** (client.js:223). Decisão "reage" é separada de "persiste"; **não há vínculo garantido reaction↔row** (doc 06).
- `brunoBlocked` → `type:'ignore'` (parser/index.js:593) → **descartado**.
- `unknown`/`ignore` → poller não dispatcha → **sem persistência, sem nota**.

## 4.2 App Home (`src/slack/home.js` + handlers de interação)

Botões/wizards (App Home Slack) escrevem **direto no modelo ISA-88** (phase/ad_hoc instances) e podem criar `operator_notes` com `source='app_home'` (EVIDENCIADO: operator_notes id2, ad_hoc_task_instances id42). **Não passa pelo parser nem pelo dispatcher do canal** → é um 3º caminho de escrita. Não há tabela de auditoria de "quem clicou qual botão"; `ad_hoc_task_instances` nem tem coluna `source`.

## 4.3 Carolina admin chat (`src/ai/admin-tools.js`)

Tools que **mutam dados** (admin-tools.js, rodadas anteriores): `close_phase, approve_adhoc, approve_supplement, rename, merge_tasks, move_operator, create_workflow, post_to_production_channel, close_active_break, close_all_active_breaks, create_operator/deactivate/reactivate/promote_helper, resolve_activity_check, update_break_retroactive, dismiss_pending_question`.
- Persistem via `engine.*` (ISA-88) e/ou SQL direto; auditam em `admin_audit_log`.
- 4º caminho de escrita, com regras próprias de resolução de operador (`resolveOperator`/`resolveOperatorId` em admin-tools, diferente do parser).

## 4.4 Tabela comparativa (mesmo evento, 4 fontes)

| Evento real | Parser (canal) | App Home | Carolina admin | Legacy (paralelo ao parser) |
|---|---|---|---|---|
| Iniciar fase | `phase_instances`+`oal` via dispatcher | `phase_instances` direto | `engine.startPhase` | `tasks` |
| Fechar fase | `engine.closePhase` (acha "última aberta") | botão fecha phase | `close_phase(id)` | `tasks.ended_at` |
| Break | `pauses` (legacy) **e** `oal break` | botão pausa | `close_active_break` | `pauses` |
| Voltei | `engine.endBreak` | botão | `update_break_retroactive` | fecha `pauses` |
| Note | `operator_notes` (engine) ou legacy | `operator_notes` source=app_home | — | — |
| Cowork | `join_producao` (só Linha Produção) | — | `move_operator` | `tasks.helpers` |
| Ordens P&P | `orders_sessions` + phase Imprimir | — | — | `orders_sessions` |

**Conclusão:** existem **4 escritores** (parser-legacy, parser-ISA88, App Home, Carolina) gravando o mesmo conceito em **tabelas diferentes**, com **3 lógicas distintas de resolução de operador** e **2 lógicas de fechamento de fase**. Nenhum reconcilia o outro. Daí cards duplicados, operador trocado, e "concluído" que não bate.
