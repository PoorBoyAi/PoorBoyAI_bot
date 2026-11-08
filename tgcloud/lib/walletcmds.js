// lib/walletcmds.js — /mywallet, /mywatched, /unwatchwallet.
//
// Ports the wallet command trio from the original
// artifacts/api-server/src/lib/telegram-community-bot.ts
// (/unwatchwallet ~13037, /mywatched ~13058, /mywallet ~14302),
// cross-checked against the Discord twins in discord-bot.ts
// (handleMyWallet ~1474, handleStopWatch ~2647, handleMyWatched ~2662).
// COMMANDS-map shape is the house one: async (chatId, args, msg) => {...}.
//
// Live wiring vs the originals:
// - The original /mywallet read `airdrop_wallets` (base/sol/rh). The cloud
//   schema's equivalent is user_wallets, which carries all three slots
//   (base_address / sol_address / rh_address).
// - Wizard-restore wave: the original's inline set-wallet buttons
//   (mywallet:set:base|sol|rh) are LIVE again below — each arms a 5-minute
//   DM capture session (config key) and the reply writes the same
//   user_wallets store /connect writes (Base/Solana via accounts
//   setUserWallet, so the first-Base welcome claim fires identically;
//   Robinhood via accounts setRhWallet, since setUserWallet routes 0x
//   addresses to Base and cannot target RH). /xprewards is restored in
//   this file too: status panel + the wallet-registration capture +
//   holder verify against the XP-context community. The XP→$PBAI
//   redemption SEND was a master-wallet payout in the original and had
//   no mechanism when this file was restored (the brain has truthfully
//   said /cashout doesn't exist since rev 112); the panel states
//   redemptions are paused, honestly. Masterspend wave (2026-10-22):
//   the payout mechanism now exists — requestXpCashout() below is the
//   engine caller (eligibility + atomic XP claim + engine spend +
//   restore/hold semantics mirroring the original). The panel/button
//   surface wiring is a follow-on wave; the panel copy is unchanged
//   until that wave lands, so nothing here promises what isn't wired.
// - The caller's verified $PBAI holder rows come from pbai_holder_wallets
//   (balance is a raw-units BigInt string, 18 decimals — see
//   lib/pbai-holder-sync.ts; formatted to whole $PBAI for display).
// - /mywatched and /unwatchwallet read/delete the caller's own
//   whale_watch_wallets rows via lib/accounts.js. The table carries no
//   price/threshold columns, so none are shown (never fabricated).
// - Gates: none of the three had a tier gate or owner check in the
//   original or the Discord twins, so none is added. /mywallet keeps the
//   original's DM-only privacy behaviour (house dmRedirect pattern, same
//   as /connect): wallets are personal data and are never posted in a
//   group or shown for anyone but msg.from.id (sealing rule).
//
// V8 isolate rules: imports are sdk + sibling lib modules only.
// No timers, no AbortController, no .catch() on query builders.

import { api } from 'sdk';
import db, { eq, and, gte, sql } from 'sdk/db';
import { pbai_holder_wallets, raid_xp, team_members } from '../schema.js';
import { masterSpend } from './moneyguard.js';
import {
  getUserWallets, listWatched, unwatchWallet,
  checkPbai, setUserWallet, setRhWallet, walletKind,
} from './accounts.js';
import {
  getUserXPRow, getPBRank, raidCompletionCount,
  setRaidWalletAddress, setPbaiHolderFlag,
} from './xp.js';
import { getConfig, setConfig } from './config.js';
import {
  deletePortalChallenge, restoreChatAccess, getPortalChallenge,
  setPortalChallengeStage, getManageSettings, portalModeOf, cleanupNoteSent,
  isOwnerId,
} from './groups.js';

// Source: MAX_WATCHED in telegram-community-bot.ts (~12967); also the cap
// enforced by lib/accounts.js watchWallet.
const MAX_WATCHED = 10;

// House convention: plain-text sendSafe (no MarkdownV2 layer), 4000-char cap.
async function sendSafe(chatId, text, extra = {}) {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22).
  if (sent) await cleanupNoteSent(chatId, sent);
  return sent;
}

function tsOf(v) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : 0;
}

// The caller's active watches in the original's order (created_at ASC).
// Disabled rows (enabled = the M2 app toggle; the tick skips them too)
// are not active watches, so they are not listed or numbered.
async function watchedRows(userId) {
  let rows = [];
  try { rows = await listWatched(userId); } catch { rows = []; }
  return rows
    .filter((r) => r.enabled !== false)
    .sort((a, b) => tsOf(a.createdAt) - tsOf(b.createdAt));
}

// pbai_holder_wallets.balance is a raw-units integer string (18 decimals).
function fmtPbai(raw) {
  try {
    const n = Number(BigInt(String(raw ?? '0'))) / 1e18;
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  } catch { return String(raw ?? '0'); }
}

// ── Text builders (shared by the commands and the skills layer) ─────────────
// Caller-scoped reads only — a builder only ever reads userId's own rows.

/** /mywallet body text for the caller (the command adds its DM redirect). */
export async function myWalletTextFor(userId) {
  let reg = null;
  try { reg = await getUserWallets(userId); } catch { reg = null; }

  let holders = [];
  try {
    holders = await db.select().from(pbai_holder_wallets)
      .where(eq(pbai_holder_wallets.telegramUserId, String(userId))).all();
  } catch { holders = []; }

  const lines = [
    '💳 My Airdrop Wallets',
    '',
    `⬡ Base / EVM: ${reg?.baseAddress || 'not set'}`,
    `◎ Solana (SPL): ${reg?.solAddress || 'not set'}`,
    `🤝 Robinhood Chain: ${reg?.rhAddress || 'not set'}`,
  ];

  if (holders.length) {
    lines.push('', '💎 $PBAI holder wallets (verified):');
    for (const h of holders) {
      lines.push(`${h.baseAddress} — ${fmtPbai(h.balance)} $PBAI`);
    }
  }

  lines.push(
    '',
    "🔥 $PBAI airdrop dropping soon! Make sure your Base wallet is registered or you won't be included.",
    '',
    'Use the buttons below to set or update a wallet right here, or run: /connect <wallet_address>',
    '',
    'Your Base / EVM address can be reused on additional EVM networks when each activates. Robinhood keeps its dedicated field; Solana remains separate. Registration does not guarantee every project airdrop.',
  );

  return lines.join('\n');
}

/** Set/Update buttons for /mywallet (the original's mywallet:set:* row). */
export async function myWalletKeyboardFor(userId) {
  let reg = null;
  try { reg = await getUserWallets(userId); } catch { reg = null; }
  const verb = (v) => (v ? 'Update' : 'Set');
  return {
    inline_keyboard: [
      [{ text: `⬡ ${verb(reg?.baseAddress)} Base Wallet`, callback_data: 'mywallet:set:base' }],
      [{ text: `◎ ${verb(reg?.solAddress)} Solana Wallet`, callback_data: 'mywallet:set:sol' }],
      [{ text: `🤝 ${verb(reg?.rhAddress)} Robinhood Chain Wallet`, callback_data: 'mywallet:set:rh' }],
    ],
  };
}

