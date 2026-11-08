// lib/xp.js — XP engine.
// Ported from telegram-community-bot.ts: upsertRaidXP, awardActivityXP,
// recordReferral XP bits, getPBRank, getRaidXP, buildRaidToast.
// All XP math values below are the source's (never invented).

import { api, fetch } from 'sdk';
import db, { eq, sql } from 'sdk/db';
import { raid_xp, raid_squads, group_settings, trending_votes, buy_events, buy_watch_state } from '../schema.js';
import { getConfig, setConfig } from './config.js';
import { checkPbai, getUserWallets } from './accounts.js';
import { dmOptinPromptLine, shouldShowDmOptinPrompt, readDmOptinNotifications } from './broadcastcmds.js';

// ── PB Army ranks — source: PB_RANKS + getPBRank (line 4061) ─────────────────
export const PB_RANKS = [
  { min: 0,     emoji: '🥾', name: 'Broke Boi' },
  { min: 100,   emoji: '🗡️',  name: 'Foot Soldier' },
  { min: 300,   emoji: '⚔️',  name: 'Trench Warrior' },
  { min: 600,   emoji: '🔥',  name: 'Grinder' },
  { min: 1000,  emoji: '💀',  name: 'Raid Sergeant' },
  { min: 2000,  emoji: '👑',  name: 'PoorBoy Captain' },
  { min: 5000,  emoji: '🏆',  name: 'Army General' },
  { min: 10000, emoji: '💎',  name: 'PoorBoy Legend' },
];

export function getPBRank(xp) {
  let rank = PB_RANKS[0];
  for (const r of PB_RANKS) {
    if (xp >= r.min) rank = r;
    else break;
  }
  return rank;
}

// ── Rank-milestone rewards (Skeleton-benchmark restore, Rowdy-queued) ───────
// Crossing into a new PB Army rank pays a one-time XP bonus per rank per
// community: bonus = rank threshold / 10 (100→+10 … 10,000→+1,000). The
// durable guard is a config key holding the highest rank INDEX already paid
// for this (user, community) — an admin /remxp drop can never re-arm a paid
// rank. The bonus is applied by direct DB increment (never via addXpRaw, so
// it cannot recurse, and it gets no streak/multiplier treatment). Milestones
// pay XP only — no token/credit movement exists here by design.
export function rankIndexOf(xp) {
  let idx = 0;
  for (let i = 0; i < PB_RANKS.length; i++) {
    if (xp >= PB_RANKS[i].min) idx = i;
    else break;
  }
  return idx;
}

const milestoneKey = (userId, chatId) => `xpmile:${userId}:${chatId}`;

export async function maybeGrantRankMilestone(userId, chatId, prevXP, newXP) {
  const prevIdx = rankIndexOf(prevXP ?? 0);
  const newIdx = rankIndexOf(newXP ?? 0);
  if (newIdx <= prevIdx) return null;
  let granted = 0;
  try { granted = Number(await getConfig(milestoneKey(userId, chatId), '0')) || 0; } catch { granted = 0; }
  let bonus = 0;
  for (let i = Math.max(prevIdx, granted) + 1; i <= newIdx; i++) bonus += Math.floor(PB_RANKS[i].min / 10);
  if (bonus <= 0) return null;
  await setConfig(milestoneKey(userId, chatId), String(newIdx)).catch(() => {});
  await db.update(raid_xp)
    .set({ xp: sql`${raid_xp.xp} + ${bonus}`, updatedAt: new Date() })
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .run()
    .catch((e) => console.error('[rankMilestone]', e?.message ?? e));
  const rank = PB_RANKS[newIdx];
  const next = PB_RANKS[newIdx + 1];
  await api.sendMessage({
    chat_id: userId,
    text:
      `🎉 *Rank up!* You just hit ${rank.emoji} *${rank.name}* (${rank.min.toLocaleString()} XP) on this community's XP board.\n\n` +
      `🏅 Milestone reward: *+${bonus} XP* added. Rank milestones pay once per rank per community, in XP.\n` +
      (next ? `Next rank: ${next.emoji} ${next.name} at ${next.min.toLocaleString()} XP — keep raiding! ⚔️` : `That's the top rank. Absolute legend status. 💎`),
    parse_mode: 'Markdown',
  }).catch(() => {});
  return { rank, bonus };
}

