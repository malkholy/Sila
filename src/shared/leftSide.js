// The Home list ("left side"): dbo.APISilaWebOperation 'Left side' -- the
// signed-in user's rows of dbo.SilaHistory (one row per conversation). The
// web app's own SP (SQLScript/APISilaWebOperation.sql); the mobile app keeps
// dbo.APIGeneralOperation. The gateway fills @User from the token; permission
// row in SQLScript/V1ApiOperationPermissionSeed.sql.
import { apiExec } from './auth.js';

const PROC = 'dbo.APISilaWebOperation';

// TicketState -> tone [fg, bg]; labels come from cha.TicketState
const TICKET_TONE = {
  0: ['var(--blue)', 'var(--blue-soft)'],
  1: ['var(--green)', 'var(--green-soft)'],
  5: ['var(--amber)', 'var(--amber-soft)'],
};
const MUTED_TONE = ['var(--text2)', 'var(--soft)'];

const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
// For an attachment the SP's LastMessage is the file name; a voice note (.m4a ...) reads better as words
const preview = (s) => {
  const t = clean(s);
  if (/^Text Is Deleted \*+$/i.test(t)) return 'This message was deleted';   // the mobile app's delete placeholder
  return /^\S+\.(m4a|aac|mp3|ogg|oga|opus|wav)$/i.test(t) ? 'Voice message' : t;
};

// SQL datetime without zone -> local Date
function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatWhen(d, now = new Date()) {
  if (!d) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

function toItem(r) {
  const kind = r.Kind || 'other';   // chat | group | ticket | mail | task (from RecordType O/G/C/M/K)
  const item = {
    id: r.SilaID, kind, at: parseDate(r.LastMaintDate), unread: Number(r.UnreadMessage) || 0,
    hidden: Number(r.IsHidden) > 0, preview: preview(r.LastMessage), seq: Number(r.SynSequence) || 0,
    title: '', sub: '', state: '', tone: MUTED_TONE,
    username: '', photoUrl: '', jobTitle: '', raw: r,
  };
  if (kind === 'chat') {
    item.title = r.FromName || r.FromUsername || 'Unknown user';
    item.username = String(r.FromUsername || '').toLowerCase();   // matches live presence
    item.photoUrl = r.FromPhotoURL || '';
    item.jobTitle = [r.FromJobName, r.FromDepartmentName].filter(Boolean).join(' · ');
    item.sub = item.jobTitle;
  }
  if (kind === 'group') item.title = r.GroupName || 'Group';
  if (kind === 'ticket') {
    item.title = r.TicketSubject || `Ticket #${r.TicketID}`;
    item.sub = [r.ChannelName && `# ${r.ChannelName}`, r.TicketID && `#${r.TicketID}`].filter(Boolean).join(' · ');
    item.state = r.TicketStateDescription || '';
    item.tone = TICKET_TONE[r.TicketState] || MUTED_TONE;
  }
  if (kind === 'mail') {
    item.title = r.MailSubject || 'Mail';
    item.sub = r.MailCreatedBy ? `From ${r.MailCreatedBy}` : '';
    item.state = r.MailStateDescription || '';
  }
  if (kind === 'task') {
    item.title = r.TaskSubject || `Task #${r.TaskID}`;
    item.state = r.TaskStateDescription || '';
  }
  if (kind === 'other') item.title = r.FromName || r.GroupName || r.TicketSubject || 'Conversation';
  return item;
}

const byRecent = (a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0);

// Full load (maxSeq 0) or delta (rows whose SynSequence > maxSeq: the triggers
// bump it on every new message / unread change). Returns { items, maxSeq }:
// a full load drops hidden conversations; a delta keeps them (hidden: true) so
// mergeLeftSide can remove them. Throws ApiError with the SP's message.
export async function loadLeftSide(maxSeq = 0) {
  const res = await apiExec(PROC, 'Left side', { MaxSeq: maxSeq });
  const rows = res?.data?.List0 || [];
  const all = rows.map(toItem);
  const items = (maxSeq ? all : all.filter(i => !i.hidden)).sort(byRecent);
  const top = rows.reduce((m, r) => Math.max(m, Number(r.SynSequence) || 0), 0);
  return { items, maxSeq: Math.max(maxSeq, top) };
}

// Applies a delta to the current list: changed rows replace theirs (by
// SilaID), new ones are added, hidden ones removed; newest first. What a delta
// can't see -- a row deleted server-side (left a group) or a Hide / UnHide,
// which doesn't bump SynSequence -- is corrected by the next full load.
export function mergeLeftSide(items, delta) {
  if (!delta.length) return items;
  const byId = new Map(items.map(i => [i.id, i]));
  for (const d of delta) {
    if (d.hidden) byId.delete(d.id); else byId.set(d.id, d);
  }
  return [...byId.values()].sort(byRecent);
}
