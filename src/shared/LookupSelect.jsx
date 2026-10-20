import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { apiCall } from './api.js';

// Canonical "search lookup" control. Every picker on a form/page is a
// V1QueryFilter linked to that page; this component pulls its options through
// `GetFilterOptions` -- which reads the QF view with the caller's
// V1UserFilterPermissions AND-ed in. The frontend never queries the lookup
// source directly. (See CLAUDE.md -- Search Lookup Authorization.)
//
// UI: an Excel-style table popover -- one row per record, up to four headed
// columns (value / description / extra1 / extra2), a search box that matches
// any of the four (server-side), arrow-key navigation, Enter to pick.

// GetFilterOptions returns fixed roles { value, label, sub, sub2 }; List1 (when
// the SP is new enough) carries the source field names for column headers.
export function mapOption(o) {
  const value = String(o.value ?? '');
  const primary = (o.label != null && String(o.label).trim() !== '') ? String(o.label).trim() : value;
  const parts = [];
  if (value && value !== primary && !/^\d+$/.test(value)) parts.push(value);
  [o.sub, o.sub2].forEach(x => { if (x != null && String(x).trim() !== '') parts.push(String(x).trim()); });
  // sub/sub2 are kept as their own fields (not just folded into the display
  // string) -- several forms key business logic off a specific extra field
  // directly: Customer Order derives Facility from the Warehouse picker's
  // sub, Item Master's Item Class picker filters by sub === Item Type, and
  // Receiving Order's Lot # gating reads sub2 (LotControl).
  return {
    value, label: primary, optionLabel: primary, sublabel: parts.join('  ·  '),
    sub: o.sub != null ? String(o.sub) : null,
    sub2: o.sub2 != null ? String(o.sub2) : null,
  };
}

const prettify = (s) => String(s || '')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ').trim()
  .replace(/\b\w/g, c => c.toUpperCase());

// Lookup cache (2026-10-17). Entries are keyed by USER + key: options are
// permission-filtered per user (V1UserFilterPermissions), so one user's list
// must never be served to another (also cleared on login / logout).
//   * fresh (younger than its lifetime): served from memory, no call
//   * stale: served at once, refreshed in the background (onFresh repaints)
//   * missing: fetched; concurrent requests for the same key share one call
// Lifetime = the lookup's V1QueryFilter.CacheSeconds (GetFilterOptions List1
// cacheSeconds; 0 = refresh on every open), else LOOKUP_TTL_MS.
const LOOKUP_TTL_MS = 10 * 60 * 1000;
const cache = new Map();      // user|key -> { value?, at?, ttl?, pending? }
const ttlOf = (r) => {
  const s = ((r && r.List1) || [])[0]?.cacheSeconds;
  return s != null && s !== '' && Number.isFinite(Number(s)) && Number(s) >= 0 ? Number(s) * 1000 : LOOKUP_TTL_MS;
};
const userKey = () => sessionStorage.getItem('Username') || sessionStorage.getItem('FullName') || '';
const ck = (key) => userKey() + '|' + key;
const peek = (key) => { const e = cache.get(ck(key)); return e && 'value' in e ? e.value : undefined; };

// fetcher resolves { value, ttlMs }
function refresh(key, fetcher) {
  const k = ck(key);
  const e = cache.get(k) || {};
  if (e.pending) return e.pending;
  const p = fetcher().then(
    ({ value, ttlMs }) => { cache.set(k, { value, at: Date.now(), ttl: ttlMs ?? LOOKUP_TTL_MS }); return value; },
    err => { const cur = cache.get(k); if (cur && cur.pending === p) delete cur.pending; throw err; });
  cache.set(k, { ...e, pending: p });
  return p;
}

// value now if cached (refreshing it in the background when stale), else fetch
function getCached(key, fetcher, onFresh) {
  const e = cache.get(ck(key));
  if (e && 'value' in e) {
    if (Date.now() - e.at >= (e.ttl ?? LOOKUP_TTL_MS)) refresh(key, fetcher).then(v => onFresh?.(v)).catch(() => { /* keep the stale list */ });
    return Promise.resolve(e.value);
  }
  return refresh(key, fetcher);
}

