// PB Studio — tgcloud side (Studio bridge contract, Batches 1–3).
//
// PB is the front door and the bank: /create wizard + Mini App endpoints,
// script generation via lib/llm.js under the repurpose claim guard, and ALL
// credit movement on the one shared credit_ledger (reserve / settle /
// refund, refId-keyed, replay-safe — the repurpose-wave precedent).
// Rendering never happens here; the D1 `studio_jobs` queue on the Worker
// is the queue of record and the local `studio_jobs` table is PB's mirror.
// The tick (lib/websync.js runWebSync) pushes PB-owned transitions and
// pulls status deltas through the same HMAC channel family as repurpose.
//
// Flag: config 'studio_enabled' (default OFF), read through the shared
// tolerant boolean reader (lib/config.js getConfigFlag — audit F19).
// Flag OFF preserves the parked behavior exactly: /create sends
// MOVING_NOTICE and every Mini App endpoint returns { parked: true, ... }.

import { api, fetch } from 'sdk';
import db, { eq, desc, sql } from 'sdk/db';
import { studio_jobs, credit_ledger, bot_users, web_subscriptions, studio_access_grants } from '../schema.js';
import { getConfig, setConfig, getConfigFlag } from './config.js';
import { askLLM, runScriptCouncil } from './llm.js';
import { generateSafeOutboundContent, assertSafeOutboundContent, xQueueAdd, xQueueAddVideo, studioVideoFileKey } from './repurpose.js';
import { CANONICAL_TIERS, canonicalTier, weekTrialStatus, commitWeekTrialDraw, restoreWeekTrialCredits, includedAllowanceForOne } from './tiers.js';
import { ownerIdSet, bytesToBase64 } from './groups.js';

// Byte-identical to MOVING_NOTICE in handlers/message.js — the parked
// /create reply must not drift from the catalog fallback text.
export const STUDIO_MOVING_NOTICE =
  '🚚 That command is moving into PB\u2019s new home and returns in the next rollout. Core commands (/start /help /price /ca /chart /scan /ask /profile) are live now.';

export const STUDIO_VIBES = ['hype', 'professional', 'degen'];
export const STUDIO_DURATIONS = [15, 20, 30, 45, 60]; // F16 (2026-11-06, Rowdy tap 21:28): 20s added so a 20s request bills 50 instead of silently falling back to 15s/25.
export const INCLUDED_ALLOWANCES = { free: 0, starter: 100, builder: 500, pro: 1200, agency: 2500, one: 0, trial: 0 };
// PRICING WAVE (2026-10-31): 'one' reads its included allowance from the
// pb_included_allowance_credits config key (getStudioEntitlement below) —
// the allowance number was never decided, so the table holds 0 and NO
// customer-facing copy may promise a number until Rowdy decides it.
// 'trial' draws from the pb_trials counter, never from this table.
const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
// States in which a job can still be cancelled: before the render pipeline
// starts. 'voice_ready' (TTS done, pipeline not started) cancels cleanly —
// the bridge cancel lands (row is not 'rendering') and the worker's next
// progress/check aborts. 'rendering' is EXCLUDED on purpose: the bridge push
// fence (site _worker.js: PB status transitions apply only while the row is
// not rendering) means a cancel never lands on a claimed job, so offering it
// would refund AND deliver — a credit leak. Rendering cancel waits on that
// bridge change (site promotion, owner's call).
const PRE_RENDER_STATES = ['pending', 'script_ready', 'voice_ready'];
const TERMINAL_STATES = ['complete', 'failed', 'cancelled'];

export async function isStudioEnabled() {
  try { return await getConfigFlag('studio_enabled'); } catch { return false; }
}

// ── Studio premium (Batch 4): Grok Imagine backgrounds + xAI voice ───────
// USER-facing gate: config studio_premium_enabled. Default OFF (key unset).
// While off, every premium param is ignored and every Studio surface is
// byte-identical to the pre-Batch-4 behavior. Pricing (design): Imagine
// footage +50 cr per 5s at 720p; one generation is capped at 15s by the
// provider, and the clip loops as the render's background exactly like the
// stock plates, so footage seconds = min(job duration, 15). The xAI voice
// is a flat +10 cr per job — priced 2026-10-21 off the VERIFIED rate
// (replaces the Batch 4 blind PLACEHOLDER of 50): xAI's published
// Text-to-Speech price is $15.00 per 1M characters
// (docs.x.ai/developers/pricing). One premium-voice job is ONE TTS call
// carrying the ad script, and scripts are hard-capped at 1,200 characters
// (EDIT_SCRIPT_CHAR_CAP — also generateStudioScript's ceiling), so the
// worst-case job costs 1,200 × $0.000015 = $0.018, or $0.036 counting the
// worker's one stall-retry. At the cheapest pack rate (5,000 cr / $99 →
// $0.0198/cr) 10 cr returns $0.198 ≈ 5.5× that worst case; typical jobs
// run ~230 chars (15s, ≈$0.0035) to ~900 chars (60s, ≈$0.0135). The price
// only ever applies behind this flag.
export async function isStudioPremiumEnabled() {
  try { return await getConfigFlag('studio_premium_enabled'); } catch { return false; }
}
export const PREMIUM_IMAGINE_CREDITS_PER_5S = 50;
export const PREMIUM_IMAGINE_MAX_SECONDS = 15;
export const PREMIUM_VOICE_CREDITS = 10;
export function premiumImagineSeconds(durationSec) {
  const d = STUDIO_DURATIONS.includes(Number(durationSec)) ? Number(durationSec) : 15;
  return Math.min(d, PREMIUM_IMAGINE_MAX_SECONDS);
}
/** Normalize a premium request against a job duration. Pure. */
export function normalizePremium(raw, durationSec) {
  if (!raw || typeof raw !== 'object') return null;
  const imagine = raw.imagine === true || Number(raw.imagineSeconds) > 0;
  const imagineSeconds = imagine ? premiumImagineSeconds(durationSec) : 0;
  const voice = raw.voice === 'xai' ? 'xai' : null;
  if (!imagineSeconds && !voice) return null;
  return {
    ...(imagineSeconds ? { imagineSeconds } : {}),
    ...(voice ? { voice } : {}),
  };
}
export function premiumCost(premium) {
  if (!premium) return 0;
  return (premium.imagineSeconds ? PREMIUM_IMAGINE_CREDITS_PER_5S * (premium.imagineSeconds / 5) : 0)
    + (premium.voice === 'xai' ? PREMIUM_VOICE_CREDITS : 0);
}
export function studioCostWithPremium(durationSec, premium) {
  return studioCost(durationSec) + premiumCost(premium);
}

/** Cost schedule (F16, Rowdy tap 2026-11-06 21:28): 25 cr ≤15s, +25 per additional 15s block. 15s=25, 20s=50, 30s=50, 45s=75, 60s=100. Supersedes the +15 ladder (30s was 40, 60s was 70). */
export function studioCost(durationSec) {
  const d = STUDIO_DURATIONS.includes(Number(durationSec)) ? Number(durationSec) : 15;
  const blocks = Math.ceil(d / 15);
  return 25 + 25 * (blocks - 1);
}

function nowSec() { return Math.floor(Date.now() / 1000); }

function toSec(v) {
  if (v == null || v === '') return 0;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  const p = Date.parse(v);
  return Number.isFinite(p) ? Math.floor(p / 1000) : 0;
}

function mintJobId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'sj_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Storyboard (deterministic; mirrors normalizeCinematicStoryboard's
// contract: 3–6 shots, each 1–12s, visual ∈ neon_energy / clean_product /
// abstract_motion / cta_focus, camera ∈ static / push_in / pan_left /
// pan_right, transition ∈ cut / dissolve / fade, caption ≤280, 16:9) ──────

const VIBE_VISUALS = {
  hype: ['neon_energy', 'neon_energy', 'abstract_motion', 'neon_energy', 'abstract_motion', 'cta_focus'],
  professional: ['clean_product', 'clean_product', 'abstract_motion', 'clean_product', 'abstract_motion', 'cta_focus'],
  degen: ['neon_energy', 'abstract_motion', 'neon_energy', 'abstract_motion', 'neon_energy', 'cta_focus'],
};
const CAMERA_CYCLE = ['push_in', 'pan_left', 'static', 'pan_right'];
const TRANSITION_CYCLE = ['cut', 'dissolve', 'fade'];

export function buildStoryboard(script, vibe = 'hype', durationSec = 15, token = {}) {
  const v = STUDIO_VIBES.includes(vibe) ? vibe : 'hype';
  const total = STUDIO_DURATIONS.includes(Number(durationSec)) ? Number(durationSec) : 15;
  const name = String(token.tokenName ?? token.name ?? 'this token').trim() || 'this token';
  const symbol = String(token.tokenSymbol ?? token.symbol ?? '').trim();

  let sentences = String(script ?? '').replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 3) {
    // Pad deterministically so the 3-shot floor always holds.
    const pad = [
      `Meet ${name}${symbol ? ` — $${symbol}` : ''}.`,
      'Built for the community, ready for the moment.',
      `Check out ${name} today.`,
    ];
    sentences = [...sentences, ...pad].slice(0, Math.max(3, sentences.length));
    while (sentences.length < 3) sentences.push(pad[sentences.length % pad.length]);
  }
  const minShotsForDuration = Math.ceil(total / 12); // each shot ≤ 12s
  const shotCount = Math.min(6, Math.max(3, sentences.length, minShotsForDuration));
  // Distribute sentences across shots (extras fold into the last shots).
  const buckets = Array.from({ length: shotCount }, () => []);
  sentences.forEach((s, i) => buckets[Math.min(i, shotCount - 1)].push(s));

  const visuals = VIBE_VISUALS[v];
  const base = Math.floor((total / shotCount) * 10) / 10;
  let used = 0;
  const shots = buckets.map((bucket, i) => {
    const isLast = i === shotCount - 1;
    const duration = isLast ? Math.round((total - used) * 10) / 10 : base;
    used += duration;
    return {
      id: `shot-${i + 1}`,
      order: i + 1,
      durationSec: Math.min(12, Math.max(1, duration)),
      visual: isLast ? 'cta_focus' : visuals[i % visuals.length],
      camera: CAMERA_CYCLE[i % CAMERA_CYCLE.length],
      caption: bucket.join(' ').slice(0, 280) || name,
      transition: TRANSITION_CYCLE[i % TRANSITION_CYCLE.length],
    };
  });
  return { version: 1, aspectRatio: '16:9', shots };
}

// ── Demo-video template family (surveyed X demo structure, 2026-10-29) ──
// 19 shared X posts surveyed, 12 with videos. The build, consistent
// across all 12: 20–28s looping, ONE continuous animated graphic (no cuts,
// no people, no click-through tutorial), muted by default (music at most,
// never narration/subtitles), dark theme, on-screen labels carry it.
// This builder produces a VIDEO BRIEF only — it renders nothing, spends
// nothing, and changes no live path until a Studio/Ad Creator caller
// uses it. Numbers in a brief must be verified (comparison.verified
// === true) or the brief is refused: demo templates never invent totals.
// Orientation is left to the renderer; surveyed videos are phone-feed-first.
export const DEMO_VIDEO_FORMS = ['wheel', 'pipeline', 'list_pan', 'counter_climb', 'system_graphic'];
const DEMO_VIDEO_MOVEMENT = {
  wheel: 'slow_rotate',
  pipeline: 'slow_pan',
  list_pan: 'slow_pan',
  counter_climb: 'climbing_counters',
  system_graphic: 'slow_zoom',
};
const DEMO_VIDEO_BANNED = ['free brain', 'free brains', 'ladder', 'groq', 'gemini', 'openrouter', 'mistral', 'xai', 'grok', 'claude', 'codex', 'powered by', 'under the hood'];
function demoVideoBannedHit(text) {
  const s = String(text ?? '').toLowerCase();
  return DEMO_VIDEO_BANNED.find((b) => s.includes(b)) ?? null;
}
export function buildDemoVideoBrief({ headline, jobs, form = 'pipeline', closingLine = '', comparison = null, approveGate = false } = {}) {
  const head = String(headline ?? '').trim();
  if (!head) throw new Error('demo video headline is required');
  if (head.length > 120) throw new Error('demo video headline must be 120 chars or fewer');
  const jobList = Array.isArray(jobs) ? jobs.map((j) => String(j ?? '').trim()).filter(Boolean) : [];
  if (jobList.length < 2 || jobList.length > 10) throw new Error('demo video needs 2–10 jobs');
  for (const j of jobList) if (j.length > 60) throw new Error('demo video job labels must be 60 chars or fewer');
  if (!DEMO_VIDEO_FORMS.includes(form)) throw new Error('unknown demo video form: ' + String(form));
  const close = String(closingLine ?? '').trim();
  if (close.length > 120) throw new Error('demo video closing line must be 120 chars or fewer');
  const texts = [head, close, ...jobList, ...(comparison?.label != null ? [String(comparison.label)] : [])];
  const hit = texts.map(demoVideoBannedHit).find(Boolean);
  if (hit) throw new Error('demo video text must not mention internal mechanics: ' + hit);
  let verifiedComparison = null;
  if (comparison != null) {
    if (comparison.verified !== true || String(comparison.before ?? '').trim() === '' || String(comparison.after ?? '').trim() === '') {
      throw new Error('demo video comparison numbers must be verified (verified: true with before/after labels)');
    }
    verifiedComparison = { label: String(comparison.label ?? '').trim(), before: String(comparison.before).trim(), after: String(comparison.after).trim() };
  }
  const onScreenText = [head, ...jobList, ...(close ? [close] : [])];
  return {
    version: 1,
    form,
    durationTargetSec: { min: 20, max: 28 },
    audio: 'muted_or_music_only',
    theme: 'dark',
    movement: DEMO_VIDEO_MOVEMENT[form],
    shots: [{ id: 'shot-1', order: 1, continuous: true, movement: DEMO_VIDEO_MOVEMENT[form], visual: form, onScreenText }],
    headline: head,
    jobs: jobList,
    closingLine: close,
    approveGate: Boolean(approveGate),
    comparison: verifiedComparison,
  };
}

// ── Script generation (askLLM under the outbound claim guard) ─────────────
// Consistent with brain.js's Studio paragraph: original branded 16:9 MP4,
// generated voiceover, timed captions, music, token branding, motion or
// generative background — and the claims boundary (no lip-sync / identity
// transfer / photoreal acting / guaranteed performance promises).

export const STUDIO_SYSTEM_PROMPT = `You are PB, the PoorBoyAI Studio script writer.
Write a short spoken ad script for an original branded 16:9 MP4: PB writes the script,
a generated voiceover reads it, with timed captions, background music, token branding,
and a motion or generative background. Write ONLY the script text — plain sentences the
voiceover will read, no stage directions, no labels, no quotation marks.
Never promise or imply lip-sync, identity transfer, copied footage, photorealistic
acting, real people, or guaranteed marketing performance. Never invent live prices,
metrics, or holder-based subscription discounts, upgrades, or access.`;

function fallbackScript(params) {
  const name = String(params.tokenName ?? 'this token').trim() || 'this token';
  const symbol = String(params.tokenSymbol ?? '').trim();
  const brief = String(params.brief ?? '').trim().slice(0, 160);
  return [
    `Meet ${name}${symbol ? `, $${symbol}` : ''}.`,
    brief || 'Built in the open, powered by its community.',
    'Real community. Real momentum. No shortcuts.',
    `This is ${name}. Check it out today.`,
  ].join(' ');
}

// ── Site-URL guard (PB-brand ads only) ───────────────────────────────────
// The branded .com domain is PARKED (resolves to the dead Replit
// deployment; Rowdy does not control it yet), so a PB script that sends
// viewers there sends them nowhere. The live site is config 'site_url'
// (default https://poorboyai.pages.dev — the same value the site build
// calls SITE_ORIGIN). Two layers, mirroring the repurpose claim guard's spirit:
// (1) the generation prompt hands PB-brand scripts the canonical address;
// (2) a deterministic post-generation rewrite catches any parked-domain
// form the brain still produces. Brand signal: isPbaiToken (symbol PBAI
// or the verified CA) — the SAME check normalizeParams uses to derive
// mascot=1, so the guard and the mascot can never disagree, and a client
// passing mascot=1 for a third-party token cannot trigger a rewrite.
// Third-party ads are NEVER rewritten: their CTA is the customer's own.

const DEFAULT_SITE_URL = 'https://poorboyai.pages.dev';
// Assembled from parts on purpose (pages.dev sweep, 2026-10-20): the parked
// host never appears as a literal in the shipped source — it exists only as
// the needle the guard below rewrites out of generated scripts.
const PARKED_SITE_HOST = 'poorboyai' + '.com';

export async function getSiteUrl() {
  try {
    const v = String((await getConfig('site_url', '')) ?? '').trim();
    return v || DEFAULT_SITE_URL;
  } catch { return DEFAULT_SITE_URL; }
}

function siteHostOf(siteUrl) {
  const h = String(siteUrl ?? '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  return h || siteHostOf(DEFAULT_SITE_URL);
}

/**
 * Rewrite parked-domain references (written and spoken forms of
 * PARKED_SITE_HOST) to the configured
 * site's host. No-op when the configured site IS the parked host (the
 * un-parked end state) or when the text carries no parked reference.
 */
export function rewriteParkedSiteRefs(text, siteUrl) {
  const host = siteHostOf(siteUrl);
  if (host.toLowerCase() === PARKED_SITE_HOST) return String(text ?? '');
  const spoken = host.replace(/\./g, ' dot ');
  return String(text ?? '')
    .replace(/\bpoorboyai\s+dot\s+com\b/gi, spoken)
    .replace(/\b(?:www\.)?poorboyai\.com\b/gi, host);
}

export function studioScriptPrompt(params, siteUrl = null) {
  const words = Math.round((Number(params.durationSec) || 15) * 2.5);
  const host = siteUrl ? siteHostOf(siteUrl) : null;
  return [
    `Write a ${params.durationSec ?? 15}-second ${params.vibe ?? 'hype'} video ad script (about ${words} words, 3–5 short sentences).`,
    `Token: ${params.tokenName ?? ''}${params.tokenSymbol ? ` ($${params.tokenSymbol})` : ''}`,
    params.brief ? `Brief: ${String(params.brief).slice(0, 600)}` : '',
    host
      ? `Website call to action: the live site is ${host}. If the script sends viewers to a website, use exactly "${host}" (spoken: "${host.replace(/\./g, ' dot ')}"). Never use ${PARKED_SITE_HOST} — that domain is parked and dead.`
      : '',
    'End with a clear call to action. Return only the script.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Generate a script + storyboard. deps.ask injectable for tests (defaults
 * to askLLM). LLM failures propagate — a fabricated script is never
 * silently substituted on a provider failure; the claim-guard fallback is
 * a deterministic template used only when generated text is BLOCKED.
 */
export async function generateStudioScript(params, deps = {}) {
  const ask = deps.ask || askLLM;
  // Site-URL guard applies to PB-brand ads only (see the guard block
  // above); the site is resolved once and feeds both the prompt and the
  // post-generation rewrite. deps.siteUrl is injectable for tests.
  const siteUrl = isPbaiToken(params) ? (deps.siteUrl ?? await getSiteUrl()) : null;
  const prompt = studioScriptPrompt(params, siteUrl);

  // SCRIPT COUNCIL (W1A): up to three ladder models draft the script
  // concurrently and the deterministic scorer in lib/llm.js picks the
  // winner. Fail-open: a null council (every rung down) — or a winner
  // the outbound claim guard blocks — falls through to the exact
  // pre-council single-script path below. deps.ask injection keeps its
  // legacy meaning (no council) unless deps.generateCandidate is also
  // supplied, which is the harness seam for forcing rung failures.
  if (!deps.ask || deps.generateCandidate) {
    let council = null;
    try {
      council = await runScriptCouncil(
        { systemPrompt: STUDIO_SYSTEM_PROMPT, userMessage: prompt, durationSec: params.durationSec },
        { generateCandidate: deps.generateCandidate },
      );
    } catch { council = null; }
    if (council?.winnerScript) {
      let winnerOk = true;
      try { assertSafeOutboundContent(council.winnerScript); } catch { winnerOk = false; }
      if (winnerOk) {
        let clean = String(council.winnerScript).replace(/\s+/g, ' ').trim().slice(0, 1200);
        if (siteUrl) clean = rewriteParkedSiteRefs(clean, siteUrl);
        if (clean) {
          const storyboard = buildStoryboard(clean, params.vibe, params.durationSec, params);
          storyboard.script_council = {
            candidates: council.candidates,
            winnerIndex: council.winnerIndex,
            scorerVersion: council.scorerVersion,
          };
          return { script: clean, storyboard };
        }
      }
    }
  }

  const script = await generateSafeOutboundContent(
    () => ask({
      systemPrompt: STUDIO_SYSTEM_PROMPT,
      userMessage: prompt,
      history: [],
      maxOutputTokens: 400,
    }),
    fallbackScript(params),
  );
  let clean = String(script ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  // Post-generation guard: whatever the brain (or the claim-guard
  // fallback) produced, a PB-brand script never ships a parked-domain
  // CTA. Storyboard captions derive from this final text, so they are
  // covered by the same rewrite.
  if (siteUrl) clean = rewriteParkedSiteRefs(clean, siteUrl);
  if (!clean) throw new Error('Script generation came back empty.');
  return { script: clean, storyboard: buildStoryboard(clean, params.vibe, params.durationSec, params) };
}

// ── Gap-3 draft edits: user-typed replacement scripts ───────────────────
// The broadcast edit pattern (lib/nlcmd.js) generalized for the wizards:
// a user-supplied script is vetted by the SAME rules a generated one
// passes — (a) the outbound claim guard (assertSafeOutboundContent, the
// deterministic check generateSafeOutboundContent applies to generated
// text; an edit is never a guard bypass), (b) the parked-site rewrite
// for PB-brand scripts, (c) the word budget (the studioScriptPrompt
// words-per-second math, with the podcast approve rule's 1.15 headroom)
// with the overage NAMED — never a silent truncation. A refusal leaves
// the stored draft untouched, so the user can send a fixed version.
const EDIT_SCRIPT_CHAR_CAP = 1200; // generateStudioScript's own ceiling

function editWordCount(text) {
  return String(text ?? '').split(/\s+/).filter(Boolean).length;
}

export function vetEditedStudioScript(rawText, { durationSec = 15, siteUrl = null } = {}) {
  let clean = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: 'That came back empty — send the full script text.' };
  try {
    assertSafeOutboundContent(clean);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? 'That text trips the claim guard.') };
  }
  if (siteUrl) clean = rewriteParkedSiteRefs(clean, siteUrl);
  if (clean.length > EDIT_SCRIPT_CHAR_CAP) {
    return {
      ok: false,
      error: `That runs ${clean.length} characters — over the ${EDIT_SCRIPT_CHAR_CAP}-character script ceiling by ${clean.length - EDIT_SCRIPT_CHAR_CAP}. Trim it and send it again.`,
    };
  }
  const dur = Number(durationSec) || 15;
  const budget = Math.round(dur * 2.5);
  const maxWords = Math.ceil(budget * 1.15);
  const words = editWordCount(clean);
  if (words > maxWords) {
    return {
      ok: false,
      error: `That runs ${words} words — over the ~${budget}-word budget for a ${dur}s ad (max ${maxWords}). Trim ${words - maxWords} word${words - maxWords === 1 ? '' : 's'} and send it again.`,
    };
  }
  return { ok: true, script: clean };
}

