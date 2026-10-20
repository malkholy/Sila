import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { apiCall } from './api.js';
import { loadLookup } from './LookupSelect.jsx';
import LookupSelect from './LookupSelect.jsx';

// Named default-date tokens for DATE_RANGE links (mirror of the SP resolver).
export const DATE_TOKENS = [
  ['', '(none)'],
  ['TODAY', 'Today'],
  ['MONTH_BEGIN', 'Month begin'],
  ['MONTH_END', 'Month end'],
  ['YEAR_BEGIN', 'Year begin'],
  ['YEAR_END', 'Year end'],
];
function resolveDateToken(t) {
  const s = (t || '').trim().toUpperCase();
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmt = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  switch (s) {
    case 'TODAY': return fmt(d);
    case 'MONTH_BEGIN': return fmt(new Date(d.getFullYear(), d.getMonth(), 1));
    case 'MONTH_END': return fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    case 'YEAR_BEGIN': return fmt(new Date(d.getFullYear(), 0, 1));
    case 'YEAR_END': return fmt(new Date(d.getFullYear(), 11, 31));
    case '': return '';
    default: return t;   // literal yyyy-mm-dd
  }
}

// Default-value tokens for numeric RANGE links (FixedFrom / FixedTo):
// CURRENT_YEAR -> this year (e.g. 2026); anything else is used literally.
function resolveRangeToken(t) {
  const s = (t || '').trim();
  if (s.toUpperCase() === 'CURRENT_YEAR') return String(new Date().getFullYear());
  return s;
}

// Filter Panel for a GridPage: renders the panel Filter Links
// (V1QueryFilterLink, UsePanel = 1) for a page's Base query and returns the
// chosen values as the Filters array GetGridData expects:
//   [{ LinkID, From, To, Values }]
// `onCount` reports how many panel links exist so the page can decide layout.
// `runApply`: wraps onApply so the Apply/Clear buttons can show a spinner while
// the caller's (possibly async) apply work runs, without changing what any
// existing caller's onApply returns or does.
function Spinner() {
  return (
    <span style={{
      width: 13, height: 13, border: '2px solid rgba(255,255,255,.5)', borderTopColor: '#fff',
      borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite',
    }} />
  );
}

