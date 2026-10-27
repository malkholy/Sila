// The signed-in user's own mailbox, read-only, from the Sila Mail API
// (silamail.glcpaints.com:9001 -- DNS picks the copy: inside, InternalMail;
// outside, the published Mail database). The API finds the mailbox by the
// token's username; nothing here names a mailbox.
import { authGet, getAccessToken } from './auth.js';
import { MAIL_BASE } from './mailAdmin.js';

async function get(path) {
  try {
    return await authGet(`${MAIL_BASE}/mail/v1${path}`);
  } catch (err) {
    if (err.status === 0) {
      throw Object.assign(new Error('Cannot reach the Sila Mail API (silamail.glcpaints.com:9001).'), { status: 0 });
    }
    throw err;
  }
}

// Message dates come in UTC ("...Z"); sync times are the server's local time.
const date = (v) => (v ? new Date(v) : null);

const item = (m) => ({
  id: m.messageId, folderId: m.folderId, subject: m.subject || '', fromName: m.fromName || '', fromAddress: m.fromAddress || '',
  at: date(m.receivedAt), read: Boolean(m.isRead), flag: m.flagStatus || 0, importance: m.importance ?? 1,
  attachments: Boolean(m.hasAttachments), draft: Boolean(m.isDraft), preview: m.preview || '',
});

// 1 To, 2 Cc, 3 Bcc (mail.MailRecipient.RecipientType)
const RECIPIENT = { 1: 'to', 2: 'cc', 3: 'bcc' };

export async function loadMyMailbox() {
  const d = await get('/me');
  return { email: d.email, name: d.displayName || '', syncStatus: d.syncStatus, lastSync: date(d.lastSyncAt),
    published: date(d.publishedAt), copy: d.copy };
}

export async function loadMailFolders() {
  const rows = await get('/folders');
  return (rows || []).map(f => ({ id: f.folderId, parentId: f.parentFolderId, name: f.name, type: f.type, total: f.total, unread: f.unread }));
}

// Newest first; next: the cursor of the following (older) page, or null.
export async function loadMailMessages(folderId, before = null, take = 50) {
  const q = new URLSearchParams({ take: String(take) });
  if (before) q.set('before', before);
  const page = await get(`/folders/${encodeURIComponent(folderId)}/messages?${q}`);
  return { messages: (page.messages || []).map(item), next: page.next || null };
}

export async function loadMailMessage(id) {
  const d = await get(`/messages/${encodeURIComponent(id)}`);
  const recipients = { to: [], cc: [], bcc: [] };
  for (const r of d.recipients || []) recipients[RECIPIENT[r.type] || 'to'].push({ name: r.name || '', address: r.address || '' });
  return {
    ...item(d.message), sent: date(d.sentAt), recipients,
    files: (d.attachments || []).map(a => ({
      id: a.attachmentId, name: a.name, type: a.contentType || '', size: a.size, inline: a.isInline,
      cid: String(a.contentId || '').replace(/^<|>$/g, ''),
    })),
    html: d.html || null, text: d.text || '',
  };
}

export async function searchMail(text, take = 50) {
  const rows = await get(`/search?${new URLSearchParams({ q: text, take: String(take) })}`);
  return (rows || []).map(item);
}

// An attachment's file, with the token (inside the company the Mail API fetches
// it through the Mail Connector API -- from Exchange the first time).
export async function mailAttachmentBlob(id) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(`${MAIL_BASE}/mail/v1/attachments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw Object.assign(new Error('Cannot reach the Sila Mail API (silamail.glcpaints.com:9001).'), { status: 0 });
  }
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw Object.assign(new Error(d?.message || `Could not open the attachment (${res.status}).`), { status: res.status });
  }
  return res.blob();
}

// The types the Mail API sends as they are (anything else comes as a plain download).
const VIEWABLE = /^(image\/(png|jpeg|gif|webp|bmp)|application\/pdf)$/i;

// PDFs and pictures open in a new tab; anything else is saved under its name.
// The tab is opened before the download starts, so the browser does not block it.
export async function openMailAttachment(file) {
  const view = VIEWABLE.test(file.type);
  const tab = view ? window.open('', '_blank') : null;
  try {
    const blob = await mailAttachmentBlob(file.id);
    const url = URL.createObjectURL(blob);
    if (tab) {
      tab.location.href = url;
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = /^message\/rfc822$/i.test(file.type) && !/\.eml$/i.test(file.name) ? `${file.name}.eml` : file.name || 'attachment';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

// A picture shown inside a message (cid:), as a data: URL the message frame can use.
export async function inlineImageUrl(id) {
  const blob = await mailAttachmentBlob(id);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