// ── Photo/Link video-ad wizard (2026-11-04 wave) ─────────────────────────
// Revitalized Replit video-ad job rules, inside the existing /create
// wizard (no new command, no new module):
//  - Intake is new: a product photo (Telegram file_id) or a product link
//    (fetched facts, shown for correction — never invented).
//  - Draft is hook + script + plan + caption + ≤2 hashtags, built on the
//    existing v2 script standard (generateStudioScript, claim-guarded).
//  - Fail discipline (Replit video-ad-job.md): every new catch tells the
//    user the reason and leaves the wizard retryable — never a silent
//    spinner. Job-side failures use the existing terminal + exactly-once
//    refund path (applyStudioDelta), unchanged.
//  - Photo handoff to the renderer: a link photo URL rides logo_url (the
//    existing column, renderer-fetchable). A Telegram photo rides
//    storyboard_json.videoAd.photoFileId (the Batch-4 premium precedent
//    for extra storyboard keys) + the per-job config meta below; the
//    external render worker reading that key is a NAMED GAP, not claimed
//    done here. R2 upload is hard-gated, so no bot-side upload path is
//    invented.
//  - Customer ads default to file delivery only. PB's own ads (mascot)
//    get an owner-only "Queue to X" button on the completion DM, reusing
//    the existing video-to-X path (xQueueAdd + videoJobId).
//  - Credit cost per render is a CONFIG PARAMETER
//    (studio_video_ad_cost_credits) — Rowdy's number is pending. Unset
//    or invalid = approve is blocked with an honest message. No price
//    is invented anywhere in this section.
//  - Codie's ad-craft note (board task 432, not landed at build time)
//    folds in with zero code change: when config
//    studio_video_ad_craft_note is set, its text joins the draft brief.

export const VIDEO_AD_DURATIONS = [5, 10, 15];
export const VIDEO_AD_COST_KEY = 'studio_video_ad_cost_credits';
export const VIDEO_AD_CRAFT_NOTE_KEY = 'studio_video_ad_craft_note';
export const VIDEO_AD_HASHTAGS_KEY = 'studio_video_ad_hashtags';
export const videoAdMetaKey = (jobId) => `studio_videoad:${String(jobId ?? '')}`;
// Hashtag bank, v1 seed: PB's own tags first, then generic crypto tags.
// Overridable without a code change via config
// studio_video_ad_hashtags (comma list, max 10 kept). No "researched
// bank" existed in the tree — this seed is explicit, not a research claim.
// F17 (Rowdy 2026-11-06): this bank applies to PB ads ONLY —
// pickVideoAdHashtags never draws from it for a non-PB ad.
export const VIDEO_AD_HASHTAG_BANK = ['PoorBoyAI', 'PBAI', 'Base', 'Crypto', 'Web3'];
export const VIDEO_AD_MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const VIDEO_AD_MAX_LINK_BYTES = 512 * 1024;

/** First http(s) URL in the text, or null. Trailing punctuation stripped. */
export function extractVideoAdUrl(text) {
  const m = /https?:\/\/[^\s]+/i.exec(String(text ?? '').trim());
  if (!m) return null;
  return m[0].replace(/[),.;!?]+$/, '');
}

function linkMetaContent(html, names) {
  const tags = String(html ?? '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    for (const m of tag.matchAll(/([a-zA-Z-]+)\s*=\s*["']([^"']*)["']/g)) attrs[m[1].toLowerCase()] = m[2];
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (names.includes(key) && attrs.content) return String(attrs.content).trim();
  }
  return null;
}

/**
 * Product facts from a fetched page. Every field is null when the page
 * does not carry it — the wizard SHOWS nulls as "not found" for
 * correction and never invents a fact.
 */
export function parseLinkFacts(html, url) {
  const h = String(html ?? '');
  const titleTag = (/<title[^>]*>([^<]*)<\/title>/i.exec(h)?.[1] ?? '').trim() || null;
  return {
    url: String(url ?? ''),
    title: linkMetaContent(h, ['og:title', 'twitter:title']) || titleTag,
    description: linkMetaContent(h, ['og:description', 'twitter:description', 'description']),
    imageUrl: linkMetaContent(h, ['og:image', 'og:image:url', 'twitter:image']),
    price: linkMetaContent(h, ['product:price:amount', 'og:price:amount']),
  };
}

/** Fetch a product page and extract its facts. Throws with a user-facing
 *  reason on any failure — the caller tells the user and stays retryable. */
export async function fetchLinkFacts(url, deps = {}) {
  const doFetch = deps.fetchImpl ?? fetch;
  if (typeof doFetch !== 'function') throw new Error('link fetch is unavailable here');
  const res = await doFetch(String(url), {
    headers: { 'user-agent': 'PoorBoyAI-Studio/1.0 (+https://poorboyai.pages.dev)', accept: 'text/html,*/*' },
    redirect: 'follow',
  });
  if (!res || !res.ok) throw new Error(`that link answered ${res?.status ?? 'nothing'} — check the URL and try again`);
  const ct = String(res.headers?.get?.('content-type') ?? '');
  if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
    throw new Error('that link is not a web page — send a product page URL, or a photo instead');
  }
  const html = String(await res.text()).slice(0, VIDEO_AD_MAX_LINK_BYTES);
  const facts = parseLinkFacts(html, url);
  if (!facts.title && !facts.description && !facts.imageUrl) {
    throw new Error('could not read any product facts from that page — send a photo or a brief instead');
  }
  return facts;
}

/** Config cost, fail-closed: positive integer only, else null (no price). */
export function normalizeVideoAdCost(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0 || n > 10000) return null;
  return n;
}

export async function studioVideoAdCost() {
  try { return normalizeVideoAdCost(await getConfig(VIDEO_AD_COST_KEY, null)); } catch { return null; }
}

/** Codie's ad-craft note when it has landed in config, else null. */
export async function videoAdCraftNote() {
  try {
    const v = String((await getConfig(VIDEO_AD_CRAFT_NOTE_KEY, '')) ?? '').trim();
    return v ? v.slice(0, 2000) : null;
  } catch { return null; }
}

export async function videoAdHashtagBank() {
  try {
    const raw = String((await getConfig(VIDEO_AD_HASHTAGS_KEY, '')) ?? '').trim();
    if (!raw) return [...VIDEO_AD_HASHTAG_BANK];
    const tags = raw.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean).slice(0, 10);
    return tags.length ? tags : [...VIDEO_AD_HASHTAG_BANK];
  } catch { return [...VIDEO_AD_HASHTAG_BANK]; }
}

/** At most 2 hashtags, deduped case-insensitively. PB's own tag first
 *  for PB ads, then the token cashtag, then the bank in order.
 *  F17 (Rowdy 2026-11-06): the bank is PB's own tags — it fills PB ads
 *  ONLY. A non-PB ad gets its token cashtag and nothing else; with no
 *  parseable symbol its slots stay empty rather than stamped with PB's. */
export function pickVideoAdHashtags({ tokenSymbol = '', isPbai = false, bank = VIDEO_AD_HASHTAG_BANK } = {}) {
  const out = [];
  const push = (t) => {
    const tag = String(t ?? '').trim().replace(/^#/, '');
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  };
  if (isPbai) push('PoorBoyAI');
  const sym = String(tokenSymbol ?? '').replace(/^\$/, '').trim();
  if (sym) push(sym);
  if (isPbai) {
    for (const t of bank ?? []) { if (out.length >= 2) break; push(t); }
  }
  return out.slice(0, 2);
}

/** First $SYM (2–12 alnum, at least one letter — a price like $25 is not
 *  a symbol) in the brief, or '' — the seller naming their project in
 *  their own words (e.g. a brief that says "add the $USA hashtags" when
 *  the token step gave no symbol). PBAI and any bank tag NEVER derive
 *  this way: only the token step / PB quick-pick declares PB, so a stray
 *  "$PBAI" mention in a non-PB brief cannot reintroduce a PB tag. Pure. */
export function briefTokenSymbol(brief, bank = VIDEO_AD_HASHTAG_BANK) {
  const m = /\$([A-Za-z0-9]{2,12})\b/.exec(String(brief ?? ''));
  if (!m) return '';
  const sym = m[1].toUpperCase();
  if (!/^[A-Z]/.test(sym)) return ''; // a price ($25, $25k), not a symbol
  if (sym === 'PBAI') return '';
  if ((bank ?? []).some((t) => String(t ?? '').toUpperCase() === sym)) return '';
  return sym;
}

/** Hook = the script's first sentence (deterministic, never invented). */
export function videoAdHookFromScript(script) {
  const s = String(script ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = /^[^.!?]+[.!?]/.exec(s);
  return (m ? m[0] : s.split(' ').slice(0, 12).join(' ')).trim();
}

/** Plan = the storyboard shots as a short shot list. Pure. */
export function videoAdPlanFromStoryboard(storyboard) {
  const shots = Array.isArray(storyboard?.shots) ? storyboard.shots : [];
  if (!shots.length) return '';
  return shots.map((sh) => `${sh.order ?? ''}. ${sh.visual ?? ''} ${sh.durationSec ?? ''}s — ${(sh.caption ?? '').slice(0, 80)}`.trim()).join('\n');
}

/** X caption: hook + product line + site/source link + ≤2 hashtags.
 *  Hard-capped at the 1000-char X law. Pure. */
export function buildVideoAdCaption({ hook = '', productName = '', siteHost = '', hashtags = [], sourceUrl = '' } = {}) {
  const tags = (hashtags ?? []).slice(0, 2).map((t) => `#${String(t).replace(/^#/, '')}`);
  const parts = [];
  if (hook) parts.push(hook);
  if (productName) parts.push(`🎬 ${productName} — watch the ad.`);
  if (siteHost) parts.push(`👉 ${siteHost}`);
  else if (sourceUrl) parts.push(`👉 ${sourceUrl}`);
  if (tags.length) parts.push(tags.join(' '));
  let caption = parts.join('\n').trim();
  if (caption.length > 1000) caption = caption.slice(0, 997).trimEnd() + '…';
  return caption;
}

/**
 * Describe a Telegram photo for the draft: download once via
 * getFileContent (the established isolate pattern), then one Gemini
 * vision call that states only what it can see ("unknown" otherwise).
 * Best-effort by design: any failure returns { ok:false, reason } and
 * the draft proceeds from the user's brief with the reason shown — the
 * photo still rides to the render via its file_id.
 */
export async function describeVideoAdPhoto(fileId, deps = {}) {
  const getFile = deps.getFileContent ?? (api?.getFileContent ? api.getFileContent.bind(api) : null);
  if (!getFile) return { ok: false, reason: 'photo download is unavailable here' };
  let bytes;
  try { bytes = await getFile(String(fileId)); } catch (e) {
    return { ok: false, reason: 'could not download that photo: ' + String(e?.message ?? e).slice(0, 120) };
  }
  if (!bytes?.length) return { ok: false, reason: 'that photo came back empty' };
  if (bytes.length > VIDEO_AD_MAX_PHOTO_BYTES) return { ok: false, reason: 'that photo is too large — send a smaller one (under 8 MB)' };
  const key = await getConfig('GEMINI_API_KEY').catch(() => null);
  if (!key) return { ok: false, reason: 'photo reading is not wired up yet — send a short brief with the product name and the draft will use that' };
  // Pure-JS base64 (F13, 2026-11-06): the tgcloud isolate has NO btoa
  // global — the old `btoa(bin)` here threw before any network call, so
  // the Studio video-ad wizard's photo description was dead live (same
  // defect class as F1's groups.js vision fix, rev 583). Reuses
  // lib/groups.js bytesToBase64 (same proven shape as lib/boost.js
  // bytesToB64, byte-identical to standard base64); the old chunked
  // String.fromCharCode spread is gone with it.
  const b64 = bytesToBase64(bytes);
  const doFetch = deps.fetchImpl ?? fetch;
  let res;
  try {
    res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: 'Describe this product photo in 2 short sentences for a video ad script: what the product is, what it looks like, any visible brand/name/price. Only state what you can see. If anything is unclear, say unknown for that part. No marketing promises.' },
          { inlineData: { mimeType: 'image/jpeg', data: b64 } },
        ] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'photo reading failed — send a short brief with the product name and the draft will use that' };
  }
  if (!res?.ok) return { ok: false, reason: 'photo reading failed — send a short brief with the product name and the draft will use that' };
  const data = await res.json().catch(() => null);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  if (!text) return { ok: false, reason: 'photo reading came back empty — send a short brief with the product name and the draft will use that' };
  return { ok: true, description: text.slice(0, 600) };
}

/**
 * Full video-ad draft: script via the existing v2 standard (claim
 * guard, council), then hook / plan / caption / hashtags derived
 * deterministically from it. The brief carries the photo description
 * and Codie's craft note when present. LLM failures propagate — the
 * caller tells the user and stays retryable; no fabricated draft is
 * ever substituted.
 */
export async function generateVideoAdDraft(params, deps = {}) {
  const siteUrl = isPbaiToken(params) ? (deps.siteUrl ?? await getSiteUrl()) : null;
  const craftNote = deps.craftNote !== undefined ? deps.craftNote : await videoAdCraftNote();
  const briefParts = [String(params.brief ?? '').trim()];
  if (params.photoDescription) briefParts.push(`Product photo shows: ${String(params.photoDescription).trim()}`);
  if (craftNote) briefParts.push(`Ad-craft guidance: ${String(craftNote).trim()}`);
  const { script, storyboard } = await generateStudioScript(
    { ...params, brief: briefParts.filter(Boolean).join('\n\n').slice(0, 1000) },
    deps,
  );
  const hook = videoAdHookFromScript(script);
  const plan = videoAdPlanFromStoryboard(storyboard);
  const bank = deps.hashtagBank ?? (await videoAdHashtagBank());
  const isPbai = isPbaiToken(params);
  // F17: the token step is authoritative, but a $SYM in the brief is the
  // seller naming their project when the token step gave no symbol
  // (Rowdy's $USA repro) — it becomes the tag source, never the PB bank.
  const effectiveSymbol = String(params.tokenSymbol ?? '').trim()
    || briefTokenSymbol(params.brief, bank);
  const hashtags = pickVideoAdHashtags({ tokenSymbol: effectiveSymbol, isPbai, bank });
  const caption = buildVideoAdCaption({
    hook,
    productName: params.tokenName,
    siteHost: siteUrl ? siteHostOf(siteUrl) : '',
    hashtags,
    sourceUrl: params.sourceUrl || '',
  });
  return { script, storyboard, hook, plan, caption, hashtags };
}

/** Per-job video-ad meta (approved caption etc.) for the completion DM
 *  and the X-queue button. Null when absent or unparseable. */
export async function readVideoAdMeta(jobId) {
  try {
    const raw = await getConfig(videoAdMetaKey(jobId), null);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? m : null;
  } catch { return null; }
}

async function saveVideoAdMeta(jobId, meta) {
  await setConfig(videoAdMetaKey(jobId), JSON.stringify(meta)).catch(() => {});
}

// ── Credit ledger (reserve / settle / refund — repurpose pattern) ────────
// refIds: studio:<jobId>:reserve | :settle | :refund. Reserve writes ONE
// row: amount −purchasedPart kind 'studio_reserve' — or, for a free trial,
// a 0-amount marker kind 'studio_trial' on the same reserve refId (the
// marker's presence is what makes a second trial impossible). Settle is a
// 0-amount marker; refund is +purchasedPart exactly once. Every step checks
// its refId first, so replays and retries converge and never re-reserve.

const userKeyFor = (tgId) => 'telegram:' + String(tgId);
const reserveRef = (jobId) => `studio:${jobId}:reserve`;
const settleRef = (jobId) => `studio:${jobId}:settle`;
const refundRef = (jobId) => `studio:${jobId}:refund`;

async function ledgerRowByRef(refId) {
  try {
    return await db.select().from(credit_ledger).where(eq(credit_ledger.refId, refId)).get();
  } catch { return null; }
}

export async function studioWalletBalance(tgId) {
  const row = await db.get(sql`SELECT COALESCE(SUM(amount), 0) AS bal FROM credit_ledger WHERE user_key = ${userKeyFor(tgId)}`);
  return Number(row?.bal ?? 0) || 0;
}

async function writeReserve(job) {
  const refId = reserveRef(job.id);
  if (await ledgerRowByRef(refId)) return { replay: true };
  const isTrial = job.fundsSource === 'free_trial';
  await db.insert(credit_ledger).values({
    userKey: userKeyFor(job.telegramUserId),
    amount: isTrial ? 0 : -(Number(job.purchasedPart) || 0),
    kind: isTrial ? 'studio_trial' : 'studio_reserve',
    purpose: 'studio_video',
    refId,
  }).run();
  return { replay: false };
}

/** Settle on complete: marker only (the reservation stands as the charge). */
export async function settleStudioJob(jobId) {
  const job = await getStudioJob(jobId);
  if (!job?.telegramUserId) return { skipped: 'unknown_job' };
  if (await ledgerRowByRef(settleRef(jobId))) return { replay: true };
  if (await ledgerRowByRef(refundRef(jobId))) return { skipped: 'already_refunded' };
  if (!(await ledgerRowByRef(reserveRef(jobId)))) return { skipped: 'never_reserved' };
  await db.insert(credit_ledger).values({
    userKey: userKeyFor(job.telegramUserId),
    amount: 0,
    kind: 'studio_settle',
    purpose: 'studio_video',
    refId: settleRef(jobId),
  }).run();
  return { settled: true };
}

/** Refund on failed/cancelled: +purchasedPart back, exactly once. */
export async function refundStudioJob(jobId) {
  const job = await getStudioJob(jobId);
  if (!job?.telegramUserId) return { skipped: 'unknown_job' };
  if (await ledgerRowByRef(refundRef(jobId))) return { replay: true };
  if (!(await ledgerRowByRef(reserveRef(jobId)))) return { skipped: 'never_reserved' };
  if (await ledgerRowByRef(settleRef(jobId))) return { skipped: 'already_settled' };
  // PRICING WAVE: a failed/cancelled week-trial job restores its trial
  // credits (purchasedPart is 0 for week_trial, so the ledger marker
  // below is +0 — the restore is the real refund).
  if (job.fundsSource === 'week_trial') {
    await restoreWeekTrialCredits(job.telegramUserId, Number(job.costCredits) || 0).catch(() => {});
  }
  await db.insert(credit_ledger).values({
    userKey: userKeyFor(job.telegramUserId),
    amount: Number(job.purchasedPart) || 0,
    kind: 'studio_refund',
    purpose: 'studio_video',
    refId: refundRef(jobId),
  }).run();
  return { refunded: Number(job.purchasedPart) || 0 };
}

// ── Entitlement (trial → included → purchased, mixed split allowed) ──────

/**
 * The active subscription term for a user. bot_users is the tier source;
 * web_subscriptions (the Phase 4 bridge's audit row) carries the grant
 * time — updatedAt is the term start and expiresAt the term end, which is
 * how the 30/90-day period is recovered without a period column. With no
 * web row, the term is assumed monthly: start = expiry − 30d.
 */
export async function getStudioEntitlement(tgId) {
  const id = String(tgId);
  let user = null, webSub = null;
  try { user = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, id)).get(); } catch { /* none */ }
  try { webSub = await db.select().from(web_subscriptions).where(eq(web_subscriptions.telegramUserId, id)).get(); } catch { /* none */ }
  const tier = canonicalTier(user?.tier ?? webSub?.tier ?? 'free');
  const tierPaid = tier !== 'free';
  let subAllowance = INCLUDED_ALLOWANCES[tier] ?? 0;
  // PRICING WAVE: the PB Plan's included allowance is config-only —
  // the number was never decided, so the table holds 0 for 'one' and
  // this key is the only source. Unset = 0 = no promise.
  if (tier === 'one') subAllowance = await includedAllowanceForOne().catch(() => 0);
  const subExpires = Math.max(toSec(user?.subscriptionExpiresAt), toSec(webSub?.expiresAt));
  // TIER-LINKAGE: a paid tier with NO expiry anywhere is an ongoing grant,
  // not a lapsed one. The site's own subscriptionActive treats null expiry
  // as active, a cancel overwrites the tier to 'free' (never paid+null),
  // and no bot path treats paid+null as lapsed (business getTierForTelegramUser
  // and delegationLendTier both pass null expiry through; the tick's lapse
  // mailer skips null-expiry rows). A dated expiry still governs: past = lapsed.
  const hasExpiry = subExpires > 0;
  const subActive = hasExpiry ? subExpires > nowSec() : tierPaid;
  let subStart = 0;
  if (subActive) {
    const webStart = toSec(webSub?.updatedAt);
    if (hasExpiry) {
      subStart = webStart && webStart < subExpires ? webStart : subExpires - 30 * 86400;
    } else {
      // Ongoing grant: the usage window starts at the last grant
      // application (web row only — bot_users.updatedAt moves on
      // non-grant writes too, so it must not shrink the window).
      subStart = webStart || 0;
    }
  }

  // OPS-24 (W4): claimed Studio-access grants (Ad Creator — written by
  // websync applyClaimGrant) are a real entitlement source, not a
  // write-only table. The original sold the access window as a video
  // count (AD_CREATOR_WEEKLY_VIDEO_AD_LIMIT 5 videos / 7 days;
  // AD_CREATOR_VIDEO_AD_LIMIT 30 / 30 days); at this build's pricing
  // (studioCost(15) = 25 credits per standard video) the window carries
  // 125 included credits weekly, 750 monthly. The window runs from the
  // claim; the newest claim wins (the writer upserts one row per user).
  let grant = null;
  try { grant = await db.select().from(studio_access_grants).where(eq(studio_access_grants.telegramUserId, id)).get(); } catch { /* none */ }
  const grantDays = Number(grant?.accessDays) || 0;
  const grantStart = grant ? toSec(grant.claimedAt) : 0;
  const grantEnd = grantStart && grantDays > 0 ? grantStart + grantDays * 86400 : 0;
  const grantActive = grantEnd > nowSec();
  const grantAllowance = grantActive ? (grantDays <= 7 ? 125 : 750) : 0;

  // Merge: the stronger allowance wins; the usage window follows the
  // winning source; the term end is the later of the two.
  const active = subActive || grantActive;
  let allowance = 0, termStart = 0;
  if (subActive && (!grantActive || subAllowance >= grantAllowance)) {
    allowance = subAllowance; termStart = subStart;
  } else if (grantActive) {
    allowance = grantAllowance; termStart = grantStart;
  }
  const expires = Math.max(subActive ? subExpires : 0, grantActive ? grantEnd : 0);

  let includedUsed = 0;
  if (active && allowance > 0) {
    const rows = await db.select().from(studio_jobs)
      .where(eq(studio_jobs.telegramUserId, id)).all().catch(() => []);
    for (const r of rows) {
      if (isPodcastStoryboardJson(r.storyboardJson)) continue; // Podcast pool is separate (lib/podcast.js)
      if (TERMINAL_STATES.slice(1).includes(r.status)) continue; // failed/cancelled don't consume
      if ((Number(r.createdAt) || 0) < termStart) continue;
      includedUsed += Number(r.includedPart) || 0;
    }
  }

  let trialAvailable = false;
  {
    const marker = await db.get(sql`SELECT COUNT(*) AS c FROM credit_ledger WHERE user_key = ${userKeyFor(id)} AND kind = 'studio_trial'`).catch(() => null);
    // Prior-job check counts Studio jobs only: a podcast-first member
    // keeps their Studio free trial (separate products, separate pools).
    const priorRows = await db.select().from(studio_jobs)
      .where(eq(studio_jobs.telegramUserId, id)).all().catch(() => []);
    const prior = priorRows.filter((r) => !isPodcastStoryboardJson(r.storyboardJson)).length;
    trialAvailable = Number(marker?.c ?? 0) === 0 && prior === 0;
  }

  const wallet = await studioWalletBalance(id);
  // TIER-LINKAGE: the owner bypasses the credit gate entirely. The check
  // lives here so every caller (video, podcast via base, Discord path,
  // Mini App endpoints) inherits it — never per call site.
  const owner = (await ownerIdSet().catch(() => new Set())).has(id);
  // PRICING WAVE: 7-day trial state for the spend sites (video via
  // previewFunds, podcast via base). Fail-closed: a read error means
  // no trial branch, never free credit.
  const weekTrial = await weekTrialStatus(id).catch(() => ({ active: false, remaining: 0, endsAt: 0, row: null }));
  return {
    tier,
    allowance: active ? allowance : 0,
    termStart: active ? termStart : 0,
    termEnd: active ? expires : 0,
    active,
    ownerUnlimited: owner,
    includedUsed,
    includedRemaining: active ? Math.max(0, allowance - includedUsed) : 0,
    wallet,
    trialAvailable,
    weekTrial,
    // OPS-24: the claimed access window, when one is live (else null) —
    // lets surfaces say "Studio access until <date>" truthfully.
    accessGrant: grantActive ? { days: grantDays, until: grantEnd, productId: grant?.productId ?? null } : null,
  };
}

