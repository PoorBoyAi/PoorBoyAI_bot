// Mini App: create a named chat session for the caller (item 12).
// Cap: 10 sessions per user, enforced server-side on the caller's rows.
import { EndpointError } from 'sdk';
import db, { eq } from 'sdk/db';
import { chat_sessions } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { MAX_CHAT_SESSIONS, cleanSessionTitle, sessionView } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const tgId = String(tg.id);
  const existing = await db.select().from(chat_sessions)
    .where(eq(chat_sessions.telegramUserId, tgId)).all();
  if (existing.length >= MAX_CHAT_SESSIONS) {
    throw new EndpointError(
      'PB here — you already have ' + MAX_CHAT_SESSIONS + ' chat sessions. Delete one first.',
      { code: 'SESSION_LIMIT', limit: MAX_CHAT_SESSIONS, current: existing.length },
    );
  }
  const inserted = await db.insert(chat_sessions).values({
    telegramUserId: tgId,
    title: cleanSessionTitle(input?.title),
  }).returning();
  const row = inserted[0];
  if (!row) throw new EndpointError('Could not create that session. Try again.', { code: 'CREATE_FAILED' });
  return { session: sessionView(row, 0) };
};
