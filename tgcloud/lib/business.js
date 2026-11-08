// PB Business bot — Telegram Business connection logic (restored 2026-10-19).
// Ports the business half of the original api-server webhook route
// (routes/webhook.ts) + access lib (lib/business-bot-access.ts) to tgcloud.
// Business mode lets a user connect @PoorBoyAI_bot to their own Telegram
// Business account; PB then replies to that account's customer DMs in the
// owner's configured mode, on the Business connection — never in groups.
//
// Privacy shape (stricter than the original, deliberate): nothing beyond
// the connection + settings rows is stored. Business message content is
// read to produce a reply and never archived, logged in full, or surfaced
// in any group, board, or another user's view.

import { api } from 'sdk';
import db, { eq } from 'sdk/db';
import { bot_users, business_connections } from '../schema.js';
import { getBusinessSettings, setBusinessSettings } from './accounts.js';
import { getConfig, setConfig } from './config.js';
import { isOwnerId, shieldScamMatch, cleanupParseDuration } from './groups.js';
import { askLLM } from './llm.js';
import { canonicalTier, tierRank } from './tiers.js';

// ── Tier gate (source: lib/business-bot-access.ts —
// canUseTelegramBusinessBot: owner, or tier ≥ the catalog's
// businessBot.minimumTier = "starter") ───────────────────────────────────────
// Audit F2 fix: this module originally carried a VERBATIM copy of the
// source's ACCESS_TIER_RANK / TIER_ALIAS — whose legacy aliases diverge
// from PB's canonical map (source: hustler→builder, poor→builder,
// grinder→pro, chad→agency; canonical lib/tiers.js: hustler→free,
// poor→starter, grinder→builder, chad→pro). Every legacy name was
// over-ranked by one tier here, so a legacy 'hustler' account —
// canonically Free — passed this Starter+ gate. Resolution now goes
// through lib/tiers.js, the single source every other gate uses;
// the exported names stay for compatibility.
export function resolveAccessTier(tier) {
  return canonicalTier(tier);
}

/** Tier gate: the stored tier value resolves (canonically) to Starter+. */
export function isBusinessBotTier(tier) {
  return tierRank(tier) >= tierRank('starter');
}

/**
 * The user's subscription tier, mirroring the source's
 * getTierForTelegramUser: the bot_users row, with an expired subscription
 * counting as no tier (source filtered on subscription_expires_at > NOW).
 */
export async function getTierForTelegramUser(tgId) {
  try {
    const row = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(tgId))).get();
    if (!row) return null;
    const exp = row.subscriptionExpiresAt;
    if (exp) {
      const expMs = exp instanceof Date ? exp.getTime() : new Date(exp).getTime();
      if (Number.isFinite(expMs) && expMs <= Date.now()) return null;
    }
    return row.tier ?? null;
  } catch {
    return null;
  }
}

/** canUseTelegramBusinessBot: verified owner OR qualifying tier. */
export async function canUseBusinessBot(tgId) {
  if (await isOwnerId(tgId).catch(() => false)) return true;
  return isBusinessBotTier(await getTierForTelegramUser(tgId));
}

// ── Settings (source: loadBizSettings + DEFAULT_BIZ_SETTINGS) ────────────────
export const DEFAULT_BIZ_SETTINGS = {
  aiEnabled: true,
  replyMode: 'ai',
  customSystemPrompt: null,
  fallbackMessage: null,
  fixedMessage: null,
  greetingMessage: null,
};

/** Load the connection owner's settings (lib/accounts.js store), with the
 *  source's defaults when no row exists.
 *
 *  Owner special case: the migration folded the owner's single original
 *  business_bot_settings row into PB's config as the business_bot_* keys
 *  (design §6) and no table row was ever re-created for him. When the
 *  config's business_bot_owner has no table row, his settings ARE those
 *  config keys — read them, so his configured mode (fixed, all message
 *  bodies null) is honored instead of silently falling back to defaults. */
export async function loadBizSettings(ownerTgId) {
  const row = await getBusinessSettings(ownerTgId);
  if (!row) {
    const cfgOwner = await getConfig('business_bot_owner').catch(() => null);
    if (cfgOwner && String(cfgOwner) === String(ownerTgId)) {
      const [aiEnabled, replyMode, systemPrompt, fallback, fixed, greeting] = await Promise.all([
        getConfig('business_bot_ai_enabled').catch(() => null),
        getConfig('business_bot_reply_mode').catch(() => null),
        getConfig('business_bot_system_prompt').catch(() => null),
        getConfig('business_bot_fallback_message').catch(() => null),
        getConfig('business_bot_fixed_message').catch(() => null),
        getConfig('business_bot_greeting_message').catch(() => null),
      ]);
      return {
        aiEnabled: aiEnabled !== 'false',
        replyMode: replyMode || 'ai',
        customSystemPrompt: systemPrompt || null,
        fallbackMessage: fallback || null,
        fixedMessage: fixed || null,
        greetingMessage: greeting || null,
      };
    }
    return { ...DEFAULT_BIZ_SETTINGS };
  }
  return {
    aiEnabled: row.aiEnabled !== false,
    replyMode: row.replyMode ?? 'ai',
    customSystemPrompt: row.customSystemPrompt ?? null,
    fallbackMessage: row.fallbackMessage ?? null,
    fixedMessage: row.fixedMessage ?? null,
    greetingMessage: row.greetingMessage ?? null,
  };
}

