# Etiquetas de envio — COMO VAMOS IMPRIMIR (plano consolidado, 2026-08-28)

Bruno: "we need to go back planning how our labels will be printed, this is critical and we need to figure out asap to be able to start". Este doc junta TUDO que foi decidido, descoberto e construído sobre imprimir etiqueta de envio, e o que falta decidir pra começar.

## O que já existe EM PRODUÇÃO (construído e testado)

1. **Lote com rodapé (o caminho principal).** Central de P&P → botão "Imprimir etiquetas de envio (N)": o servidor baixa os PDFs da Veeqo, carimba o rodapé (apelido, local, garrafas, envelope, picker/packer), agrupa por produto com folhas divisórias e abre UM PDF. "Já imprimi" carimba `printed_at`. (`src/v3/shipping-labels/service.js`, Fase 2 no ar desde 08-19.)
2. **Fila de impressão** (`v3.print_queue`, S15.34): celular/admin manda job, a estação puxa. Base pronta pra qualquer impressão disparada de fora.
3. **Vigia de custo (freight-watch v2, S04.40):** cada etiqueta comprada é julgada em minutos contra a mediana do estado; alerta agrupado no admin-orin DENTRO da janela de estorno (deletar envio na Veeqo = reembolso automático, só até o SCAN form do dia). Card Frete na página P&P.
4. **Rate Shopping API da Veeqo FUNCIONA com a nossa chave** (`POST /shipping/api/v1/rates`, header `x-api-key`): cota todas as tarifas por pacote/destino. Provado em 08-28.

## O que foi DESCOBERTO esta semana (muda o desenho)

- **A Simone já compra o mais barato válido**: 8/8 outliers cotados de novo já eram a melhor tarifa legítima disponível. Media Mail/Bound Printed Matter aparecem mais baratas mas NÃO valem pra suplemento (restritas a livros/mídia).
- **Dimensões na Veeqo: ZERO produtos têm** (0 de 100; nenhum shipment usa). MAS teste provou que dimensão NÃO muda o preço nos nossos tamanhos: não é a causa do excesso. Não mandar ninguém cadastrar 110 dimensões.
- **Peso é o que muda o preço** (4oz $5.40 → 8oz $5.82 → 1lb $6.64) e os pesos declarados são TEMPLATE (113,4g/226,8g exatos). Risco real: reajuste retroativo na fatura da transportadora. Conserto: pesos reais virão da calibração do Montar estoque → corrigir na Veeqo.
- **Excesso de frete medido**: $572/30d (v2 por estado). Causa NÃO é escolha de serviço nem dimensão; próximo passo parado: comparar cotação CEP-a-CEP vs pago no mesmo dia pra achar o acréscimo.
- **Veeqo nativo no label**: dá pra ligar "SKU on label" (até 3 SKUs+qtd no 4x6, 30 chars/linha) = rede de segurança pra etiqueta que escapar do nosso fluxo. Local/apelido/envelope NÃO dá nativo (bin só no packing slip 8.5x11; custom message é texto fixo).
- **Alerta de custo só aconselha "deleta e recompra" quando a cotação PROVA que existe alternativa válida mais barata** (senão diz "já era o melhor preço"): pendente de implementação no freight-watch (v3).

## O DESENHO (decidido em 08-27, pendente de 3 respostas do Bruno)

**Lote diário continua sendo o principal** (agrupado por produto = o jeito que o pick funciona). Em cima dele:

1. **Vigia de 60s na Central** (ela já fica aberta o dia todo): etiqueta comprada depois do lote → banner "N etiquetas novas desde a última impressão" + botão que imprime SÓ as novas, carimbadas. Etiqueta perdida deixa de existir por construção (nada de esperar fim de dia).
2. **Zero cliques (opcional, grátis): Chrome `--kiosk-printing`** no computador do P&P → `window.print()` imprime direto na impressora padrão, sem diálogo. Lote e retardatárias saem sozinhas; "Já imprimi" vira automático. Configuro remoto (atalho novo do Chrome).
3. **Toggle nativo da Veeqo "SKU on label"** ligado (Bruno, no painel) = qualquer etiqueta que escapar sai pelo menos com SKU+qtd.
4. **Freight-watch v3**: cotar antes de aconselhar (Rate Shopping API), texto só manda recomprar quando há alternativa válida.

**Etapa 2 (endgame, depois que o fluxo acima rodar):** comprar a etiqueta PELO nosso sistema (a Rate Shopping API também faz booking/cancel/scan form) — regra "a mais barata válida que chega até o due_date" vira código, e o handoff Veeqo→sistema deixa de existir. Grande; só depois do básico rodando liso.

## As 3 decisões que destravam o começo (Bruno)

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Em QUAL computador roda a Central do P&P e qual é a impressora 4x6 padrão dele? (Simone .246?) | confirmar → eu configuro o kiosk remoto |
| D2 | Retardatárias: imprimir sozinhas na hora, ou banner + 1 toque? | banner na 1ª semana, auto depois |
| D3 | Dia da virada: a partir de quando o dia inteiro imprime pelo nosso sistema (Veeqo vira fallback)? | próxima segunda |

## Onde está cada coisa

- Código: `src/v3/shipping-labels/`, `src/v3/print-queue/`, `src/workers/freight-watch.js`, `src/v3/freight/` (tudo em `v3-reset` no GitHub)
- Docs: ARCHITECTURE.md §2; índice S15.34/S04.40; este plano
- Obsidian: [[P&P — Shipping labels, pick list & TikTok (design + status)]] (histórico), [[Frete — desperdício real vs zona (28-08)]], Build log 08-28, e a cópia deste plano
- Memória: `shipping-label-footer`, `freight-cost-watch`, `envelope-sizes`
