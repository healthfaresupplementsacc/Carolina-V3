import React from 'react';
import { Icon } from './Icons.jsx';
import { apiPost, usePoll } from '../adapters/from-api.js';

/* ═══════════════════════════════════════════════════════════════════
   PONTO — faixa do relógio (NGTeco) no TOPO da página Hoje.

   Bruno 08-19: as pills "ao vivo · live" e "edição ativa · write" saíram do
   topbar (não diziam nada que o operador ou o admin precisasse). No lugar
   entra o PONTO: quem está na fábrica agora e o botão pra deslogar.

   ADMIN ONLY: os horários do relógio são internos. Nunca aparecem na página
   do funcionário nem no canal dos operadores. Aqui é o dashboard PIN-admin.

   A faixa MUDOU DE LUGAR, não foi duplicada: o CommandCenter não desenha mais
   ponto nenhum. Fonte de dado única (o mesmo GET /attendance de antes, poll
   de 30s), então não existe "duas verdades" sobre quem entrou.
   ═══════════════════════════════════════════════════════════════════ */

const fmtT = (isoStr) => (isoStr
  ? new Date(isoStr).toLocaleTimeString('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })
  : null);

/* Primeiro nome. A faixa fica no topbar, ao lado do título: nome completo de
   4 pessoas não cabe. O nome inteiro continua no title do botão. */
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '?';

/* Estado visual de uma pessoa: cor do ponto + a linha de texto.
   Espelha o que a faixa antiga do CommandCenter mostrava. */
function readState(p) {
  if (p.state === 'in') {
    if (p.no_clockin) {
      return { dot: 'var(--dot-warn)', txt: 'trabalhando SEM ponto', tone: 'warn' };
    }
    return { dot: 'var(--green)', txt: `entrou ${fmtT(p.checkin_at) || '—'}`, tone: 'in' };
  }
  if (p.state === 'break') {
    const min = p.break_sec != null ? `${Math.round(p.break_sec / 60)}min` : null;
    return { dot: 'var(--dot-warn)', txt: min ? `EM PAUSA · ${min}` : 'EM PAUSA', tone: 'break' };
  }
  if (p.checkout_at) {
    return { dot: 'var(--ink-faint)', txt: `saiu ${fmtT(p.checkout_at)}`, tone: 'out' };
  }
  return { dot: 'var(--ink-faint)', txt: 'sem ponto hoje', tone: 'none' };
}

/* Uma ação por pessoa (Bruno: "um toque"). A regra:
     - tem sessão de kiosk aberta  → DESLOGAR (fecha sessão + encerra tarefas)
     - sem sessão, mas o dia está aberto → registrar SAÍDA
     - dia já fechado e sem sessão → nada a fazer (botão desativado)
   As duas ações antigas continuam existindo, só deixaram de exigir que o
   admin escolha qual é a certa: o estado da pessoa já responde isso. */
function actionFor(p) {
  if (p.logged_in) return 'logoff';
  if (p.state !== 'out' && !p.checkout_at) return 'checkout';
  return null;
}

/** Dado + ações do ponto. Um hook só, pra Shell e qualquer outro consumidor. */
export function usePonto() {
  const { data, refresh } = usePoll('/attendance', [], 30000);
  const people = React.useMemo(() => (data && data.people) || [], [data]);
  const [busy, setBusy] = React.useState(null);

  /* Deslogar da estação (Bruno 08-01): login por engano na conta de outra
     pessoa, ou a pessoa foi embora sem fechar o kiosk. */
  const logoff = React.useCallback(async (p) => {
    if (!window.confirm(
      `Deslogar ${p.name} da estação?\n\n`
      + 'Fecha a sessão do kiosk e encerra tarefas ativas (a máquina em background não é afetada). '
      + 'Vou checar se a saída foi batida no relógio e avisar no admin-orin.')) return;
    setBusy(p.person_id);
    try {
      const r = await apiPost(`/operator/${p.person_id}/logoff`, { reason: 'admin_dashboard' });
      const d = (r && r.data) || r || {};
      window.alert(`${p.name} deslogado(a).`
        + (d.sessions_closed ? ` Sessões fechadas: ${d.sessions_closed.length}.` : '')
        + (d.tasks_closed && d.tasks_closed.length ? ` Tarefas encerradas: ${d.tasks_closed.length}.` : '')
        + (d.clocked_out === false ? ' Atenção: ainda não bateu a saída no relógio.' : ''));
      if (refresh) refresh();
    } catch (e) {
      window.alert('Falhou deslogar: ' + ((e && e.message) || e));
    } finally { setBusy(null); }
  }, [refresh]);

  /* SAÍDA MANUAL (Bruno 08-03): a pessoa esqueceu de bater a saída no relógio
     e o admin registra por ela. Hora vazia = agora. */
  const checkout = React.useCallback(async (p) => {
    const t = window.prompt(
      `Registrar SAÍDA de ${p.name} (esqueceu de bater no relógio).\n\n`
      + 'Hora da saída (HH:MM), ou deixe vazio pra usar AGORA:', '');
    if (t === null) return;                       // cancelou
    let atIso = null;
    if (t && t.trim()) {
      const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) { window.alert('Hora inválida. Use HH:MM (ex: 17:30).'); return; }
      const d = new Date(); d.setHours(+m[1], +m[2], 0, 0); atIso = d.toISOString();
    }
    setBusy(p.person_id);
    try {
      const r = await apiPost(`/operator/${p.person_id}/checkout`, atIso ? { at: atIso } : {});
      const dd = (r && r.data) || r || {};
      window.alert(`Saída de ${p.name} registrada.`
        + (dd.tasks_closed && dd.tasks_closed.length ? ` ${dd.tasks_closed.length} tarefa(s) encerrada(s).` : ''));
      if (refresh) refresh();
    } catch (e) {
      window.alert('Falhou registrar saída: ' + ((e && e.message) || e));
    } finally { setBusy(null); }
  }, [refresh]);

  /* O clique do botão de power resolve sozinho qual ação cabe. */
  const act = React.useCallback((p) => {
    const a = actionFor(p);
    if (!a) return;
    if (a === 'logoff') return logoff(p);
    return checkout(p);
  }, [logoff, checkout]);

  return { people, busy, act, refresh, data };
}

