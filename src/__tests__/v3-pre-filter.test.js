'use strict';
// HEALTHFARE V3 — PARTE 2.2 — testes comportamentais do pré-filtro.
const {
  classifyForFilter, smallTalkKind, isEmojiOnly, detectBurst, skippedResult,
  BURST_COUNT,
} = require('../v3/llm/pre-filter');

const msg = (text, slack_user_id = 'U_ANA', ts = '1779219330.000000') => ({ text, slack_user_id, ts });

describe('V3 §2.2 — bot_self', () => {
  test('mensagem do bot é bot_self', () => {
    const r = classifyForFilter(msg('qualquer coisa', 'U_BOT'), { botUserId: 'U_BOT' });
    expect(r.category).toBe('bot_self');
  });
  test('mensagem de operador NÃO é bot_self', () => {
    expect(classifyForFilter(msg('linha de producao'), { botUserId: 'U_BOT' }).category).toBe('pass_to_llm');
  });
});

describe('V3 §2.2 — small_talk', () => {
  test("'ok' / 'obrigada' / 'thanks' são small_talk (case insensitive)", () => {
    expect(classifyForFilter(msg('ok')).category).toBe('small_talk');
    expect(classifyForFilter(msg('OK')).category).toBe('small_talk');
    expect(classifyForFilter(msg('Obrigada')).category).toBe('small_talk');
    expect(classifyForFilter(msg('thanks')).category).toBe('small_talk');
  });
  test('risada (kkk, hahaha, rsrs) é small_talk', () => {
    expect(smallTalkKind('kkkk')).toBe('laughter');
    expect(smallTalkKind('hahaha')).toBe('laughter');
    expect(smallTalkKind('rsrs')).toBe('laughter');
  });
  test('emoji único é small_talk', () => {
    expect(classifyForFilter(msg('😂')).category).toBe('small_talk');
    expect(classifyForFilter(msg('👍')).detail).toBe('emoji_only');
    expect(classifyForFilter(msg(':joy:')).category).toBe('small_talk');
  });
  test("mensagem < 3 chars é small_talk ('oi' = 2 chars)", () => {
    expect(smallTalkKind('oi')).toBe('too_short');
    expect(classifyForFilter(msg('oi')).category).toBe('small_talk');
  });
  test('mensagem vazia é small_talk (empty)', () => {
    expect(smallTalkKind('')).toBe('empty');
    expect(smallTalkKind('   ')).toBe('empty');
  });
});

describe('V3 §2.2 — o que NÃO é small_talk', () => {
  test("'sim'/'não'/'nao'/'yes'/'no' são respostas legítimas → pass_to_llm", () => {
    for (const t of ['sim', 'não', 'nao', 'yes', 'no', 'NÃO']) {
      expect(smallTalkKind(t)).toBeNull();
      expect(classifyForFilter(msg(t)).category).toBe('pass_to_llm');
    }
  });
  test('mensagem mista (texto + emoji) NÃO é small_talk', () => {
    expect(isEmojiOnly('linha 😂')).toBe(false);
    expect(classifyForFilter(msg('terminei a linha 👍')).category).toBe('pass_to_llm');
  });
  test('ASCII art / tabela NÃO é small_talk', () => {
    const table = '| Rutin | 684 |\n| Plant | 720 |';
    expect(smallTalkKind(table)).toBeNull();
    expect(classifyForFilter(msg(table)).category).toBe('pass_to_llm');
  });
  test('frase de produção real → pass_to_llm', () => {
    expect(classifyForFilter(msg('comecei formulação do Plant Sterols 0136')).category).toBe('pass_to_llm');
  });
});

describe('V3 §2.2 — burst_member', () => {
  // textos substantivos (>=3 chars, não small_talk) — senão caem em
  // small_talk antes de chegar no burst (precedência correta).
  test('5+ msgs do mesmo user em 10s → burst_member, coalesce', () => {
    const recent = [
      msg('comecei linha', 'U_VITOR', '1779219330.000000'),
      msg('parei pra mix', 'U_VITOR', '1779219332.000000'),
      msg('voltei linha', 'U_VITOR', '1779219334.000000'),
      msg('mais um lote', 'U_VITOR', '1779219336.000000'),
    ];
    const cur = msg('terminei agora', 'U_VITOR', '1779219338.000000'); // 8s span, 5 msgs
    const r = classifyForFilter(cur, { recentUserMessages: recent });
    expect(r.category).toBe('burst_member');
    expect(r.batch).toHaveLength(BURST_COUNT);
    expect(r.batch.map((m) => m.text)).toEqual([
      'comecei linha', 'parei pra mix', 'voltei linha', 'mais um lote', 'terminei agora',
    ]); // ordenado por ts
  });

  test('< 5 msgs → pass_to_llm (não é burst)', () => {
    const recent = [
      msg('comecei linha', 'U_VITOR', '1779219330.000000'),
      msg('parei pra mix', 'U_VITOR', '1779219332.000000'),
      msg('voltei linha', 'U_VITOR', '1779219334.000000'),
    ];
    const r = classifyForFilter(msg('mais um lote', 'U_VITOR', '1779219336.000000'), { recentUserMessages: recent });
    expect(r.category).toBe('pass_to_llm');
  });

  test('5 msgs mas span > 10s → pass_to_llm (fora da janela)', () => {
    const recent = [
      msg('comecei linha', 'U_VITOR', '1779219300.000000'), // 45s antes
      msg('parei pra mix', 'U_VITOR', '1779219332.000000'),
      msg('voltei linha', 'U_VITOR', '1779219334.000000'),
      msg('mais um lote', 'U_VITOR', '1779219336.000000'),
    ];
    const cur = msg('terminei agora', 'U_VITOR', '1779219345.000000'); // a 1ª fica fora → só 4 na janela
    expect(classifyForFilter(cur, { recentUserMessages: recent }).category).toBe('pass_to_llm');
  });

  test('users diferentes na mesma janela NÃO coalescem entre si', () => {
    const recent = [
      msg('outro user um', 'U_OUTRO', '1779219330.000000'),
      msg('outro user dois', 'U_OUTRO', '1779219331.000000'),
      msg('outro user tres', 'U_OUTRO', '1779219332.000000'),
      msg('outro user quatro', 'U_OUTRO', '1779219333.000000'),
      msg('comecei linha', 'U_VITOR', '1779219334.000000'),
    ];
    // Vitor mandou só 2 — os 4 do U_OUTRO não contam.
    const r = classifyForFilter(msg('voltei linha', 'U_VITOR', '1779219335.000000'), { recentUserMessages: recent });
    expect(r.category).toBe('pass_to_llm');
  });

  test('detectBurst retorna null sem mensagens suficientes', () => {
    expect(detectBurst(msg('trabalhando sozinho', 'U_ANA'), [])).toBeNull();
  });
});

describe('V3 §2.2 — precedência e skippedResult', () => {
  test('small_talk vence burst (5 "ok" seguidos são small_talk, não burst)', () => {
    const recent = ['1779219330', '1779219331', '1779219332', '1779219333']
      .map((t) => msg('ok', 'U_ANA', t + '.000000'));
    const r = classifyForFilter(msg('ok', 'U_ANA', '1779219334.000000'), { recentUserMessages: recent });
    expect(r.category).toBe('small_talk');
  });
  test('skippedResult monta o llm_result de descarte', () => {
    expect(skippedResult('bot_self')).toEqual({ skipped: 'bot_self', detail: null, pre_filter: true });
    expect(skippedResult('small_talk', 'laughter'))
      .toEqual({ skipped: 'small_talk', detail: 'laughter', pre_filter: true });
  });
});
