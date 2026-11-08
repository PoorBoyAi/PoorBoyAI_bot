// Image generation via the Gemini REST API — the fetchable equivalent of
// lib/integrations-gemini-ai/src/image/client.ts, which used the @google/genai
// SDK (gemini-2.5-flash-image) with a 90s generation race in handleGenerate.
// Watermarking (sharp) is unavailable serverless-side — noted in BUILD_NOTES.
// Key comes from the config table (GEMINI_API_KEY), never from code.

import { api, fetch, InputFile } from 'sdk';
import db, { eq, sql } from 'sdk/db';
import { bot_users, credit_ledger } from '../schema.js';
import { getConfig, setConfig } from './config.js';
import { effectiveTier } from './posts.js';
import { tierAtLeast, weekTrialStatus, commitWeekTrialDraw, restoreWeekTrialCredits } from './tiers.js';
import { ownerIdSet } from './groups.js';

const IMAGE_MODEL = 'gemini-2.5-flash-image';

function baseUrl() {
  // Mirrors the integration's base-url override; default is public Gemini.
  return 'https://generativelanguage.googleapis.com/v1beta';
}

/**
 * Generate an image. Returns { bytes: Uint8Array, mimeType } or throws.
 * Timeout: 90s like the source's Promise.race.
 */
export async function generateGeminiImage(prompt) {
  const key = await getConfig('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY is not configured.');
  const base = (await getConfig('GEMINI_BASE_URL')) || baseUrl();
  const url = `${base}/models/${IMAGE_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && typeof setTimeout !== 'undefined' ? setTimeout(() => ctl.abort(), 90_000) : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
      signal: ctl?.signal,
    });
    if (!res.ok) throw new Error(`Gemini image API ${res.status}`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData?.data);
    if (!img) throw new Error('No image data in response');
    // Pure decode, not atob: the isolate has no atob global (see the
    // Workers AI decoder below). Without this, a Gemini 200 would die
    // in decode even after the 429 lifts — the fallback proof caught it.
    const bytes = base64ToBytesNoGlobals(img.inlineData.data);
    return { bytes, mimeType: img.inlineData.mimeType || 'image/png' };
  } finally {
    if (timer != null && typeof clearTimeout !== 'undefined') clearTimeout(timer);
  }
}

// ── Workers AI image fallback (2026-10-29, image-fix wave) ─────────────
// Second provider for when Gemini rate-limits (429 all day 2026-10-29).
// Uses the Cloudflare keys PB ALREADY holds for the chat ladder
// (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, verified present
// 2026-10-28, values never seen) — no new key, no new vendor, no new
// sign-up. Model: @cf/black-forest-labs/flux-1-schnell, text-to-image.
// REST reply is JSON { success, result: { image: base64 } } (Cloudflare
// Workers AI docs, flux-1-schnell page); a binary reply is handled too.
// Free allowance: 10,000 Workers AI neurons/day account-wide, ~173
// flux-1-schnell images/day at 1024px/4 steps; PB image volume is a
// handful a day, so this stays inside the free allowance in practice.
// It is ADD-ONLY: generateGeminiImage is untouched, and the fallback
// only runs after a RETRYABLE Gemini failure (below).
const WORKERSAI_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

/** Base64 → bytes without host globals: the tgcloud isolate has NO
 *  atob/btoa (proven live 2026-10-29: Flux decode threw
 *  'atob is not defined' in-isolate). Same proven shape as
 *  lib/llm.js base64ToBytes. */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();
export function base64ToBytesNoGlobals(b64) {
  const clean = String(b64 ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
  const out = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '=') break;
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    if (v === undefined || v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return Uint8Array.from(out);
}

/** Pure decode of a Workers AI image reply. Throws on no image. */
export function decodeWorkersAiImage(data) {
  const b64 = data?.result?.image;
  if (typeof b64 !== 'string' || !b64) throw new Error('No image data in response');
  return { bytes: base64ToBytesNoGlobals(b64), mimeType: 'image/jpeg' };
}

export async function generateWorkersAiImage(prompt, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const token = await getConfig('CLOUDFLARE_API_TOKEN');
  const accountId = await getConfig('CLOUDFLARE_ACCOUNT_ID');
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not configured');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${WORKERSAI_IMAGE_MODEL}`;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl && typeof setTimeout !== 'undefined' ? setTimeout(() => ctl.abort(), 90_000) : null;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt }),
      signal: ctl?.signal,
    });
    if (!res.ok) throw new Error(`WorkersAI image API ${res.status}`);
    let ct = '';
    try { ct = res.headers?.get?.('content-type') ?? ''; } catch { ct = ''; }
    if (String(ct).includes('application/json')) {
      const data = await res.json();
      if (data?.success === false) throw new Error('WorkersAI image API 502');
      return decodeWorkersAiImage(data);
    }
    const buf = await res.arrayBuffer();
    if (!buf || !buf.byteLength) throw new Error('No image data in response');
    return { bytes: new Uint8Array(buf), mimeType: String(ct).split(';')[0].trim() || 'image/jpeg' };
  } finally {
    if (timer != null && typeof clearTimeout !== 'undefined') clearTimeout(timer);
  }
}

/**
 * Gemini first, Workers AI Flux second — ONE attempt per provider, never
 * two of the same. Returns { img, attempts, provider } like
 * generateWithRetry's shape, so tick's cycle can use it directly.
 * Rules: a non-retryable Gemini failure (bad prompt, missing key) never
 * burns the second provider; a fallback failure that is itself
 * non-retryable (e.g. fallback keys missing) re-throws the ORIGINAL
 * retryable Gemini error, so callers queue/retry instead of
 * terminal-failing a job that was only ever rate-limited.
 * deps.gemini / deps.workersai are the harness seams.
 */
export async function generateImageWithFallback(prompt, deps = {}) {
  const gemini = deps.gemini ?? generateGeminiImage;
  const workersai = deps.workersai ?? generateWorkersAiImage;
  try {
    const img = await gemini(prompt);
    return { img, attempts: 1, provider: 'gemini' };
  } catch (first) {
    if (!classifyImageError(first).retryable) { first.imageAttempts = 1; throw first; }
    try {
      const img = await workersai(prompt);
      return { img, attempts: 2, provider: 'workersai' };
    } catch (second) {
      if (!classifyImageError(second).retryable) { first.imageAttempts = 2; throw first; }
      second.imageAttempts = 2;
      throw second;
    }
  }
}

/** base64 string for data: URIs if a caller needs it. */
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(s);
}

