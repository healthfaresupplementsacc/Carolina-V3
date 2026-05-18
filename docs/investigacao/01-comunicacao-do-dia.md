# 01 — Comunicação do dia (18 Mai 2026, ET)

Fonte: tabela `messages`, dump read-only em `_raw/messages_today.json` (57 linhas).
Janela: 00:00 ET → coleta às ~16:41 ET. **EVIDENCIADO** salvo nota.

## 1.1 Canal de produção (C09UNBXFRKK)

Contas Slack vistas hoje (EVIDENCIADO por `user_id`):
- `U07FG34TMPF` → conta da **Simone** (mapeada no parser).
- `U08JC85HMNE` → conta mapeada como **Vitor** no parser, **MAS usada pelo Bruno** o dia inteiro (textos assinados "- Bruno", "Bruno- voltei"). Ver doc 03/08.
- `U0AU8N8FA00` → PC compartilhado de chão ("Production Line"); exige prefixo "Nome-". Ana usa esse.
- `U0B3EQLPEPL` → reagiu ✅ **uma única vez** (ts 1779112687). NÃO é a Carolina (bot = `U09DQGJ1ES3` em config). Provavelmente Henrique/manager humano. **ACHISMO** quanto a quem é.

| ET | conta | autor (texto) | texto cru | parsed_type | edição | reaction |
|----|-------|---------------|-----------|-------------|--------|----------|
| 09:35 | Simone | Simone | "Bom dia,\nS- iniciando a impressao das 502 ordens" | orders_start | — | — |
| 09:45 | Vitor-acct | — | "Bom dia!" | ignore | — | — |
| 09:46 | PC | Ana | "Ana- Bom Dia <@U085…> qual e pra passar primeiro…" | unknown | — | — |
| 09:47 | PC | Ana | "Ana- os dois ja estao revisados !" | unknown | — | — |
| 09:48 | PC | Ana | "Ana- O Vitor vai ajudar ela dia de segunda…" | unknown | — | — |
| 09:55 | Vitor-acct | Vitor | "S: Iniciando ajuda nas ordens" | orders_start | — | — |
| **09:58** | Vitor-acct | **Bruno** | "S-Plant 0134 - ( para ca[psulas)- Bruno" | start | **editado** (era "S-Potassium 0134…") | ✅ U0B3EQLPEPL |
| 10:00 | Vitor-acct | Bruno | "S-Potassium rodando - Bruno" | start | — | — |
| 10:02 | Vitor-acct | Bruno | "S-, Bruno, Ana na linha de producao" | start | — | — |
| 10:14 | Simone | Simone | "F- impresssao das ordens" | orders_finish | — | — |
| 10:14 | Simone | Simone | "S- colocando as label das ordesn nos envelopes" | start | — | — |
| 10:21 | Vitor-acct | (prefixo Ana-) | "Ana-\nS: linha de producao Rutin" | start | — | — |
| 10:36 | PC | Ana | "Ana-\nN: liha parada por conta da label…" | note | — | — |
| 10:36 | PC | Ana | "Ana-\nN; ja ligamos novamente" | note | — | — |
| 11:29 | Simone | Simone | "S- iniciando a segunda impresao ordens - 32" | orders_start | — | — |
| 11:43 | Simone | Simone | "F- finalizada a segunda impressao das ordens" | orders_finish | — | — |
| 11:46 | PC | Ana | "Ana-\nN: COLOCANDO OUTRA LABEL MAQUINARIO PARADO" | note | — | — |
| 12:14 | PC | Ana | "Ana-\nN: paramos a linha duas vezes…ja finalizamos o Rutin" | note | — | — |
| **12:15** | PC | Ana | "**Ana_**\nF: linha de producao do Rutin 0138" | **unknown** (separador `_`) | — | — |
| 12:22 | PC | Ana | "Ana-" | ignore | — | — |
| 12:22 | PC | Ana | "Ana-\nS:LIMPEZA" | start | — | — |
| 12:38 | Vitor-acct | Bruno | "F: Finalizado ajuda nas ordens" | orders_finish | — | — |
| 12:40 | Vitor-acct | Bruno | "S: Iniciando Double Check Rutin e fechando as caixas" | start (multi-ação) | — | — |
| 12:46 | PC | Ana | "ANA-\nF: LIMPEZA" | finish | — | — |
| 12:57 | PC | Ana | "Ana-\nS; linha de producao Acido Hyaluronic 0139" | start | — | — |
| 13:02–13:35 | PC | Ana | 4× "N: linha parada / ligando / outra label" | note ×4 | — | — |
| 13:39 | Simone | Simone | "F- ordens finalizadas" | orders_finish | — | — |
| 13:41 | Simone | Simone | "Pausa para almoco" | pause_start | — | — |
| 13:44 | Vitor-acct | Bruno | "F: Double check e fechamento das caixas" | finish | — | — |
| 13:54 | Vitor-acct | Bruno | "F-Plant-0134 ( em capsulas )- Bruno" | finish | — | — |
| 13:56 | Vitor-acct | Bruno | "S-Plant-0135(para capsulas)-Bruno" | formulation_start | — | — |
| 13:57 | PC | Ana | "Ana-\nF; linha de producao Acido Hyaluronic 0139" | finish | — | — |
| 14:01 | PC | Ana | "Ana-\nS; limpeza" | start | — | — |
| 14:13 | Vitor-acct | Bruno | "S-Revisando Plant-0134 ( Linha de producao )-Bruno" | start | — | — |
| **14:22** | Simone | Simone | "**retorno almoco**" | **pause_start** (deveria ser pause_end) | — | — |
| 14:23 | Simone | Simone | "S- revisao Plant" | start | — | — |
| 14:24 | PC | Bruno | "Bruno - Indo almocar agora" | pause_start | — | — |
| 14:25 | Vitor-acct | Bruno | "S: Assumindo formulacao" | formulation_start | — | — |
| 14:27 | PC | Ana | "Ana-\nF; limpeza" | finish | — | — |
| 14:28 | PC | Ana | "Ana-\nparada para o almoco" | pause_start | — | — |
| 14:40 | Vitor-acct | Bruno | "S: Revisao Plant (0134)" | start | — | — |
| 14:48 | Simone | Simone | "S - linha de producao" | start | — | — |
| 15:08 | Vitor-acct | Bruno | "Bruno- voltei do almoco" | pause_end | — | — |
| 15:09 | Vitor-acct | Bruno | "S- Manutencao do Potassium" | start | — | — |
| 15:09 | PC | Ana | "Ana- Voltei" | pause_end | — | — |
| 15:10 | PC | Ana | "Ana-\nS: linha de producao" | start | — | — |
| **15:10** | Vitor-acct | Bruno | "**F: Formulacao e revisao parcial Plant (0134)**" | **formulation_start** (texto diz "F:" = finish) | — | — |
| 15:11 | Vitor-acct | Bruno | "Parando pro almoco" | pause_start | — | — |
| **15:20** | Vitor-acct | Bruno | "Bruno- Retornando a revisao do Plant-0134" | **unknown** | **editado** (era "…Potassium…") | — |
| 15:26 | Simone | Simone | "S- ajudando na revisao do Plant para a linha…nao parar" | join_producao | — | — |
| 15:56 | Vitor-acct | Bruno | "Retorno Almoco" | pause_start (deveria ser end) | — | — |
| 16:18 | PC | Ana | "Ana_\nN; linha parada estamos arrumando a maquina de bottle" | unknown (sep `_`) | — | — |
| 16:21 | PC | Ana | "Ana -\nN; voltando para a linha" | pause_end | — | — |
| 16:41 | Vitor-acct | Bruno | "S: Ajudando revsao Plant" | start | — | — |

