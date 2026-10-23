import React from 'react';
import { Clock } from 'lucide-react';
import { slaAlert } from '../../shared/ticketSla.js';

// A ticket that is due soon (amber) or late (red) against its channel's
// targets; nothing while it is on time or has no target.
export default function SlaBadge({ sla, state, compact = false }) {
  const a = slaAlert(sla, state);
  if (!a) return null;
  const [fg, bg] = a.tone === 'late' ? ['var(--red)', 'var(--red-soft)'] : ['var(--amber)', 'var(--amber-soft)'];
  return (
    <span title={a.text} aria-label={a.text} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: compact ? '0 6px' : '1px 8px', borderRadius: 999,
      background: bg, color: fg, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
    }}><Clock size={11} />{compact ? a.short : a.text}</span>
  );
}
