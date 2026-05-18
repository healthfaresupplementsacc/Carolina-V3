'use strict';
/**
 * FASE 0 — cadastro/atualização de operators + cleanup AdminValidateTest.
 *
 * Idempotente. Resolve DM-id (D...) → user-id (U...) via Slack API
 * (conversations.info do IM → channel.user; fallback conversations.members).
 * Audita cada operação. NÃO dropa nada (só soft-delete do lixo de teste).
 *
 *   railway run --service ProductionLineService node scripts/fase0-operators.js          # dry-run
 *   railway run --service ProductionLineService node scripts/fase0-operators.js --apply
 */
const { Pool } = require('pg');
const { WebClient } = require('@slack/web-api');

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Roster final (info dada pelo Bruno). slack:null = sem conta própria.
const ROSTER = [
  { canonical: 'Ana',               match: ['Ana'],                       role: 'operator', slack: null },
  { canonical: 'Bruno Sarmento',    match: ['Bruno Sarmento'],            role: 'operator', slack: null },
  { canonical: 'Simone',            match: ['Simone'],                    role: 'operator', dm: 'D07FXKPUD6D' },
  { canonical: 'Vitor Leite',       match: ['Vitor Leite', 'Vitor'],      role: 'operator', dm: 'D08JY69V1G8' },
  { canonical: 'Bruno Camp',        match: ['Bruno Camp'],                role: 'owner',    dm: 'D03UL80GDRB' },
  { canonical: 'Thassio',           match: ['Thassio'],                   role: 'owner',    dm: 'D03V1RNLSKT' },
  { canonical: 'Henrique Monteiro', match: ['Henrique Monteiro', 'Henrique'], role: 'manager', dm: 'D085DLHDRCK' },
];

let auditAction;
try { ({ auditAction } = require('../src/admin/audit')); } catch (_) { auditAction = null; }
async function audit(o) { if (auditAction) { try { await audit_(o); } catch (e) { console.error('audit err', e.message); } } }
async function audit_(o) { return auditAction({ ...o, source: 'fase0_script' }); }

async function resolveUserId(dm) {
  if (!dm) return null;
  try {
    const r = await slack.conversations.info({ channel: dm });
    if (r.channel && r.channel.user) return r.channel.user;
  } catch (e) { /* try members */ }
  try {
    const m = await slack.conversations.members({ channel: dm });
    const ids = (m.members || []).filter((u) => u !== process.env.SLACK_BOT_USER_ID);
    // pick first non-bot; bot is the app's own user — exclude by users.info bot flag
    for (const u of ids) {
      try { const ui = await slack.users.info({ user: u }); if (!ui.user.is_bot) return u; } catch (_) {}
    }
    return ids[0] || null;
  } catch (e) { return null; }
}

async function findExisting(matchNames) {
  const r = await pool.query(
    `SELECT * FROM operators WHERE ${matchNames.map((_, i) => `LOWER(name)=LOWER($${i + 1})`).join(' OR ')}
     ORDER BY (LOWER(name)=LOWER($1)) DESC, id ASC`, matchNames);
  return r.rows[0] || null;
}

function validU(s) { return typeof s === 'string' && /^U[A-Z0-9]+$/.test(s); }

