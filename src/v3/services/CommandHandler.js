'use strict';
/**
 * HEALTHFARE V3 — bloco 30/mai noite — Comandos do admin via @Carolina.
 *
 * Fluxo:
 *   1. Observer detecta msg de admin (slack_user_id mapeia pra
 *      role owner/manager) com menção @Carolina/@HealthFare Tracker
 *      no canal #orders-and-inventory.
 *   2. Observer.processMessage roteia pra CommandHandler.handle() EM
 *      VEZ DE criar event de produção (admin_directive flow legado
 *      continua igual; o que muda é que comandos vão pra cá).
 *   3. CommandHandler chama LLM com prompt dedicado pra parsear o
 *      comando. JSON estruturado com command_type/target/params/
 *      destructive/uncertain.
 *   4. Reage ✓ na msg do admin (acknowledgment imediato).
 *   5. Se NÃO-DESTRUTIVO ou uncertain=false:
 *        executa direto via EventService → posta reply "Anotado: ...".
 *      Se DESTRUTIVO ou uncertain=true:
 *        salva em v3.pending_commands → posta reply "Reaja ✅ pra
 *        confirmar". TTL 10min (cron expira).
 *   6. Quando admin reage ✅ na reply: events-v2 reaction_added
 *      handler dispara CommandHandler.confirmAndExecute().
 *   7. Audit: actor_type='admin_via_slack' (novo enum value).
 *
 * Guards:
 *   - Só admins (role IN owner/manager) podem mandar comandos.
 *   - Confirmação ✅ tem que vir do MESMO admin que mandou o comando.
 *   - LLM uncertain=true → SEMPRE pede confirmação humana, nunca age direto.
 */

const ADMIN_ROLES = ['owner', 'manager'];
const CAROLINA_MENTION_REGEX = /<@U0B3EQLPEPL>|@carolina|@Carolina/;
const DEFAULT_TTL_MIN = 10;

class CommandHandler {
  /**
   * @param {object} deps
   * @param {object} deps.db
   * @param {object} deps.provider       LLM provider
   * @param {object} deps.eventService
   * @param {object} deps.batchService
   * @param {object} deps.slack          { postAs, addReaction, channelMessage }
   * @param {string} deps.productionChannelId  canal #orders-and-inventory
   * @param {number} [deps.ttlMs]        default 10min
   * @param {function} [deps.now]
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.provider = deps.provider;
    this.eventService = deps.eventService;
    this.batchService = deps.batchService;
    this.slack = deps.slack || null;
    this.productionChannelId = deps.productionChannelId || 'C09UNBXFRKK';
    this.adminChannelId = deps.adminChannelId || 'C0B36DR5MP1';
    this.ttlMs = deps.ttlMs || DEFAULT_TTL_MIN * 60 * 1000;
    this.now = deps.now || (() => new Date());
  }

  /** Detecta apenas se o texto menciona Carolina (regex puro). */
  static hasMention(rawText) {
    return !!rawText && CAROLINA_MENTION_REGEX.test(String(rawText));
  }

  /** Carrega admin person via slack_user_id (DB lookup). null se não-admin. */
  async _loadAdminPerson(slackUserId) {
    if (!slackUserId) return null;
    const r = await this.db.query(
      `SELECT id, display_name, role, slack_user_id FROM v3.persons
       WHERE slack_user_id = $1 AND role IN ('owner','manager') AND deleted_at IS NULL
       LIMIT 1`, [slackUserId]);
    return r.rows[0] || null;
  }

  /**
   * Tenta rotear uma msg como comando admin. Retorna:
   *   { matched: false } — não tem menção (continua pipeline normal do Observer)
   *   { matched: true, handled: false, reason } — menção sem admin (já auditou)
   *   { matched: true, ...handle() result } — comando processado
   */
  async tryRoute(message) {
    if (!CommandHandler.hasMention(message.raw_text || '')) return { matched: false };
    // Comando admin é aceito no canal de produção OU no admin-orin (Frente 1).
    const allowedChannels = [this.productionChannelId, this.adminChannelId];
    if (!allowedChannels.includes(message.slack_channel_id)) return { matched: false };
    const admin = await this._loadAdminPerson(message.slack_user_id);
    if (!admin) {
      await this._audit('admin_command_rejected_not_admin', message.id, {
        reason: 'autor não é admin (role IN owner/manager)',
        slack_user_id: message.slack_user_id,
        raw_text: (message.raw_text || '').slice(0, 200),
      });
      return { matched: true, handled: false, reason: 'not_admin' };
    }
    const result = await this.handle(message, { adminPerson: admin });
    return { matched: true, ...result };
  }

