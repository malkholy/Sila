import { useState, useEffect, useMemo } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > User Master. CRUD over ERPManagement25.System.UserMaster.
//
// Backend operations used (via Pls.APIPlusUserOperationV1 -- NOT the core
// router SP; user-identity ops live there, see code-standards skill):
//   GetSystemUsers  -> List0 of { Username, Name, IsAdmin, IsNotActive, GroupID, GroupName }
//   SaveSystemUser  -> upsert { Username, Name, Password, IsAdmin, IsNotActive, GroupID? }
//                      (Password blank on edit = keep current)
//   ResetPassword   -> { Username } -- resets the password to the
//                      (lowercased) Username itself
//   DeactivateUser  -> { Username, IsNotActive? } -- soft delete/restore,
//                      never a physical row delete

const EMPTY_FORM = { Username: '', Name: '', Password: '', IsAdmin: false, IsNotActive: false, GroupID: '' };
const USER_SP = { spName: 'Pls.APIPlusUserOperationV1' };

const inputStyle = {
  width: '100%', height: 38, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none'
};
const labelStyle = {
  display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  marginBottom: 6, textTransform: 'uppercase'
};

export default function UserMaster() {
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [searchQuery, setSearchQuery] = useState('');
  const [openGroups, setOpenGroups] = useState(() => new Set());   // expanded groups (default: all collapsed)

  const toggleGroup = (name) => setOpenGroups(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  useEffect(() => {
    loadData();
    apiCall('GetUserGroups', {}, {}, USER_SP)
      .then(res => { if (res.State === 0) setGroups(res.List0 || []); })
      .catch(() => {});   // group picker just stays empty on error -- not fatal
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiCall('GetSystemUsers', {}, {}, USER_SP);
      if (res.State === 0) {
        setUsers(res.List0 || []);
      } else {
        setError(res.Message || 'Failed to load users');
      }
    } catch (err) {
      setError('Connection error: ' + err.message);
    }
    setLoading(false);
  }

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return users;
    const q = searchQuery.toLowerCase();
    return users.filter(u =>
      (u.Username || '').toLowerCase().includes(q) ||
      (u.Name || '').toLowerCase().includes(q) ||
      (u.GroupName || '').toLowerCase().includes(q)
    );
  }, [users, searchQuery]);

  // list grouped by GroupName (users without one fall into "Ungrouped")
  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach(u => {
      const g = (u.GroupName || '').trim() || 'Ungrouped';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(u);
    });
    return [...map.entries()]
      .sort((a, b) => (a[0] === 'Ungrouped') - (b[0] === 'Ungrouped') || a[0].localeCompare(b[0]))
      .map(([name, list]) => [name, list.sort((x, y) => (x.Name || x.Username).localeCompare(y.Name || y.Username))]);
  }, [filtered]);

  function toBool(v) { return v === 1 || v === true || v === '1'; }

  function handleSelect(u) {
    setSelected(u);
    setOpenGroups(prev => new Set(prev).add((u.GroupName || '').trim() || 'Ungrouped'));
    setIsNew(false);
    setError(null);
    setSuccessMsg(null);
    setFormData({
      Username: u.Username,
      Name: u.Name || '',
      Password: '',
      IsAdmin: toBool(u.IsAdmin),
      IsNotActive: toBool(u.IsNotActive),
      GroupID: u.GroupID != null ? String(u.GroupID) : ''
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
    if (!formData.Username.trim() || !formData.Name.trim()) {
      setError('Username and Name are required.');
      return;
    }
    if (isNew && !formData.Password.trim()) {
      setError('Password is required for a new user.');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('SaveSystemUser', {
        Username: formData.Username.trim(),
        Name: formData.Name.trim(),
        Password: formData.Password,
        IsAdmin: formData.IsAdmin ? 1 : 0,
        IsNotActive: formData.IsNotActive ? 1 : 0,
        GroupID: formData.GroupID ? Number(formData.GroupID) : null
      }, {}, USER_SP);

      if (res.State === 0) {
        setSuccessMsg('✓ Saved successfully!');
        setIsNew(false);
        await loadData();
        setFormData(fd => ({ ...fd, Password: '' }));
      } else {
        setError(res.Message || 'Failed to save');
      }
    } catch (err) {
      setError('Save connection error: ' + err.message);
    }
    setSaving(false);
  }

  async function handleResetPassword() {
    if (!selected) return;
    if (!window.confirm(`Reset "${selected.Username}"'s password to their username? They'll need to be told the new password to log in.`)) return;

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('ResetPassword', { Username: selected.Username }, {}, USER_SP);
      if (res.State === 0) {
        setSuccessMsg(`✓ Password reset to "${selected.Username}".`);
      } else {
        setError(res.Message || 'Failed to reset password');
      }
    } catch (err) {
      setError('Reset password connection error: ' + err.message);
    }
    setSaving(false);
  }

  async function handleDeactivate() {
    if (!selected) return;
    if (!window.confirm(`Deactivate user "${selected.Username}"? They will no longer be able to log in, but their settings and permissions are kept.`)) return;

    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await apiCall('DeactivateUser', { Username: selected.Username, IsNotActive: 1 }, {}, USER_SP);
      if (res.State === 0) {
        setSuccessMsg('✓ Deactivated successfully.');
        resetForm();
        await loadData();
      } else {
        setError(res.Message || 'Failed to deactivate');
      }
    } catch (err) {
      setError('Deactivate connection error: ' + err.message);
    }
    setSaving(false);
  }

  const showForm = isNew || !!selected;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>User Master</h2>
          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            Create and manage system users, admin rights and active status.
          </p>
        </div>
        <button onClick={handleNew} style={{
          height: 34, padding: '0 16px', background: 'linear-gradient(135deg, var(--orange), var(--orange2))',
          color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer'
        }}>+ New User</button>
      </div>

      <div style={{ display: 'flex', flex: 1, gap: 24, minHeight: 0 }}>
        {/* User list */}
        <div style={{
          width: 340, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0
        }}>
          <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search users..." value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)} style={{ ...inputStyle, height: 36 }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading users...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No users found.</div>
            ) : (
              grouped.map(([groupName, list]) => {
                const open = openGroups.has(groupName) || !!searchQuery.trim();
                return (
                <div key={groupName} style={{ marginBottom: 6 }}>
                  <button onClick={() => toggleGroup(groupName)} style={{
                    position: 'sticky', top: 0, zIndex: 1, width: '100%', background: 'var(--surface)',
                    padding: '7px 10px 5px', fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase',
                    letterSpacing: 0.6, color: 'var(--muted)', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left',
                  }}>
                    <span style={{ width: 9, fontSize: 9 }}>{open ? '▼' : '▶'}</span>
                    <span style={{ flex: 1 }}>{groupName}</span>
                    <span style={{ color: 'var(--hint, var(--muted))' }}>{list.length}</span>
                  </button>
                  {open && list.map(u => {
                    const isSelected = selected?.Username === u.Username;
                    return (
                      <div key={u.Username} onClick={() => handleSelect(u)} style={{
                        padding: '10px 14px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                        background: isSelected ? 'var(--orange-soft)' : 'transparent',
                        border: '1px solid ' + (isSelected ? 'var(--orange)' : 'transparent')
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{u.Name || u.Username}</span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {toBool(u.IsAdmin) && (
                              <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4 }}>Admin</span>
                            )}
                            {toBool(u.IsNotActive) && (
                              <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--red)', background: 'var(--red-soft)', padding: '2px 6px', borderRadius: 4 }}>Inactive</span>
                            )}
                          </div>
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>{u.Username}</div>
                      </div>
                    );
                  })}
                </div>
                );
              })
            )}
          </div>
        </div>

        {/* Form */}
        <div style={{
          flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14,
          display: 'flex', flexDirection: 'column', minHeight: 0
        }}>
          {!showForm ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
              Select a user from the list, or create a new one.
            </div>
          ) : (
            <>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isNew ? 'Create New User' : `Editing: ${formData.Username}`}
                </h3>
                {!isNew && (
                  <div style={{ display: 'flex', gap: 16 }}>
                    <button onClick={handleResetPassword} disabled={saving}
                      style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                      ↺ Reset Password
                    </button>
                    <button onClick={handleDeactivate} disabled={saving}
                      style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                      ⦸ Deactivate
                    </button>
                  </div>
                )}
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
                {error && (
                  <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{error}</div>
                )}
                {successMsg && (
                  <div style={{ background: 'var(--green-soft)', border: '1px solid rgba(22,163,74,0.2)', color: 'var(--green)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>{successMsg}</div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div>
                    <label style={labelStyle}>Username</label>
                    <input type="text" value={formData.Username} disabled={!isNew}
                      onChange={e => setFormData({ ...formData, Username: e.target.value.trim() })}
                      placeholder="e.g. jsmith"
                      style={{ ...inputStyle, background: isNew ? 'var(--bg)' : 'var(--soft)', fontFamily: 'monospace' }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Full Name</label>
                    <input type="text" value={formData.Name}
                      onChange={e => setFormData({ ...formData, Name: e.target.value })}
                      placeholder="e.g. John Smith" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>{isNew ? 'Password' : 'New Password (blank = keep)'}</label>
                    <input type="password" value={formData.Password} autoComplete="new-password"
                      onChange={e => setFormData({ ...formData, Password: e.target.value })}
                      placeholder={isNew ? 'Set a password' : '••••••••'} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Group</label>
                    <select value={formData.GroupID}
                      onChange={e => setFormData({ ...formData, GroupID: e.target.value })}
                      style={{ ...inputStyle, cursor: 'pointer' }}>
                      <option value="">— Ungrouped —</option>
                      {groups.map(g => (
                        <option key={g.GroupID} value={g.GroupID}>{g.GroupName}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 24 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={formData.IsAdmin}
                      onChange={e => setFormData({ ...formData, IsAdmin: e.target.checked })} />
                    System Administrator
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--text)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={formData.IsNotActive}
                      onChange={e => setFormData({ ...formData, IsNotActive: e.target.checked })} />
                    Inactive (cannot log in)
                  </label>
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
        </div>
      </div>
    </div>
  );
}
