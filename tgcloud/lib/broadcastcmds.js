// lib/broadcastcmds.js — /broadcast (owner broadcast).
// Ported from telegram-community-bot.ts:20253 (onText /broadcast) and its
// broadcast_confirm callback (~20353).
//
// SANCTIONED SEALING EXCEPTION: every other PB feature reads/writes strictly
// inside its own chatId — a community's data never crosses into another
// community. The owner broadcast is the ONE deliberate exception: it sends
// the owner's announcement to every group the bot serves. Do not reuse this
// cross-group pattern anywhere else.
//
// PORT DEVIATIONS (serverless):
// - Targets: the original confirmed, then DMed every bot_users row. This
//   port sends to every group in known_groups (the serverless build's spec).
//   known_groups has no "inactive" column in the cloud schema, so
//   retirement markers live in the existing config store instead (see the
//   per-group logging section below) — never in is_ad_free, which is NOT
//   consulted: this is an owner announcement, not an ad.
// - Text only, sent immediately. The original's photo modes (reply-to-photo,
//   "/broadcast photo <url> <caption>") are dropped. Its two-step inline-
//   button confirmation is restored for the PLAIN-ENGLISH path only (see
//   lib/nlcmd.js: the owner asks in a DM, confirms with a button, and this
//   module's executeBroadcast runs it); /broadcast itself stays immediate,
//   exactly as the port shipped.
// - Non-owner refusal: the original onText returned silently for non-owners;
//   the refusal text used here, "Owner only.", is the original's own wording
//   from its broadcast_confirm owner check.

import { api, InputFile } from 'sdk';
import db, { eq, and, asc, inArray } from 'sdk/db';
import {
  known_groups, bot_users, dm_broadcast_jobs, dm_broadcast_recipients,
  pbai_holder_wallets, user_wallets, user_settings,
} from '../schema.js';
import { isOwnerId, cleanupNoteSent } from './groups.js';
import { canonicalTier } from './tiers.js';
import { resolveUserKey, saveMessage } from './memory.js';
import { auditMoney } from './moneyguard.js';
import { getConfig, setConfig, getConfigFlag, saveBroadcastPreview } from './config.js';

const sendSafe = async (chatId, text, extra = {}) => {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22).
  if (sent) await cleanupNoteSent(chatId, sent);
  return sent;
};

/** Every group the bot serves — the broadcast target list. Throws on DB error. */
export async function listKnownGroups() {
  return db.select().from(known_groups).all();
}

// ══ Per-group logging + stale-group retirement (2026-10-25) ═════════════
// The 2026-10-25 broadcast reported Sent 11 / Failed 17 with no per-group
// reason anywhere: executeBroadcast swallowed each failure (catch {
// failed++ }) and the receipt's "(bot removed or no send rights)" was a
// STATIC label, not a measured reason. This section fixes that:
//  - Every failed attempt records group title + chat id + the REAL
//    Telegram error (audit log via auditMoney, the existing
//    user_activity_log path) and the receipt lists the real errors.
//  - Definitive dead groups (bot kicked/blocked, chat not found/deleted)
//    are marked inactive so future broadcasts skip them. known_groups has
//    no inactive column and this wave adds NO schema change, so the marker
//    lives in the existing config store:
//    broadcast_inactive:<chatId> = JSON { title, error, code, at }.
//    Markers NEVER delete rows; a group that re-adds the bot is a future
//    reactivation job, not something this wave guesses at.
//  - Non-terminal errors (rate limits, transient failures, and LOST SEND
//    RIGHTS — the bot still a member but not allowed to send) NEVER retire
//    a group; they are re-attempted on the next broadcast.

/** The real Telegram error text for a failed send (never a static label). */
export function broadcastErrorText(err) {
  return String(err?.description ?? err?.message ?? err ?? 'unknown error').slice(0, 200);
}

/**
 * Classify a group-send failure. 'terminal' = Telegram definitively says
 * this group is gone (bot kicked/blocked, chat not found/deleted) — safe
 * to retire. Everything else is 'transient': rate limits, transient
 * failures, and lost send rights (re-promotion can fix those, so they
 * must NOT retire the group).
 */
export function classifyGroupSendError(err) {
  const code = err?.code;
  const desc = String(err?.description ?? err?.message ?? '');
  // 403 is terminal ONLY when Telegram names the dead-group reason
  // (kicked / blocked / not a member). A bare 403 — e.g. "not enough
  // rights to send text messages" when the bot is still a member but
  // lost posting rights — is recoverable by re-promotion and must NOT
  // retire the group.
  if (code === 403 && /kicked|blocked|not a member|not a participant/i.test(desc)) return 'terminal';
  if (code === 400 && /chat not found|bot was kicked|bot was blocked|bot is not a member|chat was deleted|group chat was deleted|supergroup.*deleted|peer_id_invalid/i.test(desc)) return 'terminal';
  return 'transient';
}

const broadcastInactiveKey = (chatId) => `broadcast_inactive:${String(chatId)}`;

/** True when this group carries a retirement marker (unreadable = active). */
export async function isGroupBroadcastInactive(chatId) {
  try {
    const raw = await getConfig(broadcastInactiveKey(chatId), null);
    if (!raw) return false;
    const m = JSON.parse(raw);
    return !!m && typeof m === 'object';
  } catch { return false; }
}

/** The retirement marker for a group, or null. */
export async function getBroadcastInactiveMarker(chatId) {
  try {
    const raw = await getConfig(broadcastInactiveKey(chatId), null);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? m : null;
  } catch { return null; }
}

/**
 * Retire a group from future broadcasts: durable marker + audit row.
 * Never deletes the known_groups row. Returns true when the marker stuck.
 */
export async function retireBroadcastGroup({ chatId, title, error, code }) {
  const marker = {
    title: String(title ?? ''), error: String(error ?? '').slice(0, 200),
    code: code ?? null, at: new Date().toISOString(),
  };
  try {
    await setConfig(broadcastInactiveKey(chatId), JSON.stringify(marker));
  } catch { return false; }
  await auditMoney('broadcast', '', 'group_retired',
    `chat=${chatId} title=${marker.title} code=${code ?? ''} error=${marker.error}`);
  return true;
}

/** Broadcast targets: every known group WITHOUT a retirement marker. */
export async function listBroadcastTargets() {
  const groups = await listKnownGroups();
  const out = [];
  for (const g of groups) {
    if (await isGroupBroadcastInactive(g.chatId).catch(() => false)) continue;
    out.push(g);
  }
  return out;
}

// ══ Broadcast preview gate (2026-10-29, fix 1) ═══════════════════════════
// NOTHING in this section sends to any group or user. It only stores a
// pending preview record (config table, see lib/config.js) and shows the
// requester the exact text plus the target list with Confirm/Cancel
// buttons. The callback branch in handlers/callback_query.js is the ONLY
// path that executes a stored preview, and it takes (deletes) the record
// before executing, so one preview can fire at most once.
//   record = { kind, userId, originChatId, token, text, displayText,
//              targets: [{ chatId, title }], sourceJobId, label,
//              groupExtra, startTextKind, url, mission, creatorName }
//   kind: 'hype' | 'broadcast' | 'dmbroadcast' | 'dmfollowup' |
//         'remotesay' | 'remoteshill' | 'remoteraid' |
//         'pbblast' | 'pbnews' | 'pbbuynews' | 'pbbooster' | 'airdropblast'
//   text: the payload the executor sends (for 'broadcast': the ORIGINAL
//     text — executeBroadcastToGroups applies the same 📢 prefix the
//     immediate path used, so the executor's output equals displayText).
//   displayText: the exact text recipients will receive, shown verbatim.
//   targets: group targets for group kinds (empty for DM-job kinds, whose
//     audience is a user count, not a group list).

export const BROADCAST_PREVIEW_TARGET_NAMES = 25;

export function broadcastPreviewToken() {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** "Name (n)" target list for a preview message: first 25 names, full count always. */
export function formatBroadcastPreviewTargets(targets) {
  const list = Array.isArray(targets) ? targets : [];
  const names = list.map((g) => String(g?.title ?? g?.chatId ?? 'group')).slice(0, BROADCAST_PREVIEW_TARGET_NAMES);
  const lines = names.map((n) => `• ${n}`);
  if (list.length > names.length) lines.push(`• …and ${list.length - names.length} more`);
  return { lines, total: list.length };
}

function previewTargetLinesFor(record) {
  if (record.kind === 'dmbroadcast' || record.kind === 'dmfollowup') {
    return [`👥 Recipients: ${record.userCount ?? '?'} users (DM job — sent in batches on PB's clock)`];
  }
  if (record.kind === 'remoteshill' || record.kind === 'remoteraid' || record.kind === 'remotesay') {
    const t = (record.targets ?? [])[0];
    return [`🏘️ Target group: ${t ? String(t.title ?? t.chatId) : 'unknown'}`];
  }
  const { lines, total } = formatBroadcastPreviewTargets(record.targets);
  return [`🏘️ Groups (${total}):`, ...lines];
}

/**
 * Store a preview and show it: message 1 = the exact text recipients will
 * receive (verbatim, plain — no parse_mode, so nothing is re-rendered);
 * message 2 = the target list + Confirm/Cancel buttons. Nothing is sent
 * to any target by this function. Returns the preview token.
 */
export async function requestBroadcastPreview(originChatId, userId, record) {
  const token = broadcastPreviewToken();
  const full = { ...record, userId: String(userId), originChatId, token, createdAt: Date.now() };
  await saveBroadcastPreview(userId, full);
  const display = String(full.displayText ?? full.text ?? '');
  await sendSafe(originChatId, `👀 PREVIEW — nothing sent yet\n\n${display}`);
  const targetLines = previewTargetLinesFor(full);
  const extraLines = [];
  if (full.kind === 'remoteraid') {
    extraLines.push(`🎯 Raid target: ${full.url ?? ''}`);
    if (full.mission) extraLines.push(`🎯 Mission: ${full.mission}`);
    extraLines.push('A raid card with the standard buttons will be posted to the group above.');
  }
  await sendSafe(originChatId, [
    '📡 This will go to:',
    ...targetLines,
    ...extraLines,
    ...(looksTemplated(display) ? ['', '⚠️ Warning: this text looks templated/placeholder-like — check it before confirming. A placeholder is refused at send time even if you tap Confirm.'] : []),
    '',
    'Tap ✅ Confirm to send exactly this, or ❌ Cancel to send nothing.',
  ].join('\n'), {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Confirm — send it', callback_data: `bprev:yes:${userId}:${token}` },
      { text: '❌ Cancel', callback_data: `bprev:no:${userId}:${token}` },
    ]] },
  });
  return token;
}

/**
 * /broadcast's send pass over an EXPLICIT target list (the previewed one),
 * instead of re-reading groups at confirm time. Same per-group discipline
 * as executeBroadcast (skip inactive, audit failures, retire terminal
 * groups, capped log). The plain-English path keeps using executeBroadcast
 * unchanged — this export is only the preview-confirm executor.
 */
// ══ Unsubscribe controls (2026-10-30) ════════════════════════════════
// Group posts carry an admin-only stop button; DM ads carry a per-user
// stop button (see the DM opt-out section below). A per-member
// unsubscribe button on a group post would be meaningless — Telegram
// delivers a group post to every member, so there is no per-member
// delivery to suppress — which is why the group control is admin-gated
// and retires the whole group target instead.
/** The stop button, as its own keyboard (plain group announcements). */
export const GROUP_BROADCAST_STOP_KEYBOARD = {
  inline_keyboard: [[{ text: '🔕 Stop PB posts here', callback_data: 'group_broadcast_stop' }]],
};

/**
 * Append the group stop button to an existing send extra (blast groups
 * leg), preserving any keyboard already there (e.g. the buy keyboard)
 * and never duplicating the stop row. Pure function — harness-seamed.
 */
