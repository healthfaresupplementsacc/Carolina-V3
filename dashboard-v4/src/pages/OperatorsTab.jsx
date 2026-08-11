/* HEALTHFARE V4 — aba OPERADORES nativa (FASE 2b — unificação).

   Porta pro dashboard tudo que só existia no /admin legado (src/admin/app.js):
   criar operador, PIN, auto-logoff, count-exempt, ativar/desativar, forçar
   logout, remover (soft-delete), timeline 7d e o EDITOR DE ESCALA por dia da
   semana (v3.operator_schedules) — a "organização dia a dia" do Bruno.

   ESTILO: usa os MESMOS primitivos das outras abas (components/AdminBits.jsx:
   useAdmin/Loading/ErrBox/SecTitle/Empty/MiniKPI) e as MESMAS classes do V4
   (.card, .btn sm ghost/primary/danger, .input, .pill, .kpi-grid, .filters).
   Nada de fetch próprio nem botão inline — se precisar de um primitivo novo,
   ele nasce no AdminBits, não aqui.

   Auth = cookie hf_admin (adapters/admin-api.js), a mesma do resto do painel;
   RBAC e auditoria (v3.audit_log) seguem enforçados no servidor. Writes
   respeitam V4_ALLOW_WRITES: desligado, a UI vira preview e não chama a API.
*/
import React from 'react';
import { adminGet, adminPost, adminPut, adminDelete } from '../adapters/admin-api.js';
import { useAdmin, AdminGate, SecTitle, Empty, Loading, ErrBox, RefreshErr, MiniKPI } from '../components/AdminBits.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';

/* Página do menu Admin → "Operadores" (rota `operadores` no Shell/App).
   Mesmo login/gate das outras páginas admin; o miolo é a <OperatorsTab/>. */
export function OperatorsPage() {
  return <AdminGate title="Operadores">{() => <OperatorsTab/>}</AdminGate>;
}

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// erros do backend → PT (mesmas chaves do legado)
const ERR = {
  name_taken: 'Nome já existe', pin_taken: 'PIN já usado por outro operador',
  bad_pin_format: 'PIN precisa de 4 dígitos', end_before_start: 'Fim antes do início',
  bad_time: 'Hora inválida', bad_seconds: 'Segundos fora de 5–3600',
  operator_not_found: 'Operador não encontrado', bad_params: 'Parâmetros inválidos',
  // retroativo (mesmas mensagens do /admin legado)
  too_old: 'Máximo 7 dias atrás', started_at_future: 'Hora no futuro',
  ended_at_invalid: 'Fim inválido', justification_required: 'Justificativa obrigatória',
  unknown_batch: 'Lote não encontrado', unknown_activity_slug: 'Tarefa inválida',
  note_required: 'Nota obrigatória', orders_printed_required: 'Qtd de ordens obrigatória',
  started_at_required: 'Hora de início obrigatória',
};
const msg = (e) => ERR[e && e.message] || (e && e.message) || 'erro';

