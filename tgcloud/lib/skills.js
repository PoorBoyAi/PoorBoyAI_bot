// lib/skills.js — PB's skills registry (brain + skills + agents, Phase 2).
//
// A skill is a named, self-contained capability: { name, describe(), run }.
// run(ctx, args) takes ctx = { from, chatId, chatType } (the Telegram caller
// and where they're asking from) and returns a uniform result:
//   { ok, text, data?, gated? }
// `text` is always a user-ready plain-English answer, including on failure —
// skills never throw at their callers. The brain layer, the plain-English
// command layer (lib/nlcmd.js), and future surfaces (Mini App, MCP, Discord)
// all call skills through this one registry, so a capability is written once
// and works everywhere.
//
// Rules observed: try/catch only (no .catch() on query builders), fetch via
// lib/market.js (which imports it from 'sdk'), no AbortController/setTimeout.

import { api, fetch } from 'sdk';
import db, { eq, desc, sql, and } from 'sdk/db';
import { bot_users, raid_xp, raid_queue, raid_sessions, known_groups, credit_ledger } from '../schema.js';
import { askBrain } from './brain.js';
import { getConfig, setConfig } from './config.js';
import { getGroupSettings, isOwnerId } from './groups.js';
import { fetchTokenByAddress, searchToken, priceCard, fmt$, fmtPct, fmtLargeUsd, groundingBlock, GROUNDING_RULE } from './market.js';
import { effectiveTier, generatePost, POST_HEADERS, shillShareKeyboard } from './posts.js';
import { canonicalTier, tierAtLeast, aiCommandAllowance, referralBonus } from './tiers.js';
import { fetchOHLCV, taCard, rsi, macd, bollinger } from './ta.js';
import { rsiText, macdText, bollingerText } from './taindicators.js';
import { ethBalance, erc20BalanceRaw, checkPbai, getUserWallets, listPriceAlerts } from './accounts.js';
import { fetchVerdict, sendPriceCard, sendTaCard, sendRankCard } from './verdict.js';
import { pointsTextFor, pointsRankGroupTextFor, statsTextFor, moonitGateTextFor, pickMoonCaption } from './statscmds.js';
import { myWalletTextFor, myWatchedTextFor } from './walletcmds.js';
import { buildInvitePanel } from './referrals.js';
import { getUserSquad, squadMembers, listSquads } from './squads.js';
import { getPBRank, PB_RANKS, rankIndexOf } from './xp.js';
import { contestStatusFor } from './contests.js';
import { gemsTextFor } from './opscmds.js';
import { buildDigest } from './digest.js';
import { businessSettingsView } from './business.js';
import { campaignSummaryText, campaignGateText } from './campaigns.js';
import getRaidBoard from '../endpoints/getRaidBoard.js';
import getGlobalBoard from '../endpoints/getGlobalBoard.js';

const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── token_scan — the /analyze pipeline ───────────────────────────────────────
// Resolution + analysis were extracted from handlers/message.js (the /analyze
// command now delegates to these same functions), so the command, the NL
// layer, and every future surface run ONE pipeline. User-facing strings are
// byte-identical to the originals.

export const ANALYZE_NO_TOKEN_TEXT = [
  '📋 No featured token set for this group.',
  '',
  'Ask an admin to run /settoken <contract address> to configure the default token.',
  '',
  'You can still check any token directly:',
  '▸ /analyze BTC',
  '▸ /analyze 0x...',
  '',
  '🤖 @PoorBoyAI_bot',
].join('\n');

export const ANALYZE_FAIL_TEXT = '❌ Could not run the analysis right now. Try again in a moment.';
export const ANALYZE_GATE_TEXT = '⛔ Pro+ Required\n\n/analyze is available on Pro+ plans and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.';

const ANALYST_PROMPT = 'You are a seasoned crypto analyst who gives honest, no-nonsense analysis. Include fundamentals, risks, and sentiment. Keep it under 400 words. Format with emojis and clear sections. GROUNDING RULE: Use ONLY the numbers in the verified block for price, market cap, volume, liquidity, and percentages. Any figure not listed there — including locked %, holder counts, supply, FDV, dates, and roadmap claims — must be written as n/a or omitted entirely. Never invent a number, date, or percentage.';

/**
 * groupAwareQuery resolution (verbatim semantics from the /analyze port):
 * explicit arg wins; DM and home group fall back to $PBAI; an external group
 * without its own token set → { noToken: true }.
 * @param {string} rawArgs @param {{id?:any, type?:string}} chat
 */
export async function resolveScanTarget(rawArgs, chat) {
  const arg = (rawArgs ?? '').trim();
  const isGroup = chat?.type === 'group' || chat?.type === 'supergroup';
  let query = arg;
  if (!query && isGroup) {
    const homeId = String(await getConfig('TELEGRAM_HOME_CHAT_ID', ''));
    if (String(chat.id) !== homeId) {
      const s = await getGroupSettings(chat.id);
      if (!s?.tokenAddress) return { noToken: true };
      query = s.tokenAddress;
    }
  }
  return { query };
}

/**
 * Stats fetch + analyst brain call for an already-resolved query.
 * Returns { ok:true, text, data:{token} } or { ok:false, error, data } —
 * on brain failure the caller sends ANALYZE_FAIL_TEXT (the exact string
 * /analyze has always used), so a dead brain is honest everywhere.
 */
export async function runScanAnalysis(query) {
  const q = (query || 'PBAI').replace(/^\$/, '');
  let t = null;
  if (ADDR_RE.test(q)) {
    t = await fetchTokenByAddress(q);
  } else if (/^pbai$/i.test(q)) {
    t = await fetchTokenByAddress(PBAI_CA);
  } else {
    const found = await searchToken(q);
    if (found?.network === 'base' && found.address) t = await fetchTokenByAddress(found.address);
  }
  // FIX 2 (2026-10-29): the data block now travels with its grounding
  // rule, and missing fields render as 'n/a' (not the display '—'),
  // so the model writes n/a instead of filling gaps. When no token
  // resolved, the old bare "Token query:" line let the model invent
  // everything — now it gets the explicit no-data block.
  // NOTE: Number(null) === 0 — null/'' must be excluded explicitly,
  // otherwise a missing field renders as a fabricated-looking $0.
  const na = (v, fmt) => ((v == null || v === '' || !Number.isFinite(Number(v))) ? 'n/a' : fmt(v));
  const tokenStr = t
    ? `Token: ${t.name} ($${t.symbol})\nPrice: ${na(t.priceUsd, fmt$)}\n24h: ${na(t.change24h, fmtPct)}\nMCap: ${na(t.marketCap, fmtLargeUsd)}\nVolume: ${na(t.volume24h, fmtLargeUsd)}\nLiquidity: ${na(t.liquidity, fmtLargeUsd)}\n${GROUNDING_RULE}`
    : `Token query: ${query || 'PBAI'}\n${groundingBlock(null)}`;
  try {
    const analysis = await askBrain(`Deep analysis of this token:\n${tokenStr}`, {
      systemPromptOverride: ANALYST_PROMPT,
      maxOutputTokens: 2000,
      useKimiHeavy: true, // KIMI HEAVY (2026-11-04): deep-research heavy job; flag off => normal ladder
    });
    if (!analysis?.trim()) throw new Error('empty analysis');
    return { ok: true, text: `🔍 Token Analysis\n\n${analysis.trim().slice(0, 3800)}`, data: { token: t } };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), data: { token: t } };
  }
}

/** The /analyze tier gate as data: null when the caller may scan. Mirrors
 *  tierGate() in handlers/message.js (owner → whale via effectiveTier). */
async function analyzeGateText(from) {
  if (!from?.id) return null;
  if (await isOwnerId(from.id)) return null;
  let row = null;
  try {
    row = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(from.id))).get();
  } catch { row = null; }
  const tier = await effectiveTier(from.id, row);
  return tierAtLeast(tier, 'pro') ? null : ANALYZE_GATE_TEXT;
}

async function tokenScan(ctx, args = {}) {
  const gateText = await analyzeGateText(ctx.from);
  if (gateText) return { ok: false, gated: true, text: gateText };
  const target = await resolveScanTarget(args.query ?? args.token ?? '', { id: ctx.chatId, type: ctx.chatType });
  if (target.noToken) return { ok: false, text: ANALYZE_NO_TOKEN_TEXT };
  const out = await runScanAnalysis(target.query);
  if (!out.ok) return { ok: false, text: ANALYZE_FAIL_TEXT, data: out.data };
  return { ok: true, text: out.text, data: out.data };
}

// ── price_check — GeckoTerminal price summary (no brain) ────────────────────

