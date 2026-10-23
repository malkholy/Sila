// Text inside buttons (conversation rows, headers, chips) can be selected
// (src/index.css). A mouse-up that ends a selection still fires the button's
// click, so clickable rows check this first and ignore that click.
export const isSelectingText = () => {
  const s = typeof window !== 'undefined' ? window.getSelection?.() : null;
  return !!s && !s.isCollapsed && s.toString().trim().length > 0;
};
