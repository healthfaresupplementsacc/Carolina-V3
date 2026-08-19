'use strict';
/**
 * veeqo-shipments-by-zip — READ-ONLY. Lista os envios de uma faixa de ZIP
 * numa janela de datas, com tracking, carrier, destinatario e data de envio.
 *
 * Pedido do Bruno (2026-08-13): trackings de Lynn MA 01901 + arredores (019xx)
 * em torno de 13/07/2026.
 *
 * A Veeqo marca `shipped` quando a etiqueta e impressa. Ela NAO tem status de
 * entrega confirmada — isso e da transportadora. Entao a coluna e `shipped_at`;
 * pra "delivered" de verdade precisa da API da USPS/UPS/DHL (peca separada).
 *
 * SEGURANCA: nao escreve nada, nao loga a chave. Usa o cliente existente
 * src/v3/services/veeqo-api.js, que le process.env.VEEQO_API_KEY.
 *
 * USO:
 *   node scripts/veeqo-shipments-by-zip.js
 *   node scripts/veeqo-shipments-by-zip.js --zip 019 --from 2026-07-08 --to 2026-07-18
 *   node scripts/veeqo-shipments-by-zip.js --zip 01901,01902 --csv saida.csv
 *
 * FLAGS:
 *   --zip     prefixos/ZIPs separados por virgula (default: 019 = Lynn e vizinhos)
 *   --from    dia inicial NY YYYY-MM-DD (default: 2026-07-08)
 *   --to      dia final NY YYYY-MM-DD   (default: 2026-07-18)
 *   --pages   teto de paginas de 100 pedidos (default: 200 = 20k pedidos)
 *   --csv     tambem grava um CSV no caminho dado
 *   --timeout ms por request na Veeqo (default: 60000; janelas longas sao lentas)
 */
const fs = require('fs');
const path = require('path');
const { createVeeqoClient } = require('../src/v3/services/veeqo-api');

const TZ = 'America/New_York';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ZIPS = String(arg('zip', '019')).split(',').map((s) => s.trim()).filter(Boolean);
const FROM = arg('from', '2026-07-08');
const TO = arg('to', '2026-07-18');
const MAX_PAGES = Number(arg('pages', 200));
const CSV_OUT = arg('csv', null);
const TIMEOUT_MS = Number(arg('timeout', 60000));

const nyDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }) : null);

// ── extratores (mesmas chaves que o dup-shipment-detector usa; a Veeqo varia o nome) ──
const dest = (o) => o.deliver_to || {};
const zipOf = (o) => String(dest(o).zip || dest(o).zip_code || dest(o).post_code || '').trim();
const nameOf = (o) => {
  const d = dest(o);
  return ((d.first_name || '') + ' ' + (d.last_name || '')).replace(/\s+/g, ' ').trim() || d.company || '';
};
const addrOf = (o) => {
  const d = dest(o);
  const l1 = (d.address1 || d.address_1 || '').trim();
  const l2 = (d.address2 || d.address_2 || '').trim();
  return [l1, l2].filter(Boolean).join(', ');
};
const cityOf = (o) => (dest(o).city || '').trim();
const stateOf = (o) => (dest(o).state || dest(o).region || '').trim();

/** Todos os trackings do pedido, com carrier quando a Veeqo manda. */
function shipmentsOf(o) {
  const out = [];
  const push = (s) => {
    if (!s) return;
    let t = s.tracking_number;
    if (t && typeof t === 'object') t = t.tracking_number;
    if (!t) return;
    const carrier = (s.carrier && (s.carrier.name || s.carrier.code))
      || s.carrier_name || s.shipping_company || s.service_carrier || '';
    out.push({
      tracking: String(t),
      carrier: String(carrier || ''),
      shipped_at: s.shipped_at || s.created_at || o.shipped_at || null,
      url: s.tracking_number_url || s.tracking_url || '',
    });
  };
  for (const a of (o.allocations || [])) push(a.shipment);
  for (const s of (o.shipments || [])) push(s);
  // dedupe por tracking
  const seen = new Set();
  return out.filter((s) => (seen.has(s.tracking) ? false : (seen.add(s.tracking), true)));
}

const matchesZip = (z) => !!z && ZIPS.some((p) => z.startsWith(p));

const inWindow = (day) => !!day && day >= FROM && day <= TO;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Uma pagina lenta nao pode matar uma varredura de 60+ dias. Repete so o que e
 * transitorio (timeout/rede/5xx); 401 e erro de chave, aborta na hora.
 */
