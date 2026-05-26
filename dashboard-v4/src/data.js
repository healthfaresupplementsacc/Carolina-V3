/* Mock data for the HealthFare production dashboard prototype.
   Times are minutes-from-midnight (NY).
   "Now" is anchored to a fictional 2:34 PM so the demo always has live events.
   Live events have ended_min === null (they extend to NOW).
*/

export const HFData = (() => {
  const DAY_START = 8 * 60;       // 8:00 AM
  const DAY_END   = 18 * 60;      // 6:00 PM
  // E7-refine3: NOW_MIN era 14:34 (mock "fictional 2:34 PM") e o helpers.js
  // capturava esse valor UMA vez como anchor → timeline mostrava "2:34 PM"
  // em vez do horário NY real. Agora liveNowMin() lê wall clock NY dinamicamente
  // — esse mock fica null pra não contaminar nada.
  const NOW_MIN     = null;
  // E7-refine2: DEADLINE_MIN — populado pelo adapter (1PM real do v3.deadlines).
  const DEADLINE_MIN = null;

  const operators = [
    { id: "vitor",    short: "VI", name: "Vitor",    role: "Linha de Produção",      en_role: "Production Line", c1: "#1e3f8c", c2: "#3fc874" },
    { id: "simone",   short: "SI", name: "Simone",   role: "Etiquetagem & P&P",      en_role: "Labeling & P&P",  c1: "#22b35d", c2: "#18934c" },
    { id: "ana",      short: "AN", name: "Ana",      role: "Revisão",                en_role: "Review",          c1: "#7c5cd6", c2: "#a98be8" },
    { id: "henrique", short: "HE", name: "Henrique", role: "Encapsulação",           en_role: "Encapsulation",   c1: "#2855ad", c2: "#4a74c2" },
    { id: "diego",    short: "DI", name: "Diego",    role: "Formulação & Mix",       en_role: "Mix & Formulation", c1: "#18934c", c2: "#22b35d" },
    { id: "carolina", short: "CA", name: "Carolina", role: "Inspeção QC",            en_role: "Quality Control", c1: "#1e3f8c", c2: "#22b35d" },
    { id: "maria",    short: "MA", name: "Maria",    role: "Empacotamento",          en_role: "Packaging",       c1: "#22b35d", c2: "#1e3f8c" },
    { id: "bruno",    short: "BR", name: "Bruno",    role: "Manutenção",             en_role: "Maintenance",     c1: "#d97706", c2: "#7c5cd6" },
  ];

  const products = {
    tribulus:    { name: "Tribulus Terrestris", batch: "BR-2026-0145", category: "Hormone Support" },
    nettle:      { name: "Stinging Nettle",     batch: "BR-2026-0157", category: "Detox" },
    bcomplex:    { name: "Vitamin B Complex",   batch: "BR-2026-0158", category: "Vitamins" },
    ashwa:       { name: "Ashwagandha",         batch: "BR-2026-0142", category: "Adaptogens" },
    turmeric:    { name: "Turmeric Curcumin",   batch: "BR-2026-0160", category: "Anti-inflammatory" },
    maca:        { name: "Maca Root",           batch: "BR-2026-0162", category: "Energy" },
  };

  const FLOWS = {
    production: { color: "var(--flow-prod)",    color2: "var(--flow-prod-2)",    label: "Produção",  en: "Production" },
    pnp:        { color: "var(--flow-pnp)",     color2: "var(--flow-pnp-2)",     label: "P&P",       en: "Pick & Pack" },
    support:    { color: "var(--flow-support)", color2: "var(--flow-support-2)", label: "Suporte",   en: "Support" },
  };

  // Activity catalog (pt / en / flow / icon)
  const activities = {
    linha:        { name: "Linha de Produção",  en: "Production Line",     flow: "production", expected: 90 },
    encaps:       { name: "Encapsulação",        en: "Encapsulation",       flow: "production", expected: 120 },
    mix:          { name: "Mix & Formulação",    en: "Mix & Formulation",   flow: "production", expected: 75 },
    revisao:      { name: "Revisão",             en: "Review",              flow: "production", expected: 60 },
    qc:           { name: "Inspeção QC",         en: "QC Inspection",       flow: "production", expected: 45 },
    impressao:    { name: "Impressão de Ordens", en: "Order Printing",      flow: "pnp",        expected: 25 },
    etiqueta:     { name: "Etiquetagem",         en: "Labeling",            flow: "pnp",        expected: 90 },
    pack:         { name: "Empacotamento",       en: "Packaging",           flow: "pnp",        expected: 120 },
    picking:      { name: "Picking",             en: "Picking",             flow: "pnp",        expected: 30 },
    limpeza:      { name: "Limpeza",             en: "Cleaning",            flow: "support",    expected: 25 },
    conserto:     { name: "Conserto",            en: "Repair",              flow: "support",    expected: 30 },
    almoco:       { name: "Almoço",              en: "Lunch",               flow: "support",    expected: 45 },
    organizacao:  { name: "Organização",         en: "Setup",               flow: "support",    expected: 20 },
  };

  // Events: per operator, time-ordered. ended === null = live.
  let _id = 100;
  const ev = (op, start, end, act, product, opts={}) => ({
    id: _id++,
    op, started_min: start, ended_min: end,
    activity: act, product: product || null,
    cowork: opts.cowork || [],
    qty: opts.qty || null, unit: opts.unit || null,
    description: opts.description || "",
    confidence: opts.confidence || "high",
    overrun: opts.overrun || false,
  });

  const events = [
    // VITOR — production line, currently live on Tribulus
    ev("vitor",    8*60+5,   8*60+35,  "organizacao", null),
    ev("vitor",    8*60+38,  9*60+58,  "encaps",      "tribulus"),
    ev("vitor",    10*60+5,  10*60+25, "limpeza",     null),
    ev("vitor",    10*60+30, 12*60+0,  "linha",       "tribulus", { cowork:["ana"], qty: 218, unit:"bottle" }),
    ev("vitor",    12*60+5,  12*60+45, "almoco",      null),
    ev("vitor",    12*60+50, null,     "linha",       "tribulus", { cowork:["ana"], qty: 250, unit:"bottle", confidence:"high" }),

    // SIMONE — P&P
    ev("simone",   8*60+10,  8*60+30,  "impressao",   null,        { qty: 468, unit:"order" }),
    ev("simone",   8*60+35,  9*60+55,  "etiqueta",    "bcomplex",  { cowork:["maria"] }),
    ev("simone",   10*60+5,  11*60+50, "etiqueta",    "ashwa"),
    ev("simone",   11*60+55, 12*60+35, "almoco",      null),
    ev("simone",   12*60+40, null,     "etiqueta",    "tribulus",  { cowork:["maria"], overrun:false }),

    // ANA — Review, coworking
    ev("ana",      8*60+15,  9*60+45,  "revisao",     "nettle"),
    ev("ana",      9*60+50,  10*60+5,  "limpeza",     null),
    ev("ana",      10*60+30, 12*60+0,  "linha",       "tribulus",  { cowork:["vitor"] }),
    ev("ana",      12*60+5,  12*60+50, "almoco",     null),
    ev("ana",      12*60+50, null,     "linha",       "tribulus",  { cowork:["vitor"] }),

    // HENRIQUE — encapsulation
    ev("henrique", 8*60+0,   9*60+45,  "encaps",      "ashwa",     { qty: 320, unit:"bottle" }),
    ev("henrique", 9*60+50,  10*60+10, "organizacao", null),
    ev("henrique", 10*60+15, 12*60+15, "encaps",      "turmeric",  { qty: 412, unit:"bottle" }),
    ev("henrique", 12*60+20, 13*60+0,  "almoco",      null),
    ev("henrique", 13*60+5,  null,     "encaps",      "maca",      { qty: 180, unit:"bottle", overrun: true }),

    // DIEGO — mix / formulation
    ev("diego",    8*60+20,  9*60+35,  "mix",         "turmeric"),
    ev("diego",    9*60+45,  10*60+5,  "limpeza",     null),
    ev("diego",    10*60+10, 11*60+55, "mix",         "maca"),
    ev("diego",    12*60+0,  12*60+45, "almoco",      null),
    ev("diego",    12*60+50, 14*60+10, "mix",         "nettle"),
    ev("diego",    14*60+15, null,     "organizacao", null),

    // CAROLINA — QC inspection
    ev("carolina", 8*60+30,  9*60+15,  "qc",          "bcomplex"),
    ev("carolina", 9*60+20,  10*60+45, "qc",          "ashwa"),
    ev("carolina", 10*60+50, 11*60+30, "revisao",     "turmeric"),
    ev("carolina", 11*60+35, 12*60+25, "almoco",      null),
    ev("carolina", 12*60+30, null,     "qc",          "tribulus",  { cowork:["maria"] }),

    // MARIA — Packaging
    ev("maria",    8*60+0,   8*60+35,  "picking",     null,        { qty: 124, unit:"order" }),
    ev("maria",    8*60+40,  10*60+0,  "etiqueta",    "bcomplex",  { cowork:["simone"] }),
    ev("maria",    10*60+5,  11*60+45, "pack",        "ashwa"),
    ev("maria",    11*60+50, 12*60+40, "almoco",      null),
    ev("maria",    12*60+45, null,     "pack",        "tribulus",  { cowork:["simone","carolina"] }),

    // BRUNO — Maintenance
    ev("bruno",    8*60+0,   8*60+45,  "organizacao", null),
    ev("bruno",    8*60+50,  10*60+5,  "conserto",    null,        { description:"Conserto encapsuladora Linha 2" }),
    ev("bruno",    10*60+10, 11*60+0,  "limpeza",     null),
    ev("bruno",    11*60+5,  12*60+10, "conserto",    null,        { description:"Calibração balança P&P" }),
    ev("bruno",    12*60+15, 13*60+0,  "almoco",      null),
    ev("bruno",    13*60+5,  14*60+25, "organizacao", null),
  ];

  // Goals for the day
  const goals = [
    { id: 1, product: "tribulus", target: 750, done: 218 + 250 /* in-flight estimate */, started_min: 10*60+30, unit: "bottle" },
    { id: 2, product: "ashwa",    target: 600, done: 612, started_min: 8*60, unit: "bottle", completed: true },
    { id: 3, product: "turmeric", target: 500, done: 412, started_min: 10*60+15, unit: "bottle" },
    { id: 4, product: "maca",     target: 400, done: 180, started_min: 13*60+5,  unit: "bottle" },
    { id: 5, product: "bcomplex", target: 300, done: 300, started_min: 8*60+35, unit: "bottle", completed: true },
  ];

  // Alerts
  const alerts = [
    { id: "a1", severity: "warn", title: "Duplicata suspeita", en: "Suspected duplicate", detail: "Tribulus · BR-2026-0145 · 250 garrafas reportadas 2x" },
    { id: "a2", severity: "bad",  title: "Maca Root em overrun", en: "Maca Root overrun",  detail: "Encapsulação passou 12min do esperado" },
    { id: "a3", severity: "warn", title: "Conserto pendente",   en: "Pending repair",     detail: "Balança P&P recalibrada, validar com QC" },
  ];

  // P&P block summary
  const pp = {
    total_minutes: 210,
    orders: 475,
    seconds_per_order: 26,
    deadline_min: DEADLINE_MIN,
  };

  return {
    DAY_START, DAY_END, NOW_MIN, DEADLINE_MIN,
    operators, products, activities, FLOWS,
    events, goals, alerts, pp,
  };
})();

if (typeof window !== 'undefined') window.HFData = HFData;