// ── Image credit charging (restored 2026-10-21) ────────────────────────────
// The original priced image generation in the shared Studio credit economy
// (lib/constants/src/index.ts: STUDIO_IMAGE_CREDIT_COST = 2, "Image, meme,
// and PFP generations") and charged it on the paid MCP surface via
// runPaidMcpTool (mcp-paid-tool.ts): RESERVE before the provider call; an
// insufficient balance refuses before any provider call ("Insufficient
// credits. This tool requires 2 credits."); a provider failure refunds
// the reservation in full; success settles (the reservation stands as the
// charge). The constants' own rule — "Retry attempts for the same job do
// not create a new reservation; only a newly submitted job is charged" —
// is the refId replay guard below. The original's Telegram handlers never
// charged (tier gates only); this restore brings the charge to the bot
// commands in the port's shared-ledger idiom (mirrors lib/repurpose.js
// and the ask_pb charge in lib/websync.js):
//   reserve: amount −2, kind 'image_reserve', refId '<base>:reserve'
//   settle:  amount 0,  kind 'image_settle',  refId '<base>:settle'
//   refund:  amount +2, kind 'image_refund',  refId '<base>:refund'
// purpose 'studio_image'. Balance = SUM(credit_ledger.amount) for
// 'telegram:<id>' — the same shared wallet credit packs top up.
// STUDIO_HD_IMAGE_CREDIT_COST (5) existed in the original ONLY as a
// constants entry: no HD command, flag, tool parameter, or client option
// ever used it (the image client has no size option), so there is no HD
// surface to charge — all three commands generate at the one size the
// model returns and cost IMAGE_CREDIT_COST.
export const IMAGE_CREDIT_COST = 2;

// ── Image failure classification + recording (2026-10-27) ────────────────
// generateGeminiImage throws distinguishable messages; classify them so the
// user-facing copy and the retry decision name the real cause instead of
// the blanket "busy or unavailable". The recorded error (config key
// image_last_error) holds statuses and timings ONLY — never prompt text,
// keys, URLs, or provider bodies.
const IMAGE_LAST_ERROR_KEY = 'image_last_error';

/** Classify a provider throw. Retryable ONLY: HTTP 429, HTTP 5xx, network. */
export function classifyImageError(err) {
  const msg = String(err?.message ?? err ?? '');
  const m = msg.match(/(?:Gemini|WorkersAI) image API (\d{3})/);
  if (m) {
    const status = Number(m[1]);
    if (status === 429) return { kind: 'rate_limited', status, retryable: true };
    if (status >= 500) return { kind: 'overloaded', status, retryable: true };
    return { kind: 'bad_request', status, retryable: false };
  }
  if (/not configured/i.test(msg)) return { kind: 'key', status: null, retryable: false };
  if (/No image data/i.test(msg)) return { kind: 'empty', status: null, retryable: false };
  if (/fetch|network|ECONN|ETIMEDOUT|aborted|socket/i.test(msg)) return { kind: 'network', status: null, retryable: true };
  return { kind: 'unknown', status: null, retryable: false };
}

export async function recordImageError(info) {
  const rec = { at: Date.now(), kind: info.kind, status: info.status ?? null, attempts: info.attempts, path: info.path };
  await setConfig(IMAGE_LAST_ERROR_KEY, JSON.stringify(rec)).catch(() => {});
}

export async function clearImageError() {
  await setConfig(IMAGE_LAST_ERROR_KEY, '').catch(() => {});
}

// ── Preflight gate (first-try wave 2, 2026-10-27) ───────────────────────
// Recorded-health gate only: it reads the image_last_error row the
// failure paths already write. It makes NO provider call, so it adds no
// hang surface (a preflight fetch to a hung provider would hang exactly
// like the real call — the 2054 wave proved this for brain preflight
// and rejected it). Fail-open everywhere: a missing, corrupt, or
// unreadable record means ALLOWED. Only retryable kinds close the gate;
// a bad prompt or a missing key must never block other users.
// Window: 10 min from the last real retryable failure. After it, the
// next submission (or tick trial) is the half-open probe: success
// clears the record, failure re-records and refreshes the window.
// The gate never substitutes a provider (none exists for image) and
// never changes the price.
export const IMAGE_PREFLIGHT_WINDOW_MS = 10 * 60 * 1000;
const IMAGE_PREFLIGHT_GATE_KINDS = new Set(['rate_limited', 'overloaded', 'network']);

/** Static upfront-refusal copy per gate kind — no provider text ever interpolated. */
export function imagePreflightCopy(kind) {
  switch (kind) {
    case 'overloaded': return '🖼️ The image AI is overloaded right now — nothing was charged. Try again in a bit.';
    case 'network': return '🖼️ The image service is unreachable right now — nothing was charged. Try again in a bit.';
    default: return '🖼️ The image service is rate-limited right now — nothing was charged. Try again in a bit.';
  }
}

/** Pure gate decision over a parsed last-error record (or null). */
export function imagePreflightGate(record, now = Date.now()) {
  try {
    if (!record || typeof record !== 'object') return { allowed: true };
    if (!IMAGE_PREFLIGHT_GATE_KINDS.has(record.kind)) return { allowed: true };
    const at = Number(record.at);
    if (!Number.isFinite(at)) return { allowed: true };
    const age = now - at;
    if (age < 0 || age >= IMAGE_PREFLIGHT_WINDOW_MS) return { allowed: true };
    return { allowed: false, kind: record.kind, ageMs: age, copy: imagePreflightCopy(record.kind) };
  } catch { return { allowed: true }; }
}

