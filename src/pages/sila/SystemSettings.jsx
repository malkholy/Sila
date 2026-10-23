import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, UserCog, Hash, Search, RefreshCw, Lock, AlertTriangle, ArrowUp, ArrowDown, X, Pencil, Plus, UserPlus, UserMinus, Megaphone, MessagesSquare } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { formatWhen } from '../../shared/leftSide.js';
import {
  loadSettingsChannel, loadSettingsChannels, loadSettingsUserGroups, loadSettingsUsers, saveChannelPurpose,
  loadChannelCategories, saveChannel, addChannelMembers, setChannelMember, removeChannelMember,
  loadSettingsUserGroup, saveUserGroup, deleteUserGroup, moveUsersToGroup, saveChannelSla,
  loadSettingsChatGroups, loadSettingsChatGroup, saveChatGroup, setChatGroupAdmin,
} from '../../shared/settings.js';
import { fmtWork } from '../../shared/ticketSla.js';
import AddMembersDialog from './AddMembersDialog.jsx';
import { noWordSelect } from '../../shared/textSelection.js';
import ClearSearch from './ClearSearch.jsx';

// System Settings (user 'mhd' only -- the SP checks it): master lists -- User
// Master, User Group Master (SILA101 dbo.UserGroupMaster), Channel Master.
// Users are read-only. Sila user groups can be added, renamed, deleted when
// empty, and people moved into them (the group drawer). Channels can be added
// and edited, and in the channel drawer their purpose and members (admin /
// team leader roles) too. Group Master: chat groups, normal or Broadcast
// (every active user, admins send), with their admins. Each tab: search, a status filter, sortable columns.

const TABS = [['users', 'User Master', Users], ['groups', 'User Group Master', UserCog], ['chatgroups', 'Group Master', MessagesSquare], ['channels', 'Channel Master', Hash]];

