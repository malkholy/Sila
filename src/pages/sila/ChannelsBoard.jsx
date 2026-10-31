import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Flag, Hash, Plus, RefreshCw, X } from 'lucide-react';
import { loadChannelMembers, loadChannels, loadTickets } from '../../shared/chat.js';
import { formatWhen, preview } from '../../shared/leftSide.js';
import { onLive } from '../../shared/live.js';
import Avatar from './Avatar.jsx';
import { noWordSelect } from '../../shared/textSelection.js';
import { moveRowFocus } from '../../shared/rowNav.js';
import { useDrawerWidth, drawerWidth, DrawerResizeHandle } from './DrawerResize.jsx';
import ChatPane from './ChatPane.jsx';
import ClearSearch from './ClearSearch.jsx';
import { FlagMark } from './TicketFlag.jsx';
import { AssigneeTag } from './TicketAssign.jsx';
import SlaBadge from './SlaBadge.jsx';
import { slaLate } from '../../shared/ticketSla.js';
import { setTicketFlag } from '../../shared/ticketFlag.js';

// The Channels "Order Board" (design/mockups/Channels.dc.html, grouped views):
// the caller's tickets ('Ticket list' of CHA.APISilaWebTicketOperation) grouped
// By Status / By Channel / Created by, with a top filter panel (status
// checklist, created-date range, search), sortable groups, a ticket drawer
// (the ticket's own ChatPane) and a person drawer (all of a creator's tickets,
// ignoring the panel filters). Grouping is presentation only.

// CHA.TicketState: 0 New, 1 In Progress, 2 Forwarded, 3 Approve Waiting, 5 Hold, 10 End, 50 Close
export const TICKET_STATES = [
  { id: 0, label: 'New', tone: ['var(--blue)', 'var(--blue-soft)'] },
  { id: 1, label: 'In progress', tone: ['var(--green)', 'var(--green-soft)'] },
  { id: 2, label: 'Forwarded', tone: ['var(--orange)', 'var(--orange-soft)'] },
  { id: 3, label: 'Approve waiting', tone: ['var(--amber)', 'var(--amber-soft)'] },
  { id: 5, label: 'Hold', tone: ['var(--amber)', 'var(--amber-soft)'] },
  { id: 10, label: 'Ended', tone: ['var(--text2)', 'var(--soft)'] },
  { id: 50, label: 'Closed', tone: ['var(--muted)', 'var(--soft)'] },
];
const STATE = Object.fromEntries(TICKET_STATES.map(s => [s.id, s]));
const stateOf = (id) => STATE[id] || { id, label: `State ${id}`, tone: ['var(--text2)', 'var(--soft)'] };
const OPEN_ONLY = [0, 1, 2, 3, 5];   // every state before Ended / Closed
const DEFAULT_PICK = [0, 1, 2, 3, 5, 10];
const CLOSED = 50;

// Created-date presets; 'week' = the last 7 days, today included
const PERIODS = [['all', 'All'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last week']];
function periodRange(key, now = new Date()) {
  const day = (offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  if (key === 'today') return [day(0), day(1)];
  if (key === 'yesterday') return [day(-1), day(0)];
  if (key === 'week') return [day(-6), day(1)];
  return [null, null];
}

const TITLES = { status: 'Tickets by status', channel: 'Tickets by channel', creator: 'Tickets by creator', assignee: 'Tickets by assignee' };
// who owns the tickets shown: everyone's, mine, nobody's
const OWNERS = [['all', 'All'], ['me', 'Mine'], ['none', 'Unassigned']];

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: not remembered */ } },
};

const label11 = { fontSize: 11, fontWeight: 700, color: 'var(--text2)' };
const field = {
  height: 36, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border2)', background: 'var(--surface)',
  color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font)',
};
const plainBtn = {
  height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
};
const th = {
  padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 800, letterSpacing: '.04em',
  textTransform: 'uppercase', color: 'var(--text2)', whiteSpace: 'nowrap',
};
const td = { padding: '8px 12px', whiteSpace: 'nowrap' };

function Pill({ state, children }) {
  const s = stateOf(state);
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, background: s.tone[1], color: s.tone[0], fontSize: 11, fontWeight: 700,
      whiteSpace: 'nowrap',
    }}>{children ?? s.label}</span>
  );
}

// Segmented buttons (view switch, sort): orange when active.
export function Segmented({ items, value, onPick, label, height = 36 }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'inline-flex' }}>
      {items.map(([key, text, Icon, extra], i) => {
        const on = key === value;
        return (
          <button key={key} onClick={() => onPick(key)} aria-pressed={on} style={{
            height, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            fontSize: 12, fontWeight: 700, fontFamily: 'var(--font)', position: 'relative', zIndex: on ? 1 : 0,
            border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, marginLeft: i ? -1 : 0,
            background: on ? 'var(--accent)' : 'var(--surface)', color: on ? 'var(--on-accent)' : 'var(--text)',
            borderRadius: i === 0 ? '8px 0 0 8px' : i === items.length - 1 ? '0 8px 8px 0' : 0,
          }}>
            {Icon && <Icon size={14} />}{text}{extra}
          </button>
        );
      })}
    </div>
  );
}

