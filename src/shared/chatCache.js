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

// The newest server row we hold: the AfterChatID of the next delta.
export const newestId = (messages) =>
  messages.reduce((max, m) => (typeof m.id === 'number' && m.id > max ? m.id : max), 0);

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
