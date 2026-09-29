'use strict';
/**
 * HEALTHFARE — AVISO DE PONTO DO DIA SEGUINTE (Bruno 09-28).
 *
 * O sistema NAO avisa mais no mesmo dia: o relogio NGTeco atrasa ~45min pra gravar
 * a batida, entao o alerta do mesmo dia acusa inocente e faz o funcionario desconfiar
 * do sistema. Em vez disso, NO DIA SEGUINTE as 9:40am (relogio ja sincronizado), o
 * attendance-sync CONFIRMA os registros de ontem e, so pra quem faltou de verdade,
 * chama este modulo pra:
 *   1) registrar UMA ocorrencia por dia/pessoa (v3.punch_occurrence),
 *   2) contar as ocorrencias dos ULTIMOS 30 DIAS,
 *   3) escolher o nivel de punicao e postar UM aviso no canal dos operadores.
 *
 * A REMOCAO REAL do beneficio (a hora do lanche paga) e MANUAL — o Bruno faz na mao.
 * Aqui SO avisa e registra. Nada e removido automaticamente.
 *
 * Escala (Bruno 09-28), contando os ultimos 30 dias INCLUINDO a ocorrencia de hoje:
 *   1x, 2x -> beneficio do DIA removido
 *   3x     -> beneficio da SEMANA inteira
 *   4x     -> + a semana seguinte
 *   5x     -> + outra semana (acumula)
 *   6x+    -> reuniao obrigatoria + sem beneficio por 2 meses
 */

const TZ = 'America/New_York';

/** Escolhe o nivel (1..6) pela contagem de ocorrencias em 30 dias. */
function pickLevel(count30) {
  if (count30 <= 0) return 0;
  if (count30 === 1) return 1;
  if (count30 === 2) return 2;
  if (count30 === 3) return 3;
  if (count30 === 4) return 4;
  if (count30 === 5) return 5;
  return 6;   // 6 ou mais
}

/** "27/09" a partir de um ISO date 'YYYY-MM-DD'. */
function brDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}` : String(iso || '');
}

/** primeiro nome (pra caber no aviso sem ficar formal demais). */
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || String(name || '');
}

/** Descreve o que faltou. missing = { in, out, detail? } */
function describeMissing(missing) {
  if (missing && missing.detail) return missing.detail.toUpperCase();
  const parts = [];
  if (missing && missing.in) parts.push('ENTRADA');
  if (missing && missing.out) parts.push('SAIDA');
  if (!parts.length) return 'BATIDA DE PONTO';
  return parts.join(' E ');
}

/**
 * Monta a mensagem do aviso. MAIUSCULA, negrito, sem emoji (regra do Bruno).
 * O negrito no Slack e *asterisco*. person = display_name; missing = o que faltou;
 * level 1..6; occDateISO = o dia da falta.
 */
function composeMessage(person, missing, level, occDateISO, whenLabel = 'ONTEM') {
  const nome = firstName(person.display_name || person.name || '').toUpperCase();
  const oque = describeMissing(missing);
  const dia = brDate(occDateISO);
  const quando = String(whenLabel || 'ONTEM').toUpperCase();
  const cabeca = `${nome}, NAO ENCONTRAMOS REGISTRO DA BATIDA DE ${oque} DE ${quando} (${dia}).`;
  let corpo;
  switch (level) {
    case 1:
      corpo = 'JA ANOTEI E O BENEFICIO DESTE DIA FOI REMOVIDO. CONFIRA SEMPRE QUE BATEU O PONTO.';
      break;
    case 2:
      corpo = 'ESTA E A 2a OCORRENCIA EM 30 DIAS. O BENEFICIO DESTE DIA FOI REMOVIDO. NA PROXIMA, A PERDA PASSA A SER DA SEMANA INTEIRA.';
      break;
    case 3:
      corpo = 'ESTA E A 3a OCORRENCIA EM 30 DIAS. A PARTIR DE AGORA O BENEFICIO DA SEMANA INTEIRA FOI REMOVIDO.';
      break;
    case 4:
      corpo = 'ESTA E A 4a OCORRENCIA EM 30 DIAS. O BENEFICIO DESTA SEMANA E DA SEMANA SEGUINTE FOI REMOVIDO.';
      break;
    case 5:
      corpo = 'ESTA E A 5a OCORRENCIA EM 30 DIAS. MAIS UMA SEMANA DE BENEFICIO FOI REMOVIDA, ALEM DAS ANTERIORES.';
      break;
    default:   // 6+
      corpo = 'ESTA E A 6a OCORRENCIA EM 30 DIAS. UMA REUNIAO COM VOCE FOI REQUERIDA E OS BENEFICIOS FICAM SUSPENSOS POR 2 MESES.';
      break;
  }
  return `*${cabeca} ${corpo}*`;
}

/** Conta ocorrencias da pessoa nos ultimos 30 dias (inclui refDate). */
async function countLast30(db, personId, refDateISO) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM v3.punch_occurrence
      WHERE person_id = $1
        AND occ_date >  ($2::date - INTERVAL '30 days')
        AND occ_date <= $2::date`,
    [personId, refDateISO]);
  return r.rows[0] ? r.rows[0].n : 0;
}

