import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > Group By Master -- predefined aggregations over a Base query.
// Each config: name + query + group fields + aggregate fields. The grid's
// "Group By" dropdown lists the active configs for a page's Base query and
// GetGridData { GroupByID } returns the aggregated dataset. The frontend
// never builds GROUP BY SQL.
//
// Backend (via Pls.APIPlusOperationV1):
//   GetGroupByMaster { QueryID? } -> List0 configs, List1 fields, List2 aggregates
//   SaveGroupByMaster   -> upsert config + replace Fields[] + Aggregates[]
//   DeleteGroupByMaster -> { GroupByID }
//   GetQueryMaster / GetQueryFields

const OPS = ['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'];
// Same vocabulary as V1QueryFields.Format -- drives the grouped grid's number
// formatting/alignment and (for currency/percent) accent colour.
const AGG_FORMATS = [
  { value: 'number', label: 'Number' },
  { value: 'number:2', label: 'Number (2dp)' },
  { value: 'integer', label: 'Integer' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
];

const EMPTY = {
  GroupByID: null, GroupByName: '', QueryID: '', Description: '',
  IsActive: true, DisplayOrder: '',
};

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase',
};
const cell = {
  width: '100%', height: 30, padding: '0 8px', border: '1.5px solid var(--border)',
  borderRadius: 6, fontSize: 11.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};

