'use strict';
/* Fase E (BUG #4) — parseQueryFilters: filtro semântico do query_status. */
const { CommandHandler } = require('../v3/services/CommandHandler');

const PERSONS = [
  { id: 4, display_name: 'Vitor HealthFare' },
  { id: 5, display_name: 'Simone' },
  { id: 6, display_name: 'Ana' },
  { id: 7, display_name: 'Bruno Sarmento' },
];
const parse = (q) => CommandHandler.parseQueryFilters(q, PERSONS);

describe('Fase E — parseQueryFilters', () => {
  test('"quem está na linha de produção agora?" → grupo production_line', () => {
    const f = parse('quem está na linha de produção agora?');
    expect(f.slugs).toContain('production_line');
    expect(f.slugs).toContain('review');
    expect(f.personId).toBeNull();
  });

  test('"quem está formulando?" → grupo formulação', () => {
    const f = parse('quem está formulando?');
    expect(f.slugs).toEqual(['formulation', 'mixing', 'encapsulation', 'material_handling']);
  });

  test('"alguém na limpeza?" → cleaning', () => {
    expect(parse('alguém na limpeza?').slugs).toEqual(['cleaning']);
  });

  test('"como estão as ordens/embalagem?" → grupo P&P', () => {
    expect(parse('como estão as ordens?').slugs).toContain('packaging');
    expect(parse('quem ta na embalagem').slugs).toContain('labeling');
  });

  test('"o que o Vitor está fazendo?" → personId=4 sem slug', () => {
    const f = parse('o que o Vitor está fazendo?');
    expect(f.personId).toBe(4);
    expect(f.slugs).toBeNull();
  });

  test('"a Simone ta na linha?" → personId + slugs juntos', () => {
    const f = parse('a Simone ta na linha?');
    expect(f.personId).toBe(5);
    expect(f.slugs).toContain('production_line');
  });

  test('acentos não importam ("produção" vs "producao")', () => {
    expect(parse('quem ta na producao').slugs).toContain('production_line');
  });

  test('sem keyword → tudo null (default flow=production)', () => {
    const f = parse('quem está trabalhando?');
    expect(f.slugs).toBeNull();
    expect(f.personId).toBeNull();
  });

  test('"quem foi almoçar?" → lunch/break', () => {
    expect(parse('quem foi almoçar?').slugs).toEqual(['lunch', 'break']);
  });
});
