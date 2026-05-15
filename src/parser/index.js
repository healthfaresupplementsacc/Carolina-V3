'use strict';
/**
 * Message parser for #orders-and-inventory
 * Supplement catalog: ONLY HealthFare products actually sold.
 */

const config = require('../config');

const BRUNO_ALLOWED_ACCOUNTS = [
  'U08JC85HMNE',
  'U07FG34TMPF',
  'U0AU8N8FA00',
];

const SUPPLEMENT_CATALOG = [
  // ── HEAFA-2000 Potassium Iodide ──────────────────────────────────────────
  { canonical: 'Potassium Iodide',        aliases: ['potassium iodide', 'iodide', 'iodeto', 'iodo de potassio', 'potassium iodide 130'] },
  // ── HEAFA-2001 / 2073 / 2079 Lithium Orotate ────────────────────────────
  { canonical: 'Lithium Orotate',         aliases: ['lithium', 'litio', 'litium', 'orotato de litio', 'lithium orotate', 'litio orotato'] },
  // ── HEAFA-2002 Benfotiamine ──────────────────────────────────────────────
  { canonical: 'Benfotiamine',            aliases: ['benfotiamina', 'benfo', 'benfotiamine'] },
  // ── HEAFA-2003 Pantothenic Acid ──────────────────────────────────────────
  { canonical: 'Pantothenic Acid',        aliases: ['pantotenico', 'pantotenic', 'pantothenic', 'b5', 'vit b5', 'vitamina b5', 'acido pantotenico'] },
  // ── HEAFA-2004 Valerian Root ─────────────────────────────────────────────
  { canonical: 'Valerian Root',           aliases: ['valerian', 'valeriana', 'valerian root'] },
  // ── HEAFA-2005 Hyaluronic Acid ───────────────────────────────────────────
  { canonical: 'Hyaluronic Acid',         aliases: ['hyaluronic', 'hialuronico', 'acido hialuronico', 'hyaluronic acid'] },
  // ── HEAFA-2006 White Kidney Bean ─────────────────────────────────────────
  { canonical: 'White Kidney Bean',       aliases: ['white kidney bean', 'kidney bean', 'feijao branco', 'kidney', 'white kidney'] },
  // ── HEAFA-2007 Ginger Root ───────────────────────────────────────────────
  { canonical: 'Ginger Root',             aliases: ['ginger', 'gengibre', 'ginger root', 'gengibre root'] },
  // ── HEAFA-2008 Vitamin B2 Riboflavin ─────────────────────────────────────
  { canonical: 'Vitamin B2',              aliases: ['vitamina b2', 'riboflavin', 'riboflavina', 'vit b2', 'b2', 'vitamin b2'] },
  // ── HEAFA-2009 Licorice Root ─────────────────────────────────────────────
  { canonical: 'Licorice Root',           aliases: ['licorice', 'alcacuz', 'licorice root', 'regaliz', 'glycyrrhiza'] },
  // ── HEAFA-2010 Activated Charcoal ────────────────────────────────────────
  { canonical: 'Activated Charcoal',      aliases: ['charcoal', 'carvao ativado', 'carvao', 'activated charcoal', 'carbon ativado'] },
  // ── HEAFA-2011 Aged Black Garlic ─────────────────────────────────────────
  { canonical: 'Aged Black Garlic',       aliases: ['aged black garlic', 'black garlic', 'alho negro', 'alho preto', 'garlic', 'alho'] },
  // ── HEAFA-2012 Pygeum ────────────────────────────────────────────────────
  { canonical: 'Pygeum',                  aliases: ['pygeum', 'pigeum', 'pygenum', 'pygeum africanum'] },
  // ── HEAFA-2015 Graviola Soursop ──────────────────────────────────────────
  { canonical: 'Graviola',                aliases: ['graviola', 'soursop', 'graviolla', 'graviol', 'graviola soursop'] },
  // ── HEAFA-2017 Myo Inositol ──────────────────────────────────────────────
  { canonical: 'Myo Inositol',            aliases: ['inositol', 'myo-inositol', 'mioinositol', 'myo inositol'] },
  // ── HEAFA-2018 Pine Bark ─────────────────────────────────────────────────
  { canonical: 'Pine Bark',               aliases: ['pine bark', 'french maritime', 'casca de pinho', 'pycnogenol', 'pine bark extract'] },
  // ── HEAFA-2019 / 2071 Stinging Nettle ────────────────────────────────────
  { canonical: 'Stinging Nettle',         aliases: ['nettle', 'urtiga', 'stinging nettle', 'nettle leaf', 'nettle root', 'stinging nettle root', 'stinging nettle leaf'] },
  // ── HEAFA-2020 Plant Sterols ─────────────────────────────────────────────
  { canonical: 'Plant Sterols',           aliases: ['plant sterols', 'plant sterol', 'sterols', 'esterois', 'fitosterois', 'phytosterols'] },
  // ── HEAFA-2021 Bitter Melon ──────────────────────────────────────────────
  { canonical: 'Bitter Melon',            aliases: ['bitter melon', 'melao amargo', 'karela', 'bitter melon extract'] },
  // ── HEAFA-2022 D-Aspartic Acid ───────────────────────────────────────────
  { canonical: 'D-Aspartic Acid',         aliases: ['d-aspartic', 'd aspartic', 'aspartic acid', 'acido aspartico', 'daa'] },
  // ── HEAFA-2023 Green Tea ─────────────────────────────────────────────────
  { canonical: 'Green Tea',               aliases: ['green tea', 'cha verde', 'te verde', 'egcg', 'green tea extract'] },
  // ── HEAFA-2024 Bilberry ──────────────────────────────────────────────────
  { canonical: 'Bilberry',                aliases: ['bilberry', 'bilbery', 'bilberry extract'] },
  // ── HEAFA-2025 Skullcap ──────────────────────────────────────────────────
  { canonical: 'Skullcap',                aliases: ['skullcap', 'skull cap', 'escutelaria', 'chinese skullcap'] },
  // ── HEAFA-2026 Butchers Broom ────────────────────────────────────────────
  { canonical: 'Butchers Broom',          aliases: ['butchers broom', 'vassoura de acougueiro', 'ruscus', 'butcher broom'] },
  // ── HEAFA-2027 Devils Claw ───────────────────────────────────────────────
  { canonical: 'Devils Claw',             aliases: ['devils claw', 'garra do diabo', 'harpagophytum', 'devil claw'] },
  // ── HEAFA-2028 Mullein Leaf ──────────────────────────────────────────────
  { canonical: 'Mullein Leaf',            aliases: ['mullein', 'mulein', 'verbasco', 'mullein leaf', 'mullein extract'] },
  // ── HEAFA-2030 He Shou Wu ────────────────────────────────────────────────
  { canonical: 'He Shou Wu',              aliases: ['he shou wu', 'fo-ti', 'fo ti', 'heshouwu', 'poligonum', 'fallopia multiflora'] },
  // ── HEAFA-2031 Chromium Picolinate ───────────────────────────────────────
  { canonical: 'Chromium Picolinate',     aliases: ['chromium', 'cromo', 'picolinato', 'chromium picolinate', 'picolinato de cromo'] },
  // ── HEAFA-2032 / 2081 Yohimbine HCL ─────────────────────────────────────
  { canonical: 'Yohimbine',               aliases: ['yohimbina', 'yohimbine', 'yohimbine hcl', 'yoimbina', 'iombina'] },
  // ── HEAFA-2033 / 2034 / 2078 / 2080 Melatonin ───────────────────────────
  { canonical: 'Melatonin',               aliases: ['melatonina', 'melatonin'] },
  // ── HEAFA-2035 Saw Palmetto ──────────────────────────────────────────────
  { canonical: 'Saw Palmetto',            aliases: ['saw palmetto', 'palmeto', 'sabal serrulata'] },
  // ── HEAFA-2036 / 2074 NAC ────────────────────────────────────────────────
  { canonical: 'NAC',                     aliases: ['nac', 'n-acetyl', 'n acetyl', 'n-acetil', 'acetil cisteina', 'cysteine', 'n-acetylcysteine', 'acetyl cysteine'] },
  // ── HEAFA-2037 L-Glutamine ───────────────────────────────────────────────
  { canonical: 'L-Glutamine',             aliases: ['glutamina', 'l-glutamine', 'glutamine', 'l glutamine'] },
  // ── HEAFA-2038 / 2039 Berberine ──────────────────────────────────────────
  { canonical: 'Berberine',               aliases: ['berberina', 'berberine', 'berberine ceylon', 'berberine cinnamon', 'berberin', 'berberine cinnamon ceylon'] },
  // ── HEAFA-2040 / 2041 Vitamin B1 Thiamine ────────────────────────────────
  { canonical: 'Vitamin B1',              aliases: ['vitamina b1', 'thiamine', 'tiamina', 'vit b1', 'b1', 'vitamin b1'] },
  // ── HEAFA-2042 Tribulus Terrestris ───────────────────────────────────────
  { canonical: 'Tribulus Terrestris',     aliases: ['tribulus', 'tribulo', 'tribulus terrestris', 'trib'] },
  // ── HEAFA-2043 Apple Cider Vinegar ───────────────────────────────────────
  { canonical: 'Apple Cider Vinegar',     aliases: ['apple cider vinegar', 'vinagre de maca', 'acv', 'vinagre', 'cider vinegar'] },
  // ── HEAFA-2044 / 2045 Folic Acid ─────────────────────────────────────────
  { canonical: 'Folic Acid',              aliases: ['acido folico', 'folic acid', 'folato', 'folate', 'folic', 'acido folico'] },
  // ── HEAFA-2046 Glutathione ───────────────────────────────────────────────
  { canonical: 'Glutathione',             aliases: ['glutationa', 'glutation', 'glutathione', 'glutation'] },
  // ── HEAFA-2047 Ginkgo Biloba ─────────────────────────────────────────────
  { canonical: 'Ginkgo Biloba',           aliases: ['ginkgo', 'ginkgo biloba', 'biloba', 'ginko'] },
  // ── HEAFA-2048 Aloe Vera ─────────────────────────────────────────────────
  { canonical: 'Aloe Vera',               aliases: ['aloe', 'aloe vera', 'babosa', 'gel de aloe'] },
  // ── HEAFA-2049 Rutin ─────────────────────────────────────────────────────
  { canonical: 'Rutin',                   aliases: ['rutin', 'rutim', 'rutina'] },
  // ── HEAFA-2050 Multi Collagen ────────────────────────────────────────────
  { canonical: 'Multi Collagen',          aliases: ['colageno', 'collagen', 'collagen peptides', 'multi collagen', 'collag'] },
  // ── HEAFA-2051 Panax Ginseng Ginkgo Biloba ───────────────────────────────
  { canonical: 'Ginseng Ginkgo',          aliases: ['ginseng', 'panax ginseng', 'ginseng ginkgo', 'panax ginseng ginkgo', 'ginseng e ginkgo'] },
  // ── HEAFA-2052 Fenugreek ─────────────────────────────────────────────────
  { canonical: 'Fenugreek',               aliases: ['fenugreco', 'fenugrek', 'fenugreek', 'fenugr', 'fenugreek seed', 'methi'] },
  // ── HEAFA-2053 Banaba Leaf ───────────────────────────────────────────────
  { canonical: 'Banaba Leaf',             aliases: ['banaba', 'banaba leaf', 'lagerstroemia'] },
  // ── HEAFA-2054 Psyllium Husk ─────────────────────────────────────────────
  { canonical: 'Psyllium Husk',           aliases: ['psyllium', 'psyllium husk', 'casca de psyllium', 'psilio', 'ispagula'] },
  // ── HEAFA-2055 Cayenne Pepper ────────────────────────────────────────────
  { canonical: 'Cayenne Pepper',          aliases: ['cayenne', 'pimenta caiena', 'cayenne pepper', 'capsaicina', 'capsaicin'] },
  // ── HEAFA-2056 Fadogia Agrestis ──────────────────────────────────────────
  { canonical: 'Fadogia Agrestis',        aliases: ['fadogia', 'fadogia agrestis'] },
  // ── HEAFA-2057 Akkermansia ───────────────────────────────────────────────
  { canonical: 'Akkermansia',             aliases: ['akkermansia', 'akkermansia muciniphila'] },
  // ── HEAFA-2058 Gymnema Sylvestre ─────────────────────────────────────────
  { canonical: 'Gymnema Sylvestre',       aliases: ['gymnema', 'gymnema sylvestre', 'gurmar'] },
  // ── HEAFA-2059 Hawthorn Berry ────────────────────────────────────────────
  { canonical: 'Hawthorn Berry',          aliases: ['hawthorn', 'hawthorn berry', 'espinheiro', 'cratego', 'crataegus'] },
  // ── HEAFA-2060 Magnesium Citrate ─────────────────────────────────────────
  { canonical: 'Magnesium Citrate',       aliases: ['magnesium citrate', 'citrato de magnesio', 'mag citrate', 'citrate', 'citrato'] },
  // ── HEAFA-2061 Chlorophyll ───────────────────────────────────────────────
  { canonical: 'Chlorophyll',             aliases: ['clorofila', 'chlorophyll', 'chlorophyl', 'clorofill'] },
  // ── HEAFA-2062 Magnesium Glycinate ───────────────────────────────────────
  { canonical: 'Magnesium Glycinate',     aliases: ['magnesium glycinate', 'glicinato', 'glycinate', 'mag glycinate', 'glycinote', 'glicinate', 'bisglicinato', 'bisglycinate'] },
  // ── HEAFA-2063 Rhodiola Rosea ────────────────────────────────────────────
  { canonical: 'Rhodiola',                aliases: ['rhodiola', 'rodiola', 'rhodiola rosea'] },
  // ── HEAFA-2065 Turkesterone Tongkat Ali ──────────────────────────────────
  { canonical: 'Turkesterone',            aliases: ['turkesterone', 'tongkat ali', 'turk', 'turkersterone', 'eurycoma'] },
  // ── HEAFA-2069 Magnesium (generic) ───────────────────────────────────────
  { canonical: 'Magnesium',               aliases: ['magnesio', 'magnesium', 'mag'] },
  // ── HEAFA-2070 NAD Supplement ────────────────────────────────────────────
  { canonical: 'NAD',                     aliases: ['nad', 'nad+', 'nmn', 'nicotinamide', 'nad supplement'] },
  // ── HEAFA-2072 Beet Root ─────────────────────────────────────────────────
  { canonical: 'Beet Root',               aliases: ['beet root', 'beterraba', 'beet', 'beetroot', 'red beet'] },
  // ── HEAFA-2077 Acetyl L-Carnitine ────────────────────────────────────────
  { canonical: 'Acetyl L-Carnitine',      aliases: ['acetyl l-carnitine', 'acetil carnitina', 'alcar', 'l-carnitine', 'carnitine', 'acetil l-carnitina'] },
];

