import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

// A filter-panel dropdown checklist: a labelled button showing the picked
// values, opening a popover (portalled -- filter panels clip) of checkboxes.
// options: [{ value, label }]; picked: [value]; [] = all. Esc / click away close it.
export default function CheckListDropdown({ label, allText = 'All', options, picked, onToggle, onClear, onOnly, minWidth = 150 }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null), popRef = useRef(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.min(r.left, window.innerWidth - 220), top: r.bottom + 4, width: Math.max(r.width, 200) });
  };
  useEffect(() => {
    if (!open) return undefined;
    place();
    const away = (e) => { if (!popRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const labelOf = (v) => options.find(o => String(o.value) === String(v))?.label ?? String(v);
  const on = picked.length > 0;
  const text = !on ? allText : picked.length <= 3 ? picked.map(labelOf).join(', ') : `${picked.length} selected`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: on ? 'var(--orange)' : 'var(--muted)', textTransform: 'uppercase' }}>{label}</span>
      <button ref={btnRef} type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} title={on ? picked.map(labelOf).join(', ') : allText} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, height: 32, minWidth, padding: '0 10px',
        border: '1.5px solid ' + (on ? 'var(--orange)' : 'var(--border)'), borderRadius: 8, background: 'var(--bg)',
        color: on ? 'var(--text)' : 'var(--muted)', fontSize: 12, fontWeight: on ? 700 : 500, cursor: 'pointer',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
        <ChevronDown size={14} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .12s' }} />
      </button>
      {open && pos && createPortal(
        <div ref={popRef} role="listbox" aria-multiselectable="true" style={{
          position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 2000, maxHeight: 360, overflowY: 'auto',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.18)', padding: 6,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px 6px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase' }}>{on ? `${picked.length} selected` : allText}</span>
            {on && <button type="button" onClick={onClear} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 11.5, fontWeight: 800, color: 'var(--orange)' }}>Clear</button>}
          </div>
          {options.map(o => {
            const sel = picked.some(p => String(p) === String(o.value));
            return (
              <label key={o.value} className="cl-opt" style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer',
                background: sel ? 'var(--orange-soft)' : 'transparent', color: 'var(--text)', fontWeight: sel ? 700 : 500,
              }}>
                <input type="checkbox" checked={sel} onChange={() => onToggle(o.value)} style={{ accentColor: 'var(--orange)', margin: 0 }} />
                <span style={{ flex: 1 }}>{o.label}</span>
                {onOnly && (
                  <button type="button" onClick={(e) => { e.preventDefault(); onOnly(o.value); }} title={`Only ${o.label}`}
                    style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)' }}>only</button>
                )}
              </label>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
