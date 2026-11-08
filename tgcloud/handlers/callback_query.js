// handlers/callback_query.js — PB's button router on Telegram Serverless.
// Payload = the CallbackQuery; the full Update is on ctx.update.
// Ported from the raid/squad/profile callback handlers in
// artifacts/api-server/src/lib/telegram-community-bot.ts.
// Rule: answer every query promptly (source answers first), unknown prefixes
// are answered silently. Plain-text sends in v1 (no MarkdownV2 layer).

import { api, fetch } from 'sdk';
import db, { eq, sql } from 'sdk/db';
import { maybeTick } from '../lib/tick.js';
import {
  raid_sessions, raid_alert_preferences, raid_xp, bot_users, user_settings, group_members, credit_ledger, price_alerts,
} from '../schema.js';
import {
  effectiveTier, generatePost, POST_HEADERS,
} from '../lib/posts.js';
import { tierAtLeast, aiCommandAllowance, referralBonus, startWeekTrial } from '../lib/tiers.js';
import { fetchTokenByAddress, getUniswapPbaiQuote } from '../lib/market.js';
import { fetchOHLCV, taCard } from '../lib/ta.js';
import { getMyGroupsFor, isOwnerId, handleManageCallback, handleSetRulesCancel, handleShieldCallback, captureCommandError, errorLabelForCallback, handleVoiceLangCallback } from '../lib/groups.js';
import { handleNlcmdCallback, handleNlcmdBroadcastCallback, handleNlcmdDmBroadcastCallback, handleNlcmdAgentEditCallback, handleAgentCallback } from '../lib/nlcmd.js';
import {
  loadBizSettings, saveBizSettings, canUseBusinessBot,
  setBizWizardAwaiting, clearBizWizard, BIZ_WIZ_FIELDS,
} from '../lib/business.js';
import {
  getSession, completionCount, completeRaid, isSessionExpired, expireSession,
  endActiveRaids, buildRaidText, buildRaidKeyboard, buildEndedText,
  buildEndedKeyboard, raidCardMessages, RAID_HOW_TO_TEXT, advanceQueue,
  getQueueItems, clearQueue, detectRaidPlatform, isValidRaidUrl,
  createRaidSession, persistRaidCard, raidThreadExtra, dmRaidAlerts,
  handleRaidButtonCallback, handleRemoteCallback, startRemoteWizard,
  sendRaidCardMessage, readRaidConfirm, saveRaidConfirm, clearRaidConfirm,
  buildRaidConfirmText, buildRaidConfirmKeyboard, RAID_CONFIRM_PRESETS,
  getRaidCommunityInfo,
} from '../lib/raids.js';
import {
  leaderboardByCompletions, getUserXPRow, getPBRank,
  getXpCommunityPolicy, trendingBoard, formatTrendingBoard,
} from '../lib/xp.js';
import { getUserSquad, leaveSquad } from '../lib/squads.js';
import { buildInvitePanel, getReferralStats, botInviteLink } from '../lib/referrals.js';
import { handleContestCallback } from '../lib/contests.js';
import { handleStudioCallback, STUDIO_COMMANDS } from '../lib/studio.js';
import { handlePodcastCallback } from '../lib/studio.js';
import { handleBoostCallback, handleBoosterStopCallback, handleBoosterRetryCallback, startBoostWizardFor } from '../lib/boost.js';
import { handleRelayCallback } from '../lib/relay.js';
import { handleAirdropCallback, startAirdropWizard } from '../lib/airdrop.js';
import { handleCampaignCallback, handleSetupCallback } from '../lib/campaigns.js';
import { handleApplyCallback, handleBuyWizardCallback, startBuyWizard, handlePlanbuyCallback } from '../lib/websync.js';
import { handleOutreachCallback, executeBroadcastToGroups, broadcastReceiptText, createDmBroadcastJob, createDmFollowupJob, runOwnerBlast, setDmBroadcastOptedOut, retireBroadcastGroup } from '../lib/broadcastcmds.js';
import { readBroadcastPreview, takeBroadcastPreview } from '../lib/config.js';
import { handleXSetupCallback, handleSocialsCallback, deletePriceAlert } from '../lib/accounts.js';
import { renderHelpText, renderHelpChunks } from '../lib/catalog.js';
import { startFeedbackWizard, handleFeedbackCallback, handleSalesCallback, handleSiteCallback, armMenuCapture } from '../lib/statscmds.js';
import {
  SKILL_CATALOG, buildSkillsCard, skillKindKeyboard, parseSkillCallback,
  runSkillForDm, armSkillCapture, armSkillKindChoice, awaitSkillTopic,
  loadSkillCapture, clearSkillCapture,
} from '../lib/skills.js';
import { handleGenerateCallback } from '../lib/image.js';
import { handleAnnounceCallback } from '../lib/posts.js';
import { sendVerdictCard } from '../lib/verdict.js';
import { handleVoiceCallback } from '../lib/llm.js';
import {
  handlePortalVerifyCallback, handlePortalHolderCallback,
  handleMyWalletCallback, handleXpRewardsCallback, myWatchedTextFor,
  handleTeamCallback,
} from '../lib/walletcmds.js';

async function answer(id, text = undefined, alert = false) {
  try {
    await api.answerCallbackQuery({
      callback_query_id: id,
      ...(text !== undefined ? { text: String(text).slice(0, 200), show_alert: alert } : {}),
    });
  } catch { /* never break on answer failure */ }
}

async function safeSend(chatId, text, extra = {}) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });
  } catch (err) {
    if (err?.code !== 403) console.error('[cbq send]', err?.code ?? err?.message);
  }
}

// ── Menu-buttons fix (2026-11-05, Rowdy: the /menu card buttons in a group
//    "don't do s***") ────────────────────────────────────────────────────────
// The old menu: block had two diseases: popup-only dead ends (the toast was
// the whole outcome) and DM-delivered branches that answered "Sent to your
// DM!" while safeSend swallowed a closed-DM 403 — the toast lied and the
// group saw nothing. The helpers below make every branch honest:
// · dmSend — a DM send that REPORTS delivery (true = reached the DM,
//   false = refused, usually 403 bot-blocked). Never use safeSend for a
//   DM whose delivery the group pointer claims.
// · groupNote — the one-line group pointer for a DM-delivered branch:
//   tapper named, destination named, NO personal content (never tier,
//   draft, wallet, or review text).
// · dmClosedNote — the fallback when the DM refused: a visible group
//   message that says so, instead of a pointer that lies.
// Every branch answers its callback exactly ONCE (Telegram rejects a
// second answer; the old shill/moonpost catch answered twice).
async function dmSend(userId, text, extra = {}) {
  try {
    await api.sendMessage({ chat_id: userId, text: String(text).slice(0, 4000), ...extra });
    return true;
  } catch (err) {
    if (err?.code !== 403) console.error('[cbq dm]', err?.code ?? err?.message);
    return false;
  }
}

async function groupNote(chatId, from, emoji, action) {
  const name = from?.first_name ?? 'Degen';
  await safeSend(chatId, `${emoji} ${name} — ${action}`);
}

async function dmClosedNote(chatId) {
  await safeSend(chatId, "🔒 I couldn't DM you — open a DM with me first, then tap again.");
}

// Forum topics (raid wave, 2026-10-22): the topic of the message the
// tapped button sits on, as a sendMessage extra — empty outside topics.
function threadOf(query) {
  const t = query?.message?.message_thread_id;
  return t != null && Number(t) > 0 ? { message_thread_id: Number(t) } : {};
}

async function isChatAdmin(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    return ['administrator', 'creator'].includes(m?.status);
  } catch { return false; }
}

async function refreshCard(session, count) {
  const msgs = await raidCardMessages(session.id);
  const text = buildRaidText(session, count);
  // Profile raids (wave 2026-11-01): a refresh must not drop the
  // Vote/Join Community row — resolve the persisted card facts first.
  const info = await getRaidCommunityInfo(session).catch(() => ({ communityUrl: null, isProfileRaid: false }));
  const kb = buildRaidKeyboard(session.id, count, session.targetCount, session.targetUrl, session.isLocked, info.communityUrl, info.isProfileRaid);
  for (const rm of msgs) {
    try {
      // Raid declutter wave: photo cards (Pro banner) edit via caption.
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
    } catch { /* card may be deleted/too old — keep handler alive */ }
  }
}

async function endCard(session, finalCount) {
  const msgs = await raidCardMessages(session.id);
  const text = buildEndedText(session, finalCount, Boolean(session.isShillRaid));
  const kb = buildEndedKeyboard(session.targetUrl);
  for (const rm of msgs) {
    try {
      // Raid declutter wave: photo cards stub via caption (shares row
      // rides on the ended keyboard when the session has a target URL).
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
    } catch { /* keep alive */ }
  }
}

async function handleLeaderboard(chatId, tf = 'ALL') {
  const labels = { '1D': 'Today', '7D': 'Last 7 Days', '30D': 'Last 30 Days', 'ALL': 'All Time' };
  const seconds = { '1D': 86400, '7D': 7 * 86400, '30D': 30 * 86400 };
  const now = Math.floor(Date.now() / 1000);
  const since = tf === 'ALL' ? null : now - (seconds[tf] ?? 0);
  const rows = await leaderboardByCompletions(chatId, 10, since);
  if (!rows.length) {
    return `🏆 Raid XP Leaderboard — ${labels[tf]}\n\nNo raids yet in this timeframe.\n\nLaunch a raid: /raid <url>`;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    const name = r.displayName ?? r.username ?? 'Anon';
    const xpNum = Number(r.xp ?? 0);
    const rank = getPBRank(xpNum);
    return `${medal} ${name} ${rank.emoji} — ${xpNum} XP`;
  });
  return `🏆 Raid XP Leaderboard — ${labels[tf]}\n\n${lines.join('\n')}`;
}

async function handleProfileCard(chatId, userId, displayName) {
  const row = await getUserXPRow(userId, chatId);
  const xp = row?.xp ?? 0;
  const rank = getPBRank(xp);
  const squad = await getUserSquad(userId, chatId);
  return [
    `👤 ${displayName}`,
    `${rank.emoji} ${rank.name} — ${xp.toLocaleString('en-US')} XP`,
    `🔥 Streak: ${row?.streak ?? 0} day${(row?.streak ?? 0) === 1 ? '' : 's'}`,
    squad ? `⚔️ Squad: ${squad.name}` : '⚔️ No squad — join one with /squad',
    '',
    '/lb for the leaderboard · /raidrank for the hall of fame',
  ].join('\n');
}

