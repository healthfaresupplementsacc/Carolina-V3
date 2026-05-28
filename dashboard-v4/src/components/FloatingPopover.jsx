/* FloatingPopover — caixa flutuante padrão do V4. (E6 Leva A)
   Reutilizada por: engrenagens, NotifDetail, gap-fill, e qualquer
   outro elemento clicável que precise abrir overlay.

   Comportamento padrão:
   - position: fixed → escapa overflow do container pai
   - Posicionada PERTO do clique (anchor.x/anchor.y), clampada à viewport
   - z-index alto (250+) → fica por cima de tudo
   - Fecha ao: clicar fora, ESC, ou toggle pelo próprio anchor
   - Opcional: drag pelo header (`draggable`)
   - SEM backdrop (vê o resto da tela atrás)

   API:
     <FloatingPopover
       open={bool}                  controle externo
       anchor={{x, y}}              coords do clique (clampa pra caber)
       width={Number}               default 360
       onClose={fn}                 chamado por click-outside / ESC
       draggable={bool}             header arrastável (default false)
       header={ReactNode}           título (se draggable, é o handle)
       above={bool}                 abre acima do anchor (igual SidePanel)
       className={String}           extra className
     >
       {conteúdo}
     </FloatingPopover>
*/
import React from 'react';

const VIEWPORT_PAD = 12;

function clampPos(x, y, w, hHint) {
  const vh = window.innerHeight || 800;
  const vw = window.innerWidth || 1200;
  const h = hHint || 200;
  const maxX = Math.max(VIEWPORT_PAD, vw - w - VIEWPORT_PAD);
  const maxY = Math.max(VIEWPORT_PAD, vh - h - VIEWPORT_PAD);
  return {
    x: Math.min(Math.max(VIEWPORT_PAD, x), maxX),
    y: Math.min(Math.max(VIEWPORT_PAD, y), maxY),
  };
}

function positionFor(anchor, width, above) {
  if (!anchor || anchor.x == null) {
    const vw = window.innerWidth || 1200;
    return { x: vw - width - 32, y: 80 };
  }
  if (above) {
    // abre ACIMA do anchor (igual painel evento)
    const estimH = 540;
    let y = anchor.y - estimH - 12;
    if (y < VIEWPORT_PAD) y = VIEWPORT_PAD;
    let x = anchor.x + 16;
    const vw = window.innerWidth || 1200;
    if (x + width > vw - VIEWPORT_PAD) x = anchor.x - width - 16;
    return clampPos(x, y, width, estimH);
  }
  // default: ABAIXO do anchor (pra engrenagens)
  let x = anchor.x - width / 2;
  let y = anchor.y + 14;
  return clampPos(x, y, width, 200);
}

export function FloatingPopover({
  open, anchor, width = 360, onClose, draggable = false,
  header, above = false, className = '', children, style = {},
  anchorSelector,                  // string CSS selector pra ignorar no click-outside
}) {
  const [pos, setPos] = React.useState(() => positionFor(anchor, width, above));
  const ref = React.useRef(null);
  const dragRef = React.useRef(null);

  // Re-posiciona quando abre / muda âncora
  React.useEffect(() => {
    if (!open) return;
    setPos(positionFor(anchor, width, above));
  }, [open, anchor?.x, anchor?.y, width, above]);

  // Re-clampa em resize
  React.useEffect(() => {
    if (!open) return;
    const onResize = () => setPos((p) => clampPos(p.x, p.y, width));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, width]);

  // ESC + click outside
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    const onMouseDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      // Anchor selector — ignora cliques no próprio botão que abriu
      if (anchorSelector && e.target.closest(anchorSelector)) return;
      onClose && onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, onClose, anchorSelector]);

  // Drag
  const onDragStart = (e) => {
    if (!draggable) return;
    if (e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea')) return;
    e.preventDefault();
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    dragRef.current = { startX, startY };
    const onMove = (ev) => {
      setPos(clampPos(ev.clientX - dragRef.current.startX, ev.clientY - dragRef.current.startY, width));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!open) return null;

  return (
    <aside ref={ref}
           className={`float-popover ${className}`}
           style={{
             position: 'fixed', left: pos.x, top: pos.y, width,
             zIndex: 260, background: 'var(--surface)',
             border: '1px solid var(--border)', borderRadius: 10,
             boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.18))',
             maxHeight: 'min(80vh, 640px)',
             display: 'flex', flexDirection: 'column', overflow: 'hidden',
             ...style,
           }}>
      {header && (
        <div className="float-popover-head"
             onMouseDown={draggable ? onDragStart : undefined}
             style={{
               padding: '10px 12px', borderBottom: '1px solid var(--border)',
               background: 'var(--surface-2)',
               cursor: draggable ? 'move' : 'default',
               userSelect: 'none',
               display: 'flex', alignItems: 'center', gap: 8,
             }}>
          {header}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {children}
      </div>
    </aside>
  );
}
