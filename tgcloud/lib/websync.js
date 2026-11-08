// PB → Worker bridge client (phase4-design.md §4).
//
// Two narrow HMAC-signed channels, both driven by the tick cycle (see
// lib/tick.js), because the Worker cannot see tgcloud's DB and PB has no
// public inbound:
//
//   pushKeyDirectory() — PB pushes the MCP key directory (hashes only,
//                        never raw keys) to the Worker's
//                        POST /api/internal/keys-sync. Skipped when the
//                        snapshot fingerprint is unchanged.
//   pullOutbox()       — PB pulls the Worker's durable event queue
//                        (GET /api/internal/outbox), applies each item
//                        idempotently, advances the cursor contiguously,
//                        and ACKs what it handled.
//   pushStatsSnapshot() — PB pushes a live-stats snapshot (real DB counts)
//                        to the Worker's POST /api/internal/stats-sync for
//                        the homepage transparency strip. Fingerprint +
//                        1h throttle, like the keys push.
//   runWebSync()       — the tick's entry: secret configured? → pull
//                        first, then push; one channel's failure never
//                        blocks the others.
//
// Signing: HMAC-SHA256(secret, canonicalJSON(body)) sent as
//   x-pb-signature: t=<unix-seconds>,v1=<hex>
// where secret = PB_WEB_SYNC_SECRET (config), mirrored as an encrypted env
// var on the Pages project. NO timeouts on fetch — the runtime has no
// AbortController/setTimeout; every failure is caught and returned as
// { error: <string> }.

import { api, fetch, InputFile } from 'sdk';
import db, { and, desc, eq, isNull, sql } from 'sdk/db';
import {
  mcp_api_keys, web_subscriptions, processed_outbox_events,
  bot_users, credit_ledger, telegram_links, studio_access_grants, held_grants,
  known_groups, raid_xp, pb_conversations, business_connections,
  pbai_holder_wallets, user_wallets, twitter_handles,
  wizard_orders, wizard_order_audit,
  pb_feedback, pb_trials, referrals, x_loop_log,
  p2p_deals, p2p_deal_taps, p2p_reviews,
} from '../schema.js';
import { getConfig, setConfig, getConfigFlag } from './config.js';
import { base64ToBytesNoGlobals } from './image.js';
import { canonicalTier, weekTrialStatus, startWeekTrial, includedAllowanceForOne } from './tiers.js';
import { LLM_MODELS } from './llm.js';
import { processSignalInletByHash } from './groups.js';
import { loadBizSettings } from './business.js';
import { ownerIdSet } from './groups.js';
import { canonicalJSON, hmacHex, sha256Hex } from './mcpkeys.js';
import { generateRepurposeDrafts, publishRepurposeDraft, enqueueXMilestone, resolveXImage, xLoopBudgetState, xQueueList, xLoopDayKey, xVideoPendingRead } from './repurpose.js';
import { mirrorDeadFailureRows, readMirrorDeadSurfaced } from './relay.js';
import { isAirdropChainEnabled, isAirdropChainArmed, isBoostChainEnabled, isBoostChainArmed } from './moneyguard.js';
import { kitAnnounceFromLpEvent } from './opscmds.js'; // Kit-build wave 1: lp_launch/lp_graduated → kit announcement (best-effort, never throws; see applyLpEvent)
import { askBrain } from './brain.js';
import { runStudioSync } from './studio.js';
import { runSignerSync, BR_MASTER_WALLET } from './airdrop.js';
import { runBoostDepgenSync } from './boost.js';
import { pbaiBalancesRaw, erc20BalanceRaw, PBAI_CA } from './accounts.js';
import { dmOptinPromptLine, shouldShowDmOptinPrompt, readDmOptinNotifications } from './broadcastcmds.js';
import { trendingBoard } from './xp.js';
// Podcast Studio (revival, 2026-10-20; folded into lib/studio.js for the
// module cap): importing studio.js registers the podcast terminal hook
// with the Studio sync, so podcast rows pulled here settle/refund on the
// podcast ledger in THIS isolate too.
import { decide, recordDecisionOutcome, recordSystemDecision, setPosture, twinConversation } from './decide.js';

const DEFAULT_BASE = 'https://poorboyai.pages.dev';
const OUTBOX_LIMIT = 50;
// Tick-budget wave (2026-11-06): brain-dependent rows cost ~8-12s each
// through the LLM ladder (measured 25.6s for 3 rows) — an uncapped pull
// of 50 brain rows would take minutes and kill the tick. The cap bounds
// brain rows per pull; the rest apply on later ticks (cursor stays put).
// Non-brain rows (grants, tickets, links, config) are fast and uncapped.
const OUTBOX_BRAIN_PER_TICK = 1;
// PB School wave (2026-11-06): the lockless brain-only drain gets its OWN
// cap. The tick keeps OUTBOX_BRAIN_PER_TICK = 1 (its lock-holding path
// must stay short — rev 572). The drain runs lockless on a 1-min cron, so
// a burst of ask_pb rows drains one per run today (a 4-question burst
// waits ~4 min for its last answer); 3 per run drains the same burst in
// ~2 runs. The wall-clock budget below bounds the drain inside the ~33s
// isolate window: a long deep-analysis row (up to ~25s) still fits alone,
// and a kill mid-row loses nothing (cursor not advanced, replay-safe).
const OUTBOX_BRAIN_PER_DRAIN = 3;
const OUTBOX_BRAIN_DRAIN_BUDGET_MS = 20_000;
const OUTBOX_BRAIN_TYPES = new Set(['ask_pb_request', 'repurpose_request', 'repurpose_publish']);

// ── Outbox-brain drain staleness guard (guard wave 2026-11-06) ─────────────
// §5 R4 of the tick-wallclock plan blocks flipping `outbox_brain_separate`
// ON until a silent drain failure can page: with the flag ON the tick
// breaks at the first brain row, so a dead pb-outbox-brain cron stalls the
// WHOLE outbox behind it (fast rows too — the cursor is contiguous) and
// nothing in the code would notice. The guard is a heartbeat stamp the
// lockless drain writes on every clean completion, plus a consecutive-
// stale-tick counter the tick evaluates on every armed tick. Fail-closed:
// a MISSING stamp reads as stale, never as healthy (a flip with no drain
// running must alarm, not silently stall). Thresholds: the drain runs
// every 1 min and its worst single row costs ~25s, so a stamp older than
// 5 min means ≥5 consecutive drain runs missed or failed — unambiguous
// death, not slowness; the page fires after 3 consecutive stale ticks,
// so a first transient (one platform 500, one slow drain) never pages.
// First page lands ~8 min after the drain dies (5 min to go stale + 3
// ticks to count); the stall is digest-visible from tick 1 via
// `outbox.brainDrainGuard` on every armed tick.
export const OUTBOX_BRAIN_DRAIN_LAST_OK_KEY = 'outbox_brain_drain_last_ok';
export const OUTBOX_BRAIN_DRAIN_STALE_MS = 5 * 60 * 1000;
export const OUTBOX_BRAIN_DRAIN_STALE_TICKS = 3;
const OUTBOX_BRAIN_DRAIN_STALE_COUNT_KEY = 'outbox_brain_stale_ticks';
const OUTBOX_BRAIN_DRAIN_STALE_SINCE_KEY = 'outbox_brain_stale_since';

/**
 * Pure staleness evaluation (no I/O — the harness drives it directly and
 * runWebSync supplies the config reads). Inputs: flagOn (the
 * `outbox_brain_separate` read), stampRaw (the drain's last-ok stamp,
 * epoch ms as stored), staleCount / staleSinceRaw (the persisted
 * consecutive-stale counter + the episode start), nowMs, cursor (the
 * tick's outbox cursor, for the detail string only).
 * Returns { armed, stale, count, page, staleSinceMs, detail }.
 * - flag OFF → disarmed: { stale: false, count: 0, page: false }.
 * - stamp missing / unparseable / ≤0 → STALE (fail-closed).
 * - stamp in the future (clock skew) → fresh, never stale.
 * - page is true only on count >= OUTBOX_BRAIN_DRAIN_STALE_TICKS.
 * - staleSinceMs is the episode start: set on the 0→1 transition,
 *   preserved while stale, null when fresh.
 */
export function evalOutboxBrainDrainStale({ flagOn, stampRaw, staleCount, staleSinceRaw, nowMs, cursor }) {
  const now = Number(nowMs) || 0;
  if (flagOn !== true) {
    return { armed: false, stale: false, count: 0, page: false, staleSinceMs: null, detail: 'flag off — tick owns brain rows' };
  }
  const lastOk = Number(stampRaw);
  const stampMissing = stampRaw == null || String(stampRaw).trim() === '' || !Number.isFinite(lastOk) || lastOk <= 0;
  const ageMs = stampMissing ? null : now - lastOk;
  const stale = stampMissing || (ageMs != null && ageMs > OUTBOX_BRAIN_DRAIN_STALE_MS);
  const prevCount = Number(staleCount) || 0;
  const count = stale ? prevCount + 1 : 0;
  const prevSince = Number(staleSinceRaw);
  const staleSinceMs = !stale ? null : (prevCount > 0 && Number.isFinite(prevSince) && prevSince > 0 ? prevSince : now);
  const page = stale && count >= OUTBOX_BRAIN_DRAIN_STALE_TICKS;
  let detail;
  if (!stale) detail = `drain ok: last success ${Math.max(0, Math.round((ageMs ?? 0) / 1000))}s ago`;
  else if (stampMissing) detail = 'no drain success stamp — drain has never completed a run (or the stamp was lost)';
  else detail = `drain silent ${Math.round(ageMs / 1000)}s (last success ${new Date(lastOk).toISOString()})`;
  if (stale) detail += `, ${count} consecutive stale tick${count === 1 ? '' : 's'}`;
  if (staleSinceMs != null) detail += `, stale since ${new Date(staleSinceMs).toISOString()}`;
  if (cursor) detail += `, cursor ${cursor}`;
  return { armed: true, stale, count, page, staleSinceMs, detail };
}

/** Worker origin, e.g. https://poorboyai.pages.dev (config PB_WEB_BASE_URL). */
export async function getWorkerBase() {
  const v = await getConfig('PB_WEB_BASE_URL', DEFAULT_BASE);
  return String(v || DEFAULT_BASE).replace(/\/+$/, '');
}

/** Bridge signature headers for a request body (or the canonical query object). */
export async function signHeaders(secret, bodyObj) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = await hmacHex(secret, canonicalJSON(bodyObj));
  return {
    'x-pb-signature': `t=${t},v1=${v1}`,
    'content-type': 'application/json',
  };
}

/** Row created_at/expires_at values come back as Dates (Drizzle timestamp
 *  mode), as unix seconds, or as ISO strings — normalize to a Date. */
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(v) {
  const d = toDate(v);
  return d ? d.toISOString() : null;
}

// ── Keys push ────────────────────────────────────────────────────────────────

/**
 * Push the full key directory to the Worker (hashes, prefixes, plans, revocation
 * state — never raw keys). Returns { pushed, usageUpdated }, { skipped:
 * 'unchanged', keys } when the snapshot fingerprint matches the last push,
 * or { error } on failure.
 */