export function withGroupStopButton(extra = {}) {
  const kb = extra?.reply_markup?.inline_keyboard;
  const rows = Array.isArray(kb) ? kb.map((r) => [...r]) : [];
  const hasStop = rows.some((r) => r.some((b) => b?.callback_data === 'group_broadcast_stop'));
  if (!hasStop) rows.push([{ text: '🔕 Stop PB posts here', callback_data: 'group_broadcast_stop' }]);
  return { ...extra, reply_markup: { inline_keyboard: rows } };
}

// ══ Outbound-text guard (placeholder wave, 2026-10-30) ═══════════════════
// Incident: 2026-10-29 21:05 PDT a literal "[Generated promo content]" went
// out as a real announcement because broadcast validation was non-empty-only.
// This validator is the shared gate for executeBroadcast,
// executeBroadcastToGroups, and the agent-loop send steps. Fail closed:
// a refusal sends NOTHING and is audit-recorded, never a silent substitute.
// Narrow by design: real announcements containing brackets (e.g. "[LIVE]",
// "[UPDATE]") still pass — only a lone bracketed token, a bracketed
// placeholder-word segment, a {{...}} template, or the known incident
// phrase is refused.
const PLACEHOLDER_WORD_RE = /\b(generated|placeholder|lorem|todo|tbd|dummy|your\s+\w+\s+here)\b/i;

function outboundBody(raw) {
  return String(raw ?? '')
    .replace(/^📢 PoorBoyAI Announcement\s*/u, '')
    .trim();
}

/** { ok, reason } — reason: 'empty' | 'placeholder' | null. Pure function. */
export function validateOutboundText(raw) {
  const body = outboundBody(raw);
  if (!body) return { ok: false, reason: 'empty' };
  if (/^\[[^\]\n]+\]$/.test(body)) return { ok: false, reason: 'placeholder' };
  if (/\{\{[^}\n]+\}\}/.test(body)) return { ok: false, reason: 'placeholder' };
  if (/^(todo|tbd)\s*:/i.test(body)) return { ok: false, reason: 'placeholder' };
  if (/\blorem ipsum\b/i.test(body)) return { ok: false, reason: 'placeholder' };
  const bracketed = body.match(/\[[^\]\n]{1,120}\]/g) ?? [];
  if (bracketed.some((seg) => PLACEHOLDER_WORD_RE.test(seg))) return { ok: false, reason: 'placeholder' };
  if (body.toLowerCase() === 'generated promo content') return { ok: false, reason: 'placeholder' };
  return { ok: true, reason: null };
}

/** Looser detector for confirm-card warnings: refused OR any bracket/template mark. */
export function looksTemplated(raw) {
  const body = outboundBody(raw);
  if (!validateOutboundText(raw).ok) return true;
  return /\[[^\]\n]+\]|\{\{[^}\n]+\}\}/.test(body);
}

export async function executeBroadcastToGroups(text, groups) {
  const check = validateOutboundText(text);
  if (!check.ok) {
    try { await auditMoney('broadcast', '', 'outbound_text_refused', `reason=${check.reason} len=${String(text ?? '').length}`); } catch { /* record is best-effort; refusal stands */ }
    return { sent: 0, failed: 0, skipped: 0, total: 0, outcomes: [], retired: [], refused: true, refuseReason: check.reason };
  }
  const result = await runGroupBroadcast(groups, (g) => api.sendMessage({
    chat_id: g.chatId,
    text: `📢 PoorBoyAI Announcement\n\n${text}`.slice(0, 4000),
    reply_markup: GROUP_BROADCAST_STOP_KEYBOARD,
  }));
  await saveBroadcastLog(result);
  return result;
}

/**
 * One send pass over a group list with per-group outcomes. sendOne(group)
 * performs the actual send (text, photo, or blast variant) and throws on
 * failure. Returns { sent, failed, skipped, total, outcomes, retired } —
 * total is the known-groups row count (the universe); skipped counts
 * groups already retired before this run. Failures are audit-logged with
 * the real error; terminal failures retire the group (marker + audit row).
 */
async function runGroupBroadcast(groups, sendOne) {
  let sent = 0, failed = 0, skipped = 0;
  const outcomes = [];
  const retired = [];
  for (const g of groups) {
    const chatId = g.chatId;
    const title = g.title ?? '';
    if (await isGroupBroadcastInactive(chatId).catch(() => false)) {
      skipped++;
      outcomes.push({ chatId, title, status: 'skipped', error: null, errorCode: null, retired: false });
      continue;
    }
    try {
      await sendOne(g);
      sent++;
      outcomes.push({ chatId, title, status: 'sent', error: null, errorCode: null, retired: false });
    } catch (err) {
      failed++;
      const error = broadcastErrorText(err);
      const code = err?.code ?? null;
      const terminal = classifyGroupSendError(err) === 'terminal';
      await auditMoney('broadcast', '', 'group_send_failed',
        `chat=${chatId} title=${title} code=${code ?? ''} error=${error}`);
      let didRetire = false;
      if (terminal) {
        didRetire = await retireBroadcastGroup({ chatId, title, error, code });
        if (didRetire) retired.push({ chatId, title, error, errorCode: code });
      }
      outcomes.push({ chatId, title, status: 'failed', error, errorCode: code, retired: didRetire });
    }
  }
  return { sent, failed, skipped, total: groups.length, outcomes, retired };
}

/** Persist the last run's full outcome list (existing config store, capped). */
async function saveBroadcastLog(result) {
  try {
    await setConfig('broadcast_last_log', JSON.stringify({
      at: new Date().toISOString(),
      sent: result.sent, failed: result.failed, skipped: result.skipped, total: result.total,
      outcomes: (result.outcomes ?? []).slice(0, 200),
      retired: result.retired ?? [],
    }));
  } catch { /* the receipt + audit rows already carry the run */ }
}

/** The broadcast receipt — the system's own words for a finished broadcast.
 *  Shared by /broadcast and the plain-English path so both report the
 *  identical counts in the identical format. Failed groups list their REAL
 *  Telegram errors; the old static "(bot removed or no send rights)"
 *  label is gone — a failure with no recorded reason says so nowhere,
 *  because every failure is now recorded. */
export function broadcastReceiptText(result) {
  if (result?.refused) {
    return '⛔ Broadcast refused — nothing sent.\n\n' +
      `Reason: ${result.refuseReason === 'empty' ? 'the announcement text was empty' : 'the text looks like a placeholder'}. ` +
      'Fix the text and confirm again.';
  }
  const { sent, failed, total } = result;
  const skipped = result.skipped ?? 0;
  const retired = result.retired ?? [];
  const lines = [
    '✅ Broadcast complete',
    '',
    `📤 Sent: ${sent}`,
    `❌ Failed: ${failed}`,
    `👥 Total groups: ${total}`,
  ];
  if (skipped) lines.push(`⏭️ Skipped (previously retired): ${skipped}`);
  if (retired.length) lines.push(`🗑️ Newly retired: ${retired.length}`);
  const failures = (result.outcomes ?? []).filter((o) => o.status === 'failed');
  if (failures.length) {
    lines.push('', 'Failed groups:');
    const shown = failures.slice(0, 25);
    for (const f of shown) {
      lines.push(`• ${f.title || 'Untitled'} (${f.chatId}): ${f.error}${f.retired ? ' [retired]' : ''}`);
    }
    if (failures.length > shown.length) lines.push(`…and ${failures.length - shown.length} more failures — full list in the broadcast log.`);
  }
  return lines.join('\n');
}

/**
 * Run a broadcast: one send per known group; a failure in one group never
 * stops the rest. Returns the true counts plus per-group outcomes
 * { sent, failed, skipped, total, outcomes, retired }. Throws only when
 * the group list itself cannot be read. Callers: the /broadcast command
 * (immediate) and lib/nlcmd.js (after its mandatory confirm step).
 */
export async function executeBroadcast(text) {
  const check = validateOutboundText(text);
  if (!check.ok) {
    try { await auditMoney('broadcast', '', 'outbound_text_refused', `reason=${check.reason} len=${String(text ?? '').length}`); } catch { /* record is best-effort; refusal stands */ }
    return { sent: 0, failed: 0, skipped: 0, total: 0, outcomes: [], retired: [], refused: true, refuseReason: check.reason };
  }
  const groups = await listKnownGroups();
  const result = await runGroupBroadcast(groups, (g) => api.sendMessage({
    chat_id: g.chatId,
    text: `📢 PoorBoyAI Announcement\n\n${text}`.slice(0, 4000),
    reply_markup: GROUP_BROADCAST_STOP_KEYBOARD,
  }));
  await saveBroadcastLog(result);
  return result;
}

/**
 * Photo variant of executeBroadcast (PB Announce wave, 2026-10-22): one
 * sendPhoto per known group with the announcement as the caption (photo
 * captions cap at 1024 chars). `photo` is an InputFile (fresh bytes) or a
 * Telegram file_id string (an already-uploaded visual). Same contract:
 * per-group failures never stop the rest; returns
 * { sent, failed, skipped, total, outcomes, retired }.
 * Placeholder guard (W2, 2026-10-30): a non-empty caption that fails
 * validateOutboundText returns the text path's refusal shape instead
 * ({ refused: true, refuseReason }) and sends nothing; a null/empty/
 * whitespace-only caption is photo-only and sends unchanged.
 */
export async function executePhotoBroadcast(photo, caption) {
  // Photo-broadcast placeholder guard (W2, 2026-10-30): mirror the text
  // path's shared validator. A caption carrying non-whitespace text that
  // fails validation sends NOTHING and returns the text path's exact
  // refusal shape; the audit row is the same shape too. A null/empty/
  // whitespace-only caption is NOT text — the photo itself is the
  // content — so it passes through to the unchanged sendPhoto call below.
  // Validation runs on the full caption before the 1024 slice, exactly
  // as the text path validates before slicing to 4000.
  if (String(caption ?? '').trim() !== '') {
    const check = validateOutboundText(caption);
    if (!check.ok) {
      try { await auditMoney('broadcast', '', 'outbound_text_refused', `reason=${check.reason} len=${String(caption ?? '').length}`); } catch { /* record is best-effort; refusal stands */ }
      return { sent: 0, failed: 0, skipped: 0, total: 0, outcomes: [], retired: [], refused: true, refuseReason: check.reason };
    }
  }
  const groups = await listKnownGroups();
  const result = await runGroupBroadcast(groups, (g) => api.sendPhoto({
    chat_id: g.chatId,
    photo,
    caption: String(caption ?? '').slice(0, 1024),
    reply_markup: GROUP_BROADCAST_STOP_KEYBOARD,
  }));
  await saveBroadcastLog(result);
  return result;
}

export const BROADCAST_COMMANDS = {
  broadcast: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    let owner = false;
    try { owner = !!fromId && (await isOwnerId(fromId)); } catch { owner = false; }
    if (!owner) {
      await sendSafe(chatId, 'Owner only.');
      return;
    }

    const text = String(args ?? '').trim();
    if (!text) {
      await sendSafe(chatId,
        '📡 Broadcast Usage\n\n' +
        'Text:\n/broadcast Your message here\n\n' +
        'Sends your message to every group the bot serves.');
      return;
    }

    // Fix 1 (2026-10-29): /broadcast no longer sends immediately. Show
    // the exact prefixed text + the active target list first; the
    // callback branch executes it only on Confirm. The plain-English
    // path (lib/nlcmd.js) is untouched — it still calls executeBroadcast
    // directly after its own Send/Edit/Cancel confirm.
    let known, targets;
    try {
      known = await listKnownGroups();
      targets = await listBroadcastTargets();
    } catch (err) {
      await sendSafe(chatId, `❌ DB error fetching groups: ${String(err?.message ?? err)}`);
      return;
    }

    if (!known.length) {
      await sendSafe(chatId,
        '⚠️ No known groups yet. Groups appear here once the bot is added and active in them.');
      return;
    }
    if (!targets.length) {
      await sendSafe(chatId,
        '⚠️ All known groups are currently inactive (bot removed or retired) — nothing to send to.');
      return;
    }

    await requestBroadcastPreview(chatId, fromId, {
      kind: 'broadcast',
      text,
      displayText: `📢 PoorBoyAI Announcement\n\n${text}`.slice(0, 4000),
      targets: targets.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
    });
  },
};

