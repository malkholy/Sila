// Donut chart for a share-of-total breakdown (identity color, fixed order,
// never cycled). `segments`: [{ label, value, color, code?, name? }], already
// in the order they should be drawn/legended -- caller folds a long tail
// into an "Others" segment before calling. `code`/`name` (e.g. a customer's
// number + Arabic name) render as two separately-directioned legend lines --
// see RankedPanel for why a mixed LTR/RTL string on one truncated line
// garbles both; `label` alone is used when there's no code/name split (e.g.
// the "Others" segment). `centerLabel` / `centerValue` render in the donut's
// hole (e.g. the grand total). Legend always shown (>=2 series).
export default function DonutChart({ segments, centerLabel, centerValue, formatValue, bare = false, size = 140 }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const CX = size / 2, CY = size / 2, R = size * 0.43, STROKE = size * 0.157;
  const CIRC = 2 * Math.PI * R;

  let offset = 0;
  const arcs = segments.map((s) => {
    const frac = s.value / total;
    const dash = frac * CIRC;
    const arc = { ...s, frac, dash, offset };
    offset += dash;
    return arc;
  });

  const chart = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size, flexShrink: 0 }}>
        <g transform={`rotate(-90 ${CX} ${CY})`}>
          <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--soft)" strokeWidth={STROKE} />
          {arcs.map((a, i) => (
            <circle key={i} cx={CX} cy={CY} r={R} fill="none" stroke={a.color} strokeWidth={STROKE}
              strokeDasharray={`${a.dash} ${CIRC - a.dash}`} strokeDashoffset={-a.offset}
              strokeLinecap={arcs.length > 1 ? 'butt' : 'round'} />
          ))}
        </g>
        <text x={CX} y={CY - size * 0.036} textAnchor="middle" fontSize={size * 0.079} fill="var(--muted)" fontWeight={700}>
          {centerLabel}
        </text>
        <text x={CX} y={CY + size * 0.086} textAnchor="middle" fontSize={size * 0.107} fill="var(--text)" fontWeight={800}>
          {centerValue}
        </text>
      </svg>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minWidth: 140 }}>
        {segments.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, flexShrink: 0, marginTop: 3 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {s.code ? (
                <span dir="ltr" style={{
                  display: 'block', color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--mono, monospace)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.code}
                </span>
              ) : (
                <span style={{
                  display: 'block', color: 'var(--text)', fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.label}
                </span>
              )}
              {s.name && (
                <span dir="auto" style={{
                  display: 'block', textAlign: 'left', color: 'var(--muted)', fontSize: 10.5,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.name}
                </span>
              )}
            </div>
            <span style={{ color: 'var(--muted)', fontWeight: 700, flexShrink: 0 }}>
              {Math.round((s.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  if (bare) return chart;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', padding: '10px 14px' }}>
      {chart}
    </div>
  );
}
