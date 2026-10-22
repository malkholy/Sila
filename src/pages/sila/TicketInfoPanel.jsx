import React, { useEffect, useState } from 'react';
import { X, Hash } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { loadTicketMembers } from '../../shared/chat.js';

// The ticket details panel (opens from the ticket header): channel, state,
// who opened it and when, then the members -- managers (admins / team
// leaders) first, with Admin / Team leader / Creator / CC badges. Inviting and
// removing people comes with ticket management.

function Badge({ children, tone }) {
  const [fg, bg] = tone === 'admin' ? ['var(--accent-strong)', 'var(--accent-soft)']
    : tone === 'creator' ? ['var(--green)', 'var(--green-soft)'] : ['var(--text2)', 'var(--soft)'];
  return (
    <span style={{ padding: '1px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export default function TicketInfoPanel({ ticketId, header, isOnline, onClose }) {
  const [state, setState] = useState({ status: 'loading', members: [], error: '' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', members: [], error: '' });
    loadTicketMembers(ticketId)
      .then(members => { if (alive) setState({ status: 'ready', members, error: '' }); })
      .catch(err => { if (alive) setState({ status: 'error', members: [], error: err.message || 'Could not load the members.' }); });
    return () => { alive = false; };
  }, [ticketId]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const managers = state.members.filter(m => m.admin || m.leader);
  const others = state.members.filter(m => !m.admin && !m.leader);
  const row = (m) => (
    <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px' }}>
      <Avatar name={m.name} size={36} photoUrl={m.photoUrl} online={isOnline(m.username)} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span dir="auto" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.name}{m.me ? ' (you)' : ''}
        </span>
        <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.jobTitle || `@${m.username}`}
        </span>
      </span>
      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {m.creator && <Badge tone="creator">Creator</Badge>}
        {m.admin && <Badge tone="admin">Admin</Badge>}
        {m.leader && !m.admin && <Badge tone="admin">Team leader</Badge>}
        {m.cc && <Badge>CC</Badge>}
      </span>
    </li>
  );
  const heading = (text) => (
    <h3 style={{ margin: '14px 0 2px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
      {text}
    </h3>
  );

  return (
    <aside aria-label="Ticket details" style={{
      flex: '0 0 320px', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ flex: 1, margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Ticket details</h2>
        <button onClick={onClose} aria-label="Close ticket details" style={{
          width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><X size={18} /></button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px 20px' }}>
        {header && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--text2)' }}>
            <span dir="auto" style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{header.title}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Hash size={13} /> {header.channel} · #{header.ticketId}</span>
            {header.forwardedFrom && <span>Forwarded from # {header.forwardedFrom}</span>}
            <span>{header.stateLabel}</span>
            {header.createdBy && (
              <span>Opened by {header.createdBy}{header.createdAt ? ` · ${header.createdAt.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</span>
            )}
          </div>
        )}
        {state.status === 'loading' && <div role="status" style={{ marginTop: 16, fontSize: 13, color: 'var(--muted)' }}>Loading members…</div>}
        {state.status === 'error' && <div role="alert" style={{ marginTop: 16, fontSize: 13, color: 'var(--red)' }}>{state.error}</div>}
        {state.status === 'ready' && (
          <>
            {managers.length > 0 && heading(`Admins and team leaders · ${managers.length}`)}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{managers.map(row)}</ul>
            {others.length > 0 && heading(`Members · ${others.length}`)}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{others.map(row)}</ul>
          </>
        )}
      </div>
    </aside>
  );
}
