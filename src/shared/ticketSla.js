// Ticket service levels (SQLScript/SilaSla.sql): every ticket row carries the
// minutes it waited for its first reply and until it was finished (or until
// now), in WORKING time (Sat-Thu 08:00-16:00; a working day = 480 minutes),
// the channel's targets, and a state per measure: 0 no target, 1 on time,
// 2 due soon (75% used, still open), 3 late.
import { apiExec } from './auth.js';

const num = (v) => (v == null || v === '' ? null : Number(v));
const date = (v) => (v ? new Date(String(v).replace(' ', 'T')) : null);

export function slaOf(r) {
  if (!r) return null;
  return {
    firstReply: date(r.FirstReplyDate),
    reply: { minutes: num(r.ReplyMinutes) || 0, target: num(r.ReplyTarget), state: Number(r.ReplyState) || 0 },
    finish: { minutes: num(r.FinishWorkMinutes) || 0, target: num(r.FinishTarget), state: Number(r.FinishState) || 0 },
  };
}

// "45m", "3h 20m", "2d 1h" -- working time (a day = 8 hours)
export function fmtWork(m) {
  if (m == null) return '';
  const min = Math.max(0, Math.round(m));
  const d = Math.floor(min / 480), h = Math.floor((min % 480) / 60), mi = min % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return mi ? `${h}h ${mi}m` : `${h}h`;
  return `${mi}m`;
}

// The one thing worth showing on a row, or null: an open ticket waiting too
// long for its first reply, else one that is taking too long to finish.
// tone: 'late' | 'soon'.
export function slaAlert(sla, ticketState) {
  if (!sla || ticketState >= 10) return null;
  const { reply, finish, firstReply } = sla;
  if (!firstReply && reply.state >= 2) {
    return reply.state === 3
      ? { tone: 'late', short: 'No reply', text: `No reply · ${fmtWork(reply.minutes - reply.target)} late (target ${fmtWork(reply.target)})` }
      : { tone: 'soon', short: 'Reply due', text: `First reply due in ${fmtWork(reply.target - reply.minutes)} (target ${fmtWork(reply.target)})` };
  }
  if (finish.state >= 2) {
    return finish.state === 3
      ? { tone: 'late', short: 'Late', text: `${fmtWork(finish.minutes - finish.target)} past the finish target (${fmtWork(finish.target)})` }
      : { tone: 'soon', short: 'Due soon', text: `Finish due in ${fmtWork(finish.target - finish.minutes)} (target ${fmtWork(finish.target)})` };
  }
  return null;
}
export const slaLate = (sla, ticketState) => slaAlert(sla, ticketState)?.tone === 'late';

// The Reports page: per channel and per assignee for the channels the caller
// manages (every channel for mhd). from / to: 'yyyy-mm-dd'.
export async function loadTicketReport(from, to) {
  const res = await apiExec('CHA.APISilaWebTicketOperation', 'Ticket report', { From: from, To: to });
  const pct = (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 100) : null);
  return {
    channels: (res?.data?.List0 || []).map(r => ({
      id: r.ChannelID, name: r.ChannelName || `Channel ${r.ChannelID}`, replyTarget: num(r.ReplyTarget), finishTarget: num(r.FinishTarget),
      opened: Number(r.Opened) || 0, finished: Number(r.Finished) || 0, openNow: Number(r.OpenNow) || 0,
      noReplyLate: Number(r.NoReplyLate) || 0, finishLate: Number(r.FinishLate) || 0,
      avgReply: num(r.AvgReplyMinutes), avgFinish: num(r.AvgFinishMinutes),
      replyOnTime: pct(r.ReplyOnTime, r.ReplyMeasured), finishOnTime: pct(r.FinishOnTime, r.FinishMeasured),
    })),
    people: (res?.data?.List1 || []).map(r => ({
      id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || '', photoUrl: r.PhotoURL || '',
      openNow: Number(r.OpenNow) || 0, lateNow: Number(r.LateNow) || 0, finished: Number(r.Finished) || 0, avgFinish: num(r.AvgFinishMinutes),
    })),
    range: res?.data?.List2?.[0] || {},
  };
}
