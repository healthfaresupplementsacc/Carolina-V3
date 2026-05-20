'use strict';
/**
 * HEALTHFARE V3 — PARTE 2.3 — PersonResolver (V3 doc §6.3 + princípio #23)
 *
 * Resolve QUEM escreveu uma mensagem.
 *
 * Princípio #23: identificação é entendimento, não pattern match.
 * Este resolver NÃO faz regex de identifies_as. Pra conta própria,
 * lookup direto (zero LLM). Pra conta compartilhada, o LLM lê a
 * mensagem inteira + contexto recente e diz quem é; identifies_as[]
 * vai no prompt apenas como HINT.
 *
 * resolve(slackUserId, messageText, messageTs, context) →
 *   { person_id, resolution_method, detected_identification,
 *     confidence, llm_reasoning, cost_estimate_usd, retryable }
 *
 * GUARD admin: mensagem do canal de produção JAMAIS resolve pra
 * owner/manager. Se o LLM tentar (ex.: "Bruno" → Bruno Camp),
 * descarta → ambiguous_admin_in_production_channel + proposal.
 *
 * Princípio #24: todo acesso a DB é schema-qualificado v3.*.
 */

const ADMIN_ROLES = ['owner', 'manager'];
const DIR_TTL_MS = 30000;          // cache de diretório (§6.9)
const RECENT_WINDOW = "30 minutes"; // contexto recente da conta

class PersonResolver {
  /**
   * @param {object} deps
   * @param {object} deps.db        pool/cliente pg (search_path v3,public)
   * @param {object} deps.provider  LLMProvider (default Anthropic)
   * @param {function} [deps.now]   p/ testar TTL
   * @param {number} [deps.ttlMs]
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.provider = deps.provider;
    this._now = deps.now || Date.now;
    this.ttlMs = deps.ttlMs || DIR_TTL_MS;
    this._dir = null;
    this._dirAt = 0;
    this._llmCache = new Map(); // slack_ts → result (mesma msg nunca re-resolve)
  }

  /** Cache de shared_accounts + shared_account_users + persons (TTL 30s). */
  async _loadDirectory() {
    if (this._dir && (this._now() - this._dirAt) < this.ttlMs) return this._dir;
    const accounts = (await this.db.query(
      'SELECT slack_user_id, primary_owner_id, slack_dm_id, description FROM v3.shared_accounts')).rows;
    const users = (await this.db.query(
      `SELECT sau.shared_account_id, sau.person_id, sau.identifies_as,
              p.display_name, p.role
       FROM v3.shared_account_users sau
       JOIN v3.persons p ON p.id = sau.person_id
       WHERE sau.active = true`)).rows;
    const persons = (await this.db.query(
      'SELECT id, display_name, role, slack_user_id FROM v3.persons WHERE deleted_at IS NULL')).rows;

    const sharedAccounts = new Map();
    for (const a of accounts) sharedAccounts.set(a.slack_user_id, a);
    const usersByAccount = new Map();
    for (const u of users) {
      if (!usersByAccount.has(u.shared_account_id)) usersByAccount.set(u.shared_account_id, []);
      usersByAccount.get(u.shared_account_id).push(u);
    }
    const personsById = new Map();
    const personsBySlack = new Map();
    for (const p of persons) {
      personsById.set(p.id, p);
      if (p.slack_user_id) personsBySlack.set(p.slack_user_id, p);
    }
    this._dir = { sharedAccounts, usersByAccount, personsById, personsBySlack };
    this._dirAt = this._now();
    return this._dir;
  }

  /** Últimas 5 mensagens da mesma conta nos últimos 30 min. */
  async _recentAccountMessages(slackUserId) {
    const r = await this.db.query(
      `SELECT m.raw_text, m.created_at, m.person_id, p.display_name AS person_name
       FROM v3.messages m
       LEFT JOIN v3.persons p ON p.id = m.person_id
       WHERE m.slack_user_id = $1 AND m.created_at > NOW() - INTERVAL '${RECENT_WINDOW}'
       ORDER BY m.created_at DESC LIMIT 5`, [slackUserId]);
    return r.rows;
  }

