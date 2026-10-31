// Conversations on the right side: one-to-one chats and groups, through
// dbo.APISilaWebOperation (SQLScript/APISilaWebOperation.sql), and tickets,
// through CHA.APISilaWebTicketOperation (SQLScript/APISilaWebTicketOperation.sql).
// The SPs check the signed-in user belongs to the session / group / ticket;
// the gateway fills @User from the token. chatApi(item) gives one interface
// for all three kinds.
import { apiExec, apiExecIdempotent } from './auth.js';
import { hasFormatting } from './richText.js';
import { flagOf } from './ticketFlag.js';
import { assigneeOf } from './ticketAssign.js';
import { slaOf } from './ticketSla.js';

const PROC = 'dbo.APISilaWebOperation';
const TICKET_PROC = 'CHA.APISilaWebTicketOperation';
export const PAGE_SIZE = 50;

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic']);
// Voice notes from the mobile app are .m4a; other formats browsers can play inline
const AUDIO_EXT = new Set(['m4a', 'aac', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'webm']);

function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toMessage(r, me) {
  const ext = String(r.FileExtension || '').replace(/^\./, '').toLowerCase();
  const hasFile = Number(r.AttachmentID) > 0 && !!r.FileURL;
  return {
    id: r.ChatID, sortId: Number(r.SortID) || r.ChatID, original: Number(r.OrginalChatID) || 0,
    sessionId: Number(r.SessionID) || 0,   // one-to-one writes return it: a new chat's first message makes the session
    localId: Number(r.LocalChatID) || 0, mine: r.FromUserID === me, at: parseDate(r.CreatedDate),
    text: String(r.Text ?? ''), deleted: Number(r.IsDeleted) > 0, system: Number(r.IsSystem) > 0,
    adminNote: Number(r.IsAdminNote) > 0,   // tickets: admins-only note (the SP sends them to managers only)
    // formatted text (TextStyle HTML from the web's rich mode or the mobile editor); shown sanitized
    html: hasFormatting(r.TextStyle) ? String(r.TextStyle) : '',
    edited: Number(r.OrginalChatID) > 0, seen: Number(r.IsSeen) > 0,
    // groups: who sent it
    from: r.FromName !== undefined ? {
      id: r.FromUserID, name: r.FromName || r.FromUsername || 'Unknown user',
      username: String(r.FromUsername || '').toLowerCase(), photoUrl: r.FromPhotoURL || '', jobTitle: r.FromJobName || '',
    } : null,
    reply: Number(r.ReplayMsgID) > 0 && r.ReplyText != null
      ? { id: Number(r.ReplayMsgID), text: String(r.ReplyText), mine: r.ReplyFromUserID === me, name: r.ReplyFromName || '' } : null,
    file: hasFile ? {
      id: Number(r.AttachmentID), name: r.FileOrginalName || r.FileName || 'Attachment', ext, url: r.FileURL,
      size: Number(r.FileSize) || 0, sizeText: Number(r.FileSize) ? '' : String(r.FileSize || ''),   // AttachmentHistory: "104 KB"
      image: IMAGE_EXT.has(ext), audio: AUDIO_EXT.has(ext),
    } : null,
  };
}

// Client id of a message; a retry re-sends the same one, so the SP saves it once.
export const newLocalId = () => 1 + Math.floor(Math.random() * 2_000_000_000);

const saved = (res, me) => {
  const row = res?.data?.List0?.[0];
  if (!row) throw new Error('The server did not return the message.');
  return toMessage(row, me);
};

