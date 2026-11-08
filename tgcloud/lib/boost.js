// Pup Booster — port of the original deposit-funded booster (design
// PB-BOOST-AIRDROP-DESIGN §2.1/§5). Catalog, quote contract, campaign state
// machine, deposit watcher, dry-run planner, DM wizard, owner admin.
//
// Source-true to: booster-catalog.ts, booster-contract.ts,
// booster-volume-tiers.ts (legacy tiers deprecated — not sold),
// booster-wallet-farm.ts (wallet model), booster-deposit-watcher.ts.
//
// PHASE 2 HARD RULE (updated, broadcaster wave 2026-10-25): no signing, no
// broadcasting exists in this module. Funded campaigns are PLANNED
// (deterministic dry-run intents) and parked at 'awaiting_arm' (unarmed)
// or 'planned' (armed). The broadcaster ORCHESTRATION (step derivation,
// digest + cap verification, shadow proof, claim assembly, outcome
// application) lives in this module below; SWAP + NATIVE-TRANSFER
// execution lives in the host signer worker, which today builds ERC-20 /
// SPL transfers only — so live submission is gated OFF until that
// executor build lands (see isBoostExecutorCapable). Nothing here signs
// or broadcasts by itself.

import { api, fetch } from 'sdk';
import db, { eq, and, desc, sql } from 'sdk/db';
import { boost_campaigns, bot_users, dex_boost_leads } from '../schema.js';
import { getConfig, setConfig, flagValueOn } from './config.js';
import { sha256Hex } from './mcpkeys.js';
import {
  isValidEvmAddress, isValidSolAddress, normalizeEvmAddress,
  generateEvmKeypair, generateSolKeypair, vaultEncrypt, vaultDecrypt,
  hexToBytes, evmAddressFromPrivkey, classifyPlaintext, evmCodeAt,
  nativeBalance, nativeUsdPrice, evmGasPriceWei, rpcUrl, tokenBalance, CHAINS,
  decCmp, decSub, decDivInt, decMulInt, decAdd, decSum, fmtDec, parseDec,
} from './walletvault.js';
import {
  isBoostEnabled, isBoostArmed, requireOwner,
  auditMoney, alertOwner, checkCaps, maxBoostCapitalUsd, setMoneyConfig,
  maxSendUsd, dailyCapUsd, plannedUsdToday, MASTER_WALLET_ADDRESS,
  isAirdropEnabled, isAirdropArmed, sendSalesReceipt,
} from './moneyguard.js';
import {
  listCalendar, bookCalendarSlot, cancelCalendarSlot, getCalendarBooking,
  calendarSlotLabel, calendarOrderRank, CALENDAR_PRODUCT_LABEL,
} from './tiers.js';


// ── Catalog (verbatim from booster-catalog.ts / booster-contract.ts) ───────

export const BOOST_TYPES = ['volume', 'bump', 'mcap'];
export const BOOSTER_CHAINS = ['base', 'sol', 'rh'];
export const BOOST_TYPE_CATALOG = {
  volume: { label: 'Volume Boost', shortLabel: 'Volume', icon: '📈', description: 'Balanced buy and sell cycles designed to generate on-chain transaction volume.', supportedChains: ['base', 'sol', 'rh'] },
  bump: { label: 'Bump Boost', shortLabel: 'Bump', icon: '⚡', description: 'Base-only high-frequency execution with more wallets and shorter intervals.', supportedChains: ['base'] },
  mcap: { label: 'MCap Boost', shortLabel: 'MCap', icon: '🚀', description: 'Base-only buy-weighted execution using two buys for each sell cycle.', supportedChains: ['base'] },
};
export const BUMP_PACKAGES = {
  pulse: { label: 'Pulse', platformFeeUsd: 29, durationHours: 1 },
  push: { label: 'Push', platformFeeUsd: 79, durationHours: 6 },
  hold: { label: 'Hold', platformFeeUsd: 149, durationHours: 24 },
};
export const BOOSTER_QUOTE_TTL_MS = 15 * 60_000;
export const BOOSTER_GAS_DRIFT_LIMIT = 0.20;
// NO-GO fix 3 (2026-10-26): Bump buys only, never sells — the retention
// disclosure carried on all four member surfaces (quote assumptions,
// detail page, quote panel, package picker). Wording states only what
// the engine guarantees: no sell leg exists for bump (planParameters:
// sellsPerCycle 0), so bought tokens are not sold back by the campaign.
export const BUMP_RETENTION_DISCLOSURE =
  'Bump buys only — it never sells, so tokens bought during the run are not sold back by the campaign.';
// NO-GO fix 4 (2026-10-26): a deposit address accepted from a quote stays
// fundable for 24h past acceptance, even though the quote itself lives
// 15 minutes. Hygiene expiry for deposit_pending keys off this window.
export const BOOST_DEPOSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
// NO-GO fix 5 (2026-10-26): refund-guard warning texts (panel + detail).
export const BOOST_REFUND_MASTER_TEXT =
  '⚠️ Refund address is the operator master wallet — refunds would go to the operator, not you. Use your own wallet address.';
export const BOOST_REFUND_CONTRACT_TEXT =
  '⚠️ Refund address is a contract — some contracts cannot receive native transfers, so a refund there may fail. Prefer a wallet you control directly.';
export const BOOST_REFUND_CODE_UNKNOWN_TEXT =
  '⚠️ Refund-address contract check was unavailable — the address could not be verified as a plain wallet. Proceed only if you control it.';

export const isBoostType = (v) => BOOST_TYPES.includes(v);
export const isBoosterChain = (v) => BOOSTER_CHAINS.includes(v);
export const isSupportedBoostCombination = (t, c) =>
  isBoostType(t) && isBoosterChain(c) && BOOST_TYPE_CATALOG[t].supportedChains.includes(c);

/** Verbatim from booster-contract.ts (NOTE: its alias map differs from
 *  lib/tiers.js canonicalTier — for booster pricing the contract's own
 *  normalization is the source of truth). */
export function normalizeBoosterTier(tier) {
  const value = (tier ?? 'free').toLowerCase();
  if (value === 'agency' || value === 'chad' || value === 'whale' || value === 'dev_launch') return 'agency';
  if (value === 'pro' || value === 'grinder') return 'pro';
  if (value === 'builder' || value === 'hustler') return 'builder';
  if (value === 'starter') return 'starter';
  return 'free';
}
export const boosterDiscountRate = (tier) => {
  // TRIALPOLICY 2026-11-01 (#10): 'one' ($29 PB Plan) is a paid tier
  // and earns a paid discount — the floor of the legacy paid rates
  // (10%), not a guessed middle, since the exact legacy mapping is
  // unverified. normalizeBoosterTier is the verbatim booster-contract
  // normalization and knows no 'one' (it would map it to 'free'), so
  // 'one' is checked on the raw tier here; the contract map itself is
  // untouched. Queue priority is NOT changed by this decision (left
  // for a separate call — see wave report).
  if (String(tier ?? '').toLowerCase() === 'one') return 0.10;
  return ({ free: 0, starter: 0, builder: 0.10, pro: 0.15, agency: 0.20 })[normalizeBoosterTier(tier)];
};
export const boosterQueuePriority = (tier) => {
  // Queue wave 2026-11-02 (audit item 6): 'one' ($29 PB Plan) queues at
  // builder level 30 — the same floor-of-legacy-paid precedent as the
  // 10% discount special case above (TRIALPOLICY #10), not a guessed
  // middle. normalizeBoosterTier knows no 'one' (maps it to 'free' =
  // 40), so the paid plan queued at free-tier priority until this line.
  if (String(tier ?? '').toLowerCase() === 'one') return 30;
  return ({ agency: 10, pro: 20, builder: 30, starter: 40, free: 40 })[normalizeBoosterTier(tier)];
};

export function undiscountedPlatformFee(input) {
  if (input.mode === 'volume') return Math.max(19, input.workingCapitalUsd * 0.10);
  if (input.mode === 'mcap') return Math.max(39, input.workingCapitalUsd * 0.15);
  const pack = input.bumpPackage && BUMP_PACKAGES[input.bumpPackage];
  if (!pack) throw new Error('Bump requires bumpPackage: pulse, push, or hold');
  return pack.platformFeeUsd;
}

const roundUsd = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const roundNative = (n) => Math.ceil(n * 1e9) / 1e9;

export function validateContractInput(input) {
  if (!['volume', 'bump', 'mcap'].includes(input.mode)) return 'mode must be volume, bump, or mcap';
  if (!['base', 'sol', 'rh'].includes(input.chain)) return "chain must be 'base', 'sol', or 'rh'";
  if ((input.mode === 'bump' || input.mode === 'mcap') && input.chain !== 'base') {
    return `${input.mode === 'bump' ? 'Bump' : 'MCap'} is available on Base only`;
  }
  if (!Number.isFinite(input.workingCapitalUsd) || input.workingCapitalUsd <= 0) {
    return 'workingCapitalUsd must be greater than zero';
  }
  if (input.mode === 'bump' && (!input.bumpPackage || !(input.bumpPackage in BUMP_PACKAGES))) {
    return 'Bump requires bumpPackage: pulse, push, or hold';
  }
  if (input.mode === 'mcap') {
    if (!Number.isFinite(input.targetMcapMinUsd) || !Number.isFinite(input.targetMcapMaxUsd)
      || input.targetMcapMinUsd <= 0 || input.targetMcapMaxUsd <= input.targetMcapMinUsd) {
      return 'MCap requires a valid targetMcapMinUsd and targetMcapMaxUsd band';
    }
  }
  if (input.chain === 'sol' ? !isValidSolAddress(input.tokenCA ?? '') : !isValidEvmAddress(input.tokenCA ?? '')) {
    return 'tokenCA is not a valid address for the chain';
  }
  if (input.chain === 'sol' ? !isValidSolAddress(input.refundAddress ?? '') : !isValidEvmAddress(input.refundAddress ?? '')) {
    return 'refundAddress is not a valid address for the chain';
  }
  return null;
}

/**
 * Verbatim quote construction from booster-contract.ts buildBoosterQuote.
 * deps: { now, estimateNativeUsd, estimateNetworkReserveUsd, preflight }.
 */
export async function buildBoosterQuote(accountId, accountTier, input, deps) {
  const invalid = validateContractInput(input);
  if (invalid) throw new Error(invalid);
  const preflight = await deps.preflight(input);
  if (!preflight.ok) throw new Error(preflight.reason || 'Preflight failed closed');
  if (input.mode === 'mcap') {
    const maxBounded = preflight.boundedSwapUsd ?? 0;
    if (!Number.isFinite(preflight.liquidityUsd) || maxBounded < input.workingCapitalUsd) {
      throw new Error(preflight.reason || 'Insufficient pool liquidity for this MCap budget');
    }
  }
  const [nativeUsd, networkReserveUsdRaw] = await Promise.all([
    deps.estimateNativeUsd(input),
    deps.estimateNetworkReserveUsd(input),
  ]);
  if (!Number.isFinite(nativeUsd) || nativeUsd <= 0) throw new Error('Native asset price estimate unavailable');
  if (!Number.isFinite(networkReserveUsdRaw) || networkReserveUsdRaw < 0) throw new Error('Network estimate unavailable');

  const undiscounted = roundUsd(undiscountedPlatformFee(input));
  const discountRate = boosterDiscountRate(accountTier);
  const discountUsd = roundUsd(undiscounted * discountRate);
  const platformFeeUsd = roundUsd(undiscounted - discountUsd);
  const networkReserveUsd = roundUsd(networkReserveUsdRaw);
  const workingCapitalUsd = roundUsd(input.workingCapitalUsd);
  const totalDueUsd = roundUsd(workingCapitalUsd + platformFeeUsd + networkReserveUsd);
  const now = deps.now?.() ?? Date.now();
  const assumptions = [
    'Execution is budget-based and does not guarantee volume, market cap, price, duration, or return.',
    'Unused working capital and unused network reserve are swept after execution, less objectively incurred network costs.',
    'A quote must be refreshed when the network estimate moves by more than 20%.',
    // NO-GO fix 3: Bump retention disclosure, quote-assumptions surface.
    ...(input.mode === 'bump' ? [BUMP_RETENTION_DISCLOSURE] : []),
    ...(input.mode === 'mcap' ? ['The target market-cap band is an execution target, not a guaranteed outcome.'] : []),
    // NO-GO fix 5: master-refund warning is computable synchronously
    // (no RPC), so it rides the signed assumptions too. The contract
    // warning needs a chain read and lives on the quote panel instead.
    ...(input.chain !== 'sol' && normalizeEvmAddress(input.refundAddress ?? '')
      && normalizeEvmAddress(input.refundAddress) === MASTER_WALLET_ADDRESS
      ? [BOOST_REFUND_MASTER_TEXT] : []),
    ...(preflight.assumptions ?? []),
  ];
  return {
    version: 1,
    accountId: String(accountId),
    input,
    accountTier: normalizeBoosterTier(accountTier),
    discountRate,
    undiscountedPlatformFeeUsd: undiscounted,
    discountUsd,
    platformFeeUsd,
    networkReserveUsd,
    workingCapitalUsd,
    totalDueUsd,
    nativeUsd,
    totalDueNative: roundNative(totalDueUsd / nativeUsd),
    platformFeeNative: roundNative(platformFeeUsd / nativeUsd),
    networkReserveNative: roundNative(networkReserveUsd / nativeUsd),
    workingCapitalNative: roundNative(workingCapitalUsd / nativeUsd),
    queuePriority: boosterQueuePriority(accountTier),
    feeTier: preflight.feeTier ?? 3000,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + BOOSTER_QUOTE_TTL_MS).toISOString(),
    assumptions,
  };
}

export const gasEstimateDrift = (quotedUsd, currentUsd) =>
  quotedUsd === 0 ? (currentUsd === 0 ? 0 : Infinity) : Math.abs(currentUsd - quotedUsd) / quotedUsd;

// ── Quote signing (HMAC-SHA256, original token format: payload.signature) ──

// Pure-JS base64 (the tgcloud isolate has NO btoa/atob globals —
// createBoostCampaign threw `btoa is not defined` live 2026-10-28,
// so no booster campaign could ever be created via this path; the
// repurpose/digest waves already recorded the same lesson). Output is
// byte-identical to standard base64; b64url variants only change the
// alphabet + padding, exactly as the btoa/atob versions did.
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = Object.fromEntries([...B64_ALPHABET].map((c, i) => [c, i]));
const bytesToB64 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
};
const b64ToBytes = (b64) => {
  const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  const pad = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
  const len = Math.floor((clean.length * 3) / 4) - pad;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_REV[clean[i]] ?? 0;
    const b = B64_REV[clean[i + 1]] ?? 0;
    const c = clean[i + 2] === '=' ? 0 : (B64_REV[clean[i + 2]] ?? 0);
    const d = clean[i + 3] === '=' ? 0 : (B64_REV[clean[i + 3]] ?? 0);
    if (o < len) out[o++] = ((a << 2) | (b >> 4)) & 0xff;
    if (o < len) out[o++] = (((b & 15) << 4) | (c >> 2)) & 0xff;
    if (o < len) out[o++] = (((c & 3) << 6) | d) & 0xff;
  }
  return out;
};
const b64urlEncode = (bytes) =>
  bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return b64ToBytes(b64);
};
// Exported for the harness only (mirrors digest.js __leadsTest).
export const __boostB64Test = { bytesToB64, b64ToBytes, b64urlEncode, b64urlDecode };

async function hmacRaw(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

async function boostQuoteSecret() {
  const s = (await getConfig('BOOSTER_QUOTE_SECRET', null)) ?? (await getConfig('SESSION_SECRET', null));
  if (!s || String(s).length < 16) throw new Error('Booster quote signing is not configured');
  return String(s);
}

export async function signBoosterQuote(quote) {
  const secret = await boostQuoteSecret();
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(quote)));
  const signature = b64urlEncode(await hmacRaw(secret, payload));
  return `${payload}.${signature}`;
}

export async function verifyBoosterQuote(token, accountId, options = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Malformed quote');
  const [payload, supplied] = parts;
  const secret = await boostQuoteSecret();
  const expected = await hmacRaw(secret, payload);
  const actual = b64urlDecode(supplied);
  if (actual.length !== expected.length) throw new Error('Quote signature is invalid');
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual[i] ^ expected[i];
  if (diff !== 0) throw new Error('Quote signature is invalid');
  let quote;
  try { quote = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); }
  catch { throw new Error('Quote payload is invalid'); }
  if (quote.version !== 1 || quote.accountId !== String(accountId)) throw new Error('Quote does not belong to this account');
  if ((options.now ?? Date.now()) >= new Date(quote.expiresAt).getTime()) throw new Error('Quote has expired');
  if (validateContractInput(quote.input)) throw new Error('Quote input is invalid');
  return quote;
}

/** The signed quote TOKEN is stored verbatim on the campaign row (quoteSig
 *  column) — acceptance verifies the stored token itself, so no quote field
 *  is ever reconstructed for verification. Display reads use the columns. */

// ── Planning parameters (deterministic planner model, design §5.3) ───────
// The original runner split working capital evenly across wallets × cycles.
// Wallet/cycle sizing: volume scales with capital (10–200 wallets, 15
// cycles); bump uses the original MCap-band wallet counts, one buy each;
// mcap mirrors volume sizing with 10 cycles at 2 buys : 1 sell.

export function planParameters(input) {
  const capital = Number(input.workingCapitalUsd);
  if (input.mode === 'bump') {
    const wallets = capital <= 25_000 ? 75 : capital <= 75_000 ? 100 : capital <= 150_000 ? 150 : 200;
    return { wallets, cycles: 1, buysPerCycle: 1, sellsPerCycle: 0, delaySecs: 5 };
  }
  const wallets = Math.max(10, Math.min(200, Math.round(capital / 25)));
  if (input.mode === 'mcap') return { wallets, cycles: 10, buysPerCycle: 2, sellsPerCycle: 1, delaySecs: 15 };
  return { wallets, cycles: 15, buysPerCycle: 1, sellsPerCycle: 1, delaySecs: 15 };
}

// ── Preflight + reserve estimation (default live deps) ─────────────────────
// Fail-closed throughout (original rule). Base preflight reads the token's
// largest DexScreener pair by USD liquidity; the fee tier defaults to 3000
// (the original contract's own fallback) since DexScreener doesn't publish
// the Uniswap fee tier.

// ── Preflight fallback (2026-10-25, Rowdy-approved) ────────────────────────
// REVERSE-THINKING PASS (proven by harness-boost-preflight-fallback.mjs):
// 1. WRONG POOL — GT returns a pool that does not contain the token. GUARD:
//    the pool's own on-chain token0/token1 must include the campaign token
//    (case-insensitive), else fail closed. Proven by harness case (g).
// 2. STALE PRICE — GT prices can lag. GUARD: balances are live ('latest'
//    block); the reserve is only a feasibility estimate bounded by 0.2x, and
//    the executor re-prices at execution with min-out from live prices.
//    Residual accepted and documented, not hidden.
// 3. MANIPULATED / FLASH RESERVE — balances at one block can spike. GUARD:
//    same 0.2x bound + execution-time repricing; preflight is a feasibility
//    gate, never a settlement promise.
// 4. SILENT FALLBACK ON ERROR — an error is unknown, not empty. GUARD: the
//    fallback runs ONLY when DexScreener answers OK with zero pairs for the
//    chain. Any DexScreener fetch/parse/!ok failure fails closed BEFORE the
//    fallback; any GT or on-chain failure fails closed. Proven by (f).
// 5. DEXSCREENER REGRESSION — GUARD: the DexScreener branch below is
//    unchanged (same fields, same math, same feeTier 3000); harness (a)
//    proves identical behavior for a listed token.
// 6. HARDCODED TOKEN — GUARD: no token or pair constant appears in this
//    code; the pool comes from GT per-token and is verified on-chain.
//    $PBAI is only a harness proof case.
// 7. FEE TIER — GT publishes no fee tier, so the fallback keeps the same
//    3000 default the DexScreener path already uses (not a new assumption).
// 8. NON-BASE CHAINS — GUARD: the fallback is Base-only; sol/rh with an
//    empty DexScreener result still fail closed, exactly as before.

const GT_BASE_URL = 'https://api.geckoterminal.com/api/v2/networks/base';
const POOL_TOKEN0_SELECTOR = '0x0dfe1681';
const POOL_TOKEN1_SELECTOR = '0xd21220a7';

/** Raw eth_call via the bot's existing in-isolate Base RPC URL resolution
 *  (config BASE_RPC_URL, same path watcher/balance reads use). No new RPC
 *  URL is hardcoded anywhere. deps.ethCallFn overrides it in harness. */
