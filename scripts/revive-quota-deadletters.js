'use strict';
// Ressuscita mensagens dead-lettered por FALTA DE COTA (429/quota) nas últimas 48h.
// Com a chave 2 ativa, o Observer as processa em segundos. Só as de cota — dead-letters
// por erro real de conteúdo ficam mortas (design).
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await p.query(
    `UPDATE v3.messages
        SET dead_lettered_at = NULL, processing_attempts = 0, processing_error = NULL, last_error = NULL
      WHERE dead_lettered_at > NOW() - INTERVAL '48 hours'
        AND (last_error ILIKE '%429%' OR last_error ILIKE '%quota%' OR last_error ILIKE '%not_implemented%')
      RETURNING id`);
  console.log('Ressuscitadas:', r.rowCount, '→ ids', r.rows.map((x) => x.id).join(', ') || '(nenhuma)');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
