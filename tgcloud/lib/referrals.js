// lib/referrals.js — the Referral / invite program engine.
// Restores the mechanics from telegram-community-bot.ts (recordReferral
// ~4149, getReferralStats/getReferralLeaderboard/buildLeaderboardText +
// /invite ~7901, getOrCreateGroupInviteLink ~7783, chat_member attribution
// ~25247, /start ref_ handling ~7618) onto tgcloud idioms:
//
// - The SDK exposes no multi-statement transactions, so the atomic gate is
//   the table's UNIQUE(referred_telegram_id) + ON CONFLICT DO NOTHING +
//   RETURNING — first-touch-wins is enforced by the constraint itself, and
//   XP awards fire only when the insert actually landed (matching the source
//   flow, which awarded XP inside the same transaction only after a real
//   insert).
// - Referral XP uses addXpRaw (no streak, no holder multiplier — the source's
//   explicit rule: referral XP "must not create or advance a raid streak").
// - Messages are plain text (v1 convention — no MarkdownV2 escaping layer).

import { api } from 'sdk';
import db, { eq, sql } from 'sdk/db';
import {
  referrals, community_invite_links, bot_users, known_groups, group_settings,
} from '../schema.js';
import { addXpRaw, REFERRER_XP_REWARD, REFERRED_XP_REWARD } from './xp.js';
import { getConfig } from './config.js';

export const REFERRAL_SOURCES = ['bot', 'x', 'telegram_group', 'telegram_message'];
export { REFERRER_XP_REWARD, REFERRED_XP_REWARD };

// ── Bot username (for t.me deep links) ──────────────────────────────────────
let _botUsername = null;
export async function botUsername() {
  if (_botUsername) return _botUsername;
  try {
    const me = await api.getMe();
    if (me?.username) _botUsername = me.username;
  } catch { /* fall through */ }
  _botUsername = _botUsername ?? 'PoorBoyAI_bot';
  return _botUsername;
}

export function botInviteLink(userId, fromX = false) {
  return `https://t.me/PoorBoyAI_bot?start=ref_${userId}${fromX ? '_x' : ''}`;
}

async function homeChatId() {
  return (await getConfig('TELEGRAM_HOME_CHAT_ID')) ?? null;
}

// ── Core: record a referral + both XP awards ────────────────────────────────
// Returns true only when the referral was actually recorded (first touch).
// chatId is the chat whose raid_xp ledger receives the awards: the home chat
// for bot/x /start referrals, the joined group for telegram_group ones.
// Mirrors the source: XP is additive to the shared raid_xp balance but skips
// any streak/multiplier accounting via addXpRaw.
export async function recordReferral({
  referrerId, referredId, source,
  chatId = null, messageId = null,
  referrerUsername = null, referredUsername = null, evidenceText = null,
}) {
  if (!Number.isSafeInteger(referrerId) || !Number.isSafeInteger(referredId)) return false;
  if (referrerId === referredId) return false;
  if (!REFERRAL_SOURCES.includes(source)) return false;

  let inserted;
  try {
    inserted = await db.insert(referrals).values({
      referrerTelegramId: referrerId,
      referredTelegramId: referredId,
      source,
      referrerUsername: referrerUsername ?? null,
      referredUsername: referredUsername ?? null,
      sourceChatId: chatId,
      sourceMessageId: messageId,
      evidenceText: evidenceText ? String(evidenceText).slice(0, 500) : null,
      attributedAt: new Date(),
    }).onConflictDoNothing().returning().run();
  } catch (err) {
    console.error('[recordReferral] insert failed:', err?.message ?? err);
    return false;
  }
  if (!inserted?.length) return false; // first-touch-wins: already credited

  if (chatId !== null && chatId !== undefined) {
    try {
      await addXpRaw(referrerId, Number(chatId), referrerUsername, null, REFERRER_XP_REWARD);
    } catch (err) { console.error('[recordReferral] referrer XP failed:', err?.message ?? err); }
    try {
      await addXpRaw(referredId, Number(chatId), referredUsername, null, REFERRED_XP_REWARD);
    } catch (err) { console.error('[recordReferral] referred XP failed:', err?.message ?? err); }
  }
  return true;
}

