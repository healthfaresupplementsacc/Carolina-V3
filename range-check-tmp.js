'use strict';
const { veeqo } = require('./src/v3/services/veeqo-api');
(async () => {
  let total = 0, oldest = null, newest = null, pages = 0;
  for (let page = 1; page <= 120; page++) {
    let batch;
    try { batch = await veeqo.getOrdersPage({ page, status: 'shipped', per_page: 100 }); }
    catch (e) { console.log('err p', page, e.message); break; }
    if (!batch || !batch.length) break;
    pages++;
    total += batch.length;
    for (const o of batch) {
      const s = o.shipped_at || o.completed_at || o.updated_at;
      if (!s) continue;
      const d = new Date(s);
      if (!oldest || d < oldest) oldest = d;
      if (!newest || d > newest) newest = d;
    }
    if (batch.length < 100) { console.log('last page', page, 'size', batch.length); break; }
    if (page % 10 === 0) console.log('...page', page, 'oldest so far', oldest && oldest.toISOString().slice(0,10));
  }
  console.log('\nPAGES:', pages, 'TOTAL:', total);
  console.log('shipped_at oldest:', oldest && oldest.toISOString());
  console.log('shipped_at newest:', newest && newest.toISOString());
  // does it reach 2026-07-26?
  console.log('reaches Jul 26?', oldest && oldest <= new Date('2026-07-26T00:00:00Z'));
  process.exit(0);
})();
