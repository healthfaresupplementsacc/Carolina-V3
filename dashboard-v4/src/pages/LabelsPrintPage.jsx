/* Página "Etiquetas" (#estoque-etiquetas) — S15 Fase 3.

   Imprime etiqueta 4x6 (uma por folha) pra prateleira e pra caixa. O que vai na
   etiqueta, na ordem que o operador lê de longe pra perto:
     1. CÓDIGO HUMANO gigante (A03B2 / BX-0451) — leitura a 3 metros;
     2. Code 128 (SVG gerado aqui, src/lib/code128.js, sem CDN) — o scanner USB
        e o celular leem essa barra;
     3. QR pequeno (npm qrcode, empacotado no bundle) com a URL do local —
        atalho pro celular pareado abrir o local direto;
     4. line2 = prateleira/área (bin) ou produto (caixa);
        line3 = quantidade e lote (caixa) ou mínimo (prateleira).

   Impressão: `@page { size: 4in 6in }` e um `page-break-after` por etiqueta,
   então a impressora de etiqueta cospe exatamente uma por vez. Depois de
   imprimir, cada CAIXA leva o carimbo label_printed_at (o backend guarda quem
   imprimiu o quê, senão ninguém sabe se a caixa no palete tem etiqueta velha).

   Chega aqui por "Imprimir etiquetas" na página Locais, que passa a seleção no
   próprio hash: #estoque-etiquetas?bins=1,2&boxes=3

   STYLE-KIT na tela; a etiqueta em si é preto no branco (é impressão térmica).
   Sem travessão em texto de UI. */
import React from 'react';
import QRCode from 'qrcode';
import * as wh from '../adapters/warehouse-api.js';
import { bars128 } from '../lib/code128.js';
import { canRead, canWrite, friendlyError } from './WarehousePage.jsx';

const fmt = (v) => (v == null ? '' : Number(v).toLocaleString('pt-BR'));

/** Lê bins/boxes do hash (#estoque-etiquetas?bins=1,2&boxes=3). */
export function parseLabelSelection(hash) {
  const qs = String(hash || '').split('?')[1] || '';
  const p = new URLSearchParams(qs);
  const nums = (k) => (p.get(k) || '').split(',').map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
  return { bins: nums('bins'), boxes: nums('boxes') };
}

/** Code 128 como <svg> React. Altura em módulos; escala pela CSS. */
function Barcode({ value, height = 44 }) {
  const { rects, modules } = React.useMemo(() => bars128(value || '', height), [value, height]);
  return (
    <svg className="lbl-barcode" data-barcode={value}
         viewBox={`0 0 ${modules} ${height}`} preserveAspectRatio="none"
         shapeRendering="crispEdges" role="img" aria-label={'Code 128 ' + value}>
      {rects.map((r, i) => <rect key={i} x={r.x} y="0" width={r.w} height={r.h} fill="#000" />)}
    </svg>
  );
}

/** QR pequeno via npm qrcode (SVG string, sem canvas nem CDN).
    Se o encoder falhar, a etiqueta NÃO sai com um quadrado branco mudo: mostra
    o código em texto, que continua digitável à mão. Etiqueta impressa errada
    volta como caixa sem identificação no palete. */
