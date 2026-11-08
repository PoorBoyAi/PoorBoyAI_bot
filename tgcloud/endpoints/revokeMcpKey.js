// Stage B (MCP core): revoke one of the caller's developer API keys.
// The row is kept (history + audit), stamped with revokedAt; the Worker
// stops honoring it on the next key-directory sync. Idempotent: revoking
// an already-revoked key still reports ok:true. A caller can only revoke
// their own keys (unknown or foreign ids → VALIDATION).
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { mcp_api_keys } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  const id = Number(input?.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new EndpointError('A numeric key id is required.', { code: 'VALIDATION', field: 'id' });
  }

  let row = null;
  try {
    row = await db.select().from(mcp_api_keys)
      .where(and(eq(mcp_api_keys.id, id), eq(mcp_api_keys.telegramUserId, tgId))).get();
  } catch { row = null; }
  if (!row) {
    throw new EndpointError('That key does not exist.', { code: 'VALIDATION', field: 'id' });
  }

  if (!row.revokedAt) {
    try {
      await db.update(mcp_api_keys).set({ revokedAt: new Date() })
        .where(eq(mcp_api_keys.id, id)).run();
    } catch (err) {
      throw new EndpointError('PB could not revoke that key. Try again.', {
        code: 'DB_ERROR',
        cause: String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  return { ok: true, id };
};