async function baseEthCall(to, data, deps) {
  if (deps.ethCallFn) return deps.ethCallFn(to, data);
  const url = await rpcUrl('base');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`pool read HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`pool read: ${body.error.message ?? 'error'}`);
  return String(body.result ?? '');
}

function evmAddressFromWord(word) {
  const hex = String(word ?? '').replace(/^0x/, '').padStart(64, '0');
  return `0x${hex.slice(24)}`;
}

/** GeckoTerminal + on-chain fallback for Base tokens DexScreener does not
 *  index. Every unknown state fails closed with the same reason as today. */
async function geckoTerminalFallbackPreflight(input, deps) {
  // Static fetch: dynamic import('sdk') throws 'Not supported' in the
  // tgcloud isolate (proven 2026-10-26 by in-isolate diag run), which
  // failed this preflight closed for every token. The static import at
  // the top of this file is what the rest of the tree uses.
  const fetchFn = deps.fetchFn ?? fetch;
  const tokenBalanceFn = deps.tokenBalance ?? tokenBalance;
  const gtRes = await fetchFn(`${GT_BASE_URL}/tokens/${input.tokenCA}`);
  if (!gtRes.ok) return { ok: false, reason: 'Preflight failed closed' };
  const gt = await gtRes.json();
  const priceUsd = Number(gt?.data?.attributes?.price_usd);
  const topPools = gt?.data?.relationships?.top_pools?.data ?? [];
  if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !topPools.length) {
    return { ok: false, reason: 'Preflight failed closed' };
  }
  const pool = String(topPools[0].id ?? '').replace(/^base_/, '');
  if (!isValidEvmAddress(pool)) return { ok: false, reason: 'Preflight failed closed' };
  const t0 = evmAddressFromWord(await baseEthCall(pool, POOL_TOKEN0_SELECTOR, deps));
  const t1 = evmAddressFromWord(await baseEthCall(pool, POOL_TOKEN1_SELECTOR, deps));
  if (!isValidEvmAddress(t0) || !isValidEvmAddress(t1)) {
    return { ok: false, reason: 'Preflight failed closed' };
  }
  const want = String(input.tokenCA).toLowerCase();
  if (t0.toLowerCase() !== want && t1.toLowerCase() !== want) {
    return { ok: false, reason: 'Preflight failed closed' };
  }
  const other = t0.toLowerCase() === want ? t1 : t0;
  const otherRes = await fetchFn(`${GT_BASE_URL}/tokens/${other}`);
  if (!otherRes.ok) return { ok: false, reason: 'Preflight failed closed' };
  const otherPrice = Number((await otherRes.json())?.data?.attributes?.price_usd);
  if (!Number.isFinite(otherPrice) || otherPrice <= 0) {
    return { ok: false, reason: 'Preflight failed closed' };
  }
  const priceBySide = t0.toLowerCase() === want
    ? { t0: priceUsd, t1: otherPrice }
    : { t0: otherPrice, t1: priceUsd };
  const bal0 = Number(await tokenBalanceFn('base', t0, pool));
  const bal1 = Number(await tokenBalanceFn('base', t1, pool));
  if (!Number.isFinite(bal0) || !Number.isFinite(bal1) || bal0 < 0 || bal1 < 0) {
    return { ok: false, reason: 'Preflight failed closed' };
  }
  const reserveUsd = bal0 * priceBySide.t0 + bal1 * priceBySide.t1;
  if (!Number.isFinite(reserveUsd) || reserveUsd <= 0) {
    return { ok: false, reason: 'Preflight failed closed' };
  }
  return {
    ok: true,
    feeTier: 3000,
    liquidityUsd: reserveUsd,
    boundedSwapUsd: Math.min(Number(input.workingCapitalUsd), reserveUsd * 0.2),
    assumptions: [`Liquidity reference: ${pool} on-chain balances ≈ $${Math.round(reserveUsd)} (GeckoTerminal prices + Base on-chain balances).`],
  };
}

export async function defaultPreflight(input, deps = {}) {
  // Same static-fetch rule as the fallback above: dynamic import('sdk')
  // is unsupported in the isolate and failed every preflight closed.
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${input.tokenCA}`);
    if (!res.ok) return { ok: false, reason: 'Preflight failed closed' };
    const data = await res.json();
    const chainId = input.chain === 'sol' ? 'solana' : input.chain === 'rh' ? 'robinhood' : 'base';
    const pairs = (data?.pairs ?? []).filter((p) => p.chainId === chainId || (input.chain === 'rh' && p.chainId === 'robinhood'));
    if (pairs.length) {
      const top = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const liquidityUsd = Number(top?.liquidity?.usd ?? 0);
      if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return { ok: false, reason: 'Preflight failed closed' };
      return {
        ok: true,
        feeTier: 3000,
        liquidityUsd,
        boundedSwapUsd: Math.min(Number(input.workingCapitalUsd), liquidityUsd * 0.2),
        assumptions: [`Liquidity reference: largest ${CHAINS[input.chain].label} pool ≈ $${Math.round(liquidityUsd)} (DexScreener).`],
      };
    }
    // Empty DexScreener answer (not an error): Base-only fallback.
    // NOTE: `await` is load-bearing here — a bare `return` of the fallback
    // promise would let its rejection bypass this try/catch (harness (d)).
    if (input.chain !== 'base') return { ok: false, reason: 'Preflight failed closed' };
    return await geckoTerminalFallbackPreflight(input, deps);
  } catch {
    return { ok: false, reason: 'Preflight failed closed' };
  }
}

/** Network reserve estimator. RH = the original's flat $2.50. Base = live
 *  gas × planned transfers × 1.2 buffer. Solana = per-wallet ATA rent
 *  (~0.002 SOL, the original figure) + signature fees, at the live price. */
export async function defaultEstimateReserve(input, deps = {}) {
  if (input.chain === 'rh') return 2.50;
  const params = planParameters(input);
  const nativeUsd = await (deps.estimateNativeUsd ?? nativeUsdPrice)(input.chain === 'sol' ? 'sol' : input.chain === 'rh' ? 'rh' : 'base');
  if (input.chain === 'sol') {
    const ataSol = params.wallets * 0.002;
    const feeSol = params.wallets * params.cycles * 0.000015;
    return Math.max(1, (ataSol + feeSol) * nativeUsd * 1.2);
  }
  const gasPrice = await (deps.gasPriceWei ?? evmGasPriceWei)('base');
  const swapGas = 150_000n, fundGas = 21_000n;
  const transfers = BigInt(params.wallets) * (1n + BigInt(params.cycles) * BigInt(params.buysPerCycle + params.sellsPerCycle));
  const totalGas = transfers * swapGas + BigInt(params.wallets) * fundGas;
  const ethCost = Number(totalGas * gasPrice) / 1e18;
  return Math.max(1, ethCost * nativeUsd * 1.2);
}

export const defaultQuoteDeps = {
  estimateNativeUsd: (input) => nativeUsdPrice(input.chain),
  estimateNetworkReserveUsd: (input) => defaultEstimateReserve(input),
  preflight: (input) => defaultPreflight(input),
};

// ── Campaign CRUD + state machine ───────────────────────────────────────────

const newCampaignId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return 'bc_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// TRIAL FIX WAVE 2026-11-01, bug 11: tier read fails CLOSED.
// On a DB error the old code returned 'free', which silently passed
// every trial check below. It now returns the BOOST_TIER_UNKNOWN
// sentinel, and every trial check treats that sentinel as held/refused
// (never as a pass). 'free' is still returned only when the DB read
// succeeds and the row has no tier — a missing tier is not an error.
export const BOOST_TIER_UNKNOWN = 'unknown';
export function isBoostTierHeld(tier) {
  const t = String(tier ?? '').toLowerCase().trim();
  return t === 'trial' || t === BOOST_TIER_UNKNOWN;
}

export async function getUserTier(tgId) {
  try {
    const u = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(tgId))).get();
    return u?.tier ?? 'free';
  } catch { return BOOST_TIER_UNKNOWN; }
}

/**
 * NO-GO fix 5 (2026-10-26): refund-address guard, computed at quote time.
 * Returns warnings (possibly empty). Severities:
 * - 'block': refund to the operator master wallet. The quote is still
 *   created (a quote moves no funds), but the panel suppresses Accept
 *   and acceptBoostQuote refuses — so no campaign with a master refund
 *   can ever reach deposit_pending.
 * - 'warn': refund to a contract (eth_getCode non-empty), or the code
 *   check itself failed (unknown state, disclosed rather than hidden).
 * Solana has no EVM code read and is skipped; Base + Robinhood Chain
 * are EVM reads. deps.evmCodeAt overrides the live read in harness.
 * Never throws for a code-read failure — that path yields a warning.
 */
export async function computeBoostRefundWarnings(input, deps = {}) {
  const warnings = [];
  const refund = input.chain === 'sol' ? String(input.refundAddress ?? '')
    : normalizeEvmAddress(input.refundAddress ?? '');
  if (input.chain !== 'sol' && refund && refund === MASTER_WALLET_ADDRESS) {
    warnings.push({ code: 'refund_to_master', severity: 'block', text: BOOST_REFUND_MASTER_TEXT });
    return warnings; // master-block short-circuits: no code read needed
  }
  if (input.chain === 'sol' || !refund) return warnings;
  try {
    const codeAt = deps.evmCodeAt ?? evmCodeAt;
    const code = await codeAt(input.chain, refund);
    const c = String(code ?? '').toLowerCase();
    if (c !== '0x' && c !== '0x0' && c !== '') {
      warnings.push({ code: 'refund_is_contract', severity: 'warn', text: BOOST_REFUND_CONTRACT_TEXT });
    }
  } catch {
    warnings.push({ code: 'refund_code_unknown', severity: 'warn', text: BOOST_REFUND_CODE_UNKNOWN_TEXT });
  }
  return warnings;
}

/** Create a campaign in 'quoted' status with its signed quote persisted. */
export async function createBoostCampaign(tgId, input, deps = {}) {
  const tier = await getUserTier(tgId);
  // PRICING WAVE: booster sends are EXCLUDED from the 7-day trial
  // entirely — a trial user cannot quote, accept, or fund a campaign.
  // (Free users keep existing booster access: booster is deposit-funded
  // and was never subscription-gated. This exclusion is trial-only.)
  // TRIAL FIX WAVE 2026-11-01, bug 11: an unverifiable tier (DB error
  // sentinel) is refused exactly like trial — fail closed, no quote.
  if (isBoostTierHeld(tier)) {
    if (String(tier ?? '').toLowerCase().trim() === BOOST_TIER_UNKNOWN) {
      throw new Error('Booster tier could not be verified — try again in a moment; no campaign was created.');
    }
    throw new Error('Booster sends aren\'t part of the 7-day free trial — finish the trial or upgrade to the PB Plan ($29/mo), then come back with /boost.');
  }
  const mergedDeps = { ...defaultQuoteDeps, ...deps };
  const warnings = await computeBoostRefundWarnings(input, mergedDeps);
  const quote = await buildBoosterQuote(String(tgId), tier, input, mergedDeps);
  const token = await signBoosterQuote(quote);
  const id = newCampaignId();
  const now = Date.now();
  await db.insert(boost_campaigns).values({
    id,
    telegramUserId: String(tgId),
    mode: input.mode,
    chain: input.chain,
    tokenCa: input.chain === 'sol' ? input.tokenCA : normalizeEvmAddress(input.tokenCA),
    refundAddress: input.chain === 'sol' ? input.refundAddress : normalizeEvmAddress(input.refundAddress),
    status: 'quoted',
    platformFeeUsd: String(quote.platformFeeUsd),
    discountUsd: String(quote.discountUsd),
    discountRate: String(quote.discountRate),
    networkReserveUsd: String(quote.networkReserveUsd),
    workingCapitalUsd: String(quote.workingCapitalUsd),
    totalDueUsd: String(quote.totalDueUsd),
    nativeUsd: String(quote.nativeUsd),
    totalDueNative: String(quote.totalDueNative),
    platformFeeNative: String(quote.platformFeeNative),
    networkReserveNative: String(quote.networkReserveNative),
    workingCapitalNative: String(quote.workingCapitalNative),
    queuePriority: quote.queuePriority,
    feeTier: quote.feeTier,
    bumpPackage: input.bumpPackage ?? null,
    targetMcapMinUsd: input.targetMcapMinUsd ? String(input.targetMcapMinUsd) : null,
    targetMcapMaxUsd: input.targetMcapMaxUsd ? String(input.targetMcapMaxUsd) : null,
    quoteSig: token,
    quoteIssuedAt: now,
    quoteExpiresAt: now + BOOSTER_QUOTE_TTL_MS,
    walletCount: planParameters(input).wallets,
  }).run();
  await auditMoney('boost', tgId, 'quote_created', `campaign=${id} mode=${input.mode} chain=${input.chain} totalUsd=${quote.totalDueUsd}`);
  return { id, quote, token, warnings };
}

export async function getBoostCampaign(id) {
  try { return await db.select().from(boost_campaigns).where(eq(boost_campaigns.id, String(id))).get(); }
  catch { return null; }
}

export async function listOwnBoostCampaigns(tgId, limit = 10) {
  return db.select().from(boost_campaigns)
    .where(eq(boost_campaigns.telegramUserId, String(tgId)))
    .orderBy(desc(boost_campaigns.createdAt)).limit(limit).all().catch(() => []);
}

export async function listBoostCampaignsByStatus(status, limit = 25) {
  return db.select().from(boost_campaigns)
    .where(eq(boost_campaigns.status, status)).limit(limit).all().catch(() => []);
}

/** CAS transition: the UPDATE's WHERE clause enforces the prior status
 *  atomically; the re-read confirms the outcome (the SDK's run() result
 *  shape carries no reliable rows-affected count in this codebase). */
export async function transitionBoost(id, from, to, patch = {}) {
  await db.update(boost_campaigns)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(and(eq(boost_campaigns.id, String(id)), eq(boost_campaigns.status, from)))
    .run();
  const row = await getBoostCampaign(id);
  return !!row && row.status === to;
}

/**
 * Accept a quoted campaign: verify the stored signed quote (account-bound,
 * unexpired), generate the per-campaign deposit wallet, encrypt its key
 * into the vault format, and move to 'deposit_pending'. The plaintext key
 * exists only inside this call frame.
 */
export async function acceptBoostQuote(tgId, campaignId, deps = {}) {
  const row = await getBoostCampaign(campaignId);
  if (!row || row.telegramUserId !== String(tgId)) return { error: 'Campaign not found.' };
  if (row.status !== 'quoted') return { error: `Campaign is ${row.status.replace(/_/g, ' ')} — the quote can no longer be accepted.` };
  // PRICING WAVE: trial exclusion, defense in depth — a quote created
  // before a trial started (or via a skipped panel) can never be
  // accepted while the account is on trial.
  // TRIAL FIX WAVE 2026-11-01, bug 11: an unverifiable tier (DB error
  // sentinel) is refused exactly like trial — fail closed, no accept.
  {
    const acceptTier = await getUserTier(tgId);
    if (isBoostTierHeld(acceptTier)) {
      if (String(acceptTier ?? '').toLowerCase().trim() === BOOST_TIER_UNKNOWN) {
        return { error: 'Booster tier could not be verified — try again in a moment; the quote was not accepted.' };
      }
      return { error: 'Booster sends aren\'t part of the 7-day free trial — finish the trial or upgrade to the PB Plan ($29/mo), then come back with /boost.' };
    }
  }
  // NO-GO fix 5, defense in depth: the panel suppresses Accept on a
  // master refund, but accept must refuse on its own too — a caller
  // that skips the panel can never land a master-refund deposit wallet.
  // Checked before quote verification: the refusal needs no signature.
  if (row.chain !== 'sol' && normalizeEvmAddress(row.refundAddress ?? '')
    && normalizeEvmAddress(row.refundAddress) === MASTER_WALLET_ADDRESS) {
    return { error: 'Refund address must not be the operator master wallet — start again with /boost and use your own wallet address.' };
  }
  let quote;
  try {
    quote = await verifyBoosterQuote(row.quoteSig, tgId, { now: deps.now ?? Date.now() });
  } catch (err) {
    return { error: err?.message ?? 'Quote verification failed.' };
  }
  let keypair;
  if (row.chain === 'sol') {
    keypair = await (deps.generateSol ?? generateSolKeypair)();
    if (!keypair) {
      // §8.5 fallback (broadcaster wave): the isolate has no Ed25519, so
      // a Solana accept parks at 'deposit_generating' with NO address
      // instead of hard-erroring. The host signer worker generates the
      // keypair over the depgen bridge channel; when the ciphertext +
      // address land, applyBoostDepositGenResult moves the campaign to
      // 'deposit_pending'. The quote is consumed (quoteConsumedAt set) —
      // generation failure leaves the campaign parked, never half-made.
      const moved = await transitionBoost(row.id, 'quoted', 'deposit_generating', {
        quoteConsumedAt: Date.now(),
      });
      if (!moved) return { error: 'Campaign state changed — please reload.' };
      await auditMoney('boost', tgId, 'quote_accepted_generating', `campaign=${row.id} chain=sol`);
      return { generating: true, chain: row.chain };
    }
    keypair = { address: keypair.address, privateKey: keypair.privateKeyHex };
  } else {
    keypair = (deps.generateEvm ?? generateEvmKeypair)();
  }
  const encrypted = await (deps.encrypt ?? vaultEncrypt)(keypair.privateKey);
  const moved = await transitionBoost(row.id, 'quoted', 'deposit_pending', {
    depositAddress: keypair.address,
    encryptedDepositPk: encrypted,
    quoteConsumedAt: Date.now(),
  });
  if (!moved) return { error: 'Campaign state changed — please reload.' };
  await auditMoney('boost', tgId, 'quote_accepted', `campaign=${row.id} totalNative=${quote.totalDueNative}`);
  return {
    ok: true,
    depositAddress: keypair.address,
    totalDueNative: quote.totalDueNative,
    totalDueUsd: quote.totalDueUsd,
    chain: row.chain,
    expiresAt: row.quoteExpiresAt,
    // NO-GO fix 4: the deposit window runs 24h from acceptance, not
    // the 15-minute quote window — the DM copy and hygiene both key
    // off this, not quoteExpiresAt, once a wallet exists.
    depositWindowEndsAt: Date.now() + BOOST_DEPOSIT_WINDOW_MS,
  };
}

/** NO-GO fix 4 helper: the deposit wallet's live native balance, or
 *  null when the balance cannot be read. Callers treat null as
 *  fail-closed (never zero a key whose wallet state is unknown).
 *  deps.nativeBalance overrides the live read in harness. */
async function boostDepositBalanceOrNull(row, deps) {
  if (!row.depositAddress) return '0';
  try {
    const balanceOf = deps.nativeBalance ?? nativeBalance;
    return await balanceOf(row.chain, row.depositAddress);
  } catch { return null; }
}

/** Cancel a pre-funding campaign (owner of the campaign only). Funded
 *  campaigns never cancel here — they go through refund planning.
 *  'deposit_generating' cancels too: no wallet exists yet, so there is
 *  nothing to zero beyond the (null) key field.
 *  NO-GO fix 4: a deposit_pending wallet is NEVER zeroed blind. If its
 *  live balance is positive (a deposit landed, even partial), cancel
 *  refuses and the key stays — zeroing it would strand those funds
 *  with no key left to move them. If the balance cannot be read, cancel
 *  refuses too (fail-closed). Zero-balance wallets zero as before. */
/** Campaign states the pre-live cancel covers (mirrors the /booststop
 *  open-set): draft/quoted have no wallet, deposit_generating has no
 *  wallet yet, deposit_pending cancels only on a verified-zero balance
 *  (see cancelBoostCampaign — guards UNCHANGED by the 2026-10-26
 *  surfacing wave, which only adds buttons calling this function). */
export const BOOST_CANCELLABLE_STATUSES = ['draft', 'quoted', 'deposit_pending', 'deposit_generating'];

export async function cancelBoostCampaign(tgId, campaignId, deps = {}) {
  const row = await getBoostCampaign(campaignId);
  if (!row || row.telegramUserId !== String(tgId)) return { error: 'Campaign not found.' };
  if (!['draft', 'quoted', 'deposit_pending', 'deposit_generating'].includes(row.status)) {
    return { error: `A ${row.status.replace(/_/g, ' ')} campaign can't be cancelled here.` };
  }
  if (row.status === 'deposit_pending' && row.depositAddress) {
    const balance = await boostDepositBalanceOrNull(row, deps);
    if (balance === null) {
      return { error: 'Deposit balance could not be checked — cancellation refused rather than risk stranding funds. Try again shortly.' };
    }
    if (decCmp(balance, '0') > 0) {
      return { error: 'This deposit wallet already holds funds — cancelling would destroy the only key that can move them. The campaign stays open; funds are handled through the refund path, never by deleting the key.' };
    }
  }
  const moved = await transitionBoost(row.id, row.status, 'cancelled', {
    encryptedDepositPk: null, // hygiene: unfunded wallet material is zeroed
  });
  if (moved) await auditMoney('boost', tgId, 'campaign_cancelled', `campaign=${row.id}`);
  return { ok: moved };
}

// ── Deposit watcher (read-only) ─────────────────────────────────────────────
// Ports booster-deposit-watcher.ts's detection half: poll the deposit
// address's native balance; ≥99% of the quoted native total activates.
// The fee sweep that followed activation in the original is a BROADCAST —
// arm-phase. Here, activation only records the deposit and computes the
// settlement basis; planBoostCampaign does the rest.

