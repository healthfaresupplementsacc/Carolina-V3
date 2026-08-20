'use strict';
/**
 * HEALTHFARE V3 — Warehouse — ABSORÇÃO DA VEEQO (S15.41, Bruno 08-19).
 *
 * A PERGUNTA DO BRUNO, textual, que é a razão deste arquivo existir:
 *   "vc sabe quem sao todos os skus e seus titulos, as imagens do veeqo vc ja
 *    associou ao nossos productos no sistema e ja adicionou as imagens dos
 *    produtos no nosso sistema tb, tudo do veeqo vc absorveu, se a gente fechar
 *    nossa conta do veeqo hj vc vai ter tdas as info que precisamos correto?"
 *
 * A resposta era NÃO, medida antes de escrever isto: `v3.product_skus` guardava
 * (sku, channel, units_per_pack, barcode, is_base) — nenhuma coluna de título, o
 * barcode NULL nos 483 SKUs (a Veeqo tem upc_code em 51), e imagem em lugar
 * nenhum. Fechar a conta apagaria todo título de listagem, todo UPC e toda foto.
 *
 * O SKU-SYNC (irmão deste módulo) resolve QUEM É PAI DE QUEM. Este resolve O QUE
 * CADA UM É: título, marca, descrição, UPC, tipo, foto. Rodam na mesma tick do
 * mesmo worker, nesta ordem, porque absorver um SKU que ainda não existe na nossa
 * tabela não escreveria nada.
 *
 * TRÊS PARTES, separadas de propósito (mesmo desenho do sku-sync):
 *
 *   absorbPlan(sellables, products, current)  — PURO. Sem banco, sem rede. Diz o
 *                                               que MUDARIA e por quê.
 *   apply(plan)                               — a única metade que escreve.
 *   snapshot(sellables, products)             — a cópia crua, o seguro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AS REGRAS (não redescobrir):
 *
 * (a) NUNCA ESCREVE QUANTIDADE. Nem uma linha deste arquivo toca stock_movements,
 *     stock_bins, stock_boxes ou qty. StockService é a porta única. Este módulo
 *     escreve DESCRIÇÃO: quem o produto é, não quantos existem. Há teste que
 *     falha se qualquer query daqui mencionar tabela de estoque.
 *
 * (b) BARCODE CONFIRMADO POR GENTE NUNCA É SOBRESCRITO. `confirmed_at` marca que
 *     uma pessoa escaneou a garrafa e disse "é este". A Veeqo é um cadastro de
 *     escritório; a pessoa teve a garrafa na mão. Copiamos o upc_code SÓ quando o
 *     nosso barcode está NULL. Escanear errado manda a garrafa errada pro cliente
 *     (memória 'merge-safety-rules'), e um código sobrescrito por robô é
 *     exatamente o erro que ninguém percebe até o cliente reclamar.
 *
 * (c) IDEMPOTENTE. Rodar duas vezes seguidas não muda nada na segunda: o plano
 *     compara campo a campo com o que já está gravado e só lista o que difere.
 *     `changed: 0` é o resultado normal de um sistema em dia, e o worker fica
 *     calado quando isso acontece.
 *
 * (d) A FOTO É BAIXADA, NÃO SÓ LINKADA. URL não é posse: o link da S3 da Veeqo
 *     morre com a conta. Os bytes ficam em v3.product_images e são servidos por
 *     GET /api/v3/warehouse/image/:product_id. Baixa UMA vez por URL distinta,
 *     sequencial, e pula o que não mudou (compara source_url).
 *
 * (e) O QUE NÃO SABEMOS INTERPRETAR TAMBÉM É GUARDADO. As colunas cobrem o que a
 *     gente usa hoje; v3.veeqo_snapshots guarda a resposta CRUA inteira
 *     (hs_tariff_number, origin_country, channel_products, weight, tags…). É a
 *     diferença entre "absorvemos o que achamos importante" e "absorvemos tudo".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Teto por imagem. Foto de e-commerce (main ~80-200KB) cabe folgado; acima
 *  disso é original de câmera, que não serve pra thumbnail de hub e encheria o
 *  banco. Passou do teto: o URL fica gravado, os bytes não. */
const IMAGE_MAX_BYTES = 300 * 1024;

