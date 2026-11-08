// Mini App: everything the Dashboard tab needs in one call — profile,
// rank progress, day counts, and the live $PBAI token board (same
// GeckoTerminal source as /price).
//
// MEMBER EXTRAS (Mini App completeness wave): this endpoint also answers
// action-routed reads for the More-tab screens that had no endpoint of
// their own — the platform caps modules per app and PB sits AT the cap,
// so (following the endpoints/campaigns.js precedent) these live here:
//   action 'scamCheck'   → Scam Radar verdict (lib/verdict.js + the site
//                          Worker's canonical /api/scam-radar/verify)
//   action 'referrals'   → caller's own referral stats/links/board
//   action 'moneyStatus' → caller's own Booster + Airdrop state (read-only;
//                          NO send/arm capability exists on this surface)
//   action 'contests'    → contest status for the caller's own groups
//   action 'digest'      → daily-digest pref read/set + preview (op field)
//   action 'portal'      → Portal setup read for the caller's Change-Info
//                          groups (Portal polish, 2026-10-21)
//   action 'portalSave'  → Portal settings write — the group is
//                          re-verified against the caller's LIVE Change
//                          Info right server-side before anything writes
//   action 'trending'    → PB Trending board (Trending votes wave,
//                          2026-10-21): sealed aggregates from
//                          lib/xp.js trendingForUser — tokens + vote
//                          power + real buy volume, never group
//                          attribution — plus the caller's own rank
//                          power (their best group's ladder position)
//   action 'buyComp'       → Buy competition read for the caller's
//                          Change-Info groups (Buy Bot Phase 5
//                          follow-up, 2026-10-21): campaign resolution,
//                          the active competition + live standings,
//                          the last result — the /manage panel's data
//   action 'buyCompStart'  → start a competition through the SAME
//                          startBuyCompetition the /manage wizard's
//                          Start button calls; Change Info for the
//                          group re-verified live before anything runs
//   action 'buyCompEnd' / 'buyCompCancel' → end-now / cancel through
//                          the same finaliseBuyCompetition /
//                          cancelBuyCompetition the panel buttons call
//   action 'workerPortal' → the caller's own Worker Portal (Worker Portal
//                          wave, 2026-10-22): application state from the
//                          /apply receipt + their public directory listing
//                          matched by platform-verified handle — assembled
//                          in lib/websync.js getWorkerPortalFor
//   action 'healthSnapshot' → OWNER-ONLY watchdog health snapshot
//                          (Watchdog wave, 2026-10-22): counts-only
//                          aggregates assembled in lib/groups.js
//                          buildHealthSnapshot — the one deliberate
//                          exception to the own-data-only rule below.
// Every action is scoped to ctx.initData.user.id — own data only.
import { fetch, EndpointError } from 'sdk';
import db, { eq, gt, asc } from 'sdk/db';
import { raid_xp, pbai_holder_wallets, price_alerts, user_agents, community_events, user_settings } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { PB_RANKS, getPBRank, trendingForUser } from '../lib/xp.js';
import { fetchLpBoard, lpCoinUrl, lpDexUrl, lpChainLabel, LP_SITE, fetchLpNftBoard, lpNftCollectionUrl, lpNftBasescanUrl, nftMintPriceDisplay, nftMintPct, nftWindowState, LP_NFT_SITE } from '../lib/market.js';
import { PBAI_CA } from '../lib/accounts.js';
import { canonicalTier } from '../lib/tiers.js';
import { fetchVerdict } from '../lib/verdict.js';
import {
  getReferralStats, botInviteLink, getReferralLeaderboard, getReferralRank,
  REFERRER_XP_REWARD, REFERRED_XP_REWARD,
} from '../lib/referrals.js';
import { isBoostEnabled, isAirdropEnabled, isBoostArmed, isAirdropArmed, isMasterSpendArmed } from '../lib/moneyguard.js';
import { listOwnBoostCampaigns } from '../lib/boost.js';
import { listOwnAirdropCampaigns, tierAirdropBenefit } from '../lib/airdrop.js';
import { contestStatusFor } from '../lib/contests.js';
import {
  getMyGroupsFor, getManageGroupsFor, canChangeInfo, getManageSettings,
  setGroupSettings, portalTimeoutOf, portalModeOf, PORTAL_MODES, PORTAL_WELCOME_MAX,
  resolveBuyCampaignForGroup, getActiveBuyCompetition, getLatestEndedBuyCompetition,
  buyCompetitionStandings, buyCompetitionQualifyingBuys, startBuyCompetition,
  finaliseBuyCompetition, cancelBuyCompetition,
  BUY_COMP_KINDS, BUY_COMP_DURATIONS, BUY_COMP_PRIZE_MAX, BUY_MIN_MAX_USD,
  isOwnerId, buildHealthSnapshot,
  shieldWizardIsAdmin, shieldWizardListOwn, shieldWizardListPending, shieldWizardReport,
  shieldWizardApprove, shieldWizardDismiss, shieldWizardRemove,
} from '../lib/groups.js';
import { getConfig } from '../lib/config.js';
import { setDigestPref, buildDigest } from '../lib/digest.js';
import { getWorkerBase, getWorkerPortalFor } from '../lib/websync.js';