async function priceCheck(ctx, args = {}) {
  const gate = await skillGateText('price_check', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  const tk = String(args.token ?? args.query ?? '').trim().replace(/^\$/, '');
  // NL callers can pass a noisy phrase ("PBAI right now") — reduce to an
  // embedded address or the head token before resolving, like /price does.
  const embedded = /0x[0-9a-fA-F]{40}/.exec(tk)?.[0] ?? null;
  const head = tk.split(/\s+/)[0] ?? '';
  let address = null;
  if (embedded) {
    address = embedded;
  } else if (!head || /^pbai$/i.test(head)) {
    // Default: the caller's group token when in a group, else $PBAI.
    if (ctx.chatType === 'group' || ctx.chatType === 'supergroup') {
      try {
        const s = await getGroupSettings(ctx.chatId);
        if (s?.tokenAddress) address = s.tokenAddress;
      } catch { /* fall back to $PBAI */ }
    }
    address = address ?? PBAI_CA;
  } else if (ADDR_RE.test(head)) {
    address = head;
  } else {
    const found = await searchToken(head);
    if (found?.network === 'base') address = found.address;
  }
  if (!address) return { ok: false, text: '⚠️ Couldn’t find that token on Base. Symbol search can miss brand-new tokens — paste the contract address (0x…) directly, or try $PBAI.' };
  const t = await fetchTokenByAddress(address);
  if (!t) return { ok: false, text: '⚠️ Could not fetch price data right now. Try again in a moment.' };
  return { ok: true, text: priceCard(t), data: t };
}

// ── community_stats — raid board numbers for one chat (no brain) ───────────

async function communityStats(ctx, args = {}) {
  let chatId = args.chatId ? String(args.chatId) : null;
  if (!chatId) {
    chatId = (ctx.chatType === 'group' || ctx.chatType === 'supergroup')
      ? String(ctx.chatId)
      : String(await getConfig('TELEGRAM_HOME_CHAT_ID', '-1003931169299'));
  }
  let title = 'the community';
  try {
    const g = await db.select().from(known_groups).where(eq(known_groups.chatId, chatId)).get();
    if (g?.title) title = g.title;
  } catch { /* keep fallback */ }

  let totalXp = 0, raiders = 0, top = [];
  try {
    const agg = await db
      .select({ total: sql`COALESCE(SUM(${raid_xp.xp}), 0)`, n: sql`COUNT(DISTINCT ${raid_xp.userId})` })
      .from(raid_xp)
      .where(sql`${raid_xp.chatId} = ${chatId} AND ${raid_xp.isDisqualified} = 0`)
      .get();
    totalXp = Number(agg?.total ?? 0);
    raiders = Number(agg?.n ?? 0);
  } catch { /* zeros stand */ }
  try {
    top = await db.select().from(raid_xp)
      .where(sql`${raid_xp.chatId} = ${chatId} AND ${raid_xp.isDisqualified} = 0`)
      .orderBy(desc(raid_xp.xp)).limit(3).all();
  } catch { top = []; }

  let queued = 0;
  try {
    const c = await db.select({ n: sql`COUNT(*)` }).from(raid_queue)
      .where(sql`${raid_queue.chatId} = ${chatId} AND ${raid_queue.status} = 'queued'`).get();
    queued = Number(c?.n ?? 0);
  } catch { /* zero stands */ }

  let live = null;
  try {
    const now = new Date();
    const rows = await db.select().from(raid_sessions)
      .where(sql`${raid_sessions.chatId} = ${chatId} AND ${raid_sessions.isActive} = 1`).all();
    const active = rows.filter((r) => !r.endsAt || new Date(r.endsAt) > now);
    if (active.length) live = active[0];
  } catch { live = null; }

  const lines = [
    `📊 ${title} — community stats`,
    '',
    `⚡ Total raid XP: ${totalXp.toLocaleString('en-US')} across ${raiders} raider${raiders === 1 ? '' : 's'}`,
  ];
  if (top.length) {
    lines.push('', '🏆 Top raiders:');
    top.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.displayName || r.username || `Raider ${r.userId}`} — ${Number(r.xp).toLocaleString('en-US')} XP`);
    });
  }
  lines.push('', `🎯 Raid queue: ${queued} lined up`);
  lines.push(live
    ? `🔴 Live now: ${live.platformEmoji ?? '⚔️'} ${live.platform ?? 'raid'} raid is running`
    : '⚪ No live raid right now');
  return { ok: true, text: lines.join('\n'), data: { chatId, totalXp, raiders, queued, live: Boolean(live) } };
}

// ── my_rank — the caller's raid standing (reuses the raid-board endpoint) ──

async function myRank(ctx) {
  const board = await getRaidBoard({}, { initData: { user: ctx.from } });
  const me = board?.me ?? null;
  if (!me) {
    return {
      ok: true,
      text: "🏅 No raid XP on the board for you yet — jump into a raid in the group and you'll show up here.",
      data: { me: null },
    };
  }
  const lines = [
    '🏅 Your raid standing — Official PoorBoyAI community',
    '',
    `Rank #${me.rank ?? '—'} · ${Number(me.xp).toLocaleString('en-US')} XP · 🔥 streak ${me.streak ?? 0}`,
  ];
  const leader = (board.leaderboard ?? [])[0];
  if (leader && me.rank === 1) {
    lines.push('', "👑 You're top of the board. Defend it.");
  } else if (leader) {
    lines.push('', `Leader: ${leader.name} — ${Number(leader.xp).toLocaleString('en-US')} XP (you're ${Math.max(0, Number(leader.xp) - Number(me.xp)).toLocaleString('en-US')} XP behind).`);
  }
  // Gap-1 rank card: the caller's registered Base wallet rides along
  // (best-effort — the card simply omits the line when there is none).
  let wallet = null;
  try { const w = await getUserWallets(ctx.from.id); wallet = w?.baseAddress ?? null; } catch { /* null stands */ }
  return { ok: true, text: lines.join('\n'), data: { me, wallet } };
}

// ── global_standings — opted-in communities (reuses the global endpoint) ───

async function globalStandings(ctx) {
  const g = await getGlobalBoard({}, { initData: { user: ctx.from } });
  const communities = [...(g?.communities ?? [])].sort((a, b) => b.totalXp - a.totalXp);
  if (!communities.length) {
    return { ok: true, text: '🌍 No communities have entered the global board yet. A group admin can opt in with /globalboard on.', data: g };
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = ['🌍 Global standings — opted-in communities', ''];
  communities.forEach((c, i) => {
    lines.push(`${medals[i] ?? `${i + 1}.`} ${c.name} — ${Number(c.totalXp).toLocaleString('en-US')} XP · ${c.raiders} raider${c.raiders === 1 ? '' : 's'} · ${c.raidsCompleted} raids done`);
  });
  const top = (g?.topRaiders ?? []).slice(0, 5);
  if (top.length) {
    lines.push('', '👑 Top raiders worldwide:');
    top.forEach((r) => {
      lines.push(`${r.rank}. ${r.name} — ${Number(r.xp).toLocaleString('en-US')} XP (${r.community})`);
    });
  }
  return { ok: true, text: lines.join('\n'), data: g };
}

// ── recap_today — deterministic daily recap, brain polish when available ───

async function recapToday(ctx, args = {}) {
  // Target group's token (group settings) or $PBAI by default.
  let address = PBAI_CA;
  const targetChat = args.chatId ?? ((ctx.chatType === 'group' || ctx.chatType === 'supergroup') ? ctx.chatId : null);
  if (targetChat) {
    try {
      const s = await getGroupSettings(targetChat);
      if (s?.tokenAddress) address = s.tokenAddress;
    } catch { /* $PBAI stands */ }
  }
  const stats = await fetchTokenByAddress(address);
  if (!stats) return { ok: false, text: '⚠️ Could not fetch market data right now. Try again in a moment.' };

  const isPbai = address.toLowerCase() === PBAI_CA;
  const name = isPbai ? 'PoorBoyAI' : (stats.name ?? 'Token');
  const symbol = isPbai ? 'PBAI' : (stats.symbol ?? 'TKN');
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const money0 = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const vol = Number(stats.volume24h || 0);
  const volStr = vol > 0 ? money0(vol) : '$0.00';
  const chg = Number(stats.change24h);
  const tape = vol <= 0
    ? 'Quiet tape today — no volume yet, and the community is still here building.'
    : chg >= 5
      ? `Green day — $${symbol} is up ${fmtPct(chg)} in 24h and the trenches are awake.`
      : chg <= -5
        ? `Red day — $${symbol} is ${fmtPct(chg)} in 24h. Shakeout weather; the builders are still here.`
        : `Steady tape — $${symbol} moving sideways (${fmtPct(chg)} 24h) while the community keeps building.`;
  const deterministic = `📋 DAILY RECAP — ${name} | ${dateStr} · 💰 $${symbol}: ${fmt$(stats.priceUsd)} · FDV ${money0(stats.fdv)} · Liquidity ${money0(stats.liquidity)} · 24h vol ${volStr} · ${tape}`;

  // Brain polish only when the brain answers; the deterministic text stands
  // otherwise (production daily_recaps stay brain-written via the tick —
  // this skill is the on-demand read, so it must never come back empty).
  let text = deterministic;
  let polished = false;
  try {
    const out = await askBrain(
      `Polish this daily recap for the ${name} community. Keep the format and every number EXACTLY as given; only improve the wording of the commentary part. Return ONLY the recap text.\n\n${deterministic}`,
      { maxOutputTokens: 400 },
    );
    if (out?.trim()) { text = out.trim().slice(0, 1000); polished = true; }
  } catch { /* deterministic stands */ }
  return { ok: true, text, data: { stats, polished } };
}

// ══ Skills expansion (2026-10-20) — 25 new skills, catalog 6 → 31 ═════════
// Design: PB-SKILLS-EXPANSION-DESIGN.md. Every gate below is copied from the
// source command's own gate (same tier set, same message) — never looser.
// Skills are read-only, caller-scoped, and never post publicly; the single
// flagged exception is holder_status mirroring /claimholder's idempotent
// self-scoped pbaiHolder flag write.

// ── Gate plumbing ────────────────────────────────────────────────────────────
// Every gate compares the caller's stored tier by CANONICAL rank via
// lib/tiers.js tierAtLeast() (O1 fix — the legacy name sets from the source
// port mis-gated canonical builder/pro/agency and collapsed chad/whale/
// dev_launch to free). Gate minimums are unchanged from the source
// commands: 'starter' / 'builder' / 'pro'.

const TIER_LABELS = {
  free: '🆓 Free', starter: '🌱 Starter', builder: '💼 Builder', pro: '⚡ Pro',
  agency: '🏢 Agency', hustler: '💼 Builder', grinder: '⚡ Pro', chad: '🏢 Agency',
  whale: '🏢 Agency', dev_launch: '🚀 Dev Launch', poor: '🆓 Free',
  one: '⭐ PB Plan', trial: '🎁 Trial',
};

/** The caller's bot_users row (null when absent/unreadable). */
async function callerUserRow(from) {
  if (!from?.id) return null;
  try {
    return await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(from.id))).get();
  } catch { return null; }
}

