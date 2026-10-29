import React, { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { noWordSelect } from '../../shared/textSelection.js';

// Shared pieces of the System Settings screens (the master lists and the Mail
// Monitor): sortable Grid, Pill, filter Chips, drawer heading, buttons, cell styles.

export const th = {
  padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase',
  color: 'var(--text2)', whiteSpace: 'nowrap', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 1,
  borderBottom: '1px solid var(--border)',
};
export const td = { padding: '8px 12px', borderTop: '1px solid var(--border)', verticalAlign: 'middle', textAlign: 'left' };
export const fullDate = (d) => (d ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function Pill({ tone = 'muted', children }) {
  const [fg, bg] = {
    green: ['var(--green)', 'var(--green-soft)'], red: ['var(--red)', 'var(--red-soft)'],
    accent: ['var(--accent-strong)', 'var(--accent-soft)'], blue: ['var(--blue)', 'var(--blue-soft)'],
    amber: ['var(--amber)', 'var(--amber-soft)'],
    muted: ['var(--text2)', 'var(--soft)'],
  }[tone];
  return <span style={{ padding: '1px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>;
}

// A table with clickable column headers (click again to reverse); a row with
// a drawer opens on a double-click.
// columns: [{ key, label, sort?: row => value, render: row => node, align?, width? }]
export function Grid({ columns, rows, rowKey, initialSort, onRowClick }) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort?.key);
    if (!col?.sort) return rows;
    const v = col.sort;
    return [...rows].sort((a, b) => {
      const x = v(a), y = v(b);
      const c = typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? 0) - (y ?? 0);
      return sort.desc ? -c : c;
    });
  }, [rows, columns, sort]);
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(c => {
              const on = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" style={{ ...th, textAlign: c.align || 'left', width: c.width }}>
                  {c.sort ? (
                    <button onClick={() => setSort(s => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: false }))}
                      style={{
                        border: 'none', background: 'none', padding: 0, font: 'inherit', color: on ? 'var(--accent-strong)' : 'inherit',
                        textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}>
                      {c.label}{on && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                    </button>
                  ) : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={rowKey(r)} onMouseDown={onRowClick ? noWordSelect : undefined} onDoubleClick={onRowClick ? () => onRowClick(r) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--orange-soft)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
              {columns.map(c => <td key={c.key} style={{ ...td, textAlign: c.align || 'left' }}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Nothing matches.</div>}
    </div>
  );
}

export function Chips({ value, onPick, items }) {
  return (
    <div role="group" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(([k, label]) => {
        const on = k === value;
        return (
          <button key={k} onClick={() => onPick(k)} aria-pressed={on} style={{
            height: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 700,
            border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
            background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent-strong)' : 'var(--text2)',
          }}>{label}</button>
        );
      })}
    </div>
  );
}

export const muted = { fontSize: 12, color: 'var(--muted)' };

export function DrawerHeading({ children }) {
  return <h3 style={{ margin: '18px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{children}</h3>;
}

export const formBtn = (primary, danger) => ({
  height: 34, padding: '0 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', cursor: 'pointer',
  border: primary || danger ? 'none' : '1px solid var(--border)',
  background: danger ? 'var(--red)' : primary ? 'var(--accent)' : 'var(--surface)',
  color: danger ? '#fff' : primary ? 'var(--on-accent)' : 'var(--text)',
});

export const formField = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border2)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)', lineHeight: '19px',
};