// One interface for a one-to-one chat (item.kind 'chat'), a group ('group') or a ticket ('ticket').
//   load(before, after) -> { header, messages (oldest first), hasMore }  after: delta since that ChatID
//   markRead()          -> cleared count
//   send / edit / del   -> the saved message (an edit / delete takes the original's place: same sortId)
// header: { me, title, photoUrl, username, jobTitle, isGroup, locked, isAdmin, memberCount, broadcast }
//         tickets add { isTicket, ticketId, state, stateLabel, channel, createdBy, can: {...} }
// A new chat not started yet (item.draft: raw.ToUserID, no SessionID) loads
// empty; its first Send chat carries ToUserID and the SP creates the session.
export function chatApi(item) {
  const group = item.kind === 'group';
  const ticket = item.kind === 'ticket';
  const draft = !ticket && !group && !item.raw?.SessionID && !!item.raw?.ToUserID;
  const proc = ticket ? TICKET_PROC : PROC;
  const key = ticket ? { TicketID: item.raw?.TicketID } : group ? { GroupID: item.raw?.GroupID }
    : draft ? { ToUserID: item.raw.ToUserID } : { SessionID: item.raw?.SessionID };
  const op = ticket
    ? { load: 'Ticket messages', read: 'Mark ticket read', send: 'Send ticket chat', edit: 'Edit ticket chat', del: 'Delete ticket chat' }
    : group
      ? { load: 'Group messages', read: 'Mark group read', send: 'Send group chat', edit: 'Edit group chat', del: 'Delete group chat' }
      : { load: 'Chat messages', read: 'Mark chat read', send: 'Send chat', edit: 'Edit chat', del: 'Delete chat' };
  return {
    isGroup: group,
    isTicket: ticket,
    // before: page back (by sortId); after: only rows newer than this ChatID (cache delta)
    async load(before = 0, after = 0) {
      if (draft) {
        return {
          header: { me: 0, isGroup: false, title: item.title, photoUrl: item.photoUrl || '', username: item.username || '', jobTitle: item.jobTitle || '' },
          messages: [], hasMore: false,
        };
      }
      const res = await apiExec(proc, op.load, { ...key, BeforeChatID: before, AfterChatID: after, Top: PAGE_SIZE });
      const [h] = res?.data?.List0 || [];
      const rows = res?.data?.List1 || [];
      const me = h?.MeUserID;
      const header = !h ? null : ticket ? ticketHeader(h, item, res?.data?.List2) : group ? {
        me, isGroup: true, title: h.GroupName || item.title, photoUrl: h.GroupPhotoURL || '',
        locked: Number(h.ChatIsLocked) > 0, isAdmin: Number(h.IsAdmin) > 0, memberCount: Number(h.MemberCount) || 0,
        broadcast: Number(h.IsBroadcast) > 0,   // every active user is in it; admins send
      } : {
        me, isGroup: false, title: h.OtherName || h.OtherUsername || item.title, photoUrl: h.OtherPhotoURL || '',
        username: String(h.OtherUsername || '').toLowerCase(),
        jobTitle: [h.OtherJobName, h.OtherDepartmentName].filter(Boolean).join(' · '),
      };
      return { header, messages: rows.map(r => toMessage(r, me)).reverse(), hasMore: rows.length === PAGE_SIZE };
    },
    async markRead() {
      if (draft) return 0;
      const res = await apiExec(proc, op.read, key);
      return Number(res?.data?.List0?.[0]?.Cleared) || 0;
    },
    // adminOnly (tickets): an admins-only note -- ticket admins / team leaders only
    // html: formatted text (already sanitized); Text stays the plain version
    async send({ text, html = '', replyToId = 0, localId, me, adminOnly = false }) {
      return saved(await apiExecIdempotent(proc, op.send, {
        ...key, Text: text, ReplayMsgID: replyToId, LocalChatID: localId,
        ...(html ? { Html: html } : {}), ...(ticket && adminOnly ? { AdminOnly: 1 } : {}),
      }), me);
    },
    // a file uploaded to the Files API (AttachmentID) posted as a message
    async sendFile({ attachmentId, replyToId = 0, localId, me, adminOnly = false }) {
      const opName = ticket ? 'Send ticket file' : group ? 'Send group chat file' : 'Send chat file';
      return saved(await apiExecIdempotent(proc, opName, {
        ...key, AttachmentID: attachmentId, ReplayMsgID: replyToId, LocalChatID: localId,
        ...(ticket && adminOnly ? { AdminOnly: 1 } : {}),
      }), me);
    },
    async edit({ chatId, text, html = '', localId, me }) {
      return saved(await apiExec(proc, op.edit, { ChatID: chatId, Text: text, LocalChatID: localId, ...(html ? { Html: html } : {}) }), me);
    },
    async del({ chatId, localId, me }) {
      return saved(await apiExec(proc, op.del, { ChatID: chatId, LocalChatID: localId }), me);
    },
  };
}

