// Who owns a ticket (dbo.SilaTicketAssignment): ticket admins / team leaders
// assign anyone in it, a non-CC member takes it while unassigned, the assignee
// or a manager unassigns it (the SP checks it all). Every ticket row carries
// AssignedUserID / AssignedUsername / AssignedName; assignee = null when nobody.
import { apiExec } from './auth.js';

const PROC = 'CHA.APISilaWebTicketOperation';

export function assigneeOf(r) {
  const id = Number(r?.AssignedUserID) || 0;
  if (!id) return null;
  return { id, username: String(r.AssignedUsername || '').toLowerCase(), name: r.AssignedName || r.AssignedUsername || 'Someone' };
}

// each resolves to the ticket's assignee after the change (or null)
const after = (res) => assigneeOf(res?.data?.List0?.[0]);
export const assignTicket = async (ticketId, userId) => after(await apiExec(PROC, 'Assign ticket', { TicketID: ticketId, UserID: userId }));
export const takeTicket = async (ticketId) => after(await apiExec(PROC, 'Take ticket', { TicketID: ticketId }));
export const unassignTicket = async (ticketId) => after(await apiExec(PROC, 'Unassign ticket', { TicketID: ticketId }));
