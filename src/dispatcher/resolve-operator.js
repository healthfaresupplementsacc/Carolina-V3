'use strict';
/**
 * FASE 1 — resolveOperator unificado (doc 10.3 / spec PARTE 2).
 *
 * THE single operator-resolution function. Parser, App Home and Carolina
 * all go through this — there is no other place an operator is decided.
 *
 * Rules, in strict order (Bruno's rules, spec 2.2):
 *
 *   1. Explicit name PREFIX in the text wins — even over the account
 *      owner. Separators accepted: -  _  :  ;  ,  /  and whitespace, in
 *      either order ("ANA-", "ANA_", "ANA :", "- ana", "ana -"),
 *      case-insensitive. Recognized names are derived from the operators
 *      table (name + aliases + unique first name) — NOT hardcoded.
 *   2. Recent CONTEXT: if no prefix, a message from the SAME account
 *      within ≤2 min that DOES carry a prefix is inherited — but only
 *      when the current message looks like a continuation (short, no
 *      S:/F:/start/finish signal), never when it looks like a new task
 *      of someone else, and only when the window points at ONE operator.
 *   3. Account default OWNER (config.accountOwners, Bruno's documented
 *      rule). Shared / no-owner accounts (config.noOwnerAccounts) NEVER
 *      auto-attribute.
 *   4. Nothing → operator_id = null (AMBIGUOUS). Never guessed, never
 *      "next active operator", never a hardcoded user_id. The caller
 *      asks in the admin chat (Part 6).
 */

const config = require('../config');

const SEP = '[\\-_:;,/\\s]';
const WINDOW_MS = 2 * 60 * 1000;

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── default DB-backed dependencies (injectable for tests) ───────────────────
async function _dbLoadOperators() {
  const db = require('../db');
  const r = await db.query(
    `SELECT id, name, COALESCE(aliases,'') AS aliases, role,
            slack_user_id, COALESCE(is_shared_account,FALSE) AS is_shared_account
       FROM operators
      WHERE active = TRUE OR is_active = TRUE`
  );
  return r.rows;
}

async function _dbRecentMessages({ accountUserId, epoch, currentSourceId }) {
  if (!accountUserId || !Number.isFinite(epoch)) return [];
  const db = require('../db');
  const lo = epoch - WINDOW_MS / 1000;
  const hi = epoch + WINDOW_MS / 1000;
  const r = await db.query(
    `SELECT text, slack_ts AS ts
       FROM messages
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND slack_ts <> $2
        AND (slack_ts ~ '^[0-9.]+$')
        AND slack_ts::float8 BETWEEN $3 AND $4
      ORDER BY slack_ts::float8 ASC`,
    [accountUserId, String(currentSourceId || ''), lo, hi]
  );
  return r.rows;
}

/**
 * Build a name → operator matcher from the operators table.
 * Tokens: full name, each alias, and the first word of a multi-word name
 * when that first word is unambiguous among role='operator' rows
 * (so "vitor"→Vitor Leite, "bruno"→Bruno Sarmento, but a colliding
 * first name would require the full name).
 */
