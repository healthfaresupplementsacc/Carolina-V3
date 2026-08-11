'use strict';
/**
 * HEALTHFARE — rótulos das batidas do ponto (Bruno 07-23).
 *
 * A partir da lista ordenada de batidas do dia de uma pessoa, decide o que cada
 * par saída→volta significa e devolve marcadores pra timeline:
 *   Check-in · Lunch out · Lunch in · Check-out · Break out/in (normal/injustif.)
 *
 * REGRAS (Bruno):
 *  - 1ª batida = CHECK-IN. Última (se o dia fechou) = CHECK-OUT.
 *  - Entre elas, cada par (saída, volta) é um BREAK.
 *  - O ALMOÇO = o MAIOR break do dia (o de maior duração). Sempre marcado "Lunch".
 *  - Lunch é 45min de direito. Passou de 45 → o excedente é "esticando" (ok, mas
 *    marcado). Breaks pequenos que SOMAM até 45min contam como lunch; o que passar
 *    disso vira break normal.
 *  - Qualquer break SEPARADO do almoço (não é o maior) = break normal; se >0 e sem
 *    justificativa registrada = INJUSTIFICADO (unjustified).
 *  - Um break com nota/justificativa no sistema (event de break com description) =
 *    justificado, não alerta.
 */

const LUNCH_ENTITLEMENT_MIN = 45;

/**
 * @param {Array<{punch_time: string|Date}>} punches  batidas ordenadas do dia
 * @param {boolean} dayClosed  já houve checkout (última batida = saída do dia)?
 * @param {Set<number>} justifiedBreakStartsMs  (opcional) inícios de break (ms) justificados
 * @returns {{ markers: Array, breaks: Array, lunch: object|null }}
 *   markers: [{ kind, at, label }]  kind ∈ checkin|checkout|lunch_out|lunch_in|break_out|break_in
 *   breaks:  [{ out, in, minutes, type }]  type ∈ lunch|break|unjustified
 */
function computeMarkers(punches, dayClosed, justifiedBreakStartsMs) {
  const ts = (p) => new Date(p.punch_time).getTime();
  const list = (punches || []).map((p) => new Date(p.punch_time)).sort((a, b) => a - b);
  const markers = [];
  const breaks = [];
  if (!list.length) return { markers, breaks, lunch: null };

  // 1ª = check-in
  markers.push({ kind: 'checkin', at: list[0].toISOString(), label: 'Check-in' });

  // pares (saída, volta) no MIOLO — entre a 1ª batida (check-in) e a última.
  // Se o dia fechou, a ÚLTIMA batida é o CHECK-OUT e NÃO entra nos pares (era o bug:
  // com 3 batidas o par consumia a saída do dia como "lunch in", sumindo o checkout).
  //   dia fechado:  miolo = índices 1..lastIdx-1  (última reservada pro checkout)
  //   dia aberto:   miolo = índices 1..fim         (pares completos; sobra ímpar = break em curso, ignorada)
  const lastIdx = list.length - 1;
  const innerLast = dayClosed ? lastIdx - 1 : lastIdx;  // último índice que pode virar par
  let i = 1;
  for (; i + 1 <= innerLast; i += 2) {
    const out = list[i];
    const inn = list[i + 1];
    if (!inn) break;
    const minutes = Math.round((inn - out) / 60000);
    breaks.push({ out, in: inn, minutes, type: 'break' });
  }
  // BATIDA SOLTA no miolo (nº ímpar de batidas úteis) = saiu e esqueceu de bater a
  // volta (ou vice-versa). Marca como incompleta pra NÃO sumir da timeline.
  const orphanIdx = i;
  const orphan = (orphanIdx <= innerLast) ? list[orphanIdx] : null;

  // ALMOÇO = o maior break (maior duração). Empate → o primeiro.
  let lunchIdx = -1, lunchMax = -1;
  breaks.forEach((b, i) => { if (b.minutes > lunchMax) { lunchMax = b.minutes; lunchIdx = i; } });

  // acumulador dos "pequenos que somam até 45" — só quando NÃO há um almoço claro
  // (nenhum break sozinho >= 45). Nesse caso, os primeiros que somam 45min = lunch.
  const hasClearLunch = lunchMax >= LUNCH_ENTITLEMENT_MIN;
  let acc = 0;

  breaks.forEach((b, i) => {
    const justified = justifiedBreakStartsMs && justifiedBreakStartsMs.has(ts({ punch_time: b.out }));
    if (hasClearLunch) {
      b.type = (i === lunchIdx) ? 'lunch' : (justified ? 'break' : 'unjustified');
    } else {
      // sem break grande: soma os pequenos até 45min = lunch; resto = break/injustif.
      if (acc < LUNCH_ENTITLEMENT_MIN) { b.type = 'lunch'; acc += b.minutes; }
      else b.type = justified ? 'break' : 'unjustified';
    }
    // overtime do lunch (passou de 45min) — marca pra visibilidade
    if (b.type === 'lunch') b.overtime_min = Math.max(0, b.minutes - LUNCH_ENTITLEMENT_MIN);

    const outLabel = b.type === 'lunch' ? 'Lunch out' : (b.type === 'unjustified' ? 'Break (extra)' : 'Break out');
    const inLabel = b.type === 'lunch' ? 'Lunch in' : 'Break in';
    markers.push({ kind: b.type === 'lunch' ? 'lunch_out' : 'break_out', at: b.out.toISOString(), label: outLabel, type: b.type, minutes: b.minutes });
    markers.push({ kind: b.type === 'lunch' ? 'lunch_in' : 'break_in', at: b.in.toISOString(), label: inLabel, type: b.type });
  });

  // batida órfã (saída/volta sem par) — marca como incompleta, não some
  if (orphan) {
    markers.push({ kind: 'break_out', at: orphan.toISOString(), label: 'Saída (sem volta registrada)', type: 'incomplete', incomplete: true });
  }

  // check-out (só se o dia fechou)
  if (dayClosed) {
    markers.push({ kind: 'checkout', at: list[lastIdx].toISOString(), label: 'Check-out' });
  }

  const lunch = lunchIdx >= 0 ? breaks[lunchIdx] : null;
  return { markers: markers.sort((a, b) => new Date(a.at) - new Date(b.at)), breaks, lunch };
}

module.exports = { computeMarkers, LUNCH_ENTITLEMENT_MIN };
