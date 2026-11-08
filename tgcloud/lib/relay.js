// lib/relay.js — PB Relay: consent-based channel/group auto-forwarder.
// PB-RELAY-SPEC (design of record) + Rowdy's settled build decisions
// (2026-10-21): tiers via TIER_LIMITS.relayRules (Free 0 · Starter 0 ·
// Builder 1 + filters · Pro 5 + auto-clean · Agency unlimited + branding
// footer); group sources relay ADMIN posts by default with a per-rule
// opt-in for all non-command posts; channels consent via Path A only in
// v1; default verb copyMessage; paused rules are retained indefinitely;
// deletes are un-mirrorable (stated in the setup copy); edits are ignored
// in v1 but relay_deliveries.destMsgId stores the source→destination
// message-id map from day one.
//
// THE GATE (spec §5, load-bearing): a rule may carry content from source
// S to destination D only while the rule owner is proven creator/
// administrator of BOTH ends (Path A), proven by api.getChatMember at
// creation, re-proven at every resume, and re-checked by the tick audit.
// Any check that errors reads as consent ABSENT (fail closed). There is
// no third-party-source path: PB also physically cannot hear a channel
// it isn't an admin of.
//
// ENGINE SHAPE: the DM broadcast idioms, reused not reinvented —
// conditional-update + verify claims with a unique token, stale-claim
// recovery at 10 min, classifyDmSendError error classes, counters
// recomputed from delivery rows (rows are truth, rule counters a cache),
// per-cycle time-boxing against the ~30s invoke cap. Sends happen inline
// in the update handler for the common case (fast path, ≤5 destinations);
// anything beyond that, or handed back by a 429, drains on the tick.
//
// WAVE 1 SCOPE: schema + engine + Path A CRUD + wizard + fast path +
// queued drain + dedupe/loop guards + tier gates at creation, resume AND
// relay time + lapse-pause.
//
// WAVE 3 (this build — the Relay build is COMPLETE with it): consent
// Path B (spec §5) — a destination GROUP the owner doesn't admin can
// ride an ACTIVE Cross Protect link with the source (owner still admins
// the source; channels stay Path-A-only). Link state is re-validated at
// creation, at resume, at relay time and by the tick audit; a withdrawn
// link flips the destination to paused/consent + one owner DM. The
// revocation lifecycle: /relaystop-paused destinations carry
// pauseReason 'relaystop' and only the destination side can re-consent
// (an admin runs /relay resume <id> inside that chat); owner resume
// re-validates and reactivates 'failure'/'consent' pauses and 'dead'
// destinations. The failure lifecycle: first consecutive failure → one
// owner DM, RELAY_DEST_FAIL_PAUSE in a row → destination auto-paused +
// DM, permanent error → 'dead' + DM — exactly one DM per state
// transition, driven by the stored failCount/status flips. The
// health/consent audit rides the tick cycle (source-lost, source
// consent loss, per-destination consent), and /relay stats renders the
// §10 view from delivery rows. Wave 4 (edit-mirroring, Mini App
// manager, watermarking) stays parked per spec §11.
//
// WAVE 2 (this build): the filter chain (spec §4.2b: media-type blocks →
// link block → keyword blocklist → keyword allowlist; protected stays
// step 1 at intake), the auto-clean pipeline (§4.2c, Pro+), the branding
// footer (§4.2d, Agency+), and album staging/flush (§9.4). Feature gates
// bite at SETUP (createRelayRule refuses what the tier can't do) and at
// SEND (the send plan is computed per post under the owner's CURRENT
// entitlement — a lapsed feature stops applying; the stored settings
// are never rewritten by a lapse). Because the Bot API has no getMessage,
// intake computes the full send plan (final text / caption / media
// descriptor) onto the delivery row (payloadJson); the drain just
// executes plans. Copy mode sends text posts via sendMessage with the
// cleaned/merged text and media via copyMessage with a caption override;
// rules with nothing to transform keep W1's byte-faithful plain copy.

import { api } from 'sdk';
import db, { eq, and, asc, lt, gte } from 'sdk/db';
import {
  bot_users, known_groups,
  relay_rules, relay_rule_destinations, relay_deliveries,
  mirror_queue,
} from '../schema.js';
import { isOwnerId, isChatAdmin, getCrossProtectLink, listCrossProtectLinks, getGroupSettings, cleanupNoteSent } from './groups.js';
import { getConfig, setConfig, getConfigFlag } from './config.js';
import { canonicalJSON, hmacHex } from './mcpkeys.js';
import { canonicalTier, tierLimits, tierAtLeast } from './tiers.js';
import { classifyDmSendError } from './broadcastcmds.js';

export const RELAY_MAX_ATTEMPTS = 3;
export const RELAY_DEST_FAIL_PAUSE = 3; // consecutive failed deliveries → destination auto-pause (Wave 3 failure lifecycle)
const RELAY_AUDIT_MAX_RULES = 25; // health/consent audit slice per tick cycle (cursor-rotated)
const RELAY_FAST_PATH_MAX = 5; // destinations sent inline per source post
const RELAY_DRAIN_CHUNK_MS = 15000; // per-cycle time box (invoke cap ~30s)
const RELAY_DRAIN_MAX_SENDS = 25; // per-cycle send cap (no timers exist to pace with)
const RELAY_CLAIM_STALE_MS = 10 * 60 * 1000;
const RELAY_RETENTION_MS = 30 * 24 * 3600 * 1000; // sent/filtered rows kept 30d (spec §7.3)
const WIZ_TTL_MS = 30 * 60 * 1000;
const ALBUM_FLUSH_AGE_MS = 4000; // spec §9.4: flush when the group's newest item is ~4s old
const ALBUM_MAX_ITEMS = 10; // Telegram's album cap — a full group flushes immediately
const RELAY_TEXT_CAP = 4096; // Telegram text-message cap (footer merge truncates the body)
const RELAY_CAPTION_CAP = 1024; // Telegram caption cap (same rule)
const GROUP_ANON_BOT_ID = 1087968824; // @GroupAnonymousBot — anonymous admin posts

const nowDate = () => new Date();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendDm(uid, text, extra = {}) {
  try { await api.sendMessage({ chat_id: uid, text: String(text).slice(0, 4000), ...extra }); } catch { /* DM closed */ }
}
const sendSafe = async (chatId, text, extra = {}) => {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22).
  if (sent) await cleanupNoteSent(chatId, sent);
  return sent;
};

let _me = null;
async function botIdentity() {
  if (!_me) _me = await api.getMe();
  return _me;
}

// ── Tier entitlement ────────────────────────────────────────────────────────

async function getUserTier(tgId) {
  try {
    const u = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(tgId))).get();
    return u?.tier ?? 'free';
  } catch { return 'free'; }
}

/** { tier, limit, canClean, canFooter } for an owner — Rowdy bypasses
 *  all gates (platform rule). Feature gates (spec §6): filters ride
 *  every rule-holding tier, auto-clean is Pro+, footer is Agency+. */
export async function relayEntitlement(ownerId) {
  if (await isOwnerId(ownerId).catch(() => false)) {
    return { tier: 'owner', limit: Infinity, canClean: true, canFooter: true };
  }
  const tier = canonicalTier(await getUserTier(ownerId));
  return {
    tier,
    limit: tierLimits(tier).relayRules ?? 0,
    canClean: tierAtLeast(tier, 'pro'),
    canFooter: tierAtLeast(tier, 'agency'),
  };
}

/** Non-deleted rules of an owner, oldest first (quota position order). */
export async function listOwnerRules(ownerId) {
  const rows = await db.select().from(relay_rules)
    .where(eq(relay_rules.ownerId, String(ownerId))).orderBy(asc(relay_rules.id)).all();
  return rows.filter((r) => r.status !== 'deleted');
}

export async function countOwnerRules(ownerId) {
  return (await listOwnerRules(ownerId)).length;
}

export async function getRelayRule(ruleId) {
  const id = Number(ruleId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.select().from(relay_rules).where(eq(relay_rules.id, id)).get().catch(() => null);
}

export async function listRuleDestinations(ruleId) {
  return db.select().from(relay_rule_destinations)
    .where(eq(relay_rule_destinations.ruleId, Number(ruleId)))
    .orderBy(asc(relay_rule_destinations.id)).all();
}

/**
 * Is this rule inside its owner's CURRENT quota? Quota position = index
 * among the owner's non-deleted rules, oldest first (the lapse rule:
 * excess rules pause newest-first, §6.2). At relay time an over-quota
 * active rule flips to paused_tier (the flip is the once-guard for the
 * owner DM) and stops relaying until the tier returns.
 */
export async function ruleWithinQuota(rule) {
  const { limit } = await relayEntitlement(rule.ownerId);
  if (!Number.isFinite(limit)) return true;
  const mine = await listOwnerRules(rule.ownerId);
  const pos = mine.findIndex((r) => r.id === rule.id);
  return pos >= 0 && pos < limit;
}

async function pauseRuleForTier(rule) {
  if (rule.status !== 'active') return false;
  await db.update(relay_rules).set({ status: 'paused_tier', updatedAt: nowDate() })
    .where(and(eq(relay_rules.id, rule.id), eq(relay_rules.status, 'active'))).run();
  const after = await getRelayRule(rule.id);
  if (!after || after.status !== 'paused_tier') return false; // another runner flipped it
  const { tier } = await relayEntitlement(rule.ownerId);
  await sendDm(rule.ownerId,
    `📡 Relay rule #${rule.id} paused — your ${tier} plan's relay limit no longer covers it. ` +
    'Nothing was deleted: the rule, its destinations and its history are kept. ' +
    'Upgrade, or delete another rule and /relay resume ' + rule.id + ', and it picks up again after a consent re-check.');
  return true;
}

/** Tick audit slice: apply the lapse rule to every owner holding an
 *  active rule. Returns how many rules flipped to paused_tier. */
export async function applyRelayTierLapse() {
  const actives = await db.select({ ownerId: relay_rules.ownerId }).from(relay_rules)
    .where(eq(relay_rules.status, 'active')).all().catch(() => []);
  const owners = [...new Set(actives.map((r) => r.ownerId))];
  let flipped = 0;
  for (const ownerId of owners) {
    const { limit } = await relayEntitlement(ownerId);
    if (!Number.isFinite(limit)) continue;
    const mine = await listOwnerRules(ownerId);
    for (let i = 0; i < mine.length; i++) {
      if (i >= limit && mine[i].status === 'active') {
        if (await pauseRuleForTier(mine[i])) flipped++;
      }
    }
  }
  return flipped;
}

// ── Wave 2 settings: parse + normalize (the parked JSON columns) ───────────

function coerceJson(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}
function strList(v, max, len) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    const t = String(s ?? '').trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t.slice(0, len));
    if (out.length >= max) break;
  }
  return out;
}

export const RELAY_MEDIA_KINDS = ['photo', 'video', 'document', 'audio', 'sticker', 'poll'];

export function normalizeRelayFilters(raw) {
  const bm = (raw && typeof raw.blockMedia === 'object' && raw.blockMedia) || {};
  const blockMedia = {};
  for (const k of RELAY_MEDIA_KINDS) blockMedia[k] = bm[k] === true;
  return {
    blockKeywords: strList(raw?.blockKeywords, 50, 64),
    allowKeywords: strList(raw?.allowKeywords, 50, 64),
    blockLinks: raw?.blockLinks === true,
    blockMedia,
  };
}
export function parseRelayFilters(rule) {
  return normalizeRelayFilters(coerceJson(rule?.filtersJson));
}

export function normalizeRelayClean(raw) {
  const replacements = [];
  if (Array.isArray(raw?.replacements)) {
    for (const r of raw.replacements) {
      const from = String(r?.from ?? '').trim();
      if (!from) continue;
      replacements.push({ from: from.slice(0, 64), to: String(r?.to ?? '').slice(0, 64) });
      if (replacements.length >= 20) break;
    }
  }
  return {
    stripTme: raw?.stripTme === true,
    stripUrls: raw?.stripUrls === true,
    stripMentions: raw?.stripMentions === true,
    mentionReplacement: String(raw?.mentionReplacement ?? '').slice(0, 32),
    replacements,
  };
}
export function parseRelayClean(rule) {
  return normalizeRelayClean(coerceJson(rule?.cleanJson));
}
/** Is any cleaning step switched on? (An all-off config is inert and
 *  must leave the byte-faithful copy path exactly as W1.) */
export function cleanIsActive(clean) {
  return !!(clean && (clean.stripTme || clean.stripUrls || clean.stripMentions || clean.replacements.length));
}

export function normalizeRelayBranding(raw) {
  return { footer: String(raw?.footer ?? '').slice(0, 300) };
}
export function parseRelayBranding(rule) {
  return normalizeRelayBranding(coerceJson(rule?.brandingJson));
}

// ── Wave 2 post inspection: media kind, links, keywords ────────────────────

/** The §4.2b media kind of a post (voice rides 'audio', animation and
 *  video notes ride 'video' — the six toggle buckets). */
export function relayMediaKind(message) {
  if (Array.isArray(message?.photo) && message.photo.length) return 'photo';
  if (message?.video || message?.video_note || message?.animation) return 'video';
  if (message?.document) return 'document';
  if (message?.audio || message?.voice) return 'audio';
  if (message?.sticker) return 'sticker';
  if (message?.poll) return 'poll';
  return null;
}

/** file_id descriptor for sendMediaGroup (largest photo size, per Bot
 *  API practice). null for kinds an album can't carry (voice, animation,
 *  video notes) — those flush by the per-item fallback (spec §9.4). */
export function relayMediaDescriptor(message) {
  if (Array.isArray(message?.photo) && message.photo.length) {
    return { type: 'photo', fileId: message.photo[message.photo.length - 1].file_id };
  }
  if (message?.video) return { type: 'video', fileId: message.video.file_id };
  if (message?.document) return { type: 'document', fileId: message.document.file_id };
  if (message?.audio) return { type: 'audio', fileId: message.audio.file_id };
  return null;
}

