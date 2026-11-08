// Contests — Forgotten Features §4 rebuild (v1), ported from the
// self-contained contest block in telegram-community-bot.ts (~27129–27715:
// formatQualRules, calculateContestWinners, announceContestWinners, the
// 5-minute scheduler, /conteststatus, /contestwinner).
//
// v1 scope (per design §4): creation is an explicit admin wizard (/contest,
// button-driven like /raidsetup & /bizsetup, with a final confirm step).
// The original's ambient post-detection + AI rule parsing
// (tryRegisterContest / parseContestRules) is PARKED as v2 — v1 never
// auto-registers anything from a sniffed message.
//
// Sealing: every row and every read is keyed by chat_id and only ever
// surfaces inside that chat. A contest in one community is invisible to
// another — no cross-group boards.
//
// MONEY RULE (hard): cash_prize_text is TEXT ONLY. PB announces who won and
// what the stated prize is; PB does not hold, move, or pay out cash prizes.
// No wallet signing, no automated payout path, no money movement here.
//
// Live-store adaptations (documented, mechanics unchanged):
//  • Message counts come from group_message_log aggregated per sender
//    (from_user_id) over the window — the live replacement for the
//    original's user_message_stats table; no new stats table.
//  • X activity = raid completions on X/Twitter raid sessions (the live
//    raid_completions table carries no tweet_url column; an X raid session
//    IS a specific X post by construction — /raid validates that).
//  • wallet_linked reads user_wallets (the live replacement for the
//    original's airdrop_wallets read).
//  • pbai_holder reads raid_xp.pbai_holder (the original's exact check),
//    falling back to the live on-chain holder check in lib/accounts.js
//    (checkPbai on the linked Base wallet) when the flag is unset.
//  • Referral counts are fetched when the referrals weight is > 0 OR a
//    min_referrals qualification exists — the original fetched only on
//    weight > 0, which made a min_referrals rule unsatisfiable at the
//    default weights; the rule now works as documented.
//  • XP prizes are awarded via addXpRaw so the stated amounts land EXACTLY
//    (500/300/150 by default): no streak advance, no holder multiplier —
//    the same reasoning as the referral path in lib/xp.js.

import { api } from 'sdk';
import db, { eq, desc, sql, inArray, and, lte } from 'sdk/db';
import { contests, raid_xp, twitter_handles, user_wallets } from '../schema.js';
import { addXpRaw, getXpCommunityPolicy } from './xp.js';
import { checkPbai, getUserWallets } from './accounts.js';
import { getConfig, setConfig } from './config.js';

// ── Shared formatting (source: formatQualRules) ─────────────────────────────

export function formatQualRules(rules) {
  if (!rules?.length) return '';
  return '\n✅ <b>Qualifications to win:</b>\n' + rules.map((r) => `• ${r.description}`).join('\n');
}

function scoringLine(cfg, withReferrals = false) {
  let s = `📊 Scoring: Raids ${cfg.raids ?? 40}% · Messages ${cfg.messages ?? 30}% · X ${cfg.x_activity ?? 30}%`;
  if (withReferrals && (cfg.referrals ?? 0) > 0) s += ` · Invites ${cfg.referrals}%`;
  return s;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Contest timestamps are unix-seconds (schema ts convention). */
function toSec(v) {
  if (v == null) return 0;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const p = Date.parse(v);
  return Number.isFinite(p) ? Math.floor(p / 1000) : 0;
}

function fmtUtc(sec) {
  return new Date(sec * 1000).toLocaleString('en-US', {
    timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short',
  }) + ' UTC';
}

export function contestRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    chatId: Number(r.chatId),
    createdBy: Number(r.createdBy),
    contestName: r.contestName,
    rulesRaw: r.rulesRaw ?? null,
    startAt: toSec(r.startAt),
    endAt: toSec(r.endAt),
    status: r.status,
    scoringConfig: r.scoringConfig ?? { raids: 40, messages: 30, x_activity: 30 },
    cashPrizeText: r.cashPrizeText ?? null,
    xpPrizes: r.xpPrizes ?? { first: 500, second: 300, third: 150 },
    winnerAnnounced: Boolean(r.winnerAnnounced),
    qualificationRules: Array.isArray(r.qualificationRules) ? r.qualificationRules : [],
  };
}

/** Latest active contest for THIS chat (source: /conteststatus query). */
export async function getActiveContest(chatId) {
  const row = await db.select().from(contests)
    .where(and(eq(contests.chatId, Number(chatId)), eq(contests.status, 'active')))
    .orderBy(desc(contests.createdAt)).limit(1).get().catch(() => null);
  return contestRow(row);
}

