'use strict';
/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  REGISTRO-FONTE DE PROCESSOS (Bruno 07-28)                               │
 * │  ESTE É O CATÁLOGO ÚNICO de TUDO que roda no sistema: workers, crons,    │
 * │  watchdogs, bots e os processos da estação de impressão (.28).           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * POR QUE ISSO EXISTE: o Bruno cobrou (com razão) que eu perdia o track do que
 * estava rodando — "tem coisa que vc nem sabe se tá ativada". Sem uma fonte única,
 * cada mudança recente ficava dessincronizada. Este arquivo resolve isso:
 *
 *   • É a VERDADE do que DEVERIA existir. A página /admin de saúde cruza este
 *     registro com os heartbeats REAIS (v3.settings worker_tick_*) e com os sinais
 *     do .28 → mostra ligado/desligado, vivo/morto, verde/vermelho.
 *   • REGRA PERMANENTE (Bruno): SEMPRE que eu criar, mudar, consertar ou remover um
 *     worker/cron/bot/processo, EU ATUALIZO ESTE ARQUIVO NA MESMA HORA. Antes de
 *     mexer em qualquer processo, LEIO este arquivo pra saber o que já existe.
 *   • Campos por processo:
 *       key        — id estável (bate com o heartbeat worker_tick_<key> quando aplicável)
 *       name       — nome humano
 *       where      — 'railway' (nosso backend) | 'dotnet28'/'win28' (PC de impressão .28)
 *       short      — 1 linha: o que faz (pra bater o olho)
 *       detail     — explicação completa: o que faz, quando, por quê
 *       tickMs     — intervalo do loop (null = sob demanda / não é loop)
 *       heartbeat  — true se bate worker_tick_<key> (dá pra saber se está VIVO)
 *       staleMin   — minutos sem heartbeat pra considerar MORTO (só se heartbeat)
 *       enabledEnv — { var, offValue } que liga/desliga; enabled() calcula o estado
 *       critical   — true = se cair, alerta no admin-orin
 *       pending    — true = DESENHADO mas ainda não instalado (nunca vira alerta de
 *                    processo morto; está aqui pra ninguém redesenhar do zero)
 *       since      — data que entrou no ar (rastro histórico)
 */

// Helper: um processo está LIGADO por config? (lê o env na hora)
function _enabledByEnv(spec) {
  if (!spec || !spec.enabledEnv) return true;                 // sem gate → sempre ligado
  const { var: v, offValue, onValue, requires } = spec.enabledEnv;
  // requires: lista de envs que TÊM que existir (ex.: NGTECO_USER/PASS) senão o worker é no-op
  if (Array.isArray(requires) && !requires.every((r) => !!process.env[r])) return false;
  const cur = process.env[v];
  if (onValue !== undefined) return cur === onValue;          // liga só se == onValue (ex.: ='true')
  if (offValue !== undefined) return cur !== offValue;        // liga a menos que == offValue (ex.: !='false')
  return true;
}

