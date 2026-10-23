// Text inside buttons (conversation rows, headers, chips) can be selected
// (src/index.css). A mouse-up that ends a selection still fires the button's
// click, so clickable rows check this first and ignore that click.
export const isSelectingText = () => {
  const s = typeof window !== 'undefined' ? window.getSelection?.() : null;
  return !!s && !s.isCollapsed && s.toString().trim().length > 0;
};

// Rows that open on a double-click: the browser selects the word under the
// pointer on that double-click, which made the check above refuse to open.
// onMouseDown={noWordSelect} stops that word selection (dragging still selects);
// the double-click handler then opens without checking the selection.
export const noWordSelect = (e) => { if (e.detail > 1) e.preventDefault(); };
