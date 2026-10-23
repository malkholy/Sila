// Keyboard moves between list rows: a row (data-row, focusable) inside a list
// (data-rowlist). A click selects (focuses) a row, Up / Down move to the
// previous / next one -- also across groups in the same list -- and the row's
// own Enter / double-click opens it.
export function moveRowFocus(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
  const scope = e.currentTarget.closest('[data-rowlist]');
  if (!scope) return false;
  e.preventDefault();
  const rows = [...scope.querySelectorAll('[data-row]')];
  const next = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next) { next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'nearest' }); }
  return true;
}
