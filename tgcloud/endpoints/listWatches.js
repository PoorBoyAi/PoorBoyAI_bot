// Mini App M2: list the caller's whale wallet watches. The tick's nonce
// poller sends a DM when a watched wallet moves; enabled=false pauses one.
import db, { eq, desc } from 'sdk/db';
import { whale_watch_wallets } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  let rows = [];
  try {
    rows = await db.select().from(whale_watch_wallets)
      .where(eq(whale_watch_wallets.telegramUserId, tgId))
      .orderBy(desc(whale_watch_wallets.createdAt)).all();
  } catch { /* db errors read as no watches */ }

  return rows.map((w) => ({
    id: w.id,
    walletAddress: w.walletAddress,
    label: w.label,
    enabled: w.enabled !== false,
    createdAt: w.createdAt,
  }));
};
