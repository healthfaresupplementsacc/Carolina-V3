'use strict';
/**
 * Entrega 3 Bug B — supplement autocomplete for App Home external_select.
 *
 * Slack calls the app's single "Options Load URL" (configured in
 * Interactivity settings → Select Menus) with a block_suggestion
 * payload: { type:'block_suggestion', action_id, value }. We respond
 * with { options:[{text,value}, …] } (max 100).
 *
 * Matching:
 *   - empty value → top-N most-used supplements (by historical usage in
 *     tasks/phase_instances), falling back to the catalog order
 *   - 1+ chars → case-insensitive substring match against the canonical
 *     name AND every registered alias. Rank: prefix matches first, then
 *     substring matches, alphabetical within each.
 *   - always append a synthetic "➕ Criar novo: <value>" option with
 *     value '__create__:<value>' so the operator can introduce a brand
 *     new supplement (handled on submit → admin_approved=false + alert).
 */

const parser = require('../parser');

const SLACK_MAX_OPTIONS = 100;

function norm(s) { return String(s || '').trim().toLowerCase(); }

/**
 * Pure matcher over the parser catalog. Returns array of canonical names
 * (already de-duplicated, ranked). `topUsed` (optional) is a list of
 * canonical names to prefer/order-by when the query is empty.
 */
function matchSupplements(query, topUsed = []) {
  const q = norm(query);
  const catalog = parser.listSupplements(); // [{canonical, aliases:'a, b, c'}]
  const entries = catalog.map((c) => ({
    canonical: c.canonical,
    haystack: [c.canonical, ...String(c.aliases || '').split(',')]
      .map(norm).filter(Boolean),
  }));

  if (!q) {
    if (topUsed.length) {
      const set = new Set(entries.map((e) => e.canonical));
      const ranked = topUsed.filter((n) => set.has(n));
      const rest = entries.map((e) => e.canonical)
        .filter((n) => !ranked.includes(n))
        .sort((a, b) => a.localeCompare(b));
      return [...ranked, ...rest].slice(0, 20);
    }
    return entries.map((e) => e.canonical).sort((a, b) => a.localeCompare(b)).slice(0, 20);
  }

  const prefix = [];
  const substr = [];
  for (const e of entries) {
    const isPrefix = e.haystack.some((h) => h.startsWith(q));
    const isSubstr = !isPrefix && e.haystack.some((h) => h.includes(q));
    if (isPrefix) prefix.push(e.canonical);
    else if (isSubstr) substr.push(e.canonical);
  }
  prefix.sort((a, b) => a.localeCompare(b));
  substr.sort((a, b) => a.localeCompare(b));
  return [...prefix, ...substr];
}

function toSlackOptions(canonicalNames, rawValue) {
  const opts = canonicalNames.slice(0, SLACK_MAX_OPTIONS - 1).map((name) => ({
    text: { type: 'plain_text', text: name.slice(0, 75) },
    value: name.slice(0, 150),
  }));
  const typed = String(rawValue || '').trim();
  if (typed) {
    opts.push({
      text: { type: 'plain_text', text: `➕ Criar novo: ${typed}`.slice(0, 75) },
      value: `__create__:${typed}`.slice(0, 150),
    });
  }
  return opts;
}

/**
 * Build the Slack options response for a block_suggestion payload.
 * `db` injected for testability; queries historical usage for the
 * empty-query top list.
 */
async function buildOptionsResponse(payload, deps = {}) {
  const db = deps.db || require('../db');
  const value = payload && payload.value;
  let topUsed = [];
  if (!norm(value)) {
    try {
      const r = await db.query(`
        SELECT name, SUM(n)::int AS total FROM (
          SELECT supplement_name AS name, COUNT(*) AS n FROM tasks
            WHERE supplement_name IS NOT NULL GROUP BY supplement_name
          UNION ALL
          SELECT wi.product_name AS name, COUNT(*) AS n
            FROM phase_instances pi JOIN workflow_instances wi ON wi.id = pi.workflow_instance_id
            WHERE wi.product_name IS NOT NULL GROUP BY wi.product_name
        ) u
        GROUP BY name ORDER BY total DESC LIMIT 20`);
      topUsed = r.rows.map((x) => x.name).filter(Boolean);
    } catch (_) { topUsed = []; }
  }
  const names = matchSupplements(value, topUsed);
  return { options: toSlackOptions(names, value) };
}

module.exports = { matchSupplements, toSlackOptions, buildOptionsResponse, norm };
