import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Hash, Star, Lock, UserPlus, Check } from 'lucide-react';
import Avatar from './Avatar.jsx';
import AddMembersDialog from './AddMembersDialog.jsx';
import ClearSearch from './ClearSearch.jsx';
import { createTicket, loadChannelMembers, loadChannels, newLocalId } from '../../shared/chat.js';

// New ticket (the quick + button): pick a channel (favorites first; the last
// one used is remembered), a subject and the request, optionally more people
// (CC or not). The channel's admins and team leaders join every ticket -- the
// SP adds them and takes everyone's role from the channel. On success
// onCreated(row): the new ticket's row ('Ticket list' columns).

const SUBJECT_MAX = 300;
const TEXT_MAX = 10000;
const LAST_KEY = 'silaNewTicketChannel';
const readLast = () => { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } };
const saveLast = (id) => { try { localStorage.setItem(LAST_KEY, String(id)); } catch { /* private mode */ } };

const label = { fontSize: 12, fontWeight: 700, color: 'var(--text2)' };
const box = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border2)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font)', outline: 'none',
};

export default function NewTicketDialog({ onClose, onCreated }) {
  const [channels, setChannels] = useState({ status: 'loading', list: [], error: '' });
  const [channelId, setChannelId] = useState(0);
  const [find, setFind] = useState('');
  const [people, setPeople] = useState({ status: 'idle', list: [] });   // the chosen channel's members
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [extra, setExtra] = useState([]);       // [{ ...user, cc }] picked on top of the channel's managers
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tempId = useRef(newLocalId());          // one per dialog: a retry returns the same ticket
  const findRef = useRef(null);

  useEffect(() => {
    let alive = true;
    loadChannels()
      .then(list => {
        if (!alive) return;
        setChannels({ status: 'ready', list, error: '' });
        const last = readLast();
        if (list.some(c => c.id === last)) setChannelId(last);
        else findRef.current?.focus();
      })
      .catch(err => { if (alive) setChannels({ status: 'error', list: [], error: err.message || 'Could not load the channels.' }); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!channelId) { setPeople({ status: 'idle', list: [] }); return undefined; }
    let alive = true;
    setPeople({ status: 'loading', list: [] });
    loadChannelMembers(channelId)
      .then(list => { if (alive) setPeople({ status: 'ready', list }); })
      .catch(() => { if (alive) setPeople({ status: 'error', list: [] }); });
    return () => { alive = false; };
  }, [channelId]);

  const dirty = !!(subject.trim() || text.trim() || extra.length);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy && !picking && !dirty) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, picking, dirty, onClose]);

  // favorites, then channels you belong to, then the rest; by category and name
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    return channels.list
      .filter(c => !q || [c.name, c.category, c.purpose, c.examples].some(t => t && t.toLowerCase().includes(q)))
      .sort((a, b) => (b.favorite - a.favorite) || (b.member - a.member)
        || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }, [channels.list, find]);
  const channel = channels.list.find(c => c.id === channelId);
  const managers = people.list.filter(m => m.admin || m.leader);

  const t = subject.trim(), d = text.trim();
  const canCreate = !!channel && t.length > 0 && t.length <= SUBJECT_MAX && d.length > 0 && d.length <= TEXT_MAX && !busy;
  const create = async (e) => {
    e?.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError('');
    try {
      const row = await createTicket({ channelId, subject: t, text: d, members: extra, tempId: tempId.current });
      saveLast(channelId);
      onCreated(row);
    } catch (err) { setError(err.message || 'Could not create the ticket.'); setBusy(false); }
  };

  const managerIds = new Set(managers.map(m => m.id));
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="nt-title"
      onMouseDown={e => { if (e.target === e.currentTarget && !busy && !dirty) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={create} style={{
        width: 'min(640px, 100%)', maxHeight: 'min(820px, 94vh)', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
        borderRadius: 16, boxShadow: 'var(--shadow-lg)', fontFamily: 'var(--font)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px 20px', borderBottom: '1px solid var(--border)' }}>
          <span style={{
            width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Hash size={18} /></span>
          <h2 id="nt-title" style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>New ticket</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* channel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>Channel</span>
            {channel ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 12px', borderRadius: 10,
                border: '1px solid var(--accent)', background: 'var(--accent-soft)',
              }}>
                <Hash size={16} style={{ color: 'var(--accent-strong)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span dir="auto" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{channel.name}</span>
                  {channel.category && <span dir="auto" style={{ fontSize: 12, color: 'var(--text2)' }}>{channel.category}</span>}
                  {channel.purpose && <span dir="auto" style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{channel.purpose}</span>}
                </span>
                <button type="button" onClick={() => { setChannelId(0); setFind(''); setTimeout(() => findRef.current?.focus(), 0); }}
                  disabled={busy} style={{
                    height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
                    color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
                  }}>Change</button>
              </div>
            ) : (
              <>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px', borderRadius: 10,
                  background: 'var(--bg)', color: 'var(--muted)',
                }}>
                  <Search size={15} />
                  <input ref={findRef} value={find} onChange={e => setFind(e.target.value)} placeholder="What do you need? e.g. laptop, freight, vendor code"
                    aria-label="Find a channel" style={{
                      flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 14,
                      color: 'var(--text)', fontFamily: 'var(--font)',
                    }} />
                  <ClearSearch value={find} onClear={() => setFind('')} />
                </div>
                <div role="listbox" aria-label="Channels" style={{
                  maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 4,
                }}>
                  {channels.status === 'loading' && <div role="status" style={{ padding: 10, fontSize: 13, color: 'var(--muted)' }}>Loading channels…</div>}
                  {channels.status === 'error' && <div role="alert" style={{ padding: 10, fontSize: 13, color: 'var(--red)' }}>{channels.error}</div>}
                  {channels.status === 'ready' && shown.length === 0 && (
                    <div style={{ padding: 10, fontSize: 13, color: 'var(--muted)' }}>No channel matches.</div>
                  )}
                  {shown.map(c => (
                    <button key={c.id} type="button" role="option" aria-selected={false} onClick={() => setChannelId(c.id)} style={{
                      display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 40, padding: '6px 10px', borderRadius: 8,
                      border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
                    }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--orange-soft)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                      <Hash size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span dir="auto" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{c.name}</span>
                        {c.purpose && (
                          <span dir="auto" title={c.purpose} style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c.purpose}
                          </span>
                        )}
                      </span>
                      {c.private && <Lock size={13} aria-label="Private" style={{ color: 'var(--muted)', flexShrink: 0 }} />}
                      {c.favorite && <Star size={13} aria-label="Favorite" style={{ color: 'var(--amber)', flexShrink: 0 }} fill="currentColor" />}
                      <span dir="auto" style={{ fontSize: 11.5, color: 'var(--muted)', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.category}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* subject + request */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...label, display: 'flex', justifyContent: 'space-between' }}>
              Subject
              <span style={{ fontWeight: 600, color: t.length > SUBJECT_MAX ? 'var(--red)' : 'var(--muted)' }}>{t.length}/{SUBJECT_MAX}</span>
            </span>
            <input value={subject} onChange={e => setSubject(e.target.value)} dir="auto" placeholder="What is it about?"
              disabled={busy} style={box} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>Request</span>
            <textarea value={text} onChange={e => setText(e.target.value)} dir="auto" rows={5} disabled={busy}
              placeholder="Describe what you need. It becomes the ticket's first message."
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) create(e); }}
              style={{ ...box, resize: 'vertical', minHeight: 110, lineHeight: '20px' }} />
          </label>

          {/* people */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ ...label, display: 'flex', alignItems: 'center', gap: 8 }}>
              People
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setPicking(true)} disabled={busy} style={{
                display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', borderRadius: 8,
                border: '1px dashed var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
              }}><UserPlus size={14} /> Add people</button>
            </span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {!channel ? 'Pick a channel: its admins and team leaders join every ticket.'
                : people.status === 'loading' ? 'Loading the channel’s admins…'
                  : managers.length ? `${managers.length} admin${managers.length === 1 ? '' : 's'} / team leader${managers.length === 1 ? '' : 's'} of # ${channel.name} join automatically.`
                    : `# ${channel.name} has no admin or team leader to pick the ticket up.`}
            </span>
            {managers.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {managers.map(m => (
                  <span key={m.id} title={m.jobTitle || m.username} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px 0 3px', borderRadius: 999,
                    background: 'var(--soft)', fontSize: 12, color: 'var(--text2)',
                  }}>
                    <Avatar name={m.name} size={22} photoUrl={m.photoUrl} />
                    <span dir="auto">{m.name}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent-strong)' }}>{m.admin ? 'Admin' : 'Team leader'}</span>
                  </span>
                ))}
              </div>
            )}
            {extra.length > 0 && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {extra.map(u => (
                  <li key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}>
                    <Avatar name={u.name} size={32} photoUrl={u.photoUrl} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span dir="auto" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{u.name}</span>
                      <span dir="auto" style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {u.jobTitle || `@${u.username}`}
                      </span>
                    </span>
                    <label title="CC: kept informed" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text2)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={u.cc} disabled={busy}
                        onChange={e => { const cc = e.target.checked; setExtra(list => list.map(x => (x.id === u.id ? { ...x, cc } : x))); }}
                        style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                      CC
                    </label>
                    <button type="button" onClick={() => setExtra(list => list.filter(x => x.id !== u.id))} disabled={busy}
                      aria-label={`Remove ${u.name}`} style={{
                        width: 30, height: 30, borderRadius: 15, border: 'none', background: 'transparent', color: 'var(--muted)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                      }}><X size={15} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <span role={error ? 'alert' : undefined} style={{ flex: 1, fontSize: 12, color: error ? 'var(--red)' : 'var(--muted)' }}>
            {error || 'Ctrl + Enter creates it'}
          </span>
          <button type="button" onClick={onClose} disabled={busy} style={{
            height: 40, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}>Cancel</button>
          <button type="submit" disabled={!canCreate} style={{
            height: 40, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', display: 'flex', alignItems: 'center', gap: 6,
            cursor: canCreate ? 'pointer' : 'not-allowed', opacity: canCreate ? 1 : 0.5,
          }}><Check size={16} /> {busy ? 'Creating…' : 'Create ticket'}</button>
        </div>
      </form>
      {picking && (
        <AddMembersDialog title="Add people to the ticket" verb="Add" where="ticket"
          existingIds={[...extra.map(u => u.id), ...managerIds]}
          onAdd={(ids, users) => setExtra(list => [...list, ...users.filter(u => !list.some(x => x.id === u.id)).map(u => ({ ...u, cc: false }))])}
          onClose={() => setPicking(false)} />
      )}
    </div>
  );
}