// ══ DM broadcast (owner) — restored 2026-10-21 ══════════════════════════════
//
// The original Replit bot's broadcast DMed every bot_users row; the
// serverless port re-targeted /broadcast at groups (see PORT DEVIATIONS
// above). This section restores the DM mode as its own first-class path —
// it does NOT change the group broadcast: /dmbroadcast + the plain-English
// dm_broadcast intent create a persistent job (recipients snapshotted from
// bot_users at creation), and the tick's dmBroadcast cycle works the job in
// time-boxed chunks. Per-recipient state lives in dm_broadcast_recipients;
// a row is claimed with the codebase's conditional-update + verify idiom
// (status + attempts + a unique claim token), so overlapping tick runs can
// never send the same user twice. Blocked / deactivated / never-started
// users are permanent failures and are never retried; transient errors are
// retried up to DM_BROADCAST_MAX_ATTEMPTS claims; a Telegram 429 hands the
// claim straight back and ends the pass. On completion (or /dmstop) the
// owner gets ONE receipt DM with the true counts, mirrored into PB's
// memory with the [system] label exactly like the group receipt.

export const DM_BROADCAST_MAX_ATTEMPTS = 3;
const DM_BROADCAST_CHUNK_MS = 20000; // per-cycle time box (invoke cap ~30s)
const DM_CLAIM_STALE_MS = 10 * 60 * 1000; // a 'sending' claim older than this is dead

const nowDate = () => new Date();

function dmClaimToken() {
  return `c${Date.now().toString(36)}.${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function dmClaimAgeMs(token) {
  const ms = parseInt(String(token ?? '').split('.')[0].slice(1), 36);
  return Number.isFinite(ms) ? Date.now() - ms : Infinity;
}

/** Classify a BotApiError from a DM send. */
export function classifyDmSendError(err) {
  const code = err?.code;
  const desc = String(err?.description ?? err?.message ?? '');
  if (code === 429) return 'rate';
  if (code === 403) return 'permanent'; // bot blocked by the user
  if (code === 400 && /deactivated|chat not found|user not found|bot was blocked|user is deactivated/i.test(desc)) return 'permanent';
  if (code === 400 && /parse entities|can'?t parse/i.test(desc)) return 'parse';
  return 'retryable';
}

const dmDefaultSend = (chatId, text, extra = {}) =>
  api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });

/**
 * One DM delivery attempt. Markdown first (announcements are authored in
 * legacy Markdown); if Telegram rejects the formatting, deliver the same
 * visible text as plain text — delivery beats markup. Never throws.
 */
async function dmDeliver(sendMessage, chatId, text) {
  try {
    await sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    return { ok: true };
  } catch (err) {
    const cls = classifyDmSendError(err);
    if (cls !== 'parse') return { ok: false, cls, err };
    try {
      await sendMessage(chatId, text, { disable_web_page_preview: true });
      return { ok: true, plain: true };
    } catch (err2) {
      return { ok: false, cls: classifyDmSendError(err2), err: err2 };
    }
  }
}

/** The currently running DM broadcast job (oldest first), or null. */
export async function getRunningDmJob() {
  return db.select().from(dm_broadcast_jobs)
    .where(eq(dm_broadcast_jobs.status, 'running'))
    .orderBy(asc(dm_broadcast_jobs.id)).get().catch(() => null);
}

/** Live recipient counts for a job, straight from the recipient rows. */
export async function dmJobCounts(jobId) {
  const rows = await db.select({ status: dm_broadcast_recipients.status })
    .from(dm_broadcast_recipients).where(eq(dm_broadcast_recipients.jobId, jobId)).all();
  const counts = { total: rows.length, sent: 0, failed: 0, queued: 0, sending: 0 };
  for (const r of rows) { if (counts[r.status] !== undefined) counts[r.status]++; }
  return counts;
}

/** The DM broadcast receipt — the system's own words, mirroring the group
 *  receipt's shape so the owner reads both the same way. */
export function dmBroadcastReceiptText({ sent, failed, total, jobId, stopped = false, remaining = 0 }) {
  const head = stopped ? '🛑 DM broadcast stopped' : '✅ DM broadcast complete';
  const lines = [
    head,
    '',
    `📤 Sent: ${sent}`,
    `❌ Failed: ${failed} (blocked, deactivated, or never started)`,
    `👥 Total users: ${total}`,
    `🆔 Job #${jobId}`,
  ];
  if (stopped) lines.push(`⏳ Not sent (stopped first): ${remaining}`);
  return lines.join('\n');
}

// ══ DM broadcast opt-out (2026-10-30) ════════════════════════════════
// Store: user_settings.notifications.broadcast (false = opted out),
// mirroring setDigestPref's digest flag in lib/digest.js — the tree's
// general per-user preference store, no schema change, no second store.
// NOT raid_alert_preferences (raid alerts are a different audience) and
// NOT the outreach decline rows (per-prospect KV, not a user preference).
// Opt-out applies at job creation only: an in-flight job finishes exactly
// as snapshotted; the next job skips the opted-out user. Reversible via
// the resubscribe button the handler sends with the confirmation DM.

/** True when this user opted out of PB DM broadcasts/ads. */
export async function isDmBroadcastOptedOut(userId) {
  try {
    const row = await db.select().from(user_settings)
      .where(eq(user_settings.telegramUserId, String(userId))).get();
    return row?.notifications?.broadcast === false;
  } catch { return false; }
}

/** Set (true) or clear (false) the DM-broadcast opt-out, preserving all
 *  other notification flags on the row (digest, etc.). Never deletes. */
export async function setDmBroadcastOptedOut(userId, optedOut) {
  const existing = await db.select().from(user_settings)
    .where(eq(user_settings.telegramUserId, String(userId))).get().catch(() => null);
  const notifications = { ...(existing?.notifications ?? {}), broadcast: !optedOut };
  await db.insert(user_settings)
    .values({
      telegramUserId: String(userId),
      shillStyle: existing?.shillStyle ?? 'hype',
      notifications,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: user_settings.telegramUserId,
      set: { notifications, updatedAt: new Date() },
    }).run();
  return { optedOut: !!optedOut };
}

/** Drop opted-out ids from a snapshot. On a read error returns ids
 *  unchanged (fail-open, matching isGroupBroadcastInactive's unreadable
 *  = active discipline) so a transient blip never drops a whole blast. */
export async function filterDmBroadcastOptOuts(ids) {
  const list = [...new Set((ids ?? []).map(String).filter(Boolean))];
  if (!list.length) return list;
  try {
    const rows = await db.select({ telegramUserId: user_settings.telegramUserId, notifications: user_settings.notifications })
      .from(user_settings).where(inArray(user_settings.telegramUserId, list)).all();
    const out = new Set(rows.filter((r) => r?.notifications?.broadcast === false)
      .map((r) => String(r.telegramUserId)));
    return list.filter((id) => !out.has(id));
  } catch { return list; }
}

// ══ DM opt-in prompts (2026-11-07) ═══════════════════════════════════════
// Consent-first DM opt-ins: a member taps a deep link in a group flow
// (?start=dm_optin_<source>) which opens their DM with PB; the /start
// branch records the opt-in here and confirms in DM. Store: the same
// user_settings.notifications JSON as the opt-out above — no schema
// change, no second store. A tap is fresh explicit consent, so recording
// also clears a prior opt-out (broadcast false → true), exactly like the
// resubscribe button. Pure helpers are pinned by scratch
// harness-dm-optin.mjs (10/10); the wave pasted them verbatim.
export const DM_OPTIN_SOURCES = ['vote', 'trending', 'email'];
export const DM_OPTIN_BOT = 'PoorBoyAI_bot';

export function dmOptinDeepLink(source) {
  return `https://t.me/${DM_OPTIN_BOT}?start=dm_optin_${source}`;
}

export function dmOptinPromptLine(source) {
  switch (source) {
    case 'vote':
      return `📬 Want PB announcements in your DMs? Tap to let PB DM you — big drops, raids, and product news, only when there's something real to say. You can stop it anytime with one tap. ${dmOptinDeepLink('vote')}`;
    case 'trending':
      return `📬 Want the movers + PB announcements in your DMs? Tap to let PB DM you — only when there's something real to say. You can stop it anytime with one tap. ${dmOptinDeepLink('trending')}`;
    case 'email':
      return `📬 Want PB announcements in your DMs too? Tap to let PB DM you — big drops, raids, and product news, only when there's something real to say. You can stop it anytime with one tap. ${dmOptinDeepLink('email')}`;
    default:
      return null;
  }
}

/** Parse a /start payload. Returns the source, or null for anything else — the caller falls through to the generic welcome and records NOTHING. */
export function parseDmOptinPayload(payload) {
  const m = /^dm_optin_(vote|trending|email)$/.exec(String(payload ?? '').trim());
  return m ? m[1] : null;
}

/** True when the prompt should show: the member has NOT already opted in. Fail-open — an unreadable row shows the prompt. */
export function shouldShowDmOptinPrompt(notifications) {
  try {
    return notifications?.broadcast !== true;
  } catch { return true; }
}

/** Merge an opt-in into the existing notifications JSON. Preserves every other flag; never deletes. */
export function mergeDmOptinNotifications(existing, source, nowSec) {
  return {
    ...(existing ?? {}),
    broadcast: true,
    broadcast_source: source,
    broadcast_opted_in_at: nowSec,
  };
}

export const DM_OPTIN_CONFIRM_TEXT = `📬 You're in — PB can now DM you announcements: big drops, raids, and product news, only when there's something real to say.\n\nChanged your mind? Tap below to stop.`;

export const DM_OPTIN_STOP_KEYBOARD = {
  inline_keyboard: [[{ text: '🔕 Stop PB DMs', callback_data: 'dm_broadcast_unsubscribe' }]],
};

/** Read a member's notifications JSON for the prompt predicate. Fail-open: null on any error (show the prompt). */
export async function readDmOptinNotifications(userId) {
  try {
    const row = await db.select().from(user_settings)
      .where(eq(user_settings.telegramUserId, String(userId))).get();
    return row?.notifications ?? null;
  } catch { return null; }
}

/** True when this user explicitly opted in to PB DM announcements. */
export async function isDmOptedIn(userId) {
  const notes = await readDmOptinNotifications(userId);
  return notes?.broadcast === true;
}

/** Record an explicit DM opt-in (source-tagged). Preserves all other notification flags and shillStyle; never deletes. A tap is fresh consent, so it also clears a prior opt-out. */
export async function recordDmOptin(userId, source) {
  const nowSec = Math.floor(Date.now() / 1000);
  const existing = await db.select().from(user_settings)
    .where(eq(user_settings.telegramUserId, String(userId))).get().catch(() => null);
  const notifications = mergeDmOptinNotifications(existing?.notifications ?? null, source, nowSec);
  await db.insert(user_settings)
    .values({
      telegramUserId: String(userId),
      shillStyle: existing?.shillStyle ?? 'hype',
      notifications,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: user_settings.telegramUserId,
      set: { notifications, updatedAt: new Date() },
    }).run();
  return { optedIn: true, source, at: nowSec };
}

/**
 * Create a DM broadcast job: snapshot every bot_users id as a queued
 * recipient. Refuses while another job is running (one blast at a time).
 * Returns { job, total } or { error: 'already_running', job }.
 * opts.recipientIds snapshots exactly those ids instead of the whole
 * bot_users table — used by the owner blast variants below (owner
 * excluded; /pbbooster's free-tier subset) and by harnesses.
 * DM opt-outs are filtered out of the snapshot (2026-10-30).
 */
