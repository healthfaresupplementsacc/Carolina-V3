'use strict';
// classify() — parser as a CLASSIFIER producing EventoCanônico (FASE 1 P3).
// Uses the REAL Part-2 resolveOperator with an injected operators roster
// (no DB), so this exercises the true integration.
const { classify } = require('../index');

const OPS = [
  { id: 1,   name: 'Ana',            aliases: '', role: 'operator', slack_user_id: null,          is_shared_account: false },
  { id: 2,   name: 'Bruno Sarmento', aliases: '', role: 'operator', slack_user_id: null,          is_shared_account: false },
  { id: 3,   name: 'Vitor Leite',    aliases: '', role: 'operator', slack_user_id: 'U08JC85HMNE', is_shared_account: false },
  { id: 4,   name: 'Simone',         aliases: '', role: 'operator', slack_user_id: 'U07FG34TMPF', is_shared_account: false },
];
const PC = 'U0AU8N8FA00';
const SIMONE = 'U07FG34TMPF';

function msg(text, opts = {}) {
  return {
    ts: opts.ts || '1779120923.000100',
    user: opts.user || PC,
    text,
    username: opts.username || null,
  };
}
const DEPS = { resolveDeps: { loadOperators: async () => OPS, recentMessages: async () => [] } };
const run = (text, opts) => classify(msg(text, opts), DEPS);

describe('classify — spec 3.4 mandatory cases', () => {
  test('"Ana_ F: linha do Rutin 0138" → 1 finish, supplement Rutin, Ana (underscore prefix)', async () => {
    const evs = await run('Ana_ F: linha do Rutin 0138');
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('finish');
    expect(evs[0].supplement).toBe('Rutin');
    expect(evs[0].operator_id).toBe(1);
    expect(evs[0].source_type).toBe('parser');
    expect(evs[0].source_id).toBe('1779120923.000100');
  });

  test('"S: Double Check Rutin E fechando caixas" → 2 eventos (start Rutin + 2ª ação)', async () => {
    const evs = await run('S: Double Check Rutin E fechando caixas');
    expect(evs.length).toBe(2);
    expect(evs[0].type).toBe('start');
    expect(evs[0].supplement).toBe('Rutin');
    expect(['start', 'ad_hoc_start']).toContain(evs[1].type);
    expect(evs[1].metadata.multiAction).toBe(true);
  });

  test('"F: Formulacao e revisao parcial Plant" → 1 finish (L-10: F-tag manda sobre "formulacao")', async () => {
    const evs = await run('F: Formulacao e revisao parcial Plant');
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('finish'); // NOT formulation_start (L-10 fix)
  });

  test('"F: Formulacao Plant Sterols 0134" → finish + supplement resolvido', async () => {
    const evs = await run('F: Formulacao Plant Sterols 0134');
    expect(evs[0].type).toBe('finish');
    expect(evs[0].supplement).toBe('Plant Sterols');
    expect(evs[0].batch).toBe('0134');
  });

  test('mensagem sem padrão claro → type note, raw_text preservado (NUNCA descarta)', async () => {
    const txt = 'a maquina ta fazendo um barulho estranho hoje de manha';
    const evs = await run(txt);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('note');
    expect(evs[0].raw_text).toBe(txt);
  });
});

describe('classify — robustness fixes', () => {
  test('"retorno almoco" da Simone → break_end (fix do bug 14:22)', async () => {
    const evs = await run('retorno almoco', { user: SIMONE });
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('break_end');
    expect(evs[0].operator_id).toBe(4); // Simone (dono da conta)
  });

  test('"Pausa para almoço" → break_start', async () => {
    const evs = await run('Pausa para almoço', { user: SIMONE });
    expect(evs[0].type).toBe('break_start');
  });

  test('"S- ajudando na linha de produção do Plant" → helping_start', async () => {
    const evs = await run('S- ajudando na linha de produção do Plant', { user: SIMONE });
    expect(evs[0].type).toBe('helping_start');
  });

  test('count message maps to count', async () => {
    const evs = await run('P: 320', { user: SIMONE });
    expect(evs[0].type).toBe('count');
  });

  test('ambiguous operator: shared PC, no prefix, real content → note with operator_id null', async () => {
    const evs = await run('colocando as label das ordens nos envelopes');
    expect(evs).toHaveLength(1);
    expect(evs[0].operator_id).toBeNull(); // ambiguous → dispatcher asks admin
  });

  test('trivial noise (short / "estoque real") → discarded as []', async () => {
    expect(await run('ok')).toEqual([]);
    expect(await run('estoque real atualizado')).toEqual([]);
  });

  test('resolveOperator throwing does NOT drop the event (falls to note/null)', async () => {
    const evs = await classify(msg('linha parada de novo aqui'), {
      resolveOperator: async () => { throw new Error('db down'); },
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].operator_id).toBeNull();
    expect(evs[0].type).toBe('note');
  });
});

describe('classify — every event is a valid EventoCanônico', () => {
  const { validateEvent } = require('../../dispatcher/event-schema');
  test('start/finish/break/note all validate', async () => {
    for (const t of [
      'Ana- S: Rutin 0138',
      'Ana- F: Rutin 0138',
      'Pausa almoço',
      'so uma observacao qualquer aqui sobre a linha',
    ]) {
      const evs = await run(t);
      for (const ev of evs) expect(validateEvent(ev).ok).toBe(true);
    }
  });
});
