// Member campaigns (my-campaign) — PB-side store + posting engine.
//
// Settled design (wave-dash-10): the campaign store lives in PB's tgcloud
// DB and PB's tick executes it; the Worker/D1 never hosts campaign state
// and /api/campaign-handoffs stays parked. Member surface = Mini App +
// /campaign in DM. Telegram groups ONLY in v1 — there is no PB→Discord
// execution path and the cross-community bridge stays OFF.
//
// Port of the original product (routes/user-campaign.ts +
// telegram-community-bot.ts shill scheduler):
//   • ONE campaign profile per member (original upsert-on-owner semantics),
//     Starter+ access ("Shill Campaigns require an active Starter plan or
//     higher."), free tier cannot save.
//   • Posting slots capped per tier from the original SLOT_LIMITS, mapped
//     through canonical tiers (lib/tiers.js campaignSlots): starter 1,
//     builder 4, pro 8, agency 20 — never looser than the original.
//   • Default post interval 12h (original scheduler default); a custom
//     interval (60–1440 min, the original clamp) is a Pro+ perk (original
//     canInterval = chad/whale/dev_launch → canonical pro/agency).
//   • Custom buttons ≤3 {name,url} (original cleaning rules).
//   • Ticker normalized (strip $, uppercase); chain auto-detected from the
//     address format exactly like the original (base58 → sol, else base).
//
// ISOLATION (hard rule): a slot's target must be a group the campaign
// OWNER admins — checked live via Bot API getChatMember when the slot is
// added, when it is (re)activated, and again at every fire time. A campaign
// can only ever post into its owner's own groups; nothing crosses
// communities. All reads/writes are scoped to the caller's own rows.
//
// The original campaign ROWS are not migrated: they are keyed by Clerk id
// and no Clerk↔Telegram identity join exists (same call as mission state).
// Members re-create their campaign in the Mini App in under a minute.

import { api } from 'sdk';
import db, { eq, and, desc, sql } from 'sdk/db';
import {
  bot_users, known_groups, user_campaigns, user_campaign_slots, campaign_delivery_log,
} from '../schema.js';
import { isOwnerId, isChatAdmin, getMyGroupsFor } from './groups.js';
import { getConfig, setConfig } from './config.js';
import { canonicalTier, tierLimits, enforceGate } from './tiers.js';
import { fetchVerdict } from './verdict.js';
import { fireAutoCallout } from './opscmds.js';

export const CAMPAIGN_GATE_TEXT =
  '📣 Shill Campaigns require an active Starter plan or higher.\n\nUpgrade in the Mini App (More → 💳 My Plan) and your campaign unlocks right away.';
export const DEFAULT_INTERVAL_MINUTES = 720; // 12h — original scheduler default
export const MIN_INTERVAL_MINUTES = 60;       // original clamp
export const MAX_INTERVAL_MINUTES = 1440;     // original clamp
const MAX_SENDS_PER_CYCLE = 30;

function campError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function toSec(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const p = Date.parse(v);
  return Number.isFinite(p) ? Math.floor(p / 1000) : null;
}

function sleep(ms) {
  return new Promise((r) => (typeof setTimeout !== 'undefined' ? setTimeout(r, ms) : r()));
}

// ── Access / tier ────────────────────────────────────────────────────────────

const ACCESS_TIERS = ['starter', 'builder', 'pro', 'agency', 'one', 'trial'];

/** The caller's campaign access picture. Never throws. */
export async function getCampaignAccess(ownerId) {
  const oid = String(ownerId);
  let rawTier = 'free';
  try {
    const row = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, oid)).get();
    if (row?.tier) rawTier = row.tier;
  } catch { /* no row → free */ }
  const canon = canonicalTier(rawTier);
  const isOwner = await isOwnerId(oid).catch(() => false);
  return {
    tier: rawTier,
    canon,
    isOwner,
    access: isOwner || ACCESS_TIERS.includes(canon),
    canInterval: isOwner || canon === 'pro' || canon === 'agency' || canon === 'one' || canon === 'trial',
    limits: tierLimits(rawTier),
  };
}

async function requireAccess(ownerId) {
  const acc = await getCampaignAccess(ownerId);
  if (!acc.access) throw campError('CAMPAIGN_PAID_PLAN_REQUIRED', CAMPAIGN_GATE_TEXT);
  return acc;
}

/** Gate text for the caller, or null when allowed (skills registry hook). */
export async function campaignGateText(ownerId) {
  const acc = await getCampaignAccess(ownerId);
  return acc.access ? null : CAMPAIGN_GATE_TEXT;
}

// ── Campaign profile ─────────────────────────────────────────────────────────

/** The caller's own campaign row, or null. */
export async function getOwnCampaign(ownerId) {
  try {
    return await db.select().from(user_campaigns)
      .where(eq(user_campaigns.ownerTelegramId, String(ownerId))).get() ?? null;
  } catch { return null; }
}

// Original cleaning (routes/user-campaign.ts): keep entries with non-empty
// string name+url, cap 3, name ≤64, url ≤2048. v1 adds an http(s) scheme
// requirement — Telegram rejects non-URL buttons at send time, which would
// fail the whole post; the original never hit this because its posts went
// through a different renderer.
export function cleanButtons(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter((b) => b && typeof b.name === 'string' && typeof b.url === 'string'
      && b.name.trim() && /^https?:\/\//i.test(b.url.trim()))
    .slice(0, 3)
    .map((b) => ({ name: b.name.trim().slice(0, 64), url: b.url.trim().slice(0, 2048) }));
}

// Original chain auto-detect: explicit 'sol'/'base' wins; else a base58
// address that is not 0x-prefixed reads as Solana; everything else Base.
export function detectChain(contractAddress, requested) {
  if (requested === 'sol') return 'sol';
  if (requested === 'base') return 'base';
  const ca = String(contractAddress ?? '');
  return ca && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca) && !/^0x/i.test(ca) ? 'sol' : 'base';
}