// ── XP per platform — source: getRaidXP (line 4070) ───────────────────────────
const RAID_XP_MAP = {
  'X / Twitter': 20,
  'Reddit': 15,
  'DexScreener': 12,
  'PumpFun': 12,
  'Ape.Store': 12,
  'TikTok': 10,
  'YouTube': 10,
  'Telegram': 10,
  'Web': 8,
};
export function getRaidXP(platform) {
  return RAID_XP_MAP[platform] ?? 10;
}

// ── Raid toast — source: buildRaidToast ───────────────────────────────────────
export function buildRaidToast(xp, count, isShillRaid = false) {
  const verb = isShillRaid ? 'SHILLED' : 'RAIDED';
  const noun = isShillRaid ? 'Shiller' : 'Raider';
  let msg = `${isShillRaid ? '🔥' : '⚔️'} ${verb}! ${noun} #${count} — +${xp.actualXpEarned} XP! LFG 🚀`;
  if (xp.isFirstRaidToday && xp.streak > 1) msg += ` 🔥 ${xp.streak}-day streak!`;
  if (xp.multiplier >= 1.5) msg += ` 💎 PBAI HOLDER 1.5x!`;
  else if (xp.multiplier > 1) msg += ` 💳 Wallet 1.25x!`;
  return msg;
}

// ── Referral rewards — source: referral copy (+5 referred, +3 referrer) ───────
export const REFERRER_XP_REWARD = 3;
export const REFERRED_XP_REWARD = 5;

// ── Activity XP daily cap — source: ACTIVITY_XP_DAILY_CAP = 50 ───────────────
export const ACTIVITY_XP_DAILY_CAP = 50;

// ── XP community policy — v1 reads group_settings JSON ───────────────────────
// Source semantics: getXpCommunityPolicy(chatId) → { enabled, official,
// tokenLabel }. The original derived this from env + per-group token config.
// v1: enabled defaults true for tracked groups; official + tokenLabel come
// from group_settings.settings (owner-configurable).
export async function getXpCommunityPolicy(chatId) {
  try {
    const row = await db.select().from(group_settings)
      .where(eq(group_settings.chatId, String(chatId))).get();
    const s = row?.settings ?? {};
    return {
      enabled: s.xpEnabled !== false,
      official: Boolean(s.isOfficial),
      tokenLabel: s.tokenLabel ?? '$PBAI',
    };
  } catch {
    return { enabled: true, official: false, tokenLabel: '$PBAI' };
  }
}

