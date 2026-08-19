'use strict';
/* ============================================================
   PAUSA — serviço único (S15.61).

   Bruno 08-19: "ask at the moment they join to the Pause 'did you work with him
   from the beginning or started just now to work on it?' and then give them 2
   options and so you will be able to know and how to address it properly."

   ── O BUG (evento 3583, 19/08) ──────────────────────────────
   Vitor abriu um 'break' 11:18:36 → 12:43:07 (5071s) com nota "Organizando
   estoque que chegaram pallets" e o Bruno Sarmento no cowork. O evento do
   PRÓPRIO Vitor (#3578) congelou certo: total_paused_seconds = 5071, exato. Os
   eventos do Bruno Sarmento não: #3575 (revisão 09:50:06 → 13:05:19) e #3576
   (special_task) ficaram com total_paused_seconds = 0. Ou seja: 1h24 de pausa
   contada como trabalho, em cima de uma revisão de 3h15.

   Três furos, todos reais:
     (a) op.js chamava freezeActiveFor(STARTER) mesmo quando a pausa nascia como
         cowork com N pessoas — o loop de INSERT criava 1 evento por participante,
         mas o freeze rodava UMA vez, pro starter.
     (b) resumePausedFor(personId) descongelava UMA pessoa — os colegas ficavam
         congelados pra sempre e nunca recebiam o "continuar ou finalizar?".
     (c) anexar alguém a uma pausa JÁ RODANDO pelo caminho do admin (correção de
         cowork_with no dashboard, que foi o que aconteceu às 11:57:53) não tinha
         lógica de pausa NENHUMA.

   ── A DECISÃO ───────────────────────────────────────────────
   Quem entra numa pausa já em andamento tem duas histórias possíveis e só a
   PESSOA sabe qual é. O sistema não adivinha: pergunta, com duas opções, e grava
   a resposta (migração 076: joined_since/joined_at/join_assumed).

     'inicio' → congela desde started_at da pausa. Os eventos dela recebem o
                crédito retroativo (pause_start → agora) em total_paused_seconds
                e paused_at = NOW, pra que o resto da pausa siga contando.
     'agora'  → congela do instante em que entrou. Só paused_at = NOW.

   ── RULE #0 — NUNCA BLOQUEIA ────────────────────────────────
   O caso do 3583 é justamente aquele em que a pessoa NÃO está no kiosk quando é
   anexada. Então: o evento de pausa dela nasce com joined_since NULL, o sistema
   assume o CONSERVADOR ('agora'), marca join_assumed = TRUE, e a pergunta fica
   PENDENTE no topo do /op pra próxima vez que ela tocar a tela. Se ela responder
   "desde o começo", os números são CORRIGIDOS (o crédito que faltava entra). A
   tela diz, em português, o que foi assumido. Nada trava esperando resposta.

   ── ESCRITA ─────────────────────────────────────────────────
   Este é o ÚNICO arquivo que escreve joined_since/joined_at/join_assumed. Ele
   NÃO fecha eventos (não escreve ended_at) e NÃO escreve estoque — só mexe no
   relógio (paused_at / total_paused_seconds), que é o que a pausa significa.
   ============================================================ */

// pausa = 'break'. Mesma definição do PAUSE_SLUGS de src/routes/op.js; ficar aqui
// permite ao serviço se defender sozinho (nunca congela uma pausa com outra).
const PAUSE_SLUGS = ['break'];

// respostas válidas da pergunta. Qualquer outra coisa é tratada como "não
// respondeu" (e o conservador 'agora' continua valendo) — REGRA #0.
const SINCE = { INICIO: 'inicio', AGORA: 'agora' };

function isSince(v) { return v === SINCE.INICIO || v === SINCE.AGORA; }

/**
 * Cria o serviço de pausa. `db` é o pool (ou qualquer objeto com .query).
 */
