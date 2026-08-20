'use strict';
/**
 * TIMELINE / PAUSA — splitByPauses.
 *
 * Bruno 08-20: "a pausa ficava na mesma linha do tempo e pausava o q a pessoa
 * estivesse fazendo, no meio iria ter uma pausa, e quando a pessoa terminasse a
 * pausa reativava o q ele tava fazendo (...) tudo numa linha so, e a mesma
 * coisa deveria acontecer pra todos os coworkers que joined essa pausa."
 *
 * Os cenários abaixo são os REAIS de 19 e 20 de agosto de 2026 (eventos 3578,
 * 3583, 3575, 3576 e a linha do Vitor do dia 20), no shape que o dashboard
 * recebe do adapter (minutos do dia NY).
 */

const path = require('path');
const TP = require(path.join(__dirname, '..', '..',
  'dashboard-v4', 'src', 'components', 'timeline-pause.cjs'));

const { splitByPauses, segmentsByEvent, isPause, joinMin } = TP;

/** helper: HH:MM -> minutos do dia */
const M = (h, m) => h * 60 + (m || 0);

/** helper: monta um evento no shape do adapter V4 */
function ev(id, activity, start, end, extra) {
  return Object.assign({
    id, op: 'p4', activity,
    started_min: start, ended_min: end,
    description: '', cowork: [],
    _total_paused_seconds: 0,
  }, extra || {});
}

/** só os segmentos desenháveis de um evento, em ordem */
const drawn = (split, eventId) =>
  split.segments.filter((s) => s.event_id === eventId && !s.zero_width);

