// Conversations on the right side: one-to-one chats and groups, through
// dbo.APISilaWebOperation (SQLScript/APISilaWebOperation.sql), and tickets,
// through CHA.APISilaWebTicketOperation (SQLScript/APISilaWebTicketOperation.sql).
// The SPs check the signed-in user belongs to the session / group / ticket;
// the gateway fills @User from the token. chatApi(item) gives one interface
// for all three kinds.
import { apiExec, apiExecIdempotent } from './auth.js';
import { hasFormatting } from './richText.js';

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
      ? { text: String(r.ReplyText), mine: r.ReplyFromUserID === me, name: r.ReplyFromName || '' } : null,
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
// header: { me, title, photoUrl, username, jobTitle, isGroup, locked, isAdmin, memberCount }
//         tickets add { isTicket, ticketId, state, stateLabel, channel, createdBy, can: {...} }
export function chatApi(item) {
  const group = item.kind === 'group';
  const ticket = item.kind === 'ticket';
  const proc = ticket ? TICKET_PROC : PROC;
  const key = ticket ? { TicketID: item.raw?.TicketID } : group ? { GroupID: item.raw?.GroupID } : { SessionID: item.raw?.SessionID };
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
      const res = await apiExec(proc, op.load, { ...key, BeforeChatID: before, AfterChatID: after, Top: PAGE_SIZE });
      const [h] = res?.data?.List0 || [];
      const rows = res?.data?.List1 || [];
      const me = h?.MeUserID;
      const header = !h ? null : ticket ? ticketHeader(h, item) : group ? {
        me, isGroup: true, title: h.GroupName || item.title, photoUrl: h.GroupPhotoURL || '',
        locked: Number(h.ChatIsLocked) > 0, isAdmin: Number(h.IsAdmin) > 0, memberCount: Number(h.MemberCount) || 0,
      } : {
        me, isGroup: false, title: h.OtherName || h.OtherUsername || item.title, photoUrl: h.OtherPhotoURL || '',
        username: String(h.OtherUsername || '').toLowerCase(),
        jobTitle: [h.OtherJobName, h.OtherDepartmentName].filter(Boolean).join(' · '),
      };
      return { header, messages: rows.map(r => toMessage(r, me)).reverse(), hasMore: rows.length === PAGE_SIZE };
    },
    async markRead() {
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
function ticketHeader(h, item) {
  const flag = (k) => Number(h[k]) > 0;
  return {
    me: h.MeUserID, isTicket: true, ticketId: h.TicketID, title: h.TicketSubject || item.title, photoUrl: '',
    state: Number(h.TicketState), stateLabel: h.StateDescription || '', channel: h.ChannelName || '',
    createdBy: h.CreatedByName || h.CreatedByUser || '', createdAt: h.CreatedDate ? new Date(String(h.CreatedDate).replace(' ', 'T')) : null,
    memberCount: Number(h.MemberCount) || 0, isManager: flag('MyIsManager'), isCreator: flag('MyIsCreator'),
    forwardedFrom: h.OrginalChannelName || '',
    can: {
      send: flag('CanSend'), adminNote: flag('CanWriteAdminNote'), start: flag('CanStart'), hold: flag('CanHold'),
      end: flag('CanEnd'), reopen: flag('CanReopen'), close: flag('CanClose'), forward: flag('CanForward'),
      answerForward: flag('CanAnswerForward'), cancelForward: flag('CanCancelForward'), invite: flag('CanInvite'),
      removeMembers: flag('CanRemoveMembers'),
    },
  };
}

// Ticket state change: action = 'Start' | 'Hold' | 'End' | 'Reopen' | 'Close'.
// The SP checks the caller's role and the current state, and posts a system line.
export async function changeTicketState(ticketId, action) {
  const res = await apiExec(TICKET_PROC, 'Change ticket state', { TicketID: ticketId, Action: action });
  return res?.data?.List0?.[0] || null;
}

// The ticket members panel: managers (admins / team leaders) first.
export async function loadTicketMembers(ticketId) {
  const res = await apiExec(TICKET_PROC, 'Ticket members', { TicketID: ticketId });
  return (res?.data?.List0 || []).map(r => ({
    id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || 'Unknown user',
    photoUrl: r.PhotoURL || '', jobTitle: [r.JobName, r.DepartmentName].filter(Boolean).join(' · '),
    admin: Number(r.IsAdmin) > 0, leader: Number(r.IsTeamLeader) > 0, cc: Number(r.IsCC) > 0,
    creator: Number(r.IsCreator) > 0, me: Number(r.IsMe) > 0,
  }));
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

// People picker (new group / new chat): active users, not the caller. The
// search also matches the user group's name; userGroupId narrows to one group.
export async function findUsers(search = '', top = 30, userGroupId = 0) {
  const res = await apiExec(PROC, 'Find users', { Search: search, Top: top, UserGroupID: userGroupId || 0 });
  return (res?.data?.List0 || []).map(r => ({
    id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || 'Unknown user',
    photoUrl: r.PhotoURL || '', jobTitle: [r.JobName, r.DepartmentName].filter(Boolean).join(' · '),
    userGroup: r.UserGroupName || '',
  }));
}

// User groups (UserGroupMaster) with how many active users each has: the picker's filter.
export async function loadUserGroups() {
  const res = await apiExec(PROC, 'User groups', {});
  return (res?.data?.List0 || []).map(r => ({ id: r.UserGroupID, name: r.UserGroupName || `Group ${r.UserGroupID}`, count: Number(r.ActiveUsers) || 0 }));
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