// The ticket header from 'Ticket messages' List0: what it is, where, its state,
// and what the caller may do now (the SP's Can* flags: the same rules it checks).
// A ticket date from TicketHistory; empty / placeholder (before 2000) = not happened.
function ticketDate(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 ? null : d;
}

const STEP_LABEL = {
  opened: 'Opened', started: 'Started', hold: 'Put on hold', reopened: 'Reopened', ended: 'Ended', closed: 'Closed',
  forwarded: 'Forwarded', accepted: 'Forward accepted', rejected: 'Forward rejected', cancelled: 'Forward cancelled',
};
// steps: 'Ticket messages' List2 -- every state step from the system lines (a
// page-back load sends none, but only its messages are kept: loadOlder).
function ticketHeader(h, item, steps) {
  const flag = (k) => Number(h[k]) > 0;
  // the ticket's dated steps, oldest first; kind = what happened, by = a username.
  // The ticket row's dates (one per kind, the latest) fill in a kind with no
  // system line, e.g. a start the old app made on a manager's first reply.
  const fromLines = (steps || []).map(s => ({
    key: `${s.Step}-${s.ChatID}`, kind: s.Step, label: STEP_LABEL[s.Step] || s.Step, at: ticketDate(s.CreatedDate),
    by: String(s.ByUser || '').toLowerCase(),
  })).filter(x => x.at);
  const seen = new Set(fromLines.map(x => x.kind));
  const fromRow = [
    ['opened', h.CreatedDate, h.CreatedByUser], ['forwarded', h.ForwardDate, h.ForwardBy],
    ['started', h.StartDate, h.StartBy], ['hold', h.HoldDate, h.HoldBy],
    ['ended', h.EndedDate, h.EndedBy], ['closed', h.ClosedDate, h.ClosedBy],
  ].filter(([kind]) => kind === 'opened' || !seen.has(kind))
    .map(([kind, at, by]) => ({ key: kind, kind, label: STEP_LABEL[kind], at: ticketDate(at), by: String(by || '').toLowerCase() }))
    .filter(x => x.at);
  const history = [...fromRow, ...fromLines].sort((a, b) => a.at - b.at);
  return {
    me: h.MeUserID, isTicket: true, ticketId: h.TicketID, title: h.TicketSubject || item.title, photoUrl: '',
    state: Number(h.TicketState), stateLabel: h.StateDescription || '', channel: h.ChannelName || '',
    createdBy: h.CreatedByName || h.CreatedByUser || '', createdByUser: h.CreatedByUser || '', createdAt: h.CreatedDate ? new Date(String(h.CreatedDate).replace(' ', 'T')) : null,
    createdByJobTitle: h.CreatedByJobName || '',
    memberCount: Number(h.MemberCount) || 0, isManager: flag('MyIsManager'), isCreator: flag('MyIsCreator'),
    forwardedFrom: h.OrginalChannelName || '', history, flag: flagOf(h),
    channelId: Number(h.ChannelID) || 0, categoryId: Number(h.CategoryID) || 0,
    originalTicketId: Number(h.OrginalTicketID) || 0, assignee: assigneeOf(h), sla: slaOf(h),
    can: {
      send: flag('CanSend'), adminNote: flag('CanWriteAdminNote'), start: flag('CanStart'), hold: flag('CanHold'),
      end: flag('CanEnd'), reopen: flag('CanReopen'), close: flag('CanClose'), forward: flag('CanForward'),
      answerForward: flag('CanAnswerForward'), cancelForward: flag('CanCancelForward'), invite: flag('CanInvite'),
      removeMembers: flag('CanRemoveMembers'), leave: flag('CanLeave'),
      assign: flag('CanAssign'), take: flag('CanTake'), unassign: flag('CanUnassign'),
    },
  };
}

// Ticket state change: action = 'Start' | 'Hold' | 'End' | 'Reopen' | 'Close'.
// The SP checks the caller's role and the current state, and posts a system line.
export async function changeTicketState(ticketId, action) {
  const res = await apiExec(TICKET_PROC, 'Change ticket state', { TicketID: ticketId, Action: action });
  return res?.data?.List0?.[0] || null;
}

