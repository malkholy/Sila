// System Settings (master lists): dbo.APISilaWebOperation 'Settings users' /
// 'Settings user groups' / 'Settings channels', read-only, plus the one write,
// 'Save channel purpose' (what a channel handles). The SP allows the user 'mhd'
// only; the app just hides the button for everyone else.
import { apiExec } from './auth.js';

const PROC = 'dbo.APISilaWebOperation';
export const SETTINGS_USER = 'mhd';
export const canSeeSettings = (username) => String(username || '').toLowerCase() === SETTINGS_USER;

const date = (v) => (v ? new Date(String(v).replace(' ', 'T')) : null);
const flag = (v) => Number(v) > 0;

export async function loadSettingsUsers() {
  const res = await apiExec(PROC, 'Settings users', {});
  return (res?.data?.List0 || []).map(r => ({
    id: r.UserID, username: r.Username || '', name: r.FullName || r.Username || '', job: r.JobName || '',
    department: r.DepartmentName || '', quickGroup: r.QuickGroupName || '', silaGroupId: r.SilaGroupID,
    silaGroup: r.SilaGroupName || '', mobile: r.MobileNumber || '', local: r.LocalNumber || '',
    admin: flag(r.IsAdmin), developer: flag(r.IsDeveloper), active: !flag(r.IsNotActive), forceLogout: flag(r.ForceLogout),
    created: date(r.CreatedDate), createdBy: r.CreatedBy || '', passwordChanged: date(r.ChangePasswordDate),
    photoUrl: r.PhotoURL || '',
  }));
}

export async function loadSettingsUserGroups() {
  const res = await apiExec(PROC, 'Settings user groups', {});
  const groups = (res?.data?.List0 || []).map(r => ({
    id: r.GroupID, name: r.GroupName || `Group ${r.GroupID}`, createdBy: r.CreatedBy || '', created: date(r.CreatedDate),
    changedBy: r.LastMintBy || '', changed: date(r.LastMintDate), activeUsers: Number(r.ActiveUsers) || 0,
    allUsers: Number(r.AllUsers) || 0,
  }));
  const o = res?.data?.List1?.[0] || {};
  return {
    groups,
    orphans: { users: Number(o.OrphanUsers) || 0, active: Number(o.OrphanActiveUsers) || 0, groupIds: Number(o.OrphanGroupIDs) || 0 },
  };
}

export async function loadSettingsChannels() {
  const res = await apiExec(PROC, 'Settings channels', {});
  return (res?.data?.List0 || []).map(r => ({
    id: r.ChannelID, name: r.Name || `Channel ${r.ChannelID}`, categoryId: r.CategoryID, category: r.CategoryDescription || '',
    active: !flag(r.InActive), private: flag(r.IsPrivate), created: date(r.CreatedDate), createdBy: r.CreatedBy || '',
    changed: date(r.LastMaintDate), changedBy: r.LastMaintBy || '', members: Number(r.Members) || 0,
    admins: Number(r.Admins) || 0, leaders: Number(r.TeamLeaders) || 0, openTickets: Number(r.OpenTickets) || 0,
    allTickets: Number(r.AllTickets) || 0, purpose: r.Purpose || '', offer: flag(r.OfferInAssistant),
  }));
}

// One channel for the details drawer: { channel, members, states, tickets }.
export async function loadSettingsChannel(channelId) {
  const res = await apiExec(PROC, 'Settings channel', { ChannelID: channelId });
  const c = res?.data?.List0?.[0];
  if (!c) throw new Error('Channel not found.');
  return {
    channel: {
      id: c.ChannelID, name: c.Name || `Channel ${c.ChannelID}`, categoryId: c.CategoryID, category: c.CategoryDescription || '', active: !flag(c.InActive),
      private: flag(c.IsPrivate), created: date(c.CreatedDate), createdBy: c.CreatedByName || c.CreatedBy || '',
      changed: date(c.LastMaintDate), changedBy: c.LastMaintByName || c.LastMaintBy || '',
      purpose: c.Purpose || '', examples: c.Examples || '', offer: flag(c.OfferInAssistant),
      purposeBy: c.PurposeByName || c.PurposeBy || '', purposeAt: date(c.PurposeDate),
      replyTarget: c.ReplyTarget == null ? null : Number(c.ReplyTarget), finishTarget: c.FinishTarget == null ? null : Number(c.FinishTarget),
    },
    members: (res?.data?.List1 || []).map(m => ({
      id: m.UserID, username: String(m.Username || '').toLowerCase(), name: m.FullName || m.Username || '',
      title: [m.JobName, m.DepartmentName].filter(Boolean).join(' · '), photoUrl: m.PhotoURL || '',
      admin: flag(m.IsAdmin), leader: flag(m.IsTeamLeader), since: date(m.CreatedDate), active: !flag(m.IsNotActive),
    })),
    states: (res?.data?.List2 || []).map(s => ({
      state: Number(s.TicketState), label: s.StateDescription || `State ${s.TicketState}`, count: Number(s.Tickets) || 0,
      last: date(s.LastUpdate),
    })),
    tickets: (res?.data?.List3 || []).map(t => ({
      id: t.TicketID, subject: t.TicketSubject || `Ticket #${t.TicketID}`, state: Number(t.TicketState),
      stateLabel: t.StateDescription || '', created: date(t.CreatedDate), createdBy: t.CreatedByName || t.CreatedByUser || '',
      last: date(t.LastMaintDate),
    })),
  };
}

