/* Página "Usuários & Permissões" (RBAC — Bruno 08-03).
   Admin-only (função manage_users). Mostra:
     • Logins do dashboard (Admin, Henrique…) — nome, role, ativo, trocar PIN.
     • Matriz de permissões: roles × funções (checkbox liga/desliga por role).
       É AQUI que o Admin define o que o Henrique (manager) pode acessar.
   Fonte: /api/v3/data/rbac (GET) + /rbac/role-function + /rbac/login (POST). */
import React from 'react';
import { usePoll, apiPost } from '../adapters/from-api.js';
import { V4_ALLOW_WRITES } from '../flags.js';

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
    else ack('✓ salvo');
  }

  const [newLogin, setNewLogin] = React.useState({ name: '', role_id: '', pin: '' });
  async function addLogin() {
    if (!newLogin.name.trim() || !newLogin.role_id || !newLogin.pin.trim()) { ack('preencha nome, role e PIN'); return; }
    if (ro) { ack('preview · add ' + newLogin.name); return; }
    const res = await apiPost('/rbac/login', { name: newLogin.name.trim(), role_id: Number(newLogin.role_id), pin: newLogin.pin.trim() }).catch((e) => ({ error: e.message }));
    if (res && !res.error) {
      ack('✓ login criado');
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
    if (res && !res.error) ack('✓ PIN de ' + l.name + ' trocado'); else ack('erro: ' + (res && res.error));
  }
  async function toggleActive(l) {
    if (ro) { ack('preview'); return; }
    const res = await apiPost('/rbac/login', { id: l.id, active: !l.active }).catch((e) => ({ error: e.message }));
    if (res && !res.error) { ack('✓ ' + l.name + (l.active ? ' desativado' : ' ativado')); setLogins((ls) => ls.map((x) => x.id === l.id ? { ...x, active: !x.active } : x)); }
    else ack('erro: ' + (res && res.error));
  }

  if (rbac.loading && !roles.length) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Carregando…</div>;
  if (rbac.error) return <div style={{ padding: 24, color: 'var(--bad)' }}>Erro: {String(rbac.error)}{rbac.error && rbac.error.unauthorized ? ' (só Admin acessa)' : ''}</div>;

  // agrupa funções por categoria
  const byCat = {};
  for (const f of fns) { (byCat[f.category || 'outros'] = byCat[f.category || 'outros'] || []).push(f); }

  return (
    <div style={{ padding: '18px 22px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Usuários & Permissões</h2>
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Logins do sistema e o que cada cargo (role) pode acessar.</span>
        {flash && <span style={{ fontSize: 12, color: flash.startsWith('erro') ? 'var(--bad)' : 'var(--hf-leaf-700)', fontWeight: 600 }}>{flash}</span>}
      </div>

      {/* LOGINS */}
      <h3 style={{ margin: '18px 0 8px' }}>Logins</h3>
      <div className="card" style={{ overflowX: 'auto', padding: 0, marginBottom: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ background: 'var(--surface-2)' }}>
            <th style={thS}>Nome</th><th style={thS}>Cargo (role)</th><th style={thS}>Status</th><th style={thS}>Ações</th>
          </tr></thead>
          <tbody>
            {logins.map((l) => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--border)', opacity: l.active ? 1 : 0.5 }}>
                <td style={tdS}><b>{l.name}</b></td>
                <td style={tdS}>{l.role_name} <span style={{ color: 'var(--text-3)', fontSize: 11 }}>({l.role})</span></td>
                <td style={tdS}>{l.active ? <span style={{ color: 'var(--hf-leaf-700)' }}>ativo</span> : <span style={{ color: 'var(--text-3)' }}>inativo</span>}</td>
                <td style={tdS}>
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <button onClick={() => changePin(l)} style={btnS}>trocar PIN</button>
                    <button onClick={() => toggleActive(l)} style={btnS}>{l.active ? 'desativar' : 'ativar'}</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* add login */}
      <div className="card" style={{ padding: '10px 14px', marginBottom: 20, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ fontSize: 13 }}>Novo login:</b>
        <input value={newLogin.name} onChange={(e) => setNewLogin((s) => ({ ...s, name: e.target.value }))} placeholder="nome"
          style={{ ...inpS, flex: '1 1 160px' }} />
        <select value={newLogin.role_id} onChange={(e) => setNewLogin((s) => ({ ...s, role_id: e.target.value }))} style={inpS}>
          <option value="">cargo…</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <input value={newLogin.pin} onChange={(e) => setNewLogin((s) => ({ ...s, pin: e.target.value }))} placeholder="PIN" inputMode="numeric"
          style={{ ...inpS, width: 100 }} />
        <button onClick={addLogin} style={{ ...btnS, background: 'var(--hf-navy-700)', color: '#fff', border: 'none', padding: '7px 14px' }}>+ criar</button>
      </div>

      {/* MATRIZ DE PERMISSÕES */}
      <h3 style={{ margin: '4px 0 4px' }}>Permissões por cargo</h3>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 10 }}>
        Marque o que cada cargo pode acessar. É aqui que o Admin ajusta o acesso do Manager (Henrique). O cargo <b>Admin</b> tem tudo.
      </div>
      <div className="card" style={{ overflowX: 'auto', padding: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead><tr style={{ background: 'var(--surface-2)' }}>
            <th style={{ ...thS, minWidth: 220 }}>Função</th>
            {roles.map((r) => <th key={r.id} style={{ ...thS, textAlign: 'center' }}>{r.name}</th>)}
          </tr></thead>
          <tbody>
            {Object.keys(byCat).map((cat) => (
              <React.Fragment key={cat}>
                <tr><td colSpan={roles.length + 1} style={{ padding: '8px 12px', background: 'var(--surface-2)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05, color: 'var(--text-3)', fontWeight: 700 }}>{CAT_LABEL[cat] || cat}</td></tr>
                {byCat[cat].map((f) => (
                  <tr key={f.key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={tdS}>{f.label} <span style={{ color: 'var(--text-3)', fontSize: 11 }} className="mono">{f.key}</span></td>
                    {roles.map((r) => {
                      const on = (r.functions || []).includes(f.key);
                      const isAdminRole = r.key === 'admin';
                      return (
                        <td key={r.id} style={{ ...tdS, textAlign: 'center' }}>
                          <input type="checkbox" checked={on} disabled={ro || isAdminRole}
                            onChange={(e) => toggle(r, f.key, e.target.checked)}
                            title={isAdminRole ? 'Admin sempre tem tudo' : ''}
                            style={{ width: 17, height: 17, cursor: (ro || isAdminRole) ? 'default' : 'pointer' }} />
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
  );
}

const thS = { padding: '9px 12px', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.04, color: 'var(--text-3)', whiteSpace: 'nowrap' };
const tdS = { padding: '8px 12px' };
const btnS = { fontSize: 11.5, padding: '4px 9px', borderRadius: 7, border: '1px solid var(--border)', cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--text)' };
const inpS = { padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 };
