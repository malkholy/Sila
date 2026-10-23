import React, { useEffect, useRef, useState } from 'react';
import { Flag } from 'lucide-react';
import { flagDueToday, flagOverdue, setTicketFlag } from '../../shared/ticketFlag.js';

// The flag on a ticket row: amber, red once the due date has passed.
export function FlagMark({ flag, size = 13 }) {
  if (!flag) return null;
  const late = flagOverdue(flag);
  const tip = ['Flagged', flag.due && `${late ? 'overdue since' : 'due'} ${flag.due}`, flag.note].filter(Boolean).join(' · ');
  return (
    <span title={tip} aria-label={tip} style={{ display: 'inline-flex', flexShrink: 0, color: late ? 'var(--red)' : 'var(--amber)' }}>
      <Flag size={size} fill="currentColor" />
    </span>
  );
}

// The ticket header's flag button: flag / unflag, and an optional due date and
// note in a small panel. onChange(flag | null) after the server saved it.
export function FlagButton({ ticketId, flag, onChange }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ due: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const save = async (next) => {
    setBusy(true); setError('');
    try { onChange(await setTicketFlag(ticketId, next)); setOpen(false); }
    catch (err) { setError(err.message || 'Could not save the flag.'); }
    finally { setBusy(false); }
  };
  const late = flagOverdue(flag);
  const color = !flag ? 'var(--text2)' : late ? 'var(--red)' : 'var(--amber)';
  const field = {
    width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8, border: '1px solid var(--border2)',
    background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)',
  };
  const btn = (primary) => ({
    height: 32, padding: '0 12px', borderRadius: 8, fontWeight: 700, fontSize: 12.5, fontFamily: 'var(--font)', cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--on-accent)' : 'var(--text)',
  });
  return (
    <span ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => { setForm({ due: flag?.due || '', note: flag?.note || '' }); setError(''); setOpen(o => !o); }}
        aria-haspopup="dialog" aria-expanded={open} aria-label={flag ? 'Flagged: change or clear' : 'Flag this ticket'}
        title={flag ? `Flagged${flag.due ? ` · ${late ? 'overdue since' : 'due'} ${flag.due}` : ''}${flag.note ? ` · ${flag.note}` : ''}` : 'Flag for follow-up (only you see it)'}
        style={{
          height: 40, padding: flag?.due ? '0 10px' : 0, minWidth: 40, borderRadius: 10, cursor: 'pointer',
          border: `1px solid ${flag ? 'transparent' : 'var(--border)'}`,
          background: flag ? (late ? 'var(--red-soft)' : 'var(--amber-soft)') : 'var(--surface)', color,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 12, fontWeight: 700, fontFamily: 'var(--font)',
        }}>
        <Flag size={17} fill={flag ? 'currentColor' : 'none'} />
        {flag?.due && <span>{flagDueToday(flag) ? 'Today' : flag.due.slice(5).replace('-', '/')}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Ticket flag" style={{
          position: 'absolute', right: 0, top: 46, zIndex: 40, width: 280, padding: 14, borderRadius: 12, background: 'var(--surface)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 10,
          fontFamily: 'var(--font)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{flag ? 'Flagged for follow-up' : 'Flag for follow-up'}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Only you see your flag. It is kept while you are in the ticket.</div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>Due date (optional)</span>
            <input type="date" value={form.due} disabled={busy} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, due: v })); }} style={field} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>Note (optional)</span>
            <textarea rows={2} dir="auto" maxLength={300} value={form.note} disabled={busy} placeholder="e.g. waiting for the supplier's reply"
              onChange={e => { const v = e.target.value; setForm(f => ({ ...f, note: v })); }} style={{ ...field, resize: 'vertical' }} />
          </label>
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => save({ due: form.due, note: form.note.trim() })} disabled={busy} style={btn(true)}>
              {busy ? 'Saving…' : flag ? 'Save' : 'Flag'}
            </button>
            {flag && <button onClick={() => save(null)} disabled={busy} style={{ ...btn(false), color: 'var(--red)' }}>Clear flag</button>}
          </div>
        </div>
      )}
    </span>
  );
}
