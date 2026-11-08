// PB account/wallet library on Telegram Serverless.
// Ports the read-only chain access (Base JSON-RPC), price alerts, whale
// watches, community events, price milestones, business-bot settings and
// X-handle state from artifacts/api-server/src/lib/telegram-community-bot.ts.
// No transaction signing — read-only by design (source: v1 rule).

import { api, fetch } from 'sdk';
import db, { eq, desc } from 'sdk/db';
import {
  user_wallets,
  price_alerts,
  whale_watch_wallets,
  community_events,
  group_price_milestones,
  business_bot_settings,
  twitter_handles,
  user_twitter_creds,
  bot_users,
  airdrop_campaigns,
  raid_xp,
} from '../schema.js';
import { getConfig, setConfig } from './config.js';
import { fetchZoraCoin, ZORA_COIN_CA } from './market.js';
import { claimWelcomeAirdrop } from './airdrop.js';
import { tierAtLeast } from './tiers.js';
import { vaultEncrypt } from './walletvault.js';
import { isOwnerId } from './groups.js';

export const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
const GT = 'https://api.geckoterminal.com/api/v2';
const MAX_WATCHED = 10;

// ── Base JSON-RPC reads (source: WATCH_BASE_RPC / getEthBalance / getTokenBalance) ──

async function baseRpcUrl() {
  return await getConfig('BASE_RPC_URL', 'https://mainnet.base.org');
}

async function rpc(method, params) {
  try {
    const res = await fetch(await baseRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return j?.result ?? null;
  } catch { return null; }
}

/** Native Base ETH balance (source: getEthBalance). */
export async function ethBalance(address) {
  const r = await rpc('eth_getBalance', [address.toLowerCase(), 'latest']);
  if (r == null) return null;
  return parseInt(r, 16) / 1e18;
}

/** ERC-20 balanceOf(wallet) raw units (source: getTokenBalance). */
export async function erc20BalanceRaw(wallet, token) {
  const data = '0x70a08231' + '000000000000000000000000' + wallet.toLowerCase().replace(/^0x/, '');
  const r = await rpc('eth_call', [{ to: token.toLowerCase(), data }, 'latest']);
  if (r == null) return null;
  try { return BigInt(r); } catch { return null; }
}

/** PBAI holder check (source: checkPbaiWalletBalances — single wallet, Base). */
export async function checkPbai(wallet) {
  const raw = await erc20BalanceRaw(wallet, PBAI_CA);
  if (raw == null) return { available: false, balance: 0 };
  return { available: true, balance: Number(raw) / 1e18 };
}

/**
 * Batch $PBAI balanceOf reads (W4 holder sync): one JSON-RPC batch request
 * per chunk of 50, matched by request id. Returns a Map of lowercase
 * address → raw-unit BigInt, or null per address when the read failed
 * (RPC error / malformed result) — a failed read is NEVER a zero balance.
 * A whole-chunk transport failure marks every address in it null.
 */
export async function pbaiBalancesRaw(addresses) {
  const out = new Map();
  const addrs = [...new Set((addresses ?? []).map((a) => String(a).toLowerCase()))]
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  const CHUNK = 50;
  for (let i = 0; i < addrs.length; i += CHUNK) {
    const chunk = addrs.slice(i, i + CHUNK);
    const body = chunk.map((wallet, j) => ({
      jsonrpc: '2.0', id: j + 1, method: 'eth_call',
      params: [{
        to: PBAI_CA,
        data: '0x70a08231' + '000000000000000000000000' + wallet.replace(/^0x/, ''),
      }, 'latest'],
    }));
    let results = null;
    try {
      const res = await fetch(await baseRpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) results = await res.json().catch(() => null);
    } catch { results = null; }
    const byId = new Map();
    if (Array.isArray(results)) {
      for (const r of results) {
        if (r && Number.isInteger(r.id)) byId.set(r.id, r.result ?? null);
      }
    }
    chunk.forEach((wallet, j) => {
      const r = byId.get(j + 1);
      let v = null;
      if (typeof r === 'string') { try { v = BigInt(r); } catch { v = null; } }
      out.set(wallet, v);
    });
  }
  return out;
}

/** Nonce for wallet watching (source: fetchTgNonce). */
export async function walletNonce(address) {
  const r = await rpc('eth_getTransactionCount', [address.toLowerCase(), 'latest']);
  if (r == null) return null;
  return parseInt(r, 16);
}

// ── User wallets (source: /connect → raid_xp.wallet_address + airdrop_wallets) ──
// v1 table: user_wallets (telegram_user_id PK, base_address, sol_address).
// The raid_xp.wallet_address column on the XP context row is set too,
// mirroring the source.

export function walletKind(address) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return 'base';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'sol';
  return null;
}

export async function getUserWallets(tgId) {
  return db.select().from(user_wallets)
    .where(eq(user_wallets.telegramUserId, String(tgId))).get().catch(() => null);
}

