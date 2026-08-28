'use strict';
/**
 * Fake de v3.shipment_costs + audit_log pros testes do freight watch.
 * Emula SÓ as queries que src/v3/freight/service.js e o worker fazem
 * (upsert com COALESCE, mediana percentile_cont, summary com FILTER cost>0,
 * outliers do dia, bands, dedupe do digest). Nada de rede, nada de PG.
 */
const EDT = 'America/New_York';
const nyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: EDT });

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function makeFreightDb() {
  const rows = new Map();      // shipment_id -> row
  const audit = [];            // audit_log
  const queries = [];
  const co = (a, b) => (a != null ? a : b);

  return {
    _rows: rows, _audit: audit, _queries: queries,
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      queries.push({ q, params });

      // upsert (service.upsertShipments)
      if (q.startsWith('INSERT INTO v3.shipment_costs')) {
        const [shipment_id, order_id, order_number, channel, service, weight_g,
          cost, currency, bought_at, due_date, dispatch_date, dest_state, dest_zip, ny_day] = params;
        const key = String(shipment_id);
        const ex = rows.get(key);
        if (ex) {
          const m = { ...ex,
            order_id: co(order_id, ex.order_id), order_number: co(order_number, ex.order_number),
            channel: co(channel, ex.channel), service: co(service, ex.service),
            weight_g: co(weight_g, ex.weight_g), cost: co(cost, ex.cost),
            due_date: co(due_date, ex.due_date), dispatch_date: co(dispatch_date, ex.dispatch_date),
            dest_state: co(dest_state, ex.dest_state), dest_zip: co(dest_zip, ex.dest_zip),
            alerted_at: ex.alerted_at };   // NUNCA regride
          rows.set(key, m);
          return { rows: [{ ...m, inserted: false }], rowCount: 1 };
        }
        const row = { shipment_id, order_id, order_number, channel, service, weight_g,
          cost, currency: currency || 'USD', bought_at, due_date, dispatch_date,
          dest_state, dest_zip, ny_day, expected_cost: null, band: null,
          outlier: false, outlier_reason: null, alerted_at: null };
        rows.set(key, row);
        return { rows: [{ ...row, inserted: true }], rowCount: 1 };
      }

      // mediana da faixa (expectedFor)
      if (/PERCENTILE_CONT/.test(q) && /WHERE band = \$1/.test(q)) {
        const cs = [...rows.values()]
          .filter((r) => r.band === params[0] && Number(r.cost) > 0)
          .map((r) => Number(r.cost)).sort((a, b) => a - b);
        return { rows: [{ median: median(cs), samples: cs.length }], rowCount: 1 };
      }

      // julgamento (saveJudgement)
      if (q.startsWith('UPDATE v3.shipment_costs SET band')) {
        const r = rows.get(String(params[0]));
        if (r) { r.band = params[1]; r.expected_cost = params[2]; r.outlier = params[3]; r.outlier_reason = params[4]; }
        return { rows: [], rowCount: r ? 1 : 0 };
      }

      // markAlerted (só se nulo)
      if (/SET alerted_at = NOW\(\)/.test(q)) {
        const r = rows.get(String(params[0]));
        if (r && !r.alerted_at) { r.alerted_at = new Date().toISOString(); return { rows: [{ shipment_id: r.shipment_id }], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }

      // summary por dia
      if (/GROUP BY ny_day/.test(q)) {
        const byDay = new Map();
        for (const r of rows.values()) {
          if (!r.ny_day) continue;
          const d = byDay.get(r.ny_day) || { day: r.ny_day, shipments: 0, labeled: 0, walmart_zero: 0, total_cost: 0, outliers: 0, outlier_excess: 0 };
          d.shipments++;
          if (Number(r.cost) > 0) { d.labeled++; d.total_cost += Number(r.cost); } else d.walmart_zero++;
          if (r.outlier) { d.outliers++; if (r.expected_cost != null) d.outlier_excess += Number(r.cost) - Number(r.expected_cost); }
          byDay.set(r.ny_day, d);
        }
        const out = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
        return { rows: out, rowCount: out.length };
      }

      // total 30d (summary)
      if (/SUM\(cost\), 0\)::numeric AS total/.test(q)) {
        const cs = [...rows.values()].filter((r) => Number(r.cost) > 0);
        return { rows: [{ total: cs.reduce((s, r) => s + Number(r.cost), 0), labeled: cs.length }], rowCount: 1 };
      }

      // outliers de um dia
      if (/WHERE outlier = true/.test(q)) {
        const day = params[0] || nyToday();
        const out = [...rows.values()].filter((r) => r.outlier && r.ny_day === day)
          .sort((a, b) => (Number(b.cost) - Number(b.expected_cost || 0)) - (Number(a.cost) - Number(a.expected_cost || 0)));
        return { rows: out, rowCount: out.length };
      }

      // bands
      if (/GROUP BY band/.test(q)) {
        const byBand = new Map();
        for (const r of rows.values()) {
          if (!r.band || !(Number(r.cost) > 0)) continue;
          const b = byBand.get(r.band) || [];
          b.push(Number(r.cost)); byBand.set(r.band, b);
        }
        const out = [...byBand.entries()].map(([band, cs]) => {
          cs.sort((a, b) => a - b);
          return { band, median: median(cs), min: cs[0], max: cs[cs.length - 1], samples: cs.length };
        }).sort((a, b) => b.samples - a.samples);
        return { rows: out, rowCount: out.length };
      }

      // dedupe do digest (audit_log)
      if (/action = 'freight_digest'/.test(q) && q.startsWith('SELECT')) {
        const hit = audit.some((m) => m.action === 'freight_digest' && m.ny_date === params[0]);
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      if (/INSERT INTO v3\.audit_log/.test(q)) {
        const meta = JSON.parse(params[params.length - 1]);
        audit.push({ action: 'freight_digest', ...meta });
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

module.exports = { makeFreightDb, nyToday };