// ── Per-referrer stats (bot/x/telegram channels) ────────────────────────────
export async function getReferralStats(userId) {
  const rows = await db.all(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${referrals.source} = 'bot' THEN 1 ELSE 0 END) AS bot_total,
      SUM(CASE WHEN ${referrals.source} = 'x' THEN 1 ELSE 0 END) AS x_total,
      SUM(CASE WHEN ${referrals.source} IN ('telegram_group','telegram_message') THEN 1 ELSE 0 END) AS tg_total
    FROM referrals WHERE ${referrals.referrerTelegramId} = ${Number(userId)}
  `).catch(() => []);
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    botTotal: Number(r.bot_total ?? 0),
    xTotal: Number(r.x_total ?? 0),
    tgTotal: Number(r.tg_total ?? 0),
  };
}

// ── Per-channel counts a referrer earned INSIDE one chat (group board view) ──
export async function getReferralStatsInChat(userId, chatId) {
  const rows = await db.all(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${referrals.source} = 'bot' THEN 1 ELSE 0 END) AS bot_total,
      SUM(CASE WHEN ${referrals.source} = 'x' THEN 1 ELSE 0 END) AS x_total,
      SUM(CASE WHEN ${referrals.source} IN ('telegram_group','telegram_message') THEN 1 ELSE 0 END) AS tg_total
    FROM referrals
    WHERE ${referrals.referrerTelegramId} = ${Number(userId)}
      AND ${referrals.sourceChatId} = ${Number(chatId)}
  `).catch(() => []);
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    botTotal: Number(r.bot_total ?? 0),
    xTotal: Number(r.x_total ?? 0),
    tgTotal: Number(r.tg_total ?? 0),
  };
}

// ── Leaderboard (Top N referrers with username + per-channel breakdown) ──────
// Scope: a single chat when chatId is given (that group's board — the group
// sealing rule), or the opted-in global set when chatId is null (consistent
// with the Mini App's global board convention in endpoints/getGlobalBoard.js:
// only communities with settings.globalBoard = true). In DM with nothing
// opted in, pass chatId = 'NONE' to render no board.
export async function getReferralLeaderboard(limit = 10, chatId = null) {
  let inScope;
  if (chatId === 'NONE') {
    inScope = sql`0 = 1`;
  } else if (chatId !== null && chatId !== undefined) {
    inScope = sql`${referrals.sourceChatId} = ${Number(chatId)}`;
  } else {
    // Global opt-in set, read the same way getGlobalBoard.js reads it.
    const rows = await db.select().from(group_settings).all().catch(() => []);
    const optedIn = rows
      .filter((r) => r?.settings?.globalBoard === true)
      .map((r) => Number(r.chatId))
      .filter(Number.isSafeInteger);
    inScope = optedIn.length
      ? sql`(${optedIn
          .map((n) => sql`${referrals.sourceChatId} = ${n}`)
          .reduce((acc, cond) => sql`${acc} OR ${cond}`)})`
      : sql`0 = 1`;
  }
  const rows = await db.all(sql`
    SELECT
      ${referrals.referrerTelegramId} AS referrerId,
      bu.username AS username,
      bu.first_name AS firstName,
      COUNT(*) AS total,
      SUM(CASE WHEN ${referrals.source} = 'bot' THEN 1 ELSE 0 END) AS bot_total,
      SUM(CASE WHEN ${referrals.source} = 'x' THEN 1 ELSE 0 END) AS x_total,
      SUM(CASE WHEN ${referrals.source} IN ('telegram_group','telegram_message') THEN 1 ELSE 0 END) AS tg_total
    FROM referrals
    LEFT JOIN bot_users bu
      ON CAST(bu.telegram_user_id AS INTEGER) = ${referrals.referrerTelegramId}
    WHERE ${inScope}
    GROUP BY ${referrals.referrerTelegramId}, bu.username, bu.first_name
    ORDER BY total DESC, ${referrals.referrerTelegramId} ASC
    LIMIT ${Number(limit) ?? 10}
  `).catch(() => []);
  return rows.map((r, i) => ({
    referrerId: r.referrerId,
    username: r.username ?? null,
    firstName: r.firstName ?? null,
    total: Number(r.total ?? 0),
    botTotal: Number(r.bot_total ?? 0),
    xTotal: Number(r.x_total ?? 0),
    tgTotal: Number(r.tg_total ?? 0),
    rank: i + 1,
  }));
}