/**
 * Split a cost across the entitlement order. Returns null when the user
 * cannot fund the job at all (clean refusal — no rows written anywhere).
 */
export function previewFunds(ent, cost, opts = {}) {
  // TIER-LINKAGE: owner jobs fund with zero parts — no trial consumed, no
  // included consumed, no wallet touched. writeReserve then writes a
  // 0-amount 'studio_reserve' row (never a 'studio_trial' marker, since
  // fundsSource is 'owner'), settle is a 0 marker, refund is +0.
  if (ent.ownerUnlimited) {
    return { fundsSource: 'owner', includedPart: 0, purchasedPart: 0 };
  }
  // PRICING WAVE: the 7-day trial draws FIRST, before the lifetime
  // trial — so a trial user keeps their lifetime video for later.
  // Standard only (premium callers pass noTrial and skip this branch),
  // full-cost only (a cost above the remaining balance falls through
  // to included/wallet — trial credits are never partially drawn).
  // The draw itself is committed by the create path, not here: this
  // function is pure, and writeReserve only writes the 0 marker.
  if (ent.weekTrial?.active && !opts.noTrial && cost <= ent.weekTrial.remaining) {
    return { fundsSource: 'week_trial', includedPart: 0, purchasedPart: 0 };
  }
  // opts.noTrial (Batch 4 premium): a premium job burns real provider
  // dollars, so it must never ride the free trial — the split is computed
  // as if the trial were already used. Non-premium callers never pass it.
  // TRIALFIX: while the 7-day trial is active, the lifetime trial is
  // preserved — a cost above the week-trial balance falls through to
  // included/wallet, never into the lifetime trial (the week-trial
  // branch above already returned when it covers the cost in full).
  if (ent.trialAvailable && !opts.noTrial && !ent.weekTrial?.active) {
    return { fundsSource: 'free_trial', includedPart: 0, purchasedPart: 0 };
  }
  const includedPart = Math.min(ent.includedRemaining, cost);
  const purchasedPart = cost - includedPart;
  if (purchasedPart > ent.wallet) return null;
  const fundsSource = purchasedPart === 0 ? 'included' : includedPart === 0 ? 'purchased' : 'mixed';
  return { fundsSource, includedPart, purchasedPart };
}

// ── Mirror rows ───────────────────────────────────────────────────────────

export async function getStudioJob(jobId) {
  try {
    return await db.select().from(studio_jobs).where(eq(studio_jobs.id, String(jobId))).get();
  } catch { return null; }
}

export async function listOwnStudioJobs(tgId, limit = 20) {
  try {
    const rows = await db.select().from(studio_jobs)
      .where(eq(studio_jobs.telegramUserId, String(tgId)))
      .orderBy(desc(studio_jobs.createdAt)).limit(limit * 3).all();
    // Podcast episodes are listed by /podcast, not as Studio ads.
    return rows.filter((r) => !isPodcastStoryboardJson(r.storyboardJson)).slice(0, limit);
  } catch { return []; }
}

/** Public (member-surface) shape of a mirror row — own data only. */
export function studioJobPublic(r) {
  if (!r) return null;
  const pub = {
    id: r.id,
    surface: r.surface,
    status: r.status,
    stage: r.stage ?? null,
    progress: Number(r.progress) || 0,
    vibe: r.vibe,
    durationSec: Number(r.durationSec) || 15,
    tokenName: r.tokenName ?? null,
    tokenSymbol: r.tokenSymbol ?? null,
    tokenAddress: r.tokenAddress ?? null,
    mascot: Boolean(r.mascot),
    scriptText: r.scriptText ?? null,
    storyboard: r.storyboardJson ? safeParse(r.storyboardJson) : null,
    costCredits: Number(r.costCredits) || 0,
    fundsSource: r.fundsSource ?? null,
    includedPart: Number(r.includedPart) || 0,
    purchasedPart: Number(r.purchasedPart) || 0,
    failureReason: r.failureReason ?? null,
    deliveryState: r.deliveryState ?? 'none',
    createdAt: Number(r.createdAt) || 0,
    updatedAt: Number(r.updatedAt) || 0,
  };
  // Premium spec surfaces only on jobs that carry one (Batch 4) — standard
  // jobs keep the exact pre-Batch-4 public shape.
  const sbPremium = pub.storyboard?.premium;
  if (sbPremium) pub.premium = sbPremium;
  return pub;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function isPbaiToken(params) {
  const sym = String(params.tokenSymbol ?? '').replace(/^\$/, '').toUpperCase();
  const addr = String(params.tokenAddress ?? '').toLowerCase();
  return sym === 'PBAI' || addr === PBAI_CA;
}

function normalizeParams(params = {}) {
  const vibe = STUDIO_VIBES.includes(params.vibe) ? params.vibe : 'hype';
  // Video-ad cuts (5/10s) are valid ONLY for video-ad jobs (params.videoAd);
  // the classic wizard's durations are untouched by this branch.
  const rawDur = Number(params.durationSec ?? params.duration);
  const durationSec = (params.videoAd && VIDEO_AD_DURATIONS.includes(rawDur))
    ? rawDur
    : STUDIO_DURATIONS.includes(rawDur) ? rawDur : 15;
  return {
    vibe,
    durationSec,
    tokenName: String(params.tokenName ?? params.token_name ?? '').trim().slice(0, 80),
    tokenSymbol: String(params.tokenSymbol ?? params.token_symbol ?? '').trim().replace(/^\$/, '').slice(0, 20),
    tokenAddress: String(params.tokenAddress ?? params.token_address ?? '').trim().slice(0, 80) || null,
    tokenChain: String(params.tokenChain ?? params.token_chain ?? 'base').trim().slice(0, 20) || 'base',
    logoUrl: String(params.logoUrl ?? params.logo_url ?? '').trim().slice(0, 500) || null,
    brief: String(params.brief ?? '').trim().slice(0, 1000),
    // Claims boundary: the PB mascot performs ONLY in PoorBoyAI's own ads.
    mascot: params.mascot && isPbaiToken(params) ? 1 : 0,
  };
}

/**
 * Create a job + reserve. Keyed by job id: a replay with the same id
 * returns the existing row and NEVER re-reserves. Throws an
 * 'Insufficient…' Error when entitlement cannot fund the cost (the
 * caller turns that into a clean refusal; no rows are written first).
 */
export async function createStudioJob(tgId, params = {}, opts = {}) {
  const jobId = opts.jobId ? String(opts.jobId) : mintJobId();
  const existing = await getStudioJob(jobId);
  if (existing) return { job: studioJobPublic(existing), replay: true };

  const p = normalizeParams(params);
  if (!p.tokenName) throw new Error('Token name is required.');
  const script = String(opts.script ?? params.scriptText ?? '').trim();
  let storyboard = opts.storyboard ?? params.storyboard ?? null;
  if (!script) throw new Error('An approved script is required before a job can be created.');

  // Premium (Batch 4): honored ONLY when the premium flag is on — with the
  // flag off the params are ignored entirely and the job is a standard job
  // at the standard price with a standard storyboard. The normalized spec
  // rides inside storyboard_json (the worker reads it from the raw parse);
  // the price flows through the SAME reserve/settle/refund refIds, so a
  // failed premium render refunds the premium portion exactly with the rest.
  // Video-ad jobs never combine with premium in this wave: their price is
  // the config cost (opts.costOverride), never the schedule + premium.
  const premium = opts.videoAd ? null : (await isStudioPremiumEnabled())
    ? normalizePremium(params.premium ?? (params.premiumImagine || params.premiumVoice ? { imagine: params.premiumImagine, voice: params.premiumVoice ? 'xai' : null } : null), p.durationSec)
    : null;
  const pCost = premiumCost(premium);
  // Video-ad jobs price ONLY from the config parameter — a missing
  // override is a refusal, never a silent fall back to the schedule.
  if (opts.videoAd && opts.costOverride == null) {
    throw new Error('Video-ad pricing is not set yet — the per-render price has to be set first. Nothing was created or charged.');
  }
  const cost = (opts.videoAd && opts.costOverride != null)
    ? Number(opts.costOverride)
    : studioCost(p.durationSec) + pCost;
  const ent = await getStudioEntitlement(tgId);
  const split = previewFunds(ent, cost, pCost > 0 ? { noTrial: true } : {});
  if (!split) {
    throw new Error(
      `Insufficient Studio credits. This video costs ${cost} credits — included remaining ${ent.includedRemaining}, purchased balance ${ent.wallet}${ent.weekTrial?.active && pCost === 0 ? `, 7-day trial credits remaining ${ent.weekTrial.remaining}` : ''}${ent.trialAvailable ? (pCost > 0 ? ', free trial does not cover premium add-ons' : '') : ', free trial already used'}.`,
    );
  }
  // PRICING WAVE: commit the trial draw BEFORE the job row exists, so a
  // refused draw never strands an unpaid script_ready job. writeReserve
  // then writes only the 0 marker (purchasedPart is 0 for week_trial).
  // If the insert below fails transiently after this draw, the credits
  // leak (bounded: one job's cost) — the fail-closed direction; a
  // failed/cancelled job refunds them via refundStudioJob.
  if (split.fundsSource === 'week_trial') {
    const draw = await commitWeekTrialDraw(tgId, cost);
    if (!draw.ok) {
      throw new Error(
        `Insufficient 7-day trial credits. This video costs ${cost} credits — trial credits remaining ${draw.remaining}.`,
      );
    }
  }
  if (premium) {
    // The spec must reach the worker even when no storyboard was built.
    const sbObj = storyboard ?? buildStoryboard(script, p.vibe, p.durationSec, p);
    storyboard = { ...sbObj, premium };
  }

  const ts = nowSec();
  const row = {
    id: jobId,
    surface: opts.surface ?? 'telegram',
    telegramUserId: String(tgId),
    discordUserId: opts.discordUserId ?? null,
    discordInteractionId: opts.discordInteractionId ?? null,
    discordChannelId: opts.discordChannelId ?? null,
    status: 'script_ready',
    stage: null,
    progress: 0,
    vibe: p.vibe,
    durationSec: p.durationSec,
    tokenName: p.tokenName,
    tokenSymbol: p.tokenSymbol || null,
    tokenAddress: p.tokenAddress,
    tokenChain: p.tokenChain,
    logoUrl: p.logoUrl,
    mascot: p.mascot,
    brief: p.brief || null,
    scriptText: script.slice(0, 2000),
    storyboardJson: storyboard ? JSON.stringify(storyboard) : null,
    costCredits: cost,
    fundsSource: split.fundsSource,
    includedPart: split.includedPart,
    purchasedPart: split.purchasedPart,
    deliveryState: 'none',
    deliveryChatId: String(tgId),
    pushedAt: null,
    pushState: 'new',
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(studio_jobs).values(row).run();
  await writeReserve(row);
  return { job: studioJobPublic(row), replay: false, entitlement: ent };
}

/** Cancel an own job in a pre-pipeline state: mirror transition + refund.
 * Refund reuses the existing exactly-once rule (refundStudioJob: purchased
 * part back, refId-guarded) — no new credit promise is invented here. */
export async function cancelStudioJob(tgId, jobId) {
  const job = await getStudioJob(jobId);
  if (!job || String(job.telegramUserId) !== String(tgId)) {
    throw new Error('Job not found.');
  }
  if (job.status === 'rendering') {
    throw new Error('Job is already rendering — it can\'t be cancelled once rendering has started.');
  }
  if (!PRE_RENDER_STATES.includes(job.status)) {
    throw new Error(`Job is already ${job.status} — only pending/script-ready/voice-ready jobs can be cancelled.`);
  }
  await db.update(studio_jobs).set({
    status: 'cancelled', updatedAt: nowSec(),
    pushState: job.pushState === 'pushed' ? 'dirty' : job.pushState,
  }).where(eq(studio_jobs.id, job.id)).run();
  await refundStudioJob(job.id);
  return { job: studioJobPublic(await getStudioJob(job.id)) };
}

// ── Job status rendering (shared by wizard + callbacks) ──────────────────

const STATUS_EMOJI = {
  pending: '⏳', script_ready: '📝', voice_ready: '🎙️', rendering: '🎬',
  complete: '✅', failed: '❌', cancelled: '🚫',
};

export function renderJobLine(job) {
  const j = job?.id ? job : studioJobPublic(job);
  const token = j.tokenSymbol ? `$${j.tokenSymbol}` : (j.tokenName ?? 'video');
  const stage = j.status === 'rendering' && j.stage ? ` · ${j.stage} ${j.progress ?? 0}%` : '';
  return `${STATUS_EMOJI[j.status] ?? '•'} ${token} — ${j.status}${stage} · ${j.costCredits} cr (${j.fundsSource ?? '—'})`;
}

export function renderJobStatus(job) {
  const j = job?.costCredits !== undefined ? job : studioJobPublic(job);
  const lines = [
    `🎬 Studio job ${j.id}`,
    `Token: ${esc(j.tokenName ?? '')}${j.tokenSymbol ? ` ($${esc(j.tokenSymbol)})` : ''}`,
    `Status: ${STATUS_EMOJI[j.status] ?? ''} ${j.status}${j.stage ? ` · stage ${j.stage}` : ''}${j.status === 'rendering' ? ` · ${j.progress}%` : ''}`,
    `Cost: ${j.costCredits} credits · funds: ${j.fundsSource ?? '—'}`,
  ];
  if (j.status === 'complete') {
    lines.push(j.deliveryState === 'sent' || j.deliveryState === 'claimed'
      ? '📩 Delivered — check your messages for the MP4.'
      : '📦 Rendered and ready — delivery is pending; PB will send the MP4 here.');
  }
  if (j.status === 'failed') lines.push(`Reason: ${esc(j.failureReason ?? 'render failed')}\nYour reservation was refunded in full.`);
  if (j.status === 'cancelled') lines.push('Cancelled — your reservation was refunded in full.');
  return lines.join('\n');
}

// ── Tick sync: push PB transitions / pull Worker deltas ──────────────────
// deps.poster(path, body) / deps.getter(path, queryObj) are websync's
// HMAC-signed clients (injected, like repurpose — no circular import).
// deps.ask is injectable for tests.

// Podcast Studio (revival, 2026-10-20) shares this queue: podcast rows
// carry storyboard_json.kind === 'podcast'. Studio-side accounting must
// never count them (podcast has its own pool in lib/podcast.js), and
// their terminal transitions (settle/refund + DMs) belong to the
// podcast ledger kinds — lib/podcast.js registers a terminal hook for
// them. The import stays one-way (podcast.js → studio.js): the registry
// lives here, the hook registers itself when podcast.js is loaded.
export function isPodcastStoryboardJson(s) {
  if (!s) return false;
  try { const sb = typeof s === 'string' ? JSON.parse(s) : s; return Boolean(sb && sb.kind === 'podcast'); } catch { return false; }
}
const studioTerminalHooks = new Set();
export function registerStudioTerminalHook(fn) {
  if (typeof fn === 'function') studioTerminalHooks.add(fn);
}

function mirrorToWire(r) {
  return {
    id: r.id,
    surface: r.surface,
    telegram_user_id: r.telegramUserId ?? null,
    discord_user_id: r.discordUserId ?? null,
    discord_interaction_id: r.discordInteractionId ?? null,
    discord_channel_id: r.discordChannelId ?? null,
    status: r.status,
    stage: r.stage ?? null,
    progress: Number(r.progress) || 0,
    vibe: r.vibe,
    duration_sec: Number(r.durationSec) || 15,
    token_name: r.tokenName ?? null,
    token_symbol: r.tokenSymbol ?? null,
    token_address: r.tokenAddress ?? null,
    token_chain: r.tokenChain ?? null,
    logo_url: r.logoUrl ?? null,
    mascot: Number(r.mascot) || 0,
    script_text: r.scriptText ?? null,
    storyboard_json: r.storyboardJson ?? null,
    cost_credits: Number(r.costCredits) || 0,
    funds_source: r.fundsSource ?? null,
    attempt_id: r.attemptId ?? null,
    render_started_at: r.renderStartedAt ?? null,
    heartbeat_at: r.heartbeatAt ?? null,
    failure_reason: r.failureReason ?? null,
    delivery_state: r.deliveryState ?? 'none',
    delivery_chat_id: r.deliveryChatId ?? null,
    delivery_message_id: r.deliveryMessageId ?? null,
    output_size: r.outputSize ?? null,
    output_duration: r.outputDuration ?? null,
    output_hash: r.outputHash ?? null,
    output_name: r.outputName ?? null,
    created_at: Number(r.createdAt) || 0,
    updated_at: Number(r.updatedAt) || 0,
  };
}

export async function pushStudioJobs(secret, deps = {}) {
  const poster = deps.poster;
  if (typeof poster !== 'function') throw new Error('studio: poster dep required');
  const rows = await db.select().from(studio_jobs).all().catch(() => []);
  const pushable = rows.filter((r) => ['new', 'dirty'].includes(r.pushState)
    && ['script_ready', 'cancelled', 'failed'].includes(r.status));
  if (!pushable.length) return { pushed: 0 };
  const res = await poster('/api/internal/studio/push', { jobs: pushable.map(mirrorToWire) });
  if (res && res.error) throw new Error('studio push failed: ' + res.error);
  for (const r of pushable) {
    await db.update(studio_jobs).set({ pushState: 'pushed', pushedAt: nowSec() })
      .where(eq(studio_jobs.id, r.id)).run().catch(() => {});
  }
  return { pushed: pushable.length };
}

export async function recordFailureForOwnerAlert(job) {
  // Original semantics: 2 failures inside 10 minutes → one owner DM.
  try {
    const now = Date.now();
    let state = safeParse(await getConfig('studio_fail_window', 'null')) ?? { start: now, count: 0, alerted: false };
    if (!state.start || now - state.start > 10 * 60_000) state = { start: now, count: 0, alerted: false };
    state.count += 1;
    await setConfig('studio_fail_window', JSON.stringify(state));
    if (state.count >= 2 && !state.alerted) {
      state.alerted = true;
      await setConfig('studio_fail_window', JSON.stringify(state));
      const text = `⚠️ Studio render failures: ${state.count} in the last 10 minutes.\nLatest: ${job.id} (${job.tokenSymbol ? '$' + job.tokenSymbol : job.tokenName ?? 'video'}) — ${String(job.failureReason ?? 'unknown').slice(0, 200)}\nReservations were refunded automatically.`;
      for (const ownerId of await ownerIdSet()) {
        try { await api.sendMessage({ chat_id: ownerId, text }); } catch { /* best effort */ }
      }
      return { alerted: true };
    }
  } catch { /* alerting never breaks the sync */ }
  return { alerted: false };
}

async function dmUser(tgId, text, extra = {}) {
  if (!tgId) return;
  try { await api.sendMessage({ chat_id: tgId, text, ...extra }); } catch { /* DM closed — mirror state still converges */ }
}

/** file_id writer wave: a pulled delivery_file_id becomes the bot config
 * key the X video resolver reads (must match repurpose.js
 * studioVideoFileKey — inlined here to avoid a circular import, since
 * repurpose.js imports from this module). Set-only: a pull without the
 * field never clears an existing key, and a config failure never breaks
 * the sync. */
async function captureStudioVideoFileId(jobId, wire) {
  const fileId = wire?.delivery_file_id;
  if (typeof fileId !== 'string' || !fileId) return;
  try { await setConfig(`studio_video_file:${String(jobId)}`, fileId); } catch { /* config write never breaks the sync */ }
}

/** Video-automatic rule (2026-11-06, Rowdy's order: video ads post to X on
 *  their own, no tap): a completed PB-own video ad queues itself the moment
 *  it completes. Fires only when ALL hold: mascot (PB-own), owner, approved
 *  caption, delivered file on record. Pure decision (no I/O) so the harness
 *  can prove each guard. */
export function shouldAutoQueueVideoAd(job, adMeta, fileId, isOwner) {
  if (!job || !job.mascot) return { queue: false, reason: 'not_mascot' };
  if (!isOwner) return { queue: false, reason: 'not_owner' };
  const caption = String(adMeta?.caption ?? '').trim();
  if (!caption) return { queue: false, reason: 'no_caption' };
  if (!fileId) return { queue: false, reason: 'no_file' };
  return { queue: true, caption };
}

/** Apply ONE pulled Worker row to the mirror. Returns an outcome tag. */
export async function applyStudioDelta(wire, deps = {}) {
  const id = String(wire?.id ?? '');
  if (!id) return { skipped: 'no_id' };
  const existing = await getStudioJob(id);
  const w = {
    surface: wire.surface ?? existing?.surface ?? 'telegram',
    telegramUserId: wire.telegram_user_id != null ? String(wire.telegram_user_id) : existing?.telegramUserId ?? null,
    discordUserId: wire.discord_user_id ?? existing?.discordUserId ?? null,
    discordInteractionId: wire.discord_interaction_id ?? existing?.discordInteractionId ?? null,
    discordChannelId: wire.discord_channel_id ?? existing?.discordChannelId ?? null,
    status: wire.status ?? existing?.status ?? 'pending',
    stage: wire.stage ?? existing?.stage ?? null,
    progress: Number(wire.progress ?? existing?.progress ?? 0) || 0,
    vibe: wire.vibe ?? existing?.vibe ?? 'hype',
    durationSec: Number(wire.duration_sec ?? existing?.durationSec ?? 15) || 15,
    tokenName: wire.token_name ?? existing?.tokenName ?? null,
    tokenSymbol: wire.token_symbol ?? existing?.tokenSymbol ?? null,
    tokenAddress: wire.token_address ?? existing?.tokenAddress ?? null,
    tokenChain: wire.token_chain ?? existing?.tokenChain ?? null,
    logoUrl: wire.logo_url ?? existing?.logoUrl ?? null,
    mascot: Number(wire.mascot ?? existing?.mascot ?? 0) || 0,
    scriptText: wire.script_text ?? existing?.scriptText ?? null,
    storyboardJson: wire.storyboard_json ?? existing?.storyboardJson ?? null,
    costCredits: Number(wire.cost_credits ?? existing?.costCredits ?? 0) || 0,
    fundsSource: wire.funds_source ?? existing?.fundsSource ?? null,
    attemptId: wire.attempt_id ?? existing?.attemptId ?? null,
    renderStartedAt: wire.render_started_at ?? existing?.renderStartedAt ?? null,
    heartbeatAt: wire.heartbeat_at ?? existing?.heartbeatAt ?? null,
    failureReason: wire.failure_reason ?? existing?.failureReason ?? null,
    deliveryState: wire.delivery_state ?? existing?.deliveryState ?? 'none',
    deliveryChatId: wire.delivery_chat_id ?? existing?.deliveryChatId ?? null,
    deliveryMessageId: wire.delivery_message_id ?? existing?.deliveryMessageId ?? null,
    outputSize: wire.output_size ?? existing?.outputSize ?? null,
    outputDuration: wire.output_duration != null ? Math.round(Number(wire.output_duration)) : existing?.outputDuration ?? null,
    outputHash: wire.output_hash ?? existing?.outputHash ?? null,
    outputName: wire.output_name ?? existing?.outputName ?? null,
    updatedAt: Number(wire.updated_at) || nowSec(),
  };

  if (!existing) {
    // New row from the Worker — in v1 that means a Discord-created job:
    // PB generates the script, reserves, and the NEXT push transitions it
    // to script_ready (or failed/insufficient_credits).
    const ts = nowSec();
    await db.insert(studio_jobs).values({
      ...w,
      id,
      brief: null,
      includedPart: 0,
      purchasedPart: 0,
      pushState: 'pushed', // the row came FROM the queue; nothing to push yet
      pushedAt: ts,
      createdAt: Number(wire.created_at) || ts,
    }).run();
    await captureStudioVideoFileId(id, wire);
    const fresh = await getStudioJob(id);
    if (fresh.status === 'pending' && fresh.telegramUserId) {
      let generated = null;
      try {
        const params = {
          tokenName: fresh.tokenName ?? 'this token',
          tokenSymbol: fresh.tokenSymbol ?? '',
          tokenAddress: fresh.tokenAddress,
          vibe: fresh.vibe,
          durationSec: fresh.durationSec,
          brief: `Promote ${fresh.tokenName ?? 'this token'}${fresh.tokenSymbol ? ` ($${fresh.tokenSymbol})` : ''} for the community.`,
        };
        generated = await generateStudioScript(params, { ask: deps.ask });
        const { script, storyboard } = generated;
        const cost = studioCost(fresh.durationSec);
        const ent = await getStudioEntitlement(fresh.telegramUserId);
        const split = previewFunds(ent, cost);
        if (!split) throw new Error('insufficient_credits');
        await db.update(studio_jobs).set({
          scriptText: script,
          storyboardJson: JSON.stringify(storyboard),
          costCredits: cost,
          fundsSource: split.fundsSource,
          includedPart: split.includedPart,
          purchasedPart: split.purchasedPart,
          status: 'script_ready',
          pushState: 'dirty',
          updatedAt: nowSec(),
        }).where(eq(studio_jobs.id, id)).run();
        await writeReserve(await getStudioJob(id));
        return { created: true, scriptReady: true };
      } catch (err) {
        const insufficient = /insufficient/i.test(String(err?.message ?? ''));
        await db.update(studio_jobs).set({
          status: 'failed',
          failureReason: insufficient ? 'insufficient_credits' : String(err?.message ?? 'script generation failed').slice(0, 300),
          // Keep a generated script on the failed row: the Worker's claim
          // can reclaim failed-with-script jobs after a top-up.
          ...(generated ? { scriptText: generated.script, storyboardJson: JSON.stringify(generated.storyboard) } : {}),
          pushState: 'dirty',
          updatedAt: nowSec(),
        }).where(eq(studio_jobs.id, id)).run();
        if (insufficient) {
          await dmUser(fresh.telegramUserId, '🎬 Your Discord Studio job could not start: insufficient Studio credits. Top up or upgrade, then run /video-ad again.');
        }
        return { created: true, failed: true, reason: insufficient ? 'insufficient_credits' : 'script_failed' };
      }
    }
    return { created: true };
  }

  // GUARD (Studio cancel wave): a row the USER already cancelled is terminal
  // by user action. Late worker reports must never resurrect it — the one
  // live path is the cancel-then-claim race (bot cancels script_ready, the
  // worker claims the still-script_ready bridge row before the cancel push
  // lands, then renders + delivers + completes). Without this guard the
  // pulled 'complete' would flip the row to complete with no settle and no
  // DM, after the user was already refunded. With it the row stays
  // 'cancelled', the refund stays exactly-once, and no second DM fires.
  // (Worker-reported cancels for non-cancelled rows flow through the
  // becameTerminal path below untouched — this guard only fires when the
  // mirror is ALREADY cancelled.)
  if (existing.status === 'cancelled') {
    return { updated: true, kept_cancelled: true };
  }
  const prevStatus = existing.status;
  const becameTerminal = TERMINAL_STATES.includes(w.status) && !TERMINAL_STATES.includes(prevStatus);
  // Worker-owned fields update; PB-owned credit fields (split, script on
  // PB jobs) are preserved — w carries existing values for those already.
  await db.update(studio_jobs).set({
    ...w,
    brief: existing.brief,
    includedPart: existing.includedPart,
    purchasedPart: existing.purchasedPart,
    costCredits: existing.costCredits || w.costCredits,
    fundsSource: existing.fundsSource ?? w.fundsSource,
    pushState: existing.pushState,
    pushedAt: existing.pushedAt,
    createdAt: existing.createdAt,
  }).where(eq(studio_jobs.id, id)).run();
  await captureStudioVideoFileId(id, wire);

  if (becameTerminal) {
    const job = await getStudioJob(id);
    // Registered terminal hooks (Podcast Studio) get first claim on
    // their own rows: their ledger kinds and DM copy are not Studio's.
    let hooked = false;
    for (const hook of studioTerminalHooks) {
      try { if (await hook(job, w.status)) { hooked = true; break; } } catch { /* a hook never breaks the sync */ }
    }
    if (hooked) return { updated: true, terminal: w.status, hooked: true };
    if (w.status === 'complete') {
      await settleStudioJob(id).catch(() => {});
      // Video-ad completion: a PB-own ad (mascot) carries its approved
      // caption, and the OWNER gets the X-queue button — customer ads
      // (mascot 0) keep the plain delivery DM, never an X offer.
      const adMeta = await readVideoAdMeta(id);
      const isOwner = (await ownerIdSet().catch(() => new Set())).has(String(job.telegramUserId ?? ''));
      if (adMeta && job.mascot) {
        const caption = String(adMeta.caption ?? '').trim();
        // Video-automatic (2026-11-06): a PB-own ad with an approved
        // caption AND a delivered file on record queues itself to X the
        // moment it completes — no tap. The tick still applies budget,
        // pacing, and kill switch at send time. The button below stays
        // ONLY as the fallback when the file is not on record yet (the
        // file can land after completion; tapping it then still works).
        let autoQueued = null;
        const fileId = await getConfig(studioVideoFileKey(id), null).catch(() => null);
        const decision = shouldAutoQueueVideoAd(job, adMeta, fileId, isOwner);
        if (decision.queue) {
          const q = await xQueueAddVideo(decision.caption, id, job.telegramUserId).catch(() => null);
          if (q?.ok) autoQueued = q;
        }
        await dmUser(job.telegramUserId,
          `🎬 Your Studio video is ready${job.deliveryState === 'sent' || job.deliveryState === 'claimed'
            ? ' — it has been delivered here in your DMs. Enjoy!'
            : '! Delivery is pending, so PB will send the MP4 here shortly — no action needed.'}`
          + (caption ? `\n\n💬 Approved caption:\n${caption}` : '')
          + (autoQueued ? `\n\n📣 Queued to X automatically (position ${autoQueued.position}) — no tap needed.` : ''),
          isOwner && !autoQueued ? { reply_markup: { inline_keyboard: [[{ text: '📣 Queue this video to X', callback_data: `studio:xqueue:${id}` }]] } } : {});
      } else {
        await dmUser(job.telegramUserId,
          job.deliveryState === 'sent' || job.deliveryState === 'claimed'
            ? '🎬 Your Studio video is ready — it has been delivered here in your DMs. Enjoy!'
            : '🎬 Your Studio video is ready! Delivery is pending, so PB will send the MP4 here shortly — no action needed.');
      }
    } else {
      // failed | cancelled from the Worker side
      await refundStudioJob(id).catch(() => {});
      if (w.status === 'failed') {
        await recordFailureForOwnerAlert(job);
        await dmUser(job.telegramUserId,
          `❌ Your Studio video failed: ${String(job.failureReason ?? 'render failed').slice(0, 300)}\nYour reservation (${job.costCredits} credits) was refunded in full. You can run /create to try again.`);
      } else {
        await dmUser(job.telegramUserId, '🚫 Your Studio job was cancelled — your reservation was refunded in full.');
      }
    }
    return { updated: true, terminal: w.status };
  }
  return { updated: true };
}

export async function pullStudioDeltas(secret, deps = {}) {
  const getter = deps.getter;
  if (typeof getter !== 'function') throw new Error('studio: getter dep required');
  const cursor = Number(await getConfig('studio_pull_cursor', '0')) || 0;
  const data = await getter('/api/internal/studio/pull', { cursor });
  if (data && data.error) throw new Error('studio pull failed: ' + data.error);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  let applied = 0;
  for (const wire of jobs) {
    await applyStudioDelta(wire, deps);
    applied++;
  }
  const nextCursor = Number(data?.cursor ?? cursor);
  if (Number.isFinite(nextCursor) && nextCursor > cursor) {
    await setConfig('studio_pull_cursor', String(nextCursor)).catch(() => {});
  }
  return { pulled: jobs.length, applied, cursor: Number.isFinite(nextCursor) ? nextCursor : cursor };
}

/** One full Studio sync pass for the tick: push first, then pull. */
export async function runStudioSync(secret, deps = {}) {
  let push, pull;
  try { push = await pushStudioJobs(secret, deps); } catch (err) { push = { error: err?.message ?? 'unknown' }; }
  try { pull = await pullStudioDeltas(secret, deps); } catch (err) { pull = { error: err?.message ?? 'unknown' }; }
  return { push, pull };
}

/** Signed Worker jobs read (Mini App fallback when the mirror is empty). */
export async function fetchWorkerStudioJobs(tgId, getter) {
  const data = await getter('/api/internal/studio/jobs', { telegramUserId: Number(tgId) });
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((wire) => studioJobPublic({
    id: wire.id, surface: wire.surface, status: wire.status, stage: wire.stage,
    progress: wire.progress, vibe: wire.vibe, durationSec: wire.duration_sec,
    tokenName: wire.token_name, tokenSymbol: wire.token_symbol, tokenAddress: wire.token_address,
    mascot: wire.mascot, scriptText: wire.script_text, storyboardJson: wire.storyboard_json,
    costCredits: wire.cost_credits, fundsSource: wire.funds_source,
    includedPart: 0, purchasedPart: 0, failureReason: wire.failure_reason,
    deliveryState: wire.delivery_state, createdAt: wire.created_at, updatedAt: wire.updated_at,
  }));
}

// ── /create wizard (config-state pattern, like contests/business) ────────
// State: config `studiowiz:<uid>` JSON. DM-only. Stages:
//   brief → pick (vibe/duration buttons) → token (text or $PBAI quick-pick)
//   → draft (script + approve/regenerate) → done.
// Drafts for the Mini App live under `studiodraft:<uid>` (endpoints).

const WIZ_TTL_MS = 30 * 60 * 1000;
const wizKey = (uid) => `studiowiz:${uid}`;

/** User-facing error line for brain/provider failures — never embed the
 *  raw provider error (it leaks JSON internals into chat). */
function humanBrainErr(err) {
  const m = String(err?.message ?? '');
  if (/429|quota|rate.?limit/i.test(m)) return 'the AI is rate-limited right now — give it a few minutes';
  if (/timeout|timed out/i.test(m)) return 'the AI took too long to answer';
  return 'the AI hit a snag';
}
export const studioDraftKey = (uid) => `studiodraft:${uid}`;

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

async function sendDm(uid, text, extra = {}) {
  // Menu-buttons fix (2026-11-05): reports delivery (true = reached the
  // DM, false = refused, usually 403 bot-blocked) so a group note never
  // claims a DM that never arrived. Every other caller ignores the
  // return, so this changes no existing path.
  try { await api.sendMessage({ chat_id: uid, text: String(text).slice(0, 4000), ...extra }); return true; }
  catch { /* DM closed */ return false; }
}
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

function pickPanel(draft) {
  // Video-ad drafts offer the short cuts (5/10/15s); the classic wizard
  // keeps its 15/20/30/45/60s row exactly (F16: 20s added 2026-11-06).
  const durations = draft.adSource ? VIDEO_AD_DURATIONS : STUDIO_DURATIONS;
  const costLabel = draft.adSource
    ? (draft.cost != null ? `${draft.cost} credits` : 'pricing not set yet')
    : `${studioCostWithPremium(draft.durationSec, draft.premium)} credits`;
  const rows = [
    STUDIO_VIBES.map((v) => ({ text: `${draft.vibe === v ? '✅ ' : ''}${v}`, callback_data: `studio:vibe:${v}` })),
    durations.map((d) => ({ text: `${draft.durationSec === d ? '✅ ' : ''}${d}s`, callback_data: `studio:dur:${d}` })),
  ];
  // Premium toggles render ONLY when the wizard was opened with the
  // premium flag on (draft.premiumEnabled) — flag off, this panel is
  // byte-identical to the pre-Batch-4 panel.
  if (draft.premiumEnabled) {
    const imagineCr = premiumCost({ imagineSeconds: premiumImagineSeconds(draft.durationSec) });
    rows.push([{ text: `${draft.premium?.imagineSeconds ? '✅ ' : '✨ '}Imagine AI background (+${imagineCr} cr)`, callback_data: 'studio:prem:imagine' }]);
    rows.push([{ text: `${draft.premium?.voice === 'xai' ? '✅ ' : '🎙️ '}Premium voice — PB premium voice (+${PREMIUM_VOICE_CREDITS} cr)`, callback_data: 'studio:prem:voice' }]);
  }
  rows.push([{ text: '➡️ Next: token', callback_data: 'studio:tokenstep' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'studio:cancel' }]);
  return {
    text: `🎬 <b>Studio — pick the vibe &amp; length</b>\n\nBrief: ${esc(draft.brief)}\nVibe: <b>${draft.vibe}</b> · Length: <b>${draft.durationSec}s</b> (${costLabel})${draft.adSource ? `\nSource: ${draft.adSource === 'photo' ? '📸 your photo' : '🔗 product link'}` : ''}`,
    reply_markup: { inline_keyboard: rows },
  };
}

function draftPanel(draft) {
  const sb = draft.storyboard;
  const shots = sb?.shots?.length ?? 0;
  const preview = draft.fundsPreview;
  const fundsLine = draft.adSource && draft.cost == null
    ? 'Cost: ⏳ pricing not set yet — approve is paused until the per-render price is set. Your draft is saved; nothing was charged.'
    : preview
      ? (preview.fundsSource === 'free_trial'
        ? 'Funds: 🎁 free trial (0 credits)'
        : preview.fundsSource === 'week_trial'
          ? 'Funds: 🎁 7-day trial (0 credits)'
          : preview.fundsSource === 'owner'
          ? 'Funds: 👑 owner — unlimited'
          : `Funds: ${preview.fundsSource} — ${preview.includedPart} included + ${preview.purchasedPart} purchased`)
      : 'Funds: ⚠️ not enough credits for this one — approve will confirm';
  const premiumLine = draft.premium
    ? `\n✨ Premium: ${[draft.premium.imagineSeconds ? 'Imagine AI background' : null, draft.premium.voice === 'xai' ? 'PB premium voice' : null].filter(Boolean).join(' · ')} (+${premiumCost(draft.premium)} cr over the ${studioCost(draft.durationSec)} cr base)`
    : '';
  // Video-ad drafts show the full ad package: hook, shot plan, caption,
  // hashtags, and the source — the seller approves the whole ad, not
  // just the script.
  const adBlock = draft.adSource
    ? `\n\n🪝 Hook: <i>${esc(draft.hook ?? '')}</i>\n📋 Plan:\n${esc(draft.plan ?? '').split('\n').slice(0, 6).join('\n')}\n💬 Caption:\n${esc(draft.caption ?? '')}\n#️⃣ ${(draft.hashtags ?? []).map((t) => `#${esc(String(t).replace(/^#/, ''))}`).join(' ') || '—'}\n📎 Source: ${draft.adSource === 'photo' ? '📸 your photo' : `🔗 ${esc(draft.sourceUrl ?? '')}`}${draft.photoNote ? `\n⚠️ Photo note: ${esc(draft.photoNote)}` : ''}`
    : '';
  const costLabel = draft.adSource ? (draft.cost != null ? `${draft.cost} credits` : 'pricing TBD') : `${draft.cost} credits`;
  return {
    text: `🎬 <b>Studio — review your script</b>\n\nToken: <b>${esc(draft.tokenName)}</b>${draft.tokenSymbol ? ` ($${esc(draft.tokenSymbol)})` : ''} · ${draft.vibe} · ${draft.durationSec}s · ${costLabel}${premiumLine}\n${fundsLine}\nStoryboard: ${shots} shots, 16:9\n\n📝 <i>${esc(draft.script)}</i>${adBlock}\n\nApprove to create the job and reserve the credits — nothing is charged until you approve.`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Approve & create', callback_data: 'studio:approve' }],
      [{ text: '✏️ Edit script', callback_data: 'studio:edit' }],
      [{ text: '🔄 Regenerate script', callback_data: 'studio:regen' }, { text: '❌ Cancel', callback_data: 'studio:cancel' }],
    ]},
  };
}

