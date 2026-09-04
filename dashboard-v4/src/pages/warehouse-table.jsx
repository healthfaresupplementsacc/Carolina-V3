/* ═══════════════════════════════════════════════════════════════════
   TABELA DO HUB DE ESTOQUE — uma linha por produto, editada no lugar.

   Bruno 08-17, em uma frase: "um clique, digita, pronto". E a regra que
   manda em tudo aqui: CASEPACK É A MESMA GARRAFA. BEET-2000-C3 não é outro
   produto, são três do mesmo. Então o hub NUNCA mostra uma linha por
   listagem da Veeqo: mostra uma linha por PRODUTO, com os SKUs dobrados
   embaixo dela.

   O que este módulo tem (e por que não ficou dentro da página):
     · SkuChip          o "BEET-2000 +2" que abre e lista os filhos
     · InlineNumber     a célula que vira input no clique
     · FilterBar        busca + chips + ordem + vista salva na conta
     · MergePanel       o painel "Juntar SKUs" (sugestões + ad-hoc)
   A página #estoque já é grande e é um lugar só de montagem. Isto aqui é
   comportamento, tem estado próprio e regra própria, então mora separado.

   TEXTO: PT-BR com acento, curto, humano, sem travessão.
   ═══════════════════════════════════════════════════════════════════ */
import React from 'react';
import * as wh from '../adapters/warehouse-api.js';
import './warehouse-table.css';

const n = (v) => (v == null ? 0 : Number(v));
const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));

/* ═══ SKU CHIP ══════════════════════════════════════════════════════
   O chip diz a garrafa e QUANTAS listagens penduradas nela: "BEET-2000 +2".
   Sem o +2 a pessoa acha que o C3 sumiu do sistema; com ele, o número é a
   prova de que os três estão ali dentro e ela pode abrir pra ver.

   Fonte: base_sku + children[] do overview (contrato P2). Se o backend
   ainda não mandar children, cai em `skus` (o formato antigo da linha) pra
   a tela não ficar muda no meio do deploy.

   Aberto/fechado é do CHIP, não da linha inteira: abrir o SKU não pode
   abrir o painel lateral junto (por isso o stopPropagation). */
