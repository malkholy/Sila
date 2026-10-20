import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';
import { DATE_TOKENS } from '../../shared/DynamicFilterBar.jsx';

// Ported from PlusPro's PageMaster.jsx -- tree + form only (no AI PageBuilder,
// no side drawer). Manages rows in PLS.PagesAndGroups: the sidebar nav tree.
//
// Backend operations used (via Pls.APIPlusOperationV1):
//   GetPagesAndGroups   -> List0 of { PageGroupID, Label, Icon, Description, IsGroup, ParentID, SortOrder }
//   SavePageOrGroup     -> upsert one row
//   DeletePageOrGroup   -> delete one row by PageGroupID

const EMPTY_FORM = {
  PageGroupID: null,   // INT IDENTITY -- assigned by the DB on insert
  Label: '',
  Icon: '',
  Description: '',
  IsGroup: false,
  ParentGroupID: '',
  SortOrder: 99,
  RequireGroupBy: false
};

const inputStyle = {
  width: '100%', height: 38, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none'
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase'
};

export default function GroupPageMaster() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [searchQuery, setSearchQuery] = useState('');
  const [tab, setTab] = useState('info');   // 'info' | 'query' -- pages only
  const [collapsed, setCollapsed] = useState(() => new Set());   // group ids collapsed in the tree

  useEffect(() => { loadData(); }, []);

  // default: every group starts collapsed
  useEffect(() => {
    setCollapsed(new Set(items.filter(i => i.IsGroup).map(i => i.PageGroupID)));
  }, [items]);

  function toggleCollapse(groupId) {
    setCollapsed(prev => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  }

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiCall('GetPagesAndGroups', {}, {}, 'plus');
      if (res.State === 0) {
        setItems((res.List0 || []).filter(i => i.SortOrder !== 999));
      } else {
        setError(res.Message || 'Failed to load pages and groups');
      }
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  const groups = useMemo(() => items.filter(i => i.IsGroup), [items]);

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(i =>
      (i.Label || '').toLowerCase().includes(q) ||
      String(i.PageGroupID ?? '').includes(q)
    );
  }, [items, searchQuery]);

  const treeRows = useMemo(() => {
    const rows = [];
    const topGroups = filteredItems.filter(i => i.IsGroup).sort((a, b) => a.SortOrder - b.SortOrder);
    const orphanPages = filteredItems
      .filter(i => !i.IsGroup && !i.ParentID)
      .sort((a, b) => a.SortOrder - b.SortOrder);

    topGroups.forEach(g => {
      const children = filteredItems
        .filter(i => i.ParentID === g.PageGroupID)
        .sort((a, b) => a.SortOrder - b.SortOrder);
      rows.push({ ...g, depth: 0, childCount: children.length });
      children.forEach(child => rows.push({ ...child, depth: 1 }));
    });
    orphanPages.forEach(p => rows.push({ ...p, depth: 0 }));
    return rows;
  }, [filteredItems]);

  const groupLabelById = useMemo(() => {
    const map = {};
    groups.forEach(g => { map[g.PageGroupID] = g.Label; });
    return map;
  }, [groups]);

  function handleSelect(item) {
    setSelected(item);
    setIsNew(false);
    setTab('info');
    setSuccessMsg(null);
    setError(null);
    setFormData({
      PageGroupID: item.PageGroupID,
      Label: item.Label,
      Icon: item.Icon || '',
      Description: item.Description || '',
      IsGroup: !!item.IsGroup,
      ParentGroupID: item.ParentID || '',
      SortOrder: item.SortOrder ?? 99,
      RequireGroupBy: !!item.RequireGroupBy
    });
  }

  function handleNew(asGroup) {
    setSelected(null);
    setIsNew(true);
    setTab('info');
    setSuccessMsg(null);
    setError(null);
    setFormData({ ...EMPTY_FORM, IsGroup: asGroup });
  }

  function resetForm() {
    setSelected(null);
    setIsNew(false);
    setFormData(EMPTY_FORM);
    setError(null);
    setSuccessMsg(null);
  }

  async function handleSave() {
    if (!formData.Label.trim()) {
      setError('Label is a required field.');
      return;
    }
    if (!formData.IsGroup && !formData.ParentGroupID) {
      setError('A page must belong to a parent group.');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('SavePageOrGroup', {
        PageGroupID: isNew ? null : formData.PageGroupID,
        ParentGroupID: formData.IsGroup ? null : Number(formData.ParentGroupID),
        SortOrder: formData.SortOrder,
        Label: formData.Label.trim(),
        Icon: formData.Icon.trim(),
        Description: formData.Description.trim(),
        IsGroup: formData.IsGroup ? 1 : 0,
        RequireGroupBy: formData.IsGroup ? 0 : (formData.RequireGroupBy ? 1 : 0)
      }, {}, 'plus');

      if (res.State === 0) {
        setSuccessMsg('✓ Saved successfully!');
        setIsNew(false);
        await loadData();
        if (!isNew) setSelected({ ...formData, ParentID: formData.ParentGroupID });
        else resetForm();
      } else {
        setError(res.Message || 'Failed to save');
      }
    } catch (err) {
      setError('Save connection error: ' + err.message);
    }
    setSaving(false);
  }

  async function deleteItem(item) {
    if (!item) return;
    if (items.some(i => i.ParentID === item.PageGroupID)) {
      setError('Cannot delete this group while it still has pages inside it. Move or delete its pages first.');
      return;
    }
    if (!window.confirm(`Delete "${item.Label}"? This also removes related permissions and query bindings.`)) return;

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('DeletePageOrGroup', { PageGroupID: item.PageGroupID }, {}, 'plus');
      if (res.State === 0) {
        setSuccessMsg('✓ Deleted successfully.');
        resetForm();
        await loadData();
      } else {
        setError(res.Message || 'Failed to delete');
      }
    } catch (err) {
      setError('Delete connection error: ' + err.message);
    }
    setSaving(false);
  }

  const showForm = isNew || !!selected;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Group &amp; Page Master</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Manage sidebar navigation groups and pages registered in the system.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => handleNew(true)} style={{
            height: 34, padding: '0 16px', background: 'var(--soft)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
          }}>+ New Group</button>
          <button onClick={() => handleNew(false)} style={{
            height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
            color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
          }}>+ New Page</button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* Tree list */}
        <div style={{
          width: 380, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0
        }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input
              type="text"
              placeholder="Search pages / groups..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ ...inputStyle, height: 36 }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading pages...</div>
            ) : treeRows.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No pages or groups found.</div>
            ) : (
              treeRows
                .filter(item => searchQuery.trim() || !(item.depth > 0 && collapsed.has(item.ParentID)))
                .map(item => {
                const isSelected = selected?.PageGroupID === item.PageGroupID;
                const isCollapsed = collapsed.has(item.PageGroupID);
                return (
                  <div
                    key={item.PageGroupID}
                    onClick={() => handleSelect(item)}
                    style={{
                      padding: '10px 14px', marginLeft: item.depth * 18, borderRadius: 10, cursor: 'pointer',
                      background: isSelected
                        ? 'var(--orange-soft)'
                        : item.IsGroup ? 'var(--soft)' : 'transparent',
                      border: '1px solid ' + (isSelected ? 'var(--orange)' : 'transparent'),
                      borderLeftWidth: 3,
                      borderLeftColor: isSelected ? 'var(--orange)' : item.IsGroup ? 'var(--orange)' : 'var(--border)',
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontSize: item.IsGroup ? 12.5 : 12, fontWeight: item.IsGroup ? 800 : 600,
                        color: item.IsGroup ? 'var(--text)' : 'var(--muted-strong, var(--text))',
                        textTransform: item.IsGroup ? 'uppercase' : 'none',
                        letterSpacing: item.IsGroup ? 0.3 : 0,
                      }}>
                        {item.IsGroup ? (
                          <span
                            onClick={e => { e.stopPropagation(); toggleCollapse(item.PageGroupID); }}
                            style={{ fontSize: 9, color: 'var(--muted)', width: 12, display: 'inline-block' }}
                          >{isCollapsed ? '▶' : '▼'}</span>
                        ) : (
                          <span style={{ color: 'var(--border)', width: 12, display: 'inline-block', textAlign: 'center' }}>·</span>
                        )}
                        {item.Icon || (item.IsGroup ? '📁' : '📄')} {item.Label}
                      </span>
                      {item.IsGroup && (
                        <span style={{
                          fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--orange)',
                          background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4
                        }}>Group{item.childCount ? ` · ${item.childCount}` : ''}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>
                      {item.PageGroupID} • sort {item.SortOrder}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Form */}
        <div style={{
          flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
          display: 'flex', flexDirection: 'column', minHeight: 0
        }}>
          {!showForm ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Select a page or group from the list, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? (formData.IsGroup ? 'Create New Group' : 'Create New Page') : `Editing: ${formData.PageGroupID}`}
                </h3>
                {!isNew && (
                  <button onClick={() => deleteItem(selected)} disabled={saving}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                    ✕ Delete
                  </button>
                )}
              </div>

              {!isNew && selected && !selected.IsGroup && (
                <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
                  {[['info', 'Info'], ['query', 'Query'], ['filters', 'Filters'], ['formfilters', 'Form Filter'], ['operations', 'Operations'], ['groupby', 'Group By'], ['kpis', 'KPIs'], ['notifications', 'Notifications'], ['reports', 'Reports']].map(([key, label]) => {
                    const active = tab === key;
                    return (
                      <button key={key} onClick={() => setTab(key)} style={{
                        appearance: 'none', background: 'none', border: 'none',
                        padding: '12px 10px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                        color: active ? 'var(--orange)' : 'var(--muted)',
                        borderBottom: '2px solid ' + (active ? 'var(--orange)' : 'transparent'),
                        marginBottom: -1,
                      }}>{label}</button>
                    );
                  })}
                </div>
              )}

              {tab === 'query' && !isNew && selected && !selected.IsGroup ? (
                <PageQueryTab pageGroupId={selected.PageGroupID} />
              ) : tab === 'operations' && !isNew && selected && !selected.IsGroup ? (
                <PageOperationsTab pageGroupId={selected.PageGroupID} />
              ) : tab === 'groupby' && !isNew && selected && !selected.IsGroup ? (
                <PageGroupByTab pageGroupId={selected.PageGroupID} />
              ) : tab === 'filters' && !isNew && selected && !selected.IsGroup ? (
                <PageFiltersTab key="grid" pageGroupId={selected.PageGroupID} mode="grid" />
              ) : tab === 'formfilters' && !isNew && selected && !selected.IsGroup ? (
                <PageFiltersTab key="form" pageGroupId={selected.PageGroupID} mode="form" />
              ) : tab === 'kpis' && !isNew && selected && !selected.IsGroup ? (
                <PageKPIsTab pageGroupId={selected.PageGroupID} />
              ) : tab === 'notifications' && !isNew && selected && !selected.IsGroup ? (
                <PageNotificationsTab pageGroupId={selected.PageGroupID} />
              ) : tab === 'reports' && !isNew && selected && !selected.IsGroup ? (
                <PageReportsTab pageGroupId={selected.PageGroupID} />
              ) : (
              <>
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && (
                  <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>
                )}
                {successMsg && (
                  <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Page/Group ID</label>
                    <input
                      type="text"
                      value={isNew ? '(auto)' : formData.PageGroupID}
                      disabled
                      style={{ ...inputStyle, background: 'var(--soft)', fontFamily: 'monospace' }}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select
                      value={formData.IsGroup ? 'group' : 'page'}
                      disabled={!isNew}
                      onChange={e => setFormData({ ...formData, IsGroup: e.target.value === 'group' })}
                      style={{ ...inputStyle, background: isNew ? 'var(--bg)' : 'var(--soft)' }}
                    >
                      <option value="page">Page</option>
                      <option value="group">Group</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Label</label>
                    <input type="text" value={formData.Label}
                      onChange={e => setFormData({ ...formData, Label: e.target.value })}
                      placeholder="e.g. Item Master" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Icon (emoji)</label>
                    <input type="text" value={formData.Icon}
                      onChange={e => setFormData({ ...formData, Icon: e.target.value })}
                      placeholder="🏷️" style={{ ...inputStyle, fontSize: 14 }} />
                  </div>
                  {!formData.IsGroup && (
                    <div>
                      <label style={labelStyle}>Parent Group</label>
                      <select value={formData.ParentGroupID}
                        onChange={e => setFormData({ ...formData, ParentGroupID: e.target.value })}
                        style={inputStyle}>
                        <option value="">(Select Group)</option>
                        {groups.map(g => (
                          <option key={g.PageGroupID} value={g.PageGroupID}>{g.Label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div>
                    <label style={labelStyle}>Sort Order</label>
                    <input type="number" value={formData.SortOrder}
                      onChange={e => setFormData({ ...formData, SortOrder: parseInt(e.target.value, 10) || 0 })}
                      style={inputStyle} />
                  </div>
                  {!formData.IsGroup && (
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer', height: 38 }}>
                        <input type="checkbox" checked={formData.RequireGroupBy}
                          onChange={e => setFormData({ ...formData, RequireGroupBy: e.target.checked })} />
                        Require a Group By
                      </label>
                    </div>
                  )}
                </div>
                {!formData.IsGroup && formData.RequireGroupBy && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: -8, marginBottom: 16 }}>
                    The grid can never show fully ungrouped rows — at least one active Group By config
                    (Group By tab) must stay checked. Mark one "Default" there to pre-select it on load.
                  </p>
                )}

                <div>
                  <label style={labelStyle}>Description</label>
                  <textarea value={formData.Description}
                    onChange={e => setFormData({ ...formData, Description: e.target.value })}
                    placeholder="Optional page purpose description..."
                    style={{ ...inputStyle, height: 60, padding: '10px 12px', resize: 'none' }} />
                </div>
                {formData.ParentGroupID && groupLabelById[formData.ParentGroupID] && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                    Parent: {groupLabelById[formData.ParentGroupID]}
                  </p>
                )}
              </div>

              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button onClick={resetForm} disabled={saving} style={{
                  height: 36, padding: '0 16px', background: 'var(--soft)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
                }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{
                  height: 36, padding: '0 24px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
                  color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
                }}>{saving ? 'Saving...' : 'Save'}</button>
              </div>
              </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Query tab -- read-only view of the query(ies) linked to this page
// (V1QueryMaster / V1PageQueries).
// ---------------------------------------------------------------------------
function PageQueryTab({ pageGroupId }) {
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const res = await apiCall('GetQueryMaster', {}, {}, 'plus');
        if (!cancelled) {
          if (res.State === 0) setQueries((res.List0 || []).filter(q => q.PageGroupID === pageGroupId));
          else setErr(res.Message || 'Failed to load queries');
        }
      } catch (e) {
        if (!cancelled) setErr('Connection error: ' + e.message);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [pageGroupId]);

  const preStyle = {
    margin: '4px 0 0', padding: '8px 10px', background: 'var(--soft)',
    border: '1px solid var(--border)', borderRadius: 6, fontSize: 11,
    fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'pre-wrap',
    wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto',
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{err}</div>}

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      ) : queries.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          No query linked to this page. Link one in Query Master.
        </div>
      ) : queries.map(q => (
        <div key={q.QueryID} style={{ marginBottom: 20, border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{q.QueryName}</span>
            <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4 }}>{q.QueryType}</span>
            <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>#{q.QueryID}</span>
          </div>
          {q.Description && <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 8px' }}>{q.Description}</p>}
          <label style={labelStyle}>Query SQL</label>
          <pre style={preStyle}>{q.QuerySQL || '—'}</pre>
          {q.QueryFilter && (<><label style={{ ...labelStyle, marginTop: 10 }}>Query Filter</label><pre style={preStyle}>{q.QueryFilter}</pre></>)}
          {q.QueryOrderBy && (<><label style={{ ...labelStyle, marginTop: 10 }}>Query OrderBy</label><pre style={preStyle}>{q.QueryOrderBy}</pre></>)}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters tab -- editable grid of the Filter Links for THIS page
// (V1QueryFilterLink, scoped to PageGroupID + the page's Base query).
// ---------------------------------------------------------------------------
const QFL_FILTER_TYPES = [
  ['LIST', 'List / multi-select (IN)'],
  ['EQUALS', 'Text = '],
  ['LIKE', 'Text LIKE'],
  ['MIN', 'From (>=)'],
  ['RANGE', 'Range (From - To)'],
  ['DATE_RANGE', 'Date range (From - To)'],
];
const qflBlank = (queryId, pageGroupId, mode) => ({
  LinkID: null, QueryID: queryId, PageGroupID: pageGroupId, QueryFilterID: '',
  FilterType: 'LIST', QueryField: '', FilterField: '', UsePanel: mode !== 'form',
  FixedFrom: '', FixedTo: '', LabelOverride: '', SortOrder: '',
});

// A "form filter" link feeds a form/page lookup (GetFilterOptions -> LookupSelect):
// UsePanel = 0 with no fixed value. Anything else is a grid filter (panel widget
// or an always-applied fixed rule).
const linkIsForm = (r) =>
  !(r.UsePanel === 1 || r.UsePanel === true)
  && !String(r.FixedFrom ?? '').trim() && !String(r.FixedTo ?? '').trim();

// mode: 'grid' (Filters tab -- panel + fixed grid rules) | 'form' (Form Filter tab)
function PageFiltersTab({ pageGroupId, mode = 'grid' }) {
  const [queryId, setQueryId] = useState(null);
  const [queryName, setQueryName] = useState('');
  const [queryFields, setQueryFields] = useState([]);
  const [filters, setFilters] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [qm, qf] = await Promise.all([
        apiCall('GetQueryMaster', {}, {}, 'plus'),
        apiCall('GetQueryFilter', {}, {}, 'plus'),
      ]);
      if (qf.State === 0) setFilters(qf.List0 || []);
      const q = (qm.List0 || []).find(r => String(r.PageGroupID) === String(pageGroupId));
      if (!q?.QueryID) { setQueryId(null); setRows([]); setLoading(false); return; }
      setQueryId(q.QueryID); setQueryName(q.QueryName || '');
      const [links, flds] = await Promise.all([
        apiCall('GetQueryFilterLinks', { PageGroupID: pageGroupId }, {}, 'plus'),
        apiCall('GetQueryFields', { QueryID: q.QueryID }, {}, 'plus'),
      ]);
      if (flds.State === 0) setQueryFields((flds.List0 || []).map(f => f.FieldName).filter(Boolean));
      if (links.State === 0) setRows((links.List0 || [])
        .map(r => ({
          ...r,
          QueryFilterID: r.QueryFilterID ?? '',
          QueryField: r.QueryField ?? '', FilterField: r.FilterField ?? '',
          UsePanel: r.UsePanel === 1 || r.UsePanel === true,
          FixedFrom: r.FixedFrom ?? '', FixedTo: r.FixedTo ?? '',
          LabelOverride: r.LabelOverride ?? '', SortOrder: r.SortOrder ?? '',
        }))
        .filter(r => (mode === 'form' ? linkIsForm(r) : !linkIsForm(r))));
      else setErr(links.Message || 'Failed to load filter links');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }
  useEffect(() => { if (pageGroupId != null) load(); /* eslint-disable-next-line */ }, [pageGroupId]);

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, qflBlank(queryId, pageGroupId, mode)]);

  async function saveRow(i) {
    const r = rows[i];
    const isDate = r.FilterType === 'DATE_RANGE';
    if (!r.QueryField.trim()) { setErr('Pick a Query Field.'); return; }
    if (!isDate && (!r.QueryFilterID || !r.FilterField.trim())) {
      setErr('Pick a Filter and its Filter Field.'); return;
    }
    setBusy(i); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SaveQueryFilterLink', {
        LinkID: r.LinkID, QueryID: queryId, PageGroupID: pageGroupId,
        QueryFilterID: isDate ? null : Number(r.QueryFilterID), FilterType: r.FilterType,
        QueryField: r.QueryField.trim(), FilterField: isDate ? null : r.FilterField.trim(),
        UsePanel: mode === 'form' ? 0 : (r.UsePanel ? 1 : 0),
        FixedFrom: mode === 'form' ? null : (r.FixedFrom.trim() || null),
        FixedTo: mode === 'form' ? null : (r.FixedTo.trim() || null),
        LabelOverride: r.LabelOverride.trim() || null,
        SortOrder: r.SortOrder === '' ? null : Number(r.SortOrder),
      }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Saved'); await load(); }
      else setErr(res.Message || 'Failed to save');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  async function deleteRow(i) {
    const r = rows[i];
    if (r.LinkID == null) { setRows(rs => rs.filter((_, j) => j !== i)); return; }
    if (!window.confirm('Remove this filter link?')) return;
    setBusy(i); setErr(null);
    try {
      const res = await apiCall('DeleteQueryFilterLink', { LinkID: r.LinkID }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Removed'); await load(); }
      else setErr(res.Message || 'Failed to remove');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  const cell = {
    width: '100%', height: 30, padding: '0 8px', border: '1.5px solid var(--border)',
    borderRadius: 6, fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
  };
  const th = { fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '0 6px 8px', whiteSpace: 'nowrap' };
  const tdc = { padding: '4px 6px', borderTop: '1px solid var(--border)', verticalAlign: 'top' };

  if (loading) return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (queryId == null) return (
    <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
      No Base query linked to this page. Link one in Query Master first.
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{msg}</div>}
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        {mode === 'form'
          ? <>Form / page lookups for this page (served by <code>GetFilterOptions</code> to a <code>LookupSelect</code>). Base query: <strong>{queryName}</strong> (#{queryId}).</>
          : <>Grid filter links — panel widgets and always-applied fixed rules. Base query: <strong>{queryName}</strong> (#{queryId}).</>}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: mode === 'form' ? 720 : 1050 }}>
          <thead>
            <tr>
              {(mode === 'form'
                ? ['Lookup', 'Field name', 'Value Field', 'Label', 'Sort', '']
                : ['Type', 'Filter', 'Query Field', 'Filter Field', 'Panel', 'Fixed / Default From', 'Fixed / Default To', 'Label', 'Sort', '']
              ).map(h => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                {mode === 'form' ? 'No form lookups linked to this page.' : 'No grid filters linked to this page.'}
              </td></tr>
            )}
            {rows.map((r, i) => {
              const qf = filters.find(f => String(f.QueryFilterID) === String(r.QueryFilterID));
              const isDate = r.FilterType === 'DATE_RANGE';
              const filterFieldOpts = [...new Set([qf?.ValueField, qf?.LabelField].filter(Boolean))];
              return (
                <tr key={r.LinkID ?? 'new' + i}>
                  {mode !== 'form' && (
                  <td style={tdc}>
                    <select value={r.FilterType} onChange={e => patch(i, { FilterType: e.target.value })} style={{ ...cell, minWidth: 130 }}>
                      {QFL_FILTER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  )}
                  <td style={tdc}>
                    <select value={r.QueryFilterID} disabled={isDate}
                      onChange={e => patch(i, { QueryFilterID: e.target.value, FilterField: '' })}
                      style={{ ...cell, minWidth: 150, opacity: isDate ? 0.4 : 1 }}>
                      <option value="">{isDate ? '— (not needed)' : '(pick filter)'}</option>
                      {filters.map(f => <option key={f.QueryFilterID} value={f.QueryFilterID}>{f.FilterName}</option>)}
                    </select>
                  </td>
                  <td style={tdc}>
                    <select value={r.QueryField} onChange={e => patch(i, { QueryField: e.target.value })} style={{ ...cell, minWidth: 150 }}>
                      <option value="">(pick column)</option>
                      {queryFields.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </td>
                  <td style={tdc}>
                    <select value={r.FilterField} disabled={isDate || !qf}
                      onChange={e => patch(i, { FilterField: e.target.value })}
                      style={{ ...cell, minWidth: 130, opacity: (isDate || !qf) ? 0.4 : 1 }}>
                      <option value="">{isDate ? '—' : '(pick column)'}</option>
                      {filterFieldOpts.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </td>
                  {mode !== 'form' && <>
                  <td style={{ ...tdc, textAlign: 'center' }}>
                    <input type="checkbox" checked={r.UsePanel} onChange={e => patch(i, { UsePanel: e.target.checked })} />
                  </td>
                  <td style={tdc}>
                    {isDate ? (
                      <select value={r.FixedFrom} onChange={e => patch(i, { FixedFrom: e.target.value })}
                        style={{ ...cell, width: 120 }}>
                        {DATE_TOKENS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      <input value={r.FixedFrom} disabled={r.UsePanel} onChange={e => patch(i, { FixedFrom: e.target.value })}
                        placeholder="value / list" style={{ ...cell, width: 110, opacity: r.UsePanel ? 0.4 : 1 }} />
                    )}
                  </td>
                  <td style={tdc}>
                    {isDate ? (
                      <select value={r.FixedTo} onChange={e => patch(i, { FixedTo: e.target.value })}
                        style={{ ...cell, width: 120 }}>
                        {DATE_TOKENS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      <input value={r.FixedTo} disabled={r.UsePanel} onChange={e => patch(i, { FixedTo: e.target.value })}
                        placeholder="upper" style={{ ...cell, width: 90, opacity: r.UsePanel ? 0.4 : 1 }} />
                    )}
                  </td>
                  </>}
                  <td style={tdc}>
                    <input value={r.LabelOverride} onChange={e => patch(i, { LabelOverride: e.target.value })} style={{ ...cell, width: 110 }} />
                  </td>
                  <td style={tdc}>
                    <input type="number" value={r.SortOrder} onChange={e => patch(i, { SortOrder: e.target.value })} style={{ ...cell, width: 56 }} />
                  </td>
                  <td style={{ ...tdc, whiteSpace: 'nowrap' }}>
                    <button onClick={() => saveRow(i)} disabled={busy === i}
                      style={{ height: 28, padding: '0 12px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      {busy === i ? '…' : 'Save'}
                    </button>
                    <button onClick={() => deleteRow(i)} disabled={busy === i}
                      style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} style={{
        marginTop: 12, height: 32, padding: '0 14px', background: 'var(--soft)', color: 'var(--text)',
        border: '1.5px dashed var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
      }}>+ Add filter</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operations tab -- link reusable V1OperationMaster rows to THIS page
// (V1PageOperations). Each link picks the page's Detail/View query the
// operation runs and an optional JSON config override.
// ---------------------------------------------------------------------------
const opBlank = () => ({
  PageOperationID: null, OperationID: '', QueryID: '', ConfigOverride: '', SortOrder: '',
});

function PageOperationsTab({ pageGroupId }) {
  const [ops, setOps] = useState([]);          // all V1OperationMaster
  const [queries, setQueries] = useState([]);  // this page's registered queries
  const [rows, setRows] = useState([]);        // V1PageOperations for this page
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [om, pq, po] = await Promise.all([
        apiCall('GetOperationMaster', {}, {}, 'plus'),
        apiCall('GetPageQueries', { PageGroupID: pageGroupId }, {}, 'plus'),
        apiCall('GetPageOperations', { PageGroupID: pageGroupId }, {}, 'plus'),
      ]);
      if (om.State === 0) setOps((om.List0 || []).filter(o => o.IsActive === 1 || o.IsActive === true));
      if (pq.State === 0) setQueries(pq.List0 || []);
      if (po.State === 0) setRows((po.List0 || []).map(r => ({
        PageOperationID: r.PageOperationID,
        OperationID: r.OperationID,
        QueryID: r.QueryID ?? '',
        ConfigOverride: r.ConfigOverride ?? '',
        SortOrder: r.SortOrder ?? '',
      })));
      else setErr(po.Message || 'Failed to load page operations');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }
  useEffect(() => { if (pageGroupId != null) load(); /* eslint-disable-next-line */ }, [pageGroupId]);

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, opBlank()]);

  async function saveRow(i) {
    const r = rows[i];
    if (!r.OperationID) { setErr('Pick an operation.'); return; }
    if (r.ConfigOverride.trim()) {
      try { JSON.parse(r.ConfigOverride); }
      catch { setErr('Config override must be valid JSON (or blank).'); return; }
    }
    setBusy(i); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SavePageOperationRelation', {
        PageOperationID: r.PageOperationID, PageGroupID: pageGroupId,
        OperationID: Number(r.OperationID),
        QueryID: r.QueryID === '' ? null : Number(r.QueryID),
        ConfigOverride: r.ConfigOverride.trim() || null,
        SortOrder: r.SortOrder === '' ? null : Number(r.SortOrder),
        IsLinked: 1,
      }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Saved'); await load(); }
      else setErr(res.Message || 'Failed to save');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  async function deleteRow(i) {
    const r = rows[i];
    if (r.PageOperationID == null) { setRows(rs => rs.filter((_, j) => j !== i)); return; }
    if (!window.confirm('Unlink this operation from the page? Its user grants for this page are removed too.')) return;
    setBusy(i); setErr(null);
    try {
      const res = await apiCall('SavePageOperationRelation', {
        PageGroupID: pageGroupId, OperationID: r.OperationID, IsLinked: 0,
      }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Unlinked'); await load(); }
      else setErr(res.Message || 'Failed to unlink');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  const cell = {
    width: '100%', height: 30, padding: '0 8px', border: '1.5px solid var(--border)',
    borderRadius: 6, fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
  };
  const th = { fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '0 6px 8px', whiteSpace: 'nowrap' };
  const tdc = { padding: '4px 6px', borderTop: '1px solid var(--border)', verticalAlign: 'top' };

  if (loading) return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  const usedIds = new Set(rows.map(r => String(r.OperationID)));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{msg}</div>}
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        Operations exposed on this page. Users are granted each one per page in User Permissions → Operations.
        {ops.length === 0 && ' — no active operations exist yet; create some in Operation Master.'}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead>
            <tr>{['Operation', 'Runs Query', 'Config Override (JSON)', 'Sort', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                No operations linked to this page.
              </td></tr>
            )}
            {rows.map((r, i) => {
              const om = ops.find(o => String(o.OperationID) === String(r.OperationID));
              return (
                <tr key={r.PageOperationID ?? 'new' + i}>
                  <td style={tdc}>
                    <select value={r.OperationID} onChange={e => patch(i, { OperationID: e.target.value })}
                      style={{ ...cell, minWidth: 190 }}>
                      <option value="">(pick operation)</option>
                      {ops.filter(o => String(o.OperationID) === String(r.OperationID) || !usedIds.has(String(o.OperationID)))
                        .map(o => <option key={o.OperationID} value={o.OperationID}>{o.Label} — {o.OperationKey}</option>)}
                    </select>
                    {om?.BackendOperation && (
                      <div style={{ fontSize: 9.5, color: 'var(--muted)', fontFamily: 'monospace', marginTop: 2 }}>→ {om.BackendOperation}</div>
                    )}
                  </td>
                  <td style={tdc}>
                    <select value={r.QueryID} onChange={e => patch(i, { QueryID: e.target.value })}
                      style={{ ...cell, minWidth: 170 }}>
                      <option value="">(none)</option>
                      {queries.map(q => <option key={q.QueryID} value={q.QueryID}>{q.QueryName} ({q.QueryType})</option>)}
                    </select>
                  </td>
                  <td style={tdc}>
                    <input value={r.ConfigOverride} onChange={e => patch(i, { ConfigOverride: e.target.value })}
                      placeholder={om?.Config || '{ }'} style={{ ...cell, minWidth: 200, fontFamily: 'monospace' }} />
                  </td>
                  <td style={tdc}>
                    <input type="number" value={r.SortOrder} onChange={e => patch(i, { SortOrder: e.target.value })} style={{ ...cell, width: 56 }} />
                  </td>
                  <td style={{ ...tdc, whiteSpace: 'nowrap' }}>
                    <button onClick={() => saveRow(i)} disabled={busy === i}
                      style={{ height: 28, padding: '0 12px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      {busy === i ? '…' : 'Save'}
                    </button>
                    <button onClick={() => deleteRow(i)} disabled={busy === i}
                      style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} disabled={ops.length === 0} style={{
        marginTop: 12, height: 32, padding: '0 14px', background: 'var(--soft)', color: 'var(--text)',
        border: '1.5px dashed var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700,
        cursor: ops.length === 0 ? 'not-allowed' : 'pointer', opacity: ops.length === 0 ? 0.5 : 1,
      }}>+ Add operation</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group By tab -- Group By configs for THIS page's Base query
// (V1GroupByMaster). Each config: name, active, sort, group-field chips and
// aggregate rows. Grouping SQL is built server-side (GetGridData.GroupByIDs).
// ---------------------------------------------------------------------------
const GB_OPS = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
const gbBlank = () => ({
  GroupByID: null, GroupByName: '', IsActive: true, IsDefault: false, DisplayOrder: '',
  Fields: [], Aggs: [],
});

function PageGroupByTab({ pageGroupId }) {
  const [queryId, setQueryId] = useState(null);
  const [queryName, setQueryName] = useState('');
  const [queryFields, setQueryFields] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const qm = await apiCall('GetQueryMaster', {}, {}, 'plus');
      const q = (qm.List0 || []).find(r => String(r.PageGroupID) === String(pageGroupId) && r.QueryType === 'Base')
             || (qm.List0 || []).find(r => String(r.PageGroupID) === String(pageGroupId));
      if (!q?.QueryID) { setQueryId(null); setRows([]); setLoading(false); return; }
      setQueryId(q.QueryID); setQueryName(q.QueryName || '');
      const [gb, flds] = await Promise.all([
        apiCall('GetGroupByMaster', { QueryID: q.QueryID }, {}, 'plus'),
        apiCall('GetQueryFields', { QueryID: q.QueryID }, {}, 'plus'),
      ]);
      if (flds.State === 0) setQueryFields((flds.List0 || []).map(f => f.FieldName).filter(Boolean));
      if (gb.State === 0) {
        const fById = {}, aById = {};
        (gb.List1 || []).forEach(f => { (fById[f.GroupByID] ||= []).push(f); });
        (gb.List2 || []).forEach(a => { (aById[a.GroupByID] ||= []).push(a); });
        setRows((gb.List0 || []).map(c => ({
          GroupByID: c.GroupByID, GroupByName: c.GroupByName || '',
          IsActive: c.IsActive === 1 || c.IsActive === true,
          IsDefault: c.IsDefault === 1 || c.IsDefault === true,
          DisplayOrder: c.DisplayOrder ?? '',
          Fields: (fById[c.GroupByID] || []).sort((x, y) => (x.SortOrder ?? 1e9) - (y.SortOrder ?? 1e9)).map(f => f.FieldName),
          Aggs: (aById[c.GroupByID] || []).sort((x, y) => (x.SortOrder ?? 1e9) - (y.SortOrder ?? 1e9))
            .map(a => ({ FieldName: a.FieldName, Operation: a.Operation, DisplayName: a.DisplayName || '' })),
        })));
      } else setErr(gb.Message || 'Failed to load Group By configs');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }
  useEffect(() => { if (pageGroupId != null) load(); /* eslint-disable-next-line */ }, [pageGroupId]);

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, gbBlank()]);
  const toggleField = (i, name) => patch(i, {
    Fields: rows[i].Fields.includes(name) ? rows[i].Fields.filter(n => n !== name) : [...rows[i].Fields, name],
  });
  const addAgg = (i) => patch(i, { Aggs: [...rows[i].Aggs, { FieldName: '', Operation: 'SUM', DisplayName: '' }] });
  const patchAgg = (i, j, p) => patch(i, { Aggs: rows[i].Aggs.map((a, k) => (k === j ? { ...a, ...p } : a)) });
  const rmAgg = (i, j) => patch(i, { Aggs: rows[i].Aggs.filter((_, k) => k !== j) });

  async function saveRow(i) {
    const r = rows[i];
    if (!r.GroupByName.trim()) { setErr('Group By Name is required.'); return; }
    if (r.Fields.length === 0) { setErr('Pick at least one group field.'); return; }
    if (r.Aggs.some(a => !a.FieldName)) { setErr('Every aggregate needs a field.'); return; }
    setBusy(i); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SaveGroupByMaster', {
        GroupByID: r.GroupByID, GroupByName: r.GroupByName.trim(), QueryID: queryId,
        IsActive: r.IsActive ? 1 : 0,
        IsDefault: r.IsDefault ? 1 : 0,
        DisplayOrder: r.DisplayOrder === '' ? null : Number(r.DisplayOrder),
        Fields: r.Fields,
        Aggregates: r.Aggs.map(a => ({ FieldName: a.FieldName, Operation: a.Operation, DisplayName: a.DisplayName.trim() || null })),
      }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Saved'); await load(); }
      else setErr(res.Message || 'Failed to save');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  async function deleteRow(i) {
    const r = rows[i];
    if (r.GroupByID == null) { setRows(rs => rs.filter((_, j) => j !== i)); return; }
    if (!window.confirm(`Delete Group By "${r.GroupByName}"?`)) return;
    setBusy(i); setErr(null);
    try {
      const res = await apiCall('DeleteGroupByMaster', { GroupByID: r.GroupByID }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Deleted'); await load(); }
      else setErr(res.Message || 'Failed to delete');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  const cell = {
    height: 28, padding: '0 8px', border: '1.5px solid var(--border)', borderRadius: 6,
    fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
  };
  const lbl = { fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase' };

  if (loading) return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (queryId == null) return (
    <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
      No Base query linked to this page. Link one in Query Master first.
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid var(--border)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid var(--border)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{msg}</div>}
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 14 }}>
        Group By configs for <strong>{queryName}</strong> (#{queryId}). Active ones show in the page's Group By selector.
      </p>

      {rows.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, border: '1.5px dashed var(--border)', borderRadius: 8 }}>
          No Group By configs for this query yet.
        </div>
      )}

      {rows.map((r, i) => (
        <div key={r.GroupByID ?? 'new' + i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <input value={r.GroupByName} onChange={e => patch(i, { GroupByName: e.target.value })}
              placeholder="Group By name" style={{ ...cell, minWidth: 200, fontWeight: 700 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={r.IsActive} onChange={e => patch(i, { IsActive: e.target.checked })} /> Active
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={r.IsDefault} onChange={e => patch(i, { IsDefault: e.target.checked })} /> Default
            </label>
            <input type="number" value={r.DisplayOrder} onChange={e => patch(i, { DisplayOrder: e.target.value })}
              placeholder="sort" style={{ ...cell, width: 60 }} />
            <div style={{ flex: 1 }} />
            <button onClick={() => saveRow(i)} disabled={busy === i}
              style={{ height: 28, padding: '0 12px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              {busy === i ? '…' : 'Save'}
            </button>
            <button onClick={() => deleteRow(i)} disabled={busy === i}
              style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>✕</button>
          </div>

          <div style={{ ...lbl, marginBottom: 5 }}>Group Fields</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {queryFields.map(name => {
              const on = r.Fields.includes(name);
              return (
                <button key={name} type="button" onClick={() => toggleField(i, name)} style={{
                  fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
                  border: '1px solid ' + (on ? 'var(--orange)' : 'var(--border)'),
                  background: on ? 'var(--orange-soft)' : 'var(--bg)', color: on ? 'var(--orange)' : 'var(--text)',
                }}>{name}</button>
              );
            })}
          </div>

          <div style={{ ...lbl, marginBottom: 5 }}>Aggregates</div>
          {r.Aggs.map((a, j) => (
            <div key={j} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
              <select value={a.FieldName} onChange={e => patchAgg(i, j, { FieldName: e.target.value })} style={{ ...cell, minWidth: 150 }}>
                <option value="">(field)</option>
                {queryFields.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <select value={a.Operation} onChange={e => patchAgg(i, j, { Operation: e.target.value })} style={{ ...cell, width: 90 }}>
                {GB_OPS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <input value={a.DisplayName} onChange={e => patchAgg(i, j, { DisplayName: e.target.value })}
                placeholder={a.FieldName ? `${a.Operation} ${a.FieldName}` : 'display name'} style={{ ...cell, minWidth: 160 }} />
              <button onClick={() => rmAgg(i, j)} style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          <button onClick={() => addAgg(i)} style={{
            marginTop: 4, height: 26, padding: '0 10px', background: 'var(--soft)', color: 'var(--text)',
            border: '1.5px dashed var(--border)', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
          }}>+ Add aggregate</button>
        </div>
      ))}

      <button onClick={addRow} style={{
        marginTop: 4, height: 32, padding: '0 14px', background: 'var(--soft)', color: 'var(--text)',
        border: '1.5px dashed var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
      }}>+ Add Group By</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPIs tab -- V1KPIMaster rows for this page's Base query. Each is a
// server-calculated summary card shown above the page's grid, synced with
// the grid's active Filter/Search.
// ---------------------------------------------------------------------------
const KPI_OPS = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
const KPI_FORMATS = ['number', 'integer', 'currency', 'percent', 'compact'];
const kpiBlank = () => ({
  KPIID: null, KPIName: '', DisplayName: '', FieldName: '',
  Operation: 'SUM', Format: 'number', DisplayOrder: '', IsActive: true,
});

function PageKPIsTab({ pageGroupId }) {
  const [queryId, setQueryId] = useState(null);
  const [queryName, setQueryName] = useState('');
  const [queryFields, setQueryFields] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const qm = await apiCall('GetQueryMaster', {}, {}, 'plus');
      const q = (qm.List0 || []).find(r => String(r.PageGroupID) === String(pageGroupId) && r.QueryType === 'Base')
             || (qm.List0 || []).find(r => String(r.PageGroupID) === String(pageGroupId));
      if (!q?.QueryID) { setQueryId(null); setRows([]); setLoading(false); return; }
      setQueryId(q.QueryID); setQueryName(q.QueryName || '');
      const [km, flds] = await Promise.all([
        apiCall('GetKPIMaster', { PageGroupID: pageGroupId }, {}, 'plus'),
        apiCall('GetQueryFields', { QueryID: q.QueryID }, {}, 'plus'),
      ]);
      if (flds.State === 0) setQueryFields((flds.List0 || []).map(f => f.FieldName).filter(Boolean));
      if (km.State === 0) {
        setRows((km.List0 || []).filter(k => String(k.QueryID) === String(q.QueryID)).map(k => ({
          KPIID: k.KPIID, KPIName: k.KPIName || '', DisplayName: k.DisplayName || '',
          FieldName: k.FieldName || '', Operation: k.Operation || 'SUM',
          Format: k.Format || 'number', DisplayOrder: k.DisplayOrder ?? '',
          IsActive: k.IsActive === 1 || k.IsActive === true,
        })));
      } else setErr(km.Message || 'Failed to load KPIs');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }
  useEffect(() => { if (pageGroupId != null) load(); /* eslint-disable-next-line */ }, [pageGroupId]);

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, kpiBlank()]);

  async function saveRow(i) {
    const r = rows[i];
    if (!r.KPIName.trim() || !r.DisplayName.trim()) { setErr('KPI Name and Display Name are required.'); return; }
    if (r.Operation !== 'COUNT' && !r.FieldName) { setErr(`${r.Operation} needs a field.`); return; }
    setBusy(i); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SaveKPIMaster', {
        KPIID: r.KPIID, KPIName: r.KPIName.trim(), DisplayName: r.DisplayName.trim(),
        PageGroupID: pageGroupId, QueryID: queryId,
        FieldName: r.Operation === 'COUNT' && !r.FieldName ? null : (r.FieldName || null),
        Operation: r.Operation, Format: r.Format,
        DisplayOrder: r.DisplayOrder === '' ? null : Number(r.DisplayOrder),
        IsActive: r.IsActive ? 1 : 0,
      }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Saved'); await load(); }
      else setErr(res.Message || 'Failed to save');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  async function deleteRow(i) {
    const r = rows[i];
    if (r.KPIID == null) { setRows(rs => rs.filter((_, j) => j !== i)); return; }
    if (!window.confirm(`Delete KPI "${r.DisplayName || r.KPIName}"?`)) return;
    setBusy(i); setErr(null);
    try {
      const res = await apiCall('DeleteKPIMaster', { KPIID: r.KPIID }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Deleted'); await load(); }
      else setErr(res.Message || 'Failed to delete');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  const cell = {
    height: 28, padding: '0 8px', border: '1.5px solid var(--border)', borderRadius: 6,
    fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
  };

  if (loading) return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  if (queryId == null) return (
    <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
      No Base query linked to this page. Link one in Query Master first.
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid var(--border)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid var(--border)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{msg}</div>}
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        KPIs summarise <b>{queryName}</b>. Values are calculated on the server against the grid's current filter / search.
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead><tr style={{ background: 'var(--soft)', textAlign: 'left' }}>
            {['KPI Name', 'Display Name', 'Operation', 'Field', 'Format', 'Order', 'Active', ''].map(h => (
              <th key={h} style={{ padding: '7px 8px', fontSize: 9.5, textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 800 }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} style={{ padding: 14, color: 'var(--muted)' }}>No KPIs configured.</td></tr>}
            {rows.map((r, i) => (
              <tr key={r.KPIID ?? `n${i}`} style={{ borderTop: '1px solid var(--border)', opacity: busy === i ? 0.5 : 1 }}>
                <td style={{ padding: '5px 8px' }}><input style={{ ...cell, width: 130 }} value={r.KPIName} onChange={e => patch(i, { KPIName: e.target.value })} placeholder="TOTAL_PO_AMOUNT" /></td>
                <td style={{ padding: '5px 8px' }}><input style={{ ...cell, width: 150 }} value={r.DisplayName} onChange={e => patch(i, { DisplayName: e.target.value })} placeholder="Total Amount" /></td>
                <td style={{ padding: '5px 8px' }}>
                  <select style={{ ...cell, width: 90 }} value={r.Operation} onChange={e => patch(i, { Operation: e.target.value })}>
                    {KPI_OPS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </td>
                <td style={{ padding: '5px 8px' }}>
                  <select style={{ ...cell, width: 170 }} value={r.FieldName} onChange={e => patch(i, { FieldName: e.target.value })}
                    disabled={r.Operation === 'COUNT'}>
                    <option value="">{r.Operation === 'COUNT' ? '(all rows)' : '— field —'}</option>
                    {queryFields.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </td>
                <td style={{ padding: '5px 8px' }}>
                  <select style={{ ...cell, width: 90 }} value={r.Format} onChange={e => patch(i, { Format: e.target.value })}>
                    {KPI_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </td>
                <td style={{ padding: '5px 8px' }}><input style={{ ...cell, width: 48, textAlign: 'right' }} value={r.DisplayOrder} onChange={e => patch(i, { DisplayOrder: e.target.value.replace(/[^0-9]/g, '') })} /></td>
                <td style={{ padding: '5px 8px', textAlign: 'center' }}><input type="checkbox" checked={r.IsActive} onChange={e => patch(i, { IsActive: e.target.checked })} /></td>
                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                  <button onClick={() => saveRow(i)} disabled={busy === i} style={{ ...cell, cursor: 'pointer', fontWeight: 700, background: 'var(--orange)', color: '#fff', border: '1px solid var(--orange)', marginRight: 4 }}>Save</button>
                  <button onClick={() => deleteRow(i)} disabled={busy === i} style={{ ...cell, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} style={{ marginTop: 12, height: 30, padding: '0 14px', border: '1px dashed var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>+ Add KPI</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications tab -- PLS.V1NotificationEventType rows scoped to THIS page:
// which events raise a bell notification, who gets it (RecipientRules), and
// the message templates. Raised in-process by the page's business SP via
// PLS.V1RaiseNotification. See docs/notification-system-plan.md and
// Settings > Notification Settings (the same data, across every page).
// ---------------------------------------------------------------------------
const NOTIF_SP = 'Pls.APINotificationV1';
const NOTIF_PRIORITIES = ['Low', 'Normal', 'High'];
const NOTIF_RULE_TOKENS = ['watchers', 'page-users', '-actor'];
const notifBlank = () => ({
  EventTypeID: null, EventKey: '', TitleTemplate: '', BodyTemplate: '',
  RecipientRules: '["watchers","-actor"]', Priority: 'Normal', IsActive: true,
});

function PageNotificationsTab({ pageGroupId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const res = await apiCall('GetNotificationEventTypes', {}, {}, { spName: NOTIF_SP });
      if (res.State === 0) {
        setRows((res.List0 || []).filter(e => String(e.PageGroupID) === String(pageGroupId)).map(e => ({
          EventTypeID: e.EventTypeID, EventKey: e.EventKey || '',
          TitleTemplate: e.TitleTemplate || '', BodyTemplate: e.BodyTemplate || '',
          RecipientRules: e.RecipientRules || '[]', Priority: e.Priority || 'Normal',
          IsActive: e.IsActive === 1 || e.IsActive === true,
        })));
      } else setErr(res.Message || 'Failed to load notification events');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }
  useEffect(() => { if (pageGroupId != null) load(); /* eslint-disable-next-line */ }, [pageGroupId]);

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, notifBlank()]);

  const toggleToken = (i, token) => {
    const r = rows[i];
    let arr; try { arr = JSON.parse(r.RecipientRules); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
    arr = arr.includes(token) ? arr.filter(t => t !== token) : [...arr, token];
    patch(i, { RecipientRules: JSON.stringify(arr) });
  };

  async function saveRow(i) {
    const r = rows[i];
    if (!r.EventKey.trim() || !r.TitleTemplate.trim()) { setErr('Event Key and Title Template are required.'); return; }
    try { const a = JSON.parse(r.RecipientRules); if (!Array.isArray(a)) throw 0; } catch { setErr('Recipient Rules must be a JSON array of tokens.'); return; }
    setBusy(i); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SaveNotificationEventType', {
        EventTypeID: r.EventTypeID, EventKey: r.EventKey.trim().toUpperCase(), PageGroupID: pageGroupId,
        TitleTemplate: r.TitleTemplate.trim(), BodyTemplate: r.BodyTemplate.trim() || null,
        RecipientRules: r.RecipientRules, Priority: r.Priority, IsActive: r.IsActive ? 1 : 0,
      }, {}, { spName: NOTIF_SP });
      if (res.State === 0) { setMsg('✓ Saved'); await load(); }
      else setErr(res.Message || 'Failed to save');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  async function deleteRow(i) {
    const r = rows[i];
    if (r.EventTypeID == null) { setRows(rs => rs.filter((_, j) => j !== i)); return; }
    if (!window.confirm(`Delete event type "${r.EventKey}"? Past notifications stay; this stops future ones.`)) return;
    setBusy(i); setErr(null);
    try {
      const res = await apiCall('DeleteNotificationEventType', { EventTypeID: r.EventTypeID }, {}, { spName: NOTIF_SP });
      if (res.State === 0) { setMsg('✓ Deleted'); await load(); }
      else setErr(res.Message || 'Failed to delete');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  const cell = {
    height: 28, padding: '0 8px', border: '1.5px solid var(--border)', borderRadius: 6,
    fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
  };

  if (loading) return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid var(--border)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid var(--border)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{msg}</div>}
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        Events that raise a bell notification for this page. Raised in-process by the page's business SP via <code>PLS.V1RaiseNotification</code> -- adding a row here doesn't wire up the SP call itself.
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead><tr style={{ background: 'var(--soft)', textAlign: 'left' }}>
            {['Event Key', 'Title Template', 'Body Template', 'Recipients', 'Priority', 'Active', ''].map(h => (
              <th key={h} style={{ padding: '7px 8px', fontSize: 9.5, textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 800 }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} style={{ padding: 14, color: 'var(--muted)' }}>No notification events for this page yet.</td></tr>}
            {rows.map((r, i) => {
              let activeTokens = []; try { activeTokens = JSON.parse(r.RecipientRules) || []; } catch { /* keep [] */ }
              return (
                <tr key={r.EventTypeID ?? `n${i}`} style={{ borderTop: '1px solid var(--border)', opacity: busy === i ? 0.5 : 1 }}>
                  <td style={{ padding: '5px 8px' }}><input style={{ ...cell, width: 150, fontFamily: 'monospace' }} value={r.EventKey} onChange={e => patch(i, { EventKey: e.target.value })} placeholder="PO_APPROVED" /></td>
                  <td style={{ padding: '5px 8px' }}><input style={{ ...cell, width: 180 }} value={r.TitleTemplate} onChange={e => patch(i, { TitleTemplate: e.target.value })} placeholder="PO {PONumber} approved" /></td>
                  <td style={{ padding: '5px 8px' }}><input style={{ ...cell, width: 180 }} value={r.BodyTemplate} onChange={e => patch(i, { BodyTemplate: e.target.value })} placeholder="Approved by {ApprovedBy}." /></td>
                  <td style={{ padding: '5px 8px' }}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', width: 190 }}>
                      {NOTIF_RULE_TOKENS.map(t => {
                        const on = activeTokens.includes(t);
                        return (
                          <button key={t} type="button" onClick={() => toggleToken(i, t)} style={{
                            height: 22, padding: '0 7px', borderRadius: 5, fontSize: 9.5, fontWeight: 700, cursor: 'pointer',
                            border: '1px solid ' + (on ? 'var(--orange)' : 'var(--border)'),
                            background: on ? 'var(--orange-soft)' : 'var(--bg)',
                            color: on ? 'var(--orange)' : 'var(--muted)', fontFamily: 'monospace',
                          }}>{t}</button>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ padding: '5px 8px' }}>
                    <select style={{ ...cell, width: 80 }} value={r.Priority} onChange={e => patch(i, { Priority: e.target.value })}>
                      {NOTIF_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '5px 8px', textAlign: 'center' }}><input type="checkbox" checked={r.IsActive} onChange={e => patch(i, { IsActive: e.target.checked })} /></td>
                  <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                    <button onClick={() => saveRow(i)} disabled={busy === i} style={{ ...cell, cursor: 'pointer', fontWeight: 700, background: 'var(--orange)', color: '#fff', border: '1px solid var(--orange)', marginRight: 4 }}>Save</button>
                    <button onClick={() => deleteRow(i)} disabled={busy === i} style={{ ...cell, cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button onClick={addRow} style={{ marginTop: 12, height: 30, padding: '0 14px', border: '1px dashed var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>+ Add Notification Event</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports tab -- link V1ReportMaster reports to this page as a Form or Grid
// report (V1ReportLink). Users are granted each in User Permissions -> Reports.
// ---------------------------------------------------------------------------
const rlBlank = () => ({
  LinkID: null, ReportID: '', Target: 'Form', RecordScope: '',
  KeyField: '', DisplayName: '', DisplayOrder: '', IsActive: true,
});

function PageReportsTab({ pageGroupId }) {
  const [reports, setReports] = useState([]);   // all V1ReportMaster
  const [rows, setRows] = useState([]);         // V1ReportLink for this page
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  async function load() {
    setLoading(true); setErr(null);
    try {
      const [rm, rl] = await Promise.all([
        apiCall('GetReportMaster', {}, {}, 'plus'),
        apiCall('GetReportLinks', { PageGroupID: pageGroupId }, {}, 'plus'),
      ]);
      if (rm.State === 0) setReports((rm.List0 || []).filter(r => r.IsActive === 1 || r.IsActive === true));
      if (rl.State === 0) setRows((rl.List0 || []).map(r => ({
        LinkID: r.LinkID, ReportID: r.ReportID, Target: r.Target || 'Form',
        RecordScope: r.RecordScope ?? '', KeyField: r.KeyField ?? '',
        DisplayName: r.DisplayName ?? '', DisplayOrder: r.DisplayOrder ?? '',
        IsActive: r.IsActive === 1 || r.IsActive === true,
      })));
      else setErr(rl.Message || 'Failed to load report links');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }
  useEffect(() => { if (pageGroupId != null) load(); /* eslint-disable-next-line */ }, [pageGroupId]);

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = () => setRows(rs => [...rs, rlBlank()]);

  async function saveRow(i) {
    const r = rows[i];
    if (!r.ReportID) { setErr('Pick a report.'); return; }
    setBusy(i); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SaveReportLink', {
        LinkID: r.LinkID, ReportID: Number(r.ReportID), PageGroupID: pageGroupId,
        Target: r.Target,
        RecordScope: r.Target === 'Grid' ? (r.RecordScope || null) : null,
        KeyField: r.KeyField.trim() || null,
        DisplayName: r.DisplayName.trim() || null,
        DisplayOrder: r.DisplayOrder === '' ? null : Number(r.DisplayOrder),
        IsActive: r.IsActive ? 1 : 0,
      }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Saved'); await load(); }
      else setErr(res.Message || 'Failed to save');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  async function deleteRow(i) {
    const r = rows[i];
    if (r.LinkID == null) { setRows(rs => rs.filter((_, j) => j !== i)); return; }
    if (!window.confirm('Unlink this report from the page?')) return;
    setBusy(i); setErr(null);
    try {
      const res = await apiCall('DeleteReportLink', { LinkID: r.LinkID }, {}, 'plus');
      if (res.State === 0) { setMsg('✓ Unlinked'); await load(); }
      else setErr(res.Message || 'Failed to unlink');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(null);
  }

  const cell = {
    width: '100%', height: 30, padding: '0 8px', border: '1.5px solid var(--border)',
    borderRadius: 6, fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
  };
  const th = { fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '0 6px 8px', whiteSpace: 'nowrap' };
  const tdc = { padding: '4px 6px', borderTop: '1px solid var(--border)', verticalAlign: 'top' };

  if (loading) return <div style={{ flex: 1, padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
      {err && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{err}</div>}
      {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{msg}</div>}
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        Reports available on this page. A <b>Form</b> report prints one record (KeyField = its key). A <b>Grid</b> report prints a list — Record Scope says which rows.
        {reports.length === 0 && ' — no active reports exist yet; create some in Report Master.'}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>{['Report', 'Target', 'Record Scope', 'Key Field', 'Display Name', 'Sort', 'Active', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} style={{ ...tdc, color: 'var(--muted)', fontSize: 12 }}>No reports linked yet.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.LinkID ?? `new-${i}`}>
                <td style={{ ...tdc, minWidth: 200 }}>
                  <select value={r.ReportID} onChange={e => patch(i, { ReportID: e.target.value })} style={cell}>
                    <option value="">— pick —</option>
                    {reports.map(rp => <option key={rp.ReportID} value={rp.ReportID}>{rp.ReportName} ({rp.ReportCode})</option>)}
                  </select>
                </td>
                <td style={{ ...tdc, width: 90 }}>
                  <select value={r.Target} onChange={e => patch(i, { Target: e.target.value })} style={cell}>
                    <option value="Form">Form</option>
                    <option value="Grid">Grid</option>
                  </select>
                </td>
                <td style={{ ...tdc, width: 140 }}>
                  <select value={r.RecordScope} onChange={e => patch(i, { RecordScope: e.target.value })} style={cell} disabled={r.Target !== 'Grid'}>
                    <option value="">—</option>
                    <option value="SelectedRow">Selected row</option>
                    <option value="SelectedRows">Selected rows</option>
                    <option value="Filtered">All filtered</option>
                    <option value="CurrentPage">Current page</option>
                    <option value="All">Entire result</option>
                  </select>
                </td>
                <td style={{ ...tdc, width: 150 }}>
                  <input value={r.KeyField} onChange={e => patch(i, { KeyField: e.target.value })} placeholder="e.g. PurchaseOrderNumber" style={{ ...cell, fontFamily: 'monospace' }} />
                </td>
                <td style={{ ...tdc, minWidth: 150 }}>
                  <input value={r.DisplayName} onChange={e => patch(i, { DisplayName: e.target.value })} placeholder="menu label" style={cell} />
                </td>
                <td style={{ ...tdc, width: 60 }}>
                  <input value={r.DisplayOrder} onChange={e => patch(i, { DisplayOrder: e.target.value })} style={{ ...cell, textAlign: 'right' }} />
                </td>
                <td style={{ ...tdc, width: 50, textAlign: 'center' }}>
                  <input type="checkbox" checked={r.IsActive} onChange={e => patch(i, { IsActive: e.target.checked })} />
                </td>
                <td style={{ ...tdc, width: 110, whiteSpace: 'nowrap' }}>
                  <button onClick={() => saveRow(i)} disabled={busy === i} style={{ height: 28, padding: '0 10px', background: 'var(--orange)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', marginRight: 4 }}>Save</button>
                  <button onClick={() => deleteRow(i)} disabled={busy === i} style={{ height: 28, padding: '0 8px', background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, cursor: 'pointer' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button onClick={addRow} style={{
        marginTop: 12, height: 32, padding: '0 14px', background: 'var(--soft)', color: 'var(--text)',
        border: '1.5px dashed var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
      }}>+ Link a report</button>
    </div>
  );
}
