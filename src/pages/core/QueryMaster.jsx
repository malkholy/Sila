import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';
import FieldAutocompleteInput from '../../shared/FieldAutocompleteInput.jsx';

// Settings > Query Master -- manage [PLS].[V1QueryMaster] rows and map each
// query to a page ([PLS].[V1PageQueries]).
//
// Backend operations (via Pls.APIPlusOperationV1):
//   GetQueryMaster        -> { QueryID, PageGroupID, QueryName, Operation, Description, QuerySQL, QueryType, ApiUrl }
//   SaveQueryMaster       -> upsert, returns { QueryID }
//   DeleteQueryMaster     -> { QueryID }
//   SaveQueryPageRelation -> { QueryID, PageGroupID, IsLinked }
//   GetPagesAndGroups     -> for the "mapped page" dropdown
//   GetQueryFields        -> { QueryID }        -> V1QueryFields rows (Fields tab)
//   DiscoverQueryFields   -> { QueryID }        -> inspects the SQL, upserts new columns
//   SaveQueryFields       -> { QueryID, Fields } -> persists the column config

const QUERY_TYPES = ['Base', 'Detail', 'Lookup'];
const FORMAT_OPTIONS = ['', 'number:0', 'number:2', 'date', 'datetime', 'mono', 'yesno'];

const EMPTY_FORM = {
  QueryID: null,
  QueryName: '',
  Operation: '',
  Description: '',
  QuerySQL: '',
  QueryFilter: '',    // WHERE body -- composed at runtime, NOT in QuerySQL
  QueryOrderBy: '',   // ORDER BY body -- composed at runtime, NOT in QuerySQL
  QueryType: 'Base',
  ApiUrl: '',
  PageGroupID: '',   // mapped page (via V1PageQueries)
};

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none'
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase'
};

