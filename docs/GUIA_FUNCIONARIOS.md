# Guia Rápido — Como Reportar no Slack
*HealthFare Production · canal `#orders-and-inventory`*

A Carolina (LLM) lê tudo que você posta no Slack e transforma em registro de
trabalho automaticamente. Este guia mostra o que ela espera de você, no
formato mínimo, pra evitar confusão e te poupar de pergunta depois.

---

## 1. As 4 palavrinhas-chave

| Você posta…       | Significa…                                              |
|------------------|---------------------------------------------------------|
| **S: ...**       | **Start** — começou uma tarefa nova                     |
| **F: ...**       | **Finish** — terminou a tarefa anterior                 |
| sem S nem F      | Continuação / detalhe / dúvida — pode ser ignorado     |
| @<pessoa>        | Mencionar (notifica) outra pessoa                       |

Exemplo: você posta `S: Linha de produção Potassium` quando começa. Quando
acaba aquela tarefa, posta `F: Linha de produção 1200 garrafas`. A Carolina
fecha o registro e abre o próximo automaticamente.

---

## 2. O que SEMPRE reportar

| Quando…                                            | Posta isto                                              |
|---------------------------------------------------|---------------------------------------------------------|
| Chegou na fábrica                                 | `S: ...` da primeira tarefa (não precisa "cheguei")    |
| Começou uma fase de produção                      | `S: Linha de produção [produto] [batch se souber]`     |
| Saiu para almoçar                                 | `S: almoço` ou `vou almoçar`                            |
| Voltou do almoço                                  | `S: ...` da próxima tarefa (o sistema fecha o almoço sozinho) |
| Pausou pra resolver algo (≥ 5 min)                | `S: [o que vai fazer]`                                 |
| Trocou a linha (setup pra outro produto)          | `S: troca da linha` ou `S: linha changeover`           |
| Máquina parou / quebrou                            | `S: máquina parou` + descrição (`ajuste`, `quebrou`, etc) |
| Limpeza fim de dia                                | `S: limpeza` (a Carolina sabe que é fim porque é tarde) |
| Acabou o expediente                               | `F: fim do dia` ou `S: fim de expediente`              |
| Contou as garrafas / fechou produção              | `F: [N] garrafas` (a Carolina associa com o lote ativo) |
| Está ajudando outra pessoa em algo                | `S: ajudando [pessoa] no [que]` ou só menciona ela     |

---

## 3. O que NÃO precisa reportar

- **Conversa casual** — "bom dia", "obrigada", emojis. A Carolina ignora.
- **Dúvidas sobre o processo** — perguntar pro Henrique/Bruno por chat normal.
- **Pequenas interrupções** (banheiro, água, < 5 min) — ela já desconsidera.
- **Status checks** — não precisa postar "ainda na linha" toda hora; a tarefa
  fica aberta até você postar `F` ou começar outra.

---

## 4. Formato: como escrever bem

| ❌ Ruim                              | ✅ Bom                                              |
|-------------------------------------|----------------------------------------------------|
| `linha`                             | `S: Linha de produção Potassium`                   |
| `voltei`                            | `S: linha de produção` (o `voltei` é redundante)   |
| `acabei`                            | `F: 1200 garrafas`                                  |
| `to em reuniao`                     | `S: reunião` (o `to em` é desnecessário)           |
| `precisa de mais materia prima`     | esse texto não vira registro — manda pro Henrique  |
| `S: linha S: outra`                 | **um post por tarefa** — quebra em dois posts      |

**Dica**: você não precisa caprichar na escrita. A Carolina entende:
- abreviações ("ord", "imp", "encap")
- variantes ("mix", "mistura", "mixing", "formulação")
- erros de digitação (`producao` = `produção`)
- maiúscula/minúscula

Mas precisa do **S** ou **F** no começo pra saber se é start ou finish.

---

## 5. Casos especiais

### 5a. Manutenção da linha (para todo mundo)
Quando a linha pára (troca de linha, manutenção, máquina quebrou), **quem
está na linha precisa reportar**:
- Se está ajudando na manutenção → não precisa postar nada, vai entrar
  como cowork automático.
- Se vai fazer outra coisa → posta `S: [o que vai fazer]` (ex.: `S: limpeza`,
  `S: organização do estoque`).
- Se vai esperar → posta `S: aguardando a linha voltar` (pra Carolina
  saber que você não sumiu).

Se você não postar nada e a linha estava parada, vai aparecer no admin como
"gap não-justificado durante manutenção" — Bruno/Henrique vão te perguntar
o quê fez.

### 5a-bis. Problema na máquina — REPORTA SEMPRE (instrução Bruno Camp 29/mai)

