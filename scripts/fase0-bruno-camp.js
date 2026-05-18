'use strict';
/**
 * FASE 0 — grava o slack_user_id real do Bruno Camp (id=333),
 * descoberto via Slack users.list:
 *   U03URLL1D4L | real_name="Bruno Camp" | name="healthfaresupplements"
 * Idempotente. READ-ONLY salvo --apply. Auditado.
 *   railway run ... node scripts/fase0-bruno-camp.js          # dry-run
 *   railway run ... node scripts/fase0-bruno-camp.js --apply
 */
const { Pool } = require('pg');
const { WebClient } = require('@slack/web-api');
const APPLY = process.argv.includes('--apply');
const BRUNO_CAMP_UID = 'U03URLL1D4L';
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let auditAction; try { ({ auditAction } = require('../src/admin/audit')); } catch (_) {}

(async () => {
  // Re-confirma via Slack que o id é mesmo "Bruno Camp" antes de gravar.
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const ui = await slack.users.info({ user: BRUNO_CAMP_UID });
  const rn = ui.user.profile.real_name || '';
  console.log(`Slack users.info(${BRUNO_CAMP_UID}) → real_name="${rn}" bot=${!!ui.user.is_bot} deleted=${!!ui.user.deleted}`);
  if (!/bruno\s*camp/i.test(rn) || ui.user.is_bot || ui.user.deleted) {
    console.log('!! ABORT: id não confere com "Bruno Camp" ativo. Não gravo.');
    await p.end(); return;
  }
  const before = (await p.query('SELECT id,name,role,slack_user_id FROM operators WHERE id=333')).rows[0];
  if (!before) { console.log('!! id=333 não existe.'); await p.end(); return; }
  console.log(`operators id=333 ANTES: name="${before.name}" role=${before.role} slack=${before.slack_user_id}`);
  if (before.slack_user_id === BRUNO_CAMP_UID) { console.log('(idempotente) já está correto.'); await p.end(); return; }
  if (!APPLY) { console.log(`\nDRY-RUN — gravaria slack_user_id=${BRUNO_CAMP_UID}. Rode --apply.`); await p.end(); return; }

  await p.query('UPDATE operators SET slack_user_id=$1, updated_at=NOW() WHERE id=333', [BRUNO_CAMP_UID]);
  if (auditAction) await auditAction({
    action: 'operator.update_slack_user_id', entityType: 'operator', entityId: 333,
    source: 'fase0_followup_users_list',
    before: { slack_user_id: before.slack_user_id },
    after: { slack_user_id: BRUNO_CAMP_UID, method: 'Slack users.list real_name="Bruno Camp"' },
  });
  const after = (await p.query('SELECT id,name,role,slack_user_id FROM operators WHERE id=333')).rows[0];
  console.log(`\n>>> APLICADO + auditado. DEPOIS: name="${after.name}" role=${after.role} slack=${after.slack_user_id}`);
  await p.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
