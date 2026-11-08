// Mini App: the caller's PB profile (Home tab header card).
import db, { eq } from 'sdk/db';
import { raid_xp, pbai_holder_wallets } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { getPBRank } from '../lib/xp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const user = await ensureUser(tg);
  let xpRows = [];
  try {
    xpRows = await db.select().from(raid_xp)
      .where(eq(raid_xp.userId, Number(tg.id)));
  } catch { /* no raid history yet */ }
  const xp = xpRows.reduce((s, r) => s + (r.xp ?? 0), 0);
  const streak = xpRows.reduce((m, r) => Math.max(m, r.streak ?? 0), 0);
  let holderRows = [];
  try {
    holderRows = await db.select().from(pbai_holder_wallets)
      .where(eq(pbai_holder_wallets.telegramUserId, String(tg.id)));
  } catch { /* not a linked holder */ }
  const rank = getPBRank(xp);
  return {
    id: String(tg.id),
    firstName: user?.firstName ?? tg.first_name ?? 'friend',
    username: user?.username ?? tg.username ?? null,
    tier: user?.tier ?? 'free',
    xp,
    streak,
    rank: typeof rank === 'string' ? rank : (rank?.name ?? rank?.title ?? null),
    isHolder: holderRows.length > 0,
    holderWallets: holderRows.length,
    memberSince: user?.createdAt ?? null,
  };
};
