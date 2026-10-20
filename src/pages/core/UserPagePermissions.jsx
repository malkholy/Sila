import { useState, useEffect, useMemo, useRef } from 'react';
import { apiCall } from '../../shared/api.js';

// Settings > User Permissions.
//
// Flow: pick a user -> tick the Groups/Pages they can see -> click a page to
// open its permission detail: the row filter on each of the page's queries,
// the per-user row filter on each filter linked to the page, and which
// page-operations the user may run.
//
// Backend (via Pls.APIPlusOperationV1, except GetSystemUsers which is
// user-identity and lives in Pls.APIPlusUserOperationV1):
//   GetSystemUsers / GetPagesAndGroups
//   GetUserPagePermissions / SaveUserPagePermission        (page view grants)
//   GetPageQueries / GetUserQueryPermissions / SaveUserQueryPermission / ValidateQueryCondition
//   GetQueryFilterLinks / GetQueryFilter / GetUserFilterPermissions / SaveUserFilterPermission / ValidateFilterCondition
//   GetPageOperations / GetUserOperationPermissions / SaveUserOperationPermission

const inputStyle = {
  width: '100%', height: 36, padding: '0 12px', border: '1.5px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--text)', background: 'var(--bg)', outline: 'none'
};

function toBool(v) { return v === 1 || v === true || v === '1'; }

