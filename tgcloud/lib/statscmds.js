// lib/statscmds.js — points / stats / info command family.
// Ported from telegram-community-bot.ts:
//   /points     (22468), /pointsrank (22534), /groupstats (22567),
//   /stats      (27061), /whitepaper  (8083),  /moonit     (13137).
//
// PORT NOTES:
// - The original /points read a member_points table that does NOT exist in
//   the cloud schema; the live equivalents are raid_xp (per user per chat)
//   and bot_users (tier). /points therefore reports the caller's XP summary.
//   The original's admin give/take branch (/points @user +N, admin + Hustler+)
//   is NOT ported: there is no points store to write to, and writing admin
//   points into raid_xp would corrupt the raid XP ledger.
// - Tier gates follow the originals (Hustler+ == canonical Builder+),
//   resolved through lib/tiers.js canonicalTier + lib/posts.js effectiveTier
//   (owner -> whale -> agency, so the owner always passes).
// - /stats is owner-gated in this port (task spec). NOTE: the original
//   /stats handler was public — if that was intended, drop the gate below.
// - SEALING: /pointsrank and /groupstats only ever read rows for the chat
//   the command ran in. The private-chat /pointsrank shows the caller only
//   their own global rank number — never other groups' names or numbers.

import { api, fetch } from 'sdk';
import db, { eq, desc, sql, and, inArray } from 'sdk/db';
import {
  bot_users, raid_xp, known_groups, raid_sessions,
  price_alerts, whale_watch_wallets, pb_feedback, sales, pb_leads, user_wallets,
  airdrop_campaigns, boost_campaigns,
} from '../schema.js';
import {
  isOwnerId, ownerIdSet, isChatAdmin, getGroupSettings, setGroupSettings,
  resetAutoVisionCooldown, cleanupNoteSent,
} from './groups.js';
import { getConfig, setConfig } from './config.js';
import {
  elonMissionState, startElonMission, stopElonMission, postElonBaitNow,
} from './groupmsg.js';
import { effectiveTier } from './posts.js';
import { canonicalTier, tierAtLeast } from './tiers.js';
import { getPBRank } from './xp.js';
import {
  createAirdropCampaign, campaignFeeSettled, checkAirdropDeposit,
  airdropFeePayAddress, airdropFeePayLines, validateWalletInput,
  getAirdropUserTier,
} from './airdrop.js';
import {
  createBoostCampaign, acceptBoostQuote, checkBoostDeposit,
  getUserTier, validateContractInput, BUMP_PACKAGES,
} from './boost.js';
import { sendSalesReceipt, isAirdropChainEnabled } from './moneyguard.js';
import { sha256Hex } from './mcpkeys.js';
import { isValidEvmAddress, isValidSolAddress, normalizeEvmAddress } from './walletvault.js';
import { askBrain } from './brain.js';
import {
  SITE_TEMPLATES, SITE_ACCENTS, validateSlug, isValidHttpsUrl, isValidContract,
  verifyContractLive, buildSiteBundle, createSite, saveSiteFiles,
  getOwnedSite, getSiteBySlug, listOwnedSites, setSiteStatus, escHtml,
} from './miniapp.js';

const sendSafe = async (chatId, text, extra = {}) => {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22).
  if (sent) await cleanupNoteSent(chatId, sent);
  return sent;
};

const BUILDER_PLUS = ['builder', 'pro', 'agency'];

/** Caller's canonical tier (bot_users row -> effectiveTier -> canonical). */
async function callerTier(userId) {
  let row = null;
  try {
    row = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(userId))).get();
  } catch { row = null; }
  try {
    return canonicalTier(await effectiveTier(userId, row));
  } catch {
    return 'free';
  }
}

async function ownerOk(userId) {
  try { return !!userId && (await isOwnerId(userId)); } catch { return false; }
}

// ── /whitepaper parts ────────────────────────────────────────────────────────
// The original's text (telegram-community-bot.ts:8083), template values
// resolved from sourced facts only: 100 Telegram commands, the $PBAI Base
// CA, and the live whitepaper URL. Tier USD prices and the Discord command
// count were template variables in the source and are NOT stated here rather
// than invented.
const WHITEPAPER_URL = 'https://poorboyai.pages.dev/whitepaper';

const WHITEPAPER_PARTS = [
  `📄 PoorBoyAI White Paper — Version 3.1 (Q2 2026)
"AI for the PoorBoy — Power for Everyone."

📖 Full whitepaper: ${WHITEPAPER_URL}

━━━━━━━━━━━━━━━━━━━━
🧠 EXECUTIVE SUMMARY

PoorBoyAI ($PBAI) is a bootstrapped AI infrastructure project — no presale, no team allocation. 100 Telegram commands, registered Discord slash commands, a SaaS dashboard, an AI-verified launchpad (Q4 2026), a Community Workers Programme, and the PoorBoy Callz discovery channel.

8 exclusive features nowhere else: auto-translate (16 langs), FUD Shield, live sentiment, AI debate mode, event countdowns, price milestones, auto-CA scanner, and PoorBoy Callz auto-callout.

Launched fairly on Ape.Store (Base chain) — transparent, rug-proof, community-owned.

━━━━━━━━━━━━━━━━━━━━
⚠️ THE PROBLEM

• Marketing Inequality — New projects can't afford professional marketing.
• Bot Fragmentation — No unified Telegram + Discord + Twitter dashboard exists.
• Community Management Gap — No bot combines moderation, AI content, translation, sentiment, and raids.
• Launchpad Risks — No AI-native screening layer before projects go live.
• No Discovery Engine — New projects launch with zero visibility.

━━━━━━━━━━━━━━━━━━━━
✅ THE SOLUTION — 5 PILLARS

1. Telegram Bot — @PoorBoyAI_bot · 100 commands
2. Discord Bot — PoorBoyAI#3575 · registered slash commands
3. Dashboard — https://t.me/PoorBoyAI_bot · member dashboard (Mini App)
4. Launchpad — AI-verified token launch (Q4 2026)
5. Community Portal — poorboyai.pages.dev/marketplace

━━━━━━━━━━━━━━━━━━━━
🌐 EXCLUSIVE SUPER BOT FEATURES

🌐 Auto-Translate — 16 languages, flag emojis, 5s cooldown. /translate on [lang]
🛡️ FUD Shield — Detects coordinated FUD, Gemini confirms, AI counter-FUD fires. /fudshield on
📊 Community Sentiment — 100-msg analysis, heat score 0–100, hourly auto-posts. /sentiment
🐂🐻 AI Debate Mode — Bull vs bear case with neutral verdict. /debate $TOKEN
📅 Event Countdown — 1hr, 30min, and go-time auto-reminders. /event "Title" YYYY-MM-DD HH:MM UTC
🎯 Price Milestones — 24/7 DexScreener watch, auto-celebrates on hit. /milestone add [CA] $[price] "Label"
🔍 Auto-CA Scanner — Anyone posts a 0x address → instant rug/honeypot scan. Zero commands needed.
🚨 PoorBoy Callz — First campaign auto-posts a callout card to the discovery channel.`,

  `━━━━━━━━━━━━━━━━━━━━
🖥️ SUBSCRIPTION TIERS

🆓 Free — raids + group management · no AI commands, no scans · no shill posts or campaigns
🌱 Starter — Growth Engine Missions, 100 Studio credits
💼 Builder — 500 Studio credits, $20 Custom List credit
⚡ Pro — 1,200 Studio credits, 1 Army Drop OR $40 Custom List credit
🏢 Agency — 2,500 Studio credits, free Army Drops, $0.02 Custom List wallets
Dev Launch — Launchpad-only, not directly purchasable; Agency-equivalent access

Current pricing: see /upgrade.

Developer API and $0 Hosted MCP are bundled with active Starter+ subscriptions using the same key; generation uses shared Studio credits.

Payments: USDC on Base · USDC on Solana · USDG on Robinhood Chain
Manual: contact @Rowdyrawdon

━━━━━━━━━━━━━━━━━━━━
🔗 LIVE INTEGRATIONS

• Telegram Bot API — Full bot runtime, 100 commands, group management
• Discord API — Slash commands, server moderation, tier enforcement
• Google Gemini AI — All AI content, image synthesis, translation, FUD detection, sentiment analysis
• DexScreener API — Live prices, charts, volume, milestone price tracking
• Ape.Store — $PBAI buy + rug-proof launch platform
• Crypto-only: USDC on Base, USDC on Solana, USDG on Robinhood Chain
• Clerk Auth — Multi-provider SSO dashboard authentication
• PostgreSQL — Users, campaigns, usage, events, milestones, translate/FUD settings

━━━━━━━━━━━━━━━━━━━━
🤝 COMMUNITY WORKERS PROGRAMME

Portal: poorboyai.pages.dev/marketplace
Access: Builder tier and above — unlocks automatically on upgrade.

Verified workers receive: priority support, direct admin access, exclusive tools, campaign assets, templates, and referral rewards (live via /invite). The programme rewards the people who actually grow the ecosystem.`,

  `━━━━━━━━━━━━━━━━━━━━
🪙 TOKENOMICS

Token: $PBAI
🔵 Base CA: 0x023f98c2f47edb09ee0d0bc9133d236fc82d060e

Fair Launch via Ape.Store — No presale · No team allocation · Full transparency
$69K mcap at launch → $12K LP auto-burned forever
Rug-proof: LP locked · contracts renounced

$PBAI utilities: dashboard tier access · fee discounts · launchpad priority · staking rewards (Q4 2026) · governance voting (2027)

━━━━━━━━━━━━━━━━━━━━
⚙️ TECH STACK

Frontend: React + Vite, Tailwind CSS, Framer Motion
Backend: Node.js, Express, TypeScript
Database: PostgreSQL + Drizzle ORM
Auth: Clerk (multi-provider SSO)
AI: Google Gemini (content + images + translation + FUD detection + sentiment)
Payments: USDC on Base · USDC on Solana · USDG on Robinhood Chain

━━━━━━━━━━━━━━━━━━━━
🗺️ ROADMAP

✅ Q1–Q2 2026 — LIVE NOW
Dashboard · Telegram (100 commands) · Discord (registered slash commands) · Tier system · USDC/USDG on-chain payments · Community Workers portal · Auto-translate (16 langs) · FUD Shield · Sentiment Score · AI Debate Mode · Events · Price Milestones · Auto-CA Scanner · Raid system · Campaign ads · Bot online 24/7

🔥 Q3–Q4 2026 — IN PROGRESS
AI-Verified Launchpad (Q4) · Twitter/X cross-posting · Whale Wallet Tracker · Token-gate (holder verification) · GoPlus enhanced /scan · Webhook outbound (Agency) · Historical price feeds

📈 Q4 2026 — PLANNED
Staking contract · $PBAI holder rewards · DEX swap widget · Revenue sharing pilot · Agent workflows · TradingView embeds · Cross-group intelligence network

🌕 2027+ — VISION
Full governance (vote with $PBAI) · Custom fine-tuned models · IPFS audit reports · White-label bot builder · Global ecosystem expansion

━━━━━━━━━━━━━━━━━━━━
🌐 Website: https://poorboyai.pages.dev
📄 Full whitepaper: ${WHITEPAPER_URL}`,
];

// ── /moonit captions (verbatim from the original; MarkdownV2 escapes
// stripped for the plain-text v1 surface) ───────────────────────────────────
const MOON_CAPTIONS = [
  "🌕 WE'RE GOING TO THE MOON 🚀\n\n$PBAI doesn't stop. The PoorBoy Army is strapped in and ready. Miss this and regret forever. 💎🙌\n\nhttps://poorboyai.pages.dev",
  "🚀 MOON MISSION ACTIVE 🌕\n\nFrom the trenches to the stars. $PBAI is the rocket fuel. LFG PoorBoy Army! 🔥\n\nhttps://poorboyai.pages.dev",
  "💎 POOR BOYS DON'T STOP 🌕\n\n$PBAI is built different. While they sleep, we accumulate. Moon is the next stop — not the last. 🤖\n\nhttps://poorboyai.pages.dev",
  "🔥 STRAP IN, WE'RE LAUNCHING 🌕\n\nThe PoorBoy Army is marching. $PBAI chart looking like a launchpad. WAGMI 🚀\n\nhttps://poorboyai.pages.dev",
];

// ── Text builders (shared by the commands and the skills layer) ─────────────
// The commands send these strings; lib/skills.js returns them. Wording is
// the commands' own — one source of truth for both surfaces.

/** /points group-branch text for one caller in one chat (sealed to it). */
export async function pointsTextFor(userId, chatId, displayName) {
  const uid = Number(userId);
  const name = displayName ?? 'You';
  let groupXp = 0, totalXp = 0, streak = 0;
  try {
    const row = await db.select().from(raid_xp)
      .where(and(eq(raid_xp.userId, uid), eq(raid_xp.chatId, Number(chatId)))).get();
    groupXp = Number(row?.xp ?? 0);
    streak = Number(row?.streak ?? 0);
  } catch { /* honest zeros below */ }
  try {
    const t = await db.get(sql`SELECT COALESCE(SUM(xp), 0) AS s FROM raid_xp WHERE user_id = ${uid} AND is_disqualified = 0`);
    totalXp = Number(t?.s ?? groupXp);
  } catch { totalXp = groupXp; }

  const tier = await callerTier(uid);
  const rank = getPBRank(totalXp);
  return '🏆 Your Points\n\n' +
    `${name}: ${groupXp} XP in this group · ${totalXp} XP total\n` +
    `🎖️ Rank: ${rank.emoji} ${rank.name}\n` +
    `🔥 Raid streak: ${streak} day${streak === 1 ? '' : 's'}\n` +
    `💳 Tier: ${tier}\n\n` +
    'See the leaderboard with /pointsrank';
}

