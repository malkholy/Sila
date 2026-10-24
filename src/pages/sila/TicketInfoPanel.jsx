import React, { useEffect, useState } from 'react';
import { X, Hash, UserPlus, UserMinus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { loadTicketMembers, inviteTicketMembers, removeTicketMember } from '../../shared/chat.js';
import MediaSection from './MediaSection.jsx';
import { fmtWork } from '../../shared/ticketSla.js';
import AddMembersDialog from './AddMembersDialog.jsx';

// The ticket details panel (opens from the ticket header): channel, state,
// the action buttons the caller may use (actions, from ChatPane: the state
// changes and Leave ticket), service level, history, then the members -- managers
// (admins / team leaders) first, with Admin / Team leader / Creator / CC badges.
// Admins and team leaders invite people and remove members (not the creator).
// The SP checks it all again (header.can: its Can* flags); remove asks first,
// in the panel.

// CHA.TicketState -> [fg, bg]
const STATE_TONE = {
  0: ['var(--blue)', 'var(--blue-soft)'], 1: ['var(--green)', 'var(--green-soft)'], 2: ['var(--orange)', 'var(--orange-soft)'],
  3: ['var(--amber)', 'var(--amber-soft)'], 5: ['var(--amber)', 'var(--amber-soft)'],
};
const when = (d) => d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// "3 d 4 h", "2 h 10 min", "5 min"
function span(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

// The ticket's dated steps (header.history, oldest first): a dot per step,
// who did it, when, and how long after the step before. finished (Ended or
// Closed): "Took" = opened -> Ended (or Closed, when closed without ending),
// the SLA's finish time; otherwise "Open for" = opened -> now.
function History({ steps, nameOf, finished }) {
  const opened = steps[0]?.at;
  // the LAST end (a ticket can be ended, reopened and ended again), else the last close
  const last = (kind) => [...steps].reverse().find(st => st.kind === kind);
  const done = finished ? (last('ended') || last('closed')) : null;
  const end = done ? done.at : new Date();
  return (
    <div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {steps.map((st, i) => {
          const last = i === steps.length - 1;
          return (
            <li key={st.key} style={{ display: 'flex', gap: 10 }}>
              <span aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, flexShrink: 0 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: 5, marginTop: 5, flexShrink: 0,
                  background: last ? 'var(--accent)' : 'var(--surface)', border: `2px solid ${last ? 'var(--accent)' : 'var(--border2)'}`,
                }} />
                {!last && <span style={{ flex: 1, width: 2, background: 'var(--border)', margin: '2px 0' }} />}
              </span>
              <span style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 12, display: 'flex', flexDirection: 'column' }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{st.label}</span>
                  {i > 0 && <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>+{span(st.at - steps[i - 1].at)}</span>}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>{when(st.at)}</span>
                {st.by && <span style={{ fontSize: 12, color: 'var(--muted)' }}>by <span dir="auto">{nameOf(st.by)}</span></span>}
              </span>
            </li>
          );
        })}
      </ol>
      {opened && (
        <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--bg)', fontSize: 12, color: 'var(--text2)' }}>
          {done ? 'Took' : 'Open for'} <b style={{ color: 'var(--text)' }}>{span(end - opened)}</b>
        </div>
      )}
    </div>
  );
}

