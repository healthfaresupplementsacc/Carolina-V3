'use strict';
/**
 * QA harness for docs/architecture/MASTER_SYSTEM_MAP.html
 * Run from project root:  node docs/architecture/_qa/qa-map.js
 * Writes screenshots + qa-report.json into docs/architecture/_qa/.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const QA = __dirname;
const HTML = path.join(QA, '..', 'MASTER_SYSTEM_MAP.html');
// NOTE: do not name this `URL` — that would shadow the global URL constructor.
const PAGE_URL = 'file:///' + HTML.replace(/\\/g, '/');

const results = [];
const rec = (group, name, pass, detail) => {
  results.push({ group, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + '[' + group + '] ' + name + (detail ? '  — ' + detail : ''));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitRendered(page, timeout = 30000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById('status');
      const svg = document.querySelector('#out svg');
      return s && /^rendered/.test(s.textContent) && svg && document.querySelectorAll('#out g.node').length > 0;
    },
    { timeout, polling: 200 }
  );
}

async function tabKeys(page) {
  return page.$$eval('#tabs .tab', (els) => els.map((e) => ({ key: e.dataset.key, title: e.textContent })));
}

async function clickTab(page, key) {
  await page.evaluate((k) => {
    const b = [...document.querySelectorAll('#tabs .tab')].find((x) => x.dataset.key === k);
    b.click();
  }, key);
}

async function statusText(page) {
  return page.$eval('#status', (e) => e.textContent);
}

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('  !! pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  !! console.error: ' + m.text().slice(0, 200)); });

  await page.goto(PAGE_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await waitRendered(page);

  const tabs = await tabKeys(page);
  rec('tabs', 'tab count == 11', tabs.length === 11, 'found ' + tabs.length);

  // ---------------------------------------------------------------- 1. every tab
  const tabStats = [];
  for (const t of tabs) {
    let pass = false, nodes = 0, st = '';
    try {
      await clickTab(page, t.key);
      await waitRendered(page);
      await sleep(400);
      nodes = await page.$$eval('#out g.node', (n) => n.length);
      st = await statusText(page);
      // fit so the screenshot shows the map
      await page.click('#zfit');
      await sleep(300);
      // fit contract (compact layout): the WHOLE diagram must be inside the stage (overview first),
      // OR — for genuine wide strips — the scale must be in the legible band. Either is a pass.
      const fitInfo = await page.evaluate(() => {
        const sc = parseFloat((document.getElementById('canvas').style.transform.match(/scale\(([\d.]+)\)/) || [0, 1])[1]);
        const svg = document.querySelector('#out svg'); const vb = svg && svg.viewBox && svg.viewBox.baseVal;
        const st = document.getElementById('stage').getBoundingClientRect();
        const w = vb ? vb.width : 0, h = vb ? vb.height : 0;
        return { sc, whole: w > 0 && (w * sc) <= st.width && (h * sc) <= st.height, w, h };
      });
      const sc = fitInfo.sc;
      rec('tab-fit', t.key, sc > 0 && (fitInfo.whole || sc >= 0.2), 'fit scale=' + sc.toFixed(3) + (fitInfo.whole ? ' (whole diagram visible, ' + Math.round(fitInfo.w) + 'x' + Math.round(fitInfo.h) + ')' : ' (legible band)'));
      pass = nodes > 20 && /^rendered/.test(st);
    } catch (e) {
      st = 'EXCEPTION ' + e.message;
    }
    const shot = path.join(QA, 'tab-' + String(tabs.indexOf(t) + 1).padStart(2, '0') + '-' + t.key.replace(/[^\w.-]/g, '_') + '.png');
    try { await page.screenshot({ path: shot, type: 'png' }); } catch (e) { /* ignore */ }
    const kb = fs.existsSync(shot) ? Math.round(fs.statSync(shot).size / 1024) : -1;
    const clean = await page.evaluate(() => document.querySelectorAll('body > svg, body > div[id^="dm"]').length === 0);
    tabStats.push({ key: t.key, nodes, pass, kb, shot, status: st.slice(0, 60) });
    rec('tab', t.key, pass && clean, nodes + ' nodes, status="' + st.slice(0, 34) + '", shot ' + kb + 'KB, bodyClean=' + clean);
    if (kb >= 1024) rec('tab-shot-size', t.key, false, kb + 'KB >= 1MB');
  }

  // back to master for behaviour tests
  await clickTab(page, 'MASTER');
  await waitRendered(page);
  await sleep(300);

  // ---------------------------------------------------------------- 2a. live typing + localStorage persistence
  {
    const marker = '\n%% QA-LIVE-MARKER-' + Date.now();
    await page.focus('#src');
    await page.evaluate(() => { const t = document.getElementById('src'); t.selectionStart = t.selectionEnd = t.value.length; });
    // type via real key events so the input listener fires
    await page.type('#src', marker.replace(/\n/g, '\n'), { delay: 1 });
    await sleep(1400);
    const st = await statusText(page);
    const linesGrew = /rendered/.test(st);
    const ls = await page.evaluate(() => localStorage.getItem('hf-map-draft:MASTER'));
    const inLs = !!ls && ls.includes('QA-LIVE-MARKER');
    rec('behaviour', 'a1 live re-render after typing', linesGrew, 'status="' + st.slice(0, 50) + '"');
    rec('behaviour', 'a2 draft written to localStorage', inLs);

    await page.reload({ waitUntil: 'networkidle0' });
    await waitRendered(page);
    const kept = await page.$eval('#src', (e) => e.value.includes('QA-LIVE-MARKER'));
    rec('behaviour', 'a3 draft survives reload', kept);
  }

  // ---------------------------------------------------------------- 2b. reset to generated
  {
    page.once('dialog', async (d) => { await d.accept(); });
    await page.click('#btnReset');
    await sleep(1200);
    const gone = await page.$eval('#src', (e) => !e.value.includes('QA-LIVE-MARKER'));
    const matchesGenerated = await page.evaluate(() => {
      const el = [...document.querySelectorAll('script[data-map]')].find((s) => s.dataset.map === 'MASTER');
      return document.getElementById('src').value === el.textContent.replace(/^\n/, '');
    });
    const lsGone = await page.evaluate(() => localStorage.getItem('hf-map-draft:MASTER') === null);
    rec('behaviour', 'b Reset to generated restores embedded source', gone && matchesGenerated && lsGone,
      'markerGone=' + gone + ' exactMatch=' + matchesGenerated + ' lsCleared=' + lsGone);
  }

  // ---------------------------------------------------------------- 2c. download filename
  {
    const dlDir = path.join(QA, 'downloads');
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    async function testDownload(key, expected) {
      await clickTab(page, key);
      await waitRendered(page);
      await sleep(300);
      await page.click('#btnDownload');
      // wait for the .crdownload to settle into the final name
      let found = null;
      for (let i = 0; i < 80; i++) {
        const fl = fs.readdirSync(dlDir);
        if (fl.includes(expected) && !fl.includes(expected + '.crdownload')) { found = expected; break; }
        await sleep(150);
      }
      const st = await statusText(page);
      rec('behaviour', 'c download filename (' + key + ')', found === expected,
        'expected="' + expected + '" got=' + JSON.stringify(fs.readdirSync(dlDir)) + ' status="' + st.slice(0, 60) + '"');
    }
    await testDownload('MASTER', 'MASTER_SYSTEM_MAP.mmd');
    await testDownload('S08-data', 'S08-data.mmd');
    // clean the drafts these tabs may have created
  }

  // ---------------------------------------------------------------- 2d. + directive menu inserts at cursor
  {
    await clickTab(page, 'MASTER');
    await waitRendered(page);
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload({ waitUntil: 'networkidle0' });
    await waitRendered(page);
    const before = await page.$eval('#src', (e) => e.value);
    const pos = 120;
    await page.evaluate((p) => { const t = document.getElementById('src'); t.focus(); t.selectionStart = t.selectionEnd = p; }, pos);
    await page.select('#insert', '%% CONNECT    FROM_ID --> TO_ID   note');
    await sleep(900);
    const after = await page.$eval('#src', (e) => e.value);
    const inserted = after.includes('%% CONNECT    FROM_ID --> TO_ID   note');
    const atCursor = after.slice(0, pos) === before.slice(0, pos) && after.slice(pos, pos + 60).includes('%% CONNECT');
    rec('behaviour', 'd "+ directive" inserts template at cursor', inserted && atCursor, 'inserted=' + inserted + ' atCursor=' + atCursor);
    // restore clean source
    page.once('dialog', async (d) => { await d.accept(); });
    await page.click('#btnReset');
    await sleep(1000);
  }

  // ---------------------------------------------------------------- 2e. pan / zoom / fit
  {
    const tf = () => page.$eval('#canvas', (e) => e.style.transform);
    const t0 = await tf();
    await page.mouse.move(1100, 500);
    await page.mouse.down();
    await page.mouse.move(1180, 560, { steps: 6 });
    await page.mouse.up();
    const t1 = await tf();
    rec('behaviour', 'e1 drag pans (transform changes)', t1 !== t0, t0 + ' -> ' + t1);

    await page.mouse.move(1100, 500);
    await page.mouse.wheel({ deltaY: -300 });
    await sleep(200);
    const t2 = await tf();
    const s2 = await page.evaluate(() => parseFloat((document.getElementById('canvas').style.transform.match(/scale\(([\d.]+)\)/) || [0, 1])[1]));
    rec('behaviour', 'e2 wheel zooms (scale changes)', t2 !== t1, 'scale=' + s2);

    await page.click('#zfit');
    await sleep(250);
    const t3 = await tf();
    const fitInfo = await page.evaluate(() => {
      const svg = document.querySelector('#out svg'); const st = document.getElementById('stage').getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      const sc = parseFloat((document.getElementById('canvas').style.transform.match(/scale\(([\d.]+)\)/) || [0, 1])[1]);
      return { fits: r.width <= st.width + 60 && r.height <= st.height + 60, sc,
               fillW: r.width / st.width, fillH: r.height / st.height };
    });
    // fit must leave the diagram READABLE: either it fits entirely, or (for very wide maps) it
    // fills the stage height at a legible zoom and is pannable sideways.
    rec('behaviour', 'e3 fit changes the transform', t3 !== t2, t3);
    const readable = fitInfo.sc >= 0.2 || (fitInfo.fits && Math.max(fitInfo.fillW, fitInfo.fillH) > 0.6);
    rec('behaviour', 'e4 fit is not degenerate (stays legible)', readable,
      'scale=' + fitInfo.sc + ' fillW=' + fitInfo.fillW.toFixed(2) + ' fillH=' + fitInfo.fillH.toFixed(2));
  }

  // ---------------------------------------------------------------- 2f. node click -> id in status
  {
    const info = await page.evaluate(() => {
      const g = [...document.querySelectorAll('#out g.node')][3];
      const id = (g.id || '').replace(/^flowchart-/, '').replace(/-\d+$/, '');
      g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { id, status: document.getElementById('status').textContent, sel: document.getElementById('selInfo').textContent };
    });
    rec('behaviour', 'f click node shows id in #status', info.status.includes('copied node id: ' + info.id), 'id=' + info.id + ' status="' + info.status.slice(0, 70) + '"');
    rec('feature', 'd2 selected-node info line shows label', info.sel.includes(info.id) && info.sel.length > ('Selecionado: ' + info.id).length + 3, 'selInfo="' + info.sel.slice(0, 80) + '"');
  }

  // ---------------------------------------------------------------- 2g. syntax error -> red status, page not blanked
  {
    const nodesBefore = await page.$$eval('#out g.node', (n) => n.length);
    await page.evaluate(() => {
      const t = document.getElementById('src');
      t.value = 'flowchart TB\n  A[Broken --> B[[[[\n  %%%%';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(1600);
    const st = await statusText(page);
    const cls = await page.$eval('#status', (e) => e.className);
    const color = await page.$eval('#status', (e) => getComputedStyle(e).color);
    const nodesAfter = await page.$$eval('#out g.node', (n) => n.length);
    rec('behaviour', 'g syntax error -> red error in #status, svg kept',
      /error/i.test(st) && cls === 'err' && nodesAfter === nodesBefore,
      'status="' + st.slice(0, 60) + '" class=' + cls + ' color=' + color + ' nodes ' + nodesBefore + '->' + nodesAfter);

    // mermaid must not litter the body with its "Syntax error in text" bomb svg
    const litter = await page.evaluate(() => {
      const stray = [...document.querySelectorAll('body > svg, body > div[id^="dm"], body > .mermaidTooltip')];
      return { n: stray.length, txt: document.body.innerText.includes('Syntax error in text'), scrollH: document.body.scrollHeight, innerH: window.innerHeight };
    });
    rec('behaviour', 'g2 no stray mermaid error graphic appended to body',
      litter.n === 0 && !litter.txt, 'strayNodes=' + litter.n + ' bombText=' + litter.txt);
    rec('behaviour', 'g3 page does not grow past viewport after error',
      litter.scrollH <= litter.innerH + 4, 'scrollHeight=' + litter.scrollH + ' viewport=' + litter.innerH);
    await page.screenshot({ path: path.join(QA, 'behaviour-g-error.png'), type: 'png' });

    // restore
    page.once('dialog', async (d) => { await d.accept(); });
    await page.click('#btnReset');
    await waitRendered(page);
    await sleep(400);
  }

  // ---------------------------------------------------------------- 3a. ID search
  {
    await page.click('#search', { clickCount: 3 });
    await page.type('#search', 'S02_08', { delay: 8 });
    await sleep(700);
    const r = await page.evaluate(() => {
      const hits = [...document.querySelectorAll('#out g.node.hf-hit')];
      const w = hits.length ? getComputedStyle(hits[0].querySelector('rect,polygon,path,circle,ellipse')).strokeWidth : '0';
      return { n: hits.length, ids: hits.map((g) => (g.id || '').replace(/^flowchart-/, '').replace(/-\d+$/, '')), sw: w, count: document.getElementById('searchCount').textContent, tf: document.getElementById('canvas').style.transform };
    });
    rec('feature', 'a1 search highlights matching nodes (thick outline)', r.n > 0 && parseFloat(r.sw) >= 4, r.n + ' hits ' + JSON.stringify(r.ids.slice(0, 5)) + ' strokeWidth=' + r.sw);
    // pan to first match => node near stage centre
    const centred = await page.evaluate(() => {
      const g = document.querySelector('#out g.node.hf-hit'); if (!g) return null;
      const gr = g.getBoundingClientRect(), st = document.getElementById('stage').getBoundingClientRect();
      return { dx: Math.abs((gr.left + gr.width / 2) - (st.left + st.width / 2)), dy: Math.abs((gr.top + gr.height / 2) - (st.top + st.height / 2)) };
    });
    rec('feature', 'a2 search pans to first match', centred && centred.dx < 60 && centred.dy < 60, JSON.stringify(centred));
    rec('feature', 'a3 search counter shows n/total', /^\d+\/\d+$/.test(r.count), r.count);
    await page.screenshot({ path: path.join(QA, 'feature-a-search.png'), type: 'png' });

    // text search too (label match, not just id)
    await page.click('#search', { clickCount: 3 });
    await page.type('#search', 'Veeqo', { delay: 8 });
    await sleep(700);
    const n2 = await page.$$eval('#out g.node.hf-hit', (n) => n.length);
    rec('feature', 'a4 search matches label text ("Veeqo")', n2 > 0, n2 + ' hits');
    // next-match button cycles
    const idxBefore = await page.$eval('#searchCount', (e) => e.textContent);
    await page.click('#searchNext');
    await sleep(300);
    const idxAfter = await page.$eval('#searchCount', (e) => e.textContent);
    rec('feature', 'a5 next-match button cycles', idxBefore !== idxAfter, idxBefore + ' -> ' + idxAfter);
    await page.click('#searchClear');
    await sleep(300);
    const cleared = await page.$$eval('#out g.node.hf-hit', (n) => n.length);
    rec('feature', 'a6 clear removes highlights', cleared === 0, cleared + ' hits left');
  }

  // ---------------------------------------------------------------- 3b. class filter
  {
    const base = await page.$$eval('#out g.node.hf-dim', (n) => n.length);
    await page.evaluate(() => {
      const cb = document.querySelector('input[data-cls="verified"]');
      cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(350);
    const r = await page.evaluate(() => {
      const dim = [...document.querySelectorAll('#out g.node.hf-dim')];
      const anyVerifiedDim = dim.some((g) => g.classList.contains('verified'));
      const anyExternalDim = dim.some((g) => g.classList.contains('external'));
      const op = dim.length ? parseFloat(getComputedStyle(dim[0]).opacity) : 1;
      return { dim: dim.length, anyVerifiedDim, anyExternalDim, op };
    });
    rec('feature', 'b1 unchecking "verified" dims verified nodes', base === 0 && r.dim > 0 && r.anyVerifiedDim && r.op < 0.5,
      'dimmed=' + r.dim + ' opacity=' + r.op + ' verifiedDimmed=' + r.anyVerifiedDim);
    rec('feature', 'b2 other classes stay bright', !r.anyExternalDim, 'externalDimmed=' + r.anyExternalDim);
    await page.screenshot({ path: path.join(QA, 'feature-b-filter.png'), type: 'png' });
    await page.click('#filterAll');
    await sleep(300);
    const after = await page.$$eval('#out g.node.hf-dim', (n) => n.length);
    rec('feature', 'b3 "all" button restores everything', after === 0, after + ' still dimmed');
  }

  // ---------------------------------------------------------------- 3c. human-edit quick panel
  {
    // reset the FROM/TO sequence first (earlier tests clicked nodes and consumed a slot)
    await page.click('#heClear');
    await sleep(200);
    // two clicks in sequence fill FROM then TO
    const ids = await page.evaluate(() => {
      const gs = [...document.querySelectorAll('#out g.node')];
      const id = (g) => (g.id || '').replace(/^flowchart-/, '').replace(/-\d+$/, '');
      gs[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const from = document.getElementById('heFrom').value;
      gs[5].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const to = document.getElementById('heTo').value;
      return { from, to, expFrom: id(gs[2]), expTo: id(gs[5]) };
    });
    rec('feature', 'c1 1st click=FROM, 2nd click=TO', ids.from === ids.expFrom && ids.to === ids.expTo, JSON.stringify(ids));

    // append each directive and check formatting + placement below HUMAN EDITS marker
    const dirs = ['CONNECT', 'DISCONNECT', 'MOVE', 'SAME', 'FEEDS', 'WRONG', 'NOTE', 'REORG'];
    const lines = [];
    for (const d of dirs) {
      await page.evaluate(() => { document.getElementById('heNote').value = 'qa test note'; });
      await page.click('button[data-dir="' + d + '"]');
      await sleep(160);
      const v = await page.$eval('#src', (e) => e.value);
      const last = v.replace(/\s+$/, '').split('\n').pop();
      const markIdx = v.indexOf('%% ==== HUMAN EDITS BELOW');
      const lastIdx = v.lastIndexOf(last);
      const below = markIdx !== -1 && lastIdx > markIdx;
      let shape;
      if (d === 'MOVE') shape = new RegExp('^%% MOVE\\s+' + ids.from + ' UNDER ' + ids.to + '\\s+qa test note$');
      else if (d === 'SAME') shape = new RegExp('^%% SAME\\s+' + ids.from + ' == ' + ids.to + '\\s+qa test note$');
      else if (d === 'NOTE' || d === 'REORG') shape = new RegExp('^%% ' + d + '\\s+' + ids.from + '\\s+qa test note$');
      else shape = new RegExp('^%% ' + d + '\\s+' + ids.from + ' --> ' + ids.to + '\\s+qa test note$');
      const ok = shape.test(last) && below;
      lines.push(last);
      rec('feature', 'c2.' + d + ' appended below HUMAN EDITS, well formed', ok, JSON.stringify(last) + ' below=' + below);
    }
    // still renders after all those directive comment lines
    await sleep(1300);
    const st = await statusText(page);
    const nodes = await page.$$eval('#out g.node', (n) => n.length);
    rec('feature', 'c3 map still renders with directives appended', /^rendered/.test(st) && nodes > 20, st.slice(0, 50) + ' nodes=' + nodes);
    await page.screenshot({ path: path.join(QA, 'feature-c-human-edits.png'), type: 'png' });

    // missing FROM/TO -> red warning, nothing appended
    await page.evaluate(() => { document.getElementById('heFrom').value = ''; document.getElementById('heTo').value = ''; });
    const lenBefore = await page.$eval('#src', (e) => e.value.length);
    await page.click('button[data-dir="CONNECT"]');
    await sleep(250);
    const lenAfter = await page.$eval('#src', (e) => e.value.length);
    const cls = await page.$eval('#status', (e) => e.className);
    rec('feature', 'c4 missing ids -> red warning, no append', lenBefore === lenAfter && cls === 'err', 'len ' + lenBefore + '->' + lenAfter + ' cls=' + cls);

    // works on a drill-down map that has NO human-edits marker -> creates the section
    await page.evaluate(() => localStorage.clear());
    await clickTab(page, 'S04-workers');
    await waitRendered(page);
    await sleep(300);
    const hasMark = await page.$eval('#src', (e) => e.value.includes('%% ==== HUMAN EDITS BELOW'));
    await page.evaluate(() => {
      const gs = [...document.querySelectorAll('#out g.node')];
      gs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      gs[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.getElementById('heNote').value = 'sem marcador';
    });
    await page.click('button[data-dir="FEEDS"]');
    await sleep(300);
    const v = await page.$eval('#src', (e) => e.value);
    const created = v.includes('%% ==== HUMAN EDITS BELOW') && v.indexOf('%% FEEDS') > v.indexOf('%% ==== HUMAN EDITS BELOW');
    rec('feature', 'c5 map without HUMAN EDITS marker -> section created', created, 'markerExistedBefore=' + hasMark);
    await sleep(1300);
    const st2 = await statusText(page);
    rec('feature', 'c6 drill-down still renders after append', /^rendered/.test(st2), st2.slice(0, 50));
  }

  // ---------------------------------------------------------------- 3e. self-contained (only jsDelivr external)
  {
    const reqs = [];
    page.on('request', (r) => reqs.push(r.url()));
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });
    await waitRendered(page);
    const external = reqs.filter((u) => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
    const hosts = [...new Set(external.map((u) => { try { return new URL(u).host; } catch (e) { return 'UNPARSEABLE:' + u; } }))];
    const badHosts = hosts.filter((h) => h !== 'cdn.jsdelivr.net');
    rec('feature', 'e only external host is cdn.jsdelivr.net', badHosts.length === 0,
      external.length + ' external reqs, hosts=' + JSON.stringify(hosts) + (badHosts.length ? ' BAD=' + JSON.stringify(badHosts) : ''));
  }
  {
    const src = fs.readFileSync(HTML, 'utf8');
    const hasFallback = /import\('\.\/mermaid\.min\.mjs'\)/.test(src);
    const noExtCss = !/<link[^>]+stylesheet/i.test(src);
    const noExtScriptSrc = !/<script[^>]+src=/i.test(src);
    rec('feature', 'e2 local ./mermaid.min.mjs fallback kept', hasFallback);
    rec('feature', 'e3 no external <link>/<script src>', noExtCss && noExtScriptSrc, 'css=' + noExtCss + ' script=' + noExtScriptSrc);
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  fs.writeFileSync(path.join(QA, 'qa-report.json'), JSON.stringify({ when: new Date().toISOString(), tabStats, results }, null, 2));
  console.log('\n================ ' + (results.length - failed.length) + '/' + results.length + ' passed ================');
  if (failed.length) { console.log('FAILURES:'); failed.forEach((f) => console.log('  - [' + f.group + '] ' + f.name + ' :: ' + f.detail)); }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('QA CRASH', e); process.exit(2); });
