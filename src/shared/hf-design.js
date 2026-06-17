'use strict';
/* HealthFare Design helpers — UMD (browser window.HFDesign + node/jest export).
   Puro (sem efeitos), testável. Usado por /op (e reutilizável no admin). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HFDesign = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // fase do dia (hora local) → rótulo PT
  function phaseOfDay(date) {
    const h = (date || new Date()).getHours();
    if (h < 5) return 'madrugada';
    if (h < 12) return 'manhã';
    if (h < 18) return 'tarde';
    return 'noite';
  }
  // saudação de acordo com a fase
  function greeting(phase) {
    const p = typeof phase === 'string' ? phase : phaseOfDay(phase);
    return ({ 'madrugada': 'Boa madrugada', 'manhã': 'Bom dia', 'tarde': 'Boa tarde', 'noite': 'Boa noite' })[p] || 'Olá';
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function clockStr(date) { const d = date || new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function dateStr(date) {
    const d = date || new Date();
    const dias = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
    const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    return `${dias[d.getDay()]}, ${d.getDate()} de ${meses[d.getMonth()]}`;
  }
  // iniciais (até 2) de um nome
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  // cor de status do operador
  function statusDot(state) {
    return ({ busy: '#21a85b', occupied: '#21a85b', free: '#8195ab', idle: '#8195ab', lunch: '#d97712', off: '#8195ab' })[state] || '#8195ab';
  }
  // badge de idade da task: {text, color} — laranja após warnMin, vermelho após overMin
  function ageBadge(startedAt, now, opts) {
    const o = opts || {};
    const warn = o.warnMin || 120; const over = o.overMin || 240;
    const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
    const t = (now ? (now instanceof Date ? now.getTime() : Date.parse(now)) : Date.now());
    const min = Math.max(0, Math.floor((t - start) / 60000));
    let text; if (min < 1) text = 'agora'; else if (min < 60) text = 'há ' + min + 'min'; else { const h = Math.floor(min / 60); const m = min % 60; text = 'há ' + h + 'h' + (m ? ' ' + m + 'min' : ''); }
    let color = '#0e7a4e'; let level = 'ok';
    if (min >= over) { color = '#b3261e'; level = 'over'; } else if (min >= warn) { color = '#b35c00'; level = 'warn'; }
    return { text, color, minutes: min, level };
  }
  // hash determinístico → índice de paleta (accent por operador/produto)
  function _hash(str) { let h = 0; const s = String(str || ''); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }
  const ACCENTS = ['#0e7a4e', '#0f4c92', '#1b8f8f', '#2f7ae0', '#44ae4f', '#b35c00', '#1f5fd0'];
  function operatorAccent(idOrName) { return ACCENTS[_hash(idOrName) % ACCENTS.length]; }
  function productAccent(name) { return ACCENTS[_hash('p:' + name) % ACCENTS.length]; }

  // ambient CSS vars a partir do contexto (hora + nº tasks ativas)
  function ambientVars(date, activeTasks) {
    const h = (date || new Date()).getHours();
    // --day: 0 de madrugada, ~1 ao meio-dia, decai à noite
    const day = Math.max(0, Math.min(1, 1 - Math.abs(13 - h) / 13));
    const energy = Math.max(0, Math.min(1, (activeTasks || 0) / 5));
    return { '--day': day.toFixed(3), '--energy': energy.toFixed(3) };
  }

  // frases inspiradoras (pt/es/en) — só renderizadas se ligado nos settings
  const MANTRAS = {
    pt: ['Cada lote conta.', 'Capricho hoje, qualidade amanhã.', 'Trabalho seguro é trabalho bem feito.', 'Um passo de cada vez.', 'Atenção aos detalhes faz a diferença.', 'Equipe forte, produção forte.', 'Hoje melhor que ontem.'],
    es: ['Cada lote cuenta.', 'Esmero hoy, calidad mañana.', 'Trabajo seguro es trabajo bien hecho.', 'Un paso a la vez.', 'Los detalles marcan la diferencia.'],
    en: ['Every batch counts.', 'Care today, quality tomorrow.', 'Safe work is good work.', 'One step at a time.', 'Details make the difference.'],
  };
  function mantra(lang, i) {
    const arr = MANTRAS[lang] || MANTRAS.pt;
    return arr[(i == null ? 0 : i) % arr.length];
  }

  // ── ambient floaters (bottles + cápsulas à deriva no fundo) ──
  var BOTTLE_FILES = ['ashwagandha', 'benfotiamine', 'berberine', 'charcoal', 'chlorophyll', 'l-carnitine', 'nad', 'plant-sterols', 'rutin', 'white-kidney'];
  // 22 floaters curados (x/y % espalhados, drift/duração variados, opacidade baixa).
  // kind 'b' = bottle (usa BOTTLE_FILES[i]), 'c' = cápsula (CSS). count fatia por densidade.
  var FLOATERS = [
    { k: 'b', b: 0, x: 6, y: 12, s: 74, d: 'driftA', t: 15, dl: 0, o: 0.15 },
    { k: 'c', x: 20, y: 64, s: 30, d: 'driftC', t: 12, dl: 1, o: 0.16, r: 40 },
    { k: 'b', b: 1, x: 83, y: 18, s: 60, d: 'driftB', t: 17, dl: 2, o: 0.14 },
    { k: 'c', x: 70, y: 40, s: 24, d: 'driftD', t: 13, dl: 0.5, o: 0.18, r: -25 },
    { k: 'b', b: 2, x: 46, y: 78, s: 66, d: 'driftC', t: 18, dl: 1.5, o: 0.13 },
    { k: 'c', x: 12, y: 38, s: 26, d: 'driftB', t: 14, dl: 2.5, o: 0.15, r: 70 },
    { k: 'b', b: 3, x: 90, y: 68, s: 56, d: 'driftA', t: 16, dl: 0.8, o: 0.14 },
    { k: 'c', x: 56, y: 14, s: 22, d: 'driftD', t: 12, dl: 3, o: 0.17, r: 10 },
    { k: 'b', b: 4, x: 30, y: 28, s: 50, d: 'driftB', t: 19, dl: 1.2, o: 0.12 },
    { k: 'c', x: 78, y: 84, s: 28, d: 'driftA', t: 13, dl: 2, o: 0.16, r: -50 },
    { k: 'b', b: 5, x: 60, y: 58, s: 62, d: 'driftC', t: 15, dl: 0.3, o: 0.13 },
    { k: 'c', x: 38, y: 48, s: 24, d: 'driftB', t: 14, dl: 1.8, o: 0.15, r: 30 },
    { k: 'b', b: 6, x: 16, y: 86, s: 58, d: 'driftD', t: 17, dl: 2.2, o: 0.12 },
    { k: 'c', x: 92, y: 44, s: 26, d: 'driftC', t: 12, dl: 0.6, o: 0.17, r: -15 },
    { k: 'b', b: 7, x: 72, y: 8, s: 52, d: 'driftA', t: 18, dl: 1.4, o: 0.13 },
    { k: 'c', x: 4, y: 60, s: 22, d: 'driftD', t: 13, dl: 2.8, o: 0.16, r: 55 },
    { k: 'b', b: 8, x: 50, y: 36, s: 48, d: 'driftB', t: 16, dl: 0.9, o: 0.12 },
    { k: 'c', x: 86, y: 28, s: 28, d: 'driftC', t: 14, dl: 1.6, o: 0.15, r: -40 },
    { k: 'b', b: 9, x: 24, y: 6, s: 54, d: 'driftA', t: 19, dl: 2.4, o: 0.12 },
    { k: 'c', x: 64, y: 90, s: 24, d: 'driftB', t: 12, dl: 0.4, o: 0.17, r: 20 },
    { k: 'b', b: 0, x: 40, y: 66, s: 46, d: 'driftD', t: 17, dl: 1.1, o: 0.11 },
    { k: 'c', x: 8, y: 84, s: 26, d: 'driftC', t: 13, dl: 3.2, o: 0.15, r: -60 },
  ];
  function floaters(count) { var n = Math.max(0, Math.min(FLOATERS.length, count || 14)); return FLOATERS.slice(0, n); }

  return { phaseOfDay, greeting, clockStr, dateStr, initials, statusDot, ageBadge, operatorAccent, productAccent, ambientVars, mantra, MANTRAS, ACCENTS, floaters, BOTTLE_FILES };
}));