export async function checkBoostDeposit(campaign, deps = {}) {
  if (campaign.status !== 'deposit_pending' || !campaign.depositAddress) return { skipped: 'not_pending' };
  // TRIAL FIX WAVE 2026-11-01, bug 9: trial hold, mirroring the
  // broadcast hold — a pre-trial deposit_pending campaign must NOT
  // flip to funded if the deposit lands mid-trial, or the "cannot
  // quote, accept, or fund" exclusion is contradicted. The row is
  // left untouched (still deposit_pending); when the trial ends the
  // owner is a free user again and the next tick flips it normally.
  // Bug 11: an unverifiable tier (DB error sentinel) is held too —
  // fail closed, never flipped on an unreadable tier. No send, no
  // audit, no owner alert from this path; the broadcast hold already
  // guards sends, and this hold guards the funding flip itself.
  {
    const depositTier = deps.getUserTier ? await deps.getUserTier(campaign.telegramUserId) : await getUserTier(campaign.telegramUserId);
    if (isBoostTierHeld(depositTier)) {
      return { held: true, reason: String(depositTier ?? '').toLowerCase().trim() === BOOST_TIER_UNKNOWN ? 'tier_unknown' : 'trial' };
    }
  }
  const balanceOf = deps.nativeBalance ?? nativeBalance;
  const balance = await balanceOf(campaign.chain, campaign.depositAddress);
  const expected = String(campaign.totalDueNative);
  const threshold = fmtDec(parseDec(expected) * 99n / 100n);
  if (decCmp(balance, threshold) < 0) return { pending: true, balance };
  const moved = await transitionBoost(campaign.id, 'deposit_pending', 'funded', {
    depositAmountText: balance,
    depositConfirmedAt: Date.now(),
  });
  if (!moved) return { skipped: 'lost_claim' };
  await auditMoney('boost', campaign.telegramUserId, 'deposit_confirmed',
    `campaign=${campaign.id} balance=${balance} expected=${expected}`);
  await alertOwner('boost', `💰 Boost deposit confirmed\nCampaign ${campaign.id} (${campaign.mode}/${campaign.chain})\nReceived ${balance} (expected ${expected}). Planning runs on the next tick; live execution opens on the owner live flag, so nothing broadcasts yet.`);
  // Sales leg: a funded deposit is a completed sale — receipt once, best-effort.
  await sendSalesReceipt('boost', campaign.id).catch(() => {});
  return { funded: true, balance };
}

export async function cycleBoostWatch(deps = {}) {
  if (!(await isBoostEnabled())) return { skipped: 'boost_disabled' };
  const rows = await listBoostCampaignsByStatus('deposit_pending', 25);
  let funded = 0, checked = 0;
  for (const row of rows) {
    checked++;
    try { const r = await checkBoostDeposit(row, deps); if (r.funded) funded++; }
    catch (err) { console.error('[boostWatch]', row.id, err?.message ?? err); }
  }
  return { checked, funded };
}

// ── Dry-run planner ─────────────────────────────────────────────────────────
// Computes the exact execution plan a broadcaster would run: fee sweep,
// wallet funding splits, per-wallet cycle counts, settlement refund basis.
// Persists the plan (planJson) and parks the campaign at 'awaiting_arm'.
// Caps are enforced here (design §6.4); an over-cap plan is recorded and
// alerted, never silently split.

export function buildBoostPlan(campaign, armed) {
  const input = {
    mode: campaign.mode, chain: campaign.chain,
    workingCapitalUsd: Number(campaign.workingCapitalUsd),
    bumpPackage: campaign.bumpPackage ?? undefined,
  };
  const params = planParameters(input);
  const perWalletCapital = decDivInt(String(campaign.workingCapitalNative), params.wallets);
  const wallets = Array.from({ length: params.wallets }, (_, i) => ({
    index: i,
    capitalNative: perWalletCapital,
    cycles: params.cycles,
    buysPerCycle: params.buysPerCycle,
    sellsPerCycle: params.sellsPerCycle,
  }));
  return {
    version: 1,
    mode: armed ? 'armed' : 'dry_run',
    campaignId: campaign.id,
    chain: campaign.chain,
    feeSweep: { to: 'master', amountNative: String(campaign.platformFeeNative) },
    walletFunding: { count: params.wallets, perWalletCapitalNative: perWalletCapital, gasReserveNative: String(campaign.networkReserveNative) },
    wallets,
    settlement: {
      refundAddress: campaign.refundAddress,
      basis: 'unused working capital + unused reserve, less actual network costs',
      quotedRefundNative: decSub(String(campaign.totalDueNative), String(campaign.platformFeeNative)),
    },
    delaySecs: params.delaySecs,
  };
}

export async function planBoostCampaign(campaign, deps = {}) {
  if (campaign.status !== 'funded') return { skipped: 'not_funded' };
  // TRIAL FIX WAVE 2026-11-01, bug 10 (low): trial hold — a funded
  // campaign must not plan to planned/awaiting_arm mid-trial. The row
  // is left untouched (still funded, counted as held); when the trial
  // ends the next tick plans it normally. Moves no funds, writes no
  // plan. Bug 11: an unverifiable tier (DB error sentinel) is held
  // too — fail closed, never planned on an unreadable tier.
  {
    const planTier = deps.getUserTier ? await deps.getUserTier(campaign.telegramUserId) : await getUserTier(campaign.telegramUserId);
    if (isBoostTierHeld(planTier)) {
      return { held: true, reason: String(planTier ?? '').toLowerCase().trim() === BOOST_TIER_UNKNOWN ? 'tier_unknown' : 'trial' };
    }
  }
  const armed = await isBoostArmed();
  const plan = buildBoostPlan(campaign, armed);
  plan.digest = await sha256Hex(JSON.stringify({ ...plan, digest: undefined }));
  const totalUsd = Number(campaign.totalDueUsd);
  const perSendUsd = Number(campaign.workingCapitalUsd) / Math.max(1, planParameters(campaign).wallets);
  const caps = await checkCaps({ perSendUsd, totalUsd, kind: 'boost' });
  let capital = null;
  if (caps.ok) {
    capital = await checkCapitalBoost(Number(campaign.workingCapitalUsd));
    if (!capital.ok) { caps.ok = false; caps.reason = capital.reason; }
  }
  const planJson = JSON.stringify({ ...plan, caps, capital });
  if (!caps.ok) {
    await db.update(boost_campaigns).set({ planJson, error: caps.reason, updatedAt: new Date() })
      .where(eq(boost_campaigns.id, campaign.id)).run();
    await alertOwner('boost', `⚠️ Boost plan over cap\nCampaign ${campaign.id}: ${caps.reason}\nPlan recorded; campaign stays funded, nothing sent.`);
    await auditMoney('boost', campaign.telegramUserId, 'plan_over_cap', `campaign=${campaign.id} reason=${caps.reason}`);
    return { overCap: caps.reason };
  }
  const moved = await transitionBoost(campaign.id, 'funded', armed ? 'planned' : 'awaiting_arm', { planJson });
  if (!moved) return { skipped: 'lost_claim' };
  await auditMoney('boost', campaign.telegramUserId, 'plan_created',
    `campaign=${campaign.id} usd=${totalUsd} mode=${armed ? 'armed' : 'dry_run'} digest=${plan.digest.slice(0, 12)}`);
  return { planned: true, armed };
}

export async function cycleBoostPlan(deps = {}) {
  if (!(await isBoostEnabled())) return { skipped: 'boost_disabled' };
  const rows = await listBoostCampaignsByStatus('funded', 10);
  let planned = 0;
  for (const row of rows) {
    try { const r = await planBoostCampaign(row, deps); if (r.planned) planned++; }
    catch (err) { console.error('[boostPlan]', row.id, err?.message ?? err); }
  }
  return { checked: rows.length, planned };
}

// ── Vault proof (NO-GO fix 1, 2026-10-26) ─────────────────────────────────
// What this proves, honestly labeled: the BOT's vault key is configured
// (64-hex shape, checked as a boolean only — the value is never logged,
// returned, or stored) and AES-256-GCM round-trips through it, AND a
// freshly generated EVM keypair survives encrypt → decrypt → address
// derivation unchanged. All plaintext here is ephemeral and unfunded:
// the proof string is random, the keypair is fresh and never funded, so
// the proof moves ZERO funds and risks no real key.
// What it does NOT prove: that the host signer worker's vault key
// EQUALS the bot's. That equality needs the worker's own vaultcheck
// over the site bridge (still pending a bridge deploy — see the flip
// prerequisites), so the stored result is scoped 'bot_vault_only' and
// workerEquality stays 'pending_bridge'. Never claim more than that.
// Runs at most once per 24h inside cycleBoostHygiene (an existing
// cycle — no tick.js edit), plus on demand via /boostvault (owner,
// DM-only). Stored result carries booleans + timestamps only: no key
// material, no plaintext, no ciphertext.

