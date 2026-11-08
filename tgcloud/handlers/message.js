// handlers/message.js — PB's front door on Telegram Serverless.
// Runs on each `message` update (payload = the Message; full Update on ctx.update).
// Port of the dispatch core in artifacts/api-server/src/lib/telegram-community-bot.ts:
// global-ban gate -> user ensure -> command parse (catalog dispatch) ->
// DM-only redirects -> natural-language conversation routing -> brain.

import { api, fetch, BotApiError, InputFile } from 'sdk';
import db, { eq, desc, and, sql } from 'sdk/db';
import {
  bot_users,
  global_banned_users,
  known_groups,
  pb_conversations,
  raid_xp,
  group_message_log,
  group_settings,
  fud_state,
  raid_sessions,
  credit_ledger,
  group_members,
  user_settings,
  ad_submissions,
} from '../schema.js';
import {
  isSupportedTelegramCommand,
  resolveCanonicalCommand,
  isDmOnlyCommand,
  TELEGRAM_COMMAND_NAMES,
  TELEGRAM_SETUP_COMMANDS,
  renderHelpText,
  renderHelpChunks,
  registerBotMenus,
} from '../lib/catalog.js';
import { routeTelegramConversation } from '../lib/routing.js';
import { resolveUserKey, loadHistory, saveMessage } from '../lib/memory.js';
import { askBrain, groundMetricReply } from '../lib/brain.js';
import { handleOwnerNLCommand, isAgentLoopActive } from '../lib/nlcmd.js';
import { fetchTokenByAddress, searchToken, priceCard, fmt$, fmtPct, fmtLargeUsd, LP_COMMANDS } from '../lib/market.js';
import {
  WALLET_COMMANDS, handlePortalWalletCapture,
  handleMyWalletCapture, handleXpRewardsWalletCapture,
  TEAM_COMMANDS, handleTeamCapture,
} from '../lib/walletcmds.js';
import { BROADCAST_COMMANDS, DM_BROADCAST_COMMANDS, BLAST_COMMANDS, requestBroadcastPreview, recordDmOptin, parseDmOptinPayload, DM_OPTIN_CONFIRM_TEXT, DM_OPTIN_STOP_KEYBOARD } from '../lib/broadcastcmds.js';
import { RELAY_COMMANDS, handleRelayWizardText, relayGroupHook, mirrorGroupHook } from '../lib/relay.js';
import { STATS_COMMANDS, handleFeedbackWizardText, handleSalesWizardText, maybeStartSalesFromText, maybeStartSalesForCommand, handleSiteWizardText, maybeStartSiteForCommand, maybeListMySitesForCommand, loadMenuCapture, clearMenuCapture, bumpMenuCaptureRetry, MENU_CAP_MAX_RETRIES } from '../lib/statscmds.js';
import { TA_COMMANDS } from '../lib/taindicators.js';
import { OPS_COMMANDS } from '../lib/opscmds.js';
import { resolveScanTarget, runScanAnalysis, ANALYZE_NO_TOKEN_TEXT, scanTextFor, hotGemsText, buildSkillsCard, handleSkillWizardText } from '../lib/skills.js';
import { sendVerdictCard } from '../lib/verdict.js';
import { DIGEST_COMMANDS, LEADS_COMMANDS } from '../lib/digest.js';
import { maybeTick, runDueCycles } from '../lib/tick.js';
import {
  startContestWizard, handleContestWizardText, handleContestStatus, handleContestWinner,
} from '../lib/contests.js';
import {
  getXpCommunityPolicy, getPBRank,
  leaderboardByCompletions, hallOfFame, addXp,
  TRENDING_COMMANDS,
} from '../lib/xp.js';
import {
  detectRaidPlatform, isValidRaidUrl, createRaidSession, endActiveRaids,
  buildRaidText, buildRaidKeyboard, buildEndedText, buildEndedKeyboard,
  raidCardMessages, persistRaidCard, queueRaid, getQueueItems, clearQueue,
  advanceQueue, raidThreadExtra, dmRaidAlerts, parseMetricTargetToken,
  REMOTE_COMMANDS, handleRaidWizardText, handleRemoteWizardText,
  getActiveRaid, postRaidConfirm, sendRaidCardMessage, maybeDropLinkRaid,
  handleRaidBannerCapture, armRaidBanner, clearRaidBanner, userTierOf,
  RAID_BANNER_GATE_TEXT, canSetRaidBanner,
  resolveProfileLatestPost, parseXProfileHandle, profileRaidFailureText,
} from '../lib/raids.js';
import {
  createSquad, joinSquad, leaveSquad, getUserSquad, squadMembers, listSquads,
} from '../lib/squads.js';
import {
  effectiveTier, generatePost, shillShareKeyboard, POST_HEADERS,
  ANNOUNCE_COMMANDS, handleAnnounceWizardText,
} from '../lib/posts.js';
import { rsi, macd, bollinger, rsiVerdict, fetchOHLCV, taCard } from '../lib/ta.js';
import {
  logGroupMessage, recentMessages, transcript, sentimentPulseText,
  handleSupportGroupMessage, handleSupportDmFollowup, tallyRollup, sendGroupReport,
  analyzeGroupVibe, analyzeSenderVibe,
} from '../lib/groupmsg.js';
import { executeImageCommand, armGenerateStylePick, generateStyleKeyboard, getGenerateStyleDefault, handleGenerateCallback } from '../lib/image.js';
import { getConfig, setConfig, flagValueOn, canonicalBooleanConfigKey } from '../lib/config.js';
import {
  linkCodeVerify, SUPPORT_COMMANDS, APPLY_COMMANDS,
  handleSupportCapture, handleApplyWizardText,
  WIZBUY_COMMANDS, WIZBUY_PRODUCTS, handleBuyWizardText, handlePlanbuyText,
  PROMO_COMMANDS, handlePromoCapture, EMAIL_COMMANDS,
  lifecycleOnSignup,
  PAYSUPPORT_COMMANDS, handleStarsSuccessfulPayment,
} from '../lib/websync.js';
import { askLLM, VOICE_COMMANDS, prepareVoiceAnswer, maybeAutoVoice, withTimeout, probeSkipStartIndex, transcribeVoiceNote } from '../lib/llm.js';
import { xPostStatsBoard, xPostStatsBoardText, xPostStatsNoteReply } from '../lib/repurpose.js';
import { decide, recordChatOutcome, recordDecisionOutcome, recordSystemDecision, setPosture, captureOwnerDecision, recallDecisionContext, twinConversation, chatOutcomeLabel } from '../lib/decide.js';
// [relay-fold 2026-10-21] INVITE_COMMANDS moved into lib/referrals.js
// (the module-cap fold — invitecmds.js was a wrapper over this file).
import { INVITE_COMMANDS } from '../lib/referrals.js';
import { STUDIO_COMMANDS, handleStudioWizardText, handleStudioWizardPhoto } from '../lib/studio.js';
import { PODCAST_COMMANDS, PODCAST_SERIES_COMMANDS, handlePodcastWizardText } from '../lib/studio.js';
import { BOOST_COMMANDS, handleBoostWizardText, isBoostWizardActive, boostWizardTouch, boostWizardNextPrompt } from '../lib/boost.js';
import { AIRDROP_COMMANDS, AIRDROP_ADMIN_COMMANDS, BUYREWARDS_COMMANDS, handleAirdropWizardText, isAirdropWizardActive, airdropWizardTouch, airdropWizardNextPrompt } from '../lib/airdrop.js';
import { MONEY_ADMIN_COMMANDS, pickMoneyWizardOrder } from '../lib/moneyguard.js';
import { CAMPAIGN_COMMANDS, SETUP_COMMANDS, handleSetupWizardText } from '../lib/campaigns.js';
import { handleStartReferral } from '../lib/referrals.js';
import { aiCommandAllowance, referralBonus, tierAtLeast, consumeAiCommand, aiCapReachedText, weekTrialStatus, aiUsageToday } from '../lib/tiers.js';

async function isGroupAdmin(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    return ['administrator', 'creator'].includes(m?.status);
  } catch { return false; }
}

// Sends a raid card and persists its location for live updates.
// Raid wave (2026-10-22): the card lands in the session's forum topic
// (raidThreadExtra is empty for non-forum chats — byte-identical there),
// and raid-alert subscribers get their one-tap DM.
// Raid declutter wave (2026-10-31): the send is banner-aware — a stored
// Banner rides as the card's photo caption, and persistRaidCard
// records the shape truthfully so refreshes edit the right way.
async function sendRaidCard(chatId, session) {
  const { sent, hasPhoto } = await sendRaidCardMessage(chatId, session, 0, raidThreadExtra(session));
  if (sent?.message_id) await persistRaidCard(session.id, chatId, sent.message_id, hasPhoto);
  await dmRaidAlerts(session).catch(() => {});
  return sent;
}

// Ends active raids in a chat, updates their cards, announces, and
// auto-launches the next queued raid (source: endAndUpdateActiveRaids + advanceQueue).
// threadId = the ended raid's forum topic (queue-advance cards inherit it).
async function endAndAnnounce(chatId, userId, threadId = null) {
  const ended = await endActiveRaids(chatId);
  for (const e of ended) {
    const msgs = await raidCardMessages(e.id);
    const text = buildEndedText(e.session, e.finalCount, Boolean(e.session.isShillRaid));
    const kb = buildEndedKeyboard(e.session.targetUrl);
    for (const rm of msgs) {
      try {
        // Raid declutter wave: photo cards stub via caption, text via text.
        if (rm.hasPhoto) {
          await api.editMessageCaption({
            chat_id: rm.chatId, message_id: Number(rm.messageId),
            caption: text, reply_markup: kb,
          });
        } else {
          await api.editMessageText({
            chat_id: rm.chatId, message_id: Number(rm.messageId),
            text, reply_markup: kb, disable_web_page_preview: true,
          });
        }
      } catch { /* card gone */ }
    }
  }
  // Auto-advance the queue.
  const advanceThread = threadId ?? ended[0]?.session?.threadId ?? null;
  await advanceQueue(chatId, (next) => sendRaidCard(chatId, next), advanceThread).catch(() => {});
  return ended;
}

const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';

let _me = null;
async function botIdentity() {
  if (!_me) _me = await api.getMe();
  return _me;
}

async function sendSafe(chatId, text, extra = {}) {
  try {
    const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });
    // PB Cleanup capture seam (2026-10-22): records only while a
    // member-command capture is armed for this chat (lib/groups.js).
    await cleanupNoteSent(chatId, sent);
    return sent;
  } catch (err) {
    // 403 = bot blocked/kicked — nothing more to do.
    if (err?.code !== 403) console.error('[send]', err?.code, err?.description ?? err?.message);
  }
}

async function getOrCreateUser(from) {
  if (!from) return null;
  const tgId = String(from.id);
  let row = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, tgId)).get();
  if (!row) {
    const inserted = await db.insert(bot_users).values({
      telegramUserId: tgId,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
    }).returning();
    row = inserted[0] ?? null;
    // OPS-35 (W4): the original paged the owner on every new user
    // (owner-notify.ts notifyOwnerNewUser). Owner DMs only. AWAITED,
    // not fire-and-forget: this runtime drops detached promises when
    // the isolate suspends (the same reason maybeTick is awaited), so
    // an un-awaited page can silently never land. The cost is one
    // config read + one send, once per genuinely new user.
    await notifyOwnersNewUser(from).catch(() => {});
    // LIFECYCLE WAVE (2026-10-27): bot-signup email (DM stays the
    // existing /start). Flag-gated, best-effort, awaited for the same
    // isolate reason; marker-guarded inside so it fires once.
    await lifecycleOnSignup(tgId, {}).catch(() => {});
  }
  return row;
}

/** OPS-35: one "new user" DM per owner (TELEGRAM_OWNER_ID set only). */
async function notifyOwnersNewUser(from) {
  const owners = await ownerIdSet().catch(() => new Set());
  if (!owners.size) return;
  const name = from.first_name ?? (from.username ? `@${from.username}` : 'Unknown');
  const text = [
    '👋 New User Alert',
    '',
    `👤 ${name}${from.username && from.first_name ? ` (@${from.username})` : ''}`,
    `🆔 TG ID: ${from.id}`,
    '📦 Tier: 🆓 Free',
    '🔑 Via: 🤖 Telegram /start',
  ].join('\n');
  for (const ownerId of owners) {
    await api.sendMessage({ chat_id: ownerId, text }).catch(() => {});
  }
}

async function trackGroup(chat) {
  if (!chat || chat.type === 'private') return;
  const chatId = String(chat.id);
  await db.insert(known_groups).values({
    chatId,
    title: chat.title ?? null,
  }).onConflictDoUpdate({
    target: known_groups.chatId,
    set: { title: chat.title ?? null, lastActive: new Date() },
  }).run();
}

function parseCommand(text) {
  const m = /^\/([a-z0-9_]+)(?:@(\w+))?([\s\S]*)$/i.exec((text ?? '').trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), at: m[2] ?? null, args: (m[3] ?? '').trim() };
}

// ── Market tools ──────────────────────────────────────────────────────────────
// fetchTokenByAddress / searchToken / priceCard live in lib/market.js
// (extracted verbatim) so the skills layer shares the exact same code.

async function handlePrice(chatId, args, msg) {
  // FREE-TIER RESHAPE (Rowdy 2026-11-05): live price leaves Free — Starter+
  // floor, so every paid tier and trial keeps it and only Free changes.
  if (msg && !(await tierGate(chatId, msg, 'starter', 'price', 'Starter+'))) return;
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  let address = null;
  if (!args || /^pbai$/i.test(args.replace(/^\$/, ''))) {
    address = PBAI_CA;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(args)) {
    address = args;
  } else {
    const found = await searchToken(args.replace(/^\$/, ''));
    if (found) {
      // v1: GeckoTerminal search resolves network; base lookups only.
      if (found.network === 'base') address = found.address;
    }
  }
  if (!address) {
    await sendSafe(chatId, '⚠️ Couldn’t find that token on Base. Symbol search can miss brand-new tokens — paste the contract address (0x…) directly, or try $PBAI.');
    return;
  }
  // Uniswap API wave (2026-10-28): opt into pool-state enrichment. It
  // runs only for the project coin inside fetchTokenByAddress, and only
  // when a key exists; every other token and every keyless call is
  // untouched. The price itself still comes from GeckoTerminal.
  const t = await fetchTokenByAddress(address, 'base', { uniswapPool: true });
  if (!t) {
    await sendSafe(chatId, '⚠️ Could not fetch price data right now. Try again in a moment.');
    return;
  }
  await sendSafe(chatId, priceCard(t));
}

async function handleScan(chatId, args, msg) {
  // FREE-TIER RESHAPE (Rowdy 2026-11-05): token-safety scans leave Free —
  // Starter+ floor, so every paid tier and trial keeps them.
  if (msg && !(await tierGate(chatId, msg, 'starter', 'scan', 'Starter+'))) return;
  const addr = (args ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    await sendSafe(chatId, '🛡️ Usage: /scan <contract address> — paste a Base (0x…) contract to check.');
    return;
  }
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  // The scan text itself lives in lib/skills.js (scanTextFor) so the
  // security_scan skill runs the identical GoPlus read.
  const out = await scanTextFor(addr);
  await sendSafe(chatId, out.text);
  // Shareable verdict card (Edge wave #2) — best-effort; only on a
  // successful scan, never on the failure path.
  if (out.ok) {
    await sendVerdictCard(chatId, addr).catch(() => {});
  }
}

// Menu-button captures (2026-11-05): consumes the tapper's next plain
// message in the chat where a /menu button armed it. Returns true ONLY
// when a capture was armed for this sender in this chat (consumed or
// cleared) — every other message falls through untouched.
// · scan: the message must be a Base contract (the existing 0x+40hex
//   regex, enforced inside handleScan); a valid one runs the existing
//   scan path (scanTextFor + verdict card) in the group. An invalid one
//   gets the /scan usage text and ONE retry; the second invalid input
//   clears the capture.
// · generate: the message is the prompt — Starter+ gate first (same floor
//   as /generate), then the existing armGenerateStylePick + gen: style
//   picker in the same chat. No new image engine.
// Commands ('/...') never reach here — the caller only offers plain text.
async function handleMenuCaptureText(chatId, message, text) {
  const userId = message.from?.id;
  if (!userId) return false;
  const cap = await loadMenuCapture(userId);
  if (!cap || String(cap.chatId) !== String(chatId)) return false;
  if (cap.kind === 'scan') {
    const addr = (text ?? '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      if ((cap.retries ?? 0) < MENU_CAP_MAX_RETRIES) await bumpMenuCaptureRetry(userId, cap);
      else await clearMenuCapture(userId);
      await handleScan(chatId, addr, message); // usage text for the invalid input
      return true;
    }
    await clearMenuCapture(userId);
    await handleScan(chatId, addr, message);
    return true;
  }
  if (cap.kind === 'generate') {
    const prompt = (text ?? '').trim();
    if (!prompt) {
      await clearMenuCapture(userId);
      await sendSafe(chatId, '❌ Please provide a prompt. Example: /generate cyberpunk robot trading crypto');
      return true;
    }
    if (!(await tierGate(chatId, message, 'starter', 'generate', 'Starter+'))) {
      await clearMenuCapture(userId);
      return true;
    }
    await clearMenuCapture(userId);
    await armGenerateStylePick(userId, chatId, prompt);
    await sendSafe(chatId, `🎨 Pick a style for your image:\nPrompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`, { reply_markup: generateStyleKeyboard() });
    return true;
  }
  await clearMenuCapture(userId);
  return true;
}

// ── Commands ──────────────────────────────────────────────────────────────────

function helpText() {
  // Wizard-fix wave (2026-10-21): /help renders from the same live
  // catalog the "/" menus register from (lib/catalog.js HELP_SECTIONS) —
  // the old hand-written list was the frozen pre-restore catalog and hid
  // every restored wizard, the exact blind spot Rowdy spot-checked.
  return renderHelpText();
}

const MOVING_NOTICE =
  '🚚 That command is moving into PB\u2019s new home and returns in the next rollout. Core commands (/start /help /price /ca /chart /scan /ask /profile) are live now.';

// Extra working commands that live outside the 100-name catalog (they are the
// natural reverses of cataloged features: ban→unban, note→delnote,
// filter→unfilter, warn→setwarnmax). The catalog stays verbatim; these are
// documented in BUILD_NOTES.
const EXTRA_COMMANDS = new Set(['unban', 'delnote', 'unfilter', 'setwarnmax', 'tick', 'setkey', 'freechat', 'globalboard', 'slayer', 'queue',
  'contest', 'conteststatus', 'contestwinner',
  // Forgotten-features wave, 2026-10-19: ports of the original non-menu handlers
  'mywallet', 'mywatched', 'unwatchwallet', 'broadcast', 'points', 'pointsrank',
  // TTF /kill wave (2026-11-01): /kill is the natural reverse of /alert,
  // like unwatchwallet is of watchwallet — dispatchable, help/menu-listed
  // below, but kept out of the verbatim 100-name TELEGRAM_COMMAND_NAMES.
  'kill',
  'stats', 'groupstats', 'whitepaper', 'moonit', 'rsi', 'macd', 'bollinger',
  'ping', 'globalban', 'globalunban', 'modlist', 'delnext', 'clearnext',
  'disqualify', 'undisqualify', 'lbreset', 'remxp', 'resetwarn', 'resetwelcome',
  'kitregister', 'kitlist', 'kitraid', 'kitraidlist',
  // Raid declutter wave (2026-10-31): PB-Plan-gated custom raid banners.
  'raidbanner',
  'removetoken', 'schedule', 'schedules', 'unschedule', 'settier', 'noads',
  'xstats',
  'enableads', 'checkuser', 'hype', 'addgem', 'removegem', 'gems',
  // registration-only aliases (targets already in COMMANDS)
  'save', 'tagall',
  // Edge wave (2026-10-20): agent digests (lib/digest.js)
  'digest',
  // Community learning wave (2026-10-28): owner-only profile read/edit/wipe.
  'pbprofile', 'pbprofileset', 'pbprofilewipe',
  // DM greeting wave (2026-10-28): owner-only greeting text control.
  'setgreeting',
  // Lead Finder (Autonomous Worker Stage 1, 2026-10-20): owner-only
  // /leads (lib/digest.js LEADS_COMMANDS).
  'leads',
  // Smoketest gate wave (2026-11-02): /smoketest handler lives in
  // lib/moneyguard.js (owner-gated, 0.01 USDC master→watcher TEST) and
  // is help-listed, but the dispatch gate never admitted it — Rowdy's
  // 8:11 PM run answered "I don't know". Admission only; the handler's
  // ownerGateRefuse still decides who can run it.
  'smoketest',
  // Member campaigns (2026-10-20): /campaign panel (lib/campaigns.js)
  'campaign',
  // Group Manager restore Phase 1 (2026-10-20): /manage panel + the
  // /manager alias Rowdy remembers (lib/groups.js MANAGE_COMMANDS).
  'manage', 'manager',
  // Group Manager restore Phase 2 (2026-10-20): whitelist + banned-words
  // commands (lib/groups.js GUARD_COMMANDS).
  'wl', 'addban', 'removeban', 'bans',
  // Group Manager restore Phase 3 (2026-10-21): /crosslink — two-sided
  // Cross Protect group linking (lib/groups.js GUARD_COMMANDS).
  'crosslink',
  // Podcast Studio revival (2026-10-20): /podcast wizard (lib/podcast.js),
  // non-menu while the feature is sample-gated behind podcast_enabled.
  'podcast',
  // Recurring podcast series (2026-11-04): /podcastseries (lib/studio.js),
  // DM-only; same podcast_enabled gate as the wizard.
  'podcastseries',
  // Boost/Airdrop rebuild (2026-10-20): wizards + owner money admin
  // (lib/boost.js, lib/airdrop.js, lib/moneyguard.js). 'boost', 'booster'
  // and 'airdrop' themselves are catalog commands; these are the extras.
  'boostquote', 'myboosts', 'boostdetail', 'mydrops', 'dropdetail', 'dropcancel',
  'moneyops', 'armboost', 'armairdrop', 'moneycaps',
  'dropfee', // owner fee confirm (lib/airdrop.js AIRDROP_ADMIN_COMMANDS)
  // Restore wave 1 (2026-10-25): owner/admin ports — typed, gated as in
  // Replit, never menu/catalog additions (menu stays at 100).
  'booststatus', 'booststop', 'config', 'debug', 'export', 'webhook',
  'protect', 'unprotect',
  // LaunchPad W3 (2026-10-25): read-only /launchpad board (lib/market.js
  // LP_COMMANDS) — typed, never menu/catalog (menu stays at 100).
  'launchpad',
  // Buy Rewards (2026-10-21): owner-only campaign admin (lib/airdrop.js
  // BUYREWARDS_COMMANDS) — setup/status/arm/off/announce.
  'buyrewards',
  // DM broadcast restore (2026-10-21): owner-only /dmbroadcast + /dmstop
  // (lib/broadcastcmds.js DM_BROADCAST_COMMANDS) — the original's
  // bot_users DM blast, rebuilt as a persistent tick-driven job.
  // /dmfollowup joined with the job #6 remainder run: dedupe-aware
  // follow-up seeded from a stopped job's unreached rows.
  'dmbroadcast', 'dmstop', 'dmfollowup',
  // PB Relay Wave 1 (2026-10-21): consent-based channel/group
  // auto-forwarder (lib/relay.js RELAY_COMMANDS) — /relay family +
  // /relaystop + /relayhere. Catalog-described + /help-listed only:
  // the scoped menus are at Telegram's 100-command cap (the /email /
  // /dmfollowup precedent).
  'relay', 'relaystop', 'relayhere',
  // Wizard-restore wave (2026-10-21): /setup member-campaign wizard
  // (lib/campaigns.js), /remote wizard (lib/raids.js), /support + /apply
  // (lib/websync.js), /xprewards (lib/walletcmds.js).
  'setup', 'remote', 'support', 'apply', 'xprewards',
  // Promo codes (2026-10-21): /promo + /redeem DM redemption against the
  // web-side D1 store over the HMAC bridge (lib/websync.js PROMO_COMMANDS).
  'promo', 'redeem',
  // Subscriber email (2026-10-21): /email set / status / off against the
  // site Worker's /api/email/bridge-subscribe over the same HMAC bridge
  // (lib/websync.js EMAIL_COMMANDS). DM-only (catalog TELEGRAM_DM_ONLY).
  'email',
  // Gap-2 voice notes (2026-10-21): /voice auto-read toggle
  // (lib/llm.js VOICE_COMMANDS).
  'voice',
  // Buy Bot Phase 3 (2026-10-21): the direct-command lane (lib/groups.js
  // BUYBOT_COMMANDS) — thin admin setters over the /manage Buy Bot
  // panel's own writes. /settoken is NOT here: it is the established
  // group featured-token catalog command above.
  'setemoji', 'setgif', 'setstep', 'setminbuy', 'setwhale', 'setwhalebal',
  'milestones', 'hourly', 'pause', 'resume', 'cancel',
  // Buy Bot Phase 5 (2026-10-21): /buycomp — member-facing competition
  // standings (lib/groups.js BUYBOT_COMMANDS).
  'buycomp',
  // Trending votes + rank power (2026-10-21): /vote + /trending —
  // rank-weighted community token voting (lib/xp.js TRENDING_COMMANDS).
  'vote', 'trending',
  // Wizard-fix wave (2026-10-21): /menusync (owner menu re-register,
  // inline below like /setkey) + the Connect Socials legs /connecttwitter
  // + /disconnecttwitter (lib/accounts.js SOCIALS_COMMANDS).
  'menusync', 'connecttwitter', 'disconnecttwitter',
  // E4a completeness restores (2026-10-21): support mode, Auto Vision,
  // anti-flood + goodbyes, owner blast variants, the minor bundle and the
  // Elon joke. Catalog-described + /help-listed only — the "/" menus stay
  // at Telegram's 100-command cap (the /relay + /email precedent).
  // ('setsupport' itself is dispatched by the canonical if-chain below,
  // beside /freechat; it is listed here so the catalog gate admits it.)
  'setsupport', 'autoread', 'setflood', 'flood', 'setgoodbye', 'resetgoodbye',
  'pbblast', 'pbnews', 'pbbuynews', 'pbbooster', 'airdropblast',
  'roadmap', 'ecosystem', 'discord', 'volume', 'calloutnow',
  'setcalloutchannel', 'mytoken', 'disqualified', 'scanmods', 'workerpin',
  'supportrecap', 'testbuy', 'testcallout', 'keep_posting_till_elon_reposts',
  // PB Shield (2026-10-21): /shield — group scam-bot protection
  // (lib/groups.js SHIELD_COMMANDS). Catalog-described + /help-listed
  // only — the "/" menus stay at Telegram's 100-command cap.
  'shield',
  // PB Cleanup (2026-10-22): /cleanup — group auto-tidy (lib/groups.js
  // CLEANUP_COMMANDS). Catalog-described + /help-listed only — the "/"
  // menus stay at Telegram's 100-command cap.
  'cleanup',
  // PB Cleanup phase 2 (2026-10-22): /bizclean — business-chat tidy
  // (lib/business.js BIZCLEAN_COMMANDS). Catalog-described +
  // /help-listed only — the "/" menus stay at the cap.
  'bizclean',
  // PB Research packaging wave (2026-10-22): /research — the research
  // suite map card (COMMANDS.research below; buttons route via the
  // research:* callbacks in handlers/callback_query.js). Catalog-
  // described + /help-listed only — the "/" menus stay at the cap.
  'research',
  // PB Announce (2026-10-22): /announce — graphic announcement-post
  // creator (lib/posts.js ANNOUNCE_COMMANDS; ann:* callbacks in
  // handlers/callback_query.js). Catalog-described + /help-listed only
  // — the "/" menus stay at Telegram's 100-command cap.
  'announce',
  // Signal Inlet (2026-10-23): /signals — per-group webhook alert inlet
  // admin (lib/groups.js signalInletCommand; the delivery door is
  // endpoints/signal.js). Catalog-described + /help-listed only — the
  // "/" menus stay at Telegram's 100-command cap.
  'signals',
  // Guarded X loop (2026-10-23): /xqueue — owner-only queue admin for
  // the autonomous @Poorboyai loop (lib/opscmds.js OPS_COMMANDS;
  // engine in lib/repurpose.js). Non-menu, like /setkey.
  'xqueue',
  // Team registry (2026-10-27): owner-only /teamadd → /teamapprove →
  // /teamremove (lib/walletcmds.js TEAM_COMMANDS). Catalog-described +
  // /help-listed only — the "/" menus stay at Telegram's 100-command
  // cap, and the commands are DM-only via TELEGRAM_DM_ONLY_COMMANDS.
  'teamadd', 'teamapprove', 'teamremove']);

// ── Wave 3 helpers: group settings, tier gating, group-topic default ──────────
import {
  getGroupSettings, setGroupSettings, getTarget, isChatAdmin, isProtectedId,
  isOwnerId, ownerIdSet, getWarns, addWarn, resetWarns, getWarnMax, setWarnMax,
  saveNote, getNote, deleteNote, listNotes,
  addFilter, removeFilter, getFilters, matchFilter,
  logCommunityBan, removeCommunityBan, logCommunityMute, removeCommunityMute, fireWelcome,
  fireGoodbye, antiFloodHook, maybeAutoVision, callGeminiVision, DM_VISION_SYSTEM, isSupportModeChat, getSupportModeStatus,
  GROUP_RESTORE_COMMANDS,
  SHIELD_COMMANDS, shieldJoinHook, shieldMessageHook, handleShieldWizardCapture,
  CLEANUP_COMMANDS, cleanupBeginCapture, cleanupEndCapture, cleanupNoteSent,
  cleanupRecordCommand, cleanupServiceHook, cleanupNotePinned,
  getMyGroupsFor, resolveMyGroup, isFreeChatGroup, setFreeChatGroup,
  MANAGE_COMMANDS, handleManageStartPayload,
  GUARD_COMMANDS, handleJoinGates, antiPornHook, bannedWordsHook, adGuardHook,
  mirrorBanToLinkedGroups, handlePortalSetupCapture,
  armSetRulesCapture, clearSetRulesCapture, loadSetRulesCapture, handleSetRulesCapture,
  handleSetupWizardCapture,
  BUYBOT_COMMANDS, handleBuyBotCapture, handleBuyCompCapture,
  captureCommandError, errorLabelForMessage, stampMessagePath,
  stampAnswerSent, stampBrainError, stampBrainSendFailed, stampBrainReplyAttempt, stampTriggered, tallyRoutingExit,
  createBrainReplayJob, updateBrainReplayJob, resolveBrainReplayJob,
  stampDiagHandled, stampDiagTriggered, stampDiagAttempt, stampDiagAnswer, stampDiagBrainError, stampDiagSendFailed,
  loadCommunityProfileForAnswer, buildCommunityContext, recordCommunitySealViolation,
  noteCommunityAnswered, foldCommunityProfile,
  readCommunityProfiles, setCommunityProfileText, wipeCommunityProfiles,
  signalInletCommand,
} from '../lib/groups.js';
import {
  ethBalance, erc20BalanceRaw, checkPbai, walletKind, getUserWallets, setUserWallet,
  addPriceAlert, listPriceAlerts, deletePriceAlert,
  watchWallet, unwatchWallet, listWatched,
  addEvent, listUpcomingEvents, cancelEvent,
  addMilestone, listMilestones, clearMilestones,
  getTwitterHandle, setTwitterHandle, handleXSetupCapture,
  handleSocialsCapture, sendSocialsPanel, SOCIALS_COMMANDS,
  resolveToken, listAirdropCampaigns,
} from '../lib/accounts.js';
import { loadBizSettings, handleBizWizardText, BIZCLEAN_COMMANDS } from '../lib/business.js';

/** Tier gate for a command. Returns true when allowed; sends the gate msg
 *  when not. minTier is a canonical tier ('starter' | 'builder' | 'pro');
 *  the caller's stored tier is compared by canonical rank via tierAtLeast
 *  (O1 fix — legacy name sets mis-gated canonical tiers).
 *
 *  Tier Delegation (2026-10-22): in a GROUP, resolution carries the
 *  delegation context { chatId, commandName: featureName } — a manager
 *  or granted admin of the group borrows the group owner's current tier
 *  for this command (live two-key check in lib/posts.js; money/owner
 *  commands are never delegatable and their gates are not here anyway).
 *  An anonymous-admin post (sender_chat = the chat itself) resolves on
 *  the anon path and NEVER creates a bot_users row for the chat persona.
 *  DMs and every non-group path resolve own-tier exactly as before. */
async function tierGate(chatId, msg, minTier, featureName, label) {
  if (!msg.from) return true;
  const isGroupChat = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
  const ctx = isGroupChat
    ? { chatId, commandName: featureName, chatType: msg.chat.type, senderChat: msg.sender_chat ?? null }
    : null;
  let tier;
  if (ctx?.senderChat && String(msg.sender_chat.id) === String(chatId)) {
    tier = await effectiveTier(null, null, ctx).catch(() => 'free');
  } else {
    const user = await getOrCreateUser(msg.from);
    tier = await effectiveTier(msg.from.id, user, ctx);
  }
  if (tierAtLeast(tier, minTier)) return true;
  // PRICING WAVE: floors are unchanged (add-only) — only the price
  // figure moves to the one price. A grandfathered tier name in the
  // label still means that floor; the PB Plan passes every floor.
  await sendSafe(chatId,
    `⛔ ${label} Required\n\n/${featureName} is available on ${label} plans and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.`);
  return false;
}