export function SkuChip({ row, writable, onUnmerge, expanded, onToggle }) {
  const base = row.base_sku || (row.children && row.children.length ? row.children[0].sku : null);
  const children = React.useMemo(() => {
    if (Array.isArray(row.children)) return row.children;
    // fallback: a linha antiga tinha `skus` com o base junto; tira o base
    return (row.skus || []).filter((s) => s.role !== 'base' && s.sku !== row.base_sku);
  }, [row.children, row.skus, row.base_sku]);

  const count = row.sku_count != null
    ? Math.max(0, Number(row.sku_count) - 1)
    : children.length;

  if (!base) {
    return <span className="kit-chip warn" data-sku-chip="none">sem SKU</span>;
  }

  return (
    <span className="wht-skuwrap" onClick={(e) => e.stopPropagation()}>
      <button type="button"
              className={'wht-skuchip' + (expanded ? ' on' : '')}
              data-sku-chip={row.product_id}
              data-sku-count={count}
              aria-expanded={expanded ? 'true' : 'false'}
              title={count ? 'Ver os ' + count + ' SKUs pendurados nesta garrafa' : base}
              onClick={() => count && onToggle && onToggle()}>
        <span className="base">{base}</span>
        {count > 0 && <span className="plus">+{count}</span>}
      </button>

      {expanded && count > 0 && (
        <span className="wht-skukids" data-sku-kids={row.product_id}>
          {children.map((c) => (
            <span key={c.sku || c.id} className="wht-skukid" data-sku-kid={c.sku}>
              <span className="s">{c.sku}</span>
              {n(c.units_per_pack) > 1 && <span className="x">×{c.units_per_pack} kit</span>}
              {c.channel && c.channel !== 'veeqo' && <span className="ch">{c.channel}</span>}
              <span className="v">Veeqo {c.veeqo_qty == null ? '—' : fmt(c.veeqo_qty)}</span>
              {writable && c.product_id != null && onUnmerge && (
                <button type="button" className="un" data-unmerge={c.product_id}
                        title="Tirar deste produto e voltar a ter linha própria"
                        onClick={() => onUnmerge(c)}>desagrupar</button>
              )}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/* ═══ CÉLULA QUE VIRA INPUT ═════════════════════════════════════════
   Clique → input com o valor JÁ SELECIONADO (digitar substitui, que é o
   que a pessoa quer 9 vezes em 10). Enter salva, Esc cancela, Tab salva e
   pula pra próxima célula editável.

   OTIMISTA COM VOLTA ATRÁS: o número novo aparece na hora e um tique
   discreto confirma. Se a API recusar, o número VOLTA ao que era e o toast
   diz o porquê. Nunca ficamos com um número na tela que o banco não tem.

   MOTIVO: mexer no total exige motivo (é ajuste de contagem). Em vez de um
   modal, o motivo é uma segunda linha DENTRO da própria célula: continua
   sendo "clica, digita, pronto", só que com um campo a mais.

   Esta célula NUNCA escreve quantidade direto: ela chama o endpoint que já
   existe (adjust / place), que passa pelo StockService. */
export function InlineNumber({
  value, row, field, writable, disabled,
  needsReason, reasonPlaceholder, hint,
  onCommit, tabIndexKey,
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const inputRef = React.useRef(null);
  const savedTimer = React.useRef(null);

  React.useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const open = React.useCallback(() => {
    if (!writable || disabled) return;
    setDraft(value == null ? '' : String(n(value)));
    setReason('');
    setEditing(true);
  }, [writable, disabled, value]);

  React.useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const cancel = React.useCallback(() => { setEditing(false); setDraft(''); setReason(''); }, []);

  const commit = React.useCallback(async (thenNext) => {
    const next = Number(draft);
    if (!Number.isFinite(next)) { cancel(); return; }
    const delta = next - n(value);
    if (delta === 0) { cancel(); return; }
    if (needsReason && !reason.trim()) {
      // não fecha: o motivo é obrigatório e o campo já está na frente dela
      if (inputRef.current) {
        const r = inputRef.current.parentNode.querySelector('[data-inline-reason]');
        if (r) r.focus();
      }
      return;
    }
    setBusy(true);
    try {
      await onCommit({ next, delta, reason: reason.trim(), row, field });
      setEditing(false);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1800);
      if (thenNext) {
        // Tab: a próxima célula editável da MESMA linha, senão a primeira da seguinte
        const all = [...document.querySelectorAll('[data-inline-cell]')];
        const i = all.findIndex((el) => el.dataset.inlineCell === tabIndexKey);
        const nx = i >= 0 ? all[i + 1] : null;
        if (nx) nx.click();
      }
    } catch (e) {
      setEditing(false);   // o valor da linha volta sozinho: a página desfaz o patch
    } finally { setBusy(false); }
  }, [draft, value, reason, needsReason, onCommit, row, field, cancel, tabIndexKey]);

  if (!editing) {
    return (
      <span className={'wht-cell' + (writable && !disabled ? ' editable' : '')}
            data-inline-cell={tabIndexKey}
            data-inline-field={field}
            tabIndex={writable && !disabled ? 0 : undefined}
            role={writable && !disabled ? 'button' : undefined}
            title={writable && !disabled ? (hint || 'Clique pra editar') : undefined}
            onClick={(e) => { e.stopPropagation(); open(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
            }}>
        <span className="v">{fmt(value)}</span>
        {saved && <span className="wht-tick" data-inline-saved>✓ salvo</span>}
      </span>
    );
  }

  return (
    <span className="wht-editing" onClick={(e) => e.stopPropagation()}>
      <input ref={inputRef} className="kit-input mono wht-input" type="number"
             data-inline-input={tabIndexKey}
             value={draft} disabled={busy}
             onChange={(e) => setDraft(e.target.value)}
             onKeyDown={(e) => {
               if (e.key === 'Enter') { e.preventDefault(); commit(false); }
               else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
               else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commit(true); }
             }}
             onBlur={() => { if (!needsReason) commit(false); }} />
      {needsReason && (
        <input className="kit-input wht-reason" data-inline-reason
               value={reason} disabled={busy}
               placeholder={reasonPlaceholder || 'motivo (ex: contagem do dia)'}
               onChange={(e) => setReason(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') { e.preventDefault(); commit(false); }
                 else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
               }} />
      )}
    </span>
  );
}

/* Igual à de cima, mas pra texto (apelido). Sem motivo, sem sinal. */
export function InlineText({ value, placeholder, writable, onCommit, tabIndexKey, hint }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const ref = React.useRef(null);
  const t = React.useRef(null);
  React.useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  React.useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select(); } }, [editing]);

  async function commit() {
    const v = draft.trim();
    if (v === String(value || '')) { setEditing(false); return; }
    setBusy(true);
    try {
      await onCommit(v);
      setEditing(false);
      setSaved(true);
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setSaved(false), 1800);
    } catch (e) { setEditing(false); }
    finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <span className={'wht-cell text' + (writable ? ' editable' : '')}
            data-inline-cell={tabIndexKey} data-inline-field="nickname"
            tabIndex={writable ? 0 : undefined} title={writable ? (hint || 'Clique pra editar') : undefined}
            onClick={(e) => { if (!writable) return; e.stopPropagation(); setDraft(String(value || '')); setEditing(true); }}
            onKeyDown={(e) => {
              if (!writable) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDraft(String(value || '')); setEditing(true); }
            }}>
        <span className="v">{value || <span className="wht-faint">{placeholder || '—'}</span>}</span>
        {saved && <span className="wht-tick" data-inline-saved>✓ salvo</span>}
      </span>
    );
  }
  return (
    <span className="wht-editing" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} className="kit-input wht-input text" data-inline-input={tabIndexKey}
             value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)}
             onKeyDown={(e) => {
               if (e.key === 'Enter') { e.preventDefault(); commit(); }
               else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
             }}
             onBlur={commit} />
    </span>
  );
}