export const BOOST_VAULT_PROOF_KEY = 'boost_vault_proof';
export const BOOST_VAULT_PROOF_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function runBoostVaultProof(deps = {}) {
  const checks = { keyShape: false, roundTrip: false, evmDerive: false };
  try {
    const rawKey = await getConfig('BOOSTER_ENCRYPTION_KEY', null);
    checks.keyShape = !!rawKey && /^[0-9a-fA-F]{64}$/.test(String(rawKey).trim());
    if (!checks.keyShape) {
      const result = { ok: false, scope: 'bot_vault_only', workerEquality: 'pending_bridge', checks, checkedAt: Date.now() };
      await setConfig(BOOST_VAULT_PROOF_KEY, JSON.stringify(result)).catch(() => {});
      return result;
    }
    const encrypt = deps.encrypt ?? vaultEncrypt;
    const decrypt = deps.decrypt ?? vaultDecrypt;
    const proofText = `vault-proof-${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const blob = await encrypt(proofText);
    checks.roundTrip = (await decrypt(blob)) === proofText;
    const kp = (deps.generateEvm ?? generateEvmKeypair)();
    const enc = await encrypt(kp.privateKey);
    const dec = await decrypt(enc);
    const derived = evmAddressFromPrivkey(hexToBytes(String(dec).replace(/^0x/, '')));
    checks.evmDerive = derived.toLowerCase() === String(kp.address).toLowerCase()
      && classifyPlaintext(dec).kind === 'evm_pk_0x';
    const ok = checks.keyShape && checks.roundTrip && checks.evmDerive;
    const result = { ok, scope: 'bot_vault_only', workerEquality: 'pending_bridge', checks, checkedAt: Date.now() };
    await setConfig(BOOST_VAULT_PROOF_KEY, JSON.stringify(result)).catch(() => {});
    if (!ok) await auditMoney('boost', 'system', 'vault_proof_failed', 'checks=' + JSON.stringify(checks));
    return result;
  } catch (err) {
    const result = { ok: false, scope: 'bot_vault_only', workerEquality: 'pending_bridge', checks, checkedAt: Date.now(), error: String(err?.message ?? err).slice(0, 120) };
    await setConfig(BOOST_VAULT_PROOF_KEY, JSON.stringify(result)).catch(() => {});
    return result;
  }
}

/** Cadenced vault proof: reruns only when forced or when the last
 *  stored proof is older than 24h (or absent / failed). Never throws
 *  into the calling cycle — callers wrap it anyway. */
export async function cycleBoostVaultProof(deps = {}) {
  const now = deps.now ?? Date.now();
  if (!deps.force) {
    try {
      const raw = await getConfig(BOOST_VAULT_PROOF_KEY, null);
      const last = raw ? JSON.parse(raw) : null;
      if (last?.ok && now - (last.checkedAt ?? 0) < BOOST_VAULT_PROOF_INTERVAL_MS) {
        return { skipped: 'recent', checkedAt: last.checkedAt };
      }
    } catch { /* unparsable stored proof → rerun */ }
  }
  return runBoostVaultProof(deps);
}

// ── Hygiene (revoke-sweep's safe half — no sends) ───────────────────────────

export async function cycleBoostHygiene(deps = {}) {
  const now = deps.now ?? Date.now();
  let expired = 0;
  let held = 0;
  for (const status of ['quoted', 'deposit_pending']) {
    const rows = await listBoostCampaignsByStatus(status, 50);
    for (const row of rows) {
      if (row.legacyId) continue;
      // NO-GO fix 4: deposit_pending expires on the 24h deposit
      // window (acceptance + 24h), NOT the 15-minute quote window —
      // an accepted wallet that is merely slow to fund must not be
      // reaped at quote expiry. Unaccepted quotes keep quote expiry.
      const deadline = status === 'deposit_pending' && row.quoteConsumedAt
        ? row.quoteConsumedAt + BOOST_DEPOSIT_WINDOW_MS
        : (row.quoteExpiresAt ?? 0);
      if (deadline >= now) continue;
      if (status === 'deposit_pending' && row.depositAddress) {
        // NO-GO fix 4: never zero a key over a funded wallet. A
        // positive balance holds the campaign open (watcher keeps
        // watching; the owner is told once per campaign via a config
        // marker, not once per tick). An unreadable balance also
        // holds — expiry retries next tick, stranding never happens
        // by default.
        const balance = await boostDepositBalanceOrNull(row, deps);
        if (balance === null) continue;
        if (decCmp(balance, '0') > 0) {
          held++;
          const marker = `boost_hygiene_held:${row.id}`;
          if ((await getConfig(marker, null).catch(() => '1')) === null) {
            await setConfig(marker, String(now)).catch(() => {});
            await alertOwner('boost', `⚠️ Boost deposit held past its window\nCampaign ${row.id} still holds funds in its deposit wallet, so expiry did NOT delete its key. The campaign stays open — reconcile the deposit before cancelling.`);
            await auditMoney('boost', row.telegramUserId, 'campaign_expiry_held', `campaign=${row.id} balance=${balance}`);
          }
          continue;
        }
      }
      const patch = status === 'deposit_pending' ? { encryptedDepositPk: null } : {};
      if (await transitionBoost(row.id, status, 'expired', patch)) {
        expired++;
        await auditMoney('boost', row.telegramUserId, 'campaign_expired', `campaign=${row.id} from=${status}`);
      }
    }
  }
  // NO-GO fix 1: the vault proof rides this existing cycle (no tick.js
  // edit, so the answer-path files stay untouched). Failure-isolated:
  // a proof failure never breaks hygiene, and the proof itself runs
  // at most once per 24h unless forced.
  let vaultProof = null;
  try { vaultProof = await cycleBoostVaultProof(deps); }
  catch { vaultProof = { ok: false, error: 'proof_threw' }; }
  return { expired, held, vaultProof };
}

// ── Rendering (member surfaces: own data only; never secrets) ──────────────

const BOOST_STATUS_ICON = {
  draft: '📝', quoted: '🧾', deposit_pending: '💳', deposit_generating: '⏳', funded: '💰', planned: '🗺️',
  awaiting_arm: '⏸️', executing: '🚀', settling: '🧮', completed: '✅',
  expired: '⌛', refund_pending: '↩️', refunded: '💸', reconciliation_required: '🛠️', cancelled: '🚫',
};

export function renderBoostLine(c) {
  const icon = BOOST_STATUS_ICON[c.status] ?? '❓';
  const token = c.tokenSymbol ?? (c.tokenCa ? c.tokenCa.slice(0, 10) + '…' : 'token');
  return `${icon} #${c.id} ${BOOST_TYPE_CATALOG[c.mode]?.shortLabel ?? c.mode} · ${token} (${c.chain}) — ${c.status.replace(/_/g, ' ')} · $${c.totalDueUsd ?? '?'}`;
}

export function renderBoostDetail(c) {
  const lines = [
    `⚡ ${BOOST_TYPE_CATALOG[c.mode]?.label ?? c.mode} — ${c.chain.toUpperCase()}`,
    `Status: ${c.status.replace(/_/g, ' ')}`,
    `Token: ${c.tokenCa ?? '—'}`,
    `Working capital: $${c.workingCapitalUsd ?? '0'}`,
    `Platform fee: $${c.platformFeeUsd ?? '0'} (after $${c.discountUsd ?? '0'} tier discount)`,
    `Network reserve: $${c.networkReserveUsd ?? '0'}`,
    `Total due: $${c.totalDueUsd ?? '0'} ≈ ${c.totalDueNative ?? '?'} ${CHAINS[c.chain]?.nativeSymbol ?? ''}`,
  ];
  // NO-GO fix 3, detail-page surface: Bump retention disclosure.
  if (c.mode === 'bump') lines.push('', BUMP_RETENTION_DISCLOSURE);
  // NO-GO fix 5, detail-page surface: master-refund warning (sync check).
  if (c.chain !== 'sol' && normalizeEvmAddress(c.refundAddress ?? '')
    && normalizeEvmAddress(c.refundAddress) === MASTER_WALLET_ADDRESS) {
    lines.push('', BOOST_REFUND_MASTER_TEXT);
  }
  if (c.status === 'deposit_pending' && c.depositAddress) {
    // NO-GO fix 4: deposit window copy — 24h from acceptance, not the
    // 15-minute quote window.
    lines.push('', `Send exactly ${c.totalDueNative} ${CHAINS[c.chain]?.nativeSymbol ?? ''} to:`, c.depositAddress, '', 'Your deposit is detected automatically. This deposit address stays valid for 24 hours from acceptance — after that it lapses and you start again with /boost for a fresh address.');
  }
  if (c.status === 'deposit_generating') {
    lines.push('', 'Your Solana deposit wallet is being generated on the host signer — the address appears here automatically. Nothing to do.');
  }
  if (c.status === 'planned') {
    lines.push('', 'Planned and verified. Live execution opens on the owner live flag — nothing has been broadcast.');
  }
  if (c.status === 'awaiting_arm') {
    lines.push('', 'Your campaign is funded and fully planned. Execution opens when the operator arms live sends — nothing has been broadcast.');
  }
  return lines.join('\n');
}

// ── Wizard (DM-only; draft in config, Studio pattern) ───────────────────────

const WIZ_TTL_MS = 30 * 60 * 1000;
const wizKey = (uid) => `boostwiz:${uid}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function loadWiz(uid) {
  try {
    const raw = await getConfig(wizKey(uid), null);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || Date.now() - (d.createdAt ?? 0) > WIZ_TTL_MS) return null;
    return d;
  } catch { return null; }
}
async function saveWiz(uid, draft) {
  // Routing recency (hijack fix 2026-10-25): every draft save stamps the
  // last touch, so the dispatcher can tell which of two coexisting
  // money-wizard drafts the user touched most recently. TTL still keys
  // off createdAt (unchanged) — this field never extends a session.
  draft.lastTouchAt = Date.now();
  await setConfig(wizKey(uid), JSON.stringify(draft)).catch(() => {});
}
async function clearWiz(uid) { await setConfig(wizKey(uid), JSON.stringify({ createdAt: 0 })).catch(() => {}); }

/** Live session predicate (single source of truth for the dispatcher):
 *  flag on AND a TTL-valid draft, any stage — a quoted wizard still
 *  awaits its Accept/Cancel tap, so it counts as live. */
export async function isBoostWizardActive(uid) {
  if (!(await isBoostEnabled())) return false;
  return (await loadWiz(uid)) !== null;
}

/** Last-touch timestamp for routing order (0 = no live draft). */
export async function boostWizardTouch(uid) {
  const draft = await loadWiz(uid);
  if (!draft) return 0;
  return draft.lastTouchAt ?? draft.createdAt ?? 0;
}

/** Next prompt for the routing guard's re-prompt (null = no session). */
export async function boostWizardNextPrompt(uid) {
  const draft = await loadWiz(uid);
  if (!draft) return null;
  if (draft.stage === 'quoted') return 'Tap ✅ Accept or ❌ Cancel on the quote above — typed words can\'t accept it.';
  return nextTextPrompt(draft) ?? 'Your quote hit a snag — send any message to retry it.';
}

async function sendDm(uid, text, extra = {}) {
  try { await api.sendMessage({ chat_id: uid, text: String(text).slice(0, 4000), ...extra }); } catch { /* DM closed */ }
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

function modePanel() {
  return {
    text: '⚡ <b>Pup Booster</b>\nStep 1 — pick a boost type\n────────────────\n📈 Volume — balanced buy/sell cycles (Base · Solana · Robinhood Chain)\n⚡ Bump — one buy per wallet, Base only (Pulse $29 · Push $79 · Hold $149)\n🚀 MCap — buy-weighted toward a target band, Base only',
    reply_markup: { inline_keyboard: [
      [{ text: '📈 Volume', callback_data: 'boost:mode:volume' }, { text: '⚡ Bump', callback_data: 'boost:mode:bump' }, { text: '🚀 MCap', callback_data: 'boost:mode:mcap' }],
      [{ text: '❌ Cancel', callback_data: 'boost:cancel' }],
    ] },
  };
}

function chainPanel(draft) {
  const chains = BOOST_TYPE_CATALOG[draft.mode].supportedChains;
  return {
    text: `${BOOST_TYPE_CATALOG[draft.mode].icon} <b>${BOOST_TYPE_CATALOG[draft.mode].label}</b>\nStep 2 — pick a chain\n────────────────`,
    reply_markup: { inline_keyboard: [
      chains.map((c) => ({ text: CHAINS[c].label, callback_data: `boost:chain:${c}` })),
      [{ text: '❌ Cancel', callback_data: 'boost:cancel' }],
    ] },
  };
}

export function bumpPanel() {
  return {
    // NO-GO fix 3, package-picker surface: Bump retention disclosure.
    text: '⚡ <b>Bump</b>\nStep 3 — pick a package\n────────────────\nPulse — $29 platform fee · ~1 hour\nPush — $79 platform fee · ~6 hours\nHold — $149 platform fee · ~24 hours\n\n(Plus your working capital + network reserve — quoted exactly before you commit.)\n\n' + BUMP_RETENTION_DISCLOSURE,
    reply_markup: { inline_keyboard: [
      Object.entries(BUMP_PACKAGES).map(([k, p]) => ({ text: `${p.label} $${p.platformFeeUsd}`, callback_data: `boost:bump:${k}` })),
      [{ text: '❌ Cancel', callback_data: 'boost:cancel' }],
    ] },
  };
}

const nextTextPrompt = (draft) => {
  if (!draft.tokenCa) return 'Send the token contract address (CA) for the chain you picked.';
  if (!draft.capitalUsd) return `Send your working capital in USD (e.g. 500). This is your money — it funds the cycles and the unused part comes back to your refund address.`;
  if (draft.mode === 'mcap' && !draft.mcapMin) return 'Send the target market-cap band as two USD numbers: MIN MAX (e.g. 250000 400000).';
  if (!draft.refundAddress) return 'Send your refund address — unused capital and reserve are swept back there after the run.';
  return null;
};

async function showQuote(uid, draft, deps = {}) {
  const tier = await getUserTier(uid);
  const input = {
    mode: draft.mode, chain: draft.chain, tokenCA: draft.tokenCa,
    refundAddress: draft.refundAddress, workingCapitalUsd: Number(draft.capitalUsd),
    ...(draft.bumpPackage ? { bumpPackage: draft.bumpPackage } : {}),
    ...(draft.mcapMin ? { targetMcapMinUsd: Number(draft.mcapMin), targetMcapMaxUsd: Number(draft.mcapMax) } : {}),
  };
  // NO-GO fix 5: warnings are LIVE here, not dormant — they come from
  // createBoostCampaign's guard and render on the panel. A 'block'
  // warning suppresses Accept entirely: the user must cancel and
  // restart with a different refund address.
  const { id, quote, warnings = [] } = await createBoostCampaign(uid, input, deps);
  draft.campaignId = id;
  draft.stage = 'quoted';
  await saveWiz(uid, draft);
  const blocked = warnings.some((w) => w.severity === 'block');
  const text = [
    '🧾 <b>Your signed quote</b> (15 minutes)',
    '',
    `${BOOST_TYPE_CATALOG[draft.mode].icon} ${BOOST_TYPE_CATALOG[draft.mode].label} on ${CHAINS[draft.chain].label}`,
    `Token: <code>${esc(draft.tokenCa)}</code>`,
    `Working capital: <b>$${quote.workingCapitalUsd}</b>`,
    `Platform fee: <b>$${quote.platformFeeUsd}</b>${quote.discountUsd ? ` (tier discount −$${quote.discountUsd})` : ''}`,
    `Network reserve: <b>$${quote.networkReserveUsd}</b>`,
    `Total due: <b>$${quote.totalDueUsd}</b> ≈ <b>${quote.totalDueNative} ${CHAINS[draft.chain].nativeSymbol}</b>`,
    // NO-GO fix 3, quote-panel surface: Bump retention disclosure.
    ...(draft.mode === 'bump' ? ['', BUMP_RETENTION_DISCLOSURE] : []),
    // NO-GO fix 5, quote-panel surface: live guard warnings.
    ...(warnings.length ? ['', ...warnings.map((w) => w.text)] : []),
    ...(blocked ? ['', 'This quote cannot be accepted as shown — tap ❌ Cancel and start again with a different refund address.'] : []),
    '',
    'Accept to get your one-time deposit address. Nothing is sent anywhere until you fund it — and execution itself stays gated on the owner live flag, so nothing broadcasts yet.',
  ].join('\n');
  return {
    text,
    reply_markup: { inline_keyboard: blocked
      ? [[{ text: '❌ Cancel', callback_data: 'boost:cancel' }]]
      : [
          [{ text: '✅ Accept & get deposit address', callback_data: 'boost:accept' }],
          [{ text: '❌ Cancel', callback_data: 'boost:cancel' }],
        ] },
  };
}

export async function handleBoostWizardText(chatId, user, text, deps = {}) {
  const uid = user?.id;
  if (!uid || !(await isBoostEnabled())) return false;
  const draft = await loadWiz(uid);
  if (!draft) return false;
  // PRICING WAVE: a trial user never progresses the booster wizard —
  // refusal here (not just at quote time) so no draft work is wasted.
  // TRIAL FIX WAVE 2026-11-01, bug 11: an unverifiable tier (DB error
  // sentinel) is refused too — but unlike trial, the draft is NOT
  // cleared: an unreadable tier is transient, and clearing would
  // destroy the user's in-progress draft for a DB blip. The wizard
  // simply does not progress on this turn; a later turn retries.
  {
    const wizTier = await getUserTier(uid);
    if (isBoostTierHeld(wizTier)) {
      if (String(wizTier ?? '').toLowerCase().trim() === BOOST_TIER_UNKNOWN) {
        await sendDm(uid, '⚡ Booster tier could not be verified right now — please try again in a moment. Nothing was changed.');
        return true;
      }
      await sendDm(uid, '⚡ Booster sends aren\'t part of the 7-day free trial — finish the trial or upgrade to the PB Plan ($29/mo), then come back with /boost.');
      await clearWiz(uid);
      return true;
    }
  }
  // Quoted stage (hijack fix 2026-10-25): the wizard still owns the DM
  // while the quote awaits its Accept/Cancel tap — typed text used to
  // decline here and fall through to the agent loop. Consume + nudge.
  if (draft.stage === 'quoted') {
    await sendDm(uid, 'Tap ✅ Accept or ❌ Cancel on the quote above — typed words can\'t accept it.');
    return true;
  }
  const value = String(text ?? '').trim();
  if (!draft.tokenCa) {
    const ok = draft.chain === 'sol' ? isValidSolAddress(value) : isValidEvmAddress(value);
    if (!ok) { await sendDm(uid, 'That doesn\u2019t look like a valid address for this chain — send the token contract address again.'); return true; }
    draft.tokenCa = value;
  } else if (!draft.capitalUsd) {
    const n = Number(value.replace(/[$,]/g, ''));
    if (!Number.isFinite(n) || n <= 0) { await sendDm(uid, 'Send the working capital as a USD number (e.g. 500).'); return true; }
    draft.capitalUsd = n;
  } else if (draft.mode === 'mcap' && !draft.mcapMin) {
    const parts = value.replace(/[$,]/g, '').split(/\s+/).map(Number);
    if (parts.length !== 2 || !(parts[0] > 0) || !(parts[1] > parts[0])) {
      await sendDm(uid, 'Send the band as two numbers: MIN MAX, with MAX above MIN (e.g. 250000 400000).');
      return true;
    }
    [draft.mcapMin, draft.mcapMax] = parts;
  } else if (!draft.refundAddress) {
    const ok = draft.chain === 'sol' ? isValidSolAddress(value) : isValidEvmAddress(value);
    if (!ok) { await sendDm(uid, 'That refund address isn\u2019t valid for this chain — send it again.'); return true; }
    draft.refundAddress = value;
  }
  await saveWiz(uid, draft);
  const prompt = nextTextPrompt(draft);
  if (prompt) { await sendDm(uid, prompt); return true; }
  // Quote build (hijack fix 2026-10-25): preflight/price failures THROW
  // (buildBoosterQuote throws before any campaign insert; audit never
  // throws), and a throw here used to fall through to the agent loop,
  // which grabbed the refund address as a goal. Contain it: one immediate
  // retry (transient blips heal), then keep the draft and let the next
  // message retry — a failed attempt never created a campaign, so a
  // retry cannot duplicate one. Always returns true: this input is the
  // wizard's, never the loop's.
  let panel;
  try {
    panel = await showQuote(uid, draft, deps);
  } catch (err) {
    try { panel = await showQuote(uid, draft, deps); } catch { panel = null; }
    if (!panel) {
      await sendDm(uid, '⚠️ The quote hit a snag — your answers are kept. Send any message to retry the quote.');
      return true;
    }
  }
  const sent = await api.sendMessage({ chat_id: uid, text: panel.text, parse_mode: 'HTML', reply_markup: panel.reply_markup }).catch(() => null);
  if (sent?.message_id) { draft.panelId = sent.message_id; await saveWiz(uid, draft); }
  return true;
}

export async function handleBoostCallback({ userId, data, messageId }, deps = {}) {
  const uid = userId;
  const [, sub, arg] = String(data).split(':');
  // Cancel branches run BEFORE the parked gate: cancelling is a safety
  // action, and a parked product must never strand a user in a campaign
  // they want out of. The guards live in cancelBoostCampaign itself and
  // are NOT modified here — these branches only surface it.
  if (sub === 'cancelown') {
    const row = await getBoostCampaign(arg);
    if (!row || row.telegramUserId !== String(uid)) return { text: 'Campaign not found.', alert: true };
    if (!BOOST_CANCELLABLE_STATUSES.includes(row.status)) return { text: `A ${row.status.replace(/_/g, ' ')} campaign can't be cancelled here.`, alert: true };
    await editPanel(uid, messageId, `Cancel boost campaign #${row.id}? This is final — the campaign stops and can't be restarted. Cancelling never deletes a funded wallet: if the deposit holds funds, cancel refuses instead.`, { inline_keyboard: [
      [{ text: '✅ Yes, cancel it', callback_data: `boost:cancelgo:${row.id}` }],
      [{ text: '❌ Keep it', callback_data: `boost:cancelkeep:${row.id}` }],
    ] });
    return { text: 'Confirm cancel' };
  }
  if (sub === 'cancelgo') {
    const res = await cancelBoostCampaign(uid, arg);
    if (res?.error) return { text: res.error, alert: true };
    await editPanel(uid, messageId, `🛑 Boost campaign #${arg} cancelled.`, null);
    return { text: 'Cancelled' };
  }
  if (sub === 'cancelkeep') {
    await editPanel(uid, messageId, 'Campaign kept — nothing changed.', null);
    return { text: 'Kept' };
  }
  // Calendar slot wizard branches run BEFORE the parked gate (like
  // cancel): booking a slot is scheduling only, never a send, so a
  // parked product can still be scheduled — with the parked copy in
  // the panels, never a promise that it sends.
  if (['slot', 'slotdate', 'slottime', 'slotconfirm', 'slotcancel', 'slotcancelbook', 'slotfull'].includes(sub)) {
    const handled = await handleCalendarSlotCallback({ userId, data, messageId });
    if (handled) return handled;
  }
  if (!(await isBoostEnabled())) return { text: '⚡ Booster is parked right now.', alert: true };
  const draft = (await loadWiz(uid)) ?? { createdAt: Date.now(), stage: 'start' };
  if (sub === 'cancel') {
    if (draft.campaignId) await cancelBoostCampaign(uid, draft.campaignId).catch(() => {});
    await clearWiz(uid);
    await editPanel(uid, messageId, '❌ Boost wizard cancelled.', null);
    return { text: 'Cancelled' };
  }
  if (sub === 'mode') {
    draft.mode = arg; draft.createdAt = Date.now(); draft.stage = 'chain';
    await saveWiz(uid, draft);
    const panel = chainPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: BOOST_TYPE_CATALOG[arg].label };
  }
  if (sub === 'chain') {
    draft.chain = arg; draft.stage = draft.mode === 'bump' ? 'bump' : 'text';
    await saveWiz(uid, draft);
    if (draft.mode === 'bump') {
      const panel = bumpPanel();
      await editPanel(uid, messageId, panel.text, panel.reply_markup);
    } else {
      await editPanel(uid, messageId, `Chain set: <b>${CHAINS[arg].label}</b>`, null);
      await sendDm(uid, nextTextPrompt(draft));
    }
    return { text: CHAINS[arg].label };
  }
  if (sub === 'bump') {
    draft.bumpPackage = arg; draft.stage = 'text';
    await saveWiz(uid, draft);
    await editPanel(uid, messageId, `Package: <b>${BUMP_PACKAGES[arg].label}</b> ($${BUMP_PACKAGES[arg].platformFeeUsd})`, null);
    await sendDm(uid, nextTextPrompt(draft));
    return { text: BUMP_PACKAGES[arg].label };
  }
  if (sub === 'accept') {
    if (!draft.campaignId) return { text: 'Quote expired — start again with /boost.', alert: true };
    const res = await acceptBoostQuote(uid, draft.campaignId, deps);
    if (res.error) { await sendDm(uid, `⚠️ ${res.error}`); return { text: 'Quote problem', alert: true }; }
    if (res.generating) {
      await clearWiz(uid);
      await sendDm(uid, [
        '⏳ <b>Deposit wallet generating</b>',
        '',
        'Your Solana deposit wallet is being generated on the host signer. The address appears in /mydrops automatically — nothing to do, and nothing is charged until you fund it.',
      ].join('\n'), { parse_mode: 'HTML' });
      return { text: 'Deposit wallet generating' };
    }
    await clearWiz(uid);
    await sendDm(uid, [
      '💳 <b>Deposit address ready</b>',
      '',
      `Send exactly <b>${res.totalDueNative} ${CHAINS[res.chain].nativeSymbol}</b> to:`,
      `<code>${res.depositAddress}</code>`,
      '',
      'One transfer, exact amount. Detection is automatic (checked every few minutes). This deposit address stays valid for 24 hours from now — if it lapses, start again with /boost and you\u2019ll get a fresh address.',
      'Execution stays in dry-run planning until the operator arms live sends.',
      '',
      '📅 Want a run time? Pick a slot on the calendar — full slots are shown, so you can pick around them.',
    ].join('\n'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📅 Pick a run slot', callback_data: `boost:slot:${draft.campaignId}` }]] } });
    return { text: 'Deposit address sent' };
  }
  return { text: 'Unknown step' };
}

// ── Calendar slot wizard (2026-11-01 calendar wave) ─────────────────────────
// Shared calendar (lib/tiers.js) inside the EXISTING booster wizard — no
// new command, no new card row. Steps, phone-simple, names/dates only:
//  1. Product is the wizard you are already in (Booster here; run
//     /airdrop in this DM to schedule an airdrop instead — products are
//     never mixed, and a booster slot is not an airdrop slot).
//  2. Pick a date, then a time slot. Full slots show as full and are
//     not buttons — pick around them to another open slot.
//  3. Preview: exact product, exact date/time, exact campaign.
//  4. Confirm / Cancel — Cancel books nothing; Confirm claims the slot
//     with a re-check at confirm time, so a slot that filled since the
//     view never double-books.
//  5. Confirmation naming the product and slot only.
// Booking is SCHEDULING ONLY: it never funds, arms, or executes a
// send. A booked slot that arrives while booster sends are still
// parked waits — it never auto-sends. Trial users never reach this
// wizard for booster: the trial booster-send exclusion (create/accept/
// wizard gates above) still refuses them, with the upgrade path, and
// that exclusion is NOT lifted here — see the wave plan's single
// trial-booking follow-up question.
async function calDatePanel(campaignId) {
  const cal = await listCalendar('boost');
  if (cal.error) return { text: `⚠️ ${cal.error}`, reply_markup: null };
  const rows = cal.days.map((d) => ([{ text: `📅 ${d.date}`, callback_data: `boost:slotdate:${campaignId}_${d.dateKey}` }]));
  rows.push([{ text: '❌ Cancel', callback_data: `boost:slotcancel:${campaignId}` }]);
  return {
    text: `📅 <b>Booster — book a slot</b>\nStep 1 of 3 — pick a date\n────────────────\nCampaign #${campaignId}\nPick a day, then a time slot.\nFull slots are marked full and can't be picked.\n\nBooking a slot schedules your run window only — nothing sends until booster sends are armed.`,
    reply_markup: { inline_keyboard: rows },
  };
}
async function calTimePanel(campaignId, dateKey) {
  const cal = await listCalendar('boost');
  if (cal.error) return { text: `⚠️ ${cal.error}`, reply_markup: null };
  const day = (cal.days ?? []).find((d) => d.dateKey === dateKey);
  if (!day) return { text: 'That date is no longer on the calendar — pick another date.', reply_markup: { inline_keyboard: [[{ text: '📅 Back to dates', callback_data: `boost:slot:${campaignId}` }]] } };
  const rows = day.slots.map((s) => (s.full
    ? [{ text: `❌ ${s.label} — Full`, callback_data: `boost:slotfull:${campaignId}` }]
    : [{ text: `🟢 ${s.label} — Open`, callback_data: `boost:slottime:${campaignId}_${s.start}` }]));
  rows.push([{ text: '📅 Back to dates', callback_data: `boost:slot:${campaignId}` }]);
  rows.push([{ text: '❌ Cancel', callback_data: `boost:slotcancel:${campaignId}` }]);
  return {
    text: `📅 <b>Booster — ${day.date}</b>\nStep 2 of 3 — pick a time slot\n────────────────\nOpen slots can be picked.\nFull slots are shown as full and can't be picked.`,
    reply_markup: { inline_keyboard: rows },
  };
}
function calPreviewPanel(campaignId, slotStart) {
  const label = calendarSlotLabel(slotStart);
  return {
    text: `📅 <b>Booster — confirm your slot</b>\nStep 3 of 3 — confirm\n────────────────\nProduct: Booster\nCampaign: #${campaignId}\nSlot: ${label}\n\nThis books your run window only — nothing sends until booster sends are armed. Confirm to claim this slot, or cancel to book nothing.`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Confirm this slot', callback_data: `boost:slotconfirm:${campaignId}_${slotStart}` }],
      [{ text: '❌ Cancel', callback_data: `boost:slotcancel:${campaignId}` }],
    ] },
  };
}
async function handleCalendarSlotCallback({ userId, data, messageId }) {
  // data split in the caller gives [, sub, arg]; slot branches use
  // 'slot', 'slotdate', 'slottime', 'slotconfirm', 'slotcancel', 'slotfull'.
  const uid = userId;
  const [, sub, arg] = String(data).split(':');
  if (sub === 'slotcancel') {
    await editPanel(uid, messageId, '❌ Nothing booked — no slot was claimed.', null);
    return { text: 'Cancelled' };
  }
  if (sub === 'slotcancelbook') {
    const res = await cancelCalendarSlot({ product: 'boost', campaignId: arg, telegramUserId: uid });
    if (res.error) return { text: res.error, alert: true };
    await editPanel(uid, messageId, `❌ Booster booking cancelled (${res.slotLabel}). Pick another slot when ready.`, { inline_keyboard: [[{ text: '📅 Pick a slot', callback_data: `boost:slot:${arg}` }]] });
    return { text: 'Booking cancelled' };
  }
  if (sub === 'slotfull') return { text: 'That slot is full — pick another open slot.', alert: true };
  if (sub === 'slot') {
    const row = await getBoostCampaign(arg);
    if (!row || row.telegramUserId !== String(uid)) return { text: 'Campaign not found.', alert: true };
    const existing = await getCalendarBooking('boost', arg);
    if (existing) {
      await editPanel(uid, messageId, `📅 This campaign already has a Booster slot booked: <b>${existing.slotLabel}</b>.\n\nTo pick a different slot, cancel that booking first, then pick again.`, { inline_keyboard: [[{ text: '❌ Cancel this booking', callback_data: `boost:slotcancelbook:${arg}` }]] });
      return { text: 'Already booked' };
    }
    const panel = await calDatePanel(arg);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Pick a date' };
  }
  if (sub === 'slotdate') {
    const [campaignId, dateKey] = String(arg).split('_');
    const panel = await calTimePanel(campaignId, dateKey);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Pick a time' };
  }
  if (sub === 'slottime') {
    const [campaignId, slotStart] = String(arg).split('_');
    const panel = calPreviewPanel(campaignId, Number(slotStart));
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Preview' };
  }
  if (sub === 'slotconfirm') {
    const [campaignId, slotStart] = String(arg).split('_');
    const row = await getBoostCampaign(campaignId);
    if (!row || row.telegramUserId !== String(uid)) return { text: 'Campaign not found.', alert: true };
    // Trial exclusion, re-checked at confirm (not lifted by this wave).
    const tier = await getUserTier(uid);
    if (isBoostTierHeld(tier)) {
      await editPanel(uid, messageId, '⚡ Booster sends aren\'t part of the 7-day free trial — finish the trial or upgrade to the PB Plan ($29/mo), then come back with /boost.', null);
      return { text: 'Trial excluded', alert: true };
    }
    const res = await bookCalendarSlot({ product: 'boost', campaignId, telegramUserId: uid, tier, slotStart: Number(slotStart) });
    if (res.error) {
      await editPanel(uid, messageId, `⚠️ ${res.error}`, null);
      return { text: 'Slot problem', alert: true };
    }
    await editPanel(uid, messageId, `✅ <b>Booster slot booked: ${res.booking.slotLabel}</b>\n\nCampaign #${campaignId} is scheduled for that window. Nothing sends until booster sends are armed — a slot that arrives while still parked waits.`, null);
    return { text: 'Slot booked' };
  }
  return null;
}

// ── Commands ────────────────────────────────────────────────────────────────

const dmOnly = async (chatId, msg) => {
  if (msg?.chat?.type === 'private') return true;
  await api.sendMessage({ chat_id: chatId, text: '🔒 That one needs a private chat — open a DM with me and run it there.' }).catch(() => {});
  return false;
};
// Honest parked copy (audit F7): Pup Booster is BUILT and parked pending
// the owner's arm call — never the old "moving to a new home" notice.
// Only create/send paths land here; the read-only status commands
// (myboosts / boostdetail) answer from the DB regardless of the flag.
const BOOST_PARKED_TEXT =
  '⚡ Pup Booster is built and parked — live sends arm when the owner arms them. Your existing campaigns are safe.';