/** Group token/topic default for post generators (source: postTopic). */
async function postTopic(arg, chatId) {
  if (arg) return arg;
  const s = await getGroupSettings(chatId);
  return s.tokenLabel ?? s.tokenAddress ?? '$PBAI';
}

// Post-generator command handler factory (mirrors /bullpost etc. in source).
function postCommand(kind, minTier, gateLabel) {
  return async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, minTier, kind, gateLabel))) return;
    const topic = await postTopic(args.trim(), chatId);
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const post = await generatePost(kind, topic);
      await sendSafe(chatId, `${POST_HEADERS[kind](topic)}\n\n${post}`, {
        reply_markup: shillShareKeyboard(post, topic),
      });
    } catch (err) {
      console.error(`[${kind}]`, err?.message ?? err);
      await sendSafe(chatId, '❌ Could not write that right now. Try again shortly.');
    }
  };
}

// ── Wave 3: FUD Shield (rolling 90s window, 3+ unique users, 5-min cooldown) ──
const FUD_WINDOW_MS = 90_000;
const FUD_MIN_USERS = 3;
const FUD_COOLDOWN_MS = 5 * 60_000;

async function fudShieldHook(chatId, text, userId) {
  const settings = await getGroupSettings(chatId);
  if (!settings.fudshield) return;
  const now = Date.now();
  let row;
  try {
    row = await db.select().from(fud_state).where(eq(fud_state.chatId, String(chatId))).get();
  } catch { return; }
  const buf = (row?.messages ?? []).filter((e) => now - e.ts < FUD_WINDOW_MS);
  buf.push({ userId, text: String(text).slice(0, 500), ts: now });
  const unique = new Set(buf.map((e) => e.userId));
  const lastFire = row?.lastFire instanceof Date ? row.lastFire.getTime() : Number(row?.lastFire ?? 0);
  if (unique.size >= FUD_MIN_USERS && now - lastFire >= FUD_COOLDOWN_MS) {
    const sampleLines = buf.slice(-15).map((e) => e.text);
    const sample = sampleLines.join('\n');
    let isFud = false, themes = [];
    // Decision layer (DP-6, Batch 3a — ships gated OFF/shadow): when the
    // fud_check set is LIVE, its typed answers replace the ad-hoc chat-tier
    // call (fire line mirrors today's: is_fud ≥ 0.65 AND coordination ≥ 5).
    // In shadow the incumbent call still decides and the comparison is
    // logged; off/failed → incumbent exactly as before. Windowing and
    // cooldown above stay pure code either way.
    // Posture 'off' → no decide() call at all (per-hook guard: a disabled
    // set costs nothing and logs nothing here; the kill-switch logging in
    // decide() serves the owner-volume surfaces).
    const dOut = (await setPosture('fud_check')) === 'off' ? null : await decide({
      surface: 'fud', questionSet: 'fud_check',
      state: { conversation: twinConversation('fud', sampleLines.length), messages: sampleLines },
      chatId: String(chatId),
    });
    if (dOut?.ok && !dOut.shadow) {
      isFud = (dOut.answers.is_fud?.value ?? 0) >= 0.65 && (dOut.answers.coordination?.value ?? 0) >= 5;
      const theme = dOut.answers.theme?.value;
      themes = theme && theme !== 'other' ? [String(theme).replace(/_/g, ' ')] : [];
      if (dOut.logId) await recordDecisionOutcome(dOut.logId, isFud ? 'fired' : 'silent');
    } else {
      let verdict = null;
      try {
        verdict = await askLLM({
          tier: 'chat',
          maxOutputTokens: 200,
          systemPrompt: 'You are a FUD detection AI. Respond ONLY with JSON: {"is_fud":true/false,"confidence":0-100,"themes":["theme1"]}',
          userMessage: `Are these crypto group messages coordinated FUD (fear/uncertainty/panic spreading from multiple users)?\n\n${sample}`,
        });
      } catch { /* silent fail — FUD detection never disrupts the group */ }
      try {
        const jm = verdict?.match(/\{[\s\S]*\}/);
        if (jm) { const j = JSON.parse(jm[0]); isFud = j.is_fud && (j.confidence ?? 0) >= 65; themes = j.themes ?? []; }
      } catch { /* fall through */ }
      if (dOut?.logId) {
        const dWould = dOut.ok
          ? ((dOut.answers.is_fud?.value ?? 0) >= 0.65 && (dOut.answers.coordination?.value ?? 0) >= 5)
          : null;
        await recordDecisionOutcome(dOut.logId, isFud ? 'incumbent:fired' : 'incumbent:silent', {
          outcomeNote: dWould === null ? `decide-failed:${dOut.reason}` : (dWould === isFud ? 'agree' : 'diverge'),
        });
      }
    }
    if (isFud) {
      const themesCtx = themes.length ? ` Key FUD themes detected: ${themes.join(', ')}.` : '';
      let counter;
      try {
        counter = await askLLM({
          tier: 'chat',
          maxOutputTokens: 300,
          systemPrompt: 'You are PoorBoyAI, a confident community defender. Write a short energetic counter-FUD message (max 120 words). Use emojis. No markdown asterisks. Be positive and factual.',
          userMessage: `Write a counter-FUD response for a crypto community experiencing a coordinated FUD wave.${themesCtx} Reassure holders, highlight community strength, encourage diamond hands. End with a strong close.`,
        });
      } catch {
        counter = '🛡️ FUD ALERT detected! Stay calm, zoom out, and do your own research. This community is stronger than any FUD wave. Diamond hands! 💎🙌';
      }
      await api.sendMessage({ chat_id: chatId, text: `🛡️ FUD Shield Activated\n\n${counter}` }).catch(() => {});
      await db.insert(fud_state).values({ chatId: String(chatId), messages: [], lastFire: new Date(now) })
        .onConflictDoUpdate({ target: fud_state.chatId, set: { messages: [], lastFire: new Date(now) } }).run();
      // Twin wave 1 (C10): a live shield firing is memory-worthy — link
      // the memory row to the decide log row. Proposed-only, label-only,
      // group-scoped (write-only in v1, never retrieved); the silent
      // branch records no row because no action was taken.
      try {
        await recordSystemDecision({
          scope: 'group', chatId: String(chatId),
          topicKey: 'fud-shield', title: 'FUD shield fired',
          decision: 'Twin link: FUD shield counter-message sent (live fud_check action)',
          reasoning: null, status: 'proposed', reasonState: 'not_stated',
          decisionLogId: dOut?.logId ?? null,
        });
      } catch { /* twin link failures never break the shield */ }
      return;
    }
  }
  await db.insert(fud_state).values({ chatId: String(chatId), messages: buf })
    .onConflictDoUpdate({ target: fud_state.chatId, set: { messages: buf } }).run();
}

// ── Wave 3: auto-translate hook (source: /translate management + auto hook) ───
async function autoTranslateHook(chatId, msg, text) {
  const settings = await getGroupSettings(chatId);
  const tr = settings.translate;
  if (!tr?.enabled) return false;
  const t = String(text).trim();
  if (t.length < 8) return false;
  // Decision layer (DP-8, Batch 3b — ships gated OFF/shadow): when the
  // translate_gate set is LIVE, a cheap typed call decides skip-vs-translate
  // before the bulk translation call is spent. is_target_language ≥ 0.90 →
  // skip; ≤ 0.40 → translate; between → translate (a redundant translation
  // is the smaller error for an opted-in group). Shadow/off/failed → the
  // incumbent path below runs exactly as before (in shadow the gate's
  // would-be call is logged for calibration).
  const gOut = (await setPosture('translate_gate')) === 'off' ? null : await decide({
    surface: 'translate', questionSet: 'translate_gate',
    state: { conversation: twinConversation('translate', 1), text: t, targetLanguage: tr.targetLanguage ?? 'English' },
    chatId: String(chatId), actorId: msg.from?.id ?? null,
  });
  if (gOut?.ok && !gOut.shadow) {
    const isTarget = gOut.answers.is_target_language?.value ?? 0;
    if (isTarget >= 0.90) {
      if (gOut.logId) await recordDecisionOutcome(gOut.logId, 'skipped:already-target-language');
      return true;
    }
    if (gOut.logId) await recordDecisionOutcome(gOut.logId, 'translate');
  }
  try {
    const out = await askLLM({
      tier: 'bulk',
      maxOutputTokens: 400,
      systemPrompt: `You are a translator. Detect the language of the message. If it is already English, respond EXACTLY with the single word SAME. Otherwise translate it to ${tr.targetLanguage ?? 'English'}. Reply with only the translation, no commentary.`,
      userMessage: t,
    });
    const clean = (out ?? '').trim();
    if (clean && !/^SAME\b/i.test(clean)) {
      await api.sendMessage({
        chat_id: chatId,
        text: `🌐 ${clean}`,
        reply_to_message_id: msg.message_id,
      }).catch(() => {});
    }
  } catch { /* silent fail — translation errors never disrupt the group */ }
  return true;
}

const COMMANDS = {
  start: async (chatId, args, msg) => {
    await getOrCreateUser(msg.from);
    // Deep-link: /start ref_<userId> or ref_<userId>_x — referral attribution
    // (source: bot | x) + both XP awards + referrer DM (source ~7618; the
    // mechanics live in lib/referrals.js). The welcome below still fires.
    const payload = (args ?? '').trim();
    if (payload.startsWith('ref_') && msg.from?.id) {
      await handleStartReferral(msg.from.id, payload, msg.from)
        .catch((err) => console.error('[start ref]', err?.message ?? err));
    }
    // Deep-link: /start manage — the /manage in-group fallback button lands
    // here (source :7591). Show the caller's group selector when they hold
    // the Change Info right in at least one known group (live check), else
    // the run-/manage-in-group guidance. Replaces the generic welcome for
    // this payload only.
    if (payload === 'manage' && msg.chat?.type === 'private' && msg.from?.id) {
      await handleManageStartPayload(chatId, msg.from.id);
      return;
    }
    // Deep-link: /start buy — the group /howtobuy buttons link here
    // (?start=buy) and the original opened the buy wizard in DM. The
    // port dropped this routing (the payload fell through to the
    // generic welcome) while the group buttons kept pointing at it;
    // restored 2026-10-21 — same wizard surface as /howtobuy in DM.
    if (payload === 'buy' && msg.chat?.type === 'private') {
      await COMMANDS.howtobuy(chatId, '', msg);
      return;
    }
    // Deep-link: /start announce — the Mini App Setups "Announcement Writer"
    // card links here (?start=announce) and the wizard must open in DM.
    // Same shape as the restored /start buy branch above (2026-10-21):
    // private chat only; the Starter+ gate lives inside cmdAnnounce
    // (lib/posts.js announceGate — owner bypass), so no gate here.
    if (payload === 'announce' && msg.chat?.type === 'private') {
      await COMMANDS.announce(chatId, '', msg);
      return;
    }
    // Deep-link: /start dm_optin_<source> — the DM opt-in prompts in the
    // group flows (vote confirmation, trending board, email redirect) link
    // here (?start=dm_optin_vote|trending|email). The tap IS the consent:
    // record it and confirm in DM with the one-tap stop button. Private
    // chat only; anything else falls through to the generic welcome and
    // records nothing.
    const dmOptinSource = parseDmOptinPayload(payload);
    if (dmOptinSource && msg.chat?.type === 'private' && msg.from?.id) {
      // Record first, confirm only on success — never tell a member
      // they're in when the row wasn't written (§5 D12).
      const recorded = await recordDmOptin(msg.from.id, dmOptinSource)
        .then(() => true)
        .catch((err) => { console.error('[start dm_optin]', err?.message ?? err); return false; });
      if (!recorded) {
        await sendSafe(chatId, "Couldn't save that just now — tap the link again in a bit.");
        return;
      }
      await sendSafe(chatId, DM_OPTIN_CONFIRM_TEXT, { reply_markup: DM_OPTIN_STOP_KEYBOARD });
      return;
    }
    // web_app buttons are private-chat only on Telegram — groups get text.
    // The Add-PB row is a startgroup URL: one tap opens Telegram's group
    // picker, and my_chat_member registers the chosen group in known_groups.
    const extra = msg.chat?.type === 'private'
      ? { reply_markup: { inline_keyboard: [
          [{ text: '📱 Open the PB App', web_app: { url: 'https://app8667050062.tgcloud.ai/' } }],
          [{ text: '🧠 PB Skills', callback_data: 'menu:skills' }],
          [{ text: '➕ Add PB to your community', url: 'https://t.me/PoorBoyAI_bot?startgroup=true' }],
        ] } }
      : {};
    await sendSafe(chatId, [
      '👋 Yo, I\u2019m PB — the PoorBoyAI bot. Crypto-native, street-smart, here to help the community win.',
      '',
      'Try me: /price · /scan <CA> · /ask <anything> · /help',
      'I\u2019m settling into my new home — more commands land with each rollout.',
      '',
      '🌐 poorboyai.pages.dev · 📊 /upgrade for Starter+ superpowers',
    ].join('\n'), extra);
  },
  // FIX 6 (2026-10-29): /help is 4195 chars but sendSafe slices at
  // 4000 — it always cut off at "Owner & wizar". Send the chunked
  // render instead, in order; the chunks rejoin to the full text.
  help: async (chatId) => { for (const chunk of renderHelpChunks()) await sendSafe(chatId, chunk); },
  price: async (chatId, args, msg) => { await handlePrice(chatId, args, msg); },
  ca: async (chatId) => {
    await sendSafe(chatId, `🪙 $PBAI contract (Base):\n${PBAI_CA}\n\nTap and hold to copy. Always verify the CA before you buy.`);
  },
  chart: async (chatId, args, msg) => {
    // FREE-TIER RESHAPE (Rowdy 2026-11-07): chart links leave Free — Starter+
    // floor, so every paid tier and trial keeps them (Rowdy's tap 2026-11-07).
    if (!(await tierGate(chatId, msg, 'starter', 'chart', 'Starter+'))) return;
    const addr = /^0x[0-9a-fA-F]{40}$/.test(args) ? args : PBAI_CA;
    await sendSafe(chatId, `📊 Chart\n\nhttps://www.geckoterminal.com/base/tokens/${addr}\nhttps://dexscreener.com/base/${addr}`);
  },
  scan: async (chatId, args, msg) => { await handleScan(chatId, args, msg); },
  // ─── /analyze — Deep AI token analysis (source: handleAnalyze; Pro+
  // gate — canonical rank comparison since the O1 fix; the source's
  // grinder/chad/whale/dev_launch name set mis-gated canonical pro/agency) ──
  analyze: async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, 'pro', 'analyze', 'Pro+'))) return;
    // The pipeline itself lives in lib/skills.js (token_scan) — same code
    // path the plain-English layer calls. Gate + user-facing strings are
    // unchanged from the original port.
    const target = await resolveScanTarget(args, msg?.chat);
    if (target.noToken) {
      await sendSafe(chatId, ANALYZE_NO_TOKEN_TEXT);
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const out = await runScanAnalysis(target.query);
    if (!out.ok) {
      console.error('[analyze]', out.error ?? 'brain failure');
      await sendSafe(chatId, '❌ Could not run the analysis right now. Try again in a moment.');
      return;
    }
    // Verdict-card button (Edge wave #2) when the analysis resolved a token
    // address — the callback lives in handlers/callback_query.js (vcard:).
    // Text is byte-identical either way.
    const analyzedAddr = out.data?.token?.address;
    if (analyzedAddr) {
      await sendSafe(chatId, out.text, {
        reply_markup: { inline_keyboard: [[{ text: '🪪 Verdict card', callback_data: 'vcard:' + analyzedAddr }]] },
      });
    } else {
      await sendSafe(chatId, out.text);
    }
  },
  myid: async (chatId, _args, msg) => {
    const uid = msg.from?.id;
    const idText = `🆔 Your Telegram ID: ${uid ?? 'unknown'}\nChat ID: ${chatId}`;
    // ID-leak fix 2026-10-31: in a group, the ID is never printed
    // where members can see it. DM it; if the DM cannot go through
    // (user never started the bot, or a transient failure), say so
    // in group WITHOUT the number — fail closed, never retry-with-ID.
    if (msg.chat?.type === 'private') {
      await sendSafe(chatId, idText);
      return;
    }
    const dm = uid ? await sendSafe(uid, idText) : null;
    if (dm) {
      await sendSafe(chatId, '🆔 Sent your Telegram ID to your DM — check there.');
    } else {
      await sendSafe(chatId, '🆔 DM the bot first, then run /myid again — your ID is only ever shown in DM, never in a group.');
    }
  },
  pbai: async (chatId) => {
    await sendSafe(chatId, [
      '🪙 $PBAI — PoorBoyAI (Base)',
      `CA: ${PBAI_CA}`,
      'Fair launched on Ape.Store. No presale, no team allocation. LP burned.',
      '',
      '/price for live data · /howtobuy to ape in · DYOR, NFA.',
    ].join('\n'));
  },
  gm: async (chatId) => { await sendSafe(chatId, '☀️ GM fam! Another day to grind. What are we cooking today?'); },
  profile: async (chatId, _args, msg) => {
    const user = await getOrCreateUser(msg.from);
    const xpRows = await db.select().from(raid_xp)
      .where(eq(raid_xp.userId, msg.from.id));
    const totalXp = xpRows.reduce((s, r) => s + (r.xp || 0), 0);
    await sendSafe(chatId, [
      `👤 ${msg.from?.first_name ?? 'Degen'}${msg.from?.username ? ' (@' + msg.from.username + ')' : ''}`,
      `⭐ Tier: ${user?.tier ?? 'free'}`,
      `⚔️ Total XP: ${totalXp.toLocaleString('en-US')}`,
      '',
      'Link your dashboard with /link to sync your tier.',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '💰 XP Rewards', callback_data: 'xprewards:start' }]] },
    });
  },

  // ── Raids — source: /raid handler (line 13733) ────────────────────────────
  raid: async (chatId, args, msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    const arg = (args ?? '').trim();
    // Forum topics (raid wave, 2026-10-22): every reply + card in this
    // handler lands in the topic the command was typed in. threadExtra
    // is empty outside topics — non-forum behavior is byte-identical.
    const threadId = msg.message_thread_id ?? null;
    const threadExtra = threadId != null && Number(threadId) > 0
      ? { message_thread_id: Number(threadId) } : {};

    // /raid stop — admin only (source: line 13742).
    if (arg.toLowerCase() === 'stop') {
      if (!(await isGroupAdmin(chatId, userId))) {
        await sendSafe(chatId, '⛔ Only group admins can stop a raid.', threadExtra);
        return;
      }
      const ended = await endAndAnnounce(chatId, userId, threadId);
      if (!ended.length) {
        await sendSafe(chatId, '⚠️ No active raid in this group.', threadExtra);
      } else {
        const finalCount = ended[0]?.finalCount ?? 0;
        await sendSafe(chatId,
          `🛑 Raid ended!\n\n⚔️ ${finalCount} raider${finalCount !== 1 ? 's' : ''} confirmed. GGs!`, {
            ...threadExtra,
            reply_markup: { inline_keyboard: [[
              { text: '🏆 XP Leaderboard', callback_data: 'lb:ALL' },
              { text: '👤 My Profile', callback_data: 'raid_profile:0' },
            ]]},
          });
      }
      return;
    }

    // /raid lock / unlock — NEW, raid declutter wave (2026-10-31). These
    // REPLACE the lock buttons that left the live card; admins lose no
    // capability. Mirrors /raid stop's isGroupAdmin check and the
    // raid_lock: callback's setChatPermissions shapes exactly.
    if (arg.toLowerCase() === 'lock' || arg.toLowerCase() === 'unlock') {
      const wantLock = arg.toLowerCase() === 'lock';
      if (!(await isGroupAdmin(chatId, userId))) {
        await sendSafe(chatId, wantLock
          ? '⛔ Only group admins can lock the chat.'
          : '⛔ Only group admins can unlock the chat.', threadExtra);
        return;
      }
      const active = await getActiveRaid(chatId);
      if (!active) {
        await sendSafe(chatId, '⚠️ No active raid in this group.', threadExtra);
        return;
      }
      try {
        await api.setChatPermissions({
          chat_id: chatId,
          ...(wantLock
            ? { can_send_messages: false }
            : {
                can_send_messages: true, can_send_audios: true, can_send_documents: true,
                can_send_photos: true, can_send_videos: true, can_send_other_messages: true,
                can_add_web_page_previews: true,
              }),
        });
      } catch { /* may lack rights — still record intent */ }
      await db.update(raid_sessions).set({ isLocked: wantLock })
        .where(eq(raid_sessions.id, active.id)).run().catch(() => {});
      await sendSafe(chatId, wantLock
        ? '🔒 Chat locked during this raid.'
        : '🔓 Chat unlocked.', threadExtra);
      return;
    }

    // /raid <url> [raiders] [likes/reposts/replies] — the source parsed
    // "url targetCount"; the raid tracking wave (2026-10-23) also reads
    // an optional metric-target token (e.g. 50/20/10) in either slot.
    const parts = arg.split(/\s+/).filter(Boolean);
    let url = parts[0] ?? '';
    let targetCount = null;
    let metricTargets;
    let launcherCommunityUrl = null;
    for (const tok of parts.slice(1)) {
      const mt = parseMetricTargetToken(tok);
      if (mt) { metricTargets = mt; continue; }
      if (/^https?:\/\//i.test(tok)) { if (!launcherCommunityUrl) launcherCommunityUrl = tok; continue; }
      if (targetCount == null && /^\d+$/.test(tok)) targetCount = parseInt(tok, 10);
    }

    if (!arg || !/^https?:\/\//i.test(url)) {
      // No URL — show the raid wizard (source: line 13800).
      await sendSafe(chatId, [
        '⚔️ PoorBoy Raid System',
        '',
        'Coordinate your community and earn XP. Pick a raid type:',
        '',
        '🎯 Live Raid — fires a raid card right here in the group',
        '🤖 Shill Raid — raid + auto AI shill post after',
        '📡 Remote Raid — launch from your DMs to a group you admin',
        '',
        'Or just type /raid <url> to fire one instantly.',
      ].join('\n'), {
        ...threadExtra,
        reply_markup: { inline_keyboard: [
          [
            { text: '🎯 Live Raid', callback_data: 'raid:live' },
            { text: '🤖 Shill Raid', callback_data: 'raid:shill' },
          ],
          [{ text: '📡 Remote Raid', callback_data: 'raid:remote' }],
          [
            { text: '🏆 Leaderboard', callback_data: 'raid:lb' },
            { text: '📋 Queue', callback_data: 'queue:view' },
          ],
          // Raid declutter wave: guide + alerts join the menu (the rows
          // they left on the live card land here instead).
          [
            { text: '📖 How to Raid', callback_data: 'raid_guide' },
            { text: '🔔 Get Raid Alerts', callback_data: 'raid_subscribe' },
          ],
        ]},
      });
      return;
    }

    // Profile raids (wave 2026-11-01): an X profile link resolves to
    // the profile's latest post and then flows through the NORMAL
    // confirm/instant path below — same gates, same card. A failed
    // resolution is a plain refusal; nothing is guessed or invented.
    let communityUrl = null;
    let isProfileRaid = false;
    let profileHandle = null;
    const validity = isValidRaidUrl(url);
    if (!validity.ok && validity.reason === 'x-profile') {
      const resolved = await resolveProfileLatestPost(url).catch(() => ({ ok: false, reason: 'lookup-failed', handle: parseXProfileHandle(url) }));
      if (!resolved.ok) {
        await sendSafe(chatId, profileRaidFailureText(resolved.reason, resolved.handle), threadExtra);
        return;
      }
      url = resolved.postUrl;
      communityUrl = launcherCommunityUrl ?? resolved.communityUrl;
      isProfileRaid = true;
      profileHandle = resolved.handle;
    }

    await getOrCreateUser(msg.from);
    const displayName = msg.from?.first_name ?? msg.from?.username ?? 'Commander';
    const platform = detectRaidPlatform(url);
    // Raid declutter wave: a bare /raid <url> (no explicit metric token
    // or raider count) posts the confirm card instead of firing
    // instantly — same launch, one extra tap, Modify/Ignore added. The
    // advanced path (explicit token/count) still fires instantly.
    if (metricTargets === undefined && targetCount == null) {
      await postRaidConfirm({
        chatId: Number(chatId), url, platform, threadId, droppedBy: userId,
        communityUrl, isProfileRaid, profileHandle,
      });
      return;
    }
    const session = await createRaidSession({
      chatId: Number(chatId), url, platform, targetCount,
      creatorId: userId, creatorName: displayName, threadId,
      ...(metricTargets !== undefined ? { metricTargets } : {}),
      communityUrl, isProfileRaid,
    });
    await sendRaidCard(chatId, session);
  },

  // ── Raid banners — PB-Plan-gated set, group display (declutter wave) ─────
  // /raidbanner arms a 10-minute capture: the admin's next photo/GIF/
  // video in this group becomes the banner riding on raid cards.
  // /raidbanner off clears it (admin, any tier). The PB Plan gate is checked
  // here at arm AND again at capture time (lib/raids.js) — a free/trial user
  // never reaches a banner write path. Viewing a set banner is group
  // display, not a bypass.
  raidbanner: async (chatId, args, msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (msg.chat.type === 'private') {
      await sendSafe(chatId, 'ℹ️ /raidbanner only works in groups.');
      return;
    }
    if (!(await isGroupAdmin(chatId, userId))) {
      await sendSafe(chatId, '⛔ Only group admins can set a raid banner.');
      return;
    }
    const arg = (args ?? '').trim().toLowerCase();
    if (arg === 'off') {
      await clearRaidBanner(chatId);
      await sendSafe(chatId, '🖼️ Raid banner removed — raid cards are text-only again.');
      return;
    }
    const tier = await userTierOf(userId).catch(() => 'free');
    if (!canSetRaidBanner(tier)) {
      await sendSafe(chatId, RAID_BANNER_GATE_TEXT);
      return;
    }
    await armRaidBanner(chatId, userId);
    await sendSafe(chatId, '🖼️ Send the banner photo, GIF, or video here in the group — it will ride on top of raid cards. You have 10 minutes. /raidbanner off removes it.');
  },

  // ── Raid hall of fame — source: /raidrank (line 13842) ────────────────────
  raidrank: async (chatId) => {
    const rows = await hallOfFame(Number(chatId), 10);
    if (!rows.length) {
      await sendSafe(chatId, '🏆 PoorBoyAI Raid Hall of Fame\n\nNo XP earned yet. Be the first — use /raid <url> to launch a raid!');
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const name = r.displayName ?? r.username ?? 'Anon';
      const xpNum = Number(r.xp ?? 0);
      const rank = getPBRank(xpNum);
      return `${medal} ${name} ${rank.emoji} — ${xpNum} XP (${r.raids ?? 0} raids)`;
    });
    await sendSafe(chatId, `🏆 PB Army — Hall of Fame\n\n${lines.join('\n')}`);
  },

  // ── XP leaderboard — source: /lb (line 13909) ─────────────────────────────
  lb: async (chatId, args) => {
    const tf = ((args ?? '').toUpperCase().trim() || 'ALL');
    const labels = { '1D': 'Today', '7D': 'Last 7 Days', '30D': 'Last 30 Days', 'ALL': 'All Time' };
    const seconds = { '1D': 86400, '7D': 7 * 86400, '30D': 30 * 86400 };
    if (!labels[tf]) { await sendSafe(chatId, '⚠️ Usage: /lb [1D|7D|30D|ALL]'); return; }
    const since = tf === 'ALL' ? null : Math.floor(Date.now() / 1000) - seconds[tf];
    const rows = await leaderboardByCompletions(Number(chatId), 10, since);
    if (!rows.length) {
      await sendSafe(chatId, `🏆 Raid XP Leaderboard — ${labels[tf]}\n\nNo raids yet in this timeframe.\n\nLaunch a raid: /raid <url>`);
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const name = r.displayName ?? r.username ?? 'Anon';
      const xpNum = Number(r.xp ?? 0);
      const rank = getPBRank(xpNum);
      return `${medal} ${name} ${rank.emoji} — ${xpNum} XP`;
    });
    await sendSafe(chatId, `🏆 Raid XP Leaderboard — ${labels[tf]}\n\n${lines.join('\n')}`);
  },

  // ── Squads — source: /squad (line 14469) + /squads (line 14617) ────────────
  squad: async (chatId, args, msg) => {
    const chatNum = Number(chatId);
    const userId = msg.from?.id;
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();
    const squadName = parts.slice(1).join(' ').trim();

    if (sub === 'create') {
      if (!squadName) { await sendSafe(chatId, '⚠️ Usage: /squad create <name>'); return; }
      const res = await createSquad(chatNum, squadName, userId);
      if (res.reason === 'already-in-squad') {
        await sendSafe(chatId, "⚠️ You're already in a squad. Use /squad leave first.");
        return;
      }
      if (res.reason === 'name-taken') {
        await sendSafe(chatId, '⚠️ A squad with that name already exists in this group.');
        return;
      }
      await sendSafe(chatId, [
        `⚔️ Squad Created: ${squadName}`,
        '',
        'You are the squad leader. Your raids now earn XP for the squad too.',
        '',
        `Invite soldiers: /squad join ${squadName}`,
      ].join('\n'));
      return;
    }

    if (sub === 'join') {
      if (!squadName) { await sendSafe(chatId, '⚠️ Usage: /squad join <name>'); return; }
      const res = await joinSquad(chatNum, squadName, userId);
      if (res.reason === 'already-in-squad') {
        await sendSafe(chatId, "⚠️ You're already in a squad. Use /squad leave first.");
        return;
      }
      if (res.reason === 'not-found') {
        await sendSafe(chatId, '⚠️ No squad with that name in this group. Check /squads.');
        return;
      }
      const name = msg.from?.first_name ?? msg.from?.username ?? 'Soldier';
      await sendSafe(chatId, `⚔️ ${name} joined squad ${res.squad.name}!\n\nYour raids now earn XP for the squad too. /profile to see squad stats.`);
      return;
    }

    if (sub === 'leave') {
      const res = await leaveSquad(chatNum, userId);
      await sendSafe(chatId, res.ok
        ? "👋 You've left your squad. Use /squad join <name> to enlist in another."
        : "⚠️ You're not in a squad. Use /squad create or /squad join.");
      return;
    }

    // Default /squad — show my squad info.
    const mine = await getUserSquad(userId, chatNum);
    if (!mine) {
      await sendSafe(chatId, [
        '⚔️ PB Army Squads',
        '',
        '/squad create <name> — Form a new squad (you become leader)',
        '/squad join <name> — Join an existing squad',
        '/squad leave — Leave your current squad',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: '🚪 Leave Squad', callback_data: 'squad:leave' }]] },
      });
      return;
    }
    const members = await squadMembers(mine.id);
    const rank = getPBRank(mine.squadXp ?? 0);
    await sendSafe(chatId, [
      `⚔️ Squad: ${mine.name}`,
      `${rank.emoji} ${rank.name} — ${(mine.squadXp ?? 0).toLocaleString('en-US')} squad XP`,
      `👥 ${members.length} member${members.length === 1 ? '' : 's'}`,
    ].join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '🚪 Leave Squad', callback_data: 'squad:leave' }]] },
    });
  },

  squads: async (chatId) => {
    const rows = await listSquads(Number(chatId), 10);
    if (!rows.length) {
      await sendSafe(chatId, '⚔️ PB Army Squads\n\nNo squads yet. Be the first — /squad create <name>');
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      return `${medal} ${r.name} — ${r.squadXp} XP (${r.memberCount} members)`;
    });
    await sendSafe(chatId, `⚔️ PB Army Squad Leaderboard\n\n${lines.join('\n')}`, {
      reply_markup: { inline_keyboard: [[
        { text: '👤 My Profile', callback_data: 'raid_profile:0' },
        { text: '🏆 XP Board', callback_data: 'lb:ALL' },
      ]]},
    });
  },

  // ── Admin XP award — source: /givexp (line ~3600) ──────────────────────────
  givexp: async (chatId, args, msg) => {
    const adminId = msg.from?.id;
    if (!adminId) return;
    if (!(await isGroupAdmin(chatId, adminId))) {
      await sendSafe(chatId, '⛔ Only group admins can give XP.');
      return;
    }
    const community = await getXpCommunityPolicy(chatId);
    if (!community.enabled) {
      await sendSafe(chatId, '⚠️ XP is disabled in this community.\n\nSet the community token with /settoken before awarding XP.');
      return;
    }
    const m = /^@?(\w+)\s+(\d+)/.exec(args ?? '');
    if (!m) { await sendSafe(chatId, '⚠️ Usage: /givexp @username <amount>'); return; }
    const amount = parseInt(m[2], 10);
    if (!amount || amount <= 0) { await sendSafe(chatId, '⚠️ Amount must be a positive number.'); return; }
    const targetUsername = m[1];
    const targets = await db.all(sql`SELECT user_id AS userId, display_name AS displayName FROM raid_xp WHERE chat_id = ${Number(chatId)} AND username = ${targetUsername}`).catch(() => []);
    if (!targets.length) {
      await sendSafe(chatId, `@${targetUsername} hasn't raided in this group yet.`);
      return;
    }
    const xpResult = await addXp(Number(targets[0].userId), Number(chatId), targetUsername, targets[0].displayName, amount);
    await sendSafe(chatId, `⚡ +${xpResult.actualXpEarned} ${community.tokenLabel} XP given to ${targets[0].displayName ?? targetUsername}\nNew total: ${xpResult.newXP} XP`);
  },

  // ── Raid queue — source: /raidnext (line 14692), /queue ────────────────────
  raidnext: async (chatId, args, msg) => {
    const m = /^(https?:\/\/\S+)(?:\s+(\d+))?/.exec((args ?? '').trim());
    if (!m) { await sendSafe(chatId, '⚠️ Usage: /raidnext <url> [target]'); return; }
    if (!isValidRaidUrl(m[1]).ok) { await sendSafe(chatId, '⚠️ That doesn\u2019t look like a raid link. Paste the full URL starting with https://'); return; }
    await queueRaid(
      Number(chatId), m[1], m[2] ? parseInt(m[2], 10) : null,
      msg.from?.id, [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Commander',
    );
    const items = await getQueueItems(Number(chatId));
    await sendSafe(chatId, `📋 Raid queued — position ${items.length} in queue.\n\nIt will launch automatically when the current raid ends.`);
  },

  queue: async (chatId) => {
    const items = await getQueueItems(Number(chatId));
    if (!items.length) {
      await sendSafe(chatId, '📋 Raid Queue\n\nQueue is empty.\n\nAdd raids with: /raidnext <url> [target]');
      return;
    }
    const lines = items.map((it, i) => {
      const p = detectRaidPlatform(it.targetUrl);
      const target = it.targetCount ? ` (target: ${it.targetCount})` : '';
      const url = String(it.targetUrl);
      return `${i + 1}. ${p.emoji} ${p.name}${target}\n   ${url.slice(0, 50)}${url.length > 50 ? '...' : ''}`;
    });
    await sendSafe(chatId, `📋 Raid Queue — ${items.length} queued\n\n${lines.join('\n\n')}\n\nRaids start automatically when the current one ends.\n/delnext <index> to remove a specific entry`, {
      reply_markup: { inline_keyboard: [[
        { text: '🗑️ Clear Entire Queue', callback_data: 'queue:clearall' },
      ]]},
    });
  },
};

