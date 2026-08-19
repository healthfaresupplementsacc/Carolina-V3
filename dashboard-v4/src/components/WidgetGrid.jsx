import React from 'react';

/* ═══════════════════════════════════════════════════════════════════
   WIDGET GRID — grade arrastável e redimensionável da página Hoje.

   Bruno 08-19: "os widgets deveriam ser draggable, que a gente pudesse mudar
   tamanho, lugar, ajustar em qualquer lugar dessa área".

   Escrita à mão de propósito: o npm desta máquina está quebrado, então nada de
   react-grid-layout. São ~300 linhas de pointer events + uma função de
   compactação; o comportamento que importa (arrastar pelo título, puxar o
   canto, nada sobrepõe, o estado sobrevive ao F5) cabe nisso.

   MODELO
     - 12 colunas. Altura da linha = ROW_H, mais GAP entre células.
     - Cada widget = { id, x, y, w, h, on }. x/y/w/h em unidades de grade.
     - Layout persistido em localStorage 'hf-hoje-layout-v2'.
     - Nada sobrepõe: depois de cada mexida o layout é COMPACTADO pra cima
       (cada widget sobe até encostar em outro ou no topo), que é o mesmo
       comportamento que as pessoas já conhecem de dashboards.

   TABLET (< 900px): uma coluna só, drag/resize desligados. Puxar bloco de
   56px com o dedo num tablet só gera layout quebrado sem querer; quem precisa
   reorganizar faz no desktop, e o popover de Widgets tem subir/descer pra
   quem usa teclado ou toque.
   ═══════════════════════════════════════════════════════════════════ */

export const COLS = 12;
export const ROW_H = 56;
export const GAP = 14;
export const NARROW_PX = 900;

/* ── util de layout ─────────────────────────────────────────────── */

const clone = (l) => l.map((w) => ({ ...w }));
const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Sobe cada widget até encostar. Determinístico: ordena por y, depois x. */
export function compact(layout) {
  const out = clone(layout).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const placed = [];
  for (const w of out) {
    let y = 0;
    // desce até achar a primeira faixa livre a partir do topo
    for (;;) {
      const probe = { ...w, y };
      const hit = placed.find((p) => overlaps(probe, p));
      if (!hit) break;
      y = hit.y + hit.h;
    }
    w.y = y;
    placed.push(w);
  }
  return out;
}

/** Empurra pra baixo quem colide com `moving`, depois compacta. */
export function resolve(layout, moving) {
  const out = clone(layout).map((w) => (w.id === moving.id ? { ...moving } : w));
  const me = out.find((w) => w.id === moving.id);
  // quem colide com o widget movido desce pro fim dele
  let guard = 0;
  for (;;) {
    const hit = out.find((w) => w.id !== me.id && w.on && me.on && overlaps(w, me));
    if (!hit || guard++ > 200) break;
    hit.y = me.y + me.h;
  }
  // compacta só os ligados; os desligados guardam a posição pra quando voltarem
  const on = out.filter((w) => w.on);
  const off = out.filter((w) => !w.on);
  const packed = compact(on);
  const byId = new Map(packed.map((w) => [w.id, w]));
  return out.map((w) => byId.get(w.id) || off.find((o) => o.id === w.id) || w);
}

const clampW = (w, min, max) => Math.max(min, Math.min(max, w));

/* ── o componente ───────────────────────────────────────────────── */

/**
 * @param layout   [{id,x,y,w,h,on}]
 * @param onLayout (next) => void        chamado no fim de cada drag/resize
 * @param defs     { [id]: { label, minW, minH } }
 * @param children (id) => ReactNode     conteúdo de cada widget
 * @param narrow   bool                  força coluna única (tablet)
 */
