'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.8 — Observer worker (V3 doc §3.2 + §6.5 + §6.6)
 *
 * Amarra o pipeline: pre-filter → PersonResolver → janela operacional
 * → prompt-builder → LLMProvider.classify → validação → persistência
 * (EventService/BatchService/ProductionCountService).
 *
 * SHADOW MODE (Sprint 1): persiste em v3.*, mas NÃO reage com emoji,
 * NÃO posta no canal, NÃO envia DM. A reação é o ÚLTIMO passo do
 * pipeline (pós-persist) e fica gated por this.mode — "no reaction
 * without record" (§6.6) é estrutural mesmo inativo em shadow; o
 * Sprint 2 só precisa virar mode='active'.
 *
 * AJUSTE 3:
 *  - admin_intervention: autor é admin (PersonResolver). Passa pelo
 *    LLM com is_admin_context; nenhum event é criado (defesa dupla:
 *    o prompt instrui actions=[] e o Observer ignora actions).
 *  - admin_broadcast: bot carregando broadcast de admin, detectado
 *    por cross-ref do admin_audit_log LEGADO (Opção A). Persiste como
 *    contexto, sem event.
 *
 * Princípio #24: queries v3.* schema-qualificadas.
 */
const { classifyForFilter, skippedResult, contextResult } = require('./pre-filter');

/** Data ET (YYYY-MM-DD) de um Date. */
function etDate(date) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return f.format(date); // en-CA → YYYY-MM-DD
}

/** Hora (0-23) e dia-da-semana (0=dom) ET de um Date. */
function etHourWeekday(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', weekday: 'short',
  });
  const parts = f.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = wdMap[parts.find((p) => p.type === 'weekday').value];
  return { hour, weekday };
}