// ── Wave 4: group admin/mod suite + account commands ────────────────────────

const SOCIALS = {
  website: 'https://poorboyai.pages.dev',
  twitter: 'https://x.com/PoorboyAI',
  tiktok: 'https://www.tiktok.com/@poorboyai',
  reddit: 'https://www.reddit.com/u/Official-Poorboyai/s/sMFPfNoESv',
  facebook: 'https://www.facebook.com/share/1BiwyCtcRB/',
  whatsapp: 'https://whatsapp.com/channel/0029VbD9YNyJf05cRJ4N0z2k',
  telegram: 'https://t.me/poorboyai',
  discord: 'https://discord.gg/Jk2tzNphr6',
  buy: 'https://ape.store/refer/4Ah6P69TEESczvFfL53S9g/8453/0x023f98c2f47edb09ee0d0bc9133d236fc82d060e',
  chart: 'https://www.geckoterminal.com/base/tokens/0x023f98c2f47edb09ee0d0bc9133d236fc82d060e',
  baseApp: 'https://base.app/coin/base-mainnet/0x023f98c2f47edb09ee0d0bc9133d236fc82d060e',
  miniApp: 'https://app8667050062.tgcloud.ai/',
  launchpad: 'https://poorboyai.pages.dev/launchpad',
  dashboard: 'https://app8667050062.tgcloud.ai/',
  bot: 'https://t.me/PoorBoyAI_bot',
  support: 'https://t.me/poorboyai_agent_support',
};

// Setup Wizard (2026-11-04): the /socials card lines for a chat. A group's
// group_socials setting overrides ONLY the 8 community-facing fields;
// bot/support/buy/chart/baseApp/miniApp/launchpad/contract stay PB's.
// Empty overrides reproduce the official card exactly (proven, not assumed).
export async function socialsCardLines(chatId) {
  let over = {};
  try {
    const s = await getGroupSettings(chatId);
    if (s?.group_socials && typeof s.group_socials === 'object' && !Array.isArray(s.group_socials)) over = s.group_socials;
  } catch { over = {}; }
  const pick = (k) => { const v = String(over[k] ?? '').trim(); return v || SOCIALS[k]; };
  return [
    '🌐 PoorBoyAI — Official Links',
    '',
    `🌐 Website: ${pick('website')}`,
    `🤖 Telegram Bot: ${SOCIALS.bot}`,
    `💬 Support: ${SOCIALS.support}`,
    `🎮 Discord: ${pick('discord')}`,
    `📊 Dashboard: ${SOCIALS.miniApp}`,
    `🚀 LaunchPad: ${SOCIALS.launchpad}`,
    '🐙 GitHub: https://github.com/PoorBoyAi',
    `🐦 Twitter/X: ${pick('twitter')}`,
    `🎵 TikTok: ${pick('tiktok')}`,
    `🟠 Reddit: ${pick('reddit')}`,
    `📘 Facebook: ${pick('facebook')}`,
    `💬 WhatsApp Channel: ${pick('whatsapp')}`,
    `💬 Telegram Community: ${pick('telegram')}`,
    '',
    `💰 Buy $PBAI (Base): ${SOCIALS.buy}`,
    `📊 Chart: ${SOCIALS.chart}`,
    `🔵 Base App: ${SOCIALS.baseApp}`,
    '',
    '📋 Contract (Base):',
    PBAI_CA,
    '',
    'DYOR • NFA • Just HODL & spread the word!',
    '#PoorBoyAI #PBAI #ToTheMoon',
  ];
}


async function adminGate(chatId, msg, groupOnly = false) {
  if (msg.chat.type === 'private') {
    // W4 refusal polish (final-gate Class A): group-only commands answer
    // in DM with one uniform line instead of going silent.
    if (groupOnly) await sendSafe(chatId, 'ℹ️ This command works in groups only.');
    return false;
  }
  if (!(await isChatAdmin(chatId, msg.from.id))) {
    await sendSafe(chatId, '⛔ Only group admins can use this command.');
    return false;
  }
  return true;
}

async function modGate(chatId, msg, groupOnly = false) {
  // Source: can_restrict_members permission; v1 approximates with admin status.
  if (msg.chat.type === 'private') {
    if (groupOnly) await sendSafe(chatId, 'ℹ️ This command works in groups only.');
    return false;
  }
  if (!(await isChatAdmin(chatId, msg.from.id))) {
    await sendSafe(chatId, '❌ You need admin rights to manage members.');
    return false;
  }
  return true;
}

Object.assign(COMMANDS, {
  // ─── Moderation (source: /ban /unban /kick /mute /unmute) ────────────────
  ban: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const target = await getTarget(msg, (args ?? '').trim() || undefined);
    if (!target) { await sendSafe(chatId, '↩️ Reply to a user or type /ban @username to ban them.'); return; }
    if (await isProtectedId(target.id)) { await sendSafe(chatId, `🛡️ ${target.name} is protected and cannot be banned.`); return; }
    try {
      await api.banChatMember({ chat_id: chatId, user_id: target.id });
      await logCommunityBan(chatId, target, msg.from);
      // Cross Protect (Phase 3): mirror to two-sided linked groups —
      // the source called its mirror helper from /ban ONLY (:21862);
      // kicks, warn-max bans and anti-porn bans never mirror.
      await mirrorBanToLinkedGroups(chatId, target.id);
      await sendSafe(chatId, `🔨 ${target.name} has been banned.`);
    } catch (e) {
      await sendSafe(chatId, `❌ Couldn't ban: ${e?.description ?? e?.message ?? 'unknown error'}`);
    }
  },

  unban: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const arg = (args ?? '').trim();
    let userId = null;
    if (/^\d+$/.test(arg)) {
      userId = Number(arg);
    } else {
      const target = await getTarget(msg, arg);
      if (target) userId = target.id;
    }
    if (!userId) { await sendSafe(chatId, 'Usage: /unban @username or /unban <user_id>.'); return; }
    try {
      await api.unbanChatMember({ chat_id: chatId, user_id: userId });
      await removeCommunityBan(chatId, userId);
      await sendSafe(chatId, `✅ User ${userId} unbanned.`);
    } catch (e) {
      await sendSafe(chatId, `❌ Couldn't unban: ${e?.description ?? e?.message ?? 'unknown error'}`);
    }
  },

  kick: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const target = await getTarget(msg, (args ?? '').trim() || undefined);
    if (!target) { await sendSafe(chatId, '↩️ Reply to a user or type /kick @username to kick them.'); return; }
    if (await isProtectedId(target.id)) { await sendSafe(chatId, `🛡️ ${target.name} is protected and cannot be kicked.`); return; }
    try {
      await api.banChatMember({ chat_id: chatId, user_id: target.id });
      await api.unbanChatMember({ chat_id: chatId, user_id: target.id });
      await sendSafe(chatId, `👢 ${target.name} has been kicked.`);
    } catch (e) {
      await sendSafe(chatId, `❌ Couldn't kick: ${e?.description ?? e?.message ?? 'unknown error'}`);
    }
  },

  mute: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
    let usernameArg; let minutes = 60;
    if (parts.length && /^\d+$/.test(parts[0])) {
      minutes = Math.min(43200, Math.max(1, Number(parts[0])));
    } else if (parts.length) {
      usernameArg = parts[0];
      if (parts[1] && /^\d+$/.test(parts[1])) minutes = Math.min(43200, Math.max(1, Number(parts[1])));
    }
    const target = await getTarget(msg, usernameArg);
    if (!target) { await sendSafe(chatId, '↩️ Reply to a user or type /mute @username [minutes].'); return; }
    if (await isProtectedId(target.id)) { await sendSafe(chatId, `🛡️ ${target.name} is protected and cannot be muted.`); return; }
    const until = Math.floor(Date.now() / 1000) + minutes * 60;
    try {
      await api.restrictChatMember({
        chat_id: chatId, user_id: target.id,
        permissions: { can_send_messages: false }, until_date: until,
      });
      await logCommunityMute(chatId, target, minutes, msg.from);
      await sendSafe(chatId, `🔇 ${target.name} muted for ${minutes} minute(s).`);
    } catch (e) {
      await sendSafe(chatId, `❌ Couldn't mute: ${e?.description ?? e?.message ?? 'unknown error'}`);
    }
  },

  unmute: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const target = await getTarget(msg, (args ?? '').trim() || undefined);
    if (!target) { await sendSafe(chatId, '↩️ Reply to a user or type /unmute @username.'); return; }
    try {
      await api.restrictChatMember({
        chat_id: chatId, user_id: target.id,
        permissions: {
          can_send_messages: true, can_send_polls: true, can_send_other_messages: true,
          can_add_web_page_previews: true, can_change_info: false, can_invite_users: true,
          can_pin_messages: false,
        },
      });
      await removeCommunityMute(chatId, target.id);
      await sendSafe(chatId, `🔊 ${target.name} has been unmuted.`);
    } catch (e) {
      await sendSafe(chatId, `❌ Couldn't unmute: ${e?.description ?? e?.message ?? 'unknown error'}`);
    }
  },

  // ─── Warnings (source: /warn /warns — warnMax from group settings) ──────
  warn: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const target = await getTarget(msg);
    if (!target) { await sendSafe(chatId, '↩️ Reply to a user to warn them.'); return; }
    if (await isProtectedId(target.id)) { await sendSafe(chatId, `🛡️ ${target.name} is protected and cannot be warned.`); return; }
    const reason = (args ?? '').trim();
    const entry = await addWarn(chatId, target.id, reason);
    const max = await getWarnMax(chatId);
    if (entry.count >= max) {
      try {
        await api.banChatMember({ chat_id: chatId, user_id: target.id });
        await sendSafe(chatId, `🔨 ${target.name} reached ${max} warnings and has been banned.`);
      } catch {
        await sendSafe(chatId, `⚠️ ${target.name} reached ${max} warnings (ban failed — check my admin rights).`);
      }
    } else {
      await sendSafe(chatId, `⚠️ ${target.name} warned (${entry.count}/${max})${reason ? `\nReason: ${reason}` : ''}`);
    }
  },

  warns: async (chatId, _args, msg) => {
    const target = await getTarget(msg);
    const userId = target?.id ?? msg.from?.id;
    const name = target?.name ?? msg.from?.first_name ?? 'You';
    if (!userId) return;
    const entry = await getWarns(chatId, userId);
    const max = await getWarnMax(chatId);
    if (entry.count === 0) {
      await sendSafe(chatId, `✅ ${name} has no warnings.`);
      return;
    }
    const list = entry.reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');
    await sendSafe(chatId, `⚠️ ${name}: ${entry.count}/${max} warnings\n\n${list}`);
  },

  setwarnmax: async (chatId, args, msg) => {
    if (!(await modGate(chatId, msg, true))) return;
    const n = Number((args ?? '').trim());
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      await sendSafe(chatId, 'Usage: /setwarnmax <1-10> — users are banned after this many warnings.');
      return;
    }
    await setWarnMax(chatId, n);
    await sendSafe(chatId, `✅ Warn limit set to ${n}. Users get banned after ${n} warnings.`);
  },

  // ─── Pins (source: /pin /unpin) ─────────────────────────────────────────
  pin: async (chatId, _args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const reply = msg.reply_to_message;
    if (!reply) { await sendSafe(chatId, '↩️ Reply to a message to pin it.'); return; }
    try {
      await api.pinChatMessage({ chat_id: chatId, message_id: reply.message_id });
      await sendSafe(chatId, '📌 Message pinned.');
    } catch {
      await sendSafe(chatId, '❌ Could not pin — I need the "Pin Messages" admin right.');
    }
  },

  unpin: async (chatId, _args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const reply = msg.reply_to_message;
    try {
      if (reply) {
        await api.unpinChatMessage({ chat_id: chatId, message_id: reply.message_id });
      } else {
        await api.unpinAllChatMessages({ chat_id: chatId });
      }
      await sendSafe(chatId, '📌 Unpinned.');
    } catch {
      await sendSafe(chatId, '❌ Could not unpin — I need the "Pin Messages" admin right.');
    }
  },

  // ─── Notes (source: /note /get /notes /delnote) ──────────────────────────
  note: async (chatId, args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const m = /^\s*(\S+)(?:\s+([\s\S]+))?$/.exec(args ?? '');
    const name = m?.[1]?.toLowerCase();
    const content = (m?.[2] ?? '').trim() || msg.reply_to_message?.text?.trim();
    if (!name || !content) {
      await sendSafe(chatId, 'Usage: /note <name> <content> — or reply to a message with /note <name>');
      return;
    }
    await saveNote(chatId, name, content);
    await sendSafe(chatId, `✅ Note ${name} saved. Retrieve it with /get ${name} or #${name}`);
  },

  delnote: async (chatId, args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const name = (args ?? '').trim().toLowerCase();
    if (!name) return;
    const deleted = await deleteNote(chatId, name);
    await sendSafe(chatId, deleted ? `✅ Note ${name} deleted.` : `❌ No note named ${name}.`);
  },

  get: async (chatId, args, msg) => {
    // Notes are per-group state (Class A): in DM, answer with the
    // uniform group-only line instead of a silent miss.
    if (msg?.chat?.type === 'private') {
      await sendSafe(chatId, 'ℹ️ This command works in groups only.');
      return;
    }
    const name = (args ?? '').trim().toLowerCase();
    if (!name) return;
    const content = await getNote(chatId, name);
    if (!content) { await sendSafe(chatId, `❌ No note named ${name}.`); return; }
    await sendSafe(chatId, content);
  },

  notes: async (chatId) => {
    const names = await listNotes(chatId);
    if (!names.length) { await sendSafe(chatId, '📝 No notes saved yet.'); return; }
    await sendSafe(chatId, `📝 Saved Notes\n\n${names.map((n) => `• #${n}`).join('\n')}\n\nGet any note with /get <name> or #<name>`);
  },

  // ─── Keyword filters (source: /filter /unfilter /filters) ────────────────
  filter: async (chatId, args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const m = /^\s*(\S+)\s+([\s\S]+)$/.exec(args ?? '');
    const keyword = m?.[1]?.toLowerCase();
    const reply = (m?.[2] ?? '').trim();
    if (!keyword || !reply) {
      await sendSafe(chatId, 'Usage: /filter <keyword> <reply text>');
      return;
    }
    await addFilter(chatId, keyword, reply);
    await sendSafe(chatId, `✅ Filter added: when someone says "${keyword}" I'll reply with your message.`);
  },

  unfilter: async (chatId, args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const keyword = (args ?? '').trim().toLowerCase();
    if (!keyword) return;
    await removeFilter(chatId, keyword);
    await sendSafe(chatId, `✅ Filter "${keyword}" removed.`);
  },

  filters: async (chatId) => {
    const filters = await getFilters(chatId);
    if (!filters.length) { await sendSafe(chatId, '🔍 No keyword filters set.'); return; }
    const list = filters.map((f) => `• ${f.keyword} → ${f.reply.slice(0, 40)}${f.reply.length > 40 ? '…' : ''}`).join('\n');
    await sendSafe(chatId, `🔍 Active Filters\n\n${list}`);
  },

  // ─── Group config (source: /groupinfo /settoken /setwelcome /setrules /rules) ──
  groupinfo: async (chatId, _args, msg) => {
    if (msg.chat.type === 'private') { await sendSafe(chatId, 'This command works in groups only.'); return; }
    let count = 0;
    try { count = (await api.getChatMemberCount({ chat_id: chatId })) ?? 0; } catch { /* ignore */ }
    const s = await getGroupSettings(chatId);
    await sendSafe(chatId, [
      '⚙️ Group Settings',
      '',
      `👥 Members: ${count}`,
      `👋 Welcome msg: ${s.welcomeMsg ? '✅ Set' : '❌ Not set'}`,
      `📋 Rules: ${s.rules ? '✅ Set' : '❌ Not set'}`,
      `📝 Notes: ${Object.keys(s.notes ?? {}).length}`,
      `🔍 Filters: ${(s.filters ?? []).length}`,
      `⚠️ Warn limit: ${s.warnMax ?? 3}`,
      `🪙 Featured token: ${s.tokenLabel ?? s.tokenAddress ?? 'not set'}`,
      `🚪 Goodbye msg: ${s.goodbyeMsg ? '✅ Set' : '❌ Not set'}`,
      `🌊 Antiflood: ${Number(s.antifloodLimit ?? 0) > 0 ? `max ${s.antifloodLimit} per ${s.antifloodSeconds ?? 10}s` : '❌ Off'}`,
      `🎧 Support mode: ${s.supportMode ? '✅ ON' : '❌ OFF'}`,
      `👁️ Auto Vision: ${s.autoVisionEnabled ? `✅ ON (${s.autoVisionCooldownSeconds ?? 30}s cooldown)` : '❌ OFF'}`,
    ].join('\n'));
  },

  settoken: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await sendSafe(chatId, 'ℹ️ /settoken only works in groups.'); return; }
    if (!(await adminGate(chatId, msg))) return;
    const input = (args ?? '').trim();
    if (!input) {
      await sendSafe(chatId, '📋 Usage: /settoken <contract address> [optional name]\nExample: /settoken 0x023f98c2f47edb09ee0d0bc9133d236fc82d060e PBAI');
      return;
    }
    const parts = input.split(/\s+/);
    const addressOrSymbol = parts[0];
    const label = parts.slice(1).join(' ') || undefined;
    if (addressOrSymbol.length < 8) {
      await sendSafe(chatId, '❌ Please provide a contract address.\nExample: /settoken 0x023f98c2f47edb09ee0d0bc9133d236fc82d060e PBAI');
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    let displayName = label ?? addressOrSymbol.slice(0, 10) + '…';
    if (/^0x[0-9a-fA-F]{40}$/.test(addressOrSymbol)) {
      const token = await resolveToken(addressOrSymbol);
      if (token?.name) displayName = label ?? token.name;
      // Track-both wave: a labeled token with no user label stores the
      // label-suffixed name, so the shared 'PBAI' name can never sit
      // ambiguous as a group's featured token.
      if (token?.label && !label) displayName = `${token.name} (${token.label})`;
    }
    await setGroupSettings(chatId, { tokenAddress: addressOrSymbol, tokenLabel: label ?? displayName });
    await sendSafe(chatId, [
      `✅ Featured token set: ${displayName}`,
      '',
      'Now /price, /ta, /scan and /chart default to this token.',
      'Members can still specify any token directly.',
    ].join('\n'));
  },

  // ─── /mytoken (E4a restore; source :15743) — no gate in the source ──────
  // FIX 3 (2026-10-29, partial — /mytoken half only): the home group
  // has a settings row but NO tokenAddress/tokenLabel (verified live
  // 2026-10-29), and a DM has no group token at all, so /mytoken
  // there answered only "No featured token set" — the tester's
  // "returns nothing". Same rule as /analyze (resolveScanTarget):
  // DM and home group fall back to $PBAI; external groups without
  // their own token keep the admin message (PB does not know their
  // token, and guessing one would be worse than the honest note).
  mytoken: async (chatId, _args, msg) => {
    const s = await getGroupSettings(chatId);
    let addr = s.tokenAddress ?? null;
    if (!addr) {
      const homeId = String(await getConfig('TELEGRAM_HOME_CHAT_ID', '') ?? '');
      const isDmOrHome = msg?.chat?.type === 'private' || (homeId && String(chatId) === homeId);
      if (isDmOrHome) addr = PBAI_CA;
    }
    if (!addr) {
      await sendSafe(chatId, [
        '📋 *No featured token set for this group.*',
        '',
        'Admins can set one with /settoken <contract address>.',
        'Once set, /price /ta /scan /chart /analyze will all default to that token.',
        '',
        '🤖 @PoorBoyAI_bot',
      ].join('\n'), { parse_mode: 'Markdown' });
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    let token = null;
    try { token = await fetchTokenByAddress(addr); } catch { token = null; }
    // Wizard-fix wave, pb_scan residual (2026-11-05): the Price button and the
    // Scan button both pointed at the popup-only menu:pb_scan handler, so the
    // card promised two flows it never ran. The price is already on the card
    // body, so Price goes; Scan takes the Oct 27 honest wording, same callback.
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📊 TA Analysis', callback_data: 'menu:pb_ta' },
          { text: '🔍 How to Scan', callback_data: 'menu:pb_scan' },
        ],
        [{ text: '💰 Buy $PBAI (Base)', url: SOCIALS.buy }],
      ],
    };
    if (token) {
      const chg = Number(token.change24h ?? 0);
      await sendSafe(chatId, [
        `🎯 *${token.name} ($${token.symbol})*`,
        '',
        `💰 Price: ${fmt$(token.priceUsd)}`,
        `📈 24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
        `📊 MCap: ${fmtLargeUsd(token.marketCap)}`,
        `💧 Vol: ${fmtLargeUsd(token.volume24h)}`,
        '',
        `📍 CA: \`${addr}\``,
      ].join('\n'), { parse_mode: 'Markdown', reply_markup: keyboard });
      return;
    }
    await sendSafe(chatId, [
      `🎯 *${s.tokenLabel ?? addr.slice(0, 10) + '…'}*`,
      '',
      `📍 CA: \`${addr}\``,
      '',
      'Price data unavailable right now — try /price for a live check.',
    ].join('\n'), { parse_mode: 'Markdown', reply_markup: keyboard });
  },

  setwelcome: async (chatId, args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const text = (args ?? '').trim();
    if (!text || text.toLowerCase() === 'off') {
      await setGroupSettings(chatId, { welcomeMsg: null, welcomeEnabled: false });
      await sendSafe(chatId, '👋 Welcome messages turned off.');
      return;
    }
    await setGroupSettings(chatId, { welcomeMsg: text, welcomeEnabled: true });
    await sendSafe(chatId, [
      '✅ Welcome message saved.',
      '',
      'Placeholders: {name} {username} {group}',
      'Turn it off with /setwelcome off',
    ].join('\n'));
  },

  setrules: async (chatId, args, msg) => {
    const text = (args ?? '').trim();
    // DM form (restored fallback): a live capture gets a reminder; without
    // one, point at the group — rules are per-group state.
    if (msg.chat.type === 'private') {
      const { sess } = await loadSetRulesCapture(msg.from.id);
      if (sess) {
        await sendSafe(chatId, '📋 You have a rules update in progress — just send the new rules for ' + sess.title + ' as your next message and I\'ll apply them.');
      } else {
        await sendSafe(chatId, 'Run /setrules in your group first — I\'ll open the editor here in DM.');
      }
      return;
    }
    if (!(await adminGate(chatId, msg))) return;
    if (text) {
      await setGroupSettings(chatId, { rules: text });
      await sendSafe(chatId, '✅ Group rules saved. Members can read them with /rules.');
      return;
    }
    // No args (restored DM fallback, source ~21783): arm the capture and
    // walk the admin through DM; if the DM can't be opened, post the hint.
    const title = msg.chat.title ?? 'your group';
    await armSetRulesCapture(msg.from.id, chatId, title);
    const dm = await api.sendMessage({
      chat_id: msg.from.id,
      text: '📜 Send the new rules for ' + title + ' — your next message here becomes the group rules (10-minute window).',
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'setrules:cancel' }]] },
    }).catch(() => null);
    if (dm) {
      await sendSafe(chatId, '⚙️ @' + (msg.from.username ?? msg.from.first_name ?? 'admin') + ' — check your DMs to set the group rules for ' + title + '.');
    } else {
      await clearSetRulesCapture(msg.from.id);
      await sendSafe(chatId, '⚠️ I couldn\'t DM you. Open a private chat with me first: https://t.me/PoorBoyAI_bot — or set rules inline: /setrules <text>');
    }
  },

  rules: async (chatId) => {
    const s = await getGroupSettings(chatId);
    if (!s.rules) { await sendSafe(chatId, '📋 No rules set for this group yet.'); return; }
    await sendSafe(chatId, `📋 Group Rules\n\n${s.rules}`);
  },
});


// Send "🔒 Sent to your DM!" in groups and continue in the user's DM
// (source: redirectGroupWizardToDM pattern).
async function dmRedirect(chatId, msg, featureName) {
  if (msg.chat.type === 'private') return chatId;
  await sendSafe(chatId, '🔒 Sent to your DM!');
  return msg.from.id;
}

// XP context chat for DM-run account commands (source: resolveInteractionXpChatId).
async function xpContextChatId(chatId, chatType) {
  if (chatType === 'group' || chatType === 'supergroup') return String(chatId);
  return String(await getConfig('OFFICIAL_XP_CHAT_ID', '-1003931169299'));
}

const TIER_LABELS = {
  free: '🆓 Free', starter: '🌱 Starter', builder: '💼 Builder', pro: '⚡ Pro',
  agency: '🏢 Agency', hustler: '💼 Builder', grinder: '⚡ Pro', chad: '🏢 Agency',
  whale: '🏢 Agency', dev_launch: '🚀 Dev Launch', poor: '🆓 Free',
  one: '⭐ PB Plan', trial: '🎁 Trial',
};

