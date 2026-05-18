# 07 — Auto-check de atividade pendente (BUG L-13 focal)

## 7.1 O cron está rodando?
**EVIDENCIADO** (railway logs, serviço ProductionLineService):
```
[ActivityCheck] asked about 2 stale activit(y/ies)
[ActivityCheck] asked about 1 stale activit(y/ies)
[ActivityCheck] asked about 1 stale activit(y/ies)
[ActivityCheck] asked about 3 stale activit(y/ies)
```
→ O cron horário `checkActivityFreshness` (commit cc93b03b, `scheduler.js` cron `0 * * * *`) **está executando e detectando** atividades paradas.

Critério (de `src/workflow/activity-freshness.js`, rodada anterior): phase/ad-hoc `status='open'`, `started_at < NOW()-1h`, e último `oal` do operador responsável `NULL` ou `> 1h`. Pergunta postada no **canal admin** (`postToChannel(managerChannelId,...)`) — admin não é silenciado (`client.js isAdminChannel`). Estado em `app_state.activity_freshness_pending`.

## 7.2 Então por que o caso "Bruno indo almoçar 14:24, nunca voltou" não foi perguntado direito?
Causa raiz combinada (**EVIDENCIADO** salvo onde marcado):
1. **L-08:** "Bruno - Indo almocar agora" (conta `U0AU8N8FA00`) → `resolveOperator` "Bruno" + conta não em `BRUNO_ALLOWED_ACCOUNTS` → `brunoBlocked` → `type:'ignore'` (parser/index.js:435,593). **Não criou pause do Bruno** (pauses de hoje: Simone/Ana/Vitor, nenhuma do Bruno — `_raw/pauses_today.json`). Como não há atividade aberta nem break do "Bruno" no oal, **o auto-check não tem o que vincular ao Bruno**.
2. A pergunta da break-time-reply ("hmm Bruno, não registrou… manda as horas") **foi gerada** (silent_log id 55, 14:24 ET) mas é mensagem **no canal de produção** → `silent_text=TRUE` → suprimida. Bruno nunca viu.
3. O auto-check até "asked about N stale" — mas as stale que ele achou são as **phases fantasma/abertas** (ex.: Linha de Produção sem dono, Revisão Plant), não o almoço do Bruno (que nem virou registro). As perguntas vão pro admin chat (não ingerido em `messages`, não rastreável aqui) e/ou as do canal pro silent_log.
4. **Filtro horário comercial:** não confirmei o filtro exato do activity-freshness sem reler o arquivo → **ACHISMO** se há janela que descartaria ~15:24.

## 7.3 Conclusão L-13
O cron **funciona**. O furo é **upstream**: o evento "Bruno saiu" nunca virou dado (L-08 bloqueia Bruno), então não há "atividade pendente do Bruno" pra perguntar. E o que o auto-check pergunta no canal de produção morre no silent_log. **Não é bug do auto-check — é o L-08 + silent_text se somando.** Decisão Bruno: cadastrar Bruno (Sarmento) com user-id real resolve a raiz.
