import React from 'react';
import { Icon } from './Icons.jsx';
import nyTime from '../utils/ny-time.cjs';
import { FalarCarolinaButton } from '../pages/CarolinaFalar.jsx';
// E7-refine2: logo real do HealthFare (H+leaf, azul/verde, "HEALTHFARE"
// wordmark). Substitui o SVG inline `BrandH` que era um esboço.
// Vite resolve a URL no build (com base /dashboard-v4/...).
import healthFareLogo from '../../assets/healthfare-logo.png';

/* Shell: sidebar nav + top bar + page wrapper.
   Routing via simple hash. Theme from <html data-theme>.
*/

const NAV = [
  { section: "Operação", en: "Operations", items: [
    { id: "hoje",      pt: "Hoje",          en: "Today",          icon: "home" },
    { id: "producao",  pt: "Produção",      en: "Production",     icon: "factory" },
    { id: "metas",     pt: "Metas",         en: "Goals",          icon: "target" },
    { id: "pessoas",   pt: "Pessoas",       en: "People",         icon: "people" },
  ]},
  { section: "Display", en: "Floor Display", items: [
    { id: "floor",     pt: "Painel da Fábrica", en: "Floor Display", icon: "tv" },
  ]},
  { section: "Outros", en: "Other", items: [
    { id: "pp",           pt: "P&P",            en: "Pick & Pack",     icon: "pp" },
    { id: "suporte",      pt: "Suporte",        en: "Support",         icon: "support" },
    { id: "produto",      pt: "Produto",        en: "Product",         icon: "product" },
    { id: "falar",        pt: "Falar",          en: "Speak",           icon: "chat" },
    { id: "planejamento", pt: "Planejamento",   en: "Planning",        icon: "plan" },
    // E0 ajuste: Carolina volta na nav como placeholder Bloco 5 (chat de aprendizado).
    { id: "carolina",     pt: "Carolina",       en: "Carolina",        icon: "chat" },
    { id: "config",       pt: "Config",         en: "Settings",        icon: "config" },
  ]},
];

const ALL_PAGES = NAV.flatMap(s => s.items);

function findPage(id) {
  return ALL_PAGES.find(p => p.id === id) || ALL_PAGES[0];
}

const Sidebar = ({ route, onRoute, collapsed, opLink }) => {
  return (
    <aside className="sidebar">
      <div className="brand brand-with-logo">
        {collapsed ? (
          // Sidebar colapsada: só o H+leaf cortado da extremidade esquerda
          <div className="brand-mark"><img src={healthFareLogo} alt="HealthFare" className="brand-logo-mini"/></div>
        ) : (
          <>
            <img src={healthFareLogo} alt="HealthFare" className="brand-logo-full"/>
            <div className="brand-sub">Production · V4</div>
          </>
        )}
      </div>
      <nav className="nav">
        {NAV.map(sec => (
          <React.Fragment key={sec.section}>
            {!collapsed && <div className="nav-section">{sec.section}<span style={{ opacity: 0.55, marginLeft: 6 }}>· {sec.en}</span></div>}
            {collapsed && <div style={{ height: 8 }}/>}
            {sec.items.map(it => (
              <a key={it.id} href={`#${it.id}`}
                 className={`nav-item ${route === it.id ? "active" : ""}`}
                 onClick={e => { e.preventDefault(); onRoute(it.id); }}>
                <span className="nav-ico"><Icon name={it.icon} size={17}/></span>
                {!collapsed && (
                  <>
                    <span className="nav-label">{it.pt}</span>
                    <span className="nav-sub-en">{it.en}</span>
                  </>
                )}
              </a>
            ))}
          </React.Fragment>
        ))}
      </nav>
      {!collapsed && opLink ? <div className="sidebar-oplink">{opLink}</div> : null}
      <div className="sidebar-foot">
        <div className="live-dot"/>
        {!collapsed && (
          <div className="sync-text">
            <b>Sincronizado</b><br/>
            <span>worker ativo · fila 0</span>
          </div>
        )}
      </div>
    </aside>
  );
};

// (E7-refine2) BrandH SVG removido — agora usa healthfare-logo.png direto.

