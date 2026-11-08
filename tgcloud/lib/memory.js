// PB cross-platform conversation memory.
// Ported from artifacts/api-server/src/lib/pb-memory.ts, on SQLite.
// v1: user_key is "telegram:{id}". Linking Telegram/Discord via clerk ids
// (approved_users table) is a v2 migration item. History: last 20 loaded,
// trimmed to the most recent 60 per user on every write (source semantics).

import db, { eq, desc, sql } from 'sdk/db';
import { pb_conversations } from '../schema.js';

/** Resolve a user key. v1: platform-scoped key only. */
export async function resolveUserKey(platform, platformUserId) {
  return `${platform}:${platformUserId}`;
}

/**
 * Memory key for a Telegram conversation. The default/legacy conversation
 * (bot DMs + Mini App chat without a session) stays `telegram:{id}` —
 * untouched. A named Mini App chat session (chat_sessions row) uses
 * `telegram:{id}:s{sessionId}`, so sessions never bleed into each other
 * or into the default stream.
 */
export function sessionUserKey(telegramId, sessionId) {
  const base = `telegram:${telegramId}`;
  const sid = Number(sessionId);
  return Number.isSafeInteger(sid) && sid > 0 ? `${base}:s${sid}` : base;
}

/** Load the last `limit` messages for a user key, oldest first. */
export async function loadHistory(userKey, limit = 20) {
  try {
    const rows = await db.select().from(pb_conversations)
      .where(eq(pb_conversations.userKey, userKey))
      .orderBy(desc(pb_conversations.createdAt))
      .limit(limit);
    return rows
      .reverse()
      .map((r) => ({
        role: r.role === 'model' ? 'assistant' : 'user',
        content: r.content,
      }));
  } catch (err) {
    console.error('[memory] loadHistory failed:', err?.message ?? err);
    return [];
  }
}

/** Persist one message; trim to the most recent 60 per user. */
export async function saveMessage(userKey, role, content, platform) {
  try {
    await db.insert(pb_conversations).values({
      userKey,
      role: role === 'assistant' ? 'model' : 'user',
      content: String(content ?? '').slice(0, 8000),
      platform: platform ?? 'telegram',
    });
    await db.run(sql`
      DELETE FROM pb_conversations
      WHERE user_key = ${userKey}
        AND id NOT IN (
          SELECT id FROM pb_conversations
          WHERE user_key = ${userKey}
          ORDER BY created_at DESC
          LIMIT 60
        )`);
  } catch (err) {
    // Non-fatal — conversation still works without memory.
    console.error('[memory] saveMessage failed:', err?.message ?? err);
  }
}
