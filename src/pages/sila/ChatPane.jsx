import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Check, CheckCheck, FileText, Ban, Paperclip, Send, Mic, MoreHorizontal, Reply, Copy, Pencil, Trash2, X, Clock, AlertCircle,
  Users, Lock,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import { chatApi, formatSize, newLocalId, PAGE_SIZE } from '../../shared/chat.js';
import { cacheKey, getCached, putCached, newestId, applyDelta } from '../../shared/chatCache.js';
import GroupInfoPanel from './GroupInfoPanel.jsx';

// The right side for a one-to-one chat or a group (design/mockups/Home.dc.html):
// header, messages (newest page first, "Load older" pages back), read state,
// composer, and per-message Reply / Copy / Edit / Delete (own messages only
// for edit and delete). Groups add sender names / photos, system lines and
// the locked state (only admins send). Sends are optimistic and idempotent
// (LocalChatID): a failed send can be retried without saving it twice. New
// messages from others appear on reload until live updates are wired.

function dayLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const timeOf = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const bySort = (a, b) => (a.sortId - b.sortId) || (a.id - b.id);

// Only one voice note plays at a time: starting one pauses the one playing.
let playingAudio = null;
function onAudioPlay(e) {
  const el = e.currentTarget;
  if (playingAudio && playingAudio !== el) playingAudio.pause();
  playingAudio = el;
}
function onAudioStop(e) {
  if (playingAudio === e.currentTarget) playingAudio = null;
}

function VoiceNote({ file, mine }) {
  const [failed, setFailed] = useState(false);
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 12, minWidth: 0,
      background: mine ? 'rgba(255,255,255,.55)' : 'var(--soft)',
    }}>
      <Mic size={18} aria-hidden="true" style={{ color: 'var(--accent-strong)', flexShrink: 0 }} />
      {failed ? (
        <a href={file.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>
          Voice message · open
        </a>
      ) : (
        // preload="none": nothing downloads until the user presses play
        <audio controls preload="none" src={file.url} onError={() => setFailed(true)}
          onPlay={onAudioPlay} onPause={onAudioStop} onEnded={onAudioStop}
          aria-label="Voice message" style={{ height: 36, width: 240, maxWidth: '100%' }} />
      )}
    </span>
  );
}

function ImageAttachment({ file, mine }) {
  const [status, setStatus] = useState('loading');   // loading | ok | failed
  if (status === 'failed') return <FileCard file={file} mine={mine} />;
  return (
    <a href={file.url} target="_blank" rel="noopener noreferrer" aria-label={`Open image ${file.name}`} style={{
      position: 'relative', display: 'block', width: status === 'ok' ? 'auto' : 220, height: status === 'ok' ? 'auto' : 160,
      maxWidth: '100%', borderRadius: 10, overflow: 'hidden', background: 'var(--soft)',
    }}>
      {status === 'loading' && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--muted)' }}>
          Loading image…
        </span>
      )}
      <img src={file.url} alt={file.name} loading="lazy" onLoad={() => setStatus('ok')} onError={() => setStatus('failed')} style={{
        display: 'block', maxWidth: 280, maxHeight: 280, width: status === 'ok' ? 'auto' : '100%', height: status === 'ok' ? 'auto' : '100%',
        objectFit: 'cover', opacity: status === 'ok' ? 1 : 0,
      }} />
    </a>
  );
}

function Attachment({ file, mine }) {
  if (file.audio) return <VoiceNote file={file} mine={mine} />;
  if (file.image) return <ImageAttachment file={file} mine={mine} />;
  return <FileCard file={file} mine={mine} />;
}

