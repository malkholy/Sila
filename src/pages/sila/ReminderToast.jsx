import React, { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { onLive } from '../../shared/live.js';
import { changed, loadMyDay, quickTimes, saveReminder, setReminderDone } from '../../shared/reminders.js';

// The pop-up when a My Day reminder fires (SilaApi's live frame
// {type:'reminder', id, title, note, dueAt, linkKind, linkId, late}): Open
// (its conversation), In 1 hour, Done. Up to 3 at a time, newest on top; a
// short tone unless the reminder was late. Mounted once in HomeShell.
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
    o.onended = () => ctx.close();
  } catch { /* no sound */ }
}

export default function ReminderToast({ onOpen }) {
  const [list, setList] = useState([]);   // frames
  useEffect(() => onLive('reminder', (f) => {
    changed();
    setList(l => [f, ...l.filter(x => x.id !== f.id)].slice(0, 3));
    if (!f.late) beep();
  }), []);
  const close = (id) => setList(l => l.filter(x => x.id !== id));
  const [busy, setBusy] = useState(0);
  const act = async (f, fn) => {
    setBusy(f.id);
    try { await fn(); close(f.id); } catch { /* left open: try again */ } finally { setBusy(0); }
  };
  const later = (f) => act(f, async () => {
    const { reminders } = await loadMyDay();
    const r = reminders.find(x => x.reminderId === f.id);
    // a one-off moves; a repeating one keeps its series and gets a one-off copy
    if (r) { const t = quickTimes()[0]; await saveReminder({ ...r, reminderId: r.repeat ? 0 : r.reminderId, repeat: '', date: t.date, time: t.time }); }
  });
  if (!list.length) return null;
  const btn = (primary) => ({
    height: 30, padding: '0 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, fontFamily: 'var(--font)', cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--on-accent)' : 'var(--text)',
  });
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1400, display: 'flex', flexDirection: 'column', gap: 10, width: 'min(320px, calc(100vw - 32px))' }}>
      {list.map(f => {
        const time = String(f.dueAt || '').slice(11, 16);
        return (
          <div key={f.id} role="alert" style={{
            padding: 14, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--accent-line)', boxShadow: 'var(--shadow-lg)',
            display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font)', color: 'var(--text)', opacity: busy === f.id ? 0.6 : 1,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Bell size={15} /></span>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 800, color: 'var(--accent-strong)' }}>Reminder{time ? ` · ${time}` : ''}{f.late ? ' (missed)' : ''}</span>
              <button onClick={() => close(f.id)} aria-label="Dismiss" style={{ width: 26, height: 26, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} /></button>
            </div>
            <div dir="auto" style={{ fontWeight: 800 }}>{f.title}</div>
            {f.note && <div dir="auto" style={{ fontSize: 13, color: 'var(--text2)', whiteSpace: 'pre-wrap' }}>{f.note}</div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
              {f.linkKind && <button onClick={() => { onOpen?.({ linkKind: f.linkKind, linkId: f.linkId }); close(f.id); }} style={btn(true)}>Open</button>}
              <button onClick={() => later(f)} disabled={!!busy} style={btn(false)}>In 1 hour</button>
              <button onClick={() => act(f, () => setReminderDone(f.id, true))} disabled={!!busy} style={{ ...btn(false), color: 'var(--green)' }}>Done</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
