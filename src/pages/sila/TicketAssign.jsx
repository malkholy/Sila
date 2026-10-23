import React, { useEffect, useRef, useState } from 'react';
import { UserCheck, UserX, Hand, Search } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { loadTicketMembers } from '../../shared/chat.js';
import { assignTicket, takeTicket, unassignTicket } from '../../shared/ticketAssign.js';

// The assignee on a ticket row: "→ Sara" (muted), or nothing.
export function AssigneeTag({ assignee, me }) {
  if (!assignee) return null;
  const mine = me && assignee.username === me;
  return (
    <span title={`Assigned to ${assignee.name}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, fontSize: 11.5, fontWeight: 700,
      color: mine ? 'var(--accent-strong)' : 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140,
    }}>
      <UserCheck size={12} style={{ flexShrink: 0 }} /><span dir="auto">{mine ? 'You' : assignee.name}</span>
    </span>
  );
}

// The ticket header's owner button: who has it; Take it / Unassign / assign
// someone in the ticket (managers), per the header's can flags. onChange(assignee).
export function AssignButton({ ticketId, assignee, can, meId, onChange }) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState({ status: 'idle', list: [] });
  const [q, setQ] = useState('');
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
  useEffect(() => {
    if (!open || !can.assign || members.status !== 'idle') return;
    setMembers({ status: 'loading', list: [] });
    loadTicketMembers(ticketId).then(list => setMembers({ status: 'ready', list })).catch(() => setMembers({ status: 'error', list: [] }));
  }, [open, can.assign, members.status, ticketId]);
  const run = async (fn) => {
    setBusy(true); setError('');
    try { onChange(await fn()); setOpen(false); }
    catch (err) { setError(err.message || 'Could not change the assignment.'); }
    finally { setBusy(false); }
  };
  const anything = can.assign || can.take || can.unassign;
  const mine = assignee && meId && assignee.id === meId;
  const shown = members.list.filter(m => !q.trim() || [m.name, m.username, m.jobTitle].some(v => v && v.toLowerCase().includes(q.trim().toLowerCase())));
  const btn = (primary, danger) => ({
    height: 32, padding: '0 12px', borderRadius: 8, fontWeight: 700, fontSize: 12.5, fontFamily: 'var(--font)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--on-accent)' : danger ? 'var(--red)' : 'var(--text)',
  });
  return (
    <span ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => { setError(''); if (anything || assignee) setOpen(o => !o); }} aria-haspopup="dialog" aria-expanded={open}
        title={assignee ? `Assigned to ${assignee.name}` : 'Nobody has this ticket yet'} style={{
          height: 40, maxWidth: 200, padding: '0 10px 0 6px', borderRadius: 10, cursor: anything ? 'pointer' : 'default',
          border: `1px solid ${assignee ? 'transparent' : 'var(--border)'}`,
          background: mine ? 'var(--accent-soft)' : assignee ? 'var(--soft)' : 'var(--surface)',
          display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font)', fontSize: 12.5, fontWeight: 700,
          color: assignee ? 'var(--text)' : 'var(--text2)',
        }}>
        {assignee ? <Avatar name={assignee.name} size={26} /> : <UserCheck size={17} style={{ marginLeft: 4 }} />}
        <span dir="auto" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {assignee ? (mine ? 'You' : assignee.name) : 'Unassigned'}
        </span>
      </button>
      {open && (
        <div role="dialog" aria-label="Ticket owner" style={{
          position: 'absolute', right: 0, top: 46, zIndex: 40, width: 300, padding: 14, borderRadius: 12, background: 'var(--surface)',
          border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 10, fontFamily: 'var(--font)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
            {assignee ? <>Assigned to <span dir="auto">{mine ? 'you' : assignee.name}</span></> : 'Nobody has this ticket'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {can.take && <button onClick={() => run(() => takeTicket(ticketId))} disabled={busy} style={btn(true)}><Hand size={14} /> Take it</button>}
            {can.unassign && <button onClick={() => run(() => unassignTicket(ticketId))} disabled={busy} style={btn(false, true)}><UserX size={14} /> Unassign</button>}
          </div>
          {can.assign && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>{assignee ? 'Reassign to' : 'Assign to'}</div>
              {members.list.length > 6 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 8px', borderRadius: 8, background: 'var(--bg)', color: 'var(--muted)' }}>
                  <Search size={13} />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people in the ticket" aria-label="Search people in the ticket"
                    style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--font)' }} />
                </div>
              )}
              <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {members.status === 'loading' && <div role="status" style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>}
                {members.status === 'error' && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>Could not load the people.</div>}
                {shown.filter(m => !assignee || m.id !== assignee.id).map(m => (
                  <button key={m.id} onClick={() => run(() => assignTicket(ticketId, m.id))} disabled={busy} style={{
                    display: 'flex', alignItems: 'center', gap: 8, minHeight: 38, padding: '4px 6px', borderRadius: 8, border: 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--orange-soft)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Avatar name={m.name} size={28} photoUrl={m.photoUrl} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span dir="auto" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{m.me ? `${m.name} (you)` : m.name}</span>
                      <span dir="auto" style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {[m.admin ? 'Admin' : m.leader ? 'Team leader' : '', m.cc ? 'CC' : '', m.jobTitle].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        </div>
      )}
    </span>
  );
}