/** Latest un-announced contest for THIS chat (source: /contestwinner query). */
export async function getPendingContest(chatId) {
  const row = await db.select().from(contests)
    .where(and(eq(contests.chatId, Number(chatId)), eq(contests.winnerAnnounced, false)))
    .orderBy(desc(contests.createdAt)).limit(1).get().catch(() => null);
  return contestRow(row);
}

export async function createContest({ chatId, createdBy, contestName, rulesRaw = null, startAt, endAt, scoringConfig, cashPrizeText = null, xpPrizes, qualificationRules }) {
  const rows = await db.insert(contests).values({
    chatId: Number(chatId),
    createdBy: Number(createdBy),
    contestName: contestName ?? 'Community Contest',
    rulesRaw,
    startAt: new Date(startAt * 1000),
    endAt: new Date(endAt * 1000),
    status: 'active',
    scoringConfig: scoringConfig ?? { raids: 40, messages: 30, x_activity: 30 },
    cashPrizeText,
    xpPrizes: xpPrizes ?? { first: 500, second: 300, third: 150 },
    winnerAnnounced: false,
    qualificationRules: qualificationRules ?? [],
  }).returning();
  return contestRow(rows[0]);
}

// ── Scoring (source: calculateContestWinners, ported faithfully) ────────────

