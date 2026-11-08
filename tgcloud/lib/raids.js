// lib/raids.js — raid sessions, completions, cards.
// Ported from telegram-community-bot.ts (launchRaid, raid_done/raid_share
// handlers, buildRaidText, buildRaidKeyboard, buildEndedKeyboard,
// detectRaidPlatform, RAID_HOW_TO_TEXT, endAndUpdateActiveRaids).

import { api, fetch } from 'sdk';
import db, { eq, sql } from 'sdk/db';
import { raid_sessions, raid_completions, raid_messages, raid_queue, bot_users, twitter_handles, raid_alert_preferences } from '../schema.js';
import { addXp, getRaidXP, buildRaidToast, getXpCommunityPolicy, getPBRank } from './xp.js';
import { getConfig, setConfig } from './config.js';
import { generatePost, effectiveTier } from './posts.js';
import { tierAtLeast, canonicalTier } from './tiers.js';
import { getGroupSettings, getMyGroupsFor, portalBannerOf } from './groups.js';

// ── Platform detection — source: detectRaidPlatform ───────────────────────────
export function detectRaidPlatform(url) {
  if (/twitter\.com|x\.com/i.test(url))      return { emoji: '🐦', name: 'X / Twitter',  cta: 'Like, Retweet & Reply 🔥' };
  if (/reddit\.com/i.test(url))              return { emoji: '🟠', name: 'Reddit',        cta: 'Upvote & Comment 🚀' };
  if (/dexscreener\.com/i.test(url))         return { emoji: '📊', name: 'DexScreener',   cta: 'Visit, Star & Boost ⭐' };
  if (/pump\.fun/i.test(url))                return { emoji: '🟢', name: 'PumpFun',       cta: 'Buy & Boost 💎' };
  if (/ape\.store/i.test(url))               return { emoji: '🦍', name: 'Ape.Store',     cta: 'Buy & Raid 🦍' };
  if (/tiktok\.com/i.test(url))              return { emoji: '🎵', name: 'TikTok',        cta: 'Like, Share & Comment 🔥' };
  if (/youtube\.com|youtu\.be/i.test(url))   return { emoji: '📺', name: 'YouTube',      cta: 'Like, Subscribe & Comment ⭐' };
  if (/t\.me|telegram\.me/i.test(url))       return { emoji: '✈️', name: 'Telegram',      cta: 'Join & Engage 💬' };
  if (/instagram\.com/i.test(url))          return { emoji: '📸', name: 'Instagram',     cta: 'Like, Share & Comment 🔥' };
  if (/facebook\.com|fb\.com/i.test(url))    return { emoji: '📘', name: 'Facebook',      cta: 'Like, Share & Comment 👍' };
  if (/discord\.gg|discord\.com/i.test(url)) return { emoji: '💬', name: 'Discord',       cta: 'Join & Engage 🎮' };
  if (/warpcast\.com|farcaster\.xyz/i.test(url)) return { emoji: '🟣', name: 'Farcaster', cta: 'Recast & Reply 🔥' };
  return                                            { emoji: '🌐', name: 'Web',            cta: 'Visit & Engage 🚀' };
}

// X/Twitter raids must target a specific post, not a profile/homepage (source: /raid handler).
export function isValidRaidUrl(url) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'not-url' };
  if (/twitter\.com|x\.com/i.test(url) && !/\/status\/\d+/i.test(url)) {
    return { ok: false, reason: 'x-profile' };
  }
  return { ok: true };
}

// ── Profile raids (wave 2026-11-01) ─────────────────────────────────────────
// A profile link (x.com/<handle>) resolves to that profile's LATEST post and
// then flows through the NORMAL confirm/raid flow — same gates, same card
// shape, same metric tracking (likes / reposts / replies only; bookmarks
// are never read anywhere in this file). Resolution is two signed X calls
// via the existing raidXGet (OAuth 1.0a TWITTER_* creds, same as the
// auto-track engine below): users/by/username, then that user's tweets
// excluding replies and retweets, so the resolved target is the profile's
// own latest post — never a retweet of someone else, never a reply.
// Failure reasons are plain and terminal: nothing is invented, no stale
// or guessed post ever becomes a raid target.
//   PROFILE_POST_STALE_MS = 30 days (wave decision, not a Rowdy call):
//   a latest post older than that is not a live raid target.
// Community link order: an explicit URL token from the raid launcher
// first, else the first http(s) link in the profile bio (entities.url,
// else a link inside the bio text), else none. The confirm card shows
// it; the live card carries it as the Join Community button.
export const PROFILE_POST_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** The X handle in a profile URL, or null (post URLs and non-X URLs fail). */
export function parseXProfileHandle(url) {
  const m = /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(String(url ?? '').trim());
  if (!m) return null;
  if (/\/status\/\d+/i.test(String(url))) return null;
  return m[1];
}

/** First http(s) URL token in a string, punctuation-trimmed, or null. */
export function firstUrlInText(text) {
  const m = /https?:\/\/[^\s<>"')\]]+/i.exec(String(text ?? ''));
  if (!m) return null;
  return m[0].replace(/[.,;:!?)]+$/, '');
}