/** Pure profile validation/normalization (harness-tested). */
export function normalizeCampaignInput(input, acc) {
  const projectName = String(input?.projectName ?? '').trim().slice(0, 80);
  const tickerRaw = String(input?.ticker ?? '').trim();
  if (!projectName || !tickerRaw) {
    throw campError('BAD_INPUT', 'Project name and ticker are required.');
  }
  const ticker = tickerRaw.replace(/^\$/, '').toUpperCase().slice(0, 16);
  const contractAddress = String(input?.contractAddress ?? '').trim() || null;
  const chain = detectChain(contractAddress, String(input?.chain ?? '').trim().toLowerCase() || null);
  const intervalRaw = input?.postIntervalOverride;
  const postIntervalOverride = acc.canInterval && intervalRaw != null && intervalRaw !== ''
    ? Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Number(intervalRaw) || DEFAULT_INTERVAL_MINUTES))
    : null;
  return {
    projectName,
    ticker,
    description: String(input?.description ?? '').slice(0, 2000),
    website: String(input?.website ?? '').trim().slice(0, 2048) || null,
    contractAddress,
    chain,
    telegramUsername: String(input?.telegramUsername ?? '').replace(/^@/, '').trim().slice(0, 64) || null,
    customButtons: cleanButtons(input?.customButtons),
    postIntervalOverride,
  };
}

/**
 * Create or update the caller's campaign (one per member — the original
 * upsert). Re-runs the token scan when a Base contract address is set or
 * changed; a scan failure never blocks the save.
 */
// ── Auto-callout (restored Replit behavior, callout-auto wave 2026-10-30) ──
// A first complete campaign setup posts its card to the callout channel,
// once per contract, ever. The save already proved paid access (requireAccess),
// so free-tier campaigns can never reach the hook.
const CALLOUT_POSTED_KEY = 'callout_posted_contracts';

/** Replit completeness rule: name + ticker + description + contract. */
export function isCalloutComplete(row) {
  return !!(row?.projectName && row?.ticker
    && String(row?.description ?? '').trim()
    && row?.contractAddress);
}

/** One card per token ever: chain-scoped contract key (EVM lowercased). */
export function calloutDedupeKey(row) {
  const ca = String(row?.contractAddress ?? '');
  return row?.chain === 'sol' ? `sol:${ca}` : `base:${ca.toLowerCase()}`;
}

/** Campaign row → buildCalloutCard fields (snake_case). No market data: a
 *  freshly set-up campaign has no pool quote yet, and the builder omits
 *  absent price lines — exactly like the Replit auto post. */
export function toCalloutCard(row) {
  return {
    project_name: row?.projectName ?? '',
    ticker: row?.ticker ?? '',
    description: row?.description ?? '',
    contract_address: row?.contractAddress ?? null,
    website: row?.website ?? null,
    telegram_username: row?.telegramUsername ?? null,
    chain: row?.chain ?? null,
  };
}

async function readPostedCalloutContracts() {
  try {
    const raw = await getConfig(CALLOUT_POSTED_KEY, '[]');
    const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}

export async function saveOwnCampaign(ownerId, input) {
  const oid = String(ownerId);
  const acc = await requireAccess(oid);
  const fields = normalizeCampaignInput(input, acc);
  const prev = await getOwnCampaign(oid);
  const now = new Date();
  let row;
  if (prev) {
    const updated = await db.update(user_campaigns)
      .set({ ...fields, updatedAt: now })
      .where(eq(user_campaigns.ownerTelegramId, oid)).returning();
    row = updated[0] ?? { ...prev, ...fields };
  } else {
    const inserted = await db.insert(user_campaigns)
      .values({ ownerTelegramId: oid, ...fields, status: 'active' }).returning();
    row = inserted[0];
  }
  // Token verification at setup (settled design): Base only — lib/verdict.js
  // is the existing GoPlus scan (the /scan pipeline). Solana contracts stay
  // unverified in v1 rather than pretending a scan ran.
  const caChanged = String(prev?.contractAddress ?? '') !== String(row.contractAddress ?? '');
  if (row.contractAddress && row.chain === 'base' && (caChanged || !row.tokenVerifiedAt)) {
    try {
      const v = await fetchVerdict(row.contractAddress);
      if (v) {
        const summary = `Score ${v.score}/100 · ${v.riskLevel} risk`
          + (v.flags?.length ? ` · ${v.flags.slice(0, 3).join('; ')}` : ' · no flags');
        const upd = await db.update(user_campaigns)
          .set({ tokenVerifiedAt: new Date(), verificationSummary: summary.slice(0, 300), updatedAt: new Date() })
          .where(eq(user_campaigns.ownerTelegramId, oid)).returning();
        if (upd[0]) row = upd[0];
      }
    } catch { /* scan is best-effort */ }
  }
  // Auto-callout: complete setup → channel card, once per contract. A fire
  // failure never fails the save; unposted keys retry on a later save.
  // Awaited (not fire-and-forget: the isolate may freeze un-awaited work
  // when the handler returns).
  try {
    if (isCalloutComplete(row)) {
      const key = calloutDedupeKey(row);
      const posted = await readPostedCalloutContracts();
      if (!posted.has(key)) {
        const ok = await fireAutoCallout(toCalloutCard(row), acc.canon);
        if (ok) {
          posted.add(key);
          await setConfig(CALLOUT_POSTED_KEY, JSON.stringify([...posted]));
        }
      }
    }
  } catch { /* auto-callout is best-effort; the save stands */ }
  return row;
}

/** Pause/resume flips status only (settled design). Own row only. */
export async function setOwnCampaignStatus(ownerId, status) {
  const oid = String(ownerId);
  await requireAccess(oid);
  if (!['active', 'paused'].includes(status)) {
    throw campError('BAD_INPUT', 'Status must be active or paused.');
  }
  const prev = await getOwnCampaign(oid);
  if (!prev) throw campError('CAMPAIGN_NOT_FOUND', 'No campaign yet — set one up first.');
  const updated = await db.update(user_campaigns)
    .set({ status, updatedAt: new Date() })
    .where(eq(user_campaigns.ownerTelegramId, oid)).returning();
  return updated[0] ?? { ...prev, status };
}

// ── Slots ────────────────────────────────────────────────────────────────────

/** The caller's own slots (all campaigns — they own at most one campaign). */
export async function listOwnSlots(ownerId) {
  try {
    return await db.select().from(user_campaign_slots)
      .where(eq(user_campaign_slots.ownerTelegramId, String(ownerId)))
      .orderBy(user_campaign_slots.id).all();
  } catch { return []; }
}

async function getOwnSlot(ownerId, slotId) {
  const row = await db.select().from(user_campaign_slots)
    .where(eq(user_campaign_slots.id, Number(slotId))).get().catch(() => null);
  // Someone else's slot id is indistinguishable from a missing one.
  if (!row || String(row.ownerTelegramId) !== String(ownerId)) return null;
  return row;
}

function normalizeSlotInterval(value, acc) {
  if (value == null || value === '') return null;
  if (!acc.canInterval) {
    throw campError('INTERVAL_TIER', 'Custom post intervals are a Pro perk — your slots post on the standard 12h rhythm. Upgrade to Pro to set intervals from 1h to 24h.');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw campError('BAD_INPUT', 'Interval must be a number of minutes.');
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.round(n)));
}