export function WidgetGrid({ layout, onLayout, defs, renderWidget, narrow: narrowProp }) {
  const ref = React.useRef(null);
  const [colPx, setColPx] = React.useState(100);
  const [autoNarrow, setAutoNarrow] = React.useState(false);
  // drag = { id, mode:'move'|'resize', startX, startY, orig, ghost }
  const [drag, setDrag] = React.useState(null);
  // layout mostrado enquanto arrasta (preview ao vivo); null = usa o de fora
  const [preview, setPreview] = React.useState(null);

  const narrow = narrowProp != null ? narrowProp : autoNarrow;

  /* Largura da coluna + modo estreito, medidos do container REAL.
     Os filhos são absolutos, então o container não tem largura própria: quem
     manda é o pai. Medir cedo demais (antes da sidebar assentar) dava coluna
     larga e o último widget saía pela direita, então a medida também roda no
     ResizeObserver do PAI e num rAF depois da montagem. */
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      /* Mede o AVÔ (o .main-inner), não o próprio container: os filhos são
         absolutos, então .wg-root não impõe largura nenhuma e, num pai que
         rola no eixo x, ele acaba lendo a largura do CONTEÚDO, não a da área.
         Isso inflava a coluna e o último widget saía pela direita. */
      const host = (el.parentElement && el.parentElement.parentElement) || el.parentElement || el;
      const cs = window.getComputedStyle(host);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const avail = Math.max(0, (host.clientWidth || 0) - pad);
      const wpx = avail > 1 ? avail : (el.clientWidth || 1);
      if (wpx <= 1) return;
      setAutoNarrow(wpx < NARROW_PX);
      setColPx(Math.max(1, (wpx - GAP * (COLS - 1)) / COLS));
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const t = setTimeout(measure, 250);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      if (el.parentElement) ro.observe(el.parentElement);
      if (el.parentElement && el.parentElement.parentElement) ro.observe(el.parentElement.parentElement);
    }
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf); clearTimeout(t);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const live = preview || layout;
  const on = live.filter((w) => w.on);

  /* ── pointer: arrastar (pela alça do cabeçalho) e redimensionar ── */
  const startDrag = (e, w, mode) => {
    if (narrow) return;                       // tablet: sem drag
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* jsdom */ }
    setDrag({ id: w.id, mode, startX: e.clientX, startY: e.clientY, orig: { ...w }, pointerId: e.pointerId });
    setPreview(clone(live));
  };

  React.useEffect(() => {
    if (!drag) return undefined;
    const def = (defs && defs[drag.id]) || {};
    const minW = def.minW || 2;
    const minH = def.minH || 2;

    const onMove = (ev) => {
      const dx = Math.round((ev.clientX - drag.startX) / (colPx + GAP));
      const dy = Math.round((ev.clientY - drag.startY) / (ROW_H + GAP));
      const o = drag.orig;
      let next;
      if (drag.mode === 'move') {
        next = { ...o, x: clampW(o.x + dx, 0, COLS - o.w), y: Math.max(0, o.y + dy) };
      } else {
        next = { ...o, w: clampW(o.w + dx, minW, COLS - o.x), h: Math.max(minH, o.h + dy) };
      }
      setPreview((prev) => resolve(prev || live, next));
    };
    const onUp = () => {
      setPreview((prev) => {
        if (prev && onLayout) onLayout(prev);
        return null;
      });
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  // live/onLayout mudam a cada render; o drag em curso só precisa do snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, colPx, defs]);

  // altura total (pra o container reservar espaço enquanto arrasta)
  const rows = on.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  const px = (n) => n * (ROW_H + GAP) - GAP;

  if (narrow) {
    // coluna única, na ordem de leitura do layout (y, depois x)
    const ordered = on.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return (
      <div className="wg-root wg-narrow" ref={ref} data-widget-grid data-narrow="1">
        {ordered.map((w) => (
          <section key={w.id} className="wg-item" data-widget={w.id}>
            {renderWidget(w.id, { narrow: true })}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="wg-root" ref={ref} data-widget-grid
         style={{ height: rows > 0 ? px(rows) : 0 }}>
      {/* sombra do lugar onde o bloco vai cair */}
      {drag && (() => {
        const g = on.find((w) => w.id === drag.id);
        if (!g) return null;
        return (
          <div className="wg-ghost" data-widget-ghost aria-hidden="true"
               style={{
                 transform: `translate(${g.x * (colPx + GAP)}px, ${g.y * (ROW_H + GAP)}px)`,
                 width: g.w * colPx + (g.w - 1) * GAP,
                 height: px(g.h),
               }}/>
        );
      })()}

      {on.map((w) => {
        const def = (defs && defs[w.id]) || {};
        const dragging = drag && drag.id === w.id;
        return (
          <section key={w.id}
                   className={`wg-item ${dragging ? 'wg-dragging' : ''}`}
                   data-widget={w.id}
                   data-x={w.x} data-y={w.y} data-w={w.w} data-h={w.h}
                   style={{
                     transform: `translate(${w.x * (colPx + GAP)}px, ${w.y * (ROW_H + GAP)}px)`,
                     width: w.w * colPx + (w.w - 1) * GAP,
                     height: px(w.h),
                   }}>
            {/* alça: arrasta pelo título, como o Bruno pediu */}
            <div className="wg-handle" data-widget-handle={w.id}
                 title={`Arraste pra mover "${def.label || w.id}"`}
                 onPointerDown={(e) => startDrag(e, w, 'move')}>
              <span className="wg-grip" aria-hidden="true">⋮⋮</span>
              <span className="wg-title kit-mlabel">{def.label || w.id}</span>
            </div>
            <div className="wg-body">{renderWidget(w.id, { narrow: false })}</div>
            {/* canto: muda o tamanho */}
            <div className="wg-resize" data-widget-resize={w.id}
                 title="Puxe pra mudar o tamanho"
                 onPointerDown={(e) => startDrag(e, w, 'resize')}/>
          </section>
        );
      })}
    </div>
  );
}

export default WidgetGrid;
