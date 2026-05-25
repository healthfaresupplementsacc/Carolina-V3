'use strict';
// HEALTHFARE V3 — PARTE 2.7 — testes comportamentais do prompt-builder.
const { PromptBuilder, SYSTEM_PROMPT, rankCorrections } = require('../v3/llm/prompt-builder');

function makeFakeDb(seed = {}) {
  const d = {
    persons: [], activeEvents: [], products: [], activityTypes: [],
    batches: [], channelMsgs: [], personMsgs: [], corrections: [], vocab: [], profile: null,
  };
  Object.assign(d, seed);
  return {
    query: jest.fn((sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FROM v3\.persons WHERE active = true/.test(s)) return Promise.resolve({ rows: d.persons });
      if (/FROM v3\.events e.*WHERE e\.ended_at IS NULL/.test(s) || /FROM v3\.events WHERE ended_at IS NULL/.test(s)) {
        return Promise.resolve({ rows: d.activeEvents });
      }
      if (/FROM v3\.products WHERE active = true/.test(s)) return Promise.resolve({ rows: d.products });
      if (/FROM v3\.activity_types WHERE active = true/.test(s)) return Promise.resolve({ rows: d.activityTypes });
      if (/FROM v3\.product_batches b JOIN/.test(s)) return Promise.resolve({ rows: d.batches });
      if (/FROM v3\.messages m LEFT JOIN/.test(s)) return Promise.resolve({ rows: d.channelMsgs });
      if (/FROM v3\.messages WHERE person_id/.test(s)) return Promise.resolve({ rows: d.personMsgs });
      if (/FROM v3\.llm_corrections/.test(s)) return Promise.resolve({ rows: d.corrections });
      if (/FROM v3\.vocabulary/.test(s)) return Promise.resolve({ rows: d.vocab });
      if (/FROM v3\.person_language_profile/.test(s)) return Promise.resolve({ rows: d.profile ? [d.profile] : [] });
      return Promise.resolve({ rows: [] });
    }),
  };
}

const MSG = { text: 'comecei a formulação do plant sterols', ts: '111.1', slack_user_id: 'U_PL', channel_id: 'C_PROD' };
const AUTHOR = { person_id: 6, resolution_method: 'llm_identified', confidence: 'high' };

