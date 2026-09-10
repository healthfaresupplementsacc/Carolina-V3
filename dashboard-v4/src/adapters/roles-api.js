/* HEALTHFARE V4 — cargos do sistema (Bruno 09-09: "por cargo, não por nome").
 *
 * Backend: GET/PUT /api/adminpanel/roles/:role (src/routes/admin.js →
 * src/v3/roles.js). Hoje só existe `packing_operator` (responsável pelo P&P).
 * Vazio = as mensagens automáticas usam o genérico ("pessoal do packing").
 *
 * useRoleHolder(role)      → { holder, label_pt, label_en, fallback, loading, error, refresh }
 * setRoleHolder(role, id)  → PUT; id null esvazia o cargo
 * useActiveOperators()     → operadores ativos (pro select)
 */
import React from 'react';
import { adminGet, adminPut } from './admin-api.js';

export function useRoleHolder(role) {
  const [state, setState] = React.useState({ holder: null, label_pt: '', label_en: '', fallback: '', loading: true, error: null });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    adminGet('/roles/' + role)
      .then((d) => { if (alive) setState({ holder: (d && d.holder) || null, label_pt: d.label_pt || '', label_en: d.label_en || '', fallback: d.fallback || '', loading: false, error: null }); })
      .catch((e) => { if (alive) setState((s) => ({ ...s, loading: false, error: e })); });
    return () => { alive = false; };
  }, [role, nonce]);
  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}

export function setRoleHolder(role, personId) {
  return adminPut('/roles/' + role, { person_id: personId == null ? null : personId });
}

export function useActiveOperators() {
  const [ops, setOps] = React.useState([]);
  React.useEffect(() => {
    let alive = true;
    adminGet('/operators')
      .then((d) => { if (alive) setOps(((d && d.operators) || []).filter((o) => o.is_active !== false)); })
      .catch(() => { if (alive) setOps([]); });
    return () => { alive = false; };
  }, []);
  return ops;
}

/** Primeiro nome de quem ocupa o cargo, ou o rótulo genérico (pra chips/rodapés). */
export function holderShort(r) {
  if (r && r.holder && r.holder.name) return String(r.holder.name).trim().split(/\s+/)[0];
  return r && r.label_en ? r.label_en : 'Packing Operator';
}
