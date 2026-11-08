// Mini App M2: delete one of the caller's whale watches.
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { whale_watch_wallets } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  const id = Number(input?.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new EndpointError('PB needs a watch id to delete.', { code: 'VALIDATION', field: 'id' });
  }
  const row = await db.select().from(whale_watch_wallets)
    .where(and(eq(whale_watch_wallets.id, id), eq(whale_watch_wallets.telegramUserId, tgId))).get();
  if (!row) throw new EndpointError('Watch not found.', { code: 'NOT_FOUND' });

  await db.delete(whale_watch_wallets)
    .where(and(eq(whale_watch_wallets.id, id), eq(whale_watch_wallets.telegramUserId, tgId))).run();

  return { deleted: id };
};
