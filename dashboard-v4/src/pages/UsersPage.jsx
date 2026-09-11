/* Página "Usuários & Permissões" (RBAC — Bruno 08-03).
   Admin-only (função manage_users). Mostra:
     • Logins do dashboard (Admin, Henrique…) — nome, role, ativo, trocar PIN.
     • Matriz de permissões: roles × funções (checkbox liga/desliga por role).
       É AQUI que o Admin define o que o Henrique (manager) pode acessar.
   Fonte: /api/v3/data/rbac (GET) + /rbac/role-function + /rbac/login (POST).

   S15 Fase 2 (grupo C): visual 100% STYLE-KIT. Mesmos endpoints, mesmo estado,
   mesmos gates de escrita — só o markup virou kit (kit-table, kit-chip,
   kit-btn, kit-input). */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';
import { getLoginFunctions, setLoginFunction, STOCK_FUNCTIONS } from '../adapters/rbac-api.js';
import { getOperators, setOperatorPin, setKioskPrefs, impersonate, KIOSK_GROUPS } from '../adapters/operators-api.js';
import './pages-admin.css';

const CAT_LABEL = { admin: 'Admin', operacao: 'Operação', estoque: 'Estoque & Produtos', fabrica: 'Fábrica', assistente: 'Assistente' };


/* ── CONTROLE DE ESTOQUE POR PESSOA (Fase C, Bruno 09-10) ───────────────
   "Ajusta aqui e a gente define como quiser; níveis diferentes; o sistema nunca
   chama ninguém de manager ou supervisor." Cada pessoa × cada nível: herda do
   perfil (cinza), dado por cima (verde), tirado por cima (vermelho). O perfil é
   só o modelo inicial. */

/* ── OPERADORES E KIOSK (Bruno 09-11) ─────────────────────────────────────
   "Eu deveria ver todos os operadores e os PINs (se esquecerem eu falo), logar
   como eles pra achar bug, e editar o que cada um vê no kiosk." Toda leitura de
   PIN fica no audit. */
