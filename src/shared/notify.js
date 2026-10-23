// Desktop notifications while Sila is open in a tab (the browser's
// Notification API; nothing when the tab is closed -- that needs web push).
// The user turns them on once (Chrome asks for permission); the choice is
// kept per browser. HomeShell calls notifyMessage() when a conversation gains
// unread messages that the user is not looking at.
//
//   notifyState()          'unsupported' | 'blocked' | 'off' | 'on' | 'ask'
//   enableNotify()         asks for permission (from a click), turns them on
//   disableNotify()        turns them off (the permission stays with the browser)
//   notifyMessage({...})   shows one notification; tag collapses repeats per conversation
import { useSyncExternalStore } from 'react';

const KEY = 'silaNotify';   // '1' on, '0' off, missing = never chosen
const listeners = new Set();
const changed = () => listeners.forEach(fn => fn());

const pref = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const setPref = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: not remembered */ } };

export function notifyState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission === 'granted') return pref() === '0' ? 'off' : 'on';
  return pref() === '0' ? 'off' : 'ask';
}

export function useNotifyState() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, notifyState);
}

export async function enableNotify() {
  if (notifyState() === 'unsupported') return 'unsupported';
  setPref('1');
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* old Safari: callback form only */ }
  }
  changed();
  return notifyState();
}

export function disableNotify() {
  setPref('0');
  changed();
}

// One notification. onOpen runs when it is clicked (the tab is focused first).
export function notifyMessage({ id, title, body, onOpen }) {
  if (notifyState() !== 'on') return;
  try {
    const n = new Notification(title, {
      body: String(body || '').slice(0, 180), tag: `sila-${id}`, renotify: true, silent: false,
    });
    n.onclick = () => { window.focus(); n.close(); onOpen?.(); };
  } catch { /* the browser refused (e.g. a mobile browser that only allows service-worker notifications) */ }
}
