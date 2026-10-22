import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Bold, Italic, Underline, List, ListOrdered, Quote, RemoveFormatting } from 'lucide-react';

// The formatted-text editor (shown in the composer's pop-up): a small toolbar over a contentEditable box.
// Enter adds a line; Ctrl / Cmd + Enter sends (onSubmit). The parent reads
// the HTML through the ref (getHtml / setHtml / clear / focus) and is told
// when it becomes empty or not (onEmptyChange) to enable the Send button.
// Commands use document.execCommand: deprecated, but every browser still
// supports this basic set, and it keeps the undo stack working.

const TOOLS = [
  { cmd: 'bold', icon: Bold, label: 'Bold (Ctrl+B)' },
  { cmd: 'italic', icon: Italic, label: 'Italic (Ctrl+I)' },
  { cmd: 'underline', icon: Underline, label: 'Underline (Ctrl+U)' },
  { cmd: 'insertUnorderedList', icon: List, label: 'Bulleted list' },
  { cmd: 'insertOrderedList', icon: ListOrdered, label: 'Numbered list' },
  { cmd: 'formatBlock', arg: 'blockquote', icon: Quote, label: 'Quote' },
  { cmd: 'removeFormat', icon: RemoveFormatting, label: 'Clear formatting' },
];

const RichComposer = forwardRef(function RichComposer({
  placeholder, disabled, accent, onSubmit, onEscape, onEmptyChange, minHeight = 64, maxHeight = 220, hint = true,
}, ref) {
  const box = useRef(null);
  const emptyRef = useRef(true);
  const checkEmpty = () => {
    const empty = !(box.current?.textContent || '').trim();
    if (empty !== emptyRef.current) { emptyRef.current = empty; onEmptyChange?.(empty); }
  };

  useImperativeHandle(ref, () => ({
    getHtml: () => box.current?.innerHTML || '',
    setHtml: (html) => { if (box.current) { box.current.innerHTML = html || ''; checkEmpty(); } },
    clear: () => { if (box.current) { box.current.innerHTML = ''; checkEmpty(); } },
    focus: () => {
      const el = box.current;
      if (!el) return;
      el.focus();
      // caret at the end
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    },
  }));

  useEffect(() => { checkEmpty(); });   // keep onEmptyChange in step after setHtml / clear

  const run = (t) => {
    if (disabled) return;
    box.current?.focus();
    document.execCommand(t.cmd, false, t.arg ?? null);
    checkEmpty();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit?.(); return; }
    if (e.key === 'Escape') { onEscape?.(e); }
  };

  // pasting keeps only the text: formatting is applied with the toolbar
  const onPaste = (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  };

  return (
    <div style={{
      flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden',
      border: `1.5px solid ${accent || 'var(--accent)'}`, background: 'var(--soft)',
    }}>
      <div role="toolbar" aria-label="Formatting" style={{
        display: 'flex', gap: 2, padding: 4, borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexWrap: 'wrap',
      }}>
        {TOOLS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.label} type="button" title={t.label} aria-label={t.label} disabled={disabled}
              onMouseDown={e => e.preventDefault()} onClick={() => run(t)} style={{
                width: 32, height: 30, borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--text2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
              }}><Icon size={16} /></button>
          );
        })}
        {hint && (
          <span style={{ marginLeft: 'auto', alignSelf: 'center', paddingRight: 6, fontSize: 11, color: 'var(--muted)' }}>
            Ctrl + Enter to send
          </span>
        )}
      </div>
      <div ref={box} role="textbox" aria-multiline="true" aria-label="Formatted message" contentEditable={!disabled}
        suppressContentEditableWarning dir="auto" data-placeholder={placeholder}
        onInput={checkEmpty} onKeyDown={onKeyDown} onPaste={onPaste}
        className="sila-rich-input"
        style={{
          minHeight, maxHeight, overflowY: 'auto', padding: '10px 14px', fontSize: 14, lineHeight: '20px',
          color: 'var(--text)', fontFamily: 'var(--font)', outline: 'none', overflowWrap: 'anywhere',
        }} />
      <style>{`
        .sila-rich-input:empty:before { content: attr(data-placeholder); color: var(--muted); }
        .sila-rich-input ul, .sila-rich-input ol { margin: 4px 0; padding-inline-start: 22px; }
        .sila-rich-input blockquote { margin: 4px 0; padding: 2px 10px; border-inline-start: 3px solid var(--border2); color: var(--text2); }
      `}</style>
    </div>
  );
});

export default RichComposer;
