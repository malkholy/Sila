// Small "loading" strip for drawers and forms. Pattern (2026-10-17): a drawer
// opens at once and shows what it already has (usually the grid row); the
// part still being fetched shows this strip, and inputs stay locked until it
// is in -- never a full-body spinner. `error` turns it red with a Retry.
//
//   <InlineLoader text="Loading lines…" />
//   <InlineLoader error={err} onRetry={reload} />
export default function InlineLoader({ text = 'Loading…', error = null, onRetry = null, style = null }) {
  return (
    <div role="status" aria-live="polite" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8,
      background: error ? 'var(--red-soft)' : 'var(--orange-soft)', border: '1px solid ' + (error ? 'var(--red)' : 'var(--border)'),
      ...style,
    }}>
      {error ? (
        <>
          <span style={{ flex: 1, color: 'var(--red)', fontSize: 12.5, fontWeight: 600 }}>{error}</span>
          {onRetry && (
            <button onClick={onRetry} style={{
              height: 28, padding: '0 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}>Retry</button>
          )}
        </>
      ) : (
        <>
          <span aria-hidden="true" style={{
            width: 14, height: 14, flexShrink: 0, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--orange)',
            display: 'inline-block', animation: 'spin .8s linear infinite',
          }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{text}</span>
        </>
      )}
    </div>
  );
}
