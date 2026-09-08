'use strict';
/* TROCA A FOTO DE PERFIL DA CAROL NO SLACK (Bruno 09-08: toda sexta 10am,
 * com a imagem nova que ele poe na pasta do Drive).
 *
 * Como funciona (o jeito simples, que o Bruno apontou): entrega o ARQUIVO a um
 * input[type=file] pelo CDP (DOM.setFileInputFiles) e chama users.setPhoto de
 * dentro da propria pagina, com o token da sessao web dela. Sem base64.
 *
 * Regra do Bruno: SEMPRE a imagem MAIS RECENTE da pasta (mtime manda, sem
 * filtro de nome).
 *
 * Uso:  node set-carol-photo.js [arquivo]
 * Estado: _watch/photo-state.json (nao repete a mesma imagem).
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '_watch');
const STATE = path.join(DIR, 'photo-state.json');
const FOLDER = process.env.CAROL_PHOTO_DIR || 'G:/My Drive/Clinic/Work From Home/Carol';
const TEAM = process.env.SLACK_TEAM || 'T020AHKP5D5';
const OK_EXT = /\.(png|jpe?g|webp)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickNewest() {
  const arg = process.argv[2];
  if (arg) return path.isAbsolute(arg) ? arg : path.join(FOLDER, arg);
  let files;
  try { files = fs.readdirSync(FOLDER); } catch (_) { throw new Error('pasta nao acessivel: ' + FOLDER); }
  const cands = files
    .filter((f) => OK_EXT.test(f))
    .map((f) => ({ p: path.join(FOLDER, f), m: fs.statSync(path.join(FOLDER, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);              // mais recente primeiro (regra do Bruno)
  if (!cands.length) throw new Error('nenhuma imagem em ' + FOLDER);
  return cands[0].p;
}

(async () => {
  const file = pickNewest().split(String.fromCharCode(92)).join('/');
  const st = fs.statSync(file);
  console.log('IMAGEM: ' + file + ' (' + Math.round(st.size / 1024) + 'KB, ' + new Date(st.mtimeMs).toISOString() + ')');
  const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return {}; } })();
  if (state.lastFile === file && state.lastMtime === st.mtimeMs) { console.log('JA APLICADA, nada a fazer'); return; }
  if (st.size > 5 * 1024 * 1024) throw new Error('imagem acima de 5MB, o Slack recusa');

  const list = await (await fetch('http://localhost:9222/json/list')).json();
  const tab = list.filter((x) => x.type === 'page').find((x) => /app\.slack\.com/.test(x.url || ''));
  if (!tab) throw new Error('sem aba do Slack no Chrome da Carol');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('ws timeout')), 15000); ws.onopen = () => { clearTimeout(to); res(); }; ws.onerror = () => { clearTimeout(to); rej(new Error('ws erro')); }; });
  let idc = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const raw = (mth, p = {}, tmo) => new Promise((r, rej) => { const id = ++idc; const to = setTimeout(() => { pend.delete(id); rej(new Error('cdp timeout ' + mth)); }, tmo || 30000); pend.set(id, (v) => { clearTimeout(to); r(v); }); ws.send(JSON.stringify({ id, method: mth, params: p })); });
  const ev = async (x, awaitP, tmo) => { const r = await raw('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: !!awaitP }, tmo); const res = r && r.result ? r.result : null; if (res && res.exceptionDetails) throw new Error('js: ' + JSON.stringify(res.exceptionDetails.exception || {}).slice(0, 200)); return res && res.result ? res.result.value : undefined; };

  try {
    await raw('Runtime.enable'); await raw('DOM.enable');
    await ev("(function(){var i=document.getElementById('__carolPic');if(!i){i=document.createElement('input');i.type='file';i.id='__carolPic';i.style.display='none';document.body.appendChild(i);}return true})()");
    const doc = await raw('DOM.getDocument', {});
    const node = await raw('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#__carolPic' });
    const set = await raw('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [file] });
    if (set.error) throw new Error('setFileInputFiles: ' + JSON.stringify(set.error));
    const loaded = await ev("(function(){var i=document.getElementById('__carolPic');return i.files.length?i.files[0].size:0})()");
    if (!loaded) throw new Error('arquivo nao entrou no input (0 bytes)');

    // upload direto: awaitPromise segura ate o Slack responder (leva ~1s)
    const out = await ev(`(async function(){
      var f=document.getElementById('__carolPic').files[0];
      var cfg=JSON.parse(localStorage.getItem('localConfig_v2'));
      var team=cfg.teams[${JSON.stringify(TEAM)}];
      if(!team||!team.token) return JSON.stringify({ok:false,error:'sem token da sessao'});
      var fd=new FormData();
      fd.append('token',team.token);
      fd.append('image',f,f.name);
      var r=await fetch('/api/users.setPhoto',{method:'POST',body:fd});
      var j=await r.json();
      return JSON.stringify({ok:j.ok,error:j.error||null});
    })()`, true, 240000);
    await ev("(function(){var i=document.getElementById('__carolPic');if(i)i.remove();return true})()");
    let j; try { j = JSON.parse(out); } catch (_) { throw new Error('resposta inesperada: ' + out); }
    if (!j.ok) throw new Error('slack recusou: ' + (j.error || '?'));
    fs.writeFileSync(STATE, JSON.stringify({ lastFile: file, lastMtime: st.mtimeMs, appliedAt: new Date().toISOString() }, null, 1));
    console.log('FOTO TROCADA OK');
  } finally { try { ws.close(); } catch (_) {} }
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