function OperatorsKiosk({ ro }) {
  const [rows, setRows] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(null);
  const load = React.useCallback(() => { getOperators().then((d) => { setRows(d.operators || []); setErr(''); }).catch((e) => setErr(e.message || String(e))); }, []);
  React.useEffect(load, [load]);
  if (err) return <div className="kit-card pad bad" style={{ marginBottom: 22 }}>Operadores e kiosk: {err}</div>;
  if (!rows) return null;
  const ops = rows.filter((r) => r.role === 'operator');
  const changePin = async (r) => {
    const v = window.prompt(`Novo PIN de 4 dígitos pra ${r.display_name}:`, r.pin || ''); if (v == null) return;
    if (!/^\d{4}$/.test(v.trim())) { alert('PIN tem 4 dígitos'); return; }
    setBusy(r.id); try { await setOperatorPin(r.id, v.trim()); load(); } catch (e) { alert(e.message); } finally { setBusy(null); }
  };
  const toggleGroup = async (r, key) => {
    const cur = (r.kiosk_prefs && r.kiosk_prefs.hidden_groups) || []; const next = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
    setBusy(r.id); try { await setKioskPrefs(r.id, next); load(); } catch (e) { alert(e.message); } finally { setBusy(null); }
  };
  const loginAs = async (r) => {
    setBusy(r.id); try { const d = await impersonate(r.id); window.open(d.url, '_blank'); } catch (e) { alert(e.message); } finally { setBusy(null); }
  };
  const stamp = (iso) => { if (!iso) return 'nunca'; try { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); } catch (_) { return ''; } };
  return (
    <div className="kit-card pad" style={{ marginBottom: 22 }} data-section="operadores-kiosk">
      <div className="adm-sec">
        <span className="kit-mlabel">Operadores e kiosk</span>
        <span className="rule"/>
        <button className="kit-btn sm ghost" onClick={() => setShow((v) => !v)}>{show ? 'Esconder PINs' : 'Mostrar PINs'}</button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-dim)', margin: '6px 0 12px' }}>
        PIN do kiosk de cada pessoa (toda leitura fica no audit). <b>Logar como</b> abre o kiosk na conta da pessoa, numa aba nova, pra você ver o que ela vê; o que fizer ali é real e fica registrado como aberto por você. Os chips escondem grupos do kiosk só pra aquela pessoa. No kiosk, qualquer um pode digitar o PIN seguido de números e um 0 no fim: o sistema usa só os 4 primeiros.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="kit-table" data-table="operadores-kiosk">
          <thead><tr><th>Pessoa</th><th>PIN</th><th>Dashboard</th><th>Último kiosk</th><th>Esconder no kiosk</th><th/></tr></thead>
          <tbody>
            {ops.map((r) => { const hidden = (r.kiosk_prefs && r.kiosk_prefs.hidden_groups) || []; return (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                <td><b>{r.display_name}</b>{r.is_sandbox && <span className="kit-chip neutral" style={{ marginLeft: 6 }}>sandbox</span>}{!r.active && <span className="kit-chip neutral" style={{ marginLeft: 6 }}>inativo</span>}</td>
                <td className="mono">{!r.has_pin ? <span style={{ color: 'var(--ink-faint)' }}>sem PIN</span> : r.pin_unknown ? <span className="kit-chip warn" title="PIN definido antes do painel guardar o número; defina um novo">desconhecido</span> : (show ? <b>{r.pin}</b> : '••••')}
                  {!ro && <button className="kit-btn sm ghost" style={{ marginLeft: 6 }} disabled={busy === r.id} onClick={() => changePin(r)}>{r.has_pin ? 'trocar' : 'definir'}</button>}</td>
                <td style={{ fontSize: 12 }}>{r.login_role ? <span className="kit-chip ok">{r.login_name} · {r.login_role}</span> : <span style={{ color: 'var(--ink-faint)' }}>sem acesso</span>}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{stamp(r.last_kiosk_at)}</td>
                <td>{KIOSK_GROUPS.map(([k, t]) => (<button key={k} type="button" className={'kit-chip ' + (hidden.includes(k) ? 'bad' : 'neutral')} disabled={ro || busy === r.id} title={hidden.includes(k) ? 'escondido: clique pra mostrar' : 'visível: clique pra esconder'} onClick={() => toggleGroup(r, k)} style={{ cursor: 'pointer', marginRight: 4, textDecoration: hidden.includes(k) ? 'line-through' : 'none', opacity: hidden.includes(k) ? 0.7 : 1 }}>{t}</button>))}</td>
                <td>{r.active && <button className="kit-btn sm primary" disabled={ro || busy === r.id} onClick={() => loginAs(r)}>Logar como</button>}</td>
              </tr>); })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PersonStockLevels({ ro }) {
  const [data, setData] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [err, setErr] = React.useState('');
  const load = React.useCallback(() => {
    getLoginFunctions().then((r) => { setData((r && r.data) || null); setErr(''); }).catch((e) => setErr(e.message || String(e)));
  }, []);
  React.useEffect(load, [load]);
  if (err) return <div className="kit-card pad bad" style={{ marginBottom: 22 }}>Controle de estoque por pessoa: {err}</div>;
  if (!data) return null;
  const logins = (data.logins || []).filter((l) => l.active);
  const cycle = async (l, key) => {
    const ov = (l.overrides || {})[key];
    const inherited = (l.role_functions || []).includes(key);
    // herdado → (tirar se tinha | dar se não tinha) → voltar a herdar
    const next = ov == null ? (inherited ? 'revoke' : 'grant') : 'inherit';
    setBusy(l.id + ':' + key);
    try { await setLoginFunction(l.id, key, next); load(); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(null); }
  };
  return (
    <div className="kit-card pad" style={{ marginBottom: 22 }} data-section="estoque-por-pessoa">
      <div className="adm-sec">
        <span className="kit-mlabel">Controle de estoque por pessoa</span>
        <span className="rule"/>
        <span className="kit-chip neutral">clique pra dar, tirar ou voltar ao perfil</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-dim)', margin: '6px 0 12px' }}>
        Cada nível diz o que a pessoa <b>faz</b> no estoque. Cinza = herda do perfil; verde = dado a esta pessoa; vermelho riscado = tirado desta pessoa.
        Quem tem só <b>Propor</b> não muda número: entrada, saída e contagem viram proposta pra quem tem <b>Aprovar</b> (nunca a própria).
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="kit-table" data-table="estoque-por-pessoa">
          <thead>
            <tr><th style={{ minWidth: 150 }}>Pessoa</th>{STOCK_FUNCTIONS.map(([k, t]) => <th key={k} style={{ textAlign: 'center', fontSize: 11 }} title={k}>{t.split(' (')[0]}</th>)}</tr>
          </thead>
          <tbody>
            {logins.map((l) => (
              <tr key={l.id}>
                <td><b>{l.name}</b></td>
                {STOCK_FUNCTIONS.map(([k]) => {
                  const ov = (l.overrides || {})[k];
                  const inherited = (l.role_functions || []).includes(k) || l.role === 'admin';
                  const on = ov == null ? inherited : !!ov;
                  const tone = ov === true ? 'ok' : (ov === false ? 'bad' : (on ? 'neutral' : 'neutral'));
                  const label = ov === true ? 'dado' : (ov === false ? 'tirado' : (on ? 'perfil' : '—'));
                  return (
                    <td key={k} style={{ textAlign: 'center' }}>
                      <button type="button" className={'kit-chip ' + tone} disabled={ro || l.role === 'admin' || busy === l.id + ':' + k}
                              data-level={l.id + ':' + k} data-on={on ? '1' : '0'}
                              title={l.role === 'admin' ? 'Admin sempre tem tudo' : (ov == null ? 'clique: ' + (inherited ? 'tirar desta pessoa' : 'dar a esta pessoa') : 'clique: voltar a seguir o perfil')}
                              onClick={() => cycle(l, k)}
                              style={{ cursor: (ro || l.role === 'admin') ? 'default' : 'pointer', textDecoration: ov === false ? 'line-through' : 'none', opacity: on ? 1 : 0.45 }}>
                        {on ? '✓ ' : ''}{label}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UsersPage() {
  const rbac = usePoll('/rbac', [], 0);
  const [roles, setRoles] = React.useState([]);
  const [fns, setFns] = React.useState([]);
  const [logins, setLogins] = React.useState([]);
  const [flash, setFlash] = React.useState('');
  const ro = !V4_ALLOW_WRITES;

  React.useEffect(() => {
    if (rbac.data) {
      setRoles(rbac.data.roles || []);
      setFns(rbac.data.functions || []);
      setLogins(rbac.data.logins || []);
    }
  }, [rbac.data]);

  const ack = (m) => { setFlash(m); setTimeout(() => setFlash(''), 1200); };

  async function toggle(role, fnKey, enabled) {
    if (ro) { ack('preview · ' + role.key + ' ' + fnKey); return; }
    // otimista
    setRoles((rs) => rs.map((r) => r.id !== role.id ? r : {
      ...r, functions: enabled ? [...r.functions, fnKey] : r.functions.filter((f) => f !== fnKey),
    }));
    const res = await apiPost('/rbac/role-function', { role_id: role.id, function_key: fnKey, enabled }).catch((e) => ({ error: e.message }));
    if (res && res.error) { ack('erro: ' + res.error); }
    else ack('salvo');
  }

  const [newLogin, setNewLogin] = React.useState({ name: '', role_id: '', pin: '' });
  async function addLogin() {
    if (!newLogin.name.trim() || !newLogin.role_id || !newLogin.pin.trim()) { ack('preencha nome, cargo e PIN'); return; }
    if (ro) { ack('preview · add ' + newLogin.name); return; }
    const res = await apiPost('/rbac/login', { name: newLogin.name.trim(), role_id: Number(newLogin.role_id), pin: newLogin.pin.trim() }).catch((e) => ({ error: e.message }));
    if (res && !res.error) {
      ack('login criado');
      const created = res.data || res;
      const roleName = (roles.find((r) => r.id === Number(newLogin.role_id)) || {});
      setLogins((ls) => [...ls, { id: created.id, name: newLogin.name.trim(), role: roleName.key, role_name: roleName.name, active: true }]);
      setNewLogin({ name: '', role_id: '', pin: '' });
    } else ack('erro: ' + (res && res.error));
  }
  async function changePin(l) {
    if (ro) { ack('preview'); return; }
    const pin = window.prompt('Novo PIN para ' + l.name + ':', '');
    if (!pin || !pin.trim()) return;
    const res = await apiPost('/rbac/login', { id: l.id, pin: pin.trim() }).catch((e) => ({ error: e.message }));
    if (res && !res.error) ack('PIN de ' + l.name + ' trocado'); else ack('erro: ' + (res && res.error));
  }
  async function toggleActive(l) {
    if (ro) { ack('preview'); return; }
    const res = await apiPost('/rbac/login', { id: l.id, active: !l.active }).catch((e) => ({ error: e.message }));
    if (res && !res.error) { ack(l.name + (l.active ? ' desativado' : ' ativado')); setLogins((ls) => ls.map((x) => x.id === l.id ? { ...x, active: !x.active } : x)); }
    else ack('erro: ' + (res && res.error));
  }

  if (rbac.loading && !roles.length) return <div className="adm-state">Carregando usuários…</div>;
  if (rbac.error) {
    return (
      <div className="adm-state bad">
        <b>Erro:</b> {String(rbac.error)}{rbac.error && rbac.error.unauthorized ? ' (só Admin acessa)' : ''}
      </div>
    );
  }

  // agrupa funções por categoria
  const byCat = {};
  for (const f of fns) { (byCat[f.category || 'outros'] = byCat[f.category || 'outros'] || []).push(f); }

  return (
    <div data-page="usuarios" style={{ maxWidth: 1120, paddingBottom: 60 }}>
      <div className="adm-head">
        <div className="lead">
          <span className="kit-eyebrow">● HEALTHFARE · USUÁRIOS E PERMISSÕES</span>
          <h1 className="kit-h1">Quem entra e o que cada <em>cargo</em> acessa</h1>
          <p className="kit-sub">
            Logins do sistema e a matriz de permissões por cargo. O acesso segue o cargo, não o nome da pessoa.
          </p>
        </div>
        <div className="acts">
          {flash && <span className={'kit-chip ' + (flash.startsWith('erro') ? 'bad' : 'ok')}>{flash}</span>}
          {ro && <span className="kit-chip neutral">modo leitura</span>}
        </div>
      </div>

      {/* LOGINS */}
      <div className="kit-card pad" style={{ marginBottom: 12 }}>
        <div className="adm-sec">
          <span className="kit-mlabel">Logins</span>
          <span className="rule"/>
          <span className="kit-chip neutral">{logins.length} logins</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="kit-table" data-table="logins">
            <thead>
              <tr><th>Nome</th><th>Cargo (role)</th><th>Status</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {logins.map((l) => (
                <tr key={l.id} style={{ opacity: l.active ? 1 : 0.6 }}>
                  <td><b>{l.name}</b></td>
                  <td>{l.role_name} <span style={{ font: '500 11px var(--font-mono)', color: 'var(--ink-faint)' }}>{l.role}</span></td>
                  <td><span className={'kit-chip ' + (l.active ? 'ok' : 'neutral')}>{l.active ? 'ativo' : 'inativo'}</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button className="kit-btn sec xs" onClick={() => changePin(l)}>trocar PIN</button>
                      <button className="kit-btn sec xs" onClick={() => toggleActive(l)}>{l.active ? 'desativar' : 'ativar'}</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* add login */}
      <div className="kit-card pad" style={{ marginBottom: 22 }}>
        <div className="adm-sec"><span className="kit-mlabel">Novo login</span><span className="rule"/></div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="adm-field" style={{ flex: '1 1 180px' }}>
            <span className="kit-mlabel">Nome</span>
            <input className="kit-input" value={newLogin.name} onChange={(e) => setNewLogin((s) => ({ ...s, name: e.target.value }))} placeholder="nome"/>
          </label>
          <label className="adm-field" style={{ width: 190 }}>
            <span className="kit-mlabel">Cargo</span>
            <select className="kit-input" value={newLogin.role_id} onChange={(e) => setNewLogin((s) => ({ ...s, role_id: e.target.value }))}>
              <option value="">escolher cargo</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="adm-field" style={{ width: 120 }}>
            <span className="kit-mlabel">PIN</span>
            <input className="kit-input mono" value={newLogin.pin} onChange={(e) => setNewLogin((s) => ({ ...s, pin: e.target.value }))} placeholder="0000" inputMode="numeric"/>
          </label>
          <button className="kit-btn primary sm" onClick={addLogin}>Criar login</button>
        </div>
      </div>

      {/* MATRIZ DE PERMISSÕES */}
      <OperatorsKiosk ro={ro} />

      <PersonStockLevels ro={ro} />

      <div className="kit-card pad">
        <div className="adm-sec">
          <span className="kit-mlabel">Permissões por cargo</span>
          <span className="rule"/>
        </div>
        <p className="kit-sub" style={{ margin: '0 0 14px' }}>
          Marque o que cada cargo pode acessar. É aqui que o Admin ajusta o acesso do Manager. O cargo <b>Admin</b> tem tudo.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table className="kit-table" data-table="permissoes">
            <thead>
              <tr>
                <th style={{ minWidth: 230 }}>Função</th>
                {roles.map((r) => <th key={r.id} style={{ textAlign: 'center' }}>{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {Object.keys(byCat).map((cat) => (
                <React.Fragment key={cat}>
                  <tr>
                    <td colSpan={roles.length + 1} style={{ background: 'var(--kit-surface-2)' }}>
                      <span className="kit-mlabel">{CAT_LABEL[cat] || cat}</span>
                    </td>
                  </tr>
                  {byCat[cat].map((f) => (
                    <tr key={f.key}>
                      <td>
                        {f.label} <span style={{ font: '500 11px var(--font-mono)', color: 'var(--ink-faint)' }}>{f.key}</span>
                      </td>
                      {roles.map((r) => {
                        const on = (r.functions || []).includes(f.key);
                        const isAdminRole = r.key === 'admin';
                        return (
                          <td key={r.id} style={{ textAlign: 'center' }}>
                            <input type="checkbox" checked={on} disabled={ro || isAdminRole}
                              onChange={(e) => toggle(r, f.key, e.target.checked)}
                              title={isAdminRole ? 'Admin sempre tem tudo' : ''}
                              style={{ width: 17, height: 17, accentColor: 'var(--primary-deep)',
                                       cursor: (ro || isAdminRole) ? 'default' : 'pointer' }} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
