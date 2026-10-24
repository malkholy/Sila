import React, { useEffect, useState } from 'react';
import { X, Bell, Hash, MessageCircle, Users } from 'lucide-react';
import { quickTimes, saveReminder } from '../../shared/reminders.js';

// New / edit a My Day reminder or note. reminder: an existing one (edit), or
// the start of a new one -- e.g. from a message's "Remind me": its title, the
// conversation (linkKind / linkId / linkTitle) and the message (chatId).
// onSaved(reminder) after the server saved it.
export default function ReminderDialog({ reminder = {}, onClose, onSaved }) {
  const isNew = !reminder.reminderId;
  const [form, setForm] = useState(() => ({
    title: reminder.title || '', note: reminder.note || '', date: reminder.date || '', time: reminder.time || '',
    repeat: reminder.repeat || '', push: reminder.push !== false,
    linkKind: reminder.linkKind || '', linkId: reminder.linkId || 0, chatId: reminder.chatId || 0, linkTitle: reminder.linkTitle || '',
  }));
  const [quick, setQuick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const times = quickTimes();
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [busy, onClose]);
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [k]: v }));
    if (k === 'date' || k === 'time') setQuick('');
  };
  const ok = form.title.trim() && !busy;
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError('');
    try { onSaved(await saveReminder({ ...form, reminderId: reminder.reminderId, title: form.title.trim(), note: form.note.trim() })); }
    catch (err) { setError(err.message || 'Could not save the reminder.'); setBusy(false); }
  };
  const field = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border2)',
    background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)',
  };
  const label = (text, node, flex) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>{text}</span>{node}
    </label>
  );
  const LinkIcon = form.linkKind === 'ticket' ? Hash : form.linkKind === 'group' ? Users : MessageCircle;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="rem-title" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={submit} style={{
        width: 'min(500px, 100%)', maxHeight: '92vh', overflowY: 'auto', padding: 20, borderRadius: 16, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font)', color: 'var(--text)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Bell size={17} />
          </span>
          <h2 id="rem-title" style={{ flex: 1, margin: 0, fontSize: 17, fontWeight: 800 }}>{isNew ? 'New reminder' : 'Edit reminder'}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{
            width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><X size={16} /></button>
        </div>
        {label('What to remember', <input autoFocus dir="auto" value={form.title} maxLength={200} onChange={set('title')} disabled={busy} style={field} />)}
        {label('Note (optional)', <textarea rows={3} dir="auto" value={form.note} maxLength={1000} onChange={set('note')} disabled={busy} style={{ ...field, resize: 'vertical' }} />)}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>When</span>
          <div role="group" aria-label="Quick times" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {times.map(t => {
              const on = quick === t.key;
              return (
                <button key={t.key} type="button" aria-pressed={on} disabled={busy}
                  onClick={() => { setQuick(t.key); setForm(f => ({ ...f, date: t.date, time: t.time })); }} style={{
                    height: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 700,
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'var(--surface)',
                    color: on ? 'var(--accent-strong)' : 'var(--text2)',
                  }}>{t.label} <span style={{ fontWeight: 600, opacity: 0.75 }}>{t.hint}</span></button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {label('Date', <input type="date" value={form.date} onChange={set('date')} disabled={busy} style={field} />, '1 1 130px')}
            {label('Time (optional)', <input type="time" value={form.time} onChange={set('time')} disabled={busy || !form.date} style={field} />, '1 1 110px')}
            {label('Repeat', (
              <select value={form.repeat} onChange={set('repeat')} disabled={busy || !form.date} style={field}>
                <option value="">Never</option><option value="day">Every day</option><option value="week">Every week</option><option value="month">Every month</option>
              </select>
            ), '1 1 120px')}
          </div>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {!form.date ? 'No date: it stays on your list without a reminder.' : form.time ? '' : 'Date only: you are reminded at 9:00.'}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>Linked to</span>
          {form.linkKind ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 10, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}>
              <LinkIcon size={15} style={{ color: 'var(--accent-strong)', flexShrink: 0 }} />
              <span dir="auto" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {form.linkTitle || form.linkKind}{form.chatId ? ' · a message' : ''}
              </span>
              <button type="button" onClick={() => setForm(f => ({ ...f, linkKind: '', linkId: 0, chatId: 0, linkTitle: '' }))} disabled={busy}
                aria-label="Remove the link" title="Make it a personal note" style={{
                  width: 26, height: 26, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--accent-strong)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}><X size={14} /></button>
            </div>
          ) : <span style={{ fontSize: 13, color: 'var(--muted)' }}>Personal note (“Remind me” on a message links it to that message)</span>}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.push} onChange={set('push')} disabled={busy} style={{ width: 18, height: 18, accentColor: 'var(--accent)' }} />
          Push to my phone at the due time (a pop-up shows here too)
        </label>
        {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Only you see your reminders.</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} disabled={busy} style={{
              height: 38, padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
            }}>Cancel</button>
            <button type="submit" disabled={!ok} style={{
              height: 38, padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)',
              fontWeight: 700, fontSize: 13, cursor: ok ? 'pointer' : 'not-allowed', opacity: ok ? 1 : 0.5, fontFamily: 'var(--font)',
            }}>{busy ? 'Saving…' : 'Save reminder'}</button>
          </span>
        </div>
      </form>
    </div>
  );
}
