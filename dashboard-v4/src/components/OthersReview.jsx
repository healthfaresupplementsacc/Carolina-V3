import React from 'react';
import { getOthers, resolveOther, createType, KIOSK_GROUP_OPTIONS, FLOW_OPTIONS } from '../adapters/others-api.js';

/* OthersReview — "um painel pra reclassificar os outros... abaixo do resumo do dia
   como um tab expansível; uma vez que a gente resolve tudo ele some; fica lá todos os
   dias até ser resolvido; avisa quem criou, o que colocou, quando" (Bruno 09-11).
   Sem notificação. Reclassificar troca a atividade do registro e marca revisado;
   "Estava certo" só marca revisado. */
/* NewTileForm (Bruno 09-12: "criar um novo tile" direto do painel). Cria a atividade, o kiosk
   passa a mostrar no grupo escolhido, e o "Outros" de origem já vira o tile novo. */
function NewTileForm({ row, onDone, onCancel }) {
  const [f, setF] = React.useState({ name: (row && row.title) || '', group: 'outros', flow: 'support', background: false, requires_product: false, requires_quantity: false });
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState(null);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await createType({ ...f, reclassify_event_id: row ? row.id : null }); onDone(r); }
    catch (err) { setError(err.message || String(err)); }
    finally { setBusy(false); }
  };
  return (
    <form className="others-newtile" data-new-tile onSubmit={submit}>
      <div className="hint">Tile novo no kiosk. Nome curto, como as pessoas falam. Aparece no grupo escolhido no próximo carregamento do kiosk; o registro acima já vira ele. O Claude de plantão recebe um aviso no Slack pra conferir.</div>
      <div className="grid">
        <label>Nome<input autoFocus value={f.name} maxLength={48} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ex.: Troca de bobina"/></label>
        <label>Grupo no kiosk<select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>{KIOSK_GROUP_OPTIONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        <label>Fluxo (cor na linha do tempo)<select value={f.flow} onChange={(e) => setF({ ...f, flow: e.target.value })}>{FLOW_OPTIONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
        <label className="chk"><input type="checkbox" checked={f.requires_product} onChange={(e) => setF({ ...f, requires_product: e.target.checked })}/> Pede produto e lote</label>
        <label className="chk"><input type="checkbox" checked={f.requires_quantity} onChange={(e) => setF({ ...f, requires_quantity: e.target.checked })}/> Pede quantidade (bottles) ao terminar, obrigatória</label>
        <label className="chk"><input type="checkbox" checked={f.background} onChange={(e) => setF({ ...f, background: e.target.checked })}/> Roda em paralelo (máquina ligada, a pessoa pode fazer outra coisa)</label>
      </div>
      {error && <div className="err">{error}</div>}
      <div className="acts">
        <button type="submit" className="btn sm primary" disabled={busy || f.name.trim().length < 3}>{busy ? 'Criando…' : 'Criar tile e reclassificar'}</button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

export function OthersReview({ activities, ack, refresh }) {
  const [rows, setRows] = React.useState(null);
  const [newTile, setNewTile] = React.useState(null);   // id da linha com o formulário aberto
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
                <select defaultValue="" disabled={busy === r.id} onChange={(e) => { if (e.target.value === '__new__') { setNewTile(r.id); e.target.value = ''; return; } if (e.target.value) resolve(r, e.target.value); }}>
                  <option value="">Reclassificar como…</option>
                  <option value="__new__">➕ Criar tile novo…</option>
                  {acts.map(([k, a]) => <option key={k} value={k}>{a.name}</option>)}
                </select>
                <button className="btn sm ghost" disabled={busy === r.id} onClick={() => resolve(r, null)}>Estava certo</button>
              </div>
              {newTile === r.id && (
                <NewTileForm row={r} onCancel={() => setNewTile(null)}
                  onDone={(t) => { setNewTile(null); ack && ack(`Tile "${t.name}" criado no kiosk (${t.group}) e ev${r.id} reclassificado ✓`); load(); if (refresh) refresh(); }}/>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
