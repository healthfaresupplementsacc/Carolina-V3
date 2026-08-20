'use strict';
/**
 * HEALTHFARE V3 — veeqo-sku-sync (S15.39, Bruno 08-19).
 *
 * POR QUE EXISTE, nas palavras do Bruno: "pq q ele nao ta mapeado se ta tudo la
 * no Veeqo?". O mapeamento SKU↔produto era feito à mão, casando por nome, e por
 * isso 315 dos 483 sellables da Veeqo estavam órfãos: pedido do HF-NAC-1300-C4
 * não reservava, não deduzia, e só aparecia quando falhava. O backlog foi
 * consertado na mão hoje. Este worker é o que impede o PRÓXIMO SKU novo de
 * nascer órfão e ser descoberto por um pedido quebrado.
 *
 * A CADA 6 HORAS (mais uma primeira rodada 3 min depois do boot, pro deploy já
 * dizer o que encontrou):
 *   1. plan()   — puro, olha a Veeqo e o nosso mapeamento;
 *   2. aplica a PARTE SEGURA sempre: liga SKU novo no pai que já tem a raiz e
 *      corrige units_per_pack errado (o código do SKU manda, não a coluna);
 *   3. cria produto novo SÓ com SKU_SYNC_CREATE_PRODUCTS='true' (default OFF:
 *      um typo de SKU na Veeqo não pode virar linha no hub sozinho);
 *   4. ABSORVE o descritivo (S15.41): título, marca, descrição, UPC, tipo e FOTO
 *      de cada SKU passam a morar aqui, mais um snapshot cru da Veeqo inteira.
 *      Pergunta do Bruno: "se a gente fechar nossa conta do veeqo hj vc vai ter
 *      tdas as info que precisamos correto?" — o passo 4 é o que faz a resposta
 *      virar sim. Mesma tick, mesmo opt-in: mapear e descrever são a mesma
 *      leitura do mesmo catálogo, e dois workers lendo a Veeqo em horários
 *      diferentes dariam duas verdades diferentes sobre o mesmo SKU.
 *   5. avisa no admin-orin SÓ quando aconteceu algo ou existe conflito.
 *
 * NUNCA escreve quantidade. Este worker mexe só em mapeamento (v3.product_skus /
 * v3.products); StockService continua sendo a porta única de estoque.
 * NUNCA junta dois produtos sozinho: conflito vira aviso, o merge é humano no
 * hub ("Juntar SKUs"), porque merge errado manda a garrafa errada pro cliente.
 *
 * Canal: admin-orin (o operador não tem o que fazer com "a Veeqo tem SKU novo"),
 * mesmo remetente e estilo do stock-drift-alert. Sem em dash, no máximo 1 emoji.
 * OPT-IN: WORKER_VEEQO_SKU_SYNC_ENABLED=true.
 */
const EDT = 'America/New_York';
const MAX_LINES = 10;      // aviso maior que isso vira parede de texto

class VeeqoSkuSync {
  /**
   * @param {object} deps
   *   deps.db         pool pg
   *   deps.sync       createSkuSync({db, veeqo|veeqoCache}) — preview/apply
   *   deps.absorb     createVeeqoAbsorb({db, veeqo}) — run() (opcional; sem ele
   *                   a tick faz só o mapeamento, exatamente como antes)
   *   deps.slack      { postAs }
   *   deps.channelId  admin-orin
   */
  constructor(deps = {}) {
    this.db = deps.db;
    this.sync = deps.sync || null;
    this.absorb = deps.absorb || null;
    this.slack = deps.slack || null;
    this.channelId = deps.channelId || 'C0B36DR5MP1';
    this.enabled = deps.enabled !== undefined ? deps.enabled
      : (process.env.WORKER_VEEQO_SKU_SYNC_ENABLED === 'true');
    this.createProducts = deps.createProducts !== undefined ? deps.createProducts
      : (process.env.SKU_SYNC_CREATE_PRODUCTS === 'true');
    this.heartbeat = deps.heartbeat || null;
    this.now = deps.now || (() => new Date());
    this._t = null; this._kick = null; this._ticking = false;
  }

