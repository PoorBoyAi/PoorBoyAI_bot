// lib/market.js — GeckoTerminal market data helpers.
// fetchTokenByAddress / searchToken / priceCard were extracted VERBATIM from
// handlers/message.js (2026-10-19, skills build) so the bot commands and the
// skills layer (lib/skills.js) call the exact same code — no forked logic.

import { fetch, api } from 'sdk';
import { getConfig } from './config.js';
import { renderAnnouncePoster } from './pngcard.js';

// ── Number formatting (folded from lib/format.js, Signal Inlet wave
// 2026-10-23 — the platform caps the app at 100 modules; format.js was
// folded into its heaviest consumer to free the slot for
// endpoints/signal.js, the relay-fold precedent). Mirrors fmt$ / fmtPct
// / fmtLargeUsd from telegram-community-bot.ts (plain-text v1).
export function fmt$(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  // Sub-dollar: show up to 8 significant-ish decimals without trailing zeros.
  return '$' + n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

export function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtLargeUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return fmt$(n);
}

// ── AI grounding (fix 2, 2026-10-29) ────────────────────────────────────
// Post generators and /analyze used to hand the brain a bare topic and
// let it invent specifics ("$3.2M market cap", "78% locked",
// "mainnet v2 on 2026-12-01"). These helpers build the verified-data
// block that now travels with the prompt. Missing fields render as
// 'n/a' (not the display '—'), so the model writes n/a instead of
// filling the gap. Pure formatting — no fetch, no state, no caller
// behavior change except the prompt text itself.
export const GROUNDING_RULE = 'GROUNDING RULE: Use ONLY the numbers in the verified block above for price, market cap, volume, liquidity, and percentages. Any figure not listed there — including locked %, holder counts, supply, FDV, dates, and roadmap claims — must be written as n/a or omitted entirely. Never invent a number, date, or percentage.';
export function groundingBlock(t) {
  if (!t) {
    return [
      'VERIFIED LIVE DATA: none available for this topic.',
      'GROUNDING RULE: Do NOT state any price, market cap, volume, liquidity, percentage, holder count, or date for this topic. Write n/a for any such figure or omit it entirely. Never invent one.',
    ].join('\n');
  }
  // NOTE: Number(null) === 0, so null must be excluded explicitly —
  // otherwise a missing price renders as a fabricated-looking $0.
  const na = (v, fmt) => ((v == null || v === '' || !Number.isFinite(Number(v))) ? 'n/a' : fmt(v));
  // Zora coin data comes from its on-chain V4 pool, not GeckoTerminal
  // (fetchZoraCoin) — say so, so the header never mislabels a source.
  const sourceLabel = t.source === 'zora-v4-pool' ? 'on-chain pool price' : 'GeckoTerminal';
  return [
    `VERIFIED LIVE DATA (${sourceLabel}, fetched just now):`,
    `Token: ${t.name ?? 'n/a'} ($${t.symbol ?? 'n/a'})`,
    `Price: ${na(t.priceUsd, fmt$)}`,
    `24h change: ${na(t.change24h, fmtPct)}`,
    `Market cap: ${na(t.marketCap, fmtLargeUsd)}`,
    `Volume 24h: ${na(t.volume24h, fmtLargeUsd)}`,
    `Liquidity: ${na(t.liquidity, fmtLargeUsd)}`,
    GROUNDING_RULE,
  ].join('\n');
}

const GT = 'https://api.geckoterminal.com/api/v2';

// GeckoTerminal launchpad_details (verified live 2026-10-21): present on
// token AND pool payloads while GT tracks the token as a launchpad token —
// { graduation_percentage, completed, completed_at,
// migrated_destination_pool_address } — and null/absent for established
// tokens (Fartcoin, $PBAI). Normalized here so callers never read the raw
// shape: null when GT carries no launchpad record for the token.
export function normalizeLaunchpad(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pct = Number(raw.graduation_percentage);
  return {
    completed: raw.completed === true,
    graduationPct: Number.isFinite(pct) ? pct : null,
    migratedPool: typeof raw.migrated_destination_pool_address === 'string'
      ? raw.migrated_destination_pool_address : null,
  };
}

export async function fetchTokenByAddress(address, network = 'base', opts = {}) {
  const lc = String(address ?? '').toLowerCase();
  // Two-coin routing (track-both wave 2026-10-27): the Zora creator coin
  // is NOT on GeckoTerminal, so an exact-address match routes to the
  // on-chain V4 adapter instead of a GT 404. The project coin keeps the
  // GT path and gains its 'Project coin' label. Every other address runs
  // the exact body below, unchanged.
  if (lc === ZORA_COIN_CA) return fetchZoraCoin();
  const res = await fetch(`${GT}/networks/${network}/tokens/${address}`);
  if (!res.ok) return null;
  const data = await res.json();
  const a = data?.data?.attributes;
  if (!a) return null;
  const topPool = data?.data?.relationships?.top_pools?.data?.[0];
  const out = {
    name: a.name, symbol: a.symbol, address,
    priceUsd: Number(a.price_usd),
    change24h: Number(a.price_change_percentage?.h24),
    marketCap: Number(a.market_cap_usd),
    fdv: Number(a.fdv_usd),
    liquidity: Number(a.total_reserve_in_usd),
    volume24h: Number(a.volume_usd?.h24),
    poolId: topPool?.id ?? null,
    // Buy Bot §9.6 wave: the token payload already carries GT's
    // launchpad/graduation record — additive field, existing callers
    // (commands, skills) are unaffected.
    launchpad: normalizeLaunchpad(a.launchpad_details),
  };
  if (lc === PROJECT_COIN_CA) out.label = PROJECT_COIN_LABEL;
  // Uniswap API wave (2026-10-28, V1 read-only): pool-state enrichment
  // ONLY when the caller opts in (handlePrice passes { uniswapPool: true })
  // AND this is the project coin. Every other caller passes nothing, so
  // tick/moneyguard/airdrop paths make zero new calls and cannot slow
  // down. getUniswapPbaiPoolState returns null without a key or on any
  // API failure, so the card is byte-identical to before in those cases.
  if (lc === PROJECT_COIN_CA && opts?.uniswapPool) {
    const pool = await getUniswapPbaiPoolState().catch(() => null);
    if (pool) out.uniswapPool = pool;
  }
  return out;
}

// ── Zora creator-coin price adapter (track-both wave 2026-10-27) ─────────
// Rowdy's own Zora ContentCoin (0x7a38…) is NOT covered by GeckoTerminal
// or Dexscreener, so its price comes from its Uniswap V4 pool on Base,
// read on-chain. The pool was verified live 2026-10-27: the coin's
// getPoolKey() returns (coin, USDC, fee 10000, tickSpacing 200, hooks
// 0xc8d0…), i.e. a coin/USDC pool — so the USD price is the slot0 price
// times the USDC leg (GT USDC price when available, $1 peg fallback,
// flagged). NEVER throws: every failure mode returns null, and callers
// already render null as 'unavailable' — a missing price is never
// replaced with an invented or stale one.
// ANTI-STALE GUARD: the live getPoolKey() must equal the pinned tuple
// AND the live poolManager() must equal the pinned manager before the
// pinned poolId is read. If Zora ever migrates the pool, the adapter
// refuses (null) instead of quoting a frozen pool's last price.
// SLOT0 READ PATH (corrected 2026-10-27 ~23:0x PDT — this is the fix
// for the wave's blocker): the slot0 price is read from Uniswap's
// StateView contract on Base, NOT from the PoolManager. The manager
// has NO external getSlot0 function — StateLibrary's getSlot0 is a
// library call resolved via extsload — so a direct manager getSlot0
// eth_call reverts on every provider for every pool (proven: static
// pool + an unrelated pool both revert, VM + isolate). StateView's
// getSlot0(poolId) returns (sqrtPriceX96, tick, protocolFee, lpFee);
// its sqrt was verified live against the pool's last Swap sqrt
// (198731502971559221639, block 52859469) — exact match, price
// $0.00000629179 at peg 1.0, matching the Coinbase Wallet order.
// The poolId itself was proven by Swap logs, not by the (void)
// Initialize-topic scans: the coin's last trades (blocks 52859454,
// 52859469) each emit TWO Swaps in the static poolId, senders =
// Universal Router + the Zora hook. The earlier "pool never
// initialized / pool key differs" conclusions were artifacts of the
// wrong Initialize topic (0x1f170290…) and the broken slot0 call,
// and are superseded by this evidence. The getPoolKey guard is
// therefore KEPT (it returns the trading key), not dropped.
export const ZORA_COIN_CA = '0x7a384a8e1b17fe938d5725e47e58ec954c8d7893';
export const PROJECT_COIN_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
export const ZORA_COIN_LABEL = 'Creator coin (Zora)';
export const PROJECT_COIN_LABEL = 'Project coin';
export const ZORA_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';
export const ZORA_STATE_VIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71';
export const ZORA_USDC_CA = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ZORA_POOL_ID = '0x4f46fa27c6fb78874b87e34fa8903a7d8988129c8c3a30b2178bb6219cfdda55';
const ZORA_POOL_KEY = {
  currency0: ZORA_COIN_CA,
  currency1: ZORA_USDC_CA,
  fee: 10000,
  tickSpacing: 200,
  hooks: '0xc8d077444625eb300a427a6dfb2b1dbf9b159040',
};
const ZORA_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
];
const ZORA_GET_POOL_KEY_DATA = '0x683e76e0';
const ZORA_GET_POOL_MANAGER_DATA = '0xdc4c90d3';
const ZORA_GET_SLOT0_DATA = '0xc815641c' + ZORA_POOL_ID.slice(2);

