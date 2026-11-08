// Tier gates for the Mini App M2 agent layer (agents / alerts / watches).
//
// The numbers are the spec §6 proposals (PB-MINI-APP-SPEC.md). Tune them HERE
// only — every M2 endpoint reads from this file, so no other file changes when
// Rowdy confirms different numbers.
//
// Enforcement happens server-side in the endpoints; the owner (TELEGRAM_OWNER_ID
// config) bypasses all gates. The tick's own entitlement set (lib/tick.js
// AGENT_TIERS) is separate and unchanged: it decides which agents RUN, this
// file decides which agents users may CREATE.

import { EndpointError } from 'sdk';
import db, { eq, and, sql } from 'sdk/db';
import { referrals, pb_trials, bot_users, mcp_api_keys, product_calendar_bookings } from '../schema.js';
import { getConfig, setConfig } from './config.js';
import { isOwnerId } from './groups.js';

/** Canonical tiers (spec §6 table columns). */
export const CANONICAL_TIERS = ['free', 'starter', 'builder', 'pro', 'agency', 'one', 'trial'];
// PRICING WAVE (2026-10-31): 'one' = the PB Plan ($29/mo, $290/yr — the
// single price for NEW sales; grandfathered starter/builder/pro/agency
// rows keep working untouched). 'trial' = the 7-day free trial (100
// credits, standard renders only). Both rank ABOVE agency so every
// feature gate passes — "everything unlocked" — while metered quantities
// (included credits, airdrop benefits) are set per-table below, never by
// inheriting Agency's numbers. Appended AFTER agency so index-based
// ranks (lib/studio.js podcastGate) keep their existing order.

/**
 * Per-tier resource limits. `Infinity` = unlimited (agency).
 * Resource keys: priceAlerts (rows), agentsRunning (status='active'),
 * whaleWatches (rows), mcpKeys (non-revoked rows), campaigns (member
 * campaign profiles — one per member in the original product, Starter+
 * access), campaignSlots (posting targets — the original SLOT_LIMITS
 * canonical rows: starter 1, grinder/builder 4, chad/pro 8, whale/agency 20;
 * free/hustler 0 because campaign access itself starts at Starter),
 * relayRules (non-deleted PB Relay rules per owner — PB-RELAY-SPEC §6 as
 * settled at build time: Free/Starter 0, Builder 1, Pro 5, Agency
 * unlimited; filters ride Builder+, auto-clean Pro+, branding footer
 * Agency — the feature gates live in lib/relay.js, this key is the count).
 */
export const TIER_LIMITS = {
  free:    { priceAlerts: 1,        agentsRunning: 0,        whaleWatches: 0,        mcpKeys: 0,  campaigns: 0, campaignSlots: 0,  relayRules: 0 },
  starter: { priceAlerts: 5,        agentsRunning: 1,        whaleWatches: 2,        mcpKeys: 2,  campaigns: 1, campaignSlots: 1,  relayRules: 0 },
  builder: { priceAlerts: 15,       agentsRunning: 3,        whaleWatches: 5,        mcpKeys: 5,  campaigns: 1, campaignSlots: 4,  relayRules: 1 },
  pro:     { priceAlerts: 50,       agentsRunning: 10,       whaleWatches: 20,       mcpKeys: 10, campaigns: 1, campaignSlots: 8,  relayRules: 5 },
  agency:  { priceAlerts: Infinity, agentsRunning: Infinity, whaleWatches: Infinity, mcpKeys: Infinity, campaigns: 1, campaignSlots: 20, relayRules: Infinity },
  // PRICING WAVE: operating limits at Pro level — generous and bounded.
  // Unlimited (Agency) limits are NOT inherited: they would invent an
  // Agency-level giveaway for a $29 plan. Rowdy can raise these with one
  // word; the wave does not decide it for him.
  one:     { priceAlerts: 50,       agentsRunning: 10,       whaleWatches: 20,       mcpKeys: 10, campaigns: 1, campaignSlots: 8,  relayRules: 5 },
  trial:   { priceAlerts: 50,       agentsRunning: 10,       whaleWatches: 20,       mcpKeys: 0,  campaigns: 1, campaignSlots: 8,  relayRules: 5 },
};

/**
 * Legacy tier aliases (bot_users.tier predates the 5 canonical tiers;
 * see schema.js comment). Maps a legacy tier to the canonical tier whose
 * limits it gets. Proposals — adjust alongside TIER_LIMITS.
 */
