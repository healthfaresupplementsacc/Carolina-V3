'use strict';
// HEALTHFARE V3 — PARTE 2.11 — teste estrutural das migrations.
// (O ciclo DOWN→UP→DOWN ao vivo foi rodado contra um schema
//  isolado v3test no servidor Railway — ver RUN_REPORT da §2.11.)
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'v3', 'schema', 'migrations');
const up = fs.readFileSync(path.join(dir, '001_v3_initial.sql'), 'utf8');
const down = fs.readFileSync(path.join(dir, '001_v3_initial.down.sql'), 'utf8');
const up2 = fs.readFileSync(path.join(dir, '002_actor_type_app_home.sql'), 'utf8');
const down2 = fs.readFileSync(path.join(dir, '002_actor_type_app_home.down.sql'), 'utf8');

const V3_TABLES = [
  'persons', 'shared_accounts', 'shared_account_users', 'activity_types',
  'products', 'product_batches', 'events', 'production_counts', 'messages',
  'prefix_resolution_log', 'admin_chats', 'proposals', 'audit_log',
  'llm_corrections', 'vocabulary', 'person_language_profile', 'settings',
];

describe('V3 §2.11 — migration 001 (estrutura)', () => {
  test('UP cria schema v3 + as 17 tabelas, transacional', () => {
    expect(up).toMatch(/CREATE SCHEMA v3;/);
    expect(up).toMatch(/^BEGIN;/m);
    expect(up).toMatch(/^COMMIT;/m);
    for (const t of V3_TABLES) {
      expect(up).toContain('CREATE TABLE v3.' + t + ' ');
    }
  });

  test('UP — todo CREATE TABLE é schema-qualificado v3.* (#24)', () => {
    expect(up).not.toMatch(/CREATE TABLE (?!v3\.)/);
  });

  test('DOWN dropa schema v3 CASCADE, idempotente, transacional', () => {
    expect(down).toMatch(/DROP SCHEMA IF EXISTS v3 CASCADE;/);
    expect(down).toMatch(/^BEGIN;/m);
    expect(down).toMatch(/^COMMIT;/m);
  });

  test('events trava escrita direta (COMMENT) + idempotência por source_message_ts', () => {
    expect(up).toMatch(/COMMENT ON TABLE v3\.events/);
    expect(up).toMatch(/INSERT\/UPDATE DIRETO PROIBIDO/i);
    expect(up).toMatch(/CREATE UNIQUE INDEX idx_events_source_ts/);
  });

  test('reforços do schema presentes', () => {
    expect(up).toMatch(/persons_slack_user_id_unique[\s\S]*WHERE slack_user_id IS NOT NULL/);
    expect(up).toMatch(/last_stale_check_at/);
    expect(up).toMatch(/stale_check_count/);
    expect(up).toMatch(/cowork_with\s+INTEGER\[\] NOT NULL/);
  });
});

describe('V3 §2.11 — migration 002 (app_home)', () => {
  test('UP adiciona app_home ao CHECK de audit_log.actor_type', () => {
    expect(up2).toMatch(/ADD CONSTRAINT audit_log_actor_type_check/);
    expect(up2).toMatch(/'app_home'/);
  });

  test('DOWN reverte aos 4 valores (sem app_home)', () => {
    expect(down2).toMatch(/DROP CONSTRAINT audit_log_actor_type_check/);
    expect(down2).not.toMatch(/'app_home'/);
  });
});
