# Guia de Métricas — HealthFare V3 (aba 📈 Métricas)

Fonte: `v3.events_enriched` (materialized view, refresh a cada 10min) +
`v3.task_targets`. Owner e manager veem tudo, **exceto Finance (owner only)**.

## Sub-abas
| Aba | O que mostra |
|---|---|
| 🎯 **Hoje** | logados agora (semáforo por ociosidade), bottles/ordens/horas do dia, tasks abertas há +1h. Auto-refresh. |
| 👤 **Operador** | drill-down 30d: events, horas, dias ativos, por task, **day-of-week effect**, **energy-drain** (eventos tarde/manhã), notas de voz. |
| 📋 **Tasks** | target vs tempo real médio (30d) por slug, com Δ%. |
| 📊 **Targets** | aplica novo target (min) por slug. Registrado no audit. |
| 📈 **Tendências** | horas/dia e bottles/dia (gráficos 30d). |
| 🔥 **Anomalias** | forgotten pendentes, ociosos +2h, tasks presas +3h. |
| 🏆 **Rankings** | volume, horas, "mais ajudou" (cowork). ⚠️ só admin. |
| 🤖 **Insights** | textos gerados por SQL (task mais lenta, concentração de conhecimento). Carolina **não age** — só informa. |
| 💰 **Finance** | **owner only** — ver abaixo. |

## Targets — 3 métodos (seed da análise 30d, `docs/analysis/`)
- **M1** = média dos P25 individuais (operadores com ≥3 events) — justo.
- **M2** = P25 do operador mais rápido — puxa todos pra cima (pode ficar baixo demais se alguém teve poucos events rápidos).
- **M3** = M2 × 1.15 — **default semeado**: ambicioso mas alcançável.
- fallback = P25 agregado quando ninguém tem dados suficientes.
Owner/manager sobrescreve manualmente na aba 📊 Targets.

## Métricas "exóticas"
- **Energy drain** = (eventos à tarde, ≥14h) / (eventos de manhã, <13h). <0.7 = cansa muito; ~1 = sustenta o ritmo.
- **Day-of-week effect** = minutos médios por dia da semana (qual dia rende mais).
- **Knowledge concentration** (Insights) = % do volume de um slug feito por 1 só operador; >70% = risco se ele sair.

## 💰 Finance (OWNER ONLY) — salário NUNCA é salvo
- O salário/hora é **input temporário** a cada cálculo. **Não é gravado no banco
  nem em log** (G12/G13). Saindo da tela, some.
- Calcula: horas, custo total, custo/bottle, custo/task, % tempo produtivo
  (produção/PnP) vs suporte.
- O audit registra **só o fato do acesso** (quem, qual operador, range) — sem salário.

## Cache
Matview refaz sozinha a cada 10min. Owner pode forçar em
`POST /api/adminpanel/metrics/refresh-cache`.

## Cobertura (bloco final)
9 das 12 abas conceituais entregues funcionais. **Score composto**,
**Por-Produto** e **Schedule-adherence detalhada** ficaram mais leves
(endpoint de aderência existe; UI dedicada é TODO). Ver reporte do bloco.
