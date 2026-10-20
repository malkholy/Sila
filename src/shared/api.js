const IS_DEV = import.meta.env.DEV;
const API_URL = IS_DEV
  ? '/api/General/GeneralAPI/'
  : 'https://sila.silasystem.com:7103/General/GeneralAPI/';

// Every web operation routes through this single stored procedure.
const SP_NAME = 'Pls.APIPlusOperationV1';

const BASE_BODY = {
  AppVersionWeb: '255',
  AppVersionAndroid: '255',
  AppVersionIos: '255',
  AppVersionDesktop: '255',
  FireBaseToken: '',
  PlatForm: 'web',
  deviceID: '',
  IP: '192.168.1.3'
};

// `apiType` is kept for call-site compatibility but ignored -- the generic
// router SP is the default. Pass an object `{ spName }` as the 4th arg to route
// a page-business operation to its own SP (e.g. Pls.APIPlusPurchaseOrderOperation)
// -- the gateway dispatches on the SP_Name header. Still permission-checked
// server-side inside that SP.
// Re-call strategy (2026-10-17). The gateway intermittently hangs ~40 s and
// then answers with an empty body. Only READS on the generic router are ever
// repeated -- writes and every page-business SP (saves, posts, Get Price...)
// go out exactly once, so nothing can be recorded twice.
//   * metadata reads (page settings, lookup lists -- tiny, normally < 2 s):
//     cut off after META_TIMEOUT_MS, then retried; the last try has no cut-off
//   * data reads (GetGridData, View, GetKPIData, reports...): never cut off --
//     a big grid can legitimately take a while -- but an empty / failed reply
//     is retried
//   * up to READ_ATTEMPTS tries, waiting RETRY_DELAYS_MS between them
//   * identical reads already in flight (same SP + body, i.e. same user) share
//     one request instead of going out twice
// A retry fires a 'sila:api-retry' window event so the app can show a note.
const READ_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];
const META_TIMEOUT_MS = 12000;
const META_OPS = new Set(['GetQueryMaster', 'GetQueryFields', 'GetQueryFilterLinks', 'GetPageQueries', 'GetPageGroupBys',
  'GetPageKPIs', 'GetKPIVisibility', 'GetDataViews', 'GetDataView', 'GetGroupByColumnOrder', 'GetFilterOptions']);
const inFlight = new Map();   // SP + body -> Promise (reads only)

// Page-settings cache (phase 2). The metadata every page reads on open (query,
// fields, filter links, group-bys, KPIs, data views...) hardly ever changes, so
// a successful answer is kept for the session -- keyed by SP + body, which
// includes the user. Dropped by clearApiCache() (login, logout, sidebar
// Reload), after SETTINGS_TTL_MS, and after ANY write on the generic router
// (every metadata save -- SaveQueryMaster, SaveDataView, SaveKPIVisibility,
// SaveGroupByColumnOrder... -- goes through it).
const SETTINGS_OPS = new Set(['GetQueryMaster', 'GetQueryFields', 'GetQueryFilterLinks', 'GetPageQueries', 'GetPageGroupBys',
  'GetPageKPIs', 'GetKPIVisibility', 'GetDataViews', 'GetDataView', 'GetGroupByColumnOrder']);
const SETTINGS_TTL_MS = 30 * 60 * 1000;
const settingsCache = new Map();   // SP + body -> { text, at }
let settingsGen = 0;               // bumped on every clear: an answer that was in flight across a clear is not stored
export function clearApiCache() { settingsCache.clear(); settingsGen++; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// SP operations that de-duplicate by LineData.RequestID (PLS.V1RequestLog) --
// every caller of these gets a request id + safe re-send automatically.
// Add an entry ONLY once the SP version that honours RequestID is live:
// re-sending to an SP that doesn't de-duplicate could save twice.
const IDEMPOTENT_OPS = new Set([
  'Pls.APIPlusInvoiceCollectionOperation:CollectInvoices',
  'Pls.APIPlusCashReceiveOperation:SaveCashReceive',
  'Pls.APIPlusCashReceiveOperation:PostCashReceive',
  'Pls.APIPlusCashReceiveOperation:DeleteCashReceive',
  'Pls.APIPlusCashPayableOperation:SaveCashPayable',
  'Pls.APIPlusCashPayableOperation:PostCashPayable',
  'Pls.APIPlusCashPayableOperation:DeleteCashPayable',
  'Pls.APIPlusVendorInvoicePaymentOperation:NewInvoicePaymentHeader',
  'Pls.APIPlusVendorInvoicePaymentOperation:PayVendorInvoices',
]);
const newRequestId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

async function sendOnce(headers, body, timeoutMs) {
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(API_URL, { method: 'POST', headers, body, signal: ctrl?.signal });
    return await res.text();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`No response from server after ${Math.round(timeoutMs / 1000)} s`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readWithRetry(operation, headers, body) {
  const meta = META_OPS.has(operation);
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= READ_ATTEMPTS;
    let text, failure;
    try {
      text = await sendOnce(headers, body, meta && !last ? META_TIMEOUT_MS : 0);
      if (!text) failure = new Error('Empty response from server');
    } catch (err) { failure = err; }
    if (!failure) {
      console.log(operation, 'raw:', text);
      return text;
    }
    if (last) throw failure;
    console.warn(operation, `attempt ${attempt} failed (${failure.message}), retrying`);
    try { window.dispatchEvent(new CustomEvent('sila:api-retry', { detail: { operation, attempt } })); } catch { /* no window */ }
    await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3000);
  }
}