  start(ms = 6 * 60 * 60 * 1000) {
    // 3 min depois do boot: tempo do pool subir e do cache da Veeqo esquentar,
    // e cedo o bastante pro deploy já contar o que achou.
    this._kick = setTimeout(() => this.tick().catch((e) => console.error('[sku-sync] erro:', e.message)), 3 * 60 * 1000);
    this._t = setInterval(() => this.tick().catch((e) => console.error('[sku-sync] erro:', e.message)), ms);
    console.log('[V3] veeqo-sku-sync ligado (' + (this.enabled ? 'ON' : 'OFF')
      + ', criar produtos: ' + (this.createProducts ? 'ON' : 'OFF') + ')');
  }

  stop() {
    if (this._t) clearInterval(this._t);
    if (this._kick) clearTimeout(this._kick);
    this._t = null; this._kick = null;
  }

  _nyDate() {
    return this.now().toLocaleDateString('en-CA', { timeZone: EDT });
  }

  /** Já avisei isso hoje? Dedupe por dia NY + assinatura do que mudou. */
  async _posted(nyDate, sig) {
    const r = await this.db.query(
      `SELECT 1 FROM v3.audit_log
        WHERE action = 'sku_sync'
          AND metadata->>'ny_date' = $1 AND metadata->>'sig' = $2 LIMIT 1`,
      [nyDate, sig]);
    return (r.rowCount || 0) > 0;
  }

  async _mark(nyDate, sig, info) {
    await this.db.query(
      `INSERT INTO v3.audit_log (actor_type, actor_person_id, action, target_type, target_id, metadata)
       VALUES ('system', NULL, 'sku_sync', 'stock', NULL, $1::jsonb)`,
      [JSON.stringify({ ny_date: nyDate, sig, ...info })]).catch(() => {});
  }