/**
 * Add a posting slot. Enforcement (all server-side):
 *  - campaign access + the caller's campaign must exist;
 *  - per-tier slot cap (lib/tiers.js campaignSlots, owner bypass inside);
 *  - the target must be a group PB serves (known_groups);
 *  - the OWNER must be admin/creator of the target — live Bot API check;
 *  - no duplicate slot for the same campaign+group.
 * deps.isAdmin is injectable for harness proofs.
 */
export async function addOwnSlot(ownerId, input, deps = {}) {
  const oid = String(ownerId);
  const acc = await requireAccess(oid);
  const campaign = await getOwnCampaign(oid);
  if (!campaign) throw campError('CAMPAIGN_NOT_FOUND', 'Create your campaign first, then add posting slots.');
  const targetChatId = String(input?.targetChatId ?? '').trim();
  if (!targetChatId) throw campError('BAD_INPUT', 'Pick a target group for this slot.');
  const existing = await listOwnSlots(oid);
  const mine = existing.filter((s) => s.campaignId === campaign.id);
  await enforceGate(oid, acc.tier, 'campaignSlots', mine.length);
  if (mine.some((s) => String(s.targetChatId) === targetChatId)) {
    throw campError('SLOT_EXISTS', 'That group is already a slot on your campaign.');
  }
  const group = await db.select().from(known_groups)
    .where(eq(known_groups.chatId, targetChatId)).get().catch(() => null);
  if (!group) {
    throw campError('GROUP_UNKNOWN', 'PB is not in that group yet. Add @PoorBoyAI_bot to the group first, then retry.');
  }
  const isAdmin = deps.isAdmin ?? isChatAdmin;
  if (!(await isAdmin(targetChatId, oid).catch(() => false))) {
    throw campError('NOT_GROUP_ADMIN', 'Slots can only post to groups YOU admin. PB checked — you are not an admin of that group.');
  }
  const inserted = await db.insert(user_campaign_slots).values({
    campaignId: campaign.id,
    ownerTelegramId: oid,
    targetChatId,
    targetTitle: group.title ?? null,
    intervalMinutes: normalizeSlotInterval(input?.intervalMinutes, acc),
    customText: String(input?.customText ?? '').slice(0, 2000) || null,
    customButtons: input?.customButtons === undefined ? null : cleanButtons(input.customButtons),
    active: true,
  }).returning();
  return inserted[0];
}

/** Patch a slot (active / interval / custom text / custom buttons). Own only. */
export async function updateOwnSlot(ownerId, slotId, patch, deps = {}) {
  const oid = String(ownerId);
  const acc = await requireAccess(oid);
  const slot = await getOwnSlot(oid, slotId);
  if (!slot) throw campError('SLOT_NOT_FOUND', 'That slot is not on your campaign.');
  const set = { updatedAt: new Date() };
  if (patch?.active !== undefined) {
    const want = Boolean(patch.active);
    if (want && !slot.active) {
      // Re-activation re-proves admin rights (same rule as fire time).
      const isAdmin = deps.isAdmin ?? isChatAdmin;
      if (!(await isAdmin(slot.targetChatId, oid).catch(() => false))) {
        throw campError('NOT_GROUP_ADMIN', 'You are no longer an admin of that group, so this slot cannot be reactivated.');
      }
    }
    set.active = want;
  }
  if (patch?.intervalMinutes !== undefined) set.intervalMinutes = normalizeSlotInterval(patch.intervalMinutes, acc);
  if (patch?.customText !== undefined) set.customText = String(patch.customText ?? '').slice(0, 2000) || null;
  if (patch?.customButtons !== undefined) set.customButtons = patch.customButtons === null ? null : cleanButtons(patch.customButtons);
  const updated = await db.update(user_campaign_slots).set(set)
    .where(eq(user_campaign_slots.id, slot.id)).returning();
  return updated[0] ?? { ...slot, ...set };
}

/** Delete a slot. Own only; delivery log rows are kept for audit. */
export async function deleteOwnSlot(ownerId, slotId) {
  const oid = String(ownerId);
  await requireAccess(oid);
  const slot = await getOwnSlot(oid, slotId);
  if (!slot) throw campError('SLOT_NOT_FOUND', 'That slot is not on your campaign.');
  await db.delete(user_campaign_slots).where(eq(user_campaign_slots.id, slot.id)).run();
  return { deleted: true, id: slot.id };
}

/** Recent deliveries for the caller's own campaign (Mini App display). */
export async function listOwnDeliveries(ownerId, limit = 10) {
  const campaign = await getOwnCampaign(ownerId);
  if (!campaign) return [];
  try {
    return await db.select().from(campaign_delivery_log)
      .where(eq(campaign_delivery_log.campaignId, campaign.id))
      .orderBy(desc(campaign_delivery_log.sentAt)).limit(limit).all();
  } catch { return []; }
}

// ── Post rendering (pure) ────────────────────────────────────────────────────

export function effectiveIntervalMinutes(campaign, slot) {
  return slot?.intervalMinutes ?? campaign?.postIntervalOverride ?? DEFAULT_INTERVAL_MINUTES;
}