const PROCESSES = [
  // ─────────────────────────── RAILWAY (backend) ───────────────────────────
  {
    key: 'observer', name: 'Observer (LLM)', where: 'railway', tickMs: 5000,
    heartbeat: true, heartbeatKey: 'observer_last_tick_at', staleMin: 3, critical: true, since: '2026-06',
    short: 'Lê o Slack e interpreta mensagens → eventos (quem fez o quê).',
    detail: 'Worker central do V4. A cada 5s pega mensagens novas do Slack, manda pro LLM (Gemini) classificar, e cria/fecha eventos, contagens, cowork, pausas. É o cérebro que transforma conversa em dados. SHADOW = roda sem postar decisões automáticas quando em modo sombra.',
  },
  {
    key: 'attendance', name: 'Ponto (NGTeco)', where: 'railway', tickMs: 60000,
    heartbeat: true, staleMin: 15, critical: true, since: '2026-07-22',
    enabledEnv: { var: 'WORKER_ATTENDANCE_ENABLED', offValue: 'false', requires: ['NGTECO_USER', 'NGTECO_PASS'] },
    short: 'Puxa batidas do relógio, marca chegada/almoço/saída, cobra ponto.',
    detail: 'A cada 60s lê as batidas do relógio NGTeco NG-TC2, atualiza att_state (checkin/almoço/saída), fecha tarefas no checkout autoritativo, e cobra quem esqueceu batida/checkout. TODO aviso de ponto passa pelo GATE que reconfere a batida ao vivo antes de mandar (07-27). Horário do relógio NUNCA vai pro canal do operador.',
  },
  {
    key: 'total', name: 'Total de produção', where: 'railway', tickMs: 30000,
    heartbeat: true, staleMin: 5, critical: true, since: '2026-07-27',
    enabledEnv: { var: 'WORKER_TOTAL_ENABLED', offValue: 'false' },
    short: 'Linha fechada sem total → conversa no Slack até ter o número ou escala.',
    detail: 'A cada 30s olha os followups abertos (linha de produção fechada sem quantidade). Lê a resposta do operador na thread, entende via LLM: número → registra o total; motivo sem número → insiste 1×; nada claro/silêncio → escala pro admin-orin. Garante que TODA linha termina com um total.',
  },
  {
    key: 'ems_sync', name: 'EMS activity sync', where: 'railway', tickMs: 45000,
    heartbeat: true, staleMin: 10, critical: false, since: '2026-07',
    enabledEnv: { var: 'WORKER_EMS_SYNC_ENABLED', offValue: 'false' },
    short: 'Sincroniza atividade das máquinas via API do EMS (read-only).',
    detail: 'A cada 45s lê a API de produção do EMS pra saber o que as máquinas estão fazendo e cruzar com presença real. Toda auto-task do EMS é tratada como suspeita — presença real ignora ems_auto.',
  },
  {
    key: 'veeqo_orders', name: 'Veeqo order sync (estoque)', where: 'railway', tickMs: 300000,
    heartbeat: true, staleMin: 20, critical: false, since: '2026-08-01',
    enabledEnv: { var: 'WORKER_VEEQO_ORDERS_ENABLED', onValue: 'true', requires: ['VEEQO_API_KEY'] },
    short: 'Espelha pedidos da Veeqo por linha (pick sheet + dedução de estoque).',
    detail: 'A cada 5min lê /orders da Veeqo (abertos, enviados, cancelados) e espelha por LINHA em v3.pnp_order_lines — alimenta o pick sheet do dia e a dedução idempotente de estoque (STOCK_DEDUCT_MODE: dry = shadow, live = deduz via StockService). SKU sem mapeamento confirmado (v3.product_skus) fica em quarentena — nunca deduz por palpite. Centro de Estoque Fase A (Bruno 08-01).',
  },
  {
    key: 'stock_alerts', name: 'Alertas de estoque (planner)', where: 'railway', tickMs: 1800000,
    heartbeat: true, staleMin: 90, critical: false, since: '2026-08-01',
    enabledEnv: { var: 'WORKER_STOCK_ALERTS_ENABLED', onValue: 'true' },
    short: 'Dias de estoque por produto + lead time da fórmula → avisos EMS-aware.',
    detail: 'A cada 30min calcula por produto: estoque armazém (bins+caixas) + marketplace (Veeqo) ÷ velocidade 14d = dias de estoque; lead time medido do histórico EMS por fórmula. Zona PLANEJAR → aviso "comece a planejar"; baixo/zerado COM batch no EMS → "rodar na linha ASAP"; SEM batch → "adicionar à lista de fabricação". Dedupe 24h por produto. Canal: STOCK_ALERTS_CHANNEL (sandbox em teste; admin-orin em produção). NUNCA canal de operador.',
  },
  {
    key: 'stock_drift', name: 'Divergência de estoque vs Veeqo', where: 'railway', tickMs: 600000,
    heartbeat: true, staleMin: 30, critical: false, since: '2026-08-18',
    enabledEnv: { var: 'WORKER_STOCK_DRIFT_ENABLED', onValue: 'true' },
    short: 'A cada 10min compara nosso total com o da Veeqo; divergência nova → admin-orin, e resumo às 8h NY.',
    detail: 'S15 Fase 3 (Bruno 08-18): reconciliação CONTÍNUA. A cada 10min chama computeDrift do warehouse router (direto, sem HTTP) — mesmo cálculo do hub, comparação sempre contra o SKU base. Divergência NOVA vira 1 aviso no admin-orin (dedupe 1×/produto/dia NY via audit_log stock_drift_alert); às 8h NY manda o resumo de tudo que está divergindo (dedupe stock_drift_digest). NUNCA sobrescreve estoque: importar ou ajustar é decisão de gente, no hub. Canal admin (não passa pelo alert-gate, que protege o canal do operador).',
  },
  {
    key: 'freight_watch', name: 'Vigia de custo de frete', where: 'railway', tickMs: 300000,
    heartbeat: true, staleMin: 20, critical: false, since: '2026-08-28',
    enabledEnv: { var: 'WORKER_FREIGHT_WATCH_ENABLED', onValue: 'true' },
    short: 'A cada 5min julga o custo de cada etiqueta nova da Veeqo; cara demais → admin-orin na hora, digest 16:15 NY.',
    detail: 'Bruno 08-28 ("o custo eh uma coisa muito seria... tem como eu saber oq o custo ta acima e oq nao ta antes de imprimir?"). A Veeqo compra etiqueta com data antes do prazo que o cliente pediu (due_date) e o carrier cobra caro. A cada 5min (janela 8h-19h NY) espelha os shipments recentes (48h) em v3.shipment_costs e julga cada etiqueta NOVA contra a mediana móvel 30d da faixa (serviço + faixa de peso; <8 amostras nunca julga; teto absoluto $12 pra <1lb). Etiqueta acima do normal → 1 mensagem no admin-orin NA HORA, porque deletar o envio na Veeqo estorna a etiqueta automático (14 dias) MAS pra USPS isso morre quando o SCAN form do dia sai (~tarde): alerta em minutos = dinheiro recuperável. 16:15 NY manda o digest do dia (dedupe audit_log freight_digest; dia normal = 1 linha). Walmart chega com custo 0 (etiqueta deles): contado à parte, nunca em média. Leitura no /api/v3/freight/* e card Frete na página P&P. READ-ONLY na Veeqo, nunca escreve estoque, nunca canal de operador.',
  },
  {
    key: 'signal_watchdog', name: 'Vigia de sinais externos', where: 'railway', tickMs: 300000,
    heartbeat: true, staleMin: 15, critical: true, since: '2026-08-25',
    enabledEnv: { var: 'WORKER_SIGNAL_WATCHDOG_ENABLED', onValue: 'true' },
    short: 'A cada 5min confere se cada sinal externo ainda está chegando; sinal morto vira incidente com dossiê.',
    detail: 'Bruno 08-25 ("temos que fechar todas as aberturas de esses erros repentinos"). O push de câmera do .28 parou em 23/08 às 23:39 e ficou 42h morto sem ninguém ver; o encap-monitor, cego, gritou alarme falso pros operadores. Este vigia lê src/v3/health/signal-registry.js (machine_state, print_event, ems_sync, veeqo_sync, ngteco_clock) e, pra cada sinal VELHO dentro da janela em que ele deveria estar vivo, abre UM incidente por dia NY: linha em v3.incidents, dossiê Markdown no Obsidian (pasta Incidentes) e UMA mensagem no admin-orin. Quando o sinal volta, posta uma linha e fecha o incidente. NÃO tenta alcançar o .28 (o servidor não consegue: o .28 é quem sempre inicia) — só mede AUSÊNCIA. Nunca escreve estoque, nunca posta no canal dos operadores, nunca bloqueia nada. No Railway não existe o G: do Obsidian, então o dossiê fica guardado em v3.incidents.detail.dossier_md e uma máquina com o vault grava depois via flushDossiers. Dedupe por audit_log signal_incident / signal_recovered. OPT-IN: WORKER_SIGNAL_WATCHDOG_ENABLED=true.',
  },
  {
    key: 'veeqo_sku_sync', name: 'Sincronização e absorção da Veeqo', where: 'railway', tickMs: 21600000,
    heartbeat: true, staleMin: 400, critical: false, since: '2026-08-19',
    enabledEnv: { var: 'WORKER_VEEQO_SKU_SYNC_ENABLED', onValue: 'true' },
    short: 'A cada 6h liga SKU novo no produto pai e ABSORVE o catálogo da Veeqo (titulo, marca, UPC, foto + snapshot cru).',
    detail: 'S15.39 (Bruno 08-19: "pq q ele nao ta mapeado se ta tudo la no Veeqo?"). v3.product_skus sempre foi preenchido À MÃO casando por nome, e por isso 315 dos 483 sellables estavam órfãos: pedido de HF-NAC-1300-C4 não reservava nem deduzia. A cada 6h (+1 rodada 3min após o boot) roda o planner PURO de src/v3/warehouse/sku-sync.js e aplica a PARTE SEGURA: liga SKU novo no produto que já tem a raiz e corrige units_per_pack (o sufixo -C<n> do próprio código manda; -C2-C4 = 8). Cria produto novo SÓ com SKU_SYNC_CREATE_PRODUCTS=true (default OFF: typo de SKU na Veeqo não vira produto sozinho). NUNCA junta dois produtos (raiz disputada = aviso, merge é humano no hub) e NUNCA escreve quantidade. Serviço/plano/insumo (HF-PLN-, HC-, HF-MED-, HF-SYR-, SHOPIFY-, SILIN-, RUBBER-, SKU "70") fica de fora. Avisa no admin-orin só quando mudou algo ou existe conflito, dedupe por dia NY + assinatura via audit_log action sku_sync. SEGUNDA METADE, MESMA TICK — ABSORÇÃO (S15.41, Bruno 08-19: "se a gente fechar nossa conta do veeqo hj vc vai ter tdas as info que precisamos correto?"). Antes a resposta era NÃO: product_skus não tinha coluna de título, barcode estava NULL nos 483 SKUs (a Veeqo tem upc_code em 51) e imagem não existia em lugar nenhum. src/v3/warehouse/veeqo-absorb.js roda logo depois do mapeamento (nesta ordem porque absorver SKU sem linha não teria onde gravar) e grava o DESCRITIVO: title, product_title, brand, veeqo_type, image_url, thumb_url, description, veeqo_product_id em v3.product_skus; image_url + brand em v3.products (herdado do SKU base); os BYTES da foto em v3.product_images (teto 300KB, 25 downloads por rodada, pula URL não mudado) servidos em GET /api/v3/warehouse/image/:product_id; e a leitura CRUA inteira em v3.veeqo_snapshots (últimos 8, podados por id). Copia upc_code pro barcode SÓ quando o nosso está NULL — barcode com confirmed_at foi escaneado por uma pessoa e NUNCA é sobrescrito. Idempotente (compara campo a campo; segunda rodada não muda nada) e NUNCA escreve quantidade. Falha da absorção é isolada em try: não derruba o mapeamento.',
  },
  {
    key: 'mergeable_alert', name: 'Mergeable orders (Veeqo)', where: 'railway', tickMs: 1800000,
    heartbeat: true, staleMin: 120, critical: false, since: '2026-08-02',
    enabledEnv: { var: 'WORKER_MERGEABLE_ALERT_ENABLED', onValue: 'true', requires: ['VEEQO_API_KEY'] },
    short: 'De manhã, lista no admin-orin os pedidos Veeqo a mergear (MESMO nome exato + endereço).',
    detail: 'Uma vez por manhã (janela 7h–12h NY, dedupe 1×/dia), lista no admin-orin os pedidos ABERTOS da Veeqo do MESMO cliente (NOME EXATO + rua + ZIP) que precisam ser juntados num pacote antes de imprimir. SEGURANÇA (Bruno 08-03): NUNCA agrupa por mergeable_id (é só ZIP → estranhos); freight forwarder (mesma rua, nomes diferentes) = não agrupa, e mesmo-nome-em-forwarder exige a SUITE bater. READ-ONLY (não merja). Sempre lembra de conferir cancelamento PENDENTE no eBay antes (a Veeqo não expõe isso). Flag pra canal misto + pra despachante.',
  },
  {
    key: 'stock_gap_alert', name: 'Falta de estoque pro P&P', where: 'railway', tickMs: 300000,
    heartbeat: true, staleMin: 30, critical: false, since: '2026-08-06',
    enabledEnv: { var: 'WORKER_STOCK_GAP_ALERT_ENABLED', onValue: 'true' },
    short: '10min após iniciar impressão + 8h diário: o que falta pro P&P, cruzado com o EMS.',
    detail: 'Bruno 08-06. (1) 10 min depois que um operador inicia Impressão de ordens, manda no admin-orin E no orders-and-inventory o que está zerado/baixo na picklist com a recomendação do EMS: cápsulas prontas em yield_review ("dá pra fazer na mão e liberar hoje?"), na linha (weighing/weighed), já passou (finalized, "temos aqui no estoque?"), ou nada em produção (VERMELHO, resolver já). (2) Todo dia 8h NY manda o resumo no admin-orin. Dedupe 1x/dia por tipo. Casamento de nome EMS↔produto exige 1ª palavra igual (evita Magnesium Citrate virar Magnesium Oxide).',
  },
  {
    key: 'unusual_sku', name: 'SKU incomum na fila P&P', where: 'railway', tickMs: 900000,
    heartbeat: true, staleMin: 60, critical: false, since: '2026-08-06',
    enabledEnv: { var: 'WORKER_UNUSUAL_SKU_ENABLED', onValue: 'true' },
    short: 'SKU FBA/WFS ou sem mapa na fila pendente → avisa admin-orin (sem tirar da picklist).',
    detail: 'Regra do Bruno (08-06): a picklist imprime TUDO alocado no HealthFare Warehouse (até FBA quando cai lá) — NUNCA filtra. Mas SKU estranho (padrão FBA/WFS ou sem mapeamento em product_skus) na fila pendente gera aviso agrupado no admin-orin, 1x por SKU por dia (dedupe via audit_log unusual_sku).',
  },
  {
    key: 'print_divergence', name: 'Divergência de impressão (Veeqo)', where: 'railway', tickMs: 900000,
    heartbeat: true, staleMin: 60, critical: false, since: '2026-08-06',
    enabledEnv: { var: 'WORKER_PRINT_DIVERGENCE_ENABLED', onValue: 'true', requires: ['VEEQO_API_KEY'] },
    short: '12pm NY: digitado (1ª+2ª impressão) vs Veeqo; divergiu → pergunta pra Simone (só a diferença) e grava a resposta.',
    detail: 'Diário às 12pm NY (Simone já imprimiu tudo): soma orders_printed de order_printing+order_printing_2 (não-teste) e compara com veeqo.shippedByDay. Divergiu → pergunta no #orders-and-inventory citando SÓ a diferença (nunca os totais — decisão do Bruno pra capturar o motivo real). Resposta da thread gravada em v3.print_divergence_log todo dia → histórico pra investigar. Respeita o mute do alert-gate.',
  },
  {
    key: 'dup_shipment', name: 'Duplicatas de envio (Veeqo)', where: 'railway', tickMs: 3600000,
    heartbeat: true, staleMin: 150, critical: false, since: '2026-08-03',
    enabledEnv: { var: 'WORKER_DUP_SHIPMENT_ENABLED', onValue: 'true', requires: ['VEEQO_API_KEY'] },
    short: 'À tarde, flag no admin-orin de clientes que saíram em caixas separadas (merge perdido pós-envio).',
    detail: 'Rede de segurança PÓS-envio. À tarde (janela 13h–20h NY, dedupe 1×/dia), detecta no admin-orin pedidos já ENVIADOS do MESMO cliente (NOME EXATO + endereço + MESMO dia) que foram em CAIXAS SEPARADAS (2+ trackings distintos, sem merge) — postagem desperdiçada + base pra claim de reembolso. Mesmo gate anti-despachante do merge-alert (nome exato; nunca mergeable_id; forwarder exige suite). READ-ONLY. NUNCA canal de operador.',
  },
  {
    key: 'absence', name: 'Ausência / idle', where: 'railway', tickMs: 300000,
    heartbeat: true, staleMin: 20, critical: false, since: '2026-07',
    enabledEnv: { var: 'ABSENCE_ALERT_ENABLED', offValue: 'false' },
    short: 'Operador logado sem tarefa há muito → cobra, e após 60min faz checkout.',
    detail: 'A cada 5min vê quem está logado/bateu ponto mas sem função registrada. Passou do limiar → cobra no canal (sem horário do relógio). 60min idle → checkout automático. Sábado/on-demand pergunta com ✅/❌.',
  },
  {
    key: 'encap', name: 'Monitor encapsulação', where: 'railway', tickMs: 600000,
    heartbeat: true, staleMin: 40, critical: false, since: '2026-07-02',
    enabledEnv: { var: 'ENCAP_MONITOR_ENABLED', offValue: 'false' },
    short: 'Encapsuladora parada ≥1h em horário de trabalho → alerta.',
    detail: 'A cada 10min, na janela 8h–20h de dia ativo com operador presente, vê se a máquina de encapsulação está parada há ≥1h e alerta o canal (repete por hora com o total parado do dia).',
  },
  {
    key: 'forgotten_dm', name: 'Carolina forgotten-DM', where: 'railway', tickMs: 600000,
    heartbeat: true, staleMin: 40, critical: false, since: '2026-07',
    enabledEnv: { var: 'WORKER_FORGOTTEN_DM_ENABLED', onValue: 'true' },
    short: 'No dia seguinte, cobra quem esqueceu o checkout (canal + DM).',
    detail: 'A cada 10min processa os forgotten_checkouts agendados: manda 1 mensagem no canal (batch) + DM por pessoa cobrando o checkout esquecido. Tom firme; se esqueceu ponto E checkout, versão séria.',
  },
  {
    key: 'proactive', name: 'Alertas proativos', where: 'railway', tickMs: 1800000,
    heartbeat: false, critical: false, since: '2026-07',
    enabledEnv: { var: 'WORKER_PROACTIVE_ALERTS_ENABLED', onValue: 'true' }, // OPT-IN: off por default — bate com wire.js:322 (drift corrigido 07-28)
    short: 'Varre anomalias (idle longo, evento preso, contagem estranha) → admin.',
    detail: 'A cada 30min roda checagens de anomalia (operador idle longo, evento sem fechar, contagem fora do padrão, ordens impressas anômalas, cota de storage de vídeo) e avisa SÓ o admin-orin.',
  },
  {
    key: 'dedupe', name: 'Dedupe watcher', where: 'railway', tickMs: 60000,
    heartbeat: true, staleMin: 5, critical: false, since: '2026-07-23',
    enabledEnv: { var: 'WORKER_DEDUPE_ENABLED', onValue: 'true' },   // OPT-IN: off por default
    short: 'Detecta contagem de produção duplicada e marca incidente.',
    detail: 'A cada 60s procura contagens duplicadas (mesma produção contada 2× — /op + Slack). Marca possible_duplicate_of, cria incidente no admin-orin + caixa vermelha no dashboard, e auto-corrige.',
  },
  {
    key: 'sandbox_cleanup', name: 'Sandbox cleanup', where: 'railway', tickMs: 5000,
    heartbeat: true, staleMin: 5, critical: false, since: '2026-07',
    enabledEnv: { var: 'WORKER_SANDBOX_CLEANUP_ENABLED', offValue: 'false' },
    short: 'Limpa dados de sessões sandbox (teste) pra não vazar no sistema real.',
    detail: 'A cada 5s remove/expira dados marcados como sandbox (testes no /op) pra que nunca apareçam no Slack, contagens ou timeline reais.',
  },
  {
    key: 'pending_commands', name: 'Pending commands cron', where: 'railway', tickMs: 60000,
    heartbeat: true, staleMin: 5, critical: false, since: '2026-07',
    enabledEnv: { var: 'V3_PENDING_COMMANDS_CRON_DISABLED', offValue: '1' },
    short: 'Expira comandos de admin não confirmados (reaja ✅ em 10min).',
    detail: 'A cada 60s marca como expirados os comandos de admin que pediram confirmação por reação e não foram confirmados em 10min.',
  },
  {
    key: 'note_analyzer', name: 'Note analyzer', where: 'railway', tickMs: null,
    heartbeat: false, critical: false, since: '2026-07',
    short: 'Lê notas dos operadores e resume/analisa pro admin (conservador).',
    detail: 'Sob demanda: quando chega uma nota, o LLM analisa e manda um resumo pro admin-orin. Conservador — não inventa ação, só sinaliza.',
  },
  {
    key: 'worker_watchdog', name: 'Watchdog de workers', where: 'railway', tickMs: 60000,
    heartbeat: false, critical: true, since: '2026-07',
    short: 'Vigia os heartbeats dos workers; se um cai, alerta o admin-orin.',
    detail: 'A cada 60s compara os heartbeats reais (worker_tick_*) com o registro. Worker que devia estar vivo e parou de bater → 1 alerta no admin-orin (1×/60min por worker, sem spam). Usa ESTE registro como fonte da lista.',
  },

  // ─────────────────────── ESTAÇÃO DE IMPRESSÃO (.28) ───────────────────────
  // Rodam no PC de impressão (DESKTOP-SUB8JL6, 10.1.10.28). Mandam sinal pro
  // backend via /api/print-event, /api/printer-status e /api/print-watchdog.
  {
    key: 'printmon', name: 'Print monitor (.28)', where: 'win28', tickMs: 2000,
    heartbeat: false, critical: true, since: '2026-07-16', signalVia: '/api/print-event',
    short: 'Detecta cada job de impressão no PC .28 e manda pro backend.',
    detail: 'Roda no .28, verifica o spooler a cada 2s. Quando um job imprime, registra (produto/lote/labels/operador) e POSTa em /api/print-event. Instância ÚNICA garantida por mutex + varredura (07-27). O watchdog do .28 revive se cair.',
  },
  {
    key: 'epson_status', name: 'EPSON status (.28)', where: 'win28', tickMs: 2000,
    heartbeat: false, critical: true, since: '2026-07-17', signalVia: '/api/printer-status',
    short: 'Lê o estado físico da EPSON (imprimindo/ociosa/erro) e manda mudanças.',
    detail: 'Roda no .28. Lê o status físico da EPSON por ESC/Label sobre USB (~H(SMA,S). Detecta o FIM FÍSICO real (PR→IL) pra o "pode coletar" e erros de mídia (sem papel/atolou). POSTa mudanças em /api/printer-status.',
  },
  {
    key: 'printlock', name: 'Print lock / PIN (.28)', where: 'win28', tickMs: null,
    heartbeat: false, critical: false, since: '2026-07-17',
    short: 'Trava o PC de impressão por PIN e conta o tempo ativo do operador.',
    detail: 'Roda no .28. Exige login por PIN pra usar a estação; conta tempo ativo (teclado/mouse) até 5min de inatividade. É a fonte de "quem está na estação agora".',
  },
  {
    key: 'idlecleanup', name: 'Idle cleanup (.28)', where: 'win28', tickMs: null,
    heartbeat: false, critical: false, since: '2026-07-16',
    short: 'Fecha apps de design abertos/ociosos no PC de impressão.',
    detail: 'Roda no .28. Depois de X min ocioso, fecha Illustrator/Acrobat/etc. abertos pra não deixar arquivo pendurado nem travar a máquina.',
  },
  {
    key: 'print_watchdog', name: 'Watchdog do .28', where: 'win28', tickMs: 30000,
    heartbeat: false, critical: true, since: '2026-07-24', signalVia: '/api/print-watchdog',
    short: 'Revive printmon/epson_status se caírem no .28 e avisa o admin.',
    detail: 'Roda no .28 como tarefa SYSTEM. Vigia printmon + epson_status; se um morre, revive (via WMI) e POSTa em /api/print-watchdog → o backend avisa o admin-orin (debounce 10min). É o que mantém a captura de impressão viva após reboot.',
  },
  {
    // AINDA NÃO INSTALADO no .28 (Bruno 08-19). Fica aqui porque este arquivo é a
    // verdade do que DEVERIA existir, e a fila já está de pé do lado do servidor:
    // sem o puxador, o que o celular manda imprimir espera na fila até alguém
    // abrir a estação. `pending: true` mantém fora da vigia de heartbeat (não dá
    // pra cobrar batida de processo que ninguém instalou ainda).
    key: 'printqueue_agent', name: 'Puxador da fila de impressão (.28)', where: 'win28',
    tickMs: 5000, heartbeat: false, critical: false, pending: true, since: '2026-08-19',
    signalVia: '/api/v3/print-queue',
    short: 'Fila de impressão do celular: hoje quem puxa é a página /print logada no .28 (e a Central/hub), a cada 30 s no navegador. Agente nativo = futuro.',
    detail: 'HOJE (08-19): a estação /print (src/print/print.js) e a Central/hub fazem poll de 30 s em GET /api/v3/print-queue com Bearer OPERATOR_PAGE_TOKEN + X-Session-Token, tomam o job, imprimem pelo navegador (HF_LABELS) e fecham com done/error. Um agente NATIVO no .28 (sem navegador aberto) fica pra depois: poll a cada poucos segundos em GET /api/v3/print-queue com x-print-token (o MESMO PRINT_EVENT_TOKEN do /api/print-event, nenhum segredo novo): toma o job (POST /:id/take), desenha Code128 + QR do payload já resolvido, imprime 4x6, e fecha com POST /:id/done (que carimba label_printed_at nas caixas) ou POST /:id/error com o motivo. Enquanto ele não existe, a estação logada (/print ou /op) consegue tomar e concluir pela mesma API com Bearer OPERATOR_PAGE_TOKEN + X-Session-Token.',
  },
];

// enabled() — resolve o estado LIGADO/DESLIGADO por config, na hora.
function withEnabled(p) {
  return Object.assign({}, p, { enabled: _enabledByEnv(p) });
}

function listProcesses() { return PROCESSES.map(withEnabled); }
function railwayProcesses() { return listProcesses().filter((p) => p.where === 'railway'); }
function win28Processes() { return listProcesses().filter((p) => p.where === 'win28'); }
function getProcess(key) { const p = PROCESSES.find((x) => x.key === key); return p ? withEnabled(p) : null; }
// os que o watchdog deve vigiar: railway, ligados, com heartbeat.
function watchedProcesses() { return listProcesses().filter((p) => p.where === 'railway' && p.enabled && p.heartbeat); }

module.exports = { listProcesses, railwayProcesses, win28Processes, getProcess, watchedProcesses, PROCESSES };