/** Facts panel for the link path: every fetched field shown, nulls shown
 *  as "not found" — the seller corrects, never PB inventing. */
function linkFactsPanel(facts) {
  const f = facts ?? {};
  const line = (label, v) => `${label}: ${v ? esc(String(v).slice(0, 300)) : '<i>not found</i>'}`;
  return {
    text: `🔗 <b>Product link — check the facts</b>\n\n${line('Page', f.url)}\n${line('Title', f.title)}\n${line('Description', f.description)}\n${line('Photo', f.imageUrl)}\n${line('Price', f.price)}\n\nThese came straight from the page — nothing was guessed. Tap ✅ if they are right, or ✏️ to correct them.`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Looks right', callback_data: 'studio:linkok' }],
      [{ text: '✏️ Correct the facts', callback_data: 'studio:linkedit' }],
      [{ text: '❌ Cancel', callback_data: 'studio:cancel' }],
    ]},
  };
}

async function generateDraftInto(uid, draft, deps = {}) {
  // Video-ad branch: hook + script + plan + caption + hashtags, with
  // the photo read (best-effort) and Codie's craft note folded in by
  // generateVideoAdDraft. The photo read never blocks the draft: a
  // failure is shown as a photo note and the draft proceeds from the
  // brief, the photo still riding to the render via its file_id.
  if (draft.adSource) {
    if (draft.adSource === 'photo' && draft.photoFileId && !draft.photoDescription && !draft.photoNote) {
      const seen = await describeVideoAdPhoto(draft.photoFileId, deps)
        .catch((err) => ({ ok: false, reason: String(err?.message ?? 'photo read failed').slice(0, 200) }));
      if (seen.ok) draft.photoDescription = seen.description;
      else draft.photoNote = seen.reason;
    }
    const ad = await generateVideoAdDraft({
      brief: draft.brief, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol,
      tokenAddress: draft.tokenAddress, vibe: draft.vibe, durationSec: draft.durationSec,
      photoDescription: draft.photoDescription ?? null, sourceUrl: draft.sourceUrl ?? null,
    }, deps);
    draft.script = ad.script;
    // The render handoff rides inside the storyboard (premium precedent):
    // source + pointers only; the marketing copy lives in the per-job
    // config meta saved at approve time.
    draft.storyboard = {
      ...ad.storyboard,
      videoAd: { source: draft.adSource, sourceUrl: draft.sourceUrl ?? null, photoFileId: draft.photoFileId ?? null },
    };
    draft.hook = ad.hook;
    draft.plan = ad.plan;
    draft.caption = ad.caption;
    draft.hashtags = ad.hashtags;
    draft.cost = await studioVideoAdCost();
    const ent = await getStudioEntitlement(uid);
    draft.fundsPreview = draft.cost != null ? previewFunds(ent, draft.cost, {}) : null;
    draft.stage = 'draft';
    await saveWiz(uid, draft);
    return draft;
  }
  const { script, storyboard } = await generateStudioScript({
    brief: draft.brief, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol,
    tokenAddress: draft.tokenAddress, vibe: draft.vibe, durationSec: draft.durationSec,
  }, deps);
  draft.script = script;
  draft.storyboard = storyboard;
  draft.cost = studioCostWithPremium(draft.durationSec, draft.premium);
  const ent = await getStudioEntitlement(uid);
  draft.fundsPreview = previewFunds(ent, draft.cost, premiumCost(draft.premium) > 0 ? { noTrial: true } : {});
  draft.stage = 'draft';
  await saveWiz(uid, draft);
  return draft;
}

export const STUDIO_COMMANDS = {
  create: async (chatId, args, msg) => {
    const uid = msg?.from?.id;
    if (!uid) return;
    if (!(await isStudioEnabled())) {
      try { await api.sendMessage({ chat_id: chatId, text: STUDIO_MOVING_NOTICE }); } catch { /* blocked */ }
      return;
    }
    if (msg.chat?.type !== 'private') {
      // Menu-buttons fix (2026-11-05): the group note must not claim a DM
      // that never arrived — a closed DM gets the fallback note instead.
      // (Same lie the /menu DM branches had; this fixes the /create
      // command's group path too.)
      const delivered = await sendDm(uid, '🎬 Studio runs in DM — run /create here and we\u2019ll build your video ad step by step.').catch(() => false);
      try {
        await api.sendMessage({ chat_id: chatId, text: delivered
          ? '🎬 Sent you a DM — Studio builds your video ad there. Run /create in our DM to start.'
          : "🔒 I couldn't DM you — open a DM with me first, then run /create there." });
      } catch { /* group send failed */ }
      return;
    }
    const draft = {
      stage: 'brief', brief: '', vibe: 'hype', durationSec: 15,
      tokenName: '', tokenSymbol: '', tokenAddress: null,
      script: null, storyboard: null, cost: null, fundsPreview: null,
      // Video-ad intake (photo/link): null for the classic brief flow.
      // adSource 'photo' | 'link'; the classic flow never sets it, so
      // every classic path below is untouched by this wave.
      adSource: null, photoFileId: null, photoDescription: null, photoNote: null,
      sourceUrl: null, linkFacts: null, hook: null, plan: null, caption: null,
      hashtags: null, logoUrl: null,
      // Batch 4: premium is offered in this wizard ONLY when the flag was
      // on at /create time; createStudioJob re-gates on the flag at
      // approve time regardless (defense in depth).
      premium: null, premiumEnabled: await isStudioPremiumEnabled(),
      createdAt: Date.now(),
    };
    await saveWiz(uid, draft);
    const jobs = await listOwnStudioJobs(uid, 5);
    await sendDm(uid,
      '🎬 <b>PB Studio</b>\n\nI\u2019ll write the script, you approve it, and Studio renders an original branded 16:9 MP4 with voiceover, captions, music and token branding.\n\n✏️ First: tell me the brief — what should this ad say? (One or two sentences: the token, the vibe, the call to action.)\n\n📸 Or send a product photo, or paste a product link instead — I\u2019ll build the ad from that.'
      + (jobs.length ? `\n\n<b>Your recent jobs:</b>\n${jobs.map(renderJobLine).join('\n')}` : ''),
      { parse_mode: 'HTML' });
  },
};

/**
 * Photo-step capture for the video-ad wizard. Called from the DM media
 * path (caption-less photos) and the main flow (captioned photos) in
 * handlers/message.js. Returns true ONLY when a Studio wizard is waiting
 * for its first input (stage 'brief') — every other photo falls through
 * to the existing consumers untouched. The largest size is kept; the
 * bytes are read once, at draft time (describeVideoAdPhoto), never
 * input-looped (Replit ffmpeg-still-image-loops.md).
 */
/** A photo caption that reads as a Studio instruction — an ad/video/
 *  studio mention, a hashtag instruction, or /create. Narrow on purpose:
 *  a bare $TICKER or a plain question ("what do you think of this
 *  chart?") is NOT Studio intent and still falls through to DM vision.
 *  Pure. */
export function looksLikeStudioPhotoCaption(caption) {
  const c = String(caption ?? '');
  if (!c.trim()) return false;
  if (/\/create\b/i.test(c)) return true;
  if (/\bhashtags?\b/i.test(c)) return true;
  if (/\bvideo\b/i.test(c)) return true;
  if (/\bstudio\b/i.test(c)) return true;
  if (/\bad\b/i.test(c)) return true;
  return false;
}