## 1.2 App Home (slack/home.js)

Não há tabela dedicada de "evento App Home". Evidência indireta:
- `operator_notes` id=2 `source='app_home'`, operator_id=3 (Vitor), `linked_phase_instance_id=538`, texto "Ajuda no packing", 16:46 (`_raw/operator_notes_today.json`). **EVIDENCIADO**: 1 nota veio do App Home.
- `ad_hoc_task_instances` id=42 `task_name='Outro'`, `started_by_operator_id=1` (Ana), notes 'limpeza', 14:00 — sem coluna `source`; origem inferida App Home (doc 09). **ACHISMO** parcial.
Botões/wizards e quem confirmou cada um **não são auditados** em tabela própria → não rastreável além disso. Ver doc 04/11.

## 1.3 Admin chat (C0B36DR5MP1)

**EVIDENCIADO:** o dump `messages_today` filtra `channel_id` e retornou **0 linhas** com `channel_id='C0B36DR5MP1'` (todas 57 são `C09UNBXFRKK`). O canal admin não é gravado em `messages`. Tool-calls/results da Carolina **não são persistidos como mensagens**; só efeitos colaterais aparecem em `admin_audit_log` (37 linhas hoje) e `silent_log`. Ver doc 06.

## Observações desta parte
- `was_edited`/`previous_text` confirmam **2 edições** que viraram dado novo: ts 1779112687 (Potassium→Plant, 09:58) e ts 1779131989 (Potassium→Plant, 15:20).
- **Apenas 1 reaction** o dia inteiro, de conta humana, não-Carolina. Carolina não reagiu a nada (doc 06).
- Limite: a coleta pegou até ~16:41 ET; mensagens após o horário da coleta não estão aqui.