async function callerEffTier(from) {
  return effectiveTier(from.id, await callerUserRow(from));
}

/** tierGate()'s refusal text (handlers/message.js), byte-identical. */
function gateMsg(featureName, label) {
  return `⛔ ${label} Required\n\n/${featureName} is available on ${label} plans and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.`;
}

async function tierMinGateText(from, minTier, featureName, label) {
  const tier = await callerEffTier(from);
  return tierAtLeast(tier, minTier) ? null : gateMsg(featureName, label);
}

const BIZ_GATE_TEXT = [
  '🏢 Business Bot Setup',
  '',
  'Link your dashboard first, then activate a Starter+ plan to access Business Bot features.',
  '',
  'Use /link to connect your account.',
].join('\n');

// post_writer kinds → the post commands' own gates (handlers/message.js
// postCommand registrations): bull/bear/moon Starter+, fud/gem Builder+,
// meme/callout/alpha/nft/defi Pro+ (canonical minimums since the O1 fix).
const POST_KINDS = {
  bull: { kind: 'bullpost', label: '📈 Bull Post', minTier: 'starter', gateLabel: 'Starter+', gateSet: 'starter' },
  bear: { kind: 'bearpost', label: '🐻 Bear Slayer', minTier: 'starter', gateLabel: 'Starter+', gateSet: 'starter' },
  moon: { kind: 'moonpost', label: '🌕 Moon Post', minTier: 'starter', gateLabel: 'Starter+', gateSet: 'starter' },
  fud: { kind: 'fudpost', label: '🛡️ FUD Destroyer', minTier: 'builder', gateLabel: 'Builder+', gateSet: 'hustler' },
  gem: { kind: 'gempost', label: '💎 Gem Alert', minTier: 'builder', gateLabel: 'Builder+', gateSet: 'hustler' },
  meme: { kind: 'memepost', label: '😂 Meme Post', minTier: 'pro', gateLabel: 'Pro+', gateSet: 'grinder' },
  callout: { kind: 'callout', label: '📣 Callout Thread', minTier: 'pro', gateLabel: 'Pro+', gateSet: 'grinder' },
  alpha: { kind: 'alpha', label: '🔭 Alpha Drop', minTier: 'pro', gateLabel: 'Pro+', gateSet: 'grinder' },
  nft: { kind: 'nftpost', label: '🖼️ NFT Post', minTier: 'pro', gateLabel: 'Pro+', gateSet: 'grinder' },
  defi: { kind: 'defipost', label: '⚙️ DeFi Post', minTier: 'pro', gateLabel: 'Pro+', gateSet: 'grinder' },
};

function postKindSpec(rawKind) {
  const k = String(rawKind ?? '').trim().toLowerCase();
  if (!k) return null;
  return POST_KINDS[k] ?? POST_KINDS[k.replace(/post$/, '')] ?? null;
}

/**
 * The one gate function for the whole catalog — used by the runSkill
 * endpoint as a pre-check AND by each gated skill's run() (defense in
 * depth, one source). Returns the refusal text, or null when allowed.
 */
export async function skillGateText(name, from, args = {}) {
  if (!from?.id) return null;
  switch (name) {
    case 'token_scan':
      return analyzeGateText(from);
    case 'hot_gems':
      return tierMinGateText(from, 'builder', 'gem', 'Builder+');
    // FREE-TIER RESHAPE (Rowdy 2026-11-05): live price, TA and token-safety
    // scans leave Free — Starter+ floor, so every paid tier and trial
    // keeps them and only Free changes.
    case 'price_check':
      return tierMinGateText(from, 'starter', 'price', 'Starter+');
    case 'ta_overview':
      return tierMinGateText(from, 'starter', 'ta', 'Starter+');
    case 'rsi_check':
      return tierMinGateText(from, 'starter', 'rsi', 'Starter+');
    case 'macd_check':
      return tierMinGateText(from, 'starter', 'macd', 'Starter+');
    case 'bollinger_check':
      return tierMinGateText(from, 'starter', 'bollinger', 'Starter+');
    case 'security_scan':
      return tierMinGateText(from, 'starter', 'scan', 'Starter+');
    case 'verdict_card':
      return tierMinGateText(from, 'starter', 'scan', 'Starter+');
    case 'wallet_lookup':
      return tierMinGateText(from, 'builder', 'portfolio', 'Builder+');
    case 'debate':
      return tierMinGateText(from, 'builder', 'debate', 'Builder+');
    case 'moon_moment':
      return moonitGateTextFor(from.id);
    case 'business_status': {
      const tier = await callerEffTier(from);
      return tierAtLeast(tier, 'starter') ? null : BIZ_GATE_TEXT;
    }
    case 'my_campaign':
      // The campaigns lib is the one gate (canonical tiers, owner bypass) —
      // the skill can never disagree with the endpoints.
      return campaignGateText(from.id);
    case 'post_writer': {
      const spec = postKindSpec(args.kind);
      if (!spec) return null; // run() answers with the kind picker usage text
      return tierMinGateText(from, spec.minTier, spec.kind, spec.gateLabel);
    }
    default:
      return null;
  }
}

/** Lock computation for getSkills — same sets skillGateText enforces. */
export function gateLockedFor(gateSet, effTier) {
  switch (gateSet) {
    case 'starter': return !tierAtLeast(effTier, 'starter');
    case 'hustler': return !tierAtLeast(effTier, 'builder');
    case 'grinder': return !tierAtLeast(effTier, 'pro');
    case 'builderSet': return !tierAtLeast(effTier, 'builder');
    case 'builderCanon': return !tierAtLeast(effTier, 'builder');
    case 'perKind': return !tierAtLeast(effTier, 'starter');
    default: return false;
  }
}

/**
 * Group context for the group-shaped skills (design §6.5): explicit
 * args.chatId → the caller's own group ctx → the caller's most-active
 * group (their biggest raid_xp row) → the home group. Every group skill
 * reads exactly this one chat's rows.
 */
async function resolveGroupChatId(ctx, args = {}) {
  if (args.chatId) return String(args.chatId);
  if (ctx.chatType === 'group' || ctx.chatType === 'supergroup') return String(ctx.chatId);
  try {
    const row = await db.select().from(raid_xp)
      .where(eq(raid_xp.userId, Number(ctx.from.id)))
      .orderBy(desc(raid_xp.xp)).limit(1).get();
    if (row?.chatId) return String(row.chatId);
  } catch { /* fall through to home */ }
  return String(await getConfig('TELEGRAM_HOME_CHAT_ID', '-1003931169299'));
}

function urlButtonsOf(keyboardRows) {
  const buttons = [];
  for (const row of keyboardRows ?? []) {
    for (const b of row ?? []) {
      if (b?.url && b?.text) buttons.push({ text: b.text, url: b.url });
    }
  }
  return buttons;
}

// ── Shared command bodies (the commands delegate to these) ──────────────────

/**
 * The /scan GoPlus read as data (handlers/message.js handleScan delegates).
 * Returns { ok, text } — on failure the command's own failure text.
 */
