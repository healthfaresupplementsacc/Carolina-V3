# 05 — Modelos duplicados (sem reconciliação)

## 5.1/5.2 Pares que cobrem o mesmo conceito

### a) `tasks` (legacy) vs `phase_instances`+`ad_hoc_task_instances` (ISA-88)
- Hoje: `tasks`=8, `phase_instances`=20, `ad_hoc`=1.
- Leituras (grep): `getOperatorStats` (`routes/api.js`) lê **tasks**; `getCompletedToday`/board ISA-88 lê **phase_instances**; App Home (`slack/home.js`) lê **ISA-88**; `dm-handler.getProductionContext` lê **tasks** (legacy). → **Carolina e dashboard veem modelos diferentes**.
- Divergência concreta hoje: Bruno Plant 0134 → `tasks` 487(Bruno)+488(Vitor) **vs** phases 533/534/544/545. Ana Rutin → task 489 **vs** phases 546+538. **Mesma intenção, 2–4 rows, operador inconsistente.**

### b) `pauses` (legacy) vs `oal activity_type='break'` (ISA-88)
- Hoje: `pauses`=5; `oal break`=1 (oal 93, Ana, dur 0, pause_id 68).
- `pauses` tem o trilho real (63 Simone, 66/68 Ana, 69/71 Vitor); `oal break` quase vazio. Dashboard "Breaks de hoje" lê um; `get_state`/`get_breaks_today` da Carolina lê `oal`. **Divergem**: a maioria dos breaks está só em `pauses`, invisível pra Carolina.

### c) `supplements` vs `supplement_catalog`
- `supplements`=13, `supplement_catalog`=1. Dois cadastros de suplemento; código lê ora um ora outro (documentado no handoff anterior). `detect.js` consultava `supplement_catalog.admin_approved` (coluna criada na emergência). **Sem fonte única.**

### d) workflow_templates→phase_templates→workflow_instances→phase_instances (ISA-88) vs estrutura legacy (`tasks.task_type`)
- ISA-88 modela workflow/fase ricamente; legacy só `task_type` (`producao/revisao/limpeza/outro`). O dispatcher tenta mapear `task_type`→fase (dispatcher.js TASK_TYPE_TO_PHASE) — origem do default phantom "Linha de Produção".
- Divergência hoje: phase 546 (Rutin) ligada a `wf_id=22` — um workflow_instance **antigo** (não criado hoje), enquanto a task 489 (Rutin) é nova. ISA-88 reaproveitou wf velho; legacy criou novo. **EVIDENCIADO** (`phase_joined_today` id546 wf_id 22).

### e) `production_counts` vs `phase_instances.final_bottle_count`/bottles
- Hoje `production_counts`=0; bottles ficam em `phase_instances`/`tasks`. Contagem de garrafas tem 2+ destinos; board legacy soma `production_counts` (zero hoje) → bottles do dia não refletem ISA-88.

## 5.3 Por que não conversam (causa estrutural)
- O ISA-88 foi sobreposto ao legacy sem matar o legacy. O poller dispara **os dois** (`taskEngine` + `dispatcher`) por mensagem → escrita dupla por design.
- Resolução de operador difere entre parser (user-id fixo + prefixo) e admin-tools (`resolveOperator` por nome/alias) → mesmo nome, ids diferentes.
- Fechamento de fase: dispatcher fecha "última aberta que casa template"; legacy fecha por `slack_end_ts`; App Home fecha por id. → fechamentos cruzados (ex.: "F: LIMPEZA" fechou o Rutin — doc 03).
- Não há **chave de idempotência por mensagem** (`slack_ts`) compartilhada entre os 4 escritores → edição/reprocesso multiplica rows.

**Resumo:** não é "dessincronizado às vezes" — é **sem reconciliação por construção**. Cada fonte é a verdade pra si.
