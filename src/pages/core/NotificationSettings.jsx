import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > Notification Settings -- manage [PLS].[V1NotificationEventType]
// rows: the catalog of what can notify, who it notifies (RecipientRules),
// and the message templates. See docs/notification-system-plan.md.
//
// Backend operations (via Pls.APINotificationV1, admin-only):
//   GetNotificationEventTypes    -> { EventTypeID, EventKey, PageGroupID, PageLabel,
//                                     TitleTemplate, BodyTemplate, RecipientRules,
//                                     Channels, Priority, IsActive }
//   SaveNotificationEventType    -> upsert (EventKey unique), returns { EventTypeID }
//   DeleteNotificationEventType  -> { EventTypeID }

const NOTIF_SP = 'Pls.APINotificationV1';

const RULE_TOKENS = [
  { token: 'watchers', hint: 'Anyone who starred/watched this record' },
  { token: 'page-users', hint: 'Everyone with permission on the page (broad)' },
  { token: '-actor', hint: 'Exclude whoever made the change' },
];

// 'user:<Username>' -- an explicit extra recipient (Extra tab). Still gated
// by every other layer server-side (page permission, record visibility) --
// picking someone here never shows them a record they couldn't otherwise see.
const EXTRA_PREFIX = 'user:';

const EMPTY_FORM = {
  EventTypeID: null,
  EventKey: '',
  PageGroupID: '',
  TitleTemplate: '',
  BodyTemplate: '',
  RecipientRules: '["watchers","-actor"]',
  Priority: 'Normal',
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

function parseRules(json) {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return null; }
}

