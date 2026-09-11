'use strict';
/**
 * TIMELINE — layout puro (Bruno 09-10, redesenho da linha do tempo).
 * Cenários REAIS do dia 09-09 (Caroline: Linha + Labels; Bruno S.: 3 encapsulações
 * iguais; Vitor: encapsulação duplicada; reinícios de 0 min no kiosk).
 */
const path = require('path');
const L = require(path.join(__dirname, '..', '..', 'dashboard-v4', 'src', 'components', 'timeline-layout.cjs'));

// medidor previsível: 0.55 × px por caractere (sans) · 0.6 (mono)
const measure = (t, px, kind) => t.length * px * (kind === 'mono' ? 0.6 : 0.55);
const ev = (id, activity, s, e, extra) => ({ id, activity, started_min: s, ended_min: e, ...(extra || {}) });

describe('classificação', () => {
  test('impressão de labels e is_background viram aba; almoço é neutro', () => {
    expect(L.isRail(ev(1, 'label_printing', 0, 10))).toBe(true);
    expect(L.isRail(ev(2, 'encapsulation', 0, 10, { _is_background: true }))).toBe(true);
    expect(L.isRail(ev(3, 'production_line', 0, 10))).toBe(false);
    expect(L.isNeutral(ev(4, 'lunch', 0, 10))).toBe(true);
  });
});

describe('collapseDupes', () => {
  test('encapsulação três vezes no mesmo horário vira um bloco ×3 com os ids', () => {
    const E = (e) => e.ended_min;
    const out = L.collapseDupes([ev(4325, 'encapsulation', 736, 882), ev(4326, 'encapsulation', 736, 773), ev(4329, 'encapsulation', 742, 882)], E);
    // 4326 (37 min) está 100% dentro de 4325 → junta; 4329 idem
    expect(out).toHaveLength(1);
    expect(out[0].dupes).toBe(3);
    expect(out[0].dupe_ids).toEqual([4325, 4326, 4329]);
  });
  test('atividades diferentes no mesmo horário NÃO juntam', () => {
    const out = L.collapseDupes([ev(1, 'production_line', 721, 804), ev(2, 'label_printing', 727, 804)], (e) => e.ended_min);
    expect(out).toHaveLength(2);
  });
});

describe('layoutPerson (Caroline 09-09)', () => {
  const events = [
    ev(4307, 'packaging', 568, 662), ev(4312, 'label_printing', 640, 662), ev(4314, 'order_printing', 663, 691),
    ev(4318, 'packaging', 691, 706), ev(4320, 'production_line', 721, 804, { cowork: ['p10'] }), ev(4323, 'label_printing', 727, 804),
    ev(4332, 'lunch', 804, 848), ev(4333, 'label_printing', 808, 849), ev(4335, 'production_line', 849, 930),
  ];
  const lay = L.layoutPerson(events, { now: 1200, dayEnd: 1080 });
  test('labels vira aba; linha e empacotamento ficam na faixa; nada de "simultâneo"', () => {
    expect(lay.rails.map((r) => r.id)).toEqual([4312, 4323, 4333]);
    expect(lay.railLanes).toBe(1);
    // clusters de tarefas de mão: nenhum com 2 lanes (Linha + Labels já não se cruzam)
    expect(lay.clusters.every((c) => c.count === 1)).toBe(true);
  });
  test('almoço é neutro e o buraco entre linha 13:24 e linha 14:09 não vira gap (é o almoço)', () => {
    expect(lay.neutral.map((e) => e.id)).toEqual([4332]);
    // gaps só ≥ 15 min entre tarefas consecutivas: 706→721 = 15 min conta
    expect(lay.gaps.map((g) => [g.start, g.end])).toEqual([[706, 721]]);
  });
});

describe('almoço dentro de uma tarefa divide a faixa (não fica por cima)', () => {
  test('revisão 11:32–12:21 + almoço 12:20–13:03 = um cluster com 2 lanes', () => {
    const lay = L.layoutPerson([ev(1, 'review', 692, 741), ev(2, 'lunch', 740, 783)], { now: 1200, dayEnd: 1080 });
    expect(lay.clusters).toHaveLength(1); expect(lay.clusters[0].count).toBe(2);
  });
});

describe('calor e marca ao terminar', () => {
  const effEnd = (e) => e.ended_min;
  test('esperado: pref > cadastro > média do dia (≥ 3) > nada', () => {
    const evs = [ev(1, 'review', 0, 50), ev(2, 'review', 0, 40), ev(3, 'review', 0, 60)];
    expect(L.expectedFor('review', { prefMin: 30, actMin: 45, events: evs, effEnd })).toBe(30);
    expect(L.expectedFor('review', { prefMin: 0, actMin: 45, events: evs, effEnd })).toBe(45);
    expect(L.expectedFor('review', { prefMin: 0, actMin: null, events: evs, effEnd })).toBe(50);
    expect(L.expectedFor('review', { prefMin: 0, actMin: null, events: evs.slice(0, 2), effEnd })).toBeNull();
  });
  test('níveis: azul → verde → amarelo → laranja → vermelho', () => {
    expect([10, 40, 55, 70, 100].map((m) => L.heatLevel(m, 60))).toEqual([0, 1, 2, 3, 4]);
    expect(L.heatLevel(30, null)).toBeNull();
  });
  test('marca ao terminar', () => { expect(L.doneMark(50, 60)).toBe('fast'); expect(L.doneMark(58, 60)).toBe('ok'); expect(L.doneMark(80, 60)).toBe('slow'); });
});

