import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox, FileText, Send, Trash2, ShieldAlert, Archive, Folder, RefreshCw, Search, Paperclip, Flag, AlertCircle, ArrowLeft,
  MailOpen, Mail, CircleCheck, ChevronRight, ChevronDown,
} from 'lucide-react';
import {
  loadMyMailbox, loadMailFolders, loadMailMessages, loadMailMessage, searchMail, openMailAttachment, inlineImageUrl,
} from '../../shared/mail.js';
import Avatar from './Avatar.jsx';
import ClearSearch from './ClearSearch.jsx';
import Mark from './Mark.jsx';

// Mail: the signed-in user's own mailbox, read-only (the Sila Mail API finds it
// by the token's username). Folders | messages (newest first, "Load older"
// pages back) | the open message. Search covers subject, sender and recipients.
// Narrow screens show one pane at a time. The message HTML (sanitized when it
// was copied) is shown in a sandboxed frame: no scripts, links open a new tab.
const FOLDER_ICON = { Inbox, Drafts: FileText, SentItems: Send, DeletedItems: Trash2, JunkEmail: ShieldAlert, Outbox: Send, Archive };
const REFRESH_MS = 90_000;
// pictures inside a message: at most this many, each at most this size
const INLINE_MAX = 20;
const INLINE_BYTES = 3 * 1024 * 1024;
const OPEN_KEY = 'silaMailOpenFolders';   // the folders this browser shows opened