export const TIER_ALIASES = {
  whale: 'agency',
  chad: 'pro',
  grinder: 'builder',
  poor: 'starter',
  hustler: 'free',
  dev_launch: 'agency',
};

/** Normalize any bot_users.tier value to a canonical tier for gating. */
export function canonicalTier(tier) {
  const t = String(tier ?? 'free').toLowerCase().trim();
  if (TIER_LIMITS[t]) return t;
  if (TIER_ALIASES[t]) return TIER_ALIASES[t];
  return 'free'; // unknown tier → safest (free) limits
}

/** Canonical tier ranks — the one ordering every access gate compares on. */
export const CANONICAL_TIER_RANK = { free: 0, starter: 1, builder: 2, pro: 3, agency: 4, one: 5, trial: 6 };

/** Rank of any stored tier value (legacy aliases resolve via canonicalTier). */
export function tierRank(tier) {
  return CANONICAL_TIER_RANK[canonicalTier(tier)] ?? 0;
}

/**
 * True when the stored tier value meets the canonical minimum tier
 * (e.g. tierAtLeast('grinder', 'builder') === true via the builder alias;
 * tierAtLeast('chad', 'pro') === true; tierAtLeast('hustler', 'starter')
 * === false — hustler aliases to free). This is the ONLY comparison gate
 * code should use; legacy name sets (lib/posts.js STARTER/HUSTLER/GRINDER_TIERS)
 * predate the canonical vocabulary and mis-gate canonical tiers.
 */
export function tierAtLeast(tier, minTier) {
  return tierRank(tier) >= (CANONICAL_TIER_RANK[minTier] ?? 0);
}

/** The limits object for a tier value. */
export function tierLimits(tier) {
  return TIER_LIMITS[canonicalTier(tier)];
}

/**
 * Enforce a creation/reactivation gate.
 *
 * @param {string} telegramUserId - caller id
 * @param {string} tier - caller's bot_users.tier
 * @param {'priceAlerts'|'agentsRunning'|'whaleWatches'|'mcpKeys'|'campaigns'|'campaignSlots'|'relayRules'} resource
 * @param {number} current - current usage count for the caller
 * @throws {EndpointError} TIER_LIMIT when at the cap (owner bypasses).
 */
export async function enforceGate(telegramUserId, tier, resource, current) {
  if (await isOwnerId(telegramUserId).catch(() => false)) return;
  const limit = tierLimits(tier)[resource];
  if (current >= limit) {
    const canon = canonicalTier(tier);
    const labels = {
      priceAlerts: 'price alerts',
      agentsRunning: 'running agents',
      whaleWatches: 'whale watches',
      mcpKeys: 'API keys',
      campaigns: 'campaigns',
      campaignSlots: 'campaign slots',
      relayRules: 'relay rules',
    };
    throw new EndpointError(
      `PB here — your ${canon} plan caps ${labels[resource]} at ${limit}. ` +
      `Delete one first or upgrade to add more.`,
      { code: 'TIER_LIMIT', resource, tier: canon, limit, current },
    );
  }
}

/** JSON-safe limits (Infinity → -1 = unlimited) for UI display. */
export function serializableLimits(tier) {
  const l = tierLimits(tier);
  const out = {};
  for (const [k, v] of Object.entries(l)) out[k] = Number.isFinite(v) ? v : -1;
  return out;
}

// ── AI command daily limits + referral bonus ────────────────────────────────
// Port of TIER_LIMITS['ai'] + getReferralBonus from user-manager.ts.
// Source numbers (constants/src/index.ts, never invented): starter 15,
// builder 100, pro/agency/dev-launch -1 (unlimited); legacy aliases resolve
// through canonicalTier so poor → starter and whale/chad → -1, as before.
// FREE-TIER RESHAPE (Rowdy 2026-11-05): Free is raids + moderation only —
// the free AI base is 0, not 15.
// Bonus (source getReferralBonus, 'ai' group): +3 per referral made (permanent)
// + +5 one-time welcome bonus if the user was themselves referred. Free for
// everyone — no tier gate, as the original had it. The ta/scan groups were
// unlimited in the source so the bonus never applied to them; there is no
// v1 consumer of the image-group variant (1/ref + 2 welcome), so only the ai
// group is ported here.
/** Base AI-command daily limit for a tier value (-1 = unlimited). */
export function aiCommandBaseLimit(tier) {
  const canon = canonicalTier(tier);
  const LIMITS = { free: 0, starter: 15, builder: 100, pro: -1, agency: -1, one: -1, trial: -1 };
  return LIMITS[canon] ?? 15;
}