// ── Broadcast preview execution (fix 1, 2026-10-29) ───────────────────────
// Runs ONLY from the bprev branch above, AFTER the record has been taken
// (deleted). Each case mirrors the pre-fix command's send + receipt text
// exactly; the only difference is that it runs on Confirm instead of at
// command time. Nothing here runs on Cancel.
async function executeBroadcastPreview(record) {
  const origin = record.originChatId;
  const targets = Array.isArray(record.targets) ? record.targets : [];
  switch (record.kind) {
    case 'hype': {
      let sent = 0;
      for (const g of targets) {
        try { await api.sendMessage({ chat_id: g.chatId, text: record.text }); sent++; }
        catch { /* one dead group never stops the blast */ }
      }
      await safeSend(origin, `✅ Hype message sent to ${sent} group${sent === 1 ? '' : 's'}!`);
      return;
    }
    case 'broadcast': {
      const result = await executeBroadcastToGroups(record.text, targets);
      await safeSend(origin, broadcastReceiptText(result));
      return;
    }
    case 'dmbroadcast': {
      const created = await createDmBroadcastJob(record.text, record.userId);
      if (created.error === 'already_running') {
        await safeSend(origin, `⏳ Job #${created.job.id} is already running — one DM broadcast at a time. /dmstop halts it first.`);
        return;
      }
      await safeSend(origin,
        `📨 DM broadcast started — job #${created.job.id} to ${created.total} users.\n` +
        'It sends in batches on PB\'s clock; I\'ll DM you the receipt when it finishes. /dmstop halts it.');
      return;
    }
    case 'dmfollowup': {
      const res = await createDmFollowupJob(record.sourceJobId, record.userId);
      if (res.error === 'already_running') {
        await safeSend(origin, `⏳ Job #${res.job.id} is already running — one DM broadcast at a time. /dmstop halts it first.`);
        return;
      }
      if (res.error === 'source_not_found') {
        await safeSend(origin, '❌ No DM broadcast job exists for that follow-up.');
        return;
      }
      if (res.error === 'nothing_remaining') {
        await safeSend(origin, `✅ Job #${res.source.id} has nobody left unreached — every recipient was already sent or failed. No follow-up needed.`);
        return;
      }
      await safeSend(origin,
        `📨 DM follow-up started — job #${res.job.id} to ${res.total} users (the ones job #${res.source.id} never reached).\n` +
        'It sends in batches on PB\'s clock; I\'ll DM you the receipt when it finishes. /dmstop halts it.');
      return;
    }
    case 'remotesay': {
      const t = targets[0];
      try {
        await api.sendMessage({ chat_id: t.chatId, text: record.text });
        await safeSend(origin, `✅ Message sent to ${t.title}.`);
      } catch {
        await safeSend(origin, '❌ Couldn\'t send — make sure I\'m still an admin there.');
      }
      return;
    }
    case 'remoteshill': {
      const t = targets[0];
      const post = record.text;
      try {
        await api.sendMessage({ chat_id: t.chatId, text: post, disable_web_page_preview: true });
        await safeSend(origin, [
          `✅ Shill post fired to ${t.title}!`,
          '',
          '_Preview:_',
          post.slice(0, 220) + (post.length > 220 ? '…' : ''),
        ].join('\n'));
      } catch (err) {
        const m = String(err?.message ?? '');
        await safeSend(origin, /429|quota|rate.?limit/i.test(m)
          ? '❌ Failed: the AI is rate-limited right now — try again in a few minutes.'
          : '❌ Failed: PB hit a snag doing that — try again.');
      }
      return;
    }
    case 'remoteraid': {
      const t = targets[0];
      const platform = detectRaidPlatform(record.url);
      if (!platform) {
        await safeSend(origin, '❌ That URL can\'t be a raid target — send a link to a post on X, Reddit, etc.');
        return;
      }
      try {
        const session = await createRaidSession({
          chatId: Number(t.chatId), url: record.url, platform,
          targetCount: null, creatorId: record.creatorId,
          creatorName: record.creatorName ?? 'Commander',
        });
        const sent = await api.sendMessage({
          chat_id: t.chatId,
          text: buildRaidText(session, 0) + (record.mission ? `\n\n🎯 Mission: ${record.mission}` : ''),
          reply_markup: buildRaidKeyboard(session.id, 0, session.targetCount, session.targetUrl, false),
          disable_web_page_preview: true,
        });
        await persistRaidCard(session.id, t.chatId, sent.message_id);
        await safeSend(origin, `⚔️ Raid fired in ${t.title}!`);
      } catch (err) {
        await safeSend(origin, `❌ Failed: ${err?.message ?? String(err)}`);
      }
      return;
    }
    case 'pbblast':
    case 'pbnews':
    case 'pbbuynews':
    case 'pbbooster':
    case 'airdropblast': {
      const startText = record.startTextKind === 'booster'
        ? ({ userCount, groupCount }) => `🐾 *Booster Pup Blast starting...*\n👥 Free users: ${userCount}\n🏘️ Groups: ${groupCount}\n\n_Sending the promo through the shared Telegram queue — groups first._`
        : record.startTextKind === 'airdrop'
          ? ({ userCount, groupCount }) => `🪂 *Airdrop Blast starting...*\n🏘️ Groups: ${groupCount}\n👥 Users: ${userCount}`
          : null;
      await runOwnerBlast({
        label: record.label, text: record.text, fromId: record.userId, reportChatId: origin,
        recipientIds: record.recipientIds ?? null, groupExtra: record.groupExtra ?? {},
        startText, groupsOverride: targets,
      });
      return;
    }
    default:
      await safeSend(origin, '❌ Unknown preview kind — nothing was sent.');
      return;
  }
}

