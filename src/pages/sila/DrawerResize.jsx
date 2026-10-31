import React, { useCallback, useRef, useState } from 'react';

// A right-side drawer the user can make wider or narrower: drag its left edge,
// or focus the edge and press Left (wider) / Right (narrower); a double-click
// goes back to the default width. The width is remembered per drawer (key) in
// this browser only -- a convenience, so storage errors are ignored.
//
//   const [width, setWidth] = useDrawerWidth('silaTicketDrawerWidth');
//   <aside ref={ref} style={{ ..., width: drawerWidth(width, 'min(1240px, 94vw)') }}>
//     <DrawerResizeHandle asideRef={ref} onWidth={setWidth} />

const MIN = 420;   // px: room for the messages and the composer
const STEP = 40;   // px per arrow key
const clamp = (v) => Math.round(Math.max(MIN, Math.min(v, window.innerWidth - 40)));

export function useDrawerWidth(key) {
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : null; } catch { return null; }
  });
  const save = useCallback((v) => {
    const next = v == null ? null : clamp(v);
    setWidth(next);
    try { if (next == null) localStorage.removeItem(key); else localStorage.setItem(key, String(next)); } catch { /* not remembered */ }
  }, [key]);
  return [width, save];
}

// the aside's CSS width: the saved one (kept inside the window) or the default
export const drawerWidth = (width, fallback) => (width ? `${clamp(width)}px` : fallback);

export function DrawerResizeHandle({ asideRef, onWidth }) {
  const drag = useRef(null);
  const [hover, setHover] = useState(false);
  const current = () => asideRef.current?.getBoundingClientRect().width || MIN;

  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: current() };
    document.body.style.userSelect = 'none';
  };
  const move = (e) => {
    if (!drag.current) return;
    onWidth(drag.current.w + (drag.current.x - e.clientX));   // the drawer sits on the right: moving left widens it
  };
  const up = () => {
    drag.current = null;
    document.body.style.userSelect = '';
  };
  const key = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onWidth(current() + STEP); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onWidth(current() - STEP); }
  };

  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize the drawer" tabIndex={0}
      title="Drag to resize · double-click for the default width"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => onWidth(null)} onKeyDown={key}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      style={{
        position: 'absolute', left: -5, top: 0, bottom: 0, width: 10, zIndex: 5, cursor: 'ew-resize',
        display: 'flex', alignItems: 'center', justifyContent: 'center', outline: 'none', touchAction: 'none',
      }}>
      <span aria-hidden="true" style={{
        width: 4, height: 48, borderRadius: 2, transition: 'background .15s',
        background: hover || drag.current ? 'var(--accent)' : 'var(--border2)',
      }} />
    </div>
  );
}
