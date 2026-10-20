import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiCall } from './api.js';
import DataGrid from './DataGrid.jsx';

// Right-side drawer for one document (a proforma, an invoice, ...): a header
// (title, subtitle, stat strip, actions, optional banner) and one tab per
// Detail query, each fetched with View { PageGroupID, QueryID, KeyField,
// KeyValue } -- queries are resolved by name from the page's mapped queries
// (GetPageQueries), so a tab only works for a query linked to that page.
//
// tabs: [{ key, label, query, keyField, cols: [[field, label, kind]] }]
//   kind: 'num' (2 dp) | 'qty' (up to 3 dp) | 'int' | 'date' | 'yesno' | 'text'
// stats: [[label, value]]
// loadingLabel: text of the loader shown (instead of the drawer) until every
// tab's data has arrived -- the drawer opens once, already complete.

export function fmt(v, kind) {
  if (v == null || v === '') return '';
  if (kind === 'date') return String(v).slice(0, 10);
  if (kind === 'num' || kind === 'qty') {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return kind === 'qty' ? n.toLocaleString(undefined, { maximumFractionDigits: 3 })
      : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (kind === 'yesno') return Number(v) ? 'Yes' : 'No';
  return String(v);
}

function HeadStat({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );
}

function Loader({ label, onCancel }) {
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay, rgba(0,0,0,0.35))', zIndex: 1200 }} />
      <div role="status" aria-live="polite" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1201,
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,.25)',
        padding: '22px 28px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, minWidth: 240,
      }}>
        <span style={{
          width: 34, height: 34, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--orange)',
          display: 'inline-block', animation: 'spin .8s linear infinite',
        }} />
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{label}</div>
        <button onClick={onCancel} style={{
          height: 28, padding: '0 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--muted)',
        }}>Cancel</button>
      </div>
    </>
  );
}

// `onRowActivate(tabKey, row)` (opt-in): a click on a row of a tab -- e.g. the
// proforma drawer opens an item's invoice history from its Lines tab. Tabs can
// set `hint` (shown above the grid) to say rows are clickable.
export default function DetailsDrawer({ pageGroupId, keyValue, title, subtitle, stats = [], tabs, actions, banner, loadingLabel = 'Loading…', onClose, onRowActivate = null }) {
  const [data, setData] = useState({});   // { [tab.key]: rows[] }
  const [tab, setTab] = useState(tabs[0]?.key);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const pq = await apiCall('GetPageQueries', { PageGroupID: pageGroupId });
      const map = {};
      (pq.List0 || []).forEach(q => { map[q.QueryName] = q.QueryID; });
      const results = await Promise.all(tabs.map(t => (map[t.query]
        ? apiCall('View', { PageGroupID: pageGroupId, QueryID: map[t.query], KeyField: t.keyField, KeyValue: String(keyValue) })
        : Promise.resolve({ State: -1, Message: `Query "${t.query}" is not linked to this page.` }))));
      const next = {};
      let firstErr = null;
      results.forEach((res, i) => {
        const t = tabs[i];
        const list = res.List0 || [];
        const sqlErr = list.length === 1 && list[0] && list[0].Message != null && list[0][t.keyField] === undefined;
        if ((res.State != null && res.State !== 0) || sqlErr) {
          if (!firstErr) firstErr = (sqlErr ? list[0].Message : res.Message) || `Failed to load ${t.label}`;
          next[t.key] = [];
        } else {
          // derived columns (spec opts.value) become real row fields -- sortable, searchable
          const derived = t.cols.filter(c => c[3]?.value);
          next[t.key] = derived.length ? list.map(r => {
            const o = { ...r };
            derived.forEach(([k, , , opts]) => { o[k] = opts.value(r); });
            return o;
          }) : list;
        }
      });
      setData(next);
      if (firstErr) setError(firstErr);
    } catch (e) {
      setError('Connection error: ' + e.message);
    }
    setLoading(false);
    // tabs is a module-level constant in every caller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageGroupId, keyValue]);

  useEffect(() => { setData({}); setTab(tabs[0]?.key); load(); }, [load]);   // eslint-disable-line react-hooks/exhaustive-deps

  const activeTab = tabs.find(t => t.key === tab) || tabs[0];
  // a column spec may carry a 4th element { color(row) -> css color | null,
  // title(row) -> tooltip, value(row) -> a value derived from the row's own
  // fields (e.g. a discount % from amount + discount) }
  const columns = useMemo(() => activeTab.cols.map(([key, label, kind, opts]) => ({
    key, label, numeric: kind === 'num' || kind === 'qty',
    render: (v, row) => {
      const text = fmt(v, kind);
      const color = opts?.color?.(row);
      return color ? <span style={{ color, fontWeight: 700 }} title={opts.title?.(row) || undefined}>{text}</span> : text;
    },
  })), [activeTab]);
  const rows = data[activeTab.key] || [];

  if (loading) return <Loader label={loadingLabel} onCancel={onClose} />;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--overlay, rgba(0,0,0,0.35))', zIndex: 1200 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(1200px, 96vw)', zIndex: 1201,
        background: 'var(--surface)', borderLeft: '1px solid var(--border)', boxShadow: '-12px 0 40px var(--overlay, rgba(0,0,0,0.25))',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--soft)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>{title}</div>
              {subtitle && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, flex: '0 0 auto', alignItems: 'center' }}>
              {actions}
              <button onClick={onClose} style={{
                height: 30, padding: '0 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)',
              }}>Close</button>
            </div>
          </div>
          {banner}
          {stats.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginTop: 14 }}>
              {stats.map(([l, v]) => <HeadStat key={l} label={l} value={v} />)}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 4, padding: '10px 16px 0', borderBottom: '1px solid var(--border)' }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '8px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
              border: 'none', borderBottom: `2px solid ${activeTab.key === t.key ? 'var(--orange)' : 'transparent'}`,
              background: 'transparent', color: activeTab.key === t.key ? 'var(--text)' : 'var(--muted)',
            }}>
              {t.label}{data[t.key] ? ` (${data[t.key].length})` : ''}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, padding: 16, overflow: 'auto' }}>
          {error && (
            <div style={{ color: 'var(--red)', background: 'var(--red-soft)', border: '1px solid var(--red)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 }}>{error}</div>
          )}
          {activeTab.hint && onRowActivate && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>{activeTab.hint}</div>}
          <DataGrid columns={columns} rows={rows}
            onView={onRowActivate ? (row) => onRowActivate(activeTab.key, row) : undefined}
            activateOnSingleClick={!!onRowActivate} />
        </div>
      </div>
    </>
  );
}