/** Bio community link for an X user object (entities.url first, bio text second). */
export function extractBioCommunityUrl(user) {
  const entityUrls = user?.entities?.url?.urls ?? [];
  for (const u of entityUrls) {
    const expanded = u?.expanded_url ?? u?.url;
    if (expanded && /^https?:\/\//i.test(expanded)) return String(expanded).replace(/[.,;:!?)]+$/, '');
  }
  return firstUrlInText(user?.description);
}

/** First http(s) token among extra input tokens (the launcher's community link), or null. */
export function extractLauncherCommunityUrl(tokens) {
  for (const tok of tokens ?? []) {
    if (/^https?:\/\//i.test(String(tok ?? '').trim())) return String(tok).trim().replace(/[.,;:!?)]+$/, '');
  }
  return null;
}

export function profileRaidFailureText(reason, handle) {
  const who = handle ? `@${handle}` : 'that profile';
  switch (reason) {
    case 'no-profile': return `❌ No X profile found for ${who} — check the handle and try again.`;
    case 'protected': return `❌ ${who} is a protected (private) profile — PB can't read its posts, so it can't be a raid target.`;
    case 'no-posts': return `❌ ${who} has no posts of its own yet — a profile raid needs a latest post to target.`;
    case 'stale': return `❌ ${who}'s latest post is over 30 days old — too stale to raid. Send a direct link to a fresher post instead.`;
    default: return `❌ Couldn't read ${who} from X right now — X lookup failed. Try again in a bit, or send the direct post link instead.`;
  }
}

/**
 * Resolve a profile URL to its latest own post. deps: { xGet } (defaults to
 * raidXGet — defined below, hoisted by function declaration), { now }.
 * Returns { ok, postUrl, handle, userId, createdAt, metrics, communityUrl }
 * or { ok: false, reason, handle }.
 */
export async function resolveProfileLatestPost(profileUrl, deps = {}) {
  const handle = parseXProfileHandle(profileUrl);
  if (!handle) return { ok: false, reason: 'lookup-failed', handle: null };
  const xGet = deps.xGet ?? ((path) => raidXGet(path, deps));
  const now = deps.now ?? Date.now();
  let user;
  try {
    const data = await xGet(`/2/users/by/username/${encodeURIComponent(handle)}?user.fields=protected,description,entities,public_metrics`);
    user = data?.data ?? null;
    if (!user) return { ok: false, reason: 'no-profile', handle };
  } catch (err) {
    if (err?.status === 404) return { ok: false, reason: 'no-profile', handle };
    return { ok: false, reason: 'lookup-failed', handle };
  }
  if (user.protected) return { ok: false, reason: 'protected', handle };
  const bioCommunityUrl = extractBioCommunityUrl(user);
  let tweets;
  try {
    const data = await xGet(`/2/users/${encodeURIComponent(String(user.id))}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at,public_metrics`);
    tweets = Array.isArray(data?.data) ? data.data : [];
  } catch (err) {
    if (err?.status === 403) return { ok: false, reason: 'protected', handle };
    return { ok: false, reason: 'lookup-failed', handle };
  }
  if (!tweets.length) return { ok: false, reason: 'no-posts', handle };
  const latest = tweets[0];
  const createdMs = Date.parse(latest?.created_at ?? '');
  if (!Number.isFinite(createdMs)) return { ok: false, reason: 'lookup-failed', handle };
  if (now - createdMs > PROFILE_POST_STALE_MS) return { ok: false, reason: 'stale', handle };
  const m = latest?.public_metrics ?? {};
  return {
    ok: true,
    postUrl: `https://x.com/${encodeURIComponent(user.username ?? handle)}/status/${latest.id}`,
    handle: user.username ?? handle,
    userId: String(user.id),
    createdAt: latest.created_at,
    metrics: {
      likes: Number(m.like_count ?? 0),
      retweets: Number(m.retweet_count ?? 0),
      replies: Number(m.reply_count ?? 0),
    },
    communityUrl: bioCommunityUrl,
  };
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// Source: launchRaid — ends existing actives, inserts a 2h session, returns it.
// Raid wave (2026-10-22): threadId = the forum topic the raid was fired
// from (raid_sessions.thread_id has existed since the source schema but
// was never populated). Persisted on the session so every later card
// send/edit/end can recover it; null for non-forum chats (behavior
// byte-identical there — no message_thread_id param is ever sent).
export async function createRaidSession({ chatId, url, platform, targetCount, creatorId, creatorName, threadId = null, metricTargets, communityUrl = null, isProfileRaid = false }) {
  await endActiveRaids(chatId);
  // X-metrics tracking (2026-10-23): X-post raids carry per-metric
  // engagement targets the tick scores against the post's live public
  // metrics. metricTargets === undefined → PB defaults (the config row
  // raid_metric_defaults can retune them); explicit null → untracked;
  // an object → those targets; all-zero → untracked.
  let mt = metricTargets;
  if (mt === undefined) mt = await defaultMetricTargets(url);
  if (mt && mt.likes <= 0 && mt.retweets <= 0 && mt.replies <= 0) mt = null;
  const now = new Date();
  const endsAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const rows = await db.insert(raid_sessions).values({
    chatId,
    platform: platform.name,
    platformEmoji: platform.emoji,
    targetUrl: url,
    callToAction: platform.cta,
    createdBy: creatorId,
    createdByName: creatorName,
    startedAt: now,
    isActive: true,
    endsAt,
    xpPerRaid: getRaidXP(platform.name),
    targetCount: targetCount ?? null,
    threadId: threadId ?? null,
    xLikesTarget: mt ? mt.likes : null,
    xRetweetsTarget: mt ? mt.retweets : null,
    xRepliesTarget: mt ? mt.replies : null,
  }).returning();
  const session = rows[0];
  // Profile raids (wave 2026-11-01): no schema change — the community
  // link + profile flag ride in a config row keyed by session id, so
  // card refreshes (which re-read the session from the DB) keep them.
  // Non-profile sessions never write this row; their cards are untouched.
  if (session && (communityUrl || isProfileRaid)) {
    await setConfig(`raidcommunity:${session.id}`, JSON.stringify({
      communityUrl: communityUrl ?? null, isProfileRaid: Boolean(isProfileRaid),
    })).catch(() => {});
    session.communityUrl = communityUrl ?? null;
    session.isProfileRaid = Boolean(isProfileRaid);
  }
  return session;
}

/** Profile-raid card facts for a session (config row, or in-memory fields). */
export async function getRaidCommunityInfo(session) {
  if (session?.communityUrl || session?.isProfileRaid) {
    return { communityUrl: session.communityUrl ?? null, isProfileRaid: Boolean(session.isProfileRaid) };
  }
  if (!session?.id) return { communityUrl: null, isProfileRaid: false };
  try {
    const raw = await getConfig(`raidcommunity:${session.id}`, null);
    if (!raw) return { communityUrl: null, isProfileRaid: false };
    const j = JSON.parse(raw);
    return { communityUrl: j?.communityUrl ?? null, isProfileRaid: Boolean(j?.isProfileRaid) };
  } catch { return { communityUrl: null, isProfileRaid: false }; }
}

/** sendMessage extra that lands a post in the raid's forum topic, or {}
 *  for non-forum chats (the param is omitted entirely — byte-identical). */
export function raidThreadExtra(session) {
  const t = session?.threadId;
  return t != null && Number(t) > 0 ? { message_thread_id: Number(t) } : {};
}

export async function getSession(sessionId) {
  return db.select().from(raid_sessions)
    .where(eq(raid_sessions.id, sessionId)).get()
    .catch(() => null);
}

export async function getActiveRaid(chatId) {
  return db.select().from(raid_sessions)
    .where(sql`${raid_sessions.chatId} = ${chatId} AND ${raid_sessions.isActive} = 1`)
    .orderBy(sql`id DESC`)
    .get()
    .catch(() => null);
}

// Port of endAndUpdateActiveRaids: ends all active raids in a chat, marks the
// card ended, returns [{ id, finalCount }].
export async function endActiveRaids(chatId) {
  const actives = await db.select().from(raid_sessions)
    .where(sql`${raid_sessions.chatId} = ${chatId} AND ${raid_sessions.isActive} = 1`)
    .all()
    .catch(() => []);
  const ended = [];
  for (const s of actives) {
    const count = await completionCount(s.id);
    await db.update(raid_sessions)
      .set({ isActive: false })
      .where(eq(raid_sessions.id, s.id))
      .run()
      .catch(() => {});
    ended.push({ id: s.id, finalCount: count, session: s });
  }
  return ended;
}

export async function expireSession(sessionId) {
  await db.update(raid_sessions)
    .set({ isActive: false })
    .where(eq(raid_sessions.id, sessionId))
    .run()
    .catch(() => {});
}

export function isSessionExpired(session) {
  if (!session) return true;
  if (!session.isActive) return true;
  if (session.endsAt) {
    const end = session.endsAt instanceof Date ? session.endsAt : new Date(Number(session.endsAt) * 1000);
    if (end < new Date()) return true;
  }
  return false;
}

// ── Completions ──────────────────────────────────────────────────────────────
export async function completionCount(sessionId) {
  const row = await db.get(sql`SELECT COUNT(*) AS cnt FROM raid_completions WHERE raid_id = ${sessionId}`)
    .catch(() => null);
  return Number(row?.cnt ?? 0);
}

export async function hasCompleted(sessionId, userId) {
  const row = await db.get(sql`SELECT 1 FROM raid_completions WHERE raid_id = ${sessionId} AND user_id = ${userId}`)
    .catch(() => null);
  return Boolean(row);
}

// Port of the raid_done award core: inserts a completion (no double-count),
// credits XP via upsert semantics, returns the toast payload.
export async function completeRaid(session, userId, username, displayName) {
  if (await hasCompleted(session.id, userId)) {
    return { alreadyRaided: true };
  }
  const baseXpAmount = Number(session.xpPerRaid ?? 10);
  await db.insert(raid_completions).values({
    raidId: session.id,
    userId,
    username: username ?? null,
    displayName: displayName ?? null,
    xpEarned: baseXpAmount,
    completedAt: new Date(),
  }).run();
  const xpResult = await addXp(userId, Number(session.chatId), username, displayName, baseXpAmount);
  await db.update(raid_completions)
    .set({ xpEarned: xpResult.actualXpEarned })
    .where(sql`${raid_completions.raidId} = ${session.id} AND ${raid_completions.userId} = ${userId}`)
    .run()
    .catch(() => {});
  const count = await completionCount(session.id);
  return {
    alreadyRaided: false,
    xpResult,
    count,
    toast: buildRaidToast(xpResult, count, Boolean(session.isShillRaid)),
    community: await getXpCommunityPolicy(Number(session.chatId)),
    rankUp: rankUpText(xpResult),
  };
}

function rankUpText(xpResult) {
  if (!xpResult) return null;
  const prev = getPBRank(xpResult.prevXP);
  const next = getPBRank(xpResult.newXP);
  if (prev.name === next.name) return null;
  return `🎖️ RANK UP!\n\nLeveled up to ${next.emoji} ${next.name}!\n\nKeep chatting, reacting & raiding — /profile to see your stats`;
}

// ── Card persistence + builders (plain text in v1 — see BUILD_NOTES #2) ──────
export async function persistRaidCard(sessionId, chatId, messageId, hasPhoto = false) {
  // Delete-then-insert: the original upsert targeted (raid_id, chat_id),
  // which carries only a plain index — no unique constraint — so every
  // ON CONFLICT write threw and the catch swallowed it, meaning NO card
  // record was ever persisted and live cards never refreshed (proven by
  // the raid-wave harness, 2026-10-22: 0 rows after sends). One row per
  // raid+chat, latest message wins — same net semantics, working SQL.
  await db.delete(raid_messages)
    .where(sql`${raid_messages.raidId} = ${sessionId} AND ${raid_messages.chatId} = ${chatId}`)
    .run().catch(() => {});
  await db.insert(raid_messages).values({
    raidId: sessionId, chatId, messageId, hasPhoto: Boolean(hasPhoto),
  }).run().catch(() => {});
}

export async function raidCardMessages(sessionId) {
  return db.select().from(raid_messages)
    .where(eq(raid_messages.raidId, sessionId))
    .all()
    .catch(() => []);
}

// Shared card refresh (the callback router keeps its own local copy; this
// one serves the tick auto-track cycle): re-render text + keyboard on
// every persisted card message for the session.
export async function refreshRaidCards(session, count) {
  const msgs = await raidCardMessages(session.id);
  const text = buildRaidText(session, count);
  const info = await getRaidCommunityInfo(session).catch(() => ({ communityUrl: null, isProfileRaid: false }));
  const kb = buildRaidKeyboard(session.id, count, session.targetCount, session.targetUrl, session.isLocked, info.communityUrl, info.isProfileRaid);
  for (const rm of msgs) {
    try {
      // Raid declutter wave: photo cards (banner) edit via caption,
      // text cards via text — an editMessageText on a photo card fails.
      if (rm.hasPhoto) {
        await api.editMessageCaption({
          chat_id: rm.chatId, message_id: Number(rm.messageId),
          caption: text.slice(0, 1024), reply_markup: kb,
        });
      } else {
        await api.editMessageText({
          chat_id: rm.chatId, message_id: Number(rm.messageId),
          text, reply_markup: kb, disable_web_page_preview: true,
        });
      }
    } catch { /* card may be deleted/too old — keep going */ }
  }
}

// ── Raid alert DMs (raid_alert_preferences) ─────────────────────────────────
// The subscribe button always promised a DM when a raid goes live, but no
// sender ever existed — the preferences were write-only. This is that
// sender (the source's "one-tap DM raid alerts"): every subscriber gets
// the card text plus a one-tap ⚔️ Done — Claim XP button bound to the
// session, and an Unsubscribe button (the subscribe confirmation copy
// points at it). Best-effort per user (a closed DM never breaks the raid
// send), capped per raid.
const RAID_ALERT_DM_CAP = 200;

export async function dmRaidAlerts(session) {
  try {
    const subs = await db.select().from(raid_alert_preferences)
      .where(eq(raid_alert_preferences.isSubscribed, true))
      .all().catch(() => []);
    if (!subs.length) return { sent: 0 };
    const count = await completionCount(session.id);
    const text = buildRaidText(session, count) +
      '\n\n🔔 You\'re getting this because raid alerts are ON for you.';
    const kb = {
      inline_keyboard: [
        [{ text: '⚔️ Done — Claim XP', callback_data: `raid_done:${session.id}` }],
        [{ text: '🔕 Unsubscribe', callback_data: 'raid_unsubscribe' }],
      ],
    };
    let sent = 0;
    for (const s of subs.slice(0, RAID_ALERT_DM_CAP)) {
      try {
        await api.sendMessage({
          chat_id: Number(s.telegramUserId), text,
          reply_markup: kb, disable_web_page_preview: true,
        });
        sent++;
      } catch { /* DM closed / bot blocked — skip */ }
    }
    return { sent };
  } catch { return { sent: 0 }; }
}

/** Raid declutter wave (2026-10-31): the short live card. Exactly four
 *  kinds of line — header (+min-% when tracked), target, one delta line
 *  per tracked metric, ONE count line. Nothing else: no mission, leader,
 *  XP, lock, shill, metric-header, or footer line. Untracked cards carry
 *  only header + target + count. */
export function buildRaidText(session, count) {
  const t = sessionMetricTargets(session);
  const g = metricGains(session);
  // Percent suffix = MIN across required (target >= 1) metrics; omitted
  // when untracked or before the first poll has set a baseline.
  let pct = null;
  if (t && g) {
    const required = X_METRIC_DEFS.filter((d) => (t[d.key] ?? 0) >= 1);
    if (required.length) pct = Math.min(...required.map((d) => metricPct(g[d.key], t[d.key])));
  }
  const lines = [
    `⚔️ RAID ALERT — ${session.platformEmoji} ${session.platform}${pct != null ? ` [${pct}%]` : ''}`,
    `🎯 Target: ${session.targetUrl}`,
  ];
  if (t) {
    for (const d of X_METRIC_DEFS) {
      if (t[d.key] == null) continue;
      // No baseline yet = nothing gained so far (the first poll sets it).
      lines.push(`${d.icon} ${d.label} +${g ? g[d.key] : 0}/${t[d.key]}`);
    }
  }
  lines.push(count === 0
    ? 'No raiders yet — be the first!'
    : `⚔️ ${count} Raider${count === 1 ? '' : 's'} confirmed`);
  return lines.join('\n');
}

export function buildRaidKeyboard(sessionId, count, targetCount, targetUrl, isLocked, communityUrl = null, isProfileRaid = false) {
  // Raid declutter wave (2026-10-31): 3 rows — open target, claim XP,
  // leaderboard. Share/lock/end/alerts/guide rows moved off the card
  // (shares live on the ended keyboard, lock/end on /raid lock|unlock
  // and /raid stop, guide/alerts on the /raid menu). isLocked stays in
  // the signature (callers untouched) but is IGNORED — the card never
  // shows lock state anymore. Every callback_data value is unchanged.
  // Profile raids (wave 2026-11-01): still exactly 3 rows. Row 1 is
  // Vote (the resolved post) + Join Community when a community link
  // exists (Vote alone when it does not); rows 2–3 are unchanged.
  // Non-profile cards are byte-identical to before: the new params
  // default off and no existing caller passes them.
  const rows = [];
  if (targetUrl) {
    if (isProfileRaid) {
      const row = [{ text: '🗳️ Vote →', url: targetUrl }];
      if (communityUrl) row.push({ text: '👥 Join Community', url: communityUrl });
      rows.push(row);
    } else {
      rows.push([{ text: '🎯 Go Raid Now →', url: targetUrl }]);
    }
  }
  rows.push([{ text: '⚔️ I Raided! — Claim XP', callback_data: `raid_done:${sessionId}` }]);
  rows.push([{ text: '🏆 Leaderboard', callback_data: `raid_board:${sessionId}` }]);
  return { inline_keyboard: rows };
}

export function buildEndedKeyboard(targetUrl) {
  // Raid declutter wave (2026-10-31): shares move HERE from the live
  // card, using the same intent/share URL shapes the old live card used.
  // Without a URL the keyboard renders exactly as before.
  const rows = [];
  if (targetUrl) {
    const encUrl = encodeURIComponent(targetUrl);
    const encText = encodeURIComponent('⚔️ RAID ALERT! Join our community raid — help us grow and earn XP! 🔥 @PoorBoyAI_bot');
    rows.push([
      { text: '🐦 Share on X', url: `https://twitter.com/intent/tweet?text=${encText}&url=${encUrl}` },
      { text: '✈️ Share on Telegram', url: `https://t.me/share/url?url=${encUrl}&text=${encText}` },
    ]);
  }
  rows.push([
    { text: '🏆 Leaderboard', callback_data: 'lb:ALL' },
    { text: '👤 My Profile', callback_data: 'raid_profile:0' },
  ]);
  return { inline_keyboard: rows };
}

export function buildEndedText(session, finalCount, isShill = false) {
  const icon = isShill ? '🔥' : '🛑';
  const noun = isShill ? 'Shiller' : 'Raider';
  const head = isShill ? `SHILL RAID ENDED — ${session.platformEmoji} ${session.platform}`
                       : `RAID ENDED — ${session.platformEmoji} ${session.platform}`;
  return [
    `${icon} ${head}`,
    '',
    `🎯 Target: ${session.targetUrl}`,
    '',
    `${icon} ${finalCount} ${finalCount === 1 ? noun : noun + 's'} — Mission Complete!`,
  ].join('\n');
}

export const RAID_HOW_TO_TEXT = [
  '📖 How to Raid and Claim XP',
  '',
  '1️⃣ Tap Go Raid Now and open the raid target.',
  '2️⃣ On the target post, like, repost, and reply.',
  '3️⃣ Return here and tap I Raided! — Claim XP.',
  '4️⃣ If the bot sends you a DM alert, use Done — Claim XP in that DM.',
  '',
  '🐦 X raids auto-verify: if your X account is linked AND verified (Connect Socials), PB detects your like, repost or reply on the target post by itself and DMs your XP — no tap needed. The tap stays as the backup for everyone else.',
  '',
  '📊 X raids are also tracked live: PB watches the post\'s likes, reposts and replies against the raid\'s targets and posts a results card the moment every target lands. Set your own targets with /raid <url> 50/20/10 (likes/reposts/replies).',
  '',
  'First time? Open @PoorBoyAI_bot in DM and tap Start before claiming an official-community raid.',
  'Connect X/Twitter, TikTok, or Discord from Connect Socials so your activity can be matched and verified.',
  '',
  'Official-community members can also earn XP from normal messages, emojis, stickers, and reactions.',
  'Check your balance with /profile or the leaderboard with /lb.',
].join('\n');

// ── Queue ────────────────────────────────────────────────────────────────────
export async function queueRaid(chatId, url, targetCount, addedBy, addedByName) {
  const platform = detectRaidPlatform(url);
  const rows = await db.insert(raid_queue).values({
    chatId,
    targetUrl: url,
    platform: platform.name,
    platformEmoji: platform.emoji,
    callToAction: platform.cta,
    targetCount: targetCount ?? null,
    addedBy,
    addedByName: addedByName ?? null,
    status: 'queued',
    createdAt: new Date(),
  }).returning();
  return rows[0];
}

export async function getQueueItems(chatId) {
  return db.select().from(raid_queue)
    .where(sql`${raid_queue.chatId} = ${chatId} AND ${raid_queue.status} = 'queued'`)
    .orderBy(sql`id ASC`)
    .all()
    .catch(() => []);
}

export async function clearQueue(chatId) {
  await db.delete(raid_queue)
    .where(sql`${raid_queue.chatId} = ${chatId} AND ${raid_queue.status} = 'queued'`)
    .run()
    .catch(() => {});
}

// Pops the next queued raid (source: advanceQueue after a raid ends).
// threadId: the forum topic of the raid that just ended (callers pass the
// ended session's persisted threadId), so the follow-up card lands in
// the same topic the queue was raiding in.
export async function advanceQueue(chatId, sendCard, threadId = null) {
  const items = await getQueueItems(chatId);
  if (!items.length) return null;
  const next = items[0];
  await db.delete(raid_queue).where(eq(raid_queue.id, next.id)).run().catch(() => {});
  const session = await createRaidSession({
    chatId: Number(chatId),
    url: next.targetUrl,
    platform: { name: next.platform, emoji: next.platformEmoji, cta: next.callToAction },
    targetCount: next.targetCount,
    creatorId: Number(next.addedBy),
    creatorName: next.addedByName ?? 'Commander',
    threadId: threadId ?? null,
  });
  if (sendCard) await sendCard(session);
  return session;
}

// ── Raid execution cores (shared by the one-shot commands' flows and the
// restored button/remote wizards below) ──────────────────────────────────────
// These run the exact steps the /raid and /shillraid handlers run: validate
// (object-form isValidRaidUrl), create the session (which ends actives),
// mark shill content for shill raids, post the card, persist the card ref.

/** Raid declutter wave (2026-10-31): the ONE card-send path. With a Pro
 *  banner stored for the chat, the short card rides as the media caption
 *  (sendPhoto/sendAnimation/sendVideo by stored type); a stale or
 *  undeliverable file_id falls back to a plain text send. Without a
 *  banner the card is text-only, exactly as before. Returns { sent,
 *  hasPhoto } so callers can persist the card shape truthfully. */
export async function sendRaidCardMessage(chatId, session, count, extra = {}) {
  const text = buildRaidText(session, count);
  const info = await getRaidCommunityInfo(session).catch(() => ({ communityUrl: null, isProfileRaid: false }));
  const kb = buildRaidKeyboard(session.id, count, session.targetCount, session.targetUrl, false, info.communityUrl, info.isProfileRaid);
  const banner = await resolveRaidBanner(chatId).catch(() => null);
  if (banner) {
    const method = { photo: 'sendPhoto', animation: 'sendAnimation', video: 'sendVideo' }[banner.type];
    const field = { photo: 'photo', animation: 'animation', video: 'video' }[banner.type];
    if (method) {
      const sent = await api[method]({
        chat_id: chatId, [field]: banner.fileId,
        caption: text.slice(0, 1024), reply_markup: kb, ...extra,
      }).catch(() => null);
      if (sent) return { sent, hasPhoto: true };
      // Stale file_id — fall through to the text send below.
    }
  }
  const sent = await api.sendMessage({
    chat_id: chatId, text, reply_markup: kb, disable_web_page_preview: true, ...extra,
  });
  return { sent, hasPhoto: false };
}

export async function sendRaidCardTo(chatId, session, { mission = '', markdown = true } = {}) {
  const count = await completionCount(session.id);
  const { sent, hasPhoto } = await sendRaidCardMessage(chatId, session, count, raidThreadExtra(session));
  if (sent?.message_id) await persistRaidCard(session.id, chatId, sent.message_id, hasPhoto);
  await dmRaidAlerts(session).catch(() => {});
  // The short card carries no mission line: a supplied mission rides as
  // its own follow-up message instead of being dropped or crammed into
  // the card (keeps the remote-wizard and kit-brief content intact).
  if (mission) {
    await api.sendMessage({
      chat_id: chatId, text: mission, ...raidThreadExtra(session),
    }).catch(() => {});
  }
  return sent;
}

export async function fireLiveRaid({ chatId, url, targetCount = null, creatorId, creatorName, threadId = null, metricTargets, communityUrl = null, isProfileRaid = false }) {
  const check = isValidRaidUrl(url);
  if (!check.ok) return { ok: false, reason: check.reason };
  const session = await createRaidSession({
    chatId, url, platform: detectRaidPlatform(url),
    targetCount, creatorId, creatorName, threadId, metricTargets, communityUrl, isProfileRaid,
  });
  await sendRaidCardTo(chatId, session);
  return { ok: true, session };
}

export async function fireShillRaid({ chatId, url, targetCount = null, creatorId, creatorName, threadId = null, metricTargets, communityUrl = null, isProfileRaid = false }, deps = {}) {
  const check = isValidRaidUrl(url);
  if (!check.ok) return { ok: false, reason: check.reason };
  const gen = deps.generatePost ?? generatePost;
  const gs = await getGroupSettings(chatId).catch(() => ({}));
  const topic = (gs?.tokenLabel ?? gs?.tokenAddress) || '$PBAI';
  const post = await gen('shillraid', topic).catch(() => '');
  const session = await createRaidSession({
    chatId, url, platform: detectRaidPlatform(url),
    targetCount, creatorId, creatorName, threadId, metricTargets, communityUrl, isProfileRaid,
  });
  await db.update(raid_sessions)
    .set({ isShillRaid: true, shillContent: post })
    .where(eq(raid_sessions.id, session.id))
    .run().catch(() => {});
  session.isShillRaid = true;
  session.shillContent = post;
  await sendRaidCardTo(chatId, session);
  // Raid declutter wave: the live card NEVER contains shill text — the
  // generated post rides as its own follow-up message in the same chat.
  if (post) {
    await api.sendMessage({
      chat_id: chatId, text: post,
      disable_web_page_preview: true, ...raidThreadExtra(session),
    }).catch(() => {});
  }
  return { ok: true, session, post };
}

// ── Raid declutter wave (2026-10-31): confirm-before-launch ───────────────
// A dropped link or a bare `/raid <url>` no longer fires instantly: PB
// posts a confirm card first, and only an admin tap launches. Pending
// state lives in CONFIG (no schema change) under raidcfm:<12-hex-id>,
// plus a per-chat+URL index key for dedupe. No timers in the isolate:
// pendings live until acted on; launch re-validates URL + admin at tap
// time. Callback handlers live in handlers/callback_query.js and re-check
// everything server-side; the builders + state helpers here are what the
// harness exercises directly.

export const RAID_CONFIRM_PRESETS = {
  small: { likes: 10, retweets: 5, replies: 2 },
  std: { likes: 25, retweets: 10, replies: 5 },
  large: { likes: 50, retweets: 20, replies: 10 },
};

export const raidConfirmKey = (id) => `raidcfm:${id}`;

/** Small deterministic hash (djb2, hex) for the chat+URL dedupe index. */
export function raidConfirmUrlHash(url) {
  let h = 5381;
  for (let i = 0; i < String(url).length; i++) h = ((h << 5) + h + String(url).charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}
const raidConfirmIndexKey = (chatId, url) => `raidcfm:idx:${chatId}:${raidConfirmUrlHash(url)}`;

function newConfirmId() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 12; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

export async function createRaidConfirm({ chatId, url, platform, metricTargets, targetCount, threadId, droppedBy, communityUrl = null, isProfileRaid = false, profileHandle = null }) {
  const pending = {
    id: newConfirmId(),
    chatId: Number(chatId),
    url,
    platform: platform?.name ?? 'Web',
    platformEmoji: platform?.emoji ?? '🌐',
    metricTargets: metricTargets ?? null,
    targetCount: targetCount ?? null,
    threadId: threadId ?? null,
    droppedBy: droppedBy ?? null,
    communityUrl: communityUrl ?? null,
    isProfileRaid: Boolean(isProfileRaid),
    profileHandle: profileHandle ?? null,
    createdAt: Date.now(),
  };
  await setConfig(raidConfirmKey(pending.id), JSON.stringify(pending)).catch(() => {});
  await setConfig(raidConfirmIndexKey(chatId, url), pending.id).catch(() => {});
  return pending;
}

export async function readRaidConfirm(id) {
  if (!/^[0-9a-f]{12}$/.test(String(id ?? ''))) return null;
  try {
    const raw = await getConfig(raidConfirmKey(id), null);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && typeof p === 'object' && p.url ? p : null;
  } catch { return null; }
}

export async function saveRaidConfirm(pending) {
  await setConfig(raidConfirmKey(pending.id), JSON.stringify(pending)).catch(() => {});
}

export async function clearRaidConfirm(pendingOrId) {
  const p = typeof pendingOrId === 'string' ? await readRaidConfirm(pendingOrId) : pendingOrId;
  const id = p?.id ?? pendingOrId;
  await setConfig(raidConfirmKey(id), '').catch(() => {});
  if (p) await setConfig(raidConfirmIndexKey(p.chatId, p.url), '').catch(() => {});
}

/** The live pending confirm for this chat + URL, or null (dedupe read). */
export async function findPendingConfirmFor(chatId, url) {
  try {
    const id = await getConfig(raidConfirmIndexKey(chatId, url), null);
    if (!id) return null;
    const p = await readRaidConfirm(id);
    return p && Number(p.chatId) === Number(chatId) && p.url === url ? p : null;
  } catch { return null; }
}

export function buildRaidConfirmText(pending, { hasActive = false, modify = false } = {}) {
  const t = pending?.metricTargets;
  // Real pendings carry platform as a normalized NAME string
  // (createRaidConfirm), but render defensively for an object shape too
  // — a raw platform object must never print as [object Object].
  const plat = pending?.platform;
  const platName = typeof plat === 'string' ? plat : (plat?.name ?? 'Web');
  const platEmoji = pending?.platformEmoji ?? plat?.emoji ?? '🌐';
  const lines = [
    '⚔️ Raid ready — confirm to launch',
    '',
    `🎯 ${platEmoji} ${platName}: ${pending?.url}`,
  ];
  // Profile raids: the launcher sees what was resolved, and where the
  // Join Community button will point — never a bare post URL with the
  // profile provenance hidden.
  if (pending?.isProfileRaid && pending?.profileHandle) {
    lines.push('', `📌 Resolved from @${pending.profileHandle}'s profile — latest post.`);
  }
  if (pending?.communityUrl) {
    lines.push(`👥 Community: ${pending.communityUrl}`);
  }
  if (t) {
    lines.push('', `Suggested: ❤️ Likes ${t.likes} · 🔁 Reposts ${t.retweets} · 💬 Replies ${t.replies}`);
  } else {
    lines.push('', 'No metric tracking for this platform — raiders confirm by tap.');
  }
  if (hasActive) lines.push('', 'Launching ends the current raid.');
  if (modify) {
    lines.push('', 'Custom targets? Use the advanced path: /raid <url> 50/20/10 (likes/reposts/replies).');
  }
  return lines.join('\n');
}

export function buildRaidConfirmKeyboard(id, pending = null, { modify = false } = {}) {
  if (modify) {
    return {
      inline_keyboard: [
        [
          { text: 'Small 10/5/2', callback_data: `raidcfm:preset:${id}:small` },
          { text: 'Standard 25/10/5', callback_data: `raidcfm:preset:${id}:std` },
          { text: 'Large 50/20/10', callback_data: `raidcfm:preset:${id}:large` },
        ],
        [{ text: '⬅️ Back', callback_data: `raidcfm:back:${id}` }],
      ],
    };
  }
  const rows = [[{ text: "🚀 Let's raid", callback_data: `raidcfm:launch:${id}` }]];
  // Modify is X-only: presets mean nothing for untracked platforms.
  if (pending?.metricTargets) {
    rows.push([{ text: '✏️ Modify targets', callback_data: `raidcfm:modify:${id}` }]);
  }
  rows.push([{ text: '❌ Ignore', callback_data: `raidcfm:ignore:${id}` }]);
  return { inline_keyboard: rows };
}

/** Create the pending confirm and post its card. X posts carry the PB
 *  default metric targets (config raid_metric_defaults retunes them);
 *  other platforms are untracked. Link preview stays ON — Telegram's
 *  native unfurl IS the post preview (no X API fetch at confirm time). */
export async function postRaidConfirm({ chatId, url, platform, targetCount = null, threadId = null, droppedBy = null, replyTo = null, metricTargets, communityUrl = null, isProfileRaid = false, profileHandle = null }) {
  const mt = metricTargets !== undefined
    ? metricTargets
    : await defaultMetricTargets(url).catch(() => null);
  const hasActive = Boolean(await getActiveRaid(chatId).catch(() => null));
  const pending = await createRaidConfirm({
    chatId, url, platform, metricTargets: mt, targetCount, threadId, droppedBy,
    communityUrl, isProfileRaid, profileHandle,
  });
  const sent = await api.sendMessage({
    chat_id: chatId,
    text: buildRaidConfirmText(pending, { hasActive }),
    reply_markup: buildRaidConfirmKeyboard(pending.id, pending),
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    ...(threadId != null && Number(threadId) > 0 ? { message_thread_id: Number(threadId) } : {}),
  });
  return { pending, sent, hasActive };
}

let _dropLinkBotUsername = null;
async function dropLinkBotUsername() {
  if (_dropLinkBotUsername !== null) return _dropLinkBotUsername;
  try {
    const me = await api.getMe();
    _dropLinkBotUsername = me?.username ?? null;
  } catch { _dropLinkBotUsername = null; }
  return _dropLinkBotUsername;
}

/** Drop-link start: a bare raid URL in group chat earns a confirm card
 *  as a REPLY to the dropped message. NEVER consumes the message — the
 *  caller keeps routing it normally; this only ever adds a card.
 *  Fully fail-open: any error means no card, never a broken handler.
 *  Skip rules: non-group chat, bot sender, command, PB-addressed (starts
 *  with the PB trigger, @-mentions the bot, or replies to a bot
 *  message), no valid raid URL, or a pending confirm already exists for
 *  the same chat + URL. Support-chat and Shield-deleted messages never
 *  reach here — the call site sits after both early returns. */
export async function maybeDropLinkRaid(chatId, message) {
  try {
    const chat = message?.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return false;
    const from = message?.from;
    if (!from || from.is_bot || message?.sender_chat) return false;
    const rawText = String(message?.text ?? message?.caption ?? '');
    const text = rawText.trim();
    if (!text || text.startsWith('/')) return false;
    // First VALID raid URL in the message (a non-raid link first does
    // not block a raid link later in the same message).
    let url = null;
    for (const m of rawText.match(/https?:\/\/[^\s]+/g) ?? []) {
      const clean = m.replace(/[.,;:!?)]+$/, '');
      if (isValidRaidUrl(clean).ok) { url = clean; break; }
    }
    if (!url) return false;
    // PB-addressed skip (cheap checks first; the username check only
    // runs when the message contains an @-mention at all).
    if (/^pb\b/i.test(text)) return false;
    if (message?.reply_to_message?.from?.is_bot) return false;
    if (text.includes('@')) {
      const botName = await dropLinkBotUsername();
      if (botName && text.toLowerCase().includes(`@${botName.toLowerCase()}`)) return false;
    }
    if (await findPendingConfirmFor(chatId, url)) return false;
    await postRaidConfirm({
      chatId, url, platform: detectRaidPlatform(url),
      threadId: message?.message_thread_id ?? null,
      droppedBy: from.id, replyTo: message.message_id,
    });
    return true;
  } catch { return false; }
}

// ── Raid declutter wave (2026-10-31): Pro raid banners ─────────────────────
// Raid-banner $29 wave (2026-11-01): the Pro tier no longer exists as a
// product (Free + 7-day trial + $29/mo PB Plan only), so the Pro gate is
// replaced by the PB Plan gate below. Mirror of the Portal banner pattern
// (lib/groups.js): a stored Telegram file_id + type, NEVER a hardcoded
// image URL. Free cards are text-only. Setting a banner is PB-Plan-gated
// at BOTH arm and capture; VIEWING a set banner is not a bypass (banners
// are group display, and a lapsed holder's banner persists as a group
// asset — removing it would delete group state, not restore an
// entitlement).

// Explicit allow-set, NOT a rank check: CANONICAL_TIER_RANK puts trial
// (6) above one (5), so tierAtLeast(tier, 'one') or ('pro') would let a
// trial user through. 'one' is the PB Plan. 'pro'/'agency' are retained
// ONLY as grandfathered holders to term end (not for sale, not a product
// tier); 'free', 'starter', 'builder', and 'trial' are refused. The owner
// resolves via effectiveTier to 'whale' → canonical 'agency', so the
// owner passes through the grandfathered-agency path — an internal
// resolution, never presented as a tier for sale.
export function canSetRaidBanner(tier) {
  const canon = canonicalTier(tier);
  return canon === 'one' || canon === 'pro' || canon === 'agency';
}

export const RAID_BANNER_GATE_TEXT =
  '⛔ PB Plan Required — custom raid banners are included in the PB Plan ($29/month). Upgrade with /upgrade.';
const RAID_BANNER_TTL_MS = 10 * 60 * 1000;

export const raidBannerKey = (chatId) => `raidbanner:${chatId}`;
export const raidBannerArmKey = (chatId, userId) => `raidbanner:${chatId}:${userId}`;

/** The stored banner for a chat, or null (unset, malformed, or bad type). */
export async function resolveRaidBanner(chatId) {
  try {
    const raw = await getConfig(raidBannerKey(chatId), null);
    if (!raw) return null;
    const b = JSON.parse(raw);
    if (!b || !b.fileId || !['photo', 'animation', 'video'].includes(b.type)) return null;
    return b;
  } catch { return null; }
}

export async function armRaidBanner(chatId, userId) {
  await setConfig(raidBannerArmKey(chatId, userId), JSON.stringify({
    chatId: Number(chatId), userId, expiresAt: Date.now() + RAID_BANNER_TTL_MS,
  })).catch(() => {});
}

export async function clearRaidBannerArm(chatId, userId) {
  await setConfig(raidBannerArmKey(chatId, userId), '').catch(() => {});
}

export async function clearRaidBanner(chatId) {
  await setConfig(raidBannerKey(chatId), '').catch(() => {});
}

/** Extract a storable { fileId, type } from a message (Portal shape). */
export function extractRaidBanner(message) {
  return portalBannerOf(message);
}

/** Armed banner capture (group media while a /raidbanner arm is live for
 *  this admin in this chat). Returns true only when the message was
 *  consumed (saved or PB-Plan-refused); plain text and unarmed media fall
 *  through untouched. Tier is re-checked HERE at capture time, not just
 *  at arm time — a lapsed admin's capture writes nothing. */
export async function handleRaidBannerCapture(chatId, message) {
  const userId = message?.from?.id;
  if (!userId) return false;
  let arm = null;
  try {
    const raw = await getConfig(raidBannerArmKey(chatId, userId), null);
    if (raw) arm = JSON.parse(raw);
  } catch { return false; }
  if (!arm || !arm.expiresAt || Date.now() > arm.expiresAt) {
    if (arm) await clearRaidBannerArm(chatId, userId).catch(() => {});
    return false;
  }
  const banner = portalBannerOf(message);
  if (!banner) return false;
  // Coordinator hardening (2026-10-31): admin re-checked at capture,
  // not just at arm — a demoted admin's arm writes nothing. An API
  // error leaves the arm intact (no write either way).
  let member = null;
  try { member = await api.getChatMember({ chat_id: chatId, user_id: userId }); } catch { member = null; }
  if (!member) return false;
  if (!['administrator', 'creator'].includes(member?.status)) {
    await clearRaidBannerArm(chatId, userId).catch(() => {});
    await api.sendMessage({ chat_id: chatId, text: '⛔ Only group admins can set a raid banner.' }).catch(() => {});
    return true;
  }
  await clearRaidBannerArm(chatId, userId).catch(() => {});
  const tier = await userTierOf(userId).catch(() => 'free');
  if (!canSetRaidBanner(tier)) {
    await api.sendMessage({ chat_id: chatId, text: RAID_BANNER_GATE_TEXT }).catch(() => {});
    return true;
  }
  await setConfig(raidBannerKey(chatId), JSON.stringify({
    fileId: banner.fileId, type: banner.type, setBy: userId, setAt: Date.now(),
  })).catch(() => {});
  const label = { photo: 'photo', animation: 'GIF', video: 'video' }[banner.type];
  await api.sendMessage({
    chat_id: chatId,
    text: `✅ Raid banner saved (${label}) — it will ride on top of raid cards in this group. /raidbanner off removes it.`,
  }).catch(() => {});
  return true;
}

// ── Shared wizard plumbing ───────────────────────────────────────────────────
const WIZ_TTL_MS = 10 * 60 * 1000;

async function saveWiz(key, sess) { await setConfig(key, JSON.stringify(sess)).catch(() => {}); }
async function clearWiz(key) { await setConfig(key, JSON.stringify({ expiresAt: 0 })).catch(() => {}); }
async function loadWiz(key) {
  try {
    const raw = await getConfig(key, null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    // A live session always carries a marker (kind/step); the cleared
    // payload is a bare { expiresAt: 0 } and must read as "no session",
    // never as "expired" (or the expiry note would repeat on every DM).
    if (!sess || typeof sess !== 'object' || (!sess.kind && !sess.step)) {
      return { sess: null, expired: false };
    }
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

export async function userTierOf(userId) {
  const row = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, String(userId))).get().catch(() => null);
  return effectiveTier(userId, row);
}

const BUILDER_GATE_DM =
  '⛔ Builder+ Required\n\nThis is available on Builder+ plans and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.';
const BUILDER_GATE_ALERT = '⛔ Builder+ Required — available on Builder+ plans and above. The PB Plan ($29/month) unlocks everything. Upgrade with /upgrade.';

// Retained for reuse: profile links now resolve to the latest post
// (wave 2026-11-01); this text is only for a path that cannot resolve.
const X_PROFILE_DM =
  '❌ That X profile could not be resolved to a post — send the direct link to a specific post, e.g. https://x.com/user/status/123…';

// ── /raid menu button wizard (raid:live / raid:shill) ────────────────────────
// The menu renders in a group; the tapper is walked in DM (the census's "DM
// walk over the live raid engine") and the raid fires back into that group
// through fireLiveRaid / fireShillRaid — the same cores as the one-shots.
// Gates mirror the commands exactly: live raid has no gate; shill is
// Builder+ (checked at tap AND again when the URL lands).
const raidWizKey = (userId) => `raidwiz:${userId}`;

export async function handleRaidButtonCallback(query) {
  const from = query.from;
  const chatId = query.message?.chat?.id;
  const data = String(query.data ?? '');
  if (!from?.id || chatId == null) return null;

  if (data === 'raidwiz:cancel') {
    await clearWiz(raidWizKey(from.id));
    return { text: 'Raid wizard cancelled.' };
  }
  const kind = data === 'raid:shill' ? 'shill' : 'live';
  if (String(chatId) === String(from.id)) {
    return { text: '⚔️ Run /raid in your group — the menu fires the raid into that group.', alert: true };
  }
  if (kind === 'shill') {
    const tier = await userTierOf(from.id);
    if (!tierAtLeast(tier, 'builder')) return { text: BUILDER_GATE_ALERT, alert: true };
  }
  const title = query.message?.chat?.title ?? 'your group';
  await saveWiz(raidWizKey(from.id), {
    kind, chatId, title, expiresAt: Date.now() + 5 * 60 * 1000,
    // The menu message's forum topic (when the tap happened in one) —
    // the fired card must land in that same topic, not the group root.
    threadId: query.message?.message_thread_id ?? null,
  });
  const prompt = kind === 'shill'
    ? `🔥 *Shill Raid — ${title}*\n\nSend me the post URL to shill — optionally add a target count:\n\n` +
      `\`https://x.com/user/status/123 50\`\n\nFor X posts you can also add metric targets like \`50/20/10\` (likes/reposts/replies) — PB tracks the post live and ends the raid itself when they're hit.\n\nPB writes the shill post with AI and fires the raid card into the group. Expires in 5 minutes.`
    : `⚔️ *Live Raid — ${title}*\n\nSend me the raid target URL — optionally add a target count:\n\n` +
      `\`https://x.com/user/status/123 50\`\n\nFor X posts you can also add metric targets like \`50/20/10\` (likes/reposts/replies) — PB tracks the post live and ends the raid itself when they're hit.\n\nThe raid card fires into the group. Expires in 5 minutes.`;
  const sent = await api.sendMessage({
    chat_id: from.id, text: prompt, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'raidwiz:cancel' }]] },
  }).catch(() => null);
  if (!sent) {
    await clearWiz(raidWizKey(from.id));
    return { text: '📩 Open a DM with me first (@PoorBoyAI_bot), then tap the button again.', alert: true };
  }
  return { text: '📩 Check your DMs — send the raid URL there.' };
}

