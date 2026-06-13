'use strict';
/* Diagnóstico do snapshot via HTTP — usa o token do env (Railway run), nunca
   imprime. Replica exatamente o que o cliente externo (claude.ai, FloorDisplay)
   recebe. Read-only. */
const https = require('https');

const HOST = 'productionlineservice-production.up.railway.app';

function get(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: HOST, path, headers: { 'cache-control': 'no-cache' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, raw: body }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const token = process.env.V3_SNAPSHOT_TOKEN;
  if (!token) { console.error('V3_SNAPSHOT_TOKEN ausente no env'); process.exit(1); }
  console.log('Testes contra https://' + HOST + '/api/v3/data/snapshot');
  console.log('(token usado do env — nunca impresso)\n');

  for (const d of ['2026-05-26', '2026-05-25', null /* sem date param */]) {
    const path = '/api/v3/data/snapshot?token=' + encodeURIComponent(token) + (d ? '&date=' + d : '');
    const t0 = Date.now();
    const r = await get(path);
    const ms = Date.now() - t0;
    const j = r.json || {};
    const meta = j.meta || {};
    const data = j.data || {};
    const tl = data.timeline || {};
    console.log(`q=date=${JSON.stringify(d)}  http=${r.status}  ${ms}ms`);
    console.log('  meta.date           :', meta.date);
    console.log('  meta.generated_at   :', meta.generated_at);
    console.log('  data.date           :', data.date);
    console.log('  data.timeline.date  :', tl.date);
    console.log('  timeline.people.len :', (tl.people || []).length);
    console.log('  worker_health       :', data.worker_health);
    console.log('');
  }
}

main().then(() => process.exit(0), (e) => { console.error('ERR:', e.message); process.exit(1); });