// ── A user's rank on a given leaderboard scope ──────────────────────────────
export async function getReferralRank(userId, chatId = null) {
  const board = await getReferralLeaderboard(10000, chatId);
  const entry = board.find((b) => String(b.referrerId) === String(userId));
  return entry ? entry.rank : null;
}

// ── Leaderboard text block (source: buildLeaderboardText, plain-text v1) ─────
export function buildReferralLeaderboardText(boardRows, userId, myTotal, myRank, boardLabel) {
  if (!boardRows.length) return '';
  const MEDAL = ['🥇', '🥈', '🥉', '🏅', '🏅', '🏅', '🏅', '🏅', '🏅', '🏅'];
  const top = boardRows.slice(0, 10);
  let text = `\n\n🏆 Referral Leaderboard (Top ${top.length})${boardLabel ? ` — ${boardLabel}` : ''}:\n`;
  top.forEach((r, i) => {
    const isMe = String(r.referrerId) === String(userId);
    const label = isMe ? '*You* 👈'
      : r.username ? `@${r.username}`
        : r.firstName ? r.firstName
          : `ID ${r.referrerId}`;
    const breakdown = [
      r.botTotal > 0 ? `🤖${r.botTotal}` : '',
      r.xTotal > 0 ? `𝕏${r.xTotal}` : '',
      r.tgTotal > 0 ? `💬${r.tgTotal}` : '',
    ].filter(Boolean).join(' ');
    text += `${MEDAL[i] ?? `#${i + 1}`} ${label} — *${r.total}* (${breakdown || '0'}) +${r.total * 3} cmds\n`;
  });
  if (myRank && myRank > 10) {
    text += `...\n#${myRank} *You* — *${myTotal}* total (+${myTotal * 3} cmds)\n`;
  }
  return text;
}

// ── Per-user Telegram group invite links (source: getOrCreateGroupInviteLink) ─
// Issues (or reuses) a personal invite link for the user in the given group.
// The bot must be an admin with can_invite_users; links are named ref_<id>
// so joins stay attributable. Returns '' when unavailable.
export async function getOrCreateGroupInviteLink(userId, chatId) {
  if (!chatId) return '';
  try {
    const existing = await db.select().from(community_invite_links)
      .where(sql`${community_invite_links.referrerTelegramId} = ${Number(userId)}
             AND ${community_invite_links.chatId} = ${Number(chatId)}`)
      .get();
    if (existing?.inviteLink) return existing.inviteLink;
  } catch { /* fall through to create */ }
  try {
    const created = await api.createChatInviteLink({
      chat_id: Number(chatId),
      name: `ref_${userId}`,
      creates_join_request: false,
    });
    if (created?.invite_link) {
      await db.insert(community_invite_links).values({
        referrerTelegramId: Number(userId),
        chatId: Number(chatId),
        inviteLink: created.invite_link,
        createdAt: new Date(),
      }).onConflictDoNothing().run().catch(() => {});
      return created.invite_link;
    }
  } catch (err) {
    console.error('[getOrCreateGroupInviteLink]', err?.code ?? err?.message ?? err);
  }
  return '';
}

