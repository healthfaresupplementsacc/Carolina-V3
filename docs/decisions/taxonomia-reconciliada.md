# Taxonomia reconciliada — L-xx ↔ B-xx / D-xx

## ⚠️ Bloqueio honesto (ler antes da tabela)

A TAREFA pedia mapear L-xx contra **Seção 9 (B-01..B-18)** e **Seção 10
(D-01..D-14)** do `CAROLINA_HANDOFF_MASTER.md`.

**`CAROLINA_HANDOFF_MASTER.md` NÃO está no repositório** e a taxonomia
`B-xx`/`D-xx` **não aparece em nenhum `.md`** (grep em todo o repo,
excl. node_modules → zero ocorrências). O documento que existe na raiz,
`carolina_master_doc.md` ("Documento Mestre de Remodeling", 1933
linhas), tem outra estrutura: **Seção 9 = "Breaks e pausas"**,
**Seção 10 = "Picking & Packing"** — não é o handoff master e não
contém B-/D-.

Portanto a coluna **"Corresponde a"** está marcada **PENDENTE**: eu
**não invento** números B-/D- sem a fonte. O lado L-xx (minha
investigação em `docs/investigacao/`) + status/commits está **completo
e verificado**. Para fechar o mapeamento: **cola aqui as Seções 9 e 10
do `CAROLINA_HANDOFF_MASTER.md`** (ou adiciona o arquivo ao repo) e eu
preencho a coluna numa passada.

Legenda status: **mitigado** (band-aid emergência) · **endereçado/Fase 1**
(caminho canônico já trata; legacy ainda em sombra até Fase 2) ·
**cadastro/Fase 0** · **pendente-definição** (não documentei o L-xx).

| L-xx | Descrição (da investigação) | Corresponde a | Status atual |
|------|------------------------------|---------------|--------------|
| L-01 | Phantom "Linha de Produção" criada p/ start sem contexto | PENDENTE (handoff ausente) | Mitigado `78fb400`; endereçado Fase 1 P1/P3 `4698f9a`/`ec75403` (canonical não cria phantom) |
| L-02 | Operador real (P&P) aparece em phantom "Linha de Produção" no board | PENDENTE | Mitigado `78fb400`; Fase 1 P1/P3 |
| L-03 | Soma de duração não conta P&P (`getOperatorStats` só `tasks`) → "0min" | PENDENTE | Mitigado `ec82473` (soma `orders_sessions`); leitura definitiva = Fase 2 |
| L-04 | Cowork ("ajudando X") virou fase "Linha de Produção", não helping | PENDENTE | Endereçado Fase 1 P1 (`helping_start/helping_end` no event-schema) `4698f9a`; legacy `join_producao` em sombra |
| L-05 | "ANA- F: LIMPEZA" virou phantom Linha de Produção e **fechou o Rutin** | PENDENTE | Endereçado Fase 1 P1 (`finish` fecha `target_phase_id`, não "última que casa") `4698f9a` |
| L-06 | Edição/reprocesso de mensagem cria N rows (sem idempotência) | PENDENTE | Endereçado Fase 1 P1 (`dispatcher_index` UPSERT por `source_id`) `4698f9a` |
| L-07 | Separador `_` / multi-ação / mensagem não classificável **descartada em silêncio** | PENDENTE | Endereçado Fase 1 P3 (`classify`→note nunca descarta; separadores) `ec75403` |
| L-08 | Operador errado (Bruno↔Vitor; user-id fixo no parser; cadastro furado) | PENDENTE | Cadastro Fase 0 (`be460a5`/`a2e8b9f`/`5a606ce`) + Fase 1 P2 `resolveOperator` único `ca293de` |
| L-09 | Card mostra atividade ativa mas timer zerado | PENDENTE | Mitigado `ec82473`; Fase 1 (sem phantom) reforça |
| L-10 | "F:" classificado como start/`formulation_start` (sentido invertido) | PENDENTE | Endereçado Fase 1 P3 ("F:" sempre finish) `ec75403` |
| L-11 | **Definição não documentada na minha investigação** | PENDENTE | pendente-definição (preciso do handoff p/ confirmar o que é L-11) |
| L-12 | Carolina reage/pergunta mas vai tudo p/ `silent_log` (operador nunca vê) | PENDENTE | Endereçado Fase 1 P6 (pergunta SEMPRE no admin chat, isento `silent_text`) `b376f5e` |
| L-13 | Auto-check de atividade parada não pergunta (raiz = L-08 + silenciamento) | PENDENTE | Endereçado Fase 1 P2/P6/P7 (operador resolvido + admin chat + ingestão) `ca293de`/`b376f5e`/`7c4c833` |
| L-14 | **Definição não documentada** | PENDENTE | pendente-definição |
| L-15 | **Definição não documentada** | PENDENTE | pendente-definição |
| L-16 | **Definição não documentada** | PENDENTE | pendente-definição |
| L-17 | **Definição não documentada** | PENDENTE | pendente-definição |
| L-18 | App Home mostra "Outro" sem o detalhe (nota existe no banco, não renderiza) | PENDENTE | Endereçado Fase 1 P4 (render mostra nota; wizard→template) `ded58ee` |

## Notas de honestidade
- **L-01..L-10, L-12, L-13, L-18**: definições firmes (vêm das rodadas de
  emergência + `docs/investigacao/03,06,07,09` + `RESUMO-EXECUTIVO`).
- **L-11, L-14..L-17**: o Bruno mencionou a faixa "L-12 a L-18", mas só
  L-12/L-13/L-18 foram detalhados na investigação. Não tenho definição
  firme de L-11/14/15/16/17 → **não invento**.
- "Endereçado Fase 1" ≠ "resolvido em produção": Fase 1 está em código +
  testes (tag `pre-fase2`=`a0c29c0`), **não validada/deployada** até o
  cutover; legacy ainda escreve em sombra (P8) até a Fase 2 cortar as
  leituras. Logo, bugs visíveis no dashboard podem persistir até Fase 2.
- Próximo passo p/ fechar este doc: **Seções 9 e 10 do
  CAROLINA_HANDOFF_MASTER.md**.
