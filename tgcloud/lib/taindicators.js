// lib/taindicators.js — /rsi, /macd, /bollinger indicator cards.
// Ports handleRSI / handleMACD / handleBollinger from the original
// telegram-community-bot.ts onto the live serverless market stack:
//   token lookup  -> lib/market.js (GeckoTerminal, Base)
//   hourly OHLCV  -> lib/ta.js fetchOHLCV (GeckoTerminal pool ohlcv)
//   number format -> lib/market.js fmt$ (folded from lib/format.js, 2026-10-23)
//
// The indicator math is the standard textbook form ported from the
// original's ta-analysis.ts (full-series Wilder RSI, EMA-seeded MACD with
// crossover detection, SMA+/-2 sigma Bollinger with bandwidth + position).
// lib/ta.js's exported rsi/macd/bollinger are NOT reused here: they are
// simplified /ta-card variants that do not produce the signal, trend,
// crossover, bandwidth, or position fields the original per-command cards
// print. Only its fetchOHLCV (data layer) is reused.
//
// V8 isolate rules: imports are sdk + sibling lib modules only.
// No timers, no abort controllers, plain single-attempt fetch calls.

import { api, fetch } from 'sdk';
import { fetchTokenByAddress, searchToken, fmt$, fmtLargeUsd } from './market.js';
import { fetchOHLCV } from './ta.js';

import { getGroupSettings, cleanupNoteSent } from './groups.js';

// Verified PBAI contract on Base — copied verbatim from
// handlers/message.js (live PBAI_CA).
const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';

// House convention: plain-text sendSafe (no MarkdownV2 layer), 4000-char cap.
async function sendSafe(chatId, text, extra = {}) {
  const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra }).catch(() => null);
  // PB Cleanup capture seam (2026-10-22).
  if (sent) await cleanupNoteSent(chatId, sent);
  return sent;
}

// ── Indicator math (port of ta-analysis.ts — textbook forms) ────────────────

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period - 1; i++) result.push(NaN);
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

/** Wilder RSI. Returns { value, signal, interpretation } or null if < period+1 closes. */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = changes.slice(0, period).filter((c) => c > 0).reduce((a, b) => a + b, 0) / period;
  let avgLoss = Math.abs(changes.slice(0, period).filter((c) => c < 0).reduce((a, b) => a + b, 0)) / period;
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  let signal = 'Neutral';
  let interpretation = '⚪ Neutral — no strong signal';
  if (rsi < 30) { signal = 'Oversold'; interpretation = '🟢 Oversold — potential reversal / buy zone'; }
  else if (rsi < 45) { signal = 'Bearish'; interpretation = '🔴 Approaching oversold — bearish momentum'; }
  else if (rsi > 70) { signal = 'Overbought'; interpretation = '🔴 Overbought — potential pullback incoming'; }
  else if (rsi > 55) { signal = 'Bullish'; interpretation = '🟢 Bullish momentum — uptrend territory'; }
  return { value: Math.round(rsi * 100) / 100, signal, interpretation };
}

/** MACD(12,26,9) with crossover detection. Null if < slow+signal closes. */
function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = emaFast.map((v, i) => (Number.isNaN(v) || Number.isNaN(emaSlow[i]) ? NaN : v - emaSlow[i]));
  const validMacd = macdLine.filter((v) => !Number.isNaN(v));
  const signalLine = emaSeries(validMacd, signalPeriod);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const histogram = lastMacd - lastSignal;
  const prevHistogram = validMacd[validMacd.length - 2] - signalLine[signalLine.length - 2];
  let trend = 'Neutral';
  let interpretation = '⚪ MACD near the signal line — no clear trend';
  if (histogram > 0 && prevHistogram <= 0) {
    trend = 'Bullish'; interpretation = '🟢 Bullish crossover — buy signal!';
  } else if (histogram < 0 && prevHistogram >= 0) {
    trend = 'Bearish'; interpretation = '🔴 Bearish crossover — sell signal';
  } else if (histogram > 0) {
    trend = 'Bullish'; interpretation = '🟢 Bullish — MACD above signal line';
  } else if (histogram < 0) {
    trend = 'Bearish'; interpretation = '🔴 Bearish — MACD below signal line';
  }
  return {
    macd: Math.round(lastMacd * 1e8) / 1e8,
    signal: Math.round(lastSignal * 1e8) / 1e8,
    histogram: Math.round(histogram * 1e8) / 1e8,
    trend,
    interpretation,
  };
}

