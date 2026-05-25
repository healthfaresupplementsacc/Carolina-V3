/* PinGate — protege o V4 inteiro com o mesmo PIN do dashboard atual.
   Porta direta de dashboard/src/App.jsx (PinGate fn).
   sessionStorage key: 'v3pin' (compartilhado com /dashboard atual).
*/
import React from 'react';
import { setPin } from '../adapters/from-api.js';

function PinGate({ onOk }) {
  const [v, setV] = React.useState('');
  const [err, setErr] = React.useState(false);

  const submit = (e) => {
    e.preventDefault();
    const pin = v.trim();
    if (!pin) { setErr(true); return; }
    setPin(pin);
    onOk();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg, #f7f8fb)', zIndex: 9999,
    }}>
      <div className="card" style={{
        padding: '28px 32px', minWidth: 320, maxWidth: 400,
        textAlign: 'center', boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{
          fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em',
          marginBottom: 6, color: 'var(--hf-navy-700, #1e3f8c)',
        }}>
          HealthFare · Production V4
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3, #6c7488)', marginBottom: 18 }}>
          Digite o PIN admin para continuar
        </div>
        <form onSubmit={submit}>
          <input
            type="password"
            value={v}
            placeholder="PIN"
            autoFocus
            onChange={(e) => { setV(e.target.value); setErr(false); }}
            style={{
              width: '100%', padding: '10px 12px', fontSize: 15,
              border: '1px solid var(--border, #d8dce5)', borderRadius: 8,
              background: 'var(--surface, #fff)', color: 'var(--text-1)',
              boxSizing: 'border-box',
            }}
          />
          <button type="submit" style={{
            marginTop: 12, width: '100%', padding: '10px 14px',
            fontSize: 14, fontWeight: 700, color: '#fff',
            background: 'var(--hf-navy-600, #2855ad)',
            border: 'none', borderRadius: 8, cursor: 'pointer',
          }}>
            Entrar
          </button>
        </form>
        {err && (
          <p style={{ color: 'var(--bad, #d9534f)', fontSize: 12, marginTop: 10 }}>
            Digite o PIN.
          </p>
        )}
      </div>
    </div>
  );
}

export { PinGate };
