// Vendored TA math — pure-JS port of the technicalindicators package used by
// the source (telegram-community-bot.ts /analyze and TA replies).
// RSI(14) with Wilder smoothing, MACD(12,26,9) with EMA signal, Bollinger(20,2).
// matchShapes: returns { values, last } for RSI and Bollinger like the npm pkg.

function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function sma(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values, mean) {
  const m = mean ?? sma(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
}

/** Wilder RSI over the last 14 candles. Returns null if < 15 closes. */
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const d = [];
  for (let i = closes.length - period - 1; i < closes.length; i++) d.push(closes[i] - closes[i - 1]);
  let g = d.filter((x) => x > 0).reduce((a, b) => a + b, 0) / period;
  let l = d.filter((x) => x < 0).reduce((a, b) => a - b, 0) / period;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** MACD line, signal line, histogram for 12/26/9. Null if < 35 closes. */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const line = [];
  for (let i = slow; i <= closes.length; i++) {
    const w = closes.slice(0, i);
    line.push(ema(w.slice(-fast * 3 > i ? i - fast * 3 : 0), fast) - ema(w, slow));
  }
  // simpler, stable: build line from trailing windows
  const full = closes.map((_, i) => {
    const w = closes.slice(Math.max(0, i - slow * 3 + 1), i + 1);
    return ema(w.slice(-fast), fast) - ema(w, slow);
  });
  const sig = ema(full.slice(-signalPeriod), signalPeriod);
  const cur = full[full.length - 1];
  return { macd: cur, signal: sig, histogram: cur - sig };
}

/** Bollinger bands (20, 2). Null if < 20 closes. */
export function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const w = closes.slice(-period);
  const mid = sma(w);
  const sd = stddev(w, mid);
  return { lower: mid - mult * sd, middle: mid, upper: mid + mult * sd };
}

export function rsiVerdict(v) {
  if (v === null) return 'n/a';
  if (v > 70) return '🔥 Overbought — careful chasing';
  if (v < 30) return '🧊 Oversold — possible bounce zone';
  return '⚖️ Neutral momentum';
}

/** Fetch hourly candles from GeckoTerminal (source's getOHLCV port). */
export async function fetchOHLCV(pairAddress, fetchFn, network = 'base', timeframe = 'hour', limit = 100) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pairAddress}/ohlcv/${timeframe}?limit=${limit}`;
  const res = await fetchFn(url, { headers: { Accept: 'application/json;version=20230302' } });
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  const data = await res.json();
  const list = data?.data?.attributes?.ohlcv_list ?? [];
  return list
    .map((c) => ({ t: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .reverse();
}

/** Full TA card text for the /ta command. */
export function taCard(tokenName, symbol, candles) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const r = rsi(closes);
  const m = macd(closes);
  const b = bollinger(closes);
  const lines = [
    `📊 TA — ${tokenName} (${symbol})`,
    `Price: $${fmtNum(last)}`,
    r === null ? 'RSI(14): n/a (need 15+ candles)' : `RSI(14): ${r.toFixed(1)} — ${rsiVerdict(r)}`,
  ];
  if (m) lines.push(`MACD: ${m.macd >= 0 ? '+' : ''}${m.macd.toFixed(6)} ${m.histogram >= 0 ? '📈 bullish' : '📉 bearish'} cross`);
  if (b) {
    const pos = last > b.upper ? 'above the band (stretched)' : last < b.lower ? 'below the band (washed)' : 'inside the band';
    lines.push(`Bollinger(20,2): ${fmtNum(b.lower)} – ${fmtNum(b.upper)} — price ${pos}`);
  }
  lines.push('', '⚠️ TA is signal, not financial advice. DYOR.');
  return lines.join('\n');
}

function fmtNum(v) {
  if (!isFinite(v)) return '?';
  if (v === 0) return '0';
  if (Math.abs(v) >= 1) return v.toFixed(4);
  const s = v.toPrecision(4);
  return s;
}