/**
 * Referral bonus term for a Telegram user, read live from the referrals
 * table: { referralsMade, wasReferred, bonus } with
 * bonus = referralsMade * 3 + (wasReferred ? 5 : 0).
 */
export async function referralBonus(telegramUserId) {
  const id = Number(telegramUserId);
  if (!Number.isSafeInteger(id)) return { referralsMade: 0, wasReferred: false, bonus: 0 };
  let made = 0, was = false;
  try {
    const madeRow = await db.all(sql`SELECT COUNT(*) AS c FROM referrals WHERE referrer_telegram_id = ${id}`).catch(() => []);
    made = Number(madeRow[0]?.c ?? 0);
    const wasRow = await db.select().from(referrals)
      .where(eq(referrals.referredTelegramId, id)).get().catch(() => null);
    was = Boolean(wasRow);
  } catch { /* bonus reads as 0 */ }
  return { referralsMade: made, wasReferred: was, bonus: made * 3 + (was ? 5 : 0) };
}

/**
 * Effective AI-command daily allowance: { base, referralBonus, limit }.
 * Unlimited bases stay unlimited (source short-circuited -1 before adding
 * the bonus); capped tiers get base + bonus.
 * REFERRAL RESTORE (Rowdy 2026-11-05): the referral bonus DOES lift a zero
 * base — a free referrer keeps +3/referral and +5 welcome. Free base stays
 * 0; only the earned bonus applies.
 */
export async function aiCommandAllowance(tier, telegramUserId) {
  const base = aiCommandBaseLimit(tier);
  if (base === -1) return { base, referralBonus: 0, limit: -1 };
  const { bonus } = await referralBonus(telegramUserId);
  return { base, referralBonus: bonus, limit: base + bonus };
}

// ── AI daily-cap ENFORCEMENT (audit F1 fix) ────────────────────────────────
// aiCommandAllowance above was display-only: /ask, plain DM/group brain
// replies and Mini App chatSend ran the LLM with no counter at all, while
// brain/catalog/menu/referral copy all promised the caps. Enforcement now
// lives here and the conversational brain paths call consumeAiCommand
// BEFORE any LLM call (handlers/message.js handleBrainReply — the single
// chokepoint both Telegram paths funnel through — and endpoints/chatSend).
//
// Counter home: one config row per user per day, `aicap_daily:<id>:<day>`
// — the exact pattern the ask_pb bridge already uses for its own daily
// counter (lib/websync.js askpb_daily), kept SEPARATE from it: ask_pb
// over-allowance asks are a paid MCP path (credits), these are the
// included conversational commands the copy caps. Day boundary: UTC
// (the askpb counter's boundary — the codebase's daily-counter
// precedent). Only ADMITTED asks on finite tiers are counted: a refused
// ask never increments, so the counter can never run past the cap, and
// unlimited tiers write nothing. The owner is exempt (never counted).
// The enforced limit IS aiCommandAllowance's limit — the same number
// /mytier and getTierLimits display, referral bonus included (+3 per
// recorded referral + 5 welcome, read live from the referrals table by
// referralBonus) — so display and enforcement can never drift apart.

export function aiUsageDayKey(telegramUserId, date = new Date()) {
  return `aicap_daily:${telegramUserId}:${date.toISOString().slice(0, 10)}`;
}

