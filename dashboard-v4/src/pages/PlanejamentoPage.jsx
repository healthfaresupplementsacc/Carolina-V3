/* Página "Planejamento" (Bruno 09-04, direção corrigida). O pedido, verbatim:
   "o planejamento nao eh so baseado no veeqo e no stock do P&P, ele eh baseado
   em toda a producao do EMS e pra gente saber oq tem pra revisao que ainda nao
   foi revisado... como se fosse uma tabela de to-dos: Formulating /
   Encapsulating / Waiting to be Revised / Being Revised / Ready to go to
   Production / Produced / Boxed ... Then below we should also have the
   planning area where we can drag, add, remove, from the same set of table so
   we can organize our next day and plan how its gonna be, with a section on
   the side to take notes".

   TRÊS blocos, STYLE-KIT:
     QUADRO  — o funil (7 colunas, GET /board). Auto-derivado, é a VERDADE:
               nada se arrasta AQUI, só o flag manual de Encaixotado.
     PLANO   — abas de data (Amanhã + próximos 5 dias); arrasta cartões do
               quadro pra dentro (HTML5 drag, sem lib; o botão + do cartão é o
               caminho de toque), reordena por drag, remove no ×, adiciona item
               livre. Persiste com PUT da lista ordenada inteira.
     NOTAS   — uma caixa por data, autosave debounced.
   Cada item do plano mostra o estágio AO VIVO re-derivado do quadro no load:
   item planejado que já saiu como Produzido/Encaixotado ganha ✓ verde sozinho
   (o plano mostra a deriva da realidade). */
import React from 'react';
import {
  getBoard, getPlan, putPlan, addPlanItem, deletePlanItem,
  getNotes, putNotes, setBoxed,
} from '../adapters/planning-api.js';
import { nyToday, shiftDate } from '../adapters/from-api.js';

const CSS = `
.pl-board{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px;align-items:flex-start}
.pl-col{flex:0 0 232px;min-width:232px;background:var(--surface-2,#f7fafd);border:1px solid var(--line,#d4e2f0);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px}
.pl-col-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 2px}
.pl-card{background:#fff;border:1px solid var(--line,#d4e2f0);border-radius:11px;padding:9px 10px;cursor:grab;box-shadow:0 1px 2px rgba(13,31,60,.04)}
.pl-card:active{cursor:grabbing}
.pl-card .top{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.pl-prod{font-weight:600;font-size:13px;line-height:1.25;color:var(--ink,#1c2b3a)}
.pl-batch{font-family:var(--font-mono,monospace);font-size:11px;color:var(--ink-faint,#6b7f92);margin-top:2px}
.pl-meta{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;align-items:center}
.pl-who{font-size:11.5px;color:var(--ink-dim,#54687c);margin-top:5px}
.pl-add{border:none;background:var(--neutral-bg,#eaf0fb);color:var(--primary,#1a3a6b);border-radius:999px;width:22px;height:22px;font-size:14px;line-height:1;cursor:pointer;flex:0 0 auto}
.pl-add:hover{filter:brightness(.95)}
.pl-lane{min-height:96px;border:1.5px dashed var(--line-strong,#b9cbe2);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:7px;background:var(--surface,#fff)}
.pl-lane.over{border-color:var(--green-d,#2e8b3c);background:var(--ok-bg,#e8f7ea)}
.pl-item{display:flex;align-items:center;gap:9px;background:var(--surface-2,#f7fafd);border:1px solid var(--line,#d4e2f0);border-radius:10px;padding:8px 10px;cursor:grab}
.pl-item.dragging{opacity:.4}
.pl-item.over{border-top:3px solid var(--primary,#1a3a6b)}
.pl-item .t{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--ink,#1c2b3a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-item .x{border:none;background:none;color:var(--ink-faint,#6b7f92);cursor:pointer;font-size:15px;line-height:1;padding:2px}
.pl-item .x:hover{color:var(--bad-deep,#a02c20)}
.pl-tabs{display:flex;gap:6px;flex-wrap:wrap}
.pl-tab{border:1px solid var(--line,#d4e2f0);background:#fff;border-radius:999px;height:30px;padding:0 14px;font:600 12px var(--font,sans-serif);color:var(--ink-dim,#54687c);cursor:pointer}
.pl-tab.on{background:var(--primary-deep,#0d1f3c);border-color:var(--primary-deep,#0d1f3c);color:#fff}
.pl-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;align-items:start}
@media (max-width:980px){.pl-grid{grid-template-columns:1fr}}
.pl-notes textarea{width:100%;min-height:220px;border:1px solid var(--line,#d4e2f0);border-radius:10px;padding:10px;font:400 13px var(--font,sans-serif);color:var(--ink,#1c2b3a);resize:vertical;background:var(--surface,#fff)}
.pl-empty{color:var(--ink-faint,#6b7f92);font-size:12.5px;padding:6px 2px}
`;