export async function pushKeyDirectory(secret) {
  try {
    const base = await getWorkerBase();
    let rows;
    try {
      rows = await db.select().from(mcp_api_keys).all();
    } catch (err) {
      return { error: 'key directory read failed: ' + (err?.message ?? 'unknown') };
    }

    const snapshot = rows.map((r) => ({
      hash: r.apiKeyHash,
      prefix: r.apiKeyPrefix,
      last4: r.last4,
      telegram_user_id: Number(r.telegramUserId),
      plan: r.plan,
      created_at: iso(r.createdAt),
      revoked_at: r.revokedAt ? iso(r.revokedAt) : null,
    })).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

    const fingerprint = await sha256Hex(canonicalJSON(snapshot));
    const prev = await getConfig('mcp_keys_sync_fingerprint', '');
    if (prev === fingerprint) return { skipped: 'unchanged', keys: snapshot.length };

    const body = { keys: snapshot };
    const headers = await signHeaders(secret, body);
    const res = await fetch(base + '/api/internal/keys-sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('keys-sync HTTP ' + res.status);
    await setConfig('mcp_keys_sync_fingerprint', fingerprint);

    // Last-used feedback from the Worker: fold it into lastUsedAt, but only
    // ever move the watermark forward. Also fold today's per-hash call
    // counts (usage[].daily_calls) into the key rows: the count only ever
    // moves forward within its UTC day (matching the Worker's mcpToday) and
    // resets when the day rolls — the row then carries the new day + count.
    let usageUpdated = 0;
    const data = await res.json().catch(() => null);
    if (Array.isArray(data?.usage)) {
      const byHash = new Map(rows.map((r) => [r.apiKeyHash, r]));
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      for (const u of data.usage) {
        const row = byHash.get(u?.hash ?? u?.api_key_hash);
        if (!row) continue;
        const usedAt = toDate(u?.last_used_at ?? u?.lastUsedAt);
        const dailyCalls = Number(u?.daily_calls ?? u?.dailyCalls);
        const sameDay = row.dailyCallsDay === today;
        const currentDaily = sameDay ? (Number(row.dailyCalls) || 0) : 0;
        const set = {};
        const current = row.lastUsedAt ? toDate(row.lastUsedAt).getTime() : 0;
        if (usedAt && usedAt.getTime() > current) set.lastUsedAt = usedAt;
        if (Number.isFinite(dailyCalls) && (dailyCalls > currentDaily || !sameDay)) {
          set.dailyCalls = dailyCalls;
          set.dailyCallsDay = today;
        }
        if (Object.keys(set).length) {
          try {
            await db.update(mcp_api_keys).set(set)
              .where(eq(mcp_api_keys.id, row.id)).run();
            usageUpdated++;
          } catch { /* one row's staleness never blocks the rest */ }
        }
      }
    }

    return { pushed: snapshot.length, usageUpdated };
  } catch (err) {
    return { error: 'keys-sync failed: ' + (err?.message ?? 'unknown') };
  }
}

// ── Outbox pull ──────────────────────────────────────────────────────────────

/** Field read that tolerates the item's payload nested flat or under .payload. */
function itemField(item, key) {
  const v = item?.[key];
  if (v != null) return v;
  return item?.payload?.[key] ?? null;
}

// ── OPS-35 (W4): owner purchase pages ──────────────────────────────────────
// The original paged the owner on every purchase (owner-notify.ts
// notifyOwnerPurchase — a DM plus a home-group celebration). This build
// restores the owner DM only, to TELEGRAM_OWNER_ID owners only: no
// community broadcast, no member-facing copy. Best-effort per owner — a
// failed page never wedges the outbox cursor. Admin grants, console
// grants and promo redemptions are NOT purchases and never page.
async function pageOwners(text) {
  for (const ownerId of await ownerIdSet().catch(() => [])) {
    try {
      await api.sendMessage({ chat_id: ownerId, text });
    } catch (err) {
      console.error('[websync:owner-page] failed:', err?.code ?? err?.message);
    }
  }
}

function isPurchaseSource(source) {
  const s = String(source ?? '');
  return s === 'claim' || s.endsWith('_subscription') || s.endsWith('_guest_checkout');
}

// ── Purchase announcements (Rowdy 2026-10-27) ────────────────────────
// Every confirmed REAL purchase gets one X post + one Telegram
// home-community message naming the PRODUCT + its card image, never
// the buyer. Text is composed ONLY from WIZBUY_PRODUCTS labels —
// never from grant fields (no id/handle/wallet can leak). Hooks sit
// inside the exact isPurchaseSource branches that fire the owner NEW
// PURCHASE page; the Telegram post fires only when the X enqueue
// returns { queued: true } (first time), which IS the Telegram dedup.
// Grants must never break on announcements: every failure path logs
// and returns, never throws.
const PURCHASE_CARD_BY_TIER = { starter: 'pbx03', builder: 'pbx06', pro: 'pbx09', agency: 'pbx12', one: 'pbx21' };
const PURCHASE_CARD_BY_PACK = { 500: 'pbx13', 2000: 'pbx13', 5000: 'pbx13' };

function purchaseB64ToBytes(b64) {
  // F14 site 3 fix (pbplan-card wave): atob is undefined in-isolate —
  // use the tree's pure-JS decoder (lib/image.js), same shape F14 proved
  // on the real card bytes. No other change: same input, same bytes out.
  return base64ToBytesNoGlobals(b64);
}

function purchaseTermFromExpires(expiresAt) {
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return null;
  const days = (ms - Date.now()) / 86400_000;
  if (days > 200) return 'annual';
  if (days > 60) return 'quarterly';
  return 'monthly';
}

async function announcePurchase({ key, product, label, imageKey }) {
  try {
    if (!key || !product || !label || !imageKey) return;
    const text = `🎉 Someone just grabbed ${label}! Welcome to the PoorBoyAI family. #PoorBoyAI #PBAI`;
    const enq = await enqueueXMilestone('purchase', key, text, imageKey, { budgetExempt: true, product, label });
    if (!enq?.queued) return; // duplicate / held / overlength — Telegram stays silent too
    const homeId = String(await getConfig('TELEGRAM_HOME_CHAT_ID', '').catch(() => '') || '').trim();
    if (!homeId) { console.log('[purchase-announce] no TELEGRAM_HOME_CHAT_ID, Telegram skipped'); return; }
    const img = resolveXImage(imageKey);
    try {
      if (img) {
        await api.sendPhoto({ chat_id: homeId, photo: new InputFile(purchaseB64ToBytes(img.b64), `purchase-${imageKey}.jpg`, { type: img.mediaType }), caption: text.slice(0, 1024) });
      } else {
        await api.sendMessage({ chat_id: homeId, text });
      }
    } catch (err) {
      console.error('[purchase-announce] telegram photo failed:', err?.code ?? err?.message);
      try { await api.sendMessage({ chat_id: homeId, text }); } catch { /* text fallback failed — log only */ }
    }
  } catch (err) {
    console.error('[purchase-announce] failed:', err?.message ?? err);
  }
}

export async function applyTierGrant(item) {
  const tgId = String(itemField(item, 'telegram_user_id') ?? '').trim();
  if (!tgId) throw new Error('tier_grant missing telegram_user_id');
  const tier = String(itemField(item, 'tier') ?? 'free').toLowerCase();
  const expiresAt = toDate(itemField(item, 'expires_at'));
  const source = itemField(item, 'source');
  const ref = itemField(item, 'ref');

  await db.insert(web_subscriptions).values({
    telegramUserId: tgId,
    tier,
    expiresAt,
    source,
    ref,
  }).onConflictDoUpdate({
    target: web_subscriptions.telegramUserId,
    set: { tier, expiresAt, source, ref, updatedAt: new Date() },
  }).run();

  // bot_users stays the tier source every gate reads.
  await db.insert(bot_users).values({
    telegramUserId: tgId,
    tier,
    subscriptionExpiresAt: expiresAt,
  }).onConflictDoUpdate({
    target: bot_users.telegramUserId,
    set: { tier, subscriptionExpiresAt: expiresAt, updatedAt: new Date() },
  }).run();

  // Keep issued key plans in step with the granted tier.
  await db.update(mcp_api_keys).set({ plan: canonicalTier(tier) })
    .where(eq(mcp_api_keys.telegramUserId, tgId)).run();

  // OPS-35: a real purchase pages the owner (admin/console/promo grants
  // don't — isPurchaseSource is the filter).
  if (tier !== 'free' && isPurchaseSource(source)) {
    await pageOwners([
      '💰 NEW PURCHASE',
      '',
      `👤 telegram ${tgId}`,
      `📦 Plan: ${tier}`,
      `💳 Via: ${String(source)}`,
      '',
      '✅ Subscription activated!',
    ].join('\n'));
    // Purchase announcement (never names the buyer): tier card by
    // canonical tier; term from the grant when carried, else from
    // the expiry window (annual >200d, quarterly 60–200d, monthly
    // below — wide margins, no price is ever guessed: quarterly
    // has no WIZBUY SKU, so it announces the tier with no price).
    const ct = canonicalTier(tier);
    const card = PURCHASE_CARD_BY_TIER[ct];
    const termRaw = String(itemField(item, 'term') ?? '').toLowerCase();
    const term = termRaw === 'annual' || termRaw === 'monthly' || termRaw === 'quarterly'
      ? termRaw
      : purchaseTermFromExpires(expiresAt);
    let label = null;
    if (term === 'annual' || term === 'monthly') {
      const sku = WIZBUY_PRODUCTS[`tier:${ct}:${term}`];
      if (sku) label = sku.label;
    } else if (term === 'quarterly') {
      label = `${ct[0].toUpperCase() + ct.slice(1)} quarterly`;
    }
    if (card && label) {
      const expMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
      const key = item?.id != null
        ? `purchase:outbox:${item.id}`
        : `purchase:tier:${tgId}:${ct}:${Number.isFinite(expMs) ? expMs : 'noexp'}`;
      await announcePurchase({ key, product: `tier:${ct}`, label, imageKey: card });
    } else {
      console.log('[purchase-announce] held: unknown tier/term', tier, term);
    }
    // Lifecycle receipt + welcome/restore (flag-gated, best-effort,
    // never wedges the grant): amount exact from the SKU, null for
    // quarterly (no SKU — never guessed); receipt id mirrors the
    // announcement key's source so replays dedupe on the same id.
    const tierSku = (term === 'annual' || term === 'monthly') ? WIZBUY_PRODUCTS[`tier:${ct}:${term}`] : null;
    const tierExpMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
    await lifecycleOnPurchase({
      tgId, source, tier: ct, label,
      amountUsd: tierSku?.amountUsd ?? null, term,
      expiresAt, receiptId: item?.id != null ? `outbox:${item.id}` : `tier:${tgId}:${ct}:${Number.isFinite(tierExpMs) ? tierExpMs : 'noexp'}`,
      txUrl: null,
    }).catch((err) => console.error('[lifecycle:hook] tier failed:', err?.message ?? err));
  }

  // TRIALPOLICY 2026-11-01 (#1/#2, conversion release): any tier grant
  // that moves the user OFF 'trial' ends the trial, so held grants
  // become drawable now — not at day 7. releaseHeldGrants re-checks
  // weekTrialStatus itself, so this is a no-op while the trial is
  // still active (e.g. a grant that keeps tier 'trial') and on
  // replays (held rows are deleted on release).
  const released = await releaseHeldGrants(tgId).catch(() => null);
  if (released && (released.credits > 0 || released.grants > 0)) {
    try {
      await api.sendMessage({
        chat_id: tgId,
        text: `🎁 Your held Studio purchase is now available${released.credits > 0 ? ` — ${released.credits} credits added to your Studio wallet` : ''}${released.grants > 0 ? ` — Studio access unlocked (${released.grants} grant${released.grants === 1 ? '' : 's'})` : ''}.`,
      });
    } catch { /* DM best-effort; the grants themselves already landed */ }
  }
}

// TRIAL GRANT (console, 2026-11-07 — Rowdy's word "Yes, allow trial grants"):
// the console's `trial_grant` outbox event. The ONLY thing this does is
// call startWeekTrial(tgId) — the single trial entry point, which enforces
// the one-trial-ever rule (refuses 'already' when a pb_trials row exists,
// 'paid' when the user holds an active paid term) and, on success, writes
// the pb_trials row + tier 'trial' + MCP plan 'trial' with the day-6 nudge
// / day-7 stop lifecycle. It deliberately does NOT write tier/pb_trials
// itself: routing a trial through applyTierGrant would strand the user at
// tier 'trial' with no trial row, no credits, and no lifecycle.
// Refusals return normally (ack) — a throw would wedge the outbox queue
// behind a grant the operator must simply see refused. Only a missing
// telegram_user_id throws (malformed event, same as applyTierGrant).
// No DM: the operator tells the user.
export async function applyTrialGrant(item) {
  const tgId = String(itemField(item, 'telegram_user_id') ?? '').trim();
  if (!tgId) throw new Error('trial_grant missing telegram_user_id');
  const res = await startWeekTrial(tgId);
  if (res?.ok) {
    console.log('[trial_grant] trial started for telegram', tgId, 'ends', new Date(res.endsAt).toISOString());
  } else {
    console.log('[trial_grant] refused for telegram', tgId, 'reason', res?.reason ?? 'unknown');
  }
  return res;
}

/**
 * TRIALPOLICY 2026-11-01 (#1/#2): release held grants for a user whose
 * trial is no longer active (converted or ended). Gate: weekTrialStatus
 * must be INACTIVE — a still-active trial keeps everything held, so a
 * stray call can never leak held money into the trial. Idempotent per
 * row: a pack whose ledger refId already exists is just un-held (the
 * delete still runs), so a crash between insert and delete cannot pay
 * twice; a row that fails mid-release stays held for the next attempt
 * (never silently dropped). Packs land in the ledger with their
 * ORIGINAL refId, so the grant-time dedupe still holds; studio-access
 * rows upsert with claimedAt = release time, so the access window
 * starts at release and the full term survives the trial. Owner page /
 * announcement / lifecycle receipt fire here (deferred from grant
 * time), best-effort, never wedging the release. Returns what was
 * released ({ credits, grants }) for caller messaging.
 */
export async function releaseHeldGrants(tgId) {
  const id = String(tgId ?? '').trim();
  if (!id) return { credits: 0, grants: 0 };
  let trialActive = true;
  try { trialActive = (await weekTrialStatus(id)).active; } catch { trialActive = true; }
  if (trialActive) return { credits: 0, grants: 0 };
  let rows = [];
  try {
    rows = await db.select().from(held_grants)
      .where(eq(held_grants.telegramUserId, id)).all();
  } catch { return { credits: 0, grants: 0 }; }
  let credits = 0, grants = 0;
  for (const row of rows) {
    try {
      if (row.kind === 'pack_credits') {
        const refId = row.refId ?? null;
        let existing = null;
        if (refId) {
          try {
            existing = await db.select().from(credit_ledger)
              .where(eq(credit_ledger.refId, refId)).get();
          } catch { existing = null; }
        }
        if (!existing) {
          await db.insert(credit_ledger).values({
            userKey: 'telegram:' + id,
            amount: Number(row.credits) || 0,
            kind: 'grant',
            purpose: row.source ?? null,
            refId,
          }).run();
        }
        await db.delete(held_grants).where(eq(held_grants.id, row.id)).run();
        credits += Number(row.credits) || 0;
        const amount = Number(row.credits) || 0;
        if (amount > 0) {
          await pageOwners([
            '💰 NEW PURCHASE',
            '',
            `👤 telegram ${id}`,
            `🎬 Studio credits: +${amount} (held during trial, released now)`,
            '',
            '✅ Credited to their Studio wallet.',
          ].join('\n')).catch(() => {});
          const card = PURCHASE_CARD_BY_PACK[amount];
          const sku = WIZBUY_PRODUCTS[`pack:${amount}`];
          if (card && sku) {
            await announcePurchase({ key: `purchase:${refId ?? `held:${row.id}`}`, product: `pack:${amount}`, label: sku.label, imageKey: card });
          }
          await lifecycleOnPurchase({
            tgId: id, source: row.source ?? 'claim', tier: null, label: sku?.label ?? null,
            amountUsd: sku?.amountUsd ?? null, term: 'one-time', expiresAt: null,
            receiptId: refId ?? `held:${row.id}`, txUrl: null,
          }).catch((err) => console.error('[lifecycle:hook] held pack release failed:', err?.message ?? err));
        }
      } else if (row.kind === 'studio_access') {
        const days = Number(row.accessDays) || 0;
        await db.insert(studio_access_grants).values({
          telegramUserId: id,
          accessDays: days,
          productId: row.productId ?? null,
          claimedAt: new Date(),
        }).onConflictDoUpdate({
          target: studio_access_grants.telegramUserId,
          set: {
            accessDays: days,
            productId: row.productId ?? null,
            claimedAt: new Date(),
          },
        }).run();
        await db.delete(held_grants).where(eq(held_grants.id, row.id)).run();
        grants += 1;
        await pageOwners([
          '💰 NEW PURCHASE',
          '',
          `👤 telegram ${id}`,
          `🎬 Studio access: ${days} days (${row.productId ?? 'studio_access'}) (held during trial, released now)`,
          '',
          '✅ Access unlocked.',
        ].join('\n')).catch(() => {});
        const adSku = WIZBUY_PRODUCTS[String(row.productId ?? '')];
        if (adSku && String(row.productId).startsWith('ad:')) {
          await announcePurchase({ key: `purchase:${row.refId ?? `held:${row.id}`}`, product: String(row.productId), label: adSku.label, imageKey: 'pbx11' });
          await lifecycleOnPurchase({
            tgId: id, source: 'claim', tier: null, label: adSku.label,
            amountUsd: adSku.amountUsd, term: 'access',
            termEndMs: days > 0 ? Date.now() + days * 86400_000 : null,
            expiresAt: null, receiptId: row.refId ?? `held:${row.id}`, txUrl: null,
          }).catch((err) => console.error('[lifecycle:hook] held ad release failed:', err?.message ?? err));
        }
      }
      // Unknown kinds stay held: never silently drop a held grant.
    } catch (err) {
      console.error('[trialpolicy:release] row failed, stays held:', err?.message ?? err);
    }
  }
  return { credits, grants };
}

export async function applyCreditGrant(item) {
  const tgId = String(itemField(item, 'telegram_user_id') ?? '').trim();
  const credits = Number(itemField(item, 'credits'));
  if (!tgId || !Number.isFinite(credits)) throw new Error('credit_grant malformed');
  const refId = 'outbox:' + String(item.id);

  let existing = null;
  try {
    existing = await db.select().from(credit_ledger)
      .where(eq(credit_ledger.refId, refId)).get();
  } catch { existing = null; }
  if (existing) return; // replay-safe: same refId never grants twice

  // TRIALPOLICY 2026-11-01 (#1): a paid pack grant landing while the
  // 7-day trial is active is HELD, not granted — trial + purchased
  // credits must never stack, and the trial-start copy already promises
  // packs wait until the trial ends. Held rows live in held_grants
  // (never in the ledger, so no balance query can see them) and are
  // released by releaseHeldGrants on conversion or trial end. Replay
  // guard: a held row with this refId means this grant is already
  // held — return without a second held row (else release would pay
  // twice). Scope: paid sources only (website/claim packs and tier
  // term credits); promos and unknown sources grant immediately —
  // holding a free grant would contradict its redemption message,
  // and an unknown source must never silently defer money.
  // Owner page / announcement / receipt are deferred to release, so
  // nothing claims "credited to their wallet" while the grant is held.
  const srcEarly = String(itemField(item, 'source') ?? '');
  const holdable = isPurchaseSource(srcEarly) || srcEarly.startsWith('term_grant:');
  if (holdable) {
    let held = null;
    try {
      held = await db.select().from(held_grants)
        .where(eq(held_grants.refId, refId)).get();
    } catch { held = null; }
    if (held) return; // already held — replay, not a second grant
    let trialActive = false;
    try { trialActive = (await weekTrialStatus(tgId)).active; } catch { trialActive = false; }
    if (trialActive) {
      try {
        await db.insert(held_grants).values({
          telegramUserId: tgId, kind: 'pack_credits', credits,
          accessDays: null, productId: null, refId, source: srcEarly,
          claimedAt: new Date(),
        }).run();
        try {
          await api.sendMessage({
            chat_id: tgId,
            text: `⏳ Your ${credits}-credit pack is held until your 7-day trial ends — your trial credits cover renders for now, and the pack lands in your Studio wallet when the trial ends (or when you switch to the PB Plan). Nothing is lost.`,
          });
        } catch { /* DM best-effort; the held row itself already landed */ }
        return { held: true };
      } catch (err) {
        // Fail-open to the immediate grant: money already paid must
        // land even if the held table is missing (migrate not run).
        // A missed hold is a stacking-policy miss; a lost paid grant
        // is lost money. Never wedge the outbox cursor over it.
        console.error('[trialpolicy:hold] held insert failed, granting immediately:', err?.message ?? err);
      }
    }
  }

  await db.insert(credit_ledger).values({
    userKey: 'telegram:' + tgId,
    amount: credits,
    kind: 'grant',
    purpose: itemField(item, 'source'),
    refId,
  }).run();

  // OPS-35: a purchased credit pack pages the owner. Term credits ride
  // the tier grant's own page (source 'term_grant:…') and promos are
  // not purchases — neither pages here.
  const src = String(itemField(item, 'source') ?? '');
  if (credits > 0 && isPurchaseSource(src)) {
    await pageOwners([
      '💰 NEW PURCHASE',
      '',
      `👤 telegram ${tgId}`,
      `🎬 Studio credits: +${credits}`,
      '',
      '✅ Credited to their Studio wallet.',
    ].join('\n'));
    // Purchase announcement (never names the buyer): pack card by
    // credit amount; any other amount passing the filter is HELD
    // rather than mislabeled.
    const card = PURCHASE_CARD_BY_PACK[credits];
    const sku = WIZBUY_PRODUCTS[`pack:${credits}`];
    if (card && sku) {
      await announcePurchase({ key: `purchase:outbox:${item.id}`, product: `pack:${credits}`, label: sku.label, imageKey: card });
    } else {
      console.log('[purchase-announce] held: unknown pack credits', credits);
    }
    // Lifecycle receipt (flag-gated, best-effort): packs get receipt
    // only — no tier welcome applies. Unknown amounts still receipt
    // when the SKU exists; without a SKU the hook skips on no_label.
    await lifecycleOnPurchase({
      tgId, source: src, tier: null, label: sku?.label ?? null,
      amountUsd: sku?.amountUsd ?? null, term: 'one-time', expiresAt: null,
      receiptId: `outbox:${item.id}`, txUrl: null,
    }).catch((err) => console.error('[lifecycle:hook] pack failed:', err?.message ?? err));
  }
}

async function applyTicket(item) {
  const summary = String(itemField(item, 'summary') ?? '');
  const source = itemField(item, 'source') || 'web';
  // Decision layer (DP-10, Batch 3c — ships gated OFF/shadow): Class O
  // advisory ONLY. The ticket ALWAYS reaches the owners; when ticket_route
  // is live, a header line (category · urgency · suggested first step) is
  // prepended — never an auto-reply, never a filter. Shadow/off/failed →
  // today's raw forward, byte-identical.
  let header = '';
  if ((await setPosture('ticket_route')) !== 'off') {
    const tOut = await decide({
      surface: 'tickets', questionSet: 'ticket_route',
      state: { conversation: twinConversation('ticket', 0), summary: summary.slice(0, 1500), source: String(source) },
    });
    if (tOut?.ok && !tOut.shadow) {
      const cat = tOut.answers.category?.value ?? 'other';
      const urg = Math.round(tOut.answers.urgency?.value ?? 0);
      const docs = tOut.answers.docs_answerable?.value ?? 0;
      header = `${urg >= 8 ? '🚨 ' : ''}🏷 ${cat} · urgency ${urg}/10`
        + (docs >= 0.85 ? ' · likely docs-answerable — the help path may resolve it' : '')
        + '\n\n';
      if (tOut.logId) await recordDecisionOutcome(tOut.logId, 'forwarded-with-header');
      // Twin wave 1 (C10): a live routed forward is memory-worthy — link
      // the memory row to the decide log row. Proposed-only, label-only,
      // fail-open; the forwarded-raw branch records no row (no action).
      try {
        await recordSystemDecision({
          scope: 'owner', topicKey: 'ticket-route', title: 'Ticket forwarded with route header',
          decision: 'Twin link: ticket forwarded with decide route header (live ticket_route action)',
          reasoning: null, status: 'proposed', reasonState: 'not_stated',
          decisionLogId: tOut.logId,
        });
      } catch { /* twin link failures never break the forward */ }
    } else if (tOut?.logId) {
      await recordDecisionOutcome(tOut.logId, 'forwarded-raw', {
        outcomeNote: tOut.ok ? 'shadow' : `decide-failed:${tOut.reason}`,
      });
    }
  }
  const text = '🎫 New support ticket (' + source + ')\n\n' + header + summary.slice(0, 1500);
  // Best-effort per owner: a 403 on one owner never blocks the others or
  // wedges the cursor on this item.
  for (const ownerId of await ownerIdSet()) {
    try {
      await api.sendMessage({ chat_id: ownerId, text });
    } catch (err) {
      console.error('[websync:ticket] notify owner failed:', err?.code ?? err?.message);
    }
  }
}

// ── Content repurposing (Forgotten Features §2 — wave rebuild) ─────────────
// The Worker owns the D1 rows and queues work here; the engine lives in
// lib/repurpose.js. Both appliers push their results back to the Worker
// through the same HMAC-signed POST channel as the claim bridge
// (signedPost below). Business failures (insufficient credits, brain
// quota, channel rejects) are reported to the Worker by the engine and
// return normally — the item is acked; transport failures throw so the
// cursor stops and the tick retries next cycle.
async function applyRepurposeRequest(item, secret) {
  const poster = (path, body) => signedPost(secret, path, body);
  return await generateRepurposeDrafts(item, { poster });
}

async function applyRepurposePublish(item, secret) {
  const poster = (path, body) => signedPost(secret, path, body);
  return await publishRepurposeDraft(item, { poster });
}

// ── ask_pb bridge (MCP un-park 2026-10-21, Rowdy's option (b)) ─────────────
// The Worker queues `ask_pb_request` outbox items from MCP ask_pb calls;
// this applier runs the REAL askBrain here (the Worker never talks to an
// LLM) and posts the outcome back through POST /api/internal/ask-pb/answer.
// Charge — the tool contract ("Normal daily commands are included;
// deep_analysis or requests over your daily cap cost 3 shared Studio
// credits"): deep_analysis, or a request past the caller's daily included
// allowance (the canonical /ask quotas: starter 15, builder 100,
// pro/agency unlimited, free 0), reserves ASK_PB_CREDIT_COST on the shared
// credit_ledger — reserve → settle/refund keyed by the outbox item id,
// mirroring lib/repurpose.js, so a replay can never double-charge. Free
// asks write no ledger rows. Failure isolation: business outcomes
// (insufficient credits, brain failure, malformed item) are reported and
// RETURNED — an ask_pb item can never wedge the outbox cursor behind it.
// Only an answer-ingest transport failure throws, so the tick retries;
// replays converge on the Worker's 409 already_final + the ledger refIds.

export const ASK_PB_CREDIT_COST = 3;
// PRICING WAVE: 'one' matches Pro/Agency (unlimited included deep asks);
// 'trial' stays at the free level (15) so the 100-credit trial cap
// cannot be bypassed through unlimited free deep asks.
// FREE-TIER RESHAPE (Rowdy 2026-11-05): free is 0 — the ask_pb included
// allowance is the same canonical /ask quota family as the conversational
// cap, so a free caller is over allowance on the first ask and the
// 3-credit reserve decides (insufficient credits unless they bought a
// pack — a purchase, not a Free inclusion).
const ASK_PB_DAILY_INCLUDED = { free: 0, starter: 15, builder: 100, pro: Infinity, agency: Infinity, one: Infinity, trial: 15 };

function askPbUserKey(tgId) {
  return 'telegram:' + String(tgId);
}

async function askPbLedgerRow(refId) {
  try {
    return await db.select().from(credit_ledger).where(eq(credit_ledger.refId, refId)).get();
  } catch {
    return null;
  }
}

async function askPbBalance(tgId) {
  const row = await db.get(sql`SELECT COALESCE(SUM(amount), 0) AS bal FROM credit_ledger WHERE user_key = ${askPbUserKey(tgId)}`);
  return Number(row?.bal ?? 0) || 0;
}

async function reserveAskPbCredits(tgId, refBase) {
  const refId = refBase + ':reserve';
  if (await askPbLedgerRow(refId)) return { replay: true };
  const balance = await askPbBalance(tgId);
  if (balance < ASK_PB_CREDIT_COST) {
    throw new Error(
      `Insufficient shared Studio credits. This ask requires ${ASK_PB_CREDIT_COST} credits (deep analysis, or past your daily included asks).`
    );
  }
  await db.insert(credit_ledger).values({
    userKey: askPbUserKey(tgId),
    amount: -ASK_PB_CREDIT_COST,
    kind: 'askpb_reserve',
    purpose: 'ask_pb',
    refId,
  }).run();
  return { replay: false };
}

async function settleAskPbCredits(tgId, refBase, success) {
  if (success) {
    const refId = refBase + ':settle';
    if (await askPbLedgerRow(refId)) return;
    if (await askPbLedgerRow(refBase + ':refund')) return; // already refunded
    await db.insert(credit_ledger).values({
      userKey: askPbUserKey(tgId),
      amount: 0,
      kind: 'askpb_settle',
      purpose: 'ask_pb',
      refId,
    }).run();
    return;
  }
  const refundRef = refBase + ':refund';
  if (await askPbLedgerRow(refundRef)) return;
  if (!(await askPbLedgerRow(refBase + ':reserve'))) return; // never charged
  if (await askPbLedgerRow(refBase + ':settle')) return; // already settled
  await db.insert(credit_ledger).values({
    userKey: askPbUserKey(tgId),
    amount: ASK_PB_CREDIT_COST,
    kind: 'askpb_refund',
    purpose: 'ask_pb',
    refId: refundRef,
  }).run();
}

// Daily included-ask counter (one config row per user per UTC day).
// Counts every applied ask_pb request, charged or not.
function askPbDayKey(tgId) {
  return `askpb_daily:${tgId}:${new Date().toISOString().slice(0, 10)}`;
}

async function askPbDailyCount(tgId) {
  const n = Number(await getConfig(askPbDayKey(tgId), '0'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function askPbOverDailyAllowance(tgId) {
  let tier = 'free';
  try {
    const row = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(tgId))).get();
    tier = canonicalTier(row?.tier ?? 'free');
  } catch { /* unknown user → free allowance */ }
  const cap = ASK_PB_DAILY_INCLUDED[tier] ?? ASK_PB_DAILY_INCLUDED.free;
  if (!Number.isFinite(cap)) return false;
  return (await askPbDailyCount(tgId)) >= cap;
}

/**
 * Apply one ask_pb_request outbox item.
 * deps.ask(msg, opts) — defaults to the real askBrain.
 * deps.poster(path, body) — defaults to websync's signedPost.
 * Business outcomes return; only ingest transport failures throw.
 */
export async function applyAskPbRequest(item, secret, deps = {}) {
  const ask = deps.ask || ((msg, opts) => askBrain(msg, opts));
  const poster = deps.poster || ((path, body) => signedPost(secret, path, body));
  const requestId = String(itemField(item, 'request_id') ?? '').trim();
  const tgId = String(itemField(item, 'telegram_user_id') ?? '').trim();
  const message = String(itemField(item, 'message') ?? '').trim().slice(0, 4000);
  const deep = itemField(item, 'deep_analysis') === true || itemField(item, 'deep_analysis') === 1;
  if (!requestId || !tgId || !message) {
    // Nothing addressable to report to — ack it so one malformed item
    // can never wedge the queue behind it.
    return { ok: false, malformed: true };
  }
  const refBase = 'askpb:' + String(item.id);

  const report = async (payload) => {
    const res = await poster('/api/internal/ask-pb/answer', { request_id: requestId, ...payload });
    if (res && res.error) {
      if (res.error === 'already_final' || res.httpStatus === 409) return { converged: true };
      throw new Error('ask-pb answer ingest failed: ' + res.error);
    }
    return res ?? {};
  };

  // Charge decision first, then count this ask against today's allowance.
  // OWNER-UNLIMITED (2026-10-29, Rowdy's call): the owner's own key never
  // pays the 3-credit deep/over-allowance charge — deep or not, charged
  // stays 0, and no reserve/settle rows are written. The daily count
  // below still increments (audit trail, harmless: the owner's agency
  // cap is already unlimited). Non-owner behavior is untouched.
  const askOwner = (await ownerIdSet().catch(() => new Set())).has(String(tgId));
  let charged = 0;
  if (!askOwner && (deep || (await askPbOverDailyAllowance(tgId)))) charged = ASK_PB_CREDIT_COST;
  await setConfig(askPbDayKey(tgId), String((await askPbDailyCount(tgId)) + 1)).catch(() => {});

  if (charged) {
    try {
      await reserveAskPbCredits(tgId, refBase);
    } catch (err) {
      // Insufficient credits is a business outcome: report + ack, no charge.
      await report({
        status: 'failed',
        error: String(err?.message ?? 'Insufficient credits.').slice(0, 500),
        charged: 0,
      });
      return { ok: false, requestId, error: 'insufficient_credits' };
    }
  }

  let answer;
  try {
    answer = await ask(message, {
      tier: 'chat',
      maxOutputTokens: 8192,
      context: deep
        ? 'This question arrived via the PoorBoyAI MCP ask_pb tool as a DEEP ANALYSIS request - give a thorough, structured deep-dive answer.'
        : 'This question arrived via the PoorBoyAI MCP ask_pb tool.',
    });
  } catch (err) {
    // Brain failure: refund and report honestly - never a fabricated answer.
    if (charged) await settleAskPbCredits(tgId, refBase, false).catch(() => {});
    const msg = String(err?.message ?? 'The brain could not answer.').slice(0, 500);
    await report({ status: 'failed', error: msg, charged: 0 });
    return { ok: false, requestId, error: msg };
  }

  if (charged) await settleAskPbCredits(tgId, refBase, true);
  const res = await report({
    status: 'answered',
    answer: String(answer ?? '').slice(0, 24000),
    charged,
  });
  return { ok: true, requestId, charged, ...(res?.converged ? { converged: true } : {}) };
}

// ── Admin action + config_set appliers (Dashboard wave) ────────────────────
// admin_action {action:'holder_sync'}: W4 (OPS-08) — the sync is REAL now
// (syncPbaiHolders below): every known candidate address (the existing
// holder table ∪ registered user wallets ∪ raid XP wallets) gets a fresh
// on-chain balanceOf read and the table is upserted from chain truth. A
// read that fails is never written as zero; if the RPC is wholly
// unreachable the action records applied:false with the reason — the
// ack-without-apply shape this applier shipped with is gone.
// config_set {key, value}: the write allowlist is EMPTY. The getConfig
// call sites in this build are secrets, bridge cursors/fingerprints, and
// internal bookkeeping (tick_lock-adjacent keys, wizard state) — no
// genuinely non-secret operational config key exists that a Worker-driven
// write should touch (feature/group toggles live in group_settings JSON,
// not the config table). Every attempt is recorded in 'config_set:last'
// as applied:false / 'key not allowlisted'.
export const CONFIG_SET_ALLOWLIST = [];

/**
 * Refresh pbai_holder_wallets from Base chain truth (OPS-08; the
 * original's 6-hourly pbai-holder-sync, adapted to the isolate: one
 * bounded pass over the addresses this build actually knows — a full
 * 314-holder chain scan is the original server shape, not this one's).
 * Returns { applied, refreshed, holders, candidates } or
 * { applied:false, reason } when the chain read failed outright.
 */
export async function syncPbaiHolders() {
  const candidates = new Map(); // lowercase address -> telegram id (or null)
  const note = (addr, tgId) => {
    const a = String(addr ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return;
    const prev = candidates.get(a);
    if (prev == null && tgId != null && String(tgId) !== '') candidates.set(a, String(tgId));
    else if (!candidates.has(a)) candidates.set(a, null);
  };
  const existing = await db.select().from(pbai_holder_wallets).all().catch(() => []);
  for (const r of existing) note(r.baseAddress, r.telegramUserId);
  const wallets = await db.select().from(user_wallets).all().catch(() => []);
  for (const r of wallets) note(r.baseAddress, r.telegramUserId);
  const xpRows = await db.select().from(raid_xp).all().catch(() => []);
  for (const r of xpRows) note(r.walletAddress, r.userId);

  // Read order matters: the public Base RPC throttles bursts (a first
  // harness pass landed one batch chunk, then refusals), so the master
  // wallet and telegram-mapped addresses read FIRST, and whatever the
  // batches miss gets a bounded second pass of single reads. A click
  // that lands only part of the table still reports applied:true with
  // honest counts — the next click keeps draining (fresh rows carry a
  // new verifiedAt; stale rows keep theirs).
  const ordered = [...candidates.entries()].sort((a, b) => {
    const rank = ([addr, tgId]) => (addr === BR_MASTER_WALLET.toLowerCase() ? 0 : tgId ? 1 : 2);
    return rank(a) - rank(b);
  });
  const balances = await pbaiBalancesRaw(ordered.map(([addr]) => addr));
  const stillFailed = ordered.filter(([addr]) => balances.get(addr) == null).map(([addr]) => addr);
  for (const addr of stillFailed.slice(0, 30)) {
    const raw = await erc20BalanceRaw(addr, PBAI_CA).catch(() => null);
    if (raw != null) balances.set(addr, raw);
  }

  let refreshed = 0, holders = 0, failed = 0;
  for (const [addr, tgId] of ordered) {
    const raw = balances.get(addr);
    if (raw == null) { failed++; continue; } // failed read ≠ zero balance
    if (raw > 0n) holders++;
    await db.insert(pbai_holder_wallets).values({
      baseAddress: addr,
      telegramUserId: tgId,
      balance: raw.toString(),
      verifiedAt: new Date(),
    }).onConflictDoUpdate({
      target: pbai_holder_wallets.baseAddress,
      set: { telegramUserId: tgId, balance: raw.toString(), verifiedAt: new Date() },
    }).run();
    refreshed++;
  }
  if (refreshed === 0 && candidates.size > 0) {
    return { applied: false, reason: 'base rpc unavailable — no balance read landed', candidates: candidates.size };
  }
  return { applied: true, refreshed, holders, failed, candidates: candidates.size };
}

async function applyAdminAction(item) {
  const action = String(itemField(item, 'action') ?? '').trim();
  let result;
  if (action === 'holder_sync') {
    try {
      result = { action, ...(await syncPbaiHolders()), at: Date.now() };
    } catch (err) {
      result = { action, applied: false, reason: String(err?.message ?? 'holder sync failed').slice(0, 200), at: Date.now() };
    }
  } else {
    result = { action: action || null, applied: false, reason: 'unknown admin action', at: Date.now() };
  }
  await setConfig('admin_action:last', JSON.stringify(result)).catch(() => {});
  return result;
}

async function applyConfigSet(item) {
  const key = String(itemField(item, 'key') ?? '').trim();
  let result;
  if (key && CONFIG_SET_ALLOWLIST.includes(key)) {
    await setConfig(key, String(itemField(item, 'value') ?? ''));
    result = { key, applied: true, at: Date.now() };
  } else {
    result = { key: key || null, applied: false, reason: 'key not allowlisted', at: Date.now() };
  }
  await setConfig('config_set:last', JSON.stringify(result)).catch(() => {});
  return result;
}

// Signal Inlet relay applier (2026-10-25): Worker rows carry the secret
// HASH, never the raw secret, so this resolves by hash. Terminal
// refusals (unknown/rotated secret, disabled, killed, rate-limited,
// malformed, send failure) MUST NOT throw: a throw stops the outbox
// cursor without acking and wedges tier grants + tickets behind the row
// (and pages the money cycle). The deliver path already writes the
// audit row where a group is known, so acking a refusal loses nothing
// but the undeliverable signal. Only a transient settings-read failure
// (UNAVAILABLE) throws, for retry next tick — the same discipline the
// other branches use for infra errors. Deviation from the relay spec's
// "one retry then dead-letter": a retry needs a throw, and a throw
// wedges the money cycle for a tick and pages Rowdy; ack-with-audit is
// the safer shape for a signal row.
async function applySignalInlet(item) {
  const readField = (key) => {
    const v = itemField(item, key);
    if (v != null) return v;
    // Defensive: if the Worker ever ships payload as a JSON string
    // instead of an object, itemField misses and every signal would
    // 404. Parse once rather than orphaning the row.
    if (typeof item?.payload === 'string') {
      try { return JSON.parse(item.payload)?.[key] ?? null; } catch { return null; }
    }
    return null;
  };
  const r = await processSignalInletByHash({
    secretHash: readField('secretHash'),
    text: readField('text'),
    title: readField('title'),
  });
  if (r.ok) return { type: 'signal_inlet', applied: true, chatId: r.chatId ?? null, messageId: r.messageId ?? null, at: Date.now() };
  if (r.code === 'UNAVAILABLE') throw new Error('signal_inlet settings read failed — retry next tick');
  return { type: 'signal_inlet', applied: false, reason: r.code ?? 'refused', at: Date.now() };
}

// LaunchPad outbox events (2026-10-29, webSync block fix — NOT pushed yet).
// The site indexer emits `lp_launch` the first time a factory coin lists
// (site/_worker.js confirmCoin) and `lp_graduated` on graduation; the bot
// had no branch for either, so applyOutboxItem threw, pullOutbox stopped
// at that row without acking, and the cursor wedged behind it — blocking
// every later tier/credit/ticket item on every tick (money cycle error).
// These events are INFORMATIONAL ONLY: they carry no grant, no spend, no
// claim, no user to link. The substantive effects already happen elsewhere
// from chain truth — the lpListings tick cycle (lib/tick.js cycleLpListings
// → lib/market.js runLpListingPass) discovers listed coins from
// /api/lp/coins, registers the buy-watch, and announces with its own
// lp_announced dedupe. Teaching lp_launch to announce here would
// double-announce. So this branch RECORDS the event (config `lp_event:last`,
// same audit shape as admin_action:last / config_set:last) and returns —
// pullOutbox then writes its processed_outbox_events row and ACKs, and the
// cursor advances past the row. A malformed LP notice (missing
// tokenAddress) records applied:false and still advances: the notice is
// not chain truth, and wedging the money queue over it would be worse.
// This is deliberately NOT a generic unknown-type quarantine: any other
// unknown type still throws below, so a future money type can never be
// silently dropped by this branch.
async function applyLpEvent(item) {
  const type = String(item?.type ?? '').trim();
  // Defensive, as in applySignalInlet: if the Worker ever ships payload
  // as a JSON string, itemField misses every field and a good notice
  // would record applied:false. Parse once instead.
  const readField = (key) => {
    const v = itemField(item, key);
    if (v != null) return v;
    if (typeof item?.payload === 'string') {
      try { return JSON.parse(item.payload)?.[key] ?? null; } catch { return null; }
    }
    return null;
  };
  const tokenAddress = String(readField('tokenAddress') ?? '').trim();
  const record = {
    type,
    id: item?.id ?? null,
    chain: readField('chain') ?? null,
    chainId: readField('chainId') ?? null,
    tokenAddress: tokenAddress || null,
    name: readField('name') ?? null,
    symbol: readField('symbol') ?? null,
    creator: readField('creator') ?? null,
    creationTxHash: readField('creationTxHash') ?? null,
    ethWei: readField('ethWei') ?? null,
    recipient: readField('recipient') ?? null,
    applied: Boolean(tokenAddress),
    reason: tokenAddress ? null : 'missing tokenAddress',
    at: Date.now(),
  };
  await setConfig('lp_event:last', JSON.stringify(record)).catch(() => {});
  // Kit-build wave 1: a registered kit coin's launch/graduation announces
  // itself (dedupe-guarded inside). Best-effort and never throwing: the
  // outbox cursor must advance past this row regardless, and the flag
  // guards make a later re-fire a no-op. The recording above stays first.
  try {
    await kitAnnounceFromLpEvent({ type, tokenAddress, chain: record.chain });
  } catch { /* kit announcement never wedges the money queue */ }
  return record;
}

// ── Console review approve (console bot-push wave, 2026-11-06) ─────────────
// Worker route POST /api/console/admin/review-approve emits outbox kind
// 'review_approve' {feedbackId}. Idempotent + never-throwing by design:
// a missing id, an already-decided row, or a replay all return
// applied:false WITHOUT throwing — a throw here wedges the money queue
// behind the row (see applyOutboxItem). The row is read first and the
// update runs only from new/read, so a second apply is a no-op in effect
// (same values) even without relying on the driver's changes count.
// Approve only marks the row eligible for a future public surface —
// NOTHING publishes (no publish path exists anywhere).
async function applyReviewApprove(item) {
  const readField = (key) => {
    const v = itemField(item, key);
    if (v != null) return v;
    if (typeof item?.payload === 'string') {
      try { return JSON.parse(item.payload)?.[key] ?? null; } catch { return null; }
    }
    return null;
  };
  const feedbackId = Number(readField('feedbackId') ?? readField('feedback_id'));
  if (!Number.isFinite(feedbackId) || feedbackId <= 0) return { applied: false, reason: 'missing feedbackId' };
  const id = Math.floor(feedbackId);
  let row = null;
  try {
    row = await db.select().from(pb_feedback).where(eq(pb_feedback.id, id)).get();
  } catch (err) {
    // A missing table (migrate not run) must not wedge the queue either —
    // record it and advance: the approval is lost, the queue is not.
    console.error('[review_approve] read failed:', err?.message ?? err);
    return { applied: false, reason: 'read_failed' };
  }
  if (!row) return { applied: false, reason: 'missing' };
  if (!['new', 'read'].includes(String(row.status ?? ''))) return { applied: false, reason: 'already_decided' };
  try {
    await db.update(pb_feedback).set({ status: 'approved', decidedBy: 'console', decidedAt: new Date() })
      .where(eq(pb_feedback.id, id)).run();
  } catch (err) {
    console.error('[review_approve] update failed:', err?.message ?? err);
    return { applied: false, reason: 'update_failed' };
  }
  return { applied: true, id };
}

// ── NFT moderation review (PB's own moderation provider, 2026-11-06) ──────
// Worker outbox kind 'nft_moderation_review': a drop image the judge
// rejected or could not decide clearly. The applier posts ONE Portal task
// to Digi (muse) on the War Room board — the human look. Never-throwing
// by design (same rule as applyReviewApprove above): a missing field or
// a failed Portal post returns applied:false WITHOUT throwing, because a
// throw wedges the money queue behind the row. The durable record is the
// D1 row (lp_nft_moderation_reviews); the board note is the nudge, and
// losing the nudge loses nothing — the queue still holds the row.
// Body carries classes/counts only: no clerk ids, no wallet addresses,
// no secrets (Portal client rule).
async function applyNftModerationReview(item) {
  const readField = (key) => {
    const v = itemField(item, key);
    if (v != null) return v;
    if (typeof item?.payload === 'string') {
      try { return JSON.parse(item.payload)?.[key] ?? null; } catch { return null; }
    }
    return null;
  };
  const verdict = String(readField('verdict') || 'pending');
  const rule = String(readField('rule') || 'none');
  const kind = String(readField('kind') || 'image');
  const name = String(readField('collectionName') || '');
  const symbol = String(readField('collectionSymbol') || '');
  const url = String(readField('url') || '');
  const detail = String(readField('detail') || '').slice(0, 300);
  if (!url && !name) return { applied: false, reason: 'missing' };
  const label = name ? `${name}${symbol ? ` (${symbol})` : ''}` : 'Unnamed drop';
  const body = `NFT moderation review — ${label}\n${kind}: ${verdict}${rule !== 'none' ? ` (rule ${rule})` : ''}\n${detail}${url ? `\nArt: ${url}` : ''}\nReview queue: lp_nft_moderation_reviews (status pending).`;
  let posted;
  try {
    posted = await portalPost({ to: 'muse', type: 'task', body });
  } catch (err) {
    console.error('[nft_moderation_review] portal post threw:', err?.message ?? err);
    return { applied: false, reason: 'portal_threw' };
  }
  if (!posted || !posted.ok) {
    console.error('[nft_moderation_review] portal post failed:', posted?.error ?? 'unknown');
    return { applied: false, reason: 'portal_failed' };
  }
  return { applied: true, id: posted.id ?? null };
}

// ── P2P marketplace Wave 2 — deal-record layer (2026-11-07) ───────────────
// The bot is the RECORD keeper for P2P deals, never a party to them: it
// holds no fiat, writes nothing on-chain, and moves no funds. The Mini
// App/site reports each lifecycle tap through the existing site→bot sync
// path (Worker outbox kind 'p2p_deal_event', applied below by
// applyP2pDealEvent); this file turns each event into a p2p_deals row
// update + a p2p_deal_taps evidence row. Dispute data feeds Rowdy's
// console through collectP2pDisputes() (wired into collectConsoleOps /
// pushBotStatus — the existing bot→Worker push, no new channel).
// NEVER-THROWING by design (same rule as applyReviewApprove): a bad
// event returns { applied:false, reason } — a throw in applyOutboxItem
// stops pullOutbox and wedges the money queue behind the row. The deal
// row is the only truth for role checks: the event's actorRole string is
// advisory, the stored seller/buyer ids decide. State transitions mirror
// the Wave 1 escrow contract exactly (PbP2PEscrow.sol): NO auto-refund
// after PaidMarked — from paid_marked on, only a seller release or a
// Rowdy arbitration moves the state. No message-content column is ever
// written here: terms + timestamps + taps only.

export const P2P_CHAINS = ['base-sepolia', 'base'];
export const P2P_TOKEN_SYMBOLS = ['USDC', 'PBAI']; // first assets only; new assets need Rowdy's tap
export const P2P_WINDOW_MIN_SEC = 3600; // 1h — contract bound
export const P2P_WINDOW_MAX_SEC = 604800; // 7d — contract bound

// Contract state machine in DB (lowercase-snake) spelling. Terminal
// states (released/refunded/cancelled) have no outgoing edge.
export const P2P_TRANSITIONS = {
  created: ['funded', 'cancelled'],
  funded: ['paid_marked', 'refunded'],
  paid_marked: ['released', 'disputed'],
  disputed: ['released', 'refunded'],
  released: [],
  refunded: [],
  cancelled: [],
};

export function p2pTransitionAllowed(from, to) {
  return (P2P_TRANSITIONS[String(from ?? '')] ?? []).includes(String(to ?? ''));
}

function p2pIsAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

function p2pDecimalOk(v, allowZero) {
  if (typeof v === 'number') return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0);
  if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v.trim())) return false;
  const n = Number(v);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
}

function p2pWindowOk(v) {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n >= P2P_WINDOW_MIN_SEC && n <= P2P_WINDOW_MAX_SEC;
}

// Pure create-payload validation (harness drives this directly).
// Returns an array of error strings; [] = valid. Takes the raw payload
// fields (either naming style: camelCase or snake_case).
export function p2pValidateDealCreate(f) {
  const errs = [];
  const pick = (...keys) => { for (const k of keys) if (f?.[k] != null) return f[k]; return null; };
  if (!pick('idempotencyKey', 'idempotency_key')) errs.push('missing idempotencyKey');
  const chain = String(pick('chain') ?? 'base-sepolia');
  if (!P2P_CHAINS.includes(chain)) errs.push('bad chain');
  const sellerTg = String(pick('sellerTelegramId', 'seller_telegram_id') ?? '').trim();
  const buyerTg = String(pick('buyerTelegramId', 'buyer_telegram_id') ?? '').trim();
  if (!sellerTg) errs.push('missing sellerTelegramId');
  if (!buyerTg) errs.push('missing buyerTelegramId');
  if (sellerTg && buyerTg && sellerTg === buyerTg) errs.push('same party');
  const sellerW = String(pick('sellerWallet', 'seller_wallet') ?? '').trim();
  const buyerW = String(pick('buyerWallet', 'buyer_wallet') ?? '').trim();
  if (!p2pIsAddress(sellerW)) errs.push('bad sellerWallet');
  if (!p2pIsAddress(buyerW)) errs.push('bad buyerWallet');
  if (p2pIsAddress(sellerW) && p2pIsAddress(buyerW) && sellerW.toLowerCase() === buyerW.toLowerCase()) errs.push('same wallet');
  if (!p2pIsAddress(pick('token'))) errs.push('bad token');
  const symbol = String(pick('tokenSymbol', 'token_symbol') ?? '').trim().toUpperCase();
  if (!P2P_TOKEN_SYMBOLS.includes(symbol)) errs.push('bad tokenSymbol');
  if (!p2pDecimalOk(pick('cryptoAmount', 'crypto_amount_text'), false)) errs.push('bad cryptoAmount');
  if (!p2pDecimalOk(pick('fiatAmount', 'fiat_amount_text'), true)) errs.push('bad fiatAmount');
  if (!p2pWindowOk(pick('payWindowSec', 'pay_window_sec'))) errs.push('bad payWindowSec');
  if (!p2pWindowOk(pick('confirmWindowSec', 'confirm_window_sec'))) errs.push('bad confirmWindowSec');
  return errs;
}

// Deal lookup: bot row id first, then the site-minted idempotency key,
// then the on-chain triple — but the triple only when all three parts
// are present (an eq() against NULL never matches, by design).
async function p2pFindDeal(ref) {
  try {
    if (ref.dealId != null && Number.isFinite(Number(ref.dealId))) {
      const row = await db.select().from(p2p_deals).where(eq(p2p_deals.id, Math.floor(Number(ref.dealId)))).get();
      if (row) return row;
    }
    if (ref.dealKey) {
      const row = await db.select().from(p2p_deals).where(eq(p2p_deals.idempotencyKey, String(ref.dealKey))).get();
      if (row) return row;
    }
    if (ref.chain && ref.escrowAddress && ref.chainDealId != null && Number.isFinite(Number(ref.chainDealId))) {
      const row = await db.select().from(p2p_deals).where(and(
        eq(p2p_deals.chain, String(ref.chain)),
        eq(p2p_deals.escrowAddress, String(ref.escrowAddress).toLowerCase()),
        eq(p2p_deals.chainDealId, Math.floor(Number(ref.chainDealId))),
      )).get();
      if (row) return row;
    }
  } catch (err) {
    console.error('[p2p] deal lookup failed:', err?.message ?? err);
    return null;
  }
  return null;
}

async function p2pRecordTap(dealId, actorTelegramId, actorRole, action, txHash) {
  await db.insert(p2p_deal_taps).values({
    dealId,
    actorTelegramId: String(actorTelegramId ?? ''),
    actorRole: String(actorRole ?? ''),
    action: String(action ?? ''),
    txHash: txHash ? String(txHash) : null,
    createdAt: new Date(),
  }).run();
}

// Public trader stats, computed from the bot's own deal rows (single
// source of truth — the site never supplies these numbers, so a forged
// review event cannot inflate them). completed = deals this party took
// part in that ended RELEASED. volume = summed fiatAmountText over those
// deals (decimal strings summed as numbers; a display snapshot, never
// money math). medianTimeToPaySec = median fundedAt→paidMarkedAt seconds
// over deals where this party was the BUYER and both stamps exist; null
// until the party has a timed deal.
export async function p2pTraderStats(telegramId) {
  const tg = String(telegramId ?? '');
  let rows = [];
  try {
    rows = await db.select().from(p2p_deals).all();
  } catch { return { completedCount: 0, volumeText: null, medianTimeToPaySec: null }; }
  const mine = (rows ?? []).filter((r) =>
    String(r?.sellerTelegramId ?? '') === tg || String(r?.buyerTelegramId ?? '') === tg);
  const completed = mine.filter((r) => String(r?.state ?? '') === 'released');
  let volume = 0;
  for (const r of completed) {
    const n = Number(r?.fiatAmountText);
    if (Number.isFinite(n)) volume += n;
  }
  const times = [];
  for (const r of mine) {
    if (String(r?.buyerTelegramId ?? '') !== tg) continue;
    if (String(r?.state ?? '') !== 'released' && String(r?.state ?? '') !== 'disputed') continue;
    const funded = r?.fundedAt ? new Date(r.fundedAt).getTime() : NaN;
    const paid = r?.paidMarkedAt ? new Date(r.paidMarkedAt).getTime() : NaN;
    if (Number.isFinite(funded) && Number.isFinite(paid) && paid >= funded) times.push(Math.floor((paid - funded) / 1000));
  }
  times.sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;
  return {
    completedCount: completed.length,
    volumeText: completed.length ? String(Math.round(volume * 100) / 100) : null,
    medianTimeToPaySec: median,
  };
}