export default function GroupByMaster() {
  const [configs, setConfigs] = useState([]);
  const [allFields, setAllFields] = useState([]);       // List1
  const [allAggs, setAllAggs] = useState([]);           // List2
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [queryFields, setQueryFields] = useState([]);   // field names of form.QueryID
  const [groupFields, setGroupFields] = useState([]);   // ["Col", ...]
  const [aggs, setAggs] = useState([]);                 // [{ FieldName, Operation, DisplayName }]
  const [search, setSearch] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true); setError(null);
    try {
      const [g, q] = await Promise.all([
        apiCall('GetGroupByMaster', {}, {}, 'plus'),
        apiCall('GetQueryMaster', {}, {}, 'plus'),
      ]);
      if (g.State === 0) { setConfigs(g.List0 || []); setAllFields(g.List1 || []); setAllAggs(g.List2 || []); }
      else setError(g.Message || 'Failed to load Group By configs');
      if (q.State === 0) {
        const seen = new Set();
        setQueries((q.List0 || []).filter(r => !seen.has(r.QueryID) && seen.add(r.QueryID)));
      }
    } catch (e) { setError('Connection error: ' + e.message); }
    setLoading(false);
  }

  async function loadFieldsFor(queryId) {
    if (!queryId) { setQueryFields([]); return; }
    try {
      const r = await apiCall('GetQueryFields', { QueryID: Number(queryId) }, {}, 'plus');
      setQueryFields(r.State === 0 ? (r.List0 || []).map(f => f.FieldName).filter(Boolean) : []);
    } catch { setQueryFields([]); }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return configs;
    const s = search.toLowerCase();
    return configs.filter(c => (c.GroupByName || '').toLowerCase().includes(s) || (c.QueryName || '').toLowerCase().includes(s));
  }, [configs, search]);

  function selectConfig(c) {
    setSelected(c); setIsNew(false); setError(null); setSuccessMsg(null);
    setForm({
      GroupByID: c.GroupByID, GroupByName: c.GroupByName || '', QueryID: c.QueryID ?? '',
      Description: c.Description || '', IsActive: c.IsActive === 1 || c.IsActive === true,
      DisplayOrder: c.DisplayOrder ?? '',
    });
    setGroupFields(allFields.filter(f => f.GroupByID === c.GroupByID)
      .sort((a, b) => (a.SortOrder ?? 1e9) - (b.SortOrder ?? 1e9)).map(f => f.FieldName));
    setAggs(allAggs.filter(a => a.GroupByID === c.GroupByID)
      .sort((a, b) => (a.SortOrder ?? 1e9) - (b.SortOrder ?? 1e9))
      .map(a => ({ FieldName: a.FieldName, Operation: a.Operation, DisplayName: a.DisplayName || '', Format: a.Format || 'number' })));
    loadFieldsFor(c.QueryID);
  }

  function newConfig() {
    setSelected(null); setIsNew(true); setError(null); setSuccessMsg(null);
    setForm(EMPTY); setGroupFields([]); setAggs([]); setQueryFields([]);
  }

  function reset() {
    setSelected(null); setIsNew(false); setForm(EMPTY);
    setGroupFields([]); setAggs([]); setQueryFields([]); setError(null); setSuccessMsg(null);
  }

  function onQueryChange(qid) {
    setForm(f => ({ ...f, QueryID: qid }));
    setGroupFields([]); setAggs([]);
    loadFieldsFor(qid);
  }

  const toggleGroupField = (name) => setGroupFields(prev =>
    prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);

  const addAgg = () => setAggs(a => [...a, { FieldName: '', Operation: 'SUM', DisplayName: '', Format: 'number' }]);
  const patchAgg = (i, p) => setAggs(a => a.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const removeAgg = (i) => setAggs(a => a.filter((_, j) => j !== i));

  async function handleSave() {
    if (!form.GroupByName.trim()) { setError('Group By Name is required.'); return; }
    if (!form.QueryID) { setError('Pick a Query.'); return; }
    if (groupFields.length === 0) { setError('Select at least one group field.'); return; }
    if (aggs.some(a => !a.FieldName)) { setError('Every aggregate row needs a field.'); return; }
    setSaving(true); setError(null); setSuccessMsg(null);
    try {
      const res = await apiCall('SaveGroupByMaster', {
        GroupByID: isNew ? null : form.GroupByID,
        GroupByName: form.GroupByName.trim(),
        QueryID: Number(form.QueryID),
        Description: form.Description.trim(),
        IsActive: form.IsActive ? 1 : 0,
        DisplayOrder: form.DisplayOrder === '' ? null : Number(form.DisplayOrder),
        Fields: groupFields,
        Aggregates: aggs.map(a => ({
          FieldName: a.FieldName, Operation: a.Operation, DisplayName: a.DisplayName.trim() || null,
          Format: a.Format || 'number',
        })),
      }, {}, 'plus');
      if (res.State !== 0) { setError(res.Message || 'Failed to save'); setSaving(false); return; }
      setSuccessMsg('✓ Saved successfully!');
      setIsNew(false);
      await loadData();
      if (isNew) reset();
    } catch (e) { setError('Save connection error: ' + e.message); }
    setSaving(false);
  }

  async function handleDelete() {
    if (!selected) return;
    if (!window.confirm(`Delete Group By "${selected.GroupByName}"?`)) return;
    setSaving(true); setError(null);
    try {
      const res = await apiCall('DeleteGroupByMaster', { GroupByID: selected.GroupByID }, {}, 'plus');
      if (res.State === 0) { setSuccessMsg('✓ Deleted.'); reset(); await loadData(); }
      else setError(res.Message || 'Failed to delete');
    } catch (e) { setError('Delete connection error: ' + e.message); }
    setSaving(false);
  }

  const showForm = isNew || !!selected;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Group By Master</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Predefined aggregations over a query. Active configs appear in the page's <strong>Group By</strong> dropdown.
          </p>
        </div>
        <button onClick={newConfig} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>+ New Group By</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* list */}
        <div style={{ width: 300, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No Group By configs yet.</div>
            ) : filtered.map(c => {
              const sel = selected?.GroupByID === c.GroupByID;
              return (
                <div key={c.GroupByID} onClick={() => selectConfig(c)} style={{
                  padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                  background: sel ? 'var(--orange-soft)' : 'transparent',
                  border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent'),
                  opacity: (c.IsActive === 1 || c.IsActive === true) ? 1 : 0.55,
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{c.GroupByName}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{c.QueryName || `query #${c.QueryID}`}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* form */}
        <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!showForm ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Select a config, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? 'New Group By' : `Editing #${form.GroupByID}`}
                </h3>
                {!isNew && (
                  <button onClick={handleDelete} disabled={saving}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✕ Delete</button>
                )}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && <div style={{ background: 'var(--red-soft)', border: '1px solid var(--border)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>}
                {successMsg && <div style={{ background: 'var(--green-soft)', border: '1px solid var(--border)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Group By Name</label>
                    <input type="text" value={form.GroupByName}
                      onChange={e => setForm({ ...form, GroupByName: e.target.value })}
                      placeholder="e.g. Group By Vendor" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Query</label>
                    <select value={form.QueryID} onChange={e => onQueryChange(e.target.value)} style={inputStyle}>
                      <option value="">(pick query)</option>
                      {queries.map(q => <option key={q.QueryID} value={q.QueryID}>{q.QueryName} ({q.QueryType})</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Display Order</label>
                    <input type="number" value={form.DisplayOrder}
                      onChange={e => setForm({ ...form, DisplayOrder: e.target.value })} style={inputStyle} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer', height: 36 }}>
                      <input type="checkbox" checked={form.IsActive}
                        onChange={e => setForm({ ...form, IsActive: e.target.checked })} />
                      Active
                    </label>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle}>Description</label>
                    <input type="text" value={form.Description}
                      onChange={e => setForm({ ...form, Description: e.target.value })} style={inputStyle} />
                  </div>
                </div>

                {!form.QueryID ? (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, border: '1.5px dashed var(--border)', borderRadius: 8 }}>
                    Pick a query to choose group and aggregate fields.
                  </div>
                ) : (
                  <>
                    <label style={labelStyle}>Group Fields</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
                      {queryFields.length === 0 ? (
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>No fields discovered for this query.</span>
                      ) : queryFields.map(name => {
                        const on = groupFields.includes(name);
                        return (
                          <button key={name} type="button" onClick={() => toggleGroupField(name)} style={{
                            fontSize: 11.5, fontWeight: 700, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
                            border: '1px solid ' + (on ? 'var(--orange)' : 'var(--border)'),
                            background: on ? 'var(--orange-soft)' : 'var(--bg)',
                            color: on ? 'var(--orange)' : 'var(--text)',
                          }}>{name}</button>
                        );
                      })}
                    </div>
                    {groupFields.length > 0 && (
                      <p style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 16 }}>
                        Grouping key: {groupFields.join(' + ')}
                      </p>
                    )}

                    <label style={{ ...labelStyle, marginTop: 8 }}>Aggregate Fields</label>
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
                      <thead>
                        <tr>{['Field', 'Operation', 'Display Name', 'Format', ''].map(h => (
                          <th key={h} style={{ fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '0 6px 6px' }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {aggs.length === 0 && (
                          <tr><td colSpan={5} style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>No aggregates.</td></tr>
                        )}
                        {aggs.map((a, i) => (
                          <tr key={i}>
                            <td style={{ padding: '4px 6px', borderTop: '1px solid var(--border)' }}>
                              <select value={a.FieldName} onChange={e => patchAgg(i, { FieldName: e.target.value })} style={{ ...cell, minWidth: 150 }}>
                                <option value="">(pick field)</option>
                                {queryFields.map(f => <option key={f} value={f}>{f}</option>)}
                              </select>
                            </td>
                            <td style={{ padding: '4px 6px', borderTop: '1px solid var(--border)' }}>
                              <select value={a.Operation} onChange={e => patchAgg(i, { Operation: e.target.value })} style={{ ...cell, width: 100 }}>
                                {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                              </select>
                            </td>
                            <td style={{ padding: '4px 6px', borderTop: '1px solid var(--border)' }}>
                              <input value={a.DisplayName} onChange={e => patchAgg(i, { DisplayName: e.target.value })}
                                placeholder={a.FieldName ? `${a.Operation} ${a.FieldName}` : ''} style={{ ...cell, minWidth: 160 }} />
                            </td>
                            <td style={{ padding: '4px 6px', borderTop: '1px solid var(--border)' }}>
                              <select value={a.Format || 'number'} onChange={e => patchAgg(i, { Format: e.target.value })} style={{ ...cell, width: 130 }}>
                                {AGG_FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                              </select>
                            </td>
                            <td style={{ padding: '4px 6px', borderTop: '1px solid var(--border)' }}>
                              <button onClick={() => removeAgg(i)} style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>✕</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button onClick={addAgg} style={{
                      height: 30, padding: '0 12px', background: 'var(--soft)', color: 'var(--text)',
                      border: '1.5px dashed var(--border)', borderRadius: 8, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                    }}>+ Add aggregate</button>
                  </>
                )}
              </div>

              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button onClick={reset} disabled={saving} style={{
                  height: 36, padding: '0 16px', background: 'var(--soft)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{
                  height: 36, padding: '0 24px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
                  color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                }}>{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