// chip tonal por coluna (o "estágio ao vivo" dos itens do plano usa o mesmo)
const COL_CHIP = {
  formulating: 'neutral', encapsulating: 'info', waiting: 'warn',
  revising: 'info', ready: 'ok', produced: 'ok', boxed: 'solid',
};

const fmtDays = (d) => (d == null ? null : (d < 1 ? 'hoje' : `${d}d`));

function tabDates() {
  const today = nyToday();
  const out = [];
  for (let i = 1; i <= 6; i++) {
    const date = shiftDate(today, i);
    const dt = new Date(date + 'T12:00:00');
    const wd = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][dt.getDay()];
    out.push({
      date,
      label: i === 1 ? 'Amanhã' : `${wd} ${date.slice(8, 10)}/${date.slice(5, 7)}`,
    });
  }
  return out;
}

/* Um cartão do quadro. Arrastável pro plano; o + adiciona na aba ativa
   (caminho de toque, onde o HTML5 drag não existe). */
function BoardCard({ card, onAdd, onToggleBoxed, canWrite }) {
  return (
    <div className="pl-card" draggable
         data-batch={card.batch_number}
         onDragStart={(e) => {
           e.dataTransfer.effectAllowed = 'copy';
           e.dataTransfer.setData('text/plain', JSON.stringify({
             batch_number: card.batch_number, product: card.product, product_id: card.product_id,
           }));
         }}>
      <div className="top">
        <div style={{ minWidth: 0 }}>
          <div className="pl-prod">{card.product}</div>
          <div className="pl-batch">{card.batch_number}</div>
        </div>
        <button className="pl-add" title="Adicionar no plano do dia selecionado"
                onClick={() => onAdd(card)}>+</button>
      </div>
      <div className="pl-meta">
        {card.na_fila
          ? <span className="kit-chip neutral">na fila</span>
          : card.ems_stage && <span className="kit-chip neutral">{card.ems_stage}</span>}
        {fmtDays(card.days_in_stage) && <span className="kit-chip warn" title="Tempo no estágio atual">{fmtDays(card.days_in_stage)}</span>}
        {card.bottles != null && <span className="kit-chip ok">{card.bottles} garrafas</span>}
        {card.manual_boxed && <span className="kit-chip solid">manual</span>}
      </div>
      {card.who.length > 0 && (
        <div className="pl-who">
          {card.who.map((w) => w.name).join(', ')} agora
        </div>
      )}
      {/* O ÚNICO toque manual do quadro: marcar/desmarcar Encaixotado enquanto
          a carga física (stock_boxes) não existe. */}
      {canWrite && (card.column === 'produced' || card.manual_boxed) && !card.boxed_auto && (
        <button className="kit-btn xs" style={{ marginTop: 7 }}
                onClick={() => onToggleBoxed(card)}>
          {card.manual_boxed ? 'Desmarcar encaixotado' : 'Marcar encaixotado'}
        </button>
      )}
    </div>
  );
}

