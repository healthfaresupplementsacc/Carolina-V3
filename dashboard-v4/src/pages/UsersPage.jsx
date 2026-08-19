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
import './pages-admin.css';

const CAT_LABEL = { admin: 'Admin', operacao: 'Operação', estoque: 'Estoque & Produtos', fabrica: 'Fábrica', assistente: 'Assistente' };

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