// Forwarding (the SP checks it all again): a New ticket goes to a channel of the
// same category and waits there (state 3) until that channel's managers accept
// or reject it. The target channel's admins / team leaders and the ticket's
// creator always join the copy; members = [{ id, cc }] adds others.
export async function forwardTicket(ticketId, toChannelId, members = []) {
  await apiExec(TICKET_PROC, 'Forward ticket', {
    TicketID: ticketId, ToChannelID: toChannelId, Members: members.map(m => ({ UserID: m.id, IsCC: m.cc ? 1 : 0 })),
  });
}
// on the waiting copy; rejecting deletes the copy (the caller leaves it)
export async function answerForward(ticketId, accept) {
  await apiExec(TICKET_PROC, 'Answer forward', { TicketID: ticketId, Accept: accept ? 1 : 0 });
}
// on the original (the forwarder or its managers)
export async function cancelForward(ticketId) {
  await apiExec(TICKET_PROC, 'Cancel forward', { TicketID: ticketId });
}

// The Channels board: the caller's tickets (member, not left) -- open ones
// (state < 50, up to 2000) or, closed = true, the newest 200 closed ones.
// since = a previous mark: only the tickets that changed after it, in any
// state, with left = true for tickets the caller left (TicketHistory /
// TicketMembers RowVer). Returns { rows, mark, more }: mark = the watermark for
// the next delta (0 = the server has no RowVer yet: reload in full instead);
// more = the delta hit its cap (reload in full).
export const TICKET_DELTA_CAP = 2000;
const ticketDateOf = (v) => (v ? new Date(String(v).replace(' ', 'T')) : null);
// one 'Ticket list' row (also what 'New ticket' returns) as the board's ticket
export const toBoardTicket = (r) => ({
  id: Number(r.TicketID), subject: r.TicketSubject || `Ticket #${r.TicketID}`, state: Number(r.TicketState),
  stateLabel: r.StateDescription || '', channelId: Number(r.ChannelID) || 0, channel: r.ChannelName || '',
  createdBy: String(r.CreatedByUser || '').toLowerCase(), createdByName: r.CreatedByName || r.CreatedByUser || 'Unknown',
  created: ticketDateOf(r.CreatedDate), last: ticketDateOf(r.LastMaintDate) || ticketDateOf(r.CreatedDate), lastMessage: r.LastMessage || '',
  unread: Number(r.Unread) || 0, left: Number(r.IsLeft) > 0, flag: flagOf(r), assignee: assigneeOf(r), sla: slaOf(r), raw: r,
});
export async function loadTickets({ closed = false, since = 0 } = {}) {
  const line = since ? { Since: since } : closed ? { Closed: 1 } : {};
  const res = await apiExec(TICKET_PROC, 'Ticket list', line);
  const list = res?.data?.List0 || [];
  return { rows: list.map(toBoardTicket), mark: Number(res?.data?.List1?.[0]?.Mark) || 0, more: since > 0 && list.length > TICKET_DELTA_CAP };
}

