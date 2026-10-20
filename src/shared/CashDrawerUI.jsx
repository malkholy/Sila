import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, BookOpen, Wallet } from 'lucide-react';
import LookupSelect, { loadLookup } from './LookupSelect.jsx';

export const cashLabelStyle = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 8, letterSpacing: 0.2 };
const valueStyle = { minHeight: 36, display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 600, color: 'var(--text)', overflowWrap: 'anywhere' };

export function CashInput({ disabled, value, type, ...props }) {
  if (!disabled) return <input type={type} value={value} {...props} />;
  const display = type === 'date' && value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : value;
  return <div dir="auto" style={valueStyle}>{display === '' || display == null ? <span style={{ color: 'var(--hint)', fontWeight: 400 }}>—</span> : display}</div>;
}

export function CashLookup({ disabled, linkId, value, ...props }) {
  const [resolved, setResolved] = useState(null);
  useEffect(() => {
    let alive = true;
    setResolved(null);
    if (disabled && linkId && value !== '' && value != null) {
      loadLookup(linkId).then(rows => {
        if (alive) setResolved(rows.find(row => String(row.value) === String(value))?.label || null);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [disabled, linkId, value]);
  if (!disabled) return <LookupSelect linkId={linkId} value={value} {...props} />;
  return <div style={{ ...valueStyle, flexWrap: 'wrap', gap: 8 }}>
    <span dir="auto">{resolved || value || '—'}</span>
    {resolved && resolved !== String(value) && <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', background: 'var(--soft)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 6px', fontWeight: 400 }}>{value}</span>}
  </div>;
}

export function CashSummary({ payable, total, currency, loading, journal, treasury, treasuryLink, mode, accountLabel = 'Treasury', totalLabel }) {
  const Icon = payable ? ArrowUpRight : ArrowDownLeft;
  const accent = payable ? 'var(--orange)' : 'var(--green)';
  const soft = payable ? 'var(--orange-soft)' : 'var(--green-soft)';
  return <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '20px 32px', padding: '22px 24px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', borderLeft: `4px solid ${accent}` }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: '1 1 300px', minWidth: 0 }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: soft, color: accent, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon size={24} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={cashLabelStyle}>{totalLabel || (payable ? 'Total payment' : 'Total receipt')}{mode === 'edit' ? ' · Editing' : mode === 'new' ? ' · New request' : ''}</div>
        <div style={{ fontSize: 'clamp(22px, 3vw, 32px)', fontWeight: 800, letterSpacing: '-0.8px', lineHeight: 1.2, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{loading ? '—' : total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style={{ color: 'var(--muted)', fontSize: 13, fontWeight: 600, letterSpacing: 0 }}>{currency}</span></div>
      </div>
    </div>
    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
      <div style={{ ...cashLabelStyle, display: 'flex', alignItems: 'center', gap: 6 }}><Wallet size={13} /> {accountLabel}</div>
      <CashLookup disabled linkId={treasuryLink} value={treasury} />
    </div>
    {journal && <div style={{ flex: '1 1 180px', minWidth: 0 }}>
      <div style={{ ...cashLabelStyle, display: 'flex', alignItems: 'center', gap: 6 }}><BookOpen size={13} /> Journal reference</div>
      <div style={{ ...valueStyle, fontFamily: 'var(--mono)', fontSize: 13 }}>{journal}</div>
    </div>}
  </div>;
}

// Request-date window for cash / bank / note / treasury documents (user rule
// 2026-10-19): today-3 .. today. The server enforces it on Save
// (PLS.V1CheckRequestDate); these bounds only limit the date pickers.
export function requestDateBounds() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const min = new Date(today); min.setDate(min.getDate() - 3);
  return { min: iso(min), max: iso(today) };
}