export async function createDmBroadcastJob(text, createdBy, opts = {}) {
  const active = await getRunningDmJob();
  if (active) return { error: 'already_running', job: active };
  let ids;
  if (Array.isArray(opts.recipientIds)) {
    ids = [...new Set(opts.recipientIds.map((u) => String(u ?? '')).filter(Boolean))];
  } else {
    const users = await db.select({ telegramUserId: bot_users.telegramUserId }).from(bot_users).all();
    ids = [...new Set(users.map((u) => String(u.telegramUserId ?? '')).filter(Boolean))];
  }
  ids = await filterDmBroadcastOptOuts(ids);
  const inserted = await db.insert(dm_broadcast_jobs).values({
    text: String(text), status: 'running', total: ids.length, createdBy: String(createdBy),
  }).returning();
  const job = inserted[0];
  for (let i = 0; i < ids.length; i += 200) {
    await db.insert(dm_broadcast_recipients).values(
      ids.slice(i, i + 200).map((tid) => ({ jobId: job.id, telegramUserId: tid, status: 'queued' })),
    ).run();
  }
  // The recipient rows are the truth — if a chunk insert lost rows, the
  // job total follows them, never the other way round.
  const counts = await dmJobCounts(job.id);
  if (counts.total !== job.total) {
    await db.update(dm_broadcast_jobs).set({ total: counts.total, updatedAt: nowDate() })
      .where(eq(dm_broadcast_jobs.id, job.id)).run();
    job.total = counts.total;
  }
  return { job, total: counts.total };
}

/**
 * Create a follow-up job from an earlier DM broadcast: the new job sends
 * the SOURCE job's exact stored text, but only to the users the source
 * job never reached. Seeded rows are the source's non-terminal ones:
 * 'queued' (never claimed, or handed back before delivery — 429 /
 * retryable requeue) plus 'sending' rows whose claim is older than
 * DM_CLAIM_STALE_MS (a dead claim from a killed runner; the send was
 * never confirmed, the same recovery rule cycleDmBroadcast applies).
 * A live 'sending' claim is NOT seeded — its runner may still deliver.
 * Terminal rows (sent / failed) are never re-targeted: users already
 * sent stay sent exactly once, permanent failures stay buried.
 * Returns { job, total, source } or { error, ... }: 'source_not_found'
 * (no such job), 'already_running' (a job — possibly the source — is
 * live), 'nothing_remaining' (nobody left unreached).
 */
export async function createDmFollowupJob(sourceJobId, createdBy) {
  const srcId = Number(sourceJobId);
  if (!Number.isInteger(srcId) || srcId <= 0) return { error: 'source_not_found' };
  const source = await db.select().from(dm_broadcast_jobs)
    .where(eq(dm_broadcast_jobs.id, srcId)).get().catch(() => null);
  if (!source) return { error: 'source_not_found' };
  if (source.status === 'running') return { error: 'already_running', job: source };
  const rows = await db.select({
    telegramUserId: dm_broadcast_recipients.telegramUserId,
    status: dm_broadcast_recipients.status,
    claimToken: dm_broadcast_recipients.claimToken,
  }).from(dm_broadcast_recipients)
    .where(eq(dm_broadcast_recipients.jobId, source.id)).all();
  const ids = [...new Set(rows
    .filter((r) => r.status === 'queued'
      || (r.status === 'sending' && dmClaimAgeMs(r.claimToken) > DM_CLAIM_STALE_MS))
    .map((r) => String(r.telegramUserId ?? '')).filter(Boolean))];
  if (!ids.length) return { error: 'nothing_remaining', source };
  const created = await createDmBroadcastJob(source.text, createdBy, { recipientIds: ids });
  if (created.error) return { ...created, source };
  return { ...created, source };
}

async function setRecip(id, fields) {
  await db.update(dm_broadcast_recipients).set({ ...fields, updatedAt: nowDate() })
    .where(eq(dm_broadcast_recipients.id, id)).run();
}

/**
 * Finalize a job (done or stopped): persist the true counts, claim the
 * receipt exactly once (conditional update + verify, the codebase claim
 * idiom), then DM it to the job's creator and mirror it into PB's memory
 * with the [system] label — the Hard Honesty Rule record, same as the
 * group broadcast receipt.
 */
async function finalizeDmJob(job, finalStatus, sendMessage) {
  const counts = await dmJobCounts(job.id);
  await db.update(dm_broadcast_jobs).set({
    status: finalStatus, sentCount: counts.sent, failedCount: counts.failed,
    finishedAt: nowDate(), updatedAt: nowDate(),
  }).where(and(eq(dm_broadcast_jobs.id, job.id), eq(dm_broadcast_jobs.status, 'running'))).run();
  const after = await db.select().from(dm_broadcast_jobs).where(eq(dm_broadcast_jobs.id, job.id)).get();
  if (!after || after.status !== finalStatus) return { finalized: false, counts }; // another runner did it
  if (after.receiptSent) return { finalized: true, counts, receipt: false }; // receipt already claimed
  await db.update(dm_broadcast_jobs).set({ receiptSent: true })
    .where(and(eq(dm_broadcast_jobs.id, job.id), eq(dm_broadcast_jobs.receiptSent, false))).run();
  const receiptRow = await db.select().from(dm_broadcast_jobs).where(eq(dm_broadcast_jobs.id, job.id)).get();
  if (!receiptRow?.receiptSent) return { finalized: true, counts, receipt: false };
  const receipt = dmBroadcastReceiptText({
    sent: counts.sent, failed: counts.failed, total: counts.total, jobId: job.id,
    stopped: finalStatus === 'stopped', remaining: counts.queued + counts.sending,
  });
  try { await sendMessage(Number(job.createdBy), receipt, {}); } catch { /* receipt is also in the DB row */ }
  try {
    const userKey = await resolveUserKey('telegram', job.createdBy);
    await saveMessage(userKey, 'assistant', `[system] DM broadcast result posted by the system:\n${receipt}`, 'telegram');
  } catch { /* memory write is best-effort */ }
  return { finalized: true, counts, receipt: true };
}

/**
 * Stop the running DM broadcast (owner /dmstop). Queued recipients are
 * never sent; an in-flight claim settles on its own row. Returns the
 * finalize result, or { none: true } when nothing is running.
 */
export async function stopDmBroadcast(deps = {}) {
  const sendMessage = deps.sendMessage ?? dmDefaultSend;
  const job = await getRunningDmJob();
  if (!job) return { none: true };
  return { job, ...(await finalizeDmJob(job, 'stopped', sendMessage)) };
}

/**
 * Tick cycle: work the running job for one time-boxed pass.
 * deps.sendMessage is the harness seam (defaults to the real Bot API).
 */
export async function cycleDmBroadcast(deps = {}) {
  const sendMessage = deps.sendMessage ?? dmDefaultSend;
  const job = await getRunningDmJob();
  if (!job) return { idle: true };

  // Recover claims whose runner died mid-send (isolate killed): a claim
  // older than DM_CLAIM_STALE_MS goes back to the queue; its attempt was
  // already burned at claim time, which is the safe direction.
  const sending = await db.select().from(dm_broadcast_recipients)
    .where(and(eq(dm_broadcast_recipients.jobId, job.id), eq(dm_broadcast_recipients.status, 'sending'))).all();
  let recovered = 0;
  for (const row of sending) {
    if (dmClaimAgeMs(row.claimToken) > DM_CLAIM_STALE_MS) {
      await setRecip(row.id, { status: 'queued', claimToken: null });
      recovered++;
    }
  }

  const claimToken = dmClaimToken();
  const startedAt = Date.now();
  let sent = 0, failed = 0, released = 0, rateHit = false;

  while (Date.now() - startedAt < DM_BROADCAST_CHUNK_MS) {
    const batch = await db.select().from(dm_broadcast_recipients)
      .where(and(eq(dm_broadcast_recipients.jobId, job.id), eq(dm_broadcast_recipients.status, 'queued')))
      .orderBy(asc(dm_broadcast_recipients.id)).limit(10).all();
    if (!batch.length) break;
    for (const row of batch) {
      // Atomic claim: conditional update (status + attempts must still be
      // exactly what we read), then verify the claim token landed. A lost
      // claim means another runner owns this row — skip it silently.
      await db.update(dm_broadcast_recipients)
        .set({ status: 'sending', attempts: row.attempts + 1, claimToken, updatedAt: nowDate() })
        .where(and(
          eq(dm_broadcast_recipients.id, row.id),
          eq(dm_broadcast_recipients.status, 'queued'),
          eq(dm_broadcast_recipients.attempts, row.attempts),
        )).run();
      const claimed = await db.select().from(dm_broadcast_recipients)
        .where(eq(dm_broadcast_recipients.id, row.id)).get();
      if (!claimed || claimed.status !== 'sending' || claimed.claimToken !== claimToken) continue;

      const res = await dmDeliver(sendMessage, Number(row.telegramUserId), job.text);
      if (res.ok) {
        await setRecip(row.id, { status: 'sent', failClass: null, lastError: null, claimToken: null });
        sent++;
      } else if (res.cls === 'rate') {
        // Telegram asked us to slow down: hand the claim back (the attempt
        // stays burned — conservative) and end the pass.
        await setRecip(row.id, { status: 'queued', claimToken: null, lastError: 'rate_limited' });
        released++;
        rateHit = true;
        break;
      } else if (res.cls === 'permanent' || row.attempts + 1 >= DM_BROADCAST_MAX_ATTEMPTS) {
        await setRecip(row.id, {
          status: 'failed',
          failClass: res.cls === 'permanent' ? 'permanent' : 'retryable',
          lastError: String(res.err?.description ?? res.err?.message ?? res.cls).slice(0, 200),
          claimToken: null,
        });
        failed++;
      } else {
        await setRecip(row.id, {
          status: 'queued', claimToken: null,
          lastError: String(res.err?.description ?? res.err?.message ?? res.cls).slice(0, 200),
        });
        released++;
      }
    }
    if (rateHit) break;
  }

  const counts = await dmJobCounts(job.id);
  const out = { job: job.id, sent, failed, released, recovered, remaining: counts.queued + counts.sending };
  if (!rateHit && counts.queued === 0 && counts.sending === 0) {
    const fin = await finalizeDmJob(job, 'done', sendMessage);
    out.done = !!fin.finalized;
    if (fin.counts) { out.sentTotal = fin.counts.sent; out.failedTotal = fin.counts.failed; }
  }
  return out;
}