  /** Monta o prompt focado de resolução de autor. */
  _buildPrompt(account, candidates, recentMsgs, messageText) {
    const system = 'Você decide QUEM escreveu uma mensagem que chegou por uma conta '
      + 'Slack COMPARTILHADA da HealthFare. Várias pessoas usam a mesma conta.\n'
      + 'Leia a mensagem inteira (o nome pode estar no começo, meio, fim, ou ser '
      + 'inferido do contexto recente). identifies_as é só uma DICA, não uma regra.\n'
      + 'Responda SOMENTE com JSON: {"person_id":int|null,'
      + '"identification_evidence":string|null,"confidence":"high|medium|low|unconfirmed",'
      + '"reasoning":string}.\n'
      + 'person_id DEVE ser um dos candidatos listados. Sem nenhuma evidência → '
      + 'person_id null + confidence unconfirmed. Nunca invente person_id.';
    const cand = candidates.map((c) =>
      `  - person_id=${c.person_id} "${c.display_name}" identifies_as=[${(c.identifies_as || []).join(', ')}]`).join('\n');
    const recent = recentMsgs.length
      ? recentMsgs.slice().reverse().map((m) =>
        `  [${new Date(m.created_at).toISOString()}] ${m.person_name || '(não resolvido)'}: ${m.raw_text}`).join('\n')
      : '  (nenhuma mensagem recente)';
    const userContent =
      `Conta compartilhada: ${account.description || account.slack_user_id}\n`
      + `Candidatos (quem pode postar dessa conta):\n${cand}\n\n`
      + `Mensagens recentes dessa conta (30 min):\n${recent}\n\n`
      + `Mensagem a resolver:\n"${messageText}"`;
    return { systemPrompt: system, userContent };
  }