/** DM capture for the raid menu wizard. Returns true when consumed. */
export async function handleRaidWizardText(chatId, msg, deps = {}) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const key = raidWizKey(userId);
  const { sess, expired } = await loadWiz(key);
  if (!sess) {
    if (expired) {
      await clearWiz(key);
      await api.sendMessage({ chat_id: userId, text: '⏰ That raid prompt expired. Tap the raid menu button in your group again.' }).catch(() => {});
      return true;
    }
    return false;
  }
  const parts = text.split(/\s+/).filter(Boolean);
  let url = parts[0] ?? '';
  // Trailing tokens: a bare number is the raider target; a L/R/R token
  // (e.g. 50/20/10) sets the X metric targets (raid tracking, 2026-10-23);
  // an http(s) token is the launcher's community link (profile raids).
  let targetCount = null;
  let metricTargets;
  let launcherCommunityUrl = null;
  for (const tok of parts.slice(1)) {
    const mt = parseMetricTargetToken(tok);
    if (mt) { metricTargets = mt; continue; }
    if (/^https?:\/\//i.test(tok)) { if (!launcherCommunityUrl) launcherCommunityUrl = tok; continue; }
    if (targetCount == null && /^\d+$/.test(tok) && parseInt(tok, 10) > 0) targetCount = parseInt(tok, 10);
  }
  const check = isValidRaidUrl(url);
  // Profile raids (wave 2026-11-01): resolve to the latest post first;
  // a failed resolution is a plain refusal, never a guessed target.
  // The wizard session is NOT cleared on failure, so the user can retry
  // with a direct post link in the same prompt.
  let communityUrl = null;
  let isProfileRaid = false;
  if (!check.ok && check.reason === 'x-profile') {
    const resolved = await resolveProfileLatestPost(url, deps).catch(() => ({ ok: false, reason: 'lookup-failed', handle: parseXProfileHandle(url) }));
    if (!resolved.ok) {
      await api.sendMessage({ chat_id: userId, text: profileRaidFailureText(resolved.reason, resolved.handle) }).catch(() => {});
      return true;
    }
    url = resolved.postUrl;
    communityUrl = launcherCommunityUrl ?? resolved.communityUrl;
    isProfileRaid = true;
  } else if (!check.ok) {
    await api.sendMessage({
      chat_id: userId,
      text: '❌ That doesn\'t look like a URL. Send the full link — e.g. https://x.com/user/status/123',
    }).catch(() => {});
    return true;
  }
  if (sess.kind === 'shill') {
    const tier = await userTierOf(userId);
    if (!tierAtLeast(tier, 'builder')) {
      await clearWiz(key);
      await api.sendMessage({ chat_id: userId, text: BUILDER_GATE_DM }).catch(() => {});
      return true;
    }
  }
  // Soft membership re-check: only an explicit left/kicked blocks (the /raid
  // command itself carries no gate; a getChatMember error can't prove exit).
  const member = await api.getChatMember({ chat_id: sess.chatId, user_id: userId }).catch(() => null);
  if (member && (member.status === 'left' || member.status === 'kicked')) {
    await clearWiz(key);
    await api.sendMessage({ chat_id: userId, text: `❌ You're no longer in ${sess.title}, so that raid wasn't fired.` }).catch(() => {});
    return true;
  }
  const creatorName = msg.from.first_name ?? msg.from.username ?? 'Commander';
  const res = sess.kind === 'shill'
    ? await fireShillRaid({ chatId: sess.chatId, url, targetCount, creatorId: userId, creatorName, threadId: sess.threadId ?? null, metricTargets, communityUrl, isProfileRaid }, deps)
    : await fireLiveRaid({ chatId: sess.chatId, url, targetCount, creatorId: userId, creatorName, threadId: sess.threadId ?? null, metricTargets, communityUrl, isProfileRaid });
  await clearWiz(key);
  if (!res.ok) {
    await api.sendMessage({ chat_id: userId, text: '❌ That URL can\'t be a raid target — send a link to a post on X, Reddit, etc.' }).catch(() => {});
    return true;
  }
  await api.sendMessage({
    chat_id: userId,
    text: sess.kind === 'shill'
      ? `🔥 Shill raid launched in ${sess.title}!`
      : `⚔️ Raid launched in ${sess.title}!`,
  }).catch(() => {});
  return true;
}