  /**
   * Pipeline principal — chamada pelo Observer quando detecta comando admin.
   * Retorna { handled: true, result: 'executed'|'pending'|'rejected'|'unknown' }.
   */
  async handle(message, options = {}) {
    const adminPerson = options.adminPerson;
    // Carolina responde NO CANAL DE ORIGEM da msg do admin (Frente 1).
    const channel = message.slack_channel_id || this.productionChannelId;
    if (!adminPerson || !ADMIN_ROLES.includes(adminPerson.role)) {
      await this._audit('admin_command_rejected_not_admin', message.id, {
        reason: 'autor não é admin', slack_user_id: message.slack_user_id,
      });
      return { handled: false, result: 'rejected' };
    }

    // 1) react ✓ no admin msg (acknowledgment)
    await this._react(message.slack_ts, 'white_check_mark', channel);

    // 2) LLM parse
    let parsed;
    try {
      parsed = await this._parseCommand(message.raw_text || '', adminPerson, options.context || {});
    } catch (e) {
      await this._reply(message.slack_ts, `❌ Erro ao processar comando: ${e.message}`, channel);
      await this._audit('admin_command_parse_error', message.id, { error: e.message });
      return { handled: true, result: 'error' };
    }

    const isDestructive = !!parsed.destructive;
    const isUncertain = !!parsed.uncertain;
    const isUnknown = parsed.command_type === 'unknown';

    // 3) Roteamento
    if (isUnknown) {
      await this._reply(message.slack_ts,
        `Não entendi o comando. Exemplos:\n`
        + `• "anota lunch da Simone 1pm"\n`
        + `• "maquinario parou 4:18-4:52"\n`
        + `• "apaga ev280"\n`
        + `• "como tá o Potassium?"`, channel);
      await this._audit('admin_command_unknown', message.id, { llm_parsed: parsed });
      return { handled: true, result: 'unknown' };
    }

    if (parsed.command_type === 'query_status') {
      // read-only — só responde
      const text = await this._executeQuery(parsed);
      await this._reply(message.slack_ts, text, channel);
      await this._audit('admin_command_query', message.id, { llm_parsed: parsed });
      return { handled: true, result: 'executed' };
    }

    if (!isDestructive && !isUncertain) {
      // executa direto
      const result = await this._executeNonDestructive(parsed, adminPerson, message);
      await this._reply(message.slack_ts, result.replyText, channel);
      await this._audit('admin_command_executed', message.id, {
        llm_parsed: parsed, result, admin_person_id: adminPerson.id,
      });
      return { handled: true, result: 'executed' };
    }

    // destructive ou uncertain → pending confirmation
    const carolinaReplyText = await this._buildConfirmation(parsed);
    const replyTs = await this._reply(message.slack_ts, carolinaReplyText, channel);
    if (!replyTs) {
      await this._reply(message.slack_ts, '⚠ Falha ao postar pedido de confirmação. Tente de novo.', channel);
      return { handled: true, result: 'error' };
    }
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);
    await this.db.query(`
      INSERT INTO v3.pending_commands
        (carolina_msg_ts, admin_msg_ts, admin_person_id, admin_slack_user_id,
         command_type, command_payload, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [replyTs, message.slack_ts, adminPerson.id, message.slack_user_id,
        parsed.command_type, JSON.stringify(parsed), expiresAt]);
    await this._audit('admin_command_pending', message.id, {
      llm_parsed: parsed, carolina_reply_ts: replyTs, expires_at: expiresAt.toISOString(),
    });
    return { handled: true, result: 'pending' };
  }

  /**
   * Chamado pelo handler de reação ✅. Busca pending command pelo
   * carolina_msg_ts, valida quem confirmou, executa.
   */
  async confirmAndExecute({ carolinaMsgTs, reactorSlackUserId, reactorPersonId, channel }) {
    // Canal de origem da reação (Frente 1) — Carolina responde onde foi chamada.
    const ch = channel || this.productionChannelId;
    const r = await this.db.query(`
      SELECT * FROM v3.pending_commands
      WHERE carolina_msg_ts = $1 AND status = 'pending'`, [carolinaMsgTs]);
    if (r.rows.length === 0) return { handled: false, reason: 'no_pending_command' };
    const cmd = r.rows[0];

    // Guard: só o admin original pode confirmar
    if (reactorPersonId !== cmd.admin_person_id) {
      await this._reply(carolinaMsgTs, '⚠ Só quem mandou o comando pode confirmar.', ch);
      await this._audit('admin_command_wrong_confirmer', null, {
        original_admin: cmd.admin_person_id,
        attempted_admin: reactorPersonId,
        attempted_slack_user_id: reactorSlackUserId,
      });
      return { handled: false, reason: 'wrong_admin' };
    }

    // Guard: expirado?
    if (new Date(cmd.expires_at).getTime() < this.now().getTime()) {
      await this.db.query(`UPDATE v3.pending_commands SET status='expired' WHERE id=$1`, [cmd.id]);
      await this._reply(carolinaMsgTs, '⏰ Comando expirou. Mande de novo se ainda quiser.', ch);
      return { handled: false, reason: 'expired' };
    }

    const adminPerson = { id: cmd.admin_person_id, role: 'owner' };  // já validamos acima
    const parsed = cmd.command_payload;
    let execResult;
    try {
      execResult = await this._executeDestructive(parsed, adminPerson, cmd);
    } catch (e) {
      await this._reply(carolinaMsgTs, `❌ Erro ao executar: ${e.message}`, ch);
      await this._audit('admin_command_execution_error', null, {
        pending_command_id: cmd.id, error: e.message,
      });
      return { handled: true, result: 'error' };
    }
    await this.db.query(`
      UPDATE v3.pending_commands
      SET status='executed', confirmed_at=NOW(), executed_at=NOW(), result=$2::jsonb
      WHERE id=$1`, [cmd.id, JSON.stringify(execResult)]);
    await this._reply(carolinaMsgTs, execResult.replyText, ch);
    await this._audit('admin_command_executed_after_confirm', null, {
      pending_command_id: cmd.id, llm_parsed: parsed, result: execResult,
      admin_person_id: adminPerson.id,
    });
    return { handled: true, result: 'executed' };
  }

  /**
   * Cron — expira comandos pendentes com expires_at < now.
   * Roda 1x/min via setInterval no wire.js.
   */
  async expireOldPending() {
    const r = await this.db.query(`
      UPDATE v3.pending_commands
      SET status='expired'
      WHERE status='pending' AND expires_at < NOW()
      RETURNING id, carolina_msg_ts, admin_msg_ts`);
    for (const row of r.rows) {
      try {
        if (this.slack) {
          // pending_commands não guarda canal — resolve pelo canal da msg
          // original do admin (admin_msg_ts) em v3.messages. Fallback produção.
          let channel = this.productionChannelId;
          try {
            const m = await this.db.query(
              'SELECT slack_channel_id FROM v3.messages WHERE slack_ts = $1 LIMIT 1', [row.admin_msg_ts]);
            if (m.rows[0] && m.rows[0].slack_channel_id) channel = m.rows[0].slack_channel_id;
          } catch (_) { /* mantém fallback */ }
          await this._reply(row.carolina_msg_ts, '⏰ Comando expirou sem confirmação (10min). Mande de novo se ainda quiser.', channel);
        }
      } catch (e) {
        console.error('[CommandHandler] falha ao postar timeout reply:', e.message);
      }
    }
    return r.rows.length;
  }

  // ─── LLM parser ─────────────────────────────────────────────

  async _parseCommand(rawText, adminPerson, context) {
    const sys = [
      'Você é o intérprete de comandos do admin pra Carolina (sistema de tracking',
      'da HealthFare). O admin escreveu uma mensagem mencionando @Carolina.',
      'Sua tarefa: extrair a INTENÇÃO em JSON estruturado.',
      '',
      'TIPOS DE COMANDO suportados:',
      '',
      'NÃO-DESTRUTIVOS (executam direto):',
      '- create_event: cria event novo. params: { person_id, slug, started_at,',
      '  ended_at?, description, product_batch_id?, cowork_with? }',
      '- create_downtime: machine_downtime retroativo. params: { started_at,',
      '  ended_at, person_id?, cowork_with?, product_batch_id?, description }',
      '- annotate_note: adiciona nota em event existente. target: { event_id }.',
      '  params: { note }',
      '- mark_long_running: marca/desmarca event como long_running. target:',
      '  { event_id } OR { person_id, slug, product_batch_id }. params: { flag }',
      '- query_status: pergunta status (read-only). params: { question, scope? }',
      '',
      'DESTRUTIVOS (precisam confirmação ✅):',
      '- delete_event: soft-delete. target: { event_id }. params: { reason? }',
      '- reassign: muda person_id. target: { event_id }. params: { new_person_id }',
      '- edit_field: edita campo do event. target: { event_id }.',
      '  params: { field, value }. Campos permitidos: product_batch_id, ended_at,',
      '  started_at, cowork_with, description, confidence, phase_label.',
      '- close_tasks: FECHA TODAS as tasks abertas de uma OU MAIS pessoas.',
      '  params: { person_ids: [4, 6] }. Use quando admin diz "fecha/finaliza/',
      '  encerra/termina as tasks/atividades/eventos do <pessoa>" (uma ou várias).',
      '- close_specific_event: fecha UM event específico. target: { event_id }.',
      '  Use pra "fecha ev280" / "encerra o evento 280" (≠ apagar).',
      '',
      'DIFERENÇA close vs delete: "fecha/finaliza/encerra" = close (marca fim,',
      'mantém o registro). "apaga/deleta/remove" = delete (soft-delete).',
      '',
      'SEM correspondência ou ambíguo → command_type="unknown".',
      'Se a intenção é clara mas algum dado falta (ex: pessoa não identificada)',
      ' → uncertain=true + explanation.',
      '',
      'CATÁLOGO DE PESSOAS (id → nome / role):',
      '  1 = Bruno Camp (owner)',
      '  2 = Thassio (owner)',
      '  3 = Henrique (manager)',
      '  4 = Vitor (operator)',
      '  5 = Simone (operator)',
      '  6 = Ana (operator)',
      '  7 = Bruno Sarmento (operator)',
      'Quando admin fala "Bruno" em contexto operacional, é Bruno Sarmento (7).',
      '',
      'TIMESTAMPS: NY timezone (EDT/EST). Devolva ISO UTC com Z. Hoje é',
      `  ${this._todayNyDate()} (use pra resolver horários relativos como "4:18 PM" → ISO completo).`,
      '',
      'EXEMPLOS:',
      '',
      'msg: "@Carolina anota que Simone saiu pro almoco às 1:01pm"',
      '→ { "command_type": "create_event", "target": null,',
      '    "params": { "person_id": 5, "slug": "lunch",',
      '                "started_at": "...T17:01:00Z" (1:01 PM NY EDT → 17:01 UTC),',
      '                "ended_at": null, "description": "Almoço Simone (criado retroativo)" },',
      '    "destructive": false, "uncertain": false,',
      '    "explanation": "Criar lunch da Simone começando 1:01 PM" }',
      '',
      'msg: "@Carolina maquinario sem funcionar de 4:18pm as 4:52pm"',
      '→ { "command_type": "create_downtime", "target": null,',
      '    "params": { "started_at": "...T20:18:00Z", "ended_at": "...T20:52:00Z",',
      '                "description": "Maquinário parou (criado retroativo via comando admin)" },',
      '    "destructive": false, "uncertain": false,',
      '    "explanation": "Criar machine_downtime 4:18-4:52 PM" }',
      '',
      'msg: "@Carolina apaga ev280"',
      '→ { "command_type": "delete_event", "target": { "event_id": 280 },',
      '    "params": { "reason": "comando admin via Slack" },',
      '    "destructive": true, "uncertain": false,',
      '    "explanation": "Soft-delete ev280" }',
      '',
      'msg: "@Carolina como tá o Potassium?"',
      '→ { "command_type": "query_status", "target": null,',
      '    "params": { "question": "como tá o Potassium", "scope": "current_production" },',
      '    "destructive": false, "uncertain": false,',
      '    "explanation": "Status atual da produção de Potassium" }',
      '',
      'msg: "@carolina Finaliza os tasks do vitor que estao ativos"',
      '→ { "command_type": "close_tasks", "target": null,',
      '    "params": { "person_ids": [4] },',
      '    "destructive": true, "uncertain": false,',
      '    "explanation": "Fechar todas as tasks abertas do Vitor" }',
      '',
      'msg: "@carolina fecha as atividades do Vitor e da Ana"',
      '→ { "command_type": "close_tasks", "target": null,',
      '    "params": { "person_ids": [4, 6] },',
      '    "destructive": true, "uncertain": false,',
      '    "explanation": "Fechar tasks abertas do Vitor e da Ana" }',
      '',
      'msg: "@carolina encerra o evento 312"',
      '→ { "command_type": "close_specific_event", "target": { "event_id": 312 },',
      '    "params": {}, "destructive": true, "uncertain": false,',
      '    "explanation": "Fechar ev312" }',
      '',
      'RESPOSTA: APENAS o JSON. Sem texto extra. Sem markdown. JSON puro.',
    ].join('\n');

    const userContent = [
      `Admin: ${adminPerson.display_name || `person_id=${adminPerson.id}`} (${adminPerson.role})`,
      `Mensagem: "${rawText}"`,
    ].join('\n');

    const res = await this.provider.classifyRaw(sys, userContent);
    const parsed = res && res.json_parsed;
    if (!parsed || typeof parsed !== 'object' || !parsed.command_type) {
      throw new Error('LLM retornou JSON inválido');
    }
    return parsed;
  }

  _todayNyDate() {
    try {
      const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      return f.format(this.now());
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  // ─── Execução ───────────────────────────────────────────────

  async _executeNonDestructive(parsed, adminPerson, message) {
    switch (parsed.command_type) {
      case 'create_event':
        return this._execCreateEvent(parsed, adminPerson, message);
      case 'create_downtime':
        return this._execCreateDowntime(parsed, adminPerson, message);
      case 'annotate_note':
        return this._execAnnotateNote(parsed, adminPerson, message);
      case 'mark_long_running':
        return this._execMarkLongRunning(parsed, adminPerson, message);
      default:
        return { replyText: `⚠ Tipo não-destrutivo desconhecido: ${parsed.command_type}` };
    }
  }

  async _executeDestructive(parsed, adminPerson, pendingCmd) {
    switch (parsed.command_type) {
      case 'delete_event':
        return this._execDeleteEvent(parsed, adminPerson, pendingCmd);
      case 'reassign':
        return this._execReassign(parsed, adminPerson, pendingCmd);
      case 'edit_field':
        return this._execEditField(parsed, adminPerson, pendingCmd);
      case 'close_tasks':
        return this._execCloseTasks(parsed, adminPerson, pendingCmd);
      case 'close_specific_event':
        return this._execCloseSpecificEvent(parsed, adminPerson, pendingCmd);
      default:
        return { replyText: `⚠ Tipo destrutivo desconhecido: ${parsed.command_type}` };
    }
  }

  async _execCreateEvent(parsed, adminPerson, message) {
    const p = parsed.params || {};
    const slug = p.slug;
    if (!slug || !p.person_id || !p.started_at) {
      return { replyText: `⚠ Faltam params: slug, person_id, started_at.` };
    }
    const at = await this.db.query(`SELECT id FROM v3.activity_types WHERE slug = $1`, [slug]);
    if (at.rows.length === 0) {
      return { replyText: `⚠ slug "${slug}" não existe no catálogo.` };
    }
    // Idempotência: checa se já existe event MESMA pessoa, MESMO slug, MESMO horário (±60s)
    const existing = await this.db.query(`
      SELECT id FROM v3.events
      WHERE person_id = $1 AND activity_type_id = $2 AND deleted_at IS NULL
        AND ABS(EXTRACT(EPOCH FROM (started_at - $3::timestamptz))) < 60
      LIMIT 1`, [p.person_id, at.rows[0].id, p.started_at]);
    if (existing.rows.length > 0) {
      return { replyText: `ℹ Já existe event similar (ev${existing.rows[0].id}). Comando idempotente — nada a fazer.` };
    }
    const ev = await this.eventService.upsert({
      person_id: p.person_id,
      activity_type_id: at.rows[0].id,
      product_batch_id: p.product_batch_id || null,
      started_at: p.started_at,
      ended_at: p.ended_at || null,
      description: p.description || `Criado retroativo via comando admin (msg ${message.slack_ts}).`,
      cowork_with: p.cowork_with || [],
      confidence: 'medium',
      actor_type: 'admin',
    });
    if (!ev) {
      return { replyText: `⚠ Event não criado (guard bloqueou — possivelmente dur=0 non-eod).` };
    }
    return {
      replyText: `✅ Criado ev${ev.id} (${slug}, person ${p.person_id}).`,
      event_id: ev.id,
    };
  }

  async _execCreateDowntime(parsed, adminPerson, message) {
    const p = parsed.params || {};
    if (!p.started_at || !p.ended_at) {
      return { replyText: `⚠ Faltam started_at e ended_at pro downtime.` };
    }
    const at = await this.db.query(`SELECT id FROM v3.activity_types WHERE slug = $1`, ['machine_downtime']);
    if (at.rows.length === 0) return { replyText: `⚠ Catálogo sem machine_downtime.` };

    // Auto-detect cowork das pessoas em produção no intervalo
    let cowork = p.cowork_with || [];
    let personId = p.person_id;
    if ((!cowork || cowork.length === 0) || !personId) {
      const onLine = await this.db.query(`
        SELECT DISTINCT e.person_id, p.display_name, p.role
        FROM v3.events e
        LEFT JOIN v3.persons p ON p.id = e.person_id
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        WHERE e.deleted_at IS NULL
          AND at.flow = 'production'
          AND e.started_at <= $2::timestamptz
          AND (e.ended_at >= $1::timestamptz OR e.ended_at IS NULL)
        ORDER BY e.person_id`, [p.started_at, p.ended_at]);
      const opsOnLine = onLine.rows.filter((r) => !ADMIN_ROLES.includes(r.role)).map((r) => r.person_id);
      if (!personId) personId = opsOnLine[0] || null;
      if ((!cowork || cowork.length === 0) && personId) {
        cowork = opsOnLine.filter((id) => id !== personId);
      }
    }
    if (!personId) {
      return { replyText: `⚠ Não consegui identificar a pessoa do downtime (sem ninguém na linha no intervalo).` };
    }

    // Idempotência
    const existing = await this.db.query(`
      SELECT id FROM v3.events
      WHERE activity_type_id = $1 AND deleted_at IS NULL
        AND ABS(EXTRACT(EPOCH FROM (started_at - $2::timestamptz))) < 60
        AND ABS(EXTRACT(EPOCH FROM (ended_at - $3::timestamptz))) < 60
      LIMIT 1`, [at.rows[0].id, p.started_at, p.ended_at]);
    if (existing.rows.length > 0) {
      return { replyText: `ℹ Já existe machine_downtime similar (ev${existing.rows[0].id}). Nada a fazer.` };
    }

    const ev = await this.eventService.upsert({
      person_id: personId,
      activity_type_id: at.rows[0].id,
      product_batch_id: p.product_batch_id || null,
      started_at: p.started_at,
      ended_at: p.ended_at,
      description: p.description || `Machine downtime criado retroativo via comando admin (msg ${message.slack_ts}).`,
      cowork_with: cowork,
      confidence: 'medium',
      actor_type: 'admin',
    });
    if (!ev) return { replyText: `⚠ Downtime não criado (guard bloqueou).` };
    return {
      replyText: `✅ Criado machine_downtime ev${ev.id} (person ${personId}, cowork [${cowork.join(',')}]).`,
      event_id: ev.id,
    };
  }

  async _execAnnotateNote(parsed, adminPerson, message) {
    const eventId = parsed.target && parsed.target.event_id;
    const note = parsed.params && parsed.params.note;
    if (!eventId || !note) return { replyText: `⚠ Faltam event_id e/ou note.` };
    const cur = await this.db.query(`SELECT description FROM v3.events WHERE id = $1 AND deleted_at IS NULL`, [eventId]);
    if (cur.rows.length === 0) return { replyText: `⚠ ev${eventId} não existe ou está deletado.` };
    const oldDesc = cur.rows[0].description || '';
    const newDesc = oldDesc ? `${oldDesc}\n[admin nota]: ${note}` : `[admin nota]: ${note}`;
    const after = await this.eventService.correct(eventId, { description: newDesc }, adminPerson.id,
      `Annotate via comando Slack admin (msg ${message.slack_ts})`, 'admin');
    return { replyText: `✅ Nota adicionada em ev${eventId}.`, event_id: eventId };
  }

  async _execMarkLongRunning(parsed, adminPerson, message) {
    const t = parsed.target || {};
    const flag = (parsed.params && parsed.params.flag) !== false;
    if (t.event_id) {
      await this.eventService.markLongRunning(t.event_id, flag, {
        actorType: 'admin', actorPersonId: adminPerson.id,
        reason: `comando admin via Slack (msg ${message.slack_ts})`,
      });
      return { replyText: `✅ ev${t.event_id} marcado long_running=${flag}.`, event_id: t.event_id };
    }
    return { replyText: `⚠ mark_long_running sem target.event_id (TODO: suportar slug+product+person).` };
  }

  async _execDeleteEvent(parsed, adminPerson, pendingCmd) {
    const eventId = parsed.target && parsed.target.event_id;
    if (!eventId) return { replyText: `⚠ Falta target.event_id.` };
    const cur = await this.db.query(`SELECT id, deleted_at FROM v3.events WHERE id = $1`, [eventId]);
    if (cur.rows.length === 0) return { replyText: `⚠ ev${eventId} não existe.` };
    if (cur.rows[0].deleted_at) return { replyText: `ℹ ev${eventId} já está deletado.` };
    const reason = (parsed.params && parsed.params.reason) || `comando admin via Slack (pending_command ${pendingCmd.id})`;
    await this.eventService.softDelete(eventId, adminPerson.id, reason, 'admin');
    return { replyText: `✅ ev${eventId} soft-deleted.`, event_id: eventId };
  }

  async _execReassign(parsed, adminPerson, pendingCmd) {
    const eventId = parsed.target && parsed.target.event_id;
    const newPersonId = parsed.params && parsed.params.new_person_id;
    if (!eventId || !newPersonId) return { replyText: `⚠ Faltam event_id e/ou new_person_id.` };
    const after = await this.eventService.correct(eventId, { person_id: newPersonId },
      adminPerson.id,
      `Reassign via comando Slack admin (pending_command ${pendingCmd.id})`, 'admin');
    return { replyText: `✅ ev${eventId} reatribuído pra person_id=${newPersonId}.`, event_id: eventId };
  }

  async _execEditField(parsed, adminPerson, pendingCmd) {
    const eventId = parsed.target && parsed.target.event_id;
    const field = parsed.params && parsed.params.field;
    const value = parsed.params && parsed.params.value;
    const ALLOWED = new Set(['product_batch_id', 'ended_at', 'started_at', 'cowork_with', 'description', 'confidence', 'phase_label']);
    if (!eventId || !field) return { replyText: `⚠ Faltam event_id e/ou field.` };
    if (!ALLOWED.has(field)) return { replyText: `⚠ Campo "${field}" não permitido (allowed: ${[...ALLOWED].join(', ')}).` };
    await this.eventService.correct(eventId, { [field]: value }, adminPerson.id,
      `Edit ${field} via comando Slack admin (pending_command ${pendingCmd.id})`, 'admin');
    return { replyText: `✅ ev${eventId} ${field} atualizado.`, event_id: eventId };
  }

  // ─── Fase A (bloco zerar) — fechar tasks ────────────────────

  /** Normaliza person_ids do parsed (aceita person_id único OU person_ids[]). */
  _personIdsFromParsed(parsed) {
    const p = parsed.params || {};
    const ids = [];
    if (Array.isArray(p.person_ids)) ids.push(...p.person_ids);
    if (p.person_id != null) ids.push(p.person_id);
    if (parsed.target && parsed.target.person_id != null) ids.push(parsed.target.person_id);
    return [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x)))];
  }

  /** Lista open events (foreground) de uma lista de pessoas. */
  async _openEventsForPeople(personIds) {
    if (!personIds.length) return [];
    const r = await this.db.query(`
      SELECT e.id, e.person_id, p.display_name, at.slug, pb.batch_number,
             to_char(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS started_edt,
             ROUND((EXTRACT(EPOCH FROM (NOW() - e.started_at)) / 60)::numeric) AS min_aberto
      FROM v3.events e
      JOIN v3.persons p ON p.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      WHERE e.person_id = ANY($1::int[])
        AND e.ended_at IS NULL AND e.deleted_at IS NULL
        AND e.is_long_running = false
      ORDER BY e.person_id, e.started_at`, [personIds]);
    return r.rows;
  }

  /** close_tasks — fecha TODAS as tasks abertas (foreground) das pessoas. */
  async _execCloseTasks(parsed, adminPerson, pendingCmd) {
    const personIds = this._personIdsFromParsed(parsed);
    if (!personIds.length) return { replyText: '⚠ Não identifiquei a pessoa. Tenta "fecha as tasks do Vitor".' };
    const open = await this._openEventsForPeople(personIds);
    if (!open.length) return { replyText: 'Nenhuma task aberta pra fechar (long-running não conta).' };
    const ids = open.map((e) => e.id);
    await this.db.query(
      `UPDATE v3.events SET ended_at = NOW(), closed_reason = 'admin_close_via_carolina', updated_at = NOW()
       WHERE id = ANY($1::int[]) AND ended_at IS NULL`, [ids]);
    for (const e of open) {
      await this._audit('event.closed_via_carolina', e.id,
        { pending_command_id: pendingCmd.id, admin_person_id: adminPerson.id, slug: e.slug });
    }
    const names = [...new Set(open.map((e) => e.display_name))].join(', ');
    return { replyText: `✅ Fechei ${ids.length} task(s) de ${names}: ev${ids.join(', ev')}.`, event_ids: ids };
  }

  /** close_specific_event — fecha um event por id (se aberto). */
  async _execCloseSpecificEvent(parsed, adminPerson, pendingCmd) {
    const eventId = parsed.target && parsed.target.event_id;
    if (!eventId) return { replyText: '⚠ Faltou o event_id (ex: "fecha ev280").' };
    const r = await this.db.query(
      `UPDATE v3.events SET ended_at = NOW(), closed_reason = 'admin_close_via_carolina', updated_at = NOW()
       WHERE id = $1 AND ended_at IS NULL AND deleted_at IS NULL RETURNING id`, [eventId]);
    if (r.rowCount === 0) {
      const chk = await this.db.query('SELECT ended_at, deleted_at FROM v3.events WHERE id = $1', [eventId]);
      if (!chk.rows[0]) return { replyText: `⚠ ev${eventId} não existe.` };
      if (chk.rows[0].deleted_at) return { replyText: `⚠ ev${eventId} foi apagado.` };
      return { replyText: `ev${eventId} já estava fechado.` };
    }
    await this._audit('event.closed_via_carolina', eventId,
      { pending_command_id: pendingCmd.id, admin_person_id: adminPerson.id, specific: true });
    return { replyText: `✅ ev${eventId} fechado.`, event_id: eventId };
  }

  /** Texto de confirmação — enriquecido pra close_tasks (lista as tasks). */
  async _buildConfirmation(parsed) {
    try {
      if (parsed.command_type === 'close_tasks') {
        const personIds = this._personIdsFromParsed(parsed);
        const open = await this._openEventsForPeople(personIds);
        if (!open.length) return '⚠ Vou fechar tasks, mas não achei nenhuma aberta dessas pessoas. Reaja ✅ pra seguir mesmo assim (10min) ou ❌ pra cancelar.';
        const lines = open.map((e) =>
          `• ${e.display_name} — ${e.slug || '?'}${e.batch_number ? ' ' + e.batch_number : ''} (aberta há ${e.min_aberto}min)`);
        return `⚠ Vou fechar ${open.length} task(s) abertas:\n${lines.join('\n')}\nReaja ✅ NESTA mensagem (10min) pra confirmar. ❌ pra cancelar.`;
      }
      if (parsed.command_type === 'close_specific_event') {
        const id = parsed.target && parsed.target.event_id;
        return `⚠ Vou fechar a task ev${id} (ended_at = agora).\nReaja ✅ NESTA mensagem (10min) pra confirmar. ❌ pra cancelar.`;
      }
    } catch (e) {
      console.error('[CommandHandler] _buildConfirmation falhou:', e.message);
    }
    return this._formatConfirmationPrompt(parsed);
  }

  /**
   * Fase E (BUG #4) — filtro SEMÂNTICO da pergunta: "quem está na linha?"
   * filtra production_line; "formulando?" → grupo formulação; "limpeza?" →
   * cleaning; nome de pessoa → filtra por pessoa. Sem keyword → tudo LIVE
   * de flow=production (comportamento anterior). Função pura, testável.
   * @param {string} question
   * @param {Array<{id, display_name}>} persons
   * @returns {{slugs: string[]|null, personId: number|null}}
   */
  static parseQueryFilters(question, persons = []) {
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const q = norm(question);
    const KEYWORDS = [
      { re: /linha|producao|production/, slugs: ['production_line', 'review', 'counting', 'line_changeover'] },
      { re: /formula|mistur|capsul|tablet|penera/, slugs: ['formulation', 'mixing', 'encapsulation', 'material_handling'] },
      { re: /limpez|limpando|cleaning/, slugs: ['cleaning'] },
      { re: /embalag|empacot|packing|packaging|label|ordens|orden/, slugs: ['packaging', 'labeling', 'orders', 'order_printing', 'order_printing_2', 'box_closing', 'marketplace_prep'] },
      { re: /envio|shipping|enviando/, slugs: ['shipping', 'dc_shipment', 'clinic_shipment'] },
      { re: /almoc|lunch|pausa|break/, slugs: ['lunch', 'break'] },
    ];
    let slugs = null;
    for (const k of KEYWORDS) { if (k.re.test(q)) { slugs = k.slugs; break; } }
    let personId = null;
    for (const p of persons) {
      const name = norm(p.display_name);
      const first = name.split(/\s+/)[0];
      if (first && first.length >= 3 && q.includes(first)) { personId = p.id; break; }
    }
    return { slugs, personId };
  }

  async _executeQuery(parsed) {
    const q = (parsed.params && parsed.params.question) || '';
    const scope = parsed.params && parsed.params.scope;
    if (scope === 'current_production') {
      // Fase E — filtros semânticos da pergunta (keyword + pessoa)
      let filters = { slugs: null, personId: null };
      try {
        const pr = await this.db.query(
          `SELECT id, display_name FROM v3.persons WHERE deleted_at IS NULL AND active = true`);
        filters = CommandHandler.parseQueryFilters(q, pr.rows);
      } catch (_) { /* sem filtro de pessoa se a query falhar */ }

      const conds = ['e.deleted_at IS NULL', 'e.ended_at IS NULL'];
      const vals = [];
      if (filters.slugs) {
        vals.push(filters.slugs);
        conds.push(`at.slug = ANY($${vals.length}::text[])`);
      } else {
        conds.push(`at.flow = 'production'`); // comportamento original
      }
      if (filters.personId) {
        vals.push(filters.personId);
        conds.push(`(e.person_id = $${vals.length} OR e.cowork_with @> ARRAY[$${vals.length}]::int[])`);
      }
      const r = await this.db.query(`
        SELECT p.display_name AS person, at.slug, pr.canonical_name AS product,
               pb.batch_number, e.started_at,
               to_char(e.started_at AT TIME ZONE 'America/New_York', 'HH12:MI AM') AS started_edt
        FROM v3.events e
        LEFT JOIN v3.persons p ON p.id = e.person_id
        LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
        LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
        LEFT JOIN v3.products pr ON pr.id = pb.product_id
        WHERE ${conds.join(' AND ')}
        ORDER BY e.started_at DESC LIMIT 15`, vals);
      if (r.rows.length === 0) {
        return filters.slugs || filters.personId
          ? 'Ninguém nessa atividade agora.' : 'Sem produção ativa agora.';
      }
      return r.rows.map((row) =>
        `• ${row.person || '?'} — ${row.slug || '?'}${row.product ? ' · ' + row.product : ''}${row.batch_number ? ' ' + row.batch_number : ''} (desde ${row.started_edt})`
      ).join('\n');
    }
    return `Query: "${q}" — TODO suportar mais scopes além de current_production.`;
  }

  // ─── Slack helpers ──────────────────────────────────────────

  _formatConfirmationPrompt(parsed) {
    const expl = parsed.explanation || JSON.stringify(parsed.target || parsed.params);
    return `⚠ Vou ${expl}.\nReaja ✅ NESTA mensagem (10min) pra confirmar. Reaja ❌ pra cancelar.`;
  }

  async _react(slackTs, emoji, channel) {
    if (!this.slack || !this.slack.addReaction) return;
    try {
      await this.slack.addReaction({ channel: channel || this.productionChannelId, ts: slackTs, emoji });
    } catch (e) {
      console.error('[CommandHandler] addReaction falhou:', e.message);
    }
  }

  async _reply(threadTs, text, channel) {
    // Decisão Bruno (01/jun): reply da Carolina SEMPRE no canal principal
    // (mensagem top-level), NUNCA em thread — qualquer canal, qualquer comando.
    // O 1º arg (threadTs) é mantido por compat dos call-sites mas IGNORADO
    // p/ threading (thread_ts=null explícito). O ✓ (_react) segue mirando a msg.
    if (!this.slack || !this.slack.postAs) return null;
    try {
      const r = await this.slack.postAs({
        channel: channel || this.productionChannelId,
        sender: { name: 'Carolina' },
        text,
        thread_ts: null,
      });
      return r && r.ts;
    } catch (e) {
      console.error('[CommandHandler] postAs falhou:', e.message);
      return null;
    }
  }

  async _audit(action, messageId, metadata) {
    try {
      // actor_type='admin' (passa no CHECK audit_log_actor_type_check). Ver TODO
      // no INTEGRATION_PLAN sobre criar 'admin_via_slack' pra diferenciar de dashboard.
      await this.db.query(
        `INSERT INTO v3.audit_log
           (actor_type, actor_person_id, action, target_type, target_id, before_data, after_data, metadata)
         VALUES ('admin', NULL, $1, 'message', $2, NULL, NULL, $3::jsonb)`,
        [action, messageId, JSON.stringify(metadata || {})]);
    } catch (e) {
      console.error('[CommandHandler] _audit falhou:', e.message);
    }
  }
}

module.exports = { CommandHandler, ADMIN_ROLES, CAROLINA_MENTION_REGEX };