Quando o maquinário der problema (parar, falhar, dar pressão errada,
quebrar uma peça, qualquer coisa), **reporta NO CANAL imediatamente**.
Mesmo que pareça pequeno. Mesmo que vá voltar logo. Reporta.

Por quê:
- Fica registrado no sistema (vira evento `machine_downtime`).
- Bruno/Henrique veem em tempo real e podem ajudar.
- Histórico fica pra entender padrões de falha do equipamento.

**Formato**:
```
S: maquinario sem funcionar - [linha qual]
ou
S: máquina X com problema - [descrição curta]
```

Quando voltar:
```
F: maquinario voltou
ou
F: máquina X consertada
```

**Quem está na máquina parada também tem que reportar a próxima atividade**:
Enquanto a máquina não funciona, posta o que vai fazer no meio tempo:
```
S: enquanto máquina para, vou cortar silica
S: enquanto linha parada, vou organizar prateleira
```

Sem isso, o sistema acha que você sumiu durante a parada. Cada minuto que
passa sem report vira "não reportado" no admin.

**Quem reporta a próxima função enquanto a máquina parada**:
- Já era a pessoa que estava na máquina → ela reporta.
- Outras pessoas que estavam em cowork na linha → cada uma reporta sua
  próxima função.
- Quem não estava na linha → não precisa reportar (continua na atividade
  normal).

Esse padrão liga com:
- Regra 26 do sistema: `machine_downtime` é parada crítica — linha
  inteira pausa.
- Regra 31 do sistema: parada da linha afeta TODA a equipe que estava
  na linha — sistema marca cowork automaticamente em quem estava lá.

### 5b. Cowork (ajudando alguém)
Se você se junta a uma tarefa que **outra pessoa já começou**, o jeito mais
simples é mencionar a pessoa no seu start:
```
S: ajudando Vitor na linha de Potassium
```
Ou simplesmente:
```
S: linha de produção Potassium
```
A Carolina detecta que o Vitor já estava lá e te coloca como cowork.

### 5c. Troca de fase do mesmo produto
Cada fase é um registro separado. Exemplo, fazendo Melatonin:
```
S: mistura Melatonin           ← fase 1
F: mistura ok                  ← fecha fase 1
S: formulação Melatonin         ← fase 2 (automaticamente entende próxima fase)
F: formulação 8kg              ← fecha fase 2 com qty
S: encapsulação Melatonin       ← fase 3
F: 950 cápsulas                ← fecha fase 3 com qty
```
Ou mais curto — só `S:` pra próxima fase já fecha a anterior automaticamente.

### 5d. Almoço (F implícito)
Se você posta `S: almoço` 12:30 e depois `S: linha de produção` 13:30, a
Carolina fecha o almoço sozinha às 13:30 (regra **F implícito**). **Não
precisa postar `F: almoço` separado**.

### 5e. Esqueceu de fechar (F)
Se você foi embora sem postar `F:`, o sistema fecha sozinho às 21:00 NY
(fim do expediente padrão) com aviso. Isso fica registrado como "auto-close"
no admin, então **tenta sempre postar o `F:` final** pra evitar warning.

---

## 6. O que acontece com o que você posta

1. Mensagem entra na fila — alguns segundos.
2. Carolina lê e classifica (qual atividade, qual produto, qual fase).
3. Vira registro em `v3.events` (linha do tempo).
4. Aparece no `/dashboard-v4` (Bruno/Henrique veem o dia montado em tempo real).
5. Se a Carolina não tem certeza → marca como `uncertain=true` e o admin
   confere/corrige depois.

**Privacidade**: tudo que você posta no canal `#orders-and-inventory` é
público pra equipe e pros admins. Conversa pessoal vai em DM, não no canal.

---

## 7. Quem é admin (não posta tarefa de produção)

- **Bruno Camp** (dono) — supervisão
- **Thassio** (dono) — supervisão
- **Henrique** (gerente) — operação + supervisão

Esses 3 não geram registro de produção quando postam — o sistema entende que
são intervenções/instruções. Operadores (Vitor, Simone, Ana, Bruno Sarmento)
são os que postam trabalho real.

---

## 8. Dúvidas?

Manda pro **Bruno Camp** ou abre uma issue no projeto. Esse guia vai virar
parte do treinamento futuro da Carolina autônoma — então quanto mais claro
ficar pra vocês, mais ela aprende a ser claro pra todo mundo.

---
*Última atualização: 2026-05-29 noite · adicionado seção 5a-bis (máquina parada — instrução Bruno Camp msg721 16:59 PM).*
