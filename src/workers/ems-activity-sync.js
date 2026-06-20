'use strict';
/**
 * HEALTHFARE V3 — FASE 2: EMS activity sync.
 *
 * Puxa /line (máquinas rodando) + /pipeline (batches por stage) do EMS e faz
 * UPSERT em v3.ems_activity_cache. O dashboard lê DAQUI (1 sistema só, alimentado
 * pelo EMS). Detecta started (in_use_since) e ended (sumiu do EMS → completed +
 * duration). Mapeia o operador do EMS pro person do tracker por nome. EMS down =
 * no-op (não quebra nada — REGRA #0).
 */
const STAGE_TO_PROCESS = {
  weighing: 'formulation', weighed: 'formulation', blending: 'mixing', blended: 'mixing',
  encapsulating: 'encapsulation', encapsulated: 'encapsulation',
  yield_review: 'production_line', to_count: 'production_line', to_separate: 'revision',
  label_printing: 'production_line', finalized: 'production_line', pending: 'pending',
};
const MACHINE_TO_PROCESS = { blender: 'mixing', capsule_machine: 'encapsulation', tablet_machine: 'encapsulation', scale: 'formulation' };

// auto check-in: stage EMS → slug de atividade do tracker
const EMS_STAGE_TO_SLUG = {
  weighing: 'weighing', weighed: 'weighing', blending: 'mixing', blended: 'mixing',
  encapsulating: 'encapsulation', encapsulated: 'encapsulation',
  yield_review: 'production_line', to_count: 'production_line', label_printing: 'production_line',
  finalized: 'production_line', on_line: 'production_line', ready_for_line: 'production_line', to_separate: 'review',
};
// slugs que o check-out automático pode FECHAR sozinho (sem contagem obrigatória).
// NUNCA fecha production_line/P&P automaticamente (perderia bottles/ordens).
const SAFE_AUTOCLOSE = new Set(['encapsulation', 'mixing', 'weighing', 'review', 'separating', 'material_handling']);
// stage → chave do timeline (started_at/completed_at). weighing usa formulation (doc EMS).
const STAGE_TO_TIMELINE = {
  weighing: 'formulation', weighed: 'formulation', blending: 'blending', blended: 'blending',
  encapsulating: 'encapsulating', encapsulated: 'encapsulating',
  yield_review: 'production', to_count: 'production', to_separate: 'production', label_printing: 'production', finalized: 'production',
};
function timelineAt(timeline, stage, which) {
  if (!timeline) return null;
  const k = STAGE_TO_TIMELINE[stage]; const t = k && timeline[k];
  return (t && t[which]) || null;
}

// EMS: pending_queue é array; formulation/production_line são objetos-de-arrays
// por sub-stage. Normaliza ambos numa lista; herda a chave do sub-stage como
// status quando o batch não traz status próprio.
function flattenStage(node) {
  if (Array.isArray(node)) return node.slice();
  if (node && typeof node === 'object') {
    const out = [];
    for (const sub of Object.keys(node)) {
      const arr = node[sub];
      if (Array.isArray(arr)) for (const b of arr) {
        if (b && typeof b === 'object') out.push(b.status ? b : Object.assign({}, b, { status: sub }));
      }
    }
    return out;
  }
  return [];
}

