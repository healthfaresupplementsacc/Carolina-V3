import React from 'react';
import { Icon } from './Icons.jsx';
import { PontoStrip } from './PontoStrip.jsx';
import nyTime from '../utils/ny-time.cjs';
import { FalarCarolinaButton } from '../pages/CarolinaFalar.jsx';
import { can, getLogin } from '../adapters/from-api.js';
import { whGet } from '../adapters/warehouse-api.js';
// E7-refine2: logo real do HealthFare (H+leaf, azul/verde, "HEALTHFARE"
// wordmark). Substitui o SVG inline `BrandH` que era um esboço.
// Vite resolve a URL no build (com base /dashboard-v4/...).
import healthFareLogo from '../../assets/healthfare-logo.png';

/* Shell: sidebar nav + top bar + page wrapper.
   Routing via simple hash. Theme from <html data-theme>.
*/

// Nav REAGRUPADA (Bruno 08-03): menus principais colapsáveis com submenus.
// "Coisas conectadas ficam sob um menu principal; clica → submenu aparece."
// S15 (Bruno 08-18): nasce a seção ESTOQUE (Warehouse Inventory) com o hub novo,
// Aprovações e Locais; P&P + Picklist viram um SUBGRUPO dentro dela (saíram de
// Operação); Planejamento e Produto voltam pra Operação logo depois de Metas.
// S15 (Bruno 08-19, "organizar tudo"): as duas entradas "(antigo)" SAÍRAM do menu.
// As rotas #estoque-geral e #inventory continuam vivas pra quem tem link salvo,
// mas abrem com uma faixa dizendo que o hub substituiu a tela. Menu com dois
// caminhos pra mesma coisa é o que faz gente contar estoque no lugar errado.
const NAV = [
  { section: "Operação", en: "Operations", icon: "home", items: [
    { id: "hoje",         pt: "Hoje",         en: "Today",       icon: "home" },
    { id: "producao",     pt: "Produção",     en: "Production",  icon: "factory" },
    { id: "metas",        pt: "Metas",        en: "Goals",       icon: "target" },
    { id: "planejamento", pt: "Planejamento", en: "Planning",    icon: "plan" },
    { id: "produto",      pt: "Produto",      en: "Product",     icon: "product" },
    { id: "pessoas",      pt: "Pessoas",      en: "People",      icon: "people" },
  ]},
  // Seção nova (S15). Toda ela é gated por `view_stock` quando o login TEM lista
  // de funções; login sem lista nenhuma continua vendo tudo (ver `visible()`).
  { section: "Estoque", en: "Warehouse Inventory", icon: "product", fn: "view_stock", items: [
    { id: "estoque",            pt: "Estoque",                   en: "Warehouse",          icon: "product" },
    // S15.43 (Bruno 08-22): a porta de CARGA do armazém, logo depois do hub.
    { id: "estoque-montar",     pt: "Montar estoque",            en: "Load stock",         icon: "plan" },
    { id: "estoque-aprovacoes", pt: "Aprovações",                en: "Approvals",          icon: "target" },
    { id: "estoque-locais",     pt: "Locais",                    en: "Locations",          icon: "plan" },
    { id: "estoque-etiquetas",  pt: "Etiquetas",                 en: "Labels",             icon: "product" },
    { id: "produto-setup",      pt: "Product Setup",             en: "Product Setup",      icon: "config" },
    { id: "config-estoque",     pt: "Configurações",             en: "Inventory Settings", icon: "config" },
    // subgrupo P&P (mesmo colapso da seção, cabeçalho recuado)
    { id: "pp",       pt: "P&P",      en: "Pick & Pack", icon: "pp",      sub: "P&P" },
    { id: "picklist", pt: "Picklist", en: "Picklist",    icon: "product", sub: "P&P" },
  ]},
  { section: "Impressão", en: "Printing", icon: "factory", items: [
    { id: "impressao",    pt: "Impressão",      en: "Printing",        icon: "factory" },
  ]},
  { section: "Fábrica", en: "Floor", icon: "tv", items: [
    { id: "floor",     pt: "Painel da Fábrica", en: "Floor Display", icon: "tv" },
    { id: "cameras",   pt: "Câmeras",           en: "Cameras",       icon: "live" },
  ]},
  { section: "Assistente", en: "Assistant", icon: "chat", items: [
    { id: "carolina",     pt: "Carolina",       en: "Carolina",        icon: "chat" },
    { id: "falar",        pt: "Falar",          en: "Speak",           icon: "chat" },
    { id: "suporte",      pt: "Suporte",        en: "Support",         icon: "support" },
  ]},
  // Admin: só quem tem a função aparece (manager NÃO vê — Bruno 08-03).
  // Roadmap = plano do sistema inteiro, é assunto de admin, não de operação
  // (Bruno 08-21: "deveria estar dentro do menu do ADMIN").
  { section: "Admin", en: "Admin", icon: "config", items: [
    { id: "admin",        pt: "Admin",              en: "Admin panel",     icon: "config", fn: "admin_page" },
    { id: "roadmap",      pt: "Roadmap",            en: "Roadmap",         icon: "plan",   fn: "admin_page" },
    { id: "operadores",   pt: "Operadores",         en: "Operators",       icon: "people", fn: "admin_page" },
    { id: "usuarios",     pt: "Usuários & Acessos", en: "Users & Access",  icon: "people", fn: "manage_users" },
    { id: "config",       pt: "Config",             en: "Settings",        icon: "config", fn: "config_page" },
    { id: "sistema",      pt: "Sistema",            en: "System health",   icon: "config", fn: "manage_system" },
  ]},
];

