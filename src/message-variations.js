'use strict';
/**
 * BLOCO B / C5 — editable message variations.
 *
 * Each variation SET has a stable `type` key, a PT label, the
 * placeholders its templates accept, and the code DEFAULTS (the arrays
 * that used to live inline in announce.js / scheduler.js / tasks.js).
 *
 * resolveTemplates(type) returns the active rows from message_variations
 * for that type; if the table has none for that type (or the read
 * fails), the code DEFAULTS are returned → behaviour is identical to
 * before this commit. That fallback + the pre-bloco-B snapshot are the
 * safety net for this high-risk refactor.
 *
 * Placeholders use {brace} syntax; render() substitutes them. Unknown
 * placeholders are left untouched.
 */
const db = require('./db');

const VARIATION_SETS = {
  greeting: {
    label: 'Saudação de manhã',
    placeholders: [],
    example: {},
    defaults: [
      'Bom dia, time! Bora começar o dia. Qualquer coisa é só marcar por aqui.',
      'Bom dia! Novo dia, novo lote, vamo que vamo.',
      'Oi gente, bom dia! Tô por aqui acompanhando, manda ver.',
      'Bom dia, pessoal! Lembrem de marcar início e fim das tarefas.',
      'Bom diaa! Dia produtivo pra todo mundo, conta comigo.',
    ],
  },
  note: {
    label: 'Anúncio de nota',
    placeholders: ['op', 'texto'],
    example: { op: 'Ana', texto: 'faltou tampa no lote 0098' },
    defaults: [
      '📝 {op} anotou: {texto}',
      '📝 anotação de {op}: {texto}',
      '📝 {op} deixou registrado: {texto}',
      '📝 observação do {op}: {texto}',
      '📝 {op} apontou aqui: {texto}',
      '📝 nota do {op}, {texto}',
      '📝 {op} quis registrar: {texto}',
      '📝 fica anotado ({op}): {texto}',
      '📝 {op} mandou anotar: {texto}',
      '📝 registrando o que {op} falou: {texto}',
      '📝 {op} avisou: {texto}',
      '📝 anotei pro {op}: {texto}',
      '📝 {op} deixou recado: {texto}',
      '📝 ó, {op} anotou: {texto}',
      '📝 {op} pediu pra registrar: {texto}',
      '📝 nota rápida do {op}: {texto}',
      '📝 {op} reportou: {texto}',
      '📝 anotação na conta do {op}: {texto}',
      '📝 {op} sinalizou: {texto}',
      '📝 guardando aqui ({op}): {texto}',
    ],
  },
  voltei: {
    label: 'Pergunta de volta sem break',
    placeholders: ['nome'],
    example: { nome: 'Bruno' },
    defaults: [
      '{nome}, vc voltou mas eu não vi vc sair, que horas vc saiu mesmo?',
      'oi {nome}, não registrei sua saída. que horas vc parou pro break?',
      '{nome} que horas vc tinha saído? não peguei o início do break',
      '{nome}, cadê o horário que vc saiu? não vi vc ir',
      '{nome} me ajuda: que horas começou seu break? não tinha registro',
      'ué {nome}, não vi vc sair. que horas foi?',
      '{nome}, faltou o início do seu break, que horas vc saiu?',
      '{nome} que horas vc saiu pro break? não tinha anotado',
      'oi {nome}, voltou de onde? não registrei a saída, que horas foi?',
      '{nome}, me diz a que horas vc saiu que eu acerto aqui',
      '{nome} não peguei vc saindo. qual foi o horário do break?',
      '{nome}, que horas vc tinha parado? preciso pro registro',
      'eita {nome}, sumiu e voltou, que horas vc saiu?',
      '{nome} qual horário vc saiu pro intervalo? não tinha aqui',
      '{nome}, sem registro da saída. me passa o horário que vc parou',
      '{nome} voltou! mas que horas vc tinha saído mesmo?',
      'oi {nome}, que horas começou o break? não vi vc sair',
      '{nome}, preciso do horário que vc saiu, não foi registrado',
      '{nome} me fala que horas vc parou que eu ajusto',
      '{nome}, não vi vc saindo. a que horas foi o break?',
    ],
  },
  break_time_retry: {
    label: 'Re-pergunta de horário do break',
    placeholders: ['nome'],
    example: { nome: 'Bruno' },
    defaults: [
      '{nome}, não entendi 😅 tenta no formato HH:MM, tipo 14:30',
      '{nome} esse horário não deu pra ler, manda assim: 14:30',
      'hmm {nome}, não consegui entender. que horas? ex: 13:05',
      '{nome}, me manda só o horário tipo 15:40',
      'não peguei {nome}, formato HH:MM por favor (ex 14h30)',
      '{nome} tenta de novo: que horas vc saiu? tipo 12:15',
      '{nome}, preciso no formato hora:minuto, ex 16:00',
      'não rolou {nome} 😬 manda o horário tipo 14:30',
      '{nome} qual horário mesmo? escreve assim: 09:45',
      '{nome}, só o horário por favor, exemplo: 17:20',
    ],
  },
  conflict: {
    label: 'Pergunta de conflito (join)',
    placeholders: ['nome', 'parceiro', 'supp'],
    example: { nome: 'Ana,', parceiro: 'Vitor', supp: 'Green Tea' },
    defaults: [
      '{nome}, você está trabalhando com {parceiro} no {supp}?',
      '{nome}, vai ajudar {parceiro} com o {supp}?',
      '{nome}, está junto com {parceiro} no {supp}?',
      '{nome}, você se juntou a {parceiro} no {supp}?',
      '{nome}, trabalho conjunto com {parceiro} no {supp}?',
      '{nome}, está na mesma linha que {parceiro}, {supp}?',
      '{nome}, vai trabalhar com {parceiro} no {supp}?',
      '{nome}, confirmando, você está com {parceiro} no {supp}?',
      '{nome}, você entrou no {supp} junto com {parceiro}?',
      '{nome}, está colaborando com {parceiro} no {supp}?',
    ],
  },
};

