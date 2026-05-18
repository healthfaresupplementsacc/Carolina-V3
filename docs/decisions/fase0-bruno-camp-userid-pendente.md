# Decisão FASE 0 — slack_user_id do Bruno Camp ✅ RESOLVIDO

Status: **RESOLVIDO** via Slack `users.list` / `users.info`.
`operators` id=333 `slack_user_id = U03URLL1D4L`.

## Como foi resolvido (EVIDENCIADO)
O método anterior (admin chat) era inviável (canal não persistido). A
solução foi **`users.list`** (escopo `users:read`, bot tem) — enumerou
o workspace e casou por `real_name`:
```
U03URLL1D4L | real_name="Bruno Camp" | display="Bruno Camp" | name="healthfaresupplements" | bot=false deleted=false
```
Re-confirmado por `users.info(U03URLL1D4L)` → `real_name="Bruno Camp"`.
Aplicado em `operators` id=333 (antes `slack=null` → depois
`U03URLL1D4L`), auditado `operator.update_slack_user_id`
`source='fase0_followup_users_list'`. Idempotente.

## Verificações adicionais via users.list (EVIDENCIADO)
- `U07FG34TMPF` → real "Simone" ✔ (op id=4 — confere)
- `U085SDY3F4Z` → real "Henrique Monteiro" ✔ (op id=324 — confere)
- `U03S46L2EUA` → real "Thassio" ✔ (op id=323 — confere)
- `U0AKQHLSSCQ` → real "Ana Beatriz", name `bia` (ex-funcionária — NÃO cadastrar, decisão mantida)
- `U0AU8N8FA00` → display "Production Line", **name `brunosarmento`** (PC de chão compartilhado; conta criada pelo Bruno Sarmento)
- `U0B3EQLPEPL` → "HealthFare Tracker" `bot=true` (o bot Carolina — confirma o ✅ de 18/05)
- `U09DQGJ1ES3` → "Forge Miller" (humano; era o `bryceUserId` legado no config — premissa antiga errada)

## ⚠️ NOVO ponto de decisão — Vitor Leite (NÃO alterado nesta rodada)
`users.list` revelou **DUAS contas distintas**:
- `U08JC85HMNE` → real **"Vitor HealthFare"**, name `vitorhealthfare` — conta da EMPRESA / compartilhada (no histórico postam Bia/Bruno/Vitor/Henrique/Ana/Thassio por prefixo).
- `U08M6DSE17T` → real **"Vitor Leite"**, name `vitor` — conta PESSOAL do Vitor Leite.

Hoje `operators` id=3 "Vitor Leite" = `U08JC85HMNE` (a compartilhada),
por **decisão explícita do Bruno na rodada anterior** ("U08JC85HMNE
FICA com Vitor Leite, é conta dele embora compartilhada"). **Mantido
como está** — não mexi. Mas a evidência mostra que a conta PESSOAL do
Vitor é `U08M6DSE17T`. **Decisão do Bruno p/ Fase 1:** manter
`U08JC85HMNE` (compartilhada, regra por prefixo) ou trocar id=3 p/
`U08M6DSE17T` (pessoal) e tratar `U08JC85HMNE` como conta compartilhada
sem dono (igual `U0AU8N8FA00`).

## Escopo
Só `operators` id=333 alterado (audit). Parser/dispatcher/silent_text
intactos. Nada dropado. id=3 inalterado (decisão anterior do Bruno).