function buildMatcher(operators) {
  const tokenToOp = new Map();
  const fwOperatorCount = new Map(); // first word among role='operator'
  const fwTotalCount = new Map(); // first word among ALL active ops

  const ops = operators.filter((o) => o && o.name);
  for (const o of ops) {
    const fw = o.name.trim().split(/\s+/)[0].toLowerCase();
    fwTotalCount.set(fw, (fwTotalCount.get(fw) || 0) + 1);
    if ((o.role || 'operator') === 'operator') {
      fwOperatorCount.set(fw, (fwOperatorCount.get(fw) || 0) + 1);
    }
  }

  function add(token, op) {
    const k = token.trim().toLowerCase();
    if (!k) return;
    // First registration wins unless a later one is a better (operator) role.
    const prev = tokenToOp.get(k);
    if (!prev) tokenToOp.set(k, op);
    else if ((prev.role || 'operator') !== 'operator' && (op.role || 'operator') === 'operator') {
      tokenToOp.set(k, op);
    }
  }

  for (const o of ops) {
    add(o.name, o);
    String(o.aliases || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .forEach((a) => add(a, o));
    const parts = o.name.trim().split(/\s+/);
    if (parts.length > 1) {
      const fw = parts[0].toLowerCase();
      // (a) unique among operators → that operator owns the first name
      //     ("bruno"→Bruno Sarmento even though Bruno Camp is an owner);
      // (b) else globally unique → still usable ("henrique"→manager).
      if (
        ((o.role || 'operator') === 'operator' && fwOperatorCount.get(fw) === 1) ||
        fwTotalCount.get(fw) === 1
      ) {
        add(parts[0], o);
      }
    }
  }

  // longest tokens first so "Vitor Leite" beats "Vitor", "Bruno Sarmento"
  // beats "Bruno".
  const tokens = [...tokenToOp.keys()].sort((a, b) => b.length - a.length);
  return { tokens, tokenToOp };
}

/**
 * Match an inline operator-name prefix at the START of the text.
 * Returns { op, remainingText } or null.
 */
function matchPrefix(text, matcher) {
  if (!text || !matcher.tokens.length) return null;
  const t = text.trim();
  const alt = matcher.tokens.map(esc).join('|');
  // optional leading separators, the name, then at least one separator,
  // case-insensitive, anchored at start.
  const re = new RegExp(`^${SEP}*(${alt})${SEP}+`, 'i');
  const m = t.match(re);
  if (!m) return null;
  const op = matcher.tokenToOp.get(m[1].trim().toLowerCase());
  if (!op) return null;
  return { op, remainingText: t.slice(m[0].length).trim() };
}

// "new task of someone else" signal — a tag (S:/F:/P:/N:), word form
// (INICIO/FIM/...), or a start/finish verb. A short message with none of
// these is treated as a continuation.
const NEW_TASK_RE =
  /^(?:S|F|P|N)\s*[-_:;,/]|^(?:INICIO|FIM|PRODU[CÇ][AÃ]O|PROD|NOTA|OBS)\b|\b(?:iniciei|iniciando|comecei|come[cç]ei|terminei|finalizei|acabei|finaliz\w+)\b/i;

function looksLikeContinuation(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (NEW_TASK_RE.test(t)) return false;
  return t.length <= 40;
}

/**
 * Resolve the operator for one message/event.
 *
 * @param {object} input
 *   - text            raw message text (may carry a prefix)
 *   - accountUserId   Slack user/account id the message came from
 *   - accountUserName optional display name (unused for attribution —
 *                     NEVER guess from it; kept for diagnostics)
 *   - timestamp       ISO time of the event
 *   - sourceId        the message source_id (slack_ts) — excluded from
 *                     the context window
 * @param {object} [deps] injectable { loadOperators, recentMessages }
 * @returns {Promise<{
 *   operatorId:number|null, operatorName:string|null,
 *   via:'prefix'|'context'|'account_owner'|'ambiguous',
 *   remainingText:string, ambiguous:boolean, reason?:string }>}
 */
async function resolveOperator(input, deps = {}) {
  const text = String(input?.text || '');
  const accountUserId = input?.accountUserId || null;
  const timestamp = input?.timestamp || null;
  const sourceId = input?.sourceId || null;

  const loadOperators = deps.loadOperators || _dbLoadOperators;
  const recentMessages = deps.recentMessages || _dbRecentMessages;

  const operators = await loadOperators();
  const matcher = buildMatcher(operators);
  const opById = new Map(operators.map((o) => [o.id, o]));

  function found(op, via, remainingText) {
    return {
      operatorId: op.id,
      operatorName: op.name,
      via,
      remainingText: remainingText != null ? remainingText : text.trim(),
      ambiguous: false,
    };
  }
  function ambiguous(reason, remainingText) {
    return {
      operatorId: null,
      operatorName: null,
      via: 'ambiguous',
      remainingText: remainingText != null ? remainingText : text.trim(),
      ambiguous: true,
      reason,
    };
  }

  // ── Step 1: explicit name prefix (wins over everything) ──
  const pm = matchPrefix(text, matcher);
  if (pm) return found(pm.op, 'prefix', pm.remainingText);

  // ── Step 2: recent context (same account, ≤2 min, one operator) ──
  const epoch = timestamp ? Date.parse(timestamp) / 1000 : NaN;
  if (accountUserId && Number.isFinite(epoch)) {
    let recents = [];
    try {
      recents = await recentMessages({
        accountUserId,
        epoch,
        currentSourceId: sourceId,
      });
    } catch (_) {
      recents = [];
    }
    const distinct = new Map();
    for (const m of recents || []) {
      const r = matchPrefix(String(m.text || ''), matcher);
      if (r && r.op) distinct.set(r.op.id, r.op);
    }
    if (distinct.size === 1 && looksLikeContinuation(text)) {
      const op = [...distinct.values()][0];
      return found(op, 'context', text.trim());
    }
    if (distinct.size > 1) {
      return ambiguous('múltiplos operadores no contexto de 2 min');
    }
  }

  // ── Step 3: account default owner (never for shared/no-owner) ──
  if (accountUserId && !config.noOwnerAccounts.includes(accountUserId)) {
    const ownerName = config.accountOwners[accountUserId];
    if (ownerName) {
      const op = operators.find(
        (o) => o.name && o.name.toLowerCase() === ownerName.toLowerCase()
      );
      if (op) return found(op, 'account_owner', text.trim());
    }
    // data-driven fallback: a non-shared account whose slack_user_id is
    // registered against exactly one active operator.
    const bySlack = operators.filter(
      (o) => o.slack_user_id === accountUserId && !o.is_shared_account
    );
    if (bySlack.length === 1) return found(bySlack[0], 'account_owner', text.trim());
  }

  // ── Step 4: ambiguous — never guess ──
  return ambiguous('sem prefixo, sem contexto, conta sem dono');
}

module.exports = {
  resolveOperator,
  // exported for unit tests / reuse
  buildMatcher,
  matchPrefix,
  looksLikeContinuation,
  WINDOW_MS,
};
