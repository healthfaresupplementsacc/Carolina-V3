'use strict';
/**
 * AUDITORIA passo 2: bate em TODOS os GETs de leitura AO VIVO.
 * Rota existir não basta — handler pode quebrar em runtime (500) ou devolver
 * shape vazio. Uso: node scripts/audit-live-smoke.js
 */
const BASE = 'https://productionlineservice-production.up.railway.app';
const PIN = process.env.ADMIN_PIN || '510510';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const V3_GETS = [
  '/timeline?date=' + today, '/person/6/timeline?date=' + today,
  '/counts?date=' + today, '/batches', '/batches/104', '/messages?date=' + today,
  '/uncertain-cases', '/metrics?date=' + today, '/health', '/vocabulary', '/flows',
  '/catalog/persons', '/catalog/products', '/catalog/activity-types',
  '/person/6/history', '/product/70/history', '/goals?date=' + today,
  '/production?date=' + today, '/pp?date=' + today, '/support?date=' + today,
  '/fnsku?date=' + today, '/review-rate?range=30d', '/deadlines',
  '/sender-profiles', '/sent-history',
  '/search?q=urolithin', '/history/batch/104', '/history/product-family/70',
];
const PAGES = ['/op/', '/dashboard-v4/', '/cameras', '/admin/', '/api/health'];

(async () => {
  let bad = 0;
  console.log('── /api/v3/data (PIN) ──');
  for (const p of V3_GETS) {
    const url = BASE + '/api/v3/data' + p + (p.includes('?') ? '&' : '?') + 'pin=' + PIN;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      let note = '';
      if (r.status === 200) {
        const j = await r.json().catch(() => null);
        if (!j || j.data === undefined) note = ' ⚠️ sem envelope data';
      }
      const ok = r.status === 200;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗ ' + r.status} ${p}${note}`);
    } catch (e) { bad++; console.log(`  ✗ ERR ${p} — ${e.message}`); }
  }
  console.log('── páginas ──');
  for (const p of PAGES) {
    try {
      const r = await fetch(BASE + p, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
      const ok = r.status === 200 || r.status === 302;
      if (!ok) bad++;
      console.log(`  ${ok ? '✓' : '✗ ' + r.status} ${p}`);
    } catch (e) { bad++; console.log(`  ✗ ERR ${p} — ${e.message}`); }
  }
  console.log(bad === 0 ? '\n✅ TUDO 200.' : `\n❌ ${bad} endpoint(s) com problema.`);
})();
