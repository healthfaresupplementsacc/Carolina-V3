/* Card de Notificações — E7 refinamentos
   #3 max 5 visíveis + scroll
   #4 clicar notif abre detalhe inline
   #5 agrupa por (pessoa + tipo) com badge
   #6 detalhe de gap tem form de justificar/ajustar (preview · liga no E5)

   Tudo leitura (preview-only). Saves toastam pelo callback `ack`.
   Layout em ABAS pra alinhar com o que o Bruno pediu:
   - estilo flat, navegação inline (sem modal por cima)
   - quando expandido, o conteúdo ocupa o lugar do header de notif

   Props: { notifs, gearOpen, onGear, onCloseGear, ack, operators,
            events, GearButton, EditPopover, EditList, V4_ALLOW_WRITES }
*/
import React from 'react';
import { Icon } from './Icons.jsx';
import { FloatingPopover } from './FloatingPopover.jsx';

const GAP_NOTIFY_THRESHOLD_MIN = 25;        // mantém consistente com CommandCenter
const MAX_VISIBLE = 5;
const ROW_PX = 52;                          // altura aprox de um alert-row
const ROW_GAP = 8;
const NOTIF_LIST_MAX_H = MAX_VISIBLE * ROW_PX + (MAX_VISIBLE - 1) * ROW_GAP; // ~292

/** Deriva o tipo da notif a partir do id ou _type. */
function typeOf(n) {
  if (n._type) return n._type;
  if (typeof n.id === 'string' && n.id.startsWith('gap')) return 'gap';
  return String(n.id || 'other');
}

/** Título mostrado num cabeçalho de grupo. */
function groupTitle(group, operators) {
  if (group.type === 'gap') {
    const op = operators.find((o) => o.id === group.personKey);
    return op ? `Gaps em ${op.name}` : 'Gaps';
  }
  // Globais (dup/inv/down/open) → usa o título da primeira ocorrência
  return (group.items[0] && group.items[0].title) || group.type;
}

/** Pior severidade do grupo, pra ordenar/colorir. */
function worstSeverity(items) {
  if (items.some((i) => i.severity === 'bad')) return 'bad';
  if (items.some((i) => i.severity === 'warn')) return 'warn';
  return 'info';
}

