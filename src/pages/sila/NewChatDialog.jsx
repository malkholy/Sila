import React, { useEffect, useRef, useState } from 'react';
import { X, Search, MessageCirclePlus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import Mark from './Mark.jsx';
import ClearSearch from './ClearSearch.jsx';
import { findUsers, loadUserGroups } from '../../shared/chat.js';
import DirectoryRefresh, { useDirectoryVersion } from './DirectoryRefresh.jsx';

// New chat: pick one person from the user directory ('Find users': name,
// username or user group, with the user-group chips); onPick(user) opens the
// conversation -- the existing one, or a new one that the first message creates.
export default function NewChatDialog({ meUsername, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [groupId, setGroupId] = useState(0);
  const [groups, setGroups] = useState([]);
  const [found, setFound] = useState({ status: 'loading', users: [], error: '' });
  const inputRef = useRef(null);
  const dirVersion = useDirectoryVersion();
  const me = String(meUsername || '').toLowerCase();

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { loadUserGroups().then(setGroups).catch(() => {}); }, [dirVersion]);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      setFound(f => ({ ...f, status: 'loading', error: '' }));
      findUsers(q.trim(), groupId ? 300 : 50, groupId)
        .then(users => { if (alive) setFound({ status: 'ready', users: users.filter(u => u.username !== me), error: '' }); })
        .catch(err => { if (alive) setFound({ status: 'error', users: [], error: err.message || 'Could not search.' }); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, groupId, me, dirVersion]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return (
    <div role="dialog" aria-modal="true" aria-label="New chat" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        width: 'min(480px, 100%)', maxHeight: 'min(640px, 92vh)', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
        borderRadius: 16, boxShadow: 'var(--shadow-lg)', fontFamily: 'var(--font)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px 20px', borderBottom: '1px solid var(--border)' }}>
          <MessageCirclePlus size={20} style={{ color: 'var(--accent-strong)' }} aria-hidden="true" />
          <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>New chat</h2>
          <button onClick={onClose} aria-label="Close" style={{
            width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderRadius: 10, background: 'var(--bg)', color: 'var(--muted)' }}>
            <Search size={15} />
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Who do you want to chat with?" aria-label="Search people"
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={q} onClear={() => setQ('')} />
            <DirectoryRefresh size={28} />
          </div>
          <div role="group" aria-label="User group" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
            {[{ id: 0, name: 'All', count: null }, ...groups].map(g => {
              const on = g.id === groupId;
              return (
                <button key={g.id} type="button" onClick={() => setGroupId(on && g.id ? 0 : g.id)} aria-pressed={on} style={{
                  flexShrink: 0, height: 30, padding: '0 11px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)',
                  fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'var(--accent)' : 'var(--surface)', color: on ? 'var(--on-accent)' : 'var(--text2)',
                }}><span dir="auto">{g.name}</span>{g.count != null && <span style={{ opacity: 0.75, fontWeight: 600 }}> · {g.count}</span>}</button>
              );
            })}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 160, overflowY: 'auto', padding: 8 }}>
          {found.status === 'loading' && <div role="status" style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Searching…</div>}
          {found.status === 'error' && <div role="alert" style={{ padding: 16, color: 'var(--red)', fontSize: 13 }}>{found.error}</div>}
          {found.status === 'ready' && found.users.length === 0 && <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Nobody matches.</div>}
          {found.status === 'ready' && found.users.map(u => (
            <button key={u.id} onClick={() => onPick(u)} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 10, border: 'none',
              background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-soft)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
              <Avatar name={u.name} size={36} photoUrl={u.photoUrl} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}><span dir="auto"><Mark text={u.name} terms={terms} /></span></span>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span dir="auto"><Mark text={[u.jobTitle, u.userGroup].filter(Boolean).join(' · ') || `@${u.username}`} terms={terms} /></span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