async function readImageLastError() {
  try {
    const raw = await getConfig(IMAGE_LAST_ERROR_KEY, '');
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch { return null; }
}

/** Async gate check for submission paths. Fail-open to ALLOWED on any read error. */
export async function checkImagePreflight(now = Date.now()) {
  try {
    return imagePreflightGate(await readImageLastError(), now);
  } catch { return { allowed: true }; }
}

// ── Image circuit breaker (first-try wave 3, 2026-10-27) ─────────────────
// Copy of the brain breaker's shape (lib/llm.js:591-604, plus its M2
// trip-persistence): opens after IMAGE_BREAKER_THRESHOLD (default 3)
// CONSECUTIVE retryable failures; while open, submissions refuse fast and
// the tick job cycle skips without consuming an attempt. After the
// cooldown (default 300s, wall-clock timestamp — the isolate has no
// timers), the next attempt IS the half-open trial: success closes,
// failure re-opens. Only retryable kinds count — a bad prompt must never
// trip it. State is in-memory plus a persisted openUntil written on trip
// and cleared on close, so a cold isolate honors a trip until expiry
// (the fails count resets on restart, exactly like the brain breaker).
// Fail-open everywhere: a missing, corrupt, or unreadable state means
// ALLOWED. The breaker never substitutes a provider (none exists) and
// never changes the price. It complements, not replaces, the preflight
// gate: preflight blocks submissions for 10 min after ANY retryable
// failure, while the breaker is what stops the tick job loop — which
// bypasses preflight — from hammering a dead provider every minute.
export const IMAGE_BREAKER_OPEN_KEY = 'image_breaker_open';
export const IMAGE_BREAKER_DEFAULT_THRESHOLD = 3;
export const IMAGE_BREAKER_DEFAULT_COOLDOWN_MS = 300_000;
export const IMAGE_BREAKER_TRIAL_STALE_MS = 120_000;
export const IMAGE_BREAKER_COPY = '🖼️ The image service is cooling down after repeated failures — nothing was charged. Try again in a bit.';
const _imageBreaker = { fails: 0, openUntil: 0, trialInFlight: false, trialAt: 0, hydrated: false };
export function __resetImageBreakerForTest() {
  _imageBreaker.fails = 0; _imageBreaker.openUntil = 0; _imageBreaker.trialInFlight = false; _imageBreaker.trialAt = 0; _imageBreaker.hydrated = false;
}
/** Pure decision over a breaker state object (harness seam). */
export function imageBreakerAllows(state, now = Date.now()) {
  try {
    if (!state || !state.openUntil) return true;
    if (now < state.openUntil) return false;
    // A trial claimed long ago with no outcome recorded is a dead trial
    // (its invocation was platform-killed) — it must not wedge the
    // breaker forever. A live trial (claimed < 120s ago) still refuses.
    if (state.trialInFlight && (now - (Number(state.trialAt) || 0)) < IMAGE_BREAKER_TRIAL_STALE_MS) return false;
    return true; // cooldown expired: caller claims the trial via record() path
  } catch { return true; }
}
/** Pure next-state over a breaker state object (harness seam). Mutates a copy. */
export function imageBreakerNext(state, ok, settings, now = Date.now()) {
  const next = { fails: state?.fails ?? 0, openUntil: state?.openUntil ?? 0, trialInFlight: false, trialAt: 0 };
  if (ok) { next.fails = 0; next.openUntil = 0; return next; }
  next.fails = (Number(next.fails) || 0) + 1;
  if (next.fails >= (settings?.threshold ?? IMAGE_BREAKER_DEFAULT_THRESHOLD)) {
    next.openUntil = now + (settings?.cooldownMs ?? IMAGE_BREAKER_DEFAULT_COOLDOWN_MS);
  }
  return next;
}
async function imageBreakerSettings() {
  try {
    const th = Number(await getConfig('image_breaker_threshold', ''));
    const cdRaw = await getConfig('image_breaker_cooldown_ms', '');
    const cd = Number(cdRaw);
    return {
      threshold: Number.isFinite(th) && th >= 1 ? Math.floor(th) : IMAGE_BREAKER_DEFAULT_THRESHOLD,
      // Same explicit-0 guard as the brain breaker: an absent or 0
      // cooldown must yield the 5-min default, never instant re-open.
      cooldownMs: String(cdRaw ?? '').trim() !== '' && Number.isFinite(cd) && cd > 0 ? cd : IMAGE_BREAKER_DEFAULT_COOLDOWN_MS,
    };
  } catch { return { threshold: IMAGE_BREAKER_DEFAULT_THRESHOLD, cooldownMs: IMAGE_BREAKER_DEFAULT_COOLDOWN_MS }; }
}
async function imageBreakerHydrate() {
  if (_imageBreaker.hydrated) return;
  _imageBreaker.hydrated = true;
  try {
    const raw = await getConfig(IMAGE_BREAKER_OPEN_KEY, '');
    const openUntil = Number(raw);
    if (Number.isFinite(openUntil) && openUntil > Date.now()) {
      _imageBreaker.openUntil = openUntil; _imageBreaker.fails = IMAGE_BREAKER_DEFAULT_THRESHOLD;
    } else if (raw !== '' && raw != null) {
      await setConfig(IMAGE_BREAKER_OPEN_KEY, '').catch(() => {});
    }
  } catch { /* fail-open: state stays closed */ }
}
async function imageBreakerPersist() {
  try {
    await setConfig(IMAGE_BREAKER_OPEN_KEY, _imageBreaker.openUntil ? String(_imageBreaker.openUntil) : '').catch(() => {});
  } catch { /* best effort */ }
}
/** Async breaker check for submission/tick paths. Fail-open to allowed. */
export async function checkImageBreaker(now = Date.now()) {
  try {
    await imageBreakerHydrate();
    if (!_imageBreaker.openUntil) return { allowed: true };
    if (!imageBreakerAllows(_imageBreaker, now)) return { allowed: false, copy: IMAGE_BREAKER_COPY };
    _imageBreaker.trialInFlight = true; _imageBreaker.trialAt = now; // this caller owns the half-open trial
    return { allowed: true, trial: true };
  } catch { return { allowed: true }; }
}
/** Record one generation outcome. ok=true closes; retryable failure counts. Never throws. */
export async function recordImageBreaker(ok) {
  try {
    await imageBreakerHydrate();
    const settings = await imageBreakerSettings();
    const wasOpen = !!_imageBreaker.openUntil;
    const next = imageBreakerNext(_imageBreaker, ok, settings);
    _imageBreaker.fails = next.fails; _imageBreaker.openUntil = next.openUntil; _imageBreaker.trialInFlight = false; _imageBreaker.trialAt = 0;
    if (next.openUntil || wasOpen) await imageBreakerPersist();
  } catch { /* fail-open */ }
}
/** Release a claimed half-open trial WITHOUT recording an outcome (the
 *  provider was never actually called, or failed non-retryably — the
 *  consecutive-retryable count must be preserved, not reset). Never throws. */
export function releaseImageBreakerTrial() {
  try { _imageBreaker.trialInFlight = false; _imageBreaker.trialAt = 0; } catch { /* ignore */ }
}

/** Static copy per class — no provider text is ever interpolated. */
export function imageFailureCopy(kind) {
  switch (kind) {
    case 'rate_limited': return '❌ Image generation failed — the image service is rate-limited right now. Try again in a bit.';
    case 'overloaded': return '❌ Image generation failed — the image AI is overloaded. Try again in a bit.';
    case 'bad_request': return '❌ Image generation failed — the request was rejected. Try a different prompt.';
    case 'key': return '❌ Image generation is unavailable right now (configuration). Try again later.';
    case 'empty': return '❌ Image generation returned no image. Try a different prompt.';
    case 'network': return '❌ Image generation failed — network error reaching the image service. Try again in a bit.';
    default: return '❌ Image generation failed — the image AI is busy or unavailable. Try again in a bit.';
  }
}

// One immediate retry on retryable failures only. No timers exist in the
// isolate, so the retry is immediate or not at all. Returns { img, attempts }
// or throws the FINAL error with .imageAttempts attached (1 fail-fast, 2
// after a retried failure). Retry never re-reserves: it runs inside the
// caller's post-reserve try block, and settle runs once after the outcome.
export async function generateWithRetry(gen, prompt) {
  try {
    return { img: await gen(prompt), attempts: 1 };
  } catch (first) {
    if (!classifyImageError(first).retryable) { first.imageAttempts = 1; throw first; }
    try {
      return { img: await gen(prompt), attempts: 2 };
    } catch (second) {
      second.imageAttempts = 2;
      throw second;
    }
  }
}

const imageUserKey = (tgId) => 'telegram:' + String(tgId);

async function imageLedgerRow(refId) {
  try {
    return await db.select().from(credit_ledger).where(eq(credit_ledger.refId, refId)).get();
  } catch { return null; }
}

export async function imageCreditBalance(tgId) {
  const row = await db.get(sql`SELECT COALESCE(SUM(amount), 0) AS bal FROM credit_ledger WHERE user_key = ${imageUserKey(tgId)}`);
  return Number(row?.bal ?? 0) || 0;
}

/**
 * Reserve IMAGE_CREDIT_COST for one generation. `replay` is true when the
 * reserve row already exists (the same invocation re-delivered — never
 * double-charged). Throws an 'Insufficient…' error, before any provider
 * call, when the balance cannot cover the cost.
 */
export async function reserveImageCredits(tgId, refBase) {
  const refId = refBase + ':reserve';
  if (await imageLedgerRow(refId)) return { replay: true };
  // OWNER-UNLIMITED (2026-10-29, Rowdy's call): the owner never pays the
  // image wallet charge. A 0-amount reserve marker keeps every downstream
  // ledger-state check identical to a paid job (tick retry proceeds past
  // the no-reserve guard; the stranded scan skips 0-amount rows), while
  // the shared balance never moves. No trial marker is consumed.
  const owner = (await ownerIdSet().catch(() => new Set())).has(String(tgId));
  if (owner) {
    await db.insert(credit_ledger).values({
      userKey: imageUserKey(tgId),
      amount: 0,
      kind: 'image_reserve',
      purpose: 'studio_image',
      refId,
    }).run();
    return { replay: false, owner: true };
  }
  // PRICING WAVE: 7-day trial images draw from the pb_trials counter,
  // never the wallet. Marker-first, then draw, so a retry after a
  // transient failure converges: the marker row's distinct kind tells
  // the refund path this was trial-funded (a plain 'image_reserve'
  // marker would refund +COST into the wallet — trial credits must
  // never mint wallet credits). If the draw itself fails, the marker
  // is deleted so a retry re-attempts cleanly instead of replaying a
  // free image.
  const wt = await weekTrialStatus(tgId).catch(() => ({ active: false, remaining: 0 }));
  if (wt.active && wt.remaining >= IMAGE_CREDIT_COST) {
    await db.insert(credit_ledger).values({
      userKey: imageUserKey(tgId),
      amount: 0,
      kind: 'image_week_trial',
      purpose: 'studio_image',
      refId,
    }).run();
    const draw = await commitWeekTrialDraw(tgId, IMAGE_CREDIT_COST);
    if (!draw.ok) {
      await db.delete(credit_ledger).where(eq(credit_ledger.refId, refId)).run().catch(() => {});
      throw new Error(
        `Insufficient 7-day trial credits. An image costs ${IMAGE_CREDIT_COST} credits — trial credits remaining ${draw.remaining}.`,
      );
    }
    return { replay: false, weekTrial: true };
  }
  const balance = await imageCreditBalance(tgId);
  if (balance < IMAGE_CREDIT_COST) {
    throw new Error(
      `Insufficient shared Studio credits. An image costs ${IMAGE_CREDIT_COST} credits — your balance is ${balance}.`
    );
  }
  await db.insert(credit_ledger).values({
    userKey: imageUserKey(tgId),
    amount: -IMAGE_CREDIT_COST,
    kind: 'image_reserve',
    purpose: 'studio_image',
    refId,
  }).run();
  return { replay: false };
}

/** Settle on success (marker row) or refund on failure (+COST back). */
export async function settleImageCredits(tgId, refBase, success) {
  if (success) {
    const refId = refBase + ':settle';
    if (await imageLedgerRow(refId)) return;
    if (await imageLedgerRow(refBase + ':refund')) return; // already refunded
    await db.insert(credit_ledger).values({
      userKey: imageUserKey(tgId),
      amount: 0,
      kind: 'image_settle',
      purpose: 'studio_image',
      refId,
    }).run();
    return;
  }
  const refundRef = refBase + ':refund';
  if (await imageLedgerRow(refundRef)) return;
  const reserveRow = await imageLedgerRow(refBase + ':reserve');
  if (!reserveRow) return; // never charged
  if (await imageLedgerRow(refBase + ':settle')) return; // already settled
  // OWNER-UNLIMITED: an owner reserve is a 0 marker, so its refund is a
  // 0 marker too — never +COST back, or a failed owner job would mint
  // credits into the shared wallet.
  // PRICING WAVE: a week-trial reserve restores trial credits instead
  // of minting wallet credits (the marker kind is the record).
  const owner = (await ownerIdSet().catch(() => new Set())).has(String(tgId));
  if (reserveRow.kind === 'image_week_trial') {
    await restoreWeekTrialCredits(tgId, IMAGE_CREDIT_COST).catch(() => {});
    await db.insert(credit_ledger).values({
      userKey: imageUserKey(tgId),
      amount: 0,
      kind: 'image_refund',
      purpose: 'studio_image',
      refId: refundRef,
    }).run();
    return;
  }
  await db.insert(credit_ledger).values({
    userKey: imageUserKey(tgId),
    amount: owner ? 0 : IMAGE_CREDIT_COST,
    kind: 'image_refund',
    purpose: 'studio_image',
    refId: refundRef,
  }).run();
}

/** Ledger state for one refBase: which money rows already exist. */
export async function imageJobLedgerState(refBase) {
  return {
    reserved: !!(await imageLedgerRow(refBase + ':reserve')),
    settled: !!(await imageLedgerRow(refBase + ':settle')),
    refunded: !!(await imageLedgerRow(refBase + ':refund')),
  };
}

// ── Async image jobs (2026-10-27, first-try wave 1) ─────────────────────
// Submit-once for /meme, /pfp, and /generate. A job is persisted BEFORE
// the provider call; the synchronous attempt still delivers immediately
// in the common case, and if the invocation dies mid-call (~33s platform
// kill, no catch runs) the tick cycle regenerates and delivers from the
// job. This deliberately differs from the brain-replay job store in one
// place: a brain-replay job holds ids only because conversation history
// already holds the question text. NO history row holds an image prompt
// (/generate's session is consumed by the style tap; /meme and /pfp
// never store the prompt), so the image job row MUST carry the prompt
// itself. That payload is the pending work, not a log, tally, or stamp:
// it is sealed to that user + chat, never appears in any tick summary,
// error record, or tally, and the row is DELETED on every terminal
// resolution. Fail-open everywhere: a job-store failure never blocks a
// generation — it falls back to today's synchronous path.
export const IMAGE_JOB_KEY = 'image_jobs';
export const IMAGE_JOB_MIN_AGE_MS = 90_000;
export const IMAGE_JOB_MAX_ATTEMPTS = 8;
export const IMAGE_JOB_MAX_AGE_MS = 180 * 60_000;
const IMAGE_JOB_MAX_JOBS = 20;
export const IMAGE_JOB_QUEUED_TEXT = '🖼️ Got it — your image is queued and I\'ll send it here when it\'s ready. If it can\'t be delivered, your 2 credits refund in full.';
export const IMAGE_JOB_QUEUED_TEXT_OWNER = '🖼️ Got it — your image is queued and I\'ll send it here when it\'s ready. Nothing was charged for this one.';
export async function imageQueuedText(tgId) {
  const owner = (await ownerIdSet().catch(() => new Set())).has(String(tgId));
  return owner ? IMAGE_JOB_QUEUED_TEXT_OWNER : IMAGE_JOB_QUEUED_TEXT;
}

async function readImageJobs() {
  try {
    const raw = await getConfig(IMAGE_JOB_KEY, '');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((j) => j && typeof j === 'object') : [];
  } catch { return []; }
}
async function writeImageJobs(jobs) {
  try { await setConfig(IMAGE_JOB_KEY, JSON.stringify(jobs.slice(0, IMAGE_JOB_MAX_JOBS))); } catch { /* fail-open */ }
}
/** Create (or reuse, on same-refBase re-delivery) a pending job. Null on store failure. */
export async function createImageJob({ userId, chatId, refBase, prompt, caption, filename, kind }) {
  try {
    const jobs = await readImageJobs();
    const existing = jobs.find((j) => j.state === 'pending' && j.refBase === refBase);
    if (existing) return existing;
    const job = {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      userId, chatId, refBase,
      prompt: String(prompt ?? ''), caption: caption ?? '', filename: filename ?? 'generated.png',
      kind: kind ?? 'oneshot',
      createdAt: Date.now(), attempts: 0, lastAttemptAt: 0, state: 'pending',
    };
    jobs.push(job);
    while (jobs.length > IMAGE_JOB_MAX_JOBS) {
      const idx = jobs.findIndex((j) => j.state !== 'pending');
      jobs.splice(idx >= 0 ? idx : 0, 1);
    }
    await writeImageJobs(jobs);
    return job;
  } catch { return null; }
}
/** Delete a job row (terminal resolution purges the prompt payload). */
export async function deleteImageJob(jobId) {
  try {
    const jobs = await readImageJobs();
    const next = jobs.filter((j) => j.id !== jobId);
    if (next.length === jobs.length) return false;
    await writeImageJobs(next);
    return true;
  } catch { return false; }
}
export async function claimImageJobAttempt(jobId) {
  try {
    const jobs = await readImageJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job || job.state !== 'pending') return null;
    job.attempts = (Number(job.attempts) || 0) + 1;
    job.lastAttemptAt = Date.now();
    await writeImageJobs(jobs);
    return job;
  } catch { return null; }
}
/** Oldest pending job old enough to be certainly dead (90s > ~33s platform kill). Attempts are NOT filtered: the cycle must still see an attempts-capped job so it can refund + resolve it instead of letting it linger pending forever. Pure over a job list. */
export function pickImageJob(jobs = [], now = Date.now()) {
  const pending = jobs.filter((j) => j && j.state === 'pending'
    && now - (Number(j.createdAt) || 0) >= IMAGE_JOB_MIN_AGE_MS);
  pending.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  return pending[0] ?? null;
}
export async function readImageJobsPublic() { return readImageJobs(); }

