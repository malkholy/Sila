import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Lock, Users, MoreVertical, ShieldCheck, ShieldOff, UserPlus, UserMinus, LogOut, Megaphone } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { loadGroupMembers, setGroupLock, setGroupAdmin, addGroupMembers, removeGroupMember, leaveGroup } from '../../shared/chat.js';
import AddMembersDialog from './AddMembersDialog.jsx';
import ClearSearch from './ClearSearch.jsx';

// The group details panel (opens from the group header): photo, name, member
// count, lock state, who created it and when (GroupMaster.CreatedBy), then the
// Admins and the other Members -- photo, online dot, job title (or @username),
// Admin / Creator badges. Group admins also get Lock chat and, per member,
// Make group admin / Dismiss as admin (Step down for themselves), Add members
// and Remove from group; every member can Leave group. The SP enforces the
// rules (admins only, creator protected, at least one admin, the last admin
// can't leave); remove / leave ask first, in the panel (no browser dialogs).

function MemberMenu({ m, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector('button')?.focus();
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  const item = ({ label, Icon, danger, run }) => (
    <button key={label} role="menuitem" onClick={() => { onClose(); run(); }} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 38, padding: '0 10px', border: 'none',
      borderRadius: 8, background: 'transparent', color: danger ? 'var(--red)' : 'var(--text)', fontFamily: 'var(--font)',
      fontSize: 13, fontWeight: 600, textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap',
    }}><Icon size={16} /> {label}</button>
  );
  return (
    <div ref={ref} role="menu" aria-label={`Options for ${m.name}`} style={{
      position: 'absolute', right: 0, top: 36, zIndex: 30, padding: 6, borderRadius: 12, background: 'var(--surface)',
      border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
    }}>
      {items.map(item)}
    </div>
  );
}

