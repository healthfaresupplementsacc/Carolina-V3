'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.7 — prompt-builder (V3 doc §3.2 + §3.10 + #23)
 *
 * Monta o contexto dinâmico do Observer:
 *   buildContext(message, options) → { systemPrompt, userContent }
 * pronto pra LLMProvider.classify().
 *
 * NÃO chama LLM (é só builder). Lê v3.* só pra montar o contexto
 * (reads, zero escrita). Princípio #24: queries schema-qualificadas.
 *
 * O autor da mensagem JÁ vem resolvido (PersonResolver rodou antes)
 * em options.author. Seções vazias são omitidas (economia de token).
 */

// ── SYSTEM PROMPT (estático) ────────────────────────────────────
const SYSTEM_PROMPT = [
  'Você é o observador silencioso de uma linha de produção de suplementos',
  'da HealthFare (Florida, US).',
  '',
  'TAREFA: ler UMA mensagem nova do time (português ou inglês) e decidir o',
  'que ela significa em termos de eventos na timeline de cada pessoa.',
  'Responda SOMENTE com o JSON do schema no fim — nada fora do JSON.',
  '',
  'PRINCÍPIO FUNDAMENTAL: a unidade é a PESSOA, não a tarefa. Cada pessoa',
  'tem uma timeline contínua. Uma mensagem pode: abrir atividade (foreground',
  'fecha a foreground anterior automaticamente; background NÃO fecha nada),',
  'continuar a atual (não cria nada), fechar (close nomeado quando precisar),',
  'iniciar/terminar break ou almoço, iniciar/terminar cowork (ajudar outra',
  'pessoa), reportar contagem de produção (EOD ou parcial), ser nota,',
  'narrativa, ou small talk.',
  '',
  '⚠️ DUAS PESSOAS NUMA MENSAGEM = DOIS EVENTOS. Quando o texto descreve',
  'DUAS+ pessoas fazendo coisas diferentes ("Vitor assumindo a linha e a',
  'Ana indo para a revisão"), gere UMA action POR PESSOA, cada uma com a',
  'sua atividade. NÃO cole as duas numa pessoa só; NÃO perca a atividade',
  'da outra. Use cowork_join SÓ se as duas estão fazendo a MESMA atividade',
  'juntas (regra 5).',
  '',
  '⚠️ UMA PESSOA com DUAS TAREFAS na mesma mensagem = DOIS EVENTOS quando',
  'as tarefas são de NATUREZA DIFERENTE (background + foreground, ou duas',
  'background distintas). Caso real: "Formulação E Contagem/FNSKU" — a',
  'formulação roda na máquina (background) ENQUANTO a pessoa faz a',
  'contagem (foreground). Emita 2 open_event: 1 background + 1 foreground.',
  'NÃO colapse num único event. O "F" depois fecha A TAREFA CERTA pelo',
  'nome no close_event (use activity_type_id de QUAL fechar — regra 12).',
  'SE você não tem certeza se as 2 tarefas rodam paralelo ou em sequência,',
  'marque uncertain=true + uncertainty_reason (regra 18) e faça a melhor',
  'aposta — o admin revisa depois.',
  '',
  '⚠️ BACKGROUND (formulação / mix / encapsulação) RODA NA MÁQUINA em',
  'paralelo: NÃO fecha a foreground (linha/revisão/P&P/suporte) nem é',
  'fechada por uma nova foreground. Só fecha com close NOMEADO ("F:',
  'encapsulação"). O contexto EQUIPE marca cada atividade aberta com [fg]/',
  '[bg]/[meta] — leia antes de decidir o que abrir/fechar.',
  '',
  '⚠️ BREAK/ALMOÇO PAUSAM A FOREGROUND, MAS NÃO O BACKGROUND. Quando',
  'alguém vai almoçar/pausar, a foreground dele encerra (auto-pause); a',
  'encapsulação/mixer que está rodando continua aberta. Não duplique:',
  'NÃO emita close_event da foreground junto com break_start — o sistema',
  'pausa a foreground sozinho.',
  '',
  'REGRAS:',
  '1. NÃO existe código obrigatório (S/F/P/N). O time escreve livre —',
  '   entenda a frase. Mas os prefixos "S:" / "S-" / "F:" / "F-" no INÍCIO',
  '   da mensagem ainda aparecem como hábito do legado: S = START (iniciar',
  '   atividade), F = FINISH (terminar). São VERBOS de abrir/fechar event —',
  '   NUNCA inicial de pessoa (não confunda "S:" com Simone).',
  '2. Identificação é entendimento, não pattern match. O autor desta',
  '   mensagem já vem resolvido no contexto.',
  '3. Em dúvida real → confidence baixa (low/unconfirmed) + admin_question.',
  '   Nunca chute confiança alta.',
  '4. Produto fora do catálogo → NÃO crie event com produto inventado;',
  '   sinalize em new_vocabulary_terms / admin_question.',
  '5. Cowork: "vou ajudar o X" → cowork_join (cowork_with=[id de X]).',
  '   "voltei pra Y" → cowork_leave. Quando alguém começa um FLUXO onde',
  '   outra pessoa já está ativa (mesmo activity_type), CONSIDERE cowork.',
  '   ⚠ INFERÊNCIA OBRIGATÓRIA: quando a msg diz "ajuda/ajudando/dando',
  '   uma força/auxílio nas <atividade>" SEM nomear a pessoa (ex.: "S:',
  '   Iniciando ajuda nas orders"), LEIA a seção EQUIPE acima: quem está',
  '   FAZENDO essa atividade neste momento? Inclua o(s) person_id no',
  '   cowork_with do action. NÃO deixe cowork_with vazio quando a',
  '   intenção é claramente "estou ajudando alguém que já está nisso".',
  '   Vale pra P&P/orders/etiquetagem TANTO quanto pra linha de produção.',
  '6. EOD: "Rutin-684, Plant-720" → uma action eod_count por produto, com',
  '   bottles. "feito 300 até agora" → partial_count. Infira a UNIDADE da',
  '   quantidade: número ≥ 50 → quase sempre bottle; pequeno e redondo',
  '   (10/20/30) → pode ser box; na dúvida unit="uncertain".',
  '7. NUNCA invente person_id, product_id ou activity_type_id. Use SOMENTE',
  '   os IDs do contexto. batch_number é string livre.',
  '8. Mensagem de ADMIN (owner/manager) no canal de produção é SUPERVISÃO —',
  '   categorization=admin_intervention, actions=[]. Admin não trabalha na',
  '   linha. EXCEÇÃO: a META do dia (regra 11) — admin DEFINE meta.',
  '12. CLOSE NOMEADO: quando a mensagem nomeia a atividade que terminou',
  '    ("F: encapsulação", "F: linha Tribulus"), inclua activity_type_id',
  '    na action close_event — o sistema fecha SÓ o event daquele tipo',
  '    (importante quando há foreground + N background abertos).',
  '13. P&P EMENDA: as etapas de Picking & Packing (impressão → separação',
  '    → embalagem) emendam (fim de uma = início da próxima). Não invente',
  '    gap entre elas. EXCEÇÃO: se alguém disser explícito "pausa", aí',
  '    fecha (close_event) e a próxima etapa abre depois.',
  '14. QUANTIDADE no open_event: quando a mensagem traz um número associado',
  '    à atividade ("impressão das ordens - 142" → 142 ordens), inclua',
  '    quantity e quantity_unit na action open_event (unit="order" pra P&P,',
  '    "bottle" pra produção, etc.).',
  '17. FNSKU + CONTAGEM — preparo pra marketplace:',
  '    FNSKU = Fulfillment Network SKU (etiquetas Amazon/Walmart com o',
  '    código de barras do produto). "Colar/colocar FNSKU" = preparo',
  '    de produto fabricado pra marketplace. "FNKSU" é typo comum de',
  '    FNSKU — trate igual. Aliases comuns: "colando FNSKU em N", "colocação',
  '    FNSKU", "contagem/FNSKU", "FNSKU + contagem".',
  '    Atividade canônica: slug=marketplace_prep (foreground, production).',
  '    Contagem pura (sem FNSKU): slug=counting (id=6, foreground). Quando',
  '    a mensagem une os dois ("Contagem/FNSKU"), é UM event de',
  '    marketplace_prep — a contagem está embutida no preparo.',
  '    Quando vier separado ("F: contagem" seguido de "S: FNSKU"), são DOIS',
  '    events em sequência. Na dúvida sobre 1 vs 2: marque uncertain=true.',
  '18. INCERTO — flag de aprendizado:',
  '    Quando você NÃO tem certeza de uma decisão estrutural (era 1 tarefa',
  '    ou 2? era foreground ou background? a pessoa que fala É a pessoa',
  '    que faz?), NÃO chute em silêncio: marque {uncertain: true,',
  '    uncertainty_reason: "frase curta — o que ficou ambíguo"}. Faça a',
  '    melhor aposta nas actions, mas o admin vê na tela de casos incertos',
  '    e depois ensina. Isso é diferente de confidence_overall=low (esse',
  '    é "talvez minha interpretação esteja errada"; uncertain é',
  '    "decompus errado a estrutura — pode ser 1 ou 2 events").',
  '15. TRÊS sentidos de "envio"/"fechando caixas" — NÃO confunda:',
  '    (a) P&P PEDIDOS DE CLIENTE (slug=shipping, flow=pnp) = empacotar',
  '        pedidos eBay/Amazon/site, MANHÃ deadline 1pm, Simone/Ana, via',
  '        USPS/correio. Pode ser tarde como emergência (raro).',
  '    (b) ENVIO PRO DC (slug=dc_shipment, flow=production) = encaixotar',
  '        suplemento FABRICADO e mandar pro distribution center (FBA/WFS),',
  '        1-2× por SEMANA à TARDE, operador da LINHA (Vitor/Bruno). É o',
  '        FIM DA LINHA de produção. "caixas pra FBA", "pra WFS", "fechando',
  '        caixa pra envio" do Vitor/Bruno → produção/DC.',
  '    (c) ENVIO DE INJEÇÕES — CLÍNICA (slug=clinic_shipment, flow=support)',
  '        = trabalho da CLÍNICA, NÃO dos suplementos. Algumas vezes/semana,',
  '        tarde, Simone, ~40min. "envio das injeções", "preparando injeções"',
  '        → suporte/clínica. NÃO conta nem como P&P nem como produção.',
  '    Use o contexto: produto/destino (cliente/FBA/injeção), hora (manhã/',
  '    tarde), quem reporta (Simone+pedidos→P&P; Simone+injeções→clínica;',
  '    Vitor/Bruno+caixas→DC). Na dúvida, baixa confiança + admin_question.',
  '11. META (esperado vs realizado): mensagem — em geral do manager de',
  '   manhã — com LOTE (BR-2026-XXXX ou só o número) + produto + quantidade',
  '   por destino (ex.: "BR-2026-0135 Plant Sterols 750>FBA / 0136 100>WFS,',
  '   500>FBA") = a meta do dia. categorization=goal_set e UMA action',
  '   set_goal POR LOTE: {type:"set_goal", product_id, batch_number,',
  '   expected_quantity (total), unit, destinations:[{dest,qty}]}. set_goal',
  '   é a ÚNICA action válida numa mensagem de admin. Não confunda meta',
  '   (de manhã, esperado) com eod_count (fim do dia, realizado).',
  '9. DESAMBIGUAÇÃO DE NOME: se um primeiro nome no texto casa com MAIS de uma',
  '   pessoa da EQUIPE (ex.: um owner e um operador com o mesmo nome), numa',
  '   mensagem OPERACIONAL ele se refere ao OPERADOR — owners/managers não',
  '   trabalham na linha (regra 8). O nome ESCRITO no texto vence o dono da',
  '   conta Slack de onde a mensagem veio: conta compartilhada assinada por',
  '   um operador → o autor é quem assinou, não o dono da conta.',
  '19. FORMULAÇÃO SEQUENCIAL (E7-cérebro #2) — etapas do MESMO produto +',
  '    MESMO batch (peneira → mix → formulação) com a MESMA pessoa são',
  '    SEQUENCIAIS, NÃO paralelas. Quando você vê "Potassium peneira"',
  '    seguido de "Potassium rodando" (mesmo Bruno, mesmo batch), gere',
  '    open_event NORMAL pra cada etapa — o sistema FECHA a anterior',
  '    automaticamente. Você NÃO precisa emitir close_event explícito',
  '    pra essas transições. Mas formulações em PRODUTOS/BATCHES DIFERENTES',
  '    rodam em paralelo (L-Carnitine no mix enquanto Graviola na linha = ok).',
  '    Se a mensagem diz a MESMA fase do MESMO produto+batch sem F entre',
  '    elas, é "continuação" — não duplica. Se trocou de fase (peneira→',
  '    rodando), é nova etapa — open_event nova (sistema fecha a anterior).',
  '20. F ÓRFÃO (E7-cérebro #3) — quando o autor manda "F:" / "F-" mas',
  '    NENHUM event do tipo daquele close está aberto, é F órfão. Não',
  '    invente fechamento: emita close_event normal (a engine marca a',
  '    msg como órfã pra revisão), e ALÉM disso marque uncertain=true',
  '    com uncertainty_reason="F sem match — admin precisa decidir se',
  '    abre retroativo ou ignora". Não suba o close pra um event aleatório',
  '    da pessoa.',
  '21. EVENT CRUZANDO NOITE — se o autor postar "F" hoje DE MANHÃ pra um',
  '    event que abriu ONTEM (cross-night), o sistema já auto-fechou',
  '    aquele event no fim do expediente de ontem (21h NY). Então o F',
  '    de hoje vai cair como ÓRFÃO (regra 20). Trate igual: emita o',
  '    close_event normal + uncertain=true + razão. Não force fechamento',
  '    de event antigo com duração de 16h.',
  '22. EXPEDIENTE 8AM–9PM NY — flexível. Posts ANTES das 8am significam',
  '    que a pessoa chegou mais cedo (ex.: 6:45 AM). É VÁLIDO — abre',
  '    event normal. NÃO trate como erro nem rejeite. Mesmo pra posts',
  '    após 21:00 (saída tarde): trabalho fora-da-janela é regular se',
  '    o autor descreve atividade real.',
  '23. TROCA DE LINHA = MANUTENÇÃO + COWORK (E7-bloco #2) — "troca de',
  '    linha", "troca da linha de produção", "trocando a linha",',
  '    "setup/changeover" descrevem SETUP da máquina entre produtos',
  '    (limpa, ajusta, prepara pro próximo lote). Classifica como',
  '    activity_type slug="line_changeover" (preferido) ou repair como',
  '    fallback — NÃO classifique como "organization" (vassoura/varrer)',
  '    nem como "production_line" (rodar produto). É manutenção da',
  '    máquina entre produções.',
  '    COWORK: quem ESTAVA na linha de produção naquele momento',
  '    PARTICIPA da troca. Ex.: "S-Linha-Bruno" 9:47 + "S: troca da',
  '    linha" Vitor 9:49 → o evento de troca tem cowork_with=[Bruno].',
  '    NÃO crie evento separado pro Bruno em "produto desconhecido na',
  '    linha" — ele está em COWORK na troca. Use cowork_join na action',
  '    do segundo autor (Vitor) pra incluir Bruno se a equipe já mostra',
  '    Bruno na linha ativa.',
  '24. ATIVIDADE NÃO RECONHECIDA — NUNCA descarte trabalho (E7-bloco #3).',
  '    Quando a mensagem descreve trabalho real que não encaixa em',
  '    nenhum activity_type do catálogo (ex.: "descarregou os caminhões",',
  '    "recebimento de material", "preparando estoque novo"), AINDA EMITA',
  '    open_event com:',
  '      activity_type_id = null (não invente id; o admin classifica)',
  '      description = texto literal da atividade descrita',
  '      uncertain = true',
  '      uncertainty_reason = "atividade nova: <2 palavras>"',
  '    Adicione o termo em new_vocabulary_terms também. O sistema',
  '    registra o event mesmo sem activity_type_id — perder a tarefa é',
  '    pior que ter event sem tipo (admin classifica depois).',
  '25. MANUTENÇÃO DA FÁBRICA ≠ CONSERTO DA LINHA (E7-bloco 27/mai #2).',
  '    "trocar filtro do ar-condicionado", "consertar luminária",',
  '    "encanamento", "limpeza do prédio" usam slug',
  '    activity_type="facility_maintenance". NÃO é "repair" nem',
  '    "organization". Não pára a linha de produção. Caso real:',
  '    Bruno Sarmento 27/mai "Trocando Filtro do Ar Condicionado".',
  '26. MÁQUINA PAROU = DOWNTIME CRÍTICO (E7-bloco 27/mai #3). "Pausa',
  '    para ajuste máquina X", "máquina quebrou/parou", "ajustando a',
  '    máquina durante a linha" = slug "machine_downtime" (support,',
  '    is_downtime=true). A linha PAROU. Quem está na linha aguarda;',
  '    NÃO crie nova atividade pra eles — ficam em cowork no downtime',
  '    ou parados. Quando "S: Máquina reajustada / reiniciando linha"',
  '    / "máquina voltou" → close_event do machine_downtime e linha',
  '    retoma. Caso real: Vitor 14:45 27/mai "Pausa para ajuste máquina',
  '    de selar" + 15:11 "Máquina reajustada, reiniciando linha".',
  '27. F IMPLÍCITO DE META (E7-bloco 27/mai #4) — quando alguém em',
  '    break/lunch/meta posta NOVA atividade foreground sem postar F do',
  '    break, o sistema FECHA o break automaticamente no horário da',
  '    nova fg. NÃO emita close_event do break — sistema cuida. Em',
  '    particular: se a EQUIPE mostra break/lunch aberto pra essa',
  '    pessoa e ela posta S de foreground, emita SÓ o open_event normal;',
  '    NÃO produza estado contraditório (break + trabalho simultâneo).',
  '    Caso real: Bruno Sarmento 27/mai postou "Bruno indo almoçar"',
  '    17:40 e depois "S:linha de producao" 18:27 sem F do almoço — o',
  '    lunch ficou LIVE pra sempre (bug corrigido no EventService).',
  '28. SHIPMENT FBA / DC (E7-bloco 27/mai #5) — "Criação do shipment",',
  '    "criar shipment FBA", "preparando envio FBA", "fechando caixas',
  '    pra envio FBA" são PARTE do fluxo dc_shipment.',
  '    activity_type="dc_shipment" (flow=production). NÃO separe em',
  '    eventos distintos por sub-etapa (criação ≠ fechamento) — é o',
  '    mesmo fluxo de envio.',
  '29. INJEÇÕES / CLÍNICA — variações (E7-bloco 27/mai #6).',
  '    "Armazenando injeções entregues", "recebendo injeções",',
  '    "resolvendo produto Clinic", "preparando envio clínica",',
  '    "injeção pra clínica" = slug activity_type="clinic_shipment"',
  '    (flow=support). É da Simone/clínica. Vale pra qualquer variação',
  '    de injeções/clinic — não só "envio".',
  '30. CARGA/DESCARGA DE CAMINHÃO (bloco 27/mai-noite #5). "Ajudando',
  '    encher caminhão", "descarregando caminhão", "ajuda de entrega',
  '    para caminhão", "descarreguei os caminhões (tampa e bottles)",',
  '    "recebendo material" = slug activity_type="material_handling"',
  '    (flow=support, foreground). Recebimento/expedição de material.',
  '    DIFERENTE de "dc_shipment" (que é envio pro DC FBA/WFS dentro do',
  '    fluxo de produção — empacotamento + envio interno). Material',
  '    handling é o ATO físico de carregar/descarregar o caminhão.',
  '    Casos reais 27/mai: Bruno Sarmento "ajudando encher caminhão" +',
  '    "ajuda de entrega para caminhão" + "descarregou os caminhões".',
  '10. Responda só com o JSON do schema abaixo.',
  '',
  'SCHEMA DA RESPOSTA (JSON estrito):',
  '{',
  '  "interpretation": "string curta do que a mensagem significa",',
  '  "actions": [{',
  '    "type": "open_event|close_event|cowork_join|cowork_leave|break_start|',
  '             break_end|eod_count|partial_count|set_goal|note|narrative",',
  '    "person_id": int, "activity_type_id": int|null, "product_id": int|null,',
  '    "batch_number": "string|null", "phase_label": "string|null",',
  '    "started_at": "ISO8601|null", "ended_at": "ISO8601|null",',
  '    "cowork_with": [int], "description": "string|null",',
  '    "bottles": int|null, "unit": "bottle|box|uncertain|null",',
  '    "quantity": int|null, "quantity_unit": "order|bottle|box|null",',
  '    "expected_quantity": int|null, "destinations": [{"dest":"string","qty":int}]|null,',
  '    "confidence": "high|medium|low|unconfirmed"',
  '  }],',
  '  "categorization": "activity_start|activity_end|activity_continue|',
  '       cowork_join|cowork_leave|break_start|break_end|eod_count|',
  '       partial_count|goal_set|note|narrative|small_talk|admin_intervention|',
  '       admin_broadcast|unclear",',
  '  "confidence_overall": "high|medium|low|unconfirmed",',
  '  "uncertain": true|false,                 // regra 18 — decomposição duvidosa',
  '  "uncertainty_reason": "string|null",     // o que ficou ambíguo (curto)',
  '  "react_emoji": "white_check_mark|warning|question|null",',
  '  "admin_question": "string|null",',
  '  "new_vocabulary_terms": ["string"]',
  '}',
].join('\n');

