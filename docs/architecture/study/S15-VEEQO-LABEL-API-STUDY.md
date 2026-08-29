# Comprar e imprimir etiquetas PELO SISTEMA via API da Veeqo — estudo (2026-08-29)

Bruno: "vamos logo entao trabalhar em conectar o Veeqo pelo API pra gente conseguir realmente imprimir os labels pelo sistema, faz um estudo de como seria a melhor opcao tomando em conta que eh sempre impresso do pc da simone".

## Os blocos, todos VERIFICADOS (doc oficial + teste real na conta)

| Bloco | Endpoint | Status |
|---|---|---|
| Cotar tarifas | `POST /shipping/api/v1/rates` (header `x-api-key`) | **TESTADO 08-28 na nossa conta, funciona** — todas as tarifas com preço e `delivery_estimate` |
| Comprar etiqueta | `POST /shipping/api/v1/shipments` com `rate_id` da cotação | doc: resposta traz **`label_content` (base64 PDF/ZPL/PNG/JPEG)**, `tracking_number`, `total_charge` |
| Marcar enviado + tracking no canal | `POST /shipments` (API principal) com `order_id` + `allocation_id` + `tracking_number_attributes` + `update_remote_order: true` | doc: marca enviado e sincroniza o canal |
| Amazon (Buy Shipping) | book com `is_amazon_order: true` + `channel_items` | doc: sincroniza Seller Central sozinho e **mantém as proteções do Buy Shipping** |
| Estornar | `DELETE cancel-shipment` | doc (reembolso automático de etiqueta não usada, até o SCAN form) |
| SCAN form | `POST create-scan-form` (+ reprint, história, unmanifested) | doc — **substitui o plano do browser-agent** (memória usps-scan-form-automation) |

O ciclo inteiro fecha num fornecedor só, mesma conta e billing de hoje, sem terceiros.

## O desenho recomendado

FLUXO POR ENVIO (não-Amazon primeiro):
1. Pedido já espelhado (veeqo-order-sync → `pnp_order_lines`).
2. **Cota na hora da compra** (cotação expira; cotar imediatamente antes do book). Filtro fixo: NUNCA Media Mail / Bound Printed Matter / Library Mail (restritas a livros/mídia; suplemento não pode). Escolha: **a mais barata válida cujo `delivery_estimate` <= due_date**; sem due_date → a mais barata válida.
3. **Compra** (`label_format: PDF` 4x6; avaliar ZPL direto na térmica na fase 2).
4. **Marca enviado na Veeqo** (`update_remote_order: true`) → tracking sobe pro canal. `carrier_id` 3 "Other" quando o carrier não mapear.
5. **Carimba o rodapé** (código existente: apelido, local, garrafas, envelope, picker/packer) e **enfileira** na print-queue.
6. **Imprime na .246 (PC da Simone)** via agente dedicado. Sem clique.
7. Fim do dia: **SCAN form via API** (um botão, ou automático após a última do dia).
8. Alerta de custo (freight-watch) ganha **"estornar"** de 1 clique: cancel-shipment + recompra.

## A impressão no PC da Simone (.246): agente, não navegador

**`HF-PrintAgent`** — PowerShell + SumatraPDF portátil (`-print-to "<impressora 4x6>" -silent`), poll de 15s na nossa print-queue (com `x-print-token`; o PC sempre PUXA, o servidor nunca alcança a LAN — mesmo desenho do .28), imprime silencioso, marca `done`. Provisionado remoto via SSH/WMI que já temos na .246. **Lições do incidente de 25/08 aplicadas de nascença:** tarefa agendada SEM `ExecutionTimeLimit` (PT0S), restart on failure, e o heartbeat do agente entra no signal-watchdog (incidente automático se calar).

Por que agente e não Chrome `--kiosk-printing`: imprime com a Central fechada, com o navegador fechado, sem popup vivo. O kiosk fica como fallback documentado.

## Fases (cada uma utilizável sozinha)

- **FASE A — Copiloto (1 dia, zero risco):** nada muda na compra. A Central mostra por envio a cotação "melhor válida" vs o pago; freight-watch v3 cota antes de aconselhar (só manda recomprar quando a alternativa EXISTE). Valida cotação em volume real.
- **FASE B — Compra pelo sistema, canal piloto (2-3 dias):** botão "Comprar e imprimir" na Central para **HealthFare Website** (menor risco). 1 pedido → conferir tracking no canal → lote do canal inteiro. Depois eBay e Walmart.
- **FASE C — Amazon** via `is_amazon_order` + `channel_items`. Só depois da B rodar limpa 1 semana.
- **FASE D — SCAN form via API + estorno de 1 clique.**

## Incertezas honestas (validar na Fase B com 1 pedido real)

- **U-A:** `update_remote_order` comprovadamente sincroniza Amazon; para eBay/Walmart/Shopify a doc diz "integrated channels" sem listar — validar com 1 pedido de cada canal ANTES do lote.
- **U-B:** como o envio comprado via API aparece na UI da Veeqo (a Simone precisa continuar enxergando o dia dela lá como fallback).
- **U-C:** billing — confirmar na primeira fatura que a cobrança cai na mesma conta.
- **U-D:** peso declarado continua o do cadastro; corrigir com os pesos reais do Montar estoque (risco de reajuste retroativo já documentado).

## Alternativas descartadas

1. **Continuar comprando na Veeqo UI + esteira de impressão** (plano 08-27): resolve impressão, não resolve custo/controle; mantém o handoff. Vira fallback.
2. **Plataforma terceira (Pirate Ship/Shippo/EasyPost):** outra conta, sem sync de canal, perde Buy Shipping. Não.
3. **Rate Shopping API + mark-shipped (RECOMENDADA):** um fornecedor, conta única, canal sincronizado, Amazon suportado, estorno e SCAN form inclusos — e a regra "mais barata válida que chega no prazo" vira NOSSO código.

## O que destrava o início

- **D1 (Bruno):** nome da impressora 4x6 padrão na .246 (ou o agente lista e você escolhe).
- **Go da Fase A** (zero risco) e, quando quiser, **go da Fase B** com canal piloto.