// ── Referrer DM on a new referral (source: the "New referral via …" DMs) ─────
// Shows running totals. Only fired for real inserts (first touch).
export async function notifyReferrer(referrerId, channelLabel, joinerHandle, joinerUsername = null) {
  try {
    const stats = await getReferralStats(referrerId);
    const bonus = stats.total * 3;
    await api.sendMessage({
      chat_id: Number(referrerId),
      text: [
        `🎉 New referral via ${channelLabel}!`,
        '',
        `${joinerHandle} just joined through your invite!`,
        '',
        `⚡ Referral XP: +${REFERRER_XP_REWARD} XP for you · +${REFERRED_XP_REWARD} XP for them`,
        '📊 Your totals:',
        `🤖 Bot: ${stats.botTotal} · 𝕏 X: ${stats.xTotal} · 💬 Telegram: ${stats.tgTotal}`,
        `⚡ Bonus commands: ${bonus}`,
        '',
        'Keep sharing to earn more rewards!',
      ].join('\n'),
      reply_markup: { inline_keyboard: [[
        { text: '📊 See My Stats', callback_data: 'menu:invite' },
      ]]},
    }).catch(() => {});
  } catch (err) {
    console.error('[notifyReferrer]', err?.message ?? err);
  }
}

// ── /start ref_ payload handler (source: /start deep-link block ~7618) ───────
// payload: "ref_<id>" (source bot) or "ref_<id>_x" (source x). Records the
// referral against the HOME chat (as the source did with TELEGRAM_CHAT_ID),
// so bot/x referral XP credits the home community ledger. Returns true when
// it handled the payload (caller should still run the normal /start welcome).
export async function handleStartReferral(userId, payload, from) {
  if (!payload || !payload.startsWith('ref_')) return false;
  const rawRef = payload.slice(4); // e.g. "8429146850" or "8429146850_x"
  const isXSource = rawRef.endsWith('_x');
  const referrerId = parseInt(isXSource ? rawRef.slice(0, -2) : rawRef, 10);
  if (!Number.isSafeInteger(referrerId) || referrerId === userId) return false;

  const refSource = isXSource ? 'x' : 'bot';
  const homeId = await homeChatId();
  const referredUsername = from?.username ?? null;

  const inserted = await recordReferral({
    referrerId,
    referredId: userId,
    source: refSource,
    chatId: homeId ? Number(homeId) : null,
    referrerUsername: null,
    referredUsername,
  }).catch((err) => {
    console.error(`[handleStartReferral] ${refSource} attribution failed:`, err?.message ?? err);
    return false;
  });

  if (!inserted) {
    console.log(`[handleStartReferral] ${userId} already has a referrer; skipped duplicate ${refSource} credit`);
    return true;
  }
  console.log(`[handleStartReferral] ${userId} referred by ${referrerId} via ${refSource}`);
  const joinerHandle = from?.username ? `@${from.username}` : (from?.first_name ?? 'A new member');
  const srcLabel = isXSource ? 'your 𝕏 post' : 'your bot invite link';
  await notifyReferrer(referrerId, srcLabel, joinerHandle, referredUsername);
  return true;
}