// ── Stranded-reserve reconciliation (remainder wave, 2026-10-28) ─────
// Pre-wave reserves — or reserves whose job creation failed — have no
// job row to recover them, so the tick cycle below refunds them. This
// section ONLY refunds: it never generates, never reads a prompt (none
// exists for pre-wave work), never touches breaker/preflight state, and
// never sends anything but the refund notice. A reserve is stranded iff
// it is old, unsettled, unrefunded, and job-free; see
// PB-STRANDED-RESERVE-PLAN-2026-10-27.md for the full definition and
// the doubt list. Fail polarity, recorded here because it is easy to
// get backwards: unknown job coverage or unknown ledger state must
// NEVER resolve toward refunding — the scan aborts (job read) or stops
// at the row (ledger read) without advancing the watermark past it.
export const STRANDED_RESERVE_MIN_AGE_MS = IMAGE_JOB_MAX_AGE_MS;
export const STRANDED_RESERVE_BATCH = 20;
export const STRANDED_RESERVE_SCAN_LIMIT = 50;
export const STRANDED_SCAN_KEY = 'stranded_reserve_scan_id';
export const STRANDED_REFUND_NOTICE = `♻️ An image charge that never delivered has been refunded — your ${IMAGE_CREDIT_COST} credits are back in full.`;