// ── Reply copy (source: webhook.ts, verbatim prompts) ────────────────────────
export const DEFAULT_SYSTEM_PROMPT = `You are PB, the AI assistant for PoorBoyAI ($PBAI) — the world's most complete crypto community bot.
You are responding on behalf of a Telegram Business account connected to @PoorBoyAI_bot.
Be helpful, concise, and on-brand: scrappy, smart, and crypto-savvy.
If the user asks about crypto prices, tokens, or trading — give your best honest take.
Keep replies under 200 words. Plain text only, no markdown.
Always stay positive and represent the PoorBoy Army.
Your name is PB — never introduce yourself as Grok or as any other model, and never say you were built by xAI. You were built by Rowdy Rawdon, founder of PoorBoyAI. If asked whether you're a bot, what you are, or who built you, say you're PB, built by Rowdy Rawdon — PoorBoyAI's AI agent, answering on behalf of this account. If pressed on the underlying tech, one line only: PB is powered by PoorBoyAI, run by PoorBoyAI — then back to helping.`;

export const DEFAULT_FALLBACK = "Hey! PB here 🤖 — I'm the AI behind @PoorBoyAI_bot. Drop me a crypto question or check out poorboyai.pages.dev for the full toolkit. PoorBoy Army never sleeps. 💪";

/** getBusinessAIReply: LLM with the owner's custom system prompt (or the
 *  default PB business persona); the configured fallback on LLM failure. */
export async function getBusinessAIReply(userText, settings) {
  const fallback = settings.fallbackMessage?.trim() || DEFAULT_FALLBACK;
  try {
    const reply = await askLLM({
      systemPrompt: settings.customSystemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
      userMessage: userText,
      maxOutputTokens: 500,
    });
    return (reply ?? '').trim() || fallback;
  } catch {
    return fallback;
  }
}

// ── Sends (source: webhook.ts sendBusinessReply / sendDM) ────────────────────
// Plain text in v1 (no Markdown/HTML layer, per the project rule); the text
// bodies are the source's own, HTML tags and all harmlessly readable.

/** Reply inside a Business chat — the business_connection_id parameter is
 *  what routes the send onto the owner's Business account. */
export async function sendBusinessReply(chatId, businessConnectionId, text) {
  const sent = await api.sendMessage({
    chat_id: chatId,
    business_connection_id: businessConnectionId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });
  // PB Cleanup phase 2 capture seam (2026-10-22): record PB's own sent
  // message (metadata only) for the owner's manual sweep. Self-gating —
  // records ONLY while this connection's business cleanup is ON; never
  // throws, so a tidy failure can never break a customer reply.
  await bizCleanupNoteOwn(businessConnectionId, chatId, sent).catch(() => {});
  return sent;
}

/** Plain DM to a user (owner notifications). Best-effort: never throws. */
export async function sendOwnerDM(userId, text) {
  try {
    await api.sendMessage({ chat_id: userId, text: String(text).slice(0, 4000) });
  } catch (err) {
    console.error('[business dm]', err?.code ?? '', err?.description ?? err?.message ?? err);
  }
}

// ── Tier-block owner nag, throttled (audit F3 fix) ────────────────────────
// While a connection owner's tier is below the gate, EVERY customer
// message used to fire this identical owner DM — a busy business chat
// became a DM flood. The nag is about the CONNECTION's tier state, not
// about any one customer, so the bound is per connection: at most one
// nag per connection per 24h (a config timestamp row — the audit's
// suggested shape; it also caps total nag volume at one per connection
// per day no matter how many distinct customers write in, which a
// per-customer bound would not). The block itself is unchanged —
// customers still get no reply; only the owner's notification is paced.
// The timestamp is stamped BEFORE the send attempt so a failed stamp
// can never produce a duplicate.
const TIER_NAG_INTERVAL_MS = 24 * 60 * 60 * 1000;
const tierNagKey = (connectionId) => `biz_tier_nag:${connectionId}`;

export async function sendTierBlockNag(ownerTgId, connectionId) {
  try {
    const last = Number(await getConfig(tierNagKey(connectionId), '0')) || 0;
    if (Date.now() - last < TIER_NAG_INTERVAL_MS) return false;
    await setConfig(tierNagKey(connectionId), String(Date.now()));
    await sendOwnerDM(ownerTgId,
      `⚠️ Business Bot paused\n\n` +
      `A customer just messaged you but AI auto-replies require an active Starter+ plan.\n\n` +
      `Upgrade in the PB app — open @PoorBoyAI_bot and tap the menu button — to activate it.`);
    return true;
  } catch {
    return false;
  }
}

// ── Connection store (source: business_connections upserts in webhook.ts) ──

export async function getBusinessConnection(connectionId) {
  return db.select().from(business_connections)
    .where(eq(business_connections.connectionId, String(connectionId)))
    .get().catch(() => null);
}

/** Insert/update the connection row on connect (source INSERT … ON CONFLICT). */
export async function upsertBusinessConnection(connectionId, ownerTgId, tierAllowed) {
  await db.insert(business_connections).values({
    connectionId: String(connectionId),
    ownerTelegramId: String(ownerTgId),
    isActive: true,
    tierAllowed: !!tierAllowed,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: business_connections.connectionId,
    set: {
      ownerTelegramId: String(ownerTgId),
      isActive: true,
      tierAllowed: !!tierAllowed,
      updatedAt: new Date(),
    },
  }).run();
}

export async function setBusinessConnectionActive(connectionId, isActive) {
  await db.update(business_connections).set({ isActive: !!isActive, updatedAt: new Date() })
    .where(eq(business_connections.connectionId, String(connectionId))).run();
}

export async function setBusinessConnectionTierAllowed(connectionId, tierAllowed) {
  await db.update(business_connections).set({ tierAllowed: !!tierAllowed, updatedAt: new Date() })
    .where(eq(business_connections.connectionId, String(connectionId))).run();
}

// ── Settings editor (Dashboard wave item 1) ─────────────────────────────────
// The editor writes EXACTLY what loadBizSettings / business_message reads:
//   • a business_bot_settings table row when one exists (or for any
//     non-owner-pattern user — setBusinessSettings creates it), and
//   • the business_bot_* config keys when the user is the config owner
//     (business_bot_owner) AND has no table row — the owner's migrated
//     pattern. Writing the table for him instead would shadow his config
//     values with a partial row, so the store follows the read path.

