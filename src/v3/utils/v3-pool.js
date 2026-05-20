'use strict';
/**
 * HEALTHFARE V3 — pool pg compartilhado.
 *
 * search_path = v3, public é setado via a connection option
 * `-c search_path=...` (vai no startup packet da conexão) — em vez
 * do handler pool.on('connect', c => c.query('SET search_path…')),
 * que dispara o DeprecationWarning do node-pg ("client.query()
 * quando o client já está executando uma query").
 *
 * Princípio #24: V3 escreve schema-qualificado v3.*; o search_path
 * cobre as leituras de tabelas legadas em public.
 */
const { Pool } = require('pg');

function makeV3Pool(opts = {}) {
  return new Pool({
    connectionString: opts.connectionString || process.env.DATABASE_URL,
    ssl: opts.ssl !== undefined ? opts.ssl : { rejectUnauthorized: false },
    options: '-c search_path=v3,public',
    max: opts.max || 5,
  });
}

module.exports = { makeV3Pool };