/** Admitted conversational AI commands so far today (UTC) for a user. */
export async function aiUsageToday(telegramUserId) {
  const n = Number(await getConfig(aiUsageDayKey(telegramUserId), '0'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Check-and-count one conversational AI command for (tier, user).
 * Returns { allowed, limit, used, base, referralBonus, unlimited, owner }.
 * When allowed on a finite tier, the ask is counted immediately (before
 * the caller's LLM call — a failed brain call still consumed the ask,
 * the same accounting the ask_pb bridge uses). When not allowed, nothing
 * is written and the caller must reply with aiCapReachedText and make
 * NO LLM call.
 */
export async function consumeAiCommand(tier, telegramUserId) {
  if (await isOwnerId(telegramUserId).catch(() => false)) {
    return { allowed: true, owner: true, unlimited: true, tier: canonicalTier(tier), limit: -1, used: null, base: -1, referralBonus: 0 };
  }
  const allowance = await aiCommandAllowance(tier, telegramUserId);
  if (allowance.limit === -1) {
    return { allowed: true, owner: false, unlimited: true, tier: canonicalTier(tier), limit: -1, used: null, base: allowance.base, referralBonus: 0 };
  }
  const used = await aiUsageToday(telegramUserId);
  if (used >= allowance.limit) {
    return { allowed: false, owner: false, unlimited: false, tier: canonicalTier(tier), limit: allowance.limit, used, base: allowance.base, referralBonus: allowance.referralBonus };
  }
  await setConfig(aiUsageDayKey(telegramUserId), String(used + 1));
  return { allowed: true, owner: false, unlimited: false, tier: canonicalTier(tier), limit: allowance.limit, used: used + 1, base: allowance.base, referralBonus: allowance.referralBonus };
}

/** Honest cap-reached reply (shared by the Telegram + Mini App paths). */
export function aiCapReachedText(cap) {
  const canon = canonicalTier(cap?.tier);
  const label = canon === 'free' ? 'Free' : canon[0].toUpperCase() + canon.slice(1);
  const limit = Number.isFinite(cap?.limit) ? cap.limit : aiCommandBaseLimit(canon);
  const bonus = cap?.referralBonus > 0 ? ` (incl. +${cap.referralBonus} from your referral bonus)` : '';
  // FREE-TIER RESHAPE (Rowdy 2026-11-05): Free is raids + moderation only.
  // A free user at the cap must not be told scans/commands keep working,
  // and the upsell points at the PB Plan / trial, not at legacy tiers.
  const upsell = canon === 'free'
    ? 'The PB Plan ($29/month) unlocks unlimited AI chat — or try it free for 7 days.'
    : canon === 'builder'
      ? 'Pro and Agency are unlimited.'
      : (canon === 'one' || canon === 'trial')
        ? 'Your plan already has unlimited AI chat.'
        : 'Builder jumps to 100/day, and Pro and Agency are unlimited.';
  const lines = [
    `🧠 That's today's AI chat limit — ${limit} commands on the ${label} plan${bonus}. It resets at midnight UTC.`,
    `${upsell} See /upgrade if you want more headroom.`,
  ];
  if (canon === 'free') {
    lines.push('Raids and moderation keep working.');
  } else {
    lines.push('Everything else keeps working — prices, charts, scans and commands are not capped.');
  }
  return lines.join('\n');
}

// ── PB PRICING WAVE (2026-10-31): one price + 7-day free trial ───────────
// Decided figures ONLY: $29/mo, $290/yr (10x = 2 months free), trial
// 100 credits / 7 days. The monthly included allowance lives ONLY
// behind the pb_included_allowance_credits config key (unset = 0, no
// customer-facing promise). TRIALPOLICY 2026-11-01 (#14, verify-first
// SETTLED): the live config value was read 2026-11-01 and WAS 500 —
// raised to 1000 on 2026-11-05 by Rowdy's word (credit-raise wave, rev
// TBD); the live config value IS 1000 as of that date —
// the stale "never decided" wording above is corrected by this comment
// only; no value changes here, and the 500 is still never hard-coded
// (the config key remains the single source).
//
// Trial credits are NOT ledger credits. The shared credit_ledger balance
// is a bare SUM with no expiry and no source bucket — granting trial
// credits there would make them permanent, fungible across every surface,
// and indistinguishable from a bought pack. So trial spend is counted in
// pb_trials.credits_used and checked at each spend site (Studio video,
// podcast, images). Every helper below fails CLOSED (returns inactive /
// false) on any read error, so a DB blip never grants trial access.

/** Decided one-price figures (Rowdy, 2026-10-31). */
export const ONE_PRICE_MONTHLY_USD = 29;
export const ONE_PRICE_ANNUAL_USD = 290;
/** Decided trial shape (Rowdy, 2026-10-31). */
export const TRIAL_DAYS = 7;
export const TRIAL_CREDIT_CAP = 100;
/** Trial airdrop waiver: Custom List only, at most this many wallets. */
export const TRIAL_WAIVER_MAX_WALLETS = 100;

/**
 * Monthly included Studio credits for the PB Plan, from config ONLY.
 * Unset / garbage / negative → 0 (no promise). TRIALPOLICY 2026-11-01
 * (#14, raised 2026-11-05): the live config value is 1000 (verified 2026-11-05); it is
 * still read from the key, never hard-coded here.
 */
export async function includedAllowanceForOne() {
  try {
    const v = Number(await getConfig('pb_included_allowance_credits', '0'));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  } catch { return 0; }
}

/** Raw pb_trials row for a user (null when never trialed). */
export async function getWeekTrialRow(telegramUserId) {
  try {
    return await db.select().from(pb_trials)
      .where(eq(pb_trials.telegramUserId, String(telegramUserId))).get() ?? null;
  } catch { return null; }
}

/**
 * Live trial status for spend gates. Active ONLY when ALL hold: a row
 * exists, state is 'active', now is before endsAt, AND the user's
 * current bot_users.tier is 'trial'. The tier check is what stops
 * stacking: a user who converts to 'one' mid-trial stops drawing trial
 * credits the moment the grant lands (the paid path takes over).
 * Returns { active, remaining, endsAt, row }.
 */
export async function weekTrialStatus(telegramUserId) {
  const id = String(telegramUserId);
  const row = await getWeekTrialRow(id);
  if (!row || row.state !== 'active') return { active: false, remaining: 0, endsAt: 0, row };
  let tier = 'free';
  try {
    const u = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, id)).get();
    tier = canonicalTier(u?.tier ?? 'free');
  } catch { /* no user row → not active */ }
  if (tier !== 'trial') return { active: false, remaining: 0, endsAt: 0, row };
  const endsMs = row.endsAt instanceof Date ? row.endsAt.getTime() : Number(row.endsAt) * 1000;
  if (!Number.isFinite(endsMs) || endsMs <= Date.now()) return { active: false, remaining: 0, endsAt: endsMs || 0, row };
  const used = Number(row.creditsUsed) || 0;
  return { active: true, remaining: Math.max(0, TRIAL_CREDIT_CAP - used), endsAt: endsMs, row };
}

/**
 * Start the one trial for an account. Refuses when: a pb_trials row
 * already exists (active OR ended — no re-trial, ever), or the user
 * holds an ACTIVE paid term (paid tier with no expiry, or expiry in
 * the future). A lapsed paid term (expiry in the past) does NOT block:
 * that term is dead, and starting the trial replaces the stale tier
 * string (web_subscriptions keeps the audit trail).
 * On success: inserts the row, sets bot_users.tier='trial' with a NULL
 * subscription expiry (trial time lives ONLY in pb_trials.endsAt — a
 * dated expiry here would trip the renewal-reminder cycle mid-trial),
 * and syncs mcp_api_keys.plan to 'trial'.
 */
export async function startWeekTrial(telegramUserId) {
  const id = String(telegramUserId);
  const existing = await getWeekTrialRow(id);
  if (existing) return { ok: false, reason: 'already', row: existing };
  let user = null;
  try {
    user = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, id)).get();
  } catch { /* none */ }
  const canon = canonicalTier(user?.tier ?? 'free');
  const paidTiers = ['starter', 'builder', 'pro', 'agency', 'one'];
  if (paidTiers.includes(canon)) {
    const exp = user?.subscriptionExpiresAt;
    const expMs = exp instanceof Date ? exp.getTime() : (exp ? Number(exp) * 1000 : 0);
    if (!expMs || expMs > Date.now()) return { ok: false, reason: 'paid', tier: canon };
  }
  const now = new Date();
  const ends = new Date(now.getTime() + TRIAL_DAYS * 24 * 3600_000);
  await db.insert(pb_trials).values({
    telegramUserId: id, startedAt: now, endsAt: ends,
    creditsUsed: 0, waiverUsed: 0, nudgedDay6: 0, endedNotified: 0, state: 'active',
  }).run();
  await db.insert(bot_users).values({
    telegramUserId: id, tier: 'trial', subscriptionExpiresAt: null,
  }).onConflictDoUpdate({
    target: bot_users.telegramUserId,
    set: { tier: 'trial', subscriptionExpiresAt: null, updatedAt: new Date() },
  }).run().catch(() => {});
  await db.update(mcp_api_keys).set({ plan: 'trial' })
    .where(eq(mcp_api_keys.telegramUserId, id)).run().catch(() => {});
  return { ok: true, endsAt: ends.getTime(), row: await getWeekTrialRow(id) };
}

