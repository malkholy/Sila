import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Home, MessageCircle, Users, Hash, Settings, Search, LogOut, Wifi, WifiOff, RefreshCw, Mail, CheckSquare,
  ListChecks, User, LayoutList, Columns3, GripVertical, Bell, BellOff, X, Plus, Flag, UserCheck, BarChart3, Megaphone,
  MessageCirclePlus, UsersRound, CalendarCheck,
} from 'lucide-react';
import { useLive, retryLiveNow, onLive } from '../../shared/live.js';
import { loadLeftSide, mergeLeftSide, formatWhen } from '../../shared/leftSide.js';
import { notifyMessage, useNotifyState, enableNotify, disableNotify } from '../../shared/notify.js';
import { isSelectingText, noWordSelect } from '../../shared/textSelection.js';
import { moveRowFocus } from '../../shared/rowNav.js';
import { loadDirectory, startDirectory, loadChannels } from '../../shared/chat.js';
import Avatar from './Avatar.jsx';
import ChatPane from './ChatPane.jsx';
import ChannelsBoard, { Segmented } from './ChannelsBoard.jsx';
import SystemSettings from './SystemSettings.jsx';
import { canSeeSettings } from '../../shared/settings.js';
import ClearSearch from './ClearSearch.jsx';
import NewTicketDialog from './NewTicketDialog.jsx';
import Reports from './Reports.jsx';
import { FlagMark } from './TicketFlag.jsx';
import { AssigneeTag } from './TicketAssign.jsx';
import SlaBadge from './SlaBadge.jsx';
import ProfileCard from './ProfileCard.jsx';
import NewChatDialog from './NewChatDialog.jsx';
import NewGroupDialog from './NewGroupDialog.jsx';
import MyDay from './MyDay.jsx';
import MailPage from './MailPage.jsx';
import ReminderToast from './ReminderToast.jsx';
import { myDayCount, MYDAY_CHANGED } from '../../shared/reminders.js';
import Mark from './Mark.jsx';
import silaLogo from '../../Assets/sila_logo.png';
import { setTicketFlag } from '../../shared/ticketFlag.js';
import { toBoardTicket } from '../../shared/chat.js';

// The landing shell (design/mockups/Home.dc.html): rail, conversation list,
// conversation pane. The list is the user's "left side" (dbo.APISilaWebOperation
// 'Left side'); chats, groups and tickets open in ChatPane. Presence, the list
// and open conversations follow the live channel.

const SECTIONS = [
  { key: 'home', label: 'Home', icon: Home, title: 'Home', hint: 'Search people, groups, tickets' },
  { key: 'chats', label: 'Chats', icon: MessageCircle, title: 'Chats', hint: 'Search people' },
  { key: 'groups', label: 'Groups', icon: Users, title: 'Groups', hint: 'Search groups' },
  { key: 'channels', label: 'Channels', icon: Hash, title: 'Channels', hint: 'Search tickets' },
];
// filter / section -> which list kinds it shows (null = all)
const FILTER_KINDS = { All: null, Unread: null, Chats: ['chat'], Groups: ['group'], Tickets: ['ticket'], Tasks: ['task'], Mail: ['mail'] };
const SECTION_KINDS = { home: null, chats: ['chat'], groups: ['group'], channels: ['ticket'] };
// Channels: the conversation list, or the Order Board grouped views (ChannelsBoard)
const CHANNEL_VIEWS = [
  ['conv', 'Conversation', MessageCircle], ['status', 'By Status', ListChecks],
  ['channel', 'By Channel', Hash], ['creator', 'Created by', User], ['assignee', 'By Assignee', UserCheck],
];
// Home: one list + the conversation pane, or three panels side by side
// (Chats | Groups | Tickets) with the conversation in a drawer on the right
const HOME_VIEWS = [['list', 'List', LayoutList], ['panels', 'Panels', Columns3]];
const PANELS = [
  { key: 'chat', title: 'Chats', icon: MessageCircle, empty: 'No chats yet.' },
  { key: 'group', title: 'Groups', icon: Users, empty: 'No groups yet.' },
  { key: 'ticket', title: 'Tickets', icon: Hash, empty: 'No open tickets.' },
];
// Tickets panel: the "Open" toggle shows New + In Progress only (CHA.TicketState 0, 1)
const OPEN_STATES = [0, 1];
// Tickets panel sort; the Today / Yesterday lines show only for 'last' (time order)
const TICKET_SORTS = [['last', 'Last update'], ['unread', 'Unread first'], ['state', 'Status'], ['number', 'Ticket #'], ['channel', 'Channel']];
const STATE_ORDER = [0, 1, 2, 3, 5, 10, 50];   // New, In Progress, Forwarded, Approve Waiting, Hold, End, Close
const byTime = (a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0);
const TICKET_SORT_FN = {
  last: byTime,
  unread: (a, b) => (b.unread > 0) - (a.unread > 0) || b.unread - a.unread || byTime(a, b),
  state: (a, b) => {
    const r = (i) => { const k = STATE_ORDER.indexOf(Number(i.raw?.TicketState)); return k < 0 ? 99 : k; };
    return r(a) - r(b) || byTime(a, b);
  },
  number: (a, b) => (Number(b.raw?.TicketID) || 0) - (Number(a.raw?.TicketID) || 0),
  channel: (a, b) => String(a.raw?.ChannelName || '').localeCompare(String(b.raw?.ChannelName || '')) || byTime(a, b),
};
// the New chat / New group buttons: icon-only in the list header, with a label in the Panels bar
const newBtn = {
  height: 36, minWidth: 36, padding: '0 6px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
};
const newTextBtn = {
  height: 36, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer', flexShrink: 0,
};
const KIND_ICON = { group: Users, ticket: Hash, mail: Mail, task: CheckSquare, other: MessageCircle };