describe('V3 §2.7 — buildContext estrutura', () => {
  test('retorna systemPrompt + userContent', async () => {
    const pb = new PromptBuilder({ db: makeFakeDb() });
    const r = await pb.buildContext(MSG, { author: AUTHOR });
    expect(typeof r.systemPrompt).toBe('string');
    expect(typeof r.userContent).toBe('string');
  });

  test('systemPrompt traz as regras-chave e o schema', () => {
    expect(SYSTEM_PROMPT).toMatch(/PRINCÍPIO FUNDAMENTAL/);
    expect(SYSTEM_PROMPT).toMatch(/NÃO existe código obrigatório/);
    expect(SYSTEM_PROMPT).toMatch(/SCHEMA DA RESPOSTA/);
    expect(SYSTEM_PROMPT).toMatch(/admin_intervention/);
    expect(SYSTEM_PROMPT).toMatch(/NUNCA invente person_id/);
  });

  test('FIX E — systemPrompt reforça desambiguação de nome (operador vence owner)', () => {
    expect(SYSTEM_PROMPT).toMatch(/DESAMBIGUAÇÃO DE NOME/);
    expect(SYSTEM_PROMPT).toMatch(/nome ESCRITO no texto vence o dono da/);
  });

  test('FIX — systemPrompt trata "S:"/"F:" como marcador start/finish, não nome', () => {
    expect(SYSTEM_PROMPT).toMatch(/S = START/);
    expect(SYSTEM_PROMPT).toMatch(/F = FINISH/);
    expect(SYSTEM_PROMPT).toMatch(/NUNCA inicial de pessoa/);
  });

  test('Captura A2 — regra "duas pessoas na msg = dois events"', () => {
    // a causa-raiz do erro do dia 22 (Vitor/Ana). O prompt precisa
    // instruir explicitamente o LLM a emitir UMA action POR PESSOA.
    expect(SYSTEM_PROMPT).toMatch(/DUAS PESSOAS NUMA MENSAGEM = DOIS EVENTOS/);
    expect(SYSTEM_PROMPT).toMatch(/UMA action POR PESSOA/);
  });

  test('Captura A1 — regra background (roda em paralelo, close nomeado)', () => {
    expect(SYSTEM_PROMPT).toMatch(/BACKGROUND.*formulação.*mix.*encapsulação/i);
    expect(SYSTEM_PROMPT).toMatch(/RODA NA MÁQUINA em\s+paralelo/);
    expect(SYSTEM_PROMPT).toMatch(/CLOSE NOMEADO/);
  });

  test('Captura A4 — regra "break/almoço pausa foreground, não bg"', () => {
    expect(SYSTEM_PROMPT).toMatch(/BREAK\/ALMOÇO PAUSAM A FOREGROUND, MAS NÃO O BACKGROUND/);
  });

  test('Captura A2 — regra de quantidade no open_event', () => {
    expect(SYSTEM_PROMPT).toMatch(/QUANTIDADE no open_event/);
    expect(SYSTEM_PROMPT).toMatch(/quantity.*quantity_unit/);
  });

  test('Captura A2 — regra P&P emenda + exceção "pausa"', () => {
    expect(SYSTEM_PROMPT).toMatch(/P&P EMENDA/);
    expect(SYSTEM_PROMPT).toMatch(/EXCEÇÃO.*pausa/);
  });

  test('Captura — UMA pessoa, DUAS tarefas (foreground + background) = 2 events', () => {
    expect(SYSTEM_PROMPT).toMatch(/UMA PESSOA com DUAS TAREFAS/);
    expect(SYSTEM_PROMPT).toMatch(/Formulação E Contagem\/FNSKU/);
    expect(SYSTEM_PROMPT).toMatch(/Emita 2 open_event/);
  });

  test('Captura — FNSKU + contagem = marketplace_prep (regra 17)', () => {
    expect(SYSTEM_PROMPT).toMatch(/FNSKU \+ CONTAGEM/);
    expect(SYSTEM_PROMPT).toMatch(/slug=marketplace_prep/);
    expect(SYSTEM_PROMPT).toMatch(/FNKSU.*typo/);
    expect(SYSTEM_PROMPT).toMatch(/Amazon\/Walmart/);
  });

  test('Aprendizado — regra 18 INCERTO + uncertain no schema', () => {
    expect(SYSTEM_PROMPT).toMatch(/INCERTO.*flag de aprendizado/);
    expect(SYSTEM_PROMPT).toMatch(/uncertain:\s*true/);
    expect(SYSTEM_PROMPT).toMatch(/uncertainty_reason/);
    expect(SYSTEM_PROMPT).toMatch(/"uncertain":\s*true\|false/);
    expect(SYSTEM_PROMPT).toMatch(/"uncertainty_reason":\s*"string\|null"/);
  });

  test('Captura — TRÊS sentidos de envio (P&P cliente / DC produção / clínica injeções)', () => {
    expect(SYSTEM_PROMPT).toMatch(/TRÊS sentidos de "envio"/);
    expect(SYSTEM_PROMPT).toMatch(/PEDIDOS DE CLIENTE.*slug=shipping/s);
    expect(SYSTEM_PROMPT).toMatch(/dc_shipment.*flow=production/s);
    expect(SYSTEM_PROMPT).toMatch(/clinic_shipment.*flow=support/s);
    expect(SYSTEM_PROMPT).toMatch(/FBA|WFS/);
    expect(SYSTEM_PROMPT).toMatch(/INJEÇÕES/);
  });

  test('mensagem a interpretar incluída no userContent', async () => {
    const pb = new PromptBuilder({ db: makeFakeDb() });
    const r = await pb.buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toContain('MENSAGEM A INTERPRETAR');
    expect(r.userContent).toContain('comecei a formulação do plant sterols');
  });
});

