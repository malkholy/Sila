import React, { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { reloadApp, useNewVersion } from '../../shared/appUpdate.js';

// A newer build was published (version.json, shared/appUpdate.js): everyone
// moves to it. The screen is covered until the user reloads -- old code must
// not keep talking to the new APIs. Nobody is looking (tab in the background)
// or nothing is open (the sign-in page): reload straight away.
export default function UpdateGate({ signedIn }) {
  const newer = useNewVersion();
  useEffect(() => {
    if (!newer) return undefined;
    if (!signedIn || document.visibilityState !== 'visible') { reloadApp(); return undefined; }
    const away = () => { if (document.visibilityState !== 'visible') reloadApp(); };
    document.addEventListener('visibilitychange', away);
    return () => document.removeEventListener('visibilitychange', away);
  }, [newer, signedIn]);
  if (!newer) return null;
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="upd-title" aria-describedby="upd-desc" style={{
      position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(15,23,42,.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'var(--font)',
    }}>
      <div style={{
        width: 'min(420px, 100%)', padding: 24, borderRadius: 16, background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center',
      }}>
        <span style={{
          width: 52, height: 52, borderRadius: 15, background: 'var(--accent-soft)', color: 'var(--accent-strong)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><RefreshCw size={24} /></span>
        <h2 id="upd-title" style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>A new version of Sila is ready</h2>
        <p id="upd-desc" style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}>
          Refresh to continue with version {newer}. Your conversations stay as they are.
        </p>
        <button autoFocus onClick={reloadApp} style={{
          height: 42, padding: '0 22px', marginTop: 4, borderRadius: 10, border: 'none', background: 'var(--accent)',
          color: 'var(--on-accent)', fontWeight: 700, fontSize: 14, fontFamily: 'var(--font)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
        }}><RefreshCw size={16} /> Refresh now</button>
      </div>
    </div>
  );
}