export function isZoraCoin(address) {
  return String(address ?? '').toLowerCase() === ZORA_COIN_CA;
}

// One JSON-RPC eth_call against the rotating public list. Returns the
// result hex, or null when every endpoint fails / the node returns an
// error body (deterministic errors are not retried across providers —
// they would fail identically everywhere).
async function zoraRpcCall(data, to, fetchImpl = fetch) {
  let seq = 1;
  for (const url of ZORA_RPC_URLS) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      if (body?.error) return null;
      if (typeof body?.result === 'string' && body.result.startsWith('0x')) return body.result;
    } catch { /* next provider */ }
  }
  return null;
}

function zoraParsePoolKey(hex) {
  if (typeof hex !== 'string' || hex.length < 2 + 160 * 2) return null;
  const raw = hex.slice(2);
  const word = (i) => raw.slice(i * 64, (i + 1) * 64);
  const addr = (w) => '0x' + w.slice(24);
  const fee = Number(BigInt('0x' + word(2)));
  let tickSpacing = BigInt('0x' + word(3));
  if (tickSpacing >= (1n << 255n)) tickSpacing -= (1n << 256n);
  return {
    currency0: addr(word(0)).toLowerCase(),
    currency1: addr(word(1)).toLowerCase(),
    fee,
    tickSpacing: Number(tickSpacing),
    hooks: addr(word(4)).toLowerCase(),
  };
}

function zoraPoolKeyMatches(pk) {
  return !!pk
    && pk.currency0 === ZORA_POOL_KEY.currency0
    && pk.currency1 === ZORA_POOL_KEY.currency1
    && pk.fee === ZORA_POOL_KEY.fee
    && pk.tickSpacing === ZORA_POOL_KEY.tickSpacing
    && pk.hooks === ZORA_POOL_KEY.hooks;
}