/**
 * Commit a trial-credit draw. Fail-closed: returns { ok:false } when
 * the trial is not active or the remaining balance cannot cover the
 * full cost — callers must then fall through to included/wallet or
 * refuse; they must NEVER partially draw trial credits.
 * KNOWN RACE (same class as the lifetime studio_trial marker race):
 * two concurrent draws can both pass the check before either update
 * lands, overshooting the cap by at most one job's cost. The normal
 * path (one job at a time) is exact; the reserve-time re-check in each
 * spend site catches the sequential case.
 */
export async function commitWeekTrialDraw(telegramUserId, cost) {
  const id = String(telegramUserId);
  const st = await weekTrialStatus(id);
  if (!st.active || st.remaining < cost) return { ok: false, remaining: st.remaining };
  const next = (Number(st.row.creditsUsed) || 0) + cost;
  await db.update(pb_trials).set({ creditsUsed: next, updatedAt: new Date() })
    .where(eq(pb_trials.telegramUserId, id)).run();
  return { ok: true, remaining: Math.max(0, TRIAL_CREDIT_CAP - next) };
}

/** Restore trial credits (failed/cancelled job refunds). Floored at 0. */
export async function restoreWeekTrialCredits(telegramUserId, amount) {
  const id = String(telegramUserId);
  const row = await getWeekTrialRow(id);
  if (!row) return;
  const next = Math.max(0, (Number(row.creditsUsed) || 0) - (Number(amount) || 0));
  await db.update(pb_trials).set({ creditsUsed: next, updatedAt: new Date() })
    .where(eq(pb_trials.telegramUserId, id)).run().catch(() => {});
}