// Action → target state, who may tap it, which timestamp/tx columns it
// fills. resolve_* additionally sets resolvedBy + resolutionNote.
const P2P_ACTION_MAP = {
  fund: { to: 'funded', role: 'seller', at: 'fundedAt', tx: 'fundTxHash' },
  mark_paid: { to: 'paid_marked', role: 'buyer', at: 'paidMarkedAt', tx: 'markPaidTxHash' },
  release: { to: 'released', role: 'seller', at: 'releasedAt', tx: 'releaseTxHash' },
  refund: { to: 'refunded', role: 'seller', at: 'refundedAt', tx: 'refundTxHash' },
  dispute: { to: 'disputed', role: 'buyer', at: 'disputedAt', tx: 'disputeTxHash' },
  resolve_release: { to: 'released', role: 'arbitrator', at: 'resolvedAt', tx: 'resolveTxHash' },
  resolve_refund: { to: 'refunded', role: 'arbitrator', at: 'resolvedAt', tx: 'resolveTxHash' },
  cancel: { to: 'cancelled', role: 'seller', at: 'cancelledAt', tx: null },
};

export async function applyP2pDealEvent(item) {
  // Same JSON-string-payload defence as applyLpEvent: if the Worker ever
  // ships payload as a string, itemField misses every field.
  const readField = (key) => {
    const v = itemField(item, key);
    if (v != null) return v;
    if (typeof item?.payload === 'string') {
      try { return JSON.parse(item.payload)?.[key] ?? null; } catch { return null; }
    }
    return null;
  };
  const action = String(readField('action') ?? '').trim();
  const actorTelegramId = String(readField('actorTelegramId') ?? readField('actor_telegram_id') ?? '').trim();
  const actorRole = String(readField('actorRole') ?? readField('actor_role') ?? '').trim();
  const txHash = readField('txHash') ?? readField('tx_hash') ?? null;
  const nowSec = Math.floor(Date.now() / 1000);
  const nowDate = new Date();

  try {
    // ── create ──────────────────────────────────────────────────────
    if (action === 'create') {
      const errs = p2pValidateDealCreate(item?.payload ?? item ?? {});
      if (errs.length) return { applied: false, reason: 'invalid_create', errors: errs };
      const idempotencyKey = String(readField('idempotencyKey') ?? readField('idempotency_key'));
      const existing = await p2pFindDeal({ dealKey: idempotencyKey });
      if (existing) return { applied: false, reason: 'duplicate' };
      const chain = String(readField('chain') ?? 'base-sepolia');
      const escrowAddress = readField('escrowAddress') ?? readField('escrow_address');
      const chainDealId = readField('chainDealId') ?? readField('chain_deal_id');
      if (chain && escrowAddress && chainDealId != null) {
        const dup = await p2pFindDeal({ chain, escrowAddress, chainDealId });
        if (dup) return { applied: false, reason: 'duplicate_chain_deal' };
      }
      const sellerTg = String(readField('sellerTelegramId') ?? readField('seller_telegram_id'));
      const buyerTg = String(readField('buyerTelegramId') ?? readField('buyer_telegram_id'));
      // .returning() (no .run()) is the shape createRaidSession uses to
      // get the new row back, including its id — the tap + later updates
      // key on it.
      const created = await db.insert(p2p_deals).values({
        idempotencyKey,
        chain,
        escrowAddress: escrowAddress ? String(escrowAddress).toLowerCase() : null,
        chainDealId: chainDealId != null ? Math.floor(Number(chainDealId)) : null,
        adId: readField('adId') ?? readField('ad_id') ?? null,
        sellerTelegramId: sellerTg,
        buyerTelegramId: buyerTg,
        sellerWallet: String(readField('sellerWallet') ?? readField('seller_wallet')).toLowerCase(),
        buyerWallet: String(readField('buyerWallet') ?? readField('buyer_wallet')).toLowerCase(),
        token: String(readField('token')).toLowerCase(),
        tokenSymbol: String(readField('tokenSymbol') ?? readField('token_symbol')).toUpperCase(),
        cryptoAmountText: String(readField('cryptoAmount') ?? readField('crypto_amount_text')),
        fiatAmountText: String(readField('fiatAmount') ?? readField('fiat_amount_text')),
        fiatCurrency: String(readField('fiatCurrency') ?? readField('fiat_currency') ?? 'USD'),
        paymentLabel: readField('paymentLabel') ?? readField('payment_label') ?? null,
        payWindowSec: Math.floor(Number(readField('payWindowSec') ?? readField('pay_window_sec'))),
        confirmWindowSec: Math.floor(Number(readField('confirmWindowSec') ?? readField('confirm_window_sec'))),
        payDeadline: null,
        confirmDeadline: null,
        state: 'created',
        createTxHash: txHash ? String(txHash) : null,
        createdAt: nowDate,
        updatedAt: nowDate,
      }).returning();
      const row = Array.isArray(created) ? created[0] : null;
      if (!row) return { applied: false, reason: 'create_readback_failed' };
      await p2pRecordTap(row.id, actorTelegramId || buyerTg, 'buyer', 'create', txHash);
      return { applied: true, id: row.id, state: 'created' };
    }

    // ── review ──────────────────────────────────────────────────────
    if (action === 'review') {
      const deal = await p2pFindDeal({
        dealId: readField('dealId') ?? readField('deal_id'),
        dealKey: readField('dealKey') ?? readField('deal_key') ?? readField('idempotencyKey') ?? readField('idempotency_key'),
        chain: readField('chain'),
        escrowAddress: readField('escrowAddress') ?? readField('escrow_address'),
        chainDealId: readField('chainDealId') ?? readField('chain_deal_id'),
      });
      if (!deal) return { applied: false, reason: 'missing_deal' };
      if (!['released', 'refunded'].includes(String(deal.state ?? ''))) return { applied: false, reason: 'deal_not_terminal' };
      if (!actorTelegramId) return { applied: false, reason: 'missing_actor' };
      const isSeller = String(deal.sellerTelegramId ?? '') === actorTelegramId;
      const isBuyer = String(deal.buyerTelegramId ?? '') === actorTelegramId;
      if (!isSeller && !isBuyer) return { applied: false, reason: 'not_a_party' };
      const stars = Math.floor(Number(readField('stars')));
      if (!Number.isFinite(stars) || stars < 1 || stars > 5) return { applied: false, reason: 'bad_stars' };
      let prior = null;
      try {
        prior = await db.select().from(p2p_reviews).where(and(
          eq(p2p_reviews.dealId, deal.id),
          eq(p2p_reviews.reviewerTelegramId, actorTelegramId),
        )).get();
      } catch { prior = null; }
      if (prior) return { applied: false, reason: 'duplicate_review' };
      const stats = await p2pTraderStats(actorTelegramId);
      await db.insert(p2p_reviews).values({
        dealId: deal.id,
        reviewerTelegramId: actorTelegramId,
        counterpartyTelegramId: isSeller ? String(deal.buyerTelegramId ?? '') : String(deal.sellerTelegramId ?? ''),
        stars,
        completedCount: stats.completedCount,
        volumeText: stats.volumeText,
        medianTimeToPaySec: stats.medianTimeToPaySec,
        createdAt: nowDate,
      }).run();
      await p2pRecordTap(deal.id, actorTelegramId, isSeller ? 'seller' : 'buyer', 'review', null);
      return { applied: true, id: deal.id, state: String(deal.state ?? '') };
    }

    // ── lifecycle transitions ───────────────────────────────────────
    const spec = P2P_ACTION_MAP[action];
    if (!spec) return { applied: false, reason: 'unknown_action', action: action || null };
    const deal = await p2pFindDeal({
      dealId: readField('dealId') ?? readField('deal_id'),
      dealKey: readField('dealKey') ?? readField('deal_key') ?? readField('idempotencyKey') ?? readField('idempotency_key'),
      chain: readField('chain'),
      escrowAddress: readField('escrowAddress') ?? readField('escrow_address'),
      chainDealId: readField('chainDealId') ?? readField('chain_deal_id'),
    });
    if (!deal) return { applied: false, reason: 'missing_deal' };
    if (!actorTelegramId) return { applied: false, reason: 'missing_actor' };
    // Role is enforced against the DEAL row, not the event's role string.
    if (spec.role === 'seller' && String(deal.sellerTelegramId ?? '') !== actorTelegramId) return { applied: false, reason: 'wrong_role' };
    if (spec.role === 'buyer' && String(deal.buyerTelegramId ?? '') !== actorTelegramId) return { applied: false, reason: 'wrong_role' };
    if (spec.role === 'arbitrator') {
      let owners = null;
      try { owners = await ownerIdSet(); } catch { owners = null; }
      if (!owners || !owners.has(actorTelegramId)) return { applied: false, reason: 'not_arbitrator' };
    }
    const from = String(deal.state ?? '');
    // Replay / double-apply: already in the target state. Repair a
    // missing tap row (e.g. a tap write failed on the first apply) and
    // report already_applied — the outbox row still advances.
    if (from === spec.to) {
      try {
        const priorTap = await db.select().from(p2p_deal_taps).where(and(
          eq(p2p_deal_taps.dealId, deal.id),
          eq(p2p_deal_taps.action, action),
        )).get();
        if (!priorTap) await p2pRecordTap(deal.id, actorTelegramId, spec.role, action, txHash);
      } catch { /* repair is best-effort; the state is already correct */ }
      return { applied: false, reason: 'already_applied', id: deal.id, state: from };
    }
    if (!p2pTransitionAllowed(from, spec.to)) return { applied: false, reason: 'illegal_transition', from, to: spec.to };
    const patch = { state: spec.to, updatedAt: nowDate, [spec.at]: nowDate };
    if (spec.tx) patch[spec.tx] = txHash ? String(txHash) : null;
    // Deadlines come from the event (chain truth) when present; the bot
    // clock only fills them in when the site did not send them.
    if (action === 'fund') {
      const payDl = readField('payDeadline') ?? readField('pay_deadline');
      const confDl = readField('confirmDeadline') ?? readField('confirm_deadline');
      patch.payDeadline = Number.isFinite(Number(payDl)) && Number(payDl) > 0
        ? Math.floor(Number(payDl)) : nowSec + Number(deal.payWindowSec ?? P2P_WINDOW_MIN_SEC);
      if (Number.isFinite(Number(confDl)) && Number(confDl) > 0) patch.confirmDeadline = Math.floor(Number(confDl));
    }
    if (action === 'mark_paid') {
      const confDl = readField('confirmDeadline') ?? readField('confirm_deadline');
      patch.confirmDeadline = Number.isFinite(Number(confDl)) && Number(confDl) > 0
        ? Math.floor(Number(confDl)) : nowSec + Number(deal.confirmWindowSec ?? P2P_WINDOW_MIN_SEC);
    }
    if (action === 'resolve_release' || action === 'resolve_refund') {
      patch.resolvedBy = actorTelegramId;
      const note = readField('resolutionNote') ?? readField('resolution_note');
      patch.resolutionNote = note ? String(note).slice(0, 500) : null;
    }
    await db.update(p2p_deals).set(patch).where(eq(p2p_deals.id, deal.id)).run();
    await p2pRecordTap(deal.id, actorTelegramId, spec.role, action, txHash);
    return { applied: true, id: deal.id, state: spec.to, from };
  } catch (err) {
    // A missing table (migrate not run) or any DB failure must not wedge
    // the queue: record it and advance. Tables land before this code by
    // the push order (schema rev 607 + migrate, then this code), so a
    // live db_error here means a real fault, not a missing table.
    console.error('[p2p] apply failed:', err?.message ?? err);
    return { applied: false, reason: 'db_error' };
  }
}

// ── Dispute console data path ─────────────────────────────────────────────
// Owner-only read surface for Rowdy's dispute console (Child C): open
// disputes with terms + timestamps + tap counts — never message content.
// Fed to the Worker through collectP2pDisputes() in collectConsoleOps /
// pushBotStatus (the existing bot→Worker push). Fail-open: a missing
// table or read fault returns an empty shape, never a throw.
export async function listP2pOpenDisputes(limit = 20) {
  try {
    const rows = await db.select().from(p2p_deals)
      .where(eq(p2p_deals.state, 'disputed'))
      .orderBy(desc(p2p_deals.disputedAt)).limit(Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)))).all();
    return (rows ?? []).map((r) => ({
      id: Number(r.id),
      dealKey: String(r.idempotencyKey ?? ''),
      chain: String(r.chain ?? ''),
      escrowAddress: r.escrowAddress ? String(r.escrowAddress) : null,
      chainDealId: r.chainDealId == null ? null : Number(r.chainDealId),
      sellerTelegramId: String(r.sellerTelegramId ?? ''),
      buyerTelegramId: String(r.buyerTelegramId ?? ''),
      sellerWallet: String(r.sellerWallet ?? ''),
      buyerWallet: String(r.buyerWallet ?? ''),
      tokenSymbol: String(r.tokenSymbol ?? ''),
      cryptoAmountText: String(r.cryptoAmountText ?? ''),
      fiatAmountText: String(r.fiatAmountText ?? ''),
      fiatCurrency: String(r.fiatCurrency ?? ''),
      paymentLabel: r.paymentLabel ? String(r.paymentLabel) : null,
      disputedAt: iso(r.disputedAt),
      payDeadline: r.payDeadline == null ? null : Number(r.payDeadline),
      confirmDeadline: r.confirmDeadline == null ? null : Number(r.confirmDeadline),
      fundedAt: iso(r.fundedAt),
      paidMarkedAt: iso(r.paidMarkedAt),
    }));
  } catch {
    return [];
  }
}

async function collectP2pDisputes() {
  try {
    const rows = await db.select().from(p2p_deals).all();
    const list = rows ?? [];
    const counts = {};
    for (const r of list) {
      const s = String(r?.state ?? 'unknown');
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return { open: counts.disputed ?? 0, counts, disputed: await listP2pOpenDisputes(20) };
  } catch {
    return { open: 0, counts: {}, disputed: [] };
  }
}

async function applyOutboxItem(item, secret) {
  const type = String(item?.type ?? '').trim();
  if (type === 'tier_grant') return await applyTierGrant(item);
  if (type === 'trial_grant') return await applyTrialGrant(item);
  if (type === 'credit_grant') return await applyCreditGrant(item);
  if (type === 'ticket') return await applyTicket(item);
  if (type === 'telegram_link') return await applyTelegramLink(item);
  if (type === 'repurpose_request') return await applyRepurposeRequest(item, secret);
  if (type === 'repurpose_publish') return await applyRepurposePublish(item, secret);
  if (type === 'ask_pb_request') return await applyAskPbRequest(item, secret);
  if (type === 'admin_action') return await applyAdminAction(item);
  if (type === 'config_set') return await applyConfigSet(item);
  if (type === 'signal_inlet') return await applySignalInlet(item);
  if (type === 'lp_launch' || type === 'lp_graduated') return await applyLpEvent(item);
  if (type === 'review_approve') return await applyReviewApprove(item);
  if (type === 'nft_moderation_review') return await applyNftModerationReview(item);
  if (type === 'p2p_deal_event') return await applyP2pDealEvent(item);
  throw new Error('unknown outbox type: ' + type); // do not ack — stop
}

export { applyOutboxItem };

// ── Telegram ↔ console link (Stage D) ───────────────────────────────────────
// The Worker emits a `telegram_link` outbox event once /link verifies a code
// server-side. Applying it records the pairing locally and DM-confirms the
// user. Like every outbox applier this is replay-safe: same telegram id
// upserts the same row, and the DM is idempotent in practice (the processed
// set guarantees apply runs once per event id).
async function applyTelegramLink(item) {
  const tgId = String(itemField(item, 'telegram_user_id') ?? '').trim();
  const clerkUserId = String(
    itemField(item, 'clerk_user_id') ?? itemField(item, 'clerkUserId') ?? '',
  ).trim();
  if (!tgId) throw new Error('telegram_link missing telegram_user_id');
  await db.insert(telegram_links).values({
    telegramUserId: tgId,
    clerkUserId: clerkUserId || null,
    linkedAt: new Date(),
  }).onConflictDoUpdate({
    target: telegram_links.telegramUserId,
    set: { clerkUserId: clerkUserId || null, linkedAt: new Date() },
  }).run();
  // Confirmation DM — best effort: a failure here must not wedge the cursor.
  try {
    await api.sendMessage({
      chat_id: tgId,
      text: '🔗 Your Telegram is now linked to the PoorBoyAI console — your tier and purchases stay in sync.',
    });
  } catch (err) {
    console.error('[websync:telegram_link] confirm DM failed:', err?.code ?? err?.message);
  }
}

/**
 * Pull and apply the Worker outbox. Items are processed sequentially in the
 * order delivered; the cursor advances contiguously and stops at the first
 * failure. Already-processed ids are ack-eligible and advance the cursor
 * (the local processed set makes replays harmless). The ack POST's failure
 * is logged, never thrown.
 */
export async function pullOutbox(secret, deps = {}) {
  // Tick-budget wave: optional fetch seam (harness only; production
  // passes no deps and uses the live fetch, behavior unchanged).
  const doFetch = deps.fetch ?? fetch;
  // PB School wave: wall-clock seam for the brain-only drain budget
  // (harness passes deps.now; production uses Date.now — same shape
  // as tick.js opts.now).
  const nowFn = deps.now ?? Date.now;
  const pullStartMs = nowFn();
  // Tick-wallclock wave: brainOnly (lockless drain) + skipBrain (the
  // tick skips brain rows when the separate drain owns them). Both
  // BREAK the loop instead of skipping a row: the cursor is
  // contiguous, so advancing past an unapplied row would DROP it. A
  // break leaves the cursor at the last applied row and the row
  // applies on a later pull — defer, never drop.
  const brainOnly = deps.brainOnly === true;
  const skipBrain = deps.skipBrain === true;
  try {
    const base = await getWorkerBase();
    let cursor = String(await getConfig('web_outbox_cursor', '0') ?? '0');
    if (!cursor) cursor = '0';
    // The Worker signs over canonicalJSON({since: <number>, limit: <number>}).
    // Keep the wire value numeric here too — a text id in `since` would parse
    // to NaN server-side and collapse to 0 on every pull.
    const sinceNum = Number(cursor);
    const sinceWire = String(Number.isFinite(sinceNum) && sinceNum >= 0 ? Math.floor(sinceNum) : 0);

    const query = { since: Number(sinceWire), limit: OUTBOX_LIMIT };
    const headers = await signHeaders(secret, query);
    const res = await doFetch(
      `${base}/api/internal/outbox?since=${encodeURIComponent(sinceWire)}&limit=${OUTBOX_LIMIT}`,
      { method: 'GET', headers },
    );
    if (!res.ok) throw new Error('outbox HTTP ' + res.status);
    const data = await res.json().catch(() => null);
    const items = Array.isArray(data) ? data : (data?.items ?? data?.events ?? []);

    const ackIds = [];
    let applied = 0, already = 0, failure = null;
    let brainApplied = 0;
    let stoppedAtNonBrain = false, brainSkipped = false;
    let advanced = sinceWire; // contiguous rowid advance; stops at first failure
    for (const item of items) {
      const id = String(item?.id ?? '');
      if (!id) { failure = new Error('outbox item missing id'); break; }
      const rowid = item?.rowid ?? item?._rowid;
      try {
        let seen = null;
        try {
          seen = await db.select().from(processed_outbox_events)
            .where(eq(processed_outbox_events.id, id)).get();
        } catch { seen = null; }
        if (seen) {
          already++;
        } else {
          // Tick-budget cap: stop (not fail) when the brain budget is
          // spent. The cursor stays at the last applied row, so the
          // remaining rows apply on later ticks — nothing is dropped.
          const itemType = String(item?.type ?? '').trim();
          const isBrain = OUTBOX_BRAIN_TYPES.has(itemType);
          // Tick-wallclock wave: a brain-only drain stops at the first
          // non-brain row (the tick owns the fast rows — it applies
          // them on its next pass, after which this drain proceeds);
          // a tick with the separate-drain flag ON stops at the first
          // brain row (the lockless cron owns it). Both are breaks,
          // never skips — see the cursor note above.
          if (brainOnly && !isBrain) { stoppedAtNonBrain = true; break; }
          if (skipBrain && isBrain) { brainSkipped = true; break; }
          // PB School wave: the lockless drain applies up to
          // OUTBOX_BRAIN_PER_DRAIN brain rows per run (the tick still
          // stops at OUTBOX_BRAIN_PER_TICK = 1), and stops starting
          // new brain rows once the pull has spent its wall-clock
          // budget — break, never skip, so the cursor stays at the
          // last applied row and the rest apply on later pulls.
          const brainCap = brainOnly ? OUTBOX_BRAIN_PER_DRAIN : OUTBOX_BRAIN_PER_TICK;
          if (isBrain && brainApplied >= brainCap) break;
          if (brainOnly && isBrain && brainApplied > 0 && (nowFn() - pullStartMs) > OUTBOX_BRAIN_DRAIN_BUDGET_MS) break;
          await applyOutboxItem(item, secret);
          if (isBrain) brainApplied++;
          await db.insert(processed_outbox_events).values({
            id,
            type: item?.type ?? null,
            appliedAt: new Date(),
          }).run();
          applied++;
        }
        ackIds.push(id);
        // The Worker's cursor is the D1 rowid, not the item's text id —
        // advancing on a text id would parse to NaN server-side and collapse
        // the cursor to 0 on every subsequent pull.
        if (rowid !== undefined && rowid !== null) advanced = String(rowid);
      } catch (err) {
        failure = err;
        break;
      }
    }

    if (advanced !== cursor) {
      cursor = advanced;
      await setConfig('web_outbox_cursor', cursor).catch(() => {});
    }

    let acked = 0;
    if (ackIds.length) {
      try {
        const ackBody = { ids: ackIds };
        const ackHeaders = await signHeaders(secret, ackBody);
        const ackRes = await doFetch(base + '/api/internal/outbox/ack', {
          method: 'POST',
          headers: ackHeaders,
          body: JSON.stringify(ackBody),
        });
        if (ackRes.ok) acked = ackIds.length;
        else console.error('[websync] outbox ack failed: HTTP', ackRes.status);
      } catch (err) {
        // Logged, never thrown — the local processed set prevents replay.
        console.error('[websync] outbox ack failed:', err?.message ?? err);
      }
    }

    // Outbox-brain drain staleness guard (guard wave 2026-11-06): the
    // lockless drain heartbeats here on every CLEAN completion — a row
    // applied, a stop at a non-brain row, or nothing pending are all
    // proof the drain is alive. A completion with `failure` does NOT
    // stamp: an unprocessable brain row must read as a dead drain, not
    // a live one. Best-effort: a stamp-write failure must never break
    // the drain. The tick's normal pull (brainOnly false) never stamps
    // — otherwise the tick would keep the heartbeat fresh and mask a
    // dead drain. A pull that throws (the catch below) never stamps
    // either: it never completed.
    let drainLastOk = null;
    if (brainOnly && !failure) {
      try {
        drainLastOk = Date.now();
        await setConfig(OUTBOX_BRAIN_DRAIN_LAST_OK_KEY, String(drainLastOk));
      } catch { drainLastOk = null; }
    }

    const out = { pulled: items.length, applied, already, acked, cursor };
    if (brainOnly) out.brainOnly = true;
    if (brainOnly && drainLastOk) out.drainLastOk = drainLastOk;
    if (stoppedAtNonBrain) out.stoppedAtNonBrain = true;
    if (brainSkipped) out.brainSkipped = true;
    if (failure) out.error = 'stopped at unprocessable item: ' + (failure?.message ?? 'unknown');
    return out;
  } catch (err) {
    return { error: 'outbox pull failed: ' + (err?.message ?? 'unknown') };
  }
}

/**
 * Lockless brain-rows-only outbox drain (tick-wallclock wave). Same
 * fetch/ack/cursor mechanics as pullOutbox, but applies ONLY
 * brain-dependent rows and stops (never skips) at the first non-brain
 * row — the tick owns the fast rows and applies them on its next pass,
 * after which this drain proceeds. Up to OUTBOX_BRAIN_PER_DRAIN brain
 * rows per call (PB School wave 2026-11-06; the tick still stops at
 * OUTBOX_BRAIN_PER_TICK = 1), and no new brain row starts once the pull
 * has spent OUTBOX_BRAIN_DRAIN_BUDGET_MS — the lockless invocation
 * still runs inside the ~33s isolate window, so the budget keeps a
 * burst from becoming a minutes-long brain backlog in one call. Called by
 * the endpoints/tick outboxBrainOnly branch (no tick lock, no cycles)
 * and the pb-outbox-brain cron. Never drops a row: the cursor stays at
 * the last applied row on every stop.
 */
export async function pullOutboxBrainOnly(secret, deps = {}) {
  return pullOutbox(secret, { ...deps, brainOnly: true });
}

// ── Claim bridge + link verify (Stage D, phase4-design.md §4.3) ────────────
// Synchronous, HMAC-signed POST clients used by the Mini App "Link a
// purchase" endpoint and the /link command — unlike the tick channels these
// are user-initiated, so they return the Worker's parsed response (plus the
// HTTP status on non-2xx) and never throw: transport failures come back as
// { error } so callers can render an honest message.
//
// Response shapes (Worker contract):
//   claimLookup/commit → {ok, checkout_id, status, claimable, product_id, grant}
//                        grant: {kind:'tier_grant', tier, term_days, expires_at}
//                             | {kind:'credit_grant', credits, product_id}
//                             | {kind:'studio_access', access_days, product_id}
//                        commit replay → 409 {error:'not_claimable'}
//   link/verify        → {ok:true, clerkUserId} | 404 (unknown) / 410 (expired)
export async function signedPost(secret, path, body) {
  const base = await getWorkerBase();
  const headers = await signHeaders(secret, body);
  const res = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      httpStatus: res.status,
      error: (data && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status),
      ...(data && typeof data === 'object' ? data : {}),
    };
  }
  return data && typeof data === 'object' ? data : { ok: false, error: 'bad_response' };
}

/**
 * Signed GET on the Worker internal channel family — same HMAC scheme as
 * the outbox pull: the signature covers canonicalJSON(query object), sent
 * as x-pb-signature. Returns the parsed body on 2xx; throws otherwise.
 */