// sqrtPriceX96 -> USD, all BigInt until the final division:
// usd = (sqrt/2^96)^2 * 10^12 (decimals: content 18, USDC 6) * usdcUsd.
// usdcUsd arrives as integer micro-dollars (1e6 = $1) so the whole
// computation stays exact; the result is scaled by 1e12 and divided once.
export function zoraPriceFromSlot0(sqrtPriceX96, usdcMicro) {
  try {
    const sqrt = BigInt(sqrtPriceX96);
    if (sqrt <= 0n) return null;
    const micro = BigInt(usdcMicro);
    if (micro <= 0n) return null;
    const scaled = (sqrt * sqrt * micro * (10n ** 18n)) / (1n << 192n);
    const usd = Number(scaled) / 1e12;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch { return null; }
}

export async function fetchZoraPoolPrice({ rpcCall, fetchImpl, fetchUsdc } = {}) {
  try {
    const call = rpcCall ?? ((data, to) => zoraRpcCall(data, to, fetchImpl ?? fetch));
    // (a) Live pool-key check — the anti-stale guard. Any mismatch, empty
    // or reverted read refuses the price outright.
    const keyHex = await call(ZORA_GET_POOL_KEY_DATA, ZORA_COIN_CA);
    if (!zoraPoolKeyMatches(zoraParsePoolKey(keyHex))) return { priceUsd: null, usdcPeg: false };
    // (a2) Live manager check — the coin must still report the pinned
    // manager, else the pool (and its StateView read) is not ours.
    const mgrHex = await call(ZORA_GET_POOL_MANAGER_DATA, ZORA_COIN_CA);
    const mgrAddr = (typeof mgrHex === 'string' && mgrHex.length >= 66)
      ? ('0x' + mgrHex.slice(-40)).toLowerCase() : null;
    if (mgrAddr !== ZORA_POOL_MANAGER.toLowerCase()) return { priceUsd: null, usdcPeg: false };
    // (b) Live slot0, via StateView (see header: the manager itself
    // has no external getSlot0 — a direct manager call reverts).
    const slotHex = await call(ZORA_GET_SLOT0_DATA, ZORA_STATE_VIEW);
    if (typeof slotHex !== 'string' || slotHex.length < 2 + 64) return { priceUsd: null, usdcPeg: false };
    const sqrt = BigInt('0x' + slotHex.slice(2, 66));
    if (sqrt <= 0n) return { priceUsd: null, usdcPeg: false };
    // (c) USDC leg: GT price when it answers, $1 peg otherwise (flagged).
    // fetchUsdc is injectable so the peg fallback is harness-provable;
    // default is the module's own GT read of USDC.
    let usdcMicro = 1000000;
    let usdcPeg = true;
    try {
      const usdc = await (fetchUsdc ?? (() => fetchTokenByAddress(ZORA_USDC_CA)))();
      const p = Number(usdc?.priceUsd);
      if (Number.isFinite(p) && p > 0) { usdcMicro = Math.round(p * 1e6); usdcPeg = false; }
    } catch { /* peg fallback */ }
    const priceUsd = zoraPriceFromSlot0(sqrt, usdcMicro);
    return { priceUsd, usdcPeg };
  } catch { return { priceUsd: null, usdcPeg: false }; }
}

export async function fetchZoraCoin(deps = {}) {
  const { priceUsd, usdcPeg } = await fetchZoraPoolPrice(deps);
  if (priceUsd == null) return null;
  return {
    address: ZORA_COIN_CA,
    network: 'base',
    name: 'POOR BOY AI ( PBAI )',
    symbol: 'PBAI',
    priceUsd,
    change24h: null,
    marketCap: priceUsd * 1e9,
    fdv: priceUsd * 1e9,
    liquidity: null,
    volume24h: null,
    zoraPoolId: ZORA_POOL_ID,
    label: ZORA_COIN_LABEL,
    source: 'zora-v4-pool',
    usdcPeg,
  };
}

// Number-only wrapper for the tick's tokenPriceUsd hook and live proofs.
export async function zoraPriceUsd(deps = {}) {
  const c = await fetchZoraCoin(deps).catch(() => null);
  const p = c?.priceUsd;
  return Number.isFinite(p) && p > 0 ? p : null;
}

// GeckoTerminal pool classification (Buy Bot §9.6 wave) — the ONE extra
// GT call the graduation detector spends, and only when a token's pool
// is first resolved or changes (the caller throttles; steady state is
// zero extra calls). Verified live 2026-10-21: the pool object's
// relationships.dex.data.id is the discriminator — 'pump-fun' for a
// pump.fun bonding-curve pool, 'pumpswap' / 'raydium' /
// 'meteora-damm-v2' for graduated Solana DEX pools, 'uniswap-v3-base'
// for $PBAI's Base pool — and the pool payload carries the same
// launchpad_details record as the token payload. Returns
// { dexId, launchpad } or null on any failure (callers fail quiet and
// simply retry classification on the next refresh).
export async function fetchPoolDex(network, poolAddress) {
  try {
    const res = await fetch(`${GT}/networks/${network}/pools/${poolAddress}`, {
      headers: { 'User-Agent': 'PoorBoyAI-Agent/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const d = data?.data;
    if (!d) return null;
    const dexId = d.relationships?.dex?.data?.id ?? null;
    return {
      dexId: typeof dexId === 'string' && dexId ? dexId : null,
      launchpad: normalizeLaunchpad(d.attributes?.launchpad_details),
    };
  } catch { return null; }
}

export async function searchToken(query) {
  const res = await fetch(`${GT}/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const hit = (data?.data ?? []).find((d) => d.type === 'token');
  if (!hit?.attributes?.address) return null;
  return { network: hit.attributes.network ?? 'base', address: hit.attributes.address };
}

// GeckoTerminal pool trades — the Buy Bot v1 event source (PB-BUYBOT-DESIGN
// §3: verified keyless from this stack; per-trade objects with kind,
// tx_hash, tx_from_address, USD volume, block number). Returns normalized
// trades in GT's order (newest first), or null on any failure so callers
// can skip a cycle quietly. One call returns up to ~300 trades (GT page
// cap) — the recent-window depth the Phase 1 smoke measured.
// Orientation (verified against live payloads 2026-10-21): for a 'buy',
// tx_from_address is the buyer and to_token_* describes the token bought
// (the watched token is normally the pool's base token); for a 'sell',
// from_token_* is the token sold. Amounts arrive human-readable.
// Solana (Buy Bot Phase 4, verified live 2026-10-21): GT serves solana
// pool trades — Raydium/PumpSwap AND pump.fun bonding-curve pools — in
// the IDENTICAL attribute shape (block_number is the slot). Base58
// addresses are CASE-SENSITIVE, so the watched-token match is exact on
// solana and case-insensitive on EVM networks; a lowercased solana mint
// also 404s the token lookup in fetchTokenByAddress, so callers must
// pass solana addresses verbatim (lib/tick.js does).
export async function fetchPoolTrades(network, poolAddress, tokenAddress) {
  const res = await fetch(`${GT}/networks/${network}/pools/${poolAddress}/trades`, {
    headers: { 'User-Agent': 'PoorBoyAI-Agent/1.0' },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const rows = data?.data;
  if (!Array.isArray(rows)) return null;
  const norm = network === 'solana'
    ? (s) => String(s || '')
    : (s) => String(s || '').toLowerCase();
  const ca = norm(tokenAddress);
  const out = [];
  for (const r of rows) {
    const a = r?.attributes;
    if (!a || !a.tx_hash || (a.kind !== 'buy' && a.kind !== 'sell')) continue;
    const toIsWatched = !ca || norm(a.to_token_address) === ca;
    const tokAmount = Number(toIsWatched ? a.to_token_amount : a.from_token_amount);
    const priceUsd = Number(toIsWatched ? a.price_to_in_usd : a.price_from_in_usd);
    const tsMs = a.block_timestamp ? Date.parse(a.block_timestamp) : NaN;
    out.push({
      kind: a.kind,
      txHash: a.tx_hash,
      buyerAddress: a.tx_from_address ?? null,
      volumeUsd: Number(a.volume_in_usd),
      tokAmount: Number.isFinite(tokAmount) ? tokAmount : 0,
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
      blockNumber: Number(a.block_number) || 0,
      ts: Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : 0,
    });
  }
  return out;
}

export function priceCard(t) {
  const lines = [
    `🚀 $${t.symbol} — ${t.name}`,
  ];
  // Two-coin labels (track-both wave): present only when the token carries
  // one — every other card renders exactly as before.
  if (t.label) lines.push(`🏷️ ${t.label}`);
  lines.push(
    '',
    `💰 Price: ${fmt$(t.priceUsd)}`,
    `📊 24h: ${fmtPct(t.change24h)}`,
    `💧 Liq: ${fmtLargeUsd(t.liquidity)}`,
    `📦 Vol 24h: ${fmtLargeUsd(t.volume24h)}`,
  );
  if (Number.isFinite(t.marketCap) && t.marketCap > 0) lines.push(`🏦 MCap: ${fmtLargeUsd(t.marketCap)}`);
  // Uniswap API wave (2026-10-28): pool line ONLY when the token carries
  // a parsed pool state (project coin + key + successful pool_info).
  // Every other card renders exactly as before. The GT price above is
  // never replaced by Uniswap data — this enriches, it does not re-price.
  if (t.uniswapPool && typeof t.uniswapPool.feePct === 'number') lines.push(`🦄 Uniswap V3: fee ${t.uniswapPool.feePct}% · pool live`);
  if (t.source === 'zora-v4-pool') {
    lines.push(`📡 Source: Zora V4 pool vs USDC, live on-chain${t.usdcPeg ? ' (USDC at $1 peg)' : ''}`);
    lines.push('', `🔗 https://basescan.org/token/${t.address}`, '', '🤖 @PoorBoyAI_bot');
  } else {
    lines.push('', `🔗 https://www.geckoterminal.com/base/tokens/${t.address}`, '', '🤖 @PoorBoyAI_bot');
  }
  return lines.join('\n');
}

// ── PB LaunchPad reads (W3 bot integration, 2026-10-25) ─────────────────
// The pad's own backend lives in the site Worker (W1 /api/lp/*, public
// reads need no auth). The bot NEVER writes to the pad: creation stays
// refused until W4/W5/W6, and this layer only reads status + listings.
// Every fetch fails quiet → null; callers render an honest "unavailable"
// or "parked" board, never invented numbers. No mainnet surface is touched:
// the only chain names that appear are the ones the site API reports.

export const LP_API_BASE = 'https://poorboyai.pages.dev/api/lp';
export const LP_SITE = 'https://poorboyai.pages.dev/launchpad';

const LP_CHAIN_LABEL = { base: 'Base', base_sepolia: 'Base Sepolia', sol: 'Solana', rh: 'Robinhood Chain' };
export function lpChainLabel(chain) { return LP_CHAIN_LABEL[chain] || String(chain || ''); }

export function lpCoinKey(coin) {
  const chain = String(coin?.chain || '').toLowerCase();
  const addr = String(coin?.tokenAddress || coin?.address || '');
  return `${chain}:${chain === 'sol' ? addr : addr.toLowerCase()}`;
}

export function lpCoinUrl(coin) {
  return `${LP_SITE}/coin/${encodeURIComponent(coin.chain)}/${encodeURIComponent(coin.tokenAddress)}`;
}

export function lpDexUrl(coin) {
  const net = coin.chain === 'sol' ? 'solana' : 'base';
  return `https://dexscreener.com/${net}/${coin.tokenAddress}`;
}

export function normalizeLpCoin(c) {
  if (!c || typeof c !== 'object') return null;
  const chain = String(c.chain || '');
  const tokenAddress = String(c.tokenAddress || '');
  if (!chain || !tokenAddress) return null;
  const grad = Number(c.graduationProgress);
  return {
    chain, chainId: Number(c.chainId) || null, tokenAddress,
    factoryAddress: String(c.factoryAddress || ''),
    creator: String(c.creator || ''),
    name: String(c.name || ''), symbol: String(c.symbol || ''),
    description: String(c.description || ''),
    imageUrl: String(c.imageUrl || ''),
    links: {
      website: String(c.links?.website || ''), twitter: String(c.links?.twitter || ''),
      telegram: String(c.links?.telegram || ''),
    },
    status: String(c.status || ''), listed: c.listed === true, demo: c.demo === true,
    graduationProgress: Number.isFinite(grad) ? grad : null,
    tradeCount: Number(c.tradeCount) || 0,
    createdOnchainAt: Number(c.createdOnchainAt) || null,
  };
}

export async function fetchLpStatus(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${LP_API_BASE}/status`, { headers: { Accept: 'application/json' } });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      launchpad: String(data.launchpad || ''),
      writesEnabled: data.writesEnabled === true,
      chains: (Array.isArray(data.chains) ? data.chains : []).map((ch) => ({
        key: String(ch.key || ''), chainId: Number(ch.chainId) || null,
        label: String(ch.label || ch.key || ''), testnet: ch.testnet === true,
        configured: ch.configured === true, enabled: ch.enabled === true,
        factoryAddress: String(ch.factoryAddress || ''),
      })),
    };
  } catch { return null; }
}

export async function fetchLpCoins({ sort = 'new', limit = 60 } = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${LP_API_BASE}/coins?sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(limit)}`, { headers: { Accept: 'application/json' } });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    const coins = (Array.isArray(data.coins) ? data.coins : []).map(normalizeLpCoin).filter(Boolean);
    return { coins, launchpad: String(data.launchpad || ''), note: String(data.note || '') };
  } catch { return null; }
}

export async function fetchLpBoard(fetchImpl = fetch) {
  const [status, list] = await Promise.all([fetchLpStatus(fetchImpl), fetchLpCoins({}, fetchImpl)]);
  if (!status && !list) return null;
  return { status, coins: list?.coins ?? [], launchpad: list?.launchpad ?? status?.launchpad ?? '', note: list?.note ?? '' };
}

export function formatLpBoard(board, nftBoard, nowMs = Date.now()) {
  if (!board) {
    return '🚀 PB LaunchPad\n\nBoard unavailable right now — the pad API did not answer. Try /launchpad again in a bit.\n\n🔗 https://poorboyai.pages.dev/launchpad';
  }
  const parked = board.status?.launchpad === 'parked' || board.launchpad === 'parked';
  const coins = (board.coins || []).filter((c) => c.listed && !c.demo);
  const lines = ['🚀 PB LaunchPad — read-only board', ''];
  if (parked) lines.push('Status: PARKED — creation is closed and no live listings exist yet.', '');
  if (!coins.length) {
    lines.push(board.note || 'No confirmed listings yet. Coins appear here only after their on-chain creation is verified.');
  } else {
    for (const c of coins.slice(0, 20)) {
      const grad = c.graduationProgress === null ? '' : ` · ${Math.round(c.graduationProgress * 100)}% to graduation`;
      lines.push(`• $${c.symbol || '???'} — ${c.name || ''} (${lpChainLabel(c.chain)}${grad})`);
      lines.push(`  ${lpCoinUrl(c)}`);
    }
  }
  lines.push('', `🔗 ${LP_SITE}`);
  // NFT lane (N3): appended when the caller fetched the NFT board; a
  // null NFT board means that lane's API was down, rendered honestly.
  if (nftBoard !== undefined) {
    lines.push('', '────────────────────', '');
    lines.push(nftBoard === null
      ? '🎨 NFT drops: lane unavailable right now — the pad API did not answer.'
      : formatLpNftBoard(nftBoard, nowMs));
  }
  lines.push('', '🤖 @PoorBoyAI_bot');
  return lines.join('\n');
}

export function buildLpAnnouncementText(coin) {
  const grad = coin.graduationProgress === null ? '' : `\n📈 ${Math.round(coin.graduationProgress * 100)}% to graduation`;
  const desc = coin.description ? `\n${String(coin.description).slice(0, 200)}` : '';
  return `🚀 New on PB LaunchPad\n\n${coin.name || ''} ($${coin.symbol || '???'}) — ${lpChainLabel(coin.chain)}${grad}${desc}\n\n🔗 ${lpCoinUrl(coin)}\n📊 ${lpDexUrl(coin)}`;
}

// Pure listing-pass planner (harnessable without db): given the site's
// listed coins, the announced-set, and the pending queue, decide what to
// enqueue, what to send now (cap 10), and what went stale (>24h queued
// without a successful send — the caller marks stale keys announced so
// they are never re-queued). Unlisted and demo coins never enter.
export function planLpAnnouncements({ coins, announced, queue }) {
  const announcedMap = announced && typeof announced === 'object' ? announced : {};
  const q = Array.isArray(queue) ? queue.slice() : [];
  const queuedKeys = new Set(q.map((i) => i.key));
  let discovered = 0;
  for (const coin of coins || []) {
    if (!coin.listed || coin.demo) continue;
    const key = lpCoinKey(coin);
    if (announcedMap[key] || queuedKeys.has(key)) continue;
    q.push({ key, coin, queuedAt: Date.now() });
    queuedKeys.add(key);
    discovered++;
  }
  const now = Date.now();
  const fresh = [];
  const toAnnounce = [];
  const stale = [];
  for (const item of q) {
    if (announcedMap[item.key]) continue;
    if (now - (Number(item.queuedAt) || 0) > 24 * 60 * 60 * 1000) { stale.push(item); continue; }
    fresh.push(item);
    if (toAnnounce.length < 10) toAnnounce.push(item);
  }
  return { queue: fresh, toAnnounce, discovered, stale };
}

// Listing pass orchestrator (deps injected for harnessing; the tick cycle
// wires the real ones). Config keys: lp_announced (map key → {at, stale?}),
// lp_announce_queue (pending snapshots), lp_watch_targets (buy-watch
// registry — registration at listing), lp_announce_chats (override list;
// default is home only, sealed — never known_groups). Never throws: an
// API outage returns apiOk:false and the cycle reports counts, not an
// error, so a read-only feed being down never pages the owner.
export async function runLpListingPass(deps = {}) {
  const getCfg = deps.getConfig;
  const setCfg = deps.setConfig;
  const send = deps.send;
  const homeChat = deps.homeChatId;
  const fetchBoard = deps.fetchBoard || fetchLpBoard;
  const now = deps.now ?? Date.now();
  const readJson = async (key, fallback) => {
    try {
      const raw = await getCfg(key, null);
      if (raw === null || raw === undefined || raw === '') return fallback;
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch { return fallback; }
  };
  const board = await fetchBoard().catch(() => null);
  if (!board) return { apiOk: false, checked: 0, listed: 0, discovered: 0, announced: 0, queued: 0, registered: 0, targets: 0, stale: 0 };
  const coins = (board.coins || []).filter((c) => c.listed && !c.demo);
  const announced = await readJson('lp_announced', {});
  const queue = await readJson('lp_announce_queue', []);
  const plan = planLpAnnouncements({ coins, announced, queue });
  const targets = await readJson('lp_watch_targets', []);
  const have = new Set((Array.isArray(targets) ? targets : []).map((t) => `${String(t.chain).toLowerCase()}:${String(t.ca).toLowerCase()}`));
  let registered = 0;
  for (const coin of coins) {
    const key = lpCoinKey(coin);
    if (have.has(key)) continue;
    targets.push({ ca: coin.tokenAddress, chain: coin.chain, symbol: coin.symbol, name: coin.name, registeredAt: Math.floor(now / 1000), graduated: false });
    have.add(key);
    registered++;
  }
  let chats = await readJson('lp_announce_chats', null);
  if (!Array.isArray(chats) || !chats.length) {
    const h = await homeChat().catch(() => null);
    chats = h ? [String(h)] : [];
  }
  chats = chats.map(String).filter(Boolean);
  let announcedCount = 0;
  const newAnnounced = { ...(announced && typeof announced === 'object' ? announced : {}) };
  for (const item of plan.toAnnounce) {
    const text = buildLpAnnouncementText(item.coin);
    let ok = false;
    for (const chatId of chats) {
      try { await send(chatId, text); ok = true; } catch { /* per-chat failure: item stays queued for retry unless stale */ }
    }
    if (ok) { newAnnounced[item.key] = { at: Math.floor(now / 1000) }; announcedCount++; }
  }
  for (const item of plan.stale) newAnnounced[item.key] = { at: Math.floor(now / 1000), stale: true };
  const remainingQueue = plan.queue.filter((i) => !newAnnounced[i.key]);
  await setCfg('lp_announce_queue', JSON.stringify(remainingQueue)).catch(() => {});
  await setCfg('lp_announced', JSON.stringify(newAnnounced)).catch(() => {});
  await setCfg('lp_watch_targets', JSON.stringify(targets)).catch(() => {});
  return { apiOk: true, checked: coins.length, listed: coins.length, discovered: plan.discovered, announced: announcedCount, queued: remainingQueue.length, registered, targets: targets.length, stale: plan.stale.length };
}

async function lpSendSafe(chatId, text) {
  try { await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }); } catch { /* board send failure: no retry, no crash */ }
}

// /launchpad — public read-only board (any chat, any member). No gate:
// the board is public aggregate data, the same payload the Mini App
// LaunchPad screen shows. Never a write path, never a quote.
// NFT lane (N3, 2026-11-04): the same call also fetches the NFT board
// and appends its live-drops / closing-soon lane; a down NFT API only
// drops that lane with an honest line, never the token board.
export const LP_COMMANDS = {
  launchpad: async (chatId, _args, _msg) => {
    const [board, nftBoard] = await Promise.all([
      fetchLpBoard().catch(() => null),
      fetchLpNftBoard().catch(() => null),
    ]);
    await lpSendSafe(chatId, formatLpBoard(board, nftBoard));
  },
};

// ── PB LaunchPad NFT lane (N3, 2026-11-04) ─────────────────────────────
// Second lane on the existing LaunchPad (spec PB-LAUNCHPAD-NFT-SPEC.md
// §6.4): fixed-supply ERC-721 drops, factory 0x7b28cC8af66D429C2f5293c108C2DBCf0B9e7A8c
// on Base Sepolia. Mirrors the token lane's shapes exactly — same
// verify-first backend, same fail-quiet reads, same sealed distribution.
// SEPOLIA ONLY in this wave: mainnet collections are skipped unless the
// `lp_nft_mainnet` config flag is explicitly '1' (default off, N4 gate).
// N1 API CONTRACT (not staged yet at build time — 2026-11-04 ~23:35 the
// backend tree carries no /api/lp-nft/* routes; N1 confirms/adjusts
// field names): GET /api/lp-nft/status → { launchpad, writesEnabled,
// chains[] }; GET /api/lp-nft/collections → { collections[], launchpad,
// note }. normalizeLpNftCollection tolerates missing OPTIONAL fields;
// a row without chain + collectionAddress is dropped, never invented.
// The bot NEVER holds keys, signs, or relays user transactions, and
// implements NO tier check — the Worker checks the creator's tier
// before issuing a creation permit (mainnet Starter+; Sepolia open);
// the bot reads the backend's outcome only. Minting is never tier-gated.
// VISUAL LAW (Rowdy, 2026-11-04 ~23:34 — "visually out of this world"):
// a launch/milestone post is a PHOTO post: the collection's REAL art
// (imageUrl from the N1 payload) is the photo, the caption is short
// HTML (≤1024 chars, the Telegram photo-caption cap), and link-out
// buttons carry the mint path. No art URL → the PB Announce typeset
// card (renderAnnouncePoster, same card the Announce wizard posts)
// is rendered as the photo instead — never a bare text post for a
// launch. Reveal gets its own event post: the reveal IS the moment.

export const LP_NFT_API_BASE = 'https://poorboyai.pages.dev/api/lp-nft';
export const LP_NFT_SITE = 'https://poorboyai.pages.dev/launchpad/nft';
export const LP_NFT_SEPOLIA_CHAIN_ID = 84532;
export const LP_NFT_MAINNET_CHAIN_ID = 8453;
export const LP_NFT_MILESTONE_THRESHOLDS = [25, 50, 90, 100];
export const LP_NFT_FINAL_HOUR_MS = 60 * 60 * 1000;
export const LP_NFT_CLOSING_SOON_MS = 48 * 60 * 60 * 1000;

function escNftHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Unix seconds in, ms-tolerant: N1 reports seconds (token-lane
// convention); a ms value passes through unchanged.
function nftToMs(v) {
  const n = Number(v) || 0;
  if (!n) return null;
  return n > 1e12 ? n : n * 1000;
}

function fmtNftDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; } catch { return '—'; }
}