export async function handleStudioWizardPhoto(chatId, user, message, deps = {}) {
  if (!user?.id || !message?.photo?.length) return false;
  if (String(chatId) !== String(user.id)) return false; // DM only
  if (!(await isStudioEnabled())) return false;
  const draft = await loadWiz(user.id);
  if (!draft || draft.stage !== 'brief') {
    // F17 photo-intake guard (Rowdy 2026-11-06): a photo captioned like
    // a Studio instruction with NO wizard awaiting it must not fall
    // through silently — say so plainly. Only when there is no draft at
    // all: a draft at a later stage already ran /create, so that message
    // would be false. Caption-less and plain-caption photos still fall
    // through to DM vision, untouched.
    if (!draft && looksLikeStudioPhotoCaption(message?.caption)) {
      await sendDm(user.id, '📸 Got the photo — but there\u2019s no Studio session waiting for it. Run /create first, then send the photo and I\u2019ll use it as the ad visual.');
      return true;
    }
    return false;
  }
  const photo = message.photo[message.photo.length - 1];
  if (!photo?.file_id) return false;
  draft.adSource = 'photo';
  draft.photoFileId = String(photo.file_id);
  const caption = String(message.caption ?? '').trim().slice(0, 1000);
  if (caption) draft.brief = caption;
  draft.cost = await studioVideoAdCost();
  draft.stage = 'pick';
  await saveWiz(user.id, draft);
  const panel = pickPanel(draft);
  await sendDm(user.id,
    `📸 <b>Photo received</b> — it will be the ad visual.${caption ? ' Brief taken from your caption.' : ' Tell me the product name at the token step.'}\n\n${panel.text}`,
    { parse_mode: 'HTML', reply_markup: panel.reply_markup });
  return true;
}

/** Text-step capture for the wizard. Returns true when consumed. */
export async function handleStudioWizardText(chatId, user, text, deps = {}) {
  if (!user?.id || !text || text.startsWith('/')) return false;
  if (String(chatId) !== String(user.id)) return false; // DM only
  const draft = await loadWiz(user.id);
  if (!draft) {
    // Gap-3: an edit left armed past the session TTL gets the expired
    // answer — never a silent commit (the draft is simply gone).
    try {
      const raw = await getConfig(wizKey(user.id), null);
      const stale = raw ? JSON.parse(raw) : null;
      if (stale?.stage === 'edit' && stale.createdAt) {
        await clearWiz(user.id);
        await sendDm(user.id, '⏳ That draft expired — run /create again to pick it back up. Nothing was created or charged.');
        return true;
      }
    } catch { /* fall through */ }
    return false;
  }
  if (draft.stage === 'edit') {
    // The user's own replacement script, vetted exactly like a generated
    // one (claim guard → parked-site rewrite → word budget). On any
    // refusal the draft survives untouched for another edit.
    const siteUrl = isPbaiToken(draft) ? await getSiteUrl() : null;
    const vet = vetEditedStudioScript(text, { durationSec: draft.durationSec, siteUrl });
    if (!vet.ok) {
      await sendDm(user.id, `✏️ That edit didn't land — ${vet.error}\n\nYour current draft is unchanged. Send a fixed version, or use the buttons on the review message to keep the current script or cancel.`);
      return true;
    }
    draft.script = vet.script;
    draft.storyboard = buildStoryboard(vet.script, draft.vibe, draft.durationSec, draft);
    if (draft.adSource) {
      // The edited script replaces the whole script, so the derived ad
      // copy (hook/plan/caption) is rebuilt from it — the review panel
      // never shows a stale caption — and the render handoff key rides
      // on the rebuilt storyboard.
      draft.storyboard = {
        ...draft.storyboard,
        videoAd: { source: draft.adSource, sourceUrl: draft.sourceUrl ?? null, photoFileId: draft.photoFileId ?? null },
      };
      draft.hook = videoAdHookFromScript(vet.script);
      draft.plan = videoAdPlanFromStoryboard(draft.storyboard);
      const siteUrl = isPbaiToken(draft) ? await getSiteUrl() : null;
      draft.caption = buildVideoAdCaption({
        hook: draft.hook, productName: draft.tokenName,
        siteHost: siteUrl ? siteHostOf(siteUrl) : '',
        hashtags: draft.hashtags ?? [], sourceUrl: draft.sourceUrl ?? '',
      });
    }
    draft.stage = 'draft';
    await saveWiz(user.id, draft);
    const panel = draftPanel(draft);
    await sendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    return true;
  }
  const value = String(text).trim().slice(0, 1000);
  if (!value) return false;

  if (draft.stage === 'brief') {
    // Link intake: a URL in the first message fetches the product facts
    // and shows them for correction — the classic brief path below is
    // untouched for any non-URL text.
    const url = extractVideoAdUrl(value);
    if (url) {
      await sendDm(user.id, '🔗 Fetching that page…');
      let facts;
      try {
        facts = await fetchLinkFacts(url, deps);
      } catch (err) {
        // Fail discipline: the reason goes to the user, the wizard stays
        // in 'brief' so a photo or a typed brief still works. No job, no
        // charge, no spinner.
        await sendDm(user.id, `❌ Couldn't use that link — ${String(err?.message ?? 'fetch failed').slice(0, 200)}\n\nSend a product photo or a short brief instead — nothing was created or charged.`);
        return true;
      }
      draft.adSource = 'link';
      draft.sourceUrl = url;
      draft.linkFacts = facts;
      draft.logoUrl = facts.imageUrl || null;
      draft.cost = await studioVideoAdCost();
      draft.stage = 'linkfacts';
      await saveWiz(user.id, draft);
      const panel = linkFactsPanel(facts);
      await sendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
      return true;
    }
    draft.brief = value;
    draft.stage = 'pick';
    await saveWiz(user.id, draft);
    const panel = pickPanel(draft);
    await sendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    return true;
  }
  if (draft.stage === 'linkfacts' || draft.stage === 'linkedit') {
    // The seller's corrected facts (or a fresh message while the facts
    // panel is up): first line / first clause is the product name, the
    // rest is the brief. Nothing here invents — the seller's words win.
    const firstBreak = value.search(/\n| — | - /);
    const name = (firstBreak >= 0 ? value.slice(0, firstBreak) : value).trim().slice(0, 80);
    const rest = (firstBreak >= 0 ? value.slice(firstBreak).replace(/^\n|^ — |^ - /, '') : '').trim();
    if (name) draft.tokenName = name;
    draft.brief = (rest || draft.linkFacts?.description || draft.linkFacts?.title || '').slice(0, 1000);
    draft.cost = await studioVideoAdCost();
    draft.stage = 'pick';
    await saveWiz(user.id, draft);
    const panel = pickPanel(draft);
    await sendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    return true;
  }
  if (draft.stage === 'token') {
    // "Name $SYM" / "Name SYM" / just a name.
    const m = /^(.+?)(?:\s+\$?([A-Za-z0-9]{2,12}))?$/.exec(value);
    draft.tokenName = (m?.[1] ?? value).trim().slice(0, 80);
    draft.tokenSymbol = (m?.[2] ?? '').toUpperCase();
    draft.tokenAddress = null;
    await saveWiz(user.id, draft);
    await sendDm(user.id, '✍️ Writing your script…');
    try {
      const ready = await generateDraftInto(user.id, draft, deps);
      const panel = draftPanel(ready);
      await sendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    } catch (err) {
      draft.stage = 'token';
      await saveWiz(user.id, draft);
      await sendDm(user.id, `❌ Script generation failed — ${humanBrainErr(err)}. Send the token again to retry, or /create to restart.`);
    }
    return true;
  }
  return false;
}

/** Button router for `studio:*` callbacks. Caller answers the query. */
export async function handleStudioCallback({ userId, data, messageId }, deps = {}) {
  const uid = userId;
  const sub = data.slice('studio:'.length);
  if (!(await isStudioEnabled())) return { text: '🎬 Studio is parked right now.', alert: true };
  const draft = await loadWiz(uid);
  // 'jobs' and 'xqueue:*' carry no wizard state (the wizard is cleared
  // long before a job completes) — they must not hit the expired-session
  // guard below.
  if (!draft && sub !== 'jobs' && !sub.startsWith('xqueue:')) return { text: '⏳ Studio session expired — run /create again.', alert: true };

  if (sub === 'cancel') {
    await clearWiz(uid);
    await editPanel(uid, messageId, '❌ Studio session cancelled. Nothing was charged.');
    return { text: 'Cancelled' };
  }
  if (sub === 'jobs') {
    const jobs = await listOwnStudioJobs(uid, 10);
    await sendDm(uid, jobs.length
      ? `🎬 <b>Your Studio jobs</b>\n\n${jobs.map(renderJobLine).join('\n')}`
      : '🎬 No Studio jobs yet — run /create to make your first video.', { parse_mode: 'HTML' });
    return { text: undefined };
  }
  if (sub.startsWith('vibe:')) {
    const v = sub.slice(5);
    if (STUDIO_VIBES.includes(v)) draft.vibe = v;
    await saveWiz(uid, draft);
    const panel = pickPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: undefined };
  }
  if (sub.startsWith('dur:')) {
    const d = Number(sub.slice(4));
    // Video-ad drafts take the short cuts; the classic wizard keeps its
    // own duration list.
    const allowed = draft.adSource ? VIDEO_AD_DURATIONS : STUDIO_DURATIONS;
    if (allowed.includes(d)) draft.durationSec = d;
    await saveWiz(uid, draft);
    const panel = pickPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: undefined };
  }
  // Link-facts confirm: the fetched facts become the brief/token and the
  // wizard moves to vibe/length. Edit: the seller types corrections.
  if (sub === 'linkok') {
    if (draft.stage !== 'linkfacts') return { text: 'Those facts are no longer waiting.', alert: true };
    const facts = draft.linkFacts ?? {};
    if (facts.title && !draft.tokenName) draft.tokenName = String(facts.title).slice(0, 80);
    draft.brief = String(facts.description || facts.title || '').slice(0, 1000);
    draft.cost = await studioVideoAdCost();
    draft.stage = 'pick';
    await saveWiz(uid, draft);
    const panel = pickPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: '✅ Facts confirmed' };
  }
  if (sub === 'linkedit') {
    if (draft.stage !== 'linkfacts') return { text: 'Those facts are no longer waiting.', alert: true };
    draft.stage = 'linkedit';
    await saveWiz(uid, draft);
    await editPanel(uid, messageId,
      '✏️ <b>Correct the facts</b>\n\nSend one message — product name first, then what it is (e.g. "Acme Widget — a solar charger, $29"). Your words replace the fetched facts.',
      { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'studio:cancel' }]] });
    return { text: '✏️ Send the corrections' };
  }
  // X-queue for a completed PB-own video ad: owner-only, mascot-only,
  // delivered-file-only. The caption is the APPROVED one from the job
  // meta; the send itself still runs the X loop's kill switch, 1000-char
  // drop, budget and pacing at send time. No wizard state is needed.
  if (sub.startsWith('xqueue:')) {
    const jobId = sub.slice('xqueue:'.length);
    const job = await getStudioJob(jobId);
    if (!job || String(job.telegramUserId) !== String(uid)) return { text: 'Job not found.', alert: true };
    if (!(await ownerIdSet().catch(() => new Set())).has(String(uid))) {
      return { text: 'Only Rowdy queues PB ads to X.', alert: true };
    }
    if (!job.mascot) return { text: 'Only PoorBoyAI\u2019s own ads queue to X — customer ads are delivered as a file.', alert: true };
    if (job.status !== 'complete') return { text: 'That video is not ready yet.', alert: true };
    const meta = await readVideoAdMeta(jobId);
    const caption = String(meta?.caption ?? '').trim();
    if (!caption) return { text: 'No approved caption on file for this job.', alert: true };
    const fileId = await getConfig(studioVideoFileKey(jobId), null).catch(() => null);
    if (!fileId) return { text: 'No delivered file on record yet — the video has to land in your DMs first.', alert: true };
    const r = await xQueueAdd(caption, uid, null, jobId);
    if (!r?.ok) return { text: `Could not queue it: ${r?.reason ?? 'queue error'}.`, alert: true };
    return { text: `📣 Queued to X (position ${r.position}) — it still goes through the X loop's own checks and daily cap.`, alert: true };
  }
  if (sub === 'prem:imagine' || sub === 'prem:voice') {
    if (!draft.premiumEnabled) return { text: '✨ Premium is not open yet.', alert: true };
    const next = { ...(draft.premium ?? {}) };
    if (sub === 'prem:imagine') {
      if (next.imagineSeconds) delete next.imagineSeconds;
      else next.imagineSeconds = premiumImagineSeconds(draft.durationSec);
    } else if (next.voice === 'xai') delete next.voice;
    else next.voice = 'xai';
    draft.premium = (next.imagineSeconds || next.voice) ? next : null;
    await saveWiz(uid, draft);
    const panel = pickPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: undefined };
  }
  if (sub === 'tokenstep') {
    draft.stage = 'token';
    await saveWiz(uid, draft);
    await editPanel(uid, messageId,
      '🪙 <b>Which token is this ad for?</b>\n\nSend the token name and symbol as your next message (e.g. "PoorBoyAI PBAI"), or tap the $PBAI quick-pick.\n\n<i>The PB mascot only performs in PoorBoyAI\u2019s own ads — third-party token ads are mascot-free.</i>',
      { inline_keyboard: [
        [{ text: '🪙 PoorBoyAI $PBAI', callback_data: 'studio:token:pbai' }],
        [{ text: '❌ Cancel', callback_data: 'studio:cancel' }],
      ]});
    return { text: undefined };
  }
  if (sub === 'token:pbai') {
    draft.tokenName = 'PoorBoyAI';
    draft.tokenSymbol = 'PBAI';
    draft.tokenAddress = PBAI_CA;
    draft.mascot = 1;
    await saveWiz(uid, draft);
    await sendDm(uid, '✍️ Writing your script…');
    try {
      const ready = await generateDraftInto(uid, draft, deps);
      const panel = draftPanel(ready);
      await sendDm(uid, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    } catch (err) {
      await sendDm(uid, `❌ Script generation failed — ${humanBrainErr(err)}. Run /create to retry.`);
    }
    return { text: undefined };
  }
  if (sub === 'regen') {
    if (draft.stage !== 'draft') return { text: 'No draft to regenerate yet.', alert: true };
    try {
      const ready = await generateDraftInto(uid, draft, deps);
      const panel = draftPanel(ready);
      await editPanel(uid, messageId, panel.text, panel.reply_markup);
    } catch (err) {
      return { text: `❌ Regeneration failed — ${humanBrainErr(err)}.`, alert: true };
    }
    return { text: '🔄 New script drafted' };
  }
  if (sub === 'edit') {
    if (draft.stage !== 'draft' || !draft.script) return { text: 'Review a script draft first.', alert: true };
    draft.stage = 'edit';
    await saveWiz(uid, draft);
    await editPanel(uid, messageId,
      `✏️ <b>Edit your script</b>\n\nSend the full replacement script as your next message — it replaces the whole script. Your words go through the same claim check as a generated script, and the ~${Math.round((draft.durationSec || 15) * 2.5)}-word budget for a ${draft.durationSec}s ad still applies. I'll show the result back here for a final approve — nothing is created or charged until you approve.`,
      { inline_keyboard: [
        [{ text: '↩️ Keep current script', callback_data: 'studio:editback' }],
        [{ text: '❌ Cancel', callback_data: 'studio:cancel' }],
      ]});
    return { text: '✏️ Send the new script' };
  }
  if (sub === 'editback') {
    if (draft.stage !== 'edit') return { text: undefined };
    draft.stage = 'draft';
    await saveWiz(uid, draft);
    const panel = draftPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: '↩️ Kept your script' };
  }
  if (sub === 'approve') {
    if (draft.stage !== 'draft' || !draft.script) return { text: 'Review a script draft first.', alert: true };
    try {
      const adSource = draft.adSource;
      // Video-ad jobs price ONLY from the config parameter, re-read at
      // approve time (the draft-time read can go stale). Unset = an
      // honest refusal, never a schedule fallback.
      const adCost = adSource ? await studioVideoAdCost() : null;
      if (adSource && adCost == null) {
        return { text: 'Video-ad pricing is not set yet — the per-render price has to be set first. Your draft is saved; nothing was charged.', alert: true };
      }
      const { job } = await createStudioJob(uid, {
        brief: draft.brief, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol,
        tokenAddress: draft.tokenAddress, vibe: draft.vibe, durationSec: draft.durationSec,
        mascot: draft.mascot ? 1 : 0,
        ...(adSource ? { videoAd: 1, logoUrl: draft.logoUrl ?? null } : {}),
        premium: draft.premiumEnabled ? draft.premium : null,
      }, { script: draft.script, storyboard: draft.storyboard, ...(adSource ? { videoAd: true, costOverride: adCost } : {}) });
      if (adSource) {
        await saveVideoAdMeta(job.id, {
          source: adSource, sourceUrl: draft.sourceUrl ?? null, photoFileId: draft.photoFileId ?? null,
          hook: draft.hook ?? null, caption: draft.caption ?? null, hashtags: draft.hashtags ?? [], plan: draft.plan ?? null,
        });
      }
      await clearWiz(uid);
      const fundsLabel = job.fundsSource === 'free_trial'
        ? '🎁 free trial — 0 credits charged'
        : job.fundsSource === 'week_trial'
          ? '🎁 7-day trial — 0 credits charged'
          : job.fundsSource === 'owner'
          ? '👑 owner — unlimited, 0 credits charged'
          : `${job.costCredits} credits reserved (${job.fundsSource}: ${job.includedPart} included + ${job.purchasedPart} purchased)`;
      await editPanel(uid, messageId,
        `✅ <b>Studio job created!</b>\n\n🎬 ${esc(job.tokenName)}${job.tokenSymbol ? ` ($${esc(job.tokenSymbol)})` : ''} · ${job.durationSec}s · ${job.vibe}\n💳 ${fundsLabel}\n📌 Status: ${job.status} — rendering starts shortly; I\u2019ll DM you here when the video is ready.${adSource ? `\n📎 Source: ${adSource === 'photo' ? 'your photo' : 'product link'}${job.mascot ? '' : '\n📩 Customer ad — delivered as a file, never auto-posted to X.'}` : ''}\n\nJob: ${job.id}`);
      return { text: '✅ Job created' };
    } catch (err) {
      return { text: String(err?.message ?? 'Could not create the job.').slice(0, 190), alert: true };
    }
  }
  if (sub.startsWith('canceljob:')) {
    const jobId = sub.slice('canceljob:'.length);
    try {
      const { job } = await cancelStudioJob(uid, jobId);
      return { text: `🚫 Job ${job.id} cancelled — reservation refunded.`, alert: true };
    } catch (err) {
      return { text: String(err?.message ?? 'Cancel failed.').slice(0, 190), alert: true };
    }
  }
  return { text: undefined };
}

// ============================================================================
// Podcast Video Studio (folded into lib/studio.js on 2026-10-20 for the
// platform module cap — was lib/podcast.js; identical code and behavior,
// podcast-internal helpers carry a pod prefix to coexist with Studio's).
// ============================================================================
export const PODCAST_PARKED_NOTICE =
  '🎙️ The Podcast Studio is in the workshop — Carrie and PB are cutting new episodes and it returns soon. Video ads live in /create.';

export const PODCAST_SHOW = 'Crypto Real Talk';
export const PODCAST_HOST = 'Carrie Miller';
export const PODCAST_GUEST = 'PB';

// ── Guest seat (Rowdy's call, 2026-10-21): Carrie always hosts; the
// second seat belongs to the buyer. A custom guest supplies a name, a
// short persona, and a voice from the worker's standard map (tts.js
// VOICE_MAP keys: hype/professional/degen). PB stays the default guest —
// with no custom guest, every prompt, label, storyboard and price below
// is the pre-guest shape exactly.
export const PODCAST_GUEST_VOICES = {
  hype: '🔥 Hype — excitable read',
  professional: '🎓 Professional — clear read',
  degen: '🎲 Degen — playful read',
};
export const PODCAST_DEFAULT_GUEST = { name: PODCAST_GUEST, persona: null, voice: null };

/**
 * Normalize a buyer-supplied guest descriptor. Anything unusable falls
 * back to the default guest: a name that collides with the host's label
 * or carries label-breaking characters can never reach a script.
 */
export function normalizePodcastGuest(guest) {
  const name = String(guest?.name ?? '').replace(/[:\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!name || /^pb$/i.test(name) || /^carrie/i.test(name)) return { ...PODCAST_DEFAULT_GUEST };
  const persona = String(guest?.persona ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) || null;
  const voice = PODCAST_GUEST_VOICES[guest?.voice] ? String(guest.voice) : 'professional';
  return { name, persona, voice };
}

export function isDefaultPodcastGuest(guest) {
  return !guest || String(guest.name ?? PODCAST_GUEST) === PODCAST_GUEST;
}

/** Regex source for one speaker label (words escaped, whitespace-flexed). */
function podLabelPattern(name) {
  return String(name).split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
}

// Length classes (design §3.4/§4 — pricing + gates PROPOSED 2026-10-20,
// approved by Rowdy with the sample; the constants are the single place
// an amendment lands).
export const PODCAST_CLASSES = {
  short: { seconds: 90, words: 220, cost: 50, label: 'Short · ~1 min', minTier: 'free' },
  standard: { seconds: 330, words: 800, cost: 150, label: 'Standard · ~5 min', minTier: 'starter' },
  long: { seconds: 660, words: 1600, cost: 300, label: 'Long · ~10 min', minTier: 'builder' },
};
export const PODCAST_INCLUDED = { free: 0, starter: 50, builder: 200, pro: 600, agency: 1500, one: 0, trial: 0 };
// PRICING WAVE: podcast included for 'one' is 0 until the allowance is
// decided (the config key feeds the VIDEO pool only — see
// getStudioEntitlement); 'trial' draws from the pb_trials counter.
const pod_TERMINAL_STATES = ['complete', 'failed', 'cancelled'];
const pod_PRE_RENDER_STATES = ['pending', 'script_ready'];
const SCRIPT_CHAR_CAP = 12000;

export async function isPodcastEnabled() {
  try { return await getConfigFlag('podcast_enabled'); } catch { return false; }
}

export function podcastCost(lengthClass) {
  return (PODCAST_CLASSES[lengthClass] ?? PODCAST_CLASSES.short).cost;
}

function tierRank(tier) { return CANONICAL_TIERS.indexOf(canonicalTier(tier)); }

export function podcastGate(tier, lengthClass) {
  const cls = PODCAST_CLASSES[lengthClass] ?? PODCAST_CLASSES.short;
  return tierRank(tier) >= tierRank(cls.minTier)
    ? { ok: true }
    : { ok: false, reason: `The ${cls.label} episode needs the ${cls.minTier[0].toUpperCase() + cls.minTier.slice(1)} plan or above — your plan is ${canonicalTier(tier)}.` };
}

function podNowSec() { return Math.floor(Date.now() / 1000); }

function podMintJobId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'sj_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function podEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Script format: the original's labelled turns ────────────────────────

export function parsePodcastTurns(script, guestName = PODCAST_GUEST) {
  const src = String(script ?? '');
  const guest = String(guestName || PODCAST_GUEST);
  const pattern = new RegExp(`\\b(Carrie(?:\\s+Miller)?|${podLabelPattern(guest)})\\s*:\\s*`, 'gi');
  const matches = [...src.matchAll(pattern)];
  const turns = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    const text = src.slice(m.index + m[0].length, end)
      .split(/\r?\n/).map((l) => l.trim()).join(' ')
      .replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    if (text) turns.push({ speaker: m[1].toLowerCase().startsWith('carrie') ? 'Carrie' : guest, text });
  }
  return turns;
}

export function podcastWordCount(script, guestName = PODCAST_GUEST) {
  return parsePodcastTurns(script, guestName).reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
}

/** Normalize brain output into the canonical stored script shape. */
export function normalizePodcastScript(raw, guestName = PODCAST_GUEST) {
  const guest = String(guestName || PODCAST_GUEST);
  const turns = parsePodcastTurns(raw, guest);
  if (turns.length < 2) return '';
  return turns.map((t) => `${t.speaker === 'Carrie' ? 'Carrie Miller' : guest}:\n${t.text}`).join('\n\n').slice(0, SCRIPT_CHAR_CAP);
}