/** Parse `image:<userId>:<chatId>:<messageId>`; nulls when unparseable. */
export function parseImageRefBase(refBase) {
  const parts = String(refBase ?? '').split(':');
  if (parts.length < 4 || parts[0] !== 'image') return { userId: null, chatId: null };
  const userId = Number(parts[1]);
  const chatId = Number(parts[2]);
  return {
    userId: Number.isFinite(userId) ? userId : null,
    chatId: Number.isFinite(chatId) ? chatId : null,
  };
}

/** Normalized age in ms of a ledger created_at (ms number, sec number,
 *  or ISO string). Returns -1 when the timestamp is unusable — unknown
 *  age is NEVER treated as old enough to refund. Pure. */
export function strandedReserveAgeMs(createdAt, now = Date.now()) {
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
    const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
    return now - ms;
  }
  const t = Date.parse(String(createdAt ?? ''));
  return Number.isNaN(t) ? -1 : now - t;
}

/** Pure stranded decision. Unknown age (-1) is never stranded. */
export function isStrandedReserve({ ageMs, settled, refunded, jobCovered }) {
  return ageMs >= STRANDED_RESERVE_MIN_AGE_MS && !settled && !refunded && !jobCovered;
}

/** Resolve an owner id from a ledger user_key or a refBase; null if neither parses. Pure. */
export function strandedReserveOwnerId(userKey, refBase) {
  const uk = String(userKey ?? '');
  if (uk.startsWith('telegram:')) {
    const n = Number(uk.slice('telegram:'.length));
    if (Number.isFinite(n)) return n;
  }
  return parseImageRefBase(refBase).userId;
}

/**
 * Watermarked scan for stranded reserves. Reads reserve rows with
 * id > watermark in id order (LIMIT 50). STOPS at the first young row
 * (watermark stays below it, so it is revisited once it ages) and
 * stops at the first row whose ledger read fails (same reason).
 * Advances the watermark past settled, refunded, job-covered,
 * corrupt-age-skipped, and refunded-this-scan rows — but NOT past a
 * stranded candidate left unrefunded by the per-tick refund cap.
 * A failed job read throws: the caller must refund nothing and
 * advance nothing that tick. Returns counts + candidates (refBase
 * and owner ids only — never prompts, never amounts beyond the
 * constant cost). The watermark is written even on a partial scan so
 * a later tick resumes where this one stopped.
 */
