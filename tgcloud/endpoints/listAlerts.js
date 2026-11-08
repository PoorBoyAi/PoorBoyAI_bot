// Mini App M2: list the caller's price alerts. The tick keeps one-shot
// semantics (fire once, then delete the row); enabled=false pauses one.
import db, { eq, desc } from 'sdk/db';
import { price_alerts } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  let rows = [];
  try {
    rows = await db.select().from(price_alerts)
      .where(eq(price_alerts.telegramUserId, tgId))
      .orderBy(desc(price_alerts.createdAt)).all();
  } catch { /* db errors read as no alerts */ }

  return rows.map((a) => ({
    id: a.id,
    tokenAddress: a.tokenAddress,
    tokenName: a.tokenName,
    targetPrice: a.targetPrice,
    direction: a.direction,
    enabled: a.enabled !== false,
    createdAt: a.createdAt,
  }));
};