// ── Core: addXp — port of upsertRaidXP ───────────────────────────────────────
// Source logic (line ~4317): streak accounting on last_raid_date, multiplier
// (holder 1.5x official / wallet 1.25x), streak bonus min(streak*2, 30) for
// the first raid of the day, squad XP roll-up.
export async function addXp(userId, chatId, username, displayName, baseXpDelta) {
  const community = await getXpCommunityPolicy(chatId);
  if (!community.enabled) {
    return {
      newXP: 0, prevXP: 0, actualXpEarned: 0,
      streak: 0, multiplier: 1, isFirstRaidToday: false,
    };
  }

  const row = await db.select().from(raid_xp)
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .get()
    .catch(() => null);
  const prevXP = row?.xp ?? 0;

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const lastDate = row?.lastRaidDate ?? null;

  let streak, isFirstRaidToday;
  if (!lastDate || lastDate < yesterday) {
    streak = 1; isFirstRaidToday = true;
  } else if (lastDate === yesterday) {
    streak = (row?.streak ?? 0) + 1; isFirstRaidToday = true;
  } else {
    streak = row?.streak ?? 1; isFirstRaidToday = false;
  }

  const isHolder = community.official && Boolean(row?.pbaiHolder);
  const hasWallet = Boolean(row?.walletAddress);
  const multiplier = isHolder ? 1.5 : hasWallet ? 1.25 : 1.0;
  const streakBonus = isFirstRaidToday ? Math.min(streak * 2, 30) : 0;
  const actualXpEarned = Math.floor(baseXpDelta * multiplier) + streakBonus;

  await db.insert(raid_xp).values({
    userId, chatId,
    username: username ?? null,
    displayName: displayName ?? null,
    xp: actualXpEarned,
    streak,
    lastRaidDate: today,
    pbaiHolder: Boolean(row?.pbaiHolder),
    squadId: row?.squadId ?? null,
    isDisqualified: false,
    walletAddress: row?.walletAddress ?? null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [raid_xp.userId, raid_xp.chatId],
    set: {
      xp: sql`${raid_xp.xp} + ${actualXpEarned}`,
      streak,
      lastRaidDate: today,
      username: sql`COALESCE(${raid_xp.username}, ${username ?? null})`,
      displayName: sql`COALESCE(${raid_xp.displayName}, ${displayName ?? null})`,
      updatedAt: new Date(),
    },
  }).run().catch((e) => console.error('[addXp]', e?.message ?? e));

  const fresh = await db.select().from(raid_xp)
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .get()
    .catch(() => null);
  const newXP = fresh?.xp ?? prevXP + actualXpEarned;

  // Squad roll-up (same as raid path).
  if (row?.squadId) {
    await db.update(raid_squads)
      .set({ squadXp: sql`${raid_squads.squadXp} + ${actualXpEarned}` })
      .where(eq(raid_squads.id, row.squadId))
      .run()
      .catch(() => {});
  }

  const milestone = await maybeGrantRankMilestone(userId, chatId, prevXP, newXP).catch(() => null);

  return { newXP, prevXP, actualXpEarned, streak, multiplier, isFirstRaidToday, milestone };
}

// ── Raw add (no streak/multiplier) — referral & admin awards ─────────────────
// Mirrors the referral path: shares the raid_xp balance/leaderboard but must
// NOT create or advance a raid streak.
export async function addXpRaw(userId, chatId, username, displayName, amount) {
  const community = await getXpCommunityPolicy(chatId);
  if (!community.enabled) return { newXP: 0, prevXP: 0 };
  const row = await db.select().from(raid_xp)
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .get()
    .catch(() => null);
  const prevXP = row?.xp ?? 0;
  await db.insert(raid_xp).values({
    userId, chatId,
    username: username ?? null,
    displayName: displayName ?? null,
    xp: amount,
    streak: row?.streak ?? 0,
    lastRaidDate: row?.lastRaidDate ?? null,
    pbaiHolder: Boolean(row?.pbaiHolder),
    squadId: row?.squadId ?? null,
    isDisqualified: false,
    walletAddress: row?.walletAddress ?? null,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [raid_xp.userId, raid_xp.chatId],
    set: {
      xp: sql`${raid_xp.xp} + ${amount}`,
      username: sql`COALESCE(${raid_xp.username}, ${username ?? null})`,
      displayName: sql`COALESCE(${raid_xp.displayName}, ${displayName ?? null})`,
      updatedAt: new Date(),
    },
  }).run().catch((e) => console.error('[addXpRaw]', e?.message ?? e));
  const milestone = await maybeGrantRankMilestone(userId, chatId, prevXP, prevXP + amount).catch(() => null);
  return { newXP: prevXP + amount, prevXP, milestone };
}

// ── Reads ────────────────────────────────────────────────────────────────────
export async function getUserXPRow(userId, chatId) {
  return db.select().from(raid_xp)
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .get()
    .catch(() => null);
}

