import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { formatSize, loadTicketMedia } from '../../shared/chat.js';
import { downloadFile, fileBlobUrl, isFilesApiUrl, saveAttachment } from '../../shared/files.js';

// "Media, links and docs" in the ticket details panel (design/mockups/MediaPanel.dc.html):
// tabs Media / Docs / Links with counts, each list grouped by month, newest
// first. Data: 'Ticket media' (CHA.APISilaWebTicketOperation). Images open in
// the conversation's image viewer (onView), docs download with the user's token
// (Files API) or open as a plain link (older files), links open in a new tab.

const GRID_FIRST = 9;   // thumbnails shown before "Show all"

const monthOf = (d) => (d ? d.toLocaleDateString([], { month: 'long', year: 'numeric' }) : 'Earlier');
function byMonth(list) {
  const out = [];
  for (const x of list) {
    const m = monthOf(x.at);
    if (!out.length || out[out.length - 1].month !== m) out.push({ month: m, items: [] });
    out[out.length - 1].items.push(x);
  }
  return out;
}
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

function Thumb({ item, entity, onView }) {
  const { file } = item;
  const stored = isFilesApiUrl(file.url);
  const [src, setSrc] = useState(stored ? '' : file.url);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!stored) return undefined;
    let alive = true;
    fileBlobUrl({ attachmentId: file.id, ...entity, preview: true })
      .then(url => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [stored, file.id, entity.entityType, entity.entityKey]);
  const open = () => onView?.(stored
    ? { url: src, name: file.name, file: { attachmentId: file.id, ...entity } }
    : { url: file.url, name: file.name, downloadUrl: file.url });
  return (
    <div style={{ position: 'relative' }}>
    <button type="button" onClick={open} disabled={!src && !failed} aria-label={`View image ${file.name}`}
      title={`${file.name}${item.from ? ` · ${item.from}` : ''}`} style={{
        position: 'relative', aspectRatio: '1 / 1', width: '100%', padding: 0, border: 'none', borderRadius: 8,
        overflow: 'hidden', background: 'var(--soft)', cursor: 'zoom-in', display: 'block',
      }}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
          <ImageIcon size={18} />
        </span>
      )}
    </button>
    <button type="button" onClick={() => saveAttachment({ file, entity: stored ? entity : null }).catch(() => {})}
      aria-label={`Download ${file.name}`} title={`Download ${file.name}`} style={{
        position: 'absolute', left: 4, bottom: 4, width: 26, height: 26, borderRadius: 7, border: 'none',
        background: 'rgba(15,23,42,.6)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
      }}><Download size={13} /></button>
    </div>
  );
}

