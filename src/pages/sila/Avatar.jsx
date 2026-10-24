import React, { useEffect, useState } from 'react';
import { photoBlobUrl } from '../../shared/files.js';
import { openProfile } from '../../shared/profile.js';

// A person: initials always, the photo fading in over them once it has
// actually loaded -- so a slow, blocked or missing photo (AttachmentHistory
// FileURL on the old photo server, fetched through the Files API: photoBlobUrl)
// still shows a proper avatar -- plus an online dot. With userId or username
// it is clickable: the person's profile card opens (ProfileCard.jsx). It often
// sits inside a row that is itself a button, so it is a focusable span, and
// its click never reaches the row.

export function initials(name) {
  return (name || '?').split(/[\s._-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

export default function Avatar({ name, size = 40, online, photoUrl, userId, username }) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    setLoaded(false); setBroken(false); setSrc('');
    photoBlobUrl(photoUrl).then(u => { if (alive) setSrc(u); });
    return () => { alive = false; };
  }, [photoUrl]);
  const clickable = !!(userId || username);
  const show = (e) => {
    e.stopPropagation(); e.preventDefault();
    openProfile({ userId, username, name, photoUrl }, e.currentTarget);
  };
  return (
    <span {...(clickable ? {
      role: 'button', tabIndex: 0, 'aria-label': `Profile of ${name || username}`, title: name || undefined,
      onClick: show, onMouseDown: (e) => e.stopPropagation(), onDoubleClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') show(e); },
    } : {})} style={{
      position: 'relative', display: 'inline-block', flex: `0 0 ${size}px`, width: size, height: size, verticalAlign: 'middle',
      cursor: clickable ? 'pointer' : undefined, borderRadius: '50%',
    }}>
      <span aria-hidden={src && loaded ? true : undefined} style={{
        position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--accent)', color: 'var(--on-accent)',
        fontWeight: 700, fontSize: size * 0.36, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      }}>{initials(name)}</span>
      {src && !broken && (
        <img src={src} alt="" decoding="async" onLoad={() => setLoaded(true)} onError={() => setBroken(true)} style={{
          position: 'absolute', inset: 0, width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block',
          opacity: loaded ? 1 : 0, transition: 'opacity .2s',
        }} />
      )}
      {online && <span title="Online" style={{
        position: 'absolute', right: 0, bottom: 0, width: size * 0.28, height: size * 0.28, borderRadius: '50%',
        background: 'var(--online)', border: '2px solid var(--surface)',
      }} />}
    </span>
  );
}
