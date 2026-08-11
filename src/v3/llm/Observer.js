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
    this.goalService = deps.goalService || null; // Bloco 2 — metas
    this.slack = deps.slack || null;
    this.botUserId = deps.botUserId || null;
    this.mode = deps.mode || 'shadow';
    this.now = deps.now || (() => new Date());
    // Bloco 29/mai-noite #3 — alertas Slack pra falhas persistentes do
    // worker (billing/rate-limit). Bypassa mode=shadow porque é admin,
    // não auto-resposta operacional.
    this.enableWorkerAlerts = deps.enableWorkerAlerts === true;
    // REVIEW MODE (Bruno 06-22): posta um resumo no canal ADMIN quando interpreta
    // algo do Slack (criou/atualizou), pra revisar ANTES de liberar no grupo normal.
    this.reviewToAdmin = deps.reviewToAdmin === true;
    this.alertAdminChannelId = deps.alertAdminChannelId || 'C0B36DR5MP1';
    this.alertBrunoCampDmId = deps.alertBrunoCampDmId || 'D03UL80GDRB';
    this.alertCooldownMs = deps.alertCooldownMs || (60 * 60 * 1000);   // 1h
    // Bloco 30/mai-noite — comandos do admin via @Carolina mention.
    this.commandHandler = deps.commandHandler || null;
    // FIX C: concorrência reduzida p/ 2 durante backfill (env), 3 em
    // tempo-real — deixa headroom de rate-limit pra Carolina legada.
    this.concurrency = deps.concurrency
      || (process.env.V3_OBSERVER_CONCURRENCY ? parseInt(process.env.V3_OBSERVER_CONCURRENCY, 10) : 3);
    this._timer = null;
    this._ticking = false; // guard — ticks não se sobrepõem
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

    // 1.5 ── ADMIN COMMAND ROUTING (bloco 30/mai-noite).
    // Msg de admin com @Carolina/@HealthFare Tracker no canal de produção
    // vai pro CommandHandler em vez da pipeline LLM normal. Não cria
    // event de produção (admin não opera linha). Inclui mentions sem admin
    // role (rejected silenciosamente, com audit).
    if (this.commandHandler) {
      const cmd = await this.commandHandler.tryRoute(message);
      if (cmd.matched) {
        await this._finalizeSkipped(message, skippedResult('admin_command',
          JSON.stringify({ handled: cmd.handled, result: cmd.result, reason: cmd.reason || null })));
        return { ok: true, category: 'admin_command', events: [], commandResult: cmd };
      }
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

    // 5.5 ── TELEMETRIA LLM (bloco 1/jun Fase 1).
    // Grava input/output/cache/cost por chamada em v3.llm_metrics pra
    // medir economia de prompt caching. Best-effort (não derruba pipeline).
    await this._recordLlmMetric(message, decision, 'observer');

    // 6 ── VALIDAÇÃO ───────────────────────────────────────────
    const invalid = await this._validate(decision);
    if (invalid) {
      await this._markError(message, 'invalid_llm_response: ' + invalid);
      return { ok: false, stage: 'validation', error: invalid, retryable: true };
    }

    // 6.5 ── GUARD slack_ts override (bloco 29/mai-noite #7).
    // Quando o LLM emite action.started_at/ended_at que diverge > 5min
    // do slack_ts da msg, sobrescreve com slack_ts e loga warning.
    // EXCEÇÃO: msg de admin (adminCtx, categorization='admin_intervention',
    // ou slack U0B3EQLPEPL — Bruno Camp via @Carolina) preserva o
    // horário do LLM porque admin pode estar especificando retroativamente.
    {
      const carolinaAdminId = process.env.CAROLINA_ADMIN_USER_ID || 'U0B3EQLPEPL';
      const adminLikeForTs = !!(author && author.is_admin_context)
        || decision.categorization === 'admin_intervention'
        || message.slack_user_id === carolinaAdminId;
      if (!adminLikeForTs) {
        await this._enforceSlackTsOnActions(decision.actions || [], message);
      }
    }

    // 7 ── PERSISTÊNCIA (SHADOW) ───────────────────────────────
    const created = [];
    const updated = [];
    const adminCtx = !!(author && author.is_admin_context);

    // Bug-raiz "uma msg, N events": Se a decisão tem 2+ actions que
    // criam event (open_event/break_start/cowork_join), TODOS teriam
    // o mesmo source_message_ts → o EventService.upsert achava o 1º
    // já inserido e fazia UPDATE em vez de INSERT do 2º (sobrescrevia).
    // Conserto: sufixar com '#a<i>' quando há múltiplos open-style.
    // Quando há só 1, mantém o ts puro (retrocompat com mensagens já
    // processadas — re-processo continua idempotente).
    const OPENS = new Set(['open_event', 'break_start', 'cowork_join']);
    const openTotal = (decision.actions || []).filter((a) => a && OPENS.has(a.type)).length;
    let openIdx = 0;
    for (const action of (decision.actions || [])) {
      // set_goal vale SEMPRE (admin DEFINE meta — Bloco 2). As demais
      // actions (events de trabalho) só fora de admin_context.
      if (adminCtx && (!action || action.type !== 'set_goal')) continue;
      if (action && OPENS.has(action.type) && openTotal > 1) {
        action._sourceSuffix = '#a' + openIdx;
        openIdx += 1;
      }
      const r = await this._applyAction(action, message);
      if (r.created) created.push(...r.created);
      if (r.updated) updated.push(...r.updated);
    }
    await this._upsertVocabulary(decision.new_vocabulary_terms);

    // 7.5 ── GUARD msg.no_event_created (bloco 29/mai-noite auditoria #36).
    // Quando msg tem prefixo S:/F:/S-/F- explícito MAS nenhum event foi
    // criado nem atualizado, loga warning audit pra admin investigar.
    // Sem isso, falha do classifier passa silenciosa (caso real Akkermansia
    // manual da Simone msgs676/678 — LLM viu mas não emitiu actions).
    if (!adminCtx && created.length === 0 && updated.length === 0) {
      const raw = String(message.raw_text || '').trim();
      const sfMatch = raw.match(/^([SsFf])\s*[:\-;]\s*/);
      if (sfMatch) {
        try {
          await this.db.query(
            `INSERT INTO v3.audit_log
               (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
             VALUES ('system', NULL, 'msg.no_event_created', 'message', $1, NULL, NULL, $2::jsonb)`,
            [message.id, JSON.stringify({
              guard: 'msg com prefixo S:/F: mas zero events criados/atualizados',
              prefix: sfMatch[1].toUpperCase(),
              slack_user_id: message.slack_user_id,
              slack_ts: message.slack_ts,
              raw_preview: raw.slice(0, 200),
              llm_category: decision.categorization || null,
              llm_actions_count: (decision.actions || []).length,
            })]);
        } catch (e) {
          // não bloqueia o fluxo principal
          console.error('[Observer] falha ao registrar msg.no_event_created:', e.message);
        }
      }
    }

    // 8 ── REAÇÃO — ÚLTIMO passo, pós-persist (§6.6). SHADOW: skip.
    if (this.mode !== 'shadow' && this.slack && decision.react_emoji) {
      await this.slack.addReaction(message.slack_ts, decision.react_emoji);
    }
    // SHADOW: zero reaction, zero post, zero DM.
    // REVIEW MODE: resumo pro ADMIN do que interpretou (sem tocar no grupo normal).
    if (this.reviewToAdmin && this.slack && this.slack.postAs && (created.length || updated.length || (decision.actions && decision.actions.length))) {
      try {
        await this.slack.postAs({
          channel: this.alertAdminChannelId, sender: { name: 'Carolina (revisão)' }, thread_ts: null,
          unfurl_links: false, unfurl_media: false,
          text: `:eyes: *Revisão* — interpretei do Slack:\n_"${(message.raw_text || '').slice(0, 160)}"_\n→ ${decision.interpretation || '(sem interpretação)'}\n`
            + (created.length ? `• criou ${created.length} event(s)\n` : '')
            + (updated.length ? `• atualizou ${updated.length} event(s)\n` : '')
            + `confiança: ${decision.confidence || '?'} · categoria: ${decision.categorization || '?'}`,
        });
      } catch (e) { console.error('[Observer] review post falhou:', e.message); }
    }

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
    if (!action) return {};
    const t = action.type;
    // set_goal — meta (esperado). NÃO exige person_id (a meta tem
    // created_by opcional). É a única action que vale de mensagem admin.
    if (t === 'set_goal') {
      if (!this.goalService || action.expected_quantity == null) return {};
      await this.goalService.record({
        product_id: action.product_id || null,
        batch_number: action.batch_number || null,
        expected_quantity: action.expected_quantity,
        unit: action.unit || 'bottle',
        destinations: action.destinations || null,
        production_date: etDate(new Date(message.created_at || this.now())),
        source: 'channel',
        source_message_ts: message.slack_ts,
        created_by_person_id: action.person_id || null,
        confidence: action.confidence || 'high',
        actor_type: 'llm_observer',
      });
      return {};
    }
    if (!action.person_id) return {};
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
        // sufixo '#a<i>' aplicado pelo loop em _process quando há N>1
        // actions open-style na mesma msg, pra cada um virar event distinto
        // sem colidir na idempotência por source_message_ts.
        source_message_ts: action._sourceSuffix
          ? message.slack_ts + action._sourceSuffix
          : message.slack_ts,
        confidence: action.confidence || 'high',
        cowork_with: action.cowork_with || [],
        // Captura Aprimorada A2 — P&P "142 ordens" / quantidades em events.
        quantity: action.quantity != null ? action.quantity : null,
        quantity_unit: action.quantity_unit || null,
        actor_type: 'llm_observer',
      });
      // Bloco 29/mai-noite #3: upsert pode retornar null quando o insert
      // guard bloqueia dur=0 non-eod (caso ev316/317 — 2 open_event com
      // mesmo started_at). Audit do bloqueio já foi gravado; só pula essa
      // action.
      if (!ev) return { created: [] };
      return { created: [ev.id] };
    }
    if (t === 'close_event' || t === 'break_end' || t === 'cowork_leave') {
      const reason = t === 'cowork_leave' ? 'cowork_pause' : 'manual';
      // Captura Aprimorada A1 + bug-fix 25/mai: quando a action tem
      // activity_type_id, o filtro forte é POR ATIVIDADE — kind=any (caso
      // contrário, "F: encapsulação" não fecha porque encapsulação é
      // background e o default kind=foreground filtrava ela fora).
      let kind;
      if (action.activity_type_id) {
        kind = 'any';
      } else if (t === 'break_end') {
        kind = 'meta';
      } else {
        kind = 'foreground';
      }
      const closeTime = action.ended_at || message.created_at || this.now();
      const closed = await this.eventService.closeActivePersonEvent(
        action.person_id, closeTime, reason,
        {
          kind,
          activityTypeId: action.activity_type_id || null,
          actorType: 'llm_observer',
        });
      // E7-cérebro #3 — F ÓRFÃO: close_event sem match.
      // Antes: closed=[] silenciosamente sumia. Agora marca a msg como
      // precisa-atenção via processing_error (sem matar a captura — o ev
      // não é criado fantasma; a próxima vez que a Carolina abrir o caso
      // incerto, vê a flag e o admin decide).
      if (t === 'close_event' && (!closed || closed.length === 0)) {
        await this.db.query(
          `UPDATE v3.messages SET processing_error = COALESCE(processing_error, $2)
           WHERE id = $1 AND processing_error IS NULL`,
          [message.id, 'orphan_close: F sem foreground/background aberto pra fechar']);
      }
      return { updated: (closed || []).map((e) => e.id), orphan: closed.length === 0 && t === 'close_event' };
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
        unit: action.unit || 'bottle',
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

  // Sets de ids válidos com cache curto (30s). ANTES: 3 SELECT full-table por
  // mensagem com ações, no path de 5s → caro em pico. Agora escaneia no máx.
  // 1×/30s; num MISS (pessoa/produto recém-criado DEPOIS do cache) confirma com
  // 1 query pontual antes de rejeitar → zero falso-negativo. (perf 07-28)
  async _idSets() {
    const now = Date.now();
    if (this.__idSets && (now - this.__idSets.at) < 30000) return this.__idSets;
    const [persons, products, ats] = await Promise.all([
      this.db.query('SELECT id FROM v3.persons WHERE deleted_at IS NULL'),
      this.db.query('SELECT id FROM v3.products'),
      this.db.query('SELECT id FROM v3.activity_types'),
    ]);
    this.__idSets = {
      at: now,
      persons: new Set(persons.rows.map((r) => r.id)),
      products: new Set(products.rows.map((r) => r.id)),
      ats: new Set(ats.rows.map((r) => r.id)),
    };
    return this.__idSets;
  }

  async _validate(decision) {
    if (!decision || !Array.isArray(decision.actions)) return 'actions ausente/inválido';
    if (decision.actions.length === 0) return null; // ex.: admin_intervention, note
    const sets = await this._idSets();
    const exists = async (kind, tbl, id) => {
      if (sets[kind].has(id)) return true; // fast path (cache quente)
      try { const r = await this.db.query(`SELECT 1 FROM v3.${tbl} WHERE id = $1 LIMIT 1`, [id]); return r.rows.length > 0; } catch { return false; }
    };
    for (const a of decision.actions) {
      if (a.person_id != null && !(await exists('persons', 'persons', a.person_id))) return `person_id ${a.person_id} inexistente`;
      if (a.activity_type_id != null && !(await exists('ats', 'activity_types', a.activity_type_id))) return `activity_type_id ${a.activity_type_id} inexistente`;
      if (a.product_id != null && !(await exists('products', 'products', a.product_id))) return `product_id ${a.product_id} inexistente`;
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
      // Ciclo de aprendizado — tijolo base (Bloco 5): o LLM pode marcar
      // "não tive certeza dessa decisão" + por quê. Persiste no
      // llm_result; a tela de casos incertos lista isso pro admin
      // revisar (e no futuro a Carolina pergunta).
      uncertain: decision.uncertain === true,
      uncertainty_reason: decision.uncertainty_reason || null,
    };
    await this.db.query(
      `UPDATE v3.messages
         SET llm_processed_at = NOW(), llm_result = $2::jsonb, llm_provider_used = $3,
             events_created = $4, events_updated = $5, processing_error = NULL,
             last_error = NULL
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

  /** Bloco 1/jun Fase 1 — grava métricas de LLM call em v3.llm_metrics.
   *  Best-effort (nunca derruba pipeline). decision deve ter tokens_in/out,
   *  cache_creation_input_tokens, cache_read_input_tokens, cost_estimate_usd,
   *  model_used, processing_ms (todos providos pelo AnthropicProvider). */
  async _recordLlmMetric(message, decision, caller) {
    if (!decision) return;
    try {
      await this.db.query(
        `INSERT INTO v3.llm_metrics
           (message_id, caller, model, provider, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens,
            cost_estimate_usd, processing_ms, cache_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          message && message.id ? message.id : null,
          caller || 'observer',
          decision.model_used || 'unknown',
          decision.provider_used || 'anthropic',
          decision.tokens_in || 0,
          decision.tokens_out || 0,
          decision.cache_creation_input_tokens || 0,
          decision.cache_read_input_tokens || 0,
          decision.cost_estimate_usd || 0,
          decision.processing_ms || 0,
          !!decision.cache_enabled,
        ]);
    } catch (e) {
      // Tabela pode não existir ainda (deploy parcial). Log e segue.
      console.error('[Observer] _recordLlmMetric falhou:', e.message);
    }
  }

  /** Bloco 29/mai-noite #7 — força action.started_at/ended_at = slack_ts
   *  quando LLM diverge > 5min do horário real da msg. Defesa contra
   *  hallucinations de tempo (caso 29/mai reprocesso: msg724 17:27 virou
   *  ev335 started 18:47 = +80min de hallucination LLM).
   *  Loga warning em audit_log action='action.timestamp_overridden' com
   *  Δ original pra admin auditar.
   *  Caller deve checar se msg é de admin/Carolina ANTES de chamar — esses
   *  podem especificar timestamps retroativos legitimamente. */
  async _enforceSlackTsOnActions(actions, message) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    const slackTsMs = parseFloat(message.slack_ts) * 1000;
    if (!Number.isFinite(slackTsMs)) return;
    const msgIso = new Date(slackTsMs).toISOString();
    const TOLERANCE_MS = 5 * 60 * 1000;
    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;
      for (const field of ['started_at', 'ended_at']) {
        if (!action[field]) continue;
        const actionMs = new Date(action[field]).getTime();
        if (!Number.isFinite(actionMs)) continue;
        const deltaMs = actionMs - slackTsMs;
        if (Math.abs(deltaMs) <= TOLERANCE_MS) continue;
        const originalTs = action[field];
        action[field] = msgIso;
        try {
          await this.db.query(
            `INSERT INTO v3.audit_log
               (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
             VALUES ('system', NULL, 'action.timestamp_overridden', 'message', $1, NULL, NULL, $2::jsonb)`,
            [message.id, JSON.stringify({
              guard: 'LLM action timestamp diverged > 5min from slack_ts',
              field,
              original_ts: originalTs,
              override_ts: msgIso,
              delta_min: Math.round(deltaMs / 60000),
              slack_ts: message.slack_ts,
              action_type: action.type,
            })]);
        } catch (e) {
          console.error('[Observer] falha ao audit timestamp_overridden:', e.message);
        }
      }
    }
  }

  async _markError(message, error) {
    const errStr = String(error);
    // COTA ESGOTADA EM TODA A CORRENTE (QuotaChain, Bruno 07-03): NÃO é falha da
    // mensagem — é o dia que acabou. Desfaz a tentativa (o claim incrementou) e
    // deixa a msg quieta na fila; depois do reset (3AM ET) ela processa sozinha.
    // Sem isso, o retry martelava 429 e a msg morria em dead-letter injustamente.
    if (/llm_quota_exhausted_all/.test(errStr)) {
      await this.db.query(
        `UPDATE v3.messages SET processing_attempts = GREATEST(0, processing_attempts - 1),
                processing_error = $2, last_error = $2, last_attempt_at = NOW()
         WHERE id = $1`,
        [message.id, 'llm_quota_exhausted_all — aguardando reset de cota (não conta tentativa)']);
      return;
    }
    // llm_processed_at fica NULL → o worker re-tenta (até o limite abaixo).
    await this.db.query(
      'UPDATE v3.messages SET processing_error = $2, last_error = $2, last_attempt_at = NOW() WHERE id = $1',
      [message.id, errStr.slice(0, 500)]);
    // Bloco 29/mai-noite #3 — alerta admin pra falhas persistentes.
    const kind = this._classifyWorkerError(errStr);
    if (kind) await this._maybeSendBillingAlert(kind, errStr);
    // Fase A — DEAD-LETTER: 3+ tentativas falhas → sai da fila pra sempre.
    // (processing_attempts foi incrementado no claim; message veio do RETURNING.)
    const attempts = Number(message.processing_attempts || 0);
    if (attempts >= 3) await this._deadLetter(message, errStr, attempts);
  }

  /** Fase A — marca dead-letter + audit + notification + aviso Carolina. */
  async _deadLetter(message, errStr, attempts) {
    try {
      const upd = await this.db.query(
        `UPDATE v3.messages SET dead_lettered_at = NOW()
         WHERE id = $1 AND dead_lettered_at IS NULL RETURNING id`, [message.id]);
      if (upd.rowCount === 0) return; // já dead-lettered (corrida)
      await this.db.query(
        `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('llm_observer', NULL, 'message_dead_lettered', 'message', $1, $2::jsonb)`,
        [message.id, JSON.stringify({ slack_ts: message.slack_ts, attempts, error: errStr.slice(0, 200) })]);
      await this.db.query(
        `INSERT INTO v3.notifications (type, payload, status)
         VALUES ('dead_letter', $1::jsonb, 'pending')`,
        [JSON.stringify({
          message_id: message.id, slack_ts: message.slack_ts,
          text: (message.raw_text || '').slice(0, 100),
          error: errStr.slice(0, 200), attempts,
        })]);
      // só posta o aviso no Slack se os worker-alerts estiverem ligados (respeita
      // WORKER_ALERTS_DISABLED e o kill-switch Carolina). O REGISTRO (notification +
      // audit) continua sempre — só o spam da Carolina some. (Bruno 06-22)
      if (this.enableWorkerAlerts && this.slack && this.slack.postAs) {
        try {
          await this.slack.postAs({
            channel: this.alertAdminChannelId, sender: { name: 'Carolina' }, thread_ts: null,
            text: `⚠️ Mensagem entrou em *dead-letter* após ${attempts} tentativas.\n`
              + `ts: ${message.slack_ts}\n`
              + `texto: ${(message.raw_text || '').slice(0, 100)}\n`
              + `último erro: ${errStr.slice(0, 200)}`,
          });
        } catch (e) { console.error('[Observer] aviso dead-letter falhou:', e.message); }
      }
      console.error(`[Observer] msg#${message.id} DEAD-LETTERED após ${attempts} tentativas: ${errStr.slice(0, 120)}`);
    } catch (e) {
      console.error('[Observer] _deadLetter falhou:', e.message);
    }
  }

  /** Bloco 29/mai-noite #3 — classifica erros do worker pra triggear alerta.
   *  'credit_balance' → conta sem crédito (gravíssimo, sistema parado).
   *  'rate_limit'     → 429/529 transitório (alerta se persistir).
   *  null             → erro normal (validation, parse, etc — sem alerta). */
  _classifyWorkerError(errStr) {
    if (!errStr) return null;
    if (/credit_balance.*too low|invalid_request_error.*credit/i.test(errStr)) return 'credit_balance';
    if (/\b(429|529)\b|rate.?limit|overloaded/i.test(errStr)) return 'rate_limit';
    return null;
  }

  /** Bloco 29/mai-noite #3 — envia alerta pra DM Bruno Camp + canal admin
   *  quando worker bate em billing/rate-limit. Cooldown 1h pra não spammar.
   *  Bypassa mode=shadow porque é alerta de incidente admin, não auto-post. */
  async _maybeSendBillingAlert(kind, errStr) {
    if (!this.enableWorkerAlerts) return;
    try {
      // Cooldown — checa último alerta do mesmo kind em settings
      const key = `worker_last_alert_${kind}`;
      const r = await this.db.query("SELECT value FROM v3.settings WHERE key = $1", [key]);
      let last = r.rows[0]?.value;
      if (typeof last === 'string') { try { last = JSON.parse(last); } catch (_) { /* leave */ } }
      const lastMs = last ? new Date(last).getTime() : 0;
      if (Date.now() - lastMs < this.alertCooldownMs) return;

      const text = kind === 'credit_balance'
        ? '⚠ *Sistema parado: crédito Anthropic esgotou.*\n'
          + 'Topar em https://console.anthropic.com/settings/billing\n'
          + 'Fila parada — msgs Slack não estão virando events. Depois de topar, fila reprocessa sozinha.'
        : `⚠ Worker hitting rate limit: ${errStr.slice(0, 200)}`;

      if (this.slack) {
        try {
          if (typeof this.slack.sendDM === 'function') await this.slack.sendDM(this.alertBrunoCampDmId, text);
          else if (typeof this.slack.postMessage === 'function') await this.slack.postMessage(this.alertBrunoCampDmId, text);
        } catch (e) { console.error('[Observer] alert DM fail:', e.message); }
        try {
          if (typeof this.slack.postMessage === 'function') await this.slack.postMessage(this.alertAdminChannelId, text);
        } catch (e) { console.error('[Observer] alert channel fail:', e.message); }
      }

      // Audit
      try {
        await this.db.query(`
          INSERT INTO v3.audit_log (actor_type, action, target_type, target_id, after_data)
          VALUES ('system', 'worker.alert_sent', NULL, NULL, $1::jsonb)`,
          [JSON.stringify({ kind, error_preview: errStr.slice(0, 300) })]);
      } catch (_) { /* audit nunca derruba */ }

      // Cooldown timestamp
      await this.db.query(`
        INSERT INTO v3.settings (key, value)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
        [key, JSON.stringify(new Date().toISOString())]);
    } catch (_) { /* alerta nunca derruba o pipeline */ }
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
   * só processamos as rows que ESTE tick reivindicou.
   *
   * Elegível pro claim: llm_processed_at IS NULL E (nunca reivindicada
   * OU claim expirado há >2min — re-claim após crash do worker).
   * FOR UPDATE SKIP LOCKED no sub-select evita corrida entre ticks.
   *
   * Hardening (descoberto no FIX F):
   *  - ticks NÃO se sobrepõem (_ticking). O setInterval continua
   *    disparando o heartbeat, mas só UM lote processa por vez.
   *  - claim de exatamente `concurrency` mensagens — processa tudo
   *    que reivindicou num único Promise.all. Antes claîava 10 e
   *    processava 2 a 2: as 8 da fila ficavam "claimed" minutos,
   *    estouravam o claim de 2min e eram re-reivindicadas no meio do
   *    processamento → espiral de trabalho duplicado no rate limiter.
   */
  async tick() {
    await this._heartbeat();
    // Auto-close de segurança (Captura Aprimorada A7): 1× a cada 5min,
    // sem bloquear o claim. Fecha events de DIA ANTERIOR ou do dia atual
    // se já passou do expedient_end_hour_ny. Marca closed_reason=
    // 'auto_closed_eod'. Erro aqui nunca interrompe o tick.
    const nowMs = this.now().getTime();
    if (!this._lastSafetyAutoCloseMs || nowMs - this._lastSafetyAutoCloseMs > 5 * 60 * 1000) {
      this._lastSafetyAutoCloseMs = nowMs;
      try {
        await this.eventService.safetyAutoClose(this.now());
      } catch (e) {
        console.error('[Observer] safetyAutoClose error:', e.message);
      }
    }
    if (this._ticking) return [];
    this._ticking = true;
    try {
      // Fase A (dead-letter): msgs dead-lettered saem da fila pra sempre;
      // cada claim incrementa processing_attempts (>=3 falhas → dead-letter
      // no _markError). Antes disso uma msg envenenada re-tentava eternamente.
      const claimed = (await this.db.query(
        `UPDATE v3.messages
           SET claimed_at = NOW(),
               processing_attempts = COALESCE(processing_attempts, 0) + 1,
               last_attempt_at = NOW()
         WHERE id IN (
           SELECT id FROM v3.messages
           WHERE llm_processed_at IS NULL
             AND dead_lettered_at IS NULL
             AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '2 minutes')
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`, [this.concurrency])).rows;
      return await Promise.all(claimed.map((m) => this.processMessage(m)));
    } finally {
      this._ticking = false;
    }
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
