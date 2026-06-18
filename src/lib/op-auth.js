'use strict';
/**
 * HEALTHFARE V3 — Operator Page: PIN hashing + sessões.
 *
 * PIN 4 dígitos → scrypt (crypto nativo do Node; bcrypt não instalável —
 * npm global da máquina quebrado — e scrypt é equivalente/superior em
 * custo de memória contra brute-force). Colunas: persons.pin_hash/pin_salt.
 *
 * Sessão: token 48-bytes hex em v3.operator_sessions. Válida se
 * logged_out_at IS NULL e last_activity_at < 16h atrás (guarda server-side;
 * o auto-logoff fino é client-side por operador).
 */
const crypto = require('crypto');

const SCRYPT_LEN = 64;
const SESSION_MAX_IDLE_HOURS = 16;

function hashPin(pin, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, SCRYPT_LEN);
  return { pin_hash: hash.toString('hex'), pin_salt: salt.toString('hex') };
}

function verifyPin(pin, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  try {
    const candidate = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), SCRYPT_LEN);
    const stored = Buffer.from(hashHex, 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  } catch (_) {
    return false;
  }
}

function makeSessionToken() {
  return crypto.randomBytes(48).toString('hex');
}

/** Cria sessão pro person. Retorna a row criada. */
async function createSession(db, { personId, ip, userAgent }) {
  const token = makeSessionToken();
  const r = await db.query(
    `INSERT INTO v3.operator_sessions (person_id, session_token, source, ip_address, user_agent)
     VALUES ($1, $2, 'page', $3, $4)
     RETURNING id, person_id, session_token, created_at`,
    [personId, token, ip || null, userAgent || null]);
  return r.rows[0];
}

/** Valida token → { session, person } ou null. */
async function getSession(db, token) {
  if (!token) return null;
  const r = await db.query(
    `SELECT s.id AS session_id, s.person_id, s.last_activity_at,
            p.display_name, p.role, p.active, p.auto_logoff_seconds, p.count_exempt, p.is_sandbox
     FROM v3.operator_sessions s
     JOIN v3.persons p ON p.id = s.person_id
     WHERE s.session_token = $1
       AND s.logged_out_at IS NULL
       AND s.last_activity_at > NOW() - INTERVAL '${SESSION_MAX_IDLE_HOURS} hours'
     LIMIT 1`, [token]);
  return r.rows[0] || null;
}

/** Atualiza last_activity_at (heartbeat). true se sessão viva. */
async function touchSession(db, token) {
  const r = await db.query(
    `UPDATE v3.operator_sessions SET last_activity_at = NOW()
     WHERE session_token = $1 AND logged_out_at IS NULL
     RETURNING id, person_id`, [token]);
  return r.rows[0] || null;
}

/** Fecha sessão (idempotente). */
async function closeSession(db, token, reason) {
  const r = await db.query(
    `UPDATE v3.operator_sessions
     SET logged_out_at = NOW(), logoff_reason = $2
     WHERE session_token = $1 AND logged_out_at IS NULL
     RETURNING id, person_id`, [token, reason || 'manual']);
  return r.rows[0] || null;
}

/** Quantos OUTROS operators (role=operator) têm sessão ativa agora. */
async function otherActiveOperators(db, sessionId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
     FROM v3.operator_sessions s
     JOIN v3.persons p ON p.id = s.person_id
     WHERE s.logged_out_at IS NULL
       AND s.last_activity_at > NOW() - INTERVAL '${SESSION_MAX_IDLE_HOURS} hours'
       AND p.role = 'operator'
       AND s.id <> $1`, [sessionId]);
  return r.rows[0].n;
}

module.exports = {
  hashPin, verifyPin, makeSessionToken,
  createSession, getSession, touchSession, closeSession, otherActiveOperators,
  SESSION_MAX_IDLE_HOURS,
};
