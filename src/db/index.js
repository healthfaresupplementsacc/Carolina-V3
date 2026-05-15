'use strict';
const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms): ${text.substring(0, 80)}`);
    }
    return res;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text.substring(0, 200));
    throw err;
  }
}

async function migrate() {
  const sql = `
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      slack_ts VARCHAR(30) UNIQUE NOT NULL,
      channel_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20),
      user_name VARCHAR(100),
      text TEXT,
      raw_json JSONB,
      parsed_type VARCHAR(20),  -- 'start'|'finish'|'count'|'note'|'freetext'|'ignore'
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- B4: track Slack edits so we can reprocess the message when text changes
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at VARCHAR(30);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS previous_text TEXT;

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      operator VARCHAR(100),
      closed_by VARCHAR(100),           -- who posted the F: message
      supplement_name VARCHAR(200),
      batch_number VARCHAR(50),
      description TEXT,
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      active_duration_seconds INTEGER,  -- duration minus pauses
      status VARCHAR(20) DEFAULT 'open', -- 'open'|'closed'|'abandoned'
      urgency_tier INTEGER DEFAULT 0,   -- 0-3
      slack_start_ts VARCHAR(30),
      slack_end_ts VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS closed_by VARCHAR(100);
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(50) DEFAULT 'producao';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS helpers TEXT;

    CREATE TABLE IF NOT EXISTS production_counts (
      id SERIAL PRIMARY KEY,
      supplement_name VARCHAR(200),
      batch_number VARCHAR(50),
      count INTEGER,
      operator VARCHAR(100),
      reported_at TIMESTAMPTZ,
      slack_ts VARCHAR(30),
      task_id INTEGER REFERENCES tasks(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pauses (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id),
      operator VARCHAR(100),          -- denormalized for quick lookup when task_id is null
      reason VARCHAR(200),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      slack_ts VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE pauses ADD COLUMN IF NOT EXISTS operator VARCHAR(100);
    -- N3: tag why a pause was closed (manual return, auto-cleanup, etc)
    ALTER TABLE pauses ADD COLUMN IF NOT EXISTS ended_reason VARCHAR(50);
    CREATE INDEX IF NOT EXISTS idx_pauses_ended_at ON pauses(ended_at) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS operators (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      slack_user_id VARCHAR(20),
      is_shared_account BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Entrega 2: operators get aliases (e.g. 'Aninha,Bru') and role
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS aliases TEXT DEFAULT '';
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS role VARCHAR(50);
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS supplements (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) UNIQUE NOT NULL,
      canonical_name VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS eod_snapshots (
      id SERIAL PRIMARY KEY,
      snapshot_date DATE UNIQUE NOT NULL,
      screenshot_path VARCHAR(500),
      summary_text TEXT,
      total_bottles INTEGER,
      task_count INTEGER,
      slack_message_ts VARCHAR(30),
      data_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS urgency_notifications (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES tasks(id),
      tier INTEGER NOT NULL,
      slack_ts VARCHAR(30),
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS formulation_sessions (
      id SERIAL PRIMARY KEY,
      operator VARCHAR(100),
      supplement_name VARCHAR(200),
      batch_number VARCHAR(50),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      status VARCHAR(20) DEFAULT 'open',
      slack_start_ts VARCHAR(30),
      slack_end_ts VARCHAR(30),
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_formulation_started_at ON formulation_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_formulation_status ON formulation_sessions(status);

    CREATE TABLE IF NOT EXISTS orders_sessions (
      id SERIAL PRIMARY KEY,
      operator VARCHAR(100),
      order_count INTEGER,
      batch_label VARCHAR(20) DEFAULT 'morning', -- 'morning' | 'afternoon'
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      status VARCHAR(20) DEFAULT 'open',        -- 'open' | 'closed'
      slack_start_ts VARCHAR(30),
      slack_end_ts VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_orders_started_at ON orders_sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders_sessions(status);
    ALTER TABLE orders_sessions ADD COLUMN IF NOT EXISTS helpers TEXT;

    -- Custom supplement catalog (admin-managed, extends the hardcoded parser list)
    CREATE TABLE IF NOT EXISTS supplement_catalog (
      id SERIAL PRIMARY KEY,
      canonical_name VARCHAR(200) UNIQUE NOT NULL,
      aliases TEXT DEFAULT '',          -- comma-separated alias list
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Entrega 2: every admin write goes through auditAction() and lands here.
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_user VARCHAR(100),
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(100),
      before_data JSONB,
      after_data JSONB,
      source VARCHAR(50) DEFAULT 'api',
      request_meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
      ON admin_audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity
      ON admin_audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action
      ON admin_audit_log(action);

    -- Entrega 2: learned synonyms from task merges. Next time alias_term shows
    -- up in a message, the engine knows it maps to canonical_term.
    CREATE TABLE IF NOT EXISTS task_aliases (
      id SERIAL PRIMARY KEY,
      canonical_term VARCHAR(200) NOT NULL,
      alias_term VARCHAR(200) NOT NULL,
      learned_from_task_id INTEGER,
      learned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (canonical_term, alias_term)
    );
    CREATE INDEX IF NOT EXISTS idx_task_aliases_alias
      ON task_aliases(LOWER(alias_term));

    -- Entrega 2: soft-delete columns. Tasks already use status='deleted'
    -- via the existing status VARCHAR. Other tables get an explicit
    -- deleted_at TIMESTAMPTZ. NULL = active.
    ALTER TABLE pauses              ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE orders_sessions     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE production_counts   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE formulation_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_pauses_active ON pauses(deleted_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_active ON orders_sessions(deleted_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_counts_active ON production_counts(deleted_at) WHERE deleted_at IS NULL;

    -- Default operators
    INSERT INTO operators (name, slack_user_id, is_shared_account) VALUES
      ('Ana', NULL, FALSE),
      ('Bruno', 'U03URLL1D4L', FALSE),
      ('Vitor', 'U08JC85HMNE', FALSE),
      ('Simone', 'U07FG34TMPF', FALSE)
    ON CONFLICT (name) DO NOTHING;

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_slack_ts ON messages(slack_ts);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_supplement ON tasks(supplement_name);
    CREATE INDEX IF NOT EXISTS idx_tasks_started_at ON tasks(started_at);
    CREATE INDEX IF NOT EXISTS idx_production_supplement ON production_counts(supplement_name);
  `;

  await pool.query(sql);
  console.log('[DB] Migration complete');
}

/**
 * N3: one-shot cleanup of stale breaks that were never closed.
 *
 * Production smoke test found pauses with started_at from previous days still
 * open (Ana at 8h53m, Vitor much older). Auto-close them at started_at + 1h
 * so totals and dashboards stop showing impossible break durations.
 *
 * Idempotent: only fires on pauses whose started_at (in America/New_York) is
 * BEFORE today's ET date. After the cleanup runs, those rows have ended_at
 * != NULL and won't match the WHERE on the next boot.
 *
 * Same-day open breaks (legitimate) are not touched.
 */
async function cleanupStaleBreaks() {
  try {
    const result = await pool.query(`
      UPDATE pauses
      SET ended_at = started_at + INTERVAL '1 hour',
          ended_reason = 'auto_cleanup_stale'
      WHERE ended_at IS NULL
        AND (started_at AT TIME ZONE 'America/New_York')::date
            < (NOW() AT TIME ZONE 'America/New_York')::date
      RETURNING id, operator, started_at
    `);
    if (result.rows.length > 0) {
      console.log(
        `[DB] N3 cleanup: closed ${result.rows.length} stale break(s) ` +
        `(ended_reason=auto_cleanup_stale): ` +
        result.rows.map((r) => `#${r.id}/${r.operator || '?'}`).join(', ')
      );
    } else {
      console.log('[DB] N3 cleanup: no stale breaks to close');
    }
    return result.rows;
  } catch (err) {
    console.error('[DB] N3 cleanup error:', err.message);
    return [];
  }
}

module.exports = { query, pool, migrate, cleanupStaleBreaks };
