import React from 'react';
import { Icon } from './Icons.jsx';
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

const Sidebar = ({ route, onRoute, collapsed }) => {
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
                  workerNode, readOnly, onLogout }) => {
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
        {readOnly && (
          <span className="pill" style={{ marginLeft: 8, background: "var(--surface-2)", color: "var(--text-3)" }}
                title="V4_ALLOW_WRITES=0 — edição/drag/criar são só preview até E5/E6">
            <span className="dot" style={{ background: "var(--text-3)" }}/>leitura · read-only
          </span>
        )}
      </div>
      <div className="topbar-spacer"/>
      {workerNode}
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
      {onLogout && (
        <button className="icon-btn" title="Sair (limpar PIN)" aria-label="Logout" onClick={onLogout}>
          <Icon name="config" size={17}/>
        </button>
      )}
    </header>
  );
};

const DatePicker = ({ date, onDate }) => {
  const d = new Date(date);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const ptMonths = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const ptDays = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  const shift = (n) => {
    const nd = new Date(d); nd.setDate(nd.getDate() + n);
    onDate(nd.toISOString().slice(0,10));
  };
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