export function PlanejamentoPage() {
  const [board, setBoard] = React.useState(null);
  const [boardErr, setBoardErr] = React.useState(null);
  const tabs = React.useMemo(tabDates, []);
  const [date, setDate] = React.useState(tabs[0].date);
  const [items, setItems] = React.useState([]);
  const [note, setNote] = React.useState('');
  const [noteSavedAt, setNoteSavedAt] = React.useState(null);
  const [laneOver, setLaneOver] = React.useState(false);
  const [dragIdx, setDragIdx] = React.useState(null);
  const [overIdx, setOverIdx] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const noteTimer = React.useRef(null);
  const noteDirty = React.useRef(false);

  const canWrite = (() => {
    try {
      const l = JSON.parse(sessionStorage.getItem('v3login') || '{}');
      const fns = l.functions || [];
      return fns.includes('*') || fns.includes('manage_stock');
    } catch (e) { return false; }
  })();

  const loadBoard = React.useCallback(() => {
    getBoard().then((d) => { setBoard(d); setBoardErr(null); })
      .catch((e) => setBoardErr(e.message));
  }, []);
  React.useEffect(() => { loadBoard(); }, [loadBoard]);

  // plano + notas da aba ativa (estágio ao vivo re-derivado a cada load do board)
  React.useEffect(() => {
    let alive = true;
    getPlan(date).then((d) => { if (alive) setItems(d.items || []); }).catch(() => {});
    getNotes(date).then((d) => {
      if (!alive) return;
      setNote(d.body || '');
      setNoteSavedAt(d.updated_at || null);
      noteDirty.current = false;
    }).catch(() => {});
    return () => { alive = false; };
  }, [date]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 2600); };

  // ── persistência do plano: SEMPRE a lista ordenada inteira ──────────────
  const persist = React.useCallback((next) => {
    setItems(next);
    const payload = next.map((i) => ({
      batch_number: i.batch_number || null, product_id: i.product_id || null,
      custom_title: i.custom_title || null, note: i.note || null, done: !!i.done,
    }));
    putPlan(date, payload)
      .then((d) => setItems(d.items || next))
      .catch((e) => flash('Erro ao salvar o plano: ' + e.message));
  }, [date]);

  const addCard = React.useCallback((card) => {
    setItems((cur) => {
      if (cur.some((i) => i.batch_number === card.batch_number)) { flash('Esse lote já está no plano do dia.'); return cur; }
      const next = [...cur, { batch_number: card.batch_number, product_id: card.product_id, custom_title: null }];
      persist(next);
      return next;
    });
  }, [persist]);

  const addCustom = () => {
    const t = window.prompt('Item livre pro plano (ex.: "Limpar a encapsuladora"):');
    if (!t || !t.trim()) return;
    persist([...items, { custom_title: t.trim() }]);
  };

  const removeItem = (idx) => persist(items.filter((_, i) => i !== idx));

  const reorder = (from, to) => {
    if (from === to || from == null || to == null) return;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persist(next);
  };

  // estágio AO VIVO de um item do plano (re-derivado do quadro)
  const liveOf = (item) => {
    if (!item.batch_number || !board) return null;
    for (const c of board.columns) {
      const hit = c.cards.find((x) => x.batch_number === item.batch_number);
      if (hit) return { column: c.id, title: c.title };
    }
    return null;
  };

  // ── notas: autosave debounced ───────────────────────────────────────────
  const onNote = (v) => {
    setNote(v);
    noteDirty.current = true;
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => {
      putNotes(date, v).then((d) => { setNoteSavedAt(d.updated_at); noteDirty.current = false; })
        .catch((e) => flash('Erro ao salvar anotação: ' + e.message));
    }, 800);
  };

  const toggleBoxed = (card) => {
    setBoxed(card.batch_number, !card.manual_boxed)
      .then(() => loadBoard())
      .catch((e) => flash('Erro: ' + e.message));
  };

  const itemLabel = (i) => {
    if (i.custom_title) return i.custom_title;
    if (!board) return i.batch_number;
    for (const c of board.columns) {
      const hit = c.cards.find((x) => x.batch_number === i.batch_number);
      if (hit) return `${hit.product} · ${i.batch_number}`;
    }
    return i.batch_number;
  };

  return (
    <div data-page-op="planejamento" className="pl-root">
      <style>{CSS}</style>
      <div className="opa-head">
        <div className="opa-head-main">
          <span className="kit-eyebrow">● HEALTHFARE · PLANEJAMENTO</span>
          <h1 className="kit-h1">O funil da <em>produção</em></h1>
          <p className="kit-sub">Todo lote do EMS nas 7 etapas até a caixa, e embaixo o plano dos próximos dias: arraste os cartões, adicione itens livres e anote do lado.</p>
        </div>
        <div className="opa-head-side">
          <button className="kit-btn sec sm" onClick={loadBoard}>Atualizar</button>
        </div>
      </div>

      {msg && <div className="kit-card warn pad" style={{ marginBottom: 10, padding: '10px 14px', fontSize: 13 }}>{msg}</div>}

      {/* ── O QUADRO (auto-derivado, a verdade) ── */}
      {boardErr && <div className="kit-card bad pad" style={{ marginBottom: 10 }}>Quadro indisponível: {boardErr}</div>}
      {!board && !boardErr && <div className="pl-empty">Carregando o funil…</div>}
      {board && (
        <div className="pl-board" data-pl-board>
          {board.columns.map((c) => (
            <div className="pl-col" key={c.id} data-pl-col={c.id}>
              <div className="pl-col-head">
                <span className="kit-mlabel">{c.title}</span>
                <span className={'kit-chip ' + (COL_CHIP[c.id] || 'neutral')}>{c.count}</span>
              </div>
              {c.cards.length === 0 && <div className="pl-empty">Nada aqui.</div>}
              {c.cards.map((card) => (
                <BoardCard key={card.batch_number} card={card} canWrite={canWrite}
                           onAdd={addCard} onToggleBoxed={toggleBoxed}/>
              ))}
            </div>
          ))}
        </div>
      )}
      {board && !board.ems_ok && (
        <div className="pl-empty" style={{ marginBottom: 4 }}>Fila viva do EMS indisponível agora; o quadro mostra o último estado sincronizado.</div>
      )}

      {/* ── O PLANO + NOTAS ── */}
      <div className="kit-mlabel" style={{ margin: '18px 0 8px' }}>Plano · arraste do quadro ou use o +</div>
      <div className="pl-tabs" style={{ marginBottom: 10 }}>
        {tabs.map((t) => (
          <button key={t.date} className={'pl-tab' + (t.date === date ? ' on' : '')}
                  onClick={() => setDate(t.date)}>{t.label}</button>
        ))}
      </div>

      <div className="pl-grid">
        <div>
          <div className={'pl-lane' + (laneOver ? ' over' : '')} data-pl-lane
               onDragOver={(e) => { e.preventDefault(); setLaneOver(true); }}
               onDragLeave={() => setLaneOver(false)}
               onDrop={(e) => {
                 e.preventDefault(); setLaneOver(false);
                 if (dragIdx != null) { reorder(dragIdx, overIdx != null ? overIdx : items.length - 1); setDragIdx(null); setOverIdx(null); return; }
                 try {
                   const card = JSON.parse(e.dataTransfer.getData('text/plain'));
                   if (card && card.batch_number) addCard(card);
                 } catch (err) { /* payload de fora, ignora */ }
               }}>
            {items.length === 0 && <div className="pl-empty">Solte um cartão aqui, ou clique no + de um cartão do quadro.</div>}
            {items.map((i, idx) => {
              const live = liveOf(i);
              const donezinho = live && (live.column === 'produced' || live.column === 'boxed');
              return (
                <div key={i.id || 'n' + idx}
                     className={'pl-item' + (dragIdx === idx ? ' dragging' : '') + (overIdx === idx && dragIdx != null && dragIdx !== idx ? ' over' : '')}
                     draggable
                     onDragStart={(e) => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'reorder'); }}
                     onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                     onDragOver={(e) => { e.preventDefault(); if (dragIdx != null) setOverIdx(idx); }}
                     onDrop={(e) => {
                       e.preventDefault(); e.stopPropagation(); setLaneOver(false);
                       if (dragIdx != null) { reorder(dragIdx, idx); setDragIdx(null); setOverIdx(null); return; }
                       try {
                         const card = JSON.parse(e.dataTransfer.getData('text/plain'));
                         if (card && card.batch_number) addCard(card);
                       } catch (err) { /* ignora */ }
                     }}>
                  <span style={{ color: 'var(--ink-faint)', cursor: 'grab', fontSize: 14 }}>⠿</span>
                  <span className="t">{itemLabel(i)}</span>
                  {/* estágio AO VIVO re-derivado: planejou e já saiu → ✓ verde sozinho */}
                  {donezinho && <span className="kit-chip ok">✓ {live.title}</span>}
                  {live && !donezinho && <span className={'kit-chip ' + (COL_CHIP[live.column] || 'neutral')}>{live.title}</span>}
                  {!live && !i.custom_title && <span className="kit-chip neutral">fora do quadro</span>}
                  {canWrite && <button className="x" title="Remover do plano" onClick={() => removeItem(idx)}>×</button>}
                </div>
              );
            })}
          </div>
          {canWrite && (
            <button className="kit-btn sec sm" style={{ marginTop: 9 }} onClick={addCustom} data-pl-addcustom>
              + Adicionar item livre
            </button>
          )}
        </div>

        <div className="kit-card pad pl-notes" data-pl-notes>
          <div className="kit-mlabel" style={{ marginBottom: 7 }}>Anotações · {tabs.find((t) => t.date === date)?.label || date}</div>
          <textarea value={note} onChange={(e) => onNote(e.target.value)}
                    placeholder="Anote aqui o plano do dia: prioridades, quem faz o quê, avisos."
                    readOnly={!canWrite}/>
          <div className="pl-empty" style={{ marginTop: 5 }}>
            {noteDirty.current ? 'Salvando…'
              : noteSavedAt ? 'Salvo ' + new Date(noteSavedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                : 'Nada salvo ainda.'}
          </div>
        </div>
      </div>
    </div>
  );
}