// wei (string) → ETH display, BigInt throughout, ≤4 decimals, trimmed.
// '0' → 'Free'. Null/invalid → null (caller renders '—').
export function nftWeiToEth(wei) {
  try {
    const w = BigInt(String(wei ?? '').trim());
    if (w === 0n) return 'Free';
    const whole = w / 1000000000000000000n;
    const frac = w % 1000000000000000000n;
    if (frac === 0n) return whole.toString();
    const dec = frac.toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
    return dec ? `${whole}.${dec}` : whole.toString();
  } catch { return null; }
}

export function lpNftKey(c) {
  const chain = String(c?.chain || '').toLowerCase();
  const addr = String(c?.collectionAddress || c?.address || '');
  return `${chain}:${addr.toLowerCase()}`;
}

export function lpNftCollectionUrl(c) {
  return `${LP_NFT_SITE}/${encodeURIComponent(c.chain)}/${encodeURIComponent(c.collectionAddress)}`;
}

export function lpNftBasescanUrl(c) {
  const host = Number(c.chainId) === LP_NFT_MAINNET_CHAIN_ID ? 'basescan.org' : 'sepolia.basescan.org';
  return `https://${host}/address/${c.collectionAddress}`;
}

export function lpNftOpenseaAssetUrl(c, tokenId = 1) {
  const net = Number(c.chainId) === LP_NFT_MAINNET_CHAIN_ID ? 'base' : 'base-sepolia';
  const host = net === 'base' ? 'opensea.io' : 'testnets.opensea.io';
  return `https://${host}/assets/${net}/${c.collectionAddress}/${tokenId}`;
}

