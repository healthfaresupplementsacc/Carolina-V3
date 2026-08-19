/* useAccountPref — uma preferência que segue a PESSOA, não o navegador.
   Bruno 08-19: "como eu salvo os widgets do jeito que eu quero (salvar na conta)?"

   O CONTRATO, em uma frase: a tela nunca pisca e a conta sempre ganha.

   ORDEM DE LEITURA (importa, e é a parte fácil de errar)
     1. localStorage AGORA, no primeiro render. Sem isso a página abriria no
        layout de fábrica por um instante e depois pularia pro layout salvo —
        piscada feia justamente em quem ajustou a tela com carinho.
     2. GET /api/v3/prefs/<key> logo em seguida. Se a conta TEM valor, ele
        VENCE (conta > navegador) e é reescrito no localStorage, que vira só um
        cache pra próxima abertura.
     3. Se a conta não tem valor e o navegador tem, esse valor local é
        PROMOVIDO: sobe pra conta como primeira gravação. É o que faz a migração
        de quem já tinha layout salvo acontecer sozinha, sem "importar
        configurações".

   ESCRITA
     setValue grava estado + localStorage NA HORA (a interação nunca espera a
     rede) e agenda o PUT com 600 ms de debounce. Arrastar um widget dispara
     dezenas de layouts intermediários; sem coalescer, seria uma escrita por
     quadro. O último valor vence; o timer é reiniciado a cada mexida.

   SEM CONTA (PIN de emergência)
     O servidor responde account:null / 409 no_account. Não é erro: source vira
     'navegador', a tela avisa em português e tudo continua funcionando local.
     REGRA #0 — nunca bloquear quem está trabalhando.

   meta = { source:'conta'|'navegador', saving, savedAt, error, account, loaded }
*/
import React from 'react';
import { getPref, putPref } from '../adapters/prefs-api.js';

const DEBOUNCE_MS = 600;