class EmsActivitySync {
  constructor(deps = {}) {
    this.db = deps.db;
    this.ems = deps.ems;
    this._timer = null;
    this._ticking = false;
    // auto check-in: cria task automática quando um STAGE inicia. Gate por env +
    // só dispara em início RECENTE (timeline.started_at ou in_use_since), nunca
    // back-fill de assignment velho. Kill-switch: EMS_AUTO_CHECKIN_ENABLED.
    this.autoCheckin = deps.autoCheckin !== undefined ? deps.autoCheckin : (process.env.EMS_AUTO_CHECKIN_ENABLED === 'true');
    this.checkinWindowMin = deps.checkinWindowMin || parseInt(process.env.EMS_AUTO_CHECKIN_WINDOW_MIN, 10) || 20;
  }
  start(intervalMs = 45000) {
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[ems-sync] tick erro:', e.message)), intervalMs);
    console.log('[V3] ems-activity-sync ligado (tick ' + Math.round(intervalMs / 1000) + 's)');
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  // ── extração pura (testável): line + pipeline → lista de atividades ──
  extract(line, pipeline) {
    const out = [];
    const eq = (line && Array.isArray(line.equipment)) ? line.equipment : [];
    eq.forEach((m) => {
      if (!m.running || !m.current_batch) return;
      const cb = m.current_batch;
      // início real: timeline do stage (quando EMS publicar) → senão in_use_since (máquina).
      const stageStart = timelineAt(cb.timeline, cb.status, 'started_at') || m.in_use_since || null;
      out.push({
        ems_key: m.id + ':' + cb.id,
        process_type: STAGE_TO_PROCESS[cb.status] || MACHINE_TO_PROCESS[m.equipment_type] || 'other',
        stage: cb.status || null,
        machine: m.name || null, machine_type: m.equipment_type || null,
        supplement_name: (cb.product && cb.product.name) || (cb.formula && cb.formula.name) || null,
        batch_number: cb.batch_record_number || null,
        formula_code: cb.formula && cb.formula.formula_code || null,
        employee_ems_name: (m.operator && m.operator.name) || (cb.operator && cb.operator.name) || null,
        ems_user_id: (m.operator && m.operator.user_id) || (cb.operator && cb.operator.user_id) || null,
        target_bottles: cb.target_qty_bottles != null ? cb.target_qty_bottles : null,
        actual_bottles: cb.actual_yield_bottles != null ? cb.actual_yield_bottles : null,
        product_image: cb.product && cb.product.image_url || null,
        started_at: stageStart, stage_started_at: stageStart,
        raw: { equipment: m.name, batch: cb },
      });
    });
    const groups = ['formulation', 'production_line'];
    if (pipeline) groups.forEach((g) => {
      // EMS entrega formulation/production_line como OBJETO-por-stage
      // ({yield_review:[...], encapsulating:[...]}), não array plana — flatten
      // (mesma dívida do /lots/available). Sem isso, o path batch-operador
      // ficava morto e o cache só pegava máquinas.
      flattenStage(pipeline[g]).forEach((b) => {
        if (!b.operator || !b.operator.name) return; // só batches COM alguém trabalhando
        // stage_started_at = SÓ o timeline real (created_at NÃO é início de stage —
        // sem timeline fica null → auto check-in de stage não dispara, evita
        // back-fill de assignment velho). started_at do cache mantém created_at p/ display.
        const stageStart = timelineAt(b.timeline, b.status, 'started_at');
        out.push({
          ems_key: b.id + ':' + (b.status || g),
          process_type: STAGE_TO_PROCESS[b.status] || g,
          stage: b.status || null, machine: null, machine_type: null,
          supplement_name: (b.product && b.product.name) || (b.formula && b.formula.name) || null,
          batch_number: b.batch_record_number || null,
          formula_code: b.formula && b.formula.formula_code || null,
          employee_ems_name: b.operator.name,
          ems_user_id: (b.operator && b.operator.user_id) || null,
          target_bottles: b.target_qty_bottles != null ? b.target_qty_bottles : null,
          actual_bottles: b.actual_yield_bottles != null ? b.actual_yield_bottles : null,
          product_image: b.product && b.product.image_url || null,
          started_at: stageStart || b.created_at || null, stage_started_at: stageStart,
          raw: { batch: b },
        });
      });
    });
    return out;
  }

  async _resolvePersonId(name, emsUserId) {
    // UUID (ems_user_id) primeiro — robusto (estudo: nome é frágil). Nome é fallback.
    if (emsUserId) {
      try { const u = await this.db.query('SELECT id FROM v3.persons WHERE ems_user_id = $1 AND deleted_at IS NULL LIMIT 1', [emsUserId]); if (u.rows[0]) return u.rows[0].id; } catch (e) {}
    }
    if (!name) return null;
    const r = await this.db.query('SELECT id, display_name, ems_user_id FROM v3.persons WHERE active = true AND deleted_at IS NULL');
    const lc = String(name).toLowerCase();
    let hit = r.rows.find((p) => p.display_name.toLowerCase() === lc);
    if (!hit) hit = r.rows.find((p) => lc.indexOf(p.display_name.toLowerCase()) >= 0 || p.display_name.toLowerCase().indexOf(lc) >= 0);
    if (!hit) { // match por primeiro nome SE único
      const first = lc.split(/\s+/)[0];
      const matches = r.rows.filter((p) => p.display_name.toLowerCase().split(/\s+/)[0] === first);
      if (matches.length === 1) hit = matches[0];
    }
    // backfill: casou por nome e ainda não tem UUID → grava (próximas vezes casa por UUID)
    if (hit && emsUserId && !hit.ems_user_id) {
      try { await this.db.query('UPDATE v3.persons SET ems_user_id = $1 WHERE id = $2 AND ems_user_id IS NULL', [emsUserId, hit.id]); } catch (e) {}
    }
    return hit ? hit.id : null;
  }

  async _sync(activities) {
    const tickStart = new Date();
    for (const a of activities) {
      const pid = await this._resolvePersonId(a.employee_ems_name, a.ems_user_id);
      a.tracker_person_id = pid; // anexa p/ o auto check-in
      await this.db.query(
        `INSERT INTO v3.ems_activity_cache
           (ems_key, process_type, stage, machine, machine_type, supplement_name, batch_number,
            formula_code, employee_ems_name, tracker_person_id, target_bottles, actual_bottles,
            product_image, started_at, raw_json, sync_status, last_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15::jsonb,'active',NOW())
         ON CONFLICT (ems_key) DO UPDATE SET
           stage = EXCLUDED.stage, actual_bottles = EXCLUDED.actual_bottles,
           employee_ems_name = EXCLUDED.employee_ems_name, tracker_person_id = EXCLUDED.tracker_person_id,
           supplement_name = EXCLUDED.supplement_name, raw_json = EXCLUDED.raw_json,
           sync_status = 'active', ended_at = NULL, duration_seconds = NULL, last_synced_at = NOW()`,
        [a.ems_key, a.process_type, a.stage, a.machine, a.machine_type, a.supplement_name, a.batch_number,
          a.formula_code, a.employee_ems_name, pid, a.target_bottles, a.actual_bottles,
          a.product_image, a.started_at, JSON.stringify(a.raw || {})]);
    }
    // ativas que NÃO vieram nesse tick → completaram (saíram do stage no EMS).
    // RETURNING dados pra FECHAR a task: a auto-criada (ems_auto) E a do /op que
    // ficou "presa" (operador moveu de stage e não finalizou — bug do ev1040).
    const done = await this.db.query(
      `UPDATE v3.ems_activity_cache
       SET sync_status = 'completed', ended_at = NOW(),
           duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
       WHERE sync_status = 'active' AND last_synced_at < $1::timestamptz
       RETURNING auto_event_id, tracker_person_id, batch_number, stage`, [tickStart]);
    for (const row of done.rows) {
      try {
        if (row.auto_event_id) {
          await this.db.query(
            `UPDATE v3.events SET ended_at = NOW(), closed_reason = 'ems_auto_complete', updated_at = NOW()
             WHERE id = $1 AND ended_at IS NULL AND source = 'ems_auto'`, [row.auto_event_id]);
        }
        // check-OUT do /op: o stage saiu do EMS → fecha a task ABERTA correspondente
        // (mesma pessoa+lote+slug). SÓ slugs SEM contagem obrigatória (não fecha
        // production_line/P&P sem o número — perderia bottles/ordens). Gated.
        if (this.autoCheckin && row.tracker_person_id && row.batch_number) {
          const slug = EMS_STAGE_TO_SLUG[row.stage];
          if (slug && SAFE_AUTOCLOSE.has(slug)) {
            await this.db.query(
              `UPDATE v3.events SET ended_at = NOW(), closed_reason = 'ems_stage_completed', updated_at = NOW()
               WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND source IN ('operator_page','ems_auto')
                 AND activity_type_id IN (SELECT id FROM v3.activity_types WHERE slug = $2)
                 AND product_batch_id IN (SELECT id FROM v3.product_batches WHERE batch_number = $3 OR batch_number = 'BR-2026-' || $3)`,
              [row.tracker_person_id, slug, row.batch_number]);
          }
        }
      } catch (e) { console.error('[ems-sync] check-out falhou:', e.message); }
    }
    await this._autoCheckin(activities); // check-in automático dos inícios recentes
    return activities.length;
  }

  // FASE auto check-in: cria uma task automática quando um STAGE INICIOU recentemente
  // pra um operador MAPEADO e que não tem event aberto pro lote. Só início recente
  // (timeline/in_use_since dentro da janela) — nunca back-fill de assignment velho.
  // resolve product_id LOCAL por nome do EMS (canonical + aliases, normalizado).
  async _resolveProductId(name) {
    if (!name) return null;
    try {
      const r = await this.db.query('SELECT id, canonical_name, aliases FROM v3.products WHERE active = true');
      const norm = (sx) => String(sx || '').toLowerCase().replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|iu|ml|ct|count|caps?|capsules?|softgels?|tablets?|servings?)\b/g, '').replace(/[^a-z0-9]+/g, '');
      const t = norm(name); if (!t) return null;
      let hit = r.rows.find((p) => norm(p.canonical_name) === t);
      if (!hit) hit = r.rows.find((p) => [p.canonical_name].concat(p.aliases || []).some((a) => norm(a) === t));
      if (!hit) hit = r.rows.find((p) => { const n = norm(p.canonical_name); return n && t.length >= 5 && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0); });
      return hit ? hit.id : null;
    } catch (e) { return null; }
  }
  async _autoCheckin(activities) {
    if (!this.autoCheckin) return 0;
    const windowMs = this.checkinWindowMin * 60000;
    let created = 0;
    for (const a of activities) {
      try {
        if (!a.tracker_person_id || !a.stage_started_at) continue; // só mapeado + início real
        const startMs = Date.parse(a.stage_started_at);
        if (!Number.isFinite(startMs) || (Date.now() - startMs) > windowMs) continue; // só RECENTE
        const slug = EMS_STAGE_TO_SLUG[a.stage]; if (!slug) continue;
        const cur = await this.db.query('SELECT auto_event_id FROM v3.ems_activity_cache WHERE ems_key = $1', [a.ems_key]);
        if (cur.rows[0] && cur.rows[0].auto_event_id) continue; // já criou pra essa atividade
        let batchId = null;
        if (a.batch_number) {
          const b = await this.db.query("SELECT id FROM v3.product_batches WHERE batch_number = $1 OR batch_number = 'BR-2026-' || $1 ORDER BY id DESC LIMIT 1", [a.batch_number]);
          if (b.rows[0]) batchId = b.rows[0].id;
          else { // product_batches.product_id é NOT NULL → só cria lote se resolver o produto (por nome do EMS)
            const prodId = await this._resolveProductId(a.supplement_name);
            if (prodId) { try { const ins = await this.db.query("INSERT INTO v3.product_batches (product_id, batch_number, started_at, status, origin, created_via) VALUES ($1, $2, NOW(), 'in_progress', 'ems_auto', 'ems_sync') RETURNING id", [prodId, a.batch_number]); batchId = ins.rows[0].id; } catch (e) {} }
          }
          // já tem event aberto pro person+batch (/op, slack, etc)? → NÃO duplica
          if (batchId) {
            const open = await this.db.query('SELECT 1 FROM v3.events WHERE person_id = $1 AND ended_at IS NULL AND deleted_at IS NULL AND product_batch_id = $2 LIMIT 1', [a.tracker_person_id, batchId]);
            if (open.rowCount) continue;
          }
        }
        const act = await this.db.query('SELECT id, is_background FROM v3.activity_types WHERE slug = $1 AND active = true LIMIT 1', [slug]);
        if (!act.rows[0]) continue;
        const ins = await this.db.query(
          `INSERT INTO v3.events (person_id, activity_type_id, product_batch_id, started_at, description, confidence, source, is_long_running)
           VALUES ($1, $2, $3, $4::timestamptz, $5, 'high', 'ems_auto', $6) RETURNING id`,
          [a.tracker_person_id, act.rows[0].id, batchId, a.stage_started_at, '[check-in automático EMS: ' + (a.machine || a.stage || '?') + ']', !!act.rows[0].is_background]);
        const evId = ins.rows[0].id;
        await this.db.query('UPDATE v3.ems_activity_cache SET auto_event_id = $1 WHERE ems_key = $2', [evId, a.ems_key]);
        try { await this.db.query("INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata) VALUES ('system', NULL, 'event.ems_auto_checkin', 'event', $1, $2::jsonb)", [evId, JSON.stringify({ ems_key: a.ems_key, slug, batch: a.batch_number, person_id: a.tracker_person_id, machine: a.machine })]); } catch (e) {}
        created++;
      } catch (e) { console.error('[ems-sync] auto check-in falhou:', e.message); }
    }
    if (created) console.log('[ems-sync] auto check-in criou ' + created + ' task(s)');
    return created;
  }

  async tick() {
    if (this._ticking) return { skipped: true };
    this._ticking = true;
    try {
      if (!this.ems || !this.ems.configured || !this.ems.configured()) return { ems: false };
      const [line, pipeline] = await Promise.all([
        this.ems.line().catch((e) => { console.error('[ems-sync] /line:', e.message); return null; }),
        this.ems.pipeline().catch((e) => { console.error('[ems-sync] /pipeline:', e.message); return null; }),
      ]);
      if (!line && !pipeline) return { ems: false }; // EMS down → no-op
      const acts = this.extract(line, pipeline);
      const n = await this._sync(acts);
      return { synced: n };
    } finally { this._ticking = false; }
  }
}
module.exports = { EmsActivitySync, STAGE_TO_PROCESS, flattenStage };
