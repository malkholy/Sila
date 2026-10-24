import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Check, UserPlus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { findUsers, loadUserGroups } from '../../shared/chat.js';
import DirectoryRefresh, { useDirectoryVersion } from './DirectoryRefresh.jsx';
import ClearSearch from './ClearSearch.jsx';
import Mark from './Mark.jsx';

// Group admins / ticket managers: pick people to add to a group or invite to a
// ticket -- laid out like New group: the picked people on top (with the
// adminLabel switch and remove), a user-group filter with "Add all", then the
// search (its words highlighted in the results);
// people already in it are left out. onAdd(userIds, users) does the work (the SP
// checks the caller's role). where / verb word the dialog ('group' / 'Add').
// adminLabel (e.g. 'Ticket admin'): each picked person gets that switch; onAdd's
// third argument is the ids switched on.
export default function AddMembersDialog({ existingIds, onAdd, onClose, where = 'group', verb = 'Add', title = 'Add members', adminLabel = '' }) {
  const [q, setQ] = useState('');
  const [groupId, setGroupId] = useState(0);
  const [groups, setGroups] = useState([]);
  const [found, setFound] = useState({ status: 'loading', users: [], error: '' });
  const [picked, setPicked] = useState(() => new Map());   // id -> user
  const [admins, setAdmins] = useState(() => new Set());   // ids picked as admins (adminLabel)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  const dirVersion = useDirectoryVersion();

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { loadUserGroups().then(setGroups).catch(() => {}); }, [dirVersion]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      setFound(f => ({ ...f, status: 'loading', error: '' }));
      findUsers(q.trim(), groupId ? 300 : 50, groupId)
        .then(users => { if (alive) setFound({ status: 'ready', users: users.filter(u => !existing.has(u.id)), error: '' }); })
        .catch(err => { if (alive) setFound({ status: 'error', users: [], error: err.message || 'Could not search.' }); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, groupId, existing, dirVersion]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, busy]);

  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);   // highlighted in the results
  const pickedList = [...picked.values()];
  const toggle = (u) => setPicked(m => { const n = new Map(m); if (n.has(u.id)) n.delete(u.id); else n.set(u.id, u); return n; });
  const notPicked = found.users.filter(u => !picked.has(u.id));
  const addAll = () => setPicked(m => { const n = new Map(m); notPicked.forEach(u => n.set(u.id, u)); return n; });
  const setAdmin = (id, on) => setAdmins(st => { const n = new Set(st); if (on) n.add(id); else n.delete(id); return n; });
  const add = async () => {
    if (!picked.size || busy) return;
    setBusy(true); setError('');
    try { await onAdd([...picked.keys()], pickedList, [...admins].filter(id => picked.has(id))); onClose(); }
    catch (err) { setError(err.message || `Could not ${verb.toLowerCase()} them.`); setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        width: 'min(520px, 100%)', maxHeight: 'min(720px, calc(100vh - 32px))', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
        borderRadius: 18, boxShadow: 'var(--shadow-lg)', fontFamily: 'var(--font)', color: 'var(--text)', overflow: 'hidden',
      }}>
        <header style={{ padding: '18px 20px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 18, fontWeight: 800 }}>{title}</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 40, height: 40, borderRadius: 20, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={20} /></button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* the people picked so far, with the admin switch (adminLabel) and a remove button */}
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>Selected · {picked.size}</span>
          {pickedList.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: 12, background: 'var(--soft)' }}>
              {pickedList.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40 }}>
                  <Avatar name={p.name} size={30} photoUrl={p.photoUrl} />
                  <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                  {adminLabel && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                      <input type="checkbox" checked={admins.has(p.id)} onChange={e => setAdmin(p.id, e.target.checked)} disabled={busy}
                        style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                      {adminLabel}
                    </label>
                  )}
                  <button type="button" onClick={() => toggle(p)} disabled={busy} aria-label={`Remove ${p.name}`} style={{
                    width: 30, height: 30, borderRadius: 15, border: 'none', background: 'transparent', color: 'var(--muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  }}><X size={16} /></button>
                </div>
              ))}
            </div>
          )}

          {groups.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label htmlFor="am-usergroup" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>User group</label>
              <select id="am-usergroup" value={groupId} onChange={e => setGroupId(Number(e.target.value))} style={{
                flex: '1 1 180px', minWidth: 0, height: 38, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border2)',
                background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--font)', fontSize: 13,
              }}>
                <option value={0}>All user groups</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.count})</option>)}
              </select>
              {groupId !== 0 && found.status === 'ready' && notPicked.length > 0 && (
                <button type="button" onClick={addAll} disabled={busy} style={{
                  height: 38, padding: '0 12px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--accent-soft)',
                  color: 'var(--accent-strong)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                  cursor: 'pointer', fontFamily: 'var(--font)',
                }}><UserPlus size={16} /> Add all ({notPicked.length})</button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42, padding: '0 12px', borderRadius: 10, background: 'var(--bg)', color: 'var(--muted)' }}>
            <Search size={16} />
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, username or user group" aria-label="Search people"
              autoComplete="off" style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 14, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={q} onClear={() => setQ('')} />
            <DirectoryRefresh />
          </div>

          <div role="listbox" aria-multiselectable="true" aria-label="People" style={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 120 }}>
            {found.status === 'loading' && found.users.length === 0 && <div role="status" style={{ padding: 10, fontSize: 13, color: 'var(--muted)' }}>Searching…</div>}
            {found.status === 'error' && <div role="alert" style={{ padding: 10, fontSize: 13, color: 'var(--red)' }}>{found.error}</div>}
            {found.status === 'ready' && found.users.length === 0 && (
              <div style={{ padding: 10, fontSize: 13, color: 'var(--muted)' }}>{q.trim() ? `Nobody matches “${q.trim()}”.` : `Nobody to add here — they may already be in the ${where}.`}</div>
            )}
            {found.users.map(u => {
              const on = picked.has(u.id);
              return (
                <button type="button" key={u.id} role="option" aria-selected={on} onClick={() => toggle(u)} disabled={busy} style={{
                  display: 'flex', alignItems: 'center', gap: 10, minHeight: 50, padding: '6px 8px', borderRadius: 10,
                  border: 'none', background: on ? 'var(--accent-soft)' : 'transparent', textAlign: 'left', cursor: 'pointer',
                  fontFamily: 'var(--font)', color: 'var(--text)',
                }}>
                  <Avatar name={u.name} size={36} photoUrl={u.photoUrl} />
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span dir="auto" style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><Mark text={u.name} terms={terms} /></span>
                    <span dir="auto" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <Mark text={[u.jobTitle || `@${u.username}`, u.userGroup].filter(Boolean).join(' · ')} terms={terms} />
                    </span>
                  </span>
                  <span aria-hidden="true" style={{
                    width: 22, height: 22, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: on ? 'none' : '2px solid var(--border2)', background: on ? 'var(--accent)' : 'transparent', color: 'var(--on-accent)',
                  }}>{on && <Check size={14} />}</span>
                </button>
              );
            })}
          </div>
        </div>

        <footer style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span role={error ? 'alert' : undefined} style={{ flex: 1, fontSize: 12, color: error ? 'var(--red)' : 'var(--muted)' }}>
            {error || (picked.size ? `${picked.size} selected` : 'Pick one or more people')}
          </span>
          <button onClick={onClose} disabled={busy} style={{
            height: 42, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={add} disabled={!picked.size || busy} style={{
            height: 42, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontFamily: 'var(--font)', cursor: picked.size && !busy ? 'pointer' : 'not-allowed', opacity: picked.size ? 1 : 0.5,
          }}>{busy ? 'Working…' : `${verb}${picked.size ? ` (${picked.size})` : ''}`}</button>
        </footer>
      </div>
    </div>
  );
}
