// Mini App: rename one of the caller's OWN chat sessions (item 12).
import { EndpointError } from 'sdk';
import db, { eq } from 'sdk/db';
import { chat_sessions } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { requireOwnedSession, sessionView } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const row = await requireOwnedSession(tg.id, input?.sessionId);
  const title = String(input?.title ?? '').trim().slice(0, 80);
  if (!title) throw new EndpointError('Title cannot be empty.', { code: 'BAD_TITLE' });
  await db.update(chat_sessions).set({ title, updatedAt: new Date() })
    .where(eq(chat_sessions.id, row.id)).run();
  return { session: sessionView({ ...row, title, updatedAt: new Date() }) };
};