/**
 * Peek the one-time airdrop waiver WITHOUT consuming it. TRIALPOLICY
 * 2026-11-01 (#11): eligible ONLY while the trial is ACTIVE
 * (weekTrialStatus: row active, endsAt unpassed, bot_users.tier still
 * 'trial'). An unused waiver EXPIRES with the trial — after trial end
 * or mid-trial conversion the peek refuses, so no ex-trial/free user
 * can claim a $0 drop indefinitely. This supersedes the earlier
 * parked-arming rationale (a window restriction was once deliberately
 * omitted so early trial users could still use the waiver while arming
 * was parked); the policy decision now gates on active trial, and the
 * display + creation paths both funnel through this peek via
 * trialWaiverApplies, so both expire together. Already-waived
 * campaigns (waiver_used=1) are unaffected — this peek only gates new
 * claims. One drop, Custom List, ≤100 wallets, customer funds tokens +
 * gas — the fee waiver is PB's $9 + per-wallet fee only.
 */
export async function peekTrialAirdropWaiver(telegramUserId) {
  const st = await weekTrialStatus(telegramUserId).catch(() => ({ active: false, row: null }));
  const row = st.row ?? await getWeekTrialRow(telegramUserId);
  return { eligible: st.active && Number(row?.waiverUsed) === 0, row };
}

/**
 * Atomically claim the one-time airdrop waiver (TRIALFIX 2026-11-01,
 * bugs 12+13). The claim IS the conditional write itself: UPDATE
 * pb_trials SET waiver_used=1 WHERE telegram_user_id=? AND
 * waiver_used=0, with .returning() as the receipt — exactly one row
 * back means THIS caller won the claim, zero rows means the waiver
 * was already used (by a concurrent claim or an earlier one).
 * No peek-then-update: a peek can pass for two concurrent callers,
 * and a post-update re-read cannot tell this caller's claim apart
 * from the winner's. No endsAt/tier check is added here — the gate
 * stays exactly the peek's semantics (a row exists, waiver_used=0),
 * so the waiver-survival question is untouched. Fail-closed: any
 * error returns { applied: false }, never a swallowed success.
 * Callers must check { applied } BEFORE granting the $0 price; a
 * false here means full fee, never a waived campaign row.
 */
export async function consumeTrialAirdropWaiver(telegramUserId) {
  const id = String(telegramUserId);
  try {
    const claimed = await db.update(pb_trials).set({ waiverUsed: 1, updatedAt: new Date() })
      .where(and(eq(pb_trials.telegramUserId, id), eq(pb_trials.waiverUsed, 0)))
      .returning();
    return { applied: Array.isArray(claimed) && claimed.length === 1 };
  } catch { return { applied: false }; }
}

