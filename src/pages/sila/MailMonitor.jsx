import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, RefreshCw, Search, AlertTriangle, Play, Folder } from 'lucide-react';
import { formatWhen } from '../../shared/leftSide.js';
import { loadMailOverview, loadMailAccounts, loadMailAccount, loadMailErrors, syncMailbox } from '../../shared/mailAdmin.js';
import { Grid, Pill, Chips, muted, DrawerHeading, formBtn } from './SettingsUi.jsx';
import ClearSearch from './ClearSearch.jsx';

// Mail Monitor (System Settings tab, MailPlan 6): every mailbox the Mail
// Connector API keeps in InternalMail -- is it up to date, how much is copied,
// what is failing. Overview (totals, publish queue, latest sync runs),
// Accounts (one row per mailbox; double-click for its folders, runs and
// errors; "Sync now") and Errors (open grouped errors). The connector pushes
// its figures to SilaApi every 15 s (no inbound port into the company); the
// screen reads them every 15 s and says how old they are. Data:
// shared/mailAdmin.js (checked server side).

const VIEWS = [['overview', 'Overview'], ['accounts', 'Accounts'], ['errors', 'Errors']];
const REFRESH_MS = 15_000;
const STALE_MS = 60_000;   // no push for a minute: the connector is behind or down