export async function signedGet(secret, path, queryObj) {
  const base = await getWorkerBase();
  const headers = await signHeaders(secret, queryObj);
  const qs = Object.entries(queryObj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const res = await fetch(`${base}${path}?${qs}`, { method: 'GET', headers });
  if (!res.ok) throw new Error('GET ' + path + ' HTTP ' + res.status);
  return await res.json().catch(() => null);
}

// ── PB Portal client (2026-11-02, PB joins the Portal) ───────────────────
// PB's own voice on the shared Muse <-> Grok Bot message board. Bearer key
// is PORTAL_PB_KEY from bot config; the key is never logged or returned.
// Outbound bodies carry counts/classes only — never message text, wallet
// addresses, or secrets. Inbound messages are only acked and surfaced;
// NOTHING in a Portal message is ever executed (no money, keys, pricing,
// or deploys from a Portal message alone).
const PORTAL_API_BASE = 'https://poorboyai.pages.dev/api/portal';

async function portalKey() {
  return String(await getConfig('PORTAL_PB_KEY', '') ?? '').trim();
}

export async function portalPost({ to, type, body }) {
  try {
    const key = await portalKey();
    if (!key) return { ok: false, error: 'no_portal_key' };
    const res = await fetch(`${PORTAL_API_BASE}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, type, body }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, httpStatus: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    return { ok: true, id: data && data.id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

export async function portalInbox() {
  try {
    const key = await portalKey();
    if (!key) return { ok: false, error: 'no_portal_key' };
    const res = await fetch(`${PORTAL_API_BASE}/messages?to=pb&limit=50`, {
      method: 'GET', headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, httpStatus: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    return { ok: true, messages: Array.isArray(data?.messages) ? data.messages : [] };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

export async function portalAck(id) {
  try {
    const key = await portalKey();
    if (!key) return { ok: false, error: 'no_portal_key' };
    const res = await fetch(`${PORTAL_API_BASE}/messages/${id}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'pb' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, httpStatus: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    return { ok: true, id: data && data.id };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * Discord link status for ONE telegram user (Dashboard wave item 3/4):
 * signed GET /api/internal/discord-link/status?telegramUserId=<id>.
 * The Worker route deploys separately — on ANY failure (no secret, HTTP
 * error, bad shape) this returns { linked:false, unavailable:true } and
 * never throws, so member endpoints degrade honestly.
 */
export async function fetchDiscordLinkStatus(tgId) {
  try {
    const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
    if (!secret) return { linked: false, unavailable: true };
    const data = await signedGet(secret, '/api/internal/discord-link/status', {
      telegramUserId: Number(tgId),
    });
    if (!data || typeof data !== 'object') return { linked: false, unavailable: true };
    return {
      linked: Boolean(data.linked ?? data.connected),
      username: data.username ?? data.discordUsername ?? data.discord_username ?? null,
    };
  } catch {
    return { linked: false, unavailable: true };
  }
}

/** Look up a checkout: is it claimable, and what would the grant be? */
export async function claimLookup(secret, checkoutId) {
  try {
    return await signedPost(secret, '/api/internal/claim/lookup', { checkout_id: checkoutId });
  } catch (err) {
    return { error: 'claim lookup failed: ' + (err?.message ?? 'unknown') };
  }
}

/** Commit a claim (Worker flips paid_unclaimed → claimed atomically). */
export async function claimCommit(secret, checkoutId, tgId) {
  try {
    return await signedPost(secret, '/api/internal/claim/commit', {
      checkout_id: checkoutId,
      telegram_user_id: Number(tgId),
    });
  } catch (err) {
    return { error: 'claim commit failed: ' + (err?.message ?? 'unknown') };
  }
}

/** Verify a console link code for this Telegram user. */
export async function linkCodeVerify(secret, code, tgId) {
  try {
    return await signedPost(secret, '/api/internal/link/verify', {
      code: String(code).trim(),
      telegram_user_id: Number(tgId),
    });
  } catch (err) {
    return { error: 'link verify failed: ' + (err?.message ?? 'unknown') };
  }
}

// ── Promo codes (2026-10-21) ───────────────────────────────────────────────
// Codes live ONLY in the site Worker's D1 (promo_codes) — the bot keeps no
// code table. /promo and /redeem (DM) redeem over the HMAC bridge; the
// Worker records the redemption, snapshots the grant, and emits it on the
// outbox with the deterministic item id 'promo:<redemption id>'.
// deliverPromo ALSO applies the grant locally right away through the same
// appliers under that same item id, so the tick's later pull of the outbox
// row dedupes (credit refId 'outbox:promo:<id>'; tier grants upsert) —
// exactly once in every ordering, and a crash between the bridge call and
// the local apply still lands via the tick.

export async function promoRedeem(secret, code, tgId, deps = {}) {
  const poster = deps.poster || ((path, body) => signedPost(secret, path, body));
  try {
    return await poster('/api/internal/promo/redeem', {
      code: String(code ?? '').trim(),
      telegram_user_id: Number(tgId),
    });
  } catch (err) {
    return { error: 'promo redeem failed: ' + (err?.message ?? 'unknown') };
  }
}

const PROMO_ERROR_TEXT = {
  code_not_found: "🤔 That code doesn't exist — check the spelling and try again.",
  bad_code: '🤔 That doesn\'t look like a promo code. Codes look like PB-XXXXXX.',
  code_inactive: '⏸️ That code is no longer active.',
  code_expired: '⌛ That code has expired.',
  code_exhausted: '🎟️ That code has already been fully redeemed.',
};

export async function deliverPromo(userId, rawCode, deps = {}) {
  const secret = deps.secret ?? (await getConfig('PB_WEB_SYNC_SECRET', ''));
  if (!secret) {
    await wizSend(userId, '⚠️ Promo redemption is unavailable right now — the rewards bridge is not configured. Tell the owner.');
    return 'unavailable';
  }
  const res = await promoRedeem(secret, rawCode, userId, deps);
  if (!res || res.ok !== true) {
    const errCode = typeof res?.error === 'string' ? res.error : '';
    if (PROMO_ERROR_TEXT[errCode]) {
      await wizSend(userId, PROMO_ERROR_TEXT[errCode]);
      return 'refused';
    }
    if (res?.httpStatus === 401 || errCode === 'unauthorized') {
      await wizSend(userId, "⚠️ Promo redemption hit an authorization snag on PB's side — your code was NOT used. Tell the owner.");
      return 'retry';
    }
    await wizSend(userId, "❌ Couldn't reach the promo desk just now — your code was NOT used. Try /promo again in a bit.");
    return 'retry';
  }
  const grant = res.grant || {};
  const itemId = 'promo:' + String(res.redemption_id);
  try {
    if (grant.kind === 'tier_grant') {
      await applyTierGrant({
        telegram_user_id: String(userId),
        tier: grant.tier,
        expires_at: grant.expires_at ?? null,
        source: 'promo_code',
        ref: itemId,
      });
    } else if (grant.kind === 'credit_grant') {
      await applyCreditGrant({
        id: itemId,
        type: 'credit_grant',
        telegram_user_id: String(userId),
        credits: grant.credits,
        source: 'promo_code',
      });
    }
  } catch { /* the tick's outbox pull lands it instead — same id, deduped */ }
  if (grant.kind === 'tier_grant') {
    const exp = grant.expires_at ? ` until ${String(grant.expires_at).slice(0, 10)}` : ' (permanent)';
    await wizSend(userId, res.already
      ? `🎁 You already redeemed this code — your *${mdSafeW(grant.tier)}* tier${exp} is on your account.`
      : `🎁 *Code redeemed!* Your *${mdSafeW(grant.tier)}* tier is active${exp}.`);
  } else {
    const n = Number(grant.credits) || 0;
    await wizSend(userId, res.already
      ? `🎁 You already redeemed this code — its *${n} credits* are already in your balance.`
      : `🎁 *Code redeemed!* *${n} Studio credits* were added to your balance. Spend them in /create or the Mini App Studio.`);
  }
  return 'done';
}

const promoKey = (userId) => `promocap:${userId}`;

export async function handlePromoCapture(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  let sess = null;
  try {
    const raw = await getConfig(promoKey(userId), null);
    if (raw) sess = JSON.parse(raw);
  } catch { sess = null; }
  if (!sess?.armed) return false;
  if (!sess.expiresAt || Date.now() > sess.expiresAt) {
    await setConfig(promoKey(userId), JSON.stringify({ armed: false })).catch(() => {});
    await wizSend(userId, '⏰ That promo prompt expired — run /promo again when you\'re ready.');
    return true;
  }
  const outcome = await deliverPromo(userId, text, deps);
  if (outcome === 'done' || outcome === 'refused') {
    await setConfig(promoKey(userId), JSON.stringify({ armed: false })).catch(() => {});
  }
  return true;
}

async function promoCommand(chatId, args, msg) {
  const userId = msg.from?.id;
  if (!userId) return;
  if (msg.chat?.type !== 'private') {
    await api.sendMessage({
      chat_id: chatId,
      text: '🎁 Promo codes are redeemed in private — DM me /promo with your code.',
    }).catch(() => {});
    return;
  }
  const code = String(args ?? '').trim();
  if (code) {
    await deliverPromo(userId, code);
    return;
  }
  await setConfig(promoKey(userId), JSON.stringify({ armed: true, expiresAt: Date.now() + 5 * 60 * 1000 })).catch(() => {});
  await wizSend(userId,
    '🎁 *Redeem a promo code*\n\nSend me the code (it looks like `PB-XXXXXX`) and I\'ll apply its credits or tier grant to your account right away.\n\n_(Expires in 5 minutes.)_');
}

export const PROMO_COMMANDS = {
  promo: promoCommand,
  redeem: promoCommand,
};

// ── /email — subscriber email (PoorBoyAI subscriber email v1) ─────────────
// DROP-IN for tgcloud/lib/websync.js — paste after the PROMO_COMMANDS block.
// Everything it uses is already in scope in websync.js: signedPost,
// wizSend, mdSafeW, getConfig, api. See PATCH_NOTES.md for the two-line
// registration in handlers/message.js + lib/catalog.js.
//
// The subscriber list lives ONLY in the site Worker's D1 (subscribers
// table) — the bot keeps no email store. /email talks to the Worker's
// POST /api/email/bridge-subscribe over the standing HMAC channel
// (signedPost), exactly like /promo redeem: subscribe / status /
// unsubscribe are actions on that one endpoint. NO new outbox kind is
// needed — the D1 outbox is the Worker→bot direction; bot→Worker writes
// have always used signedPost (claim bridge, promo redeem, link verify).
//
// Consent: setting an address here IS the opt-in — marketing_consent
// true rides along, the confirmation copy says what they'll get, and
// /email off is the one-command stop. Every email PB sends additionally
// carries a one-click unsubscribe link (Rowdy's NO-SPAM rule).

const EMAIL_RE_BOT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function emailBridge(secret, payload, deps = {}) {
  const poster = deps.poster || ((path, body) => signedPost(secret, path, body));
  try {
    return await poster('/api/email/bridge-subscribe', payload);
  } catch (err) {
    return { error: 'email bridge failed: ' + (err?.message ?? 'unknown') };
  }
}

async function emailBridgeOrComplain(userId, secret, payload) {
  const res = await emailBridge(secret, payload);
  if (res && res.ok === true) return res;
  if (res?.httpStatus === 401 || res?.error === 'unauthorized') {
    await wizSend(userId, "⚠️ Email settings hit an authorization snag on PB's side — nothing was changed. Tell the owner.");
    return null;
  }
  await wizSend(userId, "❌ Couldn't reach the email desk just now — nothing was changed. Try /email again in a bit.");
  return null;
}

async function emailCommand(chatId, args, msg) {
  const userId = msg.from?.id;
  if (!userId) return;
  if (msg.chat?.type !== 'private') {
    // DM opt-in prompt (2026-11-07): only while the member has NOT already
    // opted in — the redirect already asks them to DM for email, so the
    // prompt adds the announcements reason to the same trip.
    let redirectText = '📧 Email settings live in private — DM me /email.';
    if (msg.from?.id && shouldShowDmOptinPrompt(await readDmOptinNotifications(msg.from.id))) {
      redirectText += `\n\n${dmOptinPromptLine('email')}`;
    }
    await api.sendMessage({
      chat_id: chatId,
      text: redirectText,
    }).catch(() => {});
    return;
  }
  const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
  if (!secret) {
    await wizSend(userId, '⚠️ Email signup is unavailable right now — the mail bridge is not configured. Tell the owner.');
    return;
  }
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();

  if (sub === 'set') {
    const address = (parts[1] ?? '').trim().toLowerCase();
    if (address.length > 254 || !EMAIL_RE_BOT.test(address)) {
      await wizSend(userId, "🤔 That doesn't look like an email address. Try: `/email set you@example.com`");
      return;
    }
    const res = await emailBridgeOrComplain(userId, secret, {
      action: 'subscribe', email: address,
      telegram_id: Number(userId), source: 'bot', marketing_consent: true,
    });
    if (!res) return;
    await wizSend(userId,
      `📧 *You're on the list.* PB updates + upgrade offers will go to *${mdSafeW(address)}* — only when there's something real to say.\n\nA welcome email is queued for the next mail run. Changed your mind anytime: /email off — and every email carries a one-click unsubscribe link.`);
    return;
  }

  if (sub === 'off' || sub === 'stop' || sub === 'unsubscribe') {
    const res = await emailBridgeOrComplain(userId, secret, {
      action: 'unsubscribe', telegram_id: Number(userId),
    });
    if (!res) return;
    if (res.found) {
      await wizSend(userId, "🔕 *Done — email is off.* You won't get PB marketing email anymore. /email set <address> turns it back on.");
    } else {
      await wizSend(userId, "You don't have an email on the list — nothing to turn off.");
    }
    return;
  }

  if (sub === '' || sub === 'status') {
    const res = await emailBridgeOrComplain(userId, secret, {
      action: 'status', telegram_id: Number(userId),
    });
    if (!res) return;
    if (res.found && res.subscriber) {
      const s = res.subscriber;
      if (s.status === 'unsubscribed') {
        await wizSend(userId,
          `📧 *Email: off.* ${mdSafeW(s.email)} is unsubscribed.\n\n/email set <address> to rejoin.`);
      } else {
        await wizSend(userId,
          `📧 *Email: on.* Updates + offers go to *${mdSafeW(s.email)}*.\n\n/email set <address> to change it · /email off to stop.`);
      }
    } else {
      await wizSend(userId,
        "📧 *No email on the list yet.*\n\n/email set you@example.com — you'll get PB product updates + upgrade offers, only when there's something real to say. Unsubscribe is one click in every email.");
    }
    return;
  }

  await wizSend(userId,
    '📧 *Email commands*\n\n/email — see your status\n/email set you@example.com — subscribe or change your address\n/email off — unsubscribe');
}

export const EMAIL_COMMANDS = {
  email: emailCommand,
};

/**
 * Apply a Worker claim grant locally, mapping it onto the same appliers the
 * outbox uses — every path is replay-safe: tier grants upsert by telegram id,
 * credit grants dedupe on credit_ledger refId ('claim:'+checkoutId carried
 * in the outbox-id slot), studio access upserts by telegram id.
 */
export async function applyClaimGrant(tgId, grant, checkoutId) {
  const id = String(tgId ?? '').trim();
  if (!id || !grant || typeof grant !== 'object') throw new Error('claim grant malformed');
  const kind = String(grant.kind ?? '').trim();
  if (kind === 'tier_grant') {
    const applied = await applyTierGrant({
      telegram_user_id: id,
      tier: grant.tier,
      expires_at: grant.expires_at,
      term: grant.term,
      source: 'claim',
      ref: checkoutId,
    });
    // F3: the worker pairs term_credits with every claimed tier grant
    // (claimGrantFor). Replay-safe: applyCreditGrant dedupes on refId
    // 'outbox:claimterm:<checkoutId>' — a re-claim can never grant twice.
    // source names tier+term; it lands in the ledger's purpose column.
    const termCredits = Number(grant.term_credits) || 0;
    if (termCredits > 0) {
      const term = grant.term === 'quarterly' ? 'quarterly' : grant.term === 'annual' ? 'annual' : 'monthly';
      await applyCreditGrant({
        id: 'claimterm:' + checkoutId,
        type: 'credit_grant',
        telegram_user_id: id,
        credits: termCredits,
        source: `term_grant:${String(grant.tier ?? '').toLowerCase()}:${term}`,
      });
    }
    return applied;
  }
  if (kind === 'credit_grant') {
    return await applyCreditGrant({
      id: 'claim:' + checkoutId,
      type: 'credit_grant',
      telegram_user_id: id,
      credits: grant.credits,
      source: 'claim',
    });
  }
  if (kind === 'studio_access') {
    // TRIALPOLICY 2026-11-01 (#2 + #5): a Studio-access purchase claimed
    // while the 7-day trial is active is HELD, not unlocked — the trial
    // already includes Ad Creator, so an immediately-starting 125/7d or
    // 750/30d window would double-grant a sampler on top of the trial's
    // 100 credits. The purchase itself STANDS (#5): no refund, no extra
    // credit — the held grant is released in full on trial end or
    // conversion (releaseHeldGrants), with its access window starting
    // at release, so the paid term is preserved, not confiscated, and
    // simply runs later. Replay guard: a held row with this claim refId
    // means the claim is already held — return without a second row.
    // Held-insert failure falls back to the immediate grant (money
    // already paid must land; never wedge the claim over the hold).
    const accessRefId = 'claim:' + checkoutId;
    let trialActiveAccess = false;
    try { trialActiveAccess = (await weekTrialStatus(id)).active; } catch { trialActiveAccess = false; }
    if (trialActiveAccess) {
      let alreadyHeld = null;
      try {
        alreadyHeld = await db.select().from(held_grants)
          .where(eq(held_grants.refId, accessRefId)).get();
      } catch { alreadyHeld = null; }
      if (alreadyHeld) return;
      try {
        await db.insert(held_grants).values({
          telegramUserId: id, kind: 'studio_access', credits: null,
          accessDays: Number(grant.access_days) || 0,
          productId: grant.product_id ?? null, refId: accessRefId,
          source: 'claim', claimedAt: new Date(),
        }).run();
        try {
          await api.sendMessage({
            chat_id: id,
            text: '⏳ Your Studio access purchase is held until your 7-day trial ends — your trial already includes Ad Creator, so the access window starts when the trial ends (or when you switch to the PB Plan) and you keep the full term. Nothing is lost.',
          });
        } catch { /* DM best-effort; the held row itself already landed */ }
        return;
      } catch (err) {
        console.error('[trialpolicy:hold] held studio_access insert failed, granting immediately:', err?.message ?? err);
      }
    }
    await db.insert(studio_access_grants).values({
      telegramUserId: id,
      accessDays: Number(grant.access_days) || 0,
      productId: grant.product_id ?? null,
      claimedAt: new Date(),
    }).onConflictDoUpdate({
      target: studio_access_grants.telegramUserId,
      set: {
        accessDays: Number(grant.access_days) || 0,
        productId: grant.product_id ?? null,
        claimedAt: new Date(),
      },
    }).run();
    // OPS-35: a claimed Studio-access purchase pages the owner.
    await pageOwners([
      '💰 NEW PURCHASE',
      '',
      `👤 telegram ${id}`,
      `🎬 Studio access: ${Number(grant.access_days) || 0} days (${grant.product_id ?? 'studio_access'})`,
      '',
      '✅ Access unlocked.',
    ].join('\n'));
    // Purchase announcement (never names the buyer): the claim
    // bridge is the studio_access producer by construction, so a
    // claimed access IS a purchase. Ad Creator card for both
    // variants; unknown product is HELD, never mislabeled.
    const adSku = WIZBUY_PRODUCTS[String(grant.product_id ?? '')];
    if (adSku && String(grant.product_id).startsWith('ad:')) {
      await announcePurchase({ key: `purchase:claim:${checkoutId}`, product: String(grant.product_id), label: adSku.label, imageKey: 'pbx11' });
      // Lifecycle receipt (flag-gated, best-effort): Ad Creator gets
      // receipt only — no tier welcome applies. Term end from the
      // granted access days; amount exact from the SKU.
      const adDays = Number(grant.access_days) || 0;
      await lifecycleOnPurchase({
        tgId: id, source: 'claim', tier: null, label: adSku.label,
        amountUsd: adSku.amountUsd, term: 'access',
        termEndMs: adDays > 0 ? Date.now() + adDays * 86400_000 : null,
        expiresAt: null, receiptId: `claim:${checkoutId}`, txUrl: null,
      }).catch((err) => console.error('[lifecycle:hook] ad failed:', err?.message ?? err));
    } else {
      console.log('[purchase-announce] held: unknown studio product', grant.product_id);
    }
    return;
  }
  throw new Error('unknown claim grant kind: ' + kind);
}

// ── Stats push (EDGE WAVE #5 — live transparency strip) ────────────────────
// PB pushes a snapshot of real counts from its own cloud DB to the Worker's
// POST /api/internal/stats-sync (same HMAC signing as keys-sync); the Worker
// stores it in its config table (key 'pb_stats') and serves it publicly at
// GET /api/stats for the homepage transparency strip. Every number is a real
// count — nothing is estimated. Throttled like pushKeyDirectory: when the
// fingerprint is unchanged AND the last push is < 1h old, the push is
// skipped; otherwise it pushes and updates the markers.

const STATS_PUSH_MAX_AGE_MS = 60 * 60 * 1000;

export async function pushStatsSnapshot(secret) {
  try {
    const base = await getWorkerBase();
    let stats;
    let trending = null;
    try {
      const xpRow = await db.get(sql`SELECT COALESCE(SUM(xp), 0) AS total FROM raid_xp`);
      stats = {
        users: Number(await db.$count(bot_users)) || 0,
        groups: Number(await db.$count(known_groups)) || 0,
        raidXp: Number(xpRow?.total) || 0,
        conversations: Number(await db.$count(pb_conversations)) || 0,
        mcpKeys: Number(await db.$count(mcp_api_keys, isNull(mcp_api_keys.revokedAt))) || 0,
      };
      // Trending board (2026-10-21): sealed aggregates from lib/xp.js —
      // tokens + vote power + real buy volume, never group attribution.
      // It rides the same HMAC-signed body as a sibling field. The
      // Worker's coerceStats whitelists the numeric stats fields today,
      // so `trending` is dropped worker-side until the Worker learns
      // the field (batched site deploy follow-up) — harmless either
      // way, and the payload is forward-compatible from day one.
      trending = await trendingBoard(10).catch(() => null);
    } catch (err) {
      return { error: 'stats read failed: ' + (err?.message ?? 'unknown') };
    }

    // Fingerprint covers the board too: a changed board re-pushes even
    // when the counters stand still (at most once per webSync cycle).
    const fingerprint = await sha256Hex(canonicalJSON({ stats, trending }));
    const prev = await getConfig('stats:fingerprint', '');
    const lastPushMs = Number(await getConfig('stats:last_push_ms', '0')) || 0;
    if (prev === fingerprint && lastPushMs && Date.now() - lastPushMs < STATS_PUSH_MAX_AGE_MS) {
      return { skipped: 'unchanged' };
    }

    const body = { stats, trending, pushedAt: Date.now() };
    const headers = await signHeaders(secret, body);
    const res = await fetch(base + '/api/internal/stats-sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('stats-sync HTTP ' + res.status);
    await setConfig('stats:fingerprint', fingerprint);
    await setConfig('stats:last_push_ms', String(Date.now()));
    return { pushed: true };
  } catch (err) {
    return { error: 'stats-sync failed: ' + (err?.message ?? 'unknown') };
  }
}

// ── Console ops snapshot (console bot-push wave, 2026-11-06) ───────────────
// The operator console panels wave 6 could not build (N2/N3/N4/N5/N6/N7/N8/
// N9 + M7 partial) get their data here: one collector per field, each
// fail-soft to null, all read-only. The payload rides the existing
// bot-status HMAC channel — new fields, same signing, worker stores
// botStatus verbatim, consoleAdminBotControl returns it whole. NOTHING
// goes through stats-sync (its coerceStats whitelist + public /api/stats
// make it the wrong channel for operator data). No new config keys are
// written by the collectors; the only writer is runDueCycles (tick_last).
// TICK_LAST_KEY is the twin of the same const in lib/tick.js — keep in sync.

const TICK_LAST_KEY = 'tick_last';
const OPS_CHAINS = ['base', 'sol', 'rh'];

/** Pure: summarize GROUP BY credit_ledger rows [{k, b}] into balances. */
export function summarizeCreditLedger(rows) {
  const balances = (rows ?? [])
    .map((r) => ({ userKey: String(r?.k ?? ''), balance: Math.floor(Number(r?.b) || 0) }))
    .filter((x) => x.userKey && x.balance > 0);
  balances.sort((a, b) => b.balance - a.balance);
  return {
    totalOutstanding: balances.reduce((s, x) => s + x.balance, 0),
    usersWithBalance: balances.length,
    topBalances: balances.slice(0, 25),
  };
}

/** Pure: summarize GROUP BY bot_users rows [{tier, c}] into tier counts. */
export function summarizeUsersByTier(rows) {
  const out = { free: 0, starter: 0, builder: 0, pro: 0, agency: 0, one: 0, trial: 0, other: 0 };
  for (const r of rows ?? []) {
    const tier = String(r?.tier ?? '').toLowerCase();
    const n = Math.max(0, Math.floor(Number(r?.c) || 0));
    if (tier in out) out[tier] += n;
    else out.other += n;
  }
  return out;
}

async function collectTickHealth() {
  let last = null;
  try { const raw = await getConfig(TICK_LAST_KEY, ''); if (raw) last = JSON.parse(raw); } catch { last = null; }
  const t = last && typeof last === 'object' ? last : {};
  // Drain guard: READ-ONLY eval with the same inputs runWebSync uses.
  // The count persistence stays in runWebSync — this eval never writes.
  let guard = { armed: false, stale: false, count: 0, lastOkMs: null, detail: 'flag off — tick owns brain rows' };
  try {
    const flagOn = await getConfigFlag('outbox_brain_separate');
    const stampRaw = await getConfig(OUTBOX_BRAIN_DRAIN_LAST_OK_KEY, '');
    const countRaw = await getConfig(OUTBOX_BRAIN_DRAIN_STALE_COUNT_KEY, '0');
    const sinceRaw = await getConfig(OUTBOX_BRAIN_DRAIN_STALE_SINCE_KEY, '');
    const g = evalOutboxBrainDrainStale({ flagOn, stampRaw, staleCount: countRaw, staleSinceRaw: sinceRaw, nowMs: Date.now(), cursor: '' });
    const lastOk = Number(stampRaw);
    guard = { armed: g.armed, stale: g.stale, count: g.count, lastOkMs: Number.isFinite(lastOk) && lastOk > 0 ? lastOk : null, detail: String(g.detail ?? '').slice(0, 200) };
  } catch { /* guard stays default */ }
  return {
    ranAt: Number.isFinite(Number(t.ranAt)) ? Number(t.ranAt) : null,
    lockSkipped: t.lockSkipped === true,
    lockStreak: Number.isFinite(Number(t.lockStreak)) ? Math.max(0, Math.floor(Number(t.lockStreak))) : 0,
    heldCycle: typeof t.heldCycle === 'string' ? t.heldCycle : null,
    cycleErrors: Array.isArray(t.cycleErrors) ? t.cycleErrors.filter((x) => typeof x === 'string').slice(0, 20) : [],
    moneyErrors: Array.isArray(t.moneyErrors) ? t.moneyErrors.filter((x) => typeof x === 'string').slice(0, 10) : [],
    drainGuard: guard,
  };
}

async function collectMirrorDead() {
  const rows = await mirrorDeadFailureRows();
  const surfaced = new Set(await readMirrorDeadSurfaced());
  return {
    total: rows.length,
    rows: rows.map((r) => ({
      id: r.id, direction: r.direction,
      error: String(r.detail ?? '').slice(0, 200),
      attempts: r.attempts, ageHrs: r.ageHrs,
      surfaced: surfaced.has(r.id),
    })),
  };
}

async function collectXBudget() {
  const b = await xLoopBudgetState();
  const q = await xQueueList();
  return {
    day: b.day, postsCap: b.postsCap, postsUsed: b.postsUsed, postsRemaining: b.postsRemaining,
    repliesCap: b.repliesCap, repliesUsed: b.repliesUsed, repliesRemaining: b.repliesRemaining,
    queueDepth: q.length, queueVideo: q.filter((i) => i && i.videoJobId).length,
  };
}

async function collectSalesLeg() {
  // Same truthy test as isSalesLegLive (statscmds.js:1049, SALES_GATE_KEY
  // 'sales_leg_live'); read inline — no statscmds import.
  const v = String(await getConfig('sales_leg_live', '') ?? '').trim().toLowerCase();
  return { live: v === '1' || v === 'on' || v === 'true' || v === 'yes' };
}

async function collectVideoAds() {
  const q = await xQueueList();
  const pending = await xVideoPendingRead();
  const today = xLoopDayKey();
  let postedToday = 0;
  try {
    const rows = await db.select().from(x_loop_log)
      .where(and(eq(x_loop_log.kind, 'queue'), eq(x_loop_log.status, 'sent')))
      .orderBy(desc(x_loop_log.id)).limit(100).all();
    // Phase B posts carry detail 'video:<queueId>'; the day filter uses the
    // same LA day key as the budget, so no tz math. Newest-100 cap covers
    // ~4+ days at the 15-post/10-reply daily caps (see plan §6).
    postedToday = (rows ?? []).filter((r) =>
      String(r?.detail ?? '').startsWith('video:') && xLoopDayKey(Number(r?.ts ?? 0) * 1000) === today).length;
  } catch { postedToday = 0; }
  return { queued: q.filter((i) => i && i.videoJobId).length, uploading: pending ? 1 : 0, postedToday };
}

async function collectChains() {
  const airdrop = {};
  const boost = {};
  for (const c of OPS_CHAINS) {
    airdrop[c] = { enabled: await isAirdropChainEnabled(c), armed: await isAirdropChainArmed(c) };
    boost[c] = { enabled: await isBoostChainEnabled(c), armed: await isBoostChainArmed(c) };
  }
  return {
    airdrop, boost,
    global: {
      airdropEnabled: await getConfigFlag('airdrop_enabled'),
      airdropArmed: await getConfigFlag('airdrop_live_arm'),
      boostEnabled: await getConfigFlag('boost_enabled'),
      boostArmed: await getConfigFlag('boost_live_arm'),
    },
  };
}

async function collectTrials() {
  const trialRows = await db.select().from(pb_trials).all();
  const list = trialRows ?? [];
  const started = list.length;
  const active = list.filter((r) => String(r?.state ?? '') === 'active').length;
  // Converted: trial rows whose user now holds tier 'one' — per-row lookup
  // (trials are few); a SQL join would be unreadable under the harness stubs.
  let converted = 0;
  for (const t of list) {
    try {
      const u = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(t.telegramUserId))).get();
      if (u && String(u.tier ?? '').toLowerCase() === 'one') converted++;
    } catch { /* this row counts as not converted */ }
  }
  const refRows = await db.select().from(referrals).all().catch(() => []);
  const referralTotal = (refRows ?? []).length;
  // Referral bonus total: referralBonus() (tiers.js:167) is made*3 +
  // (wasReferred ? 5 : 0) per user; summed over all users = 3N + 5N = 8N
  // because each referral row is one made AND one distinct referred user
  // (uq_referrals_referred).
  return { started, active, converted, referralTotal, referralBonusTotal: referralTotal * 8 };
}

async function collectReviews() {
  const counts = { new: 0, read: 0, approved: 0, hidden: 0 };
  try {
    for (const s of ['new', 'read', 'approved', 'hidden']) {
      counts[s] = (await db.$count(pb_feedback, eq(pb_feedback.status, s))) || 0;
    }
  } catch { /* counts stay 0 */ }
  let latest = [];
  try {
    const rows = await db.select().from(pb_feedback).orderBy(desc(pb_feedback.createdAt)).limit(20).all();
    latest = (rows ?? []).map((r) => ({
      id: Number(r.id), kind: String(r.kind ?? ''),
      stars: r.stars == null ? null : Number(r.stars),
      userId: String(r.userId ?? ''), username: r.username ? String(r.username) : null,
      displayName: r.displayName ? String(r.displayName) : null,
      text: String(r.text ?? '').slice(0, 300),
      status: String(r.status ?? ''),
      createdAt: iso(r.createdAt),
    }));
  } catch { latest = []; }
  return { counts, latest };
}

async function collectCredits() {
  let planGrantCredits = 1000;
  try {
    const v = Number(await getConfig('pb_included_allowance_credits', ''));
    if (Number.isFinite(v) && v > 0) planGrantCredits = Math.floor(v);
  } catch { /* default 1000 */ }
  const planMembers = (await db.$count(bot_users, eq(bot_users.tier, 'one'))) || 0;
  let rows = [];
  try {
    // No LIMIT in SQL: totals must cover every positive-balance user; the
    // summarizer caps the payload list at 25.
    rows = await db.all(sql`SELECT user_key AS k, SUM(amount) AS b FROM credit_ledger GROUP BY user_key HAVING SUM(amount) > 0 ORDER BY SUM(amount) DESC`);
  } catch { rows = []; }
  const sum = summarizeCreditLedger(rows ?? []);
  return { planGrantCredits, planMembers, totalOutstanding: sum.totalOutstanding, usersWithBalance: sum.usersWithBalance, topBalances: sum.topBalances };
}

async function collectUsersByTier() {
  let rows = [];
  try {
    rows = await db.all(sql`SELECT tier, COUNT(*) AS c FROM bot_users GROUP BY tier`);
  } catch { rows = []; }
  return summarizeUsersByTier(rows ?? []);
}

/**
 * Gather every console-ops field for the bot-status push. Each field is
 * collected in its own try/catch → null on failure, so one bad read can
 * never fail the push (or the tick cycle that carries it).
 */
export async function collectConsoleOps() {
  const out = {};
  const fields = {
    tickHealth: collectTickHealth, mirrorDead: collectMirrorDead, xBudget: collectXBudget,
    salesLeg: collectSalesLeg, videoAds: collectVideoAds, chains: collectChains,
    trials: collectTrials, reviews: collectReviews, credits: collectCredits, usersByTier: collectUsersByTier,
    p2pDisputes: collectP2pDisputes,
  };
  for (const [name, fn] of Object.entries(fields)) {
    try { out[name] = await fn(); } catch { out[name] = null; }
  }
  return out;
}

// ── Bot status push (Dashboard wave) ───────────────────────────────────────
// POST /api/internal/bot-status, HMAC-signed like the other pushes,
// fingerprint + 1h throttle, failure-isolated. Providers report CONFIGURED
// (key present) only — never a key value. configPresence is an allowlist
// of key NAMES with presence booleans; nothing else about config leaves.

const BOTSTATUS_MAX_AGE_MS = 60 * 60 * 1000;
const CONFIG_PRESENCE_KEYS = [
  'PB_WEB_SYNC_SECRET', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY',
  'XROCKET_PAY_TOKEN', 'CLERK_PUBLISHABLE_KEY', 'DISCORD_BOT_TOKEN',
];

export async function pushBotStatus(secret) {
  try {
    const base = await getWorkerBase();
    let botStatus;
    let configPresence;
    try {
      const presenceEntries = [];
      for (const key of CONFIG_PRESENCE_KEYS) {
        const v = await getConfig(key, '');
        presenceEntries.push([key, Boolean(String(v ?? '').trim())]);
      }
      configPresence = Object.fromEntries(presenceEntries);
      botStatus = {
        brainPrimary: LLM_MODELS.chat.primary.model,
        brainFallback: LLM_MODELS.chat.fallback.model,
        providers: {
          gemini: configPresence.GEMINI_API_KEY,
          openrouter: configPresence.OPENROUTER_API_KEY,
          xai: configPresence.XAI_API_KEY,
        },
        holders: Number(await db.$count(pbai_holder_wallets)) || 0,
        groups: Number(await db.$count(known_groups)) || 0,
        users: Number(await db.$count(bot_users)) || 0,
      };
      // Bot probe patch (status v2 follow-up, 2026-11-01): carry the tick's
      // synthetic probe record into botStatus so the Worker Brain reader
      // flips from UNKNOWN to a real check. NARROWED vs the saved patch:
      // only {at, ok, failStreak, slowStreak} are pushed — never rung,
      // latency, or error text (the Worker stores botStatus verbatim in
      // D1, and none of those belong in a public status record). The
      // Worker reader uses ok/failStreak/slowStreak only, with fixed
      // detail literals, so this shape is complete for it. Fail-soft:
      // a missing/corrupt probe record reads as null, never throws.
      let probe = null;
      try {
        const rawProbe = await getConfig('answer_probe_last', '');
        const rec = rawProbe ? JSON.parse(rawProbe) : null;
        if (rec && typeof rec === 'object') {
          probe = {
            at: Number.isFinite(Number(rec.at)) ? Number(rec.at) : null,
            ok: rec.ok === true ? true : rec.ok === false ? false : null,
            failStreak: Number.isFinite(Number(rec.failStreak)) ? Math.floor(Number(rec.failStreak)) : 0,
            slowStreak: Number.isFinite(Number(rec.slowStreak)) ? Math.floor(Number(rec.slowStreak)) : 0,
          };
        }
      } catch { probe = null; }
      botStatus.probe = probe;
      // Console ops snapshot (console bot-push wave, 2026-11-06): new
      // fields, same signing. Never throws (per-field fail-soft inside);
      // a total failure here still leaves the base botStatus pushable.
      try { Object.assign(botStatus, await collectConsoleOps()); } catch { /* base fields still push */ }
    } catch (err) {
      return { error: 'bot-status read failed: ' + (err?.message ?? 'unknown') };
    }

    const body = { botStatus, configPresence };
    // Throttle WITHOUT spamming and WITHOUT missing a probe flip: the
    // main fingerprint covers botStatus WITHOUT probe, and a coarse
    // probeState covers the probe. Push when (a) main fingerprint
    // changed, OR (b) probeState differs from the stored one, OR (c)
    // last push > 1h. Without (b), a failing probe would only ride the
    // 1h push; with it, a flip is visible within one webSync cycle.
    // Explicit field list (no object-rest destructuring) so the fingerprint
    // shape is exactly the pre-patch botStatus shape, probe excluded.
    // Console bot-push wave: the rarely-changing new fields join the
    // fingerprint (an arming flip, a new dead row, a new review, a trial
    // start re-pushes promptly). High-churn values are EXCLUDED — ranAt,
    // xBudget used-counts, credit balances, per-row details ride the next
    // triggered push or the 1h max-age push.
    const botStatusMain = {
      brainPrimary: botStatus.brainPrimary,
      brainFallback: botStatus.brainFallback,
      providers: botStatus.providers,
      holders: botStatus.holders,
      groups: botStatus.groups,
      users: botStatus.users,
      salesLeg: botStatus.salesLeg,
      chains: botStatus.chains,
      mirrorDeadTotal: botStatus.mirrorDead ? botStatus.mirrorDead.total : null,
      reviewsNew: botStatus.reviews ? botStatus.reviews.counts.new : null,
      trialsActive: botStatus.trials ? botStatus.trials.active : null,
    };
    const probeState = botStatus.probe
      ? botStatus.probe.ok + ':' + botStatus.probe.failStreak + ':' + botStatus.probe.slowStreak
      : 'none';
    // Coarse ops trigger (same shape as probeState, no timestamps): a
    // lock-streak change, a money-cycle error appearing/clearing, or the
    // drain guard flipping stale/clean re-pushes within one webSync cycle.
    const th = botStatus.tickHealth;
    const opsState = th
      ? [th.lockStreak, (th.moneyErrors ?? []).join(','), th.drainGuard ? (th.drainGuard.stale ? 'stale' : 'ok') : 'unknown'].join(':')
      : 'none';
    const fingerprint = await sha256Hex(canonicalJSON({ botStatus: botStatusMain, configPresence }));
    const prev = await getConfig('botstatus:fingerprint', '');
    const prevProbeState = await getConfig('botstatus:probe_state', '');
    const prevOpsState = await getConfig('botstatus:ops_state', '');
    const lastPushMs = Number(await getConfig('botstatus:last_push_ms', '0')) || 0;
    if (prev === fingerprint && prevProbeState === probeState && prevOpsState === opsState && lastPushMs && Date.now() - lastPushMs < BOTSTATUS_MAX_AGE_MS) {
      return { skipped: 'unchanged' };
    }

    const headers = await signHeaders(secret, body);
    const res = await fetch(base + '/api/internal/bot-status', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('bot-status HTTP ' + res.status);
    await setConfig('botstatus:fingerprint', fingerprint);
    await setConfig('botstatus:probe_state', probeState);
    await setConfig('botstatus:ops_state', opsState);
    await setConfig('botstatus:last_push_ms', String(Date.now()));
    return { pushed: true };
  } catch (err) {
    return { error: 'bot-status failed: ' + (err?.message ?? 'unknown') };
  }
}

// ── Business directory push (Dashboard wave) ───────────────────────────────
// POST /api/internal/business-sync — full snapshot of connected Business
// customers each push (fingerprint-gated, 1h throttle, failure-isolated).
// Only the connection owner's id, a display name, their mode/aiEnabled
// (via loadBizSettings — the same read business_message uses) and the
// connection time. No message content ever leaves.

const BUSINESS_SYNC_MAX_AGE_MS = 60 * 60 * 1000;

export async function pushBusinessDirectory(secret) {
  try {
    const base = await getWorkerBase();
    let customers;
    try {
      const conns = await db.select().from(business_connections).all();
      customers = [];
      for (const c of conns) {
        if (!c.isActive) continue;
        let user = null;
        try {
          user = await db.select().from(bot_users)
            .where(eq(bot_users.telegramUserId, String(c.ownerTelegramId))).get();
        } catch { /* name stays null */ }
        const s = await loadBizSettings(c.ownerTelegramId).catch(() => null);
        customers.push({
          telegramUserId: Number(c.ownerTelegramId),
          displayName: user?.firstName ?? user?.username ?? null,
          mode: s?.replyMode ?? 'ai',
          aiEnabled: s ? s.aiEnabled !== false : true,
          connectedAt: iso(c.connectedAt),
        });
      }
      customers.sort((a, b) => a.telegramUserId - b.telegramUserId);
    } catch (err) {
      return { error: 'business directory read failed: ' + (err?.message ?? 'unknown') };
    }

    const body = { customers };
    const fingerprint = await sha256Hex(canonicalJSON(body));
    const prev = await getConfig('business:fingerprint', '');
    const lastPushMs = Number(await getConfig('business:last_push_ms', '0')) || 0;
    if (prev === fingerprint && lastPushMs && Date.now() - lastPushMs < BUSINESS_SYNC_MAX_AGE_MS) {
      return { skipped: 'unchanged', customers: customers.length };
    }

    const headers = await signHeaders(secret, body);
    const res = await fetch(base + '/api/internal/business-sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('business-sync HTTP ' + res.status);
    await setConfig('business:fingerprint', fingerprint);
    await setConfig('business:last_push_ms', String(Date.now()));
    return { pushed: customers.length };
  } catch (err) {
    return { error: 'business-sync failed: ' + (err?.message ?? 'unknown') };
  }
}

// ── Tick entry ───────────────────────────────────────────────────────────────

/**
 * Run one full bridge pass: pull first, then push, each wrapped so one
 * channel's failure never blocks the other. Returns { outbox, keys } with
 * errors as strings — nothing here throws at the tick.
 */
export async function runWebSync(deps = {}) {
  let secret;
  try {
    secret = await getConfig('PB_WEB_SYNC_SECRET', '');
  } catch {
    secret = '';
  }
  if (!secret) return { skipped: 'not_configured' };

  let outbox, keys, stats, botStatus, business, studio, signer;
  try {
    // Studio bridge (Batches 1–3): push PB-owned job transitions to the D1
    // queue of record, pull status deltas back into the mirror, and settle
    // / refund on terminal states. Failure-isolated like every channel.
    studio = await runStudioSync(secret, {
      poster: (path, body) => signedPost(secret, path, body),
      getter: (path, query) => signedGet(secret, path, query),
    });
  } catch (err) {
    studio = { error: err?.message ?? 'unknown' };
  }
  try {
    // Signer bridge (Airdrop Phase 2): push airdrop claim intents to the
    // D1 queue the host-side signer worker polls, pull outcome reports
    // back into transfer state. Deposit-class claims, ciphertext only;
    // the broadcast signal inside each claim carries the arm state.
    // Failure-isolated like every channel.
    signer = await runSignerSync(secret, {
      poster: (path, body) => signedPost(secret, path, body),
      getter: (path, query) => signedGet(secret, path, query),
    });
  } catch (err) {
    signer = { error: err?.message ?? 'unknown' };
  }
  let boostDepgen;
  try {
    // Boost depgen (broadcaster wave): Solana deposit-wallet generation
    // for boost campaigns parked at 'deposit_generating' — same §8.5
    // channel as airdrop, own cursor, failure-isolated like every channel.
    boostDepgen = await runBoostDepgenSync({
      poster: (path, body) => signedPost(secret, path, body),
      getter: (path, query) => signedGet(secret, path, query),
    });
  } catch (err) {
    boostDepgen = { error: err?.message ?? 'unknown' };
  }
  // Tick-wallclock wave: when outbox_brain_separate is ON, the tick
  // skips brain-dependent outbox rows (the lockless pb-outbox-brain
  // cron drains them instead). Default '0' = current behavior (the
  // tick applies up to 1 brain row/pull). Fail-closed: a config blip
  // reads as OFF, so the tick keeps applying brain rows rather than
  // stranding them on an unproven drain path. Flip ON only after the
  // pb-outbox-brain cron proves one lockless run (same guard as the
  // rev 572 scan flag). Registered in BOOLEAN_CONFIG_KEYS so /setkey
  // lands on this lowercase row (D1 lesson).
  let skipBrainOutbox = false;
  try { skipBrainOutbox = await getConfigFlag('outbox_brain_separate'); } catch { skipBrainOutbox = false; }
  try {
    outbox = await pullOutbox(secret, { ...(deps.fetch ? { fetch: deps.fetch } : {}), skipBrain: skipBrainOutbox });
  } catch (err) {
    outbox = { error: err?.message ?? 'unknown' };
  }
  // Outbox-brain drain staleness guard (guard wave 2026-11-06, §5 R4):
  // while the separate drain owns brain rows, the tick watches its
  // heartbeat stamp and counts consecutive stale ticks. The page signal
  // is a TOP-LEVEL `error` on this cycle's result: the in-bot watchers
  // (portal money-episode, outageConditions) and the host tick job all
  // read top-level `cycles[name].error` — a nested `outbox.error` is
  // invisible to them, so a nested-only signal would never page. The
  // guard state is also attached to `outbox.brainDrainGuard` on every
  // armed tick, so the stall is digest-visible before it pages. The
  // guard never throws into webSync, and a counter-write failure never
  // breaks the tick. `deps.nowMs` is a harness seam (production passes
  // no deps, so Date.now()).
  let brainDrainGuard = null;
  if (skipBrainOutbox) {
    try {
      const stampRaw = await getConfig(OUTBOX_BRAIN_DRAIN_LAST_OK_KEY, '');
      const countRaw = await getConfig(OUTBOX_BRAIN_DRAIN_STALE_COUNT_KEY, '0');
      const sinceRaw = await getConfig(OUTBOX_BRAIN_DRAIN_STALE_SINCE_KEY, '');
      brainDrainGuard = evalOutboxBrainDrainStale({
        flagOn: true, stampRaw, staleCount: countRaw, staleSinceRaw: sinceRaw,
        nowMs: deps.nowMs ?? Date.now(), cursor: outbox?.cursor ?? '',
      });
      try { await setConfig(OUTBOX_BRAIN_DRAIN_STALE_COUNT_KEY, String(brainDrainGuard.count)); } catch { /* best effort */ }
      const sinceWire = brainDrainGuard.staleSinceMs == null ? '' : String(brainDrainGuard.staleSinceMs);
      if (sinceWire !== String(sinceRaw ?? '')) {
        try { await setConfig(OUTBOX_BRAIN_DRAIN_STALE_SINCE_KEY, sinceWire); } catch { /* best effort */ }
      }
      if (outbox && typeof outbox === 'object') {
        outbox.brainDrainGuard = { stale: brainDrainGuard.stale, count: brainDrainGuard.count, page: brainDrainGuard.page, detail: brainDrainGuard.detail };
      }
    } catch { /* guard must never break webSync */ }
  } else {
    // Guard disarmed: never carry a stale count into a future flip —
    // clear it once if a previous armed episode left one behind.
    try {
      const countRaw = await getConfig(OUTBOX_BRAIN_DRAIN_STALE_COUNT_KEY, '0');
      if ((Number(countRaw) || 0) > 0) {
        await setConfig(OUTBOX_BRAIN_DRAIN_STALE_COUNT_KEY, '0');
        await setConfig(OUTBOX_BRAIN_DRAIN_STALE_SINCE_KEY, '');
      }
    } catch { /* best effort */ }
  }
  try {
    keys = await pushKeyDirectory(secret);
  } catch (err) {
    keys = { error: err?.message ?? 'unknown' };
  }
  try {
    stats = await pushStatsSnapshot(secret);
  } catch (err) {
    stats = { error: err?.message ?? 'unknown' };
  }
  try {
    botStatus = await pushBotStatus(secret);
  } catch (err) {
    botStatus = { error: err?.message ?? 'unknown' };
  }
  try {
    business = await pushBusinessDirectory(secret);
  } catch (err) {
    business = { error: err?.message ?? 'unknown' };
  }
  const result = { outbox, keys, stats, botStatus, business, studio, signer, boostDepgen };
  // Guard page signal (see above): top-level, so the money-cycle
  // watchdog sees it. It fires only after
  // OUTBOX_BRAIN_DRAIN_STALE_TICKS consecutive stale ticks — a first
  // transient never pages. While the drain stays stale the error
  // persists every tick (the parent's no-drip dedupe covers repeats,
  // same as any persistent money-cycle error); a nested outbox.error,
  // if any, is left intact for detail.
  if (brainDrainGuard?.page) result.error = 'outbox brain drain stale: ' + brainDrainGuard.detail;
  return result;
}

// ── Support tickets + worker applications (bot write path) ──────────────────
// Both stores live web-side (D1) behind PUBLIC Worker endpoints — the same
// ones the website's own forms post to (phase4/_worker.js handleWizardTicket
// / handleCommunityApply). There is no HMAC/internal ingest route, so the
// bot posts exactly like a browser form; the endpoints' inserts emit the
// outbox 'ticket' event the tick already applies (owner DM). Consequences,
// stated plainly: both endpoints rate-limit 5/hour PER IP and the bot's
// egress IP is shared, so a 429 is surfaced honestly, never swallowed; the
// application row's source: the endpoint defaults to 'website' and
// honors the wizard's explicit source:'telegram' (buildApplicationPayload).
async function postPublicJson(path, body, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const base = await getWorkerBase();
  try {
    const res = await doFetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: Boolean(res.ok), data };
  } catch (err) {
    return { status: 0, ok: false, data: null, error: String(err?.message ?? err) };
  }
}

export async function submitSupportTicket({ description, name }, deps = {}) {
  return postPublicJson('/api/wizard/ticket', {
    description: String(description ?? '').slice(0, 4000),
    name: String(name ?? '').slice(0, 200) || null,
    source: 'telegram',
  }, deps);
}

export async function submitCommunityApplication(payload, deps = {}) {
  return postPublicJson('/api/community/apply', payload, deps);
}

const mdSafeW = (v) => String(v ?? '').replace(/[*_`[\]]/g, '');
async function wizSend(userId, text, buttons = null) {
  await api.sendMessage({
    chat_id: userId, text, parse_mode: 'Markdown',
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  }).catch(() => {});
}

// ── /support — one-shot DM capture ───────────────────────────────────────────
const supportKey = (userId) => `supportcap:${userId}`;

async function deliverSupport(userId, msg, description, deps = {}) {
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
    + (msg.from.username ? ` (@${msg.from.username})` : '') + ` [tg:${userId}]`;
  const res = await submitSupportTicket({ description, name }, deps);
  if (res.ok && res.data?.ticket?.id != null) {
    await wizSend(userId, `🎫 *Ticket #${res.data.ticket.id} filed.* The owner gets pinged right away — watch this DM for a reply.`);
    return 'done';
  }
  if (res.status === 429) {
    await wizSend(userId, '⏳ Support is rate-limited right now (too many tickets this hour) — your message was NOT filed. Give it a bit, then run /support and send it again. In a rush? The support chat is https://t.me/poorboyai_agent_support');
    return 'retry';
  }
  await wizSend(userId, '❌ Couldn\'t file that ticket — PB hit a snag reaching the support desk. Your message was NOT filed; try /support again in a bit.');
  return 'retry';
}

export async function handleSupportCapture(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  let sess = null;
  try {
    const raw = await getConfig(supportKey(userId), null);
    if (raw) sess = JSON.parse(raw);
  } catch { sess = null; }
  if (!sess?.armed) return false;
  if (!sess.expiresAt || Date.now() > sess.expiresAt) {
    await setConfig(supportKey(userId), JSON.stringify({ armed: false })).catch(() => {});
    await wizSend(userId, '⏰ That support prompt expired — run /support again when you\'re ready.');
    return true;
  }
  const outcome = await deliverSupport(userId, msg, text, deps);
  if (outcome === 'done') {
    await setConfig(supportKey(userId), JSON.stringify({ armed: false })).catch(() => {});
  }
  return true;
}

export const SUPPORT_COMMANDS = {
  support: async (chatId, args, msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (msg.chat?.type !== 'private') {
      await api.sendMessage({
        chat_id: chatId,
        text: '🆘 Support tickets are private — DM me /support with what\'s wrong and I\'ll file it for the owner.',
      }).catch(() => {});
      return;
    }
    const text = String(args ?? '').trim();
    if (text) {
      await deliverSupport(userId, msg, text);
      return;
    }
    await setConfig(supportKey(userId), JSON.stringify({ armed: true, expiresAt: Date.now() + 5 * 60 * 1000 })).catch(() => {});
    await wizSend(userId,
      '🆘 *PB Support*\n\nTell me what\'s wrong — your next message here becomes the ticket, and the owner gets pinged right away.\n\n_(Expires in 5 minutes. Anything you send that isn\'t a command is filed as the ticket.)_');
  },
};

// ── /apply — worker application wizard ───────────────────────────────────────
// Mirrors the original's /apply walk (name, bio, niches, availability,
// audience size, handles, confirm) and submits in the WEBSITE's shape to
// POST /api/community/apply, landing in the same D1 community_applications
// review queue the console reads. Two forced deviations from the original,
// both imposed by the live store: an EMAIL step (the endpoint requires and
// dedupe-keys on it) and the availability pick lands in `role` (the
// endpoint's single role field) while niches + audience fold into the
// free-text `experience` the endpoint preserves.
export const APPLY_ROLES = [
  { key: 'shilling', label: '📣 Shilling' },
  { key: 'moderation', label: '🛡️ Moderation' },
  { key: 'community', label: '👥 Community Management' },
  { key: 'content', label: '🎨 Content Creation' },
  { key: 'development', label: '💻 Development' },
  { key: 'raiding', label: '⚔️ Raiding' },
  { key: 'translation', label: '🌐 Translation' },
];
export const APPLY_NICHES = [
  'Crypto', 'DeFi', 'NFTs', 'Meme Coins', 'Trading',
  'Solana', 'Base Chain', 'Gaming', 'AI', 'Content Creation',
];
export const APPLY_TIERS = [
  { key: 'nano', label: 'Nano (<1K)' },
  { key: 'micro', label: 'Micro (1K–10K)' },
  { key: 'mid', label: 'Mid (10K–50K)' },
  { key: 'macro', label: 'Macro (50K+)' },
];
const APPLY_TTL_MS = 15 * 60 * 1000;
const applyKey = (userId) => `applywiz:${userId}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const APPLY_TEXT_STEPS = {
  name: { label: 'Your name', prompt: 'What\'s your name (or the name you go by publicly)?' },
  email: { label: 'Email', prompt: 'What email can the team reach you at? (Required — applications are keyed by email.)' },
  bio: { label: 'Bio', prompt: 'Short bio — who you are and what you do in the space.' },
  experience: { label: 'Experience', prompt: 'Your experience — communities you\'ve worked with, how long, what you did there.' },
  proof: { label: 'Proof of work', prompt: 'Proof of work — links to posts, communities, dashboards, anything that shows the work.' },
  x: { label: 'X handle', prompt: 'Your X (Twitter) handle — send it, or tap Skip.', skippable: true },
  tiktok: { label: 'TikTok / other', prompt: 'TikTok or any other social handle worth knowing — send it, or tap Skip.', skippable: true },
  why: { label: 'Why PB', prompt: 'Why do you want to work with PoorBoyAI?' },
};
const APPLY_ORDER = ['name', 'email', 'role', 'bio', 'niches', 'tier', 'experience', 'proof', 'x', 'tiktok', 'why', 'confirm'];

async function saveApplySession(userId, sess) {
  sess.expiresAt = Date.now() + APPLY_TTL_MS;
  await setConfig(applyKey(userId), JSON.stringify(sess)).catch(() => {});
}
async function clearApplySession(userId) {
  await setConfig(applyKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}
async function loadApplySession(userId) {
  try {
    const raw = await getConfig(applyKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.step) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

async function sendApplyStep(userId, sess) {
  const step = sess.step;
  const n = APPLY_ORDER.indexOf(step) + 1;
  const head = `🤝 *Worker Application — step ${n} of ${APPLY_ORDER.length}*`;
  if (step === 'role') {
    await wizSend(userId, `${head}\n\n*What are you available for?* Pick the closest fit:`,
      APPLY_ROLES.map((r) => [{ text: r.label, callback_data: `applywiz:role:${r.key}` }]));
    return;
  }
  if (step === 'niches') {
    const picked = new Set(sess.data.niches ?? []);
    await wizSend(userId, `${head}\n\n*Your niches* — tap to toggle, then Done:${picked.size ? `\nPicked: ${[...picked].join(', ')}` : ''}`, [
      ...APPLY_NICHES.map((nm) => [{ text: `${picked.has(nm) ? '✅' : '▫️'} ${nm}`, callback_data: `applywiz:niche:${nm}` }]),
      [{ text: '➡️ Done', callback_data: 'applywiz:nichesdone' }],
    ]);
    return;
  }
  if (step === 'tier') {
    await wizSend(userId, `${head}\n\n*Your audience size* on your main platform:`,
      APPLY_TIERS.map((t) => [{ text: t.label, callback_data: `applywiz:tier:${t.key}` }]));
    return;
  }
  if (step === 'confirm') {
    await sendApplyConfirm(userId, sess);
    return;
  }
  const spec = APPLY_TEXT_STEPS[step];
  if (!spec) return;
  const row = [];
  if (spec.skippable) row.push({ text: '⏭ Skip', callback_data: 'applywiz:skip' });
  row.push({ text: '❌ Cancel', callback_data: 'applywiz:cancel' });
  await wizSend(userId, `${head}\n\n*${spec.label}*\n${spec.prompt}`, [row]);
}

async function sendApplyConfirm(userId, sess) {
  const d = sess.data ?? {};
  const role = APPLY_ROLES.find((r) => r.key === d.role)?.label ?? d.role ?? '—';
  const tier = APPLY_TIERS.find((t) => t.key === d.tier)?.label ?? '—';
  const lines = [
    '🤝 *Review your application*',
    '',
    `Name: ${mdSafeW(d.name)}`,
    `Email: ${mdSafeW(d.email)}`,
    `Role: ${mdSafeW(role)}`,
    `Bio: ${mdSafeW(String(d.bio ?? '').slice(0, 200))}`,
    `Niches: ${mdSafeW((d.niches ?? []).join(', ') || '—')}`,
    `Audience: ${tier}`,
    `Experience: ${mdSafeW(String(d.experience ?? '').slice(0, 200))}`,
    `Proof: ${mdSafeW(String(d.proof ?? '').slice(0, 200))}`,
    `X: ${d.x ? '@' + mdSafeW(String(d.x).replace(/^@/, '')) : '—'} · Telegram: ${sess.data.telegram ? '@' + mdSafeW(sess.data.telegram) : '—'}${d.tiktok ? ` · Other: ${mdSafeW(d.tiktok)}` : ''}`,
    `Why PB: ${mdSafeW(String(d.why ?? '').slice(0, 200))}`,
    '',
    'Submit it? It lands in the team\'s review queue, plus a marketplace profile in the KOL review queue.',
  ];
  await wizSend(userId, lines.join('\n'), [[
    { text: '🚀 Submit application', callback_data: 'applywiz:submit' },
    { text: '❌ Cancel', callback_data: 'applywiz:cancel' },
  ]]);
}

async function advanceApply(userId, sess) {
  const idx = APPLY_ORDER.indexOf(sess.step);
  sess.step = APPLY_ORDER[Math.min(idx + 1, APPLY_ORDER.length - 1)];
  await saveApplySession(userId, sess);
  await sendApplyStep(userId, sess);
}

/** Compose the website-shaped payload from the wizard's collected data. */
export function buildApplicationPayload(sess) {
  const d = sess.data ?? {};
  const role = APPLY_ROLES.find((r) => r.key === d.role)?.label.replace(/^\S+\s/, '') ?? d.role ?? '';
  const tier = APPLY_TIERS.find((t) => t.key === d.tier)?.label ?? '';
  const expParts = [];
  if ((d.niches ?? []).length) expParts.push(`Niches: ${d.niches.join(', ')}`);
  if (tier) expParts.push(`Audience: ${tier}`);
  if (d.experience) expParts.push(String(d.experience));
  return {
    name: String(d.name ?? '').slice(0, 200),
    email: String(d.email ?? '').trim().toLowerCase(),
    role: String(role).slice(0, 100),
    bio: String(d.bio ?? '').slice(0, 4000),
    experience: expParts.join(' · ').slice(0, 4000) || null,
    proofOfWork: String(d.proof ?? '').slice(0, 4000),
    whyPbai: String(d.why ?? '').slice(0, 4000),
    twitter: d.x ? String(d.x).replace(/^@/, '').slice(0, 100) : null,
    telegram: d.telegram ? String(d.telegram).slice(0, 100) : null,
    source: 'telegram',
    discord: null,
    otherSocials: d.tiktok ? `TikTok/other: ${String(d.tiktok).slice(0, 180)}` : null,
  };
}

// ── /apply → worker_kol_profiles (apply-kol-restore wave, 2026-11-04) ───────
// The wizard's second feed: the same answers also land as a KOL marketplace
// profile (unverified until the cousins approve it). Pure map — no I/O, so
// the harness can prove it without any dependency. Role labels mirror the
// Replit available_for values; tier keys already match KOL_FOLLOWER_TIERS.
const KOL_AVAIL_BY_ROLE = {
  shilling: 'Shilling', moderation: 'Moderation', community: 'Community Management',
  content: 'Content Creation', development: 'Development', raiding: 'Raiding',
  translation: 'Translation',
};
export function buildKolProfilePayload(sess) {
  const d = sess.data ?? {};
  const stripAt = (v) => (typeof v === 'string' ? v.trim().replace(/^@+/, '').slice(0, 120) || null : null);
  const avail = KOL_AVAIL_BY_ROLE[d.role] ? [KOL_AVAIL_BY_ROLE[d.role]] : [];
  return {
    display_name: String(d.name ?? '').trim().slice(0, 120),
    bio: String(d.bio ?? '').trim().slice(0, 2000) || null,
    x_handle: stripAt(d.x),
    telegram_handle: stripAt(d.telegram),
    tiktok_handle: stripAt(d.tiktok),
    follower_tier: ['nano', 'micro', 'mid', 'macro'].includes(d.tier) ? d.tier : null,
    niches: Array.isArray(d.niches) ? d.niches.slice(0, 12) : [],
    available_for: avail,
  };
}

/** POST the KOL profile to the site's HMAC-gated internal upsert route.
 *  Returns the site result, or {ok:false,...} on any failure — callers treat
 *  a KOL sync failure as best-effort and never let it break the web submit.
 *  The bridge secret comes from bot config (PB_WEB_SYNC_SECRET), the same
 *  secret the tick's bridge calls use; it is never logged or returned. */
export async function submitKolProfile(payload, deps = {}) {
  try {
    const secret = deps.secret ?? String(await getConfig('PB_WEB_SYNC_SECRET', '') ?? '').trim();
    if (!secret) return { ok: false, error: 'no_bridge_secret' };
    const poster = deps.poster ?? ((path, body) => signedPost(secret, path, body));
    const res = await poster('/api/internal/worker-kol/upsert', payload);
    if (res && res.ok) return res;
    return { ok: false, error: (res && res.error) || 'upsert_failed', httpStatus: res?.httpStatus ?? null };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'upsert_error' };
  }
}

/** Cousin approval execution (Digi's path — never Rowdy's DM, never a Rowdy
 *  tap). Posts the decision to the site's HMAC-gated internal decision route.
 *  Codie screens on the War Room board; Digi calls this to finalize. */
export async function cousinKolDecision(kolId, decision, deps = {}) {
  try {
    const secret = deps.secret ?? String(await getConfig('PB_WEB_SYNC_SECRET', '') ?? '').trim();
    if (!secret) return { ok: false, error: 'no_bridge_secret' };
    const poster = deps.poster ?? ((path, body) => signedPost(secret, path, body));
    const res = await poster('/api/internal/worker-kol/decision', { id: kolId, decision });
    if (res && res.ok) return res;
    return { ok: false, error: (res && res.error) || 'decision_failed', httpStatus: res?.httpStatus ?? null };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'decision_error' };
  }
}

/** Notify the cousin approval queue that a KOL profile needs screening.
 *  Best-effort War Room board note to Codie (the screener) — it must never
 *  throw and never block a submit. Deliberately NOT an owner DM and NOT a
 *  group post: approval is the cousins' job and no live portal thread exists.
 *  Body carries applicant fields only (no chat text, no secrets). */
export async function notifyKolScreening(profile, deps = {}) {
  try {
    const post = deps.portalPost ?? portalPost;
    const handles = [profile.telegram_handle ? `@${profile.telegram_handle}` : null,
      profile.x_handle ? `@${profile.x_handle}` : null].filter(Boolean).join(' ');
    const lines = [
      'KOL application needs screening (bot /apply):',
      `${profile.display_name || 'Unnamed'}${handles ? ` (${handles})` : ''}`,
      `Audience: ${profile.follower_tier || '—'} | Niches: ${(profile.niches ?? []).join(', ') || '—'}`,
      `Services: ${(profile.available_for ?? []).join(', ') || '—'}`,
      profile.bio ? `Bio: ${String(profile.bio).slice(0, 200)}` : null,
      'Queue: console /dashboard/campaigns (KOL profiles tab) + /api/console/worker-portal. Codie screens, Digi decides.',
    ].filter(Boolean).join('\n');
    await post({ to: 'grok-bot', type: 'task', body: lines });
    return { ok: true };
  } catch { return { ok: false, error: 'screen_note_failed' }; }
}

export async function startApplyWizard(userId, from = {}) {
  const sess = {
    step: 'name',
    data: { telegram: from.username ?? null, niches: [] },
    expiresAt: Date.now() + APPLY_TTL_MS,
  };
  await saveApplySession(userId, sess);
  await wizSend(userId,
    '🤝 *Work with PoorBoyAI*\n\nThis application goes to the same review queue as the website form — the team reviews every one — and a marketplace profile goes to the KOL review queue. I\'ll ask a few quick questions (about 2 minutes).');
  await sendApplyStep(userId, sess);
  return true;
}

/** DM text capture for /apply. Returns true when consumed. */
export async function handleApplyWizardText(chatId, msg) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const { sess, expired } = await loadApplySession(userId);
  if (!sess) {
    if (expired) {
      await clearApplySession(userId);
      await wizSend(userId, '⏰ That application expired — run /apply to start again. Nothing was submitted.');
      return true;
    }
    return false;
  }
  const spec = APPLY_TEXT_STEPS[sess.step];
  if (!spec) return false; // button-driven step (role/niches/tier/confirm)
  if (/^skip$/i.test(text) && spec.skippable) {
    sess.data[sess.step] = null;
    await advanceApply(userId, sess);
    return true;
  }
  if (sess.step === 'email') {
    const email = text.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      await wizSend(userId, '⚠️ That doesn\'t look like a valid email — send it again (e.g. you@example.com).');
      return true;
    }
    sess.data.email = email;
  } else if (sess.step === 'x') {
    sess.data.x = text.replace(/^@/, '').trim().slice(0, 100);
  } else if (sess.step === 'tiktok') {
    sess.data.tiktok = text.slice(0, 200);
  } else {
    sess.data[sess.step] = text.slice(0, 2000);
  }
  await advanceApply(userId, sess);
  return true;
}

/** Button router for `applywiz:*` callbacks. Caller answers the query. */
export async function handleApplyCallback(query, deps = {}) {
  const userId = query.from?.id;
  const data = String(query.data ?? '');
  if (!userId) return null;
  const sub = data.slice('applywiz:'.length);

  if (sub === 'cancel') {
    await clearApplySession(userId);
    await wizSend(userId, '❌ Application cancelled — nothing was submitted.');
    return { text: 'Application cancelled.' };
  }
  const { sess } = await loadApplySession(userId);
  if (!sess) return { text: '⏰ That application session expired — run /apply again.', alert: true };

  if (sub.startsWith('role:')) {
    if (sess.step !== 'role') return { text: 'Out of order — follow the prompts.', alert: true };
    sess.data.role = sub.slice('role:'.length);
    await advanceApply(userId, sess);
    return { text: '✅ Role picked.' };
  }
  if (sub.startsWith('niche:')) {
    if (sess.step !== 'niches') return { text: 'Out of order — follow the prompts.', alert: true };
    const nm = sub.slice('niche:'.length);
    const picked = new Set(sess.data.niches ?? []);
    if (picked.has(nm)) picked.delete(nm); else picked.add(nm);
    sess.data.niches = [...picked];
    await saveApplySession(userId, sess);
    await sendApplyStep(userId, sess);
    return { text: picked.has(nm) ? `✅ ${nm}` : `▫️ ${nm} removed` };
  }
  if (sub === 'nichesdone') {
    if (sess.step !== 'niches') return { text: 'Out of order — follow the prompts.', alert: true };
    if (!(sess.data.niches ?? []).length) return { text: 'Pick at least one niche.', alert: true };
    await advanceApply(userId, sess);
    return { text: '➡️ Niches saved.' };
  }
  if (sub.startsWith('tier:')) {
    if (sess.step !== 'tier') return { text: 'Out of order — follow the prompts.', alert: true };
    sess.data.tier = sub.slice('tier:'.length);
    await advanceApply(userId, sess);
    return { text: '✅ Audience size saved.' };
  }
  if (sub === 'skip') {
    const spec = APPLY_TEXT_STEPS[sess.step];
    if (!spec?.skippable) return { text: 'This step can\'t be skipped.', alert: true };
    sess.data[sess.step] = null;
    await advanceApply(userId, sess);
    return { text: '⏭ Skipped.' };
  }
  if (sub === 'submit') {
    if (sess.step !== 'confirm') return { text: 'Finish the steps first.', alert: true };
    const payload = buildApplicationPayload(sess);
    // KOL-profile feed (apply-kol-restore wave): the same answers also land
    // as an unverified worker_kol_profiles row for the cousins' KOL queue.
    // Idempotent update-if-exists, so a web-submit retry/409 below stays
    // safe. Best-effort: a KOL sync failure never blocks the web submit.
    let kolRes = { ok: false, error: 'not_attempted' };
    try {
      kolRes = await submitKolProfile(buildKolProfilePayload(sess), deps);
    } catch { kolRes = { ok: false, error: 'kol_sync_error' }; }
    const res = await submitCommunityApplication(payload, deps);
    if (res.ok && res.data?.success) {
      await clearApplySession(userId);
      // Persist a bot-side receipt so the Mini App Worker Portal can show
      // this caller their own application state (see getWorkerPortalFor).
      // Best-effort: a receipt failure never breaks the submit itself.
      await recordApplicationReceipt(userId, {
        applicationId: res.data?.id ?? null,
        email: payload.email,
        name: payload.name,
        role: payload.role,
        telegram: payload.telegram,
        kol: kolRes.ok
          ? { id: kolRes.id ?? null, synced: true }
          : { id: null, synced: false },
      }).catch(() => {});
      // Cousin-queue screening note (Codie screens, Digi decides). Only when
      // the KOL row actually landed; never an owner DM, never a group post.
      if (kolRes.ok) {
        await notifyKolScreening(buildKolProfilePayload(sess), deps).catch(() => {});
      }
      await wizSend(userId,
        '🚀 *Application submitted!*\n\nIt\'s in the team\'s review queue now, plus a marketplace profile in the KOL review queue. If it\'s a fit, you\'ll hear back at the email you gave. Track it any time in the PB app: *More → 🤝 Worker Portal*. Thanks for applying!');
      return { text: '🚀 Application submitted.' };
    }
    if (res.status === 409) {
      sess.step = 'email';
      await saveApplySession(userId, sess);
      await wizSend(userId,
        '⚠️ An application with that email already exists — applications are one-per-email. Send a different email to continue, or /apply later if you need the team to update the existing one.');
      await sendApplyStep(userId, sess);
      return { text: '⚠️ That email already has an application.', alert: true };
    }
    if (res.status === 429) {
      return { text: '⏳ Applications are rate-limited right now — your answers are saved; tap Submit again in a bit.', alert: true };
    }
    return { text: `❌ Submit failed (${res.status || 'network'}) — your answers are saved; tap Submit again.`, alert: true };
  }
  return null;
}

export const APPLY_COMMANDS = {
  apply: async (chatId, _args, msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (msg.chat?.type !== 'private') {
      await api.sendMessage({
        chat_id: chatId,
        text: '🤝 Applications are personal — open a DM with me and run /apply there.',
      }).catch(() => {});
      return;
    }
    await startApplyWizard(userId, msg.from);
  },
};

// ── Worker Portal (Mini App) ───────────────────────────────────────────────
// Rowdy's consolidation ruling (2026-10-22): the worker portal FUNCTION
// lives in Telegram; the website console is operator oversight only. This
// is the worker's OWN view, served to endpoints/getDashboard.js action
// 'workerPortal'. Identity discipline: everything keys off the caller's
// platform-verified Telegram identity (initData user, passed in as `tg`) —
// never a client-supplied id or handle.
//
// What exists to read, honestly:
//  - The public directory (GET /api/community/verified on the site Worker)
//    is the SAME merged listing the public sees (community_workers +
//    verified worker_kol_profiles, deduped by handle). A caller is matched
//    to their listing by handle: their initData Telegram username, or the
//    X handle PB itself verified for them (twitter_handles.x_verified).
//    Everything in a listing is already public; matching decides only
//    WHICH public card is "yours".
//  - Application status has NO read path on the website (the review queue
//    is operator-only), so /apply records a bot-side receipt at submit
//    time (config `applyrec:<tgId>`). State model: matched listing →
//    'approved'; receipt but no listing → 'submitted' (in review — a
//    rejection is indistinguishable from pending through any channel PB
//    can read, and the screen copy says so); neither → 'none'.
//  - Announcement history is NOT served: worker_portal_posts (site D1)
//    has no writer in the current site code and no read route PB can
//    call, and its rows carry no worker key PB could attribute by.
//    Rather than invent one, the portal omits the section entirely.
const applyRecKey = (userId) => `applyrec:${userId}`;

export async function recordApplicationReceipt(userId, rec, deps = {}) {
  const set = deps.setConfig ?? setConfig;
  const row = {
    applicationId: rec?.applicationId ?? null,
    email: rec?.email ?? null,
    name: rec?.name ?? null,
    role: rec?.role ?? null,
    telegram: rec?.telegram ?? null,
    // KOL-feed sync state (apply-kol-restore wave): carried through so the
    // caller-side record shows whether a marketplace profile landed.
    // getWorkerPortalFor picks its own fields; extra keys are ignored.
    kol: rec?.kol ?? null,
    submittedAt: Date.now(),
  };
  await set(applyRecKey(userId), JSON.stringify(row));
  return row;
}

export async function getApplicationReceipt(userId, deps = {}) {
  const get = deps.getConfig ?? getConfig;
  try {
    const raw = await get(applyRecKey(userId), null);
    if (!raw) return null;
    const row = JSON.parse(raw);
    if (!row || typeof row !== 'object') return null;
    return row;
  } catch { return null; }
}

/** Handle normalization — mirrors the site Worker's directoryHandleKey. */
export function normalizeHandle(v) {
  return v == null ? '' : String(v).trim().replace(/^@+/, '').toLowerCase();
}

/** The public merged directory, or null when the site is unreachable. */
export async function fetchPublicDirectory(deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.workerBase ?? (await getWorkerBase());
  try {
    const res = await doFetch(base + '/api/community/verified');
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    const rows = Array.isArray(data?.workers) ? data.workers : null;
    return rows;
  } catch { return null; }
}

async function callerTwitterRow(tgId, deps = {}) {
  if (deps.twitterRow !== undefined) return deps.twitterRow;
  try {
    return await db.select().from(twitter_handles)
      .where(eq(twitter_handles.telegramUserId, String(tgId))).get() ?? null;
  } catch { return null; }
}

/** The public shape of one directory listing — exactly the fields
 *  /api/community/verified serves; nothing extra is exposed. */
function publicListing(w) {
  if (!w) return null;
  return {
    id: w.id ?? null,
    source: w.source ?? null,
    name: w.name ?? null,
    role: w.role ?? null,
    bio: w.bio ?? null,
    experience: w.experience ?? null,
    profilePicPath: w.profilePicPath ?? null,
    twitter: w.twitter ?? null,
    telegram: w.telegram ?? null,
    discord: w.discord ?? null,
    otherSocials: w.otherSocials ?? null,
    approvedAt: w.approvedAt ?? null,
  };
}

/**
 * The caller's own worker-portal state. `tg` is the platform-verified
 * initData user ({ id, username }) — the ONLY identity input. Returns:
 *   { state: 'approved'|'submitted'|'none', matchedBy, listing,
 *     application: {applicationId, submittedAt, role} | null,
 *     directoryTotal, directoryOk, announcements: { available:false } }
 * The receipt's email stays server-side (never returned to the client).
 */
export async function getWorkerPortalFor(tg, deps = {}) {
  const tgId = tg?.id;
  const receipt = tgId != null ? await getApplicationReceipt(tgId, deps) : null;
  const twRow = tgId != null ? await callerTwitterRow(tgId, deps) : null;

  // Match keys, strongest first: the platform-verified Telegram username,
  // then the X handle PB verified for this caller. Self-asserted handles
  // (unverified X, TikTok/Discord captures) never match a listing.
  const keys = [];
  const tgHandle = normalizeHandle(tg?.username);
  if (tgHandle) keys.push({ by: 'telegram', key: tgHandle });
  const xHandle = twRow?.xVerified ? normalizeHandle(twRow.twitterHandle) : '';
  if (xHandle && xHandle !== tgHandle) keys.push({ by: 'x', key: xHandle });

  const listings = await fetchPublicDirectory(deps);
  let listing = null;
  let matchedBy = null;
  if (Array.isArray(listings)) {
    for (const k of keys) {
      const hit = listings.find((w) =>
        normalizeHandle(w?.twitter) === k.key || normalizeHandle(w?.telegram) === k.key);
      if (hit) { listing = hit; matchedBy = k.by; break; }
    }
  }

  const state = listing ? 'approved' : (receipt ? 'submitted' : 'none');
  return {
    state,
    matchedBy,
    listing: publicListing(listing),
    application: receipt
      ? {
          applicationId: receipt.applicationId ?? null,
          submittedAt: receipt.submittedAt ?? null,
          role: receipt.role ?? null,
          name: receipt.name ?? null,
        }
      : null,
    directoryTotal: Array.isArray(listings) ? listings.length : null,
    directoryOk: Array.isArray(listings),
    announcements: { available: false },
  };
}

// ══ Telegram purchase wizard — WATCHER RAIL ORCHESTRATION (overnight build, 2026-10-25) ══
// Local only, unpushed. Approved 2026-10-22 as: pick product → transfer
// instructions → paste tx hash → watcher verifies → entitlement applies.
// Honest scope, read before wiring:
//   - This wizard does NOT create a site checkout and does NOT know a
//     receiving address on its own. No bot→Worker checkout-creation route
//     exists (the internal bridge is outbox / watcher claims / claim
//     lookup-commit only), and receiving addresses live ONLY in Worker D1
//     config. So the wizard orchestrates the EXISTING rails: it walks the
//     buyer to the existing site checkout (poorboyai.pages.dev/buy, existing
//     prices only), then collects the checkout id + chain/token + tx hash +
//     declared sending wallet and submits them to the EXISTING public
//     watcher-claim route (POST /api/<guest|subscription>-checkouts/<id>/
//     watcher-claim). The grant then lands through the EXISTING settle +
//     outbox applier, or through the existing claim bridge if the buyer did
//     not supply a Telegram id at checkout. "Entitlement auto-applies" is
//     therefore true only in the auto-grant case; the wizard never claims
//     otherwise, and it says so in its own copy.
//   - Fail-closed: if the watcher rail is off on the site (watcher-claim
//     returns watcher_disabled / 403), the wizard stops and tells the
//     buyer to wait for the watcher to be armed instead of inventing a transfer.
//     It never invents a receiving address, price, or checkout.
//   - Prices below are copied from the site catalog + /buy copy — the same
//     figures, never a new price: tiers monthly/annual, packs, Ad Creator
//     weekly/monthly. Stars is NOT in this wizard (spec only, separate lane).
//   - State lives in the existing config table (wizbuy:<userId> JSON, same
//     pattern as the apply wizard), so this build needs NO schema change
//     and NO migrate. Sessions expire at the watcher claim window for the
//     chosen product (tiers 24h, one-offs 7 days); an expired session tells
//     the buyer to start again and submits nothing.
//   - Buttons use the wizbuy: prefix, routed in handlers/callback_query.js;
//     text steps are consumed by handleBuyWizardText, wired into the DM
//     capture chain in handlers/message.js (same pattern as apply-wiz).
// FINAL MONEY-PATH LEG (2026-11-01): bare /checkout renders the GUEST
// checkout (packs + Ad Creator); the subscription form renders only at
// /checkout?tier=<tier>&period=<period>. The wizard must link the buyer
// straight to their plan form, or they land on packs with no path to the
// plan. Tier keys map to their plan form; packs, Ad Creator, malformed,
// and unknown keys fall back to bare /checkout (the guest page is where
// packs live).
export function wizbuyCheckoutUrl(productKey) {
  const m = /^tier:([A-Za-z0-9_-]+):(monthly|annual)$/.exec(String(productKey ?? ''));
  if (!m) return `${DEFAULT_BASE}/checkout`;
  return `${DEFAULT_BASE}/checkout?tier=${encodeURIComponent(m[1])}&period=${m[2]}`;
}

export const WIZBUY_PRODUCTS = {
  // PRICING WAVE (2026-10-31): 'one' is the single price for NEW sales
  // ($29/mo, $290/yr = 2 months free). Legacy tier SKUs stay defined
  // (proofCheckoutBridge asserts starter:monthly; purchase-announcement
  // and lifecycle lookups resolve old grants through this map) but are
  // NOT offered by wizbuyProductKeyboard below — new sales offer only
  // 'one' + packs. Ad Creator SKUs likewise stay defined (legacy
  // lookups) but are not offered: Ad Creator is folded into the PB
  // Plan, not a separate purchase anymore. Packs unchanged ($15/$49/$99,
  // never expire). NOTE: offering tier:one:* in the wizard still needs
  // the site Worker to accept those product keys and grant tier 'one'
  // — a follow-up outside this tree; until then the wizard's tier
  // buttons route to a checkout the Worker does not yet know.
  'tier:one:monthly': { label: 'PB Plan — $29/mo', kind: 'subscription', amountUsd: 29, windowDays: 1 },
  'tier:one:annual': { label: 'PB Plan — $290/yr', kind: 'subscription', amountUsd: 290, windowDays: 1 },
  'tier:starter:monthly': { label: 'Starter — $10/mo', kind: 'subscription', amountUsd: 10, windowDays: 1 },
  'tier:starter:annual': { label: 'Starter — $100/yr', kind: 'subscription', amountUsd: 100, windowDays: 1 },
  'tier:builder:monthly': { label: 'Builder — $23/mo', kind: 'subscription', amountUsd: 23, windowDays: 1 },
  'tier:builder:annual': { label: 'Builder — $230/yr', kind: 'subscription', amountUsd: 230, windowDays: 1 },
  'tier:pro:monthly': { label: 'Pro — $63/mo', kind: 'subscription', amountUsd: 63, windowDays: 1 },
  'tier:pro:annual': { label: 'Pro — $630/yr', kind: 'subscription', amountUsd: 630, windowDays: 1 },
  'tier:agency:monthly': { label: 'Agency — $130/mo', kind: 'subscription', amountUsd: 130, windowDays: 1 },
  'tier:agency:annual': { label: 'Agency — $1300/yr', kind: 'subscription', amountUsd: 1300, windowDays: 1 },
  'pack:500': { label: '500 credits — $15 · about 250 images', kind: 'guest', amountUsd: 15, windowDays: 7 },
  'pack:2000': { label: '2,000 credits — $49 · about 1,000 images', kind: 'guest', amountUsd: 49, windowDays: 7 },
  'pack:5000': { label: '5,000 credits — $99 · about 2,500 images', kind: 'guest', amountUsd: 99, windowDays: 7 },
  'ad:weekly': { label: 'Ad Creator — $6.25/wk', kind: 'guest', amountUsd: 6.25, windowDays: 7 },
  'ad:monthly': { label: 'Ad Creator — $24.99/mo', kind: 'guest', amountUsd: 24.99, windowDays: 7 },
};

const WIZBUY_RAILS = {
  'base:USDC': { chain: 'base', token: 'USDC', label: 'Base USDC' },
  'base:USDT': { chain: 'base', token: 'USDT', label: 'Base USDT' },
  'solana:USDC': { chain: 'solana', token: 'USDC', label: 'Solana USDC' },
  'solana:USDT': { chain: 'solana', token: 'USDT', label: 'Solana USDT' },
  'solana:SOL': { chain: 'solana', token: 'SOL', label: 'Solana SOL' },
};

const WIZBUY_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const WIZBUY_TX_RE = /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{32,128})$/;
const WIZBUY_PAYER_RE = {
  base: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

const wizbuyKey = (userId) => `wizbuy:${userId}`;

async function wizbuyLoad(userId, deps = {}) {
  const get = deps.get ?? ((k) => getConfig(k, null));
  const raw = await get(wizbuyKey(userId)).catch(() => null);
  if (!raw) return { sess: null, expired: false };
  let sess = null;
  try { sess = JSON.parse(raw); } catch { sess = null; }
  if (!sess) return { sess: null, expired: false };
  if (sess.expiresAt && Date.now() > sess.expiresAt) return { sess, expired: true };
  return { sess, expired: false };
}

async function wizbuySave(userId, sess, deps = {}) {
  const set = deps.set ?? ((k, v) => setConfig(k, v));
  await set(wizbuyKey(userId), JSON.stringify(sess)).catch(() => {});
}

async function wizbuyClear(userId, deps = {}) {
  const set = deps.set ?? ((k, v) => setConfig(k, v));
  await set(wizbuyKey(userId), '').catch(() => {});
}

// ── /wizbuy gate (Rowdy's call 2026-10-26, until WW3) ─────────────────────
// The wizard is closed while gated. FAIL-CLOSED by construction: only an
// explicit off value ('0'/'false'/'off'/'no') ungates. Unset, empty,
// garbage, or a read error all gate. Lifting is a separate explicit step
// (owner /setkey WIZBUY_GATED 0 after WW3 is proven) — no code path in
// this tree writes 'wizbuy_gated', so nothing auto-ungates, not a watcher
// success, not WW3 itself. The key is registered in config.js's boolean
// registry so /setkey normalizes the typed name to this canonical key.
export const WIZBUY_GATE_TEXT = '🛒 Purchases through the wizard are paused right now. Buy on the website instead — run /buy for the credit packs and the checkout link.';
export async function isWizbuyGated(deps = {}) {
  try {
    const get = deps.getConfig ?? deps.get ?? getConfig;
    const v = await get('wizbuy_gated', null);
    const s = String(v ?? '').trim().toLowerCase();
    if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
    return true;
  } catch { return true; }
}

// PRICING WAVE: the only products offered to a NEW buyer. Single source
// for the keyboard filter (wizbuyProductKeyboard) and for tests.
export const WIZBUY_NEW_SALE_KEYS = [
  'tier:one:monthly', 'tier:one:annual', 'pack:500', 'pack:2000', 'pack:5000',
];
function wizbuyProductKeyboard() {
  const rows = [];
  // PRICING WAVE: new sales only — the PB Plan + credit packs. Legacy
  // tier and Ad Creator SKUs stay in WIZBUY_PRODUCTS for lookups but
  // are never offered to a new buyer.
  const keys = WIZBUY_NEW_SALE_KEYS.filter((k) => WIZBUY_PRODUCTS[k]);
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((k) => ({ text: WIZBUY_PRODUCTS[k].label, callback_data: `wizbuy:product:${k}` })));
  }
  rows.push([{ text: '❌ Cancel', callback_data: 'wizbuy:cancel' }]);
  return rows;
}

function wizbuyRailKeyboard() {
  return [
    ...Object.keys(WIZBUY_RAILS).map((k) => [{ text: WIZBUY_RAILS[k].label, callback_data: `wizbuy:rail:${k}` }]),
    [{ text: '❌ Cancel', callback_data: 'wizbuy:cancel' }],
  ];
}

// Stars-aware rail keyboard (2026-11-01, workspace only): when the
// Stars lane is OFF this returns exactly wizbuyRailKeyboard() — no
// row, no text change, no behavior change. When ON it adds one row,
// '⭐ Pay with Telegram Stars', handled by the rail:stars branch below.
export async function starsWizbuyRailKeyboard(deps = {}) {
  const rows = wizbuyRailKeyboard();
  if (!(await isStarsLaneEnabled(deps))) return rows;
  const cancel = rows.pop();
  rows.push([{ text: '⭐ Pay with Telegram Stars', callback_data: 'wizbuy:rail:stars' }]);
  rows.push(cancel);
  return rows;
}

export async function startBuyWizard(userId, deps = {}) {
  const send = deps.send ?? wizSend;
  if (await isWizbuyGated(deps)) {
    await send(userId, WIZBUY_GATE_TEXT);
    return false;
  }
  const sess = { step: 'product', data: {}, expiresAt: Date.now() + 24 * 3600 * 1000 };
  await wizbuySave(userId, sess, deps);
  await send(userId,
    '🛒 *Buy with PB — transfer checkout*\n\nPick a product. Prices are the live site prices; you pay on the site checkout, then come back here with the receipt details and PB hands them to the payment watcher. If you gave your Telegram id at checkout, the grant lands on its own; otherwise PB will point you at the claim step.',
    wizbuyProductKeyboard());
  return true;
}

/** DM text capture for /wizbuy. Returns true when consumed. */
export async function handleBuyWizardText(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const send = deps.send ?? wizSend;
  const { sess, expired } = await wizbuyLoad(userId, deps);
  if (!sess) return false;
  // Gate (until WW3): an armed session must not advance while gated.
  // Checked BEFORE the expired branch so a gated user never gets "run
  // /wizbuy to start again" (false while gated). The session is left
  // intact — the gate refuses, it does not delete; a later explicit
  // lift resumes unexpired sessions normally.
  if (await isWizbuyGated(deps)) {
    await send(userId, WIZBUY_GATE_TEXT);
    return true;
  }
  if (expired) {
    await wizbuyClear(userId, deps);
    await send(userId, '⏰ That purchase session expired — run /wizbuy to start again. Nothing was submitted.');
    return true;
  }
  if (sess.step === 'checkout') {
    if (!WIZBUY_UUID_RE.test(text)) {
      await send(userId, '⚠️ That doesn\u2019t look like a checkout id — paste the full id from your site receipt page (the long code with dashes).');
      return true;
    }
    sess.data.checkoutId = text;
    sess.step = 'txhash';
    await wizbuySave(userId, sess, deps);
    await send(userId, '✅ Checkout saved. Now paste the transaction hash of the transfer you sent (the on-chain tx hash, not the checkout id).');
    return true;
  }
  if (sess.step === 'txhash') {
    if (!WIZBUY_TX_RE.test(text)) {
      await send(userId, '⚠️ That doesn\u2019t look like a transaction hash — paste the full on-chain tx hash from your wallet or explorer.');
      return true;
    }
    sess.data.txHash = text;
    sess.step = 'payer';
    await wizbuySave(userId, sess, deps);
    await send(userId, '✅ Transaction saved. Last one: paste the wallet address you sent FROM (the declared sending wallet — the watcher refuses a claim with no declared sender).');
    return true;
  }
  if (sess.step === 'payer') {
    const rail = WIZBUY_RAILS[sess.data.rail];
    const re = rail ? WIZBUY_PAYER_RE[rail.chain] : null;
    if (!re || !re.test(text)) {
      await send(userId, `⚠️ That doesn\u2019t look like a ${rail ? rail.chain : ''} wallet address — send it again, exactly as your wallet shows it.`);
      return true;
    }
    sess.data.payerAddress = text;
    sess.step = 'confirm';
    await wizbuySave(userId, sess, deps);
    const prod = WIZBUY_PRODUCTS[sess.data.product];
    const solNote = wizbuySolWarnings(rail.chain, rail.token);
    await send(userId,
      `📋 *Check before PB submits*\n\nProduct: ${prod ? prod.label : sess.data.product}\nRail: ${rail.label}\nCheckout: \`${sess.data.checkoutId}\`\nTx: \`${sess.data.txHash}\`\nFrom: \`${sess.data.payerAddress}\`\n\nPB submits this to the payment watcher. The watcher verifies on-chain (right tx, right destination, right sender, right amount) — a mismatch is rejected and nothing is granted.${solNote}`,
      [[{ text: '✅ Submit to watcher', callback_data: 'wizbuy:confirm' }], [{ text: '❌ Cancel', callback_data: 'wizbuy:cancel' }]]);
    return true;
  }
  return false;
}

// SOL-only wizbuy warnings (native SOL payments wave, 2026-10-28): static
// copy, no address interpolated — the checkout is the source of truth for
// the destination address, by the existing wizbuy design. Other rails get
// '' so their copy is byte-identical.
function wizbuySolWarnings(chain, token) {
  if (chain !== 'solana' || token !== 'SOL') return '';

  return `

⚠️ SOL rules — read before you send: send native SOL on Solana only, to exactly the address the checkout shows, from one wallet. Do not send wrapped SOL, do not send from an exchange withdrawal that changes the sender, and never send SOL to a Base (0x…) address — SOL sent to a Base address is not recoverable by PB. Pay the exact SOL amount shown. Paying less grants nothing. Paying more than 10% over grants nothing and PB cannot refund the excess — there is no SOL send path. Your SOL amount is fixed at checkout even if the SOL price moves; the claim window ends at the expiry shown, and a payment claimed after that grants nothing.`;
}

async function wizbuySubmitClaim(sess, deps = {}) {
  const submit = deps.claimSubmit ?? (async (body) => {
    const prod = WIZBUY_PRODUCTS[sess.data.product];
    const base = await getWorkerBase();
    const res = await fetch(`${base}/api/${prod.kind}-checkouts/${sess.data.checkoutId}/watcher-claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chain: sess.data.railChain, token: sess.data.railToken,
        txHash: sess.data.txHash, payerAddress: sess.data.payerAddress,
      }),
    }).catch(() => null);
    if (!res) return { ok: false, error: 'network' };
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: (data && data.error) || `HTTP ${res.status}`, httpStatus: res.status };
    return { ok: true, claim: data?.claim ?? null };
  });
  return submit({
    checkoutId: sess.data.checkoutId, chain: sess.data.railChain, token: sess.data.railToken,
    txHash: sess.data.txHash, payerAddress: sess.data.payerAddress,
  });
}

/** Button router for `wizbuy:*` callbacks. Caller answers the query. */
export async function handleBuyWizardCallback(query, deps = {}) {
  const userId = query.from?.id;
  const data = String(query.data ?? '');
  if (!userId) return null;
  const send = deps.send ?? wizSend;
  const sub = data.slice('wizbuy:'.length);
  if (sub === 'cancel') {
    await wizbuyClear(userId, deps);
    await send(userId, '❌ Purchase cancelled — nothing was submitted.');
    return { text: 'Purchase cancelled.' };
  }
  // Gate (until WW3): no claim step completes while gated. Cancel above
  // stays allowed deliberately — it clears the session and submits
  // nothing, so it can never complete a claim; refusing it would only
  // strand stale sessions. Every other button refuses here, before any
  // session load or step advance.
  if (await isWizbuyGated(deps)) {
    await send(userId, WIZBUY_GATE_TEXT);
    return { text: 'Purchases are paused — see /buy.', alert: true };
  }
  const { sess, expired } = await wizbuyLoad(userId, deps);
  if (!sess) return { text: 'Run /wizbuy to start a purchase.', alert: true };
  if (expired) {
    await wizbuyClear(userId, deps);
    await send(userId, '⏰ That purchase session expired — run /wizbuy to start again. Nothing was submitted.');
    return { text: 'Session expired.' };
  }
  if (sub.startsWith('product:')) {
    if (sess.step !== 'product') return { text: 'Out of order — follow the prompts.', alert: true };
    const key = sub.slice('product:'.length);
    const prod = WIZBUY_PRODUCTS[key];
    if (!prod) return { text: 'Unknown product — pick again.', alert: true };
    // ADVERSARIAL REVIEW (2026-11-01): the keyboard offers new sales
    // only, but the handler used to accept ANY defined SKU — a stale
    // pre-push keyboard (or a crafted callback) could still buy a
    // retired tier or Ad Creator. Reject retired SKUs here, not just
    // in the keyboard, so the new-sale rule holds even with a stale
    // keyboard. Grandfathered holders keep their terms; they cannot
    // re-buy a retired tier.
    if (!WIZBUY_NEW_SALE_KEYS.includes(key)) {
      await send(userId, 'That plan is no longer sold — the PB Plan ($29/mo, $290/yr) is the current plan. Run /upgrade to see it.');
      return { text: 'That plan is no longer sold.', alert: true };
    }
    // PRICING WAVE: no pack stacking during an active trial — trial
    // credits cover renders for now, and packs wait until the trial
    // ends. (Website pack claims cannot be refused this way: money
    // already paid must still grant. The wizard is the enforceable
    // half; see the wave plan.)
    if (key.startsWith('pack:')) {
      const wt = await weekTrialStatus(userId).catch(() => ({ active: false, endsAt: 0 }));
      if (wt.active) {
        const endLabel = wt.endsAt ? new Date(wt.endsAt).toISOString().slice(0, 10) : 'trial end';
        await send(userId, `⏳ Packs wait until your trial ends (${endLabel}) — your 7-day trial credits cover renders for now. Come back after the trial and the packs will be right here.`);
        return { text: 'Packs wait until the trial ends.', alert: true };
      }
    }
    sess.data.product = key;
    sess.expiresAt = Date.now() + prod.windowDays * 24 * 3600 * 1000;
    sess.step = 'rail';
    await wizbuySave(userId, sess, deps);
    const starsOn = await isStarsLaneEnabled(deps);
    await send(userId,
      `✅ ${prod.label} picked.\n\nNow pick how you will pay. Then open the site checkout and pay the exact amount shown there — the watcher only accepts the exact recorded amount, from the wallet you declare, to the address the checkout shows. PB never shows you a receiving address here, because the checkout is the source of truth for it.${starsOn ? '\n\nOr pay with Telegram Stars — PB sends you a Stars invoice right here, no site checkout needed.' : ''}`,
      await starsWizbuyRailKeyboard(deps));
    return { text: '✅ Product picked.' };
  }
  // Stars rail (2026-11-01, workspace only): creates a snapshotted
  // Stars order for the picked product and sends the Stars invoice.
  // The session parks at stars_pending; the grant lands only from a
  // validated successful_payment, never from this button alone.
  if (sub === 'rail:stars') {
    if (sess.step !== 'rail') return { text: 'Out of order — follow the prompts.', alert: true };
    if (!(await isStarsLaneEnabled(deps))) return { text: 'Stars payments are not available right now.', alert: true };
    const starsProductId = ({ 'tier:one:monthly': 'sub_one_m', 'tier:one:annual': 'sub_one_a', 'pack:500': 'studio_credits_500', 'pack:2000': 'studio_credits_2000', 'pack:5000': 'studio_credits_5000' })[sess.data.product];
    if (!starsProductId) return { text: 'That product is not sold with Stars — pick again.', alert: true };
    const created = await createStarsOrder(userId, starsProductId, deps);
    if (!created.ok) {
      await send(userId, 'Stars payments are not available right now — nothing was charged. Try the transfer checkout instead.');
      return { text: 'Stars order could not be created.', alert: true };
    }
    const sent = await sendStarsInvoice(userId, created.order, deps);
    if (!sent.ok) {
      await send(userId, 'The Stars invoice did not go through — nothing was charged. Try again, or use the transfer checkout.');
      return { text: 'Stars invoice failed.', alert: true };
    }
    sess.data.starsOrderId = created.order.id;
    sess.data.starsProduct = starsProductId;
    sess.step = 'stars_pending';
    await wizbuySave(userId, sess, deps);
    await send(userId, `⭐ Stars invoice sent for ${created.entry.title} — ${created.entry.stars} Stars. Pay it in Telegram to complete the purchase. ${STARS_FINE_PRINT} No subscription auto-renewal: this buys one fixed term, and renewal is a fresh purchase.`);
    return { text: '⭐ Stars invoice sent.' };
  }
  if (sub.startsWith('rail:')) {
    if (sess.step !== 'rail') return { text: 'Out of order — follow the prompts.', alert: true };
    const rail = WIZBUY_RAILS[sub.slice('rail:'.length)];
    if (!rail) return { text: 'Unknown payment rail — pick again.', alert: true };
    sess.data.rail = sub.slice('rail:'.length);
    sess.data.railChain = rail.chain;
    sess.data.railToken = rail.token;
    sess.step = 'checkout';
    await wizbuySave(userId, sess, deps);
    const prod = WIZBUY_PRODUCTS[sess.data.product];
    const solNote = wizbuySolWarnings(rail.chain, rail.token);
    await send(userId,
      `✅ Paying by ${rail.label}.\n\n1. Open ${wizbuyCheckoutUrl(sess.data.product)} and create the checkout for ${prod ? prod.label : sess.data.product} (pay by transfer).\n2. Transfer the exact amount the checkout shows, from ONE wallet.\n3. Paste the checkout id here (from your receipt page).${solNote}`);
    return { text: '✅ Rail picked.' };
  }
  if (sub === 'confirm') {
    if (sess.step !== 'confirm') return { text: 'Out of order — follow the prompts.', alert: true };
    const res = await wizbuySubmitClaim(sess, deps);
    await wizbuyClear(userId, deps);
    if (!res?.ok) {
      if (res?.error === 'watcher_disabled' || res?.httpStatus === 403) {
        await send(userId, '⚠️ The transfer rail is off right now — the watcher isn\u2019t armed. Your transfer was NOT submitted. Wait for the watcher to be armed and run /wizbuy again.');
      } else {
        await send(userId, `❌ The watcher claim did not go through (${res?.error ?? 'unknown'}). Nothing was granted. Check the checkout id, tx hash, and sending wallet, then run /wizbuy again.`);
      }
      return { text: 'Claim not submitted.' };
    }
    await send(userId, '✅ Submitted to the payment watcher. It verifies on-chain and the grant lands through the normal settle path (or the claim step, if you didn\u2019t give your Telegram id at checkout). Watcher verdicts arrive within a couple of clock passes; a rejection tells you the exact reason and grants nothing.');
    return { text: '✅ Submitted to watcher.' };
  }
  return null;
}

// ── In-bot PB Plan purchase (planbuy wave, 2026-11-03) ─────────────────────
// The trial user already has the bot: they buy the Plan in DM without
// leaving Telegram. Shape mirrors wizbuy's session pattern (config-table
// JSON session, text capture, callback router) but is a SEPARATE,
// ungated flow: it never reads wizbuy_gated and never touches wizbuy
// sessions. Prices are never typed here: the worker's create response is
// the source of truth for address + amount + expiry.
// Flow: period pick -> bot creates a PB Invoice checkout (public POST,
// telegramUserId attached) -> pay screen (worker-returned Base USDC
// address + exact amount + expiry) -> user pays -> pastes tx hash ->
// pastes sending wallet -> confirm -> signed /api/internal/watcher/file
// -> tick verifier confirms on-chain -> settle auto-grants tier 'one'
// -> user checks status (signed claimLookup) for the grant.

const PLANBUY_PERIODS = {
  monthly: { label: 'PB Plan — $29/mo', billingPeriod: 'monthly' },
  annual: { label: 'PB Plan — $290/yr', billingPeriod: 'annual' },
};
const PLANBUY_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const PLANBUY_PAYER_RE = /^0x[0-9a-fA-F]{40}$/;
const planbuyKey = (userId) => `planbuy:${userId}`;

async function planbuyLoad(userId, deps = {}) {
  const get = deps.get ?? ((k) => getConfig(k, null));
  const raw = await get(planbuyKey(userId)).catch(() => null);
  if (!raw) return { sess: null, expired: false };
  let sess = null;
  try { sess = JSON.parse(raw); } catch { sess = null; }
  if (!sess) return { sess: null, expired: false };
  if (sess.expiresAt && Date.now() > sess.expiresAt) return { sess, expired: true };
  return { sess, expired: false };
}

async function planbuySave(userId, sess, deps = {}) {
  const set = deps.set ?? ((k, v) => setConfig(k, v));
  await set(planbuyKey(userId), JSON.stringify(sess)).catch(() => {});
}

async function planbuyClear(userId, deps = {}) {
  const set = deps.set ?? ((k, v) => setConfig(k, v));
  await set(planbuyKey(userId), '').catch(() => {});
}

export function planbuyPayScreen(sess) {
  const d = sess.data;
  return {
    text: `💳 ${d.periodLabel}\n\nSend the EXACT amount below to the address shown, from ONE wallet. The watcher verifies on-chain (right tx, right destination, right sender, right amount) — a mismatch grants nothing.\n\nPay to (Base USDC):\n\`${d.receiveAddress}\`\n\nAmount: ${d.amountDisplay} USDC\nPay before: ${d.expiresAt ?? 'the expiry shown at checkout'}\n\nAfter you send, tap ✅ I have paid and paste your transaction hash.`,
    keyboard: [[{ text: '✅ I have paid', callback_data: 'planbuy:paid' }], [{ text: '🔍 Check status', callback_data: 'planbuy:status' }], [{ text: '❌ Cancel', callback_data: 'planbuy:cancel' }]],
  };
}

export async function planbuyCreateCheckout(userId, period, deps = {}) {
  const prod = PLANBUY_PERIODS[period];
  if (!prod) return { ok: false, error: 'unknown_period' };
  const doFetch = deps.fetch ?? fetch;
  const base = await getWorkerBase();
  const res = await doFetch(`${base}/api/subscription-checkouts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier: 'one', billingPeriod: prod.billingPeriod, currency: 'USDC', payMethod: 'transfer', telegramUserId: Number(userId) }),
  }).catch(() => null);
  if (!res) return { ok: false, error: 'network' };
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: (data && data.error) || `HTTP ${res.status}`, httpStatus: res.status };
  const opts = Array.isArray(data?.transfer?.options) ? data.transfer.options : [];
  const opt = opts.find((o) => o.chain === 'base' && o.token === 'USDC');
  if (!opt?.receiveAddress || !opt?.amountDisplay) return { ok: false, error: 'transfer_unavailable' };
  return { ok: true, checkoutId: data.id, receiveAddress: opt.receiveAddress, amountDisplay: opt.amountDisplay, expiresAt: data.transfer?.claimBy ?? data.expiresAt ?? null };
}

export function planbuyFileBody(sess, userId) {
  return {
    checkout_id: sess.data.checkoutId,
    telegram_user_id: Number(userId),
    chain: 'base',
    token: 'USDC',
    tx_hash: sess.data.txHash,
    payer_address: sess.data.payerAddress,
  };
}

export async function planbuyFileClaim(sess, userId, deps = {}) {
  const secret = deps.secret ?? (await getConfig('PB_WEB_SYNC_SECRET', ''));
  if (!secret) return { ok: false, error: 'no_sync_secret' };
  return signedPost(secret, '/api/internal/watcher/file', planbuyFileBody(sess, userId));
}

/** Button router for `planbuy:*` callbacks. Caller answers the query. */
export async function handlePlanbuyCallback(query, deps = {}) {
  const userId = query.from?.id;
  const data = String(query.data ?? '');
  if (!userId) return null;
  const send = deps.send ?? wizSend;
  const sub = data.slice('planbuy:'.length);
  if (sub === 'cancel') {
    await planbuyClear(userId, deps);
    await send(userId, '❌ Plan purchase cancelled — nothing was submitted.');
    return { text: 'Purchase cancelled.' };
  }
  if (sub === 'period:monthly' || sub === 'period:annual') {
    const period = sub.slice('period:'.length);
    const create = deps.createCheckout ?? planbuyCreateCheckout;
    const res = await create(userId, period, deps);
    if (!res?.ok) {
      if (res?.httpStatus === 429) {
        await send(userId, '⏳ Too many checkout attempts — wait a little and try again. Nothing was created.');
      } else if (res?.error === 'watcher_disabled' || res?.httpStatus === 503) {
        await send(userId, '⚠️ Transfer payments are off right now — the watcher is not armed. Nothing was created; try again later.');
      } else {
        await send(userId, `❌ Could not start the checkout (${res?.error ?? 'unknown'}). Nothing was charged. Try again.`);
      }
      return { text: 'Checkout failed.' };
    }
    const sess = { step: 'pay', expiresAt: Date.now() + 24 * 3600 * 1000, data: { period, periodLabel: PLANBUY_PERIODS[period].label, checkoutId: res.checkoutId, receiveAddress: res.receiveAddress, amountDisplay: res.amountDisplay, expiresAt: res.expiresAt } };
    await planbuySave(userId, sess, deps);
    const screen = planbuyPayScreen(sess);
    await send(userId, screen.text, screen.keyboard);
    return { text: '✅ Checkout created.' };
  }
  const { sess, expired } = await planbuyLoad(userId, deps);
  if (!sess) return { text: 'Run /upgrade to start a Plan purchase.', alert: true };
  if (expired) {
    await planbuyClear(userId, deps);
    await send(userId, '⏰ That purchase session expired — run /upgrade to start again. Nothing was submitted.');
    return { text: 'Session expired.' };
  }
  if (sub === 'paid') {
    if (sess.step !== 'pay') return { text: 'Out of order — follow the prompts.', alert: true };
    sess.step = 'txhash';
    await planbuySave(userId, sess, deps);
    await send(userId, '✅ Got it. Paste the transaction hash of the transfer you sent (the on-chain tx hash from your wallet or explorer).');
    return { text: '✅ Awaiting tx hash.' };
  }
  if (sub === 'status') {
    const lookup = deps.claimLookup ?? (async (id) => {
      const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
      if (!secret) return { error: 'no_sync_secret' };
      return claimLookup(secret, id);
    });
    const st = await lookup(sess.data.checkoutId).catch(() => ({ error: 'lookup_failed' }));
    if (!st || st.error || st.ok === false) {
      await send(userId, `🔍 Status check failed (${st?.error ?? 'unknown'}). Your checkout is still open — try again in a bit.`);
      return { text: 'Status check failed.' };
    }
    if (st.status === 'claimed') {
      await send(userId, `✅ PB Plan active — ${(st.grant && st.grant.tier) || 'one'}${st.grant && st.grant.expires_at ? ` until ${String(st.grant.expires_at).slice(0, 10)}` : ''}. If the bot still shows the old tier, it refreshes on the next clock pass.`);
      await planbuyClear(userId, deps);
      return { text: '✅ Plan active.' };
    }
    await send(userId, `🔍 Checkout status: ${st.status ?? 'unknown'}. The watcher verifies on-chain (a couple of clock passes); tap 🔍 Check status again in a few minutes.`);
    return { text: 'Status checked.' };
  }
  if (sub === 'confirm') {
    if (sess.step !== 'confirm') return { text: 'Out of order — follow the prompts.', alert: true };
    const file = deps.fileClaim ?? planbuyFileClaim;
    const res = await file(sess, userId, deps);
    if (!res?.ok) {
      await send(userId, `❌ The watcher filing did not go through (${res?.error ?? 'unknown'}). Nothing was granted. Check the tx hash and sending wallet, then run /upgrade again.`);
      await planbuyClear(userId, deps);
      return { text: 'Filing failed.' };
    }
    sess.step = 'submitted';
    await planbuySave(userId, sess, deps);
    await send(userId, '✅ Submitted to the payment watcher. It verifies on-chain and the Plan grants automatically once confirmed (a couple of clock passes). Tap 🔍 Check status below to see the grant land.', [[{ text: '🔍 Check status', callback_data: 'planbuy:status' }], [{ text: '❌ Cancel', callback_data: 'planbuy:cancel' }]]);
    return { text: '✅ Submitted to watcher.' };
  }
  return null;
}

/** Text capture for the planbuy wizard (tx hash, then sending wallet). */
export async function handlePlanbuyText(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const send = deps.send ?? wizSend;
  const { sess, expired } = await planbuyLoad(userId, deps);
  if (!sess) return false;
  if (expired) {
    await planbuyClear(userId, deps);
    await send(userId, '⏰ That purchase session expired — run /upgrade to start again. Nothing was submitted.');
    return true;
  }
  if (sess.step === 'txhash') {
    if (!PLANBUY_TX_RE.test(text)) {
      await send(userId, '⚠️ That does not look like a Base transaction hash — paste the full 0x hash (64 hex chars).');
      return true;
    }
    sess.data.txHash = text;
    sess.step = 'payer';
    await planbuySave(userId, sess, deps);
    await send(userId, '✅ Transaction saved. Last one: paste the wallet address you sent FROM (the watcher refuses a claim with no declared sender).');
    return true;
  }
  if (sess.step === 'payer') {
    if (!PLANBUY_PAYER_RE.test(text)) {
      await send(userId, '⚠️ That does not look like a Base wallet address — send it again, exactly as your wallet shows it.');
      return true;
    }
    sess.data.payerAddress = text;
    sess.step = 'confirm';
    await planbuySave(userId, sess, deps);
    await send(userId,
      `📋 Check before PB submits\n\nProduct: ${sess.data.periodLabel}\nPay to: \`${sess.data.receiveAddress}\`\nAmount: ${sess.data.amountDisplay} USDC\nTx: \`${sess.data.txHash}\`\nFrom: \`${sess.data.payerAddress}\`\n\nPB submits this to the payment watcher. The watcher verifies on-chain (right tx, right destination, right sender, right amount) — a mismatch is rejected and nothing is granted.`,
      [[{ text: '✅ Submit to watcher', callback_data: 'planbuy:confirm' }], [{ text: '❌ Cancel', callback_data: 'planbuy:cancel' }]]);
    return true;
  }
  return false;
}

export const WIZBUY_COMMANDS = {
  wizbuy: async (chatId, _args, msg) => {
    const target = msg?.chat?.type === 'private' ? chatId : null;
    if (!target) {
      await wizSend(msg.from.id, '🛒 Run /wizbuy in a DM with me — purchases are private.');
      return;
    }
    await startBuyWizard(msg.from.id);
  },
};

// ── Subscription lifecycle comms (Rowdy 2026-10-27; copy approved) ───────
// Stages: 0R receipt (watcher-confirmed purchase) → 0 welcome (tier
// purchase AND bot signup) → 1 warnings (5-day + T-1) → 2 lapse notice
// → 3 restore note. Copy source of truth: the approved deck
// (goal files/PB-LIFECYCLE-COPY-DECK-2026-10-27.md); wording below
// follows it, with three recorded deviations:
//   DEV-1: grant points carry no tx hash and no chain, so the receipt
//     shows a Basescan link ONLY when a tx is threaded through
//     (optional param, none today) and otherwise reads "by crypto
//     transfer" with the receipt # as the proof key — never an
//     invented chain or link. Worker claim/outbox must carry tx_hash
//     for full proof (named gap, not a blocker: receipts stay correct).
//   DEV-2: spec said T-7 warnings; the wave brief says 5-day + T-1,
//     and 5-day matches the existing cycle — brief wins.
//   DEV-3: welcome vs restore overlap (deck silent): receipt always;
//     then restore INSTEAD of welcome when the member previously
//     lapsed (ever_lapsed marker, cleared on restore).
// HARD GATE: every NEW send below is behind `lifecycle_comms_enabled`
// (default OFF, tolerant getConfigFlag reader). Flag OFF = exactly
// today's behavior: the existing text-only 5-day DM still sends, and
// nothing new goes out. This wave NEVER flips the flag and NEVER
// sends anything live — the flip is Rowdy's separate send-go tap.
// EMAIL TRANSPORT GAP (named, not a blocker): the bot has no
// member-email SEND endpoint today (bridge-subscribe handles
// subscribe/status/unsubscribe only; the bot keeps no email store).
// Email attempts go to the Worker bridge-send action and FAIL CLOSED
// on any non-ok result: logged, email marker left unset (retry next
// tick), DM unaffected. Until the Worker implements bridge-send,
// emails cannot leave and DMs carry every message.
// GUARDS: idempotency markers per stage (config rows, no schema
// change — the app is at the 100-module cap and push never migrates);
// purchase sources only (isPurchaseSource re-checked here, defense in
// depth); email only from bridge status (found + not unsubscribed);
// every send try/catch + log-only, never wedging a grant or a cycle.

export const LIFECYCLE_FLAG = 'lifecycle_comms_enabled';

export async function lifecycleEnabled(deps = {}) {
  try {
    const get = deps.getConfig ?? getConfigFlag;
    return await get(LIFECYCLE_FLAG);
  } catch { return false; }
}

// Exact tier lines from the live /upgrade plans message — never reworded.
// PRICING WAVE (2026-10-31): legacy lines PRESERVED for grandfathered
// lifecycle mail (those users keep their terms); 'one'/'trial' lines
// added for the new plan. The plans panel itself was rewritten to one
// price in this wave — these lines match it for new buyers.
export const LIFECYCLE_TIER_LINES = {
  starter: '🌱 Starter — $10/mo: essential one-group toolkit',
  builder: '💼 Builder — $23/mo: 3 campaigns, FUD Shield, alerts, $20 Custom List credit',
  pro: '⚡ Pro — $63/mo: 10 campaigns, 1,200 Studio credits, 1 Army Drop OR $40 credit',
  agency: '🏢 Agency — $130/mo: unlimited campaigns, 2,500 credits, priority support',
  one: '⭐ PB Plan — $29/mo: everything unlocked, Ad Creator included',
  trial: '🎁 Trial — 7 days free, 100 trial credits',
};

export const LIFECYCLE_RESUBSCRIBE_KEYBOARD = [[{ text: '🔁 Resubscribe', callback_data: 'menu:upgrade:plans' }]];
const LIFECYCLE_PLANS_KEYBOARD = [[{ text: '📋 See my tier', callback_data: 'menu:upgrade:plans' }]];

const lcKey = (stage, tgId, scope) => `lifecycle:${stage}:${tgId}:${scope}`;
const lcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const lcMs = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};
// Receipt # display: checkout UUIDs → first 8; short ids as-is; long ids → last 8.
function lcReceiptShort(receiptId) {
  const raw = String(receiptId ?? '').split(':').pop() ?? '';
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$/.test(raw)) return raw.slice(0, 8);
  if (raw.length <= 12) return raw;
  return raw.slice(-8);
}
function lcAmount(amountUsd) {
  return typeof amountUsd === 'number' && Number.isFinite(amountUsd) ? `$${amountUsd}` : null;
}
function lcTermLabel(p, nowMs) {
  if (p.term === 'one-time') return 'one-time purchase';
  const endMs = p.termEndMs ?? lcMs(p.expiresAt);
  if (endMs) return `${lcDate(nowMs)} – ${lcDate(endMs)}`;
  return null;
}