// ── /remote wizard (guided /remoteshill /remoteraid /remotesay) ─────────────
// Same gates as the one-shots: Builder+ and admin-of-target only (targets
// come from getMyGroupsFor and are re-verified at every step). The one-shot
// commands stay untouched; execution below mirrors their bodies.
const remoteWizKey = (userId) => `remotewiz:${userId}`;

export async function startRemoteWizard(userId, preselectAction = null) {
  const tier = await userTierOf(userId);
  if (!tierAtLeast(tier, 'builder')) {
    await api.sendMessage({ chat_id: userId, text: BUILDER_GATE_DM }).catch(() => {});
    return false;
  }
  const groups = await getMyGroupsFor(userId).catch(() => []);
  if (!groups.length) {
    await api.sendMessage({
      chat_id: userId,
      text: '❌ No groups found. You\'re not an admin of any group I serve yet.\n\nAdd me to your group, make yourself an admin there, then run /remote. Use /mygroups to check.',
    }).catch(() => {});
    return false;
  }
  await saveWiz(remoteWizKey(userId), {
    step: 'group', action: preselectAction, expiresAt: Date.now() + WIZ_TTL_MS,
  });
  // Menu-buttons fix (2026-11-05): the picker send reports delivery so a
  // group tap can post an honest pointer — a closed DM returns false
  // instead of a swallowed success. The gate / no-groups paths above
  // already return false (the wizard never started).
  try {
    await api.sendMessage({
      chat_id: userId,
      text: `🎮 *Remote Control*${preselectAction === 'raid' ? ' — ⚔️ Raid' : ''}\n\nPick the target group:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...groups.map((g) => [{ text: `🎯 ${g.title}`, callback_data: `rwiz:grp:${g.chatId}` }]),
          [{ text: '❌ Cancel', callback_data: 'rwiz:cancel' }],
        ],
      },
    });
  } catch { return false; }
  return true;
}

async function remoteInputPrompt(userId, sess) {
  const isRaid = sess.action === 'raid';
  await api.sendMessage({
    chat_id: userId,
    text: isRaid
      ? `⚔️ *Remote Raid → ${sess.title}*\n\nSend the raid URL — you can add a mission after it:\n\n` +
        `\`https://x.com/user/status/123 Push it past 100!\``
      : `💬 *Remote Say → ${sess.title}*\n\nSend the exact message to post in the group (up to 4,000 characters).`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'rwiz:cancel' }]] },
  }).catch(() => {});
}

