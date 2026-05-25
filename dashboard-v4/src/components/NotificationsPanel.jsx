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
  notifs, gearOpen, onGear, onCloseGear, ack, operators = [], events = [],
  GearButton, EditPopover, EditList, V4_ALLOW_WRITES,
}) {
  const [expandedKey, setExpandedKey] = React.useState(null);   // chave do grupo aberto (#5)
  const [openNotif, setOpenNotif] = React.useState(null);       // notif individual em detalhe (#4)

  // Agrupa por (pessoa + tipo)
  const groups = React.useMemo(() => {
    const m = new Map();
    for (const n of notifs) {
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
  }, [notifs]);

  const totalNotifs = notifs.length;

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
        <EditPopover open={gearOpen} onClose={onCloseGear} title="Configurar notificações">
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
            onOpenSingle={setOpenNotif}
          />
        ))}
      </div>

      {/* Detalhe inline aparece abaixo da lista quando uma notif é clicada (#4 / #6) */}
      {openNotif && (
        <NotifDetail
          notif={openNotif}
          operators={operators}
          events={events}
          onClose={() => setOpenNotif(null)}
          ack={ack}
          V4_ALLOW_WRITES={V4_ALLOW_WRITES}
        />
      )}
    </div>
  );
}

/* Linha de grupo: se tem >1 item, mostra como header com badge expansível.
   Se tem só 1, mostra como notif normal clicável. */
function GroupRow({ group, operators, expanded, onToggleExpand, onOpenSingle }) {
  const isMulti = group.items.length > 1;
  const sev = worstSeverity(group.items);

  if (!isMulti) {
    const n = group.items[0];
    return (
      <button className={`alert-row ${sev} notif-clickable`}
              onClick={() => onOpenSingle(n)}
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>
        <div className="ico"><Icon name="bell" size={14}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="title">
            {n.title}
            {n.en && <span style={{ color: 'var(--text-3)', fontWeight: 500, fontSize: 11.5 }}> · {n.en}</span>}
          </div>
          <div className="sub">{n.detail}</div>
        </div>
        <Icon name="right" size={12}/>
      </button>
    );
  }

  // Grupo com badge
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
          {group.items.map((n) => (
            <button key={n.id}
                    className={`alert-row ${n.severity || 'info'} notif-clickable notif-child`}
                    onClick={() => onOpenSingle(n)}
                    style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}>
              <div className="ico"><Icon name="bell" size={11}/></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title" style={{ fontSize: 12 }}>{n.title}</div>
                <div className="sub">{n.detail}</div>
              </div>
              <Icon name="right" size={11}/>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* Detalhe inline de uma notificação (single). Pra gap, tem form de
   justificar/ajustar adjacentes — preview-only enquanto V4_ALLOW_WRITES=0. */
function NotifDetail({ notif, operators, events, onClose, ack, V4_ALLOW_WRITES }) {
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

  const [reason, setReason] = React.useState('');
  const [reasonCat, setReasonCat] = React.useState('outro');

  const reasonOptions = [
    { value: 'almoco',    label: 'Almoço (não registrou)' },
    { value: 'pausa',     label: 'Pausa curta' },
    { value: 'limpeza',   label: 'Limpeza/setup' },
    { value: 'transicao', label: 'Transição entre tarefas' },
    { value: 'outro',     label: 'Outro motivo' },
  ];

  const onPreview = () => {
    if (type === 'gap') {
      ack(`preview · justificar gap ${op?.name || '?'} (${reasonCat}) — POST /events/${linkedEvents?.before?.id}/justify liga no E5`);
    } else {
      ack(`preview · resolver ${notif.title} — liga no E5`);
    }
  };

  return (
    <div className="notif-detail" style={{
      marginTop: 10, padding: 12,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
      borderRadius: 8, position: 'relative',
    }}>
      <button className="icon-btn" onClick={onClose}
              style={{ position: 'absolute', top: 8, right: 8, padding: 4 }}
              aria-label="Fechar detalhe">
        <Icon name="x" size={12}/>
      </button>

      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.06, fontWeight: 700, marginBottom: 6 }}>
        Detalhe · {type}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{notif.title}</div>
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
            <select value={reasonCat} onChange={(e) => setReasonCat(e.target.value)} className="input">
              {reasonOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', marginBottom: 4 }}>
              Nota livre
            </label>
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                      placeholder="(opcional) ex: foi limpar a linha 2 depois do encapsulamento"/>
          </div>
        </>
      )}

      {type !== 'gap' && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', padding: '8px 10px', background: 'var(--surface)', borderRadius: 6, marginBottom: 10 }}>
          Edição/resolução completa deste tipo de notificação fica pro E5.
          Por enquanto, marcar como visto/resolvido só toasta preview.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={onPreview}>
          {type === 'gap' ? 'Salvar justificativa' : 'Marcar como resolvido'}
        </button>
        <button className="btn ghost" onClick={onClose}>Cancelar</button>
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontStyle: 'italic', alignSelf: 'center' }}>
          {V4_ALLOW_WRITES ? 'salvar persiste' : 'modo leitura · save liga no E5'}
        </span>
      </div>
    </div>
  );
}
