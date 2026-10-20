import { useState, useEffect, useRef, useLayoutEffect, useMemo, memo } from "react";
import { createPortal } from "react-dom";

const CSS = `
*{box-sizing:border-box;margin:0;padding:0;font-family:Inter,Segoe UI,Arial,sans-serif}
/* No :root block here on purpose -- this used to redeclare --bg/--surface/etc.
   with its own hardcoded palette, which (since :root applies document-wide)
   silently reset the ACTIVE theme's colors the moment any grid mounted,
   fighting the app-level theme in App.jsx's own :root/.dark/.warm-ivory
   blocks. It now inherits --primary/--primary-dark/--primary-soft (aliased
   to --orange/--orange2/--orange-soft there) and everything else from that
   single source of truth instead. */
.dg-page-head{display:flex;justify-content:space-between;gap:14px;margin-bottom:18px}
.dg-page-head h1{font-size:26px;font-weight:900}
.dg-muted{color:var(--muted);font-size:14px}
.dg-grid-panel{background:var(--surface);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;flex:1;min-height:0}
.dg-grid-title{padding:16px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between}
.dg-grid-title h3{font-size:18px;font-weight:900}
.dg-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid var(--border)}
.dg-selected{color:#0b5ed7;font-weight:900;margin-right:8px}
.dg-search{height:40px;border:1px solid var(--border);border-radius:12px;padding:0 12px;font-weight:800;min-width:260px;outline:none}
.dg-btn{height:40px;border:1px solid var(--border);background:var(--surface);border-radius:12px;padding:0 14px;font-weight:900;cursor:pointer;font-size:13px}
.dg-btn.primary{background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:#fff;border:0}
.dg-btn.green{background:#166534;color:#fff;border:0}
.dg-btn.red{background:#991b1b;color:#fff;border:0}
.dg-btn.blue{background:#0b5ed7;color:#fff;border:0}
.dg-btn:disabled{opacity:.4;cursor:not-allowed}
.dg-export-wrap{position:relative}
.dg-export-menu,.dg-row-menu{position:fixed;display:none;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);z-index:10000;padding:7px;min-width:210px}.dg-summary-menu{position:fixed;display:none;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);z-index:10000;padding:7px;min-width:210px}
.dg-export-menu.show,.dg-row-menu.show,.dg-summary-menu.show{display:block}
.dg-menu-title{padding:8px 10px 5px;color:var(--muted);font-size:11px;font-weight:900;text-transform:uppercase}
.dg-menu-item{padding:10px 12px;border-radius:9px;font-weight:900;cursor:pointer;display:flex;justify-content:space-between;font-size:13px}
.dg-menu-item:hover{background:var(--primary-soft);color:var(--primary-dark)}
.dg-danger{color:var(--red)}
.dg-table-wrap{overflow:auto;flex:1;min-height:0}
table.dg-table{width:100%;border-collapse:separate;border-spacing:0;min-width:600px;table-layout:auto}
table.dg-table th,table.dg-table td{padding:13px 16px;border-bottom:1px solid var(--border);white-space:nowrap;text-align:left;font-size:13px}
table.dg-table th{background:var(--soft);color:var(--muted);font-size:13px;position:sticky;top:0;z-index:3;font-weight:900;box-shadow:inset 0 -1px 0 var(--border)}
.dg-sort{cursor:pointer}
.dg-filter-btn{height:28px;width:28px;border:1px solid var(--border);border-radius:9px;background:var(--surface);cursor:pointer;margin-left:6px;font-size:12px}
.dg-filter-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
.dg-num{text-align:right;font-family:Consolas,monospace;font-weight:800}
.dg-badge{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:900}
.dg-good{background:var(--green-soft);color:var(--green)}
.dg-warn{background:var(--amber-soft);color:var(--amber)}
.dg-bad{background:var(--red-soft);color:var(--red)}
table.dg-table tr.active-row td{background:var(--primary-soft)!important}
table.dg-table tr.selected-row td{background:color-mix(in srgb,var(--orange) 12%,transparent)}
table.dg-table tfoot td{position:sticky;bottom:0;z-index:3;background:var(--soft)!important;font-weight:900;border-top:2px solid var(--primary);box-shadow:0 -2px 5px rgba(0,0,0,0.02)}
table.dg-table tfoot td.dg-num{text-align:right;font-family:Consolas,monospace}
table.dg-table tfoot td.dg-summary-cell{cursor:context-menu}
table.dg-table tfoot td.dg-summary-cell:hover{background:var(--primary-soft)!important}
.dg-summary-badge{display:block;color:var(--primary);font-size:10px;margin-top:3px;font-weight:900}
.dg-paging{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--border);z-index:9;box-shadow:0 -4px 12px rgba(0,0,0,0.02)}
.dg-page-size{height:38px;border:1px solid var(--border);border-radius:10px;padding:0 10px;font-size:13px}
.dg-pager{display:flex;gap:6px}
.dg-page-btn{height:36px;min-width:36px;border:1px solid var(--border);background:var(--surface);border-radius:10px;font-weight:900;cursor:pointer;font-size:13px}
.dg-page-btn.active{background:var(--primary);color:#fff;border:0}
.dg-page-btn:disabled{opacity:.4}
.dg-modal{position:fixed;inset:0;background:rgba(15,23,42,.45);display:none;align-items:center;justify-content:center;z-index:99999}
.dg-modal.show{display:flex}
.dg-modal-box{width:min(560px,calc(100vw - 28px));background:var(--surface);border-radius:22px;box-shadow:var(--shadow)}
.dg-modal-head{padding:18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.dg-modal-head h3{font-size:17px;font-weight:900}
.dg-modal-body{padding:18px}
.dg-col-list{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.dg-col-list label{padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--soft);font-weight:800;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px}
.dg-toast{position:fixed;bottom:18px;right:18px;background:#111827;color:#fff;padding:12px 16px;border-radius:14px;display:none;z-index:99999;font-weight:800;font-size:13px}
.dg-toast.show{display:block}
.dg-col-filter-popup{position:fixed;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);z-index:10001;padding:8px;min-width:240px;display:none}
.dg-col-filter-popup.show{display:block}
.dg-col-filter-popup .dg-cf-search{width:100%;height:32px;border:1px solid var(--border);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:6px;outline:none}
.dg-col-filter-opts{max-height:230px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:2px}
.dg-col-filter-opt{padding:5px 8px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
.dg-col-filter-opt:hover{background:var(--primary-soft)}
.dg-col-filter-opt.all{font-weight:800;border-bottom:1px solid var(--border);border-radius:0;margin-bottom:2px}
.dg-col-filter-opt input[type=checkbox]{appearance:auto;-webkit-appearance:checkbox;width:15px !important;height:15px !important;min-width:15px;min-height:15px;flex:0 0 15px;margin:0;padding:0;cursor:pointer;accent-color:var(--primary)}
.dg-col-filter-actions{display:flex;gap:6px;margin-top:8px}
.dg-col-filter-actions button{flex:1;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--soft);font-weight:800;font-size:12px;cursor:pointer;color:var(--text)}
.dg-col-filter-actions button.ok{background:var(--primary);color:#fff;border:0}
.dg-col-filter-actions button.link{flex:0 0 auto;background:none;border:0;color:var(--muted);font-weight:700}
.dg-th-inner{display:flex;align-items:center;position:relative}
.dg-resize-handle{position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:1;background:transparent}
.dg-resize-handle:hover{background:var(--primary)}
.dg-th-grip{cursor:grab;color:var(--muted);font-size:10px;letter-spacing:-1px;margin-right:5px;user-select:none;opacity:.45}
.dg-th-inner:hover .dg-th-grip{opacity:1}
.dg-th-grip:active{cursor:grabbing}
table.dg-table th.dg-drop-before{box-shadow:inset 3px 0 0 var(--primary)}
table.dg-table th.dg-drop-after{box-shadow:inset -3px 0 0 var(--primary)}
table.dg-table th.dg-dragging{opacity:.4}
.dg-drag-hint{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#111827;color:#fff;font-size:12px;font-weight:700;padding:8px 14px;border-radius:999px;z-index:100000;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none}
.dg-loader-wrap { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 30px; color: var(--muted); font-weight: 800; font-size: 14px; }
.dg-spinner { width: 24px; height: 24px; border: 3px solid var(--border); border-top: 3px solid var(--primary); border-radius: 50%; animation: dg-spin 0.8s linear infinite; }
@keyframes dg-spin { to { transform: rotate(360deg); } }
`;

