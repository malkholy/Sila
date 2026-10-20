import React, { useState, useEffect } from 'react';
import { apiCall } from './api.js';

export default function ConditionBuilderModal({ initialCondition = '', tableName = '', user, onClose, onSave, title = 'Condition Builder', label = 'Condition' }) {
  const [condition, setCondition] = useState(initialCondition || '');
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadColumns() {
      if (!tableName) return;
      setLoading(true);
      try {
        const res = await apiCall('Get Table Columns', { TableName: tableName }, { User: user?.Username }, 'journal');
        if (res.State !== 0) {
          setError(res.Message || 'Failed to fetch columns');
        } else {
          setColumns(res.List0 || []);
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    loadColumns();
  }, [tableName, user]);

  const insertText = (text) => {
    setCondition(prev => (prev ? prev + ' ' : '') + text);
  };

  const handleOperatorClick = (op) => {
    insertText(op);
  };

  const handleRowDoubleClick = (colName) => {
    insertText(`[${colName}]`);
  };

  // Parse Schema/Table from ACC.AccountMaster format
  const schemaStr = tableName.includes('.') ? tableName.split('.')[0] : 'dbo';
  const tableStr = tableName.includes('.') ? tableName.split('.')[1] : tableName;

  return (
    <>
      <div 
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', zIndex: 9999999
        }}
        onClick={onClose}
      />
      
      <div 
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 600, background: '#fff', borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          zIndex: 10000000, display: 'flex', flexDirection: 'column'
        }}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #E9ECF2', background: '#F8F9FA', borderTopLeftRadius: 8, borderTopRightRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🔣</span>
            <span style={{ fontWeight: 600, color: '#0F2038', fontSize: 14 }}>{title}</span>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#9AA5B4', fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          {/* Schema & Table Fields */}
          <div style={{ display: 'flex', gap: 16 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#4A5A72' }}>Schema</label>
              <input type="text" readOnly value={schemaStr} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #DCE1EA', borderRadius: 4, background: '#F8F9FA', color: '#0F2038', outline: 'none' }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#4A5A72' }}>Table</label>
              <input type="text" readOnly value={tableStr} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #DCE1EA', borderRadius: 4, background: '#F8F9FA', color: '#0F2038', outline: 'none' }} />
            </div>
          </div>

          {/* Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            {['+', '-', '*', '/', '(', ')'].map(op => (
              <button 
                key={op} 
                onClick={() => handleOperatorClick(op)}
                style={{ 
                  width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: '#FFF', border: '1px solid #DCE1EA', borderRadius: 4, cursor: 'pointer',
                  fontWeight: 600, color: '#4A5A72', fontSize: 14
                }}
              >
                {op}
              </button>
            ))}
          </div>

          {/* Condition Textarea */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#4A5A72' }}>{label}</label>
            <textarea 
              value={condition} 
              onChange={e => setCondition(e.target.value)}
              style={{ 
                width: '100%', height: 100, padding: 10, fontSize: 13, border: '1px solid #DCE1EA', 
                borderRadius: 4, background: '#FFF', color: '#0F2038', outline: 'none', resize: 'none',
                fontFamily: 'monospace'
              }}
              placeholder="e.g. [AccountNumber] > 1000"
            />
          </div>

          {/* Columns Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, color: '#9AA5B4', fontStyle: 'italic' }}>Double-click a column row below to insert it</div>
            <div style={{ border: '1px solid #DCE1EA', borderRadius: 4, height: 160, overflowY: 'auto' }}>
              {loading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#7A8C9E', fontSize: 13 }}>Loading columns...</div>
              ) : error ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--red)', fontSize: 13 }}>{error}</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
                  <thead style={{ position: 'sticky', top: 0, background: '#F8F9FA' }}>
                    <tr style={{ borderBottom: '1px solid #DCE1EA' }}>
                      <th style={{ padding: '6px 12px', fontWeight: 600, color: '#4A5A72' }}>Name</th>
                      <th style={{ padding: '6px 12px', fontWeight: 600, color: '#4A5A72' }}>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((c, i) => (
                      <tr 
                        key={i} 
                        onDoubleClick={() => handleRowDoubleClick(c.Name)}
                        style={{ borderBottom: '1px solid #F1F3F7', cursor: 'pointer', transition: 'background 0.2s' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#F8F9FA'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <td style={{ padding: '6px 12px', color: '#0F2038' }}>{c.Name}</td>
                        <td style={{ padding: '6px 12px', color: '#7A8C9E' }}>{c.Description}</td>
                      </tr>
                    ))}
                    {columns.length === 0 && (
                      <tr><td colSpan={2} style={{ padding: '16px', textAlign: 'center', color: '#9AA5B4', fontStyle: 'italic' }}>No columns found for this table.</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>

        </div>

        {/* Footer */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #E9ECF2', background: '#F8F9FA', borderBottomLeftRadius: 8, borderBottomRightRadius: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button 
            onClick={onClose}
            style={{ padding: '8px 16px', background: 'transparent', border: '1px solid #DCE1EA', borderRadius: 4, color: '#4A5A72', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Cancel
          </button>
          <button 
            onClick={() => onSave(condition)}
            style={{ padding: '8px 16px', background: '#1D4FB8', border: 'none', borderRadius: 4, color: '#FFF', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Save Changes
          </button>
        </div>
      </div>
    </>
  );
}