const RE_SCHEME_URL = /(?:https?:\/\/|www\.)[^\s<>()"']+/i;
const RE_TME_URL = /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/[^\s<>()"']+/i;
const RE_BARE_DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|me|gg|xyz|co|app|dev|info|biz|site|online|club|fun|live|pro|ai|to|tv|cc|ru|su)(?:\/[^\s<>()"']*)?/i;

export function textHasLink(text, entities) {
  if (Array.isArray(entities) && entities.some((e) => e && (e.type === 'url' || e.type === 'text_link'))) return true;
  const t = String(text ?? '');
  return RE_SCHEME_URL.test(t) || RE_TME_URL.test(t) || RE_BARE_DOMAIN.test(t);
}

/** Case-insensitive substring match (the banned-words house style);
 *  returns the matched list entry or null. */
export function matchRelayKeyword(haystack, list) {
  const h = String(haystack ?? '').toLowerCase();
  if (!h) return null;
  for (const w of list ?? []) {
    if (w && h.includes(String(w).toLowerCase())) return w;
  }
  return null;
}

/**
 * The §4.2b filter chain, steps 2–5 (step 1, protected content, is
 * handled at intake before destinations are even loaded — it filters
 * the post for every rule at once): media_type → link_block → keyword →
 * no_allow_match. First match wins; returns the reason or null.
 */
export function relayFilterReason(message, filters) {
  const f = filters ?? normalizeRelayFilters(null);
  const kind = relayMediaKind(message);
  if (kind && f.blockMedia?.[kind]) return 'media_type';
  const text = `${message?.text ?? ''}\n${message?.caption ?? ''}`;
  const entities = [...(message?.entities ?? []), ...(message?.caption_entities ?? [])];
  if (f.blockLinks && textHasLink(text, entities)) return 'link_block';
  if (matchRelayKeyword(text, f.blockKeywords)) return 'keyword';
  if (f.allowKeywords?.length && !matchRelayKeyword(text, f.allowKeywords)) return 'no_allow_match';
  return null;
}

// ── Wave 2 auto-clean (spec §4.2c) + footer merge (§4.2d) ──────────────────

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The clean pipeline, in the spec's fixed order: t.me links → all URLs
 * (entity spans first, while offsets still refer to the original text;
 * then regex passes) → @usernames (or the rule's placeholder) →
 * find-replace pairs → whitespace repair. Pure function of (text,
 * entities, clean) — the unit the harness byte-checks.
 */
export function cleanRelayText(input, entities, clean) {
  const original = String(input ?? '');
  if (!cleanIsActive(clean)) return { text: original, changed: false };
  let text = original;
  // Entity spans: url entities whose span is a t.me link fall under
  // stripTme or stripUrls; any url/text_link span falls under stripUrls.
  // (@mention spans are left for the regex pass so the placeholder can
  // substitute instead of deleting.)
  const spans = [];
  for (const e of Array.isArray(entities) ? entities : []) {
    if (!e || typeof e.offset !== 'number' || typeof e.length !== 'number') continue;
    if (e.type === 'url') {
      const spanText = original.substr(e.offset, e.length);
      const isTme = /(?:t\.me|telegram\.me)\//i.test(spanText);
      if ((isTme && clean.stripTme) || clean.stripUrls) spans.push(e);
    } else if (e.type === 'text_link') {
      const isTme = /(?:t\.me|telegram\.me)\//i.test(String(e.url ?? ''));
      if ((isTme && clean.stripTme) || clean.stripUrls) spans.push(e);
    }
  }
  if (spans.length) {
    spans.sort((a, b) => b.offset - a.offset);
    for (const s of spans) text = text.slice(0, s.offset) + text.slice(s.offset + s.length);
  }
  if (clean.stripTme) text = text.replace(new RegExp(RE_TME_URL.source, 'gi'), '');
  if (clean.stripUrls) {
    text = text.replace(new RegExp(RE_SCHEME_URL.source, 'gi'), '');
    text = text.replace(new RegExp(RE_BARE_DOMAIN.source, 'gi'), '');
  }
  if (clean.stripMentions) {
    text = text.replace(/@[A-Za-z0-9_]{2,}/g, () => clean.mentionReplacement ?? '');
  }
  for (const r of clean.replacements) {
    text = text.replace(new RegExp(escapeRegExp(r.from), 'gi'), () => r.to);
  }
  // Whitespace repair: removals leave dangling blanks behind.
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { text, changed: text !== original };
}

/** Footer merge (spec §4.2d): the BODY truncates first, the footer
 *  never does; the result never exceeds the cap. */
export function mergeRelayFooter(body, footer, cap) {
  const b = String(body ?? '');
  const f = String(footer ?? '');
  if (!f) return b.slice(0, cap);
  if (f.length >= cap) return f.slice(0, cap);
  const room = cap - f.length - 2; // "\n\n" separator
  const trimmed = b.length > room ? b.slice(0, Math.max(0, room)) : b;
  return trimmed ? `${trimmed}\n\n${f}` : f;
}

/**
 * The send plan for one post under the owner's CURRENT entitlement
 * (feature gates bite at send time too — §6: lapsed clean/footer stop
 * applying, stored settings untouched). Copy mode only; forward mode
 * never gets a plan (Telegram forwards are immutable — filters still
 * ran before this). Returns { plan } or { filtered: 'cleaned_empty' }.
 * Plans with nothing to transform stay { kind: 'copy' } — W1's plain
 * byte-faithful copyMessage.
 */
export function buildRelaySendPlan(rule, message, ent) {
  const cleanCfg = parseRelayClean(rule);
  const clean = ent?.canClean && cleanIsActive(cleanCfg) ? cleanCfg : null;
  const footer = ent?.canFooter ? parseRelayBranding(rule).footer : '';
  const isAlbum = Boolean(message?.media_group_id);
  const text = typeof message?.text === 'string' ? message.text : null;
  const caption = typeof message?.caption === 'string' ? message.caption : null;

  if (isAlbum) {
    // Album item: the descriptor rides the plan; the flush recomposes
    // the group. Caption/footer resolve per item — the flush takes the
    // caption of the item that HAS one (else the bare footer) onto the
    // group's first item, where Telegram shows album captions.
    let capOut = caption;
    if (caption !== null && clean) capOut = cleanRelayText(caption, message.caption_entities, clean).text;
    let finalCaption = capOut;
    if (footer) finalCaption = mergeRelayFooter(capOut ?? '', footer, RELAY_CAPTION_CAP);
    if (finalCaption && finalCaption.length > RELAY_CAPTION_CAP) finalCaption = finalCaption.slice(0, RELAY_CAPTION_CAP);
    return {
      plan: {
        kind: 'album', media: relayMediaDescriptor(message),
        caption: finalCaption ?? null, hasCaption: caption !== null,
        cleaned: (finalCaption ?? null) !== caption,
      },
    };
  }
  if (!clean && !footer) return { plan: { kind: 'copy', cleaned: false } };
  if (text !== null) {
    const c = clean ? cleanRelayText(text, message.entities, clean) : { text, changed: false };
    if (clean && c.text.trim() === '') return { filtered: 'cleaned_empty' };
    const finalText = mergeRelayFooter(c.text, footer, RELAY_TEXT_CAP);
    return { plan: { kind: 'text', text: finalText, cleaned: finalText !== text } };
  }
  // Single media post: the caption is the only text PB may rewrite.
  let capOut = caption;
  if (caption !== null && clean) capOut = cleanRelayText(caption, message.caption_entities, clean).text;
  let finalCaption = capOut;
  if (footer) finalCaption = mergeRelayFooter(capOut ?? '', footer, RELAY_CAPTION_CAP);
  if (finalCaption && finalCaption.length > RELAY_CAPTION_CAP) finalCaption = finalCaption.slice(0, RELAY_CAPTION_CAP);
  return { plan: { kind: 'media', caption: finalCaption ?? null, cleaned: (finalCaption ?? null) !== caption } };
}

// ── Consent (Path A + Path B) ─────────────────────────────────────────────

/** Probe a chat PB may need to reason about: { id, type, title } or null. */
export async function probeRelayChat(chatRef) {
  try {
    const c = await api.getChat({ chat_id: chatRef });
    if (!c?.id) return null;
    return { id: String(c.id), type: c.type ?? 'group', title: c.title ?? c.first_name ?? String(c.id) };
  } catch { return null; }
}

/** Path A for one end: the owner is creator/administrator there. Any
 *  API error reads as NOT admin — consent fails closed (spec §5). */
export async function ownerAdminAt(ownerId, chatId) {
  return isChatAdmin(chatId, ownerId);
}

/** Can PB itself operate in this chat for the given role?
 *  source channel → PB must be admin (only way it hears posts, §3.1);
 *  dest channel → PB must be admin (only way it can post);
 *  groups → membership is enough; sends classify their own failures. */
export async function pbReadyAt(chatId, kind, role) {
  try {
    const me = await botIdentity();
    const m = await api.getChatMember({ chat_id: chatId, user_id: me.id });
    if (kind === 'channel') return m?.status === 'administrator';
    return ['administrator', 'creator', 'member'].includes(m?.status);
  } catch { return false; }
}

const kindLabel = (kind) => (kind === 'channel' ? 'channel' : 'group');

/** Path B validity for a (source, destination) pair (spec §5): an
 *  ACTIVE Cross Protect link joins the two groups — both sides'
 *  admins confirmed the link row AND both groups' Cross Protect
 *  switches are on (the mirror gate's own definition of live, so
 *  unlinking OR either side switching off both end the consent).
 *  DB state only — cheap enough to re-check at relay time. Any read
 *  error reads as INACTIVE: consent fails closed. */
export async function relayCpLinkActive(sourceChatId, destChatId) {
  try {
    const row = await getCrossProtectLink(sourceChatId, destChatId);
    if (!row || row.aConfirmed !== true || row.bConfirmed !== true) return false;
    const ss = await getGroupSettings(sourceChatId).catch(() => null);
    const ds = await getGroupSettings(destChatId).catch(() => null);
    return ss?.cross_protect === true && ds?.cross_protect === true;
  } catch { return false; }
}

/** Groups joined to this source by an ACTIVE Cross Protect link —
 *  the wizard's Path B destination candidates. Channels never appear
 *  (links join groups; channels are Path-A-only in v1, spec §5/D7). */
export async function listCpLinkedGroups(sourceChatId) {
  const links = await listCrossProtectLinks(sourceChatId).catch(() => []);
  const out = [];
  for (const l of links) {
    if (!l.active) continue;
    if (!(await relayCpLinkActive(sourceChatId, l.otherId))) continue;
    const probe = await probeRelayChat(l.otherId);
    if (!probe || probe.type === 'channel') continue;
    out.push({ chatId: String(l.otherId), title: probe.title, type: probe.type, consentMode: 'cp_link' });
  }
  return out;
}

/** The source end of a rule shape (same for both consent paths): the
 *  owner admins the source, and PB can hear it. */
export async function validateRelaySourceEnd(ownerId, source) {
  if (!(await ownerAdminAt(ownerId, source.id))) {
    return { ok: false, reason: `you're not an admin of the source ${kindLabel(source.type)} (${source.title}). Relay only moves content out of chats you run.` };
  }
  if (source.type !== 'channel' && !(await pbReadyAt(source.id, source.type, 'source'))) {
    return { ok: false, reason: `PB isn't a member of ${source.title} — add @PoorBoyAI_bot there first.` };
  }
  if (source.type === 'channel' && !(await pbReadyAt(source.id, 'channel', 'source'))) {
    return { ok: false, reason: `PB isn't an admin in ${source.title} yet — add @PoorBoyAI_bot as admin with post rights, then retry. Channels only send their posts to admin bots.` };
  }
  return { ok: true };
}

/** One destination's consent, by its mode (spec §5). Path A: the
 *  owner admins the destination (plus PB admin for channel dests).
 *  Path B (cp_link, groups only): an ACTIVE Cross Protect link joins
 *  source and destination, and PB is a member there to post. */
export async function validateRelayDestConsent(ownerId, source, d) {
  if (String(d.id) === String(source.id)) {
    return { ok: false, reason: 'a chat can\'t relay into itself.' };
  }
  if (d.consentMode === 'cp_link') {
    if (d.type === 'channel') {
      return { ok: false, reason: `${d.title} is a channel — Cross Protect links join groups, so a channel destination needs you as its admin (Path A).` };
    }
    if (!(await relayCpLinkActive(source.id, d.id))) {
      return { ok: false, reason: `the Cross Protect link between ${source.title} and ${d.title} isn't active — both groups' admins must confirm the link and keep Cross Protect switched on before posts can ride it.` };
    }
    if (!(await pbReadyAt(d.id, d.type, 'dest'))) {
      return { ok: false, reason: `PB isn't a member of ${d.title} — the link joins the groups, but PB still has to be in the group to post there.` };
    }
    return { ok: true };
  }
  if (!(await ownerAdminAt(ownerId, d.id))) {
    return { ok: false, reason: `you're not an admin of ${d.title}. Relay only delivers into chats you run.` };
  }
  if (d.type === 'channel' && !(await pbReadyAt(d.id, 'channel', 'dest'))) {
    return { ok: false, reason: `PB isn't an admin in ${d.title} yet — add @PoorBoyAI_bot as admin with post rights, then retry.` };
  }
  return { ok: true };
}

/** Full creation-time validation for one rule shape. Returns
 *  { ok: true } or { ok: false, reason } with plain-English reasons. */
export async function validateRuleShape(ownerId, source, dests) {
  const s = await validateRelaySourceEnd(ownerId, source);
  if (!s.ok) return s;
  for (const d of dests) {
    const v = await validateRelayDestConsent(ownerId, source, d);
    if (!v.ok) return v;
  }
  // Direct 2-cycle refusal (spec §9.5.3): refuse S→D while a live D→S
  // rule exists anywhere. (The own-copy guard already cuts every cycle;
  // this surfaces the confusing setup at creation time instead.)
  for (const d of dests) {
    const reverse = await db.select().from(relay_rules)
      .where(and(eq(relay_rules.sourceChatId, String(d.id)), eq(relay_rules.status, 'active'))).all().catch(() => []);
    for (const r of reverse) {
      const rd = await listRuleDestinations(r.id);
      if (rd.some((x) => String(x.destChatId) === String(source.id) && x.status === 'active')) {
        return { ok: false, reason: `${d.title} already relays into ${source.title} (rule #${r.id}) — a two-way relay loop. Pause that rule first.` };
      }
    }
  }
  return { ok: true };
}

// ── Rule CRUD ───────────────────────────────────────────────────────────────

/**
 * Create a rule after full validation (tier count → feature gates →
 * shape/consent → 2-cycle). `input`: { name?, source: {id,type,title},
 * dests: [{id,type,title}], scope?, attribution?, filters?, clean?,
 * branding? } — the W2 settings are normalized and feature-gated here
 * (setup refuses what the tier can't do, spec §6). Returns { rule,
 * destinations } or { error: 'tier_zero'|'tier_cap'|'feature'|'invalid',
 * reason?, tier?, limit?, count? }.
 */
export async function createRelayRule(ownerId, input) {
  const ent = await relayEntitlement(ownerId);
  const count = await countOwnerRules(ownerId);
  if (ent.limit === 0) return { error: 'tier_zero', tier: ent.tier, limit: 0, count };
  if (count >= ent.limit) return { error: 'tier_cap', tier: ent.tier, limit: ent.limit, count };
  const filters = normalizeRelayFilters(input.filters);
  const clean = normalizeRelayClean(input.clean);
  const branding = normalizeRelayBranding(input.branding);
  if (cleanIsActive(clean) && !ent.canClean) {
    return { error: 'feature', tier: ent.tier, reason: 'auto-clean (stripping links and @usernames, find-replace) opens on Pro — create the rule without cleaning, or upgrade first.' };
  }
  if (branding.footer && !ent.canFooter) {
    return { error: 'feature', tier: ent.tier, reason: 'the branding footer opens on Agency — create the rule without a footer, or upgrade first.' };
  }
  const source = { id: String(input.source.id), type: input.source.type ?? 'group', title: input.source.title ?? String(input.source.id) };
  const dests = (input.dests ?? []).map((d) => ({
    id: String(d.id), type: d.type ?? 'group', title: d.title ?? String(d.id),
    consentMode: d.consentMode === 'cp_link' ? 'cp_link' : 'owner_admin',
  }));
  if (!dests.length) return { error: 'invalid', reason: 'pick at least one destination.' };
  const v = await validateRuleShape(ownerId, source, dests);
  if (!v.ok) return { error: 'invalid', reason: v.reason };
  const inserted = await db.insert(relay_rules).values({
    ownerId: String(ownerId),
    name: input.name ? String(input.name).slice(0, 80) : null,
    sourceChatId: source.id,
    sourceTitle: source.title,
    sourceKind: source.type,
    scope: source.type === 'channel' ? 'all' : (input.scope === 'all' ? 'all' : 'admins'),
    status: 'active',
    attribution: input.attribution === 'forward' ? 'forward' : 'copy',
    filtersJson: filters,
    cleanJson: clean,
    brandingJson: branding,
  }).returning();
  const rule = inserted[0];
  const destinations = [];
  for (const d of dests) {
    const rows = await db.insert(relay_rule_destinations).values({
      ruleId: rule.id, destChatId: d.id, destTitle: d.title, consentMode: d.consentMode, status: 'active',
    }).returning();
    destinations.push(rows[0]);
  }
  return { rule, destinations };
}

export async function pauseRelayRule(ownerId, ruleId) {
  const rule = await getRelayRule(ruleId);
  if (!rule || rule.ownerId !== String(ownerId) || rule.status === 'deleted') return { error: 'not_found' };
  if (rule.status !== 'active') return { rule, already: true };
  await db.update(relay_rules).set({ status: 'paused_owner', updatedAt: nowDate() })
    .where(eq(relay_rules.id, rule.id)).run();
  return { rule: await getRelayRule(rule.id) };
}

/** A destination the owner-side resume may bring back: 'dead' (after
 *  re-validation, spec §7.2) or paused for 'failure'/'consent'. A
 *  'relaystop' pause is the destination side's revocation — owner
 *  resume deliberately never touches it (spec §5: revocation is
 *  one-sided, re-consent must come from that side too). */
function destRepairableByOwner(d) {
  return d.status === 'dead'
    || (d.status === 'paused' && (d.pauseReason === 'failure' || d.pauseReason === 'consent'));
}

async function reactivateDest(d) {
  await db.update(relay_rule_destinations)
    .set({ status: 'active', failCount: 0, pauseReason: null, lastError: null, nextRetryAt: null, updatedAt: nowDate() })
    .where(eq(relay_rule_destinations.id, d.id)).run();
}

/** Resume re-runs EVERY gate (spec §4.3): tier quota position, consent
 *  at the source and every destination BY ITS MODE (Path A admin proof
 *  / Path B live link), PB readiness. Failures name the destination
 *  and the failed check. Wave 3: an already-active rule still gets a
 *  destination repair pass, so /relay resume is also how a recovered
 *  destination comes back without pausing the rule first. */
export async function resumeRelayRule(ownerId, ruleId) {
  const rule = await getRelayRule(ruleId);
  if (!rule || rule.ownerId !== String(ownerId) || rule.status === 'deleted') return { error: 'not_found' };
  const wasActive = rule.status === 'active';
  if (!wasActive && !(await ruleWithinQuota(rule))) {
    return { error: 'tier', reason: 'your current plan\'s relay limit doesn\'t cover this rule — rules resume oldest-first within the limit.' };
  }
  const source = { id: rule.sourceChatId, type: rule.sourceKind, title: rule.sourceTitle ?? rule.sourceChatId };
  if (!wasActive) {
    const sv = await validateRelaySourceEnd(ownerId, source);
    if (!sv.ok) return { error: 'consent', reason: sv.reason };
  }
  const destRows = await listRuleDestinations(rule.id);
  const reactivated = [];
  const heldRelaystop = [];
  for (const d of destRows) {
    if (d.status === 'paused' && d.pauseReason === 'relaystop') { heldRelaystop.push(d.destChatId); continue; }
    const repairable = destRepairableByOwner(d);
    if (wasActive && !repairable && d.status === 'active') continue; // live dests re-validate at relay time/audit
    const probe = await probeRelayChat(d.destChatId);
    const v = await validateRelayDestConsent(ownerId, source, {
      id: d.destChatId, type: probe?.type ?? 'group', title: d.destTitle ?? d.destChatId, consentMode: d.consentMode,
    });
    if (!v.ok) {
      // A paused rule refuses as a whole (W1 semantics); on a live rule
      // only the broken destination stays down.
      if (!wasActive) return { error: 'consent', reason: v.reason };
      continue;
    }
    if (repairable) { await reactivateDest(d); reactivated.push(d.destChatId); }
  }
  if (!wasActive) {
    await db.update(relay_rules).set({ status: 'active', lastError: null, updatedAt: nowDate() })
      .where(eq(relay_rules.id, rule.id)).run();
  }
  return { rule: await getRelayRule(rule.id), already: wasActive, reactivated, heldRelaystop };
}

/**
 * Destination-side re-consent (Wave 3, spec §5): an admin of the
 * DESTINATION chat undoes a /relaystop pause on that chat's
 * destination row — run as /relay resume <id> inside the chat. The
 * caller must admin the destination (acting as its admin IS the
 * re-consent); the pair's consent is then re-validated by its mode
 * before the row flips back. The rule owner is DM'd when someone else
 * re-consents their destination.
 */
export async function resumeRelayDestination(chatId, ruleId, actorId) {
  const rule = await getRelayRule(ruleId);
  if (!rule || rule.status === 'deleted') return { error: 'not_found' };
  const dest = (await listRuleDestinations(rule.id))
    .find((d) => String(d.destChatId) === String(chatId));
  if (!dest) return { error: 'not_found' };
  if (!(await isChatAdmin(chatId, actorId).catch(() => false)) && !(await isOwnerId(actorId).catch(() => false))) {
    return { error: 'not_admin', reason: 'only an admin of this chat can re-consent to relays into it.' };
  }
  if (dest.status === 'active') return { rule, dest, already: true };
  // pauseReason NULL = a pre-Wave-3 /relaystop pause (the only pause
  // source that existed before the column) — read as 'relaystop'.
  if (dest.status !== 'paused' || (dest.pauseReason && dest.pauseReason !== 'relaystop')) {
    return { error: 'not_relaystop', reason: 'this destination isn\'t waiting on this chat\'s re-consent — the rule owner handles its state from their DM (/relay resume).' };
  }
  const source = { id: rule.sourceChatId, type: rule.sourceKind, title: rule.sourceTitle ?? rule.sourceChatId };
  const probe = await probeRelayChat(dest.destChatId);
  const v = await validateRelayDestConsent(rule.ownerId, source, {
    id: dest.destChatId, type: probe?.type ?? 'group', title: dest.destTitle ?? dest.destChatId, consentMode: dest.consentMode,
  });
  if (!v.ok) return { error: 'consent', reason: v.reason };
  await reactivateDest(dest);
  if (String(rule.ownerId) !== String(actorId)) {
    await sendDm(rule.ownerId,
      `📡 Relay rule #${rule.id}: an admin of ${dest.destTitle ?? dest.destChatId} re-consented — relays into that chat are flowing again.`);
  }
  return { rule, dest: { ...dest, status: 'active' } };
}

/** Mutate a rule's stored W2 settings (filters/clean/branding) with
 *  ownership enforced — the engine behind the /relay block, /allow and
 *  /footer edit shortcuts (spec §8). The mutator edits the parsed bag
 *  in place; it may return { error, reason } to refuse. */
export async function updateRelayRuleSettings(ownerId, ruleId, mutator) {
  const rule = await getRelayRule(ruleId);
  if (!rule || rule.ownerId !== String(ownerId) || rule.status === 'deleted') return { error: 'not_found' };
  const bag = {
    filters: parseRelayFilters(rule),
    clean: parseRelayClean(rule),
    branding: parseRelayBranding(rule),
  };
  const refused = await mutator(bag);
  if (refused?.error) return refused;
  await db.update(relay_rules).set({
    filtersJson: bag.filters, cleanJson: bag.clean, brandingJson: bag.branding,
    updatedAt: nowDate(),
  }).where(eq(relay_rules.id, rule.id)).run();
  return { rule: await getRelayRule(rule.id) };
}

/** Hard delete (the only delete path, spec §8): rule + destinations +
 *  delivery rows, children first (no FKs on this platform). */
export async function deleteRelayRule(ownerId, ruleId) {
  const rule = await getRelayRule(ruleId);
  if (!rule || rule.ownerId !== String(ownerId) || rule.status === 'deleted') return { error: 'not_found' };
  await db.delete(relay_deliveries).where(eq(relay_deliveries.ruleId, rule.id)).run();
  await db.delete(relay_rule_destinations).where(eq(relay_rule_destinations.ruleId, rule.id)).run();
  await db.delete(relay_rules).where(eq(relay_rules.id, rule.id)).run();
  return { deleted: true, rule };
}

/**
 * /relaystop engine (spec §5): an admin of THIS chat stops relays into
 * it (destination rows → paused) and out of it (rules → paused_consent),
 * whoever owns them. Affected owners (other than the caller) get one DM
 * per affected rule naming the chat and the admin action.
 */
export async function stopRelaysForChat(chatId, actorId) {
  const cid = String(chatId);
  let destPaused = 0, rulesPaused = 0;
  const notify = new Map(); // ruleId -> rule
  const destRows = await db.select().from(relay_rule_destinations)
    .where(and(eq(relay_rule_destinations.destChatId, cid), eq(relay_rule_destinations.status, 'active'))).all();
  for (const d of destRows) {
    await db.update(relay_rule_destinations).set({ status: 'paused', pauseReason: 'relaystop', updatedAt: nowDate() })
      .where(eq(relay_rule_destinations.id, d.id)).run();
    destPaused++;
    const rule = await getRelayRule(d.ruleId);
    if (rule && rule.status !== 'deleted') notify.set(rule.id, rule);
  }
  const srcRules = await db.select().from(relay_rules)
    .where(and(eq(relay_rules.sourceChatId, cid), eq(relay_rules.status, 'active'))).all();
  for (const r of srcRules) {
    await db.update(relay_rules).set({ status: 'paused_consent', updatedAt: nowDate() })
      .where(eq(relay_rules.id, r.id)).run();
    rulesPaused++;
    notify.set(r.id, r);
  }
  for (const rule of notify.values()) {
    if (String(rule.ownerId) !== String(actorId)) {
      await sendDm(rule.ownerId,
        `🛑 Relay rule #${rule.id} was stopped by an admin of a chat it touches (${cid}). ` +
        'An admin of a chat a relay touches can always stop it — that\'s the consent rule working. ' +
        'A stopped source restarts with your /relay resume ' + rule.id + ' after a consent re-check; ' +
        'a stopped destination re-opens only when an admin of THAT chat runs /relay resume ' + rule.id + ' inside it.');
    }
  }
  return { destPaused, rulesPaused, affected: notify.size };
}

// ── Counters (rows are truth; the rule row is a cache — spec §10) ──────────

export async function refreshRuleCounters(ruleId) {
  const rows = await db.select({ status: relay_deliveries.status, cleaned: relay_deliveries.cleaned })
    .from(relay_deliveries).where(eq(relay_deliveries.ruleId, Number(ruleId))).all();
  let sent = 0, filtered = 0, failed = 0, cleaned = 0;
  for (const r of rows) {
    if (r.status === 'sent') { sent++; if (r.cleaned) cleaned++; }
    else if (r.status === 'filtered') filtered++;
    else if (r.status === 'failed' || r.status === 'dead') failed++;
  }
  await db.update(relay_rules).set({
    relayedCount: sent, filteredCount: filtered, failedCount: failed, cleanedCount: cleaned,
    updatedAt: nowDate(),
  }).where(eq(relay_rules.id, Number(ruleId))).run();
  return { sent, filtered, failed, cleaned };
}

// ── Delivery engine ─────────────────────────────────────────────────────────

function relayClaimToken() {
  return `r${Date.now().toString(36)}.${Math.floor(Math.random() * 1e9).toString(36)}`;
}
function relayClaimAgeMs(token) {
  const ms = parseInt(String(token ?? '').split('.')[0].slice(1), 36);
  return Number.isFinite(ms) ? Date.now() - ms : Infinity;
}

async function setDelivery(id, fields) {
  await db.update(relay_deliveries).set({ ...fields, updatedAt: nowDate() })
    .where(eq(relay_deliveries.id, id)).run();
}
async function setDest(id, fields) {
  await db.update(relay_rule_destinations).set({ ...fields, updatedAt: nowDate() })
    .where(eq(relay_rule_destinations.id, id)).run();
}

// ── Failure lifecycle (Wave 3, spec §9.3) ─────────────────────────────────
// Driven by the STORED counters/status, not memory: a destination's
// consecutive-failure count (failCount, reset on any success) and its
// status flips are the state machine, and the owner gets exactly ONE
// DM per transition — first failure (0→1), auto-pause (flip to
// paused/failure at RELAY_DEST_FAIL_PAUSE), death (flip to dead on a
// classified permanent error). A burst of failures inside one state
// sends nothing further; recovery is the resume re-validation (§5).

async function noteDestFailure(destId, rule, errText, { permanent = false } = {}) {
  if (!destId || !rule) return;
  const dest = await db.select().from(relay_rule_destinations)
    .where(eq(relay_rule_destinations.id, destId)).get().catch(() => null);
  if (!dest) return;
  const failCount = (dest.failCount ?? 0) + 1;
  const destName = dest.destTitle ?? dest.destChatId;
  if (permanent) {
    const wasDead = dest.status === 'dead';
    await setDest(destId, { status: 'dead', pauseReason: null, failCount, lastError: errText }).catch(() => {});
    if (!wasDead) {
      await sendDm(rule.ownerId,
        `📡 Relay rule #${rule.id}: PB can't post in ${destName} anymore (${errText}) — that destination is dead. ` +
        'The rule keeps flowing to its other destinations. Re-add PB with post rights there, then /relay resume ' + rule.id + '.');
    }
    return;
  }
  if (dest.status === 'active' && failCount >= RELAY_DEST_FAIL_PAUSE) {
    await setDest(destId, { status: 'paused', pauseReason: 'failure', failCount, lastError: errText }).catch(() => {});
    await sendDm(rule.ownerId,
      `📡 Relay rule #${rule.id}: posting to ${destName} has failed ${failCount} times in a row (last error: ${errText}) — ` +
      'that destination is paused. The rule keeps flowing elsewhere. Fix the cause, then /relay resume ' + rule.id + '.');
    return;
  }
  const firstFailure = (dest.failCount ?? 0) === 0 && dest.status === 'active';
  await setDest(destId, { failCount, lastError: errText }).catch(() => {});
  if (firstFailure) {
    await sendDm(rule.ownerId,
      `📡 Relay rule #${rule.id}: a post failed to reach ${destName} (${errText}). ` +
      'Retries are queued — if it keeps failing I\'ll pause that destination and tell you.');
  }
}

/** One send attempt for a claimed delivery row. Never throws; returns
 *  'sent' | 'rate' | 'queued' | 'failed'. The send executes the plan
 *  intake stored on the row (Wave 2): forward → forwardMessage; text
 *  plan → sendMessage with the cleaned/footered text; media plan →
 *  copyMessage with the caption replaced; album plan reached singly
 *  (the group fallback) → copyMessage with its caption; no plan → W1's
 *  plain byte-faithful copyMessage. */
async function deliverRow(row, rule) {
  let res;
  try {
    const plan = coerceJson(row.payloadJson);
    if (rule.attribution === 'forward') {
      res = await api.forwardMessage({
        chat_id: row.destChatId, from_chat_id: row.sourceChatId, message_id: row.sourceMsgId,
      });
    } else if (plan?.kind === 'text' && typeof plan.text === 'string') {
      res = await api.sendMessage({ chat_id: row.destChatId, text: plan.text });
    } else if ((plan?.kind === 'media' || plan?.kind === 'album') && plan.caption !== null && plan.caption !== undefined) {
      res = await api.copyMessage({
        chat_id: row.destChatId, from_chat_id: row.sourceChatId, message_id: row.sourceMsgId,
        caption: plan.caption,
      });
    } else {
      res = await api.copyMessage({
        chat_id: row.destChatId, from_chat_id: row.sourceChatId, message_id: row.sourceMsgId,
      });
    }
  } catch (err) {
    const cls = classifyDmSendError(err);
    const errText = String(err?.description ?? err?.message ?? cls).slice(0, 200);
    if (cls === 'rate') {
      // Hand the claim straight back and stamp the destination's
      // next-eligible time (spec §9.2); the attempt stays burned.
      const retryAfter = Number(err?.parameters?.retry_after ?? 5) || 5;
      await setDelivery(row.id, { status: 'queued', claimToken: null, lastError: 'rate_limited' });
      await setDest(row.destId, { nextRetryAt: new Date(Date.now() + retryAfter * 1000) }).catch(() => {});
      return 'rate';
    }
    if (cls === 'permanent') {
      // PB removed / no post rights / chat gone: the destination is dead
      // until the owner re-validates it via resume (spec §7.2/§9.3);
      // the failure lifecycle owns the flip + the one owner DM.
      await setDelivery(row.id, { status: 'failed', claimToken: null, lastError: errText });
      await noteDestFailure(row.destId, rule, errText, { permanent: true });
      await db.update(relay_rules).set({ lastError: errText, updatedAt: nowDate() })
        .where(eq(relay_rules.id, rule.id)).run().catch(() => {});
      return 'failed';
    }
    // retryable (incl. 'parse' — impossible for copy/forward, read as transient)
    if (row.attempts >= RELAY_MAX_ATTEMPTS) {
      await setDelivery(row.id, { status: 'failed', claimToken: null, lastError: errText });
      await noteDestFailure(row.destId, rule, errText, { permanent: false });
      return 'failed';
    }
    await setDelivery(row.id, { status: 'queued', claimToken: null, lastError: errText });
    return 'queued';
  }
  await setDelivery(row.id, {
    status: 'sent', destMsgId: res?.message_id ?? null, claimToken: null, lastError: null,
  });
  await setDest(row.destId, { failCount: 0, nextRetryAt: null, lastError: null, pauseReason: null }).catch(() => {});
  await db.update(relay_rules).set({ lastRelayAt: nowDate(), updatedAt: nowDate() })
    .where(eq(relay_rules.id, rule.id)).run().catch(() => {});
  return 'sent';
}

/** Claim a queued delivery (conditional update + verify, broadcast
 *  idiom) and attempt it. Returns deliverRow's outcome or 'unclaimed'. */
async function claimAndDeliver(row, rule) {
  const token = relayClaimToken();
  await db.update(relay_deliveries)
    .set({ status: 'sending', attempts: row.attempts + 1, claimToken: token, updatedAt: nowDate() })
    .where(and(
      eq(relay_deliveries.id, row.id),
      eq(relay_deliveries.status, 'queued'),
      eq(relay_deliveries.attempts, row.attempts),
    )).run();
  const claimed = await db.select().from(relay_deliveries)
    .where(eq(relay_deliveries.id, row.id)).get();
  if (!claimed || claimed.status !== 'sending' || claimed.claimToken !== token) return 'unclaimed';
  return deliverRow({ ...claimed }, rule);
}

// ── Album staging + flush (spec §9.4) ───────────────────────────────────────
// Album items land as separate updates; intake stages their delivery
// rows and this flush recomposes ONE sendMediaGroup per (rule,
// destination, media group) once the group is complete enough: newest
// item ~4s old, or the 10-item cap reached. If any item can't ride
// sendMediaGroup (voice/animation, a missing file_id) — or the group
// has a single item — the flush falls back to per-item copies: album
// layout is lost, content is preserved, and the row notes the fallback.

async function flushStagedAlbums(out, budget) {
  const staged = await db.select().from(relay_deliveries)
    .where(eq(relay_deliveries.status, 'staging'))
    .orderBy(asc(relay_deliveries.id)).all().catch(() => []);
  if (!staged.length) return;
  const groups = new Map();
  for (const row of staged) {
    if (!row.mediaGroupId || !row.destId) continue;
    const key = `${row.ruleId}|${row.destId}|${row.mediaGroupId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    if (budget.sends >= RELAY_DRAIN_MAX_SENDS) break;
    rows.sort((a, b) => a.sourceMsgId - b.sourceMsgId);
    const newest = Math.max(...rows.map((r) => new Date(r.createdAt).getTime()));
    if (rows.length < ALBUM_MAX_ITEMS && Date.now() - newest < ALBUM_FLUSH_AGE_MS) continue;
    const rule = await getRelayRule(rows[0].ruleId);
    if (!rule || rule.status !== 'active') continue; // paused rules hold their staging
    const dest = await db.select().from(relay_rule_destinations)
      .where(eq(relay_rule_destinations.id, rows[0].destId)).get().catch(() => null);
    if (!dest || dest.status !== 'active') continue; // paused/dead destinations hold theirs
    if (dest.consentMode === 'cp_link' && !(await relayCpLinkActive(rule.sourceChatId, dest.destChatId))) {
      await pauseDestForConsent(dest, rule, cpLinkPauseDm(rule, dest));
      continue;
    }
    if (dest.nextRetryAt && new Date(dest.nextRetryAt).getTime() > Date.now()) continue;
    // Claim the whole group under one token (conditional + verify, the
    // broadcast idiom); a lost race hands the claimed rows back.
    const token = relayClaimToken();
    const claimed = [];
    let lostRace = false;
    for (const row of rows) {
      await db.update(relay_deliveries)
        .set({ status: 'sending', attempts: row.attempts + 1, claimToken: token, updatedAt: nowDate() })
        .where(and(
          eq(relay_deliveries.id, row.id),
          eq(relay_deliveries.status, 'staging'),
          eq(relay_deliveries.attempts, row.attempts),
        )).run();
      const got = await db.select().from(relay_deliveries)
        .where(eq(relay_deliveries.id, row.id)).get();
      if (!got || got.status !== 'sending' || got.claimToken !== token) { lostRace = true; break; }
      claimed.push(got);
    }
    if (lostRace) {
      for (const c of claimed) await setDelivery(c.id, { status: 'staging', claimToken: null });
      continue;
    }
    budget.sends += claimed.length;
    out.albumItems += claimed.length;
    await sendClaimedAlbum(claimed, rule, dest, out);
    await refreshRuleCounters(rule.id);
  }
}

async function sendClaimedAlbum(rows, rule, dest, out) {
  const plans = rows.map((r) => coerceJson(r.payloadJson) ?? {});
  const groupable = rows.length > 1
    && plans.every((p) => p.media?.fileId && ['photo', 'video', 'document', 'audio'].includes(p.media.type));
  if (!groupable) {
    for (let i = 0; i < rows.length; i++) {
      const p = { ...plans[i], kind: 'media', fallback: true };
      await setDelivery(rows[i].id, { payloadJson: p });
      const res = await deliverRow({ ...rows[i], payloadJson: p }, rule);
      if (res === 'sent') out.sent++;
      else if (res === 'failed') out.failed++;
    }
    out.albumFallback++;
    return;
  }
  const captionPlan = plans.find((p) => p.hasCaption) ?? plans[0];
  const media = plans.map((p, i) => {
    const m = { type: p.media.type, media: p.media.fileId };
    if (i === 0 && captionPlan?.caption) m.caption = captionPlan.caption;
    return m;
  });
  let results;
  try {
    results = await api.sendMediaGroup({ chat_id: rows[0].destChatId, media });
  } catch (err) {
    const cls = classifyDmSendError(err);
    const errText = String(err?.description ?? err?.message ?? cls).slice(0, 200);
    if (cls === 'rate') {
      const retryAfter = Number(err?.parameters?.retry_after ?? 5) || 5;
      for (const row of rows) await setDelivery(row.id, { status: 'staging', claimToken: null, lastError: 'rate_limited' });
      await setDest(dest.id, { nextRetryAt: new Date(Date.now() + retryAfter * 1000) }).catch(() => {});
      return;
    }
    if (cls === 'permanent') {
      for (const row of rows) await setDelivery(row.id, { status: 'failed', claimToken: null, lastError: errText });
      await noteDestFailure(dest.id, rule, errText, { permanent: true });
      await db.update(relay_rules).set({ lastError: errText, updatedAt: nowDate() })
        .where(eq(relay_rules.id, rule.id)).run().catch(() => {});
      out.failed += rows.length;
      return;
    }
    // retryable: attempts were burned at claim; the group dead-letters
    // together once every row has spent its attempts.
    const burnedOut = rows.every((r) => r.attempts >= RELAY_MAX_ATTEMPTS);
    for (const row of rows) {
      await setDelivery(row.id, {
        status: burnedOut ? 'failed' : 'staging', claimToken: null, lastError: errText,
      });
    }
    if (burnedOut) {
      await noteDestFailure(dest.id, rule, errText, { permanent: false });
      out.failed += rows.length;
    }
    return;
  }
  const arr = Array.isArray(results) ? results : [];
  for (let i = 0; i < rows.length; i++) {
    await setDelivery(rows[i].id, {
      status: 'sent', destMsgId: arr[i]?.message_id ?? null, claimToken: null, lastError: null,
    });
  }
  await setDest(dest.id, { failCount: 0, nextRetryAt: null, lastError: null, pauseReason: null }).catch(() => {});
  await db.update(relay_rules).set({ lastRelayAt: nowDate(), updatedAt: nowDate() })
    .where(eq(relay_rules.id, rule.id)).run().catch(() => {});
  out.sent += rows.length;
  out.albums++;
}

// ── Consent pauses + health audit (Wave 3, spec §5/§9.3) ──────────────────
// Every pause here is a conditional flip out of 'active', so the owner
// DM rides the flip itself — exactly one DM per transition, whoever
// (intake, drain, audit, kick hook) notices first.

function cpLinkPauseDm(rule, d) {
  return `📡 Relay rule #${rule.id}: relays into ${d.destTitle ?? d.destChatId} are paused — ` +
    `the Cross Protect link with ${rule.sourceTitle ?? rule.sourceChatId} is no longer active ` +
    '(unlinked, unconfirmed, or a side switched Cross Protect off). The destination stays on the rule; ' +
    're-confirm the link, then /relay resume ' + rule.id + '.';
}

async function pauseDestForConsent(dest, rule, dmText) {
  await db.update(relay_rule_destinations)
    .set({ status: 'paused', pauseReason: 'consent', lastError: 'consent_lost', updatedAt: nowDate() })
    .where(and(eq(relay_rule_destinations.id, dest.id), eq(relay_rule_destinations.status, 'active'))).run();
  const after = await db.select().from(relay_rule_destinations)
    .where(eq(relay_rule_destinations.id, dest.id)).get().catch(() => null);
  if (!after || after.status !== 'paused' || after.pauseReason !== 'consent') return false;
  if (dmText) await sendDm(rule.ownerId, dmText);
  return true;
}

async function pauseRuleFromAudit(rule, status, dmText) {
  await db.update(relay_rules).set({ status, updatedAt: nowDate() })
    .where(and(eq(relay_rules.id, rule.id), eq(relay_rules.status, 'active'))).run();
  const after = await getRelayRule(rule.id);
  if (!after || after.status !== status) return false;
  if (dmText) await sendDm(rule.ownerId, dmText);
  return true;
}

/** One destination under the audit: returns true when it flipped to
 *  paused/consent. Path B reads the live link; Path A re-proves the
 *  owner's admin. PB's own posting rights are NOT probed here — sends
 *  classify those failures into the dead/failure lifecycle (§9.3). */
async function auditOneDest(rule, d) {
  if (d.consentMode === 'cp_link') {
    if (await relayCpLinkActive(rule.sourceChatId, d.destChatId)) return false;
    return pauseDestForConsent(d, rule, cpLinkPauseDm(rule, d));
  }
  if (!(await ownerAdminAt(rule.ownerId, d.destChatId))) {
    return pauseDestForConsent(d, rule,
      `📡 Relay rule #${rule.id}: relays into ${d.destTitle ?? d.destChatId} are paused — ` +
      'you\'re no longer an admin there, so consent no longer holds. Regain admin, then /relay resume ' + rule.id + '.');
  }
  return false;
}

/**
 * The tick health/consent audit (spec §9.3): a rotating slice of
 * active rules gets its source probed (unreachable or PB gone →
 * paused_source_lost + DM; owner no longer admin of the source →
 * paused_consent + DM) and every active destination re-proven. The
 * Cross Protect unlink/toggle hooks in lib/groups.js stamp
 * config 'relay:consent_recheck' when consent state changes — the
 * stamp is consumed here as the enqueue receipt; the slice runs
 * regardless (a quiet source has no posts to trip the relay-time
 * check, so the audit is its only witness).
 */
export async function auditRelayConsent(out = {}) {
  try {
    const stamp = await getConfig('relay:consent_recheck', null);
    if (stamp) {
      out.consentRecheck = true;
      await setConfig('relay:consent_recheck', '').catch(() => {});
    }
  } catch { /* the audit does not depend on the stamp */ }

  const actives = await db.select().from(relay_rules)
    .where(eq(relay_rules.status, 'active')).orderBy(asc(relay_rules.id)).all().catch(() => []);
  if (!actives.length) return out;
  let cursor = 0;
  try { cursor = Number(await getConfig('relay:audit_cursor', '0')) || 0; } catch { cursor = 0; }
  const start = actives.findIndex((r) => r.id > cursor);
  const ordered = start < 0 ? actives : [...actives.slice(start), ...actives.slice(0, start)];
  const slice = ordered.slice(0, RELAY_AUDIT_MAX_RULES);
  for (const rule of slice) {
    out.audited = (out.audited ?? 0) + 1;
    const probe = await probeRelayChat(rule.sourceChatId);
    const ready = probe ? await pbReadyAt(rule.sourceChatId, rule.sourceKind, 'source') : false;
    if (!probe || !ready) {
      if (await pauseRuleFromAudit(rule, 'paused_source_lost',
        `📡 Relay rule #${rule.id} paused — PB can't hear ${rule.sourceTitle ?? rule.sourceChatId} anymore ` +
        '(PB was removed, or a channel dropped PB\'s admin). Re-add PB, then /relay resume ' + rule.id + '.')) {
        out.sourceLost = (out.sourceLost ?? 0) + 1;
      }
      continue;
    }
    if (!(await ownerAdminAt(rule.ownerId, rule.sourceChatId))) {
      if (await pauseRuleFromAudit(rule, 'paused_consent',
        `📡 Relay rule #${rule.id} paused — you're no longer an admin of ${rule.sourceTitle ?? rule.sourceChatId}, ` +
        'so its posts can\'t relay. Regain admin there, then /relay resume ' + rule.id + '.')) {
        out.consentPaused = (out.consentPaused ?? 0) + 1;
      }
      continue;
    }
    const dests = await listRuleDestinations(rule.id);
    for (const d of dests) {
      if (d.status !== 'active') continue;
      if (await auditOneDest(rule, d)) out.destConsentPaused = (out.destConsentPaused ?? 0) + 1;
    }
  }
  if (slice.length) {
    await setConfig('relay:audit_cursor', String(slice[slice.length - 1].id)).catch(() => {});
  }
  return out;
}

/**
 * PB was kicked/removed from a chat (handlers/my_chat_member hook,
 * spec §9.3): destinations there die (owner DM'd once per flip),
 * rules sourced there pause as source-lost. The send-failure
 * classification backstops any removal the update misses.
 */
export async function handleRelayBotRemoved(chat) {
  const cid = String(chat?.id ?? '');
  if (!cid) return { destsDead: 0, rulesPaused: 0 };
  let destsDead = 0, rulesPaused = 0;
  const destRows = await db.select().from(relay_rule_destinations)
    .where(eq(relay_rule_destinations.destChatId, cid)).all().catch(() => []);
  for (const d of destRows) {
    if (d.status === 'dead') continue;
    const rule = await getRelayRule(d.ruleId);
    if (!rule || rule.status === 'deleted') continue;
    await setDest(d.id, { status: 'dead', pauseReason: null, lastError: 'bot_removed' }).catch(() => {});
    destsDead++;
    await sendDm(rule.ownerId,
      `📡 Relay rule #${rule.id}: PB was removed from ${d.destTitle ?? cid} — that destination is dead. ` +
      'Re-add PB there, then /relay resume ' + rule.id + '.');
  }
  const srcRules = await db.select().from(relay_rules)
    .where(and(eq(relay_rules.sourceChatId, cid), eq(relay_rules.status, 'active'))).all().catch(() => []);
  for (const r of srcRules) {
    if (await pauseRuleFromAudit(r, 'paused_source_lost',
      `📡 Relay rule #${r.id} paused — PB was removed from ${r.sourceTitle ?? cid}, so its posts can't arrive. ` +
      'Re-add PB, then /relay resume ' + r.id + '.')) {
      rulesPaused++;
    }
  }
  return { destsDead, rulesPaused };
}

// ── Intake: guards + per-post fan-out ───────────────────────────────────────

const SERVICE_KEYS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed', 'pinned_message',
  'migrate_to_chat_id', 'migrate_from_chat_id', 'forum_topic_created',
  'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened',
  'video_chat_started', 'video_chat_ended', 'proximity_alert_triggered',
];

export function isServicePost(message) {
  return SERVICE_KEYS.some((k) => message?.[k] !== undefined && message?.[k] !== null);
}

function hasRelayableContent(message) {
  return Boolean(
    message?.text || message?.caption || message?.photo || message?.video ||
    message?.document || message?.audio || message?.voice || message?.animation ||
    message?.sticker || message?.poll || message?.video_note || message?.location ||
    message?.contact || message?.dice || message?.game,
  );
}

/** PB never relays its own output (spec §9.5.1): the author check, plus
 *  the delivery map — a message that IS a recorded relay copy in this
 *  chat (its destMsgId) is PB's output even when Telegram attributes it
 *  to the destination chat itself (channel posts). This cuts every
 *  cycle in the graph, of any length. */
export async function isOwnRelayOutput(chatId, message) {
  try {
    const me = await botIdentity();
    if (me?.id && Number(message?.from?.id) === Number(me.id)) return true;
    if (me?.id && Number(message?.via_bot?.id) === Number(me.id)) return true;
  } catch { /* identity read failed — the map check below still applies */ }
  if (message?.message_id) {
    const hit = await db.select({ id: relay_deliveries.id }).from(relay_deliveries)
      .where(and(
        eq(relay_deliveries.destChatId, String(chatId)),
        eq(relay_deliveries.destMsgId, message.message_id),
        eq(relay_deliveries.status, 'sent'),
      )).get().catch(() => null);
    if (hit) return true;
  }
  return false;
}

/** Group-source 'admins' scope: is this post an admin post? Anonymous
 *  posts (sender_chat set — the poster speaks AS the chat or a linked
 *  channel) and @GroupAnonymousBot posts are admin posts by construction.
 *  Any check error fails closed (spec §5). */
export async function isAdminPost(chatId, message) {
  if (message?.sender_chat) return true;
  const fromId = message?.from?.id;
  if (!fromId) return false;
  if (Number(fromId) === GROUP_ANON_BOT_ID) return true;
  return isChatAdmin(chatId, fromId);
}

function isCommandPost(message, sourceKind, botUsername) {
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (!text.startsWith('/')) return false;
  if (sourceKind === 'channel') {
    // In a channel a leading /… is content, not a command to PB — only a
    // command explicitly addressed to PB is excluded there.
    return botUsername ? new RegExp(`^/[a-z0-9_]+@${botUsername}\\b`, 'i').test(text) : false;
  }
  return /^\/[a-z0-9_]+(@\w+)?(\s|$)/i.test(text);
}

/** One 'filtered' record per (rule, post) — the §10 stats record for a
 *  skip (destId NULL: the post never had destinations). Written at most
 *  once per rule+post; the reason is counted on the rule's surfaces via
 *  the delivery rows + refreshRuleCounters. */
async function recordFilteredDelivery(rule, sourceChatId, message, reason) {
  const existing = await db.select({ id: relay_deliveries.id }).from(relay_deliveries)
    .where(and(
      eq(relay_deliveries.ruleId, rule.id),
      eq(relay_deliveries.sourceChatId, sourceChatId),
      eq(relay_deliveries.sourceMsgId, message.message_id),
      eq(relay_deliveries.status, 'filtered'),
    )).all();
  if (existing.length) return;
  await db.insert(relay_deliveries).values({
    ruleId: rule.id, destId: null, destChatId: null,
    sourceChatId, sourceMsgId: message.message_id,
    mediaGroupId: message.media_group_id ?? null,
    status: 'filtered', filterReason: reason,
  }).run().catch(() => {});
}

/**
 * The intake both handlers call (channel_post handler + message.js group
 * seam). `chat` = { id, type, title }. Returns a small summary; never
 * throws to the caller (handlers wrap it anyway — never break the seam).
 */
export async function handleRelaySourcePost(chat, message) {
  const sourceChatId = String(chat?.id ?? message?.chat?.id ?? '');
  const out = { source: sourceChatId, sent: 0, queued: 0, filtered: 0, staged: 0, skipped: null };
  if (!sourceChatId || !message?.message_id) { out.skipped = 'no_ids'; return out; }
  if (isServicePost(message) || !hasRelayableContent(message)) { out.skipped = 'not_content'; return out; }
  if (await isOwnRelayOutput(sourceChatId, message)) { out.skipped = 'own_output'; return out; }
  const sourceKind = chat?.type ?? message?.chat?.type ?? 'group';
  let botUsername = null;
  try { botUsername = (await botIdentity())?.username ?? null; } catch { /* addressed-command guard just narrows */ }
  if (isCommandPost(message, sourceKind, botUsername)) { out.skipped = 'command'; return out; }

  const rules = await db.select().from(relay_rules)
    .where(and(eq(relay_rules.sourceChatId, sourceChatId), eq(relay_rules.status, 'active')))
    .orderBy(asc(relay_rules.id)).all();
  if (!rules.length) { out.skipped = 'no_rules'; return out; }

  for (const rule of rules) {
    // Tier gate at RELAY time (settled decision): an over-quota rule
    // pauses itself and relays nothing until the tier returns.
    if (!(await ruleWithinQuota(rule))) { await pauseRuleForTier(rule); continue; }
    // Group-source scope (settled decision): admin posts by default.
    if (rule.sourceKind !== 'channel' && rule.scope !== 'all') {
      if (!(await isAdminPost(sourceChatId, message))) continue;
    }
    // Protected content cannot legally move (spec §4.2b step 1): one
    // filtered record per (rule, post), never a send attempt.
    if (message.has_protected_content) {
      await recordFilteredDelivery(rule, sourceChatId, message, 'protected');
      out.filtered++;
      await refreshRuleCounters(rule.id);
      continue;
    }
    // Wave 2 filter chain (steps 2–5) — applies in copy AND forward
    // mode alike (forwards can't be cleaned or signed, but they can
    // absolutely be filtered; §3.2).
    const filterReason = relayFilterReason(message, parseRelayFilters(rule));
    if (filterReason) {
      await recordFilteredDelivery(rule, sourceChatId, message, filterReason);
      out.filtered++;
      await refreshRuleCounters(rule.id);
      continue;
    }
    // Wave 2 send plan, computed NOW under the owner's current feature
    // entitlement (the drain can't re-read the source post later).
    let plan = null;
    if (rule.attribution !== 'forward') {
      const built = buildRelaySendPlan(rule, message, await relayEntitlement(rule.ownerId));
      if (built.filtered) {
        await recordFilteredDelivery(rule, sourceChatId, message, built.filtered);
        out.filtered++;
        await refreshRuleCounters(rule.id);
        continue;
      }
      plan = built.plan;
    }
    const dests = await db.select().from(relay_rule_destinations)
      .where(and(eq(relay_rule_destinations.ruleId, rule.id), eq(relay_rule_destinations.status, 'active')))
      .orderBy(asc(relay_rule_destinations.id)).all();
    // Path B re-validation at RELAY time (spec §5): a link withdrawn
    // since the last post stops this delivery before anything is
    // recorded — the destination flips to paused/consent with one
    // owner DM (the tick audit catches sources that go quiet instead).
    for (let i = dests.length - 1; i >= 0; i--) {
      const d = dests[i];
      if (d.consentMode === 'cp_link' && !(await relayCpLinkActive(rule.sourceChatId, d.destChatId))) {
        await pauseDestForConsent(d, rule, cpLinkPauseDm(rule, d));
        dests.splice(i, 1);
      }
    }
    if (!dests.length) continue;
    // Albums stage for the grouped flush (§9.4) — copy mode only;
    // forward mode keeps W1's per-item immediacy.
    const stageAsAlbum = Boolean(message.media_group_id) && rule.attribution === 'copy';
    // Record the deliveries (dedupe by construction: the unique
    // (ruleId, sourceChatId, sourceMsgId, destId) makes update
    // redeliveries and handler retries no-ops — spec §9.5.2).
    const rows = [];
    for (const d of dests) {
      const inserted = await db.insert(relay_deliveries).values({
        ruleId: rule.id, destId: d.id, destChatId: d.destChatId,
        sourceChatId, sourceMsgId: message.message_id,
        mediaGroupId: message.media_group_id ?? null,
        status: stageAsAlbum ? 'staging' : 'queued',
        payloadJson: plan,
        cleaned: plan?.cleaned ? true : false,
      }).onConflictDoNothing().returning().run().catch(() => []);
      if (inserted[0]) rows.push(inserted[0]);
      else {
        const existing = await db.select().from(relay_deliveries)
          .where(and(
            eq(relay_deliveries.ruleId, rule.id),
            eq(relay_deliveries.sourceChatId, sourceChatId),
            eq(relay_deliveries.sourceMsgId, message.message_id),
            eq(relay_deliveries.destId, d.id),
          )).get().catch(() => null);
        if (existing && (existing.status === 'queued' || existing.status === 'staging')) rows.push(existing);
      }
    }
    if (stageAsAlbum) {
      out.staged += rows.length;
      await refreshRuleCounters(rule.id);
      continue;
    }
    // Fast path: send the first few inline; a 429 or the cap hands the
    // remainder to the tick drain untouched.
    let budget = RELAY_FAST_PATH_MAX;
    for (const row of rows) {
      if (budget <= 0) { out.queued++; continue; }
      const dest = dests.find((d) => d.id === row.destId);
      if (dest?.nextRetryAt && new Date(dest.nextRetryAt).getTime() > Date.now()) { out.queued++; continue; }
      budget--;
      const res = await claimAndDeliver(row, rule);
      if (res === 'sent') out.sent++;
      else if (res === 'failed') { /* counted via counters below */ }
      else out.queued++;
      if (res === 'rate') break;
    }
    await refreshRuleCounters(rule.id);
  }
  return out;
}

/** handlers/channel_post.js entry. Also registers the channel in
 *  known_groups (channels surface no other updates PB can learn from —
 *  this is how the wizard's pick list finds PB-admin channels). */
export async function relayChannelPost(message) {
  const chat = message?.chat;
  if (!chat?.id) return { skipped: 'no_chat' };
  try {
    await db.insert(known_groups).values({
      chatId: String(chat.id), title: chat.title ?? null,
    }).onConflictDoUpdate({
      target: known_groups.chatId,
      set: { title: chat.title ?? null, lastActive: nowDate() },
    }).run();
  } catch { /* registration is best-effort; relay still runs */ }
  return handleRelaySourcePost(
    { id: chat.id, type: chat.type ?? 'channel', title: chat.title ?? null }, message,
  );
}

/** handlers/message.js group-seam entry (after the moderation hooks). */
export async function relayGroupHook(chatId, message) {
  return handleRelaySourcePost(
    { id: chatId, type: message?.chat?.type ?? 'supergroup', title: message?.chat?.title ?? null },
    message,
  );
}

// ── Tick cycle: drain + lapse audit + retention ─────────────────────────────

/**
 * Work queued deliveries with the claim idiom, recover stale claims,
 * apply the tier-lapse audit, prune aged rows. deps is the harness seam
 * (unused in production — the api object itself is the seam, per house
 * harness practice).
 */
export async function cycleRelay(deps = {}) {
  const out = {
    sent: 0, failed: 0, released: 0, recovered: 0, lapsePaused: 0, pruned: 0, remaining: 0,
    albums: 0, albumItems: 0, albumFallback: 0,
  };

  // Stale-claim recovery (a runner died mid-send): back to the queue;
  // the attempt burned at claim time — the safe direction.
  const sending = await db.select().from(relay_deliveries)
    .where(eq(relay_deliveries.status, 'sending')).all().catch(() => []);
  for (const row of sending) {
    if (relayClaimAgeMs(row.claimToken) > RELAY_CLAIM_STALE_MS) {
      await setDelivery(row.id, { status: 'queued', claimToken: null });
      out.recovered++;
    }
  }

  // Tier lapse audit (spec §6.2): excess rules pause newest-first,
  // never delete; owners are DM'd by the flip itself.
  out.lapsePaused = await applyRelayTierLapse().catch(() => 0);

  // Album flush (Wave 2, §9.4): staged groups recompose as one
  // sendMediaGroup before the singles drain, sharing its send budget.
  // NOTE: the Wave 3 audit runs AFTER the flush + drain on purpose —
  // its per-rule probes take real wall time, and running it earlier
  // aged staged albums past their flush window inside one cycle
  // (caught by the W2 harness re-run, 2026-10-21).
  const budget = { sends: 0 };
  await flushStagedAlbums(out, budget).catch(() => {});

  const startedAt = Date.now();
  while (Date.now() - startedAt < RELAY_DRAIN_CHUNK_MS && budget.sends < RELAY_DRAIN_MAX_SENDS) {
    const batch = await db.select().from(relay_deliveries)
      .where(eq(relay_deliveries.status, 'queued'))
      .orderBy(asc(relay_deliveries.id)).limit(10).all();
    if (!batch.length) break;
    let progressed = false;
    for (const row of batch) {
      if (budget.sends >= RELAY_DRAIN_MAX_SENDS) break;
      const rule = await getRelayRule(row.ruleId);
      if (!rule || rule.status !== 'active') continue; // paused/deleted rules hold their queue
      const dest = await db.select().from(relay_rule_destinations)
        .where(eq(relay_rule_destinations.id, row.destId)).get().catch(() => null);
      if (!dest || dest.status !== 'active') continue; // paused/dead destinations hold theirs
      if (dest.consentMode === 'cp_link' && !(await relayCpLinkActive(rule.sourceChatId, dest.destChatId))) {
        await pauseDestForConsent(dest, rule, cpLinkPauseDm(rule, dest));
        continue;
      }
      if (dest.nextRetryAt && new Date(dest.nextRetryAt).getTime() > Date.now()) continue;
      budget.sends++;
      progressed = true;
      const res = await claimAndDeliver(row, rule);
      if (res === 'sent') out.sent++;
      else if (res === 'failed') out.failed++;
      else if (res === 'queued') out.released++;
      await refreshRuleCounters(rule.id);
      if (res === 'rate') break;
    }
    if (!progressed) break;
  }

  // Health/consent audit (Wave 3, spec §9.3): source-lost, source
  // consent loss, per-destination consent (Path B link / Path A admin).
  // Runs last in the cycle (see the album-flush note above).
  await auditRelayConsent(out).catch(() => {});

  // Retention: sent/filtered rows age out at 30 days (the rule counters
  // are the permanent record). Guarded — a prune hiccup never fails the
  // cycle.
  try {
    const cutoff = Math.floor((Date.now() - RELAY_RETENTION_MS) / 1000); // unix seconds (ts columns)
    const stale = await db.select({ id: relay_deliveries.id }).from(relay_deliveries)
      .where(and(eq(relay_deliveries.status, 'sent'), lt(relay_deliveries.createdAt, cutoff))).all();
    const staleFiltered = await db.select({ id: relay_deliveries.id }).from(relay_deliveries)
      .where(and(eq(relay_deliveries.status, 'filtered'), lt(relay_deliveries.createdAt, cutoff))).all();
    for (const r of [...stale, ...staleFiltered].slice(0, 500)) {
      await db.delete(relay_deliveries).where(eq(relay_deliveries.id, r.id)).run();
      out.pruned++;
    }
  } catch { /* retention is hygiene, never load-bearing */ }

  const remaining = await db.select({ id: relay_deliveries.id }).from(relay_deliveries)
    .where(eq(relay_deliveries.status, 'queued')).all().catch(() => []);
  out.remaining = remaining.length;
  if (out.sent === 0 && out.failed === 0 && out.recovered === 0 && out.lapsePaused === 0
    && out.remaining === 0 && out.albumItems === 0
    && (out.sourceLost ?? 0) === 0 && (out.consentPaused ?? 0) === 0 && (out.destConsentPaused ?? 0) === 0) {
    return { idle: true, ...out };
  }
  return out;
}

// ── DM wizard (house idiom: config-backed draft + inline panels) ────────────

const wizKey = (uid) => `relaywiz:${uid}`;
const hereKey = (uid) => `relayhere:${uid}`;

async function loadWiz(uid) {
  try {
    const raw = await getConfig(wizKey(uid), null);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || Date.now() - (d.createdAt ?? 0) > WIZ_TTL_MS) return null;
    return d;
  } catch { return null; }
}
async function saveWiz(uid, draft) { await setConfig(wizKey(uid), JSON.stringify(draft)).catch(() => {}); }
async function clearWiz(uid) { await setConfig(wizKey(uid), JSON.stringify({ createdAt: 0 })).catch(() => {}); }

async function editPanel(uid, messageId, text, replyMarkup) {
  if (!messageId) return false;
  try {
    await api.editMessageText({
      chat_id: Number(uid), message_id: Number(messageId),
      text: String(text).slice(0, 4000), parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return true;
  } catch { return false; }
}

const HONEST_LIMITS =
  'Two honest limits before you start:\n' +
  '• If a post is <b>deleted</b> in the source, its copies stay in the destinations — Telegram never tells bots about deletions, so no bot can mirror a delete.\n' +
  '• <b>Edits</b> aren\'t mirrored yet: copies keep the text as first posted.';

async function getEligibleChats(ownerId) {
  // Every chat PB knows where the caller proves admin (Path A probing).
  const groups = await db.select().from(known_groups).all().catch(() => []);
  const out = [];
  for (const g of groups) {
    if (await isChatAdmin(g.chatId, ownerId).catch(() => false)) {
      const probe = await probeRelayChat(g.chatId);
      out.push({
        chatId: String(g.chatId),
        title: g.title ?? probe?.title ?? String(g.chatId),
        type: probe?.type ?? 'supergroup',
      });
    }
  }
  // A fresh /relayhere pick leads the list even if PB met the chat only
  // through that command.
  try {
    const raw = await getConfig(hereKey(ownerId), null);
    if (raw) {
      const h = JSON.parse(raw);
      if (h?.chatId && Date.now() - (h.at ?? 0) < WIZ_TTL_MS
        && !out.some((c) => c.chatId === String(h.chatId))) {
        out.unshift({ chatId: String(h.chatId), title: h.title ?? String(h.chatId), type: h.type ?? 'supergroup' });
      }
    }
  } catch { /* the pick is a convenience, never load-bearing */ }
  return out;
}

function chatButton(prefix, c) {
  return { text: `${c.type === 'channel' ? '📢' : '👥'} ${String(c.title).slice(0, 40)}`, callback_data: `${prefix}:${c.chatId}` };
}

function sourcePanel(draft) {
  const rows = draft.eligible.map((c) => [chatButton('relay:src', c)]);
  rows.push([{ text: '❌ Cancel', callback_data: 'relay:cancel' }]);
  return {
    text:
      '📡 <b>New relay rule — step 1: the source</b>\n\n' +
      'Pick the channel or group whose posts get copied. You must be an admin of it — relay only moves content out of chats you run.\n\n' +
      HONEST_LIMITS + '\n\n' +
      'Don\'t see the chat? Add PB there, make sure you\'re an admin, or run /relayhere inside it — or just type its @username or chat id here.',
    reply_markup: { inline_keyboard: rows },
  };
}

function destPanel(draft) {
  const picked = new Set(draft.dests.map((d) => String(d.chatId)));
  const rows = draft.eligible
    .filter((c) => String(c.chatId) !== String(draft.sourceChatId))
    .map((c) => [{
      text: `${picked.has(String(c.chatId)) ? '✅' : (c.type === 'channel' ? '📢' : '👥')} ${String(c.title).slice(0, 40)}`,
      callback_data: `relay:dst:${c.chatId}`,
    }]);
  // Path B candidates (Wave 3): groups joined to the source by an
  // ACTIVE Cross Protect link — the destination's admins consented
  // through the link, so the owner needn't admin them.
  for (const c of draft.cpDests ?? []) {
    if (String(c.chatId) === String(draft.sourceChatId)) continue;
    if (draft.eligible.some((e) => String(e.chatId) === String(c.chatId))) continue;
    rows.push([{
      text: `${picked.has(String(c.chatId)) ? '✅' : '🔗'} ${String(c.title).slice(0, 34)} (via Cross Protect link)`,
      callback_data: `relay:dst:${c.chatId}`,
    }]);
  }
  rows.push([{ text: `➡️ Continue (${draft.dests.length} picked)`, callback_data: 'relay:dst_done' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'relay:cancel' }]);
  const hasCp = (draft.cpDests ?? []).some((c) => String(c.chatId) !== String(draft.sourceChatId)
    && !draft.eligible.some((e) => String(e.chatId) === String(c.chatId)));
  return {
    text:
      '📡 <b>Step 2: destinations</b>\n\n' +
      `Source: <b>${esc(draft.sourceTitle)}</b>\n\n` +
      'Tap each chat the posts should land in (you must admin those too — PB checks when you tap Continue), then Continue. Or type a @username / chat id to add one.' +
      (hasCp ? '\n\n🔗 Groups marked "via Cross Protect link" are joined to the source by an active link — their admins already consented there, so you don\'t need to admin them.' : ''),
    reply_markup: { inline_keyboard: rows },
  };
}

function optionsPanel(draft, ent) {
  const isGroup = draft.sourceKind !== 'channel';
  const f = draft.filters ?? normalizeRelayFilters(null);
  const c = draft.clean ?? normalizeRelayClean(null);
  if (draft.sub === 'media') {
    const rows = [[{ text: '🎞 Tap a type to block/unblock it', callback_data: 'relay:noop' }]];
    for (const k of RELAY_MEDIA_KINDS) {
      rows.push([{
        text: f.blockMedia[k] ? `🚫 ${k} — blocked` : `✅ ${k} — allowed`,
        callback_data: `relay:medt:${k}`,
      }]);
    }
    rows.push([{ text: '⬅️ Back to options', callback_data: 'relay:opts' }]);
    return {
      text:
        '📡 <b>Step 3: options — media blocks</b>\n\n' +
        'A blocked type is filtered before anything sends; the skip is recorded on the rule (filtered count, with the reason).',
      reply_markup: { inline_keyboard: rows },
    };
  }
  const rows = [];
  if (isGroup) {
    rows.push([{
      text: draft.scope === 'all' ? '📨 Posts: ALL non-command posts ✅' : '📨 Posts: admin posts only ✅',
      callback_data: 'relay:scope',
    }]);
  }
  rows.push([
    { text: `🚫 Block words (${f.blockKeywords.length})`, callback_data: 'relay:blk' },
    { text: `✅ Allow words (${f.allowKeywords.length})`, callback_data: 'relay:alw' },
  ]);
  rows.push([
    { text: `🔗 Posts with links: ${f.blockLinks ? '🚫 blocked' : 'allowed'}`, callback_data: 'relay:lnk' },
    { text: '🎞 Media blocks', callback_data: 'relay:med' },
  ]);
  if (ent?.canClean) {
    rows.push([
      { text: `🧹 t.me links: ${c.stripTme ? 'stripped' : 'kept'}`, callback_data: 'relay:cln:tme' },
      { text: `🌐 All URLs: ${c.stripUrls ? 'stripped' : 'kept'}`, callback_data: 'relay:cln:url' },
    ]);
    rows.push([
      { text: `👤 @usernames: ${c.stripMentions ? 'stripped' : 'kept'}`, callback_data: 'relay:cln:men' },
      { text: `🔁 Replacements (${c.replacements.length})`, callback_data: 'relay:rep' },
    ]);
  }
  if (ent?.canFooter) {
    rows.push([{ text: draft.footer ? '✍️ Footer: set — tap to change' : '✍️ Footer: tap to set', callback_data: 'relay:ftr' }]);
  }
  rows.push([{
    text: draft.attribution === 'forward' ? '↪️ Delivery: forwarded (keeps the credit)' : '📄 Delivery: copies (native look)',
    callback_data: 'relay:attr',
  }]);
  rows.push([{ text: '➡️ Review the rule', callback_data: 'relay:review' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'relay:cancel' }]);
  return {
    text:
      '📡 <b>Step 3: options</b>\n\n' +
      (isGroup
        ? 'Group sources relay <b>admin posts</b> by default. Switch to ALL if every member post (commands excluded) should cross.\n\n'
        : 'Channel sources relay every post.\n\n') +
      '<b>Filters</b> (every plan with rules): block words filter a post out; allow words mean ONLY posts matching one cross; link/media blocks filter whole posts.\n' +
      (ent?.canClean
        ? '<b>Auto-clean</b> (Pro): strips links and @usernames out of the copies and applies your find-replace pairs. Copies only — forwards stay untouched.\n'
        : '🔒 <b>Auto-clean</b> (strip links/@usernames from copies) opens on Pro.\n') +
      (ent?.canFooter
        ? '<b>Footer</b> (Agency): your signature line rides every copy.\n'
        : '🔒 The <b>branding footer</b> opens on Agency.\n') +
      '\n<b>Delivery</b>: copies arrive as PB\'s own posts — no "forwarded from" header — and are the only kind cleaning/footer can touch. Switch to forwarded if the source wants visible credit; filters still apply there.',
    reply_markup: { inline_keyboard: rows },
  };
}

const WIZ_TEXT_PROMPTS = {
  blk: '🚫 Type the block words — comma-separated (phrases are fine). A post containing any of them is filtered out. Send "none" to clear the list.',
  alw: '✅ Type the allow words — comma-separated. When the list is non-empty, ONLY posts containing one of them cross. Send "none" to clear it.',
  rep: '🔁 Type your find-replace pairs, one per line, like:\nOLDTICKER => NEWTICKER\nrival phrase => \n(an empty right side deletes the text). Send "none" to clear.',
  ftr: '✍️ Type the footer text — it rides every copy, under the post (text posts) or in the caption (media). Send "off" to clear it.',
};

function parseWizWordList(value) {
  const v = String(value ?? '').trim();
  if (!v || /^(none|off|clear|-)$/i.test(v)) return [];
  return strList(v.split(/[,\n]+/), 50, 64);
}

function parseWizReplacements(value) {
  const v = String(value ?? '').trim();
  if (!v || /^(none|off|clear|-)$/i.test(v)) return [];
  const pairs = [];
  for (const line of v.split(/\n|,/)) {
    const m = line.split('=>');
    const parts = m.length > 1 ? m : line.split('->');
    if (parts.length < 2) continue;
    const from = parts[0].trim();
    if (!from) continue;
    pairs.push({ from: from.slice(0, 64), to: parts.slice(1).join('=>').trim().slice(0, 64) });
    if (pairs.length >= 20) break;
  }
  return pairs;
}

async function confirmPanel(draft, ownerId) {
  const ent = await relayEntitlement(ownerId);
  const count = await countOwnerRules(ownerId);
  const cost = Number.isFinite(ent.limit)
    ? `This becomes rule ${count + 1} of ${ent.limit} on your ${ent.tier} plan.`
    : 'Your plan has unlimited relay rules.';
  const destLines = draft.dests.map((d) => `• ${esc(d.title)}${d.consentMode === 'cp_link' ? ' — via Cross Protect link (its admins already consented)' : ''}`).join('\n');
  const anyCp = draft.dests.some((d) => d.consentMode === 'cp_link');
  const f = draft.filters ?? normalizeRelayFilters(null);
  const filterBits = [];
  if (f.blockKeywords.length) filterBits.push(`blocks: ${f.blockKeywords.map(esc).join(', ')}`);
  if (f.allowKeywords.length) filterBits.push(`only posts matching: ${f.allowKeywords.map(esc).join(', ')}`);
  if (f.blockLinks) filterBits.push('posts with links are filtered');
  const mediaBlocked = RELAY_MEDIA_KINDS.filter((k) => f.blockMedia?.[k]);
  if (mediaBlocked.length) filterBits.push(`no ${mediaBlocked.join('/')}`);
  const c = draft.clean ?? normalizeRelayClean(null);
  const cleanBits = [];
  if (c.stripTme) cleanBits.push('t.me links stripped');
  if (c.stripUrls) cleanBits.push('URLs stripped');
  if (c.stripMentions) cleanBits.push('@usernames stripped');
  if (c.replacements.length) cleanBits.push(`${c.replacements.length} find-replace pair(s)`);
  return {
    text:
      '📡 <b>Confirm your relay rule</b>\n\n' +
      `From: <b>${esc(draft.sourceTitle)}</b> (${draft.sourceKind === 'channel' ? 'channel' : 'group'})\n` +
      `Into:\n${destLines}\n` +
      `Posts: ${draft.sourceKind === 'channel' ? 'every post' : (draft.scope === 'all' ? 'all non-command posts' : 'admin posts only')}\n` +
      `Filters: ${filterBits.length ? filterBits.join(' · ') : 'none'}\n` +
      (cleanBits.length ? `Cleaning: ${cleanBits.join(' · ')}\n` : '') +
      (draft.footer ? `Footer: ${esc(draft.footer)}\n` : '') +
      `Delivery: ${draft.attribution === 'forward'
        ? 'forwarded — keeps the source credit; filters apply, but cleaning/footer can\'t touch a forward'
        : 'copies'}\n` +
      (anyCp
        ? 'Consent: you admin the source; destinations are chats you admin plus Cross Protect-linked groups (checked again when you tap Create).\n\n'
        : 'Consent: you admin both ends (checked again when you tap Create).\n\n') +
      HONEST_LIMITS + '\n\n' + cost,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Create rule', callback_data: 'relay:create' }],
      [{ text: '❌ Cancel', callback_data: 'relay:cancel' }],
    ] },
  };
}

async function startRelayWizard(uid) {
  const ent = await relayEntitlement(uid);
  if (ent.limit === 0) {
    await sendDm(uid,
      '📡 PB Relay is a paid feature — it opens at Builder (Builder 1 rule · Pro 5 · Agency unlimited). ' +
      `Your plan (${ent.tier}) includes 0 relay rules. /upgrade to unlock it.`);
    return { started: false, reason: 'tier_zero' };
  }
  const count = await countOwnerRules(uid);
  if (count >= ent.limit) {
    await sendDm(uid,
      `📡 You've used all ${ent.limit} relay rule(s) on your ${ent.tier} plan. ` +
      'Delete a rule (/relay) or upgrade — paused rules still count, they\'re kept capacity.');
    return { started: false, reason: 'tier_cap' };
  }
  const eligible = await getEligibleChats(uid);
  const draft = {
    createdAt: Date.now(), stage: 'source',
    sourceChatId: null, sourceTitle: null, sourceKind: null,
    dests: [], cpDests: [], scope: 'admins', eligible,
    // Wave 2 options (normalized shapes, same as the stored JSON):
    filters: normalizeRelayFilters(null),
    clean: normalizeRelayClean(null),
    footer: '', attribution: 'copy', textStep: null, sub: null,
  };
  await saveWiz(uid, draft);
  const panel = sourcePanel(draft);
  const sent = await api.sendMessage({
    chat_id: uid, text: panel.text, parse_mode: 'HTML', reply_markup: panel.reply_markup,
  }).catch(() => null);
  if (sent?.message_id) { draft.panelId = sent.message_id; await saveWiz(uid, draft); }
  return { started: true };
}

/** Resolve a typed chat ref (@username / numeric id) to a probed chat.
 *  With a sourceChatId (the destination step), a group the caller
 *  doesn't admin still resolves when an ACTIVE Cross Protect link
 *  joins it to the source — the Path B pick (Wave 3). Sources always
 *  require the caller's own admin; channels are Path-A-only. */
async function resolveTypedChat(uid, value, sourceChatId = null) {
  const probe = await probeRelayChat(value);
  if (!probe) return { error: `I can't reach ${value} — check the @username/id, and make sure PB is in that chat.` };
  if (await isChatAdmin(probe.id, uid).catch(() => false)) {
    return { chat: { chatId: probe.id, title: probe.title, type: probe.type, consentMode: 'owner_admin' } };
  }
  if (sourceChatId && probe.type !== 'channel' && (await relayCpLinkActive(sourceChatId, probe.id))) {
    return { chat: { chatId: probe.id, title: probe.title, type: probe.type, consentMode: 'cp_link' } };
  }
  return {
    error: sourceChatId
      ? `You're not an admin of ${probe.title}, and no active Cross Protect link joins it to your source — relay only works between chats you run or groups linked by consent.`
      : `You're not an admin of ${probe.title} — relay only works between chats you run.`,
  };
}

/** DM text steps for the wizard. Returns true when the text was consumed. */
export async function handleRelayWizardText(chatId, user, text, deps = {}) {
  const uid = user?.id;
  if (!uid || String(chatId) !== String(uid)) return false;
  const draft = await loadWiz(uid);
  if (!draft || draft.stage === 'confirm') return false;
  const value = String(text ?? '').trim();
  if (!value || value.startsWith('/')) return false;
  if (draft.stage === 'options' && draft.textStep) {
    // Wave 2 option text steps (block/allow words, replacements, footer).
    const step = draft.textStep;
    draft.textStep = null;
    if (step === 'blk') draft.filters.blockKeywords = parseWizWordList(value);
    else if (step === 'alw') draft.filters.allowKeywords = parseWizWordList(value);
    else if (step === 'rep') draft.clean.replacements = parseWizReplacements(value);
    else if (step === 'ftr') draft.footer = /^off$/i.test(value) ? '' : value.slice(0, 300);
    await saveWiz(uid, draft);
    const panel = optionsPanel(draft, await relayEntitlement(uid));
    const sent = await api.sendMessage({ chat_id: uid, text: panel.text, parse_mode: 'HTML', reply_markup: panel.reply_markup }).catch(() => null);
    if (sent?.message_id) { draft.panelId = sent.message_id; await saveWiz(uid, draft); }
    return true;
  }
  if (draft.stage === 'source') {
    const r = await resolveTypedChat(uid, value);
    if (r.error) { await sendDm(uid, `❌ ${r.error}`); return true; }
    draft.sourceChatId = r.chat.chatId; draft.sourceTitle = r.chat.title; draft.sourceKind = r.chat.type;
    if (!draft.eligible.some((c) => String(c.chatId) === String(r.chat.chatId))) draft.eligible.push(r.chat);
    draft.cpDests = await listCpLinkedGroups(draft.sourceChatId);
    draft.stage = 'dest';
    await saveWiz(uid, draft);
    const panel = destPanel(draft);
    const sent = await api.sendMessage({ chat_id: uid, text: panel.text, parse_mode: 'HTML', reply_markup: panel.reply_markup }).catch(() => null);
    if (sent?.message_id) { draft.panelId = sent.message_id; await saveWiz(uid, draft); }
    return true;
  }
  if (draft.stage === 'dest') {
    const r = await resolveTypedChat(uid, value, draft.sourceChatId);
    if (r.error) { await sendDm(uid, `❌ ${r.error}`); return true; }
    if (String(r.chat.chatId) === String(draft.sourceChatId)) {
      await sendDm(uid, '❌ A chat can\'t relay into itself — pick a different destination.');
      return true;
    }
    if (!draft.dests.some((d) => String(d.chatId) === String(r.chat.chatId))) {
      draft.dests.push({ chatId: r.chat.chatId, title: r.chat.title, type: r.chat.type, consentMode: r.chat.consentMode ?? 'owner_admin' });
      if (!draft.eligible.some((c) => String(c.chatId) === String(r.chat.chatId))) draft.eligible.push(r.chat);
      await saveWiz(uid, draft);
    }
    if (draft.panelId) {
      const panel = destPanel(draft);
      await editPanel(uid, draft.panelId, panel.text, panel.reply_markup);
    }
    return true;
  }
  return false;
}

/** Wizard + rule-action buttons (callback_query 'relay:' delegation). */
export async function handleRelayCallback({ userId, data, messageId }, deps = {}) {
  const uid = userId;
  const [, sub, arg] = String(data).split(':');

  // Rule actions ride the same prefix (from /relay list buttons).
  if (sub === 'pause' || sub === 'resume' || sub === 'del' || sub === 'delok') {
    const ruleId = Number(arg);
    if (sub === 'pause') {
      const r = await pauseRelayRule(uid, ruleId);
      if (r.error) return { text: 'That rule isn\'t yours (anymore).', alert: true };
      await editPanel(uid, messageId, `⏸ Relay rule #${ruleId} paused. /relay resume ${ruleId} restarts it after a consent re-check.`, null);
      return { text: 'Paused' };
    }
    if (sub === 'resume') {
      const r = await resumeRelayRule(uid, ruleId);
      if (r.error === 'not_found') return { text: 'That rule isn\'t yours (anymore).', alert: true };
      if (r.error) { await sendDm(uid, `❌ Rule #${ruleId} can't resume: ${r.reason}`); return { text: 'Resume refused', alert: true }; }
      await editPanel(uid, messageId, `▶️ Relay rule #${ruleId} is live again — consent re-checked at both ends.`, null);
      return { text: 'Live' };
    }
    if (sub === 'del') {
      await editPanel(uid, messageId,
        `🗑 Delete relay rule #${ruleId}? The rule and its destinations go away for good (delivery history goes with them).`,
        { inline_keyboard: [
          [{ text: '🗑 Yes, delete it', callback_data: `relay:delok:${ruleId}` }],
          [{ text: 'Keep it', callback_data: 'relay:cancel' }],
        ] });
      return { text: 'Confirm delete' };
    }
    const r = await deleteRelayRule(uid, ruleId);
    if (r.error) return { text: 'That rule isn\'t yours (anymore).', alert: true };
    await editPanel(uid, messageId, `🗑 Relay rule #${ruleId} deleted.`, null);
    return { text: 'Deleted' };
  }

  if (sub === 'new') {
    const r = await startRelayWizard(uid);
    return { text: r.started ? 'Pick the source' : 'Relay not available on your plan', alert: !r.started };
  }
  if (sub === 'cancel') {
    await clearWiz(uid);
    await editPanel(uid, messageId, '❌ Relay wizard cancelled.', null);
    return { text: 'Cancelled' };
  }

  const draft = await loadWiz(uid);
  if (!draft) return { text: 'That setup expired — run /relay new to start again.', alert: true };
  // Old drafts (pre-W2) may lack the options fields — backfill in place.
  draft.filters = normalizeRelayFilters(draft.filters);
  draft.clean = normalizeRelayClean(draft.clean);
  draft.footer = draft.footer ?? '';
  draft.attribution = draft.attribution ?? 'copy';
  draft.cpDests = draft.cpDests ?? [];
  const renderOptions = async () => {
    const panel = optionsPanel(draft, await relayEntitlement(uid));
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
  };

  if (sub === 'src') {
    const c = draft.eligible.find((x) => String(x.chatId) === String(arg));
    if (!c) return { text: 'That chat is no longer on your list.', alert: true };
    draft.sourceChatId = c.chatId; draft.sourceTitle = c.title; draft.sourceKind = c.type;
    draft.cpDests = await listCpLinkedGroups(draft.sourceChatId);
    draft.stage = 'dest';
    await saveWiz(uid, draft);
    const panel = destPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: `Source: ${c.title}` };
  }
  if (sub === 'dst') {
    const own = draft.eligible.find((x) => String(x.chatId) === String(arg));
    const linked = (draft.cpDests ?? []).find((x) => String(x.chatId) === String(arg));
    const c = own ?? linked;
    if (!c) return { text: 'That chat is no longer on your list.', alert: true };
    const i = draft.dests.findIndex((d) => String(d.chatId) === String(arg));
    if (i >= 0) draft.dests.splice(i, 1);
    else draft.dests.push({ chatId: c.chatId, title: c.title, type: c.type, consentMode: own ? 'owner_admin' : 'cp_link' });
    await saveWiz(uid, draft);
    const panel = destPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: i >= 0 ? 'Removed' : 'Added' };
  }
  if (sub === 'dst_done') {
    if (!draft.dests.length) return { text: 'Pick at least one destination first.', alert: true };
    draft.stage = 'options';
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: 'Options' };
  }
  if (sub === 'scope') {
    draft.scope = draft.scope === 'all' ? 'admins' : 'all';
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: draft.scope === 'all' ? 'All non-command posts' : 'Admin posts only' };
  }
  if (sub === 'noop') return { text: 'Tap a row to toggle it' };
  if (sub === 'opts') {
    draft.sub = null;
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: 'Options' };
  }
  if (sub === 'med') {
    draft.sub = 'media';
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: 'Media blocks' };
  }
  if (sub === 'medt') {
    if (RELAY_MEDIA_KINDS.includes(arg)) {
      draft.filters.blockMedia[arg] = !draft.filters.blockMedia[arg];
      await saveWiz(uid, draft);
      await renderOptions();
      return { text: draft.filters.blockMedia[arg] ? `${arg} blocked` : `${arg} allowed` };
    }
    return { text: 'Unknown media type', alert: true };
  }
  if (sub === 'lnk') {
    draft.filters.blockLinks = !draft.filters.blockLinks;
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: draft.filters.blockLinks ? 'Posts with links will be filtered' : 'Links allowed' };
  }
  if (sub === 'cln') {
    const map = { tme: 'stripTme', url: 'stripUrls', men: 'stripMentions' };
    const k = map[arg];
    if (!k) return { text: 'Unknown cleaning toggle', alert: true };
    draft.clean[k] = !draft.clean[k];
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: draft.clean[k] ? 'Cleaning step on' : 'Cleaning step off' };
  }
  if (sub === 'attr') {
    draft.attribution = draft.attribution === 'forward' ? 'copy' : 'forward';
    await saveWiz(uid, draft);
    await renderOptions();
    return { text: draft.attribution === 'forward' ? 'Forwarded — keeps the credit' : 'Copies — native look' };
  }
  if (sub === 'blk' || sub === 'alw' || sub === 'rep' || sub === 'ftr') {
    draft.textStep = sub;
    await saveWiz(uid, draft);
    await sendDm(uid, WIZ_TEXT_PROMPTS[sub]);
    return { text: 'Type it in this chat' };
  }
  if (sub === 'review') {
    draft.stage = 'confirm';
    await saveWiz(uid, draft);
    const panel = await confirmPanel(draft, uid);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Review it' };
  }
  if (sub === 'create') {
    const res = await createRelayRule(uid, {
      source: { id: draft.sourceChatId, type: draft.sourceKind, title: draft.sourceTitle },
      dests: draft.dests.map((d) => ({ id: d.chatId, type: d.type, title: d.title, consentMode: d.consentMode })),
      scope: draft.scope,
      attribution: draft.attribution,
      filters: draft.filters,
      clean: draft.clean,
      branding: { footer: draft.footer ?? '' },
    });
    if (res.error === 'tier_zero' || res.error === 'tier_cap') {
      await clearWiz(uid);
      await editPanel(uid, messageId,
        `❌ Your ${res.tier} plan allows ${res.limit} relay rule(s) — this one doesn't fit. Nothing was created.`, null);
      return { text: 'Tier limit', alert: true };
    }
    if (res.error) {
      // Consent/shape failures surface ON the panel — the wizard stays
      // open so the owner can fix the pick instead of starting over.
      await editPanel(uid, messageId,
        `❌ Can't create that rule yet: ${esc(res.reason)}\n\nFix it (add PB / sort the admin side) and tap Create again, or Cancel.`,
        { inline_keyboard: [
          [{ text: '✅ Create rule', callback_data: 'relay:create' }],
          [{ text: '❌ Cancel', callback_data: 'relay:cancel' }],
        ] });
      return { text: 'Check the panel', alert: true };
    }
    await clearWiz(uid);
    const destNames = res.destinations.map((d) => esc(d.destTitle ?? d.destChatId)).join(', ');
    await editPanel(uid, messageId,
      `✅ <b>Relay rule #${res.rule.id} is live</b>\n\n` +
      `${esc(res.rule.sourceTitle)} → ${destNames}\n\n` +
      'New posts start copying within seconds. /relay lists your rules; /relay pause ' + res.rule.id + ' stops this one any time.', null);
    return { text: 'Rule live' };
  }
  return { text: 'Unknown relay action', alert: true };
}

