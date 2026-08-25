'use strict';
/**
 * HEALTHFARE V4 — PIPELINE DE INCIDENTE (Bruno 08-25, palavras dele).
 *
 * "se der erro eu quero que ele alerte vc ou algum webhook que o claude vai
 *  trabalhar nisso e me avisar por slack 'o erro tal ta acontecendo, claude tal
 *  ta trabalhando nisso, informacao sobre o erro registrado no obsidian no folder
 *  blablabla com todos os dados em caso vc queira investigar mais a fundo'"
 *
 * Um incidente faz TRÊS coisas, nesta ordem:
 *   1. LINHA em v3.incidents  → o registro que sobrevive a redeploy.
 *   2. DOSSIÊ em Markdown     → todos os dados crus, pra investigar depois.
 *   3. UMA mensagem no Slack  → curta, no admin-orin, sem em dash, 1 emoji.
 *
 * O DOSSIÊ E O PROBLEMA DO G:
 * O Obsidian vive em `G:\My Drive\...` que é uma pasta do Google Drive na máquina
 * do Bruno. O servidor roda no RAILWAY e NÃO TEM G:. Se eu escrevesse direto,
 * todo incidente em produção iria falhar exatamente na hora em que ele mais
 * importa. Solução: o filesystem é INJETADO (deps.fs). Sem fs utilizável, o
 * markdown inteiro fica em v3.incidents.detail->>'dossier_md' e dossier_path
 * guarda o caminho PRETENDIDO. Depois, de uma máquina que tem o G:, roda-se
 * flushDossiers({ db, fs }) e os dossiês pendentes viram arquivo de verdade.
 * Nada se perde, nada quebra.
 *
 * Este módulo NUNCA escreve estoque, nunca posta no canal dos operadores, e
 * nunca diz que o Claude consertou alguma coisa. Só que o caso foi registrado.
 */

const EDT = 'America/New_York';
const ADMIN_CHANNEL = 'C0B36DR5MP1';                          // admin-orin
const VAULT_DIR = 'G:\\My Drive\\Clinic\\Obsidian Bruno\\HealthFare\\Production Line Tracker\\Incidentes';

/** "2026-08-25 1432" em NY. Nome de arquivo do dossiê. */
function stamp(now) {
  const d = now || new Date();
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDT, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value || '00';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}${g('minute')}`;
}

/** Data NY (YYYY-MM-DD) — a chave de dedupe por dia. */
function nyDate(now) {
  return (now || new Date()).toLocaleDateString('en-CA', { timeZone: EDT });
}

/** HH:MM NY, pro texto curto do Slack. */
function nyTime(d) {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(t.getTime())) return null;
  return t.toLocaleTimeString('pt-BR', { timeZone: EDT, hour: '2-digit', minute: '2-digit' });
}

/** Nome do arquivo do dossiê. Sem caractere proibido no Windows.
 *  Separador é hífen simples, NÃO em dash: este nome entra na mensagem do Slack
 *  ("Detalhes completos no Obsidian: Incidentes/<arquivo>") e a regra de estilo do
 *  Bruno proíbe em dash em texto que ele lê. */
function dossierName(code, now) {
  const safe = String(code || 'incidente').replace(/[\\/:*?"<>|]/g, '-');
  return `${stamp(now)} - ${safe}.md`;
}

/**
 * O DOSSIÊ. Tudo em PT-BR, com os dados crus embutidos, porque o objetivo é
 * que o Bruno consiga investigar sozinho meses depois sem precisar de mim.
 * dossier = { o_que_aconteceu, desde, esperado, observado, afeta[], dados_crus{} }
 */
function buildDossier({ code, title, detail, fix_hint, dossier }, now) {
  const d = dossier || {};
  const at = now || new Date();
  const L = [];
  L.push(`# ${title}`);
  L.push('');
  L.push(`- Código: \`${code}\``);
  L.push(`- Aberto em: ${at.toLocaleString('pt-BR', { timeZone: EDT })} (Nova York)`);
  L.push(`- Registrado automaticamente pelo watchdog de sinais.`);
  L.push('');
  L.push('## O que aconteceu');
  L.push(d.o_que_aconteceu || title);
  if (d.desde) { L.push(''); L.push(`Desde: **${d.desde}**.`); }
  L.push('');
  L.push('## O que o sistema esperava');
  L.push(d.esperado || 'Sinal chegando dentro do intervalo configurado.');
  L.push('');
  L.push('## O que o sistema viu de verdade');
  L.push(d.observado || 'Nada chegou.');
  L.push('');
  L.push('## O que isso afeta');
  const af = Array.isArray(d.afeta) ? d.afeta : (d.afeta ? [d.afeta] : []);
  if (af.length) for (const a of af) L.push(`- ${a}`);
  else L.push('- Ainda não mapeado.');
  L.push('');
  L.push('## Primeira coisa a conferir');
  L.push(fix_hint || 'Sem pista automática. Olhar os logs do Railway e a página Sistema.');
  L.push('');
  L.push('## Dados crus');
  L.push('Tudo que foi consultado no momento em que o incidente abriu.');
  L.push('');
  L.push('```json');
  let raw;
  try {
    raw = JSON.stringify({ code, detail: detail || {}, dados: d.dados_crus || {} }, null, 2);
  } catch (_) { raw = '{ "erro": "payload não serializável" }'; }
  L.push(raw);
  L.push('```');
  L.push('');
  L.push('---');
  L.push('Arquivo gerado pelo sistema. Não editar o cabeçalho; anotações humanas podem ir no fim.');
  L.push('');
  return L.join('\n');
}

