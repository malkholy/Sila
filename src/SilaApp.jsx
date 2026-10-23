import React, { useCallback, useEffect, useState } from 'react';
import { restore, logout } from './shared/auth.js';
import { connectLive, disconnectLive } from './shared/live.js';
import { clearChatCache } from './shared/chatCache.js';
import { clearDirectory } from './shared/chat.js';
import { clearBoardCache } from './pages/sila/ChannelsBoard.jsx';
import LoginPage from './pages/sila/LoginPage.jsx';
import HomeShell from './pages/sila/HomeShell.jsx';
import UpdateGate from './pages/sila/UpdateGate.jsx';

// Sila web app: sign-in (SilaApi /api/v2/auth) -> Home shell. A stored session
// is restored on reload; the live socket runs while signed in. UpdateGate
// covers every screen once a newer build is published.
export default function SilaApp() {
  const [signedIn, setSignedIn] = useState(false);
  return (
    <>
      <Screens onSignedInChange={setSignedIn} />
      <UpdateGate signedIn={signedIn} />
    </>
  );
}

function Screens({ onSignedInChange }) {
  const [user, setUser] = useState(null);
  const [phase, setPhase] = useState('restoring');   // restoring | signed-out | signed-in | offline

  const start = useCallback((u) => {
    setUser(u);
    setPhase('signed-in');
    connectLive();
  }, []);

  const tryRestore = useCallback(() => {
    setPhase('restoring');
    restore()
      .then(u => (u ? start(u) : setPhase('signed-out')))
      .catch(() => setPhase('offline'));   // server unreachable: keep the session, offer a retry
  }, [start]);

  useEffect(() => { tryRestore(); }, [tryRestore]);

  // The session ended elsewhere (logout on another tab, password change, expiry).
  useEffect(() => {
    const ended = () => { disconnectLive(); clearChatCache(); clearBoardCache(); clearDirectory(); setUser(null); setPhase('signed-out'); };
    window.addEventListener('sila:signed-out', ended);
    return () => window.removeEventListener('sila:signed-out', ended);
  }, []);

  const signOut = useCallback(async () => {
    disconnectLive();
    clearChatCache(); clearBoardCache(); clearDirectory();
    setUser(null);
    setPhase('signed-out');
    await logout();
  }, []);

  useEffect(() => { onSignedInChange(phase === 'signed-in'); }, [phase, onSignedInChange]);

  if (phase === 'restoring' || phase === 'offline') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, background: 'var(--bg)', color: 'var(--muted)', fontFamily: 'var(--font)', padding: 16, textAlign: 'center',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 15, background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 800,
          fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>S</div>
        {phase === 'restoring' ? 'Loading Sila…' : (
          <>
            <div>Can't reach the Sila server. Check your connection.</div>
            <button onClick={tryRestore} style={{
              height: 40, padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--accent)',
              color: 'var(--on-accent)', fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
            }}>Try again</button>
          </>
        )}
      </div>
    );
  }
  if (phase === 'signed-out' || !user) return <LoginPage onSignedIn={start} />;
  return <HomeShell user={user} onSignOut={signOut} />;
}