// ── Stats (spec §10) ──────────────────────────────────────────────────────
// Rows are truth: lifetime counters come from refreshRuleCounters;
// windows and per-reason totals are counted from delivery rows
// directly (the 30-day retention bounds the windows, §7.3).

export const RELAY_FILTER_REASON_LABEL = {
  protected: 'protected content', media_type: 'media type', link_block: 'links',
  keyword: 'block word', no_allow_match: 'no allow-word match', cleaned_empty: 'empty after cleaning',
};

function agoText(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export async function relayRuleStats(ruleId) {
  const found = await getRelayRule(ruleId);
  if (!found) return null;
  const counters = await refreshRuleCounters(found.id);
  const rule = await getRelayRule(found.id);
  const dests = await listRuleDestinations(rule.id);
  // ts columns store unix SECONDS on this platform — Date objects in
  // comparisons throw (caught → empty), so windows compare in seconds.
  const since7 = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);
  const since30 = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
  const rows7 = await db.select({ status: relay_deliveries.status }).from(relay_deliveries)
    .where(and(eq(relay_deliveries.ruleId, rule.id), gte(relay_deliveries.createdAt, since7)))
    .all().catch(() => []);
  let relayed7 = 0, filtered7 = 0;
  for (const r of rows7) {
    if (r.status === 'sent') relayed7++;
    else if (r.status === 'filtered') filtered7++;
  }
  const fRows = await db.select({ filterReason: relay_deliveries.filterReason }).from(relay_deliveries)
    .where(and(
      eq(relay_deliveries.ruleId, rule.id),
      eq(relay_deliveries.status, 'filtered'),
      gte(relay_deliveries.createdAt, since30),
    )).all().catch(() => []);
  const byReason = {};
  for (const r of fRows) {
    const k = r.filterReason ?? 'other';
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  const anchor = rule.lastRelayAt ? new Date(rule.lastRelayAt) : new Date(rule.createdAt);
  const quietDays = Math.max(0, Math.floor((Date.now() - anchor.getTime()) / 86400000));
  return { rule, counters, dests, relayed7, filtered7, byReason, quietDays };
}

const DEST_STATE_LABEL = (d) => (d.status === 'active'
  ? 'active'
  : `${d.status}${d.pauseReason ? ` (${d.pauseReason})` : ''}`);

export async function relayStatsText(ownerId, ruleId) {
  const s = await relayRuleStats(ruleId);
  if (!s || s.rule.ownerId !== String(ownerId)) return null;
  const { rule, counters, dests } = s;
  const lines = [
    `📡 <b>Relay rule #${rule.id} — stats</b>`,
    `${esc(rule.sourceTitle ?? rule.sourceChatId)} (${rule.sourceKind}) → ${dests.length} destination(s) · ${rule.status} · ${rule.attribution === 'forward' ? 'forwarded' : 'copies'}`,
    '',
    '<b>Destinations</b>',
  ];
  for (const d of dests) {
    lines.push(`• ${esc(d.destTitle ?? d.destChatId)} — ${d.consentMode === 'cp_link' ? 'Path B · Cross Protect link' : 'Path A · your admin'} · ${DEST_STATE_LABEL(d)}${d.failCount ? ` · ${d.failCount} consecutive failure(s)` : ''}`);
  }
  lines.push(
    '',
    `<b>Lifetime</b>: relayed ${counters.sent} · filtered ${counters.filtered} · cleaned ${counters.cleaned} · failed ${counters.failed}`,
    `<b>Last 7 days</b>: relayed ${s.relayed7} · filtered ${s.filtered7}`,
  );
  const reasons = Object.entries(s.byReason);
  if (reasons.length) {
    lines.push(`<b>Filtered reasons (30d)</b>: ${reasons.map(([k, n]) => `${RELAY_FILTER_REASON_LABEL[k] ?? k} ×${n}`).join(' · ')}`);
  }
  lines.push(rule.lastRelayAt
    ? `Last relay: ${agoText(rule.lastRelayAt)}`
    : `No posts seen yet${s.quietDays > 0 ? ` — nothing in ${s.quietDays} day(s); a quiet source can also mean PB lost access (the audit keeps checking)` : ''}`);
  if (rule.lastError) lines.push(`Last error: ${esc(rule.lastError)}`);
  return lines.join('\n');
}

// ── Commands ────────────────────────────────────────────────────────────────

const STATUS_ICON = {
  active: '▶️', paused_owner: '⏸', paused_tier: '⏸💎',
  paused_consent: '⏸🛡', paused_source_lost: '⏸❓', deleted: '🗑',
};

async function ruleListText(ownerId) {
  const rules = await listOwnerRules(ownerId);
  const ent = await relayEntitlement(ownerId);
  const cap = Number.isFinite(ent.limit) ? `${rules.length}/${ent.limit}` : `${rules.length}/∞`;
  if (!rules.length) {
    return '📡 <b>PB Relay — your rules</b>\n\n' +
      'No rules yet. A relay rule copies new posts from a channel/group you admin into other chats you admin — announcements land everywhere at once, no manual forwarding.\n\n' +
      (ent.limit === 0
        ? `Relay opens at Builder (Builder 1 rule · Pro 5 · Agency unlimited) — your ${ent.tier} plan includes 0.`
        : 'Tap below (or /relay new) to build your first rule.');
  }
  const lines = [`📡 <b>PB Relay — your rules</b> (${cap} on ${ent.tier})\n`];
  for (const r of rules) {
    const dests = await listRuleDestinations(r.id);
    const destNames = dests.map((d) => `${esc(d.destTitle ?? d.destChatId)}${d.consentMode === 'cp_link' ? ' (via CP link)' : ''}${d.status !== 'active' ? ` [${DEST_STATE_LABEL(d)}]` : ''}`).join(', ');
    const rf = parseRelayFilters(r);
    const marks =
      `${(rf.blockKeywords.length || rf.allowKeywords.length || rf.blockLinks || RELAY_MEDIA_KINDS.some((k) => rf.blockMedia[k])) ? ' 🛡' : ''}` +
      `${cleanIsActive(parseRelayClean(r)) ? ' 🧹' : ''}` +
      `${parseRelayBranding(r).footer ? ' ✍️' : ''}`;
    lines.push(
      `${STATUS_ICON[r.status] ?? ''} <b>#${r.id}</b> ${esc(r.name ?? r.sourceTitle ?? r.sourceChatId)}${marks}\n` +
      `   ${esc(r.sourceTitle ?? r.sourceChatId)} → ${destNames || '—'}\n` +
      `   ${r.status} · relayed ${r.relayedCount} · filtered ${r.filteredCount} · cleaned ${r.cleanedCount} · failed ${r.failedCount} · last ${r.lastRelayAt ? agoText(r.lastRelayAt) : 'never'}`,
    );
  }
  lines.push('\n/relay pause &lt;id&gt; · /relay resume &lt;id&gt; · /relay del &lt;id&gt; · /relay stats &lt;id&gt; · /relay block &lt;id&gt; &lt;word&gt; · /relay footer &lt;id&gt; &lt;text&gt;');
  return lines.join('\n');
}

export const RELAY_COMMANDS = {
  relay: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    if (!fromId) return;
    const raw = String(args ?? '').trim();
    const rm = raw.match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/);
    const sub = rm?.[1] ?? '';
    const arg = rm?.[2];
    const rest = (rm?.[3] ?? '').trim();
    const isPrivate = msg?.chat?.type === 'private';

    if (!isPrivate) {
      // In-group: admin-gated view of the rules touching THIS chat
      // (the destination admin's visibility, spec §8).
      if (!(await isChatAdmin(chatId, fromId).catch(() => false)) && !(await isOwnerId(fromId).catch(() => false))) {
        await sendSafe(chatId, '🔒 Only this group\'s admins can see its relay rules.');
        return;
      }
      if (sub === 'resume') {
        // Destination-side re-consent (Wave 3): an admin of THIS chat
        // undoes its own /relaystop pause. The owner's DM resume can
        // never do this — consent revoked one-sidedly is restored
        // one-sidedly, from the side that revoked it.
        const ruleId = Number(arg);
        if (!Number.isInteger(ruleId) || ruleId <= 0) {
          await sendSafe(chatId, 'Usage: /relay resume <rule id> — re-consent this chat as a relay destination after a /relaystop.');
          return;
        }
        const r = await resumeRelayDestination(chatId, ruleId, fromId);
        if (r.error === 'not_found') { await sendSafe(chatId, `Rule #${ruleId} has no destination in this chat.`); return; }
        if (r.error) { await sendSafe(chatId, `❌ Can't re-open relays into this chat: ${r.reason}`); return; }
        await sendSafe(chatId, r.already
          ? `📡 Rule #${ruleId} already flows into this chat.`
          : `📡 Rule #${ruleId} flows into this chat again — re-consent recorded, consent re-checked first.`);
        return;
      }
      const touching = [];
      const srcRules = await db.select().from(relay_rules)
        .where(eq(relay_rules.sourceChatId, String(chatId))).all().catch(() => []);
      for (const r of srcRules) if (r.status !== 'deleted') touching.push({ r, via: 'source' });
      const destRows = await db.select().from(relay_rule_destinations)
        .where(eq(relay_rule_destinations.destChatId, String(chatId))).all().catch(() => []);
      for (const d of destRows) {
        const r = await getRelayRule(d.ruleId);
        if (r && r.status !== 'deleted') touching.push({ r, via: 'destination' });
      }
      if (!touching.length) {
        await sendSafe(chatId, '📡 No relay rules touch this chat. Admins can stop any future relay here with /relaystop.');
        return;
      }
      const lines = ['📡 <b>Relay rules touching this chat</b>\n'];
      for (const { r, via } of touching) {
        lines.push(`#${r.id} (${via}) — ${esc(r.sourceTitle ?? r.sourceChatId)} · ${r.status} · owner ${r.ownerId}`);
      }
      lines.push('\n/relaystop stops them all from here.');
      await sendSafe(chatId, lines.join('\n'), { parse_mode: 'HTML' });
      return;
    }

    // DM surface.
    if (!raw || sub === 'list') {
      const text = await ruleListText(fromId);
      const ent = await relayEntitlement(fromId);
      await sendSafe(chatId, text, {
        parse_mode: 'HTML',
        ...(ent.limit !== 0
          ? { reply_markup: { inline_keyboard: [[{ text: '➕ New relay rule', callback_data: 'relay:new' }]] } }
          : {}),
      });
      return;
    }
    if (sub === 'new') {
      await startRelayWizard(fromId);
      return;
    }
    if (sub === 'pause' || sub === 'resume' || sub === 'del') {
      const ruleId = Number(arg);
      if (!Number.isInteger(ruleId) || ruleId <= 0) {
        await sendSafe(chatId, `Usage: /relay ${sub} <rule id> — /relay lists your rules with their ids.`);
        return;
      }
      if (sub === 'pause') {
        const r = await pauseRelayRule(fromId, ruleId);
        if (r.error) { await sendSafe(chatId, 'That rule isn\'t yours (anymore).'); return; }
        await sendSafe(chatId, r.already ? `Rule #${ruleId} is already paused (${r.rule.status}).` : `⏸ Relay rule #${ruleId} paused.`);
        return;
      }
      if (sub === 'resume') {
        const r = await resumeRelayRule(fromId, ruleId);
        if (r.error === 'not_found') { await sendSafe(chatId, 'That rule isn\'t yours (anymore).'); return; }
        if (r.error) { await sendSafe(chatId, `❌ Rule #${ruleId} can't resume: ${r.reason}`); return; }
        await sendSafe(chatId, r.already
          ? (r.reactivated?.length
            ? `▶️ Rule #${ruleId} was already live — ${r.reactivated.length} destination(s) re-validated and restored${r.heldRelaystop?.length ? ` (${r.heldRelaystop.length} still stopped by its own chat's admins — only they can re-open it, with /relay resume ${ruleId} inside that chat)` : ''}.`
            : `Rule #${ruleId} is already live.`)
          : `▶️ Relay rule #${ruleId} is live again — consent re-checked at both ends.`);
        return;
      }
      // del: confirm inline (the callback owns the second step).
      await sendSafe(chatId, `🗑 Delete relay rule #${ruleId}? This is the only delete — it can't be undone.`, {
        reply_markup: { inline_keyboard: [
          [{ text: '🗑 Yes, delete it', callback_data: `relay:delok:${ruleId}` }],
          [{ text: 'Keep it', callback_data: 'relay:cancel' }],
        ] },
      });
      return;
    }
    if (sub === 'stats') {
      const ruleId = Number(arg);
      if (!Number.isInteger(ruleId) || ruleId <= 0) {
        await sendSafe(chatId, 'Usage: /relay stats <rule id> — /relay lists your rules with their ids.');
        return;
      }
      const text = await relayStatsText(fromId, ruleId);
      if (!text) { await sendSafe(chatId, 'That rule isn\'t yours (anymore).'); return; }
      await sendSafe(chatId, text, { parse_mode: 'HTML' });
      return;
    }
    if (sub === 'block' || sub === 'unblock' || sub === 'allow' || sub === 'footer') {
      // Edit shortcuts (spec §8): small settings edits without the wizard.
      const ruleId = Number(arg);
      if (!Number.isInteger(ruleId) || ruleId <= 0 || !rest) {
        await sendSafe(chatId,
          sub === 'footer'
            ? 'Usage: /relay footer <id> <text> — or /relay footer <id> off to clear it.'
            : `Usage: /relay ${sub} <id> <word or phrase>.`);
        return;
      }
      if (sub === 'footer') {
        const ent = await relayEntitlement(fromId);
        if (!ent.canFooter && !/^off$/i.test(rest)) {
          await sendSafe(chatId, '✍️ The branding footer opens on Agency — your plan can\'t set one. /upgrade unlocks it.');
          return;
        }
        const r = await updateRelayRuleSettings(fromId, ruleId, (bag) => {
          bag.branding.footer = /^off$/i.test(rest) ? '' : rest.slice(0, 300);
        });
        if (r.error) { await sendSafe(chatId, 'That rule isn\'t yours (anymore).'); return; }
        await sendSafe(chatId, /^off$/i.test(rest)
          ? `✍️ Rule #${ruleId}: footer cleared.`
          : `✍️ Rule #${ruleId}: footer set — it rides every copy from the next post on.`);
        return;
      }
      const phrase = rest.slice(0, 64);
      const r = await updateRelayRuleSettings(fromId, ruleId, (bag) => {
        const listName = sub === 'allow' ? 'allowKeywords' : 'blockKeywords';
        const list = bag.filters[listName];
        const i = list.findIndex((w) => w.toLowerCase() === phrase.toLowerCase());
        if (sub === 'unblock') { if (i >= 0) list.splice(i, 1); }
        else if (i < 0) list.push(phrase);
      });
      if (r.error) { await sendSafe(chatId, 'That rule isn\'t yours (anymore).'); return; }
      const now = parseRelayFilters(r.rule);
      await sendSafe(chatId, sub === 'allow'
        ? `✅ Rule #${ruleId}: allow list is now [${now.allowKeywords.join(', ') || 'empty — everything crosses'}].`
        : `🚫 Rule #${ruleId}: block list is now [${now.blockKeywords.join(', ') || 'empty'}].`);
      return;
    }
    await sendSafe(chatId,
      '📡 PB Relay commands\n\n' +
      '/relay — your rules\n' +
      '/relay new — build a rule (source → destinations → options)\n' +
      '/relay pause <id> · /relay resume <id> · /relay del <id>\n' +
      '/relay stats <id> — counts, destination states, last activity\n' +
      '/relay block <id> <word> · /relay unblock <id> <word> · /relay allow <id> <word>\n' +
      '/relay footer <id> <text|off> — branding footer (Agency)\n\n' +
      'In a group: /relay shows rules touching that chat, /relaystop stops them, /relay resume <id> re-consents a destination your chat stopped, /relayhere offers the chat to your wizard.');
  },

  relaystop: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    if (!fromId) return;
    if (msg?.chat?.type === 'private') {
      await sendSafe(chatId, 'ℹ️ /relaystop works inside the group or channel it should protect — run it there as an admin.');
      return;
    }
    if (!(await isChatAdmin(chatId, fromId).catch(() => false)) && !(await isOwnerId(fromId).catch(() => false))) {
      await sendSafe(chatId, '🔒 Only this chat\'s admins can stop its relays.');
      return;
    }
    const res = await stopRelaysForChat(chatId, fromId);
    if (!res.affected && !res.destPaused && !res.rulesPaused) {
      await sendSafe(chatId, '📡 Nothing to stop — no active relay touches this chat.');
      return;
    }
    await sendSafe(chatId,
      `🛑 Relay stopped for this chat: ${res.rulesPaused} rule(s) paused at the source, ${res.destPaused} destination(s) paused. ` +
      'Affected owners were DM\'d. A stopped destination re-opens only from inside that chat: an admin there runs /relay resume <rule id> (the re-consent is that side\'s to give).');
  },

  relayhere: async (chatId, args, msg) => {
    const fromId = msg?.from?.id;
    if (!fromId) return;
    if (msg?.chat?.type === 'private') {
      await sendSafe(chatId, 'ℹ️ Run /relayhere inside the group you want to offer to your relay wizard.');
      return;
    }
    if (!(await isChatAdmin(chatId, fromId).catch(() => false))) {
      await sendSafe(chatId, '🔒 Only this group\'s admins can offer it to a relay wizard.');
      return;
    }
    await setConfig(hereKey(fromId), JSON.stringify({
      chatId: String(chatId), title: msg.chat.title ?? String(chatId),
      type: msg.chat.type ?? 'supergroup', at: Date.now(),
    })).catch(() => {});
    await sendSafe(chatId,
      '📡 Noted — this chat now leads your pick list when you run /relay new in a DM with PB. (Offer lasts 30 minutes.)');
  },
};