export async function handleRemoteCallback(query, deps = {}) {
  const from = query.from;
  const data = String(query.data ?? '');
  if (!from?.id) return null;
  const key = remoteWizKey(from.id);

  if (data === 'rwiz:cancel') {
    await clearWiz(key);
    return { text: 'Remote control cancelled.' };
  }
  const { sess, expired } = await loadWiz(key);
  if (!sess) {
    return { text: expired ? '⏰ That remote session expired — run /remote again.' : '⏰ No active remote session — run /remote.', alert: true };
  }
  const tier = await userTierOf(from.id);
  if (!tierAtLeast(tier, 'builder')) {
    await clearWiz(key);
    return { text: BUILDER_GATE_ALERT, alert: true };
  }
  sess.expiresAt = Date.now() + WIZ_TTL_MS;

  if (data.startsWith('rwiz:grp:')) {
    const targetId = data.slice('rwiz:grp:'.length);
    const groups = await getMyGroupsFor(from.id).catch(() => []);
    const target = groups.find((g) => String(g.chatId) === targetId);
    if (!target) return { text: '❌ That group is no longer available to you.', alert: true };
    sess.chatId = Number(target.chatId);
    sess.title = target.title;
    if (sess.action === 'raid' || sess.action === 'say') {
      sess.step = 'input';
      await saveWiz(key, sess);
      await remoteInputPrompt(from.id, sess);
      return { text: `🎯 ${target.title} — send the ${sess.action === 'raid' ? 'raid URL' : 'message'} here.` };
    }
    sess.step = 'action';
    await saveWiz(key, sess);
    await api.sendMessage({
      chat_id: from.id,
      text: `🎮 *Remote Control → ${target.title}*\n\nWhat should PB do there?`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🔥 Shill', callback_data: 'rwiz:act:shill' },
          { text: '⚔️ Raid', callback_data: 'rwiz:act:raid' },
          { text: '💬 Say', callback_data: 'rwiz:act:say' },
        ], [{ text: '❌ Cancel', callback_data: 'rwiz:cancel' }]],
      },
    }).catch(() => {});
    return { text: `🎯 ${target.title} selected.` };
  }

  if (data.startsWith('rwiz:act:')) {
    const action = data.slice('rwiz:act:'.length);
    if (sess.chatId == null) return { text: 'Pick a target group first.', alert: true };
    if (action === 'shill') {
      await clearWiz(key);
      const gen = deps.generatePost ?? generatePost;
      try {
        const post = await gen('shillraid', '$PBAI');
        await api.sendMessage({ chat_id: sess.chatId, text: post, disable_web_page_preview: true });
        await api.sendMessage({
          chat_id: from.id,
          text: `✅ Shill post fired to ${sess.title}!\n\n_Preview:_\n${String(post).slice(0, 220)}${String(post).length > 220 ? '…' : ''}`,
        }).catch(() => {});
        return { text: '✅ Shill post fired.' };
      } catch (err) {
        const m = String(err?.message ?? '');
        await api.sendMessage({
          chat_id: from.id,
          text: /429|quota|rate.?limit/i.test(m)
            ? '❌ Failed: the AI is rate-limited right now — try again in a few minutes.'
            : '❌ Failed: PB hit a snag doing that — try again.',
        }).catch(() => {});
        return { text: '❌ Shill failed — see your DM.', alert: true };
      }
    }
    if (action === 'raid' || action === 'say') {
      sess.action = action;
      sess.step = 'input';
      await saveWiz(key, sess);
      await remoteInputPrompt(from.id, sess);
      return { text: action === 'raid' ? '⚔️ Send the raid URL here.' : '💬 Send the message here.' };
    }
  }

  return null;
}