function useNarrow(px = 900) {
  const query = `(max-width: ${px - 1}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return undefined;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

// Well-known folders first (the API's order), each followed by its subfolders;
// ancestors: the folders above it (it shows only while they are all open).
function folderTree(folders) {
  const ids = new Set(folders.map(f => f.id));
  const kids = new Map();
  for (const f of folders) {
    const parent = ids.has(f.parentId) ? f.parentId : 0;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(f);
  }
  const out = [];
  const walk = (parent, depth, ancestors) => {
    for (const f of kids.get(parent) || []) {
      const deeper = depth < 6 && kids.has(f.id);
      out.push({ ...f, depth, ancestors, hasKids: deeper });
      if (deeper) walk(f.id, depth + 1, [...ancestors, f.id]);
    }
  };
  walk(0, 0, []);
  return out;
}

function shortWhen(d) {
  if (!d) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function ago(d) {
  if (!d) return 'not yet';
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return shortWhen(d);
}

function size(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The email as its own little page: no scripts (sandbox), nothing fetched but
// images and fonts, links in a new tab. Emails are designed on white.
function bodyDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:">
<base target="_blank">
<style>html{color-scheme:light}body{margin:16px;font:14px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937;background:#fff;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}

const pane = { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)' };
const iconBtn = {
  width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
};

function Notice({ icon: Icon = AlertCircle, title, text, action }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24,
      textAlign: 'center', color: 'var(--muted)' }}>
      <Icon size={34} strokeWidth={1.5} />
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {text && <div style={{ fontSize: 13, maxWidth: 360 }}>{text}</div>}
      {action}
    </div>
  );
}

function FolderList({ folders, current, opened, onToggle, onPick }) {
  return (
    <div role="tree" aria-label="Folders" style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
      {folders.filter(f => f.ancestors.every(a => opened.has(a))).map(f => {
        const Icon = FOLDER_ICON[f.type] || Folder;
        const active = f.id === current;
        const open = opened.has(f.id);
        const Chevron = open ? ChevronDown : ChevronRight;
        return (
          <div key={f.id} role="treeitem" aria-expanded={f.hasKids ? open : undefined} aria-selected={active} style={{
            display: 'flex', alignItems: 'center', minHeight: 38, paddingLeft: f.depth * 14, borderRadius: 9,
            background: active ? 'var(--accent-soft)' : 'transparent',
          }}>
            {/* the chevron opens / closes the subfolders; a folder without any keeps the space */}
            {f.hasKids ? (
              <button type="button" onClick={() => onToggle(f.id)} aria-label={`${open ? 'Close' : 'Open'} ${f.name}`} style={{
                flex: '0 0 24px', height: 28, padding: 0, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)',
              }}><Chevron size={15} /></button>
            ) : <span style={{ flex: '0 0 24px' }} />}
            <button type="button" onClick={() => onPick(f)} aria-current={active ? 'true' : undefined} style={{
              flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 10px 0 4px',
              border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)', fontSize: 13.5,
              color: active ? 'var(--accent-strong)' : 'var(--text)', fontWeight: active || f.unread > 0 ? 700 : 500,
            }}>
              <Icon size={17} strokeWidth={1.8} style={{ flexShrink: 0, color: active ? 'var(--accent-strong)' : 'var(--text2)' }} />
              <span dir="auto" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
              {f.unread > 0 && <span style={{ fontSize: 12, color: 'var(--accent-strong)' }}>{f.unread}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function MessageRow({ m, active, terms, folderName, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(m)} aria-current={active ? 'true' : undefined} style={{
      display: 'flex', gap: 10, width: '100%', padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--border)',
      borderLeft: `3px solid ${m.read ? 'transparent' : 'var(--accent)'}`, cursor: 'pointer', textAlign: 'left',
      fontFamily: 'var(--font)', color: 'var(--text)', background: active ? 'var(--accent-soft)' : 'transparent',
    }}>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: m.read ? 600 : 800, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {m.draft ? <span style={{ color: 'var(--red)' }}>[Draft] </span> : null}
            <Mark text={m.fromName || m.fromAddress || '(no sender)'} terms={terms} />
          </span>
          <span style={{ flexShrink: 0, fontSize: 11.5, color: m.read ? 'var(--muted)' : 'var(--accent-strong)', fontWeight: 600 }}>{shortWhen(m.at)}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {m.importance === 2 && <AlertCircle size={13} aria-label="High importance" style={{ flexShrink: 0, color: 'var(--red)' }} />}
          <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: m.read ? 500 : 700, whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis', color: m.read ? 'var(--text2)' : 'var(--text)' }}>
            <Mark text={m.subject || '(no subject)'} terms={terms} />
          </span>
          {m.attachments && <Paperclip size={13} aria-label="Has attachments" style={{ flexShrink: 0, color: 'var(--muted)' }} />}
          {m.flag === 1 && <Flag size={13} aria-label="Flagged" fill="currentColor" style={{ flexShrink: 0, color: 'var(--red)' }} />}
          {m.flag === 2 && <CircleCheck size={13} aria-label="Flag completed" style={{ flexShrink: 0, color: 'var(--green)' }} />}
        </span>
        <span dir="auto" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {folderName ? <b style={{ fontWeight: 600 }}>{folderName} · </b> : null}{m.preview}
        </span>
      </span>
    </button>
  );
}

function People({ label, list }) {
  if (!list.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, fontSize: 12.5, color: 'var(--text2)', minWidth: 0 }}>
      <span style={{ flexShrink: 0, width: 26, color: 'var(--muted)' }}>{label}</span>
      <span dir="auto" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {list.map((p, i) => (
          <span key={i} title={p.address}>{p.name || p.address}{i < list.length - 1 ? '; ' : ''}</span>
        ))}
      </span>
    </div>
  );
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// the cid: pictures this message's HTML actually uses
const usedInline = (msg) => (msg.html ? msg.files.filter(f => f.cid && new RegExp(`cid:${escapeRe(f.cid)}`, 'i').test(msg.html)) : []);

function AttachmentChip({ f }) {
  const [state, setState] = useState({ busy: false, error: '' });
  const open = async () => {
    if (state.busy) return;
    setState({ busy: true, error: '' });
    try { await openMailAttachment(f); setState({ busy: false, error: '' }); }
    catch (err) { setState({ busy: false, error: err.message || 'Could not open the attachment.' }); }
  };
  return (
    <button type="button" onClick={open} disabled={state.busy} title={state.error || `Open ${f.name}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 280, height: 32, padding: '0 10px', borderRadius: 8, cursor: state.busy ? 'progress' : 'pointer',
      border: `1px solid ${state.error ? 'var(--red)' : 'var(--border)'}`, background: state.error ? 'var(--red-soft)' : 'var(--soft)',
      fontFamily: 'var(--font)', fontSize: 12, color: state.error ? 'var(--red)' : 'var(--text2)',
    }}>
      {state.busy ? <RefreshCw size={13} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} /> : <Paperclip size={13} style={{ flexShrink: 0 }} />}
      <span dir="auto" style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 }}>{f.name}</span>
      <span style={{ flexShrink: 0, color: 'var(--muted)' }}>{state.busy ? 'Opening…' : size(f.size)}</span>
    </button>
  );
}