export async function setUserWallet(tgId, address) {
  const kind = walletKind(address);
  if (!kind) return null;
  // Schema PROPERTY names, not SQL column names: this SDK's values()/set()
  // key on the property ('baseAddress'), and the SQL name ('base_address')
  // is silently dropped — proven 2026-10-20 by a round-trip probe in which
  // setUserWallet resolved and created the row but stored NULL. (Every
  // registration through this helper was affected; reads were fine.)
  const col = kind === 'base' ? 'baseAddress' : 'solAddress';
  const value = kind === 'base' ? address.toLowerCase() : address;
  // Welcome airdrop (Boost/Airdrop rebuild): a FIRST-EVER Base registration
  // claims 1,000 PBAI into the permanent address-dedup ledger. The claim is
  // address-atomic in lib/airdrop.js; failures here never break /connect.
  const prior = kind === 'base' ? await getUserWallets(tgId).catch(() => null) : null;
  await db.insert(user_wallets)
    .values({ telegramUserId: String(tgId), [col]: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: user_wallets.telegramUserId,
      set: { [col]: value, updatedAt: new Date() },
    }).run();
  if (kind === 'base' && !prior?.baseAddress) {
    await claimWelcomeAirdrop(tgId, value).catch(() => {});
  }
  return { kind, address: value };
}

// ── Price alerts (source: in-memory alerts array → DB; fields mirror source) ──

export async function addPriceAlert(userId, chatId, tokenAddress, tokenName, targetPrice, direction) {
  const inserted = await db.insert(price_alerts).values({
    telegramUserId: String(userId),
    chatId: String(chatId),
    tokenAddress: tokenAddress.toLowerCase(),
    tokenName,
    targetPrice,
    direction,
    createdAt: new Date(),
  }).returning();
  return inserted[0] ?? null;
}

export async function listPriceAlerts(userId) {
  return db.select().from(price_alerts)
    .where(eq(price_alerts.telegramUserId, String(userId)))
    .orderBy(desc(price_alerts.createdAt)).all().catch(() => []);
}

export async function deletePriceAlert(id, userId) {
  const rows = await db.select().from(price_alerts)
    .where(eq(price_alerts.id, Number(id))).get().catch(() => null);
  if (!rows || rows.telegramUserId !== String(userId)) return false;
  await db.delete(price_alerts).where(eq(price_alerts.id, Number(id))).run();
  return true;
}

// ── Whale wallet watches (source: whale_watch_wallets; max 10/user) ───────────

export async function watchWallet(tgId, chatId, address, label) {
  const uid = String(tgId);
  const existing = await db.select().from(whale_watch_wallets)
    .where(eq(whale_watch_wallets.telegramUserId, uid)).all().catch(() => []);
  if (existing.length >= MAX_WATCHED) return { error: 'max' };
  // FIX 5 (2026-10-29): compare lowercased on BOTH sides. The old
  // check lowercased only the input, so a row stored with mixed
  // case (e.g. via the Mini App endpoint, which stored as-given)
  // slipped past it and duplicated. Stored addresses are normalized
  // to lowercase on insert below, so this also heals legacy rows
  // on their next add attempt.
  if (existing.some((w) => String(w.walletAddress ?? '').toLowerCase() === address.toLowerCase())) {
    return { error: 'dup' };
  }
  const nonce = await walletNonce(address);
  await db.insert(whale_watch_wallets).values({
    telegramUserId: uid,
    telegramChatId: String(chatId),
    walletAddress: address.toLowerCase(),
    label,
    lastNonce: nonce ?? -1,
    createdAt: new Date(),
  }).run();
  return { ok: true };
}

export async function unwatchWallet(tgId, address) {
  const rows = await db.select().from(whale_watch_wallets)
    .where(eq(whale_watch_wallets.telegramUserId, String(tgId))).all().catch(() => []);
  const hit = rows.find((r) => r.walletAddress === address.toLowerCase());
  if (!hit) return false;
  await db.delete(whale_watch_wallets).where(eq(whale_watch_wallets.id, hit.id)).run();
  return true;
}

export async function listWatched(tgId) {
  return db.select().from(whale_watch_wallets)
    .where(eq(whale_watch_wallets.telegramUserId, String(tgId)))
    .all().catch(() => []);
}

// ── Community events (source: community_events; fired by the clock wave) ─────

export async function addEvent(chatId, title, eventTime, createdBy) {
  const inserted = await db.insert(community_events).values({
    chatId: String(chatId),
    title,
    eventTime: new Date(eventTime),
    fired: false,
    createdBy: String(createdBy),
  }).returning();
  return inserted[0] ?? null;
}

export async function listUpcomingEvents(chatId, limit = 5) {
  const now = Math.floor(Date.now() / 1000);
  return db.select().from(community_events)
    .where(eq(community_events.chatId, String(chatId)))
    .all().catch(() => [])
    .then((rows) => rows
      .filter((r) => !r.fired && (r.eventTime instanceof Date ? r.eventTime.getTime() / 1000 : r.eventTime) > now)
      .slice(0, limit));
}

export async function cancelEvent(chatId, title) {
  const rows = await db.select().from(community_events)
    .where(eq(community_events.chatId, String(chatId))).all().catch(() => []);
  const hit = rows.find((r) => !r.fired && (r.title ?? '').toLowerCase() === String(title).toLowerCase());
  if (!hit) return null;
  await db.update(community_events).set({ fired: true }).where(eq(community_events.id, hit.id)).run();
  return hit;
}

// ── Price milestones (source: group_price_milestones) ─────────────────────────

