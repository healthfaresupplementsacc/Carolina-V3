'use strict';
/**
 * HEALTHFARE V3 — AUDITORIA 22/mai/2026 (America/New_York). READ-ONLY.
 *
 * Lê v3.events do dia (deleted_at IS NULL), agrupa por pessoa,
 * responde 4 perguntas específicas do Bruno e lista mensagens com
 * DUAS pessoas no texto (candidatos a atribuição trocada).
 *
 * NÃO altera nada. Saída em markdown pra colar na conversa.
 */
const { makeV3Pool } = require('../src/v3/utils/v3-pool');

const DAY = '2026-05-22';
const TZ = 'America/New_York';

function fmtClock(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ts));
}

function durLabel(s, e) {
  if (!s) return '?';
  if (!e) return 'aberto';
  const ms = new Date(e).getTime() - new Date(s).getTime();
  if (ms < 0) return `INVÁLIDO(${Math.round(ms / 1000)}s)`;
  if (ms === 0) return '0s';
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(ss).padStart(2, '0')}s`;
  return `${ss}s`;
}

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/\r/g, '');

const STOP_NAMES = new Set(['de', 'da', 'do', 'dos', 'das', 'silva', 'santos']);
const firstNameOf = (n) => String(n || '').trim().split(/\s+/)[0].toLowerCase();

(async () => {
  const p = makeV3Pool();
  try {
    // ── catálogo de pessoas (pra detectar nomes no texto)
    const persons = (await p.query(
      'SELECT id, display_name, role FROM v3.persons WHERE deleted_at IS NULL ORDER BY id')).rows;
    const personFirsts = persons
      .map((pp) => ({ id: pp.id, name: pp.display_name, role: pp.role, first: firstNameOf(pp.display_name) }))
      .filter((pp) => pp.first && pp.first.length >= 3 && !STOP_NAMES.has(pp.first));

    // ── todos os events do dia
    const events = (await p.query(`
      SELECT e.id, e.person_id, e.activity_type_id, e.product_batch_id,
             e.started_at, e.ended_at, e.confidence, e.cowork_with,
             e.source_message_ts, e.closed_reason,
             pn.display_name AS person, pn.role AS role,
             at.slug AS slug, at.display_name AS activity, at.flow, at.category,
             pb.batch_number, pr.canonical_name AS product,
             m.raw_text AS msg_text, m.slack_user_id AS msg_user_id, m.person_id AS msg_person_id
      FROM v3.events e
      LEFT JOIN v3.persons pn ON pn.id = e.person_id
      LEFT JOIN v3.activity_types at ON at.id = e.activity_type_id
      LEFT JOIN v3.product_batches pb ON pb.id = e.product_batch_id
      LEFT JOIN v3.products pr ON pr.id = pb.product_id
      LEFT JOIN v3.messages m ON m.slack_ts = e.source_message_ts
      WHERE e.deleted_at IS NULL
        AND (e.started_at AT TIME ZONE 'America/New_York')::date = $1
      ORDER BY e.started_at, e.id`, [DAY])).rows;

    // ── clampados (audit_log)
    const ids = events.map((r) => r.id);
    const clampedRows = ids.length
      ? (await p.query(
        `SELECT target_id FROM v3.audit_log
         WHERE target_type='event' AND action='event.negative_duration_clamped'
           AND target_id = ANY($1)`, [ids])).rows
      : [];
    const clampedSet = new Set(clampedRows.map((r) => r.target_id));

    // ── agrupa por pessoa
    const byPerson = new Map();
    for (const ev of events) {
      const key = ev.person_id;
      if (!byPerson.has(key)) byPerson.set(key, { name: ev.person, role: ev.role, evs: [], totalSec: 0 });
      const b = byPerson.get(key);
      b.evs.push(ev);
      if (ev.started_at && ev.ended_at) {
        const s = (new Date(ev.ended_at).getTime() - new Date(ev.started_at).getTime()) / 1000;
        if (s > 0) b.totalSec += s;
      }
    }

    // ───────────────── SAÍDA ─────────────────
    console.log(`# Auditoria — v3.events em ${DAY} (America/New_York)`);
    console.log(`\nTotal de events do dia: **${events.length}** (deleted_at IS NULL).`);
    console.log(`Pessoas distintas com events: **${byPerson.size}**. Snapshot lido agora: ${new Date().toISOString()}.\n`);

    // ── TABELA
    console.log('## Tabela completa (ordenada por started_at)\n');
    console.log('| id | pessoa | atividade | fluxo | lote/produto | início | fim | duração | conf | cowork | source_ts | qty | flags |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const ev of events) {
      const flags = [];
      if (!ev.ended_at) flags.push('aberto');
      if (ev.ended_at && new Date(ev.ended_at).getTime() <= new Date(ev.started_at).getTime()) flags.push('dur≤0');
      if (clampedSet.has(ev.id)) flags.push('clampado');
      if (ev.confidence === 'low' || ev.confidence === 'unconfirmed') flags.push('conf↓');
      const lote = ev.batch_number ? `${ev.product || '?'}/${ev.batch_number}` : (ev.product || '—');
      const act = ev.activity ? `${ev.slug} (${ev.activity})` : '(sem activity_type)';
      console.log(`| ${ev.id} | ${esc(ev.person)} (${ev.person_id}) | ${esc(act)} | ${ev.flow || '—'} | ${esc(lote)} | ${fmtClock(ev.started_at)} | ${ev.ended_at ? fmtClock(ev.ended_at) : '—'} | ${durLabel(ev.started_at, ev.ended_at)} | ${ev.confidence || '—'} | ${(ev.cowork_with || []).join(',') || '—'} | ${ev.source_message_ts || '—'} | — | ${flags.join(' ') || '—'} |`);
    }

    // ── RESUMO POR PESSOA
    console.log('\n## Resumo por pessoa\n');
    const peopleSorted = [...byPerson.entries()].sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
    for (const [pid, b] of peopleSorted) {
      const fp = (b.totalSec / 3600).toFixed(2);
      console.log(`### ${b.name} (id=${pid}, role=${b.role || '—'}) — ${b.evs.length} event(s), ~${fp}h fechadas`);
      for (const e of b.evs) {
        const co = e.cowork_with && e.cowork_with.length ? ` 🔗[${e.cowork_with.join(',')}]` : '';
        const prod = e.batch_number ? ` · ${e.product || '?'}/${e.batch_number}` : (e.product ? ` · ${e.product}` : '');
        console.log(`- ${fmtClock(e.started_at)}→${e.ended_at ? fmtClock(e.ended_at) : 'aberto'} (${durLabel(e.started_at, e.ended_at)}) **${e.slug || '?'}**${prod}${co} _[ev ${e.id}]_`);
      }
      console.log();
    }

    // ── 4 PERGUNTAS
    console.log('## 4 perguntas\n');

    // Q1
    const rev = events.filter((e) => /revis/i.test(e.slug || '') || /revis/i.test(e.activity || ''));
    console.log('### 1. Revisão ~13:45 — atribuído a quem? qual ended_at?');
    if (!rev.length) {
      console.log('(nenhum event de revisão no dia)');
    } else {
      for (const e of rev) {
        console.log(`- **event ${e.id}**: ${e.person} (id=${e.person_id}), ${fmtClock(e.started_at)} → ${e.ended_at ? fmtClock(e.ended_at) : 'aberto'} (${durLabel(e.started_at, e.ended_at)})`);
        console.log(`  - cowork_with=[${(e.cowork_with || []).join(',')}], conf=${e.confidence}`);
        console.log(`  - source_ts=${e.source_message_ts}; msg: "${esc((e.msg_text || '').slice(0, 180))}"`);
      }
    }

    // Q2 — mensagens "-Bruno"
    console.log('\n### 2. Mensagens com assinatura "-Bruno" — pra quem o event foi?');
    const brunoPersons = persons.filter((pp) => /bruno/i.test(pp.display_name || ''));
    if (brunoPersons.length) console.log('persons com "Bruno": ' + brunoPersons.map((b) => `${b.display_name} (id=${b.id}, role=${b.role || '—'})`).join('; '));
    const brunoMsgs = events.filter((e) => /-\s*bruno\b/i.test(e.msg_text || ''));
    if (!brunoMsgs.length) {
      console.log('(nenhum event com "-Bruno" no source message)');
    } else {
      // dedupe by source_message_ts
      const seenTs = new Set();
      for (const e of brunoMsgs) {
        if (seenTs.has(e.source_message_ts)) continue;
        seenTs.add(e.source_message_ts);
        const evs = brunoMsgs.filter((x) => x.source_message_ts === e.source_message_ts);
        console.log(`- msg ${e.source_message_ts}: "${esc((e.msg_text || '').slice(0, 160))}"`);
        for (const ev of evs) {
          console.log(`  - event ${ev.id}: ${ev.person} (id=${ev.person_id}); ${ev.slug}${ev.batch_number ? ' ' + ev.product + '/' + ev.batch_number : ''}`);
        }
      }
    }

    // Q3 — Simone após 15:34
    console.log('\n### 3. Simone tem buraco entre ~15:34 e o EOD (~19:20)?');
    const simone = persons.find((pp) => /^simone/i.test(pp.display_name || ''));
    if (!simone) {
      console.log('(pessoa "Simone" não encontrada)');
    } else {
      const sEvs = events.filter((e) => e.person_id === simone.id);
      const after = sEvs.filter((e) => new Date(e.started_at).getTime() >= new Date(`${DAY}T15:34:00-04:00`).getTime());
      console.log(`- Simone (id=${simone.id}): **${sEvs.length}** event(s) no dia; **${after.length}** a partir das 15:34.`);
      for (const e of after) {
        console.log(`  - event ${e.id}: ${fmtClock(e.started_at)}→${e.ended_at ? fmtClock(e.ended_at) : 'aberto'} ${e.slug}; msg: "${esc((e.msg_text || '').slice(0, 100))}"`);
      }
      const last = sEvs[sEvs.length - 1];
      if (last) console.log(`- último event da Simone no dia: ev ${last.id} @ ${fmtClock(last.started_at)} → ${last.ended_at ? fmtClock(last.ended_at) : 'aberto'} (${last.slug})`);

      // production_counts dela
      const sCounts = (await p.query(
        `SELECT pc.id, pc.bottles, pc.reported_at, pc.product_id, pr.canonical_name AS product,
                pc.product_batch_id, pb.batch_number, pc.source_message_ts
         FROM v3.production_counts pc
         LEFT JOIN v3.products pr ON pr.id = pc.product_id
         LEFT JOIN v3.product_batches pb ON pb.id = pc.product_batch_id
         WHERE pc.reported_by_person_id = $1 AND pc.production_date = $2
           AND pc.deleted_at IS NULL AND pc.superseded_by IS NULL
         ORDER BY pc.reported_at`, [simone.id, DAY])).rows;
      console.log(`- production_counts reportadas pela Simone no dia: ${sCounts.length}`);
      for (const c of sCounts) {
        console.log(`  - ${fmtClock(c.reported_at)} ${c.product || '?'}${c.batch_number ? '/' + c.batch_number : ''}: ${c.bottles} (count_id=${c.id}, src=${c.source_message_ts})`);
      }
    }

    // Q4
    const lowConf = events.filter((e) => e.confidence === 'low' || e.confidence === 'unconfirmed');
    const invalid = events.filter((e) => e.ended_at && new Date(e.ended_at).getTime() <= new Date(e.started_at).getTime());
    const open = events.filter((e) => !e.ended_at);
    console.log('\n### 4. Confidence baixa / duração inválida / abertos\n');
    console.log(`- **confidence low/unconfirmed**: ${lowConf.length}`);
    for (const e of lowConf) console.log(`  - ev ${e.id} ${e.person} ${e.slug} (${e.confidence})`);
    console.log(`- **duração ≤ 0** (started_at >= ended_at): ${invalid.length}`);
    for (const e of invalid) console.log(`  - ev ${e.id} ${e.person} ${e.slug}: ${fmtClock(e.started_at)} → ${fmtClock(e.ended_at)}`);
    console.log(`- **clampados** (audit event.negative_duration_clamped): ${clampedSet.size}`);
    for (const id of clampedSet) console.log(`  - ev ${id}`);
    console.log(`- **abertos** (ended_at NULL): ${open.length}`);
    for (const e of open) console.log(`  - ev ${e.id} ${e.person} ${e.slug} desde ${fmtClock(e.started_at)}`);

    // ── DUAS PESSOAS NUMA LINHA
    console.log('\n## Mensagens com DUAS+ pessoas no texto (candidatos a atribuição trocada)\n');
    const seenTs2 = new Set();
    const suspects = [];
    for (const e of events) {
      if (!e.msg_text || !e.source_message_ts) continue;
      if (seenTs2.has(e.source_message_ts)) continue;
      seenTs2.add(e.source_message_ts);
      const txt = e.msg_text.toLowerCase();
      const hitsRaw = personFirsts.filter((pf) => new RegExp(`\\b${pf.first}\\b`, 'i').test(txt));
      const uniqFirsts = [...new Set(hitsRaw.map((h) => h.first))];
      if (uniqFirsts.length >= 2) {
        const evsOfMsg = events.filter((x) => x.source_message_ts === e.source_message_ts);
        suspects.push({ ts: e.source_message_ts, text: e.msg_text, firsts: uniqFirsts, evs: evsOfMsg });
      }
    }
    if (!suspects.length) {
      console.log('(nenhum)');
    } else {
      console.log(`**${suspects.length}** mensagem(ns) com 2+ nomes no texto, totalizando ${suspects.reduce((a, s) => a + s.evs.length, 0)} event(s):\n`);
      for (const s of suspects) {
        console.log(`- **msg ${s.ts}** — nomes: \`${s.firsts.join(', ')}\``);
        console.log(`  - texto: "${esc(s.text.slice(0, 200))}"`);
        for (const ev of s.evs) {
          console.log(`  - event ${ev.id}: **${ev.person}** (id=${ev.person_id}) → ${ev.slug || '?'}${ev.batch_number ? ' ' + ev.product + '/' + ev.batch_number : ''}; ${fmtClock(ev.started_at)}→${ev.ended_at ? fmtClock(ev.ended_at) : 'aberto'}; cowork=[${(ev.cowork_with || []).join(',')}]`);
        }
      }
    }
    console.log('\n_(fim da auditoria — nada foi alterado)_');
  } catch (e) {
    console.error('ERRO:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await p.end();
  }
})();