Object.assign(COMMANDS, {
  // ─── Member registration + /everyone (source: /syncmembers /everyone) ───
  syncmembers: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await sendSafe(chatId, '❌ /syncmembers only works in groups.'); return; }
    if (!(await adminGate(chatId, msg))) return;
    if (!(await tierGate(chatId, msg, 'builder', 'syncmembers', 'Builder+'))) return;
    let count = 0;
    try {
      const rows = await db.select().from(group_members)
        .where(eq(group_members.chatId, String(chatId))).all();
      count = rows.length;
    } catch { /* ignore */ }
    await sendSafe(chatId, [
      '🪪 PoorBoy Army — Member Registration',
      '',
      'Hey everyone! Tap the button below to register yourself in the community system.',
      '',
      'Why?',
      '• The bot tracks who\'s here so admins can reach everyone with /everyone',
      '• Registered members get tagged in announcements, raids & alerts',
      '• No info is collected — just your Telegram display name & ID',
      '',
      '👇 Tap once — takes 1 second. You\'ll get a confirmation.',
      '',
      `_${count} member${count === 1 ? '' : 's'} already registered._`,
    ].join('\n'), {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Register Me in the PoorBoy Army!', callback_data: 'army:register' },
      ]]},
    });
  },

  everyone: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await sendSafe(chatId, '❌ /everyone only works in groups.'); return; }
    if (!(await adminGate(chatId, msg))) return;
    if (!(await tierGate(chatId, msg, 'builder', 'everyone', 'Builder+'))) return;
    // Cooldown (source: EVERYONE_COOLDOWN_MS — 10 minutes).
    const s = await getGroupSettings(chatId);
    const last = Number(s.everyoneCooldown ?? 0);
    const remaining = 10 * 60_000 - (Date.now() - last);
    if (remaining > 0) {
      await sendSafe(chatId, `⏳ /everyone is on cooldown — try again in ${Math.ceil(remaining / 60000)} minute(s).`);
      return;
    }
    let members = [];
    try {
      members = await db.select().from(group_members)
        .where(eq(group_members.chatId, String(chatId))).all();
    } catch { /* ignore */ }
    if (!members.length) {
      await sendSafe(chatId, '📣 No registered members yet — run /syncmembers to start registration.');
      return;
    }
    await setGroupSettings(chatId, { everyoneCooldown: Date.now() });
    const text = (args ?? '').trim();
    const tags = members.slice(0, 50).map((m) =>
      m.username ? `@${m.username}` : (m.firstName ?? 'member')
    ).join(' ');
    await sendSafe(chatId, [
      '📣 Announcement',
      text ? `\n${text}` : '',
      '',
      tags,
    ].filter(Boolean).join('\n'));
  },

  // ─── Console linking (source: /link) ───────────────────────────────────
  // The console issues link codes; the bot verifies them against the
  // Worker's /api/internal/link/verify. On success the Worker emits a
  // telegram_link outbox event and the tick stores it + DM-confirms.
  link: async (chatId, args, msg) => {
    if (msg.chat.type !== 'private') {
      await sendSafe(chatId, '🔗 /link only works in a DM — send me /link YOURCODE in a private chat with the bot.');
      return;
    }
    const code = (args ?? '').trim();
    if (!code) {
      await sendSafe(chatId, [
        '🔗 Link Your Console Session',
        '',
        '1. Open the console and sign in',
        '2. Go to My Command Center → tap Get Link Code',
        '3. Run: /link YOURCODE here',
        '',
        'Your bot tier syncs with your console account.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[
          { text: '🌐 Open Console → Get My Code', web_app: { url: SOCIALS.dashboard } },
        ]]},
      });
      return;
    }
    const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
    if (!secret) {
      await sendSafe(chatId, '🔗 PB here — the console link is being wired up. Try again in a bit.');
      return;
    }
    const res = await linkCodeVerify(secret, code, msg.from.id);
    if (res?.ok) {
      await sendSafe(chatId, [
        '✅ Telegram linked to your console session.',
        '',
        'Your console will show the link as verified — once it does, your purchases and tier stay in sync.',
      ].join('\n'));
      return;
    }
    const gone = res?.httpStatus === 404 || res?.httpStatus === 410 ||
      res?.error === 'not_found' || res?.error === 'expired';
    if (gone) {
      await sendSafe(chatId, '❌ That code is invalid or expired — request a fresh one in the console.');
      return;
    }
    await sendSafe(chatId, '🔗 PB could not verify that code right now — try again in a bit.');
  },

  // ─── Wallet connect (source: /connect → raid_xp.wallet_address + registry) ──
  connect: async (chatId, args, msg) => {
    const target = await dmRedirect(chatId, msg, 'connect');
    const wallet = (args ?? '').trim();
    if (!wallet) {
      await sendSafe(target, '💳 Usage: /connect <wallet_address>\n\nLink your wallet to receive token rewards from raid leaders.');
      return;
    }
    if (!walletKind(wallet)) {
      await sendSafe(target, '❌ That doesn\'t look like a Base (0x…) or Solana wallet address.');
      return;
    }
    const set = await setUserWallet(msg.from.id, wallet);
    // Mirror onto the raid_xp row for the XP context chat (source behavior).
    const xpChat = await xpContextChatId(chatId, msg.chat.type);
    try {
      const rows = await db.select().from(raid_xp)
        .where(eq(raid_xp.userId, msg.from.id)).all();
      const row = rows.find((r) => String(r.chatId) === xpChat);
      if (row) {
        await db.update(raid_xp).set({ walletAddress: set.address, updatedAt: new Date() })
          .where(eq(raid_xp.userId, msg.from.id)).run();
      } else {
        await db.insert(raid_xp).values({
          userId: msg.from.id, chatId: Number(xpChat),
          username: msg.from.username ?? null, displayName: msg.from.first_name ?? null,
          walletAddress: set.address, xp: 0,
        }).run();
      }
    } catch { /* wallet registry is authoritative in v1 */ }
    await sendSafe(target, [
      '✅ Wallet connected!',
      '',
      set.address,
      '',
      'You\'re now set to receive token rewards and airdrops.',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [[
        { text: '👤 View Profile', callback_data: `raid_profile:${xpChat}` },
        { text: '🏆 Leaderboard', callback_data: 'lb:ALL' },
      ]]},
    });
  },

  // ─── Holder verification (source: /claimholder — on-chain PBAI check) ───
  claimholder: async (chatId, args, msg) => {
    const target = await dmRedirect(chatId, msg, 'claimholder');
    const uid = msg.from.id;
    const xpChat = await xpContextChatId(chatId, msg.chat.type);
    const wallets = [];
    const reg = await getUserWallets(uid);
    if (reg?.baseAddress) wallets.push(reg.baseAddress);
    if (reg?.solAddress) wallets.push(reg.solAddress);
    try {
      const rows = await db.select().from(raid_xp)
        .where(eq(raid_xp.userId, uid)).all();
      for (const r of rows) if (r.walletAddress) wallets.push(r.walletAddress);
    } catch { /* ignore */ }
    const baseWallets = [...new Set(wallets.filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w)))];
    if (!baseWallets.length) {
      await sendSafe(target, [
        '💎 Verify Your $PBAI Holder Status',
        '',
        'Connect your wallet first:',
        '/connect <your_wallet_address>',
        '',
        'Then run /claimholder again — I\'ll check your $PBAI balance on-chain and unlock your 1.5x XP multiplier.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: '💰 Buy $PBAI (Base)', url: SOCIALS.buy }]] },
      });
      return;
    }
    await api.sendChatAction({ chat_id: target, action: 'typing' }).catch(() => {});
    let verifiedWallet = null; let balance = 0; let rpcOk = false;
    for (const w of baseWallets) {
      const check = await checkPbai(w);
      if (check.available) {
        rpcOk = true;
        if (check.balance > balance) { balance = check.balance; verifiedWallet = w; }
      }
    }
    if (!rpcOk) {
      await sendSafe(target, '⚠️ Holder verification is temporarily unavailable.\n\nI could not reach the chain provider to confirm your wallet balance.\n\nYour holder status and XP were not changed. Run /claimholder again in a moment.');
      return;
    }
    if (balance <= 0) {
      await sendSafe(target, [
        '🔍 No $PBAI found on-chain.',
        '',
        `I checked your connected wallet${baseWallets.length > 1 ? 's' : ''} but couldn't find any $PBAI.`,
        '',
        'Grab some, then run /claimholder again to unlock your 1.5x XP multiplier.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: '💰 Buy $PBAI (Base)', url: SOCIALS.buy }]] },
      });
      return;
    }
    try {
      const rows = await db.select().from(raid_xp)
        .where(eq(raid_xp.userId, uid)).all();
      for (const r of rows) {
        await db.update(raid_xp).set({ pbaiHolder: true, updatedAt: new Date() })
          .where(eq(raid_xp.userId, uid)).run().catch(() => {});
      }
    } catch { /* multiplier flag write best-effort */ }
    const short = verifiedWallet.length > 12
      ? `${verifiedWallet.slice(0, 6)}...${verifiedWallet.slice(-4)}` : verifiedWallet;
    await sendSafe(target, [
      '💎 PBAI Holder Verified On-Chain!',
      '',
      `Found ${Math.floor(balance).toLocaleString('en-US')} $PBAI in ${short}.`,
      '',
      'Your 1.5x XP multiplier is now active on all future raids. 🔥',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        [
          { text: '👤 View My Profile', callback_data: `raid_profile:${xpChat}` },
          { text: '🏆 Leaderboard', callback_data: 'lb:ALL' },
        ],
        [{ text: '💰 Buy $PBAI (Base)', url: SOCIALS.buy }],
      ]},
    });
  },

  // ─── Tier + subscription (source: /mytier) ──────────────────────────────
  mytier: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'mytier');
    const user = await getOrCreateUser(msg.from);
    const tier = await effectiveTier(msg.from.id, user);
    const label = TIER_LABELS[tier] ?? `⭐ ${tier}`;
    const expires = user?.subscriptionExpiresAt
      ? (user.subscriptionExpiresAt instanceof Date ? user.subscriptionExpiresAt : new Date(user.subscriptionExpiresAt))
      : null;
    // PRICING WAVE: a trial account's subscription line is its trial
    // clock (bot_users carries no expiry for trials, by design).
    const wt = await weekTrialStatus(msg.from.id).catch(() => ({ active: false, remaining: 0, endsAt: 0 }));
    let credits = 0;
    try {
      const rows = await db.select().from(credit_ledger)
        .where(eq(credit_ledger.userKey, `telegram:${msg.from.id}`)).all();
      credits = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    } catch { /* ignore */ }
    // Referral bonus term (lib/tiers.js — +3/referral, +5 welcome if referred).
    const allowance = await aiCommandAllowance(tier, msg.from.id).catch(() => null);
    const refInfo = allowance ? await referralBonus(msg.from.id).catch(() => null) : null;
    await sendSafe(target, [
      `👤 ${msg.from.first_name ?? 'Degen'}${msg.from.username ? ' (@' + msg.from.username + ')' : ''}`,
      `${label}`,
      wt.active
        ? `🎁 Trial: until ${new Date(wt.endsAt).toISOString().slice(0, 10)} · ${wt.remaining} trial credits left`
        : (expires ? `📅 Subscription: until ${expires.toISOString().slice(0, 10)}` : '📅 Subscription: free / manual'),
      `🎨 Studio credits: ${credits.toLocaleString('en-US')}`,
      allowance
        ? (allowance.limit === -1
          ? '⚡ AI commands: unlimited on your tier'
          : `⚡ AI commands/day: ${allowance.limit}${allowance.referralBonus > 0 ? ` (incl. +${allowance.referralBonus} referral bonus)` : ''}`)
        : 'Free users get 0 AI commands/day. Upgrade with /upgrade.',
      refInfo && refInfo.referralsMade > 0
        ? `🎁 Referrals: ${refInfo.referralsMade} — each one adds +3 AI commands/day. /invite for your links.`
        : '🎁 Invite friends with /invite — +3 AI commands/day per referral, forever.',
    ].join('\n'));
  },

  // ─── Upgrade picker (source: /upgrade — keyboard, plans copy) ───────────
  upgrade: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'upgrade');
    await sendSafe(target, [
      '🛒 How to Get PoorBoyAI Features',
      '',
      'One price for everything: the PB Plan — $29/mo or $290/yr (2 months free). Or start free for 7 days.',
      '',
      'If you don\'t grab the $29 PB Plan inside those 7 days, you drop to Free: raids and moderation — and you can still earn AI asks by inviting friends.',
      '',
      '👇 Pick a category below:',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        [{ text: '🎁 Start 7-day free trial', callback_data: 'menu:trial:start' }],
        [{ text: '📋 Subscription Plans', callback_data: 'menu:upgrade:plans' }],
        [{ text: '🛒 Buy with PB', callback_data: 'menu:wizbuy' }],
        [{ text: '🚀 Volume Booster', callback_data: 'menu:upgrade:booster' }],
        [{ text: '🪂 Airdrop Campaigns', callback_data: 'menu:upgrade:airdrop' }],
        [{ text: '🎬 Video Ads', callback_data: 'menu:upgrade:videos' }],
        [{ text: '💬 Questions? @Rowdyrawdon', url: 'https://t.me/Rowdyrawdon' }],
      ]},
    });
  },

  // ─── Portfolio + balance (source: /portfolio /balance — Base reads) ─────
  portfolio: async (chatId, args, msg) => {
    const wallet = (args ?? '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      await sendSafe(chatId, '💼 Usage: /portfolio 0xWALLET\nExample: /portfolio 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
      return;
    }
    if (!(await tierGate(chatId, msg, 'builder', 'portfolio', 'Builder+'))) return;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const [eth, pbaiRaw] = await Promise.all([ethBalance(wallet), erc20BalanceRaw(wallet, PBAI_CA)]);
    if (eth == null) { await sendSafe(chatId, '⚠️ Could not reach the chain provider right now.'); return; }
    const pbai = pbaiRaw != null ? Number(pbaiRaw) / 1e18 : 0;
    const short = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
    await sendSafe(chatId, [
      `💼 Portfolio: ${short}`,
      '',
      `⚡ ETH: ${eth.toFixed(6)} ETH`,
      `🤖 PBAI: ${pbai.toLocaleString('en-US')} $PBAI`,
      '',
      `🔗 https://basescan.org/address/${wallet}`,
    ].join('\n'));
  },

  balance: async (chatId, args, msg) => {
    const wallet = (args ?? '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      await sendSafe(chatId, '⚡ Usage: /balance 0xWALLET\nExample: /balance 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
      return;
    }
    if (!(await tierGate(chatId, msg, 'builder', 'balance', 'Builder+'))) return;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const eth = await ethBalance(wallet);
    if (eth == null) { await sendSafe(chatId, '⚠️ Could not reach the chain provider right now.'); return; }
    const short = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
    await sendSafe(chatId, [
      '⚡ ETH Balance',
      '',
      `Wallet: ${short}`,
      `Balance: ${eth.toFixed(6)} ETH`,
      '',
      `🔗 https://basescan.org/address/${wallet}`,
    ].join('\n'));
  },

  // ─── Whale wallet watch (source: /watchwallet — nonce poller on the clock) ──
  watchwallet: async (chatId, args, msg) => {
    const addr = (args ?? '').trim().split(/\s+/)[0] ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      await sendSafe(chatId, [
        '🐋 Whale Wallet Tracker',
        '',
        'Usage: /watchwallet 0xADDRESS [optional label]',
        'Example: /watchwallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 Dev wallet',
        '',
        'Get notified in this chat whenever the wallet makes an outgoing transaction on Base.',
      ].join('\n'));
      return;
    }
    if (!(await tierGate(chatId, msg, 'builder', 'watchwallet', 'Builder+'))) return;
    const label = (args ?? '').trim().split(/\s+/).slice(1).join(' ').slice(0, 40) || addr.slice(0, 10) + '…';
    const res = await watchWallet(msg.from.id, chatId, addr, label);
    if (res.error === 'max') { await sendSafe(chatId, '❌ You\'re already watching 10 wallets.'); return; }
    if (res.error === 'dup') { await sendSafe(chatId, '⚠️ You\'re already watching that wallet.'); return; }
    await sendSafe(chatId, [
      '🐋 Wallet Watch Added',
      '',
      `Label: ${label}`,
      `Address: ${addr}`,
      '',
      '🔔 This chat will be notified whenever this wallet sends a new transaction on Base.',
      `🔗 https://basescan.org/address/${addr}`,
    ].join('\n'));
  },

  // ─── Price alerts (source: /alert — evaluation on the clock wave) ───────
  alert: async (chatId, args, msg) => {
    const arg = (args ?? '').trim();
    if (!arg || /^list$/i.test(arg)) {
      const alerts = await listPriceAlerts(msg.from.id);
      if (!alerts.length) {
        await sendSafe(chatId, '🔔 No active alerts.\n\nUsage: /alert PBAI 0.0005\nYou\'ll be notified in this chat when the price crosses your target.');
        return;
      }
      const lines = alerts.map((a, i) =>
        `${i + 1}. ${a.tokenName ?? a.tokenAddress.slice(0, 10)} ${a.direction === 'above' ? '↑' : '↓'} $${a.targetPrice}`
      );
      await sendSafe(chatId, `🔔 Your Price Alerts\n\n${lines.join('\n')}`);
      return;
    }
    if (!(await tierGate(chatId, msg, 'builder', 'alert', 'Builder+'))) return;
    const parts = arg.split(/\s+/);
    const price = parseFloat(parts[parts.length - 1]);
    const query = parts.slice(0, -1).join(' ');
    if (!query || !Number.isFinite(price) || price <= 0) {
      await sendSafe(chatId, '🔔 Usage: /alert TOKEN PRICE\nExample: /alert PBAI 0.0005');
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const token = await resolveToken(query);
    if (!token || token.price == null) {
      await sendSafe(chatId, '❌ Usage: /alert PBAI 0.0001 — could not resolve that token.');
      return;
    }
    const direction = price > token.price ? 'above' : 'below';
    // Track-both wave: the two PBAI coins share a name, so a labeled token
    // stores and confirms under its label-suffixed name. Unlabeled tokens
    // keep today's behavior exactly.
    const displayName = token.label ? `${token.symbol} · ${token.label}` : token.name;
    await addPriceAlert(msg.from.id, chatId, token.address, displayName, String(price), direction);
    await sendSafe(chatId, [
      '✅ Alert set!',
      '',
      `${displayName} when price goes ${direction} $${price}`,
      `Current: $${token.price}`,
    ].join('\n'));
  },

  // ─── /kill — delete one of your own price alerts (TTF steal, 2026-11-01) ──
  // Wiring only: deletePriceAlert (lib/accounts.js) already exists and
  // refuses any id that is not the caller's own. No tier gate here on
  // purpose: deleting an alert is a reversal, and gating it would trap a
  // user whose alert predates a tier change. Confirm step is the
  // inline-keyboard card below (callback kill:yes:/kill:no: in
  // handlers/callback_query.js); this handler never deletes on its own.
  kill: async (chatId, args, msg) => {
    const arg = (args ?? '').trim();
    const alerts = await listPriceAlerts(msg.from.id);
    const formatAlert = (a, i) =>
      `${i + 1}. ${a.tokenName ?? a.tokenAddress.slice(0, 10)} ${a.direction === 'above' ? '↑' : '↓'} $${a.targetPrice}`;
    if (!alerts.length) {
      await sendSafe(chatId, '🔔 No active alerts to delete.\n\nSet one with /alert TOKEN PRICE, or list yours with /alert.');
      return;
    }
    if (!arg) {
      await sendSafe(chatId, [
        '🔔 Your Price Alerts',
        '',
        ...alerts.map(formatAlert),
        '',
        'Delete one with /kill <number> or /kill <token>.',
        'Example: /kill 2  —  or  /kill PBAI',
      ].join('\n'));
      return;
    }
    if (/^all$/i.test(arg)) {
      await sendSafe(chatId, '🔔 /kill deletes one alert at a time.\n\nPick one from /alert and delete it with /kill <number> or /kill <token>.');
      return;
    }
    let target = null;
    const num = Number(arg);
    if (Number.isInteger(num) && num >= 1 && num <= alerts.length) {
      target = alerts[num - 1];
    } else {
      const q = arg.toLowerCase();
      const matches = alerts.filter((a) => {
        const name = String(a.tokenName ?? '').toLowerCase();
        const addr = String(a.tokenAddress ?? '').toLowerCase();
        const symbol = name.split(/[\s·]+/)[0] ?? '';
        return name === q || symbol === q || addr === q || addr.startsWith(q);
      });
      if (!matches.length) {
        await sendSafe(chatId, `🔔 No alert for "${arg}".\n\nList yours with /alert, then delete one with /kill <number> or /kill <token>.`);
        return;
      }
      if (matches.length > 1) {
        const lines = matches.map((a) => formatAlert(a, alerts.indexOf(a)));
        await sendSafe(chatId, [
          `🔔 ${matches.length} alerts match "${arg}" — pick one:`,
          '',
          ...lines,
          '',
          'Delete one with /kill <number>.',
        ].join('\n'));
        return;
      }
      target = matches[0];
    }
    const label = `${target.tokenName ?? target.tokenAddress.slice(0, 10)} ${target.direction === 'above' ? '↑' : '↓'} $${target.targetPrice}`;
    await sendSafe(chatId, `🗑️ Delete this alert?\n\n${label}\n\nThis only deletes YOUR alert — nothing else changes.`, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Delete', callback_data: `kill:yes:${target.id}` },
        { text: '❌ Cancel', callback_data: `kill:no:${target.id}` },
      ]] },
    });
  },
});


// Resolve "#N" or a chat id against the user's groups (source: resolveMyGroup).
// Implemented in lib/groups.js so handlers can share it.
async function myGroupsFor(userId) { return getMyGroupsFor(userId); }

Object.assign(COMMANDS, {
  // ─── Community events (source: /event — reminders fire on the clock) ───
  event: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await sendSafe(chatId, 'ℹ️ /event only works in groups.'); return; }
    if (!(await adminGate(chatId, msg))) return;
    const arg = (args ?? '').trim();
    if (!arg || arg.toLowerCase() === 'list') {
      const events = await listUpcomingEvents(chatId);
      if (!events.length) {
        await sendSafe(chatId, [
          '📅 No upcoming events.',
          '',
          'Schedule one:',
          '/event "Title" YYYY-MM-DD HH:MM UTC',
          '',
          'Example:',
          '/event "Moon Party" 2026-06-20 20:00 UTC',
        ].join('\n'));
        return;
      }
      const lines = events.map((e) => {
        const dt = e.eventTime instanceof Date ? e.eventTime : new Date(e.eventTime * 1000);
        const diffMs = dt.getTime() - Date.now();
        const diffH = Math.floor(diffMs / 3_600_000);
        const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
        return `📅 ${e.title}\n   🕐 ${dt.toUTCString()}\n   ⏳ In ${diffH > 0 ? `${diffH}h ` : ''}${diffM}m`;
      });
      await sendSafe(chatId, `📅 Upcoming Events\n\n${lines.join('\n\n')}`);
      return;
    }
    if (arg.toLowerCase().startsWith('cancel')) {
      const title = arg.replace(/^cancel\s*/i, '').replace(/^"(.*)"$/, '$1');
      const hit = await cancelEvent(chatId, title);
      await sendSafe(chatId, hit ? `✅ Event ${hit.title} cancelled.` : '❌ No matching event found. Check /event list for exact titles.');
      return;
    }
    const parsed = arg.match(/^"([^"]+)"\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s+UTC)?/i);
    if (!parsed) {
      await sendSafe(chatId, [
        '📅 Schedule an Event',
        '',
        'Format:',
        '/event "Title" YYYY-MM-DD HH:MM UTC',
        '',
        'Example:',
        '/event "Moon Party" 2026-06-20 20:00 UTC',
        '',
        'Other commands:',
        '• /event list — view upcoming events',
        '• /event cancel "Title" — cancel an event',
      ].join('\n'));
      return;
    }
    const eventTime = new Date(`${parsed[2]}T${parsed[3]}:00Z`);
    if (isNaN(eventTime.getTime()) || eventTime.getTime() < Date.now()) {
      await sendSafe(chatId, '❌ Invalid date or date is already in the past. Use UTC time.');
      return;
    }
    await addEvent(chatId, parsed[1], eventTime, msg.from.id);
    const diffMs = eventTime.getTime() - Date.now();
    const diffH = Math.floor(diffMs / 3_600_000);
    const diffM = Math.floor((diffMs % 3_600_000) / 60_000);
    await sendSafe(chatId, [
      '✅ Event Scheduled!',
      '',
      `📅 ${parsed[1]}`,
      `🕐 ${eventTime.toUTCString()}`,
      `⏳ In ${diffH > 0 ? `${diffH}h ` : ''}${diffM}m`,
      '',
      'I\'ll remind the group at 1 hour, 30 minutes, and right at go-time! 🚀',
    ].join('\n'));
  },

  // ─── Price milestones (source: /milestone — celebrations on the clock) ──
  milestone: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await sendSafe(chatId, 'ℹ️ /milestone only works in groups.'); return; }
    if (!(await adminGate(chatId, msg))) return;
    if (!(await tierGate(chatId, msg, 'builder', 'milestone', 'Builder+'))) return;
    const arg = (args ?? '').trim();
    if (!arg || arg.toLowerCase() === 'list') {
      const milestones = await listMilestones(chatId);
      if (!milestones.length) {
        await sendSafe(chatId, [
          '🎯 No active milestones.',
          '',
          'Add one:',
          '/milestone add [CA] $[price] "Label"',
          '',
          'Example:',
          '/milestone add 0x023f98c2f47edb09ee0d0bc9133d236fc82d060e $0.01 "One Cent Achieved!"',
        ].join('\n'));
        return;
      }
      const lines = milestones.map((m) => `🎯 ${m.label} — ${m.tokenName} @ $${m.targetPrice}`);
      await sendSafe(chatId, `🎯 Active Price Milestones\n\n${lines.join('\n')}\n\nI'm watching these and will celebrate in this group the moment any is hit! 🎉`);
      return;
    }
    if (arg.toLowerCase() === 'clear') {
      await clearMilestones(chatId);
      await sendSafe(chatId, '✅ All milestones cleared.');
      return;
    }
    if (arg.toLowerCase().startsWith('add')) {
      const m = arg.match(/^add\s+(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\s+\$?([\d.]+)\s+"([^"]+)"/i);
      if (!m) {
        await sendSafe(chatId, '📋 Usage: /milestone add [CA] $[price] "Label"\n\nExample:\n/milestone add 0x023f98c2f47edb09ee0d0bc9133d236fc82d060e $0.01 "One Cent!"');
        return;
      }
      const targetPrice = parseFloat(m[2]);
      if (!targetPrice || isNaN(targetPrice)) { await sendSafe(chatId, '❌ Invalid price.'); return; }
      await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
      let tokenName = m[1].slice(0, 8) + '...';
      // Track-both wave: the token-aware lookup runs first so a labeled
      // coin stores its label-suffixed name; the Dexscreener read below
      // stays as the fallback for everything it already covered.
      const t = await fetchTokenByAddress(m[1]).catch(() => null);
      if (t?.symbol) tokenName = t.label ? `${t.symbol} · ${t.label}` : t.symbol;
      else {
        try {
          const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${m[1]}`);
          const pairs = (await r.json().catch(() => null))?.pairs ?? [];
          if (pairs.length) tokenName = (pairs[0].baseToken?.symbol ?? tokenName).toUpperCase();
        } catch { /* ignore */ }
      }
      await addMilestone(chatId, m[1], tokenName, String(targetPrice), m[3]);
      await sendSafe(chatId, [
        '🎯 Milestone Added!',
        '',
        `📈 Token: ${tokenName}`,
        `💰 Target: $${targetPrice}`,
        `🏆 Label: ${m[3]}`,
        '',
        'I\'ll watch this price and celebrate the moment it\'s hit! 🎉',
      ].join('\n'));
      return;
    }
    await sendSafe(chatId, 'Commands: /milestone list | /milestone add [CA] $[price] "Label" | /milestone clear');
  },

  // ─── Advertise (W4, OPS-23: in-bot intake RETIRED) ─────────────────────
  // The bot-side flow wrote ad_submissions into a review queue nothing
  // read, promising a review + auto-posting that never happened, while
  // the tick's ad scheduler reads a different table (ad_campaigns) that
  // only migrated rows populate. Advertising is a buy surface and the
  // website owns buying (site↔Telegram ownership rule): the live PB Ads
  // system — submit → auto-vet → owner approval → paid slot — runs at
  // poorboyai.pages.dev/advertise. The in-bot intake is retired honestly
  // rather than wired into a second, unreviewed auto-post path; the
  // ad_campaigns scheduler keeps serving its migrated campaigns.
  advertise: async (chatId) => {
    await sendSafe(chatId, [
      '📢 Advertising runs through PB Ads on the website now:',
      '',
      'https://poorboyai.pages.dev/advertise',
      '',
      'Submit your project there — every ad is vetted and owner-approved before it runs ($5/day, $25/week). The bot no longer takes ad submissions.',
    ].join('\n'));
  },

  // ─── Info commands (source copy, plain-text v1) ─────────────────────────
  about: async (chatId) => {
    await sendSafe(chatId, [
      '🤖 PoorBoyAI ($PBAI) — About',
      '',
      '"AI for the PoorBoy — Power for Everyone."',
      '',
      'NO PRESALE | NO TEAM ALLOCATION | PURE COMMUNITY',
      '',
      'PoorBoyAI is a bootstrapped AI infrastructure project built from the trenches by one person — @Rowdyrawdon, sole Creator, Developer & Owner. We deliver the most complete crypto community bot ecosystem available.',
      '',
      '🪙 Token: $PBAI',
      '⛓️ Chain: Base',
      `📋 Base CA: ${PBAI_CA}`,
      '🚀 Status: LIVE — Bot online 24/7',
      '',
      '/price /ta /scan /ask /generate /sentiment /debate /translate /fudshield /milestone /event /raid /recap /gem /alert …',
      '',
      `🌐 ${SOCIALS.website} | 📊 ${SOCIALS.chart}`,
      `💰 Buy: ${SOCIALS.buy}`,
      `💬 Telegram: ${SOCIALS.telegram} | 🎮 Discord: ${SOCIALS.discord} | 🐦 X: ${SOCIALS.twitter}`,
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        [{ text: '📊 Chart', url: SOCIALS.chart }, { text: '💰 Buy $PBAI (Base)', url: SOCIALS.buy }],
      ]},
    });
  },

  docs: async (chatId) => {
    await sendSafe(chatId, '📚 PoorBoyAI Docs\n\nOfficial documentation and legal resources for the PoorBoy Army 👇', {
      reply_markup: { inline_keyboard: [
        [{ text: '📄 White Paper', url: 'https://poorboyai.pages.dev/whitepaper' }, { text: '🔒 Privacy Policy', url: 'https://poorboyai.pages.dev/privacy' }],
        [{ text: '📋 Terms of Service', url: 'https://poorboyai.pages.dev/terms' }, { text: '⚠️ Disclaimer', url: 'https://poorboyai.pages.dev/disclaimer' }],
      ]},
    });
  },

  menu: async (chatId) => {
    await sendSafe(chatId, [
      '🤖 PoorBoyAI Command Center',
      '_Tap any button to get started_',
      '',
      '🌱 Starter+ — AI posts, raids, Growth Engine Missions',
      '💼 Builder+ — FUD Shield, alerts, and a $20 Custom List credit',
      '⚡ Pro+ — Images, memes, and Twitter/X cross-posting',
      '🏢 Agency — 20 campaign slots and priority support',
      '',
      'Free users get 0 AI cmds/day. /mytier to check yours.',
    ].join('\n'), {
      // FIX 6 (2026-10-29): this text uses _italics_ — without
      // parse_mode Telegram showed the underscores literally.
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🤖 AI Shill Post', callback_data: 'menu:pb_shill' }, { text: '⚔️ Launch Raid', callback_data: 'menu:pb_raid' }],
        [{ text: '📊 TA Analysis', callback_data: 'menu:pb_ta' }, { text: '🔍 How to Scan', callback_data: 'menu:pb_scan' }],
        [{ text: '🚀 Remote Shill', callback_data: 'menu:pb_remoteshill' }, { text: '💼 My Groups', callback_data: 'menu:pb_mygroups' }],
        [{ text: '🖼️ How to Generate', callback_data: 'menu:pb_image' }, { text: '🌙 Moon Post', callback_data: 'menu:pb_moonpost' }],
        [{ text: '⭐ My Tier & Usage', callback_data: 'menu:mytier' }, { text: '🚀 Volume Boost', callback_data: 'menu:boost' }],
        [{ text: '🎬 Video Ads', callback_data: 'menu:pb_videoad' }],
        [{ text: '🧠 PB Skills', callback_data: 'menu:skills' }],
        [{ text: '⭐ Leave a Review', callback_data: 'menu:review' }, { text: '💬 Send Feedback', callback_data: 'menu:feedback' }],
        [{ text: '📋 All Commands', callback_data: 'menu:commands' }, { text: '💎 Upgrade Tier', callback_data: 'menu:subscribe' }],
        [{ text: '💳 Subscribe', callback_data: 'menu:wizbuy' }],
        // Feedback + reviews (2026-11-05): owner-only row — visible only
        // in the owner's own DM (in a group chatId never matches an owner).
        ...((await isOwnerId(chatId).catch(() => false)) ? [[{ text: '📋 Reviews', callback_data: 'fb:owner:list' }]] : []),
      ]},
    });
  },

  // ─── PB Research (packaging wave, 2026-10-22): the suite map card ──────
  // PB's research tools presented as ONE flow — discover → investigate →
  // monitor → act — with a working door per step (research:* callbacks in
  // handlers/callback_query.js; the PB App row is private-only because
  // web_app buttons are). No dead ends: every button lands on a real tool.
  research: async (chatId, args, msg) => {
    const rows = [
      [{ text: '🔥 Trending board', callback_data: 'research:trending' }],
      [{ text: '🔐 Scan a token', callback_data: 'research:scan' }, { text: '🛡️ Scam Radar', callback_data: 'research:scam' }],
      [{ text: '💸 Buy alerts', callback_data: 'research:buyalerts' }, { text: '🐋 Whale watches', callback_data: 'research:whales' }],
    ];
    if (msg?.chat?.type === 'private') {
      rows.push([{ text: '📱 Open the PB App', web_app: { url: 'https://app8667050062.tgcloud.ai/' } }]);
    }
    await sendSafe(chatId, [
      '🔍 PB Research — one kit for the whole hunt',
      '',
      'PB\u2019s research tools aren\u2019t scattered commands — they\u2019re one flow:',
      '',
      '1️⃣ DISCOVER — the Trending board: what\u2019s moving, ranked by community votes + real buy volume.',
      '2️⃣ INVESTIGATE — /scan <CA> checks a token for honeypots, taxes & rug flags. Scam Radar screens contracts, wallets, Telegram handles & X names.',
      '3️⃣ MONITOR — Buy Bot alerts post in your groups the moment a buy lands, and whale watches ping you when a wallet you follow moves.',
      '4️⃣ ACT — buy links, /vote and raids, all one tap from the same research.',
      '',
      'Tap a door:',
    ].join('\n'), { reply_markup: { inline_keyboard: rows } });
  },

  // ─── /skills — PB Skills card (Mini App Chat wave, 2026-11-05) ─────────
  // Tap-to-run skill buttons for the DM. DM-only: my_wallet / my_tier must
  // never post to a group, so a group tap redirects to the DM (dmRedirect).
  skills: async (chatId, args, msg) => {
    const target = await dmRedirect(chatId, msg, 'PB Skills');
    const card = await buildSkillsCard(msg.from);
    await sendSafe(target, card.text, { reply_markup: { inline_keyboard: card.keyboard } });
  },

  socials: async (chatId, _args, msg) => {
    // web_app buttons are private-chat only on Telegram — groups get text.
    // Lines come from socialsCardLines (Setup Wizard, 2026-11-04): same
    // output as before when the group has no overrides.
    const socialsExtra = msg?.chat?.type === 'private'
      ? { reply_markup: { inline_keyboard: [
          [{ text: '📱 Open the PB App', web_app: { url: SOCIALS.miniApp } }],
        ] } }
      : undefined;
    await sendSafe(chatId, (await socialsCardLines(chatId)).join('\n'), socialsExtra);
  },

  status: async (chatId) => {
    let users = 0, groups = 0, alerts = 0, watches = 0;
    try { users = await db.select().from(bot_users).all().then((r) => r.length); } catch { /* ignore */ }
    try { groups = await db.select().from(known_groups).all().then((r) => r.length); } catch { /* ignore */ }
    try { alerts = await db.select().from(price_alerts).all().then((r) => r.length); } catch { /* ignore */ }
    try { watches = await db.select().from(whale_watch_wallets).all().then((r) => r.length); } catch { /* ignore */ }
    await sendSafe(chatId, [
      '⚡ PoorBoyAI Bot Status',
      '',
      '🟢 Community bot: Online',
      `👥 Users tracked: ${users}`,
      `💬 Groups served: ${groups}`,
      `🔔 Active alerts: ${alerts}`,
      `🐋 Wallets watched: ${watches}`,
      '',
      '_All systems operational_',
    ].join('\n'), { parse_mode: 'Markdown' });
  },

  howtobuy: async (chatId, _args, msg) => {
    const isGroup = msg.chat.type !== 'private';
    await sendSafe(chatId, [
      '💰 How to Buy $PBAI',
      '',
      'Hold ETH on Base? Or on Solana, Ethereum, BNB, Polygon — anywhere else?',
      '',
      '🌐 Cross-chain — Pay with any token on any chain. Swap aggregators route it and $PBAI lands in your wallet on Base.',
      '',
      '🔵 Already on Base — Buy directly on Ape.Store or Uniswap. Fastest & cheapest.',
      '',
      '👇 Pick your method below:',
    ].join('\n'), {
      reply_markup: { inline_keyboard: isGroup ? [
        [{ text: '🌐 Buy from any chain (SOL · ETH · BNB · MATIC…)', url: 'https://t.me/PoorBoyAI_bot?start=buy' }],
        [{ text: '🔵 I\'m already on Base', url: 'https://t.me/PoorBoyAI_bot?start=buy' }],
        [{ text: '📋 Copy Base CA', copy_text: { text: PBAI_CA } }, { text: '📊 Chart', url: SOCIALS.chart }],
        [{ text: '🌐 Full Buy Page', url: 'https://poorboyai.pages.dev/buy' }],
      ] : [
        [{ text: '🌐 Buy from any chain (SOL · ETH · BNB · MATIC…)', callback_data: 'menu:buy_cross' }],
        [{ text: '🔵 I\'m already on Base', callback_data: 'menu:buy_base' }],
        [{ text: '📋 Copy Base CA', copy_text: { text: PBAI_CA } }, { text: '📊 Chart', url: SOCIALS.chart }],
        [{ text: '🌐 Full Buy Page', url: 'https://poorboyai.pages.dev/buy' }],
      ]},
    });
  },

  howtouse: async (chatId, _args, msg) => {
    const user = msg.from ? await getOrCreateUser(msg.from) : null;
    const tier = msg.from ? await effectiveTier(msg.from.id, user) : 'free';
    const label = TIER_LABELS[tier] ?? 'Free';
    await sendSafe(chatId, [
      `🤖 How to Use PoorBoyAI — ${label}`,
      '',
      'Free first steps',
      '• Try /price PBAI, /ta PBAI, /scan <CA>, and /ask.',
      '• Join official PoorBoyAI raids with /raid, then check /lb.',
      '• Register a public recipient wallet with /connect.',
      '',
      'Set up your account',
      '1. DM @PoorBoyAI_bot and run /link.',
      '2. Sign in to the dashboard and get a link code.',
      '3. Send /link YOURCODE in DM.',
      '4. Run /mytier for live limits and /help for every command.',
      '',
      'Paid onboarding',
      'PB Plan ($29/mo or $290/yr) → everything unlocked: all commands, Studio access, campaigns, Developer API + Hosted MCP, Ad Creator included',
      '🎁 7-day free trial → 100 trial credits, standard renders only, one per account',
      'Credit packs → 500 for $15, 2,000 for $49, 5,000 for $99 — never expire',
    ].join('\n'));
  },

  buy: async (chatId, _args, msg) => {
    // Deep-links repair (2026-10-26): /buy is the Studio credit top-up
    // surface. The old body rendered a TIER menu, but the bot's own copy
    // (lib/posts.js poster note) sends credit-short users here for
    // "Studio credit packs", and /upgrade already owns tier purchase —
    // so tiers are only a pointer here, never the menu. Pack prices come
    // from WIZBUY_PRODUCTS (the site-copied catalog), never re-typed, so
    // /buy cannot drift from the live prices. Buying is website checkout
    // + Mini App claim (More → 🧾 Link a purchase); there is NO in-bot
    // checkout on this path and no button implies one: every purchase
    // button is a URL button to the live checkout page, which carries
    // its own product picker — a deep link only preselects it, and the
    // buyer can still change packs on the page.
    // Per-pack deep links use the site's product ids, VERIFIED LIVE
    // 2026-10-26 against the production checkout bundle
    // /assets/index-DZQM9LQ4.js: that bundle reads
    // `new URLSearchParams(window.location.search).get("product")` and
    // preselects it when it is a member of the site's pack-id set
    // (studio_credits_500/2000/5000 + ad_creator), defaulting to
    // studio_credits_500 otherwise. All three ids below are members of
    // that set, so a shipped link can never hit the unknown-id fallback
    // — the Task 3 caution, which held while the ids were unverifiable
    // from this tree: a guessed id would have misdirected buyers to the
    // 500 pack. The map stays here, not in the catalog, so the catalog's
    // prices are untouched; an entry missing from either side drops its
    // button rather than shipping a fallback-default link. Buyers reach
    // /wizbuy from the /upgrade keyboard and the plans/subscribe panels
    // (wizard-fix wave 2026-10-27 — the WW3 sequencing hold is lifted).
    const PACK_SITE_ID = {
      'pack:500': 'studio_credits_500',
      'pack:2000': 'studio_credits_2000',
      'pack:5000': 'studio_credits_5000',
    };
    const packEntries = ['pack:500', 'pack:2000', 'pack:5000']
      .map((k) => [k, WIZBUY_PRODUCTS[k]])
      .filter(([k, p]) => Boolean(p) && Boolean(PACK_SITE_ID[k]));
    const packLines = packEntries.map(([, p]) => `• ${p.label} — one-time`).join('\n');
    await sendSafe(chatId, [
      '🛒 Buy Studio Credits',
      '',
      'Top up your PB balance with a one-time credit pack:',
      '',
      packLines,
      '',
      'How it works:',
      '1️⃣ Tap a pack below — the website checkout opens with that pack preselected (pay in crypto).',
      '2️⃣ After payment, open the Mini App → More → 🧾 Link a purchase and paste your checkout code — the credits land on your PB balance.',
      '3️⃣ Newly purchased credits do not expire. Failed jobs refund in full.',
      '',
      'Tier term credits come bundled with your PB Plan each term — your current amount shows in /mytier. They are not sold here.',
      '',
      'Need a plan instead? Run /upgrade. Want $PBAI the token? Run /howtobuy.',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        ...packEntries.map(([k, p]) => [{ text: `🛒 ${p.label}`, url: `https://poorboyai.pages.dev/checkout?product=${PACK_SITE_ID[k]}` }]),
        [{ text: '🛒 Buy credits on the website', url: 'https://poorboyai.pages.dev/checkout' }],
        [{ text: '💎 Upgrade Tier', callback_data: 'menu:subscribe' }],
      ]},
    });
  },

  settings: async (chatId, _args, msg) => {
    let style = 'hype';
    try {
      const row = await db.select().from(user_settings)
        .where(eq(user_settings.telegramUserId, String(msg.from.id))).get();
      style = row?.shillStyle ?? 'hype';
    } catch { /* ignore */ }
    const styleLabel = { hype: '🔥 Hype', professional: '💼 Professional', degen: '🤙 Degen' }[style] ?? '🔥 Hype';
    await sendSafe(chatId, [
      '⚙️ Settings',
      '',
      'Customise how @PoorBoyAI_bot works for you.',
      '',
      `🎨 Shill Style — ${styleLabel} (used in all AI post commands)`,
      '🔔 Notifications — control which alerts you receive',
      '💳 My Subscription — view your current tier',
      '🔗 Referral Link — invite friends (+3 AI cmds/day per referral)',
      '🆘 Support & Policies — tickets, help & legal docs',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        [{ text: '🔔 Notifications', callback_data: 'settings:notif' }, { text: '🎨 Shill Style', callback_data: 'settings:style' }],
        [{ text: '💳 My Subscription', callback_data: 'settings:sub' }, { text: '🔗 Referral Link', callback_data: 'settings:referral' }],
        [{ text: '🆘 Support & Policies', callback_data: 'settings:support' }],
        [{ text: '◀️ Back to Menu', callback_data: 'menu:back' }],
      ]},
    });
  },
});


