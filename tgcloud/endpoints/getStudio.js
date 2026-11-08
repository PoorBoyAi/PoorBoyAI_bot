// Mini App: the caller's OWN Studio summary — parked state, balances
// (purchased wallet + included-term remaining + trial), and their latest
// jobs from PB's mirror. Scoped ONLY to ctx.initData.user.id.
// Flag OFF → { parked: true, ... } so the app renders parked copy.
import { caller, ensureUser } from '../lib/miniapp.js';
import {
  isStudioEnabled, isStudioPremiumEnabled, getStudioEntitlement,
  listOwnStudioJobs, studioJobPublic, fetchWorkerStudioJobs,
} from '../lib/studio.js';
import { getConfig } from '../lib/config.js';
import { weekTrialStatus } from '../lib/tiers.js';
import { signedGet } from '../lib/websync.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const tgId = String(tg.id);
  const enabled = await isStudioEnabled();
  if (!enabled) {
    // TRIALFIX 2026-11-01: week-trial state rides even the parked
    // response (same weekTrialStatus source as /mytier; endsAt ms epoch, null when no trial row; row never exposed). Distinct from
    // balance.trialAvailable, which is the separate lifetime free
    // trial video pool — the two must never be conflated.
    const wtParked = await weekTrialStatus(tgId).catch(() => ({ active: false, remaining: 0, endsAt: 0 }));
    return {
      parked: true,
      enabled: false,
      weekTrial: { active: Boolean(wtParked.active), remaining: Number(wtParked.remaining) || 0, endsAt: wtParked.endsAt ? Number(wtParked.endsAt) : null },
      balance: { wallet: 0, includedRemaining: 0, trialAvailable: false },
      jobs: [],
    };
  }
  const ent = await getStudioEntitlement(tgId);
  let jobs = (await listOwnStudioJobs(tgId, 20)).map(studioJobPublic);
  if (!jobs.length) {
    // Mirror is empty — fall back to the signed Worker jobs route (the
    // queue of record), exactly the getAccount → discord-status pattern.
    // Any failure degrades to an empty list, never an endpoint error.
    try {
      const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
      if (secret) {
        jobs = await fetchWorkerStudioJobs(tgId, (path, query) => signedGet(secret, path, query));
      }
    } catch { jobs = []; }
  }
  return {
    parked: false,
    enabled: true,
    // Batch 4: the premium signal exists ONLY when the premium flag is on,
    // so the flag-off response is byte-identical to the pre-Batch-4 shape.
    ...((await isStudioPremiumEnabled()) ? { premiumEnabled: true } : {}),
    tier: ent.tier,
    // TRIALFIX 2026-11-01: surface the week-trial state the
    // entitlement already computed (lib/studio.js getStudioEntitlement)
    // in the same stripped shape as getAccount/getTierLimits. Row
    // never exposed. Distinct from balance.trialAvailable (lifetime
    // free trial video pool).
    weekTrial: { active: Boolean(ent.weekTrial?.active), remaining: Number(ent.weekTrial?.remaining) || 0, endsAt: ent.weekTrial?.endsAt ? Number(ent.weekTrial.endsAt) : null },
    balance: {
      wallet: ent.wallet,
      includedRemaining: ent.includedRemaining,
      includedAllowance: ent.allowance,
      trialAvailable: ent.trialAvailable,
      ownerUnlimited: ent.ownerUnlimited,
    },
    jobs,
  };
};