/* Rotas que existem mas NÃO aparecem no menu (S15 08-19). Ficam alcançáveis por
   hash pra não quebrar link salvo nem favorito, e o TopBar continua achando o
   título delas. Cada uma renderiza a faixa "Página antiga" (ver LegacyBanner). */
const HIDDEN_PAGES = [
  { id: "estoque-geral", pt: "Ver estoque (antigo)",       en: "Stock (legacy)",          icon: "product", section: "Estoque" },
  { id: "inventory",     pt: "Estoque detalhado (antigo)", en: "Stock (legacy detailed)", icon: "product", section: "Estoque" },
];

const ALL_PAGES = NAV.flatMap(s => s.items).concat(HIDDEN_PAGES);

/* RBAC tolerante (S15): se o login TEM lista de funções, respeita `can()`;
   se NÃO tem lista nenhuma (login antigo, sem functions), mostra. Os logins de
   hoje (Admin/Henrique) têm '*' ou lista cheia, então nada some pra eles. */
function visible(fn) {
  if (!fn) return true;
  const l = getLogin();
  if (!l || !Array.isArray(l.functions)) return true;   // sem lista → não esconde
  return can(fn);
}

function findPage(id) {
  return ALL_PAGES.find(p => p.id === id) || ALL_PAGES[0];
}

/* Contador de propostas esperando, mostrado no item Aprovações (S15 08-19).
   Fonte: pending_summary.count do MESMO GET /overview que o hub já usa, a cada
   60s. Sem endpoint novo: quem só olha o menu precisa ver que tem gente parada
   esperando decisão, senão a proposta dorme a tarde inteira.
   Falha em silêncio: badge é informação extra, não pode derrubar a navegação. */
function usePendingCount() {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    const load = () => {
      whGet('/overview').then(
        (j) => {
          if (!alive) return;
          const s = j && j.data && j.data.pending_summary;
          setCount(s && Number.isFinite(Number(s.count)) ? Number(s.count) : 0);
        },
        () => { /* sem badge é melhor que menu quebrado */ },
      );
    };
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return count;
}

const sectionOf = (id) => {
  const sec = NAV.find((s) => s.items.some((it) => it.id === id));
  if (sec) return sec.section;
  // rota escondida (legado): mantém aberto o grupo a que ela pertence
  const hid = HIDDEN_PAGES.find((h) => h.id === id);
  return hid ? hid.section : NAV[0].section;
};

