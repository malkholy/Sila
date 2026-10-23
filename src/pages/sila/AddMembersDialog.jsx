import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Check } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { findUsers, loadUserGroups } from '../../shared/chat.js';
import DirectoryRefresh, { useDirectoryVersion } from './DirectoryRefresh.jsx';
import ClearSearch from './ClearSearch.jsx';

// Group admins / ticket managers: pick people to add to a group or invite to a
// ticket. Search by name / username / user group, or narrow to one user group;
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

  const toggle = (u) => setPicked(m => { const n = new Map(m); if (n.has(u.id)) n.delete(u.id); else n.set(u.id, u); return n; });
  const add = async () => {
    if (!picked.size || busy) return;
    setBusy(true); setError('');
    try { await onAdd([...picked.keys()], [...picked.values()], [...admins].filter(id => picked.has(id))); onClose(); }
    catch (err) { setError(err.message || `Could not ${verb.toLowerCase()} them.`); setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        width: 'min(520px, 100%)', maxHeight: 'min(680px, 92vh)', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
        borderRadius: 16, boxShadow: 'var(--shadow-lg)', fontFamily: 'var(--font)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px 20px', borderBottom: '1px solid var(--border)' }}>
          <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{title}</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
          <div style={{
            flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderRadius: 10,
            background: 'var(--bg)', color: 'var(--muted)',
          }}>
            <Search size={15} />
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Name, username or user group" aria-label="Search people"
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={q} onClear={() => setQ('')} />
            <DirectoryRefresh size={28} />
          </div>
          <select value={groupId} onChange={e => setGroupId(Number(e.target.value))} aria-label="User group" style={{
            height: 38, maxWidth: 200, padding: '0 8px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)',
          }}>
            <option value={0}>All user groups</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.count})</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minHeight: 160, overflowY: 'auto', padding: 8 }}>
          {found.status === 'loading' && <div role="status" style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Searching…</div>}
          {found.status === 'error' && <div role="alert" style={{ padding: 16, color: 'var(--red)', fontSize: 13 }}>{found.error}</div>}
          {found.status === 'ready' && found.users.length === 0 && (
            <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Nobody to add here — they may already be in the {where}.</div>
          )}
          {found.status === 'ready' && found.users.map(u => {
            const on = picked.has(u.id);
            return (
              <button key={u.id} onClick={() => toggle(u)} aria-pressed={on} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 10, border: 'none',
                background: on ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
              }}>
                <Avatar name={u.name} size={36} photoUrl={u.photoUrl} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}><span dir="auto">{u.name}</span></span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span dir="auto">{[u.jobTitle, u.userGroup].filter(Boolean).join(' · ') || `@${u.username}`}</span>
                  </span>
                </span>
                <span aria-hidden="true" style={{
                  width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `2px solid ${on ? 'var(--accent)' : 'var(--border2)'}`, background: on ? 'var(--accent)' : 'transparent', color: 'var(--on-accent)',
                }}>{on && <Check size={14} strokeWidth={3} />}</span>
                {adminLabel && on && (
                  <span role="switch" aria-checked={admins.has(u.id)} tabIndex={0} title={`Make ${u.name} ${adminLabel.toLowerCase()}`}
                    onClick={(e) => { e.stopPropagation(); setAdmins(s => { const n = new Set(s); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; }); }}
                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.currentTarget.click(); } }}
                    style={{
                      flexShrink: 0, padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
                      border: `1px solid ${admins.has(u.id) ? 'transparent' : 'var(--border)'}`,
                      background: admins.has(u.id) ? 'var(--accent-soft)' : 'var(--surface)', color: admins.has(u.id) ? 'var(--accent-strong)' : 'var(--muted)',
                    }}>{adminLabel}</span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <span style={{ flex: 1, fontSize: 13, color: error ? 'var(--red)' : 'var(--text2)' }}>
            {error || (picked.size ? `${picked.size} selected` : 'Pick one or more people')}
          </span>
          <button onClick={onClose} disabled={busy} style={{
            height: 38, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}>Cancel</button>
          <button onClick={add} disabled={!picked.size || busy} style={{
            height: 38, padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontSize: 13, cursor: picked.size && !busy ? 'pointer' : 'not-allowed', opacity: picked.size ? 1 : 0.5,
            fontFamily: 'var(--font)',
          }}>{busy ? 'Working…' : `${verb}${picked.size ? ` (${picked.size})` : ''}`}</button>
        </div>
      </div>
    </div>
  );
}
