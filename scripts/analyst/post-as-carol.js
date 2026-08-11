'use strict';
/**
 * POST-AS-CAROL — posta no Slack pela sessão logada no Chrome (porta debug 9222),
 * ou seja, COMO a conta que está logada ali (Carol). Bruno/Carol 07-29.
 *
 * Uso:  node scripts/analyst/post-as-carol.js "<texto>"
 * Requer: um Chrome aberto com --remote-debugging-port=9222 e o Slack logado.
 *
 * Digita no composer do canal aberto e envia (Enter). Não usa token nem API —
 * usa a própria sessão do navegador (a mensagem sai com o nome de quem está logado).
 */
const WebSocket = require('ws');
const MSG = process.argv[2];

(async () => {
  if (!MSG) { console.log('uso: node post-as-carol.js "<texto>"'); process.exit(1); }
  let tabs;
  try { tabs = await (await fetch('http://localhost:9222/json')).json(); }
  catch (e) { console.log('NO_DEBUG_PORT: Chrome com --remote-debugging-port=9222 não encontrado (' + e.message + ')'); process.exit(2); }
  const page = tabs.find((t) => t.type === 'page' && /slack\.com\/client/.test(t.url || ''));
  if (!page) { console.log('NO_SLACK_TAB: nenhuma aba do Slack aberta no Chrome de debug'); process.exit(3); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const cmd = (m, p = {}) => new Promise((r) => { const i = ++id; const h = (d) => { const j = JSON.parse(d); if (j.id === i) { ws.off('message', h); r(j.result); } }; ws.on('message', h); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise((r) => ws.on('open', r));
  await cmd('Runtime.enable');

  const js = '(function(){var b=document.querySelector(\'[data-qa=message_input] [contenteditable=true]\')||document.querySelector(\'.ql-editor[contenteditable=true]\');if(!b)return "NO_BOX";b.focus();var ok=document.execCommand("insertText",false,' + JSON.stringify(MSG) + ');return ok?"TYPED":"FAIL_TYPE";})()';
  const r = await cmd('Runtime.evaluate', { expression: js, returnByValue: true });
  const typed = r && r.result && r.result.value;
  console.log('digitou:', typed);
  if (typed === 'TYPED') {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await new Promise((r) => setTimeout(r, 500));
    console.log('ENVIADO ✓');
  }
  ws.close();
})().catch((e) => { console.log('erro:', e.message); process.exit(1); });
