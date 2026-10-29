import React, { useCallback, useEffect, useState } from 'react';
import { restore, logout } from './shared/auth.js';
import { connectLive, disconnectLive } from './shared/live.js';
import { clearChatCache } from './shared/chatCache.js';
import { clearDirectory } from './shared/chat.js';
import { clearBoardCache } from './pages/sila/ChannelsBoard.jsx';
import LoginPage from './pages/sila/LoginPage.jsx';
import HomeShell from './pages/sila/HomeShell.jsx';
import UpdateGate from './pages/sila/UpdateGate.jsx';
import silaLogo from './Assets/sila_logo.png';

// Sila web app: sign-in (SilaApi /api/v2/auth) -> Home shell. A stored session
// is restored on reload; the live socket runs while signed in. UpdateGate
// covers every screen once a newer build is published.
//
// Until the launch only these accounts get past sign-in; everyone else is signed
// out again and told when the site opens. A screen, not security: the APIs still
// check each call.
const OPEN_TO = ['mhd'];
const isOpenTo = (u) => OPEN_TO.includes(String(u?.username || '').toLowerCase());

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
  const [phase, setPhase] = useState('restoring');   // restoring | signed-out | signed-in | offline | not-open

  const start = useCallback((u) => {
    if (!isOpenTo(u)) { setPhase('not-open'); logout(); return; }
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
        }}><img src={silaLogo} alt="Sila" width={36} height={36} style={{ display: 'block' }} /></div>
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
  if (phase === 'not-open') return <NotOpenYet onBack={() => setPhase('signed-out')} />;
  if (phase === 'signed-out' || !user) return <LoginPage onSignedIn={start} />;
  return <HomeShell user={user} onSignOut={signOut} />;
}

function NotOpenYet({ onBack }) {
  return (
    <div role="alert" style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 18, background: 'var(--bg)', fontFamily: 'var(--font)', padding: 16, textAlign: 'center',
    }}>
      <img src={silaLogo} alt="Sila" width={72} height={72} style={{ display: 'block' }} />
      <h1 style={{ margin: 0, fontSize: 'clamp(28px, 6vw, 48px)', fontWeight: 800, color: 'var(--text)', lineHeight: 1.15 }}>
        Sila will be ready within 48 hours
      </h1>
      <p style={{ margin: 0, maxWidth: 520, fontSize: 'clamp(15px, 2.4vw, 19px)', color: 'var(--text2)' }}>
        We are getting the new Sila ready. Please sign in again after that. Thank you for your patience.
      </p>
      <button onClick={onBack} style={{
        height: 42, padding: '0 22px', marginTop: 6, borderRadius: 10, border: 'none', background: 'var(--accent)',
        color: 'var(--on-accent)', fontWeight: 700, fontSize: 14, fontFamily: 'var(--font)', cursor: 'pointer',
      }}>Back to sign-in</button>
    </div>
  );
}
