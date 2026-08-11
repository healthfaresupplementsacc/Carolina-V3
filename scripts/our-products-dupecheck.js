'use strict';
/* Bruno 07-09: NÃO é duplicata só porque o nome parece igual — mg diferente é
   produto diferente, e -C2/-C3 é CASEPACK (2/3 frascos/pacote), não canal.
   Então agrupo por FAMÍLIA (nome sem dose/casepack/canal) e mostro cada linha
   com a DOSE e o CASEPACK, marcando só o que é MESMA dose + MESMO casepack
   (aí sim candidato a duplicata real). Read-only.
   railway run --service ProductionLineService node scripts/our-products-dupecheck.js */
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const up = (s) => String(s || '').trim().toUpperCase();
// dose: primeiro número (com vírgula/ponto) seguido de mg/mcg/g/bi/iu
function dose(name) {
  const m = String(name).match(/([\d.,]+)\s*(mcg|mg|g|bi|iu|billion|afu)\b/i);
  if (!m) return null;
  const num = m[1].replace(/[.,]/g, (c, i, s) => (s.length - i - 1) === 3 ? '' : c); // 32,500 -> 32500
  return `${parseInt(num.replace(/\D/g, ''), 10)}${m[2].toLowerCase()}`;
}
// casepack: variant_label (C2/C6) OU "- Cn" / "pack of n" no nome; senão 1
function pack(name, vlabel) {
  if (vlabel && /^C\d+$/i.test(vlabel)) return parseInt(vlabel.slice(1), 10);
  const m = String(name).match(/(?:^|[^A-Z0-9])C(\d+)(?![0-9])|pack of\s*(\d+)/i);
  if (m) return parseInt(m[1] || m[2], 10);
  return 1;
}
// família: nome sem dose, casepack, canal, contagem, pontuação
function family(name) {
  return String(name).toLowerCase()
    .replace(/[\d.,]+\s*(mcg|mg|g|bi|iu|billion|afu)\b/gi, ' ')
    .replace(/\b\d+\s*(tabs?|tablets?|caps?|capsules?|count|ct|softgels?|pills?|un|units?)\b/gi, ' ')
    .replace(/[-\s]+c\d+\b/gi, ' ').replace(/\bpack of\s*\d+/gi, ' ')
    .replace(/\b(amazon|walmart|wallmart|ebay|wfs|fba|site próprio|site|subscription)\b/gi, ' ')
    .replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const hasSku = (aliases) => (aliases || []).some((a) => /^[A-Z]{2,}[-0-9]/i.test(up(a)) && /\d/.test(a));

(async () => {
  const prods = (await p.query('SELECT id, canonical_name, aliases, active, parent_product_id, variant_label FROM v3.products ORDER BY id')).rows;
  const groups = new Map();
  for (const pr of prods) {
    const fam = family(pr.canonical_name);
    if (!fam) continue;
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push({ ...pr, _dose: dose(pr.canonical_name), _pack: pack(pr.canonical_name, pr.variant_label), _sku: hasSku(pr.aliases) });
  }

  const multi = [...groups.entries()].filter(([, rows]) => rows.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const realDupGroups = [];
  console.log(`\n════ FAMÍLIAS com mais de 1 linha (${multi.length}) ════`);
  console.log(`legenda: dose · CasePack(x frascos) · [SKU?] · (parent) · inativo\n`);
  for (const [fam, rows] of multi) {
    // chave de identidade "real" = dose + casepack. mesma chave 2x = candidato a dup.
    const byKey = new Map();
    for (const r of rows) {
      const k = `${r._dose || 'sem-mg'}|C${r._pack}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    const dupKeys = [...byKey.entries()].filter(([, rs]) => rs.length > 1);
    const flag = dupKeys.length ? '  ⚠️ POSSÍVEL DUPLICATA' : '';
    if (dupKeys.length) realDupGroups.push([fam, dupKeys]);
    console.log(`● ${fam.toUpperCase()}${flag}`);
    for (const r of rows.sort((a, b) => (a._dose || '').localeCompare(b._dose || '') || a._pack - b._pack)) {
      const tag = dupKeys.find(([k]) => k === `${r._dose || 'sem-mg'}|C${r._pack}`) ? ' ⚠️' : '';
      console.log(`   #${String(r.id).padEnd(4)} ${String(r.canonical_name).slice(0, 46).padEnd(46)} ${String(r._dose || '—').padStart(8)} · C${r._pack}(${r._pack}fr) ${r._sku ? '[SKU]' : '[s/SKU]'}${r.parent_product_id ? ' (parent #' + r.parent_product_id + ')' : ''}${r.active ? '' : ' INATIVO'}${tag}`);
    }
    console.log('');
  }

  console.log(`\n════ RESUMO — só as MESMA-DOSE + MESMO-CASEPACK (candidatos reais) ════`);
  if (!realDupGroups.length) console.log('  nenhum — todas as linhas diferem por dose ou casepack.');
  for (const [fam, dupKeys] of realDupGroups) {
    for (const [k, rs] of dupKeys) {
      console.log(`  ${fam.toUpperCase()} @ ${k.replace('|', ' ')}:  ${rs.map((r) => `#${r.id} "${r.canonical_name}"${r._sku ? '' : ' (s/SKU)'}`).join('   vs   ')}`);
    }
  }
  console.log('');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
