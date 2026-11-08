// Mini App: the caller's OWN account summary (Dashboard wave item 3).
// Every value is scoped to ctx.initData.user.id — tier/subscription from
// the caller's bot_users + web_subscriptions rows, credits from the
// caller's credit_ledger stream, groups from the caller's own admin
// memberships. No global or other-user numbers ever leave here.
// Discord link status rides the HMAC-signed Worker internal channel
// (lib/websync.js fetchDiscordLinkStatus); the Worker route deploys
// separately, so ANY failure degrades to { linked:false, unavailable:true }
// and never fails this endpoint.
import db, { eq } from 'sdk/db';
import { bot_users, web_subscriptions, credit_ledger } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { canonicalTier, weekTrialStatus } from '../lib/tiers.js';
import { getMyGroupsFor } from '../lib/groups.js';
import { fetchDiscordLinkStatus } from '../lib/websync.js';

const TIER_LABELS = { free: 'Free', starter: 'Starter', builder: 'Builder', pro: 'Pro', agency: 'Agency', one: 'PB Plan', trial: 'Trial' };

function toUnix(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

export default async (input, ctx) => {
  const tg = caller(ctx);
  const user = await ensureUser(tg);
  const tgId = String(tg.id);

  let webSub = null;
  try {
    webSub = await db.select().from(web_subscriptions)
      .where(eq(web_subscriptions.telegramUserId, tgId)).get();
  } catch { /* no web subscription row */ }

  let creditsBalance = 0;
  try {
    const rows = await db.select().from(credit_ledger)
      .where(eq(credit_ledger.userKey, 'telegram:' + tgId)).all();
    creditsBalance = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  } catch { /* no ledger rows yet */ }

  const groups = await getMyGroupsFor(tg.id).catch(() => []);

  let discord;
  try {
    const d = await fetchDiscordLinkStatus(tgId);
    discord = d && !d.unavailable
      ? { linked: Boolean(d.linked), username: d.username ?? null }
      : { linked: false, unavailable: true };
  } catch {
    discord = { linked: false, unavailable: true };
  }

  const rawTier = user?.tier ?? 'free';
  // TRIALFIX 2026-11-01: week-trial state for the Mini App screens.
  // weekTrialStatus (lib/tiers.js) is the same source /mytier renders.
  // endsAt is ms epoch (its native unit), null when no trial row (past ms for an ended trial);
  // the row itself is never exposed. A read failure degrades to
  // inactive, never an endpoint error.
  const wt = await weekTrialStatus(tgId).catch(() => ({ active: false, remaining: 0, endsAt: 0 }));
  return {
    tier: rawTier,
    tierLabel: TIER_LABELS[canonicalTier(rawTier)] ?? 'Free',
    weekTrial: { active: Boolean(wt.active), remaining: Number(wt.remaining) || 0, endsAt: wt.endsAt ? Number(wt.endsAt) : null },
    subscriptionExpiresAt: toUnix(user?.subscriptionExpiresAt) ?? toUnix(webSub?.expiresAt),
    creditsBalance,
    telegram: { id: tg.id, username: user?.username ?? tg.username ?? null },
    discord,
    managedGroupsCount: groups.length,
    groups,
  };
};