// Square badge for non-person conversations (group / ticket / mail / task);
// a ticket's badge takes its state colour (tone = [fg, bg]) when it has one
// broadcast: an announcement group -- megaphone, accent colours and a "B" tag
function KindBadge({ kind, size = 46, tone, broadcast = false }) {
  const Icon = broadcast ? Megaphone : KIND_ICON[kind] || MessageCircle;
  const ticket = kind === 'ticket';
  const toned = ticket && tone && tone[0] !== 'var(--text2)';
  return (
    <span style={{
      flex: `0 0 ${size}px`, width: size, height: size, borderRadius: 13, display: 'flex', alignItems: 'center',
      justifyContent: 'center', position: 'relative',
      background: toned ? tone[1] : ticket || broadcast ? 'var(--accent-soft)' : 'var(--soft)',
      border: `1.5px solid ${toned ? tone[0] : ticket || broadcast ? 'var(--accent-line)' : 'var(--border)'}`,
      color: toned ? tone[0] : ticket || broadcast ? 'var(--accent-strong)' : 'var(--text2)',
    }}>
      <Icon size={22} strokeWidth={1.8} />
      {/* a group's "G" tag ("B" for broadcast), so groups stand out from people and tickets */}
      {kind === 'group' && (
        <span aria-hidden="true" style={{
          position: 'absolute', right: -4, bottom: -4, minWidth: 18, height: 18, borderRadius: 9, padding: '0 4px',
          background: 'var(--accent)', color: 'var(--on-accent)', border: '2px solid var(--bg)',
          fontSize: 10, fontWeight: 800, lineHeight: '14px', textAlign: 'center',
        }}>{broadcast ? 'B' : 'G'}</span>
      )}
    </span>
  );
}

// A ticket's system lines name the ticket and the person with "@":
// "@Mohammad Al Kholy has started Ticket #174769" -> "Mohammad Al Kholy started this ticket"
function ticketPreview(text, ticketId) {
  let t = String(text || '').replace(/^@/, '');
  if (ticketId) {
    t = t.replace(new RegExp(`\\b(forwarded )?Ticket #${ticketId}\\b`, 'i'), (_, fwd) => (fwd ? 'the forwarded ticket' : 'this ticket'));
  }
  return t.replace(/\bhas (started|ended|closed|reopened|held|forwarded|accepted|rejected|cancelled|canceled)\b/i, '$1');
}

// dbl: open on a double-click (the Panels view's drawer): a single click
// selects the row, Up / Down move the selection (rowNav.js), Enter opens it
// (a keyboard click has detail 0). In the List view a click opens the
// conversation and selects the row too, and Up / Down open the row they land
// on. The
// click focuses the row itself: Safari doesn't focus buttons on click.
// The search text marked inside a row's name / channel / number / preview
// (terms: the active searches, lower case; empty = plain text).