// ── Telegram ↔ Discord mirror (Mirror wave, 2026-10-23) ────────────────────
// Rowdy's explicit tap 2026-10-23 ~22:40 PDT ("Build it — full two-way
// mirror"): a scoped carve-out to the sealed-communities rule, pairing ONLY
// the Telegram home group with Discord #general-chat, member chat only,
// both directions. This section is the ENTIRE tgcloud side of the mirror —
// it lives here (not a new module) because the platform hard-caps the app
// at 100 modules and PB sits AT the cap.
//
// TRANSPORT (why not a direct call — read before "fixing" this): the
// platform's initData gate 401s unauthenticated external POSTs (proven
// 2026-10-23: POST /api/signal with no initData → 401, endpoint never
// runs), so the Discord worker CANNOT call a tgcloud endpoint directly,
// and the isolate holds no Discord token (nor a Telegram token the worker
// could use). The transport is therefore the mirror daemon: a 5-minute
// agent cron that loops 60-second cycles and (a) pulls pending tg_dc
// rows via the mirrorPoll endpoint action and posts them to Discord via
// REST, and (b) polls Discord REST for new #general-chat messages and
// delivers them via the mirrorRelay endpoint action. The daemon
// authenticates to the endpoint actions with owner initData (the CLI
// run's --ctx, same shape as the tick) PLUS an HMAC over the request
// body keyed by PB_WEB_SYNC_SECRET (the websync bridge scheme) —
// mirrorVerifyAction enforces both. No new shared database: the queue
// IS mirror_queue in this app's own DB; the daemon holds no state but
// its cursor (a workspace file) and reads the pair toggle from the
// Discord .env / PG mirror_state it already owns.
//
// LOOP PREVENTION — three independent layers; ANY ONE breaks a cycle:
//   1. Bot-authorship: relayed messages are sent BY PB (Telegram) / by
//      the bot token (Discord). Telegram never webhooks a bot its own
//      messages, and the daemon skips author.bot on Discord. A relayed
//      message physically cannot re-enter as input.
//   2. Marker: every relayed message carries ⟦mirror:tg⟧ / ⟦mirror:dc⟧.
//      Both intake filters (mirrorShouldRelay here, the daemon's Discord
//      filter) refuse any message containing ⟦mirror: — even a human
//      copy-paste of a relayed message cannot bounce.
//   3. Dedupe map: mirror_queue's (direction, source_msg_id) unique key.
//      A re-offered source id resolves to an existing row (done/dead)
//      and is skipped, never re-queued or re-sent.
// A crash between a far-side send and its DONE write can duplicate ONE
// message (the window is a single DB write); the duplicate still carries
// the marker, so it can never cascade into a loop.
//
// KILL SWITCHES (any one stops everything; all are checked on every path):
//   · tgcloud config mirror_off (canonical boolean — /setkey MIRROR_OFF 1
//     in the PB DM, or the mirrorSetFlag endpoint action): the hook
//     stops enqueueing AND the poll/relay actions refuse.
//   · Discord .env MIRROR_OFF (read fresh by the daemon every cycle):
//     the daemon skips the whole cycle — no poll, no relay.
//   · Discord PG mirror_state pair_on=false (the /mirror owner toggle's
//     future home; the daemon reads it every cycle, fail-last-known):
//     same whole-cycle skip. Until the toggle lands, the env flag +
//     /setkey flag are the live switches.
// RATE GUARD: 20 sends/minute/direction, counted from mirror_queue DONE
// rows in the last 60s. Over-cap TG→DC rows wait (the poll returns only
// the remaining budget; rows older than 10 min are swept to dead).
// Over-cap DC→TG messages are written DEAD with detail 'rate' (dropped
// + logged, never queued unboundedly).

