// Mini App: recent brain conversation for the Chat tab. With an optional
// sessionId (item 12) it reads that named session's own stream — ownership
// verified server-side; without one, the default stream, as before.
import { caller } from '../lib/miniapp.js';
import { resolveUserKey, sessionUserKey, loadHistory } from '../lib/memory.js';
import { requireOwnedSession } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  let userKey;
  if (input?.sessionId != null) {
    const session = await requireOwnedSession(tg.id, input.sessionId);
    userKey = sessionUserKey(tg.id, session.id);
  } else {
    userKey = await resolveUserKey('telegram', tg.id);
  }
  const messages = await loadHistory(userKey, 50);
  return { messages };
};
