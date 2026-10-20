// Account statement math, shared by the Account Statement page and its
// printed report (ReportMenu 'accountStatement' layout) so both always agree.
// Port of legacy PRO.AccountingStatement (AccountStatment.frx):
//   * one block per Account; each dimension the user picks (Currency or a
//     segment) splits the blocks further -- legacy grouped by a segment only
//     when it was filtered
//   * opening = SUM(Debit - Credit) of everything BEFORE From, Book and
//     Transaction, per block
//   * lines oldest first with running balances; totals; closing
//     = opening + debit - credit
// `lines` are the period's rows (PLS.QVAccountStatement), `openings` the
// "ACS Opening" Group By rows (aggregates by DisplayName) up to From - 1.

export const AS_DIMS = [
  { key: 'LineCurrency', label: 'Currency', ar: 'العملة' },
  { key: 'DebitorCreditor', name: 'DebitorCreditorName', label: 'Debtor / Creditor', ar: 'مدين / دائن' },
  { key: 'Customer', name: 'CustomerName', label: 'Customer', ar: 'العميل' },
  { key: 'Vendor', name: 'VendorName', label: 'Vendor', ar: 'المورد' },
  { key: 'Bank', name: 'BankName', label: 'Bank', ar: 'البنك' },
  { key: 'Segment7', name: 'Segment7Name', label: 'Asset', ar: 'الأصل' },
  { key: 'Segment8', name: 'Segment8Name', label: 'Employee', ar: 'الموظف' },
  { key: 'Segment9', name: 'Segment9Name', label: 'Expense', ar: 'المصروف' },
  { key: 'Segment10', name: 'Segment10Name', label: 'Customer Expense', ar: 'مصروفات العملاء' },
];

const day = (v) => (v ? String(v).slice(0, 10) : '');
const n = (v) => Number(v) || 0;
const tiny = (v) => Math.abs(v) < 0.005;

// grouped GetGridData row -> the line field names
export function normaliseOpening(r) {
  return { ...r, DebitBook: n(r['Debit Book']), CreditBook: n(r['Credit Book']), DebitTransaction: n(r['Debit Trans']), CreditTransaction: n(r['Credit Trans']) };
}

// dims: keys of AS_DIMS to group by; only: { dimKey: value } keeps just that value;
// key / desc: the block's field + its description -- Account by default, the
// party (Vendor / Debtor / Bank) for the party statements
export function buildAccountStatement(lines, openings, dims = [], only = {}, key = 'Account', desc = 'AccountDescription') {
  const active = AS_DIMS.filter(d => dims.includes(d.key));
  const keep = (r) => Object.entries(only).every(([k, v]) => v === '' || v == null || String(r[k] ?? '') === String(v));
  const keyOf = (r) => [r[key], ...active.map(d => r[d.key] ?? '')].join('\u0001');
  const groups = new Map();
  const ensure = (r) => {
    const k = keyOf(r);
    if (!groups.has(k)) {
      groups.set(k, {
        key: k, account: String(r[key] ?? ''), accountDescription: r[desc] || '',
        dims: active.map(d => ({ key: d.key, label: d.label, ar: d.ar, code: String(r[d.key] ?? ''), name: d.name ? (r[d.name] || '') : '' })),
        openB: 0, openT: 0, debitB: 0, creditB: 0, debitT: 0, creditT: 0, lines: [], currencies: new Set(),
      });
    }
    return groups.get(k);
  };
  for (const o of openings || []) {
    if (!keep(o)) continue;
    const g = ensure(o);
    g.openB += o.DebitBook - o.CreditBook;
    g.openT += o.DebitTransaction - o.CreditTransaction;
    if (!tiny(o.DebitTransaction - o.CreditTransaction)) g.currencies.add(o.LineCurrency || 'EGP');
  }
  for (const r of lines || []) {
    if (!keep(r)) continue;
    const g = ensure(r);
    if (!g.accountDescription) g.accountDescription = r[desc] || '';
    g.dims.forEach(d => { const nf = AS_DIMS.find(x => x.key === d.key)?.name; if (!d.name && nf) d.name = r[nf] || ''; });
    g.lines.push(r);
    g.currencies.add(r.LineCurrency || 'EGP');
  }
  const out = [];
  for (const g of groups.values()) {
    if (!g.lines.length && tiny(g.openB) && tiny(g.openT)) continue;   // nothing to show
    g.lines.sort((a, b) => day(a.JournalDate).localeCompare(day(b.JournalDate))
      || String(a.JournalNumber).localeCompare(String(b.JournalNumber)) || n(a.Line) - n(b.Line));
    let bb = g.openB, bt = g.openT;
    g.lines = g.lines.map(r => {
      g.debitB += n(r.DebitBook); g.creditB += n(r.CreditBook);
      g.debitT += n(r.DebitTransaction); g.creditT += n(r.CreditTransaction);
      bb += n(r.DebitBook) - n(r.CreditBook); bt += n(r.DebitTransaction) - n(r.CreditTransaction);
      return { ...r, BalanceBook: bb, BalanceTrans: bt };
    });
    g.closeB = g.openB + g.debitB - g.creditB;
    g.closeT = g.openT + g.debitT - g.creditT;
    g.currency = g.currencies.size === 1 ? [...g.currencies][0] : (g.currencies.size ? 'mixed' : '');
    out.push(g);
  }
  out.sort((a, b) => a.account.localeCompare(b.account)
    || a.dims.map(d => d.code).join('|').localeCompare(b.dims.map(d => d.code).join('|')));
  const sum = (f) => out.reduce((s, g) => s + g[f], 0);
  const ccys = new Set(out.flatMap(g => [...g.currencies]));
  return {
    groups: out,
    totals: {
      openB: sum('openB'), debitB: sum('debitB'), creditB: sum('creditB'), closeB: sum('closeB'),
      openT: sum('openT'), debitT: sum('debitT'), creditT: sum('creditT'), closeT: sum('closeT'),
      lines: out.reduce((s, g) => s + g.lines.length, 0),
      // Transaction amounts only add up within one currency
      currency: ccys.size === 1 ? [...ccys][0] : (ccys.size ? 'mixed' : ''),
    },
  };
}
