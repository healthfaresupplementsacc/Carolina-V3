'use strict';
/**
 * V4 — TIMELINE / PAUSA: quem congelou o quê.
 *
 * ── O PEDIDO (Bruno, 08-20, textual) ────────────────────────────────────
 *   "eles estao usando 'pausa' como se eles estivessem em um task e tivesse
 *    que parar pra fazer outra coisa (...) eu tinha combinado com vc que a
 *    pausa ficava na mesma linha do tempo e pausava o q a pessoa estivesse
 *    fazendo, no meio iria ter uma pausa, e quando a pessoa terminasse a pausa
 *    reativava o q ele tava fazendo, no caso do vitor era pra ta assim na
 *    timeline dele:
 *      -----linha de producao Apple cider vinegar-----|| PAUSA (Descarregando
 *      caminhao)|| ------- linha de producao Apple cider vinegar-
 *    tudo numa linha so, e a mesma coisa deveria acontecer pra todos os
 *    coworkers que joined essa pausa."
 *
 * ── O QUE JÁ ESTAVA CERTO ───────────────────────────────────────────────
 * O BACKEND. A pausa ('break') congela de verdade: src/v3/pause/service.js
 * credita total_paused_seconds no evento congelado, faz isso pra TODO
 * participante do cowork (união de cowork_group_id + cowork_with) e pergunta a
 * cada um "você estava nisso desde o começo?" (joined_since/joined_at).
 * O DADO está certo. O DESENHO é que estava errado: assignLanes() em
 * Timeline.jsx tratava a pausa como mais um evento de foreground sobreposto e
 * empurrava ela pra uma SUB-LANE em cima da tarefa, em vez de INTERROMPER a
 * tarefa.
 *
 * ── O QUE ESTE MÓDULO FAZ ───────────────────────────────────────────────
 * Função pura, sem React e sem DOM (por isso .cjs, igual day-stats.cjs: o
 * dashboard-v4 é "type": "module" e o Jest deste repo é CJS sem babel — um .js
 * aqui dentro seria ESM e não daria pra `require` no teste).
 *
 *   splitByPauses(events, opts) -> { segments, pauses, frozenBy, frozenIds }
 *
 * `events` são os eventos de UMA pessoa no shape do adapter V4
 * (adapt-to-hfdata.cjs): { id, op, activity, started_min, ended_min,
 * description, _total_paused_seconds, _joined_since, _joined_at_min, ... }.
 *
 * ── A REGRA DE PAREAMENTO ───────────────────────────────────────────────
 * Uma pausa P congela um evento de trabalho E da MESMA pessoa quando E já
 * estava ABERTO no instante em que P começou:
 *
 *     E.started_min < P.started_min  E  (E.ended_min == null  OU
 *                                        E.ended_min > P.started_min)
 *
 * Duas notas que o backend obriga:
 *
 *  1. `_total_paused_seconds` é a VERDADE do backend — é ele que diz que o
 *     evento foi realmente congelado. Quando o campo existe e é > 0, exigimos
 *     coerência: só pareia se o evento tem crédito de pausa. Quando o campo não
 *     chega (endpoint antigo) ou é 0 em TODOS os candidatos, caímos na
 *     continência de tempo pura — REGRA #0: nunca deixar de desenhar o que
 *     aconteceu só porque falta um campo.
 *
 *  2. Uma pausa pode congelar MAIS DE UM evento (Bruno Sarmento tinha `review`
 *     e `special_task` abertos ao mesmo tempo no dia 19/08). Todos rachar.
 *
 * ── ENTRADA TARDIA (joined_since = 'agora') ─────────────────────────────
 * Quem entrou na pausa DEPOIS não deve ter a tarefa cortada no início da
 * pausa do colega, e sim no instante em que ELE entrou. O corte usa, nesta
 * ordem: `_joined_at_min` (o joined_at da migração 076), senão o
 * started_min do PRÓPRIO evento de pausa da pessoa (que o serviço já cria com
 * started_at = NOW() no caminho pause_join). Como cada participante tem o SEU
 * evento de 'break', na prática o corte já cai certo mesmo sem joined_at.
 *
 * ── O QUE ESTE MÓDULO **NÃO** FAZ ───────────────────────────────────────
 * Não soma nada, não muda duração, não inventa evento. Um evento rachado
 * continua sendo UM evento com UMA duração (a real, já descontada da pausa
 * pelo backend). `segments` são pedaços de DESENHO que carregam `event_id`;
 * quem agrega (day-stats, fgSimul, worked minutes) continua olhando o evento,
 * nunca os segmentos. Foi isso que evitou reintroduzir o bug do "trabalho
 * SIMULTÂNEO" rosa em cima da pausa.
 */

