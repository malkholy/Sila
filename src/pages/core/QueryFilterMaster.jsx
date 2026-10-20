import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > Query Filter -- manage [PLS].[V1QueryFilter] rows. Each row is a
// named filter backed by a "QF..." view built from a SELECT statement; the
// views are consumed later by the grid Filter Panels.
//
// Backend operations (via Pls.APIPlusOperationV1):
//   GetQueryFilter    -> { QueryFilterID, FilterName, ViewName, SourceSQL,
//                          ValueField, LabelField, Description }
//   SaveQueryFilter   -> upsert; (re)creates [PLS].[QF<Name>], returns { QueryFilterID, ViewName }
//   DeleteQueryFilter -> { QueryFilterID }  (also drops the view)

const EMPTY_FORM = {
  QueryFilterID: null,
  FilterName: '',
  Description: '',
  ValueField: '',
  LabelField: '',
  ExtraField1: '',
  ExtraField2: '',
  OrderBy: '',
  CacheSeconds: '',
  SourceSQL: '',
};

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase',
};

export default function QueryFilterMaster() {
  const [filters, setFilters] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [search, setSearch] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiCall('GetQueryFilter', {}, {}, 'plus');
      if (res.State === 0) setFilters(res.List0 || []);
      else setError(res.Message || 'Failed to load query filters');
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return filters;
    const s = search.toLowerCase();
    return filters.filter(f =>
      (f.FilterName || '').toLowerCase().includes(s) ||
      (f.ViewName || '').toLowerCase().includes(s));
  }, [filters, search]);

  function handleSelect(f) {
    setSelected(f);
    setIsNew(false);
    setError(null);
    setSuccessMsg(null);
    setFormData({
      QueryFilterID: f.QueryFilterID,
      FilterName: f.FilterName || '',
      Description: f.Description || '',
      ValueField: f.ValueField || '',
      LabelField: f.LabelField || '',
      ExtraField1: f.ExtraField1 || '',
      ExtraField2: f.ExtraField2 || '',
      OrderBy: f.OrderBy || '',
      CacheSeconds: f.CacheSeconds == null ? '' : String(f.CacheSeconds),
      SourceSQL: f.SourceSQL || '',
    });
  }

  function handleNew() {
    setSelected(null);
    setIsNew(true);
    setError(null);
    setSuccessMsg(null);
    setFormData(EMPTY_FORM);
  }

  function resetForm() {
    setSelected(null);
    setIsNew(false);
    setFormData(EMPTY_FORM);
    setError(null);
    setSuccessMsg(null);
  }

  async function handleSave() {
    if (!formData.FilterName.trim()) { setError('Filter Name is required.'); return; }
    if (!formData.SourceSQL.trim()) { setError('Select statement is required.'); return; }
    if (!formData.ValueField.trim()) { setError('Field Value is required.'); return; }
    if (!formData.LabelField.trim()) { setError('Field Description is required.'); return; }
    const cacheTxt = String(formData.CacheSeconds ?? '').trim();
    if (cacheTxt !== '' && !(/^\d+$/.test(cacheTxt))) { setError('Cache (seconds) must be a whole number of 0 or more, or blank for the default.'); return; }
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('SaveQueryFilter', {
        QueryFilterID: isNew ? null : formData.QueryFilterID,
        FilterName: formData.FilterName.trim(),
        Description: formData.Description.trim(),
        ValueField: formData.ValueField.trim(),
        LabelField: formData.LabelField.trim(),
        ExtraField1: formData.ExtraField1.trim() || null,
        ExtraField2: formData.ExtraField2.trim() || null,
        OrderBy: formData.OrderBy.trim(),
        CacheSeconds: cacheTxt === '' ? null : Number(cacheTxt),
        SourceSQL: formData.SourceSQL,
      }, {}, 'plus');

      if (res.State !== 0) {
        setError(res.Message || 'Failed to save');
        setSaving(false);
        return;
      }
      const viewName = res.List0?.[0]?.ViewName ?? res.ViewName;
      setSuccessMsg(viewName ? `✓ Saved — view [PLS].[${viewName}] created` : '✓ Saved successfully!');
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
    if (!window.confirm(`Delete filter "${selected.FilterName}" and drop its view?`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiCall('DeleteQueryFilter', { QueryFilterID: selected.QueryFilterID }, {}, 'plus');
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
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Query Filter</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Named filter sources. Each one builds a <code>QF…</code> view from a SELECT, used by grid Filter Panels.
          </p>
        </div>
        <button onClick={handleNew} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>+ New Filter</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* List */}
        <div style={{ width: 320, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search filters..." value={search}
              onChange={e => setSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No filters yet.</div>
            ) : filtered.map(f => {
              const sel = selected?.QueryFilterID === f.QueryFilterID;
              return (
                <div key={f.QueryFilterID} onClick={() => handleSelect(f)} style={{
                  padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                  background: sel ? 'var(--orange-soft)' : 'transparent',
                  border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent'),
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{f.FilterName}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>
                    #{f.QueryFilterID} • {f.ViewName || 'no view'}
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
              Select a filter, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? 'New Filter' : `Editing #${formData.QueryFilterID}`}
                </h3>
                {!isNew && (
                  <button onClick={handleDelete} disabled={saving}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✕ Delete</button>
                )}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>}
                {successMsg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Filter Name</label>
                    <input type="text" value={formData.FilterName}
                      onChange={e => setFormData({ ...formData, FilterName: e.target.value })}
                      placeholder="e.g. Vendor Categories" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>View Name</label>
                    <input type="text" readOnly
                      value={selected?.ViewName || (formData.FilterName ? 'QF' + formData.FilterName.replace(/[^A-Za-z0-9]/g, '') : '')}
                      style={{ ...inputStyle, fontFamily: 'monospace', color: 'var(--muted)', background: 'var(--soft)' }} />
                  </div>
                  <div style={{ gridColumn: '1 / -1', fontSize: 10.5, color: 'var(--muted)' }}>
                    A lookup shows <b>2–4 fixed fields</b> — no more. Position 1 is the value returned,
                    position 2 is the bold description line, positions 3–4 (optional) form the muted second line.
                  </div>
                  <div>
                    <label style={labelStyle}>1 · Field Value *</label>
                    <input type="text" value={formData.ValueField}
                      onChange={e => setFormData({ ...formData, ValueField: e.target.value })}
                      placeholder="e.g. ItemCode, VendorNumber" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>2 · Field Description *</label>
                    <input type="text" value={formData.LabelField}
                      onChange={e => setFormData({ ...formData, LabelField: e.target.value })}
                      placeholder="e.g. ItemDescription, VendorName" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>3 · Additional Field 1</label>
                    <input type="text" value={formData.ExtraField1}
                      onChange={e => setFormData({ ...formData, ExtraField1: e.target.value })}
                      placeholder="optional — e.g. ItemType" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>4 · Additional Field 2</label>
                    <input type="text" value={formData.ExtraField2}
                      onChange={e => setFormData({ ...formData, ExtraField2: e.target.value })}
                      placeholder="optional" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle}>Order By</label>
                    <input type="text" value={formData.OrderBy}
                      onChange={e => setFormData({ ...formData, OrderBy: e.target.value })}
                      placeholder="e.g. VendorName, or VendorNumber DESC" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                    <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                      ORDER BY applied to the options list. Blank = order by the label.
                    </p>
                  </div>
                  <div>
                    <label style={labelStyle}>Cache (seconds)</label>
                    <input type="number" min="0" step="1" value={formData.CacheSeconds}
                      onChange={e => setFormData({ ...formData, CacheSeconds: e.target.value })}
                      placeholder="blank = 600 (10 min)" style={inputStyle} />
                    <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                      How long a user's browser reuses this list before refreshing it in the background.
                      0 = refresh on every open (fast-changing lists); e.g. 86400 for lists that almost never change.
                    </p>
                  </div>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Description</label>
                  <input type="text" value={formData.Description}
                    onChange={e => setFormData({ ...formData, Description: e.target.value })}
                    style={inputStyle} />
                </div>

                <div>
                  <label style={labelStyle}>Select Statement</label>
                  <textarea value={formData.SourceSQL}
                    onChange={e => setFormData({ ...formData, SourceSQL: e.target.value })}
                    placeholder="SELECT CategoryID, CategoryName FROM ..."
                    spellCheck={false}
                    style={{ ...inputStyle, height: 220, padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                    On save this becomes <code>CREATE OR ALTER VIEW [PLS].[QF…] AS &lt;your SELECT&gt;</code>.
                  </p>
                </div>
              </div>

              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button onClick={resetForm} disabled={saving} style={{
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