/** Bollinger(period, mult). Null if < period closes. */
function calcBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, v) => a + (v - middle) ** 2, 0) / period);
  const upper = middle + stdDev * std;
  const lower = middle - stdDev * std;
  const currentPrice = closes[closes.length - 1];
  const bandwidth = ((upper - lower) / middle) * 100;
  const pct = (currentPrice - lower) / (upper - lower);
  let position = 'Middle';
  let interpretation = '⚪ Price in middle of bands — no strong signal';
  if (currentPrice > upper) { position = 'Above Upper'; interpretation = '🔴 Price above upper band — overbought / breakout'; }
  else if (pct > 0.8) { position = 'Near Upper'; interpretation = '🟡 Near upper band — momentum strong, watch for reversal'; }
  else if (currentPrice < lower) { position = 'Below Lower'; interpretation = '🟢 Price below lower band — oversold / bounce candidate'; }
  else if (pct < 0.2) { position = 'Near Lower'; interpretation = '🟡 Near lower band — potential support, watch for bounce'; }
  return {
    upper: Math.round(upper * 1e8) / 1e8,
    middle: Math.round(middle * 1e8) / 1e8,
    lower: Math.round(lower * 1e8) / 1e8,
    bandwidth: Math.round(bandwidth * 100) / 100,
    position,
    interpretation,
  };
}

// ── Token resolution + OHLCV fetch ───────────────────────────────────────────
// Order: explicit arg -> group's /settoken address -> verified PBAI CA.
// A GeckoTerminal lookup hit outside Base is treated as "not found"
// (live v1 only serves Base, same as /price).

async function resolveAddress(query, chatId, msg) {
  if (!query) {
    let groupAddr = null;
    if (msg?.chat?.type && msg.chat.type !== 'private') {
      try {
        const s = await getGroupSettings(chatId);
        if (/^0x[0-9a-fA-F]{40}$/.test(s?.tokenAddress ?? '')) groupAddr = s.tokenAddress;
      } catch { /* settings store is best-effort */ }
    }
    return groupAddr ?? PBAI_CA;
  }
  const q = query.replace(/^\$/, '');
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return q;
  if (/^pbai$/i.test(q)) return PBAI_CA;
  try {
    const found = await searchToken(q);
    if (found?.network === 'base' && found.address) return found.address;
  } catch { /* search failed — fall through to not-found */ }
  return null;
}

/**
 * Resolve token -> pool -> hourly candles. Returns { token, candles } or
 * { errorText } with the honest failure text (never fabricates data).
 * The skills layer (lib/skills.js) consumes this directly; the command
 * wrapper below adds the typing action + sendSafe behavior.
 */
async function prepareData(chatId, args, msg, minCandles, notEnoughText) {
  const address = await resolveAddress(args.trim(), chatId, msg);
  if (!address) {
    return { errorText: '⚠️ Couldn’t find that token on Base. Symbol search can miss brand-new tokens — paste the contract address (0x…) directly, or try $PBAI.' };
  }
  let token = null;
  let candles = null;
  try {
    token = await fetchTokenByAddress(address);
    if (!token?.poolId) {
      return { errorText: '❌ No trading pool found for that token — it may be too new or have no liquidity yet. A contract address with an active pool works best.' };
    }
    const poolAddr = String(token.poolId).split('_').pop();
    candles = await fetchOHLCV(poolAddr, fetch, 'base', 'hour', 100);
  } catch {
    return { errorText: '📊 Price feed unavailable right now — could not pull candle data for this token. Try again in a moment.' };
  }
  if (!candles || candles.length < minCandles) {
    return { errorText: notEnoughText };
  }
  return { token, candles };
}

async function prepare(chatId, args, msg, minCandles, notEnoughText) {
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  const d = await prepareData(chatId, args, msg, minCandles, notEnoughText);
  if (d.errorText) {
    await sendSafe(chatId, d.errorText);
    return null;
  }
  return d;
}

// Split an optional trailing integer period: "<token> 14" -> { query, period }.
// Only consumed when the number is inside the valid range; an out-of-range
// number produces a usage message instead of a silent default.
function splitPeriod(raw, def, min, max, usage) {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let period = def;
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    const n = parseInt(parts[parts.length - 1], 10);
    if (n < min || n > max) return { usage: true };
    period = n;
    parts.pop();
  }
  return { query: parts.join(' '), period };
}

