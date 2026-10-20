import { useRef, useEffect } from 'react';

// Lightweight rich-text editor -- a contentEditable surface + a small toolbar
// (bold / italic / underline / lists / clear). Value and onChange are an HTML
// string. No dependency; uses document.execCommand for the common commands
// (deprecated but universally supported for this basic set).

const btn = {
  height: 26, minWidth: 28, padding: '0 7px', border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', borderRadius: 5, cursor: 'pointer',
  fontSize: 12, fontWeight: 700, lineHeight: 1,
};

const TOOLS = [
  ['bold', <b>B</b>, 'Bold'],
  ['italic', <i>I</i>, 'Italic'],
  ['underline', <span style={{ textDecoration: 'underline' }}>U</span>, 'Underline'],
  ['insertUnorderedList', '•', 'Bullet list'],
  ['insertOrderedList', '1.', 'Numbered list'],
  ['formatBlock:H3', 'H', 'Heading'],
  ['removeFormat', '⌫', 'Clear formatting'],
];

export default function RichTextEditor({ value = '', onChange, disabled = false, minHeight = 240, placeholder = 'Type here…' }) {
  const ref = useRef(null);

  // keep the DOM in sync when `value` changes from outside (initial load),
  // but never stomp the user's caret while they're typing.
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== (value || '') && document.activeElement !== el) {
      el.innerHTML = value || '';
    }
  }, [value]);

  const exec = (cmd) => {
    if (disabled) return;
    ref.current?.focus();
    if (cmd.startsWith('formatBlock:')) document.execCommand('formatBlock', false, cmd.split(':')[1]);
    else document.execCommand(cmd, false, null);
    onChange?.(ref.current?.innerHTML || '');
  };

  const emit = () => onChange?.(ref.current?.innerHTML || '');

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)', opacity: disabled ? 0.6 : 1 }}>
      <div style={{ display: 'flex', gap: 4, padding: 6, borderBottom: '1px solid var(--border)', background: 'var(--soft)', flexWrap: 'wrap' }}>
        {TOOLS.map(([cmd, icon, title]) => (
          <button key={cmd} type="button" title={title} disabled={disabled}
            onMouseDown={e => e.preventDefault()} onClick={() => exec(cmd)} style={btn}>{icon}</button>
        ))}
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        data-placeholder={placeholder}
        style={{
          minHeight, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.6, color: 'var(--text)',
          outline: 'none', overflowY: 'auto',
        }}
      />
      <style>{`
        [contenteditable][data-placeholder]:empty:before{content:attr(data-placeholder);color:var(--muted)}
        [contenteditable] ul,[contenteditable] ol{margin:6px 0 6px 22px}
        [contenteditable] h3{font-size:14px;margin:8px 0 4px}
      `}</style>
    </div>
  );
}
