#!/usr/bin/env node
'use strict';
/**
 * build-map-html.js — regenerates docs/architecture/MASTER_SYSTEM_MAP.html from the .mmd sources.
 *
 * Usage:  node docs/architecture/build-map-html.js
 *
 * The HTML embeds every map (master + maps/*.mmd) so the page is self-contained apart from the
 * Mermaid library (loaded from jsDelivr; open the page with internet, or vendor mermaid.min.mjs
 * next to it and it will be picked up automatically). Bruno edits in the page; edits autosave in
 * the browser (localStorage) and can be downloaded as .mmd to overwrite the source files.
 *
 * Page features (all inline, no build step):
 *   - 10 tabs (master + 9 drill-downs), live re-render, localStorage draft per map
 *   - ID search (highlight + pan to first match), class filter (dim non-matching)
 *   - "Human edits" quick panel: click node A then node B -> FROM/TO, then a directive button
 *     appends a correctly-formatted `%% DIRECTIVE ...` line below `%% ==== HUMAN EDITS BELOW`
 *   - pan / wheel-zoom / fit, selected-node info line, Mermaid errors shown in red (page not blanked)
 *
 * Docs tooling only — touches nothing under src/.
 */
const fs = require('fs');
const path = require('path');

const here = __dirname;
const masterPath = path.join(here, 'MASTER_SYSTEM_MAP.mmd');
const mapsDir = path.join(here, 'maps');
const outPath = path.join(here, 'MASTER_SYSTEM_MAP.html');