export async function scanTextFor(address) {
  const addr = String(address ?? '').trim();
  try {
    const res = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr}`);
    if (!res.ok) throw new Error(`GoPlus ${res.status}`);
    const data = await res.json();
    const r = data?.result?.[addr.toLowerCase()] ?? data?.result?.[addr] ?? {};
    const honeypot = r.is_honeypot === '1';
    const buyTax = r.buy_tax, sellTax = r.sell_tax;
    const mintable = r.is_mintable === '1';
    const proxy = r.is_proxy === '1';
    const verdict = honeypot ? '🔴 DANGER — honeypot detected'
      : (mintable || Number(sellTax) > 10) ? '🟡 CAUTION — review flags below'
      : '🟢 LOOKS CLEAN — always DYOR';
    return {
      ok: true,
      text: [
        `🛡️ Token Scan — ${addr.slice(0, 10)}…${addr.slice(-6)} (Base)`,
        '',
        verdict,
        `🍯 Honeypot: ${honeypot ? 'YES' : 'no'}`,
        `💸 Buy tax: ${buyTax ?? 'n/a'} · Sell tax: ${sellTax ?? 'n/a'}`,
        `🖨️ Mintable: ${mintable ? 'yes' : 'no'} · Proxy: ${proxy ? 'yes' : 'no'}`,
        `👑 Owner: ${r.owner_address ? r.owner_address.slice(0, 10) + '…' : 'renounced/none'}`,
        '',
        'Not financial advice. DYOR.',
      ].join('\n'),
    };
  } catch (err) {
    console.error('[scan]', err?.message ?? err);
    return { ok: false, text: '⚠️ Scan failed right now. Try again in a moment.' };
  }
}

/**
 * The /gem DexScreener read as text (handlers/message.js gem delegates).
 * Failure returns the command's own failure text — never fabricated data.
 */
export async function hotGemsText() {
  try {
    const boostsRaw = await fetch('https://api.dexscreener.com/token-boosts/top/v1')
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=base').catch(() => null);
    const pairs = searchRes && searchRes.ok ? (await searchRes.json()).pairs ?? [] : [];
    const trending = pairs
      .filter((p) => p.chainId === 'base' && (p.liquidity?.usd ?? 0) > 5000)
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
      .slice(0, 5);
    if (!trending.length) return '⚠️ Trending tokens are unavailable right now — the market feed didn’t answer. Try again in a few minutes.';
    const lines = trending.map((t, i) => {
      const chg = Number(t.priceChange?.h24 ?? 0);
      return `${i + 1}. ${t.baseToken?.name ?? '?'} ($${t.baseToken?.symbol ?? '?'})\n   💰 $${t.priceUsd ?? '?'} | 24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% | Vol: ${fmtLargeUsd(Number(t.volume?.h24 ?? 0))}`;
    }).join('\n\n');
    let boostSection = '';
    try {
      const baseBoosts = ((boostsRaw?.data ?? boostsRaw ?? [])).filter((b) => b.chainId === 'base').slice(0, 3);
      if (baseBoosts.length) {
        const bLines = baseBoosts.map((b, i) => {
          const name = b.description?.split(/\s/)[0] ?? `${String(b.tokenAddress ?? '').slice(0, 6)}…`;
          return `${i + 1}. ${name} — 🔥 $${b.totalAmount ?? b.amount ?? '?'} spent`;
        }).join('\n');
        boostSection = `\n\n🚀 Top Boosted on Base (DexScreener)\n${bLines}`;
      }
    } catch { /* boost section is best-effort */ }
    return `🔥 Hot Gems on Base Right Now\n\n${lines}${boostSection}`;
  } catch {
    return '⚠️ Trending tokens are unavailable right now — the market feed didn’t answer. Try again in a few minutes.';
  }
}

// ── Batch 1 — Markets & TA + account basics ─────────────────────────────────

async function taOverview(ctx, args = {}) {
  const gate = await skillGateText('ta_overview', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  // /ta resolution, exactly: an explicit CA wins, anything else is $PBAI.
  const q = String(args.query ?? args.token ?? '').trim();
  const ca = ADDR_RE.test(q) ? q : PBAI_CA;
  try {
    const token = await fetchTokenByAddress(ca);
    if (!token?.poolId) return { ok: false, text: '❌ No trading pool found for that token — it may be too new or have no liquidity yet. A contract address with an active pool works best.' };
    const poolAddr = String(token.poolId).split('_').pop();
    const candles = await fetchOHLCV(poolAddr, fetch, 'base', 'hour', 100);
    if (!candles || candles.length < 15) return { ok: false, text: '📊 Not enough candle history for TA on this pair yet.' };
    // Gap-1 TA card data: the SAME candles the text card reads, run through
    // the same lib/ta.js math — no second fetch, numbers cannot drift apart.
    const closes = candles.map((c) => c.close);
    const r = rsi(closes);
    const ta = {
      name: token.name, symbol: token.symbol, price: closes[closes.length - 1],
      rsi: r, rsiLabel: r == null ? null : r > 70 ? 'OVERBOUGHT' : r < 30 ? 'OVERSOLD' : 'NEUTRAL',
      macd: macd(closes), bollinger: bollinger(closes),
    };
    return { ok: true, text: taCard(token.name, token.symbol, candles), data: { token, ta } };
  } catch {
    return { ok: false, text: '📊 Could not build TA right now. Try again shortly.' };
  }
}

function taSkillResult(text) {
  const failed = text.startsWith('⚠️') || text.startsWith('❌') || text.startsWith('📊 Price feed');
  return { ok: !failed, text };
}

async function rsiCheck(ctx, args = {}) {
  const gate = await skillGateText('rsi_check', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  return taSkillResult(await rsiText(String(args.query ?? args.token ?? ''), ctx.chatId, ctx.chatType));
}

async function macdCheck(ctx, args = {}) {
  const gate = await skillGateText('macd_check', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  return taSkillResult(await macdText(String(args.query ?? args.token ?? ''), ctx.chatId, ctx.chatType));
}

async function bollingerCheck(ctx, args = {}) {
  const gate = await skillGateText('bollinger_check', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  return taSkillResult(await bollingerText(String(args.query ?? args.token ?? ''), ctx.chatId, ctx.chatType));
}

async function hotGems(ctx, args = {}) {
  const gate = await skillGateText('hot_gems', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  const text = await hotGemsText();
  return { ok: !text.startsWith('⚠️'), text };
}

async function walletLookup(ctx, args = {}) {
  const gate = await skillGateText('wallet_lookup', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  const wallet = String(args.address ?? args.token ?? args.query ?? '').trim();
  if (!ADDR_RE.test(wallet)) {
    return { ok: false, text: '💼 Usage: /portfolio 0xWALLET\nExample: /portfolio 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' };
  }
  const [eth, pbaiRaw] = await Promise.all([ethBalance(wallet), erc20BalanceRaw(wallet, PBAI_CA)]);
  if (eth == null) return { ok: false, text: '⚠️ Could not reach the chain provider right now.' };
  const pbai = pbaiRaw != null ? Number(pbaiRaw) / 1e18 : 0;
  const short = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  return {
    ok: true,
    text: [
      `💼 Portfolio: ${short}`,
      '',
      `⚡ ETH: ${eth.toFixed(6)} ETH`,
      `🤖 PBAI: ${pbai.toLocaleString('en-US')} $PBAI`,
      '',
      `🔗 https://basescan.org/address/${wallet}`,
    ].join('\n'),
    data: { address: wallet },
  };
}

async function securityScan(ctx, args = {}) {
  const gate = await skillGateText('security_scan', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  // /scan contract: an address is REQUIRED — no group-token defaulting.
  const addr = String(args.token ?? args.query ?? args.address ?? '').trim();
  if (!ADDR_RE.test(addr)) {
    return { ok: false, text: '🛡️ Usage: /scan <contract address> — paste a Base (0x…) contract to check.' };
  }
  const out = await scanTextFor(addr);
  return { ok: out.ok, text: out.text, data: { address: addr } };
}

async function verdictCardSkill(ctx, args = {}) {
  const gate = await skillGateText('verdict_card', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  const addr = String(args.token ?? args.query ?? args.address ?? '').trim();
  if (!ADDR_RE.test(addr)) {
    return { ok: false, text: '🪪 Send a Base contract address (0x…) and I\'ll pull its verdict card.' };
  }
  const v = await fetchVerdict(addr);
  if (!v) {
    return { ok: false, text: '⚠️ No security data available for that token right now — no card sent.', data: { address: addr } };
  }
  const flagLines = v.flags.length ? `\n\n${v.flags.map((f) => `• ${f}`).join('\n')}` : '';
  const posLines = v.positives?.length ? `\n\n${v.positives.map((p) => `✓ ${p}`).join('\n')}` : '';
  return {
    ok: true,
    text: `🪪 $${v.symbol} verdict — ${v.verdictText} (score ${v.score}/100)${flagLines}${posLines}\n\nThe full card is on its way to your DM.`,
    data: { address: addr, score: v.score, riskLevel: v.riskLevel },
  };
}

async function myPoints(ctx, args = {}) {
  const chatId = await resolveGroupChatId(ctx, args);
  const name = ctx.from?.first_name ?? ctx.from?.username ?? 'You';
  const text = await pointsTextFor(ctx.from.id, chatId, name);
  // Gap-1 rank card data: the exact reads pointsTextFor just made (same
  // row, same total) so the card can never contradict the text above it.
  const xpData = { groupXp: 0, totalXp: 0, streak: 0, wallet: null };
  try {
    const row = await db.select().from(raid_xp)
      .where(and(eq(raid_xp.userId, Number(ctx.from.id)), eq(raid_xp.chatId, Number(chatId)))).get();
    xpData.groupXp = Number(row?.xp ?? 0);
    xpData.streak = Number(row?.streak ?? 0);
    const t = await db.get(sql`SELECT COALESCE(SUM(xp), 0) AS s FROM raid_xp WHERE user_id = ${Number(ctx.from.id)} AND is_disqualified = 0`);
    xpData.totalXp = Number(t?.s ?? xpData.groupXp);
  } catch { /* zeros stand — the companion fires nothing on empty data */ }
  try { const w = await getUserWallets(ctx.from.id); xpData.wallet = w?.baseAddress ?? null; } catch { /* null stands */ }
  return { ok: true, text, data: { chatId, ...xpData } };
}

async function myTierSkill(ctx) {
  const from = ctx.from;
  const user = await callerUserRow(from);
  const tier = await effectiveTier(from.id, user);
  const label = TIER_LABELS[tier] ?? `⭐ ${tier}`;
  const expires = user?.subscriptionExpiresAt
    ? (user.subscriptionExpiresAt instanceof Date ? user.subscriptionExpiresAt : new Date(user.subscriptionExpiresAt))
    : null;
  let credits = 0;
  try {
    const rows = await db.select().from(credit_ledger)
      .where(eq(credit_ledger.userKey, `telegram:${from.id}`)).all();
    credits = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  } catch { /* ignore */ }
  let allowance = null;
  try { allowance = await aiCommandAllowance(tier, from.id); } catch { allowance = null; }
  let refInfo = null;
  if (allowance) {
    try { refInfo = await referralBonus(from.id); } catch { refInfo = null; }
  }
  return {
    ok: true,
    text: [
      `👤 ${from.first_name ?? 'Degen'}${from.username ? ' (@' + from.username + ')' : ''}`,
      `${label}`,
      expires ? `📅 Subscription: until ${expires.toISOString().slice(0, 10)}` : '📅 Subscription: free / manual',
      `🎨 Studio credits: ${credits.toLocaleString('en-US')}`,
      allowance
        ? (allowance.limit === -1
          ? '⚡ AI commands: unlimited on your tier'
          : `⚡ AI commands/day: ${allowance.limit}${allowance.referralBonus > 0 ? ` (incl. +${allowance.referralBonus} referral bonus)` : ''}`)
        : 'Free users get 0 AI commands/day. Upgrade with /upgrade.',
      refInfo && refInfo.referralsMade > 0
        ? `🎁 Referrals: ${refInfo.referralsMade} — each one adds +3 AI commands/day. /invite for your links.`
        : '🎁 Invite friends with /invite — +3 AI commands/day per referral, forever.',
    ].join('\n'),
    data: { tier },
  };
}

// ── Batch 2 — My stuff + my community ───────────────────────────────────────

async function myWalletSkill(ctx) {
  return { ok: true, text: await myWalletTextFor(ctx.from.id) };
}

async function holderStatus(ctx) {
  // Mirrors /claimholder exactly, including its ONE write: when a balance
  // is found, the caller's own raid_xp rows get pbaiHolder = true (the
  // idempotent 1.5× multiplier flag). Caller-scoped, self-only.
  const uid = ctx.from.id;
  const wallets = [];
  const reg = await getUserWallets(uid);
  if (reg?.baseAddress) wallets.push(reg.baseAddress);
  if (reg?.solAddress) wallets.push(reg.solAddress);
  try {
    const rows = await db.select().from(raid_xp).where(eq(raid_xp.userId, uid)).all();
    for (const r of rows) if (r.walletAddress) wallets.push(r.walletAddress);
  } catch { /* ignore */ }
  const baseWallets = [...new Set(wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w)))];
  if (!baseWallets.length) {
    return {
      ok: true,
      text: [
        '💎 Verify Your $PBAI Holder Status',
        '',
        'Connect your wallet first:',
        '/connect <your_wallet_address>',
        '',
        'Then run /claimholder again — I\'ll check your $PBAI balance on-chain and unlock your 1.5x XP multiplier.',
      ].join('\n'),
      data: { holder: false, reason: 'no-wallet' },
    };
  }
  let verifiedWallet = null; let balance = 0; let rpcOk = false;
  for (const w of baseWallets) {
    const check = await checkPbai(w);
    if (check.available) {
      rpcOk = true;
      if (check.balance > balance) { balance = check.balance; verifiedWallet = w; }
    }
  }
  if (!rpcOk) {
    return { ok: false, text: '⚠️ Holder verification is temporarily unavailable.\n\nI could not reach the chain provider to confirm your wallet balance.\n\nYour holder status and XP were not changed. Run /claimholder again in a moment.' };
  }
  if (balance <= 0) {
    return {
      ok: true,
      text: [
        '🔍 No $PBAI found on-chain.',
        '',
        `I checked your connected wallet${baseWallets.length > 1 ? 's' : ''} but couldn't find any $PBAI.`,
        '',
        'Grab some, then run /claimholder again to unlock your 1.5x XP multiplier.',
      ].join('\n'),
      data: { holder: false, reason: 'zero-balance' },
    };
  }
  try {
    await db.update(raid_xp).set({ pbaiHolder: true, updatedAt: new Date() })
      .where(eq(raid_xp.userId, uid)).run();
  } catch { /* multiplier flag write best-effort, like the command */ }
  const short = verifiedWallet.length > 12
    ? `${verifiedWallet.slice(0, 6)}...${verifiedWallet.slice(-4)}` : verifiedWallet;
  return {
    ok: true,
    text: [
      '💎 PBAI Holder Verified On-Chain!',
      '',
      `Found ${Math.floor(balance).toLocaleString('en-US')} $PBAI in ${short}.`,
      '',
      'Your 1.5x XP multiplier is now active on all future raids. 🔥',
    ].join('\n'),
    data: { holder: true, balance },
  };
}

