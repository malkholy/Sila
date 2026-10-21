import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Home, MessageCircle, Users, Hash, Settings, Search, Plus, Ticket, LogOut, Wifi, WifiOff, RefreshCw, Mail, CheckSquare,
} from 'lucide-react';
import { useLive, retryLiveNow, onLive } from '../../shared/live.js';
import { loadLeftSide, mergeLeftSide, formatWhen } from '../../shared/leftSide.js';
import Avatar from './Avatar.jsx';
import ChatPane from './ChatPane.jsx';
import NewGroupDialog from './NewGroupDialog.jsx';

// The landing shell (design/mockups/Home.dc.html): rail, conversation list,
// conversation pane. The list is the user's "left side" (dbo.APISilaWebOperation
// 'Left side'), loaded after sign-in; opening a conversation is the next step.
// Presence and the connection state are live.

const SECTIONS = [
  { key: 'home', label: 'Home', icon: Home, title: 'Home', hint: 'Search people, groups, tickets' },
  { key: 'chats', label: 'Chats', icon: MessageCircle, title: 'Chats', hint: 'Search people' },
  { key: 'groups', label: 'Groups', icon: Users, title: 'Groups', hint: 'Search groups' },
  { key: 'channels', label: 'Channels', icon: Hash, title: 'Channels', hint: 'Search tickets' },
];
// filter / section -> which list kinds it shows (null = all)
const FILTER_KINDS = { All: null, Unread: null, Chats: ['chat'], Groups: ['group'], Tickets: ['ticket'], Tasks: ['task'], Mail: ['mail'] };
const SECTION_KINDS = { home: null, chats: ['chat'], groups: ['group'], channels: ['ticket'] };
const KIND_ICON = { group: Users, ticket: Hash, mail: Mail, task: CheckSquare, other: MessageCircle };

// Square badge for non-person conversations (group / ticket / mail / task)
function KindBadge({ kind, size = 46 }) {
  const Icon = KIND_ICON[kind] || MessageCircle;
  const ticket = kind === 'ticket';
  return (
    <span style={{
      flex: `0 0 ${size}px`, width: size, height: size, borderRadius: 13, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: ticket ? 'var(--accent-soft)' : 'var(--soft)',
      border: `1.5px solid ${ticket ? 'var(--accent-line)' : 'var(--border)'}`,
      color: ticket ? 'var(--accent-strong)' : 'var(--text2)',
    }}><Icon size={22} strokeWidth={1.8} /></span>
  );
}

