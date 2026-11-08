// lib/decide.js — PB's own decision layer ("our own Jev", built in-house).
//
// Spec: PB-DECISION-LAYER-DESIGN.md. One cheap, tightly-constrained model
// call answers a batch of TYPED questions (Choice / Score / Noul) against a
// compact state snapshot, and every call — success, failure, shadow,
// kill-switch — is written to decision_log. The log is the calibration
// asset: a general model's self-reported confidence is never trusted, only
// measured (see endpoints/decideReport.js).
//
// Hard rules baked in here:
//  - decide() NEVER throws. Any failure → { ok:false } and the caller uses
//    its incumbent behavior. A dead decision layer degrades PB to today's PB.
//  - Strict parse: full-string JSON after fence-stripping; every question
//    answered exactly once; values validated against the set. ANY violation
//    → ok:false, reason 'parse'. No partial answers, ever.
//  - Shadow-first: a set can only return non-shadow answers when the owner
//    has explicitly set decide_live_<setId>='1' in config (and the shadow
//    flag is not also on). Everything ships shadow or off.
//  - Kill switches: decide_off_all / decide_off_<setId> in the config table
//    stop the layer without a deploy (the short-circuit is still logged).
//  - Class N (money, admin, tier grants, MCP keys, moderation, winner
//    declaration) has NO question sets and NO code path here — the layer
//    structurally cannot act on those surfaces; sets that touch their
//    territory (ticket_route) are advisory annotations for a human only.
//  - Numbers are never extracted by the model: numeric VALUES stay in code
//    (regex over the original text). Sets ask only whether/which, never
//    "copy the number".
//
// Platform rules observed: no .catch() on query builders (try/catch only),
// unix-seconds comparisons on timestamp columns, no AbortController /
// setTimeout / clearTimeout (timeouts ride askLLM's guarded timers).

import db, { eq, lt, ne, and, or, like, desc, sql } from 'sdk/db';
import { decision_log, decision_memory } from '../schema.js';
import { getConfig, setConfig, getConfigFlag } from './config.js';
import { askLLM } from './llm.js';

// ── Question-set registry (data only — bump `version` on ANY wording change)

// The NL classifier's current action space (mirrors nlcmd.js normalizeIntent
// + 'other'). DP-1/DP-2: intent + slot presence in ONE batched call.
const NL_INTENT_ACTIONS = [
  'create_alert', 'create_watch', 'create_agent', 'list_jobs', 'stop_job',
  'token_scan', 'price_check', 'community_stats', 'my_rank', 'global_standings',
  'ta_overview', 'rsi_check', 'macd_check', 'bollinger_check', 'hot_gems',
  'wallet_lookup', 'security_scan', 'my_points', 'my_tier', 'my_wallet',
  'holder_status', 'my_alerts', 'my_watched', 'my_invite', 'my_digest',
  'business_status', 'group_leaderboard', 'my_squad', 'contest_status',
  'global_stats', 'featured_gems', 'post_writer', 'debate', 'moon_moment',
  'none',
];

// The 31-skill registry names (lib/skills.js SKILLS) — DP-3 routing targets.
const SKILL_ROUTE_NAMES = [
  'price_check', 'ta_overview', 'rsi_check', 'macd_check', 'bollinger_check',
  'hot_gems', 'wallet_lookup', 'recap_today', 'token_scan', 'security_scan',
  'verdict_card', 'my_rank', 'my_points', 'my_tier', 'my_wallet',
  'holder_status', 'my_alerts', 'my_watched', 'my_invite', 'my_digest',
  'business_status', 'community_stats', 'group_leaderboard', 'my_squad',
  'contest_status', 'global_stats', 'featured_gems', 'global_standings',
  'post_writer', 'debate', 'moon_moment',
];