/** DM capture for the remote wizard's input step. Returns true when consumed. */
export async function handleRemoteWizardText(chatId, msg) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const key = remoteWizKey(userId);
  const { sess, expired } = await loadWiz(key);
  if (!sess) {
    if (expired) {
      await clearWiz(key);
      await api.sendMessage({ chat_id: userId, text: '⏰ That remote session expired. Run /remote to start again.' }).catch(() => {});
      return true;
    }
    return false;
  }
  if (sess.step !== 'input' || sess.chatId == null) return false;
  const tier = await userTierOf(userId);
  if (!tierAtLeast(tier, 'builder')) {
    await clearWiz(key);
    await api.sendMessage({ chat_id: userId, text: BUILDER_GATE_DM }).catch(() => {});
    return true;
  }

  if (sess.action === 'say') {
    try {
      await api.sendMessage({ chat_id: sess.chatId, text: text.slice(0, 4000) });
      await api.sendMessage({ chat_id: userId, text: `✅ Message sent to ${sess.title}.` }).catch(() => {});
    } catch {
      await api.sendMessage({ chat_id: userId, text: '❌ Couldn\'t send — make sure I\'m still an admin there.' }).catch(() => {});
    }
    await clearWiz(key);
    return true;
  }

  // action === 'raid'
  const parts = text.split(/\s+/).filter(Boolean);
  let url = parts[0] ?? '';
  // An http(s) token after the raid URL is the launcher's community
  // link (profile raids); it is NOT part of the mission text.
  const restTokens = parts.slice(1);
  const launcherCommunityUrl = extractLauncherCommunityUrl(restTokens);
  const mission = restTokens.filter((t) => !/^https?:\/\//i.test(t)).join(' ');
  const check = isValidRaidUrl(url);
  let communityUrl = null;
  let isProfileRaid = false;
  if (!check.ok && check.reason === 'x-profile') {
    const resolved = await resolveProfileLatestPost(url).catch(() => ({ ok: false, reason: 'lookup-failed', handle: parseXProfileHandle(url) }));
    if (!resolved.ok) {
      await api.sendMessage({ chat_id: userId, text: profileRaidFailureText(resolved.reason, resolved.handle) }).catch(() => {});
      return true;
    }
    url = resolved.postUrl;
    communityUrl = launcherCommunityUrl ?? resolved.communityUrl;
    isProfileRaid = true;
  } else if (!check.ok) {
    await api.sendMessage({
      chat_id: userId,
      text: '❌ That doesn\'t look like a URL. Send the full link — e.g. https://x.com/user/status/123',
    }).catch(() => {});
    return true;
  }
  try {
    const session = await createRaidSession({
      chatId: sess.chatId, url, platform: detectRaidPlatform(url),
      targetCount: null, creatorId: userId,
      creatorName: msg.from.first_name ?? msg.from.username ?? 'Commander',
      communityUrl, isProfileRaid,
    });
    await sendRaidCardTo(sess.chatId, session, { mission, markdown: false });
    await api.sendMessage({ chat_id: userId, text: `⚔️ Raid fired in ${sess.title}!` }).catch(() => {});
  } catch (err) {
    await api.sendMessage({ chat_id: userId, text: `❌ Failed: ${err?.message ?? String(err)}` }).catch(() => {});
  }
  await clearWiz(key);
  return true;
}

export const REMOTE_COMMANDS = {
  // DM wizard; from a group it mirrors the house dmRedirect notice and the
  // picker opens in the caller's DM (startRemoteWizard DMs the user).
  remote: async (chatId, _args, msg) => {
    if (msg.chat.type !== 'private') {
      await api.sendMessage({ chat_id: chatId, text: '🔒 Sent to your DM!' }).catch(() => {});
    }
    await startRemoteWizard(msg.from.id);
  },
};

// ── X auto-tracking (raid wave, 2026-10-22) ─────────────────────────────────
// Rowdy's order: when a member has a LINKED AND VERIFIED X account (the
// twitter_handles store written by /mytwitter + the xsetup oEmbed tweet
// verification — only xVerified rows count), PB detects their raid
// participation on X-target raids itself and credits XP without the tap.
// Detection runs as a tick cycle (lib/tick.js cycleRaidAutoTrack); this
// section is the engine: credential resolution + a query-aware OAuth
// 1.0a signer + the three engager reads + the credit path.
//
// Credentials mirror lib/repurpose.js's resolution chains exactly (the
// live TWITTER_* family; TWITTER_ACCESS_TOKEN_V1 + TWITTER_ACCESS_TOKEN_
// SECRET are the authenticating 1.0a pair — the plain TWITTER_ACCESS_
// TOKEN is OAuth2-shaped and 401s). repurpose's signer is not exported
// and signs no query parameters (its two call sites have none), which
// GET /2/tweets/:id/retweeted_by?max_results=100 requires — so the
// signer is mirrored here with query params folded into the signature
// base string, per OAuth 1.0a. Values are never logged or returned.

const RAID_X_CRED_NAMES = {
  apiKey: ['TWITTER_API_KEY', 'X_API_KEY'],
  apiSecret: ['TWITTER_API_SECRET', 'X_API_SECRET'],
  accessToken: ['TWITTER_ACCESS_TOKEN_V1', 'TWITTER_ACCESS_TOKEN', 'X_ACCESS_TOKEN'],
  accessSecret: ['TWITTER_ACCESS_TOKEN_SECRET', 'TWITTER_ACCESS_SECRET', 'X_ACCESS_SECRET'],
};

async function resolveRaidXCreds(getCfg = getConfig) {
  const pick = async (names) => {
    for (const n of names) {
      const v = String((await getCfg(n, '')) || '').trim();
      if (v) return v;
    }
    return '';
  };
  const creds = {};
  for (const [field, names] of Object.entries(RAID_X_CRED_NAMES)) creds[field] = await pick(names);
  if (!creds.apiKey || !creds.apiSecret || !creds.accessToken || !creds.accessSecret) return null;
  return creds;
}

let raidXFetchOverride = null;
export function __setRaidXFetchForTest(fn) { raidXFetchOverride = fn; }

const raidXEnc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// Same local base64 encoder as repurpose.js (the isolate has no
// guaranteed btoa global).
function raidB64(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i) & 0xff;
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) & 0xff : 0;
    out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < str.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < str.length ? chars[c & 63] : '=';
  }
  return out;
}

/** OAuth 1.0a HMAC-SHA1 Authorization header for a GET whose URL query
 *  params are part of the signed parameter set (spec-correct mirror of
 *  repurpose.js's xOAuthHeader). */
async function raidXOAuthHeader(url, creds) {
  // Manual query parse — the isolate has NO global URL constructor
  // (proven by the raid-wave harness: 'URL is not defined').
  const qIdx = url.indexOf('?');
  const baseUrl = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const nonce = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const all = { ...oauth };
  if (qIdx >= 0) {
    for (const pair of url.slice(qIdx + 1).split('&')) {
      if (!pair) continue;
      const eqIdx = pair.indexOf('=');
      const k = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
      const v = eqIdx >= 0 ? pair.slice(eqIdx + 1) : '';
      try { all[decodeURIComponent(k)] = decodeURIComponent(v); } catch { all[k] = v; }
    }
  }
  const paramString = Object.keys(all).sort().map((k) => `${raidXEnc(k)}=${raidXEnc(all[k])}`).join('&');
  const baseString = ['GET', raidXEnc(baseUrl), raidXEnc(paramString)].join('&');
  const signingKey = `${raidXEnc(creds.apiSecret)}&${raidXEnc(creds.accessSecret)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  const signature = raidB64(String.fromCharCode(...new Uint8Array(sigBuf)));
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${raidXEnc(k)}="${raidXEnc(v)}"`).join(', ');
}

function raidXHttpError(status, what) {
  const err = new Error(`x ${what} http ${status}`);
  err.status = status;
  return err;
}

/** One signed GET against api.x.com. Returns the parsed JSON body.
 *  Throws an Error with .status on any non-2xx (the tick cycle turns
 *  that into a silent skip + backoff — never a credit, never a crash). */
export async function raidXGet(path, deps = {}) {
  const creds = await resolveRaidXCreds(deps.getConfig ?? getConfig);
  if (!creds) throw raidXHttpError(0, 'credentials missing');
  const doFetch = deps.fetch ?? raidXFetchOverride ?? fetch;
  const url = `https://api.x.com${path}`;
  const authHeader = await raidXOAuthHeader(url, creds);
  const res = await doFetch(url, { method: 'GET', headers: { Authorization: authHeader } });
  if (!res.ok) throw raidXHttpError(res.status, path.split('?')[0]);
  return res.json().catch(() => null);
}

/** The X post id a raid targets, or null when the target isn't an X post. */
export function xTweetIdOf(url) {
  const m = /\/status\/(\d+)/i.exec(String(url ?? ''));
  return m ? m[1] : null;
}

// Handle → X user id, resolved ONCE per (user, handle) and cached in a
// config row (`xautoid:<tgId>` = { h, id }) — never re-resolved per tick.
// A handle change invalidates the cache by construction (h mismatch).
// 404/other 4xx (renamed, suspended, deleted) caches id:null and the
// member is simply skipped; 429/5xx throws so the cycle backs off.
// Returns { id, fetched } — fetched=true when an X call was made (the
// cycle budgets those; cache hits are free).
export async function resolveXUserId(tgId, handle, deps = {}) {
  const getCfg = deps.getConfig ?? getConfig;
  const setCfg = deps.setConfig ?? setConfig;
  const clean = String(handle ?? '').replace(/^@/, '').trim();
  if (!clean) return { id: null, fetched: false };
  const key = `xautoid:${tgId}`;
  try {
    const raw = await getCfg(key, null);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached && String(cached.h ?? '').toLowerCase() === clean.toLowerCase()) {
        return { id: cached.id ? String(cached.id) : null, fetched: false };
      }
    }
  } catch { /* cache is best-effort */ }
  let data;
  try {
    data = await raidXGet(`/2/users/by/username/${encodeURIComponent(clean)}`, deps);
  } catch (err) {
    if (err?.status === 429 || (err?.status >= 500) || !err?.status) throw err;
    data = null; // 4xx: unresolvable handle — cache the miss below.
  }
  const id = data?.data?.id ? String(data.data.id) : null;
  await setCfg(key, JSON.stringify({ h: clean.toLowerCase(), id })).catch(() => {});
  return { id, fetched: true };
}

