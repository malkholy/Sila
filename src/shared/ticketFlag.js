// A person's own follow-up flag on a ticket (dbo.SilaTicketFlag): private,
// with an optional due date (yyyy-mm-dd) and note. The SPs return it on every
// ticket row as MyFlagged / MyFlagDue / MyFlagNote; flag = null when not flagged.
import { apiExec } from './auth.js';

export function flagOf(r) {
  if (!(Number(r?.MyFlagged) > 0)) return null;
  return { due: r.MyFlagDue ? String(r.MyFlagDue).slice(0, 10) : '', note: r.MyFlagNote || '' };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const flagOverdue = (flag) => !!flag?.due && flag.due < today();
export const flagDueToday = (flag) => !!flag?.due && flag.due === today();

// flag = { due?, note? } to set, null to clear. Resolves to the saved flag (or null).
export async function setTicketFlag(ticketId, flag) {
  const res = await apiExec('CHA.APISilaWebTicketOperation', 'Set ticket flag', {
    TicketID: ticketId, Flagged: flag ? 1 : 0, DueDate: flag?.due || '', Note: flag?.note || '',
  });
  return flagOf(res?.data?.List0?.[0]);
}