export function normalizeLpNftCollection(c) {
  if (!c || typeof c !== 'object') return null;
  const chain = String(c.chain || '');
  const collectionAddress = String(c.collectionAddress || c.address || '');
  if (!chain || !collectionAddress) return null;
  const cap = Number(c.supplyCap);
  const minted = Number(c.totalMinted);
  const royalty = Number(c.royaltyBps);
  return {
    chain, chainId: Number(c.chainId) || null, collectionAddress,
    factoryAddress: String(c.factoryAddress || ''),
    creator: String(c.creator || ''),
    creatorTelegramId: c.creatorTelegramId != null ? String(c.creatorTelegramId) : null,
    linkedGroupChatId: c.linkedGroupChatId != null ? String(c.linkedGroupChatId) : null,
    name: String(c.name || ''), symbol: String(c.symbol || ''),
    description: String(c.description || ''),
    imageUrl: String(c.imageUrl || ''),
    links: {
      website: String(c.links?.website || ''), twitter: String(c.links?.twitter || ''),
      telegram: String(c.links?.telegram || ''),
    },
    status: String(c.status || ''), listed: c.listed === true, demo: c.demo === true,
    supplyCap: Number.isFinite(cap) && cap > 0 ? cap : null,
    totalMinted: Number.isFinite(minted) && minted >= 0 ? minted : 0,
    mintPriceWei: String(c.mintPriceWei ?? ''),
    mintPriceEth: c.mintPriceEth != null ? String(c.mintPriceEth) : null,
    startTime: nftToMs(c.startTime), endTime: nftToMs(c.endTime),
    royaltyBps: Number.isFinite(royalty) ? royalty : null,
    revealed: c.revealed === true,
    createdOnchainAt: Number(c.createdOnchainAt) || null,
  };
}

export function nftMintPriceDisplay(c) {
  if (c.mintPriceEth != null && c.mintPriceEth !== '') {
    const n = Number(c.mintPriceEth);
    return Number.isFinite(n) ? (n === 0 ? 'Free' : String(c.mintPriceEth)) : null;
  }
  return nftWeiToEth(c.mintPriceWei);
}

export function nftMintPct(c) {
  if (!c.supplyCap || c.supplyCap <= 0) return null;
  return Math.min(100, Math.floor((c.totalMinted / c.supplyCap) * 100));
}

export function nftWindowState(c, nowMs = Date.now()) {
  if (c.supplyCap && c.totalMinted >= c.supplyCap) return 'sold-out';
  if (c.endTime && nowMs > c.endTime) return 'ended';
  if (c.startTime && nowMs < c.startTime) return 'upcoming';
  return 'live';
}

export function nftIsClosingSoon(c, nowMs = Date.now()) {
  const st = nftWindowState(c, nowMs);
  if (st !== 'live' && st !== 'upcoming') return false;
  return !!c.endTime && (c.endTime - nowMs) > 0 && (c.endTime - nowMs) <= LP_NFT_CLOSING_SOON_MS;
}

export function nftProgressBar(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round(p / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Sepolia gate for this wave: only chain 84532 passes unless the
// caller explicitly arms mainnet (N4, Rowdy's call). Unknown chains
// never pass — a mislabelled mainnet drop cannot leak into Sepolia
// announcements by accident.
export function nftChainAllowed(c, mainnetEnabled = false) {
  if (Number(c.chainId) === LP_NFT_SEPOLIA_CHAIN_ID) return true;
  if (mainnetEnabled && Number(c.chainId) === LP_NFT_MAINNET_CHAIN_ID) return true;
  return false;
}

export async function fetchLpNftStatus(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${LP_NFT_API_BASE}/status`, { headers: { Accept: 'application/json' } });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      launchpad: String(data.launchpad || ''),
      writesEnabled: data.writesEnabled === true,
      chains: (Array.isArray(data.chains) ? data.chains : []).map((ch) => ({
        key: String(ch.key || ''), chainId: Number(ch.chainId) || null,
        label: String(ch.label || ch.key || ''), testnet: ch.testnet === true,
        configured: ch.configured === true, enabled: ch.enabled === true,
        factoryAddress: String(ch.factoryAddress || ''),
      })),
    };
  } catch { return null; }
}

export async function fetchLpNftCollections({ sort = 'new', limit = 60 } = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${LP_NFT_API_BASE}/collections?sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(limit)}`, { headers: { Accept: 'application/json' } });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    const collections = (Array.isArray(data.collections) ? data.collections : []).map(normalizeLpNftCollection).filter(Boolean);
    return { collections, launchpad: String(data.launchpad || ''), note: String(data.note || '') };
  } catch { return null; }
}

export async function fetchLpNftBoard(fetchImpl = fetch) {
  const [status, list] = await Promise.all([fetchLpNftStatus(fetchImpl), fetchLpNftCollections({}, fetchImpl)]);
  if (!status && !list) return null;
  return { status, collections: list?.collections ?? [], launchpad: list?.launchpad ?? status?.launchpad ?? '', note: list?.note ?? '' };
}

export function formatLpNftBoard(nftBoard, nowMs = Date.now()) {
  if (!nftBoard) return '🎨 NFT drops\n\nDrops lane unavailable right now — the pad API did not answer. Try /launchpad again in a bit.';
  const parked = nftBoard.status?.launchpad === 'parked' || nftBoard.launchpad === 'parked';
  const cols = (nftBoard.collections || []).filter((c) => c.listed && !c.demo);
  const live = cols.filter((c) => nftWindowState(c, nowMs) === 'live' || nftWindowState(c, nowMs) === 'upcoming');
  const closing = cols.filter((c) => nftIsClosingSoon(c, nowMs));
  const done = cols.filter((c) => ['sold-out', 'ended'].includes(nftWindowState(c, nowMs)));
  const lines = ['🎨 NFT Drops — read-only', ''];
  if (parked) lines.push('Status: PARKED — NFT creation is closed and no live drops exist yet.', '');
  if (!cols.length) {
    lines.push(nftBoard.note || 'No confirmed NFT drops yet. Drops appear here only after their on-chain creation is verified.');
  } else {
    if (live.length) {
      lines.push('🆕 Live drops:');
      for (const c of live.slice(0, 10)) {
        const pct = nftMintPct(c);
        const price = nftMintPriceDisplay(c) ?? '—';
        lines.push(`• ${c.name || 'Unnamed drop'} — ${c.totalMinted}/${c.supplyCap ?? '?'}${pct === null ? '' : ` (${pct}%)`} · ${price === 'Free' ? 'Free mint' : `${price} ETH`} (${lpChainLabel(c.chain)})`);
        lines.push(`  ${lpNftCollectionUrl(c)}`);
      }
      lines.push('');
    }
    if (closing.length) {
      lines.push('⏰ Closing soon:');
      for (const c of closing.slice(0, 10)) {
        lines.push(`• ${c.name || 'Unnamed drop'} — closes ${fmtNftDate(c.endTime)} · ${c.totalMinted}/${c.supplyCap ?? '?'} minted`);
        lines.push(`  ${lpNftCollectionUrl(c)}`);
      }
      lines.push('');
    }
    if (done.length) {
      lines.push(`✅ Finished: ${done.map((c) => `${c.name || 'drop'} (${nftWindowState(c, nowMs) === 'sold-out' ? 'sold out' : 'ended'})`).join(', ')}`);
      lines.push('');
    }
  }
  lines.push(`🔗 ${LP_NFT_SITE}`);
  return lines.join('\n');
}

