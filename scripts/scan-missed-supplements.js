'use strict';
/**
 * More focused alias scan. Strategy:
 *   - Pull messages parsed as 'start'/'finish' in the last 30 days.
 *   - Re-run parseMessage on each (no DB writes, just inspection).
 *   - Filter to messages where the parser DETECTED a tag (S/F) but
 *     extractSupplement returned null.
 *   - For each such message, isolate the "supplement-candidate" tokens —
 *     the words between the tag and the batch number (or end of line).
 *   - Group by token, rank by frequency, show examples.
 */

const { Pool } = require('pg');
const parser = require('../src/parser');

const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const STOP_WORDS = new Set([
  'ana','bruno','vitor','simone','aninha','bru',
  'iniciei','iniciou','iniciando','comecei','comecou','comecando','rodando','rodar','rodou',
  'terminei','terminou','terminado','acabei','acabou','finalizei','finalizado','finalizei',
  'pronto','feito','feita','feitos','feitas','fechado','fechei','encerrei','encerrado',
  'fazendo','fazer','vou','indo','saindo','voltei','volto','volta','voltando',
  'pausa','pausando','almoco','almoço','almocar','almoçar','banheiro','intervalo',
  'das','dos','com','sem','para','pelo','pela','sobre','depois','antes','agora',
  'esta','está','este','esse','essa','ainda','tudo','todo','outras','outros',
  'aqui','também','tambem','muito','muita','pouco','pouca','quando','como','onde',
  'producao','produção','revisao','revisão','limpeza','formula','formulacao','formulação',
  'ordens','ordem','impressao','impressão','segunda','primeira','manha','manhã','tarde',
  'capsulas','cápsulas','capsula','cápsula','frasco','frascos','potes','pote',
  'maquina','máquina','maquinario','maquinário','linha','envio','envios','envelope','envelopes',
  'etiqueta','etiquetas','label','labels','caixas','caixa','embalagem',
  'bom','dia','boa','tarde','obrigado','obrigada','minha','meus','sua','seu',
  'mais','menos','nada','algo','outro','outra','ate','até','desde',
  'colocando','colocar','colocado','colocou','tirando','tirar','tirado',
  'mixando','misturando','mixzado','misturado','peso','pesagem','pesando',
  'amanha','amanhã','hoje','ontem','agora','depois','tarde','manha',
  'continuar','continua','continuidade','continuedade','iniciada','iniciados',
  'finalizada','finalizadas','iniciados','revisado','revisada','revisar',
  'aguardando','restante','final','inicio','meio','retorno','retornando',
  'parar','parou','parado','parada','iniciar','iniciei','reiniciar',
  'mesa','prateleira','caixa','palet','warehouse','envio','enviar','enviado',
  'pedido','order','orden','tiktok','ebay','amazon','wfs','fba','fnsku',
  'unidades','unidade','bottle','bottles','poste','postes','frasco','frascos',
  'troca','trocando','trocar','novo','novos','nova','novas','velhos','velho',
  'rasgou','quebrou','furou','vazio','cheio','aberto','aberta','fechado','fechada',
  'verificacao','verificação','verificar','conferindo','conferir','checando',
  'pendente','pendentes','enviado','enviados','recebido','recebidos','recebemos',
  'imprimir','impressao','impressão','imprimindo','impresso',
]);

// These look like product/operator categories but are mostly admin chatter
const STOP_CATEGORIES = new Set([
  'thassio','henrique','health','healthfare','carolina','linha',
  'tmpf','hmne','akqhlsscq', // slack user-id fragments
  'sistema','produto','produtos','pessoal','total','quantidade','quantidades',
  'temos','passar','favor','estoque','precisar','colocar','finalizar','liberado',
  'esses','essas','isso','aquele','aquela','dessa','desse','destas','destes',
  'transformar','imprimir','colocando','colocar','colocado','revisando','revisada',
  'manualmente','adicionar','remover','editar','apenas','sempre','depois','antes',
  'gente','estamos','estive','tinha','tinham','quero','queria','outra','outras',
  'problema','tempo','final','foram','sobre','outra','outras','final','quanto','quanta',
  'ficar','ficou','ficaram','separacao','separar','separado','separados',
  'estamos','estou','estive','sigo','seguir','seguindo','informem','informar',
  'orders','orden','pendente','envio','enviar','envelope','envelopes',
  'transformar','transformei','transformou',
  'capsulas','frasco','bottle','envasamento','rotulagem','retirada',
  'verificar','verificacao','verificação','revisão','revisao','revisando',
  'segunda','primeira','impressao','impressão','imprimindo',
]);

for (const w of STOP_CATEGORIES) STOP_WORDS.add(w);

function getKnownSet() {
  const k = new Set();
  for (const s of parser.listSupplements()) {
    k.add(s.canonical.toLowerCase());
    for (const a of (s.aliases || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      k.add(a);
      for (const w of a.split(/\s+/)) if (w.length >= 4) k.add(w);
    }
    for (const w of s.canonical.toLowerCase().split(/\s+/)) if (w.length >= 4) k.add(w);
  }
  return k;
}

const TOKEN_RE = /[a-záâãàéêíóôõúçñ]{4,}/gi;

(async () => {
  const known = getKnownSet();

  const r = await p.query(
    `SELECT slack_ts, text, parsed_type
     FROM messages
     WHERE created_at >= NOW() - INTERVAL '30 days'
       AND text IS NOT NULL
       AND parsed_type IN ('start','finish')
     ORDER BY slack_ts DESC`
  );
  console.log(`Messages parsed as start/finish in 30d: ${r.rows.length}`);

  // For each, run the parser locally and check supplement
  const missed = [];
  for (const row of r.rows) {
    const parsed = parser.parseMessage({
      ts: row.slack_ts, text: row.text, user: 'U08JC85HMNE', username: 'x',
    });
    if (!parsed) continue;
    if (parsed.type !== 'start' && parsed.type !== 'finish') continue;
    if (parsed.supplement) continue; // ok, captured
    // No supplement was extracted — what was the body?
    missed.push({ text: row.text, body: parsed.description || row.text });
  }
  console.log(`Of which had no supplement extracted: ${missed.length}\n`);

  const counts = new Map();
  for (const m of missed) {
    // Tokenize body, drop stop words / batch numbers
    const tokens = (m.body || '').match(TOKEN_RE) || [];
    const seen = new Set();
    for (const raw of tokens) {
      const tok = raw.toLowerCase();
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (STOP_WORDS.has(tok)) continue;
      if (known.has(tok)) continue;
      if (parser.extractSupplement(tok)) continue;
      const entry = counts.get(tok) || { count: 0, examples: new Set() };
      entry.count++;
      if (entry.examples.size < 3) entry.examples.add(m.text.slice(0, 100));
      counts.set(tok, entry);
    }
  }

  // Show all tokens with >= 3 occurrences
  const ranked = [...counts.entries()]
    .filter(([_, v]) => v.count >= 3)
    .sort((a, b) => b[1].count - a[1].count);

  console.log(`Candidates from messages with NO supplement extracted (>= 3 uses):\n`);
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