export async function getTotalXp(userId, chatId) {
  const row = await getUserXPRow(userId, chatId);
  return row?.xp ?? 0;
}

// Top-N leaderboard for a chat (source: /lb ALL query shape, raid_completions-based).
export async function leaderboardByCompletions(chatId, limit = 10, sinceUnix = null) {
  // Uses raw SQL — joins raid_completions → raid_sessions, disqualified filter.
  const rows = await db.all(sql`
    SELECT rc.user_id AS userId, rc.display_name AS displayName, rc.username AS username,
           SUM(rc.xp_earned) AS xp
    FROM raid_completions rc
    JOIN raid_sessions rs ON rs.id = rc.raid_id AND rs.chat_id = ${chatId}
    LEFT JOIN raid_xp rx ON rx.user_id = rc.user_id AND rx.chat_id = ${chatId}
    WHERE (rx.is_disqualified IS NULL OR rx.is_disqualified = 0)
      ${sinceUnix ? sql`AND rc.completed_at > ${sinceUnix}` : sql``}
    GROUP BY rc.user_id, rc.display_name, rc.username
    HAVING SUM(rc.xp_earned) > 0
    ORDER BY xp DESC
    LIMIT ${limit}
  `).catch(() => []);
  return rows;
}

// ── XP Rewards helpers (restored /xprewards support) ────────────────────────
// Completed-raid count for one user in one community — same join shape as
// leaderboardByCompletions (completions joined to that community's sessions).
export async function raidCompletionCount(userId, chatId) {
  const rows = await db.all(sql`
    SELECT COUNT(*) AS n
    FROM raid_completions rc
    JOIN raid_sessions rs ON rs.id = rc.raid_id AND rs.chat_id = ${chatId}
    WHERE rc.user_id = ${userId}
  `).catch(() => []);
  return Number(rows?.[0]?.n ?? 0);
}

// Persist the rewards/base wallet address onto the XP row (source: the
// original's /connect wrote raid_xp.wallet_address; the live /connect path
// stores user_wallets only, so the /xprewards wallet step writes both).
// Upserts a minimal row when the user has no XP row yet (xp 0).
export async function setRaidWalletAddress(userId, chatId, address, displayName = null) {
  const row = await getUserXPRow(userId, chatId).catch(() => null);
  await db.insert(raid_xp).values({
    userId, chatId,
    username: row?.username ?? null,
    displayName: row?.displayName ?? displayName,
    xp: row?.xp ?? 0,
    streak: row?.streak ?? 0,
    lastRaidDate: row?.lastRaidDate ?? null,
    pbaiHolder: Boolean(row?.pbaiHolder),
    squadId: row?.squadId ?? null,
    isDisqualified: Boolean(row?.isDisqualified),
    walletAddress: address,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [raid_xp.userId, raid_xp.chatId],
    set: { walletAddress: address, updatedAt: new Date() },
  }).run().catch((e) => console.error('[setRaidWalletAddress]', e?.message ?? e));
}

// Set/clear the verified-holder flag on an EXISTING XP row (update-only,
// mirroring the original's holder-verify step).
export async function setPbaiHolderFlag(userId, chatId, value) {
  await db.update(raid_xp)
    .set({ pbaiHolder: Boolean(value), updatedAt: new Date() })
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .run()
    .catch((e) => console.error('[setPbaiHolderFlag]', e?.message ?? e));
}

