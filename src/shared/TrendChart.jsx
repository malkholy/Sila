import { useState, useRef } from 'react';

// Single-series trend for a grouped grid whose Group By combo is a pure time
// dimension (Year / Month / Quarter / Date, no other dimension mixed in) --
// see GridPage's `computeTrend`. Inline SVG, no charting dependency: thin
// rounded marks, recessive gridlines, hover crosshair/highlight + tooltip.
// One series -> no legend box needed (the title names it).
// `type`: 'line' (default) or 'bar'. `bare`: true skips the card chrome
// (border/background/padding/label) for embedding inside a caller's own card.
const BAR_COLORS = ['var(--orange)', 'var(--blue)', 'var(--green)', 'var(--amber)', 'var(--red)'];

export default function TrendChart({ points, label, formatValue, type = 'line', bare = false, height = 160, colorful = false }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  const W = 720, H = height, padL = 8, padR = 8, padT = 14, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;

  const values = points.map(p => p.value);
  const maxV = Math.max(...values, 0);
  const minV = Math.min(...values, 0);
  const span = (maxV - minV) || 1;

  const x = (i) => padL + (points.length <= 1 ? 0 : (i / (points.length - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - minV) / span) * innerH;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${x(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const zeroY = y(0);
  const barW = points.length ? Math.min(28, (innerW / points.length) * 0.55) : 0;

  function onMove(e) {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let nearest = 0, best = Infinity;
    points.forEach((p, i) => { const d = Math.abs(x(i) - px); if (d < best) { best = d; nearest = i; } });
    setHoverIdx(nearest);
  }

  const hp = hoverIdx != null ? points[hoverIdx] : null;

  // show every label if few points, else thin them out so text doesn't collide
  const labelStep = Math.max(1, Math.ceil(points.length / 8));

  const chart = (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: H, display: 'block', cursor: points.length ? 'crosshair' : 'default' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* recessive baseline */}
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="var(--border)" strokeWidth={1} />

        {type === 'bar' ? (
          points.map((p, i) => (
            <rect key={'bar' + i}
              x={x(i) - barW / 2} y={Math.min(y(p.value), zeroY)}
              width={barW} height={Math.abs(zeroY - y(p.value))}
              rx={3} fill={colorful ? BAR_COLORS[i % BAR_COLORS.length] : 'var(--orange)'} opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.45} />
          ))
        ) : points.length > 1 && (
          <>
            <path d={areaPath} fill="var(--orange)" opacity={0.08} stroke="none" />
            <path d={linePath} fill="none" stroke="var(--orange)" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}

        {points.map((p, i) => (
          (i % labelStep === 0 || i === points.length - 1) && (
            <text key={'lbl' + i} x={x(i)} y={H - 4} fontSize={9} fill="var(--muted)" textAnchor="middle">
              {p.label}
            </text>
          )
        ))}

        {hp && type === 'line' && (
          <>
            <line x1={x(hoverIdx)} y1={padT} x2={x(hoverIdx)} y2={padT + innerH}
              stroke="var(--border)" strokeWidth={1} strokeDasharray="3,3" />
            <circle cx={x(hoverIdx)} cy={y(hp.value)} r={4} fill="var(--orange)" stroke="var(--surface)" strokeWidth={2} />
          </>
        )}
      </svg>

      <div style={{ minHeight: 18, fontSize: 11, color: 'var(--text)', fontWeight: 700 }}>
        {hp ? (hp.label + '   ' + formatValue(hp.value)) : ' '}
      </div>
    </>
  );

  if (bare) return chart;

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)',
      padding: '10px 14px 6px', marginBottom: 14,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
      {chart}
    </div>
  );
}
