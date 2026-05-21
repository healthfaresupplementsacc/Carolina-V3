'use strict';
/**
 * HEALTHFARE V3 — Sprint 1 / FASE 1 / PARTE 1.3
 * Migração de dados: consolida o legado no schema V3.
 *
 * As 17 tabelas V3 vivem no schema Postgres `v3` (princípio #24).
 * Toda conexão roda `SET search_path = v3, public` no connect:
 *   - escritas V3 são schema-qualificadas (v3.*) p/ clareza
 *   - leituras legadas ficam sem prefixo (caem em public)
 *
 * Substeps:
 *   3a  supplements + supplement_catalog → v3.products  (consolida)
 *   3b  v3.persons  (7 rows da spec autoritativa ITEM 1; operators
 *       usado SÓ p/ cross-check de slack_user_id)
 *   3c  v3.shared_accounts (3) + v3.shared_account_users (12)
 *   3d  v3.activity_types seed (18 rows)
 *   3e  v3.settings seed (16 chaves)
 *   3f  assert tabelas de learning vazias
 *
 * MODOS:
 *   (default / --dry-run)  lê o legado, calcula o plano, imprime
 *                          relatório + ICs/Vs hipotéticos. ZERO escrita.
 *   --apply                executa 3a-3f em transação única (client
 *                          dedicado). ICs/Vs DENTRO da tx — qualquer
 *                          IC falho → ROLLBACK. Exige ADMIN_CONFIRMED=TRUE.
 *                          One-shot (recusa se v3.persons já populada).
 *   --drop-legacy-supplements
 *                          dropa public.supplement_catalog + public.supplements.
 *                          Exige ADMIN_CONFIRMED=TRUE + v3.products já
 *                          populada (≥13). Invocação SEPARADA, só após
 *                          PAUSA (b) liberada pelo Bruno.
 *
 * Pré-req do --apply: 001_v3_initial.sql já rodou (schema v3 + 17 tabelas).
 *
 *   railway run ... node scripts/v3-migrate-data.js                       # dry-run
 *   ADMIN_CONFIRMED=TRUE railway run ... node scripts/v3-migrate-data.js --apply
 *   ADMIN_CONFIRMED=TRUE railway run ... node scripts/v3-migrate-data.js --drop-legacy-supplements
 */
const { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────
// SEED DATA (spec autoritativa ITEM 1 — confirmada pelo Bruno)
// ─────────────────────────────────────────────────────────────

const PERSONS_SEED = [
  { display_name: 'Bruno Camp',     role: 'owner',    slack_user_id: null,          slack_dm_id: 'D03UL80GDRB' },
  { display_name: 'Thassio',        role: 'owner',    slack_user_id: null,          slack_dm_id: 'D03V1RNLSKT' },
  { display_name: 'Henrique',       role: 'manager',  slack_user_id: null,          slack_dm_id: 'D085DLHDRCK' },
  { display_name: 'Vitor',          role: 'operator', slack_user_id: 'U08JC85HMNE', slack_dm_id: 'D09FRA004LW' },
  { display_name: 'Simone',         role: 'operator', slack_user_id: 'U07FG34TMPF', slack_dm_id: 'D09FRA0SR8E' },
  { display_name: 'Ana',            role: 'operator', slack_user_id: null,          slack_dm_id: null },
  { display_name: 'Bruno Sarmento', role: 'operator', slack_user_id: null,          slack_dm_id: null },
];

// 3 contas compartilhadas. primary_owner = display_name OU null.
const SHARED_ACCOUNTS_SEED = [
  { slack_user_id: 'U08JC85HMNE', slack_dm_id: 'D09FRA004LW', primary_owner: 'Vitor',  description: "Vitor's account" },
  { slack_user_id: 'U07FG34TMPF', slack_dm_id: 'D09FRA0SR8E', primary_owner: 'Simone', description: "Simone's account" },
  { slack_user_id: 'U0AU8N8FA00', slack_dm_id: 'D0B5YDY3S8G', primary_owner: null,     description: 'Production Line' },
];

// Os 4 operators entram em CADA conta (3 contas × 4 = 12 rows).
// Admins (owner/manager) NUNCA entram — regra confirmada pelo Bruno.
// identifies_as: SÓ o nome (e variante de caixa). Iniciais soltas
// ('S','V') foram REMOVIDAS — colidiam com os marcadores "S:"/"F:"
// (start/finish) e causavam falso-positivo (msg do Vitor virava Simone).
// Princípio #23: identifica pelo NOME, não por inicial hardcoded.
const SHARED_USERS_SEED = [
  { person: 'Ana',            identifies_as: ['Ana', 'ana'] },
  { person: 'Bruno Sarmento', identifies_as: ['Bruno', 'Sarmento', 'bruno'] },
  { person: 'Vitor',          identifies_as: ['Vitor', 'vitor'] },
  { person: 'Simone',         identifies_as: ['Simone', 'simone'] },
];

// 3d — 18 activity_types (Sprint 1 §1.3.3d)
const ACTIVITY_TYPES_SEED = [
  { slug: 'formulation',     display_name: 'Formulação',        category: 'production_phase', requires_product: true,  emoji: '🧪', color: '#6366f1' },
  { slug: 'mixing',          display_name: 'Mix',               category: 'production_phase', requires_product: true,  emoji: '🥣', color: '#8b5cf6' },
  { slug: 'encapsulation',   display_name: 'Encapsulação',      category: 'production_phase', requires_product: true,  emoji: '💊', color: '#a855f7' },
  { slug: 'review',          display_name: 'Revisão',           category: 'production_phase', requires_product: true,  emoji: '🔍', color: '#ec4899' },
  { slug: 'production_line', display_name: 'Linha de Produção', category: 'production_phase', requires_product: true,  emoji: '🏭', color: '#06b6d4' },
  { slug: 'counting',        display_name: 'Contagem',          category: 'production_phase', requires_product: true,  emoji: '📦', color: '#10b981' },
  { slug: 'packaging',       display_name: 'Empacotamento',     category: 'production_phase', requires_product: true,  emoji: '📦', color: '#14b8a6' },
  { slug: 'labeling',        display_name: 'Etiquetagem',       category: 'production_phase', requires_product: true,  emoji: '🏷', color: '#f59e0b' },
  { slug: 'shipping',        display_name: 'Envio',             category: 'production_phase', requires_product: true,  emoji: '🚚', color: '#ef4444' },
  { slug: 'cleaning',        display_name: 'Limpeza',           category: 'support',          requires_product: false, emoji: '🧹', color: '#64748b' },
  { slug: 'repair',          display_name: 'Conserto',          category: 'support',          requires_product: false, emoji: '🔧', color: '#475569' },
  { slug: 'organization',    display_name: 'Organização',       category: 'support',          requires_product: false, emoji: '📋', color: '#6b7280' },
  { slug: 'training',        display_name: 'Treinamento',       category: 'support',          requires_product: false, emoji: '📚', color: '#0891b2' },
  { slug: 'meeting',         display_name: 'Reunião',           category: 'support',          requires_product: false, emoji: '💬', color: '#7c3aed' },
  { slug: 'orders',          display_name: 'Ordens (P&P)',      category: 'support',          requires_product: false, emoji: '📋', color: '#f97316' },
  { slug: 'break',           display_name: 'Pausa',             category: 'meta',             requires_product: false, emoji: '☕', color: '#94a3b8' },
  { slug: 'lunch',           display_name: 'Almoço',            category: 'meta',             requires_product: false, emoji: '🍽', color: '#94a3b8' },
  { slug: 'end_of_day',      display_name: 'Fim de Expediente', category: 'meta',             requires_product: false, emoji: '🌙', color: '#1e293b' },
];

// 3e — 16 settings (Sprint 1 §1.3.3e)
const SETTINGS_SEED = [
  { key: 'operational_window', value: { start_hour: 8, end_hour: 19, weekdays: [1, 2, 3, 4, 5], timezone: 'America/New_York' }, description: 'Janela operacional ET' },
  { key: 'llm_observer_active',         value: true,        description: 'Observer ligado' },
  { key: 'llm_observer_mode',           value: 'shadow',    description: 'shadow no Sprint 1 — não reage/posta/DM' },
  { key: 'llm_admin_assistant_active',  value: false,       description: 'Admin Assistant — ativado no Sprint 2' },
  { key: 'llm_provider',                value: 'anthropic', description: 'Provider LLM default' },
  { key: 'llm_model',                   value: 'claude-sonnet-4-6', description: 'Modelo do Observer' },
  { key: 'silent_mode',                 value: false,       description: 'Kill switch de emergência' },
  { key: 'confidence_post_threshold',   value: 'medium',    description: 'Confiança mínima p/ agir sem admin' },
  { key: 'admin_notify_channel',        value: 'C0B36DR5MP1', description: 'Canal admin' },
  { key: 'production_channel',          value: 'C09UNBXFRKK', description: 'Canal de produção do time' },
  { key: 'admin_assistant_label',       value: 'Carolina', description: 'Nome cosmético do Admin Assistant' },
  { key: 'system_display_name',         value: 'HealthFare Production', description: 'Nome do sistema pro time' },
  { key: 'stale_check_interval_minutes', value: 15,         description: 'Intervalo do stale worker (Sprint 2)' },
  { key: 'stale_check_threshold_hours',  value: 2,          description: 'Idade p/ event virar stale' },
  { key: 'stale_check_max_questions',    value: 3,          description: 'Máx perguntas antes de auto-close' },
  { key: 'eod_count_window_hours',       value: 2,          description: 'Janela p/ casar EOD count com batch' },
];

// nomes (sem schema) das 17 tabelas V3 e das de learning
const LEARNING_TABLES = ['llm_corrections', 'vocabulary', 'person_language_profile'];
const V3_TABLES = [
  'persons', 'shared_accounts', 'shared_account_users', 'activity_types',
  'products', 'product_batches', 'events', 'production_counts', 'messages',
  'prefix_resolution_log', 'admin_chats', 'proposals', 'audit_log',
  'llm_corrections', 'vocabulary', 'person_language_profile', 'settings',
];

// ─────────────────────────────────────────────────────────────
// 3a — planner puro (testável sem DB)
// ─────────────────────────────────────────────────────────────

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/** Converte texto vírgula-separado em array limpo. */
function parseAliases(text) {
  if (!text) return [];
  return String(text).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Consolida supplements + supplement_catalog em products.
 * Funde por canonical_name normalizado. Reporta consolidações.
 * @returns {{products:Array, consolidated:Array}}
 */
function planSupplements(supplementRows, catalogRows) {
  const byKey = new Map(); // norm(canonical) -> {canonical_name, aliases:Set, sources:[]}
  function add(canonical, aliases, source) {
    const key = norm(canonical);
    if (!key) return;
    let p = byKey.get(key);
    if (!p) { p = { canonical_name: canonical, aliases: new Set(), sources: [] }; byKey.set(key, p); }
    for (const a of aliases) { if (a && norm(a) !== key) p.aliases.add(a); }
    p.sources.push(source);
  }
  for (const r of supplementRows) {
    const canonical = r.canonical_name || r.name;
    const extra = (r.name && norm(r.name) !== norm(canonical)) ? [r.name] : [];
    add(canonical, extra, 'supplements#' + r.id);
  }
  for (const r of catalogRows) {
    add(r.canonical_name, parseAliases(r.aliases), 'supplement_catalog#' + r.id);
  }
  const products = [];
  const consolidated = [];
  for (const p of byKey.values()) {
    products.push({ canonical_name: p.canonical_name, aliases: [...p.aliases] });
    if (p.sources.length > 1) {
      consolidated.push({ canonical_name: p.canonical_name, sources: p.sources });
    }
  }
  products.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));
  return { products, consolidated };
}