describe('V3 §2.7 — seções dinâmicas', () => {
  test('equipe com current_event (agora) e sem atividade', async () => {
    const db = makeFakeDb({
      persons: [
        { id: 6, display_name: 'Ana', role: 'operator' },
        { id: 4, display_name: 'Vitor', role: 'operator' },
      ],
      activeEvents: [{ person_id: 4, activity_type_id: 10, started_at: '2026-05-20T14:00:00.000Z', phase_label: null }],
      activityTypes: [{ id: 10, slug: 'formulation', display_name: 'Formulação', category: 'production_phase', requires_product: true }],
    });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    // Captura Aprimorada A1: a seção EQUIPE agora lista TODAS as
    // atividades abertas por pessoa, marcando o kind [fg|bg|meta].
    expect(r.userContent).toContain('EQUIPE (todas as atividades abertas por pessoa)');
    expect(r.userContent).toMatch(/Vitor.*\[fg\].*Formulação/);
    expect(r.userContent).toMatch(/Ana.*sem atividade ativa/);
  });

  test('produtos com aliases incluídos', async () => {
    const db = makeFakeDb({ products: [{ id: 5, canonical_name: 'Plant Sterols', aliases: ['Plant', 'Plant-S'] }] });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toMatch(/product_id=5 "Plant Sterols" aliases=\[Plant, Plant-S\]/);
  });

  test('activity_types e batches ativos incluídos', async () => {
    const db = makeFakeDb({
      activityTypes: [{ id: 10, slug: 'formulation', display_name: 'Formulação', category: 'production_phase', requires_product: true, flow: 'production', phase_order: 1 }],
      batches: [{ id: 1, batch_number: '0136', started_at: '2026-05-20T09:00:00.000Z', product_id: 5, product_name: 'Plant Sterols' }],
    });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toContain('activity_type_id=10 formulation');
    expect(r.userContent).toMatch(/product_batch_id=1 "Plant Sterols" batch 0136/);
  });

  test('Bloco 1 — activity_types agrupados por fluxo no prompt', async () => {
    const db = makeFakeDb({
      activityTypes: [
        { id: 1, slug: 'formulation', display_name: 'Formulação', category: 'production_phase', requires_product: true, flow: 'production', phase_order: 1 },
        { id: 15, slug: 'orders', display_name: 'Ordens (P&P)', category: 'pnp_phase', requires_product: false, flow: 'pnp', phase_order: null },
        { id: 9, slug: 'cleaning', display_name: 'Limpeza', category: 'support', requires_product: false, flow: 'support', phase_order: null },
      ],
    });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toMatch(/FLUXO PRODUÇÃO/);
    expect(r.userContent).toMatch(/FLUXO PICKING & PACKING/);
    expect(r.userContent).toMatch(/FLUXO SUPORTE/);
    expect(r.userContent).toContain('[fase 1]'); // ordem da fase de produção
  });

  test('mensagens do canal em ordem cronológica', async () => {
    const db = makeFakeDb({
      channelMsgs: [ // vêm DESC do DB
        { slack_ts: '3', raw_text: 'terceira', created_at: '2026-05-20T12:00:00.000Z', person_id: 4, display_name: 'Vitor' },
        { slack_ts: '2', raw_text: 'segunda', created_at: '2026-05-20T11:00:00.000Z', person_id: 6, display_name: 'Ana' },
        { slack_ts: '1', raw_text: 'primeira', created_at: '2026-05-20T10:00:00.000Z', person_id: null, display_name: null },
      ],
    });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    const uc = r.userContent;
    expect(uc.indexOf('primeira')).toBeLessThan(uc.indexOf('segunda'));
    expect(uc.indexOf('segunda')).toBeLessThan(uc.indexOf('terceira'));
    expect(uc).toContain('(não resolvido): primeira');
  });

  test('correções relevantes filtradas por keyword', async () => {
    const db = makeFakeDb({
      corrections: [
        { original_interpretation: { interpretation: 'formulação iniciada' }, corrected_interpretation: { interpretation: 'era mix' }, correction_note: 'confundiu formulação' },
        { original_interpretation: { interpretation: 'limpeza do chão' }, corrected_interpretation: { interpretation: 'organização' }, correction_note: 'limpeza vs organizacao' },
      ],
    });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toContain('CORREÇÕES RECENTES');
    expect(r.userContent).toContain('confundiu formulação'); // match 'formulação'
    expect(r.userContent).not.toContain('limpeza vs organizacao'); // sem match
  });

  test('vocabulário confirmado incluído', async () => {
    const db = makeFakeDb({ vocab: [{ term: 'fita', meaning: 'etiqueta', category: 'activity' }] });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toMatch(/"fita" = etiqueta/);
  });

  test('perfil de linguagem incluído quando existe', async () => {
    const db = makeFakeDb({ profile: { message_style: 'curto', abbreviation_map: { rev: 'revisão' }, common_phrases: null } });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toContain('PERFIL DE LINGUAGEM DO AUTOR');
    expect(r.userContent).toContain('estilo: curto');
  });
});

