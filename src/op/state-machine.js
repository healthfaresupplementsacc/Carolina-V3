'use strict';
/**
 * HEALTHFARE — Operator Page: máquina de estados PURA da UI.
 * UMD: usada pelo app.js no browser E testada no jest (node).
 *
 * Estados:
 *   LOGGED_OUT       teclado PIN
 *   IDLE             minhas tasks + tasks da equipe + iniciar nova
 *   PICK_GROUP       modal: grupos de atividade
 *   PICK_TYPE        modal: tipos do grupo
 *   PICK_SUPPLEMENT  autocomplete (só se type.requires_product)
 *   PICK_BATCH       lote (4 dígitos ou recentes)
 *   CONFIRM          resumo + cowork A + nota/voz
 *   CLOCK_OUT        modal bottle counts (P5)
 *
 * transition(state, event, payload) → { state, draft } — sem efeitos.
 * draft = { group, type, supplement, batch, cowork, note }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HFStateMachine = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const INITIAL = 'LOGGED_OUT';
  const emptyDraft = () => ({ group: null, type: null, supplement: null, batch: null, cowork: [], note: '' });

  /**
   * @param {string} state   estado atual
   * @param {string} event   LOGIN_OK | LOGOUT | AUTO_TIMEOUT | START_NEW |
   *                         PICK_GROUP | PICK_TYPE | PICK_SUPPLEMENT |
   *                         PICK_BATCH | SKIP_BATCH | BACK | CANCEL |
   *                         CONFIRM_OK | OPEN_CLOCK_OUT | CLOCK_OUT_DONE
   * @param {object} ctx     { draft } (imutável — retorna novo)
   * @param {*} payload
   */
  function transition(state, event, ctx, payload) {
    const draft = (ctx && ctx.draft) ? ctx.draft : emptyDraft();

    // globais: qualquer estado
    if (event === 'AUTO_TIMEOUT' || event === 'LOGOUT') return { state: 'LOGGED_OUT', draft: emptyDraft() };
    if (event === 'CANCEL' && state !== 'LOGGED_OUT') return { state: 'IDLE', draft: emptyDraft() };

    switch (state) {
      case 'LOGGED_OUT':
        if (event === 'LOGIN_OK') return { state: 'IDLE', draft: emptyDraft() };
        break;

      case 'IDLE':
        if (event === 'START_NEW') return { state: 'PICK_GROUP', draft: emptyDraft() };
        if (event === 'OPEN_CLOCK_OUT') return { state: 'CLOCK_OUT', draft };
        break;

      case 'PICK_GROUP':
        if (event === 'PICK_GROUP') return { state: 'PICK_TYPE', draft: { ...draft, group: payload } };
        if (event === 'BACK') return { state: 'IDLE', draft: emptyDraft() };
        break;

      case 'PICK_TYPE':
        if (event === 'PICK_TYPE') {
          const next = payload && payload.requires_product ? 'PICK_SUPPLEMENT' : 'CONFIRM';
          return { state: next, draft: { ...draft, type: payload } };
        }
        if (event === 'BACK') return { state: 'PICK_GROUP', draft: { ...draft, group: null } };
        break;

      case 'PICK_SUPPLEMENT':
        if (event === 'PICK_SUPPLEMENT') return { state: 'PICK_BATCH', draft: { ...draft, supplement: payload } };
        if (event === 'BACK') return { state: 'PICK_TYPE', draft: { ...draft, type: null } };
        break;

      case 'PICK_BATCH':
        if (event === 'PICK_BATCH') return { state: 'CONFIRM', draft: { ...draft, batch: payload } };
        if (event === 'SKIP_BATCH') return { state: 'CONFIRM', draft: { ...draft, batch: null } };
        if (event === 'BACK') return { state: 'PICK_SUPPLEMENT', draft: { ...draft, supplement: null } };
        break;

      case 'CONFIRM':
        if (event === 'CONFIRM_OK') return { state: 'IDLE', draft: emptyDraft() };
        if (event === 'BACK') {
          if (draft.type && draft.type.requires_product) return { state: 'PICK_BATCH', draft: { ...draft, batch: null } };
          return { state: 'PICK_TYPE', draft: { ...draft, type: null } };
        }
        break;

      case 'CLOCK_OUT':
        if (event === 'CLOCK_OUT_DONE') return { state: 'LOGGED_OUT', draft: emptyDraft() };
        if (event === 'BACK') return { state: 'IDLE', draft };
        break;

      default:
        break;
    }
    return { state, draft }; // evento irrelevante: não muda nada
  }

  /** Normaliza pra busca: minúsculo, sem acento. */
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /**
   * Autocomplete local de supplements (substitui Fuse.js — npm indisponível;
   * substring com normalização + ranking por uso recente cobre o caso).
   * @param {Array} list  [{id, canonical_name, aliases[], last_used_at}]
   * @param {string} query
   * @returns top 20
   */
  function searchSupplements(list, query) {
    const q = norm(query).trim();
    const scored = [];
    for (const p of list || []) {
      const name = norm(p.canonical_name);
      const aliases = (p.aliases || []).map(norm);
      let score = -1;
      if (!q) score = 0;
      else if (name.startsWith(q)) score = 3;
      else if (name.includes(q)) score = 2;
      else if (aliases.some((a) => a.startsWith(q))) score = 2;
      else if (aliases.some((a) => a.includes(q))) score = 1;
      if (score >= 0) scored.push({ p, score, used: p.last_used_at ? Date.parse(p.last_used_at) : 0 });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.used - a.used) || norm(a.p.canonical_name).localeCompare(norm(b.p.canonical_name)));
    return scored.slice(0, 20).map((x) => x.p);
  }

  return { INITIAL, transition, emptyDraft, searchSupplements, norm };
}));