/** /mywatched body text for the caller. */
export async function myWatchedTextFor(userId) {
  const rows = await watchedRows(userId);
  if (!rows.length) {
    return [
      '🐋 Watched Wallets',
      '',
      'You have no wallets in your watch list.',
      '',
      'Add one with: /watchwallet 0xADDRESS',
    ].join('\n');
  }

  const list = rows.map((r, i) =>
    `${i + 1}. ${r.label || `${String(r.walletAddress).slice(0, 10)}…`}\n${r.walletAddress}`
  ).join('\n\n');

  return `🐋 Watched Wallets (${rows.length}/${MAX_WATCHED})\n\n${list}\n\nRemove: /unwatchwallet 0xADDRESS`;
}

// ─── /mywallet — view the caller's registered receiving wallets ─────────────
// Source: telegram-community-bot.ts ~14302 (Discord twin: handleMyWallet).
async function mywallet(chatId, _args, msg) {
  const userId = msg?.from?.id;
  if (!userId) return;

  // DM-only (source: redirectGroupWizardToDM). House pattern from /connect:
  // announce in the group, continue in the caller's own DM.
  let target = chatId;
  if (msg.chat?.type !== 'private') {
    await sendSafe(chatId, '🔒 Sent to your DM!');
    target = userId;
  }

  await sendSafe(target, await myWalletTextFor(userId), {
    reply_markup: await myWalletKeyboardFor(userId),
  });
}

// ─── /mywatched — list the caller's active whale watches ────────────────────
// Source: telegram-community-bot.ts ~13058 (Discord twin: handleMyWatched).
async function mywatched(chatId, _args, msg) {
  const userId = msg?.from?.id;
  if (!userId) return;

  await sendSafe(chatId, await myWatchedTextFor(userId));
}

// ─── /unwatchwallet — remove one of the caller's watches ────────────────────
// Source: telegram-community-bot.ts ~13037 (Discord twin: /stopwatch).
// Address form is the original's; the list-number form (#N from /mywatched)
// is the port spec's addition and resolves against the same ordering.
async function unwatchwallet(chatId, args, msg) {
  const userId = msg?.from?.id;
  if (!userId) return;

  const arg = (args ?? '').trim().split(/\s+/)[0] ?? '';

  let address = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(arg)) {
    address = arg.toLowerCase();
  } else if (/^\d+$/.test(arg)) {
    const rows = await watchedRows(userId);
    const hit = rows[parseInt(arg, 10) - 1];
    if (!hit) {
      await sendSafe(chatId, "⚠️ That wallet isn't in your watch list.");
      return;
    }
    address = hit.walletAddress;
  } else {
    await sendSafe(chatId, 'Usage: /unwatchwallet 0xADDRESS');
    return;
  }

  let removed = false;
  try { removed = await unwatchWallet(userId, address); } catch { removed = false; }
  if (!removed) {
    await sendSafe(chatId, "⚠️ That wallet isn't in your watch list.");
  } else {
    await sendSafe(chatId, `✅ Stopped watching ${address}.`);
  }
}

// ─── My Wallet update capture (mywallet:set:* — restored) ───────────────────
// Source: telegram-community-bot.ts ~18568 buttons + walletUpdateSessions DM
// consume (~18496). Session: config key, 5-min TTL; invalid input keeps the
// session (the original's behavior); commands always bypass (caller checks).
const MW_CHAINS = {
  base: {
    label: 'Base / EVM', re: /^0x[0-9a-fA-F]{40}$/,
    prompt: '⬡ Send your Base / EVM wallet address now (starts with 0x, 42 characters).',
    err: '❌ Invalid Base address — it must start with 0x and be exactly 42 characters. Send it again, or tap Cancel.',
  },
  sol: {
    label: 'Solana', re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    prompt: '◎ Send your Solana wallet address now (base58, 32–44 characters).',
    err: '❌ Invalid Solana address — it should be 32–44 base58 characters. Send it again, or tap Cancel.',
  },
  rh: {
    label: 'Robinhood Chain', re: /^0x[0-9a-fA-F]{40}$/,
    prompt: '🤝 Send your Robinhood Chain wallet address now (starts with 0x, 42 characters).',
    err: '❌ Invalid Robinhood Chain address — it must start with 0x and be exactly 42 characters. Send it again, or tap Cancel.',
  },
};
const mwCapKey = (userId) => `mywalletcap:${userId}`;