function trimmed(num) {
  return String(num);
}

// ── Card text builders (shared by the commands and the skills layer) ───────

function rsiCardText(token, r, period) {
  return [
    `📉 RSI (${period}): ${token.name}`,
    '',
    `Value: ${r.value.toFixed(2)}`,
    `Signal: ${r.signal}`,
    r.interpretation,
    '',
    `💰 Current Price: ${fmt$(token.priceUsd)}`,
  ].join('\n');
}

function macdCardText(token, m) {
  return [
    `📊 MACD (12,26,9): ${token.name}`,
    '',
    m.interpretation,
    '',
    `MACD Line: ${trimmed(m.macd)}`,
    `Signal Line: ${trimmed(m.signal)}`,
    `Histogram: ${trimmed(m.histogram)}`,
    `Trend: ${m.trend}`,
    '',
    `💰 Current Price: ${fmt$(token.priceUsd)}`,
  ].join('\n');
}

function bollingerCardText(token, b, period) {
  return [
    `📊 Bollinger Bands (${period}): ${token.name}`,
    '',
    b.interpretation,
    '',
    `🔴 Upper: ${fmt$(b.upper)}`,
    `⚪ Middle (SMA${period}): ${fmt$(b.middle)}`,
    `🟢 Lower: ${fmt$(b.lower)}`,
    `📏 Bandwidth: ${b.bandwidth.toFixed(2)}%`,
    `📍 Position: ${b.position}`,
    '',
    `💰 Current Price: ${fmt$(token.priceUsd)}`,
  ].join('\n');
}

// ── COMMANDS entries (name: async (chatId, args, msg) => {...}) ──────────────

async function rsi(chatId, args, msg) {
  const p = splitPeriod(args ?? '', 14, 2, 100);
  if (p.usage) {
    await sendSafe(chatId, '⚠️ Usage: /rsi [token] [period]\nExample: /rsi $PBAI 14 — period must be 2–100 (default 14).');
    return;
  }
  const ctx = await prepare(chatId, p.query, msg, p.period + 1, '⚠️ Not enough price history for RSI yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.');
  if (!ctx) return;
  const r = calcRSI(ctx.candles.map((c) => c.close), p.period);
  if (!r) { await sendSafe(chatId, '⚠️ Not enough price history for RSI yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.'); return; }
  await sendSafe(chatId, rsiCardText(ctx.token, r, p.period));
}

async function macd(chatId, args, msg) {
  // MACD keeps the original's fixed (12,26,9) parameters — the whole arg
  // string is the token query (no period param, as in the original).
  const ctx = await prepare(chatId, args ?? '', msg, 35, '⚠️ Not enough price history for MACD yet — MACD needs 35 hourly candles and this token has fewer. Try a token with more trading history, or check back later.');
  if (!ctx) return;
  const m = calcMACD(ctx.candles.map((c) => c.close), 12, 26, 9);
  if (!m) { await sendSafe(chatId, '⚠️ Not enough price history for MACD yet — MACD needs 35 hourly candles and this token has fewer. Try a token with more trading history, or check back later.'); return; }
  await sendSafe(chatId, macdCardText(ctx.token, m));
}

async function bollinger(chatId, args, msg) {
  const p = splitPeriod(args ?? '', 20, 5, 100);
  if (p.usage) {
    await sendSafe(chatId, '⚠️ Usage: /bollinger [token] [period]\nExample: /bollinger $PBAI 20 — period must be 5–100 (default 20).');
    return;
  }
  const ctx = await prepare(chatId, p.query, msg, p.period, '⚠️ Not enough price history for Bollinger Bands yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.');
  if (!ctx) return;
  const b = calcBollinger(ctx.candles.map((c) => c.close), p.period, 2);
  if (!b) { await sendSafe(chatId, '⚠️ Not enough price history for Bollinger Bands yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.'); return; }
  await sendSafe(chatId, bollingerCardText(ctx.token, b, p.period));
}

// ── /volume (E4a restore, 2026-10-21; source: handleVolume :3410 via the
// /volume handler :8438) ───────────────────────────────────────────────────
// Last hourly candle's volume vs the trailing-24h average, plus the
// token's 24h volume + liquidity. Query resolution is this family's
// (arg → group featured token → $PBAI); the source's handler used its
// groupAwareQuery (NO_TOKEN_MSG when a group had no featured token) and
// its shared "ta" daily-usage gate — neither exists in the port's TA
// family (rsi/macd/bollinger shipped without them), so /volume matches
// its port siblings and the divergence is the family's, noted in the
// wave report.

