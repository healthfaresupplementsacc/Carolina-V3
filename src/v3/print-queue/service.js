'use strict';
/**
 * HEALTHFARE V3 — FILA DE IMPRESSÃO (S15.34, Bruno 08-19).
 *
 * O celular pede, a estação puxa. Este módulo é a fila inteira: enfileirar,
 * listar, tomar, concluir, errar, cancelar. Nada aqui fala com impressora —
 * quem imprime é o PC .28 (ou a página /print aberta na estação), que faz poll.
 *
 * INVARIANTES
 *  - Estado é honesto: `taken` é `taken`, nunca volta pra `queued` sozinho. Se a
 *    estação travou no meio, a PRÓXIMA estação pode RE-TOMAR um job `taken` com
 *    mais de RETAKE_AFTER_MIN minutos (take() aceita isso explicitamente). O
 *    estado nunca mente; a recuperação é uma ação de alguém.
 *  - Toda transição vira uma linha em v3.audit_log ('print_queue_<estado>').
 *  - Concluir um job de etiqueta de CAIXA carimba label_printed_at em todas as
 *    caixas do payload — o mesmo carimbo do POST /locations/box/:id/label-printed.
 *    Caixa sem etiqueta é caixa perdida; o carimbo não pode depender de alguém
 *    lembrar de apertar um segundo botão.
 *  - is_test some das listas de trabalho, mas FICA na tabela (REGRA #0).
 *
 * Nada aqui escreve quantidade de estoque. A fila não é o livro-razão.
 */

const KINDS = ['bin_labels', 'box_label', 'picklist'];
const STATUSES = ['queued', 'taken', 'done', 'error', 'cancelled'];
const LIST_CAP = 200;
const DEFAULT_LIMIT = 50;
/** Job 'taken' parado além disso pode ser re-tomado por outra estação. */
const RETAKE_AFTER_MIN = 10;

/** Erro de negócio com código estável (o router traduz pra HTTP). */
class QueueError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

const SELECT_COLS = `
  id, kind, payload, requested_by, requested_login_id, target, status,
  taken_by, taken_at, done_at, error_note, is_test, created_at,
  (EXTRACT(EPOCH FROM (NOW() - created_at))::int / 60) AS age_min`;

/** Normaliza a row do banco pro contrato da API. */
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload || {},
    requested_by: row.requested_by || null,
    requested_login_id: row.requested_login_id == null ? null : Number(row.requested_login_id),
    target: row.target || 'any',
    status: row.status,
    age_min: row.age_min == null ? null : Number(row.age_min),
    taken_by: row.taken_by || null,
    taken_at: row.taken_at || null,
    done_at: row.done_at || null,
    error_note: row.error_note || null,
    is_test: !!row.is_test,
    created_at: row.created_at || null,
  };
}

const textOf = (v, max) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
};

class PrintQueueService {
  constructor(deps = {}) {
    this.db = deps.db;
  }

  /** Uma linha de auditoria por mudança de estado. Nunca derruba a operação. */
  async _audit(action, jobId, by, extra) {
    try {
      await this.db.query(
        `INSERT INTO v3.audit_log
           (actor_type, actor_person_id, action, target_type, target_id, metadata)
         VALUES ('admin', NULL, $1, 'print_queue', $2, $3::jsonb)`,
        [action, jobId || null, JSON.stringify(Object.assign({ by: by || null }, extra || {}))]);
    } catch (_) { /* auditoria nunca derruba a operação */ }
  }

  /**
   * Enfileira um trabalho.
   * @param {object} p {kind, payload, requested_by, requested_login_id?, target?, is_test?}
   */
  async enqueue(p = {}) {
    const kind = String(p.kind || '').trim();
    if (!KINDS.includes(kind)) {
      throw new QueueError('bad_request', 'kind inválido (bin_labels, box_label ou picklist)');
    }
    const payload = p.payload && typeof p.payload === 'object' ? p.payload : {};
    const r = await this.db.query(
      `INSERT INTO v3.print_queue
         (kind, payload, requested_by, requested_login_id, target, is_test)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6)
       RETURNING ${SELECT_COLS}`,
      [kind, JSON.stringify(payload), textOf(p.requested_by, 120),
        p.requested_login_id != null ? Number(p.requested_login_id) : null,
        textOf(p.target, 40) || 'any', !!p.is_test]);
    const job = shape(r.rows[0]);
    await this._audit('print_queue_queued', job.id, job.requested_by,
      { kind: job.kind, labels: Array.isArray(payload.labels) ? payload.labels.length : null });
    return job;
  }