const parked = async (chatId) => { await api.sendMessage({ chat_id: chatId, text: BOOST_PARKED_TEXT }).catch(() => {}); };

async function startWizard(chatId, msg) {
  if (!(await dmOnly(chatId, msg))) return;
  if (!(await isBoostEnabled())) return parked(chatId);
  const uid = msg.from.id;
  const cap = await maxBoostCapitalUsd();
  await saveWiz(uid, { createdAt: Date.now(), stage: 'mode' });
  const panel = modePanel();
  await sendDm(uid, panel.text + `\n\nNote: while live sends are being rolled out, per-campaign working capital is capped at $${cap}.`, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
}

// Menu-button starter (2026-11-05): the /menu ⚡ Boost button in a group
// cannot pass a Message, so it cannot call startWizard (dmOnly needs one).
// This entry point skips the DM gate and DMs the mode panel directly — the
// same saveWiz('mode') + modePanel as startWizard, minus dmOnly. It reports
// delivery (sendDm swallows, so the send is done here): true when the panel
// — or the parked notice when the flag is off — reached the DM, false when
// the DM refused (bot blocked). Quote → deposit → arm gates are untouched:
// they run later, inside the wizard.
export async function startBoostWizardFor(userId) {
  if (!(await isBoostEnabled())) {
    try { await api.sendMessage({ chat_id: userId, text: BOOST_PARKED_TEXT }); return true; }
    catch { return false; }
  }
  const cap = await maxBoostCapitalUsd();
  await saveWiz(userId, { createdAt: Date.now(), stage: 'mode' });
  const panel = modePanel();
  try {
    await api.sendMessage({
      chat_id: userId,
      text: panel.text + `\n\nNote: while live sends are being rolled out, per-campaign working capital is capped at $${cap}.`,
      parse_mode: 'HTML', reply_markup: panel.reply_markup,
    });
    return true;
  } catch { return false; }
}

// ── Restore wave Batch 2 (2026-10-26): Replit user booster controls ─────
// Ported from telegram-community-bot.ts :19076 (/boosterstop) and :19209
// (/boosterretry). Unlike the owner-only /booststatus + /booststop above,
// these are ANY-user commands: the caller may only touch their OWN
// campaigns (row.telegramUserId === caller; legacy null-owner rows fail
// closed). DM-only, like the rest of this family.
//
// Safety deltas vs the Replit originals (deliberate, documented):
// · Identity is the Telegram user id, not Clerk: the current tree keys
//   campaigns by telegramUserId (no /link step).
// · /boosterstop covers the current engine's live set
//   (planned/executing) — Replit's (running/funding/sweeping). The stop
//   reuses the existing /booststop brake (transition to 'stopped' +
//   audit row); funds stay in campaign wallets, no refund.
// · /boosterretry NEVER re-launches directly: it claims the parent and
//   seeds a fresh wizard draft + signed quote. Accept → deposit → arm
//   run exactly as for /boost. A direct launch would bypass the funding
//   and arm gates — the same reason /boostrun stays unported.
// · Retryable set is (expired, cancelled, failed): 'failed' is in the
//   Replit vocabulary but no current path writes it at campaign level
//   (step failures live in plan steps, not the campaign row), so it is
//   covered defensively. reconciliation_required / refunded /
//   refund_pending are NEVER retryable: funds may be mid-flight there.
// · Retry is a CREATE path, so it parks when the booster is disabled
//   (like /boost); stopping is not a create path, so /boosterstop
//   answers regardless of the flag (like the existing /booststop).
const BOOST_LIVE_STATUSES = ['planned', 'executing'];
const BOOST_RETRYABLE_STATUSES = ['expired', 'cancelled', 'failed'];
const BOOST_MAX_RETRY_DEPTH = 3;

function boostRetryDepth(row) {
  try {
    const p = JSON.parse(row?.planJson ?? 'null');
    const d = Number(p?.retry?.depth ?? 0);
    return Number.isFinite(d) && d >= 0 ? d : 0;
  } catch { return 0; }
}

function boostIdArgOk(arg) {
  const s = String(arg ?? '').trim();
  return /^\d+$/.test(s) || s.startsWith('bc_');
}

/** Shared stop: re-reads, re-verifies ownership + live status, brakes. */
export async function stopOwnBoostCampaign(uid, campaignId) {
  const row = await getBoostCampaign(campaignId);
  if (!row || row.telegramUserId !== String(uid)) return { error: 'not_found' };
  if (!BOOST_LIVE_STATUSES.includes(row.status)) return { error: 'not_live', status: row.status };
  const moved = await transitionBoost(campaignId, row.status, 'stopped', { error: 'stopped by user' });
  if (!moved) return { error: 'changed' };
  await auditMoney('boost', uid, 'campaign_stopped', `campaign=${campaignId} via=boosterstop`);
  return { ok: true, id: campaignId };
}

export async function handleBoosterStopCallback({ userId, data, messageId, chatId }) {
  const arg = String(data ?? '').slice('boosterstop:'.length);
  if (arg === 'cancel') {
    try { await api.editMessageText({ chat_id: chatId, message_id: messageId, text: 'Cancelled.' }); } catch { /* best effort */ }
    return { text: 'Cancelled' };
  }
  if (!boostIdArgOk(arg)) return { text: 'Unknown campaign.', alert: true };
  const res = await stopOwnBoostCampaign(userId, arg);
  if (!res.ok) {
    return { text: res.error === 'not_found' ? 'Campaign not found or already stopped.' : 'Campaign already changed state.', alert: true };
  }
  try { await api.editMessageText({ chat_id: chatId, message_id: messageId, text: `✅ Stop signal sent to campaign #${arg}.\n\nIt will wind down after the current wallet completes.` }); } catch { /* best effort */ }
  return { text: `✅ Stop signal sent to #${arg}` };
}

/**
 * Retry a user's own ended campaign: claim the parent (the status flip
 * is the single-claim guard), then seed a fresh wizard draft + signed
 * quote from the parent's inputs. The child is a normal 'quoted'
 * campaign: Accept → fresh deposit address → arm, exactly as for
 * /boost. The parent's deposit keys are never reused. Lineage
 * (retry.of/depth) rides planJson — the row is 'quoted' until the
 * planner overwrites planJson at plan time, so the write cannot
 * clobber a plan. Depth cap is 3 per lineage (Replit
 * BOOSTER_MAX_RETRIES). On any failure after the claim, the parent is
 * restored and the child (if any) is cancelled: a failed retry changes
 * nothing.
 */
export async function retryOwnBoostCampaign(uid, campaignId, deps = {}) {
  const row = await getBoostCampaign(campaignId);
  if (!row || row.telegramUserId !== String(uid)) return { error: 'not_found' };
  if (!BOOST_RETRYABLE_STATUSES.includes(row.status)) return { error: 'not_retryable', status: row.status };
  const depth = boostRetryDepth(row);
  if (depth >= BOOST_MAX_RETRY_DEPTH) return { error: 'cap' };
  const capitalUsd = Number(row.workingCapitalUsd);
  if (!Number.isFinite(capitalUsd) || capitalUsd <= 0) return { error: 'quote', detail: 'original campaign has no usable budget' };
  // Snapshot everything the claim + quote need BEFORE the claim: the
  // claim mutates the row in place (transitionBoost patches status),
  // so row.status after the claim is 'retried', not the original.
  const fromStatus = row.status;
  const draft = {
    createdAt: Date.now(), stage: 'start',
    mode: row.mode, chain: row.chain, tokenCa: row.tokenCa,
    capitalUsd, refundAddress: row.refundAddress,
    ...(row.bumpPackage ? { bumpPackage: row.bumpPackage } : {}),
    ...(row.targetMcapMinUsd ? { mcapMin: row.targetMcapMinUsd, mcapMax: row.targetMcapMaxUsd } : {}),
  };
  const claimed = await transitionBoost(campaignId, fromStatus, 'retried', { error: 'retry claimed' });
  if (!claimed) return { error: 'claimed' };
  let panel;
  try {
    panel = await showQuote(uid, draft, deps);
  } catch (err) {
    await transitionBoost(campaignId, 'retried', fromStatus).catch(() => {});
    return { error: 'quote', detail: err?.message ?? 'unknown' };
  }
  const newId = draft.campaignId;
  try {
    await db.update(boost_campaigns).set({ planJson: JSON.stringify({ retry: { of: campaignId, depth: depth + 1 } }) })
      .where(and(eq(boost_campaigns.id, String(newId)), eq(boost_campaigns.status, 'quoted'))).run();
    const check = await getBoostCampaign(newId);
    if (!check || check.status !== 'quoted' || !check.planJson) throw new Error('lineage write failed');
  } catch {
    await cancelBoostCampaign(uid, newId).catch(() => {});
    await transitionBoost(newId, 'quoted', 'cancelled').catch(() => {});
    await transitionBoost(campaignId, 'retried', fromStatus).catch(() => {});
    return { error: 'quote', detail: 'lineage write failed' };
  }
  return { ok: true, parentId: campaignId, newId, panel };
}

async function sendRetryResult(uid, res) {
  if (res.ok) {
    await sendDm(uid, `🔄 <b>Re-queued as a fresh quote.</b>\n\nOriginal #${res.parentId} kept as history (marked retried).\nNew quote #${res.newId} below — it expires in 15 minutes. Accept to get a fresh deposit address; nothing is sent until you fund it, and execution stays gated on the owner live flag.`, { parse_mode: 'HTML' });
    await sendDm(uid, res.panel.text, { parse_mode: 'HTML', reply_markup: res.panel.reply_markup });
    return;
  }
  if (res.error === 'not_found') await sendDm(uid, '❌ Campaign not found or doesn\'t belong to you.');
  else if (res.error === 'not_retryable') await sendDm(uid, `ℹ️ That campaign is ${String(res.status).replace(/_/g, ' ')} — only ended campaigns (expired, cancelled) can be retried. Check /myboosts.`);
  else if (res.error === 'cap') await sendDm(uid, '⛔ Retry limit reached. Max retries used — start a new campaign instead.');
  else if (res.error === 'claimed') await sendDm(uid, '⚠️ Campaign already changed state — check /myboosts.');
  else await sendDm(uid, '⚠️ The retry quote hit a snag — nothing changed. Try /boosterretry again.');
}

export async function handleBoosterRetryCallback({ userId, data, messageId, chatId }, deps = {}) {
  const arg = String(data ?? '').slice('boosterretry:'.length);
  if (arg === 'cancel') {
    try { await api.editMessageText({ chat_id: chatId, message_id: messageId, text: 'Cancelled.' }); } catch { /* best effort */ }
    return { text: 'Cancelled' };
  }
  if (!boostIdArgOk(arg)) return { text: 'Unknown campaign.', alert: true };
  if (!(await isBoostEnabled())) return { text: '⚡ Booster is parked right now.', alert: true };
  const res = await retryOwnBoostCampaign(userId, arg, deps);
  if (!res.ok) {
    const text = res.error === 'cap' ? '⛔ Retry limit reached.'
      : res.error === 'not_found' ? 'Campaign not found or already retried.'
      : res.error === 'not_retryable' ? 'That campaign can no longer be retried.'
      : 'Retry hit a snag — nothing changed.';
    return { text, alert: true };
  }
  try { await api.editMessageText({ chat_id: chatId, message_id: messageId, text: `✅ Re-queued — new quote #${res.newId} below. Original #${res.parentId} kept as history.` }); } catch { /* best effort */ }
  await sendDm(userId, res.panel.text, { parse_mode: 'HTML', reply_markup: res.panel.reply_markup });
  return { text: '🔄 Re-queued as a fresh quote' };
}

export const BOOST_COMMANDS = {
  boost: async (chatId, _args, msg) => startWizard(chatId, msg),
  booster: async (chatId, _args, msg) => startWizard(chatId, msg),
  boostquote: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    if (!(await isBoostEnabled())) return parked(chatId);
    const m = /^(\w+):([^:]+):([0-9.]+):(.+)$/.exec(String(args ?? '').trim());
    if (!m) {
      await sendDm(msg.from.id, 'Usage: /boostquote <chain>:<tokenCA>:<capitalUsd>:<refundAddress>\nExample: /boostquote base:0xToken…:500:0xYourWallet…');
      return;
    }
    const [, chain, tokenCA, capital, refundAddress] = m;
    const input = { mode: 'volume', chain, tokenCA, refundAddress, workingCapitalUsd: Number(capital) };
    const invalid = validateContractInput(input);
    if (invalid) { await sendDm(msg.from.id, `⚠️ ${invalid}`); return; }
    try {
      const draft = { createdAt: Date.now(), stage: 'quote', mode: 'volume', chain, tokenCa: tokenCA, capitalUsd: Number(capital), refundAddress };
      const panel = await showQuote(msg.from.id, draft);
      await sendDm(msg.from.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    } catch (err) {
      await sendDm(msg.from.id, `⚠️ Quote failed: ${err?.message ?? 'unknown error'}`);
    }
  },
  myboosts: async (chatId, _args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const rows = await listOwnBoostCampaigns(msg.from.id, 10);
    if (!rows.length) { await sendDm(msg.from.id, '⚡ No boost campaigns yet — /boost to start one.'); return; }
    const cancellable = rows.filter((r) => BOOST_CANCELLABLE_STATUSES.includes(r.status));
    // Calendar wave: every listed campaign gets a slot button (scheduling
    // only), alongside the existing cancel buttons — no behaviour removed.
    const slotRows = rows.map((r) => ([{ text: `📅 Pick a slot for #${r.id}`, callback_data: `boost:slot:${r.id}` }]));
    const extra = (cancellable.length || slotRows.length)
      ? { reply_markup: { inline_keyboard: [
        ...slotRows,
        ...cancellable.map((r) => ([{ text: `❌ Cancel #${r.id}`, callback_data: `boost:cancelown:${r.id}` }])),
      ] } }
      : {};
    await sendDm(msg.from.id, `⚡ Your Boost Campaigns\n\n${rows.map(renderBoostLine).join('\n')}`, extra);
  },
  boostdetail: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const row = await getBoostCampaign(String(args ?? '').trim());
    if (!row || row.telegramUserId !== String(msg.from.id)) { await sendDm(msg.from.id, 'Campaign not found.'); return; }
    await sendDm(msg.from.id, renderBoostDetail(row));
  },
  // Restore wave 1 (2026-10-25): Replit owner boost controls, ported
  // standalone (the Replit originals were direct onText handlers, not
  // wizard steps). DM-only like the rest of this family. /boostrun is
  // deliberately NOT restored here: the current engine requires
  // quote → deposit → arm, and a direct launch would bypass funding
  // and arm gates — that needs Rowdy's arm decision, not just a port.
  booststatus: async (chatId, _args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    if (!(await requireOwner(msg.from?.id))) { await sendDm(msg.from.id, '⛔ Owner only.'); return; }
    const rows = await listOwnBoostCampaigns(msg.from.id, 5);
    if (!rows.length) { await sendDm(msg.from.id, '⚡ No booster campaigns found.'); return; }
    const cancellable = rows.filter((r) => BOOST_CANCELLABLE_STATUSES.includes(r.status));
    const extra = cancellable.length
      ? { reply_markup: { inline_keyboard: [
        ...cancellable.map((r) => ([{ text: `❌ Cancel #${r.id}`, callback_data: `boost:cancelown:${r.id}` }])),
      ] } }
      : {};
    await sendDm(msg.from.id, `⚡ Booster Campaigns (last 5)\n\n${rows.map(renderBoostLine).join('\n')}\n\nStop: /booststop [id]`, extra);
  },
  booststop: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    if (!(await requireOwner(msg.from?.id))) { await sendDm(msg.from.id, '⛔ Owner only.'); return; }
    const idArg = String(args ?? '').trim();
    let targetId = (/^\d+$/.test(idArg) || idArg.startsWith('bc_')) ? idArg : null;
    if (!targetId) {
      const rows = await listOwnBoostCampaigns(msg.from.id, 25);
      const open = rows.find((r) => ['draft', 'quoted', 'deposit_pending', 'deposit_generating'].includes(r.status));
      const live = rows.find((r) => ['planned', 'executing'].includes(r.status));
      targetId = open?.id ?? live?.id ?? null;
    }
    if (!targetId) { await sendDm(msg.from.id, 'ℹ️ No cancellable or stoppable booster campaign found.'); return; }
    const row = await getBoostCampaign(targetId);
    if (!row || row.telegramUserId !== String(msg.from.id)) { await sendDm(msg.from.id, '⚠️ Campaign not found.'); return; }
    // Brake for live campaigns (executor wave): planned/executing stop
    // immediately — the cycle lists only those two statuses, so no
    // further waves push; in-flight submitted waves still settle their
    // progress records. Funds stay in campaign wallets; NO auto-refund.
    if (['planned', 'executing'].includes(row.status)) {
      const moved = await transitionBoost(targetId, row.status, 'stopped', { error: 'stopped by owner' });
      if (!moved) { await sendDm(msg.from.id, '⚠️ Campaign already changed state — check /booststatus.'); return; }
      await auditMoney('boost', msg.from.id, 'campaign_stopped', `campaign=${targetId}`);
      await sendDm(msg.from.id, `🛑 Stop signal sent — campaign #${targetId} stopped. No further waves will push; waves already sent still settle, and funds stay in campaign wallets pending your call.`);
      return;
    }
    const res = await cancelBoostCampaign(msg.from.id, targetId);
    if (res?.error) { await sendDm(msg.from.id, `⚠️ ${res.error}`); return; }
    await sendDm(msg.from.id, `🛑 Stop signal sent — campaign #${targetId} cancelled.`);
  },
  // Restore wave Batch 2 (2026-10-26): Replit user booster controls.
  // DM-only, any user, own campaigns only (see the helpers above).
  boosterstop: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const uid = msg.from.id;
    const idArg = String(args ?? '').trim();
    if (idArg) {
      if (!boostIdArgOk(idArg)) { await sendDm(uid, '⚡ Give a campaign id, e.g. /boosterstop bc_0123… — or run /boosterstop with no id to pick from your running campaigns.'); return; }
      const res = await stopOwnBoostCampaign(uid, idArg);
      if (res.ok) { await sendDm(uid, `🛑 Stop signal sent — campaign #${idArg} stopped. No further waves will push; waves already sent still settle, and funds stay in campaign wallets pending your call.`); return; }
      if (res.error === 'not_found') { await sendDm(uid, `❌ Campaign #${idArg} is not running or doesn't belong to you.`); return; }
      if (res.error === 'not_live') { await sendDm(uid, `ℹ️ Campaign #${idArg} is ${String(res.status).replace(/_/g, ' ')} — only running campaigns can be stopped this way. Check /myboosts.`); return; }
      await sendDm(uid, '⚠️ Campaign already changed state — check /myboosts.'); return;
    }
    const rows = await listOwnBoostCampaigns(uid, 25);
    const live = rows.filter((r) => BOOST_LIVE_STATUSES.includes(r.status));
    if (!live.length) { await sendDm(uid, '⚡ No active campaigns. Nothing to stop.\n\nUse /boost to launch one.'); return; }
    const lines = live.map((c) => `#${c.id} ${c.status} — ${(c.tokenCa ? c.tokenCa.slice(0, 16) + '…' : 'unknown')} (${c.walletsDone}/${c.walletCount}w)`).join('\n');
    await sendDm(uid, `⚡ <b>Running Campaigns — Tap to stop:</b>\n\n${lines}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      ...live.map((c) => ([{ text: `🛑 Stop #${c.id}`, callback_data: `boosterstop:${c.id}` }])),
      [{ text: '❌ Cancel', callback_data: 'boosterstop:cancel' }],
    ] } });
  },
  boosterretry: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const uid = msg.from.id;
    if (!(await isBoostEnabled())) return parked(chatId);
    const idArg = String(args ?? '').trim();
    if (idArg) {
      if (!boostIdArgOk(idArg)) { await sendDm(uid, '⚡ Give a campaign id, e.g. /boosterretry bc_0123… — or run /boosterretry with no id to pick from your ended campaigns.'); return; }
      await sendRetryResult(uid, await retryOwnBoostCampaign(uid, idArg));
      return;
    }
    const rows = await listOwnBoostCampaigns(uid, 25);
    const ended = rows.filter((r) => BOOST_RETRYABLE_STATUSES.includes(r.status));
    if (!ended.length) { await sendDm(uid, '🔄 No ended campaigns found. Nothing to retry.\n\nUse /boost to launch a new campaign.'); return; }
    const lines = ended.map((c) => `#${c.id} ${BOOST_TYPE_CATALOG[c.mode]?.shortLabel ?? c.mode} · ${(c.tokenSymbol ?? (c.tokenCa ? c.tokenCa.slice(0, 10) + '…' : 'token'))} (${c.chain}) — ${c.status.replace(/_/g, ' ')}`).join('\n');
    await sendDm(uid, `🔄 <b>Ended Campaigns — Tap to retry:</b>\n\n${lines}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      ...ended.map((c) => ([{ text: `🔄 Retry #${c.id}`, callback_data: `boosterretry:${c.id}` }])),
      [{ text: '❌ Cancel', callback_data: 'boosterretry:cancel' }],
    ] } });
  },
  // NO-GO fix 1 (2026-10-26): on-demand bot-vault proof, owner-only,
  // DM-only. Reports booleans + timestamp only — never key material,
  // plaintext, or ciphertext. Worker-key equality is NOT claimed here
  // (it needs the bridge vaultcheck, still pending); the reply says so.
  boostvault: async (chatId, _args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    if (!(await requireOwner(msg.from?.id))) { await sendDm(msg.from.id, '⛔ Owner only.'); return; }
    const r = await runBoostVaultProof({ force: true });
    await sendDm(msg.from.id, [
      `🔐 Bot vault proof — ${r.ok ? 'PASS' : 'FAIL'}`,
      `Key shape: ${r.checks.keyShape ? 'ok' : 'FAIL'} · Round-trip: ${r.checks.roundTrip ? 'ok' : 'FAIL'} · Key-derive: ${r.checks.evmDerive ? 'ok' : 'FAIL'}`,
      'Scope: bot vault only. Worker-key equality: pending site-bridge vaultcheck (not proven by this check).',
      ...(r.error ? [`Detail: ${r.error}`] : []),
    ].join('\n'));
  },
};

