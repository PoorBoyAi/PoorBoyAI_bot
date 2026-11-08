// lib/digest.js — agent digests (Edge wave, item 3).
//
// The overnight rundown: one DM per user per UTC day summarising what
// their agents and alerts did while they were away. Sources are honest
// rows only — agent_runs for agent activity, user_activity_log for fired
// price alerts / whale watches (those cycles are one-shot / nonce-only,
// so the tick logs a row at fire time; see lib/tick.js). Nothing is
// fabricated: no rows in the window → no digest (buildDigest → null).
//
// Sealed per user: a digest is built from ONE telegramUserId's rows and
// sent only to that user's own DM. Opt-out lives on the user's
// user_settings.notifications.digest flag (false = opted out).
// Exports (the contract):
//   buildDigest(telegramUserId, sinceMs) -> { text, counts } | null
//   cycleDigests(opts = {})              -> per-cycle summary object
//   DIGEST_COMMANDS                      -> { digest: (chatId, args, msg) }
//   setDigestPref(telegramUserId, on)    -> upsert the opt-in/out flag

import { api, fetch } from 'sdk';
import db, { eq, desc, asc, gt, inArray } from 'sdk/db';
import {
  user_agents, agent_runs, user_activity_log, user_settings,
  pb_leads, dex_boost_leads, known_groups,
} from '../schema.js';
import { getConfig, setConfig, flagValueOn } from './config.js';
import { isOwnerId } from './groups.js';

const HOUR_MS = 3_600_000;

// ts() columns hand back Date objects; be lenient about numbers/strings
// so filtering in JS never depends on the driver's exact shape.
function toMs(v) {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') return n > 1e12 ? n : n * 1000;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : 0;
}

