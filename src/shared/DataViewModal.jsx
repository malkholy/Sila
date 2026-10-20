import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiCall } from './api.js';

// Data View editor (docs/data-view.md, phase 4). A Data View is a per-user
// presentation config over a Page + Query -- which fields show, their order,
// display name, width and formatting. It never touches rows, SQL or permissions.
//
// 'list' mode: the user's views for this Page+Query (edit / duplicate /
// set-default / delete). 'edit' mode: a two-panel field builder -- all query
// fields on the left, drag onto the right grid to include them (right = shown,
// in order); drag rows to reorder, drag back to the left (or X) to remove.

const FORMAT_OPTS = [
  ['', '(default)'], ['mono', 'Mono'], ['number:0', 'Number'], ['number:2', 'Number (2 dp)'],
  ['date', 'Date'], ['datetime', 'Date + time'], ['yesno', 'Yes / No'],
];
const ALIGN_OPTS = [['', '(auto)'], ['Left', 'Left'], ['Center', 'Center'], ['Right', 'Right']];
const DATEFMT_OPTS = [
  ['', '(none)'], ['dd/MM/yyyy', 'dd/MM/yyyy'], ['MM/dd/yyyy', 'MM/dd/yyyy'],
  ['dd-MMM-yyyy', 'dd-MMM-yyyy'], ['yyyy-MM-dd', 'yyyy-MM-dd'], ['dd/MM/yyyy HH:mm', 'dd/MM/yyyy HH:mm'],
];

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 1300,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
};
const card = {
  width: 'min(1100px, 97vw)', maxHeight: '92vh', background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,.3)',
  display: 'flex', flexDirection: 'column', minHeight: 0,
};
const head = {
  padding: '14px 18px', borderBottom: '1px solid var(--border)',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
};
const footer = {
  padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex',
  justifyContent: 'flex-end', gap: 10, flexShrink: 0, flexWrap: 'wrap',
};
const btn = (kind) => ({
  height: 34, padding: '0 16px', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
  border: kind === 'primary' ? 'none' : '1px solid var(--border)',
  background: kind === 'primary' ? 'linear-gradient(135deg, var(--orange), var(--orange2))'
    : kind === 'danger' ? 'var(--red-soft)' : 'var(--soft)',
  color: kind === 'primary' ? '#fff' : kind === 'danger' ? 'var(--red)' : 'var(--text)',
});
const cell = {
  height: 26, padding: '0 6px', border: '1.5px solid var(--border)', borderRadius: 6,
  fontSize: 11, color: 'var(--text)', background: 'var(--bg)', outline: 'none', width: '100%',
};
const panelHead = { fontSize: 10, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 };