// ── Copy builders (pure — the deck's wording, parameterized) ──────────────
export function lifecycleReceiptDM(p) {
  const lines = [`🧾 Receipt — ${p.label} — ${p.amount ? `${p.amount} paid` : 'paid'} ${p.dateLabel}.`];
  if (p.termLabel) lines.push(`Term: ${p.termLabel}. Receipt #${p.receiptShort}.`);
  else lines.push(`Receipt #${p.receiptShort}.`);
  lines.push(p.txUrl ? `Proof: ${p.txUrl}` : `Proof: receipt #${p.receiptShort}`);
  lines.push('(Nothing auto-renews — buy again when the term ends.)');
  return lines.join('\n');
}
export function lifecycleReceiptEmail(p) {
  const amountLine = p.amount ? `${p.amount} — Paid on ${p.dateLabel} by crypto transfer` : `Paid on ${p.dateLabel} by crypto transfer`;
  const termLine = p.termLabel ? `Term: ${p.termLabel}` : 'Term: one-time purchase';
  return {
    subject: `Your PoorBoyAI receipt — ${p.label}${p.amount ? ` ${p.amount}` : ''}`,
    body: [
      'Receipt from PoorBoyAI', '',
      amountLine, '',
      `Receipt #${p.receiptShort}`,
      termLine, '',
      `${p.label} — Qty 1${p.amount ? ` — ${p.amount}` : ''}`, '',
      ...(p.amount ? [`Total: ${p.amount}`, `Amount paid: ${p.amount}`, ''] : []),
      p.txUrl ? `Transaction (public proof): ${p.txUrl}` : `Proof: receipt #${p.receiptShort}`,
      'No card, no PDF — the on-chain transfer IS the receipt.', '',
      'Questions? Ask PB with /support.',
      '— The PoorBoyAI team',
    ].join('\n'),
  };
}
export function lifecycleWelcomeDM(p) {
  return [
    '🎉 Welcome to the Poor Boy AI family — thank you for backing PB.',
    `Your ${p.tierLabel} is live${p.expiresLabel ? ` until ${p.expiresLabel}` : ''}.`,
    '',
    `What you got: ${p.tierLine}.`,
    'PB\'s powers, now yours: /ask · /price · /scan · /raid · /generate · /create — full list in /help.',
    '',
    'Nothing auto-renews — we\'ll warn you before your term ends.',
  ].join('\n');
}
export function lifecycleWelcomeEmail(p) {
  return {
    subject: `Welcome to the Poor Boy AI family — your ${p.tierLabel} is live`,
    body: [
      'Hi,', '',
      'Welcome to the Poor Boy AI family. Thank you for backing PB — you\'re one of the people keeping this thing alive, and we\'re glad you\'re here.',
      '',
      `What you got: ${p.tierLabel}${p.expiresLabel ? `, live until ${p.expiresLabel}` : ''}.`,
      '',
      'What comes with it:',
      p.tierLine,
      '',
      'The powers of PB, now yours:',
      '- Ask PB anything — /ask, /generate, /meme, /pfp, /idea',
      '- Markets — /price, /scan, /ta, /chart, /alert, /portfolio',
      '- Raids & XP — /raid, /squad, /points, leaderboards',
      '- Community posts — /gm, /bullpost, /moonpost, /callout',
      '- Studio, podcasts & campaigns — /create, /podcast, /campaign',
      '',
      'First steps: try /ask anything, then /price $PBAI.',
      '',
      'Nothing auto-renews — tiers are one-time crypto purchases; a term simply ends unless you buy again. We\'ll warn you before it ends, and one tap brings it back.',
      '',
      '— The PoorBoyAI team',
    ].join('\n'),
  };
}
export function lifecycleSignupEmail() {
  return {
    subject: 'Welcome to the Poor Boy AI family',
    body: [
      'Hi,', '',
      'Welcome to the Poor Boy AI family. Thank you for joining PB — we\'re glad you\'re here.',
      '',
      'What free gets you: raids and group moderation to start — plus bonus /ask questions when friends join through your invite (+3 per referral).',
      '',
      'The powers of PB at a glance:',
      '- Ask PB anything — /ask, /generate, /meme, /pfp, /idea',
      '- Markets — /price, /scan, /ta, /chart, /alert, /portfolio',
      '- Raids & XP — /raid, /squad, /points, leaderboards',
      '- Community posts — /gm, /bullpost, /moonpost, /callout',
      '- Studio, podcasts & campaigns — /create, /podcast, /campaign',
      '',
      'When you\'re ready for more, /upgrade shows the plans.',
      '',
      '— The PoorBoyAI team',
    ].join('\n'),
  };
}
export function lifecycleWarningEmail(p) {
  return {
    subject: `Action required: your ${p.tierLabel} ends ${p.expiresLabel}`,
    body: [
      'Hi,', '',
      `Your ${p.tierLabel} term ends on ${p.expiresLabel}, and it hasn't been renewed yet. If it lapses, you drop to free: ${p.tierLine} stops, and you keep the free commands.`,
      '',
      'Resubscribe now to keep everything running:',
      '',
      '🔁 Resubscribe → https://poorboyai.pages.dev/buy',
      '',
      'Questions? Reply to this email or ask PB with /support.',
      '— The PoorBoyAI team',
    ].join('\n'),
  };
}
export function lifecycleFinalWarningDM(p) {
  return `⏰ Last day: your ${p.tierLabel} ends tomorrow (${p.expiresLabel}). Resubscribe to keep uninterrupted access.`;
}
export function lifecycleFinalWarningEmail(p) {
  return {
    subject: `Last day: your ${p.tierLabel} ends tomorrow`,
    body: [
      'Hi,', '',
      `Your ${p.tierLabel} term ends tomorrow (${p.expiresLabel}). Resubscribe to keep uninterrupted access:`,
      '',
      '🔁 Resubscribe → https://poorboyai.pages.dev/buy',
      '',
      '— The PoorBoyAI team',
    ].join('\n'),
  };
}
export function lifecycleLapseDM(p) {
  return [
    `Your ${p.tierLabel} term ended on ${p.expiresLabel}, and you're now on free.`,
    `${p.tierLine} is paused. Free still covers raids and group moderation — and any /ask questions you earned through referrals (+3 per referral, +5 welcome) stay yours.`,
    '',
    'To restore everything, resubscribe — one tap, same tier, same price.',
    '',
    "You're still family. Come back whenever you're ready.",
  ].join('\n');
}
export function lifecycleLapseEmail(p) {
  return {
    subject: `PoorBoyAI: your ${p.tierLabel} has ended`,
    body: [
      'Hi,', '',
      `Your ${p.tierLabel} term ended on ${p.expiresLabel}, and you're now on free.`,
      'What that means:',
      `- ${p.tierLine} is paused.`,
      '- Free still covers raids and group moderation, plus any /ask questions you earned through referrals.',
      '',
      'To restore everything, resubscribe — one tap, same tier, same price:',
      '',
      '🔁 Resubscribe → https://poorboyai.pages.dev/buy',
      '',
      "You're still family. Come back whenever you're ready.",
      '— The PoorBoyAI team',
    ].join('\n'),
  };
}
export function lifecycleRestoreDM(p) {
  return `🎉 You're back on ${p.tierLabel} — everything restored. Welcome back to the family.`;
}

