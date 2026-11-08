// Mini App M2: update one of the caller's price alerts.
// Patch: { id, targetPrice?, direction?, tokenName?, enabled? }.
// NOTE: alerts are one-shot — the tick deletes the row when it fires.
// Re-enabling a stale alert fires it on the next cycle if the price
// condition is already true; the app should confirm that before toggling.
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { price_alerts } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);
  if (input == null) input = {};

  const id = Number(input.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new EndpointError('PB needs an alert id to update.', { code: 'VALIDATION', field: 'id' });
  }
  const row = await db.select().from(price_alerts)
    .where(and(eq(price_alerts.id, id), eq(price_alerts.telegramUserId, tgId))).get();
  if (!row) throw new EndpointError('Alert not found (it may already have fired).', { code: 'NOT_FOUND' });

  const patch = {};
  if (input.targetPrice !== undefined) {
    const n = Number(input.targetPrice);
    if (!Number.isFinite(n) || n <= 0) {
      throw new EndpointError('Target price must be a number greater than 0.', { code: 'VALIDATION', field: 'targetPrice' });
    }
    patch.targetPrice = String(n);
  }
  if (input.direction !== undefined) {
    const d = String(input.direction).toLowerCase().trim();
    if (d !== 'above' && d !== 'below') {
      throw new EndpointError('Direction must be "above" or "below".', { code: 'VALIDATION', field: 'direction' });
    }
    patch.direction = d;
  }
  if (input.tokenName !== undefined) {
    patch.tokenName = String(input.tokenName ?? '').trim().slice(0, 64) || null;
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled !== false;
  }
  if (!Object.keys(patch).length) {
    throw new EndpointError('Nothing to update.', { code: 'VALIDATION' });
  }

  await db.update(price_alerts).set(patch)
    .where(and(eq(price_alerts.id, id), eq(price_alerts.telegramUserId, tgId))).run();

  const updated = await db.select().from(price_alerts)
    .where(and(eq(price_alerts.id, id), eq(price_alerts.telegramUserId, tgId))).get();
  return {
    id: updated.id,
    tokenAddress: updated.tokenAddress,
    tokenName: updated.tokenName,
    targetPrice: updated.targetPrice,
    direction: updated.direction,
    enabled: updated.enabled !== false,
  };
};
