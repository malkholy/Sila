import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { Segmented } from './ChannelsBoard.jsx';
import { fmtWork, loadTicketReport } from '../../shared/ticketSla.js';

// Reports: how each channel the user manages is doing (every channel for mhd;
// the SP decides) -- tickets opened / finished in the period, open and late
// now, average first reply and finish against the targets, share on time --
// and the same per assignee. Times are WORKING time (Sat-Thu 08:00-16:00).

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PERIODS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['90', 'Last 90 days']];
function range(key) {
  const to = new Date();
  if (key === 'month') return [iso(new Date(to.getFullYear(), to.getMonth(), 1)), iso(to)];
  const from = new Date(to); from.setDate(from.getDate() - (Number(key) - 1));
  return [iso(from), iso(to)];
}

const th = {
  padding: '9px 12px', fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text2)',
  whiteSpace: 'nowrap', background: 'var(--bg)', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, cursor: 'pointer',
};
const td = { padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 13, whiteSpace: 'nowrap' };
const num = { ...td, textAlign: 'right', fontFamily: 'var(--mono)' };

function Pct({ v }) {
  if (v == null) return <span style={{ color: 'var(--muted)' }}>-</span>;
  const c = v >= 90 ? 'var(--green)' : v >= 75 ? 'var(--amber)' : 'var(--red)';
  return <span style={{ color: c, fontWeight: 800 }}>{v}%</span>;
}
function Time({ v, target }) {
  if (v == null) return <span style={{ color: 'var(--muted)' }}>-</span>;
  const late = target && v > target;
  return (
    <span>
      <span style={{ color: late ? 'var(--red)' : 'var(--text)', fontWeight: 700 }}>{fmtWork(v)}</span>
      {target ? <span style={{ color: 'var(--muted)' }}> / {fmtWork(target)}</span> : null}
    </span>
  );
}