// ── Calendar slots (2026-11-01 calendar wave, shared by booster + airdrop) ──
// Rowdy's model, plain words: customers pick their own time slot on a
// calendar, they see which slots are full, and they pick around a full
// slot. Paid customers come before trial users; a trial is a taste that
// makes them want to buy, never a jump ahead of paid customers.
// A booking is SCHEDULING ONLY — it never arms, funds, or executes a
// send, and a slot that arrives while its product is still gated waits.
// Booster and airdrop bookings live in one table but never mix: every
// count, list, and claim is scoped by product, and a booster slot is
// not an airdrop slot. No priority numbers are shown to users anywhere
// in this section — the calendar surface shows names, dates, and
// open/full only. The paid-first ordering below is for execution
// order WITHIN a booked slot (paid bookings first), not a secret queue.
//
// Slots: 4 per day (08:00, 12:00, 16:00, 20:00 UTC), next 7 days, 2
// bookings per product per slot. Times are UTC on purpose — one clock
// for every user, printed on every label, so no timezone guessing.
// Capacity is a scheduling guardrail, not a promise that a run starts
// exactly at the slot: live sends still wait on their product gates.
export const CALENDAR_SLOT_HOURS_UTC = [8, 12, 16, 20];
export const CALENDAR_DAYS = 7;
export const CALENDAR_CAPACITY_PER_SLOT = 2;
export const CALENDAR_PRODUCTS = ['boost', 'airdrop'];
export const CALENDAR_PRODUCT_LABEL = { boost: 'Booster', airdrop: 'Airdrop' };

