// Mail Monitor (System Settings): POST /api/v2/mail/admin { action, userId? }.
// SilaApi checks the user is a mail admin calling from the company network
// (server side) and answers from the last snapshot the Mail Connector API
// pushed (every 15 s): { pushedAt, data }. The app only shows the tab to the
// settings user; that grants nothing by itself.
import { authPost } from './auth.js';

async function send(action, userId) {
  try {
    return await authPost('/api/v2/mail/admin', userId == null ? { action } : { action, userId });
  } catch (err) {
    // A server without the Mail Monitor (an older SilaApi) has no such address.
    if (err.status === 404 && (action !== 'account' || /^Request failed/.test(err.message))) {
      throw Object.assign(new Error('This Sila server does not have the Mail Monitor yet: SilaApi (7400) needs the update that adds it.'), { status: 404 });
    }
    throw err;
  }
}
// The connector's figures, and when it sent them.
async function call(action, userId) {
  const res = await send(action, userId);
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
      link: p.LinkStatus || 'Down', lastError: p.LastError || '', lastErrorAt: date(p.LastErrorAt) },
    errors: { open: num(e.OpenErrors), occurrences: num(e.Occurrences) },
    runs: (d.recentSyncs || []).map(run),
    at: date(d.time),
    pushedAt,
  };
}

export async function loadMailAccounts() {
  const { data: rows } = await call('accounts');
  return (rows || []).map(r => ({
    id: r.UserID, email: r.SmtpAddress || '', name: r.DisplayName || '', enabled: Boolean(r.IsEnabled),
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
  return send('sync', userId);
}
