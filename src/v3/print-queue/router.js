'use strict';
/**
 * HEALTHFARE V3 — FILA DE IMPRESSÃO, API /api/v3/print-queue/* (S15.34, Bruno 08-19).
 *
 * Três clientes, três credenciais, uma fila:
 *   1. ADMIN pelo celular (/m/) — header `x-admin-pin`, RBAC view_stock/manage_stock.
 *      Pede a impressão, vê a fila, cancela o que pediu.
 *   2. ESTAÇÃO logada (kiosk /print ou /op) — Bearer OPERATOR_PAGE_TOKEN + a sessão
 *      em `X-Session-Token`. É quem toma e conclui.
 *   3. AGENTE do .28 — header `x-print-token` (o MESMO PRINT_EVENT_TOKEN do
 *      /api/print-event). Nenhum conceito de auth novo entrou no sistema.
 *
 * Por que não uma auth só: cada um desses já existe e já é o jeito daquele cliente
 * falar com a gente. Inventar uma quarta credencial pra fila seria mais um segredo
 * pra guardar, e o .28 não tem como digitar PIN.
 *
 * Escrita de estoque: NENHUMA. O único efeito colateral fora da fila é carimbar
 * label_printed_at nas caixas impressas (service.stampBoxes), que é o mesmo
 * carimbo do POST /api/v3/warehouse/locations/box/:id/label-printed.
 */

const express = require('express');
const { resolveLogin, hasFunction } = require('../data/auth');
const opAuth = require('../../lib/op-auth');
const { PrintQueueService, QueueError } = require('./service');

const BASE = '/api/v3/print-queue';

const err = (res, code, message, status) =>
  res.status(status || 400).json({ error: { code, message } });

/**
 * Erro de negócio → HTTP com o código estável; qualquer outro → 500 com log.
 *
 * Reconhece o QueueError e o ShippingLabelsError pelo formato ({code, status}),
 * não pelo `instanceof`: as duas classes moram em módulos diferentes e um dia
 * podem ser carregadas por caminhos diferentes. O que importa é o contrato —
 * quem tem código e status é erro de negócio e o cliente precisa vê-lo
 * (`nothing_to_print` tem que chegar como 409, não como um 500 genérico).
 */
function sendError(res, e, where) {
  if (e instanceof QueueError) return err(res, e.code, e.message, e.status);
  if (e && e.code && Number.isInteger(e.status) && e.status >= 400 && e.status < 500) {
    return err(res, e.code, e.message, e.status);
  }
  console.error('[print-queue]', where, '-', e.message);
  return err(res, 'internal', e.message, 500);
}

/**
 * Identidade de quem chamou, em ordem de custo (o PIN é o mais comum e o mais
 * barato; a sessão do kiosk custa uma query; o token do .28 é comparação de env).
 *
 * @returns {Promise<null|{kind, name, is_admin, can_write, is_test, login_id}>}
 */
