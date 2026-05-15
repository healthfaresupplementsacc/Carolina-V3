'use strict';
/**
 * Scan the last 30 days of messages for words the team uses that DON'T
 * match the current supplement catalog. Outputs candidates for new aliases.
 *
 * Heuristics:
 *  - Look only at messages parsed as start/finish/count/orders_xxx/freetext/unknown
 *    (where a supplement should plausibly appear).
 *  - Tokenize the text into words of 4+ letters.
 *  - Drop stop-words: tag letters (S/F/P/N), portuguese conjunctions,
 *    operator names, verbs/adverbs operators use a lot, batch numbers,
 *    timestamps, slack mentions.
 *  - For each remaining token, check if it's matched by SUPPLEMENT_REGEX or
 *    is an existing alias. If not, count occurrences.
 *  - Show tokens that appear >= 3 times with example sentences.
 */

const { Pool } = require('pg');
const parser = require('../src/parser');

const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Build alias map from the parser (canonical + every alias, lowercase)
function buildKnownTerms() {
  const known = new Set();
  for (const s of parser.listSupplements()) {
    known.add(s.canonical.toLowerCase());
    for (const a of (s.aliases || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      known.add(a);
      // also single-word components of multi-word aliases
      for (const w of a.split(/\s+/)) if (w.length >= 4) known.add(w);
    }
    for (const w of s.canonical.toLowerCase().split(/\s+/)) if (w.length >= 4) known.add(w);
  }
  return known;
}

// Words we know are not supplement names. Lowercase.
const STOP_WORDS = new Set([
  // operator names + aliases
  'ana','bruno','vitor','simone','aninha','bru','carolina','health','healthfare',
  // tag-letter expansions / common verbs
  'iniciei','iniciou','iniciando','comecei','comecou','comecando','rodando','rodar',
  'terminei','terminou','terminado','acabei','acabou','finalizei','finalizado',
  'pronto','feito','feita','fechado','fechei','encerrei','encerrado',
  'fazendo','fazer','vou','indo','saindo','voltei','volto','volta','voltando',
  'pausa','pausando','almoco','almoço','almocando','almoçando','almocar','almoçar',
  'banheiro','intervalo','volta','pause',
  // articles / connectors PT
  'das','dos','com','sem','para','pelo','pela','sobre','depois','antes','agora',
  'esta','está','estão','estao','este','esse','essa','aquele','aquela',
  'ainda','tudo','todo','toda','todas','todos','outro','outra','outros','outras',
  'aqui','ali','muito','muita','pouco','pouca','tambem','também','tambm',
  'pode','poder','podia','quer','quero','queria','vai','vamos','vinha',
  // common conjunctions and prepositions
  'mas','por','que','quando','como','onde','porque','porqu','entao','então',
  // work context
  'producao','produção','revisao','revisão','limpeza','formula','formulacao','formulação',
  'ordens','ordem','impressao','impressão','segunda','primeira','manha','manhã','tarde',
  'capsulas','cápsulas','capsula','cápsula','frasco','frascos','potes','pote',
  'maquina','máquina','maquinario','maquinário','linha','envio','envios','envelope',
  'envelopes','etiqueta','etiquetas','label','labels','caixas','caixa','envasamento',
  'embalagem','rotulagem','retirada','separacao','separação','impacotei','empacotei','empacotou',
  // slack noise
  'bom','dia','boa','tarde','noite','olá','ola','tchau','obrigado','obrigada',
  // batch numbers happen separately
]);

const TOKEN_RE = /[a-záâãàéêíóôõúçñA-ZÁÂÃÀÉÊÍÓÔÕÚÇÑ]{4,}/g;

(async () => {
  const known = buildKnownTerms();
  console.log(`Known terms in catalog: ${known.size} (single-word + full aliases)`);

  // Pull last 30 days of messages where a supplement is plausible.
  const r = await p.query(
    `SELECT slack_ts, text, parsed_type
     FROM messages
     WHERE created_at >= NOW() - INTERVAL '30 days'
       AND text IS NOT NULL
       AND parsed_type IN ('start','finish','count','orders_start','orders_finish','formulation_start','formulation_finish','unknown')
     ORDER BY slack_ts DESC`
  );
  console.log(`Messages scanned: ${r.rows.length}`);

  const counts = new Map();   // tokenLower → { count, examples: Set<text> }

  for (const row of r.rows) {
    const text = row.text || '';
    const tokens = text.match(TOKEN_RE) || [];
    const seenInThisMsg = new Set();

    for (const raw of tokens) {
      const tok = raw.toLowerCase();
      if (seenInThisMsg.has(tok)) continue;
      seenInThisMsg.add(tok);

      if (tok.length < 4) continue;
      if (/^\d/.test(tok)) continue;
      if (STOP_WORDS.has(tok)) continue;
      if (known.has(tok)) continue;

      // Skip if it matches the multi-word supplement regex as part of a longer phrase
      // (only single-word check above already handled). Also skip if extractSupplement
      // on this token alone finds a match.
      if (parser.extractSupplement(tok)) continue;

      // Skip very common slack lingo not in stop words
      if (/^(http|www|gmail|com)$/i.test(tok)) continue;

      const entry = counts.get(tok) || { count: 0, examples: new Set() };
      entry.count++;
      if (entry.examples.size < 3) {
        entry.examples.add(text.slice(0, 100));
      }
      counts.set(tok, entry);
    }
  }

  // Sort and report tokens with >= 3 occurrences
  const ranked = [...counts.entries()]
    .filter(([_, v]) => v.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 60);

  console.log(`\nCandidates (>= 3 uses, not in catalog, not stop-words):\n`);
  for (const [tok, v] of ranked) {
    console.log(`  [${String(v.count).padStart(3, ' ')}x] ${tok}`);
    for (const ex of v.examples) console.log(`         ↳ ${ex}`);
  }

  await p.end();
})().catch((err) => {
  console.error('FATAL:', err.message);
  p.end().catch(() => {});
  process.exit(1);
});
