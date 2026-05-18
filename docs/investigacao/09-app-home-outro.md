# 09 — App Home "Outro" sem detalhe (BUG L-18)

## 9.1 Cenário
App Home mostra "↳ Outro · Iniciado 2:00 PM · Ana" / "Outro · App Home" — sem dizer "Outro o quê".

## 9.2 Rastreio no banco (EVIDENCIADO — `_raw/ad_hoc_task_instances_today.json`)
Linha única de ad-hoc hoje:
```
id 42 · ad_hoc_task_id 8 · task_name "Outro" · status open
started_at 18:00:55Z (=14:00 ET) · started_by_operator_id 1 (Ana)
notes "limpeza" · meta {} · legacy_table null
```
oal correspondente: `oal 87` (Ana, activity_type `ad_hoc`, ati 42, 14:00→15:09, dur 4137s). EVIDENCIADO: o detalhe **existe** — `notes = "limpeza"`. A tarefa real era **Limpeza**, escolhida no wizard como template genérico "Outro" com nota "limpeza".

## 9.3 Por que o App Home mostra só "Outro"
- O render do App Home/dashboard usa `task_name` (= "Outro", o nome do template `ad_hoc_tasks` id 8) e **não concatena `notes`** (="limpeza"). O detalhe está gravado mas **não é exibido**.
- O wizard do App Home gravou a escolha como template "Outro" + nota livre, em vez de mapear "limpeza" ao template **"Limpeza"** que existe em `ad_hoc_tasks` (templates: Estoque, Limpeza, Manutenção, Outro, Reporte no sistema, Reunião, Transformação, Treinamento — visto em rodada anterior). **ACHISMO** (sobre a UI do wizard — não reinstrumentei o fluxo de botões; baseado no dado gravado).
- Duplicidade: a mesma "limpeza" da Ana também virou legacy `tasks` 493 ("limpeza", task_type=limpeza, closed 1594s) — ou seja, App Home (ad_hoc 42) **e** parser/legacy (task 493) gravaram a limpeza separadamente. Mais um caso de modelo duplo (doc 05).

## 9.4 Conclusão L-18
Não é "perdeu o detalhe" — o detalhe (`notes="limpeza"`) **está no banco**. Dois sub-bugs:
1. **Exibição:** render mostra `task_name` ("Outro") e ignora `notes` → some na tela.
2. **Modelagem:** wizard cataloga como "Outro"+nota em vez de casar o template "Limpeza"; e duplica com o legacy `tasks` 493.
Decisão Bruno: App Home deve (a) mostrar `notes`/nome real, e (b) o wizard mapear pra template específico quando existir.
