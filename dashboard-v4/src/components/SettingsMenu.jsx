import React from 'react';
import { Icon } from './Icons.jsx';
import { FloatingPopover } from './FloatingPopover.jsx';
import { FalarCarolina } from '../pages/CarolinaFalar.jsx';
import { useFetch } from '../adapters/from-api.js';

/* ═══════════════════════════════════════════════════════════════════
   ENGRENAGEM = MENU (Bruno 09-12).

   Antes o gear abria o /admin/ em outra aba. Bruno: "não acho que a engrenagem
   deva ir pra outra página; ela abre um menu pequeno onde eu mudo as
   configurações e tal; e a Carolina vai pra dentro da engrenagem".

   O menu tem o que era solto na barra:
     · Aparência: tema, densidade, rótulos (os mesmos tweaks de sempre)
     · Carolina: falar como Carolina (o popover de sempre, aberto daqui)
     · Atalhos: Painel Admin e Página dos operadores (novas abas)
     · Sistema: o estado do worker (saiu da barra — "não tem necessidade")
     · Sair
   ═══════════════════════════════════════════════════════════════════ */

function Seg({ value, options, onChange }) {
  return (
    <span className="smenu-seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
                className={`smenu-seg-btn ${value === o.value ? 'on' : ''}`}
                onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </span>
  );
}

/* Só busca /health quando o menu está aberto: o pill antigo pollava a barra
   inteira o tempo todo pra mostrar "worker ativo" que ninguém lia. */
function WorkerLine() {
  const { data } = useFetch('/health', []);
  if (!data) return <span className="smenu-muted">verificando…</span>;
  const w = data.worker || {};
  const ok = !!w.alive;
  return (
    <span className="smenu-worker" title={`fila ${data.queue || 0} · ${data.mode || '?'}`}>
      <span className="glance-dot" style={{ background: ok ? 'var(--hf-leaf-500, #22b35d)' : 'var(--bad, #d9534f)' }}/>
      worker {ok ? 'ativo' : 'sem tick'} · fila {data.queue || 0}
    </span>
  );
}

export function SettingsMenu({ tweaks, setTweak, onLogout, ack }) {
  const [open, setOpen] = React.useState(false);
  const [anchor, setAnchor] = React.useState(null);
  const [carol, setCarol] = React.useState(false);
  const [carolAnchor, setCarolAnchor] = React.useState(null);

  const toggle = (e) => {
    setAnchor({ x: e.clientX, y: e.clientY });
    setOpen((v) => !v);
  };
  const openCarol = (e) => {
    setCarolAnchor({ x: e.clientX, y: e.clientY });
    setOpen(false);
    setCarol(true);
  };
  const t = tweaks || {};
  const set = (k, v) => setTweak && setTweak(k, v);

  return (
    <>
      <button type="button" className={`icon-btn smenu-trigger ${open ? 'active' : ''}`}
              title="Ajustes" aria-label="Ajustes" aria-expanded={open} onClick={toggle}>
        <Icon name="config" size={17}/>
      </button>

      <FloatingPopover open={open} anchor={anchor} width={300}
                       onClose={() => setOpen(false)} anchorSelector=".smenu-trigger"
                       className="smenu">
        <div className="smenu-body" data-settings-menu>
          <div className="kit-mlabel smenu-sec">Aparência</div>
          <div className="smenu-row"><span>Tema</span>
            <Seg value={t.theme} onChange={(v) => set('theme', v)}
                 options={[{ value: 'light', label: 'Claro' }, { value: 'dark', label: 'Escuro' }]}/>
          </div>
          <div className="smenu-row"><span>Densidade</span>
            <Seg value={t.density} onChange={(v) => set('density', v)}
                 options={[{ value: 'compact', label: 'Compacto' }, { value: 'spacious', label: 'Espaçoso' }]}/>
          </div>
          <div className="smenu-row"><span>Rótulos</span>
            <Seg value={t.language} onChange={(v) => set('language', v)}
                 options={[{ value: 'bilingual', label: 'PT/EN' }, { value: 'pt', label: 'PT' }, { value: 'en', label: 'EN' }]}/>
          </div>

          <div className="kit-mlabel smenu-sec">Carolina</div>
          <button type="button" className="smenu-item" data-smenu="carolina" onClick={openCarol}>
            <Icon name="chat" size={14}/> Falar como Carolina <span className="smenu-muted">porta manual</span>
          </button>

          <div className="kit-mlabel smenu-sec">Atalhos</div>
          <a className="smenu-item" href="/admin/" target="_blank" rel="noreferrer" data-smenu="admin">
            <Icon name="config" size={14}/> Painel Admin <span className="smenu-muted">nova aba</span>
          </a>
          <a className="smenu-item" href="/op/" target="_blank" rel="noreferrer" data-smenu="op">
            <Icon name="people" size={14}/> Página dos operadores <span className="smenu-muted">nova aba</span>
          </a>

          <div className="kit-mlabel smenu-sec">Sistema</div>
          <div className="smenu-row">{open && <WorkerLine/>}</div>

          {onLogout && (
            <button type="button" className="smenu-item smenu-danger" data-smenu="sair"
                    onClick={() => { setOpen(false); onLogout(); }}>
              <Icon name="power" size={14}/> Sair <span className="smenu-muted">limpa o PIN</span>
            </button>
          )}
        </div>
      </FloatingPopover>

      {/* Carolina mora aqui (fora do menu) pra sobreviver ao menu fechar. */}
      <FloatingPopover open={carol} anchor={carolAnchor} width={520}
                       onClose={() => setCarol(false)} draggable above
                       header={(
                         <>
                           <Icon name="chat" size={14}/>
                           <b style={{ flex: 1, fontSize: 12.5 }}>Falar como Carolina · porta manual</b>
                           <button className="icon-btn" onClick={() => setCarol(false)} style={{ padding: 4, width: 26, height: 26 }} aria-label="Fechar">
                             <Icon name="x" size={11}/>
                           </button>
                         </>
                       )}>
        {carol && <FalarCarolina ack={ack} compact/>}
      </FloatingPopover>
    </>
  );
}

export default SettingsMenu;