function injectCSS() {
  let s = document.getElementById("dg-css");
  if (!s) {
    s = document.createElement("style");
    s.id = "dg-css";
    document.head.appendChild(s);
  }
  // keep the live stylesheet in sync with this bundle (HMR / new deploys)
  if (s.textContent !== CSS) s.textContent = CSS;
}

function fmtNum(v) {
  if (typeof v !== "number") return String(v ?? "");
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(".0", "") + "M";
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(1).replace(".0", "") + "K";
  return v.toLocaleString();
}

function calcSummary(rows, col, mode) {
  const vals = rows.map(r => r[col]).filter(v => typeof v === "number");
  if (!vals.length || !mode || mode === "none") return "";
  if (mode === "count") return vals.length;
  if (mode === "sum") return fmtNum(vals.reduce((a, b) => a + b, 0));
  if (mode === "avg") return fmtNum(vals.reduce((a, b) => a + b, 0) / vals.length);
  if (mode === "min") return fmtNum(Math.min(...vals));
  if (mode === "max") return fmtNum(Math.max(...vals));
  return "";
}

const PAGE_SIZES = [25, 50, 100, 500, 1000];

// One grid row. Memoised: it re-renders only when its row, its selection, the
// visible columns or the search change. Handlers and the cell renderer come
// through H (a ref holding DataGrid's latest closures), so it never acts stale.
const GridRow = memo(function GridRow({ row, i, visCols, isSelected, H, activateOnSingleClick }) {
  return (
                <tr
                  className={isSelected ? "selected-row" : ""}
                  onClick={e => {
                    H.current.select(i, e);
                    if (activateOnSingleClick && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
                        !e.target.closest('button, a, input, select, textarea, [role="button"]')) {
                      (H.current.onView || H.current.onEdit)?.(row);
                    }
                  }}
                  onDoubleClick={() => !activateOnSingleClick && (H.current.onView || H.current.onEdit)?.(row)}
                  onContextMenu={e => {
                    e.preventDefault();
                    // Right-clicking a row that is part of a multi-selection keeps
                    // the selection, so row actions can act on all selected rows
                    // (passed as their 2nd arg); otherwise select just this row.
                    const sel = H.current.selected;
                    const keep = sel.has(i) && sel.size > 1;
                    const menuRows = keep ? [...sel].sort((a, b) => a - b).map(x => H.current.pageRows[x]).filter(Boolean) : [row];
                    if (!keep) { H.current.selectOnly(i); }
                    H.current.setRowMenu({ x: e.clientX, y: e.clientY, row, rows: menuRows });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {visCols.map(col => (
                    <td key={col.key} className={col.numeric ? "dg-num" : ""}
                      style={col.align ? { textAlign: col.align } : undefined}>{H.current.renderCell(col, row, i)}</td>
                  ))}
                </tr>
  );
});

export default function DataGrid({
  title = "Data",
  subtitle = "",
  columns = [],
  rows = [],
  loading = false,
  onAdd,
  onEdit,
  onDelete,
  onView,
  activateOnSingleClick = false,
  onDuplicate,
  onPrint,
  onRefresh,
  onPreview,
  extraButtons = [],
  hideHeader = false,
  controlPanel = null,
  viewDropdown = null,
  onRowClick,
  selectedRowKey,
  hideSearch = false,
  hideRefresh = false,
  hideFooter = false,
  hidePaging = false,
  customActions = [],
  onColumnOrderChange,
}) {
  injectCSS();

  const [search, setSearch]         = useState("");
  const [sortCol, setSortCol]       = useState("");
  const [sortDir, setSortDir]       = useState("asc");
  const [pageIdx, setPageIdx]       = useState(1);
  const [pageSize, setPageSize]     = useState(500);
  const [selected, setSelected]     = useState(new Set());
  const [hidden, setHidden]         = useState(new Set());
  const [colWidths, setColWidths]     = useState({});
  const [summary, setSummary]       = useState({});
  const [colFilters, setColFilters] = useState({});
  const [rowMenu, setRowMenu]       = useState(null);
  const [exportMenu, setExportMenu] = useState(null);
  const [summaryMenuPos, setSummaryMenuPos] = useState(null);
  const [colFilterMenu, setColFilterMenu]   = useState(null);
  const [colFilterSearch, setColFilterSearch] = useState("");
  const [colModal, setColModal]     = useState(false);
  const [toast, setToast]           = useState("");
  const [colOrder, setColOrder]     = useState([]);     // live column order (keys)
  const [dragCol, setDragCol]       = useState(null);   // key being dragged
  const [dropCol, setDropCol]       = useState(null);   // { key, after }
  const colSigRef = useRef("");
  const dragColRef = useRef(null);       // key being dragged (survives state clears)
  const droppedOnColRef = useRef(false); // a header accepted the drop this drag
  const [headerMenu, setHeaderMenu] = useState(null);   // { x, y, col }
  const headerMenuRef = useRef();

  // refs — never stale inside event handlers
  const lastSelRef    = useRef(null);
  const resizeRef     = useRef(null);
  const anchorRef     = useRef(null);
  const summaryColRef = useRef("");
  const summaryRef    = useRef({});
  const rowMenuRef    = useRef();
  const exportMenuRef = useRef();
  const summaryMenuRef= useRef();
  const colFilterRef  = useRef();

  // keep summaryRef in sync with state
  useEffect(() => { summaryRef.current = summary; }, [summary]);

  useEffect(() => {
    const initialWidths = {};
    columns.forEach(col => {
      if (col.width) {
        initialWidths[col.key] = col.width;
      }
    });
    setColWidths(prev => ({ ...initialWidths, ...prev }));
  }, [columns]);

  useEffect(() => {
    function handler(e) {
      if (e.button === 2) return; // Ignore right-clicks to prevent race condition closing menus
      if (rowMenuRef.current     && !rowMenuRef.current.contains(e.target))     setRowMenu(null);
      if (exportMenuRef.current  && !exportMenuRef.current.contains(e.target))  setExportMenu(null);
      if (summaryMenuRef.current && !summaryMenuRef.current.contains(e.target)) setSummaryMenuPos(null);
      if (colFilterRef.current   && !colFilterRef.current.contains(e.target))   setColFilterMenu(null);
      if (headerMenuRef.current  && !headerMenuRef.current.contains(e.target))  setHeaderMenu(null);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useLayoutEffect(() => {
    if (colFilterMenu && colFilterRef.current) {
      const rect = colFilterRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      if (rect.right > viewportWidth) {
        // Dropdown extends offscreen! Reposition to align right edge inside the viewport.
        const newLeft = Math.max(10, viewportWidth - rect.width - 15);
        colFilterRef.current.style.left = `${newLeft}px`;
      }
    }
  }, [colFilterMenu]);

  function showToast(m) { setToast(m); setTimeout(() => setToast(""), 1600); }

  function startResize(e, col) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[col] || e.currentTarget.closest("th").offsetWidth;
    resizeRef.current = { col, startX, startW };
    function onMove(ev) {
      const diff = ev.clientX - resizeRef.current.startX;
      const newW = Math.max(60, resizeRef.current.startW + diff);
      setColWidths(p => ({ ...p, [resizeRef.current.col]: newW }));
    }
    function onUp() {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Live column order + visibility. colOrder resyncs (keeping the user's
  // arrangement of columns that still exist) whenever the column set changes,
  // e.g. switching Data View.
  useEffect(() => {
    const keys = columns.map(c => c.key);
    const sig = keys.join("");
    if (sig === colSigRef.current) return;
    colSigRef.current = sig;
    setColOrder(prev => {
      const kept = prev.filter(k => keys.includes(k));
      return [...kept, ...keys.filter(k => !kept.includes(k))];
    });
  }, [columns]);

  const colByKey = Object.fromEntries(columns.map(c => [c.key, c]));
  const orderedCols = (colOrder.length ? colOrder : columns.map(c => c.key))
    .map(k => colByKey[k]).filter(Boolean);
  // Performance (2026-10-17): the derived lists below are memoised, so a parent
  // re-render that doesn't touch this grid's data (opening a drawer, a toast,
  // typing in a form) no longer re-filters, re-sorts and re-renders every row --
  // with 500 rows/page that took seconds in dev mode before a drawer could paint.
  const visKey = orderedCols.filter(c => !hidden.has(c.key)).map(c => c.key).join("\u0001");
  const visCols = useMemo(() => orderedCols.filter(c => !hidden.has(c.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visKey, columns]);

  // fires onColumnOrderChange only for a genuine user drag / reset, not the
  // automatic resync above (e.g. switching Group By selection) -- that resync
  // also changes colOrder but reflects a fresh default, not a customization
  // to persist.
  const userReorderRef = useRef(false);
  useEffect(() => {
    if (!userReorderRef.current) return;
    userReorderRef.current = false;
    onColumnOrderChange?.(colOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colOrder]);

  function moveColumn(fromKey, toKey, after) {
    if (!fromKey || fromKey === toKey) return;
    userReorderRef.current = true;
    setColOrder(prev => {
      const arr = (prev.length ? prev : columns.map(c => c.key)).slice();
      const fi = arr.indexOf(fromKey);
      if (fi < 0) return prev;
      arr.splice(fi, 1);
      let ti = arr.indexOf(toKey);
      if (ti < 0) ti = arr.length - (after ? 0 : 1);
      arr.splice(ti + (after ? 1 : 0), 0, fromKey);
      return arr;
    });
  }
  function hideColumn(key) { setHidden(p => { const n = new Set(p); n.add(key); return n; }); }
  function resetLayout() {
    userReorderRef.current = true;
    setColOrder(columns.map(c => c.key));
    setHidden(new Set());
    setColWidths({});
  }

  const sorted = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = rows
      .filter(r => Object.entries(colFilters).every(([col, vals]) => !vals || vals.size === 0 || vals.has(String(r[col] ?? ""))))
      .filter(r => !q || visCols.some(c => String(r[c.key] ?? "").toLowerCase().includes(q)));
    if (!sortCol) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc"
        ? String(av ?? "").localeCompare(String(bv ?? ""))
        : String(bv ?? "").localeCompare(String(av ?? ""));
    });
  }, [rows, colFilters, visCols, search, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safeIdx    = Math.min(pageIdx, totalPages);
  const pageRows   = useMemo(() => sorted.slice((safeIdx - 1) * pageSize, safeIdx * pageSize), [sorted, safeIdx, pageSize]);

  useEffect(() => {
    const activeEl = document.activeElement;
    const isSearching = activeEl && (
      activeEl.tagName === "INPUT" && 
      (activeEl.className.includes("search") || activeEl.placeholder?.toLowerCase().includes("search"))
    );

    if (isSearching) {
      if (pageRows.length > 0) {
        setSelected(new Set([0]));
        lastSelRef.current = 0;
        anchorRef.current = 0;
        if (onRowClick) {
          onRowClick(pageRows[0]);
        }
      } else {
        setSelected(new Set());
        lastSelRef.current = null;
        if (onRowClick) {
          onRowClick(null);
        }
      }
    }
  }, [rows, search, pageRows.length, pageRows[0]]);

  // ── selection — uses ref so shift always works ──
  function select(i, e) {
    setSelected(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastSelRef.current !== null) {
        const lo = Math.min(lastSelRef.current, i);
        const hi = Math.max(lastSelRef.current, i);
        for (let x = lo; x <= hi; x++) next.add(x);
      } else if (e.ctrlKey || e.metaKey) {
        next.has(i) ? next.delete(i) : next.add(i);
        lastSelRef.current = i;
      } else {
        next.clear();
        next.add(i);
        lastSelRef.current = i;
        anchorRef.current = i;
      }
      return next;
    });
    if (onRowClick) {
      onRowClick(pageRows[i]);
    }
  }

  useEffect(() => {
    if (selectedRowKey === undefined || selectedRowKey === null || selectedRowKey === "") {
      setSelected(new Set());
      lastSelRef.current = null;
    }
  }, [selectedRowKey]);

  function handleKeyDown(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const cur = lastSelRef.current ?? 0;
      const n = e.key === "ArrowDown" ? Math.min(cur+1, pageRows.length-1) : Math.max(cur-1, 0);
      if (e.shiftKey) {
        if (anchorRef.current === null) anchorRef.current = cur;
        lastSelRef.current = n;
        const lo = Math.min(anchorRef.current, n);
        const hi = Math.max(anchorRef.current, n);
        const next = new Set();
        for (let x = lo; x <= hi; x++) next.add(x);
        setSelected(next);
      } else {
        anchorRef.current = n;
        lastSelRef.current = n;
        setSelected(new Set([n]));
      }
    }
    if (e.key === "Home")  { setSelected(new Set([0])); lastSelRef.current = 0; anchorRef.current = 0; }
    if (e.key === "End")   { const n = pageRows.length-1; setSelected(new Set([n])); lastSelRef.current = n; anchorRef.current = n; }
    if (e.key === "Enter" && lastSelRef.current !== null && onEdit) onEdit(pageRows[lastSelRef.current]);
  }

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
    setPageIdx(1);
  }

  function openColFilter(e, col) {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const colDef = visCols.find(c => c.key === col);
    const uniqueVals = [...new Set(rows.map(r => String(r[col] ?? "")))].sort();
    const current = colFilters[col] || new Set(uniqueVals);
    setColFilterMenu({
      x: r.left,
      y: r.bottom + 6,
      col,
      uniqueVals,
      tempSelected: new Set(current),
      originalSelected: new Set(current),
      render: colDef?.render
    });
    setColFilterSearch("");
  }

  // Filter applies live as checkboxes are toggled -- no separate "Apply" click
  // needed. tempSelected still tracks the popup's own display state; colFilters
  // (which actually drives the grid's row filtering) is updated in lockstep.
  function toggleColFilterVal(val) {
    setColFilterMenu(prev => {
      const s = new Set(prev.tempSelected);
      s.has(val) ? s.delete(val) : s.add(val);
      setColFilters(cf => ({ ...cf, [prev.col]: s }));
      return { ...prev, tempSelected: s };
    });
    setPageIdx(1);
  }

  function applyColFilter() {
    setColFilterMenu(null);
  }

  // the values currently shown in the popup (respecting the search box)
  function colFilterVisibleVals(menu) {
    if (!menu) return [];
    const q = colFilterSearch.toLowerCase();
    return menu.uniqueVals.filter(v => {
      const shown = menu.render ? String(menu.render(v) ?? "") : v;
      return shown.toLowerCase().includes(q);
    });
  }

  // Excel-style (Select All): check -> select every shown value; uncheck ->
  // deselect them. Tri-state (indeterminate) when only some are selected.
  function toggleColFilterSelectAll() {
    setColFilterMenu(prev => {
      if (!prev) return null;
      const vis = colFilterVisibleVals(prev);
      const allSel = vis.length > 0 && vis.every(v => prev.tempSelected.has(v));
      const s = new Set(prev.tempSelected);
      vis.forEach(v => (allSel ? s.delete(v) : s.add(v)));
      setColFilters(cf => ({ ...cf, [prev.col]: s }));
      return { ...prev, tempSelected: s };
    });
    setPageIdx(1);
  }

  function cancelColFilter() {
    if (colFilterMenu) {
      setColFilters(prev => ({ ...prev, [colFilterMenu.col]: colFilterMenu.originalSelected }));
    }
    setColFilterMenu(null);
  }

  const isColFiltered = col => {
    if (!colFilters[col]) return false;
    return colFilters[col].size < new Set(rows.map(r => String(r[col] ?? ""))).size;
  };

  // ── summary — fully ref-based like preview.html ──
  function openSummaryMenu(e, col) {
    e.preventDefault();
    e.stopPropagation();
    summaryColRef.current = col;
    const menuHeight = 280;
    const y = e.clientY + menuHeight > window.innerHeight
      ? e.clientY - menuHeight
      : e.clientY;
    setSummaryMenuPos({ x: e.clientX, y });
  }

  function applySummaryMode(mode) {
    const col = summaryColRef.current;
    setSummary(p => ({ ...p, [col]: mode }));
    setSummaryMenuPos(null);
  }

  function exportCSV() {
    const header = visCols.map(c => c.label).join(",");
    const body = sorted.map(r => visCols.map(c => `"${r[c.key] ?? ""}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([header + "\n" + body], { type: "text/csv" }));
    a.download = title + ".csv"; a.click();
    setExportMenu(null); showToast("Exported!");
  }

  function exportExcel() {
    if (!window.XLSX) { showToast("XLSX not loaded"); return; }
    const data = sorted.map(r => Object.fromEntries(visCols.map(c => [c.label, r[c.key]])));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(data), title);
    window.XLSX.writeFile(wb, title + ".xlsx");
    setExportMenu(null); showToast("Exported!");
  }

  function exportPDF() {
    if (!window.jspdf) { showToast("jsPDF not loaded"); return; }
    const doc = new window.jspdf.jsPDF({ orientation: "landscape" });
    doc.text(title, 14, 14);
    doc.autoTable({ head: [visCols.map(c => c.label)], body: sorted.map(r => visCols.map(c => String(r[c.key] ?? ""))), startY: 22 });
    doc.save(title + ".pdf");
    setExportMenu(null); showToast("Exported!");
  }

  const selRow  = selected.size === 1 ? pageRows[lastSelRef.current] : null;
  const selRows = [...selected].map(i => pageRows[i]).filter(Boolean);

  function getSearchTerm() {
    if (search && search.trim() !== "") return search.trim();
    const activeEl = document.activeElement;
    if (activeEl && activeEl.tagName === "INPUT" && 
        (activeEl.className.includes("search") || activeEl.placeholder?.toLowerCase().includes("search"))) {
      return activeEl.value.trim();
    }
    const searchInputs = document.querySelectorAll("input");
    for (const input of searchInputs) {
      if (input.className.includes("search") || input.placeholder?.toLowerCase().includes("search")) {
        if (input.value && input.value.trim() !== "") {
          return input.value.trim();
        }
      }
    }
    return "";
  }

  function highlightText(textVal, highlight) {
    if (!highlight) return textVal;
    const textStr = String(textVal ?? "");
    const regex = new RegExp(`(${escapeRegExp(highlight)})`, "gi");
    const parts = textStr.split(regex);
    return (
      <span>
        {parts.map((part, i) => 
          part.toLowerCase() === highlight.toLowerCase() ? (
            <mark key={i} style={{ backgroundColor: "var(--primary-soft)", color: "var(--primary-dark)", padding: "0 2px", borderRadius: "2px", fontWeight: "bold" }}>
              {part}
            </mark>
          ) : (
            part
          )
        )}
      </span>
    );
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function renderCell(col, row, rowIndex) {
    const term = getSearchTerm();
    let rendered;
    if (col.render) {
      rendered = col.render(row[col.key], row, rowIndex);
    } else if (col.numeric) {
      rendered = fmtNum(row[col.key]);
    } else {
      rendered = String(row[col.key] ?? "");
    }
    if (term && (typeof rendered === "string" || typeof rendered === "number")) {
      return highlightText(rendered, term);
    }
    return rendered;
  }

  // the table body: rebuilt only when what it shows changes; event handlers
  // read the latest callbacks through H, so a cached row never acts stale
  const H = useRef({});
  H.current = {
    select, onView, onEdit, selected, renderCell, openSummaryMenu, pageRows, setRowMenu,
    selectOnly: (i) => { lastSelRef.current = i; setSelected(new Set([i])); },
  };
  // footer summaries: one pass over the filtered rows per numeric column --
  // recomputed only when the rows, columns or chosen summaries change
  const footRow = useMemo(() => (
<tr>
                  {visCols.map((col, i) => {
                    const isNum = sorted.some(r => typeof r[col.key] === "number");
                    if (!isNum && i === 0) return <td key={col.key}>Summary</td>;
                    if (!isNum) return <td key={col.key}></td>;
                    const mode = summary[col.key] || "none";
                    const val  = calcSummary(sorted, col.key, mode);
                    return (
                      <td key={col.key}
                        className={`dg-summary-cell ${col.numeric ? "dg-num" : ""}`}
                        onContextMenu={e => H.current.openSummaryMenu(e, col.key)}>
                        {val && <span>{val}</span>}
                        <span className="dg-summary-badge">{mode !== "none" ? mode.toUpperCase() : "RIGHT CLICK"}</span>
                      </td>
                    );
                  })}
                </tr>
  ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visCols, sorted, summary]);

  // one memoised component per row: selecting a row re-renders only the rows
  // whose highlight changes, not all 500 (a double-click selects twice)
  const bodyRows = useMemo(() => (loading ? null : pageRows.map((row, i) => (
    <GridRow key={i} row={row} i={i} visCols={visCols} isSelected={selected.has(i)} H={H}
      search={search} activateOnSingleClick={activateOnSingleClick} />
  ))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, pageRows, visCols, selected, search, activateOnSingleClick]);


  return (
    <div tabIndex={0} onKeyDown={handleKeyDown} style={{ outline: "none", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, height: "100%" }}>


      <div className="dg-grid-panel">
        {!hideHeader && (
          <div className="dg-grid-title" style={{alignItems:"center",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
            <div style={{display:"flex",alignItems:"baseline",gap:8}}>
              <h3>{title} List</h3>
              <span className="dg-muted" style={{fontSize:12,fontWeight:800}}>{sorted.length} records</span>
              {selected.size > 0 && (
                <span style={{fontSize:12,fontWeight:900,color:"#2563eb",background:"#dbeafe",padding:"2px 8px",borderRadius:6}}>
                  {selected.size} selected
                </span>
              )}
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              {viewDropdown}
              {!hideSearch && (
                <input className="dg-search" placeholder="Search..."
                  value={search} onChange={e => { setSearch(e.target.value); setPageIdx(1); }}
                  onFocus={e => e.target.select()}
                  style={{height:32,minWidth:180,fontSize:12,borderRadius:8,padding:"0 10px"}} />
              )}
              {onRefresh && !hideRefresh && (
                <button className="dg-btn" style={{height:32,borderRadius:8,fontSize:12,padding:"0 10px",display:"inline-flex",alignItems:"center",gap:4}} onClick={onRefresh}>
                  ↻ Refresh
                </button>
              )}
              {onAdd && (
                <button className="dg-btn primary" style={{height:32,borderRadius:8,fontSize:12,padding:"0 10px",display:"inline-flex",alignItems:"center",gap:4}} onClick={onAdd}>
                  + New
                </button>
              )}
              {extraButtons.map((b,i) => (
                <button key={i} className={`dg-btn ${b.className||""}`}
                  style={{height:32,borderRadius:8,fontSize:12,padding:"0 10px"}}
                  onClick={b.onClick}>{b.label}</button>
              ))}
            </div>
          </div>
        )}

        {controlPanel && <div className="dg-control-panel-wrapper">{controlPanel}</div>}

        <div className="dg-table-wrap">
          <table className="dg-table">
            <thead>
              <tr>
                {visCols.map(col => {
                  const thCls = dragCol === col.key ? "dg-dragging"
                    : (dropCol && dropCol.key === col.key ? (dropCol.after ? "dg-drop-after" : "dg-drop-before") : "");
                  return (
                  <th key={col.key} className={thCls}
                    style={colWidths[col.key] ? {width: colWidths[col.key], minWidth: colWidths[col.key]} : {}}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setHeaderMenu({ x: e.clientX, y: e.clientY, col: col.key }); }}
                    onDragOver={e => {
                      if (!dragCol || dragCol === col.key) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDropCol({ key: col.key, after: e.clientX > r.left + r.width / 2 });
                    }}
                    onDragLeave={() => setDropCol(d => (d && d.key === col.key ? null : d))}
                    onDrop={e => {
                      e.preventDefault();
                      droppedOnColRef.current = true;
                      const src = dragColRef.current;
                      if (src) moveColumn(src, col.key, e.clientX > e.currentTarget.getBoundingClientRect().left + e.currentTarget.getBoundingClientRect().width / 2);
                      setDragCol(null); setDropCol(null);
                    }}>
                    <div className="dg-th-inner">
                      <span className="dg-th-grip" draggable
                        title="Drag onto another column to move it, or drop it outside the grid to hide it"
                        onDragStart={e => {
                          dragColRef.current = col.key;
                          droppedOnColRef.current = false;
                          setDragCol(col.key);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", col.key);
                        }}
                        onDragEnd={() => {
                          // no header accepted it -> the user dropped it outside the grid
                          if (!droppedOnColRef.current && dragColRef.current) hideColumn(dragColRef.current);
                          dragColRef.current = null;
                          setDragCol(null); setDropCol(null);
                        }}>::</span>
                      <span className="dg-sort" onClick={() => toggleSort(col.key)}>
                        {col.label}{sortCol === col.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </span>
                      <button className={`dg-filter-btn ${isColFiltered(col.key) ? "active" : ""}`}
                        onClick={e => openColFilter(e, col.key)}>⌄</button>
                      <div className="dg-resize-handle" onMouseDown={e => startResize(e, col.key)} />
                    </div>
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={visCols.length}>
                    <div className="dg-loader-wrap">
                      <div className="dg-spinner" />
                      <span>Loading data...</span>
                    </div>
                  </td>
                </tr>
              )}
              {!loading && pageRows.length === 0 && <tr><td colSpan={visCols.length} style={{ textAlign:"center", padding:30, color:"var(--muted)" }}>No records found</td></tr>}
              {bodyRows}
            </tbody>
            {!hideFooter && (
              <tfoot>
                {footRow}
              </tfoot>
            )}
          </table>
        </div>

        {!hidePaging && (
          <div className="dg-paging">
            <div>Show{" "}
              <select className="dg-page-size" value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setPageIdx(1); }}>
                {PAGE_SIZES.map(s => <option key={s}>{s}</option>)}
              </select>{" "}entries
            </div>
            <div className="dg-muted">
              Showing {sorted.length ? (safeIdx-1)*pageSize+1 : 0}–{Math.min(safeIdx*pageSize, sorted.length)} of {sorted.length} entries
            </div>
            <div className="dg-pager">
              <button className="dg-page-btn" disabled={safeIdx===1} onClick={() => setPageIdx(p=>p-1)}>‹</button>
              {[...Array(Math.min(totalPages,10))].map((_,i) => (
                <button key={i} className={`dg-page-btn ${i+1===safeIdx?"active":""}`} onClick={() => setPageIdx(i+1)}>{i+1}</button>
              ))}
              {totalPages > 10 && <span style={{padding:"0 6px",color:"var(--muted)"}}>…{totalPages}</span>}
              <button className="dg-page-btn" disabled={safeIdx===totalPages} onClick={() => setPageIdx(p=>p+1)}>›</button>
            </div>
          </div>
        )}
      </div>

      {/* Row Menu */}
      {rowMenu && createPortal(
        <div ref={rowMenuRef} className="dg-row-menu show"
          style={{ left: `${rowMenu.x}px`, top: `${rowMenu.y}px` }}>
          <div className="dg-menu-title">Record Actions</div>
          {customActions && customActions.map((act, idx) => {
            const menuRows = rowMenu.rows || [rowMenu.row];
            if (act.show && !act.show(rowMenu.row, menuRows)) return null;
            if (act.divider) {
              return <div key={idx} style={{ height: '1.5px', background: 'var(--border)', margin: '6px 0' }} />;
            }
            return (
              <div key={idx} className={`dg-menu-item ${act.className||""}`} onClick={() => { act.onClick(rowMenu.row, menuRows); setRowMenu(null); }}>
                {typeof act.label === 'function' ? act.label(rowMenu.row, menuRows) : act.label}
              </div>
            );
          })}
          {onPreview && (!rowMenu.row.PageType || rowMenu.row.PageType === "grid") && (
            <div className="dg-menu-item" onClick={() => { onPreview(rowMenu.row); setRowMenu(null); }}>🚀 Run Live</div>
          )}
          {onView      && <div className="dg-menu-item" onClick={() => { onView(rowMenu.row); setRowMenu(null); }}>🔍 View</div>}
          {onEdit      && <div className="dg-menu-item" onClick={() => { onEdit(rowMenu.row); setRowMenu(null); }}>✏ Edit</div>}
          {onDuplicate && <div className="dg-menu-item" onClick={() => { onDuplicate(rowMenu.row); setRowMenu(null); }}>📄 Duplicate</div>}
          {onPrint     && <div className="dg-menu-item" onClick={() => { onPrint(rowMenu.row); setRowMenu(null); }}>🖨️ Print</div>}
          {onDelete    && <div className="dg-menu-item dg-danger" onClick={() => { onDelete([rowMenu.row]); setRowMenu(null); }}>🗑 Delete</div>}
          <div className="dg-menu-title">Export Data</div>
          <div className="dg-menu-item" onClick={() => { exportExcel(); setRowMenu(null); }}>📗 Excel</div>
          <div className="dg-menu-item" onClick={() => { exportPDF(); setRowMenu(null); }}>📕 PDF</div>
          <div className="dg-menu-item" onClick={() => { exportCSV(); setRowMenu(null); }}>📄 CSV</div>
        </div>,
        document.body
      )}

      {/* Summary Menu — col stored in ref, never stale */}
      {summaryMenuPos && createPortal(
        <div ref={summaryMenuRef} className="dg-summary-menu show"
          style={{ left: `${summaryMenuPos.x}px`, top: `${summaryMenuPos.y}px` }}>
          <div className="dg-menu-title">Summary: {summaryColRef.current}</div>
          {["none","sum","avg","min","max","count"].map(mode => (
            <div key={mode} className="dg-menu-item" onClick={() => applySummaryMode(mode)}>
              {mode.charAt(0).toUpperCase()+mode.slice(1)}
              <span>{(summary[summaryColRef.current]||"none")===mode?"✓":""}</span>
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* Col Filter -- Excel-style value picker */}
      {colFilterMenu && createPortal((() => {
        const visVals = colFilterVisibleVals(colFilterMenu);
        const selCount = visVals.reduce((n, v) => n + (colFilterMenu.tempSelected.has(v) ? 1 : 0), 0);
        const allSel = visVals.length > 0 && selCount === visVals.length;
        const noneSel = selCount === 0;
        return (
          <div ref={colFilterRef} className="dg-col-filter-popup show"
            style={{ left: `${colFilterMenu.x}px`, top: `${colFilterMenu.y}px` }}>
            <input className="dg-cf-search" placeholder="Search…" value={colFilterSearch} autoFocus
              onChange={e => setColFilterSearch(e.target.value)} />

            <div className="dg-col-filter-opts">
              <label className="dg-col-filter-opt all">
                <input type="checkbox" checked={allSel}
                  style={{ width: 15, height: 15, flex: '0 0 15px' }}
                  ref={el => { if (el) el.indeterminate = !allSel && !noneSel; }}
                  onChange={toggleColFilterSelectAll} />
                (Select All){colFilterSearch ? ' — search results' : ''}
              </label>
              {visVals.length === 0 && (
                <div className="dg-col-filter-opt" style={{ color: 'var(--muted)', cursor: 'default' }}>No matches</div>
              )}
              {visVals.map(val => {
                const displayVal = colFilterMenu.render ? colFilterMenu.render(val) : val;
                return (
                  <label key={val} className="dg-col-filter-opt" title={String(displayVal ?? '')}>
                    <input type="checkbox" checked={colFilterMenu.tempSelected.has(val)}
                      style={{ width: 15, height: 15, flex: '0 0 15px' }}
                      onChange={() => toggleColFilterVal(val)} />
                    {displayVal === '' || displayVal == null ? '(Blanks)' : displayVal}
                  </label>
                );
              })}
            </div>

            <div className="dg-col-filter-actions">
              <button className="link" onClick={() => { setColFilters(p => { const n = { ...p }; delete n[colFilterMenu.col]; return n; }); setColFilterMenu(null); }}>Clear filter</button>
              <button onClick={cancelColFilter}>Cancel</button>
              <button className="ok" onClick={applyColFilter}>OK</button>
            </div>
          </div>
        );
      })(), document.body)}

      {/* Columns Modal */}
      <div className={`dg-modal ${colModal?"show":""}`}>
        <div className="dg-modal-box">
          <div className="dg-modal-head">
            <h3>Columns</h3>
            <button className="dg-btn" onClick={() => setColModal(false)}>✕</button>
          </div>
          <div className="dg-modal-body">
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 10px" }}>
              Tick to show a column. On the grid, drag a header's :: grip onto another column to move it, or drop it outside the grid to hide it.
            </p>
            <div className="dg-col-list">
              {orderedCols.map(col => (
                <label key={col.key}>
                  <input type="checkbox" checked={!hidden.has(col.key)}
                    onChange={() => setHidden(p => { const n=new Set(p); n.has(col.key)?n.delete(col.key):n.add(col.key); return n; })} />
                  {col.label}
                </label>
              ))}
            </div>
            <br/>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="dg-btn" onClick={resetLayout}>Reset layout</button>
              <button className="dg-btn primary" onClick={() => setColModal(false)}>Apply</button>
            </div>
          </div>
        </div>
      </div>

      {dragCol && (
        <div className="dg-drag-hint">Drop on another column to move &nbsp;·&nbsp; drop outside the grid to hide</div>
      )}

      {headerMenu && createPortal((() => {
        const c = columns.find(x => x.key === headerMenu.col);
        const close = () => setHeaderMenu(null);
        return (
          <div ref={headerMenuRef} className="dg-row-menu show"
            style={{ left: `${headerMenu.x}px`, top: `${headerMenu.y}px` }}>
            <div className="dg-menu-title">{c?.label || "Column"}</div>
            <div className="dg-menu-item" onClick={() => { setSortCol(headerMenu.col); setSortDir("asc"); setPageIdx(1); close(); }}>Sort ascending</div>
            <div className="dg-menu-item" onClick={() => { setSortCol(headerMenu.col); setSortDir("desc"); setPageIdx(1); close(); }}>Sort descending</div>
            {sortCol === headerMenu.col && (
              <div className="dg-menu-item" onClick={() => { setSortCol(""); close(); }}>Clear sort</div>
            )}
            <div className="dg-menu-title">Filter</div>
            <div className="dg-menu-item" onClick={() => {
              const at = { x: headerMenu.x, y: headerMenu.y };
              close();
              openColFilter({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: at.x, bottom: at.y }) } }, headerMenu.col);
            }}>Filter this column</div>
            {isColFiltered(headerMenu.col) && (
              <div className="dg-menu-item" onClick={() => { setColFilters(p => { const n = { ...p }; delete n[headerMenu.col]; return n; }); close(); }}>Clear this filter</div>
            )}
            <div className="dg-menu-title">Columns</div>
            <div className="dg-menu-item" onClick={() => { hideColumn(headerMenu.col); close(); }}>Hide this column</div>
            <div className="dg-menu-item" onClick={() => { setColModal(true); close(); }}>Show / arrange columns...</div>
            <div className="dg-menu-item" onClick={() => { resetLayout(); close(); }}>Reset layout</div>
          </div>
        );
      })(), document.body)}
      <div className={`dg-toast ${toast?"show":""}`}>{toast}</div>
    </div>
  );
}