Object.assign(COMMANDS, {
  // ─── Remote control (source: /remoteshill /remoteraid /remotesay — Builder+,
  // DM-only enforced by dispatch). "#N" picks from /mygroups. ──────────────
  mygroups: async (chatId, _args, msg) => {
    const groups = await myGroupsFor(msg.from.id);
    if (!groups.length) {
      await sendSafe(chatId, [
        'ℹ️ No groups linked to your account yet.',
        '',
        'How to add your group:',
        '1. Add @PoorBoyAI_bot to your group as admin',
        '2. Run /syncmembers so the bot tracks your members',
        '',
        'Then /mygroups will show it here.',
      ].join('\n'));
      return;
    }
    const list = groups.map((g, i) => `${i + 1}. ${g.title}\n   ${g.chatId}`).join('\n\n');
    await sendSafe(chatId, [
      `📋 Your Groups (${groups.length})`,
      '',
      list,
      '',
      'Remote commands — use #1, #2…',
      '▸ /remoteshill #1 — AI shill post',
      '▸ /remoteraid #1 [url] [mission] — Launch a raid',
      '▸ /remotesay #1 [message] — Custom message',
    ].join('\n'));
  },

  remoteshill: async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'remoteshill', 'Builder+'))) return;
    const arg = (args ?? '').trim() || '#1';
    const target = await resolveMyGroup(arg, msg.from.id);
    if (!target) {
      await sendSafe(chatId, `❌ Group ${arg} not found. Use /mygroups to see your groups.`);
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const post = await generatePost('shillraid', '$PBAI');
      // Fix 1 (2026-10-29): the post used to fire first and show a
      // truncated preview afterwards. Now the FULL post + target go to
      // the owner first; Confirm sends it, Cancel sends nothing.
      await requestBroadcastPreview(chatId, msg.from.id, {
        kind: 'remoteshill',
        text: post,
        displayText: post,
        targets: [{ chatId: target.chatId, title: target.title }],
      });
    } catch (err) {
      const m = String(err?.message ?? '');
      await sendSafe(chatId, /429|quota|rate.?limit/i.test(m)
        ? '❌ Failed: the AI is rate-limited right now — try again in a few minutes.'
        : '❌ Failed: PB hit a snag doing that — try again.');
    }
  },

  remoteraid: async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'remoteraid', 'Builder+'))) return;
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await sendSafe(chatId, [
        '⚔️ Remote Raid',
        '',
        'Usage: /remoteraid #1 <url> [mission]',
        '',
        'Fires a raid card in one of your groups, right from your DM.',
      ].join('\n'));
      return;
    }
    const target = await resolveMyGroup(parts[0], msg.from.id);
    if (!target) {
      await sendSafe(chatId, `❌ Group ${parts[0]} not found. Use /mygroups to see your groups.`);
      return;
    }
    const url = parts[1];
    const mission = parts.slice(2).join(' ');
    if (!/^https?:\/\//i.test(url)) { await sendSafe(chatId, '❌ That doesn\'t look like a URL.'); return; }
    const platform = detectRaidPlatform(url);
    if (!platform || !isValidRaidUrl(url).ok) {
      await sendSafe(chatId, '❌ That URL can\'t be a raid target — send a link to a post on X, Reddit, etc.');
      return;
    }
    try {
      // Fix 1 (2026-10-29): no raid session is created and no card is
      // posted until the owner confirms the preview. The confirm branch
      // (handlers/callback_query.js) creates the session and posts the
      // card with exactly these parameters.
      await requestBroadcastPreview(chatId, msg.from.id, {
        kind: 'remoteraid',
        text: '',
        displayText: `⚔️ Raid card for ${target.title}\n🎯 Target: ${url}${mission ? `\n🎯 Mission: ${mission}` : ''}`,
        targets: [{ chatId: target.chatId, title: target.title }],
        url,
        mission,
        creatorId: msg.from.id,
        creatorName: msg.from.first_name ?? msg.from.username ?? 'Commander',
      });
    } catch (err) {
      await sendSafe(chatId, `❌ Failed: ${err?.message ?? String(err)}`);
    }
  },

  remotesay: async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'remotesay', 'Builder+'))) return;
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await sendSafe(chatId, 'Usage: /remotesay #1 <message>\n\nSends a custom message to one of your groups.');
      return;
    }
    const target = await resolveMyGroup(parts[0], msg.from.id);
    if (!target) {
      await sendSafe(chatId, `❌ Group ${parts[0]} not found. Use /mygroups to see your groups.`);
      return;
    }
    const text = parts.slice(1).join(' ');
    try {
      // Fix 1 (2026-10-29): preview the exact text + target first;
      // Confirm sends it, Cancel sends nothing.
      await requestBroadcastPreview(chatId, msg.from.id, {
        kind: 'remotesay',
        text: text.slice(0, 4000),
        displayText: text.slice(0, 4000),
        targets: [{ chatId: target.chatId, title: target.title }],
      });
    } catch {
      await sendSafe(chatId, '❌ Couldn\'t send — make sure I\'m still an admin there.');
    }
  },

  // ─── Business bot setup (source: /bizsetup — Starter+, DM redirect) ─────
  bizsetup: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'bizsetup');
    const user = await getOrCreateUser(msg.from);
    const tier = await effectiveTier(msg.from.id, user);
    if (!tierAtLeast(tier, 'starter')) {
      await sendSafe(target, [
        '🏢 Business Bot Setup',
        '',
        'Link your dashboard first, then activate a Starter+ plan to access Business Bot features.',
        '',
        'Use /link to connect your account.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: '🔗 Link Account', web_app: { url: SOCIALS.dashboard } }]] },
      });
      return;
    }
    const cur = await loadBizSettings(msg.from.id);
    const modeLabel = cur.replyMode === 'fixed' ? '📌 Fixed Message'
      : cur.replyMode === 'greeting_then_ai' ? '👋 Greeting + AI'
      : '🤖 AI Only';
    const statusBlock =
      `Current settings:\n• AI replies: ${cur.aiEnabled ? 'ON ✅' : 'OFF 🔇'}\n• Mode: ${modeLabel}\n• Persona: ${cur.customSystemPrompt ? 'Custom ✅' : 'Default PB'}\n• Greeting: ${cur.greetingMessage ? 'Set ✅' : '—'}\n• Fixed message: ${cur.fixedMessage ? 'Set ✅' : '—'}\n• Fallback: ${cur.fallbackMessage ? 'Set ✅' : '—'}`;
    await sendSafe(target, [
      '🏢 Business Bot Setup',
      '',
      'Configure how your Business Bot responds to people who DM your Telegram account.',
      '',
      statusBlock,
      '',
      'Tap Start Setup to walk through the options:',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [
        [{ text: '⚙️ Start Setup', callback_data: 'biz:start' }],
        [{ text: '🌐 Open Dashboard', web_app: { url: SOCIALS.dashboard } }],
      ]},
    });
  },

  // ─── Airdrop / booster status (read-only; sends stay on the dashboard) ───
  airdropstatus: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'airdropstatus');
    const STATUS_ICON = {
      pending_review: '🔍', pending_deposit: '💳', funded: '💰',
      fee_pending: '🧾', deposit_pending: '💳', deposit_generating: '⏳',
      planned: '🗺️', awaiting_arm: '⏸️', draft: '📝', quote_ready: '🧾',
      distributing: '📤', completed: '✅', failed: '❌', cancelled: '🚫',
    };
    const rows = await listAirdropCampaigns(msg.from.id);
    if (!rows.length) {
      await sendSafe(target, [
        '🚀 Your Airdrop Campaigns',
        '',
        '_No campaigns yet._',
        '',
        'Launch your first airdrop to reward your community and grow your holder base.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [
          [{ text: '🚀 Launch Your First Airdrop', callback_data: 'airdrop:start' }],
          [{ text: '🌐 Dashboard', web_app: { url: SOCIALS.dashboard } }],
        ]},
      });
      return;
    }
    const lines = rows.map((c) => {
      const icon = STATUS_ICON[c.status] ?? '❓';
      const token = c.tokenName ?? (c.tokenCa ? c.tokenCa.slice(0, 10) + '…' : 'Unknown');
      const stats = c.status === 'completed' ? ` — ${c.txSuccess ?? 0} sent` : '';
      return `${icon} ${token} (${c.chain ?? 'base'}) — ${(c.status ?? 'unknown').replace(/_/g, ' ')}${stats}`;
    });
    let footer = 'Create one with /airdrop in this DM; deposits and details live in /mydrops.';
    if (rows.some((c) => c.status === 'fee_pending' && Number(c.serviceFeeUsd ?? 0) > 0)) {
      const feeAddr = String(await getConfig('PAY_RECEIVE_BASE_ADDRESS', '') ?? '').trim().toLowerCase();
      if (feeAddr) footer += `\nFee due? Pay it in USDC on Base from your connected wallet to ${feeAddr} — confirmed automatically.`;
    }
    await sendSafe(target, `🚀 Your Airdrop Campaigns\n\n${lines.join('\n')}\n\n${footer}`);
  },

  boosterstatus: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'boosterstatus');
    await sendSafe(target, [
      '⚡ Boost Status',
      '',
      'Pup Booster is live in the bot for quotes, deposits, planning, and sends (sends proven on a test campaign; first real customer campaign still open). The website booster handoff page is still parked. Your packs and campaigns are safe.',
      '',
      'Check your own boost history any time with /myboosts, or open the dashboard.',
    ].join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: '🌐 Open Dashboard', web_app: { url: SOCIALS.dashboard } }]] },
    });
  },

  // ─── Pro+ post commands (source: /callout /alpha /nftpost /defipost) ─────
  callout: postCommand('callout', 'pro', 'Pro+'),
  alpha: postCommand('alpha', 'pro', 'Pro+'),
  nftpost: postCommand('nftpost', 'pro', 'Pro+'),
  defipost: postCommand('defipost', 'pro', 'Pro+'),

  // ─── Manual reward record (source: /reward — tokens are sent manually) ───
  reward: async (chatId, args, msg) => {
    if (!(await adminGate(chatId, msg, true))) return;
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) {
      await sendSafe(chatId, 'Usage: /reward @username <amount> <token>\nExample: /reward @degen 100 PBAI');
      return;
    }
    const [targetUsername, amount, token] = parts;
    let wallet = null; let name = targetUsername.replace(/^@/, '');
    try {
      const rows = await db.select().from(raid_xp).all();
      const row = rows.find((r) =>
        String(r.chatId) === String(chatId) &&
        (r.username ?? '').toLowerCase() === name.toLowerCase()
      );
      if (row) { wallet = row.walletAddress; name = row.displayName ?? row.username ?? name; }
    } catch { /* ignore */ }
    await sendSafe(chatId, [
      '🎁 Reward Issued',
      '',
      `👤 To: ${name} (@${targetUsername.replace(/^@/, '')})`,
      `💰 Amount: ${amount} ${token}`,
      wallet ? `💳 Wallet: ${wallet}` : `⚠️ @${targetUsername.replace(/^@/, '')} hasn't connected a wallet (/connect <wallet>)`,
      '',
      '_Send tokens manually to the wallet above. Keep this message as a record._',
    ].join('\n'));
  },

  // ─── X setup (source: /raidsetup — handle stored; X verification is v2) ──
  raidsetup: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'raidsetup');
    const rec = await getTwitterHandle(msg.from.id);
    const handle = rec?.twitterHandle ?? null;
    const verified = rec?.xVerified === true;
    const statusLine = !handle
      ? '_No X handle linked yet_'
      : verified
        ? `✅ @${handle} — Verified`
        : `⚠️ @${handle} — Not yet verified`;
    const buttons = [];
    if (!handle) {
      buttons.push([{ text: '📝 Set My X Handle', callback_data: 'xsetup:change' }]);
    } else if (!verified) {
      buttons.push([
        { text: '✅ Verify via Tweet', callback_data: 'xsetup:verify' },
        { text: '🔄 Change Handle', callback_data: 'xsetup:change' },
      ]);
    }
    await sendSafe(target, [
      '🐦 X / Twitter Setup',
      '',
      statusLine,
      '',
      'Linking + verifying your X handle unlocks:',
      '• ⚔️ Auto-credit on X raids (once verified — no button needed)',
      '• 🔔 One-tap raid alerts in your Telegram DM (tap 🔔 Get Raid Alerts on a raid card)',
      '• ✅ Verified mark on your profile',
    ].join('\n'), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
  },

  // ─── Socials (source: /mysocials /mytwitter) ─────────────────────────────
  // Wizard-fix wave (2026-10-21): /mysocials opens the original's unified
  // Connect Socials panel (X + TikTok + Discord + the Pro+ API-keys step,
  // lib/accounts.js) instead of the X-status-only text shipped in v1.
  mysocials: async (chatId, _args, msg) => {
    const target = await dmRedirect(chatId, msg, 'mysocials');
    const sent = await sendSocialsPanel(msg.from.id).catch(() => null);
    if (!sent) {
      await sendSafe(target, '📩 Open a DM with me first (@PoorBoyAI_bot), then run /mysocials there.');
    }
  },

  mytwitter: async (chatId, args, msg) => {
    const target = await dmRedirect(chatId, msg, 'mytwitter');
    const handle = (args ?? '').trim().replace(/^@/, '');
    if (!handle) {
      await sendSafe(target, 'Usage: /mytwitter @yourhandle\n\nStores your X handle for raid auto-credit and alerts.');
      return;
    }
    const saved = await setTwitterHandle(msg.from.id, handle);
    if (!saved) { await sendSafe(target, '❌ That handle doesn\'t look right. Try /mytwitter @yourhandle'); return; }
    await sendSafe(target, [
      '✅ X handle saved!',
      '',
      `🐦 @${saved}`,
      '',
      'Verify it\'s really yours any time: open /raidsetup and tap ✅ Verify Ownership — PB checks a quick tweet.',
    ].join('\n'));
  },
});


// ── Wave 3: content, insight, image commands ────────────────────────────────
Object.assign(COMMANDS, {
  bullpost: postCommand('bullpost', 'starter', 'Starter+'),
  bearpost: postCommand('bearpost', 'starter', 'Starter+'),
  moonpost: postCommand('moonpost', 'starter', 'Starter+'),
  fudpost: postCommand('fudpost', 'builder', 'Builder+'),
  gempost: postCommand('gempost', 'builder', 'Builder+'),
  memepost: postCommand('memepost', 'pro', 'Pro+'),

  shillraid: async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'shillraid', 'Builder+'))) return;
    // Forum topics (raid wave): replies + card land in the firing topic.
    const threadId = msg.message_thread_id ?? null;
    const threadExtra = threadId != null && Number(threadId) > 0
      ? { message_thread_id: Number(threadId) } : {};
    const m = /^(https?:\/\/\S+)\s+(\d+)$/.exec(args);
    const url = m ? m[1] : args;
    if (!/^https?:\/\//i.test(url)) {
      await sendSafe(chatId, [
        '🔥 Shill Raid — AI shill post + live raid, all in one.',
        '',
        'Usage:',
        '/shillraid <url> — launch a shill raid on a target',
        '/shillraid <url> <target> — with a shiller count goal',
        '',
        'Targets: X / Twitter · Reddit · DexScreener · PumpFun · Ape.Store · any URL',
      ].join('\n'), threadExtra);
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const topic = await postTopic('', chatId);
    let shillContent = '';
    try { shillContent = await generatePost('shillraid', topic); } catch { /* fall through */ }
    const platform = detectRaidPlatform(url);
    if (!platform || !isValidRaidUrl(url).ok) {
      await sendSafe(chatId, '❌ That URL can\'t be a raid target — send a link to a post on X, Reddit, etc.', threadExtra);
      return;
    }
    await endActiveRaids(chatId);
    const session = await createRaidSession({
      chatId: Number(chatId), url, platform,
      targetCount: m ? parseInt(m[2], 10) : null,
      creatorId: msg.from.id, creatorName: msg.from.first_name ?? msg.from.username ?? 'Commander',
      threadId,
    });
    // Mark as a shill raid with the generated content (source: is_shill_raid).
    try {
      await db.update(raid_sessions)
        .set({ isShillRaid: true, shillContent: shillContent.slice(0, 2000) || null })
        .where(eq(raid_sessions.id, session.id)).run();
      session.isShillRaid = true;
      session.shillContent = shillContent;
    } catch (err) { console.error('[shillraid] flag failed:', err?.message ?? err); }
    await sendRaidCard(chatId, session);
  },

  debate: async (chatId, args, msg) => {
    const query = args.trim();
    if (!query) { await sendSafe(chatId, 'Usage: /debate $TOKEN or /debate BTC vs ETH'); return; }
    if (!(await tierGate(chatId, msg, 'builder', 'debate', 'Builder+'))) return;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const response = await askBrain(
        `Run a bull vs bear debate for: ${query}\n\nFormat exactly like this:\n🐂 BULL CASE\n• [Reason 1]\n• [Reason 2]\n• [Reason 3]\n\n🐻 BEAR CASE\n• [Reason 1]\n• [Reason 2]\n• [Reason 3]\n\n⚖️ VERDICT\n[2-sentence neutral conclusion]`,
        {
          maxOutputTokens: 800,
          systemPromptOverride: 'You are a neutral crypto debate moderator. Present bull and bear cases concisely. Do NOT use markdown asterisks or underscores. Use emojis. Max 250 words.',
        }
      );
      await sendSafe(chatId, response, { reply_to_message_id: msg.message_id });
    } catch {
      await sendSafe(chatId, '❌ Could not run debate right now. Try again shortly.');
    }
  },

  quote: async (chatId, _args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'quote', 'Builder+'))) return;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const q = await askBrain('Give me one quote.', {
        maxOutputTokens: 200,
        systemPromptOverride: 'Generate a single short, powerful quote. Either savage and real about crypto/money, or deeply inspiring. No more than 3 sentences.',
      });
      await sendSafe(chatId, `📜 ${q.trim()}`);
    } catch { await sendSafe(chatId, '❌ Could not pull a quote right now.'); }
  },

  idea: async (chatId, _args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'idea', 'Builder+'))) return;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const idea = await askBrain('Give me a fresh crypto trading idea or meme coin concept.', {
        maxOutputTokens: 400,
        // FIX 6 (2026-10-29): this output is sent with NO parse_mode,
        // so the model's **bold** / _italic_ / `code` showed literally.
        // Tell the model plain text instead of parsing its Markdown
        // (parsing risks a 400 on unbalanced markers, which would
        // deliver nothing at all — strictly worse than plain text).
        systemPromptOverride: 'You generate creative, spicy crypto trading ideas or meme coin concepts. Keep it fun, under 200 words, punchy and degen. Write in plain text only — no Markdown asterisks, underscores for emphasis, or backticks.',
      });
      await sendSafe(chatId, `💡 Fresh Idea from the Trenches\n\n${idea.trim()}`);
    } catch { await sendSafe(chatId, '❌ Brain fog — try again shortly.'); }
  },

  poor2rich: async (chatId, _args, msg) => {
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const story = await askBrain('Give me a poor-to-rich crypto tip or motivational story.', {
        maxOutputTokens: 400,
        systemPromptOverride: 'You are a motivational crypto mentor who came from nothing. Share raw, real wisdom about going from poor to rich in crypto. Max 200 words. Edgy, motivating, no fluff.',
      });
      await sendSafe(chatId, `💪 From the Trenches\n\n${story.trim()}`);
    } catch { await sendSafe(chatId, '❌ Brain fog — try again shortly.'); }
  },

  // Signal Inlet admin (2026-10-23): the /sentiment wrapper shape —
  // group-only line first, then the Starter+ tierGate (delegation-aware),
  // then the lib/groups.js handler (which re-checks admin itself).
  signals: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') {
      await sendSafe(chatId, 'ℹ️ /signals works in groups.');
      return;
    }
    if (!(await tierGate(chatId, msg, 'starter', 'signals', 'Starter+'))) return;
    await signalInletCommand(chatId, args, msg);
  },

  sentiment: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') {
      await sendSafe(chatId, 'ℹ️ /sentiment works in groups.');
      return;
    }
    if (!(await tierGate(chatId, msg, 'builder', 'sentiment', 'Builder+'))) return;
    const arg = args.trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      if (!(await isGroupAdmin(chatId, msg.from.id))) {
        await sendSafe(chatId, '🔒 Only admins can toggle auto-sentiment.');
        return;
      }
      await setGroupSettings(chatId, { sentiment_auto: arg === 'on' });
      await sendSafe(chatId, arg === 'on'
        ? '📊 Hourly Community Pulse ON! I\'ll post a mood update every hour.'
        : '📊 Hourly sentiment reports OFF.');
      return;
    }
    const buf = await recentMessages(chatId, 100);
    if (buf.length < 5) {
      await sendSafe(chatId, '📊 Not enough recent messages to analyze. Chat a bit first, then try again.');
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    // The analysis itself lives in lib/groupmsg.js (sentimentPulseText) —
    // the tick's hourly auto-post cycle runs the identical card (OPS-07).
    const pulse = await sentimentPulseText(chatId, msg.from?.id ?? null, buf);
    if (pulse) await sendSafe(chatId, pulse);
    else await sendSafe(chatId, '❌ Could not analyze sentiment right now.');
  },

  recap: async (chatId, args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'recap', 'Builder+'))) return;
    const hoursMatch = args.match(/^(\d+)h$/i);
    const countMatch = args.match(/^(\d+)$/);
    let msgs;
    if (hoursMatch) {
      const hours = Math.min(parseInt(hoursMatch[1], 10), 72);
      msgs = await recentMessages(chatId, 300, hours);
      if (!msgs.length) { await sendSafe(chatId, `📝 No messages in the last ${hours}h to recap.`); return; }
    } else {
      const count = countMatch ? Math.min(parseInt(countMatch[1], 10), 200) : 50;
      msgs = await recentMessages(chatId, count);
    }
    if (!msgs.length) {
      await sendSafe(chatId, '📝 No messages buffered yet. The buffer fills up as the group chats — send a few messages and try again!');
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const timeLabel = hoursMatch ? `last ${hoursMatch[1]}h` : `last ${msgs.length} messages`;
    try {
      const summary = await askBrain(`Recap these ${msgs.length} messages from the group:\n\n${transcript(msgs).slice(0, 6000)}`, {
        maxOutputTokens: 800,
        systemPromptOverride: `You are a chat summarizer for a crypto community Telegram group. Summarize the provided conversation clearly and concisely.\nFormat: bullet points, grouped by topic/theme if multiple topics.\nHighlight any: price discussions, alpha/calls, drama, important announcements, community sentiment.\nKeep it punchy and readable. Max 400 words. Do NOT include any preamble like "Here is a summary".`,
      });
      await sendSafe(chatId, `📝 Group Recap (${timeLabel})\n\n${summary.trim()}\n\n🤖 @PoorBoyAI_bot`);
    } catch { await sendSafe(chatId, '❌ Could not build the recap right now.'); }
  },

  // Group report (2026-10-24): image card — admin-only v1, group chats
  // only, sealed per chat (the card reads only this group's data).
  report: async (chatId, _args, msg) => {
    if (msg.chat.type === 'private') {
      await sendSafe(chatId, 'ℹ️ /report works in groups.');
      return;
    }
    if (!(await isOwnerId(msg.from?.id)) && !(await isChatAdmin(chatId, msg.from.id))) {
      await sendSafe(chatId, '🔒 Only group admins can pull the group report.', { reply_to_message_id: msg.message_id });
      return;
    }
    await api.sendChatAction({ chat_id: chatId, action: 'upload_photo' }).catch(() => {});
    try {
      await sendGroupReport(chatId, msg.chat.title || null);
    } catch { await sendSafe(chatId, '❌ Could not build the report right now.'); }
  },

  tldr: async (chatId, _args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'tldr', 'Builder+'))) return;
    const msgs = await recentMessages(chatId, 50);
    if (!msgs.length) { await sendSafe(chatId, '📝 No messages buffered yet.'); return; }
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const summary = await askBrain(`TLDR of these messages:\n\n${transcript(msgs).slice(0, 4000)}`, {
        maxOutputTokens: 400,
        systemPromptOverride: 'You are a concise chat summarizer for a crypto Telegram group. Give a TLDR in 3-5 sentences max. Be punchy. No fluff. Focus on what actually matters.',
      });
      await sendSafe(chatId, `⚡ TLDR\n\n${summary.trim()}\n\n🤖 @PoorBoyAI_bot`);
    } catch { await sendSafe(chatId, '❌ Could not build the TLDR right now.'); }
  },

  translate: async (chatId, args, msg) => {
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!isGroup) { await sendSafe(chatId, 'ℹ️ /translate only works in groups.'); return; }
    if (!(await isGroupAdmin(chatId, msg.from.id))) {
      await sendSafe(chatId, '🔒 Only admins can manage auto-translate.', { reply_to_message_id: msg.message_id });
      return;
    }
    if (!(await tierGate(chatId, msg, 'builder', 'translate', 'Builder+'))) return;
    const arg = args.trim().toLowerCase();
    const settings = await getGroupSettings(chatId);
    const tr = settings.translate ?? {};
    if (!arg || arg === 'status') {
      await sendSafe(chatId, [
        '🌐 Auto-Translate Status',
        `Status: ${tr.enabled ? '✅ ON' : '❌ OFF'}`,
        `Target language: ${(tr.targetLanguage ?? 'en').toUpperCase()}`,
        '',
        'Commands:',
        '• /translate on — enable (translates all foreign messages to English)',
        '• /translate on [lang] — translate to a specific language (e.g. /translate on es)',
        '• /translate off — disable',
      ].join('\n'), { reply_to_message_id: msg.message_id });
      return;
    }
    if (arg === 'off') {
      await setGroupSettings(chatId, { translate: { enabled: false, targetLanguage: tr.targetLanguage ?? 'en' } });
      await sendSafe(chatId, '❌ Auto-translate disabled for this group.', { reply_to_message_id: msg.message_id });
      return;
    }
    if (arg.startsWith('on')) {
      const lang = arg.split(/\s+/)[1] ?? 'en';
      await setGroupSettings(chatId, { translate: { enabled: true, targetLanguage: lang } });
      await sendSafe(chatId, `✅ Auto-translate ON!\n\nI'll now auto-detect languages and translate all foreign messages to ${lang.toUpperCase()}.\n\n🌐 Powered by @PoorBoyAI_bot`, { reply_to_message_id: msg.message_id });
      return;
    }
    await sendSafe(chatId, 'Usage: /translate on | /translate on es | /translate off | /translate status',
      { reply_to_message_id: msg.message_id });
  },

  fudshield: async (chatId, args, msg) => {
    if (!(await isGroupAdmin(chatId, msg.from.id))) {
      await sendSafe(chatId, '🔒 Only admins can manage FUD Shield.');
      return;
    }
    const arg = args.trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await setGroupSettings(chatId, { fudshield: arg === 'on' });
      await sendSafe(chatId, arg === 'on'
        ? '🛡️ FUD Shield ON! I watch for coordinated FUD waves (3+ users posting negative content within 90 seconds) and fire an AI counter-response.'
        : '🛡️ FUD Shield OFF.');
      return;
    }
    const settings = await getGroupSettings(chatId);
    await sendSafe(chatId, `🛡️ FUD Shield is ${settings.fudshield ? '✅ ON' : '❌ OFF'}\n\nUsage: /fudshield on | /fudshield off\nWhen ON: I watch for coordinated FUD waves (3+ users posting negative content within 90 seconds) and fire an AI counter-response.`);
  },

  gem: async (chatId, _args, msg) => {
    if (!(await tierGate(chatId, msg, 'builder', 'gem', 'Builder+'))) return;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    // Body lives in lib/skills.js (hotGemsText) — the hot_gems skill runs
    // the identical DexScreener read.
    await sendSafe(chatId, await hotGemsText());
  },

  ta: async (chatId, args, msg) => {
    // FREE-TIER RESHAPE (Rowdy 2026-11-05): technical analysis leaves Free —
    // Starter+ floor, so every paid tier and trial keeps it.
    if (!(await tierGate(chatId, msg, 'starter', 'ta', 'Starter+'))) return;
    const ca = /^0x[0-9a-fA-F]{40}$/.test(args) ? args : PBAI_CA;
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const token = await fetchTokenByAddress(ca);
      if (!token?.poolId) { await sendSafe(chatId, '❌ No trading pool found for that token — it may be too new or have no liquidity yet. A contract address with an active pool works best.'); return; }
      const poolAddr = String(token.poolId).split('_').pop();
      const candles = await fetchOHLCV(poolAddr, fetch, 'base', 'hour', 100);
      if (candles.length < 15) { await sendSafe(chatId, '📊 Not enough candle history for TA on this pair yet.'); return; }
      await sendSafe(chatId, taCard(token.name, token.symbol, candles));
    } catch (err) {
      console.error('[ta]', err?.message ?? err);
      await sendSafe(chatId, '📊 Could not build TA right now. Try again shortly.');
    }
  },

  generate: async (chatId, args, msg) => {
    const prompt = args.trim();
    if (!prompt) { await sendSafe(chatId, '❌ Please provide a prompt. Example: /generate cyberpunk robot trading crypto'); return; }
    if (!(await tierGate(chatId, msg, 'starter', 'generate', 'Starter+'))) return;
    // Brand memory (2026-10-30): a leading `style:` forces the picker
    // — the escape hatch for users with a saved default. Otherwise a
    // saved default runs directly with no tap, reusing the tap path
    // wholesale (same gates, same charge). No default → the old picker
    // branch below, byte-identical.
    const stylePick = /^style:\s*/i.test(prompt);
    const cleanPrompt = stylePick ? prompt.replace(/^style:\s*/i, '') : prompt;
    if (stylePick && !cleanPrompt) { await sendSafe(chatId, '❌ Please provide a prompt. Example: /generate style: cyberpunk robot'); return; }
    const actorId = msg.from?.id;
    if (!stylePick && actorId) {
      const defCode = await getGenerateStyleDefault(actorId);
      if (defCode) {
        await armGenerateStylePick(actorId, chatId, cleanPrompt);
        const sent = await api.sendMessage({
          chat_id: chatId,
          text: `🎨 Using your saved style…\nPrompt: ${cleanPrompt.slice(0, 80)}${cleanPrompt.length > 80 ? '…' : ''}`,
          reply_parameters: { message_id: msg.message_id },
        }).catch(() => null);
        if (sent?.message_id) {
          // Synthetic tap: the callback consumes the just-armed session
          // and runs its full path (tier re-check, preflight, breaker,
          // reserve, job, settle). No toast exists here, so an alert
          // refusal is sent as a message with the same words.
          const res = await handleGenerateCallback({
            from: msg.from,
            message: { chat: { id: chatId, type: msg.chat?.type ?? 'private' }, message_id: sent.message_id },
            data: `gen:${defCode}`,
          }, { viaDefault: true }).catch((err) => ({ text: `❌ ${err?.message ?? 'Generate error'}`, alert: true }));
          if (res?.alert && res.text) await sendSafe(chatId, res.text);
          if (res) return;
          // res null (session race): fall through to the picker below.
        }
        // No placeholder message: fall through to the picker below.
      }
    }
    // Style pick restored (the original's gen:* keyboard): the prompt is
    // parked and the tap executes through lib/image.js with the same gate
    // re-checked there.
    await armGenerateStylePick(msg.from.id, chatId, cleanPrompt);
    await api.sendMessage({
      chat_id: chatId,
      text: `🎨 Pick a style for your image:\nPrompt: ${cleanPrompt.slice(0, 80)}${cleanPrompt.length > 80 ? '…' : ''}`,
      reply_markup: generateStyleKeyboard(),
      reply_parameters: { message_id: msg.message_id },
    }).catch(async () => {
      await sendSafe(chatId, `🎨 Pick a style for your image:\nPrompt: ${cleanPrompt.slice(0, 80)}`, { reply_markup: generateStyleKeyboard() });
    });
  },

  meme: async (chatId, args, msg) => {
    if (!args.trim()) { await sendSafe(chatId, '🎭 Usage: /meme <description>\nExample: /meme PBAI to the moon degen ape'); return; }
    if (!(await tierGate(chatId, msg, 'pro', 'meme', 'Pro+'))) return;
    if (!msg.from?.id) { await sendSafe(chatId, '❌ Image generation needs a user account.'); return; }
    // Charged (restored): IMAGE_CREDIT_COST from the shared Studio wallet,
    // reserve → generate → settle/refund inside executeImageCommand.
    await executeImageCommand(msg.from.id, chatId, `image:${msg.from.id}:${chatId}:${msg.message_id}`, {
      fullPrompt: `Funny crypto meme image, bold text, internet humor style: ${args.trim()}`,
      caption: `🎭 ${args.trim().slice(0, 100)}`,
      filename: 'pb-meme.png',
    });
  },

  pfp: async (chatId, args, msg) => {
    if (!args.trim()) { await sendSafe(chatId, '🖼️ Usage: /pfp <description>\nExample: /pfp cyberpunk ape wearing diamond crown'); return; }
    if (!(await tierGate(chatId, msg, 'pro', 'pfp', 'Pro+'))) return;
    if (!msg.from?.id) { await sendSafe(chatId, '❌ Image generation needs a user account.'); return; }
    // Charged (restored): same shared-wallet charge as /meme.
    await executeImageCommand(msg.from.id, chatId, `image:${msg.from.id}:${chatId}:${msg.message_id}`, {
      fullPrompt: `Crypto profile picture or token logo, high quality, digital art style: ${args.trim()}`,
      caption: `🖼️ ${args.trim().slice(0, 100)}`,
      filename: 'pb-pfp.png',
    });
  },
});