export const DM_BROADCAST_COMMANDS = {
  dmbroadcast: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    let owner = false;
    try { owner = !!fromId && (await isOwnerId(fromId)); } catch { owner = false; }
    if (!owner) {
      await sendSafe(chatId, 'Owner only.');
      return;
    }
    const text = String(args ?? '').trim();
    const active = await getRunningDmJob().catch(() => null);
    if (!text) {
      const total = await db.$count(bot_users).catch(() => 0);
      await sendSafe(chatId,
        '📨 DM Broadcast Usage\n\n' +
        '/dmbroadcast Your message here\n\n' +
        `DMs your message to every bot user (${total} right now). It sends in batches on PB's clock; you get one receipt DM when it finishes.` +
        (active ? `\n\n⏳ Job #${active.id} is already running — /dmstop halts it.` : ''));
      return;
    }
    // Fix 1 (2026-10-29): no job is created until the owner confirms
    // the preview. The count below is a read-only audience size.
    const total = await db.$count(bot_users).catch(() => 0);
    await requestBroadcastPreview(chatId, fromId, {
      kind: 'dmbroadcast',
      text,
      displayText: text,
      userCount: total,
      targets: [],
    });
  },

  dmstop: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    let owner = false;
    try { owner = !!fromId && (await isOwnerId(fromId)); } catch { owner = false; }
    if (!owner) {
      await sendSafe(chatId, 'Owner only.');
      return;
    }
    const res = await stopDmBroadcast().catch((err) => ({ error: String(err?.message ?? err) }));
    if (res.none) {
      await sendSafe(chatId, 'No DM broadcast is running.');
      return;
    }
    if (res.error) {
      await sendSafe(chatId, `❌ Could not stop the DM broadcast: ${res.error}`);
      return;
    }
    await sendSafe(chatId, `🛑 DM broadcast job #${res.job.id} stopped. The receipt DM has the counts.`);
  },

  dmfollowup: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    let owner = false;
    try { owner = !!fromId && (await isOwnerId(fromId)); } catch { owner = false; }
    if (!owner) {
      await sendSafe(chatId, 'Owner only.');
      return;
    }
    const raw = String(args ?? '').trim();
    if (!raw) {
      const active = await getRunningDmJob().catch(() => null);
      await sendSafe(chatId,
        '📨 DM Follow-Up Usage\n\n' +
        '/dmfollowup <jobId>\n\n' +
        'DMs the same text as an earlier DM broadcast, but ONLY to the users that job never reached (still queued when it stopped). Users already sent or permanently failed are never re-targeted.' +
        (active ? `\n\n⏳ Job #${active.id} is already running — /dmstop halts it.` : ''));
      return;
    }
    // Fix 1 (2026-10-29): preview first, with a READ-ONLY count mirroring
    // createDmFollowupJob's filter (queued, or stale 'sending' claims).
    // The job itself is created only on Confirm, which re-checks all of
    // this and reports the same outcomes if anything changed meanwhile.
    const srcId = Number(raw);
    let source = null;
    if (Number.isInteger(srcId) && srcId > 0) {
      source = await db.select().from(dm_broadcast_jobs)
        .where(eq(dm_broadcast_jobs.id, srcId)).get().catch(() => null);
    }
    if (!source) {
      await sendSafe(chatId, `❌ No DM broadcast job #${raw} exists.`);
      return;
    }
    if (source.status === 'running') {
      await sendSafe(chatId,
        `⏳ Job #${source.id} is already running — one DM broadcast at a time. /dmstop halts it first.`);
      return;
    }
    let remaining = [];
    try {
      const rows = await db.select({
        telegramUserId: dm_broadcast_recipients.telegramUserId,
        status: dm_broadcast_recipients.status,
        claimToken: dm_broadcast_recipients.claimToken,
      }).from(dm_broadcast_recipients)
        .where(eq(dm_broadcast_recipients.jobId, source.id)).all();
      remaining = [...new Set(rows
        .filter((r) => r.status === 'queued'
          || (r.status === 'sending' && dmClaimAgeMs(r.claimToken) > DM_CLAIM_STALE_MS))
        .map((r) => String(r.telegramUserId ?? '')).filter(Boolean))];
    } catch (err) {
      await sendSafe(chatId, `❌ DB error reading the DM follow-up: ${String(err?.message ?? err)}`);
      return;
    }
    if (!remaining.length) {
      await sendSafe(chatId,
        `✅ Job #${source.id} has nobody left unreached — every recipient was already sent or failed. No follow-up needed.`);
      return;
    }
    await requestBroadcastPreview(chatId, fromId, {
      kind: 'dmfollowup',
      text: source.text,
      displayText: source.text,
      userCount: remaining.length,
      sourceJobId: source.id,
      targets: [],
    });
  },
};

// ══ Owner blast variants (E4a restore, 2026-10-21) ════════════════════════
// Source: runBlast + /pbblast /pbnews /pbbuynews (telegram-community-bot.ts
// :20402/:20524/:20555/:20605) and the bespoke /pbbooster (:20655) +
// /airdropblast (:20722) flows. All owner-only; since the W4 refusal
// polish, non-owners get the uniform "🔒 Owner only." line (the source
// returned silently).
// (source parity), no args.
// PORT SHAPE (rides the existing machinery, per the restore brief):
// - Groups leg = every known_groups row (the port's canonical group set —
//   the same adaptation /broadcast already documents), sent RAW: no
//   "📢 PoorBoyAI Announcement" prefix, groups first, like the source.
// - Users leg = a DM broadcast job (createDmBroadcastJob) with an explicit
//   recipient snapshot (owner excluded, as the source's loop excluded
//   them). The job's own completion receipt DM carries the user counts
//   when the tick finishes the leg — the source's single combined
//   completion message becomes start report + groups-leg report + the
//   standard DM receipt.
// - Text only: the source blasted a bundled photo (assets/poorboy.png)
//   with a text fallback; the port has no photo assets, so the fallback
//   shape is the shape.
// - The source auto-DELETED dead user/group rows mid-blast ("cleaned"
//   counts). The port's DM engine marks permanent failures and never
//   deletes bot_users rows; groups get the same treatment via the
//   broadcast_inactive config markers (per-group logging section above) —
//   retired, never deleted — and failures surface in the two receipts.
// Copy is recomposed in the source's shape with current facts only:
// /pbnews is a fresh news blast (the source's was a one-shot historical
// announcement), /pbbuynews drops the source's baked-in "tested live"
// trade claims for the verified cross-chain truth, and /pbbooster speaks
// of the booster as arming — it is built and parked, not live.

const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';

const BUY_CROSS_KEYBOARD = {
  inline_keyboard: [
    [{ text: '🌉 Jumper Exchange (Recommended)', url: `https://jumper.exchange/?toChain=8453&toToken=${PBAI_CA}` }],
    [{ text: '🦑 Squid Router', url: `https://app.squidrouter.com/?chains=1%2C8453&tokens=0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee%2C${PBAI_CA}` }],
    [{ text: '⚡ Li.Fi — 250+ chains & DEXes', url: `https://app.li.fi/?toChain=base&toToken=${PBAI_CA}` }],
    // 2026-10-30: the stop row. Tapping it opts the TAPPER out of PB DM
    // broadcasts/ads (it never edits this post — a group post belongs to
    // everyone, so its buy buttons stay put for all readers).
    [{ text: '🔕 Stop PB DM ads', callback_data: 'dm_broadcast_unsubscribe' }],
  ],
};

const sendMd = (chatId, text, extra = {}) =>
  api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: 'Markdown', ...extra }).catch(() => {});

/** Send one blast message: Markdown first, plain-text fallback (the DM
 *  engine's own delivery discipline, applied to the groups leg). Returns
 *  { ok } or { ok:false, error, errorCode } with the REAL final error so
 *  the shared broadcast helper can log and retire on it. */
async function blastSend(chatId, text, extra = {}) {
  try {
    await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: 'Markdown', ...extra });
    return { ok: true };
  } catch {
    try {
      await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: broadcastErrorText(err2), errorCode: err2?.code ?? null };
    }
  }
}

/**
 * One blast run: start report → groups leg (raw) → users leg (DM job).
 * recipientIds === null means every bot_users row (owner excluded here).
 * Returns { groupsSent, groupsFailed, job } or { error }.
 */
export async function runOwnerBlast({ label, text, fromId, reportChatId, recipientIds = null, groupExtra = {}, startText = null, groupsOverride = null }) {
  // Fix 1 (2026-10-29): the preview-confirm path passes the previewed
  // group snapshot so Confirm sends to exactly the previewed list.
  // Existing callers pass nothing and keep the re-read behavior.
  const groups = groupsOverride ?? await listBroadcastTargets();
  let ids = recipientIds;
  if (!ids) {
    const users = await db.select({ telegramUserId: bot_users.telegramUserId }).from(bot_users).all();
    ids = users.map((u) => String(u.telegramUserId ?? '')).filter(Boolean);
  }
  ids = [...new Set(ids.map(String))].filter((id) => id !== String(fromId));
  await sendMd(reportChatId, typeof startText === 'function'
    ? startText({ userCount: ids.length, groupCount: groups.length })
    : `📡 *${label} blast starting...*\n👥 Users: ${ids.length}\n🏘️ Groups: ${groups.length}\n\n_Sending through one shared queue at a safe pace, groups first._`);
  let groupsSent = 0, groupsFailed = 0;
  const leg = await runGroupBroadcast(groups, async (g) => {
    // 2026-10-30: every blast groups-leg post carries the admin stop
    // button (merged under any keyboard the blast already carries, e.g.
    // the pbbuynews buy keyboard — whose own stop row opts the tapper
    // out of DM ads instead; the two controls are different channels).
    const res = await blastSend(g.chatId, text, withGroupStopButton(groupExtra));
    if (!res.ok) {
      const err = new Error(res.error);
      err.code = res.errorCode;
      err.description = res.error;
      throw err;
    }
  });
  groupsSent = leg.sent;
  groupsFailed = leg.failed;
  const created = await createDmBroadcastJob(text, fromId, { recipientIds: ids });
  if (created.error) {
    await sendMd(reportChatId,
      `⚠️ *${label}: groups leg done* (🏘️ ${groupsSent} sent, ${groupsFailed} failed) — but a DM broadcast job (#${created.job?.id}) is already running, so the users leg was NOT queued. Run the blast again once it lands.`);
    return { groupsSent, groupsFailed, error: created.error };
  }
  await sendMd(reportChatId,
    `✅ *${label} — groups leg complete*\n🏘️ Groups: ${groupsSent} sent${groupsFailed ? ` · ${groupsFailed} failed` : ''}\n👥 Users: DM job #${created.job.id} queued for ${created.total} — its receipt lands here when the leg finishes.`);
  return { groupsSent, groupsFailed, job: created.job };
}

/** Free-tier audience for /pbbooster: canonical free tier (the source's
 *  tier IN ('free','poor') list in its legacy naming; the port's
 *  canonicalTier maps the legacy free names onto 'free'). */
async function freeTierUserIds() {
  const users = await db.select({ telegramUserId: bot_users.telegramUserId, tier: bot_users.tier }).from(bot_users).all();
  return users.filter((u) => canonicalTier(u.tier) === 'free')
    .map((u) => String(u.telegramUserId ?? '')).filter(Boolean);
}

const blastOwnerOnly = async (msg) => {
  try { return !!msg?.from?.id && (await isOwnerId(msg.from.id)); } catch { return false; }
};

