import { useState, useEffect, useMemo } from 'react';
import { apiCall } from './api.js';
import DataGrid from './DataGrid.jsx';

// One reusable page for every simple, flat, single-table CRUD page registered
// via PageBuilder.jsx's "Simple CRUD" mode. It reads its own column/field
// config from PLS.CrudTableMaster/PLS.CrudFieldMappings at runtime (GetCrudMetadata),
// so adding a new simple master-data page never needs a new React file --
// just a nav.js entry + an App.jsx PAGE_COMPONENTS mapping pointing here.
export default function GenericMasterPage({ user, def }) {
  const pageGroupId = def?.id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tableMeta, setTableMeta] = useState(null);
  const [fields, setFields] = useState([]);
  const [rows, setRows] = useState([]);
  const [drawer, setDrawer] = useState(null); // null | { isNew: true } | rowData
  const [searchTerm, setSearchTerm] = useState('');

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [metaRes, dataRes] = await Promise.all([
        apiCall('GetCrudMetadata', { PageGroupID: pageGroupId }, {}, 'plus'),
        apiCall('GetGridData', { PageGroupID: pageGroupId }, {}, 'plus')
      ]);
      if (metaRes.State === 0) {
        setTableMeta((metaRes.List0 || [])[0] || null);
        setFields(metaRes.List1 || []);
      } else {
        setError(metaRes.Message || 'This page is not configured for CRUD yet.');
      }
      if (dataRes.State === 0) {
        setRows(dataRes.List0 || []);
      } else if (metaRes.State === 0) {
        setError(dataRes.Message || 'Failed to load records.');
      }
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (pageGroupId) loadAll();
  }, [pageGroupId]);

  // Grid columns follow the view's actual columns, ordered by each field's
  // registered SortOrder -- a metadata-driven substitute for hand curation.
  const columns = useMemo(() => {
    const fieldByCol = Object.fromEntries(fields.map(f => [f.ColumnName, f]));
    const keys = rows.length ? Object.keys(rows[0]) : fields.map(f => f.ColumnName);
    return keys
      .slice()
      .sort((a, b) => (fieldByCol[a]?.SortOrder ?? 999) - (fieldByCol[b]?.SortOrder ?? 999))
      .map(k => ({
        key: k,
        label: fieldByCol[k]?.Label || k,
        numeric: fieldByCol[k]?.DataType === 'number',
        render: fieldByCol[k]?.DataType === 'bool' ? (v => (v ? '✓' : '')) : undefined
      }));
  }, [rows, fields]);

  const filteredRows = useMemo(() => {
    if (!searchTerm) return rows;
    const lower = searchTerm.toLowerCase();
    return rows.filter(row =>
      Object.values(row).some(val => String(val).toLowerCase().includes(lower))
    );
  }, [rows, searchTerm]);

  async function handleDelete(rowsToDelete) {
    const row = rowsToDelete[0];
    const keyField = fields.find(f => f.IsKey);
    if (!keyField) return;
    if (!window.confirm('Are you sure you want to delete this record?')) return;
    setError(null);
    try {
      const res = await apiCall('GenericRecordDelete', {
        PageGroupID: pageGroupId,
        [keyField.JsonKey]: row[keyField.ColumnName]
      }, {}, 'plus');
      if (res.State === 0) {
        await loadAll();
      } else {
        setError(res.Message || 'Failed to delete');
      }
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
  }

  if (!loading && error && !tableMeta) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', gap: 8, textAlign: 'center' }}>
        <span style={{ fontSize: 32 }}>⚠️</span>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{def?.label || 'This page'} isn't configured for CRUD yet</div>
        <div style={{ fontSize: 12.5 }}>{error}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>{def?.icon} {def?.label}</h2>
          {def?.desc && <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{def.desc}</p>}
        </div>
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            padding: '10px 16px',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--text)',
            width: '250px'
          }}
        />
      </div>

      {error && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <DataGrid
          title={def?.label || 'Records'}
          columns={columns}
          rows={filteredRows}
          loading={loading}
          hideSearch
          onAdd={() => setDrawer({ isNew: true })}
          onEdit={(row) => setDrawer(row)}
          onDelete={handleDelete}
          onRefresh={loadAll}
        />
      </div>

      {drawer && (
        <GenericMasterDrawer
          pageGroupId={pageGroupId}
          fields={fields}
          editRow={drawer.isNew ? null : drawer}
          onClose={() => setDrawer(null)}
          onSaveSuccess={loadAll}
        />
      )}
    </div>
  );
}

function GenericMasterDrawer({ pageGroupId, fields, editRow, onClose, onSaveSuccess }) {
  const isNew = !editRow;

  const [formData, setFormData] = useState(() => {
    const init = {};
    fields.forEach(f => {
      init[f.JsonKey] = editRow ? (editRow[f.ColumnName] ?? '') : (f.DataType === 'bool' ? false : '');
    });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    for (const f of fields) {
      if (f.IsRequired) {
        const v = formData[f.JsonKey];
        if (v === '' || v === null || v === undefined) {
          setError(`${f.Label} is required.`);
          return;
        }
      }
    }

    setSaving(true);
    setError(null);
    try {
      const res = await apiCall('GenericRecordSave', { PageGroupID: pageGroupId, ...formData }, {}, 'plus');
      if (res.State === 0) {
        onSaveSuccess();
        onClose();
      } else {
        setError(res.Message || 'Failed to save');
      }
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setSaving(false);
  }

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.3)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ width: 480, background: 'var(--bg)', height: '100%', display: 'flex', flexDirection: 'column', boxShadow: '-5px 0 25px rgba(0,0,0,0.15)' }}>
        <div style={{ padding: '20px 24px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>{isNew ? 'New Record' : 'Edit Record'}</h2>
          <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--soft)', color: 'var(--text)', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5 }}>
              {error}
            </div>
          )}

          {fields.map(f => {
            // Identity keys don't exist yet on Add -- no input to show at all.
            if (f.IsKey && f.IsIdentity && isNew) return null;
            // Key fields (identity or not) are locked once a record exists.
            const disabled = f.IsKey && !isNew;

            return (
              <div key={f.JsonKey}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                  {f.Label}{f.IsRequired ? ' *' : ''}
                </label>
                {f.DataType === 'bool' ? (
                  <input
                    type="checkbox"
                    checked={!!formData[f.JsonKey]}
                    disabled={disabled}
                    onChange={e => setFormData({ ...formData, [f.JsonKey]: e.target.checked })}
                    style={{ width: 18, height: 18 }}
                  />
                ) : (
                  <input
                    type={f.DataType === 'date' ? 'date' : 'text'}
                    inputMode={f.DataType === 'number' ? 'decimal' : undefined}
                    value={formData[f.JsonKey] ?? ''}
                    disabled={disabled}
                    onChange={e => setFormData({ ...formData, [f.JsonKey]: e.target.value })}
                    style={{
                      width: '100%', height: 38, padding: '0 12px', border: '1.5px solid var(--border)', borderRadius: 8,
                      fontSize: 12.5, color: 'var(--text)', background: disabled ? 'var(--soft)' : 'var(--surface)', outline: 'none'
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ height: 36, padding: '0 16px', background: 'var(--soft)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              height: 36, padding: '0 24px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
              color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
              boxShadow: '0 4px 12px var(--orange-glow)'
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