export async function calculateContestWinners(contest, topN = 3) {
  const chatId = Number(contest.chatId ?? contest.chat_id);
  const startAt = toSec(contest.startAt ?? contest.start_at);
  const endAt = toSec(contest.endAt ?? contest.end_at);
  const cfg = contest.scoringConfig ?? contest.scoring_config ?? {};
  const raidW = cfg.raids ?? 40;
  const msgW = cfg.messages ?? 30;
  const xW = cfg.x_activity ?? 30;
  const referralW = Number.isFinite(cfg.referrals) ? Math.max(0, cfg.referrals) : 0;
  const quals = (contest.qualificationRules ?? contest.qualification_rules ?? []);
  const needsReferrals = referralW > 0 || quals.some((q) => q.type === 'min_referrals');

  // ── Pull activity signals in parallel (live stores) ──
  const [raidRows, msgRows, xRows, referralRows] = await Promise.all([
    db.all(sql`
      SELECT rc.user_id AS user_id, rc.username AS username, rc.display_name AS display_name, COUNT(*) AS cnt
      FROM raid_completions rc
      JOIN raid_sessions rs ON rs.id = rc.raid_id AND rs.chat_id = ${chatId}
      WHERE rc.completed_at >= ${startAt} AND rc.completed_at <= ${endAt}
      GROUP BY rc.user_id, rc.username, rc.display_name
    `).catch(() => []),
    db.all(sql`
      SELECT from_user_id AS user_id, MAX(from_name) AS display_name, COUNT(*) AS cnt
      FROM group_message_log
      WHERE chat_id = ${String(chatId)} AND from_user_id IS NOT NULL
        AND created_at >= ${startAt} AND created_at <= ${endAt}
      GROUP BY from_user_id
    `).catch(() => []),
    // X-linked raid activity: completions on X/Twitter raid sessions.
    db.all(sql`
      SELECT rc.user_id AS user_id, COUNT(*) AS cnt
      FROM raid_completions rc
      JOIN raid_sessions rs ON rs.id = rc.raid_id AND rs.chat_id = ${chatId}
      WHERE rs.platform = 'X / Twitter'
        AND rc.completed_at >= ${startAt} AND rc.completed_at <= ${endAt}
      GROUP BY rc.user_id
    `).catch(() => []),
    needsReferrals
      ? db.all(sql`
          SELECT referrer_telegram_id AS user_id, COUNT(*) AS cnt
          FROM referrals
          WHERE source_chat_id = ${chatId}
            AND attributed_at >= ${startAt} AND attributed_at <= ${endAt}
          GROUP BY referrer_telegram_id
        `).catch(() => [])
      : Promise.resolve([]),
  ]);

  // Build unified participant map (source logic).
  const users = new Map();
  for (const r of raidRows)
    users.set(String(r.user_id), { username: r.username ?? null, displayName: r.display_name ?? r.username ?? 'Unknown', raids: Number(r.cnt), messages: 0, xActivity: 0, referrals: 0 });
  for (const r of msgRows) {
    const ex = users.get(String(r.user_id));
    if (ex) { ex.messages = Number(r.cnt); if (ex.displayName === 'Unknown') ex.displayName = r.display_name ?? 'Unknown'; }
    else users.set(String(r.user_id), { username: null, displayName: r.display_name ?? 'Unknown', raids: 0, messages: Number(r.cnt), xActivity: 0, referrals: 0 });
  }
  for (const r of xRows) {
    const ex = users.get(String(r.user_id));
    if (ex) ex.xActivity = Number(r.cnt);
    else users.set(String(r.user_id), { username: null, displayName: 'Unknown', raids: 0, messages: 0, xActivity: Number(r.cnt), referrals: 0 });
  }
  for (const r of referralRows) {
    const ex = users.get(String(r.user_id));
    if (ex) ex.referrals = Number(r.cnt);
    else users.set(String(r.user_id), { username: null, displayName: 'Unknown', raids: 0, messages: 0, xActivity: 0, referrals: Number(r.cnt) });
  }

  if (users.size === 0) return [];

  // Enrich names from this chat's raid_xp rows (message-only participants
  // otherwise carry only their log display name; usernames live here).
  try {
    const xpRows = await db.select().from(raid_xp)
      .where(eq(raid_xp.chatId, chatId)).all();
    for (const xr of xpRows) {
      const ex = users.get(String(xr.userId));
      if (!ex) continue;
      ex.username ??= xr.username ?? null;
      if (ex.displayName === 'Unknown') ex.displayName = xr.displayName ?? xr.username ?? 'Unknown';
      ex._pbaiHolderFlag = Boolean(xr.pbaiHolder);
    }
  } catch { /* names are cosmetic — never fail scoring on them */ }

  // ── Enforce qualification rules — disqualify before ranking ──
  if (quals.length > 0) {
    const needsXVerified = quals.some((q) => q.type === 'x_verified');
    const needsWallet = quals.some((q) => q.type === 'wallet_linked');
    const needsHolder = quals.some((q) => q.type === 'pbai_holder');

    const xvSet = new Set();
    const wSet = new Set();
    const hSet = new Set();
    if (needsXVerified || needsWallet || needsHolder) {
      const ids = [...users.keys()];
      const [xvRows, wRows] = await Promise.all([
        needsXVerified
          ? db.select().from(twitter_handles)
              .where(inArray(twitter_handles.telegramUserId, ids)).all().catch(() => [])
          : Promise.resolve([]),
        needsWallet
          ? db.select().from(user_wallets)
              .where(inArray(user_wallets.telegramUserId, ids)).all().catch(() => [])
          : Promise.resolve([]),
      ]);
      for (const r of xvRows) if (r.xVerified === true) xvSet.add(String(r.telegramUserId));
      for (const r of wRows) if (r.baseAddress || r.solAddress) wSet.add(String(r.telegramUserId));
      if (needsHolder) {
        for (const [uid, u] of users) if (u._pbaiHolderFlag) hSet.add(uid);
        // On-chain fallback (lib/accounts.js holder check) for participants
        // whose raid_xp flag was never synced but who hold PBAI in their
        // linked Base wallet.
        for (const uid of ids) {
          if (hSet.has(uid)) continue;
          try {
            const w = await getUserWallets(uid);
            if (w?.baseAddress) {
              const chk = await checkPbai(w.baseAddress);
              if (chk.available && chk.balance > 0) hSet.add(uid);
            }
          } catch { /* RPC unavailable — flag result stands */ }
        }
      }
    }

    for (const [uid, u] of users) {
      let fail = false;
      for (const rule of quals) {
        if (rule.type === 'min_raids' && u.raids < rule.value) { fail = true; break; }
        if (rule.type === 'min_messages' && u.messages < rule.value) { fail = true; break; }
        if (rule.type === 'min_x_posts' && u.xActivity < rule.value) { fail = true; break; }
        if (rule.type === 'min_referrals' && u.referrals < rule.value) { fail = true; break; }
        if (rule.type === 'x_verified' && !xvSet.has(uid)) { fail = true; break; }
        if (rule.type === 'wallet_linked' && !wSet.has(uid)) { fail = true; break; }
        if (rule.type === 'pbai_holder' && !hSet.has(uid)) { fail = true; break; }
      }
      if (fail) users.delete(uid);
    }
  }

  if (users.size === 0) return [];

  // ── Normalize 0–100 and weight (source logic) ──
  const vals = [...users.values()];
  const maxR = Math.max(...vals.map((u) => u.raids), 1);
  const maxM = Math.max(...vals.map((u) => u.messages), 1);
  const maxX2 = Math.max(...vals.map((u) => u.xActivity), 1);
  const maxReferrals = Math.max(...vals.map((u) => u.referrals), 1);

  return [...users.entries()]
    .map(([userId, u]) => {
      const rScore = (u.raids / maxR) * 100;
      const mScore = (u.messages / maxM) * 100;
      const xScore = (u.xActivity / maxX2) * 100;
      const referralScore = (u.referrals / maxReferrals) * 100;
      const total = (rScore * raidW + mScore * msgW + xScore * xW + referralScore * referralW) / 100;
      return {
        userId, username: u.username, displayName: u.displayName,
        raids: u.raids, messages: u.messages, xActivity: u.xActivity, referrals: u.referrals,
        rScore, mScore, xScore, referralScore, totalScore: Math.round(total * 10) / 10,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, topN);
}

// ── Announcement (source: announceContestWinners, ported) ───────────────────

export async function announceContestWinners(chatId, contest, winners) {
  const cid = Number(chatId);
  const medals = ['🥇', '🥈', '🥉'];
  const xpMap = [contest.xpPrizes?.first ?? 500, contest.xpPrizes?.second ?? 300, contest.xpPrizes?.third ?? 150];
  const rankLabels = ['1st Place', '2nd Place', '3rd Place'];
  const cfg = contest.scoringConfig ?? {};

  if (winners.length === 0) {
    await api.sendMessage({
      chat_id: cid,
      text: `🏆 <b>${esc(contest.contestName)} — Results</b>\n\nNo qualified participants were found for this contest.`,
      parse_mode: 'HTML',
    }).catch(() => {});
    await db.update(contests).set({ winnerAnnounced: true, status: 'ended' })
      .where(eq(contests.id, contest.id)).run().catch(() => {});
    return { announced: true, winners: 0 };
  }

  let msg = `🏆 <b>${esc(contest.contestName)} — WINNERS!</b>\n\n`;
  if (contest.cashPrizeText) msg += `💰 <b>Prize:</b> ${esc(contest.cashPrizeText)}\n\n`;

  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const handle = w.username ? `@${w.username}` : esc(w.displayName);
    msg += `${medals[i]} <b>${rankLabels[i]}:</b> ${handle} — Score: <b>${w.totalScore}</b>\n`;
    msg += `   ⚔️ Raids: ${w.raids}  💬 Msgs: ${w.messages}  𝕏 Posts: ${w.xActivity}`;
    if ((cfg.referrals ?? 0) > 0) msg += `  🤝 Invites: ${w.referrals}`;
    msg += `\n\n`;
  }

  msg += scoringLine(cfg, true) + '\n';
  const quals = contest.qualificationRules ?? [];
  if (quals.length) msg += `\n✅ Qualifications: ${quals.map((q) => esc(q.description)).join(' · ')}\n`;
  msg += `<i>Congratulations to all qualified participants! 🎉</i>`;

  await api.sendMessage({ chat_id: cid, text: msg, parse_mode: 'HTML' }).catch(() => {});

  // Award XP prizes at the EXACT configured amounts (addXpRaw — no streak,
  // no multiplier) + DM each winner (source behaviour). XP only lands when
  // this community's XP policy is enabled — same gate as the source.
  const xpCommunity = await getXpCommunityPolicy(cid);
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const xpAward = xpMap[i] ?? 150;
    let awarded = false;
    if (xpCommunity.enabled) {
      const res = await addXpRaw(Number(w.userId), cid, w.username, w.displayName, xpAward).catch(() => null);
      awarded = Boolean(res) && res.newXP !== 0;
    }
    const handle = w.username ? `@${w.username}` : esc(w.displayName);
    const dmText =
      `🎉 <b>Congrats ${handle}!</b>\n\n` +
      `You finished <b>${rankLabels[i]}</b> in the <b>${esc(contest.contestName)}</b>!\n\n` +
      `${medals[i]} Score: <b>${w.totalScore}</b>\n` +
      `⚔️ Raids: ${w.raids}  💬 Msgs: ${w.messages}  𝕏 Posts: ${w.xActivity}` +
      ((cfg.referrals ?? 0) > 0 ? `  🤝 Invites: ${w.referrals}` : '') +
      `\n\n` +
      (awarded ? `✨ <b>+${xpAward} ${esc(xpCommunity.tokenLabel)} XP</b> added to your profile.\n` : '') +
      (contest.cashPrizeText ? `💰 Prize: ${esc(contest.cashPrizeText)}\n` : '') +
      `\nKeep grinding 💪`;
    await api.sendMessage({ chat_id: Number(w.userId), text: dmText, parse_mode: 'HTML' }).catch(() => {});
  }

  await db.update(contests).set({ winnerAnnounced: true, status: 'ended' })
    .where(eq(contests.id, contest.id)).run().catch(() => {});
  return { announced: true, winners: winners.length };
}