// ── Trending votes + rank power (Skeleton Price Bot benchmark, 2026-10-21) ──
// Skeleton's steal-worthy core: a community VOTE on tokens where your
// LEVEL is your power. PB's version runs on the real PB Army ladder:
//   • /vote in a group backs a token (a CA argument, or the group's
//     featured token with no argument).
//   • Vote WEIGHT = rank index + 1 on the 8-rank ladder (🥾 Broke Boi 1
//     → 💎 PoorBoy Legend 8). Rank stops being status and becomes power.
//   • HOLDER FAST-TRACK: holding ≥ TRENDING_FASTTRACK_DEFAULT $PBAI
//     votes at TOP weight (8) whatever your rank — Skeleton's NFT
//     shortcut, translated. The balance read is the LIVE checkPbai
//     (accounts.js), never the pbai_holder_wallets bootstrap snapshot
//     (nothing in the live tree refreshes that table). Threshold is
//     tunable via the config key below — one owner config write.
//   • ANTI-SYBIL (proven activity): a vote counts only from a member
//     with a registered wallet (user_wallets, or the raid_xp wallet
//     the /xprewards step writes) AND real XP in THAT group (xp > 0,
//     not disqualified). Every refusal says exactly what's missing.
//   • One vote per user per token per rolling 24h window, enforced in
//     castVote against trending_votes (a UNIQUE constraint cannot
//     express a rolling window). Weight is snapshotted at cast time.
//   • The board (trendingBoard) publishes tokens + aggregates ONLY.
//     trending_votes.chat_id is stored for rank context/dedupe audit
//     and is NEVER selected by a board query — community sealing.

export const TRENDING_VOTE_WINDOW_SEC = 24 * 3600;
export const TRENDING_FASTTRACK_CONFIG_KEY = 'trending_fasttrack_pba';
export const TRENDING_FASTTRACK_DEFAULT = 100000; // $PBAI
export const TOP_VOTE_WEIGHT = PB_RANKS.length; // 8 — PoorBoy Legend weight

/** Vote weight for a ladder position: rank index + 1 (1..8). */
export function voteWeightForRankIndex(idx) {
  return Math.max(0, Math.min(PB_RANKS.length - 1, Number(idx) || 0)) + 1;
}

export async function trendingFastTrackThreshold() {
  try {
    const raw = await getConfig(TRENDING_FASTTRACK_CONFIG_KEY, null);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : TRENDING_FASTTRACK_DEFAULT;
  } catch {
    return TRENDING_FASTTRACK_DEFAULT;
  }
}

/** Normalize a user-supplied token address → { ca, chain } or null.
 *  Same rules as the campaign model: 0x… → Base (lowercased);
 *  base58 32–44 → Solana (verbatim — base58 is case-sensitive). */
