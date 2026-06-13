# Forgotten Checkouts (cascade) — HealthFare V3

Resolve o problema de operador que **esquece de fazer logout** no fim do dia —
o que inflava a duração das tasks e atrapalhava as métricas.

## Como funciona
1. Quando alguém **faz login** em `/op/`, o sistema procura colegas que:
   - estão logados (sessão aberta),
   - têm schedule definido pro dia (`v3.operator_schedules`) com `is_workday=true`,
   - já passaram do `expected_end_time`,
   - estão ociosos há **>15min**.
2. Pra cada suspeito, a página mostra um card:
   *"Fulano ainda está trabalhando em [task]?"* com dois botões.
3. **✅ Sim** → mantém logado, renova a atividade (benefício da dúvida),
   registra `still_working`.
4. **❌ Não** → **cascade**:
   - fecha as tasks abertas dele com `ended_at = última atividade`
     (`closed_reason = forgotten_checkout_cascade`),
   - desloga a sessão (no mesmo horário),
   - agenda DM da Carolina pro **dia seguinte 08:30 (EDT)**,
   - **avisa o admin na hora** no `#admin-orin`.

## Admin alert (imediato) vs Carolina DM (dia seguinte)
- **Admin** recebe o alerta no `#admin-orin` no momento do cascade (quem esqueceu,
  quem descobriu, última atividade/task, horário esperado).
- **Operador** recebe o lembrete gentil só no dia seguinte de manhã — via DM
  (se tiver `slack_user_id`) ou no canal de orders mencionando (fallback).
  Worker: `src/workers/carolina-forgotten-dm.js`, flag `WORKER_FORGOTTEN_DM_ENABLED`.

## Política sugerida
- **Não punir** — é lembrete, não bronca. O tom da DM é gentil.
- O texto menciona que esquecer baixa a pontuação de produção (incentivo suave).
- Se foi engano (a pessoa estava mesmo trabalhando), basta responder **✅ Sim**.

## Ajuste manual
- Tabela `v3.forgotten_checkouts` guarda tudo (discovered_via, last_activity,
  auto_logout_at, dm scheduled/sent, resolution).
- Pra reverter um auto-checkout errado: reabrir o event pelo admin / Carolina
  (comando de abrir task) — o cascade não apaga nada, só fecha no horário da
  última atividade.

## Limitação conhecida
O resolve interativo roda **no login** (há sessão válida pra confirmar). No
clock-out a sessão já fecha, então a detecção volta no response mas não dirige
a UI. Operadores que chegam de manhã cobrem o caso principal.
