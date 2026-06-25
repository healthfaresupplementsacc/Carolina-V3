'use strict';
/**
 * HEALTHFARE V3 — NoteAnalyzer (regra Bruno 06-22).
 *
 * Lê motivos/notas dos operadores com o Gemini (caminho CONTIDO, separado do
 * Observer shadow) e — CONSERVADOR — só age quando relevante:
 *   • precisa_admin=true → manda uma nota pro canal do ADMIN (algo que o gerente
 *     precisa saber: máquina quebrada, erro, falta, atraso, acidente, etc).
 *   • quantidade_mencionada (a pessoa diz que fez X ordens/bottles na nota) MAS
 *     não registrou contagem batendo com isso → avisa no canal dos OPERADORES.
 *
 * Gated por NOTE_LLM_ENABLED=true. Fire-and-forget (nunca bloqueia o request,
 * nunca derruba nada — try/catch total). Custo: Gemini Flash, 1 call por nota.
 */
const EDT = 'America/New_York';

const SYSTEM = [
  'Você lê uma nota/motivo escrita por um operador de uma linha de produção de suplementos (PT-BR).',
  'Entenda o que está acontecendo e responda SOMENTE JSON, sem texto fora do JSON:',
  '{"resumo": string (1 frase curta),',
  ' "precisa_admin": boolean,  // true SÓ se o gerente precisa saber: máquina quebrada, erro, falta de material, atraso relevante, acidente, retrabalho, algo fora do normal. Rotina/ok = false.',
  ' "motivo_admin": string|null,  // se precisa_admin, 1 frase do porquê',
  ' "quantidade_mencionada": number|null  // se a pessoa DIZ na nota que fez/contou/imprimiu/empacotou um número de ordens ou bottles, o número; senão null',
  '}',
].join('\n');

class NoteAnalyzer {
  constructor(deps = {}) {
    this.db = deps.db;
    this.slack = deps.slack || null;
    this.provider = deps.provider || null; // GeminiProvider (classifyRaw)
    this.adminChannel = deps.adminChannelId || process.env.V3_ADMIN_CHANNEL || 'C0B36DR5MP1';
    this.enabled = deps.enabled !== undefined ? deps.enabled : (process.env.NOTE_LLM_ENABLED === 'true');
  }

  /** Dispara a análise sem bloquear (fire-and-forget). */
  queue(input) {
    if (!this.enabled || !this.provider) return;
    const text = String((input && input.text) || '').trim();
    if (text.length < 4) return;        // notas vazias/curtas não valem call
    if (input && input.isSandbox) return; // sandbox não gera ruído
    this.analyze(input).catch((e) => console.error('[note-llm] falhou:', e.message));
  }

  async analyze(input) {
    const text = String(input.text || '').trim();
    const user = `Operador: ${input.personName || '?'}\nTarefa: ${input.slug || '—'}\nNota/motivo: "${text.slice(0, 800)}"`;
    const r = await this.provider.classifyRaw(SYSTEM, user, { maxTokens: 400 });
    const j = r && r.json_parsed;
    if (!j) return;
    // 1) precisa de atenção do admin
    if (j.precisa_admin && this.slack && this.slack.postAs) {
      try {
        await this.slack.postAs({
          channel: this.adminChannel, sender: { name: 'Carolina' }, thread_ts: null, unfurl_links: false, unfurl_media: false,
          text: `:brain: *Nota de ${input.personName || 'operador'}* (${input.slug || '—'}): _"${text.slice(0, 220)}"_\n→ ${j.motivo_admin || j.resumo || 'merece atenção'}`,
        });
      } catch (e) { console.error('[note-llm] admin post:', e.message); }
    }
    // 2) quantidade mencionada mas NÃO registrada → avisa os operadores
    const qty = Number(j.quantidade_mencionada);
    if (Number.isFinite(qty) && qty > 0 && input.personId && this.db) {
      let recorded = false;
      try {
        const c = await this.db.query(
          `SELECT 1 FROM v3.production_counts
            WHERE reported_by_person_id = $1 AND deleted_at IS NULL
              AND production_date = (NOW() AT TIME ZONE '${EDT}')::date
              AND ABS(bottles - $2) <= GREATEST(2, ($2 * 0.05)) LIMIT 1`, [input.personId, qty]);
        recorded = c.rowCount > 0;
      } catch (e) { /* sem check → assume não registrado, mas evita falso-alarme: só avisa se a query rodou */ recorded = true; }
      if (!recorded && this.slack && this.slack.postAs) {
        try {
          // REVIEW MODE (Bruno 06-22): vai pro canal ADMIN pra revisar antes de
          // liberar no grupo normal. Quando 100%, trocar p/ 'production'.
          await this.slack.postAs({
            channel: this.adminChannel, sender: { name: 'HealthFare Tracker (revisão)', icon: ':memo:' }, thread_ts: null, unfurl_links: false, unfurl_media: false,
            text: `:memo: *${input.personName || 'Operador'}* mencionou *${qty}* na nota (_"${text.slice(0, 160)}"_) mas não registrou essa contagem no sistema. Confiram / registrem no aplicativo da linha de produção.`,
          });
        } catch (e) { console.error('[note-llm] qty post:', e.message); }
      }
    }
  }
}

module.exports = { NoteAnalyzer };
