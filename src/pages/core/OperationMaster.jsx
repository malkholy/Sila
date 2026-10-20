import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > Operation Master -- manage [PLS].[V1OperationMaster] rows. Each row
// is a reusable, permissioned action (View Details, Export, Print, Approve...).
// Pages expose an operation via Group & Page Master > Operations; users are
// granted it per page in User Permissions > Operations.
//
// Backend operations (via Pls.APIPlusOperationV1):
//   GetOperationMaster    -> { OperationID, OperationKey, Label, Icon, Description,
//                              BackendOperation, Config, IsActive }
//   SaveOperationMaster   -> upsert (OperationKey unique), returns { OperationID }
//   DeleteOperationMaster -> { OperationID }  (cascades page links + grants)

const EMPTY_FORM = {
  OperationID: null,
  OperationKey: '',
  Label: '',
  Icon: '',
  Description: '',
  BackendOperation: '',
  Config: '',
  IsActive: true,
};

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase',
};

export default function OperationMaster() {
  const [ops, setOps] = useState([]);
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
      const res = await apiCall('GetOperationMaster', {}, {}, 'plus');
      if (res.State === 0) setOps(res.List0 || []);
      else setError(res.Message || 'Failed to load operations');
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return ops;
    const s = search.toLowerCase();
    return ops.filter(o =>
      (o.OperationKey || '').toLowerCase().includes(s) ||
      (o.Label || '').toLowerCase().includes(s));
  }, [ops, search]);

  function handleSelect(o) {
    setSelected(o);
    setIsNew(false);
    setError(null);
    setSuccessMsg(null);
    setFormData({
      OperationID: o.OperationID,
      OperationKey: o.OperationKey || '',
      Label: o.Label || '',
      Icon: o.Icon || '',
      Description: o.Description || '',
      BackendOperation: o.BackendOperation || '',
      Config: o.Config || '',
      IsActive: o.IsActive === 1 || o.IsActive === true,
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
    if (!formData.OperationKey.trim()) { setError('Operation Key is required.'); return; }
    if (!formData.Label.trim()) { setError('Label is required.'); return; }
    if (formData.Config.trim()) {
      try { JSON.parse(formData.Config); }
      catch { setError('Config must be valid JSON (or blank).'); return; }
    }
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('SaveOperationMaster', {
        OperationID: isNew ? null : formData.OperationID,
        OperationKey: formData.OperationKey.trim(),
        Label: formData.Label.trim(),
        Icon: formData.Icon.trim(),
        Description: formData.Description.trim(),
        BackendOperation: formData.BackendOperation.trim(),
        Config: formData.Config.trim() || null,
        IsActive: formData.IsActive ? 1 : 0,
      }, {}, 'plus');

      if (res.State !== 0) {
        setError(res.Message || 'Failed to save');
        setSaving(false);
        return;
      }
      setSuccessMsg('✓ Saved successfully!');
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
    if (!window.confirm(`Delete operation "${selected.Label}"? This also removes every page link and user grant for it.`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiCall('DeleteOperationMaster', { OperationID: selected.OperationID }, {}, 'plus');
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
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Operation Master</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Reusable permissioned actions. Link them to pages in Group &amp; Page Master, grant per user in User Permissions.
          </p>
        </div>
        <button onClick={handleNew} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>+ New Operation</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* List */}
        <div style={{ width: 320, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search operations..." value={search}
              onChange={e => setSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No operations yet.</div>
            ) : filtered.map(o => {
              const sel = selected?.OperationID === o.OperationID;
              return (
                <div key={o.OperationID} onClick={() => handleSelect(o)} style={{
                  padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                  background: sel ? 'var(--orange-soft)' : 'transparent',
                  border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent'),
                  opacity: (o.IsActive === 1 || o.IsActive === true) ? 1 : 0.55,
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                    {o.Icon} {o.Label}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>
                    {o.OperationKey}{o.BackendOperation ? ` • ${o.BackendOperation}` : ''}
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
              Select an operation, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? 'New Operation' : `Editing #${formData.OperationID}`}
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
                    <label style={labelStyle}>Operation Key</label>
                    <input type="text" value={formData.OperationKey}
                      onChange={e => setFormData({ ...formData, OperationKey: e.target.value })}
                      placeholder="e.g. PO_VIEW_DETAILS" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Label</label>
                    <input type="text" value={formData.Label}
                      onChange={e => setFormData({ ...formData, Label: e.target.value })}
                      placeholder="e.g. View Details" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Icon (emoji)</label>
                    <input type="text" value={formData.Icon}
                      onChange={e => setFormData({ ...formData, Icon: e.target.value })}
                      placeholder="🔍" style={{ ...inputStyle, fontSize: 14 }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Backend Operation</label>
                    <input type="text" value={formData.BackendOperation}
                      onChange={e => setFormData({ ...formData, BackendOperation: e.target.value })}
                      placeholder="e.g. View" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Description</label>
                  <input type="text" value={formData.Description}
                    onChange={e => setFormData({ ...formData, Description: e.target.value })}
                    style={inputStyle} />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Config (JSON)</label>
                  <textarea value={formData.Config}
                    onChange={e => setFormData({ ...formData, Config: e.target.value })}
                    placeholder={'{ "KeyField": "OrderNumber" }'}
                    spellCheck={false}
                    style={{ ...inputStyle, height: 120, padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                    Passed to the frontend as-is. Each page can override keys of this object (Group &amp; Page Master → Operations).
                  </p>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={formData.IsActive}
                    onChange={e => setFormData({ ...formData, IsActive: e.target.checked })} />
                  Active
                </label>
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