describe('V3 §2.7 — omissão de seções vazias', () => {
  test('sem batches/produtos/correções/vocab/perfil → seções omitidas', async () => {
    const pb = new PromptBuilder({ db: makeFakeDb() });
    const r = await pb.buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).not.toContain('BATCHES ATIVOS');
    expect(r.userContent).not.toContain('PRODUTOS');
    expect(r.userContent).not.toContain('CORREÇÕES RECENTES');
    expect(r.userContent).not.toContain('VOCABULÁRIO');
    expect(r.userContent).not.toContain('PERFIL DE LINGUAGEM');
    // mas sempre tem AUTOR e MENSAGEM
    expect(r.userContent).toContain('AUTOR DA MENSAGEM');
    expect(r.userContent).toContain('MENSAGEM A INTERPRETAR');
  });
});

describe('V3 §2.7 — autor', () => {
  test('autor resolvido reflete person_id, método e confiança', async () => {
    const db = makeFakeDb({ persons: [{ id: 6, display_name: 'Ana', role: 'operator' }] });
    const r = await new PromptBuilder({ db }).buildContext(MSG, { author: AUTHOR });
    expect(r.userContent).toMatch(/person_id=6 "Ana" \(operator\)/);
    expect(r.userContent).toContain('resolvido por llm_identified, confiança high');
  });

  test('admin_intervention → instrução de NÃO criar event', async () => {
    const db = makeFakeDb({ persons: [{ id: 1, display_name: 'Bruno Camp', role: 'owner' }] });
    const r = await new PromptBuilder({ db }).buildContext(MSG, {
      author: { person_id: 1, resolution_method: 'admin_intervention', confidence: 'high', is_admin_context: true },
    });
    expect(r.userContent).toMatch(/ADMIN.*SUPERVISÃO/);
    expect(r.userContent).toContain('NÃO crie event');
  });

  test('autor não resolvido → marca como desconhecido', async () => {
    const r = await new PromptBuilder({ db: makeFakeDb() }).buildContext(MSG, { author: { person_id: null } });
    expect(r.userContent).toContain('NÃO resolvido');
  });
});

describe('V3 §2.7 — rankCorrections', () => {
  test('ordena por nº de keywords batendo e respeita o limite', () => {
    const corr = [
      { original_interpretation: { t: 'formulação plant sterols' }, correction_note: 'sterols' },
      { original_interpretation: { t: 'limpeza' }, correction_note: '' },
      { original_interpretation: { t: 'plant' }, correction_note: '' },
    ];
    const ranked = rankCorrections('comecei formulação plant sterols', corr, 2);
    expect(ranked).toHaveLength(2);
    expect(JSON.stringify(ranked[0])).toContain('formulação plant sterols');
  });
  test('mensagem sem keywords → nenhuma correção', () => {
    expect(rankCorrections('ok', [{ original_interpretation: { t: 'x' } }])).toEqual([]);
  });
});
