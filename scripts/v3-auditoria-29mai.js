'use strict';
/* AUDITORIA COMPLETA 29/mai — read-only.
   Cruza CADA msg do canal com CADA event no banco, por pessoa,
   cronologicamente. Marca falhas estruturais. */
const { Pool } = require('pg');

const TODAY = '2026-05-29';

// Parser de assinatura ESTENDIDO (PHASE 1 + PHASE 2 propostas no bloco anterior).
// Usado pra inferir autor da msg mesmo que o banco mostre outra coisa.
const SIGNATURE_NOISE = new Set([
  's', 'f', 'p', 'n', 'r', 'e', 'ou', 'o', 'a', 'pra', 'para', 'por', 'com',
  'da', 'do', 'de', 'na', 'no', 'um', 'sem', 'as', 'os',
]);

function parseSignature(text, firstNameMap) {
  if (!text) return null;
  const t = String(text).trim();
  const patterns = [
    { re: /-\s*([A-Za-zÀ-ÿ]{2,})\s*$/u },      // sufixo dash
    { re: /\(\s*([A-Za-zÀ-ÿ]{2,})\s*\)\s*$/u }, // (Nome) no fim
    { re: /\bpor\s+([A-Za-zÀ-ÿ]{2,})\s*$/iu }, // por Nome
    { re: /^\s*([A-Za-zÀ-ÿ]{2,})\s*-/u },      // prefixo dash
    { re: /_\s*([A-Za-zÀ-ÿ]{2,})\s*$/u },      // sufixo underscore PHASE 2
    { re: /\s+([A-Za-zÀ-ÿ]{3,})\s*$/u },       // espaço + Nome no fim (3+ pra excluir "S","F")
    { re: /^\s*([A-Za-zÀ-ÿ]{3,})\s/u },        // prefixo Nome + espaço (3+)
  ];
  for (const { re } of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (SIGNATURE_NOISE.has(name)) continue;
    const candidates = firstNameMap.get(name);
    if (!candidates || candidates.length === 0) continue;
    let person = candidates.find((p) => p.role !== 'owner' && p.role !== 'manager');
    if (!person && candidates.length === 1) person = candidates[0];
    if (!person) continue;
    return { person, matched: m[0] };
  }
  return null;
}