// A write that got no answer (empty body / connection dropped) may or may not
// have been applied -- the gateway often finishes the SQL after the reply is
// lost. Never retried; instead the caller gets an error with code
// 'WRITE_UNKNOWN' and a message that says so, caches are refreshed in case it
// did save, and 'sila:write-unknown' lets the app warn the user to check the
// record before trying again (a blind retry could post it twice).
export const WRITE_UNKNOWN_MESSAGE =
  'The server did not confirm this action, so it may or may not have been saved. ' +
  'Check the record (reload the list) before trying again -- repeating it blindly could save it twice.';
function writeOutcomeUnknown(operation, spName, cause) {
  const err = new Error(WRITE_UNKNOWN_MESSAGE);
  err.code = 'WRITE_UNKNOWN';
  err.operation = operation;
  if (cause) err.cause = cause;
  console.warn(operation, 'write outcome unknown:', cause?.message || 'empty response');
  if (spName === SP_NAME) clearApiCache();
  try {
    window.dispatchEvent(new CustomEvent('sila:api-write', { detail: { operation, spName, unknown: true } }));
    window.dispatchEvent(new CustomEvent('sila:write-unknown', { detail: { operation, spName } }));
  } catch { /* no window */ }
  return err;
}

export async function apiCall(operation, lineData = null, extraParams = {}, apiType = 'default') {
  const spName = (apiType && typeof apiType === 'object' && apiType.spName) ? apiType.spName : SP_NAME;
  // `idempotent: true` -- only for SP operations that honour LineData.RequestID
  // (PLS.V1RequestLog, see SQLScript/V1RequestLog.sql): the save gets a fresh id
  // and, if its reply is lost, is re-sent unchanged; the SP answers "Already
  // saved" for a copy it has applied, so nothing is written twice.
  const idempotent = !!(apiType && typeof apiType === 'object' && apiType.idempotent)
    || IDEMPOTENT_OPS.has(spName + ':' + operation);
  if (idempotent) lineData = { ...(lineData || {}), RequestID: newRequestId() };
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'SP_Name': spName
  };

  const body = JSON.stringify({
    ...BASE_BODY,
    Operation: operation,
    LineData: lineData ? JSON.stringify(lineData) : null,
    User: sessionStorage.getItem('Username') || sessionStorage.getItem('FullName') || '',
    ...extraParams
  });

  const isRead = spName === SP_NAME && (operation === 'View' || /^Get[A-Z]/.test(operation));
  if (!isRead) {
    // writes / page-business SPs: one request -- unless the SP de-duplicates by
    // RequestID, in which case a lost reply is re-sent (same body, same id)
    let text, lastErr = null;
    const tries = idempotent ? READ_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= tries; attempt++) {
      lastErr = null;
      try { text = await sendOnce(headers, body, 0); } catch (err) { lastErr = err; text = ''; }
      if (text) break;
      if (attempt < tries) {
        console.warn(operation, `no reply to attempt ${attempt}, re-sending the same request (RequestID)`);
        try { window.dispatchEvent(new CustomEvent('sila:api-retry', { detail: { operation, attempt } })); } catch { /* no window */ }
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3000);
      }
    }
    console.log(operation, 'raw:', text);
    if (!text) throw writeOutcomeUnknown(operation, spName, lastErr);
    // something may have changed: router writes drop the page-settings cache;
    // every write tells the lookup cache to refresh its lists on next open
    if (spName === SP_NAME) clearApiCache();
    try { window.dispatchEvent(new CustomEvent('sila:api-write', { detail: { operation, spName } })); } catch { /* no window */ }
    return JSON.parse(text);
  }
  // share the raw text; each caller parses its own copy (no shared mutable object)
  const key = spName + '\n' + body;
  if (SETTINGS_OPS.has(operation)) {
    const hit = settingsCache.get(key);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return JSON.parse(hit.text);
  }
  let p = inFlight.get(key);
  if (!p) {
    p = readWithRetry(operation, headers, body).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    if (SETTINGS_OPS.has(operation)) {
      // keep successful answers only (State 0), and only if nothing was saved meanwhile
      const gen = settingsGen;
      p.then(text => {
        try { if (gen === settingsGen && JSON.parse(text).State === 0) settingsCache.set(key, { text, at: Date.now() }); } catch { /* not JSON */ }
      }, () => {});
    }
  }
  return JSON.parse(await p);
}