  /** Chama o LLM e devolve o objeto de resolução parseado. */
  async _callLLM(account, candidates, recentMsgs, messageText, messageTs, slackUserId) {
    const prompt = this._buildPrompt(account, candidates, recentMsgs, messageText);
    let res;
    try {
      res = await this.provider.classify(
        { text: messageText, ts: messageTs, slack_user_id: slackUserId }, prompt);
    } catch (e) {
      return { error: 'llm_error', message: e.message, cost: 0 };
    }
    const raw = res && res.raw_response;
    let parsed = null;
    if (raw && typeof raw === 'object') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); }
      catch (_) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_) { /* inválido */ } }
      }
    }
    if (!parsed) return { error: 'llm_invalid_json', cost: (res && res.cost_estimate_usd) || 0 };
    return { parsed, cost: (res && res.cost_estimate_usd) || 0 };
  }

  async _logResolution(ctx, slackUserId, result) {
    if (!ctx || !ctx.message_id) return; // FK NOT NULL — Observer sempre fornece
    try {
      await this.db.query(
        `INSERT INTO v3.prefix_resolution_log
           (message_id, source_slack_user_id, detected_prefix, resolved_person_id,
            resolution_method, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.message_id, slackUserId, result.detected_identification,
          result.person_id, result.resolution_method, result.confidence]);
    } catch (e) {
      console.error('[PersonResolver] falha ao gravar prefix_resolution_log:', e.message);
    }
  }

  async _createProposal(ctx, slackUserId, messageText, candidates, result) {
    try {
      await this.db.query(
        `INSERT INTO v3.proposals (kind, payload, status)
         VALUES ('person_resolution', $1::jsonb, 'pending')`,
        [JSON.stringify({
          message_id: (ctx && ctx.message_id) || null,
          source_slack_user_id: slackUserId,
          text: messageText,
          candidates: candidates.map((c) => ({ person_id: c.person_id, display_name: c.display_name })),
          resolution_method: result.resolution_method,
          confidence: result.confidence,
          llm_reasoning: result.llm_reasoning,
        })]);
    } catch (e) {
      console.error('[PersonResolver] falha ao criar proposal:', e.message);
    }
  }

  /**
   * Resolve o autor.
   * @param {object} context  { message_id, isAdminDM }
   */
  async resolve(slackUserId, messageText, messageTs, context = {}) {
    // cache por slack_ts — mesma mensagem nunca re-resolve (zero LLM, zero writes)
    if (messageTs && this._llmCache.has(messageTs)) return this._llmCache.get(messageTs);

    const dir = await this._loadDirectory();
    const account = dir.sharedAccounts.get(slackUserId);
    let result;

    if (!account) {
      // ── conta própria — lookup direto, sem LLM ──
      const person = dir.personsBySlack.get(slackUserId);
      if (person) {
        result = {
          person_id: person.id, resolution_method: 'direct',
          detected_identification: null, confidence: 'high',
          llm_reasoning: 'conta própria — lookup direto', cost_estimate_usd: 0,
        };
      } else {
        result = {
          person_id: null, resolution_method: 'unknown_account',
          detected_identification: null, confidence: 'unconfirmed',
          llm_reasoning: 'slack_user_id não é conta própria nem compartilhada', cost_estimate_usd: 0,
        };
      }
    } else {
      // ── conta compartilhada — LLM ──
      result = await this._resolveShared(account, dir, slackUserId, messageText, messageTs, context);
    }

    // ── audit (obrigatório) + proposal quando precisa ──
    await this._logResolution(context, slackUserId, result);
    const needsProposal = result.confidence === 'unconfirmed'
      || result.resolution_method === 'ambiguous'
      || result.resolution_method === 'ambiguous_admin_in_production_channel'
      || result.resolution_method === 'llm_invalid_person';
    if (needsProposal) {
      const cands = account ? (dir.usersByAccount.get(slackUserId) || []) : [];
      await this._createProposal(context, slackUserId, messageText, cands, result);
    }

    if (messageTs) this._llmCache.set(messageTs, result);
    return result;
  }

  async _resolveShared(account, dir, slackUserId, messageText, messageTs, context) {
    const candidates = dir.usersByAccount.get(slackUserId) || [];
    if (candidates.length === 0) {
      throw new Error(`shared_account ${slackUserId} sem usuários em shared_account_users — integridade violada`);
    }
    const recent = await this._recentAccountMessages(slackUserId);
    const llm = await this._callLLM(account, candidates, recent, messageText, messageTs, slackUserId);

    // erro de LLM / JSON inválido → unconfirmed (Observer reprocessa)
    if (llm.error) {
      return {
        person_id: null,
        resolution_method: llm.error === 'llm_error' ? 'llm_error' : 'llm_invalid_json',
        detected_identification: null, confidence: 'unconfirmed',
        llm_reasoning: llm.message || 'resposta do LLM inutilizável',
        cost_estimate_usd: llm.cost || 0,
        retryable: llm.error === 'llm_error',
      };
    }

    const p = llm.parsed;
    const llmConf = ['high', 'medium', 'low', 'unconfirmed'].includes(p.confidence) ? p.confidence : 'unconfirmed';
    const base = {
      detected_identification: p.identification_evidence || null,
      llm_reasoning: p.reasoning || '',
      cost_estimate_usd: llm.cost || 0,
    };
    const candidateIds = new Set(candidates.map((c) => c.person_id));

    // LLM sem palpite → fallback owner (se houver) ou unconfirmed
    if (llmConf === 'unconfirmed' || p.person_id == null) {
      if (account.primary_owner_id != null) {
        return Object.assign({}, base, {
          person_id: account.primary_owner_id, resolution_method: 'fallback_owner',
          confidence: 'medium',
        });
      }
      return Object.assign({}, base, {
        person_id: null, resolution_method: 'unconfirmed', confidence: 'unconfirmed',
      });
    }

    // valida o person_id que o LLM devolveu
    const person = dir.personsById.get(p.person_id);
    if (!person) {
      return Object.assign({}, base, {
        person_id: null, resolution_method: 'llm_invalid_person', confidence: 'unconfirmed',
        llm_reasoning: `LLM retornou person_id=${p.person_id} inexistente — descartado`,
      });
    }
    // GUARD admin — canal de produção nunca resolve pra owner/manager
    if (ADMIN_ROLES.includes(person.role) && !context.isAdminDM) {
      return Object.assign({}, base, {
        person_id: null, resolution_method: 'ambiguous_admin_in_production_channel',
        confidence: 'low',
        llm_reasoning: `LLM apontou ${person.display_name} (${person.role}); canal de produção não resolve pra admin — descartado`,
      });
    }
    // LLM apontou alguém fora dos candidatos da conta
    if (!candidateIds.has(person.id)) {
      return Object.assign({}, base, {
        person_id: null, resolution_method: 'llm_invalid_person', confidence: 'unconfirmed',
        llm_reasoning: `LLM apontou person_id=${person.id} fora dos candidatos da conta — descartado`,
      });
    }

    // palpite fraco (low) → mantém o palpite mas marca ambíguo + proposal
    if (llmConf === 'low') {
      return Object.assign({}, base, {
        person_id: person.id, resolution_method: 'ambiguous', confidence: 'low',
      });
    }
    // high / medium → resolve
    return Object.assign({}, base, {
      person_id: person.id,
      resolution_method: llmConf === 'high' ? 'llm_identified' : 'llm_context',
      confidence: llmConf,
    });
  }
}

module.exports = { PersonResolver, ADMIN_ROLES, DIR_TTL_MS };