// First reply and finish against the channel's targets, in working time
// (Sat-Thu 08:00-16:00): done in time / late, or how long so far while open.
function ServiceLevel({ sla, state }) {
  const line = (label, m, done, doneLabel) => {
    if (!m.target) return null;
    const late = m.minutes > m.target;
    const soon = !done && !late && m.minutes * 4 >= m.target * 3;
    const tone = late ? 'var(--red)' : soon ? 'var(--amber)' : done ? 'var(--green)' : 'var(--text2)';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, padding: 12,
        border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
        <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>{label}</span>
        <span style={{ color: tone, fontWeight: 700 }}>
          {done ? `${doneLabel} ${fmtWork(m.minutes)}` : `${fmtWork(m.minutes)} so far`}
          <span style={{ color: 'var(--muted)', fontWeight: 600 }}> / {fmtWork(m.target)}</span>
          {late ? ' · late' : soon ? ' · due soon' : done ? ' ✓' : ''}
        </span>
        <span aria-hidden="true" style={{ height: 4, background: 'var(--soft)', borderRadius: 4, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, Math.max(0, m.minutes / m.target * 100))}%`, background: tone, borderRadius: 4 }} />
        </span>
      </div>
    );
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {line('First reply', sla.reply, !!sla.firstReply || state >= 10, 'replied in')}
      {line('Finish', sla.finish, state >= 10, 'took')}
      <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--muted)', marginTop: 2 }}>Working hours · Sat–Thu, 08:00–16:00</div>
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

// entity / onView: the conversation's file context and image viewer (from ChatPane), for the media section
// onMembersChange: people were invited / removed (reload the conversation);
export default function TicketInfoPanel({ ticketId, header, isOnline, actions, entity, onView, onClose, onMembersChange }) {
  const [state, setState] = useState({ status: 'loading', members: [], error: '' });
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState(null);   // { kind: 'remove', m }
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, status: s.members.length ? 'ready' : 'loading', error: '' }));
    loadTicketMembers(ticketId)
      .then(members => { if (alive) setState({ status: 'ready', members, error: '' }); })
      .catch(err => { if (alive) setState({ status: 'error', members: [], error: err.message || 'Could not load the members.' }); });
    return () => { alive = false; };
  }, [ticketId, reloads]);
  const can = header?.can || {};

  const invite = async (ids, _users, adminIds) => {
    await inviteTicketMembers(ticketId, ids, adminIds);   // errors are shown by the dialog
    setReloads(n => n + 1);
    onMembersChange?.();
  };
  const runConfirm = async () => {
    setConfirmBusy(true); setConfirmError('');
    try {
      await removeTicketMember(ticketId, confirm.m.id);
      setState(st => ({ ...st, members: st.members.filter(x => x.id !== confirm.m.id) }));
      setConfirm(null);
      onMembersChange?.();
    } catch (err) { setConfirmError(err.message || 'Could not complete that.'); }
    finally { setConfirmBusy(false); }
  };

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const managers = state.members.filter(m => m.admin || m.leader);
  const others = state.members.filter(m => !m.admin && !m.leader);
  const row = (m) => (
    <li key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <Avatar name={m.name} size={36} photoUrl={m.photoUrl} online={isOnline(m.username)} userId={m.id} username={m.username} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span dir="auto" title={m.name} style={{ minWidth: 0, fontSize: 13, lineHeight: 1.45, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {m.name}{m.me ? ' (you)' : ''}
        </span>
      <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {m.creator && <Badge tone="creator">Creator</Badge>}
        {m.admin && <Badge tone="admin">Admin</Badge>}
        {m.leader && !m.admin && <Badge tone="admin">Team leader</Badge>}
        {m.cc && <Badge>CC</Badge>}
      </span>
        </span>
        <span dir="auto" style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
          {m.jobTitle || `@${m.username}`}
        </span>
      </span>
      {can.removeMembers && !m.me && !m.creator && (
        <button onClick={() => { setConfirmError(''); setConfirm({ kind: 'remove', m }); }} aria-label={`Remove ${m.name} from the ticket`}
          title="Remove from ticket" style={{
            width: 30, height: 30, borderRadius: 15, border: 'none', background: 'transparent', color: 'var(--muted)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}><UserMinus size={15} /></button>
      )}
    </li>
  );
  const heading = (text) => (
    <h3 style={{ margin: '22px 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--text2)' }}>
      {text}
    </h3>
  );

  return (
    <aside aria-label="Ticket details" style={{
      flex: '0 1 360px', minWidth: 0, maxWidth: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface)',
      borderLeft: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ flex: 1, margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Ticket details</h2>
        <button onClick={onClose} aria-label="Close ticket details" style={{
          width: 32, height: 32, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><X size={18} /></button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px 20px' }}>
        {header && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 12,
              border: '1px solid var(--border)', background: 'var(--bg)', fontSize: 12, color: 'var(--text2)', textAlign: 'left' }}>
              <div style={{ fontSize: 18, lineHeight: 1.4, fontWeight: 800, color: 'var(--text)', overflowWrap: 'anywhere' }}><span dir="auto">{header.title}</span></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Hash size={13} style={{ flexShrink: 0 }} /><span dir="auto" style={{ overflowWrap: 'anywhere' }}>{header.channel}</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>#{header.ticketId}</span>
                {header.stateLabel && (
                  <span style={{
                    padding: '1px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                    background: (STATE_TONE[header.state] || ['', 'var(--soft)'])[1], color: (STATE_TONE[header.state] || ['var(--text2)'])[0],
                  }}>{header.stateLabel}</span>
                )}
              </div>
              {header.forwardedFrom && <div>Forwarded from # <span dir="auto">{header.forwardedFrom}</span></div>}
            </div>
            {/* the action buttons first: what the caller can do with the ticket */}
            {actions && (
              <>
                {heading('Actions')}
                <div style={{ paddingTop: 6 }}>{actions}</div>
              </>
            )}
            {header.sla && (header.sla.reply.target || header.sla.finish.target) && (
              <>
                {heading('Service level')}
                <ServiceLevel sla={header.sla} state={header.state} />
              </>
            )}
            {header.history?.length > 0 && (
              <>
                {heading('History')}
                <div style={{ paddingTop: 6 }}>
                  <History steps={header.history} finished={header.state >= 10} nameOf={(u) => {
                    const m = state.members.find(x => x.username === u);
                    if (m) return m.name;
                    return u === String(header.createdByUser || '').toLowerCase() && header.createdBy ? header.createdBy : `@${u}`;
                  }} />
                </div>
              </>
            )}
          </>
        )}
        {state.status === 'loading' && <div role="status" style={{ marginTop: 16, fontSize: 13, color: 'var(--muted)' }}>Loading members…</div>}
        {state.status === 'error' && <div role="alert" style={{ marginTop: 16, fontSize: 13, color: 'var(--red)' }}>{state.error}</div>}
        {can.invite && (
          <button onClick={() => setInviting(true)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', height: 40, marginTop: 16,
            borderRadius: 10, border: '1px solid var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent-strong)',
            fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
          }}><UserPlus size={16} /> Invite people</button>
        )}
        {confirm && (
          <div role="alertdialog" aria-label="Confirm" style={{
            display: 'flex', flexDirection: 'column', gap: 8, padding: 12, marginTop: 12, borderRadius: 12, background: 'var(--red-soft)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)' }}>
              Remove <span dir="auto">{confirm.m.name}</span> from this ticket?
            </span>
            {confirmError && <span style={{ fontSize: 12, color: 'var(--red)' }}>{confirmError}</span>}
            <span style={{ display: 'flex', gap: 8 }}>
              <button onClick={runConfirm} disabled={confirmBusy} style={{
                height: 34, padding: '0 14px', borderRadius: 8, border: 'none', background: 'var(--red)', color: '#fff',
                fontWeight: 700, fontSize: 13, cursor: confirmBusy ? 'wait' : 'pointer', fontFamily: 'var(--font)',
              }}>{confirmBusy ? 'Working…' : 'Remove'}</button>
              <button onClick={() => setConfirm(null)} disabled={confirmBusy} style={{
                height: 34, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text)', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font)',
              }}>Cancel</button>
            </span>
          </div>
        )}
        {state.status === 'ready' && (
          <>
            {managers.length > 0 && heading(`Admins and team leaders · ${managers.length}`)}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{managers.map(row)}</ul>
            {others.length > 0 && heading(`Members · ${others.length}`)}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{others.map(row)}</ul>
          </>
        )}
        <MediaSection ticketId={ticketId} entity={entity} onView={onView} heading={heading} />
      </div>
      {inviting && (
        <AddMembersDialog title="Invite to ticket" verb="Invite" where="ticket" adminLabel="Ticket admin" existingIds={state.members.map(m => m.id)}
          onAdd={invite} onClose={() => setInviting(false)} />
      )}
    </aside>
  );
}