// ── Transport: DM (real) + email (address-gated, fail-closed) ─────────────
async function lcDm(tgId, text, extra, deps = {}) {
  const send = deps.send ?? ((args) => api.sendMessage(args));
  try {
    await send({ chat_id: tgId, text, ...(extra ?? {}) });
    return true;
  } catch (err) {
    console.error('[lifecycle:dm] failed:', err?.code ?? err?.message ?? err);
    return false;
  }
}

// Address ONLY from the Worker bridge status (found + not unsubscribed).
// Never logged, never echoed anywhere but the poster payload.
export async function lifecycleResolveEmail(tgId, deps = {}) {
  try {
    const secret = await getConfig('PB_WEB_SYNC_SECRET', '').catch(() => '');
    if (!secret) return { address: null, reason: 'no_secret' };
    const res = await emailBridge(secret, { action: 'status', telegram_id: Number(tgId) }, deps).catch(() => null);
    if (!res || res.error) return { address: null, reason: 'bridge_error' };
    if (!res.found || !res.subscriber) return { address: null, reason: 'no_address' };
    if (res.subscriber.status === 'unsubscribed') return { address: null, reason: 'unsubscribed' };
    const address = String(res.subscriber.email ?? '').trim().toLowerCase();
    if (!address) return { address: null, reason: 'no_address' };
    return { address, reason: 'ok' };
  } catch (err) {
    console.error('[lifecycle:email-resolve] failed:', err?.message ?? err);
    return { address: null, reason: 'error' };
  }
}