class Observer {
  constructor(deps = {}) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.personResolver = deps.personResolver;
    this.promptBuilder = deps.promptBuilder;
    this.eventService = deps.eventService;
    this.batchService = deps.batchService;
    this.countService = deps.productionCountService;
    this.slack = deps.slack || null;
    this.botUserId = deps.botUserId || null;
    this.mode = deps.mode || 'shadow';
    this.now = deps.now || (() => new Date());
    // FIX C: concorrência reduzida p/ 2 durante backfill (env), 3 em
    // tempo-real — deixa headroom de rate-limit pra Carolina legada.
    this.concurrency = deps.concurrency
      || (process.env.V3_OBSERVER_CONCURRENCY ? parseInt(process.env.V3_OBSERVER_CONCURRENCY, 10) : 3);
    this._timer = null;
  }

  // ── pipeline ───────────────────────────────────────────────

  async processMessage(message) {
    try {
      return await this._process(message);
    } catch (e) {
      await this._markError(message, 'unexpected: ' + e.message);
      return { ok: false, stage: 'unexpected', error: e.message, retryable: true };
    }
  }

  async _process(message) {
    // 1 ── PRE-FILTER ──────────────────────────────────────────
    const fromBot = this.botUserId && message.slack_user_id === this.botUserId;
    const isBroadcast = fromBot ? await this._isAdminBroadcast(message.slack_ts) : false;
    const recentUserMessages = await this._recentUserMessages(message);
    const pf = classifyForFilter(
      { text: message.raw_text, ts: message.slack_ts, slack_user_id: message.slack_user_id },
      { botUserId: this.botUserId, recentUserMessages, isAdminBroadcast: isBroadcast });

    if (pf.category === 'bot_self') {
      await this._finalizeSkipped(message, skippedResult('bot_self', pf.detail));
      return { ok: true, category: 'bot_self', events: [] };
    }
    if (pf.category === 'admin_broadcast') {
      // contexto pras próximas mensagens; sem event.
      await this._finalizeSkipped(message, contextResult('admin_broadcast'));
      return { ok: true, category: 'admin_broadcast', events: [] };
    }
    if (pf.category === 'small_talk') {
      await this._finalizeSkipped(message, skippedResult('small_talk', pf.detail));
      return { ok: true, category: 'small_talk', events: [] };
    }
    // burst_member → coalesce as N mensagens num texto só
    const text = pf.category === 'burst_member'
      ? pf.batch.map((m) => m.text).join('\n')
      : message.raw_text;
    const coalesced = pf.category === 'burst_member' ? pf.batch.length : 1;
    // outras mensagens do burst (com id, exceto a atual) — marcadas
    // como coalescidas no fim, p/ não re-processarem.
    const coalescedIds = pf.category === 'burst_member'
      ? pf.batch.filter((m) => m.id != null && m.id !== message.id).map((m) => m.id)
      : [];

    // 2 ── PERSON RESOLVER ─────────────────────────────────────
    const author = await this.personResolver.resolve(
      message.slack_user_id, text, message.slack_ts, { message_id: message.id });

    // 3 ── JANELA OPERACIONAL ──────────────────────────────────
    const isOffHours = !(await this._withinWindow());

    // 4 ── PROMPT BUILDER ──────────────────────────────────────
    const ctx = await this.promptBuilder.buildContext(
      {
        text, ts: message.slack_ts, slack_user_id: message.slack_user_id,
        channel_id: message.slack_channel_id,
      },
      { author });

    // 5 ── LLM CLASSIFY ────────────────────────────────────────
    let decision;
    try {
      decision = await this.provider.classify(
        { text, ts: message.slack_ts, slack_user_id: message.slack_user_id }, ctx);
    } catch (e) {
      await this._markError(message, 'llm_error: ' + e.message);
      return { ok: false, stage: 'llm', error: e.message, retryable: true };
    }

    // 6 ── VALIDAÇÃO ───────────────────────────────────────────
    const invalid = await this._validate(decision);
    if (invalid) {
      await this._markError(message, 'invalid_llm_response: ' + invalid);
      return { ok: false, stage: 'validation', error: invalid, retryable: true };
    }

    // 7 ── PERSISTÊNCIA (SHADOW) ───────────────────────────────
    const created = [];
    const updated = [];
    const adminCtx = !!(author && author.is_admin_context);
    if (!adminCtx) {
      for (const action of (decision.actions || [])) {
        const r = await this._applyAction(action, message);
        if (r.created) created.push(...r.created);
        if (r.updated) updated.push(...r.updated);
      }
    }
    await this._upsertVocabulary(decision.new_vocabulary_terms);

    // 8 ── REAÇÃO — ÚLTIMO passo, pós-persist (§6.6). SHADOW: skip.
    if (this.mode !== 'shadow' && this.slack && decision.react_emoji) {
      await this.slack.addReaction(message.slack_ts, decision.react_emoji);
    }
    // SHADOW: zero reaction, zero post, zero DM.

    // 9 ── FINALIZA ────────────────────────────────────────────
    await this._finalize(message, decision, created, updated, { isOffHours, adminCtx, coalesced });
    if (coalescedIds.length) await this._markCoalesced(coalescedIds, message.id);
    return {
      ok: true, category: decision.categorization, confidence: decision.confidence,
      events: created, updated, is_off_hours: isOffHours, admin_context: adminCtx,
    };
  }

  // ── persistência de uma action ─────────────────────────────

  async _applyAction(action, message) {
    if (!action || !action.person_id) return {};
    const t = action.type;
    if (t === 'open_event' || t === 'break_start' || t === 'cowork_join') {
      let batchId = null;
      if (action.product_id && action.batch_number) {
        const batch = await this.batchService.findOrCreateActive(
          action.product_id, action.batch_number,
          action.started_at || message.created_at || this.now(), { actorType: 'llm_observer' });
        batchId = batch.id;
      }
      const ev = await this.eventService.upsert({
        person_id: action.person_id,
        activity_type_id: action.activity_type_id || null,
        product_batch_id: batchId,
        started_at: action.started_at || message.created_at || this.now(),
        phase_label: action.phase_label || null,
        description: action.description || null,
        source_message_ts: message.slack_ts,
        confidence: action.confidence || 'high',
        cowork_with: action.cowork_with || [],
        actor_type: 'llm_observer',
      });
      return { created: [ev.id] };
    }
    if (t === 'close_event' || t === 'break_end' || t === 'cowork_leave') {
      const reason = t === 'cowork_leave' ? 'cowork_pause' : 'manual';
      const closed = await this.eventService.closeActivePersonEvent(
        action.person_id, action.ended_at || message.created_at || this.now(), reason,
        { kind: t === 'break_end' ? 'meta' : 'work', actorType: 'llm_observer' });
      return { updated: (closed || []).map((e) => e.id) };
    }
    if (t === 'eod_count' || t === 'partial_count') {
      if (!action.product_id || action.bottles == null) return {};
      let batchId = null;
      if (action.product_id && action.batch_number) {
        const batch = await this.batchService.findOrCreateActive(
          action.product_id, action.batch_number,
          message.created_at || this.now(), { actorType: 'llm_observer' });
        batchId = batch.id;
      }
      await this.countService.record({
        product_id: action.product_id,
        product_batch_id: batchId,
        bottles: action.bottles,
        reported_at: message.created_at || this.now(),
        production_date: etDate(new Date(message.created_at || this.now())),
        reported_by_person_id: action.person_id,
        // chave composta: 1 contagem por (mensagem, produto) — idempotente
        // mesmo com vários eod_count na mesma mensagem.
        source_message_ts: message.slack_ts + '#p' + action.product_id,
        confidence: action.confidence || 'high',
        notes: t === 'partial_count' ? 'partial reported during shift' : null,
        actor_type: 'llm_observer',
      });
      return {};
    }
    // note / narrative → sem persistência (só contexto)
    return {};
  }

  // ── validação da resposta do LLM ───────────────────────────

  async _validate(decision) {
    if (!decision || !Array.isArray(decision.actions)) return 'actions ausente/inválido';
    if (decision.actions.length === 0) return null; // ex.: admin_intervention, note
    const [persons, products, ats] = await Promise.all([
      this.db.query('SELECT id FROM v3.persons WHERE deleted_at IS NULL'),
      this.db.query('SELECT id FROM v3.products'),
      this.db.query('SELECT id FROM v3.activity_types'),
    ]);
    const pSet = new Set(persons.rows.map((r) => r.id));
    const prodSet = new Set(products.rows.map((r) => r.id));
    const atSet = new Set(ats.rows.map((r) => r.id));
    for (const a of decision.actions) {
      if (a.person_id != null && !pSet.has(a.person_id)) return `person_id ${a.person_id} inexistente`;
      if (a.activity_type_id != null && !atSet.has(a.activity_type_id)) return `activity_type_id ${a.activity_type_id} inexistente`;
      if (a.product_id != null && !prodSet.has(a.product_id)) return `product_id ${a.product_id} inexistente`;
    }
    return null;
  }

  // ── helpers de contexto ────────────────────────────────────

  /** Cross-ref do admin_audit_log LEGADO p/ detectar broadcast de admin.
   * TODO Sprint 2: remover esta dependência do legado quando o V3 for
   * dono do path de broadcast (ver docs/v3-sprint2-roadmap.md). */
  async _isAdminBroadcast(slackTs) {
    try {
      const r = await this.db.query(
        "SELECT 1 FROM public.admin_audit_log WHERE action = 'broadcast' AND entity_id = $1 LIMIT 1",
        [String(slackTs)]);
      return r.rows.length > 0;
    } catch (_) {
      return false; // legado indisponível → trata como notificação automática
    }
  }

  async _recentUserMessages(message) {
    const r = await this.db.query(
      `SELECT id, slack_ts AS ts, slack_user_id, raw_text AS text FROM v3.messages
       WHERE slack_user_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'
       ORDER BY created_at DESC LIMIT 20`, [message.slack_user_id]);
    return r.rows;
  }

  /** Marca as outras mensagens de um burst como coalescidas (não re-processam). */
  async _markCoalesced(ids, intoMessageId) {
    await this.db.query(
      `UPDATE v3.messages
         SET llm_processed_at = NOW(), llm_result = $2::jsonb, llm_provider_used = 'pre-filter'
       WHERE id = ANY($1) AND llm_processed_at IS NULL`,
      [ids, JSON.stringify({ skipped: 'burst_coalesced', coalesced_into: intoMessageId })]);
  }

  async _withinWindow() {
    let win = { start_hour: 8, end_hour: 19, weekdays: [1, 2, 3, 4, 5] };
    try {
      const r = await this.db.query("SELECT value FROM v3.settings WHERE key = 'operational_window'");
      if (r.rows[0]) {
        const v = typeof r.rows[0].value === 'string' ? JSON.parse(r.rows[0].value) : r.rows[0].value;
        win = Object.assign(win, v);
      }
    } catch (_) { /* usa default */ }
    const { hour, weekday } = etHourWeekday(this.now());
    return win.weekdays.includes(weekday) && hour >= win.start_hour && hour < win.end_hour;
  }

  async _upsertVocabulary(terms) {
    if (!Array.isArray(terms)) return;
    for (const term of terms) {
      if (!term || !String(term).trim()) continue;
      try {
        await this.db.query(
          `INSERT INTO v3.vocabulary (term, first_seen_at, occurrence_count)
           VALUES ($1, NOW(), 1)
           ON CONFLICT (term) DO UPDATE
             SET occurrence_count = v3.vocabulary.occurrence_count + 1`,
          [String(term).trim()]);
      } catch (_) { /* não bloqueia o pipeline */ }
    }
  }

  // ── finalização / erro ─────────────────────────────────────

  async _finalize(message, decision, created, updated, flags) {
    const result = {
      interpretation: decision.interpretation,
      categorization: decision.categorization,
      confidence_overall: decision.confidence,
      actions: decision.actions,
      cost_estimate_usd: decision.cost_estimate_usd || 0,
      model_used: decision.model_used || null,
      is_off_hours: flags.isOffHours,
      admin_context: flags.adminCtx,
      coalesced_messages: flags.coalesced,
    };
    await this.db.query(
      `UPDATE v3.messages
         SET llm_processed_at = NOW(), llm_result = $2::jsonb, llm_provider_used = $3,
             events_created = $4, events_updated = $5, processing_error = NULL
       WHERE id = $1`,
      [message.id, JSON.stringify(result), decision.provider_used || 'anthropic', created, updated]);
    await this._audit('observer.processed', message.id, {
      events_created: created, events_updated: updated, categorization: decision.categorization,
    });
  }

  async _finalizeSkipped(message, llmResult) {
    await this.db.query(
      `UPDATE v3.messages
         SET llm_processed_at = NOW(), llm_result = $2::jsonb, llm_provider_used = 'pre-filter'
       WHERE id = $1`,
      [message.id, JSON.stringify(llmResult)]);
    await this._audit('observer.skipped', message.id, llmResult);
  }

  async _markError(message, error) {
    // llm_processed_at fica NULL → o worker re-tenta.
    await this.db.query(
      'UPDATE v3.messages SET processing_error = $2 WHERE id = $1',
      [message.id, String(error).slice(0, 500)]);
  }

  async _audit(action, messageId, after) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, after_data)
         VALUES ('llm_observer', $1, 'message', $2, $3::jsonb)`,
        [action, messageId, JSON.stringify(after || {})]);
    } catch (_) { /* audit nunca bloqueia o pipeline */ }
  }

  // ── worker loop ────────────────────────────────────────────

  /** Heartbeat — grava observer_last_tick_at a cada tick. Assim o
   * /health sabe que o worker está vivo MESMO sem mensagens novas
   * (madrugada / fim de semana não parecem "worker morto"). */
  async _heartbeat() {
    try {
      await this.db.query(
        `INSERT INTO v3.settings (key, value)
         VALUES ('observer_last_tick_at', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(this.now().toISOString())]);
    } catch (_) { /* heartbeat nunca derruba o tick */ }
  }

  /**
   * Uma passada. FIX A — claim no DB contra dupla-processamento:
   * o UPDATE...RETURNING marca claimed_at=NOW() atomicamente, então
   * só processamos as rows que ESTE tick reivindicou. Ticks
   * sobrepostos (LLM lento >5s) nunca pegam a mesma mensagem.
   *
   * Elegível pro claim: llm_processed_at IS NULL E (nunca reivindicada
   * OU claim expirado há >2min — re-claim após crash do worker).
   * FOR UPDATE SKIP LOCKED no sub-select evita corrida entre ticks.
   */
  async tick() {
    await this._heartbeat();
    const claimed = (await this.db.query(
      `UPDATE v3.messages SET claimed_at = NOW()
       WHERE id IN (
         SELECT id FROM v3.messages
         WHERE llm_processed_at IS NULL
           AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '2 minutes')
         ORDER BY created_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`)).rows;
    const results = [];
    for (let i = 0; i < claimed.length; i += this.concurrency) {
      const chunk = claimed.slice(i, i + this.concurrency);
      results.push(...await Promise.all(chunk.map((m) => this.processMessage(m))));
    }
    return results;
  }

  start(intervalMs = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Observer, etDate, etHourWeekday };
