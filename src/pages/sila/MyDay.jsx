import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Bell, Hash, MessageCircle, Users, Flag, Pencil, Trash2, Repeat, ChevronLeft, ChevronRight, RefreshCw, Check, ExternalLink } from 'lucide-react';
import {
  loadMyDay, setReminderDone, deleteReminder, saveReminder, bucketOf, BUCKETS, dueText, quickTimes, isoDate, todayIso,
  REPEAT_LABEL, MYDAY_CHANGED, changed,
} from '../../shared/reminders.js';
import { setTicketFlag } from '../../shared/ticketFlag.js';
import { onLive } from '../../shared/live.js';
import ReminderDialog from './ReminderDialog.jsx';

// My Day: the caller's own reminders and notes plus his ticket flags, as a
// list (Overdue / Today / Tomorrow / Next 7 days / Later / No date / Done) or a
// month calendar (weeks from Saturday, Fridays shaded), with the selected
// item's details. A flag is "done" by clearing it. onOpen({ linkKind, linkId })
// opens the conversation an item is about.
const FILTERS = [['all', 'All'], ['ticket', 'Tickets'], ['note', 'Notes'], ['message', 'Messages']];
const BUCKET_COLOR = { overdue: 'var(--red)', today: 'var(--accent-strong)' };
const kindOf = (i) => (i.linkKind === 'ticket' ? 'ticket' : i.linkKind ? 'message' : 'note');
const TONE = {
  ticket: ['var(--accent-strong)', 'var(--accent-soft)', 'var(--accent-line)', 'Ticket'],
  note: ['var(--blue)', 'var(--blue-soft)', 'var(--blue)', 'Note'],
  message: ['var(--green)', 'var(--green-soft)', 'var(--green)', 'Message'],
};

function KindIcon({ item, size = 16 }) {
  if (item.src === 'flag') return <Flag size={size} fill="currentColor" />;
  if (item.linkKind === 'ticket') return <Hash size={size} />;
  if (item.linkKind === 'group') return <Users size={size} />;
  if (item.linkKind === 'chat') return <MessageCircle size={size} />;
  return <Pencil size={size} />;
}