const th = {
  padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase',
  color: 'var(--text2)', whiteSpace: 'nowrap', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 1,
  borderBottom: '1px solid var(--border)',
};
const td = { padding: '8px 12px', borderTop: '1px solid var(--border)', verticalAlign: 'middle', textAlign: 'left' };
const fullDate = (d) => (d ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function Pill({ tone = 'muted', children }) {
  const [fg, bg] = {
    green: ['var(--green)', 'var(--green-soft)'], red: ['var(--red)', 'var(--red-soft)'],
    accent: ['var(--accent-strong)', 'var(--accent-soft)'], blue: ['var(--blue)', 'var(--blue-soft)'],
    muted: ['var(--text2)', 'var(--soft)'],
  }[tone];
  return <span style={{ padding: '1px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>;
}

// A table with clickable column headers (click again to reverse); a row with
// a drawer opens on a double-click.
// columns: [{ key, label, sort?: row => value, render: row => node, align?, width? }]
function Grid({ columns, rows, rowKey, initialSort, onRowClick }) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    const col = columns.find(c => c.key === sort?.key);
    if (!col?.sort) return rows;
    const v = col.sort;
    return [...rows].sort((a, b) => {
      const x = v(a), y = v(b);
      const c = typeof x === 'string' || typeof y === 'string'
        ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? 0) - (y ?? 0);
      return sort.desc ? -c : c;
    });
  }, [rows, columns, sort]);
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(c => {
              const on = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" style={{ ...th, textAlign: c.align || 'left', width: c.width }}>
                  {c.sort ? (
                    <button onClick={() => setSort(s => (s?.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: false }))}
                      style={{
                        border: 'none', background: 'none', padding: 0, font: 'inherit', color: on ? 'var(--accent-strong)' : 'inherit',
                        textTransform: 'inherit', letterSpacing: 'inherit', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}>
                      {c.label}{on && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                    </button>
                  ) : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={rowKey(r)} onMouseDown={onRowClick ? noWordSelect : undefined} onDoubleClick={onRowClick ? () => onRowClick(r) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--orange-soft)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
              {columns.map(c => <td key={c.key} style={{ ...td, textAlign: c.align || 'left' }}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Nothing matches.</div>}
    </div>
  );
}

function Chips({ value, onPick, items }) {
  return (
    <div role="group" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(([k, label]) => {
        const on = k === value;
        return (
          <button key={k} onClick={() => onPick(k)} aria-pressed={on} style={{
            height: 32, padding: '0 12px', borderRadius: 999, cursor: 'pointer', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 700,
            border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
            background: on ? 'var(--accent-soft)' : 'var(--surface)', color: on ? 'var(--accent-strong)' : 'var(--text2)',
          }}>{label}</button>
        );
      })}
    </div>
  );
}

const muted = { fontSize: 12, color: 'var(--muted)' };

// CHA.TicketState -> colour
const STATE_TONE = {
  0: 'var(--blue)', 1: 'var(--green)', 2: 'var(--orange)', 3: 'var(--amber)', 5: 'var(--amber)', 10: 'var(--text2)', 50: 'var(--muted)',
};

function DrawerHeading({ children }) {
  return <h3 style={{ margin: '18px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{children}</h3>;
}

const formField = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border2)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)', lineHeight: '19px',
};
const formBtn = (primary, danger) => ({
  height: 34, padding: '0 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', cursor: 'pointer',
  border: primary || danger ? 'none' : '1px solid var(--border)',
  background: danger ? 'var(--red)' : primary ? 'var(--accent)' : 'var(--surface)',
  color: danger ? '#fff' : primary ? 'var(--on-accent)' : 'var(--text)',
});

// New channel (channel = null) or edit one: name, category, private, active;
// a new one may also get its purpose. onSaved(channelId).
function ChannelForm({ channel, onClose, onSaved }) {
  const isNew = !channel;
  const [cats, setCats] = useState([]);
  const [form, setForm] = useState(() => ({
    name: channel?.name || '', categoryId: channel?.categoryId || 0, isPrivate: !!channel?.private,
    active: channel ? channel.active : true, purpose: '', examples: '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { loadChannelCategories().then(setCats).catch(err => setError(err.message || 'Could not load the categories.')); }, []);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [busy, onClose]);
  const set = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setForm(f => ({ ...f, [k]: v })); };
  const ok = form.name.trim() && Number(form.categoryId) > 0 && !busy;
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError('');
    try {
      const id = await saveChannel({ id: channel?.id || 0, name: form.name.trim(), categoryId: Number(form.categoryId),
        isPrivate: form.isPrivate, active: form.active, purpose: form.purpose.trim(), examples: form.examples.trim() });
      onSaved(id);
    } catch (err) { setError(err.message || 'Could not save the channel.'); setBusy(false); }
  };
  const label = (text, node) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ ...muted, fontWeight: 700 }}>{text}</span>{node}
    </label>
  );
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="chform-title" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={submit} style={{
        width: 'min(520px, 100%)', maxHeight: '92vh', overflowY: 'auto', padding: 20, borderRadius: 16, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font)',
      }}>
        <h2 id="chform-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{isNew ? 'New channel' : 'Edit channel'}</h2>
        {label('Name', <input autoFocus dir="auto" value={form.name} maxLength={100} onChange={set('name')} disabled={busy} style={formField} />)}
        {label('Category', (
          <select value={form.categoryId} onChange={set('categoryId')} disabled={busy} style={formField}>
            <option value={0}>Pick a category</option>
            {cats.map(c => <option key={c.id} value={c.id}>{c.name} ({c.channels})</option>)}
          </select>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
          <input type="checkbox" checked={form.isPrivate} onChange={set('isPrivate')} disabled={busy} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
          Private: only its members can see it and open tickets in it
        </label>
        {!isNew && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.active} onChange={set('active')} disabled={busy} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
            Active (inactive channels are hidden everywhere)
          </label>
        )}
        {isNew && label('What it handles (optional, can be added later)',
          <textarea rows={2} dir="auto" value={form.purpose} maxLength={1000} onChange={set('purpose')} disabled={busy} style={{ ...formField, resize: 'vertical' }} />)}
        {isNew && label('Example requests (separate with ;)',
          <input dir="auto" value={form.examples} maxLength={1000} onChange={set('examples')} disabled={busy} style={formField} />)}
        {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={formBtn(false)}>Cancel</button>
          <button type="submit" disabled={!ok} style={{ ...formBtn(true), opacity: ok ? 1 : 0.5 }}>{busy ? 'Saving…' : isNew ? 'Create channel' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

// The channel's members: add people, switch Admin / Team leader, remove (asked
// first, in the drawer). New tickets copy these roles; existing tickets keep theirs.
function MembersSection({ channelId, members, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);       // user id being changed
  const [confirm, setConfirm] = useState(null);  // member to remove
  const [error, setError] = useState('');
  const run = async (id, fn) => {
    setBusy(id); setError('');
    try { await fn(); await onChanged(); }
    catch (err) { setError(err.message || 'Could not change the member.'); }
    finally { setBusy(null); }
  };
  const managers = members.filter(m => m.admin || m.leader).length;
  const role = (m, key, text) => {
    const on = m[key];
    return (
      <button onClick={() => run(m.id, () => setChannelMember(channelId, m.id, { admin: key === 'admin' ? !on : m.admin, leader: key === 'leader' ? !on : m.leader }))}
        disabled={busy === m.id} aria-pressed={on} title={on ? `Remove ${text.toLowerCase()} role` : `Make ${text.toLowerCase()}`} style={{
          height: 24, padding: '0 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
          border: `1px solid ${on ? 'transparent' : 'var(--border)'}`, whiteSpace: 'nowrap',
          background: on ? (key === 'admin' ? 'var(--accent-soft)' : 'var(--blue-soft)') : 'var(--surface)',
          color: on ? (key === 'admin' ? 'var(--accent-strong)' : 'var(--blue)') : 'var(--muted)',
        }}>{text}</button>
    );
  };
  return (
    <>
      <h3 style={{ margin: '18px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
        Members · {members.length}
        <button onClick={() => setAdding(true)} style={{ ...formBtn(false), height: 26, padding: '0 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none', letterSpacing: 0 }}>
          <UserPlus size={13} /> Add members
        </button>
      </h3>
      {managers === 0 && (
        <div role="note" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 8, borderRadius: 8, background: 'var(--amber-soft)', color: 'var(--amber)', fontSize: 12, fontWeight: 600 }}>
          <AlertTriangle size={14} /> No admin or team leader: new tickets here have nobody to pick them up.
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)', marginBottom: 6 }}>{error}</div>}
      {confirm && (
        <div role="alertdialog" aria-label="Confirm" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 10, marginBottom: 8, borderRadius: 10, background: 'var(--red-soft)' }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Remove <span dir="auto">{confirm.name}</span> from this channel?</span>
          <button onClick={() => { const m = confirm; setConfirm(null); run(m.id, () => removeChannelMember(channelId, m.id)); }} style={formBtn(false, true)}>Remove</button>
          <button onClick={() => setConfirm(null)} style={formBtn(false)}>Cancel</button>
        </div>
      )}
      {members.length === 0 ? <div style={muted}>No members yet.</div> : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {members.map(m => (
            <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', opacity: m.active ? (busy === m.id ? 0.6 : 1) : 0.55 }}>
              <Avatar name={m.name} size={34} photoUrl={m.photoUrl} />
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}><span dir="auto">{m.name}</span>{!m.active && <span style={muted}> · inactive</span>}</span>
                <span style={{ ...muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span dir="auto">{m.title || `@${m.username}`}</span></span>
              </span>
              <span style={{ display: 'flex', gap: 4 }}>{role(m, 'admin', 'Admin')}{role(m, 'leader', 'Team leader')}</span>
              <button onClick={() => setConfirm(m)} disabled={busy === m.id} aria-label={`Remove ${m.name}`} title="Remove from channel" style={{
                width: 28, height: 28, borderRadius: 14, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}><UserMinus size={15} /></button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddMembersDialog title="Add channel members" verb="Add" where="channel" existingIds={members.map(m => m.id)}
          onAdd={async (ids) => { await addChannelMembers(channelId, ids); await onChanged(); }} onClose={() => setAdding(false)} />
      )}
    </>
  );
}

// New Sila user group (group = null) or rename one. onSaved(groupId).
function GroupForm({ group, onClose, onSaved }) {
  const [name, setName] = useState(group?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy) { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [busy, onClose]);
  const ok = name.trim() && name.trim() !== (group?.name || '') && !busy;
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError('');
    try { onSaved(await saveUserGroup(group?.id || 0, name.trim())); }
    catch (err) { setError(err.message || 'Could not save the group.'); setBusy(false); }
  };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ugform-title" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={submit} style={{
        width: 'min(420px, 100%)', padding: 20, borderRadius: 16, background: 'var(--surface)', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font)',
      }}>
        <h2 id="ugform-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{group ? 'Rename group' : 'New user group'}</h2>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...muted, fontWeight: 700 }}>Name</span>
          <input autoFocus dir="auto" value={name} maxLength={100} onChange={e => setName(e.target.value)} disabled={busy} style={formField} />
        </label>
        {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={formBtn(false)}>Cancel</button>
          <button type="submit" disabled={!ok} style={{ ...formBtn(true), opacity: ok ? 1 : 0.5 }}>{busy ? 'Saving…' : group ? 'Save' : 'Create group'}</button>
        </div>
      </form>
    </div>
  );
}

// One Sila user group: its users, Add users (moves them in from their current
// group), Rename, Delete (only when empty). onChanged(): the grid reloads;
// onDeleted(): the drawer closes.
function UserGroupDrawer({ groupId, onClose, onChanged, onDeleted }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const load = useCallback(() => loadSettingsUserGroup(groupId)
    .then(data => setState({ status: 'ready', data, error: '' }))
    .catch(err => setState(s => ({ ...s, status: s.data ? 'ready' : 'error', error: err.message || 'Could not load the group.' }))), [groupId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !renaming && !document.querySelector('[aria-modal="true"]')) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, renaming]);
  const d = state.data;
  const shown = d ? d.users.filter(u => has(q.trim().toLowerCase(), u.name, u.username, u.title)) : [];
  const remove = async () => {
    setBusy(true); setError('');
    try { await deleteUserGroup(groupId); onChanged?.(); onDeleted?.(); }
    catch (err) { setError(err.message || 'Could not delete the group.'); setBusy(false); setConfirmDelete(false); }
  };
  return (
    <>
      <div aria-hidden="true" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.3)', zIndex: 990 }} />
      <aside role="dialog" aria-label="User group details" style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(640px, 94vw)', zIndex: 991, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font)',
      }}>
        <header style={{ flexShrink: 0, padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{
            width: 46, height: 46, borderRadius: 13, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent-soft)', border: '1.5px solid var(--accent-line)', color: 'var(--accent-strong)',
          }}><UserCog size={22} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Sila user group #{groupId}</div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text)' }}><span dir="auto">{d?.group.name || 'Loading…'}</span></h2>
            {d && (
              <div style={{ ...muted, marginTop: 4 }}>
                {d.users.filter(u => u.active).length} active of {d.users.length} users
                {d.group.created && <> · created {fullDate(d.group.created)}{d.group.createdBy && <> by {d.group.createdBy}</>}</>}
              </div>
            )}
          </div>
          {d && <button onClick={() => setRenaming(true)} style={{ ...formBtn(false), height: 40, display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={14} /> Rename</button>}
          <button onClick={onClose} aria-label="Close" style={{
            width: 40, height: 40, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          }}><X size={18} /></button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 20px 24px' }}>
          {state.status === 'loading' && <div role="status" style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>}
          {state.error && <div role="alert" style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>{state.error}</div>}
          {error && <div role="alert" style={{ marginTop: 14, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          {d && (
            <>
              <h3 style={{ margin: '18px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
                Users · {d.users.length}
                <button onClick={() => setAdding(true)} style={{ ...formBtn(false), height: 26, padding: '0 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none', letterSpacing: 0 }}>
                  <UserPlus size={13} /> Add users
                </button>
              </h3>
              <div style={{ ...muted, marginBottom: 8 }}>Adding someone moves them out of their current group. A user is always in exactly one group.</div>
              {d.users.length > 8 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', marginBottom: 6, borderRadius: 8, background: 'var(--bg)', color: 'var(--muted)' }}>
                  <Search size={14} />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search users" aria-label="Search users"
                    style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
                  <ClearSearch value={q} onClear={() => setQ('')} size={24} style={{ marginRight: -6 }} />
                </div>
              )}
              {d.users.length === 0 ? <div style={muted}>Nobody is in this group.</div> : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {shown.map(u => (
                    <li key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', opacity: u.active ? 1 : 0.55 }}>
                      <Avatar name={u.name} size={34} photoUrl={u.photoUrl} />
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}><span dir="auto">{u.name}</span>{!u.active && <span style={muted}> · inactive</span>}</span>
                        <span style={{ ...muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span dir="auto">{u.title || `@${u.username}`}</span></span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 style={{ margin: '22px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Delete group</h3>
              {d.users.length > 0 ? (
                <div style={muted}>Only an empty group can be deleted: move its {d.users.length} users to other groups first.</div>
              ) : confirmDelete ? (
                <div role="alertdialog" aria-label="Confirm" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 10, borderRadius: 10, background: 'var(--red-soft)' }}>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>Delete <span dir="auto">{d.group.name}</span>?</span>
                  <button onClick={remove} disabled={busy} style={formBtn(false, true)}>{busy ? 'Deleting…' : 'Delete'}</button>
                  <button onClick={() => setConfirmDelete(false)} disabled={busy} style={formBtn(false)}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} style={{ ...formBtn(false), color: 'var(--red)' }}>Delete this group</button>
              )}
            </>
          )}
        </div>
      </aside>
      {renaming && d && (
        <GroupForm group={d.group} onClose={() => setRenaming(false)} onSaved={() => { setRenaming(false); load(); onChanged?.(); }} />
      )}
      {adding && d && (
        <AddMembersDialog title={`Add users to ${d.group.name}`} verb="Move here" where="group" existingIds={d.users.map(u => u.id)}
          onAdd={async (ids) => { await moveUsersToGroup(groupId, ids); await load(); onChanged?.(); }} onClose={() => setAdding(false)} />
      )}
    </>
  );
}

// The channel's service-level targets, in working hours (Sat-Thu 08:00-16:00;
// 8 hours = 1 working day). Empty = no target.
function SlaSection({ channelId, channel, onSaved }) {
  const toHours = (m) => (m ? String(Math.round((m / 60) * 100) / 100) : '');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ reply: '', finish: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = () => { setForm({ reply: toHours(channel.replyTarget), finish: toHours(channel.finishTarget) }); setError(''); setEditing(true); };
  const minutes = (h) => (String(h).trim() === '' ? 0 : Math.round(Number(h) * 60));
  const valid = [form.reply, form.finish].every(h => String(h).trim() === '' || (Number(h) > 0 && Number.isFinite(Number(h))));
  const save = async () => {
    if (!valid) return;
    setBusy(true); setError('');
    try { onSaved(await saveChannelSla(channelId, minutes(form.reply), minutes(form.finish))); setEditing(false); }
    catch (err) { setError(err.message || 'Could not save the targets.'); }
    finally { setBusy(false); }
  };
  const show = (m) => (m ? <b style={{ color: 'var(--text)' }}>{fmtWork(m)}</b> : <span style={muted}>no target</span>);
  return (
    <>
      <h3 style={{ margin: '18px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
        Service level
        {!editing && (
          <button onClick={start} style={{ ...formBtn(false), height: 26, padding: '0 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none', letterSpacing: 0 }}>
            <Pencil size={12} /> Edit
          </button>
        )}
      </h3>
      {!editing ? (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13, color: 'var(--text2)' }}>
          <span>First reply within {show(channel.replyTarget)}</span>
          <span>Finished within {show(channel.finishTarget)}</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[['reply', 'First reply within (hours)'], ['finish', 'Finished within (hours)']].map(([k, label]) => (
              <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 180px' }}>
                <span style={{ ...muted, fontWeight: 700 }}>{label}</span>
                <input type="number" min="0" step="0.5" value={form[k]} disabled={busy} placeholder="no target"
                  onChange={e => { const v = e.target.value; setForm(f => ({ ...f, [k]: v })); }} style={formField} />
                <span style={muted}>{form[k] && Number(form[k]) > 0 ? `= ${fmtWork(minutes(form[k]))} working time` : 'Empty = no target'}</span>
              </label>
            ))}
          </div>
          <div style={muted}>Working hours: Saturday to Thursday, 08:00–16:00. 8 hours = 1 working day.</div>
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={busy || !valid} style={{ ...formBtn(true), opacity: valid ? 1 : 0.5 }}>{busy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={busy} style={formBtn(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

const PURPOSE_MAX = 1000;
// What the channel handles (dbo.SilaChannelPurpose): read, or edited in place.
// People see it in the New ticket picker; the assistant offers only channels
// with "Suggest in the assistant" on.
function PurposeSection({ channelId, channel, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ purpose: '', examples: '', offer: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = () => { setForm({ purpose: channel.purpose, examples: channel.examples, offer: channel.offer || !channel.purpose }); setError(''); setEditing(true); };
  const save = async () => {
    setBusy(true); setError('');
    try { onSaved(await saveChannelPurpose(channelId, form)); setEditing(false); }
    catch (err) { setError(err.message || 'Could not save.'); }
    finally { setBusy(false); }
  };
  const field = {
    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border2)',
    background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)', lineHeight: '19px',
  };
  const btn = (primary) => ({
    height: 34, padding: '0 14px', borderRadius: 8, fontWeight: 700, fontSize: 13, fontFamily: 'var(--font)', cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--on-accent)' : 'var(--text)',
  });
  return (
    <>
      <h3 style={{ margin: '18px 0 8px', fontSize: 12, fontWeight: 800, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.04em', display: 'flex', alignItems: 'center', gap: 8 }}>
        What this channel handles
        {!editing && (
          <button onClick={start} style={{ ...btn(false), height: 26, padding: '0 9px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none', letterSpacing: 0 }}>
            <Pencil size={12} /> {channel.purpose ? 'Edit' : 'Add'}
          </button>
        )}
      </h3>
      {!editing ? (
        channel.purpose ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <div dir="auto" style={{ fontSize: 13, color: 'var(--text)', lineHeight: '19px' }}>{channel.purpose}</div>
            {channel.examples && <div dir="auto" style={muted}>For example: {channel.examples}</div>}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Pill tone={channel.offer ? 'green' : 'muted'}>{channel.offer ? 'Suggested by the assistant' : 'Not suggested by the assistant'}</Pill>
              {channel.purposeAt && <span style={muted}>Updated {fullDate(channel.purposeAt)}{channel.purposeBy && <> by <span dir="auto">{channel.purposeBy}</span></>}</span>}
            </div>
          </div>
        ) : <div style={muted}>Not described yet. People choosing a channel see this text.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...muted, fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
              Purpose<span>{form.purpose.length}/{PURPOSE_MAX}</span>
            </span>
            <textarea rows={3} dir="auto" value={form.purpose} maxLength={PURPOSE_MAX} disabled={busy}
              onChange={e => { const v = e.target.value; setForm(f => ({ ...f, purpose: v })); }} style={{ ...field, resize: 'vertical' }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...muted, fontWeight: 700 }}>Example requests (separate with ;)</span>
            <input dir="auto" value={form.examples} maxLength={PURPOSE_MAX} disabled={busy}
              onChange={e => { const v = e.target.value; setForm(f => ({ ...f, examples: v })); }} style={field} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.offer} disabled={busy}
              onChange={e => { const v = e.target.checked; setForm(f => ({ ...f, offer: v })); }}
              style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
            Suggest in the assistant
          </label>
          {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={busy || !form.purpose.trim()} style={{ ...btn(true), opacity: form.purpose.trim() ? 1 : 0.5 }}>{busy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={busy} style={btn(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

// One channel: what it is and handles, its members, its tickets by status, the newest tickets.
// onPurposeSaved(channelId, saved): the grid's Purpose column follows the edit.
// onChanged(): members / name / category changed -- the grid reloads its counts.
function ChannelDrawer({ channelId, onClose, onPurposeSaved, onChanged }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading', data: null, error: '' });
    loadSettingsChannel(channelId)
      .then(data => { if (alive) setState({ status: 'ready', data, error: '' }); })
      .catch(err => { if (alive) setState({ status: 'error', data: null, error: err.message || 'Could not load the channel.' }); });
    return () => { alive = false; };
  }, [channelId]);
  // after a change: read the channel again, keeping it on screen meanwhile
  const refresh = useCallback(async () => {
    const data = await loadSettingsChannel(channelId);
    setState({ status: 'ready', data, error: '' });
    onChanged?.();
  }, [channelId, onChanged]);
  useEffect(() => {
    // not while a dialog over the drawer (Add members, Edit) takes the key
    const esc = (e) => { if (e.key === 'Escape' && !editing && !document.querySelector('[aria-modal="true"]')) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, editing]);

  const d = state.data;
  const total = d ? d.states.reduce((n, x) => n + x.count, 0) : 0;
  const open = d ? d.states.filter(x => x.state < 50).reduce((n, x) => n + x.count, 0) : 0;
  const cards = d ? [
    ['Members', d.members.length], ['Admins', d.members.filter(m => m.admin).length],
    ['Team leaders', d.members.filter(m => m.leader).length], ['Open tickets', open], ['All tickets', total.toLocaleString()],
  ] : [];

  return (
    <>
      <div aria-hidden="true" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.3)', zIndex: 990 }} />
      <aside role="dialog" aria-label="Channel details" style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(760px, 94vw)', zIndex: 991, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font)',
      }}>
        <header style={{ flexShrink: 0, padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{
            width: 46, height: 46, borderRadius: 13, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent-soft)', border: '1.5px solid var(--accent-line)', color: 'var(--accent-strong)',
          }}><Hash size={22} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
              Channel #{channelId}{d?.channel.category ? <> · <span dir="auto">{d.channel.category}</span></> : ''}
            </div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span dir="auto">{d?.channel.name || 'Loading…'}</span>
              {d?.channel.private && <Lock size={15} style={{ color: 'var(--amber)' }} aria-label="Private" />}
            </h2>
            {d && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <Pill tone={d.channel.private ? 'accent' : 'blue'}>{d.channel.private ? 'Private' : 'Public'}</Pill>
                <Pill tone={d.channel.active ? 'green' : 'red'}>{d.channel.active ? 'Active' : 'Inactive'}</Pill>
              </div>
            )}
          </div>
          {d && (
            <button onClick={() => setEditing(true)} style={{ ...formBtn(false), height: 40, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <Pencil size={14} /> Edit
            </button>
          )}
          <button onClick={onClose} aria-label="Close" style={{
            width: 40, height: 40, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          }}><X size={18} /></button>
        </header>
        {editing && d && (
          <ChannelForm channel={{ ...d.channel, id: channelId }} onClose={() => setEditing(false)}
            onSaved={() => { setEditing(false); refresh().catch(() => {}); }} />
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 20px 24px' }}>
          {state.status === 'loading' && <div role="status" style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>}
          {state.status === 'error' && <div role="alert" style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>{state.error}</div>}
          {d && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, marginTop: 14 }}>
                {cards.map(([k, v]) => (
                  <div key={k} style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--bg)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{k}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ ...muted, marginTop: 10 }}>
                Created {fullDate(d.channel.created) || '-'}{d.channel.createdBy && <> by <span dir="auto">{d.channel.createdBy}</span></>}
                {d.channel.changed && <> · last changed {fullDate(d.channel.changed)}{d.channel.changedBy && <> by <span dir="auto">{d.channel.changedBy}</span></>}</>}
              </div>

              <PurposeSection channelId={channelId} channel={d.channel} onSaved={(saved) => {
                setState(s => ({ ...s, data: { ...s.data, channel: { ...s.data.channel, ...saved } } }));
                onPurposeSaved?.(channelId, saved);
              }} />

              <DrawerHeading>Tickets by status</DrawerHeading>
              {d.states.length === 0 ? <div style={muted}>No tickets yet.</div> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {d.states.map(x => (
                    <div key={x.state} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 70px', alignItems: 'center', gap: 10, fontSize: 13 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 4, background: STATE_TONE[x.state] || 'var(--muted)' }} />{x.label}
                      </span>
                      <span style={{ height: 8, borderRadius: 4, background: 'var(--soft)', overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: `${total ? Math.max(2, (x.count / total) * 100) : 0}%`, background: STATE_TONE[x.state] || 'var(--muted)' }} />
                      </span>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700 }}>{x.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}

              <SlaSection channelId={channelId} channel={d.channel} onSaved={(saved) => {
                setState(s => ({ ...s, data: { ...s.data, channel: { ...s.data.channel, ...saved } } }));
              }} />

              <MembersSection channelId={channelId} members={d.members} onChanged={refresh} />

              <DrawerHeading>Newest tickets</DrawerHeading>
              {d.tickets.length === 0 ? <div style={muted}>No tickets yet.</div> : (
                <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr>
                      {['Ticket', 'Subject', 'Status', 'Created by', 'Last update'].map(h => <th key={h} scope="col" style={{ ...th, position: 'static' }}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {d.tickets.map(t => (
                        <tr key={t.id}>
                          <td style={{ ...td, fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>#{t.id}</td>
                          <td style={{ ...td, fontWeight: 600 }}><span dir="auto">{t.subject}</span></td>
                          <td style={td}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                              <span style={{ width: 8, height: 8, borderRadius: 4, background: STATE_TONE[t.state] || 'var(--muted)' }} />{t.stateLabel}
                            </span>
                          </td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}><span dir="auto">{t.createdBy}</span></td>
                          <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text2)' }}>{formatWhen(t.last)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
// Group master: new chat group (group = null) or rename / change its type.
// Broadcast = every active user is in it and only its admins send. A new group
// may get more admins (the signed-in user is always creator + admin). onSaved(groupId).
function ChatGroupForm({ group, activeUsers, onClose, onSaved }) {
  const isNew = !group;
  const [name, setName] = useState(group?.name || '');
  const [broadcast, setBroadcast] = useState(!!group?.broadcast);
  const [admins, setAdmins] = useState([]);       // [{ id, name }] -- new group only
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !busy && !picking) { e.stopImmediatePropagation(); onClose(); } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  }, [busy, picking, onClose]);
  const changed = isNew || name.trim() !== group.name || broadcast !== group.broadcast;
  const ok = name.trim() && changed && !busy;
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setError('');
    try {
      const r = await saveChatGroup({ id: group?.id || 0, name: name.trim(), broadcast, adminIds: admins.map(a => a.id) });
      onSaved(r.id);
    } catch (err) { setError(err.message || 'Could not save the group.'); setBusy(false); }
  };
  const typeOption = (value, title, text) => (
    <label style={{
      display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
      border: `1.5px solid ${broadcast === value ? 'var(--accent)' : 'var(--border)'}`,
      background: broadcast === value ? 'var(--accent-soft)' : 'var(--surface)',
    }}>
      <input type="radio" name="cg-type" checked={broadcast === value} onChange={() => setBroadcast(value)} disabled={busy}
        style={{ width: 16, height: 16, marginTop: 2, accentColor: 'var(--accent)' }} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
        <span style={muted}>{text}</span>
      </span>
    </label>
  );
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cgform-title" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={submit} style={{
        width: 'min(480px, 100%)', maxHeight: '92vh', overflowY: 'auto', padding: 20, borderRadius: 16, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: 'var(--font)',
      }}>
        <h2 id="cgform-title" style={{ margin: 0, fontSize: 17, fontWeight: 800, color: 'var(--text)' }}>{isNew ? 'New group' : 'Edit group'}</h2>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ ...muted, fontWeight: 700 }}>Name</span>
          <input autoFocus dir="auto" value={name} maxLength={50} onChange={e => setName(e.target.value)} disabled={busy} style={formField} />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ ...muted, fontWeight: 700 }}>Type</span>
          {typeOption(false, 'Group', 'Members are added by hand; everyone in it can send (unless an admin locks it).')}
          {typeOption(true, 'Broadcast', `Announcements for everyone: no members to pick. All ${activeUsers || ''} active users see it, and every new user too. Only its admins send.`)}
        </div>
        {!isNew && group.broadcast && !broadcast && (
          <div role="note" style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--amber-soft)', color: 'var(--amber)', fontSize: 12, fontWeight: 600 }}>
            Its {group.members} members stay in it, and everyone will be able to send. Remove people from the group's own panel if needed.
          </div>
        )}
        {isNew && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...muted, fontWeight: 700 }}>Admins (you are one already){broadcast ? ' -- they send the announcements' : ''}</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {admins.map(a => (
                <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 10px', borderRadius: 999, background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontSize: 12, fontWeight: 700 }}>
                  <span dir="auto">{a.name}</span>
                  <button type="button" onClick={() => setAdmins(list => list.filter(x => x.id !== a.id))} aria-label={`Remove ${a.name}`} disabled={busy}
                    style={{ width: 20, height: 20, border: 'none', borderRadius: 10, background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <button type="button" onClick={() => setPicking(true)} disabled={busy} style={{ ...formBtn(false), height: 28, padding: '0 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <UserPlus size={13} /> Add admins
              </button>
            </div>
          </div>
        )}
        {error && <div role="alert" style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={formBtn(false)}>Cancel</button>
          <button type="submit" disabled={!ok} style={{ ...formBtn(true), opacity: ok ? 1 : 0.5 }}>
            {busy ? 'Saving…' : isNew ? 'Create group' : 'Save'}
          </button>
        </div>
      </form>
      {picking && (
        <AddMembersDialog title="Group admins" verb="Add" where="group" existingIds={admins.map(a => a.id)}
          onAdd={async (ids, users) => {
            const byId = new Map((users || []).map(u => [u.id, u.name]));
            setAdmins(list => [...list, ...ids.filter(id => !list.some(a => a.id === id)).map(id => ({ id, name: byId.get(id) || `#${id}` }))]);
          }} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

// One chat group: type, members (admins first) with the Admin role switch, Edit.
// A broadcast group's members are every active user, kept by the server.
function ChatGroupDrawer({ groupId, activeUsers, onClose, onChanged }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const load = useCallback(() => loadSettingsChatGroup(groupId)
    .then(data => setState({ status: 'ready', data, error: '' }))
    .catch(err => setState(s => ({ ...s, status: s.data ? 'ready' : 'error', error: err.message || 'Could not load the group.' }))), [groupId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !editing && !document.querySelector('[aria-modal="true"]')) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, editing]);
  const d = state.data;
  const shown = d ? d.members.filter(m => has(q.trim().toLowerCase(), m.name, m.username, m.title)) : [];
  const toggleAdmin = async (m) => {
    setBusy(m.id); setError('');
    try { await setChatGroupAdmin(groupId, m.id, !m.admin); await load(); onChanged?.(); }
    catch (err) { setError(err.message || 'Could not change the admin.'); }
    finally { setBusy(null); }
  };
  return (
    <>
      <div aria-hidden="true" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.3)', zIndex: 990 }} />
      <aside role="dialog" aria-label="Group details" style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(640px, 94vw)', zIndex: 991, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font)',
      }}>
        <header style={{ flexShrink: 0, padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{
            width: 46, height: 46, borderRadius: 13, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent-soft)', border: '1.5px solid var(--accent-line)', color: 'var(--accent-strong)',
          }}>{d?.group.broadcast ? <Megaphone size={22} /> : <Users size={22} />}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{d?.group.broadcast ? 'Broadcast group' : 'Group'} #{groupId}</div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text)' }}><span dir="auto">{d?.group.name || 'Loading…'}</span></h2>
            {d && (
              <div style={{ ...muted, marginTop: 4 }}>
                {d.members.length} members · {d.members.filter(m => m.admin).length} admins
                {d.group.created && <> · created {fullDate(d.group.created)}{d.group.createdBy && <> by <span dir="auto">{d.group.createdBy}</span></>}</>}
              </div>
            )}
          </div>
          {d && <button onClick={() => setEditing(true)} style={{ ...formBtn(false), height: 40, display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={14} /> Edit</button>}
          <button onClick={onClose} aria-label="Close" style={{
            width: 40, height: 40, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          }}><X size={18} /></button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 20px 24px' }}>
          {state.status === 'loading' && <div role="status" style={{ padding: 24, color: 'var(--muted)' }}>Loading…</div>}
          {state.error && <div role="alert" style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>{state.error}</div>}
          {d && d.group.broadcast && (
            <div role="note" style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontSize: 13, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Megaphone size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Every active user is in this group automatically ({d.group.activeMembers} of {d.group.activeUsers || activeUsers} now): a new
                user joins the moment the account is created, a deactivated one leaves. Only its admins send. Make someone an admin below to let them post.
              </span>
            </div>
          )}
          {error && <div role="alert" style={{ marginTop: 14, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          {d && (
            <>
              <DrawerHeading>Members · {d.members.length}</DrawerHeading>
              {d.members.length > 8 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px', marginBottom: 6, borderRadius: 8, background: 'var(--bg)', color: 'var(--muted)' }}>
                  <Search size={14} />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search members" aria-label="Search members"
                    style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
                  <ClearSearch value={q} onClear={() => setQ('')} size={24} style={{ marginRight: -6 }} />
                </div>
              )}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {shown.map(m => (
                  <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)', opacity: m.active ? (busy === m.id ? 0.6 : 1) : 0.55 }}>
                    <Avatar name={m.name} size={34} photoUrl={m.photoUrl} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                        <span dir="auto">{m.name}</span>{m.creator && <span style={muted}> · creator</span>}{!m.active && <span style={muted}> · inactive</span>}
                      </span>
                      <span style={{ ...muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span dir="auto">{m.title || `@${m.username}`}</span></span>
                    </span>
                    <button onClick={() => toggleAdmin(m)} disabled={busy === m.id} aria-pressed={m.admin}
                      title={m.admin ? 'Dismiss as admin' : 'Make admin'} style={{
                        height: 24, padding: '0 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
                        border: `1px solid ${m.admin ? 'transparent' : 'var(--border)'}`, whiteSpace: 'nowrap',
                        background: m.admin ? 'var(--accent-soft)' : 'var(--surface)', color: m.admin ? 'var(--accent-strong)' : 'var(--muted)',
                      }}>Admin</button>
                  </li>
                ))}
              </ul>
              {shown.length === 0 && <div style={muted}>No members match.</div>}
            </>
          )}
        </div>
      </aside>
      {editing && d && (
        <ChatGroupForm group={{ ...d.group, members: d.members.length }} activeUsers={d.group.activeUsers || activeUsers}
          onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChanged?.(); }} />
      )}
    </>
  );
}
const has = (q, ...texts) => !q || texts.some(t => t && String(t).toLowerCase().includes(q));

export default function SystemSettings() {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('silaSettingsTab') || 'users'; } catch { return 'users'; } });
  const pickTab = (t) => { setTab(t); try { localStorage.setItem('silaSettingsTab', t); } catch { /* not remembered */ } };
  const [data, setData] = useState({ users: null, groups: null, channels: null, chatGroups: null });
  const [state, setState] = useState({ status: 'loading', error: '' });
  const [q, setQ] = useState('');
  const [userFilter, setUserFilter] = useState('active');
  const [channelFilter, setChannelFilter] = useState('active');
  const [channelId, setChannelId] = useState(null);   // the channel details drawer
  const [newChannel, setNewChannel] = useState(false);
  const [groupId, setGroupId] = useState(null);       // the user group drawer
  const [newGroup, setNewGroup] = useState(false);
  const [chatGroupId, setChatGroupId] = useState(null);   // the chat group drawer
  const [newChatGroup, setNewChatGroup] = useState(false);
  const [chatGroupFilter, setChatGroupFilter] = useState('all');
  const closeChatGroup = useCallback(() => setChatGroupId(null), []);
  const closeGroup = useCallback(() => setGroupId(null), []);
  const closeChannel = useCallback(() => setChannelId(null), []);

  const load = useCallback(() => {
    setState({ status: 'loading', error: '' });
    Promise.all([loadSettingsUsers(), loadSettingsUserGroups(), loadSettingsChannels(), loadSettingsChatGroups()])
      .then(([users, groups, channels, chatGroups]) => { setData({ users, groups, channels, chatGroups }); setState({ status: 'ready', error: '' }); })
      .catch(err => setState({ status: 'error', error: err.message || 'Could not load the settings.' }));
  }, []);
  useEffect(() => { load(); }, [load]);
  // a user group was added / renamed / deleted or got users: the groups (and users) reload quietly
  const reloadGroups = useCallback(() => {
    Promise.all([loadSettingsUserGroups(), loadSettingsUsers()])
      .then(([groups, users]) => setData(dd => ({ ...dd, groups, users }))).catch(() => { /* the next Refresh */ });
  }, []);
  // a chat group was added or changed: the group master reloads quietly
  const reloadChatGroups = useCallback(() => {
    loadSettingsChatGroups().then(chatGroups => setData(dd => ({ ...dd, chatGroups }))).catch(() => { /* the next Refresh */ });
  }, []);
  // a channel was added or changed: its row (counts, name, category) reloads quietly
  const reloadChannels = useCallback(() => {
    loadSettingsChannels().then(channels => setData(dd => ({ ...dd, channels }))).catch(() => { /* the next Refresh */ });
  }, []);

  const needle = q.trim().toLowerCase();
  const users = (data.users || []).filter(u => (userFilter === 'all' || (userFilter === 'active') === u.active)
    && has(needle, u.name, u.username, u.job, u.department, u.quickGroup, u.silaGroup, u.mobile, u.local, u.id));
  const groups = (data.groups?.groups || []).filter(g => has(needle, g.name, g.id, g.createdBy));
  const channels = (data.channels || []).filter(c => (channelFilter === 'all' || (channelFilter === 'active') === c.active)
    && has(needle, c.name, c.category, c.id, c.createdBy, c.purpose));
  const chatGroups = (data.chatGroups?.groups || []).filter(g => (chatGroupFilter === 'all' || (chatGroupFilter === 'broadcast') === g.broadcast)
    && has(needle, g.name, g.id, g.createdBy));
  const counts = { users: data.users?.length ?? 0, groups: data.groups?.groups.length ?? 0, channels: data.channels?.length ?? 0,
    chatgroups: data.chatGroups?.groups.length ?? 0 };

  const userCols = [
    { key: 'name', label: 'User', sort: u => u.name.toLowerCase(), render: u => (
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200 }}>
        <Avatar name={u.name} size={32} photoUrl={u.photoUrl} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontWeight: 700, color: 'var(--text)' }}><span dir="auto">{u.name}</span></span>
          <span style={muted}>@{u.username} · #{u.id}</span>
        </span>
      </span>
    ) },
    { key: 'job', label: 'Job · Department', sort: u => u.job.toLowerCase(), render: u => (
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
        <span style={{ color: 'var(--text)' }}><span dir="auto">{u.job || '-'}</span></span>
        {u.department && <span style={muted}><span dir="auto">{u.department}</span></span>}
      </span>
    ) },
    { key: 'quick', label: 'User group', sort: u => u.quickGroup.toLowerCase(), render: u => <span dir="auto">{u.quickGroup || '-'}</span> },
    { key: 'sila', label: 'Sila group', sort: u => u.silaGroupId ?? 0, render: u => (u.silaGroup
      ? <span dir="auto">{u.silaGroup}</span>
      : <span style={{ ...muted, color: u.silaGroupId ? 'var(--amber)' : 'var(--muted)' }} title={u.silaGroupId ? 'Not in dbo.UserGroupMaster' : undefined}>
        {u.silaGroupId ? `ID ${u.silaGroupId} (missing)` : '-'}</span>) },
    { key: 'phone', label: 'Phone', render: u => (
      <span style={{ display: 'flex', flexDirection: 'column', fontFamily: 'var(--mono)', fontSize: 12 }}>
        <span>{u.mobile || '-'}</span>{u.local && <span style={muted}>ext {u.local}</span>}
      </span>
    ) },
    { key: 'roles', label: 'Roles', sort: u => (u.admin ? 2 : 0) + (u.developer ? 1 : 0), render: u => (
      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {u.admin && <Pill tone="accent">Admin</Pill>}{u.developer && <Pill tone="blue">Developer</Pill>}
        {u.forceLogout && <Pill tone="red">Force logout</Pill>}{!u.admin && !u.developer && !u.forceLogout && <span style={muted}>-</span>}
      </span>
    ) },
    { key: 'status', label: 'Status', sort: u => (u.active ? 0 : 1), render: u => <Pill tone={u.active ? 'green' : 'red'}>{u.active ? 'Active' : 'Inactive'}</Pill> },
    { key: 'created', label: 'Created', sort: u => u.created?.getTime() || 0, render: u => (
      <span style={{ display: 'flex', flexDirection: 'column', whiteSpace: 'nowrap' }}>
        <span>{fullDate(u.created) || '-'}</span>{u.createdBy && <span style={muted}>by {u.createdBy}</span>}
      </span>
    ) },
    { key: 'pwd', label: 'Password changed', sort: u => u.passwordChanged?.getTime() || 0, render: u => (
      u.passwordChanged ? <span style={{ whiteSpace: 'nowrap' }}>{formatWhen(u.passwordChanged)}</span> : <span style={{ ...muted, color: 'var(--amber)' }}>never</span>
    ) },
  ];

  const groupCols = [
    { key: 'id', label: 'ID', sort: g => g.id, render: g => <span style={{ fontFamily: 'var(--mono)' }}>{g.id}</span>, width: 70 },
    { key: 'name', label: 'Group', sort: g => g.name.toLowerCase(), render: g => (
      <button onClick={(e) => { e.stopPropagation(); setGroupId(g.id); }} style={{
        padding: 0, border: 'none', background: 'none', font: 'inherit', fontWeight: 700, color: 'var(--accent-strong)', cursor: 'pointer',
        textDecoration: 'underline', textDecorationColor: 'var(--accent-line)', textAlign: 'left',
      }}><span dir="auto">{g.name}</span></button>
    ) },
    { key: 'active', label: 'Active users', sort: g => g.activeUsers, align: 'right', render: g => <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{g.activeUsers}</span> },
    { key: 'all', label: 'All users', sort: g => g.allUsers, align: 'right', render: g => <span style={{ fontFamily: 'var(--mono)' }}>{g.allUsers}</span> },
    { key: 'created', label: 'Created', sort: g => g.created?.getTime() || 0, render: g => <span>{fullDate(g.created) || '-'}{g.createdBy && <span style={muted}> · {g.createdBy}</span>}</span> },
    { key: 'changed', label: 'Last changed', sort: g => g.changed?.getTime() || 0, render: g => <span>{fullDate(g.changed) || '-'}{g.changedBy && <span style={muted}> · {g.changedBy}</span>}</span> },
  ];

  const chatGroupCols = [
    { key: 'id', label: 'ID', sort: g => g.id, render: g => <span style={{ fontFamily: 'var(--mono)' }}>{g.id}</span>, width: 70 },
    { key: 'name', label: 'Group', sort: g => g.name.toLowerCase(), render: g => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
        {g.broadcast ? <Megaphone size={13} style={{ color: 'var(--accent-strong)' }} /> : <Users size={13} style={{ color: 'var(--muted)' }} />}
        <button onClick={(e) => { e.stopPropagation(); setChatGroupId(g.id); }} style={{
          padding: 0, border: 'none', background: 'none', font: 'inherit', color: 'var(--accent-strong)', cursor: 'pointer',
          textDecoration: 'underline', textDecorationColor: 'var(--accent-line)', textAlign: 'left',
        }}><span dir="auto">{g.name}</span></button>
        {g.locked && !g.broadcast && <Lock size={12} style={{ color: 'var(--amber)' }} aria-label="Locked" />}
      </span>
    ) },
    { key: 'type', label: 'Type', sort: g => (g.broadcast ? 0 : 1), render: g => <Pill tone={g.broadcast ? 'accent' : 'blue'}>{g.broadcast ? 'Broadcast' : 'Group'}</Pill> },
    { key: 'members', label: 'Members', sort: g => g.members, align: 'right', render: g => (
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{g.members}</span>
        <span style={muted}>{g.admins} admin{g.admins === 1 ? '' : 's'}</span>
      </span>
    ) },
    { key: 'last', label: 'Last activity', sort: g => g.changed?.getTime() || 0, render: g => <span style={{ whiteSpace: 'nowrap' }}>{g.changed ? formatWhen(g.changed) : '-'}</span> },
    { key: 'created', label: 'Created', sort: g => g.created?.getTime() || 0, render: g => <span style={{ whiteSpace: 'nowrap' }}>{fullDate(g.created) || '-'}{g.createdBy && <span style={muted}> · {g.createdBy}</span>}</span> },
  ];

  const channelCols = [
    { key: 'id', label: 'ID', sort: c => c.id, render: c => <span style={{ fontFamily: 'var(--mono)' }}>{c.id}</span>, width: 70 },
    { key: 'name', label: 'Channel', sort: c => c.name.toLowerCase(), render: c => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
        <Hash size={13} style={{ color: 'var(--muted)' }} />
        <button onClick={(e) => { e.stopPropagation(); setChannelId(c.id); }} style={{
          padding: 0, border: 'none', background: 'none', font: 'inherit', color: 'var(--accent-strong)', cursor: 'pointer',
          textDecoration: 'underline', textDecorationColor: 'var(--accent-line)', textAlign: 'left',
        }}><span dir="auto">{c.name}</span></button>
        {c.private && <Lock size={12} style={{ color: 'var(--amber)' }} aria-label="Private" />}
      </span>
    ) },
    { key: 'category', label: 'Category', sort: c => c.category.toLowerCase(), render: c => <span dir="auto">{c.category || '-'}</span> },
    { key: 'purpose', label: 'Handles', sort: c => c.purpose.toLowerCase(), render: c => (c.purpose ? (
      <span title={c.purpose} dir="auto" style={{
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: 340, minWidth: 200,
        fontSize: 12, color: c.offer ? 'var(--text2)' : 'var(--muted)', whiteSpace: 'normal',
      }}>{c.purpose}</span>
    ) : <span style={{ ...muted, color: 'var(--amber)' }}>not described</span>) },
    { key: 'members', label: 'Members', sort: c => c.members, align: 'right', render: c => (
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{c.members}</span>
        {(c.admins > 0 || c.leaders > 0) && <span style={muted}>{c.admins} admin · {c.leaders} lead</span>}
      </span>
    ) },
    { key: 'open', label: 'Open tickets', sort: c => c.openTickets, align: 'right', render: c => <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: c.openTickets ? 'var(--accent-strong)' : 'var(--muted)' }}>{c.openTickets}</span> },
    { key: 'all', label: 'All tickets', sort: c => c.allTickets, align: 'right', render: c => <span style={{ fontFamily: 'var(--mono)' }}>{c.allTickets.toLocaleString()}</span> },
    { key: 'type', label: 'Type', sort: c => (c.private ? 1 : 0), render: c => <Pill tone={c.private ? 'accent' : 'blue'}>{c.private ? 'Private' : 'Public'}</Pill> },
    { key: 'status', label: 'Status', sort: c => (c.active ? 0 : 1), render: c => <Pill tone={c.active ? 'green' : 'red'}>{c.active ? 'Active' : 'Inactive'}</Pill> },
    { key: 'created', label: 'Created', sort: c => c.created?.getTime() || 0, render: c => <span style={{ whiteSpace: 'nowrap' }}>{fullDate(c.created) || '-'}{c.createdBy && <span style={muted}> · {c.createdBy}</span>}</span> },
  ];

  const orphans = data.groups?.orphans;

  return (
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', fontFamily: 'var(--font)' }}>
      <div style={{
        flexShrink: 0, padding: '16px 20px 0', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)', flex: 1 }}>System settings</h1>
          <span style={muted}>Users read-only · groups, chat groups and channels editable</span>
          <button onClick={load} disabled={state.status === 'loading'} aria-label="Refresh" title="Refresh" style={{
            width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><RefreshCw size={15} style={state.status === 'loading' ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
        </div>
        <div role="tablist" aria-label="Settings" style={{ display: 'flex', gap: 4 }}>
          {TABS.map(([key, label, Icon]) => {
            const on = key === tab;
            return (
              <button key={key} role="tab" aria-selected={on} onClick={() => pickTab(key)} style={{
                height: 42, padding: '0 14px', border: 'none', borderBottom: `3px solid ${on ? 'var(--accent)' : 'transparent'}`,
                background: 'transparent', color: on ? 'var(--accent-strong)' : 'var(--text2)', fontWeight: 700, fontSize: 13,
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: 'var(--font)',
              }}>
                <Icon size={16} />{label}
                {state.status === 'ready' && <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>{counts[key]}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 20px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{
            flex: '1 1 240px', maxWidth: 420, display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 12px',
            borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--muted)',
          }}>
            <Search size={15} />
            <input value={q} onChange={e => setQ(e.target.value)} aria-label="Search"
              placeholder={tab === 'users' ? 'Name, username, job, group, phone' : tab === 'groups' || tab === 'chatgroups' ? 'Group name or ID' : 'Channel, category or ID'}
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={q} onClear={() => setQ('')} size={24} style={{ marginRight: -6 }} />
          </div>
          {tab === 'users' && <Chips value={userFilter} onPick={setUserFilter} items={[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']]} />}
          {tab === 'channels' && <Chips value={channelFilter} onPick={setChannelFilter} items={[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']]} />}
          {tab === 'groups' && (
            <button onClick={() => setNewGroup(true)} style={{ ...formBtn(true), height: 38, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={15} strokeWidth={2.4} /> New group
            </button>
          )}
          {tab === 'chatgroups' && <Chips value={chatGroupFilter} onPick={setChatGroupFilter} items={[['all', 'All'], ['broadcast', 'Broadcast'], ['group', 'Groups']]} />}
          {tab === 'chatgroups' && (
            <button onClick={() => setNewChatGroup(true)} style={{ ...formBtn(true), height: 38, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={15} strokeWidth={2.4} /> New group
            </button>
          )}
          {tab === 'channels' && (
            <button onClick={() => setNewChannel(true)} style={{ ...formBtn(true), height: 38, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={15} strokeWidth={2.4} /> New channel
            </button>
          )}
          <span style={{ ...muted, fontWeight: 600 }}>
            {tab === 'users' ? `${users.length} users` : tab === 'groups' ? `${groups.length} groups`
              : tab === 'chatgroups' ? `${chatGroups.length} groups` : `${channels.length} channels`}
          </span>
        </div>

        {tab === 'groups' && orphans?.users > 0 && (
          <div role="status" style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10,
            background: 'var(--amber-soft)', color: 'var(--amber)', fontSize: 13, fontWeight: 600,
          }}>
            <AlertTriangle size={16} />
            {orphans.users} users ({orphans.active} active) point to {orphans.groupIds} group IDs that are not in this table.
          </div>
        )}

        {state.status === 'error' ? (
          <div role="alert" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>
            {state.error}
          </div>
        ) : state.status === 'loading' && !data.users ? (
          <div role="status" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
        ) : tab === 'users' ? (
          <Grid columns={userCols} rows={users} rowKey={u => u.id} initialSort={{ key: 'name', desc: false }} />
        ) : tab === 'chatgroups' ? (
          <Grid columns={chatGroupCols} rows={chatGroups} rowKey={g => g.id} initialSort={{ key: 'type', desc: false }}
            onRowClick={g => setChatGroupId(g.id)} />
        ) : tab === 'groups' ? (
          <Grid columns={groupCols} rows={groups} rowKey={g => g.id} initialSort={{ key: 'name', desc: false }}
            onRowClick={g => setGroupId(g.id)} />
        ) : (
          <Grid columns={channelCols} rows={channels} rowKey={c => c.id} initialSort={{ key: 'category', desc: false }}
            onRowClick={c => setChannelId(c.id)} />
        )}
      </div>
      {newGroup && (
        <GroupForm group={null} onClose={() => setNewGroup(false)}
          onSaved={(id) => { setNewGroup(false); reloadGroups(); setGroupId(id); }} />
      )}
      {groupId != null && (
        <UserGroupDrawer groupId={groupId} onClose={closeGroup} onChanged={reloadGroups} onDeleted={closeGroup} />
      )}
      {newChatGroup && (
        <ChatGroupForm group={null} activeUsers={data.chatGroups?.activeUsers} onClose={() => setNewChatGroup(false)}
          onSaved={(id) => { setNewChatGroup(false); reloadChatGroups(); setChatGroupId(id); }} />
      )}
      {chatGroupId != null && (
        <ChatGroupDrawer groupId={chatGroupId} activeUsers={data.chatGroups?.activeUsers} onClose={closeChatGroup} onChanged={reloadChatGroups} />
      )}
      {newChannel && (
        <ChannelForm channel={null} onClose={() => setNewChannel(false)}
          onSaved={(id) => { setNewChannel(false); setChannelFilter('all'); reloadChannels(); setChannelId(id); }} />
      )}
      {channelId != null && (
        <ChannelDrawer channelId={channelId} onClose={closeChannel} onChanged={reloadChannels} onPurposeSaved={(id, saved) => setData(dd => ({
          ...dd, channels: (dd.channels || []).map(c => (c.id === id ? { ...c, purpose: saved.purpose, offer: saved.offer } : c)),
        }))} />
      )}
    </main>
  );
}