const CAL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Human slot label, UTC, no raw epoch in any user surface. */
export function calendarSlotLabel(slotStartMs) {
  const d = new Date(Number(slotStartMs));
  if (!Number.isFinite(d.getTime())) return 'Unknown time';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${CAL_WEEKDAYS[d.getUTCDay()]}, ${CAL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${hh}:${mm} UTC`;
}

/** All slot starts (epoch ms, UTC) from `nowMs` through CALENDAR_DAYS. */
export function calendarSlotStarts(nowMs = Date.now()) {
  const out = [];
  const base = new Date(Number(nowMs));
  base.setUTCMinutes(0, 0, 0);
  for (let day = 0; day < CALENDAR_DAYS; day++) {
    for (const h of CALENDAR_SLOT_HOURS_UTC) {
      const d = new Date(base);
      d.setUTCDate(base.getUTCDate() + day);
      d.setUTCHours(h);
      if (d.getTime() > Number(nowMs)) out.push(d.getTime());
    }
  }
  return out;
}

/** Paid = a paying tier. Trial is a taste, never paid; free is not paid. */
export function calendarIsPaidTier(tier) {
  const t = canonicalTier(tier);
  return ['one', 'agency', 'pro', 'builder', 'starter'].includes(t);
}

/** Execution order inside one booked slot: paid first, then free, then trial. */
export function calendarOrderRank(tier) {
  if (calendarIsPaidTier(tier)) return 0;
  const t = canonicalTier(tier);
  return t === 'trial' ? 2 : 1;
}

/**
 * Pure calendar view from active bookings (no DB, harness-friendly).
 * bookings: [{ product, slotStart }] — counts only, no ids leak out.
 * Returns [{ date: 'Tue, Nov 3', slots: [{ start, label, booked, capacity, full }] }]
 */
export function buildCalendarView(product, bookings, nowMs = Date.now()) {
  const counts = new Map();
  for (const b of bookings ?? []) {
    if (b?.product !== product || b?.status === 'cancelled') continue;
    counts.set(Number(b.slotStart), (counts.get(Number(b.slotStart)) ?? 0) + 1);
  }
  const days = new Map();
  for (const start of calendarSlotStarts(nowMs)) {
    const d = new Date(start);
    const dateKey = d.toISOString().slice(0, 10); // UTC YYYY-MM-DD, callback-safe
    const date = `${CAL_WEEKDAYS[d.getUTCDay()]}, ${CAL_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    if (!days.has(dateKey)) days.set(dateKey, { date, dateKey, slots: [] });
    const booked = counts.get(start) ?? 0;
    days.get(dateKey).slots.push({
      start, label: calendarSlotLabel(start), booked,
      capacity: CALENDAR_CAPACITY_PER_SLOT, full: booked >= CALENDAR_CAPACITY_PER_SLOT,
    });
  }
  return [...days.values()];
}

async function listActiveCalendarBookings(product) {
  return db.select().from(product_calendar_bookings)
    .where(and(
      eq(product_calendar_bookings.product, product),
      eq(product_calendar_bookings.status, 'active'),
    )).all().catch(() => []);
}

/** Public calendar for one product: open/full per slot, counts only. */
export async function listCalendar(product, nowMs = Date.now()) {
  if (!CALENDAR_PRODUCTS.includes(product)) return { error: 'Unknown product.' };
  const bookings = await listActiveCalendarBookings(product);
  return { product, label: CALENDAR_PRODUCT_LABEL[product], days: buildCalendarView(product, bookings, nowMs) };
}

async function getActiveCalendarBooking(product, campaignId) {
  return db.select().from(product_calendar_bookings)
    .where(and(
      eq(product_calendar_bookings.product, product),
      eq(product_calendar_bookings.campaignId, String(campaignId)),
      eq(product_calendar_bookings.status, 'active'),
    )).get().catch(() => null);
}

export async function getCalendarBooking(product, campaignId) {
  return getActiveCalendarBooking(product, campaignId);
}

/**
 * Claim a slot. Re-checked at claim time (the confirm step calls this,
 * never the earlier view): a full slot refuses, a campaign with an
 * active booking for another slot refuses (cancel first, one booking
 * per campaign), and a repeat claim of the same slot returns the
 * existing booking instead of double-booking. Sequential isolate
 * execution makes the count-then-insert one call; there is no
 * concurrent-transaction claim in this runtime, and the confirm step
 * is the re-check — a stale view alone never books.
 * Returns { booking } or { error } — never a partial booking.
 */
export async function bookCalendarSlot({ product, campaignId, telegramUserId, tier, slotStart, nowMs = Date.now() }) {
  if (!CALENDAR_PRODUCTS.includes(product)) return { error: 'Unknown product.' };
  const start = Number(slotStart);
  if (!Number.isFinite(start) || !calendarSlotStarts(nowMs).includes(start)) {
    return { error: 'That time slot is no longer open — pick another slot on the calendar.' };
  }
  const existing = await getActiveCalendarBooking(product, campaignId);
  if (existing) {
    if (Number(existing.slotStart) === start) return { booking: existing, alreadyBooked: true };
    return { error: `This campaign already has a slot booked (${existing.slotLabel ?? 'see your bookings'}) — cancel that slot first, then pick another.` };
  }
  const bookings = await listActiveCalendarBookings(product);
  const booked = bookings.filter((b) => Number(b.slotStart) === start).length;
  if (booked >= CALENDAR_CAPACITY_PER_SLOT) {
    return { error: 'That slot just filled up — pick another open slot.' };
  }
  const row = {
    product, campaignId: String(campaignId), telegramUserId: String(telegramUserId),
    tier: String(tier ?? 'free'), slotStart: start, slotLabel: calendarSlotLabel(start),
    status: 'active', createdAt: new Date(),
  };
  try {
    await db.insert(product_calendar_bookings).values(row).run();
  } catch (e) {
    return { error: 'The slot could not be booked — try again in a moment. Nothing was booked.' };
  }
  const saved = await getActiveCalendarBooking(product, campaignId);
  return saved ? { booking: saved } : { error: 'The slot could not be confirmed — try again. Nothing was booked.' };
}

/** Cancel the caller's own active booking for a campaign. */
export async function cancelCalendarSlot({ product, campaignId, telegramUserId }) {
  const existing = await getActiveCalendarBooking(product, campaignId);
  if (!existing) return { error: 'No slot booked for this campaign.' };
  if (String(existing.telegramUserId) !== String(telegramUserId)) return { error: 'That booking belongs to someone else.' };
  await db.update(product_calendar_bookings)
    .set({ status: 'cancelled', cancelledAt: Date.now() })
    .where(eq(product_calendar_bookings.id, existing.id)).run().catch(() => null);
  return { cancelled: true, slotLabel: existing.slotLabel };
}

/** Own active bookings, for /myboosts / /mydrops style surfaces (ids + labels only). */
export async function listMyCalendarBookings(telegramUserId) {
  return db.select().from(product_calendar_bookings)
    .where(and(
      eq(product_calendar_bookings.telegramUserId, String(telegramUserId)),
      eq(product_calendar_bookings.status, 'active'),
    )).all().catch(() => []);
}