// What a channel handles (dbo.SilaChannelPurpose): shown in the New ticket
// picker and used by the assistant. Returns the saved values.
export async function saveChannelPurpose(channelId, { purpose, examples, offer }) {
  const res = await apiExec(PROC, 'Save channel purpose', {
    ChannelID: channelId, Purpose: purpose, Examples: examples, OfferInAssistant: offer ? 1 : 0,
  });
  const r = res?.data?.List0?.[0] || {};
  return {
    purpose: r.Purpose || '', examples: r.Examples || '', offer: flag(r.OfferInAssistant),
    purposeBy: r.PurposeBy || '', purposeAt: date(r.PurposeDate),
  };
}

// Channels and their members (mhd only, checked in the SP). Existing tickets keep
// their roles; new tickets copy them from the channel.
export async function loadChannelCategories() {
  const res = await apiExec(PROC, 'Settings channel categories', {});
  return (res?.data?.List0 || []).map(r => ({ id: r.ChannelCategoryID, name: r.CategoryDescription || `Category ${r.ChannelCategoryID}`, channels: Number(r.Channels) || 0 }));
}
// id 0 = a new channel; resolves to its ChannelID
export async function saveChannel({ id = 0, name, categoryId, isPrivate, active = true, purpose = '', examples = '' }) {
  const res = await apiExec(PROC, 'Save channel', {
    ChannelID: id, Name: name, CategoryID: categoryId, IsPrivate: isPrivate ? 1 : 0, InActive: active ? 0 : 1,
    Purpose: purpose, Examples: examples,
  });
  return Number(res?.data?.List0?.[0]?.ChannelID) || 0;
}
export async function addChannelMembers(channelId, userIds) {
  const res = await apiExec(PROC, 'Add channel members', {
    ChannelID: channelId, Members: userIds.map(id => ({ UserID: id, IsAdmin: 0, IsTeamLeader: 0 })),
  });
  return Number(res?.data?.List0?.[0]?.Added) || 0;
}
export async function setChannelMember(channelId, userId, { admin, leader }) {
  await apiExec(PROC, 'Set channel member', { ChannelID: channelId, UserID: userId, IsAdmin: admin ? 1 : 0, IsTeamLeader: leader ? 1 : 0 });
}
export async function removeChannelMember(channelId, userId) {
  await apiExec(PROC, 'Remove channel member', { ChannelID: channelId, UserID: userId });
}

// Sila user groups (dbo.UserGroupMaster; a user's group is UserMaster.GroupID).
export async function loadSettingsUserGroup(groupId) {
  const res = await apiExec(PROC, 'Settings user group', { GroupID: groupId });
  const g = res?.data?.List0?.[0];
  if (!g) throw new Error('Group not found.');
  return {
    group: { id: g.GroupID, name: g.GroupName || `Group ${g.GroupID}`, createdBy: g.CreatedBy || '', created: date(g.CreatedDate),
      changedBy: g.LastMintBy || '', changed: date(g.LastMintDate) },
    users: (res?.data?.List1 || []).map(u => ({
      id: u.UserID, username: String(u.Username || '').toLowerCase(), name: u.FullName || u.Username || '',
      title: [u.JobName, u.DepartmentName].filter(Boolean).join(' · '), photoUrl: u.PhotoURL || '', active: !flag(u.IsNotActive),
    })),
  };
}
// id 0 = a new group; resolves to its GroupID
export async function saveUserGroup(id, name) {
  const res = await apiExec(PROC, 'Save user group', { GroupID: id || 0, GroupName: name });
  return Number(res?.data?.List0?.[0]?.GroupID) || 0;
}
export async function deleteUserGroup(id) {
  await apiExec(PROC, 'Delete user group', { GroupID: id });
}
export async function moveUsersToGroup(groupId, userIds) {
  const res = await apiExec(PROC, 'Set users group', { GroupID: groupId, UserIDs: userIds });
  return Number(res?.data?.List0?.[0]?.Moved) || 0;
}

// A channel's SLA targets in WORKING minutes (Sat-Thu 08:00-16:00; a working
// day = 480); null / 0 = no target. Resolves to the saved { replyTarget, finishTarget }.
export async function saveChannelSla(channelId, replyMinutes, finishMinutes) {
  const res = await apiExec(PROC, 'Save channel sla', {
    ChannelID: channelId, FirstReplyMinutes: replyMinutes || 0, FinishMinutes: finishMinutes || 0,
  });
  const r = res?.data?.List0?.[0] || {};
  return { replyTarget: r.FirstReplyMinutes == null ? null : Number(r.FirstReplyMinutes), finishTarget: r.FinishMinutes == null ? null : Number(r.FinishMinutes) };
}
