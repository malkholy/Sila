import { useState, useRef } from 'react';

// Free-text input that autocompletes SQL field names. Suggestions are matched
// against the identifier token under the caret; picking one inserts it there.
// Used for the Query Master "Query Filter" / "Query OrderBy" boxes and the
// per-user row-filter box in User Permissions.
export default function FieldAutocompleteInput({
  value, onChange, fields = [], placeholder = '', style = {}, disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const inputRef = useRef(null);

  const text = value || '';
  const before = text.slice(0, caret);
  const tokenMatch = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const token = tokenMatch ? tokenMatch[0] : '';
  const suggestions = token
    ? fields.filter(f => f.toLowerCase().includes(token.toLowerCase()) && f.toLowerCase() !== token.toLowerCase()).slice(0, 8)
    : (open ? fields.slice(0, 8) : []);

  function insert(field) {
    const start = caret - token.length;
    const next = text.slice(0, start) + field + text.slice(caret);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      const pos = start + field.length;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  const sync = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);

  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        ref={inputRef}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setOpen(true); }}
        onKeyUp={sync}
        onClick={sync}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        style={{
          width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
          borderRadius: 8, fontSize: 12.5, fontFamily: 'monospace', color: 'var(--text)',
          background: 'var(--bg)', outline: 'none',
        }}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 2,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)', maxHeight: 200, overflowY: 'auto',
        }}>
          {suggestions.map(f => (
            <div key={f} onMouseDown={(e) => { e.preventDefault(); insert(f); }}
              style={{ padding: '6px 10px', fontSize: 11.5, fontFamily: 'monospace', cursor: 'pointer', color: 'var(--text)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--orange-soft)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              {f}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
