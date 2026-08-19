'use strict';
/**
 * HEALTHFARE V3 — Scanner pareado celular ↔ kiosk (S15 Fase 3, Bruno 08-18).
 *
 * A ideia: o operador não vai comprar leitor pra cada estação. O celular dele já
 * tem câmera. O kiosk mostra um QR com um código de 6 letras; o celular abre
 * /scan/?c=<código>, lê o código de barras e EMPURRA pro computador. A tela do
 * kiosk recebe na hora, como se um leitor USB tivesse digitado ali.
 *
 * Modelo (igual ao print-stream, que já roda em produção): SSE. O kiosk assina
 * `GET scan/stream?code=`, o celular faz `POST scan/push`, e o broadcast entrega.
 * SSE passa por proxy/Railway sem drama e é HTTP puro — nada de WebSocket.
 *
 * SEGURANÇA: o celular NÃO tem login. O código de pareamento É a credencial:
 *  - 6 chars de um alfabeto sem ambiguidade (nada de O/0, I/1) — ninguém erra ditando
 *  - vive 15 min e só é renovado por quem está no kiosk (keepalive do celular
 *    também renova enquanto está lendo, mas o par nasce de uma sessão real)
 *  - expirado → 410 no push. O celular mostra "pareamento expirou, leia o QR de novo"
 *  - o par guarda a sessão do kiosk: quem escuta o stream tem que ser a MESMA sessão
 *    que pediu o pareamento (senão um kiosk vizinho leria os scans do outro)
 *
 * Estado: v3.scan_pairs é a fonte durável (sobrevive a restart do processo); o mapa
 * de clientes SSE é em memória por definição (uma conexão HTTP não é persistível).
 */

// sem O/0/I/1/L pra ninguém errar lendo o código na tela
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const TTL_MS = 15 * 60 * 1000;      // pareamento vive 15 min, renovável
const KEEPALIVE_MS = 25 * 1000;     // comentário SSE pra proxy não matar a conexão

function randomCode(rnd) {
  let out = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    out += ALPHABET[Math.floor((rnd ? rnd() : Math.random()) * ALPHABET.length)];
  }
  return out;
}

/**
 * createScanHub({db, now?, random?}) → registro de pares + hub SSE.
 * Express-agnóstico: recebe/devolve objetos; quem escreve no `res` é o handler
 * (só o stream precisa do res, porque SSE É a resposta).
 */
function createScanHub(deps = {}) {
  const db = deps.db;
  const now = deps.now || (() => Date.now());
  const random = deps.random || null;
  const ttlMs = deps.ttlMs || TTL_MS;
  /** code → Set(res) — kiosks escutando aquele par. */
  const clients = new Map();

  const upper = (v) => String(v || '').trim().toUpperCase();

  /** Cria (ou recria) um par pra esta sessão do kiosk. */
  async function pair({ session_token, person_id }) {
    const code = randomCode(random);
    const expiresAt = new Date(now() + ttlMs);
    await db.query(
      `INSERT INTO v3.scan_pairs (code, session_token, person_id, expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE
         SET session_token = EXCLUDED.session_token, person_id = EXCLUDED.person_id,
             expires_at = EXCLUDED.expires_at, created_at = NOW()`,
      [code, session_token || null, person_id || null, expiresAt]);
    return { code, expires_at: expiresAt.toISOString() };
  }

  /** Lê o par. null quando não existe. Não julga validade — quem julga é o caller. */
  async function get(code) {
    const c = upper(code);
    if (!c) return null;
    const r = await db.query('SELECT * FROM v3.scan_pairs WHERE code = $1', [c]);
    return r.rows[0] || null;
  }

  function isExpired(row) {
    if (!row || !row.expires_at) return true;
    return new Date(row.expires_at).getTime() <= now();
  }

  /** Renova a validade (kiosk com a tela aberta ou celular lendo). */
  async function renew(code, { phone_ua } = {}) {
    const c = upper(code);
    const expiresAt = new Date(now() + ttlMs);
    const r = await db.query(
      `UPDATE v3.scan_pairs
          SET expires_at = $2, last_seen_at = NOW(),
              phone_ua = COALESCE($3, phone_ua)
        WHERE code = $1 RETURNING *`,
      [c, expiresAt, phone_ua || null]);
    return r.rows[0] || null;
  }

  /** Registra um kiosk escutando este código. Devolve a função de desinscrever. */
  function addClient(code, res) {
    const c = upper(code);
    if (!clients.has(c)) clients.set(c, new Set());
    const set = clients.get(c);
    set.add(res);
    const drop = () => {
      const s = clients.get(c);
      if (!s) return;
      s.delete(res);
      if (!s.size) clients.delete(c);
    };
    if (res && typeof res.on === 'function') res.on('close', drop);
    return drop;
  }

  /** Empurra um evento pros kiosks daquele par. Devolve quantos receberam. */
  function broadcast(code, event, data) {
    const set = clients.get(upper(code));
    if (!set || !set.size) return 0;
    const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    let sent = 0;
    for (const res of [...set]) {
      try { res.write(msg); sent += 1; } catch (_) { set.delete(res); }
    }
    if (!set.size) clients.delete(upper(code));
    return sent;
  }

  /** Quantos kiosks estão escutando (o "celular conectado" do lado de cá). */
  function clientCount(code) {
    if (code === undefined) {
      let n = 0; for (const s of clients.values()) n += s.size; return n;
    }
    const s = clients.get(upper(code));
    return s ? s.size : 0;
  }

  /** Limpa pares vencidos (chamado de vez em quando; nunca bloqueia nada). */
  async function sweep() {
    try {
      const r = await db.query('DELETE FROM v3.scan_pairs WHERE expires_at < NOW() RETURNING code');
      for (const row of (r.rows || [])) clients.delete(upper(row.code));
      return r.rowCount || 0;
    } catch (_) { return 0; }
  }

  return { pair, get, renew, isExpired, addClient, broadcast, clientCount, sweep, _clients: clients };
}

module.exports = { createScanHub, randomCode, ALPHABET, CODE_LEN, TTL_MS, KEEPALIVE_MS };