/* Título do botão. Diz o que vai acontecer ANTES de acontecer: deslogar
   encerra sessão e registra a saída; sem sessão, só registra a saída. */
function powerTitle(p) {
  const a = actionFor(p);
  if (a === 'logoff') return `Deslogar ${p.name} do kiosk (encerra a sessão e registra a saída)`;
  if (a === 'checkout') return `Registrar a saída de ${p.name} (esqueceu de bater o ponto)`;
  return `${p.name} já saiu hoje, nada pra encerrar`;
}

/** Um chip por pessoa: bolinha de estado, primeiro nome, hora e o power. */
function PersonChip({ p, busy, onAct }) {
  const st = readState(p);
  const disabled = !actionFor(p) || busy === p.person_id;
  return (
    <span className={`ponto-chip ponto-${st.tone}`} data-ponto-person={p.person_id}
          title={`${p.name} · ${st.txt} · relógio #${p.clock_code} · ${(p.punches || []).length} batida(s)`}>
      <span className="ponto-dot" style={{ background: st.dot }} aria-hidden="true"/>
      <span className="ponto-name">{firstName(p.name)}</span>
      <span className={`ponto-when ${st.tone === 'none' ? 'muted' : ''}`}>{st.txt}</span>
      <button type="button"
              className="ponto-power"
              data-ponto-power={p.person_id}
              data-ponto-action={actionFor(p) || 'none'}
              disabled={disabled}
              aria-label={powerTitle(p)}
              title={powerTitle(p)}
              onClick={() => onAct(p)}>
        <Icon name="power" size={13}/>
      </button>
    </span>
  );
}

/* ── A faixa ──────────────────────────────────────────────────────
   Larga: os chips em linha. Estreita (CSS): vira uma pill "Ponto (N)"
   que abre a mesma lista num popover, pra não empurrar o título da
   página pra fora da tela no tablet. */
export function PontoStrip({ pageId }) {
  // Regra dura: fora da Hoje, a faixa não existe. Chamado sempre (hooks não
  // podem ficar atrás de if), mas não desenha nada.
  const active = pageId === 'hoje';
  const { people, busy, act } = usePonto();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => { if (!active) setOpen(false); }, [active]);

  if (!active || people.length === 0) return null;

  return (
    <div className="ponto-strip" data-ponto-strip>
      <span className="ponto-label kit-mlabel" aria-hidden="true">
        <Icon name="clock" size={12}/> Ponto
      </span>

      {/* Tela larga: os chips soltos */}
      <span className="ponto-list">
        {people.map((p) => <PersonChip key={p.person_id} p={p} busy={busy} onAct={act}/>)}
      </span>

      {/* Tela estreita: uma pill que abre a lista */}
      <button type="button" className="ponto-collapsed" data-ponto-collapsed
              aria-expanded={open} onClick={() => setOpen((v) => !v)}
              title="Ver quem bateu o ponto hoje">
        <Icon name="clock" size={13}/> Ponto ({people.length})
      </button>
      {open && (
        <>
          <div className="ponto-pop-back" onClick={() => setOpen(false)}/>
          <div className="ponto-pop" data-ponto-pop>
            <div className="kit-mlabel" style={{ marginBottom: 8 }}>Ponto de hoje</div>
            {people.map((p) => <PersonChip key={p.person_id} p={p} busy={busy} onAct={act}/>)}
          </div>
        </>
      )}
    </div>
  );
}

export default PontoStrip;
