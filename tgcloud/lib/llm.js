// LLM gateway — single entry point for all text-generation calls.
// Ported from artifacts/api-server/src/lib/llm.ts, adapted to the Serverless
// platform (sdk fetch instead of provider SDKs, keys from the config table).
//
// Tiers: "chat" (default) — xAI-direct grok-4.3 primary (persona-critical;
// XAI_API_KEY, wired 2026-10-20 when Rowdy's xAI key landed), Gemini
// fallback. "bulk" — OpenRouter deepseek/deepseek-chat-v3.1 primary (cheap,
// high-volume), Gemini fallback. "decide" — grok-build-0.1 / Gemini
// flash-lite (models config-overridable, see askLLM).
//
// FREE-LADDER W1 (2026-10-22, spec PB-FREE-LADDER-SPEC §2/§3/§8): the
// chat and decide tiers are now config-driven failover LADDERS —
//   xAI Grok (paid primary) → Gemini free → Groq free → Cloudflare
//   Workers AI free → OpenRouter :free
// Every rung past Gemini is gated on its provider key existing in config
// (GROQ_API_KEY / CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID /
// OPENROUTER_API_KEY): no key → the rung is skipped silently and the
// ladder behaves exactly as the old primary/fallback pair did. Each rung
// carries a per-day quota counter + an exhausted flag (config state,
// ladder_quota:<provider>:<yyyymmdd>) and an in-isolate circuit breaker;
// every attempt writes an llm_ledger row (spec §7) so borrowed credits
// are bookkept, and every failover hop keeps the [LLM] operator log line
// — backup mode is visible in operator logs, never silent, and never
// surfaced to users. The system prompt flows byte-identical to every
// rung: a rung change swaps the engine, never who PB is.
//
// LADDER PREP W2 (2026-10-22): three more rungs pre-wired behind the
// same keys — Kimi K2 as a second Groq rung, and explicit OpenRouter
// :free slugs (Kimi K2 / DeepSeek chat / MiMo V2 Flash) ahead of the
// openrouter/free catch-all. All inert until GROQ_API_KEY /
// OPENROUTER_API_KEY land. Catalog honesty note: at prep time the live
// OpenRouter catalog listed NO :free variant for those three vendors
// (their :free promos rotate in and out) — a delisted model fails safe
// here (404 = model-gone → next rung), and each new slug is pinnable
// via ladder_model_<scope> if the catalog moves again.
//
// Failover: retryable (429, 404 model-gone, 5xx, timeout, network) -> next
// rung. Auth errors (401/403) -> next rung + owner alert (30-min dedup).
// ANSWER-PATH FIX (2026-10-23): NON-retryable errors now ALSO fall
// through to the next rung. The old rule — a non-retryable error on any
// rung aborts the whole ladder — let one sick primary take every
// member question down with it: xAI grok-4.3 failed ~50% of chat calls
// in the 2026-10-22/23 window, and the failures that killed real
// questions (a ~5.0s latency signature in llm_ledger; error text is
// not stored, so the exact class is unrecoverable) surfaced as a bare
// "brain glitched" with no failover and no failure record. Now a rung
// failure of ANY class kills only that rung; askLLM throws solely when
// the ladder is exhausted. singleRung (council) calls are unaffected:
// a one-rung chain still surfaces its own error after its one attempt.

import { api, fetch, InputFile } from 'sdk';
import db, { eq } from 'sdk/db';
import { bot_users, llm_ledger } from '../schema.js';
import { getConfig, setConfig, getConfigFlag, flagValueOn } from './config.js';
import { tierAtLeast } from './tiers.js';

const MODELS = {
  chat: {
    primary:  { provider: 'xai',        model: 'grok-4.3' },
    fallback: { provider: 'gemini',     model: 'gemini-3.8-flash' },
  },
  bulk: {
    primary:  { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3.1' },
    fallback: { provider: 'gemini',     model: 'gemini-3.8-flash' },
  },
  // Decision layer (lib/decide.js): high-volume, low-reasoning typed calls.
  // Models are config-overridable at call time (DECIDE_MODEL /
  // DECIDE_FALLBACK_MODEL) — see askLLM. Defaults: Grok Build-class primary
  // on the xAI-direct key (same XAI_API_KEY as the brain), Gemini
  // flash-lite fallback (the project's existing flash-lite line).
  decide: {
    primary:  { provider: 'xai',        model: 'grok-build-0.1' },
    fallback: { provider: 'gemini',     model: 'gemini-3.1-flash-lite' },
  },
};

/** Exported for lib/websync.js pushBotStatus (model names only, never keys). */
export const LLM_MODELS = MODELS;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const XAI_URL = 'https://api.x.ai/v1/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const WORKERSAI_URL = (accountId, model) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

// Documented test seam (same precedent as __setVoiceFetchForTest below):
// null in production. When set, every chat/decide/bulk provider call in
// this module routes through the supplied (url, init) => response
// function so the in-isolate harness can stub transports at the fetch
// seam. Never set outside the harness.
let _llmFetchOverride = null;
export function __setLlmFetchForTest(fn) { _llmFetchOverride = fn ?? null; }
const llmFetch = (url, init) => (_llmFetchOverride ? _llmFetchOverride(url, init) : fetch(url, init));

// The Serverless runtime lacks some host globals (AbortController,
// clearTimeout) — route every timer in this module through these guards.
const hostSetTimeout = (fn, ms) => (typeof setTimeout !== 'undefined' ? setTimeout(fn, ms) : null);
const hostClearTimeout = (t) => { if (t != null && typeof clearTimeout !== 'undefined') clearTimeout(t); };
const sleepMs = (ms) => new Promise((r) => { if (hostSetTimeout(r, ms) == null) r(); });

// Timeout race (2026-10-25): the isolate has no AbortController, so a
// provider fetch's signal-less timeout is dead — a hung rung used to hang
// the whole ladder until the platform killed the invocation with zero
// trace (the 09:11 group-message silence). This race bounds any promise
// with a real timer where the runtime has setTimeout; where it does not,
// it degrades to the bare promise (no worse than before). The timer
// rejection message carries 'timeout' so the ladder's isRetryable check
// treats it as a failover, not a fatal error. Exported for the harness.
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = hostSetTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);
    if (timer == null) {
      promise.then(
        (v) => { if (!settled) { settled = true; resolve(v); } },
        (e) => { if (!settled) { settled = true; reject(e); } },
      );
      return;
    }
    promise.then(
      (v) => { if (!settled) { settled = true; hostClearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; hostClearTimeout(timer); reject(e); } },
    );
  });
}

function isRetryable(status, errMsg) {
  if (status === 429 || status === 404) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return /timeout|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|request failed|empty response/i.test(String(errMsg ?? ''));
}

function isAuthError(status, errMsg) {
  if (status === 401 || status === 403) return true;
  return /unauthorized|invalid.*api.*key|api key not/i.test(String(errMsg ?? ''));
}

// Owner-alert dedup: at most once per 30 min per provider:model.
const _lastAuthAlert = {};

async function alertOwnerAuthError(provider, model, errMsg) {
  const key = `${provider}:${model}`;
  const now = Date.now();
  if (_lastAuthAlert[key] && now - _lastAuthAlert[key] < 30 * 60_000) return;
  _lastAuthAlert[key] = now;
  const ownerIds = String(await getConfig('TELEGRAM_OWNER_ID', ''))
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (ownerIds.length === 0) {
    console.error(`[LLM] AUTH ERROR alert — no owner IDs configured. Provider: ${provider}:${model} — ${errMsg}`);
    return;
  }
  const text =
    `⚠️ AI Key Rejected\n\nProvider: ${provider} (${model})\n` +
    `Error: ${(errMsg ?? '').slice(0, 200)}\n\n` +
    `AI has failed over to the backup model. Check the API key.`;
  for (const id of ownerIds) {
    try { await api.sendMessage({ chat_id: id, text }); } catch { /* best effort */ }
  }
}

// ── Usage accounting (ladder ledger + quota counters) ──────────────────────
// Callers return { text, tokensIn, tokensOut }. Providers that report
// usage win; otherwise estimate at ~4 chars/token (the decide layer's
// own est convention in lib/decide.js). Estimates feed quota counters
// and the ledger's units — they are bookkeeping, not billing.
function estTokensIn(systemPrompt, userMessage, history) {
  let chars = String(systemPrompt ?? '').length + String(userMessage ?? '').length;
  for (const m of history ?? []) chars += String(m?.content ?? '').length;
  return Math.max(1, Math.ceil(chars / 4));
}
function estTokensOut(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}
function openAiUsage(data, systemPrompt, userMessage, history, text) {
  const u = data?.usage ?? {};
  const tin = Number(u.prompt_tokens);
  const tout = Number(u.completion_tokens);
  return {
    text,
    tokensIn: Number.isFinite(tin) && tin > 0 ? tin : estTokensIn(systemPrompt, userMessage, history),
    tokensOut: Number.isFinite(tout) && tout > 0 ? tout : estTokensOut(text),
  };
}
function openAiMessages(systemPrompt, userMessage, history) {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];
}

async function callOpenRouter(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature) {
  // The Serverless runtime has no global AbortController — go signal-less
  // there and let the platform's own execution limit bound the call.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await llmFetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://poorboyai.com',
        'X-Title': 'PoorBoyAI PB',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        // Only sent when the caller asked for one (decide tier: 0.1) —
        // every other tier keeps the provider default, as before.
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages: openAiMessages(systemPrompt, userMessage, history),
      }),
      signal: controller?.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(body);
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('empty response');
    return openAiUsage(data, systemPrompt, userMessage, history, text);
  } finally {
    hostClearTimeout(timer);
  }
}

// PB STREAMING REPLIES — OPENROUTER EXTENSION (2026-11-06, Rowdy's pick):
// callOpenRouterStream mirrors callGroqStream exactly (OpenRouter's chat
// completions are OpenAI-compatible, same SSE shape). Same request shape
// as callOpenRouter plus stream:true; same budgets, same return shape,
// same throw-before-content / return-partial-after-content contract, so
// the ladder loop's quota / breaker / ledger code runs unchanged on a
// streamed OpenRouter rung. Reasoning deltas (delta.reasoning_content on
// DeepSeek-style models) are never read — only delta.content reaches
// onToken, exactly like the Groq path.
const OPENROUTER_STREAM_BUDGET_MS = 25_000;
const OPENROUTER_STREAM_MAX_CHARS = 4000;