function sameUtcDate(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

// ── Opt-out preference ───────────────────────────────────────────────────────

async function isDigestOptedOut(userId) {
  try {
    const row = await db.select().from(user_settings)
      .where(eq(user_settings.telegramUserId, String(userId))).get();
    return row?.notifications?.digest === false;
  } catch {
    return false;
  }
}

export async function setDigestPref(userId, on) {
  try {
    let existing = null;
    try {
      existing = await db.select().from(user_settings)
        .where(eq(user_settings.telegramUserId, String(userId))).get();
    } catch { /* no readable row — insert path below still works */ }
    const notifications = { ...(existing?.notifications ?? {}), digest: !!on };
    await db.insert(user_settings)
      .values({
        telegramUserId: String(userId),
        shillStyle: 'hype',
        notifications,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: user_settings.telegramUserId,
        set: { notifications, updatedAt: new Date() },
      })
      .run();
    return true;
  } catch (err) {
    console.error('[digest setPref]', err?.message ?? err);
    return false;
  }
}

// ── Digest builder ───────────────────────────────────────────────────────────

export async function buildDigest(telegramUserId, sinceMs) {
  const uid = String(telegramUserId);
  const since = Number(sinceMs) || 0;

  let runs = [];
  try {
    const rows = await db.select().from(agent_runs)
      .where(eq(agent_runs.telegramUserId, uid))
      .orderBy(desc(agent_runs.ranAt))
      .limit(100)
      .all();
    runs = (rows ?? []).filter((r) => toMs(r.ranAt) >= since);
  } catch (err) {
    console.error('[digest build runs]', err?.message ?? err);
  }

  let activity = [];
  try {
    const rows = await db.select().from(user_activity_log)
      .where(eq(user_activity_log.telegramUserId, uid))
      .orderBy(desc(user_activity_log.createdAt))
      .limit(100)
      .all();
    activity = (rows ?? []).filter((r) => toMs(r.createdAt) >= since);
  } catch (err) {
    console.error('[digest build activity]', err?.message ?? err);
  }

  const priceAlerts = activity.filter((r) => r.kind === 'price_alert');
  const whaleWatches = activity.filter((r) => r.kind === 'whale_watch');

  const counts = {
    agentRuns: runs.length,
    agentFailed: runs.filter((r) => r.status === 'failed').length,
    priceAlerts: priceAlerts.length,
    whaleWatches: whaleWatches.length,
  };

  if (!counts.agentRuns && !counts.priceAlerts && !counts.whaleWatches) return null;

  // Map agentId → agentType in one select; runs whose agent was deleted
  // fall back to the generic 'agent' label.
  const typeById = new Map();
  if (runs.length) {
    try {
      const agents = await db.select().from(user_agents)
        .where(eq(user_agents.telegramUserId, uid))
        .all();
      for (const a of agents ?? []) typeById.set(a.id, a.agentType);
    } catch (err) {
      console.error('[digest build agents]', err?.message ?? err);
    }
  }

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [`🌅 Your PB overnight digest — ${dateStr}`];

  if (counts.agentRuns) {
    const ok = counts.agentRuns - counts.agentFailed;
    lines.push('');
    lines.push(`🤖 Agents: ${counts.agentRuns} ran · ${ok} ok · ${counts.agentFailed} failed`);
    for (const run of runs.slice(0, 5)) {
      const type = typeById.get(run.agentId) ?? 'agent';
      if (run.status === 'failed') {
        lines.push(`• ${type} — ⚠️ ${run.error ? String(run.error).slice(0, 90) : 'failed'}`);
      } else {
        lines.push(`• ${type} — ${run.summary ? String(run.summary).slice(0, 90) : 'ran successfully'}`);
      }
    }
    if (runs.length > 5) lines.push(`• …and ${runs.length - 5} more`);
  }

  if (counts.priceAlerts) {
    lines.push('');
    lines.push(`🔔 Price alerts fired: ${counts.priceAlerts}`);
    for (const row of priceAlerts.slice(0, 5)) lines.push(`• ${row.detail}`);
    if (priceAlerts.length > 5) lines.push(`• …and ${priceAlerts.length - 5} more`);
  }

  if (counts.whaleWatches) {
    lines.push('');
    lines.push(`🐋 Whale watches: ${counts.whaleWatches}`);
    for (const row of whaleWatches.slice(0, 5)) lines.push(`• ${row.detail}`);
    if (whaleWatches.length > 5) lines.push(`• …and ${whaleWatches.length - 5} more`);
  }

  lines.push('');
  lines.push('Manage with /digest — /digest off stops these.');

  const text = lines.join('\n').slice(0, 3500);
  return { text, counts };
}

// ── /digest command ──────────────────────────────────────────────────────────

export const DIGEST_COMMANDS = {
  digest: async (chatId, args, msg) => {
    let text;
    try {
      if (msg?.chat?.type !== 'private') {
        text = '🔒 That one needs a private chat — open a DM with me and run it there.';
      } else {
        const uid = msg?.from?.id ?? chatId;
        const cmd = String(args ?? '').trim().toLowerCase();
        if (cmd === 'off') {
          await setDigestPref(uid, false);
          text = "🌅 Digests off. You won't get the morning rundown anymore — /digest on brings it back.";
        } else if (cmd === 'on') {
          await setDigestPref(uid, true);
          text = '🌅 Digests on — first one lands the next morning you have overnight activity.';
        } else if (cmd === '') {
          const digest = await buildDigest(uid, Date.now() - 24 * HOUR_MS);
          text = digest?.text ?? '🌅 All quiet — your agents and alerts had nothing to report in the last 24 hours.';
        } else {
          text = 'Usage: /digest · /digest on · /digest off';
        }
      }
    } catch (err) {
      console.error('[digest command]', err?.message ?? err);
      text = '🌅 All quiet — your agents and alerts had nothing to report in the last 24 hours.';
    }
    try {
      await api.sendMessage({ chat_id: chatId, text });
    } catch (err) {
      if (err?.code !== 403) console.error('[digest send]', err?.code, err?.description ?? err?.message);
    }
  },
};

// ── Tick cycle ───────────────────────────────────────────────────────────────

export async function cycleDigests(opts = {}) {
  const summary = { candidates: 0, sent: 0, alreadySent: 0, skippedOptOut: 0, empty: 0, blocked: 0, failed: 0 };
  try {
    // Morning run only: before 13:00 UTC there is nothing to round up yet.
    if (!opts?.force && new Date().getUTCHours() < 13) return { skipped: 'before-13-utc' };

    const now = Date.now();
    const windowStart = now - 26 * HOUR_MS;

    // Candidates: distinct users with any real activity in the last 26h.
    const userSet = new Set();
    try {
      const rows = await db.select().from(agent_runs)
        .orderBy(desc(agent_runs.ranAt))
        .limit(500)
        .all();
      for (const r of rows ?? []) {
        if (r.telegramUserId && toMs(r.ranAt) >= windowStart) userSet.add(String(r.telegramUserId));
      }
    } catch (err) {
      console.error('[digest cycle runs]', err?.message ?? err);
    }
    try {
      const rows = await db.select().from(user_activity_log)
        .orderBy(desc(user_activity_log.createdAt))
        .limit(500)
        .all();
      for (const r of rows ?? []) {
        if (r.telegramUserId && toMs(r.createdAt) >= windowStart) userSet.add(String(r.telegramUserId));
      }
    } catch (err) {
      console.error('[digest cycle activity]', err?.message ?? err);
    }

    const users = [...userSet].slice(0, 50);
    summary.candidates = users.length;

    for (const uid of users) {
      try {
        if (await isDigestOptedOut(uid)) { summary.skippedOptOut++; continue; }

        const lastMs = Number(await getConfig(`digest:lastms:${uid}`, '0')) || 0;
        if (lastMs && sameUtcDate(lastMs, now)) { summary.alreadySent++; continue; }

        const since = Math.max(lastMs || (now - 26 * HOUR_MS), now - 48 * HOUR_MS);
        const digest = await buildDigest(uid, since);
        if (!digest) {
          // Marking on empty prevents rescanning the same quiet user every
          // tick for the rest of the day — their window produced nothing,
          // so there is nothing to send until new activity lands (new
          // activity makes them a candidate again on a later day/run).
          try { await setConfig(`digest:lastms:${uid}`, String(now)); } catch { /* best-effort */ }
          summary.empty++;
          continue;
        }

        let sendErr = null;
        try {
          await api.sendMessage({ chat_id: Number(uid), text: digest.text });
        } catch (err) {
          sendErr = err;
        }
        if (!sendErr) {
          try { await setConfig(`digest:lastms:${uid}`, String(now)); } catch { /* best-effort */ }
          summary.sent++;
        } else if (sendErr?.code === 403) {
          // Blocked the bot — don't retry daily; mark as handled for today.
          try { await setConfig(`digest:lastms:${uid}`, String(now)); } catch { /* best-effort */ }
          summary.blocked++;
        } else {
          // Generic failure: do NOT mark — the next tick retries.
          summary.failed++;
        }
      } catch (err) {
        console.error('[digest cycle user]', err?.message ?? err);
        summary.failed++;
      }
    }
    return summary;
  } catch (err) {
    console.error('[digest cycle]', err?.message ?? err);
    return { ...summary, error: err?.message ?? 'unknown' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAD FINDER — Autonomous Worker, Stage 1 (2026-10-20).
//
// PB finds work: projects that might buy an airdrop, a boost, a Studio ad
// or a bot subscription. FIND + SCORE + REPORT ONLY. This section never
// contacts a lead — there are no send paths to leads anywhere in it, and
// none may be added here "for later": outreach is a separate future stage.
//
// OWNER RULE — NO SPAM, EVER (Rowdy, 2026-10-20): PB never mass-blasts.
// Encoded here as: a deliberately HIGH digest threshold (fewer, better
// leads — a quiet day with no digest beats a noisy one), a digest capped
// at the top few entries, and durable 'do_not_contact'/'dismissed'
// suppression rows that re-scans can never resurrect. Any future outreach
// stage is bound by the same rule: selective, targeted, relevant,
// low-volume, one-shot, never uninvited into communities PB serves,
// inbound-first.
//
// Sources — each degrades honestly (reason recorded in the scan summary;
// leads are NEVER fabricated):
//   dex_boost  fresh observations in dex_boost_leads (kept current hourly
//              by lib/boost.js cycleDexBoostStream), consumed past a
//              cursor. The migrated seed — everything at/below the
//              install baseline — NEVER resurfaces as "new".
//   dex_new    DexScreener latest token-profiles feed (keyless public).
//   x_intent   X API v2 recent search for public asks matching PB's
//              services, via the config's TWITTER_BEARER_TOKEN (or an
//              app-only Bearer minted from the TWITTER_API_KEY/SECRET
//              pair). If the API tier refuses, the source reports
//              degraded with the real status — no invented results.
//   pb_surface groups that newly added PB (known_groups.firstSeen) and
//              tokens run through /scan (noteScan, called from
//              lib/verdict.js). Low volume, high warmth.
//
// Scoring is deterministic code (scoreLead) — no LLM in the loop, nothing
// gated on the decision layer. At/above LEAD_THRESHOLD → status 'new'
// (digest-eligible); below → 'raw' (stored for dedupe only).
// Exports: runLeadScan, cycleLeadFinder, noteScan, scoreLead, LEADS_COMMANDS.

const LEAD_THRESHOLD = 55;          // deliberately high — quality over noise
const LEAD_SCAN_INTERVAL_MS = 6 * HOUR_MS; // ≤ 4 scans/day, tick-gated
const LEAD_DIGEST_TOP = 3;          // top few, never a wall
const LEAD_LIST_TOP = 10;

const leadNowSec = () => Math.floor(Date.now() / 1000);

// ── Link / handle extraction ────────────────────────────────────────────────

// DexScreener profile links: [{ type, url }] or [{ label, url }].
function parseDexLinks(linksJson) {
  const out = { x: null, telegram: null, website: null };
  try {
    const arr = typeof linksJson === 'string' ? JSON.parse(linksJson) : linksJson;
    if (!Array.isArray(arr)) return out;
    for (const l of arr) {
      const url = String(l?.url ?? '');
      if (!url) continue;
      const type = String(l?.type ?? l?.label ?? '').toLowerCase();
      if (!out.x && (type.includes('twitter') || type === 'x' || /(^|\.)(x\.com|twitter\.com)\//.test(url))) out.x = url;
      else if (!out.telegram && (type.includes('telegram') || /t\.me\//.test(url))) out.telegram = url;
      else if (!out.website) out.website = url;
    }
  } catch { /* malformed linksJson — no links, scored accordingly */ }
  return out;
}

function xHandleFromUrl(url) {
  const m = String(url ?? '').match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/);
  return m ? `@${m[1]}` : null;
}

function tgHandleFromUrl(url) {
  const m = String(url ?? '').match(/t\.me\/([A-Za-z0-9_]{5,})(?:[/?#]|$)/);
  return m ? `@${m[1]}` : (url ? String(url) : null); // invite links stay as URLs
}

// Deterministic copycat screen: an established brand's name with no
// website of its own is treated as impersonation farming, not a project.
const COPYCAT_BRANDS = /^(uniswap|pancakeswap|raydium|jupiter|opensea|binance|coinbase|metamask|phantom|pump\.?fun)$/i;

// ── Scoring (pure, deterministic; exported for proofs) ─────────────────────

export function scoreLead(c) {
  let s = 0;
  if (c.source === 'dex_boost') s += 30;        // paying for promotion NOW
  else if (c.source === 'x_intent') s += 25;    // publicly asking for help
  else if (c.source === 'pb_surface') s += 25;  // already at PB's door
  else if (c.source === 'dex_new') s += 20;     // fresh launch / profile
  if (c.boosting) s += 10;
  if (c.fresh) s += 10;                          // launched / posted < 7d ago
  if (c.tokenAddress) s += 10;
  if (c.xHandle || c.xUrl) s += 10;
  if (c.telegramUrl || c.telegramHandle) s += 10;
  if (c.websiteUrl) s += 5;
  // A group-surface lead needs no links: the group itself is the contact
  // path (its chatId is the dedupe key), so the vapor penalties skip it.
  const isGroup = c.surfaceKind === 'group';
  const hasAnyLink = isGroup || !!(c.xHandle || c.xUrl || c.telegramUrl || c.telegramHandle || c.websiteUrl);
  if (!hasAnyLink) s -= 15;
  if (!isGroup && !c.tokenAddress && !hasAnyLink) s -= 20;   // vapor: nothing actionable
  const name = String(c.projectName ?? '').trim();
  if (COPYCAT_BRANDS.test(name) && !c.websiteUrl) s -= 25;
  const blob = `${name} ${c.signalText ?? ''}`.toLowerCase();
  if (/guaranteed (profit|returns|100x|1000x)|send \d+(\.\d+)?\s?(eth|sol|bnb).{0,24}(get|receive|back)|double your (money|coins)/.test(blob)) s -= 30;
  return Math.max(0, Math.min(100, s));
}

function serviceFitFor(c) {
  if (c.surfaceKind === 'group') return 'bot_subscription';
  const text = String(c.signalText ?? '').toLowerCase();
  if (c.source === 'x_intent') {
    if (/airdrop/.test(text)) return 'airdrop';
    if (/video|promo|advertis|content/.test(text)) return 'studio';
    if (/\bbot\b|community|moderation/.test(text)) return 'bot_subscription';
    return 'multi';
  }
  if (c.tokenAddress && (c.telegramUrl || c.telegramHandle || c.xHandle || c.xUrl)) return 'airdrop';
  if (c.source === 'dex_boost') return 'boost';
  return 'multi';
}

function dedupeKeyFor(c) {
  if (c.surfaceKind === 'group') return `group:${c.chatId}`;
  if (c.tokenAddress) return `${String(c.chainId ?? 'unknown').toLowerCase()}:${String(c.tokenAddress).toLowerCase()}`;
  if (c.xHandle) return `x:${c.xHandle.replace(/^@/, '').toLowerCase()}`;
  return null; // no stable identity → not stored (never fabricate a key)
}

// Statuses a re-sighting must NEVER move a row out of (suppression + the
// later-stage outcomes). Stage 1 only ever writes 'new'/'digested'/'raw'.
const LEAD_STICKY_STATUSES = new Set(['do_not_contact', 'dismissed', 'contacted', 'won', 'digested']);

async function upsertLead(c, nowSec) {
  const key = dedupeKeyFor(c);
  if (!key) return 'skipped';
  const score = scoreLead(c);
  const existing = await db.select().from(pb_leads)
    .where(eq(pb_leads.dedupeKey, key)).get().catch(() => null);
  if (existing) {
    await db.update(pb_leads).set({
      lastSeenAt: nowSec,
      score: Math.max(Number(existing.score) || 0, score),
    }).where(eq(pb_leads.id, existing.id)).run();
    return 'seen'; // status untouched — suppression is durable
  }
  let status = score >= LEAD_THRESHOLD ? 'new' : 'raw';
  if (c.knownSeed) status = 'raw'; // migrated seed token — never "new"
  await db.insert(pb_leads).values({
    source: c.source,
    projectName: c.projectName ? String(c.projectName).slice(0, 120) : null,
    tokenAddress: c.tokenAddress ?? null,
    chainId: c.chainId ?? null,
    xHandle: c.xHandle ?? (c.xUrl ? xHandleFromUrl(c.xUrl) : null),
    telegramHandle: c.telegramHandle ?? (c.telegramUrl ? tgHandleFromUrl(c.telegramUrl) : null),
    signalText: c.signalText ? String(c.signalText).slice(0, 400) : null,
    signalUrl: c.signalUrl ?? null,
    score,
    serviceFit: serviceFitFor(c),
    status,
    dedupeKey: key,
    firstSeenAt: nowSec,
    lastSeenAt: nowSec,
  }).run();
  return status === 'new' ? 'new' : 'raw';
}

async function isSeedToken(tokenAddress, chainId, baselineSec) {
  if (!tokenAddress || !chainId) return false;
  const row = await db.select().from(dex_boost_leads)
    .where(eq(dex_boost_leads.tokenAddress, String(tokenAddress)))
    .orderBy(asc(dex_boost_leads.firstSeenAt)).limit(1).get().catch(() => null);
  return !!row && String(row.chainId) === String(chainId) && Number(row.firstSeenAt) <= baselineSec;
}

// ── Dex name enrichment (one batched fetch per scan slice) ─────────────────

async function enrichDexNames(fetchFn, addresses) {
  const map = new Map();
  const addrs = [...new Set(addresses.filter(Boolean))].slice(0, 30);
  if (!addrs.length) return map;
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${addrs.join(',')}`);
    if (!res.ok) return map;
    const data = await res.json().catch(() => null);
    for (const pair of data?.pairs ?? []) {
      const bt = pair?.baseToken;
      if (bt?.address && bt?.name && !map.has(bt.address.toLowerCase())) {
        map.set(bt.address.toLowerCase(), { name: bt.name, symbol: bt.symbol ?? null });
      }
    }
  } catch { /* names are decoration — absence scores honestly */ }
  return map;
}

// ── Sources ─────────────────────────────────────────────────────────────────

async function sourceDexBoosts(fetchFn, nowSec) {
  const out = { candidates: [], degraded: null, processed: 0 };
  // Install baseline: everything already in the table on first run is the
  // migrated seed — consumed silently, never reported as new.
  let baseline = Number(await getConfig('leads:dex_baseline', ''));
  if (!Number.isFinite(baseline) || baseline <= 0) {
    const top = await db.select().from(dex_boost_leads)
      .orderBy(desc(dex_boost_leads.firstSeenAt)).limit(1).get().catch(() => null);
    baseline = Number(top?.firstSeenAt ?? nowSec);
    await setConfig('leads:dex_baseline', String(baseline)).catch(() => {});
    await setConfig('leads:dex_cursor', String(baseline)).catch(() => {});
    return out;
  }
  const cursor = Number(await getConfig('leads:dex_cursor', String(baseline))) || baseline;
  const rows = await db.select().from(dex_boost_leads)
    .where(gt(dex_boost_leads.firstSeenAt, cursor))
    .orderBy(asc(dex_boost_leads.firstSeenAt)).limit(60).all().catch(() => []);
  if (!rows.length) return out;
  const names = await enrichDexNames(fetchFn, rows.map((r) => r.tokenAddress));
  let maxSeen = cursor;
  for (const r of rows) {
    maxSeen = Math.max(maxSeen, Number(r.firstSeenAt) || cursor);
    const links = parseDexLinks(r.linksJson);
    const nm = names.get(String(r.tokenAddress).toLowerCase());
    out.candidates.push({
      source: 'dex_boost',
      projectName: nm?.name ?? null,
      tokenAddress: r.tokenAddress,
      chainId: r.chainId,
      xUrl: links.x, telegramUrl: links.telegram, websiteUrl: links.website,
      boosting: true,
      // dex_boost_leads timestamps are MILLISECONDS (the stream writes
      // Date.now() directly) — compare in ms, not against nowSec.
      fresh: nowSec * 1000 - Number(r.firstSeenAt) < 7 * 24 * 3600 * 1000,
      signalText: r.description ? String(r.description).slice(0, 300) : 'Boosting their token on DexScreener',
      signalUrl: r.url ?? null,
      knownSeed: Number(r.firstSeenAt) <= baseline,
    });
    out.processed++;
  }
  await setConfig('leads:dex_cursor', String(maxSeen)).catch(() => {});
  return out;
}

async function sourceDexNew(fetchFn, nowSec, baseline) {
  const out = { candidates: [], degraded: null };
  let res;
  try {
    res = await fetchFn('https://api.dexscreener.com/token-profiles/latest/v1');
  } catch (err) {
    return { candidates: [], degraded: `dex_new fetch failed: ${err?.message ?? err}` };
  }
  if (!res.ok) return { candidates: [], degraded: `dex_new http ${res.status}` };
  const entries = await res.json().catch(() => null);
  if (!Array.isArray(entries)) return { candidates: [], degraded: 'dex_new bad payload' };
  const slice = entries.filter((e) => e?.tokenAddress && e?.chainId).slice(0, 40);
  const names = await enrichDexNames(fetchFn, slice.map((e) => e.tokenAddress));
  for (const e of slice) {
    const links = parseDexLinks(e.links);
    const nm = names.get(String(e.tokenAddress).toLowerCase());
    out.candidates.push({
      source: 'dex_new',
      projectName: nm?.name ?? null,
      tokenAddress: e.tokenAddress,
      chainId: e.chainId,
      xUrl: links.x, telegramUrl: links.telegram, websiteUrl: links.website,
      fresh: true, // the latest-profiles feed is by definition current
      signalText: e.description ? String(e.description).slice(0, 300) : 'Fresh token profile on DexScreener',
      signalUrl: e.url ?? null,
      knownSeed: await isSeedToken(e.tokenAddress, e.chainId, baseline),
    });
  }
  return out;
}

const X_LEAD_QUERIES = [
  '(airdrop OR airdrops) ("looking for" OR "we need" OR "who can" OR "anyone know") -is:retweet lang:en',
  '("need a bot" OR "looking for a bot" OR "need a telegram bot") (token OR community OR project OR crypto) -is:retweet lang:en',
];

// Small base64 encoder (ASCII input) — avoids depending on isolate globals.
function b64ascii(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i) & 0xff;
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) & 0xff : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) & 0xff : 0;
    out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < str.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < str.length ? chars[c & 63] : '=';
  }
  return out;
}

async function xAppBearer(fetchFn) {
  // Config reality (verified in-isolate 2026-10-20): the rescued X
  // credentials live under TWITTER_* names, including a ready-made
  // app bearer. Prefer the stored bearer; else mint one from the
  // consumer pair via OAuth2 client_credentials.
  const stored = await getConfig('TWITTER_BEARER_TOKEN');
  if (stored) return { token: stored };
  const key = await getConfig('TWITTER_API_KEY');
  const secret = await getConfig('TWITTER_API_SECRET');
  if (!key || !secret) return { error: 'x credentials missing from config (no TWITTER_BEARER_TOKEN, no TWITTER_API_KEY/SECRET)' };
  const basic = b64ascii(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`);
  const res = await fetchFn('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return { error: `x oauth http ${res.status}` };
  const j = await res.json().catch(() => null);
  if (!j?.access_token) return { error: 'x oauth returned no token' };
  return { token: j.access_token };
}

async function sourceXIntent(fetchFn, nowSec) {
  const auth = await xAppBearer(fetchFn);
  if (auth.error) return { candidates: [], degraded: auth.error };
  const candidates = [];
  for (const q of X_LEAD_QUERIES) {
    const url = 'https://api.x.com/2/tweets/search/recent?query=' + encodeURIComponent(q)
      + '&max_results=10&tweet.fields=created_at&expansions=author_id&user.fields=username,name';
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!res.ok) {
      // Same tier answers both queries — one refusal degrades the source.
      return { candidates, degraded: `x search http ${res.status}` };
    }
    const data = await res.json().catch(() => null);
    const users = new Map((data?.includes?.users ?? []).map((u) => [u.id, u]));
    for (const t of data?.data ?? []) {
      const u = users.get(t.author_id);
      if (!u?.username) continue;
      const text = String(t.text ?? '');
      const evm = text.match(/\b0x[a-fA-F0-9]{40}\b/);
      candidates.push({
        source: 'x_intent',
        projectName: u.name ?? null,
        xHandle: `@${u.username}`,
        tokenAddress: evm ? evm[0] : null,
        chainId: evm ? 'base' : null,
        fresh: true, // recent-search window is 7 days by definition
        signalText: text.slice(0, 300),
        signalUrl: `https://x.com/${u.username}/status/${t.id}`,
      });
    }
  }
  return { candidates, degraded: null };
}

async function sourcePbSurfaces(nowSec) {
  const out = { candidates: [], degraded: null };
  // Groups baseline: groups already serving PB at install are customers,
  // not leads. Only groups first seen after the baseline count.
  let cursorMs = Number(await getConfig('leads:groups_cursor_ms', ''));
  if (!Number.isFinite(cursorMs) || cursorMs <= 0) {
    await setConfig('leads:groups_cursor_ms', String(Date.now())).catch(() => {});
    return out;
  }
  const rows = await db.select().from(known_groups).all().catch(() => []);
  let maxMs = cursorMs;
  for (const g of rows ?? []) {
    const seenMs = toMs(g.firstSeen);
    if (seenMs > cursorMs) {
      maxMs = Math.max(maxMs, seenMs);
      out.candidates.push({
        source: 'pb_surface',
        surfaceKind: 'group',
        chatId: g.chatId,
        projectName: g.title ?? null,
        fresh: true,
        signalText: `Added PB to their group "${g.title ?? g.chatId}"`,
        signalUrl: null,
      });
    }
  }
  if (maxMs > cursorMs) await setConfig('leads:groups_cursor_ms', String(maxMs)).catch(() => {});
  return out;
}

// Tokens run through /scan (called best-effort from lib/verdict.js).
// A scan means someone cared enough to check this token — recorded for
// dedupe/warmth; its score sits below the digest threshold by design.
export async function noteScan(address, chainId = 'base') {
  try {
    const addr = String(address ?? '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return;
    await upsertLead({
      source: 'pb_surface',
      tokenAddress: addr,
      chainId,
      signalText: 'Token scanned through PB /scan',
      signalUrl: `https://dexscreener.com/${chainId}/${addr}`,
    }, leadNowSec());
  } catch { /* a lead note must never break the scan flow */ }
}

// ── Scan orchestration ──────────────────────────────────────────────────────

export async function runLeadScan(deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  const summary = {
    ranAt: new Date(nowSec * 1000).toISOString(),
    sources: {}, newLeads: 0, raw: 0, seen: 0, degraded: [],
  };
  // Baseline lives in dex_boost_leads' native timestamp unit (ms) — always
  // derive it from the table itself, never from a seconds clock.
  let baseline = Number(await getConfig('leads:dex_baseline', '')) || 0;
  if (!baseline) {
    const top = await db.select().from(dex_boost_leads)
      .orderBy(desc(dex_boost_leads.firstSeenAt)).limit(1).get().catch(() => null);
    baseline = Number(top?.firstSeenAt ?? 0);
  }
  const tally = async (candidates) => {
    for (const c of candidates) {
      try {
        const r = await upsertLead(c, nowSec);
        if (r === 'new') summary.newLeads++;
        else if (r === 'raw') summary.raw++;
        else if (r === 'seen') summary.seen++;
      } catch (err) {
        console.error('[leads upsert]', err?.message ?? err);
      }
    }
  };
  const runSource = async (name, fn) => {
    try {
      const r = await fn();
      summary.sources[name] = r.candidates.length;
      if (r.degraded) summary.degraded.push(r.degraded);
      await tally(r.candidates);
    } catch (err) {
      summary.sources[name] = 0;
      summary.degraded.push(`${name}: ${err?.message ?? err}`);
    }
  };
  await runSource('dex_boost', () => sourceDexBoosts(fetchFn, nowSec));
  await runSource('dex_new', () => sourceDexNew(fetchFn, nowSec, baseline));
  await runSource('x_intent', () => sourceXIntent(fetchFn, nowSec));
  await runSource('pb_surface', () => sourcePbSurfaces(nowSec));
  await setConfig('leads:last_scan', JSON.stringify(summary)).catch(() => {});
  await setConfig('leads:scan_last', String(nowSec * 1000)).catch(() => {});
  return summary;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const FIT_LABEL = {
  airdrop: '🪂 airdrop', boost: '⚡ boost', studio: '🎬 studio',
  bot_subscription: '🤖 bot subscription', multi: '🎯 multi-service',
};

function renderLeadLine(l) {
  const name = l.projectName || (l.tokenAddress ? `${String(l.tokenAddress).slice(0, 10)}…` : 'Unknown project');
  const contact = l.xHandle ?? l.telegramHandle ?? l.signalUrl ?? '—';
  const why = l.signalText ? ` — ${String(l.signalText).slice(0, 110)}` : '';
  return `• ${name} · ${FIT_LABEL[l.serviceFit] ?? l.serviceFit} · score ${l.score}\n  ${contact}${why}`;
}

function renderLeadsDigest(leads) {
  const lines = [`🎯 ${leads.length} new lead${leads.length === 1 ? '' : 's'} worth a look:`];
  for (const l of leads.slice(0, LEAD_DIGEST_TOP)) lines.push(renderLeadLine(l));
  if (leads.length > LEAD_DIGEST_TOP) lines.push(`…and ${leads.length - LEAD_DIGEST_TOP} more`);
  lines.push('Full list: /leads');
  return lines.join('\n').slice(0, 3500);
}

async function topLeads(limit) {
  const rows = await db.select().from(pb_leads)
    .where(inArray(pb_leads.status, ['new', 'digested']))
    .orderBy(desc(pb_leads.score)).limit(limit).all().catch(() => []);
  return rows ?? [];
}

// ── /leads command (owner-only) ─────────────────────────────────────────────

export const LEADS_COMMANDS = {
  leads: async (chatId, args, msg) => {
    let text;
    try {
      if (!(await isOwnerId(msg?.from?.id))) {
        text = '🔒 Leads are owner-only.';
      } else if (String(args ?? '').trim().toLowerCase() === 'scan') {
        const s = await runLeadScan();
        text = `🎯 Lead scan done.\nNew above threshold: ${s.newLeads} · stored raw: ${s.raw} · re-seen: ${s.seen}`
          + (s.degraded.length ? `\n⚠️ Degraded sources: ${s.degraded.join('; ')}` : '\nAll sources healthy.');
      } else {
        const rows = await topLeads(LEAD_LIST_TOP);
        const last = await getConfig('leads:last_scan', '');
        let scanLine = 'No scan has run yet.';
        if (last) {
          try {
            const s = JSON.parse(last);
            scanLine = `Last scan ${s.ranAt}` + (s.degraded?.length ? ` · degraded: ${s.degraded.join('; ')}` : ' · all sources healthy');
          } catch { /* keep default */ }
        }
        text = rows.length
          ? [`🎯 Top leads (${rows.length})`, ...rows.map(renderLeadLine), '', scanLine].join('\n').slice(0, 3500)
          : `🎯 No leads over the bar yet.\n${scanLine}\nRun /leads scan to scan now.`;
      }
    } catch (err) {
      console.error('[leads command]', err?.message ?? err);
      text = '🎯 Leads are unavailable right now — try again shortly.';
    }
    try {
      await api.sendMessage({ chat_id: chatId, text });
    } catch (err) {
      if (err?.code !== 403) console.error('[leads send]', err?.code, err?.description ?? err?.message);
    }
  },
};

// ── Tick cycle: scan (watermark-gated) + owner digest ───────────────────────
// Zero new above-threshold leads → zero messages. The owner is only ever
// messaged when there is money-worthy news (and only the owner — leads
// themselves are never contacted in this stage).

export async function cycleLeadFinder(deps = {}) {
  try {
    // Hold (Rowdy 2026-11-07 "stop the leads"): flag leads_enabled —
    // UNSET = ON, raid-flag pattern (tick.js cycleRaidAutoTrack).
    // Automatic runs stop when set and not on; deps.force still runs.
    if (!deps.force) {
      const rawFlag = await getConfig('leads_enabled', null);
      if (rawFlag != null && !flagValueOn(rawFlag)) return { skipped: 'flag_off' };
    }
    const now = deps.now ?? Date.now();
    const last = Number(await getConfig('leads:scan_last', '0')) || 0;
    if (!deps.force && now - last < LEAD_SCAN_INTERVAL_MS) return { skipped: 'cadence' };

    const scan = await runLeadScan({ ...deps, now });
    const fresh = await topLeads(50);
    const freshNew = fresh.filter((l) => l.status === 'new');
    if (!freshNew.length) return { scan, digest: 'none', newLeads: 0 };

    const owners = String(await getConfig('TELEGRAM_OWNER_ID', '') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!owners.length) return { scan, digest: 'no-owner-configured', newLeads: freshNew.length };

    const text = renderLeadsDigest(freshNew);
    let delivered = 0;
    for (const owner of owners) {
      try {
        await api.sendMessage({ chat_id: Number(owner), text });
        delivered++;
      } catch (err) {
        if (err?.code === 403) delivered++; // blocked — handled, don't retry forever
        else console.error('[leads digest send]', err?.code, err?.description ?? err?.message);
      }
    }
    if (delivered) {
      for (const l of freshNew) {
        await db.update(pb_leads).set({ status: 'digested' })
          .where(eq(pb_leads.id, l.id)).run().catch(() => {});
      }
    }
    return { scan, digest: delivered ? 'sent' : 'failed', newLeads: freshNew.length };
  } catch (err) {
    console.error('[leadFinder cycle]', err?.message ?? err);
    return { error: err?.message ?? 'unknown' };
  }
}

// Exported for in-isolate proof harnesses (same pattern as lib/tick.js).
export const __leadsTest = {
  sourceDexBoosts, sourceDexNew, sourceXIntent, sourcePbSurfaces,
  upsertLead, LEAD_THRESHOLD,
};