async function identify(db, req) {
  const h = req.headers || {};

  // 1) ADMIN por PIN (mesmo resolveLogin do data/auth — zero hashing duplicado)
  const pin = (req.query && req.query.pin) || h['x-admin-pin'];
  if (pin) {
    let login = null;
    if (db) { try { login = await resolveLogin(db, pin); } catch (_) { login = null; } }
    if (login) {
      const canRead = hasFunction(login, 'view_stock') || hasFunction(login, 'manage_stock');
      if (canRead) {
        return { kind: 'admin', name: login.name || 'admin', is_admin: true,
          can_write: hasFunction(login, 'manage_stock'), is_test: false,
          login_id: login.id || null };
      }
      return null;      // PIN vale, mas não é gente de estoque
    }
  }

  // 2) KIOSK: o token da PÁGINA prova que é a nossa estação; a sessão prova QUEM.
  const auth = String(h.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const pageToken = process.env.OPERATOR_PAGE_TOKEN || null;
  if (bearer && pageToken && bearer === pageToken) {
    const sessionToken = h['x-session-token'] || null;
    if (sessionToken && db) {
      let session = null;
      try { session = await opAuth.getSession(db, sessionToken); } catch (_) { session = null; }
      if (session) {
        // person_id: quem está logado na estação. As etiquetas de envio usam
        // isso como PACKER no rodapé (Pack: <id>) — é o "employee ID" do
        // dashboard (v3.persons.id), o único que existe no sistema.
        return { kind: 'kiosk', name: session.display_name || 'estação', is_admin: false,
          can_write: true, is_test: !!session.is_sandbox, login_id: null,
          person_id: session.person_id != null ? session.person_id : null };
      }
    }
  }

  // 3) AGENTE do .28 — mesmo segredo do /api/print-event (op.js:416)
  const printToken = h['x-print-token'];
  const expected = process.env.PRINT_EVENT_TOKEN || null;
  if (printToken && expected && printToken === expected) {
    return { kind: 'station', name: 'Estação .28', is_admin: false,
      can_write: true, is_test: false, login_id: null };
  }

  return null;
}

function createPrintQueueRouter(deps = {}) {
  const db = deps.db;
  const queue = deps.queue || new PrintQueueService({ db });
  // Etiquetas de envio (S15.37): opcional — sem o serviço injetado as rotas
  // respondem 503 em vez de derrubar o boot. O resto da fila segue funcionando.
  const shipping = deps.shipping || null;
  const router = express.Router();

  router.use(BASE, express.json({ limit: '256kb' }));

  /**
   * Envolve um handler com a auth tripla + tradução de erro.
   * mode 'read' → qualquer identidade válida; 'write' → precisa de can_write.
   */
  function route(method, path, mode, handler) {
    router[method](BASE + path, async (req, res) => {
      let who = null;
      try {
        who = await identify(db, req);
      } catch (e) {
        return sendError(res, e, method.toUpperCase() + ' ' + path);
      }
      if (!who) {
        return err(res, 'unauthorized',
          'Credencial ausente ou inválida (PIN de admin, sessão da estação ou token de impressão).', 401);
      }
      if (mode === 'write' && !who.can_write) {
        return err(res, 'forbidden', 'Este login não pode mexer na fila de impressão.', 403);
      }
      try {
        await handler(req, res, who);
      } catch (e) {
        return sendError(res, e, method.toUpperCase() + ' ' + path);
      }
    });
  }

  const ok = (res, data) => res.json({ data });

  /** `by` = quem age. O corpo pode dizer (o .28 manda o nome da máquina), mas a
   *  identidade autenticada vence quando existe nome de gente. */
  const actorName = (req, who) => {
    const fromBody = req.body && req.body.by ? String(req.body.by).trim().slice(0, 120) : null;
    if (who.kind === 'station') return fromBody || who.name;
    return who.name || fromBody || 'desconhecido';
  };

  // ── LISTAR ──────────────────────────────────────────────────
  // Sem status → 'queued' (é o que a estação quer 99% das vezes).
  route('get', '', 'read', async (req, res, who) => {
    const jobs = await queue.list({
      status: req.query.status || 'queued',
      limit: req.query.limit,
      include_test: who.is_test,
    });
    ok(res, { jobs });
  });

  // ── ETIQUETAS DE ENVIO (S15.37) ─────────────────────────────
  // ANTES do '/:id': '/shipping-labels/preview' casaria com '/:id' se viesse
  // depois (id = 'shipping-labels'), e a fila responderia 400 em vez da tela.
  const needShipping = (res) => {
    if (shipping) return false;
    err(res, 'unavailable', 'Etiquetas de envio não estão configuradas neste servidor.', 503);
    return true;
  };

  /** O que dá pra imprimir hoje. Read-only: não compõe, não enfileira. */
  route('get', '/shipping-labels/preview', 'read', async (req, res) => {
    if (needShipping(res)) return;
    ok(res, await shipping.preview(req.query.day));
  });

  /**
   * Compõe o PDF do dia e enfileira. `take:true` já toma o job pra quem pediu,
   * que é o caminho normal da estação: pede e abre o PDF na mesma ação.
   * O packer é a pessoa da SESSÃO do kiosk (quem está logado embalando); admin
   * pelo celular não é quem embala, então vai null e o rodapé escreve '?'.
   */
  route('post', '/shipping-labels', 'write', async (req, res, who) => {
    if (needShipping(res)) return;
    const b = req.body || {};
    const r = await shipping.compose({
      day: b.day || null,
      shipment_ids: Array.isArray(b.shipment_ids) ? b.shipment_ids : null,
      reprint: !!b.reprint,
      take: !!b.take,
      packer_id: who.kind === 'kiosk' ? (who.person_id != null ? String(who.person_id) : null) : null,
      requested_by: who.name,
      requested_login_id: who.login_id || null,
      is_test: !!who.is_test,
    });
    ok(res, {
      job: r.job,
      file_url: BASE + '/' + r.job.id + '/file',
      counts: r.counts,
    });
  });

  route('get', '/:id', 'read', async (req, res) => {
    const job = await queue.get(req.params.id);
    if (!job) return err(res, 'not_found', 'trabalho não existe: ' + req.params.id, 404);
    ok(res, { job });
  });

  // ── TRANSIÇÕES ──────────────────────────────────────────────
  route('post', '/:id/take', 'write', async (req, res, who) => {
    ok(res, { job: await queue.take(req.params.id, actorName(req, who)) });
  });

  // done: além de fechar o job, ETIQUETA DE ENVIO carimba printed_at nas
  // etiquetas e nas linhas de pedido. É aqui e só aqui que "imprimiu" vira
  // verdade — compor não é imprimir (ver shipping-labels/service.js).
  route('post', '/:id/done', 'write', async (req, res, who) => {
    const job = await queue.done(req.params.id, actorName(req, who));
    let stamped = null;
    if (shipping && job && job.kind === 'shipping_labels') {
      stamped = await shipping.markPrinted(job);
    }
    ok(res, stamped ? { job, stamped } : { job });
  });

  route('post', '/:id/error', 'write', async (req, res, who) => {
    const note = (req.body && req.body.note) || null;
    ok(res, { job: await queue.fail(req.params.id, actorName(req, who), note) });
  });

  route('post', '/:id/cancel', 'write', async (req, res, who) => {
    ok(res, { job: await queue.cancel(req.params.id, actorName(req, who),
      { is_admin: who.is_admin }) });
  });

  /**
   * O PDF em si. Auth PRÓPRIA (não usa route()): quem abre isso é uma ABA NOVA
   * do navegador — window.open não manda header nenhum. Então o token da sessão
   * do kiosk entra em ?t= e o PIN do admin em ?pin=. Mesmas credenciais que já
   * existem, só que no lugar onde uma aba consegue carregá-las.
   *
   * SÓ NESTA ROTA. Toda outra continua exigindo header: um PIN na query fica no
   * histórico do navegador e em log de proxy, e isso é um risco que só vale pela
   * única coisa que não tem outro jeito — abrir um PDF numa aba.
   */
  router.get(BASE + '/:id/file', async (req, res) => {
    if (needShipping(res)) return;
    // ?t= é o X-Session-Token do kiosk; a auth do kiosk também exige o Bearer da
    // página, que uma aba não manda. Aqui a sessão sozinha basta: ela é secreta,
    // expira, e o que ela libera é um PDF de etiquetas, não uma escrita.
    const t = req.query.t ? String(req.query.t) : null;
    let who = null;
    try {
      who = await identify(db, req);       // pega ?pin= e os headers normais
      if (!who && t) {
        const session = await opAuth.getSession(db, t);
        if (session) {
          who = { kind: 'kiosk', name: session.display_name || 'estação', is_admin: false,
            can_write: true, is_test: !!session.is_sandbox, login_id: null };
        }
      }
    } catch (e) { return sendError(res, e, 'GET /:id/file'); }
    if (!who) return err(res, 'unauthorized', 'Credencial ausente ou inválida.', 401);

    try {
      const job = await queue.get(req.params.id);
      if (!job) return err(res, 'not_found', 'trabalho não existe: ' + req.params.id, 404);
      const file = await shipping.fileForJob(job.id);
      if (!file) return err(res, 'not_found', 'esse trabalho não tem PDF guardado', 404);
      const day = (job.payload && job.payload.day) || 'hoje';
      res.setHeader('Content-Type', file.mime || 'application/pdf');
      res.setHeader('Content-Disposition',
        'inline; filename="etiquetas-envio-' + day + '.pdf"');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.end(Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes));
    } catch (e) { return sendError(res, e, 'GET /:id/file'); }
  });

  console.log('[V3] Fila de impressão montada: ' + BASE + '/*');
  return router;
}

module.exports = { createPrintQueueRouter, identify, BASE };
