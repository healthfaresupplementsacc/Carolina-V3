'use strict';
/**
 * HEALTHFARE V4 — Veeqo Rate Shopping API, cliente de COTAÇÃO (FASE A do
 * copiloto de frete, estudo S15-VEEQO-LABEL-API-STUDY, Bruno deu o go).
 *
 * Só cota. NUNCA compra, NUNCA imprime, NUNCA cancela: a Fase A é conselho.
 * Por isso TODA falha (rede, timeout, chave, 4xx/5xx, JSON quebrado) vira
 * `null` e nunca exceção — cotar é acessório do freight-watch e um tick de
 * watch não pode morrer porque a API de rates espirrou.
 *
 * Endpoint TESTADO AO VIVO na conta (08-28): POST
 * https://api.veeqo.com/shipping/api/v1/rates, header x-api-key (a MESMA
 * VEEQO_API_KEY de sempre), body {from_address, to_address, parcels,
 * customer_reference} — customer_reference é OBRIGATÓRIO (validation error sem
 * ele). Resposta {quotes:[{rate_id, service_name, carrier_id,
 * delivery_estimate, total_charge, charges[]}]}.
 *
 * Peso: a Veeqo guarda gramas, a API de rates pede lb → max(0.1, g/453.592)
 * arredondado em 2 casas. Dimensões FIXAS 8x5x2in: o envelope típico medido;
 * provado nos testes ao vivo que o preço não mexe com as dims nos nossos
 * tamanhos, então um número fixo honesto vale mais que um campo que ninguém
 * preenche.
 *
 * BANNED: Media Mail / Bound Printed Matter / Library Mail são restritas a
 * livros e mídia — suplemento NÃO PODE ir nelas. Cotação dessas nunca é
 * "válida" por mais barata que seja (mandar recomprar Media Mail seria
 * aconselhar infração postal).
 */

const RATES_URL = 'https://api.veeqo.com/shipping/api/v1/rates';
const LB_G = 453.592;
const TIMEOUT_MS = 15000;

// Origem fixa: o galpão. Cotação é sempre daqui pra fora.
const FROM_ADDRESS = {
  name: 'HealthFare', line1: '3389 Sheridan St', town: 'Fort Lauderdale',
  postcode: '33309', country_code: 'US', county: 'FL', phone: '+19545551234',
};

const BANNED = /media mail|bound printed|library/i;

/** Gramas → lb da API (mínimo 0.1, duas casas). */
function poundsOf(weightG) {
  const g = Number(weightG);
  const lb = Number.isFinite(g) && g > 0 ? g / LB_G : 0;
  return Math.max(0.1, Math.round(lb * 100) / 100);
}

/** Cotações VÁLIDAS: preço > 0 e serviço que suplemento pode usar. */
function validQuotes(quotes) {
  return (quotes || []).filter((q) => q && Number(q.price) > 0 && !BANNED.test(String(q.name || '')));
}

/**
 * A melhor cotação válida.
 * Com dueDate: a MAIS BARATA cujo delivery_estimate <= dueDate — se pelo menos
 * uma qualifica. Se NENHUMA chega no prazo (ou sem dueDate), a mais barata
 * válida geral: prazo estourado é problema pra humano decidir, não motivo pra
 * esconder o preço; e o delivery_estimate da transportadora é estimativa, não
 * contrato. Escolha documentada no estudo (regra "mais barata válida que chega
 * no prazo").
 * @returns {{name,price,delivery_estimate,rate_id}|null}
 */
function bestValid(quotes, { dueDate } = {}) {
  const valid = validQuotes(quotes);
  if (!valid.length) return null;
  const byPrice = (a, b) => Number(a.price) - Number(b.price);
  if (dueDate) {
    const due = Date.parse(dueDate);
    if (Number.isFinite(due)) {
      const onTime = valid.filter((q) => {
        const est = q.delivery_estimate ? Date.parse(q.delivery_estimate) : NaN;
        return Number.isFinite(est) && est <= due;
      });
      if (onTime.length) return onTime.slice().sort(byPrice)[0];
    }
  }
  return valid.slice().sort(byPrice)[0];
}

/**
 * @param {{apiKey?:string, fetchImpl?:Function, timeoutMs?:number}} opts
 * @returns {{configured:Function, quoteParcel:Function}}
 */
function createRatesClient(opts = {}) {
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : process.env.VEEQO_API_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  function configured() { return !!apiKey; }

  /**
   * Cota um envio. Qualquer falha → null (conselho que falhou é conselho que
   * não existe; o alerta diz "nao consegui cotar" e a vida segue).
   * @param {{dest_zip:string, dest_state?:string, weight_g:number, reference:string|number}} p
   * @returns {Promise<{quotes:Array<{name,price,delivery_estimate,rate_id}>}|null>}
   */
  async function quoteParcel({ dest_zip, dest_state, weight_g, reference }) {
    if (!apiKey || !dest_zip) return null;
    const body = {
      from_address: FROM_ADDRESS,
      to_address: {
        name: 'Destinatario', line1: '-', town: '-',
        postcode: String(dest_zip), country_code: 'US',
        county: dest_state ? String(dest_state) : '-', phone: '+19545551234',
      },
      parcels: [{
        weight: poundsOf(weight_g), weight_unit: 'lb',
        height: 2, width: 5, length: 8, dimension_unit: 'in',
      }],
      // OBRIGATÓRIO na API (validation error sem ele); prefixo HF-QUOTE- deixa
      // claro no painel da Veeqo que foi o copiloto cotando, não uma compra.
      customer_reference: 'HF-QUOTE-' + String(reference),
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(RATES_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r || !r.ok) return null;
      const j = await r.json();
      const quotes = (j && j.quotes) || [];
      return {
        quotes: quotes.map((q) => ({
          name: q.service_name || '',
          price: q.total_charge != null ? Number(q.total_charge) : null,
          delivery_estimate: q.delivery_estimate || null,
          rate_id: q.rate_id || null,
        })),
      };
    } catch (e) {
      return null;                       // rede/timeout/JSON: conselho ausente, nunca erro
    } finally {
      clearTimeout(t);
    }
  }

  return { configured, quoteParcel };
}

module.exports = { createRatesClient, validQuotes, bestValid, poundsOf, BANNED };
