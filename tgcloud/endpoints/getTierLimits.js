// Mini App M2 (Plan screen): the caller's tier, the tier-gate limits that
// apply to them, and their current usage — all read from lib/tiers.js, the
// same config the creation endpoints enforce. Limits render Infinity (agency)
// as -1 = unlimited, since JSON cannot carry Infinity.
import db, { eq } from 'sdk/db';
import { user_agents, price_alerts, whale_watch_wallets } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { canonicalTier, serializableLimits, aiCommandAllowance, referralBonus, weekTrialStatus } from '../lib/tiers.js';
import { isOwnerId } from '../lib/groups.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  const user = await ensureUser(tg);
  const tier = user?.tier ?? 'free';
  const isOwner = await isOwnerId(tgId).catch(() => false);

  let agents = [];
  try {
    agents = await db.select().from(user_agents)
      .where(eq(user_agents.telegramUserId, tgId)).all();
  } catch { /* db errors read as none */ }
  let alerts = [];
  try {
    alerts = await db.select().from(price_alerts)
      .where(eq(price_alerts.telegramUserId, tgId)).all();
  } catch { /* db errors read as none */ }
  let watches = [];
  try {
    watches = await db.select().from(whale_watch_wallets)
      .where(eq(whale_watch_wallets.telegramUserId, tgId)).all();
  } catch { /* db errors read as none */ }

  return {
    tier: canonicalTier(tier),
    rawTier: tier,
    isOwner,
    gateBypass: isOwner,
    // TRIALFIX 2026-11-01: week-trial state for the Plan screen (same
    // weekTrialStatus source as /mytier; endsAt ms epoch, null when no trial row
    // (past ms for an ended trial); row never exposed; read failure degrades to inactive).
    weekTrial: await weekTrialStatus(tgId).then((wt) => ({ active: Boolean(wt.active), remaining: Number(wt.remaining) || 0, endsAt: wt.endsAt ? Number(wt.endsAt) : null })).catch(() => ({ active: false, remaining: 0, endsAt: null })),
    limits: serializableLimits(tier),
    usage: {
      priceAlerts: alerts.length,
      agentsRunning: agents.filter((a) => a.status === 'active').length,
      agentsTotal: agents.length,
      whaleWatches: watches.length,
    },
    // Referral bonus term (lib/tiers.js): +3 AI commands/day per referral,
    // +5 welcome bonus when the user was themselves referred.
    referralBonus: await referralBonus(tgId).catch(() => ({ referralsMade: 0, wasReferred: false, bonus: 0 })),
    aiCommands: await aiCommandAllowance(tier, tgId).catch(() => null),
  };
};
