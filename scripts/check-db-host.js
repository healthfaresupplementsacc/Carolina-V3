'use strict';
const { Pool } = require('pg');
try {
  const u = new URL(process.env.DATABASE_URL);
  console.log('DB host:', u.hostname);
  console.log('DB port:', u.port);
  console.log('DB name:', u.pathname.replace('/', ''));
} catch (e) { console.log('DATABASE_URL não parseável:', e.message); }
console.log('PG* vars presentes:', ['PGHOST', 'RAILWAY_PROJECT_NAME', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_NAME'].map((k) => k + '=' + (process.env[k] || '—')).join(' | '));
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
p.query("SELECT version() AS v, pg_size_pretty(pg_database_size(current_database())) AS size, (SELECT count(*)::int FROM v3.events) AS events, (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='v3') AS tables")
  .then((r) => {
    const row = r.rows[0];
    console.log('Postgres:', String(row.v).split(' on ')[0]);
    console.log('tamanho da base:', row.size);
    console.log('tabelas no schema v3:', row.tables, '| events:', row.events);
    return p.end();
  }).catch((e) => { console.log('query ERR', e.message); process.exit(1); });