const GT = 'https://api.geckoterminal.com/api/v2';

async function tokenBoard() {
  try {
    const res = await fetch(`${GT}/networks/base/tokens/${PBAI_CA}`);
    if (!res.ok) return null;
    const a = (await res.json())?.data?.attributes;
    if (!a) return null;
    return {
      symbol: a.symbol ?? 'PBAI',
      name: a.name ?? 'PoorBoyAI',
      address: PBAI_CA,
      priceUsd: Number(a.price_usd) || null,
      change24h: Number(a.price_change_percentage?.h24) || 0,
      marketCap: Number(a.market_cap_usd) || null,
      fdv: Number(a.fdv_usd) || null,
      volume24h: Number(a.volume_usd?.h24) || null,
      liquidity: Number(a.total_reserve_in_usd) || null,
    };
  } catch {
    return null;
  }
}

export default async (input, ctx) => {
  const action = String(input?.action ?? '');
  if (action) return memberExtra(action, input, ctx);
  const tg = caller(ctx);
  const user = await ensureUser(tg);
  const id = String(tg.id);

  let xp = 0;
  let streak = 0;
  try {
    const rows = await db.select().from(raid_xp).where(eq(raid_xp.userId, Number(tg.id)));
    xp = rows.reduce((s, r) => s + (r.xp ?? 0), 0);
    streak = rows.reduce((m, r) => Math.max(m, r.streak ?? 0), 0);
  } catch { /* fresh user */ }

  const rank = getPBRank(xp);
  const rankIdx = PB_RANKS.findIndex((r) => r.name === rank.name);
  const next = PB_RANKS[rankIdx + 1] ?? null;

  let holderWallets = 0;
  let alertsActive = 0;
  let agentsRunning = 0;
  let agentsTotal = 0;
  let nextEvent = null;
  try {
    const rows = await db.select().from(pbai_holder_wallets)
      .where(eq(pbai_holder_wallets.telegramUserId, id));
    holderWallets = rows.length;
  } catch { /* none */ }
  try {
    const rows = await db.select().from(price_alerts)
      .where(eq(price_alerts.telegramUserId, id));
    alertsActive = rows.length;
  } catch { /* none */ }
  try {
    const rows = await db.select().from(user_agents)
      .where(eq(user_agents.telegramUserId, id));
    agentsTotal = rows.length;
    agentsRunning = rows.filter((a) => a.status === 'active').length;
  } catch { /* none */ }
  try {
    nextEvent = await db.select().from(community_events)
      .where(gt(community_events.eventTime, new Date()))
      .orderBy(asc(community_events.eventTime)).limit(1).get();
  } catch { /* none */ }

  return {
    user: {
      id,
      firstName: user?.firstName ?? tg.first_name ?? 'friend',
      username: user?.username ?? tg.username ?? null,
      tier: user?.tier ?? 'free',
      memberSince: user?.createdAt ?? null,
    },
    progress: {
      xp,
      streak,
      rank: { name: rank.name, emoji: rank.emoji },
      nextRank: next ? { name: next.name, emoji: next.emoji, at: next.min } : null,
      xpToNext: next ? Math.max(0, next.min - xp) : 0,
    },
    day: {
      alertsActive,
      agentsRunning,
      agentsTotal,
      isHolder: holderWallets > 0,
      holderWallets,
      nextEvent: nextEvent ? { title: nextEvent.title, at: nextEvent.eventTime } : null,
    },
    token: await tokenBoard(),
  };
};

// ── Member extras (action-routed; see header) ─────────────────────────────

const shortAddr = (a) => (a ? `${String(a).slice(0, 10)}…${String(a).slice(-6)}` : null);
const stripHtml = (s) => String(s ?? '')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The site Worker's canonical scam-radar verify (public route; the same
 *  list the website checks — built-in official contacts + the operator's
 *  console-managed additions). Any failure → null (unavailable), never a
 *  fabricated verdict. */
