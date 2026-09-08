'use strict';
/*
 * "TRABALHANDO SEM PONTO" NÃO PODE FICAR GRUDADO (Bruno 08-09).
 *
 * O QUE O BRUNO VIU: a faixa "O Ponto" no topo da Hoje dizia que TODO MUNDO
 * estava "trabalhando SEM ponto" — as 4 pessoas do dia. Só que as 4 tinham
 * batido: Simone 8:13, Vitor 8:30, Caroline e Larissa 9:33.
 *
 * CAUSA: o relógio NGTeco entrega a batida na nuvem com ~45min de atraso. A
 * cobrança de "não bateu o ponto" roda nesse vão (8:57 pra uma batida das 8:13
 * que só chegou ao banco 8:59), carimba att_state.noclockin_callout_at — e
 * NADA nunca limpa esse carimbo. O dashboard lia `no_clockin` direto do
 * carimbo, então a marca ficava o dia inteiro mesmo depois da batida chegar.
 * Em 60 dias, 9 cobranças e ZERO com batida realmente faltando.
 *
 * REGRA: o carimbo diz que um dia COBRAMOS; ele não diz que a batida está
 * faltando AGORA. "SEM ponto" só vale enquanto não existe batida no dia.
 *
 * Este teste trava o SQL do endpoint: a expressão que decide `no_clockin` tem
 * que olhar att_punch, não só o carimbo.
 */
const fs = require('fs');
const path = require('path');

const ROUTER = path.join(__dirname, '..', 'v3', 'data', 'router.js');
const SRC = fs.readFileSync(ROUTER, 'utf8');

/* O handler inteiro do GET /api/v3/data/attendance: da rota até a próxima. */
function attendanceQuery() {
  const i = SRC.indexOf("router.get('/api/v3/data/attendance'");
  expect(i).toBeGreaterThan(-1);
  const j = SRC.indexOf('router.', i + 10);
  return SRC.slice(i, j > i ? j : i + 6000);
}

describe('GET /attendance — "trabalhando SEM ponto" some quando a batida chega', () => {
  test('no_clockin exige que NÃO exista batida no dia (não basta o carimbo)', () => {
    const q = attendanceQuery();
    // o campo entregue ao frontend tem que sair de uma expressão que consulta att_punch
    const m = q.match(/\(\s*s\.noclockin_callout_at IS NOT NULL AND NOT EXISTS \(([\s\S]{0,300}?)\)\s*\)\s*AS no_clockin/i);
    expect(m).toBeTruthy();
    expect(m[1]).toMatch(/FROM\s+v3\.att_punch/i);
    expect(m[1]).toMatch(/ap\.person_id\s*=\s*s\.person_id/i);
    expect(m[1]).toMatch(/ap\.att_date\s*=\s*s\.att_date/i);
  });

  test('o payload usa a expressão calculada, nunca o carimbo cru', () => {
    const q = attendanceQuery();
    expect(q).toMatch(/no_clockin:\s*!!r\.no_clockin/);
    // regressão: ler o carimbo direto foi exatamente o bug
    expect(q).not.toMatch(/no_clockin:\s*!!r\.noclockin_callout_at/);
  });

  test('a cobrança de verdade continua aparecendo (não silenciamos o alerta)', () => {
    // a condição é conjuntiva: carimbo E sem batida. Quem foi cobrado e de fato
    // não bateu continua marcado — o teste garante que não viramos "sempre false".
    const q = attendanceQuery();
    expect(q).toMatch(/s\.noclockin_callout_at IS NOT NULL AND NOT EXISTS/i);
    expect(q).not.toMatch(/false\s+AS no_clockin/i);
  });
});