// ── Shared /invite panel builder ─────────────────────────────────────────────
// scopeChatId: a group chat id → that group's board; null → DM view (own stats
// + opt-in global board); the panel never surfaces another group's data.
export async function buildInvitePanel(userId, scopeChatId, from) {
  const isGroup = scopeChatId !== null && scopeChatId !== undefined;
  const stats = isGroup
    ? await getReferralStatsInChat(userId, scopeChatId)
    : await getReferralStats(userId);
  const { total, botTotal, xTotal, tgTotal } = stats;
  const bonusEarned = total * 3;

  // Group invite link: for THIS group when in one; the home group in DM.
  const linkChat = isGroup ? scopeChatId : (await homeChatId());
  const groupInviteLink = await getOrCreateGroupInviteLink(userId, linkChat);

  // Leaderboard scope: this group, or the opt-in global set in DM.
  const boardScope = isGroup ? scopeChatId : null;
  const boardRows = await getReferralLeaderboard(10, boardScope);
  let myRank = null;
  const myEntry = boardRows.find((r) => String(r.referrerId) === String(userId));
  if (myEntry) myRank = myEntry.rank;
  else if (total > 0) myRank = await getReferralRank(userId, boardScope);

  let boardLabel = null;
  if (isGroup) {
    try {
      const g = await db.select().from(known_groups)
        .where(eq(known_groups.chatId, String(scopeChatId))).get();
      boardLabel = g?.title ?? null;
    } catch { /* label optional */ }
  } else if (boardRows.length) {
    boardLabel = 'Opt-in communities';
  }
  const boardText = buildReferralLeaderboardText(boardRows, userId, total, myRank, boardLabel);

  const botLink = botInviteLink(userId);
  const xLink = botInviteLink(userId, true);
  const rankBadge = myRank ? ` · Ref Rank #${myRank}` : '';
  const lines = [
    '⭐ Referral Program',
    '',
    'Invite friends across every platform — you both win!',
    '',
    `🎁 Your friend gets +${REFERRED_XP_REWARD} XP and +5 free AI commands`,
    `💎 You earn +${REFERRER_XP_REWARD} XP and +3 bonus AI commands per referral`,
    '',
    `📊 Your stats:${isGroup ? ` in this community${rankBadge}` : rankBadge}`,
    `🤖 Bot: ${botTotal} · 𝕏 X: ${xTotal} · 💬 Telegram: ${tgTotal}`,
    `📦 Referrals: ${total} · Bonus: +${bonusEarned} cmds`,
    '',
    '🔗 Your bot invite link:',
    botLink,
    '',
    '𝕏 Your X invite link (tracked):',
    xLink,
  ];
  if (groupInviteLink) {
    lines.push('', '💬 Your Telegram group invite:', groupInviteLink);
  }
  lines.push(boardText);
  if (!isGroup && !boardRows.length) {
    lines.push('\n📊 The Top 10 board lives in each community — run /invite in a group to see its board.');
  }

  const keyboard = [
    [{ text: '🤖 Share Bot Invite', url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent('Join @PoorBoyAI_bot — AI chat, raids & more! Get +5 free AI commands when you start 🚀')}` }],
    [{ text: '🐦 Share on X (tracked)', url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(`🚀 Join me on @PoorBoyAI_bot — AI chat, price alerts & more!\n\nGet +5 FREE commands 👇\n${xLink}`)}` }],
  ];
  if (groupInviteLink) {
    keyboard.push([{ text: '💬 Invite to Telegram Community', url: `https://t.me/share/url?url=${encodeURIComponent(groupInviteLink)}&text=${encodeURIComponent('Join the PoorBoyAI community on Telegram! 💎')}` }]);
  } else {
    keyboard.push([{ text: '💬 Telegram Community', url: 'https://t.me/poorboyai' }]);
  }
  keyboard.push([{ text: '◀️ Back to Menu', callback_data: 'menu:back' }]);
  return { text: lines.join('\n'), keyboard };
}


// ── /invite command (folded from lib/invitecmds.js, 2026-10-21) ───────────
// [relay-fold] The platform caps modules per app; invitecmds.js was a
// 36-line wrapper whose only dependency was this file's
// buildInvitePanel, so the command map lives here now. Behavior
// unchanged (PB-FORGOTTEN-FEATURES-DESIGNS.md §5): in a group, the
// panel answers IN that group with that group's sealed Top 10 + the
// caller's stats + their personal links; in DM, personal links for all
// three channels + per-channel counts + rank + the opted-in global
// board. /invite stays a non-menu command.

async function sendInviteSafe(chatId, text, extra = {}) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });
  } catch (err) {
    if (err?.code !== 403) console.error('[/invite send]', err?.code, err?.description ?? err?.message);
  }
}

export const INVITE_COMMANDS = {
  invite: async (chatId, _args, msg) => {
    if (msg.from?.is_bot || !msg.from?.id) return;
    const isGroup = msg.chat?.type !== 'private';
    const scopeChatId = isGroup ? Number(chatId) : null;
    const { text, keyboard } = await buildInvitePanel(msg.from.id, scopeChatId, msg.from);
    await sendInviteSafe(chatId, text, { reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true });
  },
};