async function handleCallbackImpl(query, ctx) {
  const data = query?.data ?? '';
  const from = query.from ?? {};
  const chatId = query.message?.chat?.id;

  // ── Plain-English command layer: confirm-first buttons (owner only) ─────────
  if (data === 'nlcmd:yes' || data === 'nlcmd:no') {
    await answer(query.id);
    if (!(await isOwnerId(from?.id))) return;
    try { await handleNlcmdCallback(query, data === 'nlcmd:yes'); } catch (err) {
      console.error('[nlcmd cb]', err?.message ?? err);
    }
    return;
  }

  // ── Gap-3: ✏️ Edit on the create_agent confirm card (owner only) ─────────
  if (data === 'nlcmd:aedit') {
    await answer(query.id);
    if (!(await isOwnerId(from?.id))) return;
    try { await handleNlcmdAgentEditCallback(query); } catch (err) {
      console.error('[nlcmd aedit cb]', err?.message ?? err);
    }
    return;
  }

  // ── Agent Loop Phase A: outward-step confirm + stop (owner only) ─────────
  if (data === 'agent:go' || data === 'agent:skip' || data === 'agent:stop') {
    await answer(query.id);
    if (!(await isOwnerId(from?.id))) return;
    const action = data === 'agent:go' ? 'go' : (data === 'agent:skip' ? 'skip' : 'stop');
    try { await handleAgentCallback(query, action); } catch (err) {
      console.error('[agentloop cb]', err?.message ?? err);
    }
    return;
  }

  // ── Plain-English broadcast confirm: Send / Edit / Cancel (owner only) ────
  if (data === 'nlcmd:bsend' || data === 'nlcmd:bedit' || data === 'nlcmd:bcancel') {
    await answer(query.id);
    if (!(await isOwnerId(from?.id))) return;
    const action = data === 'nlcmd:bsend' ? 'send' : (data === 'nlcmd:bedit' ? 'edit' : 'cancel');
    try { await handleNlcmdBroadcastCallback(query, action); } catch (err) {
      console.error('[nlcmd bcast cb]', err?.message ?? err);
    }
    return;
  }

  // ── Plain-English DM broadcast confirm: Send / Edit / Cancel (owner only) ──
  if (data === 'nlcmd:dbsend' || data === 'nlcmd:dbedit' || data === 'nlcmd:dbcancel') {
    await answer(query.id);
    if (!(await isOwnerId(from?.id))) return;
    const action = data === 'nlcmd:dbsend' ? 'send' : (data === 'nlcmd:dbedit' ? 'edit' : 'cancel');
    try { await handleNlcmdDmBroadcastCallback(query, action); } catch (err) {
      console.error('[nlcmd dmbcast cb]', err?.message ?? err);
    }
    return;
  }

  // ── Broadcast preview confirm/cancel (fix 1, 2026-10-29) ─────────────────
  // Buttons carry `bprev:yes|no:<userId>:<token>`. Safety order matters:
  // (1) a tap whose token does not match the stored record sends nothing
  // (superseded preview, or a double-tap after the record was taken);
  // (2) a stranger's tap is refused WITHOUT consuming the record, so the
  // requester can still confirm; (3) only then is the record taken
  // (deleted) and the send executed — so one preview fires at most once.
  // Cancel takes the record and sends nothing, anywhere.
  if (data.startsWith('bprev:yes:') || data.startsWith('bprev:no:')) {
    const parts = data.split(':');
    const action = parts[1];
    const ownerId = parts[2] ?? '';
    const token = parts[3] ?? '';
    let record = null;
    try { record = await readBroadcastPreview(ownerId); } catch { record = null; }
    if (!record || record.token !== token) {
      await answer(query.id, 'That preview is no longer active — nothing was sent.', true);
      return;
    }
    if (String(record.userId) !== String(from?.id)) {
      await answer(query.id, 'Only the person who requested this preview can confirm it.', true);
      return;
    }
    await answer(query.id);
    const taken = await takeBroadcastPreview(ownerId);
    if (!taken) {
      await safeSend(record.originChatId, 'That preview was already handled — nothing was sent.');
      return;
    }
    if (action === 'no') {
      await safeSend(record.originChatId, '❌ Cancelled — nothing was sent.');
      return;
    }
    try {
      await executeBroadcastPreview(record);
    } catch (err) {
      console.error('[bprev execute]', err?.message ?? err);
      await safeSend(record.originChatId, '❌ The confirmed send failed before completing — check the receipts for what actually went out.');
    }
    return;
  }

  // ── Gap-2 voice notes: 🔊 Hear it (DM only; the handler answers the
  // query itself, exactly once, after synthesis resolves) ─────────────────
  if (data.startsWith('voice:hear:')) {
    try { await handleVoiceCallback(query, data.slice('voice:hear:'.length)); } catch (err) {
      console.error('[voice cb]', err?.message ?? err);
    }
    return;
  }

  // ── Scan verdict card (Edge wave #2; button attached by /analyze) ─────────
  if (data.startsWith('vcard:')) {
    const address = data.slice('vcard:'.length);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      await answer(query.id, 'Invalid token address.', true);
      return;
    }
    // FREE-TIER RESHAPE (Rowdy 2026-11-05): the verdict card is a scan
    // output — same Starter+ floor as /scan, so a stale pre-push button
    // cannot serve a fresh card to a free user.
    {
      const row = await db.select().from(bot_users)
        .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
      const tier = await effectiveTier(from.id, row);
      if (!tierAtLeast(tier, 'starter')) {
        await answer(query.id, '🌱 Starter+ feature — upgrade with /upgrade.', true);
        return;
      }
    }
    await answer(query.id, 'Building your verdict card…');
    if (chatId) {
      const res = await sendVerdictCard(chatId, address);
      if (!res.sent) await safeSend(chatId, '⚠️ Scan data unavailable for that token right now.');
    }
    return;
  }

  // ── Raid: I Raided! — claim XP (source: raid_done:) ────────────────────────
  if (data.startsWith('raid_done:')) {
    await answer(query.id);
    const sessionId = parseInt(data.split(':')[1] ?? '0', 10);
    const session = await getSession(sessionId);
    if (!session) { await answer(query.id, '⚠️ Raid not found.'); return; }
    if (isSessionExpired(session)) {
      if (session.isActive) await expireSession(sessionId);
      const count = await completionCount(sessionId);
      await endCard(session, count);
      await answer(query.id, session.isActive ? '⏰ This raid has expired.' : '🛑 This raid has ended.');
      return;
    }
    const result = await completeRaid(
      session, from.id, from.username ?? null,
      [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Anon',
    );
    if (result.alreadyRaided) {
      await answer(query.id, '✅ XP already counted!');
      return;
    }
    await refreshCard(session, result.count);
    await answer(query.id, result.toast, false);
    if (result.rankUp) await safeSend(chatId ?? session.chatId, result.rankUp, threadOf(query));
    return;
  }

  // ── Raid: board (source: raid_board:) ─────────────────────────────────────
  if (data.startsWith('raid_board:')) {
    const sessionId = parseInt(data.split(':')[1] ?? '0', 10);
    const top = await db.all(sql`
      SELECT display_name, username, completed_at FROM raid_completions
      WHERE raid_id = ${sessionId} ORDER BY completed_at ASC LIMIT 10
    `).catch(() => []);
    const count = await completionCount(sessionId);
    const medals = ['🥇', '🥈', '🥉'];
    const short = top.slice(0, 3).map((r, i) =>
      `${medals[i] ?? `${i + 1}.`} ${(r.display_name ?? r.username ?? 'Anon').slice(0, 14)}`);
    await answer(query.id, `⚔️ ${count} Raider${count !== 1 ? 's' : ''}\n${short.join('  ')}`, true);
    const lines = top.map((r, i) => {
      const medal = medals[i] ?? `${i + 1}.`;
      const d = r.completed_at ? new Date(Number(r.completed_at) * 1000) : null;
      const when = d ? d.toISOString().slice(11, 16) + ' UTC' : '';
      return `${medal} ${r.display_name ?? r.username ?? 'Anon'} — ${when}`;
    });
    const text = `🏆 Raid Leaderboard\n\n${lines.length ? lines.join('\n') : 'No raiders yet.'}\n\n⚔️ ${count} total raider${count === 1 ? '' : 's'}`;
    if (chatId) await safeSend(chatId, text, threadOf(query));
    return;
  }

  // ── Raid: profile card (source: raid_profile:) ────────────────────────────
  if (data.startsWith('raid_profile:')) {
    await answer(query.id);
    if (!chatId) return;
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Degen';
    await safeSend(chatId, await handleProfileCard(chatId, from.id, name), threadOf(query));
    return;
  }

  // ── Raid: lock/unlock (source: raid_lock:) — creator or admin ──────────────
  if (data.startsWith('raid_lock:')) {
    const sessionId = parseInt(data.split(':')[1] ?? '0', 10);
    const session = await getSession(sessionId);
    if (!session || !session.isActive) { await answer(query.id, '⚠️ Raid not found or already ended.'); return; }
    const isCreator = Number(session.createdBy) === from.id;
    const admin = isCreator || (chatId ? await isChatAdmin(chatId, from.id) : false);
    if (!admin) { await answer(query.id, '⚔️ Only the raid leader or a group admin can lock/unlock the chat.', true); return; }
    const nowLocked = !session.isLocked;
    if (chatId) {
      try {
        await api.setChatPermissions({
          chat_id: chatId,
          ...(nowLocked
            ? { can_send_messages: false }
            : {
                can_send_messages: true, can_send_audios: true, can_send_documents: true,
                can_send_photos: true, can_send_videos: true, can_send_other_messages: true,
                can_add_web_page_previews: true,
              }),
        });
      } catch { /* may lack rights — still record intent */ }
    }
    await db.update(raid_sessions).set({ isLocked: nowLocked })
      .where(eq(raid_sessions.id, sessionId)).run().catch(() => {});
    session.isLocked = nowLocked;
    const count = await completionCount(sessionId);
    await refreshCard(session, count);
    await answer(query.id, nowLocked ? "🔒 Chat locked — raiders can't send messages." : '🔓 Chat unlocked.', true);
    return;
  }

  // ── Raid: stop (source: raid_stop:) — creator or admin.
  // Deviation: single-tap immediate end. The source used a 15s double-tap
  // in-memory confirmation, which cannot work on stateless serverless isolates.
  if (data.startsWith('raid_stop:')) {
    const sessionId = parseInt(data.split(':')[1] ?? '0', 10);
    const session = await getSession(sessionId);
    if (!session || !session.isActive) { await answer(query.id, '🛑 Raid already ended.'); return; }
    const isCreator = Number(session.createdBy) === from.id;
    const admin = isCreator || (chatId ? await isChatAdmin(chatId, from.id) : false);
    if (!admin) { await answer(query.id, '⚔️ Only the raid leader or a group admin can end the raid.', true); return; }
    await expireSession(sessionId);
    const finalCount = await completionCount(sessionId);
    await endCard(session, finalCount);
    await answer(query.id, `🛑 Raid ended! ${finalCount} raider${finalCount !== 1 ? 's' : ''}. GGs!`, true);
    // Auto-advance the queue (source: advanceQueue after end). The next
    // card inherits the ended raid's forum topic (persisted on its
    // session) so it lands in the same topic.
    try {
      await advanceQueue(session.chatId, async (next) => {
        // Raid declutter wave: queue cards go through the same
        // banner-aware send as every other card send.
        const { sent, hasPhoto } = await sendRaidCardMessage(
          session.chatId, next, 0, raidThreadExtra(next));
        if (sent?.message_id) await persistRaidCard(next.id, session.chatId, sent.message_id, hasPhoto);
        await dmRaidAlerts(next).catch(() => {});
      }, session.threadId ?? null);
    } catch { /* non-critical */ }
    return;
  }

  // ── Raid declutter wave (2026-10-31): confirm-card actions ───────────────
  // raidcfm:launch|modify|preset|back|ignore:<12-hex-id>[:preset]. Every
  // step re-verifies server-side: launch/modify/preset/back are group
  // admin only (live isChatAdmin against the PENDING chat, never the
  // client-supplied query chat); ignore is admin OR the original
  // dropper. Forged/stale ids get an alert only — zero writes, no crash.
  if (data.startsWith('raidcfm:')) {
    const parts = data.split(':');
    const action = parts[1] ?? '';
    const id = parts[2] ?? '';
    const pending = await readRaidConfirm(id);
    if (!pending) { await answer(query.id, '⚠️ That raid suggestion expired.', true); return; }
    const raidChatId = Number(pending.chatId);
    const admin = await isChatAdmin(raidChatId, from.id);
    const confirmMsg = query.message;
    const reRender = async (mode) => {
      if (!confirmMsg) return false;
      try {
        await api.editMessageText({
          chat_id: confirmMsg.chat.id, message_id: confirmMsg.message_id,
          text: buildRaidConfirmText(pending, { modify: mode === 'modify' }),
          reply_markup: buildRaidConfirmKeyboard(pending.id, pending, { modify: mode === 'modify' }),
        });
        return true;
      } catch { return false; }
    };
    if (action === 'launch') {
      if (!admin) { await answer(query.id, '⚔️ Only a group admin can launch this raid.', true); return; }
      if (!isValidRaidUrl(pending.url).ok) {
        await clearRaidConfirm(pending);
        await answer(query.id, '⚠️ That raid link is no longer valid.', true);
        return;
      }
      await answer(query.id, '⚔️ Raid launched!');
      const session = await createRaidSession({
        chatId: raidChatId, url: pending.url, platform: detectRaidPlatform(pending.url),
        targetCount: pending.targetCount ?? null,
        creatorId: from.id,
        creatorName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Commander',
        threadId: pending.threadId ?? null,
        metricTargets: pending.metricTargets ?? undefined,
        communityUrl: pending.communityUrl ?? null,
        isProfileRaid: pending.isProfileRaid ?? false,
      });
      const { sent, hasPhoto } = await sendRaidCardMessage(
        raidChatId, session, 0, raidThreadExtra(session));
      if (sent?.message_id) await persistRaidCard(session.id, raidChatId, sent.message_id, hasPhoto);
      await dmRaidAlerts(session).catch(() => {});
      await clearRaidConfirm(pending);
      if (confirmMsg) {
        try {
          await api.editMessageText({
            chat_id: confirmMsg.chat.id, message_id: confirmMsg.message_id,
            text: '✅ Raid launched',
            reply_markup: { inline_keyboard: [] },
          });
        } catch { /* confirm card already gone — the raid itself is live */ }
      }
      return;
    }
    if (action === 'modify') {
      if (!admin) { await answer(query.id, '⚔️ Only a group admin can change raid targets.', true); return; }
      if (!pending.metricTargets) { await answer(query.id, '⚠️ Target presets are only for X raids.', true); return; }
      await answer(query.id);
      await reRender('modify');
      return;
    }
    if (action === 'preset') {
      if (!admin) { await answer(query.id, '⚔️ Only a group admin can change raid targets.', true); return; }
      const preset = parts[3] ?? '';
      if (!RAID_CONFIRM_PRESETS[preset]) { await answer(query.id, '⚠️ Unknown preset.', true); return; }
      pending.metricTargets = { ...RAID_CONFIRM_PRESETS[preset] };
      await saveRaidConfirm(pending);
      await answer(query.id, '✅ Targets updated.');
      await reRender('confirm');
      return;
    }
    if (action === 'back') {
      if (!admin) { await answer(query.id, '⚔️ Only a group admin can change raid targets.', true); return; }
      await answer(query.id);
      await reRender('confirm');
      return;
    }
    if (action === 'ignore') {
      const isDropper = Number(pending.droppedBy) === from.id;
      if (!admin && !isDropper) { await answer(query.id, '⚔️ Only a group admin or the person who dropped the link can ignore this.', true); return; }
      await answer(query.id, 'Suggestion ignored.');
      if (confirmMsg) {
        try { await api.deleteMessage({ chat_id: confirmMsg.chat.id, message_id: confirmMsg.message_id }); } catch { /* already gone */ }
      }
      await clearRaidConfirm(pending);
      return;
    }
    await answer(query.id, '⚠️ That raid suggestion expired.', true);
    return;
  }

  // ── Raid: guide (source: raid_guide) — DM the how-to ───────────────────────
  if (data === 'raid_guide') {
    await answer(query.id, '📖 Raid instructions sent.');
    try {
      await api.sendMessage({
        chat_id: from.id, text: RAID_HOW_TO_TEXT,
        reply_markup: { inline_keyboard: [
          [{ text: '🔔 Get Raid Alerts', callback_data: 'raid_subscribe' }],
        ]},
      });
    } catch { await answer(query.id, '📖 Open a DM with me first, then tap again.'); }
    return;
  }

  // ── Raid: subscribe/unsubscribe (source) ──────────────────────────────────
  if (data === 'raid_subscribe' || data === 'raid_unsubscribe') {
    const sub = data === 'raid_subscribe';
    const existing = await db.select().from(raid_alert_preferences)
      .where(eq(raid_alert_preferences.telegramUserId, from.id)).get().catch(() => null);
    if (sub && existing?.isSubscribed) {
      await answer(query.id, "✅ You're already subscribed! We'll DM you every raid.");
      return;
    }
    await db.insert(raid_alert_preferences).values({
      telegramUserId: from.id, isSubscribed: sub, updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: raid_alert_preferences.telegramUserId,
      set: { isSubscribed: sub, updatedAt: new Date() },
    }).run().catch(() => {});
    if (sub) {
      await answer(query.id, "🔔 Subscribed! You'll get a DM every time a raid goes live.", true);
      try {
        await api.sendMessage({
          chat_id: from.id,
          text: "🔔 Raid Alerts ON!\n\nYou'll receive a DM every time a raid goes live so you never miss XP.\n\nTo unsubscribe, tap the 🔕 Unsubscribe button in any raid alert DM.",
          reply_markup: { inline_keyboard: [[{ text: '🔕 Unsubscribe', callback_data: 'raid_unsubscribe' }]] },
        });
      } catch { /* DM not started */ }
    } else {
      await answer(query.id, "🔕 You've unsubscribed from raid alerts.");
    }
    return;
  }

  // ── Unsubscribe controls (2026-10-30) ───────────────────────────────────
  // DM ads: the tapper opts THEMSELVES out of future PB DM broadcasts.
  // The tapped post is never edited — a buy-keyboard post in a group
  // belongs to every reader, so its buy buttons stay put. The
  // confirmation (with a one-tap resubscribe) goes to the tapper's DM.
  if (data === 'dm_broadcast_unsubscribe' || data === 'dm_broadcast_resubscribe') {
    const resub = data === 'dm_broadcast_resubscribe';
    await setDmBroadcastOptedOut(from.id, !resub).catch(() => {});
    await answer(query.id, resub
      ? "🔔 DM ads back on — you'll get PB broadcasts again."
      : "🔕 Done — you won't get PB DM broadcasts or ads anymore.");
    try {
      await api.sendMessage({
        chat_id: from.id,
        text: resub
          ? "🔔 DM ads are back on. You'll get PB broadcasts and ads in DMs again."
          : "🔕 Done — you won't get PB DM broadcasts or ads anymore.\n\nChanged your mind? Tap below to turn them back on.",
        ...(resub ? {} : { reply_markup: { inline_keyboard: [[
          { text: '🔔 Turn DM ads back on', callback_data: 'dm_broadcast_resubscribe' },
        ]] } }),
      });
    } catch { /* DM not started — the answer above already confirmed */ }
    return;
  }

  // Group stop: ONLY a group admin's tap counts, verified live via
  // getChatMember (the handler's isChatAdmin, same as the raid block's
  // gates). A member tap does nothing at all — no marker, no edit.
  // An admin tap retires the group from future broadcasts (marker +
  // audit row via retireBroadcastGroup; the known_groups row is never
  // deleted) and best-effort removes the stop button from this post.
  // A per-member group unsubscribe is meaningless: Telegram delivers a
  // group post to every member, so there is no per-member delivery to
  // suppress — the admin stop is the honest control.
  if (data === 'group_broadcast_stop') {
    if (!chatId || String(chatId) === String(from.id)) {
      await answer(query.id, '🔕 This button only works on a post in a group — an admin there taps it to stop PB posts in that group.');
      return;
    }
    if (!(await isChatAdmin(chatId, from.id))) {
      await answer(query.id, '🔒 Only a group admin can stop PB posts here.');
      return;
    }
    const title = query.message?.chat?.title ?? '';
    await retireBroadcastGroup({ chatId, title, error: 'admin_stop', code: null }).catch(() => {});
    await answer(query.id, '🔕 PB posts stopped here — this group will no longer get PB broadcasts.', true);
    try {
      if (query.message) {
        await api.editMessageReplyMarkup({
          chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] },
        });
      }
    } catch { /* old message / markup already gone — the marker is the truth */ }
    return;
  }

  // ── Squad: leave (source: squad:leave) ────────────────────────────────────
  if (data === 'squad:leave') {
    await answer(query.id);
    const res = await leaveSquad(chatId ?? 0, from.id);
    if (query.message && chatId) {
      try {
        await api.editMessageText({
          chat_id: chatId, message_id: query.message.message_id,
          text: res.ok
            ? "👋 You've left your squad. Use /squad join <name> to enlist in another."
            : "⚠️ You're not in a squad. Use /squad create or /squad join.",
        });
      } catch { /* message gone */ }
    }
    return;
  }

  // ── All-time leaderboard (source: lb:ALL) ─────────────────────────────────
  if (data === 'lb:ALL') {
    await answer(query.id);
    if (chatId) await safeSend(chatId, await handleLeaderboard(chatId, 'ALL'));
    return;
  }

  // ── Wizard buttons (source: /raid wizard inline buttons) ─────────────────
  // Wizard-restore wave (2026-10-21): these buttons now run the real flows.
  // lib/raids.js walks the tapper in DM (5-min capture) and fires the raid
  // into THIS group through the same cores the one-shot commands use;
  // gates mirror the commands (live: none; shill/remote: Builder+).
  if (data === 'raid:live' || data === 'raid:shill' || data === 'raidwiz:cancel') {
    const res = await handleRaidButtonCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Raid error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data === 'raid:lb') {
    await answer(query.id);
    if (chatId) await safeSend(chatId, await handleLeaderboard(chatId, 'ALL'));
    return;
  }
  if (data === 'raid:remote') {
    await startRemoteWizard(from.id, 'raid').catch(() => {});
    await answer(query.id, '🎮 Remote wizard — check your DMs.');
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('rwiz:')) {
    const res = await handleRemoteCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Remote error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // ── Feedback + reviews (2026-11-05) ───────────────────────────────────────
  if (data.startsWith('fb:')) {
    await answer(query.id);
    await handleFeedbackCallback({ data, from, chatId }).catch((err) => console.error('[fb]', err?.message ?? err));
    maybeTick().catch(() => {});
    return;
  }

  // ── Inbound sales leg (2026-11-05) ────────────────────────────────────────
  // Qualify picks, Confirm / "I paid", Cancel, and the owner pend taps.
  // Owner taps re-check isOwnerId on every press inside the handler.
  if (data.startsWith('sales:')) {
    await answer(query.id);
    await handleSalesCallback({ data, from, chatId }).catch((err) => console.error('[sales]', err?.message ?? err));
    maybeTick().catch(() => {});
    return;
  }

  // ── Website builder v1 (2026-11-05) ───────────────────────────────────────
  // Template / accent picks, Publish, Cancel. Owner-only inside the wizard.
  if (data.startsWith('site:')) {
    await answer(query.id);
    await handleSiteCallback({ data, from, chatId }).catch((err) => console.error('[site]', err?.message ?? err));
    maybeTick().catch(() => {});
    return;
  }

  // ── Queue view / clear (source: /queue buttons) ────────────────────────────
  if (data === 'queue:view') {
    await answer(query.id);
    if (!chatId) return;
    const items = await getQueueItems(chatId);
    if (!items.length) {
      await safeSend(chatId, '📋 Raid Queue\n\nQueue is empty.\n\nAdd raids with: /raidnext <url> [target]');
      return;
    }
    const lines = items.map((it, i) => {
      const p = detectRaidPlatform(it.targetUrl);
      const target = it.targetCount ? ` (target: ${it.targetCount})` : '';
      const url = String(it.targetUrl);
      return `${i + 1}. ${p.emoji} ${p.name}${target}\n   ${url.slice(0, 50)}${url.length > 50 ? '...' : ''}`;
    });
    await safeSend(chatId, `📋 Raid Queue — ${items.length} queued\n\n${lines.join('\n\n')}\n\nRaids start automatically when the current one ends.`, {
      reply_markup: { inline_keyboard: [[
        { text: '🗑️ Clear Entire Queue', callback_data: 'queue:clearall' },
      ]]},
    });
    return;
  }
  if (data === 'queue:clearall') {
    if (!chatId || !(await isChatAdmin(chatId, from.id))) {
      await answer(query.id, '⛔ Only group admins can clear the queue.', true);
      return;
    }
    await clearQueue(chatId);
    await answer(query.id, '🗑️ Queue cleared.');
    return;
  }

  // ── /kill confirm (TTF steal, 2026-11-01) ─────────────────────────────
  // Confirm card sent by handlers/message.js /kill. Ownership is NOT
  // trusted from the button alone: deletePriceAlert re-checks the row's
  // telegramUserId against the tapper, so tapping someone else's
  // confirm button deletes nothing (false → plain refusal below).
  if (data.startsWith('kill:')) {
    await answer(query.id);
    const parts = String(data).split(':');
    const id = Number(parts[2]);
    const msgId = query?.message?.message_id;
    const editOrSend = async (text) => {
      if (msgId && chatId) {
        try {
          await api.editMessageText({ chat_id: chatId, message_id: Number(msgId), text });
          return;
        } catch { /* fall through to a fresh send */ }
      }
      await safeSend(chatId ?? from.id, text);
    };
    if (!Number.isInteger(id) || (parts[1] !== 'yes' && parts[1] !== 'no')) {
      await editOrSend('❌ That delete link is no longer valid — nothing deleted. List your alerts with /alert.');
      return;
    }
    if (parts[1] === 'no') {
      await editOrSend('❌ Cancelled — nothing deleted.');
      return;
    }
    const row = await db.select().from(price_alerts)
      .where(eq(price_alerts.id, id)).get().catch(() => null);
    const ok = await deletePriceAlert(id, from.id);
    if (!ok) {
      await editOrSend('❌ That alert is already gone or isn\u2019t yours — nothing deleted.');
      return;
    }
    const label = row
      ? `${row.tokenName ?? String(row.tokenAddress ?? '').slice(0, 10)} ${row.direction === 'above' ? '↑' : '↓'} $${row.targetPrice}`
      : 'your price alert';
    await editOrSend(`🗑️ Alert deleted: ${label}`);
    return;
  }

  // ── PB Research suite doors (packaging wave, 2026-10-22) ───────────────
  // Every button on the /research card lands on a real tool: the live
  // Trending board, the /scan usage door, the Scam Radar surfaces, the
  // per-group Buy Bot setup path, and the caller's own whale watches.
  if (data.startsWith('research:')) {
    const sub = data.slice('research:'.length);
    if (sub === 'trending') {
      await answer(query.id);
      const board = await trendingBoard(10);
      await safeSend(chatId ?? from.id, formatTrendingBoard(board));
      return;
    }
    if (sub === 'scan') {
      // Menu-buttons fix (2026-11-05): same scan capture as menu:pb_scan
      // — the button arms it, the tapper's next message in this chat is
      // the contract. The old popup-only answer was the whole outcome.
      // FREE-TIER RESHAPE (Rowdy 2026-11-05): scans leave Free — same
      // Starter+ floor as /scan.
      {
        const row = await db.select().from(bot_users)
          .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
        const tier = await effectiveTier(from.id, row);
        if (!tierAtLeast(tier, 'starter')) {
          await answer(query.id, '🌱 Starter+ feature — upgrade with /upgrade.', true);
          return;
        }
      }
      await answer(query.id);
      await armMenuCapture(from.id, 'scan', chatId ?? from.id);
      await safeSend(chatId ?? from.id, '🔍 Paste the contract address to scan (Base 0x…) — your next message here is the contract.');
      return;
    }
    if (sub === 'scam') {
      await answer(query.id);
      await safeSend(chatId ?? from.id, [
        '🛡️ Scam Radar — free risk screening, no account needed.',
        '',
        'Paste a contract, a wallet address, a Telegram handle or an X name and get a scam-risk verdict.',
        '',
        '📱 In the PB App: More → 🔍 Research → Scam Radar',
        '🌐 On the web: poorboyai.pages.dev/scam-radar',
        '💬 Right here: /scan <CA> runs the contract check in this chat.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[
          { text: '🛡️ Open Scam Radar', url: 'https://poorboyai.pages.dev/scam-radar' },
        ]] },
      });
      return;
    }
    if (sub === 'buyalerts') {
      const isGroup = chatId !== null && chatId !== undefined && Number(chatId) !== Number(from.id);
      if (isGroup) {
        await answer(query.id, '💸 Buy alerts are set per group — admins: /manage → Buy Bot (token, min buy, whale bar).', true);
        return;
      }
      await answer(query.id);
      await safeSend(from.id, [
        '💸 Buy alerts live in your groups — the Buy Bot posts every tracked buy the moment it lands, with whale badges and hourly cards.',
        '',
        'Set yours up from the group manager: pick your group, then the token, minimum buy and whale bar.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[
          { text: '🎛️ Open the group manager', url: 'https://t.me/PoorBoyAI_bot?start=manage' },
        ]] },
      });
      return;
    }
    if (sub === 'whales') {
      await answer(query.id);
      await safeSend(chatId ?? from.id, await myWatchedTextFor(from.id));
      return;
    }
    await answer(query.id);
    return;
  }

  // ── Wave 4: menu / settings / biz / airdrop / xsetup / army buttons ──────

  // Tier labels — same map as handlers/message.js TIER_LABELS (kept in
  // sync by hand; the /mytier command itself is deliberately NOT
  // refactored by this wave so an OK path never regresses).
  const MENU_TIER_LABELS = {
    free: '🆓 Free', starter: '🌱 Starter', builder: '💼 Builder', pro: '⚡ Pro',
    agency: '🏢 Agency', hustler: '💼 Builder', grinder: '⚡ Pro', chad: '🏢 Agency',
    whale: '🏢 Agency', dev_launch: '🚀 Dev Launch', poor: '🆓 Free',
    one: '⭐ PB Plan', trial: '🎁 Trial',
  };

  /** Full /mytier breakdown for the menu button (tier + usage numbers). */
  async function mytierBreakdownText(from, row) {
    const tier = await effectiveTier(from.id, row);
    const label = MENU_TIER_LABELS[tier] ?? `⭐ ${tier}`;
    const expires = row?.subscriptionExpiresAt
      ? (row.subscriptionExpiresAt instanceof Date ? row.subscriptionExpiresAt : new Date(row.subscriptionExpiresAt))
      : null;
    let credits = 0;
    try {
      const rows = await db.select().from(credit_ledger)
        .where(eq(credit_ledger.userKey, `telegram:${from.id}`)).all();
      credits = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    } catch { /* ignore */ }
    const allowance = await aiCommandAllowance(tier, from.id).catch(() => null);
    const refInfo = allowance ? await referralBonus(from.id).catch(() => null) : null;
    return [
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
    ].join('\n');
  }

  // Main menu buttons (emitted by /menu; copy mirrors sendMainMenu in source).
  if (data.startsWith('menu:')) {
    const sub = data.slice(5);
    if (sub === 'pb_shill' || sub === 'pb_moonpost') {
      const kind = sub === 'pb_shill' ? 'shillraid' : 'moonpost';
      const row = await db.select().from(bot_users)
        .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
      const tier = await effectiveTier(from.id, row);
      if (!tierAtLeast(tier, 'starter')) {
        await answer(query.id, '🌱 Starter+ feature — upgrade with /upgrade.', true);
        return;
      }
      // Menu-buttons fix (2026-11-05): ONE answer, ever — the old catch
      // answered a second time (Telegram rejects it; the tapper saw only
      // a spinner). The interim line lands first so a slow generate never
      // looks dead, and a failure posts a visible group error.
      await answer(query.id);
      const interim = sub === 'pb_shill' ? '🤖 Writing your shill post…' : '🌙 Writing your moon post…';
      await safeSend(chatId ?? from.id, interim);
      try {
        const post = await generatePost(kind, '$PBAI');
        await safeSend(chatId ?? from.id, `${POST_HEADERS[kind]('$PBAI')}\n\n${post}`);
      } catch (err) {
        console.error('[menu-post]', err?.message ?? err);
        await safeSend(chatId ?? from.id, '❌ Could not write that right now — try again in a moment.');
      }
      return;
    }
    if (sub === 'pb_raid') {
      // Wizard-fix wave: opens the real remote raid wizard (DM group
      // picker → URL input → raid fires) instead of a popup instruction.
      // Menu-buttons fix (2026-11-05): the group gets a one-line pointer
      // (tapper + destination, no content) and a visible error if the
      // wizard could not start — the old answer-only toast left the
      // group guessing whether anything happened.
      try {
        const ok = await startRemoteWizard(from.id, 'raid');
        if (ok) {
          await answer(query.id, '⚔️ Pick the target group in your DM.');
          await groupNote(chatId, from, '⚔️', 'pick the target group in your DM.');
        } else {
          await answer(query.id, '❌ The raid wizard did not open — check your DM for why.', true);
          await safeSend(chatId ?? from.id, '❌ The raid wizard did not open — check your DM for the reason, or try again in a moment.');
        }
      } catch (err) {
        console.error('[menu-raid]', err?.message ?? err);
        await answer(query.id, '❌ The raid wizard did not open.', true);
        await safeSend(chatId ?? from.id, '❌ The raid wizard did not open — try again in a moment.');
      }
      return;
    }
    if (sub === 'pb_ta') {
      // Wizard-fix wave: bare /ta needs no argument (defaults to $PBAI),
      // so this button runs the analysis instead of instructing. Body
      // mirrors the /ta command (same fallbacks, same failure copies).
      // FREE-TIER RESHAPE (Rowdy 2026-11-05): TA leaves Free — same
      // Starter+ floor as the /ta command.
      {
        const row = await db.select().from(bot_users)
          .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
        const tier = await effectiveTier(from.id, row);
        if (!tierAtLeast(tier, 'starter')) {
          await answer(query.id, '🌱 Starter+ feature — upgrade with /upgrade.', true);
          return;
        }
      }
      await answer(query.id);
      const PBAI = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
      await api.sendChatAction({ chat_id: chatId ?? from.id, action: 'typing' }).catch(() => {});
      try {
        const token = await fetchTokenByAddress(PBAI);
        if (!token?.poolId) { await safeSend(chatId ?? from.id, '❌ No trading pool found for that token — it may be too new or have no liquidity yet. A contract address with an active pool works best.'); return; }
        const poolAddr = String(token.poolId).split('_').pop();
        const candles = await fetchOHLCV(poolAddr, fetch, 'base', 'hour', 100);
        if (candles.length < 15) { await safeSend(chatId ?? from.id, '📊 Not enough candle history for TA on this pair yet.'); return; }
        await safeSend(chatId ?? from.id, taCard(token.name, token.symbol, candles));
      } catch (err) {
        console.error('[ta]', err?.message ?? err);
        await safeSend(chatId ?? from.id, '📊 Could not build TA right now. Try again shortly.');
      }
      return;
    }
    if (sub === 'pb_scan') {
      // Menu-buttons fix (2026-11-05): the old popup-only answer was the
      // whole outcome. Now the button arms a one-shot capture — the
      // tapper's next message in this chat is the contract, validated
      // against the existing 0x+40hex regex, then the existing scanTextFor
      // + verdict card post to the group. No new scan engine.
      // FREE-TIER RESHAPE (Rowdy 2026-11-05): scans leave Free — same
      // Starter+ floor as /scan (the capture itself is also gated inside
      // handleScan, so a stale arm can never serve a scan).
      {
        const row = await db.select().from(bot_users)
          .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
        const tier = await effectiveTier(from.id, row);
        if (!tierAtLeast(tier, 'starter')) {
          await answer(query.id, '🌱 Starter+ feature — upgrade with /upgrade.', true);
          return;
        }
      }
      await answer(query.id);
      await armMenuCapture(from.id, 'scan', chatId ?? from.id);
      await safeSend(chatId ?? from.id, '🔍 Paste the contract address to scan (Base 0x…) — your next message here is the contract.');
      return;
    }
    if (sub === 'pb_remoteshill') {
      // Wizard-fix wave: opens the real remote wizard (DM group picker →
      // action picker → Shill tap fires) instead of a popup instruction.
      // No blind send to #1: the user picks the group and taps Shill.
      // Menu-buttons fix (2026-11-05): group pointer + visible error,
      // same as pb_raid.
      try {
        const ok = await startRemoteWizard(from.id);
        if (ok) {
          await answer(query.id, '🚀 Pick the group in your DM.');
          await groupNote(chatId, from, '🚀', 'pick the group in your DM.');
        } else {
          await answer(query.id, '❌ The remote wizard did not open — check your DM for why.', true);
          await safeSend(chatId ?? from.id, '❌ The remote wizard did not open — check your DM for the reason, or try again in a moment.');
        }
      } catch (err) {
        console.error('[menu-remoteshill]', err?.message ?? err);
        await answer(query.id, '❌ The remote wizard did not open.', true);
        await safeSend(chatId ?? from.id, '❌ The remote wizard did not open — try again in a moment.');
      }
      return;
    }
    if (sub === 'pb_mygroups') {
      await answer(query.id);
      const groups = await getMyGroupsFor(from.id);
      if (!groups.length) {
        await safeSend(chatId ?? from.id, '📋 No groups linked yet — add me to your group as admin, then check /mygroups.');
      } else {
        const list = groups.map((g, i) => `${i + 1}. ${g.title}`).join('\n');
        await safeSend(chatId ?? from.id, `📋 Your Groups (${groups.length})\n\n${list}\n\nRemote: /remoteshill #1 · /remoteraid #1 <url> · /remotesay #1 <msg>`);
      }
      return;
    }
    if (sub === 'pb_image') {
      // Menu-buttons fix (2026-11-05): the old popup-only answer was the
      // whole outcome. Now the Starter+ gate runs first (same floor as
      // /generate), then the button arms a prompt capture — the tapper's
      // next message in this chat is the prompt, then the existing
      // armGenerateStylePick + gen: style picker run in the same chat.
      // No new image engine.
      const row = await db.select().from(bot_users)
        .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
      const tier = await effectiveTier(from.id, row);
      if (!tierAtLeast(tier, 'starter')) {
        // Same gate copy as tierGate in handlers/message.js (the /generate
        // floor) — a toast alone hides the upgrade path.
        await answer(query.id);
        await safeSend(chatId ?? from.id, '⛔ Starter+ Required\n\n/generate is available on Starter+ plans and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.');
        return;
      }
      await answer(query.id);
      await armMenuCapture(from.id, 'generate', chatId ?? from.id);
      await safeSend(chatId ?? from.id, '🖼️ What should I generate? Send the prompt as your next message here.');
      return;
    }
    if (sub === 'mytier') {
      // Wizard-fix wave: full /mytier breakdown (tier + usage), DM'd
      // when tapped in a group — never post a member's tier to the group.
      // Menu-buttons fix (2026-11-05): the DM send now reports delivery
      // (dmSend) — the old safeSend swallowed a closed-DM 403 while the
      // toast claimed "Sent to your DM!". Closed DM → a visible group
      // fallback note, never a pointer that lies.
      const row = await db.select().from(bot_users)
        .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
      const text = await mytierBreakdownText(from, row);
      const isGroup = chatId !== null && chatId !== undefined && Number(chatId) !== Number(from.id);
      if (isGroup) {
        const delivered = await dmSend(from.id, text);
        if (delivered) {
          await answer(query.id, '🔒 Sent to your DM!');
          await groupNote(chatId, from, '⭐', 'your tier breakdown is in your DM.');
        } else {
          await answer(query.id, "🔒 I couldn't DM you — open a DM with me first.", true);
          await dmClosedNote(chatId);
        }
      } else {
        await answer(query.id);
        await safeSend(chatId ?? from.id, text);
      }
      return;
    }
    if (sub === 'invite') {
      // Referral notifications ("See My Stats") land here — the same panel
      // /invite renders, scoped to this chat (a group's board in a group).
      await answer(query.id);
      const isGroup = chatId !== null && chatId !== undefined && Number(chatId) !== Number(from.id);
      const { text, keyboard } = await buildInvitePanel(from.id, isGroup ? Number(chatId) : null, from);
      await safeSend(chatId ?? from.id, text, { reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true });
      return;
    }
    if (sub === 'boost') {
      // Menu-buttons fix (2026-11-05): the old popup-only rollout notice
      // was the whole outcome. Now the button opens the real boost wizard
      // — startBoostWizardFor DMs the mode panel directly (no dmOnly gate
      // to trip over in a group). Quote → deposit → arm gates run later,
      // inside the wizard. Closed DM → a visible group fallback note.
      const delivered = await startBoostWizardFor(from.id);
      if (delivered) {
        await answer(query.id, '⚡ Pick the boost type in your DM.');
        await groupNote(chatId, from, '⚡', 'pick the boost type in your DM.');
      } else {
        await answer(query.id, "🔒 I couldn't DM you — open a DM with me first.", true);
        await dmClosedNote(chatId);
      }
      return;
    }
    if (sub === 'pb_videoad') {
      // Menu-buttons fix (2026-11-05): the old popup-only notice was the
      // whole outcome. Now the button routes to the existing /create flow
      // (studio.js), which already DMs the intro + posts a group note.
      // Approve stays blocked for photo/link ads until the cost number is
      // set (Rowdy's separate call — this wave does NOT set it).
      await answer(query.id);
      await STUDIO_COMMANDS.create(chatId ?? from.id, '', { chat: { id: chatId ?? from.id, type: chatId != null && Number(chatId) !== Number(from.id) ? 'supergroup' : 'private' }, from });
      return;
    }
    if (sub === 'review' || sub === 'feedback') {
      // Feedback/review buttons (2026-11-05): DM-only wizard. In a group,
      // the picker lands in the tapper's DM — never post a member's
      // review draft to the group.
      // Menu-buttons fix (2026-11-05): the DM send now reports delivery
      // (dmSend) — the old safeSend swallowed a closed-DM 403 while the
      // toast claimed "Sent to your DM!". Closed DM → a visible group
      // fallback note, never a pointer that lies.
      const isGroup = chatId !== null && chatId !== undefined && Number(chatId) !== Number(from.id);
      const res = await startFeedbackWizard(from.id, sub);
      if (!res.ok) { await answer(query.id, res.text, true); return; }
      if (isGroup) {
        const delivered = await dmSend(from.id, res.text, { reply_markup: res.reply_markup });
        if (delivered) {
          await answer(query.id, '💬 Sent to your DM!');
          await groupNote(chatId, from, sub === 'review' ? '⭐' : '💬', sub === 'review' ? 'your review is waiting in your DM.' : 'your feedback is waiting in your DM.');
        } else {
          await answer(query.id, "🔒 I couldn't DM you — open a DM with me first.", true);
          await dmClosedNote(chatId);
        }
      } else {
        await answer(query.id);
        await safeSend(chatId ?? from.id, res.text, { reply_markup: res.reply_markup });
      }
      return;
    }
    if (sub === 'commands') {
      await answer(query.id);
      // Wizard-fix wave: same live catalog render as /help (was a
      // hand-typed subset with the same frozen-catalog blind spot).
      // FIX 6 (2026-10-29): same 4000-slice truncation as /help —
      // send the chunked render, in order.
      for (const chunk of renderHelpChunks()) await safeSend(chatId ?? from.id, chunk);
      return;
    }
    if (sub === 'subscribe') {
      await answer(query.id);
      await safeSend(chatId ?? from.id,
        '💳 Subscribe\n\n⭐ PB Plan — $29/mo or $290/yr (2 months free)\n\nOne price, everything unlocked: all commands, Studio access, campaigns, Developer API + Hosted MCP, Ad Creator included.\n\n🎁 New here? Start with 7 days free — 100 trial credits, standard renders, one per account.\n\n🌐 Subscribe with /upgrade in this chat',
        { reply_markup: { inline_keyboard: [[{ text: '🎁 Start 7-day free trial', callback_data: 'menu:trial:start' }], [{ text: '🛒 Buy with PB', callback_data: 'menu:wizbuy' }], [{ text: '💳 Buy PB Plan in chat', callback_data: 'menu:planbuy' }]] } });
      return;
    }
    if (sub === 'wizbuy') {
      // Wizard-fix wave: the funnel exit — opens the buy wizard in the
      // tapper's DM (startBuyWizard enforces the wizbuy gate itself).
      // Menu-buttons fix (2026-11-05): the group gets a one-line pointer
      // — and the pointer is honest. startBuyWizard's default send
      // swallows a closed-DM 403, so this branch passes a reporting send
      // (same (userId, text, buttons) shape as wizSend) and only claims
      // the DM when the send actually landed. Gated → the gate copy in
      // the group instead of a pointer.
      let delivered = false;
      const reportingSend = async (uid, text, buttons = null) => {
        delivered = await dmSend(uid, text, buttons ? { reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' } : { parse_mode: 'Markdown' });
      };
      const started = await startBuyWizard(from.id, { send: reportingSend });
      if (!started) {
        await answer(query.id, '🛒 Buy with PB is gated right now.', true);
        await safeSend(chatId ?? from.id, '🛒 Buy with PB is gated right now — check your DM for details.');
      } else if (delivered) {
        await answer(query.id, '🛒 Buy wizard sent to your DM.');
        await groupNote(chatId, from, '🛒', 'the buy wizard is in your DM.');
      } else {
        await answer(query.id, "🔒 I couldn't DM you — open a DM with me first.", true);
        await dmClosedNote(chatId);
      }
      return;
    }
    if (sub === 'planbuy') {
      // Planbuy wave (2026-11-03): in-bot Plan purchase — period pick.
      // Separate, ungated flow; never touches wizbuy sessions or its gate.
      await answer(query.id);
      await safeSend(chatId ?? from.id,
        '💳 Buy PB Plan in chat\n\nPick a term. PB creates your checkout right here — no website, no claim code. You send the exact amount to the address shown, paste your tx hash, and the Plan grants automatically once the watcher confirms on-chain.',
        { reply_markup: { inline_keyboard: [[{ text: 'PB Plan — $29/mo', callback_data: 'planbuy:period:monthly' }], [{ text: 'PB Plan — $290/yr', callback_data: 'planbuy:period:annual' }], [{ text: '❌ Cancel', callback_data: 'planbuy:cancel' }]] } });
      return;
    }
    if (sub === 'back') {
      await answer(query.id);
      await safeSend(chatId ?? from.id, '🤖 PoorBoyAI Command Center — run /menu to reopen it.');
      return;
    }
    if (sub === 'buy_cross') {
      await answer(query.id);
      // Cross-chain buy (restored 2026-10-21): the original wizard offered
      // three swap-aggregator URL buttons with the Base CA pre-filled as
      // the destination; the port dropped them and sent only the Ape.Store
      // (Base-only) link under cross-chain copy. The swaps run entirely on
      // the provider's own site — PB never touches the funds.
      const PBAI = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
      await safeSend(chatId ?? from.id,
        '🌐 Buy $PBAI from any chain\n\nPay with any token on any chain — SOL, ETH, BNB, MATIC, AVAX and more. Pick a swap provider below: the swap runs on the provider\'s own site, $PBAI is pre-selected as the receive token, and it lands in your wallet on Base.\n\n1️⃣ Tap a provider\n2️⃣ Connect your wallet\n3️⃣ Enter your amount and confirm\n\n🔵 Base CA (auto-filled): ' + PBAI,
        { reply_markup: { inline_keyboard: [
          [{ text: '🌉 Jumper Exchange (Recommended)', url: `https://jumper.exchange/?toChain=8453&toToken=${PBAI}` }],
          [{ text: '🦑 Squid Router', url: `https://app.squidrouter.com/?chains=1%2C8453&tokens=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee%2C${PBAI}` }],
          [{ text: '⚡ Li.Fi — 250+ chains & DEXes', url: `https://app.li.fi/?toChain=base&toToken=${PBAI}` }],
        ] } });
      return;
    }
    if (sub === 'buy_base') {
      await answer(query.id);
      // Buy on Base with real doors (2026-10-21): the copy always named
      // Uniswap, but the only live link was Ape.Store's. Both are now URL
      // buttons (the original wizard's idiom); the Uniswap URL is the
      // website /buy page's verbatim link ($PBAI pre-selected on Base).
      const PBAI = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
      // Uniswap API wave (2026-10-28, V1 read-only): example quote line.
      // Null without a key or on any API failure → the message below is
      // byte-identical to before. The quote never blocks the buttons and
      // is labeled EXAMPLE (fixed 100 USDC — this flow takes no amount
      // input) and ESTIMATE (quote at request time, not a locked price).
      const uniQuote = await getUniswapPbaiQuote(100).catch(() => null);
      let buyText = '🔵 Buy $PBAI on Base\n\nFastest & cheapest: Ape.Store or Uniswap.\n\nCA: ' + PBAI;
      if (uniQuote) {
        buyText += `\n\n💱 Example quote (Uniswap): 100 USDC → ~${uniQuote.outputPbai} $PBAI (est., before slippage)`;
        if (uniQuote.gasFeeUsd) buyText += ` · est. gas ~$${uniQuote.gasFeeUsd}`;
      }
      await safeSend(chatId ?? from.id,
        buyText,
        { reply_markup: { inline_keyboard: [
          [{ text: '🦄 Buy on Uniswap', url: `https://app.uniswap.org/swap?outputCurrency=${PBAI}&chain=base` }],
          [{ text: '🦍 Buy on Ape.Store (Recommended)', url: `https://ape.store/refer/4Ah6P69TEESczvFfL53S9g/8453/${PBAI}` }],
        ] } });
      return;
    }
    if (sub === 'upgrade:plans') {
      await answer(query.id);
      await safeSend(chatId ?? from.id,
        '📋 Subscription Plans\n\n⭐ PB Plan — $29/mo or $290/yr (2 months free): everything unlocked — all commands, Studio access, campaigns, Developer API + Hosted MCP, Ad Creator included. Generation beyond your included allowance runs on credit packs (500 for $15, 2,000 for $49, 5,000 for $99 — never expire).\n\n🎁 7-day free trial: 100 trial credits, standard renders only, one per account, booster sends excluded. After the trial you drop to the free layer (raids and moderation) unless you upgrade.\n\nNothing auto-renews — plans are one-time crypto purchases; a term simply ends unless you buy again. Existing Starter / Builder / Pro / Agency holders keep their terms until renewal, then move to the PB Plan.\n\n🌐 /upgrade',
        { reply_markup: { inline_keyboard: [[{ text: '🎁 Start 7-day free trial', callback_data: 'menu:trial:start' }], [{ text: '🛒 Buy with PB', callback_data: 'menu:wizbuy' }], [{ text: '💳 Buy PB Plan in chat', callback_data: 'menu:planbuy' }]] } });
      return;
    }
    if (sub === 'trial:start') {
      // PRICING WAVE: the trial funnel — one tap, one trial per
      // account, ever. No money moves here; the trial is free.
      await answer(query.id);
      const res = await startWeekTrial(from.id).catch(() => ({ ok: false, reason: 'error' }));
      if (res.ok) {
        const endLabel = new Date(res.endsAt).toISOString().slice(0, 10);
        await safeSend(chatId ?? from.id,
          `🎁 Your 7-day free trial started — 100 trial credits, good until ${endLabel}.\n\nYou have everything unlocked: all commands, Studio access, campaigns, Developer API + Hosted MCP, Ad Creator. Standard renders draw trial credits (video from 25, podcast short 50, images 2 each). Premium add-ons never ride the trial, booster sends are excluded, and credit packs wait until the trial ends.\n\nI'll nudge you the day before it ends. Keep it all with /upgrade — $29/mo or $290/yr.`,
          { reply_markup: { inline_keyboard: [[{ text: '⭐ Leave a review', callback_data: 'menu:review' }]] } });
      } else if (res.reason === 'already') {
        await safeSend(chatId ?? from.id, '🎁 You already used your free trial — one per account, ever. Keep everything with the PB Plan: /upgrade ($29/mo or $290/yr).');
      } else if (res.reason === 'paid') {
        await safeSend(chatId ?? from.id, '⭐ You already hold an active paid plan — no trial needed. Your plan already unlocks everything.');
      } else {
        await safeSend(chatId ?? from.id, '❌ The trial could not start right now — try again in a moment, or run /upgrade.');
      }
      return;
    }
    if (sub === 'upgrade:airdrop') {
      // Wizard-fix wave: the airdrop wizard is live — route to it
      // instead of a dashboard popup. startAirdropWizard returns null
      // when airdrop is parked, so the flag is still respected.
      await answer(query.id);
      const panel = await startAirdropWizard(from.id);
      if (!panel) {
        await safeSend(chatId ?? from.id, '🪂 Airdrops are parked right now.');
        return;
      }
      await safeSend(chatId ?? from.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
      return;
    }
    if (sub === 'upgrade:booster') {
      // Menu-buttons fix (2026-11-05): same disease as menu:boost — the
      // old popup-only notice was the whole outcome. Routes to the same
      // boost wizard + group pointer.
      const delivered = await startBoostWizardFor(from.id);
      if (delivered) {
        await answer(query.id, '⚡ Pick the boost type in your DM.');
        await groupNote(chatId, from, '⚡', 'pick the boost type in your DM.');
      } else {
        await answer(query.id, "🔒 I couldn't DM you — open a DM with me first.", true);
        await dmClosedNote(chatId);
      }
      return;
    }
    if (sub === 'upgrade:videos') {
      // Menu-buttons fix (2026-11-05): same disease as menu:pb_videoad —
      // the old popup-only notice was the whole outcome. Routes to the
      // same /create flow.
      await answer(query.id);
      await STUDIO_COMMANDS.create(chatId ?? from.id, '', { chat: { id: chatId ?? from.id, type: chatId != null && Number(chatId) !== Number(from.id) ? 'supergroup' : 'private' }, from });
      return;
    }
    if (sub === 'skills') {
      // PB Skills card (Mini App Chat wave, 2026-11-05): DM-only surface.
      // In a group the card lands in the tapper's DM — never post a
      // member's tier/wallet to the group.
      // Menu-buttons fix (2026-11-05): the DM send now reports delivery
      // (dmSend) — the old safeSend swallowed a closed-DM 403 while the
      // toast claimed "Sent to your DM!". Closed DM → a visible group
      // fallback note, never a pointer that lies.
      const isGroup = chatId !== null && chatId !== undefined && Number(chatId) !== Number(from.id);
      const card = await buildSkillsCard(from);
      if (isGroup) {
        const delivered = await dmSend(from.id, card.text, { reply_markup: { inline_keyboard: card.keyboard } });
        if (delivered) {
          await answer(query.id, '💬 Sent to your DM!');
          await groupNote(chatId, from, '🧠', 'your skill card is in your DM.');
        } else {
          await answer(query.id, "🔒 I couldn't DM you — open a DM with me first.", true);
          await dmClosedNote(chatId);
        }
      } else {
        await answer(query.id);
        await safeSend(chatId ?? from.id, card.text, { reply_markup: { inline_keyboard: card.keyboard } });
      }
      return;
    }
    await answer(query.id);
    return;
  }

  // PB Skills buttons (Mini App Chat wave, 2026-11-05): tap-to-run skill
  // card buttons (`/skills`, /menu, /start). Delivery is always DM-safe:
  // when the tapped message sits in a group, every result/prompt goes to
  // the tapper's own DM — a member's tier/wallet never posts to a group.
  if (data.startsWith('skill:')) {
    const parsed = parseSkillCallback(data);
    if (!parsed) { await answer(query.id); return; }
    const isGroup = chatId !== null && chatId !== undefined && Number(chatId) !== Number(from.id);
    const dest = isGroup ? from.id : (chatId ?? from.id);
    const cancelRow = [[{ text: '✖ Cancel', callback_data: 'skill:cancel' }]];
    if (parsed.action === 'list') {
      const card = await buildSkillsCard(from);
      await answer(query.id);
      await safeSend(dest, card.text, { reply_markup: { inline_keyboard: card.keyboard } });
      return;
    }
    if (parsed.action === 'cancel') {
      await clearSkillCapture(from.id);
      await answer(query.id, 'Cancelled — nothing ran.');
      return;
    }
    if (parsed.action === 'run') {
      await answer(query.id);
      const res = await runSkillForDm(parsed.name, from, {});
      const out = (res?.text ?? '').trim() || '⚠️ That hit a snag — try again in a moment.';
      await safeSend(dest, out);
      return;
    }
    if (parsed.action === 'ask') {
      const meta = SKILL_CATALOG[parsed.name];
      if (!meta) { await answer(query.id); return; }
      if (parsed.name === 'post_writer') {
        const keyboard = await skillKindKeyboard(from);
        await answer(query.id);
        await safeSend(dest, '✍️ Post Writer — pick a kind:', { reply_markup: { inline_keyboard: keyboard } });
        return;
      }
      await armSkillCapture(from.id, parsed.name);
      await answer(query.id);
      const hint = meta.inputHint ? `\n${meta.inputHint}` : '';
      await safeSend(dest, `🧠 ${meta.title} — send it:${hint}`, { reply_markup: { inline_keyboard: cancelRow } });
      return;
    }
    if (parsed.action === 'kind') {
      const okArmed = await armSkillKindChoice(from.id, parsed.kind);
      if (!okArmed) { await answer(query.id, 'That kind is gone — tap Post Writer again.'); return; }
      const spec = SKILL_CATALOG.post_writer.kinds.find((k) => k.id === parsed.kind);
      await answer(query.id);
      await safeSend(dest, `✍️ Post Writer — ${spec?.label ?? parsed.kind}. Topic?`, {
        reply_markup: { inline_keyboard: [
          [{ text: '▶ Run with $PBAI', callback_data: 'skill:pbai' }],
          [{ text: '✏️ Type a topic', callback_data: 'skill:topic' }],
          [{ text: '✖ Cancel', callback_data: 'skill:cancel' }],
        ] },
      });
      return;
    }
    if (parsed.action === 'pbai') {
      const w = await loadSkillCapture(from.id);
      if (!w || w.name !== 'post_writer' || w.awaiting !== 'topic-choice' || !w.kind) {
        await answer(query.id, 'That step expired — tap Post Writer again.');
        return;
      }
      await clearSkillCapture(from.id);
      await answer(query.id);
      const res = await runSkillForDm('post_writer', from, { kind: w.kind, topic: '' });
      const out = (res?.text ?? '').trim() || '⚠️ That hit a snag — try again in a moment.';
      await safeSend(dest, out);
      return;
    }
    if (parsed.action === 'topic') {
      const moved = await awaitSkillTopic(from.id);
      if (!moved) {
        await answer(query.id, 'That step expired — tap Post Writer again.');
        return;
      }
      await answer(query.id);
      await safeSend(dest, '✍️ Send the topic for your post (one message):', { reply_markup: { inline_keyboard: cancelRow } });
      return;
    }
    await answer(query.id);
    return;
  }

  // Settings buttons (emitted by /settings).
  if (data.startsWith('settings:')) {
    const sub = data.slice(9);
    if (sub === 'style') {
      await answer(query.id);
      await safeSend(chatId ?? from.id, '🎨 Pick your shill style (used in all AI post commands):', {
        reply_markup: { inline_keyboard: [[
          { text: '🔥 Hype', callback_data: 'settings:style:hype' },
          { text: '💼 Professional', callback_data: 'settings:style:professional' },
          { text: '🤙 Degen', callback_data: 'settings:style:degen' },
        ]]},
      });
      return;
    }
    if (sub.startsWith('style:')) {
      const style = sub.slice(6);
      if (['hype', 'professional', 'degen'].includes(style)) {
        await db.insert(user_settings)
          .values({ telegramUserId: String(from.id), shillStyle: style, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: user_settings.telegramUserId,
            set: { shillStyle: style, updatedAt: new Date() },
          }).run().catch(() => {});
        await answer(query.id, `🎨 Shill style set: ${style}.`, true);
      } else {
        await answer(query.id);
      }
      return;
    }
    if (sub === 'notif') {
      const row = await db.select().from(user_settings)
        .where(eq(user_settings.telegramUserId, String(from.id))).get().catch(() => null);
      const cur = row?.notifications ?? {};
      const next = { ...cur, alerts: cur.alerts === false };
      await db.insert(user_settings)
        .values({ telegramUserId: String(from.id), notifications: next, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: user_settings.telegramUserId,
          set: { notifications: next, updatedAt: new Date() },
        }).run().catch(() => {});
      await answer(query.id, next.alerts === false ? '🔕 Price/raid alerts muted.' : '🔔 Alerts on.', true);
      return;
    }
    if (sub === 'sub') {
      await answer(query.id);
      const row = await db.select().from(bot_users)
        .where(eq(bot_users.telegramUserId, String(from.id))).get().catch(() => null);
      await safeSend(chatId ?? from.id, `💳 Your subscription: ${row?.tier ?? 'free'}\n\nRun /mytier for the full breakdown.`);
      return;
    }
    if (sub === 'referral') {
      await answer(query.id);
      const stats = await getReferralStats(from.id).catch(() => ({ total: 0, botTotal: 0, xTotal: 0, tgTotal: 0 }));
      await safeSend(chatId ?? from.id,
        `🔗 Your Referral Link\n\n${botInviteLink(from.id)}\n\n` +
        'Every friend who starts PB through your links earns you +3 XP and +3 bonus AI commands/day — they get +5 XP and +5 free AI commands.\n\n' +
        `📊 Your referrals: ${stats.total} (🤖 Bot ${stats.botTotal} · 𝕏 X ${stats.xTotal} · 💬 Telegram ${stats.tgTotal}) · Bonus: +${stats.total * 3} cmds/day\n\n` +
        'Run /invite for all three channel links, your rank, and the Top 10 board.', {
          reply_markup: { inline_keyboard: [[{ text: '📊 Open /invite', callback_data: 'menu:invite' }]] },
        });
      return;
    }
    if (sub === 'support') {
      await answer(query.id);
      await safeSend(chatId ?? from.id,
        '🆘 Support & Policies\n\n💬 Support: https://t.me/poorboyai_agent_support\n📄 White Paper: https://poorboyai.pages.dev/whitepaper\n🔒 Privacy: https://poorboyai.pages.dev/privacy\n📋 Terms: https://poorboyai.pages.dev/terms');
      return;
    }
    await answer(query.id);
    return;
  }

  // Business bot setup buttons (emitted by /bizsetup). Reads/writes route
  // through lib/business.js (loadBizSettings / saveBizSettings) so the
  // owner's config-key pattern is honored exactly as business_message
  // reads it — the raw settings table alone would shadow his config.
  if (data.startsWith('biz:')) {
    const sub = data.slice(4);
    if (sub === 'start') {
      await answer(query.id);
      const cur = await loadBizSettings(from.id);
      await safeSend(chatId ?? from.id, '⚙️ Business Bot Setup\n\nHow should I respond to people who DM your Telegram account?', {
        reply_markup: { inline_keyboard: [
          [{ text: `🤖 AI replies: ${cur?.aiEnabled === false ? 'OFF' : 'ON'}`, callback_data: 'biz:ai' }],
          [
            { text: '🤖 AI Only', callback_data: 'biz:mode:ai' },
            { text: '📌 Fixed Msg', callback_data: 'biz:mode:fixed' },
          ],
          [{ text: '👋 Greeting + AI', callback_data: 'biz:mode:greeting' }],
          [{ text: '👀 View Messages & Persona', callback_data: 'biz:view' }],
          [
            { text: '✏️ Greeting', callback_data: 'biz:edit:greeting' },
            { text: '✏️ Fixed', callback_data: 'biz:edit:fixed' },
          ],
          [
            { text: '✏️ Fallback', callback_data: 'biz:edit:fallback' },
            { text: '✏️ Persona', callback_data: 'biz:edit:persona' },
          ],
        ]},
      });
      return;
    }
    if (sub === 'ai') {
      const cur = await loadBizSettings(from.id);
      await saveBizSettings(from.id, { aiEnabled: !(cur?.aiEnabled ?? true) });
      await answer(query.id, '⚙️ Business Bot settings updated.', true);
      return;
    }
    if (sub.startsWith('mode:')) {
      const mode = sub.slice(5);
      const map = { ai: 'ai', fixed: 'fixed', greeting: 'greeting_then_ai' };
      if (map[mode]) {
        await saveBizSettings(from.id, { replyMode: map[mode] });
        await answer(query.id, `⚙️ Reply mode: ${mode}.`, true);
      } else {
        await answer(query.id);
      }
      return;
    }
    if (sub === 'view') {
      await answer(query.id);
      const cur = await loadBizSettings(from.id);
      const show = (label, v) => `${label}: ${v?.trim() ? v.trim().slice(0, 500) : '— not set —'}`;
      await safeSend(chatId ?? from.id, [
        '🏢 Your Business Bot Messages',
        '',
        show('👋 Greeting', cur.greetingMessage),
        '',
        show('📌 Fixed', cur.fixedMessage),
        '',
        show('🛟 Fallback', cur.fallbackMessage),
        '',
        show('🎭 Persona', cur.customSystemPrompt),
      ].join('\n'));
      return;
    }
    if (sub.startsWith('edit:')) {
      const field = sub.slice(5);
      const spec = BIZ_WIZ_FIELDS[field];
      if (!spec) { await answer(query.id); return; }
      if (!(await canUseBusinessBot(from.id).catch(() => false))) {
        await answer(query.id, '🏢 Business Bot needs a Starter+ plan.', true);
        return;
      }
      await setBizWizardAwaiting(from.id, field);
      await answer(query.id);
      await safeSend(from.id,
        `✏️ Send your new ${spec.label} as your next message in this DM (max 2000 characters). It replaces the current one.`, {
          reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'biz:cancel' }]] },
        });
      return;
    }
    if (sub === 'cancel') {
      await clearBizWizard(from.id);
      await answer(query.id, '❌ Business Bot edit cancelled.', true);
      return;
    }
    await answer(query.id);
    return;
  }

  // Airdrop buttons (emitted by /airdropstatus).
  if (data.startsWith('airdrop:')) {
    const sub = data.slice(8);
    if (sub === 'start') {
      await answer(query.id);
      const panel = await startAirdropWizard(from.id);
      if (!panel) { await safeSend(chatId ?? from.id, '🪂 Airdrops are parked right now.'); return; }
      await safeSend(chatId ?? from.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
      return;
    }
    if (sub === 'guide') {
      await answer(query.id);
      await safeSend(chatId ?? from.id,
        '💳 Register a Recipient Wallet\n\nRun /connect <your_wallet_address> in a DM with me.\n\nYou\'re then eligible for community airdrops sent to registered wallets.');
      return;
    }
    await answer(query.id);
    return;
  }

  // X setup buttons (emitted by /raidsetup).
  if (data.startsWith('xsetup:')) {
    // Wizard-restore wave (2026-10-21): the stub is gone — lib/accounts.js
    // runs the original's flow (DM handle capture → tweet-code verify via
    // the public oEmbed check → twitter_handles.x_verified).
    const res = await handleXSetupCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'X setup error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Connect Socials legs (Wizard-fix wave, 2026-10-21): TikTok / Discord
  // captures + the Pro+ own-X-API-keys step (lib/accounts.js). The X rows
  // of the same panel ride the xsetup: route above.
  if (data.startsWith('socials:')) {
    const res = await handleSocialsCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Socials error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Wizard-restore wave (2026-10-21) routers — each lib handler returns
  // { text, alert } and does its own sends/edits, like campaign:/mng:.
  if (data.startsWith('setupwiz:')) {
    const res = await handleSetupCallback({ userId: from.id, data })
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Setup error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('applywiz:')) {
    const res = await handleApplyCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Apply error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  // Overnight build 2026-10-25 (local only): /wizbuy purchase wizard buttons.
  if (data.startsWith('wizbuy:')) {
    const res = await handleBuyWizardCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Buy error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  // In-bot PB Plan purchase (planbuy wave, 2026-11-03): separate,
  // ungated flow — never touches wizbuy sessions or the wizbuy gate.
  if (data.startsWith('planbuy:')) {
    const res = await handlePlanbuyCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Plan buy error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  // Overnight build 2026-10-25 (local only): outreach Accept/Decline buttons.
  if (data.startsWith('outreach:')) {
    const res = await handleOutreachCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Outreach error'}`, alert: true }));
    if (res) await answer(query.id, res?.text, Boolean(res?.alert));
    else await answer(query.id);
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('mywallet:')) {
    const res = await handleMyWalletCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Wallet error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('team:')) {
    const res = await handleTeamCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Team registry error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('xprewards:')) {
    const res = await handleXpRewardsCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'XP Rewards error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data === 'setrules:cancel') {
    const res = await handleSetRulesCancel(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Rules error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('gen:')) {
    const res = await handleGenerateCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Generate error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // PB Announce wizard buttons (2026-10-22): the ann:* family emitted by
  // lib/posts.js (project pick, preview actions, destination pick,
  // history re-post). The whole handler lives in lib/posts.js; sessions
  // are keyed by the clicker's own id, so a button only ever drives its
  // owner's session.
  if (data.startsWith('ann:')) {
    const res = await handleAnnounceCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Announce error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Army registration button (emitted by /syncmembers).
  if (data === 'army:register') {
    const gid = String(chatId ?? '');
    if (gid) {
      await db.insert(group_members).values({
        chatId: gid, userId: from.id,
        firstName: from.first_name ?? null, username: from.username ?? null,
        registeredAt: new Date(),
      }).onConflictDoUpdate({
        target: [group_members.chatId, group_members.userId],
        set: {
          firstName: from.first_name ?? null, username: from.username ?? null,
          registeredAt: new Date(),
        },
      }).run().catch(() => {});
    }
    await answer(query.id, "✅ You're registered in the PoorBoy Army!");
    try {
      await api.sendMessage({
        chat_id: from.id,
        text: `✅ You're registered in the PoorBoy Army!\n\nHey ${from.first_name ?? 'friend'} — you're now in the community system.\n\n• Admins can reach you with group announcements via /everyone\n• You'll be included in raid calls, alerts & community pings\n• Use /start to see all available bot commands\n\nWelcome to the army! 🐳`,
      });
    } catch { /* DM not started — group registration still counts */ }
    return;
  }

  // Contest wizard buttons (emitted by /contest — design §4). The draft is
  // keyed by chat+admin in lib/contests.js; another user's tap lands on the
  // expired-session path, so only the wizard's owner can drive it.
  if (data.startsWith('contest:')) {
    if (chatId) {
      const res = await handleContestCallback({
        chatId, userId: from.id, data, messageId: query.message?.message_id,
      }).catch((err) => ({ text: `❌ ${err?.message ?? 'Wizard error'}`, alert: true }));
      await answer(query.id, res?.text, Boolean(res?.alert));
    } else {
      await answer(query.id);
    }
    maybeTick().catch(() => {});
    return;
  }

  // Studio wizard buttons (emitted by /create — Batches 1–3). The wizard
  // state is keyed by the tapper's own user id in lib/studio.js, so only
  // the wizard's owner can drive it; flag OFF answers with parked copy.
  if (data.startsWith('studio:')) {
    const res = await handleStudioCallback({
      userId: from.id, data, messageId: query.message?.message_id,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Studio error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Podcast wizard buttons (emitted by /podcast — revival, 2026-10-20).
  // Same ownership shape as Studio: wizard state is keyed by the
  // tapper's own user id in lib/podcast.js; flag OFF answers parked copy.
  if (data.startsWith('podcast:')) {
    const res = await handlePodcastCallback({
      userId: from.id, data, messageId: query.message?.message_id,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Podcast error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Boost/Airdrop wizard buttons (emitted by /boost and /airdrop —
  // rebuild, 2026-10-20). Same ownership shape: wizard state is keyed by
  // the tapper's own user id in lib/boost.js / lib/airdrop.js; flag OFF
  // answers with parked copy. ('adrop:' is the wizard prefix — the legacy
  // 'airdrop:' info buttons above keep their exact behavior.)
  if (data.startsWith('boost:')) {
    const res = await handleBoostCallback({
      userId: from.id, data, messageId: query.message?.message_id,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Boost error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Restore wave Batch 2 (2026-10-26): user booster pickers + group voice
  // language picker. These prefixes are deliberately NOT 'boost:' — the
  // wizard parser splits on ':' and would read a ':cancel' second
  // segment as a wizard cancel — so they route here on exact prefixes,
  // with ownership/admin re-verified inside each handler (a forwarded
  // panel drives nothing for anyone else). 'boosterstop:' /
  // 'boosterretry:' / 'voicelang:' never match the 'boost:' branch
  // above ('booster…' has no colon at index 5), so branch order between
  // them is irrelevant; the exact-prefix check is the guard.
  if (data.startsWith('boosterstop:')) {
    const res = await handleBoosterStopCallback({
      userId: from.id, data, messageId: query.message?.message_id, chatId,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Boost error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('boosterretry:')) {
    const res = await handleBoosterRetryCallback({
      userId: from.id, data, messageId: query.message?.message_id, chatId,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Boost error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('voicelang:')) {
    const res = await handleVoiceLangCallback(query).catch((err) => ({ text: `❌ ${err?.message ?? 'Voice error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // PB Relay wizard + rule-action buttons (Wave 1, 2026-10-21; emitted
  // by /relay and the DM wizard in lib/relay.js). Every action
  // re-resolves the rule by id AND owner inside lib/relay.js — a
  // forwarded panel drives nothing for anyone else.
  if (data.startsWith('relay:')) {
    const res = await handleRelayCallback({
      userId: from.id, data, messageId: query.message?.message_id,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Relay error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }
  if (data.startsWith('adrop:')) {
    const res = await handleAirdropCallback({
      userId: from.id, data, messageId: query.message?.message_id,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Airdrop error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Campaign panel buttons (emitted by /campaign). Every action re-resolves
  // the campaign/slot by id AND owner inside lib/campaigns.js, so a tapper
  // can only ever drive their own campaign — someone else's id reads as
  // not-found.
  if (data.startsWith('campaign:')) {
    const res = await handleCampaignCallback({
      userId: from.id, data, messageId: query.message?.message_id,
    }).catch((err) => ({ text: `❌ ${err?.message ?? 'Campaign error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // PB Shield alert-card buttons (impersonation Ban/Release/Dismiss +
  // the burst card's End button). Every click re-verifies the clicker's
  // admin right inside lib/groups.js before anything happens.
  if (data.startsWith('shield:')) {
    const res = await handleShieldCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Shield error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Group Manager panel buttons (Phase 1 restore; emitted by /manage).
  // Every mng: action re-verifies the clicker's Change Info admin right
  // for the target group inside lib/groups.js before anything renders —
  // a forwarded panel message drives nothing for non-admins.
  if (data.startsWith('mng:')) {
    const res = await handleManageCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Group Manager error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Portal verification (Phase 2 restore): the "I'm Human" button on a
  // portal challenge message. Only the challenged member can use it —
  // lib/walletcmds.js restores their permissions, clears the challenge
  // row and DMs the $PBAI holder prompt.
  if (data.startsWith('portal_verify:')) {
    const res = await handlePortalVerifyCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Portal error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Portal holder check: the "Check My $PBAI Holdings" button on the
  // post-verify DM (and its Check Again re-taps).
  if (data.startsWith('pbai_portal_holder:')) {
    const res = await handlePortalHolderCallback(query)
      .catch((err) => ({ text: `❌ ${err?.message ?? 'Holder check error'}`, alert: true }));
    await answer(query.id, res?.text, Boolean(res?.alert));
    maybeTick().catch(() => {});
    return;
  }

  // Unknown prefix — answer silently (never leave a spinner hanging).
  await answer(query.id);
  // Opportunistic clock: answer already sent; tick runs best-effort on its own.
  maybeTick().catch(() => {});
}

// Watchdog capture (2026-10-22): the handler's top level. An error that
// escapes handleCallbackImpl is recorded in command_errors (content-free:
// callback prefix + chat id + error class — see lib/groups.js) and then
// RETHROWN, so platform-visible behavior is exactly what it was before
// capture existed. The capture itself is fail-open.
export default async function (query, ctx) {
  try {
    return await handleCallbackImpl(query, ctx);
  } catch (err) {
    await captureCommandError({
      surface: 'callback',
      chatId: query?.message?.chat?.id,
      label: errorLabelForCallback(query),
      err,
    });
    console.error('[callback_query]', err?.message ?? err);
    throw err;
  }
}
