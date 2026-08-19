/* PinGate — protege o V4 inteiro com o mesmo PIN do dashboard atual.
   Porta direta de dashboard/src/App.jsx (PinGate fn).
   sessionStorage key: 'v3pin' (compartilhado com /dashboard atual).
*/
import React from 'react';
import { login } from '../adapters/from-api.js';

function PinGate({ onOk }) {
  const [v, setV] = React.useState('');
  const [err, setErr] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const pin = v.trim();
    if (!pin) { setErr('Digite o PIN.'); return; }
    setBusy(true); setErr('');
    try {
      const info = await login(pin);   // valida no servidor + guarda identidade/funções
      onOk(info);
    } catch (ex) {
      setErr(ex.unauthorized ? 'PIN inválido.' : (ex.message || 'Erro ao entrar.'));
    } finally { setBusy(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--ground, #f4f8fc)', zIndex: 9999,
      fontFamily: 'var(--font)',
    }}>
      <div className="kit-card" style={{
        padding: '28px 24px', width: 'min(360px, 92vw)', maxWidth: 400,
        textAlign: 'center', boxShadow: 'var(--shadow-pop)',
      }}>
        <div className="kit-h2" style={{ marginBottom: 4 }}>
          HealthFare <em style={{ color: 'var(--green-d)', fontStyle: 'italic' }}>Production</em>
        </div>
        <div className="kit-mlabel" style={{ marginBottom: 18 }}>
          Digite o PIN admin para continuar
        </div>
        <form onSubmit={submit}>
          <input
            className="kit-input"
            type="password"
            inputMode="numeric"
            value={v}
            placeholder="PIN"
            autoFocus
            onChange={(e) => { setV(e.target.value); setErr(''); }}
            style={{ width: '100%', padding: '12px', fontSize: 16, boxSizing: 'border-box', textAlign: 'center' }}
          />
          <button className="kit-btn primary" type="submit" disabled={busy}
                  style={{ marginTop: 12, width: '100%', cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        {err && (
          <p style={{ color: 'var(--bad-deep, #a02c20)', fontSize: 12, marginTop: 10 }}>
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

export { PinGate };