export const BLAST_COMMANDS = {
  pbblast: async (chatId, args, msg) => {
    if (!(await blastOwnerOnly(msg))) { await sendSafe(chatId, '🔒 Owner only.'); return; }
    const text = [
      '🤖 *PoorBoyAI — The Crypto Toolkit Degens Actually Use*',
      '',
      'AI chat, live prices, full TA, and a scam scanner in one Telegram bot.',
      '',
      '🔥 *What PB does:*',
      '• /price — live token prices',
      '• /ta — full technical analysis',
      '• /scan — contract safety scan before you ape',
      '• /ask — ask PB anything',
      '• /raid — community raids with XP',
      '• 🛡️ Group protection — auto-mod, anti-spam, flood control',
      '• 🎬 Studio — AI video ads + podcasts',
      '• 📡 PB Relay — consent-based post forwarding between your chats',
      '',
      '💎 *Tiers:* Free · PB Plan $29/mo ($290/yr)',
      '',
      '🤖 @PoorBoyAI_bot',
      '🌐 poorboyai.pages.dev',
    ].join('\n');
    // Fix 1 (2026-10-29): preview first — groups + DM audience snapshot.
    const groups = await listBroadcastTargets();
    const allUsers = await db.select({ telegramUserId: bot_users.telegramUserId }).from(bot_users).all().catch(() => []);
    const recipientIds = [...new Set(allUsers.map((u) => String(u.telegramUserId ?? '')).filter(Boolean))]
      .filter((id) => id !== String(msg.from.id));
    await requestBroadcastPreview(chatId, msg.from.id, {
      kind: 'pbblast', label: 'PB Blast', text, displayText: text,
      targets: groups.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
      userCount: recipientIds.length, recipientIds, startTextKind: 'default',
    });
  },

  pbnews: async (chatId, args, msg) => {
    if (!(await blastOwnerOnly(msg))) { await sendSafe(chatId, '🔒 Owner only.'); return; }
    const text = [
      '📣 *PoorBoyAI News*',
      '',
      'Fresh upgrades just landed in the bot:',
      '',
      '• 📡 *PB Relay is live* — forward posts between your own groups & channels, consent on both sides (/relay)',
      '• 💸 *Pay with SOL* — upgrades now accept USDT, USDC or SOL by transfer',
      '• 🌉 *Buy $PBAI from any chain* — /howtobuy routes you in from 250+ chains',
      '• 🎙️ *Podcast guest seat* — bring your own character onto Crypto Real Talk (/podcast)',
      '• 🛡️ *Group protection restored* — anti-flood (/setflood), goodbye messages (/setgoodbye), support mode (/setsupport)',
      '',
      'More cooking. Stay grinding. 💪',
      '',
      '🤖 @PoorBoyAI_bot',
    ].join('\n');
    // Fix 1 (2026-10-29): preview first — groups + DM audience snapshot.
    const groups = await listBroadcastTargets();
    const allUsers = await db.select({ telegramUserId: bot_users.telegramUserId }).from(bot_users).all().catch(() => []);
    const recipientIds = [...new Set(allUsers.map((u) => String(u.telegramUserId ?? '')).filter(Boolean))]
      .filter((id) => id !== String(msg.from.id));
    await requestBroadcastPreview(chatId, msg.from.id, {
      kind: 'pbnews', label: 'PB News', text, displayText: text,
      targets: groups.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
      userCount: recipientIds.length, recipientIds, startTextKind: 'default',
    });
  },

  pbbuynews: async (chatId, args, msg) => {
    if (!(await blastOwnerOnly(msg))) { await sendSafe(chatId, '🔒 Owner only.'); return; }
    const text = [
      '💰 *Buy $PBAI From ANY Chain*',
      '',
      'Got funds on Ethereum, Solana, Arbitrum or anywhere else? You can buy $PBAI on Base without moving anything first.',
      '',
      '🌉 /howtobuy walks you through it — Jumper, Squid and Li.Fi route your swap straight into $PBAI on Base. The swap runs on the aggregator\'s own site and $PBAI lands in your wallet on Base — PB never touches your funds.',
      '',
      `📋 Base CA: \`${PBAI_CA}\``,
      '🌐 Full buy page: https://poorboyai.pages.dev/buy',
      '',
      'Tap a button below to start 👇',
    ].join('\n');
    // Fix 1 (2026-10-29): preview first — groups + DM audience snapshot.
    const groups = await listBroadcastTargets();
    const allUsers = await db.select({ telegramUserId: bot_users.telegramUserId }).from(bot_users).all().catch(() => []);
    const recipientIds = [...new Set(allUsers.map((u) => String(u.telegramUserId ?? '')).filter(Boolean))]
      .filter((id) => id !== String(msg.from.id));
    await requestBroadcastPreview(chatId, msg.from.id, {
      kind: 'pbbuynews', label: 'PB Buy News', text, displayText: text,
      targets: groups.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
      userCount: recipientIds.length, recipientIds,
      groupExtra: { reply_markup: BUY_CROSS_KEYBOARD }, startTextKind: 'default',
    });
  },

  pbbooster: async (chatId, args, msg) => {
    if (!(await blastOwnerOnly(msg))) { await sendSafe(chatId, '🔒 Owner only.'); return; }
    const freeIds = await freeTierUserIds();
    const text = [
      '🐾 *Pup Booster — Almost Unleashed*',
      '',
      'The Pup Booster is built and in final rollout: campaigns that push your token while you sleep.',
      '',
      '📈 *Volume Mode* — steady, organic-looking volume',
      '⚡ *Bump Mode* — fast visibility pushes',
      '🚀 *MCap Mode* — campaigns aimed at market-cap targets',
      '',
      '💎 *How it works when it arms:*',
      '• Fund with your own ETH / SOL / USDG',
      '• 15% service fee · 30-minute deposit window',
      '• Campaigns start automatically once your deposit lands',
      '• Unused funds (minus fee + gas) return to you',
      '',
      'Existing campaigns are safe and first in line. The launch announcement lands here the moment it arms. 🐶',
      '',
      '👉 /boost in a DM to see your campaigns',
      '🌐 poorboyai.pages.dev',
    ].join('\n');
    // Fix 1 (2026-10-29): preview first — groups + free-tier DM snapshot
    // (owner excluded, exactly as runOwnerBlast filters).
    const groups = await listBroadcastTargets();
    const recipientIds = [...new Set(freeIds.map(String).filter(Boolean))]
      .filter((id) => id !== String(msg.from.id));
    await requestBroadcastPreview(chatId, msg.from.id, {
      kind: 'pbbooster', label: 'Booster Pup', text, displayText: text,
      targets: groups.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
      userCount: recipientIds.length, recipientIds, startTextKind: 'booster',
    });
  },

  airdropblast: async (chatId, args, msg) => {
    if (!(await blastOwnerOnly(msg))) { await sendSafe(chatId, '🔒 Owner only.'); return; }
    let holders = 301; // the source's own fallback when the count read fails
    let wallets = 0;
    try { holders = (await db.select().from(pbai_holder_wallets).all()).length || holders; } catch { /* fallback */ }
    try { wallets = (await db.select().from(user_wallets).all()).length; } catch { /* 0 */ }
    const text = [
      '🪂 *$PBAI Airdrop — Are You On the List?*',
      '',
      `We're rewarding the PoorBoy Army. *${holders} holders* are already in and *${wallets} wallets* are registered.`,
      '',
      '📌 To claim your share you MUST register a wallet:',
      '👉 Run /mywallet in a DM with @PoorBoyAI_bot and save your Base address.',
      '',
      'No wallet registered = no airdrop. Don\'t miss out.',
      '',
      '🤖 @PoorBoyAI_bot',
    ].join('\n');
    // Fix 1 (2026-10-29): preview first — groups + DM audience snapshot.
    const groups = await listBroadcastTargets();
    const allUsers = await db.select({ telegramUserId: bot_users.telegramUserId }).from(bot_users).all().catch(() => []);
    const recipientIds = [...new Set(allUsers.map((u) => String(u.telegramUserId ?? '')).filter(Boolean))]
      .filter((id) => id !== String(msg.from.id));
    await requestBroadcastPreview(chatId, msg.from.id, {
      kind: 'airdropblast', label: 'Airdrop Blast', text, displayText: text,
      targets: groups.map((g) => ({ chatId: g.chatId, title: g.title ?? null })),
      userCount: recipientIds.length, recipientIds, startTextKind: 'airdrop',
    });
  },
};

// ══ Outreach — OUTREACH_OFF kill switch + one-send-ever + Accept/Decline (overnight build, 2026-10-25) ══
// Local only, unpushed. Rules (Rowdy, 2026-10-24 + outreach pack):
//   - ONE first message per prospect, EVER. A second attempt for the same
//     prospect is refused by the store, not by discipline: the send is
//     recorded BEFORE the send call (status 'pending'), so a retry or a
//     second tick can never produce a second copy. A failed send clears
//     'pending' so a genuine retry is possible — a failed send is not a
//     sent message.
//   - Kill switch: config 'outreach_off' ON refuses every send immediately
//     (registered in lib/config.js so /setkey normalizes it). It stops
//     outreach only, not receiving; it must be wired AND tested (on → zero
//     sends) before the first live run.
//   - Accept / Decline buttons ride the one message (callback prefix
//     'outreach:', routed in handlers/callback_query.js). Accept = follow
//     up on what was accepted (the next step, never a second pitch).
//     Decline = stop, log it, never message that prospect again. A plain
//     text reply counts the same as a button tap: outreachNoteReply()
//     marks the prospect 'replied', which ends the first-message sequence
//     — the one-send-ever store then refuses any further first message
//     regardless of which surface the reply arrived on.
//   - Silence is a stop: no reply → no chase, no follow-up pitch, ever.
//   - Delivery limit (Telegram Bot API, not a PB rule): a bot CANNOT
//     cold-DM a prospect who never started PB. outreachTrySend() does not
//     and cannot fix that — a prospect with no prior PB start simply
//     fails the send, and the failure is recorded, not retried into spam.
//     The first-contact route for a brand-new prospect (group PB is in,
//     or a link they tap to start PB) must be settled before any live run;
//     this code assumes the caller already resolved it.
//   - State lives in the existing config table (outreach:<prospectKey>
//     JSON + outreach_log:<prospectKey> JSON lines via the log store), so
//     this build needs NO schema change and NO migrate. prospectKey is a
//     public contact identifier only (public group/channel username or a
//     chat id the prospect already shared) — never a private address.
//   - Daily cap (proposed in the pack, 3/day) is enforced by the CALLER's
//     run loop counting today's 'sent' records, not hidden in this module:
//     outreachCountSentToday() is the counter the loop must check before
//     each send. The cap is a hard stop, not a target.

const outreachKey = (prospectKey) => `outreach:${String(prospectKey)}`;