function hasSFprefix(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (/^[Ss][:\-;\s]/.test(t)) return 'S';
  if (/^[Ff][:\-;\s]/.test(t)) return 'F';
  return null;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Catálogo de pessoas
  const persons = (await pool.query(`SELECT id, display_name, role, slack_user_id FROM v3.persons WHERE deleted_at IS NULL ORDER BY id`)).rows;
  const personById = new Map(persons.map((p) => [p.id, p]));
  const personByName = new Map();
  const firstNameMap = new Map();
  for (const p of persons) {
    if (!p.display_name) continue;
    const first = p.display_name.split(/\s+/)[0].toLowerCase();
    if (!firstNameMap.has(first)) firstNameMap.set(first, []);
    firstNameMap.get(first).push(p);
  }
  // Slack ID → person owner
  const personBySlack = new Map();
  for (const p of persons) if (p.slack_user_id) personBySlack.set(p.slack_user_id, p);

  // shared_accounts pra resolver owner default
  const accounts = (await pool.query(`SELECT slack_user_id, primary_owner_id, description FROM v3.shared_accounts`)).rows;
  const accountBySlack = new Map(accounts.map((a) => [a.slack_user_id, a]));

  // Resolve autor "depois do PHASE 2": parser → admin slack → shared owner → direct
  function inferAuthor(slack_user_id, text) {
    const sig = parseSignature(text, firstNameMap);
    if (sig) return { person: sig.person, method: 'signature', evidence: sig.matched };
    // direct mapping?
    if (personBySlack.has(slack_user_id)) {
      const p = personBySlack.get(slack_user_id);
      const isAdmin = ['owner', 'manager'].includes(p.role);
      return { person: p, method: isAdmin ? 'admin_directive' : 'direct', evidence: null };
    }
    // shared?
    if (accountBySlack.has(slack_user_id)) {
      const a = accountBySlack.get(slack_user_id);
      if (a.primary_owner_id != null) {
        const p = personById.get(a.primary_owner_id);
        if (p) return { person: p, method: 'owner_default', evidence: null };
      }
    }
    return { person: null, method: 'unknown', evidence: null };
  }

  // Pega TODAS msgs do canal 29/mai
  const msgs = (await pool.query(`
    SELECT m.id, m.slack_user_id, m.slack_ts, m.person_id AS resolved_person_id,
      TO_CHAR(to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS ny_time,
      to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York' AS ny_ts,
      m.events_created, m.events_updated,
      m.llm_result->>'categorization' AS cat,
      m.raw_text
    FROM v3.messages m
    WHERE (to_timestamp(m.slack_ts::numeric) AT TIME ZONE 'America/New_York')::date = $1
    ORDER BY m.slack_ts::numeric`, [TODAY])).rows;

  // Pega TODOS events do dia (não-deletados)
  const events = (await pool.query(`
    SELECT e.id, e.person_id, p.display_name AS person, at.slug, at.flow, at.is_background,
      TO_CHAR(e.started_at AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS s_time,
      TO_CHAR(e.ended_at   AT TIME ZONE 'America/New_York', 'HH24:MI:SS') AS e_time,
      e.started_at, e.ended_at, e.closed_reason, e.confidence,
      e.source_message_ts, e.cowork_with,
      pb.batch_number, pr.canonical_name AS product,
      LEFT(COALESCE(e.description,''), 90) AS desc
    FROM v3.events e
    LEFT JOIN v3.persons p ON p.id = e.person_id
    LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
    LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
    LEFT JOIN v3.products pr ON pr.id = pb.product_id
    WHERE e.deleted_at IS NULL
      AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
    ORDER BY e.started_at`, [TODAY])).rows;

  // ─── 1. Lista cronológica de TODAS as msgs ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' 1. MSGS DO CANAL 29/mai — todas, autor inferido pós-PHASE 2');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  ${msgs.length} msgs no dia.\n`);

  const msgRows = msgs.map((m) => {
    const inf = inferAuthor(m.slack_user_id, m.raw_text);
    const evIds = [...(m.events_created || []), ...(m.events_updated || [])];
    const sf = hasSFprefix(m.raw_text);
    return { m, inf, evIds, sf };
  });

  // Pra cada msg, classifica:
  // ✓  — events_created/updated existe E events do banco têm person_id = inferred.person.id
  // ⚠  — events_created/updated existe MAS person_id banco != inferred
  // ✗  — msg tem prefixo S:/F: mas events_created+updated VAZIO
  // ─  — msg sem prefixo SF (small_talk, narrativa, admin)
  for (const { m, inf, evIds, sf } of msgRows) {
    let status = '─';
    let detail = '';
    if (sf && evIds.length === 0) {
      status = '✗';
      detail = `prefixo ${sf}: mas NENHUM event criado/updated`;
    } else if (evIds.length > 0) {
      // confere atribuição
      const eventActors = [];
      for (const id of evIds) {
        const ev = events.find((e) => e.id === id);
        if (ev) eventActors.push(ev.person_id);
      }
      const expectedId = inf.person ? inf.person.id : null;
      const mismatch = expectedId && eventActors.length > 0 && !eventActors.includes(expectedId);
      if (mismatch) {
        status = '⚠';
        detail = `event person=${eventActors[0]} (${personById.get(eventActors[0])?.display_name}) mas inferido=${expectedId} (${inf.person?.display_name})`;
      } else {
        status = '✓';
      }
    }
    const authorTxt = inf.person ? `${inf.person.display_name}(${inf.person.id})` : '?';
    const evTxt = evIds.length ? ` ev=[${evIds.join(',')}]` : '';
    console.log(`  ${status} ${m.ny_time} msg${m.id} [${inf.method}] → ${authorTxt}${evTxt}`);
    console.log(`       "${(m.raw_text || '').slice(0, 140).replace(/\n/g, ' / ')}"`);
    if (detail) console.log(`       ▸ ${detail}`);
  }

  // ─── 2. Estatísticas globais ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 2. ESTATÍSTICAS GLOBAIS');
  console.log('═══════════════════════════════════════════════════════════');
  const stats = { '✓': 0, '⚠': 0, '✗': 0, '─': 0 };
  for (const row of msgRows) {
    const sf = row.sf;
    const evCount = row.evIds.length;
    if (sf && evCount === 0) stats['✗']++;
    else if (evCount > 0) {
      const expectedId = row.inf.person?.id;
      const eventActors = row.evIds.map((id) => events.find((e) => e.id === id)?.person_id).filter(Boolean);
      const mismatch = expectedId && eventActors.length > 0 && !eventActors.includes(expectedId);
      if (mismatch) stats['⚠']++;
      else stats['✓']++;
    } else stats['─']++;
  }
  for (const k of Object.keys(stats)) console.log(`  ${k}: ${stats[k]}`);

  // ─── 3. Events ÓRFÃOS (sem msg de origem) ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 3. EVENTS ⓒ no banco SEM msg de origem clara');
  console.log('═══════════════════════════════════════════════════════════');
  const msgTsSet = new Set(msgs.map((m) => m.slack_ts));
  const orphans = events.filter((e) => {
    if (!e.source_message_ts) return true;
    const base = e.source_message_ts.split('#')[0];   // strip suffix #a0/#a1
    return !msgTsSet.has(base);
  });
  if (orphans.length === 0) console.log('  ✓ Nenhum.');
  for (const e of orphans) {
    console.log(`  ⓒ ev${e.id} ${e.s_time}→${e.e_time || 'LIVE'} ${e.person} ${e.slug}/${e.flow}`);
    console.log(`     src_ts=${e.source_message_ts || 'NULL'} desc="${e.desc}"`);
  }

  // ─── 4. Por pessoa: tempo ativo (presença - break) ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 4. TEMPO ATIVO POR PESSOA — wall-clock real');
  console.log('═══════════════════════════════════════════════════════════');
  function ivOf(e) {
    if (!e.started_at) return null;
    const s = new Date(e.started_at).getTime();
    const eMs = e.ended_at ? new Date(e.ended_at).getTime() : Date.now();
    if (eMs <= s) return null;
    return [s, eMs];
  }
  function mergeIvs(ivs) {
    const valid = ivs.filter(Boolean).sort((a, b) => a[0] - b[0]);
    if (valid.length === 0) return [];
    const merged = [valid[0].slice()];
    for (let i = 1; i < valid.length; i++) {
      const last = merged[merged.length - 1];
      if (valid[i][0] <= last[1]) last[1] = Math.max(last[1], valid[i][1]);
      else merged.push(valid[i].slice());
    }
    return merged;
  }
  const fmtH = (ms) => `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}`;
  const operators = persons.filter((p) => p.role === 'operator');
  for (const op of operators) {
    const evs = events.filter((e) => e.person_id === op.id);
    if (evs.length === 0) continue;
    const eodEv = evs.find((e) => e.slug === 'end_of_day');
    const lastMs = eodEv ? new Date(eodEv.started_at).getTime()
      : Math.max(...evs.map((e) => e.ended_at ? new Date(e.ended_at).getTime() : Date.now()));
    const firstMs = Math.min(...evs.map((e) => new Date(e.started_at).getTime()));
    const presenceMs = Math.max(0, lastMs - firstMs);
    const breakIvs = evs.filter((e) => ['lunch', 'break'].includes(e.slug)).map(ivOf);
    const breakMerged = mergeIvs(breakIvs);
    const breakMs = breakMerged.reduce((s, [a, b]) => s + (b - a), 0);
    const activeMs = Math.max(0, presenceMs - breakMs);
    const tsToNy = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour12: false, timeZone: 'America/New_York' });
    console.log(`\n  ${op.display_name} (id=${op.id})`);
    console.log(`    presença ${tsToNy(firstMs)} → ${tsToNy(lastMs)}${eodEv ? ' (end_of_day)' : ''} = ${fmtH(presenceMs)}`);
    console.log(`    break (lunch+pause)            = ${fmtH(breakMs)}`);
    console.log(`    TEMPO ATIVO                    = ${fmtH(activeMs)}`);
    console.log(`    events totais: ${evs.length} (fg:${evs.filter((e) => !e.is_background).length} bg:${evs.filter((e) => e.is_background).length})`);
  }

  // ─── 5. Regra 35 — F explícito não fechou na hora ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 5. REGRA 35 — F: explícito vs ended_at do event correspondente');
  console.log('═══════════════════════════════════════════════════════════');
  for (const { m, inf, evIds, sf } of msgRows) {
    if (sf !== 'F') continue;
    if (evIds.length === 0) continue;
    for (const id of evIds) {
      const ev = events.find((e) => e.id === id);
      if (!ev || !ev.ended_at) continue;
      const fMs = new Date(m.ny_ts).getTime();
      const endedMs = new Date(ev.ended_at).getTime();
      const diffMin = Math.round((endedMs - fMs) / 60000);
      if (Math.abs(diffMin) >= 5) {
        console.log(`  ⚠ msg${m.id} ${m.ny_time} F: → ev${ev.id} ended ${ev.e_time} (Δ=${diffMin > 0 ? '+' : ''}${diffMin}min)`);
        console.log(`     "${(m.raw_text || '').slice(0, 100)}"`);
      }
    }
  }

  // ─── 6. Regra 36 — S: explícito sem event ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 6. REGRA 36 — S: explícito SEM event criado (✗ do item 1)');
  console.log('═══════════════════════════════════════════════════════════');
  for (const { m, inf, evIds, sf } of msgRows) {
    if (sf !== 'S' || evIds.length > 0) continue;
    console.log(`  ✗ msg${m.id} ${m.ny_time} S: → SEM event`);
    console.log(`     "${(m.raw_text || '').slice(0, 120)}"`);
    console.log(`     inferido=${inf.person?.display_name || '?'} (${inf.method})`);
  }

  // ─── 7. Regra 37 — events longos sem F intermediário ───
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' 7. REGRA 37 — fg production_line > 3h sem F intermediário');
  console.log('═══════════════════════════════════════════════════════════');
  for (const e of events) {
    if (e.slug !== 'production_line' || e.is_background) continue;
    if (!e.ended_at) continue;
    const durH = (new Date(e.ended_at) - new Date(e.started_at)) / 3600000;
    if (durH < 3) continue;
    console.log(`  ⚠ ev${e.id} ${e.s_time}→${e.e_time} (${durH.toFixed(1)}h) ${e.person} ${e.product || '—'}/${e.batch_number || '—'}`);
    console.log(`     desc: "${e.desc}"`);
  }

  await pool.end();
}
main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message, '\n', e.stack); process.exit(1); });
