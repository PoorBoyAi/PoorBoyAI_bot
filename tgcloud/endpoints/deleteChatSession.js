// Mini App: delete one of the caller's OWN chat sessions (item 12), and
// trim that session's pb_conversations rows. Another user's session id
// resolves to SESSION_NOT_FOUND — nothing is deleted.
import db, { eq } from 'sdk/db';
import { chat_sessions, pb_conversations } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { sessionUserKey } from '../lib/memory.js';
import { requireOwnedSession } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const row = await requireOwnedSession(tg.id, input?.sessionId);
  await db.delete(pb_conversations)
    .where(eq(pb_conversations.userKey, sessionUserKey(tg.id, row.id))).run();
  await db.delete(chat_sessions).where(eq(chat_sessions.id, row.id)).run();
  return { ok: true, deleted: row.id };
};
