# 11 — Pendências e limites da investigação

## 11.1 O que NÃO consegui investigar (e por quê)
- **Admin chat (C0B36DR5MP1):** não é gravado em `messages` (0 linhas). Tool-calls/tool-results da Carolina **não são persistidos** como mensagens; só efeitos em `admin_audit_log`/`silent_log`. Não dá pra reconstruir o diálogo admin do dia só pelo banco. (PARTE 1.3 / 3.3 parcial.)
- **`urgency_notifications`:** tabela **sem coluna `created_at`** → não filtrável por dia; não coletada. (counts: ERRO.)
- **App Home — eventos de botão/wizard:** sem tabela de auditoria de clique; só dá pra inferir pelo dado final (`operator_notes.source='app_home'`, `ad_hoc_task_instances`). Quem clicou cada botão e quando: **não rastreável**.
- **`app_state`** (estado da Carolina: `activity_freshness_pending`, `retro_break_admin`, `manager_chat_history`, toggles `silent_*`): não dumpei nesta rodada → estado exato do auto-check pendente e valor de `silent_reactions` não confirmados.
- **Logs:** `railway logs` mostra janela recente; não tenho o log completo do dia inteiro com timestamps por execução de cron.

## 11.2 Suposições (ACHISMO) marcadas
- `U0B3EQLPEPL` (quem reagiu ✅ 1×) = humano/manager, não Carolina — inferido por não bater com `bryceUserId`. Não confirmado quem é.
- Destino exato das notes do parser (`N: ...` da Ana): `operator_notes` tem só 1 linha (App Home), então as notes do parser vão pro caminho legacy/silenciado — **não reli `tasks.js` a fundo** p/ confirmar a tabela.
- Wizard do App Home cataloga "Outro"+nota em vez do template "Limpeza" — inferido do dado (`ad_hoc 42 task_name='Outro' notes='limpeza'`); não reinstrumentei a UI.
- Filtro de "horário comercial" do activity-freshness: não reli o arquivo nesta rodada.
- Estimativas de tempo do plano (doc 10.6): grosseiras.

## 11.3 Riscos de QUALQUER fix futuro (o que pode quebrar)
- **Parser:** mexer em classificação (separador `_`, "retorno almoco", "F:" invertido, multi-ação) pode regredir casos hoje corretos. Constraint do Bruno: entender antes, testes comportamentais. O parser tem `freetext`/heurísticas frágeis.
- **Idempotência por `slack_ts`:** se introduzida errada, pode **deixar de registrar** reprocessos legítimos (ex.: start e finish na mesma thread) — precisa de chave por (slack_ts + tipo).
- **Matar legacy:** `getOperatorStats`, `dm-handler.getProductionContext`, dashboards e App Home leem legacy hoje; trocar leituras sem migrar dados zera relatórios históricos.
- **resolveOperator unificado:** mudar a precedência pode reatribuir trabalho retroativamente em telas que recomputam.
- **Carolina no admin chat p/ desambiguar:** se o admin chat não é monitorado pelo time, perguntas continuam sem resposta (só muda o cemitério).
- **Dado de hoje já corrompido:** qualquer agregação histórica (board, EOD) sobre 18/05 está suja (phantoms, dups, operador trocado) — corrigir o código não conserta o passado sem um cleanup/migração à parte.
- **`safeDispatch` engole erros:** enquanto existir, falhas de persistência continuam invisíveis.

## 11.4 Recomendação de sequência segura (sem código aqui)
1. Bruno decide: canônico de suplemento; user-ids reais (Bruno Sarmento/Bruno Camp); perguntas da Carolina podem ir só pro admin chat?
2. Fase 1 (dispatcher único + idempotência + resolveOperator) **sem dropar legacy** — telemetria comparando os dois modelos por ~1 semana.
3. Só então Fase 2/3.
4. Cleanup do dado de 18/05 só **depois** do dispatcher único no ar (senão regenera), com backup verificado.