function defaultOutreachStore() {
  return {
    get: async (prospectKey) => {
      const raw = await getConfig(outreachKey(prospectKey), null).catch(() => null);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    set: async (prospectKey, record) => {
      await setConfig(outreachKey(prospectKey), JSON.stringify(record));
    },
    log: async (prospectKey, entry) => {
      const raw = await getConfig(`outreach_log:${prospectKey}`, '[]').catch(() => '[]');
      let arr = [];
      try { arr = JSON.parse(raw) || []; } catch { arr = []; }
      arr.push({ at: new Date().toISOString(), ...entry });
      await setConfig(`outreach_log:${prospectKey}`, JSON.stringify(arr.slice(-50)));
    },
  };
}

export async function outreachKillOn(deps = {}) {
  const getFlag = deps.getFlag ?? getConfigFlag;
  try { return await getFlag('outreach_off'); } catch { return false; }
}

export async function outreachCountSentToday(store, nowMs = Date.now()) {
  // The config-key store has no list operation, so the caller keeps its
  // own per-day counter (deps.dayCounter) in production; the harness
  // store implements listToday(). Absent either, fail closed to 0 sent
  // is WRONG — so absent a counter, return null (unknown) and the caller
  // must refuse to send. Never guess a cap count.
  if (store && typeof store.listToday === 'function') {
    try { return await store.listToday(nowMs); } catch { return null; }
  }
  if (store && typeof store.dayCount === 'function') {
    try { return await store.dayCount(nowMs); } catch { return null; }
  }
  return null;
}

/**
 * Attempt ONE outreach first message. deps: { store, send, killOn, mailbox }.
 * send(chatId, text, buttons) must return truthy on delivery.
 * verification: the contact-gate input for this prospect (verdict + source)
 * — logged with the send attempt BEFORE anything goes out, so the log
 * proves what was sent to whom under which verdict. The message text in
 * this log is PB's own outbound draft, sealed per prospect — never a
 * community member's message (the seal rule covers their content, not
 * PB's own words).
 * Returns { ok, status, reason? } — a second attempt is refused, never sent.
 * A stop (decline / opt-out / no-interest / reply) that lands while the
 * send is in flight wins: the terminal status is never overwritten by
 * the delivery, so the prospect can never be followed up afterwards.
 */
export async function outreachTrySend({ prospectKey, chatId, text, buttons, verification }, deps = {}) {
  const store = deps.store ?? defaultOutreachStore();
  const send = deps.send ?? sendSafe;
  const killOn = deps.killOn ?? (() => outreachKillOn(deps));
  if (await killOn()) return { ok: false, status: 'refused', reason: 'outreach_off' };
  if (!prospectKey || !chatId || !String(text ?? '').trim()) return { ok: false, status: 'refused', reason: 'bad_request' };
  const existing = await store.get(prospectKey).catch(() => null);
  if (existing && existing.status === 'sent') return { ok: false, status: 'refused', reason: 'already_sent' };
  if (existing && existing.status === 'pending') return { ok: false, status: 'refused', reason: 'send_in_flight' };
  if (existing && ['declined', 'accepted', 'replied', 'opted_out', 'no_interest'].includes(existing.status)) {
    return { ok: false, status: 'refused', reason: `prospect_${existing.status}` };
  }
  await store.set(prospectKey, { status: 'pending', chatId: String(chatId), at: new Date().toISOString() }).catch(() => {});
  // Send log FIRST: prospect + message + verification verdict, before the
  // send call. A candidate send that is not logged here never goes out.
  await store.log(prospectKey, { event: 'send_attempt', message: text, verification: verification ?? null }).catch(() => {});
  let delivered = null;
  try { delivered = await send(chatId, text, buttons); } catch { delivered = null; }
  if (!delivered) {
    await store.set(prospectKey, { status: 'failed', chatId: String(chatId), at: new Date().toISOString() }).catch(() => {});
    await store.log(prospectKey, { event: 'send_failed' }).catch(() => {});
    return { ok: false, status: 'refused', reason: 'send_failed' };
  }
  // A stop landing mid-flight wins over the delivery: never overwrite a
  // terminal status with 'sent', or the prospect could be followed up.
  const after = await store.get(prospectKey).catch(() => null);
  if (after && ['declined', 'accepted', 'replied', 'opted_out', 'no_interest'].includes(after.status)) {
    await store.log(prospectKey, { event: 'sent_after_stop', priorStatus: after.status }).catch(() => {});
    if (deps.mailbox?.id) await outreachMailboxRecordSend(deps.mailbox.id, deps.mailbox.store).catch(() => {});
    return { ok: true, status: 'sent_after_stop' };
  }
  await store.set(prospectKey, { status: 'sent', chatId: String(chatId), at: new Date().toISOString(), messageId: delivered?.message_id ?? null }).catch(() => {});
  await store.log(prospectKey, { event: 'sent' }).catch(() => {});
  if (deps.mailbox?.id) await outreachMailboxRecordSend(deps.mailbox.id, deps.mailbox.store).catch(() => {});
  return { ok: true, status: 'sent' };
}

/** Mark a prospect as replied (text reply or any follow-up) — ends the sequence. */
export async function outreachNoteReply(prospectKey, deps = {}) {
  const store = deps.store ?? defaultOutreachStore();
  const existing = await store.get(prospectKey).catch(() => null);
  if (!existing) return { ok: false, reason: 'unknown_prospect' };
  if (['declined', 'accepted', 'opted_out', 'no_interest'].includes(existing.status)) return { ok: true, status: existing.status };
  await store.set(prospectKey, { ...existing, status: 'replied', at: new Date().toISOString() }).catch(() => {});
  await store.log(prospectKey, { event: 'replied' }).catch(() => {});
  return { ok: true, status: 'replied' };
}

/**
 * Production caller for outreach first messages (Wave 2, 2026-10-26).
 * NOT wired into any tick cycle or user command — it runs only when a
 * future wave explicitly calls it, and every gate below fails closed, so
 * wiring it alone can never produce a send:
 *  1. Kill switch on → refuse all (re-checked per prospect).
 *  2. Cap unconfirmed (cap not a finite integer > 0) → refuse all. The
 *     pack's proposed 3/day is NOT a default; Rowdy confirms the cap.
 *  3. Day count unknown (no dayCounter and no store listToday/dayCount)
 *     → refuse all. Never guess a cap count.
 *  4. Day count + sends-this-run >= cap → remaining prospects skipped
 *     with reason 'cap_reached' (hard stop, not a target).
 *  5. Contact gate (outreachCheckContact, mandatory — no legacy boolean):
 *     verdict must be deliverable/valid AND source must be public_link.
 *     A verified-but-guessed contact is refused ('contact_guessed'):
 *     verification proves an address exists, it does not make it a
 *     permitted target. PB has no verified-contact source today — this
 *     gate alone holds every send until one exists.
 *  6. Mailbox gate: the run must name its sending mailbox
 *     (deps.mailboxId or deps.mailboxIds) and it must not be paused.
 *     No mailbox configured → refuse all ('no_mailbox'): the engine
 *     never falls back to an implicit identity, and Rowdy's own domain
 *     or mailbox is never the silent default.
 *  7. One-send-ever enforced by outreachTrySend's store (pending/sent/
 *     declined/accepted/replied/opted_out/no_interest all refuse); a
 *     failed send clears to 'failed' so only genuine retries are
 *     possible, and this caller never retries within a run.
 * deps: { store, send, killOn, dayCounter, cap, dryRun,
 *         mailboxId, mailboxIds, mailboxStore }.
 * cap: an explicit positive integer, or — when deps.cap is undefined —
 * the owner-confirmed config value outreach_daily_cap (either case).
 * The pack's proposed 3/day is NOT a default; no code path invents one.
 * dryRun: gate-checks everything but never calls send and never writes
 * prospect or mailbox records — returns the would-send list only.
 * Returns { ok, sent: [{prospectKey, dryRun?}], skipped: [{prospectKey, reason}] }.
 */
export async function outreachCallerRun(prospects, deps = {}) {
  const store = deps.store ?? defaultOutreachStore();
  const killOn = deps.killOn ?? (() => outreachKillOn(deps));
  if (await killOn()) return { ok: false, status: 'refused', reason: 'outreach_off', sent: [], skipped: [] };
  const cap = await outreachResolveCap(deps);
  if (cap === null) return { ok: false, status: 'refused', reason: 'cap_unconfirmed', sent: [], skipped: [] };
  let dayCount = null;
  if (typeof deps.dayCounter === 'function') {
    try { dayCount = await deps.dayCounter(Date.now()); } catch { dayCount = null; }
  } else {
    dayCount = await outreachCountSentToday(store, Date.now());
  }
  if (!Number.isInteger(dayCount) || dayCount < 0) return { ok: false, status: 'refused', reason: 'day_count_unknown', sent: [], skipped: [] };
  const mailboxStore = deps.mailboxStore ?? defaultOutreachMailboxStore();
  const gate = await outreachGateMailbox({ mailboxIds: deps.mailboxIds, mailboxId: deps.mailboxId, mailboxStore });
  if (!gate.ok) return { ok: false, status: 'refused', reason: gate.reason, sent: [], skipped: [] };
  const sent = [];
  const skipped = [];
  for (const p of prospects ?? []) {
    const prospectKey = p?.prospectKey ?? null;
    if (dayCount + sent.length >= cap) { skipped.push({ prospectKey, reason: 'cap_reached' }); continue; }
    const cg = outreachCheckContact(p?.contact);
    if (!cg.ok) { skipped.push({ prospectKey, reason: cg.reason }); continue; }
    if (deps.dryRun) {
      const existing = await store.get(prospectKey).catch(() => null);
      if (existing && ['sent', 'pending', 'declined', 'accepted', 'replied', 'opted_out', 'no_interest'].includes(existing.status)) {
        skipped.push({ prospectKey, reason: `prospect_${existing.status}` });
        continue;
      }
      sent.push({ prospectKey, dryRun: true });
      continue;
    }
    const res = await outreachTrySend(
      { prospectKey, chatId: p.chatId, text: p.text, buttons: p.buttons, verification: p.contact },
      { store, send: deps.send, killOn, mailbox: { id: gate.mailboxId, store: mailboxStore } },
    );
    if (res.ok) sent.push({ prospectKey });
    else skipped.push({ prospectKey, reason: res.reason ?? res.status });
  }
  return { ok: true, sent, skipped };
}

/** Button router for `outreach:*` callbacks. Caller answers the query. */
export async function handleOutreachCallback(query, deps = {}) {
  const data = String(query.data ?? '');
  const store = deps.store ?? defaultOutreachStore();
  const send = deps.send ?? sendSafe;
  const m = /^outreach:(accept|decline):(.+)$/.exec(data);
  if (!m) return null;
  const [, action, prospectKey] = m;
  const existing = await store.get(prospectKey).catch(() => null);
  if (!existing) return { text: 'That outreach message is no longer active.', alert: true };
  if (action === 'decline') {
    await store.set(prospectKey, { ...existing, status: 'declined', at: new Date().toISOString() }).catch(() => {});
    await store.log(prospectKey, { event: 'declined' }).catch(() => {});
    return { text: 'Noted — PB won\u2019t message you again.' };
  }
  if (existing.status === 'accepted') return { text: 'Already accepted — PB will follow up on that, not pitch again.' };
  await store.set(prospectKey, { ...existing, status: 'accepted', at: new Date().toISOString() }).catch(() => {});
  await store.log(prospectKey, { event: 'accepted' }).catch(() => {});
  const chatId = Number(existing.chatId);
  if (Number.isFinite(chatId)) {
    await send(chatId,
      '✅ Thanks for accepting. Next step: open https://poorboyai.pages.dev/buy, pick the tier that fits your community, and add @PoorBoyAI_bot to your group as an admin — PB takes it from there. No second pitch coming; this is the follow-up you asked for.').catch(() => {});
  }
  return { text: 'Thanks — follow-up sent.' };
}

// ══ Outreach engine — message + follow-up engine, SHADOW-ONLY, DARK (2026-10-26) ══
// Spec gap #4 (PB-OUTREACH-SPEC-2026-10-25 §5): send log, kill switch,
// stop-on-reply enforcement, one-first-message guard, bounded follow-ups,
// per-mailbox auto-pause, cap gate. SHADOW-ONLY: no production caller
// exists — nothing in tick.js, handlers/*, or any command imports
// outreachCallerRun, outreachTrySend, or outreachFollowUpRun, and this
// build wires none. The engine can only run when a future wave explicitly
// calls it, and every gate below fails closed, so even then a send needs
// an owner-confirmed cap, a healthy named mailbox, a deliverable contact
// from a public link, and the kill switch OFF.
//   - Follow-ups go ONLY to non-repliers (record status exactly 'sent'),
//     at most OUTREACH_MAX_FOLLOWUPS each, and never add new promises:
//     the caller supplies the text; the engine never generates copy.
//     'accepted' is NOT a follow-up candidate: the callback already sent
//     the accepted next step, and an accepted prospect is never pitched.
//   - A stopped prospect (replied / declined / opted_out / no_interest)
//     is never re-added: every send path refuses those statuses, and a
//     stop that lands mid-flight wins over the delivery (see TrySend).
//   - Mailbox pause isolates: a paused mailbox sends nothing, the other
//     mailboxes carry on, and nothing ever spills onto Rowdy's domain.
//     Recovery is an explicit outreachMailboxRecover call — never
//     automatic, never timed.
//   - The 3% bounce stop line (verification plan §1.4): a mailbox with
//     ≥10 sends whose hard-bounce rate reaches 3% pauses immediately.
//     Any single hard bounce also sets needsReview — a signal to
//     re-check, not a rounding error — without pausing on its own.

export const OUTREACH_MAX_FOLLOWUPS = 2;
export const OUTREACH_BOUNCE_STOP_RATE = 0.03;
export const OUTREACH_BOUNCE_MIN_SENDS = 10;

/**
 * Contact gate — PURE, no store, no I/O. The public-link rule is a gate
 * input, not optional: { verdict, source } must be deliverable/valid
 * from a public link. Anything else is refused, including a verified
 * address from a guessed source ('contact_guessed') and every suppressed
 * verdict (invalid, disposable, spam-trap, role, catch-all, unknown).
 */
export function outreachCheckContact(contact) {
  if (!contact || typeof contact !== 'object') return { ok: false, reason: 'contact_unverified' };
  const verdict = String(contact.verdict ?? '').trim().toLowerCase();
  if (verdict !== 'deliverable' && verdict !== 'valid') return { ok: false, reason: 'contact_unverified' };
  const source = String(contact.source ?? '').trim().toLowerCase();
  if (source !== 'public_link') return { ok: false, reason: 'contact_guessed' };
  return { ok: true };
}

/**
 * Cap gate — resolves the daily send cap or returns null (BLOCKED).
 * An explicit deps.cap wins only when it is a positive integer; an
 * invalid explicit cap blocks rather than falling through to config.
 * Otherwise the owner-confirmed config value outreach_daily_cap is read
 * (both casings — /setkey uppercases what the owner typed). No default
 * exists anywhere in this function: the pack's proposed ~3/day is a
 * proposal, and until Rowdy confirms a cap this returns null and every
 * runner refuses all sends.
 */
export async function outreachResolveCap(deps = {}) {
  if (deps.cap !== undefined) {
    return Number.isInteger(deps.cap) && deps.cap > 0 ? deps.cap : null;
  }
  const get = deps.getConfig ?? getConfig;
  for (const key of ['outreach_daily_cap', 'OUTREACH_DAILY_CAP']) {
    try {
      const raw = await get(key, null);
      if (raw === null || raw === undefined) continue;
      const s = String(raw).trim();
      if (/^\d+$/.test(s) && Number(s) > 0) return Number(s);
    } catch { /* try the other casing */ }
  }
  return null;
}

// ── Per-mailbox health: state lives in the existing config table ──────────
// (outreach_mailbox:<id> JSON), so this needs NO schema change and NO migrate.

const outreachMailboxKey = (mailboxId) => `outreach_mailbox:${String(mailboxId)}`;

function defaultOutreachMailboxStore() {
  return {
    get: async (mailboxId) => {
      const raw = await getConfig(outreachMailboxKey(mailboxId), null).catch(() => null);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    set: async (mailboxId, record) => {
      await setConfig(outreachMailboxKey(mailboxId), JSON.stringify(record));
    },
  };
}

export async function outreachMailboxStatus(mailboxId, mailboxStore) {
  const store = mailboxStore ?? defaultOutreachMailboxStore();
  const rec = await store.get(mailboxId).catch(() => null);
  return rec ?? { status: 'ok', sends: 0, bounces: 0, blocklisted: false, needsReview: false };
}

/** First mailbox in the list that is not paused; no record = healthy. Null when none. */
export async function outreachMailboxPick(mailboxIds, mailboxStore) {
  const store = mailboxStore ?? defaultOutreachMailboxStore();
  for (const id of mailboxIds ?? []) {
    const rec = await store.get(id).catch(() => null);
    if (!rec || rec.status !== 'paused') return id;
  }
  return null;
}

async function outreachMailboxWrite(mailboxId, mailboxStore, patch) {
  const store = mailboxStore ?? defaultOutreachMailboxStore();
  const cur = await store.get(mailboxId).catch(() => null)
    ?? { status: 'ok', sends: 0, bounces: 0, blocklisted: false, needsReview: false };
  const next = { ...cur, ...patch };
  await store.set(mailboxId, next).catch(() => {});
  return next;
}

export async function outreachMailboxRecordSend(mailboxId, mailboxStore) {
  const cur = await outreachMailboxStatus(mailboxId, mailboxStore);
  return outreachMailboxWrite(mailboxId, mailboxStore, { sends: (Number(cur.sends ?? 0) || 0) + 1 });
}

export async function outreachMailboxRecordBounce(mailboxId, mailboxStore) {
  const cur = await outreachMailboxStatus(mailboxId, mailboxStore);
  const bounces = (Number(cur.bounces ?? 0) || 0) + 1;
  const sends = Number(cur.sends ?? 0) || 0;
  const patch = { bounces, needsReview: true };
  if (sends >= OUTREACH_BOUNCE_MIN_SENDS && bounces / sends >= OUTREACH_BOUNCE_STOP_RATE) {
    patch.status = 'paused';
    patch.pausedReason = 'bounce_rate';
    patch.pausedAt = new Date().toISOString();
  }
  return outreachMailboxWrite(mailboxId, mailboxStore, patch);
}

export async function outreachMailboxRecordBlocklist(mailboxId, mailboxStore) {
  return outreachMailboxWrite(mailboxId, mailboxStore, {
    blocklisted: true, status: 'paused', pausedReason: 'blocklisted',
    pausedAt: new Date().toISOString(), needsReview: true,
  });
}

/** Explicit owner recovery only — never automatic. Counters stay as history. */
export async function outreachMailboxRecover(mailboxId, mailboxStore) {
  return outreachMailboxWrite(mailboxId, mailboxStore, {
    status: 'ok', blocklisted: false, needsReview: false, pausedReason: null, pausedAt: null,
  });
}

/**
 * Resolve the run's sending mailbox: a single deps.mailboxId (must not be
 * paused), or the first healthy id in deps.mailboxIds. No mailbox
 * configured → 'no_mailbox': the engine never sends from an implicit
 * identity. All configured mailboxes paused → 'mailbox_paused'.
 */
export async function outreachGateMailbox({ mailboxIds, mailboxId, mailboxStore }) {
  const store = mailboxStore ?? defaultOutreachMailboxStore();
  if (mailboxId) {
    const rec = await store.get(mailboxId).catch(() => null);
    if (rec && rec.status === 'paused') return { ok: false, reason: 'mailbox_paused' };
    return { ok: true, mailboxId };
  }
  if (Array.isArray(mailboxIds) && mailboxIds.length > 0) {
    const picked = await outreachMailboxPick(mailboxIds, store);
    if (!picked) return { ok: false, reason: 'mailbox_paused' };
    return { ok: true, mailboxId: picked };
  }
  return { ok: false, reason: 'no_mailbox' };
}

// ── Permanent stops: a stopped prospect is never re-added ──────────────────

async function outreachNoteTerminalStop(prospectKey, status, event, deps = {}) {
  const store = deps.store ?? defaultOutreachStore();
  const existing = await store.get(prospectKey).catch(() => null);
  if (!existing) return { ok: false, reason: 'unknown_prospect' };
  if (existing.status === status) return { ok: true, status };
  await store.set(prospectKey, { ...existing, status, at: new Date().toISOString() }).catch(() => {});
  await store.log(prospectKey, { event }).catch(() => {});
  return { ok: true, status };
}

/** Opt-out: permanent stop, never messaged again, never re-added. */
export async function outreachNoteOptOut(prospectKey, deps = {}) {
  return outreachNoteTerminalStop(prospectKey, 'opted_out', 'opted_out', deps);
}

/** No-interest reply: permanent stop, never messaged again, never re-added. */
export async function outreachNoteNoInterest(prospectKey, deps = {}) {
  return outreachNoteTerminalStop(prospectKey, 'no_interest', 'no_interest', deps);
}

/**
 * Bounded follow-up runner — same held posture as outreachCallerRun:
 * NOT wired into any tick cycle or command; runs only when a future wave
 * explicitly calls it, and every gate fails closed.
 * Gates, in order: kill switch → cap confirmed → day count known →
 * mailbox healthy → per prospect: record must exist, status exactly
 * 'sent' (non-repliers only — replied/declined/opted_out/no_interest/
 * accepted/pending/failed all skip), followUpCount below
 * OUTREACH_MAX_FOLLOWUPS, cap not reached, mailbox still healthy
 * (re-checked per follow-up so a pause landing mid-run stops the rest).
 * A follow-up attempt is logged (message + follow-up number) BEFORE the
 * send call, exactly like a first message. A failed follow-up does not
 * consume the follow-up budget — only a delivery does. A stop landing
 * mid-flight wins over the delivery, same as first messages.
 * deps: { store, send, killOn, dayCounter, cap, dryRun,
 *         mailboxId, mailboxIds, mailboxStore }.
 * dryRun: gate-checks everything but never calls send and never writes
 * prospect or mailbox records.
 * Returns { ok, sent: [{prospectKey, followUpNumber?, dryRun?}],
 *           skipped: [{prospectKey, reason}] }.
 */
export async function outreachFollowUpRun(prospects, deps = {}) {
  const store = deps.store ?? defaultOutreachStore();
  const send = deps.send ?? sendSafe;
  const killOn = deps.killOn ?? (() => outreachKillOn(deps));
  if (await killOn()) return { ok: false, status: 'refused', reason: 'outreach_off', sent: [], skipped: [] };
  const cap = await outreachResolveCap(deps);
  if (cap === null) return { ok: false, status: 'refused', reason: 'cap_unconfirmed', sent: [], skipped: [] };
  let dayCount = null;
  if (typeof deps.dayCounter === 'function') {
    try { dayCount = await deps.dayCounter(Date.now()); } catch { dayCount = null; }
  } else {
    dayCount = await outreachCountSentToday(store, Date.now());
  }
  if (!Number.isInteger(dayCount) || dayCount < 0) return { ok: false, status: 'refused', reason: 'day_count_unknown', sent: [], skipped: [] };
  const mailboxStore = deps.mailboxStore ?? defaultOutreachMailboxStore();
  const gate = await outreachGateMailbox({ mailboxIds: deps.mailboxIds, mailboxId: deps.mailboxId, mailboxStore });
  if (!gate.ok) return { ok: false, status: 'refused', reason: gate.reason, sent: [], skipped: [] };
  const sent = [];
  const skipped = [];
  for (const p of prospects ?? []) {
    const prospectKey = p?.prospectKey ?? null;
    if (dayCount + sent.length >= cap) { skipped.push({ prospectKey, reason: 'cap_reached' }); continue; }
    const existing = await store.get(prospectKey).catch(() => null);
    if (!existing) { skipped.push({ prospectKey, reason: 'unknown_prospect' }); continue; }
    if (existing.status !== 'sent') { skipped.push({ prospectKey, reason: `prospect_${existing.status}` }); continue; }
    const n = Number(existing.followUpCount ?? 0) || 0;
    if (n >= OUTREACH_MAX_FOLLOWUPS) { skipped.push({ prospectKey, reason: 'followups_exhausted' }); continue; }
    const chatId = p?.chatId ?? existing.chatId;
    const text = p?.text;
    if (!chatId || !String(text ?? '').trim()) { skipped.push({ prospectKey, reason: 'bad_request' }); continue; }
    // Mailbox re-checked per follow-up: a pause landing mid-run stops the rest.
    const live = await outreachMailboxStatus(gate.mailboxId, mailboxStore).catch(() => null);
    if (live && live.status === 'paused') { skipped.push({ prospectKey, reason: 'mailbox_paused' }); continue; }
    if (deps.dryRun) { sent.push({ prospectKey, dryRun: true, followUpNumber: n + 1 }); continue; }
    await store.log(prospectKey, { event: 'followup_attempt', followUpNumber: n + 1, message: text }).catch(() => {});
    let delivered = null;
    try { delivered = await send(chatId, text, p.buttons); } catch { delivered = null; }
    if (!delivered) {
      await store.log(prospectKey, { event: 'followup_failed', followUpNumber: n + 1 }).catch(() => {});
      skipped.push({ prospectKey, reason: 'send_failed' });
      continue;
    }
    const after = await store.get(prospectKey).catch(() => null);
    if (after && ['declined', 'accepted', 'replied', 'opted_out', 'no_interest'].includes(after.status)) {
      await store.log(prospectKey, { event: 'followup_after_stop', followUpNumber: n + 1, priorStatus: after.status }).catch(() => {});
      await outreachMailboxRecordSend(gate.mailboxId, mailboxStore).catch(() => {});
      skipped.push({ prospectKey, reason: `prospect_${after.status}` });
      continue;
    }
    await store.set(prospectKey, { ...existing, followUpCount: n + 1, lastFollowUpAt: new Date().toISOString() }).catch(() => {});
    await store.log(prospectKey, { event: 'followup_sent', followUpNumber: n + 1 }).catch(() => {});
    await outreachMailboxRecordSend(gate.mailboxId, mailboxStore).catch(() => {});
    sent.push({ prospectKey, followUpNumber: n + 1 });
  }
  return { ok: true, sent, skipped };
}