describe('splitByPauses — pareamento pausa × tarefa congelada', () => {

  /* ── (a) VITOR 19/08 — evento 3578 + pausa 3583 ────────────────────────
     production_line 10:05 → 12:43; break 11:18 → 12:43 ("Organizando estoque
     que chegaram pallets"). A pausa termina EXATAMENTE quando a tarefa termina,
     então a cauda tem largura ZERO e não pode virar bloquinho fantasma. */
  test('(a) Vitor 19/08: pausa que termina junto com a tarefa → 1 segmento + pausa, sem ghost', () => {
    const events = [
      ev(3578, 'production_line', M(10, 5), M(12, 43), { _total_paused_seconds: 5071 }),
      ev(3583, 'break', M(11, 18), M(12, 43), { description: 'Organizando estoque que chegaram pallets' }),
    ];
    const r = splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) });

    expect(r.frozenBy[3578]).toEqual([3583]);
    expect(r.frozenIds.has(3578)).toBe(true);

    const segs = drawn(r, 3578);
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(M(10, 5));
    expect(segs[0].end).toBe(M(11, 18));
    expect(segs[0].is_first).toBe(true);
    expect(segs[0].is_continuation).toBe(false);

    // a cauda existe no resultado, mas marcada zero_width (não desenha)
    const ghosts = r.segments.filter((s) => s.event_id === 3578 && s.zero_width);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].start).toBe(ghosts[0].end);

    // a pausa é INLINE (congelou alguém) e leva a nota
    expect(r.pauses).toHaveLength(1);
    expect(r.pauses[0]).toMatchObject({
      event_id: 3583, start: M(11, 18), end: M(12, 43), inline: true, live: false,
      note: 'Organizando estoque que chegaram pallets',
    });
    expect(r.pauses[0].freezes).toEqual([3578]);
  });

  /* ── (b) VITOR 20/08 — o caso do ASCII do Bruno ────────────────────────
     production_line 09:01 → AO VIVO; break 10:52 → 11:22 ("Descarregando
     arroz"). Tem que dar: [linha]||PAUSA||[linha continuando até agora]. */
  test('(b) Vitor 20/08: pausa no MEIO da tarefa ao vivo → segmento, pausa, segmento até agora', () => {
    const NOW = M(14, 30);
    const events = [
      ev(3616, 'production_line', M(9, 1), null, { _total_paused_seconds: 1800 }),
      ev(3620, 'break', M(10, 52), M(11, 22), { description: 'Descarregando arroz' }),
    ];
    const r = splitByPauses(events, { now: NOW, dayEnd: M(18, 0) });

    const segs = drawn(r, 3616);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: M(9, 1), end: M(10, 52), index: 0, is_first: true, is_continuation: false });
    expect(segs[1]).toMatchObject({ start: M(11, 22), end: NOW, index: 1, is_last: true, is_continuation: true });
    // o 2º segmento sabe QUAL pausa veio antes dele (pro tick sutil no render)
    expect(segs[1].pause_id_before).toBe(3620);

    const p = r.pauses[0];
    expect(p.inline).toBe(true);
    expect(p.start).toBe(M(10, 52));
    expect(p.end).toBe(M(11, 22));
    // a pausa fica ENTRE os dois segmentos, horizontalmente
    expect(segs[0].end).toBe(p.start);
    expect(segs[1].start).toBe(p.end);
  });

  test('(b2) pausa AINDA ABERTA: tarefa para no início da pausa e a pausa corre até agora', () => {
    const NOW = M(11, 40);
    const events = [
      ev(3616, 'production_line', M(9, 1), null, { _total_paused_seconds: 0 }),
      ev(3621, 'break', M(10, 52), null, { description: 'Descarregando arroz' }),
    ];
    const r = splitByPauses(events, { now: NOW, dayEnd: M(18, 0) });

    const segs = drawn(r, 3616);
    expect(segs).toHaveLength(1);           // a cauda tem largura zero (cursor = now)
    expect(segs[0].end).toBe(M(10, 52));
    expect(r.pauses[0]).toMatchObject({ live: true, start: M(10, 52), end: NOW, inline: true });
  });

  /* ── (c) BRUNO SARMENTO 19/08 — duas tarefas abertas, UMA pausa ────────
     #3575 revisão 09:50 → 13:05 e #3576 special_task, as duas abertas quando a
     pausa do Vitor pegou ele no cowork. As DUAS têm que rachar. */
  test('(c) Bruno Sarmento: uma pausa congela DUAS tarefas abertas → as duas racham', () => {
    const events = [
      ev(3575, 'review', M(9, 50), M(13, 5), { op: 'p7', _total_paused_seconds: 5071 }),
      ev(3576, 'special_task', M(10, 30), M(13, 5), { op: 'p7', _total_paused_seconds: 5071 }),
      ev(3584, 'break', M(11, 18), M(12, 43), { op: 'p7', description: 'Organizando estoque' }),
    ];
    const r = splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) });

    expect(r.frozenBy[3575]).toEqual([3584]);
    expect(r.frozenBy[3576]).toEqual([3584]);
    expect(r.pauses[0].freezes.sort()).toEqual([3575, 3576]);

    for (const id of [3575, 3576]) {
      const segs = drawn(r, id);
      expect(segs).toHaveLength(2);
      expect(segs[0].end).toBe(M(11, 18));
      expect(segs[1].start).toBe(M(12, 43));
      expect(segs[1].end).toBe(M(13, 5));
      expect(segs[1].is_continuation).toBe(true);
    }
  });

  /* ── (d) pausa que não congelou nada ───────────────────────────────────
     A pessoa não tinha tarefa aberta. Mantém o desenho de hoje (bloco solto). */
  test('(d) pausa sem tarefa aberta → inline=false, nada racha', () => {
    const events = [
      ev(3590, 'production_line', M(9, 0), M(10, 0)),
      ev(3591, 'break', M(10, 30), M(10, 45), { description: 'Banheiro' }),
    ];
    const r = splitByPauses(events, { now: M(12, 0), dayEnd: M(18, 0) });

    expect(r.frozenIds.size).toBe(0);
    expect(r.pauses[0].inline).toBe(false);
    expect(r.pauses[0].freezes).toEqual([]);
    expect(drawn(r, 3590)).toHaveLength(1);
  });

  test('(d2) tarefa que COMEÇOU depois da pausa não é congelada por ela', () => {
    const events = [
      ev(3592, 'break', M(10, 0), M(10, 20)),
      ev(3593, 'production_line', M(10, 20), M(12, 0)),
    ];
    const r = splitByPauses(events, { now: M(13, 0), dayEnd: M(18, 0) });
    expect(r.frozenIds.size).toBe(0);
    expect(r.pauses[0].inline).toBe(false);
  });

  /* ── (e) duas pausas dentro da mesma tarefa → três segmentos ──────────── */
  test('(e) duas pausas na mesma tarefa → 3 segmentos, cada pausa entre dois deles', () => {
    const events = [
      ev(3600, 'production_line', M(9, 0), M(16, 0), { _total_paused_seconds: 3600 }),
      ev(3601, 'break', M(10, 0), M(10, 30), { description: 'Caminhão' }),
      ev(3602, 'break', M(13, 0), M(13, 30), { description: 'Reunião rápida' }),
    ];
    const r = splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) });

    const segs = drawn(r, 3600);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [M(9, 0), M(10, 0)],
      [M(10, 30), M(13, 0)],
      [M(13, 30), M(16, 0)],
    ]);
    expect(segs[0].is_first).toBe(true);
    expect(segs[1].is_continuation).toBe(true);
    expect(segs[2].is_last).toBe(true);
    expect(segs[1].pause_id_before).toBe(3601);
    expect(segs[2].pause_id_before).toBe(3602);
    expect(r.frozenBy[3600]).toEqual([3601, 3602]);
    expect(r.pauses.every((p) => p.inline)).toBe(true);
  });

  /* ── COWORK: 'agora' corta no joined_at da PESSOA, não no início da pausa ── */
  test('cowork joined_since=agora usa o joined_at da pessoa como ponto do corte', () => {
    const events = [
      ev(3575, 'review', M(9, 50), M(13, 5), { op: 'p7', _total_paused_seconds: 4000 }),
      ev(3584, 'break', M(11, 18), M(12, 43), {
        op: 'p7', description: 'Organizando estoque',
        _joined_since: 'agora', _joined_at_min: M(11, 57),
      }),
    ];
    const r = splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) });

    const segs = drawn(r, 3575);
    expect(segs[0].end).toBe(M(11, 57));    // NÃO 11:18
    expect(segs[1].start).toBe(M(12, 43));
    expect(r.pauses[0].start).toBe(M(11, 57));
  });

  test("cowork joined_since=inicio corta no started_at da pausa", () => {
    const events = [
      ev(3575, 'review', M(9, 50), M(13, 5), { op: 'p7', _total_paused_seconds: 5071 }),
      ev(3584, 'break', M(11, 18), M(12, 43), {
        op: 'p7', _joined_since: 'inicio', _joined_at_min: M(11, 57),
      }),
    ];
    const r = splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) });
    expect(drawn(r, 3575)[0].end).toBe(M(11, 18));
    expect(joinMin(events[1])).toBe(M(11, 18));
  });

  /* ── VERDADE DO BACKEND: total_paused_seconds desempata ───────────────── */
  test('quando algum candidato tem total_paused_seconds, só ele racha', () => {
    const events = [
      ev(10, 'production_line', M(9, 0), M(14, 0), { _total_paused_seconds: 1800 }),
      ev(11, 'review',          M(9, 30), M(14, 0), { _total_paused_seconds: 0 }),
      ev(12, 'break',           M(10, 0), M(10, 30)),
    ];
    const r = splitByPauses(events, { now: M(15, 0), dayEnd: M(18, 0) });
    expect(r.frozenIds.has(10)).toBe(true);
    expect(r.frozenIds.has(11)).toBe(false);
    expect(r.pauses[0].freezes).toEqual([10]);
  });

  test('sem NENHUM total_paused_seconds (endpoint antigo) cai na continência de tempo — RULE #0', () => {
    const events = [
      ev(10, 'production_line', M(9, 0), M(14, 0)),
      ev(11, 'review',          M(9, 30), M(14, 0)),
      ev(12, 'break',           M(10, 0), M(10, 30)),
    ];
    const r = splitByPauses(events, { now: M(15, 0), dayEnd: M(18, 0) });
    expect(r.pauses[0].freezes.sort()).toEqual([10, 11]);
  });

  /* ── invariantes: NUNCA duplicar trabalho ─────────────────────────────── */
  test('a soma dos segmentos NUNCA passa da duração do evento (sem dupla contagem)', () => {
    const events = [
      ev(3600, 'production_line', M(9, 0), M(16, 0), { _total_paused_seconds: 3600 }),
      ev(3601, 'break', M(10, 0), M(10, 30)),
      ev(3602, 'break', M(13, 0), M(13, 30)),
    ];
    const r = splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) });
    const total = drawn(r, 3600).reduce((a, s) => a + (s.end - s.start), 0);
    expect(total).toBe(M(16, 0) - M(9, 0) - 60);   // 7h menos as duas meias horas
    expect(total).toBeLessThan(M(16, 0) - M(9, 0));
  });

  test('almoço e fim de dia não são congelados nem congelam', () => {
    const events = [
      ev(1, 'lunch', M(12, 0), M(12, 45)),
      ev(2, 'end_of_day', M(17, 0), M(17, 5)),
      ev(3, 'break', M(12, 10), M(12, 20)),
    ];
    const r = splitByPauses(events, { now: M(18, 0), dayEnd: M(18, 0) });
    expect(r.frozenIds.size).toBe(0);
    expect(r.pauses[0].inline).toBe(false);
    // lunch/eod/break não geram segmento nenhum (não são trabalho)
    expect(r.segments).toHaveLength(0);
  });

  test('uma pausa nunca congela outra pausa', () => {
    const events = [
      ev(1, 'break', M(10, 0), M(11, 0)),
      ev(2, 'break', M(10, 20), M(10, 40)),
    ];
    const r = splitByPauses(events, { now: M(12, 0), dayEnd: M(18, 0) });
    expect(r.frozenIds.size).toBe(0);
    expect(r.pauses.every((p) => !p.inline)).toBe(true);
  });

  test('evento sem started_min é ignorado sem quebrar', () => {
    const events = [ev(1, 'production_line', null, null), ev(2, 'break', M(10, 0), M(10, 5))];
    expect(() => splitByPauses(events, { now: M(12, 0), dayEnd: M(18, 0) })).not.toThrow();
    const r = splitByPauses(events, { now: M(12, 0), dayEnd: M(18, 0) });
    expect(r.segments).toHaveLength(0);
  });

  test('lista vazia devolve estrutura vazia', () => {
    const r = splitByPauses([], { now: M(12, 0), dayEnd: M(18, 0) });
    expect(r.segments).toEqual([]);
    expect(r.pauses).toEqual([]);
    expect(r.frozenIds.size).toBe(0);
  });
});

describe('helpers', () => {
  test('isPause reconhece break (e o apelido pausa)', () => {
    expect(isPause({ activity: 'break' })).toBe(true);
    expect(isPause({ activity: 'pausa' })).toBe(true);
    expect(isPause({ activity: 'lunch' })).toBe(false);
    expect(isPause(null)).toBe(false);
  });

  test('segmentsByEvent agrupa por event_id na ordem do desenho', () => {
    const events = [
      ev(3600, 'production_line', M(9, 0), M(16, 0), { _total_paused_seconds: 1800 }),
      ev(3601, 'break', M(10, 0), M(10, 30)),
    ];
    const by = segmentsByEvent(splitByPauses(events, { now: M(17, 0), dayEnd: M(18, 0) }));
    expect(Object.keys(by)).toEqual(['3600']);
    expect(by[3600]).toHaveLength(2);
    expect(by[3600][0].start).toBeLessThan(by[3600][1].start);
  });
});
