'use strict';
/**
 * F8 — typed-channel supplement corrector.
 *
 * When a channel message parses as start/finish/count but no supplement
 * resolved, try to recover the intended supplement:
 *   1. deterministic fuzzy match (Levenshtein) over the parser catalog
 *      (canonical + every alias) — always available, fully testable
 *   2. optional Haiku pass (persona, prod scope) for the harder cases
 *      when ANTHROPIC_API_KEY is set
 *
 * Returns { supplement, confidence:'high'|'medium'|'low', via } or null.
 * Caller decides: high → auto-apply + admin "[auto-corrigido]";
 * < high → admin "confirmar?". App Home never calls this (it has the
 * external_select dropdown).
 */

const parser = require('../parser');

function lev(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Tokens we never treat as a supplement candidate.
const NOISE = new Set([
  's', 'f', 'p', 'n', 'inicio', 'fim', 'comecei', 'iniciei', 'terminei',
  'acabei', 'fechei', 'pronto', 'feito', 'revisao', 'limpeza', 'producao',
  'linha', 'de', 'da', 'do', 'das', 'dos', 'lote', 'batch', 'ordens',
  'ordem', 'mix', 'formula', 'formulacao', 'encapsulacao', 'tablet',
  'contagem', 'nas', 'capsulas', 'rodando', 'ja', 'tirei', 'coloquei',
]);

function catalogPhrases() {
  const out = []; // { canonical, phrase(normalized) }
  for (const c of parser.listSupplements()) {
    out.push({ canonical: c.canonical, phrase: norm(c.canonical) });
    for (const a of String(c.aliases || '').split(',')) {
      const p = norm(a);
      if (p) out.push({ canonical: c.canonical, phrase: p });
    }
  }
  return out;
}

/**
 * Deterministic fuzzy correction. Slides over the message's word
 * n-grams (1..3 words) and finds the catalog phrase with the smallest
 * normalized Levenshtein distance.
 */
function fuzzyCorrect(text) {
  const words = norm(text).split(' ').filter((w) => w && !NOISE.has(w) && !/^\d+$/.test(w));
  if (words.length === 0) return null;
  const phrases = catalogPhrases();
  let best = null;
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n).join(' ');
      if (gram.length < 3) continue;
      for (const c of phrases) {
        const dist = lev(gram, c.phrase);
        const rel = dist / Math.max(gram.length, c.phrase.length);
        if (!best || rel < best.rel) best = { canonical: c.canonical, rel, dist, gram };
      }
    }
  }
  if (!best) return null;
  // exact-ish → high; close → medium; far → low/none
  let confidence;
  if (best.dist === 0 || best.rel <= 0.15) confidence = 'high';
  else if (best.rel <= 0.34) confidence = 'medium';
  else return null;
  return { supplement: best.canonical, confidence, via: 'fuzzy', detail: best };
}

function aiEnabled() {
  return !!process.env.ANTHROPIC_API_KEY && process.env.AI_SUPPLEMENT_CORRECTOR_ENABLED !== '0';
}

async function aiCorrect(text) {
  if (!aiEnabled()) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const { withPersona } = require('./persona');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const catalog = parser.listSupplements().map((c) => c.canonical).join(', ');
    const sys = withPersona(
      `Dado o catálogo de suplementos: ${catalog}\n` +
      `O operador digitou uma mensagem que provavelmente cita UM desses ` +
      `suplementos com erro de digitação. Responda SÓ JSON: ` +
      `{"supplement":"<canonical exato do catálogo ou null>",` +
      `"confidence":"high|medium|low"}`,
      'prod'
    );
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: sys,
      messages: [{ role: 'user', content: `Mensagem: """${String(text).slice(0, 400)}"""` }],
    });
    const raw = (msg.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    const j = JSON.parse(raw);
    if (!j.supplement) return null;
    // validate against catalog (defensive — model must echo a real one)
    const known = parser.listSupplements().some((c) => c.canonical === j.supplement);
    if (!known) return null;
    return { supplement: j.supplement, confidence: j.confidence || 'low', via: 'ai' };
  } catch (err) {
    console.error('[SupplementCorrector] AI error:', err.message);
    return null;
  }
}

/**
 * Main entry. Fuzzy first (cheap, deterministic); if it doesn't reach
 * 'high' and AI is enabled, let Haiku try. Returns best result or null.
 */
async function correctSupplement(text) {
  const f = fuzzyCorrect(text);
  if (f && f.confidence === 'high') return f;
  const a = await aiCorrect(text);
  if (a) return a;
  return f; // medium fuzzy (or null)
}

module.exports = { correctSupplement, fuzzyCorrect, lev, norm };