// ─────────────────────────────────────────────────────────────
// helpers DB
// ─────────────────────────────────────────────────────────────

/** Cria o Pool e garante search_path = v3, public em toda conexão. */
function makePool() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on('connect', (client) => { client.query('SET search_path = v3, public'); });
  return pool;
}

/** @param qualified ex.: 'v3.persons' ou 'public.supplements' */
async function tableExists(db, qualified) {
  const r = await db.query('SELECT to_regclass($1) AS reg', [qualified]);
  return r.rows[0].reg != null;
}
async function count(db, sql, params = []) {
  const r = await db.query(sql, params);
  return parseInt(r.rows[0].c, 10);
}
async function audit(db, action, after) {
  await db.query(
    `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, after_data)
     VALUES ('system', NULL, $1, 'v3_migration', $2::jsonb)`,
    [action, JSON.stringify(after || {})]);
}

// ─────────────────────────────────────────────────────────────
// DRY-RUN — calcula o plano, zero escrita
// ─────────────────────────────────────────────────────────────

async function dryRun(db) {
  const out = { mode: 'dry-run', steps: {}, ic: {}, v: {}, warnings: [] };

  // 3a — leituras legadas (public, sem prefixo)
  const sup = (await db.query('SELECT id, name, canonical_name FROM supplements')).rows;
  const cat = (await db.query('SELECT id, canonical_name, aliases FROM supplement_catalog')).rows;
  const plan = planSupplements(sup, cat);
  out.steps['3a'] = {
    supplements_in: sup.length, supplement_catalog_in: cat.length,
    products_out: plan.products.length,
    consolidated: plan.consolidated,
    products: plan.products,
  };

  // 3b — cross-check operators (legado) p/ os slack_user_id da spec
  for (const p of PERSONS_SEED.filter((x) => x.slack_user_id)) {
    const r = await db.query('SELECT id, name FROM operators WHERE slack_user_id = $1', [p.slack_user_id]);
    if (!r.rows.length) {
      out.warnings.push(`cross-check: slack_user_id ${p.slack_user_id} (${p.display_name}) não achado em operators`);
    } else if (norm(r.rows[0].name) !== norm(p.display_name) &&
               norm(r.rows[0].name).indexOf(norm(p.display_name)) !== 0) {
      out.warnings.push(`cross-check: ${p.slack_user_id} → operators.name="${r.rows[0].name}" vs spec "${p.display_name}"`);
    }
  }
  out.steps['3b'] = { persons_out: PERSONS_SEED.length, persons: PERSONS_SEED };
  out.steps['3c'] = {
    shared_accounts_out: SHARED_ACCOUNTS_SEED.length,
    shared_account_users_out: SHARED_ACCOUNTS_SEED.length * SHARED_USERS_SEED.length,
  };
  out.steps['3d'] = { activity_types_out: ACTIVITY_TYPES_SEED.length };
  out.steps['3e'] = { settings_out: SETTINGS_SEED.length };

  // 3f — learning tables v3.*: se existirem, têm que estar vazias
  out.steps['3f'] = {};
  for (const t of LEARNING_TABLES) {
    out.steps['3f'][t] = (await tableExists(db, 'v3.' + t))
      ? await count(db, `SELECT COUNT(*) c FROM v3.${t}`)
      : 'tabela ainda não existe';
  }

  // ICs / Vs HIPOTÉTICOS (do que SERIA criado)
  const owners = PERSONS_SEED.filter((p) => p.role === 'owner').length;
  const managers = PERSONS_SEED.filter((p) => p.role === 'manager').length;
  const operators = PERSONS_SEED.filter((p) => p.role === 'operator').length;
  const slackNull = PERSONS_SEED.filter((p) => !p.slack_user_id).length;
  out.ic = {
    'IC-1 owner/manager em shared_account_users (esp. 0)': 0,
    'IC-2 persons test/Bia (esp. 0)': PERSONS_SEED.filter((p) => /test|adminvalidate|bia/i.test(p.display_name)).length,
    'IC-3 products (esp. >=13)': plan.products.length,
    'IC-4 activity_types (esp. 18)': ACTIVITY_TYPES_SEED.length,
  };
  // IC-5 — counts legados REAIS (public, sem prefixo)
  out.ic['IC-5a supplement_catalog (esp. 1)'] = await count(db, 'SELECT COUNT(*) c FROM supplement_catalog');
  out.ic['IC-5b supplements (esp. 13)'] = await count(db, 'SELECT COUNT(*) c FROM supplements');
  out.v = {
    'V-1 persons active (esp. 7)': PERSONS_SEED.length,
    'V-2 persons owner (esp. 2)': owners,
    'V-3 persons manager (esp. 1)': managers,
    'V-4 persons operator (esp. 4)': operators,
    'V-5 shared_accounts (esp. 3)': SHARED_ACCOUNTS_SEED.length,
    'V-6 shared_account_users (esp. 12)': SHARED_ACCOUNTS_SEED.length * SHARED_USERS_SEED.length,
    'V-7 shared_accounts primary_owner NULL (esp. 1)': SHARED_ACCOUNTS_SEED.filter((s) => !s.primary_owner).length,
    'V-8 persons slack_user_id NULL (esp. 5)': slackNull,
  };
  return out;
}