export async function scanStrandedReserves(now = Date.now(), deps = {}) {
  const rawWm = deps.getWatermark ? await deps.getWatermark() : await getConfig(STRANDED_SCAN_KEY, '');
  let watermark = Number(rawWm);
  if (!Number.isFinite(watermark) || watermark < 0) watermark = 0;
  const rows = deps.rows ?? await db.all(sql`SELECT id, ref_id, user_key, created_at, amount FROM credit_ledger WHERE kind = 'image_reserve' AND id > ${watermark} ORDER BY id ASC LIMIT ${STRANDED_RESERVE_SCAN_LIMIT}`);
  const jobs = deps.jobs ?? await readImageJobs(); // throws -> caller refunds nothing, advances nothing
  const jobBases = new Set((Array.isArray(jobs) ? jobs : []).map((j) => j?.refBase));
  const ledgerState = deps.ledgerState ?? imageJobLedgerState;
  const candidates = [];
  let nextWatermark = watermark;
  let scanned = 0;
  let skippedCorruptAge = 0;
  let skippedNoOwner = 0;
  for (const row of rows) {
    const age = strandedReserveAgeMs(row.created_at, now);
    if (age === -1) { skippedCorruptAge++; scanned++; nextWatermark = Number(row.id); continue; } // unusable timestamp: never refundable, never wedges the scan
    if (age < STRANDED_RESERVE_MIN_AGE_MS) break; // young (incl. future clock-skew): stop, watermark stays below it
    const base = String(row.ref_id).replace(/:reserve$/, '');
    // OWNER-UNLIMITED: a 0-amount reserve marker is not a stranded
    // charge — it can never be refunded into credits. Skip it (watermark
    // still advances). Rows without an amount (old callers, stub rows)
    // fail closed: treated as real charges.
    if (row.amount !== undefined && row.amount !== null && Number(row.amount) >= 0) { scanned++; nextWatermark = Number(row.id); continue; }
    let ledger;
    try {
      ledger = await ledgerState(base);
    } catch {
      break; // unknown ledger state: stop, watermark stays below this row
    }
    scanned++;
    if (ledger.settled || ledger.refunded || jobBases.has(base)) { nextWatermark = Number(row.id); continue; }
    if (strandedReserveOwnerId(row.user_key, base) === null) { skippedNoOwner++; nextWatermark = Number(row.id); continue; }
    if (candidates.length >= STRANDED_RESERVE_BATCH) break; // cap: watermark stays below this candidate
    candidates.push({ refBase: base, userKey: String(row.user_key ?? '') });
    nextWatermark = Number(row.id);
  }
  if (deps.setWatermark) await deps.setWatermark(nextWatermark);
  else await setConfig(STRANDED_SCAN_KEY, String(nextWatermark)).catch(() => {});
  return { candidates, scanned, skippedCorruptAge, skippedNoOwner, watermark: nextWatermark };
}

/**
 * Refund one scanned candidate, exactly once. Rechecks ledger state
 * and job coverage immediately before settling (guards the
 * scan-to-refund race); settleImageCredits is replay-safe by the
 * `:refund` refId, so a second call is a no-op. The DM notice is
 * best-effort: a failed send never undoes the refund. Never throws
 * to the cycle for a per-candidate problem — it returns a reason.
 */
export async function refundStrandedReserve(candidate, deps = {}) {
  const settle = deps.settle ?? settleImageCredits;
  const send = deps.send ?? ((args) => api.sendMessage(args));
  try {
    const ledger = await (deps.ledgerState ?? imageJobLedgerState)(candidate.refBase);
    if (ledger.settled || ledger.refunded) return { refunded: false, reason: 'already-resolved' };
    const jobCovered = deps.jobCovered
      ? await deps.jobCovered(candidate.refBase)
      : (await readImageJobsPublic()).some((j) => j?.refBase === candidate.refBase);
    if (jobCovered) return { refunded: false, reason: 'job-covered' };
    const userId = strandedReserveOwnerId(candidate.userKey, candidate.refBase);
    if (userId === null) return { refunded: false, reason: 'no-owner' };
    // OWNER-UNLIMITED: an owner reserve is a 0 marker — refunding it
    // would send a false "2 credits back" notice for money never spent.
    if ((await ownerIdSet().catch(() => new Set())).has(String(userId))) return { refunded: false, reason: 'owner-no-charge' };
    await settle(userId, candidate.refBase, false);
    const dest = parseImageRefBase(candidate.refBase).chatId ?? userId;
    await send({ chat_id: dest, text: STRANDED_REFUND_NOTICE }).catch(() => {});
    return { refunded: true };
  } catch (err) {
    return { refunded: false, reason: 'error', error: err?.message ?? 'unknown' };
  }
}

/**
 * One charged image generation for the one-shot commands (/meme, /pfp):
 * reserve → generate → deliver → settle. Any failure after the reserve
 * refunds in full and reports the standing failure copy; an insufficient
 * balance refuses before the provider is called (no status message, no
 * generation). deps.generate is the harness seam (defaults to the real
 * Gemini call).
 */
