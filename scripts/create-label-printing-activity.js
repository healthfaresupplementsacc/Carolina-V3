'use strict';
// Bruno 07-16: atividade "Impressão de Labels" sob Linha de Produção (flow=production)
// pra a User Screen do PC de impressão (.28). Idempotente.
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async()=>{
  const ex=(await p.query(`SELECT id FROM v3.activity_types WHERE slug='label_printing'`)).rows[0];
  if(ex){ console.log('já existe id',ex.id); return; }
  const r=await p.query(
    `INSERT INTO v3.activity_types (slug, display_name, category, flow, emoji, color, is_background, requires_product, requires_order_count, counts_as_pp, active)
     VALUES ('label_printing','Impressão de Labels','production_phase','production','🖨️','#8b5cf6', false, false, false, false, true)
     RETURNING id, slug, display_name, flow`);
  console.log('CRIADA:', JSON.stringify(r.rows[0]));
})().catch(e=>{console.error('ERR',e.message);process.exit(1);}).finally(()=>p.end());