  /**
   * Lista a fila. status 'all' traz tudo; default 'queued'.
   * `include_test` só quando quem pergunta é o próprio sandbox.
   */
  async list(opts = {}) {
    const status = opts.status && opts.status !== 'all' ? String(opts.status) : null;
    if (status && !STATUSES.includes(status)) {
      throw new QueueError('bad_request', 'status inválido');
    }
    let limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > LIST_CAP) limit = LIST_CAP;
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (!opts.include_test) where.push('is_test = false');
    params.push(limit);
    // fila de trabalho = mais antigo primeiro (o .28 imprime na ordem em que
    // pediram); histórico = mais recente primeiro (o celular quer o último).
    const order = status === 'queued' || status === 'taken'
      ? 'created_at ASC' : 'created_at DESC';
    const r = await this.db.query(
      `SELECT ${SELECT_COLS} FROM v3.print_queue
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${order} LIMIT $${params.length}`, params);
    return r.rows.map(shape);
  }

  async get(id) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) throw new QueueError('bad_request', 'id inválido');
    const r = await this.db.query(
      `SELECT ${SELECT_COLS} FROM v3.print_queue WHERE id = $1`, [jobId]);
    return shape(r.rows[0]);
  }

  /** Quantos esperam agora (o número que o celular mostra no topo). */
  async queuedCount() {
    const r = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM v3.print_queue
        WHERE status = 'queued' AND is_test = false`);
    return Number((r.rows[0] && r.rows[0].n) || 0);
  }

  /**
   * A estação TOMA o job. Só um pega: o UPDATE condicional resolve a corrida sem
   * lock explícito (duas estações fazendo poll ao mesmo tempo é o caso normal).
   * Um job 'taken' parado há mais de RETAKE_AFTER_MIN pode ser re-tomado — a
   * estação anterior travou e o papel nunca saiu.
   */
  async take(id, by) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) throw new QueueError('bad_request', 'id inválido');
    const r = await this.db.query(
      `UPDATE v3.print_queue
          SET status = 'taken', taken_by = $2, taken_at = NOW()
        WHERE id = $1
          AND (status = 'queued'
               OR (status = 'taken'
                   AND taken_at < NOW() - INTERVAL '${RETAKE_AFTER_MIN} minutes'))
        RETURNING ${SELECT_COLS}`, [jobId, textOf(by, 120)]);
    if (!r.rows[0]) {
      const current = await this.get(jobId);
      if (!current) throw new QueueError('not_found', 'trabalho não existe: ' + jobId, 404);
      throw new QueueError('not_queued',
        'Este trabalho não está esperando (status ' + current.status + ').', 409);
    }
    const job = shape(r.rows[0]);
    await this._audit('print_queue_taken', job.id, job.taken_by, { kind: job.kind });
    return job;
  }

  /**
   * Concluído: o papel saiu. Carimba label_printed_at nas caixas do payload
   * (etiqueta de caixa) pelo MESMO caminho do endpoint que já existia.
   */
  async done(id, by) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) throw new QueueError('bad_request', 'id inválido');
    const r = await this.db.query(
      `UPDATE v3.print_queue
          SET status = 'done', done_at = NOW(),
              taken_by = COALESCE(taken_by, $2), taken_at = COALESCE(taken_at, NOW())
        WHERE id = $1 AND status IN ('queued','taken')
        RETURNING ${SELECT_COLS}`, [jobId, textOf(by, 120)]);
    if (!r.rows[0]) {
      const current = await this.get(jobId);
      if (!current) throw new QueueError('not_found', 'trabalho não existe: ' + jobId, 404);
      throw new QueueError('not_open',
        'Este trabalho já foi fechado (status ' + current.status + ').', 409);
    }
    const job = shape(r.rows[0]);
    const stamped = await this.stampBoxes(job);
    await this._audit('print_queue_done', job.id, job.taken_by || textOf(by, 120),
      { kind: job.kind, boxes_stamped: stamped });
    return job;
  }

  /**
   * Carimba label_printed_at em toda caixa do payload. Só faz sentido pras
   * etiquetas de local (bin_labels traz bins e caixas misturadas quando o admin
   * seleciona os dois). Best-effort: falhar aqui não desfaz a impressão que já
   * aconteceu fisicamente.
   * @returns {Promise<number>} quantas caixas foram carimbadas
   */
  async stampBoxes(job) {
    if (!job || (job.kind !== 'box_label' && job.kind !== 'bin_labels')) return 0;
    const labels = Array.isArray(job.payload && job.payload.labels) ? job.payload.labels : [];
    const ids = [];
    for (const l of labels) {
      if (!l || l.kind !== 'box') continue;
      const id = Number(l.id);
      if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return 0;
    try {
      const r = await this.db.query(
        `UPDATE v3.stock_boxes SET label_printed_at = NOW(), updated_at = NOW()
          WHERE id = ANY($1::int[]) RETURNING id`, [ids]);
      return (r.rows || []).length;
    } catch (e) {
      console.error('[print-queue] carimbo de etiqueta falhou:', e.message);
      return 0;
    }
  }

  /** Deu erro na estação: registra o motivo, o trabalho para de aparecer na fila. */
  async fail(id, by, note) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) throw new QueueError('bad_request', 'id inválido');
    const r = await this.db.query(
      `UPDATE v3.print_queue
          SET status = 'error', done_at = NOW(), error_note = $3,
              taken_by = COALESCE(taken_by, $2)
        WHERE id = $1 AND status IN ('queued','taken')
        RETURNING ${SELECT_COLS}`,
      [jobId, textOf(by, 120), textOf(note, 500) || 'sem detalhe']);
    if (!r.rows[0]) {
      const current = await this.get(jobId);
      if (!current) throw new QueueError('not_found', 'trabalho não existe: ' + jobId, 404);
      throw new QueueError('not_open',
        'Este trabalho já foi fechado (status ' + current.status + ').', 409);
    }
    const job = shape(r.rows[0]);
    await this._audit('print_queue_error', job.id, job.taken_by, { note: job.error_note });
    return job;
  }

  /**
   * Cancela. Permitido pro admin (`is_admin`) ou pra quem pediu (`by` igual ao
   * requested_by). Só cancela o que ainda não saiu da impressora.
   */
  async cancel(id, by, opts = {}) {
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) throw new QueueError('bad_request', 'id inválido');
    const current = await this.get(jobId);
    if (!current) throw new QueueError('not_found', 'trabalho não existe: ' + jobId, 404);
    const who = textOf(by, 120);
    const mine = current.requested_by && who && current.requested_by === who;
    if (!opts.is_admin && !mine) {
      throw new QueueError('forbidden', 'Só quem pediu ou um admin pode cancelar.', 403);
    }
    if (current.status !== 'queued' && current.status !== 'taken') {
      throw new QueueError('not_open',
        'Este trabalho já foi fechado (status ' + current.status + ').', 409);
    }
    const r = await this.db.query(
      `UPDATE v3.print_queue SET status = 'cancelled', done_at = NOW()
        WHERE id = $1 AND status IN ('queued','taken')
        RETURNING ${SELECT_COLS}`, [jobId]);
    if (!r.rows[0]) throw new QueueError('not_open', 'Este trabalho já foi fechado.', 409);
    const job = shape(r.rows[0]);
    await this._audit('print_queue_cancelled', job.id, who, { was: current.status });
    return job;
  }
}

module.exports = { PrintQueueService, QueueError, KINDS, STATUSES, RETAKE_AFTER_MIN, shape };
