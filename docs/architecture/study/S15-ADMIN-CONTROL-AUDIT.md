# S15 · Auditoria página por página: a seção Estoque do dashboard · 2026-09-10

Por que este documento existe: o Bruno perguntou se eu tinha estudado a fundo cada subpágina e se o
desenho era "o mais inteligente possível". A resposta honesta foi **não** (o estudo anterior,
`S15-ADMIN-CONTROL-STUDY.md`, leu estrutura e tirou 5 screenshots de tela inicial). Este documento é
o estudo feito com método:

1. **Gabarito** que não é a minha opinião: `A3-industry-patterns.md` (Salesforce OCI + WMS genérico)
   e o desenho original `S15-WAREHOUSE-STUDY.md` §3-6.
2. **Cada página percorrida no browser real** (login admin, 1440x900), até a tela de confirmação de
   cada fluxo, **sem salvar nada** (quantidade não se mexe). 30 screenshots em
   `img/S15-admin-2026-09-09/` (h* = hub, p* = demais páginas, d* = painel do produto).
3. **Código lido inteiro** nos pontos de decisão: `ActionModal`, `ProductPanel`, `SimpleCell`,
   `simple-set.js`, `load.js`, `StockService.adjust/_insertMovement`, `stock_movements`, rotas.
4. Banco de produção consultado (universo de produtos, snapshots da Veeqo).

Conflito declarado: eu desenhei estas páginas. Por isso o gabarito externo e os defeitos numerados.

---

## 0. Veredito em uma frase

**A arquitetura por baixo é sólida (nota 4/5); a superfície de controle do admin não é "a melhor
possível" (2,5/5); e o sistema NÃO está pronto para a carga física (2/5) por três riscos de
integridade que precisam ser fechados antes de qualquer número entrar.**

O que está certo e é melhor que a média de armazém pequeno: porta única de escrita (`StockService`),
livro append-only com idempotência, reserva automática por pedido aberto, drift contínuo que alerta
e nunca sobrescreve, dedução em dry até a carga, SKU pai = garrafa física, modal em dois passos com
prévia dos números, modo simples idempotente que cria os locais sozinho.

O que não está: fragmentação (3 lugares para criar caixa, 2 para calibrar peso, 2 portas de carga
com semânticas diferentes, 7 itens de menu), ausência dos primitivos de controle que um sistema de
estoque de verdade tem (códigos de motivo, ajuste = contagem × esperado, desfazer, ator do admin no
livro, permissão por pessoa, notificação dirigida), e três riscos de dado.

---

## 1. Os três riscos que bloqueiam a carga (fechar ANTES do mutirão)

**R1 · O alvo da Veeqo some.** Cache em memória alimentado por `listSellables()` (5 páginas, timeout
20 s). No Railway estoura com frequência; enquanto vazio, as 110 linhas mostram "sem Veeqo" (h01).
`v3.veeqo_snapshots` já tem o estoque por SKU a cada 6 h e não é usado. Sem alvo, o modo simples e o
Montar viram "digite qualquer coisa".

**R2 · Importar da Veeqo dobraria e sujaria o estoque.** O modal (h10) traz **345 "[125 Test Strips]
Feminine pH Checker"** e **"Ice Pack"** como garrafas (kind errado), e o passo 3 do Montar pede para
carregar **POTA-130-C3 "faltam 6.670"**: cinco casepacks ainda são produto RAIZ (`#103 FOTI-1000-C2,
#54 PANT-500-C2, #57 POTA-130-C3, #62 STIN-7500-C2, #67 VTB2-180-C2-WFS`), o que conta a mesma
garrafa duas vezes (a Veeqo deriva o kit da base). Regra do Bruno: uma linha por garrafa física.

**R3 · "Juntar SKUs" sugere fusões erradas com "confiança alta".** A sugestão usa só o código de barras
igual. Dado real: `HF-LITH-5 Lithium Orotate` e `HF-MELA-5 Melatonin Berry 5mg` compartilham o UPC
850054045478; `Vitamin B2 180` e `Vitamin B2 400mg` compartilham 850031157378 (h11). São produtos
diferentes com UPC repetido na Veeqo. Um clique em "Juntar" funde produtos distintos = desastre de
envio (memória merge-safety-rules: fundir só com o MESMO NOME). O rótulo "confiança alta" está errado.

---

## 2. Auditoria por página