export function NotificationsCard({
  notifs,
  visibleThreshold,
  openNotifId, onNotifClick,
  pendingDrafts, onDraftChange, onDraftClear,
  // E6 #4: anchor captura click coords pra abrir caixa flutuante perto
  gearOpen, gearAnchor, onGear, onCloseGear, ack, operators = [], events = [],
  GearButton, EditPopover, EditList, V4_ALLOW_WRITES,
  onCreateInGap,                  // (E5) cria event retroativo no gap
  writes,                         // (E5) wrapper de write helpers (correio PATCH)
}) {
  const [expandedKey, setExpandedKey] = React.useState(null);   // grupo aberto (#5)
  // E6 #4: anchor (x,y) do clique que abriu o detalhe atual
  const [notifAnchor, setNotifAnchor] = React.useState(null);

  // Filtragem de visibilidade: gaps < visibleThreshold são ocultos do card,
  // mas continuam clicáveis via PersonExpansion (E7-refine2 #3).
  const visibleNotifs = React.useMemo(() => {
    if (visibleThreshold == null) return notifs;
    return notifs.filter((n) => !(n._type === 'gap' && (n._dur_min || 0) < visibleThreshold));
  }, [notifs, visibleThreshold]);

  // Achata o notif a partir do id aberto (lookup em TODOS notifs, não só visíveis)
  const openNotif = React.useMemo(() => {
    if (!openNotifId) return null;
    return notifs.find((n) => n.id === openNotifId) || null;
  }, [openNotifId, notifs]);

  // Agrupa por (pessoa + tipo) — só visíveis
  const groups = React.useMemo(() => {
    const m = new Map();
    for (const n of visibleNotifs) {
      const type = typeOf(n);
      const personKey = n._op || 'global';
      const key = `${personKey}::${type}`;
      if (!m.has(key)) m.set(key, { key, type, personKey, items: [] });
      m.get(key).items.push(n);
    }
    return [...m.values()].sort((a, b) => {
      const order = { bad: 0, warn: 1, info: 2 };
      return order[worstSeverity(a.items)] - order[worstSeverity(b.items)];
    });
  }, [visibleNotifs]);

  const totalNotifs = visibleNotifs.length;

  return (
    <div className="card notif-card" style={{ marginTop: 14, padding: 14, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon name="bell" size={14} color="var(--hf-leaf-500)"/>
        <b style={{ fontSize: 13, letterSpacing: '-0.005em' }}>Notificações</b>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>· Notifications</span>
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {totalNotifs} ativa{totalNotifs === 1 ? '' : 's'}
          {totalNotifs > MAX_VISIBLE && <span style={{ marginLeft: 4, opacity: 0.7 }}>(role pra ver mais)</span>}
        </span>
        <GearButton onClick={onGear} active={gearOpen}/>
        <EditPopover open={gearOpen} anchor={gearAnchor} onClose={onCloseGear} title="Configurar notificações">
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
            Limites e canais de notificação ficarão editáveis aqui.
          </div>
          <EditList items={[
                       { id: 'gap', label: `Gap notificável (atual: ${GAP_NOTIFY_THRESHOLD_MIN}min)` },
                       { id: 'unreported', label: 'Não-reportado (60min)' },
                       { id: 'downtime', label: 'Downtime (qualquer)' },
                     ]}
                    emptyMsg=""
                    onAdd={() => ack('preview · adicionar tipo de notif liga no E5')}
                    onEdit={(it) => ack(`preview · editar ${it.id} liga no E5`)}
                    onDelete={(it) => ack(`preview · desligar ${it.id} liga no E5`)}/>
        </EditPopover>
      </div>

      {/* Lista de notifs — max 5 visíveis + scroll (#3) */}
      <div className="notif-list" style={{
        maxHeight: NOTIF_LIST_MAX_H, overflowY: 'auto', paddingRight: 4,
      }}>
        {groups.length === 0 ? (
          <div style={{ padding: 12, fontSize: 13, color: 'var(--text-3)', textAlign: 'center' }}>
            nenhuma notificação · all clear
          </div>
        ) : groups.map((group) => (
          <GroupRow
            key={group.key}
            group={group}
            operators={operators}
            expanded={expandedKey === group.key}
            onToggleExpand={() => setExpandedKey(expandedKey === group.key ? null : group.key)}
            onOpenSingle={(n, coords) => { setNotifAnchor(coords); onNotifClick && onNotifClick(n.id); }}
            openNotifId={openNotifId}
            pendingDrafts={pendingDrafts}
          />
        ))}
      </div>

      {/* E6 #4 — Detalhe agora abre como FloatingPopover perto do clique
            (mesma caixa do SidePanel — fica POR CIMA, sem ser cortada pelo card). */}
      <FloatingPopover
        open={!!openNotif}
        anchor={notifAnchor}
        width={420}
        above={false}
        draggable={true}
        onClose={() => onNotifClick && onNotifClick(openNotif && openNotif.id)}
        anchorSelector=".notif-clickable"
        header={openNotif && (
          <>
            <span style={{ color: 'var(--text-3)', fontSize: 14, fontWeight: 700 }}>⋮⋮</span>
            <Icon name="bell" size={14}/>
            <b style={{ fontSize: 13, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {openNotif.title}
            </b>
            <button className="icon-btn" onClick={() => onNotifClick && onNotifClick(openNotif.id)} style={{ padding: 4 }}>
              <Icon name="x" size={11}/>
            </button>
          </>
        )}>
        {openNotif && (
          <NotifDetail
            notif={openNotif}
            operators={operators}
            events={events}
            pending={(pendingDrafts && pendingDrafts[openNotif.id]) || null}
            onDraftChange={(d) => onDraftChange && onDraftChange(openNotif.id, d)}
            onClose={() => onNotifClick && onNotifClick(openNotif.id)}
            onSaved={() => { if (onDraftClear) onDraftClear(openNotif.id); if (onNotifClick) onNotifClick(openNotif.id); }}
            ack={ack}
            V4_ALLOW_WRITES={V4_ALLOW_WRITES}
            onCreateInGap={onCreateInGap}
            writes={writes}
            embeddedInFloating={true}
          />
        )}
      </FloatingPopover>
    </div>
  );
}

/* Linha de grupo: se tem >1 item, mostra como header com badge expansível.
   Se tem só 1, mostra como notif normal clicável. Toggle: click no mesmo
   item de novo fecha (E7-refine2 #4). Badge "pending" se há draft. */
function GroupRow({ group, operators, expanded, onToggleExpand, onOpenSingle, openNotifId, pendingDrafts }) {
  const isMulti = group.items.length > 1;
  const sev = worstSeverity(group.items);

  if (!isMulti) {
    const n = group.items[0];
    const isOpen = openNotifId === n.id;
    const hasPending = pendingDrafts && pendingDrafts[n.id];
    return (
      <button className={`alert-row ${sev} notif-clickable ${isOpen ? 'notif-open' : ''}`}
              onClick={(e) => onOpenSingle(n, { x: e.clientX, y: e.clientY })}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>
        <div className="ico"><Icon name="bell" size={14}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">
            {n.title}
            {n.en && <span style={{ color: 'var(--text-3)', fontWeight: 500, fontSize: 11.5 }}> · {n.en}</span>}
            {hasPending && <span className="pill warn" style={{ marginLeft: 6, fontSize: 10 }}><span className="dot"/>pending</span>}
          </div>
          <div className="sub">{n.detail}</div>
        </div>
        <span style={{
          display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.16s ease', color: 'var(--text-3)', fontSize: 12,
        }}>▶</span>
      </button>
    );
  }

  const title = groupTitle(group, operators);
  return (
    <>
      <button className={`alert-row ${sev} notif-clickable notif-group`}
              onClick={onToggleExpand}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>
        <div className="ico" style={{ position: 'relative' }}>
          <Icon name="bell" size={14}/>
          <span className="notif-badge">{group.items.length}</span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">{title}</div>
          <div className="sub">{group.items.length} ocorrência(s) · clique para abrir</div>
        </div>
        <span style={{
          display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.16s ease', color: 'var(--text-3)',
        }}>▶</span>
      </button>
      {expanded && (
        <div className="notif-group-items">
          {group.items.map((n) => {
            const isOpen = openNotifId === n.id;
            const hasPending = pendingDrafts && pendingDrafts[n.id];
            return (
              <button key={n.id}
                      className={`alert-row ${n.severity || 'info'} notif-clickable notif-child ${isOpen ? 'notif-open' : ''}`}
                      onClick={(e) => onOpenSingle(n, { x: e.clientX, y: e.clientY })}
                      style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>
                <div className="ico"><Icon name="bell" size={11}/></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="title" style={{ fontSize: 12 }}>
                    {n.title}
                    {hasPending && <span className="pill warn" style={{ marginLeft: 6, fontSize: 9 }}><span className="dot"/>pending</span>}
                  </div>
                  <div className="sub">{n.detail}</div>
                </div>
                <span style={{
                  display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.16s ease', color: 'var(--text-3)', fontSize: 10,
                }}>▶</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/* Detalhe inline de uma notificação (single). Pra gap, tem form de
   justificar/ajustar adjacentes — preview-only enquanto V4_ALLOW_WRITES=0.
   E7-refine2 #4: pending — recebe `pending` (draft anterior) e chama
   onDraftChange a cada digitação. Se fechar mid-edit, parent guarda. */
// Bug #1 bloco 29/mai: extrai HH:MM do ISO "2026-05-29T14:44:39-04:00" → minutos do dia.
function toMinFromIso(iso) {
  if (!iso) return null;
  const s = String(iso);
  const h = Number(s.slice(11, 13)), m = Number(s.slice(14, 16));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function NotifDetail({ notif, operators, events, pending, onDraftChange, onClose, onSaved, ack, V4_ALLOW_WRITES, onCreateInGap, writes, embeddedInFloating = false }) {
  const type = typeOf(notif);
  const op = notif._op ? operators.find((o) => o.id === notif._op) : null;
  const { fmtClock, fmtDur } = window.HFH;

  // Para gaps: encontra os events ligados (antes e depois)
  const linkedEvents = React.useMemo(() => {
    if (type !== 'gap' || !notif._op) return null;
    const opEvents = events.filter((e) => e.op === notif._op)
                            .sort((a, b) => a.started_min - b.started_min);
    const before = opEvents.find((e) => (e.ended_min ?? Infinity) === notif._start);
    const after  = opEvents.find((e) => e.started_min === notif._end);
    return { before, after };
  }, [type, notif._op, notif._start, notif._end, events]);

  // Form state inicializado do pending (se existir) ou defaults.
  // Para 'correio': time + label. Para 'gap': reason + reasonCat. Para outros:
  // só um campo "nota" livre.
  const [form, setForm] = React.useState(() => ({
    reason: '',
    reasonCat: 'outro',
    correioTime: notif._deadline_hhmm || '13:00',
    correioLabel: notif._label || 'Corte do correio',
    note: '',
    ...(pending || {}),
  }));
  // Quando muda de notif (mudou o id), reinicializa
  React.useEffect(() => {
    setForm({
      reason: '',
      reasonCat: 'outro',
      correioTime: notif._deadline_hhmm || '13:00',
      correioLabel: notif._label || 'Corte do correio',
      note: '',
      ...(pending || {}),
    });
  }, [notif.id]);   // eslint-disable-line
  // Bubble do draft pro parent (cada change)
  React.useEffect(() => {
    if (!onDraftChange) return;
    onDraftChange(form);
  }, [form]);   // eslint-disable-line

  const reasonOptions = [
    { value: 'almoco',    label: 'Almoço (não registrou)' },
    { value: 'pausa',     label: 'Pausa curta' },
    { value: 'limpeza',   label: 'Limpeza/setup' },
    { value: 'transicao', label: 'Transição entre tarefas' },
    { value: 'outro',     label: 'Outro motivo' },
  ];

  const onPreview = async () => {
    // E5 — chamadas reais. V4_ALLOW_WRITES=0 cai no fallback preview-only.
    if (type === 'gap' && onCreateInGap && V4_ALLOW_WRITES) {
      const gap = { start: notif._start, end: notif._end, dur: notif._dur_min || (notif._end - notif._start) };
      await onCreateInGap(notif._op, gap, { reasonCat: form.reasonCat, note: form.reason });
      if (onSaved) onSaved();
      return;
    }
    if (type === 'correio' && writes && V4_ALLOW_WRITES) {
      // PATCH /deadlines/:id
      const [h, m] = String(form.correioTime).split(':').map(Number);
      const time_of_day = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
      const res = await writes.patchDeadline(notif._deadline_id, { time_of_day, label: form.correioLabel });
      if (!res.ok) { ack(`Erro correio: ${res.error.message || res.error}`); return; }
      ack(`Correio atualizado ✓ ${form.correioTime}`);
      if (onSaved) onSaved();
      return;
    }
    // Fallback (read-only OU outros tipos sem ação ainda)
    if (type === 'gap') ack(`preview · justificar gap ${op?.name || '?'} (V4_ALLOW_WRITES=0)`);
    else if (type === 'correio') ack(`preview · correio (V4_ALLOW_WRITES=0)`);
    else ack(`preview · resolver ${notif.title}`);
    if (onSaved) onSaved();
  };

  // E6 #4: quando embedded em FloatingPopover, dispensa wrapper/header próprios
  const Wrapper = embeddedInFloating
    ? ({ children: c }) => <div>{c}</div>
    : ({ children: c }) => (
      <div className="notif-detail" style={{
        marginTop: 10, padding: 12, background: 'var(--surface-2)',
        border: '1px solid var(--border)', borderRadius: 8, position: 'relative',
      }}>
        <button className="icon-btn" onClick={onClose}
                style={{ position: 'absolute', top: 8, right: 8, padding: 4 }}
                aria-label="Fechar detalhe">
          <Icon name="x" size={12}/>
        </button>
        {c}
      </div>
    );

  return (
    <Wrapper>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, marginBottom: 6 }}>
        Detalhe · {type}
      </div>
      {!embeddedInFloating && <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{notif.title}</div>}
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>{notif.detail}</div>

      {type === 'gap' && linkedEvents && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>Antes do gap</div>
              {linkedEvents.before ? (
                <>
                  <b>ev{linkedEvents.before.id}</b><br/>
                  <span className="mono">{fmtClock(linkedEvents.before.started_min)} → {fmtClock(linkedEvents.before.ended_min)}</span>
                </>
              ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
            </div>
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }}>
              <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>Depois do gap</div>
              {linkedEvents.after ? (
                <>
                  <b>ev{linkedEvents.after.id}</b><br/>
                  <span className="mono">{fmtClock(linkedEvents.after.started_min)} → {linkedEvents.after.ended_min == null ? 'agora' : fmtClock(linkedEvents.after.ended_min)}</span>
                </>
              ) : <span style={{ color: 'var(--text-3)' }}>—</span>}
            </div>
          </div>

          {/* Form de justificar (preview · liga no E5) */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
              Motivo do gap
            </label>
            <select value={form.reasonCat} onChange={(e) => setForm((f) => ({ ...f, reasonCat: e.target.value }))} className="input">
              {reasonOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
              Nota livre
            </label>
            <textarea className="input" rows={2} value={form.reason}
                      onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                      placeholder="(opcional) ex: foi limpar a linha 2 depois do encapsulamento"/>
          </div>
        </>
      )}

      {type === 'correio' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
                Horário do corte
              </label>
              <input type="time" className="input" value={form.correioTime}
                     onChange={(e) => setForm((f) => ({ ...f, correioTime: e.target.value }))}/>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
                Etiqueta
              </label>
              <input type="text" className="input" value={form.correioLabel}
                     onChange={(e) => setForm((f) => ({ ...f, correioLabel: e.target.value }))}
                     placeholder="Corte do correio"/>
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 10, fontStyle: 'italic' }}>
            v3.deadlines tem 1 entrada ativa (id={notif._deadline_id || '?'}, flow=pnp). Salvar virará
            <code> PATCH /api/v3/data/deadlines/{notif._deadline_id || '?'}</code> no E5.
          </div>
        </>
      )}

      {/* Bug #1 bloco 29/mai: lista detalhada dos events inválidos clicável. */}
      {notif.id === 'inv' && (notif._invalid_events || []).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, marginBottom: 6 }}>
            Events afetados — clique pra abrir
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflow: 'auto' }}>
            {(notif._invalid_events || []).map((ie) => {
              const ev = events.find((e) => e.id === ie.event_id);
              return (
                <button key={ie.event_id}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (ev && notif._onOpenInvalid) notif._onOpenInvalid(ev, { x: e.clientX, y: e.clientY });
                        }}
                        style={{
                          textAlign: 'left', padding: '6px 8px', borderRadius: 6,
                          background: 'var(--surface)', border: '1px solid var(--bad-line, #f5cdc7)',
                          cursor: ev ? 'pointer' : 'default', fontSize: 11.5,
                          color: 'var(--ink)',
                        }}>
                  <b className="mono">ev{ie.event_id}</b>
                  {ie.person && <> · {ie.person}</>}
                  {ie.activity && <> · {ie.activity}</>}
                  {ie.started_at && (
                    <> · <span className="mono">{fmtClock(toMinFromIso(ie.started_at))}{ie.ended_at ? `→${fmtClock(toMinFromIso(ie.ended_at))}` : '→?'}</span></>
                  )}
                  <div style={{ fontSize: 10.5, color: 'var(--bad, #dc2626)', marginTop: 2, fontWeight: 600 }}>
                    {ie.reason || 'duração inválida'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {type !== 'gap' && type !== 'correio' && notif.id !== 'inv' && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, marginBottom: 10 }}>
          Edição/resolução completa deste tipo de notificação fica pro E5.
          <div style={{ marginTop: 6 }}>
            <textarea className="input" rows={2} value={form.note}
                      onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                      placeholder="(opcional) nota sobre essa notificação"/>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={onPreview}>
          {type === 'gap' ? 'Salvar justificativa'
            : type === 'correio' ? 'Salvar correio'
            : 'Marcar como resolvido'}
        </button>
        <button className="btn ghost" onClick={onClose}>Fechar</button>
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic', alignSelf: 'center' }}>
          {V4_ALLOW_WRITES ? 'salvar persiste em prod' : 'modo leitura · fecha sem salvar → pending'}
        </span>
      </div>
    </Wrapper>
  );
}