describe('layoutPerson (Vitor 09-09): sobreposição real divide a faixa; 0 min vira tique', () => {
  const events = [ev(4305, 'cleaning', 498, 633), ev(4311, 'packaging', 590, 630), ev(4344, 'encapsulation', 927, 927, { _is_background: true }), ev(4356, 'review', 1049, 1049)];
  const lay = L.layoutPerson(events, { now: 1200, dayEnd: 1080 });
  test('limpeza + empacotamento = um cluster com 2 lanes', () => {
    expect(lay.clusters).toHaveLength(1);
    expect(lay.clusters[0].count).toBe(2);
  });
  test('registro de 0 min de mão vira tique; de máquina some', () => {
    expect(lay.ticks.map((e) => e.id)).toEqual([4356]);
    expect(lay.rails).toHaveLength(0);
  });
});

describe('fitLabel: nome e tempo sempre, letra encolhe, senão sai do bloco', () => {
  const base = { name: 'Linha de Produção', short: 'Linha', durTxt: '2h21', prodName: 'Rhodiola Rosea 1000mg', measure };
  test('largo: nome completo 11.5 px + 2ª linha com produto e tempo', () => {
    const f = L.fitLabel({ ...base, w: 220, h: 42 });
    expect(f).toMatchObject({ inside: true, name: 'Linha de Produção', px: 11.5, line2: true, prod: true });
  });
  test('médio: encolhe a letra antes de abreviar', () => {
    const f = L.fitLabel({ ...base, w: 100, h: 42 });
    expect(f.inside).toBe(true); expect(f.name).toBe('Linha de Produção'); expect(f.px).toBeLessThan(11.5);
  });
  test('estreito: nome curto dentro; tempo continua na 2ª linha', () => {
    const f = L.fitLabel({ ...base, w: 40, h: 42 });
    expect(f).toMatchObject({ inside: true, name: 'Linha', line2: true, prod: false });
  });
  test('5 minutos (9 px): sai do bloco com o nome curto', () => {
    const f = L.fitLabel({ ...base, w: 9, h: 42 });
    expect(f).toEqual({ inside: false, name: 'Linha' });
  });
  test('estreito mas alto: texto em pé dentro do bloco (antes de ir pra calha)', () => {
    const f = L.fitLabel({ ...base, w: 16, h: 42 });
    expect(f).toMatchObject({ inside: true, vertical: true, name: 'Linha' });
  });
  test('faixa dividida (bloco baixo): "Limpeza · 2h15" numa linha só', () => {
    const f = L.fitLabel({ name: 'Limpeza', short: 'Limpeza', durTxt: '2h15', w: 150, h: 20, measure });
    expect(f).toMatchObject({ inside: true, name: 'Limpeza · 2h15', line2: false });
  });
});

describe('railLabel: aba diz o que é', () => {
  const base = { name: 'Encapsulação', short: 'Encaps.', durTxt: '3h08', prodName: 'Mullein Leaf', measure };
  test('aba larga: nome · lote · duração', () => expect(L.railLabel({ ...base, w: 300, room: 0 }).mode).toBe('full'));
  test('aba média: nome curto + duração', () => expect(L.railLabel({ ...base, w: 110, room: 0 }).mode).toBe('short_dur'));
  test('aba estreita com espaço à direita: rótulo fora COM o suplemento', () => expect(L.railLabel({ ...base, w: 20, room: 200 })).toMatchObject({ mode: 'outside', name: 'Encaps. · Mullein Leaf 3h08' }));
  test('aba estreita com pouco espaço: rótulo fora só curto + tempo', () => expect(L.railLabel({ ...base, w: 20, room: 90 })).toMatchObject({ mode: 'outside', name: 'Encaps. 3h08' }));
  test('aba média com lote: nome curto + lote + tempo antes de perder o lote', () => expect(L.railLabel({ ...base, w: 185, room: 0 })).toMatchObject({ mode: 'full', name: 'Encaps.', extra: 'Mullein Leaf · 3h08' }));
  test('aba estreita sem espaço: nada (hover carrega)', () => expect(L.railLabel({ ...base, w: 20, room: 10 }).mode).toBe('none'));
});

describe('rowMetrics', () => {
  test('sem aba a faixa começa mais alto; cada lane de aba soma 21 px', () => {
    const a = L.rowMetrics({ railLanes: 0, hourPx: 110 }), b = L.rowMetrics({ railLanes: 1, hourPx: 110 });
    expect(b.laneTop - a.laneTop).toBe(23);
    expect(a.rowH).toBe(a.laneTop + a.LANE_H + 8);
  });
});
