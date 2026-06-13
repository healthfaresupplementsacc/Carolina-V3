'use strict';
/**
 * HEALTHFARE V3 — middleware de segurança (Fase D bloco-zerar).
 *
 * Aplicado SÓ nas rotas novas (/op, /admin, /api/v3/op, /api/adminpanel,
 * /api/v3/architect) — NÃO no dashboard V4 legado (R8/G4), pra não quebrar
 * o que já funciona com CSP restritivo.
 *
 * - securityHeaders: CSP + X-Frame-Options + nosniff + Referrer-Policy +
 *   HSTS + Permissions-Policy (microfone liberado pro /op voice).
 * - makeRateLimit(key, limit, windowMs): rate-limit em memória por IP.
 * - bruteForceGuard: conta falhas de login por IP; 10+/h → bloqueia 24h +
 *   alerta Carolina no #admin-orin.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'", // Chart.js + handlers inline da UI
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
}

/** Rate-limit em memória por IP. Retorna middleware. */
function makeRateLimit({ limit = 60, windowMs = 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = now();
    let e = hits.get(ip);
    if (!e || t - e.windowStart >= windowMs) { e = { count: 0, windowStart: t }; hits.set(ip, e); }
    e.count += 1;
    if (e.count > limit) {
      res.set('Retry-After', String(Math.ceil((e.windowStart + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'rate_limited', limit, window_s: windowMs / 1000 });
    }
    if (hits.size > 2000) { for (const [k, v] of hits) if (t - v.windowStart >= windowMs) hits.delete(k); }
    return next();
  };
}

/**
 * Brute-force guard de login. Uso:
 *   const bf = makeBruteForceGuard({ db, slack, adminChannelId });
 *   await bf.hydrate();                            // carrega bans persistidos no boot
 *   app.use(prefix, bf.globalGate);                // 403 p/ qualquer request de IP banido
 *   router.use('/api/.../auth/login', bf.gate);    // 429 no login (mensagem mais informativa)
 *   ... no handler de login, em caso de FALHA: bf.recordFailure(ip);
 *       em caso de SUCESSO: bf.recordSuccess(ip);
 *
 * Persistência (migration 023, v3.blocked_ips): o ban é gravado no DB no momento
 * em que dispara e re-hidratado no boot, então sobrevive a restart/redeploy do
 * Railway (antes vivia só em memória e sumia). A expiração é preguiçosa (checada
 * em isBanned) + limpeza dos expirados no hydrate.
 */
function makeBruteForceGuard({ db, slack, adminChannelId, now = Date.now, threshold = 10, windowMs = 60 * 60 * 1000, banMs = 24 * 60 * 60 * 1000 } = {}) {
  const fails = new Map();   // ip -> [timestamps]
  const banned = new Map();  // ip -> banUntil (ms)
  const alerted = new Set(); // ip já alertado nesta janela de ban

  function isBanned(ip) {
    const until = banned.get(ip);
    if (!until) return false;
    if (now() >= until) { banned.delete(ip); alerted.delete(ip); return false; }
    return true;
  }

  /** Carrega bans não-expirados do DB e limpa os vencidos. Idempotente. */
  async function hydrate() {
    if (!db) return 0;
    try {
      await db.query('DELETE FROM v3.blocked_ips WHERE expires_at <= NOW()').catch(() => {});
      const r = await db.query(
        "SELECT ip_address, EXTRACT(EPOCH FROM expires_at) * 1000 AS until_ms FROM v3.blocked_ips WHERE expires_at > NOW()");
      for (const row of (r && r.rows) || []) {
        const until = Number(row.until_ms);
        if (Number.isFinite(until)) { banned.set(row.ip_address, until); alerted.add(row.ip_address); }
      }
      return banned.size;
    } catch (_) { return 0; }
  }

  async function recordFailure(ip) {
    const t = now();
    const arr = (fails.get(ip) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    fails.set(ip, arr);
    if (arr.length >= threshold && !isBanned(ip)) {
      const until = t + banMs;
      banned.set(ip, until);
      if (!alerted.has(ip)) {
        alerted.add(ip);
        if (slack && slack.postAs) {
          try {
            await slack.postAs({
              channel: adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1',
              sender: { name: 'Carolina' }, thread_ts: null,
              text: `⚠️ ${arr.length} tentativas de login falhadas do IP ${ip} na última hora. Possível ataque — IP bloqueado por 24h.`,
            });
          } catch (_) { /* não derruba */ }
        }
        if (db) {
          // persiste o ban (sobrevive a restart) — incrementa block_count em reincidência
          db.query(
            `INSERT INTO v3.blocked_ips (ip_address, expires_at, reason, block_count)
             VALUES ($1, to_timestamp($2 / 1000.0), 'login_bruteforce', 1)
             ON CONFLICT (ip_address) DO UPDATE
               SET blocked_at = NOW(), expires_at = EXCLUDED.expires_at,
                   reason = EXCLUDED.reason, block_count = v3.blocked_ips.block_count + 1`,
            [ip, until]).catch(() => {});
          db.query(
            `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
             VALUES ('system', NULL, 'login_bruteforce_ban', 'api', NULL, $1::jsonb)`,
            [JSON.stringify({ ip, fails: arr.length, ban_hours: banMs / 3600000 })]).catch(() => {});
        }
      }
    }
  }
  function recordSuccess(ip) { fails.delete(ip); }
  function gate(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (isBanned(ip)) return res.status(429).json({ error: 'ip_temporarily_blocked', detail: 'Muitas tentativas. Tente em 24h.' });
    next();
  }
  /** Gate global: 403 sem detalhe p/ qualquer request de IP banido (D.7). */
  function globalGate(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    if (isBanned(ip)) return res.status(403).json({ error: 'forbidden' });
    next();
  }
  return { gate, globalGate, recordFailure, recordSuccess, isBanned, hydrate };
}

module.exports = { securityHeaders, makeRateLimit, makeBruteForceGuard, CSP };
