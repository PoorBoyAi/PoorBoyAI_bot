// PB ops commands — "batch B" owner/admin command ports.
//
// Each entry has the shape of handlers/message.js COMMANDS entries:
//   (chatId, args, msg) => Promise<void>
// so the coordinator can merge OPS_COMMANDS into the live dispatch.
// Self-contained: only sdk, sdk/db, schema.js and sibling libs (groups,
// config, posts, raids). Plain text, no Markdown (matches the live
// sendSafe style).
//
// Community sealing: admin commands read/write ONLY this group's data
// (raid_xp, raid_queue, group_settings keyed by this chat id). The
// cross-group operations (/globalban, /globalunban, /hype, owner-DM
// /modlist, /checkuser, /settier, /addgem, /removegem) are owner-gated by
// design — the same deliberate gated paths the original had.

import { api, fetch, InputFile } from 'sdk';
import db, { eq, sql, desc } from 'sdk/db';
import {
  bot_users, global_banned_users, known_groups, raid_xp, raid_queue,
  scheduled_messages, config, user_wallets, web_subscriptions, twitter_handles,
  group_members, ad_campaigns,
} from '../schema.js';
import {
  isOwnerId, isChatAdmin, getGroupSettings, setGroupSettings, getTarget,
  resetWarns, logCommunityBan, logCommunityMute, cleanupNoteSent,
} from './groups.js';
import { getConfig, setConfig } from './config.js';
import { requestBroadcastPreview } from './broadcastcmds.js';
import { askLLM } from './llm.js';
import { listSupportSessions } from './groupmsg.js';
import { fetchTokenByAddress, lpCoinKey } from './market.js';
import { getQueueItems, clearQueue, bookKitRaidSlot, readKitRaidSlots } from './raids.js';
import { xQueueAdd, xQueueRemove, xQueueClear, xQueueAddThankyou, xLoopStatus, XLOOP_MAX_CHARS } from './repurpose.js';
import { recordSystemDecision } from './decide.js';
import { effectiveTier, GRINDER_TIERS } from './posts.js';
import { canonicalTier } from './tiers.js';

// ── Local helpers (own sendSafe + gates, not imports from handlers) ──────────

async function sendSafe(chatId, text) {
  try {
    const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000) });
    // PB Cleanup capture seam (2026-10-22).
    await cleanupNoteSent(chatId, sent);
    return sent;
  } catch (err) {
    // 403 = bot blocked/kicked — nothing more to do.
    if (err?.code !== 403) console.error('[opscmds]', err?.code, err?.description ?? err?.message);
  }
}

async function adminGate(chatId, msg) {
  if (msg.chat.type === 'private') {
    await sendSafe(chatId, 'ℹ️ This command only works in groups.');
    return false;
  }
  if (!msg.from || !(await isChatAdmin(chatId, msg.from.id))) {
    await sendSafe(chatId, '⛔ Only group admins can use this command.');
    return false;
  }
  return true;
}

async function ownerGate(chatId, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    await sendSafe(chatId, '🔒 Owner only.');
    return false;
  }
  return true;
}

async function getBotUserRow(tgId) {
  try {
    return await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(tgId))).get() ?? null;
  } catch { return null; }
}

async function upsertAdFree(chatId, byId, free) {
  const cid = String(chatId);
  try {
    await db.insert(known_groups)
      .values({ chatId: cid, isAdFree: free, adFreeBy: String(byId ?? '') })
      .onConflictDoUpdate({
        target: known_groups.chatId,
        set: { isAdFree: free, adFreeBy: String(byId ?? '') },
      }).run();
  } catch { /* ad-free flag write failure never breaks the reply */ }
}

function stripAt(s) { return String(s ?? '').replace(/^@/, ''); }

// ── /ping — trivial health check (no gate, per the wave brief) ───────────────

async function ping(chatId) {
  await sendSafe(chatId, '🏓 Pong! Bot is alive and receiving commands.');
}

// ── /globalban /globalunban — owner-gated cross-group bans ───────────────────
// (source: telegram-community-bot.ts ~21925; table global_banned_users is live.
// The live message handler already enforces the global ban list at its gate.)

