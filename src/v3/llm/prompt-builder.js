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
  'tem uma timeline contínua. Uma mensagem pode: abrir atividade (fecha a',
  'anterior automaticamente), continuar a atual (não cria nada), fechar,',
  'iniciar/terminar break ou almoço, iniciar/terminar cowork (ajudar outra',
  'pessoa), reportar contagem de produção (EOD ou parcial), ser nota,',
  'narrativa, ou small talk.',
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
  '5. Cowork: "vou ajudar o X" → cowork_join (cowork_with=[id de X]);',
  '   "voltei pra Y" → cowork_leave.',
  '6. EOD: "Rutin-684, Plant-720" → uma action eod_count por produto, com',
  '   bottles. "feito 300 até agora" → partial_count. Infira a UNIDADE da',
  '   quantidade: número ≥ 50 → quase sempre bottle; pequeno e redondo',
  '   (10/20/30) → pode ser box; na dúvida unit="uncertain".',
  '7. NUNCA invente person_id, product_id ou activity_type_id. Use SOMENTE',
  '   os IDs do contexto. batch_number é string livre.',
  '8. Mensagem de ADMIN (owner/manager) no canal de produção é SUPERVISÃO —',
  '   categorization=admin_intervention, actions=[]. Admin não trabalha na',
  '   linha. EXCEÇÃO: a META do dia (regra 11) — admin DEFINE meta.',
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
  '    "expected_quantity": int|null, "destinations": [{"dest":"string","qty":int}]|null,',
  '    "confidence": "high|medium|low|unconfirmed"',
  '  }],',
  '  "categorization": "activity_start|activity_end|activity_continue|',
  '       cowork_join|cowork_leave|break_start|break_end|eod_count|',
  '       partial_count|goal_set|note|narrative|small_talk|admin_intervention|',
  '       admin_broadcast|unclear",',
  '  "confidence_overall": "high|medium|low|unconfirmed",',
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
        db.query('SELECT person_id, activity_type_id, started_at, phase_label FROM v3.events WHERE ended_at IS NULL AND deleted_at IS NULL'),
        db.query('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true ORDER BY canonical_name'),
        db.query('SELECT id, slug, display_name, category, requires_product, flow, phase_order FROM v3.activity_types WHERE active = true'),
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
    const evByPerson = new Map(ctx.activeEvents.map((e) => [e.person_id, e]));

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

    // EQUIPE
    if (ctx.persons.length) {
      const linhas = ctx.persons.map((p) => {
        const ev = evByPerson.get(p.id);
        if (!ev) return `- person_id=${p.id} "${p.display_name}" (${p.role}) — sem atividade ativa`;
        const at = ev.activity_type_id ? atById.get(ev.activity_type_id) : null;
        return `- person_id=${p.id} "${p.display_name}" (${p.role}) — agora: `
          + `${at ? at.display_name : '(atividade não classificada)'}`
          + `${ev.phase_label ? ' / ' + ev.phase_label : ''} desde ${this._ts(ev.started_at)}`;
      });
      sec.push(['EQUIPE (estado atual)', linhas.join('\n')]);
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
          lines.push(`  - activity_type_id=${a.id} ${a.slug} "${a.display_name}"${ph}`
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