/** Ja existe ocorrencia registrada pra esse dia/pessoa? (idempotente) */
async function alreadyRecorded(db, personId, occDateISO) {
  const r = await db.query(
    `SELECT id FROM v3.punch_occurrence WHERE person_id=$1 AND occ_date=$2::date`,
    [personId, occDateISO]);
  return r.rows.length > 0;
}

/**
 * Registra a ocorrencia + posta o aviso. Idempotente por (person, occ_date).
 *  db          : pool
 *  person      : { id, display_name }
 *  missing     : { in:bool, out:bool, detail?:string }
 *  occDateISO  : 'YYYY-MM-DD' (o dia da falta = ontem)
 *  postOperators(text) -> Promise<ts|null>  (posta no canal dos operadores, devolve ts)
 *  audit(action, personId, meta) -> Promise (opcional)
 * Retorna { posted:bool, level, count30, occ_index } ou { posted:false, reason }.
 */
async function recordAndWarn({ db, person, missing, occDateISO, postOperators, audit, whenLabel = 'ONTEM' }) {
  if (await alreadyRecorded(db, person.id, occDateISO)) {
    return { posted: false, reason: 'ja registrado hoje pra ontem' };
  }
  // conta o que JA existe (antes de inserir) e soma 1 = esta ocorrencia
  const before = await countLast30(db, person.id, occDateISO);
  const count30 = before + 1;
  const level = pickLevel(count30);
  const detail = describeMissing(missing).toLowerCase();

  // insere primeiro (dedup por UNIQUE); se corrida, ON CONFLICT nao faz nada
  const ins = await db.query(
    `INSERT INTO v3.punch_occurrence (person_id, occ_date, missing_in, missing_out, detail, occ_index, level, created_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (person_id, occ_date) DO NOTHING
     RETURNING id`,
    [person.id, occDateISO, !!(missing && missing.in), !!(missing && missing.out), detail, count30, level]);
  if (!ins.rows.length) return { posted: false, reason: 'corrida: outro tick ja inseriu' };

  const text = composeMessage(person, missing, level, occDateISO, whenLabel);
  let ts = null;
  try { ts = postOperators ? await postOperators(text) : null; } catch (e) { /* nao bloqueia o registro */ }

  await db.query(
    `UPDATE v3.punch_occurrence SET notified_at=NOW(), notify_ts=$2 WHERE person_id=$1 AND occ_date=$3::date`,
    [person.id, ts, occDateISO]);

  if (audit) { try { await audit('att.nextday_warning', person.id, { occ_date: occDateISO, missing, level, count30, notify_ts: ts }); } catch (_) {} }
  return { posted: true, level, count30, occ_index: count30, text, ts };
}

/** Leitura pro card do admin: ocorrencias dos ultimos 30 dias agrupadas por pessoa. */
async function occurrences30(db) {
  const r = await db.query(
    `SELECT p.id AS person_id, p.display_name,
            COUNT(*)::int AS count30,
            MAX(o.occ_date) AS last_date,
            MAX(o.level) AS max_level
       FROM v3.punch_occurrence o
       JOIN v3.persons p ON p.id = o.person_id
      WHERE o.occ_date > (CURRENT_DATE - INTERVAL '30 days')
      GROUP BY p.id, p.display_name
      ORDER BY count30 DESC, last_date DESC`);
  return r.rows.map((x) => ({
    person_id: x.person_id,
    name: x.display_name,
    count30: x.count30,
    last_date: x.last_date,
    level: pickLevel(x.count30),
    max_level_seen: x.max_level,
  }));
}

/** Lista das ocorrencias dos ultimos 30 dias (pro card do admin), mais recente primeiro. */
async function recent30(db) {
  const r = await db.query(
    `SELECT o.id, o.person_id, p.display_name, o.occ_date::text AS occ_date, o.detail, o.occ_index, o.level, o.notified_at
       FROM v3.punch_occurrence o JOIN v3.persons p ON p.id = o.person_id
      WHERE o.occ_date > (CURRENT_DATE - INTERVAL '30 days')
      ORDER BY o.occ_date DESC, p.display_name`);
  return r.rows;
}

module.exports = { pickLevel, composeMessage, countLast30, recordAndWarn, occurrences30, recent30, describeMissing, brDate, firstName };
