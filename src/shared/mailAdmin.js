// Mail Monitor (System Settings): POST <Mail API>/mail/v1/admin { action, ... }
// on the Sila Mail API (silamail.glcpaints.com:9001 -- DNS picks the copy:
// inside, live figures from InternalMail; outside, the snapshot the Mail
// Connector API pushes every 15 s). It checks the user is a mail admin from an
// allowed place (server side) and answers { pushedAt, data }. The app only
// shows the tab to the settings user; that grants nothing by itself.
import { authPost } from './auth.js';

// Dev: '' = same origin, through the Vite proxy (vite.config.js '/mail/v1').
export const MAIL_BASE = import.meta.env.VITE_SILA_MAIL ?? (import.meta.env.DEV ? '' : 'https://silamail.glcpaints.com:9001');

async function send(body) {
  try {
    return await authPost(`${MAIL_BASE}/mail/v1/admin`, body);
  } catch (err) {
    if (err.status === 0) {
      throw Object.assign(new Error('Cannot reach the Sila Mail API (silamail.glcpaints.com:9001).'), { status: 0 });
    }
    throw err;
  }
}
// The connector's figures, and when it sent them.
async function call(action, userId) {
  const res = await send(userId == null ? { action } : { action, userId });
  return { data: res?.data, pushedAt: res?.pushedAt ? new Date(res.pushedAt) : null };
}

// The connector sends server-local times without a zone ("2026-10-25T13:53:49.123").
const date = (v) => (v ? new Date(String(v).replace(' ', 'T')) : null);
const num = (v) => Number(v) || 0;

const run = (r) => ({
  id: r.SyncLogID, userId: r.UserID, mailbox: r.SmtpAddress || '', kind: r.Kind, reason: r.Reason || '', folder: r.Folder || '',
  started: date(r.StartedAt), ended: date(r.EndedAt), pages: num(r.Pages), added: num(r.Added), changed: num(r.Changed),
  deleted: num(r.Deleted), matched: num(r.Matched), ok: r.Succeeded == null ? null : Boolean(r.Succeeded),
  errorKind: r.ErrorKind || '', errorCode: r.ErrorCode || '', errorMessage: r.ErrorMessage || '',
});

const error = (r) => ({
  id: r.ErrorID, type: r.ErrorType, userId: r.UserID, mailbox: r.SmtpAddress || '', folder: r.Folder || '',
  code: r.Code || '', message: r.Message || '', count: num(r.Count), first: date(r.FirstSeenAt), last: date(r.LastSeenAt),
});

// A Mail Connector API heartbeat (MailServiceHeartbeat): one row per component
// (Connector, ExchangeSync, Publisher). secondsAgo is by the database's clock at
// read time; Metrics is the component's JSON (times there carry their offset).
function service(r) {
  let metrics = {};
  try { metrics = JSON.parse(r.Metrics || '{}') || {}; } catch { /* bad JSON: no figures */ }
  return {
    component: r.Component, instance: r.Instance || '', started: date(r.StartedAt), lastBeat: date(r.LastBeatAt),
    secondsAgo: num(r.SecondsAgo), metrics, lastOk: metrics.lastOkAt ? new Date(metrics.lastOkAt) : null,
    lastError: r.LastError || '', lastErrorAt: date(r.LastErrorAt),
  };
}

export async function loadMailOverview() {
  const { data: d, pushedAt } = await call('overview');
  const a = d.accounts || {}, c = d.content || {}, p = d.publish || {}, e = d.errors || {};
  return {
    accounts: { total: num(a.Mailboxes), ok: num(a.Ok), behind: num(a.Behind), error: num(a.Error), disabled: num(a.Disabled),
      oldestSync: date(a.OldestSyncAt), lastSync: date(a.LastSyncAt) },
    content: { folders: num(c.Folders), exchangeItems: num(c.ExchangeItems), exchangeUnread: num(c.ExchangeUnread),
      messages: num(c.Messages), unread: num(c.Unread), markedDeleted: num(c.MarkedDeleted), bodies: num(c.Bodies),
      attachments: num(c.Attachments), inline: num(c.InlineImages), attachmentBytes: num(c.AttachmentBytes) },
    publish: { lastPublished: num(p.LastPublishedSeq), lastChange: num(p.LastChangeSeq), at: date(p.LastPublishedAt),
      attemptAt: date(p.LastAttemptAt), responseMs: num(p.LastResponseMs),
      link: p.LinkStatus || 'Down', lastError: p.LastError || '', lastErrorAt: date(p.LastErrorAt) },
    errors: { open: num(e.OpenErrors), occurrences: num(e.Occurrences) },
    runs: (d.recentSyncs || []).map(run),
    services: (d.services || []).map(service),
    at: date(d.time),
    pushedAt,
  };
}

