import React, { useState } from 'react';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { login } from '../../shared/auth.js';
import silaLogo from '../../Assets/sila_logo.png';

const REMEMBER_KEY = 'sila.rememberUser';

export default function LoginPage({ onSignedIn }) {
  const [username, setUsername] = useState(() => {
    try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; }
  });
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const name = username.trim();
    if (!name || !password) { setError('Enter your username and password.'); return; }
    setBusy(true); setError('');
    try {
      const user = await login(name, password, remember);
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, user.username);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch { /* private mode */ }
      setPassword('');
      onSignedIn(user);
    } catch (err) {
      setError(err.message || 'Sign-in failed.');
      setBusy(false);
    }
  };

  const input = {
    width: '100%', height: 46, border: '1.5px solid var(--border)', borderRadius: 12, padding: '0 14px',
    background: 'var(--soft)', color: 'var(--text)', fontFamily: 'var(--font)', fontSize: 14, outlineColor: 'var(--accent)',
  };
  const label = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexWrap: 'wrap', background: 'var(--bg)' }}>
      {/* Brand panel: side by side on wide screens, stacked above the form on phones */}
      <div style={{
        flex: '1 1 380px', background: 'var(--rail)', color: 'var(--on-accent)', padding: '48px 40px',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 220,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src={silaLogo} alt="" width={40} height={40} style={{ display: 'block' }} />
          <span style={{ fontSize: 20, fontWeight: 800 }}>Sila</span>
        </div>
        <div style={{ maxWidth: 420 }}>
          {/* the logo on a soft ring, as on the app's splash */}
          <div style={{
            width: 132, height: 132, borderRadius: '50%', background: 'var(--rail-hover)', marginBottom: 28,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 80px 10px var(--rail-hover)',
          }}>
            <img src={silaLogo} alt="Sila" width={96} height={96} style={{ display: 'block' }} />
          </div>
          <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.2, fontWeight: 800 }}>Chats, groups and tickets in one place.</h1>
          <p style={{ margin: '12px 0 0', color: 'var(--rail-text)', fontSize: 15 }}>
            Sign in with your Sila account to pick up where you left off.
          </p>
        </div>
        <div style={{ color: 'var(--rail-text)', fontSize: 12 }}>GLC Paints</div>
      </div>

      {/* Form */}
      <div style={{ flex: '1 1 420px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 16px' }}>
        <form onSubmit={submit} noValidate style={{ width: '100%', maxWidth: 380 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 24, fontWeight: 800, color: 'var(--text)' }}>Sign in</h2>
          <p style={{ margin: '0 0 28px', color: 'var(--muted)', fontSize: 14 }}>Use the same username and password as the Sila app.</p>

          {error && (
            <div role="alert" style={{
              background: 'var(--red-soft)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 10,
              padding: '10px 14px', fontSize: 13, marginBottom: 16,
            }}>{error}</div>
          )}

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="login-user" style={label}>Username</label>
            <input id="login-user" value={username} onChange={e => setUsername(e.target.value)}
              autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus={!username} style={input} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label htmlFor="login-pw" style={label}>Password</label>
            <div style={{ position: 'relative' }}>
              <input id="login-pw" type={showPw ? 'text' : 'password'} value={password}
                onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!username}
                style={{ ...input, paddingRight: 48 }} />
              <button type="button" onClick={() => setShowPw(s => !s)} aria-label={showPw ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute', right: 4, top: 4, width: 38, height: 38, border: 'none', borderRadius: 10,
                  background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text2)', marginBottom: 22, cursor: 'pointer' }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
            Keep me signed in on this device
          </label>

          <button type="submit" disabled={busy} style={{
            width: '100%', height: 48, border: 'none', borderRadius: 12, background: 'var(--accent)', color: 'var(--on-accent)',
            fontFamily: 'var(--font)', fontSize: 15, fontWeight: 700, cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.7 : 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <LogIn size={18} />
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
