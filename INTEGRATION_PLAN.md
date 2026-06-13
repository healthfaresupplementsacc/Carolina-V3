# Integração do redesign V4 — plano oficial

Branch de trabalho: **`dashboard-v4`** (saiu de `v3-reset`).
Dashboard atual (`dashboard/` em `v3-reset`) **NÃO é tocado** até o switch final no E8.

## Princípios

- **Caminho A — skin transplant.** Visual novo, lógica preservada. O redesign do Claude Design é a **forma**; a função vem do dashboard atual.
- **PARA em cada `E*`** e mostra antes de seguir.
- Cada `E*` é commitável e revertível por `git reset`. Nada destrutivo até o E8.
- **Lista de paridade** (seção "Garantias de paridade" abaixo) é obrigatória antes de E8. Nenhuma feature atual pode sumir.

## Estado dos serviços durante a migração

- **Observer V3 (shadow):** intocado. Continua processando msgs do Slack.
- **`V2_DISABLED=1`:** mantido. Os crons V2 continuam off.
- **`/api/v3/data/*`:** não muda — só adicionamos um consumidor novo paralelo.
- **`/dashboard`** (atual): segue servido até o E8. Bruno usa em paralelo com o `/dashboard-v4`.
- **Snapshot endpoint:** intocado.

## Etapas

### E0 — Setup (esta fase)
- Cria branch `dashboard-v4` saindo de `v3-reset`. ✅
- Copia conteúdo do `Production.zip` pra `dashboard-v4/`.
- Converte CDN-Babel → projeto Vite com ES modules (`import`/`export`).
- `package.json` Vite + React 18.
- **Ajuste 1:** Carolina volta na nav (placeholder Bloco 5).
- **Ajuste 2:** marca explicitamente no código onde o drag&drop chama writes — vai ficar atrás de feature-flag `V4_ALLOW_WRITES=0` no E5/E6.
- Build local roda com dados **mock** (`window.HFData`). **Sem API ainda.**
- **Pausa.** Bruno aprova antes de E1.

**Risco:** zero (mock-only, isolado).

### E1 — Tema + tokens isolados
- Garante que `styles.css` + `timeline.css` + `extras.css` carregam sem conflito.
- Smoke "hello world" usando os tokens (`--hf-navy-*`, `--hf-leaf-*`, `--surface`, etc).
- Toggle de tema (light/dark) funciona via TweaksPanel.

**Risco:** zero.

### E2 — Adapter API → HFData (leitura, isolado)
- `dashboard-v4/src/adapters/from-api.js`:
  - `useSnapshotAsHFData(date, token)` — fetch `/api/v3/data/snapshot?date=&token=` ou compõe `/timeline + /production + /pp + /goals + /counts + /deadlines`
  - Retorna o shape `HFData` que o redesign espera
  - Mapeia: `event_id ↔ id`, `person_id ↔ op`, `activity.slug ↔ activity`, `started_at (ISO) ↔ started_min (min-from-midnight)`, `cowork_with (number[]) ↔ cowork (string[])`, `product_batch_id ↔ product` via batchById
- Testes unitários do mapeamento.
- **Ainda sem ligar na UI.**

**Risco:** zero (só o adapter; UI continua mock).

### E3 — PIN gate + date global
- Pega `PinGate` do dashboard atual e pluga ANTES do `<App>` do redesign.
- Date selector global do shell (atualmente em `App.jsx` do redesign tem `useState` local) passa a ser controlled prop.
- `sessionStorage` p/ PIN igual ao atual.

**Risco:** baixo (gate + state).

### E4 — CommandCenter ligado em dado real (só leitura)
- Página `Hoje` passa a usar `useSnapshotAsHFData` em vez de `window.HFData` mock.
- Auto-refresh polling 12s + `useNow(1s)` ligados.
- Filtros chips funcionam contra eventos reais.
- **Edição ainda desligada.** Botão Editar abre painel em modo `view` apenas.

**Risco:** baixo (só GET).

### E5 — Painel detalhe + edição + criar
- `SidePanel` modo `edit` salva via `apiPatch('/events/:id', {changes})`.
- `apiDelete` + toast undo restaurando via `POST /events/:id/restore`.
- Modo `create` chama `apiPost('/events', {...})`.
- Aviso de sobreposição (foreground × foreground) ressuscitado do `CCDetail` atual.
- Produto + Lote separados (`/batches/resolve`).
- Quantity / quantity_unit.

**Risco:** médio (primeiros writes).