export default function NotificationSettings() {
  const [events, setEvents] = useState([]);
  const [pages, setPages] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('general');
  const [addUser, setAddUser] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [evRes, pgRes, usRes] = await Promise.all([
        apiCall('GetNotificationEventTypes', {}, {}, { spName: NOTIF_SP }),
        apiCall('GetPagesAndGroups', {}, {}, 'plus'),
        apiCall('GetSystemUsers', {}, {}, { spName: 'Pls.APIPlusUserOperationV1' }),
      ]);
      if (evRes.State === 0) setEvents(evRes.List0 || []);
      else setError(evRes.Message || 'Failed to load notification event types');
      setPages((pgRes.List0 || []).filter(p => !p.IsGroup && p.IsGroup !== 1));
      setUsers(usRes.State === 0 ? (usRes.List0 || []) : []);
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return events;
    const s = search.toLowerCase();
    return events.filter(e =>
      (e.EventKey || '').toLowerCase().includes(s) ||
      (e.PageLabel || '').toLowerCase().includes(s));
  }, [events, search]);

  function handleSelect(e) {
    setSelected(e);
    setIsNew(false);
    setError(null);
    setSuccessMsg(null);
    setTab('general');
    setFormData({
      EventTypeID: e.EventTypeID,
      EventKey: e.EventKey || '',
      PageGroupID: e.PageGroupID != null ? String(e.PageGroupID) : '',
      TitleTemplate: e.TitleTemplate || '',
      BodyTemplate: e.BodyTemplate || '',
      RecipientRules: e.RecipientRules || '[]',
      Priority: e.Priority || 'Normal',
      IsActive: e.IsActive === 1 || e.IsActive === true,
    });
  }

  function handleNew() {
    setSelected(null);
    setIsNew(true);
    setError(null);
    setSuccessMsg(null);
    setTab('general');
    setFormData(EMPTY_FORM);
  }

  function resetForm() {
    setSelected(null);
    setIsNew(false);
    setFormData(EMPTY_FORM);
    setError(null);
    setSuccessMsg(null);
    setTab('general');
  }

  function toggleRuleToken(token) {
    const cur = parseRules(formData.RecipientRules) || [];
    const next = cur.includes(token) ? cur.filter(t => t !== token) : [...cur, token];
    setFormData({ ...formData, RecipientRules: JSON.stringify(next) });
  }

  function addExtraUser(username) {
    if (!username) return;
    const cur = parseRules(formData.RecipientRules) || [];
    const tok = EXTRA_PREFIX + username;
    if (cur.includes(tok)) return;
    setFormData({ ...formData, RecipientRules: JSON.stringify([...cur, tok]) });
    setAddUser('');
  }

  function removeExtraUser(username) {
    const cur = parseRules(formData.RecipientRules) || [];
    setFormData({ ...formData, RecipientRules: JSON.stringify(cur.filter(t => t !== EXTRA_PREFIX + username)) });
  }

  async function handleSave() {
    if (!formData.EventKey.trim()) { setError('Event Key is required.'); return; }
    if (!formData.PageGroupID) { setError('Page is required.'); return; }
    if (!formData.TitleTemplate.trim()) { setError('Title Template is required.'); return; }
    const rules = parseRules(formData.RecipientRules);
    if (rules === null) { setError('Recipient Rules must be valid JSON (an array of tokens).'); return; }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('SaveNotificationEventType', {
        EventTypeID: isNew ? null : formData.EventTypeID,
        EventKey: formData.EventKey.trim().toUpperCase(),
        PageGroupID: Number(formData.PageGroupID),
        TitleTemplate: formData.TitleTemplate.trim(),
        BodyTemplate: formData.BodyTemplate.trim() || null,
        RecipientRules: formData.RecipientRules,
        Priority: formData.Priority,
        IsActive: formData.IsActive ? 1 : 0,
      }, {}, { spName: NOTIF_SP });

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
    if (!window.confirm(`Delete event type "${selected.EventKey}"? This stops future notifications for it; past notifications stay.`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiCall('DeleteNotificationEventType', { EventTypeID: selected.EventTypeID }, {}, { spName: NOTIF_SP });
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
  const activeTokens = parseRules(formData.RecipientRules) || [];
  const extraUsers = activeTokens.filter(t => t.startsWith(EXTRA_PREFIX)).map(t => t.slice(EXTRA_PREFIX.length));
  const addableUsers = users.filter(u => !extraUsers.includes(u.Username));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>Notification Settings</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Which events raise a bell notification, who gets it, and the message shown. Raised in-process by business SPs via PLS.V1RaiseNotification.
          </p>
        </div>
        <button onClick={handleNew} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        }}>+ New Event Type</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* List */}
        <div style={{ width: 320, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search events..." value={search}
              onChange={e => setSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No notification events registered yet.</div>
            ) : filtered.map(e => {
              const sel = selected?.EventTypeID === e.EventTypeID;
              return (
                <div key={e.EventTypeID} onClick={() => handleSelect(e)} style={{
                  padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                  background: sel ? 'var(--orange-soft)' : 'transparent',
                  border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent'),
                  opacity: (e.IsActive === 1 || e.IsActive === true) ? 1 : 0.55,
                }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', fontFamily: 'monospace' }}>
                    {e.EventKey}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>
                    {e.PageLabel || `Page ${e.PageGroupID}`} • {e.Priority}
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
              Select an event type, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? 'New Event Type' : `Editing ${formData.EventKey}`}
                </h3>
                {!isNew && (
                  <button onClick={handleDelete} disabled={saving}
                    style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✕ Delete</button>
                )}
              </div>

              <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border)' }}>
                {[['general', 'General'], ['extra', `Extra${extraUsers.length ? ` (${extraUsers.length})` : ''}`]].map(([key, label]) => {
                  const active = tab === key;
                  return (
                    <button key={key} onClick={() => setTab(key)} style={{
                      appearance: 'none', background: 'none', border: 'none',
                      padding: '10px 8px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                      color: active ? 'var(--orange)' : 'var(--muted)',
                      borderBottom: '2px solid ' + (active ? 'var(--orange)' : 'transparent'),
                      marginBottom: -1,
                    }}>{label}</button>
                  );
                })}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>}
                {successMsg && <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>}

                {tab === 'extra' ? (
                  <div>
                    <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 16 }}>
                      Always consider these specific users for this event, on top of whatever the Recipient Rules chips resolve (watchers, etc).
                      Each is added as a <code>user:&lt;Username&gt;</code> token. They're still subject to the normal page-permission and
                      record-visibility checks — adding someone here never shows them a record they couldn't otherwise see.
                    </p>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                      <select value={addUser} onChange={e => setAddUser(e.target.value)} style={inputStyle}>
                        <option value="">Select a user to add…</option>
                        {addableUsers.map(u => (
                          <option key={u.Username} value={u.Username}>{u.Name ? `${u.Name} (${u.Username})` : u.Username}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => addExtraUser(addUser)} disabled={!addUser} style={{
                        height: 36, padding: '0 16px', border: 'none', borderRadius: 8, cursor: addUser ? 'pointer' : 'not-allowed',
                        background: addUser ? 'linear-gradient(135deg, var(--orange), var(--orange2))' : 'var(--soft)',
                        color: addUser ? '#fff' : 'var(--muted)', fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap',
                      }}>+ Add</button>
                    </div>

                    {extraUsers.length === 0 ? (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5, border: '1px dashed var(--border)', borderRadius: 8 }}>
                        No extra users added -- this event only notifies whoever the Recipient Rules chips resolve.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {extraUsers.map(username => {
                          const u = users.find(x => x.Username === username);
                          return (
                            <div key={username} style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)',
                            }}>
                              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
                                {u?.Name ? `${u.Name} ` : ''}<span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>({username})</span>
                              </span>
                              <button onClick={() => removeExtraUser(username)} title="Remove"
                                style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 13, cursor: 'pointer' }}>✕</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Event Key</label>
                    <input type="text" value={formData.EventKey}
                      onChange={e => setFormData({ ...formData, EventKey: e.target.value })}
                      placeholder="e.g. PO_APPROVED" style={{ ...inputStyle, fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Page</label>
                    <select value={formData.PageGroupID}
                      onChange={e => setFormData({ ...formData, PageGroupID: e.target.value })}
                      style={inputStyle}>
                      <option value="">Select a page…</option>
                      {pages.map(p => (
                        <option key={p.PageGroupID} value={p.PageGroupID}>{p.Label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Title Template</label>
                  <input type="text" value={formData.TitleTemplate}
                    onChange={e => setFormData({ ...formData, TitleTemplate: e.target.value })}
                    placeholder="e.g. PO {PONumber} approved" style={inputStyle} />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Body Template</label>
                  <input type="text" value={formData.BodyTemplate}
                    onChange={e => setFormData({ ...formData, BodyTemplate: e.target.value })}
                    placeholder="e.g. Approved by {ApprovedBy}." style={inputStyle} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                    {'{tokens}'} are filled from whatever JSON the raising SP passes as @ContextJson.
                  </p>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Recipient Rules</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                    {RULE_TOKENS.map(rt => {
                      const on = activeTokens.includes(rt.token);
                      return (
                        <button key={rt.token} type="button" onClick={() => toggleRuleToken(rt.token)} title={rt.hint} style={{
                          height: 28, padding: '0 10px', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          border: '1px solid ' + (on ? 'var(--orange)' : 'var(--border)'),
                          background: on ? 'var(--orange-soft)' : 'var(--bg)',
                          color: on ? 'var(--orange)' : 'var(--muted)', fontFamily: 'monospace',
                        }}>{rt.token}</button>
                      );
                    })}
                  </div>
                  <textarea value={formData.RecipientRules}
                    onChange={e => setFormData({ ...formData, RecipientRules: e.target.value })}
                    spellCheck={false}
                    style={{ ...inputStyle, height: 60, padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }} />
                  <p style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
                    JSON array of tokens. Also supports <code>record.&lt;Field&gt;</code> (pulls a username out of @ContextJson), <code>user:&lt;Username&gt;</code> (managed on the Extra tab), and <code>role:&lt;Key&gt;</code> (reserved, no-op until a roles module exists).
                  </p>
                </div>

                <div>
                  <label style={labelStyle}>Priority</label>
                  <select value={formData.Priority}
                    onChange={e => setFormData({ ...formData, Priority: e.target.value })}
                    style={{ ...inputStyle, width: 160, marginBottom: 16 }}>
                    <option value="Low">Low</option>
                    <option value="Normal">Normal</option>
                    <option value="High">High</option>
                  </select>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={formData.IsActive}
                    onChange={e => setFormData({ ...formData, IsActive: e.target.checked })} />
                  Active
                </label>
                </>
                )}
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