/**
 * The deterministic post for one slot. Content is the member's own words
 * (slot custom text, else the campaign description) — no brain rewrite, so
 * what the member approved is exactly what posts.
 */
export function buildCampaignPost(campaign, slot) {
  const lines = [`🚀 ${campaign.projectName} ($${campaign.ticker})`, ''];
  const body = String(slot?.customText ?? '').trim() || String(campaign.description ?? '').trim();
  if (body) lines.push(body, '');
  if (campaign.contractAddress) lines.push(`📍 CA: ${campaign.contractAddress}`);
  if (campaign.website) lines.push(`🔗 ${campaign.website}`);
  if (campaign.telegramUsername) lines.push(`💬 https://t.me/${campaign.telegramUsername}`);
  const text = lines.join('\n').trim().slice(0, 4000);
  const buttons = cleanButtons(slot?.customButtons ?? campaign.customButtons ?? []);
  const replyMarkup = buttons.length
    ? { inline_keyboard: buttons.map((b) => [{ text: b.name, url: b.url }]) }
    : null;
  return { text, replyMarkup };
}

// ── Public shapes (endpoints / panels) ───────────────────────────────────────

export function campaignPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectName: row.projectName,
    ticker: row.ticker,
    description: row.description ?? '',
    website: row.website ?? null,
    contractAddress: row.contractAddress ?? null,
    chain: row.chain,
    status: row.status,
    telegramUsername: row.telegramUsername ?? null,
    customButtons: Array.isArray(row.customButtons) ? row.customButtons : [],
    postIntervalOverride: row.postIntervalOverride ?? null,
    totalPosts: row.totalPosts ?? 0,
    tokenVerifiedAt: toSec(row.tokenVerifiedAt),
    verificationSummary: row.verificationSummary ?? null,
    createdAt: toSec(row.createdAt),
    updatedAt: toSec(row.updatedAt),
  };
}

export function slotPublic(row, campaign) {
  return {
    id: row.id,
    campaignId: row.campaignId,
    targetChatId: String(row.targetChatId),
    targetTitle: row.targetTitle ?? null,
    intervalMinutes: row.intervalMinutes ?? null,
    effectiveIntervalMinutes: effectiveIntervalMinutes(campaign, row),
    customText: row.customText ?? null,
    customButtons: Array.isArray(row.customButtons) ? row.customButtons : null,
    active: Boolean(row.active),
    lastSentAt: toSec(row.lastSentAt),
    createdAt: toSec(row.createdAt),
  };
}

/** Everything the Mini App campaign screen needs in one read. Own data only. */
export async function getCampaignView(ownerId) {
  const oid = String(ownerId);
  const acc = await getCampaignAccess(oid);
  const campaign = acc.access ? await getOwnCampaign(oid) : null;
  const slots = campaign ? (await listOwnSlots(oid)).filter((s) => s.campaignId === campaign.id) : [];
  const deliveries = campaign ? await listOwnDeliveries(oid, 8) : [];
  const groups = await getMyGroupsFor(oid).catch(() => []);
  return {
    access: acc.access,
    tier: acc.tier,
    canon: acc.canon,
    isOwner: acc.isOwner,
    canInterval: acc.canInterval,
    slotLimit: Number.isFinite(acc.limits.campaignSlots) ? acc.limits.campaignSlots : -1,
    slotsUsed: slots.length,
    campaign: campaignPublic(campaign),
    slots: slots.map((s) => slotPublic(s, campaign)),
    deliveries: deliveries.map((d) => ({
      id: d.id, slotId: d.slotId, chatId: String(d.chatId), outcome: d.outcome,
      detail: d.detail ?? null, sentAt: toSec(d.sentAt),
    })),
    groups,
  };
}

// ── Tick cycle ───────────────────────────────────────────────────────────────

/**
 * Fire due slots. For each active slot of an active campaign whose interval
 * has elapsed: re-verify the owner STILL admins the target group (a failed
 * check deactivates the slot and logs skipped_not_admin — the campaign can
 * never post somewhere its owner lost control of), then post, log the
 * outcome, and stamp lastSentAt. A 403 (bot removed) also deactivates.
 * deps ({ isAdmin, send }) are injectable for harness proofs.
 */
export async function cycleCampaignSlots(deps = {}) {
  const isAdmin = deps.isAdmin ?? isChatAdmin;
  const send = deps.send ?? (async (chatId, payload) => api.sendMessage({ chat_id: chatId, ...payload }));
  const slots = await db.select().from(user_campaign_slots)
    .where(eq(user_campaign_slots.active, true)).all().catch(() => []);
  const now = Date.now();
  let checked = 0, sent = 0, failed = 0, skipped = 0;
  for (const slot of slots) {
    if (sent + failed >= MAX_SENDS_PER_CYCLE) break;
    const campaign = await db.select().from(user_campaigns)
      .where(eq(user_campaigns.id, slot.campaignId)).get().catch(() => null);
    if (!campaign || campaign.status !== 'active') continue;
    if (String(campaign.ownerTelegramId) !== String(slot.ownerTelegramId)) continue; // corrupt-row guard
    checked++;
    const lastMs = slot.lastSentAt ? new Date(slot.lastSentAt).getTime() : 0;
    if (lastMs && now - lastMs < effectiveIntervalMinutes(campaign, slot) * 60_000) continue;
    const admin = await isAdmin(slot.targetChatId, slot.ownerTelegramId).catch(() => false);
    if (!admin) {
      await db.insert(campaign_delivery_log).values({
        slotId: slot.id, campaignId: campaign.id, chatId: String(slot.targetChatId),
        outcome: 'skipped_not_admin', detail: 'Owner no longer admins the target group — slot deactivated.',
      }).run().catch(() => {});
      await db.update(user_campaign_slots).set({ active: false, updatedAt: new Date() })
        .where(eq(user_campaign_slots.id, slot.id)).run().catch(() => {});
      skipped++;
      continue;
    }
    const post = buildCampaignPost(campaign, slot);
    try {
      const res = await send(slot.targetChatId, {
        text: post.text,
        ...(post.replyMarkup ? { reply_markup: post.replyMarkup } : {}),
        disable_web_page_preview: true,
      });
      await db.insert(campaign_delivery_log).values({
        slotId: slot.id, campaignId: campaign.id, chatId: String(slot.targetChatId),
        messageId: res?.message_id ?? null, outcome: 'sent', detail: null,
      }).run().catch(() => {});
      await db.update(user_campaign_slots).set({ lastSentAt: new Date(now), updatedAt: new Date(now) })
        .where(eq(user_campaign_slots.id, slot.id)).run().catch(() => {});
      await db.update(user_campaigns)
        .set({ totalPosts: sql`${user_campaigns.totalPosts} + 1`, updatedAt: new Date(now) })
        .where(eq(user_campaigns.id, campaign.id)).run().catch(() => {});
      sent++;
    } catch (err) {
      const detail = String(err?.description ?? err?.message ?? 'send failed').slice(0, 200);
      await db.insert(campaign_delivery_log).values({
        slotId: slot.id, campaignId: campaign.id, chatId: String(slot.targetChatId),
        outcome: 'failed', detail,
      }).run().catch(() => {});
      if (err?.code === 403) {
        await db.update(user_campaign_slots).set({ active: false, updatedAt: new Date() })
          .where(eq(user_campaign_slots.id, slot.id)).run().catch(() => {});
      }
      failed++;
    }
    await sleep(400);
  }
  return { checked, sent, failed, skipped };
}