export const MIRROR_TG_CHAT_ID = '-1003931169299';
export const MIRROR_MARKER = '⟦mirror:';
export const MIRROR_RATE_PER_MIN = 20;
export const MIRROR_STALE_SEC = 600; // pending tg_dc rows older than this are swept to dead
export const MIRROR_MAX_TG_TEXT = 3900; // Telegram send cap headroom (limit 4096)
// Dead-row surfacing (wave 2, 2026-11-06): a dead mirror row is a
// write-only tombstone unless a reader looks at it. Failure details are
// the three writer constants (bare or suffixed with ': <error>' — the
// prefix is the classifier, so suffixes keep matching). Intentional
// drops (command/marker/empty/rate) are policy, never failures.
export const MIRROR_DEAD_FAILURE_PREFIXES = ['relay_failed', 'send_failed', 'stale'];
const MIRROR_DEAD_SURFACED_KEY = 'mirror_dead_surfaced'; // config JSON array of surfaced queue ids
const MIRROR_DEAD_MAX_ROWS = 10; // proofs emitted per livePath run (oldest first)
const MIRROR_DEAD_SURFACED_CAP = 200; // surfaced-set bound; dead rows are rare
const MIRROR_ANON_ADMIN_ID = 1087968824; // @GroupAnonymousBot — a human admin posting anonymously

