'use strict';
/**
 * HEALTHFARE V3 — PREFERÊNCIAS POR CONTA — API /api/v3/prefs/* (Bruno 08-19).
 *
 * "Como eu salvo os widgets do jeito que eu quero?" — salvando na CONTA, não no
 * navegador. O layout da Hoje vivia só em localStorage: arrumava no desktop e o
 * notebook abria no padrão de fábrica, e dois logins no mesmo navegador viam a
 * configuração um do outro.
 *
 * GENÉRICO DE PROPÓSITO. Uma chave por preferência, valor JSON livre. A página
 * Hoje usa 'hoje.layout'; a próxima preferência (tema, colunas de tabela, filtros
 * favoritos, página inicial) entra sem rota nova e sem migração — só um key novo.
 * O servidor NÃO interpreta o valor: quem escreve a chave é dono do formato.
 *
 * CONTRATO: envelope { data } / { error:{ code, message } } — o mesmo do data
 * router e do warehouse hub.
 *
 * AUTH: makeAuthMiddleware (PIN → v3.app_logins). QUALQUER login vale, sem gate
 * de função: a preferência é da própria pessoa, não um recurso do sistema. Negar
 * "salvar o meu layout" por falta de permissão seria burocracia — e empurraria
 * todo mundo de volta pro localStorage.
 *
 * LOGIN DE EMERGÊNCIA (ADMIN_PIN, sem id de banco): não tem conta pra pendurar a
 * linha (não existe app_logins.id 0) e gravar assim mesmo seria uma conta
 * compartilhada por quem souber o PIN. Então:
 *   GET  → { prefs:{}, account:null }  (a tela cai no localStorage sozinha)
 *   PUT/DELETE → 409 no_account, com o texto que a tela mostra pro usuário.
 * REGRA #0: nada é bloqueado — a pessoa segue trabalhando, só salva local.
 */

const express = require('express');
const { makeAuthMiddleware } = require('../data/auth');

const BASE = '/api/v3/prefs';

/** Chave de preferência: minúscula, ponto/traço/underscore, até 64. */
const KEY_RE = /^[a-z0-9._-]{1,64}$/;

/** Teto do valor. 64 KB é ordens de grandeza acima de um layout de widgets;
 *  serve pra impedir que alguém use a tabela como armazenamento de arquivo. */
const VALUE_MAX_BYTES = 64 * 1024;

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

const MSG_NO_ACCOUNT = 'Entre com o seu PIN pessoal pra salvar na conta.';

/** Login com conta de verdade? O fallback de emergência vem com id 0/ausente. */
function accountIdOf(login) {
  const id = login && login.id;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** O que a tela mostra sobre quem está salvando. null = sem conta. */
function accountOf(login) {
  const id = accountIdOf(login);
  if (!id) return null;
  return { id, name: (login && login.name) || null, role: (login && login.role) || null };
}

function createPrefsRouter(deps = {}) {
  const db = deps.db;
  const router = express.Router();

  router.use(BASE, express.json({ limit: '128kb' }));
  router.use(BASE, makeAuthMiddleware({ db }));

  const ok = (res, data) => res.json({ data });

  /** Envolve um handler com tradução de erro (nunca vaza stack pro cliente). */
  function route(method, path, handler) {
    router[method](BASE + path, async (req, res) => {
      try {
        await handler(req, res);
      } catch (e) {
        console.error('[prefs]', method.toUpperCase(), path, '-', e.message);
        return err(res, 'internal', 'não deu pra ler ou salvar a preferência.', 500);
      }
    });
  }

  /** key da rota, validada. Devolve null (e já responde 400) se não presta. */
  function keyOf(req, res) {
    const k = String((req.params && req.params.key) || '').trim();
    if (!KEY_RE.test(k)) {
      err(res, 'bad_key', 'chave inválida: use letras minúsculas, números, ponto, traço ou underscore (até 64).', 400);
      return null;
    }
    return k;
  }

  // ── TUDO DE UMA VEZ ────────────────────────────────────────
  // A tela pede isso no boot: um round-trip só e ela já sabe o que é da conta e
  // quem é a conta (pra escrever "Salvo na sua conta (Bruno)").
  route('get', '', async (req, res) => {
    const account = accountOf(req.login);
    if (!account) return ok(res, { prefs: {}, account: null });
    const r = await db.query(
      'SELECT key, value FROM v3.user_prefs WHERE login_id = $1 ORDER BY key', [account.id]);
    const prefs = {};
    for (const row of r.rows) prefs[row.key] = row.value;
    return ok(res, { prefs, account });
  });

  // ── UMA CHAVE ──────────────────────────────────────────────
  // Sem valor salvo NÃO é 404: "esta conta ainda não escolheu nada" é uma
  // resposta legítima, e a tela usa o padrão dela. 404 mandaria a tela tratar
  // ausência como erro.
  route('get', '/:key', async (req, res) => {
    const key = keyOf(req, res);
    if (!key) return undefined;
    const account = accountOf(req.login);
    if (!account) return ok(res, { key, value: null, updated_at: null, account: null });
    const r = await db.query(
      'SELECT value, updated_at FROM v3.user_prefs WHERE login_id = $1 AND key = $2',
      [account.id, key]);
    const row = r.rows[0];
    return ok(res, {
      key,
      value: row ? row.value : null,
      updated_at: row ? row.updated_at : null,
      account,
    });
  });

  // ── SALVAR ─────────────────────────────────────────────────
  route('put', '/:key', async (req, res) => {
    const key = keyOf(req, res);
    if (!key) return undefined;
    const account = accountOf(req.login);
    if (!account) return err(res, 'no_account', MSG_NO_ACCOUNT, 409);

    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
      return err(res, 'bad_request', 'corpo precisa de { value }.', 400);
    }
    const value = body.value;
    if (value === undefined) {
      return err(res, 'bad_request', 'corpo precisa de { value }.', 400);
    }
    let json;
    try {
      json = JSON.stringify(value);
    } catch (_) {
      return err(res, 'bad_request', 'o valor precisa ser JSON.', 400);
    }
    if (json === undefined) return err(res, 'bad_request', 'o valor precisa ser JSON.', 400);
    if (Buffer.byteLength(json, 'utf8') > VALUE_MAX_BYTES) {
      return err(res, 'too_large', 'a preferência passou de 64 KB.', 413);
    }

    const r = await db.query(
      `INSERT INTO v3.user_prefs (login_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (login_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING key, updated_at`,
      [account.id, key, json]);
    const row = r.rows[0] || {};
    return ok(res, { key, updated_at: row.updated_at || null, account });
  });

  // ── APAGAR ─────────────────────────────────────────────────
  // Apagar o que já não existia devolve 200 com deleted:false. O estado final é
  // o que a pessoa pediu (não tem preferência salva), e 404 aqui só faria a tela
  // mostrar erro pra uma operação que deu certo.
  route('delete', '/:key', async (req, res) => {
    const key = keyOf(req, res);
    if (!key) return undefined;
    const account = accountOf(req.login);
    if (!account) return err(res, 'no_account', MSG_NO_ACCOUNT, 409);
    const r = await db.query(
      'DELETE FROM v3.user_prefs WHERE login_id = $1 AND key = $2 RETURNING key',
      [account.id, key]);
    return ok(res, { key, deleted: r.rows.length > 0, account });
  });

  console.log('[V3] Preferências por conta montadas: ' + BASE + '/*');
  return router;
}

module.exports = { createPrefsRouter, BASE, KEY_RE, VALUE_MAX_BYTES, MSG_NO_ACCOUNT };