/** slugs que são PAUSA de verdade (a que congela). Espelha PAUSE_SLUGS de
 *  src/v3/pause/service.js. 'pausa' entra só como apelido defensivo caso um
 *  catálogo antigo tenha gravado o slug em português. */
const PAUSE_SLUGS = new Set(['break', 'pausa']);

/** slugs que NUNCA são congelados por uma pausa: almoço e fim de dia não são
 *  trabalho (e uma pausa jamais congela outra pausa — o backend também não). */
const NEVER_FROZEN = new Set(['break', 'pausa', 'lunch', 'end_of_day']);

/** É um evento de pausa? */
function isPause(ev) {
  return !!(ev && PAUSE_SLUGS.has(ev.activity));
}

/** Fim EFETIVO de um evento em minutos: ended_min, ou `now` se está ao vivo. */
function effEnd(ev, now) {
  return ev.ended_min == null ? now : ev.ended_min;
}

/**
 * Instante (minuto do dia) em que ESTA pessoa entrou nesta pausa.
 * Ordem de confiança: joined_at (migração 076) → started_min do evento de
 * pausa dela. joined_since = 'inicio' significa "eu já estava nisso desde o
 * começo", então o corte volta pro started_min da pausa.
 */
function joinMin(pause) {
  if (pause._joined_since === 'agora' && pause._joined_at_min != null) {
    return Math.max(pause.started_min, pause._joined_at_min);
  }
  return pause.started_min;
}

/**
 * Racha os eventos de trabalho de UMA pessoa nos pontos em que uma pausa os
 * congelou.
 *
 * @param {Array}  events  eventos da pessoa (shape do adapter V4)
 * @param {Object} opts
 *   @param {number} opts.now  minuto-do-dia NY atual (fim das coisas ao vivo)
 *   @param {number} opts.dayEnd  teto da régua (clamp do "agora")
 *
 * @returns {{segments: Array, pauses: Array, frozenBy: Object, frozenIds: Set}}
 *   segments  — [{ event_id, start, end, index, total, is_first, is_last,
 *                  is_continuation, zero_width, pause_id_before }]
 *               UM segmento por pedaço desenhável. Eventos NÃO congelados
 *               também aparecem, com um único segmento (index 0, total 1) —
 *               assim o render tem UMA lista só pra percorrer.
 *   pauses    — [{ event_id, start, end, freezes: [event_ids], inline: bool,
 *                  live: bool, note: string }]
 *               inline=true → a pausa congelou alguém e deve ser desenhada
 *               DENTRO da lane da tarefa. inline=false → pausa solta (a pessoa
 *               não tinha nada aberto), mantém o desenho de hoje.
 *   frozenBy  — { <event_id>: [pause_ids...] } quem congelou cada tarefa
 *   frozenIds — Set dos event_ids que foram rachados (≥ 1 pausa dentro)
 */
