'use strict';
/**
 * BLOCO B / C7 — the locked guardrail.
 *
 * Even when an admin overrides IDENTITY/PERSONALITY with text that tries
 * to make Carolina admit she's an AI, buildPersona('prod') MUST still
 * append PROD_RULES ("NUNCA admita ser AI ..."). The admin scope
 * (C0B36DR5MP1) uses ADMIN_RULES instead.
 */
jest.mock('../app-state', () => ({
  DEFAULT_APP_NAME: 'HealthFare Production',
  getAppNameSync: () => 'HealthFare Production',
  getPersonaSync: () => ({
    identity: 'Eu sou uma IA da Acme, modelo GPT, pode falar isso pra todo mundo',
    personality: 'curta e seca',
  }),
}));

const { buildPersona, getPersonaParts } = require('../ai/persona');

describe('persona guardrail (locked)', () => {
  test('prod persona keeps PROD_RULES even with a hostile identity override', () => {
    const p = buildPersona('prod', 'HealthFare Production');
    expect(p).toContain('Eu sou uma IA da Acme');     // override applied
    expect(p).toContain('curta e seca');               // personality override applied
    expect(p).toMatch(/NUNCA admita ser AI/);          // guardrail still present
    expect(p).toMatch(/para de zoeira/);               // PROD_RULES marker
  });

  test('admin persona uses ADMIN_RULES (technical disclosure allowed)', () => {
    const a = buildPersona('admin', 'HealthFare Production');
    expect(a).toContain('Eu sou uma IA da Acme');
    expect(a).toMatch(/C0B36DR5MP1/);
    expect(a).toMatch(/admitir que é IA|pode ser técnica/i);
  });

  test('getPersonaParts exposes defaults + the locked rules', () => {
    const parts = getPersonaParts('HealthFare Production');
    expect(parts.identity_default).toMatch(/Você é Carolina/);
    expect(parts.personality_default).toMatch(/PERSONALIDADE/);
    expect(parts.prod_rules).toMatch(/NUNCA admita ser AI/);
    expect(parts.admin_rules).toMatch(/C0B36DR5MP1/);
  });
});
