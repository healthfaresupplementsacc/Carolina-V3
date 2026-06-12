'use strict';
/* Tests da máquina de estados pura da Operator Page (UMD → node). */
const SM = require('../op/state-machine');

const step = (state, event, draft, payload) => SM.transition(state, event, { draft }, payload);

describe('Operator Page — state machine', () => {
  test('inicial é LOGGED_OUT; LOGIN_OK → IDLE', () => {
    expect(SM.INITIAL).toBe('LOGGED_OUT');
    expect(step('LOGGED_OUT', 'LOGIN_OK').state).toBe('IDLE');
  });

  test('START_NEW → PICK_GROUP com draft zerado', () => {
    const r = step('IDLE', 'START_NEW');
    expect(r.state).toBe('PICK_GROUP');
    expect(r.draft).toEqual(SM.emptyDraft());
  });

  test('PICK_GROUP → PICK_TYPE guardando o grupo', () => {
    const g = { key: 'linha', label: 'Linha' };
    const r = step('PICK_GROUP', 'PICK_GROUP', SM.emptyDraft(), g);
    expect(r.state).toBe('PICK_TYPE');
    expect(r.draft.group).toBe(g);
  });

  test('PICK_TYPE com requires_product → PICK_SUPPLEMENT', () => {
    const t = { slug: 'production_line', requires_product: true };
    const r = step('PICK_TYPE', 'PICK_TYPE', SM.emptyDraft(), t);
    expect(r.state).toBe('PICK_SUPPLEMENT');
  });

  test('PICK_TYPE sem requires_product → CONFIRM direto (cleaning)', () => {
    const t = { slug: 'cleaning', requires_product: false };
    const r = step('PICK_TYPE', 'PICK_TYPE', SM.emptyDraft(), t);
    expect(r.state).toBe('CONFIRM');
    expect(r.draft.type).toBe(t);
  });

  test('SUPPLEMENT → BATCH → CONFIRM (pick e skip)', () => {
    const s1 = step('PICK_SUPPLEMENT', 'PICK_SUPPLEMENT', SM.emptyDraft(), { id: 1 });
    expect(s1.state).toBe('PICK_BATCH');
    expect(step('PICK_BATCH', 'PICK_BATCH', s1.draft, { batch_number: '0190' }).state).toBe('CONFIRM');
    expect(step('PICK_BATCH', 'SKIP_BATCH', s1.draft).state).toBe('CONFIRM');
    expect(step('PICK_BATCH', 'SKIP_BATCH', s1.draft).draft.batch).toBeNull();
  });

  test('BACK navega reverso: CONFIRM(c/ produto)→BATCH; BATCH→SUPPLEMENT; TYPE→GROUP', () => {
    const draft = { ...SM.emptyDraft(), type: { requires_product: true }, supplement: { id: 1 }, batch: { batch_number: '0190' } };
    expect(step('CONFIRM', 'BACK', draft).state).toBe('PICK_BATCH');
    expect(step('PICK_BATCH', 'BACK', draft).state).toBe('PICK_SUPPLEMENT');
    expect(step('PICK_TYPE', 'BACK', draft).state).toBe('PICK_GROUP');
  });

  test('CONFIRM sem produto → BACK volta pra PICK_TYPE', () => {
    const draft = { ...SM.emptyDraft(), type: { requires_product: false } };
    expect(step('CONFIRM', 'BACK', draft).state).toBe('PICK_TYPE');
  });

  test('CONFIRM_OK → IDLE com draft limpo', () => {
    const draft = { ...SM.emptyDraft(), type: { slug: 'cleaning' }, note: 'x' };
    const r = step('CONFIRM', 'CONFIRM_OK', draft);
    expect(r.state).toBe('IDLE');
    expect(r.draft).toEqual(SM.emptyDraft());
  });

  test('AUTO_TIMEOUT e LOGOUT derrubam de QUALQUER estado', () => {
    for (const st of ['IDLE', 'PICK_GROUP', 'PICK_TYPE', 'PICK_SUPPLEMENT', 'PICK_BATCH', 'CONFIRM', 'CLOCK_OUT']) {
      expect(step(st, 'AUTO_TIMEOUT').state).toBe('LOGGED_OUT');
      expect(step(st, 'LOGOUT').state).toBe('LOGGED_OUT');
    }
  });

  test('CANCEL volta pra IDLE de qualquer modal', () => {
    for (const st of ['PICK_GROUP', 'PICK_TYPE', 'PICK_SUPPLEMENT', 'PICK_BATCH', 'CONFIRM']) {
      expect(step(st, 'CANCEL').state).toBe('IDLE');
    }
  });

  test('clock-out: IDLE → CLOCK_OUT → DONE → LOGGED_OUT', () => {
    expect(step('IDLE', 'OPEN_CLOCK_OUT').state).toBe('CLOCK_OUT');
    expect(step('CLOCK_OUT', 'CLOCK_OUT_DONE').state).toBe('LOGGED_OUT');
    expect(step('CLOCK_OUT', 'BACK').state).toBe('IDLE');
  });

  test('evento irrelevante não muda nada', () => {
    const r = step('IDLE', 'PICK_BATCH', SM.emptyDraft(), {});
    expect(r.state).toBe('IDLE');
  });
});

describe('Operator Page — searchSupplements (autocomplete local)', () => {
  const LIST = [
    { id: 1, canonical_name: 'Magnesium Glycinate', aliases: ['glycinate', 'mag gly'], last_used_at: '2026-06-10T00:00:00Z' },
    { id: 2, canonical_name: 'Magnesium Citrate', aliases: [], last_used_at: null },
    { id: 3, canonical_name: 'Berberine', aliases: ['berb'], last_used_at: '2026-06-11T00:00:00Z' },
    { id: 4, canonical_name: 'Ácido Hialurônico', aliases: ['hyaluronic'], last_used_at: null },
  ];

  test('prefix match vence substring; uso recente desempata', () => {
    const r = SM.searchSupplements(LIST, 'mag');
    expect(r[0].id).toBe(1); // prefix + mais usado
    expect(r[1].id).toBe(2);
  });

  test('alias funciona', () => {
    expect(SM.searchSupplements(LIST, 'berb')[0].id).toBe(3);
    expect(SM.searchSupplements(LIST, 'hyalu')[0].id).toBe(4);
  });

  test('acentos normalizados (acido acha Ácido)', () => {
    expect(SM.searchSupplements(LIST, 'acido')[0].id).toBe(4);
  });

  test('query vazia → todos (até 20), ordenado por uso', () => {
    const r = SM.searchSupplements(LIST, '');
    expect(r).toHaveLength(4);
    expect(r[0].id).toBe(3); // mais recente
  });

  test('sem match → vazio', () => {
    expect(SM.searchSupplements(LIST, 'zzz')).toHaveLength(0);
  });
});