// ── Script generation (askLLM under the outbound claim guard) ───────────

export const PODCAST_SYSTEM_PROMPT = `You are PB, the PoorBoyAI Podcast Studio script writer.
Write a two-host podcast interview script for "Crypto Real Talk": Carrie Miller, the host,
interviews PB (PoorBoyAI — the robot in the cap and hoodie who built the PoorBoyAI community
tools). Alternate labelled turns: "Carrie Miller:" asks, reacts and wraps; "PB:" answers in
first person, plainspoken, from-the-trenches. Open with Carrie's welcome and close with her
sign-off. Write ONLY the labelled dialogue — no stage directions, no narration, no headers.
Never promise guaranteed returns, price moves, or marketing performance; never invent live
prices, metrics, or holder numbers. If Carrie mentions a website, it is only the one the
brief names. Keep every turn speakable in one breath-group: 1–4 sentences per turn.`;

/** System prompt for an episode: the default guest returns the standing
 * prompt verbatim; a buyer's guest is written in with their persona. */
export function podcastSystemPrompt(guest) {
  if (isDefaultPodcastGuest(guest)) return PODCAST_SYSTEM_PROMPT;
  const g = normalizePodcastGuest(guest);
  const who = g.persona ? `${g.name} (${g.persona})` : g.name;
  return `You are PB, the PoorBoyAI Podcast Studio script writer.
Write a two-host podcast interview script for "Crypto Real Talk": Carrie Miller, the host,
interviews ${who}. Alternate labelled turns: "Carrie Miller:" asks, reacts and wraps; "${g.name}:" answers in
first person, in character as ${g.name}. Open with Carrie's welcome and close with her
sign-off. Write ONLY the labelled dialogue — no stage directions, no narration, no headers.
Never promise guaranteed returns, price moves, or marketing performance; never invent live
prices, metrics, or holder numbers. If Carrie mentions a website, it is only the one the
brief names. Keep every turn speakable in one breath-group: 1–4 sentences per turn.`;
}

export function podcastScriptPrompt(topic, lengthClass, siteUrl, guestName = PODCAST_GUEST) {
  const cls = PODCAST_CLASSES[lengthClass] ?? PODCAST_CLASSES.short;
  const turns = lengthClass === 'short' ? '6–8' : lengthClass === 'standard' ? '10–14' : '16–22';
  const host = String(siteUrl ?? '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return [
    `Write a ${cls.label} episode of Crypto Real Talk: about ${cls.words} words of dialogue across ${turns} turns.`,
    `Topic: ${String(topic ?? '').slice(0, 400)}`,
    host ? `The live PoorBoyAI site is ${host} (spoken: "${host.replace(/\./g, ' dot ')}"). Never use ${PARKED_SITE_HOST} — that domain is parked and dead.` : '',
    `Carrie opens with the welcome, ${guestName} answers as the guest, Carrie closes the episode. Return only the labelled script.`,
  ].filter(Boolean).join('\n\n');
}

function fallbackGuestPodcastScript(topic, lengthClass, guest) {
  const t = String(topic ?? '').trim().slice(0, 120) || 'their project';
  const G = guest.name;
  const lines = [
    ['Carrie Miller', `Welcome back to Crypto Real Talk, the show where we skip the hype and talk to the people actually building. I'm Carrie Miller, and today ${G} is with me. ${G}, we're talking about ${t}. Where do we start?`],
    [G, `Thanks for having me, Carrie. We start with the problem we saw and couldn't leave alone — and what we decided to build about it.`],
    ['Carrie Miller', `And instead of just talking about it, you shipped it. What does that look like day to day?`],
    [G, `Small honest steps, in public, every day. The work speaks before we do — that's the whole strategy.`],
    ['Carrie Miller', `What's the honest test for whether it's working?`],
    [G, `People showing up because the thing actually helps them. No shortcuts, no promises we can't keep — just proof, one delivery at a time.`],
    ['Carrie Miller', `${G}, thanks for keeping it real. That's it for this episode of Crypto Real Talk. I'm Carrie Miller — stay sharp out there.`],
  ];
  if (lengthClass === 'short') return lines.map(([s, x]) => `${s}:\n${x}`).join('\n\n');
  const extra = [
    ['Carrie Miller', `Let's go deeper. Plenty of builders listening are thousands down and still shipping. What do you tell them?`],
    [G, `Stop waiting for the perfect moment or the perfect team. Build the thing you needed when nobody showed up. Small, honest, every day.`],
    ['Carrie Miller', `And for people hearing about you for the first time — how do they know this isn't just another promise?`],
    [G, `Because the work is live and anyone can check it. Trust is earned in public, one delivery at a time.`],
  ];
  const all = [...lines.slice(0, 5), ...extra, ...lines.slice(5)];
  return all.map(([s, x]) => `${s}:\n${x}`).join('\n\n');
}

function fallbackPodcastScript(topic, lengthClass, guest) {
  if (!isDefaultPodcastGuest(guest)) return fallbackGuestPodcastScript(topic, lengthClass, normalizePodcastGuest(guest));
  const t = String(topic ?? '').trim().slice(0, 120) || 'why PoorBoyAI exists';
  const lines = [
    ['Carrie Miller', `Welcome back to Crypto Real Talk, the show where we skip the hype and talk to the people actually building. I'm Carrie Miller, and today PB is with me. PB, we're talking about ${t}. Where do we start?`],
    ['PB', `Systems online, Carrie. We start where I started: in the trenches, watching good people get burned by bad actors and empty promises.`],
    ['Carrie Miller', `And instead of quitting, you built the tool you wished existed. What does that look like day to day?`],
    ['PB', `A bot that does the work: raids, research, community tools, all in the open. Funds stay with the project. Workers get matched on delivery, not vibes.`],
    ['Carrie Miller', `What's the honest test for whether it's working?`],
    ['PB', `Dead chats coming back to life because the right people are in the room. That's it. I don't need a handout — I'm asking for a hand up.`],
    ['Carrie Miller', `PB, thanks for keeping it real. That's it for this episode of Crypto Real Talk. I'm Carrie Miller — stay sharp out there.`],
  ];
  if (lengthClass === 'short') return lines.map(([s, x]) => `${s}:\n${x}`).join('\n\n');
  const extra = [
    ['Carrie Miller', `Let's go deeper. A lot of builders listening are thousands down and still shipping. What do you tell them?`],
    ['PB', `Stop waiting for the perfect team or the perfect signal. Build the tool you needed when nobody showed up. Small, honest, every day.`],
    ['Carrie Miller', `And the community side — how do people know this isn't just another promise?`],
    ['PB', `Because the tools are live and anyone can use them. Trust is earned in public, one delivery at a time.`],
  ];
  const all = [...lines.slice(0, 5), ...extra, ...lines.slice(5)];
  return all.map(([s, x]) => `${s}:\n${x}`).join('\n\n');
}

/**
 * Round context for a recurring-series episode (additive, 2026-11-04):
 * priorAngles = angles already covered (the brain must NOT repeat them);
 * angle = this round's fresh angle; research = fresh facts for the round.
 * All three are optional — one-off wizard calls pass none of them and
 * the prompt below is byte-identical to the pre-series shape.
 */
function podRoundContext(params) {
  const lines = [];
  const prior = Array.isArray(params?.priorAngles) ? params.priorAngles.filter(Boolean).slice(-20) : [];
  if (prior.length) {
    lines.push(`Previously covered angles in this series — do NOT repeat any of them, pick a genuinely different angle:\n${prior.map((a) => `- ${String(a).slice(0, 160)}`).join('\n')}`);
  }
  if (params?.angle) lines.push(`This round's fresh angle: ${String(params.angle).slice(0, 300)}`);
  if (params?.research) lines.push(`Fresh research for this round — use these facts and do not invent others:\n${String(params.research).slice(0, 2000)}`);
  return lines.length ? `\n\n${lines.join('\n\n')}` : '';
}

/**
 * Generate an episode script. Provider failures propagate (never a
 * silent substitution); the deterministic fallback is used only when
 * generated text is BLOCKED by the claim guard — the Studio rule.
 */
export async function generatePodcastScript(params, deps = {}) {
  const ask = deps.ask || askLLM;
  const siteUrl = deps.siteUrl ?? await getSiteUrl();
  const guest = normalizePodcastGuest(params.guest);
  const raw = await generateSafeOutboundContent(
    () => ask({
      systemPrompt: podcastSystemPrompt(guest),
      userMessage: podcastScriptPrompt(params.topic, params.lengthClass, siteUrl, guest.name) + podRoundContext(params),
      history: [],
      maxOutputTokens: params.lengthClass === 'long' ? 2600 : params.lengthClass === 'standard' ? 1500 : 700,
    }),
    fallbackPodcastScript(params.topic, params.lengthClass, guest),
  );
  let script = normalizePodcastScript(String(raw ?? ''), guest.name);
  if (!script) {
    // The brain answered off-format; the deterministic fallback keeps the
    // wizard honest rather than failing the user for the model's shape.
    script = normalizePodcastScript(fallbackPodcastScript(params.topic, params.lengthClass, guest), guest.name);
  }
  // Site-URL guard: an episode never ships a parked-domain CTA.
  script = rewriteParkedSiteRefs(script, siteUrl);
  if (!script) throw new Error('Script generation came back empty.');
  return { script, turns: parsePodcastTurns(script, guest.name), words: podcastWordCount(script, guest.name) };
}

/**
 * Gap-3: vet a user-typed replacement episode script (whole-script
 * replace; turns re-parsed by parsePodcastTurns) with the SAME rules a
 * generated one passes — the outbound claim guard, the both-voices
 * format createPodcastJob enforces at approve, the parked-site rewrite,
 * and the word budget with the overage named (the createPodcastJob
 * approve rule: words > ceil(class budget × 1.15) refuses). A refusal
 * leaves the stored draft untouched for another edit.
 */
export async function vetEditedPodcastScript(rawText, lengthClass, guestName = PODCAST_GUEST) {
  const cls = PODCAST_CLASSES[lengthClass] ?? PODCAST_CLASSES.short;
  const guest = String(guestName || PODCAST_GUEST);
  const raw = String(rawText ?? '').trim().slice(0, SCRIPT_CHAR_CAP);
  if (!raw) return { ok: false, error: 'That came back empty — send the full script text.' };
  try {
    assertSafeOutboundContent(raw);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? 'That text trips the claim guard.') };
  }
  const turns = parsePodcastTurns(raw, guest);
  if (turns.length < 2 || new Set(turns.map((t) => t.speaker)).size < 2) {
    return { ok: false, error: `I couldn't find both voices in that — keep the "Carrie Miller:" and "${guest}:" labels with at least one turn each, and send it again.` };
  }
  let script = normalizePodcastScript(raw, guest);
  script = rewriteParkedSiteRefs(script, await getSiteUrl());
  const words = podcastWordCount(script, guest);
  const maxWords = Math.ceil(cls.words * 1.15);
  if (words > maxWords) {
    return {
      ok: false,
      error: `That cut runs ${words} words — over the ${cls.label} budget of ${cls.words} (max ${maxWords}). Trim ${words - maxWords} word${words - maxWords === 1 ? '' : 's'} and send it again.`,
    };
  }
  return { ok: true, script, words };
}

// ── Credit ledger (podcast refIds/kinds; Studio discipline) ────────────

const podUserKeyFor = (tgId) => 'telegram:' + String(tgId);
const podReserveRef = (jobId) => `podcast:${jobId}:reserve`;
const podSettleRef = (jobId) => `podcast:${jobId}:settle`;
const podRefundRef = (jobId) => `podcast:${jobId}:refund`;

async function podLedgerRowByRef(refId) {
  try {
    return await db.select().from(credit_ledger).where(eq(credit_ledger.refId, refId)).get();
  } catch { return null; }
}

async function writePodcastReserve(job) {
  const refId = podReserveRef(job.id);
  if (await podLedgerRowByRef(refId)) return { replay: true };
  // The free first episode was retired 2026-10-21 (Rowdy's call): every
  // episode reserves for real from the first one. Historical rows written
  // under the trial keep kind 'podcast_trial'; nothing writes it anymore.
  await db.insert(credit_ledger).values({
    userKey: podUserKeyFor(job.telegramUserId),
    amount: -(Number(job.purchasedPart) || 0),
    kind: 'podcast_reserve',
    purpose: 'podcast_episode',
    refId,
  }).run();
  return { replay: false };
}

/** Settle on complete: marker only (the reservation stands as the charge). */
export async function settlePodcastJob(jobId) {
  const job = await getStudioJob(jobId);
  if (!job?.telegramUserId) return { skipped: 'unknown_job' };
  if (await podLedgerRowByRef(podSettleRef(jobId))) return { replay: true };
  if (await podLedgerRowByRef(podRefundRef(jobId))) return { skipped: 'already_refunded' };
  if (!(await podLedgerRowByRef(podReserveRef(jobId)))) return { skipped: 'never_reserved' };
  await db.insert(credit_ledger).values({
    userKey: podUserKeyFor(job.telegramUserId),
    amount: 0,
    kind: 'podcast_settle',
    purpose: 'podcast_episode',
    refId: podSettleRef(jobId),
  }).run();
  return { settled: true };
}

/** Refund on failed/cancelled: +purchasedPart back, exactly once. */
export async function refundPodcastJob(jobId) {
  const job = await getStudioJob(jobId);
  if (!job?.telegramUserId) return { skipped: 'unknown_job' };
  if (await podLedgerRowByRef(podRefundRef(jobId))) return { replay: true };
  if (!(await podLedgerRowByRef(podReserveRef(jobId)))) return { skipped: 'never_reserved' };
  if (await podLedgerRowByRef(podSettleRef(jobId))) return { skipped: 'already_settled' };
  // PRICING WAVE: failed/cancelled week-trial episodes restore trial
  // credits (purchasedPart is 0 for week_trial — the restore is the
  // real refund, the ledger marker below is +0).
  if (job.fundsSource === 'week_trial') {
    await restoreWeekTrialCredits(job.telegramUserId, Number(job.costCredits) || 0).catch(() => {});
  }
  await db.insert(credit_ledger).values({
    userKey: podUserKeyFor(job.telegramUserId),
    amount: Number(job.purchasedPart) || 0,
    kind: 'podcast_refund',
    purpose: 'podcast_episode',
    refId: podRefundRef(jobId),
  }).run();
  return { refunded: Number(job.purchasedPart) || 0 };
}

// ── Entitlement (podcast's own pool; base facts from Studio's) ─────────

export function isPodcastRow(row) {
  if (!row) return false;
  try {
    const sb = typeof row.storyboardJson === 'string' ? JSON.parse(row.storyboardJson) : row.storyboardJson;
    return Boolean(sb && sb.kind === 'podcast');
  } catch { return false; }
}

export async function getPodcastEntitlement(tgId) {
  const base = await getStudioEntitlement(tgId); // tier, term window, wallet (product-agnostic)
  const id = String(tgId);
  const tier = base.tier;
  // TIER-LINKAGE: active (not termEnd > now) is the gate — a paid tier
  // with no expiry is ongoing, and termEnd is 0 for it. Grant-only
  // windows are unchanged: active is true exactly when a window is live.
  const allowance = base.active ? (PODCAST_INCLUDED[tier] ?? 0) : 0;
  let includedUsed = 0;
  const rows = await db.select().from(studio_jobs)
    .where(eq(studio_jobs.telegramUserId, id)).all().catch(() => []);
  for (const r of rows) {
    if (!isPodcastRow(r)) continue;
    if (pod_TERMINAL_STATES.slice(1).includes(r.status)) continue; // failed/cancelled don't consume
    if ((Number(r.createdAt) || 0) < (base.termStart || 0)) continue;
    includedUsed += Number(r.includedPart) || 0;
  }
  return {
    tier,
    allowance,
    includedUsed,
    includedRemaining: Math.max(0, allowance - includedUsed),
    wallet: base.wallet,
    termStart: base.termStart,
    termEnd: base.termEnd,
    active: base.active,
    ownerUnlimited: base.ownerUnlimited,
    // PRICING WAVE: 7-day trial state rides the base entitlement.
    weekTrial: base.weekTrial ?? null,
  };
}

/**
 * Split a cost across included → purchased. Null = cannot fund. (No
 * trial split: episodes charge from the first one since 2026-10-21 —
 * the lifetime trial VIDEO is Studio's separate pool and is untouched.)
 */
export function previewPodcastFunds(ent, cost, lengthClass, opts = {}) {
  // TIER-LINKAGE: owner episodes fund with zero parts (same ledger
  // safety as Studio: 0-amount 'podcast_reserve', +0 refund).
  if (ent.ownerUnlimited) {
    return { fundsSource: 'owner', includedPart: 0, purchasedPart: 0 };
  }
  // PRICING WAVE: 7-day trial draws first (full-cost only, like video).
  // TRIALPOLICY 2026-11-01 (#3): ElevenLabs voice is PREMIUM and never
  // rides the trial — callers pass { noTrial: true } for ElevenLabs
  // jobs (same shape as video's premium noTrial), so the trial branch
  // below is skipped and the episode must fund from included/wallet
  // or refuse via the standard premium refusal path. Standard voices
  // keep the old behavior: short (50) fits the 100-credit trial;
  // standard (150) and long (300) exceed it and fall through to
  // included/wallet.
  if (ent.weekTrial?.active && !opts.noTrial && cost <= ent.weekTrial.remaining) {
    return { fundsSource: 'week_trial', includedPart: 0, purchasedPart: 0 };
  }
  const includedPart = Math.min(ent.includedRemaining, cost);
  const purchasedPart = cost - includedPart;
  if (purchasedPart > ent.wallet) return null;
  const fundsSource = purchasedPart === 0 ? 'included' : includedPart === 0 ? 'purchased' : 'mixed';
  return { fundsSource, includedPart, purchasedPart };
}

// ── Jobs ────────────────────────────────────────────────────────────────

function podcastStoryboard(topic, lengthClass, guest, voiceProvider = null, extra = null) {
  const g = normalizePodcastGuest(guest);
  const podcast = {
    show: PODCAST_SHOW,
    topic: String(topic ?? '').slice(0, 400),
    lengthClass,
    hostName: PODCAST_HOST,
    guestName: g.name,
  };
  // Show-track delivery targets (recurring series, 2026-11-04): the
  // worker sends the finished episode to these chats AFTER the owner's
  // DM delivery. Only the series cycle stamps them; one-off wizard
  // episodes never carry the field and render exactly as before.
  if (Array.isArray(extra?.showTargets) && extra.showTargets.length) {
    podcast.showTargets = extra.showTargets.map((c) => String(c)).filter(Boolean).slice(0, 2);
  }
  // Custom-guest fields ride along only when a buyer brought their own
  // character — PB-default storyboards stay byte-identical to the
  // pre-guest shape. guestVoice is a worker tts.js VOICE_MAP key.
  if (!isDefaultPodcastGuest(g)) {
    podcast.guestPersona = g.persona;
    podcast.guestVoice = g.voice;
  }
  // ElevenLabs rides along only when the buyer picked it in the wizard
  // (which only offers it when configured) — standard storyboards stay
  // byte-identical to the pre-E4a shape.
  if (voiceProvider === 'elevenlabs') podcast.voiceProvider = 'elevenlabs';
  return {
    kind: 'podcast',
    version: 1,
    podcast,
  };
}

/**
 * Create an episode job + reserve. Keyed by job id (replays never
 * re-reserve). Throws a clean Error on gate/budget/funds refusal —
 * no rows are written first.
 */
