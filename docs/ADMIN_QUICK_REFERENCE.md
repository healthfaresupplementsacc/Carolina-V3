# Admin — Referência Rápida (HealthFare V3)

**Painel admin:** `https://productionlineservice-production.up.railway.app/admin/`
**Login:** **PIN individual** (Bruno/Thassio = owner 👑, Henrique = manager 🛡️).
Sessão dura 8h; 3 tentativas erradas = 5 min de bloqueio. PINs ficam em env var
(`ADMIN_PIN_*`). `ADMIN_PASSWORD` só funciona em emergência (antes do 1º admin).
Roles e permissões: ver [ADMIN_ROLES.md](ADMIN_ROLES.md).

## Link da página dos operadores
No topo do painel tem **👷 Página operadores ↗** (abre em nova aba) e, na aba
**Operadores**, um banner com o **link completo + botão Copiar** — pra mandar pros
operadores quando pedirem, e pra você acessar a página deles se precisar checar
alguma reclamação.

## Abas novas (bloco final)
- **📈 Métricas**: Hoje/Operador/Tasks/Targets/Tendências/Anomalias/Rankings/Insights
  (+ 💰 Finance só pra owner — salário não é salvo). Guia: [METRICS_GUIDE.md](METRICS_GUIDE.md).
- **👥 Admins** (owner): mudar PIN/role/ativar de cada admin.
- **🕐 Schedule**: no card do operador, "Editar schedule" define horário por dia da semana.
- **📋 Histórico**: agora filtra por role (manager não vê ações sensíveis); owner exporta CSV e busca nos detalhes.
- **Forgotten checkout**: quem chega de manhã confirma se colega esqueceu de sair — ver [FORGOTTEN_CHECKOUTS.md](FORGOTTEN_CHECKOUTS.md).

## Silenciar spam da Carolina no #admin-orin
Enquanto os operadores não migraram pra `/op/`, toda msg do Slack vira
notificação. Pra **manter o matching mas calar a Carolina** no Slack, setar no
Railway (Variables do ProductionLineService):
- `WORKER_DEDUPE_ENABLED=true` (religa o worker/matching)
- `WORKER_DEDUPE_NOTIFICATIONS_SILENT_MODE=true` (não posta no Slack)

As notificações continuam aparecendo na aba **🔔 Notificações** com badge **🔕 só inbox**.
Filtro "origem" separa o que foi pro Slack (📢) do que foi silenciado (🔕).
Quando todos migrarem pra página, é só setar `SILENT_MODE=false` pra Carolina voltar a avisar.

## Adicionar task em nome de um operador (check-in retroativo)
Operadores → ⚙️ Gerenciar o operador → **🕐 Adicionar task pra [Nome]**.
Escolhe tarefa, lote/nota se pedir, **data (até 7 dias atrás)** + hora de início/fim,
e uma **justificativa obrigatória** (ex.: "sistema não registrou check-in da Ana às 9:15").
Fica registrado no Histórico como `event.retroactive_create_by_admin`.

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
- **🎤 Voices**: aba dedicada — todas as gravações, **filtra por operador e data**, player inline + transcrição, **📥 baixar** e **🗑️ apagar** (soft-delete, audita). Voz também aparece como player inline no **📋 Histórico** quando a ação é sobre uma gravação.
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