const readLocal = (localKey) => {
  if (!localKey) return undefined;
  try {
    const raw = localStorage.getItem(localKey);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch { return undefined; }
};

const writeLocal = (localKey, value) => {
  if (!localKey) return;
  try { localStorage.setItem(localKey, JSON.stringify(value)); } catch { /* off */ }
};

/* "ESTE NAVEGADOR TEM MUDANÇA QUE A CONTA AINDA NÃO VIU."
   Uma flag numa chave irmã (<localKey>.dirty), NÃO dentro do valor: o formato do
   valor é do dono da chave, e enfiar metadado nosso lá dentro quebraria quem lê
   o localStorage direto (a página Hoje lê, no primeiro render).

   PRA QUE SERVE. "A conta vence o navegador" está certo ao ABRIR num PC novo,
   mas erraria feio num caso real: a pessoa arruma o layout e recarrega a página
   antes dos 600 ms do debounce subirem. Sem a flag, a resposta da conta (mais
   velha) sobrescreveria o ajuste que ela acabou de fazer, e o trabalho sumiria
   na frente dela. Com a flag, o local sobe primeiro e a conta alcança.

   POR QUE FLAG E NÃO CARIMBO DE HORA. Comparar um Date.now() do navegador com o
   updated_at do servidor é comparar dois relógios diferentes: o PC do armazém
   atrasado alguns minutos faria a conta "ganhar" de um ajuste mais novo, ou o
   contrário. A flag não tem relógio nenhum — ou este navegador tem coisa pra
   subir, ou não tem. Ela é ligada em toda escrita e desligada quando o PUT
   confirma. */
const dirtyKey = (localKey) => (localKey ? localKey + '.dirty' : null);

const readDirty = (localKey) => {
  const k = dirtyKey(localKey);
  if (!k) return false;
  try { return localStorage.getItem(k) === '1'; } catch { return false; }
};

const writeDirty = (localKey, on) => {
  const k = dirtyKey(localKey);
  if (!k) return;
  try {
    if (on) localStorage.setItem(k, '1');
    else localStorage.removeItem(k);
  } catch { /* off */ }
};

/**
 * @param {string} key            chave da conta, ex. 'hoje.layout'
 * @param {*|function} defaultValue valor (ou fábrica) de quando ninguém salvou nada
 * @param {{localKey?:string, enabled?:boolean}} opts
 *        localKey = chave do localStorage que serve de cache e de fallback
 * @returns {[any, function, object]} [value, setValue, meta]
 */
export function useAccountPref(key, defaultValue, opts = {}) {
  const localKey = opts.localKey || null;
  const enabled = opts.enabled !== false;

  // valor inicial: cache local → padrão. Uma vez só, no primeiro render.
  const [value, setValueState] = React.useState(() => {
    const cached = readLocal(localKey);
    if (cached !== undefined) return cached;
    return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
  });

  const [meta, setMeta] = React.useState({
    source: 'navegador', saving: false, savedAt: null, error: null,
    account: null, loaded: false,
  });

  // refs: o timer do debounce e o último valor pendente de subir
  const timer = React.useRef(null);
  const pending = React.useRef(undefined);
  const alive = React.useRef(true);
  const valueRef = React.useRef(value);
  valueRef.current = value;
  /* Já sabemos que NÃO existe conta (PIN de emergência)? Então nem agenda o PUT:
     bater na API pra tomar 409 a cada arraste é barulho na rede e no log de
     erro, e a resposta já é conhecida. Ref e não state: o setValue de dentro de
     um drag precisa do valor do instante, não do último render. */
  const noAccount = React.useRef(false);

  React.useEffect(() => () => {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /** Sobe pro servidor o que estiver pendente. Um voo por vez. */
  const flush = React.useCallback(async () => {
    const v = pending.current;
    if (v === undefined) return;
    pending.current = undefined;
    setMeta((m) => ({ ...m, saving: true }));
    try {
      const r = await putPref(key, v);
      if (!alive.current) return;
      // subiu: este navegador não tem mais nada que a conta não saiba.
      // Só limpa se nada NOVO entrou na fila enquanto o PUT estava no ar.
      if (pending.current === undefined) writeDirty(localKey, false);
      setMeta((m) => ({
        ...m, saving: false, error: null, source: 'conta',
        savedAt: (r && r.data && r.data.updated_at) || new Date().toISOString(),
        account: (r && r.data && r.data.account) || m.account,
      }));
    } catch (e) {
      if (!alive.current) return;
      // sem conta não é falha da pessoa: é o estado normal do PIN de emergência
      if (e.noAccount) noAccount.current = true;
      setMeta((m) => ({
        ...m, saving: false, source: 'navegador',
        account: e.noAccount ? null : m.account,
        error: e.noAccount ? null : e,
      }));
    }
  }, [key, localKey]);

  /** Grava local na hora (marcando que há coisa pra subir) e agenda o PUT. */
  const setValue = React.useCallback((next) => {
    const resolved = typeof next === 'function' ? next(valueRef.current) : next;
    valueRef.current = resolved;
    setValueState(resolved);
    writeLocal(localKey, resolved);
    writeDirty(localKey, true);
    if (!enabled || noAccount.current) return;
    pending.current = resolved;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; flush(); }, DEBOUNCE_MS);
  }, [localKey, enabled, flush]);

  // ── carga inicial: a conta ganha do navegador ────────────────
  React.useEffect(() => {
    if (!enabled) { setMeta((m) => ({ ...m, loaded: true })); return undefined; }
    let cancelled = false;
    getPref(key).then(
      (r) => {
        if (cancelled || !alive.current) return;
        const d = (r && r.data) || {};
        const account = d.account || null;
        if (!account) {
          // PIN de emergência: sem conta pra salvar, segue local e avisa
          noAccount.current = true;
          setMeta((m) => ({ ...m, loaded: true, account: null, source: 'navegador', error: null }));
          return;
        }
        noAccount.current = false;

        const local = readLocal(localKey);
        /* O NAVEGADOR ESTÁ NA FRENTE? Acontece de verdade: a pessoa arruma a
           grade e dá F5 antes dos 600 ms do debounce subirem. O ajuste dela é o
           mais novo — a conta não pode desfazê-lo. */
        const localIsNewer = local !== undefined && readDirty(localKey);

        if (d.value != null && !localIsNewer) {
          // a CONTA vence e vira o cache local da próxima abertura
          setValueState(d.value);
          valueRef.current = d.value;
          writeLocal(localKey, d.value);
          writeDirty(localKey, false);      // o cache agora É a conta
          setMeta((m) => ({
            ...m, loaded: true, account, source: 'conta',
            savedAt: d.updated_at || null, error: null,
          }));
          return;
        }
        /* A conta não tem nada (primeira vez nesta conta) OU o navegador está na
           frente. Nos dois casos o valor local SOBE: é assim que quem já tinha
           layout salvo migra pra conta sozinho, sem "importar configurações". */
        if (local !== undefined) {
          setMeta((m) => ({ ...m, loaded: true, account, error: null }));
          pending.current = local;
          flush();
          return;
        }
        setMeta((m) => ({ ...m, loaded: true, account, source: 'navegador', error: null }));
      },
      (e) => {
        if (cancelled || !alive.current) return;
        // servidor fora do ar / PIN recusado: o navegador segura a página
        setMeta((m) => ({ ...m, loaded: true, source: 'navegador', error: e }));
      },
    );
    return () => { cancelled = true; };
  // key/localKey são constantes por página; flush só depende de key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return [value, setValue, meta];
}

/** Texto único da linha de status (a mesma frase em qualquer tela que use isto).
 *  Fica aqui, e não na página, pra duas telas nunca dizerem coisas diferentes
 *  sobre o mesmo estado. */
export function prefStatusText(meta, now) {
  if (!meta) return '';
  if (meta.saving) return 'Salvando…';
  if (meta.error) return 'Não consegui salvar na conta, ficou só neste navegador';
  if (!meta.account) return 'Só neste navegador (entre com seu PIN pessoal pra salvar na conta)';
  const quem = meta.account.name ? ' (' + meta.account.name + ')' : '';
  return 'Salvo na sua conta' + quem + ' · ' + agoText(meta.savedAt, now);
}

/** "agora" / "há 3 min" / hora do dia. Curto de propósito: é uma legenda. */
export function agoText(iso, now) {
  if (!iso) return 'agora';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'agora';
  const sec = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
  if (sec < 60) return 'agora';
  if (sec < 3600) return 'há ' + Math.floor(sec / 60) + ' min';
  return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export default useAccountPref;
