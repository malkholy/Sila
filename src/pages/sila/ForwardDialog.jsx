import React, { useEffect, useMemo, useState } from 'react';
import { X, Hash, Search, Lock, Forward, Check } from 'lucide-react';
import Avatar from './Avatar.jsx';
import ClearSearch from './ClearSearch.jsx';
import { forwardTicket, loadChannelMembers, loadChannels } from '../../shared/chat.js';

// Forward a New ticket: pick a channel of the SAME category (the SP refuses any
// other), then who joins the forwarded copy from that channel's members. Its
// admins / team leaders always join (ticked and locked: they accept or reject
// it), so does the ticket's creator; anyone else is optional, as a member or
// CC. onDone() after the server forwarded it.
export default function ForwardDialog({ ticketId, channelId, categoryId, onClose, onDone }) {
  const [channels, setChannels] = useState({ status: 'loading', list: [], error: '' });
  const [toId, setToId] = useState(0);
  const [find, setFind] = useState('');
  const [people, setPeople] = useState({ status: 'idle', list: [], error: '' });
  const [picked, setPicked] = useState(() => new Map());   // optional members: id -> { cc }
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    loadChannels()
      .then(list => { if (alive) setChannels({ status: 'ready', list: list.filter(c => c.categoryId === categoryId && c.id !== channelId), error: '' }); })
      .catch(err => { if (alive) setChannels({ status: 'error', list: [], error: err.message || 'Could not load the channels.' }); });
    return () => { alive = false; };
  }, [categoryId, channelId]);

  useEffect(() => {
    if (!toId) { setPeople({ status: 'idle', list: [], error: '' }); return undefined; }
    let alive = true;
    setPeople({ status: 'loading', list: [], error: '' });
    setPicked(new Map());
    setQ('');
    loadChannelMembers(toId)
      .then(list => { if (alive) setPeople({ status: 'ready', list, error: '' }); })
      .catch(err => { if (alive) setPeople({ status: 'error', list: [], error: err.message || 'Could not load the members.' }); });
    return () => { alive = false; };
  }, [toId]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [busy, onClose]);

  const shownChannels = useMemo(() => {
    const t = find.trim().toLowerCase();
    return channels.list.filter(c => !t || [c.name, c.purpose].some(v => v && v.toLowerCase().includes(t)))
      .sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name));
  }, [channels.list, find]);
  const target = channels.list.find(c => c.id === toId);
  const managers = people.list.filter(m => m.admin || m.leader);
  const others = people.list.filter(m => !m.admin && !m.leader)
    .filter(m => !q.trim() || [m.name, m.username, m.jobTitle].some(v => v && v.toLowerCase().includes(q.trim().toLowerCase())));

  const toggle = (m) => setPicked(map => { const n = new Map(map); if (n.has(m.id)) n.delete(m.id); else n.set(m.id, { cc: false }); return n; });
  const setCc = (id, cc) => setPicked(map => new Map(map).set(id, { cc }));
  const canSend = !!target && managers.length > 0 && !busy;
  const send = async () => {
    if (!canSend) return;
    setBusy(true); setError('');
    try {
      await forwardTicket(ticketId, toId, [...picked].map(([id, v]) => ({ id, cc: v.cc })));
      onDone();
    } catch (err) { setError(err.message || 'Could not forward the ticket.'); setBusy(false); }
  };

  const row = (m, locked) => {
    const on = locked || picked.has(m.id);
    return (
      <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 46, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
        <button type="button" onClick={locked ? undefined : () => toggle(m)} disabled={locked || busy} aria-pressed={on}
          aria-label={locked ? `${m.name} always joins` : `${on ? 'Remove' : 'Add'} ${m.name}`} style={{
            width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: `2px solid ${on ? 'var(--accent)' : 'var(--border2)'}`, background: on ? 'var(--accent)' : 'transparent',
            color: 'var(--on-accent)', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.75 : 1, padding: 0,
          }}>{on && <Check size={14} strokeWidth={3} />}</button>
        <Avatar name={m.name} size={32} photoUrl={m.photoUrl} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span dir="auto" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{m.name}</span>
          <span dir="auto" style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.jobTitle || `@${m.username}`}</span>
        </span>
        {locked ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
            <Lock size={11} /> {m.admin ? 'Admin' : 'Team leader'}
          </span>
        ) : on && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--text2)', cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.get(m.id)?.cc || false} disabled={busy} onChange={e => setCc(m.id, e.target.checked)}
              style={{ width: 15, height: 15, accentColor: 'var(--accent)' }} />CC
          </label>
        )}
      </li>
    );
  };
  const h3 = { margin: '14px 0 4px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="fwd-title" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        width: 'min(600px, 100%)', maxHeight: 'min(820px, 94vh)', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
        borderRadius: 16, boxShadow: 'var(--shadow-lg)', fontFamily: 'var(--font)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px 20px', borderBottom: '1px solid var(--border)' }}>
          <Forward size={20} style={{ color: 'var(--accent-strong)' }} />
          <h2 id="fwd-title" style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>Forward ticket #{ticketId}</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 20px 16px' }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Only channels in the same category can take this ticket. It waits there until their admins or team leaders accept it.</div>
          <h3 style={h3}>To channel</h3>
          {target ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 12px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--accent-soft)' }}>
              <Hash size={16} style={{ color: 'var(--accent-strong)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span dir="auto" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{target.name}</span>
                {target.purpose && <span dir="auto" style={{ fontSize: 12, color: 'var(--text2)' }}>{target.purpose}</span>}
              </span>
              <button onClick={() => setToId(0)} disabled={busy} style={{
                height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
              }}>Change</button>
            </div>
          ) : (
            <>
              {channels.list.length > 6 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 10px', marginBottom: 6, borderRadius: 8, background: 'var(--bg)', color: 'var(--muted)' }}>
                  <Search size={14} />
                  <input autoFocus value={find} onChange={e => setFind(e.target.value)} placeholder="Find a channel" aria-label="Find a channel"
                    style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
                  <ClearSearch value={find} onClear={() => setFind('')} size={24} style={{ marginRight: -6 }} />
                </div>
              )}
              {channels.status === 'loading' && <div role="status" style={{ fontSize: 13, color: 'var(--muted)' }}>Loading channels…</div>}
              {channels.status === 'error' && <div role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{channels.error}</div>}
              {channels.status === 'ready' && channels.list.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>No other channel in this category: the ticket can't be forwarded.</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {shownChannels.map(c => (
                  <button key={c.id} onClick={() => setToId(c.id)} style={{
                    display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, padding: '6px 10px', borderRadius: 8, border: 'none',
                    background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--orange-soft)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                    <Hash size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span dir="auto" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{c.name}</span>
                      {c.purpose && <span dir="auto" style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.purpose}</span>}
                    </span>
                    {c.private && <Lock size={13} aria-label="Private" style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                  </button>
                ))}
              </div>
            </>
          )}

          {target && (
            <>
              {people.status === 'loading' && <div role="status" style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>Loading members…</div>}
              {people.status === 'error' && <div role="alert" style={{ marginTop: 12, fontSize: 13, color: 'var(--red)' }}>{people.error}</div>}
              {people.status === 'ready' && (
                <>
                  <h3 style={h3}>Always join · {managers.length}</h3>
                  {managers.length === 0 ? (
                    <div role="alert" style={{ fontSize: 13, color: 'var(--red)' }}># <span dir="auto">{target.name}</span> has no admin or team leader to accept the ticket.</div>
                  ) : (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{managers.map(m => row(m, true))}</ul>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>The ticket's creator joins too.</div>
                  {people.list.length > managers.length && (
                    <>
                      <h3 style={h3}>Also add from # <span dir="auto" style={{ textTransform: 'none' }}>{target.name}</span> · {picked.size} picked</h3>
                      {people.list.length - managers.length > 8 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', margin: '4px 0', borderRadius: 8, background: 'var(--bg)', color: 'var(--muted)' }}>
                          <Search size={14} />
                          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search members" aria-label="Search members"
                            style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
                          <ClearSearch value={q} onClear={() => setQ('')} size={24} style={{ marginRight: -6 }} />
                        </div>
                      )}
                      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{others.map(m => row(m, false))}</ul>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <span role={error ? 'alert' : undefined} style={{ flex: 1, fontSize: 12, color: error ? 'var(--red)' : 'var(--muted)' }}>
            {error || (target ? `${managers.length + picked.size} people from # ${target.name}` : 'Pick a channel')}
          </span>
          <button onClick={onClose} disabled={busy} style={{
            height: 40, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}>Cancel</button>
          <button onClick={send} disabled={!canSend} style={{
            height: 40, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', display: 'flex', alignItems: 'center', gap: 6,
            cursor: canSend ? 'pointer' : 'not-allowed', opacity: canSend ? 1 : 0.5,
          }}><Forward size={16} /> {busy ? 'Forwarding…' : 'Forward'}</button>
        </div>
      </div>
    </div>
  );
}
