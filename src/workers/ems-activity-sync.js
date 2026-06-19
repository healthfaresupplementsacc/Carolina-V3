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

class EmsActivitySync {
  constructor(deps = {}) {
    this.db = deps.db;
    this.ems = deps.ems;
    this._timer = null;
    this._ticking = false;
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
      out.push({
        ems_key: m.id + ':' + cb.id,
        process_type: STAGE_TO_PROCESS[cb.status] || MACHINE_TO_PROCESS[m.equipment_type] || 'other',
        stage: cb.status || null,
        machine: m.name || null, machine_type: m.equipment_type || null,
        supplement_name: (cb.product && cb.product.name) || (cb.formula && cb.formula.name) || null,
        batch_number: cb.batch_record_number || null,
        formula_code: cb.formula && cb.formula.formula_code || null,
        employee_ems_name: (m.operator && m.operator.name) || (cb.operator && cb.operator.name) || null,
        target_bottles: cb.target_qty_bottles != null ? cb.target_qty_bottles : null,
        actual_bottles: cb.actual_yield_bottles != null ? cb.actual_yield_bottles : null,
        product_image: cb.product && cb.product.image_url || null,
        started_at: m.in_use_since || null,
        raw: { equipment: m.name, batch: cb },
      });
    });
    const groups = ['formulation', 'production_line'];
    if (pipeline) groups.forEach((g) => {
      (Array.isArray(pipeline[g]) ? pipeline[g] : []).forEach((b) => {
        if (!b.operator || !b.operator.name) return; // só batches COM alguém trabalhando
        out.push({
          ems_key: b.id + ':' + (b.status || g),
          process_type: STAGE_TO_PROCESS[b.status] || g,
          stage: b.status || null, machine: null, machine_type: null,
          supplement_name: (b.product && b.product.name) || (b.formula && b.formula.name) || null,
          batch_number: b.batch_record_number || null,
          formula_code: b.formula && b.formula.formula_code || null,
          employee_ems_name: b.operator.name,
          target_bottles: b.target_qty_bottles != null ? b.target_qty_bottles : null,
          actual_bottles: b.actual_yield_bottles != null ? b.actual_yield_bottles : null,
          product_image: b.product && b.product.image_url || null,
          started_at: b.created_at || null,
          raw: { batch: b },
        });
      });
    });
    return out;
  }

  async _resolvePersonId(name) {
    if (!name) return null;
    const r = await this.db.query('SELECT id, display_name FROM v3.persons WHERE active = true AND deleted_at IS NULL');
    const lc = String(name).toLowerCase();
    let hit = r.rows.find((p) => p.display_name.toLowerCase() === lc);
    if (!hit) hit = r.rows.find((p) => lc.indexOf(p.display_name.toLowerCase()) >= 0 || p.display_name.toLowerCase().indexOf(lc) >= 0);
    if (!hit) { // match por primeiro nome SE único
      const first = lc.split(/\s+/)[0];
      const matches = r.rows.filter((p) => p.display_name.toLowerCase().split(/\s+/)[0] === first);
      if (matches.length === 1) hit = matches[0];
    }
    return hit ? hit.id : null;
  }

  async _sync(activities) {
    const tickStart = new Date();
    for (const a of activities) {
      const pid = await this._resolvePersonId(a.employee_ems_name);
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
    // ativas que NÃO vieram nesse tick → completaram: marca ended + duração
    await this.db.query(
      `UPDATE v3.ems_activity_cache
       SET sync_status = 'completed', ended_at = NOW(),
           duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)
       WHERE sync_status = 'active' AND last_synced_at < $1::timestamptz`, [tickStart]);
    return activities.length;
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
module.exports = { EmsActivitySync, STAGE_TO_PROCESS };
