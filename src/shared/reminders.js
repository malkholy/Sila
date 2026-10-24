// My Day: the caller's own reminders and notes (dbo.SilaReminder through
// dbo.APISilaWebOperation 'My day' / 'Save reminder' / 'Reminder done' /
// 'Delete reminder' / 'My day count') and his ticket flags (ticketFlag.js),
// shown together. Private: the SP only ever touches the caller's rows.
// SilaApi fires due reminders (live frame {type:'reminder'} + phone push).
import { apiExec } from './auth.js';

const PROC = 'dbo.APISilaWebOperation';
const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const todayIso = () => isoDate(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function toReminder(r) {
  return {
    id: `r${r.ReminderID}`, reminderId: r.ReminderID, src: 'reminder',
    title: r.Title || '', note: r.Note || '', date: r.DueDate || '', time: r.DueTime || '', repeat: r.RepeatKind || '',
    push: Number(r.Push) > 0, linkKind: r.LinkKind || '', linkId: Number(r.LinkID) || 0, chatId: Number(r.ChatID) || 0,
    linkTitle: r.LinkTitle || '', linkSub: r.LinkSub || '', done: !!r.DoneAt,
  };
}
function toFlag(f) {
  return {
    id: `f${f.TicketID}`, src: 'flag', ticketId: f.TicketID, title: f.TicketSubject || `Ticket #${f.TicketID}`,
    note: f.Note || '', date: f.DueDate || '', time: '', repeat: '', push: false,
    linkKind: 'ticket', linkId: f.TicketID, chatId: 0, linkTitle: f.TicketSubject || '',
    linkSub: `# ${f.ChannelName || ''} · #${f.TicketID}`, state: f.StateDescription || '', done: false,
  };
}

export async function loadMyDay() {
  const res = await apiExec(PROC, 'My day', {});
  return { reminders: (res?.data?.List0 || []).map(toReminder), flags: (res?.data?.List1 || []).map(toFlag) };
}

// r: { reminderId?, title, note, date, time, repeat, push, linkKind, linkId, chatId }. Resolves to the saved reminder.
export async function saveReminder(r) {
  const res = await apiExec(PROC, 'Save reminder', {
    ReminderID: r.reminderId || 0, Title: r.title, Note: r.note || '', DueDate: r.date || '', DueTime: r.date ? (r.time || '') : '',
    Repeat: r.date ? (r.repeat || '') : '', Push: r.push === false ? 0 : 1,
    LinkKind: r.linkKind || '', LinkID: r.linkId || 0, ChatID: r.chatId || 0,
  });
  const row = res?.data?.List0?.[0];
  if (!row) throw new Error('The server did not return the reminder.');
  changed();
  return toReminder(row);
}

export async function setReminderDone(reminderId, done) {
  const res = await apiExec(PROC, 'Reminder done', { ReminderID: reminderId, Done: done ? 1 : 0 });
  changed();
  const row = res?.data?.List0?.[0];
  return row ? toReminder(row) : null;
}

export async function deleteReminder(reminderId) {
  await apiExec(PROC, 'Delete reminder', { ReminderID: reminderId });
  changed();
}

// The rail badge: reminders and flags due today or earlier.
export async function myDayCount() {
  const res = await apiExec(PROC, 'My day count', {});
  return Number(res?.data?.List0?.[0]?.Due) || 0;
}

// Something changed (here, in the dialog, a toast): the badge and an open My Day reload.
export const MYDAY_CHANGED = 'sila:myday-changed';
export function changed() { window.dispatchEvent(new Event(MYDAY_CHANGED)); }

// Which section an item sits in.
export function bucketOf(item, now = new Date()) {
  if (item.done) return 'done';
  if (!item.date) return 'nodate';
  const today = isoDate(now);
  if (item.date < today) return 'overdue';
  if (item.date === today) return 'today';
  if (item.date === isoDate(addDays(now, 1))) return 'tomorrow';
  if (item.date <= isoDate(addDays(now, 7))) return 'week';
  return 'later';
}
export const BUCKETS = [
  ['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['later', 'Later'],
  ['nodate', 'No date'], ['done', 'Done'],
];

// "Tue 27 Oct", "Today", "Tomorrow" (+ the time)
export function dueText(item, now = new Date(), long = false) {
  if (!item.date) return 'No date';
  const d = new Date(`${item.date}T00:00:00`);
  const b = item.date === isoDate(now) ? 'Today' : item.date === isoDate(addDays(now, 1)) ? 'Tomorrow'
    : d.toLocaleDateString('en-GB', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' });
  return item.time ? `${b}, ${item.time}` : b;
}
export const REPEAT_LABEL = { day: 'Every day', week: 'Every week', month: 'Every month' };

// Quick times for "remind me" (the work week starts on Saturday).
export function quickTimes(now = new Date()) {
  const inHour = new Date(now.getTime() + 60 * 60 * 1000);
  const later = now.getHours() < 16 ? { date: isoDate(now), time: '16:00', label: 'Later today', hint: '16:00' }
    : { date: isoDate(now), time: '20:00', label: 'This evening', hint: '20:00' };
  const tomorrow = addDays(now, 1);
  const toSat = ((6 - now.getDay()) + 7) % 7 || 7;   // next Saturday
  const nextWeek = addDays(now, toSat);
  return [
    { key: 'hour', label: 'In 1 hour', hint: hhmm(inHour), date: isoDate(inHour), time: hhmm(inHour) },
    { key: 'later', ...later },
    { key: 'tomorrow', label: 'Tomorrow', hint: '9:00', date: isoDate(tomorrow), time: '09:00' },
    { key: 'week', label: 'Next week', hint: nextWeek.toLocaleDateString('en-GB', { weekday: 'short' }) + ' 9:00', date: isoDate(nextWeek), time: '09:00' },
  ];
}