function mirrorNowSec() { return Math.floor(Date.now() / 1000); }

/** tgcloud-side kill switch: config mirror_off (canonical boolean reader). */
export async function mirrorIsOff() {
  try { return await getConfigFlag('mirror_off'); } catch { return false; }
}

/** Display-name hygiene: one line, capped — a name must never break the attribution header. */
export function mirrorCleanName(name) {
  return String(name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 64) || 'Someone';
}

function mirrorMediaKind(message) {
  if (message?.photo?.length) return 'photo';
  if (message?.video) return 'video';
  if (message?.animation) return 'gif';
  if (message?.sticker) return 'sticker';
  if (message?.document) return 'file';
  if (message?.voice) return 'voice';
  if (message?.video_note) return 'video message';
  if (message?.audio) return 'audio';
  return null;
}

/**
 * Pure intake filter — the unit-testable heart of the mirror. Returns
 * { ok: true, text, mediaKind } for a relayable message, or
 * { ok: false, reason } for a skip. Reasons: not_paired | bot | command
 * | marker | empty. Callers add their own kill-switch/rate/dedupe layers
 * around it; this function decides ONLY "is this message mirrorable?".
 */
export function mirrorShouldRelay(chatId, message) {
  if (String(chatId) !== MIRROR_TG_CHAT_ID) return { ok: false, reason: 'not_paired' };
  const from = message?.from;
  if (!from) return { ok: false, reason: 'empty' };
  // Bots never mirror — except the anonymous-admin pseudo-bot, which IS a
  // human admin posting anonymously (PB Relay's hook makes the same call).
  if (from.is_bot && from.id !== MIRROR_ANON_ADMIN_ID) return { ok: false, reason: 'bot' };
  const text = message?.text ?? message?.caption ?? null;
  if (typeof text === 'string' && text.length) {
    if (text.startsWith('/')) return { ok: false, reason: 'command' };
    if (text.includes(MIRROR_MARKER)) return { ok: false, reason: 'marker' };
    return { ok: true, text: text.slice(0, 4000), mediaKind: null };
  }
  const mediaKind = mirrorMediaKind(message);
  if (mediaKind) {
    // v1 placeholder: media itself rides in v2; a trace line rides now so
    // a shared photo is never silently dropped without a trace.
    return { ok: true, text: null, mediaKind };
  }
  return { ok: false, reason: 'empty' };
}

