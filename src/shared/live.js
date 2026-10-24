// The live channel (SilaApi /api/v2/live). It only says "something changed"
// and who is online; data is always fetched through apiExec afterwards.
//
//   connectLive()      after sign-in (idempotent)
//   disconnectLive()   on sign-out
//   useLive()          React: { status, online:Set, retryAt }
//   onLive(type, fn)   subscribe to one frame type; returns the unsubscribe
//
// Reconnects with backoff (2 s .. 60 s, at once when the network returns).
// The browser's online/offline flag is only a hint (VPNs, Wi-Fi changes and
// sleep make it wrong): it never stops a connection attempt or marks an open
// socket as down -- only the socket itself does.
// Close 4401 = the session ended: refresh once, and if that fails the app is
// signed out ('sila:signed-out' from auth.js).
import { useSyncExternalStore } from 'react';
import { API_BASE, DATABASE, authPost } from './auth.js';

let state = { status: 'idle', online: new Set(), retryAt: null };
const listeners = new Set();
const handlers = new Map();   // type -> Set<fn>
let ws = null;
let wanted = false;
let connecting = false;
let attempts = 0;
let retryTimer = null;

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}

export function useLive() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
}

export function onLive(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type)?.delete(fn);
}

function dispatch(frame) {
  if (frame.type === 'hello') set({ online: new Set((frame.online || []).map(u => u.toLowerCase())) });
  if (frame.type === 'presence' && frame.user) {
    const online = new Set(state.online);
    if (frame.online) online.add(frame.user.toLowerCase()); else online.delete(frame.user.toLowerCase());
    set({ online });
  }
  handlers.get(frame.type)?.forEach(fn => {
    try { fn(frame); } catch (err) { console.error('live handler failed', err); }
  });
}

function scheduleReconnect() {
  if (!wanted) return;
  clearTimeout(retryTimer);
  attempts += 1;
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
  set({ status: 'waiting', retryAt: Date.now() + delay });
  retryTimer = setTimeout(() => { connectLive(); }, delay);
}

export async function connectLive() {
  wanted = true;
  if (connecting) return;
  if (ws && ws.readyState === WebSocket.OPEN) { set({ status: 'connected', retryAt: null }); return; }
  if (ws && ws.readyState === WebSocket.CONNECTING) return;
  connecting = true;
  set({ status: 'connecting', retryAt: null });
  try {
    const { ticket } = await authPost('/api/v2/live/ticket', { database: DATABASE });
    if (!wanted) return;
    const base = (API_BASE || window.location.origin).replace(/^http/, 'ws');
    const socket = new WebSocket(`${base}/api/v2/live?ticket=${encodeURIComponent(ticket)}`);
    ws = socket;
    socket.onopen = () => { attempts = 0; set({ status: 'connected', retryAt: null }); };
    socket.onmessage = e => {
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }
      if (frame && typeof frame.type === 'string') dispatch(frame);
    };
    socket.onclose = () => {
      if (ws !== socket) return;   // replaced by a newer socket (Retry now): not news
      ws = null;
      set({ online: new Set() });
      // 4401 included: the next ticket request refreshes the token, or signs out.
      if (wanted) scheduleReconnect(); else set({ status: 'idle' });
    };
    socket.onerror = () => socket.close();
  } catch (err) {
    // 401 here means the refresh failed: auth.js has signed out already.
    if (err?.status === 401) { wanted = false; set({ status: 'idle' }); return; }
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

// "Retry now", the network coming back, the tab waking up: try at once. A
// socket stuck half-open (no answer since) is dropped so a fresh one opens.
export function retryLiveNow() {
  if (!wanted) return;
  attempts = 0;
  clearTimeout(retryTimer);
  if (ws && ws.readyState !== WebSocket.OPEN) { const old = ws; ws = null; try { old.close(); } catch { /* gone */ } }
  connectLive();
}

export function disconnectLive() {
  wanted = false;
  clearTimeout(retryTimer);
  attempts = 0;
  const socket = ws;
  ws = null;
  socket?.close(1000);
  set({ status: 'idle', online: new Set(), retryAt: null });
}

export function sendLive(frame) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

window.addEventListener('online', () => { if (wanted && state.status !== 'connected') retryLiveNow(); });
// back to the tab after sleep / a long time away: reconnect now instead of waiting out the backoff
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted && state.status === 'waiting') retryLiveNow();
});
