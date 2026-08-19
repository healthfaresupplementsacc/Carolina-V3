/* HEALTHFARE V4 — aba OPERADORES nativa (FASE 2b — unificação).

   Porta pro dashboard tudo que só existia no /admin legado (src/admin/app.js):
   criar operador, PIN, auto-logoff, count-exempt, ativar/desativar, forçar
   logout, remover (soft-delete), timeline 7d e o EDITOR DE ESCALA por dia da
   semana (v3.operator_schedules) — a "organização dia a dia" do Bruno.

   ESTILO (S15 Fase 2, grupo C): STYLE-KIT 100%. Usa os MESMOS primitivos das
   outras abas (components/AdminBits.jsx: useAdmin/Loading/ErrBox/SecTitle/
   Empty/MiniKPI) e só classes do kit (.kit-card .kit-btn .kit-input .kit-chip
   .kit-seg .kit-table) mais as recipes de pages-admin.css. Nada de fetch
   próprio nem botão inline — se precisar de um primitivo novo, ele nasce no
   AdminBits, não aqui.

   Auth = cookie hf_admin (adapters/admin-api.js), a mesma do resto do painel;
   RBAC e auditoria (v3.audit_log) seguem enforçados no servidor. Writes
   respeitam V4_ALLOW_WRITES: desligado, a UI vira preview e não chama a API.
*/
import React from 'react';
import { adminGet, adminPost, adminPut, adminDelete } from '../adapters/admin-api.js';
import { useAdmin, AdminGate, SecTitle, Empty, Loading, ErrBox, RefreshErr, MiniKPI } from '../components/AdminBits.jsx';
import { V4_ALLOW_WRITES } from '../flags.js';
import './pages-admin.css';

/* Página do menu Admin → "Operadores" (rota `operadores` no Shell/App).
   Mesmo login/gate das outras páginas admin; o miolo é a <OperatorsTab/>. */
export function OperatorsPage() {
  return (
    <AdminGate title="Operadores" eyebrow="OPERADORES"
               h1={<>Quem trabalha na <em>linha</em></>}
               sub="Cadastro, PIN, auto-logoff, escala por dia da semana e histórico de cada operador.">
      {() => <OperatorsTab/>}
    </AdminGate>
  );
}

