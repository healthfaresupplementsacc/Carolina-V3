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
]);

const uniq = (arr) => [...new Set(arr)];

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

  /** UPDATE uniforme de 1 event por id. fields = {col:value}. */
  async _patch(c, id, fields) {
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await c.query(
      `UPDATE v3.events SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => fields[k])]);
    return r.rows[0];
  }

  async _insert(c, p) {
    const cols = ['person_id', 'activity_type_id', 'product_batch_id', 'started_at',
      'ended_at', 'phase_label', 'description', 'source_message_ts', 'confidence',
      'cowork_with', 'closed_reason'];
    const vals = [
      p.person_id, p.activity_type_id || null, p.product_batch_id || null, p.started_at,
      p.ended_at || null, p.phase_label || null, p.description || null,
      p.source_message_ts || null, p.confidence || 'high',
      p.cowork_with || [], p.closed_reason || null];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const r = await c.query(
      `INSERT INTO v3.events (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals);
    return r.rows[0];
  }

  async _categoryOf(c, activityTypeId) {
    if (!activityTypeId) return null; // sem classificação → tratado como trabalho
    const r = await c.query('SELECT category FROM v3.activity_types WHERE id = $1', [activityTypeId]);
    return r.rows[0] ? r.rows[0].category : null;
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

  /** event de trabalho (não-meta) ativo mais recente da pessoa. */
  async _activeWorkEvent(c, personId) {
    const rows = await this._activeByPerson(c, personId);
    for (const ev of rows) {
      if ((await this._categoryOf(c, ev.activity_type_id)) !== 'meta') return ev;
    }
    return null;
  }

  // ── cowork ─────────────────────────────────────────────────

  async _syncCowork(c, eventId, coworkPersonIds) {
    const ev = await this._getById(c, eventId);
    if (!ev) return;
    const group = uniq([ev.person_id, ...(coworkPersonIds || [])]);
    for (const personId of group) {
      let targetId = null;
      if (personId === ev.person_id) {
        targetId = eventId;
      } else {
        const w = await this._activeWorkEvent(c, personId);
        targetId = w ? w.id : null;
      }
      if (targetId) {
        await this._patch(c, targetId, { cowork_with: group.filter((x) => x !== personId) });
      }
    }
  }

  /** Ao fechar um event, remove o dono dele do cowork_with dos coworkers ativos. */
  async _unlinkCoworkOnClose(c, closedEvent) {
    const cw = closedEvent && closedEvent.cowork_with;
    if (!cw || !cw.length) return;
    for (const personId of cw) {
      const w = await this._activeWorkEvent(c, personId);
      if (w && Array.isArray(w.cowork_with) && w.cowork_with.includes(closedEvent.person_id)) {
        await this._patch(c, w.id, { cowork_with: w.cowork_with.filter((x) => x !== closedEvent.person_id) });
      }
    }
  }

  // ── close ──────────────────────────────────────────────────

  /**
   * Fecha o event ativo da pessoa.
   * @param {object} opts  opts.kind 'work'(default) | 'meta' | 'any'
   */
  async closeActivePersonEvent(personId, endedAt, reason, opts = {}) {
    const actorType = this._actor(opts.actorType);
    return this._withTx((c) => this._closeActive(c, personId, endedAt, reason, opts.kind || 'work', actorType, opts.actorPersonId));
  }

  async _closeActive(c, personId, endedAt, reason, kind, actorType, actorPersonId) {
    const rows = await this._activeByPerson(c, personId);
    const closed = [];
    for (const ev of rows) {
      const isMeta = (await this._categoryOf(c, ev.activity_type_id)) === 'meta';
      const matches = kind === 'any' || (kind === 'meta' ? isMeta : !isMeta);
      if (!matches) continue;
      const after = await this._patch(c, ev.id, { ended_at: endedAt, closed_reason: reason });
      await this._unlinkCoworkOnClose(c, ev);
      await this._audit(c, {
        actorType, actorPersonId, action: 'event.closed', targetId: ev.id,
        before: ev, after, metadata: { reason },
      });
      closed.push(after);
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
        });
        await this._audit(c, {
          actorType, actorPersonId: p.actor_person_id, action: 'event.updated',
          targetId: existing.id, before: existing, after,
          metadata: { idempotent: true, source_message_ts: p.source_message_ts },
        });
        if (p.cowork_with && p.cowork_with.length) await this._syncCowork(c, existing.id, p.cowork_with);
        return after;
      }

      // 2 — auto-close do event de trabalho anterior (só p/ event ativo de trabalho)
      if (!p.ended_at) {
        const isMeta = (await this._categoryOf(c, p.activity_type_id)) === 'meta';
        if (!isMeta) {
          await this._closeActive(c, p.person_id, p.started_at, 'next_event', 'work', actorType, p.actor_person_id);
        }
      }

      // 3 — insert
      const ev = await this._insert(c, p);
      await this._audit(c, {
        actorType, actorPersonId: p.actor_person_id, action: 'event.created',
        targetId: ev.id, before: null, after: ev,
      });

      // 4 — cowork sync
      if (p.cowork_with && p.cowork_with.length) await this._syncCowork(c, ev.id, p.cowork_with);
      return ev;
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
      const after = await this._patch(c, eventId, fields);
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

module.exports = { EventService, VALID_ACTOR_TYPES, CORRECTABLE };