/* ═══ BARRA DE FILTRO ═══════════════════════════════════════════════
   Uma linha de busca, um punhado de chips e a vista salva. Tudo aqui vira
   query string do servidor: com ~190 produtos filtrar no navegador só
   funciona porque a página inteira está baixada, e ela não vai estar pra
   sempre.

   Os chips são os recortes que a pessoa realmente pede no dia a dia, com o
   nome que ela usa: "só com pendência", "só zerados", "sem local", "Veeqo
   diferente", "só sem SKU". Cada um liga/desliga sozinho; ligar dois é E,
   não OU (mostrar "zerado OU sem local" nunca ajudou ninguém a decidir).

   VISTA SALVA vai pra CONTA (prefs 'estoque.view'), não pro navegador: quem
   arruma a tela do jeito dele reencontra do mesmo jeito no PC do armazém. */
export const QUICK_FILTERS = [
  { k: 'pend',      label: 'só com pendência', param: 'status', value: 'pendente' },
  { k: 'zerado',    label: 'só zerados',       param: 'status', value: 'zerado' },
  { k: 'sem_local', label: 'sem local',        param: 'status', value: 'sem_local' },
  { k: 'drift',     label: 'Veeqo diferente',  param: 'status', value: 'drift' },
  { k: 'sem_sku',   label: 'só sem SKU',       param: 'status', value: 'sem_sku' },
];

