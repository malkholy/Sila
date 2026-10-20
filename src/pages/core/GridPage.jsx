import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { apiCall } from '../../shared/api.js';
import DataGrid from '../../shared/DataGrid.jsx';
import DynamicFilterBar from '../../shared/DynamicFilterBar.jsx';
import DataViewModal from '../../shared/DataViewModal.jsx';
import TrendChart from '../../shared/TrendChart.jsx';

// Generic data-grid page. Every page that has no bespoke component renders
// through here: it asks the server for its rows via the generic GetGridData
// operation (Query Master -> Page mapping -> permissions -> SQL) and for its
// column config via GetQueryFields. The frontend never defines the SQL.
//
// Two independent presentation layers sit on top of the rows:
//   * Data View (docs/data-view.md) -- a per-user saved column layout (which
//     fields show, order, display name, width, format). Presentation only.
//   * Group By -- the user picks one or more Group By configs; GetGridData
//     returns an aggregated result. Grouping OVERRIDES the Data View selector:
//     grouped columns don't match any layout, so raw result columns are shown
//     and the View dropdown is hidden.

const COLORS = {
  green: 'var(--green)', red: 'var(--red)', blue: '#2563eb',
  amber: '#b45309', gray: 'var(--muted)',
};
const COLOR_SOFT = {
  green: 'var(--green-soft)', red: 'var(--red-soft)', blue: 'rgba(37,99,235,.12)',
  amber: 'rgba(180,83,9,.12)', gray: 'var(--soft)',
};

const SYSTEM_VIEW = '__system__';

// KPI card value formatting
function fmtKpi(v, format) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (format === 'integer') return Math.round(n).toLocaleString();
  if (format === 'currency') return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'percent') return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%';
  if (format === 'compact' || format === 'compact-currency') {
    const abs = Math.abs(n);
    const unit = abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : ['', 1];
    return (n / unit[1]).toLocaleString(undefined, { maximumFractionDigits: unit[0] ? 1 : 0 }) + unit[0];
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// accent colour by the KPI's format / operation
function kpiAccent(d) {
  if (d.Format === 'currency' || d.Format === 'compact') return 'var(--green)';
  if (d.Format === 'percent') return 'var(--amber)';
  if (d.Operation === 'COUNT') return 'var(--blue)';
  return 'var(--orange)';
}

function KpiStrip({ defs, vals, loading, onHide }) {
  return (
    <div className="kpi-strip">
      {defs.map(d => {
        const col = d.ColName ?? ('k_' + d.KPIID);
        const has = Object.prototype.hasOwnProperty.call(vals, col);
        const sub = [String(d.Operation || '').toLowerCase(), d.Format && d.Format !== 'number' ? d.Format : null]
          .filter(Boolean).join(' · ');
        return (
          <div key={d.KPIID} className="kpi-chip" style={{ '--kc-accent': kpiAccent(d) }} title={d.KPIName}>
            <div className="kc-label">{d.DisplayName}</div>
            {loading && !has
              ? <span className="kc-skel" />
              : <div className="kc-value">{fmtKpi(vals[col], d.Format)}</div>}
            {sub && <div className="kc-sub">{sub}</div>}
          </div>
        );
      })}
      {onHide && <button className="kpi-strip-toggle" onClick={onHide} title="Hide KPIs">▾ Hide</button>}
    </div>
  );
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a date value against a Data View DateFormat pattern
// (dd/MM/yyyy, MM/dd/yyyy, dd-MMM-yyyy, yyyy-MM-dd, dd/MM/yyyy HH:mm, ...).
function formatDate(v, pattern) {
  if (v == null || v === '') return '';
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(v);
  const pad = (n) => String(n).padStart(2, '0');
  return pattern
    .replace(/yyyy/g, d.getFullYear())
    .replace(/MMM/g, MONTHS[d.getMonth()])
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()));
}

// number-shaped formats -- also drives right-alignment for the columns below.
// 'integer'/'currency'/'percent' previously only worked in the KPI strip
// (fmtKpi); a grid column (esp. a Group By aggregate) using them fell
// through to a plain unformatted String(v) with no visible change.
const NUMERIC_FORMAT_RE = /^(number|integer|currency|percent|compact)/;
const isNumericFormat = (f) => NUMERIC_FORMAT_RE.test(f || '');

