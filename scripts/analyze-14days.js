'use strict';
/**
 * Entrega 3 — Phase 0 analysis.
 *
 * Reads the last 14 days of messages from prod and reports the work patterns
 * that should drive the ISA-88 workflow_templates / phase_templates /
 * ad_hoc_tasks design. NO writes.
 *
 * Reports:
 *   A) Work-type frequency: how many start/finish events refer to each
 *      kind of work (formulação, mix, encapsulação, revisão, linha, packing,
 *      ordens, label, limpeza, FNSKU, transformação, manutenção, etc).
 *   B) Per-supplement phase flow: for each supplement, what phases were
 *      seen and in what order across the 14 days. Useful to validate the
 *      Formulação → Mix → Encapsulação → Revisão → Linha → Contagem chain.
 *   C) Transition patterns: from message N to N+1 of the same operator,
 *      what kind of transition (same supp / different supp / phase shift).
 *   D) Free-text work-types that don't fit the obvious buckets — surface
 *      candidate ad_hoc_tasks.
 */

const { Pool } = require('pg');
const parser = require('../src/parser');

const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Phase keyword detectors. Each maps to a canonical phase name.
const PHASE_KEYWORDS = [
  { canonical: 'Formulação',     re: /\bformul(?:a[c]?[a]?o?|ando|ei|ar|aco)\b/i },
  { canonical: 'Mix',            re: /\b(?:mix|mixzando|mixando|misturando|mixar|misturar)\b/i },
  { canonical: 'Encapsulação',   re: /\bencapsul\w*\b/i },
  { canonical: 'Tablet',         re: /\btablet(?:s|es|ando|ar)?\b/i },
  { canonical: 'Revisão',        re: /\brevis[aã]?o?\b|\brevisand|\brevisar/i },
  { canonical: 'Linha de Produção', re: /\blinha\s+de\s+produ[cç][aã]o\b|\blinha\s+de\s+produca[oõ]/i },
  { canonical: 'Contagem',       re: /\bcontagem|\bcontando|\bcontar/i },
  { canonical: 'Picking (ordens)', re: /\bordens?\b|\bordens?\b|\borden\b|\bpicking\b|\bimpress[aã]o\s+das?\s+ordens?\b/i },
  { canonical: 'Packing',        re: /\bpacking|\bempacot|\bimpacot|\bensacando|\bensacar/i },
  { canonical: 'Label',          re: /\blabel(?:s|ando|ar)?\b|\bcolocando\s+label|\betiqueta(?:s|ando|ar)?\b/i },
  { canonical: 'FNSKU',          re: /\bfnsku\b|\bfnsk\b/i },
  { canonical: 'Envio FBA',      re: /\bfba\b|\benvio\s+fba|\bpara\s+(?:o\s+)?fba/i },
  { canonical: 'Envio Walmart',  re: /\bwalmart\b|\bwfs\b/i },
  { canonical: 'Envio Amazon',   re: /\bamazon\b/i },
  { canonical: 'Envio Tiktok',   re: /\btiktok|\btik\s+tok/i },
  { canonical: 'Envio Ebay',     re: /\bebay\b/i },
  { canonical: 'Encaixotar',     re: /\bencaixot|\bfechar\s+caixas?|\bcaixa(?:s|ndo|r)?\b/i },
  { canonical: 'Limpeza',        re: /\blimpez|\blimpand|\blimpar/i },
  { canonical: 'Manutenção',     re: /\bmanuten[cç][aã]o|\bconsertand|\bconsertar|\barrum(?:ando|ar)\s+(?:a\s+)?m[aá]quina/i },
  { canonical: 'Pesagem',        re: /\bpesagem|\bpesando|\bpesar\b/i },
  { canonical: 'Transformação',  re: /\btransform(?:ando|ei|ar|ou)/i },
];

const STOP_OPERATORS = new Set(['Thassio', 'Henrique', 'Bryce', 'AdminValidateTest']);

function detectPhases(text) {
  const hits = new Set();
  for (const p of PHASE_KEYWORDS) {
    if (p.re.test(text)) hits.add(p.canonical);
  }
  return [...hits];
}