function ConversationRow({ item, active, online, onPick }) {
  const unread = item.unread > 0;
  return (
    <button onClick={onPick} aria-current={active ? 'true' : undefined} style={{
      display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: 12, borderRadius: 12, border: 'none',
      background: active ? 'var(--accent-soft)' : 'transparent', textAlign: 'left', cursor: 'pointer',
      color: 'var(--text)', fontFamily: 'var(--font)',
    }}>
      {item.kind === 'chat' ? <Avatar name={item.title} size={46} online={online} photoUrl={item.photoUrl} /> : <KindBadge kind={item.kind} />}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto">{item.title}</span>
          <span style={{ fontSize: 12, color: unread ? 'var(--accent-strong)' : 'var(--muted)', flexShrink: 0, fontWeight: unread ? 700 : 400 }}>
            {formatWhen(item.at)}
          </span>
        </span>
        {(item.sub || item.state) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', minWidth: 0 }}>
            {item.sub && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto">{item.sub}</span>}
            {item.state && (
              <span style={{
                flexShrink: 0, padding: '0 7px', borderRadius: 999, background: item.tone[1], color: item.tone[0],
                fontSize: 11, fontWeight: 700,
              }}>{item.state}</span>
            )}
          </span>
        )}
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <span dir="auto" style={{
            fontSize: 13, color: unread ? 'var(--text)' : 'var(--muted)', fontWeight: unread ? 600 : 400,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{item.preview || ' '}</span>
          {unread && (
            <span aria-label={`${item.unread} unread`} style={{
              minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: 'var(--accent)',
              color: 'var(--on-accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0,
            }}>{item.unread > 99 ? '99+' : item.unread}</span>
          )}
        </span>
      </span>
    </button>
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

  // ---- the left side (conversation list)
  const [left, setLeft] = useState({ status: 'loading', items: [], error: '' });
  const [selectedId, setSelectedId] = useState(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const loadSeq = useRef(0);
  // Full load: sign-in, the Refresh button, and whenever the last one is over
  // 10 minutes old (a delta can't see deleted rows or Hide / UnHide). In
  // between, syncLeft asks only for rows whose SynSequence moved (MaxSeq).
  const FULL_EVERY_MS = 10 * 60_000;
  const sync = useRef({ maxSeq: 0, fullAt: 0, busy: false, again: false });
  const reload = useCallback(() => {
    const seq = ++loadSeq.current;
    setLeft(s => ({ ...s, status: s.items.length ? 'refreshing' : 'loading', error: '' }));
    loadLeftSide()
      .then(({ items, maxSeq }) => {
        if (seq !== loadSeq.current) return;
        sync.current = { ...sync.current, maxSeq, fullAt: Date.now() };
        setLeft({ status: 'ready', items, error: '' });
      })
      .catch(err => { if (seq === loadSeq.current) setLeft(s => ({ ...s, status: 'error', error: err.message || 'Could not load your conversations.' })); });
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const syncLeft = useCallback(() => {
    const st = sync.current;
    if (!st.fullAt) return;
    if (st.busy) { st.again = true; return; }   // a change arrived mid-sync: run once more after
    if (Date.now() - st.fullAt > FULL_EVERY_MS) { reload(); return; }
    st.busy = true;
    const seq = loadSeq.current;
    loadLeftSide(st.maxSeq)
      .then(({ items: delta, maxSeq }) => {
        if (seq !== loadSeq.current) return;   // a full load started meanwhile
        sync.current.maxSeq = maxSeq;
        if (delta.length) setLeft(s => (s.status === 'ready' || s.status === 'refreshing' ? { ...s, items: mergeLeftSide(s.items, delta) } : s));
      })
      .catch(() => { /* next tick retries */ })
      .finally(() => {
        sync.current.busy = false;
        if (sync.current.again) { sync.current.again = false; syncLeftRef.current(); }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  const syncLeftRef = useRef(syncLeft);
  syncLeftRef.current = syncLeft;
  // live: a "changed" event (SilaApi watches SynSequence) or a (re)connect -> delta now
  useEffect(() => {
    const offChanged = onLive('changed', () => syncLeft());
    const offHello = onLive('hello', () => syncLeft());
    return () => { offChanged(); offHello(); };
  }, [syncLeft]);
  // fallback when the socket is down: changed conversations every 60 s and on return to the tab
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') syncLeft(); };
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [syncLeft]);

  // a group was created: reload the list, then open it (its row comes from SilaHistory)
  const onGroupCreated = useCallback(({ groupId }) => {
    setNewGroupOpen(false);
    const seq = ++loadSeq.current;
    loadLeftSide()
      .then(({ items, maxSeq }) => {
        if (seq !== loadSeq.current) return;
        sync.current = { ...sync.current, maxSeq, fullAt: Date.now() };
        setLeft({ status: 'ready', items, error: '' });
        const made = items.find(i => i.kind === 'group' && i.raw?.GroupID === groupId);
        if (made) setSelectedId(made.id);
      })
      .catch(err => setLeft(s => ({ ...s, status: 'error', error: err.message || 'Could not load your conversations.' })));
  }, []);

  const filters = useMemo(() => {
    const has = (k) => left.items.some(i => i.kind === k);
    const base = ['All', 'Unread', 'Chats', 'Groups', 'Tickets'];
    if (has('task')) base.push('Tasks');
    if (has('mail')) base.push('Mail');
    return base.map(f => ({
      key: f,
      unread: left.items.filter(i => (!FILTER_KINDS[f] || FILTER_KINDS[f].includes(i.kind)) && i.unread > 0).length,
    }));
  }, [left.items]);

  const visible = useMemo(() => {
    const kinds = SECTION_KINDS[section] || (section === 'home' ? FILTER_KINDS[filter] : null);
    const q = query.trim().toLowerCase();
    return left.items.filter(i =>
      (!kinds || kinds.includes(i.kind))
      && (section !== 'home' || filter !== 'Unread' || i.unread > 0)
      && (!q || [i.title, i.sub, i.preview, i.state].some(t => t && t.toLowerCase().includes(q))));
  }, [left.items, section, filter, query]);
  const selected = left.items.find(i => i.id === selectedId) || null;

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
          <button onClick={reload} disabled={left.status === 'loading' || left.status === 'refreshing'}
            aria-label="Refresh conversations" title="Refresh" style={{
              width: 44, height: 44, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}><RefreshCw size={18} style={left.status === 'refreshing' ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
          <button onClick={() => setNewGroupOpen(true)} title="New group" style={{
            height: 44, padding: '0 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            fontFamily: 'var(--font)',
          }}><Users size={16} /> Group</button>
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
          {filters.map(({ key: f, unread }) => {
            const on = f === filter;
            return (
              <button key={f} role="tab" aria-selected={on} onClick={() => setFilter(f)} style={{
                height: 34, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, fontWeight: 700, fontSize: 12,
                background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent-strong)' : 'var(--text2)',
              }}>{f}{unread > 0 && f !== 'Unread' ? ` · ${unread}` : ''}</button>
            );
          })}
        </div>
      )}
      {left.status === 'error' && (
        <div role="alert" style={{
          margin: '0 20px 10px', padding: '10px 12px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)',
          fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1 }}>{left.error}</span>
          <button onClick={reload} style={{
            border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 800, cursor: 'pointer',
            fontFamily: 'var(--font)', fontSize: 13,
          }}>Try again</button>
        </div>
      )}
      {left.status === 'loading' ? (
        <div role="status" style={{ flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[0, 1, 2, 3, 4, 5].map(n => (
            <div key={n} aria-hidden="true" style={{ display: 'flex', gap: 12, padding: 12, alignItems: 'center', opacity: 1 - n * 0.13 }}>
              <span style={{ width: 46, height: 46, borderRadius: 23, background: 'var(--soft)' }} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ height: 12, width: '55%', borderRadius: 6, background: 'var(--soft)' }} />
                <span style={{ height: 10, width: '80%', borderRadius: 5, background: 'var(--soft)' }} />
              </span>
            </div>
          ))}
          <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Loading conversations…</span>
        </div>
      ) : visible.length === 0 ? (
        <div style={{
          flex: 1, overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--muted)', gap: 6,
        }}>
          <current.icon size={32} strokeWidth={1.5} />
          <div style={{ fontWeight: 700, color: 'var(--text2)' }}>
            {query.trim() ? 'No matches' : left.items.length ? 'Nothing here' : 'No conversations yet'}
          </div>
          <div style={{ fontSize: 13, maxWidth: 260 }}>
            {query.trim() ? 'Try another name, subject or ticket number.'
              : left.items.length ? 'Pick another filter to see more.'
              : `Your ${current.key === 'home' ? 'chats, groups and tickets' : current.label.toLowerCase()} will appear here.`}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {visible.map(item => (
            <ConversationRow key={item.id} item={item} active={item.id === selectedId}
              online={!!item.username && live.online.has(item.username)}
              onPick={() => setSelectedId(item.id)} />
          ))}
        </div>
      )}
    </section>
  );

  const markRead = (id) => setLeft(s => ({ ...s, items: s.items.map(i => (i.id === id ? { ...i, unread: 0 } : i)) }));
  // a message sent from the pane: new preview, and the conversation moves to the top
  const onActivity = useCallback((id, { preview, at }) => setLeft(s => ({
    ...s,
    items: s.items.map(i => (i.id === id ? { ...i, preview, at } : i))
      .sort((a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0)),
  })), []);
  const isOnline = useCallback((username) => !!username && live.online.has(username), [live.online]);
  const pane = !narrow && (selected?.kind === 'chat' || selected?.kind === 'group' ? (
    <ChatPane key={selected.id} item={selected} onRead={markRead} onActivity={onActivity} isOnline={isOnline} />
  ) : selected ? (
    <main style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--soft)' }}>
      <header style={{
        minHeight: 72, padding: '12px 24px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        {selected.kind === 'chat'
          ? <Avatar name={selected.title} size={44} photoUrl={selected.photoUrl}
              online={!!selected.username && live.online.has(selected.username)} />
          : <KindBadge kind={selected.kind} size={44} />}
        <div style={{ minWidth: 0 }}>
          {selected.sub && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }} dir="auto">{selected.sub}</div>}
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--text)' }} dir="auto">{selected.title}</h2>
        </div>
        {selected.state && (
          <span style={{
            padding: '2px 10px', borderRadius: 999, background: selected.tone[1], color: selected.tone[0],
            fontSize: 12, fontWeight: 700,
          }}>{selected.state}</span>
        )}
      </header>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: 32, textAlign: 'center', color: 'var(--muted)',
      }}>
        <MessageCircle size={32} strokeWidth={1.5} />
        <div style={{ fontWeight: 700, color: 'var(--text2)' }}>Messages will open here</div>
        <div style={{ fontSize: 13, maxWidth: 320 }}>Loading the conversation itself is the next step.</div>
      </div>
    </main>
  ) : (
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
  ));

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
      {newGroupOpen && <NewGroupDialog onClose={() => setNewGroupOpen(false)} onCreated={onGroupCreated} />}
    </div>
  );
}
