import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// Themed replacement for window.confirm(). Controlled: render it with `open`
// and handle onConfirm / onCancel. `message` supports line breaks (\n).
export default function ConfirmDialog({
  open, title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false,
  onConfirm, onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.();
      else if (e.key === 'Enter') onConfirm?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  const btn = {
    height: 34, padding: '0 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
    cursor: 'pointer', border: '1px solid var(--border)',
  };

  return createPortal(
    <div onMouseDown={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 2400, background: 'var(--overlay, rgba(0,0,0,.42))',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 'min(420px, 100%)', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,.32)', padding: 22,
      }}>
        {title && <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>{title}</div>}
        <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, whiteSpace: 'pre-line' }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button onClick={onCancel} style={{ ...btn, background: 'var(--soft)', color: 'var(--text)' }}>{cancelLabel}</button>
          <button onClick={onConfirm} autoFocus style={{
            ...btn, border: 'none', color: '#fff',
            background: danger
              ? 'linear-gradient(135deg, var(--red), #b91c1c)'
              : 'linear-gradient(135deg, var(--orange), var(--orange2))',
          }}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