/**
 * A MENSAGEM DO SLACK, no formato exato que o Bruno pediu.
 * Curta, PT-BR com acento, SEM em dash, no máximo 1 emoji.
 */
function buildSlackText({ title, oneLine, fileName, fixHint }) {
  const L = [];
  L.push(`:rotating_light: *${title}*`);
  L.push(oneLine);
  L.push('Claude já está trabalhando nisso.');
  L.push(`Detalhes completos no Obsidian: Incidentes/${fileName}`);
  if (fixHint) L.push(`Primeira coisa a conferir: ${fixHint}`);
  return L.join('\n');
}

/** O fs injetado serve? (Railway não tem G:, então isso costuma ser false lá.) */
function _fsUsable(fs) {
  return !!(fs && typeof fs.writeFileSync === 'function' && typeof fs.mkdirSync === 'function');
}

/**
 * Abre um incidente. Devolve { id, code, dossier_path, dossier_written, slack_ts, text }.
 * NUNCA lança: se o Slack ou o disco falharem, a linha no banco ainda existe.
 *
 * @param {object} deps  { db, slack:{postAs}, channelId, fs?, vaultDir?, now? }
 * @param {object} inc   { code, title, detail, fix_hint, dossier, oneLine? }
 */
async function openIncident(deps, inc) {
  const db = deps.db;
  const slack = deps.slack || null;
  const channelId = deps.channelId || ADMIN_CHANNEL;
  const fs = deps.fs || null;
  const vaultDir = deps.vaultDir || VAULT_DIR;
  const now = (deps.now ? deps.now() : new Date());

  const code = String(inc.code || 'incidente');
  const title = String(inc.title || code);
  const detail = inc.detail || {};
  const fixHint = inc.fix_hint || (inc.dossier && inc.dossier.fix_hint) || null;

  const fileName = dossierName(code, now);
  const md = buildDossier({ code, title, detail, fix_hint: fixHint, dossier: inc.dossier }, now);
  const path = vaultDir.replace(/[\\/]+$/, '') + '\\' + fileName;

  // 1) tenta escrever o dossiê AGORA (só funciona na máquina que tem o G:)
  let written = false;
  if (_fsUsable(fs)) {
    try {
      fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(path, md, 'utf8');
      written = true;
    } catch (e) {
      written = false;   // sem G: (Railway) ou sem permissão: o markdown fica no banco
    }
  }

  // 2) linha no banco. O markdown vai junto quando o arquivo não pôde ser escrito,
  //    pra flushDossiers() poder criá-lo depois de uma máquina que tenha o vault.
  const payload = Object.assign({}, detail, {
    dossier_pending: !written,
    dossier_file: fileName,
  });
  if (!written) payload.dossier_md = md;

  let id = null;
  try {
    const r = await db.query(
      `INSERT INTO v3.incidents (code, title, detail, status, opened_at, dossier_path)
       VALUES ($1, $2, $3::jsonb, 'open', NOW(), $4)
       RETURNING id`,
      [code, title, JSON.stringify(payload), path]);
    id = r.rows && r.rows[0] ? r.rows[0].id : null;
  } catch (e) {
    console.error('[incident] insert falhou:', e.message);
  }

  // 3) UMA mensagem no admin-orin. Nunca no canal dos operadores: o operador não
  //    tem o que fazer com "um push parou de chegar".
  const oneLine = inc.oneLine || (inc.dossier && inc.dossier.o_que_aconteceu) || title;
  const text = buildSlackText({ title, oneLine, fileName, fixHint });
  let ts = null;
  if (slack && typeof slack.postAs === 'function') {
    try {
      const res = await slack.postAs({
        channel: channelId,
        sender: { name: 'HealthFare Vigia', icon: ':rotating_light:' },
        thread_ts: null, unfurl_links: false, unfurl_media: false, text,
      });
      ts = (res && res.ts) || null;
      if (ts && id != null) {
        await db.query('UPDATE v3.incidents SET slack_ts = $2 WHERE id = $1', [id, String(ts)]).catch(() => {});
      }
    } catch (e) { console.error('[incident] post falhou:', e.message); }
  }

  return { id, code, dossier_path: path, dossier_file: fileName, dossier_written: written, dossier_md: md, slack_ts: ts, text };
}