// ─────────────────────────────────────────────────────────────
// APPLY — executa 3a-3f em transação (client dedicado)
// ─────────────────────────────────────────────────────────────

async function apply(pool) {
  const db = await pool.connect();
  try {
    // pré-requisitos
    for (const t of V3_TABLES) {
      if (!(await tableExists(db, 'v3.' + t))) {
        throw new Error(`tabela 'v3.${t}' não existe — rode 001_v3_initial.sql primeiro.`);
      }
    }
    if (await count(db, 'SELECT COUNT(*) c FROM v3.persons') > 0) {
      throw new Error('v3.persons já tem linhas — migração é one-shot. Restaure do backup antes de re-rodar.');
    }

    const sup = (await db.query('SELECT id, name, canonical_name FROM supplements')).rows;
    const cat = (await db.query('SELECT id, canonical_name, aliases FROM supplement_catalog')).rows;
    const plan = planSupplements(sup, cat);

    const done = { products: 0, persons: 0, shared_accounts: 0, shared_account_users: 0, activity_types: 0, settings: 0 };

    await db.query('BEGIN');
    try {
      // 3a — v3.products
      for (const p of plan.products) {
        await db.query('INSERT INTO v3.products (canonical_name, aliases) VALUES ($1, $2::text[])',
          [p.canonical_name, p.aliases]);
        done.products++;
      }
      await audit(db, 'v3_migration.3a_products', { count: done.products, consolidated: plan.consolidated });

      // 3b — v3.persons (id por display_name p/ resolver FKs)
      const personId = {};
      for (const p of PERSONS_SEED) {
        const r = await db.query(
          `INSERT INTO v3.persons (display_name, role, slack_user_id, slack_dm_id, active)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [p.display_name, p.role, p.slack_user_id, p.slack_dm_id]);
        personId[p.display_name] = r.rows[0].id;
        done.persons++;
      }
      await audit(db, 'v3_migration.3b_persons', { count: done.persons });

      // 3c — v3.shared_accounts + v3.shared_account_users
      for (const s of SHARED_ACCOUNTS_SEED) {
        await db.query(
          `INSERT INTO v3.shared_accounts (slack_user_id, primary_owner_id, slack_dm_id, description)
           VALUES ($1, $2, $3, $4)`,
          [s.slack_user_id, s.primary_owner ? personId[s.primary_owner] : null, s.slack_dm_id, s.description]);
        done.shared_accounts++;
        for (const u of SHARED_USERS_SEED) {
          await db.query(
            `INSERT INTO v3.shared_account_users (shared_account_id, person_id, identifies_as)
             VALUES ($1, $2, $3::text[])`,
            [s.slack_user_id, personId[u.person], u.identifies_as]);
          done.shared_account_users++;
        }
      }
      await audit(db, 'v3_migration.3c_shared_accounts',
        { shared_accounts: done.shared_accounts, shared_account_users: done.shared_account_users });

      // 3d — v3.activity_types
      for (const a of ACTIVITY_TYPES_SEED) {
        await db.query(
          `INSERT INTO v3.activity_types (slug, display_name, category, requires_product, emoji, color)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [a.slug, a.display_name, a.category, a.requires_product, a.emoji, a.color]);
        done.activity_types++;
      }
      await audit(db, 'v3_migration.3d_activity_types', { count: done.activity_types });

      // 3e — v3.settings
      for (const s of SETTINGS_SEED) {
        await db.query(
          'INSERT INTO v3.settings (key, value, description) VALUES ($1, $2::jsonb, $3)',
          [s.key, JSON.stringify(s.value), s.description]);
        done.settings++;
      }
      await audit(db, 'v3_migration.3e_settings', { count: done.settings });

      // 3f — learning tables têm que estar vazias
      for (const t of LEARNING_TABLES) {
        const c = await count(db, `SELECT COUNT(*) c FROM v3.${t}`);
        if (c !== 0) throw new Error(`3f: v3.${t} deveria estar vazia, achei ${c} linhas`);
      }

      // ICs / Vs REAIS dentro da tx
      const ic = {
        'IC-1': await count(db,
          `SELECT COUNT(*) c FROM v3.shared_account_users sau
           JOIN v3.persons p ON p.id = sau.person_id WHERE p.role IN ('owner','manager')`),
        'IC-2': await count(db,
          `SELECT COUNT(*) c FROM v3.persons
           WHERE display_name ILIKE '%test%' OR display_name ILIKE 'adminvalidate%'
              OR display_name ILIKE '%Bia%'`),
        'IC-3': await count(db, 'SELECT COUNT(*) c FROM v3.products'),
        'IC-4': await count(db, 'SELECT COUNT(*) c FROM v3.activity_types'),
      };
      const v = {
        'V-1': await count(db, 'SELECT COUNT(*) c FROM v3.persons WHERE active = true'),
        'V-2': await count(db, "SELECT COUNT(*) c FROM v3.persons WHERE role = 'owner'"),
        'V-3': await count(db, "SELECT COUNT(*) c FROM v3.persons WHERE role = 'manager'"),
        'V-4': await count(db, "SELECT COUNT(*) c FROM v3.persons WHERE role = 'operator'"),
        'V-5': await count(db, 'SELECT COUNT(*) c FROM v3.shared_accounts'),
        'V-6': await count(db, 'SELECT COUNT(*) c FROM v3.shared_account_users'),
        'V-7': await count(db, 'SELECT COUNT(*) c FROM v3.shared_accounts WHERE primary_owner_id IS NULL'),
        'V-8': await count(db, 'SELECT COUNT(*) c FROM v3.persons WHERE slack_user_id IS NULL'),
      };
      const fails = [];
      if (ic['IC-1'] !== 0) fails.push(`IC-1 esperado 0, deu ${ic['IC-1']}`);
      if (ic['IC-2'] !== 0) fails.push(`IC-2 esperado 0, deu ${ic['IC-2']}`);
      if (ic['IC-3'] < 13)  fails.push(`IC-3 esperado >=13, deu ${ic['IC-3']}`);
      if (ic['IC-4'] !== 18) fails.push(`IC-4 esperado 18, deu ${ic['IC-4']}`);
      const vExp = { 'V-1': 7, 'V-2': 2, 'V-3': 1, 'V-4': 4, 'V-5': 3, 'V-6': 12, 'V-7': 1, 'V-8': 5 };
      for (const k of Object.keys(vExp)) {
        if (v[k] !== vExp[k]) fails.push(`${k} esperado ${vExp[k]}, deu ${v[k]}`);
      }

      if (fails.length) {
        await db.query('ROLLBACK');
        return { mode: 'apply', ok: false, rolledBack: true, fails, done, ic, v };
      }
      await audit(db, 'v3_migration.complete', { done, ic, v });
      await db.query('COMMIT');
      return { mode: 'apply', ok: true, done, ic, v, consolidated: plan.consolidated };
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  } finally {
    db.release();
  }
}

// ─────────────────────────────────────────────────────────────
// DROP LEGACY — public.supplement_catalog + public.supplements (PAUSA b)
// ─────────────────────────────────────────────────────────────

async function dropLegacySupplements(pool) {
  const db = await pool.connect();
  try {
    const products = await count(db, 'SELECT COUNT(*) c FROM v3.products');
    if (products < 13) {
      throw new Error(`recusado: v3.products tem ${products} linhas (<13) — consolidação 3a precisa estar aplicada antes do DROP.`);
    }
    await db.query('BEGIN');
    try {
      await db.query('DROP TABLE IF EXISTS public.supplement_catalog');
      await db.query('DROP TABLE IF EXISTS public.supplements');
      await audit(db, 'v3_migration.drop_legacy_supplements',
        { dropped: ['public.supplement_catalog', 'public.supplements'], products_at_drop: products });
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; }
    return { dropped: ['public.supplement_catalog', 'public.supplements'], products_at_drop: products };
  } finally {
    db.release();
  }
}

module.exports = {
  PERSONS_SEED, SHARED_ACCOUNTS_SEED, SHARED_USERS_SEED,
  ACTIVITY_TYPES_SEED, SETTINGS_SEED, LEARNING_TABLES, V3_TABLES,
  parseAliases, planSupplements, makePool, dryRun, apply, dropLegacySupplements,
};

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = argv.includes('--apply') ? 'apply'
    : argv.includes('--drop-legacy-supplements') ? 'drop' : 'dry-run';

  (async () => {
    const pool = makePool();
    try {
      if (mode === 'dry-run') {
        const r = await dryRun(pool);
        console.log('==== V3 MIGRATE-DATA — DRY-RUN ====\n');
        for (const [k, val] of Object.entries(r.steps['3a'])) {
          if (k === 'products') { console.log(`3a.products (${val.length}):`); val.forEach((p) => console.log(`     ${p.canonical_name}  aliases=[${p.aliases.join(', ')}]`)); }
          else if (k === 'consolidated') { console.log(`3a.consolidated (${val.length}):`); val.forEach((c) => console.log(`     ${c.canonical_name} ← ${c.sources.join(' + ')}`)); }
          else console.log(`3a.${k}: ${val}`);
        }
        console.log(`\n3b.persons_out: ${r.steps['3b'].persons_out}`);
        r.steps['3b'].persons.forEach((p) => console.log(`     ${p.display_name}  ${p.role}  slack=${p.slack_user_id || 'NULL'}  dm=${p.slack_dm_id || 'NULL'}`));
        console.log(`\n3c: shared_accounts=${r.steps['3c'].shared_accounts_out}  shared_account_users=${r.steps['3c'].shared_account_users_out}`);
        console.log(`3d: activity_types=${r.steps['3d'].activity_types_out}`);
        console.log(`3e: settings=${r.steps['3e'].settings_out}`);
        console.log(`3f: ${JSON.stringify(r.steps['3f'])}`);
        console.log('\n-- ICs (hipotéticos / IC-5 real) --');
        for (const [k, val] of Object.entries(r.ic)) console.log(`   ${k}: ${val}`);
        console.log('\n-- Vs (hipotéticos) --');
        for (const [k, val] of Object.entries(r.v)) console.log(`   ${k}: ${val}`);
        if (r.warnings.length) { console.log('\n-- WARNINGS --'); r.warnings.forEach((w) => console.log('   ! ' + w)); }
        else console.log('\n-- WARNINGS: nenhum --');
        console.log('\nDRY-RUN — nada escrito. ADMIN_CONFIRMED=TRUE + --apply após PAUSA (d).');
      } else if (mode === 'apply') {
        if (process.env.ADMIN_CONFIRMED !== 'TRUE') {
          console.error('RECUSADO: --apply exige ADMIN_CONFIRMED=TRUE.'); process.exitCode = 2; return;
        }
        const r = await apply(pool);
        if (!r.ok) {
          console.error('==== APPLY FALHOU — ROLLBACK ====');
          r.fails.forEach((f) => console.error('  ✗ ' + f));
          console.error('Nada foi commitado. Investigue antes de re-rodar.');
          process.exitCode = 1; return;
        }
        console.log('==== V3 MIGRATE-DATA — APPLY OK ====');
        console.log('inserido:', JSON.stringify(r.done));
        console.log('ICs:', JSON.stringify(r.ic));
        console.log('Vs:', JSON.stringify(r.v));
        if (r.consolidated.length) console.log('consolidados:', JSON.stringify(r.consolidated));
        console.log('\npublic.supplement_catalog/supplements NÃO foram dropados (PAUSA b — invocação separada).');
      } else {
        if (process.env.ADMIN_CONFIRMED !== 'TRUE') {
          console.error('RECUSADO: --drop-legacy-supplements exige ADMIN_CONFIRMED=TRUE.'); process.exitCode = 2; return;
        }
        const r = await dropLegacySupplements(pool);
        console.log('==== DROP LEGACY SUPPLEMENTS OK ====');
        console.log(JSON.stringify(r));
      }
    } catch (e) {
      console.error('FATAL:', e.message); process.exitCode = 1;
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}