/** One detection pass over one X post: who reposted, liked, or replied.
 *  Returns Map<xUserId, 'repost'|'like'|'reply'> (first proven action in
 *  that priority order). Exactly 3 API calls, one page (≤100) each. The
 *  root tweet itself is excluded from reply matches (its conversation_id
 *  is its own id, so the search returns it too). Throws on any HTTP
 *  failure — the caller treats that as "skip this tick". */
export async function fetchXEngagers(tweetId, deps = {}) {
  const found = new Map();
  const absorbUsers = (data, action) => {
    for (const u of data?.data ?? []) {
      const id = u?.id ? String(u.id) : null;
      if (id && !found.has(id)) found.set(id, action);
    }
  };
  absorbUsers(await raidXGet(`/2/tweets/${tweetId}/retweeted_by?max_results=100`, deps), 'repost');
  absorbUsers(await raidXGet(`/2/tweets/${tweetId}/liking_users?max_results=100`, deps), 'like');
  const search = await raidXGet(
    `/2/tweets/search/recent?query=${encodeURIComponent(`conversation_id:${tweetId}`)}&max_results=100`, deps);
  for (const t of search?.data ?? []) {
    const author = t?.author_id ? String(t.author_id) : null;
    if (author && String(t.id) !== String(tweetId) && !found.has(author)) found.set(author, 'reply');
  }
  return found;
}

/** All LINKED AND VERIFIED X links (the only members auto-track may credit). */
export async function getVerifiedXLinks() {
  return db.select().from(twitter_handles)
    .where(eq(twitter_handles.xVerified, true))
    .all().catch(() => []);
}

const AUTO_ACTION_LABEL = { repost: 'repost', like: 'like', reply: 'reply' };

/**
 * Credit one auto-detected raid completion through the EXISTING
 * completeRaid core (its hasCompleted guard makes double-counting with
 * a manual tap impossible in either order), refresh the raid card, and
 * DM the member exactly one receipt. Returns { credited }.
 */
export async function creditAutoTrack(session, link, action) {
  const tgId = Number(link.telegramUserId);
  if (!tgId) return { credited: false };
  const user = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, String(tgId))).get().catch(() => null);
  const username = user?.username ?? null;
  const displayName = user?.firstName ?? (link.twitterHandle ? `@${link.twitterHandle}` : 'Raider');
  const result = await completeRaid(session, tgId, username, displayName);
  if (result.alreadyRaided) return { credited: false };
  await refreshRaidCards(session, result.count).catch(() => {});
  const xp = result.xpResult;
  const lines = [
    '⚔️ Raid verified on X!',
    '',
    `PB spotted your ${AUTO_ACTION_LABEL[action] ?? 'engagement'} on the raid target — +${xp?.actualXpEarned ?? session.xpPerRaid ?? 10} XP, no tap needed.`,
    `🎯 ${session.targetUrl}`,
    `⭐ XP balance: ${(xp?.newXP ?? 0).toLocaleString('en-US')} XP`,
  ];
  if (result.rankUp) lines.push('', result.rankUp);
  await api.sendMessage({ chat_id: tgId, text: lines.join('\n'), disable_web_page_preview: true }).catch(() => {});
  return { credited: true };
}

// ── X metrics tracking (raid tracking wave, 2026-10-23) ────────────────────
// Rowdy's order after seeing Parallax's Raidar completion card: an X-post
// raid carries per-metric targets (likes / reposts / replies the raid
// must ADD over its start-of-raid baseline). The tick's metrics cycle
// polls the post's public metrics, refreshes the live card, and the
// moment every target is met this engine ends the raid and posts PB's
// own results card. Scoring is delta-based: a post's pre-raid engagement
// never counts toward the raid's targets.
//
// Targets arrive three ways: the /raid + wizard token `50/20/10`, an
// explicit metricTargets param on the fire* cores, or — for any X-post
// raid created without them — the PB defaults below (the config row
// raid_metric_defaults, a JSON {likes, retweets, replies}, retunes
// them). A single metric set to 0 is "not required"; all-zero disables
// tracking for that raid.

export const DEFAULT_X_METRIC_TARGETS = { likes: 25, retweets: 10, replies: 5 };

/** The `likes/reposts/replies` target token, e.g. `50/20/10`. */
export function parseMetricTargetToken(tok) {
  const m = /^(\d{1,6})\/(\d{1,6})\/(\d{1,6})$/.exec(String(tok ?? '').trim());
  if (!m) return null;
  return { likes: Number(m[1]), retweets: Number(m[2]), replies: Number(m[3]) };
}

async function defaultMetricTargets(url) {
  if (!xTweetIdOf(url)) return null;
  let t = { ...DEFAULT_X_METRIC_TARGETS };
  try {
    const raw = await getConfig('raid_metric_defaults', null);
    if (raw) {
      const j = JSON.parse(raw);
      const clamp = (v, dflt) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.min(100000, Math.floor(n)) : dflt;
      };
      t = {
        likes: clamp(j?.likes, t.likes),
        retweets: clamp(j?.retweets, t.retweets),
        replies: clamp(j?.replies, t.replies),
      };
    }
  } catch { /* defaults stand */ }
  if (t.likes <= 0 && t.retweets <= 0 && t.replies <= 0) return { ...DEFAULT_X_METRIC_TARGETS };
  return t;
}

const X_METRIC_DEFS = [
  { key: 'likes', icon: '❤️', label: 'Likes' },
  { key: 'retweets', icon: '🔁', label: 'Reposts' },
  { key: 'replies', icon: '💬', label: 'Replies' },
];
const X_BASE_COL = { likes: 'xBaseLikes', retweets: 'xBaseRetweets', replies: 'xBaseReplies' };
const X_LAST_COL = { likes: 'xLastLikes', retweets: 'xLastRetweets', replies: 'xLastReplies' };

/** The session's metric targets, or null when the raid is untracked. */
export function sessionMetricTargets(session) {
  if (!session) return null;
  const t = {
    likes: session.xLikesTarget ?? null,
    retweets: session.xRetweetsTarget ?? null,
    replies: session.xRepliesTarget ?? null,
  };
  return (t.likes == null && t.retweets == null && t.replies == null) ? null : t;
}

/** Engagement gained since the baseline read, per metric (never
 *  negative). Null until the first poll has set the baseline. */
export function metricGains(session) {
  if (!session || session.xBaseLikes == null) return null;
  const gain = (key) => {
    const base = Number(session[X_BASE_COL[key]] ?? 0);
    const last = Number(session[X_LAST_COL[key]] ?? base);
    return Math.max(0, last - base);
  };
  return { likes: gain('likes'), retweets: gain('retweets'), replies: gain('replies') };
}

function metricPct(gained, target) {
  if (target == null) return null;
  if (target <= 0) return 100;
  return Math.min(100, Math.floor((gained / target) * 100));
}

/** True only when a baseline exists AND every required target is met. */
export function metricsAllMet(session) {
  const t = sessionMetricTargets(session);
  const g = metricGains(session);
  if (!t || !g) return false;
  if (!X_METRIC_DEFS.some((d) => (t[d.key] ?? 0) >= 1)) return false;
  return X_METRIC_DEFS.every((d) => {
    const target = t[d.key];
    return target == null || target <= 0 || g[d.key] >= target;
  });
}

/** The live-card metrics block ('' when untracked — untracked cards
 *  render byte-identical to before this wave). */
export function buildMetricBlock(session) {
  const t = sessionMetricTargets(session);
  if (!t) return '';
  const defs = X_METRIC_DEFS.filter((d) => t[d.key] != null);
  const g = metricGains(session);
  if (!g) {
    const parts = defs.map((d) => `${d.icon} ${t[d.key]}`).join(' · ');
    return `📊 X traction tracking is ON — targets ${parts}. First read lands within ~15 min.`;
  }
  const lines = defs.map((d) => {
    const hit = t[d.key] > 0 && g[d.key] >= t[d.key] ? ' ✅' : '';
    return `${d.icon} ${d.label} +${g[d.key]}/${t[d.key]} (${metricPct(g[d.key], t[d.key])}%)${hit}`;
  });
  return ['📊 Post traction — live from X:', ...lines].join('\n');
}