const Sidebar = ({ route, onRoute, collapsed, opLink, open, onClose }) => {
  // Menus colapsáveis (Bruno 08-03). Começa com só o grupo da página atual aberto.
  const [openSecs, setOpenSecs] = React.useState(() => ({ [sectionOf(route)]: true }));
  const pendingCount = usePendingCount();
  // sempre garante que o grupo da rota ativa esteja aberto quando a rota muda
  React.useEffect(() => { setOpenSecs((o) => ({ ...o, [sectionOf(route)]: true })); }, [route]);
  const toggle = (sec) => setOpenSecs((o) => ({ ...o, [sec]: !o[sec] }));

  return (
    <aside className={`sidebar ${open ? "sidebar--open" : ""}`}>
      <div className="brand brand-with-logo">
        {collapsed ? (
          <div className="brand-mark"><img src={healthFareLogo} alt="HealthFare" className="brand-logo-mini"/></div>
        ) : (
          <>
            <img src={healthFareLogo} alt="HealthFare" className="brand-logo-full"/>
            <div className="brand-sub">Production · V4</div>
          </>
        )}
      </div>
      <nav className="nav">
        {NAV.map(sec => {
          // seção inteira gated (S15: Estoque exige view_stock quando há lista)
          if (sec.fn && !visible(sec.fn)) return null;
          // filtra itens por função (RBAC): item com `fn` só aparece se o login tiver.
          const items = sec.items.filter((it) => !it.fn || can(it.fn));
          if (items.length === 0) return null;      // grupo sem itens visíveis → some
          const hasActive = items.some((it) => it.id === route);
          // aberto se: colapsado (mostra tudo), OU o usuário abriu, OU tem a página ativa
          // e o usuário não fechou explicitamente.
          const explicit = openSecs[sec.section];
          const isOpen = collapsed ? true : (explicit === true || (explicit !== false && hasActive));
          return (
            <div key={sec.section} className={`nav-group ${isOpen ? 'open' : ''}`}>
              {!collapsed && (
                <button type="button"
                  className={`nav-section nav-section-btn ${hasActive ? 'has-active' : ''}`}
                  onClick={() => toggle(sec.section)}
                  aria-expanded={isOpen}>
                  <span className="nav-ico" style={{ marginRight: 8, opacity: 0.8 }}><Icon name={sec.icon} size={15}/></span>
                  <span className="nav-section-label">{sec.section}</span>
                  <span className="nav-section-en">· {sec.en}</span>
                  <span className={`nav-caret ${isOpen ? 'up' : ''}`} aria-hidden="true">▾</span>
                </button>
              )}
              {collapsed && <div style={{ height: 8 }}/>}
              {isOpen && items.map((it, i) => {
                // subgrupo (S15): primeiro item com `sub` novo imprime o cabeçalho
                const prev = i > 0 ? items[i - 1] : null;
                const head = it.sub && (!prev || prev.sub !== it.sub);
                // badge do menu: só Aprovações, só quando tem gente esperando
                const badge = it.id === 'estoque-aprovacoes' && pendingCount > 0 ? pendingCount : 0;
                return (
                  <React.Fragment key={it.id}>
                    {head && !collapsed && <div className="nav-subgroup">{it.sub}</div>}
                    <a href={`#${it.id}`}
                       className={`nav-item ${it.sub ? 'nav-item-sub' : ''} ${route === it.id ? "active" : ""}`}
                       onClick={e => { e.preventDefault(); onRoute(it.id); if (onClose) onClose(); }}>
                      <span className="nav-ico"><Icon name={it.icon} size={17}/></span>
                      {!collapsed && (
                        <>
                          <span className="nav-label">{it.pt}</span>
                          {badge > 0 && (
                            <span className="nav-badge" data-nav-badge={it.id}
                                  title={badge + (badge === 1 ? ' proposta esperando' : ' propostas esperando')}>
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                          <span className="nav-sub-en">{it.en}</span>
                        </>
                      )}
                      {collapsed && badge > 0 && <span className="nav-badge nav-badge-dot" data-nav-badge={it.id} />}
                    </a>
                  </React.Fragment>
                );
              })}
            </div>
          );
        })}
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
                  workerNode, readOnly, onLogout, ack, onMenu, onSearch,
                  onBell, notifTotal = 0, notifBad = 0 }) => {
  const page = findPage(pageId);
  return (
    <header className="topbar">
      {/* Hambúrguer — só aparece no mobile (CSS .topbar-burger), abre o drawer */}
      <button className="icon-btn topbar-burger" onClick={onMenu} aria-label="Menu" title="Menu">
        <Icon name="menu" size={18}/>
      </button>
      <div className="page-title">
        <h1>{page.pt}</h1>
        <span className="en">· {page.en}</span>
        {/* As pills "ao vivo · live" e "edição ativa · write" SAÍRAM (Bruno
            08-19): não informavam nada acionável, só ocupavam o topo. No lugar
            entra o PONTO (quem está na fábrica + botão de deslogar).
            A pill de LEITURA fica: essa é um aviso real, porque muda o que os
            botões da página fazem de verdade. */}
        {readOnly && (
          <span className="pill" style={{ marginLeft: 12 }}
                title="V4_ALLOW_WRITES=0 — edição/drag/criar são só preview">
            <span className="dot" style={{ background: "var(--ink-faint)" }}/>leitura · read-only
          </span>
        )}
        <PontoStrip pageId={pageId}/>
      </div>
      <div className="topbar-spacer"/>
      {/* hide-mobile: secundários somem no celular (workerNode/falar/busca/bell/admin/op
          ficam acessíveis pelo drawer ou não-essenciais na tela pequena). */}
      <span className="hide-mobile" style={{ display: "contents" }}>{workerNode}</span>
      <span className="hide-mobile"><FalarCarolinaButton ack={ack}/></span>
      <button className="icon-btn" title="Buscar (produto, lote, pessoa, tarefa)" aria-label="Search" onClick={onSearch}><Icon name="search" size={17}/></button>
      <button className="icon-btn" title="Notificações" aria-label="Notifications" onClick={onBell} style={{ position: "relative" }}>
        <Icon name="bell" size={17}/>
        {notifTotal > 0 && (
          <span style={{
            position: "absolute", top: -5, right: -5, minWidth: 16, height: 16, padding: "0 4px",
            borderRadius: 999, background: notifBad > 0 ? "var(--kit-bad)" : "var(--ink-faint)", color: "#fff",
            font: "500 10px var(--font-mono)", lineHeight: "16px", textAlign: "center",
            boxShadow: "0 0 0 2px var(--kit-surface)",
          }}>{notifTotal > 99 ? "99+" : notifTotal}</span>
        )}
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
      <a className="icon-btn hide-mobile" href="/admin/" target="_blank" rel="noreferrer"
         title="Painel Admin (/admin/, nova aba)" aria-label="Admin">
        <Icon name="config" size={17}/>
      </a>
      {/* 👷 Página dos Operadores (nova aba) */}
      <a className="icon-btn hide-mobile" href="/op/" target="_blank" rel="noreferrer"
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