async function fetchOptions(linkId) {
  // fetch the complete option set -- no Top, no Search: the popover filters
  // client-side so every record is reachable.
  const r = await apiCall('GetFilterOptions', { LinkID: linkId }, {}, 'plus');
  if (r.State !== 0) throw new Error(r.Message || 'Lookup failed');
  const rows = (r.List0 || []).map(o => ({
    value: String(o.value ?? ''),
    label: (o.label != null && String(o.label).trim() !== '') ? String(o.label).trim() : String(o.value ?? ''),
    sub: o.sub != null ? String(o.sub) : '',
    sub2: o.sub2 != null ? String(o.sub2) : '',
  }));
  const m = (r.List1 || [])[0] || {};
  // drop an extra column that just repeats the value or label field
  const seen = new Set([m.valueField, m.labelField].filter(Boolean));
  const keep = (f) => { if (!f || seen.has(f)) return null; seen.add(f); return f; };
  const x1 = keep(m.extra1Field);
  const x2 = keep(m.extra2Field);
  const meta = {
    value: prettify(m.valueField) || 'Code',
    label: prettify(m.labelField) || 'Description',
    sub: x1 ? prettify(x1) : null,
    sub2: x2 ? prettify(x2) : null,
  };
  if (!x1) rows.forEach(row => { row.sub = ''; });
  if (!x2) rows.forEach(row => { row.sub2 = ''; });
  return { value: { rows, meta }, ttlMs: ttlOf(r) };
}

// Lookup options are permission-filtered per user (V1UserFilterPermissions), so the
// in-memory cache must not outlive the login that fetched it.
export function clearLookupCache() { cache.clear(); }

// After any save (api.js fires 'sila:api-write') a list may be out of date --
// e.g. a customer was just added. Mark every list stale: it still opens at
// once, and refreshes in the background on that open.
export function markLookupsStale() { cache.forEach(e => { if ('value' in e) e.at = 0; }); }
try { window.addEventListener('sila:api-write', markLookupsStale); } catch { /* no window (tests) */ }

// mapped options for a link (DynamicFilterBar, pages building their own pickers)
export function loadLookup(linkId) {
  return getCached('m_' + linkId, () => apiCall('GetFilterOptions', { LinkID: linkId }, {}, 'plus')
    .then(r => {
      if (r.State !== 0) throw new Error(r.Message || 'Lookup failed');
      return { value: (r.List0 || []).map(o => mapOption(o)), ttlMs: ttlOf(r) };
    }));
}