export default function QueryMaster() {
  const [queries, setQueries] = useState([]);
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('info');   // 'info' | 'fields' | 'pages'
  const [queryFields, setQueryFields] = useState([]);   // field names for the autocomplete boxes

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [q, p] = await Promise.all([
        apiCall('GetQueryMaster', {}, {}, 'plus'),
        apiCall('GetPagesAndGroups', {}, {}, 'plus'),
      ]);
      if (q.State === 0) setQueries(q.List0 || []);
      else setError(q.Message || 'Failed to load queries');
      if (p.State === 0) setPages((p.List0 || []).filter(i => !i.IsGroup));
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return queries;
    const s = search.toLowerCase();
    return queries.filter(q =>
      (q.QueryName || '').toLowerCase().includes(s) ||
      (q.Operation || '').toLowerCase().includes(s));
  }, [queries, search]);

  const pageLabel = (id) => pages.find(p => p.PageGroupID === id)?.Label || (id ?? '—');

  function handleSelect(q) {
    setSelected(q);
    setIsNew(false);
    setTab('info');
    setError(null);
    setSuccessMsg(null);
    setFormData({
      QueryID: q.QueryID,
      QueryName: q.QueryName || '',
      Operation: q.Operation || '',
      Description: q.Description || '',
      QuerySQL: q.QuerySQL || '',
      QueryFilter: q.QueryFilter || '',
      QueryOrderBy: q.QueryOrderBy || '',
      QueryType: q.QueryType || 'Base',
      ApiUrl: q.ApiUrl || '',
      PageGroupID: q.PageGroupID ?? '',
    });
    setQueryFields([]);
    apiCall('GetQueryFields', { QueryID: q.QueryID }, {}, 'plus')
      .then(res => { if (res.State === 0) setQueryFields((res.List0 || []).map(f => f.FieldName).filter(Boolean)); })
      .catch(() => {});
  }

  function handleNew() {
    setSelected(null);
    setIsNew(true);
    setTab('info');
    setError(null);
    setSuccessMsg(null);
    setFormData(EMPTY_FORM);
    setQueryFields([]);
  }

  function resetForm() {
    setSelected(null);
    setIsNew(false);
    setTab('info');
    setFormData(EMPTY_FORM);
    setQueryFields([]);
    setError(null);
    setSuccessMsg(null);
  }

  async function handleSave() {
    if (!formData.QueryName.trim()) {
      setError('Query Name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('SaveQueryMaster', {
        QueryID: isNew ? null : formData.QueryID,
        QueryName: formData.QueryName.trim(),
        Operation: formData.Operation.trim(),
        Description: formData.Description.trim(),
        QuerySQL: formData.QuerySQL,
        QueryFilter: formData.QueryFilter.trim(),
        QueryOrderBy: formData.QueryOrderBy.trim(),
        QueryType: formData.QueryType,
        ApiUrl: formData.ApiUrl.trim(),
      }, {}, 'plus');

      if (res.State !== 0) {
        setError(res.Message || 'Failed to save');
        setSaving(false);
        return;
      }

      const queryId = res.List0?.[0]?.QueryID ?? res.QueryID ?? formData.QueryID;
      const prevPage = selected?.PageGroupID ?? null;
      const nextPage = formData.PageGroupID === '' ? null : Number(formData.PageGroupID);

      if (queryId && prevPage !== nextPage) {
        if (prevPage != null) {
          await apiCall('SaveQueryPageRelation', { QueryID: queryId, PageGroupID: prevPage, IsLinked: 0 }, {}, 'plus');
        }
        if (nextPage != null) {
          await apiCall('SaveQueryPageRelation', { QueryID: queryId, PageGroupID: nextPage, IsLinked: 1 }, {}, 'plus');
        }
      }

      // Discover the query's columns into V1QueryFields (existing edits kept).
      let discovered = 0;
      if (queryId && formData.QuerySQL.trim()) {
        try {
          const d = await apiCall('DiscoverQueryFields', { QueryID: queryId }, {}, 'plus');
          if (d.State === 0) discovered = (d.List0 || []).length;
        } catch { /* non-fatal */ }
      }

      setSuccessMsg(discovered ? `✓ Saved — ${discovered} field(s) synced` : '✓ Saved successfully!');
      setIsNew(false);
      await loadData();
      if (isNew) resetForm();
    } catch (err) {
      setError('Save connection error: ' + err.message);
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!selected) return;
    if (!window.confirm(`Delete query "${selected.QueryName}"?`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiCall('DeleteQueryMaster', { QueryID: selected.QueryID }, {}, 'plus');
      if (res.State === 0) {
        setSuccessMsg('✓ Deleted.');
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
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Query Master</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Named SQL queries that back grid / detail / lookup pages.
          </p>
        </div>
        <button onClick={handleNew} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
        }}>+ New Query</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* List */}
        <div style={{ width: 320, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search queries..." value={search}
              onChange={e => setSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No queries yet.</div>
            ) : filtered.map(q => {
              const sel = selected?.QueryID === q.QueryID;
              return (
                <div key={q.QueryID} onClick={() => handleSelect(q)} style={{
                  padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                  background: sel ? 'var(--orange-soft)' : 'transparent',
                  border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent')
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{q.QueryName}</span>
                    <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4 }}>{q.QueryType}</span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>
                    #{q.QueryID} • {q.PageGroupID != null ? pageLabel(q.PageGroupID) : 'unmapped'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Form */}
        <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!showForm ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Select a query, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? 'New Query' : `Editing #${formData.QueryID}`}
                </h3>
                {!isNew && (
                  <button onClick={handleDelete} disabled={saving}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✕ Delete</button>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
                {[['info', 'Info'], ['fields', 'Fields'], ['pages', 'Pages']].map(([key, label]) => {
                  const disabled = key !== 'info' && isNew;
                  const active = tab === key;
                  return (
                    <button key={key} disabled={disabled}
                      onClick={() => setTab(key)}
                      title={disabled ? 'Save the query first' : undefined}
                      style={{
                        appearance: 'none', background: 'none', border: 'none',
                        padding: '12px 10px', fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
                        color: disabled ? 'var(--border)' : active ? 'var(--orange)' : 'var(--muted)',
                        borderBottom: '2px solid ' + (active ? 'var(--orange)' : 'transparent'),
                        marginBottom: -1,
                      }}>{label}</button>
                  );
                })}
              </div>

              {tab === 'fields' ? (
                <QueryFieldsTab queryId={formData.QueryID} />
              ) : tab === 'pages' ? (
                <QueryPagesTab
                  allPages={pages}
                  linkedPageIds={queries.filter(q => q.QueryID === formData.QueryID && q.PageGroupID != null).map(q => q.PageGroupID)}
                />
              ) : (
              <>
              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>}
                {successMsg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Query Name</label>
                    <input type="text" value={formData.QueryName}
                      onChange={e => setFormData({ ...formData, QueryName: e.target.value })}
                      placeholder="e.g. Purchase Order Header" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select value={formData.QueryType}
                      onChange={e => setFormData({ ...formData, QueryType: e.target.value })} style={inputStyle}>
                      {QUERY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Operation Key</label>
                    <input type="text" value={formData.Operation}
                      onChange={e => setFormData({ ...formData, Operation: e.target.value })}
                      placeholder="optional" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Mapped Page</label>
                    <select value={formData.PageGroupID}
                      onChange={e => setFormData({ ...formData, PageGroupID: e.target.value })} style={inputStyle}>
                      <option value="">(none)</option>
                      {pages.map(p => <option key={p.PageGroupID} value={p.PageGroupID}>{p.Label}</option>)}
                    </select>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle}>API URL</label>
                    <input type="text" value={formData.ApiUrl}
                      onChange={e => setFormData({ ...formData, ApiUrl: e.target.value })}
                      placeholder="optional" style={inputStyle} />
                  </div>
                  {formData.QueryType === 'Detail' && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={labelStyle}>View Name</label>
                      <input type="text" readOnly
                        value={selected?.ViewName || (formData.QueryName ? 'V1QD' + formData.QueryName.replace(/[^A-Za-z0-9]/g, '') : '')}
                        style={{ ...inputStyle, fontFamily: 'monospace', color: 'var(--muted)', background: 'var(--soft)' }} />
                      <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                        On save the Detail SELECT is built into <code>[PLS].[V1QD…]</code> and Query SQL is replaced with
                        <code> SELECT * FROM [PLS].[V1QD…]</code>. To change it, paste the full SELECT again (rebuilds the view)
                        or edit the view directly. Query Filter / OrderBy must use the view's column names (no table aliases).
                      </p>
                    </div>
                  )}
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Description</label>
                  <input type="text" value={formData.Description}
                    onChange={e => setFormData({ ...formData, Description: e.target.value })}
                    style={inputStyle} />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Query SQL</label>
                  <textarea value={formData.QuerySQL}
                    onChange={e => setFormData({ ...formData, QuerySQL: e.target.value })}
                    placeholder="SELECT ... FROM ..."
                    spellCheck={false}
                    style={{ ...inputStyle, height: 220, padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                    Just the <code>SELECT … FROM …</code> body. Filtering and ordering come from the
                    fields below; a legacy <code>{'{FILTER}'}</code> token is still honored if present.
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <label style={labelStyle}>Query Filter</label>
                    <FieldAutocompleteInput
                      value={formData.QueryFilter}
                      onChange={v => setFormData({ ...formData, QueryFilter: v })}
                      fields={queryFields}
                      placeholder="e.g. Status <> 'Void'"
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Query OrderBy</label>
                    <FieldAutocompleteInput
                      value={formData.QueryOrderBy}
                      onChange={v => setFormData({ ...formData, QueryOrderBy: v })}
                      fields={queryFields}
                      placeholder="e.g. EnteredDate DESC"
                    />
                  </div>
                  <p style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--muted)', margin: 0 }}>
                    Do <strong>not</strong> put WHERE / ORDER BY in Query SQL — the engine appends these
                    (plus the per-user row filter) at runtime. Autocompletes discovered field names.
                  </p>
                </div>
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
// Fields tab -- editable V1QueryFields grid for one query. Auto-discovers the
// query's columns the first time it is opened with no config rows yet.
// ---------------------------------------------------------------------------
const normalizeField = (f) => ({
  ID: f.ID ?? null,
  FieldName: f.FieldName || '',
  DataType: f.DataType || '',
  Label: f.Label ?? '',
  Format: f.Format ?? '',
  Width: f.Width ?? '',
  SortOrder: f.SortOrder ?? '',
  Hidden: !!f.Hidden,
  ColorRules: f.ColorRules ?? '',
});

const cellInput = {
  width: '100%', height: 30, padding: '0 8px', border: '1.5px solid var(--border)',
  borderRadius: 6, fontSize: 12, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};

function QueryFieldsTab({ queryId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!queryId) return;
      setLoading(true); setErr(null); setMsg(null);
      try {
        const res = await apiCall('GetQueryFields', { QueryID: queryId }, {}, 'plus');
        let list = res.State === 0 ? (res.List0 || []) : null;
        if (list === null) { if (!cancelled) setErr(res.Message || 'Failed to load fields'); }
        else if (list.length === 0) {
          // first open -- auto-discover from the query's SQL
          const d = await apiCall('DiscoverQueryFields', { QueryID: queryId }, {}, 'plus');
          if (d.State === 0) { list = d.List0 || []; if (!cancelled && list.length) setMsg('✓ Columns discovered from the query'); }
          else if (!cancelled) setErr(d.Message || 'Auto-discovery failed');
        }
        if (!cancelled && list) setRows(list.map(normalizeField));
      } catch (e) {
        if (!cancelled) setErr('Connection error: ' + e.message);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [queryId]);

  async function rediscover() {
    setLoading(true); setErr(null); setMsg(null);
    try {
      const d = await apiCall('DiscoverQueryFields', { QueryID: queryId }, {}, 'plus');
      if (d.State === 0) { setRows((d.List0 || []).map(normalizeField)); setMsg('✓ Columns refreshed (existing edits kept)'); }
      else setErr(d.Message || 'Discovery failed');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }

  async function save() {
    setSaving(true); setErr(null); setMsg(null);
    try {
      const payload = rows.map((r, idx) => ({
        FieldName: r.FieldName,
        DataType: r.DataType || null,
        Label: r.Label?.trim() || null,
        Format: r.Format || null,
        Width: r.Width === '' || r.Width == null ? null : Number(r.Width),
        SortOrder: r.SortOrder === '' || r.SortOrder == null ? (idx + 1) * 10 : Number(r.SortOrder),
        Hidden: r.Hidden ? 1 : 0,
        ColorRules: r.ColorRules?.trim() || null,
      }));
      const res = await apiCall('SaveQueryFields', { QueryID: queryId, Fields: payload }, {}, 'plus');
      if (res.State === 0) { setRows((res.List0 || []).map(normalizeField)); setMsg('✓ Fields saved'); }
      else setErr(res.Message || 'Failed to save fields');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setSaving(false);
  }

  const patch = (i, p) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const removeRow = (i) => setRows(rs => rs.filter((_, j) => j !== i));

  const th = { fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '0 8px 8px' };

  return (
    <>
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        {err && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{err}</div>}
        {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{msg}</div>}

        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading fields…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No columns found. <button onClick={rediscover} style={{ background: 'none', border: 'none', color: 'var(--orange)', fontWeight: 700, cursor: 'pointer' }}>Discover columns</button>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Field</th>
                <th style={th}>Label</th>
                <th style={{ ...th, width: 110 }}>Format</th>
                <th style={{ ...th, width: 64 }}>Width</th>
                <th style={{ ...th, width: 56 }}>Sort</th>
                <th style={{ ...th, width: 44, textAlign: 'center' }}>Hide</th>
                <th style={th}>Color rules (JSON)</th>
                <th style={{ ...th, width: 28 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.FieldName || i}>
                  <td style={{ padding: '3px 8px', fontSize: 11.5, fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                    {r.FieldName}
                    {r.DataType && <span style={{ color: 'var(--muted)', fontSize: 9.5, marginLeft: 5 }}>{r.DataType}</span>}
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <input value={r.Label} onChange={e => patch(i, { Label: e.target.value })} style={cellInput} />
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <select value={r.Format} onChange={e => patch(i, { Format: e.target.value })} style={cellInput}>
                      {FORMAT_OPTIONS.map(f => <option key={f} value={f}>{f || '(none)'}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <input type="number" value={r.Width} onChange={e => patch(i, { Width: e.target.value })} style={cellInput} />
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <input type="number" value={r.SortOrder} onChange={e => patch(i, { SortOrder: e.target.value })} style={cellInput} />
                  </td>
                  <td style={{ padding: '3px 8px', textAlign: 'center' }}>
                    <input type="checkbox" checked={r.Hidden} onChange={e => patch(i, { Hidden: e.target.checked })} />
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <input value={r.ColorRules} onChange={e => patch(i, { ColorRules: e.target.value })}
                      placeholder='[{"op":"contains","value":"Close","color":"red","badge":true}]'
                      style={{ ...cellInput, fontFamily: 'monospace', fontSize: 11 }} />
                  </td>
                  <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                    <button onClick={() => removeRow(i)} title="Remove field"
                      style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: 13 }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 12 }}>
          Columns are discovered from the query's result set. Removing a row here deletes that
          field's config on save; re-run <strong>Re-discover</strong> to pull it back.
        </p>
      </div>

      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <button onClick={rediscover} disabled={loading || saving} style={{
          height: 36, padding: '0 16px', background: 'var(--soft)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
        }}>↻ Re-discover</button>
        <button onClick={save} disabled={loading || saving || rows.length === 0} style={{
          height: 36, padding: '0 24px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
        }}>{saving ? 'Saving…' : 'Save Fields'}</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pages tab -- read-only list of the pages this query is linked to
// (V1PageQueries, M:N). `linkedPageIds` is derived from GetQueryMaster rows.
// ---------------------------------------------------------------------------
function QueryPagesTab({ allPages, linkedPageIds }) {
  const linkedSet = new Set(linkedPageIds);
  const linkedPages = allPages
    .filter(p => linkedSet.has(p.PageGroupID))
    .sort((a, b) => (a.Label || '').localeCompare(b.Label || ''));

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        Pages this query is linked to. A page's grid uses its linked Base / Detail query.
      </p>

      {linkedPages.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
          Not linked to any page yet.
        </div>
      ) : linkedPages.map(p => (
        <div key={p.PageGroupID} style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
          borderRadius: 8, background: 'var(--orange-soft)', marginBottom: 4
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
            {p.Icon} {p.Label}
          </span>
          <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>#{p.PageGroupID}</span>
        </div>
      ))}
    </div>
  );
}