const ALIAS_MAP = {};
SUPPLEMENT_CATALOG.forEach(({ canonical, aliases }) => {
  ALIAS_MAP[canonical.toLowerCase()] = canonical;
  aliases.forEach(a => { ALIAS_MAP[a.toLowerCase()] = canonical; });
});

let SUPPLEMENT_REGEX;
function buildSupplementRegex() {
  const patterns = [];
  SUPPLEMENT_CATALOG.forEach(({ canonical, aliases }) => {
    patterns.push(canonical, ...aliases);
  });
  patterns.sort((a, b) => b.length - a.length);
  SUPPLEMENT_REGEX = new RegExp(
    patterns.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i'
  );
}
buildSupplementRegex();

function addCustomSupplement(canonical, aliasesRaw) {
  const aliases = (aliasesRaw || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const lc = canonical.toLowerCase();
  const existing = SUPPLEMENT_CATALOG.find(s => s.canonical.toLowerCase() === lc);
  if (existing) {
    aliases.forEach(a => {
      if (!existing.aliases.includes(a)) {
        existing.aliases.push(a);
        ALIAS_MAP[a] = existing.canonical;
      }
    });
  } else {
    SUPPLEMENT_CATALOG.push({ canonical, aliases });
    ALIAS_MAP[lc] = canonical;
    aliases.forEach(a => { ALIAS_MAP[a] = canonical; });
  }
  buildSupplementRegex();
}

function listSupplements() {
  return SUPPLEMENT_CATALOG.map(s => ({ canonical: s.canonical, aliases: s.aliases.join(', ') }))
    .sort((a, b) => a.canonical.localeCompare(b.canonical));
}

const BATCH_REGEX = /\b(?:FO-\d{4,6}|\b\d{4}\b)/i;

const OPERATOR_PREFIX_REGEX = new RegExp(
  `^(${config.operators.join('|')})\\s*[-:]\\s*`,
  'i'
);

// Fix: properly group alternatives so |ordens? doesn't match everything
const ORDERS_START_REGEX = /(?:imprimindo|impressa[o]|come[c]ando|come[c]ou|iniciando|iniciou)(?:\s+a\s+impres[s]ao)?\s+(?:(?:das?|as|de)\s+)?(?:orders?|ordens?)/i;

const ORDERS_CONTINUE_PATTERNS = [
  /segunda\s+(?:impressa[o]|rodada|leva|batch)/i,
  /(?:mais\s+)?(?:uma\s+)?(?:rodada|leva)\s+de\s+(?:orders?|ordens?)/i,
  /imprimindo\s+(?:mais|segunda)/i,
];
const ORDERS_COUNT_REGEX = /[-]\s*(\d+)\s*$|(\d+)\s*ordens?\b/i;

const ORDERS_FINISH_PATTERNS = [
  // "ordens" anywhere followed by a finish word — covers "ordens da segunda impressao feitas"
  /\bordens?\b.*\b(?:feitas?|prontas?|impacotad[ao]s?|empacotad[ao]s?|empaquetad[ao]s?|finaliz\w+|conclu[ií]d[ao]s?|terminad[ao]s?|fechad[ao]s?)\b/i,
  /\bterminei\s+(?:as\s+)?ordens?/i,
  /\bacabei\s+(?:as\s+)?ordens?/i,
  /\bordens?\s*(?:ok|feito|done)\b/i,
  // F-tag with "ordens" anywhere — covers any separator (: ; / - whitespace)
  /^F[\s:;/\-]+\s*ordens?\b/i,
];

// Detects an F (finish) tag at the very start of the message.
// Used to disambiguate "F- ordens da segunda impressao feitas" (finish)
// from "Segunda impressao feita - 67" (orders_continue).
const HAS_FINISH_TAG_RE = /^F\s*[:;/\-\s]/i;

const FORMULATION_START_PATTERNS = [
  /\bformula[c][a]o\b/i,
  /\bformulac[ao]\b/i,
  /\bfazendo\s+(?:a\s+)?f[o]rmula/i,
  /\biniciand[oa]\s+(?:a\s+)?f[o]rmula/i,
  /\bpr[o]xim[ao]\s+f[o]rmula/i,
  /\bf[o]rmula\s+(?:do\s+)?pr[o]xim/i,
  /\bpara\s+c[a]psula/i,
  /\biniciado\s+para\s+c[a]psula/i,
  /\bc[a]psula\s+iniciand/i,
  /\bformulando\b/i,
  /\bformulaco\b/i,
];

const FORMULATION_FINISH_PATTERNS = [
  /\bf[o]rmula\s+(?:pronta|finaliz|terminad|conclu|ok|feita)/i,
  /\bterminei\s+(?:a\s+)?f[o]rmula/i,
  /\bfinaliz\w+\s+(?:a\s+)?f[o]rmula/i,
  /\bc[a]psula\s+(?:pronta|finalizad|terminad)/i,
];

// Legacy (kept for reference; replaced by detectTag below).
const TAG_PATTERNS = {
  start:  /^(?:S[:\-]|INICIO\s*:|INICIO\s*:)\s*/i,
  finish: /^(?:F[:\-]|FIM\s*:)\s*/i,
  count:  /^(?:P:|PRODU[C][A]O\s*:|PROD\s*:)\s*/i,
  note:   /^(?:N:|NOTA\s*:|OBS\s*:)\s*/i,
};

// ─── Tag detection (any separator, any position) ─────────────────────────────
// Accepts S/F/P/N tags with separators :, ;, /, -, or just whitespace.
// Position: start of message OR end of message (only S/F at end realistically).
// Isolation rule: the letter must be surrounded by separators/whitespace/boundaries,
// not inside a word like "Saw" or "Fenugreek".

const TAG_LETTER_TO_TYPE = { S: 'start', F: 'finish', P: 'count', N: 'note' };

// "S:", "S-", "S;", "S/" or "S " at the start (case-insensitive).
// Requires either a separator OR whitespace after the letter — bare "Sapo" is NOT a tag.
const TAG_START_LETTER_RE = /^([SFPN])(?:\s*[:;/\-]\s*|\s+)/i;

// Word forms at the start: "INICIO:", "FIM:", "PRODUCAO:", "PROD:", "NOTA:", "OBS:"
const TAG_START_WORD_RE = /^(INICIO|FIM|PRODU[CÇ][AÃ]O|PROD|NOTA|OBS)\s*:\s*/i;

// "...-S", "... S", "...;F", "... :F" — letter at end preceded by separator/space.
// Only S/F at end are recognized (P/N at end are too ambiguous).
const TAG_END_LETTER_RE = /(?:^|[\s:;/\-])([SF])\s*$/i;

function detectTag(text) {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  // Word form at start (INICIO/FIM/PRODUCAO/PROD/NOTA/OBS).
  let m = t.match(TAG_START_WORD_RE);
  if (m) {
    const word = m[1].toUpperCase();
    let type = null;
    if (/^PRODU/i.test(word) || word === 'PROD') type = 'count';
    else if (word === 'INICIO') type = 'start';
    else if (word === 'FIM') type = 'finish';
    else if (word === 'NOTA' || word === 'OBS') type = 'note';
    if (type) {
      return { tag: word, type, body: t.slice(m[0].length).trim(), position: 'start' };
    }
  }

  // Letter form at start.
  m = t.match(TAG_START_LETTER_RE);
  if (m) {
    const tag = m[1].toUpperCase();
    return {
      tag,
      type: TAG_LETTER_TO_TYPE[tag],
      body: t.slice(m[0].length).trim(),
      position: 'start',
    };
  }

  // Letter form at end (S or F).
  m = t.match(TAG_END_LETTER_RE);
  if (m) {
    const tag = m[1].toUpperCase();
    // Slice off the matched portion including the leading separator/space.
    // m.index points to the separator (or 0 if start-of-string).
    const cutAt = m.index === 0 ? 0 : m.index;
    const body = t.slice(0, cutAt).trim();
    if (!body) return null; // bare "S" alone — not actionable
    return {
      tag,
      type: TAG_LETTER_TO_TYPE[tag],
      body,
      position: 'end',
    };
  }

  return null;
}

const PAUSE_START_PATTERNS = [
  /\b(?:indo|vou|saindo)\s+(?:almo[c]ar|almo[c]o|comer|banheiro)\b/i,
  /\b(?:indo\s+ao\s+banheiro|ao\s+banheiro)\b/i,
  /\b(?:pausa|pausando|pause)\b/i,
  /\b(?:intervalo)\b/i,
  /\b(?:brb|ja\s+volto|volto\s+ja|volto\s+logo|volta\s+logo)\b/i,
  /\b(?:saindo\s+agora|vou\s+sair(?:\s+um\s+pouco)?)\b/i,
  /\b(?:indo\s+sair|saio\s+um\s+segundo)\b/i,
];

const PAUSE_END_PATTERNS = [
  /\b(?:voltei|de\s+volta|retornei|to\s+de\s+volta|estou\s+de\s+volta)\b/i,
  /\b(?:voltando|retornando)\s+(?:para\s+)?(?:a\s+)?(?:linha|trabalho|producao)\b/i,
  /\b(?:voltei\s+do\s+almo[c]o|voltei\s+do\s+banheiro)\b/i,
  /\bback\b/i,
];

const COMPOUND_NEXT_REGEX = /\b(?:estou\s+fazendo|to\s+fazendo|fazendo\s+agora|come[c]\w+|iniciand\w+|vou\s+(?:fazer|comecar))\s+(.+)/i;

const WRONG_CODE_REGEX = /\b(?:coloquei\s+a\s+inicial\s+errada|errei\s+o\s+c[o]digo|botei\s+(?:o\s+)?c[o]digo\s+errado|coloquei\s+errado|c[o]digo\s+errado|inicial\s+errada)\b/i;

const TASK_TYPE_PATTERNS = {
  limpeza:  /\blimpeza\b|\blimpando\b|\blimpar\b/i,
  revisao:  /\brevis[a]o\b|\brevisando\b|\brevisar\b/i,
  producao: /\blinha\s+de\s+produ[c][a]o\b/i,
  label:    /\blabel\b/i,
};

function extractTaskType(text) {
  if (TASK_TYPE_PATTERNS.limpeza.test(text))  return 'limpeza';
  if (TASK_TYPE_PATTERNS.revisao.test(text))  return 'revisao';
  if (TASK_TYPE_PATTERNS.producao.test(text)) return 'producao';
  if (TASK_TYPE_PATTERNS.label.test(text))    return 'label';
  return null;
}

const FREETEXT_START_PATTERNS = [
  /\b(?:iniciando|iniciou|come[c]ando|come[c]ou|vamos\s+come[c]ar|come[c]ar)\b/i,
  /\bira?\s+rodar\b/i,
  /\bja\s+(?:esta|esta)\s+rodando\b/i,
  /\bcome[c]amos?\b/i,
];

const FREETEXT_FINISH_PATTERNS = [
  /\b(?:finalizou|finalizado|finaliz(?:ando|ei|amos)|terminei|terminou|termina(?:ndo|mos)?)\b/i,
  /\b(?:pronto|conclu[i]do|conclu[i]mos|acabou|acabei)\b/i,
];

function resolveOperator(userId, userName, text, isSharedAccount, prefixOperator) {
  if (prefixOperator === undefined) prefixOperator = null;
  let operator = null;
  let remainingText = text.trim();

  const prefixMatch = remainingText.match(OPERATOR_PREFIX_REGEX);
  if (prefixMatch) {
    operator = capitalize(prefixMatch[1]);
    remainingText = remainingText.slice(prefixMatch[0].length).trim();
  } else if (!isSharedAccount) {
    operator = resolveNameFromUserId(userId, userName);
  } else if (prefixOperator) {
    operator = prefixOperator;
  }

  if (operator === 'Bruno' && !BRUNO_ALLOWED_ACCOUNTS.includes(userId)) {
    return { operator: null, remainingText, brunoBlocked: true };
  }

  return { operator, remainingText };
}

function resolveNameFromUserId(userId, userName) {
  const mapping = {
    'U08JC85HMNE': 'Vitor',
    'U07FG34TMPF': 'Simone',
  };
  if (mapping[userId]) return mapping[userId];
  if (userName) return capitalize(userName.split(' ')[0]);
  return null;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function extractSupplement(text) {
  const match = text.match(SUPPLEMENT_REGEX);
  return match ? normalizeSupplementName(match[0]) : null;
}

function extractBatch(text) {
  const match = text.match(BATCH_REGEX);
  return match ? match[0].toUpperCase() : null;
}

function normalizeSupplementName(name) {
  if (!name) return null;
  const canonical = ALIAS_MAP[name.toLowerCase().trim()];
  if (canonical) return canonical;
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function parseMessage(msg) {
  const { ts, user, text, username } = msg;
  if (!text || text.trim() === '') return null;

  const userId = user || '';
  const userName = username || '';
  const isShared = config.sharedAccounts.includes(userId);

  let cleanText = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();

  let workingText = cleanText;
  let prefixOperator = null;
  const opPrefixMatch = cleanText.match(OPERATOR_PREFIX_REGEX);
  if (opPrefixMatch) {
    prefixOperator = capitalize(opPrefixMatch[1]);
    workingText = cleanText.slice(opPrefixMatch[0].length).trim();
  }
  workingText = workingText.replace(/^bom\s*dia[,!.\s\n:)]*\s*/i, '').trim();

  // Production summary
  if (/produ[c][a]o\s+de\s+hoje|produ[c][a]o\s+do\s+dia/i.test(workingText)) {
    const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
    const items = [];
    const lineRe = /([A-Za-z][A-Za-z\s]*?)\s*[(](\d{4,6})[)]\s*[-]\s*(\d+)/g;
    let m;
    while ((m = lineRe.exec(cleanText)) !== null) {
      const rawName = m[1].trim().replace(/\s+/g, ' ');
      if (/producao|produ[c][a]o|hoje|do\s+dia/i.test(rawName)) continue;
      const supplement = normalizeSupplementName(rawName);
      const batch = m[2].trim();
      const count = parseInt(m[3], 10);
      if (count > 0) items.push({ supplement, batch, count });
    }
    const totalBottles = items.reduce((s, i) => s + (i.count || 0), 0);
    return { type: 'production_summary', operator, items, totalBottles, raw: text, ts };
  }

  // Orders continue: "segunda impressao feita" etc — must check BEFORE orders_start.
  // But skip if the message has an explicit F tag — that means orders_finish, not continue.
  const hasFinishTag = HAS_FINISH_TAG_RE.test(workingText);
  if (!hasFinishTag) {
    for (const pat of ORDERS_CONTINUE_PATTERNS) {
      if (pat.test(workingText)) {
        const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
        const countMatch = workingText.match(ORDERS_COUNT_REGEX);
        const orderCount = countMatch ? parseInt(countMatch[1] || countMatch[2]) : null;
        return { type: 'orders_continue', operator, orderCount, raw: text, ts };
      }
    }
  }

  // Orders start
  if (ORDERS_START_REGEX.test(workingText)) {
    const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
    const countMatch = workingText.match(ORDERS_COUNT_REGEX);
    const orderCount = countMatch ? parseInt(countMatch[1] || countMatch[2]) : null;
    return { type: 'orders_start', operator, orderCount, raw: text, ts };
  }

  // Orders finish
  for (const pattern of ORDERS_FINISH_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'orders_finish', operator, raw: text, ts };
    }
  }

  // Formulation start
  for (const pattern of FORMULATION_START_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'formulation_start', operator, supplement: extractSupplement(workingText), batch: extractBatch(workingText), description: workingText, raw: text, ts };
    }
  }

  // Formulation finish
  for (const pattern of FORMULATION_FINISH_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'formulation_finish', operator, supplement: extractSupplement(workingText), batch: extractBatch(workingText), description: workingText, raw: text, ts };
    }
  }

  // Pause end
  for (const pattern of PAUSE_END_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'pause_end', operator, raw: text, ts };
    }
  }

  // Pause start
  for (const pattern of PAUSE_START_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'pause_start', operator, raw: text, ts };
    }
  }

  // Tag detection: S/F/P/N with any separator (: ; / -) at start OR end of message.
  // Covers B1, B2, B3, B13 from Appendix B.
  const detected = detectTag(workingText);
  if (detected) {
    const { type, body, position } = detected;
    const resolved = resolveOperator(userId, userName, body, isShared, prefixOperator);
    if (resolved.brunoBlocked) return { type: 'ignore', raw: text, ts };
    const { operator, remainingText } = resolved;
    const searchText = remainingText || body;
    const supplement = extractSupplement(searchText);
    const batch = extractBatch(searchText);
    const bodyTaskType = extractTaskType(searchText);

    // "ordens" always wins over supplement extraction (B10 will refine further).
    if ((type === 'start' || type === 'finish') && /\bordens?\b/i.test(searchText)) {
      if (type === 'start') {
        const countMatch = searchText.match(ORDERS_COUNT_REGEX);
        return { type: 'orders_start', operator, orderCount: countMatch ? parseInt(countMatch[1] || countMatch[2]) : null, raw: text, ts };
      }
      return { type: 'orders_finish', operator, raw: text, ts };
    }

    if (type === 'count') {
      const countMatch = searchText.match(/(\d+)\s*(?:bottles?|potes?|unidades?|un\.?)?$/i)
        || searchText.match(/[-:]\s*(\d+)\s*$/);
      const count = countMatch ? parseInt(countMatch[1]) : null;
      return { type: 'count', operator, supplement, batch, count, raw: text, ts, needsOperatorClarification: isShared && !operator };
    }

    // End-position tag (e.g. "Green Tea-0098-S") requires usable body content.
    // Otherwise a stray "S" at end of casual text would falsely register a task.
    if (position === 'end' && !supplement && !batch && !bodyTaskType) {
      // Don't accept it — fall through to other heuristics.
    } else {
      return {
        type,
        operator,
        supplement,
        batch,
        taskType: type === 'start' ? bodyTaskType : null,
        description: body,
        raw: text,
        ts,
        freetext: position === 'end',
        needsOperatorClarification: isShared && !operator,
      };
    }
  }

  // Compound finish+start
  const hasFinishIndicator = /\b(?:terminei|acabei|finalizei|ja\s+terminei)\b/i.test(workingText);
  const hasWrongCode = WRONG_CODE_REGEX.test(workingText);
  const nextClauseMatch = workingText.match(COMPOUND_NEXT_REGEX);

  if (hasFinishIndicator && (hasWrongCode || nextClauseMatch)) {
    const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
    let nextSupplement = null, nextBatch = null;
    if (nextClauseMatch) {
      nextSupplement = extractSupplement(nextClauseMatch[1]);
      nextBatch = extractBatch(nextClauseMatch[1]);
    }
    return { type: 'finish', operator, supplement: null, batch: null, nextSupplement, nextBatch, description: workingText, raw: text, ts, freetext: true };
  }

  // Free-text start
  for (const pattern of FREETEXT_START_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'start', operator, supplement: extractSupplement(workingText), batch: extractBatch(workingText), taskType: extractTaskType(workingText), description: workingText, raw: text, ts, freetext: true, needsOperatorClarification: isShared && !operator };
    }
  }

  // Free-text finish
  for (const pattern of FREETEXT_FINISH_PATTERNS) {
    if (pattern.test(workingText)) {
      const { operator } = resolveOperator(userId, userName, workingText, isShared, prefixOperator);
      return { type: 'finish', operator, supplement: extractSupplement(workingText), batch: extractBatch(workingText), description: workingText, raw: text, ts, freetext: true, needsOperatorClarification: isShared && !operator };
    }
  }

  // Ignore short messages and known noise
  if (/estoque real/i.test(workingText) || /sequ[e]ncia/i.test(workingText) || workingText.length < 10) {
    return { type: 'ignore', raw: text, ts };
  }

  if (workingText.length === 0) {
    return { type: 'ignore', raw: text, ts };
  }

  return { type: 'unknown', raw: text, ts };
}

module.exports = { parseMessage, extractSupplement, extractBatch, extractTaskType, resolveOperator, addCustomSupplement, listSupplements };
