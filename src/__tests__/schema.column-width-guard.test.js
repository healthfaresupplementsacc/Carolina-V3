'use strict';
/*
 * COLUMN WIDTH GUARD — pura análise estática (lê arquivos, nunca o banco).
 *
 * POR QUE ISSO EXISTE (Bruno 08-21): o operador que tentava lançar uma tarefa
 * esquecida (retroativa) via /op recebia
 *
 *     value too long for type character varying(20)
 *
 * e NÃO conseguia prosseguir. O INSERT gravava source='operator_page_retroactive'
 * (25 chars) numa coluna VARCHAR(20). Nunca houve UM evento com esse source no
 * banco: o retroativo do operador nunca funcionou desde que foi escrito. Os
 * testes existentes (op.retroactive.test.js) passavam porque são MOCKADOS — o
 * mock aceita qualquer string, o Postgres não. Falso-verde clássico.
 *
 * Este teste fecha esse furo sem precisar de banco: lê a largura declarada de
 * v3.events.source nas migrations e confere contra TODO literal que o código
 * grava nessa coluna. Se alguém reintroduzir um limite apertado — ou inventar um
 * source mais descritivo que não caiba — quebra aqui, não na cara do operador.
 *
 * RULE #0: o sistema nunca pode impedir o operador de registrar a realidade.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'src', 'v3', 'schema', 'migrations');

// Última largura declarada p/ v3.events.source nas migrations, em ordem numérica.
// null = TEXT (sem limite); undefined = nunca declarada.
function declaredWidthOfEventsSource() {
  const files = fs.readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  let width;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const add = sql.match(/ALTER\s+TABLE\s+v3\.events\s+ADD\s+COLUMN[^;]*?\bsource\s+VARCHAR\((\d+)\)/i);
    if (add) width = parseInt(add[1], 10);
    const alter = sql.match(/ALTER\s+TABLE\s+v3\.events\s+ALTER\s+COLUMN\s+source\s+TYPE\s+(TEXT|VARCHAR\((\d+)\))/i);
    if (alter) width = /TEXT/i.test(alter[1]) ? null : parseInt(alter[2], 10);
  }
  return width;
}

// Todo literal que o código grava na coluna source de v3.events.
function sourceLiteralsInCode() {
  const files = [
    'src/routes/op.js', 'src/routes/admin.js', 'src/v3/services/EventService.js',
    'src/v3/services/CommandHandler.js', 'src/v3/pause/service.js',
    'src/workers/ems-activity-sync.js',
  ];
  const found = new Map(); // literal -> arquivo onde aparece
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    // fatia cada INSERT INTO v3.events até o fim do statement
    const re = /INSERT\s+INTO\s+v3\.events\b[\s\S]{0,1400}?(?:RETURNING[^`;]*|`|;)/gi;
    let m;
    while ((m = re.exec(src))) {
      // só a parte depois de VALUES/SELECT — evita capturar nomes de coluna
      const tail = m[0].split(/\bVALUES\b|\bSELECT\b/i).slice(1).join(' ');
      for (const lit of tail.match(/'[a-z][a-z0-9_]{2,}'/gi) || []) {
        const v = lit.slice(1, -1);
        // valores de OUTRAS colunas que aparecem inline no mesmo INSERT.
        // 'high|medium|low' = confidence; *_close = closed_reason, que é TEXT
        // (não tem limite) — medi-los contra a largura de source daria alarme falso.
        if (/^(high|medium|low|null|true|false)$/i.test(v)) continue;
        if (/_close$/i.test(v)) continue;
        if (!found.has(v)) found.set(v, rel);
      }
    }
    // atribuição direta: source = 'x' / source: 'x' / ev.source || 'x'
    for (const lit of src.match(/source\s*(?:=|:|\|\|)\s*'([a-z][a-z0-9_]{2,})'/gi) || []) {
      const v = lit.match(/'([a-z][a-z0-9_]{2,})'/i)[1];
      if (!found.has(v)) found.set(v, rel);
    }
  }
  return found;
}

describe('v3.events.source — largura da coluna vs valores que o código grava', () => {
  test('a coluna comporta TODO source escrito pelo código (o bug do retroativo não volta)', () => {
    const width = declaredWidthOfEventsSource();
    if (width === null || width === undefined) return; // TEXT: nada a checar
    const tooLong = [];
    for (const [lit, file] of sourceLiteralsInCode()) {
      if (lit.length > width) tooLong.push(`'${lit}' (${lit.length} chars) em ${file}`);
    }
    expect({ width, tooLong }).toEqual({ width, tooLong: [] });
  });

  test('o source do retroativo do operador cabe (foi ESTE valor que quebrou em campo)', () => {
    const width = declaredWidthOfEventsSource();
    const RETRO = 'operator_page_retroactive'; // 27 chars — não cabia em VARCHAR(20)
    if (width === null || width === undefined) {
      expect(width === null || width === undefined).toBe(true); // TEXT: cabe sempre
      return;
    }
    expect(RETRO.length).toBeLessThanOrEqual(width);
  });

  test('migration 080 existe e recria a matview events_enriched junto do ALTER', () => {
    const f = path.join(MIGRATIONS, '080_events_source_widen.sql');
    expect(fs.existsSync(f)).toBe(true);
    const sql = fs.readFileSync(f, 'utf8');
    // o ALTER sozinho falha: "cannot alter type of a column used by a view or rule"
    expect(sql).toMatch(/DROP\s+MATERIALIZED\s+VIEW\s+IF\s+EXISTS\s+v3\.events_enriched/i);
    expect(sql).toMatch(/ALTER\s+TABLE\s+v3\.events\s+ALTER\s+COLUMN\s+source\s+TYPE\s+TEXT/i);
    expect(sql).toMatch(/CREATE\s+MATERIALIZED\s+VIEW\s+v3\.events_enriched/i);
    // os 4 índices têm que voltar, senão o REFRESH CONCURRENTLY quebra
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+idx_ee_id\b/i);
    expect(sql).toMatch(/CREATE\s+INDEX\s+idx_ee_person_date\b/i);
    expect(sql).toMatch(/CREATE\s+INDEX\s+idx_ee_slug\b/i);
    expect(sql).toMatch(/CREATE\s+INDEX\s+idx_ee_started\b/i);
  });
});