export default function UserPagePermissions() {
  const [users, setUsers] = useState([]);
  const [pages, setPages] = useState([]);
  const [perms, setPerms] = useState([]);          // page view grants for the selected user
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedPage, setSelectedPage] = useState(null);   // page row whose detail is open
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [userSearch, setUserSearch] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [openUserGroups, setOpenUserGroups] = useState(() => new Set());   // expanded user groups (default: all collapsed)

  const toggleUserGroup = (name) => setOpenUserGroups(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  useEffect(() => {
    if (pages.length) setCollapsed(new Set(pages.filter(p => p.IsGroup).map(p => p.PageGroupID)));
  }, [pages]);

  const toggleCollapse = (groupId) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(groupId) ? next.delete(groupId) : next.add(groupId);
    return next;
  });

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [u, p] = await Promise.all([
          apiCall('GetSystemUsers', {}, {}, { spName: 'Pls.APIPlusUserOperationV1' }),
          apiCall('GetPagesAndGroups', {}, {}, 'plus'),
        ]);
        if (u.State === 0) setUsers(u.List0 || []);
        if (p.State === 0) setPages((p.List0 || []).filter(i => i.SortOrder !== 999));
      } catch (e) {
        setError('Connection error: ' + e.message);
      }
      setLoading(false);
    })();
  }, []);

  async function loadPerms(username) {
    try {
      const res = await apiCall('GetUserPagePermissions', {}, {}, 'plus');
      if (res.State === 0) {
        setPerms((res.List0 || []).filter(r => (r.Username || '').toLowerCase() === username.toLowerCase()));
      }
    } catch (e) {
      setError('Connection error: ' + e.message);
    }
  }

  function selectUser(u) {
    setSelectedUser(u);
    setOpenUserGroups(prev => new Set(prev).add((u.GroupName || '').trim() || 'Ungrouped'));
    setSelectedPage(null);
    setError(null);
    setPerms([]);
    loadPerms(u.Username);
  }

  const filteredUsers = useMemo(() => {
    if (!userSearch.trim()) return users;
    const q = userSearch.toLowerCase();
    return users.filter(u =>
      (u.Username || '').toLowerCase().includes(q) || (u.Name || '').toLowerCase().includes(q)
      || (u.GroupName || '').toLowerCase().includes(q));
  }, [users, userSearch]);

  const groupedUsers = useMemo(() => {
    const map = new Map();
    filteredUsers.forEach(u => {
      const g = (u.GroupName || '').trim() || 'Ungrouped';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(u);
    });
    return [...map.entries()]
      .sort((a, b) => (a[0] === 'Ungrouped') - (b[0] === 'Ungrouped') || a[0].localeCompare(b[0]))
      .map(([name, list]) => [name, list.sort((x, y) => (x.Name || x.Username).localeCompare(y.Name || y.Username))]);
  }, [filteredUsers]);

  const treeRows = useMemo(() => {
    const rows = [];
    const groups = pages.filter(i => i.IsGroup).sort((a, b) => a.SortOrder - b.SortOrder);
    const orphans = pages.filter(i => !i.IsGroup && !i.ParentID).sort((a, b) => a.SortOrder - b.SortOrder);
    groups.forEach(g => {
      const kids = pages.filter(i => i.ParentID === g.PageGroupID).sort((a, b) => a.SortOrder - b.SortOrder);
      rows.push({ ...g, depth: 0, childCount: kids.length });
      kids.forEach(c => rows.push({ ...c, depth: 1 }));
    });
    orphans.forEach(o => rows.push({ ...o, depth: 0 }));
    return rows;
  }, [pages]);

  const hasPerm = (pageGroupId) => perms.some(p => p.PageGroupID === pageGroupId && toBool(p.CanView));

  const selectedIsAdmin = selectedUser &&
    (toBool(selectedUser.IsAdmin) || (selectedUser.Username || '').toLowerCase() === 'sysadmin');

  async function toggle(pageGroupId) {
    if (!selectedUser || selectedIsAdmin) return;
    const next = hasPerm(pageGroupId) ? 0 : 1;
    setBusyId(pageGroupId);
    setError(null);
    try {
      const res = await apiCall('SaveUserPagePermission', {
        Username: selectedUser.Username, PageGroupID: pageGroupId, CanView: next,
      }, {}, 'plus');
      if (res.State !== 0) setError(res.Message || 'Failed to update permission.');
      else await loadPerms(selectedUser.Username);
    } catch (e) {
      setError('Connection error: ' + e.message);
    }
    setBusyId(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>User Permissions</h2>
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
          Pick a user, tick the groups &amp; pages they can see, then click a page to set its query / filter / operation permissions.
        </p>
      </div>

      {error && (
        <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ display: 'flex', flex: 1, gap: 16, minHeight: 0 }}>
        {/* User list */}
        <div style={{ width: 260, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="Search users..." value={userSearch}
              onChange={e => setUserSearch(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading...</div>
            ) : groupedUsers.map(([groupName, list]) => {
              const open = openUserGroups.has(groupName) || !!userSearch.trim();
              return (
                <div key={groupName} style={{ marginBottom: 6 }}>
                  <button onClick={() => toggleUserGroup(groupName)} style={{
                    position: 'sticky', top: 0, zIndex: 1, width: '100%', background: 'var(--surface)',
                    padding: '7px 8px 5px', fontSize: 9.5, fontWeight: 800, textTransform: 'uppercase',
                    letterSpacing: 0.6, color: 'var(--muted)', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left',
                  }}>
                    <span style={{ width: 9, fontSize: 9 }}>{open ? '▼' : '▶'}</span>
                    <span style={{ flex: 1 }}>{groupName}</span>
                    <span style={{ color: 'var(--hint, var(--muted))' }}>{list.length}</span>
                  </button>
                  {open && list.map(u => {
                    const sel = selectedUser?.Username === u.Username;
                    return (
                      <div key={u.Username} onClick={() => selectUser(u)} style={{
                        padding: '10px 12px', borderRadius: 10, cursor: 'pointer', marginBottom: 4,
                        background: sel ? 'var(--orange-soft)' : 'transparent',
                        border: '1px solid ' + (sel ? 'var(--orange)' : 'transparent')
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{u.Name || u.Username}</span>
                          {(toBool(u.IsAdmin) || (u.Username || '').toLowerCase() === 'sysadmin') && (
                            <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: 'uppercase', color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 6px', borderRadius: 4 }}>Admin</span>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, fontFamily: 'monospace' }}>{u.Username}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {!selectedUser ? (
          <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Select a user to manage their permissions.
          </div>
        ) : (
          <>
            {/* Groups & Pages tree */}
            <div style={{ width: 340, flexShrink: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{selectedUser.Name || selectedUser.Username}</div>
                <div style={{ fontSize: 10.5, color: selectedIsAdmin ? 'var(--orange)' : 'var(--muted)', marginTop: 2 }}>
                  {selectedIsAdmin ? 'Admin — sees every page, all operations allowed.' : 'Groups & pages this user can open'}
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
                {treeRows
                  .filter(item => !(item.depth > 0 && collapsed.has(item.ParentID)))
                  .map(item => {
                    const on = selectedIsAdmin || hasPerm(item.PageGroupID);
                    const isCollapsed = collapsed.has(item.PageGroupID);
                    const pageSel = !item.IsGroup && selectedPage?.PageGroupID === item.PageGroupID;
                    return (
                      <div key={item.PageGroupID} style={{
                        marginLeft: item.depth * 16, borderRadius: 8, marginBottom: 2,
                        background: pageSel ? 'var(--orange-soft)' : item.IsGroup ? 'var(--soft)' : 'transparent',
                        border: '1px solid ' + (pageSel ? 'var(--orange)' : 'transparent'),
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                          {item.IsGroup ? (
                            <span onClick={() => toggleCollapse(item.PageGroupID)}
                              style={{ width: 14, textAlign: 'center', cursor: 'pointer', color: 'var(--muted)', fontSize: 9, flexShrink: 0, visibility: item.childCount ? 'visible' : 'hidden' }}>
                              {isCollapsed ? '▶' : '▼'}
                            </span>
                          ) : <span style={{ width: 14, flexShrink: 0 }} />}
                          <input type="checkbox" checked={on}
                            disabled={selectedIsAdmin || busyId === item.PageGroupID}
                            onChange={() => toggle(item.PageGroupID)} />
                          <span
                            onClick={() => !item.IsGroup && setSelectedPage(item)}
                            style={{
                              flex: 1, fontSize: 12.5, fontWeight: item.IsGroup ? 800 : 600,
                              color: 'var(--text)', cursor: item.IsGroup ? 'default' : 'pointer',
                              textTransform: item.IsGroup ? 'uppercase' : 'none',
                            }}>
                            {item.Icon} {item.Label}
                          </span>
                          {item.IsGroup && item.childCount > 0 && (
                            <span style={{ fontSize: 9.5, color: 'var(--muted)' }}>({item.childCount})</span>
                          )}
                          {!item.IsGroup && <span style={{ fontSize: 10, color: 'var(--muted)' }}>›</span>}
                        </div>
                      </div>
                    );
                  })}
                {treeRows.length === 0 && (
                  <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No pages or groups defined yet.</div>
                )}
              </div>
            </div>

            {/* Page permission detail */}
            <div style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {!selectedPage ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                  Click a page in the tree to set its query, filter and operation permissions for {selectedUser.Name || selectedUser.Username}.
                </div>
              ) : (
                <PagePermissionDetail
                  key={selectedPage.PageGroupID + ':' + selectedUser.Username}
                  username={selectedUser.Username}
                  page={selectedPage}
                  isAdmin={selectedIsAdmin}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail panel for one (user, page): Query / Filters / Operations
// ---------------------------------------------------------------------------
function PagePermissionDetail({ username, page, isAdmin }) {
  const [tab, setTab] = useState('query');   // 'query' | 'filters' | 'operations'
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const [queries, setQueries] = useState([]);
  const [filters, setFilters] = useState([]);       // { QueryFilterID, FilterName, ViewName }
  const [filterPerms, setFilterPerms] = useState({});   // QueryFilterID -> SQLFilter
  const [ops, setOps] = useState([]);              // page-operations
  const [opGrants, setOpGrants] = useState(new Set());  // OperationID
  const [busyOp, setBusyOp] = useState(null);
  const [reports, setReports] = useState([]);      // distinct reports linked to this page
  const [reportGrants, setReportGrants] = useState(new Set());  // ReportID
  const [busyReport, setBusyReport] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null); setTab('query');
    (async () => {
      try {
        const [pq, links, allF, fPerms, pOps, oGrants, rLinks, rGrants] = await Promise.all([
          apiCall('GetPageQueries', { PageGroupID: page.PageGroupID }, {}, 'plus'),
          apiCall('GetQueryFilterLinks', { PageGroupID: page.PageGroupID }, {}, 'plus'),
          apiCall('GetQueryFilter', {}, {}, 'plus'),
          apiCall('GetUserFilterPermissions', { Username: username }, {}, 'plus'),
          apiCall('GetPageOperations', { PageGroupID: page.PageGroupID }, {}, 'plus'),
          apiCall('GetUserOperationPermissions', { Username: username }, {}, 'plus'),
          apiCall('GetReportLinks', { PageGroupID: page.PageGroupID }, {}, 'plus'),
          apiCall('GetUserReportPermissions', { Username: username }, {}, 'plus'),
        ]);
        if (cancelled) return;

        setQueries(pq.State === 0 ? (pq.List0 || []) : []);

        const fMeta = allF.State === 0 ? (allF.List0 || []) : [];
        const linkFilterIds = [...new Set((links.List0 || []).map(l => l.QueryFilterID).filter(Boolean))];
        setFilters(linkFilterIds.map(id => fMeta.find(f => f.QueryFilterID === id) || { QueryFilterID: id, FilterName: '#' + id }));

        if (fPerms.State === 0) {
          const m = {};
          (fPerms.List0 || []).forEach(r => {
            if ((r.Username || '').toLowerCase() === username.toLowerCase()) m[r.QueryFilterID] = r.SQLFilter || '';
          });
          setFilterPerms(m);
        }

        setOps(pOps.State === 0 ? (pOps.List0 || []) : []);
        if (oGrants.State === 0) {
          const s = new Set();
          (oGrants.List0 || []).forEach(r => {
            if ((r.Username || '').toLowerCase() === username.toLowerCase()
              && r.PageGroupID === page.PageGroupID && toBool(r.CanPerform)) s.add(r.OperationID);
          });
          setOpGrants(s);
        }

        // distinct reports linked to this page (a report may be linked as Form + Grid)
        const rSeen = new Map();
        (rLinks.State === 0 ? (rLinks.List0 || []) : []).forEach(l => {
          const cur = rSeen.get(l.ReportID);
          if (cur) cur.targets.push(l.Target);
          else rSeen.set(l.ReportID, { ReportID: l.ReportID, ReportName: l.ReportName, ReportCode: l.ReportCode, ReportType: l.ReportType, targets: [l.Target] });
        });
        setReports([...rSeen.values()]);
        if (rGrants.State === 0) {
          const s = new Set();
          (rGrants.List0 || []).forEach(r => {
            if ((r.Username || '').toLowerCase() === username.toLowerCase() && toBool(r.CanRun)) s.add(r.ReportID);
          });
          setReportGrants(s);
        }
      } catch (e) {
        if (!cancelled) setErr('Connection error: ' + e.message);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [username, page.PageGroupID]);

  async function toggleOp(operationId) {
    if (isAdmin) return;
    const next = opGrants.has(operationId) ? 0 : 1;
    setBusyOp(operationId); setErr(null);
    try {
      const res = await apiCall('SaveUserOperationPermission', {
        Username: username, PageGroupID: page.PageGroupID, OperationID: operationId, CanPerform: next,
      }, {}, 'plus');
      if (res.State !== 0) setErr(res.Message || 'Failed to update');
      else setOpGrants(prev => {
        const s = new Set(prev);
        next ? s.add(operationId) : s.delete(operationId);
        return s;
      });
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusyOp(null);
  }

  async function toggleReport(reportId) {
    if (isAdmin) return;
    const next = reportGrants.has(reportId) ? 0 : 1;
    setBusyReport(reportId); setErr(null);
    try {
      const res = await apiCall('SaveUserReportPermission', {
        Username: username, ReportID: reportId, CanRun: next,
      }, {}, 'plus');
      if (res.State !== 0) setErr(res.Message || 'Failed to update');
      else setReportGrants(prev => {
        const s = new Set(prev);
        next ? s.add(reportId) : s.delete(reportId);
        return s;
      });
    } catch (e) { setErr('Connection error: ' + e.message); }
    setBusyReport(null);
  }

  const tabBtn = (key, label, count) => {
    const active = tab === key;
    return (
      <button key={key} onClick={() => setTab(key)} style={{
        appearance: 'none', background: 'none', border: 'none', padding: '12px 12px',
        fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
        color: active ? 'var(--orange)' : 'var(--muted)',
        borderBottom: '2px solid ' + (active ? 'var(--orange)' : 'transparent'), marginBottom: -1,
      }}>{label}{count != null ? ` (${count})` : ''}</button>
    );
  };

  return (
    <>
      <div style={{ padding: '14px 20px 0', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{page.Icon} {page.Label}</div>
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2, fontFamily: 'monospace' }}>page #{page.PageGroupID}</div>
        <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
          {tabBtn('query', 'Query', queries.length)}
          {tabBtn('filters', 'Filters', filters.length)}
          {tabBtn('operations', 'Operations', ops.length)}
          {tabBtn('reports', 'Reports', reports.length)}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {err && <div style={{ background: 'var(--red-soft)', border: '1px solid rgba(220,38,38,0.2)', color: 'var(--red)', padding: 10, borderRadius: 8, fontSize: 12.5, marginBottom: 14 }}>{err}</div>}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : isAdmin ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--orange)', fontSize: 12.5 }}>
            Admin — no per-page restrictions apply.
          </div>
        ) : tab === 'query' ? (
          queries.length === 0 ? (
            <Empty>No query mapped to this page.</Empty>
          ) : queries.map(q => (
            <div key={q.QueryID} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{q.QueryName}</span>
                <span style={{ fontSize: 8, fontWeight: 800, textTransform: 'uppercase', color: 'var(--orange)', background: 'var(--orange-soft)', padding: '2px 5px', borderRadius: 3 }}>{q.QueryType}</span>
              </div>
              <FieldFilterInput queryId={q.QueryID} username={username} />
            </div>
          ))
        ) : tab === 'filters' ? (
          filters.length === 0 ? (
            <Empty>No filters linked to this page. Link them in Group &amp; Page Master → Filters.</Empty>
          ) : filters.map(f => (
            <div key={f.QueryFilterID} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>{f.FilterName}</span>
                {f.ViewName && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{f.ViewName}</span>}
              </div>
              <FilterPermInput username={username} queryFilterID={f.QueryFilterID} initial={filterPerms[f.QueryFilterID] || ''} />
            </div>
          ))
        ) : tab === 'operations' ? (
          ops.length === 0 ? (
            <Empty>No operations linked to this page. Link them in Group &amp; Page Master → Operations.</Empty>
          ) : ops.map(o => (
            <label key={o.OperationID} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
              <input type="checkbox" checked={opGrants.has(o.OperationID)} disabled={busyOp === o.OperationID}
                onChange={() => toggleOp(o.OperationID)} />
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{o.Icon} {o.Label}</span>
              <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{o.OperationKey}</span>
              {o.QueryName && <span style={{ fontSize: 10, color: 'var(--muted)' }}>· {o.QueryName}</span>}
              {busyOp === o.OperationID && <span style={{ fontSize: 10, color: 'var(--muted)' }}>saving…</span>}
            </label>
          ))
        ) : (
          reports.length === 0 ? (
            <Empty>No reports linked to this page. Link them in Group &amp; Page Master → Reports.</Empty>
          ) : reports.map(r => (
            <label key={r.ReportID} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
              <input type="checkbox" checked={reportGrants.has(r.ReportID)} disabled={busyReport === r.ReportID}
                onChange={() => toggleReport(r.ReportID)} />
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>🖨️ {r.ReportName}</span>
              <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{r.ReportCode}</span>
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>· {r.targets.join(' + ')}</span>
              {busyReport === r.ReportID && <span style={{ fontSize: 10, color: 'var(--muted)' }}>saving…</span>}
            </label>
          ))
        )}
      </div>
    </>
  );
}

function Empty({ children }) {
  return <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12.5 }}>{children}</div>;
}

// One editable filter-row-filter cell: free text + Validate + Save.
// Shared field input for a SQL condition. As you type a word, every column
// name containing that word is listed inline below the box as clickable chips
// (no dropdown); clicking one drops it in at the caret.
function ConditionField({ fields, text, setText }) {
  const [caret, setCaret] = useState(0);
  const inputRef = useRef(null);

  const before = text.slice(0, caret);
  const tokenMatch = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const token = tokenMatch ? tokenMatch[0] : '';
  const matches = token
    ? fields.filter(f => f.toLowerCase().includes(token.toLowerCase()))
    : [];

  function insert(field) {
    const start = caret - token.length;
    const next = text.slice(0, start) + field + text.slice(caret);
    setText(next);
    requestAnimationFrame(() => {
      const pos = start + field.length;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }
  const sync = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);

  return (
    <div>
      <input ref={inputRef} value={text}
        onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
        onKeyUp={sync} onClick={sync} spellCheck={false}
        style={{ width: '100%', height: 30, padding: '0 10px', border: '1.5px solid var(--border)', borderRadius: 6, fontSize: 11.5, fontFamily: 'monospace', color: 'var(--text)', background: 'var(--bg)', outline: 'none' }} />
      {token && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
          {matches.length === 0
            ? <span style={{ fontSize: 10, color: 'var(--muted)' }}>no field contains “{token}”</span>
            : matches.map(f => (
              <button key={f} type="button" onMouseDown={(e) => { e.preventDefault(); insert(f); }}
                style={{
                  padding: '3px 8px', fontSize: 10.5, fontFamily: 'monospace', cursor: 'pointer',
                  border: '1px solid var(--border)', borderRadius: 999,
                  background: f.toLowerCase() === token.toLowerCase() ? 'var(--orange-soft)' : 'var(--soft)',
                  color: 'var(--text)',
                }}>
                {f}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

const filterFieldCache = new Map();   // QueryFilterID -> [field names]

function FilterPermInput({ username, queryFilterID, initial }) {
  const [text, setText] = useState(initial);
  const [fields, setFields] = useState(() => filterFieldCache.get(queryFilterID) || []);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => { setText(initial); }, [initial]);

  useEffect(() => {
    if (!queryFilterID) return;
    if (filterFieldCache.has(queryFilterID)) { setFields(filterFieldCache.get(queryFilterID)); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiCall('GetFilterOptions', { QueryFilterID: queryFilterID, Top: 1 }, {}, 'plus');
        const m = (res.List1 || [])[0] || {};
        const names = [...new Set([m.valueField, m.labelField, m.extra1Field, m.extra2Field].filter(Boolean))];
        filterFieldCache.set(queryFilterID, names);
        if (!cancelled) setFields(names);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [queryFilterID]);

  async function handleValidate() {
    setValidating(true); setStatus(null);
    try {
      const res = await apiCall('ValidateFilterCondition', { QueryFilterID: queryFilterID, Condition: text }, {}, 'plus');
      setStatus(res.State === 0 ? { type: 'ok', msg: '✓ Valid' } : { type: 'err', msg: '✕ ' + (res.Message || 'Invalid') });
    } catch (e) { setStatus({ type: 'err', msg: '✕ ' + e.message }); }
    setValidating(false);
  }

  async function handleSave() {
    setSaving(true); setStatus(null);
    try {
      const res = await apiCall('SaveUserFilterPermission', { Username: username, QueryFilterID: queryFilterID, SQLFilter: text }, {}, 'plus');
      setStatus(res.State === 0 ? { type: 'ok', msg: '✓ Saved' } : { type: 'err', msg: '✕ ' + (res.Message || 'Failed') });
    } catch (e) { setStatus({ type: 'err', msg: '✕ ' + e.message }); }
    setSaving(false);
  }

  const btn = { height: 26, padding: '0 10px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--border)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <ConditionField fields={fields} text={text} setText={(t) => { setText(t); setStatus(null); }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" onClick={handleValidate} disabled={validating || !text.trim()} style={{ ...btn, background: 'var(--soft)', color: 'var(--text)' }}>
          {validating ? '…' : 'Validate'}
        </button>
        <button type="button" onClick={handleSave} disabled={saving} style={{ ...btn, background: 'linear-gradient(135deg, var(--orange), var(--orange2))', color: '#fff', border: 'none' }}>
          {saving ? '…' : 'Save'}
        </button>
        {status && <span style={{ fontSize: 10, fontWeight: 700, color: status.type === 'ok' ? 'var(--green)' : 'var(--red)' }}>{status.msg}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Free-text row-filter box that autocompletes the field names of a query.
// ---------------------------------------------------------------------------
const fieldCache = new Map();

function FieldFilterInput({ queryId, username }) {
  const [text, setText] = useState('');
  const [fields, setFields] = useState(() => fieldCache.get(queryId) || []);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!queryId) return;
    if (fieldCache.has(queryId)) { setFields(fieldCache.get(queryId)); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiCall('GetQueryFields', { QueryID: queryId }, {}, 'plus');
        const names = res.State === 0 ? (res.List0 || []).map(f => f.FieldName).filter(Boolean) : [];
        fieldCache.set(queryId, names);
        if (!cancelled) setFields(names);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [queryId]);

  useEffect(() => {
    if (!queryId || !username) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiCall('GetUserQueryPermissions', { Username: username }, {}, 'plus');
        if (res.State === 0 && !cancelled) {
          const row = (res.List0 || []).find(r =>
            r.QueryID === queryId && (r.Username || '').toLowerCase() === username.toLowerCase());
          if (row) setText(row.SQLFilter || '');
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [queryId, username]);

  async function handleValidate() {
    setValidating(true); setStatus(null);
    try {
      const res = await apiCall('ValidateQueryCondition', { QueryID: queryId, Condition: text }, {}, 'plus');
      setStatus(res.State === 0 ? { type: 'ok', msg: '✓ Valid condition' } : { type: 'err', msg: '✕ ' + (res.Message || 'Invalid condition') });
    } catch (e) { setStatus({ type: 'err', msg: '✕ Validation error: ' + e.message }); }
    setValidating(false);
  }

  async function handleSave() {
    setSaving(true); setStatus(null);
    try {
      const res = await apiCall('SaveUserQueryPermission', { Username: username, QueryID: queryId, SQLFilter: text }, {}, 'plus');
      setStatus(res.State === 0 ? { type: 'ok', msg: '✓ Saved' } : { type: 'err', msg: '✕ ' + (res.Message || 'Failed to save') });
    } catch (e) { setStatus({ type: 'err', msg: '✕ Save error: ' + e.message }); }
    setSaving(false);
  }

  const btn = { height: 28, padding: '0 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--border)' };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
      <ConditionField fields={fields} text={text} setText={(t) => { setText(t); setStatus(null); }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={handleValidate} disabled={validating || !text.trim()} style={{ ...btn, background: 'var(--soft)', color: 'var(--text)' }}>
          {validating ? 'Validating…' : 'Validate'}
        </button>
        <button type="button" onClick={handleSave} disabled={saving} style={{ ...btn, background: 'linear-gradient(135deg, var(--orange), var(--orange2))', color: '#fff', border: 'none' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status && <span style={{ fontSize: 10.5, fontWeight: 700, color: status.type === 'ok' ? 'var(--green)' : 'var(--red)' }}>{status.msg}</span>}
      </div>
    </div>
  );
}