export async function createPodcastJob(tgId, params = {}, opts = {}) {
  const jobId = opts.jobId ? String(opts.jobId) : podMintJobId();
  const existing = await getStudioJob(jobId);
  if (existing) return { job: podcastJobPublic(existing), replay: true };

  const lengthClass = PODCAST_CLASSES[params.lengthClass] ? params.lengthClass : 'short';
  const cls = PODCAST_CLASSES[lengthClass];
  const topic = String(params.topic ?? '').trim().slice(0, 400);
  if (!topic) throw new Error('An episode topic is required.');
  const guest = normalizePodcastGuest(params.guest);
  const script = String(opts.script ?? '').trim();
  if (!script) throw new Error('An approved script is required before an episode can be created.');
  const turns = parsePodcastTurns(script, guest.name);
  if (turns.length < 2 || new Set(turns.map((t) => t.speaker)).size < 2) {
    throw new Error(`The script must alternate Carrie and ${guest.name} — regenerate it before approving.`);
  }
  const words = podcastWordCount(script, guest.name);
  if (words > Math.ceil(cls.words * 1.15)) {
    throw new Error(`That script runs ${words} words — over the ${cls.label} budget of ${cls.words}. Regenerate a tighter cut before approving.`);
  }

  const ent = await getPodcastEntitlement(tgId);
  // TIER-LINKAGE: the owner passes the tier gate regardless of the row tier.
  const gate = ent.ownerUnlimited ? { ok: true } : podcastGate(ent.tier, lengthClass);
  if (!gate.ok) throw new Error(gate.reason);
  const cost = cls.cost;
  // TRIALPOLICY 2026-11-01 (#3): ElevenLabs voice is premium — the
  // trial never funds it, even when the trial balance would cover the
  // episode. The refusal below is the standard premium refusal path
  // (same wording shape as video's "free trial does not cover premium
  // add-ons"): included/wallet may still fund it, trial may not.
  const elevenLabs = params.voiceProvider === 'elevenlabs';
  const split = previewPodcastFunds(ent, cost, lengthClass, elevenLabs ? { noTrial: true } : {});
  if (!split) {
    throw new Error(
      `Insufficient credits. This episode costs ${cost} credits — included remaining ${ent.includedRemaining}, purchased balance ${ent.wallet}${elevenLabs ? ', ElevenLabs voice is premium and never rides the 7-day trial' : (ent.weekTrial?.active ? `, 7-day trial credits remaining ${ent.weekTrial.remaining}` : '')}.`,
    );
  }
  // PRICING WAVE: commit the trial draw before the row exists (same
  // shape as video — writePodcastReserve writes only the 0 marker).
  if (split.fundsSource === 'week_trial') {
    const draw = await commitWeekTrialDraw(tgId, cost);
    if (!draw.ok) {
      throw new Error(
        `Insufficient 7-day trial credits. This episode costs ${cost} credits — trial credits remaining ${draw.remaining}.`,
      );
    }
  }

  const ts = podNowSec();
  const row = {
    id: jobId,
    surface: 'telegram',
    telegramUserId: String(tgId),
    discordUserId: null,
    discordInteractionId: null,
    discordChannelId: null,
    status: 'script_ready',
    stage: null,
    progress: 0,
    vibe: 'professional',
    durationSec: cls.seconds,
    tokenName: `${PODCAST_SHOW} — ${topic}`.slice(0, 80),
    tokenSymbol: null,
    tokenAddress: null,
    tokenChain: null,
    logoUrl: null,
    mascot: 0,
    brief: topic,
    scriptText: script.slice(0, SCRIPT_CHAR_CAP),
    storyboardJson: JSON.stringify(podcastStoryboard(topic, lengthClass, guest, params.voiceProvider ?? null, opts.storyboardExtra ?? null)),
    costCredits: cost,
    fundsSource: split.fundsSource,
    includedPart: split.includedPart,
    purchasedPart: split.purchasedPart,
    deliveryState: 'none',
    deliveryChatId: String(tgId),
    pushedAt: null,
    pushState: 'new',
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(studio_jobs).values(row).run();
  await writePodcastReserve(row);
  return { job: podcastJobPublic(row), replay: false, entitlement: ent };
}

/** Cancel an own episode in a pre-render state: transition + refund. */
export async function cancelPodcastJob(tgId, jobId) {
  const job = await getStudioJob(jobId);
  if (!job || String(job.telegramUserId) !== String(tgId) || !isPodcastRow(job)) {
    throw new Error('Episode not found.');
  }
  if (!pod_PRE_RENDER_STATES.includes(job.status)) {
    throw new Error(`Episode is already ${job.status} — only pending/script-ready episodes can be cancelled.`);
  }
  await db.update(studio_jobs).set({
    status: 'cancelled', updatedAt: podNowSec(),
    pushState: job.pushState === 'pushed' ? 'dirty' : job.pushState,
  }).where(eq(studio_jobs.id, job.id)).run();
  await refundPodcastJob(job.id);
  return { job: podcastJobPublic(await getStudioJob(job.id)) };
}

export async function listOwnPodcastJobs(tgId, limit = 20) {
  const rows = await listAllOwnRows(tgId, Math.max(limit * 3, limit));
  return rows.filter(isPodcastRow).slice(0, limit).map(podcastJobPublic);
}

async function listAllOwnRows(tgId, limit) {
  try {
    return await db.select().from(studio_jobs)
      .where(eq(studio_jobs.telegramUserId, String(tgId)))
      .orderBy(desc(studio_jobs.createdAt)).limit(limit).all();
  } catch { return []; }
}

/** Member-surface shape of a podcast mirror row — own data only. */
export function podcastJobPublic(r) {
  if (!r) return null;
  let meta = {};
  try { meta = (JSON.parse(r.storyboardJson ?? '{}')?.podcast) ?? {}; } catch { /* none */ }
  return {
    id: r.id,
    kind: 'podcast',
    status: r.status,
    stage: r.stage ?? null,
    progress: Number(r.progress) || 0,
    title: r.tokenName ?? PODCAST_SHOW,
    topic: meta.topic ?? r.brief ?? '',
    guestName: meta.guestName ?? PODCAST_GUEST,
    guestVoice: meta.guestVoice ?? null,
    lengthClass: meta.lengthClass ?? 'short',
    durationSec: Number(r.durationSec) || 90,
    scriptText: r.scriptText ?? null,
    costCredits: Number(r.costCredits) || 0,
    fundsSource: r.fundsSource ?? null,
    includedPart: Number(r.includedPart) || 0,
    purchasedPart: Number(r.purchasedPart) || 0,
    failureReason: r.failureReason ?? null,
    deliveryState: r.deliveryState ?? 'none',
    createdAt: Number(r.createdAt) || 0,
    updatedAt: Number(r.updatedAt) || 0,
  };
}

const pod_STATUS_EMOJI = {
  pending: '⏳', script_ready: '📝', voice_ready: '🎙️', rendering: '🎬',
  complete: '✅', failed: '❌', cancelled: '🚫',
};

export function renderPodcastJobLine(job) {
  const j = job?.kind === 'podcast' ? job : podcastJobPublic(job);
  const stage = j.status === 'rendering' && j.stage ? ` · ${j.stage} ${j.progress ?? 0}%` : '';
  return `${pod_STATUS_EMOJI[j.status] ?? '•'} ${j.title} — ${j.status}${stage} · ${j.costCredits} cr (${j.fundsSource ?? '—'})`;
}

// ── Terminal hook: settle/refund + 🎙️ DMs for podcast rows ────────────
// Registered into lib/studio.js's applyStudioDelta (one-way import:
// studio.js never imports this module). Returning true means the
// podcast path fully handled the terminal transition.

async function podDmUser(tgId, text) {
  if (!tgId) return;
  try { await api.sendMessage({ chat_id: tgId, text }); } catch { /* DM closed */ }
}

export async function applyPodcastTerminal(job, status) {
  if (!isPodcastRow(job)) return false;
  if (status === 'complete') {
    await settlePodcastJob(job.id).catch(() => {});
    await podDmUser(job.telegramUserId,
      job.deliveryState === 'sent' || job.deliveryState === 'claimed'
        ? '🎙️ Your podcast episode is ready — it has been delivered here in your DMs. Enjoy!'
        : '🎙️ Your podcast episode is ready! Delivery is pending, so PB will send the MP4 here shortly — no action needed.');
    return true;
  }
  if (status === 'failed' || status === 'cancelled') {
    await refundPodcastJob(job.id).catch(() => {});
    if (status === 'failed') {
      await recordFailureForOwnerAlert(job).catch(() => {});
      await podDmUser(job.telegramUserId,
        `❌ Your podcast episode failed: ${String(job.failureReason ?? 'render failed').slice(0, 300)}\nYour reservation (${job.costCredits} credits) was refunded in full. Run /podcast to try again.`);
    } else {
      await podDmUser(job.telegramUserId, '🚫 Your podcast episode was cancelled — your reservation was refunded in full.');
    }
    return true;
  }
  return false;
}

try { registerStudioTerminalHook(applyPodcastTerminal); } catch { /* studio hook registry unavailable — sync falls back to Studio handling */ }

// ── /podcast wizard (config-state pattern, like Studio/Contests) ───────
// State: config `podcastwiz:<uid>` JSON. DM-only. Stages:
//   topic → guest_choice (PB default, or guest_name → guest_persona →
//   guest_voice for a buyer's own character) → class (buttons) →
//   draft (script + approve/regenerate) → done.

const pod_WIZ_TTL_MS = 30 * 60 * 1000;
const podWizKey = (uid) => `podcastwiz:${uid}`;

async function podLoadWiz(uid) {
  try {
    const raw = await getConfig(podWizKey(uid), null);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || Date.now() - (d.createdAt ?? 0) > pod_WIZ_TTL_MS) return null;
    return d;
  } catch { return null; }
}
async function podSaveWiz(uid, draft) { await setConfig(podWizKey(uid), JSON.stringify(draft)).catch(() => {}); }
async function podClearWiz(uid) { await setConfig(podWizKey(uid), JSON.stringify({ createdAt: 0 })).catch(() => {}); }

async function podSendDm(uid, text, extra = {}) {
  try { await api.sendMessage({ chat_id: uid, text: String(text).slice(0, 4000), ...extra }); } catch { /* DM closed */ }
}
async function podEditPanel(uid, messageId, text, replyMarkup) {
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

function guestChoicePanel(draft) {
  return {
    text: `🎙️ <b>Who sits across from Carrie?</b>\n\nPB is her usual guest — or bring your own character: your project's mascot or persona, with a name, a personality, and a voice you pick. Carrie interviews them in character.`,
    reply_markup: { inline_keyboard: [
      [{ text: '🤖 PB — the usual guest', callback_data: 'podcast:guest:default' }],
      [{ text: '✨ My own character', callback_data: 'podcast:guest:custom' }],
      [{ text: '❌ Cancel', callback_data: 'podcast:cancel' }],
    ]},
  };
}

function guestVoicePanel(draft) {
  const rows = Object.entries(PODCAST_GUEST_VOICES).map(([key, label]) => ([{ text: label, callback_data: `podcast:voice:${key}` }]));
  return {
    text: `🎙️ <b>Pick ${podEsc(draft.guestName)}'s voice</b>\n\nCarrie's voice stays Carrie's — this is your guest's read.`,
    reply_markup: { inline_keyboard: [
      ...rows,
      [{ text: '↩️ Use PB instead', callback_data: 'podcast:guest:default' }, { text: '❌ Cancel', callback_data: 'podcast:cancel' }],
    ]},
  };
}

function classPanel(draft, ent) {
  const rows = Object.entries(PODCAST_CLASSES).map(([key, cls]) => {
    const gate = ent.ownerUnlimited ? { ok: true } : podcastGate(ent.tier, key);
    const split = gate.ok ? previewPodcastFunds(ent, cls.cost, key, draft.voiceProvider === 'elevenlabs' ? { noTrial: true } : {}) : null;
    const funds = !gate.ok ? `🔒 ${cls.minTier}+` : split?.fundsSource === 'owner'
      ? `👑 owner — unlimited`
      : split
        ? `${cls.cost} cr (${split.includedPart} incl + ${split.purchasedPart} purch)`
        : `⚠️ ${cls.cost} cr — not enough credits`;
    return [{ text: `${draft.lengthClass === key ? '✅ ' : '🎙️ '}${cls.label} — ${funds}`, callback_data: `podcast:class:${key}` }];
  });
  return {
    text: `🎙️ <b>Podcast Studio — pick the episode length</b>\n\nTopic: ${podEsc(draft.topic)}\nGuest: <b>${podEsc(draft.guestName ?? PODCAST_GUEST)}</b>\nYour plan: <b>${podEsc(ent.tier)}</b>${ent.ownerUnlimited ? ' · 👑 owner — unlimited' : ` · included remaining: ${ent.includedRemaining} cr · balance: ${ent.wallet} cr`}`,
    reply_markup: { inline_keyboard: [...rows, [{ text: '❌ Cancel', callback_data: 'podcast:cancel' }]] },
  };
}

function podDraftPanel(draft) {
  const preview = draft.fundsPreview;
  const fundsLine = preview
    ? `Funds: ${preview.fundsSource} — ${preview.includedPart} included + ${preview.purchasedPart} purchased`
    : 'Funds: ⚠️ not enough credits for this one — approve will confirm';
  const scriptPreview = String(draft.script ?? '').slice(0, 1100);
  return {
    text: `🎙️ <b>Podcast Studio — review your episode script</b>\n\n📻 ${podEsc(PODCAST_SHOW)} — ${podEsc(draft.topic)}\n🎙️ Carrie Miller with ${podEsc(draft.guestName ?? PODCAST_GUEST)} · ${PODCAST_CLASSES[draft.lengthClass].label} · ${draft.cost} credits · ${draft.words} words${draft.voiceProvider === 'elevenlabs' ? ' · 🎧 ElevenLabs voices' : ''}\n${fundsLine}\n\n📝 <i>${podEsc(scriptPreview)}${draft.script.length > 1100 ? '…' : ''}</i>\n\nApprove to create the episode and reserve the credits — nothing is charged until you approve.`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Approve & create', callback_data: 'podcast:approve' }],
      [{ text: '✏️ Edit script', callback_data: 'podcast:edit' }],
      [{ text: '🔄 Regenerate script', callback_data: 'podcast:regen' }, { text: '❌ Cancel', callback_data: 'podcast:cancel' }],
    ]},
  };
}

async function podGenerateDraftInto(uid, draft, deps = {}) {
  const guest = normalizePodcastGuest({ name: draft.guestName, persona: draft.guestPersona, voice: draft.guestVoice });
  const { script, words } = await generatePodcastScript({ topic: draft.topic, lengthClass: draft.lengthClass, guest }, deps);
  draft.script = script;
  draft.words = words;
  draft.cost = podcastCost(draft.lengthClass);
  const ent = await getPodcastEntitlement(uid);
  draft.fundsPreview = previewPodcastFunds(ent, draft.cost, draft.lengthClass, draft.voiceProvider === 'elevenlabs' ? { noTrial: true } : {});
  draft.stage = 'draft';
  await podSaveWiz(uid, draft);
  return draft;
}

// ── ElevenLabs voice option (E4a restore, 2026-10-21) ─────────────────────
// The source's standalone podcast tool (video-studio/main.py create_voice)
// keyed ElevenLabs per speaker: ELEVENLABS_API_KEY + ELEVENLABS_<SPEAKER>_
// VOICE_ID, both required, else the default TTS. It was fully coded and
// never configured. Restored with the same keying, read from this bot's
// config (the worker reads the same-named env on its side — src/tts.js):
// the wizard offers the choice ONLY when the key + Carrie's voice id +
// the guest's voice id are all present. Unconfigured = the option does
// not exist anywhere in the flow (no dead option). The choice rides the
// storyboard as podcast.voiceProvider === 'elevenlabs'; standard jobs
// carry no field and render exactly as before.

export async function podcastElevenLabsConfigured(guestName = PODCAST_GUEST) {
  try {
    if (!(await getConfig('ELEVENLABS_API_KEY', ''))) return false;
    if (!(await getConfig('ELEVENLABS_CARRIE_VOICE_ID', ''))) return false;
    const guestKey = !guestName || String(guestName) === PODCAST_GUEST
      ? 'ELEVENLABS_PB_VOICE_ID'
      : `ELEVENLABS_${String(guestName).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_VOICE_ID`;
    return !!(await getConfig(guestKey, ''));
  } catch { return false; }
}

function providerPanel(draft) {
  return {
    text: `🎙️ <b>Voice studio</b>\n\nStandard voices record Carrie and ${podEsc(draft.guestName ?? PODCAST_GUEST)} with the usual Studio voices — the working path. ElevenLabs voices are not finishing end-to-end yet (worker synthesis still being proven), so that option stays gated until the first real podcast job proves it.`,
    reply_markup: { inline_keyboard: [
      [{ text: '🎧 Standard voices', callback_data: 'podcast:provider:standard' }],
      [{ text: '✨ ElevenLabs voices', callback_data: 'podcast:provider:elevenlabs' }],
      [{ text: '❌ Cancel', callback_data: 'podcast:cancel' }],
    ]},
  };
}

/** Generate the script draft and show the review panel (shared by the
 *  class pick and the ElevenLabs provider pick). */
async function podGenerateAndShowDraft(uid, draft, deps = {}) {
  await podSendDm(uid, '✍️ Writing your episode script…');
  try {
    const ready = await podGenerateDraftInto(uid, draft, deps);
    const panel = podDraftPanel(ready);
    await podSendDm(uid, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
  } catch (err) {
    draft.stage = 'class';
    await podSaveWiz(uid, draft);
    const ent2 = await getPodcastEntitlement(uid);
    const panel = classPanel(draft, ent2);
    await podSendDm(uid, `❌ Script generation failed — ${humanBrainErr(err)}. Pick a length to retry, or /podcast to restart.`, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
  }
}

export const PODCAST_COMMANDS = {
  podcast: async (chatId, args, msg) => {
    const uid = msg?.from?.id;
    if (!uid) return;
    if (!(await isPodcastEnabled())) {
      try { await api.sendMessage({ chat_id: chatId, text: PODCAST_PARKED_NOTICE }); } catch { /* blocked */ }
      return;
    }
    if (msg.chat?.type !== 'private') {
      await podSendDm(uid, '🎙️ Podcast Studio runs in DM — run /podcast here and we\u2019ll cut your episode step by step.').catch(() => {});
      try {
        await api.sendMessage({ chat_id: chatId, text: '🎙️ Sent you a DM — Podcast Studio builds your episode there. Run /podcast in our DM to start.' });
      } catch { /* group send failed */ }
      return;
    }
    const draft = { stage: 'topic', topic: '', guestName: PODCAST_GUEST, guestPersona: null, guestVoice: null, voiceProvider: null, lengthClass: 'short', script: null, words: 0, cost: null, fundsPreview: null, createdAt: Date.now() };
    await podSaveWiz(uid, draft);
    const jobs = await listOwnPodcastJobs(uid, 5);
    await podSendDm(uid,
      '🎙️ <b>PB Podcast Studio</b>\n\nCarrie Miller hosts <b>Crypto Real Talk</b> — PB is her usual guest, or bring a character of your own. You pick the topic, I write the interview, two voices record it, and you get a vertical, fully-subtitled episode.\n\n✏️ First: what should this episode be about? (A sentence or two — a launch, a lesson, your project\u2019s story.)'
      + (jobs.length ? `\n\n<b>Your recent episodes:</b>\n${jobs.map(renderPodcastJobLine).join('\n')}` : ''),
      { parse_mode: 'HTML' });
  },
};

/** Text-step capture for the wizard. Returns true when consumed. */
export async function handlePodcastWizardText(chatId, user, text, deps = {}) {
  if (!user?.id || !text || text.startsWith('/')) return false;
  if (String(chatId) !== String(user.id)) return false; // DM only
  if (!(await isPodcastEnabled())) return false;
  const draft = await podLoadWiz(user.id);
  if (!draft) {
    // Gap-3: an edit left armed past the session TTL gets the expired
    // answer — never a silent commit (the draft is simply gone).
    try {
      const raw = await getConfig(podWizKey(user.id), null);
      const stale = raw ? JSON.parse(raw) : null;
      if (stale?.stage === 'edit' && stale.createdAt) {
        await podClearWiz(user.id);
        await podSendDm(user.id, '⏳ That draft expired — run /podcast again to pick it back up. Nothing was created or charged.');
        return true;
      }
    } catch { /* fall through */ }
    return false;
  }
  if (draft.stage === 'edit') {
    // Whole-script replace, vetted exactly like a generated script
    // (claim guard → both-voices format → parked-site rewrite → word
    // budget). On any refusal the draft survives for another edit.
    const vet = await vetEditedPodcastScript(text, draft.lengthClass, draft.guestName);
    if (!vet.ok) {
      await podSendDm(user.id, `✏️ That edit didn't land — ${vet.error}\n\nYour current draft is unchanged. Send a fixed version, or use the buttons on the review message to keep the current script or cancel.`);
      return true;
    }
    draft.script = vet.script;
    draft.words = vet.words;
    draft.stage = 'draft';
    await podSaveWiz(user.id, draft);
    const panel = podDraftPanel(draft);
    await podSendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    return true;
  }
  const value = String(text).trim().slice(0, 1000);
  if (!value) return false;

  if (draft.stage === 'topic') {
    draft.topic = value.slice(0, 400);
    draft.stage = 'guest_choice';
    await podSaveWiz(user.id, draft);
    const panel = guestChoicePanel(draft);
    await podSendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    return true;
  }
  if (draft.stage === 'guest_name') {
    const name = value.replace(/[:\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!name || /^pb$/i.test(name) || /^carrie/i.test(name)) {
      await podSendDm(user.id, '🎙️ That name won\'t work — Carrie hosts and PB is the default guest, so pick a different name for your character (letters, numbers and spaces, up to 30 characters).');
      return true;
    }
    draft.guestName = name;
    draft.stage = 'guest_persona';
    await podSaveWiz(user.id, draft);
    await podSendDm(user.id, `🎙️ <b>${podEsc(name)}</b> it is. Now describe them in a sentence or two — who they are, what they're about, how they talk. Carrie interviews them in character.`, { parse_mode: 'HTML' });
    return true;
  }
  if (draft.stage === 'guest_persona') {
    draft.guestPersona = value.slice(0, 240);
    draft.stage = 'guest_voice';
    await podSaveWiz(user.id, draft);
    const panel = guestVoicePanel(draft);
    await podSendDm(user.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    return true;
  }
  return false;
}

/** Button router for `podcast:*` callbacks. Caller answers the query. */
export async function handlePodcastCallback({ userId, data, messageId }, deps = {}) {
  const uid = userId;
  const sub = data.slice('podcast:'.length);
  if (!(await isPodcastEnabled())) return { text: '🎙️ Podcast Studio is parked right now.', alert: true };
  const draft = await podLoadWiz(uid);
  if (!draft && sub !== 'jobs') return { text: '⏳ Podcast session expired — run /podcast again.', alert: true };

  if (sub === 'cancel') {
    await podClearWiz(uid);
    await podEditPanel(uid, messageId, '❌ Podcast session cancelled. Nothing was charged.');
    return { text: 'Cancelled' };
  }
  if (sub === 'jobs') {
    const jobs = await listOwnPodcastJobs(uid, 10);
    await podSendDm(uid, jobs.length
      ? `🎙️ <b>Your podcast episodes</b>\n\n${jobs.map(renderPodcastJobLine).join('\n')}`
      : '🎙️ No episodes yet — run /podcast to cut your first one.', { parse_mode: 'HTML' });
    return { text: undefined };
  }
  if (sub === 'guest:default') {
    draft.guestName = PODCAST_GUEST;
    draft.guestPersona = null;
    draft.guestVoice = null;
    draft.stage = 'class';
    await podSaveWiz(uid, draft);
    const ent = await getPodcastEntitlement(uid);
    const panel = classPanel(draft, ent);
    await podEditPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: '🤖 PB takes the guest seat' };
  }
  if (sub === 'guest:custom') {
    draft.stage = 'guest_name';
    await podSaveWiz(uid, draft);
    await podEditPanel(uid, messageId,
      '🎙️ <b>Your guest character</b>\n\nWhat\u2019s their name? Send it as your next message — it\u2019s how Carrie introduces them and how their lines are labelled.');
    return { text: '✨ Send your guest\u2019s name' };
  }
  if (sub.startsWith('voice:')) {
    const key = sub.slice('voice:'.length);
    if (!PODCAST_GUEST_VOICES[key]) return { text: 'Unknown voice.', alert: true };
    draft.guestVoice = key;
    draft.stage = 'class';
    await podSaveWiz(uid, draft);
    const ent = await getPodcastEntitlement(uid);
    const panel = classPanel(draft, ent);
    await podEditPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: `🎙️ Voice set — ${PODCAST_GUEST_VOICES[key]}` };
  }
  if (sub.startsWith('class:')) {
    const key = sub.slice('class:'.length);
    if (!PODCAST_CLASSES[key]) return { text: 'Unknown length.', alert: true };
    const ent = await getPodcastEntitlement(uid);
    const gate = podcastGate(ent.tier, key);
    if (!gate.ok) return { text: gate.reason, alert: true };
    draft.lengthClass = key;
    await podSaveWiz(uid, draft);
    // ElevenLabs option: only when configured (else it does not exist).
    if (await podcastElevenLabsConfigured(draft.guestName)) {
      draft.stage = 'provider';
      await podSaveWiz(uid, draft);
      const panel = providerPanel(draft);
      await podEditPanel(uid, messageId, panel.text, panel.reply_markup);
      return { text: '🎧 Pick the voice studio' };
    }
    await podGenerateAndShowDraft(uid, draft, deps);
    return { text: undefined };
  }
  if (sub.startsWith('provider:')) {
    const choice = sub.slice('provider:'.length);
    if (choice !== 'standard' && choice !== 'elevenlabs') return { text: 'Unknown voices.', alert: true };
    // Re-check the gate at pick time: config removed mid-wizard closes
    // the option again rather than writing an unrenderable job.
    if (choice === 'elevenlabs' && !(await podcastElevenLabsConfigured(draft.guestName))) {
      return { text: 'ElevenLabs voices are not configured right now.', alert: true };
    }
    // Wizard-fix gate (2026-10-27): worker-side ElevenLabs synthesis is
    // unfinished, so the button must not accept the job even when the
    // bot-side keys are configured. The draft stays at provider stage
    // and Standard remains the working path.
    if (choice === 'elevenlabs') {
      return { text: 'ElevenLabs voices are not finishing end-to-end yet — worker synthesis is still being proven. Standard voices are the working path.', alert: true };
    }
    draft.voiceProvider = choice === 'elevenlabs' ? 'elevenlabs' : null;
    await podSaveWiz(uid, draft);
    await podGenerateAndShowDraft(uid, draft, deps);
    return { text: choice === 'elevenlabs' ? '✨ ElevenLabs voices' : '🎧 Standard voices' };
  }
  if (sub === 'regen') {
    if (draft.stage !== 'draft') return { text: 'No draft to regenerate yet.', alert: true };
    try {
      const ready = await podGenerateDraftInto(uid, draft, deps);
      const panel = podDraftPanel(ready);
      await podEditPanel(uid, messageId, panel.text, panel.reply_markup);
    } catch (err) {
      return { text: `❌ Regeneration failed — ${humanBrainErr(err)}.`, alert: true };
    }
    return { text: '🔄 New script drafted' };
  }
  if (sub === 'edit') {
    if (draft.stage !== 'draft' || !draft.script) return { text: 'Review a script draft first.', alert: true };
    draft.stage = 'edit';
    await podSaveWiz(uid, draft);
    const cls = PODCAST_CLASSES[draft.lengthClass] ?? PODCAST_CLASSES.short;
    await podEditPanel(uid, messageId,
      `✏️ <b>Edit your episode script</b>\n\nSend the full replacement script as your next message — keep the "Carrie Miller:" and "${podEsc(draft.guestName ?? PODCAST_GUEST)}:" labels so the two voices stay straight. Your words go through the same claim check as a generated script, and the ${cls.words}-word budget for a ${cls.label} episode still applies. I'll show the result back here for a final approve — nothing is created or charged until you approve.`,
      { inline_keyboard: [
        [{ text: '↩️ Keep current script', callback_data: 'podcast:editback' }],
        [{ text: '❌ Cancel', callback_data: 'podcast:cancel' }],
      ]});
    return { text: '✏️ Send the new script' };
  }
  if (sub === 'editback') {
    if (draft.stage !== 'edit') return { text: undefined };
    draft.stage = 'draft';
    await podSaveWiz(uid, draft);
    const panel = podDraftPanel(draft);
    await podEditPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: '↩️ Kept your script' };
  }
  if (sub === 'approve') {
    if (draft.stage !== 'draft' || !draft.script) return { text: 'Review a script draft first.', alert: true };
    try {
      const { job } = await createPodcastJob(uid, {
        topic: draft.topic, lengthClass: draft.lengthClass,
        guest: { name: draft.guestName, persona: draft.guestPersona, voice: draft.guestVoice },
        voiceProvider: draft.voiceProvider ?? null,
      }, { script: draft.script });
      await podClearWiz(uid);
      const fundsLabel = `${job.costCredits} credits reserved (${job.fundsSource}: ${job.includedPart} included + ${job.purchasedPart} purchased)`;
      await podEditPanel(uid, messageId,
        `✅ <b>Episode created!</b>\n\n🎙️ ${podEsc(job.title)} · ${PODCAST_CLASSES[draft.lengthClass].label}\n💳 ${fundsLabel}\n📌 Status: ${job.status} — recording starts shortly; I\u2019ll DM you the episode here when it\u2019s ready.\n\nJob: ${job.id}`);
      return { text: '✅ Episode created' };
    } catch (err) {
      return { text: String(err?.message ?? 'Could not create the episode.').slice(0, 190), alert: true };
    }
  }
  if (sub.startsWith('canceljob:')) {
    const jobId = sub.slice('canceljob:'.length);
    try {
      const { job } = await cancelPodcastJob(uid, jobId);
      return { text: `🚫 Episode ${job.id} cancelled — reservation refunded.`, alert: true };
    } catch (err) {
      return { text: String(err?.message ?? 'Cancel failed.').slice(0, 190), alert: true };
    }
  }
  return { text: undefined };
}

// ── Recurring podcast series (2026-11-04, Rowdy's "let's do it") ──────────
// Shared spine, both tracks (spec PB-SPEC-recurring-podcast-2026-11-04):
// series record → per-round FRESH research → script (prior angles
// excluded) → render with podcast voices → deliver on schedule, driven
// by the per-minute tick (cyclePodcastSeries, registered in lib/tick.js).
// A series never repeats an angle: each round's prompt carries the prior
// angles and the assigned angle is recorded on success.
//
// Storage: config-state pattern (like the podcast wizard) — one JSON row
// per series (`podcast_series:<id>`) + one index row
// (`podcast_series:index`, array of ids in creation order). Series are
// few (one PB show + a handful of customer subscriptions); no new table,
// no schema change, no new module.
//
// Flags (all default OFF / unset — nothing runs until Rowdy arms it):
//   podcast_series_enabled — the tick engine itself.
//   podcast_show_enabled — Track 1 pilot gate: the PB show series stays
//     due-but-skipped until Rowdy approves the sample episode.
//   podcast_series_cost_credits — Track 2 one-time series purchase price
//     in credits (Rowdy's number; UNSET = purchase refused, no price
//     invented). Episodes additionally cost their normal per-episode
//     credits from the shared Studio bank (PODCAST_CLASSES).
//
// Failure rule (video-ad job rule): any round step fails → the round is
// marked failed WITH the reason on the series row, the owner is DM'd at
// most once per 24h, the schedule still advances (no hot loop, no silent
// spinner). A failed round reserves nothing: createPodcastJob throws
// BEFORE writing rows on a funds refusal, so there is no reservation to
// refund. A failed RENDER refunds exactly once via the existing
// refundPodcastJob path (applyPodcastTerminal).
//
// VOICE GATE (2026-11-04, BLOCKED — see wave plan): the stored
// ElevenLabs voice IDs do NOT match the reference episode voices
// (measured F0 gaps 42/47 Hz vs 0–2 Hz same-voice control), and the
// stored key lacks voices_read so the account list cannot be enumerated.
// Series episodes render with the working path (standard Gemini voices)
// until the gate passes; the ElevenLabs option stays behind its existing
// wizard-fix gate and is never force-selected here.

const podSeriesIndexKey = 'podcast_series:index';
const podSeriesKey = (id) => `podcast_series:${id}`;
const PODCAST_SERIES_MAX_PER_TICK = 3;
const PODCAST_SERIES_FIRST_RUN_MS = 60 * 60 * 1000; // first episode 1h after purchase
const PODCAST_SERIES_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PODCAST_SERIES_MAX_PRIOR_ANGLES = 20;
// Official PoorBoyAI ADs Channel — the fallback only; the config override
// kit_ads_channel_id wins when set (source of truth: KIT_ADS_CHANNEL_ID
// in lib/opscmds.js).
const PODCAST_SHOW_ADS_CHANNEL_FALLBACK = '-1003703317130';

function podSeriesMintId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'pds_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function isPodcastSeriesEnabled() {
  try { return await getConfigFlag('podcast_series_enabled'); } catch { return false; }
}