/** Substitute {placeholder} tokens. Unknown tokens are left as-is. */
function render(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) =>
    (vars[k] !== undefined && vars[k] !== null) ? String(vars[k]) : m);
}

/**
 * Active templates for a type: DB rows when present, else the code
 * DEFAULTS (also the fallback when the DB read throws).
 */
async function resolveTemplates(type) {
  const reg = VARIATION_SETS[type];
  if (!reg) return [];
  try {
    const r = await db.query(
      `SELECT template FROM message_variations
       WHERE type = $1 AND active = TRUE
       ORDER BY position ASC, id ASC`,
      [type]
    );
    if (r.rows.length > 0) return r.rows.map((x) => x.template);
  } catch (_) { /* fall through to code defaults */ }
  return reg.defaults.slice();
}

// Avoid repeating the same variation twice in a row (per type), matching
// the old inline _lastIdx behaviour.
const _lastIdx = {};
async function pick(type, vars = {}) {
  const list = await resolveTemplates(type);
  if (list.length === 0) return '';
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && i === _lastIdx[type]) i = (i + 1) % list.length;
  _lastIdx[type] = i;
  return render(list[i], vars);
}

/** Boot-time: seed code DEFAULTS for any type that has no rows yet. */
async function seedDefaults() {
  for (const [type, reg] of Object.entries(VARIATION_SETS)) {
    try {
      const c = await db.query(
        'SELECT COUNT(*)::int AS n FROM message_variations WHERE type = $1',
        [type]
      );
      if (c.rows[0] && c.rows[0].n > 0) continue;
      for (let i = 0; i < reg.defaults.length; i++) {
        await db.query(
          `INSERT INTO message_variations (type, template, position, active)
           VALUES ($1, $2, $3, TRUE)`,
          [type, reg.defaults[i], i]
        );
      }
      console.log(`[MsgVar] seeded ${reg.defaults.length} default(s) for '${type}'`);
    } catch (e) {
      console.error(`[MsgVar] seed failed for '${type}':`, e.message);
    }
  }
}

// ---- CRUD used by the admin API ----
async function list(type) {
  const r = await db.query(
    `SELECT id, type, template, position, active
     FROM message_variations WHERE type = $1
     ORDER BY position ASC, id ASC`,
    [type]
  );
  return r.rows;
}

async function create(type, template) {
  const p = await db.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM message_variations WHERE type = $1',
    [type]
  );
  const r = await db.query(
    `INSERT INTO message_variations (type, template, position, active)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id, type, template, position, active`,
    [type, template, p.rows[0].pos]
  );
  return r.rows[0];
}

async function getById(id) {
  const r = await db.query('SELECT * FROM message_variations WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function update(id, fields) {
  const sets = []; const params = [];
  if (fields.template !== undefined) { sets.push(`template = $${params.length + 1}`); params.push(String(fields.template)); }
  if (fields.active   !== undefined) { sets.push(`active = $${params.length + 1}`);   params.push(!!fields.active); }
  if (fields.position !== undefined) { sets.push(`position = $${params.length + 1}`); params.push(parseInt(fields.position) || 0); }
  if (sets.length === 0) return getById(id);
  params.push(id);
  const r = await db.query(
    `UPDATE message_variations SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING id, type, template, position, active`,
    params
  );
  return r.rows[0] || null;
}

async function remove(id) {
  await db.query('DELETE FROM message_variations WHERE id = $1', [id]);
}

function listTypes() {
  return Object.entries(VARIATION_SETS).map(([type, r]) => ({
    type, label: r.label, placeholders: r.placeholders,
    example: r.example, default_count: r.defaults.length,
  }));
}

module.exports = {
  VARIATION_SETS, render, resolveTemplates, pick, seedDefaults,
  list, create, getById, update, remove, listTypes,
};
