import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Phone, Copy, Check, Briefcase, Users, IdCard, AtSign } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { loadUserProfile } from '../../shared/profile.js';

// The profile card: opens beside an avatar that was clicked (the
// 'sila:profile' event from openProfile in shared/profile.js). Mounted once in
// HomeShell. Esc or a click outside closes it.
const WIDTH = 300;

export default function ProfileCard() {
  const [open, setOpen] = useState(null);   // { userId, username, name, photoUrl, rect }
  const [state, setState] = useState({ status: 'idle', p: null, error: '' });
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [copied, setCopied] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const onOpen = (e) => {
      const d = e.detail || {};
      setOpen(d); setCopied('');
      setState({ status: 'loading', p: null, error: '' });
      loadUserProfile(d)
        .then(p => setState({ status: 'ready', p, error: '' }))
        .catch(err => setState({ status: 'error', p: null, error: err.message || 'Could not load the profile.' }));
    };
    window.addEventListener('sila:profile', onOpen);
    return () => window.removeEventListener('sila:profile', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(null); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(null); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);

  // beside the avatar, kept inside the window
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = open.rect || { left: window.innerWidth / 2, right: window.innerWidth / 2, top: 120, bottom: 120 };
    const h = ref.current.offsetHeight;
    let left = r.right + 10;
    if (left + WIDTH > window.innerWidth - 12) left = r.left - WIDTH - 10;
    left = Math.max(12, Math.min(left, window.innerWidth - WIDTH - 12));
    const top = Math.max(12, Math.min(r.top - 12, window.innerHeight - h - 12));
    setPos({ left, top });
  }, [open, state.status]);

  if (!open) return null;
  const p = state.p;
  const name = p?.name || open.name || '';
  const copy = (key, text) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(c => (c === key ? '' : c)), 1500); });
  };
  const row = (Icon, label, value, extra) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }}>
      <Icon size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} aria-hidden="true" />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
        <span dir="auto" style={{ fontSize: 13, color: value ? 'var(--text)' : 'var(--muted)', fontWeight: 600, overflowWrap: 'anywhere' }}>{value || 'Not set'}</span>
      </span>
      {value && extra}
    </div>
  );
  const iconBtn = (label, onClick, Icon, href) => {
    const style = {
      width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, textDecoration: 'none',
    };
    return href
      ? <a href={href} aria-label={label} title={label} style={style}><Icon size={15} /></a>
      : <button type="button" onClick={onClick} aria-label={label} title={label} style={style}><Icon size={15} /></button>;
  };
  const copyBtn = (key, text, what) => iconBtn(copied === key ? 'Copied' : `Copy ${what}`, () => copy(key, text), copied === key ? Check : Copy);

  return (
    <div ref={ref} role="dialog" aria-label={`Profile of ${name}`} style={{
      position: 'fixed', left: pos.left, top: pos.top, zIndex: 1500, width: WIDTH, boxSizing: 'border-box',
      padding: 16, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
      fontFamily: 'var(--font)', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <Avatar name={name} size={56} photoUrl={p?.photoUrl || open.photoUrl} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div dir="auto" style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.3 }}>{name || 'Loading…'}</div>
          {p && <div dir="auto" style={{ fontSize: 12, color: 'var(--text2)' }}>{[p.job, p.department].filter(Boolean).join(' · ') || `@${p.username}`}</div>}
          {p && !p.active && (
            <span style={{ display: 'inline-block', marginTop: 4, padding: '1px 8px', borderRadius: 999, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 11, fontWeight: 700 }}>Inactive</span>
          )}
        </div>
        <button type="button" onClick={() => setOpen(null)} aria-label="Close" style={{
          width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}><X size={16} /></button>
      </div>
      {state.status === 'loading' && <div role="status" style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {state.status === 'error' && <div role="alert" style={{ fontSize: 13, color: 'var(--red)' }}>{state.error}</div>}
      {p && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {row(Phone, 'Mobile', p.mobile, <>{iconBtn(`Call ${p.mobile}`, null, Phone, `tel:${p.mobile.replace(/[^\d+]/g, '')}`)}{copyBtn('m', p.mobile, 'mobile')}</>)}
          {row(Phone, 'Extension', p.extension, copyBtn('x', p.extension, 'extension'))}
          {row(IdCard, 'Employee ID', p.employeeId, copyBtn('e', p.employeeId, 'employee ID'))}
          {row(AtSign, 'Username', p.username, copyBtn('u', p.username, 'username'))}
          {row(Users, 'User group', p.userGroup)}
          {!p.job && !p.department && row(Briefcase, 'Job', '')}
        </div>
      )}
    </div>
  );
}
