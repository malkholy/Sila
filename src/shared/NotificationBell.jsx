import { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, X } from 'lucide-react';
import { apiCall } from './api.js';

const NOTIF_SP = 'Pls.APINotificationV1';
const POLL_MS = 50000;

const timeAgo = (iso) => {
  if (!iso) return '';
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return '';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

// Opens the entity a notification points to. Pages that own a drawer/detail
// view subscribe with window.addEventListener('plusv1:open-entity', ...) and
// check e.detail.pageGroupId against their own def.id.
export function openNotificationEntity(pageGroupId, keyField, keyValue) {
  window.dispatchEvent(new CustomEvent('plusv1:open-entity', { detail: { pageGroupId, keyField, keyValue } }));
}

// The bell lives in the sidebar footer, which is always dark (its own fixed
// navy palette -- see .sb-btn / .sb-profile in src/index.css) regardless of
// the light/dark theme toggle. So the trigger + dropdown match that palette
// (rgba-on-navy) instead of the theme-toggled var(--surface)/var(--text)
// tokens, which would render a stray white card on the dark sidebar in
// light mode. Only the orange accent (unread dot, link colour) is shared
// with the rest of the app, since it's theme-agnostic everywhere already.
const PANEL_BG = '#1c2536';

const PANEL_W = 320;

export default function NotificationBell({ user, onNavigateToPage }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [panelPos, setPanelPos] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const seenIds = useRef(new Set());
  const boxRef = useRef(null);

  const pushToast = (n) => {
    setToasts(t => [...t, n]);
    setTimeout(() => setToasts(t => t.filter(x => x.NotificationID !== n.NotificationID)), 5000);
  };

  const refreshCount = useCallback(async () => {
    try {
      const r = await apiCall('GetNotificationCount', {}, {}, { spName: NOTIF_SP });
      const row = (r.List0 || [])[0];
      const newCount = row ? Number(row.UnreadCount) || 0 : 0;
      if (newCount > unread) {
        const lr = await apiCall('GetNotifications', { Top: 10 }, {}, { spName: NOTIF_SP });
        const rows = lr.List0 || [];
        for (const row2 of rows) {
          if (!row2.IsRead && !seenIds.current.has(row2.NotificationID)) {
            seenIds.current.add(row2.NotificationID);
            pushToast(row2);
          }
        }
      }
      setUnread(newCount);
    } catch { /* silent -- polling should never break the app */ }
  }, [unread]);

  useEffect(() => {
    if (!user) return;
    refreshCount();
    const t = setInterval(refreshCount, POLL_MS);
    const onFocus = () => refreshCount();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiCall('GetNotifications', { Top: 30 }, {}, { spName: NOTIF_SP });
      setItems(r.List0 || []);
    } catch { setItems([]); }
    setLoading(false);
  }, []);

  const toggleOpen = () => {
    const next = !open;
    if (next && boxRef.current) {
      const r = boxRef.current.getBoundingClientRect();
      setPanelPos({
        left: Math.min(r.left, window.innerWidth - PANEL_W - 12),
        bottom: window.innerHeight - r.top + 10,
      });
    }
    setOpen(next);
    if (next) loadList();
  };

  const markRead = async (n) => {
    if (!n.IsRead) {
      setItems(list => list.map(x => x.NotificationID === n.NotificationID ? { ...x, IsRead: 1 } : x));
      setUnread(c => Math.max(0, c - 1));
      apiCall('MarkNotificationRead', { NotificationID: n.NotificationID }, {}, { spName: NOTIF_SP }).catch(() => {});
    }
  };

  const markAllRead = async () => {
    setItems(list => list.map(x => ({ ...x, IsRead: 1 })));
    setUnread(0);
    apiCall('MarkAllRead', {}, {}, { spName: NOTIF_SP }).catch(() => {});
  };

  const deleteRow = (n, e) => {
    e.stopPropagation();
    setItems(list => list.filter(x => x.UserNotificationID !== n.UserNotificationID));
    if (!n.IsRead) setUnread(c => Math.max(0, c - 1));
    apiCall('DeleteNotification', { UserNotificationID: n.UserNotificationID }, {}, { spName: NOTIF_SP }).catch(() => {});
  };

  const openRow = (n) => {
    markRead(n);
    setOpen(false);
    onNavigateToPage?.(n.PageGroupID);
    setTimeout(() => openNotificationEntity(n.PageGroupID, n.KeyField, n.KeyValue), 60);
  };

  return (
    <div ref={boxRef} style={{ position: 'relative', flex: 'none' }}>
      <button
        onClick={toggleOpen}
        title="Notifications"
        style={{
          position: 'relative', width: 30, height: 30, border: '1px solid rgba(255,255,255,.1)', borderRadius: 8,
          background: open ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.05)', color: open ? '#fff' : 'rgba(255,255,255,.65)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s',
        }}
      >
        <Bell size={14} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, minWidth: 15, height: 15, padding: '0 3px',
            borderRadius: 8, background: 'var(--orange)', color: '#fff', fontSize: 9.5, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            boxShadow: '0 0 0 2px ' + PANEL_BG,
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && panelPos && (
        <div style={{
          position: 'fixed', bottom: panelPos.bottom, left: panelPos.left, width: PANEL_W, maxHeight: 420,
          background: PANEL_BG, border: '1px solid rgba(255,255,255,.08)', borderRadius: 12,
          boxShadow: '0 16px 40px rgba(0,0,0,.5)', zIndex: 3000, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 14px', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: '#fff' }}>Notifications</span>
            {unread > 0 && (
              <button onClick={markAllRead} style={{ background: 'none', border: 'none', color: 'var(--orange)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                Mark all read
              </button>
            )}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && <div style={{ padding: 20, textAlign: 'center', color: 'rgba(255,255,255,.45)', fontSize: 12 }}>Loading…</div>}
            {!loading && items.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,.45)', fontSize: 12 }}>You're all caught up</div>
            )}
            {!loading && items.map(n => (
              <div
                key={n.NotificationID}
                onClick={() => openRow(n)}
                onMouseEnter={e => { setHoverId(n.UserNotificationID); e.currentTarget.style.background = n.IsRead ? 'rgba(255,255,255,.04)' : 'color-mix(in srgb, var(--orange) 14%, transparent)'; }}
                onMouseLeave={e => { setHoverId(null); e.currentTarget.style.background = n.IsRead ? 'transparent' : 'color-mix(in srgb, var(--orange) 8%, transparent)'; }}
                style={{
                  padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,.06)', cursor: 'pointer',
                  background: n.IsRead ? 'transparent' : 'color-mix(in srgb, var(--orange) 8%, transparent)',
                  display: 'flex', gap: 8, alignItems: 'flex-start', transition: 'background .1s',
                }}
              >
                {!n.IsRead && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--orange)', marginTop: 5, flex: 'none' }} />}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: n.IsRead ? 500 : 700, color: n.IsRead ? 'rgba(255,255,255,.75)' : '#fff' }}>{n.Title}</div>
                  {n.Body && <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.5)', marginTop: 2 }}>{n.Body}</div>}
                  <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.35)', marginTop: 3 }}>{timeAgo(n.RaisedDate)}</div>
                </div>
                <button
                  onClick={e => deleteRow(n, e)}
                  title="Delete"
                  style={{
                    flex: 'none', width: 20, height: 20, border: 'none', borderRadius: 5, cursor: 'pointer',
                    background: 'transparent', color: 'rgba(255,255,255,.4)',
                    display: hoverId === n.UserNotificationID ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,.12)'; e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,.4)'; }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 4000, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {toasts.map(n => (
          <div key={n.NotificationID} onClick={() => openRow(n)} style={{
            width: 300, background: PANEL_BG, border: '1px solid rgba(255,255,255,.1)', borderLeft: '3px solid var(--orange)',
            borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.45)', padding: '11px 14px', cursor: 'pointer',
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>{n.Title}</div>
            {n.Body && <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.55)', marginTop: 2 }}>{n.Body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