// New ticket: the channels the caller can see (favorites and his own first) ...
export async function loadChannels() {
  const res = await apiExec(TICKET_PROC, 'Channel list', {});
  return (res?.data?.List0 || []).map(r => ({
    id: Number(r.ChannelID), name: r.Name || `Channel ${r.ChannelID}`, category: r.CategoryDescription || '',
    categoryId: Number(r.CategoryID) || 0, manager: Number(r.MyIsAdmin) > 0 || Number(r.MyIsTeamLeader) > 0,
    private: Number(r.IsPrivate) > 0, favorite: Number(r.IsFavorite) > 0, member: Number(r.IsMember) > 0,
    purpose: r.Purpose || '', examples: r.Examples || '',
  }));
}
// ... a channel's people (its admins / team leaders join every new ticket) ...
export async function loadChannelMembers(channelId) {
  const res = await apiExec(TICKET_PROC, 'Channel members', { ChannelID: channelId });
  return (res?.data?.List0 || []).map(r => ({
    id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || 'Unknown user',
    photoUrl: r.PhotoURL || '', jobTitle: [r.JobName, r.DepartmentName].filter(Boolean).join(' · '),
    admin: Number(r.IsAdmin) > 0, leader: Number(r.IsTeamLeader) > 0,
  }));
}
// ... and the ticket itself: members = [{ id, cc }] (roles come from the channel,
// set by the SP). tempId makes a retried request return the same ticket.
// Resolves to the new ticket's row ('Ticket list' columns).
// excludeAdmins: user ids of the channel's plain admins left off this ticket
// (the SP ignores team leaders there: they always join).
export async function createTicket({ channelId, subject, text, members = [], excludeAdmins = [], tempId }) {
  const res = await apiExec(TICKET_PROC, 'New ticket', {
    ChannelID: channelId, Subject: subject, Text: text, TempTicketID: tempId,
    Members: members.map(m => ({ UserID: m.id, IsCC: m.cc ? 1 : 0 })), ExcludeAdmins: excludeAdmins,
  });
  const row = res?.data?.List0?.[0];
  if (!row?.TicketID) throw new Error('The server did not return the new ticket.');
  return row;
}

// The details panel's "Media, links and docs": { media, docs, links }, newest
// first. Files split by extension (images = media); links are read out of the
// text of messages that carry one.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
export async function loadTicketMedia(ticketId) {
  const res = await apiExec(TICKET_PROC, 'Ticket media', { TicketID: ticketId });
  const seen = new Set();
  const out = { media: [], docs: [], links: [] };
  for (const r of res?.data?.List0 || []) {
    if (seen.has(r.ChatID)) continue;   // the old 'New Chat' saved some messages twice
    seen.add(r.ChatID);
    const at = r.CreatedDate ? new Date(String(r.CreatedDate).replace(' ', 'T')) : null;
    const base = { chatId: r.ChatID, at, from: r.FromName || '' };
    if (Number(r.AttachmentID) > 0 && r.FileURL) {
      const ext = String(r.FileExtension || '').replace(/^\./, '').toLowerCase();
      const file = {
        id: Number(r.AttachmentID), name: r.FileOrginalName || r.FileName || 'Attachment', ext, url: r.FileURL,
        size: Number(r.FileSize) || 0, sizeText: Number(r.FileSize) ? '' : String(r.FileSize || ''),
        image: IMAGE_EXT.has(ext), audio: AUDIO_EXT.has(ext),
      };
      (file.image ? out.media : out.docs).push({ ...base, file });
    } else {
      const text = String(r.Text || '').replace(/<[^>]*>/g, ' ');
      for (const raw of text.match(URL_RE) || []) {
        const url = raw.replace(/[).,;!?]+$/, '');
        out.links.push({ ...base, url: /^https?:/i.test(url) ? url : `https://${url}` });
      }
    }
  }
  return out;
}

// The ticket members panel: managers (admins / team leaders) first.
export async function loadTicketMembers(ticketId) {
  const res = await apiExec(TICKET_PROC, 'Ticket members', { TicketID: ticketId });
  return (res?.data?.List0 || []).map(r => ({
    id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || 'Unknown user',
    photoUrl: r.PhotoURL || '', jobTitle: r.JobName || '',
    admin: Number(r.IsAdmin) > 0, leader: Number(r.IsTeamLeader) > 0, cc: Number(r.IsCC) > 0,
    creator: Number(r.IsCreator) > 0, me: Number(r.IsMe) > 0,
  }));
}

// Ticket membership (the SP enforces: admins / team leaders invite and
// remove, not the creator; anyone leaves but not the last admin / team leader
// of an open ticket; roles of invited people come from the channel).
// adminIds: the invitees to make ticket admins (managers only; the SP checks)
export async function inviteTicketMembers(ticketId, userIds, adminIds = []) {
  const admins = new Set(adminIds);
  await apiExec(TICKET_PROC, 'Invite ticket members', {
    TicketID: ticketId, Members: userIds.map(id => ({ UserID: id, IsCC: 0, IsAdmin: admins.has(id) ? 1 : 0 })),
  });
}
export async function removeTicketMember(ticketId, userId) {
  await apiExec(TICKET_PROC, 'Remove ticket member', { TicketID: ticketId, UserID: userId });
}
export async function leaveTicket(ticketId) {
  await apiExec(TICKET_PROC, 'Leave ticket', { TicketID: ticketId });
}
// An Ended ticket leaves the caller's own Home list now (not at night); his
// phone reloads its list. The ticket and the other members are untouched.
export async function removeEndedTicket(ticketId) {
  await apiExec(TICKET_PROC, 'Remove ended ticket', { TicketID: ticketId });
}