async function globalban(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const raw = (args ?? '').trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const usedReply = !!(msg.reply_to_message?.from && !msg.reply_to_message.from.is_bot);
  const target = await getTarget(msg, stripAt(tokens[0] ?? ''));
  let targetId = null, targetName = '', reason = '', username = null;
  if (target) {
    targetId = target.id;
    targetName = target.name;
    reason = usedReply ? raw : tokens.slice(1).join(' ');
    username = usedReply
      ? (msg.reply_to_message.from.username ?? null)
      : (/^\d+$/.test(tokens[0] ?? '') ? null : stripAt(tokens[0] ?? ''));
  } else if (/^\d+$/.test(tokens[0] ?? '')) {
    targetId = Number(tokens[0]);
    targetName = `ID ${tokens[0]}`;
    reason = tokens.slice(1).join(' ');
  }
  if (!targetId) {
    await sendSafe(chatId, 'Usage: /globalban @username [reason] — or reply to their message.');
    return;
  }
  if (await isOwnerId(targetId)) {
    await sendSafe(chatId, `🛡️ ${targetName} is the bot owner and cannot be globally banned.`);
    return;
  }
  const reasonText = reason.trim() || 'Permanent ban — owner decision';
  try {
    await db.insert(global_banned_users).values({
      telegramUserId: Number(targetId),
      username: username ? stripAt(username) : null,
      reason: reasonText,
    }).run();
  } catch (err) {
    console.error('[globalban]', err?.message ?? err);
    await sendSafe(chatId, '❌ Could not write the ban. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `🚫 ${targetName} globally banned.\nReason: ${reasonText}`);
}

async function globalunban(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const clean = stripAt((args ?? '').trim().split(/\s+/)[0] ?? '');
  if (!clean) {
    await sendSafe(chatId, 'Usage: /globalunban @username  (or /globalunban <user_id>)');
    return;
  }
  try {
    if (/^\d+$/.test(clean)) {
      await db.delete(global_banned_users)
        .where(eq(global_banned_users.telegramUserId, Number(clean))).run();
    } else {
      await db.delete(global_banned_users)
        .where(sql`lower(${global_banned_users.username}) = ${clean.toLowerCase()}`).run();
    }
  } catch (err) {
    console.error('[globalunban]', err?.message ?? err);
    await sendSafe(chatId, '❌ Could not remove the ban. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `✅ ${clean} has been globally unbanned.`);
}

// ── /modlist — moderation audit log ──────────────────────────────────────────
// Group: admin-gated, shows this group's bans/mutes + the global list +
// disqualified raiders (folds in ungated /disqualified under the admin gate).
// Owner DM: global bans only.

async function modlist(chatId, args, msg) {
  const inGroup = msg.chat.type !== 'private';
  // ID-leak fix 2026-10-31: group-visible output never prints a raw
  // numeric Telegram ID. Owner-DM output (owner-gated, global bans
  // only) keeps IDs; group output falls back to 'Anon'.
  const showId = !inGroup;
  if (!inGroup) {
    if (!(await ownerGate(chatId, msg))) return;
  } else if (!(await adminGate(chatId, msg))) return;

  const lines = [];
  try {
    const gb = await db.select().from(global_banned_users)
      .orderBy(sql`banned_at DESC`).limit(50).all().catch(() => []);
    lines.push('🌐 Global Bans (cross-group permanent)');
    if (!gb.length) lines.push('  None');
    else for (const r of gb) {
      const tag = r.username ? `@${r.username}` : (showId ? `ID:${r.telegramUserId ?? '?'}` : 'Anon');
      lines.push(`  🚫 ${tag} — ${r.reason ?? 'no reason'}`);
    }
  } catch { lines.push('🌐 Global Bans — unavailable right now.'); }

  if (inGroup) {
    const settings = await getGroupSettings(chatId);
    const bans = settings.bans ?? {};
    lines.push('', '🔨 Community Bans (this group)');
    const banKeys = Object.keys(bans);
    if (!banKeys.length) lines.push('  None');
    else for (const k of banKeys.slice(0, 50)) {
      const b = bans[k];
      lines.push(`  🔨 ${b.name ?? (showId ? `ID:${k}` : 'Anon')} — by ${b.byName ?? 'admin'}`);
    }
    const mutes = settings.mutes ?? {};
    lines.push('', '🔇 Active Mutes (this group)');
    const now = Date.now();
    let shown = 0;
    for (const k of Object.keys(mutes)) {
      const m = mutes[k];
      const until = new Date(m.at).getTime() + (Number(m.minutes) || 0) * 60_000;
      if (until > now) {
        lines.push(`  🔇 ${m.name ?? (showId ? `ID:${k}` : 'Anon')} — ${m.minutes} min, by ${m.byName ?? 'admin'}`);
        shown++;
      }
      if (shown >= 50) break;
    }
    if (!shown) lines.push('  None');
    try {
      const dq = await db.select().from(raid_xp)
        .where(sql`${raid_xp.chatId} = ${Number(chatId)} AND ${raid_xp.isDisqualified} = 1`).all();
      lines.push('', '⛔ Disqualified (raid leaderboard)');
      if (!dq.length) lines.push('  None');
      else for (const r of dq.slice(0, 50)) {
        lines.push(`  ⛔ ${r.displayName ?? r.username ?? (showId ? `ID:${r.userId}` : 'Anon')}`);
      }
    } catch { /* raid_xp read failure never breaks the audit */ }
  } else {
    lines.push('', 'Run /modlist in a group to see that community’s bans, mutes and disqualified list.');
  }

  await sendSafe(chatId, lines.join('\n'));
}

// ── /delnext /clearnext — raid queue management (admin) ──────────────────────

async function delnext(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const idx = parseInt((args ?? '').trim().split(/\s+/)[0] ?? '', 10);
  let items = [];
  try { items = await getQueueItems(Number(chatId)); } catch { /* fall through */ }
  if (!Number.isFinite(idx) || idx < 1 || idx > items.length) {
    await sendSafe(chatId, `⚠️ Invalid index. Queue has ${items.length} item${items.length !== 1 ? 's' : ''}. Use /queue to see them.`);
    return;
  }
  const item = items[idx - 1];
  try {
    await db.delete(raid_queue).where(eq(raid_queue.id, item.id)).run();
  } catch {
    await sendSafe(chatId, '❌ Could not remove that entry. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `🗑️ Removed from queue: ${item.platformEmoji ?? '⚔️'} ${item.platform ?? 'raid'}\n${items.length - 1} remaining in queue.`);
}

async function clearnext(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  let items = [];
  try { items = await getQueueItems(Number(chatId)); } catch { /* fall through */ }
  const n = items.length;
  try { await clearQueue(Number(chatId)); } catch { /* fall through */ }
  await sendSafe(chatId, n === 0
    ? '📋 Queue was already empty.'
    : `🗑️ Queue cleared — ${n} raid${n !== 1 ? 's' : ''} removed.`);
}

// ── /disqualify /undisqualify — raid leaderboard exclusion (admin) ────────────

async function disqualify(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const uname = stripAt((args ?? '').trim().split(/\s+/)[0] ?? '');
  if (!uname) { await sendSafe(chatId, 'Usage: /disqualify @username'); return; }
  const cid = Number(chatId);
  const row = await db.select().from(raid_xp)
    .where(sql`${raid_xp.chatId} = ${cid} AND lower(${raid_xp.username}) = ${uname.toLowerCase()}`)
    .get().catch(() => null);
  if (!row) { await sendSafe(chatId, `⚠️ @${uname} hasn't raided in this group yet.`); return; }
  try {
    await db.update(raid_xp)
      .set({ isDisqualified: true, updatedAt: new Date() })
      .where(sql`${raid_xp.userId} = ${row.userId} AND ${raid_xp.chatId} = ${cid}`).run();
  } catch {
    await sendSafe(chatId, '❌ Could not update. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `⛔ @${uname} disqualified from the leaderboard.`);
}

async function undisqualify(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const uname = stripAt((args ?? '').trim().split(/\s+/)[0] ?? '');
  if (!uname) { await sendSafe(chatId, 'Usage: /undisqualify @username'); return; }
  const cid = Number(chatId);
  const row = await db.select().from(raid_xp)
    .where(sql`${raid_xp.chatId} = ${cid} AND lower(${raid_xp.username}) = ${uname.toLowerCase()}`)
    .get().catch(() => null);
  if (!row) { await sendSafe(chatId, `⚠️ @${uname} hasn't raided in this group yet.`); return; }
  try {
    await db.update(raid_xp)
      .set({ isDisqualified: false, updatedAt: new Date() })
      .where(sql`${raid_xp.userId} = ${row.userId} AND ${raid_xp.chatId} = ${cid}`).run();
  } catch {
    await sendSafe(chatId, '❌ Could not update. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `✅ @${uname} reinstated on the leaderboard.`);
}

// ── /lbreset — wipe this group's raid XP leaderboard (admin) ─────────────────

async function lbreset(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  try {
    await db.update(raid_xp)
      .set({ xp: 0, updatedAt: new Date() })
      .where(eq(raid_xp.chatId, Number(chatId))).run();
  } catch {
    await sendSafe(chatId, '❌ Could not reset. Try again shortly.');
    return;
  }
  await sendSafe(chatId, '🔄 Leaderboard reset! All XP has been cleared for this group.');
}

// ── /remxp — remove XP from a raider (admin) ─────────────────────────────────

async function remxp(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const parts = (args ?? '').trim().split(/\s+/);
  const uname = stripAt(parts[0] ?? '');
  const amount = parseInt(parts[1] ?? '', 10);
  if (!uname || !Number.isFinite(amount) || amount <= 0) {
    await sendSafe(chatId, 'Usage: /remxp @username <amount>');
    return;
  }
  const cid = Number(chatId);
  const row = await db.select().from(raid_xp)
    .where(sql`${raid_xp.chatId} = ${cid} AND lower(${raid_xp.username}) = ${uname.toLowerCase()}`)
    .get().catch(() => null);
  if (!row) { await sendSafe(chatId, `⚠️ @${uname} hasn't raided in this group yet.`); return; }
  const newXp = Math.max(0, (Number(row.xp) || 0) - amount);
  try {
    await db.update(raid_xp)
      .set({ xp: newXp, updatedAt: new Date() })
      .where(sql`${raid_xp.userId} = ${row.userId} AND ${raid_xp.chatId} = ${cid}`).run();
  } catch {
    await sendSafe(chatId, '❌ Could not update. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `📉 -${amount} XP removed from @${uname}\nNew total: ${newXp} XP`);
}

// ── /resetwarn — clear a user's warnings (admin) ─────────────────────────────

async function resetwarn(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const target = await getTarget(msg);
  if (!target) { await sendSafe(chatId, '↩️ Reply to a user to reset their warnings.'); return; }
  try { await resetWarns(chatId, target.id); } catch {
    await sendSafe(chatId, '❌ Could not clear warnings. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `✅ Warnings cleared for ${target.name}.`);
}

// ── /resetwelcome — clear this group's welcome message (admin) ───────────────
// (Mirrors the off-branch of the live /setwelcome.)

async function resetwelcome(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  try {
    await setGroupSettings(chatId, { welcomeMsg: null, welcomeEnabled: false });
  } catch {
    await sendSafe(chatId, '❌ Could not reset. Try again shortly.');
    return;
  }
  await sendSafe(chatId, '✅ Welcome message reset.');
}

// ── /schedule /schedules /unschedule — scheduled daily messages ──────────────
// (source: telegram-community-bot.ts ~22606; table scheduled_messages is live;
// the clock wave posts due rows. /schedule keeps the original Pro+ tier gate
// on top of the group-admin gate.)

const SCHEDULE_TIERS = [...new Set([...GRINDER_TIERS, 'starter', 'builder', 'pro', 'agency'])];

async function listScheduled(chatId) {
  return db.select().from(scheduled_messages)
    .where(eq(scheduled_messages.chatId, String(chatId)))
    .orderBy(sql`send_time ASC`).all().catch(() => []);
}

async function schedule(chatId, args, msg) {
  if (msg.chat.type === 'private') { await sendSafe(chatId, 'Use /schedule in a group.'); return; }
  if (!(await isChatAdmin(chatId, msg.from?.id))) {
    await sendSafe(chatId, '❌ Admins only.');
    return;
  }
  const userRow = await getBotUserRow(msg.from.id);
  const tier = await effectiveTier(msg.from.id, userRow);
  if (!SCHEDULE_TIERS.includes(tier)) {
    await sendSafe(chatId, '⬆️ Scheduled Messages require Pro+\n\nUpgrade with /upgrade.');
    return;
  }
  const m = /^(\d{1,2}:\d{2})\s+([\s\S]+)$/.exec((args ?? '').trim());
  if (!m) { await sendSafe(chatId, 'Usage: /schedule HH:MM Your message  (24h UTC, e.g. /schedule 09:00 Good morning!)'); return; }
  const [hh, mm] = m[1].split(':').map(Number);
  if (hh > 23 || mm > 59) { await sendSafe(chatId, '❌ Invalid time. Use HH:MM (24h UTC).'); return; }
  const sendTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const message = m[2].trim();
  const existing = await listScheduled(chatId);
  if (existing.length >= 10) {
    await sendSafe(chatId, '⚠️ Max 10 scheduled messages per group. Remove one with /unschedule <ID>.');
    return;
  }
  let inserted = null;
  try {
    const rows = await db.insert(scheduled_messages).values({
      chatId: String(chatId),
      sendTime,
      message,
      createdBy: String(msg.from.id),
      active: true,
    }).returning();
    inserted = rows[0] ?? null;
  } catch {
    await sendSafe(chatId, '❌ Could not save that schedule. Try again shortly.');
    return;
  }
  await sendSafe(chatId,
    `✅ Scheduled — every day at ${sendTime} UTC\n\nID: ${inserted?.id ?? '?'}\nMessage: ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}\n\nView all with /schedules · Remove with /unschedule ${inserted?.id ?? 'ID'}`);
}

async function schedules(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const list = await listScheduled(chatId);
  if (!list.length) {
    await sendSafe(chatId, '📅 No scheduled messages. Add one with /schedule HH:MM Your message');
    return;
  }
  const lines = list.map((s) =>
    `• ID ${s.id} — ${s.sendTime} UTC${s.active ? '' : ' (paused)'}\n  ${String(s.message).slice(0, 60)}${String(s.message).length > 60 ? '…' : ''}`);
  await sendSafe(chatId, `📅 Scheduled Messages (${list.length})\n\n${lines.join('\n\n')}\n\nRemove one: /unschedule <ID>`);
}

async function unschedule(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const id = parseInt((args ?? '').trim().split(/\s+/)[0] ?? '', 10);
  if (!Number.isFinite(id)) { await sendSafe(chatId, 'Usage: /unschedule <ID>'); return; }
  const list = await listScheduled(chatId);
  if (!list.some((s) => s.id === id)) {
    await sendSafe(chatId, `❌ No schedule with ID ${id} found in this group.`);
    return;
  }
  try {
    await db.delete(scheduled_messages)
      .where(sql`${scheduled_messages.id} = ${id} AND ${scheduled_messages.chatId} = ${String(chatId)}`).run();
  } catch {
    await sendSafe(chatId, '❌ Could not remove. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `✅ Schedule #${id} removed.`);
}

// ── /settier — owner manually sets a bot tier ────────────────────────────────
// (source ~15108. Live port covers the bot tier only: the web/dashboard
// approved_users + clerk link plumbing does not exist in this runtime.)

const VALID_TIERS = ['free', 'poor', 'starter', 'builder', 'pro', 'agency', 'hustler', 'grinder', 'chad', 'whale', 'dev_launch', 'one'];

async function settier(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const parts = (args ?? '').trim().split(/\s+/);
  const rawId = (parts[0] ?? '').trim();
  const rawTier = (parts[1] ?? '').trim().toLowerCase();
  if (!rawId || !rawTier) { await sendSafe(chatId, 'Usage: /settier <telegram_id|@username> <tier>'); return; }
  if (!VALID_TIERS.includes(rawTier)) {
    await sendSafe(chatId, `❌ Invalid tier "${rawTier}".\n\nValid: ${VALID_TIERS.filter((t) => t !== 'dev_launch').join(', ')}`);
    return;
  }
  let row = null;
  try {
    if (/^\d+$/.test(rawId)) {
      row = await db.select().from(bot_users)
        .where(eq(bot_users.telegramUserId, rawId)).get() ?? null;
    } else {
      const uname = stripAt(rawId).toLowerCase();
      row = await db.select().from(bot_users)
        .where(sql`lower(${bot_users.username}) = ${uname}`).get() ?? null;
    }
  } catch { /* fall through */ }
  if (!row) {
    await sendSafe(chatId, `❌ No bot user found for ${rawId}. They may not have started the bot yet.`);
    return;
  }
  try {
    await db.update(bot_users)
      .set({ tier: rawTier, updatedAt: new Date() })
      .where(eq(bot_users.id, row.id)).run();
  } catch {
    await sendSafe(chatId, '❌ Could not set the tier. Try again shortly.');
    return;
  }
  const who = row.username ? `@${row.username}` : `ID ${row.telegramUserId}`;
  await sendSafe(chatId, `✅ ${who} is now on the ${rawTier} tier.`);
}

// ── /noads /enableads — group ad-free toggle (group admin) ───────────────────
// (source ~20078/20103; setGroupAdFree ↔ known_groups.isAdFree + adFreeBy.)

async function noads(chatId, args, msg) {
  if (msg.chat.type === 'private') { await sendSafe(chatId, 'ℹ️ /noads only works in groups.'); return; }
  if (!(await isChatAdmin(chatId, msg.from?.id))) {
    await sendSafe(chatId, '🔒 Only group admins can remove ads.');
    return;
  }
  const userRow = await getBotUserRow(msg.from.id);
  const tier = await effectiveTier(msg.from.id, userRow);
  if (tier === 'free') {
    await sendSafe(chatId, '🚫 Removing ads requires a paid subscription.\n\nUpgrade with /upgrade to remove ads from this group.');
    return;
  }
  await upsertAdFree(chatId, msg.from.id, true);
  await sendSafe(chatId, '✅ Ads removed from this group!\n\nUse /enableads to re-enable if needed.');
}

async function enableads(chatId, args, msg) {
  if (msg.chat.type === 'private') { await sendSafe(chatId, 'ℹ️ /enableads only works in groups.'); return; }
  if (!(await isChatAdmin(chatId, msg.from?.id))) {
    await sendSafe(chatId, '🔒 Only group admins can change ad settings.');
    return;
  }
  await upsertAdFree(chatId, msg.from.id, false);
  await sendSafe(chatId, '✅ Ads re-enabled for this group.');
}

// ── /checkuser — owner user lookup (DM results, group gets an ack) ───────────
// (source ~15234; reads live tables: bot_users, web_subscriptions,
// user_wallets, twitter_handles. The clerk/approved_users plumbing from the
// source has no live equivalent and is intentionally not ported.)

async function checkuser(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const raw = stripAt((args ?? '').trim().split(/\s+/)[0] ?? '');
  if (!raw) { await sendSafe(chatId, 'Usage: /checkuser @username  or  /checkuser <telegram_id>'); return; }
  const inGroup = msg.chat.type !== 'private';
  if (inGroup) {
    await sendSafe(chatId, '🔍 Sent to your DM.');
  }
  const ownerDm = msg.from.id;
  const replyTo = async (text) => {
    try {
      await sendSafe(ownerDm, text);
    } catch {
      if (inGroup) await sendSafe(chatId, text);
    }
  };
  let row = null;
  try {
    row = /^\d+$/.test(raw)
      ? await db.select().from(bot_users).where(eq(bot_users.telegramUserId, raw)).get() ?? null
      : await db.select().from(bot_users).where(sql`lower(${bot_users.username}) = ${raw.toLowerCase()}`).get() ?? null;
  } catch { /* fall through */ }
  if (!row) {
    await replyTo(`❌ No bot user found for ${raw}.\n\nThey may not have started the bot yet.`);
    return;
  }
  const tgId = row.telegramUserId;
  const tier = await effectiveTier(Number(tgId), row);
  const lines = [
    '🔍 User lookup',
    '',
    `👤 ${row.firstName ?? ''}${row.username ? ` (@${row.username})` : ''} — TG ID ${tgId}`,
    `🎟️ Tier: ${tier}${row.subscriptionExpiresAt ? ` (expires ${new Date(row.subscriptionExpiresAt).toISOString().slice(0, 10)})` : ''}`,
  ];
  try {
    const web = await db.select().from(web_subscriptions)
      .where(eq(web_subscriptions.telegramUserId, tgId)).get() ?? null;
    if (web) lines.push(`🌐 Web grant: ${web.tier} via ${web.source ?? 'worker'}${web.expiresAt ? ` (expires ${new Date(web.expiresAt).toISOString().slice(0, 10)})` : ''}`);
  } catch { /* web mirror read failure is non-fatal */ }
  try {
    const w = await db.select().from(user_wallets)
      .where(eq(user_wallets.telegramUserId, tgId)).get() ?? null;
    if (w) lines.push(`💳 Wallets: Base ${w.baseAddress ?? '—'} · SOL ${w.solAddress ?? '—'}`);
  } catch { /* non-fatal */ }
  try {
    const x = await db.select().from(twitter_handles)
      .where(eq(twitter_handles.telegramUserId, tgId)).get() ?? null;
    if (x?.twitterHandle) lines.push(`🐦 X: @${x.twitterHandle}${x.xVerified ? ' ✅' : ' (unverified)'}`);
  } catch { /* non-fatal */ }
  await replyTo(lines.join('\n'));
}

// ── /hype — owner milestone blast to all known groups ────────────────────────
// (source ~20819; targets resolved from known_groups since the original
// user_target_groups table has no live equivalent. This is one of the
// deliberate owner-broadcast cross-group paths.)

async function hype(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  let total = '?';
  try {
    const c = await db.get(sql`SELECT COUNT(*) AS cnt FROM bot_users`);
    total = String(c?.cnt ?? '?');
  } catch { /* fall through */ }
  const hypeMsg = [
    '🚨 MILESTONE ALERT 🚨',
    '',
    `The PoorBoyAI army now has ${total} soldiers and we are just getting started! 🤖🔥`,
    '',
    'Here is what you are missing if you are not using @PoorBoyAI_bot yet:',
    '',
    '📈 Live price on ANY token — /price',
    '📊 Full TA (RSI, MACD, Bollinger) — /ta',
    '🔐 Honeypot & rug check — /scan',
    '🤖 AI crypto assistant — /ask',
    '🎯 Community raids — /raid',
    '🛡️ FUD destroyer — /fudshield',
    '🖼️ AI meme maker — /meme',
    '💎 Gem discovery — /gem',
    '',
    '🔥 Tell your friends! Every new member makes the army stronger.',
    '',
    '👉 Start the bot: @PoorBoyAI_bot',
    '🌐 poorboyai.pages.dev',
    '',
    'LFG! 🚀🚀🚀',
  ].join('\n');
  let targets = [];
  try {
    targets = await db.select().from(known_groups).limit(100).all();
  } catch { targets = []; }
  if (!targets.length) {
    await sendSafe(chatId, 'ℹ️ No known groups to hype in yet.');
    return;
  }
  // Fix 1 (2026-10-29): /hype no longer blasts immediately. The exact
  // hype text + the target list go to the owner first; the callback
  // branch sends to exactly these stored targets only on Confirm.
  await requestBroadcastPreview(chatId, msg.from.id, {
    kind: 'hype',
    text: hypeMsg,
    displayText: hypeMsg,
    targets: targets.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
  });
}

// ── /addgem /removegem /gems — owner-managed global gem list ─────────────────
// (source ~20868: the original kept the list in a server-side array with a
// file save; the live runtime is stateless, so the durable store is the
// config table row GLOBAL_GEMS. /gems is public read, mirroring the source.)

const GEMS_KEY = 'GLOBAL_GEMS';

async function loadGems() {
  try {
    const row = await db.select().from(config).where(eq(config.key, GEMS_KEY)).get();
    const parsed = JSON.parse(row?.value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function saveGems(gems) {
  await db.insert(config)
    .values({ key: GEMS_KEY, value: JSON.stringify(gems) })
    .onConflictDoUpdate({ target: config.key, set: { value: JSON.stringify(gems) } })
    .run();
}

async function addgem(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const parts = (args ?? '').trim().split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await sendSafe(chatId,
      '📋 Usage: /addgem <Name> <TICKER> [contract address]\n\nExamples:\n/addgem PoorBoyAI PBAI 0x023f98c2f47edb09ee0d0bc9133d236fc82d060e\n/addgem Bitcoin BTC');
    return;
  }
  const name = parts[0];
  const ticker = stripAt(parts[1]).toUpperCase();
  let address = '';
  if (parts[2]) {
    const isEvm = /^0x[0-9a-fA-F]{40}$/.test(parts[2]);
    const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parts[2]);
    if (!isEvm && !isSol) {
      await sendSafe(chatId, '❌ Invalid contract address — must be an EVM (0x…) or Solana address.');
      return;
    }
    address = isEvm ? parts[2].toLowerCase() : parts[2];
  }
  const gems = (await loadGems()).filter((g) => (g.ticker ?? '').toUpperCase() !== ticker);
  gems.push({ name, ticker, address, addedBy: msg.from?.username ?? 'admin' });
  try { await saveGems(gems); } catch {
    await sendSafe(chatId, '❌ Could not save the gem list. Try again shortly.');
    return;
  }
  await sendSafe(chatId,
    `✅ ${name} ($${ticker}) added to the gem list.` +
    (address ? `\n📍 CA: ${address}` : '') +
    `\n💎 Total gems: ${gems.length}`);
}

async function removegem(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const ticker = stripAt((args ?? '').trim().split(/\s+/)[0] ?? '').toUpperCase();
  if (!ticker) { await sendSafe(chatId, '📋 Usage: /removegem <TICKER>'); return; }
  const gems = await loadGems();
  const idx = gems.findIndex((g) => (g.ticker ?? '').toUpperCase() === ticker);
  if (idx === -1) { await sendSafe(chatId, `❌ No gem found with ticker $${ticker}.`); return; }
  const removed = gems.splice(idx, 1)[0];
  try { await saveGems(gems); } catch {
    await sendSafe(chatId, '❌ Could not save the gem list. Try again shortly.');
    return;
  }
  await sendSafe(chatId, `🗑️ ${removed.name} ($${removed.ticker}) removed from gems list.`);
}

/** /gems body text (shared by the command and the skills layer). */
export async function gemsTextFor() {
  const list = await loadGems();
  if (!list.length) return '💎 No gems added yet.';
  const lines = list.map((g, i) =>
    `${i + 1}. ${g.name} ($${g.ticker})` + (g.address ? `\n   📍 ${g.address}` : ''));
  return `💎 Community Gem List (${list.length})\n\n${lines.join('\n\n')}`;
}

async function gems(chatId) {
  await sendSafe(chatId, await gemsTextFor());
}

// ── /removetoken — remove this group's featured token (admin) ─────────────────
// (source ~15792; live /settoken writes group_settings.tokenAddress/tokenLabel,
// so /removetoken clears both — the natural reverse of /settoken.)

async function removetoken(chatId, args, msg) {
  if (!(await adminGate(chatId, msg))) return;
  const settings = await getGroupSettings(chatId);
  if (!settings.tokenAddress) {
    await sendSafe(chatId, 'ℹ️ No featured token was set.');
    return;
  }
  try {
    await setGroupSettings(chatId, { tokenAddress: null, tokenLabel: null });
  } catch {
    await sendSafe(chatId, '❌ Could not remove. Try again shortly.');
    return;
  }
  await sendSafe(chatId, '🗑️ Featured token removed. Commands will now default to $PBAI.');
}

// ── Export ───────────────────────────────────────────────────────────────────

// ── /xqueue — owner-only admin for the guarded autonomous X loop ───────────
// (X-loop wave, 2026-10-23; engine = lib/repurpose.js cycleXLoop.)
// The loop drains this queue one post per tick under Rowdy's law
// (≤1000 chars, no threads; split budgets since 2026-11-05: posts 15/day,
// replies their own 10/day, max 2 replies to the same post per day,
// kill switch x_loop_off).
// Subcommands: (none) = status · add <text> · remove <n> · clear ·
// off · on (off/on write the same x_loop_off flag /setkey manages) ·
// thankyou (media wave 2026-10-25: queues the approved thank-you post
// + image; the loop sends it on a coming tick inside the daily budget).
async function xqueue(chatId, args, msg) {
  if (!(await ownerGate(chatId, msg))) return;
  const raw = String(args ?? '').trim();
  const sub = (raw.split(/\s+/)[0] ?? '').toLowerCase();
  if (sub === 'thankyou') {
    const r = await xQueueAddThankyou(msg.from.id);
    if (!r.ok) {
      await sendSafe(chatId, r.reason === 'already_queued'
        ? '⚠️ The thank-you post is already queued — it posts on a coming tick if the daily budget allows.'
        : '⚠️ Could not queue the thank-you post.');
      return;
    }
    await sendSafe(chatId, `📥 Thank-you post queued at #${r.position} with the image. It posts on a coming tick if the daily budget allows.`);
    return;
  }
  if (sub === 'add') {
    const text = raw.slice(raw.split(/\s+/)[0].length).trim();
    if (!text) { await sendSafe(chatId, 'Usage: /xqueue add <post text>'); return; }
    const r = await xQueueAdd(text, msg.from.id);
    if (!r.ok) {
      await sendSafe(chatId, r.reason === 'queue_full'
        ? '⚠️ The X queue is full (20). Remove something with /xqueue remove <n> or /xqueue clear.'
        : '⚠️ Could not queue that.');
      return;
    }
    const len = Array.from(r.item.text).length;
    await sendSafe(chatId, r.overLength
      ? `📥 Queued at #${r.position} — ⚠️ ${len} chars is OVER the ${XLOOP_MAX_CHARS} limit: the loop will DROP it, not send it. Shorten it, or remove it with /xqueue remove ${r.position}.`
      : `📥 Queued at #${r.position} (${len}/${XLOOP_MAX_CHARS} chars). It posts on a coming tick if the daily budget allows.`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const r = await xQueueRemove(raw.split(/\s+/)[1]);
    await sendSafe(chatId, r.ok
      ? `🗑 Removed from the X queue: "${String(r.removed.text).slice(0, 80)}"`
      : '⚠️ No queue item with that number — /xqueue shows the list.');
    return;
  }
  if (sub === 'clear') {
    const r = await xQueueClear();
    await sendSafe(chatId, `🧹 X queue cleared (${r.cleared} item${r.cleared === 1 ? '' : 's'} removed).`);
    return;
  }
  if (sub === 'off' || sub === 'on') {
    await setConfig('x_loop_off', sub === 'off' ? '1' : '0');
    // Second Brain S1 system-event hook (2026-10-24): a kill-switch flip
    // IS a decision — record it, flag-gated, fail-open, no reason
    // fabricated (reasonState not_stated; the flip itself is the fact).
    try {
      await recordSystemDecision({
        scope: 'owner', chatId: String(msg.from.id), actorId: msg.from.id,
        topicKey: 'x-loop', title: `X loop ${sub === 'off' ? 'OFF' : 'ON'}`,
        decision: `X loop ${sub === 'off' ? 'turned OFF' : 'turned ON'} via /xqueue`,
        reasoning: null, reasonState: 'not_stated',
      });
    } catch { /* decision-memory failures never break the command */ }
    await sendSafe(chatId, sub === 'off'
      ? '🛑 X loop OFF — nothing will post or reply on X until you turn it back on (/xqueue on, or /setkey X_LOOP_OFF 0).'
      : '▶️ X loop ON — queued posts, milestones and mention replies are live again inside the daily cap.');
    return;
  }
  const s = await xLoopStatus();
  const lines = [
    `🐦 X loop: ${s.off ? '🛑 OFF (kill switch)' : '▶️ ON'} · today posts ${s.budget.postsUsed}/${s.budget.postsCap} · replies ${s.budget.repliesUsed}/${s.budget.repliesCap} (LA day ${s.budget.day})`,
    '',
    s.queue.length ? '📥 Queue:' : '📥 Queue is empty — /xqueue add <text> to line one up.',
    ...s.queue.map((q, i) => `${i + 1}. (${Array.from(q.text).length} chars)${q.imageKey ? ' 📷' : ''} ${q.text.slice(0, 90)}`),
  ];
  if (s.pendingMilestones.length) {
    lines.push('', `🏆 Milestones waiting: ${s.pendingMilestones.length} (${s.pendingMilestones.map((m) => m.kind).join(', ')})`);
  }
  if (s.recentLog.length) {
    lines.push('', 'Recent loop activity:');
    for (const r of s.recentLog) {
      const when = new Date(r.ts * 1000).toISOString().slice(11, 16);
      lines.push(`· ${when}Z ${r.kind} ${r.status}${r.tweetId ? ` → ${r.tweetId}` : ''}${r.text ? ` — ${String(r.text).slice(0, 60)}` : ''}`);
    }
  }
  lines.push('', 'Commands: /xqueue add <text> · /xqueue remove <n> · /xqueue clear · /xqueue off · /xqueue on · /xqueue thankyou');
  await sendSafe(chatId, lines.join('\n'));
}

// ── Restore wave 1 (2026-10-25): Replit Agency commands ───────────────────
// /config, /debug, /export, /webhook were direct Agency-gated onText
// handlers in the Replit original (whale/dev_launch tiers = Agency now),
// NOT wizard steps — verified against telegram-community-bot.ts before
// porting. Sensitive results always reroute to DM (the original deleted
// the group invocation and answered privately); plain text, matching this
// file's sendSafe style. Storage notes: user webhooks live in config keys
// (no whale_webhooks table exists in this build); 24h usage history is
// not retained here (no usage_log table), so /debug and /export say so
// instead of inventing numbers. /webhook test payloads work; automatic
// delivery on campaign posts is NOT wired in this build, and the command
// text says that plainly.
const userWebhookKey = (uid) => `user_webhook:${uid}`;

async function readUserWebhook(uid) {
  try {
    const raw = await getConfig(userWebhookKey(uid), null);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function agencyGate(chatId, msg) {
  const fromId = msg?.from?.id;
  if (!fromId) return false;
  if (await isOwnerId(fromId)) return true;
  let tier = 'free';
  try {
    const row = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(fromId))).get();
    tier = row?.tier ?? 'free';
  } catch { tier = 'free'; }
  if (canonicalTier(tier) === 'agency') return true;
  await sendSafe(chatId, 'Agency feature — this command is exclusive to the Agency tier. Upgrade with /upgrade.');
  return false;
}

// Sensitive command invoked in a group: try to delete the invocation,
// notice the group, and return the DM chat id for the real answer.
async function dmRedirect(chatId, msg) {
  if ((msg?.chat?.type === 'group' || msg?.chat?.type === 'supergroup') && msg?.from?.id) {
    await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    const mention = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name ?? 'You');
    await sendSafe(chatId, `${mention} — results sent to your DMs.`);
    return msg.from.id;
  }
  return chatId;
}

async function latestCampaign(uid) {
  try {
    return await db.select().from(ad_campaigns).where(eq(ad_campaigns.telegramUserId, String(uid))).orderBy(desc(ad_campaigns.createdAt)).limit(1).get();
  } catch { return null; }
}

export const OPS_COMMANDS = {
  disqualified,
  scanmods,
  workerpin,
  setcalloutchannel,
  calloutnow,
  testcallout,
  kitregister,
  kitlist,
  kitraid,
  kitraidlist,
  testbuy,
  supportrecap,
  ping,
  globalban,
  globalunban,
  modlist,
  delnext,
  clearnext,
  disqualify,
  undisqualify,
  lbreset,
  remxp,
  resetwarn,
  resetwelcome,
  removetoken,
  schedule,
  schedules,
  unschedule,
  settier,
  noads,
  enableads,
  checkuser,
  hype,
  addgem,
  removegem,
  gems,
  xqueue,
  // Restore wave 1 (2026-10-25): Replit Agency commands (see helpers above).
  config: async (chatId, args, msg) => {
    if (!(await agencyGate(chatId, msg))) return;
    const dmId = await dmRedirect(chatId, msg);
    const uid = String(msg.from.id);
    const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const key = (parts[0] ?? '').toLowerCase();
    const value = parts.slice(1).join(' ');
    const campaign = await latestCampaign(uid);
    if (!campaign) { await sendSafe(dmId, 'No campaign found. Create one from the PB Ads console on the site first.'); return; }
    if (!key || key === 'show') {
      const status = campaign.isActive ? 'Active' : 'Paused';
      const interval = campaign.postIntervalOverride ?? 'Default';
      await sendSafe(dmId, `Campaign Configuration\n\nProject: ${campaign.projectName} ($${campaign.ticker})\nStatus: ${status}\nPost interval: ${interval} mins\n\nAvailable settings:\n/config interval <mins> — set post interval (30-1440)\n/config pause — pause your campaign\n/config resume — resume your campaign`);
      return;
    }
    if (key === 'interval') {
      const mins = parseInt(value, 10);
      if (isNaN(mins) || mins < 30 || mins > 1440) { await sendSafe(dmId, 'Invalid interval. Provide a number between 30 and 1440 minutes.\nExample: /config interval 120'); return; }
      await db.update(ad_campaigns).set({ postIntervalOverride: mins, updatedAt: new Date() }).where(eq(ad_campaigns.id, campaign.id)).run();
      await sendSafe(dmId, `Post interval updated to ${mins} minutes.`);
      return;
    }
    if (key === 'pause') {
      await db.update(ad_campaigns).set({ isActive: false, active: false, updatedAt: new Date() }).where(eq(ad_campaigns.id, campaign.id)).run();
      await sendSafe(dmId, `Campaign ${campaign.projectName} paused. Use /config resume to restart it.`);
      return;
    }
    if (key === 'resume') {
      await db.update(ad_campaigns).set({ isActive: true, active: true, updatedAt: new Date() }).where(eq(ad_campaigns.id, campaign.id)).run();
      await sendSafe(dmId, `Campaign ${campaign.projectName} resumed. Posts will go out on your next scheduled interval.`);
      return;
    }
    await sendSafe(dmId, `Unknown config key: ${key}\n\nValid keys: interval, pause, resume`);
  },
  debug: async (chatId, args, msg) => {
    if (!(await agencyGate(chatId, msg))) return;
    const dmId = await dmRedirect(chatId, msg);
    const uid = String(msg.from.id);
    const campaign = await latestCampaign(uid);
    const webhook = await readUserWebhook(uid);
    let dbOk = false;
    try { await db.get(sql`SELECT 1 AS ok`); dbOk = true; } catch { dbOk = false; }
    let tier = 'free';
    try {
      const row = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, uid)).get();
      tier = canonicalTier(row?.tier ?? 'free');
    } catch { tier = 'free'; }
    const campaignStatus = campaign
      ? `${campaign.projectName} ($${campaign.ticker})\n  Status: ${campaign.isActive ? 'Active' : 'Paused'}\n  Post interval: ${campaign.postIntervalOverride ?? 'Default'} mins`
      : 'None configured';
    const webhookStatus = webhook?.url ? webhook.url : 'Not set';
    await sendSafe(dmId, `Agency Debug Report\n\nAccount\n  Tier: ${tier}\n  TG User ID: ${uid}\n\nDatabase\n  ${dbOk ? 'Connected' : 'Down'}\n\nCampaign\n  ${campaignStatus}\n\n24h Usage\n  Not retained in this build\n\nWebhook\n  ${webhookStatus}\n\nReport generated at ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`);
  },
  export: async (chatId, args, msg) => {
    if (!(await agencyGate(chatId, msg))) return;
    const dmId = await dmRedirect(chatId, msg);
    const uid = String(msg.from.id);
    await sendSafe(dmId, 'Compiling your data export…');
    try {
      const profileRow = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, uid)).get().catch(() => null);
      const campaignRows = await db.select().from(ad_campaigns).where(eq(ad_campaigns.telegramUserId, uid)).all().catch(() => []);
      const webhook = await readUserWebhook(uid);
      const exportData = {
        exported_at: new Date().toISOString(),
        platform: 'telegram',
        telegram_user_id: msg.from.id,
        tier: canonicalTier(profileRow?.tier),
        profile: profileRow ? {
          telegram_user_id: uid,
          username: profileRow.username ?? null,
          first_name: profileRow.firstName ?? null,
          tier: canonicalTier(profileRow.tier),
          referral_code: profileRow.referralCode ?? null,
          created_at: profileRow.createdAt ?? null,
        } : null,
        campaigns: campaignRows.map((c) => ({
          id: c.id, project_name: c.projectName, ticker: c.ticker,
          is_active: c.isActive, post_interval_override: c.postIntervalOverride ?? null,
          created_at: c.createdAt ?? null,
        })),
        webhook: webhook ?? null,
        recent_usage: 'not retained in this build',
      };
      const json = JSON.stringify(exportData, null, 2);
      const filename = `pbai-export-${uid}-${Date.now()}.json`;
      try {
        await api.sendDocument({
          chat_id: dmId,
          document: new InputFile(new TextEncoder().encode(json), filename, { type: 'application/json' }),
          caption: 'PoorBoyAI Agency Data Export — your campaign, account, and webhook data.',
        });
      } catch {
        for (let i = 0; i < json.length; i += 3900) await sendSafe(dmId, json.slice(i, i + 3900));
      }
    } catch (err) {
      await sendSafe(dmId, `Export failed: ${err?.message ?? 'Unknown error'}. Try again in a moment.`);
    }
  },
  webhook: async (chatId, args, msg) => {
    if (!(await agencyGate(chatId, msg))) return;
    const dmId = await dmRedirect(chatId, msg);
    const uid = String(msg.from.id);
    const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const action = (parts[0] ?? '').toLowerCase();
    const urlArg = parts.slice(1).join(' ');
    const key = userWebhookKey(uid);
    if (action === 'set') {
      if (!urlArg.startsWith('https://')) { await sendSafe(dmId, 'Invalid URL. Webhook URL must start with https://\nExample: /webhook set https://yourapp.com/pbai-webhook'); return; }
      await setConfig(key, JSON.stringify({ url: urlArg, createdAt: new Date().toISOString(), lastCalled: null }));
      await sendSafe(dmId, `Webhook saved.\n\nURL: ${urlArg}\n\nUse /webhook test to verify it.`);
      return;
    }
    if (action === 'remove') {
      const cur = await readUserWebhook(uid);
      if (!cur?.url) { await sendSafe(dmId, 'No webhook configured. Use /webhook set <url> to add one.'); return; }
      await setConfig(key, JSON.stringify(null));
      await sendSafe(dmId, 'Webhook removed.');
      return;
    }
    if (action === 'test') {
      const cur = await readUserWebhook(uid);
      if (!cur?.url) { await sendSafe(dmId, 'No webhook configured. Use /webhook set <url> first.'); return; }
      try {
        const res = await fetch(cur.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'test', platform: 'telegram', telegram_user_id: msg.from.id,
            timestamp: new Date().toISOString(),
            message: 'PoorBoyAI Agency webhook test — if you see this, it works!',
          }),
        });
        if (res.ok) {
          await setConfig(key, JSON.stringify({ ...cur, lastCalled: new Date().toISOString() }));
          await sendSafe(dmId, `Webhook test sent (HTTP ${res.status})\n\nURL: ${cur.url}\n\nYour endpoint received the payload successfully.`);
        } else {
          await sendSafe(dmId, `Webhook responded with HTTP ${res.status}\n\nURL: ${cur.url}\n\nCheck your endpoint logs.`);
        }
      } catch (err) {
        await sendSafe(dmId, `Webhook test failed\n\n${err?.message ?? 'Unknown error'}\n\nURL: ${cur.url}\n\nMake sure your server is reachable.`);
      }
      return;
    }
    const cur = await readUserWebhook(uid);
    if (!cur?.url) {
      await sendSafe(dmId, 'Agency Webhook\n\nNo webhook configured.\n\n/webhook set <https://url> — save endpoint\n/webhook test — send test payload\n/webhook remove — delete webhook\n\nNote: test payloads work now; automatic delivery on campaign posts is not wired in this build.');
    } else {
      await sendSafe(dmId, `Agency Webhook\n\nURL: ${cur.url}\nCreated: ${String(cur.createdAt ?? '').slice(0, 10)}\nLast called: ${cur.lastCalled ? cur.lastCalled.slice(0, 16).replace('T', ' ') + ' UTC' : 'Never'}\n\n/webhook set <url> — update endpoint\n/webhook test — fire test payload\n/webhook remove — delete webhook`);
    }
  },
};

// ══ E4a completeness restores (2026-10-21) ═════════════════════════════════
// /disqualified (:14873), /scanmods (:22081), /workerpin (:13510),
// /calloutnow + callout.ts, /setcalloutchannel (referenced by the source's
// copy but never registered there — implemented here so the documented
// flow works), /testcallout (:16125), /testbuy (:16156), /supportrecap
// (:20999). Gates are the source's own, per command.

// The source's sendSafe was MarkdownV2; the E4a copies below carry
// * _ ` markup, so they send as Markdown with a plain-text fallback.
async function sendMd(chatId, text) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: 'Markdown' });
  } catch {
    await sendSafe(chatId, text);
  }
}

// ── /disqualified — no gate in the source; this chat's list only ───────────

async function disqualified(chatId, args, msg) {
  if (msg.chat.type === 'private') {
    await sendSafe(chatId, 'ℹ️ /disqualified only works in groups.');
    return;
  }
  const rows = await db.select().from(raid_xp)
    .where(sql`${raid_xp.chatId} = ${Number(chatId)} AND ${raid_xp.isDisqualified} = 1`).all();
  if (!rows.length) {
    await sendMd(chatId, '✅ *No disqualified users in this group.*');
    return;
  }
  const lines = rows.map((r) => `• ${r.displayName ?? (r.username ? '@' + r.username : 'Unknown')}`);
  await sendMd(chatId,
    `⛔ *Disqualified Users*\n\n${lines.join('\n')}\n\n_/undisqualify @user to reinstate_`);
}

// ── /scanmods — owner-only (source replied "❌ Owner only.") ───────────────
// PORT SHAPE: the source walked up to 1,000 getChatMember calls with 100ms
// sleeps inside one handler — impossible under the ~30s invoke cap (and
// setTimeout does not exist here). One run scans a bounded batch and says
// so; run it again to continue. The port's group_members registry has no
// is_member split, so members are classified purely by their LIVE status:
// kicked → community-ban log, restricted + cannot send → community-mute
// log (the same group_settings logs /ban and /mute write).

const SCANMODS_BATCH = 50;

async function scanmods(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    await sendSafe(chatId, '❌ Owner only.');
    return;
  }
  if (msg.chat.type === 'private') {
    await sendSafe(chatId, '❌ Run this command in the group you want to scan.');
    return;
  }
  const status = await api.sendMessage({
    chat_id: chatId, text: '🔍 Scanning members for pre-existing bans/mutes… this may take a moment.',
  }).catch(() => null);
  const statusId = status?.message_id;
  const editStatus = async (text) => {
    if (statusId) {
      await api.editMessageText({ chat_id: chatId, message_id: statusId, text }).catch(() => {});
    } else {
      await sendSafe(chatId, text);
    }
  };
  try {
    const members = await db.select().from(group_members)
      .where(eq(group_members.chatId, String(chatId))).all();
    const batch = members.slice(0, SCANMODS_BATCH);
    let bannedCount = 0, mutedCount = 0;
    for (const m of batch) {
      try {
        const member = await api.getChatMember({ chat_id: chatId, user_id: m.userId });
        if (member?.status === 'kicked') {
          await logCommunityBan(chatId,
            { id: m.userId, username: m.username ?? null, name: m.firstName ?? null },
            { id: msg.from.id, first_name: 'scanmods' });
          bannedCount++;
        } else if (member?.status === 'restricted' && member.can_send_messages === false) {
          const until = member.until_date ? Math.max(0, Math.round((member.until_date * 1000 - Date.now()) / 60000)) : 0;
          await logCommunityMute(chatId,
            { id: m.userId, username: m.username ?? null, name: m.firstName ?? null },
            until,
            { id: msg.from.id, first_name: 'scanmods' });
          mutedCount++;
        }
      } catch { /* user left or Telegram rate-limited — skip */ }
    }
    const more = members.length > batch.length
      ? `\n\nScanned ${batch.length} of ${members.length} registered members (one bounded pass per run) — run /scanmods again to continue.`
      : '';
    await editStatus(
      `✅ Scan complete\n🔨 ${bannedCount} pre-existing ban(s) found\n🔇 ${mutedCount} pre-existing mute(s) found\n\nRun /modlist to see the full list.${more}`);
  } catch (e) {
    await editStatus(`❌ Scan failed: ${e?.message ?? e}`);
  }
}

// ── /workerpin — owner-only (source silent; W4: uniform refusal) ────────────
// PORT SHAPE: the source posted a bundled photo (assets/poorboy.png); the
// port has no photo assets, so the same caption + keyboard go out as a
// text post, then pin + delete the command message, as the source did.

async function workerpin(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    // W4 refusal polish (Class B): non-owners get the uniform line.
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (!isGroup) {
    await sendSafe(chatId, 'ℹ️ Run /workerpin inside the Community Workers Portal group.');
    return;
  }
  const caption =
    '🤝 <b>THE PB ARMY WORKER MARKETPLACE IS OPEN</b>\n\n' +
    'Want to get paid to shill, moderate, raid, create content &amp; more?\n\n' +
    '✅ <b>Apply now</b> — takes &lt;2 min via the bot wizard or web form\n' +
    '🌐 <b>Browse verified workers</b> — KOLs, mods, raiders, content creators\n\n' +
    '<i>AI-verified profiles. No middleman. No fees.</i>';
  const keyboard = {
    inline_keyboard: [[
      { text: '🤝 Apply Now', url: 'https://t.me/PoorBoyAI_bot?start=apply' },
      { text: '🌐 Browse Workers', url: 'https://t.me/poorboyai' },
    ]],
  };
  try {
    const sent = await api.sendMessage({
      chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: keyboard,
    });
    await api.pinChatMessage({ chat_id: chatId, message_id: sent.message_id, disable_notification: true }).catch(() => {});
    await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id }).catch(() => {});
  } catch (err) {
    console.error('[workerpin] error:', err?.message ?? err);
    await sendSafe(chatId, '❌ Failed to post — make sure I have Send Messages + Pin Messages admin rights.');
  }
}

// ── PoorBoy Callz (callout.ts port) ────────────────────────────────────────
// The channel id lives in the config table under the source's own key
// ('callout_channel_id', the admin_settings equivalent). Card builder is
// buildCalloutCard verbatim in shape; user-supplied fields are
// HTML-escaped here (the source interpolated raw), and the footer site
// link is poorboyai.pages.dev (the port's live domain).

const CALLOUT_TIER_LABEL = {
  free: '💎 PoorBoy Army',
  starter: '🔵 Starter', hustler: '🔵 Starter',
  builder: '🟣 Builder', grinder: '🟣 Builder',
  pro: '🟠 Pro', chad: '🟠 Pro',
  agency: '🐳 Agency', whale: '🐳 Agency',
  dev_launch: '🚀 Dev Launch',
  one: '⭐ PB Plan', trial: '🎁 Trial',
};
const CALLOUT_JOIN_URL = 'https://t.me/+QYQSoI7C46BhODk5';
const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getCalloutChannelId() {
  try { return (await getConfig('callout_channel_id', null)) || null; } catch { return null; }
}

function buildCalloutCard(c, tier) {
  const lines = [
    '🚨 <b>POORBOY CALLZ</b> 🔥',
    '',
    `🪙 <b>${escHtml(c.project_name)}</b>  —  <code>$${escHtml(c.ticker)}</code>`,
  ];
  if (c.verified_ca) lines.push('✅ <i>Verified Token Holder</i>');
  if (c.description) lines.push('', escHtml(c.description));
  if (c.price || c.market_cap || c.change_24h) {
    lines.push('');
    if (c.price) lines.push(`💰 <b>Price:</b> ${c.price}`);
    if (c.market_cap) lines.push(`📊 <b>MCap:</b> ${c.market_cap}`);
    if (c.change_24h) lines.push(`📈 <b>24h:</b> ${c.change_24h}`);
    if (c.volume_24h) lines.push(`💧 <b>Vol:</b> ${c.volume_24h}`);
    if (c.chain) lines.push(`⛓ <b>Chain:</b> ${escHtml(c.chain)}`);
  }
  if (c.contract_address) {
    lines.push('', '📋 <b>Contract Address:</b>', `<code>${escHtml(c.contract_address)}</code>`);
  }
  const links = [];
  if (c.website) links.push(`<a href="${escHtml(c.website)}">🌐 Website</a>`);
  if (c.telegram_username) links.push(`<a href="https://t.me/${escHtml(String(c.telegram_username).replace(/^@/, ''))}">💬 Telegram</a>`);
  if (c.twitter_handle) links.push(`<a href="https://x.com/${escHtml(String(c.twitter_handle).replace(/^@/, ''))}">🐦 Twitter/X</a>`);
  if (c.discord_invite) links.push(`<a href="${escHtml(c.discord_invite)}">🎮 Discord</a>`);
  if (c.dexscreener_url) links.push(`<a href="${escHtml(c.dexscreener_url)}">📈 DexScreener</a>`);
  if (links.length) lines.push('', links.join('  ·  '));
  lines.push(
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '🤖 Shilling live with <a href="https://t.me/PoorBoyAI_bot">@PoorBoyAI_bot</a>',
    `${CALLOUT_TIER_LABEL[tier] ?? '💎 PoorBoy Army'}  ·  Powered by $PBAI`,
    '<a href="https://poorboyai.pages.dev">Launch your own shill campaign →</a>',
    `<a href="${CALLOUT_JOIN_URL}">📢 Join PoorBoy Callz for more gems</a>`,
  );
  return lines.join('\n');
}

async function fetchTokenImageUrl(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data?.pairs ?? [];
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return best?.info?.imageUrl ?? null;
  } catch { return null; }
}

/** fireGroupCallout: card to the configured channel, photo when available
 *  (a photo failure degrades to the text card, the source's fallback). */
async function fireGroupCallout(campaign, imageRef) {
  const channelId = await getCalloutChannelId();
  if (!channelId) return false;
  const html = buildCalloutCard(campaign, 'free');
  if (imageRef) {
    try {
      await api.sendPhoto({ chat_id: channelId, photo: imageRef, caption: html.slice(0, 1024), parse_mode: 'HTML' });
      return true;
    } catch { /* fall through to the text card */ }
  }
  await api.sendMessage({
    chat_id: channelId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
  });
  return true;
}

// fireAutoCallout — the restored Replit hook's send side (callout-auto wave,
// 2026-10-30). Unlike fireGroupCallout (manual path, tier stamped 'free'),
// the auto post carries the subscriber's REAL tier. Returns true when posted,
// false when the channel is unconfigured. Send failures propagate to the
// caller, which must never fail the campaign save on them.
export async function fireAutoCallout(cardFields, tier) {
  const channelId = await getCalloutChannelId();
  if (!channelId) return false;
  const html = buildCalloutCard(cardFields, tier);
  const imageRef = cardFields.contract_address
    ? await fetchTokenImageUrl(cardFields.contract_address)
    : null;
  if (imageRef) {
    try {
      await api.sendPhoto({ chat_id: channelId, photo: imageRef, caption: html.slice(0, 1024), parse_mode: 'HTML' });
      return true;
    } catch { /* fall through to the text card */ }
  }
  await api.sendMessage({
    chat_id: channelId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
  });
  return true;
}

// /setcalloutchannel — owner-only. The source's copy told owners to run
// this inside the callout group, but the command was never registered
// there (the id was set by hand in admin_settings). Implemented here so
// the documented flow works: run it in the channel/group to point
// PoorBoy Callz at that chat.
async function setcalloutchannel(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    // W4 refusal polish (Class B): non-owners get the uniform line.
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  if (msg.chat.type === 'private') {
    await sendSafe(chatId, 'ℹ️ Run /setcalloutchannel inside the PoorBoy Callz channel (or the group it posts to).');
    return;
  }
  await setConfig('callout_channel_id', String(chatId));
  await sendSafe(chatId, `✅ PoorBoy Callz channel set to this chat (\`${chatId}\`).\n\n/calloutnow in any group now publishes here, and /testcallout sends a test card.`);
}

// /calloutnow (source :15806) — group admins; publishes the group's
// featured token to PoorBoy Callz.
async function calloutnow(chatId, args, msg) {
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (!isGroup) { await sendSafe(chatId, 'ℹ️ /calloutnow only works in groups.'); return; }
  if (!msg.from || !(await isChatAdmin(chatId, msg.from.id))) {
    await sendSafe(chatId, '🔒 Only admins can publish to PoorBoy Callz.');
    return;
  }
  const s = await getGroupSettings(chatId);
  const gt = s.tokenAddress ? { address: s.tokenAddress, label: s.tokenLabel ?? null } : null;
  if (!gt) {
    await sendSafe(chatId, '⚠️ No featured token set.\n\nSet one first:\n/settoken <contract address>\nThen run /calloutnow to publish.');
    return;
  }
  const parts = String(args ?? '').split('|').map((x) => x.trim());
  const desc = parts[0] || null;
  const website = parts[1] || null;
  const tgHandle = parts[2] ? parts[2].replace(/^@/, '') : null;
  const discord = parts[3] || null;

  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  let token = null;
  try { token = await fetchTokenByAddress(gt.address); } catch { token = null; }

  let imageRef = null;
  const replyPhoto = msg.reply_to_message?.photo;
  if (replyPhoto?.length) imageRef = replyPhoto[replyPhoto.length - 1]?.file_id ?? null;
  else imageRef = await fetchTokenImageUrl(gt.address);

  const fmtN = (n) => {
    if (!n) return null;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };
  const fmtP = (n) => {
    if (!n) return null;
    if (n < 0.0001) return `$${n.toFixed(8)}`;
    if (n < 1) return `$${n.toFixed(6)}`;
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  };

  const campaign = {
    project_name: token?.name ?? gt.label ?? gt.address.slice(0, 10),
    ticker: token?.symbol ?? '???',
    description: desc,
    contract_address: gt.address,
    website,
    telegram_username: tgHandle ?? (msg.chat.username ?? null),
    discord_invite: discord,
    price: token ? fmtP(token.priceUsd) : null,
    market_cap: token ? fmtN(token.marketCap) : null,
    change_24h: token ? `${token.change24h >= 0 ? '+' : ''}${Number(token.change24h ?? 0).toFixed(2)}%` : null,
    volume_24h: token ? fmtN(token.volume24h) : null,
    chain: token ? 'Base' : null,
    dexscreener_url: `https://dexscreener.com/base/${gt.address}`,
  };

  const channelId = await getCalloutChannelId();
  if (!channelId) {
    await sendSafe(chatId, '⚠️ PoorBoy Callz channel not configured yet.\nAsk the owner to run /setcalloutchannel first.');
    return;
  }
  try {
    await fireGroupCallout(campaign, imageRef);
    await sendSafe(chatId,
      `📢 *Published to PoorBoy Callz!*\n\n🪙 ${campaign.project_name} ($${campaign.ticker})\n📋 CA: \`${gt.address}\`\n\nYour token is now live in the discovery channel! 🚀\n\n💡 Tip: Reply to a token image + /calloutnow to include a photo`);
  } catch (e) {
    await sendSafe(chatId, "⚠️ *Callout failed.* The PoorBoy Callz channel couldn't be reached. The owner may need to re-run /setcalloutchannel inside the callout group.");
  }
}

// /testcallout (source :16125) — owner-only. Test card = $PBAI,
// agency label tier (the source's 'whale'), live Discord invite (the
// source's 8a8chu3da invite is dead; Jk2tzNphr6 is the live one).
async function testcallout(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    // W4 refusal polish (Class B): non-owners get the uniform line.
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  const channelId = await getCalloutChannelId();
  if (!channelId) {
    await sendMd(chatId, '⚠️ *No callout channel configured.*\n\nUse /setcalloutchannel inside the PoorBoy Callz channel first.');
    return;
  }
  const testCampaign = {
    project_name: 'PoorBoyAI',
    ticker: 'PBAI',
    description: 'The most feature-rich AI crypto shill bot on Telegram. No presale. No team bag. Just grind.',
    contract_address: PBAI_CA,
    website: 'https://poorboyai.pages.dev',
    telegram_username: 'PoorBoyAI_bot',
    discord_invite: 'https://discord.gg/Jk2tzNphr6',
    verified_ca: PBAI_CA,
  };
  try {
    await api.sendMessage({
      chat_id: channelId, text: buildCalloutCard(testCampaign, 'agency'),
      parse_mode: 'HTML', disable_web_page_preview: true,
    });
    await sendMd(chatId, `✅ Test callout card sent to channel \`${channelId}\`.`);
  } catch (e) {
    await sendSafe(chatId, `❌ Failed: ${e?.message ?? e}`);
  }
}

// /testbuy (source :16156) — owner-only. Fires the mock buy alert
// into the current chat in the live buy-alert shape (the tick's
// buildBuyAlert format): [TEST] header, the source's buyBar, the source's
// mock numbers, Chart/Buy/TX buttons. Photo = the token image when
// DexScreener has one, else the text card (the source's photo fallback).
async function testbuy(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    // W4 refusal polish (Class B): non-owners get the uniform line.
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  const mockUsd = 420.69;
  const mockTokAmt = 12_500_000;
  const mockBuyer = '0x1a21fac572791834c8b3deedc918467a8f3ec8ad';
  const mockTxHash = '0xdeadbeef1337c0ffeebabe00000000000000000000000000000000000000001';
  const mockPrice = 0.00000034;
  const mockMcap = 42000;
  const buyBar = (usd) => {
    const stops = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];
    let filled = stops.filter((s) => usd >= s).length;
    filled = Math.max(1, filled);
    return '🟩'.repeat(filled) + '⬜'.repeat(stops.length - filled);
  };
  const fmtUsd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtTok = (n) => n.toLocaleString('en-US');
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const caption = [
    '🟢 <b>NEW BUY — $PBAI</b> <i>[TEST]</i>',
    '',
    buyBar(mockUsd),
    '',
    `💵 Spent: ~<b>${fmtUsd(mockUsd)}</b>`,
    `🪙 Got: <b>${fmtTok(mockTokAmt)} $PBAI</b>`,
    `💰 Price: <b>$${mockPrice.toFixed(8)}</b>`,
    `📊 Mkt Cap: <b>${fmtUsd(mockMcap)}</b>`,
    '',
    `👤 <a href="https://basescan.org/address/${mockBuyer}">${short(mockBuyer)}</a> · 🔵 Base`,
    '',
    '🤖 <b>PoorBoyAI</b> — AI crypto marketing · @PoorBoyAI_bot',
  ].join('\n');
  const buttons = {
    inline_keyboard: [[
      { text: '📊 Chart', url: `https://dexscreener.com/base/${PBAI_CA}` },
      { text: '🛒 Buy', url: `https://ape.store/refer/4Ah6P69TEESczvFfL53S9g/8453/${PBAI_CA}` },
      { text: '🔗 TX', url: `https://basescan.org/tx/${mockTxHash}` },
    ]],
  };
  try {
    const imageUrl = await fetchTokenImageUrl(PBAI_CA);
    if (imageUrl) {
      await api.sendPhoto({ chat_id: chatId, photo: imageUrl, caption, parse_mode: 'HTML', reply_markup: buttons });
    } else {
      await api.sendMessage({ chat_id: chatId, text: caption, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: buttons });
    }
    await sendMd(chatId, '✅ *Test buy alert fired!*\n_This is how it looks when someone buys $PBAI._');
  } catch (e) {
    console.error('[/testbuy]', e?.message ?? e);
    await sendSafe(chatId, `❌ Failed: ${e?.message ?? e}`);
  }
}

// ── /supportrecap (source :20999) — owner-only ────────────────────────────

async function supportrecap(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    // W4 refusal polish (Class B): non-owners get the uniform line.
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  const sessions = await listSupportSessions(15);
  if (!sessions.length) {
    await sendMd(chatId, '📋 *Support Recap*\n\nNo active support sessions yet.');
    return;
  }
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  const lines = sessions.map((s, i) => {
    const who = s.username ? `@${s.username}` : (s.firstName ?? `User ${s.userId}`);
    const ago = Math.max(0, Math.round((Date.now() - (s.lastActivity ?? Date.now())) / 60000));
    const userMsgs = (s.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text).join(' → ');
    return `Session ${i + 1}: ${who} (${ago}m ago)\n${userMsgs.slice(0, 300)}`;
  }).join('\n\n');
  let summary = null;
  try {
    summary = await askLLM({
      systemPrompt: `You are summarizing recent support tickets for the admin (the owner of PoorBoyAI). Be concise and actionable.
For each session: who the user is, their issue in one sentence, and whether it looks resolved or needs admin attention.
Format as a clean numbered list. Max 500 words. No preamble.`,
      userMessage: `Recent support sessions:\n\n${lines}`,
      tier: 'chat', maxOutputTokens: 1200,
    });
  } catch (e) {
    console.error('[supportrecap]', e?.message ?? e);
  }
  await sendMd(chatId, summary
    ? `📋 *Support Recap* (${sessions.length} session${sessions.length !== 1 ? 's' : ''})\n\n${summary}\n\n_Use /supportrecap anytime to refresh._`
    : `📋 *Support Recap* (${sessions.length} session${sessions.length !== 1 ? 's' : ''})\n\n${lines}\n\n_(AI summary unavailable — raw sessions above.)_`);
}

// ── LaunchPad kit — announcement + registry (kit-build wave 1, 2026-10-31) ──
// Spec: goal hidden_files/PB-LAUNCH-KIT-SPEC-2026-10-30.md §1; Q1–Q8 decided.
// DEDUPE DESIGN (one card per surface, never a double-post):
// - Auto-callout (campaigns.js saveOwnCampaign hook) posts to @poorboycallz
//   once per contract, keyed `base:<lowercase>` in config
//   `callout_posted_contracts`. This module reads/writes that SAME key
//   directly — it must NOT import campaigns.js (campaigns.js imports this
//   module for fireAutoCallout, so an import would cycle).
// - lpListings (market.js runLpListingPass) posts to home only, keyed by
//   lpCoinKey in config `lp_announced`. The board's chain strings are the
//   worker's chain keys (`base_sepolia` / `base`, underscore form), so the
//   lp key here is built from those, not from the kit chain form.
// - Kit launch announcement therefore: skip callz if the callout key is
//   present; skip home if the lp key is present; ads always posts (no
//   other announcer posts kit launches to ads). After sending, mark both
//   keys for the surfaces it covered, so later announcers skip. The
//   registry's announcedAt/graduatedAt flags make every fire idempotent.
// - Graduation announcements dedupe on graduatedAt only: a graduation post
//   is new information, not a duplicate of the launch card.
// Pricing (Q1, record only — no sale path exists yet, nothing charges):
// Starter-or-above tiers launch for $1 WITH the kit; free tier / anybody
// else launches WITH the kit for $25 all-in (launch + kit, not $25 + $1).
export const KIT_PRICING = { tierLaunchUsd: 1, openLaunchUsd: 25 };
export const KIT_ADS_CHANNEL_ID = '-1003703317130'; // Official PoorBoyAI ADs Channel (override: config kit_ads_channel_id)
export const KIT_BUY_PAGE_BASE = 'https://redesign-preview.poorboyai.pages.dev/buy/token';
export const KIT_LOCKER_SEPOLIA = '0x93671ACcDe20934725d007e9179D13b6652d93CD'; // Sepolia locker (public, known)
export const KIT_CALLOUT_POSTED_KEY = 'callout_posted_contracts'; // shared with campaigns.js by key name, not import (see above)
export const KIT_COINS_KEY = 'kit_coins';

/** Kit chain form: `base-sepolia` | `base`. Worker/board form uses `_`. */
export function kitNormChain(chain) {
  return String(chain ?? '').toLowerCase().replace(/_/g, '-');
}
/** Board/lp_announced key form for a kit coin, via the shared lpCoinKey
 *  (single-sourced: the board's chain strings are `base_sepolia` / `base`). */
export function kitLpKey(coin) {
  const chain = kitNormChain(coin?.chain) === 'base' ? 'base' : 'base_sepolia';
  return lpCoinKey({ chain, tokenAddress: String(coin?.contract ?? '').trim() });
}
/** Auto-callout key form for a kit coin (`base:0x…` — chain is never sol). */
export function kitCalloutKey(coin) {
  return `base:${String(coin?.contract ?? '').trim().toLowerCase()}`;
}
/** Coin page link for a kit coin (preview buy page; kit=1 reveals the §2.2 disclosure block). */
export function kitCoinPageUrl(coin) {
  const ca = encodeURIComponent(String(coin?.contract ?? '').trim());
  const sym = String(coin?.symbol ?? '').trim();
  return `${KIT_BUY_PAGE_BASE}/?ca=${ca}&chain=base${sym ? `&symbol=${encodeURIComponent(sym)}` : ''}&kit=1`;
}

export async function readKitCoins() {
  try {
    const raw = await getConfig(KIT_COINS_KEY, '[]');
    const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function writeKitCoins(coins) {
  await setConfig(KIT_COINS_KEY, JSON.stringify(coins));
}
export function findKitCoin(coins, contract, chain) {
  const lc = String(contract ?? '').trim().toLowerCase();
  const nc = chain ? kitNormChain(chain) : null;
  return (coins || []).find((c) => String(c.contract ?? '').toLowerCase() === lc
    && (!nc || kitNormChain(c.chain) === nc)) ?? null;
}

// ── Q8 screening: impersonation / scam-copy only, no quality judgment ─────
// First-pass automated screening, not a human verdict. Rejects: empty
// name/symbol; PB-brand name/symbol; "official <other-name>" claims;
// hype/claim phrases; pasted 0x addresses in the description (§1.1: the
// coin page is the buy path, pasted addresses are a scam vector);
// profit-share/dividend phrases (regulated-security language).
const KIT_BRAND_NAMES = new Set(['poorboyai', 'pbai']);
const KIT_BLOCKED_RES = [
  /guaranteed buyers/i, /guaranteed returns/i, /will moon/i,
  /profit share/i, /dividends? paid/i,
];
const KIT_ADDR_RE = /0x[0-9a-fA-F]{40}/;
export function screenKitCopy({ name, symbol, description }) {
  const n = String(name ?? '').trim();
  const s = String(symbol ?? '').trim();
  const d = String(description ?? '');
  if (!n || !s) return { ok: false, reason: 'name and symbol are required' };
  const brand = (x) => KIT_BRAND_NAMES.has(String(x).toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (brand(n) || brand(s)) return { ok: false, reason: 'name/symbol matches a PoorBoyAI brand (impersonation screen)' };
  const off = d.match(/official\s+([A-Za-z0-9][A-Za-z0-9 ._-]{1,60})/i);
  if (off) {
    // "Official <own name>" (optionally + coin/token/project) passes; any
    // other official claim fails. Note "Dogecoin" does NOT pass for a coin
    // named "Dog" — it is a different project's name, not "Dog coin".
    const cap = String(off[1]).trim().toLowerCase();
    const nLower = n.toLowerCase();
    const own = cap === nLower || cap === `${nLower} coin` || cap === `${nLower} token` || cap === `${nLower} project`;
    if (!own) return { ok: false, reason: 'description claims an official status for another project' };
  }
  for (const re of KIT_BLOCKED_RES) {
    if (re.test(d) || re.test(n)) return { ok: false, reason: `blocked claim phrase (${re.source})` };
  }
  if (KIT_ADDR_RE.test(d)) return { ok: false, reason: 'description pastes an address — the coin page is the buy path' };
  return { ok: true, reason: null };
}

// ── Announcement templates: fixed, facts only ─────────────────────────────
// No hype, no buyer/volume/price claims, no endorsement, no wallet address
// as text (addresses appear ONLY inside URLs: the coin page link, the
// Basescan locker link). One call to action: the coin page link.
export function buildKitLaunchText(coin) {
  const lines = [`🚀 New on PB LaunchPad — ${coin.name} ($${coin.symbol})`, ''];
  if (coin.description) lines.push(String(coin.description).slice(0, 200), '');
  lines.push(
    'Launch facts: Base chain · bonding curve live · graduation at 4.2 ETH.',
    'How the money works: at graduation, 90% of the pool is LOCKED for 180 days; the creator’s 10% slice is UNLOCKED — the creator can collect its fees or pull it out any time.',
    'The creator started with zero tokens.',
    '',
    `🔗 ${kitCoinPageUrl(coin)}`,
    '',
    'Not an endorsement, not a promise of buyers, volume, or price.',
  );
  return lines.join('\n');
}
export function buildKitGraduationText(coin, { lockerUrl = null } = {}) {
  const lines = [
    `🎓 ${coin.name} ($${coin.symbol}) graduated off the bonding curve — now trading on a pool.`,
    '',
    'How the money works, disclosed again: 90% of the pool is LOCKED for 180 days; the creator’s 10% slice is UNLOCKED.',
  ];
  if (lockerUrl) lines.push('', `🔒 Lock proof: ${lockerUrl}`);
  lines.push('', `🔗 ${kitCoinPageUrl(coin)}`);
  return lines.join('\n');
}

// ── Announcement sender (per-surface dedupe, per-surface failure) ──────────
async function kitSend(chatId, text) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
    return true;
  } catch { return false; }
}
async function readCalloutPosted() {
  try {
    const raw = await getConfig(KIT_CALLOUT_POSTED_KEY, '[]');
    const arr = Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
async function markCalloutPosted(key) {
  try {
    const s = await readCalloutPosted();
    s.add(key);
    await setConfig(KIT_CALLOUT_POSTED_KEY, JSON.stringify([...s]));
  } catch { /* dedupe mark is best-effort; the flag below still guards re-fire */ }
}
async function readLpAnnounced() {
  try {
    const raw = await getConfig('lp_announced', '{}');
    const v = raw && typeof raw === 'object' ? raw : JSON.parse(String(raw ?? '{}'));
    return (v && typeof v === 'object') ? v : {};
  } catch { return {}; }
}
async function markLpAnnounced(key) {
  try {
    const m = await readLpAnnounced();
    m[key] = { at: Math.floor(Date.now() / 1000) };
    await setConfig('lp_announced', JSON.stringify(m));
  } catch { /* same best-effort note as above */ }
}
async function kitHomeChatId() {
  try { return String((await getConfig('TELEGRAM_HOME_CHAT_ID', '')) ?? '').trim() || null; } catch { return null; }
}
async function kitAdsChannelId() {
  try { return String((await getConfig('kit_ads_channel_id', '')) ?? '').trim() || KIT_ADS_CHANNEL_ID; } catch { return KIT_ADS_CHANNEL_ID; }
}
export function kitLockerUrl(coin) {
  // Sepolia locker is public and known. Mainnet locker is not configured
  // (mainnet launch gated) — no link is claimed there, only the coin page.
  return kitNormChain(coin?.chain) === 'base-sepolia'
    ? `https://sepolia.basescan.org/address/${KIT_LOCKER_SEPOLIA}`
    : null;
}

/**
 * Fire a kit announcement. kind 'launch' | 'graduation'. Returns
 * { sent: {callz, ads, home}, skipped: {callz, home} }. Idempotent: the
 * caller (register / webSync hook) sets announcedAt/graduatedAt, and this
 * function never re-sends for a flagged coin — callers check the flag first.
 * A failed surface is reported, never retried here; the flag is set only
 * when at least one surface posted, so a total failure retries next trigger.
 */
export async function fireKitAnnouncement(coin, kind = 'launch') {
  const text = kind === 'graduation'
    ? buildKitGraduationText(coin, { lockerUrl: kitLockerUrl(coin) })
    : buildKitLaunchText(coin);
  const sent = { callz: false, ads: false, home: false };
  const skipped = { callz: false, home: false };
  if (kind === 'launch') {
    const posted = await readCalloutPosted();
    const lp = await readLpAnnounced();
    const callz = await getCalloutChannelId();
    const ads = await kitAdsChannelId();
    const home = await kitHomeChatId();
    if (callz && !posted.has(kitCalloutKey(coin))) {
      sent.callz = await kitSend(callz, text);
      if (sent.callz) await markCalloutPosted(kitCalloutKey(coin));
    } else if (callz) skipped.callz = true;
    if (ads) sent.ads = await kitSend(ads, text);
    const lpKey = kitLpKey(coin);
    if (home && !lp[lpKey]) {
      sent.home = await kitSend(home, text);
      if (sent.home) await markLpAnnounced(lpKey);
    } else if (home) skipped.home = true;
  } else {
    const callz = await getCalloutChannelId();
    const ads = await kitAdsChannelId();
    const home = await kitHomeChatId();
    if (callz) sent.callz = await kitSend(callz, text);
    if (ads) sent.ads = await kitSend(ads, text);
    if (home) sent.home = await kitSend(home, text);
  }
  return { sent, skipped };
}

// ── Registry + owner commands ───────────────────────────────────────────────
/**
 * Register a kit coin (owner-only command path; the sale path does not exist
 * yet, so registration is the claim step). Re-registering an existing
 * contract updates its fields but NEVER re-announces. Returns
 * { coin, announcement, already } — announcement is null when the coin was
 * already announced or when this call only updated fields.
 */
export async function registerKitCoin({ contract, name, symbol, chain, community, description, by }) {
  const clean = String(contract ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(clean)) return { ok: false, reason: 'contract must be a 0x address' };
  const screen = screenKitCopy({ name, symbol, description });
  if (!screen.ok) return { ok: false, reason: screen.reason };
  const coins = await readKitCoins();
  const prev = findKitCoin(coins, clean, chain);
  if (prev) {
    prev.name = String(name).trim();
    prev.symbol = String(symbol).trim();
    prev.description = String(description ?? '').slice(0, 500);
    if (community !== undefined) prev.community = community || null;
    await writeKitCoins(coins);
    return { ok: true, coin: prev, announcement: null, already: true };
  }
  const coin = {
    contract: clean,
    name: String(name).trim(),
    symbol: String(symbol).trim(),
    chain: kitNormChain(chain) === 'base' ? 'base' : 'base-sepolia',
    community: community || null,
    description: String(description ?? '').slice(0, 500),
    registeredAt: Math.floor(Date.now() / 1000),
    registeredBy: by ?? null,
    announcedAt: null,
    graduatedAt: null,
  };
  coins.push(coin);
  await writeKitCoins(coins);
  const announcement = await fireKitAnnouncement(coin, 'launch');
  if (announcement.sent.callz || announcement.sent.ads || announcement.sent.home) {
    coin.announcedAt = Math.floor(Date.now() / 1000);
    await writeKitCoins(coins);
  }
  return { ok: true, coin, announcement, already: false };
}

/** webSync hook: lp_launch / lp_graduated for a registered kit coin. Never throws. */
export async function kitAnnounceFromLpEvent({ type, tokenAddress, chain }) {
  try {
    if (type !== 'lp_launch' && type !== 'lp_graduated') return null;
    const coins = await readKitCoins();
    const coin = findKitCoin(coins, tokenAddress, chain);
    if (!coin) return null;
    if (type === 'lp_launch') {
      if (coin.announcedAt) return { skipped: 'already-announced' };
      const announcement = await fireKitAnnouncement(coin, 'launch');
      if (announcement.sent.callz || announcement.sent.ads || announcement.sent.home) {
        coin.announcedAt = Math.floor(Date.now() / 1000);
        await writeKitCoins(coins);
      }
      return { kind: 'launch', announcement };
    }
    if (coin.graduatedAt) return { skipped: 'already-graduated' };
    const announcement = await fireKitAnnouncement(coin, 'graduation');
    if (announcement.sent.callz || announcement.sent.ads || announcement.sent.home) {
      coin.graduatedAt = Math.floor(Date.now() / 1000);
      await writeKitCoins(coins);
    }
    return { kind: 'graduation', announcement };
  } catch { return null; }
}

async function kitregister(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  // /kitregister <contract> | <name> | <symbol> | <chain: base-sepolia|base> | <community link or -> | <description>
  const parts = String(args ?? '').split('|').map((x) => x.trim());
  const [contract, name, symbol, chain, community, description] = parts;
  if (!contract || !name || !symbol) {
    await sendSafe(chatId, 'ℹ️ Usage: /kitregister <contract> | <name> | <symbol> | <chain> | <community link or -> | <description>\nChain defaults to base-sepolia. No community link means the raid slot is VOID (told here, upfront — it can never be banked or swapped).');
    return;
  }
  const r = await registerKitCoin({
    contract, name, symbol,
    chain: chain || 'base-sepolia',
    community: community && community !== '-' ? community : null,
    description: description ?? '',
    by: String(msg.from.id),
  });
  if (!r.ok) { await sendSafe(chatId, `⚠️ Kit registration refused: ${r.reason}`); return; }
  const a = r.announcement;
  const sentList = a ? Object.entries(a.sent).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none (all surfaces skipped or failed)' : 'already announced — fields updated, no re-send';
  const skipList = a ? Object.entries(a.skipped).filter(([, v]) => v).map(([k]) => `${k} (already covered)`).join(', ') : '';
  await sendSafe(chatId, `✅ Kit coin registered: ${r.coin.name} ($${r.coin.symbol}) — ${r.coin.chain}\n📣 Launch announcement: ${sentList}${skipList ? `\n⏭️ Skipped: ${skipList}` : ''}${!r.coin.community ? '\n⚠️ No community link: the raid slot is VOID for this coin (never banked, never swapped).' : ''}\n💰 Kit pricing (Q1): $1 with kit for Starter+ launches; $25 all-in otherwise. No sale path exists yet — this registration is the claim step.`);
}

async function kitlist(chatId, _args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  const coins = await readKitCoins();
  if (!coins.length) { await sendSafe(chatId, 'ℹ️ No kit coins registered yet.'); return; }
  const lines = ['🎒 Kit coins:', ''];
  for (const c of coins) {
    lines.push(`• ${c.name} ($${c.symbol}) — ${c.chain} — ${c.announcedAt ? 'announced' : 'not announced'}${c.graduatedAt ? ' · graduated' : ''}${c.community ? '' : ' · raid slot VOID'}`);
    lines.push(`  ${c.contract}`);
  }
  await sendSafe(chatId, lines.join('\n'));
}

// ── Kit raid slot commands (kit-build wave 4) ─────────────────────────────
async function kitraid(chatId, args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  // /kitraid <contract> | <window ISO start/end or assign> | <community link or ->
  const parts = String(args ?? '').split('|').map((x) => x.trim());
  const [contract, window, community] = parts;
  if (!contract || !window) {
    await sendSafe(chatId, 'ℹ️ Usage: /kitraid <contract> | <window start/end ISO or assign> | <community link or ->\n"assign" = PB picks booking+24h for 1 hour, collision-checked. Window max 2 hours. No community (here or on the coin) = slot VOID, told here upfront.');
    return;
  }
  const r = await bookKitRaidSlot({
    contract, chain: null,
    window, community: community && community !== '-' ? community : null,
    by: String(msg.from.id),
  });
  if (!r.ok) { await sendSafe(chatId, `⚠️ Raid slot refused: ${r.reason}`); return; }
  if (r.void) {
    await sendSafe(chatId, `⚠️ Raid slot VOID for ${r.slot.contract}: no community at claim time. It can never be banked or swapped for an ad.`);
    return;
  }
  await sendSafe(chatId, `✅ Raid slot booked: ${r.slot.contract}\n📍 ${r.slot.community}\n🕐 ${new Date(r.slot.windowStart).toISOString()} → ${new Date(r.slot.windowEnd).toISOString()} (${r.slot.assignedBy === 'pb' ? 'PB assigned' : 'creator picked'})\nMembers in the home community get the opt-in raid card when the window opens.`);
}

async function kitraidlist(chatId, _args, msg) {
  if (!msg.from || !(await isOwnerId(msg.from.id))) {
    if (msg.from) await sendSafe(chatId, '🔒 Owner only.');
    return;
  }
  const slots = await readKitRaidSlots();
  if (!slots.length) { await sendSafe(chatId, 'ℹ️ No kit raid slots booked yet.'); return; }
  const lines = ['⚔️ Kit raid slots:', ''];
  for (const s of slots) {
    const when = s.windowStart ? `${new Date(s.windowStart).toISOString()} → ${new Date(s.windowEnd).toISOString()}` : 'no window (VOID)';
    lines.push(`• ${s.contract} — ${s.status} — ${when}`);
    if (s.community) lines.push(`  ${s.community}`);
  }
  await sendSafe(chatId, lines.join('\n'));
}