// ── Bot surface (/campaign + skill share this text) ──────────────────────────

function intervalLabel(min) {
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

export async function campaignSummaryText(ownerId) {
  const acc = await getCampaignAccess(ownerId);
  if (!acc.access) return CAMPAIGN_GATE_TEXT;
  const campaign = await getOwnCampaign(ownerId);
  if (!campaign) {
    return '📣 No campaign yet.\n\nSet yours up right here with /setup, or in the Mini App (More → 📣 My Campaign): project, ticker, contract, and the groups YOU admin — PB posts there on your rhythm.';
  }
  const slots = (await listOwnSlots(ownerId)).filter((s) => s.campaignId === campaign.id);
  const lines = [
    `📣 ${campaign.projectName} ($${campaign.ticker}) — ${campaign.status === 'active' ? '▶️ ACTIVE' : '⏸ PAUSED'}`,
    `Chain: ${campaign.chain === 'sol' ? 'Solana' : 'Base'} · Posts delivered: ${campaign.totalPosts ?? 0}`,
    `💎 Buy Bot: ${campaign.buyBotEnabled ? (campaign.buyBotPaused ? '⏸ PAUSED (toggle below or /manage)' : '▶️ ON — buys post into your slot groups') : 'OFF — toggle below to watch buys'}`,
  ];
  if (campaign.contractAddress) lines.push(`CA: ${campaign.contractAddress}`);
  if (campaign.verificationSummary) lines.push(`🛡️ Scan: ${campaign.verificationSummary}`);
  lines.push('', `Slots (${slots.length}/${Number.isFinite(acc.limits.campaignSlots) ? acc.limits.campaignSlots : '∞'}):`);
  if (!slots.length) lines.push('• none yet — add one in the Mini App.');
  for (const s of slots) {
    const last = s.lastSentAt ? new Date(s.lastSentAt).toLocaleString('en-US', { timeZone: 'UTC' }) : 'never';
    lines.push(`• ${s.targetTitle ?? s.targetChatId} — ${s.active ? 'on' : 'off'} · every ${intervalLabel(effectiveIntervalMinutes(campaign, s))} · last post ${last}`);
  }
  return lines.join('\n');
}

async function buildPanel(ownerId) {
  const acc = await getCampaignAccess(ownerId);
  if (!acc.access) return { text: CAMPAIGN_GATE_TEXT, reply_markup: null };
  const campaign = await getOwnCampaign(ownerId);
  const text = await campaignSummaryText(ownerId);
  if (!campaign) {
    return { text, reply_markup: { inline_keyboard: [[{ text: '🛠 Set up in chat', callback_data: 'setupwiz:start' }]] } };
  }
  const slots = (await listOwnSlots(ownerId)).filter((s) => s.campaignId === campaign.id);
  const kb = [[{
    text: campaign.status === 'active' ? '⏸ Pause campaign' : '▶️ Resume campaign',
    callback_data: 'campaign:toggle',
  }], [{
    text: campaign.buyBotEnabled ? '💎 Buy Bot: ON — tap to disable' : '💎 Buy Bot: OFF — tap to enable',
    callback_data: 'campaign:buybot',
  }], [{
    text: '🛠 Edit in chat', callback_data: 'setupwiz:start',
  }]];
  for (const s of slots.slice(0, 8)) {
    kb.push([{
      text: `${s.active ? '⏸' : '▶️'} ${String(s.targetTitle ?? s.targetChatId).slice(0, 24)}`,
      callback_data: `campaign:slot:${s.id}`,
    }]);
  }
  kb.push([{ text: '🔄 Refresh', callback_data: 'campaign:view' }]);
  return { text, reply_markup: { inline_keyboard: kb } };
}

async function editPanel(userId, messageId, panel) {
  if (!messageId) return;
  await api.editMessageText({
    chat_id: userId, message_id: messageId, text: panel.text,
    ...(panel.reply_markup ? { reply_markup: panel.reply_markup } : {}),
    disable_web_page_preview: true,
  }).catch(() => {});
}

export const CAMPAIGN_COMMANDS = {
  campaign: async (chatId, args, msg) => {
    const uid = msg?.from?.id;
    if (!uid) return;
    if (msg.chat?.type !== 'private') {
      try {
        await api.sendMessage({
          chat_id: chatId,
          text: '📣 Campaigns are yours alone — manage them in a DM with me (/campaign) or in the Mini App (More → 📣 My Campaign).',
        });
      } catch { /* group send failed */ }
      return;
    }
    const panel = await buildPanel(uid);
    try {
      await api.sendMessage({
        chat_id: chatId, text: panel.text,
        ...(panel.reply_markup ? { reply_markup: panel.reply_markup } : {}),
        disable_web_page_preview: true,
      });
    } catch { /* blocked */ }
  },
};

/** Button router for `campaign:*` callbacks. Caller answers the query. */
export async function handleCampaignCallback({ userId, data, messageId }) {
  const uid = userId;
  const sub = data.slice('campaign:'.length);
  if (sub === 'view') {
    await editPanel(uid, messageId, await buildPanel(uid));
    return { text: undefined };
  }
  if (sub === 'toggle') {
    try {
      const campaign = await getOwnCampaign(uid);
      if (!campaign) return { text: 'No campaign yet — set one up in the Mini App.', alert: true };
      await setOwnCampaignStatus(uid, campaign.status === 'active' ? 'paused' : 'active');
      await editPanel(uid, messageId, await buildPanel(uid));
      return { text: campaign.status === 'active' ? '⏸ Campaign paused' : '▶️ Campaign resumed' };
    } catch (err) {
      return { text: String(err?.message ?? 'Campaign error').slice(0, 190), alert: true };
    }
  }
  if (sub === 'buybot') {
    // Buy Bot enable/disable (Buy Bot Phase 3): writes the SAME
    // buy_bot_enabled column the /manage panel's mng:bbtoggle writes,
    // and the tick's cycleBuyWatch re-checks the owner's tier at fire
    // time either way. Enable time gate = campaign access (Starter+ /
    // owner), the same floor the engine enforces.
    try {
      const campaign = await getOwnCampaign(uid);
      if (!campaign) return { text: 'No campaign yet — set one up first.', alert: true };
      const next = !campaign.buyBotEnabled;
      if (next) {
        const acc = await getCampaignAccess(uid);
        if (!acc.access) return { text: CAMPAIGN_GATE_TEXT, alert: true };
        if (!campaign.contractAddress) {
          return { text: '⚠️ Add a contract address to your campaign first (🛠 Edit in chat) — Buy Bot watches the token\'s buys.', alert: true };
        }
      }
      await db.update(user_campaigns)
        .set({ buyBotEnabled: next, updatedAt: new Date() })
        .where(eq(user_campaigns.id, campaign.id)).run();
      await editPanel(uid, messageId, await buildPanel(uid));
      return { text: next ? '💎 Buy Bot ON — qualifying buys will post into your slot groups.' : '💎 Buy Bot OFF — settings and history are kept.' };
    } catch (err) {
      return { text: String(err?.message ?? 'Buy Bot error').slice(0, 190), alert: true };
    }
  }
  if (sub.startsWith('slot:')) {
    const slotId = Number(sub.slice('slot:'.length));
    try {
      const slot = await getOwnSlot(uid, slotId);
      if (!slot) return { text: 'That slot is not on your campaign.', alert: true };
      await updateOwnSlot(uid, slotId, { active: !slot.active });
      await editPanel(uid, messageId, await buildPanel(uid));
      return { text: slot.active ? '⏸ Slot paused' : '▶️ Slot resumed' };
    } catch (err) {
      return { text: String(err?.message ?? 'Slot error').slice(0, 190), alert: true };
    }
  }
  return { text: undefined };
}

// ── /setup wizard (member-campaign creation, in-chat) ────────────────────────
// Restores the original's /setup walk with the LIVE store: the same fields,
// validation and writes as the Mini App form — saveOwnCampaign / addOwnSlot
// above, nothing parallel. Session rides a config key (10-min TTL), DM-only,
// commands always bypass. Steps mirror normalizeCampaignInput; the interval
// step appears only for Pro/Agency (canInterval), exactly like the form.
// Discord steps from the original are dropped: live campaigns are
// Telegram-only (no discord fields exist in the live store).
const SETUP_TTL_MS = 10 * 60 * 1000;
const setupKey = (userId) => `setupwiz:${userId}`;

const SETUP_STEPS = [
  { id: 'name', field: 'projectName', label: 'Project name', required: true,
    prompt: 'What is your project called?' },
  { id: 'ticker', field: 'ticker', label: 'Ticker', required: true,
    prompt: 'Ticker symbol? Send it with or without the $ — e.g. PBAI.' },
  { id: 'contract', field: 'contractAddress', label: 'Contract address', required: false,
    prompt: 'Contract address? Send it, or tap Skip.' },
  { id: 'description', field: 'description', label: 'Description', required: false,
    prompt: 'A short description for your shill posts? Send it, or tap Skip.' },
  { id: 'website', field: 'website', label: 'Website', required: false,
    prompt: 'Website URL? Send it, or tap Skip.' },
  { id: 'telegram', field: 'telegramUsername', label: 'Telegram username', required: false,
    prompt: 'Your project\'s Telegram username (without the @)? Send it, or tap Skip.' },
  { id: 'interval', field: 'postIntervalOverride', label: 'Post interval', required: false, proOnly: true,
    prompt: `Post interval in minutes (${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}), or tap Skip for the ${DEFAULT_INTERVAL_MINUTES / 60}h default.` },
];

function setupStepsFor(sess) {
  return SETUP_STEPS.filter((s) => !s.proOnly || sess.canInterval);
}
function stepSkippable(step, sess) {
  if (!step.required) return true;
  const cur = sess.data?.[step.field];
  return cur != null && String(cur).trim() !== '';
}
async function saveSetupSession(userId, sess) {
  await setConfig(setupKey(userId), JSON.stringify(sess)).catch(() => {});
}
async function clearSetupSession(userId) {
  await setConfig(setupKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}
async function loadSetupSession(userId) {
  try {
    const raw = await getConfig(setupKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.step) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

const mdSafe = (v) => String(v ?? '').replace(/[*_`[\]]/g, '');

async function setupSend(userId, text, buttons = null) {
  await api.sendMessage({
    chat_id: userId, text, parse_mode: 'Markdown',
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  }).catch(() => {});
}

async function sendSetupStep(userId, sess) {
  const steps = setupStepsFor(sess);
  const idx = steps.findIndex((s) => s.id === sess.step);
  const step = steps[idx];
  if (!step) return;
  const cur = sess.data?.[step.field];
  const curNote = cur != null && String(cur).trim() !== ''
    ? `\n\nCurrent: ${mdSafe(String(cur).slice(0, 120))}${stepSkippable(step, sess) ? ' — send a new value, or tap Skip to keep it.' : ''}`
    : '';
  const row = [];
  if (stepSkippable(step, sess)) row.push({ text: '⏭ Skip', callback_data: 'setupwiz:skip' });
  if (sess.fromConfirm) row.push({ text: '↩️ Back to review', callback_data: 'setupwiz:back' });
  row.push({ text: '❌ Cancel', callback_data: 'setupwiz:cancel' });
  await setupSend(userId,
    sess.fromConfirm
      ? `✏️ *Edit — ${step.label}*\n${step.prompt}${curNote}`
      : `📣 *Campaign Setup — step ${idx + 1} of ${steps.length}*\n\n*${step.label}*\n${step.prompt}${curNote}`,
    [row]);
}

async function sendSetupConfirm(userId, sess) {
  const d = sess.data ?? {};
  const lines = [
    '📣 *Review your campaign*',
    '',
    `Project: ${mdSafe(d.projectName ?? '—')}`,
    `Ticker: $${mdSafe(String(d.ticker ?? '').replace(/^\$/, '').toUpperCase())}`,
    `Contract: ${mdSafe(d.contractAddress ?? '—')}`,
    `Description: ${mdSafe(String(d.description ?? '').slice(0, 200)) || '—'}`,
    `Website: ${mdSafe(d.website ?? '—')}`,
    `Telegram: ${d.telegramUsername ? '@' + mdSafe(String(d.telegramUsername).replace(/^@/, '')) : '—'}`,
  ];
  if (sess.canInterval) {
    lines.push(`Interval: ${d.postIntervalOverride ? `${d.postIntervalOverride} min` : `default (${DEFAULT_INTERVAL_MINUTES / 60}h)`}`);
  }
  lines.push('', 'Save it? You can add posting groups (slots) right after — or tap a field below to fix just that one.');
  // Gap-3 per-field edit: each button re-enters just that step (see
  // handleSetupCallback 'edit:'); completing it returns here via
  // advanceSetup's fromConfirm branch, all other fields intact.
  const editRows = [
    [
      { text: '✏️ Name', callback_data: 'setupwiz:edit:name' },
      { text: '✏️ Ticker', callback_data: 'setupwiz:edit:ticker' },
    ],
    [
      { text: '✏️ Contract', callback_data: 'setupwiz:edit:contract' },
      { text: '✏️ Description', callback_data: 'setupwiz:edit:description' },
    ],
    [
      { text: '✏️ Website', callback_data: 'setupwiz:edit:website' },
      { text: '✏️ Telegram', callback_data: 'setupwiz:edit:telegram' },
    ],
  ];
  if (sess.canInterval) {
    editRows.push([{ text: '✏️ Interval', callback_data: 'setupwiz:edit:interval' }]);
  }
  await setupSend(userId, lines.join('\n'), [
    ...editRows,
    [
      { text: '✅ Save campaign', callback_data: 'setupwiz:save' },
      { text: '❌ Cancel', callback_data: 'setupwiz:cancel' },
    ],
  ]);
}

async function advanceSetup(userId, sess) {
  const steps = setupStepsFor(sess);
  const idx = steps.findIndex((s) => s.id === sess.step);
  const next = steps[idx + 1];
  sess.expiresAt = Date.now() + SETUP_TTL_MS;
  if (sess.fromConfirm) {
    // Gap-3 field edit: completing (or skipping) the re-entered step
    // returns straight to the confirm screen, all other fields intact.
    delete sess.fromConfirm;
    sess.step = 'confirm';
    await saveSetupSession(userId, sess);
    await sendSetupConfirm(userId, sess);
    return;
  }
  if (!next) {
    sess.step = 'confirm';
    await saveSetupSession(userId, sess);
    await sendSetupConfirm(userId, sess);
  } else {
    sess.step = next.id;
    await saveSetupSession(userId, sess);
    await sendSetupStep(userId, sess);
  }
}

export async function startSetupWizard(userId) {
  const acc = await getCampaignAccess(userId);
  if (!acc.access) {
    await setupSend(userId, CAMPAIGN_GATE_TEXT);
    return false;
  }
  const existing = await getOwnCampaign(userId);
  const data = existing ? {
    projectName: existing.projectName ?? '',
    ticker: existing.ticker ?? '',
    description: existing.description ?? '',
    website: existing.website ?? null,
    contractAddress: existing.contractAddress ?? null,
    chain: existing.chain ?? null,
    telegramUsername: existing.telegramUsername ?? null,
    customButtons: existing.customButtons ?? null,
    postIntervalOverride: existing.postIntervalOverride ?? null,
  } : {};
  const sess = { step: 'name', data, canInterval: acc.canInterval, expiresAt: Date.now() + SETUP_TTL_MS };
  await saveSetupSession(userId, sess);
  await setupSend(userId, existing
    ? '📣 *Edit your campaign*\n\nI\'ll walk the same fields as the Mini App form. Nothing is written until you tap Save at the end.'
    : '📣 *New campaign*\n\nI\'ll walk the same fields as the Mini App form. Nothing is written until you tap Save at the end.');
  await sendSetupStep(userId, sess);
  return true;
}

/** DM text capture for /setup. Returns true when consumed. */
export async function handleSetupWizardText(chatId, msg) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const { sess, expired } = await loadSetupSession(userId);
  if (!sess) {
    if (expired) {
      await clearSetupSession(userId);
      await setupSend(userId, '⏰ That campaign setup expired — run /setup to start again. Nothing was saved.');
      return true;
    }
    return false;
  }
  const steps = setupStepsFor(sess);
  const step = steps.find((s) => s.id === sess.step);
  if (!step) return false; // confirm/slots steps are button-driven

  if (/^skip$/i.test(text)) {
    if (!stepSkippable(step, sess)) {
      await setupSend(userId, `⚠️ ${step.label} is required — send a value to continue.`);
      return true;
    }
    await advanceSetup(userId, sess);
    return true;
  }

  if (step.id === 'interval') {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n <= 0) {
      await setupSend(userId, `⚠️ Send the interval as a number of minutes (${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}), or tap Skip.`);
      return true;
    }
    sess.data[step.field] = n;
  } else if (step.id === 'ticker') {
    const t = text.replace(/^\$/, '').trim().toUpperCase();
    if (!t) { await setupSend(userId, '⚠️ Ticker is required — send it to continue.'); return true; }
    sess.data[step.field] = t;
  } else {
    if (step.required && !text) {
      await setupSend(userId, `⚠️ ${step.label} is required — send a value to continue.`);
      return true;
    }
    sess.data[step.field] = text;
  }
  await advanceSetup(userId, sess);
  return true;
}

/** Button router for `setupwiz:*` callbacks. Caller answers the query. */
export async function handleSetupCallback({ userId, data }) {
  const sub = data.slice('setupwiz:'.length);
  if (sub === 'start') {
    const ok = await startSetupWizard(userId);
    return ok ? { text: '📣 Campaign setup — follow the prompts here.' } : { text: 'See the message above.', alert: true };
  }
  if (sub === 'cancel') {
    await clearSetupSession(userId);
    await setupSend(userId, '❌ Campaign setup cancelled — nothing new was saved.');
    return { text: 'Setup cancelled.' };
  }
  const { sess } = await loadSetupSession(userId);
  if (!sess) return { text: '⏰ That setup session expired — run /setup again.', alert: true };

  if (sub.startsWith('edit:')) {
    // Gap-3: re-enter just one step from the confirm screen. The step
    // prompt shows the current value; completing the step returns to
    // confirm via advanceSetup's fromConfirm branch.
    if (sess.step !== 'confirm') return { text: 'Nothing to edit right now — finish the steps first.', alert: true };
    const step = setupStepsFor(sess).find((s) => s.id === sub.slice('edit:'.length));
    if (!step) return { text: 'That field can\'t be edited here.', alert: true };
    sess.step = step.id;
    sess.fromConfirm = true;
    sess.expiresAt = Date.now() + SETUP_TTL_MS;
    await saveSetupSession(userId, sess);
    await sendSetupStep(userId, sess);
    return { text: `✏️ Editing ${step.label}` };
  }

  if (sub === 'back') {
    sess.step = 'confirm';
    delete sess.fromConfirm;
    sess.expiresAt = Date.now() + SETUP_TTL_MS;
    await saveSetupSession(userId, sess);
    await sendSetupConfirm(userId, sess);
    return { text: '↩️ Back to review' };
  }

  if (sub === 'skip') {
    const steps = setupStepsFor(sess);
    const step = steps.find((s) => s.id === sess.step);
    if (!step) return { text: 'Nothing to skip right now.', alert: true };
    if (!stepSkippable(step, sess)) return { text: `⚠️ ${step.label} is required.`, alert: true };
    await advanceSetup(userId, sess);
    return { text: '⏭ Skipped.' };
  }

  if (sub === 'save') {
    if (sess.step !== 'confirm') return { text: 'Finish the steps first.', alert: true };
    try {
      const acc = await getCampaignAccess(userId);
      if (!acc.access) {
        await clearSetupSession(userId);
        await setupSend(userId, CAMPAIGN_GATE_TEXT);
        return { text: 'Plan required.', alert: true };
      }
      const row = await saveOwnCampaign(userId, sess.data ?? {});
      sess.step = 'slots';
      sess.expiresAt = Date.now() + SETUP_TTL_MS;
      await saveSetupSession(userId, sess);
      const groups = await getMyGroupsFor(userId).catch(() => []);
      const existing = (await listOwnSlots(userId)).filter((s) => s.campaignId === row.id);
      const existingIds = new Set(existing.map((s) => String(s.targetChatId)));
      const addable = groups.filter((g) => !existingIds.has(String(g.chatId)));
      const lines = [
        `✅ *Campaign saved:* ${mdSafe(row.projectName)} ($${mdSafe(row.ticker)}) — ${row.status === 'active' ? '▶️ ACTIVE' : '⏸ PAUSED'}`,
      ];
      if (row.verificationSummary) lines.push(`🛡️ Scan: ${row.verificationSummary}`);
      lines.push('');
      if (addable.length) {
        lines.push('Add posting slots — pick the groups PB should post this campaign to (you must admin them):');
        await setupSend(userId, lines.join('\n'), [
          ...addable.map((g) => [{ text: `➕ ${g.title}`, callback_data: `setupwiz:slot:${g.chatId}` }]),
          [{ text: '✅ Done', callback_data: 'setupwiz:done' }],
        ]);
      } else {
        lines.push(existing.length
          ? 'All your admin groups are already slots on this campaign. Manage them any time with /campaign.'
          : 'No groups you admin are available for slots yet. Add PB to your group, admin it, then add slots with /campaign.');
        await setupSend(userId, lines.join('\n'));
        await clearSetupSession(userId);
      }
      return { text: '✅ Campaign saved.' };
    } catch (err) {
      return { text: String(err?.message ?? 'Save failed').slice(0, 190), alert: true };
    }
  }

  if (sub.startsWith('slot:')) {
    if (sess.step !== 'slots') return { text: 'Save the campaign first.', alert: true };
    const targetChatId = sub.slice('slot:'.length);
    try {
      const slot = await addOwnSlot(userId, { targetChatId });
      await setupSend(userId, `✅ Slot added — PB will post your campaign in *${mdSafe(slot.targetTitle ?? targetChatId)}* on its rhythm. Add another above, or tap Done.`);
      return { text: '➕ Slot added.' };
    } catch (err) {
      return { text: String(err?.message ?? 'Slot error').slice(0, 190), alert: true };
    }
  }

  if (sub === 'done') {
    await clearSetupSession(userId);
    await setupSend(userId, '✅ All set. Review or pause your campaign any time with /campaign.');
    return { text: '✅ Done.' };
  }

  return { text: undefined };
}

export const SETUP_COMMANDS = {
  setup: async (chatId, _args, msg) => {
    const uid = msg?.from?.id;
    if (!uid) return;
    if (msg.chat?.type !== 'private') {
      await api.sendMessage({
        chat_id: chatId,
        text: '📣 Campaign setup is personal — open a DM with me and run /setup there.',
      }).catch(() => {});
      return;
    }
    await startSetupWizard(uid);
  },
};
