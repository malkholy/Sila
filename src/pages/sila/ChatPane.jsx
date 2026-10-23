import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Check, CheckCheck, FileText, Ban, Paperclip, Send, Mic, MoreHorizontal, Reply, Copy, Pencil, Trash2, X, Clock, AlertCircle,
  Users, Megaphone, Lock, Hash, LogOut, ShieldAlert, Play, Pause, Flag, RotateCcw, Archive, Type, Download, Forward, CheckCircle2, XCircle, Undo2,
} from 'lucide-react';
import RichComposer from './RichComposer.jsx';
import { sanitizeForSend, sanitizeForShow, hasFormatting, toPlainText } from '../../shared/richText.js';
import { ACCEPT, checkFile, downloadFile, fileBlobUrl, fileEntity, isFilesApiUrl, saveAttachment, uploadFile } from '../../shared/files.js';
import Avatar from './Avatar.jsx';
import { chatApi, formatSize, newLocalId, PAGE_SIZE, changeTicketState, answerForward, cancelForward, leaveTicket } from '../../shared/chat.js';
import ForwardDialog from './ForwardDialog.jsx';
import { cacheKey, getCached, putCached, syncAnchor, applyDelta } from '../../shared/chatCache.js';
import GroupInfoPanel from './GroupInfoPanel.jsx';
import TicketInfoPanel from './TicketInfoPanel.jsx';
import { isSelectingText } from '../../shared/textSelection.js';
import { onLive } from '../../shared/live.js';
import { FlagButton, FlagPin } from './TicketFlag.jsx';
import { AssignButton } from './TicketAssign.jsx';
import SlaBadge from './SlaBadge.jsx';

// The right side for a one-to-one chat, a group or a ticket (design/mockups/Home.dc.html):
// header, messages (newest page first, "Load older" pages back), read state,
// composer, and per-message Reply / Copy / Edit / Delete (own messages only
// for edit and delete). Groups add sender names / photos, system lines and
// the locked state (only admins send). Sends are optimistic and idempotent
// (LocalChatID): a failed send can be retried without saving it twice.
// Tickets (CHA.APISilaWebTicketOperation) add the channel / state header with
// the actions the SP allows the caller (Start, Hold, End, Reopen, Close),
// admins-only notes for ticket admins / team leaders, and a closed composer
// when the ticket's state takes no messages.

// ticket state -> tone [fg, bg] (as the Home list)
const TICKET_TONE = {
  0: ['var(--blue)', 'var(--blue-soft)'], 1: ['var(--green)', 'var(--green-soft)'], 5: ['var(--amber)', 'var(--amber-soft)'],
};
// can: the header's Can* flag that shows the button (default: key); confirm: asked
// first, in the panel. kind: 'state' (Change ticket state), 'forward' (the dialog),
// 'accept' / 'reject' (Answer forward, on the waiting copy), 'cancel' (Cancel forward),
// 'leave' (Leave ticket: header.can.leave -- not the last admin / team leader of an open ticket).
const TICKET_ACTIONS = [
  { key: 'start', action: 'Start', label: 'Start', icon: Play, primary: true },
  { key: 'accept', can: 'answerForward', kind: 'accept', label: 'Accept forward', icon: CheckCircle2, primary: true },
  { key: 'reject', can: 'answerForward', kind: 'reject', label: 'Reject forward', icon: XCircle,
    confirm: 'Reject this forwarded ticket? It goes back to the channel it came from.', confirmLabel: 'Reject' },
  { key: 'forward', kind: 'forward', label: 'Forward', icon: Forward },
  { key: 'cancelForward', kind: 'cancel', label: 'Cancel forward', icon: Undo2,
    confirm: 'Cancel the forward? The ticket comes back here as New.', confirmLabel: 'Cancel forward' },
  { key: 'hold', action: 'Hold', label: 'Hold', icon: Pause },
  { key: 'reopen', action: 'Reopen', label: 'Reopen', icon: RotateCcw, primary: true },
  { key: 'end', action: 'End', label: 'End', icon: Flag },
  { key: 'close', action: 'Close', label: 'Close', icon: Archive, confirm: 'Close this ticket for good?', confirmLabel: 'Close' },
  { key: 'leave', kind: 'leave', label: 'Leave ticket', icon: LogOut,
    confirm: 'Leave this ticket? You stop getting its messages and it leaves your lists.', confirmLabel: 'Leave' },
];

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

// entity: a voice note stored by the Files API -- its link needs the user's token,
// so it is fetched (once, on the first press of Play) and played from memory
function VoiceNote({ file, mine, entity }) {
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState(entity ? '' : file.url);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    fileBlobUrl({ attachmentId: file.id, ...entity })
      .then(url => setSrc(url))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 12, minWidth: 0,
      background: mine ? 'rgba(255,255,255,.55)' : 'var(--soft)',
    }}>
      <Mic size={18} aria-hidden="true" style={{ color: 'var(--accent-strong)', flexShrink: 0 }} />
      {failed ? (entity ? <FileCard file={file} mine={mine} entity={entity} /> : (
        <a href={file.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>
          Voice message · open
        </a>
      )) : !src ? (
        <button type="button" onClick={load} disabled={loading} aria-label="Play voice message" style={{
          display: 'flex', alignItems: 'center', gap: 6, height: 36, padding: '0 12px', borderRadius: 18,
          border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
          fontFamily: 'var(--font)', fontSize: 13, fontWeight: 600, cursor: loading ? 'progress' : 'pointer',
        }}>
          <Play size={14} /> {loading ? 'Loading…' : 'Voice message'}
        </button>
      ) : (
        // preload="none": nothing downloads until the user presses play; a fetched note starts at once
        <audio controls preload="none" autoPlay={!!entity} src={src} onError={() => setFailed(true)}
          onPlay={onAudioPlay} onPause={onAudioStop} onEnded={onAudioStop}
          aria-label="Voice message" style={{ height: 36, width: 240, maxWidth: '100%' }} />
      )}
    </span>
  );
}

