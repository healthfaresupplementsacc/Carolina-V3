'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.4 — EventService (V3 doc §6.4 + §6.6 + §3.7)
 *
 * PORTA ÚNICA de escrita em v3.events. Ninguém escreve direto na
 * tabela (COMMENT ON TABLE v3.events trava isso por documentação).
 *
 * Garante: idempotência por source_message_ts, auto-close do event
 * de trabalho anterior, cowork bidirecional simétrico (3+ pessoas),
 * soft delete universal, audit em CADA mutação.
 *
 * Regra break/lunch (§3.7): activity_type.category='meta' (break,
 * lunch) NÃO fecha o event de trabalho — coexiste. Invariante: por
 * pessoa, no máx 1 event de trabalho (category != meta) ativo.
 *
 * Princípio #24: toda query é schema-qualificada v3.*.
 *
 * ÚNICA exceção autorizada à porta-única: o BatchService faz bulk
 * UPDATE de v3.events.product_batch_id em reassignEvents/mergeBatches
 * (move estrutural de FK; atomicidade do merge exige). Aprovado por
 * Bruno Camp. Nenhuma outra escrita direta em v3.events é permitida.
 */

const VALID_ACTOR_TYPES = ['admin', 'llm_observer', 'llm_assistant', 'system', 'app_home'];

// colunas que correct() aceita alterar
const CORRECTABLE = new Set([
  'person_id', 'activity_type_id', 'product_batch_id', 'started_at', 'ended_at',
  'phase_label', 'description', 'confidence', 'closed_reason', 'cowork_with',
  'quantity', 'quantity_unit',
]);

// "kind" derivado do activity_type — invariante nova (Bloco Captura):
//   meta        — category='meta' (break/lunch). Coexiste com tudo.
//   background  — is_background=true (formulation/mixing/encapsulation).
//                 Roda na máquina; coexiste com foreground e outros bg.
//                 N abertas por pessoa. Só fecha com close explícito.
//   foreground  — o resto (incluindo activity_type_id NULL). Máx 1 por pessoa.
// Mantém 'work' como ALIAS de 'foreground' pra retro-compat dos chamadores.
const KIND_META = 'meta';
const KIND_BACKGROUND = 'background';
const KIND_FOREGROUND = 'foreground';

const uniq = (arr) => [...new Set(arr)];

/** Offset NY (EDT/EST) pra um YYYY-MM-DD. Usa Intl pra detectar DST.
 *  Antes safetyAutoClose tinha '-04:00' hardcoded (errava 1h em EST). */
function _nyOffsetForDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).formatToParts(new Date(noonUtc));
  const tz = (parts.find((p) => p.type === 'timeZoneName') || {}).value;
  return tz === 'EDT' ? '-04:00' : '-05:00';
}

/**
 * Guard de duração negativa (achado pós-shadow 21/mai): true se
 * ended_at < started_at. Vem de mensagens processadas fora de ordem
 * (re-processo em lote do FIX 4); em shadow ao vivo, mensagens em
 * ordem nunca produzem isso. Datas inválidas/nulas → false (não clampa
 * lixo, deixa passar).
 */
function isNegativeDuration(startedAt, endedAt) {
  if (startedAt == null || endedAt == null) return false;
  const s = new Date(startedAt).getTime();
  const e = new Date(endedAt).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return false;
  return e < s;
}

class EventService {
  /** @param {object} deps  deps.db = pool pg (search_path v3,public) */
  constructor(deps = {}) {
    this.db = deps.db;
  }

  // ── infra ──────────────────────────────────────────────────