// The group details panel: { members (admins first, with photo / job / badges), creator }.
export async function loadGroupMembers(groupId) {
  const res = await apiExec(PROC, 'Group members', { GroupID: groupId });
  const members = (res?.data?.List0 || []).map(r => ({
    id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || 'Unknown user',
    photoUrl: r.PhotoURL || '', jobTitle: [r.JobName, r.DepartmentName].filter(Boolean).join(' · '),
    admin: Number(r.IsAdmin) > 0, creator: Number(r.IsCreator) > 0, me: Number(r.IsMe) > 0,
  }));
  const c = res?.data?.List1?.[0];
  const creator = c && (c.CreatedByUsername || c.CreatedByName) ? {
    name: c.CreatedByName || c.CreatedByUsername, username: String(c.CreatedByUsername || '').toLowerCase(),
    photoUrl: c.CreatedByPhotoURL || '', at: c.CreatedDate ? new Date(String(c.CreatedDate).replace(' ', 'T')) : null,
    isMember: Number(c.CreatorIsMember) > 0,
  } : null;
  return { members, creator };
}

// Group admins: lock (only admins send) / unlock the chat. Returns
// { locked, system } -- system is the posted system line (null when nothing changed).
export async function setGroupLock(groupId, locked) {
  const res = await apiExec(PROC, 'Lock group chat', { GroupID: groupId, Locked: locked ? 1 : 0 });
  const r = res?.data?.List0?.[0] || {};
  return {
    locked: Number(r.ChatIsLocked) > 0,
    system: r.SystemChatID ? { id: r.SystemChatID, sortId: r.SystemChatID, system: true, text: String(r.SystemText || ''), at: new Date() } : null,
  };
}

// Group admins: make a member an admin (admin = true) or dismiss one.
// Returns { userId, admin, system } -- system is the posted line (null when nothing changed).
export async function setGroupAdmin(groupId, userId, admin) {
  const res = await apiExec(PROC, 'Set group admin', { GroupID: groupId, UserID: userId, Admin: admin ? 1 : 0 });
  const r = res?.data?.List0?.[0] || {};
  return {
    userId: r.UserID, admin: Number(r.IsAdmin) > 0,
    system: r.SystemChatID ? { id: r.SystemChatID, sortId: r.SystemChatID, system: true, text: String(r.SystemText || ''), at: new Date() } : null,
  };
}

// Group membership (the SP enforces: admins add / remove, not the creator,
// anyone leaves but not the last admin). Each returns
// { changed, memberCount, system } -- system is the posted line.
const membershipResult = (res) => {
  const r = res?.data?.List0?.[0] || {};
  return {
    changed: Number(r.Changed) || 0, memberCount: Number(r.MemberCount) || 0,
    system: r.SystemChatID ? { id: r.SystemChatID, sortId: r.SystemChatID, system: true, text: String(r.SystemText || ''), at: new Date() } : null,
  };
};
export async function addGroupMembers(groupId, userIds) {
  return membershipResult(await apiExec(PROC, 'Add group members', { GroupID: groupId, UserIDs: userIds }));
}
export async function removeGroupMember(groupId, userId) {
  return membershipResult(await apiExec(PROC, 'Remove group member', { GroupID: groupId, UserID: userId }));
}
export async function leaveGroup(groupId) {
  return membershipResult(await apiExec(PROC, 'Leave group', { GroupID: groupId }));
}