export function normalizeVoteCa(raw) {
  const s = String(raw ?? '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { ca: s.toLowerCase(), chain: 'base' };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { ca: s, chain: 'sol' };
  return null;
}

async function featuredVoteTarget(chatId) {
  try {
    const row = await db.select().from(group_settings)
      .where(eq(group_settings.chatId, String(chatId))).get();
    const s = row?.settings ?? {};
    const raw = s.tokenAddress ?? s.featuredToken ?? null;
    return raw ? normalizeVoteCa(raw) : null;
  } catch {
    return null;
  }
}

/** Best-effort symbol for a token: the Buy Bot's watch state first
 *  (free, local), then one GeckoTerminal token read. Null when unknown —
 *  callers render the short CA instead. */
export async function resolveVoteSymbol(ca, chain) {
  try {
    const st = await db.select().from(buy_watch_state)
      .where(eq(buy_watch_state.ca, ca)).get().catch(() => null);
    if (st?.symbol) return String(st.symbol).slice(0, 20);
  } catch { /* fall through */ }
  try {
    const net = chain === 'sol' ? 'solana' : 'base';
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${ca}`);
    if (res?.ok) {
      const j = await res.json().catch(() => null);
      const sym = j?.data?.attributes?.symbol;
      if (sym) return String(sym).slice(0, 20);
    }
  } catch { /* best effort */ }
  return null;
}

const shortCa = (ca) => (ca.length > 14 ? `${ca.slice(0, 8)}…${ca.slice(-4)}` : ca);

/**
 * Cast a vote. Returns { ok:true, ca, chain, symbol, weight, rank,
 * fastTrack, xp } or { ok:false, code, text } where text is the honest
 * user-facing refusal. Never throws for user error.
 */
export async function castVote(userId, chatId, caArg) {
  const xpRow = await getUserXPRow(userId, chatId).catch(() => null);
  if (!xpRow || !(Number(xpRow.xp) > 0)) {
    return { ok: false, code: 'NO_XP', text: '🗳️ No vote counted — you have no XP in this community yet. Earn XP here first (raids + activity), then your rank gives your vote real weight. Around here, rank = power.' };
  }
  if (xpRow.isDisqualified) {
    return { ok: false, code: 'DISQUALIFIED', text: '🗳️ No vote counted — your XP in this community is disqualified, so your votes don\'t count here. If that\'s a mistake, an admin can lift it with /undisqualify.' };
  }
  const wallets = await getUserWallets(userId).catch(() => null);
  const hasWallet = Boolean(wallets?.baseAddress || wallets?.solAddress || wallets?.rhAddress || xpRow.walletAddress);
  if (!hasWallet) {
    return { ok: false, code: 'NO_WALLET', text: '🗳️ No vote counted — votes need a registered wallet (that\'s the anti-sybil rule: proven members only). Run /connect <your Base or Solana address> first, then vote.' };
  }

  let target = null;
  const arg = String(caArg ?? '').trim();
  if (arg) {
    target = normalizeVoteCa(arg.split(/\s+/)[0]);
    if (!target) {
      return { ok: false, code: 'BAD_CA', text: '🗳️ That doesn\'t look like a token address. Paste a Base (0x…) or Solana contract address — or run /vote with no address to back this group\'s featured token.' };
    }
  } else {
    target = await featuredVoteTarget(chatId);
    if (!target) {
      return { ok: false, code: 'NO_TOKEN', text: '🗳️ This group has no featured token set, so there\'s nothing to vote for yet. Vote with an address — /vote <contract address> — or an admin can set the featured token with /settoken.' };
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const since = nowSec - TRENDING_VOTE_WINDOW_SEC;
  const prior = await db.all(sql`
    SELECT created_at AS createdAt FROM trending_votes
    WHERE user_id = ${Number(userId)} AND ca = ${target.ca} AND created_at > ${since}
    ORDER BY created_at DESC LIMIT 1
  `).catch(() => []);
  if (prior?.length) {
    const leftSec = Math.max(0, Number(prior[0].createdAt) + TRENDING_VOTE_WINDOW_SEC - nowSec);
    const h = Math.floor(leftSec / 3600);
    const m = Math.floor((leftSec % 3600) / 60);
    return { ok: false, code: 'DUP', text: `🗳️ You already voted for ${shortCa(target.ca)} — one vote per token per 24h. Your next vote for it opens in ~${h}h ${m}m.` };
  }

  const rankIdx = rankIndexOf(Number(xpRow.xp) || 0);
  const rank = PB_RANKS[rankIdx];
  let weight = voteWeightForRankIndex(rankIdx);
  let fastTrack = false;
  if (weight < TOP_VOTE_WEIGHT && wallets?.baseAddress) {
    const threshold = await trendingFastTrackThreshold();
    const check = await checkPbai(wallets.baseAddress).catch(() => ({ available: false, balance: 0 }));
    if (check?.available && Number(check.balance) >= threshold) {
      weight = TOP_VOTE_WEIGHT;
      fastTrack = true;
    }
  }

  const symbol = await resolveVoteSymbol(target.ca, target.chain);
  await db.insert(trending_votes).values({
    userId: Number(userId),
    chatId: String(chatId),
    ca: target.ca,
    chain: target.chain,
    symbol,
    weight,
    fastTrack,
    createdAt: nowSec,
  }).run();

  return { ok: true, ca: target.ca, chain: target.chain, symbol, weight, rank, fastTrack, xp: Number(xpRow.xp) || 0 };
}

/**
 * The PB Trending board — last 24h, two sealed aggregate lists.
 * byVotes: SUM(weight) as power + raw vote counts. byBuys: real Buy
 * Bot volume from buy_events. ONLY ca/chain/symbol/aggregates leave
 * this function — no chat ids, no group names, ever (sealing rule).
 */
export async function trendingBoard(limit = 10) {
  const lim = Math.max(1, Math.min(25, Number(limit) || 10));
  const since = Math.floor(Date.now() / 1000) - TRENDING_VOTE_WINDOW_SEC;
  const voteRows = await db.all(sql`
    SELECT ca, chain, MAX(symbol) AS symbol, COUNT(*) AS votes, SUM(weight) AS power
    FROM trending_votes
    WHERE created_at > ${since}
    GROUP BY ca, chain
    ORDER BY power DESC, votes DESC
    LIMIT ${lim}
  `).catch(() => []);
  const buyRows = await db.all(sql`
    SELECT ca, chain, COUNT(*) AS buys, SUM(usd_amount) AS usdVolume
    FROM buy_events
    WHERE created_at > ${since}
    GROUP BY ca, chain
    ORDER BY usdVolume DESC
    LIMIT ${lim}
  `).catch(() => []);
  const byVotes = (voteRows ?? []).map((r) => ({
    ca: r.ca, chain: r.chain, symbol: r.symbol ?? null,
    votes: Number(r.votes) || 0, power: Number(r.power) || 0,
  }));
  const byBuys = [];
  for (const r of (buyRows ?? [])) {
    let symbol = null;
    try {
      const st = await db.select().from(buy_watch_state)
        .where(eq(buy_watch_state.ca, r.ca)).get().catch(() => null);
      symbol = st?.symbol ?? null;
    } catch { /* symbol stays null */ }
    byBuys.push({
      ca: r.ca, chain: r.chain, symbol,
      buys: Number(r.buys) || 0,
      usdVolume: Math.round((Number(r.usdVolume) || 0) * 100) / 100,
    });
  }
  return { windowHours: 24, byVotes, byBuys };
}

/** Mini App / sync view: the board + the caller's own rank power. */
export async function trendingForUser(userId) {
  const board = await trendingBoard(10);
  let you = null;
  try {
    const rows = await db.all(sql`
      SELECT MAX(xp) AS xp FROM raid_xp WHERE user_id = ${Number(userId)}
    `).catch(() => []);
    const xp = Number(rows?.[0]?.xp ?? 0);
    const idx = rankIndexOf(xp);
    you = {
      xp,
      rankIndex: idx,
      rankName: PB_RANKS[idx].name,
      rankEmoji: PB_RANKS[idx].emoji,
      weight: voteWeightForRankIndex(idx),
      fastTrackThreshold: await trendingFastTrackThreshold(),
    };
  } catch { /* you stays null */ }
  return { ...board, you };
}

const trendUsd = (v) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: Number(v) >= 100 ? 0 : 2 });
const tokenLabel = (r) => (r.symbol ? `$${r.symbol}` : shortCa(r.ca));

export function formatTrendingBoard(board, youLine = null) {
  const lines = ['📈 PB Trending — last 24h', ''];
  lines.push('🔥 By community votes (weight = rank power)');
  if (board.byVotes.length) {
    board.byVotes.forEach((r, i) => lines.push(`${i + 1}. ${tokenLabel(r)} — ⚡${r.power} power · ${r.votes} vote${r.votes === 1 ? '' : 's'}`));
  } else {
    lines.push('No votes yet in the last 24h — be the first: /vote in your group.');
  }
  lines.push('', '💰 By real buy volume (Buy Bot tracked)');
  if (board.byBuys.length) {
    board.byBuys.forEach((r, i) => lines.push(`${i + 1}. ${tokenLabel(r)} — ${trendUsd(r.usdVolume)} across ${r.buys} buy${r.buys === 1 ? '' : 's'}`));
  } else {
    lines.push('No tracked buys in the last 24h yet.');
  }
  if (youLine) lines.push('', youLine);
  lines.push('', '🗳️ /vote in any PB group — your PB Army rank is your weight (🥾 1 → 💎 8).');
  return lines.join('\n');
}

async function trendSay(chatId, text) {
  try { await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000) }); } catch { /* 403 etc. */ }
}

export const TRENDING_COMMANDS = {
  /** /vote [CA] — group-only; rank-weighted, anti-sybil gated. */
  vote: async (chatId, args, msg) => {
    if (msg?.chat?.type === 'private') {
      await trendSay(chatId, '🗳️ Votes live in groups — run /vote inside a community where you\'ve earned XP. Your rank there is your voting power.');
      return;
    }
    const res = await castVote(msg.from.id, chatId, args);
    if (!res.ok) { await trendSay(chatId, res.text); return; }
    const label = res.symbol ? `$${res.symbol}` : shortCa(res.ca);
    const lines = [`🗳️ Vote counted for ${label} (${shortCa(res.ca)})`];
    if (res.fastTrack) {
      const threshold = await trendingFastTrackThreshold();
      lines.push(`⚡ Weight ${res.weight} — 💎 holder fast-track: you hold ≥ ${threshold.toLocaleString('en-US')} $PBAI, so you vote at top-rank power (your rank here: ${res.rank.emoji} ${res.rank.name}).`);
    } else {
      lines.push(`⚡ Weight ${res.weight} — your rank here: ${res.rank.emoji} ${res.rank.name} (${res.xp.toLocaleString('en-US')} XP).`);
    }
    lines.push('See the board: /trending');
    // DM opt-in prompt (2026-11-07): only while the voter has NOT already
    // opted in — opted-in members never see it again. Fail-open: an
    // unreadable row shows the prompt.
    if (shouldShowDmOptinPrompt(await readDmOptinNotifications(msg.from.id))) {
      lines.push('', dmOptinPromptLine('vote'));
    }
    await trendSay(chatId, lines.join('\n'));
  },

  /** /trending — the sealed aggregate board (groups + DM). */
  trending: async (chatId, args, msg) => {
    const board = await trendingBoard(10);
    let youLine = null;
    if (msg?.chat?.type !== 'private' && msg?.from?.id) {
      const row = await getUserXPRow(msg.from.id, chatId).catch(() => null);
      if (row && Number(row.xp) > 0) {
        const idx = rankIndexOf(Number(row.xp));
        youLine = `Your power in this group: ${PB_RANKS[idx].emoji} ${PB_RANKS[idx].name} — ⚡${voteWeightForRankIndex(idx)} per vote.`;
      } else {
        youLine = 'You have no XP in this group yet — earn some, then /vote with real weight.';
      }
    }
    let boardText = formatTrendingBoard(board, youLine);
    // DM opt-in prompt (2026-11-07): groups only (a DM reader is already
    // DM-reachable) and only while the member has NOT already opted in.
    // Appended here, not inside formatTrendingBoard — the callback refresh
    // (callback_query.js) stays clean.
    if (msg?.chat?.type !== 'private' && msg?.from?.id
      && shouldShowDmOptinPrompt(await readDmOptinNotifications(msg.from.id))) {
      boardText += `\n\n${dmOptinPromptLine('trending')}`;
    }
    await trendSay(chatId, boardText);
  },
};

// All-time hall of fame from the raid_xp ledger (source: /raidrank).
export async function hallOfFame(chatId, limit = 10) {
  const rows = await db.all(sql`
    SELECT display_name AS displayName, username, xp,
      (SELECT COUNT(*) FROM raid_completions rc WHERE rc.user_id = raid_xp.user_id) AS raids
    FROM raid_xp
    WHERE chat_id = ${chatId}
      AND (is_disqualified IS NULL OR is_disqualified = 0)
      AND xp > 0
    ORDER BY xp DESC
    LIMIT ${limit}
  `).catch(() => []);
  return rows;
}