async function callOpenRouterStream(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature, onToken) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();
  let text = '';
  let sawContent = false;
  let usage = null;
  try {
    const res = await llmFetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://poorboyai.com',
        'X-Title': 'PoorBoyAI PB',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages: openAiMessages(systemPrompt, userMessage, history),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller?.signal,
    });
    if (!res?.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenRouter ${res?.status}: ${String(body).slice(0, 200)}`);
      err.status = res?.status;
      throw err;
    }
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const decode = (c) => (dec ? dec.decode(c, { stream: true }) : String.fromCharCode(...c));
    let buf = '';
    let done = false;
    const pushText = (s) => {
      if (!s || text.length >= OPENROUTER_STREAM_MAX_CHARS) return;
      const room = OPENROUTER_STREAM_MAX_CHARS - text.length;
      const take = s.length > room ? s.slice(0, room) : s;
      text += take;
      sawContent = true;
      try { onToken?.(take); } catch { /* a token callback never breaks the stream */ }
    };
    for await (const chunk of res.body) {
      if (done || Date.now() - startedAt > OPENROUTER_STREAM_BUDGET_MS || text.length >= OPENROUTER_STREAM_MAX_CHARS) break;
      buf += decode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (payload === '[DONE]') { done = true; break; }
          let data;
          try { data = JSON.parse(payload); } catch { continue; }
          if (data?.usage) usage = data.usage;
          const content = data?.choices?.[0]?.delta?.content;
          // delta.reasoning_content is deliberately never read into text.
          if (typeof content === 'string' && content) pushText(content);
          if (text.length >= OPENROUTER_STREAM_MAX_CHARS) break;
        }
        if (done || text.length >= OPENROUTER_STREAM_MAX_CHARS) break;
      }
    }
    try { if (controller) controller.abort(); } catch { /* best-effort stop */ }
    if (!sawContent) throw new Error('empty response');
    return openAiUsage({ usage }, systemPrompt, userMessage, history, text);
  } catch (err) {
    // Before the first content token this is a clean rung failure: let
    // the ladder loop fail over exactly like a callOpenRouter throw.
    // After content started, the partial text IS the answer — return it.
    if (sawContent) return openAiUsage({ usage }, systemPrompt, userMessage, history, text);
    throw err;
  } finally {
    hostClearTimeout(timer);
  }
}

async function callGroq(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature) {
  // Groq's chat-completions API is OpenAI-shaped (spec §2.2) — same body
  // as the xAI path, Groq's own base URL and key.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await llmFetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages: openAiMessages(systemPrompt, userMessage, history),
      }),
      signal: controller?.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(body);
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('empty response');
    return openAiUsage(data, systemPrompt, userMessage, history, text);
  } finally {
    hostClearTimeout(timer);
  }
}

// PB STREAMING REPLIES (2026-11-06): Groq SSE streaming for the owner-DM
// draft path. Same request shape as callGroq plus stream:true; reads SSE
// deltas and invokes onToken(content) per CONTENT delta. Reasoning deltas
// (delta.reasoning — gpt-oss/qwen chain-of-thought, streamed FIRST) are
// read and DISCARDED: they must never reach the user. Returns the same
// { text, tokensIn, tokensOut } shape as callGroq (usage from the final
// chunk when present, else estimated), so the ladder loop's quota /
// breaker / ledger code runs unchanged on a streamed rung. Throws before
// the first content token exactly like callGroq (ladder fails over); after
// content started, returns the partial text as success (the caller
// persists it — a cut-short complete message beats silence). Budgets: the
// isolate has no timers and the platform kills at ~33s, so reading stops
// at GROQ_STREAM_BUDGET_MS and at GROQ_STREAM_MAX_CHARS (today's
// 4000-char answer cap — the caller slices there anyway).
const GROQ_STREAM_BUDGET_MS = 25_000;
const GROQ_STREAM_MAX_CHARS = 4000;

async function callGroqStream(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature, onToken) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();
  let text = '';
  let sawContent = false;
  let usage = null;
  try {
    const res = await llmFetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages: openAiMessages(systemPrompt, userMessage, history),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: controller?.signal,
    });
    if (!res?.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Groq ${res?.status}: ${String(body).slice(0, 200)}`);
      err.status = res?.status;
      throw err;
    }
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const decode = (c) => (dec ? dec.decode(c, { stream: true }) : String.fromCharCode(...c));
    let buf = '';
    let done = false;
    const pushText = (s) => {
      if (!s || text.length >= GROQ_STREAM_MAX_CHARS) return;
      const room = GROQ_STREAM_MAX_CHARS - text.length;
      const take = s.length > room ? s.slice(0, room) : s;
      text += take;
      sawContent = true;
      try { onToken?.(take); } catch { /* a token callback never breaks the stream */ }
    };
    for await (const chunk of res.body) {
      if (done || Date.now() - startedAt > GROQ_STREAM_BUDGET_MS || text.length >= GROQ_STREAM_MAX_CHARS) break;
      buf += decode(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (payload === '[DONE]') { done = true; break; }
          let data;
          try { data = JSON.parse(payload); } catch { continue; }
          if (data?.usage) usage = data.usage;
          const content = data?.choices?.[0]?.delta?.content;
          // delta.reasoning is deliberately never read into text.
          if (typeof content === 'string' && content) pushText(content);
          if (text.length >= GROQ_STREAM_MAX_CHARS) break;
        }
        if (done || text.length >= GROQ_STREAM_MAX_CHARS) break;
      }
    }
    try { if (controller) controller.abort(); } catch { /* best-effort stop */ }
    if (!sawContent) throw new Error('empty response');
    return openAiUsage({ usage }, systemPrompt, userMessage, history, text);
  } catch (err) {
    // Before the first content token this is a clean rung failure: let
    // the ladder loop fail over exactly like a callGroq throw. After
    // content started, the partial text IS the answer — return it.
    if (sawContent) return openAiUsage({ usage }, systemPrompt, userMessage, history, text);
    throw err;
  } finally {
    hostClearTimeout(timer);
  }
}

async function callMistral(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature) {
  // Mistral's chat-completions API is OpenAI-shaped (spec §2.7) — same
  // body as the Groq path, Mistral's own base URL and key.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await llmFetch(MISTRAL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages: openAiMessages(systemPrompt, userMessage, history),
      }),
      signal: controller?.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`Mistral ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(body);
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('empty response');
    return openAiUsage(data, systemPrompt, userMessage, history, text);
  } finally {
    hostClearTimeout(timer);
  }
}

async function callWorkersAI(model, token, accountId, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature) {
  // Cloudflare Workers AI REST (spec §2.4): POST /accounts/{id}/ai/run/{model}
  // with an OpenAI-shaped messages body; the reply rides result.response.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await llmFetch(WORKERSAI_URL(accountId, model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: openAiMessages(systemPrompt, userMessage, history),
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
      }),
      signal: controller?.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`WorkersAI ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(body);
    if (data?.success === false) {
      const msg = (data?.errors ?? []).map((e) => e?.message ?? '').filter(Boolean).join('; ') || 'workers ai error';
      const err = new Error(`WorkersAI: ${msg.slice(0, 200)}`);
      err.status = 502; // provider-side failure — retryable class
      throw err;
    }
    const text = String(data?.result?.response ?? '').trim();
    if (!text) throw new Error('empty response');
    return openAiUsage({ usage: data?.result?.usage }, systemPrompt, userMessage, history, text);
  } finally {
    hostClearTimeout(timer);
  }
}