  async _post(text) {
    if (!(this.slack && this.slack.postAs)) return false;
    try {
      await this.slack.postAs({
        channel: this.channelId,
        sender: { name: 'HealthFare Estoque', icon: ':package:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      return true;
    } catch (e) { console.error('[sku-sync] post falhou:', e.message); return false; }
  }

  /**
   * A MENSAGEM. Curta, em português, dizendo o que MUDOU e o que precisa de
   * gente. Nunca lista o catálogo inteiro: quem quiser detalhe abre o hub.
   */
  _message(applied, planOut) {
    const lines = [];
    for (const l of (applied.links || []).slice(0, MAX_LINES)) {
      if (l.reason === 'units_fix') {
        lines.push(`• ${l.sku} corrigido para pacote de ${l.units_per_pack}`);
      } else if (l.reason === 'created_base') {
        lines.push(`• ${l.sku} virou produto novo`);
      } else if (Number(l.units_per_pack) > 1) {
        lines.push(`• ${l.sku} ligado no produto ${l.product_id} (pacote de ${l.units_per_pack})`);
      } else {
        lines.push(`• ${l.sku} ligado no produto ${l.product_id}`);
      }
    }
    const extra = (applied.links || []).length - lines.length;
    if (extra > 0) lines.push(`• e mais ${extra}`);

    const conflicts = planOut.conflicts || [];
    const orphans = (planOut.create || []).length;
    if (orphans && !this.createProducts) {
      lines.push(`• ${orphans} SKU${orphans > 1 ? 's' : ''} sem pai: conferir no Estoque`);
    }
    const twoOwners = conflicts.filter((c) => c.kind === 'root_taken_by_two_products').length;
    if (twoOwners) {
      lines.push(`• ${twoOwners} raiz${twoOwners > 1 ? 'es' : ''} em dois produtos: juntar no hub`);
    }
    const baseCase = conflicts.filter((c) => c.kind === 'base_is_casepack').length;
    if (baseCase) {
      lines.push(`• ${baseCase} produto${baseCase > 1 ? 's' : ''} com base de casepack: confira se a Veeqo tem avulsa`);
    }
    if (!lines.length) return null;
    return ':link: *SKUs novos da Veeqo*\n' + lines.join('\n');
  }

  /**
   * A MENSAGEM DA ABSORÇÃO (S15.41). Bloco SEPARADO do mapeamento porque são
   * duas notícias diferentes: "apareceu SKU novo" pede ação, "absorvi 12 títulos"
   * é só tranquilizar que o catálogo está guardado aqui.
   *
   * Só sai quando ALGO mudou. Sistema em dia = silêncio (regra (c) do absorb).
   */
  _absorbMessage(a) {
    if (!a) return null;
    const lines = [];
    if (a.updated) lines.push(`• ${a.updated} SKU${a.updated > 1 ? 's' : ''} com titulo e dados atualizados`);
    if (a.barcode_filled) lines.push(`• ${a.barcode_filled} codigo${a.barcode_filled > 1 ? 's' : ''} de barra copiado${a.barcode_filled > 1 ? 's' : ''} da Veeqo`);
    if (a.images_downloaded) lines.push(`• ${a.images_downloaded} foto${a.images_downloaded > 1 ? 's' : ''} baixada${a.images_downloaded > 1 ? 's' : ''}`);
    if (!lines.length) return null;
    return ':package: *Veeqo absorvido*\n' + lines.join('\n');
  }

  async tick() {
    if (this._ticking || !this.enabled || !this.sync) return { skipped: true };
    this._ticking = true;
    try { this.heartbeat && this.heartbeat(); } catch (_) {}
    try {
      const planOut = await this.sync.preview();
      const applied = await this.sync.apply(planOut, { create_missing: this.createProducts });

      // ABSORÇÃO (S15.41) — DEPOIS do mapeamento, de propósito: absorver o
      // descritivo de um SKU que ainda não tem linha em product_skus não teria
      // onde gravar. Isolada em try: falha de rede na foto não pode desfazer nem
      // esconder o mapeamento que já deu certo.
      let absorbed = null;
      if (this.absorb && typeof this.absorb.run === 'function') {
        try {
          const r = await this.absorb.run();
          absorbed = r && r.applied ? r.applied : null;
        } catch (e) {
          console.error('[sku-sync] absorção falhou:', e.message);
        }
      }

      const conflicts = (planOut.conflicts || []).length;
      const changed = (applied.linked || 0) + (applied.units_fixed || 0) + (applied.created || 0);
      const orphans = (planOut.create || []).length;
      const absorbedN = absorbed
        ? (absorbed.updated || 0) + (absorbed.barcode_filled || 0) + (absorbed.images_downloaded || 0)
        : 0;
      const out = {
        scanned: (planOut.stats && planOut.stats.sellables) || 0,
        linked: applied.linked || 0, units_fixed: applied.units_fixed || 0,
        created: applied.created || 0, conflicts, orphans, posted: false,
        absorbed: absorbed || null,
      };

      // silêncio é resposta válida: nada mudou e nada pendente → não fala nada.
      if (!changed && !conflicts && !orphans && !absorbedN) return out;

      // duas notícias diferentes, dois blocos. A absorção pode ter mexido em algo
      // sem que o mapeamento tenha mudado nada (é o caso comum depois do primeiro
      // dia): aí sai só o bloco de baixo.
      const parts = [this._message(applied, planOut), this._absorbMessage(absorbed)]
        .filter(Boolean);
      if (!parts.length) return out;
      const text = parts.join('\n\n');

      // dedupe por dia NY + assinatura: o worker roda 4x por dia e a mesma
      // pendência (ex.: 2 raízes disputadas que ninguém resolveu ainda) não pode
      // virar 4 mensagens iguais. Mudou alguma coisa → assinatura nova → fala.
      const nyDate = this._nyDate();
      const sig = [out.linked, out.units_fixed, out.created, conflicts, orphans,
        absorbed ? (absorbed.updated || 0) : 0,
        absorbed ? (absorbed.barcode_filled || 0) : 0,
        absorbed ? (absorbed.images_downloaded || 0) : 0].join(':');
      if (await this._posted(nyDate, sig)) return out;

      await this._post(text);
      await this._mark(nyDate, sig, { linked: out.linked, units_fixed: out.units_fixed,
        created: out.created, conflicts, orphans,
        absorbed_updated: absorbed ? (absorbed.updated || 0) : 0,
        images: absorbed ? (absorbed.images_downloaded || 0) : 0 });
      out.posted = true;
      return out;
    } finally { this._ticking = false; }
  }
}

module.exports = { VeeqoSkuSync, MAX_LINES };