export async function executeImageCommand(tgId, chatId, refBase, { fullPrompt, caption, filename }, deps = {}) {
  // Production (no stubbed gen): Gemini first, Workers AI Flux second,
  // one attempt each — the same 2-provider-call budget the old
  // generateWithRetry gave to Gemini alone. A stubbed gen keeps the
  // old retry shape exactly, so existing harnesses are unaffected.
  const gen = deps.generate ?? null;
  const prompt = applyReferenceBlock(fullPrompt);
  const reserve = deps.reserve ?? reserveImageCredits;
  const settle = deps.settle ?? settleImageCredits;
  // Preflight (wave 2): BEFORE job and reserve. A gated submission
  // leaves no job row, no reserve row, no provider call — an upfront
  // refusal, not a queue. Gate failure itself is fail-open (allowed).
  const gate = await (deps.preflight ? deps.preflight() : checkImagePreflight());
  if (gate && !gate.allowed) {
    await api.sendMessage({ chat_id: chatId, text: gate.copy ?? imagePreflightCopy(gate.kind) }).catch(() => {});
    return { ok: false, reason: 'preflight' };
  }
  // Breaker (wave 3): AFTER preflight, BEFORE job and reserve. A
  // breaker-open submission leaves no job row, no reserve row, no
  // provider call — an upfront refusal, not a queue.
  const brk = await (deps.breaker ? deps.breaker() : checkImageBreaker());
  if (brk && !brk.allowed) {
    await api.sendMessage({ chat_id: chatId, text: brk.copy ?? IMAGE_BREAKER_COPY }).catch(() => {});
    return { ok: false, reason: 'breaker' };
  }
  // Job BEFORE reserve: a kill between reserve and the provider call
  // must leave a recoverable job, not a stranded reserve.
  const job = await createImageJob({ userId: tgId, chatId, refBase, prompt, caption, filename, kind: 'oneshot' });
  try {
    await reserve(tgId, refBase);
  } catch (e) {
    releaseImageBreakerTrial();
    if (job) await deleteImageJob(job.id);
    const text = String(e?.message ?? '').startsWith('Insufficient')
      ? `❌ ${e.message}`
      : '⚠️ Credit billing is temporarily unavailable — please try again shortly.';
    await api.sendMessage({ chat_id: chatId, text }).catch(() => {});
    return { ok: false, reason: 'billing' };
  }
  const status = await api.sendMessage({ chat_id: chatId, text: '🖼️ Generating your image…' }).catch(() => null);
  try {
    const { img } = gen
      ? await generateWithRetry(gen, prompt)
      : await generateImageWithFallback(prompt);
    await api.sendPhoto({
      chat_id: chatId,
      photo: new InputFile(img.bytes, filename, { type: img.mimeType }),
      caption,
      protect_content: true,
    });
    await settle(tgId, refBase, true);
    if (job) await deleteImageJob(job.id);
    await clearImageError();
    await recordImageBreaker(true);
    return { ok: true };
  } catch (err) {
    const cls = classifyImageError(err);
    await recordImageError({ kind: cls.kind, status: cls.status, attempts: err.imageAttempts ?? 1, path: 'oneshot' });
    if (cls.retryable) {
      await recordImageBreaker(false);
      // Queued, not refunded: the tick cycle retries delivery from the
      // job and refunds only on terminal failure / exhaustion.
      await api.sendMessage({ chat_id: chatId, text: await imageQueuedText(tgId) }).catch(() => {});
      return { ok: false, reason: 'queued' };
    }
    releaseImageBreakerTrial();
    await settle(tgId, refBase, false).catch(() => {});
    if (job) await deleteImageJob(job.id);
    await api.sendMessage({ chat_id: chatId, text: imageFailureCopy(cls.kind) }).catch(() => {});
    return { ok: false, reason: 'provider' };
  } finally {
    if (status?.message_id) await api.deleteMessage({ chat_id: chatId, message_id: status.message_id }).catch(() => {});
  }
}

// ── /generate style pick (restored) ─────────────────────────────────────────
// Source: IMG_STYLES + the gen:* style keyboard in the original's /generate.
// /generate now parks the prompt in a config-key session (5-min TTL) and
// renders the style picker; the tap executes through the SAME generator the
// one-shot path used, with the live gate re-checked at execution (Starter+ —
// the live /generate gate; the original's own gate was Pro+, the port's is
// Starter+, and the restore keeps the live one). Style composition matches
// the original's handleGenerate: `${style}: ${prompt}`.
export const IMG_STYLES = {
  art: 'Digital art, vibrant colors, detailed illustration',
  cyb: 'Cyberpunk neon city, futuristic dark aesthetic',
  rea: 'Photorealistic, high detail, professional photo',
  ani: 'Anime style, cel-shaded, Japanese animation',
  mem: 'Funny internet meme, bold impact font, degen crypto humor',
  auto: '',
};
const GEN_STYLE_BUTTONS = [
  { code: 'art', label: '🎨 Digital Art' },
  { code: 'cyb', label: '🌆 Cyberpunk' },
  { code: 'rea', label: '📸 Realistic' },
  { code: 'ani', label: '🎭 Anime' },
  { code: 'mem', label: '💀 Degen Meme' },
  { code: 'auto', label: '🤖 Auto' },
];
const genKey = (userId) => `genpend:${userId}`;

// ── Per-user /generate style default (brand memory, 2026-10-30) ─────
// Add-only: tapping a style remembers it as that user's default; the
// next /generate runs with it without a tap; tapping a different style
// replaces it. Stored per user (`genstyle:<userId>` in the config
// table, the same store as the `genpend:` sessions) — never shared
// across users, and only ever read for the acting user. Fail-open:
// a store failure degrades to the picker path, never to a block.
export const genStyleDefaultKey = (userId) => `genstyle:${userId}`;

/** The user's remembered /generate style code, or null (none/invalid). Pure-validated: only a code in IMG_STYLES counts. */
export async function getGenerateStyleDefault(userId, deps = {}) {
  try {
    const raw = deps.read ? await deps.read() : await getConfig(genStyleDefaultKey(userId), null);
    const code = String(raw ?? '').trim();
    return code in IMG_STYLES ? code : null;
  } catch { return null; }
}

/** Remember a style code for a user. Returns false (no throw) on an invalid code or a store failure. */
export async function setGenerateStyleDefault(userId, code, deps = {}) {
  if (!(code in IMG_STYLES)) return false;
  try {
    if (deps.write) await deps.write(code);
    else await setConfig(genStyleDefaultKey(userId), code);
    return true;
  } catch { return false; }
}

export async function armGenerateStylePick(userId, chatId, prompt) {
  await setConfig(genKey(userId), JSON.stringify({
    chatId, prompt, expiresAt: Date.now() + 5 * 60 * 1000,
  })).catch(() => {});
}

export function generateStyleKeyboard() {
  return {
    inline_keyboard: [
      GEN_STYLE_BUTTONS.slice(0, 3).map((b) => ({ text: b.label, callback_data: `gen:${b.code}` })),
      GEN_STYLE_BUTTONS.slice(3).map((b) => ({ text: b.label, callback_data: `gen:${b.code}` })),
    ],
  };
}