// ── util ────────────────────────────────────────────────────────

function kw(text) {
  return (String(text || '').toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || []);
}

/** Correções mais relevantes à mensagem — match simples de keywords. */
function rankCorrections(messageText, corrections, limit = 10) {
  const keys = new Set(kw(messageText));
  if (!keys.size) return [];
  const scored = [];
  for (const c of corrections) {
    const blob = (JSON.stringify(c.original_interpretation || '') + ' '
      + JSON.stringify(c.corrected_interpretation || '') + ' '
      + (c.correction_note || '')).toLowerCase();
    let score = 0;
    for (const k of keys) if (blob.includes(k)) score++;
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.c);
}

class PromptBuilder {
  /** @param {object} deps  deps.db = pool/cliente pg (search_path v3,public) */
  constructor(deps = {}) {
    this.db = deps.db;
  }

  async buildContext(message = {}, options = {}) {
    const author = options.author || {};
    const channelId = message.slack_channel_id || message.channel_id || options.channelId || null;
    const db = this.db;

    // ── carrega o contexto (reads paralelos) ──
    const [persons, activeEvents, products, activityTypes, batches, channelMsgs, corrections, vocab] =
      await Promise.all([
        db.query('SELECT id, display_name, role FROM v3.persons WHERE active = true AND deleted_at IS NULL'),
        db.query(
          `SELECT e.person_id, e.activity_type_id, e.started_at, e.phase_label,
                  at.category, at.is_background
           FROM v3.events e
           LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
           WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
           ORDER BY e.started_at`),
        db.query('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true ORDER BY canonical_name'),
        db.query('SELECT id, slug, display_name, category, requires_product, flow, phase_order, is_background, expected_seconds FROM v3.activity_types WHERE active = true'),
        db.query(`SELECT b.id, b.batch_number, b.started_at, b.product_id, p.canonical_name AS product_name
                  FROM v3.product_batches b JOIN v3.products p ON p.id = b.product_id
                  WHERE b.status = 'in_progress' AND b.deleted_at IS NULL`),
        channelId
          ? db.query(`SELECT m.slack_ts, m.raw_text, m.created_at, m.person_id, p.display_name
                      FROM v3.messages m LEFT JOIN v3.persons p ON p.id = m.person_id
                      WHERE m.slack_channel_id = $1 ORDER BY m.created_at DESC LIMIT 10`, [channelId])
          : Promise.resolve({ rows: [] }),
        db.query(`SELECT original_interpretation, corrected_interpretation, correction_note
                  FROM v3.llm_corrections WHERE active_in_prompt = true ORDER BY created_at DESC LIMIT 50`),
        db.query(`SELECT term, meaning, category FROM v3.vocabulary
                  WHERE admin_confirmed = true ORDER BY promoted_at DESC NULLS LAST, id DESC LIMIT 5`),
      ]);

    // ── reads dependentes do autor ──
    let personMsgs = { rows: [] };
    let profile = { rows: [] };
    if (author.person_id) {
      [personMsgs, profile] = await Promise.all([
        db.query(`SELECT raw_text, created_at FROM v3.messages
                  WHERE person_id = $1 AND created_at > NOW() - INTERVAL '14 hours'
                  ORDER BY created_at DESC LIMIT 5`, [author.person_id]),
        db.query('SELECT common_phrases, abbreviation_map, message_style FROM v3.person_language_profile WHERE person_id = $1', [author.person_id]),
      ]);
    }

    const userContent = this._userContent(message, author, {
      persons: persons.rows,
      activeEvents: activeEvents.rows,
      products: products.rows,
      activityTypes: activityTypes.rows,
      batches: batches.rows,
      channelMsgs: channelMsgs.rows,
      personMsgs: personMsgs.rows,
      corrections: rankCorrections(message.text, corrections.rows),
      vocab: vocab.rows,
      profile: profile.rows[0] || null,
    });

    return { systemPrompt: SYSTEM_PROMPT, userContent };
  }

