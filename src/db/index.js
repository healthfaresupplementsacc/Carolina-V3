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
    -- Entrega 2: notes can be admin-edited and linked to a task
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS linked_task_id INTEGER;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

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
    -- OPERATOR-CRUD — full employee management (permanent + temporary
    -- helpers). DECISION: the legacy active column stays the canonical
    -- activation flag (App Home, operator-panel and many reads use it);
    -- is_active is added per spec and kept ALWAYS equal to active
    -- (backfilled here; every write path sets BOTH in the same UPDATE so
    -- they can never drift). Migration preserves existing data: everyone
    -- active, permanent, hired_at = created_at.
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS is_temporary BOOLEAN DEFAULT FALSE;
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS hired_at TIMESTAMPTZ DEFAULT NOW();
    UPDATE operators SET is_active = active
      WHERE is_active IS DISTINCT FROM active;
    UPDATE operators SET is_temporary = FALSE WHERE is_temporary IS NULL;
    UPDATE operators SET hired_at = COALESCE(hired_at, created_at, NOW())
      WHERE hired_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_operators_expiry
      ON operators (expires_at) WHERE is_temporary = TRUE AND is_active = TRUE;

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
    -- BUG DETECT — detect.js supplementsPending() queried
    -- supplement_catalog.admin_approved, a column that never existed
    -- (every boot logged "column admin_approved does not exist").
    -- DECISION: ADD the column (DEFAULT TRUE) rather than delete the
    -- query — presence in the catalog already meant "approved"
    -- (EXEC.approve_supplement just touches the row), so DEFAULT TRUE
    -- makes supplementsPending return 0 (the correct prior intent) and
    -- leaves a real approval flag available for the future. The
    -- decision is recorded in admin_audit_log (idempotent) below.
    ALTER TABLE supplement_catalog
      ADD COLUMN IF NOT EXISTS admin_approved BOOLEAN DEFAULT TRUE;
    -- (the decision is recorded in admin_audit_log once that table is
    -- created — see the BUG DETECT decision-audit block further down.)

    -- URGENT kill switch: when silent_mode is on, Carolina silently drops
    -- every outbound message to the production channel and records what she
    -- would have posted in silent_log. Admin chat (manager channel) is NOT
    -- affected — only the worker-facing channel goes mute.
    CREATE TABLE IF NOT EXISTS silent_log (
      id SERIAL PRIMARY KEY,
      intended_channel VARCHAR(20),
      intended_action VARCHAR(50),
      intended_text TEXT,
      would_have_replied_to_ts VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_silent_log_created_at ON silent_log(created_at DESC);
    -- Partial silent mode: distinguish text-class actions from reaction-class
    -- so admin can keep ✅ reactions on while muting text.
    ALTER TABLE silent_log ADD COLUMN IF NOT EXISTS kind VARCHAR(20);

    -- Seed silent_mode flag (master) + sub-flags so isSilent() finds rows immediately.
    INSERT INTO app_state (key, value, updated_at)
      VALUES ('silent_mode', 'false', NOW())
      ON CONFLICT (key) DO NOTHING;
    INSERT INTO app_state (key, value, updated_at)
      VALUES ('silent_text', 'false', NOW())
      ON CONFLICT (key) DO NOTHING;
    INSERT INTO app_state (key, value, updated_at)
      VALUES ('silent_reactions', 'false', NOW())
      ON CONFLICT (key) DO NOTHING;

    -- ─── Entrega 3: ISA-88 style data model ────────────────────────────
    -- workflow_templates: top-level kinds of work the admin defines.
    -- Seeded with 3 templates (Produção de Suplemento, Picking & Packing,
    -- Envio FBA/Walmart/Tiktok/Ebay) — admin can CRUD freely afterwards.
    CREATE TABLE IF NOT EXISTS workflow_templates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      allows_product BOOLEAN DEFAULT FALSE, -- true when product_id is required/expected
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_templates_active
      ON workflow_templates(is_active);

    -- phase_templates: ordered fases inside a workflow_template.
    -- prerequisite_phase_ids is a jsonb array of phase_template ids. When
    -- prerequisite_mode='all', every listed phase must be closed before
    -- this one is allowed (with soft_prereq, it only alerts admin instead
    -- of blocking). When mode='any', AT LEAST ONE of the listed phases
    -- must be closed (used for Encapsulação/Tablet → Revisão).
    CREATE TABLE IF NOT EXISTS phase_templates (
      id SERIAL PRIMARY KEY,
      workflow_template_id INTEGER REFERENCES workflow_templates(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      sequence_order INTEGER NOT NULL DEFAULT 0,
      is_required BOOLEAN DEFAULT TRUE,
      can_run_parallel BOOLEAN DEFAULT FALSE,
      parallel_group VARCHAR(40), -- string tag; phases with same tag may run together
      prerequisite_phase_ids JSONB DEFAULT '[]'::jsonb,
      prerequisite_mode VARCHAR(10) DEFAULT 'all', -- 'all' | 'any'
      soft_prereq BOOLEAN DEFAULT TRUE,           -- true = alert admin instead of blocking
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_phase_templates_workflow
      ON phase_templates(workflow_template_id, sequence_order);

    -- workflow_instances: a real batch / session of one workflow_template.
    -- product_id references supplements when allows_product=true; null
    -- otherwise (Picking sessions, Envio sessions). batch_number is
    -- optional (Princípio E — operator may add it later; any change
    -- generates an audit row + admin alert via the engine).
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id SERIAL PRIMARY KEY,
      workflow_template_id INTEGER REFERENCES workflow_templates(id),
      product_id INTEGER REFERENCES supplements(id),
      product_name VARCHAR(200), -- denormalized for fast display
      batch_number VARCHAR(50),
      batch_change_approved BOOLEAN DEFAULT TRUE, -- false = pending admin review (Princípio E)
      destination VARCHAR(40),  -- 'FBA' | 'Walmart' | 'Tiktok' | 'Ebay' | null
      pass_number INTEGER,      -- 1st/2nd/3rd Picking print (null otherwise)
      status VARCHAR(20) DEFAULT 'active', -- 'active' | 'closed' | 'cancelled' | 'deleted'
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      started_by_operator_id INTEGER REFERENCES operators(id),
      notes TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      -- legacy bridge — preserves the row this instance came from
      legacy_table VARCHAR(40),
      legacy_id    INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_status
      ON workflow_instances(status) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_template
      ON workflow_instances(workflow_template_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_product
      ON workflow_instances(product_id) WHERE product_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_batch
      ON workflow_instances(batch_number) WHERE batch_number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_legacy
      ON workflow_instances(legacy_table, legacy_id) WHERE legacy_id IS NOT NULL;

    -- phase_instances: a single phase running (or finished) inside a
    -- workflow_instance. final_bottle_count is filled only by terminal
    -- phases like Linha de Produção or Contagem.
    CREATE TABLE IF NOT EXISTS phase_instances (
      id SERIAL PRIMARY KEY,
      workflow_instance_id INTEGER REFERENCES workflow_instances(id) ON DELETE CASCADE,
      phase_template_id INTEGER REFERENCES phase_templates(id),
      phase_name VARCHAR(120), -- denormalized
      batch_number VARCHAR(50), -- can be added/changed later (Princípio E)
      batch_change_approved BOOLEAN DEFAULT TRUE,
      status VARCHAR(20) DEFAULT 'open', -- 'open' | 'closed' | 'cancelled' | 'deleted'
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      started_by_operator_id INTEGER REFERENCES operators(id),
      closed_by_operator_id INTEGER REFERENCES operators(id),
      final_bottle_count INTEGER,
      notes TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      legacy_table VARCHAR(40),
      legacy_id    INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_phase_instances_workflow
      ON phase_instances(workflow_instance_id, status);
    CREATE INDEX IF NOT EXISTS idx_phase_instances_active
      ON phase_instances(status) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_phase_instances_template
      ON phase_instances(phase_template_id);
    CREATE INDEX IF NOT EXISTS idx_phase_instances_legacy
      ON phase_instances(legacy_table, legacy_id) WHERE legacy_id IS NOT NULL;

    -- ad_hoc_tasks: catalog of free-standing activities (cleaning, training,
    -- meetings, "Reporte no sistema", etc) that aren't part of any
    -- production workflow. Seeded with 8 (commit 1.5) but admin can CRUD.
    -- admin_approved=false means an operator started a new ad-hoc task
    -- that wasn't in the catalog — admin reviews and approves/merges.
    CREATE TABLE IF NOT EXISTS ad_hoc_tasks (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      admin_approved BOOLEAN DEFAULT FALSE,
      created_by_operator_id INTEGER REFERENCES operators(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ad_hoc_tasks_active
      ON ad_hoc_tasks(is_active);
    CREATE INDEX IF NOT EXISTS idx_ad_hoc_tasks_pending
      ON ad_hoc_tasks(admin_approved) WHERE admin_approved = FALSE;

    -- ad_hoc_task_instances: one row per occurrence of an ad-hoc task.
    -- linked_workflow_instance_id is set when the engine inferred a
    -- workflow link (e.g. "Reporte no sistema" matched FO-NNNN to a
    -- Contagem phase of a real batch — Princípio: fallback duplo).
    CREATE TABLE IF NOT EXISTS ad_hoc_task_instances (
      id SERIAL PRIMARY KEY,
      ad_hoc_task_id INTEGER REFERENCES ad_hoc_tasks(id),
      task_name VARCHAR(120), -- denormalized for fast display
      status VARCHAR(20) DEFAULT 'open', -- 'open' | 'closed' | 'cancelled' | 'deleted'
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      started_by_operator_id INTEGER REFERENCES operators(id),
      closed_by_operator_id INTEGER REFERENCES operators(id),
      linked_workflow_instance_id INTEGER REFERENCES workflow_instances(id),
      linked_phase_instance_id INTEGER REFERENCES phase_instances(id),
      notes TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      legacy_table VARCHAR(40),
      legacy_id    INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_adhoc_instances_active
      ON ad_hoc_task_instances(status) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_adhoc_instances_task
      ON ad_hoc_task_instances(ad_hoc_task_id);
    CREATE INDEX IF NOT EXISTS idx_adhoc_instances_legacy
      ON ad_hoc_task_instances(legacy_table, legacy_id) WHERE legacy_id IS NOT NULL;

    -- ─── operator_activity_log: HEART of Entrega 3 ────────────────────
    -- One row per stretch of time an operator was doing something. When
    -- the operator switches activities, the engine closes the current
    -- row (ended_at=NOW) and opens a new one. Invariant: each
    -- operator_id has at most ONE row with ended_at=NULL at any moment.
    --
    -- activity_type discriminates the FK that matters:
    --   'phase'   → phase_instance_id (regular production phase)
    --   'ad_hoc'  → ad_hoc_task_instance_id (cleaning, training, etc)
    --   'break'   → pause_id (lunch, banheiro)
    --   'idle'    → all FKs null (operator clocked in but not working)
    --
    -- left_for_id + came_back_from_id form a linked pair when the
    -- operator paused this activity to help in another one and then
    -- returned. left_for_id points to the new (helper) log row; the
    -- helper row's came_back_from_id points back here. This lets the
    -- Home tab show "Ana saiu de Linha de Produção pra ajudar Vitor na
    -- Revisão" with a one-query lookup.
    CREATE TABLE IF NOT EXISTS operator_activity_log (
      id SERIAL PRIMARY KEY,
      operator_id INTEGER REFERENCES operators(id) NOT NULL,
      activity_type VARCHAR(20) NOT NULL, -- phase|ad_hoc|break|idle
      phase_instance_id      INTEGER REFERENCES phase_instances(id),
      ad_hoc_task_instance_id INTEGER REFERENCES ad_hoc_task_instances(id),
      pause_id               INTEGER REFERENCES pauses(id),
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER, -- denormalized on close for fast aggregation
      role VARCHAR(20),  -- 'starter' | 'joiner' | 'closer' | null
      left_for_id INTEGER REFERENCES operator_activity_log(id),
      came_back_from_id INTEGER REFERENCES operator_activity_log(id),
      notes TEXT,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT operator_activity_log_type_check CHECK (
        activity_type IN ('phase','ad_hoc','break','idle')
      )
    );
    CREATE INDEX IF NOT EXISTS idx_oal_active
      ON operator_activity_log(operator_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_oal_operator_started
      ON operator_activity_log(operator_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_oal_phase
      ON operator_activity_log(phase_instance_id) WHERE phase_instance_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_oal_adhoc
      ON operator_activity_log(ad_hoc_task_instance_id) WHERE ad_hoc_task_instance_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_oal_started
      ON operator_activity_log(started_at);

    -- W4: workflow/phase templates created via "Outro" are usable
    -- immediately (non-blocking) but flagged pending_review for admin
    -- to approve / merge / rename.
    ALTER TABLE workflow_templates ADD COLUMN IF NOT EXISTS pending_review BOOLEAN DEFAULT FALSE;
    ALTER TABLE phase_templates    ADD COLUMN IF NOT EXISTS pending_review BOOLEAN DEFAULT FALSE;

    -- A3: admin-only internal notes per instance. NEVER exposed to the
    -- team / timeline / Slack — only the PIN-gated admin endpoint reads
    -- them. The dashboard union query must never SELECT these columns.
    ALTER TABLE workflow_instances    ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    ALTER TABLE phase_instances       ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    ALTER TABLE ad_hoc_task_instances ADD COLUMN IF NOT EXISTS admin_notes TEXT;

    -- F2: notes written via App Home (or admin) live here. Channel-typed
    -- notes still live in messages(parsed_type='note'); getTodayNotes
    -- unions both. linked_* auto-filled from the author's active activity.
    CREATE TABLE IF NOT EXISTS operator_notes (
      id SERIAL PRIMARY KEY,
      operator_id INTEGER REFERENCES operators(id),
      text TEXT NOT NULL,
      linked_phase_instance_id INTEGER REFERENCES phase_instances(id),
      linked_workflow_instance_id INTEGER REFERENCES workflow_instances(id),
      source VARCHAR(20) DEFAULT 'app_home', -- 'app_home' | 'channel' | 'admin'
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_operator_notes_created
      ON operator_notes(created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_operator_notes_operator
      ON operator_notes(operator_id);

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

    -- BUG DETECT decision audit (idempotent): record WHY we added
    -- supplement_catalog.admin_approved instead of deleting the
    -- detect.js query. Runs here, after admin_audit_log exists.
    INSERT INTO admin_audit_log (admin_user, action, entity_type, entity_id, after_data, source)
    SELECT 'system', 'schema.decision', 'supplement_catalog', 'admin_approved',
           '{"bug":"DETECT","decision":"ADD COLUMN admin_approved BOOLEAN DEFAULT TRUE","reason":"detect.js supplementsPending referenced a missing column; catalog presence already == approved, so DEFAULT TRUE keeps pending=0 and stops the boot error"}'::jsonb,
           'migration'
    WHERE NOT EXISTS (
      SELECT 1 FROM admin_audit_log
      WHERE action = 'schema.decision' AND entity_id = 'admin_approved'
    );

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

    -- BUG IDENTIDADE — team hierarchy. role ∈ {'owner','manager',
    -- 'operator'} (app-validated; column already exists). Owners
    -- (Bruno Camp, Thassio) and the manager (Henrique) give orders
    -- Carolina obeys without extra confirmation. Bruno Camp is the
    -- existing U03URLL1D4L row (avoids a duplicate slack id).
    UPDATE operators SET role = 'owner', updated_at = NOW()
      WHERE slack_user_id = 'U03URLL1D4L';
    INSERT INTO operators (name, slack_user_id, is_shared_account, role) VALUES
      ('Thassio',           'U03S46L2EUA', FALSE, 'owner'),
      ('Henrique Monteiro', 'U085SDY3F4Z', FALSE, 'manager')
    ON CONFLICT (name) DO UPDATE
      SET slack_user_id = EXCLUDED.slack_user_id,
          role = EXCLUDED.role, updated_at = NOW();
    UPDATE operators SET role = 'operator', updated_at = NOW()
      WHERE role IS NULL OR btrim(role) = '';

    -- BLOCO C / P4: Carolina autonomous proposals (multi-row, expiring)
    CREATE TABLE IF NOT EXISTS carolina_proposals (
      id SERIAL PRIMARY KEY,
      proposal_type TEXT NOT NULL,
      target_entity_type TEXT,
      target_entity_id TEXT,
      proposed_action JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_carolina_proposals_status ON carolina_proposals(status);

    -- BLOCO B / C5: editable message variations (seeded from code defaults)
    CREATE TABLE IF NOT EXISTS message_variations (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      template TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_var_type ON message_variations(type);

    -- BUG DUP BREAK: at most ONE open break per operator (master doc
    -- §9.1). Close stale duplicate open pauses keeping the earliest,
    -- then enforce with a partial unique index. Idempotent.
    UPDATE pauses SET ended_at = started_at, ended_reason = 'auto_dedup'
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY operator ORDER BY started_at ASC, id ASC) AS rn
        FROM pauses WHERE ended_at IS NULL AND operator IS NOT NULL
      ) d WHERE d.rn > 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_pause_per_operator
      ON pauses (operator) WHERE ended_at IS NULL AND operator IS NOT NULL;

    -- ─── FASE 1: canonical dispatcher idempotency index ────────────────
    -- Maps a source_id (slack_ts | wizard_event_id | tool_call_id) to the
    -- single row it produced. The canonical dispatcher upserts here so a
    -- Slack edit / reprocess UPDATES that row instead of spawning a new
    -- one (resolves L-06). target_id is TEXT so it can point at any
    -- table's PK without a type coupling.
    CREATE TABLE IF NOT EXISTS dispatcher_index (
      source_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      target_table TEXT NOT NULL,
      target_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dispatcher_index_target
      ON dispatcher_index(target_table, target_id);
    CREATE INDEX IF NOT EXISTS idx_dispatcher_index_source_type
      ON dispatcher_index(source_type);

    -- ─── FASE 1 P6: pending operator disambiguation ────────────────────
    -- An operator-required event whose operator_id resolved to NULL is
    -- AMBIGUOUS. It is NOT silently dropped: the full EventoCanônico is
    -- parked here (operator unknown) so (a) the dashboard can show a
    -- "🔶 SEM DONO" card and (b) when the admin answers in the admin
    -- chat, the stored event is re-dispatched WITH the operator and the
    -- real ISA-88 row is finally created. Idempotent by source_id.
    CREATE TABLE IF NOT EXISTS pending_disambiguation (
      source_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      event JSONB NOT NULL,
      question_text TEXT,
      account_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'resolved' | 'dismissed'
      resolved_operator_id INTEGER REFERENCES operators(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_pending_disambig_status
      ON pending_disambiguation(status) WHERE status = 'pending';

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

// L2 — admin_audit_log TTL. Rows older than 15 days are deleted EXCEPT
// permanent actions (legal/structural history we never want to lose).
// Idempotent; safe to run every boot + daily.
const AUDIT_PERMANENT_ACTIONS = [
  'legacy_cleanup',
  'workflow_template.delete',
  'phase_template.delete',
  'operator.deactivate',
  'supplement.delete',
  'task.merge',
  'phase_instance.merge',
  'workflow_instance.merge',
  'mass_delete',
  'cutover_legacy_off',
];

async function cleanupAuditLog() {
  try {
    const res = await pool.query(
      `DELETE FROM admin_audit_log
       WHERE created_at < NOW() - INTERVAL '15 days'
         AND action <> ALL($1::text[])
       RETURNING id`,
      [AUDIT_PERMANENT_ACTIONS]
    );
    console.log(`[DB] Audit TTL: deleted ${res.rows.length} rows (15+ days, non-permanent)`);
    return res.rows.length;
  } catch (err) {
    console.error('[DB] Audit TTL error:', err.message);
    return 0;
  }
}

module.exports = {
  query, pool, migrate, cleanupStaleBreaks, cleanupAuditLog,
  AUDIT_PERMANENT_ACTIONS,
};
