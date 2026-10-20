import { useState, useRef } from 'react';

// Free-text input with `=MacroName` autocomplete -- typing "=" followed by
// partial text opens a dropdown of matching Accounting Macro names (from
// ACC.MacroHeader, see Pls.APIPlusMacroOperation). Used throughout the
// Accounting Events editor, whose template fields hold either a literal
// value or a `=MacroName` expression resolved later by the (out of scope)
// posting engine. Ported from PlusPro's shared/MacroInput.jsx.

export default function MacroInput({ value, onChange, macros = [], style, ...props }) {
  const [context, setContext] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);

  const handleChange = (e) => {
    const val = e.target.value;
    onChange(e);

    const cursor = e.target.selectionStart;
    const prefix = val.substring(0, cursor);
    const match = prefix.match(/=([a-zA-Z0-9_]*)$/);

    if (match) {
      setContext({ filterText: match[1], startIndex: match.index, cursorPos: cursor });
      setActiveIndex(0);
    } else {
      setContext(null);
    }
  };

  const filteredMacros = context
    ? macros.filter(m => m.toLowerCase().includes(context.filterText.toLowerCase()))
    : [];

  const handleSelect = (macroName) => {
    if (!context) return;
    const val = value || '';
    const newValue = val.substring(0, context.startIndex + 1) + macroName + val.substring(context.cursorPos);
    onChange({ target: { value: newValue } });
    setContext(null);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        const newCursor = context.startIndex + 1 + macroName.length;
        inputRef.current.setSelectionRange(newCursor, newCursor);
      }
    }, 10);
  };

  const handleKeyDown = (e) => {
    if (!context) { if (props.onKeyDown) props.onKeyDown(e); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(prev => (prev + 1) % filteredMacros.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(prev => (prev - 1 + filteredMacros.length) % filteredMacros.length); }
    else if (e.key === 'Enter') { if (filteredMacros.length > 0) { e.preventDefault(); handleSelect(filteredMacros[activeIndex]); } }
    else if (e.key === 'Escape') { setContext(null); }
    else if (props.onKeyDown) { props.onKeyDown(e); }
  };

  return (
    <div style={{ position: 'relative', width: style?.width || '100%' }}>
      <input
        {...props}
        ref={inputRef}
        value={value || ''}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        style={style}
      />
      {context && filteredMacros.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 'var(--radius-xs)',
          boxShadow: 'var(--shadow-lg)', maxHeight: 200, overflowY: 'auto', zIndex: 9999, minWidth: 200,
        }}>
          {filteredMacros.map((m, idx) => (
            <div
              key={m}
              onClick={() => handleSelect(m)}
              onMouseEnter={() => setActiveIndex(idx)}
              style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 12.5,
                background: idx === activeIndex ? 'var(--soft)' : 'var(--surface)',
                color: idx === activeIndex ? 'var(--orange)' : 'var(--text)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{ color: 'var(--muted)', marginRight: 4 }}>=</span>{m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
