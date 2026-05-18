# 08 — Card duplicado Vitor / Plant Sterols #0134

## 8.1 Cenário
Dois+ cards p/ o mesmo batch 0134, durações/operadores diferentes ("Plant Sterols #0134 · Vitor 2:40" e "Produção de Suplemento #0134 ↳ Revisão #0134 · Vitor 2:13").

## 8.2 Rastreio no banco (EVIDENCIADO — `_raw/phase_joined_today.json`, `tasks_today.json`, `oal_joined_today.json`)

A mensagem **09:58 "S-Plant 0134 …- Bruno"** (editada de Potassium, conta U08JC85HMNE) e suas continuações geraram:

**workflow_instances:** `453` (Potassium Iodide, batch 0134) e `454` (Plant Sterols, batch 0134) — **dois workflows, mesmo batch**, porque a edição mudou o produto e `findOrCreateWorkflowInstance` chaveia por produto+batch.

**phase_instances (todas batch 0134 / Plant ou Potassium):**
| id | phase | produto | starter | status | origem (msg ts) |
|----|-------|---------|---------|--------|-----------------|
| 533 | Linha de Produção | Potassium | Vitor | deleted | 1779112687 (texto original) |
| 545 | Linha de Produção | Plant | Vitor | deleted | 1779112687 (reprocess edição) |
| 534 | Linha de Produção | Plant | Vitor | closed 13:54 | 1779112687 → fechada por "F-Plant-0134" 13:54 |
| 544 | Linha de Produção | Plant | **Bruno** | open | 1779112687 (outra resolução de operador) |
| 555 | Linha de Produção | Potassium | Vitor | deleted | 1779131350 "S- Manutencao do Potassium" |
| 551 | Revisão | (null) | Vitor | open | 1779127998 "S-Revisando Plant-0134…" 14:13 |
| 553 | Revisão | Plant | Vitor | open | 1779129635 "S: Revisao Plant (0134)" 14:40 |
| 552 | Revisão | (null) | Simone | open | 1779128613 "S- revisao Plant" 14:23 |

**tasks (legacy):** 487 (Bruno, Plant 0134, deleted) + 488 (Vitor, Plant 0134, deleted) — **mesmo `slack_start_ts` 1779112687, operadores diferentes**; 492 (Vitor, 0134, "Plant…- Bruno", outro); 494 (Vitor, Plant 0134, revisao, open).

## 8.3 Por que dois (vários) entries
1. **Edição reprocessada** (poller.js:67-72): cada vez que a msg/edição passa, re-parseia e re-dispatcha → nova phase/task (533→545→534→544). Sem idempotência por `slack_ts`. (L-06)
2. **Produto mudou na edição** → `findOrCreateWorkflowInstance` cria **wf 454 (Plant)** além do **wf 453 (Potassium)** → cards de batch 0134 em 2 workflows.
3. **Operador não-determinístico** (L-08): mesma msg resolve "Vitor" (id-fixo) numa passada e "Bruno" (sufixo "- Bruno" capturado) noutra → 487 Bruno vs 488 Vitor; phase 544 Bruno vs 534 Vitor.
4. **Revisão duplicada:** "S-Revisando Plant" (14:13), "S- revisao Plant" (14:23, Simone), "S: Revisao Plant (0134)" (14:40) → **3 phases Revisão** (551 Vitor, 552 Simone, 553 Vitor) + task 494, sem nenhuma fechar a anterior (dispatcher abre nova quando não casa "última aberta + template + produto/batch"; produto null em 551/552).

## 8.4 Conclusão
Um único trabalho real (Bruno revisando Plant 0134) está espalhado em **≥4 phase_instances + 4 tasks + 2 workflow_instances**, com starter alternando Bruno/Vitor/Simone. **Causas:** L-06 (edição→N rows, sem idempotência por slack_ts), L-08 (operador trocado), produto-na-chave do workflow, e fechamento por "última aberta que casa" (não casa quando produto/batch vêm null) → sempre abre nova.