async function myAlerts(ctx) {
  // The /alert list branch verbatim (list only — creation stays a command).
  const alerts = await listPriceAlerts(ctx.from.id);
  if (!alerts.length) {
    return { ok: true, text: '🔔 No active alerts.\n\nUsage: /alert PBAI 0.0005\nYou\'ll be notified in this chat when the price crosses your target.', data: { count: 0 } };
  }
  const lines = alerts.map((a, i) =>
    `${i + 1}. ${a.tokenName ?? a.tokenAddress.slice(0, 10)} ${a.direction === 'above' ? '↑' : '↓'} $${a.targetPrice}`);
  return { ok: true, text: `🔔 Your Price Alerts\n\n${lines.join('\n')}`, data: { count: alerts.length } };
}

async function myWatchedSkill(ctx) {
  return { ok: true, text: await myWatchedTextFor(ctx.from.id) };
}

async function myInvite(ctx) {
  // DM branch of buildInvitePanel: own stats + own links + opt-in board.
  const { text, keyboard } = await buildInvitePanel(ctx.from.id, null, ctx.from);
  return { ok: true, text, buttons: urlButtonsOf(keyboard) };
}

async function groupLeaderboard(ctx, args = {}) {
  const chatId = await resolveGroupChatId(ctx, args);
  const text = await pointsRankGroupTextFor(ctx.from.id, chatId);
  return { ok: true, text, data: { chatId } };
}

async function mySquad(ctx, args = {}) {
  const chatId = await resolveGroupChatId(ctx, args);
  const chatNum = Number(chatId);
  let mine = null;
  try { mine = await getUserSquad(ctx.from.id, chatNum); } catch { mine = null; }
  if (!mine) {
    // Squadless → the group's squad list (the /squads view).
    const rows = await listSquads(chatNum, 10);
    if (!rows.length) {
      return { ok: true, text: '⚔️ PB Army Squads\n\nNo squads yet in this group. Be the first — /squad create <name>', data: { chatId } };
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${r.name} — ${r.squadXp} XP (${r.memberCount} members)`);
    return {
      ok: true,
      text: `⚔️ You're not in a squad in this group yet.\n\n⚔️ PB Army Squad Leaderboard\n\n${lines.join('\n')}\n\nJoin one in the group with /squad join <name>.`,
      data: { chatId },
    };
  }
  const members = await squadMembers(mine.id);
  const rank = getPBRank(mine.squadXp ?? 0);
  return {
    ok: true,
    text: [
      `⚔️ Squad: ${mine.name}`,
      `${rank.emoji} ${rank.name} — ${(mine.squadXp ?? 0).toLocaleString('en-US')} squad XP`,
      `👥 ${members.length} member${members.length === 1 ? '' : 's'}`,
    ].join('\n'),
    data: { chatId, squadId: mine.id },
  };
}

async function contestStatus(ctx, args = {}) {
  const chatId = await resolveGroupChatId(ctx, args);
  const out = await contestStatusFor(chatId);
  // The command renders HTML; the skill contract is plain text.
  const text = String(out.text ?? '').replace(/<[^>]+>/g, '');
  return { ok: out.ok, text, data: { chatId, active: out.active } };
}

// ── Batch 3 — Create, fun, and the long tail ────────────────────────────────