function ImageAttachment({ file, mine, onView }) {
  const [status, setStatus] = useState('loading');   // loading | ok | failed
  if (status === 'failed') return <FileCard file={file} mine={mine} />;
  return (
    <button type="button" onClick={() => onView?.({ url: file.url, name: file.name, downloadUrl: file.url })}
      aria-label={`View image ${file.name}`} style={{
      display: 'block', padding: 0, border: 'none', cursor: 'zoom-in', font: 'inherit',
      position: 'relative', width: status === 'ok' ? 'auto' : 220, height: status === 'ok' ? 'auto' : 160,
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
    </button>
  );
}

// A file stored by the Files API (:7500): fetched with the user's token
function ProtectedImage({ file, mine, entity, onView }) {
  const [state, setState] = useState({ url: '', failed: false });
  useEffect(() => {
    let alive = true;
    fileBlobUrl({ attachmentId: file.id, ...entity, preview: true })   // the small preview, not the original
      .then(url => { if (alive) setState({ url, failed: false }); })
      .catch(() => { if (alive) setState({ url: '', failed: true }); });
    return () => { alive = false; };
  }, [file.id, entity.entityType, entity.entityKey]);
  if (state.failed) return <FileCard file={file} mine={mine} entity={entity} />;
  return (
    <button type="button" disabled={!state.url}
      onClick={() => onView?.({ url: state.url, name: file.name, file: { attachmentId: file.id, ...entity } })}
      aria-label={`View image ${file.name}`} style={{
      display: 'block', padding: 0, border: 'none', cursor: 'zoom-in', font: 'inherit',
      position: 'relative', width: state.url ? 'auto' : 220, height: state.url ? 'auto' : 160,
      maxWidth: '100%', borderRadius: 10, overflow: 'hidden', background: 'var(--soft)',
    }}>
      {!state.url && (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--muted)' }}>
          Loading image…
        </span>
      )}
      {state.url && <img src={state.url} alt={file.name} style={{ display: 'block', maxWidth: 280, maxHeight: 280 }} />}
    </button>
  );
}

// Image viewer inside the app (no new tab): Esc or a click outside closes it.
function ImageViewer({ image, onClose }) {
  const closeRef = useRef(null);
  // a Files API image opens on its preview, then switches to the full-quality original
  const [full, setFull] = useState({ url: '', failed: false });
  useEffect(() => {
    if (!image.file) return undefined;
    let alive = true;
    fileBlobUrl(image.file)
      .then(url => { if (alive) setFull({ url, failed: false }); })
      .catch(() => { if (alive) setFull({ url: '', failed: true }); });
    return () => { alive = false; };
  }, [image.file]);
  const shownUrl = full.url || image.url;
  const [saving, setSaving] = useState(false);
  const download = async (e) => {
    if (!image.file) return;   // a plain link downloads by itself
    e.preventDefault();
    setSaving(true);
    try { await downloadFile(image.file, image.name); } catch { /* the button stays; try again */ }
    finally { setSaving(false); }
  };
  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const bar = { height: 38, padding: '0 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.1)',
    color: '#fff', fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
    textDecoration: 'none' };
  return (
    <div role="dialog" aria-modal="true" aria-label={`Image ${image.name}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(10,14,22,.88)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', color: '#fff' }}>
        <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {image.name}
        </span>
        {image.file && !full.url && !full.failed && (
          <span role="status" style={{ fontSize: 12, color: 'rgba(255,255,255,.75)' }}>Loading full quality…</span>
        )}
        <a href={image.file ? '#' : image.downloadUrl} download={image.name} onClick={download} style={bar}>
          <Download size={16} /> {saving ? 'Saving…' : 'Download'}
        </a>
        <button ref={closeRef} onClick={onClose} aria-label="Close" style={bar}><X size={16} /> Close</button>
      </div>
      <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 16px 24px' }}>
        <img src={shownUrl} alt={image.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6, boxShadow: '0 10px 40px rgba(0,0,0,.5)' }} />
      </div>
    </div>
  );
}

// The download icon in the bottom-left corner of every attachment (images,
// files, voice notes)
export function DownloadButton({ file, entity, size = 26 }) {
  const [state, setState] = useState({ busy: false, error: '' });
  const save = async (e) => {
    e.stopPropagation();
    if (state.busy) return;
    setState({ busy: true, error: '' });
    try { await saveAttachment({ file, entity }); setState({ busy: false, error: '' }); }
    catch (err) { setState({ busy: false, error: err.message || 'Could not download the file.' }); }
  };
  return (
    <button type="button" onClick={save} disabled={state.busy} aria-label={`Download ${file.name}`}
      title={state.error || (state.busy ? 'Saving…' : `Download ${file.name}`)} style={{
        position: 'absolute', left: file.image ? 6 : 0, bottom: file.image ? 6 : 0, zIndex: 1, width: size, height: size, padding: 0, borderRadius: 7,
        border: 'none', background: state.error ? 'var(--red)' : 'rgba(15,23,42,.6)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: state.busy ? 'wait' : 'pointer',
        opacity: state.busy ? 0.6 : 1,
      }}>
      <Download size={13} />
    </button>
  );
}

function Attachment({ file, mine, entity, onView }) {
  const ours = isFilesApiUrl(file.url) && file.id && entity;
  const body = file.audio ? <VoiceNote file={file} mine={mine} entity={ours ? entity : null} />
    : file.image ? (ours ? <ProtectedImage file={file} mine={mine} entity={entity} onView={onView} />
      : <ImageAttachment file={file} mine={mine} onView={onView} />)
      : <FileCard file={file} mine={mine} entity={ours ? entity : null} />;
  return (
    // images: the icon sits on the picture's corner; files / voice notes: just under
    // their bottom-left corner, so it never covers the file badge or the play button
    <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', minWidth: 0, paddingBottom: file.image ? 0 : 30 }}>
      {body}
      <DownloadButton file={file} entity={ours ? entity : null} />
    </div>
  );
}

// A file being uploaded / posted from this tab
function UploadCard({ up, mine }) {
  const pct = Math.round((up.progress || 0) * 100);
  return (
    <span style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, minWidth: 220,
      background: mine ? 'rgba(255,255,255,.55)' : 'var(--soft)',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Paperclip size={16} style={{ flexShrink: 0, color: 'var(--accent-strong)' }} />
        <span dir="auto" style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{up.name}</span>
      </span>
      {up.stage !== 'failed' && (
        <span role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${up.name}`}
          style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${up.stage === 'sending' ? 100 : pct}%`, background: 'var(--accent)', transition: 'width .2s' }} />
        </span>
      )}
      <span style={{ fontSize: 11, color: up.stage === 'failed' ? 'var(--red)' : 'var(--muted)' }}>
        {up.stage === 'uploading' ? `Uploading · ${pct}% · ${formatSize(up.size)}`
          : up.stage === 'sending' ? 'Checking and sending…' : up.error || 'Not sent'}
      </span>
    </span>
  );
}

function FileCard({ file, mine, entity = null }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  // Files API file: downloaded with the user's token, saved under its own name
  const onClick = entity ? async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFailed('');
    try { await downloadFile({ attachmentId: file.id, ...entity }, file.name); }
    catch (err) { setFailed(err.message || 'Could not open the file.'); }
    finally { setBusy(false); }
  } : undefined;
  return (
    <a href={entity ? '#' : file.url} onClick={onClick} target={entity ? undefined : '_blank'} rel="noopener noreferrer" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, textDecoration: 'none',
      background: mine ? 'rgba(255,255,255,.55)' : 'var(--soft)', color: 'var(--text)', minWidth: 0,
    }}>
      <span style={{
        width: 36, height: 40, borderRadius: 6, background: 'var(--accent-strong)', color: 'var(--on-accent)',
        fontSize: 10, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{(file.ext || 'file').slice(0, 4).toUpperCase()}</span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto">{file.name}</span>
        <span style={{ fontSize: 12, color: failed ? 'var(--red)' : 'var(--muted)' }}>
          {failed || (busy ? 'Downloading…' : formatSize(file.size) || file.sizeText || 'Open file')}
        </span>
      </span>
    </a>
  );
}

const menuItemStyle = (danger) => ({
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 38, padding: '0 10px', border: 'none',
  borderRadius: 8, background: 'transparent', color: danger ? 'var(--red)' : 'var(--text)', fontFamily: 'var(--font)',
  fontSize: 13, fontWeight: 600, textAlign: 'left', cursor: 'pointer',
});

const actionButton = (primary) => ({
  height: 36, padding: '0 12px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
  border: primary ? 'none' : '1px solid var(--border2)', background: primary ? 'var(--accent)' : 'var(--surface)',
  color: primary ? 'var(--on-accent)' : 'var(--text)', fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', whiteSpace: 'nowrap',
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

function Bubble({ m, otherName, menuOpen, onMenu, actions, isGroup, canChange, online, entity, onView }) {
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
          background: m.adminNote ? 'var(--amber-soft)' : mine ? 'var(--accent-soft)' : 'var(--surface)',
          border: m.adminNote ? '1px dashed var(--amber)' : mine ? '1px solid var(--accent-line)' : '1px solid var(--border)',
          color: 'var(--text)', opacity: m.pending === 'sending' ? 0.75 : 1,
        }}>
          {m.adminNote && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: 'var(--amber)' }}>
              <ShieldAlert size={12} /> Admins only
            </span>
          )}
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
              {m.upload && <UploadCard up={m.upload} mine={mine} />}
              {m.file && <Attachment file={m.file} mine={mine} entity={entity} onView={onView} />}
              {m.html ? (
                <div dir="auto" className="sila-rich-html" dangerouslySetInnerHTML={{ __html: sanitizeForShow(m.html) }} />
              ) : m.text && <span dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</span>}
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

// A table or picture pasted into the formatted-text editor: shown first, then
// sent as an image file (like WhatsApp). Enter sends, Esc cancels.
function PastePreview({ image, onCancel, onSend }) {
  const sendRef = useRef(null);
  useEffect(() => {
    sendRef.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onCancel(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [onCancel]);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div aria-hidden="true" onMouseDown={onCancel} style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.55)' }} />
      <div role="dialog" aria-modal="true" aria-labelledby="paste-title" style={{
        position: 'relative', width: 'min(760px, 100%)', maxHeight: '92%', padding: 20, borderRadius: 16, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <h2 id="paste-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>Send as image</h2>
        <div style={{
          flex: 1, minHeight: 80, overflow: 'auto', borderRadius: 10, border: '1px solid var(--border)', background: '#fff',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 8,
        }}>
          <img src={image.url} alt="Pasted table" style={{ maxWidth: '100%', height: 'auto', display: 'block' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {image.file.name} · {formatSize(image.file.size)}
          </span>
          <button onClick={onCancel} style={{
            height: 40, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
          }}>Cancel</button>
          <button ref={sendRef} onClick={onSend} style={{
            height: 40, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
          }}><Send size={16} /> Send</button>
        </div>
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

// onClose: shown as an X at the end of the header (the pane opened in a drawer, e.g. the Channels board)
// onLeave: the user left this group / ticket (close it, refresh the list)
// onFlagChange(id, flag): the user flagged / unflagged this ticket (lists show it at once)
export default function ChatPane({ item, isOnline = () => false, onRead, onActivity, onTicketChange, onClose, onLeave, onFlagChange }) {
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
  // the details panel: open by default for tickets (members, state, who opened it), closed for groups
  const [showInfo, setShowInfo] = useState(item.kind === 'ticket');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const keepScroll = useRef(null);   // { height } before prepending an older page
  const stickBottom = useRef(true);
  const loadSeq = useRef(0);
  const header = state.header;
  const me = header?.me;
  const otherName = header?.title || item.title;
  const isGroup = api.isGroup;
  const isTicket = api.isTicket;
  const multi = isGroup || isTicket;   // several people: sender names, no read receipts
  // a locked group takes messages (and changes) from its admins only; a ticket
  // takes messages while it is New / In Progress (the SP's CanSend)
  const ticketClosedForChat = isTicket && !!header && !header.can.send;
  const canWrite = !(isGroup && header?.locked && !header?.isAdmin) && !ticketClosedForChat;
  const [adminOnly, setAdminOnly] = useState(false);   // tickets: the next message is an admins-only note
  const [richOpen, setRichOpen] = useState(false);     // the formatted-text pop-up (T button)
  const [pasted, setPasted] = useState(null);          // { file, url }: a pasted table / picture to send
  const fileInputRef = useRef(null);
  const [viewing, setViewing] = useState(null);       // { url, name, downloadUrl }: the image viewer
  const closeViewer = useCallback(() => setViewing(null), []);
  const entity = useMemo(() => fileEntity(item), [item]);   // this conversation, as the Files API names it
  const [richEmpty, setRichEmpty] = useState(true);
  const richRef = useRef(null);
  const [actionBusy, setActionBusy] = useState(null);  // ticket action key
  const [confirmAction, setConfirmAction] = useState(null);
  const [flagPanel, setFlagPanel] = useState(0);   // bumped by the pinned flag note: opens the flag panel
  const [forwarding, setForwarding] = useState(false);   // the Forward dialog

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
  const syncAgain = useRef(false);

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

  // new rows (messages, edit / delete copies): from SYNC_OVERLAP messages back,
  // so one that arrived out of order is never skipped (chatCache.js syncAnchor)
  const syncNew = useCallback((messages) => {
    const after = syncAnchor(messages || stateRef.current.messages);
    if (!after) return;
    if (syncing.current) { syncAgain.current = true; return; }   // a change arrived mid-sync: run once more after
    syncing.current = true;
    const seq = loadSeq.current;
    api.load(0, after)
      .then(page => {
        if (seq !== loadSeq.current) return;
        if (page.messages.length >= PAGE_SIZE) { fullLoad(true); return; }   // too many to be sure: reload
        const el = scrollRef.current;
        const held = new Set(stateRef.current.messages.map(m => m.id));
        if (page.messages.some(m => !held.has(m.id)) && el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) stickBottom.current = true;
        // something new from the others while this conversation is open: it is read
        if (page.messages.some(m => !held.has(m.id) && !m.mine)) readRef.current();
        setState(s => (s.status !== 'ready' ? s
          : { ...s, header: page.header || s.header, messages: applyDelta(s.messages, page.messages) }));
      })
      .catch(() => { /* next tick retries */ })
      .finally(() => {
        syncing.current = false;
        if (syncAgain.current) { syncAgain.current = false; syncNewRef.current(); }
      });
  }, [api, fullLoad]);
  const syncNewRef = useRef(syncNew);
  syncNewRef.current = syncNew;

  // Messages that arrive while the conversation is on screen count as read at
  // once (no unread badge between two people chatting); in a background tab,
  // as soon as the user comes back to it. One request at a time.
  const reading = useRef({ busy: false, again: false, waiting: false });
  const readNow = () => {
    const r = reading.current;
    if (document.visibilityState !== 'visible') { r.waiting = true; return; }
    if (r.busy) { r.again = true; return; }
    r.busy = true; r.waiting = false;
    api.markRead()
      .then(() => onRead?.(item.id))
      .catch(() => { r.waiting = true; })   // tried again when the tab is next shown
      .finally(() => { r.busy = false; if (r.again) { r.again = false; readNow(); } });
  };
  const readRef = useRef(readNow);
  readRef.current = readNow;
  useEffect(() => {
    const back = () => { if (reading.current.waiting && document.visibilityState === 'visible') readRef.current(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); };
  }, []);

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
    if (item.unread > 0) readRef.current();
    // item.unread / onRead are read at open time only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  useEffect(() => { load(); }, [load]);

  // a send whose answer was lost: its message arrived anyway (live update,
  // refresh, reopen) -- drop the sending / failed bubble with the same LocalChatID
  useEffect(() => {
    const mineIds = new Set(state.messages.filter(m => m.mine && m.localId).map(m => m.localId));
    if (mineIds.size) setPending(list => (list.some(p => mineIds.has(p.localId)) ? list.filter(p => !mineIds.has(p.localId)) : list));
  }, [state.messages]);

  // keep the cache current (sends, edits, deletes, older pages, deltas)
  useEffect(() => {
    if (state.status === 'ready') putCached(key, { header: state.header, messages: state.messages, hasMore: state.hasMore });
  }, [key, state]);

  // live: this conversation's SilaHistory row moved (new message, edit, delete) -> delta now
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const id = item.kind === 'group' ? item.raw?.GroupID : item.kind === 'ticket' ? item.raw?.TicketID : item.raw?.SessionID;
    return onLive('changed', frame => {
      if ((frame.items || []).some(c => c.kind === item.kind && c.id === id)) syncNew();
    });
  }, [state.status, syncNew, item]);

  // fallback when the socket is down: pick up new messages every 30 s and on return to the tab
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
      const saved = await api.send({ text: p.text, html: p.html, replyToId: p.replyToId, localId: p.localId, me, adminOnly: p.adminOnly });
      setPending(list => list.filter(x => x.localId !== p.localId));
      stickBottom.current = true;
      setState(s => ({ ...s, messages: [...s.messages.filter(x => x.id !== saved.id), saved].sort(bySort) }));
      if (!saved.adminNote) onActivity?.(item.id, { preview: saved.text, at: saved.at || new Date() });
      // a manager's first message starts a new ticket: pick up the new state
      if (isTicket && header?.state === 0 && !saved.adminNote) fullLoad(true);
    } catch (err) {
      setPending(list => list.map(x => (x.localId === p.localId ? { ...x, status: 'failed', error: err.message } : x)));
    }
  }, [api, me, item.id, onActivity, isTicket, header?.state, fullLoad]);

  // ---- files: upload to the Files API (:7500), then post the message. A failed
  // step can be retried: an upload that already succeeded is not repeated.
  const setUp = (localId, patch) => setPending(list => list.map(x => (x.localId === localId ? { ...x, ...patch } : x)));
  const tryFile = useCallback(async (p) => {
    let attachmentId = p.attachmentId;
    try {
      if (!attachmentId) {
        setUp(p.localId, { status: 'sending', stage: 'uploading', progress: 0, error: '' });
        attachmentId = await uploadFile({
          file: p.file, ...entity, onProgress: (f) => setUp(p.localId, { progress: f }),
        });
        setUp(p.localId, { attachmentId });
      }
      setUp(p.localId, { status: 'sending', stage: 'sending', error: '' });
      const saved = await api.sendFile({ attachmentId, replyToId: p.replyToId, localId: p.localId, me, adminOnly: p.adminOnly });
      setPending(list => list.filter(x => x.localId !== p.localId));
      stickBottom.current = true;
      setState(s => ({ ...s, messages: [...s.messages.filter(x => x.id !== saved.id), saved].sort(bySort) }));
      if (!saved.adminNote) onActivity?.(item.id, { preview: p.file.name, at: saved.at || new Date() });
      if (isTicket && header?.state === 0 && !saved.adminNote) fullLoad(true);
    } catch (err) {
      setUp(p.localId, { status: 'failed', stage: 'failed', error: err.message || 'Not sent', attachmentId });
    }
  }, [api, entity, me, item.id, onActivity, isTicket, header?.state, fullLoad]);

  const pickFiles = (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';   // the same file can be picked again
    sendFiles(files);
  };
  const sendFiles = (files) => {
    if (!files.length || !canWrite) return;
    const problems = [];
    for (const file of files.slice(0, 10)) {
      const problem = checkFile(file);
      if (problem) { problems.push(problem); continue; }
      const p = {
        localId: newLocalId(), kind: 'file', file, text: '', status: 'sending', stage: 'uploading', progress: 0,
        at: new Date(), replyToId: replyTo?.id || 0, reply: replyTo ? { text: replyTo.text || 'Attachment', mine: replyTo.mine } : null,
        adminOnly: isTicket && adminOnly,
      };
      stickBottom.current = true;
      setPending(list => [...list, p]);
      tryFile(p);
    }
    setReplyTo(null);
    if (files.length > 10) problems.push('Up to 10 files at a time.');
    if (problems.length) flash(problems[0]);
  };

  // what is being sent: { text, html } -- from the plain box, or from the pop-up's
  // editor (html only when there is real formatting)
  const readComposer = (fromRich) => {
    if (!fromRich) return { text: draft.trim(), html: '' };
    const html = sanitizeForSend(richRef.current?.getHtml() || '');
    const text = toPlainText(html);
    return { text, html: hasFormatting(html) ? html : '' };
  };
  const clearComposer = () => { setDraft(''); richRef.current?.clear(); };

  const submit = async (e, fromRich = false) => {
    e?.preventDefault();
    const { text, html } = readComposer(fromRich);
    if (!text || busy || state.status !== 'ready' || !canWrite) return;
    if (text.length > 10000) { flash('The message is too long.'); return; }
    if (editing) {
      if (text === editing.text && html === (editing.html || '')) { setEditing(null); clearComposer(); setRichOpen(false); return; }
      setBusy(true);
      try {
        const saved = await api.edit({ chatId: editing.id, text, html, localId: newLocalId(), me });
        replaceMessage(editing.id, saved);
        setEditing(null); clearComposer(); setRichOpen(false);
      } catch (err) { flash(err.message || 'Could not save the edit.'); }
      finally { setBusy(false); }
      return;
    }
    const p = {
      localId: newLocalId(), text, html, status: 'sending', at: new Date(),
      replyToId: replyTo?.id || 0, reply: replyTo ? { text: replyTo.text || 'Attachment', mine: replyTo.mine } : null,
      adminOnly: isTicket && adminOnly,
    };
    clearComposer(); setReplyTo(null); setRichOpen(false);
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

  // ticket state change; the SP re-checks the role and the state, and posts a system line
  const runTicketAction = async (a) => {
    setConfirmAction(null);
    if (a.kind === 'forward') { setForwarding(true); return; }
    setActionBusy(a.key);
    try {
      if (a.kind === 'accept') await answerForward(header.ticketId, true);
      else if (a.kind === 'reject') await answerForward(header.ticketId, false);
      else if (a.kind === 'cancel') await cancelForward(header.ticketId);
      else if (a.kind === 'leave') await leaveTicket(header.ticketId);
      else await changeTicketState(header.ticketId, a.action);
      onTicketChange?.(item.id);
      // a rejected copy is deleted, or the caller left: he is no longer in it
      if (a.kind === 'reject' || a.kind === 'leave') { if (onLeave) onLeave(item.id); else onClose?.(); return; }
      stickBottom.current = true;
      fullLoad(true);
    } catch (err) { flash(err.message || 'Could not change the ticket.'); }
    finally { setActionBusy(null); }
  };

  const actions = {
    onReply: (m) => { setEditing(null); setReplyTo(m); inputRef.current?.focus(); },
    onCopy: (m) => {
      navigator.clipboard?.writeText(m.text).then(() => flash('Message copied'), () => flash('Copy is blocked in this browser'));
    },
    onEdit: (m) => {
      setReplyTo(null); setEditing(m);
      if (m.html) {
        openRich(sanitizeForSend(m.html));   // a formatted message is edited in the pop-up
      } else {
        setDraft(m.text);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    },
    onDelete: (m) => setConfirmDel(m),
    onRetry: (m) => {
      const p = pending.find(x => x.localId === m.localId);
      if (p) (p.kind === 'file' ? tryFile(p) : trySend(p));
    },
  };
  const cancelBar = () => { if (editing) clearComposer(); setEditing(null); setReplyTo(null); };
  // the formatted-text pop-up: opens with what was typed (or the message being edited)
  function openRich(html = null) {
    const text = draft;
    setRichOpen(true);
    setTimeout(() => {
      richRef.current?.setHtml(html || '');
      richRef.current?.focus();
      if (!html && text) document.execCommand('insertText', false, text);
    }, 0);
  }
  // closed without sending: the text goes back to the plain box, so nothing is lost
  // a table / picture pasted into the editor: preview it, then send it as a file
  const onPasteImage = (file) => {
    const problem = checkFile(file);
    if (problem) { flash(problem); return; }
    setPasted(old => { if (old) URL.revokeObjectURL(old.url); return { file, url: URL.createObjectURL(file) }; });
  };
  const closePasted = () => {
    setPasted(old => { if (old) URL.revokeObjectURL(old.url); return null; });
    setTimeout(() => richRef.current?.focus(), 0);
  };

  const closeRich = () => {
    const { text } = readComposer(true);
    setRichOpen(false);
    if (editing?.html) { setEditing(null); setDraft(''); }
    else setDraft(text);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

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
    ? [header?.broadcast ? 'Broadcast · everyone' : header ? `${header.memberCount} member${header.memberCount === 1 ? '' : 's'}` : null,
       header?.locked ? 'Only admins can send' : null]
    // job · department (UserJobMaster / UserDepartmentMaster); @username until a job is set
    : [header?.jobTitle || item.jobTitle || (header?.username ? `@${header.username}` : null), headerOnline ? 'Online' : null];

  const shown = [
    ...state.messages,
    ...pending.map(p => ({
      id: `p-${p.localId}`, localId: p.localId, sortId: Infinity, mine: true, at: p.at, text: p.text,
      reply: p.reply, pending: p.status, adminNote: p.adminOnly, html: p.html,
      upload: p.kind === 'file' ? { name: p.file.name, size: p.file.size, progress: p.progress, stage: p.stage, error: p.error } : null,
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

  const tone = TICKET_TONE[header?.state] || ['var(--text2)', 'var(--soft)'];
  const ticketHeaderBody = (
    <>
      <span style={{
        flex: '0 0 44px', width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: tone[1], border: `1.5px solid ${tone[0]}`, color: tone[0],
      }}><Hash size={22} strokeWidth={1.8} /></span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'left' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
          <span dir="auto" style={{ padding: '2px 7px', borderRadius: 6, background: 'var(--soft)' }}># {header?.channel || item.raw?.ChannelName || ''}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>#{item.raw?.TicketID}</span>
          {(header?.stateLabel || item.state) && (
            <span style={{ padding: '1px 9px', borderRadius: 999, background: tone[1], color: tone[0], fontSize: 11, fontWeight: 700 }}>
              {header?.stateLabel || item.state}
            </span>
          )}
          {header && <SlaBadge sla={header.sla} state={header.state} />}
        </span>
        <span style={{ fontSize: 18, lineHeight: 1.35, fontWeight: 800, color: 'var(--text)', overflowWrap: 'anywhere' }} dir="auto">{header?.title || item.title}</span>
        {header?.createdBy && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px 16px', flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span>Created by <bdi style={{ fontWeight: 700, color: 'var(--text2)' }}>{header.createdBy}</bdi></span>
              {header.createdByJobTitle && <span dir="auto" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{header.createdByJobTitle}</span>}
            </span>
            {header.createdAt && <span style={{ fontSize: 11 }}>
              {header.createdAt.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>}
          </span>
        )}
      </span>
    </>
  );
  const ticketActions = isTicket && header ? TICKET_ACTIONS.filter(a => header.can[a.can || a.key]) : [];
  // the state buttons the caller may use, shown in the ticket details panel
  const ticketActionsNode = ticketActions.length > 0 && (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {ticketActions.map(a => {
        const Icon = a.icon;
        const asking = confirmAction?.key === a.key;
        return asking ? (
          <div key={a.key} role="group" aria-label={`Confirm ${a.label}`} style={{
            flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 10,
            background: 'var(--red-soft)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>{a.confirm}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => runTicketAction(a)} style={actionButton(true)}>{a.confirmLabel}</button>
              <button onClick={() => setConfirmAction(null)} style={actionButton(false)}>Back</button>
            </span>
          </div>
        ) : (
          <button key={a.key} disabled={!!actionBusy} onClick={() => (a.confirm ? setConfirmAction(a) : runTicketAction(a))}
            style={{ ...actionButton(a.primary), opacity: actionBusy && actionBusy !== a.key ? 0.5 : 1 }}>
            <Icon size={15} /> {actionBusy === a.key ? `${a.label}…` : a.label}
          </button>
        );
      })}
    </div>
  );

  const headerBody = isTicket ? ticketHeaderBody : (
    <>
      <Avatar name={otherName} size={44} photoUrl={photoUrl} online={headerOnline} />
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }} dir="auto">{otherName}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          {isGroup && (header?.broadcast ? <Megaphone size={12} /> : header?.locked ? <Lock size={12} /> : <Users size={12} />)}
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
        {multi ? (
          // the group / ticket header opens the details panel (members)
          <button onClick={() => { if (!isSelectingText()) setShowInfo(v => !v); }} aria-expanded={showInfo}
            aria-label={`${otherName}: ${showInfo ? 'hide' : 'show'} ${isTicket ? 'ticket details' : 'group info'}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, padding: '4px 8px', margin: '-4px -8px',
              border: 'none', borderRadius: 12, background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--font)',
            }}>{headerBody}</button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>{headerBody}</div>
        )}
        {isTicket && header?.ticketId && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <AssignButton ticketId={header.ticketId} assignee={header.assignee} can={header.can} meId={header.me}
              onChange={(assignee) => {
                setState(s => ({ ...s, header: s.header ? { ...s.header, assignee } : s.header }));
                stickBottom.current = true;
                fullLoad(true);              // the system line + the new Take / Unassign rights
                onTicketChange?.(item.id);   // lists show the new owner
              }} />
            <FlagButton ticketId={header.ticketId} flag={header.flag} openSignal={flagPanel} onChange={(flag) => {
              setState(s => ({ ...s, header: s.header ? { ...s.header, flag } : s.header }));
              onFlagChange?.(item.id, flag);
            }} />
          </span>
        )}
        {onClose && (
          <button onClick={onClose} aria-label="Close" title="Close" style={{
            marginLeft: isTicket && header?.ticketId ? 0 : 'auto', flexShrink: 0, width: 40, height: 40, borderRadius: 10,
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        )}
      </header>

      {/* the caller's own flag note, pinned like a message (only he sees it) */}
      {isTicket && header?.flag && <FlagPin flag={header.flag} onEdit={() => setFlagPanel(n => n + 1)} />}
      {isTicket && header?.state === 3 && header.originalTicketId > 0 && (
        // a forwarded copy waiting for approval: the messages below are the original's (read-only)
        <div role="note" style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 24px', fontSize: 13,
          background: 'var(--amber-soft)', color: 'var(--text)', borderBottom: '1px solid var(--border)',
        }}>
          <Forward size={16} style={{ color: 'var(--amber)', flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            Forwarded from <b dir="auto"># {header.forwardedFrom || 'another channel'}</b> (Ticket #{header.originalTicketId}).
            This is its conversation so far, admins-only notes left out.
            {header.can.answerForward ? ' Accept to take it over, or reject to send it back.' : ' It waits for this channel\'s admins or team leaders.'}
          </span>
        </div>
      )}
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
            onMenu={setMenuFor} actions={actions} isGroup={multi} canChange={canWrite || (isTicket && header?.state < 50)} online={isOnline}
            entity={entity} onView={setViewing} />
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

      {isTicket && adminOnly && canWrite && (
        <div role="status" style={{
          flexShrink: 0, padding: '8px 24px', background: 'var(--amber-soft)', borderTop: '1px solid var(--border)',
          color: 'var(--amber)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6,
        }}><ShieldAlert size={14} /> Only ticket admins will see this message. It won't start the ticket.</div>
      )}
      {!canWrite ? (
        <div style={{
          flexShrink: 0, padding: '16px 24px', background: 'var(--surface)', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text2)', fontSize: 13,
        }}><Lock size={16} /> {isTicket
          ? (header?.state === 50 ? 'This ticket is closed.'
            : `Messages are paused while the ticket is ${(header?.stateLabel || 'not open').toLowerCase()}.${header?.can.reopen ? ' Reopen it to continue.' : ''}`)
          : 'Only admins can send messages in this group.'}</div>
      ) : (
      <form onSubmit={submit} style={{
        flexShrink: 0, padding: '12px 24px 16px', background: 'var(--surface)', borderTop: bar ? 'none' : '1px solid var(--border)',
        display: 'flex', alignItems: 'flex-end', gap: 10,
      }}>
        <input ref={fileInputRef} type="file" multiple accept={ACCEPT} onChange={pickFiles} hidden />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={state.status !== 'ready'}
          aria-label="Attach files" title="Attach files (PDF, images, Word, Excel, PowerPoint, TXT, CSV · up to 50 MB)" style={{
          width: 44, height: 44, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
        }}><Paperclip size={20} /></button>
        {isTicket && header?.can.adminNote && (
          <button type="button" onClick={() => setAdminOnly(v => !v)} aria-pressed={adminOnly} title="Admins-only note" style={{
            height: 44, padding: '0 12px', borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
            border: `1.5px solid ${adminOnly ? 'var(--amber)' : 'var(--border)'}`, background: adminOnly ? 'var(--amber-soft)' : 'var(--surface)',
            color: adminOnly ? 'var(--amber)' : 'var(--text2)', fontWeight: 700, fontSize: 12, fontFamily: 'var(--font)', cursor: 'pointer',
          }}><ShieldAlert size={16} /> Admins only</button>
        )}
        <button type="button" onClick={() => openRich()} disabled={state.status !== 'ready'} aria-haspopup="dialog"
          aria-label="Formatted text" title="Formatted text (bold, lists…)" style={{
            width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer',
          }}><Type size={20} /></button>
        <label htmlFor="chat-composer" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Message</label>
        <textarea id="chat-composer" ref={inputRef} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={onKeyDown}
          disabled={state.status !== 'ready'} dir="auto"
          placeholder={editing ? 'Edit your message…' : `Message ${otherName.split(' ')[0]}…`} style={{
            flex: 1, minWidth: 0, minHeight: 44, maxHeight: 132, resize: 'none', padding: '11px 16px', borderRadius: 12,
            border: `1.5px solid ${editing ? 'var(--accent)' : isTicket && adminOnly ? 'var(--amber)' : 'var(--border)'}`,
            background: isTicket && adminOnly ? 'var(--amber-soft)' : 'var(--soft)', fontSize: 14,
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
      {viewing && <ImageViewer image={viewing} onClose={closeViewer} />}
      {forwarding && header && (
        <ForwardDialog ticketId={header.ticketId} channelId={header.channelId} categoryId={header.categoryId}
          onClose={() => setForwarding(false)}
          onDone={() => { setForwarding(false); stickBottom.current = true; fullLoad(true); onTicketChange?.(item.id); flash('Ticket forwarded. It waits for the other channel to accept it.'); }} />
      )}
      {pasted && <PastePreview image={pasted} onCancel={closePasted}
        onSend={() => { const f = pasted.file; closePasted(); sendFiles([f]); }} />}
      {richOpen && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 45, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.45)' }} />
          <div role="dialog" aria-modal="true" aria-labelledby="rich-title" style={{
            position: 'relative', width: 'min(720px, 100%)', maxHeight: '92%', display: 'flex', flexDirection: 'column', gap: 12,
            padding: 20, borderRadius: 16, background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Type size={18} style={{ color: 'var(--accent-strong)' }} />
              <h2 id="rich-title" style={{ flex: 1, margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>
                {editing ? 'Edit formatted message' : 'Formatted message'}
              </h2>
              <button onClick={closeRich} aria-label="Close" style={{
                width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}><X size={18} /></button>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text2)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span dir="auto">To {isTicket ? `# ${header?.channel || ''} · ${header?.title || otherName}` : otherName}</span>
              {replyTo && !editing && (
                <span dir="auto" style={{ padding: '4px 10px', borderInlineStart: '3px solid var(--accent)', background: 'var(--soft)', borderRadius: 6,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Replying to {replyTo.mine ? 'yourself' : (replyTo.from?.name || otherName)}: {replyTo.text}
                </span>
              )}
              {isTicket && adminOnly && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--amber)', fontWeight: 700 }}>
                  <ShieldAlert size={14} /> Admins-only note: only ticket admins will see it.
                </span>
              )}
            </div>
            <RichComposer ref={richRef} disabled={busy} onSubmit={() => submit(null, true)} onEscape={closeRich}
              onPasteImage={editing || !canWrite ? undefined : onPasteImage}
              onEmptyChange={setRichEmpty} minHeight={200} maxHeight={420} hint={false}
              accent={isTicket && adminOnly ? 'var(--amber)' : 'var(--border)'}
              placeholder={editing ? 'Edit your message…' : `Message ${otherName.split(' ')[0]}…`} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>Enter adds a line · Ctrl + Enter sends</span>
              <button onClick={closeRich} disabled={busy} style={{
                height: 40, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)',
                color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
              }}>Cancel</button>
              <button onClick={() => submit(null, true)} disabled={richEmpty || busy} style={{
                height: 40, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
                fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                opacity: richEmpty || busy ? 0.5 : 1,
              }}>{editing ? <><Check size={16} /> Save</> : <><Send size={16} /> Send</>}</button>
            </div>
          </div>
        </div>
      )}
      {confirmDel && <ConfirmDelete m={confirmDel} busy={busy} isGroup={multi} onCancel={() => setConfirmDel(null)} onConfirm={doDelete} />}
    </main>
    {isTicket && showInfo && (
      <TicketInfoPanel ticketId={item.raw?.TicketID} header={header} isOnline={isOnline} actions={ticketActionsNode}
        entity={entity} onView={setViewing} onClose={() => setShowInfo(false)}
        onMembersChange={() => { stickBottom.current = true; fullLoad(true); onTicketChange?.(item.id); }} />
    )}
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
        }}
        onMembersChange={({ memberCount, system }) => {
          stickBottom.current = !!system;
          setState(s => ({
            ...s, header: s.header ? { ...s.header, memberCount: memberCount || s.header.memberCount } : s.header,
            messages: system ? [...s.messages.filter(x => x.id !== system.id), system].sort(bySort) : s.messages,
          }));
          if (system) onActivity?.(item.id, { preview: system.text, at: system.at });
        }}
        onLeft={() => onLeave?.(item.id)} />
    )}
    </div>
  );
}