// ─── Forgotten-features wave (2026-10-19): ports of the original non-menu
// handlers from telegram-community-bot.ts, restored per the completeness
// ledger §3. Implementations live in lib/{walletcmds,broadcastcmds,statscmds,
// taindicators,opscmds}.js; all names are also in EXTRA_COMMANDS above so the
// catalog gate lets them dispatch. Registration-only aliases at the end.
Object.assign(COMMANDS, {
  ...WALLET_COMMANDS,
  ...BROADCAST_COMMANDS,
  ...BLAST_COMMANDS,
  ...GROUP_RESTORE_COMMANDS,
  ...SHIELD_COMMANDS,
  ...CLEANUP_COMMANDS,
  ...BIZCLEAN_COMMANDS,
  ...RELAY_COMMANDS,
  ...ANNOUNCE_COMMANDS,
  ...DM_BROADCAST_COMMANDS,
  ...STATS_COMMANDS,
  ...TA_COMMANDS,
  ...OPS_COMMANDS,
  ...TEAM_COMMANDS,
  ...INVITE_COMMANDS,
  ...DIGEST_COMMANDS,
  ...LEADS_COMMANDS,
  ...STUDIO_COMMANDS,
  ...PODCAST_COMMANDS,
  ...PODCAST_SERIES_COMMANDS,
  ...CAMPAIGN_COMMANDS,
  ...SETUP_COMMANDS,
  ...REMOTE_COMMANDS,
  ...SUPPORT_COMMANDS,
  ...APPLY_COMMANDS,
  ...WIZBUY_COMMANDS,
  ...PAYSUPPORT_COMMANDS,
  ...PROMO_COMMANDS,
  ...EMAIL_COMMANDS,
  ...VOICE_COMMANDS,
  ...BOOST_COMMANDS,
  ...AIRDROP_COMMANDS,
  ...BUYREWARDS_COMMANDS,
  ...AIRDROP_ADMIN_COMMANDS,
  ...MONEY_ADMIN_COMMANDS,
  ...MANAGE_COMMANDS,
  ...GUARD_COMMANDS,
  ...BUYBOT_COMMANDS,
  ...TRENDING_COMMANDS,
  ...SOCIALS_COMMANDS,
  ...LP_COMMANDS,
  save: (chatId, args, msg) => COMMANDS.note(chatId, args, msg),
  tagall: (chatId, args, msg) => COMMANDS.everyone(chatId, args, msg),
});

async function dispatchCommand(chatId, canonical, args, msg) {
  // DM-only commands must run in a private chat.
  if (isDmOnlyCommand(canonical) && msg.chat.type !== 'private') {
    await sendSafe(chatId, '🔒 That one needs a private chat — open a DM with me and run it there.');
    return;
  }
  // Inbound sales leg (2026-11-05): /airdrop or /boost in a DM from a
  // lead-matched sender starts qualify instead of the product wizard.
  // Non-lead senders fall through to the normal wizards, untouched.
  if ((canonical === 'airdrop' || canonical === 'boost') && msg.chat.type === 'private') {
    try {
      if (await maybeStartSalesForCommand(msg.from?.id, canonical, msg.from)) return;
    } catch (err) {
      console.error('[sales-cmd]', err?.message ?? err); // never break the handler
    }
  }
  // Website builder v1 (2026-11-05): /site + /mysites are DM-only and
  // not catalog commands yet — intercept before the COMMANDS lookup so
  // they never fall through to MOVING_NOTICE.
  if (canonical === 'site' || canonical === 'mysites') {
    if (msg.chat.type !== 'private') {
      await sendSafe(chatId, '🔒 That one needs a private chat — open a DM with me and run it there.');
      return;
    }
    try {
      if (canonical === 'site') {
        if (await maybeStartSiteForCommand(msg.from?.id, canonical, msg.from)) return;
      } else if (await maybeListMySitesForCommand(msg.from?.id, canonical)) return;
    } catch (err) {
      console.error('[site-cmd]', err?.message ?? err); // never break the handler
    }
    return;
  }
  const handler = COMMANDS[canonical];
  if (handler) {
    await handler(chatId, args, msg);
    return;
  }
  // Catalog command exists but isn't ported yet in v1.
  await sendSafe(chatId, MOVING_NOTICE);
}

// Answer-path watchdog (2026-10-23): handleBrainReply's sends go
// through this wrapper — when Telegram CONFIRMS the send (sendSafe
// returns the sent message), stamp last_answer_at so the tick can
// prove PB is ANSWERING, not merely receiving. sendSafe still swallows
// send errors by design (Break #3); an unconfirmed send simply leaves
// no stamp, which is exactly the signal the watchdog pages on.
async function sendBrainReply(chatId, text, extra = {}) {
  // Overnight-2 brain-reply send fix (2026-10-25): a failed brain-reply
  // send used to vanish with zero durable trace (sendSafe swallows it),
  // which is exactly how 6 handled Carrie DMs left 0 answers and 0
  // errors on 2026-10-24 evening. One retry covers a transient
  // 429/network failure; a still-failed send leaves a durable stamp +
  // command_errors row so the next failure is visible, not silent.
  // Fail-open throughout: the stamp path never breaks the reply path.
  // First-ask fix (2026-10-26): a HUNG send hung this wrapper forever
  // — no answer stamp, no send-failed stamp, the exact
  // attempt-without-answer signature of the 2026-10-26 07:55 group
  // episode (attempt stamped, then zero trace). A 20s race converts a
  // hung send into a failed send: retry once, then the durable stamp.
  // A late-landing original send is possible (same class as today's
  // retry double-send) and is strictly better than silence.
  let sent = await withTimeout(sendSafe(chatId, text, extra), 20_000, 'brain-send').catch(() => undefined);
  if (!sent) {
    await new Promise((r) => {
      if (typeof setTimeout !== 'undefined') setTimeout(r, 1500);
      else r();
    });
    sent = await withTimeout(sendSafe(chatId, text, extra), 20_000, 'brain-send').catch(() => undefined);
  }
  if (sent) await stampAnswerSent();
  else await stampBrainSendFailed(chatId).catch(() => {});
  // Community diagnosis (2026-10-28): per-chat mirrors of the global
  // stamps, from this same single site. Group chats only: Telegram
  // group/supergroup ids are negative, private chat ids are positive.
  if (Number(chatId) < 0) {
    if (sent) await stampDiagAnswer(chatId).catch(() => {});
    else await stampDiagSendFailed(chatId).catch(() => {});
  }
  return sent;
}

// ── PB STREAMING REPLIES (2026-11-06, DM-first proof) ─────────────────────
// Long AI-composed answers in the OWNER DM stream via Telegram's
// sendMessageDraft (Bot API 10.3): a transient ~30s preview the bot
// updates as Groq content tokens arrive, then persists with the normal
// sendBrainReply sendMessage. The draft is NEVER the message — if every
// draft call fails, the user still gets the exact same final message.
// Fire-and-forget BY DESIGN: the isolate has no timers, so an awaited
// draft call could stall the token flow until the platform kill; a
// dropped draft costs nothing (the final sendMessage stays awaited).
// Short answers never reach the draft threshold, so they stay single
// instant messages with ZERO draft calls.
const STREAM_DM_MIN_CHARS = 240;
const STREAM_DM_DRAFT_MIN_MS = 900;
const STREAM_DM_DRAFT_MIN_GROWTH = 60;
const STREAM_DM_MAX_CHARS = 4000;

// createDraftUpdater(chatId, sendDraft) — sendDraft(draftId, text) is the
// API call (injected so the harness can record it). Returns { draftId,
// onToken, draftSent, text }. onToken is synchronous and never throws:
// the stream must never break because a preview failed. Cadence: the
// first draft fires as soon as the text reaches STREAM_DM_MIN_CHARS;
// later drafts fire at most once per STREAM_DM_DRAFT_MIN_MS once the
// text grew STREAM_DM_DRAFT_MIN_GROWTH chars, or immediately on a
// >=240-char jump (a fast stream never starves).
function createDraftUpdater(chatId, sendDraft) {
  const draftId = Math.floor(Math.random() * 2147483647) + 1;
  let text = '';
  let lastDraftAt = 0;
  let lastDraftLen = 0;
  let draftSent = false;
  const onToken = (delta) => {
    try {
      if (!delta) return;
      text += delta;
      if (text.length > STREAM_DM_MAX_CHARS) text = text.slice(0, STREAM_DM_MAX_CHARS);
      if (text.length < STREAM_DM_MIN_CHARS) return;
      const now = Date.now();
      if (draftSent) {
        const grown = text.length - lastDraftLen;
        const due = (now - lastDraftAt >= STREAM_DM_DRAFT_MIN_MS && grown >= STREAM_DM_DRAFT_MIN_GROWTH) || grown >= 240;
        if (!due) return;
      }
      const p = sendDraft(draftId, text);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      draftSent = true;
      lastDraftAt = now;
      lastDraftLen = text.length;
    } catch { /* a preview failure never breaks the reply */ }
  };
  return {
    draftId,
    onToken,
    get draftSent() { return draftSent; },
    get text() { return text; },
  };
}

// Kill switch: config stream_dm_owner !== '0' (default on). A read
// failure degrades to OFF — the known path.
async function streamDmOwnerEnabled() {
  try {
    const flag = await getConfig('stream_dm_owner', '1');
    return String(flag ?? '1') !== '0';
  } catch { return false; }
}

async function askBrainStreamed(chatId, text, brainOpts) {
  const updater = createDraftUpdater(chatId, async (draftId, draftText) => {
    await api.sendMessageDraft({ chat_id: chatId, draft_id: draftId, text: draftText });
  });
  return await askBrain(text, { ...brainOpts, onToken: updater.onToken });
}

export const __streamingTest = { createDraftUpdater, askBrainStreamed, STREAM_DM_MIN_CHARS, STREAM_DM_DRAFT_MIN_MS, STREAM_DM_DRAFT_MIN_GROWTH, STREAM_DM_MAX_CHARS };

async function handleBrainReply(chatId, msg, text, contextLabel, triggeredVia = null) {
  // Decide-shadow wave (2026-11-05): how this turn was triggered, for the
  // post-reply shadow log. Callers pass it ('command-ask' from /ask,
  // 'direct'/'freechat' from group routing, 'dm' for private chats);
  // default derives it from the chat type so older callers stay valid.
  const shadowVia = triggeredVia ?? (msg.chat?.type === 'private' ? 'dm' : 'freechat');
  // Fix PB (2026-10-25): stamp on ENTRY, so a future silent DM shows
  // attempt-without-answer instead of zero trace. Fail-open inside.
  await stampBrainReplyAttempt().catch(() => {});
  // Community diagnosis (2026-10-28): per-chat attempt mirror, groups only.
  if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
    await stampDiagAttempt(chatId).catch(() => {});
  }
  // Hang-protection R2 (2026-10-29): create the replay job at ENTRY —
  // before the history save and cap spans — so a hang in those spans
  // still leaves a job for the tick to replay. userKey is pure
  // formatting (telegram:<id>), identical to what brain-prep resolves
  // below. convoId is 0 until the history save fills it in (below);
  // the cap-denied path resolves this job so replay never answers a
  // cap-denied turn. Fail-open: creation never blocks the reply.
  let replayJob = null;
  try {
    replayJob = await createBrainReplayJob({
      chatId, chatType: msg.chat?.type ?? '', userKey: `telegram:${msg.from.id}`, convoId: 0,
    });
  } catch { replayJob = null; }
  // Twin wave 1 (C7): resolve the outcome-hook scope ONCE for this turn.
  // Owner private chats record as owner rows; group/supergroup turns as
  // group rows (write-only in v1, never retrieved); any other surface
  // (channels, non-owner DMs) records nothing — the helper refuses an
  // unresolved scope rather than guessing identity. One config read for
  // private chats only; group chats short-circuit without the read.
  // First-ask fix (2026-10-26): the twin-scope lookup is a config read
  // (private chats only — groups short-circuit with no await), but an
  // unbounded await here hung the whole reply with zero trace, the
  // same silence class as the 07:55 episode. A 10s race bounds it;
  // timeout degrades to the existing null scope, never a failure.
  let twinScope = null;
  try {
    twinScope = await withTimeout((async () => {
      if (msg.chat?.type === 'private' && (await isOwnerId(msg.from.id))) return 'owner';
      if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') return 'group';
      return null;
    })(), 10_000, 'brain-scope');
  } catch { twinScope = null; }
  // Silent-death guard (2026-10-25): this span used to run unguarded —
  // a throw here (user/history lookup) escaped handleBrainReply with no
  // brain-error stamp, no send-failed stamp, and no answer: the user saw
  // typing, then nothing. A failure here is now a visible glitch reply
  // plus a countable brain-error stamp, exactly like a brain failure.
  let userKey, history, user;
  try {
    // First-ask fix (2026-10-26): this span used to run unguarded
    // against HANGS — a never-settling user/history lookup escaped
    // with no brain-error stamp, no send-failed stamp, and no answer
    // (the 07:55 group episode's exact signature: attempt stamped,
    // then nothing). A 15s race converts a hang into the existing
    // catch: brain-error stamp + visible glitch reply.
    ({ userKey, history, user } = await withTimeout((async () => {
      const k = await resolveUserKey('telegram', msg.from.id);
      const h = await loadHistory(k, 20);
      const u = await getOrCreateUser(msg.from);
      return { userKey: k, history: h, user: u };
    })(), 15_000, 'brain-prep'));
  } catch (err) {
    console.error('[brain-prep]', err?.message ?? err);
    // PB-chat big fix (2026-10-26): glitch FIRST, stamp second — a
    // stalled stamp write must never silence the user.
    await sendBrainReply(chatId, '🧠 My brain glitched for a sec — run it back and I got you.');
    await stampBrainError();
    // Community diagnosis (2026-10-28): per-chat brain-error mirror, groups only.
    if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') await stampDiagBrainError(chatId).catch(() => {});
    // R2: a glitch reply IS a visible response — resolve the early job
    // (mirrors the brain-error path below) so it never replays a
    // second answer for this turn.
    if (replayJob) await resolveBrainReplayJob(replayJob.id, 'answered').catch(() => {});
    // Twin wave 1 (C7): prep failure is a failed outcome, recorded
    // label-only after the user-visible reply, never before it.
    if (twinScope) await recordChatOutcome({ scope: twinScope, chatId, actorId: msg.from.id, outcome: 'failed' }).catch(() => {});
    return;
  }
  // 20:54 FIX (2026-10-27): persist the user message NOW, not after
  // the answer — a hung brain call dies before the post-answer save
  // ever runs, and the replay job below needs the row to exist first.
  // History for THIS turn was already loaded above, so the prompt is
  // unchanged. Fail-open: a pointer-read failure never breaks the reply
  // (saveMessage itself never throws; the select is guarded here).
  let replayConvoId = 0;
  try {
    await saveMessage(userKey, 'user', text, 'telegram');
    const row = await db.select().from(pb_conversations)
      .where(and(eq(pb_conversations.userKey, userKey), eq(pb_conversations.role, 'user')))
      .orderBy(desc(pb_conversations.id)).limit(1).get();
    replayConvoId = Number(row?.id) || 0;
  } catch (err) { console.error('[brain-history-save]', err?.message ?? err); }
  // R2: fill in the real question row id now that the save ran, so a
  // later replay reads the exact row (a job still at convoId 0 replays
  // as question-gone — the spec's accepted residual for a hang inside
  // the save itself).
  if (replayJob && replayConvoId) {
    const updated = await updateBrainReplayJob(replayJob.id, { convoId: replayConvoId }).catch(() => null);
    if (updated) replayJob = updated;
  }
  // Audit F1: enforce the advertised AI daily cap BEFORE the LLM call.
  // This is the single chokepoint both conversational paths funnel
  // through (/ask dispatch + plain DM/group replies), and the counter
  // charges the user whose message triggered the reply (msg.from) —
  // in a group that is the asking member, never the group itself.
  // A counter failure fails OPEN (chat keeps working; the cap is a
  // product limit, not a safety gate) but never silently: it logs.
  // Tier Delegation (2026-10-22): in a group, the cap is charged against
  // the actor under the tier they resolve WITH delegation context
  // (commandName 'ask') — a manager/granted admin chatting in the group
  // draws on the borrowed level's allowance, counted against their own
  // daily counter, exactly as the original's checkUsageForMsg charged
  // the effective tier. DMs resolve the stored tier, unchanged.
  let capTier = user?.tier;
  if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
    // First-ask fix (2026-10-26): the cap spans already fail OPEN on
    // rejection, but a hung tier/counter lookup hung the reply with
    // zero trace. 10s races convert hangs into the same fail-open
    // values the existing catches already return.
    capTier = await withTimeout(effectiveTier(msg.from.id, user, {
      chatId, commandName: 'ask', chatType: msg.chat.type, senderChat: msg.sender_chat ?? null,
    }), 10_000, 'brain-tier').catch(() => user?.tier);
  }
  const cap = await withTimeout(consumeAiCommand(capTier, msg.from.id), 10_000, 'brain-cap').catch((err) => {
    console.error('[aicap]', err?.message ?? err);
    return null;
  });
  if (cap && !cap.allowed) {
    await sendBrainReply(chatId, aiCapReachedText(cap));
    // R2: cap-denied turns must not replay (no double-charge) —
    // resolve the early job terminally instead of leaving it pending.
    if (replayJob) await resolveBrainReplayJob(replayJob.id, 'cap-denied').catch(() => {});
    return;
  }
  // Hang-protection R2: the replay job was created at entry (above) —
  // NOT here. The 20:54 FIX created it at this late point (after the
  // cap allows, before the brain call); moving it earlier covers
  // hangs in the history save + cap spans. The cap-denied path above
  // resolves the early job, preserving the no-double-charge rule.
  // (replayJob flows to the brain-error / empty / final-send
  // resolutions below, unchanged.)
  const context = [
    `User: ${msg.from?.first_name ?? 'unknown'}${msg.from?.username ? ' (@' + msg.from.username + ')' : ''} (tg id ${msg.from?.id})`,
    `Tier: ${user?.tier ?? 'free'}`,
    `Chat: ${contextLabel}`,
    `Platform: Telegram`,
  ].join('\n');
  // Second Brain S1 (2026-10-24): owner-DM recall injection via the
  // askBrain context seam. recallDecisionContext returns '' for every
  // non-owner-DM caller, so group contexts can never receive owner
  // rows through this path; failures are silent (chat keeps working).
  let brainContext = context;
  try {
    if (msg.chat?.type === 'private' && (await isOwnerId(msg.from.id).catch(() => false))) {
      const recall = await recallDecisionContext({ question: text, isOwnerDm: true, chatId });
      if (recall) brainContext = `${context}\n\n${recall}`;
    }
  } catch { /* recall failures never break the reply */ }
  // Community learning (2026-10-28, spec §2.5): this community's LIVE
  // profile (empty until graduated) rides askBrain's existing context
  // option — no change to the soul, core, or ladder. The key is built
  // from this chat's own ID and the assertion runs every answer; on a
  // mismatch NOTHING is injected and a seal violation is counted (which
  // blocks that chat's graduation). Fail-open: a profile failure never
  // breaks the reply.
  if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
    try {
      const prof = await loadCommunityProfileForAnswer(chatId);
      const built = buildCommunityContext({ profileChatId: prof.profileChatId, answeringChatId: chatId, profileText: prof.profileText, graduated: prof.graduated });
      if (built.sealViolation) await recordCommunitySealViolation(chatId).catch(() => {});
      else if (built.context) brainContext = `${brainContext}\n\n${built.context}`;
    } catch { /* profile never breaks the reply */ }
  }
  // Group recall (Replit parity): the old bot injected the last 20 group
  // messages into every group brain reply; the port dropped it, so the
  // brain answers group questions with no group transcript. Restore it.
  if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
    try {
      const recent = await recentMessages(chatId, 20);
      if (recent.length) {
        brainContext = `${brainContext}\n\nRecent group conversation (last 20 messages — use this to stay aware of what the community is discussing):\n${transcript(recent).slice(0, 3500)}`;
      }
    } catch { /* group recall never breaks the reply */ }
  }
  // Group vibe + sender vibe (Replit parity + per-person line): the old bot
  // read the room live — group vibe from the buffer, sender style from their
  // own messages in this group. The port dropped the vibe entirely. Restore it.
  if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') {
    try {
      const buf100 = await recentMessages(chatId, 100);
      const vibe = analyzeGroupVibe(buf100.slice(-20));
      if (vibe) {
        brainContext = `${brainContext}\n\nGROUP VIBE (mirror this community's style naturally — don't force it, just blend in): ${vibe}`;
      }
      const senderLine = analyzeSenderVibe(buf100, msg.from?.id, msg.from?.first_name ?? 'unknown');
      if (senderLine) {
        brainContext = `${brainContext}\n\n${senderLine}`;
      }
    } catch { /* group vibe never breaks the reply */ }
  }
  let reply;
  try {
    // Hang-protection R5: skip free-prefix rungs the tick probe saw
    // fail within 5 minutes (never into paid; fail-open to normal
    // order). Temporary, not a ladder reorder.
    const skipStart = await probeSkipStartIndex().catch(() => 0);
    const brainOpts = { history, context: brainContext, maxOutputTokens: 1500, ladderStartIndex: skipStart };
    // PB STREAMING REPLIES (2026-11-06, DM-first proof): the owner DM
    // streams via sendMessageDraft (see askBrainStreamed); every other
    // turn takes the exact old path. twinScope === 'owner' is already
    // resolved above (private + isOwnerId). The flag is a kill switch
    // ('0' = off); a flag-read failure degrades to off.
    const streamOn = msg.chat?.type === 'private' && twinScope === 'owner' && await streamDmOwnerEnabled().catch(() => false);
    reply = streamOn ? await askBrainStreamed(chatId, text, brainOpts) : await askBrain(text, brainOpts);
  } catch (err) {
    console.error('[brain]', err?.message ?? err);
    // Answer-path watchdog: a brain failure now leaves a durable,
    // countable record (last_brain_error_at + the hourly ring) —
    // before this, the catch was the end of the evidence.
    // PB-chat big fix (2026-10-26): glitch FIRST, stamp second — a
    // stalled stamp write must never silence the user.
    await sendBrainReply(chatId, '🧠 My brain glitched for a sec — run it back and I got you.');
    await stampBrainError();
    // Community diagnosis (2026-10-28): per-chat brain-error mirror, groups only.
    if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') await stampDiagBrainError(chatId).catch(() => {});
    // 20:54 FIX: a glitch reply IS a visible response — no replay needed.
    if (replayJob) await resolveBrainReplayJob(replayJob.id, 'answered');
    // Twin wave 1 (C7): brain failure outcome, label-only, after the reply.
    if (twinScope) await recordChatOutcome({ scope: twinScope, chatId, actorId: msg.from.id, outcome: 'failed' }).catch(() => {});
    return;
  }
  if (!reply || !reply.trim()) {
    await sendBrainReply(chatId, '🧠 Came up empty on that one — ask me something else.');
    // 20:54 FIX: an empty reply IS a visible response — no replay needed.
    if (replayJob) await resolveBrainReplayJob(replayJob.id, 'answered');
    // Twin wave 1 (C7): empty reply is a failed outcome (no answer made).
    if (twinScope) await recordChatOutcome({ scope: twinScope, chatId, actorId: msg.from.id, outcome: 'failed' }).catch(() => {});
    return;
  }
  // v1: action markers are recognized but not executed (forward-compat).
  const answerText = reply.trim().slice(0, 4000);
  // Metric-grounding guard (2026-10-25, the 74,300-follower lie): the
  // chat brain has no metric tools, so a count claim in this reply is
  // grounded only by this turn's own inputs — the user's message and
  // the system context block. History is never a source (a past riff
  // must not ground its own repeat). Fail-open: a guard throw logs and
  // the original reply goes out — the guard must never break chat.
  // Only this conversational path is scanned: commands, wizards, and
  // money flows never pass through here, so they cannot be blocked.
  // What the user sees is what history stores (finalAnswer, not the
  // raw reply), so a hedged claim never re-enters as memory.
  let finalAnswer = answerText;
  try {
    finalAnswer = groundMetricReply(answerText, { userText: text, context: brainContext }).text;
  } catch (err) { console.error('[metric-guard]', err?.message ?? err); }
  let replaySent = false;
  if (msg.chat?.type === 'private') {
    // Gap-2 voice notes: the 🔊 Hear it button rides the answer itself
    // (DM only — group answers stay button-free), and a /voice-on user
    // also gets short answers auto-read after the text lands. Both
    // helpers never throw: a voice failure can never cost the text.
    const markup = await prepareVoiceAnswer(msg.from.id, chatId, finalAnswer).catch(() => null);
    replaySent = !!(await sendBrainReply(chatId, finalAnswer, markup ? { reply_markup: markup } : {}));
    await maybeAutoVoice(chatId, msg.from, finalAnswer).catch(() => {});
  } else {
    replaySent = !!(await sendBrainReply(chatId, finalAnswer));
  }
  // 20:54 FIX: a confirmed send resolves the job; a failed send marks
  // it terminal (the existing send-failed stamp already makes it
  // visible) — a failed send must not replay a second, different answer.
  if (replayJob) await resolveBrainReplayJob(replayJob.id, replaySent ? 'answered' : 'send-failed');
  // History is bookkeeping, never worth a second message: a save failure
  // after the answer landed must not escape and trigger the guarded
  // call-site glitch (a duplicate reply for an already-answered user).
  // 20:54 FIX: the user message was already saved before the brain call;
  // only the assistant reply is saved here.
  try {
    await saveMessage(userKey, 'assistant', finalAnswer, 'telegram');
  } catch (err) { console.error('[brain-history]', err?.message ?? err); }
  // Twin wave 1 (C7): post-reply outcome hook. The label covers all
  // three outcomes, but only hedged + failed are recorded: an 'answered'
  // turn is already fully recorded in conversation memory above, so
  // duplicating it here adds volume, not signal. Hedged = the metric
  // guard rewrote the reply. Label-only, proposed, fail-open — and it
  // runs after the answer landed, so it can never delay the user.
  const twinOutcome = chatOutcomeLabel({ hedged: finalAnswer !== answerText, failed: false });
  if (twinOutcome !== 'answered' && twinScope) {
    await recordChatOutcome({ scope: twinScope, chatId, actorId: msg.from.id, outcome: twinOutcome }).catch(() => {});
  }
  // Community learning (2026-10-28, spec §2.2–§2.3): fold AFTER the
  // answer is sent, triggered group turns only, fail-open. The turn
  // text is passed in memory only and discarded after the fold — it is
  // never persisted keyed by chat. Fold cost books under the
  // 'community-fold' ledger surface so Q4 (cost vs the $10/day Brain
  // ceiling) is measurable from the ledger after the first live folds.
  if (replaySent && (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup')) {
    try {
      await noteCommunityAnswered(chatId);
      await foldCommunityProfile({
        chatId, turnText: text, answerText: finalAnswer,
        foldFn: async ({ profile, turnText: t, answerText: a }) => askLLM({
          tier: 'chat',
          surface: 'community-fold',
          maxOutputTokens: 400,
          systemPrompt: 'You distill one Telegram community\'s character into a short living profile. Return ONLY the replacement profile, at most 1500 characters, distilled — never quote any member verbatim. Keep vocabulary/slang, recurring topics, tone, inside jokes, and what answer shapes land well vs get corrected. Drop entries that stopped recurring; weigh recent signals over old ones.',
          userMessage: `Current profile (may be empty):\n${profile}\n\nThis turn's question:\n${t}\n\nPB's answer:\n${a}`,
        }),
      });
    } catch { /* fold failures never surface to the chat */ }
  }
  // Decide-shadow wave (2026-11-05): log-only shadow of decide() on real
  // DM/group traffic. Runs AFTER the reply landed, gated on replaySent (a
  // real reply went out), so it can never delay or change the answer.
  // Never throws; a shadow failure is a console line, never a user-visible
  // glitch. Owner-DM dedupe lives inside shadowLogChatIntent.
  if (replaySent) {
    try { await shadowLogChatIntent(chatId, msg, text, shadowVia); } catch { /* shadow logging never surfaces to the chat */ }
  }
}