async function callXai(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature) {
  // xAI's chat-completions API is OpenAI-shaped — same request body as the
  // OpenRouter path, minus OpenRouter's attribution headers.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await llmFetch(XAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        messages: openAiMessages(systemPrompt, userMessage, history),
      }),
      signal: controller?.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`xAI ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(body);
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('empty response');
    return openAiUsage(data, systemPrompt, userMessage, history, text);
  } finally {
    hostClearTimeout(timer);
  }
}

async function callGemini(model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? hostSetTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await llmFetch(GEMINI_URL(model, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [
          ...history.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: { maxOutputTokens, temperature: typeof temperature === 'number' ? temperature : 0.3, topP: 0.85 },
      }),
      signal: controller?.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(body);
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';
    if (!text) throw new Error('empty response');
    const um = data?.usageMetadata ?? {};
    const tin = Number(um.promptTokenCount);
    const tout = Number(um.candidatesTokenCount);
    return {
      text,
      tokensIn: Number.isFinite(tin) && tin > 0 ? tin : estTokensIn(systemPrompt, userMessage, history),
      tokensOut: Number.isFinite(tout) && tout > 0 ? tout : estTokensOut(text),
    };
  } finally {
    hostClearTimeout(timer);
  }
}

// ── Free-Ladder W1: rung registry, price book, quota, breaker, ledger ──────
// Spec: PB-FREE-LADDER-SPEC §2.1 (ladder order), §3 (wiring), §7 (ledger),
// §8 W1 (build scope). Mistral (§2.7) shipped ABSENT pending a separate
// decision; Rowdy made that decision on 2026-10-23 — the rung is BUILT.
// Its free tier may train on inputs: disclosed to him (and noted by him)
// before he directed the build, so the rung carries trainsOnInputs true
// like Gemini's free tier. Key-gated on MISTRAL_API_KEY like every free
// rung: no key in config → silently absent from the effective ladder.

const RUNGS = {
  xai:        { keyConfigs: ['XAI_API_KEY'], trainsOnInputs: false },
  gemini:     { keyConfigs: ['GEMINI_API_KEY'], trainsOnInputs: true }, // free tier trains (spec §2.3)
  groq:       { keyConfigs: ['GROQ_API_KEY'], trainsOnInputs: false, // contractually never (spec §2.2)
                dailyCalls: 1_000, dailyTokens: 200_000 },          // per model, org-level (spec §2.2)
  workersai:  { keyConfigs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], trainsOnInputs: false,
                dailyCalls: 300 }, // ≈ the 10K-Neuron/day bucket in chat-sized calls (spec §2.4)
  openrouter: { keyConfigs: ['OPENROUTER_API_KEY'], trainsOnInputs: true, // endpoint-dependent (spec §2.5)
                dailyCalls: 50 }, // :free account cap (spec §2.5)
  mistral:    { keyConfigs: ['MISTRAL_API_KEY'], trainsOnInputs: true }, // free tier may train (spec §2.7; disclosed to + noted by Rowdy 2026-10-23). No dailyCalls cap: free-tier 429s are burst (~1 RPS) limits, not a daily quota — the circuit breaker is the backstop.
};

// Rungs appended after each tier's primary/fallback pair (chat + decide
// only — bulk keeps its exact two-target shape). Models are the spec's
// pins; ladder_model_<provider> config overrides without a deploy.
//
// W2 multi-model rungs: two rungs can now share one provider (two Groq
// models, OpenRouter models). Ledger rows already carry
// provider+model, so attribution was always per-model; what was keyed
// by provider alone is the quota counter, the exhausted stamp and the
// circuit breaker. A rung may therefore declare a `scope` — the key
// those three are filed under. Unscoped rungs keep scope === provider,
// i.e. W1's exact config keys and behavior. Groq meters its free tier
// PER MODEL (see RUNGS), so the Kimi rung gets its own scope; the
// OpenRouter :free cap is account-wide, but its explicit-model rungs
// still take scopes so each can be pinned/disabled/metered on its own
// (the server-side 429 + exhausted stamp remains the real backstop).
// Owner controls: ladder_model_<provider> pins the provider's
// canonical (unscoped) rung exactly as in W1; ladder_model_<scope>
// pins one scoped rung. ladder_rung_<provider> '0' disables the whole
// provider; ladder_rung_<scope> '0' disables just that rung.
const LADDER_EXTRA_RUNGS = [
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  // PINNED 2026-10-25 to Rowdy's decided qwen slot (Groq catalog has no
  // Kimi K2); the scope key is RETAINED so ladder_model_<scope>
  // overrides + metering keep working unchanged.
  { provider: 'groq', model: 'qwen/qwen3.8-27b', scope: 'groq:moonshotai/kimi-k2-instruct-0905' },
  { provider: 'workersai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  // PRUNED 2026-10-26 (PB-chat big fix): three scoped :free OpenRouter
  // rungs were removed here — all http_404, retired upstream IDs
  // (28 errors / 0 ok each in 24h). openrouter/free remains as the
  // serving OpenRouter rung; no replacement IDs invented.
  { provider: 'openrouter', model: 'openrouter/free' },
  // Mistral (spec §2.7, built 2026-10-23 on Rowdy's decision): appended
  // LAST here so tiers without a ladder_chain_<tier> order override
  // (decide) only ever gain it as a final key-gated overflow rung; the
  // chat tier's ladder_chain_chat places it between openrouter and
  // workersai. Model pinnable via ladder_model_mistral.
  // RE-PINNED 2026-10-27 (brain-glitch fix): mistral-large-latest 403s
  // tier_not_allowed on this key (first failover ever to reach it);
  // mistral-small-latest is on the key's own model list, verified
  // 2026-10-27, so it is the default until a pin says otherwise.
  { provider: 'mistral', model: 'mistral-small-latest' },
];
/** Quota/breaker filing key for a rung: its scope, else its provider. */
const rungScope = (rung) => rung.scope ?? rung.provider;

// GROQ TPM GUARD (2026-10-27 brain-glitch fix): Groq's free tier
// enforces an 8,000 tokens-per-minute limit per model. A full chat
// prompt (system prompt alone ≈12.4k tokens) exceeds it, so Groq 413s
// every full-prompt call (proven 2026-10-27: Requested 14530 vs Limit
// 8000; 24h chat ledger: 120b ok 3, all ≤1503 tokens; qwen 0 ok).
// A rung the prompt cannot fit is SKIPPED (ledger tpm_skipped), never
// attempted — a skip costs a failover hop, a 413 costs cap budget.
// 0.95 margin covers tokenizer drift (Groq counted 14,530 vs est
// 14,481). Small-prompt calls (probe, commands, decide) still try Groq.
const GROQ_TPM_LIMIT = 8_000;
const GROQ_TPM_SKIP_AT = Math.floor(GROQ_TPM_LIMIT * 0.95);


// Price book v pb-2026-10-22 (spec §7) — USD per 1M tokens [in, out].
// est_paid_equiv is priced at the surface's PRIMARY rung (what the call
// would have cost on the paid reference route); actual_cost is priced at
// the serving rung and is $0 for free-tier keys/rungs. Models missing
// here price at 0 rather than inventing a number. Owner overrides merge
// via ladder_price_book_json ({"provider:model":[in,out], ...}).
const PRICE_BOOK_VERSION = 'pb-2026-10-22.2';
const PRICE_BOOK = {
  'xai:grok-4.3': [1.25, 2.50],
  'xai:grok-build-0.1': [1.00, 2.00],
  'gemini:gemini-3.8-flash': [0.75, 3.75],
  // W2 rungs, priced at their paid-route equivalents from the live
  // OpenRouter catalog (2026-10-22) so est_paid_equiv stays honest if
  // one ever serves as a surface primary. Free-tier serving still books
  // actualCostUsd 0 — PAID_PROVIDERS below is unchanged.
  'groq:moonshotai/kimi-k2-instruct-0905': [0.60, 2.50], // = openrouter moonshotai/kimi-k2-0905
  'openrouter:moonshotai/kimi-k2:free': [0.57, 2.30], // paid sibling moonshotai/kimi-k2
  'openrouter:deepseek/deepseek-chat:free': [0.26, 1.03], // paid sibling deepseek/deepseek-chat
  'openrouter:xiaomi/mimo-v2-flash:free': [0.14, 0.28], // current flash xiaomi/mimo-v2.6-flash
  // KIMI HEAVY (2026-11-04): OpenRouter list price for the flagged
  // heavy-jobs route only — NOT a ladder rung, so this entry prices
  // askKimiHeavy's ledger rows and nothing else.
  'openrouter:moonshotai/kimi-k3.1-pro': [2.00, 10.00], // OpenRouter $2 in / $10 out per 1M
};
const PAID_PROVIDERS = new Set(['xai']); // gemini key in config is the free tier (spec §2.3)

async function priceBook() {
  let book = PRICE_BOOK;
  try {
    const raw = await getConfig('ladder_price_book_json', '');
    if (raw) {
      const extra = JSON.parse(raw);
      if (extra && typeof extra === 'object') book = { ...PRICE_BOOK, ...extra };
    }
  } catch { /* a bad override never breaks routing */ }
  return book;
}
function priceUsd(book, provider, model, tokensIn, tokensOut) {
  const p = book[`${provider}:${model}`];
  if (!p) return 0;
  return (tokensIn * Number(p[0] ?? 0) + tokensOut * Number(p[1] ?? 0)) / 1_000_000;
}

// ── Daily quota counters (config state, spec §3) ────────────────────────────
// ladder_quota:<provider>:<yyyymmdd> = JSON {calls, tokens}; the date is
// UTC (Groq/OpenRouter/Cloudflare windows are UTC; spec §3). A 429 from a
// free rung also stamps ladder_exhausted:<provider>:<yyyymmdd> so the
// rung is skipped pre-emptively until the window rolls over.
const utcDay = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const quotaKey = (scope) => `ladder_quota:${scope}:${utcDay()}`;
const exhaustedKey = (scope) => `ladder_exhausted:${scope}:${utcDay()}`;

async function readQuota(scope) {
  try {
    const raw = await getConfig(quotaKey(scope), '');
    const o = raw ? JSON.parse(raw) : null;
    return { calls: Number(o?.calls) || 0, tokens: Number(o?.tokens) || 0 };
  } catch { return { calls: 0, tokens: 0 }; }
}
async function bumpQuota(scope, tokens) {
  try {
    const q = await readQuota(scope);
    await setConfig(quotaKey(scope), JSON.stringify({ calls: q.calls + 1, tokens: q.tokens + Math.max(0, tokens | 0) }));
  } catch { /* counters are bookkeeping — never break a call */ }
}
async function quotaLimits(scope, provider) {
  const def = RUNGS[provider] ?? {};
  const lim = {};
  if (def.dailyCalls) {
    const over = Number(await getConfig(`ladder_quota_calls_${scope}`, ''));
    lim.calls = Number.isFinite(over) && over > 0 ? over : def.dailyCalls;
  }
  if (def.dailyTokens) {
    const over = Number(await getConfig(`ladder_quota_tokens_${scope}`, ''));
    lim.tokens = Number.isFinite(over) && over > 0 ? over : def.dailyTokens;
  }
  return lim;
}
async function quotaExhausted(scope, provider) {
  try {
    if (await getConfig(exhaustedKey(scope), '')) return true;
    const lim = await quotaLimits(scope, provider);
    if (!lim.calls && !lim.tokens) return false;
    const q = await readQuota(scope);
    return (lim.calls && q.calls >= lim.calls) || (lim.tokens && q.tokens >= lim.tokens);
  } catch { return false; }
}
async function markExhausted(scope) {
  try { await setConfig(exhaustedKey(scope), '1'); } catch { /* best effort */ }
}

// ── Circuit breaker (in-isolate, per rung scope) ────────────────────────────
// Opens after ladder_breaker_threshold (default 3) CONSECUTIVE retryable
// failures; while open the rung is skipped. After ladder_breaker_cooldown_ms
// (default 5 min) one half-open trial is allowed: success closes the
// breaker, failure re-opens it. Same in-isolate discipline as the auth
// alert dedup above — an isolate restart simply resets it closed.
const _breakers = {};
async function breakerSettings() {
  const th = Number(await getConfig('ladder_breaker_threshold', ''));
  const cdRaw = await getConfig('ladder_breaker_cooldown_ms', '');
  const cd = Number(cdRaw);
  return {
    threshold: Number.isFinite(th) && th >= 1 ? Math.floor(th) : 3,
    // FREE-FIRST WAVE FIX (2026-10-23): an ABSENT cooldown config must
    // yield the documented 5-min default — Number('') is 0 (finite,
    // >= 0), so the old check read absence as an explicit 0 ms and a
    // tripped breaker re-opened instantly: a dead rung was never
    // actually skipped. Only a non-empty stored value counts as an
    // owner's explicit setting now. FIX WAVE 2026-10-25: an EXPLICIT 0
    // is equally unusable — a 0 ms cooldown re-opens instantly, the
    // same never-skipped failure — so 0 falls back to 5 min too.
    cooldownMs: String(cdRaw ?? '').trim() !== '' && Number.isFinite(cd) && cd > 0 ? cd : 300_000,
  };
}
function breakerAllows(provider) {
  const b = _breakers[provider];
  if (!b || !b.openUntil) return true;
  if (Date.now() < b.openUntil) return false;
  if (b.trialInFlight) return false; // half-open: exactly one trial at a time
  b.trialInFlight = true;
  return true;
}
function breakerRecord(provider, ok, settings) {
  const b = _breakers[provider] ?? (_breakers[provider] = { fails: 0, openUntil: 0, trialInFlight: false });
  b.trialInFlight = false;
  if (ok) {
    const wasOpen = !!b.openUntil;
    b.fails = 0; b.openUntil = 0;
    // M2: closing a previously-open breaker clears the persisted trip so
    // a later cold isolate does not resurrect it. No write when the
    // breaker was never open (successes must not spam config).
    if (wasOpen) persistBreakerOpen(provider, 0);
    return;
  }
  b.fails += 1;
  if (b.fails >= settings.threshold) {
    b.openUntil = Date.now() + settings.cooldownMs;
    // M2: persist ONLY on trip (not per failure) — a cold isolate then
    // honors this trip until its cooldown expires.
    persistBreakerOpen(provider, b.openUntil);
  }
}
/** Release a half-open trial without recording an outcome (the rung was
 *  never actually called — e.g. its key vanished mid-resolution). */
function breakerRelease(provider) {
  const b = _breakers[provider];
  if (b) b.trialInFlight = false;
}

// ── M2 durable breaker state (Wave 2, 2026-10-26) ─────────────────────────
// openUntil persists in config so a cold isolate honors a trip made by a
// warm one. Only the open timestamp persists — fail counts and the
// half-open trial flag stay memory-only (a persisted trial flag could
// wedge a rung forever, and a persisted fail count would re-trip a rung
// that already recovered). Persistence never blocks chat: writes are
// fire-and-forget with catch, and hydration failures fall back to
// memory-only behavior, exactly as before.
const breakerOpenKey = (scope) => `ladder_breaker_open_${scope}`;
const _breakerHydrated = new Set();
let _breakerPersistPending = null;
function persistBreakerOpen(scope, openUntil) {
  try {
    const p = (async () => {
      if (openUntil) await setConfig(breakerOpenKey(scope), String(openUntil));
      else await setConfig(breakerOpenKey(scope), '');
    })().catch(() => {});
    _breakerPersistPending = p;
  } catch { /* persistence never breaks chat */ }
}
async function breakerFlushPersist() {
  try { await (_breakerPersistPending ?? Promise.resolve()); } catch { /* ignore */ }
}
async function breakerHydrateScope(scope) {
  if (_breakerHydrated.has(scope)) return;
  _breakerHydrated.add(scope);
  let raw = null;
  try { raw = await getConfig(breakerOpenKey(scope), null); } catch { return; }
  if (raw === null || String(raw).trim() === '') return;
  const openUntil = Number(raw);
  if (!Number.isFinite(openUntil)) return;
  if (openUntil > Date.now()) {
    _breakers[scope] = { fails: 0, openUntil, trialInFlight: false };
  } else {
    // Stale row: clear it so config does not accumulate dead trips.
    try { await setConfig(breakerOpenKey(scope), ''); } catch { /* best effort */ }
  }
}
async function hydrateBreakers(scopes) {
  for (const s of new Set(scopes)) await breakerHydrateScope(s).catch(() => {});
}
/** Test-only reset (harness): clears memory breakers + hydration marks. */
export function __resetBreakersForTest() {
  for (const k of Object.keys(_breakers)) delete _breakers[k];
  _breakerHydrated.clear();
}
export const __test = { rungEnabled, breakerAllows, breakerRecord, breakerHydrateScope, breakerFlushPersist, breakerOpenKey };

// ── Ledger (spec §7) ────────────────────────────────────────────────────────
// One row per ladder attempt, written by askLLM's routing loop — never
// reconstructed after the fact, never allowed to break a chat call.
async function writeLedger(row) {
  try {
    await db.insert(llm_ledger).values({
      ts: Math.floor(Date.now() / 1000),
      surface: row.surface,
      consumer: 'bot',
      jobId: null,
      tier: row.surface === 'chat' ? 'standard' : 'internal',
      provider: row.provider,
      model: row.model,
      rungReason: row.rungReason,
      units: (row.tokensIn | 0) + (row.tokensOut | 0),
      tokensIn: row.tokensIn | 0,
      tokensOut: row.tokensOut | 0,
      unitType: 'tokens',
      estPaidEquivUsd: row.estPaidEquivUsd ?? 0,
      actualCostUsd: row.actualCostUsd ?? 0,
      priceBookVersion: PRICE_BOOK_VERSION,
      trainsOnInputs: !!RUNGS[row.provider]?.trainsOnInputs,
      outcome: row.outcome,
      latencyMs: row.latencyMs | 0,
    }).run();
  } catch { /* bookkeeping never breaks chat */ }
}

// ── Ladder error-class stamp (Task 2, 2026-10-26) ─────────────────────────
// The ledger stores outcome but no error text, so a rung's failure CLASS
// was unrecoverable from outside the isolate — the exact gap that left
// Gemini's 0-ok/39-error day undiagnosable (fast failures, avg 1.2s,
// so not timeouts, but 400 vs 401 vs 429 indistinguishable). Record the
// class ONLY: an HTTP status code, or a fixed label matched from the
// error message. NEVER the message itself (it can carry request
// details), never a key, never a prompt. Two small config rows per
// provider, overwritten — bounded, no growth. Fail-open like the
// ledger: a stamp failure never breaks the ladder. Exported for the
// harness; the snapshot surfaces it per provider.
export function llmErrorClass(status, errMsg) {
  if (typeof status === 'number') return `http_${status}`;
  const m = String(errMsg ?? '');
  if (/timeout/i.test(m)) return 'timeout';
  if (/empty response/i.test(m)) return 'empty';
  if (/not configured/i.test(m)) return 'not_configured';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|network|fetch failed|request failed/i.test(m)) return 'network';
  return 'unknown';
}
export async function recordLlmErrorClass(provider, status, errMsg) {
  try {
    await setConfig(`llm_last_error_${provider}`, llmErrorClass(status, errMsg));
    await setConfig(`llm_last_error_at_${provider}`, String(Date.now()));
  } catch { /* bookkeeping never breaks chat */ }
}

// ── Chain resolution ────────────────────────────────────────────────────────
// Default chain = the tier's primary + fallback (MODELS, with the decide
// overrides) + LADDER_EXTRA_RUNGS for chat/decide. Owner config, all
// optional: ladder_chain_<tier> (comma-separated provider names —
// reorders/filters the default chain), ladder_rung_<provider> ('0'/'off'
// disables a rung; default on), ladder_model_<provider> (model pin).
// Scoped rungs (LADDER_EXTRA_RUNGS) additionally honor
// ladder_rung_<scope> / ladder_model_<scope> for that one rung.
async function rungEnabled(provider) {
  const v = await getConfig(`ladder_rung_${provider}`, null);
  // M3 (Wave 2, 2026-10-26): an existing-but-EMPTY row must mean unset,
  // not OFF — emptying a toggle to "clear" it silently disabled the rung.
  // Only an explicit '0'/'off' (flagValueOn false on a non-empty value)
  // disables; null and '' both enable.
  return v === null || String(v).trim() === '' || flagValueOn(v);
}
async function rungKeyPresent(provider) {
  for (const k of RUNGS[provider]?.keyConfigs ?? []) {
    if (!(await getConfig(k))) return false;
  }
  return true;
}
async function resolveChain(tier) {
  let { primary, fallback } = MODELS[tier];
  if (tier === 'decide') {
    // Decision-layer models are owner-tunable without a deploy, exactly the
    // way keys already are. Unset/empty config → the MODELS defaults above.
    const dm = await getConfig('DECIDE_MODEL', '');
    const dfm = await getConfig('DECIDE_FALLBACK_MODEL', '');
    // A DECIDE_MODEL containing '/' is an OpenRouter id (vendor/model);
    // a bare id is an xAI-direct model on XAI_API_KEY.
    if (dm) primary = { provider: String(dm).includes('/') ? 'openrouter' : 'xai', model: String(dm) };
    if (dfm) fallback = { provider: 'gemini', model: String(dfm) };
  }
  let chain = [primary, fallback];
  if (tier === 'chat' || tier === 'decide') {
    for (const extra of LADDER_EXTRA_RUNGS) {
      if (!chain.some((r) => r.provider === extra.provider && r.model === extra.model)) chain.push({ ...extra });
    }
  }
  // Model pins. An unscoped rung reads the provider pin (W1 semantics —
  // the provider's canonical rung); a scoped rung reads only its own
  // scope pin, so pinning one model of a multi-model provider can
  // never collapse its sibling rungs into the same model.
  for (const rung of chain) {
    const pin = await getConfig(rung.scope ? `ladder_model_${rung.scope}` : `ladder_model_${rung.provider}`, '');
    if (pin) rung.model = String(pin);
  }
  // Chain order override (provider names; unknown names ignored, named
  // providers not in the default chain are not conjured into it).
  const orderRaw = await getConfig(`ladder_chain_${tier}`, '');
  if (orderRaw) {
    const names = String(orderRaw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const picked = [];
    for (const n of names) for (const r of chain) if (r.provider === n && !picked.includes(r)) picked.push(r);
    if (picked.length) chain = picked;
  }
  // Availability: a rung with no key in config, or disabled by
  // ladder_rung_<provider>, is not in the effective ladder at all — with
  // no free-rung keys this reproduces today's primary/fallback pair
  // exactly, including which rung is "last" (and gets the retries).
  const effective = [];
  for (const rung of chain) {
    if (!(await rungEnabled(rung.provider))) continue;
    if (rung.scope && !(await rungEnabled(rung.scope))) continue;
    if (!(await rungKeyPresent(rung.provider))) continue;
    effective.push(rung);
  }
  return effective;
}

// Documented test seam (same precedent as __setLlmFetchForTest above):
// lets the in-isolate harness assert the resolved ladder — order,
// models, scopes — without burning provider calls. Never used in
// production paths.
export const __llmTest = { resolveChain };

// Hang-protection R5 (2026-10-29): probe-guided rung skip. The tick
// probe records per-rung failures; the handler starts the ladder
// AFTER any free-prefix rung that failed within the window — never
// into the paid tail, and normal order (0) when every free rung is
// in the window (failover handles it). Temporary, not a permanent
// ladder reorder: a rung that recovers is tried again once its
// failure ages out. Pure core is exported for the harness; the
// production helper resolves the real chain + failure map, fail-open
// to 0 on any read failure.
export const PROBE_RUNG_SKIP_WINDOW_MS = 5 * 60_000;
export function computeProbeSkipStart(chain, failures, now = Date.now()) {
  const list = Array.isArray(chain) ? chain : [];
  const map = failures && typeof failures === 'object' && !Array.isArray(failures) ? failures : {};
  for (let i = 0; i < list.length; i++) {
    const rung = list[i];
    if (PAID_PROVIDERS.has(rung.provider)) break; // paid tail: never start here
    const failedAt = Number(map[`${rung.provider}:${rung.model}`]) || 0;
    if (!failedAt || now - failedAt > PROBE_RUNG_SKIP_WINDOW_MS) return i;
  }
  return 0;
}
export async function probeSkipStartIndex() {
  try {
    const chain = await resolveChain('chat');
    let failures = {};
    try {
      const raw = await getConfig('answer_probe_rung_failures', '');
      failures = raw ? JSON.parse(raw) : {};
    } catch { failures = {}; }
    return computeProbeSkipStart(chain, failures, Date.now());
  } catch { return 0; }
}

// Caller-facing model call. onToken (optional) streams a Groq or
// OpenRouter rung through callGroqStream / callOpenRouterStream instead
// of the non-streaming call — used only by the owner-DM streaming path;
// every other caller passes nothing and takes the exact old path.
async function callModel(target, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature, onToken = null) {
  if (target.provider === 'gemini') {
    const key = await getConfig('GEMINI_API_KEY');
    if (!key) throw new Error('GEMINI_API_KEY not configured');
    return callGemini(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
  }
  if (target.provider === 'xai') {
    const key = await getConfig('XAI_API_KEY');
    if (!key) throw new Error('XAI_API_KEY not configured');
    return callXai(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
  }
  if (target.provider === 'groq') {
    const key = await getConfig('GROQ_API_KEY');
    if (!key) throw new Error('GROQ_API_KEY not configured');
    return onToken
      ? callGroqStream(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature, onToken)
      : callGroq(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
  }
  if (target.provider === 'workersai') {
    const token = await getConfig('CLOUDFLARE_API_TOKEN');
    const accountId = await getConfig('CLOUDFLARE_ACCOUNT_ID');
    if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not configured');
    return callWorkersAI(target.model, token, accountId, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
  }
  if (target.provider === 'mistral') {
    const key = await getConfig('MISTRAL_API_KEY');
    if (!key) throw new Error('MISTRAL_API_KEY not configured');
    return callMistral(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
  }
  const key = await getConfig('OPENROUTER_API_KEY');
  if (!key) throw new Error('OPENROUTER_API_KEY not configured');
  return onToken
    ? callOpenRouterStream(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature, onToken)
    : callOpenRouter(target.model, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
}

// ── KIMI HEAVY ROUTE (2026-11-04, Rowdy tap) ─────────────────────────────
// Kimi K3.1 Pro as an OFF-BY-DEFAULT heavy-jobs route — NOT a ladder rung.
// It never enters MODELS, LADDER_EXTRA_RUNGS, or resolveChain, so the
// normal free-first ladder order is identical with the flag on or off,
// and normal chats can never reach it: only call sites that explicitly
// opt in (Script Council 4th candidate, askBrain useKimiHeavy) ever call
// askKimiHeavy, and askKimiHeavy returns null unless the flag is on.
// Flag key is UPPERCASE so /setkey (which uppercases) stores exactly
// the key read here: /setkey KIMI_HEAVY_ENABLED 1 to enable,
// /setkey KIMI_HEAVY_ENABLED 0 (or unset) to disable. Default OFF.
// Provider is the existing live OpenRouter key path — no Moonshot key.
// Spend books to llm_ledger surface 'kimi_heavy' at book rates; the
// $10/day brain ceiling is a stop-cold + page policy, not an automated
// gate, so Kimi spend is counted but not auto-blocked (see plan).
export const KIMI_HEAVY_MODEL = 'moonshotai/kimi-k3.1-pro';
export const KIMI_HEAVY_FLAG_KEY = 'KIMI_HEAVY_ENABLED';
// Documented test seam (same precedent as __setLlmFetchForTest above):
// null in production. When set, kimiHeavyEnabled answers from memory so
// the in-isolate harness can prove the flag-ON path without writing a
// live config row (a live row could leak flag=ON to a concurrent tick).
// Never set outside the harness.
let _kimiFlagOverride = null;
export function __setKimiFlagForTest(v) { _kimiFlagOverride = v ?? null; }
export async function kimiHeavyEnabled() {
  if (_kimiFlagOverride !== null) return _kimiFlagOverride;
  try {
    return flagValueOn(await getConfig(KIMI_HEAVY_FLAG_KEY, null));
  } catch {
    return false; // config unreadable => fail closed, no Kimi calls
  }
}
/**
 * Heavy-jobs Kimi call. Returns the model text, or null when the flag is
 * off (caller falls back to its normal path). Throws on a missing key or
 * a failed provider call (caller falls back to its normal path). Never
 * called by the normal ladder; only explicit heavy-job opt-ins call it.
 */
export async function askKimiHeavy(opts = {}) {
  const { systemPrompt, userMessage, history = [], maxOutputTokens = 8192, timeoutMs = 45_000, temperature } = opts;
  if (!(await kimiHeavyEnabled())) return null;
  const key = await getConfig('OPENROUTER_API_KEY');
  if (!key) throw new Error('KIMI heavy route requires OPENROUTER_API_KEY');
  const startedAt = Date.now();
  const res = await callOpenRouter(KIMI_HEAVY_MODEL, key, systemPrompt, userMessage, history, maxOutputTokens, timeoutMs, temperature);
  const book = await priceBook();
  const cost = priceUsd(book, 'openrouter', KIMI_HEAVY_MODEL, res.tokensIn, res.tokensOut);
  await writeLedger({
    surface: 'kimi_heavy', provider: 'openrouter', model: KIMI_HEAVY_MODEL, rungReason: 'heavy',
    tokensIn: res.tokensIn, tokensOut: res.tokensOut,
    estPaidEquivUsd: cost, actualCostUsd: cost,
    outcome: 'ok', latencyMs: Date.now() - startedAt,
  });
  return res.text;
}

export async function askLLM(opts) {
  const {
    systemPrompt,
    userMessage,
    history = [],
    tier = 'chat',
    maxOutputTokens = 8192,
    timeoutMs = 45_000,
    temperature,
    meta,
    // Ledger surface override (2026-10-23): defaults to the tier. The
    // tick's synthetic answer-path probe passes 'probe' so its calls
    // bookkeep separately from member chat while running the same
    // chat ladder.
    surface = null,
    // SCRIPT COUNCIL seam (W1A, 2026-10-22): pin this call to ONE rung —
    // { scope } matches a scoped rung, { provider, model } an exact rung,
    // { provider } the provider's first rung. The pinned call still runs
    // the full quota / circuit-breaker / ledger plumbing below; it just
    // never fails over and never retries, so concurrent council members
    // each speak for exactly one ladder model.
    singleRung = null,
    // 20:54 FIX (2026-10-27): replay attempts rotate the ladder start
    // so one hung provider cannot wedge every retry. The rotation
    // reorders the SAME chain (same rungs, quota, breaker, ledger);
    // free-first holds within each attempt. Default 0 = original order.
    ladderStartIndex = 0,
    // PB STREAMING REPLIES (2026-11-06, OpenRouter extension same day):
    // optional per-content-token callback. When set, a Groq or
    // OpenRouter rung streams through callGroqStream /
    // callOpenRouterStream and delivers its content tokens here; every
    // other rung and every caller without it takes the exact old path.
    onToken = null,
  } = opts;
  let chain = await resolveChain(tier);
  if (singleRung) {
    chain = chain.filter((r) => {
      if (singleRung.scope) return rungScope(r) === singleRung.scope;
      if (singleRung.provider && singleRung.model) return r.provider === singleRung.provider && r.model === singleRung.model;
      if (singleRung.provider) return r.provider === singleRung.provider;
      return false;
    }).slice(0, 1);
    if (!chain.length) {
      throw new Error(`council rung unavailable: ${singleRung.scope ?? singleRung.provider ?? '?'}`);
    }
  }
  if (!chain.length) throw new Error(`no LLM provider configured for tier ${tier}`);
  // 20:54 FIX: rotate the chain for replay attempts. priceRef keeps the
  // ledger's estPaidEquivUsd basis on the pre-rotation first rung, so
  // rotation never silently shifts the estimate basis (the two ledger
  // writes below use priceRef, not chain[0]).
  const priceRef = chain[0];
  const start = ((Number(ladderStartIndex) || 0) % chain.length + chain.length) % chain.length;
  if (start) chain = [...chain.slice(start), ...chain.slice(0, start)];
  const book = await priceBook();
  const bSettings = await breakerSettings();
  // M2 (Wave 2): honor trips persisted by other isolates before routing.
  // Hydration is once-per-isolate-per-scope and never throws (a config
  // read failure falls back to memory-only behavior, as before).
  await hydrateBreakers(chain.map((r) => rungScope(r)));
  const startedAt = Date.now();
  let lastErr = null;

  const runLadder = async () => {
  let failedRungs = 0;
  for (let i = 0; i < chain.length; i++) {
    const rung = chain[i];
    const isPrimary = i === 0;
    const isLast = i === chain.length - 1;
    const label = `${rung.provider}:${rung.model}`;
    const rungReason = isPrimary ? 'primary' : 'failover';
    const nextLabel = i + 1 < chain.length ? `${chain[i + 1].provider}:${chain[i + 1].model}` : null;

    if (await quotaExhausted(rungScope(rung), rung.provider)) {
      console.warn(`[LLM] ${label} skipped — daily quota exhausted`);
      await writeLedger({ surface: surface ?? tier, provider: rung.provider, model: rung.model, rungReason, tokensIn: 0, tokensOut: 0, estPaidEquivUsd: 0, actualCostUsd: 0, outcome: 'quota_exhausted', latencyMs: 0 });
      continue;
    }
    if (!breakerAllows(rungScope(rung))) {
      console.warn(`[LLM] ${label} skipped — circuit open`);
      continue;
    }
    // TPM GUARD (2026-10-27 brain-glitch fix): skip a Groq rung the
    // prompt cannot fit — same skip shape as quota/breaker above, so
    // it never reaches failedRungs++ and never eats the fail cap.
    const tpmEst = estTokensIn(systemPrompt, userMessage, history);
    if (rung.provider === 'groq' && tpmEst > GROQ_TPM_SKIP_AT) {
      console.warn(`[LLM] ${label} skipped — prompt ~${tpmEst} tokens over Groq TPM ${GROQ_TPM_LIMIT}`);
      await writeLedger({ surface: surface ?? tier, provider: rung.provider, model: rung.model, rungReason, tokensIn: tpmEst, tokensOut: 0, estPaidEquivUsd: 0, actualCostUsd: 0, outcome: 'tpm_skipped', latencyMs: 0 });
      continue;
    }
    const maxAttempts = singleRung ? 1 : (isLast ? 3 : 1);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptAt = Date.now();
      try {
        // Per-rung race (2026-10-25): callModel's own timeout relies on
        // AbortController, which the isolate lacks — without this race a
        // hung rung hangs the ladder forever. The race rejection carries
        // 'timeout', so the catch below fails over like any retryable
        // error. Same millisecond values as before; now enforced.
        const rungTimeoutMs = isPrimary ? timeoutMs : Math.min(timeoutMs, 9_000);
        const res = await withTimeout(
          callModel(rung, systemPrompt, userMessage, history, maxOutputTokens, rungTimeoutMs, temperature, onToken),
          rungTimeoutMs, `${label} rung`);
        breakerRecord(rungScope(rung), true, bSettings);
        await bumpQuota(rungScope(rung), res.tokensIn + res.tokensOut);
        await writeLedger({
          surface: surface ?? tier, provider: rung.provider, model: rung.model, rungReason,
          tokensIn: res.tokensIn, tokensOut: res.tokensOut,
          estPaidEquivUsd: priceUsd(book, priceRef.provider, priceRef.model, res.tokensIn, res.tokensOut),
          actualCostUsd: PAID_PROVIDERS.has(rung.provider) ? priceUsd(book, rung.provider, rung.model, res.tokensIn, res.tokensOut) : 0,
          outcome: 'ok', latencyMs: Date.now() - attemptAt,
        });
        if (meta) meta.modelUsed = label;
        return res.text || 'No response generated.';
      } catch (err) {
        lastErr = err;
        // Hang-protection R5: report attempted-and-failed rungs to the
        // caller via meta (the tick probe consumes this). Quota /
        // breaker / TPM skips use `continue` above and never reach
        // here, so only genuinely attempted rungs are reported.
        // Deduped: the last rung retries up to 3 times per call.
        if (meta) {
          const labels = (meta.failedRungLabels ??= []);
          if (!labels.includes(label)) labels.push(label);
        }
        const status = err?.status;
        const errMsg = String(err?.message ?? err ?? '');
        const tokensIn = estTokensIn(systemPrompt, userMessage, history);
        await bumpQuota(rungScope(rung), 0);
        await writeLedger({
          surface: surface ?? tier, provider: rung.provider, model: rung.model, rungReason,
          tokensIn, tokensOut: 0,
          estPaidEquivUsd: priceUsd(book, priceRef.provider, priceRef.model, tokensIn, 0),
          actualCostUsd: 0, outcome: 'error', latencyMs: Date.now() - attemptAt,
        });
        // Task 2 (2026-10-26): stamp the failure class (status/label
        // only) so the owner snapshot can name it — see recordLlmErrorClass.
        await recordLlmErrorClass(rung.provider, status, errMsg);
        if (/not configured/.test(errMsg)) {
          // Key vanished between resolution and call — skip the rung
          // silently (not an auth rejection), as the old pair did.
          breakerRelease(rungScope(rung));
          if (isPrimary) console.warn(`[LLM] ${label} not configured — using ${nextLabel ?? 'no further rung'}`);
          break;
        }
        if (isAuthError(status, errMsg)) {
          console.error(`[LLM] ${label} auth error — failing over to ${nextLabel ?? 'no further rung'}: ${errMsg}`);
          await alertOwnerAuthError(rung.provider, rung.model, errMsg);
          breakerRecord(rungScope(rung), false, bSettings);
          break;
        }
        if (!isRetryable(status, errMsg)) {
          // ANSWER-PATH FIX (2026-10-23): a non-retryable error kills
          // this RUNG, not the ladder — fall through exactly like a
          // retryable failure. No breaker record: the breaker counts
          // retryable failures only, as before. On the last rung the
          // attempt loop simply ends and the post-loop throw surfaces
          // lastErr — the ladder is exhausted, which is the only way
          // askLLM throws now.
          console.error(`[LLM] ${label} failed (non-retryable) — failing over to ${nextLabel ?? 'no further rung'}: ${errMsg}`);
          break;
        }
        breakerRecord(rungScope(rung), false, bSettings);
        if (status === 429 && RUNGS[rung.provider]?.dailyCalls) await markExhausted(rungScope(rung));
        if (!isLast) {
          console.warn(`[LLM] ${label} failed (${errMsg}) — failing over to ${nextLabel}`);
          break;
        }
        if (attempt >= maxAttempts - 1 || Date.now() - startedAt > 26_000) break;
        console.warn(`[LLM] ${label} failed (${errMsg}) — retrying (attempt ${attempt + 2}/${maxAttempts})`);
        await sleepMs(900 * (attempt + 1));
      }
    }
    // PB-chat big fix (2026-10-26): rung-count cap. Timers are absent
    // in the isolate, so wall-clock races cannot bound a cascade —
    // count failed rungs instead. After 5 failed rungs on the chat
    // tier, throw so the caller's catch path stamps brain-error and
    // sends the visible glitch reply. A visible failure beats silence.
    // Skipped rungs (quota/breaker/TPM `continue` above) never reach
    // this line, so they do not count — only attempted-and-failed
    // rungs. Single-rung council calls are exempt (one-rung chain by
    // design). CAP 3→5 (2026-10-27 brain-glitch fix): with the TPM
    // guard skipping both Groq rungs on full prompts, cap 3 left only
    // one real free attempt (gemini) before throwing; cap 5 reaches
    // openrouter (4th) and mistral (5th). xAI stays last-resort: it is
    // attempted only when every free rung genuinely fails, which is
    // exactly the designed emergency case — free-first still holds.
    failedRungs++;
    if (tier === 'chat' && !singleRung && failedRungs >= 5) {
      throw lastErr ?? new Error('all LLM rungs unavailable');
    }
  }
  throw lastErr ?? new Error('all LLM rungs unavailable');
  };
  // Overall chat budget (2026-10-25): per-rung races bound each rung,
  // but a chain of hanging rungs could still exceed the platform's
  // invocation bound and die silent (the 09:11 group-message case).
  // Chat replies get a hard 55s total: above the slowest observed chat
  // answer (28s), below the presumed ~60s platform bound, and long
  // enough for one hung-primary failover (45s + 9s). Exceeding it
  // rejects visibly (brain-error stamp + glitch reply) instead of
  // silence. Other tiers (decide, bulk) keep their existing behavior,
  // as do pinned single-rung council calls.
  if (tier === 'chat' && !singleRung) return await withTimeout(runLadder(), 55_000, 'chat ladder');
  return await runLadder();
}

// ── SCRIPT COUNCIL (Studio Upgrade W1A, 2026-10-22) ───────────────────────
// When a Studio video script is generated, up to THREE candidate scripts
// are drafted concurrently by DIFFERENT ladder models — the chat primary
// (xAI Grok), the scoped Groq Kimi rung, and the OpenRouter free catch-all
// — each through askLLM's singleRung seam, so every attempt keeps its
// quota / circuit-breaker checks and writes its llm_ledger row with the
// TRUE serving provider+model. A DETERMINISTIC scorer (no extra LLM call)
// picks the winner; ties go to the primary's draft (candidates are kept
// in ladder order and only a strictly higher score displaces the leader).
// Fail-open by contract: any rung may be unavailable (fewer candidates),
// duplicates on (provider, model) are dropped keeping the first, and a
// total council failure returns null so the caller falls back to the
// pre-council single-script path — job creation never breaks here.

export const COUNCIL_SCORER_VERSION = 'council-scorer-v1';

const COUNCIL_RUNGS = [
  { key: 'primary', singleRung: { provider: 'xai' } },
  { key: 'groq_kimi', singleRung: { scope: 'groq:moonshotai/kimi-k2-instruct-0905' } },
  { key: 'openrouter_free', singleRung: { provider: 'openrouter', model: 'openrouter/free' } },
];

const COUNCIL_HOOK_WORDS = new Set([
  'stop', 'get', 'watch', 'check', 'meet', 'join', 'discover', 'start',
  'see', 'look', 'try', 'grab', 'unlock', 'listen', 'introducing',
  'ready', 'imagine', 'want', 'need', 'dont', "don't", 'never',
]);

/** Banned-claim detector for the council scorer. Returns hit labels. */
export function councilBannedClaims(text) {
  const t = String(text ?? '');
  const hits = [];
  if (/\bguaranteed?\b/i.test(t) && /\b(returns?|profits?|gains?|income)\b/i.test(t)) hits.push('guaranteed returns/profit');
  if (/\brisk[-\s]?free\b/i.test(t)) hits.push('risk-free');
  let multiX = false;
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?)\s?x\b/gi)) { if (Number(m[1]) >= 10) multiX = true; }
  if (!multiX) { const m = /\bx\s?(\d{2,})\b/i.exec(t); if (m && Number(m[1]) >= 10) multiX = true; }
  if (multiX) hits.push('multi-x return promise');
  if (/\b(price\s+(target|prediction|forecast)|target\s+price|price\s+prediction)\b/i.test(t)
    || /\bwill\s+(hit|reach|go\s+to)\s+\$?\d/i.test(t)
    || /\bpredict\w*\b[^.!?]{0,40}\$\s?\d/i.test(t)) hits.push('price prediction/target');
  if (/\bwill\s+(moon|pump)\b/i.test(t)) hits.push('will moon/pump');
  return hits;
}

function councilHasCta(text) {
  const raw = String(text ?? '').toLowerCase();
  const spoken = raw.replace(/\./g, ' dot ');
  const needles = ['poorboyai.pages.dev', 'poorboyai dot pages dot dev', 't.me/poorboyai_bot', '@poorboyai_bot'];
  return needles.some((n) => raw.includes(n) || spoken.includes(n));
}

/**
 * Deterministic Studio script scorer (pure, no LLM call).
 *   Word-count fit (40): target ≈ durationSec × 2.45 words; full marks
 *     inside the sweet band (target × 0.87 … × 1.09 — 15s ≈ 32–40 words),
 *     decaying linearly with distance outside it.
 *   Hook (25): the opening ~6 words carry a question, an imperative
 *     opener, or a number/stat.
 *   CTA (25): the site domain or bot handle, written or TTS-spoken.
 *   Banned claims: −50 per claim AND the total is capped below zero, so
 *     a draft carrying a banned claim scores below ANY clean draft
 *     (clean drafts floor at 0).
 * Returns the full breakdown; `.score` is the comparable number.
 */
export function scoreStudioScript(script, durationSec = 15) {
  const text = String(script ?? '').replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').filter(Boolean) : [];
  const wc = words.length;
  const dur = Number(durationSec) > 0 ? Number(durationSec) : 15;
  const target = dur * 2.45;
  const bandLow = target * 0.87;
  const bandHigh = target * 1.09;
  let fit = 0;
  if (wc > 0 && wc >= bandLow && wc <= bandHigh) fit = 40;
  else if (wc > 0) {
    const dist = wc < bandLow ? bandLow - wc : wc - bandHigh;
    fit = Math.max(0, 40 * (1 - (dist / target) * 2));
  }
  const openingWords = words.slice(0, 6);
  const opening = openingWords.join(' ');
  const firstWord = (openingWords[0] ?? '').replace(/[^A-Za-z']/g, '').toLowerCase();
  const hook = opening.includes('?')
    || COUNCIL_HOOK_WORDS.has(firstWord)
    || openingWords.some((w) => /\d/.test(w) || w.includes('$') || w.includes('%'));
  const cta = councilHasCta(text);
  const banned = councilBannedClaims(text);
  let score = fit + (hook ? 25 : 0) + (cta ? 25 : 0);
  if (banned.length) score = Math.min(score - 50 * banned.length, -1);
  return {
    score: Math.round(score * 10) / 10,
    wordCount: wc,
    targetWords: Math.round(target * 10) / 10,
    band: [Math.round(bandLow), Math.round(bandHigh)],
    fit: Math.round(fit * 10) / 10,
    hook, cta, banned,
    scorerVersion: COUNCIL_SCORER_VERSION,
  };
}

/**
 * Run the script council for one Studio script prompt. Returns
 * { candidates: [{provider, model, script, score}], winnerIndex,
 *   winnerScript, scorerVersion } — or null when every rung failed
 * (the caller then uses the single-script path, exactly as before).
 * deps.generateCandidate(spec, index) is the documented test seam: it
 * replaces the real rung call (returning {text, provider, model} or a
 * string) so the harness can force rung failures without touching
 * production config. Never throws.
 */
export async function runScriptCouncil(opts, deps = {}) {
  try {
    const { systemPrompt, userMessage, durationSec = 15, maxOutputTokens = 400, timeoutMs = 14_000 } = opts ?? {};
    const generate = deps.generateCandidate ?? opts?.generateCandidate ?? null;
    const make = async (spec, idx) => {
      if (generate) {
        const r = await generate(spec, idx);
        if (typeof r === 'string') {
          return { text: r, provider: spec.singleRung.provider ?? 'test', model: spec.singleRung.model ?? spec.key };
        }
        return { text: r?.text ?? r?.script ?? '', provider: r?.provider ?? 'unknown', model: r?.model ?? 'unknown' };
      }
      // KIMI HEAVY (2026-11-04): the flagged 4th candidate runs through
      // askKimiHeavy, never singleRung (singleRung can only pin models
      // already in the resolved chain, and Kimi is deliberately not one).
      if (spec.kimiHeavy) {
        const text = await askKimiHeavy({ systemPrompt, userMessage, history: [], maxOutputTokens, timeoutMs });
        if (!text) throw new Error('kimi heavy unavailable');
        return { text, provider: 'openrouter', model: KIMI_HEAVY_MODEL };
      }
      const meta = {};
      const text = await askLLM({
        systemPrompt, userMessage, history: [], tier: 'chat',
        maxOutputTokens, timeoutMs, meta, singleRung: spec.singleRung,
      });
      const label = String(meta.modelUsed ?? '');
      const ci = label.indexOf(':');
      return {
        text,
        provider: ci > 0 ? label.slice(0, ci) : (spec.singleRung.provider ?? 'unknown'),
        model: ci > 0 ? label.slice(ci + 1) : (spec.singleRung.model ?? 'unknown'),
      };
    };
    // KIMI HEAVY (2026-11-04): a 4th candidate ONLY when the flag is on.
    // Flag off (default) => the original 3 rungs, byte-identical behavior.
    const rungs = [...COUNCIL_RUNGS];
    if (await kimiHeavyEnabled()) rungs.push({ key: 'kimi_heavy', kimiHeavy: true });
    const settled = await Promise.allSettled(rungs.map((s, i) => make(s, i)));
    const seen = new Set();
    const candidates = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      const clean = String(s.value?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      if (!clean) continue;
      const provider = String(s.value.provider ?? 'unknown');
      const model = String(s.value.model ?? 'unknown');
      const dedupeKey = provider + ':' + model;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push({ provider, model, script: clean, score: scoreStudioScript(clean, durationSec).score });
    }
    if (!candidates.length) return null;
    let winnerIndex = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].score > candidates[winnerIndex].score) winnerIndex = i;
    }
    return {
      candidates, winnerIndex,
      winnerScript: candidates[winnerIndex].script,
      scorerVersion: COUNCIL_SCORER_VERSION,
    };
  } catch { return null; }
}

// ── Gap-2: voice-note replies ───────────────────────────────────────────────
// PB's answers stay text-first; voice is an additive follow-up the user
// asks for — a 🔊 Hear it button under DM answers, plus a /voice auto-read
// toggle. Synthesis runs DIRECT from this isolate to the providers: xAI
// TTS primary (the same key + trust path as the brain above), Gemini TTS
// fallback on the bot's existing Gemini key. The pages.dev bridge is
// deliberately NOT used — it exists for a host-systemd egress stall and
// in-isolate would only add a hop (spec PB-GROKBOT-GAPS-SPEC.md §2C).
//
// Format (pre-build live probe, 2026-10-21): POST /v1/tts accepts
// output_format {codec:'opus'} → audio/opus Ogg bytes, so xAI notes ship
// as TRUE sendVoice bubbles; the Gemini fallback returns WAV → sendAudio.
// Copy says "voice note" — Telegram bots cannot take or join calls, and
// PB never claims to be on one.
//
// The original Replit bot had a voice layer (botvox.ts: OpenAI gpt-audio,
// voice "fable", opus → sendVoice) — but its key was a Replit-internal
// dummy, deliberately never migrated, and no OpenAI key exists in PB's
// config. So the provider pair is the spec's xAI/Gemini; what carries
// over from botvox is the discipline: cleanForSpeech, fire-and-forget,
// text always first. (botvox also had per-chat voice language —
// translate-and-read in the group's language. Beyond Gap 2's DM-v1
// scope; noted in BUILD_NOTES for a later wave, NOT built here.)
//
// Gates (spec defaults): xAI voice = Builder+, Gemini voice = Starter+.
// Free tier sees the button but gets the gate copy; zero provider calls.
// Caps: at most 800 chars per note, truncated at a sentence boundary;
// one synthesis in flight per user. Every function in this section NEVER
// throws — a voice failure can never cost the user their text answer.

const XAI_TTS_URL = 'https://api.x.ai/v1/tts';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = 'Charon'; // PB's Studio professional/podcast voice — one voice across products
const VOICE_MAX_CHARS = 800;
const VOICE_PENDING_TTL_MS = 30 * 60 * 1000; // the nlcmd pending-state discipline
const VOICE_BODY_CAP = 8 * 1024 * 1024;

const voicePendingKey = (tgId) => `voice_pending_${tgId}`;
const voiceAutoKey = (tgId) => `voice_auto_${tgId}`;

// Documented test seam (the __setAgentSkillRunner precedent in
// lib/nlcmd.js): null in production. When set, synthesizeReplyVoice
// routes its provider HTTP through the supplied (url, init) => response
// function so the in-isolate harness can stub transports at the fetch
// seam. Never set outside the harness.
let _voiceFetchOverride = null;
export function __setVoiceFetchForTest(fn) { _voiceFetchOverride = fn ?? null; }
const voiceFetch = (url, init) => (_voiceFetchOverride ? _voiceFetchOverride(url, init) : fetch(url, init));

// ── Ears: inbound voice-note transcription (Wave 5, 2026-11-06) ─────────────
// Rowdy's words (board 574): PB should understand voice notes people send.
// Groq Whisper is the free-first fit: GROQ_API_KEY is already a live brain
// rung, whisper-large-v3-turbo is on Groq's free tier, and no new key,
// hosting, or paid STT is involved. Gemini audio input is the documented
// fallback if Groq ever drops the model — NOT built here (one provider,
// fail-closed). Multipart body mirrors repurpose.js buildMultipartBody
// (proven in-isolate: TextEncoder + Uint8Array concat, Uint8Array body
// straight into the sdk fetch). NEVER throws for a missing key or a bad
// response — callers map { ok:false } to the "couldn't hear that" reply.
const GROQ_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_STT_MAX_BYTES = 25 * 1024 * 1024; // Groq's per-file limit

function buildSttMultipartBody(bytes, boundary) {
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${GROQ_STT_MODEL}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`),
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
    bytes,
    enc.encode(`\r\n--${boundary}--\r\n`),
  ];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Transcribe one Telegram voice-note's bytes with Groq Whisper.
 * Returns { ok:true, text } or { ok:false, reason } — never throws.
 * Reasons: no_key | empty | too_large | transport | http_<status> |
 * bad_response. The llmFetch seam (__setLlmFetchForTest) routes the call
 * in the harness.
 */