// ── NFT photo posts (visual law) ──────────────────────────────────────────
// buildLpNftPost returns the whole post object the sender needs:
// { kind, key, caption (HTML, ≤1024), photoUrl|null, posterBytes|null,
// buttons }. The caller (tick pass) sends photoUrl via sendPhoto, else
// posterBytes via sendPhoto(InputFile), else plain text. Caption is
// hard-capped at 1024 — a long creator description can never break the
// send. Buttons link OUT to the site for minting/creation: the bot
// never takes a wallet signature.
export function buildLpNftPost(c, kind, nowMs = Date.now()) {
  const key = lpNftKey(c);
  const name = escNftHtml(c.name || 'Unnamed drop');
  const desc = escNftHtml(String(c.description || '').slice(0, 120));
  const price = nftMintPriceDisplay(c) ?? '—';
  const priceTxt = price === 'Free' ? 'Free mint' : `${price} ETH`;
  const pct = nftMintPct(c);
  const remaining = c.supplyCap === null ? '?' : Math.max(0, c.supplyCap - c.totalMinted);
  const royalty = c.royaltyBps === null ? '?' : (c.royaltyBps / 100).toString().replace(/\.0$/, '');
  const url = lpNftCollectionUrl(c);
  const buttons = { inline_keyboard: [
    [{ text: '🖼️ View drop', url }],
    [{ text: '🔍 Contract', url: lpNftBasescanUrl(c) }],
  ] };
  if (c.totalMinted > 0) {
    buttons.inline_keyboard.push([{ text: '🌊 OpenSea', url: lpNftOpenseaAssetUrl(c, 1) }]);
  }
  let caption = '';
  let tag = 'NFT DROP';
  let hook = '';
  if (kind === 'launch') {
    tag = 'NFT DROP';
    hook = `${c.name || 'Unnamed drop'} just launched — ${priceTxt}, ${c.supplyCap ?? '?'} pieces.`;
    caption = [
      `🎨 <b>${name}</b>`,
      `🆕 NEW NFT DROP — PB LaunchPad · ${escNftHtml(lpChainLabel(c.chain))}`,
      desc,
      ``,
      `💎 ${escNftHtml(priceTxt)} · ${c.supplyCap ?? '?'} pieces`,
      `⏰ Mint window: ${fmtNftDate(c.startTime)} → ${fmtNftDate(c.endTime)}`,
      `✨ Creator keeps 95% · 5% platform · Royalties ${escNftHtml(royalty)}% (marketplaces choose whether to honor them)`,
      `🌊 Appears on OpenSea automatically once minted.`,
      ``,
      `🤖 @PoorBoyAI_bot`,
    ].filter((l, i) => !(i === 2 && !desc)).join('\n');
  } else if (kind === 'sold-out') {
    tag = 'SOLD OUT';
    hook = `${c.name || 'Unnamed drop'} sold out — ${c.supplyCap} of ${c.supplyCap} minted.`;
    caption = [
      `🏆 <b>${name}</b> — SOLD OUT`,
      `${nftProgressBar(100)} 100% — ${c.supplyCap}/${c.supplyCap} minted`,
      `💎 ${escNftHtml(priceTxt)} · 0 left`,
      `🌊 Now trading on OpenSea — see the drop page.`,
      ``,
      `🤖 @PoorBoyAI_bot`,
    ].join('\n');
  } else if (kind === 'final-hour') {
    tag = 'FINAL HOUR';
    hook = `${c.name || 'Unnamed drop'} — final hour, ${remaining} left.`;
    caption = [
      `⏰ <b>${name}</b> — FINAL HOUR`,
      `${nftProgressBar(pct)} ${pct ?? '?'}% — ${c.totalMinted}/${c.supplyCap ?? '?'} minted`,
      `💎 ${escNftHtml(priceTxt)} · ${remaining} left`,
      `⏰ Closes ${fmtNftDate(c.endTime)} — then minting ends for good.`,
      ``,
      `🤖 @PoorBoyAI_bot`,
    ].join('\n');
  } else if (kind === 'revealed') {
    tag = 'REVEALED';
    hook = `${c.name || 'Unnamed drop'} revealed — the art is live.`;
    caption = [
      `✨ <b>${name}</b> — REVEALED`,
      `The art is live — every token now shows its final piece. Metadata is frozen from here on: nobody can change it again.`,
      `💎 ${c.totalMinted}/${c.supplyCap ?? '?'} minted · ${escNftHtml(priceTxt)}`,
      `🌊 See token #1 on OpenSea, or the full drop below.`,
      ``,
      `🤖 @PoorBoyAI_bot`,
    ].join('\n');
  } else {
    // milestone-<pct>
    const pctNum = Number(String(kind).replace('milestone-', '')) || pct || 0;
    tag = `${pctNum}% MINTED`;
    hook = `${c.name || 'Unnamed drop'} — ${pctNum}% minted.`;
    caption = [
      `🔥 <b>${name}</b> — ${pctNum}% MINTED`,
      `${nftProgressBar(pctNum)} ${pctNum}% — ${c.totalMinted}/${c.supplyCap ?? '?'} minted`,
      `💎 ${escNftHtml(priceTxt)} · ${remaining} left`,
      `⏰ Closes ${fmtNftDate(c.endTime)}`,
      ``,
      `🤖 @PoorBoyAI_bot`,
    ].join('\n');
  }
  caption = String(caption).slice(0, 1024);
  const photoUrl = c.imageUrl || null;
  // No art → PB Announce typeset card as the photo (pure bytes, no I/O).
  const posterBytes = photoUrl ? null : renderAnnouncePoster({
    tag, name: c.name || 'Announcement', hook,
    footer: `${priceTxt} · ${c.supplyCap ?? '?'} pieces · ${lpChainLabel(c.chain)}`,
    credit: null,
  });
  return { kind, key, caption, photoUrl, posterBytes, buttons };
}

// Pure launch planner (harnessable without db): mirror of
// planLpAnnouncements, Sepolia-gated. Unlisted/demo/wrong-chain rows
// never enter. Returns { queue, toAnnounce, discovered, stale }.
export function planLpNftAnnouncements({ collections, announced, queue, mainnetEnabled = false }) {
  const announcedMap = announced && typeof announced === 'object' ? announced : {};
  const q = Array.isArray(queue) ? queue.slice() : [];
  const queuedKeys = new Set(q.map((i) => i.key));
  let discovered = 0;
  for (const c of collections || []) {
    if (!c.listed || c.demo || !nftChainAllowed(c, mainnetEnabled)) continue;
    const key = lpNftKey(c);
    if (announcedMap[key] || queuedKeys.has(key)) continue;
    q.push({ key, collection: c, queuedAt: Date.now() });
    queuedKeys.add(key);
    discovered++;
  }
  const now = Date.now();
  const fresh = [];
  const toAnnounce = [];
  const stale = [];
  for (const item of q) {
    if (announcedMap[item.key]) continue;
    if (now - (Number(item.queuedAt) || 0) > 24 * 60 * 60 * 1000) { stale.push(item); continue; }
    fresh.push(item);
    if (toAnnounce.length < 10) toAnnounce.push(item);
  }
  return { queue: fresh, toAnnounce, discovered, stale };
}