export const QUESTION_SETS = {
  // DP-1 + DP-2 — NL command intent + slot presence (Batch 1, SHADOW).
  nl_intent: {
    version: 1,
    floor: 0.5,
    actLine: 0.85,
    stateCap: 1200,
    sampleDefault: 100,
    questions: [
      { name: 'intent', type: 'choice', choices: [...NL_INTENT_ACTIONS, 'other'],
        ask: 'Which single action is the user asking the bot to perform? Use "none" for chit-chat or questions that request no action.' },
      { name: 'is_command', type: 'noul',
        ask: 'Is this message an instruction to the bot (rather than chit-chat or a question for a human)?' },
      { name: 'token_ref', type: 'choice', choices: ['pbai', 'address_in_text', 'named_other', 'none'],
        ask: 'Which token does the message refer to? "pbai" = the $PBAI token, "address_in_text" = a 0x contract address appears in the text, "named_other" = some other named token, "none" = no token is referred to.' },
      { name: 'direction', type: 'choice', choices: ['above', 'below', 'none'],
        ask: 'If the message sets a price condition, is the trigger above or below the target? "none" when there is no price condition.' },
      { name: 'has_target_price', type: 'noul',
        ask: 'Does the message state a specific numeric target price?' },
      { name: 'interval_hours_present', type: 'noul',
        ask: 'Does the message state a repeat interval (e.g. "every 6 hours")?' },
    ],
  },

  // DP-3 — skill routing over the 31-skill catalog (Batch 2, gated OFF).
  // gate_ack is ADVISORY only: runSkill re-checks every gate server-side.
  skill_route: {
    version: 1,
    floor: 0.5,
    actLine: 0.85,
    stateCap: 1200,
    sampleDefault: 100,
    questions: [
      { name: 'skill', type: 'choice', choices: [...SKILL_ROUTE_NAMES, 'create_flow', 'chat', 'other'],
        ask: 'Which single skill should handle this message? "create_flow" = the user wants to create an alert, watch, or agent; "chat" = no skill fits, this is conversation.' },
      { name: 'needs_group_context', type: 'noul',
        ask: 'Does answering this request require a group/community context beyond the caller\'s own account?' },
      { name: 'gate_ack', type: 'choice', choices: ['caller_clears_gate', 'caller_blocked', 'ungated', 'other'],
        ask: 'Based only on the caller tier given in the state, is the chosen skill gated for this caller? "ungated" = the skill has no tier gate. Advisory only — enforcement happens elsewhere.' },
    ],
  },

  // DP-4 — free-chat gray-zone gate (registry only; wiring is a later
  // candidate per design §5 — the clear cases stay pure code in routing.js).
  freechat_gate: {
    version: 1,
    floor: 0.5,
    actLine: 0.75,
    stateCap: 1200,
    sampleDefault: 20,
    questions: [
      { name: 'addressed_to_pb', type: 'noul',
        ask: 'Is this group message addressed to the bot PB (rather than to another member)?' },
      { name: 'wants_pb_answer', type: 'noul',
        ask: 'Is this a question or request the bot could usefully answer (rather than member banter)?' },
    ],
  },

  // DP-5 — DM support triage (registry only; the live quick-support regex
  // in routing.js is currently uncalled, so there is no call site to front
  // yet — the set is ready for the surface when it is wired).
  support_triage: {
    version: 1,
    floor: 0.5,
    actLine: 0.80,
    stateCap: 1200,
    sampleDefault: 100,
    questions: [
      { name: 'category', type: 'choice',
        choices: ['documented_howto', 'pricing_tiers', 'account_specific', 'payment_problem', 'credential', 'bug_report', 'abuse', 'other'],
        ask: 'Which support category is this message? "credential" = anything about keys, passwords, or secrets; "payment_problem" = a payment, charge, or subscription-money issue.' },
      { name: 'answerable_from_docs', type: 'noul',
        ask: 'Could a documented how-to / product answer fully resolve this (no account access needed)?' },
      { name: 'urgency', type: 'score', min: 0, max: 10,
        ask: 'Urgency from 0 (routine) to 10 (user is blocked right now / money at risk).' },
    ],
  },

  // DP-6 — FUD Shield detection (Batch 3a, gated OFF). Re-platforms the
  // ad-hoc chat-tier JSON call in fudShieldHook; windowing/cooldown stay code.
  fud_check: {
    version: 1,
    floor: 0.5,
    actLine: 0.65,
    stateCap: 2000,
    sampleDefault: 20,
    questions: [
      { name: 'is_fud', type: 'noul',
        ask: 'Are these messages coordinated FUD — fear/uncertainty/panic spreading about the token or project from multiple users?' },
      { name: 'coordination', type: 'score', min: 0, max: 10,
        ask: 'Coordination level from 0 (independent organic grumbling) to 10 (clearly orchestrated multi-user campaign).' },
      { name: 'theme', type: 'choice',
        choices: ['price_panic', 'rug_accusation', 'dev_accusation', 'fake_news', 'other'],
        ask: 'The single dominant FUD theme. "other" when there is no FUD or no dominant theme.' },
    ],
  },

  // DP-7 — community sentiment scores (Batch 3a, gated OFF). The summary
  // sentence stays generation-side; neutral % is computed in code.
  sentiment: {
    version: 1,
    floor: 0.5,
    actLine: null, // Class O — advisory display, no act line
    stateCap: 4000,
    sampleDefault: 100,
    questions: [
      { name: 'bullish_pct', type: 'score', min: 0, max: 100,
        ask: 'Percentage of the chat sentiment that is bullish (0–100).' },
      { name: 'bearish_pct', type: 'score', min: 0, max: 100,
        ask: 'Percentage of the chat sentiment that is bearish (0–100). Bullish + bearish must not exceed 100; the remainder is neutral.' },
      { name: 'heat', type: 'score', min: 0, max: 10,
        ask: 'Heat from 0 (dead quiet) to 10 (explosive): message velocity combined with emotional intensity.' },
      { name: 'mood', type: 'choice',
        choices: ['🚀 Euphoric', '📈 Bullish', '😐 Neutral', '😟 Uncertain', '📉 Bearish', '🔥 Hyped', '😤 FUD-y', 'other'],
        ask: 'The single mood label that best fits the chat overall.' },
    ],
  },

  // DP-8 — auto-translate gate (Batch 3b, gated OFF). The translation
  // itself stays a generation call; this set only decides skip vs translate.
  translate_gate: {
    version: 1,
    floor: 0.5,
    actLine: 0.90,
    stateCap: 800,
    sampleDefault: 20,
    questions: [
      { name: 'is_target_language', type: 'noul',
        ask: 'Is this message already written in the target language named in the state?' },
      { name: 'worth_translating', type: 'noul',
        ask: 'Is this a substantive message worth translating (rather than emoji, a reaction, a bare link, or noise)?' },
    ],
  },

  // DP-9 — business-bot per-message triage (Batch 3c, gated OFF).
  // suppressState: business message text is never archived — the log keeps
  // answers + confidences only (design DP-9 privacy posture, conservative
  // default until Rowdy rules otherwise).
  biz_triage: {
    version: 1,
    floor: 0.5,
    actLine: 0.90,
    stateCap: 800,
    sampleDefault: 100,
    suppressState: true,
    questions: [
      { name: 'intent', type: 'choice',
        choices: ['product_question', 'pricing', 'booking_or_order', 'complaint', 'spam', 'personal_for_owner', 'other'],
        ask: 'What does this customer message want? "spam" = unsolicited promotion, scam, or bulk junk; "personal_for_owner" = meant for the account owner personally, not the business.' },
      { name: 'needs_owner', type: 'noul',
        ask: 'Should the business owner personally see this message promptly (complaint, big order, urgent problem, personal matter)?' },
      { name: 'sentiment', type: 'score', min: -5, max: 5,
        ask: 'Customer sentiment from -5 (angry) through 0 (neutral) to +5 (delighted).' },
    ],
  },

  // DP-10 — support ticket routing (Batch 3c, gated OFF). Class O: the
  // ticket ALWAYS reaches Rowdy; this set only annotates the forward.
  ticket_route: {
    version: 1,
    floor: 0.5,
    actLine: null, // Class O — advisory header on a human-handled item
    stateCap: 1600,
    sampleDefault: 100,
    questions: [
      { name: 'category', type: 'choice',
        choices: ['payment', 'account_access', 'bug', 'howto', 'abuse_report', 'other'],
        ask: 'Which category is this support ticket?' },
      { name: 'urgency', type: 'score', min: 0, max: 10,
        ask: 'Urgency from 0 (routine) to 10 (user blocked right now / money at risk); 8+ is an emergency.' },
      { name: 'docs_answerable', type: 'noul',
        ask: 'Could the documented self-help answer fully resolve this ticket?' },
    ],
  },
};

