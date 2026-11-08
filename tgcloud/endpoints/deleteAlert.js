// Mini App M2: delete one of the caller's price alerts.
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { price_alerts } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  const id = Number(input?.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new EndpointError('PB needs an alert id to delete.', { code: 'VALIDATION', field: 'id' });
  }
  const row = await db.select().from(price_alerts)
    .where(and(eq(price_alerts.id, id), eq(price_alerts.telegramUserId, tgId))).get();
  if (!row) throw new EndpointError('Alert not found (it may already have fired).', { code: 'NOT_FOUND' });

  await db.delete(price_alerts)
    .where(and(eq(price_alerts.id, id), eq(price_alerts.telegramUserId, tgId))).run();

  return { deleted: id };
};