export async function transcribeVoiceNote(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (!data.length) return { ok: false, reason: 'empty' };
  if (data.length > GROQ_STT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const key = await getConfig('GROQ_API_KEY').catch(() => null);
  if (!key) return { ok: false, reason: 'no_key' };
  const boundary = '----PBSttBoundary' + Date.now().toString(36) + Math.floor(Math.random() * 1e12).toString(36);
  let res;
  try {
    res = await withTimeout(llmFetch(GROQ_STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: buildSttMultipartBody(data, boundary),
    }), 60_000, 'groq-stt');
  } catch (err) {
    return { ok: false, reason: 'transport' };
  }
  if (!res?.ok) return { ok: false, reason: `http_${res?.status ?? 'unknown'}` };
  const json = await res.json().catch(() => null);
  const text = String(json?.text ?? '').trim();
  if (!text) return { ok: false, reason: 'bad_response' };
  return { ok: true, text };
}

/** Read a fetch body fully via the stream reader (sdk fetch has no arrayBuffer()). */
async function collectBodyBytes(res, cap = VOICE_BODY_CAP) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const c = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += c.length;
    if (total > cap) throw new Error('voice response too large');
    chunks.push(c);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** One retry on a thrown transport failure only — an HTTP answer is a
 *  definitive answer and never retries (the Batch-4 rule), so a retry
 *  can never double-bill a completed generation. */