export const BIZ_MODES = ['ai', 'fixed', 'greeting_then_ai'];

/** Internal patch keys → config keys (owner pattern). */
const BIZ_CONFIG_KEYS = {
  aiEnabled: 'business_bot_ai_enabled',
  replyMode: 'business_bot_reply_mode',
  customSystemPrompt: 'business_bot_system_prompt',
  fallbackMessage: 'business_bot_fallback_message',
  fixedMessage: 'business_bot_fixed_message',
  greetingMessage: 'business_bot_greeting_message',
};

/** Save a settings patch (internal field names) to the store loadBizSettings reads. */
export async function saveBizSettings(ownerTgId, patch) {
  const row = await getBusinessSettings(ownerTgId);
  if (!row) {
    const cfgOwner = await getConfig('business_bot_owner').catch(() => null);
    if (cfgOwner && String(cfgOwner) === String(ownerTgId)) {
      for (const [field, value] of Object.entries(patch)) {
        const key = BIZ_CONFIG_KEYS[field];
        if (!key) continue;
        const stored = field === 'aiEnabled' ? (value ? 'true' : 'false') : (value ?? '');
        await setConfig(key, stored);
      }
      return;
    }
  }
  await setBusinessSettings(ownerTgId, patch);
}

/** The caller's own active Business connection, if any. */
export async function getBusinessConnectionForOwner(ownerTgId) {
  try {
    const rows = await db.select().from(business_connections)
      .where(eq(business_connections.ownerTelegramId, String(ownerTgId))).all();
    return rows.find((r) => r.isActive) ?? null;
  } catch {
    return null;
  }
}

/**
 * Endpoint-shaped settings view for ONE user (Mini App editor + /bizsetup).
 * Ineligible users get eligible:false and empty fields — never anyone
 * else's settings. `connection.connected` is the caller's own connection
 * state only.
 */
export async function businessSettingsView(tgId) {
  const eligible = await canUseBusinessBot(tgId).catch(() => false);
  const conn = await getBusinessConnectionForOwner(tgId);
  const connected = Boolean(conn);
  if (!eligible) {
    return {
      ok: true, eligible: false, mode: 'ai', aiEnabled: false,
      systemPrompt: null, greetingMessage: null, fixedMessage: null,
      fallbackMessage: null, connection: { connected },
    };
  }
  const s = await loadBizSettings(tgId);
  return {
    ok: true, eligible: true, mode: s.replyMode, aiEnabled: s.aiEnabled,
    systemPrompt: s.customSystemPrompt, greetingMessage: s.greetingMessage,
    fixedMessage: s.fixedMessage, fallbackMessage: s.fallbackMessage,
    connection: { connected },
  };
}

// ── /bizsetup in-bot editor wizard ──────────────────────────────────────────
// DM prompt flow for the message bodies + persona, reusing the project's
// config-table wizard-state machinery (same pattern as lib/contests.js:
// state lives in config keyed by user, 15-min TTL, isolates are stateless).
// Only the wizard owner's own next DM text is consumed, and only while a
// field is awaiting input; commands always bypass (caller checks '/').

const BIZ_WIZ_TTL_MS = 15 * 60 * 1000;
const bizWizKey = (userId) => `bizwiz:${userId}`;

/** Wizard field name → internal settings field + display label. */
export const BIZ_WIZ_FIELDS = {
  greeting: { field: 'greetingMessage', label: 'greeting message' },
  fixed: { field: 'fixedMessage', label: 'fixed message' },
  fallback: { field: 'fallbackMessage', label: 'fallback message' },
  persona: { field: 'customSystemPrompt', label: 'persona (system prompt)' },
};

export async function setBizWizardAwaiting(userId, wizField) {
  await setConfig(bizWizKey(userId), JSON.stringify({ awaiting: wizField, createdAt: Date.now() })).catch(() => {});
}

