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

  return { phaseOfDay, greeting, clockStr, dateStr, initials, statusDot, ageBadge, operatorAccent, productAccent, ambientVars, mantra, MANTRAS, ACCENTS };
}));
