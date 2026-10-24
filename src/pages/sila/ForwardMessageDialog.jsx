import React, { useEffect, useMemo, useState } from 'react';
import { X, Search, Check, Forward, Hash, Users, Megaphone } from 'lucide-react';
import Avatar from './Avatar.jsx';
import Mark from './Mark.jsx';
import ClearSearch from './ClearSearch.jsx';
import { chatApi, newLocalId } from '../../shared/chat.js';
import { fileBlobUrl, fileEntity, isFilesApiUrl, uploadFile } from '../../shared/files.js';
import { sanitizeForSend } from '../../shared/richText.js';

// Forward a message: pick up to MAX conversations from the Home list (chats,
// groups, open tickets) and send each a copy through its normal operations, so
// every rule still applies there (a locked group, a closed ticket refuse it).
// A Files API file is downloaded and uploaded again to each target -- the
// Files API ties a file to its conversation; an older file (stored link) goes
// as its name and link. Admins-only ticket notes are never forwarded (ChatPane
// hides the option). onDone(sentCount) closes it.
const MAX = 5;
const KINDS = [['all', 'All'], ['chat', 'Chats'], ['group', 'Groups'], ['ticket', 'Tickets']];

export default function ForwardMessageDialog({ message: m, source, items, currentId, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [picked, setPicked] = useState([]);       // items, in pick order
  const [status, setStatus] = useState({});       // item id -> 'sending' | 'sent' | error text
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [busy, onClose]);

  // where a message can go: chats, groups and tickets still taking messages (New / In progress)
  const targets = useMemo(() => items.filter(i => i.id !== currentId && !i.draft
    && (i.kind === 'chat' || i.kind === 'group' || (i.kind === 'ticket' && [0, 1].includes(Number(i.raw?.TicketState))))), [items, currentId]);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = targets.filter(i => (kind === 'all' || i.kind === kind)
    && terms.every(t => [i.title, i.sub, i.state].some(x => x && x.toLowerCase().includes(t)))).slice(0, 200);
  const isPicked = (i) => picked.some(p => p.id === i.id);
  const toggle = (i) => setPicked(list => (isPicked(i) ? list.filter(p => p.id !== i.id) : list.length >= MAX ? list : [...list, i]));

  // one copy into one target: the file first (uploaded again), then the text
  const sendTo = async (target) => {
    const api = chatApi(target);
    const html = m.html ? sanitizeForSend(m.html) : '';
    if (m.file) {
      if (isFilesApiUrl(m.file.url) && source) {
        const url = await fileBlobUrl({ attachmentId: m.file.id, ...source });
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], m.file.name, { type: blob.type });
        const attachmentId = await uploadFile({ file, ...fileEntity(target) });
        await api.sendFile({ attachmentId, localId: newLocalId(), me: 0 });
      } else {
        await api.send({ text: `${m.file.name}\n${m.file.url}`, localId: newLocalId(), me: 0 });
      }
    }
    const text = (m.text || '').trim();
    if (text && !(m.file && text === m.file.name)) await api.send({ text, html, localId: newLocalId(), me: 0 });
  };
  const send = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    let sent = 0;
    for (const t of picked) {
      if (status[t.id] === 'sent') { sent += 1; continue; }
      setStatus(s => ({ ...s, [t.id]: 'sending' }));
      try { await sendTo(t); sent += 1; setStatus(s => ({ ...s, [t.id]: 'sent' })); }
      catch (err) { setStatus(s => ({ ...s, [t.id]: err.message || 'Could not forward here.' })); }
    }
    setBusy(false);
    if (sent === picked.length) onDone(sent);
  };
  const failed = picked.filter(p => status[p.id] && status[p.id] !== 'sent' && status[p.id] !== 'sending');

  const badge = (i) => (i.kind === 'chat'
    ? <Avatar name={i.title} size={36} photoUrl={i.photoUrl} />
    : (
      <span style={{
        flex: '0 0 36px', width: 36, height: 36, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: i.kind === 'ticket' || i.broadcast ? 'var(--accent-soft)' : 'var(--soft)', color: i.kind === 'ticket' || i.broadcast ? 'var(--accent-strong)' : 'var(--text2)',
        border: `1.5px solid ${i.kind === 'ticket' || i.broadcast ? 'var(--accent-line)' : 'var(--border)'}`,
      }}>{i.kind === 'ticket' ? <Hash size={17} /> : i.broadcast ? <Megaphone size={17} /> : <Users size={17} />}</span>
    ));
  const preview = m.file ? m.file.name : (m.text || '').slice(0, 140);

  return (
    <div role="dialog" aria-modal="true" aria-label="Forward message" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        width: 'min(500px, 100%)', maxHeight: 'min(680px, 92vh)', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
        borderRadius: 16, boxShadow: 'var(--shadow-lg)', fontFamily: 'var(--font)', overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 12px 20px', borderBottom: '1px solid var(--border)' }}>
          <Forward size={20} style={{ color: 'var(--accent-strong)' }} aria-hidden="true" />
          <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>Forward message</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 36, height: 36, borderRadius: 18, border: 'none', background: 'transparent', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={18} /></button>
        </div>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div dir="auto" style={{
            padding: '6px 10px', borderRadius: 8, background: 'var(--soft)', borderInlineStart: '3px solid var(--accent)', fontSize: 12,
            color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{preview || 'Message'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderRadius: 10, background: 'var(--bg)', color: 'var(--muted)' }}>
            <Search size={15} />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search people, groups, tickets" aria-label="Search conversations"
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={q} onClear={() => setQ('')} />
          </div>
          <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6 }}>
            {KINDS.map(([k, label]) => {
              const on = k === kind;
              return (
                <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={on} style={{
                  height: 30, padding: '0 11px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 700,
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'var(--surface)',
                  color: on ? 'var(--on-accent)' : 'var(--text2)',
                }}>{label}</button>
              );
            })}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 160, overflowY: 'auto', padding: 8 }}>
          {shown.length === 0 && <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>No conversation matches.</div>}
          {shown.map(i => {
            const on = isPicked(i);
            const st = status[i.id];
            return (
              <button key={i.id} onClick={() => toggle(i)} disabled={busy} aria-pressed={on} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 10, border: 'none',
                background: on ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)',
                opacity: !on && picked.length >= MAX ? 0.5 : 1,
              }}>
                {badge(i)}
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span dir="auto"><Mark text={i.title} terms={terms} /></span>
                  </span>
                  <span style={{ fontSize: 12, color: st && st !== 'sent' && st !== 'sending' ? 'var(--red)' : 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {st === 'sending' ? 'Forwarding…' : st === 'sent' ? 'Forwarded' : st || <span dir="auto"><Mark text={i.sub || i.state || (i.kind === 'group' ? 'Group' : '')} terms={terms} /></span>}
                  </span>
                </span>
                <span aria-hidden="true" style={{
                  width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `2px solid ${on ? 'var(--accent)' : 'var(--border2)'}`, background: on ? 'var(--accent)' : 'transparent', color: 'var(--on-accent)',
                }}>{on && <Check size={14} strokeWidth={3} />}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          <span style={{ flex: 1, fontSize: 13, color: failed.length ? 'var(--red)' : 'var(--text2)' }}>
            {failed.length ? `${failed.length} could not take it — see the reason under each` : picked.length ? `${picked.length} of ${MAX} picked` : `Pick up to ${MAX} conversations`}
          </span>
          <button onClick={onClose} disabled={busy} style={{
            height: 38, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}>{failed.length ? 'Close' : 'Cancel'}</button>
          <button onClick={send} disabled={!picked.length || busy} style={{
            height: 38, padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
            fontWeight: 700, fontSize: 13, cursor: picked.length && !busy ? 'pointer' : 'not-allowed', opacity: picked.length ? 1 : 0.5,
            fontFamily: 'var(--font)', display: 'flex', alignItems: 'center', gap: 6,
          }}><Forward size={15} />{busy ? 'Forwarding…' : failed.length ? 'Try again' : 'Forward'}</button>
        </div>
      </div>
    </div>
  );
}
