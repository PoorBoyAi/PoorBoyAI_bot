// PB group moderation + group-settings store on Telegram Serverless.
// Ports lib/group-manager.ts (in-memory semantics, now durable in the
// group_settings JSON column) and the mod helpers from
// artifacts/api-server/src/lib/telegram-community-bot.ts.
// Plain-text v1 (no MarkdownV2 escaping layer).

import { api, fetch } from 'sdk';
import db, { eq, and, lte, lt, gte, isNotNull, desc } from 'sdk/db';
import {
  bot_users, group_settings, group_free_chat, known_groups, user_activity_log,
  group_daily_rollup,
  group_whitelist, group_banned_words, portal_challenges,
  cross_protect_links, user_campaigns, user_campaign_slots, buy_events,
  buy_competitions, relay_rules, relay_rule_destinations,
  command_errors, llm_ledger, agent_runs, campaign_delivery_log,
  dm_broadcast_jobs, dm_broadcast_recipients, decision_log,
  master_spend_ledger, signal_inlet_log,
  shield_link_verdicts, shield_link_ownlist, shield_link_reports,
} from '../schema.js';
import { getConfig, setConfig, flagValueOn } from './config.js';
import { sha256Hex, hashKey, HASH_PREFIX } from './mcpkeys.js';
import { fetchVerdict } from './verdict.js'; // GoPlus reuse (/scan's path; verdict.js imports groups.js only for runtime-called cleanupNoteSent, never at eval — no TDZ cycle)

// ── Group settings store (one JSON object per chat) ─────────────────────────
// Keys used: fudshield, translate, sentiment_auto, tokenAddress, tokenLabel,
// welcomeMsg, welcomeEnabled, rules, notes {name: content}, filters [{keyword, reply}],
// warns {userId: {count, reasons}}, warnMax, bans {userId: {...}}, mutes {userId: {...}},
// portal, portal_timeout, anti_porn, anti_porn_action, alphabets, alphabets_action,
// ad_guard (F19 auto-ad guard, 2026-11-06; absent = off — warn-only, never deletes)
// (the /manage Phase-2 feature toggles, source: group_manage_settings JSON),
// portal_mode ('holder' | 'human' | 'both'; absent = 'holder', the Phase-2
// behavior), portal_welcome (custom challenge text), portal_banner_file_id +
// portal_banner_type ('photo' | 'animation' | 'video') — the Portal polish
// keys (2026-10-21), all optional: a group that never sets them behaves
// exactly as Phase 2 shipped,
// cross_protect (Phase 3 — the toggle half of Cross Protect; the link
// topology itself lives in the cross_protect_links table),
// buy_hourly (Buy Bot Phase 2 — the hourly in-group stats card toggle;
// absent = ON for campaign groups, OFF for the home group),
// milestones (Buy Bot Phase 3 direct lane — /milestones toggles the
// price-milestone celebrations the tick posts for this group;
// absent = ON, the pre-existing behavior),
// goodbyeMsg (E4a restore, 2026-10-21 — /setgoodbye; presence = on, fired
// on member leave, the welcome system's mirror),
// antifloodLimit / antifloodSeconds (E4a — /setflood; limit 0/absent =
// off, seconds default 10), autoVisionEnabled /
// autoVisionCooldownSeconds (E4a — /autoread; absent = off, 30s),
// supportMode (E4a — /setsupport; the support-agent takeover flag read by
// lib/groupmsg.js; the home support topic is always-on by rule there),
// shieldEnabled / shieldPhrases / shieldWatch / shieldStrikes /
// shieldImpersonated / shieldBurst / shieldLog (PB Shield, 2026-10-21 —
// the scam-bot protection block near the end of this file; every key is
// per-chat, absent = Shield off and fully inert),
// cleanupEnabled / cleanupTtlSec / cleanupService / cleanupPending /
// cleanupDeleted / cleanupPinned (PB Cleanup, 2026-10-22 — the group
// auto-tidy block at the end of this file; absent = Cleanup off),
// delegation { managers, grants } (Tier Delegation restore,
// 2026-10-22 — the block after resolveBuyCampaignForGroup; absent = no
// managers, no grants, no borrows in this group; the borrow LOG lives
// in its own config row `dlglog:<chatId>`, not here),
// signalInlet { enabled, secretHash, threadId, ratePerHour, hits,
// lastReceivedAt, createdBy, createdAt } (Signal Inlet, 2026-10-23 —
// the block at the end of this file; absent = no inlet in this group.
// The raw secret is NEVER stored — only its sha256:v1: hash).

export async function getGroupSettings(chatId) {
  try {
    const row = await db.select().from(group_settings)
      .where(eq(group_settings.chatId, String(chatId))).get();
    return row?.settings ?? {};
  } catch {
    return {};
  }
}

export async function setGroupSettings(chatId, patch) {
  const current = await getGroupSettings(chatId);
  const merged = { ...current, ...patch };
  await db.insert(group_settings)
    .values({ chatId: String(chatId), settings: merged })
    .onConflictDoUpdate({ target: group_settings.chatId, set: { settings: merged } })
    .run();
  return merged;
}

// ── Free-chat mode (source: isFreeChatGroup / setFreeChatGroup) ─────────────

export async function isFreeChatGroup(chatId) {
  try {
    const row = await db.select().from(group_free_chat)
      .where(eq(group_free_chat.chatId, String(chatId))).get();
    return row?.enabled === true;
  } catch {
    return false;
  }
}

export async function setFreeChatGroup(chatId, enabled) {
  await db.insert(group_free_chat)
    .values({ chatId: String(chatId), enabled: !!enabled })
    .onConflictDoUpdate({ target: group_free_chat.chatId, set: { enabled: !!enabled } })
    .run();
}

// ── Owner / protection (source: ownerTgIds / isProtected) ────────────────────
// v1: the bot owner(s), from TELEGRAM_OWNER_ID config, are protected from
// moderation actions. The source also carried a hardcoded protected list;
// v1 keeps this to the owner set only (documented in BUILD_NOTES).

export async function ownerIdSet() {
  const s = String(await getConfig('TELEGRAM_OWNER_ID', ''));
  return new Set(s.split(',').map((x) => x.trim()).filter(Boolean));
}

export async function isOwnerId(id) {
  return (await ownerIdSet()).has(String(id));
}

export async function isProtectedId(id) {
  if (await isOwnerId(id)) return true;
  const list = await listProtectedUsers();
  return list.some((u) => String(u.id) === String(id));
}

// ── Owner protected set (restore wave 1, 2026-10-25) ───────────────────────
// Replit /protect + /unprotect managed a GLOBAL protected_users list
// (owner-only, exempt from ban/kick/mute/warn). The v1 port kept only the
// owner set (see isProtectedId above); /wl is NOT equivalent — it is
// per-group, group-admin-managed, and its exemptions cover only the
// portal/alphabets/anti-porn checks. This restores the owner list in
// config (no schema change, no migrate): ban/kick/mute/warn already
// consult isProtectedId, so extending it wires the exemption through.
const PROTECTED_USERS_KEY = 'protected_users';

export async function listProtectedUsers() {
  try {
    const raw = await getConfig(PROTECTED_USERS_KEY, '[]');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((u) => u && u.id != null) : [];
  } catch { return []; }
}

export async function addProtectedUser(id, username) {
  const list = await listProtectedUsers();
  const sid = String(id);
  const next = list.filter((u) => String(u.id) !== sid);
  next.push({ id: sid, username: username ?? null });
  await setConfig(PROTECTED_USERS_KEY, JSON.stringify(next));
  return next;
}

export async function removeProtectedUser(idOrUsername) {
  const list = await listProtectedUsers();
  const key = String(idOrUsername).replace(/^@/, '').toLowerCase();
  const next = list.filter((u) => String(u.id) !== key && String(u.username ?? '').toLowerCase() !== key);
  const removed = next.length !== list.length;
  await setConfig(PROTECTED_USERS_KEY, JSON.stringify(next));
  return removed;
}

// ── Admin checks ────────────────────────────────────────────────────────────
// Source used granular Telegram permissions (can_restrict_members,
// can_change_info, ...). The Bot API only exposes the member status to a
// third-party check, so v1 approximates any admin/creator status as having
// mod rights (documented deviation in BUILD_NOTES).

export async function isChatAdmin(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    return ['administrator', 'creator'].includes(m?.status);
  } catch { return false; }
}

// ── Target resolution (source: getTarget) ────────────────────────────────────
// Priority: reply target → @username looked up in bot_users (username index).
// Deviation: the source also searched a group_members table we don't migrate in v1.

export async function getTarget(msg, argUsername) {
  const reply = msg.reply_to_message?.from;
  if (reply && !reply.is_bot) {
    return { id: reply.id, name: reply.first_name ?? reply.username ?? 'User' };
  }
  if (argUsername) {
    const clean = String(argUsername).replace(/^@/, '').toLowerCase();
    if (!clean) return null;
    try {
      const rows = await db.select().from(bot_users).all();
      const row = rows.find((r) => (r.username ?? '').toLowerCase() === clean);
      if (row) {
        return {
          id: Number(row.telegramUserId),
          name: row.firstName ?? row.username ?? clean,
        };
      }
    } catch { /* fall through */ }
    return null;
  }
  return null;
}

// ── Warns (source: group-manager addWarn/getWarns/resetWarns/getWarnMax) ─────

const DEFAULT_WARN_MAX = 3;

export async function getWarns(chatId, userId) {
  const s = await getGroupSettings(chatId);
  return s.warns?.[String(userId)] ?? { count: 0, reasons: [] };
}

export async function addWarn(chatId, userId, reason) {
  const s = await getGroupSettings(chatId);
  const warns = { ...(s.warns ?? {}) };
  const key = String(userId);
  warns[key] = warns[key] ?? { count: 0, reasons: [] };
  warns[key] = {
    count: warns[key].count + 1,
    reasons: [...warns[key].reasons, reason || 'No reason given'],
  };
  await setGroupSettings(chatId, { warns });
  return warns[key];
}

export async function resetWarns(chatId, userId) {
  const s = await getGroupSettings(chatId);
  const warns = { ...(s.warns ?? {}) };
  delete warns[String(userId)];
  await setGroupSettings(chatId, { warns });
}

export async function getWarnMax(chatId) {
  const s = await getGroupSettings(chatId);
  const n = Number(s.warnMax);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_WARN_MAX;
}

export async function setWarnMax(chatId, n) {
  await setGroupSettings(chatId, { warnMax: n });
}

// ── Notes (source: saveNote/getNote/deleteNote/listNotes) ────────────────────

export async function saveNote(chatId, name, content) {
  const s = await getGroupSettings(chatId);
  const notes = { ...(s.notes ?? {}) };
  notes[name.toLowerCase()] = content;
  await setGroupSettings(chatId, { notes });
}

export async function getNote(chatId, name) {
  const s = await getGroupSettings(chatId);
  return s.notes?.[name.toLowerCase()] ?? null;
}

export async function deleteNote(chatId, name) {
  const s = await getGroupSettings(chatId);
  const notes = { ...(s.notes ?? {}) };
  const key = name.toLowerCase();
  const existed = Boolean(notes[key]);
  delete notes[key];
  await setGroupSettings(chatId, { notes });
  return existed;
}

export async function listNotes(chatId) {
  const s = await getGroupSettings(chatId);
  return Object.keys(s.notes ?? {});
}

// ── Keyword filters (source: addFilter/removeFilter/getFilters/matchFilter) ──

export async function addFilter(chatId, keyword, reply) {
  const s = await getGroupSettings(chatId);
  const filters = (s.filters ?? []).filter(
    (f) => (f.keyword ?? '').toLowerCase() !== keyword.toLowerCase()
  );
  filters.push({ keyword: keyword.toLowerCase(), reply });
  await setGroupSettings(chatId, { filters });
}

export async function removeFilter(chatId, keyword) {
  const s = await getGroupSettings(chatId);
  const filters = (s.filters ?? []).filter(
    (f) => (f.keyword ?? '').toLowerCase() !== keyword.toLowerCase()
  );
  await setGroupSettings(chatId, { filters });
}

export async function getFilters(chatId) {
  const s = await getGroupSettings(chatId);
  return s.filters ?? [];
}

export async function matchFilter(chatId, text) {
  const lower = String(text).toLowerCase();
  for (const f of await getFilters(chatId)) {
    if (f.keyword && lower.includes(f.keyword)) return f.reply;
  }
  return null;
}

// ── Community bans / mutes log (source used DB tables community_bans /
// community_mutes; v1 keeps the audit log in the group settings JSON) ─────────

export async function logCommunityBan(chatId, target, byUser) {
  const s = await getGroupSettings(chatId);
  const bans = { ...(s.bans ?? {}) };
  bans[String(target.id)] = {
    username: target.username ?? null,
    name: target.name,
    by: byUser?.id ?? null,
    byName: byUser?.first_name ?? null,
    at: new Date().toISOString(),
  };
  await setGroupSettings(chatId, { bans });
}

export async function removeCommunityBan(chatId, userId) {
  const s = await getGroupSettings(chatId);
  const bans = { ...(s.bans ?? {}) };
  delete bans[String(userId)];
  await setGroupSettings(chatId, { bans });
}

export async function logCommunityMute(chatId, target, minutes, byUser) {
  const s = await getGroupSettings(chatId);
  const mutes = { ...(s.mutes ?? {}) };
  mutes[String(target.id)] = {
    username: target.username ?? null,
    name: target.name,
    minutes,
    by: byUser?.id ?? null,
    byName: byUser?.first_name ?? null,
    at: new Date().toISOString(),
  };
  await setGroupSettings(chatId, { mutes });
}

export async function removeCommunityMute(chatId, userId) {
  const s = await getGroupSettings(chatId);
  const mutes = { ...(s.mutes ?? {}) };
  delete mutes[String(userId)];
  await setGroupSettings(chatId, { mutes });
}

// ── Welcome messages (source: setWelcome/getSettings; fired on join) ─────────

function fillPlaceholders(text, member, chat) {
  return String(text)
    .replace(/\{name\}/g, member.first_name ?? 'friend')
    .replace(/\{username\}/g, member.username ? '@' + member.username : member.first_name ?? 'friend')
    .replace(/\{group\}/g, chat?.title ?? 'the group');
}

export async function fireWelcome(chatId, member, chat) {
  const s = await getGroupSettings(chatId);
  if (!s.welcomeEnabled || !s.welcomeMsg) return;
  try {
    await api.sendMessage({
      chat_id: chatId,
      text: fillPlaceholders(s.welcomeMsg, member, chat).slice(0, 4000),
    });
  } catch { /* welcome send failure never breaks the handler */ }
}

// ── Goodbye messages (E4a restore, 2026-10-21) ──────────────────────────────
// Source: /setgoodbye + /resetgoodbye (telegram-community-bot.ts:21748,
// 21763) and the left_chat_member send (:21143) over group-manager.ts's
// goodbyeMsg settings key. Presence of the key = on (no enabled flag in
// the source). Same storage idiom + placeholder filler as welcome above.

export async function fireGoodbye(chatId, member, chat) {
  const s = await getGroupSettings(chatId);
  if (!s.goodbyeMsg) return;
  try {
    await api.sendMessage({
      chat_id: chatId,
      text: fillPlaceholders(s.goodbyeMsg, member, chat).slice(0, 4000),
    });
  } catch { /* goodbye send failure never breaks the handler */ }
}

// ── "My groups" (source: getMyGroups/resolveMyGroup) ─────────────────────────
// v1: the groups where the user is an admin of a bot-known group, plus the
// home community for the owner (config TELEGRAM_HOME_CHAT_ID). The source
// also merged dashboard-linked groups via user_target_groups; that mapping
// returns when the dashboard is back.

export async function getMyGroupsFor(userId) {
  let rows = [];
  try { rows = await db.select().from(known_groups).all(); } catch { return []; }
  const homeId = await getConfig('TELEGRAM_HOME_CHAT_ID', '');
  const isOwner = await isOwnerId(userId);
  const groups = [];
  for (const g of rows) {
    if (String(g.chatId) === homeId && isOwner) {
      groups.push({ chatId: String(g.chatId), title: g.title ?? 'PoorBoyAI Community' });
      continue;
    }
    if (await isChatAdmin(g.chatId, userId)) {
      groups.push({ chatId: String(g.chatId), title: g.title ?? String(g.chatId) });
    }
  }
  return groups;
}

export async function resolveMyGroup(arg, userId) {
  const groups = await getMyGroupsFor(userId);
  if (!groups.length) return null;
  if (String(arg).startsWith('#')) {
    const idx = parseInt(String(arg).slice(1), 10) - 1;
    return groups[idx] ?? null;
  }
  return groups.find((g) => g.chatId === String(arg)) ?? null;
}

// ── /manage Phase 2 features (2026-10-20): Portal, Whitelist, Banned ────────
// Words, Anti-Porn, Alphabets — the interactive half of the original
// Group Manager (telegram-community-bot.ts :24157-25073). Everything is
// keyed by chatId; nothing crosses groups. Deliberate deviations from the
// source, each forced by the platform or already flagged in the brief:
// - Portal's kick timer was a setTimeout in the source; the isolate has
//   no timers, so challenges carry expires_at (unix seconds) and the
//   tick sweep (lib/tick.js portalSweep) removes expired members — up to
//   one tick late. The panel page says this out loud.
// - Anti-Porn delete_warn RECORDS the warn in the live warn store (the
//   source printed the warning but stored nothing); the notice shows the
//   real count, so repeat offenders reach the /warn max-ban path.
// - /wl by @username resolves through bot_users; the source stored
//   username-only rows with user_id 0 when it could not resolve. The live
//   port refuses an unknown @name instead of writing a dead row.
// - The portal challenge row stores no display name (schema per spec), so
//   the expiry notice resolves the name via getChatMember at sweep time
//   and falls back to a generic label.

async function homeChatId() {
  return String((await getConfig('TELEGRAM_HOME_CHAT_ID', '')) ?? '');
}

function tsMs(v) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : 0;
}

// getGMS equivalent: the source force-disabled Portal in the home group
// at READ time (telegram-community-bot.ts :24157). Kept exactly.
export async function getManageSettings(chatId) {
  const s = await getGroupSettings(chatId);
  if (String(chatId) === (await homeChatId())) return { ...s, portal: false };
  return s;
}

// ── Whitelist (source: group_whitelist + isWL :24177) ──────────────────────

export async function isWhitelisted(chatId, userId) {
  try {
    const row = await db.select().from(group_whitelist)
      .where(and(
        eq(group_whitelist.chatId, String(chatId)),
        eq(group_whitelist.userId, Number(userId)),
      )).get();
    return !!row;
  } catch { return false; }
}

export async function listWhitelist(chatId, limit = 8) {
  try {
    const rows = await db.select().from(group_whitelist)
      .where(eq(group_whitelist.chatId, String(chatId))).all();
    return rows
      .sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt))
      .slice(0, limit);
  } catch { return []; }
}

export async function addWhitelist(chatId, userId, username, addedBy) {
  await db.insert(group_whitelist)
    .values({
      chatId: String(chatId), userId: Number(userId),
      username: username ?? null, addedBy: addedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [group_whitelist.chatId, group_whitelist.userId],
      set: { username: username ?? null },
    })
    .run();
}

export async function removeWhitelist(chatId, userId) {
  await db.delete(group_whitelist)
    .where(and(
      eq(group_whitelist.chatId, String(chatId)),
      eq(group_whitelist.userId, Number(userId)),
    ))
    .run();
}

// ── Banned words (source: group_banned_words; commands :22417, ────────────
// enforcement :24952). Words are stored lowercased; phrases allowed.

export async function listBannedWords(chatId, limit = 10) {
  try {
    const rows = await db.select().from(group_banned_words)
      .where(eq(group_banned_words.chatId, String(chatId))).all();
    return rows
      .sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt))
      .slice(0, limit)
      .map((r) => r.word);
  } catch { return []; }
}

export async function addBannedWord(chatId, word, addedBy) {
  const w = String(word).trim().toLowerCase();
  if (!w) return;
  await db.insert(group_banned_words)
    .values({ chatId: String(chatId), word: w, addedBy: addedBy ?? null })
    .onConflictDoUpdate({
      target: [group_banned_words.chatId, group_banned_words.word],
      set: { addedBy: addedBy ?? null },
    })
    .run();
}

export async function removeBannedWord(chatId, word) {
  const w = String(word).trim().toLowerCase();
  const existed = (await listBannedWords(chatId, 1000)).includes(w);
  if (!existed) return false;
  await db.delete(group_banned_words)
    .where(and(
      eq(group_banned_words.chatId, String(chatId)),
      eq(group_banned_words.word, w),
    ))
    .run();
  return true;
}

// ── Portal (source: portal_challenges + join gate :24838) ──────────────────

// The source's exact permission objects (restrict :24842, restore :24184).
const PORTAL_PERMS_OFF = {
  can_send_messages: false, can_send_audios: false,
  can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
  can_change_info: false, can_invite_users: false,
  can_pin_messages: false,
};
const PORTAL_PERMS_ON = {
  can_send_messages: true, can_send_audios: true,
  can_send_documents: true, can_send_photos: true,
  can_send_videos: true, can_send_video_notes: true,
  can_send_voice_notes: true, can_send_polls: true,
  can_send_other_messages: true, can_add_web_page_previews: true,
  can_change_info: false, can_invite_users: false,
  can_pin_messages: false,
};

export function portalTimeoutOf(settings) {
  const n = Number(settings?.portal_timeout);
  return [30, 60, 120].includes(n) ? n : 60;
}

// Portal polish (2026-10-21): the verify mode. 'holder' is the Phase-2
// behavior and the default when the key is absent — the group tap
// unlocks, then PB offers the OPTIONAL $PBAI holder check in DM.
// 'human' is the tap alone (no holder DM at all). 'both' makes the tap
// step 1 of 2: access unlocks only when the holder check also passes.
export const PORTAL_MODES = ['holder', 'human', 'both'];
export function portalModeOf(settings) {
  const m = String(settings?.portal_mode ?? 'holder');
  return PORTAL_MODES.includes(m) ? m : 'holder';
}

// Custom welcome text cap: with a banner attached the text rides as the
// media caption (Telegram caps captions at 1024 chars), so the text plus
// PB's instruction suffix must fit under that in every combination.
export const PORTAL_WELCOME_MAX = 800;

export async function getPortalChallenge(chatId, userId) {
  try {
    return await db.select().from(portal_challenges)
      .where(and(
        eq(portal_challenges.chatId, String(chatId)),
        eq(portal_challenges.userId, Number(userId)),
      )).get();
  } catch { return undefined; }
}

export async function upsertPortalChallenge(chatId, userId, messageId, expiresAtSec) {
  // Delete-then-insert: the composite-PK upsert equivalent that behaves
  // identically on this SDK (source: INSERT ... ON CONFLICT DO UPDATE).
  // A fresh challenge always starts at stage 'verify' (step 1 pending).
  await deletePortalChallenge(chatId, userId);
  await db.insert(portal_challenges)
    .values({
      chatId: String(chatId), userId: Number(userId),
      messageId: messageId ?? null, expiresAt: Number(expiresAtSec),
      stage: 'verify',
    })
    .run();
}

// Portal polish: advance a challenge's stage ('verify' → 'holder' in
// portal_mode 'both' once the member taps in the group).
export async function setPortalChallengeStage(chatId, userId, stage) {
  await db.update(portal_challenges)
    .set({ stage: String(stage) })
    .where(and(
      eq(portal_challenges.chatId, String(chatId)),
      eq(portal_challenges.userId, Number(userId)),
    ))
    .run();
}

export async function deletePortalChallenge(chatId, userId) {
  await db.delete(portal_challenges)
    .where(and(
      eq(portal_challenges.chatId, String(chatId)),
      eq(portal_challenges.userId, Number(userId)),
    ))
    .run();
}

// Source: restoreTelegramChatAccess (:24184).
export async function restoreChatAccess(chatId, userId) {
  try {
    await api.restrictChatMember({
      chat_id: chatId, user_id: userId, permissions: PORTAL_PERMS_ON,
    });
    return true;
  } catch { return false; }
}

// Portal polish: compose the challenge text. A group with NO custom
// text gets the Phase-2 default byte-for-byte in every mode. With a
// custom text, {name} and {group} are substituted and PB appends its
// own instruction line — the admin's words brand the door, the
// instruction (incl. the real timeout) always stays PB's, so a custom
// text can never misstate how the gate works.
export async function buildPortalChallengeText(chatId, settings, member) {
  const timeout = portalTimeoutOf(settings);
  const mode = portalModeOf(settings);
  const name = member.first_name ?? 'there';
  const custom = String(settings?.portal_welcome ?? '').trim();
  if (!custom) {
    const base = `👋 Welcome, ${name}!\n\nTap the button below within ${timeout} seconds to verify you're not a bot and unlock the chat.`;
    // 'both' groups opted into a different flow, so their default text
    // says so — the tap alone does not unlock there. Holder/human
    // defaults stay byte-identical to Phase 2.
    if (mode === 'both') {
      return `${base}\n\n🔐 This group uses two-step verification: after the tap, PB sends you a $PBAI holder check in DM — both steps must finish within ${timeout} seconds.`;
    }
    return base;
  }
  const group = await manageGroupTitle(chatId);
  const body = custom.replaceAll('{name}', name).replaceAll('{group}', group);
  const suffix = mode === 'both'
    ? `Verification has two steps, and both must finish within ${timeout} seconds: tap the button below, then complete the $PBAI holder check PB sends to your DMs.`
    : `Tap the button below within ${timeout} seconds to verify you're not a bot and unlock the chat.`;
  return `${body}\n\n${suffix}`;
}

// Portal polish: post the challenge. With a banner set, the text rides
// as the media caption (sendPhoto / sendAnimation / sendVideo by the
// stored type). A stale or undeliverable file_id falls back to the
// plain text message — branding can never break the gate itself.
export async function sendPortalChallenge(chatId, settings, text, keyboard) {
  const fileId = String(settings?.portal_banner_file_id ?? '');
  const type = String(settings?.portal_banner_type ?? '');
  if (fileId && ['photo', 'animation', 'video'].includes(type)) {
    const method = { photo: 'sendPhoto', animation: 'sendAnimation', video: 'sendVideo' }[type];
    const field = { photo: 'photo', animation: 'animation', video: 'video' }[type];
    const sent = await api[method]({
      chat_id: chatId, [field]: fileId, caption: text.slice(0, 1024),
      reply_markup: keyboard,
    }).catch(() => null);
    if (sent) return sent;
  }
  return await api.sendMessage({
    chat_id: chatId, text, reply_markup: keyboard,
  }).catch(() => null);
}

// Join gate (source :24838): restrict → challenge message → challenge
// row. Home group and whitelisted members skip entirely.
export async function portalJoinHook(chatId, member) {
  try {
    if (String(chatId) === (await homeChatId())) return false;
    const s = await getManageSettings(chatId);
    if (s.portal !== true) return false;
    if (await isWhitelisted(chatId, member.id)) return false;
    const timeout = portalTimeoutOf(s);
    // The source swallowed a restrict failure and posted the challenge
    // anyway (.catch(() => {})); kept.
    await api.restrictChatMember({
      chat_id: chatId, user_id: member.id, permissions: PORTAL_PERMS_OFF,
    }).catch(() => {});
    const mode = portalModeOf(s);
    const text = await buildPortalChallengeText(chatId, s, member);
    const keyboard = { inline_keyboard: [[
      {
        text: mode === 'both' ? "✅ Step 1 of 2 — I'm Human" : "✅ I'm Human — Verify Me",
        callback_data: `portal_verify:${chatId}:${member.id}`,
      },
    ]] };
    const sent = await sendPortalChallenge(chatId, s, text, keyboard);
    await upsertPortalChallenge(
      chatId, member.id, sent?.message_id ?? null,
      Math.floor(Date.now() / 1000) + timeout,
    );
    return true;
  } catch { return false; }
}

// Tick sweep: expired, still-unverified challenges → kick (ban + unban,
// the source's setTimeout body :24874, moved to the clock). Per-row
// isolation: one bad row never blocks the rest.
export async function sweepExpiredPortalChallenges() {
  const nowSec = Math.floor(Date.now() / 1000);
  let rows = [];
  try {
    rows = await db.select().from(portal_challenges)
      .where(lte(portal_challenges.expiresAt, nowSec)).all();
  } catch { return 0; }
  let kicked = 0;
  for (const row of rows) {
    try {
      await api.banChatMember({ chat_id: row.chatId, user_id: row.userId }).catch(() => {});
      await api.unbanChatMember({
        chat_id: row.chatId, user_id: row.userId, only_if_banned: true,
      }).catch(() => {});
      if (row.messageId) {
        await api.deleteMessage({ chat_id: row.chatId, message_id: row.messageId }).catch(() => {});
      }
      await deletePortalChallenge(row.chatId, row.userId);
      let name = 'A new member';
      try {
        const m = await api.getChatMember({ chat_id: row.chatId, user_id: row.userId });
        if (m?.user?.first_name) name = m.user.first_name;
      } catch { /* member may already be gone — generic label */ }
      await api.sendMessage({
        chat_id: row.chatId,
        text: `⏰ ${name} didn't verify in time and was removed.`,
      }).catch(() => {});
      kicked += 1;
    } catch { /* next row */ }
  }
  return kicked;
}

// ── Portal polish: admin setup captures (welcome text + banner) ────────────
// The /manage Portal page arms a one-shot DM capture (the /bizsetup
// wizard pattern: a config key with a 5-minute TTL — the isolate has no
// session memory). The admin's next DM message is the value: plain text
// for the welcome text, a photo/GIF/video for the banner (the file_id
// is stored; Telegram serves it by reference on every challenge). The
// clicker's Change Info right is re-verified at CONSUME time, not just
// when the button was tapped — a capture armed before an admin change
// writes nothing.
const PORTAL_SETUP_TTL_MS = 5 * 60_000;
const portalSetupKey = (userId) => `portal_setupcap:${userId}`;

export async function armPortalSetupCapture(userId, grpId, kind) {
  await setConfig(portalSetupKey(userId), JSON.stringify({
    grpId: String(grpId), kind, createdAt: Date.now(),
  })).catch(() => {});
}

export async function clearPortalSetupCapture(userId) {
  await setConfig(portalSetupKey(userId), '').catch(() => {});
}

async function loadPortalSetupCapture(userId) {
  try {
    const raw = await getConfig(portalSetupKey(userId), '');
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.grpId || !['text', 'banner'].includes(s.kind)) return null;
    if (Date.now() - (s.createdAt ?? 0) > PORTAL_SETUP_TTL_MS) return null;
    return s;
  } catch { return null; }
}

// Extract a storable banner { file_id, type } from a message, or null.
// Photos arrive as a size ladder — the largest (last) is the banner.
export function portalBannerOf(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    const best = message.photo[message.photo.length - 1];
    if (best?.file_id) return { fileId: best.file_id, type: 'photo' };
  }
  if (message?.animation?.file_id) return { fileId: message.animation.file_id, type: 'animation' };
  if (message?.video?.file_id) return { fileId: message.video.file_id, type: 'video' };
  return null;
}

async function portalSetupRefuse(dmChatId, text) {
  try { await api.sendMessage({ chat_id: dmChatId, text }); } catch { /* DM may be closed */ }
}

// DM interceptor (handlers/message.js): while a portal setup capture is
// armed for this admin, their next DM message is the value. Returns
// true when the message was consumed (saved or refused) — plain text is
// consumed ONLY by a text capture, media ONLY by a banner capture, so
// an admin mid-capture can still talk to PB otherwise.
export async function handlePortalSetupCapture(dmChatId, message) {
  const userId = message?.from?.id;
  if (!userId) return false;
  const sess = await loadPortalSetupCapture(userId);
  if (!sess) return false;
  const banner = portalBannerOf(message);
  if (sess.kind === 'text') {
    const text = String(message?.text ?? '').trim();
    if (!text || text.startsWith('/') || banner) return false;
    await clearPortalSetupCapture(userId);
    if (!(await canChangeInfo(sess.grpId, userId))) {
      await portalSetupRefuse(dmChatId,
        '⛔ Portal setup cancelled: you no longer hold the Change Info permission in that group, so nothing was saved.');
      return true;
    }
    const value = text.slice(0, PORTAL_WELCOME_MAX);
    await setGroupSettings(sess.grpId, { portal_welcome: value });
    const title = await manageGroupTitle(sess.grpId);
    await portalSetupRefuse(dmChatId,
      `✅ Portal welcome text saved for ${title} (${value.length} characters).\n\nNew members will see your text first; PB adds the verify instruction and button under it. Preview or change it any time in /manage → Portal.`);
    return true;
  }
  // kind === 'banner'
  if (!banner) return false;
  await clearPortalSetupCapture(userId);
  if (!(await canChangeInfo(sess.grpId, userId))) {
    await portalSetupRefuse(dmChatId,
      '⛔ Portal setup cancelled: you no longer hold the Change Info permission in that group, so nothing was saved.');
    return true;
  }
  await setGroupSettings(sess.grpId, {
    portal_banner_file_id: banner.fileId, portal_banner_type: banner.type,
  });
  const title = await manageGroupTitle(sess.grpId);
  const label = { photo: 'photo', animation: 'GIF', video: 'video' }[banner.type];
  await portalSetupRefuse(dmChatId,
    `✅ Portal banner saved for ${title} (${label}).\n\nIt will ride on top of every new member's verification message in that group. Change or remove it any time in /manage → Portal.`);
  return true;
}

// ── /setrules DM fallback (restored) ─────────────────────────────────────────
// Source: telegram-community-bot.ts ~21783 — /setrules with NO args in a
// group armed a 10-minute DM capture instead of dead-ending at a usage
// line. The args path is unchanged (handlers/message.js writes directly).
// The original gated on can_change_info; the live /setrules command gate
// is adminGate (admin membership), so the consume re-check uses
// isChatAdmin — the live gate's own test — and the group fallback hint
// mirrors the original's DM-failure text.
const rulesCapKey = (userId) => `rulescap:${userId}`;
const RULES_CAP_TTL_MS = 10 * 60 * 1000;

export async function armSetRulesCapture(userId, grpId, title) {
  await setConfig(rulesCapKey(userId), JSON.stringify({
    grpId: String(grpId), title: title ?? 'your group',
    expiresAt: Date.now() + RULES_CAP_TTL_MS,
  })).catch(() => {});
}
export async function clearSetRulesCapture(userId) {
  await setConfig(rulesCapKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}
export async function loadSetRulesCapture(userId) {
  try {
    const raw = await getConfig(rulesCapKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.grpId) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

/** setrules:cancel — clears the armed capture. Returns { text, alert }. */
export async function handleSetRulesCancel(query) {
  const userId = query.from?.id;
  if (!userId) return null;
  await clearSetRulesCapture(userId);
  return { text: 'Rules update cancelled.' };
}

/** DM capture: the admin's next DM text becomes the group's rules. */
export async function handleSetRulesCapture(dmChatId, message) {
  const userId = message?.from?.id;
  if (!userId) return false;
  const text = String(message?.text ?? '');
  if (!text || text.startsWith('/')) return false;
  const { sess, expired } = await loadSetRulesCapture(userId);
  if (!sess) {
    if (expired) {
      await clearSetRulesCapture(userId);
      await api.sendMessage({
        chat_id: dmChatId,
        text: '⏰ That rules prompt expired (10 minutes). Run /setrules in the group again to restart.',
      }).catch(() => {});
      return true;
    }
    return false;
  }
  await clearSetRulesCapture(userId);
  if (!(await isChatAdmin(sess.grpId, userId).catch(() => false))) {
    await api.sendMessage({
      chat_id: dmChatId,
      text: `⛔ Rules NOT saved: you're no longer an admin of ${sess.title}.`,
    }).catch(() => {});
    return true;
  }
  await setGroupSettings(sess.grpId, { rules: text });
  await api.sendMessage({
    chat_id: dmChatId,
    text: `✅ Group rules updated for ${sess.title}. Members can read them with /rules.`,
  }).catch(() => {});
  return true;
}

// ── Alphabets (source :24896): join-time non-Latin name → admin note ───────
// NOTIFY ONLY — the source deliberately disabled automatic mutes/removals
// here; there is intentionally no enforcement action in this hook.
const NON_LATIN_NAME_RE = /[^\u0000-\u024F\s0-9\-'.,!?()]/u;

export async function alphabetsJoinHook(chatId, member) {
  try {
    if (String(chatId) === (await homeChatId())) return false;
    const s = await getGroupSettings(chatId);
    if (s.alphabets !== true) return false;
    if (await isWhitelisted(chatId, member.id)) return false;
    const fullName = `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim();
    if (!NON_LATIN_NAME_RE.test(fullName)) return false;
    await api.sendMessage({
      chat_id: chatId,
      text: `🔤 ${member.first_name ?? 'User'} has a non-Latin display name. No automatic mute or removal was applied — an owner/admin must review it.`,
    }).catch(() => {});
    return true;
  } catch { return false; }
}

// Both join gates for one new member; handlers/message.js calls this next
// to fireWelcome. Independent by design, like the source's two handlers.
export async function handleJoinGates(chatId, member) {
  await portalJoinHook(chatId, member);
  await alphabetsJoinHook(chatId, member);
}

// ── Message enforcement hooks (group path, handlers/message.js) ────────────

// The source's hard-coded caption keyword list, verbatim
// (telegram-community-bot.ts, anti-porn block ~:24940). Do not extend.
const NSFW_KEYWORDS = [
  'nude', 'naked', 'nsfw', 'porn', 'xxx', 'onlyfans', '18+', 'nudes',
  'sexy girls', 'hot girls', 'erotic', 'anal', 'pussy', 'cock', 'boobs',
  'deepthroat', 'cumshot', 'blowjob', 'sexting',
];

// Source :24940: media (photo/video/animation — the source's exact set)
// whose caption matches NSFW_KEYWORDS → delete + warn or delete + ban.
// Admins and whitelisted members are exempt. Returns true when the
// message was deleted.
export async function antiPornHook(chatId, msg) {
  try {
    const from = msg?.from;
    if (!from || from.is_bot) return false;
    // Media check first (cheap): a non-media message can never match.
    if (!(msg.photo || msg.video || msg.animation)) return false;
    const caption = String(msg.caption ?? '').toLowerCase();
    if (!caption || !NSFW_KEYWORDS.some((k) => caption.includes(k))) return false;
    const s = await getGroupSettings(chatId);
    if (s.anti_porn !== true) return false;
    if (await isChatAdmin(chatId, from.id)) return false;
    if (await isWhitelisted(chatId, from.id)) return false;
    const name = from.first_name ?? 'Member';
    try {
      await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id });
    } catch { /* source continued to the warn/ban even if delete failed */ }
    if (s.anti_porn_action === 'delete_ban') {
      await api.banChatMember({ chat_id: chatId, user_id: from.id }).catch(() => {});
      await api.sendMessage({
        chat_id: chatId,
        text: `🔞 ${name} was banned for posting NSFW content.`,
      }).catch(() => {});
    } else {
      const w = await addWarn(chatId, from.id, 'NSFW content (anti-porn)');
      const max = await getWarnMax(chatId);
      await api.sendMessage({
        chat_id: chatId,
        text: `⚠️ ${name} — NSFW content is not allowed here. Warning issued (${w.count}/${max}).`,
      }).catch(() => {});
    }
    return true;
  } catch { return false; }
}

// Source :24952: non-admin message whose text/caption contains a banned
// word (case-insensitive substring, words stored lowercased) → delete +
// notice. Admins exempt. Returns true when the message was deleted.
export async function bannedWordsHook(chatId, msg) {
  try {
    const from = msg?.from;
    if (!from || from.is_bot) return false;
    const text = String(msg.text ?? msg.caption ?? '');
    if (!text) return false;
    const words = await listBannedWords(chatId, 1000);
    if (!words.length) return false;
    const lower = text.toLowerCase();
    if (!words.some((w) => w && lower.includes(w))) return false;
    if (await isChatAdmin(chatId, from.id)) return false;
    try {
      await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id });
    } catch { return false; }
    await api.sendMessage({
      chat_id: chatId,
      text: `🚫 ${from.first_name ?? 'Member'} — your message was removed for containing a banned word.`,
    }).catch(() => {});
    return true;
  } catch { return false; }
}

// ── Auto-Ad Guard (F19, 2026-11-06 — Rowdy's order) ───────────────────────
// Rule (his words, 2026-11-06 ~23:40): in communities, advertising gets an
// automatic PB warning, third warning = a ban; advertisers can ask to be
// DM'd but no advertising in the community; only the community's own
// projects may be advertised. Rose (1/3 warning for a referral link) is
// the model. WARN-ONLY by order — no message is deleted, unlike
// anti-porn / banned-words. The hook NEVER consumes a message (returns
// false always): a warned message still flows to filters / translation /
// brain exactly as before.
//
// Detection definition (pure, harness-tested in isAdGuardHit): a message
// is advertising when it carries ANY of:
//  1. a referral/affiliate link — ?ref= ?referral= ?invite= ?aff=
//     ?affiliate= ?code=, or a /ref/ or /invite/ path segment;
//  2. a Telegram invite / other-bot link — t.me/<name>, t.me/joinchat/<…>,
//     t.me/+<…> — EXCEPT t.me/PoorBoyAI_bot (the bot itself);
//  3. a 0x contract address that is NOT the group's own tokenAddress.
// NOT flagged, deliberately: a plain external link with no referral
// marker (charts, X posts, news — groups live on shared links); a bare
// "DM me" solicitation (the rule makes asking for DMs the ALLOWED
// alternative, so the phrase itself must not trigger); a bare token name
// or ticker; Solana base58 addresses (no reliable pattern); the group's
// own token links (own-CA exemption applies ONLY to the CA signal — a
// message with the own CA AND a referral link / foreign CA / t.me invite
// still fires, so one own-token mention cannot launder an ad).
// Known gaps, named not hidden: plain-URL ads with no marker, text-only
// shills, Solana-CA shills, image-only ads with no caption text, and the
// group's OWN t.me/+ invite link (indistinguishable from another group's
// without a per-message API call — admins, who normally post invite
// links, are exempt). Default OFF (anti-porn precedent): per-group opt-in
// via /manage → 📢 Ad Guard (group_settings.ad_guard).

// Referral/affiliate markers in a URL query or path.
const AD_REF_RE = /[?&](ref|referral|invite|aff|affiliate|code)=|\/(ref|invite)\//i;
// Any t.me link (name, joinchat, +hash). Own-bot exemption applied per link.
const AD_TME_RE = /\bt\.me\/(\+?[A-Za-z0-9_][A-Za-z0-9_+\/.-]*)/gi;
const AD_CA_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const AD_OWN_BOT = 'poorboyai_bot';

function adTmePaths(hay) {
  const out = [];
  AD_TME_RE.lastIndex = 0;
  let m;
  while ((m = AD_TME_RE.exec(hay)) !== null) {
    out.push(String(m[1]).replace(/[^A-Za-z0-9_+]+$/, ''));
  }
  return out;
}

// Pure detection: text is the message text/caption, ownTokenAddress is the
// group's /settoken address (or null), entityUrls are masked-link URLs
// (msg.entities / caption_entities url fields). No I/O, no side effects.
export function isAdGuardHit(text, ownTokenAddress = null, entityUrls = []) {
  const hay = [String(text ?? ''), ...entityUrls.map((u) => String(u ?? ''))].join('\n');
  if (!hay.trim()) return false;
  if (AD_REF_RE.test(hay)) return true;
  const ownCa = /^0x[0-9a-fA-F]{40}$/.test(String(ownTokenAddress ?? '').trim())
    ? String(ownTokenAddress).trim().toLowerCase()
    : null;
  const cas = hay.match(AD_CA_RE) ?? [];
  if (cas.some((c) => c.toLowerCase() !== ownCa)) return true;
  const tme = adTmePaths(hay);
  if (tme.some((p) => p.split('/')[0].toLowerCase() !== AD_OWN_BOT)) return true;
  return false;
}

// Warn-only enforcement hook. Returns false ALWAYS (never consumes — see
// header). Warns count on the same /warns tally and the same max (3
// default) toward the auto-ban; reason 'Advertising (auto-ad guard)'.
export async function adGuardHook(chatId, msg) {
  try {
    const from = msg?.from;
    if (!from || from.is_bot) return false;
    const text = String(msg.text ?? msg.caption ?? '');
    const entityUrls = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
      .map((e) => e?.url).filter(Boolean);
    if (!text && !entityUrls.length) return false;
    const s = await getGroupSettings(chatId);
    if (s.ad_guard !== true) return false;
    if (!isAdGuardHit(text, s.tokenAddress ?? null, entityUrls)) return false;
    if (await isChatAdmin(chatId, from.id)) return false;
    if (await isWhitelisted(chatId, from.id)) return false;
    if (await isProtectedId(from.id)) return false;
    const name = from.first_name ?? 'Member';
    const w = await addWarn(chatId, from.id, 'Advertising (auto-ad guard)');
    const max = await getWarnMax(chatId);
    if (w.count >= max) {
      try {
        await api.banChatMember({ chat_id: chatId, user_id: from.id });
        await api.sendMessage({
          chat_id: chatId,
          text: `🔨 ${name} reached ${max} warnings and has been banned.`,
        }).catch(() => {});
      } catch {
        await api.sendMessage({
          chat_id: chatId,
          text: `⚠️ ${name} reached ${max} warnings (ban failed — check my admin rights).`,
        }).catch(() => {});
      }
    } else {
      await api.sendMessage({
        chat_id: chatId,
        text: `⚠️ ${name} — no advertising in this community. Please ask people to DM you instead — only this community's own projects can be advertised here. Warning issued (${w.count}/${max}).`,
      }).catch(() => {});
    }
    return false;
  } catch { return false; }
}

// ── Phase 2 commands: /wl, /addban, /removeban, /bans ──────────────────────
// COMMANDS-map shape (chatId, args, msg), registered in handlers/message.js.

async function guardSend(chatId, text) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000) });
  } catch { /* command replies are best-effort */ }
}

// Source: can_delete_messages check (hasAdminRights) used by /addban & co.
export async function canDeleteMessages(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    if (!m) return false;
    if (m.status === 'creator') return true;
    if (m.status === 'administrator') return m.can_delete_messages === true;
    return false;
  } catch { return false; }
}

// Source :24989: /wl toggles whitelist membership for the reply target or
// a @username / numeric-id argument; with no target it lists the group.
async function wlCommand(chatId, args, msg) {
  if (msg?.chat?.type === 'private') {
    await guardSend(chatId, 'ℹ️ Use /wl in the group you want to manage.');
    return;
  }
  const fromId = msg?.from?.id;
  if (!fromId) return;
  if (!(await isChatAdmin(chatId, fromId))) {
    await guardSend(chatId, '⛔ Only group admins can manage the whitelist.');
    return;
  }
  const arg = (args ?? '').trim().split(/\s+/)[0] ?? '';
  const replyFrom = msg?.reply_to_message?.from;
  if (!arg && !replyFrom) {
    const rows = await listWhitelist(chatId, 12);
    const lines = ['🔗 Whitelist', ''];
    if (!rows.length) lines.push('No one is whitelisted yet.');
    else for (const r of rows) lines.push(`• ${r.username ? '@' + r.username : 'ID ' + r.userId}`);
    lines.push('', 'Toggle: reply to a member with /wl, or /wl @username');
    await guardSend(chatId, lines.join('\n'));
    return;
  }
  let targetId = null;
  let targetUsername = null;
  if (replyFrom && !replyFrom.is_bot) {
    targetId = replyFrom.id;
    targetUsername = replyFrom.username ?? null;
  } else if (/^\d+$/.test(arg)) {
    targetId = Number(arg);
  } else if (arg) {
    const t = await getTarget(msg, arg);
    if (t) {
      targetId = t.id;
      targetUsername = arg.replace(/^@/, '');
    }
  }
  if (!targetId) {
    await guardSend(chatId, "⚠️ I couldn't find that user. Reply to one of their messages with /wl, or use a @username PB has seen.");
    return;
  }
  const label = targetUsername ? '@' + targetUsername : String(targetId);
  if (await isWhitelisted(chatId, targetId)) {
    await removeWhitelist(chatId, targetId);
    await guardSend(chatId, `✅ ${label} removed from whitelist.`);
  } else {
    await addWhitelist(chatId, targetId, targetUsername, fromId);
    await guardSend(chatId, `✅ ${label} added to whitelist — portal, anti-porn and alphabets checks skip them.`);
  }
}

async function addbanCommand(chatId, args, msg) {
  if (msg?.chat?.type === 'private') {
    await guardSend(chatId, 'ℹ️ Use /addban in a group.');
    return;
  }
  const fromId = msg?.from?.id;
  if (!fromId) return;
  if (!(await canDeleteMessages(chatId, fromId))) {
    await guardSend(chatId, '⛔ You need admin rights with the Delete Messages permission to manage banned words.');
    return;
  }
  const word = (args ?? '').trim().toLowerCase();
  if (!word) {
    await guardSend(chatId, 'Usage: /addban <word or phrase>');
    return;
  }
  await addBannedWord(chatId, word, fromId);
  await guardSend(chatId, `🚫 Banned word added: ${word}`);
}

async function removebanCommand(chatId, args, msg) {
  if (msg?.chat?.type === 'private') {
    await guardSend(chatId, 'ℹ️ Use /removeban in a group.');
    return;
  }
  const fromId = msg?.from?.id;
  if (!fromId) return;
  if (!(await canDeleteMessages(chatId, fromId))) {
    await guardSend(chatId, '⛔ You need admin rights with the Delete Messages permission to manage banned words.');
    return;
  }
  const word = (args ?? '').trim().toLowerCase();
  if (!word) {
    await guardSend(chatId, 'Usage: /removeban <word or phrase>');
    return;
  }
  const removed = await removeBannedWord(chatId, word);
  await guardSend(chatId, removed
    ? `✅ Removed banned word: ${word}`
    : `ℹ️ "${word}" wasn't in the banned list.`);
}

async function bansCommand(chatId, _args, msg) {
  if (msg?.chat?.type === 'private') {
    await guardSend(chatId, 'ℹ️ Use /bans in a group.');
    return;
  }
  const fromId = msg?.from?.id;
  if (!fromId) return;
  if (!(await canDeleteMessages(chatId, fromId))) {
    await guardSend(chatId, '⛔ You need admin rights with the Delete Messages permission to view banned words.');
    return;
  }
  const words = await listBannedWords(chatId, 100);
  if (!words.length) {
    await guardSend(chatId, 'No banned words set. Add one with /addban <word>');
    return;
  }
  await guardSend(chatId,
    ['🚫 Banned Words', '', ...words.map((w, i) => `${i + 1}. ${w}`)].join('\n'));
}

export const GUARD_COMMANDS = {
  wl: wlCommand,
  addban: addbanCommand,
  removeban: removebanCommand,
  bans: bansCommand,
  crosslink: crosslinkCommand,
  // Restore wave 1 (2026-10-25): Replit /protect + /unprotect, direct
  // owner-only onText handlers (not wizard steps — verified in source).
  // Enforcement already exists: ban/kick/mute/warn consult isProtectedId.
  protect: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    if (!fromId || !(await isOwnerId(fromId))) { await guardSend(chatId, 'Owner only.'); return; }
    const target = await getTarget(msg, (args ?? '').trim() || undefined);
    if (!target) { await guardSend(chatId, 'Usage: /protect @username or reply to a message.'); return; }
    const argName = (args ?? '').trim().replace(/^@/, '') || null;
    await addProtectedUser(target.id, argName);
    await guardSend(chatId, `🛡️ ${target.name} is now protected — no admin can ban, kick, mute, or warn them.`);
  },
  unprotect: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    if (!fromId || !(await isOwnerId(fromId))) { await guardSend(chatId, 'Owner only.'); return; }
    const clean = (args ?? '').trim().replace(/^@/, '');
    if (!clean) { await guardSend(chatId, 'Usage: /unprotect @username or /unprotect <user_id>.'); return; }
    const removed = await removeProtectedUser(clean);
    await guardSend(chatId, removed ? `✅ @${clean} is no longer protected.` : `ℹ️ @${clean} was not on the protected list.`);
  },
};

// ── Cross Protect (/manage Phase 3, 2026-10-21) ────────────────────────────
// Source: cross_protect_links (:859), mirrorBanToLinkedGroups (:24974,
// called ONLY from the /ban handler :21862), /crosslink (:25034), the
// panel page (:24452) and mng:cpunlink (:24806). Deliberate deviations,
// each forced by Rowdy's community-sealing rule (cross-group effects only
// through deliberate gated paths both sides agreed to):
// - TWO-SIDED CONSENT. The source's /crosslink inserted the link row and
//   force-set cross_protect=true on BOTH groups from one side's command —
//   the other group's admins never agreed to anything. Here a link row
//   carries per-side confirmations and is ACTIVE only when both sides'
//   admins have opted in (panel confirm or /crosslink from their side).
// - MIRROR GATE. The source mirrored whenever the ORIGIN group's flag
//   was on. Here a ban mirrors only across an ACTIVE link with the flag
//   on at BOTH ends, so either community can pause mirroring instantly
//   from its own panel toggle without deleting the link.
// - TARGET MUST BE A KNOWN GROUP. The source linked any numeric id,
//   even groups the bot never served. The port refuses unknown ids —
//   the other side's panel has to exist for consent to be possible.
// Mirroring scope is the source's, unchanged: /ban only. /unban never
// mirrored in the source and does not here (the panel page says so);
// kicks and mutes never mirrored either. The Community Ban log is NOT
// written for mirrored bans — the source recorded nothing cross-group,
// and each group's own /ban writes its own record.

// Canonical pair: numerically smaller chat id first; one row both ways.
function cpPair(a, b) {
  return Number(a) <= Number(b)
    ? [String(a), String(b)]
    : [String(b), String(a)];
}

export async function getCrossProtectLink(a, b) {
  const [ga, gb] = cpPair(a, b);
  try {
    return await db.select().from(cross_protect_links)
      .where(and(
        eq(cross_protect_links.groupAId, ga),
        eq(cross_protect_links.groupBId, gb),
      )).get();
  } catch { return undefined; }
}

// All link rows touching one group, shaped for the panel/mirror:
// mine = THIS group's side confirmed; theirs = the other side's.
export async function listCrossProtectLinks(chatId) {
  let rows = [];
  try { rows = await db.select().from(cross_protect_links).all(); }
  catch { return []; }
  const me = String(chatId);
  const out = [];
  for (const r of rows) {
    if (r.groupAId !== me && r.groupBId !== me) continue;
    const iAmA = r.groupAId === me;
    out.push({
      otherId: iAmA ? r.groupBId : r.groupAId,
      mine: iAmA ? r.aConfirmed === true : r.bConfirmed === true,
      theirs: iAmA ? r.bConfirmed === true : r.aConfirmed === true,
      active: r.aConfirmed === true && r.bConfirmed === true,
    });
  }
  return out;
}

// The other ends of this group's ACTIVE (two-sided) links.
export async function activeCrossProtectTargets(chatId) {
  return (await listCrossProtectLinks(chatId))
    .filter((l) => l.active)
    .map((l) => l.otherId);
}

async function setCrossProtectSide(chatId, otherId, userId) {
  const [ga, gb] = cpPair(chatId, otherId);
  const patch = ga === String(chatId) ? { aConfirmed: true } : { bConfirmed: true };
  await db.update(cross_protect_links)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(
      eq(cross_protect_links.groupAId, ga),
      eq(cross_protect_links.groupBId, gb),
    ))
    .run();
}

// Opt this group into a link with otherId. Creates the pair row with
// this side confirmed (state 'pending'), or — when the other side had
// already requested — completes the consent (state 'active'). Turning a
// link ACTIVE sets the cross_protect flag on BOTH groups (the source set
// both flags at link time; here it happens only once consent is mutual).
export async function requestCrossProtectLink(fromChatId, toChatId, userId) {
  const [ga, gb] = cpPair(fromChatId, toChatId);
  const existing = await getCrossProtectLink(ga, gb);
  if (!existing) {
    const fromIsA = ga === String(fromChatId);
    await db.insert(cross_protect_links)
      .values({
        groupAId: ga, groupBId: gb,
        aConfirmed: fromIsA, bConfirmed: !fromIsA,
        requestedBy: userId ?? null,
      })
      .run();
    // The requesting side has opted in — its own flag goes on now (the
    // other side's flag is untouched until THEY confirm).
    await setGroupSettings(fromChatId, { cross_protect: true });
    return { state: 'pending', row: await getCrossProtectLink(ga, gb) };
  }
  const mine = ga === String(fromChatId) ? existing.aConfirmed : existing.bConfirmed;
  const theirs = ga === String(fromChatId) ? existing.bConfirmed : existing.aConfirmed;
  if (mine === true && theirs === true) return { state: 'already', row: existing };
  if (mine === true) return { state: 'pending', row: existing };
  await confirmCrossProtectLink(fromChatId, toChatId);
  return { state: 'active', row: await getCrossProtectLink(ga, gb) };
}

// Confirm THIS group's side of an existing pair (panel confirm button).
// Returns null when no pair row exists.
export async function confirmCrossProtectLink(chatId, otherId) {
  const [ga, gb] = cpPair(chatId, otherId);
  const existing = await getCrossProtectLink(ga, gb);
  if (!existing) return null;
  await setCrossProtectSide(chatId, otherId);
  const row = await getCrossProtectLink(ga, gb);
  const active = row?.aConfirmed === true && row?.bConfirmed === true;
  if (active) {
    await setGroupSettings(ga, { cross_protect: true });
    await setGroupSettings(gb, { cross_protect: true });
  }
  return { active, row };
}

// Delete the pair row outright (source mng:cpunlink semantics): unlink
// for active pairs, decline/cancel for pending ones. Flags untouched —
// a group keeps its own opt-in for any future link.
export async function removeCrossProtectLink(a, b) {
  const [ga, gb] = cpPair(a, b);
  await db.delete(cross_protect_links)
    .where(and(
      eq(cross_protect_links.groupAId, ga),
      eq(cross_protect_links.groupBId, gb),
    ))
    .run();
  // PB Relay Wave 3: a removed link can strand relay destinations that
  // rode it (consent Path B) — stamp the recheck so the relay tick
  // audit re-validates them on its next pass (it also re-validates at
  // relay time; the stamp is the enqueue, per PB-RELAY-SPEC §9.3).
  await stampRelayConsentRecheck();
}

// The relay consent-recheck enqueue (PB-RELAY-SPEC §9.3): a config
// stamp the relay cycle consumes. Written whenever Cross Protect
// consent state changes underneath relay rules (unlink here, the
// per-side toggle in the mng handler below). Relay imports nothing
// back from here — config is the shared surface, no import cycle.
export async function stampRelayConsentRecheck() {
  await setConfig('relay:consent_recheck', String(Date.now())).catch(() => {});
}

// Source mirrorBanToLinkedGroups (:24974), gated per the header note:
// origin flag on + ACTIVE link + target flag on. Best-effort per target
// (the source swallowed failures with .catch(() => {})); returns the
// per-target outcomes so callers/harnesses can observe without changing
// the /ban reply (the source announced nothing about mirroring).
export async function mirrorBanToLinkedGroups(originChatId, bannedUserId) {
  const results = [];
  try {
    const s = await getManageSettings(originChatId);
    if (s.cross_protect !== true) return results;
    for (const otherId of await activeCrossProtectTargets(originChatId)) {
      const os = await getManageSettings(otherId);
      if (os.cross_protect !== true) continue;
      let ok = true;
      try { await api.banChatMember({ chat_id: otherId, user_id: bannedUserId }); }
      catch { ok = false; }
      results.push({ chatId: String(otherId), ok });
    }
  } catch { /* mirroring never breaks the ban itself */ }
  return results;
}

// Source /crosslink (:25034), consent-adapted per the header note: run in
// group A it requests a link (or confirms, when B asked first). Admin
// gate is isChatAdmin like the source's isAdmin check and /wl.
async function crosslinkCommand(chatId, args, msg) {
  if (msg?.chat?.type === 'private') {
    await guardSend(chatId, 'ℹ️ Use /crosslink in the group you want to link.');
    return;
  }
  const fromId = msg?.from?.id;
  if (!fromId) return;
  if (!(await isChatAdmin(chatId, fromId))) {
    await guardSend(chatId, '⛔ Only group admins can link groups.');
    return;
  }
  const raw = (args ?? '').trim().split(/\s+/)[0] ?? '';
  if (!raw) {
    await guardSend(chatId,
      '🌐 Cross Protection — Link Groups\n\nUsage: /crosslink [chatId]\n\nThe link turns on only when an admin of the other group confirms it from their /manage → Cross Protect panel (or runs /crosslink back). Nothing links one-sided.\n\nGet a group\'s chat ID by forwarding any message to @userinfobot.');
    return;
  }
  if (!/^-?\d+$/.test(raw) || String(Number(raw)) === String(chatId)) {
    await guardSend(chatId, '❌ Invalid group ID.');
    return;
  }
  const otherId = String(Number(raw));
  let known = null;
  try {
    known = await db.select().from(known_groups)
      .where(eq(known_groups.chatId, otherId)).get();
  } catch { /* treated as unknown below */ }
  if (!known) {
    await guardSend(chatId,
      '❌ I don\'t serve that group yet. Add me there as an admin first — the other group\'s admin has to be able to confirm the link from their own panel.');
    return;
  }
  const otherName = known.title ?? otherId;
  const res = await requestCrossProtectLink(chatId, otherId, fromId);
  if (res.state === 'already') {
    await guardSend(chatId, `🌐 Already linked with ${otherName} — bans with /ban mirror both ways.`);
  } else if (res.state === 'active') {
    await guardSend(chatId,
      `🌐 Cross Protection enabled!\n\nThis group is now linked with ${otherName}.\nBans with /ban here will automatically apply there, and vice versa.`);
  } else {
    await guardSend(chatId,
      `🌐 Link requested with ${otherName}.\n\nAn admin of ${otherName} must confirm it from their /manage → Cross Protect panel before any bans mirror. Nothing is linked until they do.`);
  }
}

// ── Group Manager panel (/manage) — Phase 1 restore (2026-10-20) ───────────
// Ports buildManageMenu / handleManageFeature / the /manage onText handler
// from telegram-community-bot.ts (:24205 / :24282 / :24500). Deviations from
// the source, all deliberate:
// - The source gated on a stored admin registry (bot_managed_groups +
//   group_manage_admins) consulted only when the panel was opened; its mng:
//   callbacks NEVER re-verified adminship. Here every step — command,
//   selector, and EVERY mng: callback — re-checks the caller's live
//   can_change_info right via getChatMember, against known_groups. The
//   registry tables are not recreated.
// - The source rendered ✅/❌ state marks on the Anti-Porn / Alphabets /
//   Cross Protect buttons from stored toggles. Phase 1 rendered no marks
//   (features inactive); Phase 2 restores real marks for Portal,
//   Anti-Porn and Alphabets now that their toggles are live, plus live
//   counts on Whitelist / Banned Words. Phase 3 gives Cross Protect a
//   real mark as well, stricter than the source's flag-only render: ✅
//   requires the flag AND an active two-sided link — the home group's
//   rescued settings carry cross_protect:true with zero link rows, and
//   a ✅ there would claim protection that does not exist.
// - Plain text (no MarkdownV2 layer), matching this file's v1 convention.

// ── Buy Bot (Phase 2, 2026-10-21 — PB-BUYBOT-DESIGN §6.2) ──────────────────
// The panel half of Buy Bot: stats over buy_events (the ported
// buy_alerts_log math — count, Σusd, max, distinct buyers) and the
// group→campaign resolution the original did through user_target_groups
// (here: user_campaign_slots). The engine lives in lib/tick.js
// (cycleBuyWatch); the hourly stats card (cycleBuyHourly) reads
// buyStatsForChat from here — groups.js sits below tick.js in the import
// graph, so the shared helper lives here, not there.

export async function buyStatsForChat(chatId, sinceSec) {
  const out = { count: 0, volumeUsd: 0, biggestUsd: 0, uniqueBuyers: 0 };
  try {
    const rows = await db.select().from(buy_events)
      .where(eq(buy_events.chatId, String(chatId))).all();
    const buyers = new Set();
    for (const r of rows) {
      if (Number(r.createdAt) < Number(sinceSec)) continue;
      out.count++;
      out.volumeUsd += Number(r.usdAmount) || 0;
      out.biggestUsd = Math.max(out.biggestUsd, Number(r.usdAmount) || 0);
      if (r.buyerAddress) buyers.add(String(r.buyerAddress).toLowerCase());
    }
    out.uniqueBuyers = buyers.size;
  } catch { /* stats are best-effort — an empty block renders honestly */ }
  return out;
}

/** Campaigns with at least one slot (active or not) targeting this group. */
export async function buyCampaignsTargeting(chatId) {
  try {
    const slots = await db.select().from(user_campaign_slots)
      .where(eq(user_campaign_slots.targetChatId, String(chatId))).all();
    const ids = [...new Set(slots.map((s) => s.campaignId))];
    const camps = [];
    for (const id of ids) {
      const c = await db.select().from(user_campaigns)
        .where(eq(user_campaigns.id, id)).get().catch(() => null);
      if (c) camps.push(c);
    }
    return camps.sort((a, b) => a.id - b.id);
  } catch { return []; }
}

/**
 * The campaign this group's Buy Bot panel acts on: the clicker's own
 * campaign when it targets the group, else the earliest campaign that
 * does (the panel is group-scoped; campaigns resolve from the group,
 * exactly like the original's user_target_groups join).
 */
export async function resolveBuyCampaignForGroup(chatId, clickerId) {
  const camps = await buyCampaignsTargeting(chatId);
  if (!camps.length) return null;
  return camps.find((c) => String(c.ownerTelegramId) === String(clickerId)) ?? camps[0];
}

// ── Tier Delegation (restore, 2026-10-22 — "better than the original") ──────
// The original's getEffectiveTier (telegram-community-bot.ts :2980-3048)
// let a group's admins borrow power three ways: manager inheritance,
// per-command grants (community_admin_grants), and an anonymous-admin
// group tier (getGroupHighestTier). The v1 port dropped all three
// (posts.js effectiveTier resolved the caller's own row only). This
// restores them on the port's substrate, with Rowdy's improvements:
// - The group OWNER is the subscriber the campaigns mapping above names
//   for the chat: the owner of the EARLIEST campaign (lowest id) holding
//   a slot that targets the group — resolveBuyCampaignForGroup's own
//   fallback made singular, so exactly one accountable owner exists per
//   group. No campaign targets the group → no owner → NO delegation
//   (fail-closed; everyone resolves at their own tier).
// - TWO-KEY RULE (Rowdy, 2026-10-22): a borrow needs BOTH keys at the
//   moment of resolution — the borrower is a CURRENT admin of the group
//   (isChatAdmin, live Bot API read) AND currently delegated (manager,
//   or holding a grant for the command). Nothing is cached: de-admined
//   → the borrow is dead even though the grant row remains (dormant);
//   re-admined → it revives. The owner's tier must be paid + unexpired
//   at resolution too (lib/posts.js delegationLendTier).
// - NEVER DELEGATABLE (Rowdy's hard rule): boost + airdrop families,
//   buy-rewards payout control, the money-admin verbs and every
//   platform-owner / broadcast function can never be borrowed — not by
//   managers, not by grants, not by the anonymous-admin path. Enforced
//   at grant WRITE time (the picker never lists them; the toggle
//   refuses them) AND at RESOLUTION time (a forged stored grant naming
//   one is refused — lib/posts.js checks this set before honoring any
//   state). Money moves only on the owner's own identified account, or
//   as a PB job the owner armed.
// - BORROW = LEVEL ONLY: resolution changes the tier used for feature
//   gates and usage allowances. It never touches the owner's credits or
//   wallets — credit-charged actions bill the ACTOR (lib/image.js
//   reserves against the caller's own ledger, unchanged).
// - VISIBILITY (the "better"): every resolution where a borrow actually
//   ELEVATED the actor is appended to the group's borrow log (ring,
//   cap 50) rendered on the /manage Delegation page. Revocation is
//   instant because resolution reads this state live.
// State lives in the group_settings JSON under `delegation`:
// { managers: [userId], grants: { userId: [command] } } — PLUS the
// borrow log in its OWN config row (`dlglog:<chatId>`, ring cap 50).
// The split is load-bearing: borrow logging is a fire-and-forget
// read-modify-write fired from tier resolution, while managers/grants
// are owner-edited state; sharing one row let an in-flight log append
// clobber a concurrent owner edit with its stale snapshot (the wave
// harness caught exactly that). Separate rows, separate writers.

/** Commands a group owner may grant to an admin (the picker universe):
 *  the group command paths that resolve tier WITH delegation context —
 *  the message handler's tierGate feature names plus 'ask' (group AI
 *  caps) — minus the remote-* family (their effect lands in OTHER
 *  groups, so a per-group borrow must never unlock them). */
export const DELEGATABLE_COMMANDS = [
  'ask',
  'bullpost', 'bearpost', 'moonpost', 'fudpost', 'gempost', 'memepost',
  'shillraid', 'callout', 'alpha', 'nftpost', 'defipost',
  'analyze', 'gem', 'sentiment', 'debate', 'quote', 'idea', 'recap',
  'tldr', 'translate',
  'generate', 'meme', 'pfp',
  'everyone', 'syncmembers',
  'portfolio', 'balance', 'watchwallet', 'alert', 'milestone',
];

/** NEVER delegatable — Rowdy's money + platform-owner exclusion set.
 *  Derived from the live registries at build time (BOOST_COMMANDS,
 *  AIRDROP_COMMANDS, BUYREWARDS_COMMANDS, MONEY_ADMIN_COMMANDS,
 *  BROADCAST/BLAST/DM_BROADCAST_COMMANDS) plus the owner-only verbs the
 *  dispatcher special-cases; the wave harness asserts this set still
 *  covers every key of those registries. */
export const NEVER_DELEGATABLE_COMMANDS = new Set([
  // Boost family (lib/boost.js BOOST_COMMANDS) + arm verb.
  'boost', 'booster', 'boostquote', 'myboosts', 'boostdetail', 'armboost',
  // Airdrop family (lib/airdrop.js AIRDROP_COMMANDS) + arm verb.
  'airdrop', 'mydrops', 'dropdetail', 'armairdrop',
  // Buy-rewards payout control (BUYREWARDS_COMMANDS).
  'buyrewards',
  // Money admin (lib/moneyguard.js MONEY_ADMIN_COMMANDS).
  'moneyops', 'moneycaps',
  // Broadcast / blast / DM-broadcast families (lib/broadcastcmds.js).
  'broadcast', 'dmbroadcast', 'dmstop', 'dmfollowup',
  'pbblast', 'pbnews', 'pbbuynews', 'pbbooster', 'airdropblast',
  // Platform-owner dispatcher verbs + tier/grant administration.
  'setkey', 'tick', 'menusync', 'freechat', 'setsupport',
  'settier', 'globalban', 'granttier',
]);

/** The group's delegation owner: the subscriber the campaigns mapping
 *  names — owner of the earliest campaign targeting this group — or
 *  null when no campaign targets it (no delegation exists there). */
export async function delegationOwnerForGroup(chatId) {
  const camps = await buyCampaignsTargeting(chatId).catch(() => []);
  if (!camps.length) return null;
  const owner = camps[0].ownerTelegramId;
  return owner != null && String(owner) !== '' ? String(owner) : null;
}

/** Normalized delegation state for a group (never throws). The log
 *  ring lives in its own config row (see the block header) and is
 *  merged in here so pages read one shape. */
const dlgLogKey = (chatId) => `dlglog:${chatId}`;

export async function getDelegationState(chatId) {
  const s = await getGroupSettings(chatId).catch(() => ({}));
  const d = (s && typeof s.delegation === 'object' && s.delegation) || {};
  const grants = {};
  if (d.grants && typeof d.grants === 'object') {
    for (const [uid, cmds] of Object.entries(d.grants)) {
      if (Array.isArray(cmds)) grants[String(uid)] = cmds.map((c) => String(c).toLowerCase());
    }
  }
  let log = [];
  try {
    const raw = await getConfig(dlgLogKey(chatId), null);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) log = parsed.filter((e) => e && typeof e === 'object');
  } catch { /* log reads as empty */ }
  return {
    managers: Array.isArray(d.managers) ? [...new Set(d.managers.map(String))] : [],
    grants,
    log,
  };
}

async function saveDelegationState(chatId, state) {
  // Only managers/grants persist to the settings JSON — the log has its
  // own row (appendDelegationBorrowLog) and is never written here.
  await setGroupSettings(chatId, {
    delegation: { managers: state.managers, grants: state.grants },
  });
  return state;
}

/** Owner write path: add/remove a manager. Refuses the owner themself
 *  (they lend the tier; they never borrow it). Returns the new state. */
export async function delegationSetManager(chatId, userId, on, ownerId) {
  const uid = String(userId);
  if (ownerId != null && uid === String(ownerId)) return getDelegationState(chatId);
  const state = await getDelegationState(chatId);
  state.managers = on
    ? [...new Set([...state.managers, uid])]
    : state.managers.filter((m) => m !== uid);
  return saveDelegationState(chatId, state);
}

/** Owner write path: toggle one command grant for one admin. Returns
 *  true when the command is NOW granted, false when now revoked, and
 *  null when REFUSED (never-delegatable or not in the picker universe —
 *  the write path's half of the double enforcement). */
export async function delegationToggleGrant(chatId, userId, command) {
  const cmd = String(command ?? '').toLowerCase();
  if (NEVER_DELEGATABLE_COMMANDS.has(cmd)) return null;
  if (!DELEGATABLE_COMMANDS.includes(cmd)) return null;
  const uid = String(userId);
  const state = await getDelegationState(chatId);
  const cur = new Set(state.grants[uid] ?? []);
  const nowOn = !cur.has(cmd);
  if (nowOn) cur.add(cmd); else cur.delete(cmd);
  if (cur.size) state.grants[uid] = [...cur]; else delete state.grants[uid];
  await saveDelegationState(chatId, state);
  return nowOn;
}

/** Append one ELEVATING borrow to the group's log ring (cap 50, newest
 *  last), stored in the log's OWN config row so this fire-and-forget
 *  write can never clobber owner-edited managers/grants. Best-effort by
 *  contract: logging must never break a gate, so callers fire-and-forget
 *  and this never throws. */
export async function appendDelegationBorrowLog(chatId, entry) {
  try {
    let log = [];
    const raw = await getConfig(dlgLogKey(chatId), null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) log = parsed.filter((e) => e && typeof e === 'object');
    }
    log = [...log, {
      u: entry?.u != null ? String(entry.u) : null,
      c: String(entry?.c ?? ''),
      t: Math.floor(Date.now() / 1000),
      via: ['mgr', 'grant', 'anon'].includes(entry?.via) ? entry.via : 'grant',
    }].slice(-50);
    await setConfig(dlgLogKey(chatId), JSON.stringify(log));
  } catch { /* the log is visibility, not a gate */ }
}

/** Display label for a telegram id from the bot_users row (name and/or
 *  @username), falling back to the bare id. */
export async function delegationUserLabel(userId) {
  if (userId == null) return 'Anonymous admin';
  try {
    const row = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(userId))).get();
    if (row) {
      const name = row.firstName || row.username || String(userId);
      return row.username && row.firstName ? `${row.firstName} (@${row.username})` : String(name);
    }
  } catch { /* fall through */ }
  return `user ${userId}`;
}

/** The group's current human admins (live Bot API read) for the
 *  Delegation pickers: [{ id, name, status }], bots excluded. */
export async function groupAdminUsers(chatId) {
  try {
    const members = await api.getChatAdministrators({ chat_id: chatId });
    if (!Array.isArray(members)) return [];
    return members
      .filter((m) => m?.user && !m.user.is_bot)
      .map((m) => ({
        id: String(m.user.id),
        name: m.user.first_name || m.user.username || String(m.user.id),
        username: m.user.username ?? null,
        status: m.status,
      }));
  } catch { return []; }
}

// ── Delegation pages inside /manage (owner-only surface) ───────────────────
// The panel's own gate (can_change_info, re-verified on every click by
// handleManageCallback) decides who can OPEN /manage; these pages add
// the second check the feature needs: only the group's delegation owner
// (delegationOwnerForGroup) sees or changes delegation. Another admin
// opening the page gets the explanation, never the controls. Every
// mutation re-checks ownership at click time inside
// handleDelegationCallback — a forwarded panel drives nothing.

function delegationBackRow(chatId) {
  return [
    { text: '◀ Delegation', callback_data: `mng:feat:${chatId}:delegation` },
    { text: '◀ Group Manager', callback_data: `mng:menu:${chatId}` },
  ];
}

async function delegationFeaturePage(chatId, userId) {
  const ownerId = await delegationOwnerForGroup(chatId);
  if (!ownerId) {
    return {
      text: [
        '🤝 Delegation',
        '',
        'No subscriber campaign targets this group yet, so there is no group owner to lend a tier here. Delegation switches on when a member\'s campaign (with a posting slot for this group) exists — its owner becomes the lender.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [backRow(chatId)] },
    };
  }
  if (String(userId) !== ownerId) {
    const label = await delegationUserLabel(ownerId);
    return {
      text: [
        '🤝 Delegation',
        '',
        `This group's tier lender is ${label}. Only the lender manages managers and command grants — borrowing is theirs to give and revoke.`,
        '',
        'How it works: the lender\'s admins can borrow the lender\'s current plan tier for group tools, inside this group only, while they stay admins. Boosts and airdrops are never delegated.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [backRow(chatId)] },
    };
  }
  const state = await getDelegationState(chatId);
  const ownerRow = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, ownerId)).get().catch(() => null);
  const mgrLabels = [];
  for (const m of state.managers.slice(0, 10)) mgrLabels.push(await delegationUserLabel(m));
  const grantCount = Object.values(state.grants).reduce((n, arr) => n + arr.length, 0);
  const recent = state.log.slice(-3).reverse();
  const lines = [
    '🤝 Delegation — your tier, lent to your admins',
    '',
    `Your stored plan for this group: ${String(ownerRow?.tier ?? 'free')}. Managers and granted admins borrow it at that level, for group tools in THIS group only, checked live on every command.`,
    '',
    `👥 Managers (${state.managers.length}) — borrow your tier for every delegatable tool:`,
    ...(mgrLabels.length ? mgrLabels.map((l) => `• ${l}`) : ['• none yet']),
    '',
    `🎟️ Command grants: ${grantCount} command${grantCount === 1 ? '' : 's'} granted across ${Object.keys(state.grants).length} admin${Object.keys(state.grants).length === 1 ? '' : 's'}.`,
    '',
    'Hard rules: boosts and airdrops can NEVER be delegated (owner-only, or PB jobs you armed). Borrowing never spends your credits — anything credit-charged bills the person running it. Remove someone\'s Telegram admin and every borrow of theirs stops instantly; the grant stays on file, dormant, until they are an admin again.',
  ];
  if (recent.length) {
    lines.push('', 'Latest borrows:');
    for (const e of recent) {
      const who = e.u ? await delegationUserLabel(e.u) : 'Anonymous admin';
      lines.push(`• /${e.c} — ${who} (${e.via === 'mgr' ? 'manager' : e.via === 'anon' ? 'anonymous admin' : 'grant'})`);
    }
  }
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: '👥 Managers', callback_data: `mng:dlgmgrs:${chatId}` },
       { text: '🎟️ Command grants', callback_data: `mng:dlggrants:${chatId}` }],
      [{ text: '🕘 Recent borrow activity', callback_data: `mng:dlglog:${chatId}` }],
      backRow(chatId),
    ] },
  };
}

async function delegationManagersPage(chatId) {
  const ownerId = await delegationOwnerForGroup(chatId);
  const state = await getDelegationState(chatId);
  const admins = await groupAdminUsers(chatId);
  const adminIds = new Set(admins.map((a) => a.id));
  const lines = [
    '👥 Delegation — Managers',
    '',
    'Managers borrow your tier for every delegatable tool in this group. Tap to add or remove. Only CURRENT admins can be added — and a manager who stops being an admin stops borrowing instantly (their seat stays here, dormant).',
    '',
  ];
  const kb = [];
  for (const a of admins) {
    if (a.id === ownerId) continue;
    const on = state.managers.includes(a.id);
    lines.push(`${on ? '✅' : '▫️'} ${a.name}${a.username ? ` (@${a.username})` : ''}`);
    kb.push([{ text: `${on ? '✅ Remove' : '➕ Add'} — ${a.name}`.slice(0, 60), callback_data: `mng:dlgmgrtog:${chatId}:${a.id}` }]);
  }
  const dormant = state.managers.filter((m) => !adminIds.has(m) && m !== ownerId);
  for (const m of dormant) {
    lines.push(`💤 ${await delegationUserLabel(m)} — no longer an admin (dormant, not borrowing)`);
    kb.push([{ text: `🗑️ Remove dormant — ${m}`, callback_data: `mng:dlgmgrtog:${chatId}:${m}` }]);
  }
  if (!admins.length) lines.push('Telegram returned no admin list just now — try again in a moment.');
  kb.push(delegationBackRow(chatId));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function delegationGrantsAdminsPage(chatId) {
  const ownerId = await delegationOwnerForGroup(chatId);
  const state = await getDelegationState(chatId);
  const admins = await groupAdminUsers(chatId);
  const lines = [
    '🎟️ Delegation — Command grants',
    '',
    'Pick an admin to choose which single commands they may run at your tier. Managers (if any) already borrow everything delegatable — grants are for admins who should hold just one or two tools.',
    '',
  ];
  const kb = [];
  for (const a of admins) {
    if (a.id === ownerId) continue;
    const n = (state.grants[a.id] ?? []).length;
    lines.push(`• ${a.name}${a.username ? ` (@${a.username})` : ''} — ${n} grant${n === 1 ? '' : 's'}${state.managers.includes(a.id) ? ' · also a manager' : ''}`);
    kb.push([{ text: `🎟️ ${a.name} (${n})`.slice(0, 60), callback_data: `mng:dlggrant:${chatId}:${a.id}` }]);
  }
  if (!admins.length) lines.push('Telegram returned no admin list just now — try again in a moment.');
  kb.push(delegationBackRow(chatId));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function delegationGrantCmdsPage(chatId, targetId) {
  const state = await getDelegationState(chatId);
  const held = new Set(state.grants[String(targetId)] ?? []);
  const label = await delegationUserLabel(targetId);
  const lines = [
    `🎟️ Command grants — ${label}`,
    '',
    'Tap a command to grant or revoke it. Granted commands run at YOUR tier for this admin, in this group only, while they stay an admin.',
    '',
    'Boosts, airdrops and every money or owner function are never on this list — they cannot be delegated.',
  ];
  const kb = [];
  for (let i = 0; i < DELEGATABLE_COMMANDS.length; i += 2) {
    const row = [];
    for (const cmd of DELEGATABLE_COMMANDS.slice(i, i + 2)) {
      row.push({
        text: `${held.has(cmd) ? '✅' : '▫️'} /${cmd}`,
        callback_data: `mng:dlggtog:${chatId}:${targetId}:${cmd}`,
      });
    }
    kb.push(row);
  }
  kb.push([{ text: '◀ Admins', callback_data: `mng:dlggrants:${chatId}` }, delegationBackRow(chatId)[1]]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function delegationLogPage(chatId) {
  const state = await getDelegationState(chatId);
  const entries = state.log.slice(-20).reverse();
  const lines = ['🕘 Delegation — recent borrows', ''];
  if (!entries.length) {
    lines.push('No borrows yet. An entry lands here every time a delegated admin or an anonymous-admin post actually runs a command ABOVE their own tier on your plan.');
  } else {
    lines.push('Every entry is a command that ran above the runner\'s own tier on your plan:');
    lines.push('');
    for (const e of entries) {
      const who = e.u ? await delegationUserLabel(e.u) : 'Anonymous admin';
      const when = new Date(Number(e.t) * 1000).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`• /${e.c} — ${who} (${e.via === 'mgr' ? 'manager' : e.via === 'anon' ? 'anonymous admin' : 'grant'}) · ${when} UTC`);
    }
  }
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [delegationBackRow(chatId)] } };
}

/** dlg* callback branch of handleManageCallback. The caller has already
 *  re-verified the clicker's Change Info right; THIS branch re-verifies
 *  the clicker is the group's delegation owner before rendering or
 *  mutating anything — delegation is the owner's surface, not any
 *  admin's. Returns the router's { text, alert } ({} = silent). */
export async function handleDelegationCallback(query, parts) {
  const action = parts[1];
  const grpId = parts[2];
  const userId = query?.from?.id;
  const dmChatId = query?.message?.chat?.id ?? userId;
  const messageId = query?.message?.message_id;
  const ownerId = await delegationOwnerForGroup(grpId);
  if (!ownerId || String(userId) !== ownerId) {
    return { text: '⛔ Only this group\'s owner (the subscriber whose campaign targets it) manages delegation. Nothing was changed.', alert: true };
  }
  const show = async (page) => {
    if (page) await mngEdit(dmChatId, messageId, page.text, page.reply_markup);
    return {};
  };

  if (action === 'dlgmgrs') return show(await delegationManagersPage(grpId));
  if (action === 'dlggrants') return show(await delegationGrantsAdminsPage(grpId));
  if (action === 'dlglog') return show(await delegationLogPage(grpId));

  if (action === 'dlgmgrtog') {
    const targetId = parts[3];
    if (!targetId || targetId === ownerId) return {};
    const state = await getDelegationState(grpId);
    const isMgr = state.managers.includes(targetId);
    if (!isMgr) {
      // Add path: the two-key rule starts at the write — managers must
      // be CURRENT admins (resolution re-checks it live every time).
      const admins = await groupAdminUsers(grpId);
      if (!admins.some((a) => a.id === targetId)) {
        return { text: '⛔ That user is not a current admin of this group, so they can\'t be made a manager.', alert: true };
      }
    }
    await delegationSetManager(grpId, targetId, !isMgr, ownerId);
    await show(await delegationManagersPage(grpId));
    return { text: isMgr ? 'Manager removed.' : '✅ Manager added — they now borrow your tier for group tools here.' };
  }

  if (action === 'dlggrant') {
    const targetId = parts[3];
    if (!targetId) return {};
    return show(await delegationGrantCmdsPage(grpId, targetId));
  }

  if (action === 'dlggtog') {
    const targetId = parts[3];
    const cmd = String(parts[4] ?? '').toLowerCase();
    if (!targetId || !cmd) return {};
    // Write-path enforcement of the never-delegatable rule (resolution
    // enforces it again — a forged row is refused there too).
    if (NEVER_DELEGATABLE_COMMANDS.has(cmd) || !DELEGATABLE_COMMANDS.includes(cmd)) {
      return { text: `⛔ /${cmd} can never be delegated. Money and owner functions stay with the account owner.`, alert: true };
    }
    const state = await getDelegationState(grpId);
    const held = (state.grants[targetId] ?? []).includes(cmd);
    if (!held) {
      const admins = await groupAdminUsers(grpId);
      if (!admins.some((a) => a.id === targetId)) {
        return { text: '⛔ That user is not a current admin of this group, so a grant can\'t start for them.', alert: true };
      }
    }
    const nowOn = await delegationToggleGrant(grpId, targetId, cmd);
    if (nowOn === null) {
      return { text: `⛔ /${cmd} can never be delegated.`, alert: true };
    }
    await show(await delegationGrantCmdsPage(grpId, targetId));
    return { text: nowOn ? `✅ /${cmd} granted — runs at your tier for this admin here.` : `/${cmd} grant revoked.` };
  }

  return {};
}

// ── Buy Bot Phase 3 — field writes, captures, direct commands ─────────────
// ONE write path for every Buy Bot campaign setting: the /manage panel
// actions, the panel-armed DM captures and the in-group direct commands
// (/setemoji /setgif /setstep /setminbuy /setwhale /pause /resume) all
// land here, so a value written anywhere is the value every surface
// reads. Buy settings live on the CAMPAIGN row (the original's model) —
// changing one applies to the campaign in every group it posts to, and
// every surface that changes one says so.

/** The single write helper for user_campaigns buy_* fields. */
export async function updateBuyCampaign(campaignId, patch) {
  await db.update(user_campaigns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(user_campaigns.id, campaignId)).run();
}

// USD value as admins type it: "$1,250.50" / "250" / "0.5" → number|null.
// (The original's capture validation: strip $ and commas, then parse.)
export function parseBuyUsd(raw) {
  const s = String(raw ?? '').trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Sane bounds for the numeric fields (validation, not product gates):
// min buy and whale follow the original's ≥ 0 rule (whale 0 = whale
// treatment off, per the schema); the step must be > 0 (it divides).
export const BUY_MIN_MAX_USD = 1_000_000;
const BUY_WHALE_MAX_USD = 100_000_000;
const BUY_STEP_MIN_USD = 0.01;
const BUY_STEP_MAX_USD = 1_000_000;
const BUY_WHALEBAL_MAX_USD = 100_000_000;

// Alert emoji, the original's capture rule: 1–3 emoji, ≤ 8 chars, no
// whitespace (a multi-emoji string like 🟢🟢 is one "token" here).
export function validBuyEmoji(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /\s/.test(s) || s.length > 8) return null;
  return s;
}

// ── Panel field captures (the original's bb:set:* sessions) ──────────────
// Armed from the /manage Buy Bot page (mng:bbset), consumed by the
// admin's next DM message. Config-key session, 5-min TTL — the portal
// capture pattern; the isolate keeps no session memory. The clicker's
// Change Info right for the group is re-verified at CONSUME time: a
// capture armed before an admin change writes nothing.
const BB_CAPTURE_TTL_MS = 5 * 60_000;
const bbCaptureKey = (userId) => `bb_capture:${userId}`;
const BB_CAPTURE_FIELDS = {
  emoji: { label: 'alert emoji', kind: 'text' },
  min: { label: 'minimum buy (USD)', kind: 'text' },
  whale: { label: 'whale threshold (USD)', kind: 'text' },
  step: { label: 'emoji step (USD per emoji)', kind: 'text' },
  whalebal: { label: 'known-whale badge threshold (USD)', kind: 'text' },
  banner: { label: 'banner media', kind: 'media' },
};

export async function armBuyBotCapture(userId, grpId, campaignId, field) {
  await setConfig(bbCaptureKey(userId), JSON.stringify({
    grpId: String(grpId), campaignId: Number(campaignId), field,
    expiresAt: Date.now() + BB_CAPTURE_TTL_MS,
  })).catch(() => {});
}

export async function clearBuyBotCapture(userId) {
  await setConfig(bbCaptureKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}

export async function loadBuyBotCapture(userId) {
  try {
    const raw = await getConfig(bbCaptureKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.grpId || !BB_CAPTURE_FIELDS[sess.field]) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

async function bbCaptureSay(dmChatId, text) {
  try { await api.sendMessage({ chat_id: dmChatId, text }); } catch { /* DM may be closed */ }
}

function bbFieldSavedText(field, camp, value) {
  const t = `$${camp.ticker}`;
  switch (field) {
    case 'emoji': return `✅ Buy Bot alert emoji for ${t} is now ${value}.`;
    case 'min': return `✅ Buy Bot minimum buy for ${t} is now ${bbFmtUsd(value)}. Smaller buys are still logged, just not alerted.`;
    case 'whale': return Number(value) > 0
      ? `✅ Buy Bot whale threshold for ${t} is now ${bbFmtUsd(value)}.`
      : `✅ Buy Bot whale treatment for ${t} is off — no buy gets the whale header.`;
    case 'step': return `✅ Buy Bot emoji step for ${t} is now ${bbFmtUsd(value)} per emoji — the alert bar grows one emoji per step bought.`;
    case 'whalebal': return Number(value) > 0
      ? `✅ Known-whale badge for ${t} is now ${bbFmtUsd(value)} — buyers whose wallet balance (native + this token) reaches it get the 🐋 badge on their alert. That's the buyer's BALANCE, separate from the 🐳 whale-buy header.`
      : `✅ Known-whale badge for ${t} is off.`;
    case 'banner': return `✅ Buy Bot banner for ${t} saved (${value}). New buy alerts will ride on it.`;
    default: return '✅ Buy Bot setting saved.';
  }
}

// DM interceptor (handlers/message.js): while a Buy Bot capture is armed
// for this admin, their next DM message is the value — plain text for
// the value fields, media for the banner. Returns true when consumed
// (saved, refused, or invalid-with-the-session-still-armed). A message
// of the wrong kind, or a command, is NOT consumed.
export async function handleBuyBotCapture(dmChatId, message) {
  const userId = message?.from?.id;
  if (!userId) return false;
  const { sess, expired } = await loadBuyBotCapture(userId);
  if (!sess) {
    if (expired) {
      await clearBuyBotCapture(userId);
      await bbCaptureSay(dmChatId,
        '⏰ That Buy Bot edit prompt expired (5 minutes). Open /manage → 💎 Buy Bot and tap the setting again.');
      return true;
    }
    return false;
  }
  const meta = BB_CAPTURE_FIELDS[sess.field];
  const media = portalBannerOf(message);
  if (meta.kind === 'media') {
    if (!media) return false; // text doesn't answer a banner prompt
  } else {
    const text = String(message?.text ?? '').trim();
    if (!text || text.startsWith('/') || media) return false;
    // Validate BEFORE consuming: an invalid value keeps the session
    // armed so the admin can simply send a better one.
    let patch = null;
    let shown = null;
    if (sess.field === 'emoji') {
      const v = validBuyEmoji(text);
      if (!v) {
        await bbCaptureSay(dmChatId, '⚠️ That doesn\'t work as an alert emoji — send 1–3 emoji (max 8 characters, no spaces). The prompt is still open.');
        return true;
      }
      patch = { buyEmoji: v }; shown = v;
    } else {
      const n = parseBuyUsd(text);
      const bad = n === null
        || (sess.field === 'min' && (n < 0 || n > BUY_MIN_MAX_USD))
        || (sess.field === 'whale' && (n < 0 || n > BUY_WHALE_MAX_USD))
        || (sess.field === 'whalebal' && (n < 0 || n > BUY_WHALEBAL_MAX_USD))
        || (sess.field === 'step' && (n < BUY_STEP_MIN_USD || n > BUY_STEP_MAX_USD));
      if (bad) {
        const hint = sess.field === 'step'
          ? `between ${bbFmtUsd(BUY_STEP_MIN_USD)} and ${bbFmtUsd(BUY_STEP_MAX_USD)}`
          : sess.field === 'whale' || sess.field === 'whalebal'
            ? `0 (off) up to ${bbFmtUsd(BUY_WHALE_MAX_USD)}`
            : `0 up to ${bbFmtUsd(BUY_MIN_MAX_USD)}`;
        await bbCaptureSay(dmChatId, `⚠️ Send the ${meta.label} as a USD amount (${hint}) — e.g. 25 or $25. The prompt is still open.`);
        return true;
      }
      if (sess.field === 'min') patch = { buyMinUsd: n };
      if (sess.field === 'whale') patch = { whaleThresholdUsd: n };
      if (sess.field === 'whalebal') patch = { buyWhaleBalanceUsd: n > 0 ? n : null };
      if (sess.field === 'step') patch = { buyStepUsd: n };
      shown = n;
    }
    await clearBuyBotCapture(userId);
    if (!(await canChangeInfo(sess.grpId, userId))) {
      await bbCaptureSay(dmChatId,
        '⛔ Buy Bot edit cancelled: you no longer hold the Change Info permission in that group, so nothing was saved.');
      return true;
    }
    const camp = await db.select().from(user_campaigns)
      .where(eq(user_campaigns.id, sess.campaignId)).get().catch(() => null);
    if (!camp) {
      await bbCaptureSay(dmChatId, '⛔ That campaign no longer exists — nothing was saved.');
      return true;
    }
    await updateBuyCampaign(camp.id, patch);
    await bbCaptureSay(dmChatId, `${bbFieldSavedText(sess.field, camp, shown)}\n\nIt applies to the campaign in every group it posts to. Review it any time in /manage → 💎 Buy Bot.`);
    return true;
  }
  // kind === 'media' (banner)
  await clearBuyBotCapture(userId);
  if (!(await canChangeInfo(sess.grpId, userId))) {
    await bbCaptureSay(dmChatId,
      '⛔ Buy Bot edit cancelled: you no longer hold the Change Info permission in that group, so nothing was saved.');
    return true;
  }
  const camp = await db.select().from(user_campaigns)
    .where(eq(user_campaigns.id, sess.campaignId)).get().catch(() => null);
  if (!camp) {
    await bbCaptureSay(dmChatId, '⛔ That campaign no longer exists — nothing was saved.');
    return true;
  }
  await updateBuyCampaign(camp.id, { buyMediaFileId: media.fileId, buyMediaType: media.type });
  const label = { photo: 'photo', animation: 'GIF', video: 'video' }[media.type];
  await bbCaptureSay(dmChatId, `${bbFieldSavedText('banner', camp, label)}\n\nIt applies to the campaign in every group it posts to. Review it any time in /manage → 💎 Buy Bot.`);
  return true;
}

// ── Direct-command lane (Buy Bot Phase 3 — PB-BUYBOT-DESIGN §9.1) ─────────
// BuyPop-style one-shot setters for power admins, as THIN wrappers over
// the same writes the panel uses: the campaign is resolved from THIS
// group via slots exactly like the panel (resolveBuyCampaignForGroup),
// every write goes through updateBuyCampaign, and the per-group toggles
// write the same group_settings keys the panel/tick read. /settoken is
// deliberately NOT here: in PB it is the established group featured-
// token command (handlers/message.js, group_settings.tokenAddress) —
// the Buy Bot token is the campaign's contract address, set at
// campaign creation (/setup, /campaign edit, Mini App form).
// Commands are group-admin gated (isChatAdmin, the ops lane's gate).

async function bbCmdSay(chatId, text) {
  try { await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000) }); } catch { /* 403 etc. */ }
}

/** Admin gate + campaign resolution shared by the campaign commands. */
async function bbCmdCampaign(chatId, msg) {
  if (msg?.chat?.type === 'private') {
    await bbCmdSay(chatId, 'ℹ️ Buy Bot commands work in a group — run them in the group the campaign posts to.');
    return null;
  }
  if (!msg?.from?.id || !(await isChatAdmin(chatId, msg.from.id))) {
    await bbCmdSay(chatId, '⛔ Only group admins can change Buy Bot settings.');
    return null;
  }
  const camp = await resolveBuyCampaignForGroup(chatId, msg.from.id);
  if (!camp) {
    await bbCmdSay(chatId, '💎 No campaign posts into this group yet, so there is no Buy Bot to configure here. A member creates one in the Mini App (📣 My Campaign) or with /setup, then adds this group as a posting slot.');
    return null;
  }
  return camp;
}

async function bbSetEmojiCmd(chatId, args, msg) {
  const camp = await bbCmdCampaign(chatId, msg);
  if (!camp) return;
  const v = validBuyEmoji(args ?? '');
  if (!v) {
    await bbCmdSay(chatId, '📋 Usage: /setemoji <emoji> — 1–3 emoji, max 8 characters (e.g. /setemoji 🚀).');
    return;
  }
  await updateBuyCampaign(camp.id, { buyEmoji: v });
  await bbCmdSay(chatId, `✅ Buy Bot alert emoji for $${camp.ticker} is now ${v} — applies in every group this campaign posts to.`);
}

async function bbSetGifCmd(chatId, _args, msg) {
  const camp = await bbCmdCampaign(chatId, msg);
  if (!camp) return;
  const media = portalBannerOf(msg?.reply_to_message) ?? portalBannerOf(msg);
  if (!media) {
    await bbCmdSay(chatId, '📋 Reply to a photo, GIF or video with /setgif and I\'ll use it as the Buy Bot banner for this group\'s campaign.');
    return;
  }
  await updateBuyCampaign(camp.id, { buyMediaFileId: media.fileId, buyMediaType: media.type });
  const label = { photo: 'photo', animation: 'GIF', video: 'video' }[media.type];
  await bbCmdSay(chatId, `✅ Buy Bot banner for $${camp.ticker} saved (${label}) — new buy alerts will ride on it, in every group this campaign posts to.`);
}

function bbUsdCmd(field, label) {
  return async (chatId, args, msg) => {
    const camp = await bbCmdCampaign(chatId, msg);
    if (!camp) return;
    const n = parseBuyUsd(args ?? '');
    const bad = n === null
      || (field === 'min' && (n < 0 || n > BUY_MIN_MAX_USD))
      || (field === 'whale' && (n < 0 || n > BUY_WHALE_MAX_USD))
      || (field === 'whalebal' && (n < 0 || n > BUY_WHALEBAL_MAX_USD))
      || (field === 'step' && (n < BUY_STEP_MIN_USD || n > BUY_STEP_MAX_USD));
    if (bad) {
      const usage = {
        min: '📋 Usage: /setminbuy <usd> — e.g. /setminbuy 25. Buys below it are logged, not alerted.',
        whale: '📋 Usage: /setwhale <usd> — e.g. /setwhale 500. Buys at or above it get the 🐳 WHALE header; /setwhale 0 turns whale treatment off.',
        whalebal: '📋 Usage: /setwhalebal <usd> — e.g. /setwhalebal 10000. Buyers whose wallet BALANCE (native + this token) reaches it get the 🐋 Known Whale badge — that\'s the buyer\'s balance, not the buy size (/setwhale). /setwhalebal 0 turns the badge off.',
        step: '📋 Usage: /setstep <usd> — e.g. /setstep 10 grows the alert bar by one emoji per $10 bought.',
      }[field];
      await bbCmdSay(chatId, usage);
      return;
    }
    const patch = field === 'min' ? { buyMinUsd: n }
      : field === 'whale' ? { whaleThresholdUsd: n }
        : field === 'whalebal' ? { buyWhaleBalanceUsd: n > 0 ? n : null }
          : { buyStepUsd: n };
    await updateBuyCampaign(camp.id, patch);
    await bbCmdSay(chatId, `${bbFieldSavedText(field, camp, n)} It applies in every group this campaign posts to.`);
  };
}

async function bbPauseCmd(chatId, _args, msg) {
  const camp = await bbCmdCampaign(chatId, msg);
  if (!camp) return;
  if (!camp.buyBotEnabled) {
    await bbCmdSay(chatId, `💎 Buy Bot is disabled for $${camp.ticker} — enable it in /manage → 💎 Buy Bot or with /campaign (owner).`);
    return;
  }
  if (camp.buyBotPaused) {
    await bbCmdSay(chatId, `⏸ Buy Bot for $${camp.ticker} is already paused.`);
    return;
  }
  await updateBuyCampaign(camp.id, { buyBotPaused: true });
  await bbCmdSay(chatId, `⏸ Buy Bot paused for $${camp.ticker} — alerts hold in every group this campaign posts to. Settings are kept.`);
}

async function bbResumeCmd(chatId, _args, msg) {
  const camp = await bbCmdCampaign(chatId, msg);
  if (!camp) return;
  if (!camp.buyBotEnabled) {
    await bbCmdSay(chatId, `💎 Buy Bot is disabled for $${camp.ticker} — enable it in /manage → 💎 Buy Bot or with /campaign (owner).`);
    return;
  }
  if (!camp.buyBotPaused) {
    await bbCmdSay(chatId, `▶️ Buy Bot for $${camp.ticker} is already running.`);
    return;
  }
  await updateBuyCampaign(camp.id, { buyBotPaused: false });
  await bbCmdSay(chatId, `▶️ Buy Bot resumed for $${camp.ticker} — qualifying buys will post again (checked every few minutes).`);
}

/** Admin gate for the per-GROUP toggles (/hourly, /milestones). */
async function bbCmdAdmin(chatId, msg) {
  if (msg?.chat?.type === 'private') {
    await bbCmdSay(chatId, 'ℹ️ This toggle belongs to a group — run it in the group.');
    return false;
  }
  if (!msg?.from?.id || !(await isChatAdmin(chatId, msg.from.id))) {
    await bbCmdSay(chatId, '⛔ Only group admins can change this setting.');
    return false;
  }
  return true;
}

function bbOnOff(args, current) {
  const a = String(args ?? '').trim().toLowerCase();
  if (a === 'on') return true;
  if (a === 'off') return false;
  if (a === '') return !current;
  return null; // unrecognized → usage
}

async function bbHourlyCmd(chatId, args, msg) {
  if (!(await bbCmdAdmin(chatId, msg))) return;
  const cur = (await getGroupSettings(chatId)).buy_hourly !== false; // campaign groups default ON
  const next = bbOnOff(args, cur);
  if (next === null) {
    await bbCmdSay(chatId, '📋 Usage: /hourly [on|off] — toggles this group\'s hourly Buy Bot stats card.');
    return;
  }
  await setGroupSettings(chatId, { buy_hourly: next });
  await bbCmdSay(chatId, next
    ? '📊 Hourly Buy Bot stats card ON for this group — it posts at most once an hour, and only when the group had buys in the last hour.'
    : '📊 Hourly Buy Bot stats card OFF for this group.');
}

async function bbMilestonesCmd(chatId, args, msg) {
  if (!(await bbCmdAdmin(chatId, msg))) return;
  const cur = (await getGroupSettings(chatId)).milestones !== false; // absent = ON
  const a = String(args ?? '').trim().toLowerCase();
  if (a === '') {
    await bbCmdSay(chatId, `🎯 Price-milestone celebrations are ${cur ? 'ON' : 'OFF'} for this group. Change with /milestones on or /milestones off. Milestones themselves are managed with /milestone.`);
    return;
  }
  const next = bbOnOff(args, cur);
  if (next === null) {
    await bbCmdSay(chatId, '📋 Usage: /milestones [on|off] — toggles this group\'s price-milestone celebrations.');
    return;
  }
  await setGroupSettings(chatId, { milestones: next });
  await bbCmdSay(chatId, next
    ? '🎯 Price-milestone celebrations ON for this group.'
    : '🎯 Price-milestone celebrations OFF for this group — milestones stay set and will celebrate if you turn this back on.');
}

async function bbCancelCmd(chatId, _args, msg) {
  const userId = msg?.from?.id;
  if (!userId) return;
  const { sess, expired } = await loadBuyBotCapture(userId);
  if (!sess && !expired) {
    await bbCmdSay(chatId, 'Nothing to cancel — no Buy Bot edit is waiting on you.');
    return;
  }
  await clearBuyBotCapture(userId);
  await bbCmdSay(chatId, '✖ Buy Bot edit cancelled — nothing was changed.');
}

export const BUYBOT_COMMANDS = {
  setemoji: bbSetEmojiCmd,
  setgif: bbSetGifCmd,
  setstep: bbUsdCmd('step'),
  setminbuy: bbUsdCmd('min'),
  setwhale: bbUsdCmd('whale'),
  setwhalebal: bbUsdCmd('whalebal'),
  milestones: bbMilestonesCmd,
  hourly: bbHourlyCmd,
  pause: bbPauseCmd,
  resume: bbResumeCmd,
  cancel: bbCancelCmd,
  // Buy Bot Phase 5: member-facing competition standings (the data
  // layer + handler live in the Phase 5 section below).
  buycomp: bbCompCmd,
};

// ── Buy Bot Phase 5 — buy competitions (PB-BUYBOT-DESIGN §5) ──────────────
// Bubble's model on the contests lifecycle: an admin sets a prize
// (TEXT ONLY — the project chooses and distributes prizes; PB never
// holds or moves funds here, the contests MONEY RULE), a minimum
// qualifying buy and a duration. Qualifying buys are buy_events rows —
// the SAME rows the alert engine wrote, so a buy can never count for
// a competition without having been detected by the engine that
// alerts (one source of truth; UNIQUE(tx_hash, chat_id) prevents
// double counting). Scoring is sealed three ways: chat_id, token CA,
// and the campaign that owns the competition.
//   kind 'biggest' — the single largest qualifying buy wins
//     (ties: the EARLIEST buy wins — deterministic from the data).
//   kind 'raffle' — one ticket per qualifying buy row; at finalise one
//     ticket is drawn and winner_tx_hash records WHICH ticket (the
//     buy_events row) won — the draw's proof.
// The finaliser (cycleBuyCompetitions, appended to the tick CYCLES in
// lib/tick.js) is cloned from cycleContests: select due 'active' rows
// → finalise each, failure-isolated. The status transition
// active → ended is claimed BEFORE announcing (a conditional update
// that only lands while the row is still 'active'), so a competition
// posts exactly ONE results announcement even if an admin's End Now
// races the tick. Setup is a mini-wizard on the /manage Buy Bot page
// (further below, on the mng: chassis); /buycomp is the member view.

export const BUY_COMP_KINDS = {
  biggest: { label: '🏆 Biggest Buy' },
  raffle: { label: '🎟 Raffle' },
};
export const BUY_COMP_DURATIONS = [
  [3600, '1 hour'], [21600, '6 hours'], [86400, '24 hours'],
  [259200, '3 days'], [604800, '7 days'],
];
export const BUY_COMP_PRIZE_MAX = 200;

export function buyCompetitionRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    chatId: String(r.chatId),
    campaignId: r.campaignId === null || r.campaignId === undefined ? null : Number(r.campaignId),
    ca: r.ca,
    kind: BUY_COMP_KINDS[r.kind] ? r.kind : 'biggest',
    minBuyUsd: Number(r.minBuyUsd) || 0,
    prizeText: r.prizeText ?? null,
    startAt: Number(r.startAt) || 0,
    endAt: Number(r.endAt) || 0,
    status: r.status,
    winnerAddress: r.winnerAddress ?? null,
    winnerTxHash: r.winnerTxHash ?? null,
    createdBy: r.createdBy ?? null,
  };
}

export async function getBuyCompetitionById(id) {
  const row = await db.select().from(buy_competitions)
    .where(eq(buy_competitions.id, Number(id))).get().catch(() => null);
  return buyCompetitionRow(row);
}

async function latestBuyCompetition(chatId, status, campaignId = null) {
  const rows = await db.select().from(buy_competitions)
    .where(and(
      eq(buy_competitions.chatId, String(chatId)),
      eq(buy_competitions.status, status),
    )).all().catch(() => []);
  const list = rows.map(buyCompetitionRow)
    .filter((c) => c && (campaignId === null || c.campaignId === Number(campaignId)))
    .sort((a, b) => b.id - a.id);
  return list[0] ?? null;
}

/** The running competition in this chat (optionally for one campaign). */
export async function getActiveBuyCompetition(chatId, campaignId = null) {
  return latestBuyCompetition(chatId, 'active', campaignId);
}

/** Most recent finalised competition in this chat (the panel's result line). */
export async function getLatestEndedBuyCompetition(chatId, campaignId = null) {
  return latestBuyCompetition(chatId, 'ended', campaignId);
}

export async function createBuyCompetition({ chatId, campaignId = null, ca, kind, minBuyUsd = 0, prizeText = null, startAt, endAt, createdBy = null }) {
  const rows = await db.insert(buy_competitions).values({
    chatId: String(chatId),
    campaignId: campaignId === null ? null : Number(campaignId),
    ca: String(ca),
    kind: BUY_COMP_KINDS[kind] ? kind : 'biggest',
    minBuyUsd: Math.max(0, Number(minBuyUsd) || 0),
    prizeText: prizeText ? String(prizeText).slice(0, BUY_COMP_PRIZE_MAX) : null,
    startAt: Number(startAt),
    endAt: Number(endAt),
    status: 'active',
    createdBy: createdBy === null || createdBy === undefined ? null : String(createdBy),
  }).returning();
  return buyCompetitionRow(rows[0]);
}

/**
 * The qualifying buys for a competition, oldest first: buy_events rows
 * for this chat + CA (+ campaign) inside [startAt, endAt) at/above the
 * minimum. `uptoSec` bounds the live standings read ("so far"); the
 * finalise read passes null and always sees the full closed window —
 * rows timestamped outside the window can exist in the table (later
 * buys, other campaigns) and are sealed out by these bounds alone.
 */
export async function buyCompetitionQualifyingBuys(comp, uptoSec = null) {
  try {
    const rows = await db.select().from(buy_events)
      .where(eq(buy_events.chatId, String(comp.chatId))).all();
    return rows
      .filter((r) => r.ca === comp.ca
        && (comp.campaignId === null || Number(r.campaignId) === comp.campaignId)
        && Number(r.createdAt) >= comp.startAt
        && Number(r.createdAt) < comp.endAt
        && (uptoSec === null || Number(r.createdAt) <= uptoSec)
        && (Number(r.usdAmount) || 0) >= comp.minBuyUsd)
      .sort((a, b) => (Number(a.createdAt) - Number(b.createdAt)) || (a.id - b.id));
  } catch { return []; }
}

/** Standings over a qualifying-buys list (list order = time order). */
export function buyCompetitionStandingsOf(buys) {
  const buyers = new Set();
  let biggest = null;
  for (const r of buys) {
    if (r.buyerAddress) buyers.add(String(r.buyerAddress).toLowerCase());
    // Strict > keeps the EARLIEST of equal-largest buys (the list is
    // time-ordered) — the deterministic tie-break for 'biggest'.
    if (!biggest || (Number(r.usdAmount) || 0) > (Number(biggest.usdAmount) || 0)) biggest = r;
  }
  // Raffle: one ticket per qualifying buy row (design §5) — tickets IS
  // the row count; a buyer with 3 qualifying buys holds 3 tickets.
  return { total: buys.length, tickets: buys.length, uniqueBuyers: buyers.size, biggest };
}

export async function buyCompetitionStandings(comp, live = false) {
  const buys = await buyCompetitionQualifyingBuys(comp, live ? Math.floor(Date.now() / 1000) : null);
  return { buys, ...buyCompetitionStandingsOf(buys) };
}

async function buyCompCampaignLabel(comp) {
  if (comp.campaignId !== null) {
    const camp = await db.select().from(user_campaigns)
      .where(eq(user_campaigns.id, comp.campaignId)).get().catch(() => null);
    if (camp) return { ticker: camp.ticker, name: camp.projectName };
  }
  return { ticker: bbShortCa(comp.ca), name: null };
}

function buyCompTxUrl(chain, txHash) {
  return chain === 'sol' ? `https://solscan.io/tx/${txHash}` : `https://basescan.org/tx/${txHash}`;
}

function buyCompTimeLeft(endAt) {
  const s = Math.max(0, Number(endAt) - Math.floor(Date.now() / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return 'under a minute';
}

export function buyCompetitionResultText(comp, label, standings, winner) {
  const kind = BUY_COMP_KINDS[comp.kind];
  const lines = [
    '🏆 Buy Competition — RESULTS!',
    '',
    `${kind.label} · $${label.ticker}`,
  ];
  if (comp.prizeText) lines.push(`💰 Prize: ${comp.prizeText}`);
  lines.push('');
  if (!winner) {
    // Honest empty result (the contests pattern): the window closed
    // with zero qualifying buys — say so in the group, name no winner.
    lines.push(`No qualifying buys landed in the window (min buy ${bbFmtUsd(comp.minBuyUsd)}), so there's no winner this time.`);
    return lines.join('\n');
  }
  lines.push(`🥇 Winner: ${bbShortCa(winner.buyerAddress ?? 'unknown wallet')}`);
  if (comp.kind === 'raffle') {
    lines.push(`🎟 Drawn from ${standings.tickets} ticket${standings.tickets === 1 ? '' : 's'} — one ticket per qualifying buy.`);
  }
  lines.push(`💵 ${comp.kind === 'raffle' ? 'Their buy' : 'Winning buy'}: ${bbFmtUsd(Number(winner.usdAmount) || 0)}`);
  lines.push(`🔗 TX: ${buyCompTxUrl(winner.chain, winner.txHash)}`);
  lines.push('');
  lines.push(`📊 ${standings.total} qualifying buy${standings.total === 1 ? '' : 's'} from ${standings.uniqueBuyers} buyer${standings.uniqueBuyers === 1 ? '' : 's'} (min buy ${bbFmtUsd(comp.minBuyUsd)}).`);
  lines.push('');
  lines.push('The prize is chosen and distributed by the project — PB only tracks the buys and never pays prizes out.');
  return lines.join('\n');
}

export function buyCompetitionStartText(comp, camp) {
  const kind = BUY_COMP_KINDS[comp.kind];
  const lines = [
    '🏆 Buy Competition STARTED!',
    '',
    `${kind.label} · $${camp.ticker}`,
  ];
  if (comp.prizeText) lines.push(`💰 Prize: ${comp.prizeText}`);
  lines.push(`🎯 Min qualifying buy: ${bbFmtUsd(comp.minBuyUsd)}`);
  if (comp.kind === 'raffle') {
    lines.push('🎟 Every qualifying buy earns one ticket — one ticket is drawn at the end.');
  }
  lines.push(`⏰ Ends in ${buyCompTimeLeft(comp.endAt)} — every qualifying buy in this group counts.`);
  lines.push('');
  lines.push('Prizes are chosen and distributed by the project — PB tracks the buys. Run /buycomp any time for the live standings.');
  return lines.join('\n');
}

/**
 * Finalise ONE competition: compute the winner from buy_events, claim
 * the status transition, post the single results announcement in the
 * competition's own group. Shared by the tick cycle and the panel's
 * End Now. Returns { finalised:false, reason } when the row was not
 * active or the claim was lost — the caller stays silent then.
 */
export async function finaliseBuyCompetition(compIn) {
  const comp = await getBuyCompetitionById(compIn.id);
  if (!comp || comp.status !== 'active') return { finalised: false, reason: 'not_active' };
  const { buys, ...standings } = await buyCompetitionStandings(comp);
  let winner = null;
  if (buys.length) {
    winner = comp.kind === 'raffle'
      ? buys[Math.floor(Math.random() * buys.length)]
      : standings.biggest;
  }
  // Claim BEFORE announcing: the conditional update only lands while
  // the row is still 'active', and .returning() yields one row per
  // affected row (the SDK's documented semantics) — exactly one row
  // back IS the claim receipt. A lost race (the tick vs an admin's
  // End Now) returns zero rows and the loser stays silent. (try/catch,
  // not .catch(): the .returning() builder has no .catch method.)
  let claimed = null;
  try {
    claimed = await db.update(buy_competitions)
      .set({
        status: 'ended',
        winnerAddress: winner?.buyerAddress ?? null,
        winnerTxHash: winner?.txHash ?? null,
      })
      .where(and(eq(buy_competitions.id, comp.id), eq(buy_competitions.status, 'active')))
      .returning();
  } catch { claimed = null; }
  if (!Array.isArray(claimed) || claimed.length !== 1) {
    return { finalised: false, reason: 'claim_lost' };
  }
  const label = await buyCompCampaignLabel(comp);
  const text = buyCompetitionResultText(comp, label, standings, winner);
  await api.sendMessage({ chat_id: comp.chatId, text }).catch(() => {});
  return {
    finalised: true, announced: true,
    winner: winner
      ? { address: winner.buyerAddress ?? null, txHash: winner.txHash, usd: Number(winner.usdAmount) || 0 }
      : null,
    total: standings.total, tickets: standings.tickets, uniqueBuyers: standings.uniqueBuyers,
  };
}

/** Admin cancel: retire an active competition silently (no announcement). */
export async function cancelBuyCompetition(id) {
  const comp = await getBuyCompetitionById(id);
  if (!comp || comp.status !== 'active') return false;
  await db.update(buy_competitions).set({ status: 'cancelled' })
    .where(and(eq(buy_competitions.id, comp.id), eq(buy_competitions.status, 'active')))
    .run().catch(() => {});
  const after = await getBuyCompetitionById(comp.id);
  return after?.status === 'cancelled';
}

/**
 * Start ONE buy competition for a group — the single creation path
 * behind the /manage wizard's Start button and the Mini App's
 * buyCompStart action (Phase 5 follow-up, 2026-10-21). The caller must
 * already hold a verified Change Info right for the group (the mng:
 * chassis re-checks it on every callback; the endpoint re-verifies it
 * live before calling) — this function applies the wizard's own gates
 * in the wizard's order and reports the refusal as a reason:
 *   'no_campaign' — no campaign targets the group (or, with an
 *                   explicit campaignId, that campaign is gone)
 *   'no_ca'       — the campaign has no contract address
 *   'tier'        — the campaign OWNER is below Starter (bot owner ok)
 *   'disabled'    — Buy Bot is disabled for the campaign
 *   'running'     — a competition is already active for it here
 * With campaignId set (the wizard path) that campaign is loaded
 * directly; without it the campaign resolves from the group exactly
 * like the panel (resolveBuyCampaignForGroup). On success the row is
 * created through createBuyCompetition (the buy_events.ca casing rule
 * is applied here) and the start announcement is posted in the group.
 */
export async function startBuyCompetition({ chatId, userId, campaignId = null, kind, prizeText = null, minBuyUsd = 0, durationSec }) {
  const camp = campaignId !== null && campaignId !== undefined
    ? await db.select().from(user_campaigns)
      .where(eq(user_campaigns.id, Number(campaignId))).get().catch(() => null)
    : await resolveBuyCampaignForGroup(chatId, userId);
  if (!camp) return { ok: false, reason: 'no_campaign' };
  if (!camp.contractAddress) return { ok: false, reason: 'no_ca', camp };
  // Tier gate on the campaign OWNER (the wizard's floor is the
  // engine's BUY_CAMPAIGN_MIN_TIER — Starter; the bot owner bypasses,
  // as everywhere). Display mirror, like the panel's tier note; the
  // engine's real gate is unaffected.
  let tierOk = await isOwnerId(camp.ownerTelegramId).catch(() => false);
  if (!tierOk) {
    const ownerRow = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(camp.ownerTelegramId))).get().catch(() => null);
    tierOk = buyTierRankOf(ownerRow?.tier) >= BUY_TIER_RANK.starter;
  }
  if (!tierOk) return { ok: false, reason: 'tier', camp };
  if (!camp.buyBotEnabled) return { ok: false, reason: 'disabled', camp };
  const running = await getActiveBuyCompetition(chatId, camp.id);
  if (running) return { ok: false, reason: 'running', camp, comp: running };
  const nowSec = Math.floor(Date.now() / 1000);
  const comp = await createBuyCompetition({
    chatId,
    campaignId: camp.id,
    // buy_events.ca casing rule (Phase 4): verbatim base58 on
    // Solana, lowercased on EVM — the stored CA must match the
    // event rows exactly or nothing would ever qualify.
    ca: camp.chain === 'sol' ? String(camp.contractAddress) : String(camp.contractAddress).toLowerCase(),
    kind,
    minBuyUsd,
    prizeText,
    startAt: nowSec,
    endAt: nowSec + Number(durationSec),
    createdBy: userId,
  });
  // The start announcement lands in the group itself — the
  // campaign's own slot group, where its buys and alerts live.
  await api.sendMessage({
    chat_id: String(chatId), text: buyCompetitionStartText(comp, camp),
  }).catch(() => {});
  return { ok: true, camp, comp };
}

// ── Tick finaliser (cloned from cycleContests) ────────────────────────────
// Appended to CYCLES in lib/tick.js; failure-isolated per row like the
// contests original: one bad competition never blocks the rest.
export async function cycleBuyCompetitions() {
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = await db.select().from(buy_competitions)
    .where(and(
      eq(buy_competitions.status, 'active'),
      lte(buy_competitions.endAt, nowSec),
    ))
    .all().catch(() => []);
  let finalised = 0;
  for (const r of rows) {
    try {
      const res = await finaliseBuyCompetition(buyCompetitionRow(r));
      if (res.finalised) finalised++;
    } catch (err) {
      console.error('[buy-competitions cycle]', err?.message ?? err);
    }
  }
  return { due: rows.length, finalised };
}

/** /buycomp — the member view (design §5): live standings, sealed to this chat. */
async function bbCompCmd(chatId, _args, msg) {
  if (msg?.chat?.type === 'private') {
    await bbCmdSay(chatId, 'ℹ️ Buy competitions live in a group — run /buycomp in the group to see the one running there.');
    return;
  }
  const comp = await getActiveBuyCompetition(chatId);
  if (!comp) {
    await bbCmdSay(chatId, '🏆 No buy competition is running in this group right now.');
    return;
  }
  const label = await buyCompCampaignLabel(comp);
  const st = await buyCompetitionStandings(comp, true);
  const kind = BUY_COMP_KINDS[comp.kind];
  const lines = [
    `🏆 Buy Competition — ${kind.label} · $${label.ticker}`,
  ];
  if (comp.prizeText) lines.push(`💰 Prize: ${comp.prizeText}`);
  lines.push(`🎯 Min qualifying buy: ${bbFmtUsd(comp.minBuyUsd)}`);
  lines.push(`⏰ Ends in ${buyCompTimeLeft(comp.endAt)}`);
  if (comp.kind === 'raffle') {
    lines.push(`🎟 Tickets so far: ${st.tickets} from ${st.uniqueBuyers} buyer${st.uniqueBuyers === 1 ? '' : 's'} — every qualifying buy earns one ticket.`);
  } else if (st.biggest) {
    lines.push(`🥇 Biggest so far: ${bbFmtUsd(Number(st.biggest.usdAmount) || 0)} by ${bbShortCa(st.biggest.buyerAddress ?? '')}`);
    lines.push(`📊 ${st.total} qualifying buy${st.total === 1 ? '' : 's'} so far.`);
  } else {
    lines.push('🥇 No qualifying buys yet — the next one takes the lead.');
  }
  await bbCmdSay(chatId, lines.join('\n'));
}

// ── Competition setup wizard (on the /manage Buy Bot page) ───────────────
// A config-key draft keyed by the ADMIN's user id (the contest-wizard
// rule: only the admin who started a setup can drive it), 15-min TTL.
// Steps: kind → prize (text capture or skip) → min buy (capture or
// "any") → duration (buttons) → confirm. The value captures ride the
// DM interceptor chain (handleBuyCompCapture) with a fresh Change Info
// re-check at consume time, exactly like the bb field captures.
// Creation gates (checked again at Start, on the CAMPAIGN OWNER —
// the panel's tier mirror, the same one the page renders): owner is
// the bot owner or Starter+ (BUY_CAMPAIGN_MIN_TIER, lib/tick.js), and
// the campaign's Buy Bot must be ENABLED — a competition can only
// count buys the watcher records.

const BB_COMP_WIZ_TTL_MS = 15 * 60_000;
const bbCompWizKey = (userId) => `bbcompwiz:${userId}`;

async function loadBbCompDraft(userId) {
  try {
    const raw = await getConfig(bbCompWizKey(userId), null);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d?.grpId || !d.createdAt || Date.now() - d.createdAt > BB_COMP_WIZ_TTL_MS) return null;
    return d;
  } catch { return null; }
}

async function saveBbCompDraft(userId, draft) {
  await setConfig(bbCompWizKey(userId), JSON.stringify(draft)).catch(() => {});
}

async function clearBbCompDraft(userId) {
  // config has no delete helper; an expired timestamp retires the draft.
  await setConfig(bbCompWizKey(userId), JSON.stringify({ createdAt: 0 })).catch(() => {});
}

function bbCompWizardPanel(draft, note = '') {
  const head = `🏆 New Buy Competition — $${draft.ticker} (${draft.grpTitle})`;
  const gid = draft.grpId;
  const cancelRow = [{ text: '✖ Cancel setup', callback_data: `mng:bbcompwizcancel:${gid}` }];
  if (draft.stage === 'kind') {
    return {
      text: [
        head, '',
        'Step 1 of 4 — what kind?',
        '',
        '🏆 Biggest Buy — the single largest qualifying buy in the window wins.',
        '🎟 Raffle — every qualifying buy earns one ticket; one ticket is drawn at the end.',
        '',
        'Either way, PB scores buys from THIS group only, from the moment the competition starts. Buys are checked every few minutes, not in real time.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [
        [
          { text: '🏆 Biggest Buy', callback_data: `mng:bbcompkind:${gid}:biggest` },
          { text: '🎟 Raffle', callback_data: `mng:bbcompkind:${gid}:raffle` },
        ],
        cancelRow,
      ] },
    };
  }
  if (draft.stage === 'prize') {
    return {
      text: [
        head, '',
        `Step 2 of 4 — the prize (${BUY_COMP_KINDS[draft.kind].label})`,
        '',
        draft.prizeSet
          ? `💰 Prize: ${draft.prizeText ?? '(no prize text)'}`
          : 'No prize text set yet.',
        '',
        'The prize text is announced as-is. PB never holds or pays prizes — you choose and distribute them (Bubble\'s model, and the rule for every PB contest).',
      ].join('\n'),
      reply_markup: { inline_keyboard: [
        [
          { text: '✏️ Set prize text', callback_data: `mng:bbcompedit:${gid}` },
          { text: '⏭ No prize text', callback_data: `mng:bbcompskip:${gid}` },
        ],
        cancelRow,
      ] },
    };
  }
  if (draft.stage === 'min') {
    return {
      text: [
        head, '',
        'Step 3 of 4 — minimum qualifying buy',
        '',
        'Buys below the minimum are recorded by Buy Bot but don\'t count here. "Any recorded buy" still respects the watcher\'s own $0.50 dust floor — nothing below it is ever recorded.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [
        [
          { text: '✏️ Set min buy', callback_data: `mng:bbcompedit:${gid}` },
          { text: '⏭ Any recorded buy', callback_data: `mng:bbcompskip:${gid}` },
        ],
        cancelRow,
      ] },
    };
  }
  if (draft.stage === 'dur') {
    return {
      text: [
        head, '',
        'Step 4 of 4 — how long does it run?',
        '',
        'The window starts the moment you confirm on the next step.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [
        BUY_COMP_DURATIONS.slice(0, 3).map(([sec, label]) => ({ text: label, callback_data: `mng:bbcompdur:${gid}:${sec}` })),
        BUY_COMP_DURATIONS.slice(3).map(([sec, label]) => ({ text: label, callback_data: `mng:bbcompdur:${gid}:${sec}` })),
        cancelRow,
      ] },
    };
  }
  // confirm
  const durLabel = (BUY_COMP_DURATIONS.find(([s]) => s === draft.durationSec) ?? [draft.durationSec, `${draft.durationSec}s`])[1];
  return {
    text: [
      head, '',
      'Ready to start?',
      '',
      `Kind: ${BUY_COMP_KINDS[draft.kind].label}`,
      draft.prizeSet && draft.prizeText ? `💰 Prize: ${draft.prizeText}` : '💰 Prize: (no prize text)',
      `🎯 Min qualifying buy: ${draft.minBuyUsd > 0 ? bbFmtUsd(draft.minBuyUsd) : 'any recorded buy'}`,
      `⏰ Runs: ${durLabel} from now`,
      ...(note ? ['', note] : []),
      '',
      'Starting posts the announcement in the group and opens the window immediately.',
    ].join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Start competition', callback_data: `mng:bbcompstart:${gid}` }],
      cancelRow,
    ] },
  };
}

/**
 * DM capture for the wizard's prize / min-buy steps. Consumes ONLY
 * while this admin's draft is awaiting a value; an invalid min buy
 * keeps the prompt armed (the bb-capture rule). On success the draft
 * advances and the next wizard step is sent as a fresh DM panel.
 */
export async function handleBuyCompCapture(dmChatId, message) {
  const userId = message?.from?.id;
  if (!userId) return false;
  const draft = await loadBbCompDraft(userId);
  if (!draft || !draft.awaiting) return false;
  const text = String(message?.text ?? '').trim();
  if (!text || text.startsWith('/')) return false;
  if (!(await canChangeInfo(draft.grpId, userId))) {
    await clearBbCompDraft(userId);
    await bbCaptureSay(dmChatId,
      '⛔ Competition setup cancelled: you no longer hold the Change Info permission in that group, so nothing was saved.');
    return true;
  }
  if (draft.awaiting === 'prize') {
    draft.prizeText = text.slice(0, BUY_COMP_PRIZE_MAX);
    draft.prizeSet = true;
    draft.awaiting = null;
    draft.stage = 'min';
  } else if (draft.awaiting === 'min') {
    const n = parseBuyUsd(text);
    if (n === null || n < 0 || n > BUY_MIN_MAX_USD) {
      await bbCaptureSay(dmChatId, `⚠️ Send the minimum qualifying buy as a USD amount (0 up to ${bbFmtUsd(BUY_MIN_MAX_USD)}) — e.g. 25 or $25. The prompt is still open.`);
      return true;
    }
    draft.minBuyUsd = n;
    draft.awaiting = null;
    draft.stage = 'dur';
  } else {
    return false;
  }
  await saveBbCompDraft(userId, draft);
  const panel = bbCompWizardPanel(draft);
  await api.sendMessage({
    chat_id: dmChatId, text: panel.text, reply_markup: panel.reply_markup,
  }).catch(() => {});
  return true;
}

// Display-only mirror of lib/tiers.js canonical ranks for the panel's
// tier-gate note. groups.js cannot import tiers.js (tiers.js imports
// groups.js), so the alias/rank tables are mirrored here for DISPLAY;
// the engine's fire-time gate in lib/tick.js uses the real tierAtLeast.
// TRIALFIX 2026-11-01 (bug 14): 'one' and 'trial' were missing here
// and fell through to free, so the panel told one/trial owners their
// campaign was held while the engine (CANONICAL_TIER_RANK one:5,
// trial:6, both ≥ starter) passed them. Ranks below MUST stay
// identical to CANONICAL_TIER_RANK in lib/tiers.js — if that map
// changes, this map changes in the same wave.
const BUY_TIER_ALIASES = { whale: 'agency', chad: 'pro', grinder: 'builder', poor: 'starter', hustler: 'free', dev_launch: 'agency' };
const BUY_TIER_RANK = { free: 0, starter: 1, builder: 2, pro: 3, agency: 4, one: 5, trial: 6 };
function buyTierRankOf(tier) {
  const t = String(tier ?? 'free').toLowerCase().trim();
  const canon = BUY_TIER_RANK[t] !== undefined ? t : (BUY_TIER_ALIASES[t] ?? 'free');
  return BUY_TIER_RANK[canon] ?? 0;
}

function bbFmtUsd(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}
function bbShortCa(ca) {
  const s = String(ca ?? '');
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

export async function canChangeInfo(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    if (!m) return false;
    if (m.status === 'creator') return true;
    if (m.status === 'administrator') return m.can_change_info === true;
    return false;
  } catch { return false; }
}

// Groups (from known_groups) where the user CURRENTLY holds the Change Info
// admin right — live check per group, capped at 12 like the source selector.
export async function getManageGroupsFor(userId) {
  let rows = [];
  try { rows = await db.select().from(known_groups).all(); } catch { return []; }
  const groups = [];
  for (const g of rows) {
    if (groups.length >= 12) break;
    if (await canChangeInfo(g.chatId, userId)) {
      groups.push({ chatId: String(g.chatId), title: g.title ?? String(g.chatId) });
    }
  }
  return groups;
}

// ── Mini App community chat — owner-only, per-community posting ──────────
// Decided 2026-11-01 (Rowdy): the OWNER of a community posts from the Mini
// App Chat window and it lands in THAT community, as PB (anonymous: the
// community sees PB, never the caller's personal account; PB server-side
// still knows the verified caller). Multi-community owners get a picker:
// one chosen community per post, never a broadcast, never a cross-post.
// Scope is OUTBOUND posting only — not an inbound mirror, not a relay for
// non-owners, not a way to post where PB is not a member or the caller
// does not own the community. The private brain Chat stays the default.
// Design intent (Rowdy, 2026-11-01): PB runs multiple communities through
// ONE chat/DM control surface — a community registered under PB is handled
// by PB from that surface, and the owner does NOT have to sit in each
// group's chat to run it. These helpers are therefore NOT hard-wired to
// the Chat screen: any future surface (a dashboard is the recorded
// follow-up, NOT part of this wave) can import them and reuse the same
// owner-proof, list, and sealed post logic. This wave's deliverable stays
// Mini App Chat only.
// Precedent (verified 2026-11-01 in poorboyai-archive/extracted/mainbot,
// artifacts/api-server/src/routes/user-campaign.ts): the old Replit
// dashboard (shill-bot SPA, protected /dashboard, /my-campaign,
// /community, /booster, /agents, /airdrop; campaigns also via the in-bot
// /setup wizard) kept per-user target groups in user_target_groups
// (clerk_user_id, chat_id, title, manager_telegram_id = the user's
// linked Telegram ID, so the bot knows who manages the group), with
// GET/POST/DELETE /api/user/groups and an auto-wired dedicated target
// for cantoutlawus (-1003744522779, marked ad-free). This picker is
// the Telegram/Mini App version of that table: per-owner managed
// communities, one chosen per post, PB delivering to the chosen target
// only, communities sealed. Differences, deliberate: the current model
// has no Clerk join (verified caller id from initData IS the manager
// id); this wave adds NO add/remove-target endpoints (the picker is
// server-built from known_groups + owner proof, never user-typed); and
// legacy target-group slot limits (free 1 / hustler 2 / grinder 4 /
// chad 8 / whale unlimited) are NOT reintroduced — what, if any,
// target-group limit applies under Free/trial/$29 is an OPEN follow-up
// for the parent, not silently enforced here and not silently waived
// into unlimited free targets (a free owner still proves ownership of
// each listed community; the pricing limit, if any, is separate).
// Owner proof (re-verified at list time AND at post time; a typed chat id
// is never trusted on its own):
//   (a) LIVE Telegram creator status — getChatMember(caller).status ===
//       'creator'. Creator status persists when the owner is absent, so
//       this does NOT require the owner to sit in, watch, or be active
//       in the group chat; it only requires Telegram to still list them
//       as creator. That is the "present in chat" flag, checked and
//       answered: presence/activity is NOT required, creator status is.
//   (b) PB-REGISTERED ownership — the caller owns an ACTIVE
//       user_campaign_slots row targeting this chat (they registered the
//       community under PB) AND a live getChatMember re-check still shows
//       them administrator-or-creator (campaign-fire parity: a demoted
//       slot owner loses the post right). Path (b) is deliberately
//       narrow: a Telegram admin with no creator status and no slot is
//       refused — this is NOT a general admin gate, and it is NOT a
//       bot-owner bypass (the bot owner gets no community they do not
//       own under (a) or (b)).
//   Plus, always: the chat is in known_groups (PB-tracked) AND PB itself
//   is a member/administrator/creator of it (PB is the sender).
//   Any check failing, or any API error on a check, excludes the chat
//   (fail closed). A post to community A can never appear in community
//   B: the post call carries exactly one chat_id, chosen and re-verified.
async function memberStatus(chatId, userId) {
  try {
    const m = await api.getChatMember({ chat_id: chatId, user_id: userId });
    return String(m?.status ?? '');
  } catch { return ''; }
}

export async function verifyOwnedCommunity(callerId, chatIdRaw) {
  const chatId = String(chatIdRaw ?? '').trim();
  if (!/^-?\d+$/.test(chatId)) return null;
  let row = null;
  try {
    row = await db.select().from(known_groups)
      .where(eq(known_groups.chatId, chatId)).get();
  } catch { return null; }
  if (!row) return null;
  const callerStatus = await memberStatus(chatId, String(callerId));
  let proof = null;
  if (callerStatus === 'creator') {
    proof = 'creator';
  } else if (callerStatus === 'administrator') {
    // PB-registered path: active slot owned by the caller for this chat.
    let slot = null;
    try {
      const slots = await db.select().from(user_campaign_slots)
        .where(and(
          eq(user_campaign_slots.ownerTelegramId, String(callerId)),
          eq(user_campaign_slots.targetChatId, chatId),
        )).all();
      slot = (slots ?? []).find((s) => s?.active) ?? null;
    } catch { slot = null; }
    if (slot) proof = 'registered';
  }
  if (!proof) return null;
  let botId = null;
  try { botId = (await api.getMe())?.id ?? null; } catch { botId = null; }
  if (!botId) return null;
  const botStatus = await memberStatus(chatId, botId);
  if (!['member', 'administrator', 'creator'].includes(botStatus)) return null;
  return { chatId, title: row.title ?? chatId, proof };
}

export async function listOwnedCommunities(callerId) {
  let rows = [];
  try { rows = await db.select().from(known_groups).all(); } catch (err) { throw err; }
  const out = [];
  for (const g of rows) {
    const verified = await verifyOwnedCommunity(callerId, g.chatId);
    if (verified) out.push({ chatId: verified.chatId, title: verified.title });
  }
  return out;
}

// Sealed, anonymous, single-destination post. Throws a plain Error with a
// .code for the endpoint to translate; the community-facing message is
// exactly `text` — no caller name, no attribution, no prefix. Slash
// commands are REFUSED here (never executed, never posted as literal
// text): a command typed in community-post mode is not a user message
// in that community, and faking one via sendMessage to trigger handlers
// is forbidden. The caller must run a real command in the community
// itself, or post plain text. The post is logged server-side as ids
// only (caller, chat, message id) in user_activity_log — the message
// text is never stored by this path.
export async function postToOwnedCommunity(callerId, chatIdRaw, textRaw) {
  const text = String(textRaw ?? '').trim();
  if (!text) { const e = new Error('Empty message'); e.code = 'EMPTY'; throw e; }
  if (text.length > 4000) { const e = new Error('Message too long'); e.code = 'TOO_LONG'; throw e; }
  if (text.startsWith('/')) {
    const e = new Error('Commands do not run from community-post mode. Post plain text, or run the command in the community itself.');
    e.code = 'COMMAND_REFUSED'; throw e;
  }
  const verified = await verifyOwnedCommunity(callerId, chatIdRaw);
  if (!verified) {
    const e = new Error('You do not own that community, or PB is not in it. Nothing was posted.');
    e.code = 'NOT_OWNED'; throw e;
  }
  let sent = null;
  try {
    sent = await api.sendMessage({ chat_id: verified.chatId, text });
  } catch (err) {
    console.error('[communityChat] sendMessage failed:', err?.message ?? err);
    const e = new Error('PB could not post to that community right now.');
    e.code = 'POST_FAILED'; throw e;
  }
  // Best-effort audit row (ids only). A log failure must not unsend a
  // post that already delivered, and must not hide the message id from
  // the caller — the community message itself is the delivery record.
  try {
    await db.insert(user_activity_log).values({
      telegramUserId: String(callerId), kind: 'miniapp_community_post',
      detail: `community:${verified.chatId} message:${sent?.message_id ?? ''}`,
    }).run();
  } catch (err) { console.error('[communityChat] audit log failed:', err?.message ?? err); }
  return { posted: true, chatId: verified.chatId, title: verified.title, messageId: sent?.message_id ?? null };
}

async function manageGroupTitle(chatId) {
  try {
    const row = await db.select().from(known_groups)
      .where(eq(known_groups.chatId, String(chatId))).get();
    if (row?.title) return row.title;
  } catch { /* fall through */ }
  try {
    const chat = await api.getChat({ chat_id: chatId });
    if (chat?.title) return chat.title;
  } catch { /* fall through */ }
  return String(chatId);
}

async function mngTrySend(chatId, text, extra = {}) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });
    return true;
  } catch { return false; }
}

async function mngEdit(dmChatId, messageId, text, replyMarkup) {
  if (dmChatId && messageId) {
    try {
      await api.editMessageText({
        chat_id: dmChatId, message_id: messageId,
        text: String(text).slice(0, 4000), reply_markup: replyMarkup,
      });
      return;
    } catch { /* message too old / unchanged — fall through to a fresh send */ }
  }
  if (dmChatId) await mngTrySend(dmChatId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
}

// The source grid (buildManageMenu :24205), same labels/order/callbacks.
// Phase 2: state is real now — Portal / Anti-Porn / Alphabets carry the
// source's ✅/❌ suffixes (read through getManageSettings, so the home
// group's Portal honestly shows ❌), Whitelist / Banned Words show live
// counts. Phase 3: Cross Protect carries a real mark too — ✅ only when
// the group's flag is on AND an active two-sided link exists.
export async function buildManageKeyboard(chatId, userId = null) {
  const f = (feature) => `mng:feat:${chatId}:${feature}`;
  const s = await getManageSettings(chatId);
  const mark = (on) => (on ? ' ✅' : ' ❌');
  let wlCount = 0;
  let bwCount = 0;
  let cpActive = false;
  try { wlCount = (await listWhitelist(chatId, 100)).length; } catch { /* counts are cosmetic */ }
  try { bwCount = (await listBannedWords(chatId, 100)).length; } catch { /* counts are cosmetic */ }
  // Cross Protect (Phase 3): the mark means REAL protection — own flag
  // on AND at least one ACTIVE two-sided link. The flag alone mirrors
  // nothing, so it never earns the ✅ by itself.
  try {
    cpActive = s.cross_protect === true
      && (await activeCrossProtectTargets(chatId)).length > 0;
  } catch { /* marks are cosmetic */ }
  // Buy Bot (Phase 2): ✅ only when a campaign targeting this group is
  // actually being watched (enabled, unpaused, campaign active); ❌ when
  // a campaign targets the group but is not watching; no mark at all
  // when no campaign targets the group (nothing to claim either way).
  let bbMark = '';
  try {
    const bbCamps = await buyCampaignsTargeting(chatId);
    if (bbCamps.length) {
      bbMark = bbCamps.some((c) => c.buyBotEnabled && !c.buyBotPaused && c.status === 'active')
        ? ' ✅' : ' ❌';
    }
  } catch { /* marks are cosmetic */ }
  // Tier Delegation (2026-10-22): the Delegation row appears ONLY for
  // the group's delegation owner (the subscriber whose campaign targets
  // the group) — it is their lending surface, not a general admin tool.
  // userId is optional so legacy renders stay unchanged; both live
  // callers (the /manage command and the menu callback) pass it.
  let dlgOwner = null;
  if (userId != null) {
    try { dlgOwner = await delegationOwnerForGroup(chatId); } catch { /* row is cosmetic */ }
  }
  const rows = [
    [
      { text: `⊕ Portal Setup${mark(s.portal === true)}`, callback_data: f('portal') },
      { text: '⚔️ Raid Setup', callback_data: f('raid') },
    ],
    [
      { text: '🦶 Remove Members', callback_data: f('remove') },
      { text: '👋 Greetings', callback_data: f('greetings') },
    ],
    [
      { text: '🛡️ Group Protection', callback_data: f('protection') },
      { text: `🔗 Whitelist${wlCount ? ` (${wlCount})` : ''}`, callback_data: f('whitelist') },
    ],
    [
      { text: '🔍 Filters', callback_data: f('filters') },
      { text: `🚫 Banned Words${bwCount ? ` (${bwCount})` : ''}`, callback_data: f('bannedwords') },
    ],
    [
      { text: '𝕏 Twitter Followers', callback_data: f('twitterfollowers') },
      { text: '📰 Twitter Feed', callback_data: f('twitterfeed') },
    ],
    [
      { text: '📣 Mention All', callback_data: f('mentionall') },
      { text: `💎 Buy Bot${bbMark}`, callback_data: f('buybot') },
    ],
    [
      { text: '🔰 Scam Blocker', callback_data: f('scamblocker') },
      { text: `🔞 Anti-Porn${mark(s.anti_porn === true)}`, callback_data: f('antiporn') },
    ],
    [
      // F19 auto-ad guard (2026-11-06): warn-only ad moderation, per-group
      // opt-in. New row only; every row above is byte-untouched.
      { text: `📢 Ad Guard${mark(s.ad_guard === true)}`, callback_data: f('adguard') },
    ],
    [
      { text: `🔤 Alphabets${mark(s.alphabets === true)}`, callback_data: f('alphabets') },
      { text: `🌐 Cross Protect${mark(cpActive)}`, callback_data: f('crossprotect') },
    ],
    [
      { text: '📅 Scheduled Tasks', callback_data: f('scheduled') },
    ],
    [
      // Setup Wizard (2026-11-04): guided Welcome -> Goodbye -> Rules ->
      // Socials over the same settings the commands write. New row only;
      // every row above is byte-untouched.
      { text: '🧭 Setup Wizard', callback_data: `mng:wiz:${chatId}` },
    ],
  ];
  if (dlgOwner && String(dlgOwner) === String(userId)) {
    rows.push([
      { text: '🤝 Delegation', callback_data: f('delegation') },
    ]);
  }
  rows.push([
    { text: '👥 Select Another Group', callback_data: 'mng:grps' },
  ]);
  return { inline_keyboard: rows };
}

export function managePanelText(title) {
  return `⚙️ Group Manager\n${title}\n────────────────\nPick a feature to set up.`;
}

export function manageSelectorKeyboard(groups) {
  return { inline_keyboard: groups.map((g) => [
    { text: g.title, callback_data: `mng:menu:${g.chatId}` },
  ]) };
}

const MANAGE_RESTORE_NOTE =
  '🚧 Being restored — this feature is not active yet. Nothing on this page changes your group today; the working controls return in a later phase of the Group Manager restore.';

// Feature pages. LIVE pages list only commands verified present in the live
// command registry (handlers/message.js + lib/opscmds.js); where the source
// page named a command that did not survive the port (/raidstop, /shill),
// the page says what actually works today instead. (/setgoodbye + /setflood
// were restored by the E4a wave, 2026-10-21 — their pages name them again.)
const MANAGE_LIVE_PAGES = {
  raid: [
    '⚔️ Raid Setup',
    '────────────────',
    '',
    'Organize raids and shill drives — members earn XP for participating.',
    '',
    'Commands:',
    '/raid <URL> — start a raid',
    '/raid stop — end the current raid',
    '/raidsetup — link + verify your X handle for automatic raid credit',
    '/lb — XP leaderboard',
    '/raidrank — raid hall of fame',
    '/profile — your raid stats',
  ].join('\n'),
  remove: [
    '🦶 Remove Members',
    '────────────────',
    '',
    'Commands (group admins):',
    '/kick @user — remove from group',
    '/ban @user — permanent ban',
    '/unban @user — lift a ban',
    '/mute @user [mins] — silence a member',
    '/unmute @user — restore voice',
    '/warn @user [reason] — issue a warning',
  ].join('\n'),
  greetings: [
    '👋 Greetings',
    '────────────────',
    '',
    'The welcome message new members see, plus your group rules.',
    '',
    'Commands:',
    '/setwelcome <msg> — custom welcome (placeholders: {name} {username} {group})',
    '/setwelcome off — turn welcome messages off',
    '/resetwelcome — clear the welcome message',
    '/setrules <text> — set the group rules',
    '/rules — show the rules',
    '/setgoodbye <msg> — goodbye message when a member leaves (placeholders: {name} {username} {group})',
    '/resetgoodbye — clear the goodbye message',
  ].join('\n'),
  protection: [
    '🛡️ Group Protection',
    '────────────────',
    '',
    'Commands:',
    '/fudshield on — FUD Shield on (watches for coordinated FUD waves and fires an AI counter-response)',
    '/fudshield off — FUD Shield off',
    '/scan <CA> — scan a contract for risk',
    '/setflood <limit> [seconds] — anti-flood: flooding deletes the triggering message only (never auto-mutes)',
    '/setflood 0 — turn anti-flood off',
    '/flood — show the current anti-flood setting',
  ].join('\n'),
  filters: [
    '🔍 Filters',
    '────────────────',
    '',
    'Keyword triggers — I auto-reply when a keyword is posted in the group.',
    '',
    'Commands:',
    '/filter <word> <reply text> — add a filter',
    '/unfilter <word> — remove a filter',
    '/filters — list all active filters',
  ].join('\n'),
  scamblocker: [
    '🔰 Scam Blocker',
    '────────────────',
    '',
    'Check tokens before your members ape in.',
    '',
    'Commands:',
    '/scan <CA> — contract scan (honeypot & risk check)',
    '/fudshield on|off — FUD detection for this group',
  ].join('\n'),
  mentionall: [
    '📣 Mention All',
    '────────────────',
    '',
    'Ping the group\'s registered members with an announcement. Run it in the group (group admins with a Builder+ plan; 10-minute cooldown).',
    '',
    'Command:',
    '/everyone [message] — mention all registered members',
    '',
    'Members get registered as they chat in the group; /syncmembers registers them in bulk.',
  ].join('\n'),
  scheduled: [
    '📅 Scheduled Tasks',
    '────────────────',
    '',
    'Auto-post messages to the group on a daily schedule. Run these in the group:',
    '',
    'Commands:',
    '/schedule HH:MM <message> — schedule a daily post (24h UTC)',
    '/schedules — list active schedules',
    '/unschedule <id> — remove a schedule',
  ].join('\n'),
};

// Parked features: described faithfully, clearly NOT active, no controls.
// (Portal / Whitelist / Banned Words / Anti-Porn / Alphabets graduated to
// real pages in Phase 2, Cross Protect in Phase 3, Buy Bot in its own
// Phase 2 — see renderManageFeaturePage below.)
const MANAGE_RESTORING_PAGES = {
  // Twitter Followers graduated to a live page in the wizard-fix wave
  // (2026-10-21) — twitterFollowersFeaturePage below. Twitter Feed stays
  // a deliberate do-not-restore.
  twitterfeed: ['📰 Twitter Feed', 'Auto-posts new tweets from your linked X (Twitter) account into the group.'],
};

export function manageFeaturePage(chatId, feature) {
  const back = { inline_keyboard: [[
    { text: '◀ Back to Menu', callback_data: `mng:menu:${chatId}` },
  ]] };
  if (MANAGE_LIVE_PAGES[feature]) {
    return { text: MANAGE_LIVE_PAGES[feature], reply_markup: back };
  }
  const restoring = MANAGE_RESTORING_PAGES[feature];
  if (restoring) {
    return { text: `${restoring[0]}\n\n${restoring[1]}\n\n${MANAGE_RESTORE_NOTE}`, reply_markup: back };
  }
  return null;
}

// ── Phase 2 real feature pages (async: live settings + table reads) ─────────
// Text follows the source pages (handleManageFeature :24282-24498),
// rendered plain. Controls are the source's own callback shapes:
// mng:toggle:<chatId>:<key>, mng:pset:<chatId>:<30|60|120>,
// mng:apa:<chatId>:<delete_warn|delete_ban>, mng:aba:<chatId>,
// mng:wldel:<chatId>:<userId>.

function backRow(chatId) {
  return [{ text: '◀ Back to Menu', callback_data: `mng:menu:${chatId}` }];
}

// Group Protection page (dynamic since PB Shield, 2026-10-21): the
// static command list plus Shield's live state for THIS group — on/off
// and, when on, whether PB actually holds the rights to enforce here.
async function protectionFeaturePage(chatId) {
  const s = await getGroupSettings(chatId);
  const on = s.shieldEnabled === true;
  let shieldState = 'OFF — /shield on enables it';
  if (on) {
    const r = await shieldRights(chatId);
    shieldState = (r.canDelete && r.canRestrict)
      ? 'ON — full protection (PB can delete + restrict here)'
      : 'ON — ALERT-ONLY here (PB lacks delete/restrict rights; it flags + logs but cannot act)';
  }
  const lines = [
    MANAGE_LIVE_PAGES.protection,
    '',
    'PB Shield — scam-bot protection (admins run these in the group):',
    '/shield on — Shield on: new-joiner watch, first-link quarantine, impersonation catch, scam-phrase strikes',
    '/shield off — Shield off',
    '/shield status — state, watch + strike counts, recent events',
    '/shield log — the last Shield events in this group',
    '',
    `Shield here: ${shieldState}`,
    '',
    'Link wizard: tap below to post the in-group wizard panel (members report, admins manage in DM), or run /shield in the group.',
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [
    [{ text: '🛡️ Open Shield link wizard in group', callback_data: `shield:wizsend:${chatId}` }],
    backRow(chatId),
  ] } };
}

async function portalFeaturePage(chatId) {
  const s = await getManageSettings(chatId);
  const isHome = String(chatId) === (await homeChatId());
  const on = s.portal === true && !isHome;
  const timeout = portalTimeoutOf(s);
  const mode = portalModeOf(s);
  const modeLabel = {
    holder: 'Holder check (tap unlocks; $PBAI holder check offered in DM)',
    human: 'Human only (the tap is the whole check)',
    both: 'Tap + holder (both steps required to unlock)',
  }[mode];
  const welcome = String(s.portal_welcome ?? '').trim();
  const bannerType = String(s.portal_banner_type ?? '');
  const hasBanner = Boolean(s.portal_banner_file_id) && ['photo', 'animation', 'video'].includes(bannerType);
  const lines = [
    '⊕ Portal Setup',
    '',
    'Verification gate for new member joins — your branded front door.',
    '',
    on ? 'Status: Active ✅' : 'Status: Inactive ❌',
    `Timeout: ${timeout} seconds`,
    `Verify mode: ${modeLabel}`,
    welcome
      ? `Welcome text: custom (${welcome.length} of ${PORTAL_WELCOME_MAX} characters)`
      : 'Welcome text: PB default',
    hasBanner
      ? `Banner: set (${{ photo: 'photo', animation: 'GIF', video: 'video' }[bannerType]})`
      : 'Banner: none',
    '',
  ];
  if (isHome) {
    lines.push('Portal is force-disabled in the official home group — this chat stays open.', '');
  }
  lines.push(
    mode === 'both'
      ? 'How it works: a new member is muted until BOTH steps finish — the "✅ Step 1 of 2" tap in the group, then the $PBAI holder check in their DMs. Both steps must finish inside the timeout.'
      : mode === 'human'
        ? 'How it works: a new member is muted until they tap "✅ I\'m Human — Verify Me". That tap is the whole check — no wallet, no DM follow-up.'
        : 'How it works: a new member is muted until they tap "✅ I\'m Human — Verify Me". Afterwards PB offers them an optional $PBAI holder check in DM (it unlocks the 1.5x holder XP boost — it never blocks the unlock).',
    'Anyone who does not verify in time is removed.',
    '',
    'Honest note: the timeout is enforced by a sweep that runs every few minutes (there is no always-on timer here), so an unverified member can stay muted a little past the timeout before being removed.',
    '',
    'Branding: your banner and your words are what members see. Telegram does not let bots recolor messages, so there are no color settings — the banner rides on top of the verification message and your welcome text leads it. Use {name} for the member\'s name and {group} for the group name in your text.',
    '',
    'The same settings (minus the banner, which is set here by sending media) are also in the Mini App: More → Group Portal.',
    '',
    'Whitelisted members skip the gate entirely.',
  );
  const kb = [
    [{ text: on ? '🔴 Disable Portal' : '🟢 Enable Portal', callback_data: `mng:toggle:${chatId}:portal` }],
    [30, 60, 120].map((t) => ({
      text: `${t === timeout ? '● ' : ''}${t}s`,
      callback_data: `mng:pset:${chatId}:${t}`,
    })),
    [
      { text: `${mode === 'holder' ? '● ' : ''}💎 Holder check`, callback_data: `mng:pmode:${chatId}:holder` },
      { text: `${mode === 'human' ? '● ' : ''}👆 Human only`, callback_data: `mng:pmode:${chatId}:human` },
    ],
    [{ text: `${mode === 'both' ? '● ' : ''}🔐 Both steps`, callback_data: `mng:pmode:${chatId}:both` }],
    [{ text: welcome ? '✏️ Change welcome text' : '✏️ Set welcome text', callback_data: `mng:ptext:${chatId}` }],
  ];
  if (welcome) {
    kb.push([{ text: '🗑️ Reset welcome text to default', callback_data: `mng:ptextclear:${chatId}` }]);
  }
  kb.push([{ text: hasBanner ? '🖼️ Change banner' : '🖼️ Set banner (photo / GIF / video)', callback_data: `mng:pbanner:${chatId}` }]);
  if (hasBanner) {
    kb.push([{ text: '🗑️ Remove banner', callback_data: `mng:pbannerclear:${chatId}` }]);
  }
  kb.push(backRow(chatId));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function whitelistFeaturePage(chatId) {
  const rows = await listWhitelist(chatId, 8);
  const lines = [
    '🔗 Whitelist',
    '',
    'Whitelisted users skip portal verification, anti-porn and alphabets checks.',
    '',
  ];
  if (!rows.length) lines.push('No one is whitelisted yet.');
  else {
    lines.push('Current whitelist:');
    for (const r of rows) lines.push(`• ${r.username ? '@' + r.username : 'ID ' + r.userId}`);
  }
  lines.push('', 'Add or remove in the group with:', '/wl @user — toggle whitelist');
  const kb = rows.map((r) => [{
    text: `🗑️ Remove ${r.username ? '@' + r.username : 'ID ' + r.userId}`,
    callback_data: `mng:wldel:${chatId}:${r.userId}`,
  }]);
  kb.push(backRow(chatId));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

async function bannedWordsFeaturePage(chatId) {
  const words = await listBannedWords(chatId, 10);
  const lines = [
    '🚫 Banned Words',
    '',
    'Messages containing a banned word are deleted automatically. Group admins are exempt.',
    '',
  ];
  if (!words.length) lines.push('No banned words yet.');
  else {
    lines.push('Current list:');
    words.forEach((w, i) => lines.push(`${i + 1}. ${w}`));
  }
  lines.push(
    '',
    'Manage in the group (admins with Delete Messages permission):',
    '/addban <word> — add a word or phrase',
    '/removeban <word> — remove one',
    '/bans — show the list',
  );
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [backRow(chatId)] } };
}

async function antiPornFeaturePage(chatId) {
  const s = await getManageSettings(chatId);
  const on = s.anti_porn === true;
  const action = s.anti_porn_action === 'delete_ban' ? 'delete_ban' : 'delete_warn';
  const lines = [
    '🔞 Anti-Porn',
    '',
    'Auto-deletes NSFW media (photos, videos, GIFs) whose caption matches the NSFW keyword list, then warns or bans the poster. Admins and whitelisted members are exempt.',
    '',
    on ? 'Status: Active ✅' : 'Status: Inactive ❌',
    `Action: ${action === 'delete_ban' ? 'Delete + Ban' : 'Delete + Warn'}`,
  ];
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: on ? '🔴 Disable Anti-Porn' : '🟢 Enable Anti-Porn', callback_data: `mng:toggle:${chatId}:anti_porn` }],
      [
        { text: `${action === 'delete_warn' ? '● ' : ''}⚠️ Delete + Warn`, callback_data: `mng:apa:${chatId}:delete_warn` },
        { text: `${action === 'delete_ban' ? '● ' : ''}🔨 Delete + Ban`, callback_data: `mng:apa:${chatId}:delete_ban` },
      ],
      backRow(chatId),
    ] },
  };
}

async function adGuardFeaturePage(chatId) {
  const s = await getManageSettings(chatId);
  const on = s.ad_guard === true;
  const max = await getWarnMax(chatId);
  const own = s.tokenLabel ?? s.tokenAddress ?? null;
  const lines = [
    '📢 Ad Guard',
    '',
    'Warns members who post advertising in this group — referral links, links to other Telegram groups or bots, and contract addresses for tokens other than this group\'s own. The message is NOT deleted; the poster gets a warning, and at the warn limit they are banned automatically. Admins and whitelisted members are exempt.',
    '',
    on ? 'Status: Active ✅' : 'Status: Inactive ❌',
    `Warn limit: ${max} (change with /setwarnmax 1–10)`,
    own
      ? `Own project: ${own} — links to it never count as advertising.`
      : 'Own project: not set — run /settoken <contract address> in the group so links to your own token never count.',
  ];
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: on ? '🔴 Disable Ad Guard' : '🟢 Enable Ad Guard', callback_data: `mng:toggle:${chatId}:ad_guard` }],
      backRow(chatId),
    ] },
  };
}

async function alphabetsFeaturePage(chatId) {
  const s = await getManageSettings(chatId);
  const on = s.alphabets === true;
  const lines = [
    '🔤 Alphabets',
    '',
    'Flags new members whose display name contains non-Latin characters (Cyrillic, Arabic, Chinese…) with a note in the group for admin review.',
    '',
    on ? 'Status: Active ✅' : 'Status: Inactive ❌',
    'Action: Notify only — no automatic mute or removal, by design.',
  ];
  return {
    text: lines.join('\n'),
    reply_markup: { inline_keyboard: [
      [{ text: on ? '🔴 Disable Alphabets' : '🟢 Enable Alphabets', callback_data: `mng:toggle:${chatId}:alphabets` }],
      [{ text: '🔔 Action: Notify only', callback_data: `mng:aba:${chatId}` }],
      backRow(chatId),
    ] },
  };
}

// Phase 3 page (source handleManageFeature crossprotect case :24452,
// consent flow per the Phase 3 header note). userId is the panel viewer:
// the "link a group" picker lists groups where THEY hold Change Info.
async function crossProtectFeaturePage(chatId, userId) {
  const s = await getManageSettings(chatId);
  const flagOn = s.cross_protect === true;
  const links = await listCrossProtectLinks(chatId);
  const active = links.filter((l) => l.active);
  const incoming = links.filter((l) => !l.active && l.theirs && !l.mine);
  const outgoing = links.filter((l) => !l.active && l.mine && !l.theirs);
  const on = flagOn && active.length > 0;
  const titleOf = async (id) => {
    const t = await manageGroupTitle(id);
    return t === String(id) ? `Group ${id}` : t;
  };
  const short = (t) => (t.length > 24 ? `${t.slice(0, 23)}…` : t);

  const lines = [
    '🌐 Cross Protect',
    '',
    'When a member is banned with /ban in one linked group, the ban mirrors to every other linked group. Only /ban mirrors — kicks, mutes and unbans do not.',
    '',
    on ? 'Status: Active ✅' : 'Status: Inactive ❌',
    flagOn
      ? 'This group\'s switch: ON'
      : 'This group\'s switch: OFF — no bans mirror in or out while it is off, even across confirmed links.',
    '',
  ];
  const kb = [
    [{ text: flagOn ? '🔴 Disable Cross Protection' : '🟢 Enable Cross Protection', callback_data: `mng:toggle:${chatId}:cross_protect` }],
  ];

  lines.push('Linked groups (confirmed by both sides):');
  if (!active.length) lines.push('• None yet');
  for (const l of active) {
    const t = await titleOf(l.otherId);
    lines.push(`• ${t}`);
    kb.push([{ text: `🔓 Unlink ${short(t)}`, callback_data: `mng:cpunlink:${chatId}:${l.otherId}` }]);
  }
  lines.push('');

  // PB Relay Wave 3: relay rules riding these links (consent Path B)
  // are visible to both sides' admins here — inflow can be stopped
  // from the destination chat itself (/relaystop) and re-opened there
  // (/relay resume <rule id>). Visibility only; failures never break
  // the page.
  try {
    const cpDests = await db.select().from(relay_rule_destinations)
      .where(eq(relay_rule_destinations.consentMode, 'cp_link')).all();
    const relayLines = [];
    for (const d of cpDests) {
      const r = await db.select().from(relay_rules)
        .where(eq(relay_rules.id, d.ruleId)).get().catch(() => null);
      if (!r || r.status === 'deleted') continue;
      if (String(d.destChatId) === String(chatId)) {
        relayLines.push(`• Rule #${r.id}: posts from ${await titleOf(r.sourceChatId)} relay INTO this group — destination ${d.status}`);
      } else if (String(r.sourceChatId) === String(chatId)) {
        relayLines.push(`• Rule #${r.id}: this group's posts relay into ${await titleOf(d.destChatId)} — destination ${d.status}`);
      }
    }
    if (relayLines.length) {
      lines.push('PB Relay rules riding these links:');
      lines.push(...relayLines);
      lines.push('Admins here can stop relays into this group any time with /relaystop (in the group) and re-open them with /relay resume <rule id>.');
      lines.push('');
    }
  } catch { /* visibility only */ }

  if (incoming.length) {
    lines.push('Requests waiting for YOUR confirmation — an admin of that group asked to link:');
    for (const l of incoming) {
      const t = await titleOf(l.otherId);
      lines.push(`• ${t}`);
      kb.push([{ text: `✅ Confirm link: ${short(t)}`, callback_data: `mng:cpconfirm:${chatId}:${l.otherId}` }]);
      kb.push([{ text: `✖ Decline: ${short(t)}`, callback_data: `mng:cpunlink:${chatId}:${l.otherId}` }]);
    }
    lines.push('');
  }

  if (outgoing.length) {
    lines.push('Requests you sent — waiting for the other group\'s admin to confirm from their panel:');
    for (const l of outgoing) {
      const t = await titleOf(l.otherId);
      lines.push(`• ${t}`);
      kb.push([{ text: `✖ Cancel request: ${short(t)}`, callback_data: `mng:cpunlink:${chatId}:${l.otherId}` }]);
    }
    lines.push('');
  }

  lines.push(
    'How linking works: an admin requests a link below (or with /crosslink [chatId] inside the group). The link turns on only when an admin of the OTHER group confirms it from their own Cross Protect panel. Nothing is ever linked one-sided, and either side can unlink or switch off at any time.',
  );

  if (userId) {
    const paired = new Set(links.map((l) => String(l.otherId)));
    const mine = (await getManageGroupsFor(userId))
      .filter((g) => String(g.chatId) !== String(chatId) && !paired.has(String(g.chatId)))
      .slice(0, 6);
    if (mine.length) {
      lines.push('', 'Link one of your other groups:');
      for (const g of mine) {
        kb.push([{ text: `🔗 Link ${short(g.title)}`, callback_data: `mng:cplink:${chatId}:${g.chatId}` }]);
      }
    }
  }
  lines.push('', 'Command: /crosslink [chatId] — request or confirm a link from inside the group');

  kb.push(backRow(chatId));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

// Buy Bot page (Buy Bot Phase 2 — the original's bb: panel, rendered on
// the mng: chassis): the campaign resolved from THIS group, its live
// settings, 24h stats from buy_events, and real pause/resume +
// enable/disable + hourly-card controls (mng:bbpause/bbtoggle/bbhourly).
// Phase 3 adds the field captures: tapping a ✏️ setting arms a one-shot
// DM capture (mng:bbset → handleBuyBotCapture) — the original's bb:set:*
// sessions — plus a clear-banner action (mng:bbclearmedia).
async function buyBotFeaturePage(chatId, userId) {
  const camps = await buyCampaignsTargeting(chatId);
  if (!camps.length) {
    return {
      text: [
        '💎 Buy Bot',
        '',
        'No campaign is posting into this group yet, so there is nothing to watch here.',
        '',
        'How it works: a member creates a campaign (Mini App → 📣 My Campaign, or /setup in a DM with me), adds this group as a posting slot, and enables Buy Bot here. PB then watches the campaign\'s token and posts every qualifying buy into this group — with the campaign\'s alert emoji, minimum-buy and whale settings.',
        '',
        'Once a campaign targets this group, this page shows its live settings, 24h buy stats for the group, and the pause / resume / enable controls.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [backRow(chatId)] },
    };
  }
  const camp = camps.find((c) => String(c.ownerTelegramId) === String(userId)) ?? camps[0];
  const mine = String(camp.ownerTelegramId) === String(userId);
  const s = await getManageSettings(chatId);
  const hourlyOn = s.buy_hourly !== false; // campaign groups default ON
  const stats = await buyStatsForChat(chatId, Math.floor(Date.now() / 1000) - 86400);

  const enabled = Boolean(camp.buyBotEnabled);
  const paused = Boolean(camp.buyBotPaused);
  const status = camp.status !== 'active'
    ? '⏸ The campaign itself is paused — resume it from /campaign or the Mini App.'
    : !enabled
      ? '🔴 Disabled — no buys are watched or posted.'
      : paused
        ? '⏸ Paused — settings kept, alerts held.'
        : '▶️ Watching — qualifying buys post into this group.';

  // Tier gate (display mirror — the engine re-checks the real gate at
  // fire time; a held campaign says so here instead of silently idling).
  let tierNote = '';
  try {
    const ownerRow = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(camp.ownerTelegramId))).get();
    const ownerIsBotOwner = await isOwnerId(camp.ownerTelegramId).catch(() => false);
    if (!ownerIsBotOwner && buyTierRankOf(ownerRow?.tier) < BUY_TIER_RANK.starter) {
      tierNote = '⚠️ The campaign owner\'s plan is currently below Starter — the watcher holds this campaign\'s alerts until the plan is Starter or higher.';
    }
  } catch { /* the note is advisory; the engine gate is the real one */ }

  const lines = [
    '💎 Buy Bot',
    '',
    `Campaign: ${camp.projectName} ($${camp.ticker})${mine ? ' — yours' : ''}`,
    ...(camps.length > 1 ? [`(${camps.length} campaigns post into this group — showing ${mine ? 'yours' : 'the first one'}.)`] : []),
    `Status: ${status}`,
    '',
    `Token: ${camp.contractAddress ? bbShortCa(camp.contractAddress) : '— no contract set —'} · ${camp.chain === 'sol' ? 'Solana' : 'Base'}`,
    `Alert emoji: ${camp.buyEmoji || '💸'} · Min buy: ${bbFmtUsd(camp.buyMinUsd ?? 0.5)} · Whale: ${Number(camp.whaleThresholdUsd) > 0 ? `≥ ${bbFmtUsd(camp.whaleThresholdUsd)}` : 'off'}`,
    `Known-whale badge: ${Number(camp.buyWhaleBalanceUsd) > 0 ? `buyers with a wallet balance ≥ ${bbFmtUsd(camp.buyWhaleBalanceUsd)} get 🐋 (balance, not buy size)` : 'off'}`,
    `Emoji bar: ${Number(camp.buyStepUsd) > 0 ? `one emoji per ${bbFmtUsd(camp.buyStepUsd)} bought` : 'classic $1→$5000 bar'}`,
    `Banner: ${camp.buyMediaFileId ? `set (${camp.buyMediaType ?? 'photo'})` : 'none (text alerts)'}`,
    `Hourly stats card (this group): ${hourlyOn ? 'On' : 'Off'}`,
    '',
    stats.count
      ? `📊 Last 24h in this group: ${stats.count} buy${stats.count > 1 ? 's' : ''} · ${bbFmtUsd(stats.volumeUsd)} volume · biggest ${bbFmtUsd(stats.biggestUsd)} · ${stats.uniqueBuyers} unique buyer${stats.uniqueBuyers === 1 ? '' : 's'}`
      : '📊 Last 24h in this group: no qualifying buys recorded yet.',
  ];
  if (tierNote) lines.push('', tierNote);

  // Buy Bot Phase 5 — competitions for THIS campaign in THIS group:
  // live standings while one runs, the last result once one has ended,
  // and the setup/lifecycle buttons (rendered after the settings rows).
  const activeComp = await getActiveBuyCompetition(chatId, camp.id);
  let compButtons = [];
  if (activeComp) {
    const st = await buyCompetitionStandings(activeComp, true);
    lines.push('', `🏆 Competition LIVE: ${BUY_COMP_KINDS[activeComp.kind].label} · ends in ${buyCompTimeLeft(activeComp.endAt)}`);
    if (activeComp.prizeText) lines.push(`💰 Prize: ${activeComp.prizeText}`);
    lines.push(`🎯 Min qualifying buy: ${bbFmtUsd(activeComp.minBuyUsd)}`);
    if (activeComp.kind === 'raffle') {
      lines.push(`🎟 Tickets so far: ${st.tickets} from ${st.uniqueBuyers} buyer${st.uniqueBuyers === 1 ? '' : 's'}`);
    } else {
      lines.push(st.biggest
        ? `🥇 Biggest so far: ${bbFmtUsd(Number(st.biggest.usdAmount) || 0)} by ${bbShortCa(st.biggest.buyerAddress ?? '')}`
        : '🥇 No qualifying buys yet');
    }
    compButtons = [[
      { text: '⏹ End competition now', callback_data: `mng:bbcompend:${chatId}` },
      { text: '✖ Cancel competition', callback_data: `mng:bbcompcancel:${chatId}` },
    ]];
  } else {
    const last = await getLatestEndedBuyCompetition(chatId, camp.id);
    if (last) {
      let resultLine = 'no qualifying buys — no winner';
      if (last.winnerTxHash) {
        const winRow = (await buyCompetitionQualifyingBuys(last))
          .find((r) => r.txHash === last.winnerTxHash);
        resultLine = `won by ${bbShortCa(last.winnerAddress ?? '')}${winRow ? ` with a ${bbFmtUsd(Number(winRow.usdAmount) || 0)} buy` : ''}`;
      }
      lines.push('', `🏆 Last competition: ${BUY_COMP_KINDS[last.kind].label} — ${resultLine}.`);
    }
    if (camp.status === 'active') {
      compButtons = [[{ text: '🏆 New buy competition', callback_data: `mng:bbcompnew:${chatId}` }]];
    }
  }
  lines.push(
    '',
    'Buys are checked every few minutes (this watcher runs on PB\'s clock, not real-time), so an alert can land a few minutes after the buy.',
    'Pausing holds alerts for this campaign in ALL its groups. Disabling keeps every setting and all recorded history.',
    'Tap a ✏️ setting below, then send the new value here in this DM (banner: send the photo/GIF/video). These are CAMPAIGN settings — a change applies in every group the campaign posts to. In the group itself, admins can also use /setemoji, /setminbuy, /setwhale, /setwhalebal, /setstep and /setgif.',
  );

  const kb = [];
  if (camp.status === 'active') {
    if (!enabled) {
      kb.push([{ text: '🟢 Enable Buy Bot', callback_data: `mng:bbtoggle:${chatId}` }]);
    } else {
      kb.push([{ text: paused ? '▶️ Resume alerts' : '⏸ Pause alerts', callback_data: `mng:bbpause:${chatId}` }]);
      kb.push([{ text: '🔴 Disable Buy Bot', callback_data: `mng:bbtoggle:${chatId}` }]);
    }
    kb.push([
      { text: '✏️ Emoji', callback_data: `mng:bbset:${chatId}:emoji` },
      { text: '✏️ Min buy', callback_data: `mng:bbset:${chatId}:min` },
    ]);
    kb.push([
      { text: '✏️ Whale', callback_data: `mng:bbset:${chatId}:whale` },
      { text: '✏️ Emoji step', callback_data: `mng:bbset:${chatId}:step` },
    ]);
    kb.push([
      { text: '🐋 Whale badge', callback_data: `mng:bbset:${chatId}:whalebal` },
      { text: '🖼 Set banner', callback_data: `mng:bbset:${chatId}:banner` },
    ]);
    if (camp.buyMediaFileId) {
      kb.push([{ text: '🧹 Clear banner', callback_data: `mng:bbclearmedia:${chatId}` }]);
    }
  }
  for (const row of compButtons) kb.push(row);
  kb.push([{ text: `📊 Hourly stats card: ${hourlyOn ? 'On' : 'Off'}`, callback_data: `mng:bbhourly:${chatId}` }]);
  kb.push(backRow(chatId));
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}

// ── Twitter Followers page (Wizard-fix wave, 2026-10-21) ───────────────────
// The truthful version of the original's page: the follower count for the
// group's linked X handle (group_settings.twitter_handle — the key the
// rescued-settings merge restored), read live from X's public user lookup
// with PB's app bearer (the TWITTER_* family Rowdy directed be used; same
// resolution as lib/digest.js's xAppBearer). 10-minute config cache so
// panel browsing never hammers X. Every failure renders honest copy —
// counts are never fabricated.
let xFetchOverride = null;
export function __setXFetchForTest(fn) { xFetchOverride = fn; }

async function xBearerForGroups() {
  const stored = await getConfig('TWITTER_BEARER_TOKEN', null).catch(() => null);
  if (stored) return stored;
  const key = await getConfig('TWITTER_API_KEY', null).catch(() => null);
  const secret = await getConfig('TWITTER_API_SECRET', null).catch(() => null);
  if (!key || !secret) return null;
  const basic = btoa(unescape(encodeURIComponent(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`)));
  const doFetch = xFetchOverride ?? fetch;
  const res = await doFetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = await res.json().catch(() => null);
  return j?.access_token ?? null;
}

const TWFOLLOWERS_TTL_MS = 10 * 60 * 1000;

async function twitterFollowersFeaturePage(chatId) {
  const back = backRow(chatId);
  const settings = await getGroupSettings(chatId).catch(() => ({}));
  const handle = String(settings?.twitter_handle ?? '').replace(/^@/, '').trim();
  const head = '𝕏 Twitter Followers\n';
  if (!handle) {
    return {
      text: [
        head,
        'No X handle is linked to this group yet, so there is nothing to count.',
        '',
        'The handle is set in the group\'s rescued settings (twitter_handle). Once one is linked, this page shows its live follower count from X.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [back] },
    };
  }
  const cacheKey = `twfollowers:${chatId}`;
  let snap = null;
  try {
    const raw = await getConfig(cacheKey, null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.handle === handle && Date.now() - Number(parsed.at ?? 0) < TWFOLLOWERS_TTL_MS) snap = parsed;
    }
  } catch { /* cache is best-effort */ }
  if (!snap) {
    const bearer = await xBearerForGroups();
    if (bearer) {
      const doFetch = xFetchOverride ?? fetch;
      const res = await doFetch(
        `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,created_at`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      ).catch(() => null);
      if (res?.ok) {
        const j = await res.json().catch(() => null);
        const m = j?.data?.public_metrics;
        if (m && typeof m.followers_count === 'number') {
          snap = {
            handle,
            followers: m.followers_count,
            following: m.following_count ?? null,
            tweets: m.tweet_count ?? null,
            name: j.data.name ?? null,
            at: Date.now(),
          };
          await setConfig(cacheKey, JSON.stringify(snap)).catch(() => {});
        }
      }
    }
  }
  if (!snap) {
    return {
      text: [
        head,
        `Linked handle: @${handle}`,
        '',
        '⚠️ X didn\'t return follower data just now (rate limit or a temporary X error). Nothing is cached or estimated — reopen this page in a bit and PB will read it live.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [back] },
    };
  }
  const fmt = (n) => Number(n).toLocaleString('en-US');
  return {
    text: [
      head,
      `🐦 @${snap.handle}${snap.name ? ` — ${snap.name}` : ''}`,
      '',
      `👥 Followers: ${fmt(snap.followers)}`,
      snap.following != null ? `➡️ Following: ${fmt(snap.following)}` : null,
      snap.tweets != null ? `📝 Posts: ${fmt(snap.tweets)}` : null,
      '',
      `_Live from X · read ${new Date(snap.at).toUTCString()} · refreshes at most every 10 minutes._`,
    ].filter((l) => l !== null).join('\n'),
    reply_markup: { inline_keyboard: [back] },
  };
}

// Feature-page dispatcher: the five Phase-2 features, Cross Protect
// (Phase 3) and Buy Bot render live pages; everything else falls back to
// the Phase-1 sync pages.
export async function renderManageFeaturePage(chatId, feature, userId) {
  switch (feature) {
    case 'portal': return portalFeaturePage(chatId);
    case 'whitelist': return whitelistFeaturePage(chatId);
    case 'bannedwords': return bannedWordsFeaturePage(chatId);
    case 'antiporn': return antiPornFeaturePage(chatId);
    case 'adguard': return adGuardFeaturePage(chatId);
    case 'alphabets': return alphabetsFeaturePage(chatId);
    case 'crossprotect': return crossProtectFeaturePage(chatId, userId);
    case 'buybot': return buyBotFeaturePage(chatId, userId);
    case 'protection': return protectionFeaturePage(chatId);
    case 'delegation': return delegationFeaturePage(chatId, userId);
    case 'twitterfollowers': return twitterFollowersFeaturePage(chatId);
    default: return manageFeaturePage(chatId, feature);
  }
}

async function sendManageSelector(dmChatId, userId) {
  const groups = await getManageGroupsFor(userId);
  if (!groups.length) {
    await mngTrySend(dmChatId,
      '⚙️ Group Manager\n────────────────\nNo groups configured yet.\n\nAdd me to your group as an admin with the Change Info permission, then type /manage in the group to get started.');
    return 0;
  }
  await mngTrySend(dmChatId, '⚙️ Group Manager\n────────────────\nSelect a group to configure:',
    { reply_markup: manageSelectorKeyboard(groups) });
  return groups.length;
}

// /start manage deep-link (the in-group fallback button lands here): show the
// caller's selector when they admin at least one known group, else guidance.
export async function handleManageStartPayload(dmChatId, userId) {
  await sendManageSelector(dmChatId, userId);
}

// ── Setup Wizard (2026-11-04) ─────────────────────────────────────────────
// Guided group setup inside /manage: Welcome -> Goodbye -> Rules -> Socials.
// It writes the SAME settings keys the commands write (welcomeMsg +
// welcomeEnabled, goodbyeMsg, rules) plus a new group_socials JSON object
// for per-group /socials overrides. The /manage Greetings page is untouched;
// the wizard is a guided path over the same settings, not a replacement.
// No new commands, no new modules. Callback data stays well under the
// Telegram 64-byte cap (longest: mng:wizsoc:<chatId>:whatsapp, ~31 chars).
const SETUP_WIZ_CAP_TTL_MS = 10 * 60 * 1000;
const setupWizCapKey = (userId) => `setupwizcap:${userId}`;
const SETUP_WIZ_SOCIAL_FIELDS = [
  ['website', '🌐 Website'],
  ['telegram', '💬 Telegram Community'],
  ['discord', '🎮 Discord'],
  ['twitter', '🐦 Twitter/X'],
  ['tiktok', '🎵 TikTok'],
  ['reddit', '🟠 Reddit'],
  ['facebook', '📘 Facebook'],
  ['whatsapp', '💬 WhatsApp Channel'],
];

function setupWizardSocialLabel(field) {
  return (SETUP_WIZ_SOCIAL_FIELDS.find(([k]) => k === field) ?? [field, field])[1];
}

/** group_socials as a plain object ({} when unset/malformed). */
export function setupWizardGroupSocials(s) {
  const raw = s?.group_socials;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  return {};
}

function setupWizardTrunc(t, n = 80) {
  const v = String(t ?? '').replace(/\n/g, ' ').trim();
  if (!v) return '';
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

export async function setupWizardPage(grpId) {
  const s = await getGroupSettings(grpId);
  const title = await manageGroupTitle(grpId);
  const over = setupWizardGroupSocials(s);
  const customCount = SETUP_WIZ_SOCIAL_FIELDS.filter(([k]) => String(over[k] ?? '').trim()).length;
  const text = [
    '🧭 Setup Wizard',
    `Group: ${title}`,
    '────────────────',
    '',
    `👋 Welcome: ${s.welcomeEnabled && s.welcomeMsg ? setupWizardTrunc(s.welcomeMsg) : 'not set'}`,
    `👋 Goodbye: ${s.goodbyeMsg ? setupWizardTrunc(s.goodbyeMsg) : 'not set'}`,
    `📜 Rules: ${s.rules ? setupWizardTrunc(s.rules) : 'not set'}`,
    `🌐 Socials: ${customCount ? `${customCount} custom link${customCount === 1 ? '' : 's'} (rest PB official)` : 'PB official'}`,
    '',
    'Set or reset each piece — the same settings the /setwelcome, /setgoodbye and /setrules commands write.',
  ].join('\n');
  const w = (step) => `mng:wizset:${grpId}:${step}`;
  const r = (step) => `mng:wizreset:${grpId}:${step}`;
  return {
    text,
    reply_markup: { inline_keyboard: [
      [{ text: '✏️ Set Welcome', callback_data: w('welcome') }, { text: '🗑️ Reset', callback_data: r('welcome') }],
      [{ text: '✏️ Set Goodbye', callback_data: w('goodbye') }, { text: '🗑️ Reset', callback_data: r('goodbye') }],
      [{ text: '✏️ Set Rules', callback_data: w('rules') }, { text: '🗑️ Reset', callback_data: r('rules') }],
      [{ text: '🌐 Social Links →', callback_data: `mng:wizsoc:${grpId}` }],
      [{ text: '◀ Back to Menu', callback_data: `mng:menu:${grpId}` }],
    ] },
  };
}

export async function setupWizardSocialsPage(grpId) {
  const s = await getGroupSettings(grpId);
  const title = await manageGroupTitle(grpId);
  const over = setupWizardGroupSocials(s);
  const lines = [
    '🌐 Social Links',
    `Group: ${title}`,
    '────────────────',
    '',
    'These override what /socials shows in THIS group only. Anything not set here shows PB\'s official link.',
    '',
  ];
  for (const [key, label] of SETUP_WIZ_SOCIAL_FIELDS) {
    const v = String(over[key] ?? '').trim();
    lines.push(`${label}: ${v || 'PB official'}`);
  }
  lines.push('', 'Tap a field to set it. Send "off" to go back to PB official for that field.');
  const rows = [];
  for (let i = 0; i < SETUP_WIZ_SOCIAL_FIELDS.length; i += 2) {
    rows.push(SETUP_WIZ_SOCIAL_FIELDS.slice(i, i + 2).map(([key, label]) => (
      { text: `✏️ ${label}`, callback_data: `mng:wizfield:${grpId}:${key}` }
    )));
  }
  rows.push([{ text: '🗑️ Clear all socials', callback_data: `mng:wizclear:${grpId}` }]);
  rows.push([{ text: '◀ Back to Setup', callback_data: `mng:wiz:${grpId}` }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

/** Single write path for wizard text steps (callbacks + capture + proof share it). text null = reset. */
export async function setupWizardApplyText(grpId, step, text) {
  if (step === 'welcome') {
    if (text == null) await setGroupSettings(grpId, { welcomeMsg: null, welcomeEnabled: false });
    else await setGroupSettings(grpId, { welcomeMsg: String(text).slice(0, 1000), welcomeEnabled: true });
  } else if (step === 'goodbye') {
    if (text == null) await setGroupSettings(grpId, { goodbyeMsg: null });
    else await setGroupSettings(grpId, { goodbyeMsg: String(text).slice(0, 1000) });
  } else if (step === 'rules') {
    if (text == null) await setGroupSettings(grpId, { rules: null });
    else await setGroupSettings(grpId, { rules: String(text) });
  }
  return getGroupSettings(grpId);
}

/** Single write path for one social field (value null = delete the override). */
export async function setupWizardApplySocial(grpId, field, value) {
  const s = await getGroupSettings(grpId);
  const over = setupWizardGroupSocials(s);
  if (value == null) delete over[field];
  else over[field] = value;
  await setGroupSettings(grpId, { group_socials: over });
  return over;
}

export async function setupWizardClearSocials(grpId) {
  await setGroupSettings(grpId, { group_socials: {} });
  return {};
}

export async function armSetupWizardCapture(userId, grpId, title, step, field = null) {
  await setConfig(setupWizCapKey(userId), JSON.stringify({
    grpId: String(grpId), title: title ?? 'your group', step, field,
    expiresAt: Date.now() + SETUP_WIZ_CAP_TTL_MS,
  })).catch(() => {});
}
export async function clearSetupWizardCapture(userId) {
  await setConfig(setupWizCapKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});
}
export async function loadSetupWizardCapture(userId) {
  try {
    const raw = await getConfig(setupWizCapKey(userId), null);
    if (!raw) return { sess: null, expired: false };
    const sess = JSON.parse(raw);
    if (!sess?.grpId || !sess?.step) return { sess: null, expired: false };
    if (!sess.expiresAt || Date.now() > sess.expiresAt) return { sess: null, expired: true };
    return { sess, expired: false };
  } catch { return { sess: null, expired: false }; }
}

/** wizcancel — clears the armed capture. Returns { text } for the router's toast. */
export async function handleSetupWizardCancel(query) {
  const userId = query.from?.id;
  if (!userId) return null;
  await clearSetupWizardCapture(userId);
  return { text: 'Setup step cancelled.' };
}

/** DM capture: the admin's next DM text becomes the wizard step's value. */
export async function handleSetupWizardCapture(dmChatId, message) {
  const userId = message?.from?.id;
  if (!userId) return false;
  const text = String(message?.text ?? '');
  if (!text || text.startsWith('/')) return false;
  const { sess, expired } = await loadSetupWizardCapture(userId);
  if (!sess) {
    if (expired) {
      await clearSetupWizardCapture(userId);
      await api.sendMessage({
        chat_id: dmChatId,
        text: '⏰ That setup prompt expired (10 minutes). Reopen /manage → 🧭 Setup Wizard to restart.',
      }).catch(() => {});
      return true;
    }
    return false;
  }
  await clearSetupWizardCapture(userId);
  // Same gate as the /manage panel itself: Change Info, re-verified live.
  if (!(await canChangeInfo(sess.grpId, userId).catch(() => false))) {
    await api.sendMessage({
      chat_id: dmChatId,
      text: `⛔ Not saved: you're no longer an admin of ${sess.title} (Change Info required).`,
    }).catch(() => {});
    return true;
  }
  if (sess.step === 'social') {
    const raw = text.trim();
    if (/^(off|clear|reset)$/i.test(raw)) {
      await setupWizardApplySocial(sess.grpId, sess.field, null);
      await api.sendMessage({
        chat_id: dmChatId,
        text: `✅ ${setupWizardSocialLabel(sess.field)} link reset to PB official for ${sess.title}.`,
      }).catch(() => {});
      return true;
    }
    if (!raw.includes('.')) {
      // Not a link — re-arm so the next message retries instead of dead-ending.
      await armSetupWizardCapture(userId, sess.grpId, sess.title, 'social', sess.field);
      await api.sendMessage({
        chat_id: dmChatId,
        text: `⚠️ That doesn't look like a link — send a full link (e.g. https://…) for ${setupWizardSocialLabel(sess.field)}, or send "off" to use PB's official link.`,
      }).catch(() => {});
      return true;
    }
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    await setupWizardApplySocial(sess.grpId, sess.field, url);
    await api.sendMessage({
      chat_id: dmChatId,
      text: `✅ ${setupWizardSocialLabel(sess.field)} link saved for ${sess.title}: ${url}\nMembers will see it on /socials in that group.`,
    }).catch(() => {});
    return true;
  }
  const label = { welcome: 'Welcome message', goodbye: 'Goodbye message', rules: 'Group rules' }[sess.step] ?? 'Setting';
  await setupWizardApplyText(sess.grpId, sess.step, text);
  await api.sendMessage({
    chat_id: dmChatId,
    text: `✅ ${label} saved for ${sess.title}.`,
  }).catch(() => {});
  return true;
}

// /manage + /manager (source onText :24500; /manager is the alias Rowdy
// remembers — it never existed in the source, added in this restore).
export async function handleManageCommand(chatId, _args, msg) {
  const from = msg?.from;
  if (!from?.id) return;
  if (msg.chat?.type !== 'private') {
    if (!(await canChangeInfo(chatId, from.id))) {
      await mngTrySend(chatId, '⛔ You need the Change Info permission to use the group manager.');
      return;
    }
    const title = msg.chat?.title ?? (await manageGroupTitle(chatId));
    const sent = await mngTrySend(from.id, managePanelText(title),
      { reply_markup: await buildManageKeyboard(chatId, from.id) });
    if (sent) {
      await mngTrySend(chatId, '⚙️ Group manager sent to your DM.');
    } else {
      await mngTrySend(chatId,
        '📩 Can\'t reach your DM yet. Tap below — one click opens the Group Manager:', {
          reply_markup: { inline_keyboard: [[
            { text: '⚙️ Open Group Manager →', url: 'https://t.me/PoorBoyAI_bot?start=manage' },
          ]] },
        });
    }
    return;
  }
  await sendManageSelector(chatId, from.id);
}

export const MANAGE_COMMANDS = {
  manage: handleManageCommand,
  manager: handleManageCommand,
};

// mng: callback router target (handlers/callback_query.js delegates here).
// AUTH: the clicker's can_change_info right is re-verified live for the
// target group on EVERY menu/feature click before anything renders — the
// source's stored-registry check at open time was never repeated, so a
// forwarded panel stayed usable by ex-admins. Returns { text, alert } for
// the router's answerCallbackQuery; rendering happens here via edit/send.
export async function handleManageCallback(query) {
  const data = query?.data ?? '';
  const userId = query?.from?.id;
  const dmChatId = query?.message?.chat?.id ?? userId;
  const messageId = query?.message?.message_id;
  if (!userId) return { text: '⛔ Unknown user.', alert: true };
  const parts = data.split(':');
  const action = parts[1];

  if (action === 'noop') return {};

  if (action === 'grps') {
    // The selector is scoped to the clicker's own current admin rights.
    const groups = await getManageGroupsFor(userId);
    if (!groups.length) {
      return { text: 'No groups found — run /manage inside a group where you hold the Change Info permission.', alert: true };
    }
    await mngEdit(dmChatId, messageId, '⚙️ Group Manager\n────────────────\nSelect a group to configure:',
      manageSelectorKeyboard(groups));
    return {};
  }

  if (action === 'menu' || action === 'feat') {
    const grpId = parts[2];
    if (!grpId) return {};
    if (!(await canChangeInfo(grpId, userId))) {
      return { text: '⛔ You need the Change Info permission in that group to use the Group Manager. Nothing was changed.', alert: true };
    }
    if (action === 'menu') {
      const title = await manageGroupTitle(grpId);
      await mngEdit(dmChatId, messageId, managePanelText(title), await buildManageKeyboard(grpId, userId));
      return {};
    }
    const page = await renderManageFeaturePage(grpId, parts[3], userId);
    if (!page) return {};
    await mngEdit(dmChatId, messageId, page.text, page.reply_markup);
    return {};
  }

  // Setup Wizard (2026-11-04): guided group setup inside /manage.
  // SAME gate as menu/feat above: the clicker's Change Info right is
  // re-verified live before anything renders or writes. The wizcancel
  // action needs no group (the session is keyed by user alone).
  if (['wiz', 'wizsoc', 'wizset', 'wizreset', 'wizfield', 'wizclear', 'wizcancel'].includes(action)) {
    if (action === 'wizcancel') {
      const res = await handleSetupWizardCancel(query);
      return res ?? {};
    }
    const grpId = parts[2];
    if (!grpId) return {};
    if (!(await canChangeInfo(grpId, userId))) {
      return { text: '⛔ You need the Change Info permission in that group to use the Group Manager. Nothing was changed.', alert: true };
    }
    const title = await manageGroupTitle(grpId);
    if (action === 'wiz') {
      const p = await setupWizardPage(grpId);
      await mngEdit(dmChatId, messageId, p.text, p.reply_markup);
      return {};
    }
    if (action === 'wizsoc') {
      const p = await setupWizardSocialsPage(grpId);
      await mngEdit(dmChatId, messageId, p.text, p.reply_markup);
      return {};
    }
    if (action === 'wizreset') {
      const step = parts[3];
      if (!['welcome', 'goodbye', 'rules'].includes(step)) return {};
      await setupWizardApplyText(grpId, step, null);
      const p = await setupWizardPage(grpId);
      await mngEdit(dmChatId, messageId, p.text, p.reply_markup);
      const label = step === 'welcome' ? 'Welcome message' : step === 'goodbye' ? 'Goodbye message' : 'Group rules';
      return { text: `✅ ${label} reset.` };
    }
    if (action === 'wizclear') {
      await setupWizardClearSocials(grpId);
      const p = await setupWizardSocialsPage(grpId);
      await mngEdit(dmChatId, messageId, p.text, p.reply_markup);
      return { text: '✅ Social links reset to PB official.' };
    }
    if (action === 'wizset' || action === 'wizfield') {
      const step = action === 'wizset' ? parts[3] : 'social';
      const field = action === 'wizfield' ? parts[3] : null;
      if (action === 'wizset' && !['welcome', 'goodbye', 'rules'].includes(step)) return {};
      if (action === 'wizfield' && !SETUP_WIZ_SOCIAL_FIELDS.some(([k]) => k === field)) return {};
      await armSetupWizardCapture(userId, grpId, title, step, field);
      const what = step === 'social'
        ? `${setupWizardSocialLabel(field)} link`
        : step === 'welcome' ? 'welcome message' : step === 'goodbye' ? 'goodbye message' : 'group rules';
      await mngTrySend(dmChatId, `🧭 Send the new ${what} for ${title} — your next message here becomes it (10-minute window).`, {
        reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'mng:wizcancel' }]] },
      });
      return { text: '📩 Check your DMs — send the new value there.' };
    }
    return {};
  }

  // Phase 2 write actions (source :24749-24807) + Phase 3 Cross Protect
  // actions. SAME re-verification rule as menu/feat: the clicker's
  // Change Info right is checked live BEFORE any write — a forwarded
  // panel or a lapsed admin changes nothing. Each action re-renders its
  // feature page with fresh state.
  if (['toggle', 'pset', 'apa', 'aba', 'wldel', 'cpunlink', 'cpconfirm', 'cplink',
    'pmode', 'ptext', 'ptextclear', 'pbanner', 'pbannerclear', 'pcancel',
    'bbtoggle', 'bbpause', 'bbhourly', 'bbset', 'bbclearmedia', 'bbcancel',
    'bbcompnew', 'bbcompkind', 'bbcompskip', 'bbcompedit', 'bbcompdur',
    'bbcompstart', 'bbcompwizcancel', 'bbcompend', 'bbcompcancel',
    'dlgmgrs', 'dlgmgrtog', 'dlggrants', 'dlggrant', 'dlggtog', 'dlglog'].includes(action)) {
    const grpId = parts[2];
    if (!grpId) return {};
    if (!(await canChangeInfo(grpId, userId))) {
      return { text: '⛔ You need the Change Info permission in that group to use the Group Manager. Nothing was changed.', alert: true };
    }
    const back = async (feature, res) => {
      const page = await renderManageFeaturePage(grpId, feature, userId);
      if (page) await mngEdit(dmChatId, messageId, page.text, page.reply_markup);
      return res;
    };

    // Tier Delegation actions (2026-10-22): the Change Info check above
    // is the panel gate; handleDelegationCallback adds the ownership
    // check (only the group's delegation owner manages delegation).
    if (action.startsWith('dlg')) {
      return handleDelegationCallback(query, parts);
    }

    if (action === 'toggle') {
      const key = parts[3];
      const label = { portal: 'Portal', anti_porn: 'Anti-Porn', ad_guard: 'Ad Guard', alphabets: 'Alphabets', cross_protect: 'Cross Protect' }[key];
      const feature = { portal: 'portal', anti_porn: 'antiporn', ad_guard: 'adguard', alphabets: 'alphabets', cross_protect: 'crossprotect' }[key];
      if (!label) return {};
      // Home-group carve-out (source :24762): Portal never arms at home.
      if (key === 'portal' && grpId === (await homeChatId())) {
        return back('portal', {
          text: 'Official community chat stays open; Portal is disabled here.',
          alert: true,
        });
      }
      const cur = (await getGroupSettings(grpId))[key] === true;
      await setGroupSettings(grpId, { [key]: !cur });
      // Switching Cross Protect OFF ends Path B relay consent for this
      // group's links too — enqueue the relay re-validation (§9.3).
      if (key === 'cross_protect' && cur) await stampRelayConsentRecheck();
      return back(feature, { text: !cur ? `✅ Enabled: ${label}` : `❌ Disabled: ${label}` });
    }

    if (action === 'pset') {
      const val = parts[3];
      if (!['30', '60', '120'].includes(val)) return {};
      await setGroupSettings(grpId, { portal_timeout: Number(val) });
      return back('portal', { text: `⏱️ Portal timeout: ${val}s` });
    }

    // Portal polish actions. pmode/ptextclear/pbannerclear write the
    // group's settings directly; ptext/pbanner arm a one-shot DM
    // capture (handlePortalSetupCapture) and prompt for the value —
    // the value itself is written only when the capture is consumed,
    // after a fresh Change Info re-check (see the capture's header).
    if (action === 'pmode') {
      const val = parts[3];
      if (!PORTAL_MODES.includes(val)) return {};
      await setGroupSettings(grpId, { portal_mode: val });
      const label = { holder: 'Holder check', human: 'Human only', both: 'Both steps' }[val];
      return back('portal', { text: `🌀 Portal verify mode: ${label}` });
    }

    if (action === 'ptextclear') {
      await setGroupSettings(grpId, { portal_welcome: null });
      return back('portal', { text: 'Welcome text reset to the PB default.' });
    }

    if (action === 'pbannerclear') {
      await setGroupSettings(grpId, { portal_banner_file_id: null, portal_banner_type: null });
      return back('portal', { text: 'Banner removed.' });
    }

    if (action === 'pcancel') {
      await clearPortalSetupCapture(userId);
      return back('portal', { text: 'Portal setup cancelled — nothing was changed.' });
    }

    if (action === 'ptext' || action === 'pbanner') {
      const kind = action === 'ptext' ? 'text' : 'banner';
      await armPortalSetupCapture(userId, grpId, kind);
      const title = await manageGroupTitle(grpId);
      const prompt = kind === 'text'
        ? [
          `✏️ Portal welcome text for ${title}`,
          '',
          `Send the new welcome text as your next message here (up to ${PORTAL_WELCOME_MAX} characters). New members see it first; PB adds the verify instruction and button under it.`,
          '',
          'Placeholders: {name} = the new member\'s name, {group} = the group name.',
          '',
          'This prompt expires in 5 minutes. Commands and other buttons still work — only your next plain message is captured.',
        ].join('\n')
        : [
          `🖼️ Portal banner for ${title}`,
          '',
          'Send a photo, GIF or video as your next message here. It will ride on top of every new member\'s verification message in that group.',
          '',
          'This prompt expires in 5 minutes. Commands and other buttons still work — only your next media message is captured.',
        ].join('\n');
      await mngTrySend(dmChatId, prompt, {
        reply_markup: { inline_keyboard: [[
          { text: '✖ Cancel', callback_data: `mng:pcancel:${grpId}` },
        ]] },
      });
      return back('portal', {
        text: kind === 'text'
          ? '✏️ Send the welcome text in this DM — see my prompt below.'
          : '🖼️ Send the banner media in this DM — see my prompt below.',
      });
    }

    if (action === 'apa') {
      const val = parts[3];
      if (!['delete_warn', 'delete_ban'].includes(val)) return {};
      await setGroupSettings(grpId, { anti_porn_action: val });
      return back('antiporn', { text: `🔞 Anti-Porn action: ${val === 'delete_ban' ? 'Delete + Ban' : 'Delete + Warn'}` });
    }

    if (action === 'aba') {
      // Notify is the only action by design (source :24788).
      await setGroupSettings(grpId, { alphabets_action: 'notify' });
      return back('alphabets', {
        text: '🔤 Alphabets is notify-only in this bot build.',
        alert: true,
      });
    }

    if (action === 'wldel') {
      const targetId = parts[3];
      if (!targetId) return {};
      await removeWhitelist(grpId, targetId);
      return back('whitelist', { text: 'Removed from whitelist.' });
    }

    // Buy Bot actions (Buy Bot Phase 2 — the original's bb:pause /
    // bb:resume, on the mng: chassis). The Change Info check above
    // covers the group; the campaign is resolved FROM the group (the
    // original's user_target_groups rule) — no campaign targeting this
    // group means nothing exists to change. Pause/disable are
    // campaign-wide by design (the setting lives on the campaign row),
    // and the panel copy says so.
    if (action === 'bbtoggle' || action === 'bbpause') {
      const camp = await resolveBuyCampaignForGroup(grpId, userId);
      if (!camp) {
        return back('buybot', {
          text: 'No campaign targets this group yet — nothing to change.',
          alert: true,
        });
      }
      if (action === 'bbtoggle') {
        const next = !camp.buyBotEnabled;
        await updateBuyCampaign(camp.id, { buyBotEnabled: next });
        return back('buybot', {
          text: next
            ? `🟢 Buy Bot enabled for $${camp.ticker}.`
            : `🔴 Buy Bot disabled for $${camp.ticker} — settings and history are kept.`,
        });
      }
      if (!camp.buyBotEnabled) {
        return back('buybot', { text: 'Buy Bot is disabled — enable it first.', alert: true });
      }
      const nextPaused = !camp.buyBotPaused;
      await updateBuyCampaign(camp.id, { buyBotPaused: nextPaused });
      return back('buybot', {
        text: nextPaused
          ? '⏸ Buy Bot paused — alerts stop in every group this campaign posts to.'
          : '▶️ Buy Bot resumed.',
      });
    }

    // Buy Bot Phase 3 — field captures + banner clear. bbset arms a
    // one-shot DM capture (handleBuyBotCapture) and prompts for the
    // value; the value itself is written only when the capture is
    // consumed, after a fresh Change Info re-check (see the capture's
    // header). bbclearmedia writes immediately, like bbtoggle.
    if (action === 'bbcancel') {
      await clearBuyBotCapture(userId);
      return back('buybot', { text: 'Buy Bot edit cancelled — nothing was changed.' });
    }

    if (action === 'bbclearmedia') {
      const camp = await resolveBuyCampaignForGroup(grpId, userId);
      if (!camp) {
        return back('buybot', {
          text: 'No campaign targets this group yet — nothing to change.',
          alert: true,
        });
      }
      await updateBuyCampaign(camp.id, { buyMediaFileId: null, buyMediaType: null });
      return back('buybot', { text: `🧹 Banner cleared for $${camp.ticker} — alerts are text-only again.` });
    }

    if (action === 'bbset') {
      const field = parts[3];
      if (!BB_CAPTURE_FIELDS[field]) return {};
      const camp = await resolveBuyCampaignForGroup(grpId, userId);
      if (!camp) {
        return back('buybot', {
          text: 'No campaign targets this group yet — nothing to change.',
          alert: true,
        });
      }
      await armBuyBotCapture(userId, grpId, camp.id, field);
      const title = await manageGroupTitle(grpId);
      const cur = {
        emoji: camp.buyEmoji || '💸',
        min: bbFmtUsd(camp.buyMinUsd ?? 0.5),
        whale: Number(camp.whaleThresholdUsd) > 0 ? bbFmtUsd(camp.whaleThresholdUsd) : 'off',
        whalebal: Number(camp.buyWhaleBalanceUsd) > 0 ? bbFmtUsd(camp.buyWhaleBalanceUsd) : 'off',
        step: Number(camp.buyStepUsd) > 0 ? `${bbFmtUsd(camp.buyStepUsd)} per emoji` : 'classic bar (no step set)',
        banner: camp.buyMediaFileId ? `set (${camp.buyMediaType ?? 'photo'})` : 'none',
      }[field];
      const ask = {
        emoji: 'Send 1–3 emoji as your next message here (max 8 characters). Every buy alert for the campaign will carry them.',
        min: 'Send the new minimum buy as your next message here — a USD amount like 25 or $25. Buys below it are logged but not alerted (the watcher\'s hard floor is $0.50).',
        whale: 'Send the new whale threshold as your next message here — a USD amount like 500. Buys at or above it get the 🐳 WHALE header. Send 0 to turn whale treatment off.',
        whalebal: 'Send the new known-whale badge threshold as your next message here — a USD amount like 10000. Buyers whose total wallet balance (native coin + this token) reaches it get the 🐋 badge on their buy alert. This is the buyer\'s BALANCE — the 🐳 Whale setting above is the buy SIZE. Send 0 to turn the badge off. Balances are checked at most once per wallet every few hours, so a badge can lag a fast-changing wallet.',
        step: 'Send the new emoji step as your next message here — a USD amount like 10. The alert bar then grows by one emoji per step bought (e.g. step $10 → a $47 buy shows 4 emoji).',
        banner: 'Send a photo, GIF or video as your next message here. It will ride on top of every buy alert for the campaign.',
      }[field];
      await mngTrySend(dmChatId, [
        `💎 Buy Bot — ${BB_CAPTURE_FIELDS[field].label} for $${camp.ticker} (${title})`,
        '',
        `Current: ${cur}`,
        '',
        ask,
        '',
        'This is a CAMPAIGN setting: the change applies in every group the campaign posts to.',
        'This prompt expires in 5 minutes. Commands and other buttons still work — only your next matching message is captured.',
      ].join('\n'), {
        reply_markup: { inline_keyboard: [[
          { text: '✖ Cancel', callback_data: `mng:bbcancel:${grpId}` },
        ]] },
      });
      return back('buybot', { text: `✏️ Send the new ${BB_CAPTURE_FIELDS[field].label} in this DM — see my prompt below.` });
    }

    if (action === 'bbhourly') {
      // Per-GROUP toggle (group_settings), not a campaign field: the
      // card belongs to the group. Default for campaign groups is ON,
      // so the first tap turns it off.
      const cur = (await getGroupSettings(grpId)).buy_hourly !== false;
      await setGroupSettings(grpId, { buy_hourly: !cur });
      return back('buybot', {
        text: !cur
          ? '📊 Hourly stats card ON for this group.'
          : '📊 Hourly stats card OFF for this group.',
      });
    }

    // Buy Bot Phase 5 — buy competitions. The Change Info check above
    // covers the group for every action here. Lifecycle actions resolve
    // the campaign from the group like every other bb action; the
    // setup wizard's draft is keyed by the CLICKER's user id, so only
    // the admin who started a setup can drive it (the contest-wizard
    // rule) — another admin's tap finds no draft and gets the expiry
    // notice.
    if (action === 'bbcompend' || action === 'bbcompcancel') {
      const camp = await resolveBuyCampaignForGroup(grpId, userId);
      const comp = camp ? await getActiveBuyCompetition(grpId, camp.id) : null;
      if (!comp) {
        return back('buybot', {
          text: 'No buy competition is running for this campaign here.',
          alert: true,
        });
      }
      if (action === 'bbcompcancel') {
        const ok = await cancelBuyCompetition(comp.id);
        return back('buybot', {
          text: ok
            ? '✖ Competition cancelled — no results announced. The buys it counted stay in the group stats.'
            : 'That competition was already finalised.',
        });
      }
      const res = await finaliseBuyCompetition(comp);
      return back('buybot', {
        text: res.finalised
          ? '🏆 Competition ended — the results were posted in the group.'
          : 'That competition was already finalised.',
        ...(res.finalised ? {} : { alert: true }),
      });
    }

    if (action === 'bbcompnew') {
      const camp = await resolveBuyCampaignForGroup(grpId, userId);
      if (!camp) {
        return back('buybot', {
          text: 'No campaign targets this group yet — nothing to change.',
          alert: true,
        });
      }
      if (!camp.contractAddress) {
        return back('buybot', {
          text: 'This campaign has no contract address yet — a competition needs a token to score.',
          alert: true,
        });
      }
      const running = await getActiveBuyCompetition(grpId, camp.id);
      if (running) {
        return back('buybot', {
          text: 'A buy competition is already running for this campaign here — end or cancel it first.',
          alert: true,
        });
      }
      const draft = {
        grpId: String(grpId), campaignId: camp.id,
        ticker: camp.ticker, grpTitle: await manageGroupTitle(grpId),
        kind: null, prizeText: null, prizeSet: false,
        minBuyUsd: null, durationSec: null,
        stage: 'kind', awaiting: null, createdAt: Date.now(),
      };
      await saveBbCompDraft(userId, draft);
      const p = bbCompWizardPanel(draft);
      await mngEdit(dmChatId, messageId, p.text, p.reply_markup);
      return { text: '🏆 Competition setup — pick a kind below.' };
    }

    // The remaining wizard actions all drive the clicker's own draft.
    if (['bbcompkind', 'bbcompskip', 'bbcompedit', 'bbcompdur', 'bbcompstart', 'bbcompwizcancel'].includes(action)) {
      const draft = await loadBbCompDraft(userId);
      if (!draft || String(draft.grpId) !== String(grpId)) {
        return {
          text: '⏳ That competition setup expired (or belongs to another group) — open 💎 Buy Bot and tap 🏆 New buy competition.',
          alert: true,
        };
      }
      const renderWiz = async (note = '') => {
        const p = bbCompWizardPanel(draft, note);
        await mngEdit(dmChatId, messageId, p.text, p.reply_markup);
        return {};
      };

      if (action === 'bbcompwizcancel') {
        await clearBbCompDraft(userId);
        return back('buybot', { text: 'Competition setup cancelled — nothing was created.' });
      }

      if (action === 'bbcompkind') {
        const kind = parts[3];
        if (!BUY_COMP_KINDS[kind]) return {};
        draft.kind = kind;
        draft.stage = 'prize';
        await saveBbCompDraft(userId, draft);
        return renderWiz();
      }

      if (action === 'bbcompskip') {
        if (draft.stage === 'prize') {
          draft.prizeText = null;
          draft.prizeSet = true;
          draft.stage = 'min';
        } else if (draft.stage === 'min') {
          draft.minBuyUsd = 0;
          draft.stage = 'dur';
        } else return {};
        await saveBbCompDraft(userId, draft);
        return renderWiz();
      }

      if (action === 'bbcompedit') {
        if (draft.stage !== 'prize' && draft.stage !== 'min') return {};
        draft.awaiting = draft.stage;
        await saveBbCompDraft(userId, draft);
        const isPrize = draft.stage === 'prize';
        await mngTrySend(dmChatId, [
          `🏆 Buy Competition — ${isPrize ? 'prize text' : 'minimum qualifying buy'} for $${draft.ticker} (${draft.grpTitle})`,
          '',
          isPrize
            ? `Send the prize text as your next message here (up to ${BUY_COMP_PRIZE_MAX} characters) — e.g. "500 USDT + a whale role". It is announced exactly as written; you distribute the prize yourself.`
            : 'Send the minimum qualifying buy as your next message here — a USD amount like 25 or $25. Buys below it are recorded but don\'t count.',
          '',
          'This prompt expires with the setup (15 minutes). Commands and other buttons still work — only your next plain message is captured.',
        ].join('\n'), {
          reply_markup: { inline_keyboard: [[
            { text: '✖ Cancel setup', callback_data: `mng:bbcompwizcancel:${grpId}` },
          ]] },
        });
        return { text: `✏️ Send the ${isPrize ? 'prize text' : 'minimum buy'} in this DM — see my prompt below.` };
      }

      if (action === 'bbcompdur') {
        const secs = Number(parts[3]);
        if (!BUY_COMP_DURATIONS.some(([s]) => s === secs)) return {};
        draft.durationSec = secs;
        draft.stage = 'confirm';
        await saveBbCompDraft(userId, draft);
        const camp = await db.select().from(user_campaigns)
          .where(eq(user_campaigns.id, draft.campaignId)).get().catch(() => null);
        const note = camp?.buyBotPaused
          ? '⚠️ Heads up: Buy Bot is PAUSED for this campaign — buys are only recorded while it runs. Resume it (⏸ button on the Buy Bot page) or the competition will see no buys.'
          : '';
        return renderWiz(note);
      }

      if (action === 'bbcompstart') {
        if (draft.stage !== 'confirm' || !draft.kind || !draft.prizeSet
          || draft.minBuyUsd === null || !draft.durationSec) {
          return { text: 'Finish the setup steps first.', alert: true };
        }
        // Creation lives in startBuyCompetition (the data layer
        // above) — the Mini App's buyCompStart action calls the same
        // function with the same gates in the same order; this
        // handler only maps the outcome onto the wizard's own
        // responses and draft handling, unchanged from the original.
        const res = await startBuyCompetition({
          chatId: grpId, userId, campaignId: draft.campaignId,
          kind: draft.kind, prizeText: draft.prizeText,
          minBuyUsd: draft.minBuyUsd, durationSec: draft.durationSec,
        });
        if (!res.ok) {
          if (res.reason === 'no_campaign' || res.reason === 'no_ca') {
            await clearBbCompDraft(userId);
            return back('buybot', {
              text: 'That campaign no longer exists (or lost its contract address) — the setup was closed.',
              alert: true,
            });
          }
          if (res.reason === 'tier') {
            return {
              text: '⛔ The campaign owner\'s plan is below Starter — buy competitions carry the same plan floor as Buy Bot itself.',
              alert: true,
            };
          }
          if (res.reason === 'disabled') {
            return {
              text: '⛔ Buy Bot is disabled for this campaign — a competition can only count buys the watcher records. Enable Buy Bot first, then start the competition.',
              alert: true,
            };
          }
          // res.reason === 'running'
          await clearBbCompDraft(userId);
          return back('buybot', {
            text: 'A competition is already running for this campaign here.',
            alert: true,
          });
        }
        await clearBbCompDraft(userId);
        return back('buybot', {
          text: `🏆 Competition started for $${res.camp.ticker} — it ends in ${buyCompTimeLeft(res.comp.endAt)}. Standings are on this page and in /buycomp.`,
        });
      }
    }

    // Phase 3 Cross Protect actions. The Change Info check above covers
    // the group being ACTED ON (grpId — this panel's group, i.e. the
    // side consenting/unlinking). The other side is never written except
    // through its own confirmed consent: cplink only records grpId's
    // own request, cpconfirm only sets grpId's own side, and the flag
    // writes on activation touch both groups only at the moment consent
    // becomes mutual (see requestCrossProtectLink).
    if (action === 'cpunlink') {
      const otherId = parts[3];
      if (!otherId) return {};
      const before = await getCrossProtectLink(grpId, otherId);
      await removeCrossProtectLink(grpId, otherId);
      return back('crossprotect', {
        text: before?.aConfirmed && before?.bConfirmed
          ? 'Groups unlinked.'
          : 'Link request removed.',
      });
    }

    if (action === 'cpconfirm') {
      const otherId = parts[3];
      if (!otherId) return {};
      const res = await confirmCrossProtectLink(grpId, otherId);
      if (!res) {
        return back('crossprotect', { text: 'That link request no longer exists.', alert: true });
      }
      return back('crossprotect', {
        text: res.active
          ? '🌐 Link confirmed — bans with /ban now mirror both ways.'
          : '✅ Your side is confirmed.',
      });
    }

    if (action === 'cplink') {
      const otherId = parts[3];
      if (!otherId || String(otherId) === String(grpId)) return {};
      let known = null;
      try {
        known = await db.select().from(known_groups)
          .where(eq(known_groups.chatId, String(otherId))).get();
      } catch { /* treated as unknown below */ }
      if (!known) {
        return back('crossprotect', { text: 'That group is not one I serve yet.', alert: true });
      }
      const res = await requestCrossProtectLink(grpId, otherId, userId);
      return back('crossprotect', {
        text: res.state === 'already'
          ? 'Already linked.'
          : res.state === 'active'
            ? '🌐 Link confirmed — they had already requested it. Bans with /ban now mirror both ways.'
            : '🌐 Link requested — an admin of that group confirms it from their Cross Protect panel.',
      });
    }
  }

  return {};
}

// ══ E4a completeness restores (2026-10-21): anti-flood, goodbye commands,
//    Auto Vision, support-mode flag ═════════════════════════════════════════
// Sources: group-manager.ts (antiflood settings + checkFlood), the
// anti-flood middleware (telegram-community-bot.ts:21448), /setflood +
// /flood (:22668/:22680), /setgoodbye + /resetgoodbye (:21748/:21763),
// /autoread's settings + auto-vision consumer (:15379/:21382), /setsupport
// (:15064). Settings ride the group_settings JSON above — the same idiom
// the source's group-manager used. Trackers are module-level Maps exactly
// like the source's in-memory ones (isolate-local: a recycled isolate can
// only make a window marginally more permissive, never stricter).

// ── Anti-flood ─────────────────────────────────────────────────────────────

const floodTracker = new Map(); // `${chatId}:${userId}` -> number[] (ms)

function checkFloodWindow(chatId, userId, limit, seconds) {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const windowMs = Math.max(1, seconds) * 1000;
  const stamps = (floodTracker.get(key) ?? []).filter((ts) => now - ts < windowMs);
  stamps.push(now);
  floodTracker.set(key, stamps);
  return stamps.length > limit;
}

/**
 * Anti-flood hook — runs on every group message (commands included, the
 * source's middleware position). Admins are exempt. On flood: delete the
 * triggering message + the source's warning; NEVER auto-mutes (explicit
 * source design). Returns true when it deleted the message (the caller
 * stops processing it).
 */
export async function antiFloodHook(chatId, message) {
  try {
    const s = await getGroupSettings(chatId);
    const limit = Number(s.antifloodLimit ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return false;
    const seconds = Number(s.antifloodSeconds ?? 10) || 10;
    if (await isChatAdmin(chatId, message.from.id)) return false;
    if (!checkFloodWindow(chatId, message.from.id, limit, seconds)) return false;
    try {
      await api.deleteMessage({ chat_id: chatId, message_id: message.message_id });
    } catch { return false; /* delete failed (rights) — don't warn on a live message */ }
    const who = message.from.username ? '@' + message.from.username : (message.from.first_name ?? 'friend');
    await api.sendMessage({
      chat_id: chatId,
      text: `⚠️ ${who} slow down! Message removed — an admin must approve any mute.`,
    }).catch(() => {});
    return true;
  } catch { return false; /* flood failures never break the handler */ }
}

// ── Auto Vision (/autoread consumer) ───────────────────────────────────────

const autoVisionLast = new Map(); // chatId -> ms of last read

const AUTO_VISION_SYSTEM =
  'You are PB, a sharp crypto analyst inside a Telegram group. A member just shared an image. ' +
  'If it is a price chart, read the trend, key support/resistance, momentum and give a quick verdict. ' +
  'If it is a token or coin screenshot, give a quick take on what you can see. ' +
  'For other images (memes, general content), give a short fun or relevant comment. ' +
  'Be direct and concise — under 150 words. Plain text only, no markdown headers. No filler phrases.';

export const DM_VISION_SYSTEM =
  'You are PB, a sharp crypto analyst in a private chat with a member. A member just shared an image. ' +
  'If it is a price chart, read the trend, key support/resistance, momentum and give a quick verdict. ' +
  'If it is a token or coin screenshot, give a quick take on what you can see. ' +
  'For other images (memes, general content, error screenshots), give a short fun or relevant comment — for an error screenshot, read the error text out and say plainly what it says. ' +
  'Be direct and concise — under 150 words. Plain text only, no markdown headers. No filler phrases.';

// Documented test seam (the llm.js __setLlmFetchForTest precedent): null in
// production. When set, callGeminiVision routes through the supplied
// (url, init) => response function so the harness can stub the Gemini
// transport. Never set outside the harness.
let _visionFetchOverride = null;
export function __setVisionFetchForTest(fn) { _visionFetchOverride = fn ?? null; }
const visionFetch = (url, init) => (_visionFetchOverride ? _visionFetchOverride(url, init) : fetch(url, init));

/**
 * One Gemini vision read: image bytes + user text → plain-text take, or
 * null on any failure. Extracted verbatim from maybeAutoVision (Wave 5)
 * so DM vision reuses the exact same call — same model, same key, same
 * shape. NEVER throws. (Log tag changed from '[autovision] gemini' to
 * '[vision] gemini' so DM reads don't mislabel themselves; log text only.)
 */
export async function callGeminiVision({ key, bytes, userText, systemPrompt }) {
  try {
    const res = await visionFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{
            role: 'user',
            parts: [
              { text: userText },
              { inlineData: { mimeType: 'image/jpeg', data: bytesToBase64(bytes) } },
            ],
          }],
          generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
        }),
      },
    );
    if (!res?.ok) { console.warn('[vision] gemini', res?.status); return null; }
    const data = await res.json().catch(() => null);
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
    return text || null;
  } catch (err) {
    console.warn('[vision]', err?.message ?? err);
    return null;
  }
}

// Pure-JS base64 encode — the tgcloud isolate has NO btoa/atob globals
// (proven live 2026-10-29 in lib/image.js, 2026-10-28 in lib/boost.js;
// this function threw `btoa is not defined` in-isolate, so
// callGeminiVision returned null before any network call and DM/group
// vision was dead live). Same proven shape as lib/boost.js bytesToB64 —
// output is byte-identical to standard base64. NOTE for future
// harnesses: Node DOES provide btoa, so a plain harness run cannot catch
// a btoa use — the harness must delete globalThis.btoa/atob first (see
// harness-btoa-vision-fix.mjs).
// EXPORTED (F13, 2026-11-06): lib/studio.js describeVideoAdPhoto reuses
// this encoder — studio.js already imports from groups.js and groups.js
// never imports studio.js, so there is no cycle. No new import edge,
// only a new name on the existing one.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}

/**
 * Auto Vision consumer (source :21382): in a group with /autoread on, a
 * member's photo (documents excluded, bots excluded) is read by the vision
 * model and answered in place as "👁️ <take>", rate-limited per group by
 * the configured cooldown (in-memory, like the source). The port's LLM
 * gateway (lib/llm.js) is text-only, so this calls Gemini's generateContent
 * directly with the image inline — the same REST shape lib/image.js uses,
 * via callGeminiVision below (shared with DM vision, Wave 5).
 * Every failure is warn-logged and swallowed, exactly like the source.
 */
export async function maybeAutoVision(chatId, message) {
  try {
    if (!message?.photo?.length || message.from?.is_bot) return;
    const s = await getGroupSettings(chatId);
    if (!s.autoVisionEnabled) return;
    const cooldownSec = Number(s.autoVisionCooldownSeconds ?? 30) || 30;
    const last = autoVisionLast.get(String(chatId)) ?? 0;
    if (Date.now() - last < cooldownSec * 1000) return;
    autoVisionLast.set(String(chatId), Date.now());
    const key = await getConfig('GEMINI_API_KEY');
    if (!key) return;
    const photo = message.photo[message.photo.length - 1];
    const bytes = await api.getFileContent(photo.file_id);
    if (!bytes?.length) return;
    const caption = (message.caption ?? '').trim();
    const userText = caption
      ? `The user shared this image with the caption: "${caption}"\n\nAlso: analyze this image as a crypto trader would.`
      : 'Analyze this image as a crypto trader would.';
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    const text = await callGeminiVision({ key, bytes, userText, systemPrompt: AUTO_VISION_SYSTEM });
    if (!text) return;
    await api.sendMessage({
      chat_id: chatId,
      text: `👁️ ${text}`.slice(0, 4000),
      reply_to_message_id: message.message_id,
    }).catch(() => {});
  } catch (err) {
    console.warn('[autovision]', err?.message ?? err);
  }
}

/** /autoread's "on" resets the group's vision cooldown (source parity). */
export function resetAutoVisionCooldown(chatId) {
  autoVisionLast.delete(String(chatId));
}

// ── Support mode flag (/setsupport storage; engine in lib/groupmsg.js) ─────

// Effective support-mode status, shared by enforcement (isSupportModeChat)
// and by the /setsupport status text so the two can never disagree again
// (Q2 wave 2026-10-31: the status used to read only the flag while
// enforcement also honored the designated group).
export async function getSupportModeStatus(chatId, chat, threadId) {
  const s = await getGroupSettings(chatId);
  const flag = s.supportMode === true;
  // Support reroute (Rowdy's explicit order 2026-10-31): the bot support
  // group moved to "Official PoorBoyAI agent support" (-1004439813682,
  // @poorboyai_agent_support). The old home-topic rule (thread 7657) is
  // REPLACED, not kept alongside — two support surfaces would split
  // support. threadId stays in the signature for callers but no longer
  // routes anything.
  void threadId;
  const designated = String(chatId) === '-1004439813682' || chat?.username === 'poorboyai_agent_support';
  return { effective: flag || designated, flag, designated };
}

export async function isSupportModeChat(chatId, chat, threadId) {
  return (await getSupportModeStatus(chatId, chat, threadId)).effective;
}

// ══ PB Shield — group scam-bot protection (2026-10-21) ═══════════════════
// Rowdy's directive: PB must protect communities from scam bots and
// RECOGNIZE when bots/scammers are in the group. Design (settled):
// per-group opt-in via /shield on|off (group admins; the flag lives in
// the group_settings JSON like every other group feature). With Shield
// off the whole block is inert — the hooks return before touching
// anything. ALL state is keyed by chat ID (shieldWatch / shieldStrikes /
// shieldImpersonated / shieldBurst / shieldLog / shieldPhrases inside
// that group's own settings row): communities stay sealed — no signal of
// any kind crosses groups; the owner's manual /globalban remains the
// only cross-group tool.
//
// Signals:
//  1. Join burst — ≥6 joins inside 60s (in-memory stamps, the anti-flood
//     idiom) → burst mode: an in-group alert card posts and every new
//     joiner is auto-restricted (text only, no links/media) until 10
//     quiet minutes pass or an admin ends it (/shield clear or the
//     card's button). Burst restrictions carry a 15-minute until_date
//     safety cap; ending burst mode restores everyone explicitly.
//  2. Fresh-account watch — every joiner is watched for their first 24h
//     in the group OR their first 5 messages, whichever ends LATER.
//     Soft signals recorded at join: a very new Telegram account
//     (user id ≥ SHIELD_FRESH_ID_MIN — Telegram ids are issued
//     sequentially; calibrated 2026-10-21 from the 620 bot_users ids on
//     file: p95 = 8.838B, max = 8.996B, only 18 known members (2.9%) sit
//     at/above 8.9B, so the line marks roughly the newest ~3% of
//     accounts this community has ever seen) and/or no profile photo
//     (getUserProfilePhotos total_count 0, checked once at join).
//     Soft signals are NEVER an action by themselves — they are flags
//     on the watch record and in the log.
//  3. New-joiner link quarantine — a watched member posting a link
//     (entity or bare URL), a forward, or an invite → message deleted,
//     strike +1. No public shaming message; the group just stays clean.
//  4. Impersonation (STRONG) — a member's display name normalized-
//     matches a group admin (or their username), the bot/owner names,
//     or protected words (poorboyai, pb, telegram, support, admin,
//     official, verify + leetspeak folds) → message deleted + restricted
//     24h immediately + an in-group alert card with Ban / Release /
//     Dismiss buttons for the admins. Repeat sightings delete silently
//     (no card spam) until an admin rules.
//  5. Scam phrases — the curated starter patterns below + per-group
//     custom phrases (/shield ban|unban <phrase>). Established member:
//     delete + log only. Watched member: delete + strike. A watched
//     member carrying BOTH soft signals who trips a phrase is restricted
//     on the spot as well (three stacked signals — still never a ban).
//
// Escalation ladder (per user per group, shieldStrikes): strike 1 →
// delete; strike 2 → restrict 24h (no links/media/forwards); strike 3 →
// ban. NEVER an auto-ban on one weak signal. Admins, the owner and
// whitelisted members are always exempt; bot senders never reach the
// hook (Telegram hides bot-to-bot traffic from bots entirely).
//
// Rights honesty: PB's own rights are read live (cached 5 min). Without
// delete/restrict rights Shield runs ALERT-ONLY — detection, log and
// alert cards still work, no enforcement is attempted, and /shield
// status (and the /manage protection page) SAY SO plainly.
//
// Honest limit, stated in the copy too: a determined human scammer
// typing by hand can still get a first message out. Shield's job is to
// make it expensive and short-lived.

export const SHIELD_FRESH_ID_MIN = 8_900_000_000;
const SHIELD_BURST_JOINS = 6;
const SHIELD_BURST_WINDOW_MS = 60_000;
const SHIELD_BURST_QUIET_MS = 10 * 60_000;
const SHIELD_BURST_RESTRICT_SEC = 15 * 60;
const SHIELD_WATCH_MS = 24 * 60 * 60 * 1000;
const SHIELD_WATCH_MSGS = 5;
const SHIELD_RESTRICT_SEC = 24 * 3600;
const SHIELD_LOG_MAX = 100;
const SHIELD_RIGHTS_TTL_MS = 5 * 60_000;
const SHIELD_ADMINS_TTL_MS = 10 * 60_000;

// Restrict shape for strikes/burst: plain text stays, everything that
// carries a scam (links, media, forwards, stickers) goes.
const SHIELD_PERMS_LIMITED = {
  can_send_messages: true, can_send_audios: false,
  can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
  can_change_info: false, can_invite_users: true,
  can_pin_messages: false,
};

// Curated starter scam-phrase set (tested against the lowercased text).
// Kept tight and lure-shaped on purpose: every pattern is something a
// scammer says to move a victim, not something a member says in chat.
const SHIELD_SCAM_PATTERNS = [
  /\bverify your wallet\b/,
  /\bvalidate your wallet\b/,
  /\bsync your wallet\b/,
  /\bconnect your wallet\b[^.]{0,40}\b(claim|verify|receive|bonus|reward)/,
  /\bclaim your (free )?(airdrop|tokens?|bonus|reward|usdt|eth|sol|btc)\b/,
  /\bairdrop claim\b/,
  /\bdm me\b/,
  /\bdouble your (eth|sol|btc|usdt|crypto|coins?|money)\b/,
  /\btriple your (eth|sol|btc|usdt|crypto|coins?|money)\b/,
  /\bsend (me )?\d*\.?\d* ?(eth|sol|bnb|btc|usdt)\b[^.]{0,40}\b(receive|get back|double|triple)\b/,
  /\bguaranteed (profits?|returns?|income|gains?)\b/,
  /\b(send|share|enter|input|give)\b[^.]{0,30}\bseed phrase\b/,
  /\b(send|share|enter|input|give)\b[^.]{0,30}\bprivate key\b/,
  /\bofficial support\b[^.]{0,40}\b(verify|claim|send|wallet|dm)\b/,
  /\bsupport team\b[^.]{0,40}\b(verify your|claim|send|wallet)\b/,
  /\bfree (usdt|eth|sol|btc)\b[^.]{0,30}\b(claim|dm|click|send)\b/,
];

const shieldJoinStamps = new Map(); // chatId -> join timestamps (ms)
const shieldJoinSeen = new Map(); // `${chatId}:${userId}` -> ms (dual-seam dedupe)
const shieldRightsCache = new Map(); // chatId -> { at, canDelete, canRestrict }
const shieldAdminsCache = new Map(); // chatId -> { at, admins }
let shieldBotIdCache = null;

const shieldUserLabel = (u) => {
  const name = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim();
  return name || (u?.username ? '@' + u.username : `User ${u?.id ?? '?'}`);
};

function shieldLogPush(log, entry) {
  const arr = Array.isArray(log) ? [...log] : [];
  arr.push({ ts: Math.floor(Date.now() / 1000), ...entry });
  return arr.slice(-SHIELD_LOG_MAX);
}

/** PB's own enforcement rights in a chat (live, cached 5 min). */
export async function shieldRights(chatId) {
  const key = String(chatId);
  const hit = shieldRightsCache.get(key);
  if (hit && Date.now() - hit.at < SHIELD_RIGHTS_TTL_MS) return hit;
  let out = { at: Date.now(), canDelete: false, canRestrict: false };
  try {
    if (!shieldBotIdCache) {
      const me = await api.getMe();
      shieldBotIdCache = me?.id ?? null;
    }
    if (shieldBotIdCache) {
      const m = await api.getChatMember({ chat_id: chatId, user_id: shieldBotIdCache });
      if (m?.status === 'creator') out = { at: Date.now(), canDelete: true, canRestrict: true };
      else if (m?.status === 'administrator') {
        out = {
          at: Date.now(),
          canDelete: m.can_delete_messages === true,
          canRestrict: m.can_restrict_members === true,
        };
      }
    }
  } catch { /* unreadable rights = no rights; alert-only is the honest mode */ }
  shieldRightsCache.set(key, out);
  return out;
}

async function shieldAdmins(chatId) {
  const key = String(chatId);
  const hit = shieldAdminsCache.get(key);
  if (hit && Date.now() - hit.at < SHIELD_ADMINS_TTL_MS) return hit.admins;
  let admins = [];
  try {
    const rows = await api.getChatAdministrators({ chat_id: chatId });
    admins = (rows ?? []).filter((r) => r?.user && !r.user.is_bot);
  } catch { /* patterns still apply with an empty admin list */ }
  shieldAdminsCache.set(key, { at: Date.now(), admins });
  return admins;
}

// ── Impersonation matching ───────────────────────────────────────────────

const SHIELD_LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };
const shieldFold = (s) => String(s ?? '').toLowerCase().split('').map((c) => SHIELD_LEET[c] ?? c).join('');
const shieldSquash = (s) => shieldFold(s).replace(/[^a-z0-9]/g, '');
const shieldTokens = (s) => shieldFold(s).split(/[^a-z0-9]+/).filter(Boolean);
const SHIELD_PROTECTED_WORDS = ['poorboyai', 'telegram', 'support', 'admin', 'official', 'verify'];
const SHIELD_TOKEN_SUFFIX_OK = new Set(['er', 'ers', 'ing', 'ed', 's', 'ly']);

function shieldProtectedHit(name) {
  const toks = shieldTokens(name);
  for (const tok of toks) {
    if (tok === 'pb') return 'protected name "PB"';
    for (const p of SHIELD_PROTECTED_WORDS) {
      if (tok === p) return `protected word "${p}"`;
      // Pattern + short tail ("supportpb", "pbadmin") matches; ordinary
      // English derivations ("supporter", "officially") do not.
      if (tok.startsWith(p) && tok.length > p.length) {
        const tail = tok.slice(p.length);
        if (tail.length <= 3 && !SHIELD_TOKEN_SUFFIX_OK.has(tail)) return `protected word "${p}"`;
      }
      if (tok.endsWith(p) && tok.length > p.length) {
        const head = tok.slice(0, tok.length - p.length);
        if (head.length <= 3 && !SHIELD_TOKEN_SUFFIX_OK.has(head)) return `protected word "${p}"`;
      }
    }
  }
  const sq = shieldSquash(name);
  for (const p of ['poorboyai', 'telegram']) {
    if (sq.includes(p)) return `protected word "${p}"`;
  }
  return null;
}

function shieldImpersonationMatch(member, admins) {
  const name = `${member?.first_name ?? ''} ${member?.last_name ?? ''}`.trim();
  const sq = shieldSquash(name);
  if (sq) {
    for (const a of admins) {
      const an = `${a.user.first_name ?? ''} ${a.user.last_name ?? ''}`.trim();
      const asq = shieldSquash(an);
      if (asq && (sq === asq
        || (asq.length >= 5 && sq.includes(asq))
        || (sq.length >= 5 && asq.includes(sq)))) {
        return `display name matches admin "${an}"`;
      }
      const au = a.user.username ? shieldSquash(a.user.username) : '';
      const mu = member?.username ? shieldSquash(member.username) : '';
      if (au && mu && mu === au) return `username matches admin @${a.user.username}`;
    }
  }
  return shieldProtectedHit(name);
}

// ── Detection primitives ─────────────────────────────────────────────────

function shieldLinkKind(msg) {
  const ents = [...(msg?.entities ?? []), ...(msg?.caption_entities ?? [])];
  if (ents.some((e) => e?.type === 'url' || e?.type === 'text_link')) return 'link';
  const text = String(msg?.text ?? msg?.caption ?? '');
  if (/(https?:\/\/|www\.|t\.me\/|telegram\.me\/|telegram\.dog\/)/i.test(text)) return 'link';
  if (msg?.forward_date || msg?.forward_origin || msg?.forward_from
    || msg?.forward_from_chat || msg?.forward_sender_name) return 'forward';
  return null;
}

function shieldPhraseHit(settings, text) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return null;
  for (const re of SHIELD_SCAM_PATTERNS) {
    if (re.test(lower)) return 'built-in scam pattern';
  }
  for (const p of settings?.shieldPhrases ?? []) {
    if (p && lower.includes(p)) return `custom phrase "${p}"`;
  }
  return null;
}

/** PB Cleanup phase 2 (business chats) shares Shield's scam-phrase
 *  library as its default junk rule set: the curated built-in patterns
 *  plus a caller-supplied custom-phrase list. Returns the matched rule
 *  label, or null when the text is clean. */
export function shieldScamMatch(text, customPhrases = []) {
  return shieldPhraseHit(
    { shieldPhrases: Array.isArray(customPhrases) ? customPhrases : [] }, text);
}

function shieldWatchedEntry(settings, userId, now) {
  const w = settings?.shieldWatch?.[String(userId)];
  if (!w) return null;
  const active = now - (w.joinedAt ?? 0) < SHIELD_WATCH_MS || (w.msgs ?? 0) < SHIELD_WATCH_MSGS;
  return active ? w : null;
}

async function shieldRestrict(chatId, userId, seconds) {
  try {
    await api.restrictChatMember({
      chat_id: chatId, user_id: userId,
      permissions: SHIELD_PERMS_LIMITED,
      until_date: Math.floor(Date.now() / 1000) + seconds,
    });
    return true;
  } catch { return false; }
}

/** Add a strike to the (already-loaded) settings objects; returns count. */
function shieldAddStrike(strikes, userId, reason) {
  const key = String(userId);
  const cur = strikes[key] ?? { count: 0, reasons: [] };
  cur.count += 1;
  cur.lastAt = Date.now();
  cur.reasons = [...(cur.reasons ?? []), reason].slice(-5);
  strikes[key] = cur;
  return cur.count;
}

/**
 * Apply the escalation ladder for a fresh strike count. May delete the
 * user from the watch map (ban). Returns { action, entry } — the caller
 * appends `entry` to the shield log it persists.
 */
async function shieldApplyLadder(chatId, rights, user, count, watch) {
  const label = shieldUserLabel(user);
  if (count === 2) {
    if (rights.canRestrict && await shieldRestrict(chatId, user.id, SHIELD_RESTRICT_SEC)) {
      return { action: 'restricted 24h', entry: { kind: 'restrict', uid: user.id, name: label, detail: 'strike 2', action: 'restricted 24h (no links/media)' } };
    }
    return {
      action: 'restrict skipped (no rights)',
      entry: { kind: 'restrict', uid: user.id, name: label, detail: 'strike 2', action: rights.canRestrict ? 'restrict FAILED (Telegram refused)' : 'wanted restrict — alert-only (no rights)' },
    };
  }
  if (count >= 3) {
    let banned = false;
    if (rights.canRestrict) {
      banned = await api.banChatMember({ chat_id: chatId, user_id: user.id }).then(() => true).catch(() => false);
    }
    if (watch) delete watch[String(user.id)];
    return {
      action: banned ? 'banned' : 'ban skipped (no rights)',
      entry: {
        kind: 'ban', uid: user.id, name: label, detail: `strike ${count}`,
        action: banned ? 'banned (strike 3)' : (rights.canRestrict ? 'ban FAILED (Telegram refused)' : 'ban-eligible — alert-only (no rights)'),
      },
    };
  }
  return { action: 'deleted', entry: null };
}

// ── Burst mode ───────────────────────────────────────────────────────────

async function shieldEndBurst(chatId, settings, reason, editCard = true) {
  const burst = settings?.shieldBurst;
  if (!burst?.active) return false;
  const rights = await shieldRights(chatId);
  let restored = 0;
  if (rights.canRestrict) {
    for (const uid of burst.users ?? []) {
      if (await restoreChatAccess(chatId, uid)) restored += 1;
    }
  }
  const log = shieldLogPush(settings.shieldLog, {
    kind: 'burst_end', uid: null, name: null,
    detail: `${reason}; restored ${restored}/${(burst.users ?? []).length} restricted joiners`,
    action: 'burst mode off',
  });
  await setGroupSettings(chatId, { shieldBurst: null, shieldLog: log });
  if (editCard && burst.cardId) {
    await api.editMessageText({
      chat_id: chatId, message_id: burst.cardId,
      text: `🛡️ PB Shield — join burst over (${reason}). Restrictions from the burst are lifted.`,
    }).catch(() => {});
  }
  return true;
}

// ── Join hook (handlers/message.js service posts + handlers/chat_member.js;
//    the 30s seen-map makes the dual seam process each join exactly once) ──

export async function shieldJoinHook(chatId, member) {
  try {
    if (!member?.id) return false;
    let s = await getGroupSettings(chatId);
    if (s.shieldEnabled !== true) return false;
    const now = Date.now();
    // Lazy burst end: 10 quiet minutes with no joins closes burst mode
    // before this join is judged.
    if (s.shieldBurst?.active && now - (s.shieldBurst.lastJoin ?? 0) > SHIELD_BURST_QUIET_MS) {
      await shieldEndBurst(chatId, s, '10 quiet minutes');
      s = await getGroupSettings(chatId);
    }
    const seenKey = `${chatId}:${member.id}`;
    if (now - (shieldJoinSeen.get(seenKey) ?? 0) < 30_000) return false;
    shieldJoinSeen.set(seenKey, now);
    if (shieldJoinSeen.size > 5000) shieldJoinSeen.clear();

    const stamps = (shieldJoinStamps.get(String(chatId)) ?? [])
      .filter((ts) => now - ts < SHIELD_BURST_WINDOW_MS);
    stamps.push(now);
    shieldJoinStamps.set(String(chatId), stamps);

    // Soft signals (recorded once, at join; never an action alone).
    const fresh = Number(member.id) >= SHIELD_FRESH_ID_MIN;
    let noPhoto = false;
    try {
      const photos = await api.getUserProfilePhotos({ user_id: member.id, limit: 1 });
      noPhoto = (photos?.total_count ?? 1) === 0;
    } catch { /* unknown photo state is not a signal */ }

    const watch = { ...(s.shieldWatch ?? {}) };
    watch[String(member.id)] = {
      joinedAt: now,
      msgs: watch[String(member.id)]?.msgs ?? 0,
      fresh, noPhoto,
      name: shieldUserLabel(member),
    };
    const patch = { shieldWatch: watch };
    let log = s.shieldLog;
    if (fresh || noPhoto) {
      log = shieldLogPush(log, {
        kind: 'join', uid: member.id, name: shieldUserLabel(member),
        detail: `watched joiner${fresh ? ' · very new account' : ''}${noPhoto ? ' · no profile photo' : ''}`,
        action: 'watching (24h / first 5 messages)',
      });
    }

    let burst = s.shieldBurst?.active ? { ...s.shieldBurst } : null;
    if (!burst && stamps.length >= SHIELD_BURST_JOINS) {
      burst = { active: true, since: now, lastJoin: now, users: [], cardId: null };
      log = shieldLogPush(log, {
        kind: 'burst_start', uid: null, name: null,
        detail: `${stamps.length} joins inside 60 seconds`,
        action: 'burst mode on — new joiners auto-restricted',
      });
      const sent = await api.sendMessage({
        chat_id: chatId,
        text: [
          '🛡️ PB Shield — join burst detected',
          '',
          `${stamps.length}+ accounts joined inside a minute. New joiners are auto-restricted (text only — no links or media) until things calm down: 10 quiet minutes, or an admin ends burst mode.`,
        ].join('\n'),
        reply_markup: { inline_keyboard: [[
          { text: '✅ End burst mode', callback_data: `shield:burst:${chatId}` },
        ]] },
      }).catch(() => null);
      burst.cardId = sent?.message_id ?? null;
    }
    if (burst) {
      burst.lastJoin = now;
      const exempt = member.is_bot
        || (await isOwnerId(member.id))
        || (await isChatAdmin(chatId, member.id))
        || (await isWhitelisted(chatId, member.id));
      if (!exempt) {
        const rights = await shieldRights(chatId);
        if (rights.canRestrict
          && await shieldRestrict(chatId, member.id, SHIELD_BURST_RESTRICT_SEC)) {
          burst.users = [...new Set([...(burst.users ?? []), member.id])];
          log = shieldLogPush(log, {
            kind: 'burst_restrict', uid: member.id, name: shieldUserLabel(member),
            detail: 'joined during a join burst',
            action: 'restricted (text only) until burst ends',
          });
        } else if (!rights.canRestrict) {
          log = shieldLogPush(log, {
            kind: 'burst_restrict', uid: member.id, name: shieldUserLabel(member),
            detail: 'joined during a join burst',
            action: 'wanted restrict — alert-only (no rights)',
          });
        }
      }
      patch.shieldBurst = burst;
    }
    if (log !== s.shieldLog) patch.shieldLog = log;
    await setGroupSettings(chatId, patch);
    return true;
  } catch { return false; /* shield failures never break the join flow */ }
}

// ── Message hook (group automation block in handlers/message.js) ─────────
// ── Shield link check (2026-10-31 wave) ────────────────────────────────────
// Two layers, one verdict. Layer 1: URLhaus (POST /v1/url/, form-encoded,
// Auth-Key from ABUSECH_API_KEY config — presence/shape only, value never
// logged). Layer 2: PB's own hash-keyed threat list, fed by Shield
// deletions and shared across Shield-armed groups — a deliberate,
// Rowdy-approved exception to the sealed-communities rule: threat intel
// only, never message text. A link is judged malicious by URLhaus listing
// OR by a GoPlus EXTREME/HIGH verdict on a contract address carried in
// the link (reuse of /scan's fetchVerdict — MEDIUM and below never delete).
// Guards (Rowdy-ordered build parameters): Shield-armed groups only (the
// hook self-gates); exempt senders skipped BEFORE any query; verdict
// cache 7 days; URLhaus 429 arms a 1-hour backoff in config; FAIL OPEN on
// any API error, 429, backoff, missing key, or DB failure — delete
// nothing, never a delete on unknown. Stored rows carry hash + verdict +
// threat + source only — never a URL, never message text. The action-time
// admin alert card may name the flagged URL (enforcement notice, not a
// stored log). Redirects: the isolate's fetch FAILS on default-follow
// (proven 2026-10-31 probe) but honors redirect:'manual' with a Location
// header — so hops are followed by hand, max 5, and only headers are
// read (no page body is ever fetched or parsed). No URL constructor
// exists in the isolate (proven 'undefined') — normalization is manual
// string work. Only the first SHIELD_LINK_MAX_URLS links per message are
// judged (query-volume bound). Telegram-internal hosts (t.me etc.) are not
// web destinations and are never queried.

// Returns true when Shield deleted the message (the caller stops there).

const SHIELD_LINK_TTL_MS = 7 * 24 * 3600 * 1000;
const SHIELD_LINK_BACKOFF_MS = 3600 * 1000;
const SHIELD_LINK_BACKOFF_KEY = 'shield_urlhaus_backoff_until';
const SHIELD_LINK_MAX_URLS = 5;
const SHIELD_LINK_MAX_HOPS = 5;
const SHIELD_LINK_TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);
const SHIELD_LINK_CONTRACT_RE = /0x[0-9a-fA-F]{40}/g;

// Normalize for judging + hashing: trim sentence punctuation (but keep a
// trailing ')' — paren URLs are real), force https:// on www. links,
// lowercase scheme + host. Returns null for non-web destinations.
function shieldNormalizeUrl(raw) {
  let u = String(raw ?? '').trim().replace(/[.,;:!?'"+\]>]+$/g, '');
  if (!u) return null;
  if (/^www\./i.test(u)) u = 'https://' + u;
  const m = u.match(/^(https?:\/\/)([^/ ?#]+)(.*)$/i);
  if (!m) return null;
  const host = m[2].toLowerCase();
  if (SHIELD_LINK_TELEGRAM_HOSTS.has(host)) return null;
  return m[1].toLowerCase() + host + m[3];
}

// Extract normalized http(s) URLs from a message: text_link entity urls,
// url-entity slices (Telegram offsets are UTF-16 units — JS slice matches),
// plus a regex sweep for untagged links. Deduped, capped.
function shieldExtractUrls(msg) {
  const text = String(msg?.text ?? msg?.caption ?? '');
  const out = [];
  const push = (u) => {
    const n = shieldNormalizeUrl(u);
    if (n && !out.includes(n)) out.push(n);
  };
  const ents = [...(msg?.entities ?? []), ...(msg?.caption_entities ?? [])];
  for (const e of ents) {
    if (e?.type === 'text_link' && e.url) push(e.url);
    else if (e?.type === 'url' && typeof e.offset === 'number' && typeof e.length === 'number') {
      push(text.slice(e.offset, e.offset + e.length));
    }
  }
  const re = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) push(m[0]);
  return out.slice(0, SHIELD_LINK_MAX_URLS);
}

// Resolve a relative Location against the current URL by hand (no URL ctor).
function shieldResolveLocation(cur, loc) {
  if (/^https?:\/\//i.test(loc)) return loc;
  const m = cur.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
  if (!m) return cur;
  if (loc.startsWith('/')) return m[1] + loc;
  const base = m[2] ?? '/';
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  return m[1] + dir + loc;
}

// Follow redirects by hand (manual mode proven in-isolate; default-follow
// fails there). Returns the final normalized URL, or the last good URL on
// any failure — resolution failure never blocks the verdict on the URL
// itself, it only means the short link is judged as-is.
async function shieldResolveRedirects(url) {
  let cur = url;
  for (let i = 0; i < SHIELD_LINK_MAX_HOPS; i++) {
    let res;
    try {
      res = await fetch(cur, { redirect: 'manual' });
    } catch {
      return cur;
    }
    const loc = res?.headers?.get?.('location');
    if (res && res.status >= 300 && res.status < 400 && loc) {
      const next = shieldNormalizeUrl(shieldResolveLocation(cur, loc));
      if (!next) return cur; // landed on a non-web destination — judge cur
      cur = next;
      continue;
    }
    return cur;
  }
  return cur;
}

// Own-list hit (never expires) or a fresh (< 7d) cached verdict, else null.
// Every DB failure falls through to null — readers fail-open until migrate
// runs and on any later DB error.
async function shieldLookupHash(hash) {
  try {
    const own = await db.select().from(shield_link_ownlist).where(eq(shield_link_ownlist.urlHash, hash)).get();
    if (own) return { verdict: 'malicious', threat: own.threat, source: 'ownlist' };
  } catch { /* fall through */ }
  try {
    const row = await db.select().from(shield_link_verdicts).where(eq(shield_link_verdicts.urlHash, hash)).get();
    if (row && Date.now() - row.checkedAt * 1000 < SHIELD_LINK_TTL_MS) {
      return { verdict: row.verdict, threat: row.threat, source: row.source };
    }
  } catch { /* fall through */ }
  return null;
}

async function shieldLinkCacheWrite(urlHash, verdict, threat, source) {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db.insert(shield_link_verdicts).values({ urlHash, verdict, threat: threat ?? null, source, checkedAt: now })
      .onConflictDoUpdate({ target: shield_link_verdicts.urlHash, set: { verdict, threat: threat ?? null, source, checkedAt: now } })
      .run();
  } catch { /* cache write failure never blocks the verdict */ }
}

// A live malicious confirmation lands the link on PB's own list (or bumps
// its confirmation count). Own-list writes never block the verdict.
// urlDisplay (wizard wave, add-only): stored on NEW rows only; an existing
// row with a NULL display is filled forward, an existing display is never
// overwritten. Callers that must not create enforcement state (the member
// report path) do not call this at all — they judge with write:false.
async function shieldLinkOwnAdd(urlHash, threat, source, urlDisplay = null) {
  try {
    const row = await db.select().from(shield_link_ownlist).where(eq(shield_link_ownlist.urlHash, urlHash)).get();
    if (row) {
      const set = { hitCount: (row.hitCount ?? 1) + 1 };
      if (urlDisplay && !row.urlDisplay) set.urlDisplay = urlDisplay;
      await db.update(shield_link_ownlist).set(set).where(eq(shield_link_ownlist.urlHash, urlHash)).run();
    } else {
      await db.insert(shield_link_ownlist).values({ urlHash, threat, source, firstSeen: Math.floor(Date.now() / 1000), hitCount: 1, urlDisplay: urlDisplay ?? null }).run();
    }
  } catch { /* own-list write failure never blocks the verdict */ }
}

// Wizard removal: deletes exactly one own-list row. Returns true only when
// a row existed and was deleted. The confirm step lives in the wizard
// callback / endpoint (confirmed flag) — this function never runs
// unconfirmed from those surfaces.
async function shieldLinkOwnRemove(urlHash) {
  try {
    const row = await db.select().from(shield_link_ownlist).where(eq(shield_link_ownlist.urlHash, urlHash)).get();
    if (!row) return false;
    await db.delete(shield_link_ownlist).where(eq(shield_link_ownlist.urlHash, urlHash)).run();
    return true;
  } catch { return false; }
}

// Judge one normalized URL. Exported for owner-gated diagnostics: the
// live-proof probe calls the deployed judge directly (no message post).
// Returns { verdict, threat, source,
// backoffArmed }. 'clean' covers fail-open (error / 429 / backoff / no
// key) — the caller deletes NOTHING on clean. backoffArmed is true only
// on the transition that arms the backoff, so the caller logs it once.
export async function shieldJudgeLink(url, opts = {}) {
  // Wizard wave: opts.write === false makes the judge a PURE PROBE — it
  // still reads the own-list/cache (pre-existing enforcement state) and
  // still queries providers, but writes NO cache row and NO own-list row.
  // The member report path uses this so a report alone creates zero
  // enforcement state; only an admin approval re-judges with writes on.
  // Default (all rev 497 callers) is unchanged: writes on.
  const write = opts?.write !== false;
  let hash;
  try {
    hash = await sha256Hex(url);
  } catch {
    return { verdict: 'clean', threat: null, source: 'hash_error', backoffArmed: false };
  }
  const first = await shieldLookupHash(hash);
  if (first) return { ...first, backoffArmed: false };

  // Redirects first: a short link is judged as the site it lands on.
  // The final URL gets its own own-list + cache lookup.
  let finalUrl = url;
  let finalHash = hash;
  try {
    finalUrl = await shieldResolveRedirects(url);
    if (finalUrl !== url) {
      finalHash = await sha256Hex(finalUrl);
      const second = await shieldLookupHash(finalHash);
      if (second) return { ...second, backoffArmed: false };
    }
  } catch { /* resolution failure = judge the original URL */ }

  // GoPlus on any contract address carried in the final URL. EXTREME or
  // HIGH only — MEDIUM and below never delete, and a GoPlus failure
  // (null) simply falls through to URLhaus.
  const contracts = [...new Set(String(finalUrl).match(SHIELD_LINK_CONTRACT_RE) ?? [])].slice(0, 2);
  for (const addr of contracts) {
    let v = null;
    try {
      v = await fetchVerdict(addr);
    } catch {
      v = null;
    }
    if (v && (v.riskLevel === 'EXTREME' || v.riskLevel === 'HIGH')) {
      const threat = `goplus:${v.riskLevel}${v.flags?.[0] ? ` ${v.flags[0]}` : ''}`;
      if (write) {
        await shieldLinkCacheWrite(finalHash, 'malicious', threat, 'goplus');
        await shieldLinkOwnAdd(finalHash, threat, 'goplus', finalUrl);
      }
      return { verdict: 'malicious', threat, source: 'goplus', backoffArmed: false };
    }
  }

  // URLhaus, gated by the 1h backoff (GoPlus above still runs during
  // backoff — the backoff is an abuse.ch limit, not a general one).
  try {
    const until = Number(await getConfig(SHIELD_LINK_BACKOFF_KEY, '0')) || 0;
    if (Date.now() < until) return { verdict: 'clean', threat: null, source: 'backoff', backoffArmed: false };
  } catch { /* config read failure = assume unarmed; a 429 re-arms */ }
  let key = null;
  try {
    key = await getConfig('ABUSECH_API_KEY', null);
  } catch {
    key = null;
  }
  if (!key) return { verdict: 'clean', threat: null, source: 'nokey', backoffArmed: false };
  let res;
  try {
    res = await fetch('https://urlhaus-api.abuse.ch/v1/url/', {
      method: 'POST',
      headers: { 'Auth-Key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'url=' + encodeURIComponent(finalUrl),
    });
  } catch {
    return { verdict: 'clean', threat: null, source: 'urlhaus_error', backoffArmed: false };
  }
  if (res.status === 429) {
    try {
      await setConfig(SHIELD_LINK_BACKOFF_KEY, String(Date.now() + SHIELD_LINK_BACKOFF_MS));
    } catch { /* backoff write failure: next query re-tries, still fail-open */ }
    return { verdict: 'clean', threat: null, source: 'rate_limited', backoffArmed: true };
  }
  if (!res.ok) return { verdict: 'clean', threat: null, source: 'urlhaus_error', backoffArmed: false };
  let data;
  try {
    data = await res.json();
  } catch {
    return { verdict: 'clean', threat: null, source: 'urlhaus_error', backoffArmed: false };
  }
  const qs = data?.query_status;
  if (qs === 'no_results' || qs === 'invalid_url') {
    if (write) await shieldLinkCacheWrite(finalHash, 'clean', null, 'urlhaus');
    return { verdict: 'clean', threat: null, source: 'urlhaus', backoffArmed: false };
  }
  if (qs === 'ok') {
    // Single-lookup shape is FLAT (verified live 2026-10-31 diagnostic:
    // top-level id, urlhaus_reference, url, url_status, host, date_added,
    // last_online, threat — no urls array). The urls[] array shape belongs
    // to the feed/host endpoints; accept both so either shape works.
    const entry = Array.isArray(data?.urls) && data.urls.length ? data.urls[0] : data;
    const threat = String(entry?.threat ?? 'malware_download');
    if (write) {
      await shieldLinkCacheWrite(finalHash, 'malicious', threat, 'urlhaus');
      await shieldLinkOwnAdd(finalHash, threat, 'urlhaus', finalUrl);
    }
    return { verdict: 'malicious', threat, source: 'urlhaus', backoffArmed: false };
  }
  // Unknown query_status: fail open, do NOT cache an unknown.
  return { verdict: 'clean', threat: null, source: 'urlhaus_unknown', backoffArmed: false };
}

// Judge every link in a message; return the first malicious verdict (with
// backoffArmed OR-ed across all judges), or null when nothing is
// malicious. Callers delete only on a returned verdict.
async function shieldCheckMessageLinks(msg) {
  const urls = shieldExtractUrls(msg);
  let backoffArmed = false;
  for (const url of urls) {
    let r;
    try {
      r = await shieldJudgeLink(url);
    } catch {
      continue; // a judge failure is fail-open for that link
    }
    if (r?.backoffArmed) backoffArmed = true;
    if (r?.verdict === 'malicious') return { url, threat: r.threat, source: r.source, backoffArmed };
  }
  return backoffArmed ? { threat: null, source: 'rate_limited', backoffArmed, verdictOnly: true } : null;
}

// Judge the links of a message Shield already deleted (watched quarantine,
// phrase, impersonation) for propagation: a malicious verdict lands the
// link on PB's own list via shieldJudgeLink. Never throws, never changes
// the caller's outcome — it only writes threat intel.
async function shieldPropagateDeletedLinks(msg) {
  try {
    await shieldCheckMessageLinks(msg);
  } catch { /* propagation never breaks shield */ }
}

// ══ PB Shield link WIZARD (2026-10-31) — buttons, not typed commands ══
// Replaces the two rev 497 parked items: owner list/remove on /shield and
// the user /reportlink command. No new command exists: entry is the
// /shield status card (admins) / bare /shield panel (members) and the
// /manage Group Protection page, which posts the panel into the group.
//
// MEMBER-FLOW DECISION (recorded): members report ONLY. A member report
// judges with write:false (zero enforcement state — no cache row, no
// own-list row) and, on malicious, creates ONE pending row in
// shield_link_reports. Only an admin approval writes the own-list (via a
// fresh full judge). Members never add or remove directly, and a
// non-admin can never open a manage view: every step re-checks admin
// server-side (isChatAdmin live Bot API read, or owner) and refuses
// forged taps with an alert, changing nothing.
//
// DISPLAY DECISION (recorded): admin views show real URLs — to group
// admins/owner ONLY, in DM (never in a group message, which every member
// can read) and in admin-verified endpoint responses. Stored log rows
// and tallies still carry verdict + threat only, never URLs. Old
// own-list rows (urlDisplay NULL) still list with a "URL not stored
// (pre-wizard entry)" note and are still removable by tap.
//
// VISIBILITY RULE (why DM): a group panel message is member-visible by
// construction, so the flagged-links and pending-reports views — which
// carry full URLs — are DM'd to the tapping admin. The in-group panel
// itself carries buttons only, never URLs; in-group result messages
// carry verdict + threat + status only, never the pasted URL.

const SHIELD_WIZARD_CAPTURE_TTL_MS = 5 * 60_000;
const SHIELD_WIZARD_LIST_MAX = 20;
const shieldWizardCaptureKey = (chatId, userId) => `shield_wizard_report:${chatId}:${userId}`;
const shieldWizardAddKey = (chatId, userId) => `shield_wizard_add:${chatId}:${userId}`;
const shieldWizardRemoveKey = (chatId, userId) => `shield_wizard_remove:${chatId}:${userId}`;

export async function shieldWizardIsAdmin(chatId, userId) {
  if (!chatId || !userId) return false;
  if (await isOwnerId(userId)) return true;
  return await isChatAdmin(chatId, userId);
}

// Own-list rows, newest first, capped for display. Admin-only data:
// callers must have verified admin before calling (the wizard callback
// and the endpoint both do). The returned rows carry urlDisplay as
// stored (NULL for pre-wizard entries) — never sanitized away here,
// because this function's whole purpose is the admin view.
export async function shieldWizardListOwn() {
  let rows = [];
  try {
    rows = await db.select().from(shield_link_ownlist).all();
  } catch { return []; }
  rows.sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0));
  return rows.slice(0, SHIELD_WIZARD_LIST_MAX);
}

// Pending reports for one group (admin view) or all groups when chatId
// is null (endpoint admin-with-a-group uses the group form; the in-chat
// pending view always passes its group). Oldest first — the queue order.
export async function shieldWizardListPending(chatId = null) {
  try {
    const all = await db.select().from(shield_link_reports).all();
    const rows = all.filter((r) => r.status === 'pending' && (!chatId || String(r.chatId) === String(chatId)));
    rows.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return rows;
  } catch { return []; }
}

// Short callback token for an own-list row: first 12 hex chars of its
// hash. callback_data is capped at 64 bytes, so the full 64-char hash
// cannot ride a button; the handler resolves the token by prefix match
// and refuses on ambiguity (two rows sharing a prefix) rather than
// guessing.
export function shieldWizardOwnToken(urlHash) {
  return String(urlHash ?? '').slice(0, 12);
}

async function shieldWizardOwnByToken(token) {
  const rows = await shieldWizardListOwn();
  // The display cap could hide a row; resolve against the FULL table.
  let all = rows;
  try { all = await db.select().from(shield_link_ownlist).all(); } catch { /* fall back to capped list */ }
  const hits = all.filter((r) => String(r.urlHash ?? '').startsWith(String(token)));
  return hits.length === 1 ? hits[0] : null;
}

// CORE REPORT — shared by the in-chat capture and the getDashboard
// endpoint, so both surfaces behave identically:
//   input: { chatId, reporterId, raw } — raw is the pasted text.
//   invalid/empty: { ok: false, error: 'empty_or_invalid' } — no query,
//     no row, no write of any kind (the judge is never called).
//   clean: { ok: true, status: 'clean', verdict, threat, source } — no
//     row, no own-list write, for members AND admins.
//   member + malicious: { ok: true, status: 'pending', reportId, verdict,
//     threat, source } — one pending row; the judge ran write:false, so
//     this creates ZERO enforcement state.
//   admin + malicious: { ok: true, status: 'added', verdict, threat,
//     source } — the full judge already wrote the own-list (with the
//     display URL) and the verdict cache; no pending row is created.
//     This is the endpoint's one-tap shape: the submit IS the tap.
//     (The in-chat admin path differs deliberately: it judges
//     write:false first, shows the verdict card, and the admin's tap on
//     "Add to own list" performs the write via shieldWizardAdminAdd —
//     same end state, verdict shown before the write.)
// Member responses carry verdict/threat/status ONLY — never the URL.
// Admin responses may carry the URL (the admin submitted it and is
// verified); the endpoint strips it for non-admins regardless.
export async function shieldWizardReport({ chatId, reporterId, raw }) {
  const urls = shieldExtractUrls({ text: String(raw ?? '') });
  const url = urls[0] ?? null;
  if (!url) return { ok: false, error: 'empty_or_invalid' };
  const isAdmin = await shieldWizardIsAdmin(chatId, reporterId);
  let judged;
  try {
    judged = await shieldJudgeLink(url, isAdmin ? {} : { write: false });
  } catch {
    return { ok: false, error: 'judge_failed' };
  }
  if (judged?.verdict !== 'malicious') {
    return { ok: true, status: 'clean', verdict: 'clean', threat: null, source: judged?.source ?? null };
  }
  if (isAdmin) {
    // Full judge already wrote the own-list (display = final URL) above.
    return { ok: true, status: 'added', verdict: 'malicious', threat: judged.threat, source: judged.source, url };
  }
  const created = await shieldWizardCreatePending({ chatId, reporterId, url, threat: judged.threat });
  if (!created.ok) return { ok: false, error: created.error ?? 'report_store_failed' };
  return { ok: true, status: 'pending', reportId: created.reportId, verdict: 'malicious', threat: judged.threat, source: judged.source };
}

// Creates (or dedupes) the pending row for an already-judged-malicious
// URL. Pure row write — it never judges and never touches the own-list,
// so the in-chat capture (which judged once, write:false) can reuse it
// without a second provider query.
export async function shieldWizardCreatePending({ chatId, reporterId, url, threat }) {
  const now = Math.floor(Date.now() / 1000);
  let urlHash;
  try { urlHash = await sha256Hex(url); } catch { return { ok: false, error: 'judge_failed' }; }
  try {
    const existing = await db.select().from(shield_link_reports)
      .where(and(eq(shield_link_reports.chatId, String(chatId)), eq(shield_link_reports.urlHash, urlHash), eq(shield_link_reports.status, 'pending'))).get();
    if (existing) return { ok: true, reportId: existing.id };
    const id = await sha256Hex(`report:${chatId}:${urlHash}:${now}:${reporterId}`);
    await db.insert(shield_link_reports).values({
      id, urlHash, urlDisplay: url, reporterId: String(reporterId), chatId: String(chatId),
      status: 'pending', threat: threat ?? null, createdAt: now, decidedBy: null, decidedAt: null,
    }).run();
    return { ok: true, reportId: id };
  } catch {
    return { ok: false, error: 'report_store_failed' };
  }
}

// In-chat admin one-tap add: consumes the pending-add session armed when
// the admin's pasted URL judged malicious (write:false). Re-verifies
// admin at tap time. Returns the outcome for the callback answer + card.
export async function shieldWizardAdminAdd(chatId, userId) {
  if (!(await shieldWizardIsAdmin(chatId, userId))) return { ok: false, error: 'not_admin' };
  let sess = null;
  try {
    const raw = await getConfig(shieldWizardAddKey(chatId, userId), null);
    sess = raw ? JSON.parse(raw) : null;
    if (!sess?.urlHash || Date.now() > (sess.expiresAt ?? 0)) sess = null;
  } catch { sess = null; }
  if (!sess) return { ok: false, error: 'expired' };
  await setConfig(shieldWizardAddKey(chatId, userId), '').catch(() => {});
  await shieldLinkOwnAdd(sess.urlHash, sess.threat ?? 'wizard_add', 'wizard', sess.url ?? null);
  return { ok: true, urlHash: sess.urlHash, threat: sess.threat ?? null };
}

// CORE APPROVE / DISMISS / REMOVE — shared by callbacks + endpoint.
// Every one re-verifies admin against the row's own group (never a
// client-sent isAdmin flag) and refuses non-admins with no write.
export async function shieldWizardApprove(reportId, adminId) {
  let row = null;
  try { row = await db.select().from(shield_link_reports).where(eq(shield_link_reports.id, String(reportId))).get(); } catch { /* fall through */ }
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'pending') return { ok: false, error: 'not_pending', status: row.status };
  if (!(await shieldWizardIsAdmin(row.chatId, adminId))) return { ok: false, error: 'not_admin' };
  // Fresh full judge on the stored display URL: if still malicious the
  // judge itself writes the own-list (display included); if now clean,
  // nothing is written and the report closes as dismissed.
  let judged = null;
  try { judged = row.urlDisplay ? await shieldJudgeLink(row.urlDisplay) : null; } catch { judged = null; }
  const now = Math.floor(Date.now() / 1000);
  if (judged?.verdict === 'malicious') {
    try {
      await db.update(shield_link_reports).set({ status: 'approved', decidedBy: String(adminId), decidedAt: now }).where(eq(shield_link_reports.id, row.id)).run();
    } catch { /* status write best-effort; own-list write already landed */ }
    return { ok: true, status: 'approved', verdict: 'malicious', threat: judged.threat, source: judged.source };
  }
  try {
    await db.update(shield_link_reports).set({ status: 'dismissed', decidedBy: String(adminId), decidedAt: now }).where(eq(shield_link_reports.id, row.id)).run();
  } catch { /* best-effort */ }
  return { ok: true, status: 'dismissed', verdict: 'clean', threat: null, source: judged?.source ?? null, reason: 'now_clean' };
}

export async function shieldWizardDismiss(reportId, adminId) {
  let row = null;
  try { row = await db.select().from(shield_link_reports).where(eq(shield_link_reports.id, String(reportId))).get(); } catch { /* fall through */ }
  if (!row) return { ok: false, error: 'not_found' };
  if (row.status !== 'pending') return { ok: false, error: 'not_pending', status: row.status };
  if (!(await shieldWizardIsAdmin(row.chatId, adminId))) return { ok: false, error: 'not_admin' };
  try {
    await db.update(shield_link_reports).set({ status: 'dismissed', decidedBy: String(adminId), decidedAt: Math.floor(Date.now() / 1000) }).where(eq(shield_link_reports.id, row.id)).run();
  } catch { return { ok: false, error: 'store_failed' }; }
  return { ok: true, status: 'dismissed' };
}

export async function shieldWizardRemove({ chatId, adminId, urlHash, confirmed }) {
  if (!(await shieldWizardIsAdmin(chatId, adminId))) return { ok: false, error: 'not_admin' };
  if (confirmed !== true) return { ok: false, error: 'confirm_required' };
  const removed = await shieldLinkOwnRemove(String(urlHash));
  if (!removed) return { ok: false, error: 'not_found' };
  return { ok: true, removed: true };
}

// ── In-chat wizard panels + callbacks ─────────────────────────────────────
// The in-group panel carries buttons only, never URLs (group messages are
// member-visible). Admin detail views are DM'd to the tapping admin.

export function shieldWizardPanelKeyboard(chatId, isAdmin) {
  const rows = [[{ text: '🔗 Report a link', callback_data: `shield:wizrep:${chatId}` }]];
  if (isAdmin) {
    rows.push([{ text: '📋 Flagged links (DM)', callback_data: `shield:wizlist:${chatId}` }]);
    rows.push([{ text: '📥 Pending reports (DM)', callback_data: `shield:wizpend:${chatId}` }]);
  }
  return { inline_keyboard: rows };
}

export function shieldWizardPanelText(isAdmin) {
  return isAdmin
    ? '🛡️ Shield link wizard\nStep 1 of 2 — tap Report, then paste\n────────────────\nReport a suspicious link (paste it as your next message here), or manage in DM:\n• Flagged links — PB\'s own list, with remove\n• Pending reports — member reports awaiting your call\n\nAdmin views arrive by DM so flagged URLs are never shown to members in the group.'
    : '🛡️ Shield link wizard\nStep 1 of 2 — tap Report, then paste\n────────────────\nPaste the suspicious link as your next message here. PB judges it and, if it is malicious, submits it for admin review. Clean links add nothing.';
}

async function shieldWizardDm(userId, text, keyboard) {
  try {
    await api.sendMessage({ chat_id: userId, text: String(text).slice(0, 4000), reply_markup: keyboard });
    return true;
  } catch { return false; }
}

function shieldWizardFmtDate(unixSec) {
  try { return new Date((unixSec ?? 0) * 1000).toISOString().slice(0, 10); } catch { return '—'; }
}

async function shieldWizardSendOwnListDm(chatId, userId) {
  const rows = await shieldWizardListOwn();
  const lines = ['🛡️ Flagged links — PB\'s own list', ''];
  if (!rows.length) {
    lines.push('Nothing flagged yet. Links Shield deletes as malicious land here and protect every Shield group.');
  } else {
    rows.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.threat ?? 'malicious'} · first seen ${shieldWizardFmtDate(r.firstSeen)} · ${r.hitCount ?? 1} hit${(r.hitCount ?? 1) === 1 ? '' : 's'}`);
      lines.push(`   ${r.urlDisplay ?? 'URL not stored (pre-wizard entry)'}`);
    });
    if (rows.length >= SHIELD_WIZARD_LIST_MAX) lines.push('', `Showing the ${SHIELD_WIZARD_LIST_MAX} newest.`);
  }
  const keyboard = { inline_keyboard: [
    ...rows.map((r) => [{ text: `❌ Remove: ${(r.urlDisplay ?? r.threat ?? 'entry').slice(0, 24)}`, callback_data: `shield:wizrm:${chatId}:${shieldWizardOwnToken(r.urlHash)}` }]),
    [{ text: '🔗 Report a link', callback_data: `shield:wizrep:${chatId}` }],
  ] };
  return shieldWizardDm(userId, lines.join('\n'), keyboard);
}

async function shieldWizardSendPendingDm(chatId, userId) {
  const rows = await shieldWizardListPending(chatId);
  const lines = ['🛡️ Pending member reports', ''];
  if (!rows.length) {
    lines.push('No pending reports for this group.');
  } else {
    rows.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.threat ?? 'malicious'} · reported ${shieldWizardFmtDate(r.createdAt)} · by ID ${r.reporterId}`);
      lines.push(`   ${r.urlDisplay ?? '(URL not stored)'}`);
    });
  }
  // Report ids are 64-hex; buttons carry a short token instead: the
  // report row is resolved in the callback by matching the pending list
  // order at tap time AND the stored hash prefix — see wizap/wizdis.
  // To keep the token stable across renders, use the first 12 chars of
  // the report id (unique per report: id hashes chat + url + second +
  // reporter).
  const keyboard = { inline_keyboard: [
    ...rows.flatMap((r) => [[
      { text: `✅ Approve #${String(r.id).slice(0, 6)}`, callback_data: `shield:wizap:${chatId}:${String(r.id).slice(0, 12)}` },
      { text: `✖ Dismiss #${String(r.id).slice(0, 6)}`, callback_data: `shield:wizdis:${chatId}:${String(r.id).slice(0, 12)}` },
    ]]),
    [{ text: '📋 Flagged links (DM)', callback_data: `shield:wizlist:${chatId}` }],
  ] };
  return shieldWizardDm(userId, lines.join('\n'), keyboard);
}

async function shieldWizardPendingByToken(chatId, token) {
  const rows = await shieldWizardListPending(chatId);
  const hits = rows.filter((r) => String(r.id ?? '').startsWith(String(token)));
  return hits.length === 1 ? hits[0] : null;
}

// In-chat callback router for shield:wiz* buttons. Returns { text, alert }
// for the callback_query router's answerCallbackQuery. Panel edits target
// the message carrying the button (query.message.chat.id) — admin views
// live in DM, so editing the GROUP id (the old shield card pattern) would
// edit a message that does not exist there.
export async function handleShieldWizardCallback(query) {
  try {
    const parts = String(query?.data ?? '').split(':');
    const act = parts[1];
    const chatId = parts[2];
    const arg = parts[3] ?? null;
    const clicker = query?.from?.id;
    const msgChatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;
    if (!chatId || !clicker || !act?.startsWith('wiz')) return { text: 'Shield: stale button.', alert: true };
    const isAdmin = await shieldWizardIsAdmin(chatId, clicker);
    const editPanel = async (text, keyboard) => {
      if (!msgChatId || !messageId) return;
      await api.editMessageText({ chat_id: msgChatId, message_id: messageId, text: String(text).slice(0, 4000), reply_markup: keyboard }).catch(() => {});
    };

    if (act === 'wizrep') {
      // Arm the one-shot paste capture (group + user scoped, 5-min TTL).
      // The capture handler consumes the NEXT non-command message from
      // this user in this group and judges it — nothing else changes.
      await setConfig(shieldWizardCaptureKey(chatId, clicker), JSON.stringify({ chatId: String(chatId), expiresAt: Date.now() + SHIELD_WIZARD_CAPTURE_TTL_MS })).catch(() => {});
      return { text: 'Paste the link as your next message here (5 minutes).', alert: true };
    }
    if (act === 'wizsend') {
      // From the /manage Group Protection page (DM panel): post the
      // in-group wizard panel into the group. Admin-gated.
      if (!isAdmin) return { text: '⛔ Group admins only.', alert: true };
      await shieldSend(chatId, shieldWizardPanelText(true), { reply_markup: shieldWizardPanelKeyboard(chatId, true) });
      return { text: 'Wizard posted in the group.' };
    }
    if (act === 'wizlist') {
      if (!isAdmin) return { text: '⛔ Group admins only — members report, admins manage.', alert: true };
      const ok = await shieldWizardSendOwnListDm(chatId, clicker);
      return ok ? { text: 'Flagged links sent to your DM.' } : { text: 'Could not reach your DM — start PB in DM first, then tap again.', alert: true };
    }
    if (act === 'wizpend') {
      if (!isAdmin) return { text: '⛔ Group admins only — members report, admins manage.', alert: true };
      const ok = await shieldWizardSendPendingDm(chatId, clicker);
      return ok ? { text: 'Pending reports sent to your DM.' } : { text: 'Could not reach your DM — start PB in DM first, then tap again.', alert: true };
    }
    if (act === 'wizadd') {
      const res = await shieldWizardAdminAdd(chatId, clicker);
      if (!res.ok) return { text: res.error === 'not_admin' ? '⛔ Group admins only.' : '⏰ That add prompt expired — report the link again.', alert: true };
      return { text: '✅ Added to PB\'s own list — it now protects every Shield group.' };
    }
    if (act === 'wizap' || act === 'wizdis') {
      if (!isAdmin) return { text: '⛔ Group admins only.', alert: true };
      const row = await shieldWizardPendingByToken(chatId, arg);
      if (!row) return { text: 'That report is gone or already decided.', alert: true };
      const res = act === 'wizap' ? await shieldWizardApprove(row.id, clicker) : await shieldWizardDismiss(row.id, clicker);
      if (!res.ok) return { text: `Could not decide that report (${res.error ?? 'error'}).`, alert: true };
      await editPanel(`🛡️ Report ${res.status === 'approved' ? 'approved — the link is now on PB\'s own list.' : 'dismissed — nothing was added.'}`, { inline_keyboard: [] });
      return { text: res.status === 'approved' ? 'Approved — own list updated.' : 'Dismissed.' };
    }
    if (act === 'wizrm') {
      if (!isAdmin) return { text: '⛔ Group admins only.', alert: true };
      const row = await shieldWizardOwnByToken(arg);
      if (!row) return { text: 'That entry is gone or ambiguous — reopen Flagged links.', alert: true };
      // CONFIRM STEP (required — removal is destructive): store the
      // target server-side; the confirm button carries no hash, so a
      // forged or stale tap cannot delete anything unconfirmed.
      await setConfig(shieldWizardRemoveKey(chatId, clicker), JSON.stringify({ urlHash: row.urlHash, expiresAt: Date.now() + SHIELD_WIZARD_CAPTURE_TTL_MS })).catch(() => {});
      await editPanel(
        `🛡️ Remove this flagged link?\n\n${row.urlDisplay ?? 'URL not stored (pre-wizard entry)'}\nThreat: ${row.threat ?? 'malicious'} · first seen ${shieldWizardFmtDate(row.firstSeen)} · ${row.hitCount ?? 1} hit${(row.hitCount ?? 1) === 1 ? '' : 's'}\n\nRemoving ends second-group protection for this entry. This cannot be undone by tap — a later malicious verdict would re-add it.`,
        { inline_keyboard: [[
          { text: '✅ Yes, remove it', callback_data: `shield:wizrmy:${chatId}` },
          { text: '✖ Keep it', callback_data: `shield:wizrmn:${chatId}` },
        ]] });
      return { text: 'Confirm the removal.' };
    }
    if (act === 'wizrmy') {
      if (!isAdmin) return { text: '⛔ Group admins only.', alert: true };
      let sess = null;
      try {
        const raw = await getConfig(shieldWizardRemoveKey(chatId, clicker), null);
        sess = raw ? JSON.parse(raw) : null;
        if (!sess?.urlHash || Date.now() > (sess.expiresAt ?? 0)) sess = null;
      } catch { sess = null; }
      if (!sess) return { text: '⏰ That removal prompt expired — reopen Flagged links.', alert: true };
      await setConfig(shieldWizardRemoveKey(chatId, clicker), '').catch(() => {});
      const res = await shieldWizardRemove({ chatId, adminId: clicker, urlHash: sess.urlHash, confirmed: true });
      if (!res.ok) return { text: 'That entry is already gone.', alert: true };
      await editPanel('🛡️ Removed from PB\'s own list — second-group protection for that entry has ended.', { inline_keyboard: [] });
      return { text: 'Removed.' };
    }
    if (act === 'wizrmn') {
      await setConfig(shieldWizardRemoveKey(chatId, clicker), '').catch(() => {});
      await editPanel('🛡️ Kept — the entry stays on PB\'s own list.', { inline_keyboard: [] });
      return { text: 'Kept.' };
    }
    return { text: 'Shield: stale button.', alert: true };
  } catch (err) {
    return { text: `❌ ${err?.message ?? 'Shield wizard error'}`, alert: true };
  }
}

// Paste capture (handlers/message.js group seam, BEFORE the Shield hook):
// while a wizard report capture is armed for this user in this group,
// their next non-command message IS the pasted link. Returns true when
// consumed (judged, refused, or invalid-with-session-still-armed).
// Commands are never consumed. A malicious submitted message is deleted
// best-effort (Shield would have deleted it on post anyway); a clean
// submission is left in place — it was a normal message too. Result
// messages carry verdict + threat + status only, never the URL.
export async function handleShieldWizardCapture(chatId, message) {
  try {
    const userId = message?.from?.id;
    if (!userId || message?.from?.is_bot) return false;
    const text = String(message?.text ?? message?.caption ?? '');
    if (text.startsWith('/')) return false;
    let sess = null;
    let expired = false;
    try {
      const raw = await getConfig(shieldWizardCaptureKey(chatId, userId), null);
      if (raw) {
        sess = JSON.parse(raw);
        if (!sess?.chatId || String(sess.chatId) !== String(chatId)) sess = null;
        else if (Date.now() > (sess.expiresAt ?? 0)) { sess = null; expired = true; }
      }
    } catch { sess = null; }
    if (!sess) {
      if (expired) {
        await setConfig(shieldWizardCaptureKey(chatId, userId), '').catch(() => {});
        await shieldSend(chatId, '⏰ That link-report prompt expired (5 minutes). Tap 🔗 Report a link again to reopen it.');
        return true;
      }
      return false;
    }
    const urls = shieldExtractUrls(message);
    if (!urls.length) {
      await shieldSend(chatId, '⚠️ No link found in that message — paste a URL (the prompt is still open).');
      return true;
    }
    await setConfig(shieldWizardCaptureKey(chatId, userId), '').catch(() => {});
    const isAdmin = await shieldWizardIsAdmin(chatId, userId);
    // Admin path judges write:false here so the verdict card precedes
    // any write; the Add button then writes (one tap). Member path
    // judges write:false via the core and creates the pending row.
    const judged = await shieldJudgeLink(urls[0], { write: false }).catch(() => null);
    if (!judged) {
      await shieldSend(chatId, '❌ Could not judge that link right now — nothing was added. Try again.');
      return true;
    }
    if (judged.verdict !== 'malicious') {
      await shieldSend(chatId, '✅ That link looks clean — nothing was added.');
      return true;
    }
    if (!isAdmin) {
      // Single judge above (write:false) + row write only — no second
      // provider query, no own-list touch.
      const res = await shieldWizardCreatePending({ chatId, reporterId: userId, url: urls[0], threat: judged.threat });
      if (res.ok) {
        await shieldSend(chatId, `🛡️ Report submitted for admin review (threat: ${judged.threat ?? 'malicious'}). Admins decide — nothing is added until they approve.`);
      } else {
        await shieldSend(chatId, '❌ Could not submit that report — nothing was added. Try again.');
      }
      // The submitted message itself carried a malicious link: remove it
      // best-effort, exactly as Shield would have on a normal post.
      if (message?.message_id) await api.deleteMessage({ chat_id: chatId, message_id: message.message_id }).catch(() => {});
      return true;
    }
    // Admin: arm the one-tap add (server-side session, no URL in the
    // group message) and show the verdict card with the Add button.
    let urlHash = null;
    try { urlHash = await sha256Hex(urls[0]); } catch { urlHash = null; }
    if (urlHash) {
      await setConfig(shieldWizardAddKey(chatId, userId), JSON.stringify({ urlHash, url: urls[0], threat: judged.threat ?? null, expiresAt: Date.now() + SHIELD_WIZARD_CAPTURE_TTL_MS })).catch(() => {});
    }
    await shieldSend(chatId,
      `🛡️ That link judged MALICIOUS (threat: ${judged.threat ?? 'malicious'}, source: ${judged.source ?? 'check'}).\n\nTap below to add it to PB's own list — it will then protect every Shield group.`,
      { reply_markup: { inline_keyboard: [[{ text: '➕ Add to own list', callback_data: `shield:wizadd:${chatId}` }]] } });
    if (message?.message_id) await api.deleteMessage({ chat_id: chatId, message_id: message.message_id }).catch(() => {});
    return true;
  } catch { return false; }
}

export async function shieldMessageHook(chatId, msg) {
  try {
    const from = msg?.from;
    if (!from || from.is_bot) return false;
    let s = await getGroupSettings(chatId);
    if (s.shieldEnabled !== true) return false;
    const now = Date.now();
    if (s.shieldBurst?.active && now - (s.shieldBurst.lastJoin ?? 0) > SHIELD_BURST_QUIET_MS) {
      await shieldEndBurst(chatId, s, '10 quiet minutes');
      s = await getGroupSettings(chatId);
    }
    // Exemptions: owner, group admins, whitelisted members — always.
    if (await isOwnerId(from.id)) return false;
    if (await isChatAdmin(chatId, from.id)) return false;
    if (await isWhitelisted(chatId, from.id)) return false;

    const rights = await shieldRights(chatId);
    const label = shieldUserLabel(from);
    const patch = {};
    let log = s.shieldLog;
    const pushLog = (entry) => { log = shieldLogPush(log, entry); };

    // ── Impersonation (strong signal; any member, watched or not) ──
    const impMark = s.shieldImpersonated?.[String(from.id)];
    const admins = await shieldAdmins(chatId);
    const match = shieldImpersonationMatch(from, admins);
    if (match) {
      let deleted = false;
      if (rights.canDelete) {
        deleted = await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id })
          .then(() => true).catch(() => false);
      }
      if (impMark && now - impMark < SHIELD_WATCH_MS) {
        // Already flagged and awaiting an admin ruling: keep deleting
        // quietly — no repeat card, no extra strike.
        // Link-check propagation: a quietly deleted link-bearing message
        // still gets judged for PB's own list (never changes this outcome).
        try { await shieldPropagateDeletedLinks(msg); } catch { /* never break shield */ }
        if (log !== s.shieldLog) { patch.shieldLog = log; await setGroupSettings(chatId, patch); }
        return deleted;
      }
      const strikes = { ...(s.shieldStrikes ?? {}) };
      const count = shieldAddStrike(strikes, from.id, `impersonation (${match})`);
      patch.shieldStrikes = strikes;
      const imp = { ...(s.shieldImpersonated ?? {}), [String(from.id)]: now };
      patch.shieldImpersonated = imp;
      let restricted = false;
      if (rights.canRestrict) {
        restricted = await shieldRestrict(chatId, from.id, SHIELD_RESTRICT_SEC);
      }
      pushLog({
        kind: 'impersonation', uid: from.id, name: label, detail: match,
        action: rights.canRestrict || rights.canDelete
          ? `${deleted ? 'deleted' : 'delete failed'} + ${restricted ? 'restricted 24h' : 'restrict failed'} · strike ${count} · admin card posted`
          : `alert-only (no rights) · strike ${count} · admin card posted`,
      });
      // Link-check propagation: an impersonation delete of a link-bearing
      // message still gets judged for PB's own list (outcome unchanged).
      try { await shieldPropagateDeletedLinks(msg); } catch { /* never break shield */ }
      patch.shieldLog = log;
      await setGroupSettings(chatId, patch);
      await api.sendMessage({
        chat_id: chatId,
        text: [
          '🛡️ PB Shield — possible impersonator',
          '',
          `${label} (ID ${from.id}) is posting as “${`${from.first_name ?? ''} ${from.last_name ?? ''}`.trim()}” — ${match}.`,
          (rights.canDelete || rights.canRestrict)
            ? `Action taken: message ${deleted ? 'deleted' : 'flagged'}${restricted ? ' + restricted 24h (text only)' : ''}. Strike ${count} of 3.`
            : 'PB is alert-only in this group (missing delete/restrict rights), so no action was taken — admins, please review.',
          '',
          'Admins: Ban removes them for good · Release lifts the restriction and clears the strike · Dismiss leaves the restriction standing.',
        ].join('\n'),
        reply_markup: { inline_keyboard: [[
          { text: '🔨 Ban', callback_data: `shield:ban:${chatId}:${from.id}` },
          { text: '🔓 Release', callback_data: `shield:rel:${chatId}:${from.id}` },
          { text: '✖ Dismiss', callback_data: `shield:dis:${chatId}:${from.id}` },
        ]] },
      }).catch(() => {});
      return deleted;
    }

    const watchAll = { ...(s.shieldWatch ?? {}) };
    const entry = shieldWatchedEntry(s, from.id, now);
    const text = String(msg.text ?? msg.caption ?? '');

    // ── Watched member: link quarantine + phrase strikes ──
    if (entry) {
      const linkKind = shieldLinkKind(msg);
      const phrase = linkKind ? null : shieldPhraseHit(s, text);
      if (linkKind || phrase) {
        let deleted = false;
        if (rights.canDelete) {
          deleted = await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id })
            .then(() => true).catch(() => false);
        }
        const strikes = { ...(patch.shieldStrikes ?? s.shieldStrikes ?? {}) };
        const reason = linkKind
          ? `${linkKind} during the new-joiner watch window`
          : `scam phrase during the watch window (${phrase})`;
        const count = shieldAddStrike(strikes, from.id, reason);
        patch.shieldStrikes = strikes;
        pushLog({
          kind: linkKind ?? 'phrase', uid: from.id, name: label,
          detail: reason + ((entry.fresh || entry.noPhoto)
            ? ` · signals:${entry.fresh ? ' very-new-account' : ''}${entry.noPhoto ? ' no-photo' : ''}` : ''),
          action: rights.canDelete
            ? `${deleted ? 'deleted' : 'delete failed'} · strike ${count}`
            : `alert-only (no rights) · strike ${count}`,
        });
        const ladder = await shieldApplyLadder(chatId, rights, from, count, watchAll);
        if (ladder.entry) pushLog(ladder.entry);
        // Three stacked signals (fresh account + no photo + scam phrase)
        // earn the strike-2 treatment immediately — still never a ban.
        if (phrase && !linkKind && entry.fresh && entry.noPhoto && count < 2 && rights.canRestrict) {
          if (await shieldRestrict(chatId, from.id, SHIELD_RESTRICT_SEC)) {
            pushLog({
              kind: 'restrict', uid: from.id, name: label,
              detail: 'fresh account + no photo + scam phrase',
              action: 'restricted 24h (stacked signals)',
            });
          }
        }
        // Link-check propagation: the quarantined link gets judged — a
        // malicious verdict lands it on PB's own list (outcome unchanged:
        // watched links are deleted by quarantine regardless of verdict).
        if (linkKind) {
          try { await shieldPropagateDeletedLinks(msg); } catch { /* never break shield */ }
        }
        patch.shieldWatch = watchAll;
        patch.shieldLog = log;
        await setGroupSettings(chatId, patch);
        return deleted;
      }
      // Clean watched message: count it toward graduating the watch.
      entry.msgs = (entry.msgs ?? 0) + 1;
      if (now - (entry.joinedAt ?? 0) >= SHIELD_WATCH_MS && entry.msgs >= SHIELD_WATCH_MSGS) {
        delete watchAll[String(from.id)]; // graduated — established member now
      } else {
        watchAll[String(from.id)] = entry;
      }
      patch.shieldWatch = watchAll;
      if (log !== s.shieldLog) patch.shieldLog = log;
      await setGroupSettings(chatId, patch);
      return false;
    }

    // ── Established member: scam phrase = delete + log only ──
    const phrase = shieldPhraseHit(s, text);
    if (phrase) {
      let deleted = false;
      if (rights.canDelete) {
        deleted = await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id })
          .then(() => true).catch(() => false);
      }
      pushLog({
        kind: 'phrase', uid: from.id, name: label,
        detail: `scam phrase (${phrase}) — established member`,
        action: rights.canDelete
          ? `${deleted ? 'deleted' : 'delete failed'} · no strike (established)`
          : 'alert-only (no rights) · no strike (established)',
      });
      // Link-check propagation: a phrase-deleted message that also carries
      // links still gets judged for PB's own list (outcome unchanged).
      try { await shieldPropagateDeletedLinks(msg); } catch { /* never break shield */ }
      patch.shieldLog = log;
      await setGroupSettings(chatId, patch);
      return deleted;
    }
    // ── Established member: malicious link = delete + log only ──
    // (no strike — same as the phrase rule above; the ladder's strike
    // path stays watched-only. A judged-malicious link is already on PB's
    // own list via shieldJudgeLink, so other Shield groups are covered.)
    const linkVerdict = await shieldCheckMessageLinks(msg);
    if (linkVerdict?.verdictOnly) {
      // Backoff armed during judging, nothing malicious: one log line,
      // no delete, no alert card.
      pushLog({
        kind: 'linkcheck_backoff', uid: from.id, name: label,
        detail: 'URLhaus 429 — queries paused 1h',
        action: 'fail-open; nothing deleted for rate-limit',
      });
      patch.shieldLog = log;
      await setGroupSettings(chatId, patch);
    } else if (linkVerdict) {
      let deleted = false;
      if (rights.canDelete) {
        deleted = await api.deleteMessage({ chat_id: chatId, message_id: msg.message_id })
          .then(() => true).catch(() => false);
      }
      pushLog({
        kind: 'malicious_link', uid: from.id, name: label,
        detail: `malicious link (${linkVerdict.source}: ${linkVerdict.threat}) — established member`,
        action: rights.canDelete
          ? `${deleted ? 'deleted' : 'delete failed'} · no strike (established)`
          : 'alert-only (no rights) · no strike (established)',
      });
      patch.shieldLog = log;
      await setGroupSettings(chatId, patch);
      // Action-time alert names the flagged URL (enforcement notice, not
      // a stored log — stored rows carry verdict + threat only).
      await api.sendMessage({
        chat_id: chatId,
        text: [
          '🛡️ PB Shield — malicious link removed',
          '',
          `${label} posted a link judged malicious (${linkVerdict.source}: ${linkVerdict.threat}).`,
          rights.canDelete
            ? `Action taken: message ${deleted ? 'deleted' : 'flagged (delete failed)'} · no strike (established member).`
            : 'PB is alert-only in this group (missing delete/restrict rights), so no action was taken — admins, please review.',
          '',
          `Flagged link: ${String(linkVerdict.url ?? 'a posted link').slice(0, 500)}`,
        ].join('\n'),
      }).catch(() => {});
      return deleted;
    }
    if (log !== s.shieldLog) { patch.shieldLog = log; await setGroupSettings(chatId, patch); }
    return false;
  } catch { return false; /* shield failures never break the handler */ }
}

// ── Alert-card buttons (handlers/callback_query.js delegates here) ───────
// Every click re-verifies the clicker is a group admin (or the owner) —
// a forwarded card drives nothing for anyone else.

export async function handleShieldCallback(query) {
  try {
    const parts = String(query?.data ?? '').split(':');
    const act = parts[1];
    const chatId = parts[2];
    const userId = parts[3] ? Number(parts[3]) : null;
    const clicker = query?.from?.id;
    // Shield link wizard buttons (2026-10-31) route to their own handler
    // — same shield: prefix, same router, separate admin re-checks.
    if (act?.startsWith('wiz')) return handleShieldWizardCallback(query);
    if (!chatId || !clicker || !['ban', 'rel', 'dis', 'burst'].includes(act)) {
      return { text: 'Shield: stale button.', alert: true };
    }
    if (!(await isChatAdmin(chatId, clicker)) && !(await isOwnerId(clicker))) {
      return { text: '⛔ Group admins only.', alert: true };
    }
    const clickerName = shieldUserLabel(query.from);
    const s = await getGroupSettings(chatId);
    const msgId = query?.message?.message_id;
    const baseText = String(query?.message?.text ?? '🛡️ PB Shield');
    const editCard = async (suffix) => {
      if (!msgId) return;
      await api.editMessageText({
        chat_id: Number(chatId), message_id: msgId,
        text: `${baseText}\n\n${suffix}`.slice(0, 4000),
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    };
    const logEvent = async (entry) => {
      const cur = await getGroupSettings(chatId);
      await setGroupSettings(chatId, { shieldLog: shieldLogPush(cur.shieldLog, entry) });
    };

    if (act === 'burst') {
      const done = await shieldEndBurst(chatId, s, `ended by ${clickerName}`, false);
      if (!done) return { text: 'Burst mode is not active.', alert: true };
      await editCard(`✅ Burst mode ended by ${clickerName} — restrictions lifted.`);
      return { text: 'Burst mode ended.' };
    }
    if (!userId) return { text: 'Shield: stale button.', alert: true };

    if (act === 'ban') {
      const ok = await api.banChatMember({ chat_id: chatId, user_id: userId })
        .then(() => true).catch(() => false);
      if (!ok) return { text: 'Could not ban — PB may lack ban rights in this group.', alert: true };
      const watch = { ...(s.shieldWatch ?? {}) };
      delete watch[String(userId)];
      const imp = { ...(s.shieldImpersonated ?? {}) };
      delete imp[String(userId)];
      await setGroupSettings(chatId, { shieldWatch: watch, shieldImpersonated: imp });
      await logEvent({
        kind: 'admin_ban', uid: userId, name: null,
        detail: 'impersonation card', action: `banned by ${clickerName}`,
      });
      await editCard(`🔨 Banned by ${clickerName}.`);
      return { text: 'Banned.' };
    }
    if (act === 'rel') {
      await restoreChatAccess(chatId, userId);
      const strikes = { ...(s.shieldStrikes ?? {}) };
      delete strikes[String(userId)];
      const imp = { ...(s.shieldImpersonated ?? {}) };
      delete imp[String(userId)];
      await setGroupSettings(chatId, { shieldStrikes: strikes, shieldImpersonated: imp });
      await logEvent({
        kind: 'release', uid: userId, name: null,
        detail: 'impersonation card', action: `released by ${clickerName} — restriction lifted, strikes cleared`,
      });
      await editCard(`🔓 Released by ${clickerName} — restriction lifted, strikes cleared.`);
      return { text: 'Released — strikes cleared.' };
    }
    // dis — restriction stands, card closes.
    await logEvent({
      kind: 'dismiss', uid: userId, name: null,
      detail: 'impersonation card', action: `dismissed by ${clickerName} — restriction stands`,
    });
    await editCard(`✖ Dismissed by ${clickerName} — the restriction stands.`);
    return { text: 'Dismissed.' };
  } catch (err) {
    return { text: `❌ ${err?.message ?? 'Shield error'}`, alert: true };
  }
}

// ── /shield command family ───────────────────────────────────────────────

async function shieldSend(chatId, text, extra = {}) {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22): records only while a
  // member-command capture is armed for this chat.
  if (sent) await cleanupNoteSent(chatId, sent);
}

function shieldRightsLine(rights) {
  if (rights.canDelete && rights.canRestrict) return 'Mode: FULL — PB can delete, restrict and ban here.';
  const missing = [
    !rights.canDelete ? 'delete messages' : null,
    !rights.canRestrict ? 'restrict members' : null,
  ].filter(Boolean).join(' + ');
  return `Mode: ALERT-ONLY — PB is missing admin rights here (${missing}). Shield still detects, logs and posts alert cards, but it cannot delete, restrict or ban until PB is promoted with those rights.`;
}

async function shieldStatusText(chatId, s) {
  const rights = await shieldRights(chatId);
  const watchCount = Object.keys(s.shieldWatch ?? {}).length;
  const strikeCount = Object.keys(s.shieldStrikes ?? {}).length;
  const phraseCount = (s.shieldPhrases ?? []).length;
  const lines = [
    `🛡️ PB Shield — ${s.shieldEnabled === true ? 'ON' : 'OFF'} for this group`,
    '',
  ];
  if (s.shieldEnabled === true) {
    lines.push(
      shieldRightsLine(rights),
      '',
      `Watching: ${watchCount} new member${watchCount === 1 ? '' : 's'} (first 24h / first 5 messages)`,
      `Strikes on file: ${strikeCount} member${strikeCount === 1 ? '' : 's'}`,
      `Custom scam phrases: ${phraseCount} (/shield ban <phrase> to add)`,
      s.shieldBurst?.active
        ? `Burst mode: ACTIVE — ${(s.shieldBurst.users ?? []).length} joiner(s) restricted (/shield clear ends it)`
        : 'Burst mode: off',
      '',
      'Escalation: strike 1 delete · strike 2 restrict 24h · strike 3 ban. Impersonators are restricted on sight and an admin rules from the alert card.',
      'Link check: ON — posted links are judged via URLhaus + PB own list (malicious = delete + log, no strike for established members).',
      'Honest limit: a determined human typing by hand can still land a first message — Shield makes it expensive and short-lived, not impossible.',
    );
  } else {
    lines.push(
      'Turn it on with /shield on (group admins). While off, Shield does nothing at all.',
      '',
      shieldRightsLine(rights),
    );
  }
  lines.push('', 'More: /shield log · /shield strikes <user> · /shield clear [user]');
  return lines.join('\n');
}

async function shieldCommand(chatId, args, msg) {
  if (msg?.chat?.type === 'private') {
    await shieldSend(chatId, 'ℹ️ Use /shield in the group you want to protect.');
    return;
  }
  const fromId = msg?.from?.id;
  if (!fromId) return;
  const raw = (args ?? '').trim();
  const sub = (raw.split(/\s+/)[0] ?? '').toLowerCase();
  const rest = raw.slice(sub.length).trim();
  const isAdmin = (await isChatAdmin(chatId, fromId)) || (await isOwnerId(fromId));
  // Wizard entry (2026-10-31): bare /shield (or /shield status) from a
  // NON-admin opens the member wizard panel — Report button only, no
  // admin data, no manage view. Admin subcommands below stay admin-only
  // with the old silent refusal for non-admins.
  if (!isAdmin) {
    if (sub === '' || sub === 'status') {
      await shieldSend(chatId, shieldWizardPanelText(false), { reply_markup: shieldWizardPanelKeyboard(chatId, false) });
    }
    return;
  }
  const s = await getGroupSettings(chatId);

  if (sub === 'on') {
    await setGroupSettings(chatId, { shieldEnabled: true });
    const rights = await shieldRights(chatId);
    await shieldSend(chatId, [
      '🛡️ PB Shield is ON for this group.',
      '',
      'New joiners are watched (first 24h / first 5 messages): first links and forwards are deleted, impersonators are restricted on sight with an admin alert card, known scam phrases earn strikes — 1 delete · 2 restrict 24h · 3 ban.',
      '',
      shieldRightsLine(rights),
    ].join('\n'));
    return;
  }
  if (sub === 'off') {
    if (s.shieldBurst?.active) await shieldEndBurst(chatId, s, 'shield off');
    await setGroupSettings(chatId, { shieldEnabled: false });
    await shieldSend(chatId, '🛡️ PB Shield is OFF for this group. Watch lists and strikes are kept for when it comes back on.');
    return;
  }
  if (sub === 'log') {
    const rows = (s.shieldLog ?? []).slice(-15).reverse();
    if (!rows.length) {
      await shieldSend(chatId, '🛡️ Shield log is empty — nothing has tripped Shield here yet.');
      return;
    }
    const lines = ['🛡️ Shield log (latest first)', ''];
    for (const r of rows) {
      const when = new Date((r.ts ?? 0) * 1000).toISOString().slice(11, 16);
      lines.push(`• ${when} UTC — ${r.kind} — ${r.name ?? (r.uid ? 'ID ' + r.uid : 'group')} — ${r.action ?? ''}${r.detail ? ` (${r.detail})` : ''}`);
    }
    await shieldSend(chatId, lines.join('\n'));
    return;
  }
  if (sub === 'ban' || sub === 'unban') {
    const phrase = rest.toLowerCase().slice(0, 80);
    if (!phrase) {
      await shieldSend(chatId, `Usage: /shield ${sub} <phrase>`);
      return;
    }
    const cur = [...(s.shieldPhrases ?? [])];
    if (sub === 'ban') {
      if (!cur.includes(phrase)) cur.push(phrase);
      await setGroupSettings(chatId, { shieldPhrases: cur.slice(-50) });
      await shieldSend(chatId, `🛡️ Scam phrase added: "${phrase}" — watched members who post it earn a strike; established members just lose the message.`);
    } else {
      const next = cur.filter((p) => p !== phrase);
      await setGroupSettings(chatId, { shieldPhrases: next });
      await shieldSend(chatId, next.length === cur.length
        ? `ℹ️ "${phrase}" wasn't in the custom phrase list.`
        : `✅ Scam phrase removed: "${phrase}"`);
    }
    return;
  }
  if (sub === 'phrases') {
    const cur = s.shieldPhrases ?? [];
    await shieldSend(chatId, cur.length
      ? ['🛡️ Custom scam phrases', '', ...cur.map((p, i) => `${i + 1}. ${p}`)].join('\n')
      : 'No custom scam phrases yet. Add one with /shield ban <phrase>');
    return;
  }
  if (sub === 'strikes') {
    const target = await getTarget(msg, rest.replace(/^@/, ''));
    const idArg = /^\d+$/.test(rest) ? Number(rest) : null;
    const uid = target?.id ?? idArg;
    if (!uid) {
      await shieldSend(chatId, 'Usage: /shield strikes @user (or reply to their message, or a numeric ID)');
      return;
    }
    const st = s.shieldStrikes?.[String(uid)];
    if (!st?.count) {
      await shieldSend(chatId, `🛡️ No strikes on file for ${target?.name ?? 'ID ' + uid} in this group.`);
      return;
    }
    await shieldSend(chatId, [
      `🛡️ Strikes for ${target?.name ?? 'ID ' + uid}: ${st.count} of 3`,
      ...(st.reasons ?? []).map((r) => `• ${r}`),
      '',
      'Clear them with /shield clear @user.',
    ].join('\n'));
    return;
  }
  if (sub === 'clear') {
    const target = await getTarget(msg, rest.replace(/^@/, ''));
    const idArg = /^\d+$/.test(rest) ? Number(rest) : null;
    const uid = target?.id ?? idArg;
    if (uid) {
      await restoreChatAccess(chatId, uid);
      const strikes = { ...(s.shieldStrikes ?? {}) };
      delete strikes[String(uid)];
      const imp = { ...(s.shieldImpersonated ?? {}) };
      delete imp[String(uid)];
      await setGroupSettings(chatId, { shieldStrikes: strikes, shieldImpersonated: imp });
      await shieldSend(chatId, `🛡️ Cleared: strikes wiped and access restored for ${target?.name ?? 'ID ' + uid}.`);
      return;
    }
    if (rest) {
      await shieldSend(chatId, "⚠️ I couldn't find that user. Reply to one of their messages with /shield clear, or use a @username PB has seen or a numeric ID.");
      return;
    }
    if (s.shieldBurst?.active) {
      await shieldEndBurst(chatId, s, `ended by ${shieldUserLabel(msg.from)}`);
      await shieldSend(chatId, '🛡️ Burst mode ended — burst restrictions lifted.');
    } else {
      await shieldSend(chatId, 'ℹ️ Nothing to clear — burst mode is not active. Use /shield clear @user to wipe one member\'s strikes.');
    }
    return;
  }
  // '' / 'status' / anything else → the status card, with the wizard
  // entry button (admin panel: report + DM manage views).
  await shieldSend(chatId, await shieldStatusText(chatId, s), { reply_markup: shieldWizardPanelKeyboard(chatId, true) });
}

export const SHIELD_COMMANDS = {
  shield: shieldCommand,
};


async function restoreSend(chatId, text, extra = {}) {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22): records only while a
  // member-command capture is armed for this chat.
  if (sent) await cleanupNoteSent(chatId, sent);
}

// ── Voice language (Restore wave Batch 2, 2026-10-26) ─────────────────────
// Replit group-manager.ts: voiceLanguage setting, default 'English'.
// The 12-language picker mirrors the Replit /setvoicelang keyboard.
export const VOICE_LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Russian', 'Arabic', 'Japanese', 'Korean', 'Chinese', 'Hindi'];
const VOICE_LANG_FLAGS = { English: '🇬🇧', Spanish: '🇪🇸', French: '🇫🇷', German: '🇩🇪', Portuguese: '🇵🇹', Italian: '🇮🇹', Russian: '🇷🇺', Arabic: '🇦🇪', Japanese: '🇯🇵', Korean: '🇰🇷', Chinese: '🇨🇳', Hindi: '🇮🇳' };
function voiceLangKeyboard() {
  const rows = [];
  for (let i = 0; i < VOICE_LANGUAGES.length; i += 2) {
    rows.push(VOICE_LANGUAGES.slice(i, i + 2).map((l) => ({ text: `${VOICE_LANG_FLAGS[l]} ${l}`, callback_data: `voicelang:${l}` })));
  }
  return rows;
}

export async function getGroupVoiceLanguage(chatId) {
  const s = await getGroupSettings(chatId);
  const v = String(s?.voice_language ?? '').trim();
  return VOICE_LANGUAGES.includes(v) ? v : 'English';
}

// voicelang: callback — admin is re-verified live for the target group
// before any write (forwarded panels change nothing for lapsed admins).
export async function handleVoiceLangCallback(query) {
  const chatId = query?.message?.chat?.id;
  const userId = query?.from?.id;
  const messageId = query?.message?.message_id;
  if (!chatId || !userId) return { text: '⛔ Unknown chat.', alert: true };
  const language = String(query?.data ?? '').slice('voicelang:'.length);
  if (!VOICE_LANGUAGES.includes(language)) return { text: 'Unknown language.', alert: true };
  if (!(await isChatAdmin(chatId, userId))) return { text: '🔒 Only admins can change the voice language.', alert: true };
  await setGroupSettings(chatId, { voice_language: language });
  try { await api.editMessageText({ chat_id: chatId, message_id: messageId, text: `🎙️ PB Voice Language set to: ${language}\n\nAll voice notes in this group will now be in ${language}.` }); } catch { /* best effort */ }
  return { text: `✅ PB will now speak in ${language}` };
}

export const GROUP_RESTORE_COMMANDS = {
  // /setflood (source :22668) — gate: group admin (the source checked the
  // can_change_info permission and returned SILENTLY without it; the W4
  // refusal polish answers instead: Class A line in DM, Class C in group).
  setflood: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') {
      await restoreSend(chatId, 'ℹ️ This command works in groups only.');
      return;
    }
    if (!(await isChatAdmin(chatId, msg.from.id))) {
      await restoreSend(chatId, '⛔ Admin only.');
      return;
    }
    const parts = (args ?? '').trim().split(/\s+/).filter(Boolean);
    const limit = Number.parseInt(parts[0] ?? '', 10);
    if (!Number.isFinite(limit) || limit < 0) {
      await restoreSend(chatId, 'Usage: /setflood <limit> [seconds] — e.g. /setflood 5 10. Use /setflood 0 to disable.');
      return;
    }
    const seconds = Math.max(1, Number.parseInt(parts[1] ?? '', 10) || 10);
    if (limit === 0) {
      await setGroupSettings(chatId, { antifloodLimit: 0 });
      await restoreSend(chatId, '✅ Antiflood disabled.');
      return;
    }
    await setGroupSettings(chatId, { antifloodLimit: limit, antifloodSeconds: seconds });
    await restoreSend(chatId,
      `✅ Antiflood set: max ${limit} messages per ${seconds}s. Flooding removes the triggering message only; mutes require admin approval.`);
  },

  // /flood (source :22680) — no gate in the source.
  flood: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await restoreSend(chatId, 'ℹ️ /flood only works in groups.'); return; }
    const s = await getGroupSettings(chatId);
    const limit = Number(s.antifloodLimit ?? 0);
    if (!limit) {
      await restoreSend(chatId, '🌊 Antiflood is currently disabled. Enable with /setflood <limit> [seconds]');
      return;
    }
    const seconds = Number(s.antifloodSeconds ?? 10) || 10;
    await restoreSend(chatId,
      `🌊 Antiflood: max *${limit}* messages per *${seconds}s*. Use /setflood 0 to disable.`,
      { parse_mode: 'Markdown' });
  },

  // /settwitter (source :25073) — group admin sets the group's X handle.
  // Writes exactly the key the Twitter Followers page + /manage already
  // read (group_settings.twitter_handle); setGroupSettings merges, so no
  // other group setting is touched. Handle shape mirrors the source:
  // optional @, word characters only.
  settwitter: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await restoreSend(chatId, 'ℹ️ Use /settwitter in the group.'); return; }
    if (!(await isChatAdmin(chatId, msg.from.id))) { await restoreSend(chatId, '⛔ Only admins can set the Twitter handle.'); return; }
    const handle = String(args ?? '').trim().replace(/^@/, '');
    if (!/^\w+$/.test(handle)) { await restoreSend(chatId, 'Usage: /settwitter @handle'); return; }
    await setGroupSettings(chatId, { twitter_handle: handle });
    await restoreSend(chatId, `𝕏 Twitter handle set to @${handle}.\n\nThe group's 𝕏 Twitter Followers page will use this handle.`);
  },

  // /setvoicelang (source :15977) — group admin picks the group's
  // voice-note language. Stores group_settings.voice_language (default
  // 'English', the Replit getVoiceLanguage default). The callback
  // re-checks admin live, like the Group Manager rule: a forwarded
  // panel changes nothing for a lapsed admin. Language is allowlisted
  // — callback data is never trusted blindly.
  // Consumption note: voice notes are DM-only in this tree (the 🔊
  // button + /voice live in DMs; group taps are refused there by
  // design), so the stored language changes no send path today. It is
  // readable via getGroupVoiceLanguage and threaded into
  // synthesizeReplyVoice's language parameter for the first group voice
  // caller; tier gating (Starter+ Gemini, Builder+ xAI) lives in
  // voiceProviderFor and is untouched.
  setvoicelang: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') { await restoreSend(chatId, 'ℹ️ /setvoicelang only works in groups.'); return; }
    if (!(await isChatAdmin(chatId, msg.from.id))) { await restoreSend(chatId, '🔒 Only admins can set the voice language.'); return; }
    const current = await getGroupVoiceLanguage(chatId);
    await restoreSend(chatId, `🎙️ <b>PB Voice Language</b>\n\nCurrent: <b>${current}</b>\n\nSelect the language for voice notes:`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: voiceLangKeyboard() } });
  },

  // /setgoodbye (source :21748) — gate: group admin, with the source's
  // explicit Change-Info refusal.
  setgoodbye: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') {
      await restoreSend(chatId,
        "⚠️ /setgoodbye only works in a group chat where I'm an admin.\n\nGo to your group and run:\n/setgoodbye Your goodbye text here");
      return;
    }
    if (!(await isChatAdmin(chatId, msg.from.id))) {
      await restoreSend(chatId, '❌ You need the *Change Info* permission to use this command.',
        { parse_mode: 'Markdown', reply_to_message_id: msg.message_id });
      return;
    }
    const text = (args ?? '').trim();
    if (!text) { await restoreSend(chatId, 'Usage: /setgoodbye Your goodbye text here'); return; }
    await setGroupSettings(chatId, { goodbyeMsg: text.slice(0, 1000) });
    await restoreSend(chatId, '✅ Goodbye message set.');
  },

  // /resetgoodbye (source :21763) — gate: group admin (silent in the
  // source; the W4 refusal polish answers plain members — Class C).
  resetgoodbye: async (chatId, args, msg) => {
    if (msg.chat.type === 'private') {
      await restoreSend(chatId, '⚠️ /resetgoodbye only works in a group chat where I\'m an admin.');
      return;
    }
    if (!(await isChatAdmin(chatId, msg.from.id))) {
      await restoreSend(chatId, '⛔ Admin only.');
      return;
    }
    await setGroupSettings(chatId, { goodbyeMsg: null });
    await restoreSend(chatId, '✅ Goodbye message reset.');
  },
};

// ══ PB Cleanup — group chat auto-tidy (2026-10-22) ══════════════════════
// Rowdy's directive 2026-10-22 ~06:28 ("Let's do it" on the pitch): PB
// Shield deletes scam posts live; Cleanup extends that into general group
// tidiness for groups where PB is admin. Telegram bots CANNOT read chat
// history — PB can only act on messages it sees as they arrive or has
// recorded — so Cleanup is built strictly inside that truth:
//
//  • Command clutter (the core): in a group with cleanupEnabled, when a
//    NON-ADMIN member posts a command PB handles, the message handler
//    records the invocation (cleanupRecordCommand) and arms a capture;
//    every PB reply sent through an instrumented send seam during that
//    dispatch is recorded too (cleanupNoteSent). Both are deleted by the
//    tick's cleanup sweep once the group's TTL (cleanupTtlSec, default
//    6h, bounds 5m–48h, /cleanup ttl) passes.
//  • Service tidy (cleanupService, default OFF): join/leave service
//    posts are deleted on arrival (cleanupServiceHook).
//  • State lives in the group_settings JSON like Shield's (cleanupPending
//    ring — hard cap CLEANUP_PENDING_MAX, entries older than
//    CLEANUP_STALE_SEC pruned on every touch; cleanupPinned ring of
//    observed-pinned message ids; cleanupDeleted lifetime counter).
//    Sealed per chat ID: NOTHING crosses groups.
//
// HARD RAILS (never delete): pinned messages (the sweep consults BOTH
// the observed-pin ring AND the chat's live pinned_message via getChat);
// messages from the owner / group admins / other bots (never recorded —
// the dispatcher arms recording only for non-admin human members);
// PB's own announcement / raid / contest posts (never recorded — only
// PB's direct replies during a member's command dispatch are captured,
// and only through the conversational send seams below); DMs (groups
// only, at every layer); anything in a group where cleanup is off.
// deleteMessage failures (already gone, rights lost, too old) are
// silent and drop the entry, counting successes only; a 429 keeps the
// entry for the next cycle. Deletions are capped per tick cycle
// (CLEANUP_CYCLE_DELETE_CAP total across all groups) with the remainder
// carried. Where PB lacks the delete right, the sweep skips the group
// and /cleanup status says so plainly (Shield's rights read, shared).

const CLEANUP_TTL_DEFAULT_SEC = 6 * 3600;
const CLEANUP_TTL_MIN_SEC = 5 * 60;
const CLEANUP_TTL_MAX_SEC = 48 * 3600;
const CLEANUP_PENDING_MAX = 200;
const CLEANUP_PINNED_MAX = 50;
const CLEANUP_STALE_SEC = CLEANUP_TTL_MAX_SEC + 24 * 3600;
const CLEANUP_CYCLE_DELETE_CAP = 30;
const CLEANUP_NOW_CAP = 30;

const cleanupNowSec = () => Math.floor(Date.now() / 1000);

export function cleanupTtlOf(s) {
  const n = Number(s?.cleanupTtlSec);
  return Number.isFinite(n) && n >= CLEANUP_TTL_MIN_SEC && n <= CLEANUP_TTL_MAX_SEC
    ? Math.floor(n) : CLEANUP_TTL_DEFAULT_SEC;
}

// Prune + ring-cap a pending list. Pure — unit-provable from the harness.
export function cleanupPrunePending(list, nowSec) {
  const arr = (Array.isArray(list) ? list : [])
    .filter((e) => e && Number.isFinite(Number(e.m)) && Number.isFinite(Number(e.t))
      && (nowSec - Number(e.t)) <= CLEANUP_STALE_SEC)
    .map((e) => ({ m: Number(e.m), t: Number(e.t), k: e.k === 'r' ? 'r' : 'c' }));
  return arr.slice(-CLEANUP_PENDING_MAX);
}

// ── Recording seams ────────────────────────────────────────────────────────

/** Record a member's command invocation for the tidy sweep. Self-gating
 *  (cleanup off → no write at all); never throws. */
export async function cleanupRecordCommand(chatId, messageId) {
  try {
    const s = await getGroupSettings(chatId);
    if (s.cleanupEnabled !== true) return false;
    const mid = Number(messageId);
    if (!Number.isFinite(mid)) return false;
    const now = cleanupNowSec();
    const pending = cleanupPrunePending(s.cleanupPending, now);
    if (pending.some((e) => e.m === mid)) return true;
    pending.push({ m: mid, t: now, k: 'c' });
    await setGroupSettings(chatId, { cleanupPending: pending.slice(-CLEANUP_PENDING_MAX) });
    return true;
  } catch { return false; }
}

// In-flight reply capture: armed by the message dispatcher for ONE
// member-command dispatch, drained by cleanupNoteSent as PB's replies go
// out through the instrumented send seams. Module state is safe here
// because the dispatcher clears it at the top of every message
// invocation (cleanupEndCapture), so it can never leak into a later,
// unrelated invocation in a warm isolate.
let cleanupCapture = null; // { chatId: string, cmdMsgId: number }

export function cleanupBeginCapture(chatId, cmdMsgId) {
  cleanupCapture = { chatId: String(chatId), cmdMsgId: Number(cmdMsgId) };
}

export function cleanupEndCapture() { cleanupCapture = null; }

/** Note a message PB just sent. Records it (kind 'r') ONLY when a
 *  capture is armed for this exact chat. Never throws — a tidy failure
 *  must never break a send. */
export async function cleanupNoteSent(chatId, sent) {
  try {
    if (!cleanupCapture || cleanupCapture.chatId !== String(chatId)) return;
    const mid = Number(sent?.message_id);
    if (!Number.isFinite(mid) || mid === cleanupCapture.cmdMsgId) return;
    const s = await getGroupSettings(chatId);
    if (s.cleanupEnabled !== true) return;
    const now = cleanupNowSec();
    const pending = cleanupPrunePending(s.cleanupPending, now);
    if (pending.some((e) => e.m === mid)) return;
    pending.push({ m: mid, t: now, k: 'r' });
    await setGroupSettings(chatId, { cleanupPending: pending.slice(-CLEANUP_PENDING_MAX) });
  } catch { /* never break a send */ }
}

/** Remember a pin event in this group (fed from the pinned_message
 *  service post): the sweep will never delete a message it has seen
 *  pinned. Conservative on purpose — an unpin later does not un-protect;
 *  a kept message is the safe failure mode. */
export async function cleanupNotePinned(chatId, messageId) {
  try {
    const s = await getGroupSettings(chatId);
    if (s.cleanupEnabled !== true) return;
    const mid = Number(messageId);
    if (!Number.isFinite(mid)) return;
    const pins = (Array.isArray(s.cleanupPinned) ? s.cleanupPinned : []).map(Number).filter(Number.isFinite);
    if (pins.includes(mid)) return;
    pins.push(mid);
    await setGroupSettings(chatId, { cleanupPinned: pins.slice(-CLEANUP_PINNED_MAX) });
  } catch { /* never break the handler */ }
}

/** Join/leave service tidy: delete the service post on arrival when the
 *  group has cleanup + the service toggle on. Silent on failure. */
export async function cleanupServiceHook(chatId, message) {
  try {
    const s = await getGroupSettings(chatId);
    if (s.cleanupEnabled !== true || s.cleanupService !== true) return false;
    await api.deleteMessage({ chat_id: chatId, message_id: message.message_id }).catch(() => {});
    return true;
  } catch { return false; }
}

// ── The sweep (tick cycle + /cleanup now share this core) ─────────────────

export async function cleanupSweepGroup(chatId, { all = false, cap = CLEANUP_CYCLE_DELETE_CAP } = {}) {
  const s = await getGroupSettings(chatId);
  if (s.cleanupEnabled !== true) return { skipped: 'off', deleted: 0, attempts: 0, pending: 0 };
  const now = cleanupNowSec();
  const ttl = cleanupTtlOf(s);
  const pending = cleanupPrunePending(s.cleanupPending, now);
  // Pinned protection layer 1: ids PB has watched being pinned here.
  const pinned = new Set((Array.isArray(s.cleanupPinned) ? s.cleanupPinned : []).map(Number).filter(Number.isFinite));
  // Pinned protection layer 2: the chat's currently pinned message, live.
  try {
    const chat = await api.getChat({ chat_id: chatId });
    const latestPin = Number(chat?.pinned_message?.message_id);
    if (Number.isFinite(latestPin)) pinned.add(latestPin);
  } catch { /* best effort — layer 1 still applies */ }
  const due = [];
  const future = [];
  for (const e of pending) {
    if (pinned.has(e.m)) continue; // protected — drop from tracking, NEVER delete
    if (all || now - e.t >= ttl) due.push(e); else future.push(e);
  }
  const rights = await shieldRights(chatId);
  if (!rights.canDelete) {
    // No delete right: keep the records (pruned/pin-filtered only) — the
    // status surface says plainly why nothing is being tidied.
    const kept = [...future, ...due];
    if (kept.length !== (Array.isArray(s.cleanupPending) ? s.cleanupPending.length : 0)) {
      await setGroupSettings(chatId, { cleanupPending: kept });
    }
    return { skipped: 'no-rights', deleted: 0, attempts: 0, pending: kept.length };
  }
  let deleted = 0;
  let attempts = 0;
  const remainder = [];
  for (const e of due) {
    if (attempts >= cap) { remainder.push(e); continue; }
    attempts++;
    try {
      await api.deleteMessage({ chat_id: chatId, message_id: e.m });
      deleted++;
    } catch (err) {
      const desc = String(err?.description ?? err?.message ?? '');
      if (err?.code === 429 || /too many requests|retry after/i.test(desc)) {
        remainder.push(e); // rate-limited: carry this one (and the rest) forward
        for (const rest of due.slice(due.indexOf(e) + 1)) remainder.push(rest);
        break;
      }
      // Already deleted / can't be deleted / too old: drop silently,
      // count nothing (successes only).
    }
  }
  const kept = [...future, ...remainder];
  await setGroupSettings(chatId, {
    cleanupPending: kept,
    cleanupDeleted: Number(s.cleanupDeleted ?? 0) + deleted,
  });
  return { deleted, attempts, pending: kept.length };
}

/** Tick cycle: sweep every cleanup-on group with due entries, under one
 *  global per-cycle delete cap; the remainder carries to the next tick. */
export async function cycleCleanupSweep() {
  let budget = CLEANUP_CYCLE_DELETE_CAP;
  let deleted = 0;
  let groups = 0;
  try {
    const rows = await db.select().from(known_groups).all();
    for (const row of rows ?? []) {
      if (budget <= 0) break;
      const chatId = row.chatId;
      const s = await getGroupSettings(chatId);
      if (s.cleanupEnabled !== true) continue;
      const now = cleanupNowSec();
      const ttl = cleanupTtlOf(s);
      const pend = Array.isArray(s.cleanupPending) ? s.cleanupPending : [];
      if (!pend.some((e) => now - Number(e?.t ?? 0) >= ttl)) continue;
      groups++;
      const r = await cleanupSweepGroup(chatId, { cap: budget });
      deleted += r.deleted ?? 0;
      budget -= r.attempts ?? 0;
    }
  } catch { /* a sweep failure never breaks the tick */ }
  return { deleted, groups };
}

// ── /cleanup command ───────────────────────────────────────────────────────

function cleanupFmtTtl(sec) {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export function cleanupParseDuration(raw) {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(raw ?? '').trim());
  if (!m) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? 'm').toLowerCase()];
  return Number(m[1]) * mult;
}

const CLEANUP_HONESTY_LINE = 'PB tidies what it sees and its own replies — it can\'t rewind or scan old chat history.';

async function cleanupStatusText(chatId, s) {
  const on = s.cleanupEnabled === true;
  const lines = [
    `🧹 PB Cleanup — ${on ? 'ON' : 'OFF'}`,
    `Command clutter expires after: ${cleanupFmtTtl(cleanupTtlOf(s))}`,
    `Join/leave tidy: ${s.cleanupService === true ? 'ON' : 'OFF'}`,
    `Recorded & waiting: ${Array.isArray(s.cleanupPending) ? s.cleanupPending.length : 0} message(s)`,
    `Deleted so far: ${Number(s.cleanupDeleted ?? 0)}`,
  ];
  if (on) {
    const rights = await shieldRights(chatId);
    if (!rights.canDelete) {
      lines.push('⚠️ PB can\'t delete messages in this group (missing the delete-messages admin right) — cleanup is recording but cannot tidy until PB is promoted with that right.');
    }
  }
  lines.push(CLEANUP_HONESTY_LINE);
  return lines.join('\n');
}

async function cleanupCommand(chatId, args, msg) {
  if (msg.chat.type === 'private') {
    await restoreSend(chatId, 'ℹ️ Use /cleanup in the group you want kept tidy.');
    return;
  }
  // Group admins + owner only; plain members get the uniform Class C
  // refusal (W4 refusal polish — was a silent return).
  if (!((await isOwnerId(msg.from?.id)) || (await isChatAdmin(chatId, msg.from.id)))) {
    await restoreSend(chatId, '⛔ Admin only.');
    return;
  }
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'status').toLowerCase();
  const s = await getGroupSettings(chatId);
  if (sub === 'on') {
    await setGroupSettings(chatId, { cleanupEnabled: true });
    const ttl = cleanupTtlOf(s);
    const lines = [
      '🧹 PB Cleanup is ON for this group.',
      `• A member's /command and PB's reply to it are deleted after ${cleanupFmtTtl(ttl)} — the chat keeps the conversation, not the clutter.`,
      '• Pinned posts, admins\' and the owner\'s messages, other bots, and PB\'s own announcement/raid/contest posts are never touched.',
      CLEANUP_HONESTY_LINE,
    ];
    const rights = await shieldRights(chatId);
    if (!rights.canDelete) {
      lines.push('⚠️ Heads up: PB can\'t delete messages in this group yet (missing the delete-messages admin right) — cleanup will record but cannot tidy until PB is promoted with that right.');
    }
    await restoreSend(chatId, lines.join('\n'));
    return;
  }
  if (sub === 'off') {
    const pendN = Array.isArray(s.cleanupPending) ? s.cleanupPending.length : 0;
    await setGroupSettings(chatId, { cleanupEnabled: false, cleanupPending: [] });
    await restoreSend(chatId, `🧹 PB Cleanup is OFF. ${pendN} recorded message(s) dropped from the tidy list — nothing further will be deleted.`);
    return;
  }
  if (sub === 'ttl') {
    const sec = cleanupParseDuration(parts[1]);
    if (sec === null || sec < CLEANUP_TTL_MIN_SEC || sec > CLEANUP_TTL_MAX_SEC) {
      await restoreSend(chatId, 'Usage: /cleanup ttl <duration> — between 5m and 48h (e.g. /cleanup ttl 30m, /cleanup ttl 6h, /cleanup ttl 1d). A bare number means minutes.');
      return;
    }
    await setGroupSettings(chatId, { cleanupTtlSec: sec });
    await restoreSend(chatId, `🧹 Cleanup TTL set: command clutter now expires after ${cleanupFmtTtl(sec)}.`);
    return;
  }
  if (sub === 'service') {
    const v = (parts[1] ?? '').toLowerCase();
    if (v !== 'on' && v !== 'off') {
      await restoreSend(chatId, 'Usage: /cleanup service on|off — on deletes join/leave service posts as they arrive.');
      return;
    }
    await setGroupSettings(chatId, { cleanupService: v === 'on' });
    await restoreSend(chatId, `🧹 Join/leave tidy ${v === 'on' ? 'ON — join/leave service posts will be removed as they arrive' : 'OFF'}.`);
    return;
  }
  if (sub === 'now') {
    if (s.cleanupEnabled !== true) {
      await restoreSend(chatId, '🧹 Cleanup is OFF here — /cleanup on first.');
      return;
    }
    const r = await cleanupSweepGroup(chatId, { all: true, cap: CLEANUP_NOW_CAP });
    if (r?.skipped === 'no-rights') {
      await restoreSend(chatId, '⚠️ PB can\'t delete messages in this group (missing the delete-messages admin right) — nothing was swept.');
      return;
    }
    await restoreSend(chatId, `🧹 Sweep done: deleted ${r?.deleted ?? 0} recorded message(s)${(r?.pending ?? 0) > 0 ? ` — ${r.pending} still recorded (batch cap reached; run /cleanup now again or let the clock carry it)` : ''}.`);
    return;
  }
  if (sub === 'status') {
    await restoreSend(chatId, await cleanupStatusText(chatId, s));
    return;
  }
  await restoreSend(chatId, 'Usage: /cleanup on|off|status|now · /cleanup ttl <5m–48h> · /cleanup service on|off');
}

export const CLEANUP_COMMANDS = {
  cleanup: cleanupCommand,
};

// ── Watchdog: command-error capture + owner health snapshot (2026-10-22) ──
// The handlers' top level used to lose escaping errors to the isolate's
// console.error only — invisible after the fact. captureCommandError is
// called from the handlers' top-level catch wrappers and writes ONE
// content-free row to command_errors: command name / callback prefix,
// chat id, error class. NEVER message text or args. FAIL-OPEN by design:
// it swallows its own failures so capture can never break a handler.

// Error class only: err.name, with the Bot API code appended when the
// error carries one ('BotApiError:403'). No message text, ever.
export function errorClassOf(err) {
  const name = String(err?.name ?? 'Error').slice(0, 40);
  const code = err?.code;
  return (code === undefined || code === null || code === '') ? name : `${name}:${String(code).slice(0, 12)}`;
}

// Label for a message-surface failure: the command name when the text is
// a command (first token only — args are user content and never stored),
// else the generic 'message'.
export function errorLabelForMessage(message) {
  const text = message?.text ?? message?.caption ?? '';
  if (typeof text === 'string' && text.startsWith('/')) {
    const name = text.slice(1).split(/[\s@]/)[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
    if (name) return name;
  }
  return 'message';
}

// Label for a callback-surface failure: the data prefix before the first
// ':' (structural — e.g. 'raid_done'), never the payload after it.
export function errorLabelForCallback(query) {
  const data = String(query?.data ?? '');
  const prefix = data.split(':')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
  return prefix || 'callback';
}

export async function captureCommandError({ surface, chatId, label, err }) {
  try {
    await db.insert(command_errors).values({
      ts: Math.floor(Date.now() / 1000),
      chatId: (chatId === undefined || chatId === null || chatId === '') ? null : String(chatId),
      surface: surface === 'callback' ? 'callback' : 'message',
      label: String(label || 'message').slice(0, 64),
      errorClass: errorClassOf(err),
    });
  } catch { /* fail-open: capture must never break the handler */ }
}

// ── Watchdog: message-path invocation stamps (2026-10-23) ─────────────
// The cycle watchdog only sees failures in code that RUNS. A frozen
// message path (updates never dispatched to the handler) leaves every
// tick cycle green and command_errors empty — silence looks exactly
// like health, which is how the 2026-10-22 group freeze hid for hours.
// So the message handler stamps its own invocations into config:
// `last_message_at` (any chat) and `last_group_message_at` (group /
// supergroup chats), read back by the tick's msgpath section and paged
// on by the host cron. Values are epoch ms (the `last_tick` convention).
// THROTTLED: an in-isolate memo plus a stored-value check keep the
// common case at zero DB writes — at most one write per key per >60s.
// FAIL-OPEN like captureCommandError: a stamp failure must never
// affect message handling.
let msgStampMemo = { any: 0, group: 0 };
export async function stampMessagePath(message) {
  try {
    const now = Date.now();
    if (now - msgStampMemo.any > 60_000) {
      const stored = Number(await getConfig('last_message_at', '0')) || 0;
      if (now - stored > 60_000) await setConfig('last_message_at', String(now));
      msgStampMemo.any = now;
    }
    const chatType = message?.chat?.type;
    if ((chatType === 'group' || chatType === 'supergroup') && now - msgStampMemo.group > 60_000) {
      const stored = Number(await getConfig('last_group_message_at', '0')) || 0;
      if (now - stored > 60_000) await setConfig('last_group_message_at', String(now));
      msgStampMemo.group = now;
    }
  } catch { /* fail-open: stamps must never break the handler */ }
}

// ── Watchdog: answer-path stamps + routing-exit tallies (2026-10-23) ──
// The message-path stamps above prove the handler RAN; these prove it
// ANSWERED. Diagnostic #2 (2026-10-23) found PB receiving home-group
// questions fine while answers died silently in the brain / routing
// span — receipt is not health. `last_answer_at` is stamped by
// handleBrainReply ONLY when Telegram confirms a reply send (sendSafe
// returned the sent message); `last_brain_error_at` plus the
// `brain_error_stamps` ring (epoch ms, trailing hour) are stamped on
// every brain failure so the tick can count errors per hour. The
// tick's msgpath section reads all three back via answerPathState()
// and the host cron pages on their conditions. Same discipline as
// stampMessagePath: config-backed, epoch ms, FAIL-OPEN everywhere —
// a stamp failure must never affect message handling.
let answerStampMemo = 0;
export async function stampAnswerSent() {
  try {
    const now = Date.now();
    const stored = Number(await getConfig('last_answer_at', '0')) || 0;
    // Trigger-resolution bypass (2026-10-26, answer-path wave): the
    // 60s throttle below would otherwise leave last_answer_at BEHIND
    // a newer trigger stamp when an answer lands within 60s of the
    // previous answer — exactly the shape that false-latches a healthy
    // fast reply. When a trigger is still owed (triggered after the
    // last recorded answer), the answer write is never throttled.
    if (triggeredAtAfter(stored)) {
      await setConfig('last_answer_at', String(now));
      answerStampMemo = now;
      return;
    }
    if (now - answerStampMemo <= 60_000) return;
    if (now - stored > 60_000) await setConfig('last_answer_at', String(now));
    answerStampMemo = now;
  } catch { /* fail-open: stamps must never break the handler */ }
}

// Helper for the bypass above: reads the trigger stamp without ever
// throwing into the answer path. Kept tiny so stampAnswerSent stays
// readable; the full trigger state lives in answerTriggerState().
async function triggeredAtAfter(stored) {
  try {
    const t = Number(await getConfig('last_triggered_at', '0')) || 0;
    return t > stored;
  } catch { return false; }
}

// ── Watchdog: brain-reply SEND failures (2026-10-25, overnight-2) ──
// A brain reply whose Telegram send fails used to vanish with zero
// durable trace: sendSafe swallows the failure (403 fully silent, other
// errors console-only), no answer stamp, no brain-error stamp, no
// command_errors row — the exact signature of the 2026-10-24 evening
// Carrie-DM failure (6 handled tallies, 0 answers, 0 errors). This
// stamp closes that seam: sendBrainReply calls it when the send (after
// one retry) still has no confirmed delivery, so the next failure is
// visible to the tick/health snapshot instead of silent. Fail-open,
// content-free (a timestamp + a count + a class label, never text).
export async function stampBrainSendFailed(chatId) {
  try {
    const now = Date.now();
    await setConfig('last_brain_send_failed_at', String(now));
    const prev = Number(await getConfig('brain_send_failed_count', '0')) || 0;
    await setConfig('brain_send_failed_count', String(prev + 1));
    await captureCommandError({
      surface: 'message',
      chatId: chatId ?? null,
      label: 'brain-reply',
      err: { name: 'SendFailed' },
    });
  } catch { /* fail-open: stamps must never break the handler */ }
}

// ── Brain-reply attempt stamp (Fix PB, 2026-10-25) ─────────────────────────
// handleBrainReply stamps on ENTRY, so a future silent DM shows
// attempt-without-answer instead of zero trace: the 2026-10-25 06:59 DM
// left no brain error, no command error, and no send-failure stamp, which
// eliminated every in-code death span and left only "never reached the
// handler" unprovable. Attempts vs confirmed answers now separate cleanly.
export async function stampBrainReplyAttempt() {
  try {
    await setConfig('last_brain_reply_attempt_at', String(Date.now()));
    const prev = Number(await getConfig('brain_reply_attempt_count', '0')) || 0;
    await setConfig('brain_reply_attempt_count', String(prev + 1));
  } catch { /* fail-open: stamps must never break the handler */ }
}

const BRAIN_ERROR_RING_KEY = 'brain_error_stamps';
const BRAIN_ERROR_WINDOW_MS = 3_600_000;
async function readBrainErrorRing() {
  try {
    const raw = await getConfig(BRAIN_ERROR_RING_KEY, '');
    const arr = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - BRAIN_ERROR_WINDOW_MS;
    return (Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isFinite(n) && n > cutoff);
  } catch { return []; }
}
export async function stampBrainError() {
  try {
    const now = Date.now();
    const ring = await readBrainErrorRing();
    ring.push(now);
    await setConfig(BRAIN_ERROR_RING_KEY, JSON.stringify(ring.slice(-50)));
    await setConfig('last_brain_error_at', String(now));
  } catch { /* fail-open */ }
}

/** Answer-path state for the tick's msgpath section. Fail-soft: nulls. */
export async function answerPathState() {
  const out = { lastAnswerAt: null, lastBrainErrorAt: null, brainErrorsLastHour: 0, lastBrainReplyAttemptAt: null, lastBrainSendFailedAt: null, brainSendFailedCount: 0 };
  try {
    const a = Number(await getConfig('last_answer_at', '0')) || 0;
    if (a > 0) out.lastAnswerAt = a;
    const b = Number(await getConfig('last_brain_error_at', '0')) || 0;
    if (b > 0) out.lastBrainErrorAt = b;
    out.brainErrorsLastHour = (await readBrainErrorRing()).length;
    const t = Number(await getConfig('last_brain_reply_attempt_at', '0')) || 0;
    if (t > 0) out.lastBrainReplyAttemptAt = t;
    const f = Number(await getConfig('last_brain_send_failed_at', '0')) || 0;
    if (f > 0) out.lastBrainSendFailedAt = f;
    out.brainSendFailedCount = Number(await getConfig('brain_send_failed_count', '0')) || 0;
  } catch { /* state unknown this read */ }
  return out;
}

// ── Answer-path trigger stamps (2026-10-26, answer-path wave) ──────
// The 2026-10-25 22:14 episode: the handler STAMPED a group message
// (stampMessagePath fires on EVERY handled message) but no brain reply
// was ever attempted — and the old tick latch keyed on
// lastGroupMessageAt vs lastAnswerAt, so ordinary chatter pages as
// "receiving but not answering". The latch must key ONLY on messages
// PB actually owed an answer to. The handler therefore stamps a
// TRIGGER exactly where it decides a group message IS PB-triggered:
// route.shouldHandleConversation true in a group (PB-name rule, @mention,
// reply-to-PB, or freechat-on) — plus group /ask, which is an explicit
// brain request. Everything else — chatter, wizard/command-consumed
// messages (they got a response, so they never stamp), support-group
// consumption (its own handler answers or deliberately steps aside),
// banned / other-bot / unknown-command exits — never stamps, so it
// can never latch and never pages. Stored values are timestamp + chat
// id + trigger kind ONLY — never message text, never a sender name.
// Resolution is derived, not cleared by hand: lastAnswerAt AFTER the
// trigger means the episode is resolved, whatever chat answered (the
// pre-existing smoke-alarm semantics, kept deliberately). A trigger is
// the LATEST owed answer, not a per-message queue: a newer trigger
// supersedes an older one, which keeps the state to three config rows
// instead of a queue that could itself wedge.
export const ANSWER_RECOVERY_DELAY_MS = 180_000;
export const ANSWER_RECOVERY_TEXT = '🧠 I missed that one — say it again and I got you.';
const TRIGGER_VIAS = new Set(['direct', 'freechat', 'command-ask']);
export async function stampTriggered(chatId, via) {
  try {
    const v = TRIGGER_VIAS.has(String(via)) ? String(via) : 'direct';
    await setConfig('last_triggered_at', String(Date.now()));
    await setConfig('triggered_chat_id', String(chatId));
    await setConfig('triggered_via', v);
  } catch { /* fail-open: stamps must never break the handler */ }
}

// Pure episode classifier — the tick page text names exactly one of
// these, never a generic "stuck" message. Priority order matters:
// a failed send after the trigger outranks a brain error after it,
// which outranks a bare attempt, because each names the next repair.
export function classifyAnswerEpisode(s = {}) {
  const t = Number(s.triggeredAt) || 0;
  if (!t) return 'none';
  if ((Number(s.lastAnswerAt) || 0) > t) return 'resolved';
  if ((Number(s.lastBrainSendFailedAt) || 0) > t) return 'send-failed';
  if ((Number(s.lastBrainErrorAt) || 0) > t) return 'brain-error-without-answer';
  if ((Number(s.lastBrainReplyAttemptAt) || 0) >= t) return 'attempt-without-answer';
  return 'triggered-without-attempt';
}

// Pure latch evaluation — the tick cycle maintains this state and the
// host cron pages from it, so the rule lives in exactly one place and
// the harness proves it. Semantics (mirroring the old group latch,
// re-keyed): a confirmed answer after the trigger clears; a NEW trigger
// starts an episode at stuckTicks 1; an already-open episode increments
// each tick it stays unresolved; pageDue first becomes true at 2, so a
// lone triggered message pages on the second consecutive tick, once per
// episode (the host cron dedupes the page itself by triggeredAt).
export function evaluateTriggerLatch(prev = {}, curr = {}) {
  const triggeredAt = Number(curr.triggeredAt) || 0;
  const lastAnswerAt = Number(curr.lastAnswerAt) || 0;
  if (!triggeredAt) return { triggeredAt: 0, lastAnswerAt, stuckTicks: 0, unansweredSince: null, pageDue: false };
  if (lastAnswerAt > triggeredAt) return { triggeredAt, lastAnswerAt, stuckTicks: 0, unansweredSince: null, pageDue: false };
  const prevTriggeredAt = Number(prev.triggeredAt) || 0;
  const prevUnanswered = (prev.unansweredSince !== null && prev.unansweredSince !== undefined) ? prev.unansweredSince : null;
  const prevStuck = Number(prev.stuckTicks) || 0;
  let stuckTicks;
  if (triggeredAt > prevTriggeredAt) stuckTicks = 1;
  else if (prevUnanswered !== null) stuckTicks = prevStuck + 1;
  else stuckTicks = 1;
  return { triggeredAt, lastAnswerAt, stuckTicks, unansweredSince: prevUnanswered ?? triggeredAt, pageDue: stuckTicks >= 2 };
}

// Pure recovery gate: a triggered episode unresolved for at least the
// delay, with no recovery yet recorded for THIS trigger value. The
// recoveryFor === triggeredAt check is what makes it once-per-episode:
// a newer trigger re-arms it (new value), an old one never refires.
export function shouldRecoverAnswer({ triggeredAt, lastAnswerAt, recoveryFor, now } = {}) {
  const t = Number(triggeredAt) || 0;
  if (!t) return false;
  if ((Number(lastAnswerAt) || 0) > t) return false;
  if (recoveryFor !== null && recoveryFor !== undefined && Number(recoveryFor) === t) return false;
  return (Number(now) || Date.now()) - t >= ANSWER_RECOVERY_DELAY_MS;
}

/** Full trigger state for the tick's msgpath section. Fail-soft. */
export async function answerTriggerState() {
  const out = {
    triggeredAt: null, triggeredChatId: null, triggeredVia: null,
    lastAnswerAt: null, lastBrainReplyAttemptAt: null, lastBrainErrorAt: null,
    lastBrainSendFailedAt: null, recoveryFor: null, recoveryAt: null,
    recoveryState: null, state: 'none',
  };
  try {
    const t = Number(await getConfig('last_triggered_at', '0')) || 0;
    if (t > 0) out.triggeredAt = t;
    const cid = await getConfig('triggered_chat_id', '');
    if (cid) out.triggeredChatId = cid;
    const via = await getConfig('triggered_via', '');
    if (via) out.triggeredVia = via;
    const ap = await answerPathState();
    out.lastAnswerAt = ap.lastAnswerAt;
    out.lastBrainReplyAttemptAt = ap.lastBrainReplyAttemptAt;
    out.lastBrainErrorAt = ap.lastBrainErrorAt;
    out.lastBrainSendFailedAt = ap.lastBrainSendFailedAt;
    const rf = Number(await getConfig('answer_recovery_for', '0')) || 0;
    if (rf > 0) out.recoveryFor = rf;
    const ra = Number(await getConfig('answer_recovery_at', '0')) || 0;
    if (ra > 0) out.recoveryAt = ra;
    const rs = await getConfig('answer_recovery_state', '');
    if (rs) out.recoveryState = rs;
    out.state = classifyAnswerEpisode({
      triggeredAt: out.triggeredAt, lastAnswerAt: out.lastAnswerAt,
      lastBrainReplyAttemptAt: out.lastBrainReplyAttemptAt,
      lastBrainErrorAt: out.lastBrainErrorAt,
      lastBrainSendFailedAt: out.lastBrainSendFailedAt,
    });
  } catch { /* state unknown this read; state stays 'none' */ }
  return out;
}

// One recovery attempt per episode, success or failure — stamped even
// when the send throws, so a kicked/broken chat cannot retry every
// minute forever. Fail-open: a stamp failure never breaks the tick.
export async function stampAnswerRecovery(state, triggeredAt) {
  try {
    await setConfig('answer_recovery_for', String(triggeredAt));
    await setConfig('answer_recovery_at', String(Date.now()));
    await setConfig('answer_recovery_state', String(state ?? '').slice(0, 48));
  } catch { /* fail-open */ }
}

// ── Brain-reply replay jobs (2026-10-27, 20:54 fix) ─────────────────
// A hung brain call dies with the invocation (~33s platform kill) and
// writes nothing — so the handler persists a replay job BEFORE the
// brain call, and the tick replays the turn from conversation history.
// The job row holds IDS + TIMESTAMPS ONLY — never message text, never
// a sender name. The text lives only in pb_conversations (history),
// the store that already legitimately holds it. Fail-open everywhere:
// a job-store failure never blocks a brain call.
export const BRAIN_REPLAY_JOB_KEY = 'brain_replay_jobs';
export const BRAIN_REPLAY_MIN_AGE_MS = 90_000;
export const BRAIN_REPLAY_MAX_ATTEMPTS = 8;
const BRAIN_REPLAY_MAX_JOBS = 50;
// Fail-proof chat (2026-11-03): holding reply while a turn pends —
// threshold, not a delivery promise: the isolate has no timers, so the
// holding lands on the next tick after the job passes this age
// (typically 60-120s after trigger at ~1-min tick cadence).
export const BRAIN_REPLAY_HOLDING_MIN_AGE_MS = 20_000;
export const BRAIN_REPLAY_HOLDING_TEXT = '🧠 Got it — working on your answer now.';

async function readBrainReplayJobs() {
  try {
    const raw = await getConfig(BRAIN_REPLAY_JOB_KEY, '');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((j) => j && typeof j === 'object') : [];
  } catch { return []; }
}
/** Fail-proof chat (2026-11-03): store order for replay jobs — pending
 *  jobs FIRST and NEVER trimmed, then resolved history up to the cap.
 *  Pure: the temp-endpoint proof calls this directly. The old
 *  slice(0, MAX) could drop the just-pushed job when over cap. */
export function partitionReplayJobsForStore(jobs = [], max = BRAIN_REPLAY_MAX_JOBS) {
  const pending = jobs.filter((j) => j && j.state === 'pending');
  const rest = jobs.filter((j) => j && j.state !== 'pending');
  return pending.concat(rest).slice(0, Math.max(max, pending.length));
}
async function writeBrainReplayJobs(jobs) {
  try { await setConfig(BRAIN_REPLAY_JOB_KEY, JSON.stringify(partitionReplayJobsForStore(jobs))); } catch { /* fail-open */ }
}
/** Fail-proof chat (2026-11-03): replay-store health check for the
 *  daily self-test — read + write-back UNCHANGED (no rows added),
 *  proving the store path the tick replays from. Counts only. */
export async function verifyBrainReplayStore() {
  try {
    const jobs = await readBrainReplayJobs();
    await writeBrainReplayJobs(jobs);
    return { ok: true, total: jobs.length, pending: jobs.filter((j) => j && j.state === 'pending').length };
  } catch { return { ok: false, total: 0, pending: 0 }; }
}
export async function createBrainReplayJob({ chatId, chatType, userKey, convoId }) {
  try {
    const jobs = await readBrainReplayJobs();
    const now = Date.now();
    const triggeredAt = Number(await getConfig('last_triggered_at', '0')) || 0;
    for (const j of jobs) {
      if (j.state === 'pending' && String(j.chatId) === String(chatId) && j.userKey === userKey) j.state = 'superseded';
    }
    const job = {
      id: `${now}-${Math.floor(Math.random() * 1e9)}`,
      chatId: String(chatId), chatType: String(chatType ?? ''),
      userKey, convoId: Number(convoId) || 0,
      createdAt: now, triggeredAt, attempts: 0, lastAttemptAt: 0, state: 'pending',
      holdingSent: '',
    };
    jobs.push(job);
    // Fail-proof chat (2026-11-03): eviction NEVER drops a pending job.
    // Old code fell back to splice(0,1) when all jobs were pending —
    // a queued turn silently vanished at the cap. Now: evict resolved
    // history only; if all are pending the list grows past the cap and
    // the store writer keeps every pending job (see
    // partitionReplayJobsForStore).
    while (jobs.length > BRAIN_REPLAY_MAX_JOBS) {
      const idx = jobs.findIndex((j) => j.state !== 'pending');
      if (idx < 0) break;
      jobs.splice(idx, 1);
    }
    await writeBrainReplayJobs(jobs);
    return job;
  } catch { return null; }
}
// Hang-protection R2 (2026-10-29): fill in a job field created early
// with a placeholder — today only convoId (the question row id, known
// only after the history save). Fail-open: a store failure returns
// null and the caller keeps its local copy; the job still replays
// (with convoId 0 it resolves question-gone, per the spec's accepted
// residual hole).
export async function updateBrainReplayJob(jobId, { convoId, holdingSent } = {}) {
  try {
    const jobs = await readBrainReplayJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return null;
    if (convoId !== undefined && convoId !== null && Number.isFinite(Number(convoId))) job.convoId = Number(convoId);
    // Fail-proof chat (2026-11-03): holding mark — 'sent' (user told
    // once) or 'failed' (chat cannot receive; never retried each tick).
    if (holdingSent !== undefined && holdingSent !== null) job.holdingSent = String(holdingSent);
    await writeBrainReplayJobs(jobs);
    return job;
  } catch { return null; }
}
// Hang-protection R3/R4 (2026-10-29): replay state + rung trail in
// per-chat diag, where the next post-mortem looks. Groups only (diag
// writers are group-only by design); counts/labels only, never text.
// Fail-open twice over: this never throws, and call sites guard the
// call separately so a diag failure can never break a claim/resolve.
export async function noteDiagReplay(chatId, chatType, { state, attempts, rung } = {}) {
  try {
    const isGroup = chatType === 'group' || chatType === 'supergroup' || Number(chatId) < 0;
    if (!isGroup) return;
    if (state !== undefined) await diagWrite(chatId, 'replay_state', String(state).slice(0, 48));
    if (attempts !== undefined) await diagWrite(chatId, 'replay_attempts', Number(attempts) || 0);
    if (rung !== undefined && rung !== null) await diagWrite(chatId, 'replay_rung', Number(rung) || 0);
  } catch { /* fail-open */ }
}
export async function resolveBrainReplayJob(jobId, state) {
  try {
    const jobs = await readBrainReplayJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return false;
    job.state = String(state);
    job.resolvedAt = Date.now();
    await writeBrainReplayJobs(jobs);
    await noteDiagReplay(job.chatId, job.chatType, { state: String(state), attempts: job.attempts }).catch(() => {});
    return true;
  } catch { return false; }
}
export async function claimBrainReplayAttempt(jobId) {
  try {
    const jobs = await readBrainReplayJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job || job.state !== 'pending') return null;
    job.attempts = (Number(job.attempts) || 0) + 1;
    job.lastAttemptAt = Date.now();
    await writeBrainReplayJobs(jobs);
    // R3/R4: pending + rung trail (attempt N starts at rung N-1, same
    // as the cycle's ladderStartIndex) — separately guarded so a diag
    // failure can never turn a claim into claim-failed.
    await noteDiagReplay(job.chatId, job.chatType, { state: 'pending', attempts: job.attempts, rung: job.attempts - 1 }).catch(() => {});
    return job;
  } catch { return null; }
}
/** Oldest pending job old enough to be certainly dead (90s > ~33s platform kill). Attempts are NOT filtered here: the cycle must still see an attempts-capped job so it can mark it 'exhausted' instead of letting it linger pending forever. Pure over a job list. */
export function pickBrainReplayJob(jobs = [], now = Date.now()) {
  const pending = jobs.filter((j) => j && j.state === 'pending'
    && now - (Number(j.createdAt) || 0) >= BRAIN_REPLAY_MIN_AGE_MS);
  pending.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  return pending[0] ?? null;
}
export async function readBrainReplayJobsPublic() { return readBrainReplayJobs(); }
/** Nudge deferral: a pending job for THIS chat + trigger means the tick is still trying to answer for real. */
export function replayDefersNudge(jobs = [], triggeredAt, triggeredChatId) {
  const t = Number(triggeredAt) || 0;
  if (!t) return false;
  return jobs.some((j) => j && j.state === 'pending' && Number(j.triggeredAt) === t
    && String(j.chatId) === String(triggeredChatId ?? ''));
}

// ── Community learning + autonomous diagnosis (2026-10-28) ────────────────
// Spec: PB-COMMUNITY-LEARNING-AUTONOMOUS-DIAGNOSIS-SPEC-2026-10-28.md.
// Sealed per chat ID, always: every key below names exactly one chat, no
// key/row/log line ever contains two chats' data, and no message text is
// ever stored (counts, labels, timestamps only). All writers are
// fail-open: a learning/diagnosis failure must never break the reply,
// the send, or the tick. No new module, no schema migration: profiles
// and diagnosis state live in the existing config key-value store
// (config.value is TEXT — no length cap in schema, and profiles are
// hard-capped at 1500 chars before write, so Q3 is answered twice).
// DM chats are NOT communities: every stamp/fold/profile function here
// is called only for group/supergroup chats by its call sites.

export const COMMUNITY_PROFILE_MAX_CHARS = 1500;
export const COMMUNITY_FOLD_MIN_INTERVAL_MS = 3_600_000; // one fold per chat per hour, max
export const COMMUNITY_LEARN_MIN_REFRESHES = 3;
export const COMMUNITY_LEARN_MIN_ANSWERED = 20;
export const DIAG_SHADOW_MIN_CLASSIFICATIONS = 100;
export const DIAG_MAX_CHATS = 200;

export function communityProfileKey(chatId) { return `community_profile_${String(chatId)}`; }
export function communityProfileShadowKey(chatId) { return `community_profile_shadow_${String(chatId)}`; }
export function communityProfileGraduatedKey(chatId) { return `community_profile_graduated_${String(chatId)}`; }
export function diagKey(chatId, field) { return `diag_${String(chatId)}_${field}`; }
const DIAG_CHATS_KEY = 'diag_chats';

// ── Pure: prompt injection assertion ───────────────────────────────────────
// The ONLY way a profile reaches a prompt. The key is built from the
// answering chat's own ID and nothing else is ever read; this assertion
// is the second lock: on any mismatch it injects NOTHING and reports a
// seal violation (the caller counts it, which blocks graduation).
export function buildCommunityContext({ profileChatId, answeringChatId, profileText, graduated } = {}) {
  const same = String(profileChatId ?? '') !== '' && String(profileChatId) === String(answeringChatId);
  if (!graduated || !profileText) return { context: '', sealViolation: false };
  if (!same) return { context: '', sealViolation: true };
  return { context: `Community notes for this chat:\n${profileText}`, sealViolation: false };
}

// ── Pure: fold skip check ──────────────────────────────────────────────────
// Local keyword check: if the turn adds no significant word the current
// shadow profile does not already contain, the fold is skipped and the
// turn costs no LLM call. Heuristic, fail-open (a missed skip costs one
// small call; a wrong skip costs one turn of learning).
const FOLD_STOPWORDS = new Set(('a an the and or but if then else when while of to in on for with by at from as is are was were be been being do does did have has had what who whom which why how this that these those there here it its it\'s i you he she we they me him her us them my your his our their can could should would will just not no yes so very really get got make made take tell say says said ask asked know think like').split(' '));
function foldSignificantWords(text) {
  const words = String(text ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return [...new Set(words.filter((w) => !FOLD_STOPWORDS.has(w)))];
}
export function communityFoldSkipped({ profileText, turnText, answerText } = {}) {
  const words = foldSignificantWords(`${turnText ?? ''}\n${answerText ?? ''}`);
  if (!words.length) return true;
  const profile = String(profileText ?? '').toLowerCase();
  return words.every((w) => profile.includes(w));
}

// ── Pure: graduation bars ──────────────────────────────────────────────────
export function learningGraduated({ refreshes, answered, sealViolations } = {}) {
  return (Number(refreshes) || 0) >= COMMUNITY_LEARN_MIN_REFRESHES
    && (Number(answered) || 0) >= COMMUNITY_LEARN_MIN_ANSWERED
    && (Number(sealViolations) || 0) === 0;
}
export function diagnosisGraduated({ classifications, contradictions } = {}) {
  return (Number(classifications) || 0) >= DIAG_SHADOW_MIN_CLASSIFICATIONS
    && (Number(contradictions) || 0) === 0;
}

// ── Pure: per-chat fault classification ────────────────────────────────────
// Exactly one state per chat. Priority order matters and mirrors the
// spec's worked example: a trigger with no attempt reads TRIGGER, not
// DELIVERY, even when the rollup is also rising. Quiet alone (flat
// rollup, no pending trigger) is HEALTHY — never a fault. Grace
// windows keep in-flight turns from faulting: 120s for a trigger to
// gain an attempt, 300s for an attempt to gain an outcome, 600s for a
// frozen handled stamp to count as a delivery stall.
export const DIAG_TRIGGER_GRACE_MS = 120_000;
export const DIAG_ATTEMPT_STALE_MS = 300_000;
export const DIAG_DELIVERY_GRACE_MS = 600_000;
export function classifyChatDiagnosis(s = {}) {
  const now = Number(s.now) || 0;
  const t = Number(s.lastTriggeredAt) || 0;
  const ans = Number(s.lastAnswerAt) || 0;
  const att = Number(s.lastAttemptAt) || 0;
  const be = Number(s.lastBrainErrorAt) || 0;
  const sf = Number(s.lastSendFailedAt) || 0;
  if (t > 0 && ans > t) return { state: 'HEALTHY', cause: 'answer after trigger' };
  if (t > 0 && sf > t && sf > ans) return { state: 'SEND', cause: 'send failed after trigger, no answer' };
  if (t > 0 && be > t && be > ans) return { state: 'BRAIN', cause: 'brain error after trigger, no answer' };
  if (t > 0 && att > t && now - att > DIAG_ATTEMPT_STALE_MS) return { state: 'BRAIN', cause: 'attempt without outcome (stale attempt, no error or answer)' };
  if (t > 0 && att <= t && now - t > DIAG_TRIGGER_GRACE_MS) return { state: 'TRIGGER', cause: 'triggered, no brain-reply attempt' };
  const handled = Number(s.lastHandledAt) || 0;
  if ((Number(s.rollupNow) || 0) > (Number(s.rollupSeenPrev) || 0)
    && handled === (Number(s.handledSeenPrev) || 0) && handled > 0
    && now - handled >= DIAG_DELIVERY_GRACE_MS) {
    const adminNote = s.adminOk === false ? '; admin probe says PB is not admin' : '';
    return { state: 'DELIVERY', cause: `rollup rose while handled stamp frozen${adminNote}` };
  }
  if (s.adminOk === false) return { state: 'CONFIG', cause: 'admin probe says PB is not admin or was removed' };
  if (s.adminOk === null && (Number(s.adminNullStreak) || 0) >= 2) return { state: 'CONFIG', cause: 'admin state unreadable (probe failed repeatedly)' };
  if (s.freeChatEnabled === false && s.triggeredVia === 'freechat' && t > 0 && now - t < 86_400_000) {
    return { state: 'CONFIG', cause: 'freechat off after a freechat trigger' };
  }
  return { state: 'HEALTHY', cause: 'answers flowing or chat legitimately quiet' };
}

// ── Pure: repeat rule + owner page text ────────────────────────────────────
export function diagRepeatCount(history = [], state, now = Date.now()) {
  return (Array.isArray(history) ? history : []).filter((h) => h?.state === state
    && (Number(now) - (Number(h.at) || 0)) < 86_400_000).length;
}
export function diagPageTime(ms) {
  try {
    return new Date(Number(ms)).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  } catch { return new Date(Number(ms)).toISOString(); }
}
export function buildDiagPageText({ title, state, faultSince, cause, fix, result } = {}) {
  return `PB in ${title || 'this community'}: ${state} since ${diagPageTime(faultSince)}. Cause: ${cause}. PB tried: ${fix}. Result: ${result}.`;
}

// ── Config-store writers/readers (all fail-open) ────────────────────────────
async function diagWrite(chatId, field, value) {
  try { await setConfig(diagKey(chatId, field), String(value)); } catch { /* fail-open */ }
}
export async function registerDiagChat(chatId) {
  try {
    const raw = await getConfig(DIAG_CHATS_KEY, '');
    let list = [];
    try { list = JSON.parse(raw || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const cid = String(chatId);
    if (!list.includes(cid)) {
      list.push(cid);
      while (list.length > DIAG_MAX_CHATS) list.shift();
      await setConfig(DIAG_CHATS_KEY, JSON.stringify(list));
    }
  } catch { /* fail-open */ }
}
export async function readDiagChats() {
  try {
    const raw = await getConfig(DIAG_CHATS_KEY, '');
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((c) => typeof c === 'string') : [];
  } catch { return []; }
}
const diagHandledMemo = new Map(); // chatId -> last write ms (60s throttle, mirrors stampMessagePath)
export async function stampDiagHandled(chatId, title) {
  try {
    const cid = String(chatId);
    const now = Date.now();
    if (now - (diagHandledMemo.get(cid) || 0) <= 60_000) return;
    diagHandledMemo.set(cid, now);
    await registerDiagChat(cid);
    await diagWrite(cid, 'last_handled_at', now);
    if (title) await diagWrite(cid, 'title', String(title).slice(0, 200));
  } catch { /* fail-open */ }
}
const DIAG_TRIGGER_VIAS = new Set(['direct', 'freechat', 'command-ask']);
export async function stampDiagTriggered(chatId, via) {
  try {
    await registerDiagChat(chatId);
    await diagWrite(chatId, 'last_triggered_at', Date.now());
    await diagWrite(chatId, 'triggered_via', DIAG_TRIGGER_VIAS.has(String(via)) ? String(via) : 'direct');
  } catch { /* fail-open */ }
}
export async function stampDiagAttempt(chatId) {
  try { await diagWrite(chatId, 'last_attempt_at', Date.now()); } catch { /* fail-open */ }
}
export async function stampDiagAnswer(chatId) {
  try { await diagWrite(chatId, 'last_answer_at', Date.now()); } catch { /* fail-open */ }
}
export async function stampDiagBrainError(chatId) {
  try { await diagWrite(chatId, 'last_brain_error_at', Date.now()); } catch { /* fail-open */ }
}
export async function stampDiagSendFailed(chatId) {
  try {
    await diagWrite(chatId, 'last_send_failed_at', Date.now());
    const prev = Number(await getConfig(diagKey(chatId, 'send_failed_count'), '0')) || 0;
    await diagWrite(chatId, 'send_failed_count', prev + 1);
  } catch { /* fail-open */ }
}
function parseJsonArray(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export async function readDiagState(chatId) {
  const cid = String(chatId);
  const num = async (field) => {
    try { return Number(await getConfig(diagKey(cid, field), '0')) || 0; } catch { return 0; }
  };
  const str = async (field) => {
    try { return String(await getConfig(diagKey(cid, field), '') ?? ''); } catch { return ''; }
  };
  return {
    chatId: cid,
    title: await str('title'),
    lastHandledAt: await num('last_handled_at'),
    lastTriggeredAt: await num('last_triggered_at'),
    triggeredVia: await str('triggered_via'),
    lastAttemptAt: await num('last_attempt_at'),
    lastAnswerAt: await num('last_answer_at'),
    lastBrainErrorAt: await num('last_brain_error_at'),
    lastSendFailedAt: await num('last_send_failed_at'),
    sendFailedCount: await num('send_failed_count'),
    replayState: await str('replay_state'),
    replayAttempts: await num('replay_attempts'),
    replayRung: await num('replay_rung'),
    lastFault: await str('last_fault'),
    faultSince: await num('fault_since'),
    pagedEpisode: await str('paged_episode'),
    fixEpisode: await str('fix_episode'),
    fixRecord: await str('fix_record'),
    faultHistory: parseJsonArray(await str('fault_history')),
    rollupSeen: await num('rollup_seen'),
    handledSeen: await num('handled_seen'),
    adminNullStreak: await num('admin_null_streak'),
  };
}
export async function setDiagFault(chatId, state, since) {
  await diagWrite(chatId, 'last_fault', state);
  await diagWrite(chatId, 'fault_since', since);
}
export async function clearDiagFault(chatId) {
  await diagWrite(chatId, 'last_fault', '');
  await diagWrite(chatId, 'fault_since', 0);
}
export async function pushDiagFaultHistory(chatId, state, at) {
  try {
    const raw = await getConfig(diagKey(chatId, 'fault_history'), '');
    const hist = parseJsonArray(raw);
    hist.push({ state: String(state), at: Number(at) || 0 });
    await diagWrite(chatId, 'fault_history', JSON.stringify(hist.slice(-20)));
  } catch { /* fail-open */ }
}
export async function setDiagPagedEpisode(chatId, dedupe) { await diagWrite(chatId, 'paged_episode', dedupe); }
export async function setDiagFixEpisode(chatId, dedupe) { await diagWrite(chatId, 'fix_episode', dedupe); }
export async function recordDiagFix(chatId, { fault, fix, outcome } = {}) {
  await diagWrite(chatId, 'fix_record', JSON.stringify({ fault, fix, outcome, at: Date.now() }));
}
export async function setDiagSeen(chatId, rollupSeen, handledSeen) {
  await diagWrite(chatId, 'rollup_seen', rollupSeen);
  await diagWrite(chatId, 'handled_seen', handledSeen);
}
// Admin-probe streak: a single failed probe never faults a chat (transient
// reads happen); two consecutive null probes degrade to CONFIG per spec Q2.
export async function noteDiagAdminProbe(chatId, adminOk) {
  try {
    const prev = Number(await getConfig(diagKey(chatId, 'admin_null_streak'), '0')) || 0;
    const streak = adminOk === null ? prev + 1 : 0;
    await diagWrite(chatId, 'admin_null_streak', streak);
    return { adminOk, nullStreak: streak };
  } catch { return { adminOk, nullStreak: adminOk === null ? 2 : 0 }; }
}
// Today's rollup message count for one chat (read-only; a missing table
// or failed read degrades to 0, never an invented number). Day key
// mirrors lib/groupmsg.js groupReportLaDay (LA calendar day).
export async function diagRollupToday(chatId) {
  try {
    let day;
    try {
      day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch { day = new Date().toISOString().slice(0, 10); }
    const row = await db.select().from(group_daily_rollup)
      .where(and(eq(group_daily_rollup.chatId, String(chatId)), eq(group_daily_rollup.day, day))).get();
    return Number(row?.messages) || 0;
  } catch { return 0; }
}

// ── Shadow diagnosis counters + graduation switch ─────────────────────────
export async function readDiagShadow() {
  const num = async (key) => {
    try { return Number(await getConfig(key, '0')) || 0; } catch { return 0; }
  };
  return {
    classifications: await num('diag_shadow_classifications'),
    contradictions: await num('diag_shadow_contradictions'),
    sharedEpisodes: await num('diag_shadow_episodes'),
    graduated: (await (async () => { try { return await getConfig('diag_graduated', ''); } catch { return ''; } })()) === '1',
  };
}
export async function noteDiagShadowClassification({ contradiction = false, shared = false } = {}) {
  try {
    const cur = await readDiagShadow();
    await setConfig('diag_shadow_classifications', String(cur.classifications + 1));
    if (shared) await setConfig('diag_shadow_episodes', String(cur.sharedEpisodes + 1));
    if (contradiction) await setConfig('diag_shadow_contradictions', String(cur.contradictions + 1));
  } catch { /* fail-open */ }
}
export async function setDiagGraduated() {
  try { await setConfig('diag_graduated', '1'); } catch { /* fail-open */ }
}

// ── Community profiles ─────────────────────────────────────────────────────
// Live profile is EMPTY until graduation; shadow always builds. Turn text
// is never persisted: the fold receives it in memory only and it is
// discarded after the fold returns.
export async function loadCommunityProfileForAnswer(chatId) {
  const cid = String(chatId);
  try {
    const graduated = (await getConfig(communityProfileGraduatedKey(cid), '')) === '1';
    const profileText = graduated ? String(await getConfig(communityProfileKey(cid), '') || '') : '';
    return { profileText, profileChatId: cid, graduated };
  } catch { return { profileText: '', profileChatId: cid, graduated: false }; }
}
export async function recordCommunitySealViolation(chatId) {
  try {
    const cid = String(chatId);
    const prev = Number(await getConfig(`community_profile_seal_${cid}`, '0')) || 0;
    await setConfig(`community_profile_seal_${cid}`, String(prev + 1));
  } catch { /* fail-open */ }
}
export async function noteCommunityAnswered(chatId) {
  try {
    const cid = String(chatId);
    const prev = Number(await getConfig(`community_profile_answered_${cid}`, '0')) || 0;
    await setConfig(`community_profile_answered_${cid}`, String(prev + 1));
  } catch { /* fail-open */ }
}
// Fold orchestration. foldFn is injected by the caller (message.js passes
// an askLLM call); this function owns rate cap, skip check, the 1500-char
// cap, shadow write, graduation, and regression. Never throws.
export async function foldCommunityProfile({ chatId, turnText, answerText, foldFn } = {}) {
  try {
    const cid = String(chatId);
    const now = Date.now();
    const lastFold = Number(await getConfig(`community_profile_fold_at_${cid}`, '0')) || 0;
    if (now - lastFold < COMMUNITY_FOLD_MIN_INTERVAL_MS) return { folded: false, reason: 'rate-cap' };
    const shadow = String(await getConfig(communityProfileShadowKey(cid), '') || '');
    if (communityFoldSkipped({ profileText: shadow, turnText, answerText })) return { folded: false, reason: 'no-new-signal' };
    if (typeof foldFn !== 'function') return { folded: false, reason: 'no-fold-fn' };
    const out = await foldFn({ profile: shadow, turnText, answerText });
    const next = String(out ?? '').trim().slice(0, COMMUNITY_PROFILE_MAX_CHARS);
    if (!next) return { folded: false, reason: 'empty-fold' };
    const graduated = (await getConfig(communityProfileGraduatedKey(cid), '')) === '1';
    // Thanks/correction signals for this folded turn (local substring
    // counts only — never quoted, never stored as text). A negative
    // streak (corrections outnumber thanks, >= 2) regresses a live
    // profile; positive feedback clears the streak.
    let cycle = {};
    try { cycle = JSON.parse(await getConfig(`community_profile_cycle_${cid}`, '') || '{}') || {}; } catch { cycle = {}; }
    if (/thank/i.test(String(turnText ?? ''))) cycle.thanks = (Number(cycle.thanks) || 0) + 1;
    if (/\b(wrong|incorrect|not right|that's not)\b/i.test(String(turnText ?? ''))) cycle.corrections = (Number(cycle.corrections) || 0) + 1;
    await setConfig(communityProfileShadowKey(cid), next);
    await setConfig(`community_profile_fold_at_${cid}`, String(now));
    const refreshes = (Number(await getConfig(`community_profile_refreshes_${cid}`, '0')) || 0) + 1;
    await setConfig(`community_profile_refreshes_${cid}`, String(refreshes));
    if (graduated) {
      if ((Number(cycle.corrections) || 0) >= 2 && (Number(cycle.corrections) || 0) > (Number(cycle.thanks) || 0)) {
        // Regression (spec §6): live reverts to its last shadow text
        // (the pre-fold shadow), the chat re-enters shadow, and the bar
        // must be re-earned from zero.
        await setConfig(communityProfileKey(cid), shadow);
        await setConfig(communityProfileGraduatedKey(cid), '0');
        await setConfig(`community_profile_refreshes_${cid}`, '0');
        await setConfig(`community_profile_answered_${cid}`, '0');
        await setConfig(`community_profile_cycle_${cid}`, '{}');
        return { folded: true, graduated: false, regressed: true };
      }
      await setConfig(communityProfileKey(cid), next); // live tracks shadow once graduated
      if ((Number(cycle.thanks) || 0) > (Number(cycle.corrections) || 0)) cycle = {};
      await setConfig(`community_profile_cycle_${cid}`, JSON.stringify(cycle));
      return { folded: true, graduated: true };
    }
    await setConfig(`community_profile_cycle_${cid}`, JSON.stringify(cycle));
    const answered = Number(await getConfig(`community_profile_answered_${cid}`, '0')) || 0;
    const seal = Number(await getConfig(`community_profile_seal_${cid}`, '0')) || 0;
    if (learningGraduated({ refreshes, answered, sealViolations: seal })) {
      await setConfig(communityProfileKey(cid), next);
      await setConfig(communityProfileGraduatedKey(cid), '1');
      return { folded: true, graduated: true };
    }
    return { folded: true, graduated: false };
  } catch { return { folded: false, reason: 'error' }; }
}
// Owner read / edit / wipe per community (spec §2.7). Edit text is used
// as-is and capped at 1500 chars; wipe empties live + shadow + flag +
// counters (no backup is kept anywhere by this build, per spec §5.5).
export async function readCommunityProfiles(chatId) {
  const cid = String(chatId);
  const get = async (key) => { try { return String(await getConfig(key, '') ?? ''); } catch { return ''; } };
  return {
    live: await get(communityProfileKey(cid)),
    shadow: await get(communityProfileShadowKey(cid)),
    graduated: (await get(communityProfileGraduatedKey(cid))) === '1',
    refreshes: Number(await get(`community_profile_refreshes_${cid}`)) || 0,
    answered: Number(await get(`community_profile_answered_${cid}`)) || 0,
    sealViolations: Number(await get(`community_profile_seal_${cid}`)) || 0,
  };
}
export async function setCommunityProfileText(chatId, text) {
  const cid = String(chatId);
  await setConfig(communityProfileKey(cid), String(text ?? '').slice(0, COMMUNITY_PROFILE_MAX_CHARS));
}
export async function wipeCommunityProfiles(chatId) {
  const cid = String(chatId);
  for (const key of [communityProfileKey(cid), communityProfileShadowKey(cid),
    communityProfileGraduatedKey(cid), `community_profile_refreshes_${cid}`,
    `community_profile_answered_${cid}`, `community_profile_seal_${cid}`,
    `community_profile_cycle_${cid}`, `community_profile_fold_at_${cid}`]) {
    try { await setConfig(key, ''); } catch { /* fail-open */ }
  }
}

// Routing-exit tallies (Diagnostic #2, Break #2): the span between a
// message being logged and the brain being called had ZERO
// instrumentation — two of the owner's questions vanished there with
// every gate eliminated by elimination, leaving nothing to convict.
// These counters record WHERE each plain message left that span, per
// chat per UTC hour, as AGGREGATE COUNTS ONLY — kinds and hook names,
// never message content (sealed-monitoring rule). Kinds: handled /
// skipped_directed_human / skipped_not_addressed / consumed:<hook>.
// Fail-open: a tally failure never breaks handling.
export async function tallyRoutingExit(chatId, kind) {
  try {
    const k = String(kind ?? '').slice(0, 48);
    if (!/^[a-z0-9_:-]+$/.test(k)) return;
    const hour = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
    const key = `routing_tally:${chatId}:${hour}`;
    let counts = {};
    try { counts = JSON.parse((await getConfig(key, '')) || '{}') || {}; } catch { counts = {}; }
    counts[k] = (Number(counts[k]) || 0) + 1;
    await setConfig(key, JSON.stringify(counts));
  } catch { /* fail-open: tallies must never break the handler */ }
}

// Owner-gated health snapshot (getDashboard action 'healthSnapshot').
// COUNTS ONLY — tallies, class names, provider/outcome keys; no message
// content, no user text, no secrets. Every section is independently
// fail-soft: a broken read reports { error: true } for that section
// instead of sinking the whole snapshot.
// Pure per-provider:outcome latency aggregates over llm_ledger rows
// (First-ask / ladder-diagnosis wave, 2026-10-26): the ledger stores
// outcome but no error text, so a rung's failure CLASS is otherwise
// unrecoverable — but its latency signature is not. A failover rung
// timing out on its leash clusters at the leash value (9s), while an
// auth/quota/request failure lands in milliseconds. Pure so the
// harness can prove it on fixtures; read-only aggregation, no new
// columns, no schema change.
export function llmLatencyStats(rows) {
  const acc = {};
  for (const r of rows ?? []) {
    const k = `${r.provider}:${r.outcome}`;
    const ms = Number(r.latencyMs) || 0;
    const e = acc[k] ?? (acc[k] = { n: 0, sum: 0, max: 0 });
    e.n += 1; e.sum += ms; if (ms > e.max) e.max = ms;
  }
  const out = {};
  for (const [k, e] of Object.entries(acc)) out[k] = { n: e.n, avgMs: Math.round(e.sum / e.n), maxMs: e.max };
  return out;
}

export async function buildHealthSnapshot() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceSec = nowSec - 86_400;
  // ts-mode columns compare against unix SECONDS in this codebase
  // (lib/decide.js cutoffSec, lib/relay.js since7) — never Date objects.
  const silentCutoffSec = nowSec - 7 * 86_400;
  const section = async (fn) => { try { return await fn(); } catch { return { error: true }; } };
  const tally = (rows, keyOf) => {
    const out = {};
    for (const r of rows) { const k = keyOf(r); out[k] = (out[k] ?? 0) + 1; }
    return out;
  };

  const lastTickRaw = await getConfig('last_tick', '').catch(() => '');
  const lastTickMs = Number(lastTickRaw) || 0;

  const commandErrors = await section(async () => {
    const rows = await db.select().from(command_errors)
      .where(gte(command_errors.ts, sinceSec)).all();
    const bySurface = tally(rows, (r) => r.surface);
    const classCounts = tally(rows, (r) => r.errorClass);
    const topClasses = Object.entries(classCounts)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([errorClass, count]) => ({ errorClass, count }));
    return { total24h: rows.length, bySurface, topClasses };
  });

  const llm = await section(async () => {
    const rows = await db.select().from(llm_ledger)
      .where(gte(llm_ledger.ts, sinceSec)).all();
    // Task 2 (2026-10-26): model split (which Gemini model is failing —
    // chat 3.8-flash vs decide 3.1-flash-lite) reads from existing rows
    // immediately; the error class populates on the next ladder error
    // via recordLlmErrorClass (status/label only, never message text).
    const lastErrorClassByProvider = {};
    for (const p of ['groq', 'gemini', 'openrouter', 'mistral', 'workersai', 'xai']) {
      try {
        const cls = await getConfig(`llm_last_error_${p}`, '');
        if (cls) {
          const at = Number(await getConfig(`llm_last_error_at_${p}`, '0')) || 0;
          lastErrorClassByProvider[p] = { class: cls, at: at ? new Date(at).toISOString() : null };
        }
      } catch { /* one provider's stamp never breaks the section */ }
    }
    return { total24h: rows.length, byProviderOutcome: tally(rows, (r) => `${r.provider}:${r.outcome}`), latencyByProviderOutcome: llmLatencyStats(rows), byProviderModelOutcome: tally(rows, (r) => `${r.provider}:${r.model}:${r.outcome}`), lastErrorClassByProvider };
  });

  const agentRuns = await section(async () => {
    const rows = await db.select().from(agent_runs)
      .where(gte(agent_runs.ranAt, sinceSec)).all();
    return {
      total24h: rows.length,
      failed24h: rows.filter((r) => r.status === 'failed').length,
    };
  });

  const campaignDelivery = await section(async () => {
    const rows = await db.select().from(campaign_delivery_log)
      .where(gte(campaign_delivery_log.sentAt, sinceSec)).all();
    return { total24h: rows.length, byOutcome: tally(rows, (r) => r.outcome) };
  });

  const dmBroadcast = await section(async () => {
    const jobs = await db.select().from(dm_broadcast_jobs)
      .orderBy(desc(dm_broadcast_jobs.id)).limit(1).all();
    const job = jobs[0];
    if (!job) return { latestJobId: null, failed: 0, sent: 0, queued: 0 };
    const recips = await db.select().from(dm_broadcast_recipients)
      .where(eq(dm_broadcast_recipients.jobId, job.id)).all();
    const byStatus = tally(recips, (r) => r.status);
    return {
      latestJobId: job.id, jobStatus: job.status,
      failed: byStatus.failed ?? 0, sent: byStatus.sent ?? 0, queued: byStatus.queued ?? 0,
    };
  });

  const silentGroups = await section(async () => {
    const rows = await db.select().from(known_groups)
      .where(lt(known_groups.lastActive, silentCutoffSec)).all();
    return { silentOver7d: rows.length };
  });

  const decisions = await section(async () => {
    const rows = await db.select().from(decision_log)
      .where(and(gte(decision_log.createdAt, sinceSec), isNotNull(decision_log.failureReason)))
      .all();
    return { failures24h: rows.length, byReason: tally(rows, (r) => String(r.failureReason)) };
  });

  const masterSpend = await section(async () => {
    const rows = await db.select().from(master_spend_ledger)
      .where(gte(master_spend_ledger.createdAt, sinceSec)).all();
    return { total24h: rows.length, byStatus: tally(rows, (r) => r.status) };
  });

  // Fail-proof chat (2026-11-03): daily self-test record, written by
  // the tick's chatSelfTest cycle (config chat_selftest_last). Null
  // until the first run lands. Counts + timestamps only.
  const chatSelfTest = await section(async () => {
    const raw = await getConfig('chat_selftest_last', '').catch(() => '');
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      return {
        date: rec.date ?? null, at: rec.at ?? null, probeOk: rec.probeOk ?? null,
        rung: rec.rung ?? null, latencyMs: rec.latencyMs ?? null,
        pendingJobs: rec.pendingJobs ?? null, totalJobs: rec.totalJobs ?? null,
        storeOk: rec.storeOk ?? null,
      };
    } catch { return null; }
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    lastTick: lastTickMs
      ? { at: new Date(lastTickMs).toISOString(), ageSec: Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(lastTickMs / 1000)) }
      : null,
    commandErrors, llm, agentRuns, campaignDelivery, dmBroadcast,
    silentGroups, decisions, masterSpend, chatSelfTest,
  };
}

// ── Signal Inlet (Superpower Sweep wave, 2026-10-23) ──────────────────────
// Gap #1 of PB-SUPERPOWER-SWEEP-2026-10-23: PB could only GENERATE
// signals; a group had no way to pipe the alerts it already runs
// (TradingView Pine alerts, exchange/whale webhooks) into its own chat.
// The fabston TradingView-Webhook-Bot pattern (MIT) — a shared secret in
// the payload, per-group routing, {{ticker}}/{{close}} templating —
// reimplemented here in PB's own code (clean-room: idea only, no code
// taken). One inlet per group, sealed per chat ID like everything else:
// the secret resolves to exactly ONE group and a card can only ever land
// in that group. The raw secret is shown ONCE to the creating admin and
// only its sha256:v1: hash is stored (mcpkeys discipline). Signals are
// DISPLAY-ONLY — PB never trades on an inlet signal; that line is in the
// setup copy and on every card. No outbound fetch of any kind happens on
// this path (no SSRF class), no AI call, no money surface.
// Config: group_settings.settings.signalInlet (see the keys comment at
// the top of this file). Global kill flag: config `signal_inlet_global`
// (unset = ON; /setkey SIGNAL_INLET_GLOBAL 0 stops every inlet at once).
// Audit: signal_inlet_log (content-free; see schema.js).

export const SIGNAL_INLET_URL = 'https://app8667050062.tgcloud.ai/api/signal';
const SIGNAL_SECRET_PREFIX = 'pbsig_';
const SIGNAL_DEFAULT_RATE_PER_HOUR = 10;
const SIGNAL_MAX_RATE_PER_HOUR = 60;
const SIGNAL_MAX_TEXT_CHARS = 2000;
const SIGNAL_MAX_TITLE_CHARS = 120;
const SIGNAL_HITS_WINDOW_MS = 3_600_000;

function signalGenerateSecret() {
  const bytes = new Uint8Array(20);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Dead in practice (the 2026-10-19 probe proved getRandomValues
    // exists in the isolate); kept so generation can never throw.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return SIGNAL_SECRET_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string equality (lengths leak, contents do not).
function signalConstEq(a, b) {
  const x = String(a ?? ''); const y = String(b ?? '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i % Math.max(x.length, 1)) || 0) ^ (y.charCodeAt(i % Math.max(y.length, 1)) || 0);
  }
  return diff === 0;
}

export async function getSignalInlet(chatId) {
  const s = await getGroupSettings(chatId);
  const inlet = s?.signalInlet;
  return (inlet && typeof inlet === 'object') ? inlet : null;
}

async function saveSignalInlet(chatId, inlet) {
  return setGroupSettings(chatId, { signalInlet: inlet });
}

/** Global kill flag: config signal_inlet_global, UNSET = ON. */
export async function signalInletGlobalOn() {
  const raw = await getConfig('signal_inlet_global', null);
  if (raw === null || raw === undefined) return true;
  return flagValueOn(raw);
}

/**
 * Create the group's inlet or rotate its secret. Rotation replaces the
 * stored hash, so the old secret stops working the moment this lands.
 * Returns { secret, inlet } — the raw secret exists ONLY in this return
 * value, for the one-time display to the creating admin.
 */
export async function createOrRotateSignalSecret(chatId, byUserId) {
  const existing = await getSignalInlet(chatId);
  const secret = signalGenerateSecret();
  const inlet = {
    enabled: true,
    secretHash: await hashKey(secret),
    threadId: existing?.threadId ?? null,
    ratePerHour: existing?.ratePerHour ?? SIGNAL_DEFAULT_RATE_PER_HOUR,
    hits: Array.isArray(existing?.hits) ? existing.hits : [],
    lastReceivedAt: existing?.lastReceivedAt ?? null,
    createdBy: byUserId ?? existing?.createdBy ?? null,
    createdAt: existing?.createdAt ?? Date.now(),
    rotatedAt: Date.now(),
  };
  await saveSignalInlet(chatId, inlet);
  return { secret, inlet };
}

export async function setSignalInletEnabled(chatId, enabled) {
  const inlet = await getSignalInlet(chatId);
  if (!inlet) return null;
  inlet.enabled = !!enabled;
  await saveSignalInlet(chatId, inlet);
  return inlet;
}

export async function setSignalInletThread(chatId, threadId) {
  const inlet = await getSignalInlet(chatId);
  if (!inlet) return null;
  inlet.threadId = (threadId === null || threadId === undefined) ? null : Number(threadId);
  await saveSignalInlet(chatId, inlet);
  return inlet;
}

export async function setSignalInletRate(chatId, perHour) {
  const inlet = await getSignalInlet(chatId);
  if (!inlet) return null;
  const n = Math.floor(Number(perHour));
  if (!Number.isFinite(n) || n < 1 || n > SIGNAL_MAX_RATE_PER_HOUR) return inlet;
  inlet.ratePerHour = n;
  await saveSignalInlet(chatId, inlet);
  return inlet;
}

// Server-side substitution of the small template-var set. A var is
// replaced only when the payload actually carries the field — a
// TradingView alert arrives with its {{...}} placeholders already
// substituted by TradingView itself, and those must pass through whole.
const SIGNAL_TEMPLATE_VARS = ['ticker', 'close', 'price'];
export function signalApplyTemplate(text, input) {
  let out = String(text ?? '');
  for (const v of SIGNAL_TEMPLATE_VARS) {
    const val = input?.[v];
    if (val === null || val === undefined || val === '') continue;
    out = out.replace(new RegExp('\\{\\{\\s*' + v + '\\s*\\}\\}', 'gi'), String(val).slice(0, 64));
  }
  return out;
}

async function signalInletAudit(chatId, payloadHash, title, status, messageId) {
  try {
    await db.insert(signal_inlet_log).values({
      chatId: String(chatId),
      ts: Math.floor(Date.now() / 1000),
      payloadHash,
      title: title ? String(title).slice(0, SIGNAL_MAX_TITLE_CHARS) : null,
      status,
      messageId: (messageId === null || messageId === undefined) ? null : Number(messageId),
    }).run();
  } catch { /* fail-open: audit must never break delivery */ }
}

export function signalCardText(title, text) {
  const head = title ? `📡 ${title}` : '📡 Signal Alert';
  return [head, '', String(text), '', '📡 via PB Signal Inlet — display only. PB never trades on inlet signals.']
    .join('\n').slice(0, 4000);
}

/**
 * The inlet core — endpoints/signal.js is a thin shell over this.
 * input: { secret, title?, text, route?, ticker?, close?, price? }.
 * Returns a plain result object; NEVER throws for a bad payload.
 * The secret alone decides the destination group: there is deliberately
 * no chatId field in the payload, so a sender cannot aim a signal at a
 * group whose secret it does not hold (cross-group isolation is
 * structural, not a check that can be forgotten).
 */
export async function processSignalInlet(input) {
  const secret = String(input?.secret ?? '');
  if (!secret || secret.length > 128) return { ok: false, code: 'NOT_FOUND' };
  const presentedHash = await hashKey(secret);

  // Resolve the ONE group this secret belongs to. Group count is small
  // (~30) and settings are one row per group, so a scan is the honest
  // shape — there is no hash index to lean on, and none is needed.
  let match = null;
  try {
    const rows = await db.select().from(group_settings).all();
    for (const row of rows ?? []) {
      const inlet = row?.settings?.signalInlet;
      if (inlet?.secretHash && signalConstEq(inlet.secretHash, presentedHash)) {
        match = { chatId: String(row.chatId), inlet };
        break;
      }
    }
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
  if (!match) return { ok: false, code: 'NOT_FOUND' };
  return deliverSignalInlet(match.chatId, match.inlet, input);
}

// Post-match delivery, shared by the bot endpoint (raw secret) and the
// Worker relay applier (secret hash): validation, kill/enabled/rate,
// card send, audit row. The inlet is copied so hit bookkeeping never
// mutates the caller's object.
async function deliverSignalInlet(chatId, inlet, input) {
  inlet = { ...inlet };
  const title = String(input?.title ?? '').trim().slice(0, SIGNAL_MAX_TITLE_CHARS) || null;
  const rawText = String(input?.text ?? '');
  const payloadHash = await sha256Hex(JSON.stringify({
    title: title ?? '', text: rawText,
    ticker: input?.ticker ?? '', close: input?.close ?? '',
    price: input?.price ?? '', route: input?.route ?? '',
  }));

  if (!rawText.trim()) return { ok: false, code: 'VALIDATION', field: 'text' };
  if (rawText.length > SIGNAL_MAX_TEXT_CHARS) {
    await signalInletAudit(chatId, payloadHash, title, 'rejected', null);
    return { ok: false, code: 'PAYLOAD_TOO_LARGE', max: SIGNAL_MAX_TEXT_CHARS };
  }
  if (!(await signalInletGlobalOn())) {
    await signalInletAudit(chatId, payloadHash, title, 'killed', null);
    return { ok: false, code: 'INLET_OFF' };
  }
  if (!inlet.enabled) {
    await signalInletAudit(chatId, payloadHash, title, 'disabled', null);
    return { ok: false, code: 'INLET_DISABLED' };
  }

  // Rate limit: trailing-hour hit window stored on the inlet itself.
  // A hit is consumed BEFORE the send attempt, so a failing destination
  // cannot be retried into a flood.
  const now = Date.now();
  const hits = (Array.isArray(inlet.hits) ? inlet.hits : [])
    .map(Number).filter((n) => Number.isFinite(n) && now - n < SIGNAL_HITS_WINDOW_MS);
  const ratePerHour = Math.min(
    Math.max(1, Math.floor(Number(inlet.ratePerHour)) || SIGNAL_DEFAULT_RATE_PER_HOUR),
    SIGNAL_MAX_RATE_PER_HOUR,
  );
  if (hits.length >= ratePerHour) {
    inlet.hits = hits;
    await saveSignalInlet(chatId, inlet).catch(() => {});
    await signalInletAudit(chatId, payloadHash, title, 'rate_limited', null);
    return { ok: false, code: 'RATE_LIMITED', ratePerHour };
  }
  hits.push(now);
  inlet.hits = hits;
  inlet.lastReceivedAt = now;
  await saveSignalInlet(chatId, inlet);

  // Routing: the payload's optional route names 'general' or a numeric
  // topic id; otherwise the inlet's configured topic (or general).
  let threadId = (inlet.threadId === null || inlet.threadId === undefined) ? null : Number(inlet.threadId);
  const route = (input?.route === null || input?.route === undefined) ? '' : String(input.route).trim().toLowerCase();
  if (route === 'general') threadId = null;
  else if (/^\d+$/.test(route)) threadId = Number(route);

  const text = signalApplyTemplate(rawText, input);
  const card = signalCardText(title, text);
  let sent = null;
  try {
    sent = await api.sendMessage({
      chat_id: chatId,
      text: card,
      disable_web_page_preview: true,
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  } catch {
    sent = null;
  }
  if (!sent) {
    await signalInletAudit(chatId, payloadHash, title, 'send_failed', null);
    return { ok: false, code: 'SEND_FAILED' };
  }
  await signalInletAudit(chatId, payloadHash, title, 'sent', sent?.message_id ?? null);
  return { ok: true, chatId, messageId: sent?.message_id ?? null };
}

// Worker relay applier entry (2026-10-25): the relay stores only the
// SHA-256 of the secret, never the raw secret, so the applier matches
// by hash. Bot-stored hashes carry the 'sha256:v1:' prefix (hashKey);
// the relay stores bare hex — accept both, constant-time, so a prefix
// difference on either side cannot silently orphan relayed signals.
// Same { ok, code } shape as processSignalInlet; UNAVAILABLE (settings
// read failed) is transient and the caller retries, every other refusal
// is terminal and the caller acks.
export async function processSignalInletByHash(input) {
  const presented = String(input?.secretHash ?? '').trim().toLowerCase();
  if (!presented) return { ok: false, code: 'NOT_FOUND' };
  let match = null;
  try {
    const rows = await db.select().from(group_settings).all();
    for (const row of rows ?? []) {
      const inlet = row?.settings?.signalInlet;
      if (!inlet?.secretHash) continue;
      if (signalConstEq(inlet.secretHash, HASH_PREFIX + presented) || signalConstEq(inlet.secretHash, presented)) {
        match = { chatId: String(row.chatId), inlet };
        break;
      }
    }
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
  if (!match) return { ok: false, code: 'NOT_FOUND' };
  return deliverSignalInlet(match.chatId, match.inlet, input);
}

export function signalSetupText(secret) {
  const template = JSON.stringify({
    secret: secret ?? '<your secret>',
    title: '{{exchange}}:{{ticker}} alert',
    text: '{{ticker}} crossed {{close}} — your alert text here',
    ticker: '{{ticker}}',
    close: '{{close}}',
  }, null, 2);
  return [
    'TradingView setup:',
    '1. Open your alert → Notifications → Webhook URL:',
    SIGNAL_INLET_URL,
    '2. Message body (JSON) — paste exactly, keep the secret line as-is:',
    template,
    '',
    'Anyone with this secret can post alerts to your group. Rotate it if it leaks.',
    'Signals are display-only — PB never trades on an inlet signal.',
  ].join('\n');
}

async function signalStatusText(chatId) {
  const inlet = await getSignalInlet(chatId);
  if (!inlet) {
    return [
      '📡 Signal Inlet — not set up in this group yet.',
      '',
      'Pipe your own TradingView / webhook alerts into this group, sealed to this chat only.',
      '',
      'Admins: /signals create — makes the group\'s secret (shown once) and turns the inlet ON.',
      'Signals are display-only — PB never trades on an inlet signal.',
    ].join('\n');
  }
  const last = inlet.lastReceivedAt
    ? new Date(Number(inlet.lastReceivedAt)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : 'never';
  return [
    `📡 Signal Inlet — ${inlet.enabled ? 'ON' : 'OFF'} for this group.`,
    `• Rate limit: ${inlet.ratePerHour ?? SIGNAL_DEFAULT_RATE_PER_HOUR}/hour`,
    `• Topic: ${inlet.threadId ? `topic ${inlet.threadId}` : 'general (no topic)'}`,
    `• Last signal received: ${last}`,
    '',
    'Admins: /signals rotate (new secret, old one dies instantly) · /signals topic (run inside a topic to post there; /signals topic off for general) · /signals rate <1-60> · /signals off · /signals setup (show the webhook template again — needs rotate for a fresh secret)',
    'Signals are display-only — PB never trades on an inlet signal.',
  ].join('\n');
}

/**
 * /signals — the admin surface. Admin gating happens here (owner or
 * group admin; plain members get the uniform Class C refusal); the
 * Starter+ tier gate is applied by the wrapper in handlers/message.js
 * via tierGate (the /sentiment pattern, delegation-aware).
 */
export async function signalInletCommand(chatId, args, msg) {
  if (msg?.chat?.type === 'private') {
    await restoreSend(chatId, 'ℹ️ /signals works in groups.');
    return;
  }
  if (!((await isOwnerId(msg?.from?.id)) || (await isChatAdmin(chatId, msg?.from?.id)))) {
    await restoreSend(chatId, '⛔ Admin only.');
    return;
  }
  const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? 'status').toLowerCase();

  if (sub === 'create' || sub === 'rotate' || sub === 'new') {
    const { secret } = await createOrRotateSignalSecret(chatId, msg?.from?.id ?? null);
    await restoreSend(chatId, [
      sub === 'create' ? '📡 Signal Inlet is ON for this group.' : '📡 Secret rotated — the old secret stopped working just now.',
      '',
      'Your group\'s secret (shown ONCE — save it now):',
      secret,
      '',
      signalSetupText(secret),
    ].join('\n'));
    return;
  }
  if (sub === 'off' || sub === 'disable') {
    const inlet = await setSignalInletEnabled(chatId, false);
    await restoreSend(chatId, inlet
      ? '📡 Signal Inlet OFF for this group. The secret is kept — /signals on brings it back.'
      : '📡 No inlet set up in this group yet — /signals create makes one.');
    return;
  }
  if (sub === 'on' || sub === 'enable') {
    const inlet = await setSignalInletEnabled(chatId, true);
    await restoreSend(chatId, inlet
      ? '📡 Signal Inlet ON for this group.'
      : '📡 No inlet set up in this group yet — /signals create makes one.');
    return;
  }
  if (sub === 'topic') {
    const inlet = await getSignalInlet(chatId);
    if (!inlet) {
      await restoreSend(chatId, '📡 No inlet set up in this group yet — /signals create makes one.');
      return;
    }
    if ((parts[1] ?? '').toLowerCase() === 'off') {
      await setSignalInletThread(chatId, null);
      await restoreSend(chatId, '📡 Inlet topic cleared — signals will post to the group\'s general chat.');
      return;
    }
    const threadId = msg?.message_thread_id ?? null;
    if (!threadId) {
      await restoreSend(chatId, '📡 Run /signals topic inside the forum topic you want signals posted to (or /signals topic off for general).');
      return;
    }
    await setSignalInletThread(chatId, Number(threadId));
    await restoreSend(chatId, `📡 Signals will post to this topic (${threadId}).`);
    return;
  }
  if (sub === 'rate') {
    const inlet = await setSignalInletRate(chatId, parts[1]);
    await restoreSend(chatId, inlet
      ? `📡 Rate limit set: ${inlet.ratePerHour}/hour for this group.`
      : '📡 No inlet set up in this group yet — /signals create makes one. (Rate must be 1–60/hour.)');
    return;
  }
  if (sub === 'setup') {
    const inlet = await getSignalInlet(chatId);
    await restoreSend(chatId, inlet
      ? ['📡 Signal Inlet setup for this group:', '', signalSetupText(null)].join('\n')
      : '📡 No inlet set up in this group yet — /signals create makes one and shows the full setup.');
    return;
  }
  // status (default)
  await restoreSend(chatId, await signalStatusText(chatId));
}

export const SIGNAL_COMMANDS = {
  signals: signalInletCommand,
};