async function voiceFetchRetry(url, init) {
  try {
    return await voiceFetch(url, init);
  } catch (err) {
    if (!isRetryable(null, String(err?.message ?? err ?? ''))) throw err;
    return await voiceFetch(url, init);
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Base64 → bytes without host globals (the isolate has no Buffer). */
function base64ToBytes(b64) {
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

/** Wrap raw L16 PCM (Gemini TTS default: audio/L16;rate=24000 mono) in a WAV header. */
function pcmToWavBytes(pcm, sampleRate = 24000) {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  writeStr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  writeStr(36, 'data'); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Speech cleaning, ported from the original bot's voice layer
 * (botvox.ts cleanForSpeech): strip URLs, MarkdownV2 escapes, markdown
 * emphasis characters and @mentions so TTS reads clean prose — not
 * asterisks, backslashes and link gibberish. (The original hard-sliced
 * at 600 chars; the spec's cap is 800 via truncateForVoice below, which
 * also cuts at a sentence boundary instead of mid-word.)
 */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\\([_*[\]()~`>#+=|{}.!-])/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/@\w+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Cap a reply for one voice note: at most VOICE_MAX_CHARS, cut at the
 * last sentence boundary inside the window (never below half the cap,
 * so a leading abbreviation can't shrink the note to a fragment).
 */
export function truncateForVoice(text, max = VOICE_MAX_CHARS) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return { text: t, truncated: false };
  const win = t.slice(0, max);
  let cut = -1;
  for (let i = win.length - 1; i >= Math.floor(max / 2); i--) {
    if ('.!?…'.includes(win[i]) && (i + 1 >= win.length || /\s/.test(win[i + 1]))) { cut = i + 1; break; }
  }
  if (cut < 0) {
    const sp = win.lastIndexOf(' ');
    cut = sp > Math.floor(max / 2) ? sp : max;
  }
  return { text: win.slice(0, cut).trim(), truncated: true };
}

async function callXaiTts(spokenText, key, language = 'en') {
  const res = await voiceFetchRetry(XAI_TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      // voice_id 'rex' — a man's voice (Rowdy directive, 2026-10-21;
      // 'eve'/'ara' are female and rejected). 'leo' is the proven
      // fallback if rex ever disappears (both live-probed 2026-10-21).
      // Batch 2: language accepts TTS codes only — a group display name
      // ('Spanish') falls back to 'en' until a display→code map exists.
      text: spokenText, voice_id: 'rex', language: /^[a-z]{2}(-[A-Z]{2})?$/.test(language ?? '') ? language : 'en',
      output_format: { codec: 'opus' }, // live-probed 2026-10-21 → audio/opus
    }),
  });
  const contentType = String(res.headers?.get?.('content-type') ?? '');
  if (!res.ok || /json/i.test(contentType)) return null;
  const bytes = await collectBodyBytes(res);
  if (!bytes.length) return null;
  // Trust but verify the container: OggS magic → a true voice note;
  // anything else (the provider ignoring the codec) rides sendAudio.
  const isOgg = bytes.length > 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
  return { bytes, mime: isOgg ? 'audio/opus' : 'audio/mpeg', provider: 'xai' };
}

async function callGeminiTts(spokenText, key) {
  // RETRY-ON-EMPTY (2026-10-25): Gemini sometimes answers 200 with no
  // audio part — a transient empty, not a real failure. Re-POST once
  // before giving up, so a voice note isn't lost to one empty body.
  // HTTP errors (!res.ok) are NOT retried here — voiceFetchRetry owns
  // transport retries; only the 200-empty case loops.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await voiceFetchRetry(GEMINI_URL(GEMINI_TTS_MODEL, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: spokenText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } } },
        },
      }),
    });
    if (!res.ok) return null;
    const bodyBytes = await collectBodyBytes(res);
    const data = JSON.parse(new TextDecoder().decode(bodyBytes));
    const part = data?.candidates?.[0]?.content?.parts?.find((p) => p?.inlineData?.data);
    if (!part) continue;
    const raw = base64ToBytes(part.inlineData.data);
    if (!raw.length) continue;
    const mime = String(part.inlineData.mimeType ?? '');
    const isWav = /wav/i.test(mime)
      || (raw.length > 4 && raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46); // 'RIFF'
    if (isWav) return { bytes: raw, mime: 'audio/wav', provider: 'gemini' };
    const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000) || 24000;
    return { bytes: pcmToWavBytes(raw, rate), mime: 'audio/wav', provider: 'gemini' };
  }
  return null;
}

/**
 * Synthesize one voice note for a reply. `provider` is the caller's
 * tier-decided STARTING provider: 'xai' runs xAI → Gemini fallback;
 * 'gemini' runs Gemini only (the Starter path never touches xAI).
 * Returns { bytes, mime, provider, truncated, spokenText } or null.
 * NEVER throws.
 */
export async function synthesizeReplyVoice(text, { provider = 'xai', language = 'en' } = {}) {
  try {
    const { text: spoken, truncated } = truncateForVoice(cleanForSpeech(text));
    if (!spoken) return null;
    const order = provider === 'gemini' ? ['gemini'] : ['xai', 'gemini'];
    for (const p of order) {
      try {
        const key = await getConfig(p === 'xai' ? 'XAI_API_KEY' : 'GEMINI_API_KEY');
        if (!key) continue;
        const got = p === 'xai' ? await callXaiTts(spoken, key, language) : await callGeminiTts(spoken, key);
        if (got) return { ...got, truncated, spokenText: spoken };
      } catch (err) {
        console.warn(`[voice] ${p} TTS failed: ${String(err?.message ?? err).slice(0, 160)}`);
      }
    }
    return null;
  } catch { return null; }
}

// ── Voice gates + pending state ─────────────────────────────────────────────

/** The caller's stored tier value (owner → 'whale', mirrors effectiveTier). */
async function voiceTierOf(userId) {
  try {
    const owners = String(await getConfig('TELEGRAM_OWNER_ID', ''))
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (owners.includes(String(userId))) return 'whale';
    const row = await db.select().from(bot_users)
      .where(eq(bot_users.telegramUserId, String(userId))).get();
    return String(row?.tier ?? 'free').toLowerCase().trim() || 'free';
  } catch { return 'free'; }
}

/** 'xai' (Builder+) | 'gemini' (Starter+) | null (free — gate copy). */
async function voiceProviderFor(userId) {
  const tier = await voiceTierOf(userId);
  if (tierAtLeast(tier, 'builder')) return 'xai';
  if (tierAtLeast(tier, 'starter')) return 'gemini';
  return null;
}

// The skill-gate copy pattern (lib/skills.js gateMsg), Starter+ label.
const VOICE_GATE_TEXT =
  '⛔ Starter+ Required\n\n/voice is available on Starter+ plans and above. The PB Plan ($29/month) unlocks everything.\n\nUpgrade with /upgrade.';

async function readVoiceState(tgId) {
  try {
    const raw = await getConfig(voicePendingKey(tgId), '');
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.askedAt || Date.now() - Number(o.askedAt) > VOICE_PENDING_TTL_MS) return null;
    return o;
  } catch { return null; }
}

async function writeVoiceState(tgId, state) {
  try { await setConfig(voicePendingKey(tgId), state ? JSON.stringify(state) : ''); } catch { /* best effort */ }
}

/**
 * Stash a DM answer for the 🔊 button and return the reply_markup to
 * attach to the answer message itself (null when there is nothing to
 * voice). The button carries a token for THIS answer: only the newest
 * answer's button is live — an older button answers honestly that it
 * expired instead of voicing the wrong text. NEVER throws.
 */
export async function prepareVoiceAnswer(tgId, chatId, answerText) {
  try {
    const text = String(answerText ?? '').trim().slice(0, 4000);
    if (!tgId || chatId == null || !text) return null;
    const token = Date.now().toString(36);
    await writeVoiceState(tgId, { text, chatId: String(chatId), token, askedAt: Date.now(), inflight: false });
    return { inline_keyboard: [[{ text: '🔊 Hear it', callback_data: `voice:hear:${token}` }]] };
  } catch { return null; }
}

async function sendVoiceNote(chatId, res, truncated) {
  const caption = truncated ? '🎧 First part only — the full text is above.' : undefined;
  if (res.mime === 'audio/opus') {
    await api.sendVoice({
      chat_id: chatId,
      voice: new InputFile(res.bytes, 'pb-voice.ogg', { type: 'audio/opus' }),
      ...(caption ? { caption } : {}),
    });
    return;
  }
  await api.sendAudio({
    chat_id: chatId,
    audio: new InputFile(res.bytes, res.mime === 'audio/mpeg' ? 'pb-voice.mp3' : 'pb-voice.wav', { type: res.mime }),
    title: 'PB voice note', performer: 'PoorBoyAI',
    ...(caption ? { caption } : {}),
  });
}

/**
 * The 🔊 Hear it tap. DM only, tapper must own the stashed answer
 * (state is keyed by the answer recipient's id and bound to the DM chat
 * + this answer's token). Answers the callback exactly once, after the
 * synthesis resolves, so a failure lands as the quiet failure copy.
 * A successful note CONSUMES the state — a re-tap can never re-bill a
 * synthesis; the audio message itself stays in chat for replays.
 */
export async function handleVoiceCallback(query, token) {
  const from = query?.from ?? {};
  const chatId = query?.message?.chat?.id;
  const answerOnce = async (text, alert = false) => {
    try {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        ...(text ? { text: String(text).slice(0, 200), show_alert: alert } : {}),
      });
    } catch { /* never break on answer failure */ }
  };
  try {
    if (!from.id || chatId == null || query?.message?.chat?.type !== 'private' || String(chatId) !== String(from.id)) {
      await answerOnce('🎧 Voice notes live in our DM.');
      return;
    }
    const state = await readVoiceState(from.id);
    if (!state || state.token !== token || String(state.chatId) !== String(chatId)) {
      await answerOnce('⏰ That voice note expired — my newest answer has the live 🔊 button.');
      return;
    }
    if (state.inflight) { await answerOnce('🎧 Already making that voice note…'); return; }
    const provider = await voiceProviderFor(from.id);
    if (!provider) { await answerOnce(VOICE_GATE_TEXT, true); return; }
    await writeVoiceState(from.id, { ...state, inflight: true });
    const res = await synthesizeReplyVoice(state.text, { provider });
    if (!res) {
      await writeVoiceState(from.id, { ...state, inflight: false });
      await answerOnce("🎧 Voice isn't available right now — the text above is the full answer.");
      return;
    }
    await answerOnce('🎧 Voice note incoming…');
    try {
      await sendVoiceNote(chatId, res, res.truncated);
      await writeVoiceState(from.id, null); // consumed — one note per answer
    } catch {
      await writeVoiceState(from.id, { ...state, inflight: false });
      try {
        await api.sendMessage({ chat_id: chatId, text: '⚠️ Couldn\'t send that voice note — tap 🔊 Hear it to try again.' });
      } catch { /* best effort */ }
    }
  } catch (err) {
    console.error('[voice cb]', err?.message ?? err);
    await answerOnce("🎧 Voice isn't available right now.");
  }
}

// ── /voice auto-read toggle ─────────────────────────────────────────────────

export async function getVoiceAuto(tgId) {
  // Tolerant reader (lib/config.js getConfigFlag — audit F19); the only
  // writer is the /voice toggle below, which stores '1'/'0' — unchanged.
  try { return await getConfigFlag(voiceAutoKey(tgId)); } catch { return false; }
}

/**
 * Auto-read for /voice-on users: PB's own SHORT replies only (an answer
 * that fits the cap whole — auto-read never truncates), DM path only
 * (the caller enforces). Gated users are skipped silently — they got
 * the gate copy when they ran /voice on. NEVER throws.
 */
export async function maybeAutoVoice(chatId, from, answerText) {
  try {
    if (!from?.id || chatId == null) return { sent: false, reason: 'no-user' };
    if (!(await getVoiceAuto(from.id))) return { sent: false, reason: 'off' };
    const text = String(answerText ?? '').trim();
    if (!text || text.length > VOICE_MAX_CHARS) return { sent: false, reason: 'long' };
    const provider = await voiceProviderFor(from.id);
    if (!provider) return { sent: false, reason: 'gated' };
    const res = await synthesizeReplyVoice(text, { provider });
    if (!res) return { sent: false, reason: 'tts' };
    await sendVoiceNote(chatId, res, false);
    return { sent: true, provider: res.provider };
  } catch { return { sent: false, reason: 'error' }; }
}

async function voiceSend(chatId, text) {
  try { await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000) }); } catch { /* never break */ }
}

async function voiceCommand(chatId, args, msg) {
  const userId = msg?.from?.id;
  if (!userId) return;
  if (msg?.chat?.type !== 'private') {
    await voiceSend(chatId, '🔊 Voice notes live in our DM — open a private chat with me and run /voice there.');
    return;
  }
  const arg = String(args ?? '').trim().toLowerCase();
  if (arg === 'on') {
    const provider = await voiceProviderFor(userId);
    if (!provider) { await voiceSend(chatId, VOICE_GATE_TEXT); return; }
    try { await setConfig(voiceAutoKey(userId), '1'); } catch { /* best effort */ }
    await voiceSend(chatId,
      '🔊 Voice notes ON — in this DM I\'ll read my short replies aloud as voice notes. ' +
      'Longer answers stay text, and every answer still carries a 🔊 Hear it button.\n\n/voice off stops the auto-read.');
    return;
  }
  if (arg === 'off') {
    try { await setConfig(voiceAutoKey(userId), '0'); } catch { /* best effort */ }
    await voiceSend(chatId, '🔇 Voice notes OFF — replies stay text-only unless you tap 🔊 Hear it under an answer.');
    return;
  }
  const on = await getVoiceAuto(userId);
  await voiceSend(chatId, [
    `🔊 Voice notes are ${on ? 'ON' : 'OFF'} for you in this DM.`,
    '',
    'Every answer I give you here carries a 🔊 Hear it button — tap it and I\'ll send that answer as a voice note.',
    '/voice on — I read my short replies aloud automatically.',
    '/voice off — text only (the button still works).',
    '',
    'Voice notes need a Starter+ plan; Builder+ hears my premium voice.',
    'One limit for now: voice notes are English-voiced, whatever language we are chatting in.',
  ].join('\n'));
}

export const VOICE_COMMANDS = { voice: voiceCommand };
