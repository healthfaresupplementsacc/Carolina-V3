'use strict';
/**
 * Entrega 3 Fase 8.3 — end-to-end workflow scenario with a stateful
 * in-memory DB mock. Exercises a realistic day:
 *
 *   1. Vitor starts Formulação of Green Tea 0098 (new workflow_instance)
 *   2. Vitor finishes Formulação
 *   3. Bruno starts Encapsulação on the SAME batch (reuses instance)
 *   4. Ana joins Encapsulação (co-work — two oal rows on one phase)
 *   5. Ana takes a break
 *   6. Ana returns
 *   7. Bruno closes Encapsulação with 480 bottles
 *
 * Asserts the operator_activity_log invariant (≤1 open row per operator)
 * and that the phase close collects both participants.
 */

jest.mock('../db');
const db = require('../db');
const engine = require('../workflow/engine');

// ─── Minimal stateful store ─────────────────────────────────────────────
function makeStore() {
  return {
    seq: 1,
    wf: new Map(),     // id → row
    ph: new Map(),     // id → row
    oal: [],           // rows
    pauses: new Map(),
    phaseTemplates: {
      10: { id: 10, name: 'Formulação', prerequisite_phase_ids: [], prerequisite_mode: 'all', soft_prereq: true },
      12: { id: 12, name: 'Encapsulação', prerequisite_phase_ids: [10], prerequisite_mode: 'all', soft_prereq: true },
    },
    operators: { 1: 'Vitor', 2: 'Bruno', 3: 'Ana' },
  };
}

function wireDb(S) {
  db.query = jest.fn(async (sql, params = []) => {
    // ── phase template lookups ──
    if (/SELECT prerequisite_phase_ids/.test(sql)) {
      const t = S.phaseTemplates[params[0]];
      return { rows: t ? [t] : [] };
    }
    if (/SELECT name FROM phase_templates WHERE id = \$1/.test(sql)) {
      const t = S.phaseTemplates[params[0]];
      return { rows: t ? [{ name: t.name }] : [] };
    }
    if (/SELECT pt\.id, pt\.name[\s\S]+FROM phase_templates pt[\s\S]+JOIN phase_instances/.test(sql)) {
      // closed prereq phases for a workflow
      const [wfId, ids] = params;
      const closed = [...S.ph.values()].filter(
        (p) => p.workflow_instance_id === wfId && p.status === 'closed' && ids.includes(p.phase_template_id)
      );
      return { rows: closed.map((p) => ({ id: p.phase_template_id, name: S.phaseTemplates[p.phase_template_id].name })) };
    }
    if (/SELECT name FROM phase_templates WHERE id = ANY/.test(sql)) {
      return { rows: (params[0] || []).map((id) => ({ name: S.phaseTemplates[id]?.name })) };
    }

    // ── workflow_instances ──
    if (/SELECT id FROM workflow_instances WHERE/.test(sql)) {
      const match = [...S.wf.values()].find(
        (w) => w.product_name === (params[1]) && w.status === 'active'
      );
      return { rows: match ? [{ id: match.id }] : [] };
    }
    if (/INSERT INTO workflow_instances/.test(sql)) {
      const id = S.seq++;
      S.wf.set(id, { id, workflow_template_id: params[0], product_name: params[2], batch_number: params[3], status: 'active' });
      return { rows: [{ id }] };
    }

    // ── phase_instances ──
    if (/FROM phase_instances\s+WHERE workflow_instance_id = \$1 AND phase_template_id = \$2 AND status = 'open'/.test(sql)) {
      const m = [...S.ph.values()].find((p) => p.workflow_instance_id === params[0] && p.phase_template_id === params[1] && p.status === 'open');
      return { rows: m ? [{ id: m.id }] : [] };
    }
    if (/INSERT INTO phase_instances/.test(sql)) {
      const id = S.seq++;
      S.ph.set(id, { id, workflow_instance_id: params[0], phase_template_id: params[1], phase_name: params[2], status: 'open', started_at: params[4] || new Date().toISOString() });
      return { rows: [{ id }] };
    }
    if (/SELECT id, status, started_at, workflow_instance_id, phase_name\s+FROM phase_instances WHERE id/.test(sql)) {
      const p = S.ph.get(params[0]);
      return { rows: p ? [p] : [] };
    }
    if (/SELECT id, status FROM phase_instances WHERE id/.test(sql)) {
      const p = S.ph.get(params[0]);
      return { rows: p ? [{ id: p.id, status: p.status }] : [] };
    }
    if (/UPDATE phase_instances\s+SET status = 'closed'/.test(sql)) {
      const p = S.ph.get(params[3]); if (p) { p.status = 'closed'; p.final_bottle_count = params[2]; }
      return { rows: [] };
    }

    // ── operator_activity_log ──
    if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL\s+ORDER BY id DESC LIMIT 1/.test(sql)) {
      const open = S.oal.filter((r) => r.operator_id === params[0] && r.ended_at == null).slice(-1);
      return { rows: open.map((r) => ({ ...r })) };
    }
    if (/FROM operator_activity_log\s+WHERE operator_id = \$1 AND ended_at IS NULL AND activity_type = 'break'/.test(sql)) {
      const open = S.oal.filter((r) => r.operator_id === params[0] && r.ended_at == null && r.activity_type === 'break').slice(-1);
      return { rows: open.map((r) => ({ ...r })) };
    }
    if (/INSERT INTO operator_activity_log/.test(sql)) {
      const id = S.seq++;
      S.oal.push({ id, operator_id: params[0], activity_type: params[1],
        phase_instance_id: params[2], ad_hoc_task_instance_id: params[3], pause_id: params[4],
        started_at: params[5] || new Date().toISOString(), ended_at: null,
        role: params[6], came_back_from_id: params[7] });
      return { rows: [{ id }] };
    }
    if (/UPDATE operator_activity_log\s+SET ended_at = \$1[\s\S]+WHERE id = \$/.test(sql)) {
      const row = S.oal.find((r) => r.id === params[params.length - 1]);
      if (row) row.ended_at = params[0];
      return { rows: [] };
    }
    if (/UPDATE operator_activity_log\s+SET ended_at[\s\S]+WHERE phase_instance_id = \$2 AND ended_at IS NULL\s+RETURNING/.test(sql)) {
      const closed = S.oal.filter((r) => r.phase_instance_id === params[1] && r.ended_at == null);
      closed.forEach((r) => { r.ended_at = params[0]; });
      return { rows: closed.map((r) => ({ id: r.id, operator_id: r.operator_id })) };
    }
    if (/UPDATE operator_activity_log SET left_for_id/.test(sql)) {
      const row = S.oal.find((r) => r.id === params[1]); if (row) row.left_for_id = params[0];
      return { rows: [] };
    }
    if (/SELECT DISTINCT oal\.operator_id, o\.name/.test(sql)) {
      const ids = [...new Set(S.oal.filter((r) => r.phase_instance_id === params[0]).map((r) => r.operator_id))];
      return { rows: ids.map((i) => ({ operator_id: i, name: S.operators[i] })) };
    }

    // ── pauses ──
    if (/INSERT INTO pauses/.test(sql)) {
      const id = S.seq++; S.pauses.set(id, { id });
      return { rows: [{ id }] };
    }
    if (/UPDATE pauses SET ended_at/.test(sql)) return { rows: [] };

    return { rows: [] };
  });
}