// Launch pass orchestrator (deps injected for harnessing; the tick
// cycle wires the real ones). Config keys: lp_nft_announced (map key →
// {at, stale?}), lp_nft_announce_queue (pending snapshots),
// lp_nft_announce_chats (override list). Distribution is SEALED per
// drop: home + the creator's linked group from the collection record
// (linkedGroupChatId, only when present) — never known_groups, never
// sprayed. send(chatId, post) is the tick wiring's photo sender
// (sendPhoto art/card, else text). Never throws: an API outage returns
// apiOk:false and the cycle reports counts, not an error.
export async function runLpNftListingPass(deps = {}) {
  const getCfg = deps.getConfig;
  const setCfg = deps.setConfig;
  const send = deps.send;
  const homeChat = deps.homeChatId;
  const fetchBoard = deps.fetchBoard || fetchLpNftBoard;
  const now = deps.now ?? Date.now();
  const mainnetEnabled = deps.mainnetEnabled === true;
  const readJson = async (key, fallback) => {
    try {
      const raw = await getCfg(key, null);
      if (raw === null || raw === undefined || raw === '') return fallback;
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch { return fallback; }
  };
  const board = await fetchBoard().catch(() => null);
  if (!board) return { apiOk: false, checked: 0, listed: 0, discovered: 0, announced: 0, queued: 0, stale: 0 };
  const collections = (board.collections || []).filter((c) => c.listed && !c.demo && nftChainAllowed(c, mainnetEnabled));
  const announced = await readJson('lp_nft_announced', {});
  const queue = await readJson('lp_nft_announce_queue', []);
  const plan = planLpNftAnnouncements({ collections, announced, queue, mainnetEnabled });
  const override = await readJson('lp_nft_announce_chats', null);
  const home = await homeChat().catch(() => null);
  let announcedCount = 0;
  const newAnnounced = { ...(announced && typeof announced === 'object' ? announced : {}) };
  for (const item of plan.toAnnounce) {
    const post = buildLpNftPost(item.collection, 'launch', now);
    const chats = (Array.isArray(override) && override.length)
      ? override.map(String).filter(Boolean)
      : [home, item.collection.linkedGroupChatId].map((x) => (x == null ? '' : String(x))).filter(Boolean);
    let ok = false;
    for (const chatId of chats) {
      try { await send(chatId, post); ok = true; } catch { /* per-chat failure: item stays queued for retry unless stale */ }
    }
    if (ok) { newAnnounced[item.key] = { at: Math.floor(now / 1000) }; announcedCount++; }
  }
  for (const item of plan.stale) newAnnounced[item.key] = { at: Math.floor(now / 1000), stale: true };
  const remainingQueue = plan.queue.filter((i) => !newAnnounced[i.key]);
  await setCfg('lp_nft_announce_queue', JSON.stringify(remainingQueue)).catch(() => {});
  await setCfg('lp_nft_announced', JSON.stringify(newAnnounced)).catch(() => {});
  return { apiOk: true, checked: collections.length, listed: collections.length, discovered: plan.discovered, announced: announcedCount, queued: remainingQueue.length, stale: plan.stale.length };
}

// ── NFT milestones (indexer truth only) ───────────────────────────────────
// Thresholds 25/50/90/100 + final-hour + revealed. The planner is PURE:
// given collections (totalMinted/supplyCap/endTime/revealed as the N1
// indexer reports them) + the fired map, it returns due posts. A burst
// that crosses several thresholds in one poll coalesces to ONE post per
// collection (priority: sold-out > revealed > final-hour > highest
// milestone) — a fast drop can never flood a group. Exactly-once via
// idempotency key nft:<chain>:<addr>:<kind> in config
// lp_nft_milestones_fired. Never seeded, never from a user claim: a
// count the indexer did not report does not exist here.
export function planLpNftMilestones({ collections, fired, nowMs = Date.now(), mainnetEnabled = false }) {
  const firedMap = fired && typeof fired === 'object' ? fired : {};
  const due = [];
  let alreadyFired = 0;
  for (const c of collections || []) {
    if (!c.listed || c.demo || !nftChainAllowed(c, mainnetEnabled)) continue;
    if (!c.supplyCap || c.supplyCap <= 0) continue;
    const key = lpNftKey(c);
    const pct = nftMintPct(c);
    const candidates = [];
    // Highest crossed, unfired threshold. A fired higher threshold
    // implies every lower one (a sold-out drop crossed 25/50/90 by
    // definition) — without this, a burst that sells out would drip
    // stale 90/50/25 posts on later passes, one per pass.
    let firedMax = 0;
    for (const t of LP_NFT_MILESTONE_THRESHOLDS) {
      if (firedMap[`${key}:${t === 100 ? 'sold-out' : `milestone-${t}`}`]) firedMax = Math.max(firedMax, t);
    }
    let top = null;
    for (const t of LP_NFT_MILESTONE_THRESHOLDS) {
      if (pct !== null && pct >= t && t > firedMax) top = t;
    }
    if (top !== null) candidates.push({ kind: top === 100 ? 'sold-out' : `milestone-${top}`, rank: top === 100 ? 4 : 1 });
    if (c.revealed && !firedMap[`${key}:revealed`]) candidates.push({ kind: 'revealed', rank: 3 });
    const state = nftWindowState(c, nowMs);
    if (state === 'live' && c.endTime && (c.endTime - nowMs) > 0 && (c.endTime - nowMs) <= LP_NFT_FINAL_HOUR_MS && !firedMap[`${key}:final-hour`]) {
      candidates.push({ kind: 'final-hour', rank: 2 });
    }
    if (!candidates.length) { alreadyFired++; continue; }
    candidates.sort((a, b) => b.rank - a.rank);
    const pick = candidates[0];
    due.push({ collection: c, kind: pick.kind, key: `${key}:${pick.kind}`, coalesced: candidates.length });
  }
  return { due, alreadyFired };
}

export async function runLpNftMilestonePass(deps = {}) {
  const getCfg = deps.getConfig;
  const setCfg = deps.setConfig;
  const send = deps.send;
  const homeChat = deps.homeChatId;
  const fetchBoard = deps.fetchBoard || fetchLpNftBoard;
  const now = deps.now ?? Date.now();
  const mainnetEnabled = deps.mainnetEnabled === true;
  const readJson = async (key, fallback) => {
    try {
      const raw = await getCfg(key, null);
      if (raw === null || raw === undefined || raw === '') return fallback;
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch { return fallback; }
  };
  const board = await fetchBoard().catch(() => null);
  if (!board) return { apiOk: false, checked: 0, due: 0, posted: 0, coalesced: 0 };
  const collections = (board.collections || []).filter((c) => c.listed && !c.demo && nftChainAllowed(c, mainnetEnabled));
  const fired = await readJson('lp_nft_milestones_fired', {});
  const plan = planLpNftMilestones({ collections, fired, nowMs: now, mainnetEnabled });
  const override = await readJson('lp_nft_announce_chats', null);
  const home = await homeChat().catch(() => null);
  const newFired = { ...(fired && typeof fired === 'object' ? fired : {}) };
  let posted = 0;
  let coalesced = 0;
  for (const item of plan.due.slice(0, 10)) {
    const post = buildLpNftPost(item.collection, item.kind, now);
    const chats = (Array.isArray(override) && override.length)
      ? override.map(String).filter(Boolean)
      : [home, item.collection.linkedGroupChatId].map((x) => (x == null ? '' : String(x))).filter(Boolean);
    let ok = false;
    for (const chatId of chats) {
      try { await send(chatId, post); ok = true; } catch { /* per-chat failure: not marked fired, retries next pass */ }
    }
    if (ok) { newFired[item.key] = { at: Math.floor(now / 1000) }; posted++; coalesced += Math.max(0, (item.coalesced || 1) - 1); }
  }
  await setCfg('lp_nft_milestones_fired', JSON.stringify(newFired)).catch(() => {});
  return { apiOk: true, checked: collections.length, due: plan.due.length, posted, coalesced };
}

// ── Uniswap API client (V1 read-only, 2026-10-28, audit item 34) ─────────
// Spec: goal hidden_files/PB-UNISWAP-API-SPEC-2026-10-28.md.
// READ-ONLY by construction: the only endpoints called are POST /quote
// (trade API) and POST /lp/pool_info (liquidity API). No /swap, /order,
// /lp/create|increase|decrease|claim_fees, or any transaction-building
// call exists anywhere in this section — grep-proof: those path strings
// appear only in this comment as the forbidden list.
// FAIL-CLOSED WITHOUT KEY: both public functions return null BEFORE any
// network call when UNISWAP_API_KEY is absent from bot config, so every
// wired surface renders byte-identically to before the wave.
// FAIL-OPEN ON API ERROR: any failure (non-2xx, bad JSON, unparseable
// shape, failed simulation) returns null and callers render today's text.
// Nothing here ever throws to a caller: every public function catches all.
// KEY HYGIENE: the key is read fresh via getConfig on every call (so a
// /setkey tonight takes effect with no restart/deploy) and is NEVER
// logged, NEVER put in an error string, NEVER written to a file.
// RATE LIMIT (official FAQ): 6 req/s per key default. V1 callers are
// human-paced only (button taps, /price) — no tick-cycle caller may call
// these functions, so the limit is unreachable in V1.
const UNI_TRADE_API = 'https://trade-api.gateway.uniswap.org/v1';
const UNI_LIQUIDITY_API = 'https://liquidity.api.uniswap.org';
const UNI_BASE_CHAIN_ID = 8453;
const UNI_USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const UNI_WETH_BASE = '0x4200000000000000000000000000000000000006';
const UNI_ZERO_SWAPPER = '0x0000000000000000000000000000000000000000';
const UNI_QUOTE_USDC_EXAMPLE = 100;

// Test seam (precedent: llm.js __setLlmFetchForTest). Production uses the
// sdk fetch; the harness overrides it so no test touches the network.
let _uniFetchOverride = null;
export function __setUniswapFetchForTest(fn) { _uniFetchOverride = fn ?? null; }
export function __resetUniswapFetchForTest() { _uniFetchOverride = null; }
function uniFetch(...args) { return (_uniFetchOverride ?? fetch)(...args); }

async function uniswapApiKey() {
  try {
    const raw = await getConfig('UNISWAP_API_KEY', null);
    const key = typeof raw === 'string' ? raw.trim() : '';
    return key ? key : null;
  } catch { return null; }
}

// Format a base-units integer string as human units with commas.
// BigInt throughout: PBAI base-unit amounts exceed Number.MAX_SAFE_INTEGER,
// so float division would corrupt the display. Whole >= 1000 renders
// without decimals (sub-unit noise); smaller amounts show 2 decimals.
// Returns null on bad input.
export function formatBaseUnits(amountStr, decimals) {
  try {
    const amount = BigInt(String(amountStr));
    if (amount <= 0n) return null;
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const frac = amount % scale;
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (whole >= 1000n) return wholeStr;
    const frac2 = ((frac * 100n) / scale).toString().padStart(2, '0');
    return `${wholeStr}.${frac2}`;
  } catch { return null; }
}

// Strict ClassicQuote parser. Verified shape (official OpenAPI spec at
// trade-api.gateway.uniswap.org/v1/api.json): ClassicQuote =
// { input: { amount, token }, output: { amount, token, recipient,
// minimumAmount }, swapper, chainId, slippage, tradeType, gasFee, gasFeeUSD,
// gasFeeQuote, route, routeString, quoteId, gasUseEstimate, ... }.
// Guards (ALL must pass, else null — a wrong number must be impossible):
// routing is CLASSIC (V3-only request; UniswapX Dutch/priority shapes have
// different output semantics and are out of V1); output.token is exactly
// the $PBAI address; output.amount is a positive integer string and is
// not an echo of the input amount; no failed simulation (txFailureReasons
// empty/absent, no txFailureReason string anywhere on the response).
function parseClassicQuote(data, inputAmountStr, expectedToken = PROJECT_COIN_CA) {
  try {
    if (!data || typeof data !== 'object') return null;
    if (data.routing !== 'CLASSIC') return null;
    const q = data.quote;
    if (!q || typeof q !== 'object') return null;
    const out = q.output;
    if (!out || typeof out !== 'object') return null;
    if (String(out.token ?? '').toLowerCase() !== String(expectedToken).toLowerCase()) return null;
    const outAmount = String(out.amount ?? '');
    if (!/^[0-9]+$/.test(outAmount) || BigInt(outAmount) <= 0n) return null;
    if (outAmount === String(inputAmountStr)) return null;
    const fails = q.txFailureReasons ?? data.txFailureReasons;
    if (Array.isArray(fails) && fails.length) return null;
    if (typeof q.txFailureReason === 'string' && q.txFailureReason) return null;
    if (typeof data.txFailureReason === 'string' && data.txFailureReason) return null;
    const outputPbai = formatBaseUnits(outAmount, 18);
    if (!outputPbai) return null;
    let outputMinPbai = null;
    if (typeof out.minimumAmount === 'string' && /^[0-9]+$/.test(out.minimumAmount)) {
      outputMinPbai = formatBaseUnits(out.minimumAmount, 18);
    }
    let gasFeeUsd = null;
    const gas = Number(q.gasFeeUSD);
    if (Number.isFinite(gas) && gas > 0) gasFeeUsd = gas.toFixed(2);
    return { outputPbai, outputMinPbai, gasFeeUsd, routing: 'CLASSIC' };
  } catch { return null; }
}

// Example buy quote: what `usdcAmount` USDC gets in $PBAI on Uniswap V3
// Base right now. Display-only: swapper is the zero address because PB
// holds no user wallet for a display quote (spec V-1: the first live call
// must confirm a clean CLASSIC quote returns for it; until then a failed
// simulation yields null, never a shown quote). protocols ['V3'] keeps
// routing CLASSIC through $PBAI's own V3 pool and sidesteps the UniswapX
// L2 minimum (1000 USDC). autoSlippage DEFAULT: one of slippageTolerance
// / autoSlippage is required by the API; V1 sets no fee fields, so no
// integrator fee is taken. Returns null without a key or on any failure.
export async function getUniswapPbaiQuote(usdcAmount = UNI_QUOTE_USDC_EXAMPLE) {
  try {
    const key = await uniswapApiKey();
    if (!key) return null;
    const units = Number(usdcAmount);
    if (!Number.isFinite(units) || units <= 0) return null;
    const amountStr = (BigInt(Math.round(units)) * 1000000n).toString();
    const res = await uniFetch(`${UNI_TRADE_API}/quote`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        type: 'EXACT_INPUT',
        amount: amountStr,
        tokenInChainId: UNI_BASE_CHAIN_ID,
        tokenOutChainId: UNI_BASE_CHAIN_ID,
        tokenIn: UNI_USDC_BASE,
        tokenOut: PROJECT_COIN_CA,
        swapper: UNI_ZERO_SWAPPER,
        autoSlippage: 'DEFAULT',
        protocols: ['V3'],
      }),
    });
    if (!res || !res.ok) return getUniswapPbaiQuoteComposed(key, units);
    const data = await res.json().catch(() => null);
    const parsed = parseClassicQuote(data, amountStr);
    if (!parsed) return getUniswapPbaiQuoteComposed(key, units);
    return { inputUsdc: Math.round(units), ...parsed };
  } catch { return null; }
}

