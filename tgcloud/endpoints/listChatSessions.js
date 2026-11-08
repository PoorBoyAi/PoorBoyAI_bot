// Mini App: list the caller's OWN named chat sessions (item 12), newest
// activity first, each with its pb_conversations message count.
import db, { eq, desc } from 'sdk/db';
import { chat_sessions, pb_conversations } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { sessionUserKey } from '../lib/memory.js';
import { sessionView } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  let rows = [];
  try {
    rows = await db.select().from(chat_sessions)
      .where(eq(chat_sessions.telegramUserId, String(tg.id)))
      .orderBy(desc(chat_sessions.updatedAt)).all();
  } catch { /* table pending migration / no sessions */ }
  const sessions = [];
  for (const row of rows) {
    let count = 0;
    try {
      const msgs = await db.select().from(pb_conversations)
        .where(eq(pb_conversations.userKey, sessionUserKey(tg.id, row.id))).all();
      count = msgs.length;
    } catch { /* count unavailable reads as 0 */ }
    sessions.push(sessionView(row, count));
  }
  return { sessions };
};
