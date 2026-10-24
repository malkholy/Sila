// A person's profile card (dbo.APISilaWebOperation 'User profile', over the
// mobile app's dbo.V_UserMaster_1): name, photo, job, department, user group,
// mobile, local extension and HR employee id. Kept for the session, by user id
// and by username. Avatars ask for it with openProfile(); ProfileCard.jsx shows it.
import { apiExec } from './auth.js';

const cache = new Map();   // "id:24" / "u:mhd" -> Promise<profile>

export function loadUserProfile({ userId, username }) {
  const key = userId ? `id:${userId}` : `u:${String(username || '').toLowerCase()}`;
  if (!cache.has(key)) {
    const p = apiExec('dbo.APISilaWebOperation', 'User profile', userId ? { UserID: userId } : { Username: username })
      .then(res => {
        const r = res?.data?.List0?.[0];
        if (!r) throw new Error('User not found.');
        return {
          id: r.UserID, username: String(r.Username || '').toLowerCase(), name: r.FullName || r.Username || '',
          job: r.JobName || '', department: r.DepartmentName || '', userGroup: r.UserGroupName || '',
          mobile: String(r.MobileNumber || '').trim(), extension: String(r.LocalNumber || '').trim(),
          employeeId: r.EmployeeID == null ? '' : String(r.EmployeeID), photoUrl: r.PhotoURL || '',
          active: !(Number(r.IsNotActive) > 0),
        };
      });
    p.catch(() => cache.delete(key));   // a failure is retried next time
    cache.set(key, p);
  }
  return cache.get(key);
}

// Ask the card to open for a person, next to the element that was clicked.
export function openProfile({ userId, username, name, photoUrl }, anchor) {
  const rect = anchor?.getBoundingClientRect?.() || null;
  window.dispatchEvent(new CustomEvent('sila:profile', { detail: { userId, username, name, photoUrl, rect } }));
}
