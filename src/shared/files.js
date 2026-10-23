// Files through the Sila Files API (SilaApi in its "Files" role, :7500):
// the file is uploaded there (type / content check, virus scan, stored on the
// server), then the message pointing at it is posted through /api/v2/exec
// ('Send chat file' / 'Send group chat file' / 'Send ticket file').
// Opening a file goes through the same API with the user's token: the stored
// links (/api/v2/files/...) only open from office networks.
import { DATABASE, getAccessToken } from './auth.js';

// Dev: '' = same origin, through the Vite proxy (vite.config.js '/api/v2/attachments').
export const FILES_BASE = import.meta.env.VITE_SILA_FILES ?? (import.meta.env.DEV ? '' : 'https://sila.glcpaints.com:7500');

// What the Files API accepts (SilaApi/Plus.Api/Attachments/FileTypePolicy.cs) and its size limit.
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.csv,.m4a,.aac,.mp3,.ogg,.opus,.wav,.webm';
export const MAX_BYTES = 50 * 1024 * 1024;

const EXT = new Set(ACCEPT.split(','));
export function checkFile(file) {
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!EXT.has(ext)) return `“${file.name}” can't be sent: allowed are PDF, images (PNG, JPG), Word, Excel, PowerPoint, TXT, CSV and audio (M4A, AAC, MP3, OGG, OPUS, WAV, WEBM).`;
  if (file.size > MAX_BYTES) return `“${file.name}” is larger than 50 MB.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  return '';
}

// Which conversation a file belongs to, as the Files API and its SP name it.
export function fileEntity(item) {
  if (item.kind === 'group') return { entityType: 'Group', entityKey: item.raw?.GroupID };
  if (item.kind === 'ticket') return { entityType: 'Ticket', entityKey: item.raw?.TicketID };
  return { entityType: 'Chat', entityKey: item.raw?.SessionID };
}

// A file stored by the Files API (vs. an older Cloudinary link, opened directly).
export const isFilesApiUrl = (url) => /\/api\/v2\/files\//i.test(String(url || ''));

function errorText(xhrOrRes, body) {
  try { const j = typeof body === 'string' ? JSON.parse(body) : body; if (j?.message) return j.message; } catch { /* not JSON */ }
  const status = xhrOrRes.status;
  if (status === 413) return 'The file is too large.';
  if (status === 0) return 'Cannot reach the file server. Check your connection.';
  return `Upload failed (${status}).`;
}

// Uploads one file; resolves to its AttachmentID. onProgress(0..1) while sending.
export async function uploadFile({ file, entityType, entityKey, onProgress, signal }) {
  const token = await getAccessToken();
  const form = new FormData();
  form.append('database', DATABASE);
  form.append('entityType', entityType);
  form.append('entityKey', String(entityKey));
  form.append('description', file.name.slice(0, 200));
  form.append('file', file, file.name);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${FILES_BASE}/api/v2/attachments`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const id = Number(JSON.parse(xhr.responseText).attachmentID);
          if (id) { resolve(id); return; }
        } catch { /* fall through */ }
        reject(new Error('The file server did not confirm the upload.'));
      } else {
        const err = new Error(errorText(xhr, xhr.responseText));
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error(errorText(xhr, '')));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true }));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}

// Opening a stored file: downloaded with the token, kept as an object URL for
// the session. preview: an image's small JPEG (at most 480 px; the Files API
// makes it once and keeps it) -- the original when the file has none.
// Time limits: a file server that does not answer (e.g. :7500 unreachable)
// fails the request instead of leaving thumbnails on "Loading" for minutes.
const PREVIEW_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 120_000;
const blobs = new Map();   // "<attachmentId>:<p|f>" -> Promise<string>
export function fileBlobUrl({ attachmentId, entityType, entityKey, preview = false }) {
  const key = `${attachmentId}:${preview ? 'p' : 'f'}`;
  if (!blobs.has(key)) {
    const p = (async () => {
      const token = await getAccessToken();
      const q = new URLSearchParams({ database: DATABASE, entityType, entityKey: String(entityKey), inline: 'true' });
      if (preview) q.set('preview', 'true');
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), preview ? PREVIEW_TIMEOUT_MS : FILE_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`${FILES_BASE}/api/v2/attachments/${attachmentId}/download?${q}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: stop.signal,
        });
      } catch (err) {
        throw new Error(err?.name === 'AbortError'
          ? 'The file server did not answer. Try again later.' : 'Cannot reach the file server. Check your connection.');
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(errorText(res, body));
      }
      return URL.createObjectURL(await res.blob());
    })();
    p.catch(() => blobs.delete(key));   // a failure is retried next time
    blobs.set(key, p);
  }
  return blobs.get(key);
}

// Profile photos: the stored links (old photo server, office-only) are fetched
// through the Files API with the user's token (GET /api/v2/photo, SilaApi
// Photos/PhotoEndpoints.cs), kept as object URLs for the session. When the API
// can't give it (not configured yet, another server), the stored link itself is
// used, as before -- it opens inside the office; elsewhere the avatar keeps its
// initials.
const photos = new Map();   // stored link -> Promise<string>
export function photoBlobUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return Promise.resolve('');
  if (!photos.has(url)) {
    photos.set(url, (async () => {
      try {
        const token = await getAccessToken();
        const stop = new AbortController();
        const timer = setTimeout(() => stop.abort(), PREVIEW_TIMEOUT_MS);
        try {
          const res = await fetch(`${FILES_BASE}/api/v2/photo?url=${encodeURIComponent(url)}`, {
            headers: { Authorization: `Bearer ${token}` }, signal: stop.signal,
          });
          if (!res.ok) return url;
          return URL.createObjectURL(await res.blob());
        } finally { clearTimeout(timer); }
      } catch { return url; }
    })());
  }
  return photos.get(url);
}

// Saves the file under its own name (works for any type, opens nothing).
export async function downloadFile(ref, name) {
  const url = await fileBlobUrl(ref);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The Download buttons on attachments: a Files API file is downloaded with the
// token; an older link (file server, Cloudinary) is fetched and saved when its
// server allows it, else opened in a new tab (save from there).
export async function saveAttachment({ file, entity }) {
  const name = file.name || 'file';
  if (isFilesApiUrl(file.url) && file.id && entity) {
    await downloadFile({ attachmentId: file.id, ...entity }, name);
    return;
  }
  try {
    const res = await fetch(file.url, { mode: 'cors' });
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    window.open(file.url, '_blank', 'noopener,noreferrer');
  }
}