// Decide-shadow wave (2026-11-05): log decide()'s nl_intent answers on
// real DM/group traffic PB answered with free chat, next to the incumbent
// result (the chat reply). Purely observational: nothing in the reply path
// reads these answers, so user-visible behavior is identical with the
// wiring on or off. The model sees the real text (same transient exposure
// as askBrain, which already sends every answered message to the ladder);
// the durable decision_log row holds ONLY code-derived feature labels via
// opts.logState — never the raw text. Owner-DM turns are skipped: the
// owner's own text already gets exactly one nlcmd-surface row per message
// (lib/nlcmd.js shadowLogNlIntent), so logging a freechat row too would
// double-count. Non-owner DMs and ALL group messages fire the hook.
function chatIntentFeatures(text, triggeredVia) {
  const t = String(text ?? '');
  const len = t.length;
  return {
    has_address: /0x[0-9a-fA-F]{40}/.test(t),
    has_number: /\d/.test(t),
    has_question_mark: t.includes('?'),
    has_url: /https?:\/\/|t\.me\/|www\./i.test(t),
    text_len_bucket: len < 40 ? 'short' : len < 200 ? 'medium' : 'long',
    triggered_via: String(triggeredVia ?? 'freechat'),
  };
}

async function shadowLogChatIntent(chatId, msg, text, triggeredVia) {
  try {
    if (msg.chat?.type === 'private' && (await isOwnerId(msg.from?.id).catch(() => false))) return;
    const out = await decide({
      surface: 'freechat', questionSet: 'nl_intent', mode: 'shadow',
      state: { conversation: twinConversation('freechat', 1), text: String(text ?? '') },
      logState: { conversation: twinConversation('freechat', 1), features: chatIntentFeatures(text, triggeredVia) },
      actorId: String(msg.from?.id), chatId: String(chatId),
    });
    if (out.logId) {
      const decideIntent = out.answers?.intent?.value ?? null;
      await recordDecisionOutcome(out.logId, 'incumbent:chat', {
        outcomeNote: !out.ok ? `decide-failed:${out.reason}`
          : (decideIntent === 'none' ? 'agree' : `diverge:decide=${decideIntent ?? '?'}`),
      });
    }
  } catch (err) { console.error('[freechat decide shadow]', err?.message ?? err); }
}