export async function addMilestone(chatId, tokenCa, tokenName, targetPrice, label) {
  const inserted = await db.insert(group_price_milestones).values({
    chatId: String(chatId),
    tokenCa: tokenCa.toLowerCase(),
    tokenName,
    targetPrice,
    label,
    triggeredAt: null,
  }).returning();
  return inserted[0] ?? null;
}

export async function listMilestones(chatId) {
  return db.select().from(group_price_milestones)
    .where(eq(group_price_milestones.chatId, String(chatId)))
    .all().catch(() => [])
    .then((rows) => rows.filter((r) => !r.triggeredAt));
}

export async function clearMilestones(chatId) {
  const rows = await listMilestones(chatId);
  for (const r of rows) {
    await db.update(group_price_milestones).set({ triggeredAt: new Date() })
      .where(eq(group_price_milestones.id, r.id)).run();
  }
  return rows.length;
}

// ── Business bot settings (source: business_bot_settings) ────────────────────

export async function getBusinessSettings(tgId) {
  return db.select().from(business_bot_settings)
    .where(eq(business_bot_settings.ownerTelegramId, String(tgId))).get().catch(() => null);
}

export async function setBusinessSettings(tgId, patch) {
  await db.insert(business_bot_settings)
    .values({ ownerTelegramId: String(tgId), ...patch })
    .onConflictDoUpdate({
      target: business_bot_settings.ownerTelegramId,
      set: patch,
    }).run();
}

// ── X handles (source: twitter_handles; verification is v2) ──────────────────

export async function getTwitterHandle(tgId) {
  return db.select().from(twitter_handles)
    .where(eq(twitter_handles.telegramUserId, String(tgId))).get().catch(() => null);
}

export async function setTwitterHandle(tgId, handle) {
  const clean = String(handle).replace(/^@/, '').trim();
  if (!clean || clean.length > 40) return null;
  await db.insert(twitter_handles)
    .values({ telegramUserId: String(tgId), twitterHandle: clean, xVerified: false })
    .onConflictDoUpdate({
      target: twitter_handles.telegramUserId,
      set: { twitterHandle: clean, xVerified: false },
    }).run();
  return clean;
}

export async function markTwitterVerified(tgId) {
  await db.update(twitter_handles)
    .set({ xVerified: true, updatedAt: new Date() })
    .where(eq(twitter_handles.telegramUserId, String(tgId)))
    .run()
    .catch((e) => console.error('[markTwitterVerified]', e?.message ?? e));
}

// Robinhood Chain wallet slot (user_wallets.rh_address). setUserWallet routes
// by address shape and cannot target RH (every 0x address routes to Base),
// so the My Wallet RH capture writes through here.
export async function setRhWallet(tgId, address) {
  const value = String(address).trim();
  await db.insert(user_wallets)
    .values({ telegramUserId: String(tgId), rhAddress: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: user_wallets.telegramUserId,
      set: { rhAddress: value, updatedAt: new Date() },
    }).run();
  return value;
}

// ── X setup wizard (xsetup: buttons — handle capture + tweet verification) ──
// Restores the original's flow (telegram-community-bot.ts xsetup:change /
// xsetup:verify + the DM capture sessions). The live twitter_handles table
// has no verify_code columns and this wave adds no schema, so the pending
// code rides in a config-key session (the established capture pattern):
// handle capture 5 min; verify code 30 min (the original's TTL). Verification
// itself is the original's oEmbed check — publish.twitter.com/oembed is a
// public, credential-free endpoint, so real verification IS possible live.
const XSETUP_TTL_MS = 5 * 60 * 1000;
const XVERIFY_TTL_MS = 30 * 60 * 1000;
const xsetupKey = (userId) => `xsetupcap:${userId}`;
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