// ── Snapshot + prompt ────────────────────────────────────────────────────────

const FIELD_CAP = 500; // per-string-field cap (design §2.4)

function capState(state) {
  const out = {};
  for (const [k, v] of Object.entries(state ?? {})) {
    if (typeof v === 'string') out[k] = v.slice(0, FIELD_CAP);
    else if (Array.isArray(v)) out[k] = v.slice(0, 30).map((x) => (typeof x === 'string' ? x.slice(0, 200) : x));
    else out[k] = v;
  }
  return out;
}

function buildSnapshot(state, set) {
  let s = JSON.stringify(capState(state));
  if (s.length > set.stateCap) s = s.slice(0, set.stateCap) + '…[truncated]';
  return s;
}

function buildPrompt(set) {
  const lines = [
    'You are a strict decision engine inside a Telegram bot. Answer ONLY with a single JSON object — no prose, no markdown, no code fences.',
    'For EVERY question below, answer with: "<name>": {"value": <answer>, "confidence": <number 0..1>}. Answer each question exactly once and include every question.',
    '- choice: "value" must be exactly one of the listed options. If none fits, use the "other" option (or "none" when listed) with low confidence.',
    '- score: "value" is a number inside the stated range.',
    '- probability: "value" is the probability that the statement is true, from 0 to 1.',
    '"confidence" is how sure you are of that answer. If you are unsure, still give your best answer but with LOW confidence — never guess confidently.',
    '',
    'Questions:',
  ];
  set.questions.forEach((q, i) => {
    if (q.type === 'choice') lines.push(`${i + 1}. "${q.name}" (choice of: ${q.choices.join(' | ')}): ${q.ask}`);
    else if (q.type === 'score') lines.push(`${i + 1}. "${q.name}" (score from ${q.min} to ${q.max}): ${q.ask}`);
    else lines.push(`${i + 1}. "${q.name}" (probability 0..1): ${q.ask}`);
  });
  lines.push('', 'Respond with ONLY the JSON object.');
  return lines.join('\n');
}

// ── Strict parse ─────────────────────────────────────────────────────────────

export function parseAnswers(set, raw) {
  let s = String(raw ?? '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length !== set.questions.length) return null;
  const out = {};
  for (const q of set.questions) {
    if (!Object.prototype.hasOwnProperty.call(obj, q.name)) return null;
    const a = obj[q.name];
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    const { value, confidence } = a;
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) return null;
    if (q.type === 'choice') {
      if (typeof value !== 'string' || !q.choices.includes(value)) return null;
    } else if (q.type === 'noul') {
      if (typeof value !== 'number' || !(value >= 0 && value <= 1)) return null;
    } else if (q.type === 'score') {
      if (typeof value !== 'number' || !(value >= q.min && value <= q.max)) return null;
    } else {
      return null;
    }
    out[q.name] = { type: q.type, value, confidence };
  }
  return out;
}

// ── Logging ──────────────────────────────────────────────────────────────────

async function writeLog(row) {
  try {
    const rows = await db.insert(decision_log).values(row).returning({ id: decision_log.id }).run();
    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.error('[decide log]', err?.message ?? err);
    return null;
  }
}

/** Caller follow-up: record what actually happened for a decide() log row.
 *  Fire-and-forget safe — a lost outcome update never breaks a handler. */
export async function recordDecisionOutcome(logId, actionTaken, extra = {}) {
  if (!logId) return;
  try {
    const set = { actionTaken: String(actionTaken ?? '').slice(0, 300) };
    if (extra.groundTruth) set.groundTruth = String(extra.groundTruth).slice(0, 32);
    if (extra.outcomeNote) set.outcomeNote = String(extra.outcomeNote).slice(0, 500);
    await db.update(decision_log).set(set).where(eq(decision_log.id, logId)).run();
  } catch (err) {
    console.error('[decide outcome]', err?.message ?? err);
  }
}

// ── Twin wave 1 (P1-15, sealed + shadow-safe) ─────────────────────────────
// These helpers are the recording side of the twin bridge. They OBSERVE and
// record only: no posture change, no retrieval-gate change, no new live
// action, no Class N path. Every row they write is status 'proposed'
// (invisible to retrieval — §5.5), label-only (never message text), and
// fail-open (a write failure degrades to today's behavior, never breaks
// chat). The reading side (surfacing proposed twin rows) is a later,
// deliberate decision — wave 1 lays the linked records, it does not open
// them to any new reader.

/** Uniform conversation-context descriptor for decide() snapshots (C3).
 *  Counts + labels only — never message text, never new I/O. Call sites
 *  put it FIRST in the state object so it survives set.stateCap
 *  truncation (buildSnapshot serializes in insertion order). */
export function twinConversation(surface, turns) {
  return {
    surface: String(surface ?? ''),
    turns: Math.max(0, Math.floor(Number(turns) || 0)),
  };
}

/** Outcome vocabulary for chat replies (C7). Failure dominates: a turn
 *  that both hedged and failed counts as failed. */
export function chatOutcomeLabel({ hedged = false, failed = false } = {}) {
  if (failed) return 'failed';
  if (hedged) return 'hedged';
  return 'answered';
}

/** Post-reply outcome hook record (C7). Writes ONE label-only proposed
 *  row: scope 'owner' for owner-DM/Mini-App turns, scope 'group' + chatId
 *  for group turns (write-only in v1, never retrieved). Callers pass a
 *  scope they already resolved — this helper never guesses identity, and
 *  it never records for a caller that could not resolve one (pass no
 *  scope → no row). 'answered' turns are deliberately NOT recorded by
 *  callers: the full answer already lives in conversation memory via
 *  saveMessage, so duplicating it here adds volume, not signal. */
