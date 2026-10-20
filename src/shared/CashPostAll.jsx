import { useState, useMemo } from 'react';
import { apiCall } from './api.js';

// "Post All" for Cash Receive / Cash Payable: a summary of the unposted
// requests in the grid's current filter (New Request 0 / No Journal 10 with
// an amount), then posts them one by one through the page's existing single
// Post operation (PostCashReceive / PostCashPayable) -- same server rules,
// permission (CR_POST / CP_POST), transaction and journal per request; the
// server re-checks every request's state, so a stale grid can't post twice.
// Each request posts on its own Request Date.
//
// props: rows (the grid's current rows), cfg = { title, op, sp, dateParam,
// amountField, party }, pageGroupId, afterPost(row, message) (optional, e.g.
// the Cash Payable ticket message), onClose(changed)
//
// Reused by Pending Approvals (mixed document types) through optional props
// that default to the cash behaviour above:
//   select(rows)  -> the rows to post        (default: unposted cash requests)
//   keyOf(row)    -> unique row key          (default: InternalID)
//   amountOf(row) -> the row's amount        (default: row[cfg.amountField])
//   postOne(row)  -> Promise<{ ok, message }> (default: cfg.op on cfg.sp)
//   columns       -> [{ label, render(row), align, mono }] (default: cash columns)
//   subtitle(n)   -> the line under the title
//   toolbar       -> a node above the totals (e.g. a type picker)