### E6 — Drag&drop com feature-flag
**Default: `V4_ALLOW_WRITES=0`** (env var no Railway). Drag mostra só preview, não persiste.

Quando `V4_ALLOW_WRITES=1`, libera **gradualmente**:
- **Fase a:** drag horizontal (mover início/fim) + resize de borda → `apiPatch started_at/ended_at`.
- **Fase b (depois, com Bruno validando):** drag vertical (trocar de pessoa) — começa **desligado**, libera só quando Bruno autorizar.
- **Fase c:** merge-on-drop reutiliza nosso `CCMergeConfirm` modal antes de `POST /events/merge`.
- **Split modal** com datetime-local — porta do atual.

**Risco:** alto se sem flag; controlado pela flag.

### E7 — Demais páginas + FloorDisplay
- Trazer `Producao`, `PP`, `Suporte`, `Pessoas`, `Produto`, `Metas`, `Config` do redesign + ligar API igual ao Hoje.
- **`Falar` — NÃO recriar.** O atual tem MUITA lógica (sender_profiles CRUD, mrkdwn buttons, mentions picker, thread input, image inline+pub_secret, react form, audit history). Levo o componente atual e só re-skin com os tokens visuais novos.
- **`Carolina` (placeholder Bloco 5)** — volta na nav ✅.
- **`FloorDisplay` (nova)** — modo TV. Ideal expor via `/dashboard-v4/floor` ou subdomain dedicado lendo do snapshot+token (sem PIN).

**Risco:** baixo-médio (páginas operacionais simples + Falar com cuidado).

### E8 — Switch de URL
**Pré-requisito: lista de paridade abaixo 100% checada.**

- Express passa a servir `dashboard-v4/build` em `/dashboard`.
- O `dashboard/` antigo vai pra `/dashboard-legacy` (acesso preservado por 30 dias).
- Bruno usa `/dashboard-v4` em paralelo dias antes do switch pra validar.

**Risco:** baixo se a paridade foi cumprida; rollback trivial (reverter o Express).

---

## Garantias de paridade (obrigatório antes do E8)

Cada item DEVE estar funcionando no v4 antes do switch:

### Leitura
- [ ] Timeline horizontal por pessoa (eixo de horas, blocos posicionados, linha "agora")
- [ ] 4 cards do topo (Produção / Metas / P&P / Atenção)
- [ ] Cor por flow (production / pnp / support / meta)
- [ ] Cronômetro h:mm:ss live + duração final congelada
- [ ] Hover popup pequeno (segue o mouse)
- [ ] Cowork chips com iniciais resolvidas
- [ ] Background overrun com ⏰ + borda âmbar pulsante
- [ ] Idle vs "sem registro" (label distinto)
- [ ] Worker status no header (`/health` lido)
- [ ] Date selector global ◀▶ compartilhado entre páginas
- [ ] Auto-refresh polling 12s (silencioso, sem piscar)
- [ ] `useNow(1s)` tick pros cronômetros
- [ ] União de intervalos no P&P (tempo de parede, não soma)
- [ ] Sub-passos P&P com `wall_seconds` por atividade
- [ ] Person-seconds (carga individual P&P)
- [ ] 3 envios separados (P&P / DC / clínica) — slugs corretos
- [ ] FloorDisplay (TV mode) lendo snapshot

### Edição (todos via API)
- [ ] PATCH `/events/:id` (drawer edit)
- [ ] DELETE `/events/:id` + toast undo + `POST /events/:id/restore`
- [ ] POST `/events` (criar novo registro)
- [ ] POST `/events/merge` (juntar 2 com preview)
- [ ] POST `/events/:id/split` (dividir com datetime)
- [ ] Aviso de sobreposição (foreground × foreground) — não bloqueia, 2 cliques
- [ ] Drawer com Produto + Lote SEPARADOS (`/batches/resolve` com placeholder)
- [ ] Quantity + Unit no event
- [ ] PATCH `/goals/:id` + DELETE
- [ ] PATCH `/counts/:id` (supersede) + DELETE
- [ ] POST `/counts/:id/confirm` (duplicate/additional)
- [ ] GET/POST/PATCH/DELETE `/deadlines` na Config
- [ ] feature-flag `V4_ALLOW_WRITES` respeitada no drag

### Auth e segurança
- [ ] PIN gate (`x-admin-pin` header em todos os writes)
- [ ] PIN persiste em `sessionStorage`
- [ ] Botão sair

