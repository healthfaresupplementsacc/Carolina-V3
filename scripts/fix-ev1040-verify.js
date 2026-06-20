'use strict';
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = (s,p) => pool.query(s,p).then(r=>r.rows).catch(e=>[{ERRO:e.message}]);
  // fecha o ev1040 preso (encapsulação concluída; Bruno confirmou). Sem contagem (encapsulation não exige).
  const r = await q("UPDATE v3.events SET ended_at=NOW(), closed_reason='admin_stale_cleanup', updated_at=NOW() WHERE id=1040 AND ended_at IS NULL RETURNING id, started_at, ended_at");
  console.log('ev1040 fechado: ' + JSON.stringify(r));
  // confirma: events abertos do Bruno agora
  console.log('abertos Bruno agora: ' + JSON.stringify(await q("SELECT e.id, at.slug, e.source FROM v3.events e JOIN v3.activity_types at ON at.id=e.activity_type_id WHERE e.person_id=7 AND e.ended_at IS NULL AND e.deleted_at IS NULL")));
  await pool.end();
})().catch(e=>{console.error('ERRO',e.message);process.exit(1);});