function openCount(S, opId) {
  return S.oal.filter((r) => r.operator_id === opId && r.ended_at == null).length;
}

describe('Entrega 3 e2e — Green Tea batch lifecycle', () => {
  test('formulação → encapsulação co-work → break → close, invariant holds', async () => {
    const S = makeStore();
    wireDb(S);

    // 1. Vitor starts Formulação (new workflow_instance)
    const wf1 = await engine.findOrCreateWorkflowInstance({
      workflowTemplateId: 1, productName: 'Green Tea', batchNumber: '0098', startedByOperatorId: 1,
    });
    expect(wf1.created).toBe(true);
    const f = await engine.startPhase({ workflowInstanceId: wf1.workflowInstanceId, phaseTemplateId: 10, operatorId: 1 });
    expect(openCount(S, 1)).toBe(1);

    // 2. Vitor finishes Formulação
    await engine.closePhase({ phaseInstanceId: f.phaseInstanceId, closedByOperatorId: 1 });
    expect(openCount(S, 1)).toBe(0);

    // 3. Bruno starts Encapsulação on SAME batch (reuse instance, prereq met)
    const wf2 = await engine.findOrCreateWorkflowInstance({
      workflowTemplateId: 1, productName: 'Green Tea', batchNumber: '0098', startedByOperatorId: 2,
    });
    expect(wf2.created).toBe(false);
    expect(wf2.workflowInstanceId).toBe(wf1.workflowInstanceId);
    const enc = await engine.startPhase({ workflowInstanceId: wf2.workflowInstanceId, phaseTemplateId: 12, operatorId: 2 });
    expect(enc.prereqWarning).toBeNull(); // Formulação closed → prereq OK
    expect(openCount(S, 2)).toBe(1);

    // 4. Ana joins Encapsulação
    await engine.joinPhase({ phaseInstanceId: enc.phaseInstanceId, operatorId: 3 });
    expect(openCount(S, 3)).toBe(1);

    // 5. Ana takes a break — her encapsulação oal closes, break opens
    await engine.startBreak({ operatorId: 3, reason: 'almoço' });
    expect(openCount(S, 3)).toBe(1); // exactly one (the break)
    const anaActive = S.oal.filter((r) => r.operator_id === 3 && r.ended_at == null);
    expect(anaActive[0].activity_type).toBe('break');

    // 6. Ana returns
    const back = await engine.endBreak({ operatorId: 3 });
    expect(back.wasOnBreak).toBe(true);
    // After return she's idle (1 open idle row)
    expect(openCount(S, 3)).toBe(1);
    expect(S.oal.filter((r) => r.operator_id === 3 && r.ended_at == null)[0].activity_type).toBe('idle');

    // 7. Bruno closes Encapsulação with 480 bottles
    const closed = await engine.closePhase({
      phaseInstanceId: enc.phaseInstanceId, closedByOperatorId: 2, finalBottleCount: 480,
    });
    expect(closed.alreadyClosed).toBe(false);
    // Bruno + Ana both touched the phase → participants list has both
    expect(closed.participants.map((p) => p.name).sort()).toEqual(['Ana', 'Bruno']);
    expect(openCount(S, 2)).toBe(0); // Bruno's encapsulação oal closed
    expect(S.ph.get(enc.phaseInstanceId).final_bottle_count).toBe(480);

    // Invariant across ALL operators: never more than 1 open oal each
    for (const opId of [1, 2, 3]) expect(openCount(S, opId)).toBeLessThanOrEqual(1);
  });
});