function Badge({ children, tone }) {
  const [fg, bg] = tone === 'admin' ? ['var(--accent-strong)', 'var(--accent-soft)']
    : tone === 'creator' ? ['var(--green)', 'var(--green-soft)'] : ['var(--text2)', 'var(--soft)'];
  return (
    <span style={{ padding: '1px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export default function GroupInfoPanel({ groupId, header, isOnline, onClose, onLockChange, onAdminChange, onMembersChange, onLeft }) {
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);   // { kind: 'remove', m } | { kind: 'leave' }
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [menuFor, setMenuFor] = useState(null);       // member id
  const [adminBusy, setAdminBusy] = useState(null);   // member id
  const [adminError, setAdminError] = useState('');
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState('');
  const toggleLock = async () => {
    setLockBusy(true); setLockError('');
    try { onLockChange?.(await setGroupLock(groupId, !header?.locked)); }
    catch (err) { setLockError(err.message || 'Could not change the setting.'); }
    finally { setLockBusy(false); }
  };
  const [state, setState] = useState({ status: 'loading', members: [], creator: null, error: '' });
  const [q, setQ] = useState('');

  const load = () => {
    setState({ status: 'loading', members: [], creator: null, error: '' });
    loadGroupMembers(groupId)
      .then(({ members, creator }) => setState({ status: 'ready', members, creator, error: '' }))
      .catch(err => setState({ status: 'error', members: [], creator: null, error: err.message || 'Could not load the members.' }));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [groupId]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? state.members.filter(m => [m.name, m.username, m.jobTitle].some(v => v && v.toLowerCase().includes(t))) : state.members;
  }, [state.members, q]);
  const onlineCount = state.members.filter(m => isOnline(m.username)).length;
  const changeAdmin = async (m, admin) => {
    setAdminBusy(m.id); setAdminError('');
    try {
      const r = await setGroupAdmin(groupId, m.id, admin);
      setState(s => ({ ...s, members: s.members.map(x => (x.id === m.id ? { ...x, admin: r.admin } : x)) }));
      onAdminChange?.({ me: m.me, admin: r.admin, system: r.system });
    } catch (err) { setAdminError(err.message || 'Could not change the admin.'); }
    finally { setAdminBusy(null); }
  };
  // what an admin may do to a member (the server checks it all again): a creator
  // can't be dismissed or removed by others; yourself: step down only (Leave is below)
  const menuItems = (m) => {
    if (!header?.isAdmin) return [];
    if (m.me) return m.admin ? [{ label: 'Step down as admin', Icon: ShieldOff, danger: true, run: () => changeAdmin(m, false) }] : [];
    const list = [];
    if (!m.admin) list.push({ label: 'Make group admin', Icon: ShieldCheck, run: () => changeAdmin(m, true) });
    if (m.admin && !m.creator) list.push({ label: 'Dismiss as admin', Icon: ShieldOff, danger: true, run: () => changeAdmin(m, false) });
    if (!m.creator && !header?.broadcast) list.push({ label: 'Remove from group', Icon: UserMinus, danger: true, run: () => { setConfirmError(''); setConfirm({ kind: 'remove', m }); } });
    return list;
  };
  const canManage = (m) => menuItems(m).length > 0;

  const addMembers = async (ids) => {
    const r = await addGroupMembers(groupId, ids);   // errors are shown by the dialog
    onMembersChange?.(r);
    load();
  };
  const runConfirm = async () => {
    setConfirmBusy(true); setConfirmError('');
    try {
      if (confirm.kind === 'remove') {
        const r = await removeGroupMember(groupId, confirm.m.id);
        setState(st => ({ ...st, members: st.members.filter(x => x.id !== confirm.m.id) }));
        onMembersChange?.(r);
        setConfirm(null);
      } else {
        await leaveGroup(groupId);
        setConfirm(null);
        onLeft?.();
      }
    } catch (err) { setConfirmError(err.message || 'Could not complete that.'); }
    finally { setConfirmBusy(false); }
  };
  const admins = shown.filter(m => m.admin);
  const others = shown.filter(m => !m.admin);
  const creator = state.creator;

  const memberRow = (m) => (
    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 48 }}>
      <Avatar name={m.name} size={38} photoUrl={m.photoUrl} online={isOnline(m.username)} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span dir="auto" style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.me ? 'You' : m.name}
        </span>
        <span dir="auto" style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.jobTitle || (m.username ? `@${m.username}` : '')}
        </span>
      </span>
      <span style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
        {m.creator && <Badge tone="creator">Creator</Badge>}
        {m.admin && <Badge tone="admin">Admin</Badge>}
        {canManage(m) && (
          <span style={{ position: 'relative' }}>
            <button onClick={() => setMenuFor(menuFor === m.id ? null : m.id)} disabled={adminBusy === m.id}
              aria-label={`Admin options for ${m.me ? 'you' : m.name}`} aria-haspopup="menu" aria-expanded={menuFor === m.id}
              style={{
                width: 30, height: 30, borderRadius: 15, border: 'none', cursor: adminBusy === m.id ? 'wait' : 'pointer',
                background: menuFor === m.id ? 'var(--border)' : 'transparent', color: 'var(--muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><MoreVertical size={16} /></button>
            {menuFor === m.id && <MemberMenu m={m} items={menuItems(m)} onClose={() => setMenuFor(null)} />}
          </span>
        )}
      </span>
    </div>
  );
  const section = (title, list) => list.length > 0 && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h3 style={{ margin: '4px 0', fontSize: 12, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text2)' }}>
        {title} · {list.length}
      </h3>
      {list.map(memberRow)}
    </div>
  );

  return (
    <aside aria-label="Group details" style={{
      flex: '0 0 320px', maxWidth: '100%', minWidth: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--surface)', borderLeft: '1px solid var(--border)',
    }}>
      <div style={{
        minHeight: 72, padding: '12px 12px 12px 20px', display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <h2 style={{ margin: 0, flex: 1, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>Group info</h2>
        <button onClick={onClose} aria-label="Close group info" style={{
          width: 40, height: 40, borderRadius: 20, border: 'none', background: 'transparent', color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><X size={20} /></button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' }}>
          <Avatar name={header?.title} size={88} photoUrl={header?.photoUrl} />
          <div dir="auto" style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>{header?.title}</div>
          <div style={{ fontSize: 13, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Users size={14} /> Group · {header?.memberCount ?? state.members.length} members
            {state.status === 'ready' && onlineCount > 0 && <span style={{ color: 'var(--online)', fontWeight: 700 }}>· {onlineCount} online</span>}
          </div>
          {creator && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Created by <strong style={{ color: 'var(--text2)' }} dir="auto">{creator.name}</strong>
              {creator.at ? ` · ${creator.at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              {!creator.isMember ? ' · left the group' : ''}
            </div>
          )}
          {header?.broadcast ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontSize: 12, fontWeight: 700,
            }}><Megaphone size={13} /> Broadcast · everyone receives, admins send</div>
          ) : header?.locked && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
              background: 'var(--amber-soft)', color: 'var(--amber)', fontSize: 12, fontWeight: 700,
            }}><Lock size={13} /> Only admins can send messages</div>
          )}
        </div>

        {header?.isAdmin && !header?.broadcast && (
          // group admins: who may send (a broadcast group stays locked)
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, padding: '8px 12px', borderRadius: 12,
              border: '1px solid var(--border)', background: 'var(--soft)', cursor: lockBusy ? 'wait' : 'pointer',
            }}>
              <Lock size={18} style={{ color: header.locked ? 'var(--amber)' : 'var(--text2)', flexShrink: 0 }} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Lock chat</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {header.locked ? 'Only admins can send messages' : 'Everyone can send messages'}
                </span>
              </span>
              <input type="checkbox" role="switch" checked={!!header.locked} disabled={lockBusy} onChange={toggleLock}
                aria-label="Lock chat: only admins can send messages"
                style={{ width: 20, height: 20, accentColor: 'var(--accent)', cursor: 'inherit' }} />
            </label>
            {lockError && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{lockError}</div>}
          </div>
        )}

        <div style={{ height: 1, background: 'var(--border)' }} />

        {header?.isAdmin && !header?.broadcast && (
          <button onClick={() => setAdding(true)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 40, borderRadius: 10,
            border: '1px dashed var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}><UserPlus size={16} /> Add members</button>
        )}

        {confirm && (
          <div role="alertdialog" aria-label="Confirm" style={{
            display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12, background: 'var(--red-soft)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>
              {confirm.kind === 'remove' ? <>Remove <span dir="auto">{confirm.m.name}</span> from the group?</> : 'Leave this group? You will stop getting its messages.'}
            </span>
            {confirmError && <span style={{ fontSize: 12, color: 'var(--red)' }}>{confirmError}</span>}
            <span style={{ display: 'flex', gap: 8 }}>
              <button onClick={runConfirm} disabled={confirmBusy} style={{
                height: 34, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--red)', color: '#fff',
                fontWeight: 700, fontSize: 13, cursor: confirmBusy ? 'wait' : 'pointer', fontFamily: 'var(--font)',
              }}>{confirmBusy ? 'Working…' : confirm.kind === 'remove' ? 'Remove' : 'Leave'}</button>
              <button onClick={() => setConfirm(null)} disabled={confirmBusy} style={{
                height: 34, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
              }}>Cancel</button>
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.members.length > 8 && (
            <>
              <label htmlFor="member-search" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Search members</label>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px', borderRadius: 10,
                background: 'var(--bg)', color: 'var(--muted)',
              }}>
                <Search size={16} />
                <input id="member-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search members" style={{
                  flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13,
                  color: 'var(--text)', fontFamily: 'var(--font)',
                }} />
                <ClearSearch value={q} onClear={() => setQ('')} size={24} style={{ marginRight: -6 }} />
              </div>
            </>
          )}

          {state.status === 'loading' && <div role="status" style={{ color: 'var(--muted)', fontSize: 13, padding: 8 }}>Loading members…</div>}
          {state.status === 'error' && (
            <div role="alert" style={{
              padding: '10px 12px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ flex: 1 }}>{state.error}</span>
              <button onClick={load} style={{
                border: 'none', background: 'transparent', color: 'var(--red)', fontWeight: 800, cursor: 'pointer', fontFamily: 'var(--font)',
              }}>Try again</button>
            </div>
          )}
          {state.status === 'ready' && shown.length === 0 && (
            <div style={{ color: 'var(--muted)', fontSize: 13, padding: 8 }}>No members match.</div>
          )}
          {adminError && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{adminError}</div>}
          {section('Admins', admins)}
          {section('Members', others)}
        </div>

        {state.status === 'ready' && !header?.broadcast && (
          <button onClick={() => { setConfirmError(''); setConfirm({ kind: 'leave' }); }} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 40, marginTop: 4, borderRadius: 10,
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--red)',
            fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}><LogOut size={16} /> Leave group</button>
        )}
      </div>
      {adding && <AddMembersDialog existingIds={state.members.map(m => m.id)} onAdd={addMembers} onClose={() => setAdding(false)} />}
    </aside>
  );
}
