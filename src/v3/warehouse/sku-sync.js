'use strict';
/**
 * HEALTHFARE V3 — Warehouse — SINCRONIZAÇÃO DE SKU COM A VEEQO (Bruno 08-19).
 *
 * A PERGUNTA DO BRUNO, que é a razão deste arquivo existir:
 *   "pq q ele nao ta mapeado se ta tudo la no Veeqo? Veeqo tem tudo SKU, Titulo,
 *    Quantidade, como q nao ta mapeado cara?"
 *
 * Ele está certo. `v3.product_skus` sempre foi preenchido À MÃO, produto por
 * produto, casando por NOME. Resultado medido em 08-19: 168 de 483 sellables da
 * Veeqo mapeados. Um pedido de eBay do HF-NAC-1300-C4 ("4 Bottles") resolvia
 * NADA: não reservava, não deduzia, e só aparecia quando o pedido falhava. O
 * backlog de hoje foi consertado na mão (168 → 367 mapeados), mas isso não
 * impede o PRÓXIMO SKU novo da Veeqo de nascer órfão do mesmo jeito.
 *
 * Este módulo é o que mantém aquilo verdadeiro sozinho. Duas metades, de
 * propósito separadas:
 *
 *   plan(sellables, current)  — PURO. Nenhum banco, nenhuma rede, nada escrito.
 *                               Só olha o catálogo da Veeqo e o mapeamento de
 *                               hoje e diz o que FARIA.
 *   apply(plan, opts)         — a única metade que escreve, e só o que o plano
 *                               disse.
 *
 * Por que separado: o plano tem que ser REVISÁVEL antes de virar escrita. O hub
 * mostra o preview, o Bruno olha, e só então alguém aplica. Um planner que só
 * existe dentro do applier não dá pra ler nem testar sem banco.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AS REGRAS (aprendidas na varredura de 08-19; NÃO redescobrir):
 *
 * (a) CASEPACK PELO CÓDIGO. `-C<n>` no fim do SKU é um pacote de n unidades da
 *     RAIZ. `-C<a>-C<b>` é pacote de pacote: units = a × b (HF-X-C2-C4 = 8). O
 *     produto PAI é quem tem a raiz.
 *
 * (b) units_per_pack SEMPRE DERIVADO DO CÓDIGO, nunca herdado da linha. Foram
 *     encontradas 9 linhas com o número errado gravado. O SKU não mente; a
 *     coluna já mentiu.
 *
 * (c) DOIS PRODUTOS NUNCA COMPARTILHAM UMA RAIZ. 12 produtos precisaram ser
 *     juntados por isso. Quando acontece, este módulo REPORTA e para: juntar é
 *     decisão humana (o "Juntar SKUs" do hub), porque merge errado manda a
 *     garrafa errada pro cliente (memória 'merge-safety-rules').
 *
 * (d) PRODUTO CUJO SKU BASE JÁ É CASEPACK (base_units_per_pack > 1) quase sempre
 *     é bug de mapeamento — MAS existem casos reais em que a Veeqo simplesmente
 *     não tem listagem avulsa (HF-BERB-5000, HF-PANT-500). Então: SINALIZA,
 *     NUNCA conserta sozinho.
 *
 * (e) SERVIÇO/PLANO/INSUMO NÃO É GARRAFA. HF-PLN-, HC-, HF-MED-, HF-SYR-,
 *     SHOPIFY-, SILIN-, RUBBER- e o SKU pelado "70" (HairLux/Semaglutide/
 *     Thermoplus/consultas da clínica) carregam estoque falso 9999 na Veeqo.
 *     Entram em `ignored`, nunca viram produto nem estoque.
 *
 * (f) REGRA DO BRUNO (memória 'sku-parent-single-unit'): o casepack é a MESMA
 *     garrafa física. O estoque conta UNIDADES sob o PAI, a Veeqo manda na
 *     identificação, e NUNCA se soma base + kit.
 *
 * (g) SUFIXO -WFS É CANAL, NÃO PACOTE (09-02; ver docs/architecture/data/
 *     WALMART-WFS-SKUS.md, S15.42). SKU terminado em '-WFS' é a listagem do
 *     Walmart Fulfillment Services da MESMA garrafa da raiz. Tira-se o '-WFS'
 *     PRIMEIRO e depois a cadeia '-C<n>': HF-X-C2-WFS = pacote de 2 da raiz
 *     HF-X. O '-WFS' em si vale x1 (canal não multiplica garrafa). O plano liga
 *     o '-WFS' no dono da raiz igual liga casepack (reason 'wfs_of_root'). Sem
 *     esta regra os -WFS novos de 08-22 (HF-PYGE-4500-WFS etc.) nasceram órfãos
 *     e os pedidos deles ficaram dias sem resolver.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// (e) — prefixos que NÃO são garrafa de suplemento. O estoque 9999 da Veeqo
// nesses SKUs é sintético (plano de assinatura, consulta, seringa, insumo), e um
// produto criado a partir deles poluiria o hub com linha que ninguém conta.
const SERVICE_PREFIXES = ['HF-PLN-', 'HC-', 'HF-MED-', 'HF-SYR-', 'SHOPIFY-', 'SILIN-', 'RUBBER-'];
// SKU pelado, sem prefixo nenhum: serviço da clínica cadastrado com o número solto.
const SERVICE_EXACT = new Set(['70']);

// Teto do plano por rodada. Não é limite de catálogo (483 sellables hoje): é o
// tamanho de uma decisão que uma pessoa consegue revisar de uma vez. Acima disso
// o plano vem cortado e `stats.capped` avisa — melhor um plano lido inteiro do
// que um plano gigante aplicado no escuro.
const MAX_PLAN_ITEMS = 400;

/** SKU limpo e comparável: trim + UPPER. Um lugar só, senão a chave diverge. */
function normSku(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

/**
 * (g) tira o sufixo de canal '-WFS' do fim, quando existir. Aceita '-', '_'
 * e ' ' como separador (mesmas grafias do casepack). NÃO tira 'WFS' colado
 * ('HFWFS'): sem separador, as letras fazem parte do nome do produto.
 * Recebe o SKU JÁ normalizado (uso interno das duas funções abaixo).
 */
function stripWfs(s) {
  const m = String(s || '').match(/[-_\s]WFS$/);
  return m ? s.slice(0, s.length - m[0].length) : s;
}

/** (g) este SKU é uma listagem Walmart WFS (termina em '-WFS')? */
function isWfs(sku) {
  const s = normSku(sku);
  return /[-_\s]WFS$/.test(s);
}

/**
 * (a)+(b) — quantas unidades o CÓDIGO diz. Lê todos os sufixos `-C<n>` do fim,
 * da direita pra esquerda, e multiplica: 'HF-X-C4' → 4 · 'HF-X-C2-C4' → 8.
 * Sem sufixo → 1 (a garrafa avulsa é pacote de si mesma).
 *
 * (g) o sufixo '-WFS' sai PRIMEIRO e vale x1: 'HF-X-C2-WFS' → 2.
 *
 * Aceita '-C4', '_C4' e ' C4' porque a Veeqo tem as três grafias. NÃO aceita
 * 'C4' colado ('HFC4'): ali o C faz parte do nome do produto, não é sufixo.
 */
function unitsOf(sku) {
  const s = normSku(sku);
  if (!s) return 1;
  let rest = stripWfs(s) || s;
  let units = 1;
  for (;;) {
    const m = rest.match(/[-_\s]C(\d+)$/);
    if (!m) break;
    const n = Number(m[1]);
    // 'C0' e 'C1' não são pacote de verdade; tratar como 0 zeraria o estoque
    // derivado e como 1 é exatamente o que já é. Corta o sufixo e segue.
    if (Number.isFinite(n) && n > 1) units *= n;
    rest = rest.slice(0, rest.length - m[0].length);
    if (!rest) break;
  }
  return units || 1;
}

/**
 * (a) — a RAIZ do SKU: o código sem nenhum sufixo de pacote nem de canal.
 * 'HF-NAC-1300-C4' → 'HF-NAC-1300' · 'HF-X-C2-C4' → 'HF-X'
 * (g) 'HF-PYGE-4500-WFS' → 'HF-PYGE-4500' · 'HF-VTB2-180-C2-WFS' → 'HF-VTB2-180'
 * A raiz é a identidade do produto físico; é por ela que o filho acha o pai.
 */
function rootOf(sku) {
  const s = normSku(sku);
  let rest = stripWfs(s) || s;
  for (;;) {
    const m = rest.match(/[-_\s]C(\d+)$/);
    if (!m) break;
    const cut = rest.slice(0, rest.length - m[0].length);
    if (!cut) break;
    rest = cut;
  }
  return rest;
}

/** (e) — é serviço/plano/insumo (logo: não é garrafa, não entra no estoque)? */
function isService(sku) {
  const s = normSku(sku);
  if (!s) return true;
  if (SERVICE_EXACT.has(s)) return true;
  return SERVICE_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * Nome de produto limpo, a partir do título da Veeqo. Só usado quando o plano
 * vai CRIAR um produto (e mesmo assim só com create_missing ligado).
 *
 * O título da Veeqo vem carregado de coisa de marketplace:
 *   "Healthfare NAC 1300mg | 120 Capsules | 4 Bottles" → "NAC 1300mg"
 * Tira a marca, corta tudo depois do primeiro '|' (dali pra frente é contagem de
 * cápsulas e tamanho de pacote, que não identificam a garrafa), e tira o sufixo
 * de pacote que sobrar no fim.
 */
function cleanName(title, sku) {
  let t = String(title == null ? '' : title);
  const bar = t.indexOf('|');
  if (bar >= 0) t = t.slice(0, bar);
  t = t
    .replace(/health\s*fare|healthfare|healtfare/ig, ' ')
    // contagem de cápsulas e pacote, quando vêm sem barra
    .replace(/\b\d+\s*(capsules?|caps|count|ct|softgels?|tablets?)\b/ig, ' ')
    .replace(/\b\d+\s*(bottles?|packs?|pk|kit)\b/ig, ' ')
    .replace(/\bpack\s+of\s+\d+\b/ig, ' ')
    .replace(/\bx\s*\d+\s*(kit|pack)?\b/ig, ' ')
    .replace(/[-_\s]C\d+\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-|·,]+|[\s\-|·,]+$/g, '')
    .trim();
  // título inútil (só marca, ou vazio) → cai pro SKU, que pelo menos identifica
  return t || normSku(sku);
}

/**
 * O PLANO. Puro: mesma entrada, mesma saída, sempre, sem tocar em nada.
 *
 * @param {Array} sellables catálogo da Veeqo (veeqo.listSellables()):
 *        [{sku, title, product_title, type:'variant'|'kit', wh, upc_code}]
 * @param {object} current estado de hoje, lido do banco pelo chamador:
 *        {
 *          skus:     [{id, sku, channel, product_id, units_per_pack, is_base}],
 *          products: [{id, canonical_name, nickname, merged_into_product_id}],
 *        }
 * @param {object} opts {channel='veeqo', maxItems=MAX_PLAN_ITEMS}
 * @returns {{link, create, conflicts, ignored, stats}}
 */
function plan(sellables = [], current = {}, opts = {}) {
  const channel = opts.channel || 'veeqo';
  const maxItems = opts.maxItems || MAX_PLAN_ITEMS;

  const curSkus = Array.isArray(current.skus) ? current.skus : [];
  const curProducts = Array.isArray(current.products) ? current.products : [];

  // produto absorvido por um merge não pode virar pai de SKU novo: a garrafa
  // está fisicamente no lugar do pai dele. Todo apontamento sobe pra raiz.
  const productById = new Map();
  for (const p of curProducts) productById.set(Number(p.id), p);
  const rootProduct = (id) => {
    let cur = Number(id);
    for (let i = 0; i < 10; i += 1) {
      const p = productById.get(cur);
      if (!p || p.merged_into_product_id == null) return cur;
      cur = Number(p.merged_into_product_id);
    }
    return cur;
  };

  // ── índice do que JÁ existe ────────────────────────────────────────────────
  const bySku = new Map();          // SKU normalizado → linha atual
  const productsOfRoot = new Map(); // raiz → Set de product_ids que já a usam
  for (const s of curSkus) {
    if (String(s.channel || 'veeqo') !== channel) continue;
    const key = normSku(s.sku);
    if (!key) continue;
    bySku.set(key, s);
    const pid = rootProduct(s.product_id);
    const r = rootOf(key);
    if (!r) continue;
    if (!productsOfRoot.has(r)) productsOfRoot.set(r, new Set());
    productsOfRoot.get(r).add(pid);
  }

  const link = [];
  const create = [];
  const conflicts = [];
  const ignored = [];
  const stats = {
    sellables: 0, mapped: 0, service: 0, invalid: 0,
    link: 0, units_fixed: 0, create: 0, conflicts: 0, ignored: 0, capped: false,
  };

  // (c) — raiz usada por DOIS produtos: reporta uma vez, e trava a raiz inteira.
  // Enquanto dois donos disputam a raiz, ligar um filho novo nela seria escolher
  // o dono no palpite — exatamente o erro que a memória 'merge-safety-rules'
  // manda nunca cometer.
  const contested = new Set();
  for (const [root, owners] of productsOfRoot) {
    if (owners.size < 2) continue;
    contested.add(root);
    const ids = [...owners].sort((a, b) => a - b);
    conflicts.push({
      sku: root,
      kind: 'root_taken_by_two_products',
      detail: {
        root,
        product_ids: ids,
        products: ids.map((id) => {
          const p = productById.get(id) || {};
          return { product_id: id, name: p.canonical_name || null, nickname: p.nickname || null };
        }),
      },
      message: `a raiz ${root} está em ${ids.length} produtos diferentes: junte no hub antes`,
    });
  }

  // (d) — base que já é casepack. Olha o mapeamento de HOJE, produto a produto.
  // Sinaliza, não conserta: HF-BERB-5000 e HF-PANT-500 são reais (a Veeqo não
  // tem avulsa deles), e "consertar" apagaria um fato do mundo.
  const skusOfProduct = new Map();
  for (const s of curSkus) {
    if (String(s.channel || 'veeqo') !== channel) continue;
    const pid = rootProduct(s.product_id);
    if (!skusOfProduct.has(pid)) skusOfProduct.set(pid, []);
    skusOfProduct.get(pid).push(s);
  }
  for (const [pid, list] of skusOfProduct) {
    const marked = list.find((s) => s.is_base);
    const smallest = list.slice().sort((a, b) => unitsOf(a.sku) - unitsOf(b.sku))[0];
    const base = marked || smallest;
    if (!base) continue;
    const units = unitsOf(base.sku);
    if (units <= 1) continue;
    const p = productById.get(pid) || {};
    conflicts.push({
      sku: normSku(base.sku),
      kind: 'base_is_casepack',
      detail: {
        product_id: pid,
        name: p.canonical_name || null,
        nickname: p.nickname || null,
        base_sku: normSku(base.sku),
        base_units_per_pack: units,
      },
      message: `${normSku(base.sku)} é a base de "${p.nickname || p.canonical_name || pid}" mas vale ${units} unidades. `
        + 'Confira se a Veeqo tem listagem avulsa; se não tiver, está certo assim.',
    });
  }

  // ── varredura do catálogo da Veeqo ────────────────────────────────────────
  const seen = new Set();
  // criação por raiz: dois filhos da mesma raiz nova pedem UM produto, não dois
  const createByRoot = new Map();

  for (const s of (sellables || [])) {
    if (!s) continue;
    const sku = normSku(s.sku);
    if (!sku) { stats.invalid += 1; continue; }
    if (seen.has(sku)) continue;      // a Veeqo repete sellable entre páginas
    seen.add(sku);
    stats.sellables += 1;

    if (isService(sku)) {
      stats.service += 1;
      ignored.push({ sku, why: 'service_sku', message: 'SKU de serviço/plano/insumo, não é garrafa' });
      continue;
    }

    const units = unitsOf(sku);
    const root = rootOf(sku);
    const title = s.title || s.product_title || '';
    const existing = bySku.get(sku);

    if (existing) {
      stats.mapped += 1;
      // (b) — o número gravado pode estar errado; o código não está.
      const have = Number(existing.units_per_pack) || 1;
      if (have !== units) {
        link.push({
          sku,
          units_per_pack: units,
          product_id: rootProduct(existing.product_id),
          parent_sku: root === sku ? null : root,
          sku_id: existing.id != null ? Number(existing.id) : null,
          reason: 'units_fix',
          message: `${sku} está como pacote de ${have} e o código diz ${units}`,
        });
        conflicts.push({
          sku,
          kind: 'units_mismatch',
          detail: { sku, stored: have, from_code: units, product_id: rootProduct(existing.product_id) },
          message: `${sku}: gravado ${have}, o código diz ${units}. Vale o código.`,
        });
      }
      continue;
    }

    // SKU NOVO. Quem é o pai? Quem já tem a raiz.
    if (contested.has(root)) {
      ignored.push({ sku, why: 'root_contested',
        message: `a raiz ${root} está disputada por dois produtos; resolva o conflito antes` });
      continue;
    }
    const owners = productsOfRoot.get(root);
    if (owners && owners.size === 1) {
      const productId = [...owners][0];
      const parentRow = bySku.get(root) || null;
      // (g) listagem Walmart liga no dono da raiz igual liga casepack, mas com
      // reason próprio: no Slack e na auditoria "canal novo" e "pacote novo" são
      // notícias diferentes.
      const wfs = isWfs(sku);
      link.push({
        sku,
        units_per_pack: units,
        product_id: productId,
        parent_sku: root === sku ? null : root,
        sku_id: null,
        reason: wfs ? 'wfs_of_root' : (units > 1 ? 'casepack_of_root' : 'same_root'),
        message: wfs
          ? `${sku} é a listagem Walmart WFS de ${root}${units > 1 ? ` (pacote de ${units})` : ''}`
          : (units > 1
            ? `${sku} é pacote de ${units} de ${root}`
            : `${sku} tem a mesma raiz ${root}`),
        title,
        parent_is_mapped: !!parentRow,
      });
      continue;
    }

    // Ninguém tem a raiz: o produto simplesmente não existe aqui ainda.
    // O FILHO nunca cria produto sozinho: um HF-XPTO-C4 que aparece antes do
    // HF-XPTO criaria um produto cujo "base" já é casepack, que é exatamente o
    // conflito (d). O que se cria é a RAIZ; os filhos ligam nela na rodada
    // seguinte (ou nesta mesma, no applier, quando a raiz veio junto).
    const prev = createByRoot.get(root);
    if (prev) {
      prev.children.push({ sku, units_per_pack: units });
      continue;
    }
    const entry = {
      sku: root,
      units: 1,
      title: root === sku ? title : '',
      suggested_name: cleanName(root === sku ? title : title, root),
      seen_as: sku,
      children: root === sku ? [] : [{ sku, units_per_pack: units }],
    };
    createByRoot.set(root, entry);
    create.push(entry);
  }

  // filhos que vieram sem raiz no catálogo: o produto ainda vai ser criado, mas
  // é bom o plano dizer isso em voz alta (é o caso do "-C4 órfão").
  for (const c of create) {
    if (c.seen_as !== c.sku) {
      c.root_not_in_catalog = true;
      c.suggested_name = c.suggested_name || cleanName(c.title, c.sku);
    }
  }

  // teto: corta o que passar, mas NUNCA os conflitos (eles são o aviso, e um
  // aviso cortado é um aviso perdido).
  if (link.length + create.length > maxItems) {
    stats.capped = true;
    const keepLink = Math.min(link.length, maxItems);
    link.length = keepLink;
    create.length = Math.max(0, Math.min(create.length, maxItems - keepLink));
  }

  stats.link = link.length;
  stats.units_fixed = link.filter((l) => l.reason === 'units_fix').length;
  stats.create = create.length;
  stats.conflicts = conflicts.length;
  stats.ignored = ignored.length;

  return { link, create, conflicts, ignored, stats };
}

/**
 * O APPLIER. Escreve SÓ mapeamento: `v3.product_skus` e, com create_missing,
 * uma linha nova em `v3.products`. NUNCA quantidade — StockService é a porta
 * única de escrita de estoque e este módulo nem tem como chamá-la.
 *
 * O que NÃO faz, de propósito: não junta dois produtos. Isso é o "Juntar SKUs"
 * do hub, com gente na frente.
 */
function createSkuSync(deps = {}) {
  const db = deps.db;
  const veeqo = deps.veeqo || null;
  const veeqoCache = deps.veeqoCache || null;
  const channel = deps.channel || 'veeqo';
  // `stock` e `family` entram por contrato (o chamador já os tem montados) mas
  // este módulo NÃO os usa pra escrever: estão aqui pra quem ler o wiring ver
  // que a porta de quantidade continua sendo o StockService, e não esta.
  const family = deps.family || null;

  /** O mapeamento de hoje, direto do banco. Duas leituras, nenhuma escrita. */
  async function loadCurrent() {
    const skus = (await db.query(
      `SELECT id, product_id, sku, channel, units_per_pack, is_base
         FROM v3.product_skus WHERE channel = $1`, [channel])).rows;
    const products = (await db.query(
      `SELECT id, canonical_name, nickname, merged_into_product_id
         FROM v3.products`)).rows;
    return { skus, products };
  }

  /** O catálogo da Veeqo: cache quando existir (SWR), client direto senão. */
  async function loadSellables() {
    if (veeqoCache && typeof veeqoCache.warm === 'function') {
      const map = await veeqoCache.warm();
      const rows = [];
      for (const [sku, info] of Object.entries(map || {})) {
        rows.push({ sku, title: (info && info.title) || '', type: (info && info.type) || null,
          wh: (info && info.wh) || null, upc_code: (info && info.upc) || null });
      }
      if (rows.length) return rows;
    }
    if (veeqo && typeof veeqo.listSellables === 'function') return await veeqo.listSellables();
    return [];
  }

  /** Lê tudo e planeja. Não escreve nada — é o que a rota de preview chama. */
  async function preview(opts = {}) {
    const [sellables, current] = await Promise.all([loadSellables(), loadCurrent()]);
    return plan(sellables, current, opts);
  }

  /**
   * Aplica o plano.
   *
   * @param {object} p resultado de plan()
   * @param {object} opts {create_missing?:boolean, person_id?:number}
   * @returns {{linked, units_fixed, created, skipped, conflicts, products:[]}}
   */
  async function apply(p = {}, opts = {}) {
    const createMissing = opts.create_missing === true;
    const personId = opts.person_id || null;
    const out = { linked: 0, units_fixed: 0, created: 0, skipped: 0,
      conflicts: (p.conflicts || []).length, products: [], links: [] };

    // 1) CRIAÇÃO primeiro, e só se pedirem. Default desligado de propósito: um
    // typo de SKU na Veeqo não pode virar produto no nosso hub sozinho.
    const createdRootToId = new Map();
    if (createMissing) {
      for (const c of (p.create || [])) {
        const name = String(c.suggested_name || c.sku || '').trim();
        if (!name) { out.skipped += 1; continue; }
        // nome já usado = é o MESMO produto cadastrado com outro SKU. Reaproveita
        // a linha existente em vez de criar uma irmã gêmea (canonical_name é
        // UNIQUE; criar de novo estouraria, e criar com nome torto seria pior).
        const existing = (await db.query(
          'SELECT id FROM v3.products WHERE canonical_name = $1', [name])).rows[0];
        let productId;
        if (existing) {
          productId = Number(existing.id);
          out.skipped += 1;
        } else {
          const r = await db.query(
            `INSERT INTO v3.products (canonical_name, active) VALUES ($1, true)
             ON CONFLICT (canonical_name) DO NOTHING RETURNING id`, [name]);
          if (!r.rows[0]) {
            const again = (await db.query(
              'SELECT id FROM v3.products WHERE canonical_name = $1', [name])).rows[0];
            if (!again) { out.skipped += 1; continue; }
            productId = Number(again.id);
          } else {
            productId = Number(r.rows[0].id);
            out.created += 1;
            out.products.push({ product_id: productId, name, sku: c.sku });
          }
        }
        createdRootToId.set(c.sku, productId);
        // a RAIZ vira o SKU base do produto novo (units 1, is_base)
        await _attach({ product_id: productId, sku: c.sku, units_per_pack: 1,
          is_base: true, person_id: personId });
        out.linked += 1;
        out.links.push({ sku: c.sku, product_id: productId, units_per_pack: 1, reason: 'created_base' });
        // e os filhos que vieram junto no mesmo catálogo entram já ligados
        for (const ch of (c.children || [])) {
          await _attach({ product_id: productId, sku: ch.sku,
            units_per_pack: ch.units_per_pack, is_base: false, person_id: personId });
          out.linked += 1;
          out.links.push({ sku: ch.sku, product_id: productId,
            units_per_pack: ch.units_per_pack, reason: 'casepack_of_root' });
        }
      }
    } else {
      out.skipped += (p.create || []).length;
    }

    // 2) LIGAÇÃO e CORREÇÃO DE units — a parte segura, sempre aplicada.
    for (const l of (p.link || [])) {
      const units = Number(l.units_per_pack) > 0 ? Number(l.units_per_pack) : 1;
      const productId = Number(l.product_id);
      if (!productId) { out.skipped += 1; continue; }
      if (l.reason === 'units_fix') {
        // só o número; NÃO reaponta produto (mudar de pai é decisão humana)
        const r = await db.query(
          `UPDATE v3.product_skus SET units_per_pack = $3
            WHERE channel = $1 AND UPPER(sku) = $2 AND units_per_pack <> $3
            RETURNING id`, [channel, l.sku, units]);
        if (r.rows && r.rows[0]) {
          out.units_fixed += 1;
          out.links.push({ sku: l.sku, product_id: productId, units_per_pack: units, reason: 'units_fix' });
        }
        continue;
      }
      const inserted = await _attach({ product_id: productId, sku: l.sku,
        units_per_pack: units, is_base: false, person_id: personId });
      if (inserted) {
        out.linked += 1;
        out.links.push({ sku: l.sku, product_id: productId, units_per_pack: units,
          reason: l.reason || 'same_root' });
      } else {
        out.skipped += 1;
      }
    }

    return out;
  }

  /**
   * INSERT ... ON CONFLICT DO NOTHING. "DO NOTHING", não "DO UPDATE": um SKU que
   * já está em algum produto foi posto ali por uma pessoa ou por uma rodada
   * anterior, e um worker não repõe mapeamento humano no automático. Isso é o
   * que torna a rodada IDEMPOTENTE: a segunda passada não muda nada.
   *
   * confirmed_at = NOW() de propósito: o planner só liga por regra EXATA de
   * raiz, nunca por palpite, e isso é a própria definição de confirmado. Sem
   * isso a linha nasceria invisível pro veeqo-order-sync, que só carrega
   * mapeamento com confirmed_at (foi o bug que escondeu ~200 SKUs ligados até
   * 09-02).
   * @returns {boolean} true se a linha nasceu agora
   */
  async function _attach(a) {
    const r = await db.query(
      `INSERT INTO v3.product_skus (product_id, sku, channel, units_per_pack, is_base, confirmed_by_person_id, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (channel, sku) DO NOTHING
       RETURNING id`,
      [Number(a.product_id), a.sku, channel, Number(a.units_per_pack) || 1,
        !!a.is_base, a.person_id || null]);
    return !!(r.rows && r.rows[0]);
  }

  /** preview + apply numa chamada (o worker e a rota de apply usam isto). */
  async function run(opts = {}) {
    const p = await preview(opts);
    const applied = await apply(p, opts);
    return { plan: p, applied };
  }

  return { plan, preview, apply, run, loadCurrent, loadSellables, family };
}

module.exports = { createSkuSync, plan, unitsOf, rootOf, isWfs, isService, cleanName, normSku,
  SERVICE_PREFIXES, SERVICE_EXACT, MAX_PLAN_ITEMS };
