'use strict';
/* PAUSA · UI do kiosk (src/op/pause-ui.js) — Bruno 08-19.
 *
 * A pergunta que o Bruno pediu, ao pé da letra:
 *   título  "Você estava nisso desde o começo?"
 *   opção 1 "Desde o começo (HH:MM)"
 *   opção 2 "Comecei agora (HH:MM)"
 *
 * Aqui: o texto exato, os dois horários reais, o aviso do que foi ASSUMIDO
 * enquanto ninguém respondeu (REGRA #0), e as duas ações (card e overlay).
 * Nenhum DOM: o módulo é puro e roda em node.
 */
const PZ = require('../op/pause-ui');

function harness() {
  const calls = [];
  const S = { pauseQ: null, pauseBusy: false, overlay: null };
  PZ.init({
    S,
    api: (path, opts) => { calls.push({ path, body: (opts && opts.body) || null }); return Promise.resolve({ ok: true, credited_seconds: 5071 }); },
    toast: (t) => calls.push({ toast: t }),
    render: () => {},
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    loadData: () => Promise.resolve(null),
  });
  return { S, calls };
}

const Q3583 = {
  event_id: 3583,
  pause_event_id: 3578,
  starter_name: 'Vitor',
  note: 'Organizando estoque que chegaram pallets',
  pause_hhmm: '11:18',
  joined_hhmm: '11:57',
  assumed: 'agora',
};

describe('pause-ui — a pergunta do Bruno, ao pé da letra', () => {
  test('o título é exatamente "Você estava nisso desde o começo?"', () => {
    const { S } = harness();
    S.pauseQ = Q3583;
    const h = PZ.card();
    expect(h).toContain('Você estava nisso desde o');
    expect(h).toContain('começo');
    expect(h.replace(/<[^>]+>/g, '')).toContain('Você estava nisso desde o começo?');
  });

  test('as DUAS opções trazem o horário real de cada uma', () => {
    const L = PZ._.optionLabels(Q3583);
    expect(L.inicio).toBe('Desde o começo (11:18)');
    expect(L.agora).toBe('Comecei agora (11:57)');
  });

  test('o card diz o que foi ASSUMIDO enquanto ninguém respondeu (REGRA #0)', () => {
    const { S } = harness();
    S.pauseQ = Q3583;
    const t = PZ.card().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(t).toContain('Por enquanto contei a partir das 11:57');
    expect(t).toContain('Vitor');                       // de quem era a pausa
    expect(t).toContain('nada se perde');               // não assusta o operador
  });

  test('os dois botões existem e disparam pauseAnswer com o event_id e a escolha', () => {
    const { S } = harness();
    S.pauseQ = Q3583;
    const h = PZ.card();
    expect(h).toContain('data-act="pauseAnswer" data-arg="3583:inicio"');
    expect(h).toContain('data-act="pauseAnswer" data-arg="3583:agora"');
  });

  test('sem pergunta pendente o card não aparece', () => {
    const { S } = harness();
    S.pauseQ = null;
    expect(PZ.card()).toBe('');
  });

  test('responder chama a rota certa e agradece com o ajuste em minutos', async () => {
    const { S, calls } = harness();
    S.pauseQ = Q3583;
    PZ.answer('3583:inicio');
    await new Promise((r) => setTimeout(r, 0));
    const req = calls.find((c) => c.path === '/api/v3/op/pause/answer');
    expect(req).toBeTruthy();
    expect(req.body).toEqual({ event_id: 3583, since: 'inicio' });
    expect(S.pauseQ).toBeNull();
    // 5071s = 85 min
    expect(calls.some((c) => c.toast && c.toast.indexOf('85 min') >= 0)).toBe(true);
  });

  test('resposta inválida é ignorada em silêncio (nunca chama a API)', async () => {
    const { calls } = harness();
    PZ.answer('3583:talvez');
    PZ.answer('lixo');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.path).length).toBe(0);
  });
});