### "Falar como Carolina" (porta de saída manual)
- [ ] Persona (select de `/sender-profiles`) + Canal (Produção/Admin)
- [ ] Texto com toolbar mrkdwn (B/I/`/~)
- [ ] Mentions picker (Vitor/Simone/Ana/Henrique → `<@U…>`)
- [ ] Imagem inline (files.uploadV2 + sharedPublicURL + image block)
- [ ] Fallback: imagem como link quando scope faltar
- [ ] Thread_ts (link Slack ou ts cru, parseado)
- [ ] Preview WYSIWYG
- [ ] 2-cliques no Enviar
- [ ] Sender profiles CRUD (criar/editar/set-default/apagar)
- [ ] React form (canal + ts + emoji → `POST /react`)
- [ ] Histórico (✉/⚛/🖼/📎/🧵 distintos)

### Cérebro / aprendizado
- [ ] `uncertain` flag persistida no `llm_result`
- [ ] Endpoint `/uncertain-cases` disponível
- [ ] (UI da aba "Cérebro" pode ficar pro Bloco 5)

### Snapshot
- [ ] `GET /api/v3/data/snapshot?date=&token=` continua respondendo intacto
- [ ] Adapter usa snapshot OU múltiplas queries paralelas

### Configurações editáveis (admin)
- [ ] Deadlines CRUD
- [ ] (Opcional: `expected_seconds`, idle threshold etc — futuro)

---

## Riscos e mitigações

| risco | severidade | mitigação |
|---|---|---|
| Babel CDN runtime do protótipo é proibitivo em prod | alta | E0 converte pra Vite ESM no primeiro passo. |
| Light theme novo pode incomodar quem se acostumou com dark | média | TweaksPanel mantido — toggle dark disponível. |
| Shape mismatch (id↔slug, minute↔ISO) gera bugs sutis | média | Adapter centralizado em `from-api.js` com testes unitários. |
| Drag&drop em prod = ações destrutivas por gesto | alta | Feature-flag `V4_ALLOW_WRITES=0` default. Drag = preview até liberar. |
| Perda de features atuais por esquecimento | alta | Lista de paridade obrigatória antes do E8. |
| `Falar` redesenhado pode "achatar" complexidade real | alta | NÃO recriar — re-skin do atual. |
| Bug latente no drag tocando DB durante teste | alta | Sem `V4_ALLOW_WRITES=1`, drag não chama PATCH. |
| 11→12 itens na sidebar pode quebrar mobile do redesign | baixa | Testar mobile no E4. |
| Bruno usar URL `/dashboard` esperando v4 antes do switch | baixa | `/dashboard-v4` em paralelo dias antes; comunicar internamente. |

---

## Reversão a qualquer momento

- `git checkout v3-reset` → volta tudo pro estado de antes.
- Branch `dashboard-v4` continua existindo pra retomar.
- Express continua servindo `dashboard/` em `/dashboard` até o E8.
- Nenhuma migration de DB, nenhuma mudança de schema.

---

## ✅ ENTREGUE 12/JUN (blocão Operator Page + pivot custo)

- Architect API read-only (11 endpoints, ARCHITECT_API_TOKEN/OPERATOR_PAGE_TOKEN)
- Operator Page `/op` completa (migration 018, PIN scrypt, cowork A+B,
  voice, clock-out P5) — input estruturado SEM LLM
- Gemini 2.5 Flash primário (free, $0) + fallback Anthropic automático
  (`LLM_PROVIDER`, FallbackProvider 3 falhas/5min)
- Dedupe Slack↔página (migration 020, worker 60s, superseded_by) +
  notificações Carolina ✅/❌/📝 no #admin-orin
- Docs: OPERATOR_PAGE.md, ADMIN_NOTIFICATIONS.md, adendo no handoff

## 🔴 TODO #2 — Admin UI pra gerenciar operadores (futuro, 4-6h)
PINs (set/rotate), auto-logoff por operador, count_exempt, listar
notifications pendentes. Hoje: scripts + endpoints existem, UI não.

## 🔴 TODO #3 — Rotacionar GEMINI_API_KEY
A key inicial foi exposta no chat (12/jun). Bruno gera nova em
aistudio.google.com/apikey e seta direto no Railway (não passa por chat);
CC confirma worker saudável depois. **Fazer logo.**

## 🔴 TODO #1 PÓS-DEPLOY-3 — retry infinito sem dead-letter (12/jun)

**Risco**: msg que falha (llm_error, invalid_llm_response) fica com
`llm_processed_at=NULL` → re-claim a cada ~2min PARA SEMPRE (Observer.js
claim não filtra tentativas). Uma msg envenenada ≈ 720 calls/dia ≈ **$20/dia**
até intervenção manual. Em 12/jun a fila estava limpa (0 presas), mas o
mecanismo continua latente.

**Fix (aprovado pelo Bruno, não escopar antes do Deploy 3)**:
- Migration: `v3.messages` + `processing_attempts INT DEFAULT 0`,
  `last_error TEXT`, `dead_lettered_at TIMESTAMPTZ`.
- Observer claim: incrementa attempts; `attempts >= 3` → marca
  `dead_lettered_at=NOW()` + `processing_error` e SAI da fila.
- Claim query exclui `dead_lettered_at IS NOT NULL`.
- Alerta admin (já existe canal de worker alerts) ao dead-letterizar.
- Endpoint architect `/diagnostics/queue` passa a expor dead-lettered.

---

## 🔴 BUGS LLM URGENTES — pendentes (descobertos 01/jun auditoria)

**Status**: diagnosticados read-only (llm_result inspecionado), **NÃO corrigidos**.
**Quando**: implementar DEPOIS das 4 frentes (admin-orin, endpoint architect,
validação, smoke). Anotados aqui pra não perder.

### BUG #1 — Event órfão de activity_type
- **Trigger**: msgs tipo "Cortando Silica" onde o LLM não acha slug perfeito no catálogo.
- **Sintoma**: emite `activity_type_id=null` + `uncertain=false` + **persiste** event sem tipo (caso real: ev372, msg#798 01/jun).
- **Recorrência**: ALTA (diário).
- **Causa raiz**: LLM reconhece a atividade ("preparação de material") mas não faz fallback pra `material_handling` (id=28); e não há guard contra persistir event type-null.
- **Fix candidato (2 camadas)**:
  - (a) Regra nova **R38** no `prompt-builder.js`: "Atividades de preparação de material (cortar sílica, separar pó, pesar matéria-prima) → `activity_type=material_handling` (id=28)".
  - (b) Guard em `EventService._upsert`: se `activity_type_id IS NULL` → força `uncertain=true` E `confidence='low'` E loga audit `event.type_null_blocked`. Não deixa persistir limpo.
- **Retroativo**: corrigir ev372 junto do fix (ou depois).

### BUG #2 — Open_event fantasma em F: com verbo contínuo
- **Trigger**: "F: ... rodando" / "F: ... funcionando" / "F: ... em andamento".
- **Sintoma**: LLM honra o F (close correto) **+ INVENTA** um open_event novo de "background rodando" que ninguém pediu → fica OPEN sem fechar (caso real: ev345, msg#746 01/jun, OPEN 7h, `is_long_running=false`).
- **Recorrência**: MÉDIA.
- **Causa raiz**: verbo de estado contínuo ("rodando") gatilha start implícito; msg categorizada `activity_start` apesar do prefixo `F:`.
- **Fix candidato (2 camadas)**:
  - (a) Regra nova **R39** no `prompt-builder.js`: "F explícito de fim-de-fase NUNCA gera open_event novo, exceto se o operador POSTOU EXPLICITAMENTE outro S: na mesma msg. Verbos de estado contínuo (rodando/funcionando/em andamento) descrevem o estado que ACABOU de mudar, não disparam start novo."
  - (b) Guard em `Observer._applyAction`: se action é `open_event` MAS msg começa com `F:` (fim explícito) E nenhum `S:` explícito na mesma msg → bloqueia o open + audit `action.phantom_open_blocked`.
- **Retroativo**: fechar ev345 manualmente em 12:30 PM (depois do close de ev344), junto do fix.

### BUG #3 — Reply do CommandHandler sempre em thread (deveria depender do tipo)
- **Trigger**: qualquer comando admin via @Carolina.
- **Sintoma**: Carolina responde em **thread reply** da msg do admin. Pra `query_status`/comandos rápidos, Bruno prefere **mensagem top-level** no canal. (Smoke 01/jun.)
- **Decisão de design**:
  - `query_status` / comandos rápidos → **canal principal** (top-level, `thread_ts=null`).
  - destrutivos / pending confirmation → **thread reply** (`thread_ts=message.slack_ts`) pra não poluir o canal com confirmações.
- **Fix**: no `CommandHandler`, passar `thread_ts=null` pro `_reply` no caminho `query_status` (e demais não-destrutivos rápidos); manter `thread_ts` nos destrutivos/pending. Ajuste rápido — próximo bloco.

### BUG #4 — query_status ignora o filtro semântico de activity_type
- **Trigger**: "quem está **na linha de produção** agora?" (e perguntas com filtro de atividade).
- **Sintoma**: retorna TODOS os events LIVE com `flow='production'` (production_line + formulation + review + cowork etc.), não só `activity_type=production_line`. O LLM do `query_status` não faz parsing do filtro semântico.
- **Fix candidato**: (a) melhorar o prompt do `query_status` pra mapear filtros ("linha de produção"→slug `production_line`); OU (b) retornar tudo LIVE mas **agrupado por tipo** (mais visual). Decidir no próximo bloco.

### BUG #5 — Linha "? / — — <pessoas>" na resposta (events de produção sem batch)
- **Trigger**: resposta do `query_status` current_production.
- **Sintoma**: linha `• ? / — — Bruno Sarmento, Vitor` — o GROUP BY `(produto, batch)` agrupa events `flow='production'` **sem batch** em `(null,null)`.
- **Causa (confirmada 01/jun, read-only)**: NÃO é o ev372/BUG #1 (esse já não está mais LIVE). São **ev213** (formulation Bruno Sarmento, batch NULL, aberto desde 26/mai — provável long-running Potassium) **+ ev345** (formulation Vitor, batch NULL, = BUG #2 stale). Artefato de display de events de produção sem produto/lote vinculado.
- **Fix candidato**: na query do `_executeQuery`, ou (a) omitir/rotular events sem batch ("(sem lote)"), ou (b) resolver junto do BUG #2 (ev345 não deveria existir) e revisar se ev213 é long-running legítimo. Cosmético; depende de BUG #2.

---

## TODO — audit actor_type 'admin_via_slack' (Frente 1, 01/jun)

Hoje comandos admin via @Carolina (Slack) gravam no `audit_log` com
`actor_type='admin'` — mesmo valor de comandos via dashboard UI. Isso
porque o CHECK `audit_log_actor_type_check` só permite
`admin | llm_observer | llm_assistant | system | app_home`, e o valor
`'admin_via_slack'` (usado originalmente no `CommandHandler._audit`)
**violava o CHECK** → todo audit de comando admin falhava silenciosamente
(descoberto no smoke admin-orin 01/jun).

**Por ora:** `_audit` usa `'admin'` (passa no CHECK; rastreabilidade
restaurada). **TODO:** considerar adicionar `'admin_via_slack'` ao CHECK
pra diferenciar comando-via-Slack de comando-via-dashboard. Revisar quando
o bloco grande **Carolina configurável** rolar (migration nova que altere
o CHECK + atualizar `_audit`).

---

## TODO futuro — aprendizado contínuo da Carolina (bloco 28/mai noite #11)

A cada ajuste/correção feita pelo admin no `/dashboard-v4`, o sistema grava
audit_log. Esses audits são **lições** pro LLM aprender a evitar o mesmo
erro. **Não implementado ainda** — apenas documentado aqui pra próximo bloco.

### Sinais já capturados em `v3.audit_log`
| `action`                | significado pro LLM                                          |
|-------------------------|-------------------------------------------------------------|
| `event.corrected`       | admin corrigiu campo (product, cowork, person, etc) → o LLM errou nesse padrão |
| `event.deleted`         | admin apagou event criado pelo LLM → false-positive (não devia ter criado) |
| `event.merged`          | dois events viraram um → LLM segmentou demais |
| `event.split`           | um event virou dois → LLM agregou demais |
| `event.reassigned`      | mudou person_id → atribuição errada (msg sem assinatura, multi-author) |
| `event.long_running_set`| admin marcou multi-dia → LLM não detectou continuidade |
| `manual_post.sent` (Carolina) | admin perguntou via Carolina → texto vira exemplo de coaching |

### Pipeline futuro
1. **Coleta semanal** — script puxa `audit_log` da semana com `actor_type='admin'`
   E `action IN ('event.corrected', 'event.deleted', 'event.merged', 'event.reassigned')`.
2. **Diff** — pra cada audit, monta o "antes/depois" do payload (já temos
   `before_data` em audit) + texto da msg origem.
3. **Síntese** — agrupa por padrão (ex.: "msgs sem assinatura sendo
   atribuídas pro Vitor quando deveriam ser pro Bruno"; "events sem batch_id
   pra Potassium"; "admin fala 'to em reuniao' e vira event de meeting").
4. **Enriquecimento do prompt** — adiciona como **novas regras** no
   `prompt-builder.js` ou como **exemplos few-shot** na seção `EQUIPE`/contexto.
   Versionado: cada enriquecimento gera commit com link pro audit que
   originou.
5. **Validação** — re-roda o LLM nas msgs corrigidas e confere se a nova
   classificação bate com o que o admin escolheu.

### Bloco grande pendente — Carolina ATUA em @ menção (caso motivador real)

**Status**: documentado, NÃO implementado.
**Caso motivador**: 29/mai msg722 16:00 — Bruno Camp postou
`@Carolina maquinario sem funcionar de 4:18pm as 4:52pm`. Carolina
respondeu **"Anotado"** (msg723) mas **nenhum event criado no banco**.
A intenção do Bruno era criar um `machine_downtime` retroativo
4:18-4:52 PM.

**Outro caso que JÁ funciona** (referência): msg700 13:14 Bruno Camp
`@Carolina Simone saiu pro almoco as 1:01pm, por favor registrar` →
Carolina **atualizou ev320** (fechou lunch da Simone retroativo).

**Diferença**: msg700 era sobre lunch + lookup de event existente
(close); msg722 era criar event novo (`machine_downtime`) sem event
pré-existente. Aparentemente Carolina sabe FECHAR mas não sabe CRIAR
retroativo via comando admin.

**Conecta com**: [Comandos admin via Slack](memory/bloco-pendente-admin-slack-commands.md)
— quando esse bloco grande for implementado, Carolina vai criar o
event de verdade ao receber comando. Hoje ela responde "Anotado"
mas não age (false-positive perigoso — admin acha que ficou registrado).

**Workaround atual**: admin precisa criar event retroativo via /admin
ou script ad-hoc até bloco de comandos ser feito.

### Bugs candidatos a alimentar primeiro pulse
- **🔴 PRIORIDADE ALTA — PersonResolver não atribui pessoa pela assinatura
  da mensagem** (custou duas vezes em 2 dias):
  - 28/mai ev302 Thassio: msg "to em reuniao" do slack do Thassio
    (admin) virou event de meeting normal — PersonResolver não marcou
    como `admin_intervention` (LLM precisou decidir).
  - 29/mai msg695 "F- Caixas fechadas-Bruno" enviada do slack do
    Vitor (U08JC85HMNE) ASSINADA "-Bruno" — PersonResolver atribuiu
    pra Vitor; F virou GAP (não fechou dc_shipment do Bruno) e foi a
    causa raiz do ev318 ficar até 14:37 em vez de 12:16 PM.
  - **Causa raiz comum**: PersonResolver depende do LLM detectar
    contexto (admin/assinatura), em vez de processar deterministicamente
    o slack_user_id + assinatura "-Nome" no texto. Quando o LLM erra,
    o sistema também erra.
  - **Fix**: 1) hard-skip por role IN ('owner','manager') quando
    `personsBySlack[slack_user_id].role` é admin; 2) parser de
    assinatura "-NomePropio" no fim da msg ANTES do LLM, sobrescrevendo
    `person_id` se a assinatura mapeia a outro person no catálogo
    (mantém slack_user_id pra audit).
  - **Próximo bloco grande**: sobe pra prioridade #1 depois de
    terminar bloco 29/mai noite + comandos admin slack (que dependem
    do mesmo fix).
- **Batches sem product_batch_id** (caso Potassium 28/mai: 6 events
  production_line sem batch atribuído porque LLM não tinha batch ativo no
  catálogo).
- **Cowork errado por timing** (caso ev281 28/mai: cw=[5,4] mas Simone só
  começou 13min depois — LLM antecipou cowork futuro).
- **end_of_day intocável após criação** (caso ev305 28/mai: dia seguinte,
  Bruno Sarmento postou primeiro foreground 29/mai e o auto-close
  `meta_closed_by_fg` em EventService.upsert pegou o end_of_day também e
  fechou em 29/mai 11:29 AM — quebrou invariant "carimbo instantâneo" do
  end_of_day. Fix: em `_closeActive`, pular events com slug='end_of_day'
  (já são instantâneos, não devem ser fechados/movidos pelo auto-close
  de outro turno). Bloco 28/mai noite documentou; pendente).

### Não implementar agora
Esse pipeline é E9+ (após estabilizar V4 + Falar como Carolina). Antes disso,
correções continuam manuais (admin via /dashboard-v4 + scripts/v3-apply-fix-*.js)
e cada bloco diário gera audits que ficam no histórico esperando o pipeline
nascer.