// `hideFields`: QueryField names whose links are not shown in the bar (still usable by the page,
// e.g. a drawer pinning one record through the same link).
// `layout`: 'sidebar' (default, fixed-width left column) or 'top' (full-width
// bar above the content instead -- the filter list inside still stacks
// vertically, only the panel's own position/width changes).
// `extra`: page content shown first inside the panel, in every layout and when
// collapsed (e.g. an Order Board view switch -- see the order-board skill).
// `onSeed(filters)` (opt-in): called once the links are loaded, with the
// Filters the seeded defaults stand for (e.g. Order Date = this month) -- a
// page that loads without waiting for Apply uses it so its first load
// matches what the panel shows. Called with [] when there is nothing seeded
// (or the links fail to load).
const DynamicFilterBar = forwardRef(function DynamicFilterBar({
  queryId, pageGroupId, onApply, onCount, hideFields = [],
  extra = null, onSeed = null,
  groupBys = [], groupByIds = [], onGroupByChange, requireGroupBy = false, layout = 'sidebar',
}, ref) {
  const [links, setLinks] = useState([]);
  const [options, setOptions] = useState({});   // LinkID -> [{value,label}]
  const [state, setState] = useState({});       // LinkID -> { from, to, values:[] }
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const runApply = useCallback(async (filters, resetState) => {
    if (resetState) { setState(resetState); onGroupByChange?.([]); }
    setApplying(true);
    try { await onApply(filters); } finally { setApplying(false); }
  }, [onApply, onGroupByChange]);
  const [collapsed, setCollapsed] = useState(false);
  const [openLinks, setOpenLinks] = useState(() => new Set());   // expanded filters (default: all collapsed)
  const defaultsRef = useRef({});   // DATE_RANGE seed values, for Clear
  const linksRef = useRef(null);
  const listIdsRef = useRef(new Set());   // LinkIDs whose FilterType is LIST

  const toggleLink = (id) => setOpenLinks(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Clicking outside the panel collapses any open LIST (multi-check) filter,
  // the way a dropdown menu closes on outside click.
  useEffect(() => {
    const onDown = (e) => {
      if (linksRef.current && linksRef.current.contains(e.target)) return;
      setOpenLinks(prev => {
        if (![...prev].some(id => listIdsRef.current.has(id))) return prev;
        const next = new Set(prev);
        listIdsRef.current.forEach(id => next.delete(id));
        return next;
      });
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (queryId == null || pageGroupId == null) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      let panel = [];
      try {
        const res = await apiCall('GetQueryFilterLinks', { QueryID: queryId, PageGroupID: pageGroupId }, {}, 'plus');
        if (cancelled) return;
        panel = (res.State === 0 ? res.List0 || [] : [])
          .filter(l => l.UsePanel === 1 || l.UsePanel === true)
          // a page may hide a panel link from the bar (it stays a valid, permission-checked filter link)
          .filter(l => !hideFields.includes(l.QueryField));
        setLinks(panel);
        listIdsRef.current = new Set(panel.filter(l => l.FilterType === 'LIST').map(l => l.LinkID));
        // seed DATE_RANGE links with their configured default date tokens
        const seed = {};
        panel.forEach(l => {
          if (l.FilterType === 'DATE_RANGE' && (l.FixedFrom || l.FixedTo)) {
            // a single configured token is the START of the range; the end
            // defaults to today (month-to-date, year-to-date, …)
            let tokFrom = (l.FixedFrom || '').trim();
            let tokTo = (l.FixedTo || '').trim();
            if (!tokFrom && tokTo) { tokFrom = tokTo; tokTo = 'TODAY'; }
            else if (tokFrom && !tokTo) tokTo = 'TODAY';
            seed[l.LinkID] = { from: resolveDateToken(tokFrom), to: resolveDateToken(tokTo) };
          } else if (l.FilterType === 'RANGE' && (l.FixedFrom || l.FixedTo)) {
            // numeric RANGE default (e.g. a Year filter): CURRENT_YEAR or a literal
            seed[l.LinkID] = { from: resolveRangeToken(l.FixedFrom), to: resolveRangeToken(l.FixedTo) };
          }
        });
        defaultsRef.current = seed;
        setState(JSON.parse(JSON.stringify(seed)));
        setOpenLinks(new Set());   // start every filter collapsed
        if (!cancelled) onSeed?.(panel
          .filter(l => seed[l.LinkID] && (seed[l.LinkID].from || seed[l.LinkID].to))
          .map(l => ({ LinkID: l.LinkID, From: seed[l.LinkID].from || null, To: seed[l.LinkID].to || null })));
      } catch { if (!cancelled) onSeed?.([]); /* ignore -- treat as no panel filters */ }
      if (cancelled) return;
      onCount?.(panel.length);
      try {
        const loaded = {};
        await Promise.all(panel
          .filter(l => l.FilterType === 'LIST')
          .map(async l => {
            try {
              // shared per-user lookup cache (LookupSelect) -- no refetch per page open
              const opts = await loadLookup(l.LinkID);
              loaded[l.LinkID] = opts.map(m => ({ ...m, sublabel: m.sublabel || null }));
            } catch { /* ignore */ }
          }));
        if (!cancelled) setOptions(loaded);
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [queryId, pageGroupId]);

  const set = (linkId, patch) => setState(s => ({ ...s, [linkId]: { ...s[linkId], ...patch } }));

  function buildFilters(src = state) {
    const out = [];
    links.forEach(l => {
      const st = src[l.LinkID] || {};
      if (l.FilterType === 'LIST') {
        const vals = (st.values || []).filter(v => v !== '' && v != null);
        if (vals.length) out.push({ LinkID: l.LinkID, Values: vals });
      } else if (l.FilterType === 'RANGE' || l.FilterType === 'DATE_RANGE') {
        if (st.from || st.to) out.push({ LinkID: l.LinkID, From: st.from || null, To: st.to || null });
      } else if (st.from) {
        out.push({ LinkID: l.LinkID, From: st.from });
      }
    });
    return out;
  }

  useImperativeHandle(ref, () => ({ getFilters: buildFilters }));

  // Active-filter chips (top layout only): a human-readable summary of what's
  // currently set, live as the user edits -- not just what was last Applied,
  // so it doubles as "here's what Apply will send". Removing a chip clears
  // just that filter and re-applies immediately (standard chip UX).
  function chipLabel(l, st) {
    const name = l.LabelOverride || l.FilterName || l.QueryField;
    if (l.FilterType === 'LIST') {
      const vals = st.values || [];
      return vals.length ? `${name}: ${vals.length} selected` : null;
    }
    if (l.FilterType === 'RANGE' || l.FilterType === 'DATE_RANGE') {
      if (!st.from && !st.to) return null;
      const f = st.fromLabel || st.from || '…';
      const t = st.toLabel || st.to || '…';
      return `${name}: ${f} – ${t}`;
    }
    if (l.FilterType === 'MIN') {
      return st.from ? `${name}: ≥ ${st.fromLabel || st.from}` : null;
    }
    if (!st.from) return null;
    return l.FilterType === 'LIKE' ? `${name}: contains "${st.from}"` : `${name}: ${st.from}`;
  }

  function clearLink(l) {
    const patch = l.FilterType === 'LIST'
      ? { values: [] }
      : { from: null, to: null, fromLabel: '', toLabel: '' };
    const next = { ...state, [l.LinkID]: { ...state[l.LinkID], ...patch } };
    setState(next);
    onApply(buildFilters(next));
  }

  const chips = links
    .map(l => ({ l, text: chipLabel(l, state[l.LinkID] || {}) }))
    .filter(x => x.text);

  function ChipsRow({ style }) {
    if (!chips.length) return null;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, ...style }}>
        {chips.map(({ l, text }) => (
          <span key={l.LinkID} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700,
            color: 'var(--orange)', background: 'var(--orange-soft)', border: '1px solid color-mix(in srgb, var(--orange) 25%, transparent)',
            borderRadius: 999, padding: '3px 6px 3px 10px', whiteSpace: 'nowrap',
          }}>
            {text}
            <button type="button" onClick={() => clearLink(l)} title="Remove filter" style={{
              width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', borderRadius: '50%', background: 'color-mix(in srgb, var(--orange) 16%, transparent)', color: 'var(--orange)',
              fontSize: 9, cursor: 'pointer', padding: 0, lineHeight: 1,
            }}>✕</button>
          </span>
        ))}
      </div>
    );
  }

  const hasGroupBy = groupBys.length > 0;
  // nothing to show until the links are known -- rendering while they load
  // made the bar flash open and vanish on pages with no panel filters
  if (queryId == null || (links.length === 0 && !hasGroupBy && !extra)) return null;

  const isTop = layout === 'top';

  if (collapsed) {
    return isTop ? (
      <div style={{
        width: '100%', background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '10px 16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', flexShrink: 0 }}>Filters</span>
          {extra}
          <ChipsRow />
        </div>
        <button onClick={() => setCollapsed(false)} title="Expand filters" style={{
          width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)',
          color: 'var(--text)', cursor: 'pointer', fontSize: 13, lineHeight: 1, flexShrink: 0,
        }}>▾</button>
      </div>
    ) : (
      <div style={{
        width: 40, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 10,
      }}>
        <button onClick={() => setCollapsed(false)} title="Expand filters" style={{
          width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)',
          color: 'var(--text)', cursor: 'pointer', fontSize: 13, lineHeight: 1,
        }}>»</button>
        <span style={{
          writingMode: 'vertical-rl', fontSize: 11, fontWeight: 800, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: 1,
        }}>Filters</span>
      </div>
    );
  }

  const lbl = { fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' };
  const sub = { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, fontWeight: 600, color: 'var(--muted)' };
  const inp = {
    height: 32, padding: '0 10px', border: '1.5px solid var(--border)', borderRadius: 8,
    fontSize: 12, color: 'var(--text)', background: 'var(--bg)', outline: 'none', width: '100%',
  };

  if (isTop) {
    const inpSm = { ...inp, width: 128 };
    return (
      <div style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: chips.length ? 10 : 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', flexShrink: 0 }}>Filters</span>
            <ChipsRow />
          </div>
          <button onClick={() => setCollapsed(true)} title="Collapse filters" style={{
            width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text)', cursor: 'pointer', fontSize: 13, lineHeight: 1, flexShrink: 0,
          }}>▴</button>
        </div>

        <div ref={linksRef} style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: 0 }}>
          {/* a thin divider between filter cells -- every cell but the first
              gets a left border + its own padding instead of a plain gap */}
          {extra && <div style={{ display: 'flex', alignItems: 'flex-end', paddingRight: 16 }}>{extra}</div>}
          {hasGroupBy && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 16 }}>
              <span style={lbl}>Group By</span>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', maxWidth: 320 }}>
                {groupBys.map(g => {
                  const id = String(g.GroupByID);
                  const on = groupByIds.map(String).includes(id);
                  const locked = on && requireGroupBy && groupByIds.length === 1;
                  return (
                    <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text)', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.7 : 1 }}>
                      <input type="checkbox" checked={on} disabled={locked}
                        onChange={() => onGroupByChange?.(on ? groupByIds.map(String).filter(x => x !== id) : [...groupByIds.map(String), id])} />
                      {g.GroupByName}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {links.map((l, i) => {
            const st = state[l.LinkID] || {};
            const name = l.LabelOverride || l.FilterName || l.QueryField;
            const opts = options[l.LinkID] || [];
            const selected = st.values || [];
            const open = openLinks.has(l.LinkID);
            const cellStyle = (!hasGroupBy && i === 0)
              ? { paddingRight: 16 }
              : { paddingLeft: 16, paddingRight: 16, borderLeft: '1px solid var(--border)' };

            if (l.FilterType === 'LIST') {
              const q = (st.search || '').toLowerCase().trim();
              const shown = q
                ? opts.filter(o => `${o.label} ${o.value} ${o.sublabel || ''}`.toLowerCase().includes(q))
                : opts;
              const shownVals = shown.map(o => o.value);
              const allShown = shown.length > 0 && shownVals.every(v => selected.includes(v));
              const cb = { width: 14, height: 14, minWidth: 14, accentColor: 'var(--orange)', cursor: 'pointer', margin: 0 };
              return (
                <div key={l.LinkID} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 4, ...cellStyle }}>
                  <span style={lbl}>{name}</span>
                  <button type="button" onClick={() => toggleLink(l.LinkID)} style={{
                    ...inpSm, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                    color: selected.length ? 'var(--text)' : 'var(--muted)', borderColor: selected.length ? 'var(--orange)' : 'var(--border)',
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selected.length ? `${selected.length} selected` : 'Any'}
                    </span>
                    <span style={{ fontSize: 9, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
                  </button>
                  {open && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 240, zIndex: 20,
                      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,.14)', padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
                    }}>
                      <input placeholder="Search…" value={st.search || ''}
                        onChange={e => set(l.LinkID, { search: e.target.value })} style={inp} />
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontWeight: 700 }}>
                          <input type="checkbox" style={cb} checked={allShown}
                            onChange={e => set(l.LinkID, {
                              values: e.target.checked
                                ? [...new Set([...selected, ...shownVals])]
                                : selected.filter(v => !shownVals.includes(v)),
                            })} />
                          Select all{q ? ' (filtered)' : ''}
                        </label>
                        {selected.length > 0 && (
                          <button type="button" onClick={() => set(l.LinkID, { values: [] })}
                            style={{ background: 'none', border: 'none', color: 'var(--orange)', fontWeight: 700, cursor: 'pointer', fontSize: 10 }}>Clear</button>
                        )}
                      </div>
                      <div style={{ maxHeight: 190, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                        {shown.length === 0
                          ? <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--muted)' }}>No matches</div>
                          : shown.map(o => (
                            <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 9px', fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }}>
                              <input type="checkbox" style={cb} checked={selected.includes(o.value)}
                                onChange={e => set(l.LinkID, {
                                  values: e.target.checked ? [...selected, o.value] : selected.filter(v => v !== o.value),
                                })} />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {o.label}{o.sublabel ? <span style={{ color: 'var(--muted)' }}> · {o.sublabel}</span> : null}
                              </span>
                            </label>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            if (l.FilterType === 'DATE_RANGE' || l.FilterType === 'RANGE') {
              const isDate = l.FilterType === 'DATE_RANGE';
              return (
                <div key={l.LinkID} style={{ display: 'flex', flexDirection: 'column', gap: 4, ...cellStyle }}>
                  <span style={lbl}>{name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isDate
                      ? <input type="date" value={st.from || ''} onChange={e => set(l.LinkID, { from: e.target.value })} style={inpSm} />
                      : <LookupSelect linkId={l.LinkID} value={st.from || ''} optionLabel={st.fromLabel || ''}
                          placeholder="From…" onChange={(v, row) => set(l.LinkID, { from: v, fromLabel: row?.label || '' })} />}
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>–</span>
                    {isDate
                      ? <input type="date" value={st.to || ''} onChange={e => set(l.LinkID, { to: e.target.value })} style={inpSm} />
                      : <LookupSelect linkId={l.LinkID} value={st.to || ''} optionLabel={st.toLabel || ''}
                          placeholder="To…" onChange={(v, row) => set(l.LinkID, { to: v, toLabel: row?.label || '' })} />}
                  </div>
                </div>
              );
            }

            if (l.FilterType === 'MIN') {
              return (
                <div key={l.LinkID} style={{ display: 'flex', flexDirection: 'column', gap: 4, ...cellStyle }}>
                  <span style={lbl}>{name}</span>
                  <LookupSelect linkId={l.LinkID} value={st.from || ''} optionLabel={st.fromLabel || ''} placeholder="From…"
                    onChange={(v, row) => set(l.LinkID, { from: v, fromLabel: row?.label || '' })} />
                </div>
              );
            }

            // LIKE / EQUALS -- free text
            return (
              <div key={l.LinkID} style={{ display: 'flex', flexDirection: 'column', gap: 4, ...cellStyle }}>
                <span style={lbl}>{name}{l.FilterType === 'LIKE' ? ' (contains)' : ''}</span>
                <input value={st.from || ''} onChange={e => set(l.LinkID, { from: e.target.value })} style={inpSm} />
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button disabled={applying} onClick={() => runApply(buildFilters())} style={{
              height: 32, padding: '0 18px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              background: 'linear-gradient(135deg, var(--orange), var(--orange2))', opacity: applying ? 0.75 : 1,
              color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: applying ? 'default' : 'pointer',
            }}>{applying && <Spinner />}Apply</button>
            <button disabled={applying} onClick={() => runApply(buildFilters(JSON.parse(JSON.stringify(defaultsRef.current))), JSON.parse(JSON.stringify(defaultsRef.current)))} style={{
              height: 32, padding: '0 14px', background: 'var(--soft)', color: 'var(--text)', opacity: applying ? 0.6 : 1,
              border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: applying ? 'default' : 'pointer',
            }}>Clear</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      width: isTop ? '100%' : 280, flexShrink: isTop ? undefined : 0,
      maxHeight: isTop ? 340 : undefined,
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <div style={{
        padding: '12px 12px 12px 16px', borderBottom: '1px solid var(--border)',
        fontSize: 13, fontWeight: 800, color: 'var(--text)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        Filters
        <button onClick={() => setCollapsed(true)} title="Collapse filters" style={{
          width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)',
          color: 'var(--text)', cursor: 'pointer', fontSize: 13, lineHeight: 1,
        }}>«</button>
      </div>
      <div ref={linksRef} style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {extra && <div>{extra}</div>}
        {hasGroupBy && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={lbl}>Group By</span>
            {groupBys.map(g => {
              const id = String(g.GroupByID);
              const on = groupByIds.map(String).includes(id);
              const locked = on && requireGroupBy && groupByIds.length === 1;
              return (
                <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text)', cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.7 : 1 }}>
                  <input type="checkbox" checked={on} disabled={locked}
                    onChange={() => onGroupByChange?.(on ? groupByIds.map(String).filter(x => x !== id) : [...groupByIds.map(String), id])} />
                  {g.GroupByName}
                </label>
              );
            })}
            <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>
              {requireGroupBy ? 'At least one grouping is required for this page.' : 'Pick one or more, then press Apply.'}
            </span>
          </div>
        )}
        {links.map(l => {
          const st = state[l.LinkID] || {};
          const name = l.LabelOverride || l.FilterName || l.QueryField;
          const opts = options[l.LinkID] || [];
          const selected = st.values || [];
          const open = openLinks.has(l.LinkID);

          let hint = '';
          let body = null;
          if (l.FilterType === 'LIST') {
            if (selected.length) hint = `${selected.length} selected`;
            const q = (st.search || '').toLowerCase().trim();
            const shown = q
              ? opts.filter(o => `${o.label} ${o.value} ${o.sublabel || ''}`.toLowerCase().includes(q))
              : opts;
            const shownVals = shown.map(o => o.value);
            const allShown = shown.length > 0 && shownVals.every(v => selected.includes(v));
            const cb = { width: 14, height: 14, minWidth: 14, accentColor: 'var(--orange)', cursor: 'pointer', margin: 0 };
            body = (
              <>
                <input placeholder="Search…" value={st.search || ''}
                  onChange={e => set(l.LinkID, { search: e.target.value })} style={inp} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--muted)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontWeight: 700 }}>
                    <input type="checkbox" style={cb} checked={allShown}
                      onChange={e => set(l.LinkID, {
                        values: e.target.checked
                          ? [...new Set([...selected, ...shownVals])]
                          : selected.filter(v => !shownVals.includes(v)),
                      })} />
                    Select all{q ? ' (filtered)' : ''}
                  </label>
                  {selected.length > 0 && (
                    <button type="button" onClick={() => set(l.LinkID, { values: [] })}
                      style={{ background: 'none', border: 'none', color: 'var(--orange)', fontWeight: 700, cursor: 'pointer', fontSize: 10 }}>Clear</button>
                  )}
                </div>
                <div style={{ maxHeight: 190, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                  {shown.length === 0
                    ? <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--muted)' }}>No matches</div>
                    : shown.map(o => (
                      <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 9px', fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }}>
                        <input type="checkbox" style={cb} checked={selected.includes(o.value)}
                          onChange={e => set(l.LinkID, {
                            values: e.target.checked ? [...selected, o.value] : selected.filter(v => v !== o.value),
                          })} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {o.label}{o.sublabel ? <span style={{ color: 'var(--muted)' }}> · {o.sublabel}</span> : null}
                        </span>
                      </label>
                    ))}
                </div>
              </>
            );
          } else if (l.FilterType === 'DATE_RANGE' || l.FilterType === 'RANGE') {
            const isDate = l.FilterType === 'DATE_RANGE';
            if (st.from || st.to) hint = `${st.from || '…'} → ${st.to || '…'}`;
            body = (
              <>
                <label style={sub}>From
                  {isDate
                    ? <input type="date" value={st.from || ''} onChange={e => set(l.LinkID, { from: e.target.value })} style={inp} />
                    : <LookupSelect linkId={l.LinkID} value={st.from || ''} optionLabel={st.fromLabel || ''}
                        placeholder="From…" onChange={(v, row) => set(l.LinkID, { from: v, fromLabel: row?.label || '' })} />}
                </label>
                <label style={sub}>To
                  {isDate
                    ? <input type="date" value={st.to || ''} onChange={e => set(l.LinkID, { to: e.target.value })} style={inp} />
                    : <LookupSelect linkId={l.LinkID} value={st.to || ''} optionLabel={st.toLabel || ''}
                        placeholder="To…" onChange={(v, row) => set(l.LinkID, { to: v, toLabel: row?.label || '' })} />}
                </label>
              </>
            );
          } else if (l.FilterType === 'MIN') {
            if (st.from) hint = `≥ ${st.from}`;
            body = (
              <LookupSelect linkId={l.LinkID} value={st.from || ''} optionLabel={st.fromLabel || ''} placeholder="From…"
                onChange={(v, row) => set(l.LinkID, { from: v, fromLabel: row?.label || '' })} />
            );
          } else {
            // LIKE / EQUALS -- free text
            if (st.from) hint = st.from;
            body = (
              <input value={st.from || ''} onChange={e => set(l.LinkID, { from: e.target.value })} style={inp} />
            );
          }

          return (
            <div key={l.LinkID} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <button onClick={() => toggleLink(l.LinkID)} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                background: hint ? 'var(--orange-soft)' : 'var(--soft)', border: 'none', cursor: 'pointer',
                textAlign: 'left',
              }}>
                <span style={{ fontSize: 10, color: 'var(--muted)', width: 10 }}>{open ? '▼' : '▶'}</span>
                <span style={{ ...lbl, flex: 1 }}>
                  {name}{l.FilterType === 'LIKE' ? ' (contains)' : ''}
                </span>
                {hint && !open && (
                  <span style={{ fontSize: 10, color: 'var(--orange)', fontWeight: 700, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {hint}
                  </span>
                )}
              </button>
              {open && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10 }}>
                  {body}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
        <button disabled={applying} onClick={() => runApply(buildFilters())} style={{
          flex: 1, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          background: 'linear-gradient(135deg, var(--orange), var(--orange2))', opacity: applying ? 0.75 : 1,
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: applying ? 'default' : 'pointer',
        }}>{applying && <Spinner />}Apply</button>
        <button disabled={applying} onClick={() => runApply(buildFilters(JSON.parse(JSON.stringify(defaultsRef.current))), JSON.parse(JSON.stringify(defaultsRef.current)))} style={{
          height: 32, padding: '0 14px', background: 'var(--soft)', color: 'var(--text)', opacity: applying ? 0.6 : 1,
          border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: applying ? 'default' : 'pointer',
        }}>Clear</button>
      </div>
    </div>
  );
});

export default DynamicFilterBar;