// Ticket/chat system -- a separate gateway (its own server + SP, not the
// ERP router). Posts one "New Chat" message into a ticket as the logged-in
// user. Contract copied from the ticket team's Postman example; LastChatID /
// MinChatID / OrginalChatID are the chat client's sync cursors and are 0 for
// a fire-and-forget post. On success the gateway echoes the ticket's chat
// rows (verified live), including ours with the LocalChatID we generated --
// that echo, not a status code, is what `sent` reports. Throws on transport
// errors.
const TICKET_API_URL = 'https://sila.silasystem.com:9101/General/GeneralAPI';
const TICKET_SP_NAME = '[CHA].[APITicketOperation]';

// LocalChatID = the source record's id followed by 3 random digits (e.g.
// InternalID 20270 -> 20270483), so the ticket side can trace a message back
// to the ERP record. 3 digits keeps it within SQL INT for ids up to 2,147,483;
// with no/oversized recordId it falls back to a random 8-digit number.
function makeLocalChatId(recordId) {
  const rand = Math.floor(Math.random() * 1000);
  const id = Number(recordId);
  if (Number.isInteger(id) && id > 0 && id <= 2147483) return id * 1000 + rand;
  return 10000000 + Math.floor(Math.random() * 90000000);
}

export async function sendTicketChat({ ticketId, channelId, text, recordId }) {
  const user = sessionStorage.getItem('Username') || sessionStorage.getItem('FullName') || '';
  const localChatId = makeLocalChatId(recordId);
  const body = JSON.stringify({
    operation: 'New Chat',
    User: user,
    TicketID: ticketId,
    ChannelID: channelId,
    LineData: JSON.stringify({
      ChatID: 0, TicketID: ticketId, ChannelID: channelId, Text: text, TextStyle: '',
      ReplayMsgID: 0, LocalChatID: localChatId, OrginalChatID: 0, IsAdmin: 0,
    }),
    LastChatID: 0,
    MinChatID: 0,
    PlatForm: 'web',
    WebVersion: '17',
    AndroidVersion: '13',
    IOSVersion: '13',
    DeskTopVerion: '13',
    FireBaseToken: '',
  });
  const res = await fetch(TICKET_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sp_name': TICKET_SP_NAME },
    body,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = raw ? JSON.parse(raw) : {};
  const rows = Object.keys(data).filter(k => /^List\d+$/.test(k)).flatMap(k => data[k] || []);
  return { ...data, sent: rows.some(r => r?.LocalChatID === localChatId) };
}

async function sha1(string) {
  const utf8 = new TextEncoder().encode(string);
  const hashBuffer = await window.crypto.subtle.digest('SHA-1', utf8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

export async function uploadToCloudinary(file) {
  const cloudName = 'peeuy5s9';
  const apiKey = '419134873188179';
  const apiSecret = 'NoxrhWPv3O0_kWuWIMPtuxuD16k';
  const folder = 'Plus';
  const timestamp = Math.round(new Date().getTime() / 1000);

  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = await sha1(paramsToSign + apiSecret);

  const formData = new FormData();
  formData.append('file', file);
  formData.append('folder', folder);
  formData.append('timestamp', timestamp);
  formData.append('api_key', apiKey);
  formData.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Cloudinary upload failed: ' + errText);
  }

  const json = await res.json();
  return json.secure_url;
}