function FileCard({ file, mine }) {
  return (
    <a href={file.url} target="_blank" rel="noopener noreferrer" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, textDecoration: 'none',
      background: mine ? 'rgba(255,255,255,.55)' : 'var(--soft)', color: 'var(--text)', minWidth: 0,
    }}>
      <span style={{
        width: 36, height: 40, borderRadius: 6, background: 'var(--accent-strong)', color: 'var(--on-accent)',
        fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{(file.ext || 'file').slice(0, 4).toUpperCase()}</span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto">{file.name}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{formatSize(file.size) || 'Open file'}</span>
      </span>
    </a>
  );
}

const menuItemStyle = (danger) => ({
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 38, padding: '0 10px', border: 'none',
  borderRadius: 8, background: 'transparent', color: danger ? 'var(--red)' : 'var(--text)', fontFamily: 'var(--font)',
  fontSize: 13, fontWeight: 600, textAlign: 'left', cursor: 'pointer',
});

function MessageMenu({ m, canChange, onReply, onCopy, onEdit, onDelete, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  const act = (fn) => () => { onClose(); fn(m); };
  return (
    <div ref={ref} role="menu" aria-label="Message options" style={{
      position: 'absolute', bottom: 34, [m.mine ? 'right' : 'left']: 0, zIndex: 30, minWidth: 160, padding: 6,
      borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
    }}>
      {canChange && <button role="menuitem" style={menuItemStyle()} onClick={act(onReply)}><Reply size={16} /> Reply</button>}
      {m.text && <button role="menuitem" style={menuItemStyle()} onClick={act(onCopy)}><Copy size={16} /> Copy</button>}
      {canChange && m.mine && m.text && <button role="menuitem" style={menuItemStyle()} onClick={act(onEdit)}><Pencil size={16} /> Edit</button>}
      {canChange && m.mine && <button role="menuitem" style={menuItemStyle(true)} onClick={act(onDelete)}><Trash2 size={16} /> Delete</button>}
    </div>
  );
}

function Bubble({ m, otherName, menuOpen, onMenu, actions, isGroup, canChange, online }) {
  const mine = m.mine;
  const canAct = !m.deleted && !m.pending;
  if (m.system) {
    return (
      <div dir="auto" style={{
        alignSelf: 'center', maxWidth: '90%', padding: '4px 12px', borderRadius: 999, background: 'var(--border)',
        color: 'var(--text2)', fontSize: 12, fontWeight: 600, textAlign: 'center',
      }}>{m.text} · {timeOf(m.at)}</div>
    );
  }
  const sender = isGroup && !mine && m.from;
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, flexDirection: mine ? 'row-reverse' : 'row', maxWidth: 'min(600px, 86%)', minWidth: 0 }}>
        {sender && (
          <span style={{ marginRight: 6, display: 'flex', flexShrink: 0 }}>
            <Avatar name={m.from.name} size={32} photoUrl={m.from.photoUrl} online={online(m.from.username)} />
          </span>
        )}
        <div style={{
          minWidth: 0, maxWidth: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 12px',
          borderRadius: mine ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
          background: mine ? 'var(--accent-soft)' : 'var(--surface)', border: mine ? '1px solid var(--accent-line)' : '1px solid var(--border)',
          color: 'var(--text)', opacity: m.pending === 'sending' ? 0.75 : 1,
        }}>
          {sender && (
            <span dir="auto" style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-strong)' }}>
              {m.from.name}{m.from.jobTitle && <span style={{ fontWeight: 500, color: 'var(--muted)' }}> · {m.from.jobTitle}</span>}
            </span>
          )}
          {m.reply && !m.deleted && (
            <span style={{
              display: 'flex', flexDirection: 'column', padding: '4px 10px', borderRadius: 8, fontSize: 12, minWidth: 0,
              maxWidth: '100%', overflow: 'hidden',
              background: mine ? 'rgba(255,255,255,.55)' : 'var(--soft)', borderInlineStart: '3px solid var(--accent)',
            }}>
              <span style={{ fontWeight: 700, color: 'var(--accent-strong)' }}>{m.reply.mine ? 'You' : (m.reply.name || otherName)}</span>
              <span dir="auto" style={{ color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.reply.text}</span>
            </span>
          )}
          {m.deleted ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontStyle: 'italic', color: 'var(--muted)' }}>
              <Ban size={14} /> {mine ? 'You deleted this message' : 'This message was deleted'}
            </span>
          ) : (
            <>
              {m.file && <Attachment file={m.file} mine={mine} />}
              {m.text && <span dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</span>}
            </>
          )}
          <span style={{
            alignSelf: 'flex-end', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
            color: m.pending === 'failed' ? 'var(--red)' : mine ? 'var(--accent-strong)' : 'var(--muted)',
          }}>
            {m.pending === 'failed' ? (
              <>
                <AlertCircle size={13} /> Not sent ·
                <button onClick={() => actions.onRetry(m)} style={{
                  border: 'none', background: 'none', padding: 0, color: 'var(--red)', fontWeight: 800, fontSize: 11,
                  cursor: 'pointer', fontFamily: 'var(--font)', textDecoration: 'underline',
                }}>Retry</button>
              </>
            ) : (
              <>
                {timeOf(m.at)}{m.edited && !m.deleted ? ' · Edited' : ''}
                {mine && (m.pending === 'sending' ? <Clock size={13} aria-label="Sending" />
                  : isGroup ? null   // groups have no read receipts
                    : m.seen ? <CheckCheck size={14} aria-label="Seen" /> : <Check size={14} aria-label="Sent" />)}
              </>
            )}
          </span>
        </div>
        {canAct && (
          <span style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => onMenu(menuOpen ? null : m.id)} aria-label="Message options" aria-haspopup="menu"
              aria-expanded={menuOpen} style={{
                width: 30, height: 30, borderRadius: 15, border: 'none', cursor: 'pointer', color: 'var(--muted)',
                background: menuOpen ? 'var(--border)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><MoreHorizontal size={18} /></button>
            {menuOpen && <MessageMenu m={m} canChange={canChange} {...actions} onClose={() => onMenu(null)} />}
          </span>
        )}
      </div>
    </div>
  );
}