const money = (v) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => (v ? String(v).slice(0, 10) : '');
const btn = { height: 36, padding: '0 16px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
const primary = { ...btn, background: 'var(--orange)', color: '#fff', border: 'none' };
const th = { textAlign: 'left', padding: '7px 8px', fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)', background: 'var(--soft)', position: 'sticky', top: 0, whiteSpace: 'nowrap' };
const td = { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };

export const unposted = (rows, amountField) =>
  (rows || []).filter(r => [0, 10].includes(Number(r.DoucmentState)) && Number(r[amountField]) > 0);

const CASH_COLUMNS = (cfg) => [
  { label: 'ID', render: r => r.InternalID, mono: true },
  { label: 'Request date', render: r => day(r.RequestDate), nowrap: true },
  { label: 'State', render: r => r.StateDescription || r.DoucmentState },
  { label: 'Treasury', render: r => r.TreasureyCode },
  { label: cfg.party, render: r => r.Contact || r.Note || '', dir: 'auto', maxWidth: 220 },
];

export default function CashPostAll({ rows, cfg, pageGroupId, afterPost, onClose, select, keyOf, amountOf, postOne, columns, subtitle, toolbar }) {
  const keyFn = keyOf || (r => r.InternalID);
  const amountFn = amountOf || (r => r[cfg.amountField]);
  const list = useMemo(() => (select ? select(rows) : unposted(rows, cfg.amountField)
    .sort((a, b) => day(a.RequestDate).localeCompare(day(b.RequestDate)) || a.InternalID - b.InternalID)), [rows, cfg.amountField, select]);
  const cols = columns || CASH_COLUMNS(cfg);
  const [results, setResults] = useState({});   // row key -> { ok, message }
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  // totals per currency (amounts are only additive within one currency)
  const byCcy = useMemo(() => {
    const m = new Map();
    list.forEach(r => { const c = r.Currency || 'EGP'; const e = m.get(c) || { n: 0, amt: 0 }; e.n += 1; e.amt += Number(amountFn(r)) || 0; m.set(c, e); });
    return [...m.entries()];
  }, [list, amountFn]);

  const postAll = async () => {
    setRunning(true);
    for (const r of list) {
      const k = keyFn(r);
      if (results[k]?.ok) continue;
      try {
        let ok, message;
        if (postOne) ({ ok, message } = await postOne(r));
        else {
          const res = await apiCall(cfg.op, { PageGroupID: pageGroupId, InternalID: r.InternalID, [cfg.dateParam]: day(r.RequestDate) }, {}, { spName: cfg.sp });
          ok = res.State === 0;
          message = res.Message || (ok ? 'Posted' : 'Failed');
          if (ok && afterPost && !(await afterPost(r, message))) message += ' — ticket message not sent';
        }
        setResults(p => ({ ...p, [k]: { ok, message } }));
      } catch (e) {
        setResults(p => ({ ...p, [k]: { ok: false, message: 'Connection error: ' + e.message } }));
      }
    }
    setRunning(false); setDone(true);
  };

  const okCount = Object.values(results).filter(x => x.ok).length;
  const failCount = Object.values(results).filter(x => !x.ok).length;
  const changed = okCount > 0;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={`${cfg.title} — Post All`} style={{ width: 860, maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>Post all · {cfg.title}</h3>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
            {subtitle ? subtitle(list.length) : list.length
              ? `${list.length} unposted request${list.length === 1 ? '' : 's'} in the current filter. Each is posted to the GL on its own request date.`
              : 'There are no unposted requests in the current filter.'}
          </p>
        </div>

        {toolbar && <div style={{ padding: '12px 22px 0', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>{toolbar}</div>}

        {list.length > 0 && (
          <div style={{ padding: '12px 22px 0', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {byCcy.map(([c, e]) => (
              <div key={c} style={{ flex: '1 1 160px', border: '1px solid var(--border)', borderTop: '3px solid var(--orange)', borderRadius: 10, padding: '8px 12px', background: 'var(--surface)' }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase' }}>{e.n} request{e.n === 1 ? '' : 's'} · {c}</div>
                <div style={{ fontSize: 19, fontWeight: 800, fontFamily: 'var(--mono, monospace)', color: 'var(--text)' }}>{money(e.amt)}</div>
              </div>
            ))}
            {(okCount > 0 || failCount > 0) && (
              <div style={{ flex: '1 1 160px', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', background: 'var(--surface)' }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase' }}>Result</div>
                <div style={{ fontSize: 14, fontWeight: 800 }}>
                  <span style={{ color: 'var(--green)' }}>{okCount} posted</span>
                  {failCount > 0 && <span style={{ color: 'var(--red)' }}> · {failCount} failed</span>}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ padding: '12px 22px', overflow: 'auto', flex: 1, minHeight: 0 }}>
          {list.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  {cols.map(c => <th key={c.label} style={{ ...th, ...(c.align ? { textAlign: c.align } : {}) }}>{c.label}</th>)}
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Ccy</th><th style={th}>Result</th>
                </tr></thead>
                <tbody>{list.map(r => {
                  const k = keyFn(r);
                  const res = results[k];
                  return (
                    <tr key={k}>
                      {cols.map(c => (
                        <td key={c.label} dir={c.dir} style={{ ...td, ...(c.mono ? { fontFamily: 'var(--mono, monospace)' } : {}), ...(c.nowrap ? { whiteSpace: 'nowrap' } : {}),
                          ...(c.maxWidth ? { maxWidth: c.maxWidth } : {}), ...(c.align ? { textAlign: c.align } : {}) }}>{c.render(r)}</td>
                      ))}
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono, monospace)', fontWeight: 700 }}>{money(amountFn(r))}</td>
                      <td style={td}>{r.Currency}</td>
                      <td style={{ ...td, fontSize: 11.5, fontWeight: 700, color: res ? (res.ok ? 'var(--green)' : 'var(--red)') : 'var(--muted)' }}>
                        {res ? `${res.ok ? '✓' : '✕'} ${res.message}` : running ? '…' : ''}
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button style={btn} onClick={() => onClose(changed)} disabled={running}>{done ? 'Close' : 'Cancel'}</button>
          {list.length > 0 && (!done || failCount > 0) && (
            <button style={primary} onClick={postAll} disabled={running}>
              {running ? `Posting… ${okCount + failCount}/${list.length}` : done ? `Retry ${failCount} failed` : `Post all (${list.length})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
