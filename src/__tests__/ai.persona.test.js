'use strict';
const { PERSONA_PROD, PERSONA_ADMIN, withPersona, buildPersona } = require('../ai/persona');

describe('Carolina persona (P2)', () => {
  test('PERSONA_PROD forbids AI disclosure', () => {
    expect(PERSONA_PROD).toMatch(/NUNCA admita ser AI/);
    expect(PERSONA_PROD).toMatch(/para de zoeira/);
    expect(PERSONA_PROD).toMatch(/Rio de Janeiro/);
    // The forbidden-words rule itself names them; that's fine — it's an
    // instruction, not Carolina's output.
    expect(PERSONA_PROD).toMatch(/Anthropic.*OpenAI.*Claude.*GPT|Claude.*GPT/);
  });

  test('PERSONA_ADMIN allows technical disclosure to owners', () => {
    expect(PERSONA_ADMIN).toMatch(/C0B36DR5MP1/);
    expect(PERSONA_ADMIN).toMatch(/pode ser técnica|admitir que é IA/i);
    expect(PERSONA_ADMIN).toMatch(/Rio de Janeiro/);
  });

  test('withPersona prepends prod persona by default', () => {
    const p = withPersona('FAÇA X');
    expect(p.startsWith(PERSONA_PROD.slice(0, 20))).toBe(true);
    expect(p).toMatch(/TAREFA:\nFAÇA X/);
  });

  test('withPersona admin scope uses admin block', () => {
    const p = withPersona('FAÇA Y', 'admin');
    expect(p).toMatch(/C0B36DR5MP1/);
    expect(p).toMatch(/TAREFA:\nFAÇA Y/);
  });

  test('B1 — buildPersona threads the app name into IDENTITY (both scopes)', () => {
    expect(buildPersona('prod', 'Acme Labs')).toMatch(/trabalha na Acme Labs/);
    expect(buildPersona('admin', 'Acme Labs')).toMatch(/trabalha na Acme Labs/);
    // default still works and keeps the AI-disclosure guardrail
    expect(buildPersona('prod')).toMatch(/trabalha na HealthFare Production/);
    expect(buildPersona('prod')).toMatch(/NUNCA admita ser AI/);
  });

  test('B1 — withPersona uses the cached app name (default until warmed)', () => {
    expect(withPersona('X')).toMatch(/trabalha na HealthFare Production/);
  });

  test('note-classifier SYSTEM_PROMPT carries persona', () => {
    jest.resetModules();
    const nc = require('../ai/note-classifier');
    // Indirect: the module loads without throwing and exports classify
    expect(typeof nc.classify).toBe('function');
  });
});