  async _withTx(fn) {
    const hasPool = typeof this.db.connect === 'function';
    const client = hasPool ? await this.db.connect() : this.db;
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignora */ }
      throw e;
    } finally {
      if (hasPool && typeof client.release === 'function') client.release();
    }
  }

  _actor(type) {
    const t = type || 'system';
    if (!VALID_ACTOR_TYPES.includes(t)) {
      throw new Error('actor_type inválido: ' + type);
    }
    return t;
  }

  async _audit(c, { actorType, actorPersonId, action, targetId, before, after, metadata }) {
    await c.query(
      `INSERT INTO v3.audit_log
         (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
       VALUES ($1, $2, $3, 'event', $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [actorType, actorPersonId || null, action, targetId || null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        metadata ? JSON.stringify(metadata) : null]);
  }

  /** UPDATE uniforme de 1 event por id. fields = {col:value}.
   *  opts.forceEodPatch=true permite mexer em ended_at de eventos
   *  end_of_day (correct() admin-driven; audita warning).
   *  Pode retornar null se o guard dur=0 bloquear o patch (bloco 29/mai-noite #3)
   *  OU se o guard end_of_day intocável bloquear (bloco 30/mai). */
  async _patch(c, id, fields, opts = {}) {
    // GUARD duração negativa: se este patch grava ended_at < started_at,
    // clampa pro started_at (duração zero) e audita a anomalia. Preserva
    // a invariante "1 event de trabalho ativo" (≠ rejeitar o close, que
    // deixaria 2 events abertos). Em shadow ao vivo nunca dispara.
    if (Object.prototype.hasOwnProperty.call(fields, 'ended_at') && fields.ended_at != null) {
      let startedAt = fields.started_at;
      let activityTypeId;
      if (startedAt == null || Object.prototype.hasOwnProperty.call(fields, 'activity_type_id') === false) {
        const cur = await c.query('SELECT started_at, activity_type_id FROM v3.events WHERE id = $1', [id]);
        if (cur.rows[0]) {
          if (startedAt == null) startedAt = cur.rows[0].started_at;
          activityTypeId = cur.rows[0].activity_type_id;
        }
      } else {
        activityTypeId = fields.activity_type_id;
      }
      if (isNegativeDuration(startedAt, fields.ended_at)) {
        const attempted = fields.ended_at;
        fields = Object.assign({}, fields, { ended_at: startedAt });
        await this._audit(c, {
          actorType: 'system', action: 'event.negative_duration_clamped', targetId: id,
          before: { attempted_ended_at: attempted },
          after: { ended_at: startedAt },
          metadata: { guard: 'ended_at >= started_at', clamped_to: 'started_at', started_at: startedAt },
        });
      }
      // GUARD bloco 29/mai-noite #3 — dur=0 BLOQUEADO em non-eod.
      // Quando o patch resultaria em ended_at == started_at (exato match) E
      // o slug não é end_of_day (carimbo instantâneo legítimo), REJEITA o
      // patch inteiro e loga warning. Caller checa null e trata.
      // Caso real ev316/ev317 29/mai: _closeActive disparado por 2 opens
      // com mesmo started_at fechou o primeiro em ended_at = started_at,
      // gerando events fantasmas dur=0 inválidos.
      const eq = startedAt && fields.ended_at
        && new Date(fields.ended_at).getTime() === new Date(startedAt).getTime();
      const isEod = await this._isEndOfDay(c, activityTypeId);
      if (eq && !isEod) {
        await this._audit(c, {
          actorType: 'system', action: 'event.close_blocked_dur_zero', targetId: id,
          before: null, after: null,
          metadata: {
            guard: 'ended_at == started_at e slug != end_of_day',
            attempted_fields: Object.keys(fields),
            started_at: startedAt,
            attempted_ended_at: fields.ended_at,
            activity_type_id: activityTypeId,
          },
        });
        return null;   // patch rejected; caller deve checar e tratar
      }
      // GUARD bloco 30/mai — end_of_day INTOCÁVEL após criação.
      // Caso real ev305 28/mai: meta_closed_by_fg fechou o end_of_day no
      // dia seguinte (16h42 inflado), quebrando o invariant "carimbo
      // instantâneo". Quando patch tenta mudar ended_at != started_at de
      // um end_of_day, REJEITA — exceto se caller passar forceEodPatch
      // (admin correct() explícito; loga warning em ambos os casos).
      if (isEod && !eq && fields.ended_at) {
        if (opts.forceEodPatch) {
          await this._audit(c, {
            actorType: 'system', action: 'event.eod_patch_forced', targetId: id,
            before: null, after: null,
            metadata: {
              warning: 'admin forçou patch em end_of_day (invariant carimbo instantâneo quebrado intencionalmente)',
              attempted_fields: Object.keys(fields),
              original_started_at: startedAt,
              attempted_ended_at: fields.ended_at,
              activity_type_id: activityTypeId,
            },
          });
          // continua — admin permite
        } else {
          await this._audit(c, {
            actorType: 'system', action: 'event.eod_patch_blocked', targetId: id,
            before: null, after: null,
            metadata: {
              guard: 'end_of_day intocável após criação',
              attempted_fields: Object.keys(fields),
              original_started_at: startedAt,
              attempted_ended_at: fields.ended_at,
              activity_type_id: activityTypeId,
            },
          });
          return null;
        }
      }
    }
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await c.query(
      `UPDATE v3.events SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => fields[k])]);
    return r.rows[0];
  }

  async _insert(c, p) {
    // GUARD duração negativa no insert (mesmo motivo do _patch).
    let endedAt = p.ended_at || null;
    const clampedInsert = isNegativeDuration(p.started_at, endedAt);
    if (clampedInsert) endedAt = p.started_at;

    // GUARD bloco 29/mai-noite #3 — dur=0 BLOQUEADO em non-eod no INSERT.
    // Defesa contra caller passar ended_at == started_at em slug não-eod.
    // (end_of_day é exceção legítima: já é instantâneo por design.)
    if (endedAt && p.started_at
        && new Date(endedAt).getTime() === new Date(p.started_at).getTime()) {
      const isEod = await this._isEndOfDay(c, p.activity_type_id);
      if (!isEod) {
        await this._audit(c, {
          actorType: 'system', action: 'event.insert_blocked_dur_zero', targetId: null,
          before: null, after: null,
          metadata: {
            guard: 'ended_at == started_at e slug != end_of_day',
            person_id: p.person_id,
            started_at: p.started_at,
            attempted_ended_at: endedAt,
            activity_type_id: p.activity_type_id || null,
            source_message_ts: p.source_message_ts || null,
            description: p.description || null,
          },
        });
        return null;   // insert rejected; upsert deve checar e tratar
      }
    }

    const cols = ['person_id', 'activity_type_id', 'product_batch_id', 'started_at',
      'ended_at', 'phase_label', 'description', 'source_message_ts', 'confidence',
      'cowork_with', 'closed_reason', 'quantity', 'quantity_unit'];
    const vals = [
      p.person_id, p.activity_type_id || null, p.product_batch_id || null, p.started_at,
      endedAt, p.phase_label || null, p.description || null,
      p.source_message_ts || null, p.confidence || 'high',
      p.cowork_with || [], p.closed_reason || null,
      p.quantity != null ? p.quantity : null, p.quantity_unit || null];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await c.query(
      `INSERT INTO v3.events (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals);
    if (clampedInsert) {
      await this._audit(c, {
        actorType: 'system', action: 'event.negative_duration_clamped', targetId: r.rows[0].id,
        before: { attempted_ended_at: p.ended_at },
        after: { ended_at: endedAt },
        metadata: { guard: 'ended_at >= started_at', clamped_to: 'started_at', on: 'insert' },
      });
    }
    return r.rows[0];
  }

  /**
   * Retorna o "kind" do activity_type:  'meta' | 'background' | 'foreground'.
   * activity_type_id NULL → tratado como foreground (mantém comportamento
   * antigo de "sem classificação = trabalho").
   */
  async _kindOf(c, activityTypeId) {
    if (!activityTypeId) return KIND_FOREGROUND;
    const r = await c.query(
      'SELECT category, is_background FROM v3.activity_types WHERE id = $1',
      [activityTypeId]);
    const row = r.rows[0];
    if (!row) return KIND_FOREGROUND;
    if (row.category === 'meta') return KIND_META;
    if (row.is_background === true) return KIND_BACKGROUND;
    return KIND_FOREGROUND;
  }

  /**
   * Bloco 28/mai noite #32 — END_OF_DAY é instantâneo (carimbo de momento).
   * Retorna true se o activity_type é slug='end_of_day'. Usado no upsert pra
   * (a) forçar ended_at = started_at se não vier; (b) fechar foreground LIVE
   * da pessoa nesse horário com closed_reason='end_of_day'. Background
   * (long_running ou não) NÃO é fechado — quem está rodando continua
   * (long_running cruza noite; bg single-day fecha via safetyAutoClose).
   */
  async _isEndOfDay(c, activityTypeId) {
    if (!activityTypeId) return false;
    const r = await c.query(
      "SELECT 1 FROM v3.activity_types WHERE id = $1 AND slug = 'end_of_day'",
      [activityTypeId]);
    return r.rows.length > 0;
  }

  /** Lê uma setting JSONB. Retorna fallback se a tabela/setting não existir. */
  async _setting(c, key, fallback) {
    try {
      const r = await c.query('SELECT value FROM v3.settings WHERE key = $1', [key]);
      if (!r.rows[0]) return fallback;
      const v = r.rows[0].value;
      // value chega como objeto/primitivo já parsado pelo node-pg, mas
      // alguns ambientes devolvem string — normaliza.
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (_) { return v; }
      }
      return v;
    } catch (_) { return fallback; }
  }

  async _findBySourceTx(c, ts) {
    if (!ts) return null;
    const r = await c.query(
      'SELECT * FROM v3.events WHERE source_message_ts = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1', [ts]);
    return r.rows[0] || null;
  }

  async _getById(c, id) {
    const r = await c.query('SELECT * FROM v3.events WHERE id = $1', [id]);
    return r.rows[0] || null;
  }

  async _activeByPerson(c, personId) {
    const r = await c.query(
      `SELECT * FROM v3.events
       WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL
       ORDER BY started_at DESC`, [personId]);
    return r.rows;
  }

  /**
   * Event FOREGROUND ativo mais recente da pessoa. Renomeado de
   * _activeWorkEvent (que ainda fica como alias pra retro-compat).
   * Ignora background (coexiste) e meta. Usado pelo cowork.
   */
  async _activeForegroundEvent(c, personId) {
    const rows = await this._activeByPerson(c, personId);
    for (const ev of rows) {
      if ((await this._kindOf(c, ev.activity_type_id)) === KIND_FOREGROUND) return ev;
    }
    return null;
  }

  /** Alias pra código antigo. Mantido pra retro-compat (testes/chamadas). */
  async _activeWorkEvent(c, personId) {
    return this._activeForegroundEvent(c, personId);
  }

  // ── cowork ─────────────────────────────────────────────────

  /**
   * Sincroniza cowork BIDIRECIONAL. Pra cada pessoa do grupo (dono +
   * coworkers), encontra o event-âncora (foreground ativo) e grava o
   * cowork_with apontando pras OUTRAS. Os events ancorados ficam com o
   * cowork histórico — quando fecham, MANTÊM o cowork (não sofrem unlink).
   * Esse é o conserto do bug descoberto na auditoria do dia 22.
   */
  async _syncCowork(c, eventId, coworkPersonIds) {
    const ev = await this._getById(c, eventId);
    if (!ev) return;
    const group = uniq([ev.person_id, ...(coworkPersonIds || [])]);
    for (const personId of group) {
      let targetId = null;
      if (personId === ev.person_id) {
        targetId = eventId;
      } else {
        const w = await this._activeForegroundEvent(c, personId);
        targetId = w ? w.id : null;
        // SINCRONIA DE VERDADE (Bruno 07-02): o coworker SEM evento-âncora ganha um
        // EVENTO ESPELHO na própria timeline (mesma atividade/lote/janela). Antes só
        // marcava cowork_with no evento do dono e o coworker ficava sem NADA — caso
        // da Reunião da Ana (ev criado no dashboard) que não aparecia pra Simone.
        // Vale pra evento FECHADO (retroativo) e pra ABERTO sem âncora do coworker.
        // Guarda anti-duplicata: pula se o coworker já tem evento da MESMA atividade
        // sobrepondo a janela.
        if (!targetId && ev.started_at) {
          const dup = await c.query(
            `SELECT 1 FROM v3.events
              WHERE person_id = $1 AND deleted_at IS NULL AND activity_type_id = $2
                AND started_at < COALESCE($4::timestamptz, NOW())
                AND COALESCE(ended_at, NOW()) > $3::timestamptz
              LIMIT 1`,
            [personId, ev.activity_type_id, ev.started_at, ev.ended_at || null]);
          if (!dup.rowCount) {
            const ins = await c.query(
              `INSERT INTO v3.events
                 (person_id, activity_type_id, product_batch_id, started_at, ended_at,
                  phase_label, description, confidence, source, closed_reason, cowork_group_id, is_test)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, false))
               RETURNING id`,
              [personId, ev.activity_type_id, ev.product_batch_id || null, ev.started_at, ev.ended_at || null,
                ev.phase_label || null, ev.description || null, ev.confidence || 'high',
                ev.source || 'admin_cowork_mirror', ev.ended_at ? (ev.closed_reason || 'cowork_mirror') : null,
                ev.cowork_group_id || null, ev.is_test]);
            targetId = ins.rows[0].id;
          }
        }
      }
      if (targetId) {
        await this._patch(c, targetId, { cowork_with: group.filter((x) => x !== personId) });
      }
    }
  }

  // ── close ──────────────────────────────────────────────────

  /**
   * Fecha event(s) ativo(s) da pessoa.
   * @param {object} opts  opts.kind:
   *   'foreground' (default) — fecha foreground ativo (1)
   *   'background'           — fecha background(s) ativo(s); se houver
   *                            activityTypeId, fecha SÓ o(s) daquele tipo
   *                            (FIFO se múltiplos)
   *   'meta'                 — fecha meta(s) (break/lunch) ativo(s)
   *   'any'                  — fecha tudo aberto
   *   'work'                 — ALIAS de 'foreground' (retro-compat)
   * @param {number} opts.activityTypeId  filtra pelo activity_type (close
   *   nomeado, ex.: "F: encapsulação"). Quando setado, fecha SÓ os events
   *   abertos com esse activity_type_id (FIFO: mais antigo primeiro).
   */
  async closeActivePersonEvent(personId, endedAt, reason, opts = {}) {
    const actorType = this._actor(opts.actorType);
    const kind = opts.kind === 'work' ? KIND_FOREGROUND : (opts.kind || KIND_FOREGROUND);
    return this._withTx((c) => this._closeActive(c, personId, endedAt, reason, kind, actorType, {
      actorPersonId: opts.actorPersonId, activityTypeId: opts.activityTypeId || null,
    }));
  }

  /**
   * Marca/desmarca evento como long-running (multi-dia). safetyAutoClose
   * pula eventos com is_long_running=true. Audita a mudança.
   * @param {number} eventId
   * @param {boolean} flag
   * @param {object} opts  { actorType, actorPersonId, reason }
   */
  async markLongRunning(eventId, flag, opts = {}) {
    const actorType = this._actor(opts.actorType);
    return this._withTx(async (c) => {
      const before = await c.query('SELECT * FROM v3.events WHERE id = $1', [eventId]);
      if (!before.rows[0]) throw new Error('event id=' + eventId + ' não existe');
      const r = await c.query(
        `UPDATE v3.events SET is_long_running = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [eventId, !!flag]);
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId,
        action: 'event.long_running_set', targetId: eventId,
        before: before.rows[0], after: r.rows[0],
        metadata: { is_long_running: !!flag, reason: opts.reason || null },
      });
      return r.rows[0];
    });
  }

  /** E7-cérebro #2 — fecha events BACKGROUND abertos do MESMO (pessoa, batch),
   *  pra formulação ser sequencial (peneira→mix→formulação no mesmo produto).
   *  Não toca foreground nem outros batches. Usa _patch + _audit como _closeActive. */
  async _closeMatchingBgSamePB(c, personId, batchId, endedAt, reason, actorType, opts = {}) {
    const r = await c.query(
      `SELECT e.id, e.activity_type_id, e.product_batch_id, e.started_at
       FROM v3.events e
       LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
       WHERE e.person_id = $1
         AND e.product_batch_id = $2
         AND e.ended_at IS NULL AND e.deleted_at IS NULL
         AND at.is_background = true
         -- NÃO dissolve CUSTÓDIA de máquina (bg_handoff): é responsabilidade
         -- humana; só termina pela devolução (returnMachineWork) ou /end do
         -- substituto (auditoria 07-07, mesma classe do fix do EMS).
         AND e.bg_handoff_from_person_id IS NULL`,
      [personId, batchId]);
    const closed = [];
    for (const ev of r.rows) {
      // Bloco 30/mai — defesa em profundidade: skip end_of_day.
      // (já filtrado pela query is_background=true, mas defense in depth.)
      if (await this._isEndOfDay(c, ev.activity_type_id)) continue;
      const after = await this._patch(c, ev.id, { ended_at: endedAt, closed_reason: reason });
      // Bloco 29/mai-noite #3: _patch retorna null se bloqueou (dur=0 non-eod).
      // Audit do bloqueio já foi feito; pula o audit de event.closed.
      if (!after) continue;
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'event.closed',
        targetId: ev.id, before: ev, after,
        metadata: { reason, kind: 'background', sequential: true, product_batch_id: batchId },
      });
      closed.push(after);
    }
    return closed;
  }

  async _closeActive(c, personId, endedAt, reason, kind, actorType, opts = {}) {
    const rows = await this._activeByPerson(c, personId);
    // ordem FIFO (mais antigo primeiro) — relevante quando opts.activityTypeId
    // bate em N events do mesmo tipo abertos: fecha o mais antigo primeiro.
    rows.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
    const closed = [];
    for (const ev of rows) {
      // filtro por activity_type_id nomeado (ex.: "F: encapsulação"):
      // quando setado, ignora events que não casam.
      if (opts.activityTypeId != null && ev.activity_type_id !== opts.activityTypeId) continue;
      const evKind = await this._kindOf(c, ev.activity_type_id);
      const matches = kind === 'any' || evKind === kind;
      if (!matches) continue;
      // Bloco 30/mai — end_of_day INTOCÁVEL. Pula silenciosamente eventos
      // end_of_day (caso histórico ev305 28/mai: meta_closed_by_fg do dia
      // seguinte fechou o end_of_day quebrando o invariant).
      if (await this._isEndOfDay(c, ev.activity_type_id)) continue;
      // CUSTÓDIA de máquina (bg_handoff) INTOCÁVEL por close automático/Observer
      // (auditoria 07-07): "F: encapsulação" do Slack fechava o evento do
      // substituto e a máquina não voltava pro dono. Só termina pela devolução
      // (returnMachineWork) ou /end explícito por id do substituto.
      if (ev.bg_handoff_from_person_id != null) continue;
      // FASE 1 (task sumiu) — tasks da OPERATOR PAGE são do operador: o
      // processamento Slack/Observer NÃO pode fechá-las quando chega uma NOVA
      // atividade (next_event/meta). Operadores usavam /op + Slack juntos e viam
      // tasks sumirem. O operador fecha via /op; o safety de fim-de-dia ainda pode.
      if (ev.source === 'operator_page' && (reason === 'next_event' || reason === 'meta_closed_by_fg')) continue;
      const after = await this._patch(c, ev.id, { ended_at: endedAt, closed_reason: reason });
      // Bloco 29/mai-noite #3: _patch retorna null quando bloquearia dur=0
      // em non-eod. Audit do bloqueio já foi feito. Pula audit de closed
      // e segue pro próximo event (event original permanece LIVE).
      if (!after) continue;
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'event.closed', targetId: ev.id,
        before: ev, after, metadata: { reason, kind, activityTypeId: opts.activityTypeId || null },
      });
      closed.push(after);
      // close nomeado fecha SÓ o primeiro match (FIFO). Sem nome, fecha tudo.
      if (opts.activityTypeId != null) break;
    }
    return closed;
  }

  // ── upsert (porta principal) ───────────────────────────────

  async upsert(p = {}) {
    const actorType = this._actor(p.actor_type);
    if (!p.person_id) throw new Error('upsert: person_id obrigatório');
    if (!p.started_at) throw new Error('upsert: started_at obrigatório');

    return this._withTx(async (c) => {
      // 1 — idempotência
      const existing = await this._findBySourceTx(c, p.source_message_ts);
      if (existing) {
        const after = await this._patch(c, existing.id, {
          activity_type_id: p.activity_type_id || null,
          product_batch_id: p.product_batch_id || null,
          started_at: p.started_at,
          ended_at: p.ended_at || null,
          phase_label: p.phase_label || null,
          description: p.description || null,
          confidence: p.confidence || 'high',
          closed_reason: p.closed_reason || null,
          quantity: p.quantity != null ? p.quantity : null,
          quantity_unit: p.quantity_unit || null,
        });
        await this._audit(c, {
          actorType, actorPersonId: p.actor_person_id, action: 'event.updated',
          targetId: existing.id, before: existing, after,
          metadata: { idempotent: true, source_message_ts: p.source_message_ts },
        });
        if (p.cowork_with && p.cowork_with.length) await this._syncCowork(c, existing.id, p.cowork_with);
        return after;
      }

      // 2a — END_OF_DAY (bloco 28/mai noite #32). Marca instantânea de
      // saída. Força ended_at = started_at e fecha foreground LIVE da
      // pessoa com closed_reason='end_of_day'. Background (long_running
      // OU single-day) NÃO é fechado aqui — long_running cruza noite;
      // bg single-day fecha via _closeMatchingBgSamePB do próximo turno
      // ou safetyAutoClose ao 21h. Aplicado ANTES do switch de KIND
      // porque end_of_day é categoria=meta mas tem semântica própria.
      const isEod = await this._isEndOfDay(c, p.activity_type_id);
      if (isEod) {
        if (!p.ended_at) p.ended_at = p.started_at;
        if (!p.closed_reason) p.closed_reason = 'end_of_day';
        await this._closeActive(c, p.person_id, p.started_at, 'end_of_day',
          KIND_FOREGROUND, actorType, { actorPersonId: p.actor_person_id });
      }

      // 2b — auto-close baseado no KIND do novo event (invariante nova):
      //
      //   foreground  → fecha o foreground ativo anterior em p.started_at
      //                 (emenda contígua). NÃO toca background nem meta.
      //   background  → abre sem fechar nada. Convive com foreground e
      //                 com outros background. Só fecha em close nomeado
      //                 ("F: encapsulação") ou no auto-close de segurança.
      //   meta        → almoço/break "pausam" foreground (configurável
      //                 via setting meta_pauses_foreground). Background
      //                 NÃO é pausado (roda na máquina). Caso real: Vitor
      //                 organização 12:13→13:45 + almoço 12:31 não podia
      //                 coexistir; almoço fecha a organização.
      //
      //   Antes-do-almoço-sem-volta: se o último foreground/background
      //   abriu há > break_assumed_seconds (~45min), o sistema NÃO sabe
      //   o tempo real do almoço; deixa o close natural acontecer.
      //   Quando a meta é fechada (volta do almoço), o consumidor de
      //   _closeActive(kind='meta') aplica a regra dos 45min.
      if (!p.ended_at) {
        const newKind = await this._kindOf(c, p.activity_type_id);
        if (newKind === KIND_FOREGROUND) {
          await this._closeActive(c, p.person_id, p.started_at, 'next_event',
            KIND_FOREGROUND, actorType, { actorPersonId: p.actor_person_id });
          // E7-bloco-27 regra 27 — F IMPLÍCITO DE META: se há meta aberta
          // (break/lunch) e a pessoa abre nova foreground sem F do break,
          // fecha o break no started_at da nova fg. Estado "almoço + fg"
          // simultâneo NÃO pode existir. closed_reason='meta_closed_by_fg'.
          await this._closeActive(c, p.person_id, p.started_at, 'meta_closed_by_fg',
            KIND_META, actorType, { actorPersonId: p.actor_person_id });
        } else if (newKind === KIND_META) {
          const metaPausesFg = await this._setting(c, 'meta_pauses_foreground', true);
          if (metaPausesFg) {
            await this._closeActive(c, p.person_id, p.started_at, 'paused_by_meta',
              KIND_FOREGROUND, actorType, { actorPersonId: p.actor_person_id });
          }
        } else if (newKind === KIND_BACKGROUND && p.product_batch_id) {
          // Regra E7-cérebro #2 — etapas SEQUENCIAIS do MESMO produto+batch+pessoa:
          // peneira → mix → formulação. Uma nova etapa BACKGROUND do mesmo
          // (person+product_batch_id) FECHA a anterior. Permite formulações
          // PARALELAS de OUTROS produtos/batches (L-Carnitine no mix enquanto
          // Graviola na linha = ok). Sem product_batch_id (formulação solta),
          // mantém comportamento antigo (não fecha nada — N bg coexistem).
          await this._closeMatchingBgSamePB(c, p.person_id, p.product_batch_id,
            p.started_at, 'next_phase', actorType, { actorPersonId: p.actor_person_id });
        }
        // background sem product_batch_id: nada a fechar. Múltiplos bg coexistem.
      }

      // 3 — insert
      const ev = await this._insert(c, p);
      // Bloco 29/mai-noite #3: _insert retorna null se bloqueou dur=0 non-eod.
      // Audit do bloqueio já foi gravado; retornamos null pro caller checar.
      if (!ev) return null;
      await this._audit(c, {
        actorType, actorPersonId: p.actor_person_id, action: 'event.created',
        targetId: ev.id, before: null, after: ev,
      });

      // 4 — cowork sync
      if (p.cowork_with && p.cowork_with.length) await this._syncCowork(c, ev.id, p.cowork_with);
      return ev;
    });
  }

  // ── leitura / utilitários públicos ─────────────────────────

  /**
   * Lista os events abertos de uma pessoa enriquecidos com o KIND
   * (meta|background|foreground). Usado pelo Observer e pelo prompt-
   * builder pra raciocinar sobre "qual fechar" / "o que pausa o quê".
   */
  async getActiveEventsByPerson(personId) {
    return this._withTx(async (c) => {
      const rows = await this._activeByPerson(c, personId);
      const out = [];
      for (const ev of rows) {
        out.push(Object.assign({}, ev, { kind: await this._kindOf(c, ev.activity_type_id) }));
      }
      return out;
    });
  }

  /**
   * Auto-close de SEGURANÇA no fim do expediente. Fecha events abertos
   * cujo started_at é de um dia NY < refTime ou do mesmo dia mas após
   * a hora do fim do expediente (settings.expedient_end_hour_ny, default
   * 19h NY). ended_at = (data NY do started_at) + expedient_end_hour.
   * Se já é depois desse horário, o event de hoje também entra. Idempotente:
   * só pega events abertos; ao re-rodar não fecha duas vezes.
   *
   * Marca closed_reason='auto_closed_eod' e audita actor_type='system'.
   * Aplica a foreground E a background (esquecidos pra sempre é o cenário).
   * Não toca em meta (almoço sem volta vira problema separado, A4).
   */
  async safetyAutoClose(refTimeArg) {
    const refTime = refTimeArg ? new Date(refTimeArg) : new Date();
    return this._withTx(async (c) => {
      // Default 21h (9PM NY) desde migration 010 — expediente real 8am–9pm.
      // Era 19 (7PM) e fechava events que continuavam até 21h — Henrique
      // tinha que cobrar "F" manualmente. Default fallback agora 21.
      const endHour = await this._setting(c, 'expedient_end_hour_ny', 21);
      // is_long_running = true → evento multi-dia (Potassium/Chromium etc).
      // safetyAutoClose IGNORA esses. Defesa contra coluna ausente: COALESCE.
      // (Migration 011 adiciona; antes dela todos têm false implícito.)
      const r = await c.query(
        `SELECT e.id, e.person_id, e.activity_type_id, e.started_at, e.ended_at,
                e.cowork_with, e.confidence,
                (e.started_at AT TIME ZONE 'America/New_York')::date AS ny_date
         FROM v3.events e
         WHERE e.ended_at IS NULL AND e.deleted_at IS NULL
           AND COALESCE(e.is_long_running, false) = false`);
      const closed = [];
      for (const ev of r.rows) {
        const kind = await this._kindOf(c, ev.activity_type_id);
        if (kind === KIND_META) continue;  // meta tem regra própria (45min)
        // ended_at = data NY do started_at + endHour:00 NY com offset DST-aware.
        // Antes: hardcode '-04:00' (EDT) errava 1h em EST (Nov-Mar). Agora
        // detecta EDT/EST via Intl pra cada ny_date.
        const nyDate = String(ev.ny_date instanceof Date
          ? ev.ny_date.toISOString().slice(0, 10) : ev.ny_date);
        const offset = _nyOffsetForDate(nyDate);
        const eodIso = `${nyDate}T${String(endHour).padStart(2, '0')}:00:00${offset}`;
        // só fecha se refTime já passou desse EOD
        if (refTime < new Date(eodIso)) continue;
        // Guard contra duração negativa: se o event abriu APÓS o EOD (ex.: 21:25 NY,
        // EOD 21:00 do mesmo dia), o ended_at calculado ficaria ANTES do started_at.
        // Pula — esse event abre num "expediente esticado" e safetyAutoClose do
        // PRÓXIMO dia (com ny_date+1) pega ele. (Não cria invalid_event.)
        if (new Date(ev.started_at) >= new Date(eodIso)) continue;
        const after = await this._patch(c, ev.id, {
          ended_at: eodIso,
          closed_reason: 'auto_closed_eod',
        });
        await this._audit(c, {
          actorType: 'system', action: 'event.closed', targetId: ev.id,
          before: ev, after,
          // metadata.notify=true → atencao card no dashboard (parte 4)
          metadata: { reason: 'auto_closed_eod', kind, ny_date: nyDate, end_hour: endHour, notify: true },
        });
        closed.push(after);
      }
      return closed;
    });
  }

  // ── leitura ────────────────────────────────────────────────

  async findBySource(sourceMessageTs) {
    if (!sourceMessageTs) return null;
    const r = await this.db.query(
      'SELECT * FROM v3.events WHERE source_message_ts = $1 AND deleted_at IS NULL ORDER BY id LIMIT 1',
      [sourceMessageTs]);
    return r.rows[0] || null;
  }

  /** Exposto p/ o Observer/admin. Sincroniza cowork de forma bidirecional. */
  async syncCoworkLinks(eventId, coworkPersonIds, opts = {}) {
    const actorType = this._actor(opts.actorType);
    return this._withTx(async (c) => {
      await this._syncCowork(c, eventId, coworkPersonIds);
      await this._audit(c, {
        actorType, actorPersonId: opts.actorPersonId, action: 'event.cowork_synced',
        targetId: eventId, metadata: { cowork_with: coworkPersonIds },
      });
      return this._getById(c, eventId);
    });
  }

  // ── edição (§3.13) ─────────────────────────────────────────

  async softDelete(eventId, byPersonId, reason, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, eventId);
      if (!before) throw new Error('softDelete: event ' + eventId + ' não existe');
      const after = await this._patch(c, eventId, { deleted_at: new Date(), deleted_by: byPersonId || null });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'event.deleted',
        targetId: eventId, before, after, metadata: { reason: reason || null },
      });
      return after;
    });
  }

  async restore(eventId, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    return this._withTx(async (c) => {
      const before = await this._getById(c, eventId);
      if (!before) throw new Error('restore: event ' + eventId + ' não existe');
      const after = await this._patch(c, eventId, { deleted_at: null, deleted_by: null });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'event.restored',
        targetId: eventId, before, after,
      });
      return after;
    });
  }

  async correct(eventId, changes = {}, byPersonId, note, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    const fields = {};
    for (const k of Object.keys(changes)) {
      if (!CORRECTABLE.has(k)) throw new Error('correct: campo não-corrigível: ' + k);
      fields[k] = changes[k];
    }
    if (!Object.keys(fields).length) throw new Error('correct: nenhuma mudança válida');
    return this._withTx(async (c) => {
      const before = await this._getById(c, eventId);
      if (!before) throw new Error('correct: event ' + eventId + ' não existe');
      // Bloco 30/mai — admin pode forçar patch em end_of_day (com audit
      // warning); outros guards (dur=0 non-eod) continuam bloqueando.
      const after = await this._patch(c, eventId, fields, { forceEodPatch: true });
      // Bloco 29/mai-noite #3: _patch retorna null se guard bloqueou dur=0 non-eod.
      // Em correct (admin-driven), lança erro claro pra admin saber.
      if (!after) {
        throw new Error('correct: bloqueado pelo guard dur=0 — ended_at == started_at requer slug=end_of_day. Veja audit_log action=event.close_blocked_dur_zero.');
      }
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'event.corrected',
        targetId: eventId, before, after, metadata: { note: note || null, fields: Object.keys(fields) },
      });
      return after;
    });
  }

  async mergeEvents(eventIds = [], byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    if (!Array.isArray(eventIds) || eventIds.length < 2) {
      throw new Error('mergeEvents: precisa de >= 2 event_ids');
    }
    return this._withTx(async (c) => {
      const evs = [];
      for (const id of eventIds) {
        const ev = await this._getById(c, id);
        if (!ev) throw new Error('mergeEvents: event ' + id + ' não existe');
        evs.push(ev);
      }
      // sobrevivente = menor started_at (desempate menor id)
      evs.sort((a, b) => (new Date(a.started_at) - new Date(b.started_at)) || (a.id - b.id));
      const survivor = evs[0];
      const others = evs.slice(1);
      const startedAt = survivor.started_at;
      const anyActive = evs.some((e) => e.ended_at == null);
      const endedAt = anyActive ? null
        : evs.map((e) => e.ended_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];
      const after = await this._patch(c, survivor.id, { started_at: startedAt, ended_at: endedAt });
      for (const o of others) {
        await this._patch(c, o.id, { deleted_at: new Date(), deleted_by: byPersonId || null, closed_reason: 'merged' });
      }
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'event.merged',
        targetId: survivor.id, before: { events: evs }, after,
        metadata: { merged_ids: others.map((o) => o.id), survivor: survivor.id },
      });
      return after;
    });
  }

  async splitEvent(eventId, splitAt, byPersonId, actorTypeRaw = 'admin') {
    const actorType = this._actor(actorTypeRaw);
    if (!splitAt) throw new Error('splitEvent: split_at obrigatório');
    return this._withTx(async (c) => {
      const before = await this._getById(c, eventId);
      if (!before) throw new Error('splitEvent: event ' + eventId + ' não existe');
      const first = await this._patch(c, eventId, { ended_at: splitAt, closed_reason: 'split' });
      // 2ª metade — NÃO copia source_message_ts (UNIQUE; o split é admin-made)
      const second = await this._insert(c, {
        person_id: before.person_id,
        activity_type_id: before.activity_type_id,
        product_batch_id: before.product_batch_id,
        started_at: splitAt,
        ended_at: before.ended_at,
        phase_label: before.phase_label,
        description: before.description,
        source_message_ts: null,
        confidence: before.confidence,
        cowork_with: before.cowork_with,
        closed_reason: before.closed_reason,
      });
      await this._audit(c, {
        actorType, actorPersonId: byPersonId, action: 'event.split',
        targetId: eventId, before, after: { first, second },
        metadata: { split_at: splitAt, new_event_id: second.id },
      });
      return { first, second };
    });
  }
}

module.exports = {
  EventService, VALID_ACTOR_TYPES, CORRECTABLE, isNegativeDuration,
  KIND_META, KIND_BACKGROUND, KIND_FOREGROUND,
};