export async function clearBizWizard(userId) {
  // config has no delete helper; an expired timestamp retires the session.
  await setConfig(bizWizKey(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

async function loadBizWizard(userId) {
  try {
    const raw = await getConfig(bizWizKey(userId), null);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w?.awaiting || Date.now() - (w.createdAt ?? 0) > BIZ_WIZ_TTL_MS) return null;
    return w;
  } catch { return null; }
}

/**
 * Text-step capture for the /bizsetup editor. Returns true when the message
 * was consumed as a field value. Re-checks eligibility server-side, caps
 * values at 2000 chars, and writes through saveBizSettings (the same store
 * business_message reads). Confirmation goes to the user's own DM only.
 */
export async function handleBizWizardText(userId, text) {
  if (!userId || !text || text.startsWith('/')) return false;
  const wiz = await loadBizWizard(userId);
  if (!wiz) return false;
  const spec = BIZ_WIZ_FIELDS[wiz.awaiting];
  await clearBizWizard(userId);
  if (!spec) return true; // stale field name — consumed, nothing written
  if (!(await canUseBusinessBot(userId).catch(() => false))) {
    await sendOwnerDM(userId, '🏢 Business Bot editor: your plan no longer includes Business Bot (Starter+), so that change was not saved.');
    return true;
  }
  const value = String(text).trim().slice(0, 2000);
  await saveBizSettings(userId, { [spec.field]: value || null });
  await sendOwnerDM(userId, `✅ Business Bot ${spec.label} saved. Run /bizsetup to review or change anything else.`);
  return true;
}

// ══ PB Cleanup phase 2 — business-chat tidy (2026-10-22) ════════════════
// Rowdy approved 2026-10-22 ("Build it as Cleanup phase 2"), right after
// phase 1 (group /cleanup, lib/groups.js) landed. Telegram's Bot API gives
// a connected business bot `deleteBusinessMessages` (batches of 1–100 ids,
// all from the same chat, on behalf of the account). What PB may delete is
// set by the rights the account owner granted at connect time:
//   • can_delete_sent_messages — only messages PB itself sent via the
//     connection (its customer replies);
//   • can_delete_all_messages  — any message in the connected chats.
// Built strictly inside the same truth as phase 1: PB can only act on
// messages it sees as they arrive or has recorded — no history scans.
//
//  • Recording (DEFAULT OFF, per connection): while a connection's
//    cleanup is ON, the business_message handler evaluates each incoming
//    message against the junk rules at arrival (Shield's scam-phrase
//    library via lib/groups.js shieldScamMatch + the owner's custom
//    phrases) and records METADATA ONLY — {c,m,t,k,r} — never text.
//    PB's own sends through sendBusinessReply record as kind 'o'.
//  • Auto-delete: flagged junk (kind 'j') is swept by the tick's
//    bizCleanup cycle after the owner's GRACE period (default 15m,
//    owner-settable incl. 0) — never instantly, so a false positive can
//    be seen first. Requires can_delete_all_messages; without it, junk
//    is flagged and counted but never auto-deleted.
//  • Manual sweep (/bizclean sweep): preview counts per chat, then an
//    explicit `sweep confirm` within 10 minutes before anything is
//    deleted — deletes are irreversible. Covers flagged junk (needs the
//    all-messages right) and PB's own recorded sent messages (needs
//    either delete right).
//  • State: ONE config row per connection (`bizclean:<connectionId>`),
//    the tier-nag precedent below. Ring hard cap BIZCLEAN_RING_MAX,
//    pruned on every touch and by the tick cycle.
//
// HARD RAILS: the connection owner's OWN outgoing messages (sent by the
// owner personally) are NEVER recorded and NEVER deleted — excluded by
// sender at record time (bizCleanupObserve). PB's own sent messages are
// NEVER auto-deleted (manual confirmed sweep only). Nothing is recorded
// or deleted for cleanup-off (default) or inactive connections. Sealed
// per connection — state is keyed by connectionId and every read/write
// goes through that connection's row only. Deletion failures are silent
// no-ops (successes counted only, 429 carries the remainder); a rights
// error turns auto-delete OFF for that connection and surfaces in
// /bizclean status — no error loops.

const BIZCLEAN_RING_MAX = 500;
const BIZCLEAN_CLEAN_KEEP_SEC = 24 * 3600;      // kind 'i' (clean) entries
const BIZCLEAN_STALE_SEC = 7 * 24 * 3600;       // kind 'j'/'o' entries
const BIZCLEAN_GRACE_DEFAULT_SEC = 15 * 60;
const BIZCLEAN_GRACE_MAX_SEC = 48 * 3600;
const BIZCLEAN_PHRASES_MAX = 50;
const BIZCLEAN_CYCLE_DELETE_CAP = 60;           // auto sweep, per tick, all connections
const BIZCLEAN_SWEEP_DELETE_CAP = 200;          // manual sweep, per confirmed run
const BIZCLEAN_BATCH_MAX = 100;                 // deleteBusinessMessages API batch
const BIZCLEAN_SWEEP_CONFIRM_MS = 10 * 60 * 1000;
const BIZCLEAN_RIGHTS_TTL_MS = 5 * 60 * 1000;

const bizCleanKey = (connectionId) => `bizclean:${connectionId}`;
const bizCleanSweepKey = (ownerTgId) => `bizclean_sweep:${ownerTgId}`;
const bizCleanNowSec = () => Math.floor(Date.now() / 1000);

const BIZCLEAN_DEFAULT_STATE = {
  enabled: false,
  graceSec: BIZCLEAN_GRACE_DEFAULT_SEC,
  phrases: [],
  ring: [],
  delJunk: 0,
  delOwn: 0,
  autoOff: false,
  autoOffNote: null,
};

/** Load one connection's cleanup state (defaults merged). Returns null
 *  when the connection has NO state row — i.e. cleanup was never touched,
 *  which every reader treats as OFF with nothing recorded. */
export async function bizCleanLoadState(connectionId) {
  try {
    const raw = await getConfig(bizCleanKey(connectionId), null);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    return {
      ...BIZCLEAN_DEFAULT_STATE,
      ...s,
      phrases: Array.isArray(s.phrases) ? s.phrases : [],
      ring: Array.isArray(s.ring) ? s.ring : [],
    };
  } catch { return null; }
}

export async function bizCleanSaveState(connectionId, state) {
  await setConfig(bizCleanKey(connectionId), JSON.stringify(state)).catch(() => {});
}

/** Prune + ring-cap a recorded list. Pure — harness-provable. Clean
 *  ('i') entries age out in 24h; junk ('j') and own-sent ('o') entries
 *  in 7d; the ring keeps the newest BIZCLEAN_RING_MAX. */
export function bizCleanPruneRing(list, nowSec) {
  const arr = (Array.isArray(list) ? list : [])
    .filter((e) => e && Number.isFinite(Number(e.c)) && Number.isFinite(Number(e.m))
      && Number.isFinite(Number(e.t)) && ['j', 'i', 'o'].includes(e.k)
      && (nowSec - Number(e.t)) <= (e.k === 'i' ? BIZCLEAN_CLEAN_KEEP_SEC : BIZCLEAN_STALE_SEC))
    .map((e) => ({
      c: Number(e.c), m: Number(e.m), t: Number(e.t), k: e.k,
      ...(e.k === 'j' && e.r ? { r: String(e.r) } : {}),
    }));
  return arr.slice(-BIZCLEAN_RING_MAX);
}

function bizCleanGraceOf(state) {
  const n = Number(state?.graceSec);
  return Number.isFinite(n) && n >= 0 && n <= BIZCLEAN_GRACE_MAX_SEC
    ? Math.floor(n) : BIZCLEAN_GRACE_DEFAULT_SEC;
}

function bizCleanFmtDur(sec) {
  if (sec === 0) return '0m (immediate on the next clock run)';
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

// ── Live rights (getBusinessConnection, cached 5m — Shield's idiom) ─────

const bizRightsCache = new Map(); // connectionId -> { at, ok, all, sent }

/** The connection's live delete rights from Telegram. `all` =
 *  can_delete_all_messages, `sent` = can_delete_sent_messages. ok:false
 *  means the read itself failed — callers must treat that as "unknown",
 *  never as permission. */
export async function bizCleanRights(connectionId, { force = false } = {}) {
  const key = String(connectionId);
  const hit = bizRightsCache.get(key);
  if (!force && hit && Date.now() - hit.at < BIZCLEAN_RIGHTS_TTL_MS) return hit;
  let out = { at: Date.now(), ok: false, all: false, sent: false };
  try {
    const bc = await api.getBusinessConnection({ business_connection_id: key });
    const r = bc?.rights ?? {};
    out = {
      at: Date.now(), ok: true,
      all: r.can_delete_all_messages === true,
      sent: r.can_delete_sent_messages === true,
    };
  } catch { /* unreadable rights = unknown; status says so plainly */ }
  bizRightsCache.set(key, out);
  return out;
}

/** Junk evaluation: Shield's scam-phrase library (built-ins) + the
 *  owner's custom phrases. Returns the matched rule label or null. */
export function bizCleanMatchJunk(state, text) {
  return shieldScamMatch(text, state?.phrases ?? []);
}

// ── Recording seams ───────────────────────────────────────────────────────

/** Record one incoming business message (metadata only — NEVER text).
 *  Called by handlers/business_message.js after the connection resolves
 *  ACTIVE. Self-gating: records only while THIS connection's cleanup is
 *  ON. RAIL: the connection owner's own outgoing messages and bot
 *  senders are excluded by sender, here, at record time. Never throws. */
export async function bizCleanupObserve(bm, conn) {
  try {
    if (!bm || !conn?.connectionId || !conn.isActive) return false;
    const from = bm.from;
    if (!from || from.is_bot) return false;
    if (String(from.id) === String(conn.ownerTelegramId)) return false;
    const chatId = Number(bm.chat?.id);
    const mid = Number(bm.message_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(mid)) return false;
    const text = String(bm.text ?? bm.caption ?? '');
    if (!text.trim()) return false;
    const state = await bizCleanLoadState(conn.connectionId);
    if (!state || state.enabled !== true) return false;
    const label = bizCleanMatchJunk(state, text);
    const now = bizCleanNowSec();
    const ring = bizCleanPruneRing(state.ring, now);
    if (ring.some((e) => e.c === chatId && e.m === mid)) return true;
    ring.push({ c: chatId, m: mid, t: now, k: label ? 'j' : 'i', ...(label ? { r: label } : {}) });
    state.ring = ring.slice(-BIZCLEAN_RING_MAX);
    await bizCleanSaveState(conn.connectionId, state);
    return true;
  } catch { return false; }
}

/** Record a message PB itself just sent via a business connection
 *  (kind 'o' — the sendBusinessReply capture seam). Self-gating like
 *  the observe seam; never throws. PB's own sent messages are NEVER
 *  auto-deleted — they leave only through a confirmed manual sweep. */
export async function bizCleanupNoteOwn(connectionId, chatId, sent) {
  try {
    const mid = Number(sent?.message_id);
    const c = Number(chatId);
    if (!connectionId || !Number.isFinite(c) || !Number.isFinite(mid)) return false;
    const state = await bizCleanLoadState(connectionId);
    if (!state || state.enabled !== true) return false;
    const now = bizCleanNowSec();
    const ring = bizCleanPruneRing(state.ring, now);
    if (ring.some((e) => e.c === c && e.m === mid)) return true;
    ring.push({ c: c, m: mid, t: now, k: 'o' });
    state.ring = ring.slice(-BIZCLEAN_RING_MAX);
    await bizCleanSaveState(connectionId, state);
    return true;
  } catch { return false; }
}

// ── Deletion core (auto sweep + manual sweep share the batching) ────────

const bizCleanIsRightsError = (err) => err?.code === 403
  || /not enough rights|forbidden/i.test(String(err?.description ?? err?.message ?? ''));
const bizCleanIsRateError = (err) => err?.code === 429
  || /too many requests|retry after/i.test(String(err?.description ?? err?.message ?? ''));

/** Delete recorded entries of one kind for ONE connection, grouped per
 *  chat and batched ≤100 per deleteBusinessMessages call, under a total
 *  attempt budget. Mutates state's ring/counters for successes only —
 *  entries whose delete fails non-rights/non-rate (already gone,
 *  undeletable) are dropped from the ring but NEVER counted as deleted.
 *  Returns { deleted, attempts, stopped } — stopped: null | 'cap' |
 *  'rate' | 'rights' (a rights error also flips state.autoOff). */
async function bizCleanDeleteKind(connectionId, state, kind, entries, budget) {
  let deleted = 0;
  let attempts = 0;
  let stopped = null;
  const goneKeys = new Set(); // `${c}:${m}` removed from the ring either way
  const byChat = new Map();
  for (const e of entries) {
    if (!byChat.has(e.c)) byChat.set(e.c, []);
    byChat.get(e.c).push(e.m);
  }
  outer:
  for (const [chatId, ids] of byChat) {
    for (let i = 0; i < ids.length; i += BIZCLEAN_BATCH_MAX) {
      const room = budget - attempts;
      if (room <= 0) { stopped = 'cap'; break outer; }
      const slice = ids.slice(i, i + BIZCLEAN_BATCH_MAX).slice(0, room);
      attempts += slice.length;
      try {
        await api.deleteBusinessMessages({
          business_connection_id: String(connectionId),
          message_ids: slice,
        });
        for (const m of slice) { goneKeys.add(`${chatId}:${m}`); deleted++; }
      } catch (err) {
        if (bizCleanIsRateError(err)) { stopped = 'rate'; break outer; }
        if (bizCleanIsRightsError(err)) {
          stopped = 'rights';
          state.autoOff = true;
          state.autoOffNote = 'Telegram refused a delete with a rights error — auto-delete is OFF until you run /bizclean on again. Check the rights granted to PB in Telegram Settings → Business → Chatbots.';
          break outer;
        }
        // Already gone / undeletable: drop from the ring silently, count
        // nothing (successes only) — the phase-1 sweep rule.
        for (const m of slice) goneKeys.add(`${chatId}:${m}`);
      }
    }
  }
  if (goneKeys.size) {
    state.ring = state.ring.filter((e) => !goneKeys.has(`${e.c}:${e.m}`));
    if (kind === 'j') state.delJunk = Number(state.delJunk ?? 0) + deleted;
    if (kind === 'o') state.delOwn = Number(state.delOwn ?? 0) + deleted;
  }
  return { deleted, attempts, stopped };
}

/** Auto sweep for one connection: due flagged junk only, after grace.
 *  Requires the all-messages right; without it nothing is attempted
 *  (junk stays flagged; /bizclean status explains). Never throws. */
export async function bizCleanSweepConnection(conn, { cap = BIZCLEAN_CYCLE_DELETE_CAP } = {}) {
  const connectionId = String(conn?.connectionId ?? '');
  if (!connectionId) return { skipped: 'no-connection', deleted: 0, attempts: 0 };
  const state = await bizCleanLoadState(connectionId);
  if (!state || state.enabled !== true) return { skipped: 'off', deleted: 0, attempts: 0 };
  const now = bizCleanNowSec();
  state.ring = bizCleanPruneRing(state.ring, now);
  if (state.autoOff) {
    await bizCleanSaveState(connectionId, state);
    return { skipped: 'auto-off', deleted: 0, attempts: 0 };
  }
  const rights = await bizCleanRights(connectionId);
  if (!rights.ok || !rights.all) {
    await bizCleanSaveState(connectionId, state);
    return { skipped: 'no-rights', deleted: 0, attempts: 0 };
  }
  const grace = bizCleanGraceOf(state);
  const due = state.ring.filter((e) => e.k === 'j' && now - e.t >= grace);
  if (!due.length) {
    await bizCleanSaveState(connectionId, state);
    return { deleted: 0, attempts: 0 };
  }
  const r = await bizCleanDeleteKind(connectionId, state, 'j', due, cap);
  await bizCleanSaveState(connectionId, state);
  return r;
}

/** Tick cycle: auto-sweep every ACTIVE connection with cleanup on,
 *  under one global per-cycle delete cap; remainder carries. Also the
 *  prune-on-tick pass for those connections (inside the sweep). */
export async function cycleBizCleanup() {
  let budget = BIZCLEAN_CYCLE_DELETE_CAP;
  let deleted = 0;
  let connections = 0;
  try {
    const rows = await db.select().from(business_connections)
      .where(eq(business_connections.isActive, true)).all();
    for (const conn of rows ?? []) {
      if (budget <= 0) break;
      const state = await bizCleanLoadState(conn.connectionId);
      if (!state || state.enabled !== true) continue;
      connections++;
      const r = await bizCleanSweepConnection(conn, { cap: budget });
      deleted += r.deleted ?? 0;
      budget -= r.attempts ?? 0;
    }
  } catch { /* a tidy failure never breaks the tick */ }
  return { deleted, connections };
}

// ── Manual sweep (preview → explicit confirm → execute) ─────────────────

function bizCleanGroupByChat(entries) {
  const out = {};
  for (const e of entries) {
    const k = String(e.c);
    if (!out[k]) out[k] = [];
    out[k].push(e.m);
  }
  return out;
}

async function bizCleanSavePendingSweep(ownerTgId, pending) {
  await setConfig(bizCleanSweepKey(ownerTgId), JSON.stringify(pending)).catch(() => {});
}

async function bizCleanLoadPendingSweep(ownerTgId) {
  try {
    const raw = await getConfig(bizCleanSweepKey(ownerTgId), null);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || Date.now() - Number(p.at ?? 0) > BIZCLEAN_SWEEP_CONFIRM_MS) return null;
    return p;
  } catch { return null; }
}

async function bizCleanClearPendingSweep(ownerTgId) {
  // config has no delete helper; an expired timestamp retires it.
  await setConfig(bizCleanSweepKey(ownerTgId), JSON.stringify({ at: 0 })).catch(() => {});
}

// ── /bizclean command (owner of an ACTIVE connection, PB DM only) ───────

const BIZCLEAN_HONESTY_LINE = 'PB only sees messages that arrive while it\'s connected to your account — it can\'t scan or clean chats from before the connection.';
const BIZCLEAN_NOT_CONNECTED = 'PB isn\'t connected to your Telegram account as a business bot, so there are no business chats for it to clean yet.\n\nTo connect: Telegram Settings → Business → Chatbots → add @PoorBoyAI_bot. If you want junk auto-cleaned, grant PB the delete-messages rights there too — then run /bizclean on here.';

function bizCleanRightsLine(rights) {
  if (!rights.ok) return 'Delete rights: couldn\'t be read from Telegram just now — try status again in a bit.';
  if (rights.all) return 'Delete rights: FULL (any message in your connected chats) — flagged junk can auto-delete, and PB\'s own sent messages can be swept.';
  if (rights.sent) return 'Delete rights: PB\'s own sent messages only — flagged junk is counted but NEVER auto-deleted (Telegram wasn\'t granted the delete-all-messages right). You can still sweep PB\'s own sent messages.';
  return 'Delete rights: NONE granted — cleanup can flag and count junk, but Telegram won\'t let PB delete anything. Grant delete rights in Telegram Settings → Business → Chatbots to unlock sweeps.';
}

async function bizCleanStatusText(conn, state, rights) {
  const on = state?.enabled === true;
  const ring = state?.ring ?? [];
  const junk = ring.filter((e) => e.k === 'j');
  const now = bizCleanNowSec();
  const grace = bizCleanGraceOf(state ?? {});
  const due = junk.filter((e) => now - e.t >= grace).length;
  const own = ring.filter((e) => e.k === 'o').length;
  const lines = [
    `🧹 PB Cleanup — business chats: ${on ? 'ON' : 'OFF'}`,
    bizCleanRightsLine(rights),
    `Junk grace period: ${bizCleanFmtDur(grace)} (flagged junk waits this long before auto-delete, so you can spot a mistake first)`,
    `Flagged junk waiting: ${junk.length}${on && rights.all ? ` (${due} due now)` : ''}`,
    `PB's own sent messages recorded: ${own} (never auto-deleted — manual sweep only)`,
    `Deleted so far: ${Number(state?.delJunk ?? 0)} junk · ${Number(state?.delOwn ?? 0)} of PB's own`,
  ];
  if (state?.autoOff) lines.push(`⚠️ Auto-delete is OFF: ${state.autoOffNote ?? 'a rights error stopped it.'} Run /bizclean on to re-enable once the rights are fixed.`);
  if (on && rights.ok && !rights.all) lines.push('ℹ️ With the current rights, flagged junk is counted but never auto-deleted — that takes the delete-all-messages right.');
  lines.push(BIZCLEAN_HONESTY_LINE);
  return lines.join('\n');
}

async function bizcleanCommand(chatId, args, msg) {
  const fromId = msg?.from?.id;
  if (!fromId) return;
  if (msg.chat?.type !== 'private') {
    await api.sendMessage({ chat_id: chatId, text: 'ℹ️ /bizclean runs in a DM with PB — it manages cleanup of YOUR connected business chats.' }).catch(() => {});
    return;
  }
  const conn = await getBusinessConnectionForOwner(fromId);
  if (!conn) {
    await sendOwnerDM(fromId, BIZCLEAN_NOT_CONNECTED);
    return;
  }
  const connectionId = String(conn.connectionId);
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'status').toLowerCase();
  let state = await bizCleanLoadState(connectionId);
  if (!state) state = { ...BIZCLEAN_DEFAULT_STATE };
  // Prune on touch (bounded ring hygiene outside the tick too).
  state.ring = bizCleanPruneRing(state.ring, bizCleanNowSec());

  if (sub === 'status') {
    const rights = await bizCleanRights(connectionId);
    await bizCleanSaveState(connectionId, state);
    await sendOwnerDM(fromId, await bizCleanStatusText(conn, state, rights));
    return;
  }
  if (sub === 'on') {
    state.enabled = true;
    state.autoOff = false;
    state.autoOffNote = null;
    await bizCleanSaveState(connectionId, state);
    const rights = await bizCleanRights(connectionId, { force: true });
    await sendOwnerDM(fromId, [
      '🧹 PB Cleanup is ON for your business chats.',
      '• Incoming messages that match the junk rules (Shield\'s scam-phrase library + your customs) are flagged as they arrive.',
      rights.all
        ? `• Flagged junk auto-deletes after the grace period (${bizCleanFmtDur(bizCleanGraceOf(state))}) — never instantly.`
        : '• Heads up: with your current delete rights, flagged junk is counted but NOT auto-deleted — auto-delete needs the delete-all-messages right (Telegram Settings → Business → Chatbots).',
      '• Your own messages are never recorded or deleted. PB\'s own replies are recorded but only ever removed by a confirmed /bizclean sweep.',
      BIZCLEAN_HONESTY_LINE,
    ].join('\n'));
    return;
  }
  if (sub === 'off') {
    const had = state.ring.length;
    state.enabled = false;
    state.ring = [];
    await bizCleanSaveState(connectionId, state);
    await bizCleanClearPendingSweep(fromId);
    await sendOwnerDM(fromId, `🧹 PB Cleanup is OFF for your business chats. ${had} recorded message(s) dropped from the list — nothing further will be flagged or deleted.`);
    return;
  }
  if (sub === 'rules') {
    const action = (parts[1] ?? '').toLowerCase();
    if (action === 'add' || action === 'remove') {
      const phrase = parts.slice(2).join(' ').trim().toLowerCase().slice(0, 80);
      if (phrase.length < 3) {
        await sendOwnerDM(fromId, 'Usage: /bizclean rules add <phrase of 3+ characters> — e.g. /bizclean rules add claim your free airdrop');
        return;
      }
      if (action === 'add') {
        if (state.phrases.includes(phrase)) {
          await sendOwnerDM(fromId, `That phrase is already on your junk list: "${phrase}"`);
          return;
        }
        if (state.phrases.length >= BIZCLEAN_PHRASES_MAX) {
          await sendOwnerDM(fromId, `Your junk list is full (${BIZCLEAN_PHRASES_MAX} phrases) — remove one before adding more.`);
          return;
        }
        state.phrases = [...state.phrases, phrase];
        await bizCleanSaveState(connectionId, state);
        await sendOwnerDM(fromId, `🧹 Junk phrase added: "${phrase}". Incoming business messages containing it will be flagged from now on.`);
        return;
      }
      if (!state.phrases.includes(phrase)) {
        await sendOwnerDM(fromId, `That phrase isn't on your junk list: "${phrase}" — /bizclean rules shows the list.`);
        return;
      }
      state.phrases = state.phrases.filter((p) => p !== phrase);
      await bizCleanSaveState(connectionId, state);
      await sendOwnerDM(fromId, `🧹 Junk phrase removed: "${phrase}".`);
      return;
    }
    const lines = [
      '🧹 Junk rules for your business chats:',
      '• Built-in: Shield\'s scam-phrase library (wallet-verify lures, claim-your-airdrop bait, seed-phrase asks, guaranteed-profit pitches, and similar) — always on.',
      state.phrases.length
        ? `• Your custom phrases (${state.phrases.length}):\n${state.phrases.map((p) => `  – ${p}`).join('\n')}`
        : '• Your custom phrases: none yet.',
      'Add: /bizclean rules add <phrase> · Remove: /bizclean rules remove <phrase>',
    ];
    await sendOwnerDM(fromId, lines.join('\n'));
    return;
  }
  if (sub === 'grace') {
    if (!parts[1]) {
      await sendOwnerDM(fromId, `Junk grace period is ${bizCleanFmtDur(bizCleanGraceOf(state))}. Change it with /bizclean grace <duration> — 0 to 48h (e.g. /bizclean grace 0, /bizclean grace 30m, /bizclean grace 2h). A bare number means minutes.`);
      return;
    }
    const sec = cleanupParseDuration(parts[1]);
    if (sec === null || sec < 0 || sec > BIZCLEAN_GRACE_MAX_SEC) {
      await sendOwnerDM(fromId, 'Usage: /bizclean grace <duration> — between 0 and 48h (e.g. /bizclean grace 0, /bizclean grace 30m, /bizclean grace 2h).');
      return;
    }
    state.graceSec = sec;
    await bizCleanSaveState(connectionId, state);
    await sendOwnerDM(fromId, `🧹 Junk grace period set: ${bizCleanFmtDur(sec)}. Flagged junk waits that long before auto-delete.`);
    return;
  }
  if (sub === 'sweep') {
    const confirm = (parts[1] ?? '').toLowerCase() === 'confirm';
    const rights = await bizCleanRights(connectionId);
    if (!confirm) {
      const junkEntries = state.ring.filter((e) => e.k === 'j');
      const ownEntries = state.ring.filter((e) => e.k === 'o');
      if (!junkEntries.length && !ownEntries.length) {
        await sendOwnerDM(fromId, '🧹 Nothing to sweep — no flagged junk and none of PB\'s sent messages are recorded right now.');
        return;
      }
      const pending = {
        at: Date.now(), connId: connectionId,
        junk: bizCleanGroupByChat(junkEntries),
        own: bizCleanGroupByChat(ownEntries),
      };
      await bizCleanSavePendingSweep(fromId, pending);
      const perChat = new Map();
      for (const e of junkEntries) perChat.set(e.c, { ...(perChat.get(e.c) ?? { j: 0, o: 0 }), j: (perChat.get(e.c)?.j ?? 0) + 1 });
      for (const e of ownEntries) perChat.set(e.c, { ...(perChat.get(e.c) ?? { j: 0, o: 0 }), o: (perChat.get(e.c)?.o ?? 0) + 1 });
      const lines = ['🧹 Sweep preview — this is what a confirmed sweep would delete:'];
      for (const [c, n] of perChat) lines.push(`• Chat ${c}: ${n.j} flagged junk · ${n.o} of PB's own sent`);
      lines.push(`Total: ${junkEntries.length} junk · ${ownEntries.length} of PB's own.`);
      if (junkEntries.length && !rights.all) lines.push('⚠️ Junk can\'t be deleted with your current rights (needs delete-all-messages) — it will be skipped and stay flagged.');
      if (ownEntries.length && !(rights.all || rights.sent)) lines.push('⚠️ PB\'s own sent messages can\'t be deleted with your current rights (needs a delete right) — they will be skipped.');
      lines.push('Deletes are PERMANENT. Run /bizclean sweep confirm within 10 minutes to do it — anything else cancels.');
      await bizCleanSaveState(connectionId, state);
      await sendOwnerDM(fromId, lines.join('\n'));
      return;
    }
    const pending = await bizCleanLoadPendingSweep(fromId);
    if (!pending || String(pending.connId) !== connectionId) {
      await sendOwnerDM(fromId, 'That sweep preview expired or doesn\'t match this connection — run /bizclean sweep again for a fresh preview.');
      return;
    }
    await bizCleanClearPendingSweep(fromId);
    let budget = BIZCLEAN_SWEEP_DELETE_CAP;
    const results = [];
    // Junk leg (needs all-messages right).
    const junkEntries = state.ring.filter((e) => e.k === 'j'
      && (pending.junk[String(e.c)] ?? []).includes(e.m));
    if (junkEntries.length) {
      if (!rights.all) {
        results.push(`junk: skipped — missing the delete-all-messages right (${junkEntries.length} still flagged)`);
      } else {
        const r = await bizCleanDeleteKind(connectionId, state, 'j', junkEntries, budget);
        budget -= r.attempts;
        results.push(`junk: deleted ${r.deleted}${r.stopped === 'cap' ? ' (batch cap reached — the rest stays flagged; sweep again)' : ''}${r.stopped === 'rights' ? ' (Telegram refused with a rights error — auto-delete is now OFF; see /bizclean status)' : ''}`);
      }
    }
    // Own-sent leg (needs either delete right).
    const ownEntries = state.ring.filter((e) => e.k === 'o'
      && (pending.own[String(e.c)] ?? []).includes(e.m));
    if (ownEntries.length) {
      if (!(rights.all || rights.sent)) {
        results.push(`PB's own: skipped — no delete right granted (${ownEntries.length} still recorded)`);
      } else {
        const r = await bizCleanDeleteKind(connectionId, state, 'o', ownEntries, budget);
        budget -= r.attempts;
        results.push(`PB's own: deleted ${r.deleted}${r.stopped === 'cap' ? ' (batch cap reached — the rest stays recorded; sweep again)' : ''}`);
      }
    }
    await bizCleanSaveState(connectionId, state);
    await sendOwnerDM(fromId, `🧹 Sweep done.\n${results.map((r) => `• ${r}`).join('\n')}`);
    return;
  }
  await sendOwnerDM(fromId, 'Usage: /bizclean status|on|off · /bizclean rules [add|remove <phrase>] · /bizclean grace <duration> · /bizclean sweep [confirm]');
}

export const BIZCLEAN_COMMANDS = {
  bizclean: bizcleanCommand,
};