(async () => {
  console.log(`==== FASE 0 OPERATORS ${APPLY ? 'APPLY' : 'DRY-RUN'} ====\n`);
  try {
    const at = await slack.auth.test();
    console.log(`Slack auth.test: ok bot=${at.user} (${at.user_id})`);
  } catch (e) { console.log(`Slack auth.test FALHOU: ${e.message} (token ausente/sem escopo?)`); }
  const unresolved = [];

  // PARTE 2 — roster. NÃO-DESTRUTIVO: nunca apaga um slack_user_id válido
  // (U...). Só usa um id novo se a Slack API resolveu o DM. Se não
  // resolveu: mantém o U... existente; limpa só valor inválido (D...).
  for (const p of ROSTER) {
    const userId = p.dm ? await resolveUserId(p.dm) : null;
    const before = await findExisting(p.match);
    let desiredSlack;
    let slackNote = '';
    if (p.slack === null && !p.dm) {
      desiredSlack = null; // Ana / Bruno Sarmento — sem conta própria (spec)
    } else if (userId) {
      desiredSlack = userId; // resolveu via Slack API
    } else {
      // não resolveu o DM → preserva o existente se for U... válido;
      // se for inválido (D.../vazio) → NULL (correção), e reporta.
      desiredSlack = validU(before && before.slack_user_id) ? before.slack_user_id : null;
      slackNote = ` [DM ${p.dm} não resolvível pelo bot — mantido "${desiredSlack}"]`;
      unresolved.push(`${p.canonical}: DM ${p.dm} não resolvido; slack=${desiredSlack || 'NULL'} (confirmar manualmente)`);
    }
    const beforeStr = before
      ? `id=${before.id} name="${before.name}" slack=${before.slack_user_id} role=${before.role} active=${before.active}/${before.is_active}`
      : '(não existe)';
    console.log(`- ${p.canonical}: ANTES ${beforeStr}`);
    console.log(`            DEPOIS name="${p.canonical}" slack=${desiredSlack} role=${p.role} active=true${slackNote}`);
    if (!APPLY) continue;

    let after, action;
    if (before) {
      await pool.query(
        `UPDATE operators SET name=$1, slack_user_id=$2, role=$3,
                active=TRUE, is_active=TRUE, is_temporary=FALSE, updated_at=NOW()
         WHERE id=$4`,
        [p.canonical, desiredSlack, p.role, before.id]);
      after = (await pool.query('SELECT * FROM operators WHERE id=$1', [before.id])).rows[0];
      action = 'operator.update_slack_user_id';
    } else {
      const ins = await pool.query(
        `INSERT INTO operators (name, slack_user_id, role, is_shared_account, aliases,
            active, is_active, is_temporary, hired_at)
         VALUES ($1,$2,$3,FALSE,'',TRUE,TRUE,FALSE,NOW()) RETURNING *`,
        [p.canonical, desiredSlack, p.role]);
      after = ins.rows[0];
      action = 'operator.create';
    }
    await audit({ action, entityType: 'operator', entityId: after.id,
      before: before ? { name: before.name, slack_user_id: before.slack_user_id, role: before.role } : null,
      after: { name: after.name, slack_user_id: after.slack_user_id, role: after.role } });
  }

  // PARTE 3 — cleanup AdminValidateTest_*
  console.log('\n-- Cleanup AdminValidateTest_* --');
  const junk = await pool.query(
    `SELECT id,name FROM operators WHERE name ILIKE 'AdminValidateTest%' AND (active OR is_active) ORDER BY id`);
  console.log(`encontrados ${junk.rows.length} ativos`);
  if (APPLY && junk.rows.length) {
    const ids = junk.rows.map((r) => r.id);
    await pool.query(
      `UPDATE operators SET active=FALSE, is_active=FALSE, updated_at=NOW() WHERE id = ANY($1)`, [ids]);
    await audit({ action: 'operator.cleanup_admin_validate_leftover', entityType: 'operator',
      entityId: 'bulk', before: { active_ids: ids }, after: { soft_deleted: ids.length } });
    console.log(`soft-deleted ${ids.length}`);
  }

  // PARTE 4 — auditoria final
  console.log('\n==== OPERATORS ATIVOS (final) ====');
  const act = await pool.query(
    `SELECT id,name,slack_user_id,role,active,is_active FROM operators
     WHERE active OR is_active ORDER BY role, name`);
  console.table(act.rows);
  const EXPECT = {
    'Ana': { role: 'operator', slack: null },
    'Bruno Sarmento': { role: 'operator', slack: null },
    'Simone': { role: 'operator', slack: 'U' },
    'Vitor Leite': { role: 'operator', slack: 'U' },
    'Bruno Camp': { role: 'owner', slack: 'U' },
    'Thassio': { role: 'owner', slack: 'U' },
    'Henrique Monteiro': { role: 'manager', slack: 'U' },
  };
  const div = [];
  for (const [nm, exp] of Object.entries(EXPECT)) {
    const row = act.rows.find((r) => r.name === nm);
    if (!row) { div.push(`FALTANDO: ${nm}`); continue; }
    if (row.role !== exp.role) div.push(`${nm}: role ${row.role} (esperado ${exp.role})`);
    if (exp.slack === null && row.slack_user_id) div.push(`${nm}: slack deveria ser NULL, é ${row.slack_user_id}`);
    if (exp.slack === 'U' && !(row.slack_user_id && row.slack_user_id.startsWith('U'))) div.push(`${nm}: slack inválido (${row.slack_user_id})`);
  }
  for (const r of act.rows) if (!EXPECT[r.name] && !/^AdminValidateTest/i.test(r.name)) div.push(`INESPERADO ativo: "${r.name}" (id=${r.id}, role=${r.role})`);
  console.log('\n-- DIVERGÊNCIAS --');
  console.log(div.length ? div.map((d) => '  ' + d).join('\n') : '  (nenhuma)');
  console.log('\n-- SLACK IDs NÃO RESOLVÍVEIS PELO BOT (DM privado; confirmar manualmente) --');
  console.log(unresolved.length ? unresolved.map((u) => '  ' + u).join('\n') : '  (nenhum)');

  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
