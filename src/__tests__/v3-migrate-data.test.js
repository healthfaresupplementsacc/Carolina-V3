'use strict';
// HEALTHFARE V3 — PARTE 2.11 — testes da lógica pura de v3-migrate-data.
const {
  planSupplements, parseAliases,
  PERSONS_SEED, SHARED_ACCOUNTS_SEED, SHARED_USERS_SEED,
  ACTIVITY_TYPES_SEED, SETTINGS_SEED,
} = require('../../scripts/v3-migrate-data');

describe('V3 §2.11 — parseAliases', () => {
  test('quebra texto vírgula-separado, trim, sem vazios', () => {
    expect(parseAliases('Panax Ginseng, panax,  ginsen ,, ginseng'))
      .toEqual(['Panax Ginseng', 'panax', 'ginsen', 'ginseng']);
    expect(parseAliases('')).toEqual([]);
    expect(parseAliases(null)).toEqual([]);
  });
});

describe('V3 §2.11 — planSupplements (consolidação 3a)', () => {
  test('supplements + catalog sem overlap → soma, 0 consolidados', () => {
    const sup = [
      { id: 1, name: 'Rutin', canonical_name: 'Rutin' },
      { id: 2, name: 'Plant', canonical_name: 'Plant' },
    ];
    const cat = [{ id: 1, canonical_name: 'Panax', aliases: 'panax, ginseng' }];
    const { products, consolidated } = planSupplements(sup, cat);
    expect(products).toHaveLength(3);
    expect(consolidated).toHaveLength(0);
  });

  test('overlap (mesmo nome em supplements e catalog) → funde em 1 + reporta', () => {
    const sup = [{ id: 1, name: 'Panax', canonical_name: 'Panax' }];
    const cat = [{ id: 1, canonical_name: 'Panax', aliases: 'Panax Ginseng, ginseng' }];
    const { products, consolidated } = planSupplements(sup, cat);
    expect(products).toHaveLength(1);
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].canonical_name).toBe('Panax');
  });

  test('aliases do catalog parseados; alias == canonical é descartado', () => {
    const { products } = planSupplements([], [
      { id: 1, canonical_name: 'Panax', aliases: 'Panax, panax, ginseng' },
    ]);
    expect(products[0].aliases).toEqual(['ginseng']); // 'Panax'/'panax' == canonical → fora
  });

  test('supplement com name != canonical_name → name vira alias', () => {
    const { products } = planSupplements([
      { id: 1, name: 'Plant', canonical_name: 'Plant Sterols' },
    ], []);
    expect(products[0].canonical_name).toBe('Plant Sterols');
    expect(products[0].aliases).toEqual(['Plant']);
  });
});

describe('V3 §2.11 — seeds autoritativos (ITEM 1)', () => {
  test('PERSONS_SEED: 7 pessoas — 2 owner, 1 manager, 4 operator', () => {
    expect(PERSONS_SEED).toHaveLength(7);
    const byRole = (r) => PERSONS_SEED.filter((p) => p.role === r).length;
    expect(byRole('owner')).toBe(2);
    expect(byRole('manager')).toBe(1);
    expect(byRole('operator')).toBe(4);
  });

  test('PERSONS_SEED: Ana e Bruno Sarmento sem slack_user_id; Vitor/Simone com', () => {
    const get = (n) => PERSONS_SEED.find((p) => p.display_name === n);
    expect(get('Ana').slack_user_id).toBeNull();
    expect(get('Bruno Sarmento').slack_user_id).toBeNull();
    expect(get('Vitor').slack_user_id).toBe('U08JC85HMNE');
    expect(get('Henrique').role).toBe('manager');
  });

  test('SHARED_ACCOUNTS_SEED: 3 contas, Production Line sem owner', () => {
    expect(SHARED_ACCOUNTS_SEED).toHaveLength(3);
    expect(SHARED_ACCOUNTS_SEED.filter((s) => !s.primary_owner)).toHaveLength(1);
    const pl = SHARED_ACCOUNTS_SEED.find((s) => s.description === 'Production Line');
    expect(pl.primary_owner).toBeNull();
    expect(pl.slack_dm_id).toBe('D0B5YDY3S8G');
  });

  test('SHARED_USERS_SEED: 4 operators (admins nunca entram)', () => {
    expect(SHARED_USERS_SEED).toHaveLength(4);
    expect(SHARED_USERS_SEED.map((u) => u.person).sort())
      .toEqual(['Ana', 'Bruno Sarmento', 'Simone', 'Vitor']);
  });

  test('ACTIVITY_TYPES_SEED: 18 tipos, categorias válidas', () => {
    expect(ACTIVITY_TYPES_SEED).toHaveLength(18);
    const cats = new Set(ACTIVITY_TYPES_SEED.map((a) => a.category));
    expect([...cats].sort()).toEqual(['meta', 'production_phase', 'support']);
  });

  test('SETTINGS_SEED: 16 chaves, observer em shadow, modelo Sonnet 4.6', () => {
    expect(SETTINGS_SEED).toHaveLength(16);
    const get = (k) => SETTINGS_SEED.find((s) => s.key === k).value;
    expect(get('llm_observer_mode')).toBe('shadow');
    expect(get('llm_model')).toBe('claude-sonnet-4-6');
    expect(get('llm_provider')).toBe('anthropic');
  });
});