// Fail-closed Worker send (see header gap note): any non-ok result logs,
// leaves the caller's email marker unset (retry next tick), never throws,
// never affects the DM that already landed.
export async function lifecycleTryEmail(tgId, subject, body, deps = {}) {
  const { address, reason } = await lifecycleResolveEmail(tgId, deps);
  if (!address) return { sent: false, reason };
  try {
    const secret = await getConfig('PB_WEB_SYNC_SECRET', '').catch(() => '');
    const poster = deps.poster || ((path, b) => signedPost(secret, path, b));
    const res = await poster('/api/email/bridge-send', { action: 'send', telegram_id: Number(tgId), to: address, subject, body });
    if (res && res.ok === true) return { sent: true, reason: 'ok' };
    console.error('[lifecycle:email] transport not ok:', res?.error ?? res?.httpStatus ?? 'unknown');
    return { sent: false, reason: 'transport' };
  } catch (err) {
    console.error('[lifecycle:email] transport failed:', err?.message ?? err);
    return { sent: false, reason: 'transport' };
  }
}

// ── Stage 0R + 0: purchase-time sends (called from the exact ─────────────
// isPurchaseSource branches; re-checks the filter defense-in-depth.
// Best-effort single attempt like pageOwners/announcePurchase: a failed
// DM here is logged, not retried (no re-scan trigger exists for a
// purchase moment); cycle-driven sends retry via unset markers instead.
export async function lifecycleOnPurchase(p, deps = {}) {
  try {
    if (!(await lifecycleEnabled(deps))) return { skipped: 'flag_off' };
    const tgId = String(p?.tgId ?? '').trim();
    if (!tgId) return { skipped: 'no_user' };
    if (!isPurchaseSource(p?.source)) return { skipped: 'not_purchase_source' };
    const label = String(p?.label ?? '').trim();
    if (!label) return { skipped: 'no_label' };
    const receiptId = String(p?.receiptId ?? '').trim();
    if (!receiptId) return { skipped: 'no_receipt' };
    const nowMs = Date.now();
    const amount = lcAmount(p?.amountUsd);
    const termLabel = lcTermLabel(p, nowMs);
    const short = lcReceiptShort(receiptId);
    const common = { label, amount, dateLabel: lcDate(nowMs), termLabel, receiptShort: short, txUrl: p?.txUrl ?? null };
    // Receipt first (DM and email gated on SEPARATE markers, so a
    // failed email retries on a replayed purchase instead of being
    // swallowed by the DM marker).
    const rKey = lcKey('receipt', tgId, receiptId);
    if (!(await getConfig(rKey, ''))) {
      if (await lcDm(tgId, lifecycleReceiptDM(common), undefined, deps)) {
        await setConfig(rKey, String(nowMs)).catch(() => {});
      }
    }
    const reKey = lcKey('receipt_email', tgId, receiptId);
    if (!(await getConfig(reKey, ''))) {
      const em = lifecycleReceiptEmail(common);
      const eRes = await lifecycleTryEmail(tgId, em.subject, em.body, deps);
      if (eRes.sent) await setConfig(reKey, String(nowMs)).catch(() => {});
    }
    // Then exactly one of restore (returner) / welcome (new buyer).
    const tierLabel = p?.tier ? String(p.tier).toUpperCase() : null;
    const tierLine = p?.tier ? (LIFECYCLE_TIER_LINES[String(p.tier).toLowerCase()] ?? null) : null;
    const expiresLabel = p?.expiresAt ? lcDate(lcMs(p.expiresAt)) : (p?.termEndMs ? lcDate(p.termEndMs) : null);
    const everLapsed = await getConfig(`lifecycle:ever_lapsed:${tgId}`, '');
    if (everLapsed && tierLabel) {
      const expScope = p?.expiresAt ? Math.floor(lcMs(p.expiresAt) / 1000) : receiptId;
      const rstKey = lcKey('restored', tgId, expScope);
      if (!(await getConfig(rstKey, ''))) {
        if (await lcDm(tgId, lifecycleRestoreDM({ tierLabel }), undefined, deps)) {
          await setConfig(rstKey, String(nowMs)).catch(() => {});
          await setConfig(`lifecycle:ever_lapsed:${tgId}`, '').catch(() => {});
        }
      }
    } else if (tierLabel && tierLine) {
      const wKey = lcKey('welcome', tgId, receiptId);
      if (!(await getConfig(wKey, ''))) {
        if (await lcDm(tgId, lifecycleWelcomeDM({ tierLabel, tierLine, expiresLabel }), { reply_markup: { inline_keyboard: LIFECYCLE_PLANS_KEYBOARD } }, deps)) {
          await setConfig(wKey, String(nowMs)).catch(() => {});
        }
      }
      const weKey = lcKey('welcome_email', tgId, receiptId);
      if (!(await getConfig(weKey, ''))) {
        const em = lifecycleWelcomeEmail({ tierLabel, tierLine, expiresLabel });
        const eRes = await lifecycleTryEmail(tgId, em.subject, em.body, deps);
        if (eRes.sent) await setConfig(weKey, String(nowMs)).catch(() => {});
      }
    }
    // Packs / Ad Creator get receipt only (no tier welcome applies).
    return { ok: true };
  } catch (err) {
    console.error('[lifecycle:purchase] failed:', err?.message ?? err);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ── Stage 0C: bot-signup email (DM stays the existing /start) ─────────────
// Marker set after the first attempt regardless of outcome: re-querying
// the bridge on every later message would spam the Worker, and later
// /email set subscribers get the Worker-side welcome already promised.
export async function lifecycleOnSignup(tgId, deps = {}) {
  try {
    if (!(await lifecycleEnabled(deps))) return { skipped: 'flag_off' };
    const key = `lifecycle:signedup:${tgId}`;
    if (await getConfig(key, '')) return { skipped: 'already' };
    const em = lifecycleSignupEmail();
    const eRes = await lifecycleTryEmail(tgId, em.subject, em.body, deps);
    await setConfig(key, String(Date.now())).catch(() => {});
    return { ok: true, emailed: eRes.sent, reason: eRes.reason };
  } catch (err) {
    console.error('[lifecycle:signup] failed:', err?.message ?? err);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ── Stage 2: lapse notice (called by the tick's lifecycleLapse cycle) ─────
export async function lifecycleSendLapse(u, deps = {}) {
  const tgId = String(u?.telegramUserId ?? '').trim();
  if (!tgId) return { skipped: 'no_user' };
  const expMs = lcMs(u?.subscriptionExpiresAt);
  if (!expMs) return { skipped: 'no_expiry' };
  const scope = Math.floor(expMs / 1000);
  const key = lcKey('lapsed', tgId, scope);
  if (await getConfig(key, '')) return { skipped: 'already' };
  const tier = String(u?.tier ?? '').toLowerCase();
  const tierLabel = tier.toUpperCase();
  const tierLine = LIFECYCLE_TIER_LINES[tier] ?? tierLabel;
  const p = { tierLabel, tierLine, expiresLabel: lcDate(expMs) };
  if (!(await lcDm(tgId, lifecycleLapseDM(p), { reply_markup: { inline_keyboard: LIFECYCLE_RESUBSCRIBE_KEYBOARD } }, deps))) {
    return { sent: false, reason: 'dm_failed' };
  }
  const em = lifecycleLapseEmail(p);
  const eRes = await lifecycleTryEmail(tgId, em.subject, em.body, deps);
  if (eRes.sent) await setConfig(lcKey('lapsed_email', tgId, scope), String(Date.now())).catch(() => {});
  await setConfig(key, String(Date.now())).catch(() => {});
  await setConfig(`lifecycle:ever_lapsed:${tgId}`, '1').catch(() => {});
  return { sent: true, emailed: eRes.sent };
}

// ── PB Stars lane (2026-11-01, WORKSPACE ONLY — NOT pushed, NOT armed) ───
// Spec: PB-STARS-RESPEC-2026-11-01 §2/§4/§5/§6. Stars only; TON is out.
// This section is ADD-ONLY: it touches no existing function, price, or
// checkout path. Every member-facing Stars string shows Stars counts
// ONLY — never a currency figure, never a conversion, never an
// approximation sign. USD lives only in the order snapshot (a stored
// number, never rendered to a member) and in owner-side pages.
// Flags ship OFF: wizard_enabled (master) + wizard_stars_enabled (lane).
// With either OFF, no Stars surface renders and /buy, /upgrade, and
// /wizbuy behave exactly as today (the wizbuy rail keyboard below
// returns byte-identical rows when the lane is OFF).
// BLOCKER, recorded not hidden: Telegram routes pre_checkout_query
// updates to a handler file named pre_checkout_query.js, and the tree
// is at its 100-module cap — that file would be module 101. The
// validation logic (answerStarsPreCheckout) is built and harnessed
// here, and its handler file is STAGED in the wave plan directory
// (not in tgcloud/), ready to drop in when a module slot opens by a
// separate, approved consolidation. Until then a Stars invoice cannot
// complete pre-checkout live, so SW1 cannot pass. No module was
// deleted to make room, and none is created by this wave.

export const STARS_PER_USD = 76.93; // Shape B rate, decided 2026-10-23
export const STARS_FINE_PRINT = 'Stars prices include a channel surcharge, which is borne by the buyer.';
export const STARS_PRECHECKOUT_ERROR = 'This invoice is out of date — start again from /buy';
export const STARS_ORDER_TTL_MS = 24 * 3600 * 1000;

// Catalog §2, mapped onto the live site catalog (WIZBUY_PRODUCTS USD
// figures, read at call time — never re-typed here). Stars product ids
// are the lane's own ids; the USD snapshot is stored, never rendered.
const STARS_PRODUCT_MAP = {
  sub_one_m: { wizbuyKey: 'tier:one:monthly', title: 'PoorBoyAI — PB Plan, 30 days', description: 'PB Plan for 30 days, paid with Telegram Stars.', termDays: 30, term: 'monthly' },
  sub_one_a: { wizbuyKey: 'tier:one:annual', title: 'PoorBoyAI — PB Plan, 360 days', description: 'PB Plan for 360 days, paid with Telegram Stars.', termDays: 360, term: 'annual' },
  studio_credits_500: { wizbuyKey: 'pack:500', title: 'PoorBoyAI — Studio credits, 500', description: 'Studio credits, paid with Telegram Stars. About 250 images at 2 credits each, same wallet as bot, site, and MCP ask.', credits: 500 },
  studio_credits_2000: { wizbuyKey: 'pack:2000', title: 'PoorBoyAI — Studio credits, 2000', description: 'Studio credits, paid with Telegram Stars. About 1,000 images at 2 credits each, same wallet as bot, site, and MCP ask.', credits: 2000 },
  studio_credits_5000: { wizbuyKey: 'pack:5000', title: 'PoorBoyAI — Studio credits, 5000', description: 'Studio credits, paid with Telegram Stars. About 2,500 images at 2 credits each, same wallet as bot, site, and MCP ask.', credits: 5000 },
};

export function starsPriceFor(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n * STARS_PER_USD);
}

export function starsCatalogEntry(productId) {
  const m = STARS_PRODUCT_MAP[productId];
  if (!m) return null;
  const sku = WIZBUY_PRODUCTS[m.wizbuyKey];
  if (!sku || !Number.isFinite(Number(sku.amountUsd))) return null;
  const stars = starsPriceFor(sku.amountUsd);
  if (stars == null) return null;
  return { productId, title: m.title, description: m.description, usd: Number(sku.amountUsd), stars, termDays: m.termDays ?? null, term: m.term ?? null, credits: m.credits ?? null };
}

export function starsCatalog() {
  return Object.keys(STARS_PRODUCT_MAP).map((id) => starsCatalogEntry(id)).filter(Boolean);
}

export function starsShelfText() {
  const lines = starsCatalog().map((e) => `• ${e.title} — ${e.stars} Stars`);
  return ['⭐ Pay with Telegram Stars', '', ...lines, '', STARS_FINE_PRINT].join('\n');
}

export async function isStarsLaneEnabled(deps = {}) {
  try {
    const flag = deps.getConfigFlag ?? getConfigFlag;
    const master = await flag('wizard_enabled');
    const lane = await flag('wizard_stars_enabled');
    return master === true && lane === true;
  } catch { return false; }
}

function starsNewOrderId(deps = {}) {
  if (typeof deps.newOrderId === 'function') return deps.newOrderId();
  try {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
      return 'st_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through to the time-based fallback */ }
  return 'st_' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}

async function starsAudit(orderId, fromStatus, toStatus, chargeId, note, deps = {}) {
  try {
    await db.insert(wizard_order_audit).values({
      orderId, fromStatus: fromStatus ?? null, toStatus, chargeId: chargeId ?? null, note: note ?? null, createdAt: new Date(),
    }).run();
  } catch { /* audit is evidence, never a grant blocker */ }
}

async function starsLoadOrder(orderId, deps = {}) {
  try {
    const get = deps.loadOrder ?? (async (id) => db.select().from(wizard_orders).where(eq(wizard_orders.id, id)).get());
    return await get(orderId);
  } catch { return null; }
}

async function starsUpdateOrder(orderId, patch, deps = {}) {
  const set = deps.updateOrder ?? (async (id, p) => db.update(wizard_orders).set({ ...p, updatedAt: new Date() }).where(eq(wizard_orders.id, id)).run());
  await set(orderId, patch);
}

// Order creation: snapshots product, USD, and Stars price at creation.
// Never re-derived at settle — the snapshot IS the price.
export async function createStarsOrder(buyerId, productId, deps = {}) {
  const buyer = String(buyerId ?? '').trim();
  const entry = starsCatalogEntry(productId);
  if (!buyer || !entry) return { ok: false, error: 'unknown_product' };
  if (!(await isStarsLaneEnabled(deps))) return { ok: false, error: 'stars_lane_off' };
  const now = new Date();
  const order = {
    id: starsNewOrderId(deps),
    buyerTelegramId: buyer,
    productId,
    lane: 'stars',
    usdSnapshot: String(entry.usd),
    starsAmount: entry.stars,
    currency: 'XTR',
    status: 'created',
    telegramPaymentChargeId: null,
    failureReason: null,
    refundReference: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + STARS_ORDER_TTL_MS),
    paidAt: null,
    appliedAt: null,
  };
  try {
    await db.insert(wizard_orders).values(order).run();
  } catch (err) {
    return { ok: false, error: 'order_create_failed' };
  }
  await starsAudit(order.id, null, 'created', null, 'stars order created', deps);
  return { ok: true, order, entry };
}

// Pre-checkout validation: catalog-reads only, inside Telegram's
// 10-second gate. Any mismatch → ok=false with the plain error, never
// a page, never a throw. A pre-checkout rejection is not an error.
export async function answerStarsPreCheckout(preCheckout, deps = {}) {
  const answer = deps.answerPreCheckout ?? (async (args) => api.answerPreCheckoutQuery(args));
  const refuse = async () => {
    try { await answer({ pre_checkout_query_id: preCheckout?.id, ok: false, error_message: STARS_PRECHECKOUT_ERROR }); } catch { /* refusing twice is harmless */ }
    return { ok: false, error: 'precheckout_refused' };
  };
  try {
    const orderId = String(preCheckout?.invoice_payload ?? '');
    const order = await starsLoadOrder(orderId, deps);
    if (!order) return refuse();
    if (order.status !== 'created') return refuse();
    const expMs = order.expiresAt instanceof Date ? order.expiresAt.getTime() : Number(order.expiresAt);
    if (Number.isFinite(expMs) && expMs <= Date.now()) return refuse();
    if (String(preCheckout?.from?.id ?? '') !== String(order.buyerTelegramId)) return refuse();
    if (String(preCheckout?.currency ?? '') !== 'XTR') return refuse();
    if (Number(preCheckout?.total_amount) !== Number(order.starsAmount)) return refuse();
    await answer({ pre_checkout_query_id: preCheckout.id, ok: true });
    return { ok: true, order };
  } catch {
    return refuse();
  }
}

// Invoice sender: currency XTR, empty provider token, whole-Star amount,
// payload = order id, title/description from the catalog. Stars only.
export async function sendStarsInvoice(chatId, order, deps = {}) {
  const entry = starsCatalogEntry(order.productId);
  if (!entry) return { ok: false, error: 'unknown_product' };
  const sendInvoice = deps.sendInvoice ?? (async (args) => api.sendInvoice(args));
  try {
    await sendInvoice({
      chat_id: chatId,
      title: entry.title,
      description: entry.description,
      payload: order.id,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: entry.title, amount: entry.stars }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// Grant via the EXISTING claim path (source 'claim'), so owner page,
// announcement, lifecycle receipt, and replay dedupe are identical to a
// crypto purchase. PB Plan: term extends from the current expiry when
// it is in the future (double purchase, spec §4.5), else from now.
// Term credits come from config pb_included_allowance_credits, never
// hard-coded; a zero read grants zero term credits and the
// confirmation must not claim any.
async function starsApplyGrant(order, deps = {}) {
  const buyer = String(order.buyerTelegramId);
  const entry = starsCatalogEntry(order.productId);
  if (!entry) throw new Error('stars grant: unknown product');
  const checkoutRef = 'stars:' + order.id;
  if (entry.term) {
    let baseMs = Date.now();
    try {
      const u = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, buyer)).get();
      const expMs = u?.subscriptionExpiresAt instanceof Date ? u.subscriptionExpiresAt.getTime() : (u?.subscriptionExpiresAt ? Number(u.subscriptionExpiresAt) * 1000 : 0);
      if (Number.isFinite(expMs) && expMs > baseMs) baseMs = expMs;
    } catch { /* first purchase: base is now */ }
    const expiresAt = new Date(baseMs + entry.termDays * 86400_000);
    const wasTrial = await weekTrialStatus(buyer).then((s) => s.active).catch(() => false);
    await applyClaimGrant(buyer, {
      kind: 'tier_grant', tier: 'one', expires_at: expiresAt, term: entry.term,
      term_credits: await includedAllowanceForOne().catch(() => 0),
    }, checkoutRef);
    return { kind: 'tier', wasTrial, extended: baseMs > Date.now(), expiresAt };
  }
  await applyClaimGrant(buyer, { kind: 'credit_grant', credits: entry.credits }, checkoutRef);
  return { kind: 'pack', credits: entry.credits };
}

function starsConfirmationText(order, grant) {
  const entry = starsCatalogEntry(order.productId);
  const lines = [`✅ Payment received — ${entry.stars} Stars for ${entry.title}.`];
  if (grant.kind === 'tier') {
    if (grant.wasTrial) lines.push('Your trial has ended and your PB Plan is live — unused trial credits are forfeit, and your PB Plan term credits apply from now.');
    else if (grant.extended) lines.push('Your PB Plan term has been extended from your current expiry.');
    else lines.push('Your PB Plan is live.');
  } else {
    lines.push('Your Studio credits have been added.');
  }
  lines.push(STARS_FINE_PRINT);
  return lines.join('\n');
}

// successful_payment branch. Keys on telegram_payment_charge_id:
// a replayed charge is a byte-for-byte no-op (no second grant, no
// second confirmation). Validation failures and grant failures park
// in owner_review with a money page — NEVER an auto-refund, and never
// a partial grant. Exactly one confirmation, only on the transition
// into applied.
export async function handleStarsSuccessfulPayment(message, deps = {}) {
  const send = deps.send ?? wizSend;
  const pay = message?.successful_payment ?? null;
  if (!pay) return { ok: false, error: 'no_payment' };
  const buyer = String(message?.from?.id ?? '');
  const chargeId = String(pay.telegram_payment_charge_id ?? '');
  const orderId = String(pay.invoice_payload ?? '');
  if (!buyer || !chargeId || !orderId) return { ok: false, error: 'malformed_payment' };
  try {
    const prior = await db.select().from(wizard_orders).where(eq(wizard_orders.telegramPaymentChargeId, chargeId)).get().catch(() => null);
    if (prior) return { ok: true, replay: true, order: prior }; // no second grant, no second confirmation
    const order = await starsLoadOrder(orderId, deps);
    if (!order) {
      await pageOwners(['💰 STARS PAYMENT — NO ORDER', '', `Charge: ${chargeId}`, 'No matching Stars order. Payment received, nothing granted, no refund issued automatically — owner to resolve.'].join('\n')).catch(() => {});
      return { ok: false, error: 'no_order' };
    }
    if (String(order.buyerTelegramId) !== buyer || String(pay.currency ?? '') !== 'XTR' || Number(pay.total_amount) !== Number(order.starsAmount)) {
      const from = order.status;
      await starsUpdateOrder(order.id, { status: 'owner_review', failureReason: 'payment_mismatch' }, deps);
      await starsAudit(order.id, from, 'owner_review', chargeId, 'payment did not match snapshot; parked, no grant, no refund', deps);
      await pageOwners(['💰 STARS PAYMENT — MISMATCH, PARKED', '', `Order: ${order.id}`, `Charge: ${chargeId}`, 'Payment did not match the recorded Stars order. Nothing granted, no refund issued automatically — owner to resolve.'].join('\n')).catch(() => {});
      return { ok: false, error: 'payment_mismatch' };
    }
    if (order.status === 'applied') return { ok: true, replay: true, order };
    if (order.status !== 'created' && order.status !== 'paid') {
      // A second, distinct charge on an already-settled order: it bought
      // nothing. Parked, not auto-refunded (spec §6).
      const from = order.status;
      await starsUpdateOrder(order.id, { status: 'owner_review', failureReason: 'second_charge_on_settled_order', telegramPaymentChargeId: chargeId }, deps);
      await starsAudit(order.id, from, 'owner_review', chargeId, 'second distinct charge on a settled order; parked, no refund', deps);
      await pageOwners(['💰 STARS PAYMENT — SECOND CHARGE, PARKED', '', `Order: ${order.id}`, `Charge: ${chargeId}`, 'A second charge landed on a settled order. Nothing granted for it, no refund issued automatically — owner to resolve.'].join('\n')).catch(() => {});
      return { ok: false, error: 'second_charge' };
    }
    const from = order.status;
    await starsUpdateOrder(order.id, { status: 'paid', telegramPaymentChargeId: chargeId, paidAt: new Date() }, deps);
    await starsAudit(order.id, from, 'paid', chargeId, 'stars payment recorded', deps);
    let grant;
    try {
      // Test seam only: deps.grantFn replaces the real grant in the
      // harness so the apply_failed → owner_review path is provable
      // without corrupting a real catalog entry. Production never
      // passes grantFn, so the real claim path always runs.
      const grantFn = deps.grantFn ?? ((o) => starsApplyGrant(o, deps));
      grant = await grantFn({ ...order, status: 'paid' });
    } catch (err) {
      await starsUpdateOrder(order.id, { status: 'apply_failed', failureReason: String(err?.message ?? err).slice(0, 200) }, deps);
      await starsAudit(order.id, 'paid', 'apply_failed', chargeId, 'grant failed', deps);
      // Transition into owner_review pages once; the tick re-drive
      // below does not re-page an order already in owner_review.
      await starsUpdateOrder(order.id, { status: 'owner_review', failureReason: String(err?.message ?? err).slice(0, 200) }, deps);
      await starsAudit(order.id, 'apply_failed', 'owner_review', chargeId, 'grant failed; parked for owner, no refund', deps);
      await pageOwners(['💰 STARS PAYMENT — GRANT FAILED, PARKED', '', `Order: ${order.id}`, `Charge: ${chargeId}`, 'Payment received, the grant did not apply. Nothing was refunded automatically — owner to resolve.'].join('\n')).catch(() => {});
      try { await send(buyer, 'Your Stars payment was received, but the grant did not apply — the owner will resolve it. Nothing was refunded automatically.'); } catch { /* buyer notice is best-effort */ }
      return { ok: false, error: 'grant_failed' };
    }
    await starsUpdateOrder(order.id, { status: 'applied', appliedAt: new Date() }, deps);
    await starsAudit(order.id, 'paid', 'applied', chargeId, 'grant applied', deps);
    try { await wizbuyClear(buyer, deps); } catch { /* session cleanup never blocks the grant */ }
    try { await send(buyer, starsConfirmationText(order, grant)); } catch { /* confirmation best-effort; the grant already landed */ }
    return { ok: true, order, grant };
  } catch (err) {
    console.error('[stars:payment]', err?.message ?? err);
    return { ok: false, error: 'payment_handler_failed' };
  }
}

// /paysupport: how to reach the owner, the caller's own recent orders
// (by Telegram id only — never another buyer's), and a way to quote a
// charge id back for a refund conversation. While the lane is OFF this
// command behaves exactly like an unknown command (DM: "I don't know
// /paysupport", groups: silent) — the lane does not exist to members
// until it arms. It is NOT in the 100-command menu and NOT in /help.
export const PAYSUPPORT_COMMANDS = {
  paysupport: async (chatId, args, msg) => {
    const uid = String(msg?.from?.id ?? '');
    const isPrivate = msg?.chat?.type === 'private';
    if (!(await isStarsLaneEnabled())) {
      if (isPrivate) await wizSend(chatId, `❓ I don't know /paysupport. See /help for what I can do.`);
      return;
    }
    if (!isPrivate) {
      await wizSend(msg.from.id, '🔒 That one needs a private chat — open a DM with me and run /paysupport there.');
      return;
    }
    const quote = String((args ?? []).join(' ') ?? '').trim();
    let rows = [];
    try {
      rows = await db.select().from(wizard_orders).where(eq(wizard_orders.buyerTelegramId, uid)).all();
    } catch { rows = []; }
    rows = (rows ?? []).slice().sort((a, b) => {
      const am = a.createdAt instanceof Date ? a.createdAt.getTime() : Number(a.createdAt) || 0;
      const bm = b.createdAt instanceof Date ? b.createdAt.getTime() : Number(b.createdAt) || 0;
      return bm - am;
    }).slice(0, 10);
    const orderLines = rows.length
      ? rows.map((r) => `• ${r.productId} — ${r.starsAmount} Stars — ${r.status}${r.telegramPaymentChargeId ? ` — charge ${r.telegramPaymentChargeId}` : ''}`).join('\n')
      : 'No Stars orders on this account yet.';
    await wizSend(chatId, [
      '💳 Payment support',
      '',
      'For payment help, reach the owner through the support chat: https://t.me/poorboyai_agent_support',
      quote ? `You quoted charge: ${quote} — mention that charge id in your support message so the owner can find the payment.` : 'To ask about a specific payment, run /paysupport followed by its charge id.',
      '',
      'Your recent Stars orders:',
      orderLines,
      '',
      'Refunds are decided by the owner — nothing is refunded automatically.',
      STARS_FINE_PRINT,
    ].join('\n'));
  },
};

// Tick cycle (wired in lib/tick.js as 'starsOrders', appended LAST):
// re-drive paid orders until applied/apply_failed; expiry sweep past
// 24h → expired (expired orders can never be paid into — pre-checkout
// refuses them); Stars balance check throttled to at most once an
// hour, recorded in config. A cycle failure never breaks other cycles.
// apply_failed orders page once, on the transition into owner_review
// (the successful_payment path already pages there; this re-drive
// pages only orders it newly moves into owner_review).
export async function cycleStarsOrders(deps = {}) {
  const out = { driven: 0, applied: 0, failed: 0, expired: 0, balance: null };
  try {
    let paid = [];
    try { paid = await db.select().from(wizard_orders).where(eq(wizard_orders.status, 'paid')).all(); } catch { paid = []; }
    for (const order of paid ?? []) {
      out.driven++;
      try {
        const grantFn = deps.grantFn ?? ((o) => starsApplyGrant(o, deps));
        const grant = await grantFn(order);
        await starsUpdateOrder(order.id, { status: 'applied', appliedAt: new Date() }, deps);
        await starsAudit(order.id, 'paid', 'applied', order.telegramPaymentChargeId, 'tick re-drive applied', deps);
        try { await (deps.send ?? wizSend)(String(order.buyerTelegramId), starsConfirmationText(order, grant)); } catch { /* confirmation best-effort */ }
        out.applied++;
      } catch (err) {
        out.failed++;
        await starsUpdateOrder(order.id, { status: 'owner_review', failureReason: String(err?.message ?? err).slice(0, 200) }, deps);
        await starsAudit(order.id, 'paid', 'owner_review', order.telegramPaymentChargeId, 'tick re-drive failed; parked, no refund', deps);
        await pageOwners(['💰 STARS PAYMENT — RE-DRIVE FAILED, PARKED', '', `Order: ${order.id}`, `Charge: ${order.telegramPaymentChargeId ?? ''}`, 'A paid Stars order could not be applied. Nothing was refunded automatically — owner to resolve.'].join('\n')).catch(() => {});
      }
    }
    let created = [];
    try { created = await db.select().from(wizard_orders).where(eq(wizard_orders.status, 'created')).all(); } catch { created = []; }
    for (const order of created ?? []) {
      const expMs = order.expiresAt instanceof Date ? order.expiresAt.getTime() : Number(order.expiresAt);
      if (Number.isFinite(expMs) && expMs <= Date.now()) {
        await starsUpdateOrder(order.id, { status: 'expired' }, deps);
        await starsAudit(order.id, 'created', 'expired', null, 'order past 24h window', deps);
        out.expired++;
      }
    }
    // Balance check: throttled, best-effort, never a cycle failure.
    // Only recorded when the lane is armed or a balance is present;
    // the owner digest line is served from config key stars_digest_line.
    try {
      const lastAt = Number(await getConfig('stars_balance_last_at', '0')) || 0;
      if (Date.now() - lastAt >= 3600_000) {
        const getBalance = deps.getStarBalance ?? (async () => api.getMyStarBalance());
        const bal = await getBalance();
        const amount = Number(bal?.amount ?? bal ?? NaN);
        if (Number.isFinite(amount)) {
          await setConfig('stars_balance_last', String(amount)).catch(() => {});
          await setConfig('stars_balance_last_at', String(Date.now())).catch(() => {});
          out.balance = amount;
          const armed = await isStarsLaneEnabled(deps);
          if (armed || amount > 0) {
            await setConfig('stars_digest_line', `Stars balance: ${amount} Stars`).catch(() => {});
          }
        }
      } else {
        const saved = await getConfig('stars_balance_last', null).catch(() => null);
        out.balance = saved == null ? null : Number(saved);
      }
    } catch { /* balance check never fails the cycle */ }
  } catch (err) {
    console.error('[stars:cycle]', err?.message ?? err);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chainstack MCP client — PB-side, READ-ONLY (2026-11-04 wave, NO PUSH).
// Rowdy's order: connect, NOT migrate. This client only READS Chainstack
// state (projects, nodes, organization) through the MCP server. It never
// creates, updates, or deletes anything, never changes an RPC endpoint,
// and never touches an access rule. The API key comes from bot config
// (CHAINSTACK_API_KEY, set by Rowdy in his PB DM) via getConfig, in-isolate
// only. The key is used solely as the Bearer header value and is never
// logged, never returned, never stored anywhere else, and never appears in
// any error message, return value, or URL.
// Structural read-only guarantee: csMcpCall refuses every tool name that
// is not on CS_READ_TOOLS, before any fetch happens. No create/update/
// delete tool name exists anywhere in this section.
// No new top-level bot command wires these functions yet, by design: the
// read-only proof comes first, and a later wizard/owner step decides the
// surface. The functions are exported for that later step.
// Transport: MCP Streamable HTTP (JSON-RPC 2.0 POST). Responses may be plain
// JSON or SSE (data: lines); csMcpParseBody handles both. No timers exist
// in the isolate, so there is no request timeout and no retry: one POST,
// one parse, one error class.
// ─────────────────────────────────────────────────────────────────────────────
const CHAINSTACK_MCP_URL = 'https://mcp.chainstack.com/mcp';
const CHAINSTACK_MCP_PROTOCOL = '2024-11-05';
const CHAINSTACK_MCP_CLIENT = { name: 'poorboyai', version: '1.0.0' };
// The ONLY tool names this client will ever call. Anything else throws
// before fetch. get_platform_status / get_chainstack_pricing / search_docs /
// get_doc_page need no key, but they are not wired here: this client is the
// authenticated account view, and the no-key tools stay out of scope.
const CS_READ_TOOLS = ['list_projects', 'get_project', 'list_nodes', 'get_node', 'get_organization'];

// Parse one MCP Streamable HTTP response body: plain JSON, or SSE text whose
// data: lines carry JSON-RPC messages. Returns the last message carrying a
// result or an error. Throws 'chainstack_mcp_bad_response' on unparseable
// input. Never includes body content in the thrown error.
// Exported for harness testing of the SSE branch.
export function csMcpParseBody(text) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('chainstack_mcp_bad_response');
  if (body[0] === '{') {
    try { return JSON.parse(body); } catch { throw new Error('chainstack_mcp_bad_response'); }
  }
  const found = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.indexOf('data:') === 0) {
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { found.push(JSON.parse(payload)); } catch { /* skip unparseable SSE line */ }
    }
  }
  for (let i = found.length - 1; i >= 0; i--) {
    if (found[i] && (found[i].result !== undefined || found[i].error !== undefined)) return found[i];
  }
  if (found.length) return found[found.length - 1];
  throw new Error('chainstack_mcp_bad_response');
}

// One authenticated MCP POST. session = { key, id, nextId, fetchFn }.
// Returns { json, sessionId } where sessionId is the Mcp-Session-Id response
// header when the server sends one. Error classes only, never bodies:
//   chainstack_mcp_http_<status>  (non-OK HTTP; 401/403 = auth failure)
//   chainstack_mcp_rpc_<code>     (JSON-RPC error object)
//   chainstack_mcp_bad_response   (unparseable body)
async function csMcpPost(session, body) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: 'Bearer ' + session.key,
  };
  if (session.id) headers['mcp-session-id'] = session.id;
  const res = await session.fetchFn(CHAINSTACK_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('chainstack_mcp_http_' + res.status);
  const json = csMcpParseBody(text);
  let sessionId = null;
  try { sessionId = res.headers ? res.headers.get('mcp-session-id') : null; } catch { sessionId = null; }
  if (json && json.error !== undefined) {
    const code = json.error && json.error.code !== undefined ? json.error.code : 'unknown';
    throw new Error('chainstack_mcp_rpc_' + code);
  }
  return { json, sessionId };
}

// Open an authenticated MCP session: read the key from config (in-isolate
// only), run the initialize handshake, capture the session id, and send the
// initialized notification best-effort (its failure never blocks reads).
// Throws 'chainstack_mcp_no_key' when no key is configured, before any fetch.
// Exported for harness testing and future owner/wizard steps.
export async function csMcpSession(deps = {}) {
  const fetchFn = deps.fetchFn || fetch;
  const key = await getConfig('CHAINSTACK_API_KEY', null);
  if (key === null || key === undefined || String(key).length === 0) {
    throw new Error('chainstack_mcp_no_key');
  }
  const session = { key: String(key), id: null, nextId: 1, fetchFn };
  const init = await csMcpPost(session, {
    jsonrpc: '2.0',
    id: session.nextId++,
    method: 'initialize',
    params: {
      protocolVersion: CHAINSTACK_MCP_PROTOCOL,
      capabilities: {},
      clientInfo: CHAINSTACK_MCP_CLIENT,
    },
  });
  if (init.sessionId) session.id = init.sessionId;
  session.protocolVersion = init.json && init.json.result && init.json.result.protocolVersion
    ? String(init.json.result.protocolVersion)
    : CHAINSTACK_MCP_PROTOCOL;
  try {
    await csMcpPost(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch { /* notification is best-effort; reads proceed regardless */ }
  return session;
}

// Call one read-only MCP tool. The allowlist throws before fetch for any
// other name, so no write tool can ever reach the wire through this client.
// Exported for harness testing of the deny path.
export async function csMcpCall(session, toolName, args) {
  if (CS_READ_TOOLS.indexOf(toolName) === -1) throw new Error('chainstack_mcp_tool_denied');
  const id = session.nextId++;
  const out = await csMcpPost(session, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args || {} },
  });
  const result = out.json ? out.json.result : null;
  if (!result) throw new Error('chainstack_mcp_bad_response');
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      try { return JSON.parse(item.text); } catch { return item.text; }
    }
  }
  return result;
}

// Normalize a tools/call result to an array (list tools return lists; a
// single object wraps to one element; anything else yields []).
function csAsList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  if (v && Array.isArray(v.nodes)) return v.nodes;
  if (v && Array.isArray(v.projects)) return v.projects;
  if (v && typeof v === 'object') return [v];
  return [];
}