// A dropdown checklist (Status, Channel). options: [{ value, label, count, dot? }];
// picked: the checked values, or null = every option (no filter).
// onClear: shows an X beside the button while a filter is set (picked != null).
function Checklist({ label, options, picked, onChange, allText, unit, searchable = false, minWidth = 170, onClear }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  const on = (v) => picked == null || picked.includes(v);
  const chosen = options.filter(o => on(o.value));
  const text = picked == null || chosen.length === options.length ? allText
    : chosen.length === 0 ? 'None'
      : chosen.length <= 2 ? chosen.map(o => o.label).join(', ') : `${chosen.length} ${unit}`;
  const toggle = (v) => {
    const now = picked == null ? options.map(o => o.value) : picked;
    onChange(now.includes(v) ? now.filter(x => x !== v) : [...now, v]);
  };
  const needle = find.trim().toLowerCase();
  const shown = needle ? options.filter(o => o.label.toLowerCase().includes(needle)) : options;
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={label11}>{label}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="true" style={{
          ...field, minWidth, maxWidth: 260, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, cursor: 'pointer',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">{text}</span>
          <ChevronDown size={14} style={{ flexShrink: 0 }} />
        </button>
        {onClear && picked != null && (
          <button onClick={() => { onClear(); setOpen(false); }} aria-label={`Clear ${label.toLowerCase()} filter`}
            title={`Show ${allText.toLowerCase()}`} style={{
              ...field, width: 36, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text2)',
            }}><X size={16} /></button>
        )}
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: 62, left: 0, zIndex: 50, width: 260, padding: 8, borderRadius: 12,
          background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {searchable && (
            <input value={find} onChange={e => setFind(e.target.value)} placeholder={`Find ${label.toLowerCase()}`} autoFocus
              aria-label={`Find ${label.toLowerCase()}`} style={{ ...field, height: 34, marginBottom: 4 }} />
          )}
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {shown.map(o => (
              <label key={o.value} style={{
                display: 'flex', alignItems: 'center', gap: 10, minHeight: 36, padding: '0 8px', borderRadius: 8,
                cursor: 'pointer', fontSize: 13, color: 'var(--text)',
              }}>
                <input type="checkbox" checked={on(o.value)} onChange={() => toggle(o.value)}
                  style={{ width: 16, height: 16, accentColor: 'var(--accent)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {o.dot && <span style={{ width: 8, height: 8, borderRadius: 4, background: o.dot, flexShrink: 0 }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">{o.label}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{o.count}</span>
              </label>
            ))}
            {shown.length === 0 && <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>No match.</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, padding: '6px 4px 2px', borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <button onClick={() => onChange(null)} style={{ ...plainBtn, flex: 1, height: 32 }}>All</button>
            <button onClick={() => onChange([])} style={{ ...plainBtn, flex: 1, height: 32 }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Column sort: key -> [value of a row, first click descending?]. Text sorts
// A-Z first; numbers and dates newest / biggest first.
const COL_SORT = {
  id: [(t) => t.id, true],
  subject: [(t) => t.subject || '', false],
  message: [(t) => preview(t.lastMessage) || '', false],
  channel: [(t) => t.channel || '', false],
  status: [(t) => t.state, false],
  creator: [(t) => t.createdByName || '', false],
  assignee: [(t) => t.assignee?.name || '', false],
  last: [(t) => t.last?.getTime() || 0, true],
  unread: [(t) => t.unread || 0, true],
};
function sortRows(rows, sort) {
  const col = sort && COL_SORT[sort.key];
  if (!col) return rows;
  const [val] = col;
  const dir = sort.desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true }) : x - y;
    return c * dir || (b.last?.getTime() || 0) - (a.last?.getTime() || 0);
  });
}
// Click a header: sort by it; again: reverse; a third time: back to the
// default order (last update, newest first).
function nextColSort(cur, key) {
  if (cur?.key !== key) return { key, desc: COL_SORT[key][1] };
  if (cur.desc === COL_SORT[key][1]) return { key, desc: !cur.desc };
  return null;
}

function SortTh({ label, k, sort, onSort, align = 'left' }) {
  const on = sort?.key === k;
  const Arrow = on && sort.desc ? ArrowDown : ArrowUp;
  return (
    <th scope="col" aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'} style={{ ...th, textAlign: align, padding: 0 }}>
      <button type="button" onClick={() => onSort(k)} title={`Sort by ${label.toLowerCase()}`} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 4, justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', letterSpacing: 'inherit',
        textTransform: 'inherit', color: on ? 'var(--accent-strong)' : 'inherit', whiteSpace: 'nowrap',
      }}>
        {label}
        <Arrow size={12} strokeWidth={2.6} aria-hidden="true" style={{ opacity: on ? 1 : 0, flexShrink: 0 }} />
      </button>
    </th>
  );
}

