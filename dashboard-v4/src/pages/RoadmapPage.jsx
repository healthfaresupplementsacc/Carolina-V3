/* Página "Roadmap" (Bruno 08-05). Board do sistema INTEIRO (dashboard, employee,
   P&P, inventário, impressão), sincronizado no banco. Bruno comenta + desenha;
   Claude marca feito. Segue o HealthFare STYLE-KIT (Kinto editorial, sem travessão).
   Fonte: /api/v3/data/roadmap + /roadmap/card + /roadmap/card/:id/comment + /roadmap/sketch. */
import React from 'react';
import { usePoll, apiGet, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

const KIT = `
.rm-root{
  --primary:#1a3a6b; --primary-deep:#0d1f3c; --green-d:#2e8b3c;
  --ground:#f4f8fc; --surface:#fff; --surface-2:#f7fafd;
  --line:#d4e2f0; --line-strong:#b9cbe2; --dotline:#c6d7e8;
  --ink:#1c2b3a; --ink-dim:#54687c; --ink-faint:#6b7f92;
  --ok-bg:#e8f7ea; --ok-line:#c8ecce; --ok-deep:#1e6b2e;
  --warn-bg:#fdf6e3; --warn-line:#eeddad; --warn-deep:#6b4c07;
  --bad-bg:#fdeeec; --bad-line:#f5cdc7; --bad-deep:#a02c20;
  --neutral-bg:#eaf0fb; --neutral-line:#d4e2f0;
  --font:'DM Sans',system-ui,'Segoe UI',sans-serif;
  --font-display:'DM Serif Display','Iowan Old Style',Georgia,serif;
  --font-mono:'DM Mono','SFMono-Regular',ui-monospace,Consolas,monospace;
  --r-lg:18px; --r-pill:999px;
  --shadow-card:0 1px 2px rgba(13,31,60,.03),0 10px 30px rgba(13,31,60,.05);
  font-family:var(--font); color:var(--ink);
  background:var(--ground); background-image:radial-gradient(circle,rgba(26,58,107,.06) 1px,transparent 1px); background-size:26px 26px;
  min-height:100%; padding:30px 26px 70px;
}
.rm-eyebrow{font:500 10px var(--font-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--green-d)}
.rm-h1{font-family:var(--font-display);font-weight:400;font-size:clamp(24px,2.4vw,32px);color:var(--primary-deep);margin:4px 0 2px}
.rm-h1 em{color:var(--green-d);font-style:italic}
.rm-sub{color:var(--ink-dim);font-size:13px}
.rm-mlabel{font:500 10px var(--font-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-faint)}
.rm-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-card)}
.rm-btn{border:none;cursor:pointer;font:600 12.5px var(--font);border-radius:var(--r-pill);height:34px;padding:0 16px;background:var(--primary-deep);color:#fff}
.rm-btn.sec{background:#fff;color:var(--ink);border:1px solid var(--line)}
.rm-chip{display:inline-flex;align-items:center;height:20px;padding:0 9px;border-radius:var(--r-pill);font:500 10.5px var(--font-mono);white-space:nowrap}
.rm-chip.ok{background:var(--ok-bg);color:var(--ok-deep);box-shadow:inset 0 0 0 1px var(--ok-line)}
.rm-chip.warn{background:var(--warn-bg);color:var(--warn-deep);box-shadow:inset 0 0 0 1px var(--warn-line)}
.rm-chip.bad{background:var(--bad-bg);color:var(--bad-deep);box-shadow:inset 0 0 0 1px var(--bad-line)}
.rm-chip.neutral{background:var(--neutral-bg);color:var(--primary);box-shadow:inset 0 0 0 1px var(--neutral-line)}
.rm-col{background:var(--surface-2);border:1px solid var(--line);border-radius:16px;padding:12px;min-width:270px;flex:1;display:flex;flex-direction:column;gap:9px}
.rm-jobcard{background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px 12px;cursor:pointer;transition:box-shadow .14s,transform .14s;box-shadow:0 1px 2px rgba(13,31,60,.04)}
.rm-jobcard:hover{box-shadow:var(--shadow-card);transform:translateY(-1px)}
.rm-jobcard.done{opacity:.62}
.rm-jobcard.dragging{opacity:.4;box-shadow:var(--shadow-card)}
.rm-jobcard.over{border-top:3px solid var(--primary);transform:none}
.rm-grip{cursor:grab;color:var(--ink-faint);font-size:15px;line-height:1;padding:0 2px;touch-action:none;user-select:none}
.rm-grip:active{cursor:grabbing}
.rm-jobtitle{font-weight:600;font-size:13.5px;line-height:1.3}
.rm-jobtitle.done{text-decoration:line-through;color:var(--ink-dim)}
.rm-dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.rm-modal-bg{position:fixed;inset:0;background:rgba(13,31,60,.45);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px}
.rm-input{width:100%;padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);font:400 13.5px var(--font)}
.rm-seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden;flex-wrap:wrap}
.rm-seg button{padding:6px 11px;border:none;cursor:pointer;font:600 12px var(--font);background:#fff;color:var(--ink-dim)}
.rm-seg button.on{background:var(--primary-deep);color:#fff}
`;

const STATUS = [
  { key: 'todo', label: 'A fazer', tone: 'neutral' },
  { key: 'doing', label: 'Fazendo', tone: 'warn' },
  { key: 'blocked', label: 'Travado', tone: 'bad' },
  { key: 'done', label: 'Feito', tone: 'ok' },
  { key: 'backlog', label: 'Backlog', tone: 'neutral' },
];
const PRIO = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'neutral' };
const PRIO_LABEL = { urgent: 'URGENTE', high: 'alta', normal: 'normal', low: 'baixa' };

