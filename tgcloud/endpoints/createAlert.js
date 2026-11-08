// Mini App M2: create a price alert. Writes the row in exactly the shape the
// tick's cyclePriceAlerts consumes (token_address, target_price as text,
// direction 'above'|'below'). Delivered to the caller's DM: chatId = the
// caller's telegram id (the tick currently sends to telegram_user_id).
// Server-side tier gate enforced.
import { EndpointError } from 'sdk';
import db, { eq } from 'sdk/db';
import { price_alerts } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { enforceGate } from '../lib/tiers.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  const user = await ensureUser(tg);
  const tier = user?.tier ?? 'free';

  const tokenAddress = String(input?.tokenAddress ?? '').trim();
  if (!ADDR_RE.test(tokenAddress)) {
    throw new EndpointError('That token address does not look like a 0x… address (40 hex chars).', { code: 'VALIDATION', field: 'tokenAddress' });
  }
  const targetPrice = Number(input?.targetPrice);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
    throw new EndpointError('Target price must be a number greater than 0.', { code: 'VALIDATION', field: 'targetPrice' });
  }
  const direction = String(input?.direction ?? 'above').toLowerCase().trim();
  if (direction !== 'above' && direction !== 'below') {
    throw new EndpointError('Direction must be "above" or "below".', { code: 'VALIDATION', field: 'direction' });
  }
  const tokenName = String(input?.tokenName ?? '').trim().slice(0, 64) || null;

  let mine = [];
  try {
    mine = await db.select().from(price_alerts)
      .where(eq(price_alerts.telegramUserId, tgId)).all();
  } catch { /* db errors read as no existing alerts */ }
  await enforceGate(tgId, tier, 'priceAlerts', mine.length);

  let inserted = [];
  let insertError = null;
  try {
    inserted = await db.insert(price_alerts).values({
      telegramUserId: tgId,
      chatId: tgId,
      tokenAddress,
      tokenName,
      targetPrice: String(targetPrice),
      direction,
      enabled: true,
    }).returning();
  } catch (err) {
    insertError = err?.message ?? String(err);
    console.error('[createAlert] insert failed:', insertError);
  }
  const row = inserted[0];
  if (!row) {
    throw new EndpointError('PB could not save that alert. Try again.', {
      code: 'DB_ERROR',
      cause: insertError ? String(insertError).slice(0, 200) : 'no row returned',
    });
  }

  return {
    id: row.id,
    tokenAddress: row.tokenAddress,
    tokenName: row.tokenName,
    targetPrice: row.targetPrice,
    direction: row.direction,
    enabled: row.enabled !== false,
  };
};