async function fetchPageWithRetry(veeqo, params, tries = 4) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await veeqo.getOrdersPage(params);
    } catch (e) {
      last = e;
      const transient = e.code === 'timeout' || e.code === 'network' || (e.status >= 500);
      if (!transient || attempt === tries) throw e;
      const wait = 2000 * attempt;
      console.error(`[veeqo] pagina ${params.page}: ${e.message} — tentativa ${attempt}/${tries}, esperando ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

async function main() {
  const veeqo = createVeeqoClient({ timeoutMs: TIMEOUT_MS });
  if (!veeqo.configured()) {
    console.error('VEEQO_API_KEY nao esta no ambiente. Rode onde a chave existe (Railway) '
      + 'ou exporte a chave nesta shell. O script nao pede nem guarda a chave.');
    process.exit(2);
  }

  // updated_at_min: 3 dias antes do FROM, cobre fuso e updates tardios.
  const since = new Date(Date.parse(FROM + 'T00:00:00Z') - 3 * 86400000).toISOString();

  console.error(`[veeqo] buscando shipped, ZIP ${ZIPS.join('/')}*, ${FROM} a ${TO} (NY)...`);

  const rows = [];
  let scanned = 0, pages = 0, capped = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchPageWithRetry(veeqo, { status: 'shipped', updatedSince: since, page, pageSize: 100 });
    pages = page;
    if (!batch.length) break;
    scanned += batch.length;
    for (const o of batch) {
      const z = zipOf(o);
      if (!matchesZip(z)) continue;
      const day = nyDay(o.shipped_at);
      if (!inWindow(day)) continue;
      const ships = shipmentsOf(o);
      const base = {
        shipped_day: day,
        order: o.number || String(o.id),
        channel: (o.channel && (o.channel.name || o.channel.type_code)) || '',
        name: nameOf(o),
        address: addrOf(o),
        city: cityOf(o),
        state: stateOf(o),
        zip: z,
      };
      if (!ships.length) {
        rows.push({ ...base, tracking: '', carrier: '', tracking_url: '' });
      } else {
        for (const s of ships) {
          rows.push({ ...base, tracking: s.tracking, carrier: s.carrier, tracking_url: s.url });
        }
      }
    }
    if (batch.length < 100) break;
    if (page === MAX_PAGES) capped = true;
  }

  rows.sort((a, b) => a.shipped_day.localeCompare(b.shipped_day)
    || a.name.localeCompare(b.name) || a.tracking.localeCompare(b.tracking));

  if (!rows.length) {
    console.error(`[veeqo] nada encontrado. ${scanned} pedidos varridos em ${pages} pagina(s).`);
    if (capped) console.error('[veeqo] ATENCAO: bateu o teto de paginas, aumente --pages.');
    return;
  }

  const w = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
  console.log('');
  console.log(w('ENVIADO', 11) + w('CLIENTE', 24) + w('CIDADE', 14) + w('ZIP', 7)
    + w('CARRIER', 12) + w('TRACKING', 26) + 'PEDIDO');
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(w(r.shipped_day, 11) + w(r.name, 24) + w(r.city, 14) + w(r.zip, 7)
      + w(r.carrier, 12) + w(r.tracking || '(sem tracking)', 26) + r.order);
  }
  console.log('');
  const clientes = new Set(rows.map((r) => r.name.toLowerCase())).size;
  const tracks = new Set(rows.map((r) => r.tracking).filter(Boolean)).size;
  console.log(`${rows.length} linha(s) — ${clientes} cliente(s), ${tracks} tracking(s). `
    + `${scanned} pedidos varridos em ${pages} pagina(s).`);
  if (capped) console.error('ATENCAO: bateu o teto de paginas (--pages), pode faltar pedido.');
  console.log('Nota: "ENVIADO" = etiqueta impressa na Veeqo. Entrega confirmada e da transportadora, '
    + 'a Veeqo nao guarda. Confira o tracking no site do carrier.');

  if (CSV_OUT) {
    const cols = ['shipped_day', 'order', 'channel', 'name', 'address', 'city', 'state', 'zip', 'carrier', 'tracking', 'tracking_url'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
    fs.writeFileSync(path.resolve(CSV_OUT), csv, 'utf8');
    console.log('CSV: ' + path.resolve(CSV_OUT));
  }
}

main().catch((e) => {
  console.error('[veeqo] falhou: ' + (e && e.message));  // erro do cliente nunca inclui a chave
  process.exit(1);
});