/** Quantos snapshots crus manter. 8 rodadas de 6h = 2 dias — o bastante pra
 *  perceber um erro e voltar, sem virar depósito de jsonb gigante. */
const SNAPSHOT_KEEP = 8;

/** Quantas fotos baixar por rodada. A absorção divide a tick com o sku-sync;
 *  baixar 400 imagens de uma vez seguraria o worker por minutos. Com 25 por
 *  rodada de 6h, um catálogo de 483 fica completo em poucos dias e depois só
 *  pega o que entrar de novo. */
const IMAGE_BATCH = 25;

/** Timeout de UM download. Imagem que não responde não pode travar a tick. */
const IMAGE_TIMEOUT_MS = 15000;

/** As colunas descritivas que este módulo escreve em v3.product_skus. Lista
 *  única: o plano compara por ela e o applier escreve por ela, então não tem
 *  como uma das duas metades ganhar um campo e a outra não. */
const SKU_FIELDS = ['title', 'product_title', 'brand', 'veeqo_type',
  'image_url', 'thumb_url', 'description', 'veeqo_product_id'];

/** SKU comparável (mesma regra do sku-sync: trim + UPPER). */
function normSku(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

/** Texto limpo pra comparar/gravar. '' vira null: coluna vazia e coluna ausente
 *  são a mesma coisa aqui, e tratá-las diferente geraria update eterno. */
function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Descrição da Veeqo vem com HTML de marketplace. Guardamos texto: o hub e o
 *  mobile mostram em <div>, e HTML de terceiro renderizado é XSS de graça.
 *  Corta em 4000 chars — é descrição de produto, não artigo. */
function cleanDescription(v) {
  const s = clean(v);
  if (!s) return null;
  const txt = s
    .replace(/<br\s*\/?>/ig, '\n')
    .replace(/<\/p>/ig, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/ig, ' ')
    .replace(/&amp;/ig, '&')
    .replace(/&lt;/ig, '<')
    .replace(/&gt;/ig, '>')
    .replace(/&quot;/ig, '"')
    .replace(/&#39;/ig, "'")
    .replace(/[ \t]+/g, ' ')
    // a tag some e deixa o espaço dela pra trás: "1300mg</b>." vira "1300mg ."
    // e "</p><br>" vira duas quebras. Junta os dois de volta ao texto normal.
    .replace(/ +([.,;:!?%)])/g, '$1')
    .replace(/([(]) +/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return txt ? txt.slice(0, 4000) : null;
}

/** Dois valores são "o mesmo" pro efeito de gravar? null/''/undefined colapsam. */
function same(a, b) {
  const x = a == null || a === '' ? null : a;
  const y = b == null || b === '' ? null : b;
  if (x == null && y == null) return true;
  if (x == null || y == null) return false;
  return String(x) === String(y);
}

/**
 * O PLANO. Puro: mesma entrada, mesma saída, sempre, sem tocar em nada.
 *
 * @param {Array} sellables  veeqo.listSellables() — [{sku, title, product_title, upc_code, type}]
 * @param {Array} products   veeqo.listProducts()  — [{id, title, brand, description,
 *                             image_url, thumb_url, sellables:[{sku, title, upc_code, type, image_url}]}]
 * @param {object} current   estado de hoje, lido do banco pelo chamador:
 *        {
 *          skus: [{id, sku, channel, product_id, barcode, confirmed_at,
 *                  title, product_title, brand, veeqo_type, image_url,
 *                  thumb_url, description, veeqo_product_id}],
 *          products: [{id, image_url, brand}],
 *          images:   [{product_id, source_url}],   // fotos já baixadas
 *        }
 * @param {object} opts {channel='veeqo'}
 * @returns {{updates, product_images, downloads, stats}}
 */
function absorbPlan(sellables = [], products = [], current = {}, opts = {}) {
  const channel = opts.channel || 'veeqo';
  const curSkus = Array.isArray(current.skus) ? current.skus : [];
  const curProducts = Array.isArray(current.products) ? current.products : [];
  const curImages = Array.isArray(current.images) ? current.images : [];

  // ── o que já temos ─────────────────────────────────────────────────────────
  const bySku = new Map();          // SKU norm → linha atual de product_skus
  for (const s of curSkus) {
    if (String(s.channel || channel) !== channel) continue;
    const k = normSku(s.sku);
    if (k) bySku.set(k, s);
  }
  const productById = new Map();
  for (const p of curProducts) productById.set(Number(p.id), p);
  const imageOfProduct = new Map();  // product_id → source_url já baixado
  for (const im of curImages) imageOfProduct.set(Number(im.product_id), clean(im.source_url));

  // ── o que a Veeqo diz ──────────────────────────────────────────────────────
  // Duas fontes pro mesmo SKU: o sellable (título de listagem, UPC, tipo) e o
  // produto pai (foto, marca, descrição). Mescla numa visão só, com o SELLABLE
  // mandando no que é dele. A foto do sellable ganha da do pai quando existe
  // (variação com foto própria); senão herda o pai.
  const want = new Map();   // SKU norm → {title, product_title, brand, veeqo_type, ...}

  for (const s of (sellables || [])) {
    if (!s) continue;
    const k = normSku(s.sku);
    if (!k) continue;
    want.set(k, {
      title: clean(s.title),
      product_title: clean(s.product_title),
      brand: null,
      veeqo_type: clean(s.type),
      image_url: null,
      thumb_url: null,
      description: null,
      veeqo_product_id: null,
      upc_code: clean(s.upc_code),
    });
  }

  let withImage = 0;
  let withUpc = 0;
  const productImages = [];   // {product_id, image_url, brand, from_sku}
  const seenProductRow = new Set();

  for (const pd of (products || [])) {
    if (!pd) continue;
    const pid = pd.id != null ? Number(pd.id) : null;
    const pImg = clean(pd.image_url);
    const pThumb = clean(pd.thumb_url) || pImg;
    const pBrand = clean(pd.brand);
    const pDesc = cleanDescription(pd.description);
    const pTitle = clean(pd.title);

    for (const s of (pd.sellables || [])) {
      const k = normSku(s.sku);
      if (!k) continue;
      const prev = want.get(k) || {
        title: null, product_title: null, brand: null, veeqo_type: null,
        image_url: null, thumb_url: null, description: null,
        veeqo_product_id: null, upc_code: null,
      };
      // o sellable manda no que é dele; o produto preenche o resto
      prev.title = prev.title || clean(s.title);
      prev.product_title = prev.product_title || pTitle;
      prev.veeqo_type = prev.veeqo_type || clean(s.type);
      prev.upc_code = prev.upc_code || clean(s.upc_code);
      prev.brand = pBrand;
      prev.description = pDesc;
      prev.veeqo_product_id = pid;
      const own = clean(s.image_url);
      prev.image_url = own || pImg;
      prev.thumb_url = own || pThumb;
      want.set(k, prev);
    }
  }

  // ── o que muda ─────────────────────────────────────────────────────────────
  const updates = [];
  let changed = 0;
  let unchanged = 0;
  let barcodeFills = 0;
  let confirmedKept = 0;
  const missing = { title: 0, image: 0, upc: 0 };

  for (const [sku, w] of want) {
    if (w.image_url) withImage += 1;
    if (w.upc_code) withUpc += 1;

    const cur = bySku.get(sku);
    // SKU que a Veeqo tem e nós não: NÃO é problema deste módulo. Quem cria linha
    // em product_skus é o sku-sync (que sabe achar o produto pai). Absorver
    // descrição de um SKU inexistente não teria onde gravar.
    if (!cur) continue;

    const fields = {};
    for (const f of SKU_FIELDS) {
      if (!same(cur[f], w[f])) fields[f] = w[f];
    }

    // (b) BARCODE: só preenche buraco, nunca sobrescreve.
    let barcodeFill = false;
    if (w.upc_code) {
      const haveBarcode = clean(cur.barcode);
      if (!haveBarcode) {
        fields.barcode = w.upc_code;
        barcodeFill = true;
        barcodeFills += 1;
      } else if (cur.confirmed_at && !same(haveBarcode, w.upc_code)) {
        // pessoa escaneou e a Veeqo discorda: a pessoa ganha, e o fato fica
        // contado (o preview mostra, alguém decide se corrige a Veeqo).
        confirmedKept += 1;
      }
    }

    if (!Object.keys(fields).length) { unchanged += 1; continue; }
    changed += 1;
    updates.push({
      sku,
      sku_id: cur.id != null ? Number(cur.id) : null,
      product_id: cur.product_id != null ? Number(cur.product_id) : null,
      fields,
      barcode_fill: barcodeFill,
    });
  }

  // ── a foto do PRODUTO FÍSICO ───────────────────────────────────────────────
  // O hub lista produtos, não SKUs. A foto do produto vem do SKU BASE quando ele
  // tem uma; se o base não tiver, qualquer filho com foto serve (é a mesma
  // garrafa — o "4 Bottles" fotografa o mesmo frasco).
  const byProduct = new Map();   // product_id → {base:{}, any:{}}
  for (const s of curSkus) {
    if (String(s.channel || channel) !== channel) continue;
    const k = normSku(s.sku);
    const w = want.get(k);
    if (!w || !w.image_url) continue;
    const pid = Number(s.product_id);
    if (!pid) continue;
    const slot = byProduct.get(pid) || { base: null, any: null };
    const cand = { image_url: w.image_url, brand: w.brand, from_sku: k };
    if (s.is_base && !slot.base) slot.base = cand;
    if (!slot.any) slot.any = cand;
    byProduct.set(pid, slot);
  }

  const downloads = [];
  for (const [pid, slot] of byProduct) {
    const pick = slot.base || slot.any;
    if (!pick) continue;
    const p = productById.get(pid) || {};
    // linha do produto: grava url+marca quando difere do que está lá
    if (!same(p.image_url, pick.image_url) || !same(p.brand, pick.brand)) {
      if (!seenProductRow.has(pid)) {
        seenProductRow.add(pid);
        productImages.push({ product_id: pid, image_url: pick.image_url,
          brand: pick.brand, from_sku: pick.from_sku });
      }
    }
    // (d) bytes: baixa só quando o URL mudou (ou nunca houve)
    const have = imageOfProduct.get(pid);
    if (!same(have, pick.image_url)) {
      downloads.push({ product_id: pid, source_url: pick.image_url, sku: pick.from_sku });
    }
  }

  // ── o que AINDA falta (é isto que responde "e se fechar hoje?") ────────────
  for (const s of curSkus) {
    if (String(s.channel || channel) !== channel) continue;
    const k = normSku(s.sku);
    const w = want.get(k);
    const title = clean(s.title) || (w && w.title);
    const image = clean(s.image_url) || (w && w.image_url);
    const upc = clean(s.barcode) || (w && w.upc_code);
    if (!title) missing.title += 1;
    if (!image) missing.image += 1;
    if (!upc) missing.upc += 1;
  }

  return {
    updates,
    product_images: productImages,
    downloads,
    stats: {
      sellables: (sellables || []).length,
      products: (products || []).length,
      with_image: withImage,
      with_upc: withUpc,
      changed,
      unchanged,
      barcode_fills: barcodeFills,
      confirmed_kept: confirmedKept,
      product_images: productImages.length,
      downloads: downloads.length,
      missing,
    },
  };
}

/**
 * O APLICADOR + o seguro. Escreve SÓ descrição (v3.product_skus descritivo,
 * v3.products.image_url/brand, v3.product_images, v3.veeqo_snapshots).
 * NUNCA quantidade — regra (a).
 *
 * @param {object} deps {db, veeqo, fetchImpl?, channel?, now?, imageBatch?}
 */
function createVeeqoAbsorb(deps = {}) {
  const db = deps.db;
  const veeqo = deps.veeqo || null;
  const channel = deps.channel || 'veeqo';
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const imageBatch = deps.imageBatch || IMAGE_BATCH;
  const maxBytes = deps.imageMaxBytes || IMAGE_MAX_BYTES;
  const keep = deps.snapshotKeep || SNAPSHOT_KEEP;

  /** O que está gravado hoje. Três leituras, nenhuma escrita. */
  async function loadCurrent() {
    const skus = (await db.query(
      `SELECT id, product_id, sku, channel, is_base, barcode, confirmed_at,
              title, product_title, brand, veeqo_type, image_url, thumb_url,
              description, veeqo_product_id
         FROM v3.product_skus WHERE channel = $1`, [channel])).rows;
    const products = (await db.query(
      'SELECT id, image_url, brand FROM v3.products')).rows;
    const images = (await db.query(
      'SELECT product_id, source_url FROM v3.product_images')).rows;
    return { skus, products, images };
  }

  /** O catálogo da Veeqo, as duas metades. Rede; nada escrito. */
  async function loadVeeqo() {
    if (!veeqo) return { sellables: [], products: [] };
    const sellables = typeof veeqo.listSellables === 'function' ? await veeqo.listSellables() : [];
    const products = typeof veeqo.listProducts === 'function' ? await veeqo.listProducts() : [];
    return { sellables, products };
  }

  /** Lê tudo e planeja. Não escreve nada — é o que o preview da API chama. */
  async function preview(opts = {}) {
    const [{ sellables, products }, current] = await Promise.all([loadVeeqo(), loadCurrent()]);
    return absorbPlan(sellables, products, current, { channel, ...opts });
  }

  /**
   * (e) O SEGURO: a leitura crua inteira, e a poda pros 8 mais novos.
   * Guardado ainda que nada tenha mudado — o valor dele é ser a última foto
   * completa da conta, não o diff.
   */
  async function snapshot(sellables = [], products = []) {
    if (!sellables.length && !products.length) return { saved: false, pruned: 0 };
    const payload = JSON.stringify({ sellables, products });
    const r = await db.query(
      `INSERT INTO v3.veeqo_snapshots (sellables, products, payload)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [sellables.length, products.length, payload]);
    // poda: tudo que não está entre os `keep` mais recentes. Por id (bigserial
    // monotônico) e não por taken_at: dois snapshots no mesmo instante
    // (retry, teste) empatariam no timestamp e a poda ficaria indefinida.
    const pruned = await db.query(
      `DELETE FROM v3.veeqo_snapshots
        WHERE id NOT IN (SELECT id FROM v3.veeqo_snapshots ORDER BY id DESC LIMIT $1)`,
      [keep]);
    return { saved: true, id: r.rows[0] && Number(r.rows[0].id),
      pruned: pruned.rowCount || 0 };
  }

  /**
   * (d) UMA foto. Sequencial de propósito: são poucas por rodada e a Veeqo/S3
   * não precisa levar rajada. Falha de download NUNCA derruba a absorção — a
   * foto tenta de novo na próxima rodada.
   * @returns {{ok, mime?, bytes?, why?}}
   */
  async function _download(url) {
    if (!fetchImpl) return { ok: false, why: 'sem fetch' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
    try {
      const r = await fetchImpl(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r || !r.ok) return { ok: false, why: 'HTTP ' + (r && r.status) };
      const mime = String((r.headers && r.headers.get && r.headers.get('content-type')) || 'image/jpeg')
        .split(';')[0].trim().toLowerCase();
      if (!/^image\//.test(mime)) return { ok: false, why: 'não é imagem (' + mime + ')' };
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) return { ok: false, why: 'vazio' };
      if (buf.length > maxBytes) return { ok: false, why: 'grande demais (' + buf.length + ')' };
      return { ok: true, mime, bytes: buf };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, why: (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message) };
    }
  }

  /**
   * Aplica o plano. Só descrição.
   * @returns {{updated, barcode_filled, products_touched, images_downloaded, images_failed, errors}}
   */
  async function apply(p = {}, opts = {}) {
    const out = { updated: 0, barcode_filled: 0, products_touched: 0,
      images_downloaded: 0, images_failed: 0, errors: [] };

    // 1) DESCRITIVO por SKU. UPDATE por (channel, sku) — a chave única da tabela.
    // Só as colunas que o plano listou: um campo que a Veeqo não trouxe fica como
    // está, nunca é apagado por ausência.
    for (const u of (p.updates || [])) {
      const cols = [];
      const vals = [channel, u.sku];
      for (const [k, v] of Object.entries(u.fields || {})) {
        // trava dura: só as colunas descritivas conhecidas entram no SQL. Nome de
        // coluna não pode vir de dado externo, mesmo sendo nosso o gerador.
        if (k !== 'barcode' && !SKU_FIELDS.includes(k)) continue;
        vals.push(v);
        cols.push(`${k} = $${vals.length}`);
      }
      if (!cols.length) continue;
      cols.push('absorbed_at = NOW()', 'last_seen_at = NOW()');
      const r = await db.query(
        `UPDATE v3.product_skus SET ${cols.join(', ')}
          WHERE channel = $1 AND UPPER(sku) = $2 RETURNING id`, vals);
      if (r.rows && r.rows[0]) {
        out.updated += 1;
        if (u.barcode_fill) out.barcode_filled += 1;
      }
    }

    // 2) A FOTO DO PRODUTO (url + marca na linha do produto).
    for (const pi of (p.product_images || [])) {
      const r = await db.query(
        `UPDATE v3.products SET image_url = $2, brand = COALESCE($3, brand)
          WHERE id = $1 RETURNING id`,
        [Number(pi.product_id), pi.image_url || null, pi.brand || null]);
      if (r.rows && r.rows[0]) out.products_touched += 1;
    }

    // 3) OS BYTES. Sequencial, com teto por rodada, e cada falha isolada.
    const wanted = (p.downloads || []).slice(0, imageBatch);
    for (const d of wanted) {
      if (!d.source_url) continue;
      const got = await _download(d.source_url);
      if (!got.ok) {
        out.images_failed += 1;
        if (out.errors.length < 5) out.errors.push({ product_id: d.product_id, why: got.why });
        continue;
      }
      try {
        await db.query(
          `INSERT INTO v3.product_images (product_id, sku, mime, bytes, source_url, fetched_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (product_id) DO UPDATE
             SET sku = EXCLUDED.sku, mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
                 source_url = EXCLUDED.source_url, fetched_at = NOW()`,
          [Number(d.product_id), d.sku || null, got.mime, got.bytes, d.source_url]);
        out.images_downloaded += 1;
      } catch (e) {
        out.images_failed += 1;
        if (out.errors.length < 5) out.errors.push({ product_id: d.product_id, why: e.message });
      }
    }

    // 4) last_seen_at pra TODO SKU que apareceu, mesmo sem mudança. É o que
    // permite dizer depois "este SKU sumiu da Veeqo em tal data" — SKU que some
    // não é apagado (a garrafa continua na prateleira), só para de ser visto.
    const seen = (opts.seen_skus || []).filter(Boolean);
    if (seen.length) {
      await db.query(
        `UPDATE v3.product_skus SET last_seen_at = NOW()
          WHERE channel = $1 AND UPPER(sku) = ANY($2::text[])`,
        [channel, seen.map(normSku)]).catch(() => {});
    }

    return out;
  }

  /**
   * A RODADA INTEIRA: lê, planeja, aplica, guarda o cru. É o que o worker chama.
   * O snapshot vem por ÚLTIMO e só quando a leitura trouxe algo: guardar um
   * catálogo vazio por causa de uma falha de rede apagaria (pela poda) os
   * snapshots bons que estavam lá.
   */
  async function run(opts = {}) {
    const [{ sellables, products }, current] = await Promise.all([loadVeeqo(), loadCurrent()]);
    if (!sellables.length && !products.length) {
      return { plan: null, applied: null, snapshot: { saved: false, pruned: 0 }, empty: true };
    }
    const p = absorbPlan(sellables, products, current, { channel, ...opts });
    const applied = await apply(p, { seen_skus: sellables.map((s) => s && s.sku) });
    const snap = await snapshot(sellables, products);
    return { plan: p, applied, snapshot: snap, empty: false };
  }

  /** Os bytes da foto de um produto (a rota GET /image/:product_id). */
  async function imageOf(productId) {
    const r = await db.query(
      `SELECT mime, bytes, fetched_at, source_url FROM v3.product_images
        WHERE product_id = $1 LIMIT 1`, [Number(productId)]);
    return (r.rows && r.rows[0]) || null;
  }

  return { absorbPlan, plan: absorbPlan, preview, apply, run, snapshot,
    loadCurrent, loadVeeqo, imageOf };
}

module.exports = { createVeeqoAbsorb, absorbPlan, normSku, clean, cleanDescription,
  SKU_FIELDS, IMAGE_MAX_BYTES, SNAPSHOT_KEEP, IMAGE_BATCH };