function DocRow({ item, entity }) {
  const { file } = item;
  const stored = isFilesApiUrl(file.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const onClick = stored ? async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await downloadFile({ attachmentId: file.id, ...entity }, file.name); }
    catch (err) { setError(err.message || 'Could not open the file.'); }
    finally { setBusy(false); }
  } : undefined;
  const meta = [formatSize(file.size) || file.sizeText, item.from, item.at?.toLocaleDateString([], { day: 'numeric', month: 'short' })]
    .filter(Boolean).join(' · ');
  return (
    <a href={stored ? '#' : file.url} onClick={onClick} target={stored ? undefined : '_blank'} rel="noopener noreferrer" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 8, textDecoration: 'none', color: 'var(--text)',
    }}>
      <span style={{
        width: 34, height: 38, borderRadius: 6, background: 'var(--accent-strong)', color: 'var(--on-accent)', fontSize: 10,
        fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>{(file.ext || 'file').slice(0, 4).toUpperCase()}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} dir="auto">{file.name}</span>
        <span style={{ fontSize: 11.5, color: error ? 'var(--red)' : 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {error || (busy ? 'Downloading…' : meta)}
        </span>
      </span>
      <span role="button" tabIndex={0} aria-label={`Download ${file.name}`} title="Download"
        onClick={async (e) => {
          e.preventDefault(); e.stopPropagation();
          setBusy(true); setError('');
          try { await saveAttachment({ file, entity: stored ? entity : null }); }
          catch (err) { setError(err.message || 'Could not download the file.'); }
          finally { setBusy(false); }
        }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
        style={{
          width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border)', color: 'var(--text2)', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><Download size={14} /></span>
    </a>
  );
}

function LinkRow({ item }) {
  return (
    <a href={item.url} target="_blank" rel="noopener noreferrer" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderRadius: 8, textDecoration: 'none', color: 'var(--text)',
    }}>
      <span style={{
        width: 34, height: 34, borderRadius: 8, background: 'var(--blue-soft)', color: 'var(--blue)', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><ExternalLink size={16} /></span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-strong)' }}>{host(item.url)}</span>
        <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {[item.url, item.from].filter(Boolean).join(' · ')}
        </span>
      </span>
    </a>
  );
}

export default function MediaSection({ ticketId, entity, onView, heading }) {
  const [state, setState] = useState({ status: 'loading', media: [], docs: [], links: [], error: '' });
  const [tab, setTab] = useState('media');
  const [all, setAll] = useState(false);
  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, status: 'loading', error: '' }));
    loadTicketMedia(ticketId)
      .then(lib => {
        if (!alive) return;
        setState({ status: 'ready', ...lib, error: '' });
        setTab(lib.media.length ? 'media' : lib.docs.length ? 'docs' : lib.links.length ? 'links' : 'media');
      })
      .catch(err => { if (alive) setState(s => ({ ...s, status: 'error', error: err.message || 'Could not load the files.' })); });
    return () => { alive = false; };
  }, [ticketId]);

  const tabs = [['media', 'Media', state.media.length], ['docs', 'Docs', state.docs.length], ['links', 'Links', state.links.length]];
  const total = state.media.length + state.docs.length + state.links.length;
  const list = state[tab];
  const shown = tab === 'media' && !all ? list.slice(0, GRID_FIRST) : list;

  return (
    <>
      {heading(`Media, links and docs${state.status === 'ready' ? ` · ${total}` : ''}`)}
      {state.status === 'loading' && <div role="status" style={{ padding: '6px 0', fontSize: 13, color: 'var(--muted)' }}>Loading files…</div>}
      {state.status === 'error' && <div role="alert" style={{ padding: '6px 0', fontSize: 13, color: 'var(--red)' }}>{state.error}</div>}
      {state.status === 'ready' && total === 0 && (
        <div style={{ padding: '6px 0', fontSize: 13, color: 'var(--muted)' }}>No media, links or docs yet.</div>
      )}
      {state.status === 'ready' && total > 0 && (
        <div style={{ paddingTop: 4 }}>
          <div role="tablist" aria-label="Attachment type" style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', borderBottom: '1px solid var(--border)', marginBottom: 8,
          }}>
            {tabs.map(([key, label, count]) => {
              const on = key === tab;
              return (
                <button key={key} role="tab" aria-selected={on} onClick={() => { setTab(key); setAll(false); }} style={{
                  height: 36, border: 'none', borderBottom: `3px solid ${on ? 'var(--accent)' : 'transparent'}`, background: 'transparent',
                  color: on ? 'var(--accent-strong)' : 'var(--text2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
                }}>{label} · {count}</button>
              );
            })}
          </div>
          {list.length === 0 && (
            <div style={{ padding: '4px 0', fontSize: 13, color: 'var(--muted)' }}>
              {tab === 'media' ? 'No photos yet.' : tab === 'docs' ? 'No documents yet.' : 'No links yet.'}
            </div>
          )}
          {byMonth(shown).map(g => (
            <div key={g.month} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', padding: '4px 0 6px' }}>{g.month}</div>
              {tab === 'media' ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
                  {g.items.map(x => <Thumb key={`${x.chatId}-${x.file.id}`} item={x} entity={entity} onView={onView} />)}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {g.items.map((x, i) => (tab === 'docs'
                    ? <DocRow key={`${x.chatId}-${x.file.id}`} item={x} entity={entity} />
                    : <LinkRow key={`${x.chatId}-${i}`} item={x} />))}
                </div>
              )}
            </div>
          ))}
          {tab === 'media' && list.length > GRID_FIRST && (
            <button onClick={() => setAll(a => !a)} style={{
              width: '100%', height: 34, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
            }}>{all ? 'Show fewer' : `Show all ${list.length}`}</button>
          )}
        </div>
      )}
    </>
  );
}