function volumeCardText(token, candles) {
  const recent = candles.slice(-24);
  const avgVol = recent.reduce((a, c) => a + (c.volume ?? 0), 0) / (recent.length || 1);
  const lastVol = candles[candles.length - 1]?.volume ?? 0;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;
  const unusual = volRatio > 2
    ? '🚨 UNUSUAL VOLUME DETECTED'
    : volRatio > 1.5 ? '⚠️ Elevated volume' : '📊 Normal volume';
  return [
    `📦 Volume Profile: ${token.name}`,
    '',
    unusual,
    '',
    `Current Vol: ${fmtLargeUsd(lastVol)}`,
    `24h Avg Vol: ${fmtLargeUsd(avgVol)}`,
    `Vol Ratio: ${volRatio.toFixed(2)}x`,
    `24h Volume: ${fmtLargeUsd(token.volume24h)}`,
    `Liquidity: ${fmtLargeUsd(token.liquidity)}`,
  ].join('\n');
}

async function volume(chatId, args, msg) {
  const d = await prepare(chatId, args, msg, 1, '⚠️ No volume data available.');
  if (!d) return;
  await sendSafe(chatId, volumeCardText(d.token, d.candles));
}

export const TA_COMMANDS = { rsi, macd, bollinger, volume };

// ── Skill text entry points (lib/skills.js) ─────────────────────────────────
// Same resolution, same math, same card text as the commands — but they
// RETURN the text instead of sending it, and never trigger chat actions.
// `chatType` only steers the group-token default inside resolveAddress
// (a private ctx resolves arg -> $PBAI, exactly like a DM command run).

export async function rsiText(rawArgs, chatId, chatType) {
  const p = splitPeriod(rawArgs ?? '', 14, 2, 100);
  if (p.usage) return '⚠️ Usage: /rsi [token] [period]\nExample: /rsi $PBAI 14 — period must be 2–100 (default 14).';
  const msg = { chat: { type: chatType ?? 'private' } };
  const d = await prepareData(chatId, p.query, msg, p.period + 1, '⚠️ Not enough price history for RSI yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.');
  if (d.errorText) return d.errorText;
  const r = calcRSI(d.candles.map((c) => c.close), p.period);
  if (!r) return '⚠️ Not enough price history for RSI yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.';
  return rsiCardText(d.token, r, p.period);
}

export async function macdText(rawArgs, chatId, chatType) {
  const msg = { chat: { type: chatType ?? 'private' } };
  const d = await prepareData(chatId, rawArgs ?? '', msg, 35, '⚠️ Not enough price history for MACD yet — MACD needs 35 hourly candles and this token has fewer. Try a token with more trading history, or check back later.');
  if (d.errorText) return d.errorText;
  const m = calcMACD(d.candles.map((c) => c.close), 12, 26, 9);
  if (!m) return '⚠️ Not enough price history for MACD yet — MACD needs 35 hourly candles and this token has fewer. Try a token with more trading history, or check back later.';
  return macdCardText(d.token, m);
}

export async function bollingerText(rawArgs, chatId, chatType) {
  const p = splitPeriod(rawArgs ?? '', 20, 5, 100);
  if (p.usage) return '⚠️ Usage: /bollinger [token] [period]\nExample: /bollinger $PBAI 20 — period must be 5–100 (default 20).';
  const msg = { chat: { type: chatType ?? 'private' } };
  const d = await prepareData(chatId, p.query, msg, p.period, '⚠️ Not enough price history for Bollinger Bands yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.');
  if (d.errorText) return d.errorText;
  const b = calcBollinger(d.candles.map((c) => c.close), p.period, 2);
  if (!b) return '⚠️ Not enough price history for Bollinger Bands yet — this token doesn’t have enough hourly candles. Try a token with more trading history, or check back later.';
  return bollingerCardText(d.token, b, p.period);
}

/** Skill-text entry point for /volume (same shape as rsiText & friends). */
export async function volumeText(rawArgs, chatId, chatType) {
  const msg = { chat: { type: chatType ?? 'private' } };
  const d = await prepareData(chatId, rawArgs ?? '', msg, 1, '⚠️ No volume data available.');
  if (d.errorText) return d.errorText;
  return volumeCardText(d.token, d.candles);
}
