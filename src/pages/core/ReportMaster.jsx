import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > Report Master -- manage [PLS].[V1ReportMaster]. Every printed
// report is registered here first, then linked to a Form/Grid in Group & Page
// Master > Reports, and granted per user in User Permissions > Reports.
//
// Backend (via Pls.APIPlusOperationV1):
//   GetReportMaster    -> rows (+ DataQueryName)
//   SaveReportMaster   -> upsert (ReportCode unique, ReportType React|Fast)
//   DeleteReportMaster -> cascades links + grants

const EMPTY = {
  ReportID: null, ReportName: '', ReportCode: '', ReportType: 'React',
  Description: '', DataQueryID: '', DetailQueryIDs: '', LayoutConfig: '',
  ParamConfig: '', IsActive: true,
};

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none',
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase',
};
const areaStyle = { ...inputStyle, height: 120, padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 };

export default function ReportMaster() {
  const [reports, setReports] = useState([]);
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [search, setSearch] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [r, q] = await Promise.all([
        apiCall('GetReportMaster', {}, {}, 'plus'),
        apiCall('GetQueryMaster', {}, {}, 'plus'),
      ]);
      if (r.State === 0) setReports(r.List0 || []);
      else setError(r.Message || 'Failed to load reports');
      if (q.State === 0) {
        // GetQueryMaster returns one row per (query, page) mapping -- dedupe
        const seen = new Set();
        const list = [];
        (q.List0 || []).forEach(x => { if (!seen.has(x.QueryID)) { seen.add(x.QueryID); list.push(x); } });
        setQueries(list);
      }
    } catch (e) { setError('Connection error: ' + e.message); }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return reports;
    const s = search.toLowerCase();
    return reports.filter(r =>
      (r.ReportCode || '').toLowerCase().includes(s) || (r.ReportName || '').toLowerCase().includes(s));
  }, [reports, search]);

  function pick(r) {
    setSelected(r); setIsNew(false); setError(null); setSuccessMsg(null);
    setForm({
      ReportID: r.ReportID,
      ReportName: r.ReportName || '',
      ReportCode: r.ReportCode || '',
      ReportType: r.ReportType || 'React',
      Description: r.Description || '',
      DataQueryID: r.DataQueryID != null ? String(r.DataQueryID) : '',
      DetailQueryIDs: Array.isArray(safeJson(r.DetailQueryIDs)) ? safeJson(r.DetailQueryIDs).join(', ') : '',
      LayoutConfig: pretty(r.LayoutConfig),
      ParamConfig: pretty(r.ParamConfig),
      IsActive: r.IsActive === 1 || r.IsActive === true,
    });
  }
  function fresh() { setSelected(null); setIsNew(true); setError(null); setSuccessMsg(null); setForm(EMPTY); }
  function reset() { setSelected(null); setIsNew(false); setForm(EMPTY); setError(null); setSuccessMsg(null); }

  async function save() {
    if (!form.ReportName.trim()) return setError('Report Name is required.');
    if (!form.ReportCode.trim()) return setError('Report Code is required.');
    const detailIds = form.DetailQueryIDs.split(',').map(s => s.trim()).filter(Boolean).map(Number).filter(n => Number.isInteger(n));
    let layout = null, params = null;
    if (form.LayoutConfig.trim()) { try { layout = JSON.parse(form.LayoutConfig); } catch { return setError('Layout Config must be valid JSON (or blank).'); } }
    if (form.ParamConfig.trim()) { try { params = JSON.parse(form.ParamConfig); } catch { return setError('Param Config must be valid JSON (or blank).'); } }

    setSaving(true); setError(null); setSuccessMsg(null);
    try {
      const res = await apiCall('SaveReportMaster', {
        ReportID: isNew ? null : form.ReportID,
        ReportName: form.ReportName.trim(),
        ReportCode: form.ReportCode.trim(),
        ReportType: form.ReportType,
        Description: form.Description.trim(),
        DataQueryID: form.DataQueryID ? Number(form.DataQueryID) : null,
        DetailQueryIDs: detailIds.length ? detailIds : null,
        LayoutConfig: layout,
        ParamConfig: params,
        IsActive: form.IsActive ? 1 : 0,
      }, {}, 'plus');
      if (res.State !== 0) { setError(res.Message || 'Failed to save'); setSaving(false); return; }
      setSuccessMsg('✓ Saved.');
      setIsNew(false);
      await load();
      if (isNew) reset();
    } catch (e) { setError('Save connection error: ' + e.message); }
    setSaving(false);
  }

  async function remove() {
    if (!selected) return;
    if (!window.confirm(`Delete report "${selected.ReportName}"? This also removes every Form/Grid link and user grant for it.`)) return;
    setSaving(true); setError(null);
    try {
      const res = await apiCall('DeleteReportMaster', { ReportID: selected.ReportID }, {}, 'plus');
      if (res.State === 0) { setSuccessMsg('✓ Deleted.'); reset(); await load(); }
      else setError(res.Message || 'Failed to delete');
    } catch (e) { setError('Delete connection error: ' + e.message); }
    setSaving(false);
  }

  const showForm = isNew || !!selected;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Report Master</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Every printed report. Link to a Form/Grid in Group &amp; Page Master → Reports; grant per user in User Permissions → Reports.
          </p>
        </div>
        <button onClick={fresh} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>+ New Report</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        <div style={{ width: 320, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search reports..." value={search} onChange={e => setSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
              : filtered.length === 0 ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No reports yet.</div>
              : filtered.map(r => {
                const sel = selected?.ReportID === r.ReportID;
                return (
                  <div key={r.ReportID} onClick={() => pick(r)} style={{
                    padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                    background: sel ? 'var(--orange-soft)' : 'transparent',
                    border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent'),
                    opacity: (r.IsActive === 1 || r.IsActive === true) ? 1 : 0.55,
                  }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{r.ReportName}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>
                      {r.ReportCode} • {r.ReportType}{r.DataQueryName ? ` • ${r.DataQueryName}` : ''}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!showForm ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Select a report, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>{isNew ? 'New Report' : `Editing #${form.ReportID}`}</h3>
                {!isNew && <button onClick={remove} disabled={saving} style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✕ Delete</button>}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>}
                {successMsg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Report Name</label>
                    <input type="text" value={form.ReportName} onChange={e => setForm({ ...form, ReportName: e.target.value })}
                      placeholder="e.g. Purchase Order Print" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Report Code</label>
                    <input type="text" value={form.ReportCode} onChange={e => setForm({ ...form, ReportCode: e.target.value })}
                      placeholder="e.g. PO_PRINT" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Report Type</label>
                    <select value={form.ReportType} onChange={e => setForm({ ...form, ReportType: e.target.value })} style={inputStyle}>
                      <option value="React">React Report</option>
                      <option value="Fast">Fast Report (legacy)</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Data Source (Query Master)</label>
                    <select value={form.DataQueryID} onChange={e => setForm({ ...form, DataQueryID: e.target.value })} style={inputStyle}>
                      <option value="">— none —</option>
                      {queries.map(q => <option key={q.QueryID} value={q.QueryID}>{q.QueryName} (#{q.QueryID}, {q.QueryType})</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Description</label>
                  <input type="text" value={form.Description} onChange={e => setForm({ ...form, Description: e.target.value })} style={inputStyle} />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Detail Query IDs (comma-separated)</label>
                  <input type="text" value={form.DetailQueryIDs} onChange={e => setForm({ ...form, DetailQueryIDs: e.target.value })}
                    placeholder="e.g. 4, 7" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>Extra datasets (order lines, charges…). Each must be a page-linked query; the client fetches them via View / GetGridData.</p>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Param Config (JSON)</label>
                  <textarea value={form.ParamConfig} onChange={e => setForm({ ...form, ParamConfig: e.target.value })} spellCheck={false}
                    placeholder={'[{ "Name": "PurchaseOrderNumber", "Field": "PurchaseOrderNumber", "Type": "number", "Source": "record", "Required": true }]'}
                    style={areaStyle} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>Each param maps to a data-query field; GetReportData validates it against V1QueryFields and applies it server-side.</p>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Layout Config (JSON)</label>
                  <textarea value={form.LayoutConfig} onChange={e => setForm({ ...form, LayoutConfig: e.target.value })} spellCheck={false}
                    placeholder={'{ "title": "Purchase Order", "pageSize": "A4", "orientation": "portrait", "columns": [ ... ] }'}
                    style={{ ...areaStyle, height: 200 }} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>The React Report design (header/footer, columns, totals, page setup). Stored as-is; the report renderer reads it.</p>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.IsActive} onChange={e => setForm({ ...form, IsActive: e.target.checked })} />
                  Active
                </label>
              </div>

              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button onClick={reset} disabled={saving} style={{ height: 36, padding: '0 16px', background: 'var(--soft)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
                <button onClick={save} disabled={saving} style={{ height: 36, padding: '0 24px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function pretty(s) { const j = safeJson(s); return j != null ? JSON.stringify(j, null, 2) : (s || ''); }
