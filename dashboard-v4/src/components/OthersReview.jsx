import React from 'react';
import { getOthers, resolveOther } from '../adapters/others-api.js';

/* OthersReview — "um painel pra reclassificar os outros... abaixo do resumo do dia
   como um tab expansível; uma vez que a gente resolve tudo ele some; fica lá todos os
   dias até ser resolvido; avisa quem criou, o que colocou, quando" (Bruno 09-11).
   Sem notificação. Reclassificar troca a atividade do registro e marca revisado;
   "Estava certo" só marca revisado. */
export function OthersReview({ activities, ack, refresh }) {
  const [rows, setRows] = React.useState(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(null);
  const load = React.useCallback(() => { getOthers().then((d) => setRows(d.rows || [])).catch(() => setRows([])); }, []);
  React.useEffect(load, [load]);
  if (!rows || rows.length === 0) return null;
  const acts = Object.entries(activities || {}).filter(([k, a]) => a && a._id != null && k !== 'unknown' && !/_other$/.test(k) && k !== 'special_task').sort((a, b) => a[1].name.localeCompare(b[1].name));
  const stamp = (iso) => { try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch (_) { return ''; } };
  const resolve = async (r, slug) => {
    setBusy(r.id);
    try { await resolveOther(r.id, slug); ack && ack(slug ? `ev${r.id} virou ${(activities[slug] || {}).name || slug} ✓` : `ev${r.id}: estava certo ✓`); load(); if (refresh) refresh(); }
    catch (e) { ack && ack('Erro: ' + (e.message || e)); }
    finally { setBusy(null); }
  };
  return (
    <div className="others-review" data-others-review>
      <button className={`resumo-toggle others ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)}>
        <span className="car">▶</span> Outros pra reclassificar <small>{rows.length} registro{rows.length > 1 ? 's' : ''} · quem, o que, quando · {open ? 'clique pra esconder' : 'clique pra ver'}</small>
      </button>
      {open && (
        <div className="others-list">
          <div className="hint">Tarefas entradas por "Outros" ou "Outro (…)". Se era outra coisa, escolha a atividade certa; se estava certo, marque. Some daqui quando for resolvido.</div>
          {rows.map((r) => (
            <div key={r.id} className="others-row" data-other-id={r.id}>
              <div className="who">{r.person}<small>{stamp(r.started_at)} · {r.ended_at ? Math.round(r.duration_min) + ' min' : 'em andamento'} · {r.activity}</small></div>
              <div className="what"><b>{r.title || '(sem título)'}</b>{r.text && r.text !== r.title && <small>{r.text}</small>}</div>
              <div className="act">
                <select defaultValue="" disabled={busy === r.id} onChange={(e) => { if (e.target.value) resolve(r, e.target.value); }}>
                  <option value="">Reclassificar como…</option>
                  {acts.map(([k, a]) => <option key={k} value={k}>{a.name}</option>)}
                </select>
                <button className="btn sm ghost" disabled={busy === r.id} onClick={() => resolve(r, null)}>Estava certo</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