/** Calculate + announce for one contest (manual trigger + tick share this). */
export async function finaliseContest(chatId, contest) {
  const winners = await calculateContestWinners(contest);
  return announceContestWinners(chatId, contest, winners);
}

// ── Tick finaliser (source: 5-minute contest scheduler) ─────────────────────
// Appended LAST to CYCLES in lib/tick.js; failure-isolated like the others.

export async function cycleContests() {
  // NB: compare end_at against unix seconds, not a Date — the SDK rejects
  // Date objects as operator params ("unsupported value type: object").
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db.select().from(contests)
    .where(and(
      eq(contests.status, 'active'),
      eq(contests.winnerAnnounced, false),
      lte(contests.endAt, nowSec),
    ))
    .all().catch(() => []);
  let finalised = 0;
  for (const r of rows) {
    const contest = contestRow(r);
    try {
      await finaliseContest(contest.chatId, contest);
      finalised++;
    } catch (err) {
      console.error('[contests cycle]', err?.message ?? err);
    }
  }
  return { due: rows.length, finalised };
}

// ── /conteststatus (source port — hidden, non-menu, anyone) ─────────────────

/**
 * Contest status for ONE chat as data + text (shared by the command and
 * the skills layer). `text` is the command's HTML-mode string; the skills
 * layer strips the tags for its plain-text contract. Sealed to chatId.
 */