const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// erros do backend → PT (mesmas chaves do legado)
const ERR = {
  name_taken: 'Nome já existe', pin_taken: 'PIN já usado por outro operador',
  bad_pin_format: 'PIN precisa de 4 dígitos', end_before_start: 'Fim antes do início',
  bad_time: 'Hora inválida', bad_seconds: 'Segundos fora de 5 a 3600',
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
      <div className="adm-bar">
        <button className="kit-btn primary sm" onClick={() => { setCreating((v) => !v); setSelId(null); }}>
          {creating ? 'Cancelar' : '+ Novo operador'}
        </button>
        {ro && <span className="kit-chip neutral">modo leitura · botões não gravam</span>}
        <span className="grow"/>
        {flash && <span className={'kit-chip ' + (flash.startsWith('❌') ? 'bad' : 'ok')}>{flash.replace(/^[❌✅🗑️]\s*/u, '')}</span>}
      </div>

      <div className="adm-kpis">
        <MiniKPI label="Operadores" value={ops.length} suffix="cadastrados"/>
        <MiniKPI label="Ativos" value={actives} suffix="ativos"/>
        <MiniKPI label="Com sessão aberta" value={online} suffix="agora"/>
      </div>

      {creating && (
        <CreateForm ro={ro} ack={ack}
                    onDone={(ok) => { setCreating(false); if (ok) { ack('✅ operador criado'); reload(); } }}/>
      )}

      <div className="kit-card pad" style={{ marginTop: 12 }}>
        <SecTitle>Operadores</SecTitle>
        {ops.length === 0 ? <Empty msg="Nenhum operador cadastrado"/> : (
          <div className="adm-grid tiles" data-list="operadores">
            {ops.map((o) => (
              <div key={o.id} className="kit-card" style={{ padding: '13px 15px', opacity: o.is_active ? 1 : 0.6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13.5, color: 'var(--primary-deep)' }}>{o.display_name}</b>
                  <span className={'kit-chip ' + (o.is_active ? 'ok' : 'neutral')}>{o.is_active ? 'ativo' : 'inativo'}</span>
                  {o.active_session_count > 0 && <span className="kit-chip info">{o.active_session_count} sessão</span>}
                </div>
                <div className="adm-note" style={{ marginTop: 8, lineHeight: 1.6 }}>
                  Auto-logoff: <b>{o.auto_logoff_seconds == null ? 'desligado' : o.auto_logoff_seconds + 's'}</b>
                  {' · '}Pula contagem: <b>{o.count_exempt ? 'sim' : 'não'}</b><br/>
                  Login: {rel(o.last_page_login_at)} · Evento: {rel(o.last_event_at)}
                </div>
                <button className="kit-btn sec xs" style={{ marginTop: 10 }}
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
    <div className="kit-card pad" style={{ marginTop: 12 }}>
      <SecTitle>Novo operador</SecTitle>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="adm-field" style={{ flex: '1 1 190px' }}>
          <span className="kit-mlabel">Nome</span>
          <input className="kit-input" value={f.name} onChange={set('name')} placeholder="nome do operador"/>
        </label>
        <label className="adm-field" style={{ width: 140 }}>
          <span className="kit-mlabel">PIN (4 dígitos)</span>
          <input className="kit-input mono" value={f.pin} onChange={set('pin')} placeholder="0000" inputMode="numeric" maxLength={4}/>
        </label>
        <label className="adm-field" style={{ width: 150 }}>
          <span className="kit-mlabel">Auto-logoff (s)</span>
          <input className="kit-input mono" value={f.logoff} onChange={set('logoff')} type="number" min={5} max={3600}/>
        </label>
        <label className="adm-check" style={{ paddingBottom: 9 }}>
          <input type="checkbox" checked={f.exempt} onChange={set('exempt')}/> pula contagem
        </label>
        <button className="kit-btn primary sm" onClick={go} disabled={busy}>{busy ? 'Criando…' : 'Criar'}</button>
        <button className="kit-btn sec sm" onClick={() => onDone(false)}>Cancelar</button>
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
    <div className="kit-card pad" style={{ marginTop: 12 }} data-panel="operador">
      <div className="adm-sec">
        <span className="kit-mlabel">Gerenciar</span>
        <h2 className="kit-h2" style={{ fontSize: 18 }}>{op.display_name}</h2>
        <span className="kit-chip neutral">#{op.id}</span>
        <span className="rule"/>
        <button className="kit-btn sec xs" onClick={onClose}>Fechar</button>
      </div>

      <div className="adm-grid two" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))' }}>
        <div className="adm-field">
          <span className="kit-mlabel">Novo PIN (4 dígitos)</span>
          <div style={{ display: 'flex', gap: 7 }}>
            <input className="kit-input mono" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="0000"
                   inputMode="numeric" maxLength={4} style={{ width: 110 }}/>
            <button className="kit-btn sec sm" onClick={savePin}>Atualizar</button>
          </div>
        </div>
        <div className="adm-field">
          <span className="kit-mlabel">Auto-logoff em segundos (vazio = desligado)</span>
          <div style={{ display: 'flex', gap: 7 }}>
            <input className="kit-input mono" value={logoff} onChange={(e) => setLogoff(e.target.value)} type="number"
                   min={5} max={3600} style={{ width: 120 }}/>
            <button className="kit-btn sec sm" onClick={saveLogoff}>Salvar</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        <button className={'kit-btn sm ' + (op.count_exempt ? 'primary' : 'sec')} onClick={toggleExempt}>
          Pula contagem: {op.count_exempt ? 'sim' : 'não'}
        </button>
        <button className="kit-btn sec sm" onClick={() => setShowSched((v) => !v)}>{showSched ? 'Fechar escala' : 'Editar escala (dia a dia)'}</button>
        <button className="kit-btn sec sm" onClick={() => setShowRetro((v) => !v)}>{showRetro ? 'Fechar task retroativa' : 'Adicionar task retroativa'}</button>
        <button className="kit-btn sec sm" onClick={loadEvents}>{events ? 'Fechar timeline' : 'Timeline 7 dias'}</button>
        <span style={{ flex: 1 }}/>
        <button className="kit-btn sec sm" onClick={forceLogout}>Forçar logout</button>
        <button className={'kit-btn sm ' + (op.is_active ? 'danger' : 'primary')} onClick={toggleActive}>
          {op.is_active ? 'Desativar' : 'Reativar'}
        </button>
        <button className="kit-btn danger sm" onClick={remove}>Remover</button>
      </div>

      {showSched && <ScheduleEditor opId={op.id} ro={ro} ack={ack}/>}
      {showRetro && <RetroEventForm op={op} ro={ro} ack={ack} onDone={() => setShowRetro(false)}/>}

      {events && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <SecTitle>Últimos 7 dias</SecTitle>
          {events.length === 0 ? <Empty msg="Nenhum evento."/> : (
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {events.map((ev) => (
                <div key={ev.id} className="kit-dotted-row" style={{ fontSize: 12.5, flexWrap: 'wrap' }}>
                  <b>{ev.slug || '?'}</b>
                  {ev.batch_number ? <span className="kit-chip neutral">{ev.batch_number}</span> : null}
                  <span style={{ font: '500 11.5px var(--font-mono)', color: 'var(--ink-faint)' }}>
                    {ev.started_edt} → {ev.ended_edt || (ev.is_long_running ? 'rodando em background' : 'ABERTO')}
                  </span>
                  <span className="kit-chip info">{ev.source}</span>
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

  if (loading && !data) return <div className="adm-note" style={{ marginTop: 14 }}>Carregando tarefas…</div>;
  if (error && !data) return <div style={{ marginTop: 14 }}><ErrBox error={error}/></div>;

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
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <SecTitle>Task retroativa · {op.display_name}</SecTitle>
      <p className="adm-note" style={{ margin: '0 0 12px' }}>
        Adiciona uma task que não foi registrada (até 7 dias atrás). Exige justificativa e fica no audit.
      </p>
      <div className="adm-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
        <label className="adm-field">
          <span className="kit-mlabel">Tarefa</span>
          <select className="kit-input" value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">escolher tarefa</option>
            {acts.map((a) => <option key={a.slug} value={a.slug}>{a.display_name}</option>)}
          </select>
        </label>
        <label className="adm-field">
          <span className="kit-mlabel">Data</span>
          <input className="kit-input" type="date" value={f.date} onChange={set('date')}/>
        </label>
        <label className="adm-field">
          <span className="kit-mlabel">Início</span>
          <input className="kit-input" type="time" value={f.start} onChange={set('start')}/>
        </label>
        <label className="adm-field">
          <span className="kit-mlabel">Fim (opcional)</span>
          <input className="kit-input" type="time" value={f.end} onChange={set('end')}/>
        </label>
        {cur && cur.requires_product && (
          <label className="adm-field">
            <span className="kit-mlabel">Lote (4 dígitos)</span>
            <input className="kit-input mono" value={f.batch} onChange={set('batch')} placeholder="1234"/>
          </label>
        )}
        {cur && cur.note_required && (
          <label className="adm-field">
            <span className="kit-mlabel">Nota (obrigatória)</span>
            <input className="kit-input" value={f.note} onChange={set('note')}/>
          </label>
        )}
        {cur && cur.orders_required && (
          <label className="adm-field">
            <span className="kit-mlabel">Qtd ordens</span>
            <input className="kit-input mono" type="number" min={1} value={f.orders} onChange={set('orders')}/>
          </label>
        )}
      </div>
      <label className="adm-field" style={{ marginTop: 12 }}>
        <span className="kit-mlabel">Justificativa (obrigatória)</span>
        <input className="kit-input" value={f.just} onChange={set('just')}
               placeholder="ex: sistema não registrou o check-in da Ana às 9:15"/>
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="kit-btn primary sm" onClick={go} disabled={busy}>{busy ? 'Adicionando…' : 'Adicionar task'}</button>
        <button className="kit-btn sec sm" onClick={onDone}>Cancelar</button>
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

  if (err) return <div style={{ marginTop: 14 }}><ErrBox error={err}/></div>;
  if (!days) return <div className="adm-note" style={{ marginTop: 14 }}>Carregando escala…</div>;

  const upd = (dow, patch) => setDays((ds) => ds.map((d) => d.day_of_week === dow ? { ...d, ...patch } : d));

  const copyMonToFri = () => {
    const mon = days.find((d) => d.day_of_week === 1);
    if (!mon) return;
    setDays((ds) => ds.map((d) => [2, 3, 4, 5].includes(d.day_of_week)
      ? { ...d, expected_start_time: mon.expected_start_time, expected_end_time: mon.expected_end_time, is_workday: mon.is_workday !== false }
      : d));
    ack('copiado da Segunda, revise e salve');
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
    <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <SecTitle>Escala por dia da semana</SecTitle>
      <p className="adm-note" style={{ margin: '0 0 12px' }}>
        Horário previsto de entrada e saída. É o que o sistema usa como referência do dia.
      </p>
      <div style={{ display: 'grid', gap: 4 }}>
        {days.map((d) => {
          const off = d.is_workday === false;
          return (
            <div key={d.day_of_week} style={{
              display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap',
              padding: '7px 10px', borderRadius: 'var(--r-sm)',
              background: d.day_of_week === todayDow ? 'var(--primary-soft)' : 'transparent',
              border: '1px solid ' + (d.day_of_week === todayDow ? 'var(--primary-soft-line)' : 'transparent'),
              opacity: off ? 0.6 : 1,
            }}>
              <span style={{ width: 36, font: '500 11px var(--font-mono)', letterSpacing: '.06em',
                             textTransform: 'uppercase', color: 'var(--primary-deep)' }}>{DOW[d.day_of_week]}</span>
              <input className="kit-input mono" type="time" value={d.expected_start_time || ''} disabled={off}
                     onChange={(e) => upd(d.day_of_week, { expected_start_time: e.target.value })} style={{ width: 122 }}/>
              <span style={{ color: 'var(--ink-faint)' }}>→</span>
              <input className="kit-input mono" type="time" value={d.expected_end_time || ''} disabled={off}
                     onChange={(e) => upd(d.day_of_week, { expected_end_time: e.target.value })} style={{ width: 122 }}/>
              <label className="adm-check">
                <input type="checkbox" checked={d.is_workday !== false}
                       onChange={(e) => upd(d.day_of_week, { is_workday: e.target.checked })}/> trabalha
              </label>
              <input className="kit-input" type="text" placeholder="nota" value={d.notes || ''}
                     onChange={(e) => upd(d.day_of_week, { notes: e.target.value })}
                     style={{ flex: '1 1 120px', minWidth: 90 }}/>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="kit-btn sec sm" onClick={copyMonToFri}>Aplicar Seg a Sex</button>
        <button className="kit-btn primary sm" onClick={save} disabled={busy}>{busy ? 'Salvando…' : 'Salvar escala'}</button>
      </div>
    </div>
  );
}
