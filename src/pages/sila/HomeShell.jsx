import React, { useEffect, useRef, useState } from 'react';
import { Home, MessageCircle, Users, Hash, Settings, Search, Plus, Ticket, LogOut, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { useLive, retryLiveNow } from '../../shared/live.js';

// The landing shell (design/mockups/Home.dc.html): rail, conversation list,
// conversation pane. The lists are empty until their data step is built;
// presence and the connection state are live already.

const SECTIONS = [
  { key: 'home', label: 'Home', icon: Home, title: 'Home', hint: 'Search people, groups, tickets' },
  { key: 'chats', label: 'Chats', icon: MessageCircle, title: 'Chats', hint: 'Search people' },
  { key: 'groups', label: 'Groups', icon: Users, title: 'Groups', hint: 'Search groups' },
  { key: 'channels', label: 'Channels', icon: Hash, title: 'Channels', hint: 'Search tickets' },
];
const FILTERS = ['All', 'Unread', 'Chats', 'Groups', 'Tickets'];

function initials(name) {
  return (name || '?').split(/[\s._-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function Avatar({ name, size = 40, online }) {
  return (
    <span style={{ position: 'relative', flex: `0 0 ${size}px`, width: size, height: size }}>
      <span style={{
        width: size, height: size, borderRadius: size / 2, background: 'var(--accent)', color: 'var(--on-accent)',
        fontWeight: 700, fontSize: size * 0.36, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{initials(name)}</span>
      {online && <span title="Online" style={{
        position: 'absolute', right: 0, bottom: 0, width: size * 0.28, height: size * 0.28, borderRadius: '50%',
        background: 'var(--online)', border: '2px solid var(--surface)',
      }} />}
    </span>
  );
}

function useNarrow(px = 820) {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

function ConnectionBar({ live }) {
  if (live.status === 'connected' || live.status === 'idle') return null;
  const waiting = live.status === 'waiting';
  const secs = live.retryAt ? Math.max(1, Math.round((live.retryAt - Date.now()) / 1000)) : null;
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 20px', fontSize: 12, fontWeight: 700,
      background: 'var(--amber-soft)', color: 'var(--amber)', borderBottom: '1px solid var(--border)',
    }}>
      {waiting ? <WifiOff size={14} /> : <RefreshCw size={14} />}
      <span style={{ flex: 1 }}>
        {waiting ? `Not connected — live updates paused${secs ? `, retrying in ${secs} s` : ''}.` : 'Connecting…'}
      </span>
      {waiting && (
        <button onClick={retryLiveNow} style={{
          border: 'none', background: 'transparent', color: 'var(--amber)', fontWeight: 800, cursor: 'pointer', fontSize: 12,
        }}>Retry now</button>
      )}
    </div>
  );
}

export default function HomeShell({ user, onSignOut }) {
  const live = useLive();
  const narrow = useNarrow();
  const [section, setSection] = useState('home');
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const current = SECTIONS.find(s => s.key === section);
  const me = user.username.toLowerCase();
  const others = [...live.online].filter(u => u !== me);

  // re-render once a second while a retry countdown is showing
  const [, tick] = useState(0);
  useEffect(() => {
    if (live.status !== 'waiting' || !live.retryAt) return undefined;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.status, live.retryAt]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = e => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const railItem = (s) => {
    const active = s.key === section;
    const Icon = s.icon;
    return (
      <button key={s.key} onClick={() => setSection(s.key)} aria-current={active ? 'page' : undefined} style={{
        width: narrow ? 64 : 68, minHeight: narrow ? 52 : 60, borderRadius: 12, border: 'none', cursor: 'pointer',
        background: active ? 'var(--accent)' : 'transparent', color: active ? 'var(--on-accent)' : 'var(--rail-text)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        fontFamily: 'var(--font)', fontSize: 11, fontWeight: active ? 700 : 600,
      }}>
        <Icon size={22} strokeWidth={1.8} />
        {s.label}
      </button>
    );
  };

  const rail = (
    <nav aria-label="Main" style={narrow ? {
      order: 2, flex: '0 0 auto', background: 'var(--rail)', display: 'flex', justifyContent: 'space-around', padding: '6px 4px',
    } : {
      flex: '0 0 84px', background: 'var(--rail)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '16px 0',
    }}>
      {!narrow && (
        <div style={{
          width: 44, height: 44, borderRadius: 13, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 800,
          fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
        }}>S</div>
      )}
      {SECTIONS.map(railItem)}
      {!narrow && <div style={{ flex: 1 }} />}
      {!narrow && (
        <button aria-label="Settings" title="Settings (coming soon)" disabled style={{
          width: 44, height: 44, borderRadius: 12, border: 'none', background: 'transparent', color: 'var(--rail-text)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6,
        }}><Settings size={22} strokeWidth={1.8} /></button>
      )}
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button onClick={() => setMenuOpen(o => !o)} aria-label="Account" aria-expanded={menuOpen} style={{
          border: 'none', background: 'transparent', padding: narrow ? 6 : 0, cursor: 'pointer', borderRadius: 24,
        }}>
          <Avatar name={user.displayName} size={narrow ? 36 : 40} online={live.status === 'connected'} />
        </button>
        {menuOpen && (
          <div role="menu" style={{
            position: 'absolute', zIndex: 20, minWidth: 220, background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 12, boxShadow: 'var(--shadow-lg)', padding: 8,
            ...(narrow ? { right: 0, bottom: 54 } : { left: 56, bottom: 0 }),
          }}>
            <div style={{ padding: '8px 10px 10px', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
              <div style={{ fontWeight: 800, color: 'var(--text)' }}>{user.displayName}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>@{user.username}</div>
            </div>
            <button role="menuitem" onClick={onSignOut} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', border: 'none',
              borderRadius: 8, background: 'transparent', color: 'var(--red)', fontFamily: 'var(--font)',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', textAlign: 'left',
            }}><LogOut size={16} /> Sign out</button>
          </div>
        )}
      </div>
    </nav>
  );

  const list = (
    <section aria-label={current.title} style={{
      flex: narrow ? '1 1 auto' : '0 0 380px', minWidth: 0, minHeight: 0, background: 'var(--surface)',
      borderRight: narrow ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '20px 20px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{current.title}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled title="Coming soon" style={{
            height: 44, padding: '0 14px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, opacity: 0.55,
          }}><Ticket size={16} /> Ticket</button>
          <button disabled title="Coming soon" style={{
            height: 44, padding: '0 14px', borderRadius: 12, border: 'none', background: 'var(--accent)',
            color: 'var(--on-accent)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, opacity: 0.55,
          }}><Plus size={16} /> New chat</button>
        </div>
      </div>
      <div style={{ padding: '0 20px 10px' }}>
        <label htmlFor="home-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {current.hint}
        </label>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 44, padding: '0 14px', borderRadius: 12,
          background: 'var(--bg)', color: 'var(--muted)',
        }}>
          <Search size={18} />
          <input id="home-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={current.hint} style={{
            flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 14,
            color: 'var(--text)', fontFamily: 'var(--font)',
          }} />
        </div>
      </div>
      {section === 'home' && (
        <div role="tablist" aria-label="Show" style={{ display: 'flex', gap: 6, padding: '0 20px 12px', flexWrap: 'wrap' }}>
          {FILTERS.map(f => {
            const on = f === filter;
            return (
              <button key={f} role="tab" aria-selected={on} onClick={() => setFilter(f)} style={{
                height: 34, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, fontWeight: 700, fontSize: 12,
                background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent-strong)' : 'var(--text2)',
              }}>{f}</button>
            );
          })}
        </div>
      )}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--muted)', gap: 6,
      }}>
        <current.icon size={32} strokeWidth={1.5} />
        <div style={{ fontWeight: 700, color: 'var(--text2)' }}>No conversations to show yet</div>
        <div style={{ fontSize: 13, maxWidth: 260 }}>Your {current.key === 'home' ? 'chats, groups and tickets' : current.label.toLowerCase()} will appear here.</div>
      </div>
    </section>
  );

  const pane = !narrow && (
    <main style={{
      flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'var(--soft)', padding: 32, textAlign: 'center', gap: 18,
    }}>
      <Avatar name={user.displayName} size={72} online={live.status === 'connected'} />
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>Welcome, {user.displayName}</h2>
        <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>Pick a conversation on the left to open it here.</p>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700,
        color: live.status === 'connected' ? 'var(--online)' : 'var(--muted)',
      }}>
        {live.status === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
        {live.status === 'connected' ? 'Live updates on' : 'Live updates off'}
      </div>
      {live.status === 'connected' && (
        <div style={{ width: '100%', maxWidth: 420, textAlign: 'left' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', marginBottom: 8 }}>
            Online now · {others.length}
          </div>
          {others.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Nobody else is online right now.</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {others.map(u => (
                <span key={u} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 4px', borderRadius: 999,
                  background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text)',
                }}>
                  <Avatar name={u} size={26} online />
                  {u}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: narrow ? 'column' : 'row', background: 'var(--bg)',
      color: 'var(--text)', fontFamily: 'var(--font)', overflow: 'hidden',
    }}>
      {rail}
      <div style={{ order: 1, flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ConnectionBar live={live} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {list}
          {pane}
        </div>
      </div>
    </div>
  );
}
