// Customer statement math, shared by the Customer Statement page and the
// printed report (ReportMenu 'statement' layout) so both always agree.
// Port of legacy PRO.CustomerStatement (Customer Statement - National.frx):
//   opening  = sum(Debit - Credit) Book of every line BEFORE `from`
//   lines    = the lines from `from` to `to`, oldest first, each with the
//              running balance (opening + debits - credits so far)
//   totals   = period debit / credit; closing = opening + debit - credit
// `rows` are one customer's posted lines (PLS.QVCustomerStatement) -- the
// date window is applied here.
const day = (v) => (v ? String(v).slice(0, 10) : '');

export function computeStatement(rows, from, to) {
  const f = day(from), t = day(to);
  let opening = 0;
  const lines = [];
  for (const r of rows || []) {
    const d = day(r.JournalDate);
    const net = (Number(r.DebitBook) || 0) - (Number(r.CreditBook) || 0);
    if (f && d < f) opening += net;
    else if (!t || d <= t) lines.push(r);
  }
  lines.sort((a, b) => day(a.JournalDate).localeCompare(day(b.JournalDate))
    || String(a.JournalNumber).localeCompare(String(b.JournalNumber)) || (Number(a.Line) || 0) - (Number(b.Line) || 0));
  let balance = opening, debit = 0, credit = 0;
  const out = lines.map(r => {
    const d = Number(r.DebitBook) || 0, c = Number(r.CreditBook) || 0;
    debit += d; credit += c; balance += d - c;
    return { ...r, Balance: balance };
  });
  return { opening, lines: out, debit, credit, closing: opening + debit - credit };
}