/** gen:<style> execution. Returns { text, alert } for the callback answer. */
export async function handleGenerateCallback(query, deps = {}) {
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const code = String(query.data ?? '').slice('gen:'.length);
  if (!userId || chatId == null || !(code in IMG_STYLES)) return null;

  let sess = null;
  try {
    const raw = await getConfig(genKey(userId), null);
    if (raw) sess = JSON.parse(raw);
  } catch { sess = null; }
  if (!sess?.prompt || !sess.expiresAt || Date.now() > sess.expiresAt || String(sess.chatId) !== String(chatId)) {
    return { text: '⏱️ This request expired — please run /generate again.', alert: true };
  }
  // Brand memory: the tap IS the preference — remember it (fail-open).
  // A refused tap still records a preference, never an entitlement:
  // every gate below still runs at execution.
  await setGenerateStyleDefault(userId, code);
  // Consume first (the original deleted the pending entry before generating).
  await setConfig(genKey(userId), JSON.stringify({ expiresAt: 0 })).catch(() => {});

  const userRow = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, String(userId))).get().catch(() => null);
  // Tier Delegation (2026-10-22): the tap is the SAME /generate command
  // continuing — in a group it re-resolves WITH delegation context, so
  // a manager/granted admin who passed the command gate on a borrowed
  // tier isn't refused here on their own row. The credit reserve below
  // is untouched: it bills THIS user (the actor), never the lender.
  const cbChatType = query.message?.chat?.type;
  const tier = await effectiveTier(userId, userRow,
    (cbChatType === 'group' || cbChatType === 'supergroup')
      ? { chatId, commandName: 'generate', chatType: cbChatType, senderChat: null }
      : null);
  if (!tierAtLeast(tier, 'starter')) {
    return { text: '⛔ Starter+ Required — image generation is available on Starter plans and above. Upgrade with /upgrade.', alert: true };
  }

  // Preflight (wave 2): AFTER the tier gate, BEFORE job and reserve.
  // A gated tap leaves no job and no reserve — an upfront refusal in
  // the same shape as the insufficient-balance refusal below.
  const gate = await (deps.preflight ? deps.preflight() : checkImagePreflight());
  if (gate && !gate.allowed) {
    return { text: gate.copy ?? imagePreflightCopy(gate.kind), alert: true };
  }

  // Breaker (wave 3): AFTER the tier + preflight gates, BEFORE job and
  // reserve. A breaker-open tap leaves no job and no reserve.
  const brk = await (deps.breaker ? deps.breaker() : checkImageBreaker());
  if (brk && !brk.allowed) {
    return { text: brk.copy ?? IMAGE_BREAKER_COPY, alert: true };
  }

  // Charging (restored): reserve BEFORE the provider call, keyed to this
  // picker message — an insufficient balance refuses here, with no edit
  // and no generation; a re-delivered tap replays the same reserve.
  const refBase = `image:${userId}:${chatId}:${query.message.message_id}`;
  const style = IMG_STYLES[code];
  const styleName = GEN_STYLE_BUTTONS.find((b) => b.code === code)?.label ?? '🤖 Auto';
  const fullPrompt = applyReferenceBlock(style ? `${style}: ${sess.prompt}` : sess.prompt);
  // Job BEFORE reserve (same hang-kill reason as the one-shot path).
  const job = await createImageJob({ userId, chatId, refBase, prompt: fullPrompt, caption: `🖼️ ${String(sess.prompt).slice(0, 100)}`, filename: 'generated.png', kind: 'generate' });
  const reserve = deps.reserve ?? reserveImageCredits;
  const settle = deps.settle ?? settleImageCredits;
  try {
    await reserve(userId, refBase);
  } catch (e) {
    releaseImageBreakerTrial();
    if (job) await deleteImageJob(job.id);
    if (String(e?.message ?? '').startsWith('Insufficient')) {
      return { text: `❌ ${e.message}`, alert: true };
    }
    return { text: '⚠️ Credit billing is temporarily unavailable — please try again shortly.', alert: true };
  }

  await api.editMessageText({
    chat_id: chatId, message_id: query.message.message_id,
    text: `⏳ Generating image...\nStyle: ${styleName}\nPrompt: ${String(sess.prompt).slice(0, 200)}${deps.viaDefault ? '\n💡 Saved style — /generate style: … to pick a different one.' : ''}`,
  }).catch(() => {});
  await api.sendChatAction({ chat_id: chatId, action: 'upload_photo' }).catch(() => {});
  const gen = deps.generate ?? null;
  try {
    const { img } = gen
      ? await generateWithRetry(gen, fullPrompt)
      : await generateImageWithFallback(fullPrompt);
    await api.sendPhoto({
      chat_id: chatId,
      photo: new InputFile(img.bytes, 'generated.png'),
      caption: `🖼️ ${String(sess.prompt).slice(0, 100)}`,
      protect_content: true,
    });
    await settle(userId, refBase, true);
    if (job) await deleteImageJob(job.id);
    await clearImageError();
    await recordImageBreaker(true);
    return { text: '🖼️ Done.' };
  } catch (err) {
    const cls = classifyImageError(err);
    await recordImageError({ kind: cls.kind, status: cls.status, attempts: err.imageAttempts ?? 1, path: 'callback' });
    if (cls.retryable) {
      await recordImageBreaker(false);
      await api.editMessageText({
        chat_id: chatId, message_id: query.message.message_id,
        text: await imageQueuedText(userId),
      }).catch(() => {});
      return { text: '🖼️ Queued — I\'ll send it here when it\'s ready.' };
    }
    releaseImageBreakerTrial();
    await settle(userId, refBase, false).catch(() => {});
    if (job) await deleteImageJob(job.id);
    await api.sendMessage({ chat_id: chatId, text: imageFailureCopy(cls.kind) }).catch(() => {});
    return { text: '❌ Generation failed.', alert: true };
  }
}

// ── PB reference looks (2026-10-29) ─────────────────────────────────────────
// Prompt-level style guidance distilled from the images gathered 2026-10-29
// ('PoorBoyAI' album 226 + '$USA' album 76 survey) — full descriptors in
// PB-IMAGE-REFERENCE-GUIDE-2026-10-29.md. generateGeminiImage takes TEXT
// only, so these blocks are appended prompt text, NOT image conditioning.
// A prompt naming no look passes through byte-identical: plain-prompt
// behavior is untouched by construction. Detection order is raid, then
// usa, then pb. 'mascot' alone is deliberately NOT a pb trigger (a generic
// mascot request must not silently gain PB branding); pb/poorboy name it.
export const PB_REFERENCE_BLOCKS = {
  pb: 'PoorBoyAI robot-boy mascot: pale face with glowing cyan circuit lines, white/silver hair, cap, black and blue hoodie, gold interlocked-P emblem, dark background, neon cyan glow, bold poster composition, crisp readable headline text.',
  usa: 'Can\'t Outlaw Us patriotic poster: neon bald eagle and American flag motifs, deep navy and black ground, red white and blue with gold accents, bold veteran-poster composition, crisp readable headline text, merch-ready emblem style.',
  raid: 'Neon RAID poster: dark ground, glowing shield army (Telegram shields or X shields), one huge RAID headline, © PoorBoyAI mark, high-contrast neon poster composition, crisp readable text.',
};

export function detectReferenceLook(text) {
  const t = String(text ?? '');
  if (/\braid\b/i.test(t)) return 'raid';
  if (/\busa\b|outlaw|patriotic|veteran/i.test(t)) return 'usa';
  if (/\bpb\b|poorboy|poor boy/i.test(t)) return 'pb';
  return null;
}

export function pbReferenceBlock(look) {
  return PB_REFERENCE_BLOCKS[look] ?? '';
}

export function applyReferenceBlock(prompt) {
  const look = detectReferenceLook(prompt);
  if (!look) return prompt;
  return `${prompt}\n${PB_REFERENCE_BLOCKS[look]}`;
}