// a table sorted by clicking its headers; cols: [{ key, label, sort, render, align }]
function Table({ cols, rows, initial }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const c = cols.find(x => x.key === sort.key);
    if (!c?.sort) return rows;
    return [...rows].sort((a, b) => {
      const x = c.sort(a), y = c.sort(b);
      const r = x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -r : r;
    });
  }, [rows, cols, sort]);
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          {cols.map(c => (
            <th key={c.key} scope="col" onClick={() => c.sort && setSort(s => ({ key: c.key, desc: s.key === c.key ? !s.desc : true }))}
              style={{ ...th, textAlign: c.align || 'left' }}>
              {c.label}{sort.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
            </th>
          ))}
        </tr></thead>
        <tbody>
          {sorted.map((r, i) => <tr key={r.id ?? i}>{cols.map(c => <td key={c.key} style={c.align === 'right' ? num : td}>{c.render(r)}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

export default function Reports() {
  const [period, setPeriod] = useState('30');
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });
  const load = () => {
    const [from, to] = range(period);
    setState(s => ({ ...s, status: 'loading', error: '' }));
    loadTicketReport(from, to)
      .then(data => setState({ status: 'ready', data, error: '' }))
      .catch(err => setState({ status: 'error', data: null, error: err.message || 'Could not load the report.' }));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [period]);

  const d = state.data;
  const totals = d ? d.channels.reduce((t, c) => ({
    opened: t.opened + c.opened, finished: t.finished + c.finished, openNow: t.openNow + c.openNow,
    late: t.late + c.finishLate, noReply: t.noReply + c.noReplyLate,
  }), { opened: 0, finished: 0, openNow: 0, late: 0, noReply: 0 }) : null;
  const card = (label, value, tone) => (
    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border)', minWidth: 140 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--mono)', color: tone || 'var(--text)' }}>{value}</div>
    </div>
  );

  return (
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', background: 'var(--bg)', fontFamily: 'var(--font)', padding: '18px 20px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--text)', flex: 1 }}>Reports</h1>
        <Segmented label="Period" items={PERIODS} value={period} onPick={setPeriod} />
        <button onClick={load} disabled={state.status === 'loading'} aria-label="Refresh" title="Refresh" style={{
          width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}><RefreshCw size={15} style={state.status === 'loading' ? { animation: 'spin 1s linear infinite' } : undefined} /></button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
        Tickets in the channels you manage. Times are working time (Saturday to Thursday, 08:00–16:00); on time = within the channel's target.
      </div>

      {state.status === 'loading' && !d && <div role="status" style={{ color: 'var(--muted)' }}>Loading…</div>}
      {state.status === 'error' && (
        <div role="alert" style={{ padding: 12, borderRadius: 10, background: 'var(--red-soft)', color: 'var(--red)', fontSize: 13 }}>{state.error}</div>
      )}
      {d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, opacity: state.status === 'loading' ? 0.6 : 1 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {card('Opened', totals.opened.toLocaleString())}
            {card('Finished', totals.finished.toLocaleString())}
            {card('Open now', totals.openNow.toLocaleString())}
            {card('No reply, late', totals.noReply.toLocaleString(), totals.noReply ? 'var(--red)' : undefined)}
            {card('Past finish target', totals.late.toLocaleString(), totals.late ? 'var(--red)' : undefined)}
          </div>

          <section>
            <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>By channel · {d.channels.length}</h2>
            {d.channels.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No tickets in this period.</div> : (
              <Table initial={{ key: 'late', desc: true }} rows={d.channels} cols={[
                { key: 'name', label: 'Channel', sort: c => c.name.toLowerCase(), render: c => <span dir="auto" style={{ fontWeight: 700 }}># {c.name}</span> },
                { key: 'opened', label: 'Opened', align: 'right', sort: c => c.opened, render: c => c.opened },
                { key: 'finished', label: 'Finished', align: 'right', sort: c => c.finished, render: c => c.finished },
                { key: 'open', label: 'Open now', align: 'right', sort: c => c.openNow, render: c => c.openNow },
                { key: 'late', label: 'Late now', align: 'right', sort: c => c.finishLate + c.noReplyLate, render: c => (
                  c.finishLate + c.noReplyLate ? (
                    <span style={{ color: 'var(--red)', fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangle size={12} />{c.finishLate + c.noReplyLate}
                    </span>
                  ) : 0
                ) },
                { key: 'reply', label: 'Avg first reply', sort: c => c.avgReply, render: c => <Time v={c.avgReply} target={c.replyTarget} /> },
                { key: 'replyOk', label: 'Reply on time', align: 'right', sort: c => c.replyOnTime, render: c => <Pct v={c.replyOnTime} /> },
                { key: 'finish', label: 'Avg finish', sort: c => c.avgFinish, render: c => <Time v={c.avgFinish} target={c.finishTarget} /> },
                { key: 'finishOk', label: 'Finish on time', align: 'right', sort: c => c.finishOnTime, render: c => <Pct v={c.finishOnTime} /> },
              ]} />
            )}
          </section>

          <section>
            <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>By assignee · {d.people.length}</h2>
            {d.people.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No assigned tickets yet. Assign tickets to see who carries what.</div> : (
              <Table initial={{ key: 'late', desc: true }} rows={d.people} cols={[
                { key: 'name', label: 'Person', sort: p => p.name.toLowerCase(), render: p => (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Avatar name={p.name} size={26} photoUrl={p.photoUrl} /><span dir="auto" style={{ fontWeight: 700 }}>{p.name}</span></span>
                ) },
                { key: 'open', label: 'Open now', align: 'right', sort: p => p.openNow, render: p => p.openNow },
                { key: 'late', label: 'Late now', align: 'right', sort: p => p.lateNow, render: p => (p.lateNow ? <span style={{ color: 'var(--red)', fontWeight: 800 }}>{p.lateNow}</span> : 0) },
                { key: 'finished', label: 'Finished', align: 'right', sort: p => p.finished, render: p => p.finished },
                { key: 'avg', label: 'Avg finish', sort: p => p.avgFinish, render: p => <Time v={p.avgFinish} /> },
              ]} />
            )}
          </section>
        </div>
      )}
    </main>
  );
}