export async function contestStatusFor(chatId) {
  const cid = Number(chatId);
  try {
    const c = await getActiveContest(cid);
    if (!c) {
      return { ok: true, active: false, parseHtml: false, text: '📭 No active contest in this group right now.' };
    }
    const now = Math.floor(Date.now() / 1000);
    const cfg = c.scoringConfig;
    const isLive = now >= c.startAt && now < c.endAt;
    const hLeft = Math.max(0, Math.floor((c.endAt - now) / 3600));
    const mLeft = Math.max(0, Math.floor(((c.endAt - now) % 3600) / 60));

    let text = `🏆 <b>${esc(c.contestName)}</b>\n`;
    text += isLive ? `🟢 <b>LIVE</b> — ${hLeft}h ${mLeft}m remaining\n`
      : now < c.startAt ? `⏳ Starting soon\n` : `🏁 Ended — calculating results\n`;
    text += scoringLine(cfg) + '\n';
    if (c.cashPrizeText) text += `💰 Prize: ${esc(c.cashPrizeText)}\n`;
    const qualTxt = formatQualRules(c.qualificationRules);
    if (qualTxt) text += qualTxt + '\n';
    text += `\n<i>Winners announced automatically at the end.</i>`;
    return { ok: true, active: true, parseHtml: true, text };
  } catch {
    return { ok: false, active: false, parseHtml: false, text: '❌ Could not fetch contest status.' };
  }
}

export async function handleContestStatus(chatId) {
  const cid = Number(chatId);
  const out = await contestStatusFor(cid);
  if (out.parseHtml) {
    await api.sendMessage({ chat_id: cid, text: out.text, parse_mode: 'HTML' }).catch(() => {});
  } else {
    await api.sendMessage({ chat_id: cid, text: out.text }).catch(() => {});
  }
  return out.ok ? { ok: true, active: out.active } : { ok: false };
}

// ── /contestwinner (source port — hidden, non-menu; admin gate lives in the
//    caller, exactly like the source's inline check) ────────────────────────