async function loadMwCapture(userId) {
  try {
    const raw = await getConfig(mwCapKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.chain) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}
async function clearMwCapture(userId) {
  await setConfig(mwCapKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}

export async function handleMyWalletCallback(query) {
  const userId = query.from?.id;
  const data = String(query.data ?? '');
  if (!userId) return null;
  if (query.message?.chat?.type !== 'private') {
    return { text: '🔒 Wallets are private — run /mywallet in a DM with me.', alert: true };
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (data.startsWith('mywallet:set:')) {
    const chain = data.slice('mywallet:set:'.length);
    const spec = MW_CHAINS[chain];
    if (!spec) return null;
    await setConfig(mwCapKey(userId), JSON.stringify({ chain, expiresAt: Date.now() + 5 * 60 * 1000 })).catch(() => {});
    await api.editMessageText({
      chat_id: chatId, message_id: messageId,
      text: `${spec.prompt}\n\n⏰ You have 5 minutes.`,
      reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mywallet:cancel:' }]] },
    }).catch(() => {});
    return { text: `Send your ${spec.label} address here.` };
  }
  if (data === 'mywallet:cancel:') {
    await clearMwCapture(userId);
    await api.editMessageText({
      chat_id: chatId, message_id: messageId,
      text: await myWalletTextFor(userId),
      reply_markup: await myWalletKeyboardFor(userId),
    }).catch(() => {});
    return { text: 'Cancelled — no change.' };
  }
  return null;
}

/** DM capture for the My Wallet set/update flow. Returns true when consumed. */
export async function handleMyWalletCapture(chatId, msg) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  const { sess, expired } = await loadMwCapture(userId);
  if (!sess) {
    if (expired) {
      await clearMwCapture(userId);
      await sendSafe(userId, '⏰ That wallet update expired — run /mywallet and tap the button again.');
      return true;
    }
    return false;
  }
  const spec = MW_CHAINS[sess.chain];
  if (!spec) { await clearMwCapture(userId); return true; }
  if (!spec.re.test(text)) {
    await sendSafe(userId, spec.err);
    return true;
  }
  await clearMwCapture(userId);
  if (sess.chain === 'rh') {
    await setRhWallet(userId, text).catch(() => {});
  } else {
    await setUserWallet(userId, text).catch(() => {});
  }
  await sendSafe(userId, `✅ ${spec.label} wallet saved!\n\n${text}`);
  // Re-render the full overview beneath the confirmation.
  await sendSafe(userId, await myWalletTextFor(userId), {
    reply_markup: await myWalletKeyboardFor(userId),
  });
  return true;
}

// ─── /xprewards — XP Rewards status + wallet step (restored) ────────────────
// Source: sendXpRewardsStatus + xprewards:* callbacks in the original, with
// constants from artifacts/api-server/src/lib/xp-cashout.ts (threshold
// 10,000 XP / 10 raids). Status, wallet registration and holder verification
// are restored; the redemption SEND is not — it was a real master-wallet
// payout in the original, and no payout mechanism is created here (money
// movement stays parked behind the arm-flag/signer design). The panel says
// so plainly instead of rendering a cash-out button that can't cash out.
export const XP_CASHOUT_THRESHOLD = 10000;
export const XP_MIN_RAIDS = 10;
const xpCapKey = (userId) => `xpwiz:${userId}`;

async function xpContextChatId() {
  return String(await getConfig('OFFICIAL_XP_CHAT_ID', '-1003931169299'));
}

export async function xpRewardsPanel(userId) {
  const xpChatId = await xpContextChatId();
  const row = await getUserXPRow(userId, xpChatId).catch(() => null);
  const xp = Number(row?.xp ?? 0);
  const rank = getPBRank(xp);
  const wallets = await getUserWallets(userId).catch(() => null);
  const base = wallets?.baseAddress ?? row?.walletAddress ?? null;
  const isHolder = Boolean(row?.pbaiHolder);
  const isDisqualified = Boolean(row?.isDisqualified);
  const raidsDone = await raidCompletionCount(userId, xpChatId).catch(() => 0);
  const pct = Math.min(100, Math.floor((xp / XP_CASHOUT_THRESHOLD) * 100));
  const filled = Math.floor(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const tick = (ok) => (ok ? '✅' : '⬜');
  const eligible = Boolean(base) && isHolder && xp >= XP_CASHOUT_THRESHOLD && raidsDone >= XP_MIN_RAIDS && !isDisqualified;

  const lines = [
    '💰 XP Rewards',
    '',
    `${rank.emoji} Rank: ${rank.name}`,
    `⚡ XP: ${xp.toLocaleString()} / ${XP_CASHOUT_THRESHOLD.toLocaleString()}`,
    `[${bar}] ${pct}%`,
    '',
    'Requirements:',
    `${tick(Boolean(base))} Base wallet registered`,
    `${tick(isHolder)} $PBAI holder verified`,
    `${tick(xp >= XP_CASHOUT_THRESHOLD)} ${XP_CASHOUT_THRESHOLD.toLocaleString()} XP (${xp.toLocaleString()} so far)`,
    `${tick(raidsDone >= XP_MIN_RAIDS)} ${XP_MIN_RAIDS} raids completed (${raidsDone} done)`,
    `${tick(!isDisqualified)} Not disqualified`,
    '',
    eligible
      ? '🎉 Every requirement is green. XP→$PBAI redemptions are paused right now while the payout side is re-armed — your XP is safe and keeps counting, and PB will announce in the community the moment they reopen.'
      : 'Complete every requirement above to qualify. When redemptions reopen, qualifying XP converts 1:1 into $PBAI, sent to your registered Base wallet.',
    '',
    'How to earn XP:',
    '🏆 Completing raids (X 20 · Reddit 15 · Dex/PumpFun/Ape 12 · other links 10 · Web 8)',
    '💬 Chat activity (1–3 XP per message, capped daily)',
    '🔥 Daily streaks (up to +30 bonus XP/day)',
    '📈 Holder ×1.5 and wallet ×1.25 multipliers · 🎉 rank-up milestone bonuses',
  ];
  const kb = [];
  if (!base) kb.push([{ text: '📋 Register Base Wallet', callback_data: 'xprewards:wallet' }]);
  else if (!isHolder) kb.push([{ text: '💎 Verify Holder Status', callback_data: 'xprewards:holder' }]);
  kb.push([{ text: '🔄 Refresh', callback_data: 'xprewards:start' }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function sendXpPanel(userId) {
  const panel = await xpRewardsPanel(userId);
  await sendSafe(userId, panel.text, { reply_markup: panel.reply_markup });
}

// ─── XP cashout — engine caller (masterspend wave, 2026-10-22) ─────────────
// The library half of XP→$PBAI redemption; the panel button that calls
// it is a follow-on surface wave (see the file header). Semantics mirror
// the original xp-cashout.ts: owner excluded; eligibility identical to
// the panel's green state; the XP is claimed ATOMICALLY (conditional
// debit — the update only lands while the balance still covers it)
// BEFORE the spend; a pre-broadcast refusal/failure RESTORES the XP; a
// broadcast-phase failure HOLDS it (ambiguous outcome — the owner
// reconciles from the master_spend_ledger row; nothing auto-retries).
// The spend itself goes through the capped engine (purpose xp_cashout):
// arm flag, kill switch, caps and the owner page all apply.
const XP_CASHOUT_PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e'; // $PBAI on Base (public)

export async function requestXpCashout(userId, deps = {}) {
  const spend = deps.spend ?? masterSpend;
  if (await isOwnerId(userId).catch(() => false)) return { ok: false, reason: 'owner_excluded' };
  const xpChatId = await xpContextChatId();
  const row = await getUserXPRow(userId, xpChatId).catch(() => null);
  const wallets = await getUserWallets(userId).catch(() => null);
  const base = wallets?.baseAddress ?? row?.walletAddress ?? null;
  const xp = Number(row?.xp ?? 0);
  const raidsDone = await raidCompletionCount(userId, xpChatId).catch(() => 0);
  const eligible = Boolean(base) && Boolean(row?.pbaiHolder)
    && xp >= XP_CASHOUT_THRESHOLD && raidsDone >= XP_MIN_RAIDS && !row?.isDisqualified;
  if (!eligible) {
    return {
      ok: false, reason: 'not_eligible',
      xp, raidsDone, hasWallet: Boolean(base), isHolder: Boolean(row?.pbaiHolder),
      isDisqualified: Boolean(row?.isDisqualified),
    };
  }
  const amount = Math.floor(xp);
  const uidNum = Number(userId);
  const chatNum = Number(xpChatId);
  // Atomic claim: conditional debit, verified by re-read.
  await db.update(raid_xp)
    .set({ xp: sql`${raid_xp.xp} - ${amount}`, updatedAt: new Date() })
    .where(and(eq(raid_xp.userId, uidNum), eq(raid_xp.chatId, chatNum), gte(raid_xp.xp, amount)))
    .run().catch(() => {});
  const after = await getUserXPRow(userId, xpChatId).catch(() => null);
  if (!after || Number(after.xp) !== xp - amount) return { ok: false, reason: 'claim_race' };
  const restore = async () => {
    await db.update(raid_xp)
      .set({ xp: sql`${raid_xp.xp} + ${amount}`, updatedAt: new Date() })
      .where(and(eq(raid_xp.userId, uidNum), eq(raid_xp.chatId, chatNum)))
      .run().catch(() => {});
  };
  let res = null;
  try {
    res = await spend({
      purpose: 'xp_cashout', chain: 'base', asset: XP_CASHOUT_PBAI_CA, to: base,
      amountText: String(amount), initiatedBy: String(userId), detail: `xp_cashout xp=${amount}`,
    }, deps.spendDeps ?? {});
  } catch { res = null; }
  if (res?.ok) return { ok: true, txHash: res.txHash, amount, status: res.status };
  if (res && res.phase === 'broadcast') {
    // Ambiguous: the send may have landed. XP stays claimed (held) —
    // the original's rule; the owner reconciles from the ledger row.
    return { ok: false, reason: 'broadcast_ambiguous', detail: res.reason ?? null, held: true, amount };
  }
  await restore();
  return { ok: false, reason: res?.reason ?? 'spend_refused', amount, restored: true };
}

async function xprewards(chatId, _args, msg) {
  const userId = msg?.from?.id;
  if (!userId) return;
  let target = chatId;
  if (msg.chat?.type !== 'private') {
    await sendSafe(chatId, '💰 Opening your XP Rewards in DM!');
    target = userId;
  }
  const panel = await xpRewardsPanel(userId);
  await sendSafe(target, panel.text, { reply_markup: panel.reply_markup });
}

export async function handleXpRewardsCallback(query) {
  const userId = query.from?.id;
  const data = String(query.data ?? '');
  if (!userId) return null;
  const sub = data.slice('xprewards:'.length);

  if (sub === 'start') {
    await sendXpPanel(userId);
    return { text: '🔄 Refreshed.' };
  }
  if (sub === 'cancel') {
    await setConfig(xpCapKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
    await sendSafe(userId, '❌ Wallet registration cancelled.');
    await sendXpPanel(userId);
    return { text: 'Cancelled.' };
  }
  if (sub === 'wallet') {
    await setConfig(xpCapKey(userId), JSON.stringify({ armed: true, expiresAt: Date.now() + 5 * 60 * 1000 })).catch(() => {});
    await sendSafe(userId,
      '💳 Please send your Base wallet address now.\n\nIt must start with 0x and be 42 characters long.', {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'xprewards:cancel' }]] },
      });
    return { text: '📋 Send your Base wallet address here.' };
  }
  if (sub === 'holder') {
    const xpChatId = await xpContextChatId();
    const row = await getUserXPRow(userId, xpChatId).catch(() => null);
    const wallets = await getUserWallets(userId).catch(() => null);
    const wallet = wallets?.baseAddress ?? row?.walletAddress ?? null;
    if (!wallet) return { text: '⚠️ Register your Base wallet first.', alert: true };
    const res = await checkPbai(wallet).catch(() => ({ available: false, balance: 0 }));
    if (!res.available) return { text: '⚠️ Holder check unavailable right now — try again in a minute.', alert: true };
    if (res.balance > 0) {
      await setPbaiHolderFlag(userId, xpChatId, true);
      await sendSafe(userId, `💎 Holder verified! ${wallet.slice(0, 10)}… holds ${res.balance.toLocaleString()} $PBAI.`);
      await sendXpPanel(userId);
      return { text: '💎 Holder status verified!' };
    }
    return { text: `No $PBAI balance found on ${wallet.slice(0, 10)}… — buy $PBAI first, then tap Verify again.`, alert: true };
  }
  return null;
}

/** DM capture for the XP Rewards wallet step. Returns true when consumed. */
export async function handleXpRewardsWalletCapture(chatId, msg) {
  const userId = msg.from?.id;
  const text = String(msg.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  let sess = null;
  try {
    const raw = await getConfig(xpCapKey(userId), null);
    if (raw) sess = JSON.parse(raw);
  } catch { sess = null; }
  if (!sess?.armed) return false;
  if (!sess.expiresAt || Date.now() > sess.expiresAt) {
    await setConfig(xpCapKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
    await sendSafe(userId, '⏰ That wallet prompt expired — open /xprewards and tap Register again.');
    return true;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    await sendSafe(userId, '❌ Invalid address. Base addresses start with 0x and are exactly 42 characters. Please try again.');
    return true;
  }
  await setConfig(xpCapKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
  const address = text.toLowerCase();
  await setUserWallet(userId, address).catch(() => {});
  const xpChatId = await xpContextChatId();
  await setRaidWalletAddress(userId, xpChatId, address, msg.from.first_name ?? null).catch(() => {});
  await sendSafe(userId, `✅ Base wallet saved!\n\n${address}`);
  await sendXpPanel(userId);
  return true;
}

export const WALLET_COMMANDS = { mywallet, mywatched, unwatchwallet, xprewards };

// ── Portal holder path (/manage Phase 2; modes added by Portal polish) ────
// Source: the portal_verify branch of the mng:/portal callback handler
// (telegram-community-bot.ts :24580), the pbai_portal_holder check
// (:24622) and the pendingWalletCapture DM flow (:1926/:6844). The
// original kept the capture state in an in-memory map with a 5-minute
// expiry; here it is a config key (portal_capture:<userId>) so it
// survives across isolates. Registration goes through the live
// setUserWallet — nothing beyond what wallet registration already
// stores is written, and the balance read is the live checkPbai.
// Deviation: the source's post-verify DM also carried an "Access
// Dashboard" URL button pointing at the parked domain; it is dropped —
// the holder button below is the whole flow in the live port.

const portalCaptureKey = (userId) => `portal_capture:${userId}`;

// portal_verify:<chatId>:<userId> — ONLY the challenged member may press.
// Portal polish (2026-10-21) made this mode-aware (portalModeOf):
// - 'human': the tap is the whole check — unlock, no holder DM at all.
// - 'holder' (default, the Phase-2 behavior): the tap unlocks, then PB
//   offers the OPTIONAL holder check in DM (it never gates the unlock).
// - 'both': the tap is step 1 of 2 — it advances the challenge row to
//   stage 'holder' and starts the holder check in DM; the unlock happens
//   in finalizePortalBoth when (and only when) the holder check passes.
//   The challenge expiry covers both steps; the sweep is unchanged.
export async function handlePortalVerifyCallback(query) {
  const parts = (query?.data ?? '').split(':');
  const grpId = parts[1];
  const targetId = Number(parts[2]);
  const clickerId = query?.from?.id;
  if (!grpId || !targetId || !clickerId) return {};
  if (clickerId !== targetId) {
    return { text: '⛔ This button is for the new member only.', alert: true };
  }
  const settings = await getManageSettings(grpId);
  const mode = portalModeOf(settings);

  if (mode === 'both') {
    const row = await getPortalChallenge(grpId, targetId);
    if (!row) {
      return {
        text: '⌛ This verification has expired — rejoin the group to start again.',
        alert: true,
      };
    }
    if (row.stage !== 'holder') {
      await setPortalChallengeStage(grpId, targetId, 'holder');
      // Retire the step-1 button so the group message can't be re-tapped
      // into a second flow; the row (and its expiry) stays live for the
      // sweep. Media challenges carry a caption, text ones a body.
      const doneText = '⏳ Step 1 of 2 done — finishing verification in DMs…';
      const mid = query.message?.message_id;
      if (mid) {
        const edited = query.message?.caption
          ? await api.editMessageCaption({
            chat_id: grpId, message_id: mid, caption: doneText, reply_markup: { inline_keyboard: [] },
          }).then(() => true).catch(() => false)
          : await api.editMessageText({
            chat_id: grpId, message_id: mid, text: doneText, reply_markup: { inline_keyboard: [] },
          }).then(() => true).catch(() => false);
        if (!edited) {
          await api.deleteMessage({ chat_id: grpId, message_id: mid }).catch(() => {});
        }
      }
    }
    await reportPbaiHolder(targetId, grpId);
    return { text: '✅ Step 1 done — step 2 (holder check) is waiting in your DMs.' };
  }

  const ok = await restoreChatAccess(grpId, targetId);
  if (!ok) {
    return {
      text: "⚠️ I couldn't restore your permissions. Please ask a group admin to check that I have the Restrict Members permission.",
      alert: true,
    };
  }
  if (query.message?.message_id) {
    await api.deleteMessage({ chat_id: grpId, message_id: query.message.message_id }).catch(() => {});
  }
  await deletePortalChallenge(grpId, targetId);
  if (mode === 'human') {
    await sendSafe(targetId, [
      "✅ You're in! Welcome to the group 🐳",
      '',
      'Your chat access is unlocked — say hi.',
    ].join('\n'));
    return { text: '✅ Verified! Welcome to the group.' };
  }
  await sendSafe(targetId, [
    "✅ You're in! Welcome to the PoorBoy Army 🐳",
    '',
    'Want PB to check if you hold $PBAI on-chain and unlock your 1.5x holder XP boost? Tap below — takes one second.',
  ].join('\n'), {
    reply_markup: { inline_keyboard: [[
      { text: '🐳 Check My $PBAI Holdings', callback_data: `pbai_portal_holder:${grpId}` },
    ]] },
  });
  return { text: '✅ Verified! Welcome to the group.' };
}

// Portal polish, mode 'both': the holder check passed while a challenge
// row sits at stage 'holder' — complete the verification (restore
// access, clear the challenge, confirm in DM). Called from the holder
// report's success branch only; in every other mode the challenge row
// is already gone by the time a holder check can run, so this is a
// no-op there by construction.
async function finalizePortalBoth(userId, grpId) {
  let row = null;
  try { row = await getPortalChallenge(grpId, userId); } catch { row = null; }
  if (!row || row.stage !== 'holder') return;
  const ok = await restoreChatAccess(grpId, userId);
  if (!ok) {
    await sendSafe(userId,
      "⚠️ Your holder check passed, but I couldn't unlock the group chat. Please ask a group admin to check that I have the Restrict Members permission, then tap Check Again.");
    return;
  }
  if (row.messageId) {
    await api.deleteMessage({ chat_id: grpId, message_id: row.messageId }).catch(() => {});
  }
  await deletePortalChallenge(grpId, userId);
  await sendSafe(userId,
    "🎉 Both steps complete — you're fully verified and the group chat is unlocked. Welcome in! 🐳");
}

// Shared holder report (source: checkPbaiWalletBalances outcomes at
// :24655): reads the caller's registered Base wallet and reports. With
// no Base wallet on file it arms the DM capture and explains both paths.
async function reportPbaiHolder(userId, grpId) {
  const wallets = await getUserWallets(userId);
  const base = wallets?.baseAddress ?? null;
  if (!base) {
    await setConfig(portalCaptureKey(userId), JSON.stringify({
      grpId: String(grpId),
      expires: Math.floor(Date.now() / 1000) + 300,
    }));
    await sendSafe(userId, [
      '💎 No Base wallet linked yet.',
      '',
      "Just send me your Base wallet address right here in this chat and I'll check your $PBAI balance on-chain instantly — no commands needed.",
      '',
      'You can also run /connect <address> any time instead.',
    ].join('\n'));
    return;
  }
  const againKb = { inline_keyboard: [[
    { text: '🔄 Check Again', callback_data: `pbai_portal_holder:${grpId}` },
  ]] };
  const check = await checkPbai(base);
  const short = `${base.slice(0, 6)}…${base.slice(-4)}`;
  if (!check.available) {
    await sendSafe(userId,
      "⚠️ Holder verification is temporarily unavailable (the chain read didn't answer). Tap Check Again in a moment.",
      { reply_markup: againKb });
    return;
  }
  if (check.balance > 0) {
    await sendSafe(userId, [
      '💎 PBAI Holder Verified! 🐳',
      '',
      `Found ${Math.floor(check.balance).toLocaleString('en-US')} $PBAI in ${short}.`,
      '',
      'Your 1.5x XP multiplier is active on raids and missions. Welcome to the army! 🔥',
    ].join('\n'));
    // Portal mode 'both': a passing holder check is step 2 — complete
    // the pending verification if one is waiting on this member.
    await finalizePortalBoth(userId, grpId);
  } else {
      await sendSafe(userId, [
      '🔍 No $PBAI found on-chain.',
      '',
      `Checked ${short} — no $PBAI there yet.`,
      '',
      'Grab some $PBAI (see /ca) and tap Check Again to unlock holder status.',
    ].join('\n'), { reply_markup: againKb });
  }
}

// pbai_portal_holder:<grpId> — the holder-check button on the DM above.
export async function handlePortalHolderCallback(query) {
  const grpId = (query?.data ?? '').split(':')[1];
  const userId = query?.from?.id;
  if (!grpId || !userId) return {};
  await reportPbaiHolder(userId, grpId);
  return { text: '🐳 Checking your $PBAI…' };
}

// DM text interceptor (handlers/message.js): while a portal capture is
// pending (5 minutes), an address-shaped DM is the member's answer.
// Non-address text is NOT consumed — it falls through to normal chat.
export async function handlePortalWalletCapture(chatId, msg) {
  const userId = msg?.from?.id;
  if (!userId) return false;
  if (!walletKind((msg.text ?? '').trim())) return false;
  let pending = null;
  try {
    pending = JSON.parse((await getConfig(portalCaptureKey(userId), '')) || 'null');
  } catch { pending = null; }
  if (!pending) return false;
  if (Number(pending.expires ?? 0) < Math.floor(Date.now() / 1000)) {
    await setConfig(portalCaptureKey(userId), '');
    return false;
  }
  await setConfig(portalCaptureKey(userId), '');
  await setUserWallet(userId, (msg.text ?? '').trim());
  await sendSafe(userId, '✅ Wallet linked! Checking your $PBAI balance…');
  await reportPbaiHolder(userId, pending.grpId);
  return true;
}

// ─── Team member registry (2026-10-27 wave; registry ONLY, no payouts) ─────
// Owner-DM flow, ported from ~/workspace/poorboyai-team-registry-prototype/
// (registry + wizard rules unchanged, minus the prototype's plan/bucket
// functions, which this wave deliberately does NOT port):
//   /teamadd     → proposal, PENDING only (never approved by this step)
//   /teamapprove → ONE pending member → APPROVED, owner + confirm panel
//   /teamremove  → APPROVED/PENDING member → REMOVED, owner + confirm panel
// HARD LIMITS, enforced here and by the harness:
//  - No spend, sweep, payout, plan, or bucket code exists in this section.
//    The only money-adjacent data is the recorded team-bucket share %.
//  - No key material is read, ever. The holding-wallet ADDRESS is read
//    from the TEAM_HOLDING_BASE_ADDRESS config row (never the PK) and
//    only to refuse the holding wallet as a member.
//  - Holding balance never auto-redistributes (nothing here moves it).
//  - Removal stops FUTURE payments only; nothing here claws anything back.
//  - Every entry point (command, text capture, callback button) checks
//    isOwnerId; non-owners get no session, no prompt, no row, no change.
// Sessions live in config keys (teamwiz:<userId>), like the mywallet
// capture above, so they survive across isolates; 15-minute expiry.

const TEAM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TEAM_WIZ_TTL_MS = 15 * 60 * 1000;
const teamWizKey = (userId) => `teamwiz:${userId}`;

export const TEAM_HOLDING_RULE_TEXT =
  'Holding balance does NOT auto-redistribute to new members. '
  + 'Paying out the holding balance is a separate, explicit owner decision.';
export const TEAM_REMOVAL_RULE_TEXT =
  'Removal stops FUTURE payments only. It never claws back money already '
  + 'paid and never redistributes a holding balance.';

export function isBaseEoaAddress(address) {
  if (typeof address !== 'string') return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  if (address.toLowerCase() === TEAM_ZERO_ADDRESS) return false;
  return true;
}

const teamNorm = (address) => String(address).toLowerCase();

async function teamHoldingAddress() {
  try {
    const raw = String(await getConfig('TEAM_HOLDING_BASE_ADDRESS', '') ?? '').trim().toLowerCase();
    return raw || null;
  } catch { return null; }
}

async function teamOwnerGate(chatId, msg) {
  if (!msg?.from || !(await isOwnerId(msg.from.id))) {
    await sendSafe(chatId, '🔒 Owner only.');
    return false;
  }
  return true;
}

async function teamFindByAddress(address) {
  try {
    return await db.select().from(team_members)
      .where(eq(team_members.address, teamNorm(address))).get() ?? null;
  } catch { return null; }
}

async function teamListByStates(states) {
  try {
    const rows = await db.select().from(team_members).all();
    return rows.filter((r) => states.includes(r.state));
  } catch { return []; }
}

export async function teamApprovedShareTotal() {
  const rows = await teamListByStates(['approved']);
  return rows.reduce((sum, r) => sum + (Number(r.sharePct) || 0), 0);
}

function teamValidShare(share) {
  return typeof share === 'number' && Number.isFinite(share) && share > 0 && share <= 100;
}

// --- DB transitions (each re-validates everything; owner-checked) ---------
export async function teamPropose({ callerId, address, sharePct }) {
  if (!(await isOwnerId(callerId))) return { ok: false, error: 'owner_only' };
  if (!isBaseEoaAddress(address)) return { ok: false, error: 'invalid_address' };
  const addr = teamNorm(address);
  const holding = await teamHoldingAddress();
  if (holding && addr === holding) return { ok: false, error: 'holding_address_is_not_a_member' };
  if (!teamValidShare(sharePct)) return { ok: false, error: 'invalid_share' };
  const existing = await teamFindByAddress(addr);
  if (existing && (existing.state === 'pending' || existing.state === 'approved')) {
    return { ok: false, error: 'duplicate_address' };
  }
  const now = new Date();
  try {
    await db.insert(team_members).values({
      address: addr, sharePct, state: 'pending',
      proposerId: String(callerId), proposedAt: now,
      approvedAt: null, approvedBy: null, effectiveFrom: null,
      removedAt: null, removedBy: null, removeReason: null,
      createdAt: now, updatedAt: now,
    }).run();
  } catch { return { ok: false, error: 'db_error' }; }
  return { ok: true, member: await teamFindByAddress(addr) };
}

export async function teamApprove({ callerId, address }) {
  if (!(await isOwnerId(callerId))) return { ok: false, error: 'owner_only' };
  const member = await teamFindByAddress(address);
  if (!member) return { ok: false, error: 'not_found' };
  if (member.state !== 'pending') return { ok: false, error: 'not_pending' };
  const total = await teamApprovedShareTotal();
  if (total + Number(member.sharePct) > 100) return { ok: false, error: 'share_total_exceeds_100' };
  const now = new Date();
  try {
    await db.update(team_members).set({
      state: 'approved', approvedAt: now, approvedBy: String(callerId),
      effectiveFrom: now, updatedAt: now,
    }).where(eq(team_members.id, member.id)).run();
  } catch { return { ok: false, error: 'db_error' }; }
  return { ok: true, member: await teamFindByAddress(address) };
}

export async function teamRemove({ callerId, address, reason = '' }) {
  if (!(await isOwnerId(callerId))) return { ok: false, error: 'owner_only' };
  const member = await teamFindByAddress(address);
  if (!member) return { ok: false, error: 'not_found' };
  if (member.state !== 'approved' && member.state !== 'pending') {
    return { ok: false, error: 'not_removable' };
  }
  const now = new Date();
  try {
    await db.update(team_members).set({
      state: 'removed', removedAt: now, removedBy: String(callerId),
      removeReason: String(reason), updatedAt: now,
    }).where(eq(team_members.id, member.id)).run();
  } catch { return { ok: false, error: 'db_error' }; }
  return { ok: true, member: await teamFindByAddress(address) };
}

// --- Wizard sessions (config-key, mywalletcap shape) -----------------------
async function loadTeamSession(userId) {
  try {
    const raw = await getConfig(teamWizKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.kind || !sess?.step) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

async function saveTeamSession(userId, sess) {
  await setConfig(teamWizKey(userId), JSON.stringify({
    ...sess, expiresAt: Date.now() + TEAM_WIZ_TTL_MS,
  })).catch(() => {});
}

async function clearTeamSession(userId) {
  // Empty string = no session (the mywalletcap pattern). NOT an expired
  // marker: a cancelled session must not make the owner's NEXT unrelated
  // DM look like an expired team session.
  await setConfig(teamWizKey(userId), '').catch(() => {});
}

function teamAddPanel(draft) {
  return [
    'Add team member?',
    `Address: ${draft.address}`,
    `Share: ${draft.sharePct}% of the team bucket`,
    'Status on confirm: PENDING (not approved — approval is a second owner step).',
    TEAM_HOLDING_RULE_TEXT,
    TEAM_REMOVAL_RULE_TEXT,
  ].join('\n');
}

function teamApprovePanel(member) {
  return [
    'Approve team member?',
    `Address: ${member.address}`,
    `Share: ${member.sharePct}% of the team bucket`,
    'Effective from: on approval (now)',
    'This approves ONE member only. No other member changes.',
    TEAM_HOLDING_RULE_TEXT,
    TEAM_REMOVAL_RULE_TEXT,
  ].join('\n');
}

function teamRemovePanel(member) {
  return [
    'Remove team member?',
    `Address: ${member.address}`,
    `Current state: ${member.state}`,
    TEAM_REMOVAL_RULE_TEXT,
    TEAM_HOLDING_RULE_TEXT,
    'Past plan snapshots are unchanged.',
  ].join('\n');
}

function teamConfirmKb(kind) {
  return { inline_keyboard: [[
    { text: '✅ Confirm', callback_data: `team:confirm:${kind}` },
    { text: '❌ Cancel', callback_data: 'team:cancel' },
  ]] };
}

function teamBackKb(kind) {
  return { inline_keyboard: [[
    { text: '✅ Confirm', callback_data: `team:confirm:${kind}` },
    { text: '⬅️ Back', callback_data: `team:back:${kind}` },
    { text: '❌ Cancel', callback_data: 'team:cancel' },
  ]] };
}

function teamMemberLine(m) {
  return `${m.address} — ${m.sharePct}% (${m.state})`;
}

// --- Owner-DM commands ------------------------------------------------------
async function teamadd(chatId, args, msg) {
  if (!(await teamOwnerGate(chatId, msg))) return;
  const userId = msg.from.id;
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const addrArg = parts[0] ?? '';
  const shareArg = parts[1] ?? '';
  if (addrArg) {
    if (!isBaseEoaAddress(addrArg)) {
      await sendSafe(chatId, '❌ That is not a valid Base EOA address. Usage: /teamadd <0x address> [share %]\n\nSend "cancel" to stop.');
      return;
    }
    const addr = teamNorm(addrArg);
    const holding = await teamHoldingAddress();
    if (holding && addr === holding) {
      await sendSafe(chatId, '❌ The holding wallet cannot be a team member. Send a different address.');
      return;
    }
    const existing = await teamFindByAddress(addr);
    if (existing && (existing.state === 'pending' || existing.state === 'approved')) {
      await sendSafe(chatId, '❌ That address is already a pending or approved member. Send a different address.');
      return;
    }
    if (shareArg !== '') {
      const share = Number(shareArg);
      if (!teamValidShare(share)) {
        await sendSafe(chatId, '❌ Share must be a number >0 and ≤100. Usage: /teamadd <0x address> [share %]');
        return;
      }
      if ((await teamApprovedShareTotal()) + share > 100) {
        await sendSafe(chatId, '❌ That share would push approved shares over 100%. Send a smaller share %.');
        return;
      }
      await saveTeamSession(userId, { kind: 'add', step: 'confirm', draft: { address: addr, sharePct: share } });
      await sendSafe(chatId, teamAddPanel({ address: addr, sharePct: share }), { reply_markup: teamBackKb('add') });
      return;
    }
    await saveTeamSession(userId, { kind: 'add', step: 'share', draft: { address: addr, sharePct: null } });
    await sendSafe(chatId, 'Share %? Send a number >0 and ≤100 (team-bucket share), or "back" / "cancel".');
    return;
  }
  await saveTeamSession(userId, { kind: 'add', step: 'address', draft: { address: null, sharePct: null } });
  await sendSafe(chatId, 'Team member address? Send a Base EOA address (0x…40 hex). Send "cancel" to stop.');
}

async function teamapprove(chatId, args, msg) {
  if (!(await teamOwnerGate(chatId, msg))) return;
  const userId = msg.from.id;
  const addrArg = String(args ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? '';
  if (!addrArg) {
    const pending = await teamListByStates(['pending']);
    const lines = pending.slice(0, 30).map(teamMemberLine);
    await sendSafe(chatId, [
      'Usage: /teamapprove <0x address> — approves ONE pending member.',
      '',
      pending.length ? 'Pending members:' : 'No members are pending right now.',
      ...lines,
    ].join('\n'));
    return;
  }
  if (!isBaseEoaAddress(addrArg)) {
    await sendSafe(chatId, '❌ That is not a valid Base EOA address. Usage: /teamapprove <0x address>');
    return;
  }
  const member = await teamFindByAddress(addrArg);
  if (!member) { await sendSafe(chatId, '❌ No team member found for that address.'); return; }
  if (member.state !== 'pending') {
    await sendSafe(chatId, `❌ That member is ${member.state}, not pending — only pending members can be approved.`);
    return;
  }
  await saveTeamSession(userId, { kind: 'approve', step: 'confirm', draft: { address: member.address, sharePct: member.sharePct } });
  await sendSafe(chatId, teamApprovePanel(member), { reply_markup: teamConfirmKb('approve') });
}

async function teamremove(chatId, args, msg) {
  if (!(await teamOwnerGate(chatId, msg))) return;
  const userId = msg.from.id;
  const addrArg = String(args ?? '').trim().split(/\s+/).filter(Boolean)[0] ?? '';
  if (!addrArg) {
    const active = await teamListByStates(['approved', 'pending']);
    const lines = active.slice(0, 30).map(teamMemberLine);
    await sendSafe(chatId, [
      'Usage: /teamremove <0x address> — removes one approved or pending member.',
      '',
      active.length ? 'Approved / pending members:' : 'No approved or pending members right now.',
      ...lines,
    ].join('\n'));
    return;
  }
  if (!isBaseEoaAddress(addrArg)) {
    await sendSafe(chatId, '❌ That is not a valid Base EOA address. Usage: /teamremove <0x address>');
    return;
  }
  const member = await teamFindByAddress(addrArg);
  if (!member) { await sendSafe(chatId, '❌ No team member found for that address.'); return; }
  if (member.state !== 'approved' && member.state !== 'pending') {
    await sendSafe(chatId, `❌ That member is already ${member.state}.`);
    return;
  }
  await saveTeamSession(userId, { kind: 'remove', step: 'confirm', draft: { address: member.address, sharePct: member.sharePct, wasState: member.state } });
  await sendSafe(chatId, teamRemovePanel(member), { reply_markup: teamConfirmKb('remove') });
}

export const TEAM_COMMANDS = { teamadd, teamapprove, teamremove };

// --- DM text capture (handlers/message.js wizCaptures; DM only) -------------
// Returns true when the text was consumed by an armed team session.
export async function handleTeamCapture(chatId, msg) {
  const userId = msg?.from?.id;
  const text = String(msg?.text ?? '').trim();
  if (!userId || !text || text.startsWith('/')) return false;
  if (!(await isOwnerId(userId))) return false;
  const { sess, expired } = await loadTeamSession(userId);
  if (!sess) {
    if (expired) {
      await clearTeamSession(userId);
      await sendSafe(userId, '⏰ That team session expired — run /teamadd, /teamapprove, or /teamremove again.');
      return true;
    }
    return false;
  }
  const lower = text.toLowerCase();
  if (lower === 'cancel') {
    await clearTeamSession(userId);
    await sendSafe(userId, 'Cancelled — nothing was created or changed.');
    return true;
  }
  if (sess.kind === 'add' && sess.step === 'address') {
    if (lower === 'back') {
      await clearTeamSession(userId);
      await sendSafe(userId, 'Cancelled — nothing was created or changed.');
      return true;
    }
    if (!isBaseEoaAddress(text)) {
      await sendSafe(userId, 'That is not a valid Base EOA address. Send a 0x address with 40 hex characters, or "cancel" to stop.');
      return true;
    }
    const addr = teamNorm(text);
    const holding = await teamHoldingAddress();
    if (holding && addr === holding) {
      await sendSafe(userId, 'The holding wallet cannot be a team member. Send a different address, or "cancel" to stop.');
      return true;
    }
    const existing = await teamFindByAddress(addr);
    if (existing && (existing.state === 'pending' || existing.state === 'approved')) {
      await sendSafe(userId, 'That address is already a pending or approved member. Send a different address, or "cancel" to stop.');
      return true;
    }
    await saveTeamSession(userId, { kind: 'add', step: 'share', draft: { address: addr, sharePct: null } });
    await sendSafe(userId, 'Share %? Send a number >0 and ≤100 (team-bucket share), or "back" / "cancel".');
    return true;
  }
  if (sess.kind === 'add' && sess.step === 'share') {
    if (lower === 'back') {
      await saveTeamSession(userId, { kind: 'add', step: 'address', draft: { address: null, sharePct: null } });
      await sendSafe(userId, 'Back to address. Send a Base EOA address, or "cancel" to stop.');
      return true;
    }
    const share = Number(text);
    if (!teamValidShare(share)) {
      await sendSafe(userId, 'Share must be a number >0 and ≤100. Send a new share %, or "back" / "cancel".');
      return true;
    }
    if ((await teamApprovedShareTotal()) + share > 100) {
      await sendSafe(userId, 'That share would push approved shares over 100%. Send a smaller share %, or "back" / "cancel".');
      return true;
    }
    await saveTeamSession(userId, { kind: 'add', step: 'confirm', draft: { address: sess.draft.address, sharePct: share } });
    await sendSafe(userId, teamAddPanel({ address: sess.draft.address, sharePct: share }), { reply_markup: teamBackKb('add') });
    return true;
  }
  // Confirm step (any kind): typed confirm/cancel/back mirror the buttons.
  if (sess.step === 'confirm') {
    if (lower === 'confirm') {
      const outcome = await teamExecuteConfirm(userId, sess);
      await sendSafe(userId, outcome);
      return true;
    }
    if (lower === 'back') {
      if (sess.kind === 'add') {
        await saveTeamSession(userId, { kind: 'add', step: 'share', draft: { address: sess.draft.address, sharePct: null } });
        await sendSafe(userId, 'Back to share. Send a share % (>0 and ≤100), or "cancel" to stop.');
        return true;
      }
      await clearTeamSession(userId);
      await sendSafe(userId, 'Cancelled — nothing was created or changed.');
      return true;
    }
    await sendSafe(userId, 'Tap ✅ Confirm to proceed, or ❌ Cancel to stop without changing anything.');
    return true;
  }
  return false;
}

// Executes a confirm-step session. Returns the outcome text (the caller
// delivers it: DM for typed confirm, panel edit for button confirm).
// The session is cleared first, so a double-confirm cannot double-write.
async function teamExecuteConfirm(userId, sess) {
  await clearTeamSession(userId);
  if (sess.kind === 'add') {
    // Confirm-time re-validation: a duplicate may have appeared since
    // the address step. A failure here creates nothing.
    const res = await teamPropose({ callerId: userId, address: sess.draft.address, sharePct: sess.draft.sharePct });
    if (!res.ok) return `❌ Could not create the proposal (${res.error}). Nothing was created.`;
    return 'Proposal created: PENDING. It is NOT approved yet — use /teamapprove to approve it.';
  }
  if (sess.kind === 'approve') {
    const res = await teamApprove({ callerId: userId, address: sess.draft.address });
    if (!res.ok) return `❌ Could not approve (${res.error}). Nothing changed.`;
    return 'Member APPROVED, one member only. Effective from now.';
  }
  if (sess.kind === 'remove') {
    const res = await teamRemove({ callerId: userId, address: sess.draft.address, reason: 'owner wizard remove' });
    if (!res.ok) return `❌ Could not remove (${res.error}). Nothing changed.`;
    return 'Member REMOVED. Future payments only — nothing was clawed back.';
  }
  return 'Nothing changed.';
}

// --- Inline-button handler (handlers/callback_query.js team: branch) --------
export async function handleTeamCallback(query) {
  const userId = query?.from?.id;
  const data = String(query?.data ?? '');
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;
  if (!userId) return null;
  if (!(await isOwnerId(userId))) {
    return { text: '🔒 Owner only.', alert: true };
  }
  if (query.message?.chat?.type !== 'private') {
    return { text: '🔒 Team registry runs in a DM with me.', alert: true };
  }
  const { sess, expired } = await loadTeamSession(userId);
  if (!sess) {
    return { text: expired ? '⏰ That team session expired — run the command again.' : 'No team session is open.', alert: true };
  }
  const edit = async (text, extra = {}) => {
    await api.editMessageText({ chat_id: chatId, message_id: messageId, text, ...extra }).catch(() => {});
  };
  if (data === 'team:cancel') {
    await clearTeamSession(userId);
    await edit('Cancelled — nothing was created or changed.');
    return { text: 'Cancelled — no change.' };
  }
  // Confirm/back buttons are kind-bound: a stale panel from an earlier
  // step must never drive the current session. Mismatch → stale alert.
  const parts = data.split(':');
  const action = parts[1] ?? '';
  const kind = parts[2] ?? '';
  if ((action === 'confirm' || action === 'back') && sess.kind !== kind) {
    return { text: 'That panel is stale — run the command again.', alert: true };
  }
  if (action === 'back') {
    if (sess.kind !== 'add') {
      await clearTeamSession(userId);
      await edit('Cancelled — nothing was created or changed.');
      return { text: 'Cancelled — no change.' };
    }
    if (sess.step === 'confirm') {
      await saveTeamSession(userId, { kind: 'add', step: 'share', draft: { address: sess.draft.address, sharePct: null } });
      await edit('Back to share. Send a share % (>0 and ≤100), or "cancel" to stop.');
      return { text: 'Back to share.' };
    }
    if (sess.step === 'share') {
      await saveTeamSession(userId, { kind: 'add', step: 'address', draft: { address: null, sharePct: null } });
      await edit('Back to address. Send a Base EOA address, or "cancel" to stop.');
      return { text: 'Back to address.' };
    }
    await clearTeamSession(userId);
    await edit('Cancelled — nothing was created or changed.');
    return { text: 'Cancelled — no change.' };
  }
  if (action === 'confirm') {
    const outcome = await teamExecuteConfirm(userId, sess);
    await edit(outcome);
    return { text: 'Done.' };
  }
  return null;
}
