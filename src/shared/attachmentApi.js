// Client for the standalone AttachmentApi (.NET, AttachmentApi/ in the repo
// root) -- a REST/multipart API separate from the main SP_Name gateway
// (src/shared/api.js), since that gateway is JSON-only and can't carry file
// bytes. Same identity model as the rest of the app: no token, just the
// logged-in username, checked server-side against V1UserPagePermissions.
const BASE_URL = 'https://quick.glcpaints.com:1010';

function currentUser() {
  return sessionStorage.getItem('Username') || sessionStorage.getItem('FullName') || '';
}

async function parseJsonOrThrow(res, fallbackMessage) {
  let body = null;
  try { body = await res.json(); } catch { /* no JSON body */ }
  if (!res.ok) throw new Error(body?.message || body?.detail || fallbackMessage);
  return body;
}

// entityType/entityKey identify the business record, e.g. ('PurchaseOrder', '2700001').
// pageGroupId is the page that owns it, for the server's permission check.
export async function listAttachments(entityType, entityKey, pageGroupId) {
  const qs = new URLSearchParams({
    entityType, entityKey, pageGroupId: String(pageGroupId), user: currentUser(),
  });
  const res = await fetch(`${BASE_URL}/api/attachments?${qs}`);
  return parseJsonOrThrow(res, 'Failed to load attachments');
}

export async function uploadAttachment(entityType, entityKey, pageGroupId, file) {
  const form = new FormData();
  form.append('file', file);
  form.append('entityType', entityType);
  form.append('entityKey', entityKey);
  form.append('pageGroupId', String(pageGroupId));
  form.append('user', currentUser());
  const res = await fetch(`${BASE_URL}/api/attachments`, { method: 'POST', body: form });
  return parseJsonOrThrow(res, 'Upload failed');
}

export async function deleteAttachment(attachmentId) {
  const qs = new URLSearchParams({ user: currentUser() });
  const res = await fetch(`${BASE_URL}/api/attachments/${attachmentId}?${qs}`, { method: 'DELETE' });
  return parseJsonOrThrow(res, 'Delete failed');
}

// View opens the file in a new tab (inline, for PDFs/images the browser can
// render); Download forces a Save As. Both are plain URLs -- no fetch
// needed, just window.open / an <a href>.
export function attachmentViewUrl(attachmentId) {
  const qs = new URLSearchParams({ user: currentUser(), inline: 'true' });
  return `${BASE_URL}/api/attachments/${attachmentId}/download?${qs}`;
}
export function attachmentDownloadUrl(attachmentId) {
  const qs = new URLSearchParams({ user: currentUser() });
  return `${BASE_URL}/api/attachments/${attachmentId}/download?${qs}`;
}