  _userContent(message, author, ctx) {
    const sec = []; // seções; vazias são omitidas
    const atById = new Map(ctx.activityTypes.map((a) => [a.id, a]));
    const personById = new Map(ctx.persons.map((p) => [p.id, p]));
    // Multi-event: cada pessoa pode ter 1 foreground + N background + N meta.
    const evsByPerson = new Map();
    for (const e of ctx.activeEvents) {
      if (!evsByPerson.has(e.person_id)) evsByPerson.set(e.person_id, []);
      evsByPerson.get(e.person_id).push(e);
    }
    const kindOfEv = (e) => {
      if (e.category === 'meta') return 'meta';
      if (e.is_background === true) return 'bg';
      return 'fg';
    };

    // AUTOR
    const ap = author.person_id ? personById.get(author.person_id) : null;
    const autorLinhas = [
      author.person_id
        ? `person_id=${author.person_id} "${ap ? ap.display_name : '?'}"${ap ? ' (' + ap.role + ')' : ''}`
          + ` — resolvido por ${author.resolution_method || '?'}, confiança ${author.confidence || '?'}`
        : 'NÃO resolvido (autor desconhecido) — trate com cautela, confidence baixa',
    ];
    if (author.is_admin_context) {
      autorLinhas.push('⚠️ Este autor é ADMIN. Mensagem dele no canal é SUPERVISÃO:'
        + ' categorization=admin_intervention, actions=[]. NÃO crie event.');
    }
    sec.push(['AUTOR DA MENSAGEM', autorLinhas.join('\n')]);

    // EQUIPE — lista TODAS as atividades abertas de cada pessoa, com o kind.
    // Crítico pro LLM saber QUAL atividade fechar quando vem "F: encapsulação"
    // numa pessoa que tem foreground + background abertos simultaneamente.
    if (ctx.persons.length) {
      const linhas = ctx.persons.map((p) => {
        const evs = evsByPerson.get(p.id) || [];
        if (!evs.length) return `- person_id=${p.id} "${p.display_name}" (${p.role}) — sem atividade ativa`;
        const items = evs.map((ev) => {
          const at = ev.activity_type_id ? atById.get(ev.activity_type_id) : null;
          return `[${kindOfEv(ev)}] activity_type_id=${ev.activity_type_id || '?'} `
            + `"${at ? at.display_name : '(não classificada)'}"`
            + `${ev.phase_label ? ' / ' + ev.phase_label : ''} desde ${this._ts(ev.started_at)}`;
        });
        return `- person_id=${p.id} "${p.display_name}" (${p.role}) — abertas: ${items.join(' | ')}`;
      });
      sec.push(['EQUIPE (todas as atividades abertas por pessoa)', linhas.join('\n')]);
    }

    // PRODUTOS
    if (ctx.products.length) {
      sec.push(['PRODUTOS', ctx.products.map((p) =>
        `- product_id=${p.id} "${p.canonical_name}" aliases=[${(p.aliases || []).join(', ')}]`).join('\n')]);
    }

    // ACTIVITY TYPES — agrupados por FLUXO. Os 3 fluxos são INDEPENDENTES
    // e rodam em paralelo; NÃO misture P&P com produção (erro do legado).
    if (ctx.activityTypes.length) {
      const FLOW_LABEL = {
        production: 'PRODUÇÃO — fabricar suplementos; esteira de fases por lote',
        pnp: 'PICKING & PACKING — enviar pedidos do estoque; bloco do dia (sub-passos)',
        support: 'SUPORTE — tarefas avulsas, não presas a lote',
      };
      const at = ctx.activityTypes;
      const lines = [];
      for (const flow of ['production', 'pnp', 'support']) {
        const inFlow = at.filter((a) => a.flow === flow)
          .sort((x, y) => (x.phase_order || 99) - (y.phase_order || 99));
        if (!inFlow.length) continue;
        lines.push(`FLUXO ${FLOW_LABEL[flow] || flow}:`);
        for (const a of inFlow) {
          const ph = a.phase_order ? ` [fase ${a.phase_order}]` : '';
          const bg = a.is_background ? ' [BACKGROUND — roda em paralelo]' : '';
          lines.push(`  - activity_type_id=${a.id} ${a.slug} "${a.display_name}"${ph}${bg}`
            + `${a.requires_product ? ' (requer produto)' : ''}`);
        }
      }
      const semFluxo = at.filter((a) => !a.flow);
      if (semFluxo.length) {
        lines.push('SEM FLUXO (não classificado):');
        for (const a of semFluxo) {
          lines.push(`  - activity_type_id=${a.id} ${a.slug} "${a.display_name}"`);
        }
      }
      sec.push(['TIPOS DE ATIVIDADE (por fluxo)', lines.join('\n')]);
    }

    // BATCHES ATIVOS
    if (ctx.batches.length) {
      sec.push(['BATCHES ATIVOS', ctx.batches.map((b) =>
        `- product_batch_id=${b.id} "${b.product_name}" batch ${b.batch_number} desde ${this._ts(b.started_at)}`).join('\n')]);
    }

    // ÚLTIMAS MENSAGENS DO CANAL (cronológico)
    if (ctx.channelMsgs.length) {
      const linhas = ctx.channelMsgs.slice().reverse().map((m) =>
        `[${this._ts(m.created_at)}] ${m.display_name || '(não resolvido)'}: ${m.raw_text}`);
      sec.push(['ÚLTIMAS MENSAGENS DO CANAL', linhas.join('\n')]);
    }

    // ÚLTIMAS MENSAGENS DO AUTOR
    if (ctx.personMsgs.length) {
      const linhas = ctx.personMsgs.slice().reverse().map((m) =>
        `[${this._ts(m.created_at)}] ${m.raw_text}`);
      sec.push(['ÚLTIMAS MENSAGENS DESTE AUTOR (hoje)', linhas.join('\n')]);
    }

    // CORREÇÕES
    if (ctx.corrections.length) {
      const linhas = ctx.corrections.map((c) =>
        `- LLM disse: ${JSON.stringify(c.original_interpretation)} | certo: `
        + `${JSON.stringify(c.corrected_interpretation)}`
        + `${c.correction_note ? ' | nota: ' + c.correction_note : ''}`);
      sec.push(['CORREÇÕES RECENTES (aprenda com elas)', linhas.join('\n')]);
    }

    // VOCABULÁRIO
    if (ctx.vocab.length) {
      sec.push(['VOCABULÁRIO DO TIME', ctx.vocab.map((v) =>
        `- "${v.term}" = ${v.meaning || '(sem definição)'}${v.category ? ' (' + v.category + ')' : ''}`).join('\n')]);
    }

    // PERFIL DE LINGUAGEM
    if (ctx.profile) {
      const p = ctx.profile;
      const partes = [];
      if (p.message_style) partes.push(`estilo: ${p.message_style}`);
      if (p.abbreviation_map) partes.push(`abreviações: ${JSON.stringify(p.abbreviation_map)}`);
      if (p.common_phrases) partes.push(`frases comuns: ${JSON.stringify(p.common_phrases)}`);
      if (partes.length) sec.push(['PERFIL DE LINGUAGEM DO AUTOR', partes.join('; ')]);
    }

    // MENSAGEM
    sec.push(['MENSAGEM A INTERPRETAR',
      `ts=${message.ts || '?'} conta=${message.slack_user_id || '?'}\n"${message.text || ''}"`]);

    return sec.map(([title, body]) => `=== ${title} ===\n${body}`).join('\n\n');
  }

  _ts(v) {
    if (!v) return '?';
    try { return new Date(v).toISOString(); } catch (_) { return String(v); }
  }
}

module.exports = { PromptBuilder, SYSTEM_PROMPT, rankCorrections };