export async function handleContestWinner(chatId) {
  const cid = Number(chatId);
  try {
    const contest = await getPendingContest(cid);
    if (!contest) {
      await api.sendMessage({ chat_id: cid, text: '📭 No contest pending winner announcement in this group.' }).catch(() => {});
      return { ok: true, pending: false };
    }
    await api.sendMessage({
      chat_id: cid,
      text: `⏳ Calculating winners for <b>${esc(contest.contestName)}</b>…`,
      parse_mode: 'HTML',
    }).catch(() => {});
    const res = await finaliseContest(cid, contest);
    return { ok: true, pending: true, ...res };
  } catch {
    await api.sendMessage({ chat_id: cid, text: '❌ Failed to calculate winners. Try again.' }).catch(() => {});
    return { ok: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// /contest wizard — v1 creation path (design §4). Button-driven like
// /raidsetup & /bizsetup; state lives in the config table keyed by
// chat+user (the isolates are stateless — the original's in-memory
// pendingContestSessions map cannot survive here). The final confirm step
// mirrors the original's contest_confirm gate: nothing is registered until
// the admin taps ✅ Register Contest on the review panel.
// ═══════════════════════════════════════════════════════════════════════════

const WIZ_TTL_MS = 15 * 60 * 1000;
const wizKey = (chatId, userId) => `contestwiz:${chatId}:${userId}`;

const WEIGHT_PRESETS = [
  ['balanced', '⚖️ Balanced 40/30/30', { raids: 40, messages: 30, x_activity: 30 }],
  ['raidheavy', '⚔️ Raid-heavy 60/20/20', { raids: 60, messages: 20, x_activity: 20 }],
  ['chatheavy', '💬 Chat-heavy 20/50/30', { raids: 20, messages: 50, x_activity: 30 }],
  ['xheavy', '𝕏 X-heavy 20/30/50', { raids: 20, messages: 30, x_activity: 50 }],
  ['invites', '🤝 +Invites 30/25/25/20', { raids: 30, messages: 25, x_activity: 25, referrals: 20 }],
];
const XP_PRESETS = [
  ['standard', '🏅 Standard 500/300/150', { first: 500, second: 300, third: 150 }],
  ['big', '💎 Big 1000/600/300', { first: 1000, second: 600, third: 300 }],
];
const DURATIONS = [
  [1, '24 hours'],
  [3, '3 days'],
  [7, '7 days'],
];
const QUAL_CYCLES = {
  min_raids: [0, 1, 3, 5, 10],
  min_messages: [0, 10, 20, 50, 100],
  min_x_posts: [0, 1, 3, 5],
  min_referrals: [0, 1, 2, 5],
};

function defaultDraft() {
  return {
    name: 'Community Contest',
    prizeText: null,
    durationDays: 1,
    weights: 'balanced',
    xp: 'standard',
    quals: { min_raids: 0, min_messages: 0, min_x_posts: 0, min_referrals: 0, x_verified: false, wallet_linked: false, pbai_holder: false },
    stage: 'edit', // edit | quals | confirm
    awaiting: null, // null | 'name' | 'prize'
    createdAt: Date.now(),
  };
}

function preset(list, key) {
  return list.find(([k]) => k === key) ?? list[0];
}

export function draftScoringConfig(draft) {
  return { ...preset(WEIGHT_PRESETS, draft.weights)[2] };
}
export function draftXpPrizes(draft) {
  return { ...preset(XP_PRESETS, draft.xp)[2] };
}

/** Draft qualifications → the original's QualRule[] shape + descriptions. */
export function draftQualRules(draft) {
  const q = draft.quals ?? {};
  const rules = [];
  if (q.min_raids > 0) rules.push({ type: 'min_raids', value: q.min_raids, description: `Must complete at least ${q.min_raids} raids` });
  if (q.min_messages > 0) rules.push({ type: 'min_messages', value: q.min_messages, description: `Must send at least ${q.min_messages} messages` });
  if (q.min_x_posts > 0) rules.push({ type: 'min_x_posts', value: q.min_x_posts, description: `Must post at least ${q.min_x_posts} X/Twitter posts` });
  if (q.min_referrals > 0) rules.push({ type: 'min_referrals', value: q.min_referrals, description: `Must invite at least ${q.min_referrals} members` });
  if (q.x_verified) rules.push({ type: 'x_verified', description: 'Must have verified X/Twitter account linked' });
  if (q.wallet_linked) rules.push({ type: 'wallet_linked', description: 'Must have wallet address linked' });
  if (q.pbai_holder) rules.push({ type: 'pbai_holder', description: 'Must hold PBAI tokens' });
  return rules;
}

async function loadDraft(chatId, userId) {
  try {
    const raw = await getConfig(wizKey(chatId, userId), null);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || Date.now() - (d.createdAt ?? 0) > WIZ_TTL_MS) return null;
    return d;
  } catch { return null; }
}

async function saveDraft(chatId, userId, draft) {
  await setConfig(wizKey(chatId, userId), JSON.stringify(draft)).catch(() => {});
}

async function clearDraft(chatId, userId) {
  // config has no delete helper; an expired timestamp retires the session.
  await setConfig(wizKey(chatId, userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

function summaryBlock(draft) {
  const cfg = draftScoringConfig(draft);
  const xp = draftXpPrizes(draft);
  const dur = DURATIONS.find(([d]) => d === draft.durationDays) ?? DURATIONS[0];
  const lines = [
    `🏆 <b>${esc(draft.name)}</b>`,
    `⏱ <b>Window:</b> starts when you confirm · runs ${dur[1]}`,
    draft.prizeText ? `💰 <b>Prize:</b> ${esc(draft.prizeText)}` : '💰 <b>Prize:</b> <i>XP only — no cash prize text</i>',
    scoringLine(cfg, true),
    `🏅 <b>XP prizes:</b> 🥇 ${xp.first} · 🥈 ${xp.second} · 🥉 ${xp.third}`,
  ];
  const quals = draftQualRules(draft);
  lines.push(quals.length
    ? `✅ <b>Qualifications:</b> ${quals.map((q) => esc(q.description)).join(' · ')}`
    : '✅ <b>Qualifications:</b> <i>none — everyone competes</i>');
  return lines.join('\n');
}

function wizardPanel(draft) {
  const cfgLabel = preset(WEIGHT_PRESETS, draft.weights)[1];
  const xpLabel = preset(XP_PRESETS, draft.xp)[1];
  const durLabel = (DURATIONS.find(([d]) => d === draft.durationDays) ?? DURATIONS[0])[1];
  if (draft.stage === 'quals') {
    const q = draft.quals;
    const cyc = (key, label) => ({ text: `${label}: ${q[key] > 0 ? q[key] : 'off'}`, callback_data: `contest:q:${key}` });
    const tog = (key, label) => ({ text: `${q[key] ? '✅' : '⬜'} ${label}`, callback_data: `contest:q:${key}` });
    return {
      text: `🏆 <b>Contest Setup — Qualifications</b>\n\nTap to cycle a minimum or toggle a requirement. Rules are enforced <b>before</b> ranking — a top scorer who fails one does not win.\n\n${summaryBlock(draft)}`,
      reply_markup: { inline_keyboard: [
        [cyc('min_raids', '⚔️ Min raids'), cyc('min_messages', '💬 Min messages')],
        [cyc('min_x_posts', '𝕏 Min X posts'), cyc('min_referrals', '🤝 Min invites')],
        [tog('x_verified', 'X verified')],
        [tog('wallet_linked', 'Wallet linked'), tog('pbai_holder', 'PBAI holder')],
        [{ text: '⬅️ Back', callback_data: 'contest:back' }],
      ]},
    };
  }
  if (draft.stage === 'confirm') {
    const nowSec = Math.floor(Date.now() / 1000);
    const endSec = nowSec + draft.durationDays * 86400;
    return {
      text: `🏆 <b>Register this contest?</b>\n\n${summaryBlock(draft)}\n📅 Starts: ${fmtUtc(nowSec)}\n🏁 Ends: ${fmtUtc(endSec)}\n\nShould I register this and auto-announce the top 3 winners?`,
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Register Contest', callback_data: 'contest:confirm' }],
        [{ text: '⬅️ Back', callback_data: 'contest:back' }, { text: '❌ Cancel', callback_data: 'contest:cancel' }],
      ]},
    };
  }
  let prompt = '';
  if (draft.awaiting === 'name') prompt = '\n\n✏️ <i>Send the contest name as your next message here.</i>';
  if (draft.awaiting === 'prize') prompt = '\n\n💰 <i>Send the prize text as your next message here (e.g. "100 USDT to the winner"), or tap Prize again to leave it XP-only. PB announces this text only — it never pays cash out.</i>';
  return {
    text: `🏆 <b>Contest Setup</b>\n\n${summaryBlock(draft)}${prompt}`,
    reply_markup: { inline_keyboard: [
      [{ text: '✏️ Name', callback_data: 'contest:name' }, { text: '💰 Prize text', callback_data: 'contest:prize' }],
      [{ text: `⏱ Window: ${durLabel}`, callback_data: 'contest:dur' }],
      [{ text: `📊 Scoring: ${cfgLabel}`, callback_data: 'contest:weights' }],
      [{ text: `🏅 XP: ${xpLabel}`, callback_data: 'contest:xp' }],
      [{ text: '✅ Qualifications ▸', callback_data: 'contest:quals' }],
      [{ text: '🚀 Review & Register', callback_data: 'contest:review' }],
      [{ text: '❌ Cancel', callback_data: 'contest:cancel' }],
    ]},
  };
}

async function showPanel(chatId, userId, draft, messageId = null) {
  const panel = wizardPanel(draft);
  if (messageId) {
    const ok = await api.editMessageText({
      chat_id: Number(chatId), message_id: Number(messageId),
      text: panel.text, parse_mode: 'HTML', reply_markup: panel.reply_markup,
    }).then(() => true).catch(() => false);
    if (ok) return;
  }
  await api.sendMessage({
    chat_id: Number(chatId), text: panel.text, parse_mode: 'HTML', reply_markup: panel.reply_markup,
  }).catch(() => {});
}

/** /contest entry point (admin gate lives in the caller). */
export async function startContestWizard(chatId, user) {
  const draft = defaultDraft();
  await saveDraft(chatId, user.id, draft);
  const existing = await getActiveContest(chatId).catch(() => null);
  if (existing) {
    await api.sendMessage({
      chat_id: Number(chatId),
      text: `⚠️ An active contest already exists here (<b>${esc(existing.contestName)}</b>). You can still create another — /conteststatus shows the newest.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  await showPanel(chatId, user.id, draft);
  return { ok: true };
}

/** Text-step capture: returns true when the message was consumed. */
export async function handleContestWizardText(chatId, user, text) {
  if (!user?.id || !text || text.startsWith('/')) return false;
  const draft = await loadDraft(chatId, user.id);
  if (!draft || !draft.awaiting) return false;
  const value = String(text).trim().slice(0, 200);
  if (!value) return false;
  if (draft.awaiting === 'name') draft.name = value;
  if (draft.awaiting === 'prize') draft.prizeText = value;
  draft.awaiting = null;
  await saveDraft(chatId, user.id, draft);
  await showPanel(chatId, user.id, draft);
  return true;
}

function cycleNext(list, cur) {
  const i = list.indexOf(cur);
  return list[(i + 1) % list.length];
}

/** Button router for `contest:*` callbacks. Caller answers the query. */
export async function handleContestCallback({ chatId, userId, data, messageId }) {
  const sub = data.slice('contest:'.length);
  const draft = await loadDraft(chatId, userId);
  if (!draft) return { text: '⏳ Setup expired — run /contest again.', alert: true };
  // Only the admin who started the wizard can drive it (draft is keyed by
  // their user id — another admin tapping gets the expired notice above).

  if (sub === 'cancel') {
    await clearDraft(chatId, userId);
    await api.editMessageText({
      chat_id: Number(chatId), message_id: Number(messageId),
      text: '❌ Contest setup cancelled.',
    }).catch(() => {});
    return { text: 'Cancelled' };
  }
  if (sub === 'name') { draft.awaiting = draft.awaiting === 'name' ? null : 'name'; }
  else if (sub === 'prize') { draft.awaiting = draft.awaiting === 'prize' ? null : 'prize'; }
  else if (sub === 'dur') { draft.durationDays = cycleNext(DURATIONS.map(([d]) => d), draft.durationDays); draft.awaiting = null; }
  else if (sub === 'weights') { draft.weights = cycleNext(WEIGHT_PRESETS.map(([k]) => k), draft.weights); draft.awaiting = null; }
  else if (sub === 'xp') { draft.xp = cycleNext(XP_PRESETS.map(([k]) => k), draft.xp); draft.awaiting = null; }
  else if (sub === 'quals') { draft.stage = 'quals'; draft.awaiting = null; }
  else if (sub === 'review') { draft.stage = 'confirm'; draft.awaiting = null; }
  else if (sub === 'back') { draft.stage = 'edit'; draft.awaiting = null; }
  else if (sub.startsWith('q:')) {
    const key = sub.slice(2);
    if (QUAL_CYCLES[key]) draft.quals[key] = cycleNext(QUAL_CYCLES[key], draft.quals[key] ?? 0);
    else if (key in draft.quals) draft.quals[key] = !draft.quals[key];
  } else if (sub === 'confirm') {
    if (draft.stage !== 'confirm') return { text: 'Review the contest first.', alert: true };
    const nowSec = Math.floor(Date.now() / 1000);
    const contest = await createContest({
      chatId,
      createdBy: userId,
      contestName: draft.name,
      rulesRaw: null,
      startAt: nowSec,
      endAt: nowSec + draft.durationDays * 86400,
      scoringConfig: draftScoringConfig(draft),
      cashPrizeText: draft.prizeText,
      xpPrizes: draftXpPrizes(draft),
      qualificationRules: draftQualRules(draft),
    });
    await clearDraft(chatId, userId);
    const cfg = contest.scoringConfig;
    await api.editMessageText({
      chat_id: Number(chatId), message_id: Number(messageId), parse_mode: 'HTML',
      text:
        `✅ <b>Contest Registered!</b>\n\n` +
        `🏆 <b>${esc(contest.contestName)}</b>\n` +
        `🏁 Winners announced: <b>${fmtUtc(contest.endAt)}</b>\n` +
        `${scoringLine(cfg)}\n` +
        (contest.cashPrizeText ? `💰 Prize: ${esc(contest.cashPrizeText)}\n` : '') +
        formatQualRules(contest.qualificationRules) +
        `\n\n<i>PB is watching all activity. Top 3 qualified participants announced automatically.</i>`,
    }).catch(() => {});
    return { text: '🏆 Contest registered!' };
  } else {
    return { text: undefined };
  }
  await saveDraft(chatId, userId, draft);
  await showPanel(chatId, userId, draft, messageId);
  return { text: undefined };
}