/** Fecha o incidente aberto mais recente desse código. Devolve quantos fechou. */
async function resolveIncident(deps, code, note) {
  const db = deps.db;
  try {
    const r = await db.query(
      `UPDATE v3.incidents SET status = 'resolved', resolved_at = NOW(),
              detail = COALESCE(detail, '{}'::jsonb) || $2::jsonb
        WHERE id IN (SELECT id FROM v3.incidents WHERE code = $1 AND status <> 'resolved'
                      ORDER BY opened_at DESC LIMIT 1)
        RETURNING id`,
      [String(code), JSON.stringify({ resolvido: note || 'sinal voltou' })]);
    return r.rowCount || 0;
  } catch (e) { console.error('[incident] resolve falhou:', e.message); return 0; }
}

/**
 * Grava no Obsidian os dossiês que ficaram pendentes (abertos no Railway, sem G:).
 * Roda de uma máquina que TEM o vault. Idempotente: depois de gravar, tira o
 * markdown do banco e marca dossier_pending=false, então rodar duas vezes não
 * reescreve nada.
 */
async function flushDossiers(deps) {
  const db = deps.db;
  const fs = deps.fs || null;
  const vaultDir = deps.vaultDir || VAULT_DIR;
  if (!_fsUsable(fs)) return { written: 0, skipped: 'sem filesystem' };

  let rows = [];
  try {
    const r = await db.query(
      `SELECT id, code, dossier_path, detail->>'dossier_md' AS md, detail->>'dossier_file' AS file
         FROM v3.incidents
        WHERE detail->>'dossier_md' IS NOT NULL
        ORDER BY opened_at ASC LIMIT 200`);
    rows = r.rows || [];
  } catch (e) { return { written: 0, error: e.message }; }

  try { fs.mkdirSync(vaultDir, { recursive: true }); } catch (_) {}

  let written = 0;
  const failed = [];
  for (const row of rows) {
    const path = row.dossier_path
      || (vaultDir.replace(/[\\/]+$/, '') + '\\' + (row.file || dossierName(row.code)));
    try {
      fs.writeFileSync(path, row.md, 'utf8');
      written++;
      await db.query(
        `UPDATE v3.incidents
            SET detail = (COALESCE(detail, '{}'::jsonb) - 'dossier_md')
                         || jsonb_build_object('dossier_pending', false)
          WHERE id = $1`, [row.id]).catch(() => {});
    } catch (e) { failed.push({ id: row.id, error: e.message }); }
  }
  return { written, pending: rows.length - written, failed };
}

module.exports = {
  openIncident, resolveIncident, flushDossiers,
  buildDossier, buildSlackText, dossierName, stamp, nyDate, nyTime,
  VAULT_DIR, ADMIN_CHANNEL,
};
