import React from 'react';
import { X } from 'lucide-react';

// The X at the end of a search box: shown while there is text, clears it and
// keeps the cursor in the box (mousedown doesn't take the focus away).
export default function ClearSearch({ value, onClear, size = 28, style }) {
  if (!value) return null;
  return (
    <button type="button" aria-label="Clear search" title="Clear search" onMouseDown={e => e.preventDefault()} onClick={onClear}
      style={{
        width: size, height: size, flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent',
        color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', ...style,
      }}><X size={15} /></button>
  );
}