// ══ DexScreener boost-lead stream (merged under the module cap) ════

const FEEDS = [
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-boosts/top/v1',
];
const CADENCE_MS = 60 * 60 * 1000; // hourly sampling
const MERGE_WINDOW_MS = 24 * 3600 * 1000; // repeat sightings within 24h update the row

/** Normalize one DexScreener boost entry into a lead row shape. */
export function leadFromBoostEntry(entry) {
  if (!entry?.tokenAddress || !entry?.chainId) return null;
  return {
    tokenAddress: String(entry.tokenAddress),
    chainId: String(entry.chainId),
    leadType: 'boost',
    boostAmount: entry.amount != null ? String(entry.amount) : null,
    totalAmount: entry.totalAmount != null ? String(entry.totalAmount) : null,
    description: entry.description ? String(entry.description).slice(0, 500) : null,
    url: entry.url ? String(entry.url).slice(0, 500) : null,
    icon: entry.icon ? String(entry.icon).slice(0, 500) : null,
    linksJson: entry.links ? JSON.stringify(entry.links).slice(0, 2000) : null,
  };
}

/** Upsert one observation: a row for the same (token, chain) seen within
 *  the merge window is updated (lastSeenAt, totals); otherwise a new row
 *  is inserted above the current max id. Returns 'inserted'|'updated'. */
export async function recordBoostObservation(lead, nowMs) {
  const existing = await db.select().from(dex_boost_leads)
    .where(and(eq(dex_boost_leads.tokenAddress, lead.tokenAddress), eq(dex_boost_leads.chainId, lead.chainId)))
    .orderBy(desc(dex_boost_leads.lastSeenAt)).limit(1).get().catch(() => null);
  if (existing && nowMs - (existing.lastSeenAt ?? 0) < MERGE_WINDOW_MS) {
    await db.update(dex_boost_leads).set({
      boostAmount: lead.boostAmount ?? existing.boostAmount,
      totalAmount: lead.totalAmount ?? existing.totalAmount,
      description: lead.description ?? existing.description,
      url: lead.url ?? existing.url,
      icon: lead.icon ?? existing.icon,
      linksJson: lead.linksJson ?? existing.linksJson,
      lastSeenAt: nowMs,
    }).where(eq(dex_boost_leads.id, existing.id)).run();
    return 'updated';
  }
  const maxRow = await db.get(sql`SELECT MAX(id) AS m FROM dex_boost_leads`).catch(() => null);
  const nextId = Number(maxRow?.m ?? 0) + 1;
  await db.insert(dex_boost_leads).values({
    id: nextId, ...lead, firstSeenAt: nowMs, lastSeenAt: nowMs,
  }).run();
  return 'inserted';
}

export async function cycleDexBoostStream(deps = {}) {
  // Hold (Rowdy 2026-11-07 "stop the leads" + DexScreener boost stream):
  // flag dex_stream_enabled — UNSET = ON, raid-flag pattern
  // (tick.js cycleRaidAutoTrack). Automatic runs stop when set and not
  // on; deps.force still runs.
  if (!deps.force) {
    const rawFlag = await getConfig('dex_stream_enabled', null);
    if (rawFlag != null && !flagValueOn(rawFlag)) return { skipped: 'flag_off' };
  }
  const now = deps.now ?? Date.now();
  const last = Number(await getConfig('dex_stream_last', '0').catch(() => 0));
  if (!deps.force && now - last < CADENCE_MS) return { skipped: 'cadence' };
  const fetchFn = deps.fetchFn ?? fetch;
  let inserted = 0, updated = 0, seen = 0;
  for (const url of FEEDS) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) continue;
      const entries = await res.json();
      if (!Array.isArray(entries)) continue;
      for (const entry of entries.slice(0, 100)) {
        const lead = leadFromBoostEntry(entry);
        if (!lead) continue;
        seen++;
        const r = await recordBoostObservation(lead, now);
        if (r === 'inserted') inserted++; else updated++;
      }
    } catch (err) {
      console.error('[dexStream]', url, err?.message ?? err);
    }
  }
  await setConfig('dex_stream_last', String(now)).catch(() => {});
  return { seen, inserted, updated };
}

// ═══════════════════════════════════════════════════════════════════════
// BOOSTER DEPGEN SYNC — the §8.5 channel, booster side (broadcaster wave).
//
// Reuses the airdrop deposit-gen bridge exactly: the host signer worker
// polls /api/internal/signer/depgen/push, generates a Solana keypair,
// vault-encrypts it (SIGNER_VAULT_KEY_HEX), self-checks
// (decrypt → derive address must match), and reports ciphertext + address
// only. The bridge stores campaign_id via String(), so boost string ids
// ('bc_…') flow through unchanged — NO bridge change was needed. The
// depgen/pull cursor is a TIMESTAMP watermark (results reported since
// cursor); each consumer tracks its OWN cursor, so the boost cursor
// ('boost_depgen_pull_cursor') is safe alongside airdrop's
// ('depgen_pull_cursor') — duplicates are idempotent at apply time.
// While the bridge route is undeployed, the poster errors and campaigns
// simply stay parked — fail-closed, same as §8.5.
// ═══════════════════════════════════════════════════════════════════════

const BOOST_DEPGEN_PULL_CURSOR_KEY = 'boost_depgen_pull_cursor';

/** Campaigns awaiting a host-generated Solana deposit wallet (sol only,
 *  wallet-less defensive). */
export async function assembleBoostDepositGenRequests() {
  const rows = await listBoostCampaignsByStatus('deposit_generating', 100);
  const requests = [];
  for (const c of rows) {
    if (c.chain !== 'sol' || c.depositAddress) continue;
    requests.push({ campaign_id: c.id, chain: 'sol' });
  }
  return requests;
}

export async function pushBoostDepositGenRequests({ poster }) {
  const requests = await assembleBoostDepositGenRequests();
  if (!requests.length) return { requested: 0 };
  const resp = await poster('/api/internal/signer/depgen/push', { requests });
  if (!resp || resp.ok !== true) {
    return { error: resp?.error ?? 'depgen_push_failed', requested: 0, waiting: requests.length };
  }
  return { requested: requests.length, queued: resp.queued ?? 0, requeued: resp.requeued ?? 0 };
}

/** Idempotent apply of one host depgen result. Only the
 *  'deposit_generating' + wallet-less state may transition; FIRST wallet
 *  only — a second result for the same campaign is a duplicate, never a
 *  replacement. Malformed results park the campaign (audit + owner alert)
 *  and 'failed' results park it for the next sync's retry. */
export async function applyBoostDepositGenResult(result) {
  const campaignId = String(result?.campaign_id ?? '');
  if (!campaignId) return { bad: 'campaign_id' };
  const campaign = await getBoostCampaign(campaignId);
  if (!campaign) return { missing: campaignId };
  if (campaign.status !== 'deposit_generating' || campaign.depositAddress) {
    return { duplicate: true };
  }
  const status = String(result?.status ?? '');
  if (status === 'generated') {
    const address = String(result.deposit_address ?? '');
    const encrypted = String(result.encrypted_pk ?? '');
    const parts = encrypted.split(':');
    const shapeOk = isValidSolAddress(address)
      && parts.length === 3 && parts.every((p) => /^[0-9a-fA-F]+$/.test(p));
    if (!shapeOk) {
      await auditMoney('boost', campaign.telegramUserId, 'deposit_gen_bad_result', `campaign=${campaignId}`);
      await alertOwner('boost', `🚨 Solana deposit generation returned a malformed result\nCampaign ${campaignId}. The campaign stays parked with NO deposit wallet — investigate the signer worker before retrying.`);
      return { bad: 'result_shape' };
    }
    await db.update(boost_campaigns).set({
      status: 'deposit_pending', depositAddress: address, encryptedDepositPk: encrypted,
    }).where(and(eq(boost_campaigns.id, campaignId), eq(boost_campaigns.status, 'deposit_generating'))).run();
    const after = await getBoostCampaign(campaignId);
    if (after?.status !== 'deposit_pending' || after?.depositAddress !== address) {
      return { skipped: 'lost_claim' };
    }
    await auditMoney('boost', campaign.telegramUserId, 'deposit_generated', `campaign=${campaignId} via=host_signer`);
    return { applied: 'generated', depositAddress: address };
  }
  if (status === 'failed') {
    await auditMoney('boost', campaign.telegramUserId, 'deposit_gen_failed',
      `campaign=${campaignId} error=${String(result.error ?? 'unknown').slice(0, 120)}`);
    await alertOwner('boost', `⚠️ Solana deposit wallet generation failed\nCampaign ${campaignId}: ${String(result.error ?? 'unknown').slice(0, 200)}\nThe campaign stays parked — generation retries automatically on the next sync.`);
    return { applied: 'failed' };
  }
  return { ignored: status };
}

export async function ingestBoostDepositGenResults({ getter }) {
  let cursor = Number(await getConfig(BOOST_DEPGEN_PULL_CURSOR_KEY, '0').catch(() => '0')) || 0;
  const counts = {};
  let applied = 0;
  for (let page = 0; page < 5; page++) {
    const data = await getter('/api/internal/signer/depgen/pull', { cursor });
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) break;
    for (const result of results) {
      try {
        // Status-routed (executor wave): deposit_generating → deposit
        // apply; planned/executing → farm apply. Routing by status
        // survives a bridge that strips purpose/wallet_index; results
        // for dead campaigns are ignored, never applied.
        const campaign = await getBoostCampaign(String(result?.campaign_id ?? ''));
        let r;
        if (!campaign) r = { missing: result?.campaign_id };
        else if (campaign.status === 'deposit_generating') r = await applyBoostDepositGenResult(result);
        else if (['planned', 'executing'].includes(campaign.status)) r = await applyBoostFarmGenResult(result);
        else r = { ignored: campaign.status };
        const key = r.applied ?? (r.duplicate ? 'duplicate' : r.missing ? 'missing' : r.bad ? 'bad' : 'other');
        counts[key] = (counts[key] ?? 0) + 1;
        if (r.applied) applied++;
      } catch (err) {
        console.error('[boostDepgenPull]', result?.campaign_id, err?.message ?? err);
        counts.error = (counts.error ?? 0) + 1;
      }
    }
    const next = Number(data?.cursor ?? cursor);
    if (Number.isFinite(next) && next !== cursor) {
      cursor = next;
      await setConfig(BOOST_DEPGEN_PULL_CURSOR_KEY, String(cursor)).catch(() => {});
    }
    if (results.length < 1000) break;
  }
  return { applied, counts, cursor };
}

/** One full boost depgen pass (failure-isolated thirds: deposit push,
 *  farm push, pull — like §8.5). */
export async function runBoostDepgenSync({ poster, getter }) {
  let depgenPush, farmPush, depgenPull;
  try { depgenPush = await pushBoostDepositGenRequests({ poster }); } catch (err) { depgenPush = { error: err?.message ?? 'unknown' }; }
  try { farmPush = await pushBoostFarmGenRequests({ poster }); } catch (err) { farmPush = { error: err?.message ?? 'unknown' }; }
  try { depgenPull = await ingestBoostDepositGenResults({ getter }); } catch (err) { depgenPull = { error: err?.message ?? 'unknown' }; }
  return { depgenPush, farmPush, depgenPull };
}

// ── Farm wallets (executor wave) ────────────────────────────────────────────
// The execution steps name farm wallets by index, but plans carry no
// addresses — binding happens here, at claim time, never earlier. Storage
// is a config array (boost_farm:<campaignId>), NOT the boost_wallets
// table: the table has no wallet-index column, and an array keeps slot
// order stable under partial / out-of-order generation (a Solana result
// landing for slot 1 before slot 0 must not shift slot 0's identity).
// EVM wallets generate in-isolate (generateEvmKeypair works there);
// Solana wallets come over the depgen bridge (the isolate has no
// Ed25519). Ciphertext format is the vault format on both paths, so the
// worker decrypts farm keys exactly like deposit keys. Plaintext keys
// exist only inside the generation call frame.
const BOOST_FARM_PREFIX = 'boost_farm:';