function sessionStartMs(session) {
  const s = session?.startedAt;
  if (s == null) return null;
  if (s instanceof Date) return s.getTime();
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function formatRaidDuration(session, endMs) {
  const start = sessionStartMs(session);
  if (!start || !endMs) return null;
  const mins = Math.max(0, Math.round((Number(endMs) - start) / 60000));
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
}

/** PB's results card — posted when a tracked raid ends (targets hit or
 *  time up). Honest by construction: `reached` is only ever true when
 *  metricsAllMet proved out on a real read, and the expiry variant
 *  labels its scoreboard as the last tracked read. */
export function buildRaidResultsText(session, { reached, raiders = 0 } = {}) {
  const t = sessionMetricTargets(session);
  const g = metricGains(session);
  const head = reached
    ? `🎉 RAID COMPLETE — ${session.platformEmoji} ${session.platform}`
    : `⏱️ RAID TIME UP — ${session.platformEmoji} ${session.platform}`;
  const lines = [head, '', `🎯 Target: ${session.targetUrl}`, ''];
  if (t && g) {
    lines.push(reached
      ? '📊 Final scoreboard — what this raid added:'
      : '📊 Final scoreboard — what this raid added (last tracked read):');
    for (const d of X_METRIC_DEFS) {
      if (t[d.key] == null) continue;
      const hit = t[d.key] > 0 && g[d.key] >= t[d.key] ? ' ✅' : '';
      lines.push(`${d.icon} ${d.label} +${g[d.key]}/${t[d.key]} (${metricPct(g[d.key], t[d.key])}%)${hit}`);
    }
    lines.push('');
  } else if (t) {
    lines.push('📊 X never returned a tracked read for this post, so there is no scoreboard to show — nothing invented here.', '');
  }
  const dur = formatRaidDuration(session, session.xEndedAt ?? Date.now());
  if (dur) lines.push(`⏱️ Duration: ${dur}`);
  const noun = session.isShillRaid ? 'Shiller' : 'Raider';
  lines.push(`⚔️ ${raiders} ${raiders === 1 ? noun : noun + 's'} confirmed on the card`);
  if (session.xPostText) {
    const who = [session.xAuthorName, session.xAuthorHandle ? `@${session.xAuthorHandle}` : null]
      .filter(Boolean).join(' · ');
    lines.push('', `🗣️ The post${who ? ` — ${who}` : ''}:`, `“${String(session.xPostText).slice(0, 240)}”`);
  }
  lines.push('', reached
    ? 'Every target hit — the timeline felt that one. 🔥'
    : 'Not every target landed this time — the scoreboard above is the honest final read. GGs to everyone who raided. ⚔️');
  return lines.join('\n');
}

// ── Metrics reads ────────────────────────────────────────────────────────────
const TWEET_METRICS_FIELDS =
  'tweet.fields=public_metrics,created_at&expansions=author_id&user.fields=name,username';

function tweetMetricsShape(t, users) {
  const m = t?.public_metrics ?? {};
  const author = users?.get(String(t?.author_id ?? ''));
  return {
    likes: Number(m.like_count ?? 0),
    retweets: Number(m.retweet_count ?? 0),
    replies: Number(m.reply_count ?? 0),
    text: t?.text != null ? String(t.text) : null,
    authorName: author?.name ?? null,
    authorHandle: author?.username ?? null,
  };
}

/** Batch public-metrics read: up to 100 posts in ONE signed call — the
 *  free-tier-safe shape (tweet lookup on the legacy free tier is
 *  ~1 request / 15 min, so every tracked raid rides a single request).
 *  Returns Map<tweetId, metrics>. Throws on any HTTP failure — the
 *  cycle backs off and never writes a stale or partial read. */
export async function fetchTweetMetrics(tweetIds, deps = {}) {
  const ids = [...new Set((tweetIds ?? []).map((x) => String(x ?? '')).filter(Boolean))].slice(0, 100);
  const out = new Map();
  if (!ids.length) return out;
  const data = await raidXGet(`/2/tweets?ids=${ids.join(',')}&${TWEET_METRICS_FIELDS}`, deps);
  const users = new Map((data?.includes?.users ?? []).map((u) => [String(u.id), u]));
  for (const t of data?.data ?? []) {
    if (t?.id) out.set(String(t.id), tweetMetricsShape(t, users));
  }
  return out;
}

/** Single-post fallback for when the batch lookup errors — one post
 *  per call, same shape. */
export async function fetchOneTweetMetrics(tweetId, deps = {}) {
  const data = await raidXGet(`/2/tweets/${tweetId}?${TWEET_METRICS_FIELDS}`, deps);
  const users = new Map((data?.includes?.users ?? []).map((u) => [String(u.id), u]));
  return data?.data ? tweetMetricsShape(data.data, users) : null;
}

/** Persist one metrics read onto the session row. The FIRST read after
 *  creation becomes the baseline (the raid is scored on what the post
 *  gains from there); later reads move only the "last" snapshot. The
 *  session object is mutated to match so callers can score and render
 *  without a re-read. */
export async function applyTweetMetrics(session, m, now = Date.now()) {
  if (!session || !m) return { baselined: false };
  const baselined = session.xBaseLikes == null;
  const set = {
    xLastLikes: m.likes, xLastRetweets: m.retweets, xLastReplies: m.replies,
    xLastPollAt: now,
  };
  if (baselined) {
    set.xBaseLikes = m.likes;
    set.xBaseRetweets = m.retweets;
    set.xBaseReplies = m.replies;
  }
  if (m.text && !session.xPostText) set.xPostText = String(m.text).slice(0, 280);
  if (m.authorName && !session.xAuthorName) set.xAuthorName = String(m.authorName).slice(0, 80);
  if (m.authorHandle && !session.xAuthorHandle) set.xAuthorHandle = String(m.authorHandle).slice(0, 40);
  await db.update(raid_sessions).set(set)
    .where(eq(raid_sessions.id, session.id)).run().catch(() => {});
  Object.assign(session, set);
  return { baselined };
}

/** End a tracked raid and land its results card. The card is a NEW
 *  post (so the group actually sees it, and Telegram renders its own
 *  X preview for the bare link — no preview suppression on this send);
 *  the old live cards are stubbed so nobody keeps raiding a finished
 *  target, and the queue advances like any other raid end. The results
 *  message id is stored at raidresult:<sessionId> as the receipt. */
export async function endTrackedRaid(session, reason = 'targets') {
  const now = Date.now();
  const reached = reason === 'targets';
  await db.update(raid_sessions)
    .set({ isActive: false, xEndReason: reason, xEndedAt: now })
    .where(eq(raid_sessions.id, session.id)).run().catch(() => {});
  session.isActive = false;
  session.xEndReason = reason;
  session.xEndedAt = now;
  const raiders = await completionCount(session.id);
  const text = buildRaidResultsText(session, { reached, raiders });
  const sent = await api.sendMessage({
    chat_id: Number(session.chatId), text,
    reply_markup: buildEndedKeyboard(session.targetUrl),
    ...raidThreadExtra(session),
  }).catch(() => null);
  if (sent?.message_id) {
    await setConfig(`raidresult:${session.id}`, String(sent.message_id)).catch(() => {});
  }
  const stub = [
    reached
      ? '🎉 This raid hit every target — the results card is posted in the chat. ⚔️'
      : '⏱️ This raid has ended — the final card carries the results.',
    '',
    `🎯 Target: ${session.targetUrl}`,
  ].join('\n');
  const msgs = await raidCardMessages(session.id);
  for (const rm of msgs) {
    try {
      // Photo cards stub via caption, text cards via text (declutter wave).
      if (rm.hasPhoto) {
        await api.editMessageCaption({
          chat_id: rm.chatId, message_id: Number(rm.messageId),
          caption: stub, reply_markup: buildEndedKeyboard(session.targetUrl),
        });
      } else {
        await api.editMessageText({
          chat_id: rm.chatId, message_id: Number(rm.messageId),
          text: stub, reply_markup: buildEndedKeyboard(session.targetUrl), disable_web_page_preview: true,
        });
      }
    } catch { /* card gone */ }
  }
  await advanceQueue(
    Number(session.chatId),
    (next) => sendRaidCardTo(Number(session.chatId), next),
    session.threadId ?? null,
  ).catch(() => {});
  return { resultsMessageId: sent?.message_id ?? null };
}

// ── LaunchPad kit raid slots (kit-build wave 4, 2026-10-31) ────────────────
// Spec §4; Q5 decided (creator picks window or PB assigns; community must
// exist at claim time, no minimum age). Storage: config `kit_raid_slots`
// (no schema change). NO import of opscmds.js here — opscmds imports this
// module, so the kit_coins registry is read from its config key directly
// (same key as wave 1, documented), and the coin-page URL builder below
// duplicates opscmds.kitCoinPageUrl for the same reason (canonical copy
// lives in opscmds.js; keep the two in sync if the page path changes).
// Booking is config-only (no raid_sessions rows until fire time).
export const KIT_RAID_SLOTS_KEY = 'kit_raid_slots';
const KIT_RAID_MAX_WINDOW_MS = 2 * 60 * 60 * 1000; // matches the 2h session length
const KIT_RAID_ASSIGN_DAYS = 7;

function kitRaidNormChain(chain) {
  return String(chain ?? '').toLowerCase().replace(/_/g, '-');
}
export function kitRaidCoinPageUrl(coin) {
  const ca = encodeURIComponent(String(coin?.contract ?? '').trim());
  const sym = String(coin?.symbol ?? '').trim();
  return `https://redesign-preview.poorboyai.pages.dev/buy/token/?ca=${ca}&chain=base${sym ? `&symbol=${encodeURIComponent(sym)}` : ''}&kit=1`;
}
export async function readKitRaidSlots() {
  try {
    const raw = await getConfig(KIT_RAID_SLOTS_KEY, '[]');
    const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function writeKitRaidSlots(slots) {
  await setConfig(KIT_RAID_SLOTS_KEY, JSON.stringify(slots));
}
async function readKitCoinsDirect() {
  try {
    const raw = await getConfig('kit_coins', '[]');
    const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function kitSlotKey(contract, chain) {
  return `${kitRaidNormChain(chain)}:${String(contract ?? '').trim().toLowerCase()}`;
}
function kitWindowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** Honest-engagement brief for a kit raid slot (mission text on the card). */
export function buildKitRaidBrief({ coin, slot }) {
  const when = new Date(slot.windowStart).toISOString();
  return [
    `Kit raid for ${coin.name} ($${coin.symbol}).`,
    `Where: ${slot.community}`,
    `When: ${when} (1-hour window, UTC).`,
    'How to help, honestly: visit the coin’s own community, ask a question, react, or share the coin page link below.',
    'Opt-in only — nobody is required to join, and nobody is paid per message. No fake accounts, no scripted messages.',
    'This is NOT a trending slot, NOT a Dexscreener placement, and NOT a CEX listing.',
    `🔗 ${kitRaidCoinPageUrl(coin)}`,
  ].join('\n');
}

/**
 * Book a kit raid slot. Returns { ok, slot, reason }. Rules (spec §4 + Q5):
 * - Coin must be a registered kit coin; one live slot per coin.
 * - No community (neither given nor on the coin) → slot is VOID, terminal:
 *   re-booking a void coin is refused, never banked or swapped.
 * - Window: ISO-8601 or 'assign' (PB assigns booking+24h, 1h, collision-
 *   checked against ALL booked slots, up to 7 days out). Refuses: bad ISO,
 *   past start, end ≤ start, duration > 2h, X-profile community links.
 */
export async function bookKitRaidSlot({ contract, chain, window, community, by }) {
  const clean = String(contract ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(clean)) return { ok: false, reason: 'contract must be a 0x address' };
  const coins = await readKitCoinsDirect();
  const coin = coins.find((c) => String(c.contract ?? '').toLowerCase() === clean
    && (!chain || kitRaidNormChain(c.chain) === kitRaidNormChain(chain)));
  if (!coin) return { ok: false, reason: 'coin not registered as a kit coin (run /kitregister first)' };
  const slots = await readKitRaidSlots();
  const key = kitSlotKey(clean, coin.chain);
  const live = slots.find((s) => kitSlotKey(s.contract, s.chain) === key && (s.status === 'booked' || s.status === 'fired'));
  if (live) return { ok: false, reason: `slot already exists for this coin (${live.status})` };
  const voided = slots.find((s) => kitSlotKey(s.contract, s.chain) === key && s.status === 'void');
  if (voided) return { ok: false, reason: 'raid slot is VOID for this coin (no community at claim time — never banked or swapped)' };
  const comm = (community && String(community).trim()) || coin.community || null;
  const now = Date.now();
  if (!comm) {
    const slot = { contract: clean, chain: kitRaidNormChain(coin.chain), windowStart: null, windowEnd: null, assignedBy: null, community: null, status: 'void', createdAt: Math.floor(now / 1000), createdBy: by ?? null };
    slots.push(slot);
    await writeKitRaidSlots(slots);
    return { ok: true, slot, void: true };
  }
  const urlCheck = isValidRaidUrl(comm);
  if (!urlCheck.ok) return { ok: false, reason: `community link invalid: ${urlCheck.reason}` };
  let windowStart;
  let windowEnd;
  let assignedBy;
  const w = String(window ?? '').trim();
  if (w === '' || w.toLowerCase() === 'assign') {
    assignedBy = 'pb';
    let placed = null;
    for (let d = 0; d < KIT_RAID_ASSIGN_DAYS && !placed; d++) {
      const s = now + (24 + d * 24) * 60 * 60 * 1000;
      const e = s + 60 * 60 * 1000;
      const clash = slots.some((x) => x.status === 'booked' && x.windowStart && kitWindowsOverlap(s, e, x.windowStart, x.windowEnd));
      if (!clash) placed = { s, e };
    }
    if (!placed) return { ok: false, reason: 'no free PB window in the next 7 days — pick a window explicitly' };
    windowStart = placed.s;
    windowEnd = placed.e;
  } else {
    assignedBy = 'creator';
    const parts = w.split('/');
    const s = Date.parse(parts[0]);
    const e = parts[1] ? Date.parse(parts[1]) : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return { ok: false, reason: 'window must be ISO start/end (start/end) or "assign"' };
    if (s <= now) return { ok: false, reason: 'window must start in the future' };
    if (e <= s) return { ok: false, reason: 'window end must be after start' };
    if (e - s > KIT_RAID_MAX_WINDOW_MS) return { ok: false, reason: 'window longer than 2 hours (matches the raid session length)' };
    windowStart = s;
    windowEnd = e;
  }
  const slot = { contract: clean, chain: kitRaidNormChain(coin.chain), windowStart, windowEnd, assignedBy, community: comm, status: 'booked', createdAt: Math.floor(now / 1000), createdBy: by ?? null, firedAt: null };
  slots.push(slot);
  await writeKitRaidSlots(slots);
  return { ok: true, slot, void: false };
}