describe('pause-ui — overlay na hora de entrar na pausa', () => {
  test('askJoin abre o overlay a partir da resposta do backend', () => {
    const { S } = harness();
    const opened = PZ.askJoin({ pause_join_question: true, pause_event_id: 3578, pause_started_at: '2026-08-19T15:18:36Z' }, '11:18');
    expect(opened).toBe(true);
    expect(S.overlay.type).toBe('pauseJoin');
    expect(S.overlay.q.pause_event_id).toBe(3578);
    expect(S.overlay.q.pause_hhmm).toBe('11:18');
  });

  test('askJoin não faz nada quando a resposta não é a pergunta', () => {
    const { S } = harness();
    expect(PZ.askJoin({ ok: true, joined: true })).toBe(false);
    expect(S.overlay).toBeNull();
  });

  test('o overlay traz o mesmo título e os dois botões de pauseJoinPick', () => {
    const { S } = harness();
    S.overlay = { type: 'pauseJoin', q: { pause_event_id: 3578, pause_hhmm: '11:18', joined_hhmm: '11:57' } };
    const h = PZ.overlay();
    expect(h.replace(/<[^>]+>/g, '')).toContain('Você estava nisso desde o começo?');
    expect(h).toContain('data-act="pauseJoinPick" data-arg="3578:inicio"');
    expect(h).toContain('data-act="pauseJoinPick" data-arg="3578:agora"');
    expect(h).toContain('Desde o começo (11:18)');
    expect(h).toContain('Comecei agora (11:57)');
  });

  test('escolher no overlay chama /pause/join com since', async () => {
    const { S, calls } = harness();
    S.overlay = { type: 'pauseJoin', q: { pause_event_id: 3578, pause_hhmm: '11:18', joined_hhmm: '11:57' } };
    PZ.joinPick('3578:agora');
    await new Promise((r) => setTimeout(r, 0));
    const req = calls.find((c) => c.path === '/api/v3/op/pause/join');
    expect(req.body).toEqual({ pause_event_id: 3578, since: 'agora' });
    expect(S.overlay).toBeNull();
  });
});

describe('pause-ui — banner "Você está em pausa" (mudou de casa, mesma cara)', () => {
  test('mostra a nota, o número de tarefas congeladas e o botão de voltar', () => {
    const { S } = harness();
    S.myTasks = [
      { id: 3583, slug: 'break', description: 'Organizando estoque que chegaram pallets', is_paused: false },
      { id: 3575, slug: 'review', is_paused: true },
      { id: 3576, slug: 'special_task', is_paused: true },
    ];
    const h = PZ.banner();
    expect(h).toContain('Você está em pausa');
    expect(h).toContain('Organizando estoque que chegaram pallets');
    expect(h).toContain('2 tarefa(s) congelada(s)');
    expect(h).toContain('data-act="resumeWork" data-arg="3583"');
    expect(h).toContain('Voltar ao trabalho');
    expect(h).not.toContain('—');   // sem em dash (regra de estilo)
  });

  test('sem pausa aberta o banner não aparece', () => {
    const { S } = harness();
    S.myTasks = [{ id: 1, slug: 'review', is_paused: false }];
    expect(PZ.banner()).toBe('');
  });
});

describe('pause-ui — carregamento e chave de render', () => {
  test('load guarda a pergunta em S.pauseQ', async () => {
    const { S } = harness();
    PZ.init({ api: () => Promise.resolve({ question: Q3583 }) });
    await PZ.load();
    expect(S.pauseQ.event_id).toBe(3583);
  });

  test('load que falha vira "sem pergunta" e nunca estoura (REGRA #0)', async () => {
    const { S } = harness();
    PZ.init({ api: () => Promise.reject(new Error('offline')) });
    await expect(PZ.load()).resolves.toBeNull();
    expect(S.pauseQ).toBeNull();
  });

  test('a chave de render muda quando a pergunta ou o busy mudam', () => {
    const { S } = harness();
    S.pauseQ = null; const k0 = PZ.key();
    S.pauseQ = Q3583; const k1 = PZ.key();
    S.pauseBusy = true; const k2 = PZ.key();
    expect(k0).not.toBe(k1);
    expect(k1).not.toBe(k2);
  });
});

describe('pause-ui — estilo (STYLE-KIT, PT-BR)', () => {
  test('sem em dash em nenhum texto da tela', () => {
    const { S } = harness();
    S.pauseQ = Q3583;
    S.overlay = { type: 'pauseJoin', q: { pause_event_id: 1, pause_hhmm: '11:18', joined_hhmm: '11:57' } };
    const all = PZ.card() + PZ.overlay();
    expect(all.indexOf('—')).toBe(-1);
  });

  test('título editorial: serif com UMA palavra em itálico verde', () => {
    const t = PZ._.title('Você estava nisso desde o', 'começo', '?');
    expect(t).toContain('DM Serif Display');
    expect(t).toContain('font-style:italic');
    expect(t).toContain('#2e8b3c');
  });

  test('acentos preservados nas duas opções', () => {
    const L = PZ._.optionLabels({ pause_hhmm: '09:00', joined_hhmm: '09:30' });
    expect(L.inicio).toContain('começo');
    expect(L.inicioSub).toContain('relógio');
    expect(L.agoraSub).toContain('relógio');
  });

  test('horário inválido vira --:-- em vez de "Invalid Date"', () => {
    expect(PZ._.fmtHHMM('lixo')).toBe('--:--');
    expect(PZ._.fmtHHMM(null)).toBe('--:--');
  });
});