function Reader({ id, onBack }) {
  const [state, setState] = useState({ status: 'loading', msg: null, error: '' });
  const [html, setHtml] = useState(null);   // the message HTML, with its pictures filled in as they arrive
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', msg: null, error: '' });
    setHtml(null);
    loadMailMessage(id)
      .then(msg => {
        if (!alive) return;
        setState({ status: 'ready', msg, error: '' });
        setHtml(msg.html);
        // pictures inside the message (cid:) come from the attachments; one that fails stays empty
        const wanted = usedInline(msg).filter(f => f.size == null || f.size <= INLINE_BYTES).slice(0, INLINE_MAX);
        if (!wanted.length) return;
        Promise.all(wanted.map(f => inlineImageUrl(f.id).then(url => [f.cid, url]).catch(() => null))).then(pairs => {
          if (!alive) return;
          let filled = msg.html;
          for (const pair of pairs) if (pair) filled = filled.replace(new RegExp(`cid:${escapeRe(pair[0])}`, 'gi'), pair[1]);
          setHtml(filled);
        });
      })
      .catch(err => { if (alive) setState({ status: 'error', msg: null, error: err.message || 'Could not open the message.' }); });
    return () => { alive = false; };
  }, [id]);
  const { msg } = state;
  // the files to list: real attachments, and pictures marked inline that the message never shows
  const shownInline = useMemo(() => new Set(msg ? usedInline(msg).map(f => f.id) : []), [msg]);
  const files = msg ? msg.files.filter(f => !shownInline.has(f.id)) : [];
  return (
    <div style={{ ...pane, flex: 1 }}>
      {onBack && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
          <button type="button" onClick={onBack} style={{ ...iconBtn, width: 'auto', padding: '0 12px', gap: 6, fontFamily: 'var(--font)',
            fontSize: 13, fontWeight: 700, color: 'var(--text)' }}><ArrowLeft size={16} /> Messages</button>
        </div>
      )}
      {state.status === 'loading' && <Notice icon={MailOpen} title="Opening…" />}
      {state.status === 'error' && <Notice title="Could not open the message" text={state.error} />}
      {msg && (
        <>
          <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h2 dir="auto" style={{ margin: 0, fontSize: 19, lineHeight: 1.35, fontWeight: 800, color: 'var(--text)', overflowWrap: 'anywhere' }}>
              {msg.subject || '(no subject)'}
            </h2>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <Avatar name={msg.fromName || msg.fromAddress || '?'} size={40} />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span dir="auto" style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{msg.fromName || msg.fromAddress}</span>
                  {msg.fromName && <span style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{msg.fromAddress}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
                    {(msg.sent || msg.at)?.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <People label="To" list={msg.recipients.to} />
                <People label="Cc" list={msg.recipients.cc} />
                <People label="Bcc" list={msg.recipients.bcc} />
              </div>
            </div>
            {files.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {files.map(f => <AttachmentChip key={f.id} f={f} />)}
              </div>
            )}
          </div>
          {html ? (
            <iframe title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={bodyDoc(html)}
              style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#fff' }} />
          ) : (
            <div dir="auto" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              fontSize: 14, lineHeight: 1.55, color: 'var(--text)' }}>
              {msg.text || <span style={{ color: 'var(--muted)' }}>This message has no text.</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function MailPage() {
  const narrow = useNarrow();
  const [box, setBox] = useState({ status: 'loading', me: null, error: '', code: 0 });
  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState(null);
  const [list, setList] = useState({ status: 'idle', messages: [], next: null, more: false, error: '' });
  const [openId, setOpenId] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState({ status: 'idle', messages: [], error: '' });
  const [view, setView] = useState('list');   // narrow screens: folders | list | message
  const [refreshing, setRefreshing] = useState(false);
  const pagedRef = useRef(false);   // older pages loaded: the timer leaves the list alone
  const [opened, setOpened] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); }
  });
  const toggleFolder = (id) => setOpened(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch { /* not remembered */ }
    return next;
  });

  const tree = useMemo(() => folderTree(folders), [folders]);
  const folder = folders.find(f => f.id === folderId) || null;
  const folderName = useMemo(() => new Map(folders.map(f => [f.id, f.name])), [folders]);
  const searching = q.trim().length >= 2;
  const terms = searching ? [q.trim().toLowerCase()] : [];

  const loadFirstPage = useCallback((id, quiet = false) => {
    if (!quiet) setList({ status: 'loading', messages: [], next: null, more: false, error: '' });
    pagedRef.current = false;
    return loadMailMessages(id)
      .then(p => setList({ status: 'ready', messages: p.messages, next: p.next, more: false, error: '' }))
      .catch(err => setList(s => ({ ...s, status: s.messages.length ? 'ready' : 'error', error: err.message || 'Could not load the messages.' })));
  }, []);

  const start = useCallback(() => {
    setBox(b => ({ ...b, status: 'loading', error: '' }));
    Promise.all([loadMyMailbox(), loadMailFolders()])
      .then(([me, fs]) => {
        setBox({ status: 'ready', me, error: '', code: 0 });
        setFolders(fs);
        const inbox = fs.find(f => f.type === 'Inbox') || fs[0];
        if (inbox) { setFolderId(inbox.id); loadFirstPage(inbox.id); }
      })
      .catch(err => setBox({ status: 'error', me: null, error: err.message || 'Could not open your mailbox.', code: err.status || 0 }));
  }, [loadFirstPage]);
  useEffect(() => { start(); }, [start]);

  const refresh = useCallback(async (quiet = false) => {
    if (box.status !== 'ready') return;
    setRefreshing(true);
    try {
      const [me, fs] = await Promise.all([loadMyMailbox(), loadMailFolders()]);
      setBox(b => ({ ...b, me }));
      setFolders(fs);
      if (folderId != null && !(quiet && pagedRef.current)) await loadFirstPage(folderId, true);
    } catch { /* the figures stay; the next refresh tries again */ }
    finally { setRefreshing(false); }
  }, [box.status, folderId, loadFirstPage]);

  // new mail arrives through the sync; look again now and then while the page is open
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) refresh(true); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!searching) { setFound({ status: 'idle', messages: [], error: '' }); return undefined; }
    let alive = true;
    setFound(s => ({ ...s, status: 'loading', error: '' }));
    const t = setTimeout(() => {
      searchMail(q.trim())
        .then(messages => { if (alive) setFound({ status: 'ready', messages, error: '' }); })
        .catch(err => { if (alive) setFound({ status: 'error', messages: [], error: err.message || 'Search failed.' }); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [q, searching]);

  const pickFolder = (f) => {
    setQ('');
    setFolderId(f.id);
    setOpenId(null);
    loadFirstPage(f.id);
    setView('list');
  };
  const older = () => {
    if (!list.next || list.more) return;
    setList(s => ({ ...s, more: true }));
    loadMailMessages(folderId, list.next)
      .then(p => { pagedRef.current = true; setList(s => ({ ...s, messages: [...s.messages, ...p.messages], next: p.next, more: false })); })
      .catch(err => setList(s => ({ ...s, more: false, error: err.message || 'Could not load older messages.' })));
  };
  const open = (m) => { setOpenId(m.id); setView('message'); };

  if (box.status === 'loading') return <Notice icon={Mail} title="Opening your mailbox…" />;
  if (box.status === 'error') {
    return box.code === 404
      ? <Notice icon={Mail} title="No mailbox yet" text={box.error} />
      : <Notice title="Could not open your mailbox" text={box.error}
          action={<button type="button" onClick={start} style={{ ...iconBtn, width: 'auto', padding: '0 14px', gap: 6, fontFamily: 'var(--font)',
            fontWeight: 700, color: 'var(--text)', marginTop: 6 }}><RefreshCw size={15} /> Try again</button>} />;
  }

  const shown = searching ? found : list;
  const listPane = (
    <div style={{ ...pane, flex: narrow ? 1 : '0 0 380px', borderRight: narrow ? 'none' : '1px solid var(--border)' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {narrow && (
            <button type="button" onClick={() => setView('folders')} aria-label="Folders" style={iconBtn}><ArrowLeft size={16} /></button>
          )}
          <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {searching ? 'Search' : folder?.name || 'Mail'}
          </span>
          {!searching && folder && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{folder.total.toLocaleString()}</span>}
        </div>
        <label style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search size={15} aria-hidden="true" style={{ position: 'absolute', left: 10, color: 'var(--muted)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search subject, sender or recipient" aria-label="Search mail"
            style={{ width: '100%', height: 36, padding: '0 34px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)',
              color: 'var(--text)', fontFamily: 'var(--font)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          <ClearSearch value={q} onClear={() => setQ('')} style={{ position: 'absolute', right: 4 }} />
        </label>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {shown.status === 'loading' && !shown.messages.length && <Notice icon={searching ? Search : Inbox} title={searching ? 'Searching…' : 'Loading…'} />}
        {shown.status === 'error' && !shown.messages.length && <Notice title="Could not load" text={shown.error} />}
        {shown.status === 'ready' && !shown.messages.length && (
          <Notice icon={searching ? Search : Inbox} title={searching ? 'Nothing found' : 'No messages'}
            text={searching ? 'Search looks at the subject, sender and recipients.' : null} />
        )}
        {shown.messages.map(m => (
          <MessageRow key={m.id} m={m} active={m.id === openId} terms={terms} onOpen={open}
            folderName={searching ? folderName.get(m.folderId) : ''} />
        ))}
        {!searching && list.next && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <button type="button" onClick={older} disabled={list.more} style={{ ...iconBtn, width: 'auto', padding: '0 14px',
              fontFamily: 'var(--font)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {list.more ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}
        {shown.error && shown.messages.length > 0 && (
          <div role="alert" style={{ padding: 12, fontSize: 12, color: 'var(--red)', textAlign: 'center' }}>{shown.error}</div>
        )}
      </div>
    </div>
  );

  const foldersPane = (
    <div style={{ ...pane, flex: narrow ? 1 : '0 0 240px', borderRight: narrow ? 'none' : '1px solid var(--border)', background: 'var(--bg)' }}>
      <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Mail</div>
          <div title={box.me.email} style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {box.me.email}
          </div>
        </div>
        <button type="button" onClick={() => refresh()} disabled={refreshing} aria-label="Refresh" title="Refresh" style={iconBtn}>
          <RefreshCw size={16} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>
      <FolderList folders={tree} current={searching ? null : folderId} opened={opened} onToggle={toggleFolder} onPick={pickFolder} />
      <div style={{ padding: '8px 14px 12px', fontSize: 11.5, color: box.me.syncStatus === 'Error' ? 'var(--red)' : 'var(--muted)' }}>
        Updated {ago(box.me.published || box.me.lastSync)}
      </div>
    </div>
  );

  if (narrow) {
    if (view === 'message' && openId) return <Reader key={openId} id={openId} onBack={() => setView('list')} />;
    return view === 'folders' ? foldersPane : listPane;
  }
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      {foldersPane}
      {listPane}
      {openId ? <Reader key={openId} id={openId} /> : <div style={{ ...pane, flex: 1 }}><Notice icon={MailOpen} title="Pick a message to read" /></div>}
    </div>
  );
}