// onToggleFlag(item): F on a selected ticket row flags / unflags it.
function ConversationRow({ item, active, online, onPick, dbl = false, terms, onToggleFlag, meUser }) {
  const [focused, setFocused] = useState(false);
  const unread = item.unread > 0;
  const ticket = item.kind === 'ticket';
  const ticketCreator = ticket ? String(item.raw?.TicketCreatedBy || item.raw?.CreatedByName || item.raw?.CreatedByUser || '').trim() : '';
  const when = (
    <span style={{ fontSize: 12, color: unread ? 'var(--accent-strong)' : 'var(--muted)', flexShrink: 0, fontWeight: unread ? 700 : 400 }}>
      {formatWhen(item.at)}
    </span>
  );
  return (
    <button data-row data-rowid={item.id} onClick={(e) => { e.currentTarget.focus(); if (dbl && e.detail !== 0) return; if (!isSelectingText()) onPick(); }}
      onMouseDown={dbl ? noWordSelect : undefined} onDoubleClick={dbl ? onPick : undefined}
      onKeyDown={(e) => {
        if ((e.key === 'f' || e.key === 'F') && ticket && onToggleFlag && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault(); onToggleFlag(item); return;
        }
        // List view: the row Up / Down lands on opens too, as a click would
        // (Panels: it only moves the selection; the open drawer follows on its own)
        const from = e.currentTarget;
        if (moveRowFocus(e) && !dbl && document.activeElement !== from && document.activeElement?.hasAttribute('data-row')) {
          document.activeElement.click();
        }
      }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      aria-current={active ? 'true' : undefined} style={{
      display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: 12, borderRadius: 12, border: 'none',
      background: active ? 'var(--accent-soft)' : focused ? 'var(--soft)' : 'transparent', textAlign: 'left', cursor: 'pointer',
      outline: 'none', boxShadow: focused ? 'inset 0 0 0 2px var(--accent)' : 'none',
      color: 'var(--text)', fontFamily: 'var(--font)',
    }}>
      {item.kind === 'chat' ? <Avatar name={item.title} size={46} online={online} photoUrl={item.photoUrl} username={item.username} />
        : <KindBadge kind={item.kind} tone={item.tone} broadcast={item.broadcast} />}
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: ticket ? 'center' : 'baseline' }}>
          {/* a ticket leads with where it lives (the number quieter in mono), its subject below */}
          {ticket ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', minWidth: 0 }}>
              {item.raw?.ChannelName && (
                // Let long channel names wrap so the destination stays readable.
                <span title={item.raw.ChannelName} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%', minHeight: 26, padding: '3px 9px',
                  borderRadius: 7, background: 'var(--soft)', border: '1px solid var(--border2)', color: 'var(--text)',
                  fontSize: 13, lineHeight: 1.4, fontWeight: 700,
                }}>
                  <span dir="auto" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                    <Mark text={item.raw.ChannelName} terms={terms} />
                  </span>
                </span>
              )}
              {item.raw?.TicketID && (
                <span style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}><Mark text={`#${item.raw.TicketID}`} terms={terms} /></span>
              )}
            </span>
          ) : (
            <span style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto"><Mark text={item.title} terms={terms} /></span>
          )}
          {/* a ticket's state sits in the top-right corner, its SLA (Late …) under it; its time in the bottom-right one */}
          {ticket && item.state ? (
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <FlagMark flag={item.flag} />
                <span style={{
                  flexShrink: 0, padding: '1px 8px', borderRadius: 999, background: item.tone[1], color: item.tone[0],
                  fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                }}>{item.state}</span>
              </span>
              <SlaBadge sla={item.sla} state={Number(item.raw?.TicketState)} compact />
            </span>
          ) : when}
        </span>
        {ticket ? (
          <span style={{ marginTop: 4, fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto"><Mark text={item.title} terms={terms} /></span>
        ) : (item.sub || item.state) && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', minWidth: 0 }}>
            {item.sub && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto"><Mark text={item.sub} terms={terms} /></span>}
            {item.state && (
              <span style={{
                flexShrink: 0, padding: '0 7px', borderRadius: 999, background: item.tone[1], color: item.tone[0],
                fontSize: 11, fontWeight: 700,
              }}>{item.state}</span>
            )}
          </span>
        )}
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        {ticket ? (
          <span title={ticketCreator ? `Created by ${ticketCreator}` : 'Ticket creator unavailable'} style={{
            display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 0, marginTop: 3, marginBottom: 2,
            fontSize: 11.5, color: 'var(--muted)',
          }}>
            <User size={12} aria-hidden="true" style={{ flexShrink: 0 }} />
            <span style={{ flexShrink: 0 }}>Created by</span>
            <span dir="auto" style={{
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: 'var(--text2)', fontWeight: 600,
            }}>{ticketCreator || 'Unknown'}</span>
            {item.assignee && <span aria-hidden="true" style={{ color: 'var(--border2)' }}>·</span>}
            <AssigneeTag assignee={item.assignee} me={meUser} />
          </span>
        ) : (
          <span dir="auto" style={{
            flex: 1, minWidth: 0, textAlign: 'left',
            fontSize: 13, color: unread ? 'var(--text)' : 'var(--muted)', fontWeight: unread ? 600 : 400,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{item.preview ? <Mark text={item.preview} terms={terms} /> : ' '}</span>
        )}
          {unread && (
            <span aria-label={`${item.unread} unread`} style={{
              minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: 'var(--accent)',
              color: 'var(--on-accent)', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0,
            }}>{item.unread > 99 ? '99+' : item.unread}</span>
          )}
          {ticket && item.state && when}
        </span>
      </span>
    </button>
  );
}

// Day divider lines in a newest-first list: Today / Yesterday / Earlier,
// each shown once above the first conversation that falls in it.
function dayGroup(d, now = new Date()) {
  if (!d) return 'Earlier';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return 'Today';
  if (t >= start - 86_400_000) return 'Yesterday';
  return 'Earlier';
}
function withDayLines(items, renderRow) {
  const out = [];
  let last = null;
  for (const item of items) {
    const g = dayGroup(item.at);
    if (g !== last) {
      out.push(
        <div key={`day-${g}-${out.length}`} role="separator" aria-label={g} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: out.length ? '10px 12px 4px' : '4px 12px 4px',
          fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)',
        }}>
          {g}
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>,
      );
      last = g;
    }
    out.push(renderRow(item));
  }
  return out;
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
  const [channelsView, setChannelsView] = useState(() => {
    try { return localStorage.getItem('silaChannelsView') || 'conv'; } catch { return 'conv'; }
  });
  const [homeView, setHomeView] = useState(() => {
    try { return localStorage.getItem('silaHomeView') || 'list'; } catch { return 'list'; }
  });
  const pickHomeView = (v) => {
    setHomeView(v);
    try { localStorage.setItem('silaHomeView', v); } catch { /* private mode: not remembered */ }
  };
  const [drawerId, setDrawerId] = useState(null);   // Panels view: the conversation open in the drawer
  // Panels view: each panel's rows in the order shown (filled while rendering),
  // so Up / Down with the drawer open load the previous / next conversation of
  // the same panel -- unless the key is meant for a text box or a picker.
  const panelRowsRef = useRef({});
  useEffect(() => {
    if (drawerId == null || section !== 'home' || homeView !== 'panels') return undefined;
    const onKey = (e) => {
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const ids = Object.values(panelRowsRef.current).find(list => list.includes(drawerId));
      const next = ids?.[ids.indexOf(drawerId) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next == null) return;
      e.preventDefault();
      e.stopPropagation();   // the focused row would move its own selection as well
      setDrawerId(next);
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-rowid="${CSS.escape(String(next))}"]`);
        if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }); }
      });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [drawerId, section, homeView]);
  const notify = useNotifyState();
  const [unreadOnly, setUnreadOnly] = useState(() => new Set());   // Panels view: panels showing unread only
  // Panels view: the order of the three panels (drag a header, or the arrows), remembered
  const [panelOrder, setPanelOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('silaPanelsOrder') || 'null');
      if (Array.isArray(saved) && saved.length === PANELS.length && PANELS.every(p => saved.includes(p.key))) return saved;
    } catch { /* not remembered */ }
    return PANELS.map(p => p.key);
  });
  const savePanelOrder = (order) => {
    setPanelOrder(order);
    try { localStorage.setItem('silaPanelsOrder', JSON.stringify(order)); } catch { /* private mode: not remembered */ }
  };
  const movePanel = (key, to) => {   // to: the index it should take
    const from = panelOrder.indexOf(key);
    if (from < 0 || to < 0 || to >= panelOrder.length || to === from) return;
    const next = panelOrder.filter(k => k !== key);
    next.splice(to, 0, key);
    savePanelOrder(next);
  };
  const [ticketsOpenOnly, setTicketsOpenOnly] = useState(() => {
    try { return localStorage.getItem('silaPanelsTicketsOpen') === '1'; } catch { return false; }
  });
  const toggleTicketsOpen = () => setTicketsOpenOnly(v => {
    try { localStorage.setItem('silaPanelsTicketsOpen', v ? '0' : '1'); } catch { /* private mode: not remembered */ }
    return !v;
  });
  const [ticketsFlaggedOnly, setTicketsFlaggedOnly] = useState(false);   // Panels: the Tickets panel's Flagged filter
  const [ticketSort, setTicketSort] = useState(() => {
    try { const v = localStorage.getItem('silaPanelsTicketSort'); return TICKET_SORT_FN[v] ? v : 'last'; } catch { return 'last'; }
  });
  const pickTicketSort = (v) => {
    setTicketSort(v);
    try { localStorage.setItem('silaPanelsTicketSort', v); } catch { /* private mode: not remembered */ }
  };
  const [dragKey, setDragKey] = useState(null);
  const [dropKey, setDropKey] = useState(null);
  const toggleUnread = (key) => setUnreadOnly(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const pickChannelsView = (v) => {
    setChannelsView(v);
    try { localStorage.setItem('silaChannelsView', v); } catch { /* private mode: not remembered */ }
  };
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const current = SECTIONS.find(s => s.key === section) || SECTIONS[0];   // 'settings' has no list
  const settingsAllowed = canSeeSettings(user.username);
  // Reports: channel admins / team leaders (their channels) and mhd (all) -- the SP decides
  const [reportsAllowed, setReportsAllowed] = useState(settingsAllowed);
  useEffect(() => {
    if (settingsAllowed) return;
    loadChannels().then(list => setReportsAllowed(list.some(c => c.manager))).catch(() => { /* hidden */ });
  }, [settingsAllowed]);
  const me = user.username.toLowerCase();
  const others = [...live.online].filter(u => u !== me);

  // ---- the left side (conversation list)
  const [left, setLeft] = useState({ status: 'loading', items: [], error: '' });
  const [panelSearch, setPanelSearch] = useState({});   // Panels view: each panel's own search text
  const [newTicket, setNewTicket] = useState(false);     // the quick + New ticket form
  const [newChat, setNewChat] = useState(false);         // the New chat picker
  const [myDayDue, setMyDayDue] = useState(0);           // My Day rail badge: reminders + flags due today or earlier
  const [newGroup, setNewGroup] = useState(false);       // the New group form
  const [draftChat, setDraftChat] = useState(null);      // a new chat, until its first message creates it
  const openAfter = useRef(null);                        // { kind, key, id }: open once the list has its row
  const openTicketId = useRef(0);                        // a ticket just created: opened once its Home row arrives
  const [boardTicket, setBoardTicket] = useState(null);  // ... or, on the Channels board, opened in its drawer
  const [selectedId, setSelectedId] = useState(null);
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
  // the people directory for the pickers: now, then every 30 minutes
  useEffect(() => startDirectory(), []);
  // the Refresh buttons: conversations and the people directory
  const refreshAll = useCallback(() => { reload(); loadDirectory({ force: true }).catch(() => {}); }, [reload]);

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
        notifyNew(delta);
        // the conversation open in front of the user has nothing unread: its pane
        // marks the new messages read (ChatPane readNow); no badge in between
        const seen = document.visibilityState === 'visible'
          ? delta.map(d => (d.unread > 0 && openNowRef.current(d.id) ? { ...d, unread: 0 } : d)) : delta;
        if (seen.length) setLeft(s => (s.status === 'ready' || s.status === 'refreshing' ? { ...s, items: mergeLeftSide(s.items, seen) } : s));
      })
      .catch(() => { /* next tick retries */ })
      .finally(() => {
        sync.current.busy = false;
        if (sync.current.again) { sync.current.again = false; syncLeftRef.current(); }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  // desktop notifications: a conversation whose unread count went up in a delta,
  // unless it is the one on screen (the tab visible and that conversation open)
  const leftItemsRef = useRef([]);
  leftItemsRef.current = left.items;
  const openNowRef = useRef(() => false);
  const openFromNotice = useRef(() => {});
  const notifyNew = (delta) => {
    const before = new Map(leftItemsRef.current.map(i => [i.id, i]));
    for (const d of delta) {
      if (d.hidden || d.unread <= (before.get(d.id)?.unread || 0)) continue;
      if (document.visibilityState === 'visible' && openNowRef.current(d.id)) continue;
      const tid = d.raw?.TicketID;
      notifyMessage({
        id: d.id,
        title: d.kind === 'ticket' ? `#${tid} ${d.title}` : d.title,
        body: d.kind === 'ticket' ? ticketPreview(d.preview, tid) : d.preview || 'New message',
        onOpen: () => openFromNotice.current(d.id),
      });
    }
  };
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
  const selected = left.items.find(i => i.id === selectedId) || (draftChat && draftChat.id === selectedId ? draftChat : null);

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
        // narrow: the rail buttons share the bottom bar's width
        ...(narrow ? { flex: '1 1 0', minWidth: 0, maxWidth: 72 } : { width: 68 }), minHeight: narrow ? 52 : 60, borderRadius: 12,
        border: 'none', cursor: 'pointer',
        background: active ? 'var(--accent)' : 'transparent', color: active ? 'var(--on-accent)' : 'var(--rail-text)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        fontFamily: 'var(--font)', fontSize: 11, fontWeight: active ? 700 : 600,
      }}>
        <span style={{ position: 'relative', display: 'flex' }}>
          <Icon size={22} strokeWidth={1.8} />
          {s.badge > 0 && (
            <span aria-label={`${s.badge} due`} style={{
              position: 'absolute', top: -6, right: -12, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, boxSizing: 'border-box',
              background: active ? 'var(--on-accent)' : 'var(--accent)', color: active ? 'var(--accent-strong)' : 'var(--on-accent)',
              fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{s.badge > 99 ? '99+' : s.badge}</span>
          )}
        </span>
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
        <img src={silaLogo} alt="Sila" width={40} height={40} style={{ display: 'block', margin: '2px 0 16px' }} />
      )}
      {/* the quick New ticket button, on every screen */}
      <button onClick={() => setNewTicket(true)} aria-label="New ticket" title="New ticket" style={{
        width: narrow ? 44 : 48, height: narrow ? 44 : 48, borderRadius: 14, border: '1.5px dashed var(--accent)', cursor: 'pointer',
        background: 'transparent', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: narrow ? 0 : 8, flexShrink: 0, order: narrow ? 99 : undefined,
      }}><Plus size={22} strokeWidth={2.2} /></button>
      {SECTIONS.map(railItem)}
      {railItem({ key: 'myday', label: 'My Day', icon: CalendarCheck, badge: myDayDue })}
      {railItem({ key: 'mail', label: 'Mail', icon: Mail })}
      {!narrow && <div style={{ flex: 1 }} />}
      {reportsAllowed && (
        <button onClick={() => setSection('reports')} aria-label="Reports" title="Reports"
          aria-current={section === 'reports' ? 'page' : undefined} style={{
            width: 44, height: 44, borderRadius: 12, border: 'none', cursor: 'pointer',
            background: section === 'reports' ? 'var(--accent)' : 'transparent',
            color: section === 'reports' ? 'var(--on-accent)' : 'var(--rail-text)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><BarChart3 size={22} strokeWidth={1.8} /></button>
      )}
      {settingsAllowed && (
        // System Settings: the user 'mhd' only (the SP enforces it too)
        <button onClick={() => setSection('settings')} aria-label="System settings" title="System settings"
          aria-current={section === 'settings' ? 'page' : undefined} style={{
            width: 44, height: 44, borderRadius: 12, border: 'none', cursor: 'pointer',
            background: section === 'settings' ? 'var(--accent)' : 'transparent',
            color: section === 'settings' ? 'var(--on-accent)' : 'var(--rail-text)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
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
            {notify !== 'unsupported' && (
              <button role="menuitem" disabled={notify === 'blocked'}
                onClick={() => { if (notify === 'on') disableNotify(); else enableNotify(); }}
                title={notify === 'blocked' ? 'Allow notifications for this site in Chrome (the lock icon in the address bar)' : undefined}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', border: 'none',
                  borderRadius: 8, background: 'transparent', color: 'var(--text)', fontFamily: 'var(--font)',
                  fontSize: 13, fontWeight: 700, cursor: notify === 'blocked' ? 'not-allowed' : 'pointer', textAlign: 'left',
                  opacity: notify === 'blocked' ? 0.6 : 1,
                }}>
                {notify === 'on' ? <Bell size={16} /> : <BellOff size={16} />}
                <span style={{ flex: 1 }}>Desktop notifications</span>
                <span style={{ fontSize: 12, color: notify === 'on' ? 'var(--green)' : 'var(--muted)' }}>
                  {notify === 'on' ? 'On' : notify === 'blocked' ? 'Blocked' : 'Off'}
                </span>
              </button>
            )}
            {notify === 'on' && (
              // checks Chrome + the operating system can show one at all
              <button role="menuitem" onClick={() => notifyMessage({ id: 'test', title: 'Sila', body: 'Test notification — they work on this computer.' })}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', border: 'none',
                  borderRadius: 8, background: 'transparent', color: 'var(--text2)', fontFamily: 'var(--font)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
                }}><Bell size={16} /> Send a test notification</button>
            )}
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

  // the user's own ticket flag changed (header button, or F on a row): the row shows it at once.
  // A flag doesn't move SynSequence, so other devices see it on their next full load.
  const onFlagChange = useCallback((id, flag) => setLeft(s => ({ ...s, items: s.items.map(i => (i.id === id ? { ...i, flag } : i)) })), []);
  const toggleFlag = useCallback((item) => {
    const tid = Number(item.raw?.TicketID);
    if (!tid) return;
    setTicketFlag(tid, item.flag ? null : {}).then(flag => onFlagChange(item.id, flag)).catch(() => { /* unchanged */ });
  }, [onFlagChange]);

  const list = (
    <section aria-label={current.title} style={{
      flex: narrow ? '1 1 auto' : '0 0 430px', minWidth: 0, minHeight: 0, background: 'var(--surface)',
      borderRight: narrow ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ padding: '16px 16px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.03em' }}>{current.title}</h1>
            {section === 'home' && (
              <Segmented label="Home view" items={HOME_VIEWS} value={homeView} onPick={pickHomeView} height={32} />
            )}
          </div>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Your conversations, in one place</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {(section === 'home' || section === 'chats') && (
            <button onClick={() => setNewChat(true)} aria-label="New chat" title="New chat" style={newBtn}><MessageCirclePlus size={18} /></button>
          )}
          {(section === 'home' || section === 'groups') && (
            <button onClick={() => setNewGroup(true)} aria-label="New group" title="New group" style={newBtn}><UsersRound size={18} /><Plus size={11} strokeWidth={3} style={{ marginLeft: -4, marginTop: -10 }} /></button>
          )}
          <button onClick={refreshAll} disabled={left.status === 'loading' || left.status === 'refreshing'}
            aria-label="Refresh conversations" title="Refresh" style={{
              width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}><RefreshCw size={18} style={left.status === 'refreshing' ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
        </div>
      </div>
      <div style={{ padding: '0 16px 12px' }}>
        <label htmlFor="home-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {current.hint}
        </label>
        <div className="sila-conversation-search" style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 42, padding: '0 12px', borderRadius: 10,
          background: 'var(--bg)', color: 'var(--muted)',
        }}>
          <Search size={17} style={{ flexShrink: 0 }} aria-hidden="true" />
          <input id="home-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={current.hint} style={{
            flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 14,
            color: 'var(--text)', fontFamily: 'var(--font)',
          }} />
          {query && <button aria-label="Clear search" title="Clear search" onClick={() => {
            setQuery('');
            document.getElementById('home-search')?.focus();
          }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28,
            flexShrink: 0, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
          }}><X size={15} /></button>}
        </div>
      </div>
      {section === 'home' && (
        <div className="sila-conversation-filters" role="group" aria-label="Filter conversations">
          {filters.map(({ key: f, unread }) => {
            const on = f === filter;
            return (
              <button key={f} aria-pressed={on} onClick={e => {
                setFilter(f);
                e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
              }} className="sila-conversation-filter">
                {f}{unread > 0 && <span aria-label={`${unread} unread conversations`}>{unread}</span>}
              </button>
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
        <div data-rowlist style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {withDayLines(visible, item => (
            <ConversationRow key={item.id} item={item} active={item.id === selectedId} terms={[query.trim().toLowerCase()]}
              online={!!item.username && live.online.has(item.username)}
              onPick={() => setSelectedId(item.id)} onToggleFlag={toggleFlag} meUser={user.username} />
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
  const channelsSwitch = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>View</span>
      <Segmented label="Board view" items={CHANNEL_VIEWS} value={channelsView} onPick={pickChannelsView} />
    </div>
  );
  // a ticket just created (New ticket): open it on Home once the list has its row
  useEffect(() => {
    const id = openTicketId.current;
    if (!id) return;
    const it = left.items.find(i => i.kind === 'ticket' && Number(i.raw?.TicketID) === id);
    if (!it) return;
    openTicketId.current = 0;
    if (homeView === 'panels') setDrawerId(it.id); else setSelectedId(it.id);
  }, [left.items, homeView]);
  const onTicketCreated = useCallback((row) => {
    setNewTicket(false);
    reload();
    if (section === 'channels' && channelsView !== 'conv') { setBoardTicket(toBoardTicket(row)); return; }
    openTicketId.current = Number(row.TicketID);
    setSection('home');
  }, [reload, section, channelsView]);

  // My Day badge: on start, when something changes (MYDAY_CHANGED), and every 5 minutes
  useEffect(() => {
    const count = () => { myDayCount().then(setMyDayDue).catch(() => { /* next time */ }); };
    count();
    const t = setInterval(count, 5 * 60_000);
    window.addEventListener(MYDAY_CHANGED, count);
    return () => { clearInterval(t); window.removeEventListener(MYDAY_CHANGED, count); };
  }, []);
  // a reminder's (or a toast's) conversation: open it on Home, reloading the list when it isn't there yet
  const openLink = useCallback(({ linkKind, linkId }) => {
    const want = { kind: linkKind, key: linkKind === 'ticket' ? 'TicketID' : linkKind === 'group' ? 'GroupID' : 'SessionID', id: Number(linkId) };
    const it = left.items.find(i => i.kind === want.kind && Number(i.raw?.[want.key]) === want.id);
    if (it) { openFromNotice.current(it.id); return; }
    openAfter.current = want;
    reload();
  }, [left.items, reload]);
  // New chat / New group: open the conversation once the list has its row
  useEffect(() => {
    const want = openAfter.current;
    if (!want) return;
    const it = left.items.find(i => i.kind === want.kind && Number(i.raw?.[want.key]) === want.id);
    if (!it) return;
    openAfter.current = null;
    setDraftChat(null);
    openFromNotice.current(it.id);
  }, [left.items]);
  // a person picked in New chat: the conversation with them, or a new one (a
  // draft the first message creates: ChatPane onChatStarted)
  const startChat = (u) => {
    setNewChat(false);
    const have = left.items.find(i => i.kind === 'chat' && (Number(i.raw?.FromUserID) === u.id || i.username === u.username));
    if (have) { openFromNotice.current(have.id); return; }
    const d = {
      id: `draft-${u.id}`, kind: 'chat', draft: true, title: u.name, username: u.username, photoUrl: u.photoUrl,
      jobTitle: u.jobTitle, sub: u.jobTitle, at: new Date(), unread: 0, preview: '', seq: 0, hidden: false,
      raw: { SessionID: 0, ToUserID: u.id, FromUserID: u.id },
    };
    setDraftChat(d);
    openFromNotice.current(d.id);
  };
  const onChatStarted = useCallback((sessionId) => {
    openAfter.current = { kind: 'chat', key: 'SessionID', id: Number(sessionId) };
    reload();
  }, [reload]);
  const onGroupCreated = useCallback(({ groupId }) => {
    setNewGroup(false);
    openAfter.current = { kind: 'group', key: 'GroupID', id: Number(groupId) };
    reload();
  }, [reload]);

  // a ticket's state changed in the pane: refresh the list now (state label; a closed ticket leaves it)
  const onTicketChange = useCallback(() => syncLeftRef.current(), []);
  // the user left a group: close it and reload the list (a delta can't see a deleted row)
  const onLeaveGroup = useCallback((id) => {
    setSelectedId(cur => (cur === id ? null : cur));
    setDrawerId(cur => (cur === id ? null : cur));
    reload();
  }, [reload]);

  // ---- Home, Panels view: three lists side by side, the conversation in a drawer
  const homeBar = (
    <div style={{
      flexShrink: 0, padding: '12px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)', letterSpacing: '-.03em' }}>Home</h1>
        <Segmented label="Home view" items={HOME_VIEWS} value={homeView} onPick={pickHomeView} />
      </div>
      {homeView === 'panels' && (
        <>
          <div style={{
            flex: '1 1 220px', maxWidth: 420, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px', borderRadius: 8,
            border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--muted)',
          }}>
            <Search size={15} />
            <input id="panels-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="People, groups, tickets"
              aria-label="Search people, groups, tickets"
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={query} onClear={() => setQuery('')} size={24} style={{ marginRight: -6 }} />
          </div>
          <button onClick={() => setNewChat(true)} style={newTextBtn}><MessageCirclePlus size={15} /> New chat</button>
          <button onClick={() => setNewGroup(true)} style={newTextBtn}><UsersRound size={15} /> New group</button>
          <button onClick={refreshAll} disabled={left.status === 'loading' || left.status === 'refreshing'}
            aria-label="Refresh conversations" title="Refresh" style={{
              width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}><RefreshCw size={15} style={left.status === 'refreshing' ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
        </>
      )}
    </div>
  );

  const panelsQ = query.trim().toLowerCase();
  const hit = (i, q) => [i.title, i.sub, i.preview, i.state].some(t => t && t.toLowerCase().includes(q));
  const panels = (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', gap: 12, padding: 12, background: 'var(--bg)', overflowX: 'auto',
    }}>
      {panelOrder.map(k => PANELS.find(x => x.key === k)).map((p, index) => {
        // the Home search, then this panel's own search box
        const ownQ = (panelSearch[p.key] || '').trim().toLowerCase();
        const matching = left.items.filter(i => i.kind === p.key && (!panelsQ || hit(i, panelsQ)) && (!ownQ || hit(i, ownQ)));
        const unread = matching.reduce((n, i) => n + (i.unread > 0 ? 1 : 0), 0);
        const onlyUnread = unreadOnly.has(p.key);
        const stateOf = (i) => Number(i.raw?.TicketState);
        const wantStates = p.key === 'ticket' && ticketsOpenOnly ? OPEN_STATES : null;
        const flaggedOnly = p.key === 'ticket' && ticketsFlaggedOnly;
        const filteredRows = matching.filter(i => (!onlyUnread || i.unread > 0) && (!wantStates || wantStates.includes(stateOf(i)))
          && (!flaggedOnly || i.flag));
        const sortKey = p.key === 'ticket' ? ticketSort : 'last';
        const rows = sortKey === 'last' ? filteredRows : [...filteredRows].sort(TICKET_SORT_FN[sortKey]);
        panelRowsRef.current[p.key] = rows.map(i => i.id);
        const Icon = p.icon;
        return (
          <section key={p.key} aria-label={p.title}
            onDragOver={e => { if (dragKey && dragKey !== p.key) { e.preventDefault(); setDropKey(p.key); } }}
            onDragLeave={() => setDropKey(k => (k === p.key ? null : k))}
            onDrop={e => { e.preventDefault(); if (dragKey) movePanel(dragKey, index); setDragKey(null); setDropKey(null); }}
            style={{
              flex: '1 1 0', minWidth: 280, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)',
              border: `${dropKey === p.key ? 2 : 1}px ${dropKey === p.key ? 'dashed' : 'solid'} ${dropKey === p.key ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 14, overflow: 'hidden', opacity: dragKey === p.key ? 0.5 : 1,
            }}>
            <header draggable title="Drag to move this panel"
              onDragStart={e => { setDragKey(p.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.key); }}
              onDragEnd={() => { setDragKey(null); setDropKey(null); }}
              style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)',
                cursor: 'grab',
              }}>
              <GripVertical size={16} aria-hidden="true" style={{ color: 'var(--muted)', flexShrink: 0, marginRight: -4 }} />
              <span style={{
                width: 32, height: 32, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--accent-soft)', color: 'var(--accent-strong)', flexShrink: 0,
              }}><Icon size={17} /></span>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{p.title}</h2>
              {p.key === 'ticket' && (
                <button onClick={toggleTicketsOpen} aria-pressed={ticketsOpenOnly}
                  title={ticketsOpenOnly ? 'Show all tickets' : 'Show New and In progress only'} style={{
                    height: 26, padding: '0 9px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)',
                    fontSize: 12, fontWeight: 700, flexShrink: 0,
                    border: `1px solid ${ticketsOpenOnly ? 'var(--accent)' : 'var(--border)'}`,
                    background: ticketsOpenOnly ? 'var(--accent-soft)' : 'var(--surface)',
                    color: ticketsOpenOnly ? 'var(--accent-strong)' : 'var(--text2)',
                  }}>Open · {matching.filter(i => OPEN_STATES.includes(stateOf(i))).length}</button>
              )}
              {p.key === 'ticket' && (
                <button onClick={() => setTicketsFlaggedOnly(v => !v)} aria-pressed={ticketsFlaggedOnly}
                  aria-label={`Flagged tickets: ${matching.filter(i => i.flag).length}`}
                  title={ticketsFlaggedOnly ? 'Show all tickets' : 'Show your flagged tickets only (F flags the selected one)'} style={{
                    height: 26, padding: '0 9px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)',
                    fontSize: 12, fontWeight: 700, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5,
                    border: `1px solid ${ticketsFlaggedOnly ? 'var(--amber)' : 'var(--border)'}`,
                    background: ticketsFlaggedOnly ? 'var(--amber-soft)' : 'var(--surface)',
                    color: ticketsFlaggedOnly ? 'var(--amber)' : 'var(--text2)',
                  }}><Flag size={12} fill={ticketsFlaggedOnly ? 'currentColor' : 'none'} /> {matching.filter(i => i.flag).length}</button>
              )}
              <span style={{ flex: 1 }} />
              {p.key === 'ticket' && (
                <select value={ticketSort} onChange={e => pickTicketSort(e.target.value)} aria-label="Sort tickets" title="Sort tickets"
                  onMouseDown={e => e.stopPropagation()} draggable={false} style={{
                    height: 26, padding: '0 6px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
                    color: 'var(--text2)', fontSize: 12, fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer', maxWidth: 120,
                  }}>
                  {TICKET_SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              )}
              <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{matching.length}</span>
              <button onClick={() => toggleUnread(p.key)} aria-pressed={onlyUnread}
                title={onlyUnread ? `Show all ${p.title.toLowerCase()}` : `Show unread ${p.title.toLowerCase()} only`} style={{
                  height: 28, padding: '0 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)',
                  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700,
                  border: `1px solid ${onlyUnread ? 'var(--accent)' : 'var(--border)'}`,
                  background: onlyUnread ? 'var(--accent)' : 'var(--surface)', color: onlyUnread ? 'var(--on-accent)' : 'var(--text2)',
                }}>
                Unread
                {unread > 0 && (
                  <span style={{
                    minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, fontSize: 11, fontWeight: 800,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: onlyUnread ? 'var(--on-accent)' : 'var(--accent)', color: onlyUnread ? 'var(--accent-strong)' : 'var(--on-accent)',
                  }}>{unread}</span>
                )}
              </button>
            </header>
            <div style={{ flexShrink: 0, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', borderRadius: 8,
                background: 'var(--bg)', color: 'var(--muted)',
              }}>
                <Search size={14} style={{ flexShrink: 0 }} aria-hidden="true" />
                <input value={panelSearch[p.key] || ''} onChange={e => { const v = e.target.value; setPanelSearch(m => ({ ...m, [p.key]: v })); }}
                  placeholder={`Search ${p.title.toLowerCase()}`} aria-label={`Search ${p.title.toLowerCase()}`}
                  style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
                <ClearSearch value={panelSearch[p.key]} onClear={() => setPanelSearch(m => ({ ...m, [p.key]: '' }))} size={24} style={{ marginRight: -6 }} />
              </div>
            </div>
            <div data-rowlist style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 6px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {left.status === 'loading' ? (
                <div role="status" style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
              ) : rows.length === 0 ? (
                <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
                  {onlyUnread && matching.length ? 'All caught up — nothing unread.'
                    : flaggedOnly && matching.length ? 'No flagged tickets. Select a ticket and press F to flag it.'
                    : wantStates && matching.length ? 'No tickets in these states.'
                      : panelsQ || ownQ ? 'No matches.' : p.empty}
                </div>
              ) : (sortKey === 'last' ? withDayLines : (list, render) => list.map(render))(rows, item => (
                <ConversationRow key={item.id} item={item} active={item.id === drawerId} terms={[panelsQ, ownQ]}
                  online={!!item.username && live.online.has(item.username)}
                  dbl onPick={() => setDrawerId(item.id)} onToggleFlag={toggleFlag} meUser={user.username} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );

  // what is on screen now, and how a clicked notification opens its conversation
  openNowRef.current = (id) => (section === 'home' && homeView === 'panels' ? drawerId === id
    : !narrow && selectedId === id && (section === 'home' || SECTION_KINDS[section]?.includes(left.items.find(i => i.id === id)?.kind)));
  openFromNotice.current = (id) => {
    if (section !== 'home') setSection('home');
    if (homeView === 'panels') setDrawerId(id); else setSelectedId(id);
  };
  const notifyBanner = notify === 'ask' && (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px', fontSize: 13, flexWrap: 'wrap',
      background: 'var(--accent-soft)', color: 'var(--text)', borderBottom: '1px solid var(--border)',
    }}>
      <Bell size={16} style={{ color: 'var(--accent-strong)' }} />
      <span style={{ flex: 1, minWidth: 200 }}>Get a desktop notification when a message arrives while Sila is open.</span>
      <button onClick={() => enableNotify()} style={{
        height: 30, padding: '0 12px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
        fontWeight: 700, fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)',
      }}>Turn on</button>
      <button onClick={disableNotify} style={{
        height: 30, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
        color: 'var(--text2)', fontWeight: 700, fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font)',
      }}>Not now</button>
    </div>
  );

  const drawerItem = drawerId != null ? (left.items.find(i => i.id === drawerId) || (draftChat?.id === drawerId ? draftChat : null)) : null;
  const drawer = drawerItem && (
    <>
      {/* a click on the shade over a row opens that conversation in the drawer
          (one click, as the drawer is already open); anywhere else closes it */}
      <div aria-hidden="true" onMouseDown={(e) => {
        const row = document.elementsFromPoint(e.clientX, e.clientY).map(el => el.closest('[data-rowid]')).find(Boolean);
        const id = row && Object.values(panelRowsRef.current).flat().find(x => String(x) === row.dataset.rowid);
        if (id == null) { setDrawerId(null); return; }
        e.preventDefault();
        setDrawerId(id);
        row.focus({ preventScroll: true });
      }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.25)', zIndex: 1000 }} />
      <aside role="dialog" aria-label={drawerItem.title} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: drawerItem.kind === 'ticket' ? 'min(1240px, 94vw)' : 'min(980px, 90vw)',
        zIndex: 1001, background: 'var(--soft)', boxShadow: 'var(--shadow-lg)', display: 'flex',
      }}>
        <ChatPane key={drawerItem.id} item={drawerItem} onRead={markRead} onActivity={onActivity} isOnline={isOnline}
          onTicketChange={onTicketChange} onLeave={onLeaveGroup} onFlagChange={onFlagChange} onChatStarted={onChatStarted}
          homeItems={left.items} onForwarded={onTicketChange} onClose={() => setDrawerId(null)} />
      </aside>
    </>
  );
  const pane = !narrow && (['chat', 'group', 'ticket'].includes(selected?.kind) ? (
    <ChatPane key={selected.id} item={selected} onRead={markRead} onActivity={onActivity} isOnline={isOnline}
      onTicketChange={onTicketChange} onLeave={onLeaveGroup} onFlagChange={onFlagChange} onChatStarted={onChatStarted}
      homeItems={left.items} onForwarded={onTicketChange} />
  ) : selected ? (
    <main style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--soft)' }}>
      <header style={{
        minHeight: 72, padding: '12px 24px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        {selected.kind === 'chat'
          ? <Avatar name={selected.title} size={44} photoUrl={selected.photoUrl} username={selected.username}
              online={!!selected.username && live.online.has(selected.username)} />
          : <KindBadge kind={selected.kind} size={44} broadcast={selected.broadcast} />}
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
      {/* the profile card any clickable avatar opens; the pop-up when a reminder fires */}
      <ProfileCard meUsername={user.username} onChat={startChat} />
      <ReminderToast onOpen={openLink} />
      {newTicket && <NewTicketDialog onClose={() => setNewTicket(false)} onCreated={onTicketCreated} />}
      {newChat && <NewChatDialog meUsername={user.username} onPick={startChat} onClose={() => setNewChat(false)} />}
      {newGroup && <NewGroupDialog onClose={() => setNewGroup(false)} onCreated={onGroupCreated} />}
      <div style={{ order: 1, flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ConnectionBar live={live} />
        {notifyBanner}
        {section === 'myday' ? (
          <MyDay onOpen={openLink} />
        ) : section === 'mail' ? (
          <MailPage />
        ) : section === 'settings' && settingsAllowed ? (
          <SystemSettings />
        ) : section === 'reports' && reportsAllowed ? (
          <Reports />
        ) : section === 'channels' && channelsView !== 'conv' ? (
          <ChannelsBoard view={channelsView} viewSwitch={channelsSwitch} isOnline={isOnline} me={user.username}
            onNewTicket={() => setNewTicket(true)} openTicket={boardTicket} />
        ) : section === 'home' && homeView === 'panels' ? (
          <>
            {homeBar}
            {panels}
            {drawer}
          </>
        ) : (
          <>
            {section === 'channels' && (
              <div style={{
                flexShrink: 0, padding: '12px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
                display: 'flex', alignItems: 'flex-end', gap: 12,
              }}>{channelsSwitch}</div>
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              {list}
              {pane}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