function fmtValue(v, field) {
  if (v == null) return '';
  const f = field.Format || '';
  if (field.DateFormat) return formatDate(v, field.DateFormat);
  if (f === 'date') return String(v).slice(0, 10);
  if (f === 'datetime') return String(v).replace('T', ' ').slice(0, 16);
  if (f === 'yesno') return (v === true || v === 1 || v === '1') ? 'Yes' : 'No';
  if (f === 'integer') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n).toLocaleString() : String(v);
  }
  if (f === 'currency') {
    const n = Number(v);
    return Number.isFinite(n)
      ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(v);
  }
  if (f === 'percent') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%' : String(v);
  }
  if (f === 'compact') {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const abs = Math.abs(n);
    const unit = abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : ['', 1];
    return (n / unit[1]).toLocaleString(undefined, { maximumFractionDigits: unit[0] ? 1 : 0 }) + unit[0];
  }
  if (field.DecimalPlaces != null || f.startsWith('number')) {
    const dp = field.DecimalPlaces != null
      ? field.DecimalPlaces
      : (parseInt(f.split(':')[1] ?? '0', 10) || 0);
    const n = Number(v);
    return Number.isFinite(n)
      ? n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
      : String(v);
  }
  return String(v);
}

function pickColor(v, rules) {
  if (!rules) return null;
  let parsed;
  try { parsed = JSON.parse(rules); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const sv = String(v ?? '');
  const nv = Number(v);
  for (const r of parsed) {
    const rv = r.value;
    let hit = false;
    switch (r.op) {
      case 'default': hit = true; break;
      case 'eq': hit = sv === String(rv); break;
      case 'ne': hit = sv !== String(rv); break;
      case 'contains': hit = sv.toLowerCase().includes(String(rv).toLowerCase()); break;
      case 'lt': hit = nv < Number(rv); break;
      case 'le': hit = nv <= Number(rv); break;
      case 'gt': hit = nv > Number(rv); break;
      case 'ge': hit = nv >= Number(rv); break;
      default: hit = false;
    }
    if (hit) return { color: r.color || 'gray', badge: !!r.badge };
  }
  return null;
}

function makeRender(field) {
  return (value) => {
    const text = fmtValue(value, field);
    if (text === '') return '';
    const c = pickColor(value, field.ColorRules);
    const mono = field.Format === 'mono';
    if (!c) {
      return mono ? <span style={{ fontFamily: 'var(--mono, monospace)' }}>{text}</span> : text;
    }
    if (c.badge) {
      return (
        <span style={{
          padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
          color: COLORS[c.color], background: COLOR_SOFT[c.color],
        }}>{text}</span>
      );
    }
    return <span style={{ color: COLORS[c.color], fontWeight: 600 }}>{text}</span>;
  };
}

// onRowsChange(rows, grouped): optional -- told the rows each load returns
// (the current filter's rows), e.g. for a page-level "Post All" summary.
// `extraFilters` (opt-in): page-driven Filters entries ([{ LinkID, Values | From/To }],
// UsePanel = 1 links) sent with every GetGridData / GetKPIData on top of the
// panel's; the grid loads at once (no "press Apply" gate) and reloads when they
// change. `hideFilterFields`: QueryFields whose links the panel doesn't show
// (the page drives them, e.g. through extraFilters). `groupByNames` (opt-in):
// page-driven Group By selection by V1GroupByMaster.GroupByName ([] = none);
// applied at boot and whenever it changes, together with extraFilters.
// `gridPresentation` (opt-in): { filterLayout: 'top' } puts the filter panel
// above the grid instead of in a left sidebar (Order Board pages, so switching
// to a grouped view doesn't move it). `filterExtra`: page content shown first
// inside the filter panel (e.g. the Order Board view switch).
export default function GridPage({ user, def, onRowActivate, onAdd, onEditRow, onDeleteRow, onDuplicateRow, toolbarExtra, refreshSignal, activateOnSingleClick = false, activateWhileGrouped, onGroupByIdsChange, customActions, onRowsChange, extraFilters, hideFilterFields, groupByNames, gridPresentation, filterExtra }) {
  const onRowsChangeRef = useRef(onRowsChange);
  onRowsChangeRef.current = onRowsChange;
  const pageGroupId = def?.id;
  const requireGroupBy = !!def?.requireGroupBy;
  const storeKey = pageGroupId != null ? `dvSelected_${pageGroupId}` : null;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notBound, setNotBound] = useState(false);
  const [queryId, setQueryId] = useState(null);

  // Data View layer
  const [sysFields, setSysFields] = useState([]);      // V1QueryFields -- System Default Layout
  const [views, setViews] = useState([]);              // this user's Data View headers
  const [viewFields, setViewFields] = useState(null);  // active view's fields, or null for system
  const [activeView, setActiveView] = useState(SYSTEM_VIEW);

  // filter panel + group by
  const [hasPanel, setHasPanel] = useState(false);
  const [awaitingApply, setAwaitingApply] = useState(false);   // page has panel filters, wait for Apply
  const [groupBys, setGroupBys] = useState([]);       // active Group By configs for this page
  const [groupByIds, setGroupByIds] = useState([]);   // selected config ids (multi)
  const [groupedMeta, setGroupedMeta] = useState([]); // GetGridData List1 while grouped: [{FieldName,Label,Format,ColorRules}]
  const [groupColOrder, setGroupColOrder] = useState([]); // saved column order (FieldNames) for the active GroupByIDs combo
  const [dvModalOpen, setDvModalOpen] = useState(false);

  // KPIs -- server-calculated summary cards above the grid, synced to the
  // active filter/search (independent of Group By and Data View).
  const [kpiDefs, setKpiDefs] = useState([]);      // GetPageKPIs
  const [kpiVals, setKpiVals] = useState({});      // { ColName: value }
  const [kpiLoading, setKpiLoading] = useState(false);
  const [kpiHidden, setKpiHidden] = useState(false);

  const filtersRef = useRef([]);   // Filters payload from the DynamicFilterBar
  // page-driven mode (extraFilters): the first load waits for the panel's
  // seeded defaults (DynamicFilterBar onSeed), so it matches what the panel shows
  const seedRef = useRef(null);
  const waitSeedRef = useRef(false);
  const extraFiltersRef = useRef(extraFilters || []);
  extraFiltersRef.current = extraFilters || [];
  const allFilters = () => [...filtersRef.current, ...extraFiltersRef.current];
  const groupByNamesRef = useRef(groupByNames);
  groupByNamesRef.current = groupByNames;
  const groupBysRef = useRef([]);
  // select the page-driven Group By configs (by name) among this page's configs
  const applyGroupByNames = (list) => {
    const names = groupByNamesRef.current;
    if (!Array.isArray(names)) return;
    const ids = (list || []).filter(g => names.includes(g.GroupByName)).map(g => String(g.GroupByID));
    setGroupByIds(ids);
    groupByIdsRef.current = ids;
    currentGroupOrderRef.current = [];
    onGroupByIdsChange?.(ids);
  };
  const bootRef = useRef(0);
  const queryIdRef = useRef(null);
  const groupByIdsRef = useRef([]);
  const groupOrderSaveTimerRef = useRef(null);
  const currentGroupOrderRef = useRef([]);   // live column order of the grouped grid (for "set as default")
  const kpiDefsRef = useRef([]);
  const kpiVisKey = pageGroupId != null ? `kpiHidden_${pageGroupId}` : null;

  // --- data fetch (rows only; column config is resolved in the boot effect) ---
  const load = useCallback(async () => {
    if (pageGroupId == null) return;
    setAwaitingApply(false);
    setLoading(true);
    setError(null);
    setNotBound(false);
    try {
      const payload = { PageGroupID: pageGroupId, Filters: allFilters() };
      const groupIds = groupByIdsRef.current.map(Number);
      if (groupIds.length > 0) payload.GroupByIDs = groupIds;
      // Fetch the saved column order ALONGSIDE the grid data (not after) and
      // apply both together. DataGrid snapshots whatever column order it's
      // first given and preserves that snapshot across same-key-set refreshes
      // (so a user's manual drag survives a data reload) -- if groupedMeta
      // landed first in default order, that snapshot would win permanently
      // and the saved order arriving a beat later would never take effect.
      const orderPromise = groupIds.length > 0
        ? apiCall('GetGroupByColumnOrder', { PageGroupID: pageGroupId, GroupByIDs: groupIds }, {}, 'plus').catch(() => null)
        : Promise.resolve(null);
      const [dataRes, orderRes] = await Promise.all([apiCall('GetGridData', payload, {}, 'plus'), orderPromise]);
      if (dataRes.State === -1) { setNotBound(true); setRows([]); setLoading(false); return; }
      if (dataRes.State !== 0) { setError(dataRes.Message || 'Failed to load data'); setLoading(false); return; }
      setRows(dataRes.List0 || []);
      onRowsChangeRef.current?.(dataRes.List0 || [], groupIds.length > 0);
      setGroupedMeta(groupIds.length > 0 ? (dataRes.List1 || []) : []);
      setGroupColOrder(orderRes && orderRes.State === 0 ? (orderRes.List0 || []).map(x => x.FieldName) : []);
    } catch (e) {
      setError('Connection error: ' + e.message);
    }
    setLoading(false);
    loadKpis();
  }, [pageGroupId]);

  // KPI values for the current filter set (same Filters as the grid; Group By
  // is deliberately not passed).
  const loadKpis = useCallback(async () => {
    if (pageGroupId == null || kpiDefsRef.current.length === 0) return;
    setKpiLoading(true);
    try {
      const res = await apiCall('GetKPIData', { PageGroupID: pageGroupId, Filters: allFilters() }, {}, 'plus');
      if (res.State === 0) {
        const valRow = (res.List0 || [])[0] || {};
        const map = {};
        (res.List1 || []).forEach(m => { map['k_' + m.KPIID] = valRow[m.ColName]; });
        setKpiVals(map);   // defs (with Operation/Format) stay as loaded at boot
      }
    } catch { /* leave last values */ }
    setKpiLoading(false);
  }, [pageGroupId]);

  // page-driven filters changed -> reload (after boot resolved the query)
  const extraKey = JSON.stringify([extraFilters || null, groupByNames || null]);
  const extraKeyRef = useRef(extraKey);
  useEffect(() => {
    if (extraKey === extraKeyRef.current) return;
    extraKeyRef.current = extraKey;
    if (pageGroupId == null || queryIdRef.current == null) return;
    applyGroupByNames(groupBysRef.current);
    load();
  }, [extraKey, pageGroupId, load]);

  // Parent-driven soft refresh (e.g. after the PO form closes). Re-runs the
  // current query with the filters already applied -- unlike a remount, it
  // does not send the user back to the "press Apply" gate.
  const refreshedRef = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === refreshedRef.current) return;
    refreshedRef.current = refreshSignal;
    if (pageGroupId == null || awaitingApply) return;
    load();
  }, [refreshSignal, awaitingApply, pageGroupId, load]);

  // Resolve the page's query, its column layout / Data Views, group-by configs
  // and panel-filter count up-front. A page with panel filters waits for Apply.
  useEffect(() => {
    if (pageGroupId == null) return;
    const boot = ++bootRef.current;
    setLoading(true); setError(null); setNotBound(false);
    setRows([]); setQueryId(null); setHasPanel(false); setAwaitingApply(false);
    setSysFields([]); setViews([]); setViewFields(null); setActiveView(SYSTEM_VIEW);
    setGroupBys([]); setGroupByIds([]); groupByIdsRef.current = [];
    filtersRef.current = [];
    seedRef.current = null; waitSeedRef.current = false;
    (async () => {
      try {
        const qm = await apiCall('GetQueryMaster', {}, {}, 'plus');
        if (boot !== bootRef.current) return;
        const pageQs = (qm.List0 || []).filter(r => String(r.PageGroupID) === String(pageGroupId));
        const q = pageQs.find(r => r.QueryType === 'Base') || pageQs[0];
        const qid = q?.QueryID ?? null;
        queryIdRef.current = qid;
        setQueryId(qid);
        if (qid == null) { setNotBound(true); setLoading(false); return; }

        // column layout: system fields + this user's Data Views
        try {
          const [fRes, vRes] = await Promise.all([
            apiCall('GetQueryFields', { QueryID: qid }, {}, 'plus'),
            apiCall('GetDataViews', { PageGroupID: pageGroupId, QueryID: qid }, {}, 'plus'),
          ]);
          if (boot !== bootRef.current) return;
          const sys = fRes.State === 0 ? (fRes.List0 || []) : [];
          const vlist = vRes.State === 0 ? (vRes.List0 || []) : [];
          setSysFields(sys);
          setViews(vlist);

          let saved = null;
          try { saved = storeKey ? localStorage.getItem(storeKey) : null; } catch { /* ignore */ }
          const savedId = saved && saved !== SYSTEM_VIEW ? Number(saved) : null;
          let active = SYSTEM_VIEW;
          if (saved === SYSTEM_VIEW) active = SYSTEM_VIEW;
          else if (savedId && vlist.some(v => v.DataViewID === savedId)) active = savedId;
          else {
            const defView = vlist.find(v => v.IsDefault === 1 || v.IsDefault === true);
            active = defView ? defView.DataViewID : SYSTEM_VIEW;
          }
          setActiveView(active);
          if (active !== SYSTEM_VIEW) {
            const dv = await apiCall('GetDataView', { DataViewID: active }, {}, 'plus');
            if (boot === bootRef.current) setViewFields(dv.State === 0 ? (dv.List1 || []) : null);
          }
        } catch { /* layout stays on system default */ }

        // group-by configs for this page's Base query
        try {
          const gb = await apiCall('GetPageGroupBys', { PageGroupID: pageGroupId }, {}, 'plus');
          if (boot === bootRef.current && gb.State === 0) {
            const list = gb.List0 || [];
            setGroupBys(list);
            groupBysRef.current = list;
            // pre-check the configs marked Default (Group By tab -- V1GroupByMaster.IsDefault)
            const defaults = list.filter(g => g.IsDefault === 1 || g.IsDefault === true).map(g => String(g.GroupByID));
            if (defaults.length) { setGroupByIds(defaults); groupByIdsRef.current = defaults; }
            applyGroupByNames(list);   // a page-driven selection wins over the defaults
          }
        } catch { /* no group-bys */ }

        // KPI configs + this user's show/hide preference
        try {
          let hidden = false;
          try { hidden = localStorage.getItem(kpiVisKey) === '1'; } catch { /* ignore */ }
          const [kd, kv] = await Promise.all([
            apiCall('GetPageKPIs', { PageGroupID: pageGroupId }, {}, 'plus'),
            apiCall('GetKPIVisibility', { PageGroupID: pageGroupId }, {}, 'plus'),
          ]);
          if (boot !== bootRef.current) return;
          const defs = kd.State === 0 ? (kd.List0 || []) : [];
          kpiDefsRef.current = defs;
          setKpiDefs(defs.map(d => ({ ...d, ColName: 'k_' + d.KPIID })));
          if (kv.State === 0 && (kv.List0 || [])[0]) hidden = !!(kv.List0[0].IsHidden === 1 || kv.List0[0].IsHidden === true);
          setKpiHidden(hidden);
        } catch { kpiDefsRef.current = []; }

        // interactive (panel) filters? if so, wait for Apply
        let panelCount = 0;
        try {
          const lk = await apiCall('GetQueryFilterLinks', { QueryID: qid, PageGroupID: pageGroupId }, {}, 'plus');
          if (lk.State === 0) panelCount = (lk.List0 || []).filter(l => l.UsePanel === 1 || l.UsePanel === true).length;
        } catch { /* treat as none */ }
        if (boot !== bootRef.current) return;
        setHasPanel(panelCount > 0);
        // a page driving extraFilters loads at once -- with the panel's seeded defaults
        if (panelCount > 0 && !extraFilters) { setAwaitingApply(true); setLoading(false); }
        else if (panelCount > 0 && extraFilters) {
          if (seedRef.current) { filtersRef.current = seedRef.current; load(); }
          else waitSeedRef.current = true;   // DynamicFilterBar onSeed loads
        }
        else load();
      } catch (e) {
        if (boot === bootRef.current) { setError('Connection error: ' + e.message); setLoading(false); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageGroupId]);

  function toggleKpis(hide) {
    setKpiHidden(hide);
    try { localStorage.setItem(kpiVisKey, hide ? '1' : '0'); } catch { /* ignore */ }
    apiCall('SaveKPIVisibility', { PageGroupID: pageGroupId, IsHidden: hide ? 1 : 0 }, {}, 'plus').catch(() => {});
    if (!hide) loadKpis();
  }

  async function selectView(value) {
    setActiveView(value);
    try { if (storeKey) localStorage.setItem(storeKey, String(value)); } catch { /* ignore */ }
    if (value === SYSTEM_VIEW) { setViewFields(null); return; }
    setLoading(true);
    try {
      const dv = await apiCall('GetDataView', { DataViewID: Number(value) }, {}, 'plus');
      setViewFields(dv.State === 0 ? (dv.List1 || []) : null);
    } catch (e) {
      setError('Connection error: ' + e.message);
    }
    setLoading(false);
  }

  // after a Data View is created / edited / deleted in the modal
  async function refreshViews(nextId) {
    if (queryId == null) return;
    try {
      const vRes = await apiCall('GetDataViews', { PageGroupID: pageGroupId, QueryID: queryId }, {}, 'plus');
      const vlist = vRes.State === 0 ? (vRes.List0 || []) : [];
      setViews(vlist);
      if (nextId != null) {
        await selectView(nextId === SYSTEM_VIEW ? SYSTEM_VIEW : Number(nextId));
      } else if (activeView !== SYSTEM_VIEW && !vlist.some(v => v.DataViewID === activeView)) {
        await selectView(SYSTEM_VIEW);
      }
    } catch { /* ignore */ }
  }

  const grouped = groupByIds.length > 0;

  const columns = useMemo(() => {
    // grouped result columns don't match a Data View layout, but the server
    // still sends render metadata for them (List1) -- group fields resolve
    // against this query's V1QueryFields, aggregate columns use the Format
    // chosen on the Group By config -- so they go through the same render
    // pipeline (number/date formatting, color rules) as a normal grid.
    if (grouped) {
      if (groupedMeta.length) {
        // apply the caller's saved order (GetGroupByColumnOrder) if any --
        // known fields first in the saved sequence, anything new (e.g. the
        // config changed) appended in the server's default order.
        let metaList = groupedMeta;
        if (groupColOrder.length) {
          const byKey = Object.fromEntries(groupedMeta.map(f => [f.FieldName, f]));
          const known = groupColOrder.filter(k => byKey[k]).map(k => byKey[k]);
          const rest = groupedMeta.filter(f => !groupColOrder.includes(f.FieldName));
          metaList = [...known, ...rest];
        }
        return metaList.map(f => ({
          key: f.FieldName,
          label: f.Label || f.FieldName,
          align: isNumericFormat(f.Format) ? 'right' : undefined,
          numeric: isNumericFormat(f.Format),
          render: makeRender(f),
        }));
      }
      const keys = rows.length ? Object.keys(rows[0]) : [];
      return keys.map(k => ({ key: k, label: k }));
    }

    const sysByName = Object.fromEntries(sysFields.map(f => [f.FieldName, f]));

    if (viewFields && viewFields.length) {
      return viewFields
        .filter(f => f.Visible === 1 || f.Visible === true)
        .slice()
        .sort((a, b) => (a.DisplayOrder ?? 1e9) - (b.DisplayOrder ?? 1e9))
        .map(f => {
          const sys = sysByName[f.FieldName] || {};
          const resolved = {
            FieldName: f.FieldName,
            Format: f.Format || sys.Format || '',
            DecimalPlaces: f.DecimalPlaces,
            DateFormat: f.DateFormat,
            ColorRules: sys.ColorRules,
          };
          const align = f.Alignment
            ? f.Alignment.toLowerCase()
            : (isNumericFormat(resolved.Format) || resolved.DecimalPlaces != null ? 'right' : undefined);
          return {
            key: f.FieldName,
            label: f.DisplayName || sys.Label || f.FieldName,
            width: f.Width || sys.Width || undefined,
            align,
            numeric: isNumericFormat(resolved.Format) || resolved.DecimalPlaces != null,
            render: makeRender(resolved),
          };
        });
    }

    // System Default Layout
    if (sysFields.length) {
      return sysFields
        .filter(f => !(f.Hidden === 1 || f.Hidden === true))
        .map(f => ({
          key: f.FieldName,
          label: f.Label || f.FieldName,
          width: f.Width || undefined,
          align: isNumericFormat(f.Format) ? 'right' : undefined,
          numeric: isNumericFormat(f.Format),
          render: makeRender(f),
        }));
    }

    const keys = rows.length ? Object.keys(rows[0]) : [];
    return keys.map(k => ({ key: k, label: k }));
  }, [grouped, groupedMeta, groupColOrder, viewFields, sysFields, rows]);

  // Trend chart -- only when the CURRENT Group By combo groups purely by a
  // time dimension (Year / Month / Quarter / Date, no Customer/Item/etc.
  // mixed in): a "By Month" or "By Year" config, not "By Customer & Month".
  // Generic across every page (config-driven, not Sales-Statistics-specific):
  // a group field is any groupedMeta column that's also a real column of the
  // Base query (V1QueryFields); anything else is a computed aggregate.
  const trend = useMemo(() => {
    if (!grouped || !groupedMeta.length || !rows.length) return null;
    const sysNames = new Set(sysFields.map(f => f.FieldName));
    const dims = groupedMeta.filter(f => sysNames.has(f.FieldName));
    const aggs = groupedMeta.filter(f => !sysNames.has(f.FieldName) && isNumericFormat(f.Format));
    if (!dims.length || !aggs.length) return null;
    const TIME_RE = /year|month|quarter|date|period/i;
    if (!dims.every(d => TIME_RE.test(d.FieldName))) return null;

    const agg = aggs.find(a => /amount|total/i.test(a.FieldName)) || aggs[0];
    const yearF = dims.find(d => /year/i.test(d.FieldName));
    const monthF = dims.find(d => /month/i.test(d.FieldName));
    const quarterF = dims.find(d => /quarter/i.test(d.FieldName));
    const dateF = dims.find(d => /date/i.test(d.FieldName) && d !== yearF && d !== monthF);

    const rowLabel = (r) => {
      if (dateF) return String(r[dateF.FieldName] ?? '').slice(0, 10);
      if (yearF && monthF) return `${r[yearF.FieldName]}-${String(r[monthF.FieldName]).padStart(2, '0')}`;
      if (yearF && quarterF) return `${r[yearF.FieldName]} Q${r[quarterF.FieldName]}`;
      if (yearF) return String(r[yearF.FieldName]);
      return dims.map(d => r[d.FieldName]).join(' ');
    };
    const sortKey = (r) => {
      if (dateF) return new Date(r[dateF.FieldName]).getTime() || 0;
      return (Number(r[yearF?.FieldName]) || 0) * 10000 + (Number(r[monthF?.FieldName] ?? r[quarterF?.FieldName]) || 0);
    };

    const points = rows
      .map(r => ({ label: rowLabel(r), value: Number(r[agg.FieldName]) || 0, key: sortKey(r) }))
      .sort((a, b) => a.key - b.key);
    if (points.length < 2) return null;
    return { points, label: agg.Label || agg.FieldName, format: (v) => fmtValue(v, agg) };
  }, [grouped, groupedMeta, rows, sysFields]);

  // debounced save of a grouped grid's column order after the user drags one
  const onGroupColumnOrderChange = useCallback((orderKeys) => {
    currentGroupOrderRef.current = orderKeys;
    if (pageGroupId == null || groupByIdsRef.current.length === 0) return;
    clearTimeout(groupOrderSaveTimerRef.current);
    groupOrderSaveTimerRef.current = setTimeout(() => {
      apiCall('SaveGroupByColumnOrder', {
        PageGroupID: pageGroupId, GroupByIDs: groupByIdsRef.current.map(Number), Fields: orderKeys,
      }, {}, 'plus').catch(() => {});
    }, 500);
  }, [pageGroupId]);

  // Admin-only: publish the CURRENT column order as this Group By combo's
  // page-wide default (V1UserGroupByColumnOrder, Username='__default__') --
  // what every user without their own saved order sees, instead of the
  // server's arbitrary field-merge order.
  const [savingDefaultOrder, setSavingDefaultOrder] = useState(false);
  async function saveAsPageDefaultOrder() {
    if (pageGroupId == null || groupByIdsRef.current.length === 0) return;
    const orderKeys = currentGroupOrderRef.current.length ? currentGroupOrderRef.current : columns.map(c => c.key);
    if (!orderKeys.length) return;
    setSavingDefaultOrder(true);
    try {
      await apiCall('SaveGroupByColumnOrder', {
        PageGroupID: pageGroupId, GroupByIDs: groupByIdsRef.current.map(Number),
        Fields: orderKeys, AsDefault: true,
      }, {}, 'plus');
    } catch { /* ignore */ }
    setSavingDefaultOrder(false);
  }

  // the Filter Panel shows when the page has panel filters OR group-by configs;
  // while shown, the Group By selector lives in the panel, not the toolbar.
  const panelVisible = hasPanel || groupBys.length > 0 || !!filterExtra;
  const filterTop = gridPresentation?.filterLayout === 'top';

  const toggleGroupBy = (id, reload) => {
    const s = String(id);
    const isOn = groupByIds.includes(s);
    if (isOn && requireGroupBy && groupByIds.length === 1) return;   // at least one required
    const next = isOn ? groupByIds.filter(x => x !== s) : [...groupByIds, s];
    setGroupByIds(next);
    groupByIdsRef.current = next;
    currentGroupOrderRef.current = [];
    if (reload) load();
  };

  // toolbar controls: Data View select (hidden while grouped) + Group By
  // checkboxes only when there's no filter panel to host them.
  const toolbarControls = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      {toolbarExtra}
      {queryId != null && !grouped && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>
          View
          <select
            value={String(activeView)}
            onChange={e => selectView(e.target.value === SYSTEM_VIEW ? SYSTEM_VIEW : Number(e.target.value))}
            style={{
              height: 32, borderRadius: 8, fontSize: 12, padding: '0 8px',
              border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', outline: 'none',
            }}>
            <option value={SYSTEM_VIEW}>Default (system)</option>
            {views.map(v => (
              <option key={v.DataViewID} value={String(v.DataViewID)}>
                {v.DataViewName}{v.IsDefault === 1 || v.IsDefault === true ? '  ★' : ''}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setDvModalOpen(true)} title="Manage Data Views"
            style={{ height: 32, width: 32, borderRadius: 8, fontSize: 13, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}>⚙</button>
        </label>
      )}
      {grouped && (
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>Grouped view</span>
      )}
      {grouped && user?.IsAdmin && (
        <button type="button" onClick={saveAsPageDefaultOrder} disabled={savingDefaultOrder}
          title="Save the current column order as everyone's default for this grouping"
          style={{
            height: 28, padding: '0 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            border: '1px solid var(--border)', borderRadius: 6, background: 'var(--soft)', color: 'var(--text)',
          }}>
          {savingDefaultOrder ? 'Saving…' : '★ Set as Default Order'}
        </button>
      )}
      {!panelVisible && groupBys.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text)' }}>
          <span style={{ fontWeight: 700, color: 'var(--muted)' }}>Group By:</span>
          {groupBys.map(g => {
            const on = groupByIds.includes(String(g.GroupByID));
            const locked = on && requireGroupBy && groupByIds.length === 1;
            return (
              <label key={g.GroupByID} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.7 : 1 }}>
                <input type="checkbox" checked={on} disabled={locked}
                  onChange={() => toggleGroupBy(g.GroupByID, true)} />
                {g.GroupByName}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );

  if (notBound) {
    return (
      <div style={{ textAlign: 'center', padding: '64px 24px', color: 'var(--muted)', flex: 1 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>{def?.icon || '🧩'}</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{def?.label || 'Page'}</div>
        <div style={{ fontSize: 12.5, marginTop: 6 }}>
          No query is mapped to this page yet. Register one in Query Master.
        </div>
      </div>
    );
  }

  if (error) {
    return <div className="err-page" style={{ flex: 1 }}>{error}</div>;
  }

  // page-driven mode (extraFilters) keeps the normal layout while loading: the
  // filter panel must stay mounted -- its seeded defaults (onSeed) are what
  // trigger the first load, and the grid shows its own loading row meanwhile
  if (loading && rows.length === 0 && !awaitingApply && !extraFilters) {
    return (
      <div className="loading-wrap" style={{ flex: 1 }}>
        <div className="spinner" />
        <div>Loading {def?.label || 'page'}…</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%', flexDirection: filterTop ? 'column' : 'row', gap: panelVisible ? (filterTop ? 14 : 20) : 0 }}>
      <DataViewModal
        open={dvModalOpen}
        onClose={() => setDvModalOpen(false)}
        pageGroupId={pageGroupId}
        queryId={queryId}
        sysFields={sysFields}
        onChanged={(id) => refreshViews(id)}
      />
      <DynamicFilterBar
        queryId={queryId}
        pageGroupId={pageGroupId}
        hideFields={hideFilterFields}
        layout={filterTop ? 'top' : 'sidebar'}
        extra={filterExtra}
        onSeed={(f) => {
          seedRef.current = f;
          if (waitSeedRef.current) { waitSeedRef.current = false; filtersRef.current = f; load(); }
        }}
        onCount={(n) => setHasPanel(n > 0)}
        onApply={(f) => { filtersRef.current = f; load(); }}
        groupBys={groupBys}
        groupByIds={groupByIds}
        requireGroupBy={requireGroupBy}
        onGroupByChange={(ids) => {
          if (requireGroupBy && ids.length === 0) return;   // at least one required
          setGroupByIds(ids);
          groupByIdsRef.current = ids;
          onGroupByIdsChange?.(ids);
          currentGroupOrderRef.current = [];
          // Group By reloads immediately on every toggle -- except the very
          // first load of a page with panel filters, where the user still
          // has to press Apply once (same as the other filters) before any
          // data (and hence any Group By config) has loaded at all.
          if (!awaitingApply) load();
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
        {kpiDefs.length > 0 && !awaitingApply && (
          kpiHidden ? (
            <div className="kpi-strip-bar">
              <button className="kpi-strip-toggle" onClick={() => toggleKpis(false)}>▸ Show KPIs ({kpiDefs.length})</button>
            </div>
          ) : (
            <KpiStrip defs={kpiDefs} vals={kpiVals} loading={kpiLoading} onHide={() => toggleKpis(true)} />
          )
        )}
        {trend && !awaitingApply && (
          <TrendChart points={trend.points} label={trend.label} formatValue={trend.format} />
        )}
        {awaitingApply && rows.length === 0 ? (
          <>
            {toolbarExtra && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                {toolbarExtra}
              </div>
            )}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', gap: 8 }}>
              <div style={{ fontSize: 28 }}>{def?.icon || '🔎'}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Set your filters, then press Apply</div>
              <div style={{ fontSize: 12 }}>{def?.label || 'This page'} loads once you apply the filter panel.</div>
            </div>
          </>
        ) : (
          <DataGrid
            title={def?.label || 'Data'}
            columns={columns}
            rows={rows}
            loading={loading}
            onRefresh={load}
            onAdd={grouped ? undefined : onAdd}
            onEdit={grouped ? undefined : onEditRow}
            onDelete={grouped ? undefined : onDeleteRow}
            onView={(grouped && !activateWhileGrouped) ? undefined : onRowActivate}
            activateOnSingleClick={activateOnSingleClick}
            onDuplicate={grouped ? undefined : onDuplicateRow}
            customActions={grouped ? undefined : customActions}
            viewDropdown={toolbarControls}
            onColumnOrderChange={grouped ? onGroupColumnOrderChange : undefined}
          />
        )}
      </div>
    </div>
  );
}