export default function DataViewModal({ open, onClose, pageGroupId, queryId, sysFields = [], onChanged }) {
  const [mode, setMode] = useState('list');
  const [views, setViews] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  // edit-mode state
  const [editId, setEditId] = useState(null);   // DataViewID or null (= new)
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [selected, setSelected] = useState([]); // [{ FieldName, DisplayName, Width, Format, Alignment, DecimalPlaces, DateFormat }]
  const [search, setSearch] = useState('');
  const [dropIdx, setDropIdx] = useState(null); // insert marker in the right grid

  const sysByName = useMemo(() => Object.fromEntries(sysFields.map(f => [f.FieldName, f])), [sysFields]);

  const available = useMemo(() => {
    const taken = new Set(selected.map(s => s.FieldName));
    const s = search.trim().toLowerCase();
    return sysFields
      .filter(f => !taken.has(f.FieldName))
      .filter(f => !s || f.FieldName.toLowerCase().includes(s) || (f.Label || '').toLowerCase().includes(s));
  }, [sysFields, selected, search]);

  const loadViews = useCallback(async () => {
    if (queryId == null) return;
    setLoading(true); setErr(null);
    try {
      const r = await apiCall('GetDataViews', { PageGroupID: pageGroupId, QueryID: queryId }, {}, 'plus');
      setViews(r.State === 0 ? (r.List0 || []) : []);
    } catch (e) { setErr('Connection error: ' + e.message); }
    setLoading(false);
  }, [pageGroupId, queryId]);

  useEffect(() => {
    if (!open) return;
    setMode('list'); setErr(null); setMsg(null);
    loadViews();
  }, [open, loadViews]);

  // a field dragged in starts with the current (System Default Layout) settings
  // from V1QueryFields -- the user can then change any of them.
  const seededField = (fieldName) => {
    const sys = sysByName[fieldName] || {};
    const fmt = sys.Format || '';
    const dp = /^number:(\d+)$/.exec(fmt);
    return {
      FieldName: fieldName,
      DisplayName: sys.Label || fieldName,
      Width: sys.Width || '',
      Format: fmt,
      Alignment: (fmt.startsWith('number') || dp) ? 'Right' : '',
      DecimalPlaces: dp ? Number(dp[1]) : '',
      DateFormat: '',
    };
  };

  async function openEditor(view) {
    setErr(null); setMsg(null); setSearch(''); setDropIdx(null);
    if (!view) {
      setEditId(null); setName(''); setIsDefault(false); setSelected([]);
      setMode('edit');
      return;
    }
    setBusy(true);
    try {
      const r = await apiCall('GetDataView', { DataViewID: view.DataViewID }, {}, 'plus');
      const stored = (r.State === 0 ? (r.List1 || []) : [])
        .filter(s => s.Visible === 1 || s.Visible === true)
        .sort((a, b) => (a.DisplayOrder ?? 1e9) - (b.DisplayOrder ?? 1e9))
        .map(s => ({
          FieldName: s.FieldName,
          DisplayName: s.DisplayName || '',
          Width: s.Width ?? '',
          Format: s.Format || '',
          Alignment: s.Alignment || '',
          DecimalPlaces: s.DecimalPlaces ?? '',
          DateFormat: s.DateFormat || '',
        }))
        .filter(s => sysByName[s.FieldName]);   // drop fields no longer in the query
      setEditId(view.DataViewID);
      setName(view.DataViewName || '');
      setIsDefault(view.IsDefault === 1 || view.IsDefault === true);
      setSelected(stored);
      setMode('edit');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(false);
  }

  const patch = (i, p) => setSelected(fs => fs.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const removeAt = (i) => setSelected(fs => fs.filter((_, j) => j !== i));
  const move = (i, dir) => setSelected(fs => {
    const j = i + dir;
    if (j < 0 || j >= fs.length) return fs;
    const next = fs.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const addField = (fieldName, at) => setSelected(fs => {
    if (fs.some(f => f.FieldName === fieldName)) return fs;
    const next = fs.slice();
    next.splice(at == null || at > next.length ? next.length : at, 0, seededField(fieldName));
    return next;
  });
  const addAllVisible = () => setSelected(fs => {
    const taken = new Set(fs.map(f => f.FieldName));
    const add = sysFields
      .filter(f => !taken.has(f.FieldName) && !(f.Hidden === 1 || f.Hidden === true))
      .map(f => seededField(f.FieldName));
    return [...fs, ...add];
  });

  // --- drag & drop -------------------------------------------------------
  function onDragStartLeft(e, fieldName) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ src: 'left', fieldName }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }
  function onDragStartRight(e, index) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ src: 'right', index }));
    e.dataTransfer.effectAllowed = 'copyMove';
  }
  function readDrag(e) {
    try { return JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return null; }
  }
  function onDropRight(e, at) {
    e.preventDefault();
    setDropIdx(null);
    const d = readDrag(e);
    if (!d) return;
    if (d.src === 'left') { addField(d.fieldName, at); return; }
    if (d.src === 'right' && d.index != null) {
      setSelected(fs => {
        const from = d.index;
        let to = at == null ? fs.length : at;
        if (to > from) to -= 1;
        if (to === from) return fs;
        const next = fs.slice();
        const [item] = next.splice(from, 1);
        next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
        return next;
      });
    }
  }
  function onDropLeft(e) {
    e.preventDefault();
    const d = readDrag(e);
    if (d && d.src === 'right' && d.index != null) removeAt(d.index);
  }

  function buildPayload(forceNew) {
    return {
      DataViewID: forceNew ? null : editId,
      DataViewName: name.trim(),
      PageGroupID: pageGroupId,
      QueryID: queryId,
      IsDefault: isDefault ? 1 : 0,
      Fields: selected.map((f, i) => ({
        FieldName: f.FieldName,
        Visible: 1,
        DisplayOrder: (i + 1) * 10,
        DisplayName: f.DisplayName.trim() || null,
        Width: f.Width === '' ? null : Number(f.Width),
        Format: f.Format || null,
        Alignment: f.Alignment || null,
        DecimalPlaces: f.DecimalPlaces === '' ? null : Number(f.DecimalPlaces),
        DateFormat: f.DateFormat || null,
      })),
    };
  }

  async function save(forceNew) {
    if (!name.trim()) { setErr('View name is required.'); return; }
    if (selected.length === 0) { setErr('Drag at least one field onto the view.'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await apiCall('SaveDataView', buildPayload(forceNew), {}, 'plus');
      if (res.State !== 0) { setErr(res.Message || 'Failed to save'); setBusy(false); return; }
      const savedId = res.List0?.[0]?.DataViewID ?? res.DataViewID;
      await loadViews();
      onChanged?.(savedId ?? null);
      setMode('list');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(false);
  }

  async function remove(view) {
    if (!window.confirm(`Delete Data View "${view.DataViewName}"?`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await apiCall('DeleteDataView', { DataViewID: view.DataViewID }, {}, 'plus');
      if (res.State !== 0) { setErr(res.Message || 'Failed to delete'); setBusy(false); return; }
      await loadViews();
      onChanged?.('__system__');
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(false);
  }

  async function makeDefault(view) {
    setBusy(true); setErr(null);
    try {
      const res = await apiCall('SetDefaultDataView', { DataViewID: view.DataViewID, IsDefault: 1 }, {}, 'plus');
      if (res.State !== 0) { setErr(res.Message || 'Failed'); setBusy(false); return; }
      await loadViews();
      onChanged?.(view.DataViewID);
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusy(false);
  }

  async function duplicate(view) {
    await openEditor(view);
    setEditId(null);
    setName((view.DataViewName || '') + ' copy');
    setIsDefault(false);
  }

  if (!open) return null;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={card} onClick={e => e.stopPropagation()}>
        <div style={head}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
            {mode === 'list' ? 'Data Views' : editId ? 'Edit Data View' : 'New Data View'}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--muted)' }}>X</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: mode === 'list' ? 'auto' : 'hidden', padding: 18, display: 'flex', flexDirection: 'column' }}>
          {err && <div style={{ background: 'var(--red-soft)', border: '1px solid var(--border)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12, flexShrink: 0 }}>{err}</div>}
          {msg && <div style={{ background: 'var(--green-soft)', border: '1px solid var(--border)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12, flexShrink: 0 }}>{msg}</div>}

          {mode === 'list' ? (
            loading ? (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : (
              <>
                <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
                  Your saved column layouts for this page. Presentation only - never changes the data or your permissions.
                </p>
                {views.length === 0 ? (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, border: '1.5px dashed var(--border)', borderRadius: 8 }}>
                    No Data Views yet - the grid shows the system default layout.
                  </div>
                ) : views.map(v => (
                  <div key={v.DataViewID} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    border: '1px solid var(--border)', borderRadius: 10, marginBottom: 8,
                  }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', flex: 1 }}>
                      {v.DataViewName}
                      {(v.IsDefault === 1 || v.IsDefault === true) && (
                        <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 800, color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4 }}>DEFAULT</span>
                      )}
                    </span>
                    <button disabled={busy} onClick={() => openEditor(v)} style={btn()}>Edit</button>
                    <button disabled={busy} onClick={() => duplicate(v)} style={btn()}>Duplicate</button>
                    {!(v.IsDefault === 1 || v.IsDefault === true) && (
                      <button disabled={busy} onClick={() => makeDefault(v)} style={btn()}>Set default</button>
                    )}
                    <button disabled={busy} onClick={() => remove(v)} style={btn('danger')}>Delete</button>
                  </div>
                ))}
              </>
            )
          ) : (
            <>
              <div style={{ display: 'flex', gap: 14, marginBottom: 12, alignItems: 'end', flexShrink: 0, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase' }}>View Name</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Financial view"
                    style={{ ...cell, height: 34, fontSize: 12.5 }} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer', height: 34 }}>
                  <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
                  Set as my default
                </label>
              </div>

              <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12 }}>
                {/* LEFT: available fields */}
                <div
                  onDragOver={e => e.preventDefault()}
                  onDrop={onDropLeft}
                  style={{ width: 240, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--soft)' }}>
                  <div style={panelHead}>All fields ({available.length})</div>
                  <div style={{ padding: 8, flexShrink: 0 }}>
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." style={cell} />
                  </div>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
                    {available.length === 0 ? (
                      <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 11 }}>All fields added.</div>
                    ) : available.map(f => (
                      <div key={f.FieldName}
                        draggable
                        onDragStart={e => onDragStartLeft(e, f.FieldName)}
                        onDoubleClick={() => addField(f.FieldName)}
                        title="Drag onto the view (or double-click)"
                        style={{
                          padding: '7px 9px', marginBottom: 4, borderRadius: 7, cursor: 'grab',
                          background: 'var(--bg)', border: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text)',
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                        <span style={{ color: 'var(--muted)' }}>::</span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.FieldName}</span>
                          {f.Label && f.Label !== f.FieldName && (
                            <span style={{ display: 'block', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.Label}</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding: 8, borderTop: '1px solid var(--border)', flexShrink: 0 }}>
                    <button type="button" onClick={addAllVisible} style={{ ...btn(), height: 28, width: '100%', fontSize: 11 }}>+ Add all visible</button>
                  </div>
                </div>

                {/* RIGHT: chosen fields, ordered */}
                <div
                  onDragOver={e => { e.preventDefault(); if (dropIdx == null) setDropIdx(selected.length); }}
                  onDrop={e => onDropRight(e, dropIdx ?? selected.length)}
                  style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div style={{ ...panelHead, display: 'flex', justifyContent: 'space-between' }}>
                    <span>View columns ({selected.length})</span>
                    <span style={{ fontWeight: 600, textTransform: 'none' }}>drag to add / reorder / drag out to remove</span>
                  </div>
                  <div style={{ flex: 1, overflow: 'auto' }}>
                    {selected.length === 0 ? (
                      <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                        Drag fields here from the left.
                      </div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                        <thead>
                          <tr>{['', 'Field', 'Display name', 'Width', 'Format', 'Align', 'Dec', 'Date fmt', ''].map((h, k) => (
                            <th key={k} style={{ fontSize: 9, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', textAlign: 'left', padding: '6px', position: 'sticky', top: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {selected.map((f, i) => (
                            <tr key={f.FieldName}
                              draggable
                              onDragStart={e => onDragStartRight(e, i)}
                              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropIdx(i); }}
                              onDrop={e => { e.stopPropagation(); onDropRight(e, i); }}
                              style={{ borderTop: dropIdx === i ? '2px solid var(--orange)' : '1px solid var(--border)' }}>
                              <td style={{ padding: '3px 4px', whiteSpace: 'nowrap', cursor: 'grab', color: 'var(--muted)' }}>
                                ::
                                <button onClick={() => move(i, -1)} disabled={i === 0} style={{ ...btn(), height: 20, padding: '0 4px', fontSize: 9, marginLeft: 3 }}>^</button>
                                <button onClick={() => move(i, 1)} disabled={i === selected.length - 1} style={{ ...btn(), height: 20, padding: '0 4px', fontSize: 9, marginLeft: 2 }}>v</button>
                              </td>
                              <td style={{ padding: '3px 6px', fontSize: 11.5, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>{f.FieldName}</td>
                              <td style={{ padding: '3px 6px' }}><input value={f.DisplayName} onChange={e => patch(i, { DisplayName: e.target.value })} style={{ ...cell, minWidth: 120 }} /></td>
                              <td style={{ padding: '3px 6px' }}><input type="number" value={f.Width} onChange={e => patch(i, { Width: e.target.value })} style={{ ...cell, width: 58 }} /></td>
                              <td style={{ padding: '3px 6px' }}>
                                <select value={f.Format} onChange={e => patch(i, { Format: e.target.value })} style={{ ...cell, width: 118 }}>
                                  {FORMAT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: '3px 6px' }}>
                                <select value={f.Alignment} onChange={e => patch(i, { Alignment: e.target.value })} style={{ ...cell, width: 86 }}>
                                  {ALIGN_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: '3px 6px' }}><input type="number" min="0" max="6" value={f.DecimalPlaces} onChange={e => patch(i, { DecimalPlaces: e.target.value })} style={{ ...cell, width: 44 }} /></td>
                              <td style={{ padding: '3px 6px' }}>
                                <select value={f.DateFormat} onChange={e => patch(i, { DateFormat: e.target.value })} style={{ ...cell, width: 126 }}>
                                  {DATEFMT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: '3px 6px' }}>
                                <button onClick={() => removeAt(i)} title="Remove" style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>X</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div style={footer}>
          {mode === 'list' ? (
            <>
              <button onClick={onClose} style={btn()}>Close</button>
              <button onClick={() => openEditor(null)} disabled={busy || sysFields.length === 0} style={btn('primary')}>+ New view</button>
            </>
          ) : (
            <>
              <button onClick={() => setMode('list')} disabled={busy} style={btn()}>Back</button>
              <button onClick={() => save(true)} disabled={busy} style={btn()}>Save as new</button>
              {editId
                ? <button onClick={() => save(false)} disabled={busy} style={btn('primary')}>{busy ? 'Saving...' : 'Save'}</button>
                : <button onClick={() => save(true)} disabled={busy} style={btn('primary')}>{busy ? 'Saving...' : 'Create'}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
