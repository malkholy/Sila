// App-wide operation-permission check. Mirrors the inline admin-bypass check
// already duplicated across App.jsx/UserPermissions.jsx/Pls.APIPlusOperationV1.sql
// (intentionally not centralized further -- that's the established pattern
// in this codebase) rather than introducing a new source of truth for it.
export function hasOperation(user, operationKey) {
  if (!user) return false;
  const usernameLower = (user.Username || '').toLowerCase();
  const isAdmin = user.IsAdmin === 1 || user.IsAdmin === true || usernameLower === 'sysadmin';
  if (isAdmin) return true;
  return (user.AllowedOperations || []).includes(operationKey);
}
