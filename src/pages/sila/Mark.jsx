import React from 'react';

// The search words marked inside a text (terms: lower-case words; none = the
// plain text). Shared by the Home lists and the people pickers.
export default function Mark({ text, terms }) {
  const str = String(text ?? '');
  const list = (terms || []).filter(Boolean);
  if (!str || !list.length) return str;
  const re = new RegExp(`(${list.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return str.split(re).map((part, i) => (i % 2
    ? <mark key={i} style={{ background: 'var(--amber-soft)', color: 'inherit', borderRadius: 3, padding: '0 1px', boxShadow: '0 0 0 1px var(--amber)' }}>{part}</mark>
    : part));
}