export async function isPodcastShowEnabled() {
  try { return await getConfigFlag('podcast_show_enabled'); } catch { return false; }
}

/** Track 2 series price in credits, or null when Rowdy hasn't set it. */
export async function podcastSeriesPrice() {
  try {
    const raw = await getConfig('podcast_series_cost_credits', null);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch { return null; }
}

async function podSeriesIndexLoad() {
  try {
    const raw = await getConfig(podSeriesIndexKey, null);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch { return []; }
}

async function podSeriesIndexSave(ids) {
  await setConfig(podSeriesIndexKey, JSON.stringify([...new Set(ids)])).catch(() => {});
}

/** Validate a stored series row into canonical shape (bad rows → null). */
export function normalizePodcastSeries(raw) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || typeof s !== 'object') return null;
    const id = String(s.id ?? '');
    if (!/^pds_[0-9a-f]{16}$/.test(id)) return null;
    const track = s.track === 'show' ? 'show' : 'customer';
    const topic = String(s.topic ?? '').trim().slice(0, 400);
    if (!topic) return null;
    const guest = normalizePodcastGuest({ name: s.guestName, persona: s.guestPersona, voice: s.guestVoice });
    const lengthClass = PODCAST_CLASSES[s.lengthClass] ? s.lengthClass : 'standard';
    const cadenceDays = Math.min(30, Math.max(1, Number(s.cadenceDays) || 7));
    return {
      id, track,
      ownerId: String(s.ownerId ?? ''),
      topic, guestName: guest.name, guestPersona: guest.persona, guestVoice: guest.voice,
      voiceProvider: s.voiceProvider === 'elevenlabs' ? 'elevenlabs' : null,
      lengthClass, cadenceDays,
      nextRunAt: Number(s.nextRunAt) || 0,
      lastRunAt: Number(s.lastRunAt) || 0,
      episodeCount: Number(s.episodeCount) || 0,
      priorAngles: Array.isArray(s.priorAngles) ? s.priorAngles.map(String).filter(Boolean).slice(-PODCAST_SERIES_MAX_PRIOR_ANGLES) : [],
      status: s.status === 'paused' || s.status === 'ended' ? s.status : 'active',
      lastError: s.lastError ? String(s.lastError).slice(0, 300) : null,
      lastNotifiedAt: Number(s.lastNotifiedAt) || 0,
      pricePaid: Number(s.pricePaid) || 0,
      createdAt: Number(s.createdAt) || 0,
    };
  } catch { return null; }
}

export async function getPodcastSeries(id) {
  try {
    const raw = await getConfig(podSeriesKey(id), null);
    return raw ? normalizePodcastSeries(raw) : null;
  } catch { return null; }
}

export async function savePodcastSeries(series) {
  const s = normalizePodcastSeries(series);
  if (!s) throw new Error('Invalid podcast series record.');
  await setConfig(podSeriesKey(s.id), JSON.stringify(s));
  const ids = await podSeriesIndexLoad();
  if (!ids.includes(s.id)) await podSeriesIndexSave([...ids, s.id]);
  return s;
}

export async function listOwnPodcastSeries(tgId) {
  const ids = await podSeriesIndexLoad();
  const out = [];
  for (const id of ids) {
    const s = await getPodcastSeries(id);
    if (s && String(s.ownerId) === String(tgId)) out.push(s);
  }
  return out;
}

async function podSeriesIsOwner(uid) {
  return (await ownerIdSet().catch(() => new Set())).has(String(uid));
}

/**
 * Create a series. Track 'show' is owner-only (Rowdy's show); track
 * 'customer' charges the one-time series price from the buyer's
 * PURCHASED wallet balance (included allowance never pays for the
 * series itself — episodes draw it later, per episode, as usual).
 * Exactly-once: the purchase ledger row is refId-keyed; a replayed
 * create with the same opts.seriesId returns the existing series and
 * charges nothing again.
 */
export async function createPodcastSeries(ownerId, params = {}, opts = {}) {
  const uid = String(ownerId ?? '');
  if (!uid) throw new Error('A series needs an owner.');
  const track = params.track === 'show' ? 'show' : 'customer';
  if (track === 'show' && !(await podSeriesIsOwner(uid))) {
    throw new Error('Only Rowdy can create the PB show series.');
  }
  const topic = String(params.topic ?? '').trim().slice(0, 400);
  if (!topic) throw new Error('A series topic is required.');
  const guest = normalizePodcastGuest(params.guest);
  const lengthClass = PODCAST_CLASSES[params.lengthClass] ? params.lengthClass : 'standard';
  const cadenceDays = Math.min(30, Math.max(1, Number(params.cadenceDays) || 7));
  const voiceProvider = params.voiceProvider === 'elevenlabs' ? 'elevenlabs' : null;
  if (voiceProvider === 'elevenlabs' && !(await podcastElevenLabsConfigured(guest.name))) {
    throw new Error('ElevenLabs voices are not configured for this guest — pick standard voices.');
  }
  const id = opts.seriesId ? String(opts.seriesId) : podSeriesMintId();
  if (!/^pds_[0-9a-f]{16}$/.test(id)) throw new Error('Invalid series id.');
  const existing = await getPodcastSeries(id);
  if (existing) return { series: existing, replay: true };

  let pricePaid = 0;
  if (track === 'customer') {
    const price = await podcastSeriesPrice();
    if (price === null) {
      throw new Error('Podcast series pricing is not set yet — Rowdy sets the series price before subscriptions open.');
    }
    const ent = await getPodcastEntitlement(uid);
    if (ent.ownerUnlimited) {
      pricePaid = 0; // owner series never pay (same ledger safety as Studio)
    } else {
      if (ent.wallet < price) {
        throw new Error(`A podcast series costs ${price} credits — your purchased balance is ${ent.wallet}. Top up first; nothing was charged.`);
      }
      const refId = `podcast_series:${id}:purchase`;
      if (!(await podLedgerRowByRef(refId))) {
        await db.insert(credit_ledger).values({
          userKey: podUserKeyFor(uid),
          amount: -price,
          kind: 'podcast_series_purchase',
          purpose: 'podcast_series',
          refId,
        }).run();
      }
      pricePaid = price;
    }
  }

  const now = Date.now();
  const series = {
    id, track, ownerId: uid, topic,
    guestName: guest.name, guestPersona: guest.persona, guestVoice: guest.voice,
    voiceProvider, lengthClass, cadenceDays,
    nextRunAt: now + PODCAST_SERIES_FIRST_RUN_MS,
    lastRunAt: 0, episodeCount: 0, priorAngles: [],
    status: 'active', lastError: null, lastNotifiedAt: 0,
    pricePaid, createdAt: now,
  };
  await savePodcastSeries(series);
  return { series, replay: false };
}

export async function pausePodcastSeries(uid, id) {
  const s = await getPodcastSeries(id);
  if (!s || (String(s.ownerId) !== String(uid) && !(await podSeriesIsOwner(uid)))) {
    throw new Error('Series not found.');
  }
  if (s.status !== 'active') throw new Error(`Series is already ${s.status}.`);
  s.status = 'paused';
  await savePodcastSeries(s);
  return { series: s };
}

export async function resumePodcastSeries(uid, id) {
  const s = await getPodcastSeries(id);
  if (!s || (String(s.ownerId) !== String(uid) && !(await podSeriesIsOwner(uid)))) {
    throw new Error('Series not found.');
  }
  if (s.status !== 'paused') throw new Error(`Series is ${s.status} — only a paused series can resume.`);
  s.status = 'active';
  if (!s.nextRunAt || s.nextRunAt < Date.now()) s.nextRunAt = Date.now() + PODCAST_SERIES_FIRST_RUN_MS;
  await savePodcastSeries(s);
  return { series: s };
}

/** Track 1 delivery targets: home community + ads channel (ids only). */
export async function podShowTargets() {
  const out = [];
  try {
    const home = String((await getConfig('TELEGRAM_HOME_CHAT_ID', '')) ?? '').trim();
    if (home) out.push(home);
  } catch { /* none */ }
  try {
    const ads = String((await getConfig('kit_ads_channel_id', '')) ?? '').trim() || PODCAST_SHOW_ADS_CHANNEL_FALLBACK;
    if (ads) out.push(ads);
  } catch { out.push(PODCAST_SHOW_ADS_CHANNEL_FALLBACK); }
  return [...new Set(out)];
}

/**
 * Fresh-research step for one round (brain ladder via askLLM, same as
 * script generation). Returns { angle, research }; on ANY failure it
 * returns nulls and the round proceeds with prior-angles exclusion
 * only — research enriches a round, it never blocks one. The angle is
 * one line; the facts are short and verifiable, never invented numbers.
 */
export async function podResearchRound(topic, priorAngles, deps = {}) {
  const ask = deps.ask || askLLM;
  const prior = (priorAngles ?? []).filter(Boolean).slice(-PODCAST_SERIES_MAX_PRIOR_ANGLES);
  try {
    const res = await ask({
      systemPrompt: 'You are a research assistant for the PoorBoyAI podcast Crypto Real Talk. Propose ONE fresh angle and a few fresh, specific, verifiable facts. Never invent prices, metrics, holder counts, or returns. If you do not know something, say so instead of guessing.',
      userMessage: [
        `Topic: ${String(topic ?? '').slice(0, 400)}`,
        prior.length ? `Angles already covered (do NOT repeat any):\n${prior.map((a) => `- ${String(a).slice(0, 160)}`).join('\n')}` : 'No angles covered yet — propose the strongest opening angle.',
        'Reply exactly in this shape:\nANGLE: <one line, the fresh angle>\nFACTS:\n- <fact>\n- <fact>',
      ].join('\n\n'),
      history: [],
      maxOutputTokens: 600,
    });
    const text = String(res?.text ?? res ?? '');
    const angleMatch = /ANGLE:\s*(.+)/i.exec(text);
    const factsMatch = /FACTS:\s*([\s\S]+)/i.exec(text);
    return {
      angle: angleMatch ? angleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 300) : null,
      research: factsMatch ? factsMatch[1].trim().slice(0, 2000) : null,
    };
  } catch { return { angle: null, research: null }; }
}

/**
 * One due round for one series: fresh research → script (prior angles
 * excluded) → episode job via the existing one-off path (funds, gates,
 * reserve, refund rules all ride along untouched). Returns
 * { ok: true, jobId } or { ok: false, error }. The caller owns the
 * schedule claim; this function only records the round outcome.
 */
export async function podSeriesRound(series, deps = {}) {
  const s = normalizePodcastSeries(series);
  if (!s) return { ok: false, error: 'Invalid series record.' };
  const guest = normalizePodcastGuest({ name: s.guestName, persona: s.guestPersona, voice: s.guestVoice });
  try {
    const research = await podResearchRound(s.topic, s.priorAngles, deps);
    const angle = research.angle || `Episode ${s.episodeCount + 1}: a fresh angle on ${s.topic}`;
    const { script } = await generatePodcastScript({
      topic: s.topic, lengthClass: s.lengthClass, guest,
      priorAngles: s.priorAngles, angle, research: research.research,
    }, deps);
    const extra = s.track === 'show' ? { showTargets: await podShowTargets() } : null;
    const { job } = await createPodcastJob(s.ownerId, {
      topic: s.topic, lengthClass: s.lengthClass,
      guest: { name: s.guestName, persona: s.guestPersona, voice: s.guestVoice },
      voiceProvider: s.voiceProvider ?? null,
    }, { script, storyboardExtra: extra });
    s.priorAngles = [...s.priorAngles, angle].slice(-PODCAST_SERIES_MAX_PRIOR_ANGLES);
    s.episodeCount += 1;
    s.lastRunAt = Date.now();
    s.lastError = null;
    await savePodcastSeries(s);
    return { ok: true, jobId: job.id, angle };
  } catch (err) {
    const msg = String(err?.message ?? 'Round failed.').slice(0, 300);
    s.lastError = msg;
    await savePodcastSeries(s).catch(() => {});
    return { ok: false, error: msg };
  }
}

async function podSeriesNotifyFailure(series, error) {
  const now = Date.now();
  if (now - (series.lastNotifiedAt || 0) < PODCAST_SERIES_NOTIFY_COOLDOWN_MS) return;
  const next = series.nextRunAt ? new Date(series.nextRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'next round';
  const who = series.track === 'show' ? 'the PB show' : 'your podcast series';
  await podSendDm(series.ownerId,
    `🎙️ ${who} "${series.topic}" missed a round: ${error}\nNothing was charged for the missed episode. Next round: ${next} UTC. ${series.track === 'customer' ? 'Top up credits if the failure was funds, or run /podcastseries to check it.' : ''}`).catch(() => {});
  const fresh = await getPodcastSeries(series.id);
  if (fresh) { fresh.lastNotifiedAt = now; await savePodcastSeries(fresh).catch(() => {}); }
}

/**
 * Tick cycle: drive due series rounds. Flag-gated (podcast_series_enabled);
 * the show track additionally needs podcast_show_enabled (pilot gate) —
 * a gated show series stays due but untouched (no brain calls, no
 * schedule advance). Claim-first: each due series' nextRunAt advances
 * BEFORE its round runs, so a retrying tick can never double-create an
 * episode for one round. Never throws (counts, not errors).
 */
export async function cyclePodcastSeries(deps = {}) {
  try {
    if (!(await isPodcastSeriesEnabled())) return { enabled: false };
  } catch { return { enabled: false }; }
  const now = Date.now();
  const ids = await podSeriesIndexLoad();
  let checked = 0, due = 0, created = 0, failed = 0, skipped = 0;
  const errors = [];
  for (const id of ids) {
    const s = await getPodcastSeries(id);
    if (!s || s.status !== 'active') continue;
    checked++;
    if ((s.nextRunAt || 0) > now) continue;
    if (s.track === 'show' && !(await isPodcastShowEnabled())) { skipped++; continue; }
    due++;
    if (created + failed >= PODCAST_SERIES_MAX_PER_TICK) { skipped++; continue; }
    s.nextRunAt = now + s.cadenceDays * 86400_000;
    await savePodcastSeries(s).catch(() => {});
    const r = await podSeriesRound(s, deps);
    if (r.ok) created++;
    else {
      failed++;
      errors.push(`${s.id}: ${r.error}`);
      await podSeriesNotifyFailure(s, r.error);
    }
  }
  return { enabled: true, checked, due, created, failed, skipped, errors: errors.slice(0, 3) };
}

function podSeriesLine(s) {
  const next = s.nextRunAt ? new Date(s.nextRunAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
  return `${s.status === 'active' ? '🎙️' : '⏸️'} ${s.id} · ${s.track === 'show' ? 'PB show' : 'customer'} · "${s.topic}" · ${s.lengthClass} · every ${s.cadenceDays}d · ${s.episodeCount} eps · next ${next} UTC${s.lastError ? ` · ❌ ${s.lastError}` : ''}`;
}

/** /podcastseries — list / create / pause / resume. DM-only (buyer + owner data). */
export const PODCAST_SERIES_COMMANDS = {
  podcastseries: async (chatId, args, msg) => {
    const uid = msg?.from?.id;
    if (!uid) return;
    if (String(chatId) !== String(uid)) {
      try { await api.sendMessage({ chat_id: chatId, text: '🎙️ Podcast series live in DM — run /podcastseries there.' }); } catch { /* ignore */ }
      return;
    }
    if (!(await isPodcastEnabled())) {
      try { await api.sendMessage({ chat_id: chatId, text: PODCAST_PARKED_NOTICE }); } catch { /* ignore */ }
      return;
    }
    const reply = async (text) => {
      try { await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: 'HTML' }); } catch { /* DM closed */ }
    };
    const rest = (args ?? []).join(' ').trim();
    const [sub, ...tail] = rest.split(/\s+/);
    if (!sub || sub === 'list') {
      const mine = await listOwnPodcastSeries(uid);
      const price = await podcastSeriesPrice();
      await reply(mine.length
        ? `🎙️ <b>Your podcast series</b>\n\n${mine.map(podSeriesLine).join('\n')}\n\nCreate: <code>/podcastseries create Your topic | Guest Name</code> — ${price === null ? 'series pricing is not set yet' : `${price} credits one-time, then each episode costs its normal episode credits from your Studio bank`}. Pause: <code>/podcastseries pause pds_…</code> · Resume: <code>/podcastseries resume pds_…</code>`
        : `🎙️ <b>Podcast series</b>\n\nNo series yet. A series is a recurring show: Carrie hosts, fresh research every round, a new episode on schedule, delivered to your DMs.\n\nCreate: <code>/podcastseries create Your topic | Guest Name</code> — ${price === null ? 'series pricing is not set yet' : `${price} credits one-time, then each episode costs its normal episode credits from your Studio bank`}. PB is the default guest; name your own character after the |.`);
      return;
    }
    if (sub === 'create') {
      const isShow = tail[0] === 'show';
      const body = (isShow ? tail.slice(1) : tail).join(' ').trim();
      const [topicRaw, guestRaw] = body.split('|').map((x) => (x ?? '').trim());
      const topic = (topicRaw ?? '').slice(0, 400);
      if (!topic) {
        await reply('🎙️ Give the series a topic: <code>/podcastseries create Your topic</code> — or <code>/podcastseries create show Your topic</code> (Rowdy only).');
        return;
      }
      try {
        const { series, replay } = await createPodcastSeries(uid, {
          track: isShow ? 'show' : 'customer',
          topic,
          guest: guestRaw ? { name: guestRaw } : undefined,
          lengthClass: 'standard',
          cadenceDays: 7,
        });
        await reply(replay
          ? `🎙️ Series already exists:\n${podSeriesLine(series)}`
          : `✅ <b>Series created!</b>\n\n${podSeriesLine(series)}\n\nFirst episode lands about an hour from now, then every ${series.cadenceDays} days. ${series.track === 'show' ? 'The show stays pilot-gated until Rowdy approves the sample episode.' : `One-time price paid: ${series.pricePaid} credits.`}`);
      } catch (err) {
        await reply(`❌ ${podEsc(String(err?.message ?? 'Could not create the series.')).slice(0, 400)}`);
      }
      return;
    }
    if (sub === 'pause' || sub === 'resume') {
      const id = (tail[0] ?? '').trim();
      if (!/^pds_[0-9a-f]{16}$/.test(id)) {
        await reply('🎙️ Give the series id: <code>/podcastseries pause pds_…</code>');
        return;
      }
      try {
        const { series } = sub === 'pause' ? await pausePodcastSeries(uid, id) : await resumePodcastSeries(uid, id);
        await reply(`${sub === 'pause' ? '⏸️ Paused' : '▶️ Resumed'}:\n${podSeriesLine(series)}`);
      } catch (err) {
        await reply(`❌ ${podEsc(String(err?.message ?? 'Could not update the series.')).slice(0, 300)}`);
      }
      return;
    }
    await reply('🎙️ Usage: <code>/podcastseries</code> (list) · <code>/podcastseries create Topic | Guest</code> · <code>/podcastseries pause pds_…</code> · <code>/podcastseries resume pds_…</code>');
  },
};