export function FilterBar({
  q, onQ, chips, onChip, onlyQty, onOnlyQty,
  shown, total, sortLabel, onClear,
  viewStatus, onSaveView, onResetView, dirty,
}) {
  /* Debounce na busca: quem digita "beet" não pode disparar 4 buscas no
     servidor. O input é controlado por FORA (o pai guarda o texto), o
     debounce é só de quando avisar. */
  const [local, setLocal] = React.useState(q || '');
  const timer = React.useRef(null);
  React.useEffect(() => { setLocal(q || ''); }, [q]);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const type = (v) => {
    setLocal(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onQ(v), 300);
  };
  const flush = () => { if (timer.current) clearTimeout(timer.current); onQ(local); };

  const anyChip = Object.keys(chips || {}).some((k) => chips[k]);
  const active = anyChip || onlyQty || (q && q.trim());

  return (
    <div className="wht-filterbar" data-filterbar>
      <div className="wht-filterline">
        <input className="kit-input wht-search" value={local} data-filter-q
               placeholder="Buscar produto, apelido, SKU ou código de barras"
               onChange={(e) => type(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') flush(); if (e.key === 'Escape') { setLocal(''); onQ(''); } }} />

        <div className="wht-chips" data-filter-chips>
          {QUICK_FILTERS.map((f) => (
            <button key={f.k} type="button"
                    className={'wht-fchip' + (chips[f.k] ? ' on' : '')}
                    data-chip={f.k} aria-pressed={chips[f.k] ? 'true' : 'false'}
                    onClick={() => onChip(f.k)}>{f.label}</button>
          ))}
          <button type="button" className={'wht-fchip' + (onlyQty ? ' on' : '')}
                  data-chip="only_qty" aria-pressed={onlyQty ? 'true' : 'false'}
                  title="Esconde quem está com tudo zerado"
                  onClick={() => onOnlyQty(!onlyQty)}>só com quantidade</button>
          {active && (
            <button type="button" className="wht-fclear" data-filter-clear onClick={onClear}>limpar</button>
          )}
        </div>
      </div>

      <div className="wht-filterfoot">
        <span className="kit-mlabel" data-count-note>
          {fmt(shown)} de {fmt(total)} produtos
        </span>
        <span className="kit-mlabel" data-sort-note>ordenado por {sortLabel}</span>
        <span className="wht-spacer" />
        <span className="kit-mlabel" data-view-status>{viewStatus}</span>
        {dirty && (
          <button type="button" className="kit-btn xs" data-act="salvar-vista" onClick={onSaveView}>
            Salvar esta vista
          </button>
        )}
        <button type="button" className="kit-btn xs sec" data-act="resetar-vista" onClick={onResetView}>
          Vista padrão
        </button>
      </div>
    </div>
  );
}

/* ═══ CABEÇALHO ORDENÁVEL ═══════════════════════════════════════════
   Qualquer coluna numérica ordena. Clicou: ordena decrescente PRIMEIRO,
   porque "de maior pra menor" é o que o Bruno pediu e é o que se quer ao
   perguntar "quem tem mais?". Clicou de novo: inverte. Vazio vai sempre
   pro fim, nos dois sentidos (ausência de número não é "pouco"). */
export function SortableTh({ col, label, sort, onSort, className, title }) {
  const on = sort.col === col;
  return (
    <th className={'num sortable' + (className ? ' ' + className : '') + (on ? ' on' : '')}
        data-sort={col} onClick={() => onSort(col)}
        title={title || ('Ordenar por ' + label.toLowerCase())}>
      {label}{on ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

/* ═══ PAINEL "JUNTAR SKUs" ══════════════════════════════════════════
   O painel existe por uma frase do Bruno: casepack é a mesma garrafa. Hoje
   o catálogo tem BEET-2000, BEET-2000-C3 e "Beet Root 2000mg - C4" como
   três produtos, então o estoque conta três linhas pra uma garrafa só.

   NADA É APLICADO SOZINHO. O backend PROPÕE grupos, a pessoa confirma. Até
   o atalho "juntar todos os óbvios" passa por um resumo que diz, com nome e
   SKU, o que vai virar filho de quem e pra onde o estoque vai.

   Também dá pra juntar à mão: marca 2+ linhas na tabela, escolhe qual é o
   pai e confirma. É o caso que nenhuma heurística pega (nome escrito
   diferente, SKU de outro canal).

   O passo 2 nunca é genérico: ele repete a frase inteira. "BEET-2000 vira o
   pai de BEET-2000-C3 e Beet Root 2000mg - C4; o estoque de X vai pro pai;
   a linha antiga some do estoque." Quem confirma tem que saber o que some. */
function groupSentence(parentName, members) {
  const names = members.map((m) => m.sku || m.name);
  const list = names.length === 1 ? names[0]
    : names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1];
  const withStock = members.filter((m) => m.has_stock);
  const parts = [parentName + ' vira o pai de ' + list];
  if (withStock.length) {
    parts.push('o estoque de ' + withStock.map((m) => m.sku || m.name).join(', ') + ' vai pro pai');
  }
  parts.push(members.length === 1 ? 'a linha antiga some do estoque' : 'as linhas antigas somem do estoque');
  return parts.join('; ') + '.';
}

const CONF_LABEL = { high: 'alta', medium: 'média', low: 'baixa' };
const CONF_TONE = { high: 'ok', medium: 'warn', low: 'neutral' };

export function MergePanel({ onClose, onDone, onError, writable, adhoc, allRows }) {
  const st = wh.useWarehouse('/sku-suggestions', [], 0);
  const [excluded, setExcluded] = React.useState({});   // "gi:product_id" → true
  const [confirm, setConfirm] = React.useState(null);   // { groups:[...], label }
  const [busy, setBusy] = React.useState(false);
  const [adhocParent, setAdhocParent] = React.useState('');

  const groups = React.useMemo(() => {
    const g = (st.data && st.data.groups) || [];
    return g.map((x, i) => ({
      ...x,
      _i: i,
      members: (x.members || []).filter((m) => !excluded[i + ':' + m.product_id]),
      _allMembers: x.members || [],
    }));
  }, [st.data, excluded]);

  const highConf = groups.filter((g) => g.confidence === 'high' && g.members.length);

  /* Ad-hoc: as linhas que a pessoa marcou na tabela. O pai começa sendo a
     que tem o SKU mais curto (BEET-2000 antes de BEET-2000-C3), que acerta
     quase sempre, mas ela pode trocar. */
  const adhocRows = React.useMemo(() => {
    if (!adhoc || !adhoc.length) return [];
    return adhoc.map((id) => (allRows || []).find((r) => r.product_id === id)).filter(Boolean);
  }, [adhoc, allRows]);

  React.useEffect(() => {
    if (!adhocRows.length) { setAdhocParent(''); return; }
    const best = adhocRows.slice().sort((a, b) =>
      String(a.base_sku || a.name || '').length - String(b.base_sku || b.name || '').length)[0];
    setAdhocParent(String(best.product_id));
  }, [adhocRows]);

  async function apply(payload, label) {
    setBusy(true);
    try {
      const res = await wh.mergeFamilyBulk(payload);
      const d = (res && res.data) || {};
      const gone = payload.reduce((a, g) => a.concat(g.from_product_ids || []), []);
      const merged = d.merged != null ? d.merged : gone.length;
      onDone(merged + (merged === 1 ? ' produto virou filho' : ' produtos viraram filhos')
             + ' · o estoque foi pro pai', label, gone);
      setConfirm(null);
      st.refresh();
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  const counts = (st.data && st.data.counts) || {};

  return (
    <>
      <div className="kit-drawer-back" onClick={onClose} />
      <aside className="kit-drawer" data-panel="juntar-skus">
        <div className="head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: 'var(--primary-deep)', lineHeight: 1.1 }}>
                Juntar SKUs
              </div>
              <div style={{ color: 'var(--ink-dim)', fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
                Casepack é a mesma garrafa. Juntar deixa uma linha só no estoque, com os SKUs pendurados nela.
              </div>
            </div>
            <button className="kit-btn sec sm" onClick={onClose}>Fechar</button>
          </div>
        </div>

        <div className="body">
          {/* ── passo 2: o resumo do que vai acontecer ─────────────── */}
          {confirm && (
            <div className="kit-card pad warn" data-merge-confirm style={{ marginBottom: 14 }}>
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>Passo 2 de 2 · confirmar</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
                {confirm.sentences.map((s, i) => (
                  <div key={i} data-merge-sentence style={{ marginBottom: 6 }}>{s}</div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="kit-btn sec sm" disabled={busy} onClick={() => setConfirm(null)}>Voltar</button>
                <button className="kit-btn primary sm" data-act="merge-confirmar" disabled={busy}
                        onClick={() => apply(confirm.groups, confirm.label)}>
                  {busy ? 'Juntando…' : confirm.cta}
                </button>
              </div>
            </div>
          )}

          {/* ── ad-hoc: as linhas marcadas na tabela ──────────────── */}
          {adhocRows.length >= 2 && (
            <div className="kit-card pad" data-merge-adhoc style={{ marginBottom: 14 }}>
              <div className="kit-mlabel" style={{ marginBottom: 8 }}>
                {adhocRows.length} linhas marcadas na tabela
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>O pai é</span>
                <select className="kit-input" data-adhoc-parent value={adhocParent}
                        onChange={(e) => setAdhocParent(e.target.value)} style={{ minWidth: 220 }}>
                  {adhocRows.map((r) => (
                    <option key={r.product_id} value={r.product_id}>
                      {(r.nickname || r.name) + (r.base_sku ? ' · ' + r.base_sku : '')}
                    </option>
                  ))}
                </select>
                <button className="kit-btn sm" data-act="merge-adhoc" disabled={!writable || !adhocParent}
                        onClick={() => {
                          const pid = Number(adhocParent);
                          const parent = adhocRows.find((r) => r.product_id === pid);
                          const members = adhocRows.filter((r) => r.product_id !== pid).map((r) => ({
                            product_id: r.product_id, sku: r.base_sku, name: r.name,
                            has_stock: n(r.total) > 0,
                          }));
                          setConfirm({
                            groups: [{ into_product_id: pid, from_product_ids: members.map((m) => m.product_id) }],
                            sentences: [groupSentence(parent.base_sku || parent.nickname || parent.name, members)],
                            cta: 'Confirmar: juntar ' + members.length + (members.length === 1 ? ' produto' : ' produtos'),
                            label: 'adhoc',
                          });
                        }}>Juntar selecionados</button>
              </div>
            </div>
          )}

          {st.loading && !st.data && (
            <div className="kit-card pad" style={{ color: 'var(--ink-dim)' }}>Procurando SKUs parecidos…</div>
          )}
          {st.error && (
            <div className="kit-card pad bad">
              Não deu pra buscar as sugestões: {st.error.message}. Você ainda pode juntar à mão marcando as linhas na tabela.
            </div>
          )}

          {/* ── atalho dos óbvios ──────────────────────────────────── */}
          {highConf.length > 0 && writable && (
            <div className="kit-card pad" style={{ marginBottom: 14, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                {highConf.length} {highConf.length === 1 ? 'grupo é óbvio' : 'grupos são óbvios'} (mesmo SKU base, só muda o casepack)
              </span>
              <button className="kit-btn primary sm" data-act="merge-todos" style={{ marginLeft: 'auto' }}
                      onClick={() => setConfirm({
                        groups: highConf.map((g) => ({
                          into_product_id: g.suggested_parent.product_id,
                          from_product_ids: g.members.map((m) => m.product_id),
                        })),
                        sentences: highConf.map((g) =>
                          groupSentence(g.suggested_parent.sku || g.suggested_parent.nickname || g.suggested_parent.name, g.members)),
                        cta: 'Confirmar: juntar ' + highConf.length + (highConf.length === 1 ? ' grupo' : ' grupos'),
                        label: 'todos',
                      })}>
                Juntar todos os óbvios (alta confiança)
              </button>
            </div>
          )}

          {/* ── um card por grupo proposto ─────────────────────────── */}
          {groups.map((g) => (
            <div key={g._i} className="kit-card pad" data-merge-group={g._i} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 17, color: 'var(--primary-deep)' }}>
                  {g.suggested_parent.nickname || g.suggested_parent.name}
                </span>
                <span className="kit-chip solid" data-merge-parent-sku>{g.suggested_parent.sku}</span>
                <span className={'kit-chip ' + (CONF_TONE[g.confidence] || 'neutral')}>
                  confiança {CONF_LABEL[g.confidence] || g.confidence}
                </span>
                <span style={{ flex: 1 }} />
                {writable && g.members.length > 0 && (
                  <button className="kit-btn sm" data-act="merge-grupo" data-group={g._i}
                          onClick={() => setConfirm({
                            groups: [{
                              into_product_id: g.suggested_parent.product_id,
                              from_product_ids: g.members.map((m) => m.product_id),
                            }],
                            sentences: [groupSentence(g.suggested_parent.sku || g.suggested_parent.name, g.members)],
                            cta: 'Confirmar: juntar ' + g.members.length
                                 + (g.members.length === 1 ? ' produto' : ' produtos'),
                            label: 'grupo',
                          })}>Juntar</button>
                )}
              </div>
              {g.reason && (
                <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', marginTop: 5 }}>{g.reason}</div>
              )}
              <table className="kit-table" style={{ marginTop: 10 }} data-merge-members={g._i}>
                <thead><tr>
                  <th style={{ width: 30 }} />
                  <th>Produto</th><th>SKU</th>
                  <th className="num">×Unid.</th><th className="num">Veeqo</th><th>Estoque</th>
                </tr></thead>
                <tbody>
                  {g._allMembers.map((m) => {
                    const key = g._i + ':' + m.product_id;
                    const on = !excluded[key];
                    return (
                      <tr key={m.product_id} className={on ? undefined : 'wht-off'}>
                        <td>
                          <input type="checkbox" checked={on} data-member={m.product_id}
                                 title={on ? 'Tirar este SKU do grupo' : 'Voltar este SKU pro grupo'}
                                 onChange={() => setExcluded((x) => ({ ...x, [key]: on }))} />
                        </td>
                        <td>{m.name}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m.sku}</td>
                        <td className="num">{m.units_per_pack || 1}</td>
                        <td className="num">{fmt(m.veeqo_qty)}</td>
                        <td>{m.has_stock
                          ? <span className="kit-chip warn">tem estoque, vai pro pai</span>
                          : <span className="kit-chip neutral">sem estoque</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

          {st.data && !groups.length && (
            <div className="kit-card pad" data-merge-empty style={{ color: 'var(--ink-dim)' }}>
              Nenhum SKU parecido sobrando. Se ainda tiver linha repetida, marque as duas na tabela e junte à mão.
            </div>
          )}

          {(counts.groups != null || counts.products != null) && (
            <div className="kit-mlabel" style={{ marginTop: 12 }}>
              {fmt(counts.groups)} grupos · {fmt(counts.products)} produtos envolvidos
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MODO SIMPLES — as peças do mutirão de carga física (Bruno 09-04).

   A frase que manda: "Berberine, 23 in shelf, 88 in box, then i can adjust
   these numbers right there". Uma linha por produto com TUDO nela: o número
   da Veeqo (o alvo), as três contagens editáveis, o chip que diz se bate,
   a impressora e a balança. Nada de modal pra digitar uma contagem.

   Diferença pro InlineNumber lá de cima: aqui a célula manda o número
   ABSOLUTO (a contagem que a pessoa acabou de fazer), não um delta com
   motivo. O backend (POST /simple/set) faz a conta e passa tudo pelo
   StockService. client_ref (uuid) por clique: repetir não duplica.
   ═══════════════════════════════════════════════════════════════════ */

/* Sugestão do próximo código de prateleira, calculada AQUI (texto puro, o
   backend só recebe o código final). Padrão da casa: A01A1 = área A,
   prateleira 01, nível A, posição 1. Se o armazém ainda usa códigos curtos
   (A03), incrementa o número; sem código nenhum, começa do A01A1. */
export function suggestBinCode(rows) {
  const codes = [];
  (rows || []).forEach((r) => {
    (r.bins || []).forEach((b) => { if (b.bin_code) codes.push(String(b.bin_code).toUpperCase()); });
    if (r.home_bin && r.home_bin.bin_code) codes.push(String(r.home_bin.bin_code).toUpperCase());
  });
  const full = codes.map((c) => /^([A-Z])(\d{2})([A-Z])(\d{1,2})$/.exec(c)).filter(Boolean)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (full.length) {
    const m = full[full.length - 1];
    return m[1] + m[2] + m[3] + (Number(m[4]) + 1);
  }
  const short = codes.map((c) => /^([A-Z])(\d{2})$/.exec(c)).filter(Boolean)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (short.length) {
    const m = short[short.length - 1];
    return m[1] + String(Number(m[2]) + 1).padStart(2, '0');
  }
  return 'A01A1';
}

/* O chip da conferência: total (prateleira + caixa + a organizar) contra o
   que a Veeqo diz que existe AGORA. Verde quando bate, âmbar dizendo quantas
   faltam ou sobram, apagado quando o produto nem tem SKU na Veeqo. */
export function CompareChip({ row }) {
  const veeqo = row.veeqo_total != null ? Number(row.veeqo_total)
    : (row.veeqo && row.veeqo.physical != null ? Number(row.veeqo.physical) : null);
  const total = n(row.total);
  if (veeqo == null) {
    return <span className="kit-chip neutral" data-compare={row.product_id} data-match="none">sem Veeqo</span>;
  }
  const d = veeqo - total;
  if (d === 0) {
    return <span className="kit-chip ok" data-compare={row.product_id} data-match="ok">bate ✓</span>;
  }
  return (
    <span className="kit-chip warn" data-compare={row.product_id} data-match={d > 0 ? 'faltam' : 'sobram'}>
      {d > 0 ? 'faltam ' + fmt(d) : 'sobram ' + fmt(-d)}
    </span>
  );
}

/* A célula do mutirão: clique → input com o valor JÁ selecionado → digita a
   contagem → Enter salva o ABSOLUTO. No primeiro shelf de um produto sem
   prateleira, abre um segundo campo "código da prateleira" já sugerido: um
   Enter salva os dois (a prateleira nasce junto com a contagem). */
export function SimpleCell({ value, row, scope, writable, askBinCode, suggestedCode, hint, onCommit }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [code, setCode] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const inputRef = React.useRef(null);
  const codeRef = React.useRef(null);
  const closed = React.useRef(false);
  const t = React.useRef(null);
  React.useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  React.useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const open = () => {
    if (!writable) return;
    closed.current = false;
    setDraft(value == null ? '' : String(n(value)));
    setCode(askBinCode ? (suggestedCode || '') : '');
    setEditing(true);
  };
  const cancel = () => { closed.current = true; setEditing(false); };

  const commit = async () => {
    if (closed.current || busy) return;
    const qty = Number(draft);
    if (!Number.isFinite(qty) || qty < 0 || Math.floor(qty) !== qty) { cancel(); return; }
    if (qty === n(value)) { cancel(); return; }
    if (askBinCode && !code.trim()) {
      if (codeRef.current) codeRef.current.focus();
      return;
    }
    setBusy(true);
    try {
      await onCommit({ row, scope, qty, bin_code: askBinCode ? code.trim().toUpperCase() : undefined });
      closed.current = true;
      setEditing(false);
      setSaved(true);
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      // a linha volta sozinha: a página não aplicou nada que o banco recusou
      closed.current = true;
      setEditing(false);
    } finally { setBusy(false); }
  };

  const keys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  if (!editing) {
    return (
      <span className={'wht-cell' + (writable ? ' editable' : '')}
            data-simple-cell={row.product_id + ':' + scope}
            data-simple-scope={scope}
            tabIndex={writable ? 0 : undefined}
            role={writable ? 'button' : undefined}
            title={writable ? (hint || 'Clique, digite a contagem e dê Enter') : undefined}
            onClick={(e) => { e.stopPropagation(); open(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
            }}>
        <span className="v">{fmt(value)}</span>
        {saved && <span className="wht-tick" data-inline-saved>✓ salvo</span>}
      </span>
    );
  }
  return (
    <span className="wht-editing" onClick={(e) => e.stopPropagation()}>
      <input ref={inputRef} className="kit-input mono wht-input" type="number" min="0" step="1"
             data-simple-input={row.product_id + ':' + scope}
             value={draft} disabled={busy}
             onChange={(e) => setDraft(e.target.value)}
             onKeyDown={keys}
             onBlur={() => { if (!askBinCode) commit(); }} />
      {askBinCode && (
        <input ref={codeRef} className="kit-input mono wht-bincode" data-simple-bincode
               value={code} disabled={busy}
               placeholder="código da prateleira"
               title="Este produto ainda não tem prateleira: ela é criada com este código"
               onChange={(e) => setCode(e.target.value)}
               onKeyDown={keys} />
      )}
    </span>
  );
}

/* ═══ PESAR PRA CONTAR ══════════════════════════════════════════════
   O popover da balança. Produto sem peso de unidade calibra ali mesmo
   (quantas garrafas na balança / peso total) e segue direto pra pesagem:
   peso bruto (a balança USB digita sozinha no campo focado) + tara (do tipo
   da caixa quando existe; senão preset ou digitada) → "dá 87 a 89 ·
   confiança alta" → [usar 88 na caixa]. Nada aqui bloqueia ninguém.

   Só usa portas que já existem: POST /count/compute (calcula, não grava) e
   POST /weights/product/:id (calibrar). Quem grava a contagem é o
   [usar N na caixa], que passa pelo MESMO simple/set das células. */
export function WeighPopover({ row, weight, tares, onClose, onUse, onCompute, onCalibrate }) {
  const unit0 = weight && weight.unit_weight_g != null ? Number(weight.unit_weight_g) : null;
  const [unit, setUnit] = React.useState(unit0);
  const [cCount, setCCount] = React.useState('');
  const [cGross, setCGross] = React.useState('');
  const [gross, setGross] = React.useState('');
  const [calc, setCalc] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const grossRef = React.useRef(null);

  const boxTypeId = row.main_box && row.main_box.box_type_id ? row.main_box.box_type_id : null;
  const boxTares = (tares || []).filter((x) => x.kind === 'box' && x.active !== false);
  const [tareSel, setTareSel] = React.useState(boxTares.length ? String(boxTares[0].tare_g) : 'custom');
  const [tareCustom, setTareCustom] = React.useState('');

  React.useEffect(() => {
    if (unit != null && grossRef.current) grossRef.current.focus();
  }, [unit]);

  const calibUnit = Number(cGross) > 0 && Number(cCount) > 0 ? Number(cGross) / Number(cCount) : null;

  async function saveCalib() {
    if (!calibUnit) return;
    setBusy(true); setErr(null);
    try {
      await onCalibrate({ sample_gross_g: Number(cGross), sample_count: Number(cCount), sample_tare_g: 0 });
      setUnit(calibUnit);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  async function compute() {
    if (!Number(gross)) return;
    setBusy(true); setErr(null); setCalc(null);
    try {
      const body = { product_id: row.product_id, gross_g: Number(gross) };
      if (boxTypeId) body.box_type_id = boxTypeId;
      else body.tare_g = tareSel === 'custom' ? (Number(tareCustom) || 0) : Number(tareSel);
      setCalc(await onCompute(body));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const boxName = row.main_box ? row.main_box.box_number
    : ((row.boxes || [])[0] ? row.boxes[0].box_number : null);
  const rangeText = calc && calc.qty != null
    ? (calc.qty_min != null && calc.qty_max != null && calc.qty_min !== calc.qty_max
        ? 'dá ' + fmt(calc.qty_min) + ' a ' + fmt(calc.qty_max)
        : 'dá ' + fmt(calc.qty))
      + ' · confiança ' + (calc.confidence || '?')
    : null;

  return (
    <>
      <div className="wht-popback" onClick={onClose} />
      <div className="kit-card pad wht-pop" data-popover="pesar" role="dialog" aria-label="Pesar pra contar">
        <div className="kit-mlabel" style={{ marginBottom: 4 }}>Pesar pra contar</div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, color: 'var(--primary-deep)', lineHeight: 1.15 }}>
          {row.nickname || row.name}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 2 }}>
          {boxName ? 'caixa ' + boxName : 'ainda sem caixa: a primeira contagem cria uma'}
        </div>

        {unit == null && (
          <div data-weigh-calibrate style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', lineHeight: 1.45 }}>
              Este produto ainda não tem peso de unidade. Ponha algumas garrafas direto na balança e me diga:
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kit-mlabel">Quantas garrafas na balança</span>
                <input className="kit-input mono" type="number" min="1" step="1" style={{ width: 100 }}
                       data-weigh-calib-count value={cCount} disabled={busy} autoFocus
                       onChange={(e) => setCCount(e.target.value)} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kit-mlabel">Peso total (g)</span>
                <input className="kit-input mono" type="number" min="0" style={{ width: 100 }}
                       data-weigh-calib-gross value={cGross} disabled={busy}
                       onChange={(e) => setCGross(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCalib(); } }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
              <span style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>
                1 garrafa dá <b data-preview="unit">{calibUnit ? calibUnit.toFixed(2) + ' g' : 'digite os dois números'}</b>
              </span>
              <button className="kit-btn sm" data-act="pesar-calibrar" disabled={busy || !calibUnit}
                      onClick={saveCalib}>{busy ? 'Salvando…' : 'Salvar peso da unidade'}</button>
            </div>
          </div>
        )}

        {unit != null && (
          <div data-weigh-flow style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
              1 garrafa dá <b>{Number(unit).toFixed(2)} g</b>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="kit-mlabel">Peso bruto (g)</span>
                <input ref={grossRef} className="kit-input mono" type="number" min="0" style={{ width: 110 }}
                       data-weigh-gross value={gross} disabled={busy}
                       onChange={(e) => setGross(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); compute(); } }} />
              </label>
              {boxTypeId ? (
                <span className="kit-chip neutral" data-weigh-tare-auto
                      title="A tara média do tipo desta caixa entra sozinha na conta">
                  tara do tipo da caixa
                </span>
              ) : (
                <>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span className="kit-mlabel">Tara</span>
                    <select className="kit-input" data-weigh-tare-sel value={tareSel} disabled={busy}
                            onChange={(e) => setTareSel(e.target.value)}>
                      {boxTares.map((x) => (
                        <option key={x.id} value={String(x.tare_g)}>{x.name} ({fmt(x.tare_g)} g)</option>
                      ))}
                      <option value="custom">digitar a tara</option>
                    </select>
                  </label>
                  {tareSel === 'custom' && (
                    <input className="kit-input mono" type="number" min="0" style={{ width: 90 }}
                           data-weigh-tare placeholder="tara g" value={tareCustom} disabled={busy}
                           onChange={(e) => setTareCustom(e.target.value)} />
                  )}
                </>
              )}
              <button className="kit-btn sm" data-act="pesar-calcular" disabled={busy || !Number(gross)}
                      onClick={compute}>{busy ? 'Calculando…' : 'Calcular'}</button>
            </div>

            {calc && calc.qty == null && (
              <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--warn-deep)' }} data-weigh-result>
                Não deu pra calcular. Confira o peso da unidade e conte na mão se precisar.
              </div>
            )}
            {rangeText && calc.qty != null && (
              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <b style={{ fontSize: 14 }} data-weigh-result>{rangeText}</b>
                <button className="kit-btn sm primary" data-act="pesar-usar" disabled={busy}
                        onClick={() => onUse(calc.qty)}>usar {fmt(calc.qty)} na caixa</button>
              </div>
            )}
          </div>
        )}

        {err && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--bad-deep)' }}>
            {String(err.message || err)}
          </div>
        )}
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button className="kit-btn xs sec" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </>
  );
}

export default { SkuChip, InlineNumber, InlineText, FilterBar, SortableTh, MergePanel, QUICK_FILTERS,
  suggestBinCode, CompareChip, SimpleCell, WeighPopover };
