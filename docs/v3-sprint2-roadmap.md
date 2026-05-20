# HEALTHFARE V3 — Roadmap Sprint 2 (registro de decisões)

> Itens decididos durante o Sprint 1 mas que **pertencem ao Sprint 2**.
> Registrados aqui para não se perderem. NÃO implementar no Sprint 1.

## Broadcast V3 (path próprio, pós-cutover)

Contexto: no Sprint 1, o Observer distingue `admin_broadcast` de
`bot_self` cruzando com a tabela **legada** `admin_audit_log`
(`action='broadcast'`, `entityId == slack ts`). Isso é **dívida de
transição explícita** — só vale durante o parallel-run (shadow).

**Sprint 2 / Fase 4 (cutover):** o V3 vira dono do path de broadcast
e passa a registrar em tabela V3 própria (`v3.audit_log` ou tabela
dedicada). Remover a dependência de `admin_audit_log` legado.
→ Marcado no código do Observer (§2.8) como `TODO Sprint 2`.

### Decisões de produto do broadcast (Sprint 2)

1. **Tag de bot mantida.** O broadcast continua saindo com a tag de
   bot do Slack (sem user token). Bruno decidiu que user-token não
   vale a complexidade — o foco é o tracking.

2. **Nome custom por mensagem.** O admin escolhe o nome a cada
   broadcast. `Carolina` é o padrão.

3. **Settings de nomes de broadcast:**
   - `broadcast_names` = lista gerenciável pelo admin via dashboard
     (`['Carolina', ...]`, 3+ nomes).
   - `broadcast_default_name` = `'Carolina'`.
   - UI do botão 📢: dropdown com os nomes salvos + opção "outro
     nome" para digitar um novo na hora.
   - Admin pode adicionar/remover nomes da lista no settings.

## Outros itens Sprint 2 já decididos

- **Stale check worker** (15 min, `last_stale_check_at` +
  `stale_check_count`) — schema já tem as colunas (Sprint 1 §1.1);
  o worker é Sprint 2 (manda DM, e Sprint 1 é shadow puro).
- **Admin Assistant** (`llm_admin_assistant_active`) — ativado no
  Sprint 2.
- **App Home V3** — origem `app_home` já aceita no
  `v3.audit_log.actor_type` (hotfix 002, Sprint 1).