export async function loadBoostFarmWallets(campaignId) {
  try {
    const raw = await getConfig(`${BOOST_FARM_PREFIX}${campaignId}`, null);
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch { return null; }
}

async function saveBoostFarmWallets(campaignId, wallets) {
  await setConfig(`${BOOST_FARM_PREFIX}${campaignId}`, JSON.stringify(wallets)).catch(() => {});
}

function boostFarmWalletCount(campaign) {
  const params = planParameters({
    mode: campaign.mode, chain: campaign.chain,
    workingCapitalUsd: Number(campaign.workingCapitalUsd),
    bumpPackage: campaign.bumpPackage ?? undefined,
  });
  return params.wallets;
}

/** Ensure farm wallets exist for a campaign. EVM generates immediately;
 *  Solana waits on the depgen pass (waiting:true → the cycle reports
 *  liveHeld, never pushes unbound claims). */
export async function ensureBoostFarmWallets(campaign, deps = {}) {
  const count = boostFarmWalletCount(campaign);
  let wallets = (await loadBoostFarmWallets(campaign.id)) ?? [];
  while (wallets.length < count) wallets.push(null);
  const missing = wallets.map((w, i) => (w == null ? i : -1)).filter((i) => i >= 0);
  if (!missing.length) return { ready: true, wallets };
  if (campaign.chain !== 'sol') {
    try {
      for (const i of missing) {
        const kp = (deps.generateEvm ?? generateEvmKeypair)();
        const enc = await (deps.encrypt ?? vaultEncrypt)(kp.privateKey);
        wallets[i] = { address: kp.address, encrypted_pk: enc };
      }
      await saveBoostFarmWallets(campaign.id, wallets);
      return { ready: true, wallets };
    } catch (err) {
      return { ready: false, error: String(err?.message ?? err).slice(0, 200) };
    }
  }
  await saveBoostFarmWallets(campaign.id, wallets);
  return { ready: false, waiting: true, wallets };
}

/** Solana farm-wallet generation requests for planned/executing
 *  campaigns with missing slots. One request per missing slot. */
export async function assembleBoostFarmGenRequests() {
  const requests = [];
  for (const status of ['planned', 'executing']) {
    const rows = await listBoostCampaignsByStatus(status, 25);
    for (const c of rows) {
      if (c.chain !== 'sol') continue;
      const count = boostFarmWalletCount(c);
      const wallets = (await loadBoostFarmWallets(c.id)) ?? [];
      for (let i = 0; i < count; i++) {
        if (wallets[i] == null) requests.push({ campaign_id: c.id, chain: 'sol', purpose: 'farm', wallet_index: i });
      }
    }
  }
  return requests;
}

export async function pushBoostFarmGenRequests({ poster }) {
  const requests = await assembleBoostFarmGenRequests();
  if (!requests.length) return { requested: 0 };
  const resp = await poster('/api/internal/signer/depgen/push', { requests });
  if (!resp || resp.ok !== true) {
    return { error: resp?.error ?? 'depgen_push_failed', requested: 0, waiting: requests.length };
  }
  return { requested: requests.length, queued: resp.queued ?? 0, requeued: resp.requeued ?? 0 };
}

/** Idempotent apply of one host farm-wallet result. Slot order is by
 *  wallet_index when the bridge echoes it; when the bridge strips it,
 *  the lowest empty slot wins and an already-stored address is a
 *  duplicate, never a second wallet. A failed/malformed result leaves
 *  the slot empty so the next sync re-requests it — nothing is faked. */
export async function applyBoostFarmGenResult(result) {
  const campaignId = String(result?.campaign_id ?? '');
  if (!campaignId) return { bad: 'campaign_id' };
  const campaign = await getBoostCampaign(campaignId);
  if (!campaign) return { missing: campaignId };
  if (!['planned', 'executing'].includes(campaign.status)) return { ignored: campaign.status };
  const status = String(result?.status ?? '');
  if (status === 'failed') {
    await auditMoney('boost', campaign.telegramUserId, 'farm_gen_failed',
      `campaign=${campaignId} error=${String(result.error ?? 'unknown').slice(0, 120)}`);
    await alertOwner('boost', `⚠️ Solana farm wallet generation failed\nCampaign ${campaignId}: ${String(result.error ?? 'unknown').slice(0, 200)}\nThe slot stays empty — generation retries automatically on the next sync.`);
    return { applied: 'failed' };
  }
  if (status !== 'generated') return { ignored: status };
  const address = String(result.deposit_address ?? '');
  const encrypted = String(result.encrypted_pk ?? '');
  const parts = encrypted.split(':');
  const shapeOk = isValidSolAddress(address)
    && parts.length === 3 && parts.every((p) => /^[0-9a-fA-F]+$/.test(p));
  if (!shapeOk) {
    await auditMoney('boost', campaign.telegramUserId, 'farm_gen_bad_result', `campaign=${campaignId}`);
    await alertOwner('boost', `🚨 Solana farm generation returned a malformed result\nCampaign ${campaignId}. The slot stays empty — investigate the signer worker before retrying.`);
    return { bad: 'result_shape' };
  }
  const count = boostFarmWalletCount(campaign);
  const wallets = (await loadBoostFarmWallets(campaignId)) ?? [];
  while (wallets.length < count) wallets.push(null);
  if (wallets.some((w) => w?.address === address)) return { duplicate: true };
  let slot = -1;
  const want = Number(result.wallet_index);
  if (Number.isInteger(want) && want >= 0 && want < count && wallets[want] == null) slot = want;
  if (slot < 0) slot = wallets.findIndex((w) => w == null);
  if (slot < 0) return { duplicate: true };
  wallets[slot] = { address, encrypted_pk: encrypted };
  await saveBoostFarmWallets(campaignId, wallets);
  await auditMoney('boost', campaign.telegramUserId, 'farm_generated', `campaign=${campaignId} slot=${slot}`);
  return { applied: 'farm_generated', wallet_index: slot };
}

// ═══════════════════════════════════════════════════════════════════════
// EXECUTION BROADCASTER — orchestration only (broadcaster wave).
//
// What this section does: derive execution steps from the persisted plan
// (independently of planJson, so shadow verification is a real check),
// verify the plan digest, re-check caps at execution time, prove the
// campaign in shadow, bind farm wallets, assemble claims for the worker
// executor, push them in waves, and apply worker outcomes. What it does
// NOT do: sign, swap, or broadcast anything — that is the worker's job.
// The worker executor (executor wave) builds native transfers, Uniswap
// V3 swaps (Base + Robinhood Chain, router/WETH from worker env), and
// Jupiter swaps (Solana), gated per kind (booster only — airdrop stays
// dry-run). Live submission is gated OFF by isBoostExecutorCapable()
// until Rowdy's live call: while the flag is off, campaigns stay
// 'planned' and the cycle reports liveHeld — an honest, fail-closed
// hold, not a silent one.
//
// Wave discipline: claims push in ordered waves (fee sweep → funding →
// one cycle per tick → settlement). A wave pushes only when every prior
// wave is CONFIRMED; a submitted-but-unconfirmed wave blocks the next
// one (the tick cadence itself provides the delay between cycles). A
// failed/refused outcome parks the campaign at reconciliation_required
// and is NEVER auto-retried (ambiguous outcomes mirror the airdrop
// recovery model: reconcile against the chain first).
//
// Claim contract (executor wave): { broadcast, caps, intent: {
// intent_id, idempotency_key (both = the step key, stable across
// re-derivation), kind: 'boost_fee_sweep' | 'boost_funding' |
// 'boost_buy' | 'boost_sell' | 'boost_settle', chain, campaign_id,
// key_class: 'deposit' (master class is NEVER assembled), fee_status:
// 'paid', gas_ceiling_wei: null (bot-side reserve math bounds it in v1),
// wallet_index, cycle, leg, from, to, token, amount_native,
// amount_usd_estimate, deposit: { address, encrypted_pk },
// swap?: { direction, fee_tier, slippage_bps } (buy/sell only) } }.
// Farm-wallet addresses bind at claim time: fee sweep sends deposit →
// master, funding sends deposit → farm, buys/sells send farm → router,
// settlement sends farm → refund. The signing wallet (deposit) is ALWAYS
// the claimed sender (from); a claim with a null address is refused by
// the push validator here AND by the executor — never signed blind.
// ═══════════════════════════════════════════════════════════════════════

export const BOOST_EXECUTOR_FLAG = 'boost_executor_v1';
export const BOOST_SHADOW_PREFIX = 'boost_shadow:';
export const BOOST_EXEC_PREFIX = 'boost_exec:';
/** Ingest-reconcile wave (2026-10-30, audit finding 2b): per-campaign
 *  park snapshot of the execution-pull cursor. When a campaign parks,
 *  the persisted cursor at that moment is recorded (first park wins —
 *  keep-earliest, so a re-park before any cycle runs cannot lose the
 *  first park's recovery window). On unpark the cursor rewinds to the
 *  snapshot, so the next ingest re-pulls the outcomes that were
 *  consumed as duplicates while parked and applies them now that the
 *  campaign runs again. Re-pulled outcomes for other campaigns are
 *  idempotent (already-confirmed steps return duplicate). An empty
 *  value means absent (no delete helper exists in config.js). */
export const BOOST_PARK_CURSOR_PREFIX = 'boost_exec_park_cursor:';

/** Record the park snapshot if none exists yet. Returns the snapshot
 *  in force afterwards ({ snapshot } or { kept }). At park time inside
 *  ingest the persisted cursor is the pre-page cursor, which precedes
 *  the whole batch containing the park-triggering outcome — exactly
 *  the rewind point the unpark needs. */
async function snapshotBoostParkCursor(campaignId) {
  const key = `${BOOST_PARK_CURSOR_PREFIX}${campaignId}`;
  try {
    const existing = await getConfig(key, null);
    if (existing !== null && existing !== undefined && existing !== '') return { kept: String(existing) };
    const cursor = await getConfig(BOOST_EXEC_PULL_CURSOR_KEY, '0').catch(() => '0');
    await setConfig(key, String(cursor ?? '0')).catch(() => {});
    return { snapshot: String(cursor ?? '0') };
  } catch { return { error: 'snapshot_failed' }; }
}

/** Rewind the execution-pull cursor to a campaign's park snapshot and
 *  clear the snapshot — the cycle's auto-rewind (see cycleBoostBroadcast)
 *  uses this so a rewind is applied exactly once per park episode.
 *  Returns { rewound, from, to }. */
async function rewindBoostExecCursor(campaignId) {
  const key = `${BOOST_PARK_CURSOR_PREFIX}${campaignId}`;
  const snapshot = await getConfig(key, null).catch(() => null);
  if (snapshot === null || snapshot === undefined || snapshot === '') return { rewound: false, reason: 'no snapshot' };
  const current = Number(await getConfig(BOOST_EXEC_PULL_CURSOR_KEY, '0').catch(() => '0')) || 0;
  let rewound = false;
  if (Number(snapshot) < current) {
    await setConfig(BOOST_EXEC_PULL_CURSOR_KEY, String(snapshot)).catch(() => {});
    rewound = true;
  }
  await setConfig(key, '').catch(() => {});
  return { rewound, from: String(snapshot), to: current };
}

/** Owner/operator unpark with ingest reconciliation (audit finding 2b).
 *  Replaces the canary's raw transitionBoost CAS: a bare CAS moves the
 *  status but leaves bot progress stale, which is exactly how sells
 *  3–9 wedged after the cycle-5 unpark. This function rewinds the
 *  pull cursor to the park snapshot FIRST so the next ingest re-pulls
 *  and applies the outcomes consumed while parked, then moves the
 *  campaign to 'executing' — or to 'completed' when every step is
 *  already confirmed (a campaign repaired while parked must not sit
 *  'executing' forever behind an empty wave). No snapshot (parked
 *  before this fix shipped): the transition still happens — refusing
 *  would strand the campaign — but rewound is false and the operator
 *  must check progress by hand. Sends nothing, moves no funds; call
 *  it from a run-only temp endpoint, the same way the CAS was run. */
export async function unparkBoostCampaign(campaignId) {
  const campaign = await getBoostCampaign(campaignId);
  if (!campaign) return { error: 'Campaign not found.' };
  if (campaign.status !== 'reconciliation_required') return { ok: false, reason: `not parked (status ${campaign.status})` };
  const key = `${BOOST_PARK_CURSOR_PREFIX}${campaignId}`;
  const snapshot = await getConfig(key, null).catch(() => null);
  const current = Number(await getConfig(BOOST_EXEC_PULL_CURSOR_KEY, '0').catch(() => '0')) || 0;
  let rewound = false;
  let rewindNote = 'no snapshot (parked before the reconcile fix, or snapshot lost); check progress by hand after unpark';
  if (snapshot !== null && snapshot !== undefined && snapshot !== '') {
    if (Number(snapshot) < current) {
      await setConfig(BOOST_EXEC_PULL_CURSOR_KEY, String(snapshot)).catch(() => {});
      rewound = true;
      rewindNote = `cursor ${current} -> ${snapshot}; next ingest re-pulls outcomes consumed while parked`;
      // Snapshot deliberately KEPT here (not cleared): if a tick ingest
      // is running concurrently it holds its own cursor and can
      // overwrite this rewind at page end. The cycle's auto-rewind
      // re-applies it from the kept snapshot and clears it then.
    } else {
      await setConfig(key, '').catch(() => {});
      rewound = false;
      rewindNote = 'snapshot already at cursor; nothing to rewind';
    }
  }
  const progress = await loadBoostExecProgress(campaignId);
  const steps = buildBoostExecutionSteps(campaign);
  const allConfirmed = steps.length > 0 && steps.every((s) => progress.steps?.[s.key]?.status === 'confirmed');
  const target = allConfirmed ? 'completed' : 'executing';
  const moved = await transitionBoost(campaignId, 'reconciliation_required', target, {});
  if (!moved) return { ok: false, reason: 'transition failed' };
  if (target === 'completed') await setConfig(key, '').catch(() => {});
  await auditMoney('boost', campaign.telegramUserId, 'execution_unparked', `campaign=${campaignId} target=${target} rewound=${rewound} ${rewindNote}`).catch(() => {});
  return { ok: true, campaignId, target, rewound, rewindNote };
}
export const BOOST_EXEC_PULL_CURSOR_KEY = 'boost_signer_pull_cursor';

/** Executor capability: the executor wave built the swap + native
 *  builders and the farm-wallet binding, but the flag stays '0' until
 *  Rowdy's live call — setting boost_executor_v1 = '1' is what opens
 *  claim pushing (the worker's own broadcast + mainnet env gates still
 *  apply on top). While '0', every planned campaign reports liveHeld. */
export async function isBoostExecutorCapable() {
  try { return String(await getConfig(BOOST_EXECUTOR_FLAG, '')).trim() === '1'; }
  catch { return false; }
}

const BOOST_OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Per-chain explicit close. The global boost arm governs all supported
 *  chains (Rowdy's fully-automatic directive); a per-chain flag set to an
 *  explicit OFF value closes that chain. ABSENT flags do NOT close — no
 *  owner command sets them, so absent-must-close would deadlock the
 *  product forever. This is a kill-switch layer, not an approval layer:
 *  Rowdy can close any chain via /setkey boost_chain_<chain>_enabled 0.
 *  A config read failure closes the chain (fail-closed). */
async function boostChainExplicitlyClosed(chain) {
  try {
    for (const kind of ['enabled', 'arm']) {
      const v = await getConfig(`boost_chain_${chain}_${kind}`, null);
      if (v != null && BOOST_OFF_VALUES.has(String(v).trim().toLowerCase())) return true;
    }
    return false;
  } catch { return true; }
}

/** The live-broadcast signal for a chain: global arm ON, supported chain,
 *  and not explicitly closed per chain. */
export async function boostBroadcastSignal(chain) {
  if (!(await isBoostEnabled()) || !(await isBoostArmed())) return false;
  if (!isBoosterChain(chain)) return false;
  return !(await boostChainExplicitlyClosed(chain));
}

/** Stable step identity: same inputs → same key, so re-derivation,
 *  progress records, and worker idempotency all agree. */
export function boostStepKey(campaignId, kind, walletIndex, cycle, leg) {
  return `${campaignId}:step:${kind}:${walletIndex}:${cycle}:${leg}`;
}

/** Derive the execution steps for a campaign from its columns + the
 *  deterministic plan model — NOT from planJson. Independent derivation
 *  is what makes shadow verification a real check rather than a re-read. */
export function buildBoostExecutionSteps(campaign) {
  const input = {
    mode: campaign.mode, chain: campaign.chain,
    workingCapitalUsd: Number(campaign.workingCapitalUsd),
    bumpPackage: campaign.bumpPackage ?? undefined,
  };
  const params = planParameters(input);
  const W = params.wallets;
  const steps = [];
  // 0. Fee sweep: platform fee from the deposit wallet to the master
  // (revenue collection, per the persisted plan).
  steps.push({
    key: boostStepKey(campaign.id, 'fee_sweep', -1, -1, -1),
    kind: 'fee_sweep', walletIndex: -1, cycle: -1, leg: -1,
    from: campaign.depositAddress, to: 'master',
    amountNative: String(campaign.platformFeeNative ?? '0'),
    usdEstimate: Number(campaign.platformFeeUsd ?? 0),
  });
  // 1. Funding: per-wallet capital + gas share. Both splits use the
  // plan's own rule (decDivInt); the last wallet absorbs BOTH remainders
  // so funding sums EXACTLY to working capital + reserve.
  const capPer = decDivInt(String(campaign.workingCapitalNative ?? '0'), W);
  const gasPer = decDivInt(String(campaign.networkReserveNative ?? '0'), W);
  const capRem = decSub(String(campaign.workingCapitalNative ?? '0'), decMulInt(capPer, W));
  const gasRem = decSub(String(campaign.networkReserveNative ?? '0'), decMulInt(gasPer, W));
  // USD mirror of the same split (2026-10-28 funding-refusal fix):
  // the worker's boost deviation gate compares the claim's USD estimate
  // against its own live-price value and REFUSES a null/0 estimate
  // (price_mismatch: claimed 0 vs actual ~0.60 killed the canary's whole
  // funding wave). The estimate is the plan-time USD share, same split
  // rule, last wallet absorbing both USD remainders — live-price drift
  // between plan and execution sits inside the worker's 25% tolerance.
  const capUsdPer = decDivInt(String(campaign.workingCapitalUsd ?? '0'), W);
  const gasUsdPer = decDivInt(String(campaign.networkReserveUsd ?? '0'), W);
  const capUsdRem = decSub(String(campaign.workingCapitalUsd ?? '0'), decMulInt(capUsdPer, W));
  const gasUsdRem = decSub(String(campaign.networkReserveUsd ?? '0'), decMulInt(gasUsdPer, W));
  for (let i = 0; i < W; i++) {
    const last = i === W - 1;
    const amount = decAdd(decAdd(capPer, gasPer), last ? decAdd(capRem, gasRem) : '0');
    const usdEstimate = Number(decAdd(decAdd(capUsdPer, gasUsdPer), last ? decAdd(capUsdRem, gasUsdRem) : '0'));
    steps.push({
      key: boostStepKey(campaign.id, 'funding', i, -1, -1),
      kind: 'funding', walletIndex: i, cycle: -1, leg: -1,
      from: campaign.depositAddress, to: null, // farm wallet address: bound by the executor wave at generation time
      amountNative: amount, usdEstimate,
    });
  }
  // 2. Cycles: buys then sells per wallet per cycle. Amounts are USD
  // notionals (token amounts price at execution); the executor converts.
  const perWalletUsd = Number(campaign.workingCapitalUsd ?? 0) / W;
  const perCycleUsd = perWalletUsd / params.cycles;
  for (let i = 0; i < W; i++) {
    for (let c = 0; c < params.cycles; c++) {
      for (let leg = 0; leg < params.buysPerCycle; leg++) {
        steps.push({ key: boostStepKey(campaign.id, 'buy', i, c, leg), kind: 'buy', walletIndex: i, cycle: c, leg, from: null, to: null, amountNative: null, usdEstimate: perCycleUsd / Math.max(1, params.buysPerCycle) });
      }
      for (let leg = 0; leg < params.sellsPerCycle; leg++) {
        steps.push({ key: boostStepKey(campaign.id, 'sell', i, c, leg), kind: 'sell', walletIndex: i, cycle: c, leg, from: null, to: null, amountNative: null, usdEstimate: perCycleUsd / Math.max(1, params.sellsPerCycle) });
      }
    }
  }
  // 3. Settlement: per wallet, whatever remains → refund address.
  for (let i = 0; i < W; i++) {
    steps.push({
      key: boostStepKey(campaign.id, 'settle', i, -1, -1),
      kind: 'settle', walletIndex: i, cycle: -1, leg: -1,
      from: null, to: campaign.refundAddress, amountNative: null, usdEstimate: null,
    });
  }
  return steps;
}

/** Recompute the stored plan digest from planJson minus digest + caps.
 *  Matches planBoostCampaign's construction: it hashes
 *  JSON.stringify({...plan, digest: undefined}) — JSON.stringify drops
 *  undefined, so the hashed string is the plan object without digest. */
export async function verifyBoostPlanDigest(campaign) {
  try {
    const stored = JSON.parse(campaign.planJson ?? 'null');
    if (!stored || typeof stored.digest !== 'string') return { ok: false, reason: 'no plan digest' };
    // Gate metadata (caps, capital) is deliberately NOT digest-covered:
    // the gates recompute from live db + config at execution, never from
    // these stored values, so excluding them keeps the digest over the
    // plan itself. Forgetting a new metadata key here breaks every newly
    // planned campaign at execution (digest mismatch → parked).
    const { digest, caps, capital, ...rest } = stored;
    const recomputed = await sha256Hex(JSON.stringify(rest));
    return recomputed === digest ? { ok: true } : { ok: false, reason: 'plan digest mismatch' };
  } catch { return { ok: false, reason: 'plan unparsable' }; }
}

/** Execution-time cap re-check. Per-send: plan-level per-wallet capital
 *  vs the CURRENT max-send cap (guards against cap tightening since
 *  planning). Daily: plannedUsdToday('boost') vs the CURRENT daily cap —
 *  NO double count, because this campaign's plan_created row is already
 *  inside the booked total (written at plan time). */
export async function executionCapCheck(campaign) {
  const params = planParameters({
    mode: campaign.mode, chain: campaign.chain,
    workingCapitalUsd: Number(campaign.workingCapitalUsd),
    bumpPackage: campaign.bumpPackage ?? undefined,
  });
  const perSendUsd = Number(campaign.workingCapitalUsd ?? 0) / Math.max(1, params.wallets);
  const maxSend = await maxSendUsd();
  if (perSendUsd > maxSend) return { ok: false, reason: `per-send cap: $${perSendUsd} exceeds $${maxSend}` };
  const daily = await dailyCapUsd();
  const booked = await plannedUsdToday('boost');
  if (booked > daily) return { ok: false, reason: `daily cap: $${booked} booked today exceeds $${daily}` };
  // Capital re-check at execution (Gate 2): the campaign itself is in the
  // live set, so it is excluded from the active sum and added back.
  const capital = await checkCapitalBoost(Number(campaign.workingCapitalUsd), campaign.id);
  if (!capital.ok) return { ok: false, reason: capital.reason };
  return { ok: true };
}

// ── Capital cap (booster go-live Gate 2) ────────────────────────────────────
// The $500 boost capital ceiling (boost_max_capital_usd) was a wizard note
// only: neither the plan gate nor the execution gate summed working
// capital, so a $1,000-capital campaign passed every check. It is now a
// hard gate at BOTH points. Committed capital = working capital of
// campaigns in 'planned', 'executing', or 'awaiting_arm': an awaiting_arm
// campaign holds a funded deposit and will execute without another cap
// check when armed, so it counts now; 'funded' (not yet planned) and
// terminal states do not.
const BOOST_CAPITAL_STATUSES = ['planned', 'executing', 'awaiting_arm'];

export async function activeBoostCapitalUsd(excludeId = null) {
  const rows = await db.select().from(boost_campaigns).all();
  let sum = 0;
  for (const r of rows) {
    if (!BOOST_CAPITAL_STATUSES.includes(r.status)) continue;
    if (excludeId != null && r.id === excludeId) continue;
    const v = Number(r.workingCapitalUsd ?? 0);
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}

export async function checkCapitalBoost(campaignCapitalUsd, excludeId = null) {
  const cap = await maxBoostCapitalUsd();
  const active = await activeBoostCapitalUsd(excludeId);
  const capital = Number(campaignCapitalUsd ?? 0);
  if (!Number.isFinite(capital) || capital <= 0) {
    return { ok: false, reason: 'capital: working capital missing or not positive', active, cap };
  }
  if (capital > cap) {
    return { ok: false, reason: `capital cap: campaign $${capital} exceeds $${cap}`, active, cap };
  }
  if (active + capital > cap) {
    return { ok: false, reason: `capital cap: $${active} active + $${capital} exceeds $${cap}`, active, cap };
  }
  return { ok: true, active, cap };
}

/** Shadow proof: digest + plan shape + derived steps + caps, with ZERO
 *  broadcasts — this function takes no poster and performs no HTTP, so
 *  a shadow pass cannot send anything by construction. The harness
 *  asserts exactly that (no poster calls). */
export async function shadowVerifyBoostCampaign(campaign) {
  let plan;
  try { plan = JSON.parse(campaign.planJson ?? 'null'); } catch { return { verified: false, reason: 'plan unparsable' }; }
  if (!plan) return { verified: false, reason: 'no plan' };
  const d = await verifyBoostPlanDigest(campaign);
  if (!d.ok) return { verified: false, reason: d.reason };
  const input = {
    mode: campaign.mode, chain: campaign.chain,
    workingCapitalUsd: Number(campaign.workingCapitalUsd),
    bumpPackage: campaign.bumpPackage ?? undefined,
  };
  const params = planParameters(input);
  const wallets = Array.isArray(plan.wallets) ? plan.wallets : [];
  if (wallets.length !== params.wallets) {
    return { verified: false, reason: `wallet count ${wallets.length} != ${params.wallets}` };
  }
  for (const w of wallets) {
    if (w.cycles !== params.cycles || w.buysPerCycle !== params.buysPerCycle || w.sellsPerCycle !== params.sellsPerCycle) {
      return { verified: false, reason: `wallet ${w.index} cycle shape mismatch` };
    }
    if (w.capitalNative !== decDivInt(String(campaign.workingCapitalNative ?? '0'), params.wallets)) {
      return { verified: false, reason: `wallet ${w.index} capital split mismatch` };
    }
  }
  if (String(plan.feeSweep?.amountNative ?? '') !== String(campaign.platformFeeNative ?? '')) {
    return { verified: false, reason: 'fee sweep amount mismatch' };
  }
  const steps = buildBoostExecutionSteps(campaign);
  const funding = steps.filter((s) => s.kind === 'funding');
  const fundingSum = decSum(funding.map((s) => s.amountNative));
  const expectedFunding = decAdd(String(campaign.workingCapitalNative ?? '0'), String(campaign.networkReserveNative ?? '0'));
  if (decCmp(fundingSum, expectedFunding) !== 0) {
    return { verified: false, reason: `funding sum ${fundingSum} != ${expectedFunding}` };
  }
  const buys = steps.filter((s) => s.kind === 'buy').length;
  const sells = steps.filter((s) => s.kind === 'sell').length;
  if (buys !== params.wallets * params.cycles * params.buysPerCycle) return { verified: false, reason: 'buy count mismatch' };
  if (sells !== params.wallets * params.cycles * params.sellsPerCycle) return { verified: false, reason: 'sell count mismatch' };
  const caps = await executionCapCheck(campaign);
  if (!caps.ok) return { verified: false, reason: caps.reason };
  return { verified: true, steps: steps.length };
}

/** Claim assembly (executor wave): binds farm wallets and per-step
 *  signing keys. Throws when farm wallets are incomplete — the cycle
 *  guarantees readiness first, so an incomplete binding here is a bug,
 *  never a push of null-address claims. */
export async function assembleBoostExecutionClaims(campaign, steps) {
  const broadcast = await boostBroadcastSignal(campaign.chain);
  const caps = {
    max_send_usd: await maxSendUsd(),
    daily_cap_usd: await dailyCapUsd(),
    daily_spent_usd: await plannedUsdToday('boost'),
    capital_cap_usd: await maxBoostCapitalUsd(),
    capital_active_usd: await activeBoostCapitalUsd(campaign.id),
  };
  const count = boostFarmWalletCount(campaign);
  // Farm wallets are required only by steps that spend from them
  // (funding/buy/sell/settle). A fee-sweep-only assembly — the shape the
  // broadcaster harness builds — needs no farm wallet and must not
  // throw; any farm step with an incomplete binding still throws.
  const needsFarm = steps.some((s) => s.kind !== 'fee_sweep');
  let farm = [];
  if (needsFarm) {
    farm = (await loadBoostFarmWallets(campaign.id)) ?? [];
    if (farm.length < count || farm.some((w, i) => i < count && w == null)) {
      throw new Error('farm wallets incomplete');
    }
  }
  const depositKey = { address: campaign.depositAddress, encrypted_pk: campaign.encryptedDepositPk };
  const settleCeiling = (Number(campaign.workingCapitalUsd) + Number(campaign.networkReserveUsd)) / Math.max(1, count);
  return steps.map((s) => {
    let from;
    let to;
    let token;
    let amount_native;
    let amount_usd_estimate;
    let deposit;
    let swap;
    if (s.kind === 'fee_sweep') {
      from = campaign.depositAddress; to = MASTER_WALLET_ADDRESS; token = null;
      amount_native = s.amountNative; amount_usd_estimate = s.usdEstimate; deposit = depositKey;
    } else if (s.kind === 'funding') {
      from = campaign.depositAddress; to = farm[s.walletIndex].address; token = null;
      amount_native = s.amountNative; amount_usd_estimate = s.usdEstimate; deposit = depositKey;
    } else if (s.kind === 'buy' || s.kind === 'sell') {
      from = farm[s.walletIndex].address; to = 'router'; token = campaign.tokenCa;
      amount_native = null; amount_usd_estimate = s.usdEstimate;
      deposit = { address: farm[s.walletIndex].address, encrypted_pk: farm[s.walletIndex].encrypted_pk };
      swap = { direction: s.kind, fee_tier: 3000, slippage_bps: 100 };
    } else if (s.kind === 'settle') {
      from = farm[s.walletIndex].address; to = campaign.refundAddress; token = null;
      amount_native = null; amount_usd_estimate = settleCeiling; deposit = { address: farm[s.walletIndex].address, encrypted_pk: farm[s.walletIndex].encrypted_pk };
    } else {
      throw new Error(`unknown step kind ${s.kind}`);
    }
    return {
      broadcast,
      caps,
      intent: {
        intent_id: s.key,
        idempotency_key: s.key,
        kind: `boost_${s.kind}`,
        chain: campaign.chain,
        campaign_id: campaign.id,
        campaign_capital_usd: Number(campaign.workingCapitalUsd),
        key_class: 'deposit',
        fee_status: 'paid',
        gas_ceiling_wei: null,
        wallet_index: s.walletIndex,
        cycle: s.cycle,
        leg: s.leg,
        from,
        to,
        token,
        amount_native,
        amount_usd_estimate,
        deposit,
        ...(swap ? { swap } : {}),
      },
    };
  });
}

export async function pushBoostExecutionClaims({ poster }, claims) {
  // Defense in depth: a claim with an unbound address or key never
  // reaches the bridge, even if assembly regressed.
  for (const c of claims) {
    const intent = c?.intent ?? {};
    if (intent.from == null || intent.to == null
        || intent.deposit?.address == null || intent.deposit?.encrypted_pk == null) {
      return { error: 'unbound_claim', pushed: 0 };
    }
  }
  const CHUNK = 25;
  let pushed = 0;
  for (let i = 0; i < claims.length; i += CHUNK) {
    const chunk = claims.slice(i, i + CHUNK);
    const resp = await poster('/api/internal/signer/push', { intents: chunk });
    if (!resp || resp.ok !== true) {
      return { error: resp?.error ?? 'push_failed', pushed };
    }
    pushed += chunk.length;
  }
  return { pushed };
}

async function loadBoostExecProgress(id) {
  try { return JSON.parse(await getConfig(`${BOOST_EXEC_PREFIX}${id}`, '{}')) ?? {}; }
  catch { return {}; }
}
async function saveBoostExecProgress(id, progress) {
  await setConfig(`${BOOST_EXEC_PREFIX}${id}`, JSON.stringify(progress)).catch(() => {});
}

/** NO-GO fix 2 (2026-10-26): dry-run unstick constants. A submitted
 *  step with no outcome for longer than the submit timeout is stale
 *  and re-pushable (worker idempotency — intent_id = step key — makes
 *  a re-push a duplicate, never a double send). A dry-run step cools
 *  down before it re-pushes, so a dry-run worker is simulated once
 *  per cooldown, not once per tick. Both bounds are wall-clock, so a
 *  campaign wedged while the executor was incapable unsticks on the
 *  first capable cycle after the bound passes — never forever. */
export const BOOST_EXEC_SUBMIT_TIMEOUT_MS = 30 * 60 * 1000;
export const BOOST_EXEC_DRYRUN_COOLDOWN_MS = 15 * 60 * 1000;

/** The next pushable wave for a campaign, given its progress record.
 *  Ordered phases: fee sweep → funding → one cycle per tick →
 *  settlement. A phase whose steps are all confirmed is skipped; a phase
 *  with any live submitted step blocks (awaiting outcomes); otherwise
 *  the phase's pushable steps are the wave. Empty = nothing to push
 *  this tick (all confirmed, or awaiting outcomes).
 *  NO-GO fix 2: 'submitted' counts as blocking ONLY while fresh
 *  (submittedAt within the timeout, or — for pre-fix records that never
 *  stamped one — treated as stale, so legacy wedges unstick via one
 *  idempotent re-push); 'dry_run' blocks only inside its cooldown and
 *  is pushable once the cooldown passes. opts: { now, timeoutMs,
 *  dryRunCooldownMs } — all injectable in harness. */
export function nextBoostWave(steps, progress, opts = {}) {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? BOOST_EXEC_SUBMIT_TIMEOUT_MS;
  const cooldownMs = opts.dryRunCooldownMs ?? BOOST_EXEC_DRYRUN_COOLDOWN_MS;
  const rec = (k) => progress.steps?.[k] ?? {};
  const st = (k) => (rec(k).status ?? 'pending');
  const pushable = (s) => {
    const r = rec(s.key);
    if (r.status === 'pending' || r.status === undefined) return true;
    if (r.status === 'confirmed') return false;
    if (r.status === 'submitted') {
      // Fresh submitted blocks; stale (or unstamped legacy) re-pushes.
      if (r.submittedAt == null) return true;
      return now - r.submittedAt > timeoutMs;
    }
    if (r.status === 'dry_run') {
      if (r.dryRunAt == null) return true;
      return now - r.dryRunAt > cooldownMs;
    }
    return false; // 'failed' parks the campaign; never re-pushed here
  };
  const blocking = (s) => {
    const r = rec(s.key);
    if (r.status === 'submitted') {
      if (r.submittedAt == null) return false;
      return now - r.submittedAt <= timeoutMs;
    }
    if (r.status === 'dry_run') {
      if (r.dryRunAt == null) return false;
      return now - r.dryRunAt <= cooldownMs;
    }
    return false;
  };
  const phases = [
    steps.filter((s) => s.kind === 'fee_sweep'),
    steps.filter((s) => s.kind === 'funding'),
    ...Array.from(new Set(steps.filter((s) => s.kind === 'buy' || s.kind === 'sell').map((s) => s.cycle)))
      .sort((a, b) => a - b)
      .map((cycle) => steps.filter((s) => (s.kind === 'buy' || s.kind === 'sell') && s.cycle === cycle)),
    steps.filter((s) => s.kind === 'settle'),
  ];
  for (const phase of phases) {
    if (!phase.length) continue;
    if (phase.every((s) => st(s.key) === 'confirmed')) continue;
    if (phase.some(blocking)) return [];
    return phase.filter(pushable);
  }
  return [];
}

/** Apply one worker outcome to a boost campaign. Boost outcomes only
 *  (campaign_id 'bc_…' — airdrop outcomes carry numeric ids and belong
 *  to that channel). Confirmed steps advance the wave machine; a
 *  failed/refused step parks the campaign at reconciliation_required and
 *  is NEVER auto-retried. All steps confirmed → completed. */
export async function applyBoostExecutionOutcome(outcome, deps = {}) {
  const campaignId = String(outcome?.campaign_id ?? '');
  const stepKey = String(outcome?.intent_id ?? '');
  if (!campaignId.startsWith('bc_') || !stepKey.startsWith(`${campaignId}:step:`)) return { ignored: true };
  const campaign = await getBoostCampaign(campaignId);
  if (!campaign) return { missing: campaignId };
  // 'stopped' is terminal for NEW waves (the cycle lists only
  // planned/executing) but in-flight submitted waves must still settle
  // their progress records — a stop must not orphan them.
  if (!['executing', 'planned', 'stopped'].includes(campaign.status)) {
    // Ingest-reconcile wave (2b): a parked campaign's outcomes are a
    // distinct 'parked' skip, not a generic duplicate — and the park
    // snapshot is recorded (keep-earliest) so the unpark can rewind
    // the cursor back over them. Other non-running statuses keep the
    // old duplicate return.
    if (campaign.status === 'reconciliation_required') {
      await snapshotBoostParkCursor(campaignId);
      return { parked: campaignId };
    }
    return { duplicate: true };
  }
  const progress = await loadBoostExecProgress(campaignId);
  const steps = progress.steps ?? {};
  const now = deps.now ?? Date.now();
  const status = String(outcome?.status ?? '').replace(/-/g, '_');
  // NO-GO fix 2: the dry-run wedge. The old code fell through to
  // { ignored: status } for dry_run outcomes, leaving the step
  // 'submitted' forever — nextBoostWave then blocked every later
  // phase forever, even after the worker went live again. A dry-run
  // outcome now records 'dry_run' (counted, timestamped) and the wave
  // machine treats it as re-pushable after its cooldown: simulated,
  // never confirmed, never completed, never wedged.
  if (status === 'dry_run') {
    const prev = steps[stepKey] ?? {};
    steps[stepKey] = { status: 'dry_run', dryRunAt: now, dryRunCount: (prev.dryRunCount ?? 0) + 1 };
    progress.steps = steps;
    await saveBoostExecProgress(campaignId, progress);
    await auditMoney('boost', campaign.telegramUserId, 'execution_dry_run', `campaign=${campaignId} step=${stepKey} count=${steps[stepKey].dryRunCount}`);
    return { applied: 'dry_run', stepKey };
  }
  // Worker acknowledgement of receipt: refresh the submitted stamp so
  // the timeout clock runs from the last proof the worker is alive.
  if (status === 'submitted') {
    steps[stepKey] = { status: 'submitted', submittedAt: now };
    progress.steps = steps;
    await saveBoostExecProgress(campaignId, progress);
    return { applied: 'submitted', stepKey };
  }
  if (status === 'confirmed' || status === 'already_executed') {
    if (steps[stepKey]?.status === 'confirmed') return { duplicate: true };
    steps[stepKey] = { status: 'confirmed', txHash: outcome.tx_hash ?? outcome.txHash ?? null };
    progress.steps = steps;
    await saveBoostExecProgress(campaignId, progress);
    const all = buildBoostExecutionSteps(campaign);
    const done = all.every((s) => steps[s.key]?.status === 'confirmed');
    // A stopped campaign stays stopped even when its in-flight waves
    // all confirm — the stop signal is not overwritten by settlement.
    if (done && campaign.status !== 'completed' && campaign.status !== 'stopped') {
      await transitionBoost(campaignId, campaign.status, 'completed', {});
      await auditMoney('boost', campaign.telegramUserId, 'execution_completed', `campaign=${campaignId}`);
    }
    return { applied: 'confirmed', stepKey };
  }
  if (status === 'failed' || status === 'refused' || status.startsWith('refused')) {
    steps[stepKey] = { status: 'failed', error: String(outcome.error ?? outcome.reason ?? 'unknown').slice(0, 200) };
    progress.steps = steps;
    await saveBoostExecProgress(campaignId, progress);
    if (campaign.status !== 'reconciliation_required' && campaign.status !== 'stopped') {
      // Ingest-reconcile wave (2b): snapshot the cursor BEFORE the
      // transition, so the unpark rewinds over this batch.
      await snapshotBoostParkCursor(campaignId);
      await transitionBoost(campaignId, campaign.status, 'reconciliation_required', { error: `step ${stepKey} ${status}` });
      await alertOwner('boost', `🛠️ Boost execution needs review\nCampaign ${campaignId}: step ${stepKey} ${status}. It will NOT be re-sent automatically — reconcile against the chain first.`);
      await auditMoney('boost', campaign.telegramUserId, 'execution_step_failed', `campaign=${campaignId} step=${stepKey} status=${status}`);
    }
    return { applied: 'failed', stepKey };
  }
  return { ignored: status };
}

/** Pull worker outcomes for boost campaigns (own timestamp-watermark
 *  cursor — safe alongside airdrop's cursor; duplicates filtered by the
 *  campaign prefix + apply idempotency). Inert while no executor. */
export async function ingestBoostExecutionOutcomes({ getter }) {
  let cursor = Number(await getConfig(BOOST_EXEC_PULL_CURSOR_KEY, '0').catch(() => '0')) || 0;
  const counts = {};
  let applied = 0;
  for (let page = 0; page < 5; page++) {
    const data = await getter('/api/internal/signer/pull', { cursor });
    const outcomes = Array.isArray(data?.outcomes) ? data.outcomes : [];
    if (!outcomes.length) break;
    for (const outcome of outcomes) {
      if (!String(outcome?.campaign_id ?? '').startsWith('bc_')) continue;
      try {
        const r = await applyBoostExecutionOutcome(outcome);
        const key = r.applied ?? (r.parked ? 'parked' : r.duplicate ? 'duplicate' : r.missing ? 'missing' : 'other');
        counts[key] = (counts[key] ?? 0) + 1;
        if (r.applied) applied++;
      } catch (err) {
        console.error('[boostExecPull]', outcome?.intent_id, err?.message ?? err);
        counts.error = (counts.error ?? 0) + 1;
      }
    }
    const next = Number(data?.cursor ?? cursor);
    if (Number.isFinite(next) && next !== cursor) {
      cursor = next;
      await setConfig(BOOST_EXEC_PULL_CURSOR_KEY, String(cursor)).catch(() => {});
    }
    if (outcomes.length < 1000) break;
  }
  return { applied, counts, cursor };
}

async function parkBoostForReview(campaign, reason) {
  // Ingest-reconcile wave (2b): every park — not just ingest failures —
  // snapshots the cursor, because outcomes arriving while parked in
  // ANY park are consumed as duplicates until the unpark rewinds.
  await snapshotBoostParkCursor(campaign.id);
  if (campaign.status === 'reconciliation_required') return false;
  const moved = await transitionBoost(campaign.id, campaign.status, 'reconciliation_required', { error: String(reason).slice(0, 300) });
  if (moved) {
    await alertOwner('boost', `🛠️ Boost campaign parked for review\nCampaign ${campaign.id}: ${reason}\nNothing further sends until reconciled.`);
    await auditMoney('boost', campaign.telegramUserId, 'execution_parked', `campaign=${campaign.id} reason=${String(reason).slice(0, 120)}`);
  }
  return moved;
}

/** The broadcaster cycle. Planned + executing campaigns (limit 10 each):
 *  digest check → shadow verification (skipped when the shadow marker
 *  already matches the current digest) → execution-time cap re-check
 *  (runs BEFORE the executor gate, so an over-cap campaign parks
 *  promptly even while incapable) → live gates (executor capability,
 *  broadcast signal) → push the next wave → executing. A row
 *  failure never affects other rows. While the executor is incapable,
 *  every planned campaign reports liveHeld and nothing is pushed — the
 *  cycle is live, the executor is not. */
export async function cycleBoostBroadcast(deps = {}) {
  if (!(await isBoostEnabled())) return { skipped: 'boost_disabled' };
  const out = { checked: 0, shadowVerified: 0, liveHeld: 0, pushed: 0, parked: 0, executed: 0 };
  const rows = [
    ...(await listBoostCampaignsByStatus('planned', 10)),
    ...(await listBoostCampaignsByStatus('executing', 10)),
  ];
  // Calendar wave: planned campaigns with a booked slot run in slot
  // order, paid bookings before free/trial bookings inside a slot.
  // Unbooked planned campaigns keep their place after booked ones
  // only when at least one booking exists; with no bookings at all
  // the order is untouched, so existing cycle behaviour is unchanged.
  // This ordering never bypasses any gate below (trial hold, caps,
  // executor capability, broadcast signal all still apply per row).
  let orderedRows = rows;
  try {
    const planned = rows.filter((r) => r.status === 'planned');
    const executing = rows.filter((r) => r.status !== 'planned');
    const annotated = [];
    for (const r of planned) {
      const b = await getCalendarBooking('boost', r.id).catch(() => null);
      annotated.push({ row: r, slot: b ? Number(b.slotStart) : Infinity, rank: b ? calendarOrderRank(b.tier) : 1, created: Number(r.createdAt ?? 0) });
    }
    if (annotated.some((a) => a.slot !== Infinity)) {
      annotated.sort((a, b) => (a.slot - b.slot) || (a.rank - b.rank) || (a.created - b.created));
      orderedRows = [...annotated.map((a) => a.row), ...executing];
    }
  } catch { /* ordering is best-effort; the cycle itself must not fail on it */ }
  for (const row of orderedRows) {
    out.checked++;
    try {
      // PRICING WAVE: trial exclusion at the money gate — a campaign
      // quoted/accepted before a trial started must never execute
      // while the owner is on trial. The row is left untouched (not
      // parked): when the trial ends the owner is a free user again,
      // and free users keep existing booster access.
      // TRIAL FIX WAVE 2026-11-01, bug 11: an unverifiable tier (DB
      // error sentinel) counts in the same held bucket — fail closed,
      // row untouched. tierUnknownHeld is additive detail only.
      {
        const broadcastTier = await getUserTier(row.telegramUserId);
        if (isBoostTierHeld(broadcastTier)) {
          out.trialHeld = (out.trialHeld ?? 0) + 1;
          if (String(broadcastTier ?? '').toLowerCase().trim() === BOOST_TIER_UNKNOWN) {
            out.tierUnknownHeld = (out.tierUnknownHeld ?? 0) + 1;
          }
          continue;
        }
      }
      // Ingest-reconcile wave (2b): a campaign running again with a
      // park snapshot was unparked (via unparkBoostCampaign, which
      // keeps the snapshot against a concurrent-ingest clobber, or
      // via the legacy raw CAS). Rewind once from the snapshot and
      // clear it, BEFORE this cycle's ingest runs at the end — so
      // the outcomes consumed while parked are re-pulled and applied
      // on this very cycle instead of wedging again.
      const rew = await rewindBoostExecCursor(row.id);
      if (rew.rewound) {
        out.rewinds = [...(out.rewinds ?? []), row.id];
        await auditMoney('boost', row.telegramUserId, 'execution_rewind', `campaign=${row.id} cursor ${rew.to} -> ${rew.from}`).catch(() => {});
      }
      const d = await verifyBoostPlanDigest(row);
      if (!d.ok) { await parkBoostForReview(row, `plan digest: ${d.reason}`); out.parked++; continue; }
      const plan = JSON.parse(row.planJson);
      const marker = await getConfig(`${BOOST_SHADOW_PREFIX}${row.id}`, null);
      if (marker !== plan.digest) {
        const s = await shadowVerifyBoostCampaign(row);
        if (!s.verified) { await parkBoostForReview(row, `shadow verification: ${s.reason}`); out.parked++; continue; }
        await setConfig(`${BOOST_SHADOW_PREFIX}${row.id}`, plan.digest).catch(() => {});
        out.shadowVerified++;
      }
      const caps = await executionCapCheck(row);
      if (!caps.ok) { await parkBoostForReview(row, `execution caps: ${caps.reason}`); out.parked++; continue; }
      if (!(await isBoostExecutorCapable())) { out.liveHeld++; continue; }
      if (!(await boostBroadcastSignal(row.chain))) { out.liveHeld++; continue; }
      // Farm-wallet readiness (executor wave): EVM wallets generate here
      // in-isolate; Solana wallets wait on the depgen pass. A campaign
      // with unbound farm wallets never reaches claim assembly.
      const farm = await ensureBoostFarmWallets(row, deps);
      if (!farm.ready) {
        if (farm.waiting) { out.liveHeld++; continue; }
        await parkBoostForReview(row, `farm wallets: ${farm.error ?? 'unknown'}`);
        out.parked++;
        continue;
      }
      if (!deps.poster) { out.liveHeld++; continue; }
      const progress = await loadBoostExecProgress(row.id);
      const steps = buildBoostExecutionSteps(row);
      // NO-GO fix 2: the wave machine gets this cycle's clock, and
      // every pushed step is stamped — the stamp is what the timeout
      // unstick reads, so an unstamped push can never wedge again.
      const wave = nextBoostWave(steps, progress, { now: deps.now ?? Date.now() });
      if (!wave.length) { out.liveHeld++; continue; }
      const claims = await assembleBoostExecutionClaims(row, wave);
      const push = await pushBoostExecutionClaims({ poster: deps.poster }, claims);
      if (push.error) { await parkBoostForReview(row, `claim push: ${push.error}`); out.parked++; continue; }
      progress.steps = progress.steps ?? {};
      for (const s of wave) progress.steps[s.key] = { status: 'submitted', submittedAt: deps.now ?? Date.now() };
      await saveBoostExecProgress(row.id, progress);
      if (row.status === 'planned') {
        const moved = await transitionBoost(row.id, 'planned', 'executing', {});
        if (moved) out.executed++;
      }
      out.pushed += push.pushed;
    } catch (err) { console.error('[boostBroadcast]', row.id, err?.message ?? err); }
  }
  if (await isBoostExecutorCapable() && deps.getter) {
    try {
      const ing = await ingestBoostExecutionOutcomes({ getter: deps.getter });
      out.outcomesApplied = ing.applied;
    } catch (err) { console.error('[boostBroadcast] ingest', err?.message ?? err); }
  }
  return out;
}