const n = (v) => Number(v || 0).toLocaleString();
const pct = (part, whole) => (whole > 0 ? Math.min(100, Math.floor((part / whole) * 100)) : 0);
const has = (needle, ...values) => !needle || values.some(v => String(v ?? '').toLowerCase().includes(needle));
const when = (d) => (d ? `${formatWhen(d)}${sameDay(d) ? '' : ` ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}` : '-');
const sameDay = (d) => d.toDateString() === new Date().toDateString();
const bytes = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
function duration(start, end) {
  if (!start) return '';
  const s = Math.max(0, Math.round(((end || new Date()) - start) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} m ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
}
const STATUS_TONE = { OK: 'green', Behind: 'accent', Error: 'red', Disabled: 'muted' };
const FOLDER_TONE = { OK: 'green', Syncing: 'blue', New: 'muted', Rebuilding: 'accent', Error: 'red' };

function Bar({ value, tone = 'var(--accent)' }) {
  return (
    <span aria-hidden="true" style={{ display: 'block', height: 6, borderRadius: 999, background: 'var(--soft)', overflow: 'hidden', minWidth: 80 }}>
      <span style={{ display: 'block', height: '100%', width: `${value}%`, background: value >= 100 ? 'var(--green)' : tone, transition: 'width .4s' }} />
    </span>
  );
}

function Card({ label, value, sub, bar, tone }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text2)' }}>{label}</span>
      <span style={{ fontSize: 24, fontWeight: 800, color: tone || 'var(--text)', fontFamily: 'var(--mono)', lineHeight: 1.1 }}>{value}</span>
      {bar != null && <Bar value={bar} />}
      {sub && <span style={{ ...muted, lineHeight: 1.4 }}>{sub}</span>}
    </div>
  );
}

function RunResult({ r }) {
  if (r.ok == null) return <Pill tone="blue">Running</Pill>;
  return r.ok ? <Pill tone="green">OK</Pill> : <span title={r.errorMessage}><Pill tone="red">{r.errorCode || 'Failed'}</Pill></span>;
}

// What a run did, in one line: "+120 ~3 -2" (Moves: "2 moves, 1 purged").
function runChanges(r) {
  if (r.kind === 'Moves') return `${r.matched} moved · ${r.deleted} purged`;
  if (r.reason.endsWith(':Bodies')) return `${n(r.added)} bodies`;
  return `+${n(r.added)} ~${n(r.changed)} -${n(r.deleted)}`;
}
const runWhat = (r) => (r.reason.endsWith(':Bodies') ? 'Bodies' : r.kind) + (r.folder ? ` · ${r.folder.trim()}` : '');

function runColumns(withMailbox) {
  return [
    { key: 'started', label: 'Started', sort: r => r.started?.getTime() || 0, render: r => <span style={{ whiteSpace: 'nowrap' }}>{when(r.started)}</span> },
    ...(withMailbox ? [{ key: 'mailbox', label: 'Mailbox', sort: r => r.mailbox, render: r => <span>{r.mailbox}</span> }] : []),
    { key: 'what', label: 'Run', sort: r => runWhat(r), render: r => <span dir="auto">{runWhat(r)}</span> },
    { key: 'pages', label: 'Pages', sort: r => r.pages, align: 'right', render: r => <span style={{ fontFamily: 'var(--mono)' }}>{n(r.pages)}</span> },
    { key: 'changes', label: 'Changes', render: r => <span style={{ fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{runChanges(r)}</span> },
    { key: 'took', label: 'Took', sort: r => (r.ended || new Date()) - (r.started || 0), render: r => <span style={{ whiteSpace: 'nowrap' }}>{duration(r.started, r.ended)}</span> },
    { key: 'result', label: 'Result', sort: r => (r.ok == null ? 0 : r.ok ? 1 : 2), render: r => <RunResult r={r} /> },
  ];
}

const errorColumns = (withMailbox) => [
  { key: 'last', label: 'Last seen', sort: e => e.last?.getTime() || 0, render: e => <span style={{ whiteSpace: 'nowrap' }}>{when(e.last)}</span> },
  { key: 'type', label: 'Type', sort: e => e.type, render: e => <Pill tone={e.type === 'BadItem' ? 'accent' : 'red'}>{e.type}</Pill> },
  ...(withMailbox ? [{ key: 'mailbox', label: 'Mailbox', sort: e => e.mailbox, render: e => <span>{e.mailbox || '-'}</span> }] : []),
  { key: 'folder', label: 'Folder', sort: e => e.folder, render: e => <span dir="auto">{e.folder.trim() || '-'}</span> },
  { key: 'code', label: 'Code', sort: e => e.code, render: e => <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{e.code}</span> },
  { key: 'message', label: 'Message', render: e => <span title={e.message} style={{ display: 'block', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{e.message}</span> },
  { key: 'count', label: 'Times', sort: e => e.count, align: 'right', render: e => <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>{n(e.count)}</span> },
  { key: 'first', label: 'First seen', sort: e => e.first?.getTime() || 0, render: e => <span style={{ whiteSpace: 'nowrap' }}>{when(e.first)}</span> },
];

function SyncButton({ userId, onQueued, big }) {
  const [state, setState] = useState('');
  const go = async (e) => {
    e.stopPropagation();
    setState('busy');
    try { await syncMailbox(userId); setState('queued'); onQueued?.(); } catch (err) { setState(err.message || 'Failed'); }
  };
  const label = state === 'busy' ? 'Asking…' : state === 'queued' ? 'Starts within 15 s' : state ? 'Retry' : 'Sync now';
  return (
    <button onClick={go} disabled={state === 'busy' || state === 'queued'} title={state && state !== 'busy' && state !== 'queued' ? state : 'Sync every folder of this mailbox now'}
      style={{ ...formBtn(false), height: big ? 40 : 30, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
        color: state && state !== 'busy' && state !== 'queued' ? 'var(--red)' : undefined }}>
      <Play size={13} /> {label}
    </button>
  );
}

function Overview({ data }) {
  const { accounts: a, content: c, publish: p, errors: e } = data;
  const waiting = Math.max(0, p.lastChange - p.lastPublished);
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      {(a.error > 0 || a.behind > 0) && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, fontSize: 13, fontWeight: 600,
          background: a.error > 0 ? 'var(--red-soft)' : 'var(--amber-soft)', color: a.error > 0 ? 'var(--red)' : 'var(--amber)' }}>
          <AlertTriangle size={16} />
          {a.error > 0 && `${a.error} mailbox${a.error === 1 ? '' : 'es'} failing. `}{a.behind > 0 && `${a.behind} behind.`} See Accounts.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
        <Card label="Mailboxes" value={n(a.total)} sub={`${a.ok} OK · ${a.behind} behind · ${a.error} error · ${a.disabled} disabled`} />
        <Card label="Messages copied" value={`${pct(c.messages, c.exchangeItems)}%`} bar={pct(c.messages, c.exchangeItems)}
          sub={`${n(c.messages)} of ${n(c.exchangeItems)} in Exchange`} />
        <Card label="Bodies" value={`${pct(c.bodies, c.messages)}%`} bar={pct(c.bodies, c.messages)}
          sub={`${n(c.bodies)} of ${n(c.messages)} copied messages`} />
        <Card label="Unread" value={n(c.unread)} sub={`Exchange: ${n(c.exchangeUnread)}`} />
        <Card label="Attachments" value={n(c.attachments - c.inline)} sub={`files · ${n(c.inline)} inline images · ${bytes(c.attachmentBytes)} in Exchange`} />
        <Card label="Folders" value={n(c.folders)} sub={c.markedDeleted ? `${n(c.markedDeleted)} messages waiting as possible moves` : 'mail folders copied'} />
        <Card label="Waiting to publish" value={n(waiting)} tone={waiting > 0 ? 'var(--accent-strong)' : undefined}
          sub={`external copy: ${p.link === 'Up' ? `up, last ${when(p.at)}` : 'not connected yet'}`} />
        <Card label="Open errors" value={n(e.open)} tone={e.open > 0 ? 'var(--red)' : 'var(--green)'} sub={e.open ? `${n(e.occurrences)} times in all` : 'nothing failing'} />
        <Card label="Last sync" value={a.lastSync ? formatWhen(a.lastSync) : '-'} sub={a.oldestSync ? `oldest mailbox: ${when(a.oldestSync)}` : 'no mailbox synced yet'} />
      </div>
      <DrawerHeading>Latest sync runs</DrawerHeading>
      <div style={{ minHeight: 260, display: 'flex' }}>
        <Grid columns={runColumns(true)} rows={data.runs} rowKey={r => r.id} initialSort={{ key: 'started', desc: true }} />
      </div>
    </div>
  );
}

function AccountDrawer({ userId, onClose, onQueued }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const [folderFilter, setFolderFilter] = useState('mail');
  const busy = useRef(false);
  const load = useCallback(() => {
    if (busy.current) return;   // the first answer can take up to ~25 s: no second request meanwhile
    busy.current = true;
    loadMailAccount(userId)
      .then(data => setState({ status: 'ready', data, error: '' }))
      .catch(err => setState(s => ({ ...s, status: s.data ? 'ready' : 'error', error: err.message || 'Could not load the mailbox.' })))
      .finally(() => { busy.current = false; });
  }, [userId]);
  useEffect(() => { load(); const t = setInterval(load, REFRESH_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const d = state.data;
  const totals = d ? d.folders.reduce((t, f) => ({ ex: t.ex + f.exchangeTotal, db: t.db + f.messages, bodies: t.bodies + f.bodies,
    unread: t.unread + f.unread, att: t.att + f.attachments, ok: t.ok + (f.status === 'OK' ? 1 : 0) }), { ex: 0, db: 0, bodies: 0, unread: 0, att: 0, ok: 0 }) : null;
  const folders = d ? d.folders.filter(f => folderFilter === 'all' || (folderFilter === 'mail' ? f.exchangeTotal > 0 : f.status !== 'OK')) : [];
  const folderCols = [
    { key: 'name', label: 'Folder', sort: f => f.name.toLowerCase(), render: f => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}><Folder size={13} style={{ color: 'var(--muted)' }} /><span dir="auto">{f.name.trim()}</span></span>) },
    { key: 'type', label: 'Type', sort: f => f.type, render: f => <span style={muted}>{f.type === 'Custom' ? '-' : f.type}</span> },
    { key: 'copied', label: 'Copied', sort: f => pct(f.messages, f.exchangeTotal), render: f => (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 130 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{n(f.messages)} / {n(f.exchangeTotal)}</span>
        <Bar value={f.exchangeTotal ? pct(f.messages, f.exchangeTotal) : 100} />
      </span>) },
    { key: 'bodies', label: 'Bodies', sort: f => f.bodies, align: 'right', render: f => (
      <span style={{ fontFamily: 'var(--mono)', color: f.bodies < f.messages ? 'var(--accent-strong)' : undefined }}>{n(f.bodies)}</span>) },
    { key: 'unread', label: 'Unread', sort: f => f.unread, align: 'right', render: f => (
      <span style={{ fontFamily: 'var(--mono)', color: f.unread !== f.exchangeUnread ? 'var(--amber)' : undefined }}
        title={`Exchange: ${n(f.exchangeUnread)}`}>{n(f.unread)}</span>) },
    { key: 'att', label: 'Attachments', sort: f => f.attachments, align: 'right', render: f => <span style={{ fontFamily: 'var(--mono)' }}>{n(f.attachments)}</span> },
    { key: 'status', label: 'Status', sort: f => f.status, render: f => <Pill tone={FOLDER_TONE[f.status] || 'muted'}>{f.status}</Pill> },
    { key: 'last', label: 'Last sync', sort: f => f.lastSync?.getTime() || 0, render: f => <span style={{ whiteSpace: 'nowrap' }}>{when(f.lastSync)}</span> },
  ];

  return (
    <>
      <div aria-hidden="true" onMouseDown={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.3)', zIndex: 990 }} />
      <aside role="dialog" aria-label="Mailbox details" style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(980px, 96vw)', zIndex: 991, background: 'var(--surface)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font)',
      }}>
        <header style={{ flexShrink: 0, padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ width: 46, height: 46, borderRadius: 13, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent-soft)', border: '1.5px solid var(--accent-line)', color: 'var(--accent-strong)' }}><Mail size={22} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Mailbox · Sila user #{userId}{d?.account.name ? ` · ${d.account.name}` : ''}</div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--text)' }}>{d?.account.email || 'Loading…'}</h2>
            {d && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <Pill tone={STATUS_TONE[d.account.status] || 'muted'}>{d.account.status}</Pill>
                <span style={muted}>last sync {when(d.account.lastSync)}{d.account.failures > 0 ? ` · ${d.account.failures} failed in a row (${d.account.lastErrorCode})` : ''}</span>
              </div>
            )}
          </div>
          {d && <SyncButton userId={userId} onQueued={onQueued} big />}
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 20px 24px', display: 'flex', flexDirection: 'column' }}>
          {state.error && <div role="alert" style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{state.error}</div>}
          {!d ? (state.status === 'loading' && (
            <div role="status" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>Asking the Mail Connector API for this mailbox… (up to half a minute)</div>
          )) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
                <Card label="Messages" value={`${pct(totals.db, totals.ex)}%`} bar={pct(totals.db, totals.ex)} sub={`${n(totals.db)} of ${n(totals.ex)}`} />
                <Card label="Bodies" value={`${pct(totals.bodies, totals.db)}%`} bar={pct(totals.bodies, totals.db)} sub={`${n(totals.bodies)} of ${n(totals.db)}`} />
                <Card label="Unread" value={n(totals.unread)} />
                <Card label="Attachments" value={n(totals.att)} />
                <Card label="Folders done" value={`${totals.ok} / ${d.folders.length}`} />
              </div>
              {d.errors.length > 0 && (
                <>
                  <DrawerHeading>Open errors · {d.errors.length}</DrawerHeading>
                  <div style={{ display: 'flex', maxHeight: 220 }}><Grid columns={errorColumns(false)} rows={d.errors} rowKey={e => e.id} initialSort={{ key: 'last', desc: true }} /></div>
                </>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <DrawerHeading>Folders · {folders.length}</DrawerHeading>
                <Chips value={folderFilter} onPick={setFolderFilter} items={[['mail', 'With mail'], ['open', 'Not done'], ['all', 'All']]} />
              </div>
              <div style={{ display: 'flex', minHeight: 240, maxHeight: 480 }}>
                <Grid columns={folderCols} rows={folders} rowKey={f => f.id} initialSort={{ key: 'copied', desc: false }} />
              </div>
              <DrawerHeading>Recent sync runs</DrawerHeading>
              <div style={{ display: 'flex', minHeight: 200, maxHeight: 420 }}>
                <Grid columns={runColumns(false)} rows={d.runs} rowKey={r => r.id} initialSort={{ key: 'started', desc: true }} />
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default function MailMonitor() {
  const [view, setView] = useState(() => { try { return localStorage.getItem('silaMailView') || 'overview'; } catch { return 'overview'; } });
  const pickView = (v) => { setView(v); try { localStorage.setItem('silaMailView', v); } catch { /* not remembered */ } };
  const [data, setData] = useState({ overview: null, accounts: null, errors: null });
  const [state, setState] = useState({ status: 'loading', error: '', at: null });
  const [auto, setAuto] = useState(true);
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState(null);
  const closeAccount = useCallback(() => setAccountId(null), []);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;   // a slow answer is not asked for twice
    busy.current = true;
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const [overview, accounts, errors] = await Promise.all([loadMailOverview(), loadMailAccounts(), loadMailErrors()]);
      setData({ overview, accounts, errors });
      setState({ status: 'ready', error: '', at: new Date() });
    } catch (err) {
      setState(s => ({ ...s, status: 'error', error: err.message || 'Could not load the Mail Monitor.' }));
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, load]);

  const needle = q.trim().toLowerCase();
  const accounts = (data.accounts || []).filter(a => has(needle, a.email, a.name, a.id, a.status));
  const errors = (data.errors || []).filter(e => has(needle, e.mailbox, e.type, e.code, e.message, e.folder));

  const accountCols = [
    { key: 'mailbox', label: 'Mailbox', sort: a => a.email, render: a => (
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 200 }}>
        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{a.email}</span>
        <span style={muted}>{a.name ? `${a.name} · ` : ''}#{a.id}</span>
      </span>) },
    { key: 'status', label: 'Status', sort: a => a.status, render: a => (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
        <Pill tone={STATUS_TONE[a.status] || 'muted'}>{a.status}</Pill>
        {a.running && <span style={{ ...muted, color: 'var(--blue)', whiteSpace: 'nowrap' }}>syncing {a.runningFolder.trim() || a.runningKind}…</span>}
      </span>) },
    { key: 'messages', label: 'Messages', sort: a => pct(a.messages, a.exchangeItems), render: a => (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 150 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{n(a.messages)} / {n(a.exchangeItems)}</span>
        <Bar value={pct(a.messages, a.exchangeItems)} />
      </span>) },
    { key: 'bodies', label: 'Bodies', sort: a => pct(a.bodies, a.messages), render: a => (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 110 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{pct(a.bodies, a.messages)}% · {n(a.bodies)}</span>
        <Bar value={pct(a.bodies, a.messages)} tone="var(--blue)" />
      </span>) },
    { key: 'unread', label: 'Unread', sort: a => a.unread, align: 'right', render: a => <span style={{ fontFamily: 'var(--mono)' }} title={`Exchange: ${n(a.exchangeUnread)}`}>{n(a.unread)}</span> },
    { key: 'att', label: 'Attachments', sort: a => a.attachments, align: 'right', render: a => <span style={{ fontFamily: 'var(--mono)' }}>{n(a.attachments)}</span> },
    { key: 'folders', label: 'Folders', sort: a => a.foldersOk, align: 'right', render: a => <span style={{ fontFamily: 'var(--mono)' }}>{a.foldersOk} / {a.folders}</span> },
    { key: 'last', label: 'Last sync', sort: a => a.lastSync?.getTime() || 0, render: a => <span style={{ whiteSpace: 'nowrap' }}>{when(a.lastSync)}</span> },
    { key: 'errors', label: 'Errors', sort: a => a.openErrors, align: 'right', render: a => (
      <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: a.openErrors ? 'var(--red)' : 'var(--muted)' }} title={a.lastErrorCode || undefined}>{a.openErrors}</span>) },
    { key: 'action', label: '', render: a => <SyncButton userId={a.id} onQueued={load} /> },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Chips value={view} onPick={pickView} items={VIEWS.map(([k, label]) => [k, k === 'errors' && data.errors?.length ? `${label} · ${data.errors.length}` : label])} />
        {view !== 'overview' && (
          <div style={{ flex: '1 1 220px', maxWidth: 380, display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px',
            borderRadius: 10, border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--muted)' }}>
            <Search size={15} />
            <input value={q} onChange={e => setQ(e.target.value)} aria-label="Search" placeholder={view === 'accounts' ? 'Mailbox, name or user ID' : 'Mailbox, type, code or message'}
              style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: 'var(--text)', fontFamily: 'var(--font)' }} />
            <ClearSearch value={q} onClear={() => setQ('')} size={24} style={{ marginRight: -6 }} />
          </div>
        )}
        <span style={{ flex: 1 }} />
        <label style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 600 }}>
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Refresh every 15 s
        </label>
        <span style={{ ...muted, fontWeight: 600 }} title={state.at ? `Read ${state.at.toLocaleTimeString()}` : undefined}>
          {data.overview?.pushedAt ? `Figures from ${data.overview.pushedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
        </span>
        <button onClick={load} disabled={state.status === 'loading'} aria-label="Refresh mail statistics" title="Refresh" style={{
          width: 34, height: 34, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
          color: 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><RefreshCw size={15} style={state.status === 'loading' ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
      </div>

      {state.error && (
        <div role="alert" style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>
          {state.error}{data.overview ? ' Showing the last figures.' : ''}
        </div>
      )}
      {data.overview?.pushedAt && Date.now() - data.overview.pushedAt > STALE_MS && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, fontSize: 13, fontWeight: 600,
          background: 'var(--amber-soft)', color: 'var(--amber)' }}>
          <AlertTriangle size={16} />
          The Mail Connector API last reported {duration(data.overview.pushedAt, new Date())} ago. It may be stopped or unable to reach this server; the figures below are from then.
        </div>
      )}
      {!data.overview ? (
        state.status === 'loading' && <div role="status" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      ) : view === 'overview' ? (
        <Overview data={data.overview} />
      ) : view === 'accounts' ? (
        <Grid columns={accountCols} rows={accounts} rowKey={a => a.id} initialSort={{ key: 'mailbox', desc: false }} onRowClick={a => setAccountId(a.id)} />
      ) : (
        <Grid columns={errorColumns(true)} rows={errors} rowKey={e => e.id} initialSort={{ key: 'last', desc: true }} />
      )}
      {accountId != null && <AccountDrawer userId={accountId} onClose={closeAccount} onQueued={load} />}
    </div>
  );
}