function createPauseService({ db, audit } = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('createPauseService: db obrigatório');
  const log = async (action, targetId, meta, personId) => {
    if (typeof audit !== 'function') return;
    try { await audit(action, 'event', targetId, meta, personId); } catch (_) { /* audit nunca bloqueia */ }
  };

  // ── leitura ────────────────────────────────────────────────

  /**
   * O evento de pausa em si (o 'break'), com dono, início e grupo.
   * Devolve null se não existe, foi apagado, ou não é uma pausa.
   */
  async function getPause(pauseEventId) {
    const r = await db.query(
      `SELECT e.id, e.person_id, e.started_at, e.ended_at, e.cowork_group_id,
              e.cowork_with, e.description, e.is_test, at.slug
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE e.id = $1 AND e.deleted_at IS NULL AND at.slug = ANY($2::text[])`,
      [pauseEventId, PAUSE_SLUGS]);
    return r.rows[0] || null;
  }

  /**
   * TODOS os participantes de uma pausa, cada um com o SEU evento de pausa.
   * Duas fontes, unidas: o cowork_group_id (fase 1 do cowork: 1 evento por
   * pessoa, mesmo grupo) e o cowork_with[] do evento (quando o admin anexa
   * alguém sem criar o evento dele). A união é o que faltava — olhar só uma das
   * duas foi o que deixou o Bruno Sarmento de fora no 3583.
   *
   * Devolve [{ person_id, pause_event_id|null, joined_since, joined_at, join_assumed }].
   * pause_event_id null = a pessoa está no cowork_with mas não tem evento próprio.
   */
  async function participantsOf(pauseEventId) {
    const p = await getPause(pauseEventId);
    if (!p) return [];
    const byGroup = p.cowork_group_id ? (await db.query(
      `SELECT e.id AS pause_event_id, e.person_id, e.joined_since, e.joined_at,
              COALESCE(e.join_assumed, FALSE) AS join_assumed, e.started_at
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE e.cowork_group_id = $1 AND e.deleted_at IS NULL AND at.slug = ANY($2::text[])`,
      [p.cowork_group_id, PAUSE_SLUGS])).rows : [];
    const out = new Map();
    // o dono da pausa entra sempre, e sempre "desde o começo" (ele começou).
    out.set(p.person_id, {
      person_id: p.person_id, pause_event_id: p.id, is_starter: true,
      joined_since: SINCE.INICIO, joined_at: p.started_at, join_assumed: false,
    });
    for (const row of byGroup) {
      if (out.has(row.person_id) && row.pause_event_id === p.id) continue;
      out.set(row.person_id, {
        person_id: row.person_id, pause_event_id: row.pause_event_id,
        is_starter: row.person_id === p.person_id,
        joined_since: row.person_id === p.person_id ? SINCE.INICIO : (row.joined_since || null),
        joined_at: row.joined_at || row.started_at, join_assumed: !!row.join_assumed,
      });
    }
    // quem está no cowork_with mas não tem evento próprio (caminho do admin).
    for (const pid of (p.cowork_with || [])) {
      if (!out.has(pid)) {
        out.set(pid, {
          person_id: pid, pause_event_id: null, is_starter: false,
          joined_since: null, joined_at: null, join_assumed: false,
        });
      }
    }
    return [...out.values()];
  }

  // ── congelar / descongelar ─────────────────────────────────

  /**
   * CONGELA os eventos ativos de VÁRIAS pessoas. Era o furo (a): o freeze rodava
   * só pro starter. Agora recebe a lista inteira de participantes.
   *
   * Exclui: os próprios eventos de pausa (exceptEventIds) e QUALQUER evento de
   * pausa (uma pausa nunca congela outra pausa). Só pega o que está rodando de
   * verdade (ended_at NULL, paused_at NULL, is_unfinished FALSE).
   *
   * `creditSeconds` (opcional, por pessoa) credita tempo RETROATIVO: é o que
   * faz o 'desde o começo' valer — os segundos entre o início da pausa e agora
   * entram em total_paused_seconds na hora do congelamento.
   *
   * Devolve { count, by_person: { <id>: [event_id, ...] } }.
   */
  async function freezeFor(personIds, exceptEventIds = [], opts = {}) {
    const ids = [...new Set((personIds || []).map((x) => parseInt(x, 10)).filter(Number.isFinite))];
    if (!ids.length) return { count: 0, by_person: {} };
    const except = [...new Set((exceptEventIds || []).map((x) => parseInt(x, 10)).filter(Number.isFinite))];
    const credit = opts.creditSeconds || {};
    const byPerson = {};
    let count = 0;
    for (const pid of ids) {
      const add = Math.max(0, parseInt(credit[pid], 10) || 0);
      const r = await db.query(
        `UPDATE v3.events
            SET paused_at = NOW(),
                total_paused_seconds = total_paused_seconds + $4::int,
                updated_at = NOW()
          WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
            AND paused_at IS NULL AND is_unfinished = FALSE
            AND NOT (id = ANY($2::int[]))
            AND activity_type_id NOT IN (SELECT id FROM v3.activity_types WHERE slug = ANY($3::text[]))
          RETURNING id`,
        [pid, except.length ? except : [-1], PAUSE_SLUGS, add]);
      byPerson[pid] = r.rows.map((x) => x.id);
      count += r.rowCount;
    }
    return { count, by_person: byPerson };
  }

  /**
   * DESCONGELA os eventos de VÁRIAS pessoas e devolve, POR PESSOA, as tarefas
   * que voltaram — é isso que alimenta o "continuar ou finalizar?" no kiosk de
   * CADA UM. Era o furo (b): só o dono da pausa era descongelado e perguntado.
   *
   * Devolve { count, by_person: { <id>: { count, tasks: [...] } } }.
   */
  async function resumeFor(personIds) {
    const ids = [...new Set((personIds || []).map((x) => parseInt(x, 10)).filter(Number.isFinite))];
    const byPerson = {};
    let count = 0;
    for (const pid of ids) {
      const r = await db.query(
        `UPDATE v3.events
            SET total_paused_seconds = total_paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (NOW() - paused_at))::int),
                paused_at = NULL, updated_at = NOW()
          WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND paused_at IS NOT NULL
          RETURNING id`, [pid]);
      if (!r.rowCount) { byPerson[pid] = { count: 0, tasks: [] }; continue; }
      byPerson[pid] = { count: r.rowCount, tasks: await describeTasks(r.rows.map((x) => x.id)) };
      count += r.rowCount;
    }
    return { count, by_person: byPerson };
  }

  // detalhes das tarefas descongeladas (o app pergunta "continuar ou finalizar?";
  // needs_count marca as que cobram quantidade no fim: linha/encaps/fnsku/ordens).
  async function describeTasks(eventIds) {
    if (!eventIds || !eventIds.length) return [];
    const det = await db.query(
      `SELECT e.id, e.person_id, at.slug, at.display_name AS label, pb.batch_number,
              pr.canonical_name AS product,
              (at.slug IN ('production_line','encapsulation','fnsku_labeling') OR at.requires_order_count = true) AS needs_count
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
         LEFT JOIN v3.products pr ON pr.id = pb.product_id
        WHERE e.id = ANY($1::int[])`, [eventIds]);
    return det.rows;
  }

  // ── entrar numa pausa que JÁ ESTÁ RODANDO ──────────────────

  /**
   * A PERGUNTA do Bruno, aplicada. Anexa `person_id` a uma pausa em andamento e
   * congela os eventos dele conforme a resposta.
   *
   *   since 'inicio' → credita (agora − started_at da pausa) e congela
   *   since 'agora'  → só congela
   *   since ausente  → assume 'agora' (conservador), marca join_assumed = TRUE
   *                    e deixa a pergunta PENDENTE. Nunca bloqueia (REGRA #0).
   *
   * Idempotente: chamar duas vezes com a mesma resposta não credita duas vezes.
   * Chamar com uma resposta DIFERENTE da assumida CORRIGE os números (é o
   * caminho "respondeu depois" do evento 3583).
   */
  async function joinPause({ pause_event_id, person_id, since = null, actor_person_id = null } = {}) {
    const pid = parseInt(person_id, 10);
    const pause = await getPause(pause_event_id);
    if (!pause) return { ok: false, error: 'pause_not_found' };
    if (!Number.isFinite(pid)) return { ok: false, error: 'person_id_required' };
    if (pause.ended_at) return { ok: false, error: 'pause_already_ended' };

    const answered = isSince(since);
    const effective = answered ? since : SINCE.AGORA;   // conservador enquanto não responde

    // evento de pausa DESTA pessoa (o dela, não o do starter)
    let mine = null;
    if (pid === pause.person_id) {
      mine = { id: pause.id, joined_since: SINCE.INICIO, joined_at: pause.started_at, join_assumed: false };
    } else {
      mine = (await db.query(
        `SELECT e.id, e.joined_since, e.joined_at, COALESCE(e.join_assumed, FALSE) AS join_assumed
           FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
          WHERE e.person_id = $1 AND e.deleted_at IS NULL AND at.slug = ANY($2::text[])
            AND (e.cowork_group_id = $3::uuid OR e.id = $4)
          ORDER BY e.started_at DESC LIMIT 1`,
        [pid, PAUSE_SLUGS, pause.cowork_group_id || null, pause.id])).rows[0] || null;
    }

    // o starter nunca "entra tarde" na própria pausa: nada a corrigir.
    if (pid === pause.person_id) {
      const fr = await freezeFor([pid], [pause.id]);
      return { ok: true, is_starter: true, since: SINCE.INICIO, assumed: false, frozen: fr.count, credited_seconds: 0 };
    }

    // Quanto já estava creditado ANTES desta chamada. Lido aqui, antes do INSERT,
    // porque o evento recém-criado já nasce com joined_since preenchido — e ler
    // depois faria o serviço achar que o crédito 'inicio' já tinha sido dado.
    const alreadyInicio = !!(mine && mine.joined_since === SINCE.INICIO);

    // 1ª vez que a pessoa entra: cria o evento de pausa dela no MESMO grupo, se
    // ainda não tem (caminho do admin, que só mexeu no cowork_with).
    let created = false;
    if (!mine) {
      const ins = await db.query(
        `INSERT INTO v3.events
           (person_id, activity_type_id, product_batch_id, started_at, description,
            cowork_with, cowork_group_id, confidence, source, is_test, joined_at, joined_since, join_assumed)
         SELECT $1, e.activity_type_id, e.product_batch_id, NOW(), e.description,
                '{}'::int[], e.cowork_group_id, 'high', 'pause_join', e.is_test, NOW(), $3, $4
           FROM v3.events e WHERE e.id = $2
         RETURNING id, joined_since, joined_at, join_assumed`,
        [pid, pause.id, answered ? since : null, !answered]);
      mine = ins.rows[0];
      created = true;
    }

    // Quantos segundos creditar AGORA. 'inicio' = da largada da pausa até este
    // instante; 'agora' = zero. Se já tinha sido creditado antes (resposta
    // anterior), credita só a DIFERENÇA — é o que torna a correção segura.
    let creditSeconds = 0;
    if (effective === SINCE.INICIO && !alreadyInicio) {
      const g = (await db.query(
        `SELECT GREATEST(0, EXTRACT(EPOCH FROM (NOW() - $1::timestamptz))::int) AS secs`,
        [pause.started_at])).rows[0];
      creditSeconds = parseInt(g && g.secs, 10) || 0;
    }

    // já estava congelado (o join anterior congelou) → só corrige o crédito;
    // senão congela agora, já somando o crédito na mesma escrita.
    const alreadyFrozen = !created && (await db.query(
      `SELECT 1 FROM v3.events
        WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
          AND paused_at IS NOT NULL AND id <> $2 LIMIT 1`, [pid, mine.id])).rowCount > 0;

    let frozen = 0;
    let corrected = 0;
    if (alreadyFrozen) {
      if (creditSeconds > 0) {
        const r = await db.query(
          `UPDATE v3.events
              SET total_paused_seconds = total_paused_seconds + $2::int, updated_at = NOW()
            WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
              AND paused_at IS NOT NULL AND id <> $3
            RETURNING id`, [pid, creditSeconds, mine.id]);
        corrected = r.rowCount;
      }
    } else {
      const fr = await freezeFor([pid], [mine.id], { creditSeconds: { [pid]: creditSeconds } });
      frozen = fr.count;
    }

    // grava a RESPOSTA (ou o assumido) no evento de pausa da pessoa
    await db.query(
      `UPDATE v3.events
          SET joined_since = $2, joined_at = COALESCE(joined_at, NOW()),
              join_assumed = $3, updated_at = NOW()
        WHERE id = $1`,
      [mine.id, answered ? since : (mine.joined_since || null), !answered && !alreadyInicio]);

    // mantém o cowork_with coerente nos dois sentidos (o dashboard desenha daí)
    await syncCoworkWith(pause, pid).catch(() => {});

    await log('pause.join', mine.id, {
      pause_event_id: pause.id, person_id: pid, since: effective,
      answered, credited_seconds: creditSeconds, frozen, corrected, created,
    }, actor_person_id || pid);

    return {
      ok: true, is_starter: false, pause_event_id: pause.id, event_id: mine.id,
      since: effective, assumed: !answered, created,
      frozen, corrected, credited_seconds: creditSeconds,
      pause_started_at: pause.started_at,
    };
  }

  // liga o cowork_with dos dois lados dentro do grupo da pausa (display).
  async function syncCoworkWith(pause, joinerId) {
    if (!pause.cowork_group_id) return;
    await db.query(
      `UPDATE v3.events
          SET cowork_with = array_append(COALESCE(cowork_with, '{}'), $2), updated_at = NOW()
        WHERE cowork_group_id = $1::uuid AND ended_at IS NULL AND deleted_at IS NULL
          AND person_id <> $2 AND NOT (COALESCE(cowork_with, '{}') @> ARRAY[$2]::int[])`,
      [pause.cowork_group_id, joinerId]);
  }

  // ── pergunta PENDENTE (o caso do 3583: ninguém no kiosk) ───

  /**
   * A pessoa tocou o kiosk. Tem alguma pausa em que ela entrou e ainda não
   * respondeu "desde o começo ou agora"? Devolve a pergunta pronta pro /op,
   * com os dois horários já formatados (HH:MM, fuso da linha).
   *
   * A pausa PODE JÁ TER TERMINADO e a pergunta continua valendo: no evento 3583
   * o break acabou 12:43:07 e o Bruno Sarmento só voltou ao kiosk bem depois.
   * Exigir `ended_at IS NULL` faria justamente o caso real sumir sem ser
   * perguntado. Limite: só HOJE (fuso da linha) — perguntar sobre a pausa de
   * terça-feira passada não ajuda ninguém a lembrar.
   *
   * Devolve null quando não há nada a perguntar — nunca lança.
   */
  async function pendingQuestionFor(personId, tz = 'America/New_York') {
    const pid = parseInt(personId, 10);
    if (!Number.isFinite(pid)) return null;
    try {
      const r = await db.query(
        `SELECT e.id AS event_id, e.cowork_group_id, e.joined_at, e.description,
                to_char(e.joined_at AT TIME ZONE $2, 'HH24:MI') AS joined_hhmm,
                pe.id AS pause_event_id, pe.started_at AS pause_started_at,
                to_char(pe.started_at AT TIME ZONE $2, 'HH24:MI') AS pause_hhmm,
                st.display_name AS starter_name
           FROM v3.events e
           JOIN v3.activity_types at ON at.id = e.activity_type_id
           LEFT JOIN LATERAL (
             SELECT e2.id, e2.started_at, e2.person_id FROM v3.events e2
              JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id
              WHERE e2.cowork_group_id = e.cowork_group_id AND e2.deleted_at IS NULL
                AND at2.slug = ANY($3::text[]) AND e2.person_id <> e.person_id
              ORDER BY e2.started_at LIMIT 1
           ) pe ON TRUE
           LEFT JOIN v3.persons st ON st.id = pe.person_id
          WHERE e.person_id = $1 AND e.deleted_at IS NULL AND at.slug = ANY($3::text[])
            AND e.joined_since IS NULL AND e.joined_at IS NOT NULL
            AND (e.started_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date
          ORDER BY e.started_at DESC LIMIT 1`,
        [pid, tz, PAUSE_SLUGS]);
      const q = r.rows[0];
      if (!q) return null;
      const note = (q.description || '').replace(/\s*\|\s*fim:.*/i, '').trim();
      return {
        event_id: q.event_id,
        pause_event_id: q.pause_event_id || null,
        starter_name: q.starter_name || null,
        note: note || null,
        pause_started_at: q.pause_started_at || null,
        pause_hhmm: q.pause_hhmm || null,
        joined_at: q.joined_at || null,
        joined_hhmm: q.joined_hhmm || null,
        assumed: SINCE.AGORA,   // o que já está valendo enquanto ela não responde
      };
    } catch (e) {
      console.error('[pause] pendingQuestionFor falhou (não bloqueia):', e.message);
      return null;
    }
  }

  /**
   * A pessoa respondeu a pergunta pendente. 'inicio' credita o que faltava;
   * 'agora' só confirma o que já estava valendo (nada muda nos números).
   */
  async function answerPending({ event_id, person_id, since, tz = 'America/New_York' } = {}) {
    const pid = parseInt(person_id, 10);
    const eid = parseInt(event_id, 10);
    if (!Number.isFinite(eid) || !Number.isFinite(pid)) return { ok: false, error: 'event_id_required' };
    if (!isSince(since)) return { ok: false, error: 'invalid_since' };
    const me = (await db.query(
      `SELECT e.id, e.person_id, e.started_at, e.joined_at, e.joined_since, e.cowork_group_id
         FROM v3.events e JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE e.id = $1 AND e.person_id = $2 AND e.deleted_at IS NULL AND at.slug = ANY($3::text[])`,
      [eid, pid, PAUSE_SLUGS])).rows[0];
    if (!me) return { ok: false, error: 'pause_event_not_found' };
    if (me.joined_since) return { ok: true, already: me.joined_since, credited_seconds: 0 };

    // "desde o começo" → falta creditar a JANELA CEGA: do início da pausa (a do
    // colega) até o instante em que ela foi anexada. Dali em diante o relógio já
    // estava parado (o congelamento conservador cobriu esse pedaço).
    //
    // O crédito NÃO pode exigir paused_at IS NOT NULL: quando a pausa já acabou
    // (caso 3583 — o break fechou 12:43:07 e a pessoa só voltou ao kiosk depois)
    // os eventos dela já foram descongelados. O alvo certo é "os eventos DELA que
    // estavam rodando durante a janela cega", com ou sem paused_at agora.
    let credited = 0;
    let touched = 0;
    if (since === SINCE.INICIO) {
      const pauseStart = (await db.query(
        `SELECT MIN(e2.started_at) AS s FROM v3.events e2
           JOIN v3.activity_types at2 ON at2.id = e2.activity_type_id
          WHERE e2.cowork_group_id = $1::uuid AND e2.deleted_at IS NULL AND at2.slug = ANY($2::text[])`,
        [me.cowork_group_id || null, PAUSE_SLUGS])).rows[0];
      const from = (pauseStart && pauseStart.s) || me.started_at;
      const to = me.joined_at || me.started_at;
      const g = (await db.query(
        `SELECT GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - $1::timestamptz))::int) AS secs`,
        [from, to])).rows[0];
      credited = parseInt(g && g.secs, 10) || 0;
      if (credited > 0) {
        // por evento: credita só o que ELE realmente cobriu da janela cega (um
        // evento que começou no meio da pausa não leva a janela inteira).
        const r = await db.query(
          `UPDATE v3.events e
              SET total_paused_seconds = e.total_paused_seconds + GREATEST(0, EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(e.ended_at, NOW()), $3::timestamptz)
                    - GREATEST(e.started_at, $2::timestamptz)))::int),
                  updated_at = NOW()
            FROM v3.activity_types at
           WHERE at.id = e.activity_type_id
             AND e.person_id = $1 AND e.deleted_at IS NULL AND e.id <> $4
             AND at.slug <> ALL($5::text[])
             AND e.started_at < $3::timestamptz
             AND COALESCE(e.ended_at, NOW()) > $2::timestamptz
           RETURNING e.id`,
          [pid, from, to, me.id, PAUSE_SLUGS]);
        touched = r.rowCount;
      }
    }
    await db.query(
      `UPDATE v3.events SET joined_since = $2, join_assumed = FALSE, updated_at = NOW() WHERE id = $1`,
      [me.id, since]);
    await log('pause.join_answered', me.id, { since, credited_seconds: credited, events: touched }, pid);
    return { ok: true, since, credited_seconds: credited, events: touched };
  }

  // ── fim da pausa: descongela o GRUPO INTEIRO ───────────────

  /**
   * Quem termina a pausa termina PRA TODO MUNDO (mesma regra do fim de cowork).
   * Devolve as tarefas descongeladas por pessoa, pra que cada kiosk faça a sua
   * pergunta "continuar ou finalizar?".
   *
   * NÃO fecha eventos: quem fecha o 'break' é o /end de src/routes/op.js. Aqui só
   * o relógio volta a andar.
   */
  async function endPauseFor(pauseEventId) {
    const parts = await participantsOf(pauseEventId);
    if (!parts.length) return { count: 0, by_person: {}, participants: [] };
    const r = await resumeFor(parts.map((p) => p.person_id));
    return { ...r, participants: parts };
  }

  // ── REPARO do histórico (evento 3583) ──────────────────────

  /**
   * Calcula (e opcionalmente aplica) o desconto que FALTOU numa pausa antiga.
   * Para cada participante, olha os eventos DELE que se sobrepõem à janela da
   * pausa e mede a sobreposição real (interseção dos dois intervalos), descontando
   * o que já está em total_paused_seconds.
   *
   * dry-run por padrão. { apply: true } escreve.
   *
   * Devolve { pause, window, rows: [{ event_id, person_id, person, slug,
   *   overlap_seconds, current_paused, would_add, new_paused }], applied }.
   */
  async function repairPauseOverlap({ pause_event_id, apply = false, actor_person_id = null } = {}) {
    const pause = await getPause(pause_event_id);
    if (!pause) return { ok: false, error: 'pause_not_found' };
    const parts = await participantsOf(pause_event_id);
    const personIds = parts.map((p) => p.person_id);
    const pauseEventIds = parts.map((p) => p.pause_event_id).filter(Boolean);

    // janela da pausa: started_at → ended_at (ou agora, se ainda aberta)
    const win = (await db.query(
      `SELECT $1::timestamptz AS s, COALESCE($2::timestamptz, NOW()) AS e,
              GREATEST(0, EXTRACT(EPOCH FROM (COALESCE($2::timestamptz, NOW()) - $1::timestamptz))::int) AS secs`,
      [pause.started_at, pause.ended_at || null])).rows[0];

    // eventos de CADA participante que cruzam a janela — menos os próprios
    // eventos de pausa (que não se descontam) e qualquer outra pausa.
    const rows = (await db.query(
      `SELECT e.id AS event_id, e.person_id, p.display_name AS person, at.slug,
              e.started_at, e.ended_at, e.total_paused_seconds AS current_paused,
              GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(e.ended_at, NOW()), $2::timestamptz)
                - GREATEST(e.started_at, $1::timestamptz)
              ))::int) AS overlap_seconds
         FROM v3.events e
         JOIN v3.activity_types at ON at.id = e.activity_type_id
         LEFT JOIN v3.persons p ON p.id = e.person_id
        WHERE e.person_id = ANY($3::int[]) AND e.deleted_at IS NULL
          AND NOT (e.id = ANY($4::int[]))
          AND at.slug <> ALL($5::text[])
          AND e.started_at < $2::timestamptz
          AND COALESCE(e.ended_at, NOW()) > $1::timestamptz
        ORDER BY e.person_id, e.started_at`,
      [win.s, win.e, personIds.length ? personIds : [-1],
        pauseEventIds.length ? pauseEventIds : [-1], PAUSE_SLUGS])).rows;

    const report = rows.map((r) => {
      const overlap = parseInt(r.overlap_seconds, 10) || 0;
      const current = parseInt(r.current_paused, 10) || 0;
      // nunca REMOVE desconto: se já tem tanto ou mais do que a sobreposição, 0.
      const wouldAdd = Math.max(0, overlap - current);
      return {
        event_id: r.event_id, person_id: r.person_id, person: r.person || null, slug: r.slug,
        started_at: r.started_at, ended_at: r.ended_at,
        overlap_seconds: overlap, current_paused: current,
        would_add: wouldAdd, new_paused: current + wouldAdd,
      };
    });

    let applied = 0;
    if (apply) {
      for (const row of report) {
        if (row.would_add <= 0) continue;
        await db.query(
          `UPDATE v3.events SET total_paused_seconds = total_paused_seconds + $2::int, updated_at = NOW()
            WHERE id = $1`, [row.event_id, row.would_add]);
        applied += 1;
      }
      await log('pause.repair_applied', pause.id, {
        pause_event_id: pause.id, events: applied,
        seconds: report.reduce((a, r) => a + r.would_add, 0),
      }, actor_person_id);
    }

    return {
      ok: true, applied: apply ? applied : 0, dry_run: !apply,
      pause: { id: pause.id, person_id: pause.person_id, started_at: pause.started_at, ended_at: pause.ended_at },
      window: { start: win.s, end: win.e, seconds: parseInt(win.secs, 10) || 0 },
      participants: parts.map((p) => ({ person_id: p.person_id, pause_event_id: p.pause_event_id, joined_since: p.joined_since })),
      rows: report,
      total_would_add: report.reduce((a, r) => a + r.would_add, 0),
    };
  }

  return {
    PAUSE_SLUGS, SINCE,
    getPause, participantsOf,
    freezeFor, resumeFor, describeTasks,
    joinPause, pendingQuestionFor, answerPending,
    endPauseFor, repairPauseOverlap,
  };
}

module.exports = { createPauseService, PAUSE_SLUGS, SINCE, isSince };