const maps = [{ key: 'MASTER', title: 'Master map', file: 'MASTER_SYSTEM_MAP.mmd', src: fs.readFileSync(masterPath, 'utf8') }];
for (const f of fs.readdirSync(mapsDir).filter((x) => x.endsWith('.mmd')).sort()) {
  maps.push({ key: f.replace(/\.mmd$/, ''), title: f.replace(/\.mmd$/, ''), file: 'maps/' + f, src: fs.readFileSync(path.join(mapsDir, f), 'utf8') });
}
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stamp = new Date().toISOString().slice(0, 10);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HealthFare System Map</title>
<style>
  :root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2430;--muted:#5b6573;--line:#dde3ea;--navy:#0f4c92;--green:#44ae4f;--red:#c62828;--amber:#f9a825}
  *{box-sizing:border-box}
  body{margin:0;font-family:Manrope,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);height:100vh;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
  header h1{font-size:16px;margin:0;color:var(--navy)}
  header .sub{font-size:12px;color:var(--muted)}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
  .tab{padding:5px 10px;border:1px solid var(--line);border-radius:999px;background:#fff;cursor:pointer;font-size:12px}
  .tab.active{background:var(--navy);color:#fff;border-color:var(--navy)}
  main{flex:1;display:grid;grid-template-columns:440px 1fr;min-height:0}
  #left{display:flex;flex-direction:column;border-right:1px solid var(--line);background:var(--panel);min-height:0}
  .bar{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border-bottom:1px solid var(--line);align-items:center}
  .bar button,.bar select,.bar input[type=text]{font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-family:inherit}
  .bar input[type=text]{cursor:text}
  .bar button.primary{background:var(--navy);color:#fff;border-color:var(--navy)}
  .bar button.warn{border-color:var(--red);color:var(--red)}
  textarea{flex:1;width:100%;border:0;resize:none;padding:10px;font:12px/1.45 ui-monospace,Consolas,Menlo,monospace;color:#111;outline:none;min-height:0}
  #status{font-size:11px;padding:6px 10px;border-top:1px solid var(--line);color:var(--muted);white-space:pre-wrap;max-height:120px;overflow:auto}
  #status.err{color:var(--red);background:#fdecea;font-weight:600}
  #right{position:relative;overflow:hidden;background:
     radial-gradient(circle at 1px 1px,#d9dee6 1px,transparent 0) 0 0/18px 18px}
  #stage{position:absolute;inset:0;cursor:grab}
  #stage:active{cursor:grabbing}
  #canvas{transform-origin:0 0;position:absolute;left:0;top:0}
  #canvas svg{max-width:none!important;height:auto}
  .zoombar{position:absolute;right:12px;top:12px;display:flex;gap:6px;z-index:5}
  .zoombar button{width:32px;height:32px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-size:16px}
  .legend{position:absolute;left:12px;bottom:12px;background:rgba(255,255,255,.95);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:11px;line-height:1.5;z-index:5}
  .legend b{color:var(--navy)}
  .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px;border:1px solid #999}
  details.help{font-size:12px;padding:6px 10px;border-bottom:1px solid var(--line);background:#fbfcfe}
  details.help code{background:#eef2f7;padding:1px 4px;border-radius:3px}

  /* ---- search + filter + human-edit panel ---- */
  .tools{border-bottom:1px solid var(--line);background:#fbfcfe}
  .toolrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:7px 8px}
  .toolrow + .toolrow{border-top:1px dashed var(--line)}
  .toolrow label.lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:700;min-width:52px}
  #search{flex:1;min-width:120px;font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-family:ui-monospace,Consolas,monospace}
  #search:focus{outline:2px solid var(--navy);outline-offset:-1px}
  #searchCount{font-size:11px;color:var(--muted);min-width:56px}
  .toolrow button{font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer;font-family:inherit}
  .toolrow button:hover{border-color:var(--navy);color:var(--navy)}
  .chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;background:#fff;cursor:pointer;user-select:none}
  .chip input{margin:0;cursor:pointer}
  #hePanel{padding:7px 8px;border-top:1px dashed var(--line)}
  #hePanel .idrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
  #hePanel input.idin{width:112px;font:12px ui-monospace,Consolas,monospace;padding:4px 6px;border:1px solid var(--line);border-radius:6px}
  #hePanel input.idin.active{border-color:var(--green);box-shadow:0 0 0 2px rgba(68,174,79,.22)}
  #hePanel .dirs{display:flex;gap:4px;flex-wrap:wrap}
  #hePanel .dirs button{font-size:11px;font-weight:700;padding:4px 8px;border:1px solid var(--navy);color:var(--navy);background:#fff;border-radius:6px;cursor:pointer;letter-spacing:.02em}
  #hePanel .dirs button:hover{background:var(--navy);color:#fff}
  #heNote{flex:1;min-width:120px;font-size:12px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;font-family:inherit}
  #selInfo{font-size:11px;color:var(--muted);padding:5px 8px;border-top:1px dashed var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #selInfo b{color:var(--navy)}
  .hint{font-size:10px;color:var(--muted)}

  /* ---- svg node states (applied to the rendered mermaid svg) ---- */
  #canvas g.node.hf-dim{opacity:.13}
  #canvas g.node.hf-hit > rect, #canvas g.node.hf-hit > polygon, #canvas g.node.hf-hit > circle,
  #canvas g.node.hf-hit > path, #canvas g.node.hf-hit > ellipse{stroke:#44ae4f!important;stroke-width:5px!important}
  #canvas g.node.hf-sel > rect, #canvas g.node.hf-sel > polygon, #canvas g.node.hf-sel > circle,
  #canvas g.node.hf-sel > path, #canvas g.node.hf-sel > ellipse{stroke:#0f4c92!important;stroke-width:5px!important}
  @media (max-width:900px){main{grid-template-columns:1fr;grid-template-rows:46vh 1fr}#left{border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<header>
  <h1>HealthFare Tracker · System Map</h1>
  <span class="sub">generated ${stamp} · edit left, see right · your edits autosave in this browser · Download writes .mmd</span>
  <div class="tabs" id="tabs"></div>
</header>
<main>
  <section id="left">
    <div class="bar">
      <button class="primary" id="btnRender" title="Ctrl+Enter">Render</button>
      <button id="btnDownload">Download .mmd</button>
      <button id="btnCopy">Copy</button>
      <button class="warn" id="btnReset" title="Discard browser draft, restore generated source">Reset to generated</button>
      <select id="insert" title="Insert a directive template at cursor">
        <option value="">+ directive…</option>
        <option value="%% CONNECT    FROM_ID --&gt; TO_ID   note">CONNECT</option>
        <option value="%% DISCONNECT FROM_ID --&gt; TO_ID   why">DISCONNECT</option>
        <option value="%% MOVE       ID UNDER PARENT_ID  note">MOVE</option>
        <option value="%% SAME       ID_A == ID_B         note">SAME</option>
        <option value="%% FEEDS      FROM_ID --&gt; TO_ID   note">FEEDS</option>
        <option value="%% WRONG      R000 or FROM_ID --&gt; TO_ID   why">WRONG</option>
        <option value="%% REORG      GROUP_ID  how">REORG</option>
        <option value="%% NOTE       ID  free text">NOTE</option>
      </select>
      <label style="font-size:12px;margin-left:auto" title="Wrap long labels + stack sibling nodes in columns at render time (sources untouched)"><input type="checkbox" id="compact" checked> compact</label>
      <label style="font-size:12px"><input type="checkbox" id="autoRender" checked> live</label>
    </div>

    <div class="tools">
      <div class="toolrow">
        <label class="lbl" for="search">Buscar</label>
        <input type="text" id="search" placeholder="S02_08, op.js, Veeqo…" spellcheck="false" autocomplete="off">
        <span id="searchCount">—</span>
        <button id="searchNext" title="next match">↓</button>
        <button id="searchClear" title="clear">×</button>
      </div>
      <div class="toolrow" id="filterRow">
        <label class="lbl">Classes</label>
        <span id="filterChips"></span>
        <button id="filterAll" title="show all classes">all</button>
      </div>
      <div id="hePanel">
        <div class="idrow">
          <label class="lbl">Human</label>
          <input type="text" class="idin" id="heFrom" placeholder="FROM id" spellcheck="false" autocomplete="off">
          <span class="hint">→</span>
          <input type="text" class="idin" id="heTo" placeholder="TO id" spellcheck="false" autocomplete="off">
          <button id="heSwap" title="swap FROM/TO">⇄</button>
          <button id="heClear" title="clear both">×</button>
        </div>
        <div class="idrow">
          <input type="text" id="heNote" placeholder="motivo / nota (opcional)" autocomplete="off">
        </div>
        <div class="dirs" id="heDirs">
          <button data-dir="CONNECT">CONNECT</button>
          <button data-dir="DISCONNECT">DISCONNECT</button>
          <button data-dir="MOVE">MOVE</button>
          <button data-dir="SAME">SAME</button>
          <button data-dir="FEEDS">FEEDS</button>
          <button data-dir="WRONG">WRONG</button>
          <button data-dir="NOTE">NOTE</button>
          <button data-dir="REORG">REORG</button>
        </div>
      </div>
      <div id="selInfo">Selecionado: <b>—</b> · clique num nó: 1º = FROM, 2º = TO</div>
    </div>

    <details class="help"><summary>How to edit so Claude understands</summary>
      <p>Node IDs are stable (<code>S02_08</code> = S02.08 in STRUCTURE_INDEX.md). Put your changes <b>below</b> the line <code>%% ==== HUMAN EDITS BELOW</code> — either real Mermaid lines using existing IDs, or directives (use the “+ directive…” menu, or the <b>Human</b> buttons: click a node = FROM, click a second node = TO, then press a directive). Then <b>Download</b> and overwrite <code>docs/architecture/MASTER_SYSTEM_MAP.mmd</code> (or the drill-down file shown in the tab), or just tell Claude where you saved it. Rescans never overwrite the HUMAN EDITS section.</p>
      <p>Line styles: <code>--&gt;</code> verified · <code>-.-&gt;</code> partial/conditional/disconnected · <code>==&gt;</code> duplicate path. Colors: green verified · amber partial · red-dashed orphaned · purple-dotted unknown · blue external · teal satellite.</p>
    </details>
    <textarea id="src" spellcheck="false"></textarea>
    <div id="status">ready</div>
  </section>
  <section id="right">
    <div class="zoombar"><button id="zin">+</button><button id="zout">−</button><button id="zfit" title="fit">⤢</button></div>
    <div id="stage"><div id="canvas"><div id="out"></div></div></div>
    <div class="legend"><b>Legend</b><br>
      <span class="sw" style="background:#e8f5e9;border-color:#2e7d32"></span>VERIFIED &nbsp;
      <span class="sw" style="background:#fff8e1;border-color:#f9a825"></span>PARTIAL &nbsp;
      <span class="sw" style="background:#fdecea;border-color:#c62828"></span>ORPHANED &nbsp;
      <span class="sw" style="background:#ede7f6;border-color:#6a1b9a"></span>UNKNOWN<br>
      <span class="sw" style="background:#e3f2fd;border-color:#1565c0"></span>External &nbsp;
      <span class="sw" style="background:#e0f7fa;border-color:#00838f"></span>Satellite &nbsp;
      <span class="sw" style="background:#0f4c92;border-color:#0f4c92"></span>Hub (wire.js) &nbsp;
      <span class="sw" style="background:#eef4ff;border-color:#0f4c92;border-style:dashed"></span>PLANNED (not built) &nbsp;
      <span class="sw" style="background:#fff;border-color:#c62828;border-style:dotted"></span>Open question<br>
      <code>--&gt;</code> verified · <code>-.-&gt;</code> partial/disconnected · <code>==&gt;</code> duplicate path · edge label = R-id
    </div>
  </section>
</main>

${maps.map((m) => `<script type="text/plain" data-map="${attr(m.key)}" data-file="${attr(m.file)}" data-title="${attr(m.title)}">\n${esc(m.src)}\n</script>`).join('\n')}

<script type="module">
  // Try a local vendored copy first (fully offline), else jsDelivr.
  let mermaid;
  try { mermaid = (await import('./mermaid.min.mjs')).default; }
  catch (e) { mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs')).default; }
  mermaid.initialize({ startOnLoad:false, securityLevel:'loose', theme:'default', flowchart:{ useMaxWidth:false, htmlLabels:true, curve:'basis' }, maxTextSize: 200000 });

  const mapsEls = [...document.querySelectorAll('script[data-map]')];
  const maps = mapsEls.map(el => ({ key: el.dataset.map, file: el.dataset.file, title: el.dataset.title, generated: el.textContent.replace(/^\\n/, '') }));
  const $ = (id) => document.getElementById(id);
  const ta = $('src'), out = $('out'), status = $('status'), tabs = $('tabs'), canvas = $('canvas'), stage = $('stage');
  let cur = null, timer = null, scale = 1, tx = 20, ty = 20;
  const LS = (k) => 'hf-map-draft:' + k;

  // ---------------------------------------------------------------- status / transform
  function setStatus(msg, err){ status.textContent = msg; status.className = err ? 'err' : ''; }
  function apply(){ canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }

  // ---------------------------------------------------------------- class filter state
  const CLASSES = ['verified','partial','orphaned','unknown','external','satellite','planned','question'];
  const classOn = {}; CLASSES.forEach(c => classOn[c] = true);
  (function buildChips(){
    const host = $('filterChips');
    CLASSES.forEach(c => {
      const l = document.createElement('label'); l.className = 'chip'; l.dataset.cls = c;
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.cls = c;
      cb.addEventListener('change', () => { classOn[c] = cb.checked; applyDecor(); });
      l.appendChild(cb); l.appendChild(document.createTextNode(c)); host.appendChild(l);
    });
  })();
  $('filterAll').onclick = () => {
    CLASSES.forEach(c => { classOn[c] = true; const cb = document.querySelector('input[data-cls="' + c + '"]'); if (cb) cb.checked = true; });
    applyDecor();
  };

  // ---------------------------------------------------------------- node helpers
  function nodeId(g){ return (g.id || '').replace(/^flowchart-/, '').replace(/-\\d+$/, ''); }
  function nodeLabel(g){ return (g.textContent || '').replace(/\\s+/g, ' ').trim(); }
  function nodeClasses(g){ return [...(g.classList || [])]; }
  function allNodes(){ return [...out.querySelectorAll('g.node')]; }

  // ---------------------------------------------------------------- search
  let matches = [], matchIdx = -1;
  function computeMatches(){
    const q = $('search').value.trim().toLowerCase();
    if (!q) { matches = []; matchIdx = -1; $('searchCount').textContent = '—'; return; }
    matches = allNodes().filter(g => (nodeId(g) + ' ' + nodeLabel(g)).toLowerCase().includes(q));
    matchIdx = matches.length ? 0 : -1;
    $('searchCount').textContent = matches.length ? (matchIdx + 1) + '/' + matches.length : '0';
  }
  function panToNode(g){
    if (!g) return;
    const svg = out.querySelector('svg'); if (!svg) return;
    const sr = svg.getBoundingClientRect(), gr = g.getBoundingClientRect(), st = stage.getBoundingClientRect();
    // node centre in unscaled canvas coordinates
    const cx = (gr.left + gr.width / 2 - sr.left) / scale;
    const cy = (gr.top + gr.height / 2 - sr.top) / scale;
    tx = st.width / 2 - cx * scale;
    ty = st.height / 2 - cy * scale;
    apply();
  }
  function doSearch(pan){
    computeMatches();
    applyDecor();
    if (pan && matchIdx >= 0) panToNode(matches[matchIdx]);
    const q = $('search').value.trim();
    if (q) setStatus('busca "' + q + '": ' + matches.length + ' nó(s)' + (matches.length ? ' — ' + matches.slice(0, 6).map(nodeId).join(', ') + (matches.length > 6 ? '…' : '') : ''));
  }
  $('search').addEventListener('input', () => doSearch(true));
  $('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nextMatch(); } });
  function nextMatch(){
    if (!matches.length) return;
    matchIdx = (matchIdx + 1) % matches.length;
    $('searchCount').textContent = (matchIdx + 1) + '/' + matches.length;
    applyDecor(); panToNode(matches[matchIdx]);
  }
  $('searchNext').onclick = nextMatch;
  $('searchClear').onclick = () => { $('search').value = ''; doSearch(false); setStatus('busca limpa'); };

  // ---------------------------------------------------------------- decoration (search hits + class dim + selection)
  let selId = null;
  function applyDecor(){
    const hit = new Set(matches);
    const anyFilterOff = CLASSES.some(c => !classOn[c]);
    allNodes().forEach(g => {
      g.classList.toggle('hf-hit', hit.has(g));
      g.classList.toggle('hf-sel', !!selId && nodeId(g) === selId);
      let dim = false;
      if (anyFilterOff) {
        const cs = nodeClasses(g).filter(c => CLASSES.includes(c));
        // nodes carrying no known class are kept visible (they are structural / untyped)
        if (cs.length) dim = !cs.some(c => classOn[c]);
      }
      g.classList.toggle('hf-dim', dim);
    });
  }

  // ---------------------------------------------------------------- human-edit panel
  let nextSlot = 'from';
  function setSlotUI(){
    $('heFrom').classList.toggle('active', nextSlot === 'from');
    $('heTo').classList.toggle('active', nextSlot === 'to');
  }
  setSlotUI();
  function pickNode(id, label){
    selId = id;
    let slot;
    if (nextSlot === 'from') { $('heFrom').value = id; nextSlot = 'to'; slot = 'FROM'; }
    else { $('heTo').value = id; nextSlot = 'from'; slot = 'TO'; }
    setSlotUI(); applyDecor();
    $('selInfo').innerHTML = 'Selecionado: <b>' + id + '</b> → ' + slot + ' — ' +
      (label || '').slice(0, 80) + ' <span class="hint">(próximo clique = ' + nextSlot.toUpperCase() + ')</span>';
  }
  $('heSwap').onclick = () => { const a = $('heFrom').value; $('heFrom').value = $('heTo').value; $('heTo').value = a; };
  $('heClear').onclick = () => { $('heFrom').value = ''; $('heTo').value = ''; $('heNote').value = ''; nextSlot = 'from'; setSlotUI(); setStatus('FROM/TO limpos'); };

  const HUMAN_MARK = '%% ==== HUMAN EDITS BELOW';
  function appendHumanLine(line){
    let v = ta.value.replace(/\\s+$/, '');
    const idx = v.indexOf(HUMAN_MARK);
    if (idx === -1) {
      v = v + '\\n\\n' + HUMAN_MARK + ' — NEVER OVERWRITTEN BY RESCANS ======================\\n' + line + '\\n';
    } else {
      v = v + '\\n' + line + '\\n';
    }
    ta.value = v;
    ta.scrollTop = ta.scrollHeight;
    if (cur) localStorage.setItem(LS(cur.key), ta.value);
    schedule();
    return line;
  }
  function pad(s, n){ return (s + '          ').slice(0, Math.max(n, s.length)); }
  function buildDirective(dir){
    const a = $('heFrom').value.trim(), b = $('heTo').value.trim(), note = $('heNote').value.trim();
    const head = '%% ' + pad(dir, 10) + ' ';
    if (dir === 'MOVE')  { if (!a || !b) return null; return head + a + ' UNDER ' + b + (note ? '  ' + note : ''); }
    if (dir === 'SAME')  { if (!a || !b) return null; return head + a + ' == ' + b + (note ? '  ' + note : ''); }
    if (dir === 'NOTE')  { if (!a) return null; return head + a + '  ' + (note || '(escreva a nota)'); }
    if (dir === 'REORG') { if (!a) return null; return head + a + '  ' + (note || '(como reorganizar)'); }
    if (dir === 'WRONG') { if (!a) return null; return head + (b ? a + ' --> ' + b : a) + (note ? '  ' + note : ''); }
    if (!a || !b) return null;                     // CONNECT / DISCONNECT / FEEDS
    return head + a + ' --> ' + b + (note ? '  ' + note : '');
  }
  $('heDirs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]'); if (!btn) return;
    const dir = btn.dataset.dir;
    const line = buildDirective(dir);
    if (!line) { setStatus('faltou preencher: ' + dir + ' precisa de ' + (['NOTE','REORG'].includes(dir) ? 'FROM' : 'FROM e TO') + ' (clique nos nós)', true); return; }
    appendHumanLine(line);
    setStatus('adicionado no fim: ' + line.trim());
    $('heNote').value = '';
  });

  // ---------------------------------------------------------------- render
  // Mermaid appends an error <svg> ("Syntax error in text" bomb) to document.body when render()
  // throws, and also leaves behind its temporary render container. Sweep both so a bad keystroke
  // never litters the page.
  function sweepMermaidLeftovers(){
    document.querySelectorAll('body > svg[id^="m"], body > div[id^="dm"], body > #dm, body > .mermaidTooltip').forEach(el => {
      if (!canvas.contains(el)) el.remove();
    });
  }

  // ---------------------------------------------------------------- compact layout (render-time only)
  // The .mmd sources are kept clean (long one-line labels, no layout hacks) so Bruno can edit them.
  // At render time we (1) wrap long labels with <br/> so nodes are ~narrow columns and (2) chain
  // sibling nodes inside each subgraph with invisible links (~~~) in columns of N, so Dagre stacks
  // them instead of laying every subgraph out as one giant row. Measured with real Mermaid: master
  // 25070x2641 (9.5:1) -> ~18400x5200 (3.5:1); drill-downs 33:1 -> 1.6..3.1:1. Toggle: #compact.
  const WRAP_AT = 34, CHAIN_COLS = 6;
  function wrapLabels(src, width){
    return src.replace(/\\["([^"\\]]*)"\\]/g, (m, label) => {
      if (label.length <= width || label.includes('<br')) return m;
      const words = label.split(' '); const lines = []; let curL = '';
      for (const w of words) { if ((curL + ' ' + w).trim().length > width && curL) { lines.push(curL); curL = w; } else curL = (curL + ' ' + w).trim(); }
      if (curL) lines.push(curL);
      return '["' + lines.join('<br/>') + '"]';
    });
  }
  function chainify(src, cols){
    const lines = src.split('\\n'); const outL = []; const stack = [];
    for (const ln of lines) {
      const t = ln.trim();
      if (/^subgraph\\s/.test(t)) { stack.push({ ids: [] }); outL.push(ln); continue; }
      if (t === 'end' && stack.length) {
        const ids = stack.pop().ids;
        if (ids.length > cols) {
          const ncol = Math.ceil(ids.length / cols);
          for (let c = 0; c < ncol; c++) { const col = ids.filter((_, i) => Math.floor(i / cols) === c); if (col.length > 1) outL.push('  ' + col.join(' ~~~ ')); }
        }
        outL.push(ln); continue;
      }
      const m = t.match(/^([A-Za-z0-9_]+)\\["/); if (m && stack.length) stack[stack.length - 1].ids.push(m[1]);
      outL.push(ln);
    }
    return outL.join('\\n');
  }
  function layoutHint(code){ const c = document.getElementById('compact'); return (c && !c.checked) ? code : chainify(wrapLabels(code, WRAP_AT), CHAIN_COLS); }

  async function render(){
    if (!cur) return;
    const code = ta.value;
    const rid = 'm' + Date.now();
    try {
      const { svg } = await mermaid.render(rid, layoutHint(code));
      out.innerHTML = svg;
      sweepMermaidLeftovers();
      setStatus('rendered ✓  ' + cur.title + '  (' + code.split('\\n').length + ' lines, ' + out.querySelectorAll('g.node').length + ' nodes)');
      allNodes().forEach(g => {
        g.style.cursor = 'pointer';
        g.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const id = nodeId(g), label = nodeLabel(g);
          if (navigator.clipboard && navigator.clipboard.writeText) { try { navigator.clipboard.writeText(id); } catch (_) {} }
          pickNode(id, label);
          setStatus('copied node id: ' + id + '  ·  ' + label.slice(0, 120));
        });
      });
      computeMatches(); applyDecor();
    } catch (e) {
      // never blank the page: keep the last good SVG, shout in red, remove Mermaid's error bomb
      sweepMermaidLeftovers();
      setStatus('Mermaid error: ' + (e && e.message ? e.message : e), true);
    }
  }
  function schedule(){ if (!$('autoRender').checked) return; clearTimeout(timer); timer = setTimeout(render, 500); }

  // ---------------------------------------------------------------- tabs / load
  function load(m){
    cur = m; ta.value = localStorage.getItem(LS(m.key)) || m.generated;
    [...tabs.children].forEach(b => b.classList.toggle('active', b.dataset.key === m.key));
    scale = 1; tx = 20; ty = 20; apply();
    selId = null; nextSlot = 'from'; setSlotUI();
    $('heFrom').value = ''; $('heTo').value = '';
    $('selInfo').innerHTML = 'Selecionado: <b>—</b> · clique num nó: 1º = FROM, 2º = TO';
    render();
  }
  maps.forEach(m => { const b = document.createElement('button'); b.className = 'tab'; b.textContent = m.title; b.dataset.key = m.key; b.onclick = () => load(m); tabs.appendChild(b); });

  ta.addEventListener('input', () => { localStorage.setItem(LS(cur.key), ta.value); schedule(); });
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey||e.metaKey) && e.key === 'Enter') render(); });
  $('btnRender').onclick = render;
  $('compact').addEventListener('change', render);
  $('btnCopy').onclick = () => navigator.clipboard.writeText(ta.value).then(() => setStatus('copied source to clipboard'));
  $('btnDownload').onclick = () => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([ta.value], {type:'text/plain'}));
    a.href = url; a.download = cur.file.split('/').pop();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setStatus('downloaded ' + a.download + ' — overwrite docs/architecture/' + cur.file);
  };
  $('btnReset').onclick = () => { if (confirm('Discard your browser draft for ' + cur.title + '?')) { localStorage.removeItem(LS(cur.key)); ta.value = cur.generated; render(); } };
  $('insert').onchange = (e) => { const v = e.target.value; if (!v) return; const s = ta.selectionStart; ta.value = ta.value.slice(0,s) + '\\n' + v + '\\n' + ta.value.slice(s); ta.selectionStart = ta.selectionEnd = s + v.length + 2; localStorage.setItem(LS(cur.key), ta.value); e.target.value=''; schedule(); };

  // ---------------------------------------------------------------- pan / zoom
  let drag = null;
  stage.addEventListener('mousedown', (e) => { if (e.target.closest('.zoombar')) return; drag = { x: e.clientX - tx, y: e.clientY - ty, moved:false }; });
  window.addEventListener('mousemove', (e) => { if (!drag) return; drag.moved = true; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); });
  window.addEventListener('mouseup', () => drag = null);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const f = e.deltaY < 0 ? 1.1 : 0.9; const r = stage.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; scale *= f; apply(); }, { passive:false });
  $('zin').onclick = () => { scale *= 1.2; apply(); };
  $('zout').onclick = () => { scale /= 1.2; apply(); };
  // Several drill-downs lay out as one very wide row (S02 is ~20000x600, a 33:1 strip). Fitting
  // such a diagram to the stage WIDTH shrinks it to an unreadable hairline, so below a minimum
  // legible scale we fit to HEIGHT instead and let Bruno pan sideways.
  // Several drill-downs lay out as one very wide row (S02 is ~20000x600, a 33:1 strip). Fitting
  // such a strip to WIDTH shrinks it to an unreadable hairline; fitting it to HEIGHT blows one
  // node up to fill the screen. So clamp into a band that keeps text legible while still showing
  // a useful span of the diagram, and tell Bruno to pan.
  const MIN_LEGIBLE = 0.22, MAX_WIDE = 0.55;
  function fit(){
    const svg = out.querySelector('svg'); if (!svg) return;
    const r = stage.getBoundingClientRect();
    // Use the intrinsic viewBox (stable) rather than the CSS-scaled bounding box, which is
    // unreliable while mermaid is still laying the diagram out.
    const vb = svg.viewBox && svg.viewBox.baseVal;
    let w = vb && vb.width, h = vb && vb.height;
    if (!w || !h) { const bb = svg.getBoundingClientRect(); w = bb.width/scale; h = bb.height/scale; }
    if (!w || !h) return;
    const byBoth = Math.min((r.width-40)/w, (r.height-40)/h);
    // With the compact layout most maps are screen-shaped (aspect < 4): fit the WHOLE thing,
    // even if small — overview first, then zoom/search. Only fall back to the "wide strip"
    // handling when the diagram is genuinely a strip (aspect >= 4) AND would be illegible.
    const aspect = w / h;
    if (byBoth < MIN_LEGIBLE && aspect >= 4) {
      const byHeight = (r.height-40)/h;
      scale = Math.min(Math.max(byHeight, MIN_LEGIBLE), MAX_WIDE);
      tx = 20; ty = Math.max((r.height - h*scale)/2, 20);
      setStatus('fit: diagrama muito largo (' + Math.round(w) + '×' + Math.round(h) + ' px) — arraste para os lados, ou use a Busca para pular direto num nó');
    } else {
      scale = Math.min(byBoth, 1.5); // no floor: overview must fit the stage
      tx = Math.max((r.width - w*scale)/2, 20); ty = Math.max((r.height - h*scale)/2, 20);
      if (byBoth < MIN_LEGIBLE) setStatus('fit: visão geral (' + Math.round(w) + '×' + Math.round(h) + ' px) — use a roda do mouse pra ampliar ou a Busca pra ir direto num nó');
    }
    apply();
  }
  $('zfit').onclick = fit;

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey||e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); $('search').focus(); $('search').select(); }
  });

  load(maps[0]);
</script>
</body>
</html>
`;
fs.writeFileSync(outPath, html, 'utf8');
console.log('wrote', path.relative(process.cwd(), outPath), '(' + Math.round(html.length / 1024) + ' KB, ' + maps.length + ' maps)');