// Answer-path wave (2026-10-26): the call-site guard that closes the
// last silent span. handleBrainReply guards its own known spans
// (brain-prep, askBrain, metric guard, voice), but a throw anywhere
// else used to escape to the top-level capture with NO reply and NO
// brain-error stamp — the attempt-without-answer signature. Now every
// brain call goes through here: a throw becomes a visible glitch reply
// (which stamps an answer, or a send-failure stamp if THAT fails), so
// the user is never left with typing-then-nothing and the tick always
// sees a specific state instead of silence.
async function handleBrainReplyGuarded(chatId, msg, text, contextLabel, triggeredVia = null) {
  try {
    await handleBrainReply(chatId, msg, text, contextLabel, triggeredVia);
  } catch (err) {
    console.error('[brain-guarded]', err?.message ?? err);
    // PB-chat big fix (2026-10-26): glitch FIRST, stamp second — a
    // stalled stamp write must never silence the user.
    await sendBrainReply(chatId, '🧠 My brain glitched for a sec — run it back and I got you.');
    await stampBrainError().catch(() => {});
    // Community diagnosis (2026-10-28): per-chat brain-error mirror, groups only.
    if (msg.chat?.type === 'group' || msg.chat?.type === 'supergroup') await stampDiagBrainError(chatId).catch(() => {});
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

// ── DM greeting (2026-10-28): PB's equivalent of Telegram Business's
// Greeting Message — one greeting on a user's first-ever DM. Exactly
// once: the marker is set BEFORE send, so a send failure or retry can
// never double-greet; the history check fails closed on DB error (never
// greets, never burns the marker); /start counts as the hello (marker
// set, no extra greeting). The business path never reaches here:
// business_message updates have their own handler.
const DM_GREETING_KEY = 'pb_dm_greeting';
const DM_GREETING_DEFAULT = '👋 Yo, I\'m PB — the PoorBoyAI bot. Crypto-native, street-smart, here to help you win. One ask, one answer, first time, every time. Try me: ask anything crypto, /scan a token contract, or check /leads for fresh projects. What are we working on today?';
const dmGreetedKey = (userId) => `pb_dm_greeted_${userId}`;

async function dmGreetingText() {
  let raw = '';
  try { raw = await getConfig(DM_GREETING_KEY, ''); } catch { raw = ''; }
  const t = String(raw ?? '').trim();
  if (!t) return DM_GREETING_DEFAULT;
  if (t.toLowerCase() === 'off') return null;
  return t.slice(0, 4000);
}

async function maybeDmGreet(chatId, message, text) {
  if (!message || message.chat?.type !== 'private') return false;
  const from = message.from;
  if (!from || from.is_bot) return false;
  if (await isOwnerId(from.id).catch(() => false)) return false;
  if (!text) return false;
  const markerKey = dmGreetedKey(from.id);
  const cmd0 = parseCommand(text);
  if (cmd0 && resolveCanonicalCommand(cmd0.name) === 'start') {
    // The /start welcome IS the hello — mark, never double-greet.
    await setConfig(markerKey, '1').catch(() => {});
    return false;
  }
  const greeting = await dmGreetingText();
  if (greeting === null) return false; // owner-disabled; markers untouched
  try {
    if (String(await getConfig(markerKey, '')) === '1') return false;
  } catch { return false; } // fail closed on marker-read error
  // History: a DIRECT throwing query — loadHistory swallows errors and
  // would false-negative an old user into a greeting.
  let hasHistory;
  try {
    const row = await db.select().from(pb_conversations)
      .where(eq(pb_conversations.userKey, await resolveUserKey('telegram', from.id)))
      .limit(1).get();
    hasHistory = !!row;
  } catch { return false; } // fail closed, marker NOT burned
  if (hasHistory) {
    await setConfig(markerKey, '1').catch(() => {});
    return false;
  }
  // Concurrency narrowing: re-read the marker before claiming the greet.
  try {
    if (String(await getConfig(markerKey, '')) === '1') return false;
  } catch { return false; }
  await setConfig(markerKey, '1').catch(() => {});
  await sendSafe(chatId, greeting);
  return true;
}

// ── Wave 5: ears + DM sight (Rowdy's words, board 574/575) ─────────────────
// EARS: a DM voice note is transcribed (Groq Whisper, free rung —
// lib/llm.js transcribeVoiceNote) and answered as plain text through the
// normal DM brain path, so caps, history, and the voice-answer button all
// apply. Groups are untouched: a group voice note still relays as audio.
// SIGHT: a DM photo is read by the same Gemini vision call as group Auto
// Vision (lib/groups.js callGeminiVision). It is gated on the user's AI
// quota — the ask is counted ONLY when the vision read succeeds, so a
// failed read falls through to today's caption-only brain answer and
// costs nothing. Both helpers NEVER throw: a failure is a short honest
// reply (voice) or a fall-through to today's behavior (vision).
const DM_VOICE_TOO_LARGE = '🎙️ That voice note is too long for me to hear — keep it short, or type it out.';
const DM_VOICE_UNHEARD = '🎙️ I couldn\'t hear that one — try sending it again, or type it out.';

async function handleDmVoiceNote(chatId, message) {
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  const bytes = await api.getFileContent(message.voice.file_id).catch(() => null);
  if (!bytes?.length) { await sendSafe(chatId, DM_VOICE_UNHEARD); return; }
  const res = await transcribeVoiceNote(bytes).catch(() => ({ ok: false, reason: 'transport' }));
  if (!res.ok) {
    await sendSafe(chatId, res.reason === 'too_large' ? DM_VOICE_TOO_LARGE : DM_VOICE_UNHEARD);
    return;
  }
  await handleBrainReplyGuarded(chatId, message, res.text.trim(), 'private chat', 'voice-note');
}

/**
 * DM vision attempt. Returns true when the photo was consumed (vision
 * answered, or the user is at their AI cap and got the cap copy).
 * Returns false when vision did not run (no photo, no bytes, no key,
 * vision failure) — the caller then falls through to today's behavior.
 */
async function tryDmVision(chatId, message) {
  if (!message?.photo?.length || message.from?.is_bot) return false;
  try {
    const photo = message.photo[message.photo.length - 1];
    const bytes = await api.getFileContent(photo.file_id).catch(() => null);
    if (!bytes?.length) return false;
    const key = await getConfig('GEMINI_API_KEY').catch(() => null);
    if (!key) return false;
    const user = await getOrCreateUser(message.from).catch(() => null);
    const tier = user?.tier ?? 'free';
    // Gate WITHOUT counting first: a failed vision read must cost
    // nothing and fall through to the caption-only brain answer. Only
    // a successful read consumes one AI command (same accounting as a
    // brain answer — a counted ask is never refunded). Residual race:
    // two photos at once can both pass the gate and both read; the
    // second consume then finds the cap reached and counts nothing, so
    // at most one extra free read escapes. Documented, accepted.
    const allowance = await aiCommandAllowance(tier, message.from.id).catch(() => null);
    const used = await aiUsageToday(message.from.id).catch(() => 0);
    if (allowance && allowance.limit !== -1 && used >= allowance.limit) {
      await sendSafe(chatId, aiCapReachedText({ tier, limit: allowance.limit, used, referralBonus: allowance.referralBonus }));
      return true;
    }
    const caption = (message.caption ?? '').trim();
    const userText = caption
      ? `The user shared this image with the caption: "${caption}"\n\nAlso: analyze this image as a crypto trader would.`
      : 'Analyze this image as a crypto trader would.';
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const text = await callGeminiVision({ key, bytes, userText, systemPrompt: DM_VISION_SYSTEM });
    if (!text) return false;
    await consumeAiCommand(tier, message.from.id).catch(() => null);
    await api.sendMessage({
      chat_id: chatId,
      text: `👁️ ${text}`.slice(0, 4000),
      reply_to_message_id: message.message_id,
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// Harness seam (the lib/tick.js __test precedent): the DM ears/sight
// handlers, so the wave harness can drive them against stubbed transports
// without dispatching a whole update.
export const __earsSightTest = { handleDmVoiceNote, tryDmVision };

async function handleMessageImpl(message, ctx) {
  // PB Cleanup (2026-10-22): a reply capture never outlives the member-
  // command invocation that armed it — reset on EVERY message
  // invocation so a warm isolate can't leak it into unrelated sends.
  cleanupEndCapture();
  // X post analytics, per-place reach (2026-11-06): count replies to a
  // tracked Telegram leg (ads channel / home group). Self-gates on chat
  // + reply_to_message inside; fail-open; never breaks the handler.
  try { await xPostStatsNoteReply(message); } catch { /* never break the handler */ }
  // PB Stars lane (2026-11-01, workspace only): a successful_payment
  // message carries no text, so it must be consumed BEFORE the
  // no-text branch below — otherwise it would fall through to the
  // join/leave/media handling and the payment would grant nothing.
  // The handler itself validates, dedupes by charge id, and grants
  // exactly once; a payment receipt is never routed to the brain.
  if (message?.successful_payment) {
    try { await handleStarsSuccessfulPayment(message); } catch (err) { console.error('[stars:payment]', err?.message ?? err); }
    try { maybeTick().catch(() => {}); } catch { /* tick kick is best-effort */ }
    return;
  }
  // Wave 5 ears: a DM voice note is transcribed and answered as plain
  // text. Groups are untouched (a group voice note still relays as
  // audio); a bot's own voice note never enters here.
  if (message?.voice?.file_id && message.chat?.type === 'private' && message.from && !message.from.is_bot) {
    try { await handleDmVoiceNote(message.chat.id, message); } catch (err) { console.error('[dm-voice]', err?.message ?? err); }
    try { maybeTick().catch(() => {}); } catch { /* tick kick is best-effort */ }
    return;
  }
  const text = message.text ?? message.caption;
  if (!text || !message.from) {
    // Wave 4: welcome new members even without text.
    if (message.new_chat_members?.length && message.chat?.type !== 'private') {
      for (const m of message.new_chat_members) {
        if (!m.is_bot) {
          await fireWelcome(message.chat.id, m, message.chat);
          // /manage Phase 2 join gates: Portal restrict+challenge and
          // the Alphabets admin note (lib/groups.js; both keyed by
          // chatId, home group and whitelisted members skip).
          await handleJoinGates(message.chat.id, m);
        }
        // PB Shield join screening (burst detection + watch list) —
        // every joiner counts, bots included; the hook self-gates on
        // the group's shieldEnabled flag and dedupes against the
        // chat_member seam, so this costs nothing while Shield is off.
        try { await shieldJoinHook(message.chat.id, m); } catch { /* never break the handler */ }
        // Group report rollup (2026-10-24): human joins only, one seam
        // only (the chat_member update is NOT tallied — no double count).
        if (!m.is_bot) { try { await tallyRollup(message.chat.id, 'joins'); } catch { /* rollup best-effort */ } }
      }
    }
    // E4a: goodbye message on member leave (source: bot.on("left_chat_member")).
    if (message.left_chat_member && message.chat?.type !== 'private' && !message.left_chat_member.is_bot) {
      await fireGoodbye(message.chat.id, message.left_chat_member, message.chat);
      // Group report rollup (2026-10-24): human leaves feed member-change.
      try { await tallyRollup(message.chat.id, 'leaves'); } catch { /* rollup best-effort */ }
    }
    // PB Cleanup service tidy (2026-10-22): with cleanup + the service
    // toggle on in this group, the join/leave service post itself is
    // deleted on arrival. The hook self-gates; failures are silent.
    if ((message.new_chat_members?.length || message.left_chat_member)
      && (message.chat?.type === 'group' || message.chat?.type === 'supergroup')) {
      try { await cleanupServiceHook(message.chat.id, message); } catch { /* never break the handler */ }
    }
    // PB Cleanup pin memory (2026-10-22): a pin event here is recorded
    // so the tidy sweep never deletes a message it has seen pinned.
    if (message.pinned_message
      && (message.chat?.type === 'group' || message.chat?.type === 'supergroup')) {
      try { await cleanupNotePinned(message.chat.id, message.pinned_message.message_id); } catch { /* never break the handler */ }
    }
    // E4a: Auto Vision reads caption-less group photos here (captioned
    // photos flow through the group automation block further down).
    if (message.photo?.length && message.from
      && (message.chat?.type === 'group' || message.chat?.type === 'supergroup')) {
      try { await maybeAutoVision(message.chat.id, message); } catch { /* never break the handler */ }
    }
    // Portal polish: a caption-less photo/GIF/video in a DM can be an
    // armed Portal banner capture — the /manage Portal page sends the
    // admin here to supply the media, and there is no text to route on.
    // Buy Bot Phase 3: the same goes for an armed Buy Bot banner capture
    // (the /manage Buy Bot page's 🖼 Set banner button).
    if (message.from && message.chat?.type === 'private'
      && (message.photo || message.animation || message.video)) {
      try {
        if (await handlePortalSetupCapture(message.chat.id, message)) {
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[portal-setup-capture]', err?.message ?? err); // never break the handler
      }
      try {
        if (await handleBuyBotCapture(message.chat.id, message)) {
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[bb-capture]', err?.message ?? err); // never break the handler
      }
      // Video-ad wizard photo intake (2026-11-04): a caption-less DM
      // photo while a /create wizard awaits its first input becomes the
      // ad visual. Self-gated (no wizard, no consume) and placed AFTER
      // the armed Portal/Buy Bot captures so those keep precedence.
      try {
        if (await handleStudioWizardPhoto(message.chat.id, message.from, message)) {
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[studio-wiz-photo]', err?.message ?? err); // never break the handler
      }
      // Wave 5 sight: a caption-less DM photo is read by the same Gemini
      // vision call as group Auto Vision. Self-gated (no photo, no bytes,
      // no key, vision failure → false) and placed AFTER the armed
      // captures so those keep precedence.
      try {
        if (await tryDmVision(message.chat.id, message)) {
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[dm-vision]', err?.message ?? err); // never break the handler
      }
    }
    // PB Shield: caption-less group media and forwards still pass the
    // shield hook — a watched joiner's forwarded scam graphic carries
    // no text to route on. Service posts (joins/leaves) are excluded;
    // the hook self-gates on shieldEnabled.
    if (message.from && (message.chat?.type === 'group' || message.chat?.type === 'supergroup')
      && !message.new_chat_members && !message.left_chat_member) {
      let shieldDeleted = false;
      try { shieldDeleted = await shieldMessageHook(message.chat.id, message); } catch { /* never break the handler */ }
      // Raid declutter wave: caption-less group media can be an armed
      // /raidbanner capture (the bare-photo flow — this early path
      // returns before the main-flow capture placement below). A
      // Shield-deleted message never becomes a banner, and support-group
      // media never captures here either (same guard as the main flow).
      if (!shieldDeleted && !message.from.is_bot
        && (message.photo || message.animation || message.video)) {
        try {
          const support = await isSupportModeChat(message.chat.id, message.chat, message.message_thread_id).catch(() => false);
          if (!support) await handleRaidBannerCapture(message.chat.id, message);
        } catch { /* never break the handler */ }
      }
    }
    // PB Relay (Wave 1): caption-less media in a group never reaches the
    // routed seam below — a group source's photo/video post with no
    // caption still has to relay. Same intake, same inertness.
    if (message.chat?.type === 'group' || message.chat?.type === 'supergroup') {
      try { await relayGroupHook(message.chat.id, message); } catch { /* never break the handler */ }
      // Telegram ↔ Discord mirror (2026-10-23): caption-less media in
      // the home group enqueues a v1 placeholder trace. Same fail-open
      // shape; the hook self-gates to the one paired chat.
      try { await mirrorGroupHook(message.chat.id, message); } catch { /* never break the handler */ }
      // Group report rollup (2026-10-24): caption-less member media
      // counts too (service posts excluded — joins/leaves tally below).
      if (message.from && !message.from.is_bot
        && !message.new_chat_members && !message.left_chat_member && !message.pinned_message) {
        try { await tallyRollup(message.chat.id, 'messages'); } catch { /* rollup best-effort */ }
      }
    }
    return;
  }
  const chat = message.chat;
  const chatId = chat.id;
  const isPrivate = chat.type === 'private';

  // Global ban gate (mirrors the processUpdate wrapper in telegram-community-bot.ts).
  try {
    const banned = await db.select().from(global_banned_users)
      .where(eq(global_banned_users.telegramUserId, message.from.id)).get();
    // Answer-path wave: the ban gate was an un-tallied silent exit — a
    // banned triggered message left no trace at all. Banned users are
    // owed no answer, but the exit is now counted, not silent.
    if (banned) { await tallyRoutingExit(chatId, 'skipped_banned'); return; }
  } catch (err) {
    console.error('[ban-gate]', err?.message ?? err);
  }

  await trackGroup(chat);

  // Wave 3: feed the group message log (recap/sentiment/tldr) for group chatter.
  const isGroupChat = chat.type === 'group' || chat.type === 'supergroup';
  if (isGroupChat && !message.from?.is_bot) {
    await logGroupMessage(chatId, message.from.first_name ?? message.from.username ?? 'anon', text, message.from.id);
    // Group report rollup (2026-10-24): same population as the log —
    // fail-open, never breaks the handler.
    try { await tallyRollup(chatId, 'messages'); } catch { /* rollup best-effort */ }
  }

  // E4a anti-flood (source middleware position — every group message,
  // commands included; admins exempt; delete + warn only, never a mute).
  if (isGroupChat && message.from && !message.from.is_bot) {
    let flooded = false;
    try { flooded = await antiFloodHook(chatId, message); } catch { /* never break the handler */ }
    if (flooded) {
      await tallyRoutingExit(chatId, 'consumed:antiflood');
      maybeTick().catch(() => {});
      return;
    }
  }

  // Contest wizard text steps (design §4): when an admin's /contest wizard
  // is awaiting a name / prize text, their next plain message in this chat
  // is the input. Commands always bypass the wizard untouched.
  if (!text.startsWith('/')) {
    // Portal wallet capture (/manage Phase 2): a member who just passed
    // a portal gate was asked in DM to send a Base wallet address; while
    // that capture is pending (5 min), an address-shaped DM is the
    // answer. Anything else falls through untouched.
    if (isPrivate) {
      try {
        if (await handlePortalWalletCapture(chatId, message)) {
          await tallyRoutingExit(chatId, 'consumed:portal-wallet');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[portal-capture]', err?.message ?? err); // never break the handler
      }
      // Portal polish setup captures: an admin who tapped "Set welcome
      // text" / "Set banner" in the /manage Portal page supplies the
      // value as their next DM message (text for the welcome, media —
      // incl. captioned media — for the banner). Non-matching messages
      // fall through untouched.
      try {
        if (await handlePortalSetupCapture(chatId, message)) {
          await tallyRoutingExit(chatId, 'consumed:portal-setup');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[portal-setup-capture]', err?.message ?? err); // never break the handler
      }
    }
    try {
      if (await handleContestWizardText(chatId, message.from, text)) {
        await tallyRoutingExit(chatId, 'consumed:contest-wizard');
        maybeTick().catch(() => {});
        return;
      }
    } catch (err) {
      console.error('[contest-wiz]', err?.message ?? err); // never break the handler
    }
    // Menu-button captures (2026-11-05): a /menu button in this chat armed
    // a one-shot capture for the tapper (scan contract / generate prompt).
    // Group-capable by design — the capture is tapper-scoped AND
    // chat-scoped, so another user's message never consumes it, and a
    // command ('/...') never reaches it (this block only runs for plain
    // text). Self-gated: no capture armed, no consume.
    try {
      if (await handleMenuCaptureText(chatId, message, text)) {
        await tallyRoutingExit(chatId, 'consumed:menu-capture');
        maybeTick().catch(() => {});
        return;
      }
    } catch (err) {
      console.error('[menu-cap]', err?.message ?? err); // never break the handler
    }
    // Studio wizard photo intake, captioned photos (2026-11-04): a
    // captioned photo never reaches the caption-less media block above,
    // so the photo is captured here, before the caption-as-text routing
    // below. Self-gated (no wizard awaiting intake, no consume).
    if (isPrivate && message.photo?.length) {
      try {
        if (await handleStudioWizardPhoto(chatId, message.from, message)) {
          await tallyRoutingExit(chatId, 'consumed:studio-wizard-photo');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[studio-wiz-photo]', err?.message ?? err); // never break the handler
      }
    }
    // Wave 5 sight: a captioned DM photo is read by the same Gemini
    // vision call — the caption rides as the question. On success the
    // photo is consumed; on failure the caption falls through to the
    // text brain below, exactly as today. Commands never reach here
    // (this block sits inside the !text.startsWith('/') branch).
    if (isPrivate && message.photo?.length) {
      try {
        if (await tryDmVision(chatId, message)) {
          await tallyRoutingExit(chatId, 'consumed:dm-vision');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[dm-vision]', err?.message ?? err); // never break the handler
      }
    }
    // Studio wizard text steps (Batches 1–3): in a DM, when /create is
    // live and the wizard is awaiting a brief / token, the user's next
    // plain message is the input. Scoped to their own id (DM only).
    if (isPrivate) {
      try {
        if (await handleStudioWizardText(chatId, message.from, text)) {
          await tallyRoutingExit(chatId, 'consumed:studio-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[studio-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Podcast wizard text steps (revival, 2026-10-20): in a DM, when
    // /podcast is live and the wizard awaits a topic, the user's next
    // plain message is the input. Scoped to their own id (DM only);
    // flag OFF the capture returns false instantly.
    if (isPrivate) {
      try {
        if (await handlePodcastWizardText(chatId, message.from, text)) {
          await tallyRoutingExit(chatId, 'consumed:podcast-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[podcast-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Boost/Airdrop wizard text steps (rebuild, 2026-10-20; routing fix
    // 2026-10-25): in a DM, when a money wizard is awaiting an address /
    // amount / list, the user's next plain message is the input. Scoped
    // to their own id (DM only); flag OFF the captures return false
    // instantly.
    // HIJACK FIX: two defects let free text escape to the agent loop —
    // (1) the old block offered text to boost FIRST regardless of which
    // wizard the user touched last, so a stale boost draft ate airdrop
    // input (and vice versa in principle); (2) one shared try/catch let
    // a wizard that THREW (e.g. the boost quote build on the refund
    // step) skip the other wizard AND fall through to nlcmd, where a
    // bare wallet address became a loop goal. The new routing: when
    // both wizards are live, ONLY the most recently touched consumes;
    // when one is live, only it does; a live wizard that throws keeps
    // the input (error + retry) instead of falling through; and the
    // guard below re-prompts rather than letting live-wizard input
    // become a loop goal. The guard is skipped while a loop is already
    // active, so its control words (notably "stop") still reach it.
    if (isPrivate) {
      const wizUid = message.from?.id;
      const boostLive = await isBoostWizardActive(wizUid).catch(() => false);
      const airdropLive = await isAirdropWizardActive(wizUid).catch(() => false);
      const boostTouch = boostLive ? await boostWizardTouch(wizUid).catch(() => 0) : 0;
      const airdropTouch = airdropLive ? await airdropWizardTouch(wizUid).catch(() => 0) : 0;
      const wizOrder = pickMoneyWizardOrder({ boostLive, boostTouch, airdropLive, airdropTouch });
      for (const wiz of wizOrder) {
        const live = wiz === 'boost' ? boostLive : airdropLive;
        let consumed = false;
        try {
          consumed = wiz === 'boost'
            ? await handleBoostWizardText(chatId, message.from, text)
            : await handleAirdropWizardText(chatId, message.from, text);
        } catch (err) {
          console.error(`[${wiz}-wiz]`, err?.message ?? err); // never break the handler
          if (live) {
            // Owned-session throw: keep the input, never fall to the loop.
            await sendSafe(chatId, '⚠️ That wizard hit a snag — your place is kept. Send the value again.');
            await tallyRoutingExit(chatId, `consumed:${wiz}-wizard-error`);
            maybeTick().catch(() => {});
            return;
          }
          continue; // not live: try the next wizard / fall through
        }
        if (consumed) {
          await tallyRoutingExit(chatId, `consumed:${wiz}-wizard`);
          maybeTick().catch(() => {});
          return;
        }
        // Declined despite being live: do NOT offer the other wizard
        // (it would cross-eat); the guard below handles it.
        if (live) break;
      }
      // Guard: a live money wizard declined input (shouldn't happen —
      // the handlers consume every live stage incl. quoted). Never let
      // it become a loop goal; re-prompt instead.
      if ((boostLive || airdropLive) && !(await isAgentLoopActive(String(wizUid)).catch(() => false))) {
        const wiz = airdropLive && airdropTouch >= boostTouch ? 'airdrop' : 'boost';
        const next = wiz === 'airdrop'
          ? await airdropWizardNextPrompt(wizUid).catch(() => null)
          : await boostWizardNextPrompt(wizUid).catch(() => null);
        await sendSafe(chatId, `🧭 You're in the middle of the ${wiz} wizard — ${next ?? 'send the requested value, or tap Cancel on the panel.'}`);
        await tallyRoutingExit(chatId, 'consumed:money-wizard-guard');
        maybeTick().catch(() => {});
        return;
      }
    }
    // Inbound sales leg (2026-11-05): in a DM, while a sales wizard
    // awaits text, the user's next plain message is that input. Scoped
    // to their own id; commands always bypass. Runs after the money
    // wizards (so a live money wizard wins) and before the brain.
    if (isPrivate) {
      try {
        if (await handleSalesWizardText(message.from?.id, text, message.from)) {
          await tallyRoutingExit(chatId, 'consumed:sales-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[sales-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // PB Relay wizard text steps (Wave 1, 2026-10-21): in a DM, when the
    // /relay wizard awaits a typed @username / chat id at its source or
    // destination step, the user's next plain message is the input.
    // Scoped to their own id (DM only); no armed draft → returns false.
    if (isPrivate) {
      try {
        if (await handleRelayWizardText(chatId, message.from, text)) {
          await tallyRoutingExit(chatId, 'consumed:relay-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[relay-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // PB Announce wizard text steps (2026-10-22): in a DM, while an
    // /announce session awaits a pasted CA, the news text, or edited post
    // text, the user's next plain message is that input. Scoped to their
    // own session row (annwiz:<uid>); no armed session → returns false.
    if (isPrivate) {
      try {
        if (await handleAnnounceWizardText(chatId, message.from, text)) {
          await tallyRoutingExit(chatId, 'consumed:announce-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[announce-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Business Bot editor wizard (item 1): in a DM, when the user tapped
    // an ✏️ edit button in /bizsetup, their next plain message is the new
    // greeting / fixed / fallback / persona value. Scoped to their own id.
    if (isPrivate) {
      try {
        if (await handleBizWizardText(message.from?.id, text)) {
          await tallyRoutingExit(chatId, 'consumed:biz-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[biz-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Feedback/review wizard (2026-11-05): in a DM, while a feedback or
    // review session awaits text, the user's next plain message is that
    // input. Scoped to their own id; commands always bypass.
    if (isPrivate) {
      try {
        if (await handleFeedbackWizardText(message.from?.id, text, message.from)) {
          await tallyRoutingExit(chatId, 'consumed:feedback-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[feedback-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Skill input capture (Mini App Chat wave, 2026-11-05): in a DM, while
    // a skill awaits typed input (tapped a skill button that needs text),
    // the user's next plain message is that input. Scoped to their own id;
    // commands always bypass; consumes exactly one text.
    if (isPrivate) {
      try {
        if (await handleSkillWizardText(message.from?.id, text, message.from)) {
          await tallyRoutingExit(chatId, 'consumed:skill-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[skill-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Website builder v1 (2026-11-05): in a DM, while a site wizard
    // awaits text, the user's next plain message is that input.
    // Scoped to their own id; commands always bypass.
    if (isPrivate) {
      try {
        if (await handleSiteWizardText(message.from?.id, text, message.from)) {
          await tallyRoutingExit(chatId, 'consumed:site-wizard');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[site-wiz]', err?.message ?? err); // never break the handler
      }
    }
    // Inbound sales leg (2026-11-05): a DM buying-intent message from a
    // lead-matched sender starts qualify. No match → falls through to
    // the brain as today (no hijack). Never fires while a money wizard
    // is live (that block already returned above).
    if (isPrivate) {
      try {
        if (await maybeStartSalesFromText(message.from?.id, text, message.from)) {
          await tallyRoutingExit(chatId, 'consumed:sales-entry');
          maybeTick().catch(() => {});
          return;
        }
      } catch (err) {
        console.error('[sales-entry]', err?.message ?? err); // never break the handler
      }
    }
    // Wizard-restore wave (2026-10-21): the restored captures. Each checks
    // its own armed config-key session and returns false when unarmed, so
    // order only matters among simultaneously-armed sessions; /setrules
    // goes LAST because it consumes arbitrary text as the rules body.
    if (isPrivate) {
      const wizCaptures = [
        ['raid-wiz', () => handleRaidWizardText(chatId, message)],
        ['remote-wiz', () => handleRemoteWizardText(chatId, message)],
        ['setup-wiz', () => handleSetupWizardText(chatId, message)],
        ['apply-wiz', () => handleApplyWizardText(chatId, message)],
        // Overnight build 2026-10-25 (local only): /wizbuy purchase wizard.
        ['wizbuy', () => handleBuyWizardText(chatId, message)],
        // Planbuy wave (2026-11-03): in-bot Plan purchase text capture.
        ['planbuy', () => handlePlanbuyText(chatId, message)],
        // Wizard-fix wave: Connect Socials captures (TikTok / Discord /
        // Pro+ API keys). Before xsetup-cap: the panel's own sessions are
        // distinct keys, and an armed apikeys capture must win over the
        // generic consumers below (it deletes the secrets message).
        ['socials-cap', () => handleSocialsCapture(chatId, message)],
        ['xsetup-cap', () => handleXSetupCapture(chatId, message)],
        ['mywallet-cap', () => handleMyWalletCapture(chatId, message)],
        ['team-cap', () => handleTeamCapture(chatId, message)],
        ['xprewards-cap', () => handleXpRewardsWalletCapture(chatId, message)],
        ['support-cap', () => handleSupportCapture(chatId, message)],
        ['promo-cap', () => handlePromoCapture(chatId, message)],
        // Buy Bot Phase 5: competition-wizard prize/min captures.
        // Consumes ONLY while a bbcompwiz draft awaits a value.
        ['bbcomp-cap', () => handleBuyCompCapture(chatId, message)],
        // Buy Bot Phase 3: panel-armed field/banner captures. Before
        // setrules (which consumes arbitrary text); consumes ONLY while
        // a bb_capture session is armed for this admin.
        ['bb-cap', () => handleBuyBotCapture(chatId, message)],
        // Setup Wizard (2026-11-04): consumes arbitrary text like
        // setrules, so it goes BEFORE setrules-cap; returns false unless
        // its own session is armed, so unarmed DMs fall through untouched.
        ['setupwiz-cap', () => handleSetupWizardCapture(chatId, message)],
        ['setrules-cap', () => handleSetRulesCapture(chatId, message)],
      ];
      for (const [label, run] of wizCaptures) {
        try {
          if (await run()) {
            await tallyRoutingExit(chatId, `consumed:${label}`);
            maybeTick().catch(() => {});
            return;
          }
        } catch (err) {
          console.error(`[${label}]`, err?.message ?? err); // never break the handler
        }
      }
    }
  }

  // E4a: an open support session continues in DM (source :6538). Fires
  // only for users with a live session — everyone else falls through.
  if (isPrivate && !text.startsWith('/')) {
    try {
      if (await handleSupportDmFollowup(chatId, message)) {
        await tallyRoutingExit(chatId, 'consumed:support-dm');
        maybeTick().catch(() => {});
        return;
      }
    } catch (err) {
      console.error('[support-dm]', err?.message ?? err); // never break the handler
    }
  }

  // DM greeting (2026-10-28): a first-ever DM gets one greeting, then
  // normal processing continues. Best-effort, never breaks the handler.
  // Sits AFTER support-DM consumption (support followups never greet)
  // and BEFORE command dispatch / brain routing.
  try { await maybeDmGreet(chatId, message, text); } catch (err) { console.error('[dm-greet]', err?.message ?? err); }

  const cmd = parseCommand(text);
  if (cmd) {
    // If the command names another bot (@otherbot), ignore it.
    if (cmd.at) {
      try {
        const me = await botIdentity();
        // Answer-path wave: a command for another bot was an un-tallied
        // silent exit. Not addressed to PB, no answer owed — counted.
        if (me.username && cmd.at.toLowerCase() !== me.username.toLowerCase()) { await tallyRoutingExit(chatId, 'skipped_other_bot'); return; }
      } catch { /* fall through and handle */ }
    }
    // Fix PB (2026-10-25): an unknown command died SILENTLY even in DMs —
    // the owner typed /airdroped four times and got zero replies, which
    // looked like the bot was broken. In a private chat, say so (groups
    // stay silent: other bots' commands and member typos must not spam).
    if (!isSupportedTelegramCommand(cmd.name) && !EXTRA_COMMANDS.has(cmd.name)) {
      if (isPrivate) {
        await sendSafe(chatId, `❓ I don't know /${cmd.name}. See /help for what I can do.`);
      } else {
        // Answer-path wave: group silence for unknown commands is by
        // design (other bots' commands, member typos), but it was
        // un-tallied. Counted now; still silent, still no latch (a
        // command is never a brain trigger).
        await tallyRoutingExit(chatId, 'skipped_unknown_command');
      }
      return;
    }
    const canonical = resolveCanonicalCommand(cmd.name);
    // E4a support-group command firewall (source :7307): in a support
    // group the dedicated support handler is the only voice — commands
    // are silently ignored. DEVIATION, deliberate: the source's wrap also
    // swallowed /setsupport itself, trapping the toggle; here /setsupport
    // stays reachable so the owner can turn the mode back off.
    if (isGroupChat && canonical !== 'setsupport') {
      let support = false;
      try { support = await isSupportModeChat(chatId, chat, message.message_thread_id); } catch { /* fall through */ }
      // Answer-path wave: the support-command firewall was an
      // un-tallied silent exit — a command swallowed by support mode
      // left no trace. Counted now; commands never latch either way.
      if (support) { await tallyRoutingExit(chatId, 'consumed:support-command-firewall'); return; }
    }
    // PB Cleanup recording (2026-10-22): in a cleanup-on group, a
    // NON-ADMIN human member's command invocation is recorded as tidy
    // clutter and a reply capture is armed for this dispatch — PB's
    // replies through the instrumented send seams record themselves
    // against it. Owner / admins / bots / anonymous-admin posts are
    // NEVER recorded (hard rail). /cleanup itself is excluded: its
    // status output is not clutter. Self-gating + never throws.
    if (isGroupChat && canonical !== 'cleanup' && message.from
      && !message.from.is_bot && !message.sender_chat) {
      try {
        const cs = await getGroupSettings(chatId);
        if (cs.cleanupEnabled === true
          && !(await isOwnerId(message.from.id))
          && !(await isChatAdmin(chatId, message.from.id))) {
          await cleanupRecordCommand(chatId, message.message_id);
          cleanupBeginCapture(chatId, message.message_id);
        }
      } catch { /* never break the handler */ }
    }
    // /setsupport — owner toggles support mode (PB Support takes over the
    // group's member traffic). Source: telegram-community-bot.ts:15064;
    // storage is the group_settings flag (lib/groups.js), the engine is
    // lib/groupmsg.js.
    if (canonical === 'setsupport') {
      if (isPrivate) {
        await sendSafe(chatId, 'ℹ️ /setsupport only works in groups.');
        return;
      }
      if (!(await isOwnerId(message.from?.id))) {
        await sendSafe(chatId, '🔒 Only the bot owner can toggle support mode.', { reply_to_message_id: message.message_id });
        return;
      }
      const arg = cmd.args.trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        const enable = arg === 'on';
        await setGroupSettings(chatId, { supportMode: enable });
        // Q2 wave 2026-10-31: in the designated support group the flag alone
        // does not turn support mode off — saying "normal behavior restored"
        // there was false. The off reply says so plainly instead.
        const stAfter = enable ? null : await getSupportModeStatus(chatId, chat, message.message_thread_id);
        await sendSafe(chatId,
          enable
            ? '✅ *Support mode ON* — PB Support now handles member questions in this group.'
            : stAfter?.designated
              ? '🔕 Support-mode flag OFF — but this is the designated support group, so support mode stays ON by designation.'
              : '🔕 *Support mode OFF* — normal bot behavior restored in this group.',
          { parse_mode: 'Markdown' });
        return;
      }
      // Q2 wave 2026-10-31: the status must reflect the EFFECTIVE mode —
      // the old text read only the flag and said OFF in the designated
      // support group while enforcement was already ON there.
      const stNow = await getSupportModeStatus(chatId, chat, message.message_thread_id);
      const stSource = stNow.flag && stNow.designated
        ? 'Source: the support-mode flag is ON (this is also the designated support group).'
        : stNow.flag
          ? 'Source: the support-mode flag is ON.'
          : stNow.designated
            ? 'Source: this is the designated support group, so support mode stays ON even though the flag is OFF.'
            : 'Source: neither the flag nor a designation applies.';
      await sendSafe(chatId,
        `🎧 Support mode is currently *${stNow.effective ? 'ON' : 'OFF'}* in this group.\n${stSource}\nUse \`/setsupport on\` or \`/setsupport off\` to change it.`,
        { parse_mode: 'Markdown' });
      return;
    }
    // Owner-only clock command (not in the public catalog): forces the
    // external-clock cycles and reports the summary. DM + owner only.
    if (canonical === 'tick') {
      if (message.chat.type !== 'private') {
        await sendSafe(chatId, '🔒 That one needs a private chat — open a DM with me and run it there.');
        return;
      }
      if (!(await isOwnerId(message.from?.id))) return;
      await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
      const summary = await runDueCycles().catch((e) => ({ error: e?.message ?? 'unknown' }));
      const lines = ['⏱️ Tick complete'];
      for (const [name, r] of Object.entries(summary.cycles ?? {})) {
        if (r?.error) lines.push(`• ${name}: ❌ ${r.error}`);
        else {
          const parts = Object.entries(r).filter(([k]) => !['ranAt', 'skipped'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ');
          lines.push(`• ${name}: ${parts || 'ok'}`);
        }
      }
      await sendSafe(chatId, lines.join('\n'));
      return;
    }
    // Owner-only secret setter (not in the public catalog): the owner DMs
    // PB a key directly; it lands in the config table. PB cannot delete
    // the owner's DM messages, so the usage reply tells him to delete the
    // message himself — never claim a deletion that cannot happen.
    if (canonical === 'setkey') {
      if (message.chat.type !== 'private') return;
      if (!(await isOwnerId(message.from?.id))) return;
      const parts = cmd.args.trim().split(/\s+/);
      const name = (parts[0] ?? '').toUpperCase();
      const value = parts.slice(1).join(' ');
      await api.deleteMessage({ chat_id: chatId, message_id: message.message_id }).catch(() => {});
      if (!/^[A-Z0-9_]{3,64}$/.test(name) || !value) {
        await sendSafe(chatId, 'Usage: /setkey NAME value — PB cannot delete your DM messages, so delete that message yourself.');
        return;
      }
      // Audit F19: known boolean flags are normalized at write time to
      // '1'/'0' under their canonical (lowercase) key — the key the
      // readers read. Without this, typing the natural `true` stored a
      // verbatim literal on an UPPERCASED row no flag reader ever sees,
      // silently leaving the feature in its previous state.
      const boolKey = canonicalBooleanConfigKey(name);
      if (boolKey) {
        // Paste trap (2026-10-25): the owner pasted two commands in one
        // message, so the value arrived as "1 /setkey AIRDROP_ENABLED 1".
        // That is not a boolean — normalizing it silently wrote 0 while
        // replying "Saved ... It's live now". A boolean value is one
        // token; anything with whitespace or a slash is a pasted
        // multi-command message: refuse it loudly instead of writing.
        const rawBool = value.trim();
        if (/\s/.test(rawBool) || rawBool.includes('/')) {
          await sendSafe(chatId, '⚠️ That looks like more than one command pasted into one message — I only read the first command per message, so nothing was saved. Send one command per message: /setkey BOOST_ENABLED 1 on its own, then /setkey AIRDROP_ENABLED 1 on its own.');
          return;
        }
        const normalized = flagValueOn(value) ? '1' : '0';
        await setConfig(boolKey, normalized);
        await sendSafe(chatId, `🔐 Saved ${boolKey} = ${normalized} (boolean flag, normalized from "${value}"). It's live now.`);
        return;
      }
      await setConfig(name, value);
      await sendSafe(chatId, `🔐 Saved ${name} (${value.length} chars). It's live now — try /ask.`);
      return;
    }
    // Owner-only menu re-register (Wizard-fix wave): the tick's menuSync
    // cycle keeps the "/" menus at MENU_CATALOG_VERSION on its own; this
    // forces registration NOW (e.g. right after a deploy) and reports the
    // scoped counts. DM + owner only, like /setkey.
    if (canonical === 'menusync') {
      if (message.chat.type !== 'private') return;
      if (!(await isOwnerId(message.from?.id))) {
        // W4 refusal polish (Class B): owner commands answer non-owners.
        await sendSafe(chatId, '🔒 Owner only.');
        return;
      }
      const res = await registerBotMenus({ force: true });
      await sendSafe(chatId, res.registered
        ? `📋 Menus re-registered (catalog v${res.version}) — default ${res.counts.default} · private chats ${res.counts.private} · groups ${res.counts.group}.`
        : `⚠️ Menu registration failed: ${res.error ?? 'unknown'}`);
      return;
    }
    // Community learning (2026-10-28, spec §2.7): owner-only per-community
    // profile read / edit / wipe. DM + owner only, like /setkey (silent
    // for non-owners). Each command names exactly one chat; no digest
    // ever mixes communities. Edit text is used as-is (capped 1500);
    // wipe empties live + shadow + flag + counters, no backup kept.
    if (canonical === 'pbprofile' || canonical === 'pbprofileset' || canonical === 'pbprofilewipe') {
      if (message.chat.type !== 'private') return;
      if (!(await isOwnerId(message.from?.id))) return;
      const argParts = cmd.args.trim().split(/\s+/);
      const targetChat = argParts[0] ?? '';
      if (!/^-?\d+$/.test(targetChat)) {
        await sendSafe(chatId, 'Usage: /pbprofile <chatId> · /pbprofileset <chatId> <text> · /pbprofilewipe <chatId>');
        return;
      }
      if (canonical === 'pbprofile') {
        const p = await readCommunityProfiles(targetChat);
        await sendSafe(chatId, [
          `📋 Community profile for chat ${targetChat}`,
          `Graduated: ${p.graduated ? 'yes (live)' : 'no (shadow only)'} · shadow refreshes: ${p.refreshes} · answered turns: ${p.answered} · seal violations: ${p.sealViolations}`,
          '',
          `LIVE: ${p.live || '(empty)'}`,
        ].join('\n'));
        if (p.shadow) await sendSafe(chatId, `SHADOW: ${p.shadow}`);
        return;
      }
      if (canonical === 'pbprofileset') {
        const text = cmd.args.trim().slice(targetChat.length).trim();
        if (!text) { await sendSafe(chatId, 'Usage: /pbprofileset <chatId> <text>'); return; }
        await setCommunityProfileText(targetChat, text);
        await sendSafe(chatId, `📋 Live profile for chat ${targetChat} replaced (used as-is; the next fold merges from it).`);
        return;
      }
      await wipeCommunityProfiles(targetChat);
      await sendSafe(chatId, `📋 Profiles for chat ${targetChat} wiped (live + shadow + graduation flag). Shadow rebuilds from new turns; live stays empty until re-graduated.`);
      return;
    }
    // X post analytics (2026-10-28): owner-only scoreboard. DM + owner
    // only, silent for non-owners — same guard shape as /pbprofile above.
    // Read-only: PB's own public post snippets + public counts, no
    // community message content ever involved.
    if (canonical === 'xstats') {
      if (message.chat.type !== 'private') return;
      if (!(await isOwnerId(message.from?.id))) return;
      await sendSafe(chatId, xPostStatsBoardText(await xPostStatsBoard()));
      return;
    }
    // DM greeting (2026-10-28): owner-only greeting text control. DM +
    // owner only, silent for non-owners — same guard shape as /pbprofile.
    // /setgreeting <text> sets custom text; /setgreeting off disables;
    // bare /setgreeting shows the current text/state.
    if (canonical === 'setgreeting') {
      if (message.chat.type !== 'private') return;
      if (!(await isOwnerId(message.from?.id))) return;
      const arg = cmd.args.trim();
      if (!arg) {
        const cur = await dmGreetingText();
        await sendSafe(chatId, cur === null
          ? '👋 DM greeting: OFF — new DMers get no greeting. Use /setgreeting <text> to set one.'
          : `👋 DM greeting (current${cur === DM_GREETING_DEFAULT ? ' — default' : ''}):\n\n${cur}`);
        return;
      }
      if (arg.toLowerCase() === 'off') {
        await setConfig(DM_GREETING_KEY, 'off');
        await sendSafe(chatId, '👋 DM greeting OFF — new DMers will no longer be greeted.');
        return;
      }
      await setConfig(DM_GREETING_KEY, arg.slice(0, 4000));
      await sendSafe(chatId, '👋 DM greeting updated. The next first-time DMer gets the new text.');
      return;
    }
    // /freechat — owner toggles free-chat mode (PB responds to all group
    // messages). Ported faithfully from telegram-community-bot.ts.
    if (canonical === 'freechat') {
      if (isPrivate) {
        await sendSafe(chatId, 'ℹ️ /freechat only works in groups.');
        return;
      }
      if (!(await isOwnerId(message.from?.id))) {
        await sendSafe(chatId, '🔒 Only the bot owner can toggle free-chat mode.', { reply_to_message_id: message.message_id });
        return;
      }
      const arg = cmd.args.trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        const enable = arg === 'on';
        await setFreeChatGroup(chatId, enable);
        await sendSafe(chatId,
          enable
            ? '✅ *Free-chat mode ON* — PB will now respond to all messages in this group without needing to be mentioned.'
            : '🔕 *Free-chat mode OFF* — PB will only respond when mentioned or triggered.',
          { parse_mode: 'Markdown' });
        return;
      }
      const current = await isFreeChatGroup(chatId);
      await sendSafe(chatId,
        `🤖 Free-chat mode is currently *${current ? 'ON' : 'OFF'}* in this group.\nUse \`/freechat on\` or \`/freechat off\` to change it.`,
        { parse_mode: 'Markdown' });
      return;
    }
    // /globalboard — group admins (or the owner) opt this community into the
    // global cross-community leaderboard shown in the Mini App's Raids tab.
    // Stats-only participation: raid XP totals, raids completed, raider counts.
    // Calls, token addresses, wallets, member lists and messages never cross.
    if (canonical === 'globalboard') {
      if (isPrivate) {
        await sendSafe(chatId, 'ℹ️ /globalboard only works in groups.');
        return;
      }
      const canToggle = (await isOwnerId(message.from?.id)) || (await isGroupAdmin(chatId, message.from?.id));
      if (!canToggle) {
        await sendSafe(chatId, '🔒 Only group admins can toggle the global leaderboard.', { reply_to_message_id: message.message_id });
        return;
      }
      const arg = cmd.args.trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        const enable = arg === 'on';
        await setGroupSettings(chatId, { globalBoard: enable });
        await sendSafe(chatId,
          enable
            ? '✅ *Global leaderboard ON* — this community is now competing on the global board. Only stats cross over (raid XP, raids, raiders); your calls and token addresses stay in this group.'
            : '🚫 *Global leaderboard OFF* — this community no longer appears on the global board.',
          { parse_mode: 'Markdown' });
        return;
      }
      const gs = await getGroupSettings(chatId);
      await sendSafe(chatId,
        `🌍 The global leaderboard is currently *${gs.globalBoard ? 'ON' : 'OFF'}* for this community.\nUse \`/globalboard on\` or \`/globalboard off\` to change it.`,
        { parse_mode: 'Markdown' });
      return;
    }
    // /slayer on|off — group admins (or the owner) opt this community into
    // the Chart Slayer game (design §1: guess the token from its mystery
    // chart, ~10-min rounds, XP on reveal). Default OFF everywhere; rounds,
    // answers, guesses and XP are sealed inside this chat — no cross-group
    // board. The answer pool is global majors only, so no group's call or
    // featured token can ever appear in another group's game.
    if (canonical === 'slayer') {
      if (isPrivate) {
        // Owner-only sandbox: the owner may test the game in their own DM.
        if (!(await isOwnerId(message.from?.id))) {
          await sendSafe(chatId, 'ℹ️ /slayer only works in groups.');
          return;
        }
      } else {
        const canToggle = (await isOwnerId(message.from?.id)) || (await isGroupAdmin(chatId, message.from?.id));
        if (!canToggle) {
          await sendSafe(chatId, '🔒 Only group admins can toggle Chart Slayer.', { reply_to_message_id: message.message_id });
          return;
        }
      }
      const arg = cmd.args.trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        const enable = arg === 'on';
        await setGroupSettings(chatId, { chartSlayer: enable });
        await sendSafe(chatId,
          enable
            ? '✅ *Chart Slayer ON* — a mystery-chart round starts every ~10 minutes in this chat. Guess the token in the poll, earn XP!'
            : '🚫 *Chart Slayer OFF* — no new rounds will start here.',
          { parse_mode: 'Markdown' });
        return;
      }
      const slayerGs = await getGroupSettings(chatId);
      await sendSafe(chatId,
        `🎮 Chart Slayer is currently *${slayerGs.chartSlayer ? 'ON' : 'OFF'}* here.\nUse \`/slayer on\` or \`/slayer off\` to change it.`,
        { parse_mode: 'Markdown' });
      return;
    }
    // Contests — Forgotten Features §4 (v1). /contest runs the admin wizard
    // in this chat; /conteststatus (anyone) and /contestwinner (admins) are
    // hidden, non-menu, exactly as the original's were. Everything is sealed
    // by chat — a contest in one community is invisible to another.
    // Private-chat rule mirrors the original: /conteststatus works anywhere;
    // /contestwinner refused to run in private in the original, but the
    // owner's own DM is the sanctioned test sandbox (same allowance as
    // /slayer) — only the owner may use /contest or /contestwinner there.
    if (canonical === 'contest') {
      const isOwner = await isOwnerId(message.from?.id);
      if (isPrivate) {
        if (!isOwner) {
          await sendSafe(chatId, 'ℹ️ /contest only works in groups.');
          return;
        }
      } else if (!isOwner && !(await isGroupAdmin(chatId, message.from?.id))) {
        await sendSafe(chatId, '❌ Only admins can create a contest.');
        return;
      }
      await startContestWizard(chatId, message.from);
      maybeTick().catch(() => {});
      return;
    }
    if (canonical === 'conteststatus') {
      await handleContestStatus(chatId);
      maybeTick().catch(() => {});
      return;
    }
    if (canonical === 'contestwinner') {
      const isOwner = await isOwnerId(message.from?.id);
      if (isPrivate && !isOwner) {
        // W4 refusal polish (Class A): the original's silent private
        // refusal becomes the uniform group-only line. The owner's own
        // DM stays the sanctioned test sandbox.
        await sendSafe(chatId, 'ℹ️ This command works in groups only.');
        return;
      }
      if (!isPrivate && !isOwner && !(await isGroupAdmin(chatId, message.from?.id))) {
        await sendSafe(chatId, '❌ Only admins can trigger winner calculation.');
        return;
      }
      await handleContestWinner(chatId);
      maybeTick().catch(() => {});
      return;
    }
    if (canonical === 'ask' || canonical === 'ai') {
      const q = cmd.args.trim();
      if (!q) {
        await sendSafe(chatId, '❓ Ask me something — e.g. /ask what is PoorBoyAI?');
        return;
      }
      await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
      // Answer-path wave: group /ask is an explicit brain request, so
      // it stamps a trigger exactly like a routed group message. A
      // dead /ask must page and recover the same way a dead "PB …"
      // does; DM /ask never stamps (the group latch is group-only).
      if (isGroupChat) await stampTriggered(chatId, 'command-ask').catch(() => {});
      if (isGroupChat) await stampDiagTriggered(chatId, 'command-ask').catch(() => {});
      await tallyRoutingExit(chatId, 'handled');
      await handleBrainReplyGuarded(chatId, message, q,
        isPrivate ? 'private chat' : `group "${chat.title ?? 'unknown'}"`, 'command-ask');
      maybeTick().catch(() => {});
      return;
    }
    await dispatchCommand(chatId, canonical, cmd.args, message);
    // Opportunistic clock: reply already sent; tick runs best-effort on its own.
    maybeTick().catch(() => {});
    return;
  }

  // v1 plain-English command layer — owner DMs only. Non-command text from the
  // owner in a private chat gets one brain classification pass; if it isn't an
  // actionable command it falls through to normal chat untouched.
  if (isPrivate && !message.from?.is_bot && (await isOwnerId(message.from.id))) {
    // Second Brain S1 (2026-10-24): explicit owner-DM capture. Only the
    // "remember this:" form writes a row (flag-gated, inert when off);
    // the echo is the audit surface — a wrong capture is corrected by
    // reply, which writes a superseding row. Fail-open, never breaks chat.
    try {
      const captured = await captureOwnerDecision({ text, actorId: message.from.id, chatId });
      if (captured) {
        await sendSafe(chatId, `📝 Recorded under \`${captured.topicKey}\`: ${captured.decision.slice(0, 200)}`);
        await tallyRoutingExit(chatId, 'consumed:decision-capture');
        maybeTick().catch(() => {});
        return;
      }
    } catch (err) {
      console.error('[decision-capture]', err?.message ?? err); // fall through to chat
    }
    try {
      if (await handleOwnerNLCommand(chatId, message, text)) {
        await tallyRoutingExit(chatId, 'consumed:owner-nlcmd');
        maybeTick().catch(() => {});
        return;
      }
    } catch (err) {
      console.error('[nlcmd]', err?.message ?? err); // fall through to chat
    }
  }

  // Wave 3: auto-translate + FUD shield hooks run on plain group messages
  // (commands are excluded — they go through dispatch above).
  // Wave 4: keyword filters auto-reply (source: matchFilter hook).
  if (isGroupChat && !message.from?.is_bot) {
    // /manage Phase 2 enforcement: Anti-Porn (caption-keyword media) and
    // Banned Words run FIRST — a deleted message gets no filter reply,
    // no translation and no brain routing. Source order: anti-porn's
    // handler was registered before the banned-words one.
    let deleted = false;
    try { deleted = await antiPornHook(chatId, message); } catch { /* never break the handler */ }
    if (!deleted) {
      try { deleted = await bannedWordsHook(chatId, message); } catch { /* never break the handler */ }
    }
    // Shield link wizard paste capture (2026-10-31): runs BEFORE the
    // Shield hook so a pasted report is judged as a report, not deleted
    // as a post. Consumes ONLY while a wizard report capture is armed
    // for this user in this group; everyone else falls through untouched.
    // The capture itself deletes a malicious submission best-effort, so
    // a consumed report never reaches the hook.
    if (!deleted) {
      try {
        if (await handleShieldWizardCapture(chatId, message)) {
          await tallyRoutingExit(chatId, 'consumed:shield-wiz');
          maybeTick().catch(() => {});
          return;
        }
      } catch { /* never break the handler */ }
    }
    // PB Shield message checks (impersonation, watched-joiner link
    // quarantine, scam phrases) — self-gated on the group's
    // shieldEnabled flag; inert everywhere Shield is off.
    if (!deleted) {
      try { deleted = await shieldMessageHook(chatId, message); } catch { /* never break the handler */ }
    }
    if (deleted) {
      await tallyRoutingExit(chatId, 'consumed:moderation');
      maybeTick().catch(() => {});
      return;
    }
    // Auto-Ad Guard (F19, 2026-11-06): warn-only, never deletes, never
    // consumes — a warned message still flows to filters / translation /
    // brain below. Deliberately NOT chained into `deleted`.
    try { await adGuardHook(chatId, message); } catch { /* never break the handler */ }
    try {
      const filterReply = await matchFilter(chatId, text);
      if (filterReply) await sendSafe(chatId, filterReply);
    } catch { /* filter failures never break the handler */ }
    // GROUP-NL GUARD (2026-10-29, incident 18:23/18:25): an optional
    // translation must never gate an owed brain answer. In this
    // isolate there are no timers, so a hung provider call inside
    // autoTranslateHook kills the invocation silently (log row, no
    // tally, no trigger, no mirror) — exactly the incident signature.
    // If this message will route to the brain, skip translate: the
    // brain answers the original text anyway (multilingual), and for
    // English text translate would have returned SAME with no reply
    // at all, so the skip is invisible there. Unaddressed chatter
    // keeps translate exactly as before. Support-group traffic keeps
    // translate too (support answers, not the brain, so the guard
    // does not apply). All reads here are DB/config/API-cache only —
    // no provider call — and any failure falls back to the old
    // behavior (translate runs). Moderation, filter, FUD, vision,
    // relay, mirror, support, and routing order below are unchanged.
    let skipTranslateForRouted = false;
    try {
      const supportEarly = await isSupportModeChat(chatId, chat, message.message_thread_id);
      if (!supportEarly) {
        let meEarly = null;
        try { meEarly = await botIdentity(); } catch { meEarly = null; }
        const freeChatEarly = await isFreeChatGroup(chatId).catch(() => false);
        const routeEarly = routeTelegramConversation({
          chatType: chat.type,
          text,
          caption: message.caption,
          entities: message.entities,
          captionEntities: message.caption_entities,
          replyTo: message.reply_to_message
            ? { senderId: message.reply_to_message.from?.id, isBot: message.reply_to_message.from?.is_bot }
            : undefined,
          botUsername: meEarly?.username ?? 'PoorBoyAI_bot',
          botId: meEarly?.id,
          freeChatEnabled: !isPrivate && freeChatEarly,
          allowPrivateConversation: isPrivate,
        });
        skipTranslateForRouted = routeEarly.shouldHandleConversation;
      }
    } catch { skipTranslateForRouted = false; }
    if (!skipTranslateForRouted) await autoTranslateHook(chatId, message, text);
    await fudShieldHook(chatId, text, message.from.id);
    // E4a Auto Vision: captioned photos reach here (caption = text);
    // self-gated on the group setting + cooldown (lib/groups.js).
    try { await maybeAutoVision(chatId, message); } catch { /* never break the handler */ }
  }

  // PB Relay group-source hook (Wave 1, 2026-10-21): runs AFTER the
  // moderation hooks above (a post they deleted returned already) and
  // before brain routing, per PB-RELAY-SPEC §1.1. It sits outside the
  // is_bot block above on purpose: anonymous admin posts arrive as
  // @GroupAnonymousBot (is_bot) and are exactly what a group source's
  // default admin-posts scope must see. Inert unless an active,
  // consent-proven relay rule names this chat as its source; commands
  // never reach here (they dispatched and returned above).
  if (isGroupChat) {
    try { await relayGroupHook(chatId, message); } catch { /* never break the handler */ }
    // Telegram ↔ Discord mirror (2026-10-23): home-group member text
    // enqueues for Discord. Runs after moderation, before brain routing;
    // commands never reach here. Fail-open, self-gated to the paired chat.
    try { await mirrorGroupHook(chatId, message); } catch { /* never break the handler */ }
  }

  // E4a support mode (the source's :6840 early-return + dedicated handler
  // :5798): in a support group, non-command traffic belongs to PB
  // Support — never to general brain routing.
  if (isGroupChat && !message.from?.is_bot) {
    let support = false;
    try { support = await isSupportModeChat(chatId, chat, message.message_thread_id); } catch { /* fall through */ }
    if (support) {
      await tallyRoutingExit(chatId, 'consumed:support-group');
      try { await handleSupportGroupMessage(chatId, message); } catch (err) { console.error('[support]', err?.message ?? err); }
      maybeTick().catch(() => {});
      return;
    }
  }

  // GROUP-NL CHECKPOINT (2026-10-29): a cheap tally that localizes
  // the next silent death — annotation-block deaths show no
  // reached-routing, routing/brain deaths show it. Fail-open inside.
  // Raid declutter wave (2026-10-31): the drop-link hook + banner
  // capture sit HERE — after the support-group early return above and
  // after the Shield/moderation returns further up, so a support-chat
  // message or a Shield-deleted message never earns a confirm card.
  // Neither hook consumes the message: routing below runs untouched
  // (a banner capture only suppresses the drop-link card for that same
  // media message — the photo was a banner, not a raid drop).
  if (isGroupChat && !message.from?.is_bot) {
    let bannerCaptured = false;
    if (message.photo || message.animation || message.video) {
      try { bannerCaptured = await handleRaidBannerCapture(chatId, message); } catch { /* never break routing */ }
    }
    if (!bannerCaptured) {
      try { await maybeDropLinkRaid(chatId, message); } catch { /* never break routing */ }
    }
  }
  if (isGroupChat) await tallyRoutingExit(chatId, 'reached-routing');
  // Natural language — conversation routing (ported rules).
  let me = null;
  try { me = await botIdentity(); } catch { /* routing still works on text patterns */ }
  const route = routeTelegramConversation({
    chatType: chat.type,
    text,
    caption: message.caption,
    entities: message.entities,
    captionEntities: message.caption_entities,
    replyTo: message.reply_to_message
      ? { senderId: message.reply_to_message.from?.id, isBot: message.reply_to_message.from?.is_bot }
      : undefined,
    botUsername: me?.username ?? 'PoorBoyAI_bot',
    botId: me?.id,
    freeChatEnabled: !isPrivate && (await isFreeChatGroup(chatId)),
    allowPrivateConversation: isPrivate, // v1: DMs get the brain (see BUILD_NOTES)
  });

  if (!route.shouldHandleConversation) {
    // Routing-exit tally (2026-10-23): the two silent exits — the
    // message was aimed at another human, or PB simply wasn't
    // addressed and freechat doesn't cover it. Aggregates only.
    await tallyRoutingExit(chatId, route.isDirectedAtHuman ? 'skipped_directed_human' : 'skipped_not_addressed');
    maybeTick().catch(() => {});
    return;
  }
  // Answer-path wave: THE trigger stamp. This is the only place a
  // group brain episode begins — after every consuming gate (wizards,
  // moderation, support) and after routing has decided PB should
  // answer, immediately before the brain call. Chatter never reaches
  // here (it returned at the skip branch above), so chatter can never
  // latch. 'direct' covers the PB-name rule, @mention, and reply-to-PB;
  // 'freechat' covers freechat-on groups answering unaddressed traffic.
  if (isGroupChat) await stampTriggered(chatId, route.isDirectPbAddress ? 'direct' : 'freechat').catch(() => {});
  if (isGroupChat) await stampDiagTriggered(chatId, route.isDirectPbAddress ? 'direct' : 'freechat').catch(() => {});
  await tallyRoutingExit(chatId, 'handled');
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  await handleBrainReplyGuarded(chatId, message, text,
    isPrivate ? 'private chat' : `group "${chat.title ?? 'unknown'}"`,
    isPrivate ? 'dm' : (route.isDirectPbAddress ? 'direct' : 'freechat'));
  // Opportunistic clock: reply already sent; tick runs best-effort on its own.
  maybeTick().catch(() => {});
}

// Wizard-fix wave seam (mirrors lib/tick.js's __test precedent): the live
// dispatchable-name registry — every COMMANDS key plus the EXTRA_COMMANDS
// the gate also admits. The menu/help harness asserts the catalog's
// HELP_SECTIONS + scoped menus cover exactly this set, so a future
// command can never silently fall out of the discovery surfaces again.
export function listDispatchableCommands() {
  return [...new Set([...Object.keys(COMMANDS), ...EXTRA_COMMANDS])].sort();
}

// Overnight-2 test seam (mirrors lib/tick.js's __test precedent): the
// harness drives sendBrainReply with a stubbed Bot API so the retry +
// failed-send stamp are provable without sending a real message.
// Task 3 adds buyCommand so the /buy repair is provable the same way.
export const __test = { sendBrainReply, handleBrainReply, buyCommand: COMMANDS.buy, maybeDmGreet, dmGreetingText, DM_GREETING_DEFAULT };

// Watchdog capture (2026-10-22): the handler's top level. An error that
// escapes handleMessageImpl is recorded in command_errors (content-free:
// command name + chat id + error class — see lib/groups.js) and then
// RETHROWN, so platform-visible behavior is exactly what it was before
// capture existed. The capture itself is fail-open.
export default async function (message, ctx) {
  // Message-path watchdog stamp (2026-10-23, lib/groups.js): record that
  // the handler was INVOKED at all, so a frozen dispatch path is visible
  // to the tick's msgpath section. Throttled + fail-open inside.
  await stampMessagePath(message);
  // Community diagnosis (2026-10-28): per-chat handled stamp for group
  // chats only (any message, not just triggered) + community title.
  if (message?.chat?.type === 'group' || message?.chat?.type === 'supergroup') {
    await stampDiagHandled(message.chat.id, message.chat.title).catch(() => {});
  }
  try {
    return await handleMessageImpl(message, ctx);
  } catch (err) {
    await captureCommandError({
      surface: 'message',
      chatId: message?.chat?.id,
      label: errorLabelForMessage(message),
      err,
    });
    console.error('[message]', err?.message ?? err);
    throw err;
  }
}
