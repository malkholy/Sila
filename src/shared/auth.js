// Sign-in against the Sila API (SilaApi, /api/v2/auth/*) and authenticated calls.
//
// - The access token (5 min) lives in memory only.
// - The refresh token is kept so a reload stays signed in: localStorage when
//   "Remember me" is ticked, else sessionStorage (gone with the tab).
// - Refreshes are serialized: a refresh token works once, and reusing one
//   signs the whole session out (server-side replay protection).
// - When the session can't be renewed, 'sila:signed-out' fires on window.

// Dev: '' = same origin, through the Vite proxy (vite.config.js '/api/v2').
export const API_BASE = import.meta.env.VITE_SILA_API ?? (import.meta.env.DEV ? '' : 'https://sila.glcpaints.com:7400');
export const DATABASE = 'SILA101';
const STORE_KEY = 'sila.session';

let access = null;        // { token, expiresAt (ms) }
let session = null;       // { refreshToken, username, displayName, sessionExpiresAt, remember }
let refreshing = null;    // in-flight refresh promise

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function store() { return session?.remember ? localStorage : sessionStorage; }

function save(next) {
  session = next;
  try {
    localStorage.removeItem(STORE_KEY);
    sessionStorage.removeItem(STORE_KEY);
    if (next) store().setItem(STORE_KEY, JSON.stringify(next));
  } catch { /* private mode: stays signed in for this page only */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function post(path, body, token) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the Sila server. Check your connection.', 0);
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.message || `Request failed (${res.status})`, res.status);
  return data;
}

// TokenResponse -> local state; returns the public user.
function accept(tokens, remember) {
  access = { token: tokens.accessToken, expiresAt: new Date(tokens.expiresAt).getTime() };
  save({
    refreshToken: tokens.refreshToken, username: tokens.username, displayName: tokens.displayName,
    sessionExpiresAt: tokens.sessionExpiresAt, remember,
  });
  return currentUser();
}

export function currentUser() {
  return session ? { username: session.username, displayName: session.displayName || session.username } : null;
}

export async function login(username, password, remember) {
  let tokens;
  try {
    tokens = await post('/api/v2/auth/login', { database: DATABASE, username, password });
  } catch (err) {
    if (err.status === 401) throw new ApiError('Wrong username or password, or the account is locked.', 401);
    if (err.status === 429) throw new ApiError('Too many attempts. Wait a minute and try again.', 429);
    throw err;
  }
  if (tokens.mustChangePassword) throw new ApiError('Your password must be changed first. Change it in the Sila app, then sign in here.', 403);
  return accept(tokens, remember);
}

function signedOut() {
  access = null;
  save(null);
  try { window.dispatchEvent(new CustomEvent('sila:signed-out')); } catch { /* no window */ }
}

async function refresh() {
  if (!session?.refreshToken) throw new ApiError('Not signed in.', 401);
  if (!refreshing) {
    const { refreshToken, remember } = session;
    refreshing = post('/api/v2/auth/refresh', { database: DATABASE, refreshToken })
      .then(tokens => { accept(tokens, remember); return access.token; })
      .catch(err => {
        // 401 = session over; anything else (offline) keeps the session for a retry
        if (err.status === 401) signedOut();
        throw err;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Restores a stored session after a reload. Null when there is none / it ended.
export async function restore() {
  const stored = load();
  if (!stored?.refreshToken) return null;
  session = stored;
  try { await refresh(); } catch (err) { if (err.status === 401) return null; throw err; }
  return currentUser();
}

export async function getAccessToken() {
  if (access && access.expiresAt - Date.now() > 30_000) return access.token;
  return refresh();
}

// Authenticated POST; one silent refresh + retry on 401.
export async function authPost(path, body) {
  try {
    return await post(path, body, await getAccessToken());
  } catch (err) {
    if (err.status !== 401) throw err;
    access = null;
    return post(path, body, await refresh());
  }
}

// /api/v2/exec: { ok, state, message, data: { List0, ... } }
// extraParams: named SP parameters beyond Operation/User/LineData; each must be
// listed in the operation's AllowedParametersJson (PLS.V1ApiOperationPermission).
export function apiExec(proc, operation, lineData = null, extraParams = null) {
  return authPost('/api/v2/exec', {
    database: DATABASE, proc, operation, lineData, ...(extraParams ? { extraParams } : {}),
  });
}

// Ends the session on the server too (that also closes its live sockets).
export async function logout() {
  const token = await getAccessToken().catch(() => null);
  access = null;
  save(null);
  if (token) await post('/api/v2/auth/logout', undefined, token).catch(() => {});
}