const TopBar = ({ pageId, date, onDate, onToggleTweaks, theme, onTheme, onNewEvent,
                  workerNode, readOnly, onLogout, ack }) => {
  const page = findPage(pageId);
  return (
    <header className="topbar">
      <div className="page-title">
        <h1>{page.pt}</h1>
        <span className="en">· {page.en}</span>
        {pageId === "hoje" && (
          <span className="pill live" style={{ marginLeft: 12 }}>
            <span className="dot"/>ao vivo · live
          </span>
        )}
        {readOnly ? (
          <span className="pill" style={{ marginLeft: 8, background: "var(--surface-2)", color: "var(--text-3)" }}
                title="V4_ALLOW_WRITES=0 — edição/drag/criar são só preview">
            <span className="dot" style={{ background: "var(--text-3)" }}/>leitura · read-only
          </span>
        ) : (
          <span className="pill" style={{ marginLeft: 8, background: "rgba(34,179,93,0.12)", color: "var(--hf-leaf-700)", borderColor: "rgba(34,179,93,0.32)" }}
                title="V4_ALLOW_WRITES=1 — edits/drag/criar persistem em prod via PIN (auditados em v3.audit_log)">
            <span className="dot" style={{ background: "var(--hf-leaf-500)" }}/>edição ativa · write
          </span>
        )}
      </div>
      <div className="topbar-spacer"/>
      {workerNode}
      <FalarCarolinaButton ack={ack}/>
      <button className="icon-btn" title="Buscar" aria-label="Search"><Icon name="search" size={17}/></button>
      <button className="icon-btn" title="Notificações" aria-label="Notifications" style={{ position: "relative" }}>
        <Icon name="bell" size={17}/>
        <span style={{ position: "absolute", top: 6, right: 7, width: 7, height: 7, borderRadius: "50%", background: "var(--bad)", boxShadow: "0 0 0 2px var(--surface)" }}/>
      </button>
      <button className="icon-btn" title={`Tema: ${theme}`} aria-label="Toggle theme" onClick={onTheme}>
        <Icon name={theme === "dark" ? "sun" : "moon"} size={17}/>
      </button>
      <DatePicker date={date} onDate={onDate}/>
      {pageId === "hoje" && (
        <button className="btn primary" onClick={onNewEvent}>
          <Icon name="plus" size={15}/> Novo registro
        </button>
      )}
      {/* 🔧 gear → Painel Admin (nova aba). ANTES o gear estava no botão de
          logout (Icon config) e deslogava — bug. Agora gear = admin. */}
      <a className="icon-btn" href="/admin/" target="_blank" rel="noreferrer"
         title="Painel Admin (/admin/, nova aba)" aria-label="Admin">
        <Icon name="config" size={17}/>
      </a>
      {/* 👷 Página dos Operadores (nova aba) */}
      <a className="icon-btn" href="/op/" target="_blank" rel="noreferrer"
         title="Página dos Operadores (/op/, nova aba)" aria-label="Operadores">
        <Icon name="people" size={17}/>
      </a>
      {onLogout && (
        <button className="icon-btn" title="Sair (limpar PIN)" aria-label="Logout" onClick={onLogout}>
          <Icon name="x" size={17}/>
        </button>
      )}
    </header>
  );
};

const DatePicker = ({ date, onDate }) => {
  // E7-refine3 — fix do bug "Ter 26 mostra como Seg":
  //   ANTES: new Date('2026-05-26') → UTC midnight → getDay() em TZ negativa cai
  //          no dia anterior (NY UTC-4 → Mon; BRT UTC-3 → Mon).
  //   AGORA: parseYmdLocal cria Date(y,m-1,d,12,0,0) local-noon — getDay/getDate
  //          retornam os valores certos pro YYYY-MM-DD em qualquer fuso do user.
  const d = nyTime.parseYmdLocal(date);
  const isToday = date === nyTime.nyToday();
  const ptMonths = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const ptDays = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  const shift = (n) => {
    // shiftNyDate: aritmética em NY-noon-UTC → re-formata em NY date.
    // Robusto contra DST (sem cair em ambiguidade de meia-noite).
    onDate(nyTime.shiftNyDate(date, n));
  };
  if (!d) return null;
  return (
    <div className="date-picker">
      <button onClick={() => shift(-1)} title="Dia anterior"><Icon name="left" size={15}/></button>
      <div className="date-value">
        {isToday ? "Hoje" : ptDays[d.getDay()]}, {d.getDate()} {ptMonths[d.getMonth()]}
        <span className="small">{ptDays[d.getDay()]} · {isToday ? "Today" : ""}</span>
      </div>
      <button onClick={() => shift(1)} title="Próximo dia"><Icon name="right" size={15}/></button>
    </div>
  );
};

Object.assign(window, { Sidebar, TopBar, findPage, ALL_PAGES });

export { Sidebar, TopBar, findPage, ALL_PAGES };