export async function recordChatOutcome({ scope, chatId = null, actorId = null, outcome } = {}) {
  try {
    const label = String(outcome ?? '');
    if (!['answered', 'hedged', 'failed'].includes(label)) return { ok: false, reason: 'bad_outcome' };
    if (scope !== 'owner' && scope !== 'group') return { ok: false, reason: 'bad_scope' };
    if (scope === 'group' && chatId == null) return { ok: false, reason: 'group_needs_chat_id' };
    return await recordDecision({
      scope, chatId: chatId != null ? String(chatId) : null,
      actorId: actorId != null ? String(actorId) : null,
      topicKey: 'twin-chat-outcome',
      title: `Twin chat outcome: ${label}`,
      decision: `Chat reply outcome: ${label} (twin hook record, not a user decision)`,
      reasoning: null, source: 'chat_outcome', status: 'proposed', reasonState: 'not_stated',
    });
  } catch (err) {
    console.error('[twin chat outcome]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}

/** Config posture for a set — used by the report endpoint and callers that
 *  want to skip work cheaply. off → decide() short-circuits; live → the set
 *  may act; otherwise it computes + logs in shadow. */
export async function setPosture(questionSet) {
  try {
    // Tolerant boolean reads (lib/config.js getConfigFlag — audit F19);
    // the check ORDER and the shadow-first default are unchanged.
    if (await getConfigFlag('decide_off_all')) return 'off';
    if (await getConfigFlag(`decide_off_${questionSet}`)) return 'off';
    if (await getConfigFlag(`decide_shadow_${questionSet}`)) return 'shadow';
    if (await getConfigFlag(`decide_live_${questionSet}`)) return 'live';
    return 'shadow'; // shadow-first: unflagged sets never act
  } catch {
    return 'off'; // config unreadable → incumbent behavior, no model spend
  }
}

// ── decide() ─────────────────────────────────────────────────────────────────

export async function decide(opts = {}) {
  const startedAt = Date.now();
  const envelope = {
    ok: false, shadow: false, answers: null, layer: 'decide',
    modelUsed: null, latencyMs: 0, escalated: true, reason: null, logId: null,
  };
  try {
    const { surface, questionSet, actorId = null, chatId = null, mode = 'auto' } = opts;
    const set = QUESTION_SETS[questionSet];
    if (!set) return { ...envelope, reason: 'unknown_set', latencyMs: Date.now() - startedAt };

    const snapshot = buildSnapshot(opts.state ?? {}, set);
    // Decide-shadow wave (2026-11-05): opt-in logState. When present, the
    // durable stateJson is built from logState (code-derived labels only)
    // while the model still sees the full opts.state. Callers that pass no
    // logState get byte-identical behavior. logBase is built once, so every
    // written row (success, parse-fail, timeout, off) uses logSnapshot.
    const logSnapshot = opts.logState ? buildSnapshot(opts.logState, set) : snapshot;
    const logBase = {
      surface: String(surface ?? questionSet),
      questionSet,
      setVersion: set.version,
      chatId: chatId != null ? String(chatId) : null,
      actorId: actorId != null ? String(actorId) : null,
      stateJson: set.suppressState ? null : logSnapshot,
    };

    // Kill switches — logged so "the layer went quiet" is visible in data.
    const posture = await setPosture(questionSet);
    if (posture === 'off') {
      const logId = await writeLog({
        ...logBase, answersJson: null, layer: 'code', modelUsed: null,
        shadow: false, latencyMs: Date.now() - startedAt,
        estInputTokens: 0, estOutputTokens: 0, failureReason: 'off',
      });
      return { ...envelope, reason: 'off', layer: 'code', logId, latencyMs: Date.now() - startedAt };
    }

    const shadow = mode === 'shadow' || posture !== 'live';

    // Sampling (per-message group hooks default below 100%): a sampled-out
    // call never happens — no model spend, no log row.
    let rate = set.sampleDefault ?? 100;
    const rateCfg = await getConfig(`decide_sample_${questionSet}`, '');
    if (rateCfg !== '' && Number.isFinite(Number(rateCfg))) rate = Number(rateCfg);
    if (rate < 100 && Math.random() * 100 >= Math.max(0, rate)) {
      return { ...envelope, reason: 'sampled', layer: 'code', shadow, latencyMs: Date.now() - startedAt };
    }

    const systemPrompt = buildPrompt(set);
    const meta = {};
    let raw;
    try {
      raw = await askLLM({
        tier: 'decide',
        systemPrompt,
        userMessage: snapshot,
        maxOutputTokens: Math.min(48 + 28 * set.questions.length, 260),
        timeoutMs: 9_000,
        temperature: 0.1,
        meta,
      });
    } catch (err) {
      const msg = String(err?.message ?? err ?? '');
      const reason = /timeout|aborted|ETIMEDOUT/i.test(msg) ? 'timeout' : 'transport';
      const logId = await writeLog({
        ...logBase, answersJson: null, layer: 'decide', modelUsed: meta.modelUsed ?? null,
        shadow, latencyMs: Date.now() - startedAt,
        estInputTokens: Math.ceil((systemPrompt.length + snapshot.length) / 4),
        estOutputTokens: 0, failureReason: reason,
      });
      return { ...envelope, reason, shadow, logId, modelUsed: meta.modelUsed ?? null, latencyMs: Date.now() - startedAt };
    }

    const answers = parseAnswers(set, raw);
    const latencyMs = Date.now() - startedAt;
    if (!answers) {
      const logId = await writeLog({
        ...logBase, answersJson: null, layer: 'decide', modelUsed: meta.modelUsed ?? null,
        shadow, latencyMs,
        estInputTokens: Math.ceil((systemPrompt.length + snapshot.length) / 4),
        estOutputTokens: Math.ceil(String(raw ?? '').length / 4), failureReason: 'parse',
      });
      return { ...envelope, reason: 'parse', shadow, logId, modelUsed: meta.modelUsed ?? null, latencyMs };
    }

    const escalated = Object.values(answers).some((a) => a.confidence < set.floor);
    const logId = await writeLog({
      ...logBase, answersJson: answers, layer: 'decide', modelUsed: meta.modelUsed ?? null,
      shadow, latencyMs,
      estInputTokens: Math.ceil((systemPrompt.length + snapshot.length) / 4),
      estOutputTokens: Math.ceil(String(raw ?? '').length / 4), failureReason: null,
    });
    return {
      ok: true, shadow, answers, layer: 'decide',
      modelUsed: meta.modelUsed ?? null, latencyMs, escalated,
      reason: shadow ? 'shadow' : (escalated ? 'low_confidence' : null), logId,
    };
  } catch (err) {
    // The layer never throws into a handler.
    console.error('[decide]', err?.message ?? err);
    return { ...envelope, reason: 'transport', latencyMs: Date.now() - startedAt };
  }
}

// ── Retention: 90-day prune + per-set rollup (design §3.4) ──────────────────

const RETENTION_SEC = 90 * 24 * 3600;

export async function pruneDecisionLog() {
  const cutoffSec = Math.floor(Date.now() / 1000) - RETENTION_SEC;
  let expiring = [];
  try {
    expiring = await db.select().from(decision_log)
      .where(lt(decision_log.createdAt, cutoffSec)).all();
  } catch (err) {
    console.error('[decide prune read]', err?.message ?? err);
    return { pruned: 0, error: 'read' };
  }
  if (!expiring.length) return { pruned: 0 };
  // Roll the counts up per set + month BEFORE deleting, so calibration
  // history survives the prune (config key decide_stats_<setId>).
  const bySet = {};
  for (const r of expiring) {
    const month = new Date(Number(r.createdAt) * 1000).toISOString().slice(0, 7);
    const s = (bySet[r.questionSet] ??= { pruned: 0, months: {} });
    s.pruned++;
    s.months[month] = (s.months[month] ?? 0) + 1;
  }
  for (const [setId, roll] of Object.entries(bySet)) {
    try {
      const key = `decide_stats_${setId}`;
      let prev = {};
      try { prev = JSON.parse((await getConfig(key, '')) || '{}'); } catch { prev = {}; }
      const months = { ...(prev.months ?? {}) };
      for (const [m, n] of Object.entries(roll.months)) months[m] = (months[m] ?? 0) + n;
      await setConfig(key, JSON.stringify({ pruned: (prev.pruned ?? 0) + roll.pruned, months }));
    } catch (err) {
      console.error('[decide prune rollup]', err?.message ?? err);
    }
  }
  try {
    await db.delete(decision_log).where(lt(decision_log.createdAt, cutoffSec)).run();
  } catch (err) {
    console.error('[decide prune delete]', err?.message ?? err);
    return { pruned: 0, error: 'delete' };
  }
  return { pruned: expiring.length };
}

// ── Second Brain S1 — Temporal decision memory (PB-SECOND-BRAIN-SPEC §2) ───
// Folded here per spec §6 (no new tgcloud file). This section NEVER touches
// decision_log posture, question sets, or gate counters — it only reads
// config and writes/reads decision_memory. Everything is gated behind
// decision_memory_enabled (default OFF: an unset flag reads OFF via
// getConfigFlag); with the flag off, record/retrieve/capture are inert
// and return { ok:false, reason:'disabled' } / '' / null without DB writes.
// Sealing (spec §1.1, task requirement): v1 retrieval is OWNER-DM ONLY.
// A group context can never retrieve owner rows — retrieveDecisions()
// returns [] for any non-owner-DM caller, and recallDecisionContext()
// returns '' for any non-owner-DM caller, regardless of topic/query.
// Proposed rows are invisible to retrieval (status filter), always.
// FTS5: the schema DSL has no virtual-table declaration, so the FTS5
// index is created lazily here (CREATE VIRTUAL TABLE IF NOT EXISTS …
// USING fts5, external content over decision_memory) and every read
// falls back to LIKE when FTS creation/query is unavailable. The FTS
// table is a migrate-independent runtime artifact — see schema.js note.

const DM_SCOPES = ['owner', 'project'];
const DM_STATUSES = ['active', 'superseded', 'reversed', 'expired', 'proposed'];
const DM_SOURCES = ['owner_command', 'owner_chat', 'system_event', 'agent_loop', 'proposal', 'backfill', 'chat_outcome'];
const DM_EVIDENCE_KINDS = ['link', 'quote', 'message', 'metric', 'tx', 'file'];
const DM_SECRET_RE = /(api[_-]?key|secret|password|bearer|private[_-]?key)\s*[:=]/i;

export function normalizeTopicKey(input) {
  const slug = String(input ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || 'general';
}

function dmCap(text, n) { return String(text ?? '').slice(0, n); }

function sanitizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return null;
  const out = [];
  for (const item of evidence.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    if (!DM_EVIDENCE_KINDS.includes(item.kind)) continue;
    const ref = dmCap(item.ref ?? '', 300);
    const note = dmCap(item.note ?? '', 300);
    if (DM_SECRET_RE.test(ref) || DM_SECRET_RE.test(note)) continue; // never record secret-shaped evidence
    out.push({ kind: item.kind, ref, note });
  }
  return out.length ? out : null;
}

export async function decisionMemoryEnabled() {
  try { return await getConfigFlag('decision_memory_enabled'); } catch { return false; }
}

async function ensureDecisionMemoryFts() {
  try {
    await db.run(sql`CREATE VIRTUAL TABLE IF NOT EXISTS decision_memory_fts USING fts5(title, decision, reasoning, content='decision_memory', content_rowid='id', tokenize='porter')`);
    return true;
  } catch (err) {
    console.error('[decision_memory fts]', err?.message ?? err);
    return false;
  }
}

async function syncDecisionMemoryFts(id, row) {
  try {
    await db.run(sql`INSERT INTO decision_memory_fts(rowid, title, decision, reasoning) VALUES (${id}, ${row.title}, ${row.decision}, ${row.reasoning ?? ''})`);
  } catch { /* FTS sync is best-effort; the row itself is the record */ }
}

function dmRowToPlain(row) {
  if (!row) return null;
  // Builder rows use camelCase + Date + parsed JSON; raw FTS rows use
  // snake_case + unix seconds + JSON strings. Normalize both here.
  const tsToMs = (v) => (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v * 1000 : null));
  let evidence = row.evidenceJson ?? row.evidence_json ?? null;
  if (typeof evidence === 'string') { try { evidence = JSON.parse(evidence); } catch { evidence = null; } }
  return {
    id: row.id,
    scope: row.scope,
    chatId: row.chatId ?? row.chat_id ?? null,
    actorId: row.actorId ?? row.actor_id ?? null,
    topicKey: row.topicKey ?? row.topic_key,
    title: row.title,
    decision: row.decision,
    reasoning: row.reasoning ?? null,
    evidenceJson: evidence,
    status: row.status,
    supersedesId: row.supersedesId ?? row.supersedes_id ?? null,
    supersededById: row.supersededById ?? row.superseded_by_id ?? null,
    decisionLogId: row.decisionLogId ?? row.decision_log_id ?? null,
    source: row.source,
    reasonState: row.reasonState ?? row.reason_state ?? 'stated',
    validFromMs: tsToMs(row.validFrom ?? row.valid_from),
    validToMs: tsToMs(row.validTo ?? row.valid_to),
    createdAtMs: tsToMs(row.createdAt ?? row.created_at),
  };
}

/** Write one decision row. Never throws into a caller: failures return
 *  { ok:false, reason } and are logged. Supersession: when supersedesId
 *  names a live row, that row is marked superseded + supersededById +
 *  validTo, so the chain stays readable in both directions. */
export async function recordDecision(input = {}) {
  try {
    if (!(await decisionMemoryEnabled())) return { ok: false, reason: 'disabled' };
    const scope = String(input.scope ?? 'owner');
    if (!['owner', 'project', 'group'].includes(scope)) return { ok: false, reason: 'bad_scope' };
    const chatId = input.chatId != null ? String(input.chatId) : null;
    if (scope === 'group' && !chatId) return { ok: false, reason: 'group_needs_chat_id' };
    const status = String(input.status ?? 'active');
    if (!DM_STATUSES.includes(status)) return { ok: false, reason: 'bad_status' };
    const source = DM_SOURCES.includes(input.source) ? input.source : 'owner_chat';
    const reasonState = input.reasonState === 'not_stated' ? 'not_stated' : 'stated';
    const decision = dmCap(input.decision ?? '', 1000);
    if (!decision.trim()) return { ok: false, reason: 'empty_decision' };
    const now = new Date();
    const validFrom = input.validFrom instanceof Date ? input.validFrom
      : (typeof input.validFrom === 'number' ? new Date(input.validFrom) : now);
    const row = {
      scope,
      chatId,
      actorId: input.actorId != null ? String(input.actorId) : null,
      topicKey: normalizeTopicKey(input.topicKey ?? input.topic ?? ''),
      title: dmCap(input.title ?? decision, 300),
      decision,
      reasoning: input.reasoning != null ? dmCap(input.reasoning, 2000) : null,
      evidenceJson: sanitizeEvidence(input.evidence),
      status,
      supersedesId: input.supersedesId != null ? Number(input.supersedesId) : null,
      supersededById: null,
      decisionLogId: input.decisionLogId != null ? Number(input.decisionLogId) : null,
      source,
      reasonState,
      validFrom,
      validTo: null,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await db.insert(decision_memory).values(row).returning({ id: decision_memory.id }).run();
    const id = inserted?.[0]?.id ?? null;
    if (!id) return { ok: false, reason: 'insert_failed' };
    if (await ensureDecisionMemoryFts()) await syncDecisionMemoryFts(id, row);
    if (row.supersedesId) {
      try {
        const prev = await db.select().from(decision_memory).where(eq(decision_memory.id, row.supersedesId)).get();
        if (prev && (prev.status === 'active' || prev.status === 'proposed')) {
          await db.update(decision_memory).set({ status: 'superseded', supersededById: id, validTo: now, updatedAt: now })
            .where(eq(decision_memory.id, row.supersedesId)).run();
        }
      } catch (err) { console.error('[decision_memory supersede]', err?.message ?? err); }
    }
    return { ok: true, id, topicKey: row.topicKey };
  } catch (err) {
    console.error('[decision_memory record]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}

/** Flip a quarantined proposal to active. Caller must already be the
 *  owner (owner-DM confirm path); this function does not re-check
 *  identity — it only enforces the proposed → active transition. */
export async function confirmDecisionProposal(id) {
  try {
    if (!(await decisionMemoryEnabled())) return { ok: false, reason: 'disabled' };
    const row = await db.select().from(decision_memory).where(eq(decision_memory.id, Number(id))).get();
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'proposed') return { ok: false, reason: 'not_proposed' };
    const now = new Date();
    await db.update(decision_memory).set({ status: 'active', validFrom: now, updatedAt: now })
      .where(eq(decision_memory.id, Number(id))).run();
    return { ok: true, id: Number(id), topicKey: row.topicKey };
  } catch (err) {
    console.error('[decision_memory confirm]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}

/** Archive (expire) a row — the owner-DM soft-delete path. The row and
 *  its chain position survive; only its status changes. */
export async function expireDecision(id) {
  try {
    if (!(await decisionMemoryEnabled())) return { ok: false, reason: 'disabled' };
    const now = new Date();
    await db.update(decision_memory).set({ status: 'expired', validTo: now, updatedAt: now })
      .where(eq(decision_memory.id, Number(id))).run();
    return { ok: true, id: Number(id) };
  } catch (err) {
    console.error('[decision_memory expire]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}

function ftsQueryFromText(text) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !['why', 'did', 'the', 'and', 'for', 'was', 'are', 'our', 'with', 'that', 'this'].includes(w));
  return words.slice(0, 8).join(' OR ');
}

async function retrieveByTopic(topicKey, limit) {
  const rows = await db.select().from(decision_memory)
    .where(and(
      eq(decision_memory.topicKey, topicKey),
      ne(decision_memory.status, 'proposed'),
      or(eq(decision_memory.scope, 'owner'), eq(decision_memory.scope, 'project')),
    ))
    .orderBy(desc(decision_memory.validFrom)).limit(limit).all();
  const plains = rows.map(dmRowToPlain);
  // Chain completeness: a returned row's predecessor rides along even
  // if it fell outside the limit — the acceptance answer needs the
  // whole chain, not just the newest link.
  const have = new Set(plains.map((r) => r.id));
  for (const r of [...plains]) {
    if (r.supersedesId && !have.has(r.supersedesId)) {
      const prev = await db.select().from(decision_memory).where(eq(decision_memory.id, r.supersedesId)).get();
      if (prev && prev.status !== 'proposed') { plains.push(dmRowToPlain(prev)); have.add(prev.id); }
    }
  }
  return plains;
}

// Second Brain retrieval fallback (2026-10-30, LIKE-only: the isolate
// refuses FTS5 virtual tables, so FTS can never be the bridge). Tokenizes
// the query with the SAME stopword/length filter as ftsQueryFromText, so
// a question matches a row containing ANY of its content tokens — e.g.
// "why did we drop Stripe?" yields {drop, stripe} and finds the row whose
// decision text says "Stripe is dead", which whole-phrase LIKE can never
// match and topic derivation cannot see (the keyword is not in the topic
// key). Tokens are [a-z0-9] only after the strip, so no LIKE wildcard
// can survive into a pattern. Pure tokenization; exported for harnessing.
export function likeTokensFromText(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !['why', 'did', 'the', 'and', 'for', 'was', 'are', 'our', 'with', 'that', 'this'].includes(w))
    .slice(0, 8);
}

// Ranked tokenized-OR-LIKE: rows matching more distinct query tokens rank
// first, recency breaks ties. Substring LIKE already absorbs inflections
// (%drop% matches dropped/drops), so no stemming is applied. Candidate
// fetch is capped at 50 rows before JS ranking; the table is ~26 rows,
// and the cap keeps the fallback bounded as it grows.
export async function retrieveByTokenizedLike(query, limit) {
  const tokens = likeTokensFromText(query);
  if (!tokens.length) return [];
  const likeConds = [];
  for (const t of tokens) {
    const p = `%${t}%`;
    likeConds.push(like(decision_memory.title, p), like(decision_memory.decision, p), like(decision_memory.reasoning, p));
  }
  const rows = await db.select().from(decision_memory)
    .where(and(
      ne(decision_memory.status, 'proposed'),
      or(eq(decision_memory.scope, 'owner'), eq(decision_memory.scope, 'project')),
      or(...likeConds),
    ))
    .orderBy(desc(decision_memory.validFrom)).limit(50).all();
  const plains = rows.map(dmRowToPlain);
  const scored = plains.map((r) => {
    const hay = `${r.title ?? ''} ${r.decision ?? ''} ${r.reasoning ?? ''}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    return { r, score };
  }).filter((s) => s.score >= 1);
  scored.sort((a, b) => (b.score - a.score) || ((b.r.validFromMs ?? 0) - (a.r.validFromMs ?? 0)));
  return scored.slice(0, limit).map((s) => s.r);
}

async function retrieveByText(query, limit) {
  const ftsQuery = ftsQueryFromText(query);
  if (ftsQuery && (await ensureDecisionMemoryFts())) {
    try {
      const raw = await db.all(sql`SELECT dm.* FROM decision_memory dm JOIN decision_memory_fts ON decision_memory_fts.rowid = dm.id WHERE decision_memory_fts MATCH ${ftsQuery} AND dm.status != 'proposed' AND dm.scope IN ('owner', 'project') ORDER BY dm.valid_from DESC LIMIT ${limit}`);
      const plains = (raw ?? []).map(dmRowToPlain);
      if (plains.length) return plains;
    } catch { /* fall through to LIKE */ }
  }
  const likePattern = `%${String(query ?? '').replace(/[%_\\]/g, '').slice(0, 100)}%`;
  const rows = await db.select().from(decision_memory)
    .where(and(
      ne(decision_memory.status, 'proposed'),
      or(eq(decision_memory.scope, 'owner'), eq(decision_memory.scope, 'project')),
      or(like(decision_memory.title, likePattern), like(decision_memory.decision, likePattern), like(decision_memory.reasoning, likePattern)),
    ))
    .orderBy(desc(decision_memory.validFrom)).limit(limit).all();
  const plains = rows.map(dmRowToPlain);
  // Whole-phrase LIKE is preserved exactly as the first LIKE stage; the
  // tokenized fallback runs ONLY when it returns nothing, so every
  // previously-passing recall keeps its exact result.
  if (plains.length) return plains;
  return await retrieveByTokenizedLike(query, limit);
}

/** v1 retrieval. isOwnerDm MUST be true (owner private chat) or this
 *  returns [] — group contexts can never retrieve owner rows, and
 *  group-sealed retrieval is not opened in v1 (spec D2 default). */
export async function retrieveDecisions(opts = {}) {
  try {
    if (!(await decisionMemoryEnabled())) return [];
    if (!opts.isOwnerDm) return [];
    const limit = Math.min(Math.max(Number(opts.limit ?? 5) || 5, 1), 10);
    if (opts.topicKey) return await retrieveByTopic(normalizeTopicKey(opts.topicKey), limit);
    if (opts.query) return await retrieveByText(opts.query, limit);
    return [];
  } catch (err) {
    console.error('[decision_memory retrieve]', err?.message ?? err);
    return [];
  }
}

export function formatDecisionsForContext(rows, topicKey = null) {
  if (!rows?.length) return '';
  const sorted = [...rows].sort((a, b) => (a.validFromMs ?? 0) - (b.validFromMs ?? 0));
  const lines = [
    'Answer decision-recall questions from these recorded decisions when present; cite the date and who decided; if a row superseded an older one, tell the whole chain.',
    `RECORDED DECISIONS${topicKey ? ` on \`${topicKey}\`` : ''}:`,
  ];
  for (const r of sorted) {
    const date = r.validFromMs ? new Date(r.validFromMs).toISOString().slice(0, 10) : 'unknown date';
    const who = r.actorId ? `tg ${r.actorId}` : 'owner';
    lines.push(`- [${r.status}] ${r.title} — ${r.decision} (decided ${date}, by ${who}; reason: ${r.reasoning || 'no reason stated'})`);
    if (r.supersedesId) lines.push(`  This replaced row #${r.supersedesId}.`);
    if (r.supersededById) lines.push(`  Later replaced by row #${r.supersededById}.`);
    if (Array.isArray(r.evidenceJson)) {
      for (const ev of r.evidenceJson.slice(0, 3)) lines.push(`  Evidence (${ev.kind}): ${ev.ref}${ev.note ? ` — ${ev.note}` : ''}`);
    }
  }
  return lines.join('\n');
}

const RECALL_RE = /why (did|do|would) we|didn'?t we (decide|choose|set)|what (was|is) the call|what did we decide|why did we (reject|choose|pick|set|drop)|why is .* (off|on|disabled|blocked)/i;

export function isRecallQuestion(text) {
  return RECALL_RE.test(String(text ?? ''));
}

async function deriveTopicKey(question) {
  try {
    const rows = await db.select({ topicKey: decision_memory.topicKey }).from(decision_memory)
      .where(and(ne(decision_memory.status, 'proposed'),
        or(eq(decision_memory.scope, 'owner'), eq(decision_memory.scope, 'project'))))
      .distinct().limit(100).all();
    const qTokens = String(question ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 3).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
    // Deterministic iteration: distinct() order is unspecified, and the
    // old first-in-order tie-break made ties order-dependent. Sorting
    // makes the final fallback stable across runs.
    const topicKeys = [...new Set((rows ?? []).map((r) => r.topicKey).filter(Boolean))].sort();
    let best = null; let bestScore = 0; let bestCoverage = -1; let bestLongest = -1;
    for (const topicKey of topicKeys) {
      const tTokens = String(topicKey).split('-').filter(Boolean);
      let score = 0; let longest = 0;
      for (const tt of tTokens) {
        if (tt.length < 4) continue;
        for (const qt of qTokens) {
          if (qt === tt) { score += 1; longest = Math.max(longest, tt.length); break; }
          // Prefix matches only when the SHORTER side is >= 4 chars: a
          // 3-letter question token ("per") must never prefix-match a
          // longer topic token ("permanent"). Exact matches above are
          // unaffected, and plural handling survives ("rule" vs "rules"
          // still matches: shorter side is 4).
          if (Math.min(qt.length, tt.length) >= 4 && (qt.startsWith(tt) || tt.startsWith(qt))) {
            score += 1; longest = Math.max(longest, Math.min(qt.length, tt.length)); break;
          }
        }
      }
      const counted = tTokens.filter((tt) => tt.length >= 4).length;
      const coverage = counted ? score / counted : 0;
      // Ties break by coverage (how fully the question describes the
      // topic), then by longest matched token, then by sorted order.
      // This resolves both proven miss classes: pb-identity (1/1) beats
      // decide-shadow (1/4), and outreach-rules (1/2, "outreach" 8)
      // beats first-ask-rule (1/2, "first" 5) and decide-shadow (1/4).
      if (score > bestScore
        || (score === bestScore && (coverage > bestCoverage
          || (coverage === bestCoverage && longest > bestLongest)))) {
        bestScore = score; bestCoverage = coverage; bestLongest = longest; best = topicKey;
      }
    }
    return bestScore >= 1 ? best : null;
  } catch { return null; }
}

/** Injection-seam helper for the DM brain path. Returns '' unless the
 *  message is recall-shaped AND the caller is the owner in a DM AND
 *  the flag is on. When recall-shaped but nothing is recorded, it
 *  returns an explicit no-record block so the brain says so instead of
 *  improvising a decision (spec §1.2, no confabulation). */
export async function recallDecisionContext({ question, isOwnerDm, chatId } = {}) {
  try {
    if (!isRecallQuestion(question)) return '';
    if (!isOwnerDm) return '';
    if (!(await decisionMemoryEnabled())) return '';
    const topicKey = await deriveTopicKey(question);
    const rows = topicKey
      ? await retrieveDecisions({ isOwnerDm: true, topicKey, limit: 5 })
      : await retrieveDecisions({ isOwnerDm: true, query: question, limit: 5 });
    if (!rows.length) return `No recorded decision found${topicKey ? ` on \`${topicKey}\`` : ''}. Do not invent a decision — say that nothing is recorded.`;
    return formatDecisionsForContext(rows, topicKey);
  } catch (err) {
    console.error('[decision_memory recall]', err?.message ?? err);
    return '';
  }
}

/** Owner-DM explicit capture (spec §2.3 path 1, v1 explicit form only).
 *  Accepts: "remember this [topic-key]: decision — reason: …" or
 *  "remember this: decision" (topic auto-slugged from the decision's
 *  first words; the echo back is the audit surface — the owner corrects
 *  a wrong capture by reply, which writes a superseding row). Returns
 *  null when the text is not an explicit capture. Never throws. */
export async function captureOwnerDecision({ text, actorId, chatId, decisionLogId = null } = {}) {
  try {
    if (!(await decisionMemoryEnabled())) return null;
    const m = /^\s*(?:pb,?\s*)?(?:remember this|note this|record this)\s*[:\-]?\s*(.+)$/is.exec(String(text ?? ''));
    if (!m) return null;
    const body = m[1].trim();
    if (!body) return null;
    let topicKey = null; let rest = body;
    const bracket = /^\[([a-z0-9\-_ ]+)\]\s*[:\-]\s*(.+)$/is.exec(body);
    if (bracket) { topicKey = normalizeTopicKey(bracket[1]); rest = bracket[2].trim(); }
    let decision = rest; let reasoning = null;
    const reasonSplit = /\s+—\s*reason:\s*|\s+--\s*reason:\s*|\s+reason:\s*/i.exec(rest);
    if (reasonSplit) { decision = rest.slice(0, reasonSplit.index).trim(); reasoning = rest.slice(reasonSplit.index + reasonSplit[0].length).trim() || null; }
    if (!topicKey) topicKey = normalizeTopicKey(decision.split(/\s+/).slice(0, 4).join(' '));
    const res = await recordDecision({
      scope: 'owner', chatId: chatId != null ? String(chatId) : (actorId != null ? String(actorId) : null),
      actorId, topicKey, title: decision, decision, reasoning,
      source: 'owner_chat', reasonState: reasoning ? 'stated' : 'not_stated',
      decisionLogId: decisionLogId != null ? Number(decisionLogId) : null,
    });
    if (!res.ok) return null;
    return { id: res.id, topicKey, decision, reasoning };
  } catch (err) {
    console.error('[decision_memory capture]', err?.message ?? err);
    return null;
  }
}

/** System-event hook (spec §2.3 path 2): a code path that performed a
 *  decision calls this with the actor's stated reason when one exists,
 *  else reasonState 'not_stated'. No reason is ever fabricated. */
export async function recordSystemDecision(input = {}) {
  return recordDecision({ ...input, source: 'system_event', scope: input.scope ?? 'owner' });
}
