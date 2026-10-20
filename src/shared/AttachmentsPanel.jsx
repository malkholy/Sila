import { useState, useEffect, useCallback, useRef } from 'react';
import { Paperclip, Upload, Eye, Download, Trash2, Loader2 } from 'lucide-react';
import { listAttachments, uploadAttachment, deleteAttachment, attachmentViewUrl, attachmentDownloadUrl } from './attachmentApi.js';
import ConfirmDialog from './ConfirmDialog.jsx';

const btn = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'inline-flex',
  alignItems: 'center', gap: 6,
};
const iconBtn = {
  padding: 6, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isViewable(fileType) {
  return fileType === 'application/pdf' || (fileType || '').startsWith('image/');
}

// Reusable list/upload/view/download/delete UI for the standalone AttachmentApi
// (see src/shared/attachmentApi.js). Drop into any form's tab: it just needs
// the business record's key and the page's PageGroupID for the server-side
// permission check.
export default function AttachmentsPanel({ entityType, entityKey, pageGroupId, disabled = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const fileInputRef = useRef(null);

  const load = useCallback(() => {
    if (!entityKey) { setItems([]); return; }
    setLoading(true);
    setError('');
    listAttachments(entityType, entityKey, pageGroupId)
      .then(list => setItems(Array.isArray(list) ? list : []))
      .catch(e => setError(e.message || 'Failed to load attachments'))
      .finally(() => setLoading(false));
  }, [entityType, entityKey, pageGroupId]);

  useEffect(() => { load(); }, [load]);

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChosen = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !entityKey) return;
    setUploading(true);
    setError('');
    try {
      await uploadAttachment(entityType, entityKey, pageGroupId, file);
      load();
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    const row = pendingDelete;
    setPendingDelete(null);
    if (!row) return;
    try {
      await deleteAttachment(row.attachmentID);
      load();
    } catch (err) {
      setError(err.message || 'Delete failed');
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--muted)' }}>
          Documents
        </div>
        {!disabled && (
          <>
            <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onFileChosen} />
            <button style={btn} onClick={onPickFile} disabled={uploading || !entityKey}>
              {uploading ? <Loader2 size={14} style={{ animation: 'spin .7s linear infinite' }} /> : <Upload size={14} />}
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
          </>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}

      {loading ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Paperclip size={14} /> No documents attached.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {items.map(it => (
                <tr key={it.attachmentID} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px' }}>
                    <div style={{ fontWeight: 600 }}>{it.fileName}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {formatSize(it.fileSize)} · {it.createdBy} · {it.createdDate ? new Date(it.createdDate).toLocaleString() : ''}
                    </div>
                  </td>
                  <td style={{ padding: '8px 12px', width: 1, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {isViewable(it.fileType) && (
                        <a href={attachmentViewUrl(it.attachmentID)} target="_blank" rel="noreferrer" style={iconBtn} title="View">
                          <Eye size={14} />
                        </a>
                      )}
                      <a href={attachmentDownloadUrl(it.attachmentID)} style={iconBtn} title="Download">
                        <Download size={14} />
                      </a>
                      {!disabled && (
                        <button style={{ ...iconBtn, color: 'var(--red)' }} title="Delete" onClick={() => setPendingDelete(it)}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete attachment"
        message={pendingDelete ? `Delete "${pendingDelete.fileName}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