function LookupPopover({ anchorRect, rows, meta, loading, count, highlight, setHighlight, onPick, onClose, search, setSearch, onRefresh }) {
  const boxRef = useRef(null);
  // extra field 1 + 2 share one column, stacked on two lines inside the cell
  const extraHeader = [meta.sub, meta.sub2].filter(Boolean).join('  /  ');
  const cols = [['value', meta.value], ['label', meta.label], extraHeader && ['extra', extraHeader]].filter(Boolean);
  const width = Math.min(Math.max(anchorRect.width, 560), window.innerWidth - 24);
  let left = anchorRect.left;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - 12 - width;
  const belowSpace = window.innerHeight - anchorRect.bottom;
  const top = belowSpace > 300 || belowSpace > anchorRect.top ? anchorRect.bottom + 4 : undefined;
  const bottom = top == null ? window.innerHeight - anchorRect.top + 4 : undefined;

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  useEffect(() => {
    const el = boxRef.current?.querySelector(`[data-row="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  return createPortal(
    <div ref={boxRef} style={{
      position: 'fixed', left, top, bottom, width, maxHeight: 380, zIndex: 12000,
      background: 'var(--surface)', border: '1px solid var(--border2, var(--border))',
      borderRadius: 10, boxShadow: '0 16px 48px rgba(0,0,0,.22)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
        <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, rows.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (rows[highlight]) onPick(rows[highlight]); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          placeholder={`Search ${cols.map(c => c[1].toLowerCase()).join(', ')}…`}
          style={{ width: '100%', height: 32, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 12.5, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }} />
      </div>
      <div style={{ overflow: 'auto', flex: 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ position: 'sticky', top: 0, background: 'var(--soft)', textAlign: 'left' }}>
            {cols.map(([k, h]) => (
              <th key={k} style={{ padding: '6px 10px', fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={cols.length} style={{ padding: 16, color: 'var(--muted)' }}>Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={cols.length} style={{ padding: 16, color: 'var(--muted)' }}>No matches.</td></tr>}
            {rows.map((r, i) => (
              <tr key={r.value + i} data-row={i}
                onMouseEnter={() => setHighlight(i)} onClick={() => onPick(r)}
                style={{ cursor: 'pointer', borderTop: '1px solid var(--border)', background: i === highlight ? 'var(--blue-soft, var(--orange-soft))' : 'transparent' }}>
                {cols.map(([k]) => k === 'extra' ? (
                  <td key={k} style={{ padding: '6px 10px', color: 'var(--muted)' }}>
                    {r.sub ? <div style={{ whiteSpace: 'nowrap' }}>{r.sub}</div> : null}
                    {r.sub2 ? <div style={{ whiteSpace: 'nowrap', fontSize: 10.5, opacity: 0.85 }}>{r.sub2}</div> : null}
                  </td>
                ) : (
                  <td key={k} style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontWeight: k === 'value' ? 700 : 400, color: 'var(--text)' }}>
                    {r[k] || ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '6px 10px', borderTop: '1px solid var(--border)', fontSize: 10.5, color: 'var(--muted)', display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {count} result{count === 1 ? '' : 's'}
          {onRefresh && (
            <button type="button" onClick={onRefresh} disabled={loading} title="Reload this list from the server"
              style={{ border: '1px solid var(--border)', background: 'var(--soft)', color: 'var(--muted)', borderRadius: 5, fontSize: 10.5, fontWeight: 700, padding: '1px 7px', cursor: loading ? 'default' : 'pointer' }}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          )}
        </span>
        <span>↑↓ navigate · Enter select · Esc close</span>
      </div>
    </div>,
    document.body,
  );
}

// `filter` (optional) narrows the offered options client-side, e.g. a line's
// Item picker to the selected vendor's items. The full set still resolves the
// closed control's label, so an existing value outside the filter shows.
// Pass a stable (memoised) function.
// `options` (optional) supplies the rows directly -- [{ value, label, sub?, sub2? }]
// -- for a caller whose list isn't a V1QueryFilter link (e.g. Smart Journal's
// model segments, served by GetModelSegmentLookup); same popover + search.
// `columns` optionally renames the popover headers ({ value, label }).
// `showValue` shows the selected CODE in the closed control instead of its label
// (e.g. a narrow Currency cell: "EGP", not "Egyptian Pound"); the popover still
// lists code + label.
// `lazy` skips the on-mount fetch: the closed control shows `optionLabel` for
// the current value, and the option list loads the first time it is opened.
// For forms with many pickers (e.g. Customer Master) that already know each
// value's description, so opening the form costs no lookup calls.
export default function LookupSelect({ linkId, value, onChange, optionLabel = '', placeholder = 'Select…', disabled = false, style = {}, filter = null, options = null, columns = null, showValue = false, lazy = false }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ value: 'Code', label: 'Description', sub: null, sub2: null });
  const [full, setFull] = useState(null);   // the complete option set (client-filtered)
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [labelMap, setLabelMap] = useState({});   // value -> label, so the closed control shows text
  const anchorRef = useRef(null);

  const selectedLabel = value != null && value !== ''
    ? (showValue ? String(value) : (labelMap[String(value)] ?? (optionLabel || String(value))))
    : '';

  // load the complete option set once -- seeds labelMap so the closed control
  // resolves `value`, and `full` so the popover can filter every record.
  // caller-supplied rows (no link): use them as the full set
  useEffect(() => {
    if (!options) return;
    const rows = options.map(o => ({
      value: String(o.value ?? ''), label: o.label != null && String(o.label).trim() !== '' ? String(o.label) : String(o.value ?? ''),
      sub: o.sub != null ? String(o.sub) : '', sub2: o.sub2 != null ? String(o.sub2) : '',
    }));
    setMeta({ value: columns?.value || 'Code', label: columns?.label || 'Description', sub: null, sub2: null });
    setFull(rows);
    setLabelMap(m => { const n = { ...m }; rows.forEach(r => { n[r.value] = r.label; }); return n; });
  }, [options, columns]);

  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // put a loaded option set on screen (also used by background refreshes)
  const applySet = useCallback((set) => {
    if (!aliveRef.current || !set) return;
    setMeta(set.meta);
    setFull(set.rows);
    setLabelMap(m => { const n = { ...m }; set.rows.forEach(r => { n[r.value] = r.label; }); return n; });
  }, []);
  const loadSet = useCallback(() => {
    if (peek('t_' + linkId) === undefined) setLoading(true);
    return getCached('t_' + linkId, () => fetchOptions(linkId), applySet)
      .then(applySet)
      .catch(() => { if (aliveRef.current) setFull(f => f || []); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
  }, [linkId, applySet]);

  // footer ↻: fetch this list now, whatever its age
  const reloadSet = useCallback(() => {
    if (!linkId) return;
    setLoading(true);
    refresh('t_' + linkId, () => fetchOptions(linkId))
      .then(applySet)
      .catch(() => { /* keep the list we have */ })
      .finally(() => { if (aliveRef.current) setLoading(false); });
  }, [linkId, applySet]);

  useEffect(() => {
    if (!linkId || options || lazy) return;
    loadSet();
  }, [linkId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // client-filter the full set across all columns
  useEffect(() => {
    if (!open) return;
    const ql = search.trim().toLowerCase();
    const src = filter ? (full || []).filter(filter) : (full || []);
    setRows(ql
      ? src.filter(r => `${r.value} ${r.label} ${r.sub} ${r.sub2}`.toLowerCase().includes(ql))
      : src);
    setHighlight(0);
  }, [search, open, full, filter]);

  const openPanel = useCallback(() => {
    if (disabled || (!linkId && !options)) return;
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.top, bottom: r.bottom, width: r.width });
    setSearch(''); setHighlight(0); setOpen(true);
    // cached list (any age) shows at once -- a stale one is refreshed in the
    // background; nothing cached yet (e.g. a lazy picker's first open) loads now
    if (linkId && !options) loadSet();
  }, [disabled, linkId, options, loadSet]);

  const pick = (row) => {
    setLabelMap(m => ({ ...m, [row.value]: row.label }));
    onChange?.(row.value, row);
    setOpen(false);
  };

  return (
    <div ref={anchorRef} style={{ position: 'relative', ...style }}>
      <button type="button" onClick={openPanel} disabled={disabled || (!linkId && !options)}
        style={{
          width: '100%', minHeight: 34, textAlign: 'left', padding: '6px 28px 6px 10px', position: 'relative',
          border: '1px solid var(--border)', borderRadius: 6, fontSize: 12.5,
          background: disabled ? 'var(--soft)' : 'var(--bg)', color: selectedLabel ? 'var(--text)' : 'var(--muted)',
          cursor: disabled || (!linkId && !options) ? 'default' : 'pointer', outline: open ? '2px solid var(--orange)' : 'none',
        }}>
        {selectedLabel || (linkId || options ? placeholder : 'Lookup unavailable')}
        {value != null && value !== '' && !disabled && (
          <span onClick={e => { e.stopPropagation(); onChange?.('', null); }}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', fontSize: 13 }}>✕</span>
        )}
      </button>
      {open && rect && (
        <LookupPopover
          anchorRect={rect} rows={rows} meta={meta} loading={loading} count={rows.length}
          highlight={highlight} setHighlight={setHighlight}
          onPick={pick} onClose={() => setOpen(false)}
          search={search} setSearch={setSearch}
          onRefresh={linkId && !options ? reloadSet : null}
        />
      )}
    </div>
  );
}