async function officialVerify(type, value) {
  try {
    const base = await getWorkerBase();
    const res = await fetch(
      `${base}/api/scam-radar/verify?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function classifyScamInput(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return { kind: 'address', value: v };
  const tgm = /(?:t\.me\/|telegram\.me\/)([A-Za-z0-9_]{3,})/i.exec(v);
  if (tgm) return { kind: 'telegram', value: tgm[1] };
  const twm = /(?:x\.com\/|twitter\.com\/)([A-Za-z0-9_]{1,15})/i.exec(v);
  if (twm) return { kind: 'twitter', value: twm[1] };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { kind: 'email', value: v };
  if (/^(https?:\/\/)?(www\.)?[A-Za-z0-9-]+\.[A-Za-z]{2,}(\/\S*)?$/.test(v)) {
    return { kind: 'website', value: v };
  }
  if (/^@?[A-Za-z0-9_]{3,32}$/.test(v)) return { kind: 'handle', value: v.replace(/^@/, '') };
  return { kind: 'website', value: v };
}

async function scamCheck(input) {
  const c = classifyScamInput(input?.value);
  if (!c) throw new EndpointError('Paste something to check first.', { code: 'EMPTY_INPUT' });

  if (c.kind === 'address') {
    // A contract gets the full token verdict (lib/verdict.js — the
    // in-platform port of the Worker's canonical scoring); any address is
    // also checked against the official-wallet list.
    const [verdict, official] = await Promise.all([
      fetchVerdict(c.value).catch(() => null),
      officialVerify('wallet', c.value),
    ]);
    return {
      kind: 'address',
      input: c.value,
      official: official
        ? { status: official.status, label: official.label ?? null, description: official.description ?? null, type: 'wallet' }
        : null,
      officialUnavailable: !official,
      verdict: verdict ? {
        name: verdict.name, symbol: verdict.symbol, address: verdict.address,
        score: verdict.score, riskLevel: verdict.riskLevel, verdictText: verdict.verdictText,
        flags: verdict.flags, positives: verdict.positives ?? [], lpState: verdict.lpState ?? null,
        buyTax: verdict.buyTax, sellTax: verdict.sellTax,
        holderCount: verdict.holderCount,
      } : null,
    };
  }

  if (c.kind === 'handle') {
    // A bare handle could be Telegram or X — check both official lists.
    const [tgRes, twRes] = await Promise.all([
      officialVerify('telegram', c.value),
      officialVerify('twitter', c.value),
    ]);
    const hit = [tgRes, twRes].find((r) => r?.status === 'verified');
    const any = hit ?? tgRes ?? twRes;
    return {
      kind: 'handle',
      input: c.value,
      official: any
        ? { status: any.status, label: any.label ?? null, description: any.description ?? null, type: any.type ?? null }
        : null,
      officialUnavailable: !any,
      verdict: null,
    };
  }

  const official = await officialVerify(c.kind, c.value);
  return {
    kind: c.kind,
    input: c.value,
    official: official
      ? { status: official.status, label: official.label, description: official.description ?? null, type: official.type ?? c.kind }
      : null,
    officialUnavailable: !official,
    verdict: null,
  };
}

async function referralsView(tg) {
  const stats = await getReferralStats(tg.id);
  const board = await getReferralLeaderboard(10, null);
  let myRank = board.find((r) => String(r.referrerId) === String(tg.id))?.rank ?? null;
  if (!myRank && stats.total > 0) {
    myRank = await getReferralRank(tg.id, null).catch(() => null);
  }
  return {
    stats,
    botLink: botInviteLink(tg.id),
    xLink: botInviteLink(tg.id, true),
    board: board.map((r) => ({
      rank: r.rank,
      name: r.username ? `@${r.username}` : (r.firstName ?? 'member'),
      total: r.total,
      mine: String(r.referrerId) === String(tg.id),
    })),
    myRank,
    rewards: { referrerXp: REFERRER_XP_REWARD, referredXp: REFERRED_XP_REWARD },
  };
}

async function moneyStatus(tg) {
  const user = await ensureUser(tg);
  const [boostEnabled, boostArmed, airdropEnabled, airdropArmed, masterSpendArmed] = await Promise.all([
    isBoostEnabled(), isBoostArmed(), isAirdropEnabled(), isAirdropArmed(), isMasterSpendArmed(),
  ]);
  const boostRows = await listOwnBoostCampaigns(tg.id, 10).catch(() => []);
  const airdropRows = await listOwnAirdropCampaigns(tg.id, 10);
  const feePayAddress = String(await getConfig('PAY_RECEIVE_BASE_ADDRESS', '') ?? '').trim().toLowerCase();
  const benefit = tierAirdropBenefit(canonicalTier(user?.tier ?? 'free'));
  return {
    // M10 (Wave 2, 2026-10-26): master spend arm state, previously
    // receipt-only and unverifiable from outside. Boolean only — no key
    // material, no wallet, no amounts. Read-only surface; no send/arm
    // capability exists here.
    masterSpendArm: masterSpendArmed,
    boost: {
      enabled: boostEnabled, armed: boostArmed, parked: !boostEnabled,
      campaigns: boostRows.map((c) => ({
        id: c.id, mode: c.mode, chain: c.chain,
        token: c.tokenSymbol ?? shortAddr(c.tokenCa),
        status: c.status, totalDueUsd: c.totalDueUsd ?? null,
      })),
    },
    airdrop: {
      enabled: airdropEnabled, armed: airdropArmed, parked: !airdropEnabled,
      benefit: {
        customCreditUsd: benefit.customCreditUsd, armyDrops: benefit.armyDrops,
        armyFairUse: benefit.armyFairUse, customRateUsd: benefit.customRateUsd,
      },
      campaigns: airdropRows.map((c) => ({
        id: c.id, chain: c.chain ?? 'base', mode: c.recipientMode ?? null,
        token: c.tokenName ?? shortAddr(c.tokenCa),
        status: c.status, walletCount: c.walletCount ?? null,
        amountPerWallet: c.amountPerWallet ?? null, txSuccess: c.txSuccess ?? null,
        serviceFeeUsd: c.serviceFeeUsd ?? null, depositAddress: c.depositAddress ?? null,
        feePaymentKind: c.feePaymentKind ?? null,
        feePayAsset: 'USDC', feePayChain: 'base', feePayAddress: feePayAddress || null,
      })),
    },
  };
}

async function contestsView(tg) {
  const groups = (await getMyGroupsFor(tg.id).catch(() => [])).slice(0, 8);
  const out = [];
  for (const g of groups) {
    const s = await contestStatusFor(g.chatId).catch(() => ({ ok: false, active: false, text: '' }));
    out.push({
      chatId: String(g.chatId),
      title: g.title ?? 'Group',
      ok: s.ok !== false,
      active: !!s.active,
      text: stripHtml(s.text),
    });
  }
  return { groups: out };
}

async function digestOp(tg, input) {
  const op = String(input?.op ?? 'get');
  if (op === 'set') {
    await setDigestPref(tg.id, !!input?.on);
    return { on: !!input?.on };
  }
  if (op === 'preview') {
    const d = await buildDigest(tg.id, Date.now() - 24 * 3600 * 1000).catch(() => null);
    return { text: d?.text ?? '🌅 All quiet — your agents and alerts had nothing to report in the last 24 hours.' };
  }
  let on = true;
  try {
    const row = await db.select().from(user_settings)
      .where(eq(user_settings.telegramUserId, String(tg.id))).get();
    on = row?.notifications?.digest !== false;
  } catch { /* no settings row yet — digest defaults on */ }
  return { on };
}

// ── Portal setup (Portal polish) ──────────────────────────────────────────
// Read: the caller's Change-Info groups (the /manage selector's own
// list — a group appears only while the caller can actually manage it)
// with each group's live portal settings. The banner itself is reported
// as a fact (set / type) but never written from here: a banner is a
// Telegram file_id, captured by sending media to PB in the bot DM.
async function portalView(tg) {
  const homeId = String(await getConfig('TELEGRAM_HOME_CHAT_ID', ''));
  const groups = await getManageGroupsFor(tg.id).catch(() => []);
  const out = [];
  for (const g of groups) {
    const s = await getManageSettings(g.chatId).catch(() => ({}));
    const bannerType = String(s?.portal_banner_type ?? '');
    out.push({
      chatId: String(g.chatId),
      title: g.title ?? 'Group',
      isHome: String(g.chatId) === homeId,
      enabled: s?.portal === true,
      timeout: portalTimeoutOf(s),
      mode: portalModeOf(s),
      welcome: String(s?.portal_welcome ?? ''),
      hasBanner: Boolean(s?.portal_banner_file_id)
        && ['photo', 'animation', 'video'].includes(bannerType),
      bannerType: bannerType || null,
    });
  }
  return { groups: out, welcomeMax: PORTAL_WELCOME_MAX };
}

// Write: ONE group's portal settings. The caller's Change Info right
// for THAT group is re-verified live before anything is written (the
// /manage discipline — the client is never trusted). Only the fields
// present in `patch` are touched, each strictly validated; the banner
// has no write path here at all.
async function portalSave(tg, input) {
  const chatId = String(input?.chatId ?? '');
  const patchIn = (input?.patch && typeof input.patch === 'object') ? input.patch : {};
  if (!chatId) throw new EndpointError('Pick a group first.', { code: 'NO_GROUP' });
  const homeId = String(await getConfig('TELEGRAM_HOME_CHAT_ID', ''));
  if (chatId === homeId) {
    throw new EndpointError('Portal stays off in the official home group — that chat stays open.', { code: 'HOME_LOCKED' });
  }
  if (!(await canChangeInfo(chatId, tg.id))) {
    throw new EndpointError('You need the Change Info permission in that group to change its Portal.', { code: 'NOT_ADMIN' });
  }
  const patch = {};
  if ('enabled' in patchIn) patch.portal = patchIn.enabled === true;
  if ('timeout' in patchIn) {
    const t = Number(patchIn.timeout);
    if (![30, 60, 120].includes(t)) {
      throw new EndpointError('Timeout must be 30, 60 or 120 seconds.', { code: 'BAD_TIMEOUT' });
    }
    patch.portal_timeout = t;
  }
  if ('mode' in patchIn) {
    if (!PORTAL_MODES.includes(String(patchIn.mode))) {
      throw new EndpointError('Unknown verify mode.', { code: 'BAD_MODE' });
    }
    patch.portal_mode = String(patchIn.mode);
  }
  if ('welcome' in patchIn) {
    if (patchIn.welcome === null) {
      patch.portal_welcome = null;
    } else {
      const w = String(patchIn.welcome ?? '').trim();
      if (w.length > PORTAL_WELCOME_MAX) {
        throw new EndpointError(`Welcome text is capped at ${PORTAL_WELCOME_MAX} characters.`, { code: 'TEXT_TOO_LONG' });
      }
      patch.portal_welcome = w || null;
    }
  }
  if (!Object.keys(patch).length) {
    throw new EndpointError('Nothing to save.', { code: 'EMPTY_PATCH' });
  }
  await setGroupSettings(chatId, patch);
  return { ok: true };
}

// ── Buy competitions (Buy Bot Phase 5 follow-up, 2026-10-21) ────────────
// Mini App setup at parity with the /manage Buy Bot panel wizard: the
// campaign resolves from the group via slots exactly like the panel
// (resolveBuyCampaignForGroup), creation runs through the shared
// startBuyCompetition (the wizard's Start button calls it too — same
// gates, same order, same refusal reasons), and end/cancel run through
// the same finaliseBuyCompetition / cancelBuyCompetition as the
// panel's buttons. EVERY write re-verifies the caller's LIVE Change
// Info right for the group first (the portalSave discipline — the
// client is never trusted). Prizes are text only: the project chooses
// and distributes them; PB never holds or moves funds (the contests
// money rule — the UI copy says so too).

function buyCompStandingsShape(st) {
  if (!st) return null;
  return {
    total: st.total, tickets: st.tickets, uniqueBuyers: st.uniqueBuyers,
    biggest: st.biggest ? {
      usd: Number(st.biggest.usdAmount) || 0,
      buyer: shortAddr(st.biggest.buyerAddress),
    } : null,
  };
}

async function buyCompView(tg) {
  const groups = await getManageGroupsFor(tg.id).catch(() => []);
  const out = [];
  for (const g of groups) {
    const chatId = String(g.chatId);
    const camp = await resolveBuyCampaignForGroup(chatId, tg.id).catch(() => null);
    const entry = {
      chatId,
      title: g.title ?? 'Group',
      campaign: null,
      active: null,
      lastEnded: null,
      // Why the start form is unavailable (null = it can be offered).
      // Mirrors the panel page: the New button renders only for an
      // active campaign with a contract and Buy Bot enabled, and not
      // while one runs. The write re-checks every gate server-side —
      // startBuyCompetition is the real gate (plus its tier gate,
      // whose refusal the start call returns verbatim).
      startBlock: 'no_campaign',
      pausedWarning: false,
    };
    if (camp) {
      entry.campaign = {
        id: camp.id,
        projectName: camp.projectName,
        ticker: camp.ticker,
        chain: camp.chain ?? 'base',
        caShort: shortAddr(camp.contractAddress),
        status: camp.status,
        buyBotEnabled: camp.buyBotEnabled === true,
        buyBotPaused: camp.buyBotPaused === true,
      };
      entry.pausedWarning = camp.buyBotEnabled === true && camp.buyBotPaused === true;
      const active = await getActiveBuyCompetition(chatId, camp.id).catch(() => null);
      if (active) {
        const st = await buyCompetitionStandings(active, true).catch(() => null);
        entry.active = {
          id: active.id, kind: active.kind,
          kindLabel: BUY_COMP_KINDS[active.kind]?.label ?? active.kind,
          prizeText: active.prizeText,
          minBuyUsd: active.minBuyUsd,
          startAt: active.startAt, endAt: active.endAt,
          endsInSec: Math.max(0, active.endAt - Math.floor(Date.now() / 1000)),
          standings: buyCompStandingsShape(st),
        };
        entry.startBlock = 'running';
      } else {
        const last = await getLatestEndedBuyCompetition(chatId, camp.id).catch(() => null);
        if (last) {
          let winnerUsd = null;
          if (last.winnerTxHash) {
            const rows = await buyCompetitionQualifyingBuys(last).catch(() => []);
            const winRow = rows.find((r) => r.txHash === last.winnerTxHash);
            if (winRow) winnerUsd = Number(winRow.usdAmount) || 0;
          }
          entry.lastEnded = {
            id: last.id, kind: last.kind,
            kindLabel: BUY_COMP_KINDS[last.kind]?.label ?? last.kind,
            prizeText: last.prizeText,
            winnerAddress: shortAddr(last.winnerAddress),
            winnerUsd,
          };
        }
        if (!camp.contractAddress) entry.startBlock = 'no_ca';
        else if (camp.status !== 'active') entry.startBlock = 'campaign_inactive';
        else if (!camp.buyBotEnabled) entry.startBlock = 'disabled';
        else entry.startBlock = null;
      }
    }
    out.push(entry);
  }
  return {
    groups: out,
    kinds: Object.entries(BUY_COMP_KINDS).map(([id, k]) => ({ id, label: k.label })),
    durations: BUY_COMP_DURATIONS.map(([sec, label]) => ({ sec, label })),
    prizeMax: BUY_COMP_PRIZE_MAX,
    minBuyMax: BUY_MIN_MAX_USD,
  };
}

async function buyCompGroupGate(tg, input) {
  const chatId = String(input?.chatId ?? '');
  if (!chatId) throw new EndpointError('Pick a group first.', { code: 'NO_GROUP' });
  if (!(await canChangeInfo(chatId, tg.id))) {
    throw new EndpointError(
      'You need the Change Info permission in that group to run its buy competitions.',
      { code: 'NOT_ADMIN' });
  }
  return chatId;
}

async function buyCompStart(tg, input) {
  const chatId = await buyCompGroupGate(tg, input);
  // Input validation mirrors the wizard's own limits exactly: kind
  // from its button set, duration from its button set, min buy the
  // capture's 0..BUY_MIN_MAX_USD range, prize text sliced to
  // BUY_COMP_PRIZE_MAX like the capture + createBuyCompetition do.
  const kind = String(input?.kind ?? '');
  if (!BUY_COMP_KINDS[kind]) {
    throw new EndpointError('Pick a competition kind: Biggest Buy or Raffle.', { code: 'BAD_KIND' });
  }
  const durationSec = Number(input?.durationSec);
  if (!BUY_COMP_DURATIONS.some(([s]) => s === durationSec)) {
    throw new EndpointError('Pick one of the standard durations (1 hour to 7 days).', { code: 'BAD_DURATION' });
  }
  let minBuyUsd = 0;
  if (input?.minBuyUsd !== undefined && input?.minBuyUsd !== null && input?.minBuyUsd !== '') {
    minBuyUsd = Number(input.minBuyUsd);
    if (!Number.isFinite(minBuyUsd) || minBuyUsd < 0 || minBuyUsd > BUY_MIN_MAX_USD) {
      throw new EndpointError(
        `Minimum buy must be a USD amount from 0 up to $${BUY_MIN_MAX_USD.toLocaleString('en-US')}.`,
        { code: 'BAD_MIN_BUY' });
    }
  }
  const prizeText = input?.prizeText ? String(input.prizeText).slice(0, BUY_COMP_PRIZE_MAX) : null;
  const res = await startBuyCompetition({
    chatId, userId: tg.id, kind,
    prizeText: prizeText || null,
    minBuyUsd, durationSec,
  });
  if (!res.ok) {
    // The wizard's refusal texts, verbatim where the wizard has one.
    const map = {
      no_campaign: ['No campaign targets this group yet — nothing to run a competition for.', 'NO_CAMPAIGN'],
      no_ca: ['This campaign has no contract address yet — a competition needs a token to score.', 'NO_CA'],
      tier: ['⛔ The campaign owner\'s plan is below Starter — buy competitions carry the same plan floor as Buy Bot itself.', 'TIER'],
      disabled: ['⛔ Buy Bot is disabled for this campaign — a competition can only count buys the watcher records. Enable Buy Bot first, then start the competition.', 'DISABLED'],
      running: ['A buy competition is already running for this campaign here — end or cancel it first.', 'RUNNING'],
    };
    const [msg, code] = map[res.reason] ?? ['Could not start the competition.', 'START_FAILED'];
    throw new EndpointError(msg, { code });
  }
  return {
    ok: true,
    comp: { id: res.comp.id, kind: res.comp.kind, startAt: res.comp.startAt, endAt: res.comp.endAt },
    campaign: { id: res.camp.id, ticker: res.camp.ticker },
    pausedWarning: res.camp.buyBotPaused === true,
  };
}

async function buyCompEndCancel(tg, input, mode) {
  const chatId = await buyCompGroupGate(tg, input);
  // Same resolution + lifecycle calls as the panel's End Now / Cancel
  // buttons: campaign from the group, its active competition, then
  // finalise (claims + one results post in the group) or cancel
  // (silent retire). A lost race reports the panel's own line.
  const camp = await resolveBuyCampaignForGroup(chatId, tg.id);
  const comp = camp ? await getActiveBuyCompetition(chatId, camp.id) : null;
  if (!comp) {
    throw new EndpointError('No buy competition is running for this campaign here.', { code: 'NO_COMP' });
  }
  if (mode === 'cancel') {
    const ok = await cancelBuyCompetition(comp.id);
    if (!ok) throw new EndpointError('That competition was already finalised.', { code: 'ALREADY_DONE' });
    return { ok: true, cancelled: true, compId: comp.id };
  }
  const res = await finaliseBuyCompetition(comp);
  if (!res.finalised) {
    throw new EndpointError('That competition was already finalised.', { code: 'ALREADY_DONE' });
  }
  return {
    ok: true, ended: true, compId: comp.id,
    winner: res.winner, total: res.total, tickets: res.tickets, uniqueBuyers: res.uniqueBuyers,
  };
}

// ── Trending board (Trending votes wave, 2026-10-21) ──────────────────────
// Read-only. The board is a PUBLIC aggregate (tokens + vote power +
// buy volume) — the same sealed payload the webSync stats push carries
// to the site. `you` is the caller's own rank power only.
async function trendingView(tg) {
  return trendingForUser(tg.id);
}

// ── LaunchPad board (W3, 2026-10-25; NFT lane N3, 2026-11-04) ──────────
// Read-only. Same public payload as /launchpad: site status + listed
// coins (demo + unlisted filtered), each with link-outs. When the site
// API is down the screen renders "unavailable" honestly — never a
// fabricated listing, never a quote. NFT lane: listed drops from the
// N1 /api/lp-nft feed, each with art thumb URL, price, minted/cap,
// window state + link-outs; `myDrops` is the caller's own drops only
// (matched on the platform-verified tg.id against the collection's
// creatorTelegramId — never a client-sent id). Creation + minting link
// OUT to the site: wallets live on the site, the bot never takes a
// signature.
async function launchpadView(tg) {
  const board = await fetchLpBoard().catch(() => null);
  const nftBoard = await fetchLpNftBoard().catch(() => null);
  const nfts = (nftBoard?.collections || []).filter((c) => c.listed && !c.demo).map((c) => ({
    ...c,
    collectionUrl: lpNftCollectionUrl(c), basescanUrl: lpNftBasescanUrl(c),
    chainLabel: lpChainLabel(c.chain), priceDisplay: nftMintPriceDisplay(c),
    mintPct: nftMintPct(c), windowState: nftWindowState(c),
  }));
  const myId = tg?.id != null ? String(tg.id) : '';
  const myDrops = myId ? nfts.filter((c) => c.creatorTelegramId && String(c.creatorTelegramId) === myId) : [];
  if (!board) return { unavailable: true, launchpad: null, writesEnabled: false, note: '', coins: [], nfts, myDrops, nftUnavailable: nftBoard === null, links: { launchpad: LP_SITE, nft: LP_NFT_SITE } };
  const coins = (board.coins || []).filter((c) => c.listed && !c.demo).map((c) => ({
    ...c, coinUrl: lpCoinUrl(c), dexUrl: lpDexUrl(c), chainLabel: lpChainLabel(c.chain),
  }));
  return {
    unavailable: false,
    launchpad: board.status?.launchpad ?? board.launchpad ?? null,
    writesEnabled: board.status?.writesEnabled ?? false,
    note: board.note ?? '', coins, nfts, myDrops,
    nftLaunchpad: nftBoard?.status?.launchpad ?? nftBoard?.launchpad ?? null,
    nftUnavailable: nftBoard === null, nftNote: nftBoard?.note ?? '',
    links: { launchpad: LP_SITE, nft: LP_NFT_SITE },
  };
}

// Watchdog health snapshot (2026-10-22): owner-only. Identity comes from
// ctx.initData via caller() — input fields are never consulted, so a
// spoofed userId in the body buys nothing. Counts only (lib/groups.js).
async function healthSnapshotView(tg) {
  if (!(await isOwnerId(tg?.id))) {
    throw new EndpointError('Owner only.', { code: 'FORBIDDEN' });
  }
  return buildHealthSnapshot();
}

// ── Shield link wizard actions (2026-10-31) ─────────────────────────────
// Backend contract for the Mini App + website wizard UI (sibling children
// build against exactly this — do not rename actions or fields
// unilaterally). All inputs are plain JSON; the caller is ALWAYS
// ctx.initData.user (platform-verified) — never a client-sent isAdmin
// flag. Admin/owner checks are server-side via shieldWizardIsAdmin
// (live getChatMember read or owner set).
//
// wizardList   in: { action, chatId } — chatId is REQUIRED: it is the
//              group the caller's admin right is verified against. The
//              own-list itself is global (it protects every Shield
//              group), so the returned entries are the full list.
//              out: { entries: [{ urlHash, urlDisplay, threat, source,
//              firstSeen, hitCount }], pending: [{ reportId, urlHash,
//              urlDisplay, threat, reporterId, chatId, createdAt }] } —
//              full URLs, admin-only. Pending is this group's reports
//              only (no cross-group reporter leak); entries are global
//              by the rev 497 design.
//              Non-admin → EndpointError NOT_ADMIN. urlDisplay is null
//              for pre-wizard entries (they still list + remove).
// wizardReport in: { action, chatId, url } — chatId REQUIRED (a report
//              belongs to a group). out for a MEMBER: { status:
//              'pending' | 'clean', verdict, threat, source, reportId? }
//              — NEVER a URL. A malicious member report creates a pending
//              row only; it writes NO own-list row and NO cache row (the
//              core judges write:false). A clean report adds nothing.
//              Out for an ADMIN/owner caller: { status: 'added' |
//              'clean', verdict, threat, source, url } — the submit IS
//              the one tap: a malicious admin report writes the own-list
//              immediately (with display URL) and creates no pending row.
//              Empty/invalid url → EndpointError EMPTY_INPUT, no query,
//              no row.
// wizardApprove in: { action, reportId } — admin/owner of the report's
//              group only. Re-judges the stored URL with writes on:
//              still malicious → { status: 'approved', verdict,
//              threat, source } (own-list written by the judge);
//              now clean → { status: 'dismissed', verdict: 'clean',
//              reason: 'now_clean' } (nothing written).
// wizardDismiss in: { action, reportId } — admin/owner of the report's
//              group only. out: { status: 'dismissed' }. No writes.
// wizardRemove in: { action, chatId, urlHash, confirmed } — admin/owner
//              of chatId only. confirmed !== true → EndpointError
//              CONFIRM_REQUIRED and NOTHING changes (the in-chat confirm
//              card is the same gate). confirmed === true → deletes the
//              own-list row, out: { removed: true }.
// Errors: NOT_ADMIN / NOT_FOUND / NOT_PENDING / CONFIRM_REQUIRED /
// EMPTY_INPUT / MISSING_CHAT / JUDGE_FAILED as EndpointError codes.
async function wizardListView(tg, input) {
  const chatId = String(input?.chatId ?? '');
  if (!chatId) throw new EndpointError('chatId is required.', { code: 'MISSING_CHAT' });
  if (!(await shieldWizardIsAdmin(chatId, tg.id))) throw new EndpointError('Group admins only.', { code: 'NOT_ADMIN' });
  const rows = await shieldWizardListOwn();
  const pending = await shieldWizardListPending(chatId);
  return {
    entries: rows.map((r) => ({
      urlHash: r.urlHash, urlDisplay: r.urlDisplay ?? null, threat: r.threat ?? null,
      source: r.source ?? null, firstSeen: r.firstSeen ?? null, hitCount: r.hitCount ?? 1,
    })),
    pending: pending.map((r) => ({
      reportId: r.id, urlHash: r.urlHash, urlDisplay: r.urlDisplay ?? null,
      threat: r.threat ?? null, reporterId: r.reporterId ?? null,
      chatId: r.chatId ?? null, createdAt: r.createdAt ?? null,
    })),
  };
}

async function wizardReportView(tg, input) {
  const chatId = String(input?.chatId ?? '');
  if (!chatId) throw new EndpointError('chatId is required.', { code: 'MISSING_CHAT' });
  const raw = String(input?.url ?? '');
  if (!raw.trim()) throw new EndpointError('Paste a link first.', { code: 'EMPTY_INPUT' });
  const res = await shieldWizardReport({ chatId, reporterId: tg.id, raw });
  if (!res.ok) {
    if (res.error === 'empty_or_invalid') throw new EndpointError('That is not a link PB can judge.', { code: 'EMPTY_INPUT' });
    throw new EndpointError('Could not judge that link right now.', { code: 'JUDGE_FAILED' });
  }
  const isAdmin = await shieldWizardIsAdmin(chatId, tg.id);
  const out = { status: res.status, verdict: res.verdict, threat: res.threat ?? null, source: res.source ?? null };
  if (res.reportId) out.reportId = res.reportId;
  // Full URLs only ever go back to a verified admin (who submitted it).
  if (isAdmin && res.url) out.url = res.url;
  return out;
}

async function wizardApproveView(tg, input) {
  const reportId = String(input?.reportId ?? '');
  if (!reportId) throw new EndpointError('reportId is required.', { code: 'MISSING_REPORT' });
  const res = await shieldWizardApprove(reportId, tg.id);
  if (!res.ok) {
    if (res.error === 'not_found') throw new EndpointError('That report is gone.', { code: 'NOT_FOUND' });
    if (res.error === 'not_admin') throw new EndpointError('Group admins only.', { code: 'NOT_ADMIN' });
    if (res.error === 'not_pending') throw new EndpointError('That report is already decided.', { code: 'NOT_PENDING' });
    throw new EndpointError('Could not decide that report.', { code: 'JUDGE_FAILED' });
  }
  return { status: res.status, verdict: res.verdict, threat: res.threat ?? null, source: res.source ?? null, ...(res.reason ? { reason: res.reason } : {}) };
}

async function wizardDismissView(tg, input) {
  const reportId = String(input?.reportId ?? '');
  if (!reportId) throw new EndpointError('reportId is required.', { code: 'MISSING_REPORT' });
  const res = await shieldWizardDismiss(reportId, tg.id);
  if (!res.ok) {
    if (res.error === 'not_found') throw new EndpointError('That report is gone.', { code: 'NOT_FOUND' });
    if (res.error === 'not_admin') throw new EndpointError('Group admins only.', { code: 'NOT_ADMIN' });
    if (res.error === 'not_pending') throw new EndpointError('That report is already decided.', { code: 'NOT_PENDING' });
    throw new EndpointError('Could not dismiss that report.', { code: 'JUDGE_FAILED' });
  }
  return { status: 'dismissed' };
}

async function wizardRemoveView(tg, input) {
  const chatId = String(input?.chatId ?? '');
  if (!chatId) throw new EndpointError('chatId is required.', { code: 'MISSING_CHAT' });
  const urlHash = String(input?.urlHash ?? '');
  if (!urlHash) throw new EndpointError('urlHash is required.', { code: 'MISSING_HASH' });
  if (input?.confirmed !== true) throw new EndpointError('Removal needs confirmed=true.', { code: 'CONFIRM_REQUIRED' });
  const res = await shieldWizardRemove({ chatId, adminId: tg.id, urlHash, confirmed: true });
  if (!res.ok) {
    if (res.error === 'not_admin') throw new EndpointError('Group admins only.', { code: 'NOT_ADMIN' });
    throw new EndpointError('That entry is already gone.', { code: 'NOT_FOUND' });
  }
  return { removed: true };
}

async function memberExtra(action, input, ctx) {
  const tg = caller(ctx);
  await ensureUser(tg);
  switch (action) {
    case 'scamCheck': return scamCheck(input);
    case 'referrals': return referralsView(tg);
    case 'moneyStatus': return moneyStatus(tg);
    case 'contests': return contestsView(tg);
    case 'digest': return digestOp(tg, input);
    case 'portal': return portalView(tg);
    case 'portalSave': return portalSave(tg, input);
    case 'trending': return trendingView(tg);
    case 'launchpad': return launchpadView(tg);
    case 'buyComp': return buyCompView(tg);
    case 'buyCompStart': return buyCompStart(tg, input);
    case 'buyCompEnd': return buyCompEndCancel(tg, input, 'end');
    case 'buyCompCancel': return buyCompEndCancel(tg, input, 'cancel');
    case 'workerPortal': return getWorkerPortalFor(tg);
    case 'healthSnapshot': return healthSnapshotView(tg);
    case 'wizardList': return wizardListView(tg, input);
    case 'wizardReport': return wizardReportView(tg, input);
    case 'wizardApprove': return wizardApproveView(tg, input);
    case 'wizardDismiss': return wizardDismissView(tg, input);
    case 'wizardRemove': return wizardRemoveView(tg, input);
    default:
      throw new EndpointError(`Unknown dashboard action: ${action}`, { code: 'BAD_ACTION' });
  }
}