async function postWriter(ctx, args = {}) {
  const spec = postKindSpec(args.kind);
  if (!spec) {
    return {
      ok: false,
      text: '✍️ Pick a post kind first: bull · bear · moon (Starter+) · fud · gem (Builder+) · meme · callout · alpha · nft · defi (Pro+) — then give me a topic.\n\nExample: kind "bull", topic "$PBAI".',
    };
  }
  const gate = await skillGateText('post_writer', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  // Topic default mirrors postTopic(): explicit arg → group token → $PBAI.
  let topic = String(args.topic ?? args.text ?? args.query ?? '').trim();
  if (!topic) {
    if (ctx.chatType === 'group' || ctx.chatType === 'supergroup') {
      try {
        const s = await getGroupSettings(ctx.chatId);
        topic = s.tokenLabel ?? s.tokenAddress ?? '$PBAI';
      } catch { topic = '$PBAI'; }
    } else {
      topic = '$PBAI';
    }
  }
  try {
    const post = await generatePost(spec.kind, topic);
    // Deliberate surface difference (design §3): the skill returns the post
    // PRIVATELY to the caller and never posts anywhere. Sharing is the
    // caller's own tap on the Share-on-X button.
    return {
      ok: true,
      text: `${POST_HEADERS[spec.kind](topic)}\n\n${post}`,
      buttons: urlButtonsOf(shillShareKeyboard(post, topic)?.inline_keyboard),
      data: { kind: spec.kind, topic },
    };
  } catch {
    return { ok: false, text: '❌ Could not write that right now. Try again shortly.' };
  }
}

async function debateSkill(ctx, args = {}) {
  const gate = await skillGateText('debate', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  const query = String(args.topic ?? args.query ?? args.text ?? '').trim();
  if (!query) return { ok: false, text: 'Usage: /debate $TOKEN or /debate BTC vs ETH' };
  try {
    const response = await askBrain(
      `Run a bull vs bear debate for: ${query}\n\nFormat exactly like this:\n🐂 BULL CASE\n• [Reason 1]\n• [Reason 2]\n• [Reason 3]\n\n🐻 BEAR CASE\n• [Reason 1]\n• [Reason 2]\n• [Reason 3]\n\n⚖️ VERDICT\n[2-sentence neutral conclusion]`,
      {
        maxOutputTokens: 800,
        systemPromptOverride: 'You are a neutral crypto debate moderator. Present bull and bear cases concisely. Do NOT use markdown asterisks or underscores. Use emojis. Max 250 words.',
      }
    );
    return { ok: true, text: response };
  } catch {
    return { ok: false, text: '❌ Could not run debate right now. Try again shortly.' };
  }
}

async function moonMoment(ctx, args = {}) {
  const gate = await skillGateText('moon_moment', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  // Private delivery only — the in-group command posts publicly; the skill
  // returns the caption to the caller and posts nothing.
  return { ok: true, text: pickMoonCaption() };
}

async function myDigest(ctx) {
  const d = await buildDigest(ctx.from.id, Date.now() - 24 * 3600 * 1000);
  return { ok: true, text: d?.text ?? '🌅 All quiet — your agents and alerts had nothing to report in the last 24 hours.' };
}

async function businessStatus(ctx, args = {}) {
  const gate = await skillGateText('business_status', ctx.from, args);
  if (gate) return { ok: false, gated: true, text: gate };
  const view = await businessSettingsView(ctx.from.id);
  const modeLabel = view.mode === 'fixed' ? '📌 Fixed Message'
    : view.mode === 'greeting_then_ai' ? '👋 Greeting + AI'
    : '🤖 AI Only';
  return {
    ok: true,
    text: [
      '🏢 Business Bot Status',
      '',
      `• AI replies: ${view.aiEnabled ? 'ON ✅' : 'OFF 🔇'}`,
      `• Mode: ${modeLabel}`,
      `• Persona: ${view.systemPrompt ? 'Custom ✅' : 'Default PB'}`,
      `• Greeting: ${view.greetingMessage ? 'Set ✅' : '—'}`,
      `• Fixed message: ${view.fixedMessage ? 'Set ✅' : '—'}`,
      `• Fallback: ${view.fallbackMessage ? 'Set ✅' : '—'}`,
      `• Connection: ${view.connection?.connected ? 'Connected ✅' : 'Not connected'}`,
      '',
      'Edit anytime with /bizsetup.',
    ].join('\n'),
    data: { eligible: view.eligible },
  };
}

async function myCampaign(ctx) {
  const gate = await skillGateText('my_campaign', ctx.from, {});
  if (gate) return { ok: false, gated: true, text: gate };
  return { ok: true, text: await campaignSummaryText(ctx.from.id) };
}

async function globalStats(ctx) {
  return { ok: true, text: await statsTextFor() };
}

async function featuredGems(ctx) {
  return { ok: true, text: await gemsTextFor() };
}

// ── Gap-1 card companions ───────────────────────────────────────────────────
// After a skill's TEXT answer has landed, the caller fires this: the
// matching card is rendered from the SAME data object the runner already
// fetched (never a refetch) and sent as a follow-up photo. Mirrors how the
// verdict card coexists with the scan skills. Never throws — a card
// failure can never cost the user their answer, and an empty data source
// sends nothing. Gates: companions inherit their skill's gate by
// construction (they only fire on an ok, ungated result).

function rankCardData({ displayName, xp, boardRank = null, streak = 0, wallet = null, scopeLabel = '', groupXp = null }) {
  const idx = rankIndexOf(xp);
  const cur = PB_RANKS[idx];
  const next = PB_RANKS[idx + 1] ?? null;
  return {
    displayName, rankName: cur.name, xp, boardRank, streak, wallet, scopeLabel, groupXp,
    nextRankName: next?.name ?? null, nextAt: next?.min ?? null,
    progress: next ? Math.min(1, Math.max(0, (xp - cur.min) / (next.min - cur.min))) : 1,
  };
}

export async function sendSkillCardCompanion(action, res, chatId, from) {
  try {
    if (!res?.ok || chatId == null) return { sent: false, reason: 'no-data' };
    const displayName = from?.first_name ?? from?.username ?? 'Raider';
    if (action === 'price_check' && res.data) {
      return await sendPriceCard(chatId, res.data);
    }
    if (action === 'ta_overview' && res.data?.ta) {
      return await sendTaCard(chatId, res.data.ta);
    }
    if (action === 'my_rank' && res.data?.me) {
      return await sendRankCard(chatId, rankCardData({
        displayName, xp: Number(res.data.me.xp) || 0, boardRank: res.data.me.rank ?? null,
        streak: res.data.me.streak ?? 0, wallet: res.data.wallet ?? null, scopeLabel: 'HOME BOARD',
      }));
    }
    if (action === 'my_points' && Number(res.data?.totalXp) > 0) {
      return await sendRankCard(chatId, rankCardData({
        displayName, xp: Number(res.data.totalXp) || 0, boardRank: null,
        streak: res.data.streak ?? 0, wallet: res.data.wallet ?? null,
        scopeLabel: 'POINTS SUMMARY', groupXp: Number(res.data.groupXp) || 0,
      }));
    }
    return { sent: false, reason: 'no-card' };
  } catch {
    return { sent: false, reason: 'error' };
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

export const SKILLS = {
  // 📊 Markets & TA
  price_check: {
    name: 'price_check',
    describe: () => 'Live GeckoTerminal price summary for a token. Args: { token } — ticker or 0x…; empty = group token / $PBAI. No brain needed. Starter+ gate applies.',
    run: priceCheck,
  },
  ta_overview: {
    name: 'ta_overview',
    describe: () => 'Full TA card (RSI + MACD + Bollinger) for a token — the /ta pipeline. Args: { query } — 0x… contract; empty/other = $PBAI. Starter+ gate applies.',
    run: taOverview,
  },
  rsi_check: {
    name: 'rsi_check',
    describe: () => 'RSI reading with overbought/oversold label — the /rsi pipeline. Args: { query } — ticker, 0x…, optional trailing period. Starter+ gate applies.',
    run: rsiCheck,
  },
  macd_check: {
    name: 'macd_check',
    describe: () => 'MACD (12,26,9) with crossover detection — the /macd pipeline. Args: { query }. Starter+ gate applies.',
    run: macdCheck,
  },
  bollinger_check: {
    name: 'bollinger_check',
    describe: () => 'Bollinger Bands (20) position/breakout read — the /bollinger pipeline. Args: { query } — optional trailing period. Starter+ gate applies.',
    run: bollingerCheck,
  },
  hot_gems: {
    name: 'hot_gems',
    describe: () => 'Top Base tokens by 24h volume + top DexScreener boosts — the /gem pipeline. Builder+ gate applies. No args.',
    run: hotGems,
  },
  wallet_lookup: {
    name: 'wallet_lookup',
    describe: () => 'ETH + $PBAI balances for any public Base address — the /portfolio pipeline. Builder+ gate applies. Args: { address }.',
    run: walletLookup,
  },
  recap_today: {
    name: 'recap_today',
    describe: () => 'Today\u2019s market recap for a community\u2019s token in the proven 📋 DAILY RECAP format. Deterministic; brain-polished when the brain answers. Args: { chatId? }.',
    run: recapToday,
  },
  // 🛡️ Safety & Scanning
  token_scan: {
    name: 'token_scan',
    describe: () => 'Deep AI analysis of a token (the /analyze pipeline; Pro+ gate applies). Args: { query } — ticker, name, or 0x… contract; empty = $PBAI / group token.',
    run: tokenScan,
  },
  security_scan: {
    name: 'security_scan',
    describe: () => 'Fast GoPlus security verdict (honeypot, taxes, ownership) — the /scan pipeline, no AI. Args: { token } — 0x… contract REQUIRED. Starter+ gate applies.',
    run: securityScan,
  },
  verdict_card: {
    name: 'verdict_card',
    describe: () => 'The shareable PNG verdict card for a token (deterministic GoPlus score) — card is sent to the caller\u2019s DM. Args: { token } — 0x… contract. Starter+ gate applies.',
    run: verdictCardSkill,
  },
  // 👤 My Account
  my_rank: {
    name: 'my_rank',
    describe: () => 'The caller\u2019s raid rank, XP, and streak on the home community board. No args. No brain needed.',
    run: myRank,
  },
  my_points: {
    name: 'my_points',
    describe: () => 'The caller\u2019s XP in a group + global total, PB rank, streak, tier — the /points pipeline. Args: { chatId? } — defaults to the caller\u2019s most-active group, else home.',
    run: myPoints,
  },
  my_tier: {
    name: 'my_tier',
    describe: () => 'The caller\u2019s tier, subscription expiry, Studio credit balance, and AI-command allowance — the /mytier pipeline. No args.',
    run: myTierSkill,
  },
  my_wallet: {
    name: 'my_wallet',
    describe: () => 'The caller\u2019s own registered Base/Sol wallets + verified $PBAI holder rows — the /mywallet pipeline. No args.',
    run: myWalletSkill,
  },
  holder_status: {
    name: 'holder_status',
    describe: () => 'On-chain $PBAI holder check for the caller\u2019s wallets + 1.5× XP multiplier state — the /claimholder pipeline (mirrors its self-scoped flag write). No args.',
    run: holderStatus,
  },
  my_alerts: {
    name: 'my_alerts',
    describe: () => 'The caller\u2019s active price alerts (list only) — the /alert list pipeline. No args.',
    run: myAlerts,
  },
  my_watched: {
    name: 'my_watched',
    describe: () => 'The caller\u2019s whale-wallet watches (list only) — the /mywatched pipeline. No args.',
    run: myWatchedSkill,
  },
  my_invite: {
    name: 'my_invite',
    describe: () => 'The caller\u2019s referral stats + personal invite links + global-board standing — the /invite DM pipeline. Returns share buttons. No args.',
    run: myInvite,
  },
  my_digest: {
    name: 'my_digest',
    describe: () => 'The caller\u2019s last-24h activity rundown (agent runs, alerts fired, whale watches hit) — the /digest read pipeline. No args.',
    run: myDigest,
  },
  business_status: {
    name: 'business_status',
    describe: () => 'The caller\u2019s Business Bot status (AI on/off, reply mode, persona, connection) — the /bizsetup status pipeline. Starter+ gate applies. No args.',
    run: businessStatus,
  },
  my_campaign: {
    name: 'my_campaign',
    describe: () => 'The caller’s member campaign: status, slots (their own groups only), post rhythm, deliveries — the /campaign pipeline. Starter+ gate applies (the campaigns lib gate). No args.',
    run: myCampaign,
  },
  // 🏆 Community
  community_stats: {
    name: 'community_stats',
    describe: () => 'Raid XP total, raider count, top 3 raiders, queue length, and live-raid status for a community. Args: { chatId? } — defaults to the caller\u2019s group, else home. No brain needed.',
    run: communityStats,
  },
  group_leaderboard: {
    name: 'group_leaderboard',
    describe: () => 'One group\u2019s sealed top-10 XP board + the caller\u2019s rank in it — the /pointsrank group pipeline. Args: { chatId? } — defaults to the caller\u2019s most-active group, else home.',
    run: groupLeaderboard,
  },
  my_squad: {
    name: 'my_squad',
    describe: () => 'The caller\u2019s squad in a group (rank, XP, members), or the group\u2019s squad list when squadless — the /squad + /squads pipelines. Args: { chatId? }.',
    run: mySquad,
  },
  contest_status: {
    name: 'contest_status',
    describe: () => 'The active contest in a group: state, time left, scoring, prize text, qualification rules — the /conteststatus pipeline. Args: { chatId? }.',
    run: contestStatus,
  },
  global_stats: {
    name: 'global_stats',
    describe: () => 'Whole-network aggregates: users, groups, raids, raid XP, active alerts, watches — the /stats pipeline. No args.',
    run: globalStats,
  },
  featured_gems: {
    name: 'featured_gems',
    describe: () => 'The curated community gem list (name, ticker, contract) — the /gems pipeline. No args.',
    run: featuredGems,
  },
  global_standings: {
    name: 'global_standings',
    describe: () => 'Global leaderboard across opted-in communities: standings + top raiders. No args. No brain needed.',
    run: globalStandings,
  },
  // ✍️ Create & Fun
  post_writer: {
    name: 'post_writer',
    describe: () => 'Generate a ready-to-post shill post in 11 kinds — returned PRIVATELY to the caller, never posted. Args: { kind, topic }. Per-kind gates mirror the post commands (bull/bear/moon Starter+, fud/gem Builder+, meme/callout/alpha/nft/defi Pro+).',
    run: postWriter,
  },
  debate: {
    name: 'debate',
    describe: () => 'Bull-vs-bear AI debate on a token or topic, with verdict — the /debate pipeline. Builder+ gate applies. Args: { topic }.',
    run: debateSkill,
  },
  moon_moment: {
    name: 'moon_moment',
    describe: () => 'A random moon caption / hype line, delivered privately — the /moonit pipeline. Builder+ gate (canonical) applies. No args.',
    run: moonMoment,
  },
};

/** Run a skill by name. Never throws — failures come back as { ok:false }. */
export async function runSkill(name, ctx, args = {}) {
  const skill = SKILLS[name];
  if (!skill) return { ok: false, text: `Unknown skill: ${name}` };
  try {
    return await skill.run(ctx ?? {}, args ?? {});
  } catch (err) {
    console.error(`[skill ${name}]`, err?.message ?? err);
    return { ok: false, text: '⚠️ That hit a snag — try again in a moment.' };
  }
}

/** Registry listing for the brain layer / future surfaces. */
export function describeSkills() {
  return Object.values(SKILLS).map((s) => ({ name: s.name, description: s.describe() }));
}

// ── Mini App catalog metadata (EDGE WAVE #1, expanded 2026-10-20) ──────────
// Display + gate metadata for the Mini App Skills screen. Registry order in
// SKILLS above is the display order within each category. `gate` is the
// display tier ('none'|'starter'|'builder'|'pro'); `gateSet` names the
// gate family skillGateText() enforces ('starter', 'hustler', 'grinder',
// 'builderSet', 'builderCanon', 'perKind', 'none') — since the O1 fix each
// family is a canonical minimum (starter/builder/pro) compared by rank in
// gateLockedFor(), so the badge and the server-side wall can never drift
// apart.
export const SKILL_CATEGORIES = {
  markets: '📊 Markets & TA',
  safety: '🛡️ Safety & Scanning',
  account: '👤 My Account',
  community: '🏆 Community',
  create: '✍️ Create & Fun',
};

export const SKILL_CATALOG = {
  // 📊 Markets & TA
  price_check: {
    title: 'Price Check',
    blurb: 'Live price summary for any token — price, 24h move and market stats.',
    category: 'markets', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: 'Ticker or 0x… address — leave empty for $PBAI',
  },
  ta_overview: {
    title: 'TA Overview',
    blurb: 'Full technical analysis card — RSI, MACD and Bollinger in one view.',
    category: 'markets', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: '0x… contract address — leave empty for $PBAI',
  },
  rsi_check: {
    title: 'RSI Check',
    blurb: 'RSI reading with overbought / oversold signal for any token.',
    category: 'markets', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: 'Ticker or 0x… — empty = $PBAI · optional period, e.g. "PBAI 21"',
  },
  macd_check: {
    title: 'MACD Check',
    blurb: 'MACD (12,26,9) with crossover detection.',
    category: 'markets', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: 'Ticker or 0x… — empty = $PBAI',
  },
  bollinger_check: {
    title: 'Bollinger Check',
    blurb: 'Bollinger Bands — price position and breakout read.',
    category: 'markets', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: 'Ticker or 0x… — empty = $PBAI · optional period, e.g. "PBAI 20"',
  },
  hot_gems: {
    title: 'Hot Gems',
    blurb: 'Top Base tokens by 24h volume + top DexScreener boosts.',
    category: 'markets', gate: 'builder', gateSet: 'hustler', lockLabel: 'Builder+',
    needsInput: 'none',
    inputHint: null,
  },
  wallet_lookup: {
    title: 'Wallet Lookup',
    blurb: 'ETH + $PBAI balances for any public Base address.',
    category: 'markets', gate: 'builder', gateSet: 'builderSet', lockLabel: 'Builder+',
    needsInput: 'token',
    inputHint: 'Base wallet address (0x…)',
  },
  recap_today: {
    title: 'Daily Recap',
    blurb: "Today's market recap in the 📋 DAILY RECAP format.",
    category: 'markets', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  // 🛡️ Safety & Scanning
  token_scan: {
    title: 'Token Scan',
    blurb: 'Deep AI analysis of any token — the /analyze pipeline.',
    category: 'safety', gate: 'pro', gateSet: 'grinder', lockLabel: 'Pro+',
    needsInput: 'token',
    inputHint: 'Ticker or 0x… address — leave empty for $PBAI',
  },
  security_scan: {
    title: 'Security Scan',
    blurb: 'Fast GoPlus security verdict — honeypot, taxes, ownership. No AI, no quota.',
    category: 'safety', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: 'Base contract address (0x…) — required',
  },
  verdict_card: {
    title: 'Verdict Card',
    blurb: 'The shareable PNG verdict card — deterministic GoPlus score, sent to your DM.',
    category: 'safety', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'token',
    inputHint: 'Base contract address (0x…)',
  },
  // 👤 My Account
  my_rank: {
    title: 'My Rank',
    blurb: 'Your raid rank, XP and streak on the community board.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  my_points: {
    title: 'My Points',
    blurb: 'Your XP in a group + global total, PB rank, streak and tier.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'group',
    inputHint: 'Group chat ID (optional — defaults to your most active group)',
  },
  my_tier: {
    title: 'My Tier',
    blurb: 'Your tier, subscription expiry, Studio credits and AI-command allowance.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  my_wallet: {
    title: 'My Wallet',
    blurb: 'Your registered Base/Sol wallets + verified $PBAI holder rows.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  holder_status: {
    title: 'Holder Status',
    blurb: 'On-chain check: does your wallet hold $PBAI — and is your 1.5× XP multiplier active?',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  my_alerts: {
    title: 'My Alerts',
    blurb: 'Your active price alerts — token, direction, target.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  my_watched: {
    title: 'My Watched Wallets',
    blurb: 'The whale wallets you are watching.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  my_invite: {
    title: 'My Invites',
    blurb: 'Your referral stats, personal invite links and global-board standing.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  my_digest: {
    title: 'My Digest',
    blurb: 'Your last-24h rundown: agent runs, alerts fired, whale watches hit.',
    category: 'account', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  business_status: {
    title: 'Business Bot Status',
    blurb: 'Your Business Bot: AI on/off, reply mode, persona, connection state.',
    category: 'account', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'none',
    inputHint: null,
  },
  my_campaign: {
    title: 'My Campaign',
    blurb: 'Your shill campaign: status, posting slots in your own groups, rhythm, deliveries.',
    category: 'account', gate: 'starter', gateSet: 'starter', lockLabel: 'Starter+',
    needsInput: 'none',
    inputHint: null,
  },
  // 🏆 Community
  community_stats: {
    title: 'Community Stats',
    blurb: 'Raid XP, top raiders, queue and live-raid status for the community.',
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  group_leaderboard: {
    title: 'Group Leaderboard',
    blurb: "A group's sealed top-10 XP board + your rank in it.",
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'group',
    inputHint: 'Group chat ID (optional — defaults to your most active group)',
  },
  my_squad: {
    title: 'My Squad',
    blurb: 'Your squad in a group — rank, XP, members — or the squad list.',
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'group',
    inputHint: 'Group chat ID (optional — defaults to your most active group)',
  },
  contest_status: {
    title: 'Contest Status',
    blurb: 'The active contest in a group: state, time left, scoring, prizes, rules.',
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'group',
    inputHint: 'Group chat ID (optional — defaults to your most active group)',
  },
  global_stats: {
    title: 'Global Stats',
    blurb: 'Whole-network aggregates: users, groups, raids, raid XP, alerts, watches.',
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  featured_gems: {
    title: 'Featured Gems',
    blurb: 'The curated community gem list — name, ticker, contract.',
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  global_standings: {
    title: 'Global Standings',
    blurb: 'Leaderboard across opted-in communities, plus top raiders worldwide.',
    category: 'community', gate: 'none', gateSet: 'none',
    needsInput: 'none',
    inputHint: null,
  },
  // ✍️ Create & Fun
  post_writer: {
    title: 'Post Writer',
    blurb: 'PB writes a ready-to-post shill post — returned privately to you, never posted.',
    category: 'create', gate: 'starter', gateSet: 'perKind', lockLabel: 'Starter+',
    needsInput: 'kind+text',
    inputHint: 'Topic — e.g. "$PBAI" (defaults to $PBAI)',
    kinds: Object.entries(POST_KINDS).map(([id, s]) => ({
      id, label: s.label, gateSet: s.gateSet,
      lockLabel: s.gateLabel,
    })),
  },
  debate: {
    title: 'Bull vs Bear Debate',
    blurb: 'AI debate on a token or topic, with a neutral verdict.',
    category: 'create', gate: 'builder', gateSet: 'hustler', lockLabel: 'Builder+',
    needsInput: 'text',
    inputHint: 'Topic — e.g. "BTC vs ETH"',
  },
  moon_moment: {
    title: 'Moon Moment',
    blurb: 'A random moon caption / hype line — delivered privately to you.',
    category: 'create', gate: 'builder', gateSet: 'builderCanon', lockLabel: 'Builder+',
    needsInput: 'none',
    inputHint: null,
  },
};

// ── Skill chat surface (Mini App Chat + Telegram DM, 2026-11-05) ───────────
// Rowdy's tap: "the buttons and skills from the Digi chat, in PB's Telegram
// chat + Mini App, PB version." The registry above is the single source of
// truth — this section only SURFACES it: a DM skill card (`/skills`, /menu,
// /start), tap-to-run callbacks, and a one-step input capture for skills
// that need text. Same gates as the Mini App `runSkill` endpoint
// (skillGateText pre-check + in-run gates); locked skills answer with the
// tier wall, never the output. No money moves here: no skill sends, buys,
// or reads keys — post_writer returns privately, never posts.
// Capture state lives in config, same shape as the feedback wizard
// (`fbwiz:<userId>` in lib/statscmds.js): `skillwiz:<userId>` JSON
// { name, kind?, awaiting, createdAt }, 15-min TTL. Sealing: the card and
// every result/prompt go to the caller's DM when tapped in a group — a
// member's tier/wallet never posts to a group.

const SKILL_WIZ_KEY = (userId) => `skillwiz:${userId}`;
const SKILL_WIZ_TTL_MS = 15 * 60 * 1000;

/** Callback-data builders — every shape stays far under Telegram's 64-byte cap. */
export function skillRunData(name) { return `skill:run:${name}`; }
export function skillAskData(name) { return `skill:ask:${name}`; }
export function skillKindData(kindId) { return `skill:kind:${kindId}`; }

/** Pure parser for `skill:*` callback data — null when not ours / malformed. */
export function parseSkillCallback(data) {
  const d = String(data ?? '');
  if (!d.startsWith('skill:')) return null;
  const rest = d.slice(6);
  if (rest === 'list') return { action: 'list' };
  if (rest === 'cancel') return { action: 'cancel' };
  if (rest === 'pbai') return { action: 'pbai' };
  if (rest === 'topic') return { action: 'topic' };
  let m = /^run:([a-z_]+)$/.exec(rest);
  if (m && SKILLS[m[1]]) return { action: 'run', name: m[1] };
  m = /^ask:([a-z_]+)$/.exec(rest);
  if (m && SKILLS[m[1]]) return { action: 'ask', name: m[1] };
  m = /^kind:([a-z]+)$/.exec(rest);
  if (m && postKindSpec(m[1])) return { action: 'kind', kind: m[1] };
  return null;
}

/** Run one skill for a DM caller: gate pre-check, then the skill itself. */
export async function runSkillForDm(name, from, args = {}) {
  const skill = SKILLS[name];
  if (!skill) return { ok: false, text: 'Unknown skill.', gated: false };
  const gateText = await skillGateText(name, from, args).catch(() => null);
  if (gateText) return { ok: false, text: gateText, gated: true };
  const who = { id: from?.id, first_name: from?.first_name, username: from?.username };
  const res = await runSkill(name, { from: who, chatId: who.id, chatType: 'private' }, args);
  return { ok: Boolean(res?.ok), text: res?.text ?? '', gated: Boolean(res?.gated) };
}

/**
 * The DM skill card: every skill in SKILL_CATALOG order, grouped by
 * SKILL_CATEGORIES, lock badges from the same gate sets getSkills serves.
 * Buttons: 2 per row; no-input skills run at once, the rest ask for input.
 */
export async function buildSkillsCard(from) {
  let effTier = 'free';
  try { effTier = await callerEffTier(from); } catch { effTier = 'free'; }
  const tier = String(effTier ?? 'free').toLowerCase();
  const lines = [
    '🧠 PB Skills — tap a button to run it.',
    `${Object.keys(SKILL_CATALOG).length} skills · your tier: ${tier}`,
    '',
  ];
  const keyboard = [];
  for (const [cat, label] of Object.entries(SKILL_CATEGORIES)) {
    const skills = Object.entries(SKILL_CATALOG).filter(([, m]) => m.category === cat);
    if (!skills.length) continue;
    lines.push(`${label} — ${skills.map(([, m]) => m.title).join(' · ')}`);
    let row = [];
    for (const [name, meta] of skills) {
      const locked = gateLockedFor(meta.gateSet ?? 'none', effTier);
      const text = locked ? `🔒 ${meta.title}` : meta.title;
      const data = (meta.needsInput === 'none' || meta.needsInput === 'group')
        ? skillRunData(name)
        : skillAskData(name);
      row.push({ text, callback_data: data });
      if (row.length === 2) { keyboard.push(row); row = []; }
    }
    if (row.length) keyboard.push(row);
  }
  lines.push('', '🔒 = needs a higher tier — tap it and PB tells you which.');
  return { text: lines.join('\n'), keyboard };
}

/** post_writer kind picker — the kinds getSkills serves. */
export async function skillKindKeyboard(from) {
  let effTier = 'free';
  try { effTier = await callerEffTier(from); } catch { effTier = 'free'; }
  const kinds = SKILL_CATALOG.post_writer?.kinds ?? [];
  const keyboard = [];
  let row = [];
  for (const k of kinds) {
    const locked = gateLockedFor(k.gateSet ?? 'none', effTier);
    row.push({ text: locked ? `🔒 ${k.label}` : k.label, callback_data: skillKindData(k.id) });
    if (row.length === 2) { keyboard.push(row); row = []; }
  }
  if (row.length) keyboard.push(row);
  keyboard.push([{ text: '✖ Cancel', callback_data: 'skill:cancel' }]);
  return keyboard;
}

// ── Input capture ───────────────────────────────────────────────────────────

async function setSkillCapture(userId, state) {
  await setConfig(SKILL_WIZ_KEY(userId), JSON.stringify({ ...state, createdAt: Date.now() })).catch(() => {});
}

export async function clearSkillCapture(userId) {
  await setConfig(SKILL_WIZ_KEY(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

export async function loadSkillCapture(userId) {
  try {
    const raw = await getConfig(SKILL_WIZ_KEY(userId), null);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w?.name || !SKILLS[w.name] || Date.now() - (w.createdAt ?? 0) > SKILL_WIZ_TTL_MS) return null;
    return w;
  } catch { return null; }
}

/** Arm the one-step text capture for a skill that needs input. Returns its catalog meta (null when unknown). */
export async function armSkillCapture(userId, name, kind = null) {
  const meta = SKILL_CATALOG[name];
  if (!meta) return null;
  await setSkillCapture(userId, { name, kind, awaiting: 'text' });
  return meta;
}

/** Arm the post_writer kind-picked step (kind chosen, topic choice pending). */
export async function armSkillKindChoice(userId, kind) {
  if (!postKindSpec(kind)) return false;
  await setSkillCapture(userId, { name: 'post_writer', kind, awaiting: 'topic-choice' });
  return true;
}

/** Move an armed post_writer capture from kind-picked to awaiting a typed topic. */
export async function awaitSkillTopic(userId) {
  const w = await loadSkillCapture(userId);
  if (!w || w.name !== 'post_writer' || w.awaiting !== 'topic-choice' || !w.kind) return false;
  await setSkillCapture(userId, { ...w, awaiting: 'text' });
  return true;
}

/**
 * Consume one DM text as a skill input. Returns true when a capture was
 * armed (the text is consumed — even when the skill itself fails); false
 * when nothing was armed, so the message falls through to the brain.
 * Commands never reach here (dispatch runs before the wizard chain).
 */
export async function handleSkillWizardText(userId, text, from) {
  const w = await loadSkillCapture(userId);
  if (!w || w.awaiting !== 'text') return false;
  await clearSkillCapture(userId);
  const clean = String(text ?? '').trim();
  const meta = SKILL_CATALOG[w.name];
  let args = {};
  if (w.name === 'post_writer') args = { kind: w.kind ?? null, topic: clean };
  else if (meta?.needsInput === 'token' || meta?.needsInput === 'text') args = { query: clean };
  const res = await runSkillForDm(w.name, from ?? { id: userId }, args);
  const out = (res?.text ?? '').trim() || '⚠️ That hit a snag — try again in a moment.';
  try { await api.sendMessage({ chat_id: userId, text: String(out).slice(0, 4000) }); } catch { /* never throw into the handler */ }
  return true;
}

/** Harness + live-proof seam (mirrors nlcmd.js __agentLoopTest). */
export const __skillChatTest = {
  buildSkillsCard, skillKindKeyboard, parseSkillCallback, runSkillForDm,
  armSkillCapture, armSkillKindChoice, awaitSkillTopic, loadSkillCapture, clearSkillCapture,
  handleSkillWizardText, skillRunData, skillAskData, skillKindData,
};