Notas: 5 = faria assim num sistema sério · 3 = funciona, com atritos · 1 = atrapalha.

### 2.1 Estoque (hub) · modo simples · nota 3
O que é: uma linha por produto, Veeqo · Prateleira · Caixa · A organizar · Confere, célula editável
(quantidade ABSOLUTA por escopo; cria prateleira/caixa "de casa"; idempotente por uuid).
- D1 Alvo some (R1).
- D2 Primeiro salvamento em cada produto exige digitar um **código de prateleira** (`askBinCode`,
  h01): 110 vezes no mutirão. Existe `suggestBinCode`; deveria vir preenchido e só pedir confirmação.
- D3 Chip "sem Veeqo" em todas as linhas quando o cache está vazio; "0 batendo com a Veeqo" conta
  como "batendo" produtos com 0 dos dois lados (13) — vaidade, não sinal.
- D4 Sem "Salvo por quem/quando" na linha; sem histórico visível do que o mutirão já fez.
- Certo: ordem por nome (ordem da prateleira), busca no servidor, retry seguro.

### 2.2 Estoque (hub) · modo completo · nota 2
- D5 "Precisa de atenção hoje": **185 alarmes para 110 produtos** (ZERADO + VEEQO DIFERENTE por
  produto), Disponível −166, "APPL-3200 negativo" (h08/h09). Alarmes verdadeiros no papel, inúteis
  antes da carga; não existe estado "não carregado".
- D6 Vocabulário misto nos chips de status: `negative`, `out` (inglês) ao lado de `Veeqo diferente`,
  `sem local` (h09).
- D7 "Dias de estoque" mostra 45 / 50 / 17 com total 0 (h09): o número vem de outra base (vendas
  7 d ÷ disponível negativo?) e ninguém sabe o que significa. O plano mestre já apontou duas
  definições (D-6).
- D8 Veeqo negativa (−5) exibida como alvo (AKKE-300, NAD): erro de dado da Veeqo virando meta nossa.
- Certo: KPIs viram filtro; ordenação no servidor; vista salva na conta.

### 2.3 Estoque (hub) · modal de ações (`ActionModal`) · nota 2,5
Verbos: Entrada · Organizar · Mover · Ajustar · Separar · Devolução.
- D9 **Ajustar = delta com sinal ("+ entra, − sai") e motivo em texto livre.** Gabarito: ajuste é
  "esperado X, contado Y" com **código de motivo** (contagem, dano, amostra, erro de registro…) e o
  delta calculado. Do jeito atual, sinal invertido é um erro silencioso e motivo livre não gera relatório.
- D10 Ajustar sem local cai em "A organizar": mistura correção com organização.
- D11 **Entrada não tem origem** (produção/lote, compra, transferência, importação). O livro grava
  `store_in` sem saber por quê; não dá para separar recebimento de correção. Ironia: `load.js` do
  Montar TEM as origens (`count_manual`, `count_weigh`, `production_direct`, `loose_fixed`); o hub não.
- D12 **Devolução existe duas vezes**: ação própria e motivo `return` dentro de Separar (código idêntico).
- D13 **Não existe Saída** (amostra, uso interno, extra em pedido, transferência, descarte). Só cabe
  em "Ajustar −N", que é verbo de correção. É o buraco do shrinkage.
- D14 **Não existe Contar** para o admin (o `StockService.count` existe; só o kiosk usa).
- D15 Motivos de Separar (`rótulo ruim`, `sem lacre`, `outro`, `devolução`) são os únicos códigos de
  motivo do sistema inteiro.
- Certo: dois passos com prévia "como fica" (h04); textos de ajuda por verbo; nada de SQL cru.

### 2.4 Estoque (hub) · painel do produto (7 abas) · nota 3
- D16 **Aba Movimentos: "Quem" fica "—" para toda ação do dashboard.** O router grava
  `person_id = login.person_id` (null para Admin e Henrique) e esconde o nome do login dentro da
  `note` como "[Admin] …". O livro não sabe quem, entre os admins, fez o quê. Só o `audit_log` sabe.
- D17 Movimentos sem motivo, sem referência (pedido/lote), sem "desfazer".
- D18 Aba Config linka "Editar Veeqo (página antiga)" — vazamento das páginas aposentadas.
- D19 Aba Família tem "Mesclar produto neste" a dois cliques, sem a regra de mesmo nome (R3).
- Certo: 6 números no cabeçalho; Pedidos abertos mostra a reserva de verdade; Separadas com resolução.