function QR({ value, size = 92 }) {
  const [svg, setSvg] = React.useState('');
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let on = true;
    if (!value) { setSvg(''); return undefined; }
    setFailed(false);
    QRCode.toString(String(value), { type: 'svg', margin: 0, width: size, errorCorrectionLevel: 'M' })
      .then((s) => { if (on) { setSvg(s); setFailed(false); } })
      .catch(() => { if (on) { setSvg(''); setFailed(true); } });
    return () => { on = false; };
  }, [value, size]);
  if (failed) {
    return (
      <div className="lbl-qr lbl-qr-fail" data-qr={value} data-qr-failed="1" style={{ width: size, height: size }}>
        <span>{String(value).slice(0, 28)}</span>
      </div>
    );
  }
  // dangerouslySetInnerHTML: o SVG vem do encoder local, não de input de usuário.
  return (
    <div className="lbl-qr" data-qr={value} style={{ width: size, height: size }}
         dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

/** Uma etiqueta 4x6. `kind` decide o corpo (prateleira x caixa). */
function Label({ l }) {
  const isBox = l.kind === 'box';
  return (
    <div className="lbl-page" data-label={l.code} data-kind={l.kind}>
      <div className="lbl-top">
        <span className="lbl-kind">{isBox ? 'CAIXA' : 'PRATELEIRA'}</span>
        <span className="lbl-brand">HEALTHFARE</span>
      </div>

      <div className="lbl-code">{l.code}</div>

      <Barcode value={l.code} />
      <div className="lbl-code-small">{l.code}</div>

      <div className="lbl-lines">
        {l.line2 ? <div className="lbl-line2">{l.line2}</div> : null}
        {l.line3 ? <div className="lbl-line3">{l.line3}</div> : null}
      </div>

      <div className="lbl-foot">
        <QR value={l.url || l.code} />
        <div className="lbl-foot-txt">
          {isBox ? (
            <>
              {l.batch_number ? <div><b>Lote</b> {l.batch_number}</div> : null}
              {l.qty != null ? <div><b>Qtd</b> {fmt(l.qty)} garrafas</div> : null}
              {l.sealed ? <div>lacrada</div> : null}
            </>
          ) : (
            <>
              {l.area ? <div><b>Área</b> {l.area}</div> : null}
              {l.capacity != null ? <div><b>Cabe</b> {fmt(l.capacity)}</div> : null}
            </>
          )}
          <div className="lbl-date">{new Date().toISOString().slice(0, 10)}</div>
        </div>
      </div>
    </div>
  );
}

const CSS = `
/* ── tela ─────────────────────────────────────────────── */
.lbl-screen { padding-bottom:60px; }
.lbl-sheet { display:flex; flex-wrap:wrap; gap:18px; margin-top:16px; }
.lbl-page {
  width:4in; height:6in; box-sizing:border-box;
  background:#fff; color:#000; border:1px solid var(--line, #d4e2f0); border-radius:6px;
  padding:0.24in 0.22in; display:flex; flex-direction:column; gap:0.07in;
  font-family:'DM Sans', system-ui, 'Segoe UI', sans-serif;
  page-break-after:always; break-after:page;
}
.lbl-page:last-child { page-break-after:auto; break-after:auto; }
.lbl-top { display:flex; justify-content:space-between; align-items:baseline;
  font:600 9px 'DM Mono', ui-monospace, Consolas, monospace; letter-spacing:.14em; }
.lbl-kind { color:#000; }
.lbl-brand { color:#444; }
.lbl-code {
  font-family:'DM Mono', ui-monospace, Consolas, monospace;
  font-weight:600; font-size:0.72in; line-height:1; letter-spacing:.01em;
  text-align:center; margin-top:0.04in; word-break:break-all;
}
.lbl-barcode { width:100%; height:0.62in; display:block; margin-top:0.04in; }
.lbl-code-small { text-align:center; font:500 10px 'DM Mono', ui-monospace, monospace; letter-spacing:.16em; }
/* .lbl-lines cresce pra empurrar o rodape (QR + lote) pro pe da etiqueta:
   o operador procura sempre no mesmo canto, em qualquer etiqueta. */
.lbl-lines { margin-top:0.06in; border-top:1px solid #000; padding-top:0.08in; flex:1; }
.lbl-line2 { font-size:21px; font-weight:600; line-height:1.2; }
.lbl-line3 { font-size:16px; color:#222; margin-top:4px; line-height:1.3; }
.lbl-foot { display:flex; gap:0.12in; align-items:flex-end; border-top:1px dotted #666; padding-top:0.07in; }
.lbl-qr svg { width:100%; height:100%; display:block; }
.lbl-qr-fail { border:1px dashed #000; display:flex; align-items:center; justify-content:center;
  padding:4px; text-align:center; font:500 9px 'DM Mono', ui-monospace, monospace; word-break:break-all; }
.lbl-foot-txt { font-size:11.5px; line-height:1.45; flex:1; }
.lbl-foot-txt b { font-weight:600; }
.lbl-date { color:#666; font:500 9.5px 'DM Mono', ui-monospace, monospace; margin-top:3px; }

/* ── impressão: 4x6, uma etiqueta por folha ────────────── */
@media print {
  @page { size: 4in 6in; margin: 0; }
  html, body { background:#fff !important; }
  body * { visibility:hidden; }
  .lbl-sheet, .lbl-sheet * { visibility:visible; }
  .lbl-sheet { position:absolute; left:0; top:0; margin:0; gap:0; display:block; }
  .lbl-page { width:4in; height:6in; border:none; border-radius:0; margin:0; }
}
`;

export function LabelsPrintPage() {
  const writable = canWrite();
  const [sel, setSel] = React.useState(() => parseLabelSelection(window.location.hash));
  const [st, setSt] = React.useState({ loading: true, labels: null, error: null });
  const [toast, setToast] = React.useState(null);
  const [printed, setPrinted] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [queued, setQueued] = React.useState(null);

  const ack = (m, bad) => { setToast({ msg: m, bad: !!bad }); setTimeout(() => setToast(null), 2600); };

  // o hash carrega a seleção; mudar de seleção sem sair da página revalida
  React.useEffect(() => {
    const on = () => setSel(parseLabelSelection(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const key = sel.bins.join(',') + '|' + sel.boxes.join(',');
  React.useEffect(() => {
    if (!sel.bins.length && !sel.boxes.length) { setSt({ loading: false, labels: [], error: null }); return; }
    let on = true;
    setSt((s) => ({ loading: true, labels: s.labels, error: null }));
    wh.getLabels(sel.bins, sel.boxes).then(
      (j) => { if (on) setSt({ loading: false, labels: (j.data && j.data.labels) || [], error: null }); },
      (e) => { if (on) setSt({ loading: false, labels: null, error: e }); },
    );
    return () => { on = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const labels = st.labels || [];
  const boxLabels = labels.filter((l) => l.kind === 'box');

  /* Imprime e, no retorno, carimba as CAIXAS (prateleira não tem carimbo: a
     etiqueta dela é fixa, a da caixa acompanha um lote que muda).
     window.print() bloqueia até o diálogo fechar, mas o navegador não conta se
     a pessoa mandou imprimir ou cancelou. Carimbamos assim mesmo e dizemos o
     que foi carimbado: uma caixa marcada sem etiqueta na prateleira é erro
     visível na hora; uma caixa etiquetada e não marcada vira etiqueta velha
     silenciosa no palete, que é o caso pior. */
  async function print() {
    window.print();
    setPrinted(true);
    if (!writable || !boxLabels.length) return;
    const ids = boxLabels.map((l) => l.box_id || l.id).filter(Boolean);
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => wh.markBoxLabelPrinted(id)));
      ack(ids.length === 1
        ? 'Etiqueta enviada pra impressora. A caixa ficou marcada como etiquetada.'
        : 'Etiquetas enviadas pra impressora. ' + ids.length + ' caixas ficaram marcadas como etiquetadas.');
    } catch (e) {
      ack('As etiquetas foram pra impressora, mas não consegui marcar as caixas como etiquetadas. ' + friendlyError(e), true);
    }
  }

  /* "Mandar pro computador da impressora": quem está no celular (ou num PC sem
     impressora de etiqueta do lado) não pode imprimir daqui. O pedido entra na
     fila e QUEM tem papel puxa: a Central do /op, o hub de Estoque e a estação
     .28 mostram o cartão e imprimem com um toque. O servidor resolve o desenho
     das etiquetas na hora do pedido, então o papel sai igual ao que está na
     tela agora, mesmo que o estoque mude no meio do caminho. */
  async function sendToStation() {
    if (sending || !labels.length) return;
    setSending(true);
    try {
      const kind = boxLabels.length && !sel.bins.length ? 'box_label' : 'bin_labels';
      const j = await wh.submitPrintJob({ kind, bins: sel.bins, boxes: sel.boxes });
      const n = (j.data && j.data.queued) || labels.length;
      setQueued({ id: j.data && j.data.job_id, n });
      ack(n === 1
        ? 'Pedido na fila. O papel sai no computador da impressora, é só alguém tocar em Imprimir por lá.'
        : n + ' etiquetas na fila. O papel sai no computador da impressora, é só alguém tocar em Imprimir por lá.');
    } catch (e) {
      ack('Não deu pra mandar pro computador da impressora. ' + friendlyError(e), true);
    } finally {
      setSending(false);
    }
  }

  if (!canRead()) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-dim)' }}>
        <h2 className="kit-h2">Sem acesso</h2>
        <p className="kit-sub">Essa página precisa da função view_stock.</p>
      </div>
    );
  }

  return (
    <div className="lbl-screen" data-page="etiquetas">
      <style>{CSS}</style>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="kit-eyebrow">● HEALTHFARE P&amp;P · ETIQUETAS</span>
          <h1 className="kit-h1">Etiquetas de <em>local</em></h1>
          <p className="kit-sub">
            Uma etiqueta 4x6 por folha: código grande pra ler de longe, Code 128 pro scanner, QR pro celular pareado.
            Escolha as prateleiras e caixas na página Locais e volte aqui.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a className="kit-btn sec" href="#estoque-locais">Voltar aos Locais</a>
          {writable && (
            <button className="kit-btn sec" data-act="mandar-estacao" disabled={!labels.length || sending}
                    onClick={sendToStation}
                    title="Põe na fila; o papel sai no computador que tem a impressora de etiqueta">
              {sending ? 'Mandando…' : 'Mandar pro computador da impressora'}
            </button>
          )}
          <button className="kit-btn primary" data-act="imprimir" disabled={!labels.length} onClick={print}>
            Imprimir {labels.length ? '(' + labels.length + ')' : ''}
          </button>
        </div>
      </div>

      {queued && (
        <div className="kit-card pad ok" style={{ marginTop: 16 }} data-card="fila-enviada">
          <b>{queued.n === 1 ? 'Pedido na fila do computador da impressora.' : queued.n + ' etiquetas na fila do computador da impressora.'}</b>
          <p className="kit-sub" style={{ marginTop: 4 }}>
            Aparece na Central do operador, no hub de Estoque e na estação de impressão. Quem estiver por lá toca em Imprimir e tira o papel.
            Dá pra acompanhar e cancelar na página Impressão.
          </p>
        </div>
      )}

      {st.error && (
        <div className="kit-card pad bad" style={{ marginTop: 16 }}>
          Não deu pra carregar as etiquetas. {friendlyError(st.error)}
        </div>
      )}
      {st.loading && !st.labels && (
        <div className="kit-card pad" style={{ marginTop: 16, color: 'var(--ink-dim)' }}>Montando as etiquetas…</div>
      )}

      {!st.loading && !labels.length && !st.error && (
        <div className="kit-card pad" style={{ marginTop: 16 }}>
          <div className="kit-h2">Nada selecionado ainda</div>
          <p className="kit-sub" style={{ marginTop: 6 }}>
            Vá em Locais, marque as caixinhas das prateleiras ou caixas que quer etiquetar e clique em Imprimir etiquetas.
            Elas voltam pra cá já montadas, prontas pra mandar pra impressora.
          </p>
          <a className="kit-btn primary" href="#estoque-locais" style={{ marginTop: 12 }}>Escolher em Locais</a>
        </div>
      )}

      {labels.length > 0 && (
        <>
          <div className="kit-card pad" style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="kit-mlabel">Pré-visualização em tamanho real</span>
            <span className="kit-chip neutral">{labels.length} etiquetas</span>
            {boxLabels.length > 0 && <span className="kit-chip info">{boxLabels.length} de caixa</span>}
            {printed && <span className="kit-chip ok">enviado pra impressora</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>
              Papel 4x6, uma etiqueta por folha. Confira o tamanho na janela de impressão antes de mandar.
            </span>
          </div>

          <div className="lbl-sheet" data-sheet>
            {labels.map((l, i) => <Label key={(l.kind || '') + (l.code || i)} l={l} />)}
          </div>
        </>
      )}

      {toast && <div className={'kit-toast ' + (toast.bad ? 'bad' : '')}>{toast.msg}</div>}
    </div>
  );
}