function ConfirmDelete({ m, busy, isGroup, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const esc = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [busy, onCancel]);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.45)' }} />
      <div role="alertdialog" aria-modal="true" aria-labelledby="del-title" aria-describedby="del-desc" style={{
        position: 'relative', width: 'min(400px, 100%)', padding: 22, borderRadius: 16, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <h2 id="del-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>Delete this message?</h2>
        <p id="del-desc" style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
          {isGroup ? 'Everyone in the group' : 'Both of you'} will see “This message was deleted”. This can't be undone.
        </p>
        {m.text && (
          <blockquote dir="auto" style={{
            margin: '4px 0 0', padding: '8px 12px', borderRadius: 10, background: 'var(--soft)', fontSize: 13,
            color: 'var(--text2)', borderInlineStart: '3px solid var(--border2)', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto',
          }}>{m.text}</blockquote>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button ref={cancelRef} onClick={onCancel} disabled={busy} style={{
            height: 40, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{
            height: 40, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--red)', color: '#fff',
            fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer', opacity: busy ? 0.7 : 1,
          }}>{busy ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  );
}

export default function ChatPane({ item, isOnline = () => false, onRead, onActivity }) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => chatApi(item), [item.id]);
  const [state, setState] = useState({ status: 'loading', header: null, messages: [], hasMore: false, error: '' });
  const [pending, setPending] = useState([]);        // optimistic sends: { localId, text, reply, replyToId, status }
  const [older, setOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);      // message
  const [editing, setEditing] = useState(null);      // message
  const [menuFor, setMenuFor] = useState(null);      // message id
  const [confirmDel, setConfirmDel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [showInfo, setShowInfo] = useState(false);   // group details panel
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const keepScroll = useRef(null);   // { height } before prepending an older page
  const stickBottom = useRef(true);
  const loadSeq = useRef(0);
  const header = state.header;
  const me = header?.me;
  const otherName = header?.title || item.title;
  const isGroup = api.isGroup;
  // a locked group takes messages (and changes) from its admins only
  const canWrite = !(isGroup && header?.locked && !header?.isAdmin);

  const flash = useCallback((text) => {
    setNotice(text);
    window.clearTimeout(flash.t);
    flash.t = window.setTimeout(() => setNotice(''), 2500);
  }, []);
  useEffect(() => () => window.clearTimeout(flash.t), [flash]);

  // ---- loading: cache first (chatCache.js), then only what's new (AfterChatID)
  const key = cacheKey(item);
  const stateRef = useRef(state);
  stateRef.current = state;
  const syncing = useRef(false);

  // full load of the newest page; keepShown: refresh behind what is on screen
  const fullLoad = useCallback((keepShown = false) => {
    const seq = ++loadSeq.current;
    if (!keepShown) setState({ status: 'loading', header: null, messages: [], hasMore: false, error: '' });
    api.load()
      .then(page => {
        if (seq !== loadSeq.current) return;
        stickBottom.current = true;
        setState({ status: 'ready', ...page, error: '' });
      })
      .catch(err => {
        if (seq === loadSeq.current && !keepShown) setState(s => ({ ...s, status: 'error', error: err.message || 'Could not load this conversation.' }));
      });
  }, [api]);

  // rows newer than the newest one held (new messages, edit / delete copies)
  const syncNew = useCallback((messages) => {
    const after = newestId(messages || stateRef.current.messages);
    if (!after || syncing.current) return;
    syncing.current = true;
    const seq = loadSeq.current;
    api.load(0, after)
      .then(page => {
        if (seq !== loadSeq.current) return;
        if (page.messages.length >= PAGE_SIZE) { fullLoad(true); return; }   // too many to be sure: reload
        const el = scrollRef.current;
        if (page.messages.length && el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) stickBottom.current = true;
        setState(s => (s.status !== 'ready' ? s
          : { ...s, header: page.header || s.header, messages: applyDelta(s.messages, page.messages) }));
      })
      .catch(() => { /* next tick retries */ })
      .finally(() => { syncing.current = false; });
  }, [api, fullLoad]);

  const load = useCallback(() => {
    const cached = getCached(key);
    if (cached) {
      ++loadSeq.current;
      stickBottom.current = true;
      setState({ status: 'ready', header: cached.header, messages: cached.messages, hasMore: cached.hasMore, error: '' });
      syncNew(cached.messages);
    } else {
      fullLoad();
    }
    if (item.unread > 0) {
      api.markRead().then(() => onRead?.(item.id)).catch(() => { /* stays unread; retried next open */ });
    }
    // item.unread / onRead are read at open time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  useEffect(() => { load(); }, [load]);

  // keep the cache current (sends, edits, deletes, older pages, deltas)
  useEffect(() => {
    if (state.status === 'ready') putCached(key, { header: state.header, messages: state.messages, hasMore: state.hasMore });
  }, [key, state]);

  // until live events exist: pick up new messages every 30 s and on return to the tab
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const tick = () => { if (document.visibilityState === 'visible') syncNew(); };
    const timer = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [state.status, syncNew]);

  const loadOlder = () => {
    const first = state.messages[0];
    if (!first || older) return;
    setOlder(true);
    keepScroll.current = { height: scrollRef.current?.scrollHeight || 0 };
    const seq = loadSeq.current;
    api.load(first.sortId)
      .then(page => {
        if (seq !== loadSeq.current) return;
        setState(s => ({ ...s, messages: [...page.messages, ...s.messages].sort(bySort), hasMore: page.hasMore }));
      })
      .catch(err => flash(err.message || 'Could not load older messages.'))
      .finally(() => setOlder(false));
  };

  // newest page / own send: stick to the bottom; older page: keep the reader's place
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || state.status !== 'ready') return;
    if (keepScroll.current) {
      el.scrollTop = el.scrollHeight - keepScroll.current.height;
      keepScroll.current = null;
    } else if (stickBottom.current) {
      el.scrollTop = el.scrollHeight;
      stickBottom.current = false;
    }
  }, [state.messages, state.status, pending]);

  // ---- actions
  const replaceMessage = (oldId, saved) =>
    setState(s => ({ ...s, messages: [...s.messages.filter(x => x.id !== oldId && x.id !== saved.id), saved].sort(bySort) }));

  const trySend = useCallback(async (p) => {
    setPending(list => list.map(x => (x.localId === p.localId ? { ...x, status: 'sending' } : x)));
    try {
      const saved = await api.send({ text: p.text, replyToId: p.replyToId, localId: p.localId, me });
      setPending(list => list.filter(x => x.localId !== p.localId));
      stickBottom.current = true;
      setState(s => ({ ...s, messages: [...s.messages.filter(x => x.id !== saved.id), saved].sort(bySort) }));
      onActivity?.(item.id, { preview: saved.text, at: saved.at || new Date() });
    } catch (err) {
      setPending(list => list.map(x => (x.localId === p.localId ? { ...x, status: 'failed', error: err.message } : x)));
    }
  }, [api, me, item.id, onActivity]);

  const submit = async (e) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy || state.status !== 'ready' || !canWrite) return;
    if (editing) {
      if (text === editing.text) { setEditing(null); setDraft(''); return; }
      setBusy(true);
      try {
        const saved = await api.edit({ chatId: editing.id, text, localId: newLocalId(), me });
        replaceMessage(editing.id, saved);
        setEditing(null); setDraft('');
      } catch (err) { flash(err.message || 'Could not save the edit.'); }
      finally { setBusy(false); }
      return;
    }
    const p = {
      localId: newLocalId(), text, status: 'sending', at: new Date(),
      replyToId: replyTo?.id || 0, reply: replyTo ? { text: replyTo.text || 'Attachment', mine: replyTo.mine } : null,
    };
    setDraft(''); setReplyTo(null);
    stickBottom.current = true;
    setPending(list => [...list, p]);
    trySend(p);
  };

  const doDelete = async () => {
    const m = confirmDel;
    setBusy(true);
    try {
      const saved = await api.del({ chatId: m.id, localId: newLocalId(), me });
      replaceMessage(m.id, saved);
      if (editing?.id === m.id) { setEditing(null); setDraft(''); }
      if (replyTo?.id === m.id) setReplyTo(null);
      setConfirmDel(null);
    } catch (err) { flash(err.message || 'Could not delete the message.'); }
    finally { setBusy(false); }
  };

  const actions = {
    onReply: (m) => { setEditing(null); setReplyTo(m); inputRef.current?.focus(); },
    onCopy: (m) => {
      navigator.clipboard?.writeText(m.text).then(() => flash('Message copied'), () => flash('Copy is blocked in this browser'));
    },
    onEdit: (m) => { setReplyTo(null); setEditing(m); setDraft(m.text); setTimeout(() => inputRef.current?.focus(), 0); },
    onDelete: (m) => setConfirmDel(m),
    onRetry: (m) => trySend(pending.find(p => p.localId === m.localId)),
  };
  const cancelBar = () => { if (editing) setDraft(''); setEditing(null); setReplyTo(null); };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape' && (editing || replyTo)) { e.preventDefault(); cancelBar(); }
  };
  // grow the composer with its text (up to ~5 lines)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const photoUrl = header?.photoUrl || item.photoUrl;
  const headerOnline = !isGroup && isOnline(header?.username || item.username);
  const subLine = isGroup
    ? [header ? `${header.memberCount} member${header.memberCount === 1 ? '' : 's'}` : null, header?.locked ? 'Only admins can send' : null]
    // job · department (UserJobMaster / UserDepartmentMaster); @username until a job is set
    : [header?.jobTitle || item.jobTitle || (header?.username ? `@${header.username}` : null), headerOnline ? 'Online' : null];

  const shown = [
    ...state.messages,
    ...pending.map(p => ({
      id: `p-${p.localId}`, localId: p.localId, sortId: Infinity, mine: true, at: p.at, text: p.text,
      reply: p.reply, pending: p.status,
    })),
  ];
  const rows = [];
  let lastDay = '';
  for (const m of shown) {
    const label = m.at ? dayLabel(m.at) : '';
    if (label && label !== lastDay) { rows.push({ divider: label, key: `d-${label}-${m.id}` }); lastDay = label; }
    rows.push({ m, key: m.id });
  }
  const bar = editing ? { title: 'Editing message', text: editing.text, label: 'Cancel editing' }
    : replyTo ? { title: `Replying to ${replyTo.mine ? 'yourself' : (replyTo.from?.name || otherName)}`, text: replyTo.text || 'Attachment', label: 'Cancel reply' }
    : null;

  const headerBody = (
    <>
      <Avatar name={otherName} size={44} photoUrl={photoUrl} online={headerOnline} />
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }} dir="auto">{otherName}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          {isGroup && (header?.locked ? <Lock size={12} /> : <Users size={12} />)}
          {subLine.filter(Boolean).join(' · ') || '\u00a0'}
          {isGroup && <span style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>· {showInfo ? 'hide info' : 'group info'}</span>}
        </span>
      </span>
    </>
  );

  return (
    <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>
    <main style={{ position: 'relative', flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--soft)' }}>
      <header style={{
        minHeight: 72, padding: '12px 24px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
      }}>
        {isGroup ? (
          // the group header opens the details panel (members)
          <button onClick={() => setShowInfo(v => !v)} aria-expanded={showInfo} aria-label={`${otherName}: ${showInfo ? 'hide' : 'show'} group info`}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, padding: '4px 8px', margin: '-4px -8px',
              border: 'none', borderRadius: 12, background: showInfo ? 'var(--soft)' : 'transparent', cursor: 'pointer',
              fontFamily: 'var(--font)',
            }}>{headerBody}</button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>{headerBody}</div>
        )}
      </header>

      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.status === 'loading' && (
          <div role="status" style={{ margin: 'auto', color: 'var(--muted)', fontSize: 13 }}>Loading messages…</div>
        )}
        {state.status === 'error' && (
          <div role="alert" style={{
            margin: 'auto', padding: '10px 14px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)',
            fontSize: 13, display: 'flex', gap: 10, alignItems: 'center',
          }}>
            {state.error}
            <button onClick={load} style={{
              border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 800, cursor: 'pointer', fontFamily: 'var(--font)',
            }}>Try again</button>
          </div>
        )}
        {state.status === 'ready' && state.hasMore && (
          <button onClick={loadOlder} disabled={older} style={{
            alignSelf: 'center', height: 32, padding: '0 14px', borderRadius: 999, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            fontFamily: 'var(--font)',
          }}>{older ? 'Loading…' : 'Load older messages'}</button>
        )}
        {state.status === 'ready' && shown.length === 0 && (
          <div style={{ margin: 'auto', color: 'var(--muted)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={16} /> No messages yet. Say hello.
          </div>
        )}
        {state.status === 'ready' && rows.map(r => (r.divider ? (
          <div key={r.key} style={{
            alignSelf: 'center', padding: '3px 12px', borderRadius: 999, background: 'var(--border)', color: 'var(--text2)',
            fontSize: 12, fontWeight: 600, margin: '6px 0',
          }}>{r.divider}</div>
        ) : (
          <Bubble key={r.key} m={r.m} otherName={otherName} menuOpen={menuFor === r.m.id}
            onMenu={setMenuFor} actions={actions} isGroup={isGroup} canChange={canWrite} online={isOnline} />
        )))}
      </div>

      {bar && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 8px 24px',
          background: 'var(--surface)', borderTop: '1px solid var(--border)',
        }}>
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '2px 10px', borderInlineStart: '3px solid var(--accent)' }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-strong)' }}>{bar.title}</span>
            <span dir="auto" style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bar.text}</span>
          </span>
          <button onClick={cancelBar} aria-label={bar.label} style={{
            width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        </div>
      )}

      {!canWrite ? (
        <div style={{
          flexShrink: 0, padding: '16px 24px', background: 'var(--surface)', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text2)', fontSize: 13,
        }}><Lock size={16} /> Only admins can send messages in this group.</div>
      ) : (
      <form onSubmit={submit} style={{
        flexShrink: 0, padding: '12px 24px 16px', background: 'var(--surface)', borderTop: bar ? 'none' : '1px solid var(--border)',
        display: 'flex', alignItems: 'flex-end', gap: 10,
      }}>
        <button type="button" disabled aria-label="Attach file" title="Attachments come next" style={{
          width: 44, height: 44, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.6, flexShrink: 0,
        }}><Paperclip size={20} /></button>
        <label htmlFor="chat-composer" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Message</label>
        <textarea id="chat-composer" ref={inputRef} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
          disabled={state.status !== 'ready'} dir="auto"
          placeholder={editing ? 'Edit your message…' : `Message ${otherName.split(' ')[0]}…`} style={{
            flex: 1, minWidth: 0, minHeight: 44, maxHeight: 132, resize: 'none', padding: '11px 16px', borderRadius: 12,
            border: `1.5px solid ${editing ? 'var(--accent)' : 'var(--border)'}`, background: 'var(--soft)', fontSize: 14,
            lineHeight: '20px', color: 'var(--text)', fontFamily: 'var(--font)', outlineColor: 'var(--accent)',
          }} />
        <button type="submit" aria-label={editing ? 'Save edit' : 'Send'} disabled={!draft.trim() || busy || state.status !== 'ready'} style={{
          width: 44, height: 44, borderRadius: 12, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          opacity: !draft.trim() || busy ? 0.5 : 1,
        }}>{editing ? <Check size={20} /> : <Send size={20} />}</button>
      </form>
      )}

      {notice && (
        <div role="status" style={{
          position: 'absolute', left: '50%', bottom: 88, transform: 'translateX(-50%)', zIndex: 40, padding: '8px 14px',
          borderRadius: 10, background: 'var(--text)', color: 'var(--surface)', fontSize: 13, fontWeight: 600, boxShadow: 'var(--shadow-lg)',
        }}>{notice}</div>
      )}
      {confirmDel && <ConfirmDelete m={confirmDel} busy={busy} isGroup={isGroup} onCancel={() => setConfirmDel(null)} onConfirm={doDelete} />}
    </main>
    {isGroup && showInfo && (
      <GroupInfoPanel groupId={item.raw?.GroupID} header={header} isOnline={isOnline} onClose={() => setShowInfo(false)}
        onLockChange={({ locked, system }) => {
          stickBottom.current = !!system;
          setState(s => ({
            ...s, header: s.header ? { ...s.header, locked } : s.header,
            messages: system ? [...s.messages.filter(x => x.id !== system.id), system].sort(bySort) : s.messages,
          }));
          if (system) onActivity?.(item.id, { preview: system.text, at: system.at });
        }}
        onAdminChange={({ me: self, admin, system }) => {
          stickBottom.current = !!system;
          setState(s => ({
            ...s, header: self && s.header ? { ...s.header, isAdmin: admin } : s.header,
            messages: system ? [...s.messages.filter(x => x.id !== system.id), system].sort(bySort) : s.messages,
          }));
          if (system) onActivity?.(item.id, { preview: system.text, at: system.at });
        }} />
    )}
    </div>
  );
}
