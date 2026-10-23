import React, { useEffect, useRef, useState } from 'react';
import { X, Search, Check, Users, UserPlus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { findUsers, createGroup, loadUserGroups } from '../../shared/chat.js';
import DirectoryRefresh, { useDirectoryVersion } from './DirectoryRefresh.jsx';
import ClearSearch from './ClearSearch.jsx';

// New group: a name, members picked from the user directory ('Find users') --
// by name, username or user group, with a user-group filter and "Add all" --
// and optionally who else is an admin. The creator (you) is always creator +
// admin -- the SP adds you. On success onCreated({ groupId, name }).

const NAME_MAX = 50;   // GRP.GroupMaster.Name nvarchar(50)

export default function NewGroupDialog({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState({ status: 'loading', users: [] });
  const [userGroups, setUserGroups] = useState([]);
  const [userGroupId, setUserGroupId] = useState(0);
  const [picked, setPicked] = useState([]);   // [{ ...user, admin }]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef(null);
  const searchSeq = useRef(0);

  useEffect(() => { nameRef.current?.focus(); }, []);
  const dirVersion = useDirectoryVersion();
  useEffect(() => { loadUserGroups().then(setUserGroups).catch(() => setUserGroups([])); }, [dirVersion]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  // directory search, debounced
  useEffect(() => {
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      setResults(r => ({ ...r, status: 'loading' }));
      // a chosen user group lists all its people (up to 300) so "Add all" adds them all
      findUsers(q.trim(), userGroupId ? 300 : 30, userGroupId)
        .then(users => { if (seq === searchSeq.current) setResults({ status: 'ready', users }); })
        .catch(err => { if (seq === searchSeq.current) setResults({ status: 'error', users: [], error: err.message }); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, userGroupId, dirVersion]);

  const isPicked = (u) => picked.some(p => p.id === u.id);
  const toggle = (u) => setPicked(list => (list.some(p => p.id === u.id) ? list.filter(p => p.id !== u.id) : [...list, { ...u, admin: false }]));
  const notPicked = results.users.filter(u => !picked.some(p => p.id === u.id));
  const addAll = () => setPicked(list => [...list, ...notPicked.map(u => ({ ...u, admin: false }))]);
  const setAdmin = (id, admin) => setPicked(list => list.map(p => (p.id === id ? { ...p, admin } : p)));

  const trimmed = name.trim();
  const canCreate = trimmed.length > 0 && trimmed.length <= NAME_MAX && picked.length > 0 && !busy;
  const create = async (e) => {
    e?.preventDefault();
    if (!canCreate) return;
    setBusy(true); setError('');
    try { onCreated(await createGroup(trimmed, picked)); }
    catch (err) { setError(err.message || 'Could not create the group.'); setBusy(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.45)' }} />
      <form onSubmit={create} role="dialog" aria-modal="true" aria-labelledby="ng-title" style={{
        position: 'relative', width: 'min(520px, 100%)', maxHeight: 'min(720px, calc(100vh - 32px))', display: 'flex',
        flexDirection: 'column', borderRadius: 18, background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
        fontFamily: 'var(--font)', color: 'var(--text)',
      }}>
        <header style={{ padding: '18px 20px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)' }}>
          <Users size={20} style={{ color: 'var(--accent-strong)' }} />
          <h2 id="ng-title" style={{ margin: 0, flex: 1, fontSize: 18, fontWeight: 800 }}>New group</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 40, height: 40, borderRadius: 20, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={20} /></button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="ng-name" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>Group name</label>
            <input id="ng-name" ref={nameRef} value={name} onChange={e => setName(e.target.value)} maxLength={NAME_MAX} dir="auto"
              placeholder="e.g. Sales Team" autoComplete="off" style={{
                height: 44, padding: '0 14px', borderRadius: 10, border: '1.5px solid var(--border2)', fontSize: 15,
                fontFamily: 'var(--font)', color: 'var(--text)', background: 'var(--surface)', outlineColor: 'var(--accent)',
              }} />
            <span style={{ alignSelf: 'flex-end', fontSize: 11, color: 'var(--muted)' }}>{trimmed.length}/{NAME_MAX}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>
              Members · {picked.length} <span style={{ fontWeight: 500, color: 'var(--muted)' }}>(you are added as creator and admin)</span>
            </span>
            {picked.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, borderRadius: 12, background: 'var(--soft)' }}>
                {picked.map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40 }}>
                    <Avatar name={p.name} size={30} photoUrl={p.photoUrl} />
                    <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={p.admin} onChange={e => setAdmin(p.id, e.target.checked)}
                        style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                      Admin
                    </label>
                    <button type="button" onClick={() => toggle(p)} aria-label={`Remove ${p.name}`} style={{
                      width: 30, height: 30, borderRadius: 15, border: 'none', background: 'transparent', color: 'var(--muted)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}><X size={16} /></button>
                  </div>
                ))}
              </div>
            )}

            <label htmlFor="ng-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Search people</label>
            {userGroups.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <label htmlFor="ng-usergroup" style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>User group</label>
                <select id="ng-usergroup" value={userGroupId} onChange={e => setUserGroupId(Number(e.target.value))} style={{
                  flex: '1 1 180px', minWidth: 0, height: 38, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border2)',
                  background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--font)', fontSize: 13,
                }}>
                  <option value={0}>All user groups</option>
                  {userGroups.map(g => <option key={g.id} value={g.id}>{g.name} ({g.count})</option>)}
                </select>
                {userGroupId !== 0 && results.status === 'ready' && notPicked.length > 0 && (
                  <button type="button" onClick={addAll} style={{
                    height: 38, padding: '0 12px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--accent-soft)',
                    color: 'var(--accent-strong)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                    cursor: 'pointer', fontFamily: 'var(--font)',
                  }}><UserPlus size={16} /> Add all ({notPicked.length})</button>
                )}
              </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 42, padding: '0 12px', borderRadius: 10,
              background: 'var(--bg)', color: 'var(--muted)',
            }}>
              <Search size={16} />
              <input id="ng-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, username or user group"
                autoComplete="off" style={{
                  flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 14,
                  color: 'var(--text)', fontFamily: 'var(--font)',
                }} />
              <ClearSearch value={q} onClear={() => setQ('')} />
              <DirectoryRefresh />
            </div>

            <div role="listbox" aria-multiselectable="true" aria-label="People" style={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 120 }}>
              {results.status === 'loading' && results.users.length === 0 && (
                <div role="status" style={{ padding: 10, fontSize: 13, color: 'var(--muted)' }}>Searching…</div>
              )}
              {results.status === 'error' && (
                <div role="alert" style={{ padding: 10, fontSize: 13, color: 'var(--red)' }}>{results.error || 'Search failed.'}</div>
              )}
              {results.status === 'ready' && results.users.length === 0 && (
                <div style={{ padding: 10, fontSize: 13, color: 'var(--muted)' }}>Nobody matches “{q.trim()}”.</div>
              )}
              {results.users.map(u => {
                const on = isPicked(u);
                return (
                  <button type="button" key={u.id} role="option" aria-selected={on} onClick={() => toggle(u)} style={{
                    display: 'flex', alignItems: 'center', gap: 10, minHeight: 50, padding: '6px 8px', borderRadius: 10,
                    border: 'none', background: on ? 'var(--accent-soft)' : 'transparent', textAlign: 'left', cursor: 'pointer',
                    fontFamily: 'var(--font)', color: 'var(--text)',
                  }}>
                    <Avatar name={u.name} size={36} photoUrl={u.photoUrl} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span dir="auto" style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name}</span>
                      <span dir="auto" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {[u.jobTitle || `@${u.username}`, u.userGroup].filter(Boolean).join(' · ')}
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
        </div>

        <footer style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span role={error ? 'alert' : undefined} style={{ flex: 1, fontSize: 12, color: error ? 'var(--red)' : 'var(--muted)' }}>
            {error || (picked.length === 0 ? 'Pick at least one member.' : !trimmed ? 'Give the group a name.' : '')}
          </span>
          <button type="button" onClick={onClose} disabled={busy} style={{
            height: 42, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
          }}>Cancel</button>
          <button type="submit" disabled={!canCreate} style={{
            height: 42, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontFamily: 'var(--font)', cursor: canCreate ? 'pointer' : 'not-allowed', opacity: canCreate ? 1 : 0.5,
          }}>{busy ? 'Creating…' : 'Create group'}</button>
        </footer>
      </form>
    </div>
  );
}