function splitByPauses(events, opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : 24 * 60;
  const dayEnd = o.dayEnd != null ? o.dayEnd : 24 * 60;
  const nowClamped = Math.min(now, dayEnd);

  const list = (events || []).filter((e) => e && e.started_min != null);
  const pauseEvents = list.filter(isPause).sort((a, b) => a.started_min - b.started_min);
  const workEvents = list.filter((e) => !NEVER_FROZEN.has(e.activity));

  const frozenBy = {};
  const cutsOf = {};        // event_id -> [{ pause_id, at, until }]
  const pauseOut = [];

  for (const p of pauseEvents) {
    const pStart = joinMin(p);
    const pEnd = effEnd(p, nowClamped);
    // candidatos: aberto quando a pausa começou.
    let candidates = workEvents.filter((e) =>
      e.started_min < pStart && (e.ended_min == null || e.ended_min > pStart));

    // VERDADE DO BACKEND: se ALGUM candidato traz crédito de pausa, só valem os
    // que trazem. Se nenhum traz (campo ausente / endpoint antigo), vale a
    // continência de tempo pura — nunca deixamos de desenhar por falta de campo.
    const withCredit = candidates.filter((e) => Number(e._total_paused_seconds) > 0);
    if (withCredit.length) candidates = withCredit;

    for (const e of candidates) {
      (frozenBy[e.id] = frozenBy[e.id] || []).push(p.id);
      (cutsOf[e.id] = cutsOf[e.id] || []).push({ pause_id: p.id, at: pStart, until: pEnd });
    }

    pauseOut.push({
      event_id: p.id,
      start: pStart,
      end: pEnd,
      live: p.ended_min == null,
      inline: candidates.length > 0,
      freezes: candidates.map((e) => e.id),
      note: (p.description || '').trim(),
      activity: p.activity,
    });
  }

  const frozenIds = new Set(Object.keys(cutsOf).map((k) => Number(k)));

  // ── segmentos ─────────────────────────────────────────────────────────
  const segments = [];
  for (const e of workEvents) {
    const eStart = e.started_min;
    const eEnd = effEnd(e, nowClamped);
    const cuts = (cutsOf[e.id] || []).slice().sort((a, b) => a.at - b.at);

    if (!cuts.length) {
      segments.push({
        event_id: e.id, start: eStart, end: eEnd,
        index: 0, total: 1, is_first: true, is_last: true,
        is_continuation: false, zero_width: eEnd <= eStart, pause_id_before: null,
      });
      continue;
    }

    // percorre os cortes em ordem, fatiando [cursor, corte.at] e pulando pro
    // fim do corte. Pausas encavaladas (uma dentro da outra) não geram fatia
    // negativa porque o cursor nunca anda pra trás.
    const raw = [];
    let cursor = eStart;
    let prevPause = null;
    for (const c of cuts) {
      const segEnd = Math.min(Math.max(c.at, cursor), eEnd);
      raw.push({ start: cursor, end: segEnd, pause_id_before: prevPause });
      cursor = Math.min(Math.max(c.until, cursor), eEnd);
      prevPause = c.pause_id;
    }
    raw.push({ start: cursor, end: eEnd, pause_id_before: prevPause });

    /* GHOST DE LARGURA ZERO (caso do Vitor 19/08): a pausa 11:18→12:43 terminou
       EXATAMENTE quando a linha de produção terminou (12:43). A fatia da cauda
       tem largura 0 e não pode virar um bloquinho fantasma na tela. Marcamos
       zero_width e o render descarta — mas ela continua listada pra quem quiser
       auditar o corte. */
    const drawable = raw.filter((s) => s.end > s.start);
    const total = drawable.length;
    let i = 0;
    for (const s of raw) {
      const zero = s.end <= s.start;
      if (zero) {
        segments.push({
          event_id: e.id, start: s.start, end: s.end,
          index: -1, total, is_first: false, is_last: false,
          is_continuation: true, zero_width: true, pause_id_before: s.pause_id_before,
        });
        continue;
      }
      segments.push({
        event_id: e.id, start: s.start, end: s.end,
        index: i, total,
        is_first: i === 0, is_last: i === total - 1,
        is_continuation: i > 0, zero_width: false,
        pause_id_before: s.pause_id_before,
      });
      i += 1;
    }
  }

  segments.sort((a, b) => a.start - b.start || a.event_id - b.event_id || a.index - b.index);

  return { segments, pauses: pauseOut, frozenBy, frozenIds };
}

/** Agrupa o resultado por event_id — atalho pro render, que percorre eventos. */
function segmentsByEvent(split) {
  const by = {};
  for (const s of (split && split.segments) || []) {
    (by[s.event_id] = by[s.event_id] || []).push(s);
  }
  return by;
}

module.exports = {
  PAUSE_SLUGS, NEVER_FROZEN,
  isPause, effEnd, joinMin,
  splitByPauses, segmentsByEvent,
};
