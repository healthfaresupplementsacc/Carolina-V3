# Admin — Referência Rápida (HealthFare V3)

**Painel admin:** `https://productionlineservice-production.up.railway.app/admin/`
**Senha:** env var `ADMIN_PASSWORD` no Railway (Settings → Variables do ProductionLineService).
Sessão dura 8h; 3 tentativas erradas = 5 min de bloqueio.

## Operadores (aba 👷)
| Quero… | Como |
|---|---|
| **Adicionar operador** | "➕ Adicionar Operador" → nome + PIN + auto-logoff → Criar |
| **Mudar PIN** | Gerenciar → digita 4 dígitos → "Atualizar PIN" (vale na hora; sessões abertas continuam) |
| **Ajustar auto-logoff** | Gerenciar → segundos (5–3600) ou vazio = desligado |
| **Deixar pular bottle count** | Gerenciar → toggle "count exempt" (hoje: só Bruno Sarmento) |
| **Desativar operador** | Gerenciar → "🔴 Desativar" → derruba TODAS as sessões dele e bloqueia login. Histórico fica. Reativar = mesmo botão |
| **Remover operador** | Gerenciar → "🗑️ Remover" (confirmação 2x; soft-delete, events ficam) |
| **Derrubar sessão sem desativar** | "🚪 Forçar logout agora" |
| **Ver o que fez** | "📅 Ver timeline 7 dias" (read-only) |

## Outras abas
- **📊 Analytics**: métricas (bottles/dia, horas/operador, top supplements, **min/ordem impressa**, **uso de voz**), range 7/30/90d. No fim da aba: **🎤 Notas de voz recentes** com player + transcrição.
- **📋 Histórico**: auditoria filtrável (quem mudou o quê, quando).
- **🔔 Notificações**: inbox (slack órfão, bottle count, dead-letter, ocioso, task presa, count anômalo, **ordens anômalas**, **quota de áudio**) — ✅/❌/📝 ou ações específicas (💤 force logout, ⏱️ fecha task).

## Notas de voz (🎤)
- Operadores podem gravar áudio (até 60s) — fica com transcrição.
- **Ouvir**: aba 📊 Analytics → "🎤 Notas de voz recentes" → player.
- **Storage**: áudio guardado no Postgres (bytea). Retenção sugerida **90 dias** — quando o alerta de quota (≥400MB) aparecer, apague gravações antigas (soft-delete no DB) ou aumente o plano.

## Notificações (aba 🔔) — espelho do que a Carolina posta no #admin-orin
- **🔔 Slack órfão**: alguém postou no Slack sem registrar na página → ✅ aceita o registro / ❌ apaga / 📝 edita (lote/nota).
- **📊 Bottle count**: operador saiu com "Não sei" na contagem.
- **⚠️ Dead-letter**: mensagem que falhou 3x no LLM (parou de gastar — investigar com calma).
- Resolver aqui **ou** reagindo no Slack dá no mesmo (a msg da Carolina é atualizada nos dois casos).

## Saúde do sistema (Architect API — token no Railway)
```bash
curl -H "Authorization: Bearer $ARCHITECT_API_TOKEN" https://.../api/v3/architect/health
curl -H "Authorization: Bearer $ARCHITECT_API_TOKEN" https://.../api/v3/architect/diagnostics/queue
curl -H "Authorization: Bearer $ARCHITECT_API_TOKEN" https://.../api/v3/architect/diagnostics/llm_metrics
```
`queue` mostra dead-letters e msgs em risco; `llm_metrics` mostra provider (Gemini grátis vs fallback Anthropic) e custo.

## Rotação de chaves
- **GEMINI_API_KEY**: gera nova em aistudio.google.com/apikey → Railway → Variables → substitui → redeploy automático. (⚠️ a inicial foi exposta — rotacionar!)
- **ADMIN_PASSWORD / tokens**: mesmo caminho (Variables). PINs: pela própria aba Operadores.