export default function MyDay({ onOpen }) {
  const [view, setView] = useState(() => { try { return localStorage.getItem('silaMyDayView') || 'list'; } catch { return 'list'; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem('silaMyDayView', v); } catch { /* not kept */ } };
  const [data, setData] = useState({ status: 'loading', reminders: [], flags: [], error: '' });
  const [filter, setFilter] = useState('all');
  const [selId, setSelId] = useState(null);
  const [editing, setEditing] = useState(null);   // {} new | a reminder
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [month, setMonth] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [day, setDay] = useState(todayIso());

  const load = useCallback(() => {
    loadMyDay().then(d => setData({ status: 'ready', ...d, error: '' }))
      .catch(err => setData(s => ({ ...s, status: s.reminders.length || s.flags.length ? 'ready' : 'error', error: err.message || 'Could not load My Day.' })));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener(MYDAY_CHANGED, load);
    const off = onLive('reminder', load);   // a reminder fired (a repeating one moved on)
    return () => { window.removeEventListener(MYDAY_CHANGED, load); off(); };
  }, [load]);
  const flash = (t) => { setToast(t); setTimeout(() => setToast(x => (x === t ? '' : x)), 2200); };

  const items = useMemo(() => [...data.reminders, ...data.flags], [data]);
  const shown = items.filter(i => filter === 'all' || kindOf(i) === filter);
  const sel = items.find(i => i.id === selId) || null;
  const now = new Date();
  const counts = { overdue: 0, today: 0 };
  items.forEach(i => { const b = bucketOf(i, now); if (b in counts) counts[b] += 1; });

  // actions (the server checks everything again)
  const run = async (fn, done) => {
    setBusy(true);
    try { await fn(); if (done) flash(done); changed(); }
    catch (err) { flash(err.message || 'That did not work.'); }
    finally { setBusy(false); }
  };
  const toggleDone = (i) => (i.src === 'flag'
    ? run(() => setTicketFlag(i.ticketId, null), 'Flag cleared')
    : run(() => setReminderDone(i.reminderId, !i.done), i.done ? 'Back on your list' : i.repeat ? 'Done — moved to its next time' : 'Done'));
  const moveTo = (i, t) => (i.src === 'flag'
    ? run(() => setTicketFlag(i.ticketId, { due: t.date, note: i.note }), `Flag moved to ${dueText({ date: t.date })}`)
    : run(() => saveReminder({ ...i, date: t.date, time: t.time }), `Reminder set: ${dueText({ date: t.date, time: t.time })}`));
  const remove = (i) => run(async () => { await deleteReminder(i.reminderId); setSelId(null); setConfirmDel(false); }, 'Reminder deleted');

  const chip = (on, label, onClick, key) => (
    <button key={key} type="button" onClick={onClick} aria-pressed={on} style={{
      height: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 700,
      border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'var(--surface)',
      color: on ? 'var(--accent-strong)' : 'var(--text2)', whiteSpace: 'nowrap',
    }}>{label}</button>
  );
  const btn = (primary, danger) => ({
    height: 36, padding: '0 14px', borderRadius: 10, fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--on-accent)' : danger ? 'var(--red)' : 'var(--text)', display: 'flex', alignItems: 'center', gap: 6,
  });

  const row = (i) => {
    const b = bucketOf(i, now);
    const [fg, bg, line] = TONE[kindOf(i)];
    const late = b === 'overdue';
    return (
      <div key={i.id} style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, padding: 10, borderRadius: 12,
        background: i.id === selId ? 'var(--accent-soft)' : 'transparent',
      }}>
        <button onClick={() => toggleDone(i)} disabled={busy} aria-pressed={i.done}
          aria-label={i.src === 'flag' ? `Clear the flag: ${i.title}` : `${i.done ? 'Not done' : 'Done'}: ${i.title}`}
          title={i.src === 'flag' ? 'Done: clears the ticket flag' : i.done ? 'Mark not done' : 'Mark done'} style={{
            flex: '0 0 22px', width: 22, height: 22, marginTop: 6, borderRadius: 7, padding: 0, cursor: 'pointer',
            border: `2px solid ${i.done ? 'var(--green)' : late ? 'var(--red)' : 'var(--border2)'}`,
            background: i.done ? 'var(--green)' : 'var(--surface)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{i.done && <Check size={13} strokeWidth={3} />}</button>
        <span style={{
          flex: '0 0 34px', width: 34, height: 34, borderRadius: 10, background: bg, border: `1.5px solid ${line}`, color: fg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><KindIcon item={i} /></span>
        <button onClick={() => { setSelId(i.id); setConfirmDel(false); }} style={{
          flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer',
          color: 'var(--text)', fontFamily: 'var(--font)', display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
            <span dir="auto" style={{
              fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              textDecoration: i.done ? 'line-through' : 'none', color: i.done ? 'var(--muted)' : 'var(--text)',
            }}>{i.title}</span>
            <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: i.done ? 'var(--green)' : BUCKET_COLOR[b] || 'var(--text2)', display: 'flex', alignItems: 'center', gap: 4 }}>
              {i.repeat && <Repeat size={12} aria-label={REPEAT_LABEL[i.repeat]} />}{i.done ? 'Done' : dueText(i, now)}
            </span>
          </span>
          {i.note && <span dir="auto" style={{ fontSize: 13, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.note}</span>}
          <span dir="auto" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {i.src === 'flag' ? `${i.linkSub} · your flag` : i.linkKind ? `${i.linkTitle || ''}${i.linkSub ? ` · ${i.linkSub}` : ''}${i.chatId ? ' · a message' : ''}` : 'Personal note'}
          </span>
        </button>
        {!i.done && b !== 'tomorrow' && (
          <button onClick={() => moveTo(i, quickTimes(now)[2])} disabled={busy} title="Move to tomorrow, 9:00" style={{ ...btn(false), height: 30, padding: '0 10px', fontSize: 12 }}>Tomorrow</button>
        )}
      </div>
    );
  };

  const list = (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 14px 24px' }}>
      {BUCKETS.map(([key, label]) => {
        const rows = shown.filter(i => bucketOf(i, now) === key);
        if (!rows.length) return null;
        return (
          <section key={key} aria-label={label} style={{ marginTop: 14 }}>
            <h2 style={{ margin: '0 10px 6px', fontSize: 12, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: BUCKET_COLOR[key] || 'var(--text2)' }}>
              {label} · {rows.length}
            </h2>
            {rows.map(row)}
          </section>
        );
      })}
      {data.status === 'ready' && shown.length === 0 && (
        <div style={{ margin: 24, padding: 20, borderRadius: 12, border: '1px dashed var(--border2)', color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
          Nothing here yet. Add a reminder, or use “Remind me” on any message. Flagged tickets show up here too.
        </div>
      )}
    </div>
  );

  // the month grid: 6 weeks from the Saturday on or before the 1st
  const start = new Date(month); start.setDate(1 - ((start.getDay() + 1) % 7));
  const cells = Array.from({ length: 42 }, (_, n) => { const d = new Date(start); d.setDate(start.getDate() + n); return d; });
  const byDay = (iso) => shown.filter(i => i.date === iso).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const calendar = (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, flex: 1 }}>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2>
        <button onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Previous month" style={{ ...btn(false), width: 36, padding: 0, justifyContent: 'center' }}><ChevronLeft size={16} /></button>
        <button onClick={() => { const d = new Date(); d.setDate(1); setMonth(d); setDay(todayIso()); }} style={btn(false)}>Today</button>
        <button onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Next month" style={{ ...btn(false), width: 36, padding: 0, justifyContent: 'center' }}><ChevronRight size={16} /></button>
      </div>
      <div style={{ minWidth: 560, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
        {['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(w => (
          <div key={w} style={{ padding: '0 6px', fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: w === 'Fri' ? 'var(--muted)' : 'var(--text2)' }}>{w}</div>
        ))}
        {cells.map(d => {
          const iso = isoDate(d);
          const evs = byDay(iso);
          const inMonth = d.getMonth() === month.getMonth();
          const isToday = iso === todayIso();
          const on = iso === day;
          return (
            <button key={iso} onClick={() => setDay(iso)} aria-pressed={on} aria-label={`${d.toDateString()}: ${evs.length} items`} style={{
              minHeight: 92, padding: '5px 6px', borderRadius: 10, textAlign: 'left', cursor: 'pointer', fontFamily: 'var(--font)',
              display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'stretch',
              border: on ? '2px solid var(--accent)' : '1px solid var(--border)',
              background: on ? 'var(--accent-soft)' : d.getDay() === 5 ? 'var(--bg)' : 'var(--surface)', color: inMonth ? 'var(--text)' : 'var(--muted)',
            }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 12, fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? 'var(--on-accent)' : 'inherit',
                }}>{d.getDate()}</span>
                {evs.length > 2 && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>+{evs.length - 2}</span>}
              </span>
              {evs.slice(0, 2).map(i => {
                const late = bucketOf(i, now) === 'overdue';
                const [fg, bg] = TONE[kindOf(i)];
                return (
                  <span key={i.id} dir="auto" style={{
                    padding: '1px 5px', borderRadius: 5, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    background: late ? 'var(--red-soft)' : bg, color: late ? 'var(--red)' : fg, textDecoration: i.done ? 'line-through' : 'none',
                  }}>{i.time ? `${i.time} ` : ''}{i.title}</span>
                );
              })}
            </button>
          );
        })}
      </div>
    </div>
  );

  // right side: the selected item, else (calendar) the selected day's agenda
  const dayItems = byDay(day);
  const details = sel ? (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em',
          background: TONE[kindOf(sel)][1], color: TONE[kindOf(sel)][0],
        }}>{sel.src === 'flag' ? 'Ticket flag' : TONE[kindOf(sel)][3]}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: BUCKET_COLOR[bucketOf(sel, now)] || 'var(--text2)' }}>
          {sel.done ? 'Done' : dueText(sel, now, true)}{sel.repeat ? ` · ${REPEAT_LABEL[sel.repeat]}` : ''}
        </span>
      </div>
      <h2 dir="auto" style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{sel.title}</h2>
      <div dir="auto" style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 14, whiteSpace: 'pre-wrap', color: sel.note ? 'var(--text)' : 'var(--muted)' }}>
        {sel.note || 'No note.'}
      </div>
      {sel.linkKind && (
        <button onClick={() => onOpen?.(sel)} style={{ ...btn(false), alignSelf: 'flex-start' }}>
          <ExternalLink size={14} /> Open {sel.linkKind === 'ticket' ? `ticket #${sel.linkId}` : sel.linkKind === 'group' ? 'the group' : 'the chat'}
        </button>
      )}
      {!sel.done && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Remind me again</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {quickTimes(now).filter(t => sel.src !== 'flag' || t.key !== 'hour').map(t => chip(false, `${t.label} ${t.hint}`, () => moveTo(sel, t), t.key))}
          </div>
        </div>
      )}
      {sel.src === 'reminder' && !sel.push && <div style={{ fontSize: 12, color: 'var(--muted)' }}>No push to the phone for this one.</div>}
      <div style={{ flex: 1 }} />
      {confirmDel ? (
        <div role="alertdialog" aria-label="Confirm" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 10, borderRadius: 10, background: 'var(--red-soft)' }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Delete this reminder?</span>
          <button onClick={() => remove(sel)} disabled={busy} style={{ ...btn(false), background: 'var(--red)', color: '#fff', border: 'none' }}>Delete</button>
          <button onClick={() => setConfirmDel(false)} style={btn(false)}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => toggleDone(sel)} disabled={busy} style={btn(true)}>
            <Check size={15} /> {sel.src === 'flag' ? 'Done (clear flag)' : sel.done ? 'Not done' : 'Mark done'}
          </button>
          {sel.src === 'reminder' && <button onClick={() => setEditing(sel)} style={btn(false)}><Pencil size={14} /> Edit</button>}
          {sel.src === 'reminder' && <button onClick={() => setConfirmDel(true)} style={btn(false, true)}><Trash2 size={14} /> Delete</button>}
        </div>
      )}
    </>
  ) : view === 'calendar' ? (
    <>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--accent-strong)' }}>
        {day === todayIso() ? 'Today' : day < todayIso() ? 'Past day' : 'Coming up'}
      </div>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      {dayItems.length === 0 && <div style={{ padding: 14, borderRadius: 12, border: '1px dashed var(--border2)', color: 'var(--muted)', fontSize: 13 }}>Nothing on this day.</div>}
      {dayItems.map(i => (
        <button key={i.id} onClick={() => setSelId(i.id)} style={{
          display: 'flex', gap: 10, padding: 10, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)',
          textAlign: 'left', cursor: 'pointer', fontFamily: 'var(--font)', color: 'var(--text)',
        }}>
          <span style={{ flex: '0 0 46px', fontSize: 12, fontWeight: 800, color: 'var(--accent-strong)' }}>{i.time || 'All day'}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span dir="auto" style={{ display: 'block', fontWeight: 700, textDecoration: i.done ? 'line-through' : 'none' }}>{i.title}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i.src === 'flag' ? 'Ticket flag' : TONE[kindOf(i)][3]}</span>
          </span>
        </button>
      ))}
      <button onClick={() => setEditing({ date: day })} style={{ ...btn(false), alignSelf: 'flex-start', borderStyle: 'dashed' }}><Plus size={14} /> Add on this day</button>
    </>
  ) : (
    <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--muted)', fontSize: 13, maxWidth: 260 }}>
      <Bell size={28} style={{ color: 'var(--accent)', marginBottom: 8 }} />
      <div>Pick a reminder to see it here. At its time you get a pop-up here and a push on your phone.</div>
    </div>
  );

  return (
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexWrap: 'wrap', background: 'var(--bg)', fontFamily: 'var(--font)', color: 'var(--text)', position: 'relative' }}>
      <section aria-label="My Day" style={{ flex: '999 1 560px', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
        <header style={{ padding: '16px 20px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--border)' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: '-.03em' }}>My Day</h1>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {counts.overdue} overdue · {counts.today} today · only you see these
            </div>
          </div>
          <div role="group" aria-label="View" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            {[['list', 'List'], ['calendar', 'Calendar']].map(([k, label]) => (
              <button key={k} onClick={() => pickView(k)} aria-pressed={view === k} style={{
                height: 36, padding: '0 14px', border: 'none', cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 13, fontWeight: 700,
                background: view === k ? 'var(--accent)' : 'var(--surface)', color: view === k ? 'var(--on-accent)' : 'var(--text)',
              }}>{label}</button>
            ))}
          </div>
          <button onClick={load} aria-label="Refresh" title="Refresh" style={{ ...btn(false), width: 36, padding: 0, justifyContent: 'center' }}><RefreshCw size={15} /></button>
          <button onClick={() => setEditing({})} style={btn(true)}><Plus size={15} strokeWidth={2.4} /> New reminder</button>
        </header>
        <div role="group" aria-label="Show" style={{ padding: '10px 20px 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map(([k, label]) => chip(filter === k, `${label} · ${items.filter(i => k === 'all' || kindOf(i) === k).length}`, () => setFilter(k), k))}
        </div>
        {data.status === 'loading' && <div role="status" style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>}
        {data.status === 'error' && <div role="alert" style={{ margin: 20, padding: 12, borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>{data.error}</div>}
        {data.status === 'ready' && (view === 'calendar' ? calendar : list)}
      </section>
      <aside aria-label="Details" style={{ flex: '1 1 320px', minWidth: 0, maxWidth: '100%', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--soft)' }}>
        {sel && <button onClick={() => setSelId(null)} style={{ ...btn(false), alignSelf: 'flex-end', height: 30, fontSize: 12 }}>Close</button>}
        {details}
      </aside>
      {editing && (
        <ReminderDialog reminder={editing} onClose={() => setEditing(null)}
          onSaved={(r) => { setEditing(null); setSelId(r.id); flash(r.date ? `Reminder set: ${dueText(r)}` : 'Saved'); }} />
      )}
      {toast && (
        <div role="status" style={{ position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: 12, background: 'var(--text)', color: 'var(--surface)', fontSize: 13, fontWeight: 600 }}>{toast}</div>
      )}
    </main>
  );
}