export async function loadMailAccounts() {
  const { data: rows } = await call('accounts');
  return (rows || []).map(r => ({
    id: r.UserID, email: r.SmtpAddress || '', name: r.DisplayName || '', username: r.Username || '', enabled: Boolean(r.IsEnabled),
    status: r.IsEnabled ? r.SyncStatus || 'OK' : 'Disabled', subscription: r.SubscriptionStatus || '',
    lastSync: date(r.LastSyncAt), lastAttempt: date(r.LastSyncAttemptAt), failures: num(r.ConsecutiveFailures),
    lastErrorKind: r.LastErrorKind || '', lastErrorCode: r.LastErrorCode || '', lastErrorAt: date(r.LastErrorAt),
    folders: num(r.Folders), foldersOk: num(r.FoldersOk), exchangeItems: num(r.ExchangeItems), exchangeUnread: num(r.ExchangeUnread),
    messages: num(r.Messages), unread: num(r.Unread), bodies: num(r.Bodies), attachments: num(r.Attachments),
    openErrors: num(r.OpenErrors), running: Boolean(r.Running), runningKind: r.RunningKind || '', runningFolder: r.RunningFolder || '',
  }));
}

// One mailbox for the drawer: { account, folders, runs, errors, pushedAt }. The
// first time, SilaApi asks the connector for it and waits (up to ~25 s).
export async function loadMailAccount(userId) {
  const { data: d, pushedAt } = await call('account', userId);
  const a = d.account || {};
  return {
    account: { id: a.UserID, email: a.SmtpAddress || '', name: a.DisplayName || '', enabled: Boolean(a.IsEnabled),
      status: a.IsEnabled ? a.SyncStatus || 'OK' : 'Disabled', lastSync: date(a.LastSyncAt), lastAttempt: date(a.LastSyncAttemptAt),
      failures: num(a.ConsecutiveFailures), lastErrorCode: a.LastErrorCode || '' },
    folders: (d.folders || []).map(f => ({
      id: f.FolderID, name: f.DisplayName || '', type: f.FolderType || '', exchangeTotal: num(f.TotalCount), exchangeUnread: num(f.UnreadCount),
      messages: num(f.DbCount), unread: num(f.DbUnread), bodies: num(f.DbBodies), attachments: num(f.DbAttachments),
      status: f.FolderSyncStatus || '', lastSync: date(f.LastSyncAt),
    })),
    runs: (d.recentSyncs || []).map(run),
    errors: (d.errors || []).map(error),
    pushedAt,
  };
}

export async function loadMailErrors() {
  return ((await call('errors')).data || []).map(error);
}

// Ask for a full sync of the mailbox (all folders); the connector picks it up
// with its next push (within ~15 s).
export function syncMailbox(userId) {
  return send({ action: 'sync', userId });
}

// Add a Sila user's mailbox with the address the mail admin typed (and the
// user's Sila username: the Mail API finds a signed-in user's mailbox by it).
// The connector checks it with Exchange. Inside, the answer comes at once:
// { done: true, ok, message }; outside it is queued: { requestId } -- poll
// addMailboxResult(requestId).
export function addMailbox(userId, email, username, displayName) {
  return send({ action: 'add', userId, email, username, displayName: displayName || null });
}

// { pending: true } until the connector has answered; then { ok, message }.
export function addMailboxResult(requestId) {
  return send({ action: 'addResult', requestId });
}
