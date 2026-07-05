'use strict';
// Verificação AO VIVO do alert-gate contra o DB de produção (round-trip, sem deixar rastro).
const { Pool } = require('pg');
const g = require('../src/v3/alert-gate');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const present = await g.anyonePresent(pool);
  console.log('anyonePresent() =', present, '(hoje é domingo → esperado false se ninguém logado)');

  const before = await g.isMuted(pool);
  console.log('isMuted() antes =', before);

  const until = Date.now() + 60 * 60 * 1000;
  await g.setMute(pool, { untilMs: until, reason: 'verify round-trip', by: 'system-check' });
  const during = await g.isMuted(pool);
  const m = await g.getMute(pool);
  console.log('após setMute(+1h): isMuted =', during, '· until =', m && m.until);

  await g.clearMute(pool);
  const after = await g.isMuted(pool);
  console.log('após clearMute: isMuted =', after);

  const ok = present !== undefined && during === true && after === false;
  console.log(ok ? '\n✅ alert-gate OK ao vivo (presença + mute round-trip + clear).' : '\n❌ algo falhou.');
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