async function saveXSetupSession(userId, sess) {
  await setConfig(xsetupKey(userId), JSON.stringify(sess)).catch(() => {});
}
async function clearXSetupSession(userId) {
  await setConfig(xsetupKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}
async function loadXSetupSession(userId) {
  try {
    const raw = await getConfig(xsetupKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.mode) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

function newVerifyCode() {
  return 'PBAI-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function dmXSetup(userId, text, extra = {}) {
  return api.sendMessage({ chat_id: userId, text, parse_mode: 'Markdown', ...extra }).catch(() => null);
}

async function issueXVerify(userId, handle) {
  const code = newVerifyCode();
  await saveXSetupSession(userId, { mode: 'verify', code, expiresAt: Date.now() + XVERIFY_TTL_MS });
  return dmXSetup(userId,
    `✅ *Verify @${handle} via Tweet*\n\n` +
    `*Step 1* — Post this tweet (copy exactly):\n\n` +
    `\`Verifying my @PoorBoyAI_bot account! ${code}\`\n\n` +
    `*Step 2* — Paste your tweet URL here.\n` +
    `_Example: https://x.com/${handle}/status/123456_\n\n` +
    `⏰ _Code expires in 30 minutes_`);
}

/** Public oEmbed lookup (the original's verifyTweetOembed). Returns
 *  { handle, html } or null on any failure. */
export async function fetchTweetOembed(tweetUrl) {
  try {
    const res = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data?.author_url || !data?.html) return null;
    const handle = String(data.author_url).split('/').filter(Boolean).pop() ?? '';
    return { handle, html: String(data.html) };
  } catch { return null; }
}

/** xsetup:change / xsetup:verify — returns { text, alert } for the answer. */
export async function handleXSetupCallback(query) {
  const userId = query.from?.id;
  if (!userId) return null;
  const sub = String(query.data ?? '').split(':')[1] ?? '';

  if (sub === 'change') {
    await saveXSetupSession(userId, { mode: 'handle', expiresAt: Date.now() + XSETUP_TTL_MS });
    const sent = await dmXSetup(userId,
      '📝 *Set your X handle*\n\nSend me your X (Twitter) handle — e.g. `@YourName`.\n\n' +
      'It is saved to your PB profile; right after saving you can verify ownership with a quick tweet.');
    if (!sent) {
      await clearXSetupSession(userId);
      return { text: '📩 Open a DM with me first (@PoorBoyAI_bot), then tap Change Handle again.', alert: true };
    }
    return { text: '📝 Check your DMs — send me your X handle there.' };
  }

  if (sub === 'verify') {
    const row = await getTwitterHandle(userId).catch(() => null);
    const handle = row?.twitterHandle ?? null;
    if (!handle) {
      return { text: '⚠️ Set your X handle first — use /mytwitter @yourhandle or the Change Handle button.', alert: true };
    }
    if (row?.xVerified) return { text: `✅ @${handle} is already verified on your profile.`, alert: true };
    const sent = await issueXVerify(userId, handle);
    if (!sent) return { text: '📩 Open a DM with me first (@PoorBoyAI_bot), then tap Verify again.', alert: true };
    return { text: '📨 Verification steps sent to your DM — post the tweet, then paste its URL there.' };
  }

  return null;
}

/**
 * DM text capture for the X setup wizard. Returns true when the message was
 * consumed. Handle mode validates the X handle format, then stores through
 * setTwitterHandle (the same store /mytwitter writes) and auto-issues the
 * verify tweet (the original's behavior). Verify mode checks the pasted
 * tweet URL via oEmbed: author handle must match and the code must appear.
 */
export async function handleXSetupCapture(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const { sess, expired } = await loadXSetupSession(userId);
  if (!sess) {
    if (expired) {
      await clearXSetupSession(userId);
      await dmXSetup(userId, '⏰ That X setup step expired. Open /raidsetup or /mytwitter and tap the button again.');
      return true;
    }
    return false;
  }

  if (sess.mode === 'handle') {
    const clean = text.replace(/^@/, '').trim();
    if (!X_HANDLE_RE.test(clean)) {
      if (!/\s/.test(text) && text.length <= 40) {
        await dmXSetup(userId, '⚠️ That doesn\'t look like an X handle. Handles are 1–15 characters: letters, numbers and underscores only. Send it again — e.g. `@YourName`.');
        return true;
      }
      return false;
    }
    const saved = await setTwitterHandle(userId, clean).catch(() => null);
    if (!saved) {
      await dmXSetup(userId, '⚠️ Couldn\'t save your handle right now — please try again.');
      return true;
    }
    const sent = await issueXVerify(userId, saved);
    if (sent) {
      await api.sendMessage({
        chat_id: userId,
        text: `✅ *Handle saved — @${saved}*\n\nNow verify it's really yours — the steps are in my previous message: post the tweet, then paste the tweet URL here.`,
        parse_mode: 'Markdown',
      }).catch(() => {});
    } else {
      await clearXSetupSession(userId);
      await dmXSetup(userId, `✅ *Handle saved — @${saved}*\n\nVerify it anytime from /raidsetup with the ✅ Verify Ownership button.`);
    }
    return true;
  }

  if (sess.mode === 'verify') {
    const urlMatch = text.match(/https?:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/i);
    if (!urlMatch) {
      await dmXSetup(userId, '🔗 Paste the full URL of the tweet containing your verification code — e.g. `https://x.com/you/status/123456`.');
      return true;
    }
    const row = await getTwitterHandle(userId).catch(() => null);
    const stored = row?.twitterHandle ?? '';
    const oembed = deps.oembed ?? fetchTweetOembed;
    const res = await oembed(urlMatch[0]).catch(() => null);
    if (!res) {
      await dmXSetup(userId, '❌ Couldn\'t fetch that tweet (it may be private or deleted). Make sure it\'s public and paste the URL again.');
      return true;
    }
    if (String(res.handle).toLowerCase() !== String(stored).toLowerCase()) {
      await dmXSetup(userId, `❌ That tweet is from @${res.handle || '?'}, but your saved handle is @${stored}. Post the verification tweet from @${stored} and paste its URL.`);
      return true;
    }
    if (!String(res.html).includes(sess.code)) {
      await dmXSetup(userId, `❌ The code \`${sess.code}\` isn't in that tweet. Post the exact tweet text I sent you, then paste its URL.`);
      return true;
    }
    await markTwitterVerified(userId);
    await clearXSetupSession(userId);
    await dmXSetup(userId,
      `🎉 *Verified!* Your X account @${stored} is now linked and verified.\n\n` +
      `Raid claims from this account count as verified, and it shows on your profile.\n\n` +
      `🐦 For X raids, PB now spots your like, repost or reply on the target post by itself and DMs your XP — no Claim tap needed.`);
    return true;
  }

  return false;
}

// ── Connect Socials legs (Wizard-fix wave, 2026-10-21) ──────────────────────
// The original's Connect Socials wizard (showSocialsWizard +
// buildTelegramSocialsKeyboard) had FOUR legs: X handle (+ tweet verify),
// TikTok handle, Discord handle, and a Pro+ step for the member's OWN X
// API keys. The rev-141 restore shipped the X leg only; this block restores
// the other three in the same idiom (config-key capture sessions, the same
// twitter_handles store the original used — its tiktok_handle /
// discord_handle columns live there too — panel rendered from row state).
//
// Own-keys storage — the one deliberate deviation from the original: it
// stored the four values PLAINTEXT (user_twitter_creds columns) while its
// copy claimed encryption. Here the set is saved as ONE AES-GCM blob
// (lib/walletvault.js vaultEncrypt, BOOSTER_ENCRYPTION_KEY) and the verify
// runs BEFORE saving, exactly like the original (client.v2.me()): bad keys
// are never stored. NOTE: no consumer of these keys exists in the current
// bot (the original's tweetAsUser cross-post + engagement reads were never
// ported), so the panel copy says what the keys are FOR without claiming a
// live cross-post feature — see BUILD_NOTES.
const SOCIALS_TTL_MS = 5 * 60 * 1000;
const APIKEYS_TTL_MS = 10 * 60 * 1000;
const socialsKey = (userId) => `socialscap:${userId}`;
const TIKTOK_HANDLE_RE = /^[A-Za-z0-9_.]{2,30}$/;

/** Port of the original's normalizeTikTokHandle (tiktok-handle.ts):
 *  bare handle or a tiktok.com/@handle profile URL; short links rejected. */
export function normalizeTikTokHandle(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t) || /tiktok\.com\//i.test(t)) {
    const m = t.match(/tiktok\.com\/@([A-Za-z0-9_.]{2,30})(?:[/?#]|$)/i);
    if (m) return m[1];
    if (/tiktok\.com\/(?:t|vm|vt)\//i.test(t)) return null; // short/share link — ask for the @handle
    return null;
  }
  const clean = t.replace(/^@/, '');
  return TIKTOK_HANDLE_RE.test(clean) ? clean : null;
}

/** Port of the original's Discord capture rule: trimmed, 2–50 chars. */
export function normalizeDiscordHandle(raw) {
  const t = String(raw ?? '').trim();
  return t.length >= 2 && t.length <= 50 ? t : null;
}

export async function setTiktokHandle(tgId, handle) {
  await db.insert(twitter_handles)
    .values({ telegramUserId: String(tgId), tiktokHandle: handle })
    .onConflictDoUpdate({
      target: twitter_handles.telegramUserId,
      set: { tiktokHandle: handle },
    }).run();
  return handle;
}

export async function setDiscordHandle(tgId, handle) {
  await db.insert(twitter_handles)
    .values({ telegramUserId: String(tgId), discordHandle: handle })
    .onConflictDoUpdate({
      target: twitter_handles.telegramUserId,
      set: { discordHandle: handle },
    }).run();
  return handle;
}

async function saveSocialsSession(userId, sess) {
  await setConfig(socialsKey(userId), JSON.stringify(sess)).catch(() => {});
}
async function clearSocialsSession(userId) {
  await setConfig(socialsKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}
async function loadSocialsSession(userId) {
  try {
    const raw = await getConfig(socialsKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.mode) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

async function dmSocials(userId, text, extra = {}) {
  return api.sendMessage({ chat_id: userId, text, parse_mode: 'Markdown', ...extra }).catch(() => null);
}

// ── Own X API keys (Pro+) ────────────────────────────────────────────────────

async function userTierIsProPlus(userId) {
  if (await isOwnerId(userId).catch(() => false)) return true;
  const row = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, String(userId))).get().catch(() => null);
  return tierAtLeast(row?.tier ?? 'free', 'pro');
}

/** Status only — never returns credential material. */
export async function getUserXCredsStatus(tgId) {
  const row = await db.select().from(user_twitter_creds)
    .where(eq(user_twitter_creds.telegramUserId, String(tgId))).get().catch(() => null);
  if (!row) return null;
  return { screenName: row.screenName ?? null, updatedAt: row.updatedAt ?? null };
}

export async function removeUserXCreds(tgId) {
  await db.delete(user_twitter_creds)
    .where(eq(user_twitter_creds.telegramUserId, String(tgId))).run().catch(() => {});
}

/** OAuth 1.0a HMAC-SHA1 signed GET (same construction as
 *  lib/repurpose.js's poster, WebCrypto only). Used to verify a member's
 *  own keys against GET /2/users/me BEFORE anything is stored — the
 *  original's verify-then-save semantics. Returns the parsed JSON body or
 *  null on any failure. */
export async function xUsersMe(creds, fetchImpl) {
  const doFetch = fetchImpl ?? fetch;
  const url = 'https://api.twitter.com/2/users/me';
  const enc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const nonce = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
  const params = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const baseString = ['GET', enc(url), enc(paramString)].join('&');
  const signingKey = `${enc(creds.apiSecret)}&${enc(creds.tokenSecret)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  const authHeader = 'OAuth ' + Object.entries({ ...params, oauth_signature: signature })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
  const res = await doFetch(url, { method: 'GET', headers: { Authorization: authHeader } }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

/** Parse the original's intake format: KEY | SECRET | TOKEN | SECRET. */
export function parseXApiKeys(text) {
  const parts = String(text ?? '').split('|').map((s) => s.trim());
  if (parts.length !== 4 || parts.some((p) => !p)) return null;
  const [apiKey, apiSecret, token, tokenSecret] = parts;
  if ([apiKey, apiSecret, token, tokenSecret].some((p) => p.length > 200 || /\s/.test(p))) return null;
  return { apiKey, apiSecret, token, tokenSecret };
}

async function storeUserXCreds(userId, creds, screenName) {
  const blob = await vaultEncrypt(JSON.stringify(creds));
  await db.insert(user_twitter_creds)
    .values({ telegramUserId: String(userId), screenName: screenName ?? null, credsEnc: blob })
    .onConflictDoUpdate({
      target: user_twitter_creds.telegramUserId,
      set: { screenName: screenName ?? null, credsEnc: blob, updatedAt: new Date() },
    }).run();
}

// ── The unified panel (the original's showSocialsWizard) ────────────────────

function socialsPanelText(row, credsStatus) {
  const lines = ['🔗 *Connect Socials*', ''];
  lines.push(row?.twitterHandle
    ? `🐦 *X / Twitter:* ✅ @${row.twitterHandle}${row.xVerified ? ' (verified)' : ''}`
    : '🐦 *X / Twitter:* _Not set_');
  lines.push(row?.tiktokHandle
    ? `🎵 *TikTok:* ✅ @${row.tiktokHandle}`
    : '🎵 *TikTok:* _Not set_');
  lines.push(row?.discordHandle
    ? `🎮 *Discord:* ✅ ${row.discordHandle}`
    : '🎮 *Discord:* _Not set_');
  lines.push('');
  lines.push(credsStatus
    ? `🔑 *Your X API keys:* ✅ Connected${credsStatus.screenName ? ` (@${credsStatus.screenName})` : ''} — stored encrypted.`
    : '🔑 *Your X API keys:* _Not connected_ (Pro+ feature)');
  lines.push('');
  lines.push('_Your handles show on your PB profile so communities can find and credit you. Your own X API keys are checked to belong to an X account, then stored encrypted — PB never displays them back._');
  return lines.join('\n');
}

function socialsPanelKeyboard(row, credsStatus) {
  const kb = [];
  if (row?.twitterHandle) {
    kb.push([{ text: '🐦 Change X Handle', callback_data: 'xsetup:change' }]);
    if (!row.xVerified) kb.push([{ text: '✅ Verify X Ownership', callback_data: 'xsetup:verify' }]);
  } else {
    kb.push([{ text: '🐦 Set X Handle', callback_data: 'xsetup:change' }]);
  }
  kb.push([{ text: row?.tiktokHandle ? '🎵 Change TikTok' : '🎵 Connect TikTok', callback_data: 'socials:tiktok' }]);
  kb.push([{ text: row?.discordHandle ? '🎮 Change Discord' : '🎮 Connect Discord', callback_data: 'socials:discord' }]);
  kb.push([{ text: credsStatus ? '🔑 Update My X API Keys (Pro+)' : '🔑 Connect My X API Keys (Pro+)', callback_data: 'socials:apikeys' }]);
  if (credsStatus) kb.push([{ text: '🗑 Remove My X API Keys', callback_data: 'socials:apikeys_remove' }]);
  return { inline_keyboard: kb };
}

/** Render the panel into the user's DM. Returns the send result (null when
 *  the user has no open DM with the bot). */
export async function sendSocialsPanel(userId) {
  const row = await getTwitterHandle(userId).catch(() => null);
  const credsStatus = await getUserXCredsStatus(userId).catch(() => null);
  return dmSocials(userId, socialsPanelText(row, credsStatus), {
    reply_markup: socialsPanelKeyboard(row, credsStatus),
  });
}

/** socials:tiktok / socials:discord / socials:apikeys[/_remove] — returns
 *  { text, alert } for the callback answer, { panel: true } when the tap
 *  re-rendered the panel (the /socials command + /mysocials re-entry). */
export async function handleSocialsCallback(query) {
  const userId = query.from?.id;
  if (!userId) return null;
  const sub = String(query.data ?? '').split(':')[1] ?? '';

  if (sub === 'menu') {
    const sent = await sendSocialsPanel(userId);
    if (!sent) return { text: '📩 Open a DM with me first (@PoorBoyAI_bot), then run /socials there.', alert: true };
    return { panel: true };
  }

  if (sub === 'tiktok' || sub === 'discord') {
    const isTikTok = sub === 'tiktok';
    await saveSocialsSession(userId, { mode: sub, expiresAt: Date.now() + SOCIALS_TTL_MS });
    const sent = await dmSocials(userId, isTikTok
      ? '🎵 *Connect TikTok*\n\nSend me your TikTok username or profile link — e.g. `@yourname` or `https://www.tiktok.com/@yourname`.\n\nIt is saved to your PB profile.'
      : '🎮 *Connect Discord*\n\nSend me your Discord username — e.g. `yourname` or `yourname#1234`.\n\nIt is saved to your PB profile.');
    if (!sent) {
      await clearSocialsSession(userId);
      return { text: '📩 Open a DM with me first (@PoorBoyAI_bot), then tap the button again.', alert: true };
    }
    return { text: isTikTok ? '🎵 Check your DMs — send me your TikTok there.' : '🎮 Check your DMs — send me your Discord username there.' };
  }

  if (sub === 'apikeys') {
    if (!(await userTierIsProPlus(userId))) {
      return {
        text: '🔒 Connecting your own X API keys is a Pro+ feature — the PB Plan ($29/mo) unlocks it. Upgrade with /upgrade.',
        alert: true,
      };
    }
    await saveSocialsSession(userId, { mode: 'apikeys', expiresAt: Date.now() + APIKEYS_TTL_MS });
    const sent = await dmSocials(userId,
      '🔑 *Connect your X API keys (Pro+)*\n\n' +
      'Send ONE message in this exact format:\n\n' +
      '`API_KEY | API_SECRET | ACCESS_TOKEN | ACCESS_SECRET`\n\n' +
      'Create the app at developer.twitter.com with read+write permissions. PB checks the keys belong to an X account (it does not check read+write permission) before saving them, then stores them encrypted. PB cannot delete your messages — after you send your keys, delete that message yourself (long-press, delete).\n\n' +
      '⏰ _This step expires in 10 minutes._');
    if (!sent) {
      await clearSocialsSession(userId);
      return { text: '📩 Open a DM with me first (@PoorBoyAI_bot), then tap the button again.', alert: true };
    }
    return { text: '🔑 Check your DMs — send your keys there in the shown format.' };
  }

  if (sub === 'apikeys_remove') {
    await removeUserXCreds(userId);
    const sent = await sendSocialsPanel(userId);
    return sent ? { panel: true } : { text: '🗑 Your stored X API keys were removed. That does not revoke the app at X — revoke the app at developer.twitter.com if you want the keys dead.' };
  }

  return null;
}

/**
 * DM text capture for the socials legs. Mirrors handleXSetupCapture:
 * returns true when consumed. Invalid handles are refused with the
 * session ALIVE (the original's retry shape). The apikeys message delete is
 * ATTEMPTED (it carries secrets) — success, bad format, or failed
 * verification alike — but in DMs a bot cannot delete a user's messages,
 * so the attempt fails and the user is told to delete it themselves.
 * Nothing is stored before X verifies the keys.
 * deps.xverify is the harness seam for the verify call.
 */
export async function handleSocialsCapture(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text) return false;
  const { sess, expired } = await loadSocialsSession(userId);
  if (!sess) {
    if (expired) {
      await clearSocialsSession(userId);
      await dmSocials(userId, '⏰ That socials step expired. Open /socials and tap the button again. Nothing was stored — and if that message held your X keys, PB did not delete it, so delete it yourself.');
      return true;
    }
    return false;
  }
  if (text.startsWith('/')) return false; // commands pass through; session stays armed

  if (sess.mode === 'tiktok') {
    const handle = normalizeTikTokHandle(text);
    if (!handle) {
      await dmSocials(userId, '⚠️ That doesn\'t look like a TikTok handle. Send your username (2–30 chars: letters, numbers, dots, underscores) or your full profile link — `https://www.tiktok.com/@yourname`. Short share links (vm.tiktok.com) don\'t work here.');
      return true;
    }
    await setTiktokHandle(userId, handle).catch(() => null);
    await clearSocialsSession(userId);
    await dmSocials(userId, `✅ *TikTok connected — @${handle}*\n\nRun /socials to see all your connected accounts.`);
    return true;
  }

  if (sess.mode === 'discord') {
    const handle = normalizeDiscordHandle(text);
    if (!handle) {
      await dmSocials(userId, '⚠️ Discord usernames are 2–50 characters. Send it again — e.g. `yourname` or `yourname#1234`.');
      return true;
    }
    await setDiscordHandle(userId, handle).catch(() => null);
    await clearSocialsSession(userId);
    await dmSocials(userId, `✅ *Discord connected — ${handle}*\n\nRun /socials to see all your connected accounts.`);
    return true;
  }

  if (sess.mode === 'apikeys') {
    // The message carries secrets: attempt delete first, whatever happens next.
    // (In DMs this fails — the user is told to delete it themselves.)
    await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    if (!(await userTierIsProPlus(userId))) {
      await clearSocialsSession(userId);
      await dmSocials(userId, '🔒 Connecting your own X API keys is a Pro+ feature — the PB Plan ($29/mo) unlocks it. Upgrade with /upgrade — nothing was stored. Delete the message you just sent yourself — PB cannot delete it.');
      return true;
    }
    const creds = parseXApiKeys(text);
    if (!creds) {
      await dmSocials(userId, '⚠️ That didn\'t match the format — send ONE message: `API_KEY | API_SECRET | ACCESS_TOKEN | ACCESS_SECRET` (four values separated by | ). Nothing was stored. PB cannot delete your messages — delete that message yourself. The step is still open for 10 minutes.');
      return true;
    }
    const verify = deps.xverify ?? ((c) => xUsersMe(c, deps.xfetch));
    const me = await verify(creds).catch(() => null);
    const screenName = me?.data?.username ?? null;
    if (!screenName) {
      await dmSocials(userId, '❌ X didn\'t accept those keys (verification failed), so nothing was stored. Check the four values, delete the message you just sent yourself, then send them again — the step is still open.');
      return true;
    }
    await storeUserXCreds(userId, creds, screenName);
    await clearSocialsSession(userId);
    await dmSocials(userId, `✅ *X API keys connected — @${screenName}*\n\nChecked against X and stored encrypted. Manage them anytime from /socials. Delete the message you sent with your keys yourself — PB cannot delete it.`);
    return true;
  }

  return false;
}

// ── /connecttwitter + /disconnecttwitter (the original's DM commands) ───────

export const SOCIALS_COMMANDS = {
  // Direct intake (the original's /connecttwitter): with pipe args it IS
  // the apikeys step (delete attempted, Pro+ gate, verify-then-save); with
  // no args it opens the Connect Socials panel. Handler signature matches
  // the message dispatcher's (chatId, args, msg) convention.
  connecttwitter: async (chatId, args, msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    const raw = String(args ?? '').trim();
    if (!raw) {
      const sent = await sendSocialsPanel(userId);
      if (!sent) await dmSocials(userId, '📩 Open a DM with me first (@PoorBoyAI_bot), then run /connecttwitter there.');
      return;
    }
    await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    if (!(await userTierIsProPlus(userId))) {
      await dmSocials(userId, '🔒 Connecting your own X API keys is a Pro+ feature — the PB Plan ($29/mo) unlocks it. Upgrade with /upgrade — nothing was stored. Delete the message you just sent yourself — PB cannot delete it.');
      return;
    }
    const creds = parseXApiKeys(raw);
    if (!creds) {
      await dmSocials(userId, '⚠️ Format: `/connecttwitter API_KEY | API_SECRET | ACCESS_TOKEN | ACCESS_SECRET` — nothing was stored. PB cannot delete your messages — delete that message yourself.');
      return;
    }
    const me = await xUsersMe(creds).catch(() => null);
    const screenName = me?.data?.username ?? null;
    if (!screenName) {
      await dmSocials(userId, '❌ X didn\'t accept those keys (verification failed), so nothing was stored. Check the four values, delete the message you just sent yourself, then try again.');
      return;
    }
    await storeUserXCreds(userId, creds, screenName);
    await dmSocials(userId, `✅ *X API keys connected — @${screenName}*\n\nChecked against X and stored encrypted. Manage them anytime from /socials. Delete the message you sent with your keys yourself — PB cannot delete it.`);
  },
  disconnecttwitter: async (chatId, args, msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    await removeUserXCreds(userId);
    await dmSocials(userId, '🗑 Your stored X API keys were removed. That does not revoke the app at X — revoke the app at developer.twitter.com if you want the keys dead. (Your X handle connection is separate — see /socials.)');
  },
};

// ── Token resolution via GeckoTerminal (source: resolveToken/getTokenByAddress) ──

export async function resolveToken(query) {
  try {
    // Track-both wave: the Zora creator coin is not on GeckoTerminal, so
    // an exact-address query routes to the on-chain adapter instead of a
    // GT search that returns nothing (or, worse, a lookalike). Symbol
    // queries keep today's GT semantics.
    if (typeof query === 'string' && query.toLowerCase() === ZORA_COIN_CA) {
      const c = await fetchZoraCoin().catch(() => null);
      if (!c) return null;
      return { address: c.address, network: 'base', name: c.name, symbol: c.symbol, price: c.priceUsd, label: c.label };
    }
    const res = await fetch(`${GT}/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const hit = (data?.data ?? []).find((d) => d.type === 'token');
    if (!hit?.attributes?.address) return null;
    // Address-mismatch guard (repair wave 2026-10-24): when the caller asked
    // for a contract address, never return a different token — search can
    // surface lookalikes, and a wrong-token return would mislabel alerts
    // and /settoken displays. Symbol queries have no expected address to
    // check against, so they keep search semantics (tgcloud bare /price
    // never uses this path — it resolves $PBAI by contract directly).
    if (/^0x[0-9a-fA-F]{40}$/.test(query) && hit.attributes.address.toLowerCase() !== query.toLowerCase()) return null;
    const network = hit.attributes.network ?? 'base';
    const address = hit.attributes.address;
    const t2 = await fetch(`${GT}/networks/${network}/tokens/${address}`);
    if (!t2.ok) {
      return { address, network, name: hit.attributes.name, symbol: hit.attributes.symbol, price: null };
    }
    const a = (await t2.json().catch(() => null))?.data?.attributes;
    return {
      address, network,
      name: a?.name ?? hit.attributes.name,
      symbol: a?.symbol ?? hit.attributes.symbol,
      price: a?.price_usd != null ? Number(a.price_usd) : null,
    };
  } catch { return null; }
}

// ── Airdrop campaigns (read-only status; source: airdrop_campaigns) ───────────

export async function listAirdropCampaigns(tgId, limit = 10) {
  return db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.telegramUserId, String(tgId)))
    .orderBy(desc(airdrop_campaigns.createdAt))
    .limit(limit).all().catch(() => []);
}