// A click selects a row, Up / Down move the selection (also into the next
// group), Enter or a double-click opens the ticket, F flags / unflags it.
// sort / onSort: the column sort shared by every group (else kept here).
// openId: the ticket open in the drawer now -- while one is, the drawer follows
// the selected row (Up / Down, or a click on another row) instead of staying put.
function TicketTable({ rows, show, onOpen, onPerson, onChannel, onToggleFlag, me, sort: sortProp, onSort, openId = null }) {
  const [sel, setSel] = useState(null);
  const [ownSort, setOwnSort] = useState(null);
  const sort = onSort ? sortProp : ownSort;
  const pickSort = (k) => (onSort ? onSort(k) : setOwnSort(s => nextColSort(s, k)));
  const shown = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const bg = (t) => (sel === t.id ? 'var(--accent-soft)' : '');
  const h = { sort, onSort: pickSort };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--bg)' }}>
            <SortTh label="Ticket" k="id" {...h} />
            <SortTh label={show.channel ? 'Channel · Subject' : 'Subject'} k="subject" {...h} />
            <SortTh label="Last message" k="message" {...h} />
            {show.status && <SortTh label="Status" k="status" {...h} />}
            {show.creator && <SortTh label="Created by" k="creator" {...h} />}
            {show.assignee && <SortTh label="Assigned to" k="assignee" {...h} />}
            <SortTh label="Last update" k="last" {...h} />
            {show.unread && <SortTh label="Unread" k="unread" align="right" {...h} />}
          </tr>
        </thead>
        <tbody>
          {shown.map(t => (
            <tr key={t.id} data-row tabIndex={0} aria-selected={sel === t.id}
              onMouseDown={noWordSelect} onDoubleClick={() => onOpen(t)}
              onKeyDown={e => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter') { e.preventDefault(); onOpen(t); }
                else if ((e.key === 'f' || e.key === 'F') && onToggleFlag && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); onToggleFlag(t); }
                else moveRowFocus(e);
              }}
              onFocus={() => { setSel(t.id); if (openId != null && openId !== t.id) onOpen(t); }} onBlur={() => setSel(null)}
              style={{ borderTop: '1px solid var(--border)', outline: 'none', background: bg(t),
                boxShadow: sel === t.id ? 'inset 3px 0 0 var(--accent)' : 'none' }}
              onMouseEnter={e => { if (sel !== t.id) e.currentTarget.style.background = 'var(--orange-soft)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = bg(t); }}>
              <td style={td}>
                <button onClick={() => onOpen(t)} style={{
                  padding: 0, border: 'none', background: 'none', color: 'var(--accent-strong)', fontWeight: 800,
                  textDecoration: 'underline', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer',
                }}>#{t.id}</button>
              </td>
              <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', fontWeight: 600, minWidth: 220, color: 'var(--text)' }}>
                {/* the channel sits on a quiet line above the subject (no column of its own) */}
                {show.channel && (
                  <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 1 }}>
                    {onChannel ? (
                      <button onClick={() => onChannel(t.channelId)} style={{
                        padding: 0, border: 'none', background: 'none', color: 'inherit', font: 'inherit', cursor: 'pointer',
                        textDecoration: 'underline', textDecorationColor: 'var(--border2)',
                      }}># <span dir="auto">{t.channel}</span></button>
                    ) : <># <span dir="auto">{t.channel}</span></>}
                  </span>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FlagMark flag={t.flag} /><span dir="auto">{t.subject}</span><SlaBadge sla={t.sla} state={t.state} compact />
                </span>
              </td>
              <td title={preview(t.lastMessage)} style={{
                ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text2)',
                textAlign: 'left',
              }}><span dir="auto">{preview(t.lastMessage) || '-'}</span></td>
              {show.status && <td style={td}><Pill state={t.state}>{t.stateLabel || undefined}</Pill></td>}
              {show.creator && (
                <td style={td}>
                  <button onClick={() => onPerson(t.createdBy)} style={{
                    padding: 0, border: 'none', background: 'none', color: 'var(--text)', fontSize: 13, cursor: 'pointer',
                    textDecoration: 'underline', textDecorationColor: 'var(--border2)', fontFamily: 'var(--font)',
                  }} dir="auto">{t.createdByName}</button>
                </td>
              )}
              {show.assignee && (
                <td style={td}>{t.assignee ? <AssigneeTag assignee={t.assignee} me={me} /> : <span style={{ fontSize: 12, color: 'var(--muted)' }}>-</span>}</td>
              )}
              <td style={{ ...td, color: 'var(--text2)' }}>{formatWhen(t.last)}</td>
              {show.unread && (
                <td style={{
                  ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700,
                  color: t.unread ? 'var(--accent-strong)' : 'var(--muted)',
                }}>{t.unread}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Figure({ label, children, color }) {
  return (
    <div>
      <dt style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 800, fontFamily: 'var(--mono)', color: color || 'var(--text)' }}>{children}</dd>
    </div>
  );
}

// A drawer of tickets (all loaded tickets, the panel filters ignored): head,
// optional extra block, summary cards, status chips and the ticket table.
function TicketsDrawer({ label, head, extra, tickets, show, blocked, onOpen, onClose }) {
  const [chip, setChip] = useState('all');
  useEffect(() => {
    // Esc closes it, unless a ticket drawer is open on top of it
    const esc = (e) => { if (e.key === 'Escape' && !blocked) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, blocked]);
  const states = [...new Set(tickets.map(t => t.state))].sort((a, b) => a - b);
  const rows = chip === 'all' ? tickets : tickets.filter(t => t.state === chip);
  const cards = [
    ['Tickets', tickets.length], ['Open', tickets.filter(t => t.state < CLOSED).length],
    ['Unread', tickets.reduce((n, t) => n + t.unread, 0)], ['Last update', formatWhen(tickets[0]?.last) || '-'],
  ];
  const chipBtn = (key, text, on) => (
    <button key={key} onClick={() => setChip(key)} aria-pressed={on} style={{
      height: 34, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontWeight: 700, fontSize: 12,
      fontFamily: 'var(--font)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
      background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent-strong)' : 'var(--text2)',
    }}>{text}</button>
  );
  return (
    <>
      <div aria-hidden="true" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', zIndex: 990 }} />
      <aside role="dialog" aria-label={label} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(720px, 100%)', zIndex: 991, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font)',
      }}>
        <header style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          {head}
          <button onClick={onClose} aria-label="Close" style={{
            width: 44, height: 44, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          }}><X size={18} /></button>
        </header>
        <div data-rowlist style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {extra}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
            {cards.map(([k, v]) => (
              <div key={k} style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{k}</div>
                <div style={{ fontSize: 22, fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {chipBtn('all', `All · ${tickets.length}`, chip === 'all')}
            {states.map(s => chipBtn(s, `${stateOf(s).label} · ${tickets.filter(t => t.state === s).length}`, chip === s))}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <TicketTable rows={rows} show={show} onOpen={onOpen} onPerson={() => {}} />
            {rows.length === 0 && <div style={{ padding: 18, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No tickets in this status.</div>}
          </div>
        </div>
      </aside>
    </>
  );
}

// Every ticket one person created.
function PersonDrawer({ person, tickets, blocked, onOpen, onClose }) {
  return (
    <TicketsDrawer label={`Tickets created by ${person.name}`} tickets={tickets} show={{ channel: true, status: true }}
      blocked={blocked} onOpen={onOpen} onClose={onClose} head={(
        <>
          <Avatar name={person.name} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Created by · all their tickets you can see</div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text)' }} dir="auto">{person.name}</h2>
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>@{person.username}</div>
          </div>
        </>
      )} />
  );
}

// Every ticket of one channel, with the channel's purpose and its admins /
// team leaders (they join each new ticket).
function ChannelDrawer({ channel, tickets, blocked, onOpen, onClose }) {
  const [info, setInfo] = useState({ purpose: '', managers: null });
  useEffect(() => {
    let live = true;
    loadChannels().then(list => {
      const c = list.find(x => x.id === channel.id);
      if (live && c) setInfo(i => ({ ...i, purpose: c.purpose, private: c.private }));
    }).catch(() => {});
    loadChannelMembers(channel.id).then(list => {
      if (live) setInfo(i => ({ ...i, managers: list.filter(m => m.admin || m.leader) }));
    }).catch(() => { if (live) setInfo(i => ({ ...i, managers: [] })); });
    return () => { live = false; };
  }, [channel.id]);
  const extra = (info.purpose || info.managers?.length) ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {info.purpose && <div style={{ fontSize: 13, color: 'var(--text2)' }} dir="auto">{info.purpose}</div>}
      {info.managers?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginRight: 2 }}>Admins and team leaders</span>
          {info.managers.map(m => (
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
    </div>
  ) : null;
  return (
    <TicketsDrawer label={`Tickets in # ${channel.name}`} tickets={tickets} show={{ status: true, creator: true, assignee: true, unread: true }}
      blocked={blocked} onOpen={onOpen} onClose={onClose} extra={extra} head={(
        <>
          <span style={{
            width: 56, height: 56, borderRadius: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            background: 'var(--accent-soft)', border: '1.5px solid var(--accent-line)', color: 'var(--accent-strong)',
          }}><Hash size={26} strokeWidth={1.8} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Channel · all its tickets you can see{info.private ? ' · private' : ''}</div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text)' }} dir="auto"># {channel.name}</h2>
          </div>
        </>
      )} />
  );
}

// The ticket itself, in a drawer: its own ChatPane (messages, actions, details).
function TicketDrawer({ ticket, isOnline, onRead, onChange, onClose, onFlagChange }) {
  const item = useMemo(() => ({
    id: `ticket-${ticket.id}`, kind: 'ticket', title: ticket.subject, unread: ticket.unread,
    raw: { ...ticket.raw, TicketID: ticket.id, ChannelName: ticket.channel },
    // ChatPane reads these at open time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ticket.id]);
  const [width, setWidth] = useDrawerWidth('silaTicketDrawerWidth');   // dragged by the user, shared with Home's drawer
  const ref = useRef(null);
  return (
    <>
      <div aria-hidden="true" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.25)', zIndex: 1000 }} />
      <aside ref={ref} role="dialog" aria-label={`Ticket ${ticket.id}`} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: drawerWidth(width, 'min(1240px, 94vw)'), zIndex: 1001, background: 'var(--soft)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      }}>
        <DrawerResizeHandle asideRef={ref} onWidth={setWidth} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ChatPane item={item} isOnline={isOnline} onRead={() => onRead(ticket.id)} onTicketChange={onChange} onClose={onClose}
            onFlagChange={(_, flag) => onFlagChange(ticket.id, flag)} />
        </div>
      </aside>
    </>
  );
}

// The board's tickets for this session, kept between visits (Channels <-> other
// sections): reopening shows them at once, then asks only for changes.
const FULL_EVERY_MS = 10 * 60_000;
const boardCache = { open: null, closed: null, mark: 0, fullAt: 0 };
export function clearBoardCache() { Object.assign(boardCache, { open: null, closed: null, mark: 0, fullAt: 0 }); }

// onNewTicket: the + New ticket button (HomeShell owns the form); openTicket: a
// ticket just created there, opened in the drawer and loaded with the rest.
export default function ChannelsBoard({ view, viewSwitch, isOnline, onNewTicket, openTicket, me }) {
  const [open, setOpen] = useState(() => (boardCache.open
    ? { status: 'ready', rows: boardCache.open, error: '' } : { status: 'loading', rows: [], error: '' }));
  const [closed, setClosed] = useState(() => (boardCache.closed
    ? { status: 'ready', rows: boardCache.closed } : { status: 'idle', rows: [] }));
  const [picked, setPicked] = useState(() => store.get('silaBoardStatus', DEFAULT_PICK));
  const [channels, setChannels] = useState(() => store.get('silaBoardChannels', null));   // null = all channels
  const pickChannels = (list) => { setChannels(list); store.set('silaBoardChannels', list); };
  const [period, setPeriod] = useState(() => store.get('silaBoardPeriod', 'all'));
  const pickPeriod = (key) => { setPeriod(key); store.set('silaBoardPeriod', key); };
  const [q, setQ] = useState('');
  const [colSort, setColSort] = useState(() => store.get('silaTicketColSort', null));   // the ticket tables' column sort
  const [expanded, setExpanded] = useState(() => new Set());
  const [ticket, setTicket] = useState(null);
  const [personKey, setPersonKey] = useState(null);
  const [channelKey, setChannelKey] = useState(null);   // the channel drawer
  const seq = useRef(0);

  const pick = (list) => { setPicked(list); store.set('silaBoardStatus', list); };
  const pickColSort = (key) => setColSort(s => {
    const next = nextColSort(s, key);
    store.set('silaTicketColSort', next);
    return next;
  });

  // ---- loading: full loads, then deltas (RowVer watermark) between them
  const wantClosed = picked.includes(CLOSED);
  const openOnly = picked.length === OPEN_ONLY.length && OPEN_ONLY.every(x => picked.includes(x));
  const wantClosedRef = useRef(wantClosed);
  wantClosedRef.current = wantClosed;
  const deltaBusy = useRef(false);
  const again = useRef(false);
  const save = (patch) => { Object.assign(boardCache, patch); };

  const full = useCallback(() => {
    const n = ++seq.current;
    setOpen(s => ({ ...s, status: s.rows.length ? 'refreshing' : 'loading', error: '' }));
    loadTickets()
      .then(({ rows, mark }) => {
        if (n !== seq.current) return;
        save({ open: rows, mark, fullAt: Date.now() });
        setOpen({ status: 'ready', rows, error: '' });
      })
      .catch(err => { if (n === seq.current) setOpen(s => ({ ...s, status: 'error', error: err.message || 'Could not load your tickets.' })); });
    if (wantClosedRef.current) loadClosedRef.current();
  }, []);

  // a ticket just created (+ New ticket): open it and reload the board
  useEffect(() => {
    if (!openTicket) return;
    setTicket(openTicket);
    full();
  }, [openTicket, full]);

  // closed tickets: a second request, only once Closed is picked (newest 200);
  // after that, deltas keep them current with the open ones
  const loadClosed = useCallback(() => {
    setClosed(s => ({ ...s, status: 'loading' }));
    loadTickets({ closed: true })
      .then(({ rows }) => { save({ closed: rows }); setClosed({ status: 'ready', rows }); })
      .catch(() => setClosed({ status: 'error', rows: [] }));
  }, []);
  const loadClosedRef = useRef(loadClosed);
  useEffect(() => { if (wantClosed && closed.status === 'idle') loadClosed(); }, [wantClosed, closed.status, loadClosed]);

  // only what changed since the watermark: each row is filed again -- open,
  // closed (if those are loaded), or gone (left, archived)
  const delta = useCallback(() => {
    if (!boardCache.mark || Date.now() - boardCache.fullAt > FULL_EVERY_MS) { full(); return; }
    if (deltaBusy.current) { again.current = true; return; }
    deltaBusy.current = true;
    const n = seq.current;
    loadTickets({ since: boardCache.mark })
      .then(({ rows, mark, more }) => {
        if (n !== seq.current) return;   // a full load started meanwhile
        if (more || !mark) { full(); return; }
        save({ mark });
        if (!rows.length) return;
        const ids = new Set(rows.map(t => t.id));
        const keep = (list) => list.filter(t => !ids.has(t.id));
        const openRows = [...keep(boardCache.open || []), ...rows.filter(t => !t.left && t.state < CLOSED)];
        save({ open: openRows });
        setOpen(s => ({ ...s, rows: openRows }));
        if (boardCache.closed) {
          const closedRows = [...keep(boardCache.closed), ...rows.filter(t => !t.left && t.state === CLOSED)];
          save({ closed: closedRows });
          setClosed(s => ({ ...s, rows: closedRows }));
        }
      })
      .catch(() => { /* the next event or tick retries */ })
      .finally(() => {
        deltaBusy.current = false;
        if (again.current) { again.current = false; deltaRef.current(); }
      });
  }, [full]);
  const deltaRef = useRef(delta);
  deltaRef.current = delta;

  // first show: what this session already holds, then only the changes
  useEffect(() => {
    if (boardCache.open) delta(); else full();
  }, [full, delta]);

  const refresh = full;

  // live: a ticket event -> delta (coalesced); closing a ticket sends no event
  // (its SilaHistory rows are deleted), so also every 60 s and on return to the tab
  useEffect(() => {
    let timer = null;
    const off = onLive('changed', frame => {
      if (!(frame.items || []).some(c => c.kind === 'ticket')) return;
      clearTimeout(timer);
      timer = setTimeout(() => deltaRef.current(), 800);
    });
    const tick = () => { if (document.visibilityState === 'visible') deltaRef.current(); };
    const every = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      off(); clearTimeout(timer); clearInterval(every);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);

  const all = useMemo(() => {
    const byId = new Map(open.rows.map(t => [t.id, t]));
    if (wantClosed) closed.rows.forEach(t => { if (!byId.has(t.id)) byId.set(t.id, t); });
    return [...byId.values()].sort((a, b) => (b.last?.getTime() || 0) - (a.last?.getTime() || 0));
  }, [open.rows, closed.rows, wantClosed]);

  // the channels of my tickets (in the picked statuses), with ticket counts; a picked
  // channel with no tickets right now stays listed so it can be unticked
  const channelOptions = useMemo(() => {
    const map = new Map();
    all.filter(t => picked.includes(t.state)).forEach(t => {
      const o = map.get(t.channelId) || { value: t.channelId, label: t.channel || 'No channel', count: 0 };
      o.count += 1;
      map.set(t.channelId, o);
    });
    (channels || []).forEach(id => { if (!map.has(id)) map.set(id, { value: id, label: all.find(t => t.channelId === id)?.channel || `Channel ${id}`, count: 0 }); });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [all, picked, channels]);

  const [flaggedOnly, setFlaggedOnly] = useState(false);   // only the tickets the user flagged
  const [owner, setOwner] = useState('all');                // All / Mine / Unassigned
  const [lateOnly, setLateOnly] = useState(false);          // past their channel's target
  const counts = useMemo(() => all.reduce((m, t) => ({ ...m, [t.state]: (m[t.state] || 0) + 1 }), {}), [all]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    const [lo, hi] = periodRange(period);
    return all.filter(t => picked.includes(t.state) && (channels == null || channels.includes(t.channelId)) && (!flaggedOnly || t.flag)
      && (owner === 'all' || (owner === 'none' ? !t.assignee : t.assignee?.username === me))
      && (!lateOnly || slaLate(t.sla, t.state))
      && (!lo || (t.created && t.created >= lo && t.created < hi))
      && (!needle || String(t.id).includes(needle)
        || [t.subject, t.channel, t.createdByName, t.createdBy].some(s => s && s.toLowerCase().includes(needle))));
  }, [all, picked, channels, period, q, flaggedOnly, owner, me, lateOnly]);

  const groups = useMemo(() => {
    const keyOf = view === 'status' ? (t => t.state) : view === 'channel' ? (t => t.channelId)
      : view === 'assignee' ? (t => t.assignee?.username || '') : (t => t.createdBy);
    const map = new Map();
    filtered.forEach(t => {
      const k = keyOf(t);
      if (!map.has(k)) {
        map.set(k, {
          key: k, rows: [],
          label: view === 'status' ? (t.stateLabel || stateOf(t.state).label) : view === 'channel' ? `# ${t.channel || 'No channel'}`
            : view === 'assignee' ? (t.assignee?.name || 'Unassigned') : t.createdByName,
        });
      }
      map.get(k).rows.push(t);
    });
    const list = [...map.values()].map(g => ({
      ...g, count: g.rows.length, open: g.rows.filter(t => t.state < CLOSED).length,
      unread: g.rows.reduce((n, t) => n + t.unread, 0), last: g.rows[0]?.last || null,
      mix: [...new Set(g.rows.map(t => t.state))].sort((a, b) => a - b)
        .map(s => ({ state: s, count: g.rows.filter(t => t.state === s).length })),
    }));
    // groups: the most recently updated first
    return list.sort((a, b) => (b.last?.getTime() || 0) - (a.last?.getTime() || 0));
  }, [filtered, view]);

  const keyStr = (g) => `${view}:${g.key}`;
  const isOpen = (g) => expanded.has(keyStr(g));
  const toggle = (g) => setExpanded(s => { const n = new Set(s); if (n.has(keyStr(g))) n.delete(keyStr(g)); else n.add(keyStr(g)); return n; });

  // the user's own flag on a ticket (F on a row, or the drawer's header button)
  const flagRow = useCallback((id, flag) => {
    const put = (rows) => rows.map(t => (t.id === id ? { ...t, flag } : t));
    if (boardCache.open) boardCache.open = put(boardCache.open);
    if (boardCache.closed) boardCache.closed = put(boardCache.closed);
    setOpen(s => ({ ...s, rows: put(s.rows) }));
    setClosed(s => ({ ...s, rows: put(s.rows) }));
  }, []);
  const toggleFlag = useCallback((t) => {
    setTicketFlag(t.id, t.flag ? null : {}).then(flag => flagRow(t.id, flag)).catch(() => { /* unchanged */ });
  }, [flagRow]);

  const markRead = useCallback((id) => {
    const clear = (rows) => rows.map(t => (t.id === id ? { ...t, unread: 0 } : t));
    if (boardCache.open) boardCache.open = clear(boardCache.open);
    if (boardCache.closed) boardCache.closed = clear(boardCache.closed);
    setOpen(s => ({ ...s, rows: clear(s.rows) }));
    setClosed(s => ({ ...s, rows: clear(s.rows) }));
  }, []);

  const person = personKey ? (() => {
    const mine = all.filter(t => t.createdBy === personKey);
    return { username: personKey, name: mine[0]?.createdByName || personKey, tickets: mine };
  })() : null;
  const channel = channelKey != null ? (() => {
    const its = all.filter(t => t.channelId === channelKey);
    return { id: channelKey, name: its[0]?.channel || `Channel ${channelKey}`, tickets: its };
  })() : null;

  const show = { channel: view !== 'channel', status: view !== 'status', creator: view !== 'creator', assignee: view !== 'assignee', unread: true };
  const loading = open.status === 'loading';
  const busy = open.status === 'refreshing' || closed.status === 'loading';
  const unreadTotal = filtered.reduce((n, t) => n + t.unread, 0);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font)' }}>
      {/* top filter panel */}
      <div style={{
        flexShrink: 0, padding: '12px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 14px',
      }}>
        {viewSwitch}
        <Checklist label="Status" allText="All statuses" unit="statuses" picked={picked}
          onChange={list => pick(list ?? TICKET_STATES.map(x => x.id))}
          options={TICKET_STATES.map(x => ({ value: x.id, label: x.label, dot: x.tone[0], count: counts[x.id] ?? (x.id === CLOSED ? '' : 0) }))} />
        <Checklist label="Channel" allText="All channels" unit="channels" picked={channels} onChange={pickChannels}
          onClear={() => pickChannels(null)}
          searchable={channelOptions.length > 8} options={channelOptions} />
        <button onClick={() => pick(openOnly ? DEFAULT_PICK : OPEN_ONLY)} aria-pressed={openOnly}
          title={openOnly ? 'Show ended tickets too' : 'Only open tickets: New, In progress, Forwarded, Approve waiting, Hold'} style={{
            ...plainBtn, height: 36,
            border: `1px solid ${openOnly ? 'var(--accent)' : 'var(--border)'}`,
            background: openOnly ? 'var(--accent-soft)' : 'var(--bg)', color: openOnly ? 'var(--accent-strong)' : 'var(--text)',
          }}>Open only</button>
        <button onClick={() => setFlaggedOnly(v => !v)} aria-pressed={flaggedOnly}
          title={flaggedOnly ? 'Show all tickets' : 'Only the tickets you flagged (F flags the selected row)'} style={{
            ...plainBtn, height: 36, display: 'flex', alignItems: 'center', gap: 6,
            border: `1px solid ${flaggedOnly ? 'var(--amber)' : 'var(--border)'}`,
            background: flaggedOnly ? 'var(--amber-soft)' : 'var(--bg)', color: flaggedOnly ? 'var(--amber)' : 'var(--text)',
          }}><Flag size={13} fill={flaggedOnly ? 'currentColor' : 'none'} /> Flagged · {all.filter(t => t.flag).length}</button>
        <button onClick={() => setLateOnly(v => !v)} aria-pressed={lateOnly}
          title={lateOnly ? 'Show all tickets' : 'Only open tickets past their channel\'s first-reply or finish target'} style={{
            ...plainBtn, height: 36, alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 6,
            border: `1px solid ${lateOnly ? 'var(--red)' : 'var(--border)'}`,
            background: lateOnly ? 'var(--red-soft)' : 'var(--bg)', color: lateOnly ? 'var(--red)' : 'var(--text)',
          }}>Late · {all.filter(t => slaLate(t.sla, t.state)).length}</button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={label11}>Assigned</span>
          <Segmented label="Assigned" items={OWNERS} value={owner} onPick={setOwner} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={label11}>Created</span>
          <Segmented label="Created" items={PERIODS} value={period} onPick={pickPeriod} />
        </div>
        <div style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label htmlFor="board-q" style={label11}>Search</label>
          <span style={{ position: 'relative', display: 'flex' }}>
            <input id="board-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Ticket #, subject, channel or person"
              style={{ ...field, flex: 1, fontSize: 13, paddingRight: 34 }} />
            <ClearSearch value={q} onClear={() => setQ('')} style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }} />
          </span>
        </div>
      </div>

      {/* grouped view */}
      <div data-rowlist style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 20px 28px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--text)' }}>{TITLES[view]}</h1>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
            {groups.length} groups · {filtered.length} tickets · {unreadTotal} unread
          </span>
          <span style={{ flex: 1 }} />
          {onNewTicket && (
            <button onClick={onNewTicket} style={{
              ...plainBtn, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'var(--accent)',
              color: 'var(--on-accent)',
            }}><Plus size={15} strokeWidth={2.4} /> New ticket</button>
          )}
          <button onClick={() => setExpanded(new Set(groups.map(keyStr)))} style={plainBtn}>Expand all</button>
          <button onClick={() => setExpanded(new Set())} style={plainBtn}>Collapse all</button>
          <button onClick={refresh} disabled={busy || loading} aria-label="Refresh tickets" title="Refresh" style={{
            ...plainBtn, width: 34, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><RefreshCw size={14} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
        </div>

        {open.status === 'error' && (
          <div role="alert" style={{
            padding: '10px 12px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ flex: 1 }}>{open.error}</span>
            <button onClick={full} style={{ border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 800, cursor: 'pointer', fontSize: 13 }}>Try again</button>
          </div>
        )}
        {wantClosed && closed.status === 'error' && (
          <div role="status" style={{ fontSize: 12, color: 'var(--amber)', fontWeight: 700 }}>
            Closed tickets could not be loaded. <button onClick={loadClosed} style={{ border: 'none', background: 'none', color: 'var(--amber)', fontWeight: 800, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        )}

        {loading ? (
          <div role="status" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>Loading your tickets…</div>
        ) : groups.length === 0 && open.status !== 'error' ? (
          <div style={{
            padding: 28, borderRadius: 12, border: '1px dashed var(--border2)', color: 'var(--muted)', textAlign: 'center',
            background: 'var(--surface)',
          }}>{all.length ? 'No tickets match the filters.' : 'You are not a member of any open ticket.'}</div>
        ) : groups.map(g => {
          const exp = isOpen(g);
          return (
            <section key={keyStr(g)} style={{
              flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden',
            }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 14px', padding: '10px 14px' }}>
                <button onClick={() => toggle(g)} aria-expanded={exp} aria-label={`${exp ? 'Collapse' : 'Expand'} ${g.label}`} style={{
                  width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
                }}>{exp ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
                {view === 'status' && <span style={{ width: 12, height: 12, borderRadius: 6, background: stateOf(g.key).tone[0], flexShrink: 0 }} />}
                {view === 'channel' && (
                  <span style={{
                    width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
                    color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}><Hash size={16} /></span>
                )}
                {view === 'creator' && <Avatar name={g.label} size={40} online={isOnline(g.key)} />}
                {view === 'assignee' && (g.key ? <Avatar name={g.label} size={40} online={isOnline(g.key)} /> : (
                  <span style={{
                    width: 40, height: 40, borderRadius: 20, background: 'var(--soft)', border: '1px dashed var(--border2)',
                    color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 800,
                  }}>?</span>
                ))}
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  {view === 'creator' || view === 'channel' ? (
                    <button onClick={() => (view === 'creator' ? setPersonKey(g.key) : setChannelKey(g.key))} style={{
                      padding: 0, border: 'none', background: 'none', textAlign: 'left', fontSize: 15, fontWeight: 800,
                      color: 'var(--text)', textDecoration: 'underline', textDecorationColor: 'var(--border2)', cursor: 'pointer',
                      fontFamily: 'var(--font)',
                    }} dir="auto">{g.label}</button>
                  ) : (
                    <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }} dir="auto">{g.label}</span>
                  )}
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {view === 'creator' ? `@${g.key}` : view === 'assignee' ? (g.key ? `@${g.key}` : 'Nobody has these yet') : view === 'channel' ? 'Channel' : 'Status'}
                  </span>
                </div>
                {view !== 'status' && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {g.mix.map(x => <Pill key={x.state} state={x.state}>{stateOf(x.state).label} {x.count}</Pill>)}
                  </div>
                )}
                <span style={{ flex: 1 }} />
                <dl style={{ margin: 0, display: 'flex', gap: 18, textAlign: 'right' }}>
                  <Figure label="Tickets">{g.count}</Figure>
                  <Figure label="Open">{g.open}</Figure>
                  <Figure label="Unread" color={g.unread ? 'var(--accent-strong)' : 'var(--muted)'}>{g.unread}</Figure>
                  <div>
                    <dt style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>Last update</dt>
                    <dd style={{ margin: 0, fontWeight: 700, color: 'var(--text)' }}>{formatWhen(g.last)}</dd>
                  </div>
                </dl>
              </div>
              {exp && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  <TicketTable rows={g.rows} show={show} onOpen={setTicket} onPerson={setPersonKey} onChannel={setChannelKey} onToggleFlag={toggleFlag} me={me} openId={ticket?.id ?? null}
                    sort={colSort} onSort={pickColSort} />
                </div>
              )}
            </section>
          );
        })}
      </div>

      {channel && (
        <ChannelDrawer channel={channel} tickets={channel.tickets} blocked={!!ticket} onOpen={setTicket} onClose={() => setChannelKey(null)} />
      )}
      {person && (
        <PersonDrawer person={person} tickets={person.tickets} blocked={!!ticket} onOpen={setTicket} onClose={() => setPersonKey(null)} />
      )}
      {ticket && (
        <TicketDrawer ticket={ticket} isOnline={isOnline} onRead={markRead} onChange={refresh} onClose={() => setTicket(null)} onFlagChange={flagRow} />
      )}
    </div>
  );
}
