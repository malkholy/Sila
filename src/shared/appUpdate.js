// "A new version was published": every production build writes version.json
// beside index.html with its number (vite.config.js) and bakes the same number
// into the app (api.js APP_VERSION). The running app reads version.json from
// the server -- never from a cache -- every 2 minutes and whenever the tab
// comes back, and reports a newer number once. Dev (vite serve) has no
// version.json: nothing is checked.
import { useEffect, useState } from 'react';
import { APP_VERSION } from './api.js';

const EVERY_MS = 2 * 60_000;

async function publishedVersion() {
  const url = new URL('version.json', document.baseURI);
  url.searchParams.set('t', String(Date.now()));   // past any proxy that ignores no-store
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return 0;
  return Number((await res.json())?.version) || 0;
}

// The published number when it is newer than this build's, else 0.
export function useNewVersion() {
  const [newer, setNewer] = useState(0);
  useEffect(() => {
    if (import.meta.env.DEV) return undefined;
    const mine = Number(APP_VERSION) || 0;
    let stopped = false;
    const check = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      publishedVersion()
        .then(v => { if (!stopped && v > mine) setNewer(v); })
        .catch(() => { /* offline: next time */ });
    };
    check();
    const timer = setInterval(check, EVERY_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, []);
  return newer;
}

// A fresh index.html (web.config sends it with no-cache) and so the new assets.
export function reloadApp() { window.location.reload(); }
