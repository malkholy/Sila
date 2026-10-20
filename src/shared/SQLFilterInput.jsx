import { useState, useEffect } from 'react';
import { apiCall } from './api.js';

// Row-level query filter editor (builder or raw SQL) for a single
// (User, Query) pair -- shared by UserPermissions.jsx (nested under each
// page's queries) and LookupPermissions.jsx (a dedicated 3-panel screen for
// Lookup-type queries specifically, including ones not linked to any page).
export default function SQLFilterInput({ query, qPerm, onSave, isLoading, manualSave = false }) {
  const [mode, setMode] = useState('sql');
  const [builder, setBuilder] = useState([]);
  const [text, setText] = useState('');
  const [denyAll, setDenyAll] = useState(false);

  const [fields, setFields] = useState([]);
  const [loadingFields, setLoadingFields] = useState(false);

  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [ac, setAc] = useState(null); // autocomplete { items, hl }

  const OPS = ["=", "<>", ">", ">=", "<", "<=", "LIKE", "IN", "IS NULL", "IS NOT NULL"];
  const VARS = ["@UserID", "@Username"];

  // Inject styles dynamically once
  useEffect(() => {
    const sId = "up-filter-styles";
    if (!document.getElementById(sId)) {
      const el = document.createElement("style");
      el.id = sId;
      el.textContent = `
        .up-filter-wrap {
          margin-top: 10px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .up-mt {
          display: inline-flex;
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
          margin-bottom: 8px;
          align-self: flex-start;
        }
        .up-mt button {
          height: 28px;
          padding: 0 12px;
          border: 0;
          background: var(--surface);
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          color: var(--muted);
          font-family: var(--font);
          transition: all 0.15s;
        }
        .up-mt button.active {
          background: var(--orange);
          color: #fff;
        }
        .up-cr {
          display: grid;
          grid-template-columns: 80px 1.2fr 80px 1.5fr 28px;
          gap: 6px;
          align-items: center;
          margin-bottom: 6px;
        }
        .up-cr.first {
          grid-template-columns: 1.2fr 80px 1.5fr 28px;
        }
        .up-cr select, .up-cr input {
          height: 30px;
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 0 7px;
          font-size: 12px;
          background: var(--surface);
          color: var(--text);
          outline: none;
          width: 100%;
          font-family: var(--font);
        }
        .up-cr select:focus, .up-cr input:focus {
          border-color: var(--orange);
        }
        .up-cr .conj {
          color: var(--orange);
          font-weight: 800;
        }
        .up-cr .del {
          height: 28px;
          width: 28px;
          border: 0;
          border-radius: 6px;
          background: var(--red-soft);
          color: var(--red);
          cursor: pointer;
          font-weight: 800;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .up-cr .del:hover {
          background: var(--red);
          color: #fff;
        }
        .up-addc {
          height: 28px;
          border: 1.5px dashed var(--border);
          border-radius: 6px;
          background: var(--soft);
          color: var(--muted);
          font-weight: 700;
          font-size: 11.5px;
          cursor: pointer;
          width: 100%;
          transition: all 0.15s;
          font-family: var(--font);
          margin-bottom: 8px;
        }
        .up-addc:hover {
          border-color: var(--orange);
          color: var(--orange);
          background: var(--surface);
        }
        .up-pre {
          font-family: var(--mono);
          font-size: 11px;
          color: var(--muted);
          background: var(--soft);
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px solid var(--border);
          word-break: break-all;
        }
        .up-pre b {
          color: var(--orange);
        }
        .up-ac {
          position: absolute;
          background: var(--surface);
          border: 1px solid var(--orange);
          border-radius: 8px;
          box-shadow: var(--shadow-lg);
          z-index: 99;
          max-height: 150px;
          overflow-y: auto;
          min-width: 180px;
          padding: 4px 0;
        }
        .up-ai {
          padding: 6px 12px;
          font-size: 11px;
          font-family: var(--mono);
          cursor: pointer;
          color: var(--text);
          transition: all 0.1s;
        }
        .up-ai:hover, .up-ai.hl {
          background: var(--orange-soft);
          color: var(--orange);
        }
        .up-val {
          margin-top: 6px;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .up-val.ok {
          background: var(--green-soft);
          color: var(--green);
          border: 1px solid rgba(22, 163, 74, 0.15);
        }
        .up-val.err {
          background: var(--red-soft);
          color: var(--red);
          border: 1px solid rgba(220, 38, 38, 0.15);
        }
        .up-sw {
          position: relative;
          display: flex;
          flex-direction: column;
        }
      `;
      document.head.appendChild(el);
    }
  }, []);

  // Sync state with qPerm
  useEffect(() => {
    if (qPerm) {
      setDenyAll(qPerm.CondMode === 'deny');
      setMode(qPerm.CondMode === 'deny' ? 'sql' : (qPerm.CondMode || 'sql'));
      setText(qPerm.CondMode === 'deny' ? '' : (qPerm.SQLFilter || ''));

      let parsedBuilder = [];
      if (qPerm.CondMode !== 'deny' && qPerm.CondBuilder) {
        try {
          parsedBuilder = JSON.parse(qPerm.CondBuilder);
        } catch (e) {
          parsedBuilder = [];
        }
      }
      setBuilder(parsedBuilder);
    } else {
      setDenyAll(false);
      setMode('sql');
      setText('');
      setBuilder([]);
    }
    setValidation(null);
  }, [qPerm]);

  // Load fields for builder and autocomplete suggestions
  useEffect(() => {
    if (query?.QueryID) {
      loadFields();
    }
  }, [query?.QueryID]);

  async function loadFields() {
    setLoadingFields(true);
    try {
      const res = await apiCall('GetQueryFields', { QueryID: query.QueryID }, {}, 'plus');
      if (res.State === 0) {
        setFields((res.List0 || []).map(f => f.FieldName));
      }
    } catch (e) {
      console.error('Failed to load query fields:', e);
    }
    setLoadingFields(false);
  }

  function buildSqlText(rows) {
    return rows.map((r, i) => {
      const conj = i > 0 ? ` ${(r.conj || 'AND')} ` : '';
      let valPart = '';
      if (r.op && !r.op.includes('NULL')) {
        const val = r.val || '';
        valPart = ` ${val.startsWith('@') ? val : `'${val}'`}`;
      }
      return `${conj}${r.field} ${r.op}${valPart}`;
    }).join(' ').trim();
  }

  function savePermission(finalText, finalMode, finalBuilder) {
    // In manualSave mode, every handler below already updated its own local
    // state (text/mode/builder) before calling this -- persisting only
    // happens when the user clicks the Save button (see handleManualSave).
    if (manualSave) return;
    onSave(finalText, finalMode, JSON.stringify(finalBuilder));
  }

  function handleManualSave() {
    if (denyAll) {
      onSave('1=0', 'deny', JSON.stringify(builder));
      return;
    }
    const finalText = mode === 'builder' ? buildSqlText(builder) : text;
    onSave(finalText, mode, JSON.stringify(builder));
  }

  function handleToggleDenyAll(checked) {
    setDenyAll(checked);
    if (checked) {
      savePermission('1=0', 'deny', builder);
    } else {
      const restoredText = mode === 'builder' ? buildSqlText(builder) : text;
      savePermission(restoredText, mode, builder);
    }
  }

  function handleConjChange(idx, conj) {
    const updated = [...builder];
    updated[idx] = { ...updated[idx], conj };
    setBuilder(updated);
    const sql = buildSqlText(updated);
    savePermission(sql, 'builder', updated);
  }

  function handleFieldChange(idx, field) {
    const updated = [...builder];
    updated[idx] = { ...updated[idx], field };
    setBuilder(updated);
    const sql = buildSqlText(updated);
    savePermission(sql, 'builder', updated);
  }

  function handleOpChange(idx, op) {
    const updated = [...builder];
    updated[idx] = { ...updated[idx], op };
    if (op.includes('NULL')) {
      updated[idx].val = '';
    }
    setBuilder(updated);
    const sql = buildSqlText(updated);
    savePermission(sql, 'builder', updated);
  }

  function handleValueChange(idx, val) {
    const updated = [...builder];
    updated[idx] = { ...updated[idx], val };
    setBuilder(updated);
  }

  // Auto-save on blur of a text input value in a builder row
  function handleValueBlur(idx) {
    const sql = buildSqlText(builder);
    savePermission(sql, 'builder', builder);
  }

  function handleAddRow() {
    const defaultField = fields[0] || '';
    const updated = [...builder, { field: defaultField, op: '=', val: '', conj: 'AND' }];
    setBuilder(updated);
    const sql = buildSqlText(updated);
    savePermission(sql, 'builder', updated);
  }

  function handleDelRow(idx) {
    const updated = builder.filter((_, i) => i !== idx);
    setBuilder(updated);
    const sql = buildSqlText(updated);
    savePermission(sql, 'builder', updated);
  }

  function handleModeChange(newMode) {
    setMode(newMode);
    if (newMode === 'sql' && builder.length > 0) {
      const sql = buildSqlText(builder);
      setText(sql);
      savePermission(sql, 'sql', builder);
    } else if (newMode === 'builder') {
      const sql = buildSqlText(builder);
      savePermission(sql, 'builder', builder);
    } else {
      savePermission(text, newMode, builder);
    }
  }

  const handleTextChange = (e) => {
    const val = e.target.value;
    setText(val);
    const pos = e.target.selectionStart;
    const before = val.slice(0, pos);
    const m = before.match(/[A-Za-z@_]+$/);
    if (!m) {
      setAc(null);
      return;
    }
    const word = m[0].toLowerCase();
    const pool = [...fields, ...VARS];
    const items = pool.filter(f => f.toLowerCase().startsWith(word) && f.toLowerCase() !== word);
    if (!items.length) {
      setAc(null);
      return;
    }
    setAc({ items, hl: 0 });
  };

  const handleTextBlur = () => {
    setTimeout(() => {
      setAc(null);
      if (text !== (qPerm?.SQLFilter || '')) {
        savePermission(text, 'sql', builder);
      }
    }, 200);
  };

  const handleTextKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur();
    }
  };

  const handleSelectAc = (it) => {
    const nextText = text.replace(/[A-Za-z@_]+$/, '') + it + ' ';
    setText(nextText);
    setAc(null);
    savePermission(nextText, 'sql', builder);
  };

  async function handleValidate() {
    setValidating(true);
    setValidation(null);
    const cond = mode === 'builder' ? buildSqlText(builder) : text;
    try {
      const res = await apiCall('ValidateQueryCondition', {
        QueryID: query.QueryID,
        Condition: cond
      }, {}, 'plus');
      if (res.State === 0) {
        setValidation({ type: 'ok', msg: '✓ Valid SQL Condition' });
      } else {
        setValidation({ type: 'err', msg: `✕ Invalid: ${res.Message || 'Verification failed'}` });
      }
    } catch (e) {
      setValidation({ type: 'err', msg: '✕ Validation connection error: ' + e.message });
    }
    setValidating(false);
  }

  const currentText = denyAll ? '1=0' : (mode === 'builder' ? buildSqlText(builder) : text);
  const currentMode = denyAll ? 'deny' : mode;
  const isDirty = manualSave && (currentText !== (qPerm?.SQLFilter || '') || currentMode !== (qPerm?.CondMode || 'sql'));

  return (
    <div className="up-filter-wrap">
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 4 }}>
        <input type="checkbox" checked={denyAll} onChange={e => handleToggleDenyAll(e.target.checked)} />
        <span style={{ fontSize: 12, fontWeight: 700, color: denyAll ? 'var(--red)' : 'var(--text)' }}>
          🚫 Deny all data for this user (return zero rows)
        </span>
      </label>

      {denyAll ? (
        <div className="up-val err" style={{ marginTop: 0 }}>
          This user will get <b>zero rows</b> from this query. Uncheck to set a specific condition instead.
        </div>
      ) : (
      <>
      <div className="up-mt">
        <button className={mode === 'builder' ? 'active' : ''} onClick={() => handleModeChange('builder')}>Builder</button>
        <button className={mode === 'sql' ? 'active' : ''} onClick={() => handleModeChange('sql')}>Raw SQL</button>
      </div>

      {mode === 'builder' ? (
        <>
          {loadingFields ? (
            <div style={{ fontSize: 11, color: 'var(--muted)', padding: 6 }}>Loading query fields...</div>
          ) : (
            <>
              {builder.map((r, i) => (
                <div key={i} className={`up-cr ${i === 0 ? 'first' : ''}`}>
                  {i > 0 && (
                    <select className="conj" value={r.conj || 'AND'} onChange={e => handleConjChange(i, e.target.value)}>
                      <option>AND</option>
                      <option>OR</option>
                    </select>
                  )}
                  <select value={r.field} onChange={e => handleFieldChange(i, e.target.value)}>
                    {fields.length === 0 && <option value="">(No fields)</option>}
                    {fields.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select value={r.op || '='} onChange={e => handleOpChange(i, e.target.value)}>
                    {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                  {r.op && r.op.includes('NULL') ? (
                    <span style={{ color: 'var(--muted)', fontSize: 11, textAlign: 'center' }}>—</span>
                  ) : (
                    <input
                      value={r.val || ''}
                      placeholder="value / @UserID"
                      onChange={e => handleValueChange(i, e.target.value)}
                      onBlur={() => handleValueBlur(i)}
                    />
                  )}
                  <button className="del" onClick={() => handleDelRow(i)}>✕</button>
                </div>
              ))}
              <button className="up-addc" onClick={handleAddRow}>+ Add Condition Row</button>
              <div className="up-pre">
                <b>WHERE</b> {buildSqlText(builder) || '(none)'}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="up-sw">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={text}
              onChange={handleTextChange}
              onFocus={() => setShowSuggestions(true)}
              onBlur={handleTextBlur}
              onKeyDown={handleTextKeyDown}
              placeholder=""
              style={{
                flex: 1,
                height: 32,
                padding: '0 10px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: 'var(--text)',
                outline: 'none'
              }}
            />
          </div>
          {ac && showSuggestions && ac.items.length > 0 && (
            <div className="up-ac" style={{ left: 0, top: '100%', marginTop: 4 }}>
              {ac.items.map((it, idx) => (
                <div
                  key={it}
                  className={`up-ai ${idx === ac.hl ? 'hl' : ''}`}
                  onMouseDown={() => handleSelectAc(it)}
                >
                  {it}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            Type for autocomplete. Variables: <b>@UserID</b>, <b>@Username</b>
          </div>
        </div>
      )}
      </>
      )}

      {/* Validation & Status */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        {!denyAll && (
          <button
            className="btn-secondary"
            style={{ height: 26, padding: '0 10px', fontSize: 11 }}
            onClick={handleValidate}
            disabled={validating}
          >
            {validating ? 'Validating...' : '✓ Validate Condition'}
          </button>
        )}
        {manualSave && (
          <button
            className="btn-primary"
            style={{ height: 26, padding: '0 10px', fontSize: 11 }}
            onClick={handleManualSave}
            disabled={!isDirty || isLoading}
          >
            {isLoading ? 'Saving...' : (isDirty ? '💾 Save' : 'Saved')}
          </button>
        )}
        {isLoading && !manualSave && <span style={{ fontSize: 10.5, color: 'var(--orange)', fontWeight: 600 }}>Saving...</span>}
      </div>

      {!denyAll && validation && (
        <div className={`up-val ${validation.type}`}>
          {validation.msg}
        </div>
      )}
    </div>
  );
}
