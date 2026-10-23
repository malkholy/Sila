// In-memory cache of opened conversations (Phase 1 of the chat caching plan):
// reopening a chat shows what was loaded before at once, then only newer rows
// are fetched (AfterChatID, Phase 2). Lives for the session; cleared on
// sign-out. Bounded: the 30 most recently opened conversations, the newest
// 200 messages of each.

const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES = 200;
const cache = new Map();   // key -> { header, messages, hasMore }, oldest-opened first

export const cacheKey = (item) =>
  `${item.kind}:${item.kind === 'group' ? item.raw?.GroupID : item.kind === 'ticket' ? item.raw?.TicketID : item.raw?.SessionID}`;

export function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);          // most recently used goes last
  cache.set(key, entry);
  return entry;
}

const bySort = (a, b) => (a.sortId - b.sortId) || (a.id - b.id);

export function putCached(key, { header, messages, hasMore }) {
  const settled = messages.filter(m => typeof m.id === 'number');   // never cache optimistic sends
  const trimmed = settled.length > MAX_MESSAGES;
  cache.delete(key);
  cache.set(key, {
    header,
    messages: trimmed ? settled.slice(-MAX_MESSAGES) : settled,
    hasMore: hasMore || trimmed,
  });
  while (cache.size > MAX_CONVERSATIONS) cache.delete(cache.keys().next().value);
}

export function clearChatCache() {
  cache.clear();
}

// Where a delta starts: SYNC_OVERLAP messages back from the newest held, not
// the newest itself. The newest held is often the user's own send, which can
// get a higher ChatID than a message from the other side still on its way
// (sent a moment earlier, or committed a little later); asking only for what
// is newer than it would skip that message for good. The overlap is merged
// by id (applyDelta), so re-reading it changes nothing.
export const SYNC_OVERLAP = 20;
export function syncAnchor(messages) {
  const ids = (messages || []).filter(m => m.id > 0).map(m => m.id).sort((a, b) => b - a);
  if (!ids.length) return 0;
  return ids[Math.min(SYNC_OVERLAP, ids.length) - 1] - 1;
}

// Applies newer rows in ChatID order: a new message is added; an edit /
// delete copy replaces the row it points at (original), so A -> B -> C
// arriving together ends with C only.
export function applyDelta(messages, delta) {
  if (!delta.length) return messages;
  let list = messages;
  for (const d of [...delta].sort((a, b) => a.id - b.id)) {
    list = list.filter(x => x.id !== d.id && (!d.original || x.id !== d.original));
    list.push(d);
  }
  return list.sort(bySort);
}
