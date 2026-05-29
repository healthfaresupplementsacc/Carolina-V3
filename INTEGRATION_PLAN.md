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