const toPickerUser = (r) => ({
  id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || 'Unknown user',
  photoUrl: r.PhotoURL || '', jobTitle: [r.JobName, r.DepartmentName].filter(Boolean).join(' · '),
  userGroup: r.UserGroupName || '', userGroupId: Number(r.UserGroupID) || 0,
});
const toUserGroup = (r) => ({ id: r.UserGroupID, name: r.UserGroupName || `Group ${r.UserGroupID}`, count: Number(r.ActiveUsers) || 0 });

// The people directory: every active user (but the caller) and the user
// groups, loaded once after sign-in and kept for the session; reloaded every
// 30 minutes (startDirectory) and by the Refresh buttons (loadDirectory
// { force }). The pickers search it locally. A server without 'Find users'
// All (SQLScript/APISilaWebOperation.sql) still stops at 100 rows: then the
// directory is not complete and the pickers search the server as before.
const DIRECTORY_EVERY_MS = 30 * 60_000;
const OLD_FIND_CAP = 100;
let directory = null;        // { users, groups, complete, at }
let directoryLoad = null;
const directoryListeners = new Set();
export function loadDirectory({ force = false } = {}) {
  if (directory && !force) return Promise.resolve(directory);
  if (!directoryLoad) {
    directoryLoad = Promise.all([
      apiExec(PROC, 'Find users', { Search: '', Top: 2000, All: 1 }),
      apiExec(PROC, 'User groups', {}),
    ]).then(([u, g]) => {
      const users = (u?.data?.List0 || []).map(toPickerUser);
      directory = { users, groups: (g?.data?.List0 || []).map(toUserGroup), complete: users.length !== OLD_FIND_CAP, at: Date.now() };
      directoryListeners.forEach(fn => fn(directory));
      return directory;
    }).finally(() => { directoryLoad = null; });
  }
  return directoryLoad;
}
// open pickers follow a reload; returns the unsubscribe
export function onDirectory(fn) { directoryListeners.add(fn); return () => directoryListeners.delete(fn); }
// after sign-in (HomeShell): load now, then every 30 minutes; returns the stop
export function startDirectory() {
  loadDirectory({ force: !directory || Date.now() - directory.at > DIRECTORY_EVERY_MS }).catch(() => {});
  const t = setInterval(() => loadDirectory({ force: true }).catch(() => {}), DIRECTORY_EVERY_MS);
  return () => clearInterval(t);
}
export function clearDirectory() { directory = null; }

// The same matching and order as the SP: name / username / user group contains
// the text, names starting with it first, then by name.
function searchDirectory(users, search, top, userGroupId) {
  const t = search.toLowerCase();
  const has = (v) => !!v && v.toLowerCase().includes(t);
  const starts = (u) => u.name.toLowerCase().startsWith(t) || u.username.startsWith(t);
  return users
    .filter(u => (!userGroupId || u.userGroupId === userGroupId) && (!t || has(u.name) || has(u.username) || has(u.userGroup)))
    .sort((a, b) => (t ? starts(b) - starts(a) : 0) || a.name.localeCompare(b.name))
    .slice(0, Math.min(top, userGroupId ? 300 : 100));
}

// People picker (new group / new chat): active users, not the caller. The
// search also matches the user group's name; userGroupId narrows to one group.
export async function findUsers(search = '', top = 30, userGroupId = 0) {
  if (directory?.complete) return searchDirectory(directory.users, search, top, userGroupId);
  const res = await apiExec(PROC, 'Find users', { Search: search, Top: top, UserGroupID: userGroupId || 0 });
  return (res?.data?.List0 || []).map(toPickerUser);
}

// User groups (UserGroupMaster) with how many active users each has: the picker's filter.
export async function loadUserGroups() {
  if (directory) return directory.groups;
  const res = await apiExec(PROC, 'User groups', {});
  return (res?.data?.List0 || []).map(toUserGroup);
}

// Creates a group: the caller becomes creator + admin. members: [{ id, admin }].
// Returns { groupId, name }.
export async function createGroup(name, members) {
  const res = await apiExec(PROC, 'Create group', {
    Name: name, Members: members.map(m => ({ UserID: m.id, IsAdmin: m.admin ? 1 : 0 })),
  });
  const r = res?.data?.List0?.[0];
  if (!r?.GroupID) throw new Error('The server did not return the new group.');
  return { groupId: r.GroupID, name: r.GroupName };
}

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