### 2.5 Estoque (hub) · Importar da Veeqo · nota 2 (por R2)
Lógica boa (delta > 0 entra em A organizar, < 0 nunca desconta, prévia com totais, h10). Mas o
universo importado está errado (R2). Também: "+6.819 garrafas" na prévia, quando o total bottle é 17.413:
o número muda conforme o filtro do momento e ninguém explica a diferença.

### 2.6 Montar estoque · nota 2,5
- D20 Passo 1 apresenta **peso de 110 produtos como o começo do trabalho** ("dê a cada produto o
  peso"), quando é opcional e só compensa nos ~18 produtos com 500+ (p04/p06). A barra "0 com peso"
  reforça a ideia de pré-requisito.
- D21 Passo 3 "faltam acertar (75)" liderado por casepack (R2).
- D22 **Duas portas de carga com semânticas diferentes**: `POST /load` (soma um delta ao local) e
  `POST /simple/set` (define o ABSOLUTO do escopo). Contar duas vezes pelo Montar duplica; pelo
  simples, não. O operador não tem como saber qual está usando.
- D23 Cria caixa aqui, no Locais e no modo simples (3 lugares); calibra peso aqui e no Product Setup (2).
- Certo: 4 origens de entrada; balança híbrida; "contar na mão OU pesar" lado a lado; tipo de caixa
  com tara aprendida (decisões do Bruno de 22/08 estão implementadas).

### 2.7 Aprovações · nota 3
Fila só do operador; histórico; chips de idade. D24: não recebe propostas de ninguém do dashboard
(tudo aplica direto); D25: sem "desfazer" nem registro de reversões; D26: sem notificação dirigida.

### 2.8 Locais · nota 3,5
Assistente em massa correto (A01A1…A08C4, p08), taras padrão, desativar em vez de apagar. D27: bin
exige produto (1 produto por bin) já no cadastro, o que obriga a decidir o mapa antes de contar; D28:
tara/capacidade por prateleira é nível avançado que ninguém vai preencher agora.

### 2.9 Etiquetas · nota 4
Faz uma coisa e faz bem (Code128 + QR, 4x6, carimbo de impressão). Não precisa ser item de menu.

### 2.10 Product Setup · nota 2,5
- D29 **309 produtos** aqui contra **110** no hub (p11): inclui planos, medicamentos, insumos e
  casepacks-filhos como linhas próprias com apelido ("CHAR-1200-C2-C4"). "170 sem nickname" aqui,
  "101 com apelido" lá: o mesmo conceito medido em universos diferentes.
- D30 Mistura catálogo (nome, tipo, SKUs) com configuração do rodapé de etiqueta (cor, tiers).
- D31 Calibrar peso duplicado com o Montar.
- Certo: sugestão de apelido pela regra strip-HF; SKUs por canal; validade do rótulo.

### 2.11 Configurações · nota 1,5
É configuração de **embalagem e impressão** (envelope por cor, mistura, suprimentos; p13). A seção
"Inventário e estoque" diz "não construído". Está no menu de Estoque sem ser de estoque.

### 2.12 Usuários & Acessos · nota 2 (para o que o Bruno pediu)
Matriz **perfil × função**; login herda perfil; sem função por pessoa. D32 (SEGURANÇA, fora do
estoque): a página mostrou "Sem acesso" (p17) porque o PIN `510510` que eu usei **é o PIN do login
Henrique (manager)** — e `510510` é também o PIN mestre de emergência padrão do código
(`ADMIN_PIN` não está definido no Railway). Quem tem o PIN do Henrique tem, nas rotas que usam o
padrão (`op.js` adminPin, legado `checkPin`, emergência do `/api/v3/data`), acesso de dono. Corrigir
fora deste plano: definir `ADMIN_PIN` no Railway com valor próprio e trocar o PIN do Henrique.

### 2.13 Transversal
- D33 Sem códigos de motivo (exceto Separar). D34 Sem desfazer. D35 Notificações globais (todo
  mundo vê tudo). D36 Ator do admin ausente no livro (D16). D37 Vocabulário EN/PT misto. D38 Três
  contagens de "produto" (110 / 309 / 261 variantes Veeqo) e duas de "dias de estoque".

---

## 3. Contra o gabarito (A3), ponto a ponto

| Padrão da indústria | Aqui | Situação |
|---|---|---|
| Quantidade = soma de movimentos; nunca digitada por cima | Sim (StockService, livro) | ✅ |
| Reserva ao abrir o pedido, libera ao enviar | Sim (pnp_order_lines) | ✅ |
| Hold/quarentena fora do vendável | Separadas | ✅ |
| Idempotência por chave externa | Sim | ✅ |
| Reconciliação com o canal, alerta, nunca sobrescreve | Drift 10 min | ✅ |
| **Ajuste = pedido com motivo codificado + aprovador → movimento** | Delta livre, aplica na hora | ❌ D9 |
| **Todo movimento com ator, motivo, referência** | Ator ausente p/ admin; sem motivo/ref | ❌ D16/D17 |
| Recebimento com origem (lote/PO) | Só no Montar, não no hub | ⚠ D11 |
| Saída codificada (amostra, uso interno, baixa) | Não existe | ❌ D13 |
| Contagem cíclica com variância → pedido de ajuste | Só kiosk; sem ciclo | ⚠ D14 |
| Operador cria fatos; gestão cria decisões | Dashboard: tudo é decisão direta | ❌ D24 |
| Reversão auditada | Não existe | ❌ D34 |
| Ponto de reposição / estoque de segurança por SKU | thresholds "não construído" | ⚠ |
| Tela principal: 6 números que não se digitam | Sim (painel) | ✅ |
| Alertas com estado "não carregado" / sem ruído | 185 alarmes para 110 produtos | ❌ D5 |

---

## 4. O que muda na proposta (revisão do estudo anterior)

A proposta anterior (funções por pessoa, três verbos + Desfazer, Pendências, menu de 4, recebimento
da produção) continua de pé. A auditoria acrescenta uma **fase zero de integridade** que vem antes de
tudo, e corrige dois pontos do desenho:

**Fase A · Integridade antes da carga (S, sem mexer em quantidade)**
1. R1 alvo Veeqo: snapshot no boot + timeout 60 s + selo de idade.
2. R2 catálogo: `kind` dos não-garrafa (Ice Pack, test strips, planos) + parentear os 5 casepacks raiz
   + títulos limpos. Um universo só: 110 (ou o que sobrar) em todas as páginas.
3. R3 Juntar SKUs: código de barras igual = "verificar", nunca "confiança alta"; fusão exige mesmo
   nome (regra existente); confirmação mostra os dois nomes lado a lado.
4. D16 ator: o livro guarda `actor_login_id`/nome do login, não só `person_id`.

**Fase B · Primitivos de controle (M)**
5. Códigos de motivo únicos para o sistema (entrada: produção/lote, compra, transferência, importação,
   correção; saída: amostra, uso interno, extra em pedido, transferência, descarte; ajuste: contagem,
   dano, erro de registro). Uma tabela, usada por hub, kiosk e Montar.
6. Ajustar vira **Contar** ("esperado X · contado Y · motivo"), delta calculado. Some o sinal.
7. Entrada com origem (reusa as 4 do `load.js` + lote). Saída (novo). Devolução só como motivo.
8. Desfazer 24 h (movimento inverso ligado ao original). Funções por pessoa + Propor → proposta.
   Notificação com destinatário por função.

**Fase C · Uma porta (M)**
9. Uma única porta de carga (`simple/set`, absoluto); `load.js` vira o caminho "pesar" dentro dela.
10. Caixa nasce num lugar só; peso calibra num lugar só (Produtos).
11. Menu 7 → 4; Montar dentro do hub com barra de progresso; estado "não carregado"; Configurações
    de embalagem vai para Impressão/P&P.
12. Vocabulário: chips em português; "Dias de estoque" com uma definição só e tooltip com a conta.

Depois: mutirão (2 pessoas × 2 tardes), recebimento da produção, dedução ao vivo.

---

## 5. O que eu não consegui verificar
- Fluxos com dados reais (não há estoque carregado; não mexi em quantidade). A auditoria é de código
  + navegação até a confirmação; o comportamento com 17 mil garrafas dentro (paginação, lentidão do
  overview, drift em massa) só se vê depois da carga.
- O kiosk do operador (fora do escopo pedido).
- O `can()` do cliente com o login Admin de verdade (testei com o PIN de emergência).