/**
 * Telegram message hook — called from handlers/message.js beside
 * relayGroupHook (both the text path and the caption-less media path),
 * fail-open: it NEVER throws into the handler. Enqueues one pending
 * tg_dc row; the daemon does the Discord post. Idempotent: the
 * (direction, source_msg_id) unique key + a pre-check make a double
 * hook call a no-op.
 */
export async function mirrorGroupHook(chatId, message) {
  try {
    if (await mirrorIsOff()) return { skipped: 'off' };
    const verdict = mirrorShouldRelay(chatId, message);
    if (!verdict.ok) return { skipped: verdict.reason };
    const sourceMsgId = String(message.message_id);
    const existing = await db.select().from(mirror_queue)
      .where(and(eq(mirror_queue.direction, 'tg_dc'), eq(mirror_queue.sourceMsgId, sourceMsgId))).get()
      .catch(() => null);
    if (existing) return { skipped: 'duplicate' };
    const sender = mirrorCleanName(
      [message.from.first_name, message.from.last_name].filter(Boolean).join(' ')
      || message.from.username || 'Someone',
    );
    await db.insert(mirror_queue).values({
      direction: 'tg_dc',
      sourceMsgId,
      sourceSender: sender,
      text: verdict.text,
      mediaKind: verdict.mediaKind,
      status: 'pending',
      attempts: 0,
      tsSec: mirrorNowSec(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing().run().catch(() => {});
    return { ok: true, sourceMsgId };
  } catch (err) {
    console.error('[mirror:hook]', err?.message ?? err);
    return { error: true };
  }
}

async function mirrorDoneCountLastMin(direction) {
  const since = mirrorNowSec() - 60;
  const rows = await db.select().from(mirror_queue)
    .where(and(eq(mirror_queue.direction, direction), eq(mirror_queue.status, 'done'), gte(mirror_queue.tsSec, since))).all()
    .catch(() => []);
  return rows.length;
}

/**
 * Endpoint-action auth: owner initData AND a websync-shaped HMAC.
 * body = input minus 'sig'; sig must equal HMAC-SHA256(PB_WEB_SYNC_SECRET,
 * canonicalJSON(body)) and t must be within ±300s. Either failure is a
 * uniform refusal (the endpoint shell maps it to NOT_ACCEPTED, the same
 * posture as the Signal Inlet door). ctx is the CLI run's --ctx (owner)
 * or a Mini App caller's initData — non-owners never pass gate 1.
 */
export async function mirrorVerifyAction(input, ctx) {
  try {
    const callerId = ctx?.initData?.user?.id;
    if (!callerId || !(await isOwnerId(callerId).catch(() => false))) return false;
    const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
    if (!secret) return false;
    const t = Number(input?.t);
    if (!Number.isFinite(t) || Math.abs(mirrorNowSec() - t) > 300) return false;
    const sig = String(input?.sig ?? '');
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;
    const body = {};
    for (const k of Object.keys(input ?? {})) if (k !== 'sig') body[k] = input[k];
    const expected = await hmacHex(secret, canonicalJSON(body));
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

/** Dead-row failure classifier: detail starts with a failure prefix.
 *  Intentional drops (command/marker/empty/rate) never match. */
export function mirrorDeadIsFailure(detail) {
  const d = String(detail ?? '');
  return MIRROR_DEAD_FAILURE_PREFIXES.some((p) => d.startsWith(p));
}

/** Read unsurfaced dead FAILURE rows (oldest first, capped). Result
 *  form (F4, 2026-11-06): { ok: true, rows } on a good read, { ok: false,
 *  rows: [], error } when the DB read itself fails — a reader error is
 *  NOT "no dead rows". Sorted in JS (the query has no orderBy so the
 *  harness stub's descending sort cannot reorder it). Age is hours
 *  since death (updatedAt, else tsSec). */
export async function mirrorDeadFailureRowsResult() {
  let rows = [];
  try {
    rows = await db.select().from(mirror_queue)
      .where(eq(mirror_queue.status, 'dead')).limit(100).all();
  } catch (err) { return { ok: false, rows: [], error: err?.message ?? 'read failed' }; }
  const nowMs = Date.now();
  return {
    ok: true,
    rows: (rows ?? [])
    .filter((r) => mirrorDeadIsFailure(r?.detail))
    .map((r) => {
      const upd = r?.updatedAt ? new Date(r.updatedAt).getTime() : NaN;
      const base = Number.isFinite(upd) ? upd : (Number(r?.tsSec) || 0) * 1000;
      const ageHrs = base ? Math.max(0, Math.round((nowMs - base) / 360000) / 10) : null;
      return {
        id: Number(r?.id), direction: String(r?.direction ?? '?'),
        sourceMsgId: String(r?.sourceMsgId ?? '?'),
        sourceSender: String(r?.sourceSender ?? ''),
        detail: String(r?.detail ?? ''), attempts: Number(r?.attempts ?? 0),
        ageHrs,
      };
    })
    .filter((r) => Number.isFinite(r.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, MIRROR_DEAD_MAX_ROWS),
  };
}

/** Fail-open wrapper kept for display-only readers (the botStatus
 *  board): any DB error reads as "no dead rows" for this run — the rows
 *  stay dead in the queue and surface on the next run. The tick's
 *  livePath cycle MUST use mirrorDeadFailureRowsResult instead: it
 *  prunes streaks from this read, so it cannot afford to mistake an
 *  error for empty. */
export async function mirrorDeadFailureRows() {
  const r = await mirrorDeadFailureRowsResult();
  return r.ok ? r.rows : [];
}

/** Surfaced set: queue ids whose dead-row proof has already had its
 *  page chances. Stored as JSON in config (same shape as the livePath
 *  streaks). Result form (F4, 2026-11-06): a DB read error is
 *  { ok: false } — NOT "nothing surfaced", which would re-emit (and
 *  re-page) already-surfaced rows. A CORRUPT stored value is different:
 *  it never self-heals, so it keeps the wave-2 fail-open ({ ok: true,
 *  ids: [] } — re-emit once, page once more, surface again). */
export async function readMirrorDeadSurfacedResult() {
  let raw = '';
  try {
    raw = await getConfig(MIRROR_DEAD_SURFACED_KEY, '');
  } catch (err) { return { ok: false, ids: [], error: err?.message ?? 'read failed' }; }
  try {
    const arr = raw ? JSON.parse(raw) : [];
    return { ok: true, ids: Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [] };
  } catch { return { ok: true, ids: [] }; }
}

/** Fail-open wrapper kept for display-only readers (the botStatus
 *  board): a corrupt value reads as "nothing surfaced" so rows surface
 *  again. The tick's livePath cycle MUST use
 *  readMirrorDeadSurfacedResult instead — it must not re-emit
 *  already-surfaced rows on a transient read error. */
export async function readMirrorDeadSurfaced() {
  const r = await readMirrorDeadSurfacedResult();
  return r.ok ? r.ids : [];
}

export async function markMirrorDeadSurfaced(ids) {
  try {
    const cur = await readMirrorDeadSurfaced();
    const set = new Set(cur);
    for (const id of ids ?? []) if (Number.isFinite(id)) set.add(id);
    const arr = [...set].slice(-MIRROR_DEAD_SURFACED_CAP);
    await setConfig(MIRROR_DEAD_SURFACED_KEY, JSON.stringify(arr));
  } catch { /* best-effort: the proofs keep paging until it lands */ }
}

/** Poll action (daemon → tgcloud): pending tg_dc rows within the rate budget. */
export async function mirrorPollAction(input) {
  if (await mirrorIsOff()) return { ok: false, off: true };
  const now = mirrorNowSec();
  // Stale sweep: pending rows older than 10 min are dropped + logged, so
  // the queue can never grow unboundedly behind a dead Discord leg.
  const stale = await db.select().from(mirror_queue)
    .where(and(eq(mirror_queue.direction, 'tg_dc'), eq(mirror_queue.status, 'pending'), lt(mirror_queue.tsSec, now - MIRROR_STALE_SEC))).all()
    .catch(() => []);
  for (const row of stale) {
    await db.update(mirror_queue).set({ status: 'dead', detail: 'stale', updatedAt: new Date() })
      .where(eq(mirror_queue.id, row.id)).run().catch(() => {});
  }
  const budget = Math.max(0, MIRROR_RATE_PER_MIN - (await mirrorDoneCountLastMin('tg_dc')));
  if (budget <= 0) return { ok: true, items: [], budget: 0, swept: stale.length };
  const rows = await db.select().from(mirror_queue)
    .where(and(eq(mirror_queue.direction, 'tg_dc'), eq(mirror_queue.status, 'pending')))
    .orderBy(asc(mirror_queue.id)).limit(budget).all().catch(() => []);
  return {
    ok: true,
    items: rows.map((r) => ({
      id: r.id, sourceMsgId: r.sourceMsgId, sourceSender: r.sourceSender,
      text: r.text, mediaKind: r.mediaKind, tsSec: r.tsSec,
    })),
    budget, swept: stale.length,
  };
}

/** Ack action (daemon → tgcloud): confirm Discord posts / count failures. */
export async function mirrorAckAction(input) {
  const done = Array.isArray(input?.done) ? input.done : [];
  const failed = Array.isArray(input?.failed) ? input.failed : [];
  let acked = 0, dead = 0;
  for (const d of done) {
    const id = Number(d?.id);
    if (!Number.isFinite(id)) continue;
    const r = await db.update(mirror_queue).set({
      status: 'done', destMsgId: d?.destMsgId != null ? String(d.destMsgId) : null, updatedAt: new Date(),
    }).where(and(eq(mirror_queue.id, id), eq(mirror_queue.direction, 'tg_dc'))).run().catch(() => null);
    if (r) acked++;
  }
  for (const f of failed) {
    const id = Number(f?.id);
    if (!Number.isFinite(id)) continue;
    const row = await db.select().from(mirror_queue)
      .where(and(eq(mirror_queue.id, id), eq(mirror_queue.direction, 'tg_dc'))).get().catch(() => null);
    if (!row || row.status !== 'pending') continue;
    const attempts = (row.attempts ?? 0) + 1;
    if (attempts >= 3) {
      // Wave 2: keep the Discord HTTP code the daemon forwards (if any)
      // in the detail — the prefix stays 'send_failed' so the failure
      // classifier still matches, and the page carries the real cause.
      const code = Number(f?.code);
      const detail = Number.isFinite(code) && code > 0 ? `send_failed:http_${code}` : 'send_failed';
      await db.update(mirror_queue).set({ status: 'dead', attempts, detail, updatedAt: new Date() })
        .where(eq(mirror_queue.id, id)).run().catch(() => {});
      dead++;
    } else {
      await db.update(mirror_queue).set({ attempts, updatedAt: new Date() })
        .where(eq(mirror_queue.id, id)).run().catch(() => {});
    }
  }
  return { ok: true, acked, dead };
}

/** Render a Discord-origin message for Telegram (attribution + marker + caps). */
export function mirrorRenderForTelegram(sender, text, mediaKind) {
  const name = mirrorCleanName(sender);
  if (text) return `💬 ${name} via Discord ${MIRROR_MARKER}dc⟧\n${String(text).slice(0, MIRROR_MAX_TG_TEXT)}`;
  const kindLabel = mediaKind === 'photo' ? 'a photo' : mediaKind === 'video' ? 'a video'
    : mediaKind === 'gif' ? 'a GIF' : mediaKind === 'sticker' ? 'a sticker'
    : mediaKind === 'file' ? 'a file' : mediaKind === 'audio' ? 'an audio clip'
    : mediaKind === 'voice' ? 'a voice message' : mediaKind === 'video message' ? 'a video message'
    : 'media';
  return `📎 ${name} shared ${kindLabel} via Discord ${MIRROR_MARKER}dc⟧`;
}

async function mirrorInsertTerminalRow(direction, sourceMsgId, sender, text, mediaKind, status, destMsgId, detail) {
  await db.insert(mirror_queue).values({
    direction, sourceMsgId: String(sourceMsgId), sourceSender: mirrorCleanName(sender),
    text: text != null ? String(text).slice(0, 4000) : null, mediaKind: mediaKind ?? null,
    status, attempts: 0, destMsgId: destMsgId != null ? String(destMsgId) : null, detail: detail ?? null,
    tsSec: mirrorNowSec(), createdAt: new Date(), updatedAt: new Date(),
  }).onConflictDoNothing().run().catch(() => {});
}

/** Relay action (daemon → tgcloud): one Discord message → the Telegram home group. */
export async function mirrorRelayAction(input) {
  if (await mirrorIsOff()) return { ok: false, off: true };
  const sourceMsgId = String(input?.sourceMsgId ?? '');
  const sender = input?.sender ?? '';
  const text = typeof input?.text === 'string' ? input.text : null;
  const mediaKind = typeof input?.mediaKind === 'string' ? input.mediaKind : null;
  if (!sourceMsgId) return { ok: false, error: 'missing_source_msg_id' };
  const existing = await db.select().from(mirror_queue)
    .where(and(eq(mirror_queue.direction, 'dc_tg'), eq(mirror_queue.sourceMsgId, sourceMsgId))).get()
    .catch(() => null);
  if (existing) return { ok: true, skipped: 'duplicate', status: existing.status, destMsgId: existing.destMsgId ?? null };
  // Defense-in-depth: the daemon already filters these, but a re-offered
  // or hand-built relay must still land as a LOGGED drop, never a send.
  if (text != null && text.startsWith('/')) {
    await mirrorInsertTerminalRow('dc_tg', sourceMsgId, sender, text, mediaKind, 'dead', null, 'command');
    return { ok: true, skipped: 'command' };
  }
  if (text != null && text.includes(MIRROR_MARKER)) {
    await mirrorInsertTerminalRow('dc_tg', sourceMsgId, sender, text, mediaKind, 'dead', null, 'marker');
    return { ok: true, skipped: 'marker' };
  }
  if (text == null && mediaKind == null) {
    await mirrorInsertTerminalRow('dc_tg', sourceMsgId, sender, text, mediaKind, 'dead', null, 'empty');
    return { ok: true, skipped: 'empty' };
  }
  if ((await mirrorDoneCountLastMin('dc_tg')) >= MIRROR_RATE_PER_MIN) {
    await mirrorInsertTerminalRow('dc_tg', sourceMsgId, sender, text, mediaKind, 'dead', null, 'rate');
    return { ok: true, skipped: 'rate' };
  }
  const out = mirrorRenderForTelegram(sender, text, mediaKind);
  let sent;
  try {
    sent = await api.sendMessage({ chat_id: MIRROR_TG_CHAT_ID, text: out });
  } catch (err) {
    // No row written: the daemon retries this id next cycle (up to 3
    // cycles, then it calls mirrorDeadAction). A crash between this send
    // and the DONE write below can duplicate ONE message; the duplicate
    // carries the marker, so it can never loop back.
    return { ok: false, error: 'send_failed', detail: (err?.description ?? err?.message ?? 'unknown').slice(0, 200) };
  }
  const destMsgId = sent?.message_id != null ? String(sent.message_id) : null;
  await mirrorInsertTerminalRow('dc_tg', sourceMsgId, sender, text, mediaKind, 'done', destMsgId, null);
  return { ok: true, sent: true, destMsgId };
}

/** Dead action (daemon → tgcloud): give up on a dc_tg id after 3 failed relay cycles. */
export async function mirrorDeadAction(input) {
  const sourceMsgId = String(input?.sourceMsgId ?? '');
  if (!sourceMsgId) return { ok: false, error: 'missing_source_msg_id' };
  const existing = await db.select().from(mirror_queue)
    .where(and(eq(mirror_queue.direction, 'dc_tg'), eq(mirror_queue.sourceMsgId, sourceMsgId))).get()
    .catch(() => null);
  if (existing) return { ok: true, skipped: 'duplicate', status: existing.status };
  // Wave 2: keep the last relay error the daemon forwards (if any) in
  // the detail — the prefix stays 'relay_failed' so the failure
  // classifier still matches, and the page carries the real cause
  // instead of the bare constant. Without it, the row is exactly as
  // before: detail 'relay_failed'.
  const errText = typeof input?.error === 'string' ? input.error.trim().slice(0, 200) : '';
  const detail = errText ? `relay_failed: ${errText}` : 'relay_failed';
  await mirrorInsertTerminalRow('dc_tg', sourceMsgId, input?.sender ?? '', input?.text ?? null,
    input?.mediaKind ?? null, 'dead', null, detail);
  return { ok: true, dead: true };
}

/** Flag action (owner → tgcloud): set ONLY mirror_off ('1'/'0'). Test + admin seam. */
export async function mirrorSetFlagAction(input) {
  const value = String(input?.value ?? '');
  if (value !== '1' && value !== '0') return { ok: false, error: 'value_must_be_1_or_0' };
  await setConfig('mirror_off', value);
  return { ok: true, mirror_off: value };
}

/**
 * Test-enqueue action (owner → tgcloud): insert ONE pending tg_dc row with
 * caller-supplied fields, exactly as the handler would. Lets the daemon's
 * poll → Discord post → ack path be proven live without waiting on a
 * human post. Test rows are identifiable by their sourceMsgId prefix
 * ('test-') and sender 'MirrorTest'. Never used by production callers.
 */
export async function mirrorTestEnqueueAction(input) {
  const text = typeof input?.text === 'string' ? input.text.slice(0, 4000) : null;
  const mediaKind = typeof input?.mediaKind === 'string' ? input.mediaKind : null;
  if (text == null && mediaKind == null) return { ok: false, error: 'need_text_or_media' };
  const sourceMsgId = 'test-' + String(Math.floor(Date.now() / 1000)) + '-' + String(input?.tag ?? 'manual').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  await db.insert(mirror_queue).values({
    direction: 'tg_dc', sourceMsgId, sourceSender: 'MirrorTest',
    text, mediaKind, status: 'pending', attempts: 0,
    tsSec: mirrorNowSec(), createdAt: new Date(), updatedAt: new Date(),
  }).run();
  return { ok: true, sourceMsgId };
}

/** Endpoint dispatch table for endpoints/signal.js mirror actions. */
export const MIRROR_ACTIONS = {
  mirrorPoll: mirrorPollAction,
  mirrorAck: mirrorAckAction,
  mirrorRelay: mirrorRelayAction,
  mirrorDead: mirrorDeadAction,
  mirrorSetFlag: mirrorSetFlagAction,
  mirrorTestEnqueue: mirrorTestEnqueueAction,
};
