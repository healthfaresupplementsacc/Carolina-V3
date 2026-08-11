'use strict';
/**
 * ANALISTA DE DADOS — vigia do Slack (Bruno 07-28).
 *
 * Faz polling do Slack e IMPRIME UMA LINHA (evento) sempre que um ADMIN (owner/
 * manager) faz uma PERGUNTA de dados. Essa linha me acorda (Claude Code, via
 * Monitor) → eu leio a pergunta, rodo o context.js, e respondo no Slack.
 *
 * Uso (dentro de um Monitor):
 *   railway run node scripts/analyst/watch.js
 *
 * Só emite quando:
 *   - autor é admin (role owner/manager em v3.persons, por slack_user_id);
 *   - a mensagem menciona o bot OU termina com "?" OU tem palavra de pergunta;
 *   - não é o próprio bot; não foi já vista (dedup por ts).
 *
 * NÃO responde nada sozinho — só sinaliza. Quem responde sou EU. (Se eu não estiver
 * ativo, o Gemini do Railway responde pelo caminho normal do CommandHandler.)
 */

const { Pool } = require('pg');

const TOK = process.env.SLACK_BOT_TOKEN;
const BOT_ID = 'U0B3EQLPEPL';
const CAROL_ID = 'U044WG04UMQ'; // conta da Carol (Bruno 07-28: TUDO que mencionar @Carol deve ser respondido)
const CHANNELS = (process.env.ANALYST_CHANNELS || 'C0B36DR5MP1,C09UNBXFRKK').split(',').map((s) => s.trim());
const POLL_MS = 15000;
const QUESTION_RE = /\?|\bqual\b|\bquanto\b|\bquantos\b|\bquantas\b|\bcomo\b|\bcompar|\bm[eé]dia\b|\btempo\b|\bstats?\b|\brelat[oó]rio\b|\bme (diz|fala|mostra)\b/i;

async function slack(method, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await (await fetch('https://slack.com/api/' + method + '?' + qs, { headers: { Authorization: 'Bearer ' + TOK } })).json();
  return r;
}

async function main() {
  if (!TOK) { process.stderr.write('SEM SLACK_BOT_TOKEN\n'); process.exit(1); }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  // admins por slack_user_id
  const admins = new Map();
  try {
    const r = await db.query("SELECT slack_user_id, display_name, role FROM v3.persons WHERE role IN ('owner','manager') AND slack_user_id IS NOT NULL AND deleted_at IS NULL");
    for (const p of r.rows) admins.set(p.slack_user_id, p);
  } catch (e) { process.stderr.write('erro admins: ' + e.message + '\n'); }

  const seen = new Set();
  // começa "agora" — só perguntas NOVAS a partir de quando o vigia liga
  let since = (Date.now() / 1000).toFixed(6);
  let sinceThreads = since; // marca d'água das varreduras de thread
  process.stderr.write(`[watch] vigiando ${CHANNELS.length} canais, ${admins.size} admins, desde ${since}\n`);

  async function tick() {
    const tickStart = (Date.now() / 1000).toFixed(6); // marca ANTES de varrer (não perde reply que chega durante)
    for (const ch of CHANNELS) {
      let h;
      try { h = await slack('conversations.history', { channel: ch, oldest: since, limit: 30 }); } catch (_) { continue; }
      if (!h || !h.ok || !h.messages) continue;
      for (const m of h.messages.slice().reverse()) {
        if (m.ts && parseFloat(m.ts) > parseFloat(since)) since = m.ts;
        if (!m.user || m.user === BOT_ID || m.bot_id) continue;
        if (seen.has(m.ts)) continue;
        const admin = admins.get(m.user);
        if (!admin) continue;                                  // só admins
        const text = String(m.text || '').trim();
        if (!text) continue;
        const mentionsBot = text.includes('<@' + BOT_ID + '>') || text.includes('<@' + CAROL_ID + '>') || /@?carolina|@?tracker|@?carol\b/i.test(text);
        if (!mentionsBot && !QUESTION_RE.test(text)) continue;  // parece pergunta?
        seen.add(m.ts);
        // EVENTO (uma linha, JSON) — isto me acorda.
        process.stdout.write(JSON.stringify({ kind: 'admin_question', channel: ch, ts: m.ts, asker: admin.display_name, asker_id: m.user, text }) + '\n');
      }
      // THREADS (Bruno 07-28): replies não aparecem no history → varre threads com
      // atividade nova (a pergunta do P&P veio em thread e passaria batida).
      let h6;
      try { h6 = await slack('conversations.history', { channel: ch, oldest: (Date.now() / 1000 - 6 * 3600).toFixed(6), limit: 100 }); } catch (_) { continue; }
      for (const root of (h6 && h6.messages) || []) {
        if (!root.reply_count || !root.latest_reply) continue;
        if (parseFloat(root.latest_reply) <= parseFloat(sinceThreads)) continue;
        let rep;
        try { rep = await slack('conversations.replies', { channel: ch, ts: root.ts, oldest: sinceThreads, limit: 30 }); } catch (_) { continue; }
        for (const m of (rep && rep.messages) || []) {
          if (m.ts === root.ts || seen.has(m.ts)) continue;
          if (parseFloat(m.ts) <= parseFloat(sinceThreads)) continue;
          if (!m.user || m.user === BOT_ID || m.user === CAROL_ID || m.bot_id) continue;
          const admin = admins.get(m.user);
          if (!admin) continue;
          const text = String(m.text || '').trim();
          if (!text) continue;
          const mentionsBot = text.includes('<@' + BOT_ID + '>') || text.includes('<@' + CAROL_ID + '>') || /@?carolina|@?tracker|@?carol\b/i.test(text);
          if (!mentionsBot && !QUESTION_RE.test(text)) continue;
          seen.add(m.ts);
          process.stdout.write(JSON.stringify({ kind: 'admin_question', channel: ch, ts: m.ts, thread_ts: root.ts, asker: admin.display_name, asker_id: m.user, text }) + '\n');
        }
      }
    }
    sinceThreads = tickStart;
  }

  // loop
  // (Monitor lê o stdout linha a linha; mantemos o processo vivo)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await tick(); } catch (e) { process.stderr.write('[watch] tick erro: ' + e.message + '\n'); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { process.stderr.write('FATAL: ' + e.message + '\n'); process.exit(1); });