// Raw quote POST, shared by the composed fallback below. Returns the
// parsed JSON on HTTP 2xx, null otherwise. Never throws. `swapper` is
// the simulated recipient: default is the zero address (V1 choice — PB
// holds no user wallet for a display quote); callers pass a non-zero
// address only where the zero recipient breaks the simulation (leg 2).
async function requestUniswapQuoteRaw(tokenIn, tokenOut, amountStr, key, swapper = UNI_ZERO_SWAPPER) {
  try {
    const res = await uniFetch(`${UNI_TRADE_API}/quote`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        type: 'EXACT_INPUT',
        amount: amountStr,
        tokenInChainId: UNI_BASE_CHAIN_ID,
        tokenOutChainId: UNI_BASE_CHAIN_ID,
        tokenIn,
        tokenOut,
        swapper,
        autoSlippage: 'DEFAULT',
        protocols: ['V3'],
      }),
    });
    if (!res || !res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

// Two-leg composed quote (2026-11-06, wave 4): the router no longer
// chains USDC→WETH→PBAI in ONE request — live probes return 404
// NoRouteFoundError at $1/$10/$100, with and without the protocols
// restriction, while each leg routes CLASSIC alone (USDC→WETH 200,
// WETH→PBAI 200, and the exact leg-1 output amount routes leg 2). So
// when the direct quote fails, compose: leg 1 USDC→WETH, leg 2 WETH→
// PBAI with leg 1's exact output as input. Leg 2 simulates with the
// pool address as recipient (UNI_PBAI_POOL): the zero address makes
// PBAI's transfer simulation revert (SIMULATION_ERROR) — see the
// constant's comment. Both legs pass the same strict guards (CLASSIC, expected output token, positive integer
// amounts, no echo, no failed simulation); anything else → null. The
// figure is an ESTIMATE (two quotes at one instant, not one atomic
// route) — the buy flow already labels it est. Live composed check
// 2026-11-06: 100 USDC → 0.0446 WETH → ~43,915,701 PBAI, in line with
// the 2026-10-28 direct quote (43,006,185). Human-paced only (buy tap),
// 2 extra calls max; the 6 req/s key limit is unreachable.
async function getUniswapPbaiQuoteComposed(key, usdcAmount) {
  try {
    const amountStr = (BigInt(Math.round(Number(usdcAmount))) * 1000000n).toString();
    const leg1Data = await requestUniswapQuoteRaw(UNI_USDC_BASE, UNI_WETH_BASE, amountStr, key);
    if (!leg1Data) return null;
    const leg1 = parseClassicQuote(leg1Data, amountStr, UNI_WETH_BASE);
    if (!leg1) return null;
    // Leg 2 needs the RAW base-unit string, never the formatted display
    // string — re-derive it from leg 1's response, validated again here.
    const leg1OutRaw = String(leg1Data?.quote?.output?.amount ?? '');
    if (!/^[0-9]+$/.test(leg1OutRaw) || BigInt(leg1OutRaw) <= 0n) return null;
    const leg2Data = await requestUniswapQuoteRaw(UNI_WETH_BASE, PROJECT_COIN_CA, leg1OutRaw, key, UNI_PBAI_POOL);
    if (!leg2Data) return null;
    const leg2 = parseClassicQuote(leg2Data, leg1OutRaw);
    if (!leg2) return null;
    const gas1 = leg1.gasFeeUsd === null ? null : Number(leg1.gasFeeUsd);
    const gas2 = leg2.gasFeeUsd === null ? null : Number(leg2.gasFeeUsd);
    let gasFeeUsd = null;
    if (Number.isFinite(gas1) && Number.isFinite(gas2)) gasFeeUsd = (gas1 + gas2).toFixed(2);
    else if (Number.isFinite(gas2)) gasFeeUsd = leg2.gasFeeUsd;
    // Live leg gas is ~$0.002–$0.003, which rounds to $0.00 at 2
    // decimals — a sub-cent gas figure carries no information, so omit
    // it (the buy flow omits the gas suffix when null) rather than
    // showing "est. gas ~$0.00".
    if (gasFeeUsd !== null && Number(gasFeeUsd) < 0.01) gasFeeUsd = null;
    return { inputUsdc: Math.round(Number(usdcAmount)), outputPbai: leg2.outputPbai, outputMinPbai: leg2.outputMinPbai, gasFeeUsd, routing: 'CLASSIC' };
  } catch { return null; }
}

// Normalize a V3 fee value to a percent. V3 fees are uint24 in hundredths
// of a bip (100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%). Only
// integer values in the V3 range are accepted; any other shape (decimal,
// string-with-units) is NOT rendered — a guessed unit is a wrong number.
function parsePoolFee(raw) {
  const n = typeof raw === 'string' && /^[0-9]+$/.test(raw)
    ? Number(raw)
    : (typeof raw === 'number' ? raw : NaN);
  if (!Number.isInteger(n) || n < 100 || n > 1000000) return null;
  return n / 10000;
}

// Proven 2026-10-29 (probe note PB-UNISWAP-V2-PROBE-2026-10-29.md): the
// PBAI/WETH V3 Base pool lives at fee 10000 (1%); other standard fees
// return pools: []. Never send another fee without a live probe first.
const UNI_PBAI_POOL_FEE = 10000;
// The PBAI/WETH V3 pool address (live-proven 2026-10-29, re-proven
// 2026-11-06/07). It is used ONLY as the simulated recipient (swapper)
// for the leg-2 display quote below — never a real recipient, no funds
// ever move (quote API only, read-only). Why not the zero address:
// the quote simulates delivering PBAI to the recipient, and PBAI
// reverts transfers to address(0), so leg 2 deterministically returns
// txFailureReasons ['SIMULATION_ERROR'] under the zero swapper
// (reviewer probe, 2026-11-07); with the pool address as swapper the
// same leg returns txFailureReasons [] with the SAME output amount.
// Leg 1 (USDC→WETH) keeps the zero swapper: WETH delivery to the zero
// address simulates fine (txFailureReasons [] every probe).
const UNI_PBAI_POOL = '0x561330e99a7fd2710d8d32960e22d5f8f6fe2f94';

// Pool state for $PBAI's Uniswap V3 Base pool (PBAI/WETH, token0 sorts
// first by address: PBAI 0x023f… < WETH 0x4200…). V-2 shape PROVEN live
// 2026-10-29: pool_info takes poolParameters { tokenAddressA,
// tokenAddressB, fee } and returns { pools: [...] } with
// poolReferenceIdentifier / fee / currentTick / poolLiquidity. Old parse
// fallbacks are KEPT (bare object, array, data wrapper, feeTier, tick,
// liquidity, poolAddress) — the parser only gains new branches. Returns
// null unless the fee tier parsed — the card line needs it — and null
// on any failure.
export async function getUniswapPbaiPoolState() {
  try {
    const key = await uniswapApiKey();
    if (!key) return null;
    const res = await uniFetch(`${UNI_LIQUIDITY_API}/lp/pool_info`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        protocol: 'V3',
        chainId: UNI_BASE_CHAIN_ID,
        poolParameters: {
          tokenAddressA: PROJECT_COIN_CA,
          tokenAddressB: UNI_WETH_BASE,
          fee: UNI_PBAI_POOL_FEE,
        },
      }),
    });
    if (!res || !res.ok) return null;
    const body = await res.json().catch(() => null);
    let cand = null;
    if (body && typeof body === 'object' && Array.isArray(body.pools)) cand = body.pools[0];
    else if (Array.isArray(body)) cand = body[0];
    else if (body && typeof body === 'object') cand = Array.isArray(body.data) ? body.data[0] : (body.data ?? body);
    if (!cand || typeof cand !== 'object') return null;
    const feePct = parsePoolFee(cand.feeTier ?? cand.fee);
    if (feePct === null) return null;
    const out = { feePct };
    const tickRaw = cand.tick ?? cand.tickCurrent ?? cand.currentTick;
    if (Number.isInteger(tickRaw)) out.tick = tickRaw;
    const liqRaw = cand.liquidity ?? cand.poolLiquidity;
    if (typeof liqRaw === 'string' && /^[0-9]+$/.test(liqRaw)) out.liquidity = liqRaw;
    const poolRaw = cand.poolAddress ?? cand.address ?? cand.pool ?? cand.poolReferenceIdentifier;
    if (typeof poolRaw === 'string' && /^0x[0-9a-fA-F]{40}$/.test(poolRaw)) out.pool = poolRaw;
    return out;
  } catch { return null; }
}