/** /pointsrank GROUP-branch text: this chat's sealed top-10 + caller's rank. */
export async function pointsRankGroupTextFor(userId, chatId) {
  const uid = Number(userId);
  let board = [];
  try {
    board = await db.select().from(raid_xp)
      .where(and(eq(raid_xp.chatId, Number(chatId)), eq(raid_xp.isDisqualified, false)))
      .orderBy(desc(raid_xp.xp)).limit(10).all();
  } catch { board = []; }
  if (!board.length) {
    return '🏆 No XP yet in this group! Earn XP by raiding — /raid <url> launches one.';
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = board.map((r, i) => {
    const who = r.username ? `@${r.username}` : (r.displayName ?? 'Anon');
    return `${medals[i] ?? `${i + 1}.`} ${who} — ${Number(r.xp ?? 0)} XP`;
  });

  // Caller's own rank within this group (chatId filter only — sealing).
  let myLine = '';
  try {
    const mine = board.find((r) => Number(r.userId) === uid);
    if (mine) {
      const idx = board.indexOf(mine);
      myLine = `\n\nYou: #${idx + 1} on this board · ${Number(mine.xp ?? 0)} XP`;
    } else {
      const me = await db.get(sql`SELECT xp FROM raid_xp WHERE chat_id = ${Number(chatId)} AND user_id = ${uid} AND is_disqualified = 0`);
      if (me) {
        const above = await db.get(sql`SELECT COUNT(*) AS c FROM raid_xp WHERE chat_id = ${Number(chatId)} AND is_disqualified = 0 AND xp > ${Number(me.xp ?? 0)}`);
        myLine = `\n\nYou: #${Number(above?.c ?? 0) + 1} in this group · ${Number(me.xp ?? 0)} XP`;
      } else {
        myLine = '\n\nYou: no XP in this group yet — join a raid to get on the board.';
      }
    }
  } catch { myLine = ''; }

  return `🏆 Points Leaderboard — this group\n\n${lines.join('\n')}${myLine}\n\nEarn XP by raiding. Use /points to check yours.`;
}

/** /stats text — bot-wide aggregates (public, no personal data). */
export async function statsTextFor() {
  const safe = async (p) => { try { return Number((await p) ?? 0); } catch { return 0; } };
  const [users, groups, raids] = await Promise.all([
    safe(db.$count(bot_users)),
    safe(db.$count(known_groups)),
    safe(db.$count(raid_sessions)),
  ]);
  let totalXp = 0;
  try {
    const t = await db.get(sql`SELECT COALESCE(SUM(xp), 0) AS s FROM raid_xp WHERE is_disqualified = 0`);
    totalXp = Number(t?.s ?? 0);
  } catch { totalXp = 0; }
  const alerts = await safe(db.$count(price_alerts, eq(price_alerts.enabled, true)));
  const watches = await safe(db.$count(whale_watch_wallets, eq(whale_watch_wallets.enabled, true)));

  return [
    '🌐 Global Stats',
    `🤖 Bot in Groups: ${groups}`,
    `👥 Bot Users: ${users}`,
    `✖️ Total Raids: ${raids}`,
    `⚡ Total Raid XP: ${totalXp.toLocaleString()}`,
    `🔔 Active Price Alerts: ${alerts}`,
    `🐋 Active Whale Watches: ${watches}`,
    '',
    '🕐 Last updated: just now',
    'Powered by @PoorBoyAI_bot',
  ].join('\n');
}

export const MOONIT_GATE_TEXT = '🌕 Builder+ Required\n\n/moonit is available on Builder and above.\n\nUpgrade with /upgrade.';

/** /moonit gate, exactly as the handler applies it (canonical Builder+). */
export async function moonitGateTextFor(userId) {
  const tier = await callerTier(Number(userId));
  return BUILDER_PLUS.includes(tier) ? null : MOONIT_GATE_TEXT;
}

/** One random /moonit caption. */
export function pickMoonCaption() {
  return MOON_CAPTIONS[Math.floor(Math.random() * MOON_CAPTIONS.length)];
}

export const STATS_COMMANDS = {
  // ── /points — caller's XP summary (source: personal-balance branch) ─────
  points: async (chatId, args, msg) => {
    if (msg?.chat?.type === 'private') {
      await sendSafe(chatId, 'Use /points in a group.');
      return;
    }
    const from = msg?.from;
    if (!from) return;
    const name = from.first_name ?? from.username ?? 'You';
    await sendSafe(chatId, await pointsTextFor(from.id, chatId, name));
  },

  // ── /pointsrank — caller's rank among raid_xp rows ──────────────────────
  // Group run: top-10 board for THIS chat only + the caller's rank in it.
  // Private run: the caller's own global rank only (no cross-group data).
  pointsrank: async (chatId, args, msg) => {
    const from = msg?.from;
    if (!from) return;
    const uid = Number(from.id);
    const isGroup = msg?.chat?.type === 'group' || msg?.chat?.type === 'supergroup';

    if (isGroup) {
      await sendSafe(chatId, await pointsRankGroupTextFor(uid, chatId));
      return;
    }

    // Private: global rank of the caller only, computed from per-user totals.
    try {
      const me = await db.get(sql`SELECT COALESCE(SUM(xp), 0) AS s FROM raid_xp WHERE user_id = ${uid} AND is_disqualified = 0`);
      const myTotal = Number(me?.s ?? 0);
      if (myTotal <= 0) {
        await sendSafe(chatId,
          '🏆 No XP yet! Earn XP by raiding in a PoorBoyAI group, then check your rank here.');
        return;
      }
      const above = await db.get(sql`
        SELECT COUNT(*) AS c FROM (
          SELECT user_id, SUM(xp) AS total FROM raid_xp
          WHERE is_disqualified = 0 GROUP BY user_id
        ) WHERE total > ${myTotal}`);
      const raiders = await db.get(sql`
        SELECT COUNT(*) AS c FROM (
          SELECT DISTINCT user_id FROM raid_xp WHERE is_disqualified = 0
        )`);
      await sendSafe(chatId,
        `🏆 Your Global Rank\n\nRank: #${Number(above?.c ?? 0) + 1} of ${Number(raiders?.c ?? 0)} raiders\n` +
        `⚡ Total XP: ${myTotal}\n\n` +
        'Run /pointsrank inside a group to see that group\'s board.');
    } catch {
      await sendSafe(chatId, '❌ Could not fetch your rank right now. Try again in a moment.');
    }
  },

  // ── /stats — bot-wide aggregates (owner-gated per task spec; the
  // original handler was public — see header note) ─────────────────────────
  stats: async (chatId, args, msg) => {
    // Public in the original (telegram-community-bot.ts line ~27061) — no gate.
    // Coordinator correction 2026-10-19: the interim owner gate is removed to
    // restore the original's public behavior; aggregates only, no personal data.
    await sendSafe(chatId, await statsTextFor());
  },

  // ── /groupstats — THIS GROUP ONLY (source gate: Hustler+ / Builder+) ────
  groupstats: async (chatId, args, msg) => {
    if (msg?.chat?.type === 'private') {
      await sendSafe(chatId, 'Use /groupstats in a group.');
      return;
    }
    const from = msg?.from;
    if (!from) return;

    const tier = await callerTier(Number(from.id));
    if (!BUILDER_PLUS.includes(tier)) {
      await sendSafe(chatId,
        '⬆️ Group Stats requires Builder+\n\nUpgrade at: https://t.me/PoorBoyAI_bot');
      return;
    }

    const cid = Number(chatId);
    let raiders = 0, totalXp = 0, top = null, activeRaids = 0;
    try {
      const agg = await db.get(sql`
        SELECT COUNT(*) AS raiders, COALESCE(SUM(xp), 0) AS total
        FROM raid_xp WHERE chat_id = ${cid} AND is_disqualified = 0`);
      raiders = Number(agg?.raiders ?? 0);
      totalXp = Number(agg?.total ?? 0);
    } catch { /* honest zeros */ }
    try {
      top = await db.select().from(raid_xp)
        .where(and(eq(raid_xp.chatId, cid), eq(raid_xp.isDisqualified, false)))
        .orderBy(desc(raid_xp.xp)).limit(1).get();
    } catch { top = null; }
    try {
      activeRaids = await db.$count(raid_sessions,
        and(eq(raid_sessions.chatId, cid), eq(raid_sessions.isActive, true)));
    } catch { activeRaids = 0; }

    if (!raiders) {
      await sendSafe(chatId,
        '📊 No stats yet — data builds up as the group raids. Check back soon!');
      return;
    }

    let memberCount = null;
    try { memberCount = await api.getChatMemberCount({ chat_id: chatId }); } catch { memberCount = null; }

    const topName = top
      ? (top.username ? `@${top.username}` : (top.displayName ?? 'Anon'))
      : '—';
    const lines = [
      '📊 Group Stats — this group',
      '',
      ...(memberCount != null ? [`👥 Members: ${Number(memberCount).toLocaleString()}`] : []),
      `⚔️ Raiders with XP: ${raiders}`,
      `⚡ Total Raid XP: ${totalXp.toLocaleString()}`,
      `🥇 Top Raider: ${topName} — ${Number(top?.xp ?? 0)} XP`,
      `🔥 Active Raids: ${activeRaids}`,
      '',
      'Powered by @PoorBoyAI_bot',
    ];
    await sendSafe(chatId, lines.join('\n'));
  },

  // ── /whitepaper — original text + live URL (free, no gate) ──────────────
  whitepaper: async (chatId) => {
    for (const part of WHITEPAPER_PARTS) {
      await sendSafe(chatId, part);
    }
  },

  // ── /moonit — Builder+ (source: HUSTLER_TIERS gate) ─────────────────────
  // Both the Telegram original and the Discord twin reference a LOCAL file
  // (artifacts/api-server/data/moonit_pbai.mp4) — there is no hosted URL to
  // sendVideo by, and the serverless isolate has no filesystem (the file is
  // absent from both builds on disk, so even the originals fell back). Per
  // the twins' own fallback: post the caption.
  moonit: async (chatId, args, msg) => {
    const from = msg?.from;
    if (from) {
      const gate = await moonitGateTextFor(from.id);
      if (gate) {
        await sendSafe(chatId, gate);
        return;
      }
    }
    const caption = pickMoonCaption();
    try { await api.sendChatAction({ chat_id: chatId, action: 'upload_video' }); } catch { /* cosmetic */ }
    await sendSafe(chatId, caption);
  },
};

// ══ E4a completeness restores (2026-10-21) ═════════════════════════════════
// /autoread (:15379), /roadmap (:8252), /ecosystem (:16886), /discord
// (:17000), /keep_posting_till_elon_reposts (:16022). Roadmap/ecosystem/
// discord copy is recomposed truthful in the source's shape (parked
// features are never claimed live; dead links replaced).

// ── /autoread — group Auto Vision toggle (admin + Builder+) ───────────────
// Settings ride group_settings (lib/groups.js); the consumer is
// maybeAutoVision there. The caller's effective tier gates the toggle,
// exactly like the source (its legacy list = canonical Builder+).

async function autoread(chatId, args, msg) {
  if (msg.chat.type === 'private') {
    await sendSafe(chatId, 'ℹ️ /autoread only works in groups.');
    return;
  }
  if (!msg.from || !(await isChatAdmin(chatId, msg.from.id))) {
    await sendSafe(chatId, '🔒 Only admins can manage Auto Vision.', { reply_to_message_id: msg.message_id });
    return;
  }
  const tier = await callerTier(msg.from.id);
  if (!tierAtLeast(tier, 'builder')) {
    await sendSafe(chatId, '⛔ *Builder+ Required*\n\n/autoread is available on Builder and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.');
    return;
  }
  const s = await getGroupSettings(chatId);
  const enabled = s.autoVisionEnabled === true;
  const cooldownSeconds = Number(s.autoVisionCooldownSeconds ?? 30) || 30;
  const arg = String(args ?? '').trim().toLowerCase();

  if (!arg || arg === 'status') {
    await sendSafe(chatId,
      `👁️ *Auto Vision Status*\n\nStatus: ${enabled ? '✅ ACTIVE' : '❌ OFF'}\nCooldown: ${cooldownSeconds}s between reads\n\nWhen ON: every photo posted by members triggers an instant PB chart read — trend, sentiment, meme read. The cooldown prevents spam.\n\nCommands:\n• \`/autoread on\` — activate\n• \`/autoread off\` — deactivate\n• \`/autoread cooldown <seconds>\` — set cooldown (min 10s)`);
    return;
  }
  if (arg === 'on') {
    await setGroupSettings(chatId, { autoVisionEnabled: true });
    resetAutoVisionCooldown(chatId);
    await sendSafe(chatId,
      `👁️ *Auto Vision ACTIVATED!* I'll now read every photo posted in this group automatically.\n\nCooldown: ${cooldownSeconds}s (change with /autoread cooldown <seconds>).`);
    return;
  }
  if (arg === 'off') {
    await setGroupSettings(chatId, { autoVisionEnabled: false });
    await sendSafe(chatId, '👁️ Auto Vision *deactivated*.');
    return;
  }
  if (arg.startsWith('cooldown')) {
    const secs = Number.parseInt(arg.split(/\s+/)[1] ?? '', 10);
    if (!Number.isFinite(secs) || secs < 10) {
      await sendSafe(chatId, '⚠️ Cooldown must be at least 10 seconds. Example: `/autoread cooldown 30`');
      return;
    }
    await setGroupSettings(chatId, { autoVisionCooldownSeconds: secs });
    await sendSafe(chatId,
      `✅ *Auto Vision cooldown set to ${secs}s*\n\nPB will read at most one image every ${secs} seconds in this group.`);
    return;
  }
  await sendSafe(chatId, 'Usage: `/autoread on` | `/autoread off` | `/autoread cooldown <seconds>` | `/autoread status`');
}

// ── /roadmap (source :8252) — statuses corrected to today's truth ──────────

async function roadmap(chatId) {
  await sendSafe(chatId, [
    '🗺️ <b>PoorBoyAI — Development Roadmap</b>',
    '',
    '<i>"Built from the trenches, shipping for the community."</i>',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '✅ <b>PHASE 1 — FOUNDATION (Complete)</b>',
    '',
    '• @PoorBoyAI_bot — 100 Telegram commands live',
    '• Discord bot — 55 registered slash commands',
    '• Dashboard + Mini App — poorboyai.pages.dev',
    '• AI Image Generation (Gemini)',
    '• Community Raids + XP leaderboard',
    '• AI Agent platform (Pro / Agency)',
    '• Crypto transfer payments — USDT / USDC / SOL',
    '• Operator console + Community Workers Portal — live',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '🔄 <b>PHASE 2 — COMMUNITY TAKEOVER (In Progress)</b>',
    '',
    '• Autonomous PB brain — image gen, polls, raids, XP from AI chat ✅ Live',
    '• Pup Booster (Volume / Bump / MCap) — built, in final rollout',
    '• PoorBoyAI Airdrops — built, in final rollout',
    '• Chart Slayer game (guess the token chart) — parked, returns on the owner\'s call',
    '• AgentKit live Base wallet for AI agents 🔜',
    '• Telegram ↔ Discord communities — live on both, sealed per platform by design',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '🔜 <b>PHASE 3 — LAUNCHPAD (Q4 2026)</b>',
    '',
    '• AI-verified token launchpad — contracts + site built, Sepolia-proven, mainnet arming',
    '• Revenue Distributor smart contract — written + reviewed, deploys when revenue flows',
    '• Bonding-curve launches / Uniswap graduation',
    '• NFT collection for Agency holders',
    '• ERC-721 community badges',
    '• On-chain AgentKit wallets',
    '',
    '━━━━━━━━━━━━━━━━━━',
    '🌕 <b>PHASE 4 — ECOSYSTEM (2027)</b>',
    '',
    '• White-label Studio for other projects',
    '• Full marketplace for AI agents',
    '• PBAI staking + governance',
    '• Cross-chain expansion — multi-chain groundwork shipped',
    '',
    '📎 Full details: https://poorboyai.pages.dev/whitepaper',
  ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
}

// ── /ecosystem (source :16886) — two messages, statuses corrected ──────────

async function ecosystem(chatId) {
  // FIX 6 (2026-10-29): both messages used *bold* / _italic_ but were
  // sent with no parse_mode, so users saw the markers literally.
  // parse_mode is NOT the repair here: the texts also contain
  // CONTENT underscores (@PoorBoyAI_bot, and a URL would too) that
  // legacy Markdown would misparse — a lone _ risks a 400 or a
  // literal render. So these two go out PLAIN, markers stripped,
  // content identical. /menu and /status (paired markers, no content
  // underscores) keep parse_mode instead.
  await sendSafe(chatId,
    '🌐 PoorBoyAI Ecosystem\nEverything we\'re building — live status below 👇\n\n━━━━━━━━━━━━━━━━━━━━\n🤖 @PoorBoyAI_bot — Community Bot\nStatus: ✅ LIVE NOW\n100 commands: AI chat, price, TA, scam scan, image gen, alerts, raids, XP & more.');
  await sendSafe(chatId, [
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '🚀 PoorBoyAI Launchpad — AI-Verified Meme Launchpad',
    'Status: 🟡 BUILT — contracts + backend + site live in arming mode (Sepolia-proven; mainnet is the owner\'s call)',
    'The launchpad where every project is AI-screened before launch.',
    '🔗 https://poorboyai.pages.dev/launchpad',
    'Full launch: Q4 2026',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '🎓 PoorBoyAI Education — AI Tutor (Mr. Atlas)',
    'Status: 🔧 In development as its own project',
    'AI-powered tutoring across Math, Science & English.',
    'Drop your feedback — you shape what\'s built next',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '📊 PoorBoyAI Dashboard — Shill Command Center',
    'Status: ✅ LIVE — operator console + the Mini App member dashboard',
    '🔗 https://poorboyai.pages.dev/dashboard',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '🌐 https://poorboyai.pages.dev — Hub for the whole ecosystem',
    '💬 Early user? Drop your feedback in the group — we read everything.',
    '',
    '💰 Buy $PBAI (Base): https://ape.store/refer/4Ah6P69TEESczvFfL53S9g/8453/0x023f98c2f47edb09ee0d0bc9133d236fc82d060e',
  ].join('\n'));
}

// ── /discord (source :17000) — live server invite; the source's /bridge
//    tip is gone (the bridge is deliberately OFF; communities are sealed).

async function discord(chatId) {
  // FIX 6 (2026-10-29): same class as /ecosystem — *bold* / `code`
  // markers sent with no parse_mode showed literally, but parse_mode
  // is unsafe here too: the invite URL contains a content underscore
  // (client_id) that legacy Markdown would misparse. Plain text,
  // markers stripped, content identical.
  await sendSafe(chatId, [
    '🎮 PoorBoyAI is on Discord!',
    '',
    'The same AI bot you love on Telegram is live on Discord too.',
    '',
    '⚡ Available on Discord:',
    '/ask — AI chat (any language)',
    '/price — Live token prices',
    '/ta — Full technical analysis',
    '/scan — Security scan contracts',
    '/gem — Hot trending tokens on Base',
    '/pbai — $PBAI info & all links',
    '/help — Full command list',
    '',
    '💬 Join the server:',
    'https://discord.gg/Jk2tzNphr6',
    '',
    '🔗 Invite the bot to your Discord server:',
    'https://discord.com/oauth2/authorize?client_id=1508563922200957158&scope=bot+applications.commands&permissions=274878295040',
    '',
    '🌐 Dashboard: https://poorboyai.pages.dev/dashboard',
    '#PoorBoyAI #PBAI #Discord',
  ].join('\n'));
}

// ── /keep_posting_till_elon_reposts — the joke (source :16022) ─────────────
// NO gate in the source, none here (parity, flagged in the wave report).
// Toggle semantics are the source's: same chat re-run pauses; a run in
// another chat takes the mission over. Engine: lib/groupmsg.js + tick.

async function keep_posting_till_elon_reposts(chatId, args, msg) {
  const state = await elonMissionState();
  if (state.chatId && String(state.chatId) === String(chatId)) {
    const count = await stopElonMission();
    await sendSafe(chatId,
      `🛑 *Elon Mission paused after ${count} posts.* He'll see it eventually. We never stop building.`);
    return;
  }
  await startElonMission(chatId);
  await sendSafe(chatId,
    '🚀 *ELON MISSION ACTIVATED*\n\n@elonmusk will see $PBAI.\nPosting once a day until he reposts.\nRun the command again to pause.');
  await postElonBaitNow(chatId);
}

Object.assign(STATS_COMMANDS, {
  autoread,
  roadmap,
  ecosystem,
  discord,
  keep_posting_till_elon_reposts,
});

// ── Feedback + reviews (2026-11-05, Rowdy: feedback buttons + review ───────
//    buttons so people can leave live reviews) ─────────────────────────────
// Entry: /menu buttons (⭐ Leave a Review / 💬 Send Feedback) + the
// trial-start success message. No new top-level command, no new module.
// Wizard state lives in config (same pattern as lib/business.js bizwiz):
// fbwiz:<userId> JSON { awaiting, stars?, createdAt }, 15-min TTL.
// Rows land in pb_feedback (D1). Owner-only read: fb:owner:* callbacks.
// Status: new | read | approved | hidden. 'approved' only marks a row
// eligible for a future public surface — NOTHING publishes automatically.
// The site testimonials section is hardcoded today (Replit
// artifacts/poorboyai-com/src/components/testimonials.tsx); public display
// of user-submitted reviews needs Rowdy's word (moderation + authenticity).
// Sealing: the wizard runs in DM only; a group tap redirects to the DM.
// User text is always sent PLAIN (no parse_mode) — never rendered as markup.
// Anti-spam: one review per user per 24h, one feedback per 6h (config row
// fb:last:<userId>). Never throws into the caller: every entry returns a
// boolean / sends its own failure copy.

const FB_WIZ_TTL_MS = 15 * 60 * 1000;
const FB_TEXT_MAX = 1000;
const FB_REVIEW_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const FB_FEEDBACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FB_LIST_PAGE = 10;
const FB_LIST_MAX = 50;

const fbWizKey = (userId) => `fbwiz:${userId}`;
const fbLastKey = (userId) => `fb:last:${userId}`;

async function setFeedbackWizard(userId, state) {
  await setConfig(fbWizKey(userId), JSON.stringify({ ...state, createdAt: Date.now() })).catch(() => {});
}

async function clearFeedbackWizard(userId) {
  // config has no delete helper; an expired timestamp retires the session.
  await setConfig(fbWizKey(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

async function loadFeedbackWizard(userId) {
  try {
    const raw = await getConfig(fbWizKey(userId), null);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w?.awaiting || Date.now() - (w.createdAt ?? 0) > FB_WIZ_TTL_MS) return null;
    return w;
  } catch { return null; }
}

async function readFeedbackLast(userId) {
  try { return JSON.parse(await getConfig(fbLastKey(userId), '') || '{}') || {}; } catch { return {}; }
}

async function stampFeedbackLast(userId, kind) {
  const last = await readFeedbackLast(userId);
  if (kind === 'review') last.reviewAt = Date.now(); else last.feedbackAt = Date.now();
  await setConfig(fbLastKey(userId), JSON.stringify(last)).catch(() => {});
}

// ── Menu-button captures (2026-11-05, Rowdy: the /menu card buttons in a
//    group "don't do s***" — they need wizards on them) ─────────────────────
// The scan / generate buttons arm a one-shot capture: the tapper's next
// plain message IN THE SAME CHAT is the input (a contract for scan, a
// prompt for generate). Same shape as the fbwiz session above:
// menucap:<userId> JSON { kind, chatId, createdAt, retries }, 10-min TTL.
// Sealing: the capture is tapper-scoped AND chat-scoped — another user's
// message never consumes it, and it never fires in a different chat.
// Commands bypass it (a '/' message is never input). One capture per
// user — arming a second replaces the first (most recently armed wins).
// The consume lives in handlers/message.js (handleMenuCaptureText); the
// arm/load/clear live here so both handlers share one key.
const MENU_CAP_TTL_MS = 10 * 60 * 1000;
export const MENU_CAP_MAX_RETRIES = 1;

const menuCapKey = (userId) => `menucap:${userId}`;

export async function armMenuCapture(userId, kind, chatId) {
  await setConfig(menuCapKey(userId), JSON.stringify({
    kind, chatId: String(chatId), createdAt: Date.now(), retries: 0,
  })).catch(() => {});
}

export async function loadMenuCapture(userId) {
  try {
    const raw = await getConfig(menuCapKey(userId), null);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w?.kind || !w?.chatId || Date.now() - (w.createdAt ?? 0) > MENU_CAP_TTL_MS) return null;
    return w;
  } catch { return null; }
}

export async function clearMenuCapture(userId) {
  // config has no delete helper; an expired timestamp retires the session.
  await setConfig(menuCapKey(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

export async function bumpMenuCaptureRetry(userId, cap) {
  await setConfig(menuCapKey(userId), JSON.stringify({
    ...cap, retries: (cap.retries ?? 0) + 1,
  })).catch(() => {});
}

function feedbackCooldownLeftMs(last, kind) {
  const at = kind === 'review' ? Number(last.reviewAt ?? 0) : Number(last.feedbackAt ?? 0);
  if (!at) return 0;
  const windowMs = kind === 'review' ? FB_REVIEW_COOLDOWN_MS : FB_FEEDBACK_COOLDOWN_MS;
  return Math.max(0, windowMs - (Date.now() - at));
}

/**
 * Start the wizard. Returns { ok, text, reply_markup? } — the caller sends
 * it to the user's DM (group taps redirect there). Review opens on a star
 * picker; feedback goes straight to the text step.
 */
export async function startFeedbackWizard(userId, kind) {
  const k = kind === 'review' ? 'review' : 'feedback';
  const left = feedbackCooldownLeftMs(await readFeedbackLast(userId), k);
  if (left > 0) {
    const hrs = Math.ceil(left / 3600000);
    return { ok: false, text: k === 'review'
      ? `⭐ You already left a review in the last day — you can leave another in about ${hrs}h. Thanks for the love.`
      : `💬 Feedback received recently — you can send more in about ${hrs}h.` };
  }
  if (k === 'review') {
    await setFeedbackWizard(userId, { awaiting: 'review_stars' });
    return { ok: true, kind: k,
      text: '⭐ Leave a review\n\nHow many stars for PB? Tap one — then send your review as your next message here.',
      reply_markup: { inline_keyboard: [
        [{ text: '⭐', callback_data: 'fb:stars:1' }, { text: '⭐⭐', callback_data: 'fb:stars:2' }, { text: '⭐⭐⭐', callback_data: 'fb:stars:3' }],
        [{ text: '⭐⭐⭐⭐', callback_data: 'fb:stars:4' }, { text: '⭐⭐⭐⭐⭐', callback_data: 'fb:stars:5' }],
        [{ text: '❌ Cancel', callback_data: 'fb:cancel' }],
      ] } };
  }
  await setFeedbackWizard(userId, { awaiting: 'feedback_text' });
  return { ok: true, kind: k,
    text: '💬 Send feedback\n\nWhat should PB do better — or what do you love? Send it as your next message here. (One message, up to 1000 characters.)',
    reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fb:cancel' }]] } };
}

/**
 * Text-step capture. Returns true when the message was consumed as wizard
 * input (caller stops routing). Only fires while a text step is armed;
 * a star-picker wait ('review_stars') never consumes text, and commands
 * always bypass (caller checks '/').
 */
export async function handleFeedbackWizardText(userId, text, from) {
  if (!userId || !text || text.startsWith('/')) return false;
  const wiz = await loadFeedbackWizard(userId);
  if (!wiz) return false;
  if (wiz.awaiting !== 'review_text' && wiz.awaiting !== 'feedback_text') return false;
  const kind = wiz.awaiting === 'review_text' ? 'review' : 'feedback';
  const clean = String(text).trim();
  if (!clean) {
    await sendSafe(userId, 'Send a little more than that — one message with your words.');
    return true; // consumed; wizard stays armed
  }
  if (clean.length > FB_TEXT_MAX) {
    await sendSafe(userId, `That ran long (${clean.length}/${FB_TEXT_MAX}) — send it shorter, one message.`);
    return true; // consumed; wizard stays armed for the retry
  }
  const row = {
    kind,
    userId: String(userId),
    username: from?.username ? String(from.username) : null,
    displayName: from?.first_name ? String(from.first_name) : null,
    stars: kind === 'review' ? (Number(wiz.stars) || null) : null,
    text: clean,
    status: 'new',
    createdAt: Math.floor(Date.now() / 1000),
  };
  try {
    await db.insert(pb_feedback).values(row).run();
  } catch (err) {
    console.error('[feedback save]', err?.message ?? err);
    await sendSafe(userId, '❌ That didn\'t save — try sending it again in a moment.');
    return true; // consumed; wizard stays armed for a retry
  }
  await clearFeedbackWizard(userId);
  await stampFeedbackLast(userId, kind);
  await sendSafe(userId, kind === 'review'
    ? `⭐ Thanks — your ${row.stars}-star review is in. Rowdy reads every one.`
    : '💬 Thanks — your feedback is in. It goes straight to Rowdy.');
  await notifyFeedbackOwner(row).catch(() => {});
  return true;
}

/** Owner DM ping on each new row (best-effort, never throws). */
async function notifyFeedbackOwner(row) {
  const owners = [...(await ownerIdSet().catch(() => new Set()))];
  if (!owners.length) return;
  const head = row.kind === 'review' ? `⭐ New ${row.stars}-star review` : '💬 New feedback';
  const who = row.username ? `@${row.username}` : (row.displayName ?? `user ${row.userId}`);
  const text = `${head} from ${who}:\n\n${row.text}`;
  for (const ownerId of owners) {
    try {
      await api.sendMessage({ chat_id: Number(ownerId) || ownerId, text: text.slice(0, 4000),
        reply_markup: { inline_keyboard: [[{ text: '📋 View reviews', callback_data: 'fb:owner:list' }]] } });
    } catch { /* best effort */ }
  }
}

function formatFeedbackRow(r) {
  const stars = r.kind === 'review' ? `${'⭐'.repeat(Number(r.stars) || 0)} (${Number(r.stars) || '?'} / 5)` : '💬 feedback';
  const who = r.username ? `@${r.username}` : (r.displayName ?? `user ${r.userId}`);
  const tag = { new: '🆕 new', read: '👁 read', approved: '✅ approved', hidden: '🙈 hidden' }[r.status] ?? r.status;
  const body = String(r.text ?? '');
  return `#${r.id} ${stars} — ${who} · ${tag}\n${body.slice(0, 300)}${body.length > 300 ? '…' : ''}`;
}

async function sendFeedbackOwnerList(toChatId, offset = 0) {
  const rows = await db.select().from(pb_feedback).orderBy(desc(pb_feedback.createdAt)).limit(FB_LIST_MAX).all().catch(() => []);
  const total = rows.length;
  const page = rows.slice(offset, offset + FB_LIST_PAGE);
  const counts = { new: 0, read: 0, approved: 0, hidden: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const head = `📋 Reviews & feedback — newest first\nNew: ${counts.new ?? 0} · Read: ${counts.read ?? 0} · Approved: ${counts.approved ?? 0} · Hidden: ${counts.hidden ?? 0}${total >= FB_LIST_MAX ? ' (latest 50)' : ''}`;
  const kb = page.map((r) => ([
    { text: `✅ #${r.id}`, callback_data: `fb:owner:approve:${r.id}` },
    { text: `🙈 #${r.id}`, callback_data: `fb:owner:hide:${r.id}` },
  ]));
  if (offset + FB_LIST_PAGE < total) kb.push([{ text: '➡️ More', callback_data: `fb:owner:more:${offset + FB_LIST_PAGE}` }]);
  kb.push([{ text: '✅ Mark all read', callback_data: 'fb:owner:readall' }]);
  await sendSafe(toChatId,
    page.length ? `${head}\n\n${page.map((r) => formatFeedbackRow(r)).join('\n\n')}` : `${head}\n\nNothing yet — reviews land here the moment someone leaves one.`,
    { reply_markup: { inline_keyboard: kb } });
}

/**
 * fb:* button router (called from handlers/callback_query.js after the
 * query is answered). Stars + cancel for the user; list / approve / hide /
 * mark-read for the owner only. Never throws.
 */
export async function handleFeedbackCallback({ data, from, chatId }) {
  const userId = from?.id;
  const to = chatId ?? userId;
  if (data === 'fb:cancel') {
    await clearFeedbackWizard(userId);
    await sendSafe(to, 'Cancelled — nothing saved. /menu anytime to try again.');
    return;
  }
  if (data.startsWith('fb:stars:')) {
    const n = Number(data.slice('fb:stars:'.length));
    const wiz = await loadFeedbackWizard(userId);
    if (!wiz || wiz.awaiting !== 'review_stars' || !(n >= 1 && n <= 5)) {
      await sendSafe(to, '⭐ That review step expired — tap ⭐ Leave a Review in /menu to start again.');
      return;
    }
    await setFeedbackWizard(userId, { awaiting: 'review_text', stars: n });
    await sendSafe(to, `${'⭐'.repeat(n)} — nice. Now send your review as your next message here (up to 1000 characters).`, {
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fb:cancel' }]] },
    });
    return;
  }
  if (data.startsWith('fb:owner:')) {
    if (!(await isOwnerId(userId).catch(() => false))) {
      await sendSafe(to, 'Owner only.');
      return;
    }
    const sub = data.slice('fb:owner:'.length);
    if (sub === 'list' || sub.startsWith('more:')) {
      const offset = sub.startsWith('more:') ? Number(sub.slice(5)) || 0 : 0;
      await sendFeedbackOwnerList(to, offset);
      return;
    }
    if (sub === 'readall') {
      await db.update(pb_feedback).set({ status: 'read' }).where(eq(pb_feedback.status, 'new')).run();
      await sendSafe(to, '✅ All new reviews marked read.');
      return;
    }
    if (sub.startsWith('approve:') || sub.startsWith('hide:')) {
      const [action, idRaw] = sub.split(':');
      const id = Number(idRaw);
      const row = id ? await db.select().from(pb_feedback).where(eq(pb_feedback.id, id)).get().catch(() => null) : null;
      if (!row) {
        await sendSafe(to, 'That review is gone — tap 📋 View reviews for the latest list.');
        return;
      }
      const next = action === 'approve' ? 'approved' : 'hidden';
      await db.update(pb_feedback).set({ status: next, decidedBy: String(userId), decidedAt: Math.floor(Date.now() / 1000) }).where(eq(pb_feedback.id, id)).run();
      await sendSafe(to, action === 'approve'
        ? `✅ Review #${id} approved — eligible for a future public surface (nothing publishes on its own).`
        : `🙈 Review #${id} hidden — it stays stored, never shown.`);
      return;
    }
    return;
  }
}

// ── Inbound sales leg (2026-11-05, Rowdy: turn hot leads into paid ─────────
//    campaigns) ─────────────────────────────────────────────────────────────
// A qualified prospect gets quoted the real fee, pays, and gets their
// campaign created, with an itemized receipt in Rowdy's DM. Entry: a DM
// buying-intent message, or /airdrop / /boost, from a lead-matched sender
// (pb_leads: telegram-handle match, status new/digested, score >= 55,
// serviceFit airdrop/boost/multi; never dismissed/do_not_contact/raw).
// Inbound only: the leg never contacts anyone who hasn't engaged first,
// sends no follow-up nags, and never claims a payment landed unless the
// rail confirms it. Payment is gated by the sales_leg_live config flag
// (unset = gated; only explicit 1/on/true/yes ungates). No XRocket
// anywhere: airdrop fees settle through matchAirdropFeePayments, booster
// fees inside the deposit via checkBoostDeposit. Custom/off-schedule asks
// pend to the owner (sales:owner:* callbacks) — the owner takes over, the
// leg never invents a price. Wizard state lives in config:
// saleswiz:<userId> JSON, 15-min TTL (same pattern as fbwiz). Sales rows
// land in `sales` (D1). Sealing: DM only; a prospect sees only their own
// sale; owner taps re-check isOwnerId on every press. User text is sent
// PLAIN (no parse_mode) — never rendered as markup.

const SALES_WIZ_TTL_MS = 15 * 60 * 1000;
const SALES_GATE_KEY = 'sales_leg_live';
const SALES_LEAD_MIN_SCORE = 55;
const SALES_OWNER_PEND_TTL_MS = 24 * 60 * 60 * 1000;
const SALES_CHAIN_LABELS = { base: 'Base', sol: 'Solana', rh: 'Robinhood Chain' };
const SALES_NATIVE = { base: 'ETH', sol: 'SOL', rh: 'ETH' };
const SALES_SERVICE_LABELS = {
  airdrop_custom: 'Airdrop Custom List',
  boost_volume: 'Booster Volume',
  boost_bump: 'Booster Bump',
  boost_mcap: 'Booster MCap',
};

const salesWizKey = (userId) => `saleswiz:${userId}`;

async function setSalesWizard(userId, state) {
  await setConfig(salesWizKey(userId), JSON.stringify({ ...state, createdAt: Date.now() })).catch(() => {});
}
async function clearSalesWizard(userId) {
  // config has no delete helper; an expired timestamp retires the session.
  await setConfig(salesWizKey(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}
async function loadSalesWizard(userId) {
  try {
    const raw = await getConfig(salesWizKey(userId), null);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w?.stage || Date.now() - (w.createdAt ?? 0) > SALES_WIZ_TTL_MS) return null;
    return w;
  } catch { return null; }
}
export async function isSalesWizardActive(userId) {
  return !!(await loadSalesWizard(userId));
}

/** Payment gate. Fail-closed: unset/empty/garbage = gated. */
export async function isSalesLegLive(deps = {}) {
  try {
    const v = deps.flag ?? (await getConfig(SALES_GATE_KEY, ''));
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'on' || s === 'true' || s === 'yes';
  } catch { return false; }
}

function normalizeLeadHandle(h) {
  if (!h) return '';
  let s = String(h).trim().toLowerCase();
  s = s.replace(/^@/, '').replace(/^https?:\/\/(www\.)?t\.me\//, '').replace(/^t\.me\//, '');
  return s.split(/[/?#]/)[0];
}

/**
 * Find the prospect's lead row by telegram handle. Returns the highest-score
 * row that is eligible for a sales conversation, or null. Never matches
 * dismissed / do_not_contact / raw rows — those are durable suppression or
 * below threshold, and a miss fails safe (the message goes to the brain).
 */
export async function findSalesLead(userId, from) {
  const handle = normalizeLeadHandle(from?.username);
  if (!handle) return null;
  const variants = [handle, `@${handle}`, `t.me/${handle}`, `https://t.me/${handle}`];
  const rows = await db.select().from(pb_leads)
    .where(inArray(pb_leads.telegramHandle, variants)).all().catch(() => []);
  const cands = rows.filter((r) => normalizeLeadHandle(r.telegramHandle) === handle
    && (r.status === 'new' || r.status === 'digested')
    && Number(r.score ?? 0) >= SALES_LEAD_MIN_SCORE
    && ['airdrop', 'boost', 'multi'].includes(String(r.serviceFit ?? '')));
  if (!cands.length) return null;
  cands.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
  return cands[0];
}

const SALES_INTENT_RE = /\b(airdrop|boost(?:er)?|buy|purchase)\b/i;
const SALES_INTENT_SOFT_RE = /\b(launch|drop)\b/i;
const SALES_INTENT_WANT_RE = /\b(want|need|looking|get|start|can i|how (do|can) i)\b/i;
/** Buying intent in a DM text. Pure — harness-tested. */
export function isSalesIntent(text) {
  const t = String(text ?? '');
  if (SALES_INTENT_RE.test(t)) return true;
  return SALES_INTENT_SOFT_RE.test(t) && SALES_INTENT_WANT_RE.test(t);
}

/** Deterministic spec digest for sale idempotency (one live sale per hash). */
export async function salesSpecHash(buyerId, service, spec) {
  const parts = [
    String(buyerId), String(service), String(spec.tokenCa ?? '').toLowerCase(),
    String(spec.chain ?? ''), String(spec.amountPerWallet ?? ''), String(spec.capitalUsd ?? ''),
    String(spec.mode ?? ''), String(spec.bumpPackage ?? ''),
    String(spec.refundAddress ?? '').toLowerCase(),
    String(spec.mcapMin ?? ''), String(spec.mcapMax ?? ''),
    String(spec.addressesInput ?? ''),
  ];
  try {
    return await sha256Hex(parts.join('|'));
  } catch {
    return parts.join('|').slice(0, 200);
  }
}

const SALES_LIVE_STATUSES = ['qualifying', 'quoted', 'pending_owner', 'awaiting_payment', 'paid'];
async function findLiveSale(buyerId, service, specHash) {
  const rows = await db.select().from(sales)
    .where(and(
      eq(sales.buyerTelegramId, String(buyerId)),
      eq(sales.service, service),
      eq(sales.specHash, specHash),
    )).all().catch(() => []);
  return rows.find((r) => SALES_LIVE_STATUSES.includes(String(r.status))) ?? null;
}

async function createSaleRow(buyerId, leadId, service, campaignKind, feeUsd, specHash) {
  // NOTE: the isolate's .returning() thenable has no .catch — wrap in
  // try/catch (tree convention: .run()/.get()/.all() carry .catch, .returning() does not).
  let inserted = null;
  try {
    inserted = await db.insert(sales).values({
      buyerTelegramId: String(buyerId),
      leadId: leadId ?? null,
      service,
      campaignKind,
      campaignId: null,
      feeUsd: String(feeUsd),
      status: 'qualifying',
      specHash,
      txHash: null,
      receiptSentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
  } catch { inserted = null; }
  return inserted?.[0] ?? null;
}

async function setSaleStatus(saleId, status) {
  await db.update(sales).set({ status, updatedAt: new Date() })
    .where(eq(sales.id, saleId)).run().catch(() => {});
}

/** Lead stage transitions. Only ever moves new/digested -> contacted -> won. */
async function salesMarkLeadContacted(leadId) {
  if (!leadId) return;
  await db.update(pb_leads).set({ status: 'contacted' })
    .where(and(eq(pb_leads.id, leadId), inArray(pb_leads.status, ['new', 'digested']))).run().catch(() => {});
}

const SALES_CANCEL_KB = { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'sales:cancel' }]] };
const salesServiceKb = () => ({ inline_keyboard: [
  [{ text: '🪂 Airdrop Custom List — $9 + $0.03/wallet', callback_data: 'sales:svc:airdrop' }],
  [{ text: '📈 Booster Volume', callback_data: 'sales:svc:boost_volume' }],
  [{ text: '⚡ Booster Bump — $29 / $79 / $149', callback_data: 'sales:svc:boost_bump' }],
  [{ text: '🚀 Booster MCap', callback_data: 'sales:svc:boost_mcap' }],
  [{ text: '💬 Something else', callback_data: 'sales:svc:other' }],
  [{ text: '❌ Cancel', callback_data: 'sales:cancel' }],
] });
const salesBoostModeKb = () => ({ inline_keyboard: [
  [{ text: '📈 Volume — balanced buy/sell cycles', callback_data: 'sales:svc:boost_volume' }],
  [{ text: '⚡ Bump — one buy per wallet', callback_data: 'sales:svc:boost_bump' }],
  [{ text: '🚀 MCap — buy-weighted to a target band', callback_data: 'sales:svc:boost_mcap' }],
  [{ text: '❌ Cancel', callback_data: 'sales:cancel' }],
] });

const salesQuoteKb = () => ({ inline_keyboard: [
  [{ text: '✅ Confirm & get payment details', callback_data: 'sales:confirm' }],
  [{ text: '❌ Cancel', callback_data: 'sales:cancel' }],
] });
const salesQuoteBlockedKb = () => ({ inline_keyboard: [
  [{ text: '❌ Cancel', callback_data: 'sales:cancel' }],
] });
const salesPayKb = () => ({ inline_keyboard: [
  [{ text: '✅ I paid — check now', callback_data: 'sales:paid' }],
  [{ text: '❌ Cancel', callback_data: 'sales:cancel' }],
] });

async function salesChainKb(kind, mode = null) {
  let chains = ['base', 'sol', 'rh'];
  if (kind === 'airdrop') {
    const open = [];
    for (const c of chains) {
      if (await isAirdropChainEnabled(c).catch(() => false)) open.push(c);
    }
    chains = open;
  } else if (mode === 'bump' || mode === 'mcap') {
    chains = ['base'];
  }
  const rows = chains.map((c) => [{ text: SALES_CHAIN_LABELS[c], callback_data: `sales:chain:${c}` }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'sales:cancel' }]);
  return { inline_keyboard: rows };
}

async function salesChainPrompt(wiz) {
  const kind = wiz.service === 'airdrop_custom' ? 'airdrop' : 'boost';
  const mode = wiz.service === 'boost_bump' ? 'bump' : (wiz.service === 'boost_mcap' ? 'mcap' : null);
  const kb = await salesChainKb(kind, mode);
  const open = kb.inline_keyboard.filter((r) => String(r[0]?.callback_data ?? '').startsWith('sales:chain:'));
  if (!open.length) return { closed: true, text: 'That isn\'t open on any chain right now — check back soon, or pick something else.' };
  return { text: 'Which chain?', reply_markup: kb };
}

async function salesAskChain(userId, wiz) {
  const p = await salesChainPrompt(wiz);
  if (p.closed) {
    await clearSalesWizard(userId);
    await sendSafe(userId, p.text);
    return;
  }
  await setSalesWizard(userId, { ...wiz, stage: 'chain' });
  await sendSafe(userId, p.text, { reply_markup: p.reply_markup });
}

/**
 * Start the qualify wizard for a lead-matched prospect.
 * Returns { ok, text, reply_markup? } — the caller sends it to the DM.
 * Studio / bot_subscription fits are refused plainly with a pointer to /buy.
 */
export async function startSalesWizard(userId, from, lead = null) {
  const l = lead ?? (await findSalesLead(userId, from).catch(() => null));
  if (!l) return { ok: false, text: '' };
  const fit = String(l.serviceFit ?? 'multi');
  if (fit === 'studio' || fit === 'bot_subscription') {
    return { ok: false, text: 'I can help with airdrops and Booster here. Studio credits and the PB Plan are on /buy — same bot, same checkout.' };
  }
  await salesMarkLeadContacted(l.id);
  const name = from?.first_name ?? 'friend';
  if (fit === 'airdrop') {
    const wiz = { stage: 'chain', leadId: l.id, service: 'airdrop_custom' };
    const p = await salesChainPrompt(wiz);
    if (p.closed) {
      await clearSalesWizard(userId);
      return { ok: false, text: p.text };
    }
    await setSalesWizard(userId, wiz);
    return { ok: true, text: `Let's set up your airdrop, ${name} — Custom List, $9 + $0.03 per wallet ($0.02 on the PB Plan).\n\n${p.text}`, reply_markup: p.reply_markup };
  }
  if (fit === 'boost') {
    await setSalesWizard(userId, { stage: 'service', leadId: l.id, service: null });
    return { ok: true, text: `Let's set up your boost, ${name} — pick the type:`, reply_markup: salesBoostModeKb() };
  }
  await setSalesWizard(userId, { stage: 'service', leadId: l.id, service: null });
  return { ok: true, text: `Let's get you set up, ${name} — what do you need?`, reply_markup: salesServiceKb() };
}

function salesAirdropQuoteText(camp) {
  return [
    'Your quote (15 minutes)',
    '',
    `Airdrop Custom List on ${SALES_CHAIN_LABELS[camp.chain] ?? camp.chain}`,
    `Token: ${camp.tokenCa}`,
    `Per wallet: ${camp.amountPerWallet} — ${camp.walletCount} wallets`,
    `Service fee: $${camp.serviceFeeUsd} (Base USDC)`,
    '',
    'Confirm to lock this in and get payment details. Nothing is charged until you pay the fee.',
  ].join('\n');
}

function salesBoostQuoteText(q, warnings = []) {
  const blocked = warnings.some((w) => w?.severity === 'block');
  const lines = [
    'Your signed quote (15 minutes)',
    '',
    `Booster ${q.mode ?? ''} on ${SALES_CHAIN_LABELS[q.chain] ?? q.chain}`,
    `Token: ${q.tokenCa}`,
    `Working capital: $${q.workingCapitalUsd}`,
    `Platform fee: $${q.platformFeeUsd}${q.discountUsd ? ` (tier discount -$${q.discountUsd})` : ''}`,
    `Network reserve: $${q.networkReserveUsd}`,
    `Total due: $${q.totalDueUsd} ≈ ${q.totalDueNative} ${SALES_NATIVE[q.chain] ?? ''}`,
  ];
  if (warnings.length) lines.push('', ...warnings.map((w) => w.text));
  if (blocked) {
    lines.push('', 'This quote cannot be accepted as shown — tap Cancel and start again with a different refund address.');
  } else {
    lines.push('', 'Accept to get your one-time deposit address. Nothing is sent anywhere until you fund it — and execution itself stays gated on the owner live flag, so nothing broadcasts yet.');
  }
  return { text: lines.join('\n'), blocked };
}

async function salesCreateAirdrop(userId, wiz, validated) {
  const spec = {
    mode: 'custom', chain: wiz.chain, tokenCa: wiz.tokenCa,
    amountPerWallet: wiz.amountPerWallet, addressesInput: validated.addresses.join('\n'),
  };
  const specHash = await salesSpecHash(userId, 'airdrop_custom', spec);
  let reQuote = false;
  const existing = await findLiveSale(userId, 'airdrop_custom', specHash);
  if (existing?.campaignId) {
    const camp = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, existing.campaignId)).get().catch(() => null);
    if (camp && camp.status === 'fee_pending') {
      if (camp.quoteExpiresAt && Number(camp.quoteExpiresAt) < Date.now()) {
        // Stale quote: retire the old campaign (the matcher only scans
        // fee_pending, so no fee ambiguity) and re-quote fresh below.
        await db.update(airdrop_campaigns).set({ status: 'expired' }).where(eq(airdrop_campaigns.id, camp.id)).run().catch(() => {});
        reQuote = true;
      } else {
        const quoteText = salesAirdropQuoteText(camp);
        await setSalesWizard(userId, { ...wiz, stage: 'quote', saleId: existing.id, campaignId: String(camp.id), campaignKind: 'airdrop', feeUsd: String(camp.serviceFeeUsd ?? existing.feeUsd), quoteText });
        await sendSafe(userId, quoteText, { reply_markup: salesQuoteKb() });
        return true;
      }
    }
  }
  let created;
  try {
    created = await createAirdropCampaign(userId, { ...spec, idempotencyKey: reQuote ? `sales_${specHash}_rq${Date.now()}` : `sales_${specHash}` });
  } catch (err) {
    await sendSafe(userId, `That couldn't be quoted — ${err?.message ?? 'try again in a moment.'}`);
    return true;
  }
  const camp = created?.campaigns?.[0];
  if (!camp) {
    await sendSafe(userId, 'That couldn\'t be quoted — try again in a moment.');
    return true;
  }
  let sale = null;
  if (reQuote && existing) {
    await db.update(sales).set({ campaignId: String(camp.id), feeUsd: String(camp.serviceFeeUsd ?? '0'), status: 'quoted' }).where(eq(sales.id, existing.id)).run().catch(() => {});
    sale = existing;
  } else {
    sale = await createSaleRow(userId, wiz.leadId, 'airdrop_custom', 'airdrop', String(camp.serviceFeeUsd ?? '0'), specHash);
    if (sale) {
      await db.update(sales).set({ campaignId: String(camp.id), status: 'quoted' }).where(eq(sales.id, sale.id)).run().catch(() => {});
    }
  }
  const quoteText = salesAirdropQuoteText(camp);
  await setSalesWizard(userId, { ...wiz, stage: 'quote', saleId: sale?.id ?? null, campaignId: String(camp.id), campaignKind: 'airdrop', feeUsd: String(camp.serviceFeeUsd ?? '0'), quoteText });
  await sendSafe(userId, quoteText, { reply_markup: salesQuoteKb() });
  return true;
}

async function salesCreateBoost(userId, wiz) {
  const mode = wiz.service === 'boost_bump' ? 'bump' : (wiz.service === 'boost_mcap' ? 'mcap' : 'volume');
  const input = {
    mode, chain: wiz.chain, tokenCA: wiz.tokenCa, refundAddress: wiz.refundAddress,
    workingCapitalUsd: Number(wiz.capitalUsd),
    ...(wiz.bumpPackage ? { bumpPackage: wiz.bumpPackage } : {}),
    ...(wiz.mcapMin ? { targetMcapMinUsd: Number(wiz.mcapMin), targetMcapMaxUsd: Number(wiz.mcapMax) } : {}),
  };
  const specHash = await salesSpecHash(userId, wiz.service, {
    tokenCa: wiz.tokenCa, chain: wiz.chain, capitalUsd: wiz.capitalUsd, mode,
    bumpPackage: wiz.bumpPackage ?? '', refundAddress: wiz.refundAddress,
    mcapMin: wiz.mcapMin ?? '', mcapMax: wiz.mcapMax ?? '',
  });
  const existing = await findLiveSale(userId, wiz.service, specHash);
  let reQuote = false;
  if (existing?.campaignId) {
    const camp = await db.select().from(boost_campaigns).where(eq(boost_campaigns.id, existing.campaignId)).get().catch(() => null);
    if (camp && (camp.status === 'quoted' || camp.status === 'deposit_pending')) {
      if (camp.status === 'quoted' && camp.quoteExpiresAt && Number(camp.quoteExpiresAt) < Date.now()) {
        // Stale quote: retire the old campaign and re-quote fresh below.
        await db.update(boost_campaigns).set({ status: 'expired' }).where(eq(boost_campaigns.id, camp.id)).run().catch(() => {});
        reQuote = true;
      } else {
        const q = {
          mode, chain: camp.chain, tokenCa: camp.tokenCa,
          workingCapitalUsd: camp.workingCapitalUsd, platformFeeUsd: camp.platformFeeUsd,
          discountUsd: camp.discountUsd, networkReserveUsd: camp.networkReserveUsd,
          totalDueUsd: camp.totalDueUsd, totalDueNative: camp.totalDueNative,
        };
        const { text } = salesBoostQuoteText(q, []);
        await setSalesWizard(userId, { ...wiz, stage: 'quote', saleId: existing.id, campaignId: String(camp.id), campaignKind: 'boost', feeUsd: String(camp.platformFeeUsd ?? existing.feeUsd), quoteText: text });
        await sendSafe(userId, text, { reply_markup: salesQuoteKb() });
        return true;
      }
    }
  }
  let created;
  try {
    created = await createBoostCampaign(userId, input);
  } catch (err) {
    await sendSafe(userId, `That couldn't be quoted — ${err?.message ?? 'try again in a moment.'}`);
    return true;
  }
  const { id, quote, warnings = [] } = created ?? {};
  if (!id || !quote) {
    await sendSafe(userId, 'That couldn\'t be quoted — try again in a moment.');
    return true;
  }
  let sale = null;
  if (reQuote && existing) {
    await db.update(sales).set({ campaignId: String(id), feeUsd: String(quote.platformFeeUsd ?? '0'), status: 'quoted' }).where(eq(sales.id, existing.id)).run().catch(() => {});
    sale = existing;
  } else {
    sale = await createSaleRow(userId, wiz.leadId, wiz.service, 'boost', String(quote.platformFeeUsd ?? '0'), specHash);
    if (sale) {
      await db.update(sales).set({ campaignId: String(id), status: 'quoted' }).where(eq(sales.id, sale.id)).run().catch(() => {});
    }
  }
  const { text, blocked } = salesBoostQuoteText({ ...quote, mode, chain: wiz.chain, tokenCa: wiz.tokenCa }, warnings);
  await setSalesWizard(userId, { ...wiz, stage: 'quote', saleId: sale?.id ?? null, campaignId: String(id), campaignKind: 'boost', feeUsd: String(quote.platformFeeUsd ?? '0'), quoteText: text, blocked });
  await sendSafe(userId, text, { reply_markup: blocked ? salesQuoteBlockedKb() : salesQuoteKb() });
  return true;
}

async function salesReprompt(userId, wiz) {
  if (wiz.stage === 'service') {
    await sendSafe(userId, 'Pick what you need — or tap Cancel.', { reply_markup: salesServiceKb() });
  } else if (wiz.stage === 'chain') {
    await salesAskChain(userId, wiz);
  } else if (wiz.stage === 'quote') {
    await sendSafe(userId, wiz.quoteText ?? 'Your quote is ready — tap Confirm to proceed or Cancel to stop.', { reply_markup: wiz.blocked ? salesQuoteBlockedKb() : salesQuoteKb() });
  } else if (wiz.stage === 'pay') {
    const pres = await salesPayPresentation(userId, wiz);
    await sendSafe(userId, pres.text, { reply_markup: pres.reply_markup });
  } else if (wiz.stage === 'pending_owner') {
    await sendSafe(userId, 'Rowdy has your ask — he\'ll message you. If you don\'t hear back within a day, send me another message and we\'ll start fresh.');
  } else {
    await sendSafe(userId, 'Send the requested value, or tap Cancel on the panel.');
  }
}

/** The gate's plain missing-step message. No address, no amount, no link. */
const SALES_GATE_CLOSED_TEXT = 'Payments for this are opening soon — Rowdy flips the switch and I\'ll message you with the payment details.';

/**
 * Build the pay presentation for a confirmed quote. The gate decides the
 * shape: closed → missing-step message only; open → real pay lines.
 * Airdrop pay lines come from airdropFeePayLines (authoritative); the
 * buyer must have a connected Base wallet in user_wallets.baseAddress or
 * the address is withheld and /connect is requested first. Booster pay
 * lines come from the accepted quote (totalDueNative + deposit address).
 * Returns { text, reply_markup }.
 */
export async function salesPayPresentation(userId, wiz, deps = {}) {
  const live = deps.live ?? (await isSalesLegLive(deps));
  if (!live) {
    return { text: SALES_GATE_CLOSED_TEXT, reply_markup: SALES_CANCEL_KB };
  }
  if (wiz.campaignKind === 'airdrop') {
    const wallet = await db.select().from(user_wallets).where(eq(user_wallets.telegramUserId, String(userId))).get().catch(() => null);
    if (!wallet?.baseAddress) {
      return { text: 'Before I can show the payment address, connect your Base wallet with /connect — the fee has to come from that wallet so it can be matched to your order.', reply_markup: SALES_CANCEL_KB };
    }
    const camp = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, wiz.campaignId)).get().catch(() => null);
    if (!camp) return { text: 'That quote is gone — start again and I\'ll re-quote you.', reply_markup: SALES_CANCEL_KB };
    const feeAddress = await airdropFeePayAddress().catch(() => '');
    const payLines = airdropFeePayLines(camp.serviceFeeUsd, feeAddress).join('\n');
    if (!payLines) return { text: 'That quote is gone — start again and I\'ll re-quote you.', reply_markup: SALES_CANCEL_KB };
    return { text: `${payLines}\n\nTap "I paid" after you send it — I check the chain and confirm it.`, reply_markup: salesPayKb() };
  }
  const camp = await db.select().from(boost_campaigns).where(eq(boost_campaigns.id, wiz.campaignId)).get().catch(() => null);
  if (!camp?.depositAddress) return { text: 'That quote is gone — start again and I\'ll re-quote you.', reply_markup: SALES_CANCEL_KB };
  const text = [
    'Send the deposit to this address — one transfer, from any wallet:',
    '',
    `${SALES_NATIVE[camp.chain] ?? ''} ${camp.chain === 'sol' ? 'on Solana' : camp.chain === 'rh' ? 'on Robinhood Chain' : 'on Base'}: ${camp.depositAddress}`,
    `Amount: ${camp.totalDueNative} ${SALES_NATIVE[camp.chain] ?? ''} (≈ $${camp.totalDueUsd})`,
    `Campaign: ${camp.id}`,
    '',
    'Tap "I paid" after you send it — I check the deposit and confirm it. The platform fee is part of this deposit; the rest is your working capital and network reserve.',
  ].join('\n');
  return { text, reply_markup: salesPayKb() };
}

async function salesCancel(userId, wiz) {
  await clearSalesWizard(userId);
  if (wiz?.saleId) await setSaleStatus(wiz.saleId, 'declined');
  await sendSafe(userId, 'No problem — that\'s cancelled. Message me again any time you want to pick it back up.');
  return true;
}

/**
 * Pend an off-schedule ask to the owner: sales row -> pending_owner, owner
 * DM with the ask + proposed terms + Confirm/Decline buttons. The prospect
 * is told Rowdy will message with terms. Confirm = owner takes over (the
 * leg never prices custom work itself).
 */
export async function salesPendToOwner(userId, wiz, ask) {
  const specHash = await salesSpecHash(userId, wiz.service ?? 'other', {
    tokenCa: wiz.tokenCa ?? '', chain: wiz.chain ?? '', amountPerWallet: wiz.amountPerWallet ?? '',
    capitalUsd: wiz.capitalUsd ?? '', mode: wiz.service ?? '', refundAddress: wiz.refundAddress ?? '',
    addressesInput: ask,
  });
  const sale = await createSaleRow(userId, wiz.leadId ?? null, wiz.service ?? 'other', 'airdrop', '0', specHash);
  if (sale) await setSaleStatus(sale.id, 'pending_owner');
  await setSalesWizard(userId, { ...wiz, stage: 'pending_owner', saleId: sale?.id ?? null });
  await sendSafe(userId, 'That\'s a custom ask — checking with the owner. He\'ll message you with terms.');
  const ownerText = [
    'Custom sales ask — needs your call:',
    '',
    `Prospect: ${userId}`,
    `Service: ${SALES_SERVICE_LABELS[wiz.service] ?? wiz.service ?? 'other'}`,
    `Chain: ${wiz.chain ?? '-'}`,
    `Token: ${wiz.tokenCa ?? '-'}`,
    `Ask: ${ask}`,
    `Sale #S-${sale?.id ?? '?'}`,
    '',
    'Confirm = you take it over (I tell them you\'ll message with terms). Decline = plain refusal.',
  ].join('\n');
  const kb = { inline_keyboard: [[
    { text: '✅ Confirm — I\'ll take it', callback_data: `sales:owner:yes:${sale?.id ?? 0}` },
    { text: '❌ Decline', callback_data: `sales:owner:no:${sale?.id ?? 0}` },
  ]] };
  for (const ownerId of ownerIdSet()) {
    await sendSafe(ownerId, ownerText, { reply_markup: kb }).catch(() => {});
  }
  return true;
}

/**
 * The qualify stage machine. Consumes the prospect's text while a sales
 * wizard is live; returns true when the message was handled. Every stage
 * refuses /-commands (so /cancel and friends still route elsewhere) and
 * never claims a payment without a rail confirmation.
 */
export async function handleSalesWizardText(userId, text, from) {
  if (!userId || !text || String(text).startsWith('/')) return false;
  const wiz = await loadSalesWizard(userId);
  if (!wiz) return false;
  const clean = String(text).trim();

  if (['service', 'chain', 'quote', 'pay', 'pending_owner'].includes(wiz.stage)) {
    await salesReprompt(userId, wiz);
    return true;
  }

  if (wiz.stage === 'token') {
    const isEvm = wiz.chain === 'base' || wiz.chain === 'rh';
    const ok = isEvm ? await isValidEvmAddress(clean) : await isValidSolAddress(clean);
    if (!ok) {
      await sendSafe(userId, `That doesn't look like a valid ${SALES_CHAIN_LABELS[wiz.chain] ?? wiz.chain} address — send the token contract/mint address.`);
      return true;
    }
    const tokenCa = isEvm ? normalizeEvmAddress(clean) : clean;
    const next = { ...wiz, tokenCa };
    if (wiz.service === 'airdrop_custom') {
      await setSalesWizard(userId, { ...next, stage: 'amount' });
      await sendSafe(userId, 'How many tokens should each wallet receive? (e.g. 1000)', { reply_markup: SALES_CANCEL_KB });
    } else {
      await setSalesWizard(userId, { ...next, stage: 'capital' });
      await sendSafe(userId, 'Send your working capital in USD (e.g. 500). This is your money — it funds the cycles, and the unused part comes back to your refund address.', { reply_markup: SALES_CANCEL_KB });
    }
    return true;
  }

  if (wiz.stage === 'amount') {
    const n = Number(clean.replace(/[$,]/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      await sendSafe(userId, 'Send a number above zero for the tokens per wallet (e.g. 1000).');
      return true;
    }
    await setSalesWizard(userId, { ...wiz, amountPerWallet: n, stage: 'wallets', addressesInput: wiz.addressesInput ?? '', addressesList: wiz.addressesList ?? [] });
    await sendSafe(userId, 'Paste your recipient wallets — one per line, comma-separated, or a CSV with an address column. You can send several messages; they accumulate. Send DONE when finished (CANCEL to stop).', { reply_markup: SALES_CANCEL_KB });
    return true;
  }

  if (wiz.stage === 'wallets') {
    if (/^done$/i.test(clean)) {
      const list = wiz.addressesList ?? [];
      if (!list.length) {
        await sendSafe(userId, 'Send at least one wallet first — paste your recipient wallets, then DONE.');
        return true;
      }
      let validated;
      try { validated = validateWalletInput(wiz.chain, list.join('\n')); } catch (err) {
        await sendSafe(userId, `That list didn't parse — ${err?.message ?? 'check the format and paste again.'}`);
        return true;
      }
      if (!validated.addresses?.length) {
        await sendSafe(userId, 'Send at least one wallet first — paste your recipient wallets, then DONE.');
        return true;
      }
      return salesCreateAirdrop(userId, wiz, validated);
    }
    if (/^cancel$/i.test(clean)) return salesCancel(userId, wiz);
    try {
      const v = validateWalletInput(wiz.chain, clean);
      const prev = wiz.addressesList ?? [];
      const merged = [...new Set([...prev, ...v.addresses])];
      await setSalesWizard(userId, { ...wiz, addressesInput: `${String(wiz.addressesInput ?? '')}\n${clean}`, addressesList: merged });
      await sendSafe(userId, `${merged.length} wallets so far${(v.invalid?.length ?? 0) ? ` (${v.invalid.length} skipped as invalid)` : ''}. Paste more, or send DONE when finished.`, { reply_markup: SALES_CANCEL_KB });
    } catch (err) {
      await sendSafe(userId, `That batch didn't parse — ${err?.message ?? 'check the format and paste again.'}`);
    }
    return true;
  }

  if (wiz.stage === 'capital') {
    const n = Number(clean.replace(/[$,]/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      await sendSafe(userId, 'Send your working capital in USD as a number above zero (e.g. 500).');
      return true;
    }
    const next = { ...wiz, capitalUsd: n };
    if (wiz.service === 'boost_mcap') {
      await setSalesWizard(userId, { ...next, stage: 'mcap' });
      await sendSafe(userId, 'Send the target market-cap band as two USD numbers: MIN MAX (e.g. 250000 400000).', { reply_markup: SALES_CANCEL_KB });
    } else {
      await setSalesWizard(userId, { ...next, stage: 'refund' });
      await sendSafe(userId, 'Send your refund address — unused capital and reserve are swept back there after the run.', { reply_markup: SALES_CANCEL_KB });
    }
    return true;
  }

  if (wiz.stage === 'mcap') {
    const nums = clean.replace(/[$,]/g, '').split(/\s+/).map(Number);
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n) || n <= 0) || nums[0] >= nums[1]) {
      await sendSafe(userId, 'Send the band as two USD numbers with the low one first: MIN MAX (e.g. 250000 400000).');
      return true;
    }
    await setSalesWizard(userId, { ...wiz, mcapMin: nums[0], mcapMax: nums[1], stage: 'refund' });
    await sendSafe(userId, 'Send your refund address — unused capital and reserve are swept back there after the run.', { reply_markup: SALES_CANCEL_KB });
    return true;
  }

  if (wiz.stage === 'refund') {
    const isEvm = wiz.chain === 'base' || wiz.chain === 'rh';
    const ok = isEvm ? await isValidEvmAddress(clean) : await isValidSolAddress(clean);
    if (!ok) {
      await sendSafe(userId, `That doesn't look like a valid ${SALES_CHAIN_LABELS[wiz.chain] ?? wiz.chain} refund address — send it again.`);
      return true;
    }
    const refundAddress = isEvm ? normalizeEvmAddress(clean) : clean;
    return salesCreateBoost(userId, { ...wiz, refundAddress });
  }

  if (wiz.stage === 'other') {
    return salesPendToOwner(userId, wiz, clean);
  }

  await salesReprompt(userId, wiz);
  return true;
}

/**
 * "I paid" check. Never claims a payment without a rail confirmation.
 * Airdrop: re-read the campaign; campaignFeeSettled → receipt + next
 * steps; else "not confirmed yet". Booster: if already funded → receipt;
 * else call checkBoostDeposit live (it also holds trial/tier-unknown
 * deposits and never flips them) → funded / held / pending plainly.
 */
async function salesCheckPaid(userId, wiz) {
  if (!wiz.saleId || !wiz.campaignId) {
    await clearSalesWizard(userId);
    await sendSafe(userId, 'That quote is gone — start again and I\'ll re-quote you.');
    return;
  }
  if (wiz.campaignKind === 'airdrop') {
    const camp = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, wiz.campaignId)).get().catch(() => null);
    if (!camp) {
      await clearSalesWizard(userId);
      await sendSafe(userId, 'That campaign is gone — start again and I\'ll re-quote you.');
      return;
    }
    if (campaignFeeSettled(camp)) {
      await setSaleStatus(wiz.saleId, 'paid');
      await sendSalesReceipt('airdrop', wiz.campaignId, { txHash: camp.feeTxHash ?? null }).catch(() => {});
      await clearSalesWizard(userId);
      await sendSafe(userId, 'Payment confirmed — your airdrop is being set up. Your deposit wallet is open; fund it with the tokens and the drop goes out.');
    } else {
      await sendSafe(userId, 'Not confirmed yet — the watcher checks every minute. Give it a moment and tap "I paid" again.');
    }
    return;
  }
  const camp = await db.select().from(boost_campaigns).where(eq(boost_campaigns.id, wiz.campaignId)).get().catch(() => null);
  if (!camp) {
    await clearSalesWizard(userId);
    await sendSafe(userId, 'That campaign is gone — start again and I\'ll re-quote you.');
    return;
  }
  if (camp.status === 'funded') {
    await setSaleStatus(wiz.saleId, 'paid');
    await sendSalesReceipt('boost', wiz.campaignId, {}).catch(() => {});
    await clearSalesWizard(userId);
    await sendSafe(userId, 'Deposit confirmed — your boost is funded and queued to run.');
    return;
  }
  let outcome;
  try { outcome = await checkBoostDeposit(camp, {}); }
  catch (err) {
    await sendSafe(userId, `That check hit a snag — ${err?.message ?? 'try again in a moment.'}`);
    return;
  }
  if (outcome?.funded) {
    await setSaleStatus(wiz.saleId, 'paid');
    await sendSalesReceipt('boost', wiz.campaignId, {}).catch(() => {});
    await clearSalesWizard(userId);
    await sendSafe(userId, 'Deposit confirmed — your boost is funded and queued to run.');
  } else if (outcome?.held) {
    await sendSafe(userId, 'Trial users can\'t run Booster yet — upgrade to the PB Plan and tap "I paid" again.');
  } else {
    await sendSafe(userId, 'Not funded yet — the deposit hasn\'t landed. Check the amount and address, then tap "I paid" again.');
  }
}

/**
 * Callback router for the sales leg (data `sales:*`). Called from
 * handlers/callback_query.js after the fb: branch. Handles service pick,
 * chain pick, Confirm (gate → accept → pay presentation), "I paid",
 * Cancel, and the owner Confirm/Decline pend taps.
 */
export async function handleSalesCallback(cb) {
  const userId = cb?.from?.id;
  const data = String(cb?.data ?? '');
  const parts = data.split(':');
  const kind = parts[1];

  if (kind === 'cancel') {
    const wiz = await loadSalesWizard(userId);
    await salesCancel(userId, wiz ?? {});
    return true;
  }

  if (kind === 'owner') {
    const verdict = parts[2];
    const saleId = Number(parts[3] ?? 0);
    if (!isOwnerId(userId)) return true;
    const row = saleId ? await db.select().from(sales).where(eq(sales.id, saleId)).get().catch(() => null) : null;
    if (!row) return true;
    if (row.status === 'expired' || (row.status === 'pending_owner' && Date.now() - new Date(row.updatedAt ?? 0).getTime() > SALES_OWNER_PEND_TTL_MS)) {
      await setSaleStatus(saleId, 'declined');
      await clearSalesWizard(row.buyerTelegramId);
      await sendSafe(row.buyerTelegramId, 'That ask timed out — message me again and we\'ll start fresh.');
      await sendSafe(userId, 'That pend expired — the prospect was told to start fresh.');
      return true;
    }
    await clearSalesWizard(row.buyerTelegramId);
    if (verdict === 'yes') {
      await setSaleStatus(saleId, 'declined');
      await sendSafe(row.buyerTelegramId, 'Rowdy will message you directly with terms.');
      await sendSafe(userId, `Sale #S-${saleId}: confirmed — take it over in the prospect's DM.`);
    } else {
      await setSaleStatus(saleId, 'declined');
      await sendSafe(row.buyerTelegramId, 'That\'s not something we can do — thanks for asking.');
      await sendSafe(userId, `Sale #S-${saleId}: declined — the prospect was told plainly.`);
    }
    return true;
  }

  const wiz = await loadSalesWizard(userId);
  if (!wiz) return false;

  if (kind === 'svc') {
    let svc = parts[2];
    if (svc === 'airdrop') svc = 'airdrop_custom';
    if (svc === 'other') {
      await setSalesWizard(userId, { ...wiz, stage: 'other', service: 'other' });
      await sendSafe(userId, 'Tell me what you need in one message — I\'ll check with the owner.', { reply_markup: SALES_CANCEL_KB });
      return true;
    }
    if (!['airdrop_custom', 'boost_volume', 'boost_bump', 'boost_mcap'].includes(svc)) return true;
    if (svc.startsWith('boost')) {
      let tier = null;
      try { tier = await getUserTier(userId); } catch { tier = null; }
      if (String(tier ?? '').toLowerCase().trim() === 'trial') {
        await clearSalesWizard(userId);
        await sendSafe(userId, 'Trial users can\'t run Booster yet — upgrade to the PB Plan and come back.');
        return true;
      }
    }
    const next = { ...wiz, service: svc };
    if (svc === 'airdrop_custom') {
      await salesAskChain(userId, next);
    } else if (svc === 'boost_bump') {
      const packs = Object.keys(BUMP_PACKAGES ?? {});
      const rows = packs.map((p) => [{ text: `⚡ Bump ${BUMP_PACKAGES[p].label} — $${BUMP_PACKAGES[p].platformFeeUsd}`, callback_data: `sales:bump:${p}` }]);
      rows.push([{ text: '❌ Cancel', callback_data: 'sales:cancel' }]);
      await setSalesWizard(userId, { ...next, stage: 'bump' });
      await sendSafe(userId, 'Pick a Bump pack — one buy per wallet, over the window:', { reply_markup: { inline_keyboard: rows } });
    } else {
      await salesAskChain(userId, next);
    }
    return true;
  }

  if (kind === 'bump') {
    const pack = parts[2];
    if (!BUMP_PACKAGES?.[pack]) return true;
    await salesAskChain(userId, { ...wiz, bumpPackage: pack });
    return true;
  }

  if (kind === 'chain') {
    const chain = parts[2];
    if (!['base', 'sol', 'rh'].includes(chain)) return true;
    if (wiz.service === 'airdrop_custom' && !(await isAirdropChainEnabled(chain).catch(() => false))) {
      await sendSafe(userId, `Airdrops aren't open on ${SALES_CHAIN_LABELS[chain]} right now — pick another chain.`, { reply_markup: (await salesChainKb('airdrop')) });
      return true;
    }
    const label = SALES_CHAIN_LABELS[chain];
    const addrLabel = chain === 'sol' ? 'token mint address' : 'token contract address';
    await setSalesWizard(userId, { ...wiz, chain, stage: 'token' });
    await sendSafe(userId, `Send the ${addrLabel} on ${label}.`, { reply_markup: SALES_CANCEL_KB });
    return true;
  }

  if (kind === 'confirm') {
    if (!wiz.saleId || !wiz.campaignId) return true;
    if (wiz.stage === 'pay') {
      // Already confirmed — a stale Confirm tap re-presents the pay
      // lines instead of erroring or going silent.
      const pres = await salesPayPresentation(userId, wiz);
      await sendSafe(userId, pres.text, { reply_markup: pres.reply_markup });
      return true;
    }
    if (wiz.stage !== 'quote') return true;
    if (wiz.blocked) {
      await sendSafe(userId, 'This quote cannot be accepted as shown — tap Cancel and start again with a different refund address.');
      return true;
    }
    if (!await isSalesLegLive()) {
      await setSaleStatus(wiz.saleId, 'awaiting_payment');
      await setSalesWizard(userId, { ...wiz, stage: 'pay' });
      await sendSafe(userId, SALES_GATE_CLOSED_TEXT, { reply_markup: SALES_CANCEL_KB });
      return true;
    }
    if (wiz.campaignKind === 'boost') {
      const camp = await db.select().from(boost_campaigns).where(eq(boost_campaigns.id, wiz.campaignId)).get().catch(() => null);
      if (camp && camp.status !== 'quoted') {
        if (camp.status === 'deposit_pending' || camp.status === 'deposit_generating') {
          await setSaleStatus(wiz.saleId, 'awaiting_payment');
          await setSalesWizard(userId, { ...wiz, stage: 'pay' });
          const pres = await salesPayPresentation(userId, wiz);
          await sendSafe(userId, pres.text, { reply_markup: pres.reply_markup });
          return true;
        }
        await sendSafe(userId, `That quote is no longer open — the campaign is ${String(camp.status).replace(/_/g, ' ')}. Start again and I'll re-quote you.`);
        return true;
      }
      const accepted = await acceptBoostQuote(userId, wiz.campaignId).catch((err) => ({ error: err?.message ?? 'try again in a moment.' }));
      if (accepted?.error) {
        // Fast double-tap: the first tap already accepted — re-read and
        // re-present instead of erroring on the state change.
        const campNow = await db.select().from(boost_campaigns).where(eq(boost_campaigns.id, wiz.campaignId)).get().catch(() => null);
        if (campNow && (campNow.status === 'deposit_pending' || campNow.status === 'deposit_generating')) {
          await setSaleStatus(wiz.saleId, 'awaiting_payment');
          await setSalesWizard(userId, { ...wiz, stage: 'pay' });
          const pres = await salesPayPresentation(userId, wiz);
          await sendSafe(userId, pres.text, { reply_markup: pres.reply_markup });
          return true;
        }
        await sendSafe(userId, `That couldn't be accepted — ${accepted.error}`);
        return true;
      }
    } else {
      const saleRow = wiz.saleId ? await db.select().from(sales).where(eq(sales.id, wiz.saleId)).get().catch(() => null) : null;
      if (saleRow?.status === 'awaiting_payment') {
        await setSalesWizard(userId, { ...wiz, stage: 'pay' });
        const pres = await salesPayPresentation(userId, wiz);
        await sendSafe(userId, pres.text, { reply_markup: pres.reply_markup });
        return true;
      }
    }
    await setSaleStatus(wiz.saleId, 'awaiting_payment');
    await setSalesWizard(userId, { ...wiz, stage: 'pay' });
    const pres = await salesPayPresentation(userId, wiz);
    await sendSafe(userId, pres.text, { reply_markup: pres.reply_markup });
    return true;
  }

  if (kind === 'paid') {
    if (wiz.stage !== 'pay') return true;
    await salesCheckPaid(userId, wiz);
    return true;
  }

  return false;
}

/** DM-text entry: buying intent + lead match → start qualify, consume. */
export async function maybeStartSalesFromText(userId, text, from) {
  if (!userId || !text || String(text).startsWith('/')) return false;
  if (!isSalesIntent(text)) return false;
  const lead = await findSalesLead(userId, from).catch(() => null);
  if (!lead) return false;
  const started = await startSalesWizard(userId, from, lead);
  if (!started.ok) {
    if (started.text) await sendSafe(userId, started.text);
    return true;
  }
  await sendSafe(userId, started.text, started.reply_markup ? { reply_markup: started.reply_markup } : undefined);
  return true;
}

/** Command entry: /airdrop or /boost in a DM from a lead-matched sender. */
export async function maybeStartSalesForCommand(userId, cmd, from) {
  if (!userId || (cmd !== 'airdrop' && cmd !== 'boost')) return false;
  const lead = await findSalesLead(userId, from).catch(() => null);
  if (!lead) return false;
  const started = await startSalesWizard(userId, from, lead);
  if (!started.ok) {
    if (started.text) await sendSafe(userId, started.text);
    return true;
  }
  await sendSafe(userId, started.text, started.reply_markup ? { reply_markup: started.reply_markup } : undefined);
  return true;
}

// ── Website builder v1 (2026-11-05, Rowdy: build a website builder) ────────
// Entry: /site in a DM. v1 is OWNER-ONLY (Rowdy) — no checkout, no prices,
// no public creation (spec §7 decisions still gate public creation).
// Wizard state lives in config (same pattern as feedback/sales wizards):
// sitewiz:<userId> JSON { awaiting, template?, data?, createdAt }, 30-min TTL.
// Flow: template pick → slug → interview (text steps) → brain copy (one
// askBrain call, fallback to buyer words) → accent pick → review → publish.
// Publish writes the bundle to pb_sites + pb_site_files (status
// pending_deploy); the VM-side deploy runner picks it up and the live URL
// lands in pb_sites + /mysites. Template-only: no raw HTML/JS injection,
// ever — the generator escapes every buyer value. User text is always sent
// PLAIN (no parse_mode). Never throws into the caller.

const SITE_WIZ_TTL_MS = 30 * 60 * 1000;
const SITE_TEXT_MAX = 1000;
const SITE_LINKS_MAX = 8;

const siteWizKey = (userId) => `sitewiz:${userId}`;

async function setSiteWizard(userId, state) {
  await setConfig(siteWizKey(userId), JSON.stringify({ ...state, createdAt: Date.now() })).catch(() => {});
}

async function clearSiteWizard(userId) {
  await setConfig(siteWizKey(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

async function loadSiteWizard(userId) {
  try {
    const raw = await getConfig(siteWizKey(userId), null);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w?.awaiting || Date.now() - (w.createdAt ?? 0) > SITE_WIZ_TTL_MS) return null;
    return w;
  } catch { return null; }
}

// Test seam (same convention as __xloopTest / __agentLoopTest): the
// harness overrides the contract-check fetch; production uses sdk fetch.
let siteContractFetch = fetch;
export const __siteTest = {
  setContractFetch(fn) { siteContractFetch = fn; },
  resetContractFetch() { siteContractFetch = fetch; },
};

const SITE_CANCEL_ROW = [[{ text: '❌ Cancel', callback_data: 'site:cancel' }]];

function siteTemplateKeyboard() {
  return { inline_keyboard: [
    [{ text: SITE_TEMPLATES.t1_launch.label, callback_data: 'site:tpl:t1_launch' }],
    [{ text: SITE_TEMPLATES.t5_links.label, callback_data: 'site:tpl:t5_links' }],
    [{ text: '❌ Cancel', callback_data: 'site:cancel' }],
  ] };
}

function siteAccentKeyboard() {
  const rows = [Object.keys(SITE_ACCENTS).map((a) => ({ text: a, callback_data: `site:accent:${a}` }))];
  rows.push([{ text: '❌ Cancel', callback_data: 'site:cancel' }]);
  return { inline_keyboard: rows };
}

/** Parse brain copy text into { headline, about }. Loose on purpose. */
export function parseSiteCopy(raw) {
  const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const headline = lines[0].replace(/^#+\s*/, '').slice(0, 200);
  const about = lines.slice(1).join(' ').slice(0, 500) || null;
  return { headline, about };
}

/** One brain call for site copy; null on any failure (caller falls back). */
async function siteBrainCopy(template, data) {
  const desc = template === 't1_launch'
    ? `Token project ${data.name ?? ''}: ${data.tagline ?? ''}. Contract ${data.contract ?? ''}.`
    : `Link page titled ${data.title ?? ''}: ${data.tagline ?? ''}.`;
  try {
    const out = await askBrain(
      `Write short website copy for this project. First line: a punchy hero headline (max 12 words). Then 1-2 short sentences for an About blurb. Plain text only, no hashtags, no invented facts, no metrics.\n\n${desc}`,
      { systemPromptOverride: 'You write short, honest website copy. Never invent features, metrics, partnerships, or prices. Plain text only.' },
    );
    if (typeof out !== 'string' || !out.trim()) return null;
    return parseSiteCopy(out);
  } catch { return null; }
}

function parseLinkLines(text) {
  const links = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.split('|');
    if (m.length < 2) continue;
    const label = m[0].trim().slice(0, 40);
    const url = m[1].trim();
    if (label && url) links.push({ label, url });
    if (links.length >= SITE_LINKS_MAX) break;
  }
  return links;
}

function siteReviewText(wiz) {
  const d = wiz.data ?? {};
  const url = `https://${wiz.slug}.pages.dev`;
  const lines = [
    '🌐 <b>Review your site</b>',
    '',
    `Template: <b>${escHtml(SITE_TEMPLATES[wiz.template]?.label ?? wiz.template)}</b>`,
    `URL: <b>${url}</b>`,
    `Title: <b>${escHtml(d.title ?? d.name ?? '')}</b>`,
    d.contract ? `Contract: <code>${escHtml(d.contract)}</code>` : null,
    d.links ? `Links: <b>${(Array.isArray(d.links) ? d.links.length : Object.keys(d.links).length) || 0}</b>` : null,
    `Accent: <b>${d.accent ?? 'gold'}</b>`,
    '',
    'Publishing deploys this to Cloudflare Pages on PB’s account. You own the content; export anytime.',
  ].filter((l) => l !== null);
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Publish it', callback_data: 'site:publish' }],
      [{ text: '❌ Cancel', callback_data: 'site:cancel' }],
    ] },
  };
}

/** Command entry: /site in a DM. Owner-only in v1. */
export async function maybeStartSiteForCommand(userId, cmd, from) {
  if (!userId || cmd !== 'site') return false;
  if (!(await isOwnerId(userId))) {
    await sendSafe(userId, '🌐 The website builder is in testing right now — it opens up soon. Watch this space.');
    return true;
  }
  await setSiteWizard(userId, { awaiting: 'template', data: {} });
  await sendSafe(userId,
    '🌐 <b>Build a website</b>\n\nTell me what it’s for and I’ll build it — no code, no dashboard. Pick a template to start:',
    { parse_mode: 'HTML', reply_markup: siteTemplateKeyboard() });
  return true;
}

/** /mysites: list the caller's sites with status + live URL. DM-only. */
export async function listMySitesText(userId) {
  const sites = await listOwnedSites(userId);
  if (!sites.length) return '🌐 No sites yet — run /site to build your first one.';
  const rows = sites.map((s) => {
    const url = s.pagesUrl ? `\n🔗 ${escHtml(s.pagesUrl)}` : '';
    return `• <b>${escHtml(s.name)}</b> (${s.template === 't1_launch' ? 'launch page' : 'link page'}) — ${escHtml(s.status)}${url}`;
  });
  return `🌐 <b>My sites</b>\n\n${rows.join('\n\n')}`;
}

export async function maybeListMySitesForCommand(userId, cmd) {
  if (!userId || cmd !== 'mysites') return false;
  await sendSafe(userId, await listMySitesText(userId), { parse_mode: 'HTML' });
  return true;
}

/** Callback entry: site:tpl:* / site:accent:* / site:publish / site:cancel. */
export async function handleSiteCallback(cb) {
  const { data, from, chatId } = cb ?? {};
  const userId = from?.id;
  if (!userId || !data || !data.startsWith('site:')) return false;
  const parts = data.split(':');
  const action = parts[1] ?? '';
  if (action === 'cancel') {
    await clearSiteWizard(userId);
    await sendSafe(chatId, '🌐 Site build cancelled — nothing was published. Run /site to start again.');
    return true;
  }
  const wiz = await loadSiteWizard(userId);
  if (!wiz) {
    await sendSafe(chatId, '🌐 That build expired — run /site to start again.');
    return true;
  }
  if (action === 'tpl') {
    const tpl = parts[2] ?? '';
    if (!SITE_TEMPLATES[tpl]) return true;
    await setSiteWizard(userId, { ...wiz, template: tpl, awaiting: 'slug' });
    await sendSafe(chatId,
      `🌐 <b>${escHtml(SITE_TEMPLATES[tpl].label)}</b>\n\n${escHtml(SITE_TEMPLATES[tpl].blurb)}\n\nWhat should the site’s address be? Send a slug — lowercase letters, numbers and dashes, 3–32 characters (it becomes https://your-slug.pages.dev).`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: SITE_CANCEL_ROW } });
    return true;
  }
  if (action === 'accent') {
    const accent = parts[2] ?? '';
    if (!SITE_ACCENTS[accent]) return true;
    wiz.data.accent = accent;
    await setSiteWizard(userId, { ...wiz, awaiting: 'review' });
    const review = siteReviewText(wiz);
    await sendSafe(chatId, review.text, { parse_mode: 'HTML', reply_markup: review.reply_markup });
    return true;
  }
  if (action === 'publish') {
    if (wiz.awaiting !== 'review') return true;
    const d = wiz.data ?? {};
    let bundle;
    try {
      bundle = buildSiteBundle(wiz.template, d);
    } catch (err) {
      await sendSafe(chatId, `❌ Couldn’t build that site: ${String(err?.message ?? 'bad input')}`);
      return true;
    }
    try {
      const row = await createSite({
        ownerTgId: userId, slug: wiz.slug, template: wiz.template,
        name: d.title ?? d.name ?? wiz.slug, data: d,
      });
      if (!row) throw new Error('no row');
      await saveSiteFiles(row.id, bundle.files);
      await setSiteStatus(row.id, 'pending_deploy');
      await clearSiteWizard(userId);
      await sendSafe(chatId,
        `🌐 Queued for deploy — <b>${escHtml(d.title ?? d.name ?? wiz.slug)}</b> is building now.\n\nI’ll send you the live URL once it’s up. Check /mysites anytime.`,
        { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[site publish]', err?.message ?? err);
      await sendSafe(chatId, '❌ That didn’t save — try publishing again in a moment.');
    }
    return true;
  }
  return true;
}

/**
 * Text-step capture. Returns true when the message was consumed as wizard
 * input (caller stops routing). Only fires while a text step is armed;
 * commands always bypass (caller checks '/').
 */
export async function handleSiteWizardText(userId, text, from) {
  if (!userId || !text || text.startsWith('/')) return false;
  const wiz = await loadSiteWizard(userId);
  if (!wiz || !wiz.awaiting) return false;
  if (wiz.awaiting === 'template' || wiz.awaiting === 'accent' || wiz.awaiting === 'review') return false;
  const clean = String(text).trim();
  const d = wiz.data ?? {};
  const cancelRow = { reply_markup: { inline_keyboard: SITE_CANCEL_ROW } };

  if (wiz.awaiting === 'slug') {
    if (!clean) { await sendSafe(userId, 'Send a slug — lowercase letters, numbers and dashes.', cancelRow); return true; }
    const v = validateSlug(clean);
    if (!v.ok) { await sendSafe(userId, `⚠️ ${v.reason} Try another slug.`, cancelRow); return true; }
    const taken = await getSiteBySlug(v.slug).catch(() => null);
    if (taken) { await sendSafe(userId, `⚠️ “${v.slug}” is already taken — try another slug (e.g. ${v.slug}-2).`, cancelRow); return true; }
    wiz.slug = v.slug;
    await setSiteWizard(userId, { ...wiz, awaiting: wiz.template === 't1_launch' ? 'name' : 'title' });
    await sendSafe(userId,
      wiz.template === 't1_launch'
        ? '🚀 What’s the token/project called? Send the name (e.g. PoorBoyAI).'
        : '🔗 What’s the page called? Send a title (e.g. My links).',
      cancelRow);
    return true;
  }

  if (wiz.awaiting === 'name' || wiz.awaiting === 'title') {
    if (!clean) { await sendSafe(userId, 'Send a little more than that — one message with the name.', cancelRow); return true; }
    if (clean.length > 100) { await sendSafe(userId, 'That ran long — send it shorter (100 characters max).', cancelRow); return true; }
    if (wiz.template === 't1_launch') d.name = clean.slice(0, 80); else d.title = clean.slice(0, 80);
    await setSiteWizard(userId, { ...wiz, awaiting: 'tagline' });
    await sendSafe(userId, '💬 One line that describes it — what does it do? (Send “skip” to leave it blank.)', cancelRow);
    return true;
  }

  if (wiz.awaiting === 'tagline') {
    d.tagline = clean.toLowerCase() === 'skip' ? '' : clean.slice(0, 200);
    await setSiteWizard(userId, { ...wiz, awaiting: wiz.template === 't1_launch' ? 'contract' : 'links' });
    await sendSafe(userId,
      wiz.template === 't1_launch'
        ? '📜 Paste the token contract address (0x + 40 hex). I’ll check it’s real before we publish.'
        : '🔗 Send your links — one per line, like this:\nX | https://x.com/yourhandle\nTelegram | https://t.me/yourgroup\n(Up to 8 links.)',
      cancelRow);
    return true;
  }

  if (wiz.awaiting === 'contract') {
    if (!isValidContract(clean)) {
      await sendSafe(userId, '⚠️ That doesn’t look like a contract address (0x + 40 hex). Paste it again.', cancelRow);
      return true;
    }
    const check = await verifyContractLive(clean.trim(), siteContractFetch);
    if (!check.verified && !check.providerDown) {
      await sendSafe(userId, '⚠️ I couldn’t find that contract on DexScreener or GeckoTerminal — double-check the address and paste it again.', cancelRow);
      return true;
    }
    d.contract = clean.trim();
    if (check.verified && check.symbol) d.symbol = check.symbol;
    if (check.providerDown) {
      await sendSafe(userId, '⚠️ Neither price provider answered just now, so I couldn’t verify the contract live — I’ll go with the address as given. Send “skip” for tokenomics, or send supply and tax like: 1000000000, 0%');
    } else {
      await sendSafe(userId, '✅ Contract checks out. Send tokenomics — supply and tax, like: 1000000000, 0% (or “skip”).', cancelRow);
    }
    await setSiteWizard(userId, { ...wiz, awaiting: 'tokenomics' });
    return true;
  }

  if (wiz.awaiting === 'tokenomics') {
    if (clean.toLowerCase() !== 'skip') {
      const [supply, tax] = clean.split(',').map((s) => s.trim());
      d.tokenomics = { supply: (supply ?? '').slice(0, 40) || null, tax: (tax ?? '').slice(0, 20) || null };
    } else d.tokenomics = {};
    await setSiteWizard(userId, { ...wiz, awaiting: 'links' });
    await sendSafe(userId,
      '🔗 Send your links — one per line, like this:\nBuy | https://...\nChart | https://...\nX | https://x.com/...\nTelegram | https://t.me/...\n(Labels Buy, Chart, X, Telegram, Website — up to 8.)',
      cancelRow);
    return true;
  }

  if (wiz.awaiting === 'links') {
    const parsed = parseLinkLines(clean);
    if (!parsed.length) {
      await sendSafe(userId, '⚠️ I didn’t get any links — send them one per line, “Label | https://...”.', cancelRow);
      return true;
    }
    const bad = parsed.filter((l) => !isValidHttpsUrl(l.url));
    if (bad.length) {
      await sendSafe(userId, `⚠️ These links don’t look right (need https, no shorteners): ${bad.map((l) => l.label).join(', ')}. Send the list again.`, cancelRow);
      return true;
    }
    if (wiz.template === 't1_launch') {
      const byLabel = {};
      for (const l of parsed) byLabel[l.label.trim().toLowerCase()] = l.url;
      d.links = {
        buy: byLabel.buy ?? null, chart: byLabel.chart ?? null,
        x: byLabel.x ?? null, telegram: byLabel.telegram ?? null,
        website: byLabel.website ?? null,
      };
    } else {
      d.links = parsed;
    }
    // Brain copy (one call, fail-open to buyer words), then accent pick.
    const copy = await siteBrainCopy(wiz.template, d);
    if (copy) d.copy = copy;
    await setSiteWizard(userId, { ...wiz, awaiting: 'accent' });
    await sendSafe(userId, '🎨 Pick an accent color for the site:', { reply_markup: siteAccentKeyboard() });
    return true;
  }

  return false;
}