function CommentThread({ card, onCount }) {
  const [items, setItems] = React.useState(null);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let on = true;
    apiGet('/roadmap/card/' + card.id + '/comments').then((r) => { if (on) setItems((r && r.data) || []); }).catch(() => { if (on) setItems([]); });
    return () => { on = false; };
  }, [card.id]);
  async function send() {
    const body = text.trim();
    if (!body) return;
    if (!V4_ALLOW_WRITES) { setText(''); return; }
    setBusy(true);
    const r = await apiPost('/roadmap/card/' + card.id + '/comment', { author: 'bruno', body }).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (r && !r.error) { setItems((it) => [...(it || []), r.data]); setText(''); onCount && onCount(); }
  }
  return (
    <div style={{ marginTop: 14 }}>
      <div className="rm-mlabel" style={{ marginBottom: 6 }}>Comentários</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
        {items === null && <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>carregando…</div>}
        {items && items.length === 0 && <div style={{ color: 'var(--ink-faint)', fontSize: 12 }}>Sem comentários ainda. Escreva o que precisa mudar.</div>}
        {(items || []).map((c) => (
          <div key={c.id} style={{ background: c.author === 'claude' ? 'var(--neutral-bg)' : 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 12, padding: '8px 11px' }}>
            <div className="rm-mlabel" style={{ color: c.author === 'claude' ? 'var(--primary)' : 'var(--green-d)' }}>{c.author === 'claude' ? 'Claude' : 'Bruno'}</div>
            <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Escreva um comentário para o Claude…" rows={2}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
          className="rm-input" style={{ resize: 'vertical' }} />
        <button className="rm-btn" disabled={busy} onClick={send} style={{ alignSelf: 'flex-end' }}>{busy ? '…' : 'Enviar'}</button>
      </div>
    </div>
  );
}

function CardModal({ card, areas, onClose, onSaved }) {
  const area = areas.find((a) => a.id === card.area_id) || {};
  const [status, setStatus] = React.useState(card.status);
  const [busy, setBusy] = React.useState(false);
  async function setStatusTo(st) {
    setStatus(st);
    if (!V4_ALLOW_WRITES) return;
    setBusy(true);
    const r = await apiPost('/roadmap/card', { id: card.id, status: st }).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (r && !r.error) onSaved && onSaved({ ...card, status: st, done_at: st === 'done' ? new Date().toISOString() : null });
  }
  return (
    <div className="rm-modal-bg" onClick={onClose}>
      <div className="rm-card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(560px,96vw)', padding: 20, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="rm-dot" style={{ background: area.color }} />
          <span className="rm-mlabel">{area.name}</span>
          <span style={{ flex: 1 }} />
          <span className={'rm-chip ' + (PRIO[card.priority] || 'neutral')}>{PRIO_LABEL[card.priority] || card.priority}</span>
        </div>
        <h3 style={{ margin: '8px 0 4px', fontSize: 18 }}>{card.title}</h3>
        {card.detail && <p style={{ color: 'var(--ink-dim)', fontSize: 13.5 }}>{card.detail}</p>}
        {card.blocks_on && <div className="rm-chip bad" style={{ marginTop: 8 }}>bloqueado por: {card.blocks_on}</div>}

        {/* RESUMO rico: o que conversamos + a ideia do plano (Bruno 08-06) */}
        {card.summary && (
          <div style={{ marginTop: 14, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px' }}>
            <div className="rm-mlabel" style={{ marginBottom: 6 }}>O plano · o que conversamos</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{card.summary}</div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div className="rm-mlabel" style={{ marginBottom: 6 }}>Status {busy && <span style={{ color: 'var(--ink-faint)' }}>· salvando…</span>}</div>
          <div className="rm-seg">
            {STATUS.map((s) => <button key={s.key} className={status === s.key ? 'on' : ''} onClick={() => setStatusTo(s.key)}>{s.label}</button>)}
          </div>
        </div>

        <CommentThread card={card} onCount={onSaved} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="rm-btn sec" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

/* Área de desenho (canvas puro, sem lib externa). Salva PNG no banco. */
function SketchPad({ areas }) {
  const ref = React.useRef(null);
  const [drawing, setDrawing] = React.useState(false);
  const [color, setColor] = React.useState('#1a3a6b');
  const [title, setTitle] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const last = React.useRef(null);

  React.useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#c6d7e8'; ctx.lineWidth = 1;
    for (let x = 26; x < c.width; x += 26) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke(); }
    for (let y = 26; y < c.height; y += 26) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke(); }
  }, []);

  const pos = (e) => {
    const c = ref.current; const r = c.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
  };
  const start = (e) => { e.preventDefault(); setDrawing(true); last.current = pos(e); };
  const move = (e) => {
    if (!drawing) return; e.preventDefault();
    const c = ref.current; const ctx = c.getContext('2d'); const p = pos(e);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
  };
  const end = () => setDrawing(false);
  const clear = () => {
    const c = ref.current; const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = '#c6d7e8'; ctx.lineWidth = 1;
    for (let x = 26; x < c.width; x += 26) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke(); }
    for (let y = 26; y < c.height; y += 26) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.width, y); ctx.stroke(); }
  };
  async function save() {
    if (!V4_ALLOW_WRITES) { setMsg('modo leitura'); return; }
    setBusy(true); setMsg('');
    const data_url = ref.current.toDataURL('image/png');
    const r = await apiPost('/roadmap/sketch', { title: title.trim() || null, data_url, created_by: 'bruno' }).catch((e) => ({ error: e.message }));
    setBusy(false);
    if (r && !r.error) { setMsg('✓ desenho salvo'); setTitle(''); setTimeout(() => setMsg(''), 2000); }
    else setMsg('erro: ' + (r && r.error));
  }
  const COLORS = ['#1a3a6b', '#c0392b', '#2e8b3c', '#96690a', '#5b4a9e', '#1c2b3a'];
  return (
    <div className="rm-card" style={{ padding: 16, marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="rm-mlabel">Rascunho · desenhe o que precisa</div>
        <span style={{ flex: 1 }} />
        {COLORS.map((c) => <button key={c} onClick={() => setColor(c)} title={c} style={{ width: 22, height: 22, borderRadius: '50%', background: c, border: color === c ? '2px solid var(--ink)' : '2px solid #fff', boxShadow: '0 0 0 1px var(--line)', cursor: 'pointer' }} />)}
        <button className="rm-btn sec" onClick={clear}>Limpar</button>
      </div>
      <canvas ref={ref} width={1000} height={520}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{ width: '100%', borderRadius: 12, border: '1px solid var(--line)', touchAction: 'none', background: '#fff', cursor: 'crosshair' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="rm-input" style={{ flex: '1 1 200px' }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="título do desenho (opcional)…" />
        <button className="rm-btn" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar desenho'}</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('erro') ? 'var(--bad-deep)' : 'var(--green-d)', fontWeight: 600 }}>{msg}</span>}
      </div>
    </div>
  );
}

export function RoadmapPage() {
  const rm = usePoll('/roadmap', [], 20000);
  const [open, setOpen] = React.useState(null);       // card aberto no modal
  const [areaFilter, setAreaFilter] = React.useState('all');
  const [tab, setTab] = React.useState('board');      // 'board' | 'sketch'
  const [localCards, setLocalCards] = React.useState(null);

  const d = rm.data || {};
  const areas = d.areas || [];
  const cards = localCards || d.cards || [];
  // não deixa o poll de 20s apagar uma reordenação/edição local recém-feita
  const dirtyRef = React.useRef(false);
  React.useEffect(() => { if (!dirtyRef.current) setLocalCards(null); }, [rm.data]);

  // ordena por `sort` (depois id) — pra a reordenação por drag aparecer NA HORA,
  // não só depois do reload (o backend já entrega ordenado, mas o update otimista
  // muda o campo `sort` e o render precisa reler essa ordem).
  const shown = cards
    .filter((c) => areaFilter === 'all' || c.area_id === areaFilter)
    .slice()
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id);
  const total = cards.length;
  const done = cards.filter((c) => c.status === 'done').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  function onCardSaved(updated) {
    dirtyRef.current = true;
    setLocalCards((cur) => (cur || cards).map((c) => c.id === updated.id ? { ...c, ...updated } : c));
  }

  // ── DRAG-to-reorder (Bruno 08-06): arrasta card pra cima/baixo na coluna.
  //    Mouse E toque. Usa document.elementFromPoint no pointermove GLOBAL (funciona
  //    no touch, onde pointerenter não dispara nos outros cards). Persiste o `sort`.
  const [dragId, setDragId] = React.useState(null);
  const [overId, setOverId] = React.useState(null);
  const drag = React.useRef({ id: null, over: null, status: null });

  function reorderWithin(colKey, fromId, toId) {
    const ids = shown.filter((c) => c.status === colKey).map((c) => c.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    dirtyRef.current = true;
    const sortById = {};
    ids.forEach((id, i) => { sortById[id] = i; });
    setLocalCards((cur) => (cur || cards).map((c) => sortById[c.id] != null ? { ...c, sort: sortById[c.id] } : c));
    if (V4_ALLOW_WRITES) ids.forEach((id, i) => { apiPost('/roadmap/card', { id, sort: i }).catch(() => {}); });
  }

  function startDrag(card, e) {
    if (drag.current.id != null) return;         // já arrastando (evita pointerdown+touchstart duplo)
    e.preventDefault(); e.stopPropagation();
    drag.current = { id: card.id, over: card.id, status: card.status };
    setDragId(card.id); setOverId(card.id);

    const onMove = (ev) => {
      const pt = ev.touches ? ev.touches[0] : ev;
      const el = document.elementFromPoint(pt.clientX, pt.clientY);
      const cardEl = el && el.closest && el.closest('[data-card-id]');
      if (cardEl) {
        const id = Number(cardEl.getAttribute('data-card-id'));
        const st = cardEl.getAttribute('data-card-status');
        if (id !== drag.current.over && st === drag.current.status) {
          drag.current.over = id; setOverId(id);
        }
      }
      if (ev.cancelable) ev.preventDefault();
    };
    const onUp = () => {
      const { id, over, status } = drag.current;
      if (id != null && over != null && id !== over) reorderWithin(status, id, over);
      drag.current = { id: null, over: null, status: null };
      setDragId(null); setOverId(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }

  return (
    <div className="rm-root">
      <style>{KIT}</style>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="rm-eyebrow">● HEALTHFARE · ROADMAP</span>
          <h1 className="rm-h1">O plano do <em>sistema inteiro</em></h1>
          <p className="rm-sub">Dashboard, funcionário, P&amp;P, inventário e impressão. Comente nos cards, desenhe o que precisa. Sincroniza em todos os aparelhos.</p>
        </div>
        <div className="rm-card" style={{ padding: '12px 16px', minWidth: 150 }}>
          <div className="rm-mlabel">Progresso</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, color: 'var(--primary-deep)' }}>{pct}%</div>
            <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{done}/{total} feitos</div>
          </div>
        </div>
      </div>

      {/* tabs board / sketch */}
      <div style={{ display: 'flex', gap: 8, margin: '16px 0 6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="rm-seg">
          <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Board</button>
          <button className={tab === 'sketch' ? 'on' : ''} onClick={() => setTab('sketch')}>Desenhar</button>
        </div>
        {tab === 'board' && (
          <div className="rm-seg" style={{ marginLeft: 6 }}>
            <button className={areaFilter === 'all' ? 'on' : ''} onClick={() => setAreaFilter('all')}>Tudo</button>
            {areas.map((a) => <button key={a.id} className={areaFilter === a.id ? 'on' : ''} onClick={() => setAreaFilter(a.id)}>{a.name}</button>)}
          </div>
        )}
      </div>

      {rm.loading && !cards.length && <div className="rm-card" style={{ padding: 20, marginTop: 12, color: 'var(--ink-dim)' }}>Carregando o plano…</div>}

      {tab === 'sketch' && <SketchPad areas={areas} />}

      {tab === 'board' && (
        <div style={{ display: 'flex', gap: 12, marginTop: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {STATUS.filter((s) => s.key !== 'backlog' || shown.some((c) => c.status === 'backlog')).map((col) => {
            const list = shown.filter((c) => c.status === col.key);
            return (
              <div key={col.key} className="rm-col">
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className={'rm-chip ' + col.tone}>{col.label}</span>
                  <span className="rm-mlabel">{list.length}</span>
                </div>
                {list.map((c) => {
                  const area = areas.find((a) => a.id === c.area_id) || {};
                  const isDragging = dragId === c.id;
                  const isOver = overId === c.id && dragId != null && dragId !== c.id;
                  return (
                    <div key={c.id}
                      data-card-id={c.id} data-card-status={c.status}
                      className={'rm-jobcard' + (c.status === 'done' ? ' done' : '') + (isDragging ? ' dragging' : '') + (isOver ? ' over' : '')}
                      onClick={() => { if (dragId == null) setOpen(c); }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                        <span className="rm-grip" title="arraste pra reordenar"
                          onPointerDown={(e) => startDrag(c, e)}
                          onTouchStart={(e) => startDrag(c, e)}
                          onClick={(e) => e.stopPropagation()}>⠿</span>
                        <span className="rm-dot" style={{ background: area.color }} />
                        <span className="rm-mlabel" style={{ letterSpacing: '.08em' }}>{area.name}</span>
                        <span style={{ flex: 1 }} />
                        {c.priority === 'urgent' && <span className="rm-chip bad">URGENTE</span>}
                        {c.priority === 'high' && <span className="rm-chip warn">alta</span>}
                      </div>
                      <div className={'rm-jobtitle' + (c.status === 'done' ? ' done' : '')}>{c.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        {c.blocks_on && <span className="rm-chip bad" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>🔒 {c.blocks_on}</span>}
                        <span style={{ flex: 1 }} />
                        {c.comment_count > 0 && <span className="rm-mlabel">💬 {c.comment_count}</span>}
                      </div>
                    </div>
                  );
                })}
                {list.length === 0 && <div style={{ color: 'var(--ink-faint)', fontSize: 12, padding: '6px 2px' }}>vazio</div>}
              </div>
            );
          })}
        </div>
      )}

      {open && <CardModal card={cards.find((c) => c.id === open.id) || open} areas={areas} onClose={() => setOpen(null)} onSaved={onCardSaved} />}
    </div>
  );
}