(async () => {
  // Pull 14 days of messages including parsed_type and raw text
  const r = await p.query(
    `SELECT m.slack_ts, m.user_id, m.user_name, m.text, m.parsed_type,
            m.created_at,
            (m.created_at AT TIME ZONE 'America/New_York')::date AS et_date
     FROM messages m
     WHERE m.created_at >= NOW() - INTERVAL '14 days'
       AND m.text IS NOT NULL
       AND COALESCE(m.deleted_at::text, '') = ''
     ORDER BY m.slack_ts ASC`
  );
  console.log(`Messages in last 14 days: ${r.rows.length}\n`);

  // ── A) Work-type frequency ────────────────────────────────────────
  const phaseFreq = new Map();      // canonical → { count, operators:Set, supplements:Set }
  const messagesWithoutPhase = [];  // for ad_hoc candidate hunt
  const supplementPhases = new Map(); // supp → Set<phase>
  const operatorPhaseTimeline = new Map(); // operator → [{ts, phases, supp}]

  for (const row of r.rows) {
    const parsed = parser.parseMessage({
      ts: row.slack_ts, text: row.text, user: row.user_id || '', username: row.user_name || '',
    });
    if (!parsed) continue;
    if (parsed.operator && STOP_OPERATORS.has(parsed.operator)) continue;

    const phases = detectPhases(row.text);
    const supp = parsed.supplement || null;

    if (phases.length === 0) {
      // Could be ad-hoc / noise / casual chat. Only collect if it looks
      // actionable (parsed_type was start/finish/etc).
      if (['start','finish','count','pause_start','pause_end','orders_start','orders_finish'].includes(row.parsed_type)) {
        messagesWithoutPhase.push({
          ts: row.slack_ts, parsed_type: row.parsed_type,
          operator: parsed.operator, supp, text: row.text.slice(0, 100),
        });
      }
      continue;
    }

    for (const ph of phases) {
      const entry = phaseFreq.get(ph) || { count: 0, operators: new Set(), supplements: new Set() };
      entry.count++;
      if (parsed.operator) entry.operators.add(parsed.operator);
      if (supp) entry.supplements.add(supp);
      phaseFreq.set(ph, entry);
      if (supp) {
        const sset = supplementPhases.get(supp) || new Set();
        sset.add(ph);
        supplementPhases.set(supp, sset);
      }
    }

    if (parsed.operator) {
      const timeline = operatorPhaseTimeline.get(parsed.operator) || [];
      timeline.push({ ts: row.slack_ts, phases, supp, parsed_type: row.parsed_type, date: row.et_date });
      operatorPhaseTimeline.set(parsed.operator, timeline);
    }
  }

  console.log('========================================');
  console.log('A) Work-type frequency (last 14 days)');
  console.log('========================================');
  const ranked = [...phaseFreq.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [name, e] of ranked) {
    console.log(`  ${name.padEnd(22)} ${String(e.count).padStart(4)} events · ${e.operators.size} ops · ${e.supplements.size} supplements`);
    if (e.operators.size > 0) console.log(`    operators: ${[...e.operators].sort().join(', ')}`);
  }

  // ── B) Phase flow per supplement ─────────────────────────────────
  console.log('\n========================================');
  console.log('B) Phase coverage per supplement (alphabetical)');
  console.log('========================================');
  const supps = [...supplementPhases.keys()].sort();
  console.log(`Total supplements seen in chat: ${supps.length}`);
  for (const s of supps) {
    const phases = [...supplementPhases.get(s)].sort();
    console.log(`  ${s.padEnd(28)} → ${phases.join(', ')}`);
  }

  // ── C) Transitions per operator ──────────────────────────────────
  console.log('\n========================================');
  console.log('C) Same-operator consecutive transitions (top patterns)');
  console.log('========================================');
  const transitions = new Map();
  for (const [op, tl] of operatorPhaseTimeline.entries()) {
    for (let i = 1; i < tl.length; i++) {
      const prev = tl[i - 1];
      const cur  = tl[i];
      // Only consider within same ET day for clean transitions
      if (prev.date !== cur.date) continue;
      for (const a of prev.phases) {
        for (const b of cur.phases) {
          if (a === b) continue;
          const key = `${a} → ${b}`;
          transitions.set(key, (transitions.get(key) || 0) + 1);
        }
      }
    }
  }
  const topTrans = [...transitions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [k, n] of topTrans) console.log(`  [${String(n).padStart(3)}x] ${k}`);

  // ── D) Messages without a recognized phase (ad-hoc candidates) ───
  console.log('\n========================================');
  console.log('D) Action messages without a recognized phase (potential ad-hoc tasks)');
  console.log('========================================');
  console.log(`Total: ${messagesWithoutPhase.length}`);
  const sample = messagesWithoutPhase.slice(0, 30);
  for (const m of sample) {
    console.log(`  [${m.parsed_type.padEnd(13)}] ${(m.operator || '?').padEnd(7)} ${m.supp ? '· ' + m.supp.padEnd(20) : '· --'.padEnd(22)} ${m.text.replace(/\n/g, ' ')}`);
  }

  // ── E) Co-work detection: same-supplement work by 2+ different operators
  console.log('\n========================================');
  console.log('E) Same-supplement work seen across 2+ operators (co-work candidates)');
  console.log('========================================');
  const suppOpPhases = new Map(); // supp → { phase → Set(operator) }
  for (const row of r.rows) {
    const parsed = parser.parseMessage({
      ts: row.slack_ts, text: row.text, user: row.user_id || '', username: row.user_name || '',
    });
    if (!parsed || !parsed.supplement || !parsed.operator) continue;
    if (STOP_OPERATORS.has(parsed.operator)) continue;
    const phs = detectPhases(row.text);
    if (phs.length === 0) continue;
    if (!suppOpPhases.has(parsed.supplement)) suppOpPhases.set(parsed.supplement, new Map());
    const inner = suppOpPhases.get(parsed.supplement);
    for (const ph of phs) {
      if (!inner.has(ph)) inner.set(ph, new Set());
      inner.get(ph).add(parsed.operator);
    }
  }
  for (const [supp, inner] of suppOpPhases.entries()) {
    for (const [ph, opSet] of inner.entries()) {
      if (opSet.size >= 2) {
        console.log(`  ${supp.padEnd(25)} ${ph.padEnd(20)} → ${[...opSet].sort().join(', ')}`);
      }
    }
  }

  await p.end();
})().catch((e) => { console.error('FATAL:', e.message, e.stack); p.end().catch(() => {}); process.exit(1); });