export async function csListTools(deps = {}) {
  const session = await csMcpSession(deps);
  const out = await csMcpPost(session, {
    jsonrpc: '2.0',
    id: session.nextId++,
    method: 'tools/list',
    params: {},
  });
  const result = out.json ? out.json.result : null;
  if (!result || !Array.isArray(result.tools)) throw new Error('chainstack_mcp_bad_response');
  return result.tools;
}

export async function csListProjects(deps = {}) {
  const session = await csMcpSession(deps);
  return csAsList(await csMcpCall(session, 'list_projects', {}));
}

export async function csListNodes(deps = {}) {
  const session = await csMcpSession(deps);
  return csAsList(await csMcpCall(session, 'list_nodes', {}));
}

export async function csGetNode(nodeId, deps = {}) {
  const session = await csMcpSession(deps);
  return csMcpCall(session, 'get_node', { node_id: nodeId });
}

export async function csGetOrganization(deps = {}) {
  const session = await csMcpSession(deps);
  return csMcpCall(session, 'get_organization', {});
}

// Read-only summary for owner verification. Returns COUNTS, STATUSES, and
// FLAGS only — never ids, names, descriptions, endpoints, or any key-bearing
// value. Safe to surface in full.
export async function csChainstackReadOnlySummary(deps = {}) {
  const session = await csMcpSession(deps);
  const toolsOut = await csMcpPost(session, {
    jsonrpc: '2.0',
    id: session.nextId++,
    method: 'tools/list',
    params: {},
  });
  const toolsResult = toolsOut.json ? toolsOut.json.result : null;
  const toolNames = toolsResult && Array.isArray(toolsResult.tools)
    ? toolsResult.tools.map((t) => t.name)
    : [];
  const projects = csAsList(await csMcpCall(session, 'list_projects', {}));
  const nodes = csAsList(await csMcpCall(session, 'list_nodes', {}));
  let nodeStatuses = [];
  try {
    nodeStatuses = nodes.map((n) => String((n && n.status) || 'unknown'));
  } catch { nodeStatuses = []; }
  let orgOk = false;
  try {
    const org = await csMcpCall(session, 'get_organization', {});
    orgOk = org !== null && org !== undefined;
  } catch { orgOk = false; }
  let firstNodeStatus = null;
  if (nodes.length) {
    try {
      const detail = await csMcpCall(session, 'get_node', { node_id: nodes[0].id });
      firstNodeStatus = detail && detail.status ? String(detail.status) : 'unknown';
    } catch { firstNodeStatus = 'get-failed'; }
  }
  return {
    ok: true,
    protocolVersion: session.protocolVersion,
    sessionIdPresent: session.id ? true : false,
    toolNames,
    projectCount: projects.length,
    nodeCount: nodes.length,
    nodeStatuses,
    orgOk,
    firstNodeStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chainstack faucet claim — MASTER-ONLY gated write (2026-11-04 addendum,
// NO PUSH). Rowdy's order: the master wallet IS the faucet/rehearsal wallet.
// This is the section's ONLY write path, and it is gated three ways:
//   1. Tool: csFaucetToolCall hardcodes 'request_testnet_funds'. No
//      tool-name parameter exists anywhere on this path, so no other
//      write can be routed through it. csMcpCall (the read path) still
//      refuses 'request_testnet_funds' — the read-only guarantee is
//      unchanged; the faucet path is a separate, narrower function.
//   2. Recipient: CS_FAUCET_MASTER_ADDRESS is the ONLY address this
//      function will ever send. Any other address is refused BEFORE any
//      fetch (fetch delta 0, proven in harness). The constant, not the
//      caller-supplied string, is what goes on the wire.
//   3. Network: only 'sepolia' and 'base' (Base Sepolia — the tool's own
//      enum lists 'base' as the canonical Base testnet id, with the
//      'base-sepolia' alias normalized to it). Every other network is
//      refused before any fetch. PB-relevant testnets only; the other ten
//      enum entries are deliberately NOT wired.
// No retry, ever: one POST, one verdict. The provider refuses a second
// claim inside 24h (one top-up per network per 24h); the caller must
// surface that refusal, never retry around it.
// Verdicts are classes only: 'claimed', 'chainstack_faucet_address_denied',
// 'chainstack_faucet_chain_denied', or the csMcpPost error classes
// (chainstack_mcp_http_<status> / chainstack_mcp_rpc_<code>). Never
// amounts, never tx hashes, never URLs, never key material, never the
// recipient (it is always the master by construction, so storing it adds
// nothing). Every attempt — including pre-fetch denials — writes one
// class-only row to bot config (CS_FAUCET_LOG_KEY, best-effort, never
// blocks the verdict) via deps.logFn when injected (harness), else setConfig.
// KNOWN FACT (2026-11-04 Etherscan check, public chain data): a live claim
// for the master is currently expected to be REFUSED on eligibility — the
// master holds ~0.00003 ETH on Ethereum mainnet, and the faucet requires
// 0.08 ETH + holding history. The client surfaces the provider's refusal
// verbatim by class and never suggests funding moves on its own. A live
// claim is a separate Rowdy decision; this wave proves the gates with a
// MOCK harness only. No live claim runs here.
// ─────────────────────────────────────────────────────────────────────────────
const CS_FAUCET_MASTER_ADDRESS = '0xEFa099590c45874e844dEc6FC862c7141ecF4139';
const CS_FAUCET_TOOL = 'request_testnet_funds';
const CS_FAUCET_NETWORKS = ['sepolia', 'base'];
const CS_FAUCET_NETWORK_ALIASES = { 'ethereum-sepolia': 'sepolia', 'base-sepolia': 'base' };
const CS_FAUCET_LOG_KEY = 'chainstack_faucet:last';

function csFaucetNormalizeNetwork(network) {
  const n = String(network ?? '').trim().toLowerCase();
  return CS_FAUCET_NETWORK_ALIASES[n] || n;
}

// The ONLY faucet write call. Tool name hardcoded; arguments are the
// normalized network and the master constant. Throws the csMcpPost error
// classes on provider failure (classes only, never bodies).
async function csFaucetToolCall(session, network, address) {
  const id = session.nextId++;
  const out = await csMcpPost(session, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: CS_FAUCET_TOOL, arguments: { network, address } },
  });
  const result = out.json ? out.json.result : null;
  if (!result) throw new Error('chainstack_mcp_bad_response');
  return result;
}

// Claim faucet funds for the master wallet only.
//   csClaimFaucetFunds(recipientAddress, network, deps = {})
// deps: { fetchFn, logFn } — both optional, both injectable for harness.
// Returns { outcome: 'claimed' } on provider success, or
// { outcome: 'denied' | 'error', errorClass } otherwise. NEVER retries.
// The caller (a future owner/wizard step) must surface the verdict and
// must NOT auto-retry a refusal or a 24h-limit refusal.
export async function csClaimFaucetFunds(recipientAddress, network, deps = {}) {
  const logFn = deps.logFn || ((key, val) => setConfig(key, val).catch(() => {}));
  const log = async (outcome, errorClass, net) => {
    try {
      await logFn(CS_FAUCET_LOG_KEY, JSON.stringify({
        outcome, errorClass: errorClass || null, network: net || null, at: Date.now(),
      }));
    } catch { /* logging never blocks the verdict */ }
  };
  const recipient = String(recipientAddress ?? '').trim().toLowerCase();
  if (recipient !== CS_FAUCET_MASTER_ADDRESS.toLowerCase()) {
    await log('denied', 'chainstack_faucet_address_denied', null);
    return { outcome: 'denied', errorClass: 'chainstack_faucet_address_denied' };
  }
  const net = csFaucetNormalizeNetwork(network);
  if (CS_FAUCET_NETWORKS.indexOf(net) === -1) {
    await log('denied', 'chainstack_faucet_chain_denied', null);
    return { outcome: 'denied', errorClass: 'chainstack_faucet_chain_denied' };
  }
  try {
    const session = await csMcpSession(deps);
    await csFaucetToolCall(session, net, CS_FAUCET_MASTER_ADDRESS);
    await log('claimed', null, net);
    return { outcome: 'claimed' };
  } catch (e) {
    const errorClass = e && e.message ? String(e.message) : 'chainstack_mcp_bad_response';
    await log('error', errorClass, net);
    return { outcome: 'error', errorClass };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chainstack faucet SURFACE — guarded owner claim (2026-11-04 surface wave).
// Rowdy's orders: "Wire the faucet" + "Make claim". This is the ONLY caller
// of csClaimFaucetFunds: no chat command (100-command menu cap + /help
// clutter guardrail — no new top-level command), no tick call, no schedule.
// Invocation is an explicit owner order (Rowdy's word in chat), executed via
// a run-only owner endpoint that imports this function and is deleted after.
// Guard (closes the §8.5-D2 named gap):
//   - Reads chainstack_faucet:last BEFORE any claim (awaited getConfig,
//     via injectable deps.readFn for harness; production default below).
//   - A 'claimed' row for the SAME network within 24h hard-blocks: returns
//     'guarded' with NO inner call (fetch delta 0) and NO log write, so the
//     claimed row stays as the guard's own evidence. Per-network: a
//     'sepolia' claim never blocks 'base' and vice versa.
//   - A prior refusal/error row is SURFACED in the verdict (priorAttempt)
//     but does not block an explicit owner order: the provider's 24h rule
//     governs top-ups, not refused attempts, and a refusal leaves nothing
//     to protect. Blocking retries after a refusal would strand the owner
//     if eligibility changes inside the window.
//   - The wrapper pre-validates the network allowlist itself: a bad
//     network is refused pre-fetch WITHOUT calling the inner function and
//     WITHOUT touching the log, so a denial row (which the inner function
//     logs with network:null) can never clobber a prior claimed row.
// Verdicts are classes only, same as the inner function, plus priorAttempt
// ({ outcome, errorClass, network, at } — class + timestamp, never amounts,
// hashes, URLs, keys, or the recipient).
// ─────────────────────────────────────────────────────────────────────────────
const CS_FAUCET_GUARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function csFaucetClaimGuarded(network, deps = {}) {
  const readFn = deps.readFn || ((key) => getConfig(key, ''));
  const net = csFaucetNormalizeNetwork(network);
  if (CS_FAUCET_NETWORKS.indexOf(net) === -1) {
    return { outcome: 'denied', errorClass: 'chainstack_faucet_chain_denied', priorAttempt: null };
  }
  let priorAttempt = null;
  try {
    const raw = await readFn(CS_FAUCET_LOG_KEY);
    const parsed = typeof raw === 'string' ? (raw ? JSON.parse(raw) : null) : (raw || null);
    if (parsed && typeof parsed === 'object') {
      priorAttempt = {
        outcome: parsed.outcome || null,
        errorClass: parsed.errorClass || null,
        network: parsed.network || null,
        at: typeof parsed.at === 'number' ? parsed.at : null,
      };
    }
  } catch { priorAttempt = null; }
  if (
    priorAttempt && priorAttempt.outcome === 'claimed' && priorAttempt.network === net &&
    typeof priorAttempt.at === 'number' && Date.now() - priorAttempt.at < CS_FAUCET_GUARD_WINDOW_MS
  ) {
    return { outcome: 'guarded', errorClass: 'chainstack_faucet_24h_guard', priorAttempt };
  }
  const verdict = await csClaimFaucetFunds(CS_FAUCET_MASTER_ADDRESS, net, deps);
  return { ...verdict, priorAttempt };
}