const rel = (iso) => {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min}min`;
  if (min < 1440) return `há ${Math.round(min / 60)}h`;
  return `há ${Math.round(min / 1440)}d`;
};

export function OperatorsTab() {
  // nonce = força o refetch depois de cada escrita (mesmo padrão de deps das outras abas)
  const [nonce, setNonce] = React.useState(0);
  const { data, loading, error } = useAdmin('/operators', [nonce]);
  const [selId, setSelId] = React.useState(null);
  const [creating, setCreating] = React.useState(false);
  const [flash, setFlash] = React.useState('');
  const ro = !V4_ALLOW_WRITES;

  const ack = React.useCallback((m) => { setFlash(m); setTimeout(() => setFlash(''), 2200); }, []);
  const reload = React.useCallback(() => setNonce((n) => n + 1), []);

  if (loading && !data) return <Loading/>;
  if (error && !data) return <ErrBox error={error}/>;

  const ops = (data && data.operators) || [];
  const sel = ops.find((o) => o.id === selId) || null;
  const actives = ops.filter((o) => o.is_active).length;
  const online = ops.reduce((a, o) => a + (o.active_session_count > 0 ? 1 : 0), 0);

  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <button className="btn sm primary" onClick={() => { setCreating((v) => !v); setSelId(null); }}>
          {creating ? 'Cancelar' : '+ Novo operador'}
        </button>
        {ro && <span style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>modo leitura — botões não gravam</span>}
        <span style={{ flex: 1 }}/>
        {flash && (
          <span style={{ fontSize: 12, fontWeight: 600, color: flash.startsWith('❌') ? 'var(--bad)' : 'var(--hf-leaf-700)' }}>{flash}</span>
        )}
      </div>

      <div className="kpi-grid">
        <MiniKPI label="Operadores" value={ops.length} suffix="cadastrados"/>
        <MiniKPI label="Ativos" value={actives} suffix=""/>
        <MiniKPI label="Com sessão aberta" value={online} suffix="agora"/>
      </div>

      {creating && (
        <CreateForm ro={ro} ack={ack}
                    onDone={(ok) => { setCreating(false); if (ok) { ack('✅ operador criado'); reload(); } }}/>
      )}

      <div className="card" style={{ marginTop: 12, padding: 14 }}>
        <SecTitle>Operadores</SecTitle>
        {ops.length === 0 ? <Empty msg="Nenhum operador cadastrado"/> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))', gap: 10 }}>
            {ops.map((o) => (
              <div key={o.id} className="card" style={{ padding: 11, opacity: o.is_active ? 1 : 0.55 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13.5 }}>{o.display_name}</b>
                  <span className={'pill ' + (o.is_active ? 'ok' : '')}>{o.is_active ? 'ativo' : 'inativo'}</span>
                  {o.active_session_count > 0 && <span className="pill prod">{o.active_session_count} sessão</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6, lineHeight: 1.5 }}>
                  Auto-logoff: <b>{o.auto_logoff_seconds == null ? 'desligado' : o.auto_logoff_seconds + 's'}</b>
                  {' · '}Pula contagem: <b>{o.count_exempt ? 'sim' : 'não'}</b><br/>
                  Login: {rel(o.last_page_login_at)} · Evento: {rel(o.last_event_at)}
                </div>
                <button className="btn sm ghost" style={{ marginTop: 9 }}
                        onClick={() => { setSelId(selId === o.id ? null : o.id); setCreating(false); }}>
                  {selId === o.id ? 'Fechar' : 'Gerenciar'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {sel && <OperatorDetail op={sel} ro={ro} ack={ack} reload={reload} onClose={() => setSelId(null)}/>}
      {error && <RefreshErr error={error}/>}
    </div>
  );
}

// ── criar ────────────────────────────────────────────────
function CreateForm({ onDone, ro, ack }) {
  const [f, setF] = React.useState({ name: '', pin: '', logoff: '30', exempt: false });
  const [busy, setBusy] = React.useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: k === 'exempt' ? e.target.checked : e.target.value }));

  async function go() {
    if (!f.name.trim()) { ack('❌ nome obrigatório'); return; }
    if (!/^\d{4}$/.test(f.pin)) { ack('❌ PIN precisa de 4 dígitos'); return; }
    if (ro) { ack('preview · criaria ' + f.name.trim()); onDone(false); return; }
    setBusy(true);
    try {
      await adminPost('/operators', {
        display_name: f.name.trim(), pin: f.pin,
        auto_logoff_seconds: f.logoff === '' ? null : parseInt(f.logoff, 10),
        count_exempt: f.exempt,
      });
      onDone(true);
    } catch (e) { ack('❌ ' + msg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 14 }}>
      <SecTitle>Novo operador</SecTitle>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" value={f.name} onChange={set('name')} placeholder="nome" style={{ flex: '1 1 180px' }}/>
        <input className="input" value={f.pin} onChange={set('pin')} placeholder="PIN (4 dígitos)" inputMode="numeric" maxLength={4} style={{ width: 130 }}/>
        <input className="input" value={f.logoff} onChange={set('logoff')} type="number" min={5} max={3600} placeholder="auto-logoff (s)" style={{ width: 145 }}/>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={f.exempt} onChange={set('exempt')}/> pula contagem
        </label>
        <button className="btn sm primary" onClick={go} disabled={busy}>{busy ? 'Criando…' : 'Criar'}</button>
        <button className="btn sm ghost" onClick={() => onDone(false)}>Cancelar</button>
      </div>
    </div>
  );
}

// ── detalhe / gerenciar ──────────────────────────────────
function OperatorDetail({ op, ro, ack, reload, onClose }) {
  const [pin, setPin] = React.useState('');
  const [logoff, setLogoff] = React.useState(op.auto_logoff_seconds == null ? '' : String(op.auto_logoff_seconds));
  const [showSched, setShowSched] = React.useState(false);
  const [showRetro, setShowRetro] = React.useState(false);
  const [events, setEvents] = React.useState(null);

  // troca de operador selecionado → limpa o form
  React.useEffect(() => {
    setPin('');
    setLogoff(op.auto_logoff_seconds == null ? '' : String(op.auto_logoff_seconds));
    setShowSched(false); setShowRetro(false); setEvents(null);
  }, [op.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = (label, fn) => async () => {
    if (ro) { ack('preview · ' + label); return; }
    try { await fn(); } catch (e) { ack('❌ ' + msg(e)); }
  };

  const savePin = guard('PIN', async () => {
    if (!/^\d{4}$/.test(pin)) { ack('❌ PIN precisa de 4 dígitos'); return; }
    await adminPost(`/operators/${op.id}/pin`, { pin });
    setPin(''); ack('✅ PIN atualizado');
  });

  const saveLogoff = guard('auto-logoff', async () => {
    await adminPut(`/operators/${op.id}/auto-logoff`, { seconds: logoff === '' ? null : parseInt(logoff, 10) });
    ack('✅ auto-logoff salvo'); reload();
  });

  const toggleExempt = guard('count-exempt', async () => {
    await adminPut(`/operators/${op.id}/count-exempt`, { exempt: !op.count_exempt });
    ack('✅ salvo'); reload();
  });

  const toggleActive = guard('ativar/desativar', async () => {
    const m = op.is_active
      ? `Desativar ${op.display_name} e forçar logout de ${op.active_session_count} sessão(ões)?`
      : `Reativar ${op.display_name}?`;
    if (!window.confirm(m)) return;
    await adminPut(`/operators/${op.id}/active`, { active: !op.is_active });
    ack('✅ feito'); reload();
  });

  const forceLogout = guard('forçar logout', async () => {
    const r = await adminPost(`/operators/${op.id}/force-logout`, {});
    ack(`✅ ${r.sessions_closed} sessão(ões) encerrada(s)`); reload();
  });

  const remove = guard('remover', async () => {
    if (!window.confirm(`Remover ${op.display_name}? Ele é desativado e o histórico de eventos é PRESERVADO.`)) return;
    if (!window.confirm('Tem CERTEZA? Essa ação remove o operador do painel.')) return;
    await adminDelete(`/operators/${op.id}`);
    ack('🗑️ removido'); onClose(); reload();
  });

  async function loadEvents() {
    if (events) { setEvents(null); return; }
    try { const r = await adminGet(`/operators/${op.id}/events`); setEvents(r.events || []); }
    catch (e) { ack('❌ ' + msg(e)); }
  }

  return (
    <div className="card" style={{ marginTop: 12, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <SecTitle>Gerenciar · {op.display_name}</SecTitle>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>#{op.id}</span>
        <span style={{ flex: 1 }}/>
        <button className="btn sm ghost" onClick={onClose}>Fechar</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14 }}>
        <div>
          <div style={labS}>Novo PIN (4 dígitos)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••" inputMode="numeric" maxLength={4} style={{ width: 100 }}/>
            <button className="btn sm" onClick={savePin}>Atualizar</button>
          </div>
        </div>
        <div>
          <div style={labS}>Auto-logoff (s; vazio = desligado)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" value={logoff} onChange={(e) => setLogoff(e.target.value)} type="number" min={5} max={3600} style={{ width: 110 }}/>
            <button className="btn sm" onClick={saveLogoff}>Salvar</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        <button className="btn sm" onClick={toggleExempt}>{op.count_exempt ? '✅' : '⬜'} Pula contagem</button>
        <button className="btn sm" onClick={() => setShowSched((v) => !v)}>{showSched ? 'Fechar escala' : '🕐 Editar escala (dia a dia)'}</button>
        <button className="btn sm" onClick={() => setShowRetro((v) => !v)}>{showRetro ? 'Fechar task retroativa' : '➕ Adicionar task retroativa'}</button>
        <button className="btn sm" onClick={loadEvents}>{events ? 'Fechar timeline' : '📅 Timeline 7 dias'}</button>
        <button className="btn sm ghost" onClick={forceLogout}>Forçar logout</button>
        <button className={'btn sm ' + (op.is_active ? 'danger' : 'primary')} onClick={toggleActive}>
          {op.is_active ? 'Desativar' : 'Reativar'}
        </button>
        <button className="btn sm danger" onClick={remove}>Remover</button>
      </div>

      {showSched && <ScheduleEditor opId={op.id} ro={ro} ack={ack}/>}
      {showRetro && <RetroEventForm op={op} ro={ro} ack={ack} onDone={() => setShowRetro(false)}/>}

      {events && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <SecTitle>Últimos 7 dias</SecTitle>
          {events.length === 0 ? <Empty msg="Nenhum evento."/> : (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {events.map((ev) => (
                <div key={ev.id} style={{ fontSize: 12, padding: '5px 0', borderTop: '1px dashed var(--border)' }}>
                  <b>{ev.slug || '?'}</b>{ev.batch_number ? ' · ' + ev.batch_number : ''}
                  <span style={{ color: 'var(--text-3)' }}>
                    {' — '}<span className="mono">{ev.started_edt}</span> → <span className="mono">{ev.ended_edt || (ev.is_long_running ? 'rodando (bg)' : 'ABERTO')}</span> · {ev.source}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── task retroativa em nome do operador (Parte B do legado) ──
// Até 7 dias atrás, justificativa OBRIGATÓRIA (vai pro audit). Os campos
// Lote / Nota / Qtd ordens aparecem conforme as flags da activity escolhida
// (requires_product / note_required / orders_required) — igual ao /admin.
function RetroEventForm({ op, ro, ack, onDone }) {
  const { data, loading, error } = useAdmin('/activity-types', []);
  const [slug, setSlug] = React.useState('');
  const [f, setF] = React.useState({ batch: '', note: '', orders: '', date: '', start: '', end: '', just: '' });
  const [busy, setBusy] = React.useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  if (loading && !data) return <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12 }}>Carregando tarefas…</div>;
  if (error && !data) return <div style={{ marginTop: 12 }}><ErrBox error={error}/></div>;

  const acts = (data && data.activities) || [];
  const cur = acts.find((a) => a.slug === slug) || null;

  async function go() {
    if (!cur) { ack('❌ escolhe a tarefa'); return; }
    if (!f.date || !f.start) { ack('❌ data e hora de início'); return; }
    if (!f.just.trim()) { ack('❌ justificativa obrigatória'); return; }
    if (cur.note_required && !f.note.trim()) { ack('❌ nota obrigatória'); return; }
    if (cur.orders_required && !(parseInt(f.orders, 10) > 0)) { ack('❌ qtd de ordens obrigatória'); return; }
    if (ro) { ack('preview · adicionaria a task'); return; }
    setBusy(true);
    try {
      await adminPost(`/operators/${op.id}/retroactive-event`, {
        activity_slug: cur.slug,
        batch_number: (cur.requires_product && f.batch.trim()) ? f.batch.trim() : undefined,
        note: f.note.trim() || undefined,
        orders_printed: cur.orders_required ? parseInt(f.orders, 10) : undefined,
        started_at: new Date(f.date + 'T' + f.start).toISOString(),
        ended_at: f.end ? new Date(f.date + 'T' + f.end).toISOString() : null,
        admin_justification: f.just.trim(),
      });
      ack('✅ task adicionada');
      setF({ batch: '', note: '', orders: '', date: '', start: '', end: '', just: '' });
      setSlug('');
      onDone();
    } catch (e) { ack('❌ ' + msg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <SecTitle>Task retroativa · {op.display_name}</SecTitle>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 10 }}>
        Adiciona uma task que não foi registrada (até 7 dias atrás). Exige justificativa — fica no audit.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
        <div>
          <div style={labS}>Tarefa</div>
          <select className="input" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ width: '100%' }}>
            <option value="">— tarefa —</option>
            {acts.map((a) => <option key={a.slug} value={a.slug}>{a.display_name}</option>)}
          </select>
        </div>
        <div>
          <div style={labS}>Data</div>
          <input className="input" type="date" value={f.date} onChange={set('date')} style={{ width: '100%' }}/>
        </div>
        <div>
          <div style={labS}>Início</div>
          <input className="input" type="time" value={f.start} onChange={set('start')} style={{ width: '100%' }}/>
        </div>
        <div>
          <div style={labS}>Fim (opcional)</div>
          <input className="input" type="time" value={f.end} onChange={set('end')} style={{ width: '100%' }}/>
        </div>
        {cur && cur.requires_product && (
          <div>
            <div style={labS}>Lote (4 dígitos)</div>
            <input className="input" value={f.batch} onChange={set('batch')} placeholder="ex: 1234" style={{ width: '100%' }}/>
          </div>
        )}
        {cur && cur.note_required && (
          <div>
            <div style={labS}>Nota (obrigatória)</div>
            <input className="input" value={f.note} onChange={set('note')} style={{ width: '100%' }}/>
          </div>
        )}
        {cur && cur.orders_required && (
          <div>
            <div style={labS}>Qtd ordens</div>
            <input className="input" type="number" min={1} value={f.orders} onChange={set('orders')} style={{ width: '100%' }}/>
          </div>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={labS}>Justificativa (obrigatória)</div>
        <input className="input" value={f.just} onChange={set('just')} style={{ width: '100%' }}
               placeholder="ex: sistema não registrou o check-in da Ana às 9:15"/>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn sm primary" onClick={go} disabled={busy}>{busy ? 'Adicionando…' : 'Adicionar task'}</button>
        <button className="btn sm ghost" onClick={onDone}>Cancelar</button>
      </div>
    </div>
  );
}

// ── escala 7 dias (v3.operator_schedules) ────────────────
function ScheduleEditor({ opId, ro, ack }) {
  const [days, setDays] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const todayDow = new Date().getDay();

  React.useEffect(() => {
    let alive = true;
    setDays(null); setErr(null);
    adminGet(`/operators/${opId}/schedule`).then(
      (j) => { if (alive) setDays(j.days || []); },
      (e) => { if (alive) setErr(e); },
    );
    return () => { alive = false; };
  }, [opId]);

  if (err) return <div style={{ marginTop: 12 }}><ErrBox error={err}/></div>;
  if (!days) return <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12 }}>Carregando escala…</div>;

  const upd = (dow, patch) => setDays((ds) => ds.map((d) => d.day_of_week === dow ? { ...d, ...patch } : d));

  const copyMonToFri = () => {
    const mon = days.find((d) => d.day_of_week === 1);
    if (!mon) return;
    setDays((ds) => ds.map((d) => [2, 3, 4, 5].includes(d.day_of_week)
      ? { ...d, expected_start_time: mon.expected_start_time, expected_end_time: mon.expected_end_time, is_workday: mon.is_workday !== false }
      : d));
    ack('copiado da Segunda — revise e salve');
  };

  async function save() {
    if (ro) { ack('preview · salvaria a escala'); return; }
    // valida no cliente antes de gastar 7 PUTs (o servidor revalida)
    for (const d of days) {
      if (d.is_workday !== false && d.expected_start_time && d.expected_end_time
          && d.expected_end_time <= d.expected_start_time) {
        ack(`❌ ${DOW[d.day_of_week]}: fim antes do início`); return;
      }
    }
    setBusy(true);
    try {
      for (const d of days) {
        await adminPut(`/operators/${opId}/schedule/${d.day_of_week}`, {
          expected_start_time: d.expected_start_time || null,
          expected_end_time: d.expected_end_time || null,
          is_workday: d.is_workday !== false,
          notes: d.notes || null,
        });
      }
      ack('✅ escala salva');
    } catch (e) { ack('❌ ' + msg(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <SecTitle>Escala por dia da semana</SecTitle>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 10 }}>
        Horário previsto de entrada e saída — é o que o sistema usa como referência do dia.
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {days.map((d) => {
          const off = d.is_workday === false;
          return (
            <div key={d.day_of_week} style={{
              display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
              padding: '6px 8px', borderRadius: 8,
              background: d.day_of_week === todayDow ? 'var(--surface-2)' : 'transparent',
              opacity: off ? 0.55 : 1,
            }}>
              <span style={{ width: 34, fontWeight: 700, fontSize: 12.5 }}>{DOW[d.day_of_week]}</span>
              <input className="input" type="time" value={d.expected_start_time || ''} disabled={off}
                     onChange={(e) => upd(d.day_of_week, { expected_start_time: e.target.value })} style={{ width: 120 }}/>
              <span style={{ color: 'var(--text-3)' }}>→</span>
              <input className="input" type="time" value={d.expected_end_time || ''} disabled={off}
                     onChange={(e) => upd(d.day_of_week, { expected_end_time: e.target.value })} style={{ width: 120 }}/>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                <input type="checkbox" checked={d.is_workday !== false}
                       onChange={(e) => upd(d.day_of_week, { is_workday: e.target.checked })}/> trabalha
              </label>
              <input className="input" type="text" placeholder="nota" value={d.notes || ''}
                     onChange={(e) => upd(d.day_of_week, { notes: e.target.value })}
                     style={{ flex: '1 1 120px', minWidth: 90 }}/>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="btn sm ghost" onClick={copyMonToFri}>Aplicar Seg→Sex</button>
        <button className="btn sm primary" onClick={save} disabled={busy}>{busy ? 'Salvando…' : 'Salvar escala'}</button>
      </div>
    </div>
  );
}

const labS = { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-3)', fontWeight: 700, marginBottom: 5 };
