// Chain primitives + wallet vault — the low-level layer of the
// Boost/Airdrop rebuild (design PB-BOOST-AIRDROP-DESIGN §4–§5.3).
// Consolidated into ONE module under the platform module cap
// (wave-boost-airdrop): exact decimal math, keccak-256 / secp256k1
// keypair GENERATION / base58, the AES-256-GCM wallet vault
// (byte-compatible with the original farm format), and read-only
// JSON-RPC chain access + native prices. Parts 1–3 sign and broadcast
// NOTHING. Part 4 (masterspend wave, 2026-10-22) adds the signing +
// raw-broadcast PRIMITIVES for exactly one consumer — the capped
// master-wallet spend engine in lib/moneyguard.js, which is the only
// module permitted to call them. No other caller may use Part 4.

import { fetch } from 'sdk';
import { getConfig } from './config.js';

// Exact decimal-string math for native token amounts (design §5.2: native
// amounts are decimal TEXT, never floats). Fixed 18 decimal places via
// BigInt scaling — enough for wei (18dp) and lamports (9dp) alike.
// USD quote math stays in JS numbers inside the quote builders, mirroring
// the original contract code exactly; this module is for stored amounts,
// splits, sums and comparisons where float drift is unacceptable.

const SCALE = 10n ** 18n;
const FRAC = 18;

/** Parse a decimal string → scaled BigInt. Throws on malformed input. */
export function parseDec(value) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal: ${s.slice(0, 40)}`);
  const neg = s.startsWith('-');
  const [intPart, fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  if (fracPart.length > FRAC) throw new Error('decimal has more than 18 places');
  const scaled = BigInt(intPart) * SCALE + BigInt(fracPart.padEnd(FRAC, '0') || '0');
  return neg ? -scaled : scaled;
}

/** Scaled BigInt → minimal decimal string (trailing zeros trimmed). */
export function fmtDec(scaled) {
  const v = BigInt(scaled);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const intPart = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(FRAC, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

export const decAdd = (a, b) => fmtDec(parseDec(a) + parseDec(b));
export const decSub = (a, b) => fmtDec(parseDec(a) - parseDec(b));
export const decCmp = (a, b) => {
  const d = parseDec(a) - parseDec(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};
export const decIsPositive = (a) => parseDec(a) > 0n;
/** Multiply a decimal string by a non-negative integer. */
export const decMulInt = (a, n) => fmtDec(parseDec(a) * BigInt(n));
/** Divide a decimal string by a positive integer, truncating toward zero at 18dp. */
export const decDivInt = (a, n) => fmtDec(parseDec(a) / BigInt(n));
/** a × bps / 10000 (basis points), truncated at 18dp. */
export const decBps = (a, bps) => fmtDec((parseDec(a) * BigInt(bps)) / 10000n);
/** Sum an array of decimal strings exactly. */
export const decSum = (arr) => fmtDec(arr.reduce((acc, x) => acc + parseDec(x), 0n));

/** USD number (≤2dp semantics) → integer cents, original rounding. */
export const usdToCents = (n) => Math.round((Number(n) + Number.EPSILON) * 100);
/** Integer cents → USD number with 2dp rounding (original roundUsd). */
export const centsToUsd = (c) => Math.round((Number(c) / 100 + Number.EPSILON) * 100) / 100;

// ══ Part 2: crypto primitives + AES-256-GCM vault ════════════════

// Wallet vault — AES-256-GCM encryption byte-compatible with the original
// booster wallet farm (`ivHex:encHex:tagHex`, key = BOOSTER_ENCRYPTION_KEY
// as 64 hex chars), plus the pure-JS chain primitives the isolate needs:
// keccak-256, secp256k1 keypair GENERATION (no signing ships in Phase 2),
// and base58. Design: PB-BOOST-AIRDROP-DESIGN §4–§5.3.
//
// HARD RULES: the encryption key is read from config, validated by shape
// only, and never logged or returned. Private keys exist only as function
// locals and are returned solely to the caller that generated them (which
// encrypts immediately). Decrypt callers: migration verification and the
// future arm-phase executor — never user surfaces.


// ── Hex / byte helpers ──────────────────────────────────────────────────────

export function hexToBytes(hex) {
  const s = String(hex).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('invalid hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);

// ── Keccak-256 (original Keccak padding, not SHA3) ─────────────────────────

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const MASK64 = (1n << 64n) - 1n;
const rotl64 = (x, n) => (n === 0 ? x : (((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64));

function keccakF1600(state) {
  const C = new Array(5), D = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) state[i] ^= D[i % 5];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], KECCAK_ROT[x + 5 * y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = B[x + 5 * y] ^ ((~B[((x + 1) % 5) + 5 * y] & MASK64) & B[((x + 2) % 5) + 5 * y]);
      }
    }
    state[0] ^= KECCAK_RC[round];
  }
}

/** Keccak-256 of a Uint8Array → Uint8Array(32). */
export function keccak256(input) {
  const rate = 136; // 1088-bit rate for 256-bit output
  const state = new Array(25).fill(0n);
  const absorb = (block, len) => {
    for (let i = 0; i < len; i++) {
      state[i >> 3] ^= BigInt(block[i]) << BigInt(8 * (i & 7));
    }
  };
  let offset = 0;
  while (offset + rate <= input.length) {
    absorb(input.subarray(offset, offset + rate), rate);
    keccakF1600(state);
    offset += rate;
  }
  const tail = new Uint8Array(rate);
  tail.set(input.subarray(offset));
  tail[input.length - offset] ^= 0x01; // Keccak domain byte
  tail[rate - 1] ^= 0x80;
  absorb(tail, rate);
  keccakF1600(state);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number((state[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

export const keccak256Hex = (data) =>
  bytesToHex(keccak256(typeof data === 'string' ? utf8(data) : data));

// ── secp256k1 — GENERATION (point multiplication for addresses) ───────────
// Generation shipped in Phase 2 under a no-signing hard rule; the ECDSA
// signing primitive that reuses this point math lives in Part 4 and
// exists solely for the capped master-spend engine (lib/moneyguard.js).

const SEC_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SEC_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SEC_G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

function modPow(base, exp, mod) {
  let result = 1n, b = ((base % mod) + mod) % mod, e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}
const modInv = (a, mod) => modPow(a, mod - 2n, mod);
const modP = (a) => ((a % SEC_P) + SEC_P) % SEC_P;

function pointAdd(p, q) {
  if (p === null) return q;
  if (q === null) return p;
  let lambda;
  if (p.x === q.x) {
    if (modP(p.y + q.y) === 0n) return null; // point at infinity
    lambda = modP(3n * p.x * p.x * modInv(2n * p.y, SEC_P));
  } else {
    lambda = modP((q.y - p.y) * modInv(q.x - p.x, SEC_P));
  }
  const x = modP(lambda * lambda - p.x - q.x);
  const y = modP(lambda * (p.x - x) - p.y);
  return { x, y };
}

function scalarMul(k, point = SEC_G) {
  let result = null, addend = point, bits = k;
  while (bits > 0n) {
    if (bits & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    bits >>= 1n;
  }
  return result;
}

function bigIntTo32(n) {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

/** EVM address (lowercase hex, 0x-prefixed) for a 32-byte private key. */
export function evmAddressFromPrivkey(privBytes) {
  if (privBytes.length !== 32) throw new Error('private key must be 32 bytes');
  const k = BigInt('0x' + bytesToHex(privBytes));
  if (k === 0n || k >= SEC_N) throw new Error('private key out of range');
  const pub = scalarMul(k);
  const xy = new Uint8Array(64);
  xy.set(bigIntTo32(pub.x), 0);
  xy.set(bigIntTo32(pub.y), 32);
  return '0x' + bytesToHex(keccak256(xy).subarray(12));
}

/** Generate a fresh EVM keypair. Plaintext format = ethers-canonical '0x'+64hex. */
export function generateEvmKeypair() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const k = BigInt('0x' + bytesToHex(priv));
    if (k === 0n || k >= SEC_N) continue;
    return { address: evmAddressFromPrivkey(priv), privateKey: '0x' + bytesToHex(priv) };
  }
  throw new Error('key generation failed');
}

// ── base58 (Bitcoin alphabet) ───────────────────────────────────────────────

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(str) {
  if (typeof str !== 'string' || !str.length) return null;
  let n = 0n;
  for (const c of str) {
    const v = B58_MAP.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  const body = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

// ── Address validation / normalization ─────────────────────────────────────

export const isValidEvmAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
export const normalizeEvmAddress = (a) => (isValidEvmAddress(a) ? a.toLowerCase() : null);

export function isValidSolAddress(a) {
  if (typeof a !== 'string') return false;
  const bytes = base58Decode(a);
  return !!bytes && bytes.length === 32;
}

/**
 * Generate a fresh Solana keypair via WebCrypto Ed25519 when the isolate
 * exposes it. Stored plaintext = the 64-byte secret key as 128 hex chars
 * (the original farm's format). Returns null when Ed25519 is unavailable —
 * callers surface Solana as temporarily unavailable rather than faking it.
 */
export async function generateSolKeypair() {
  try {
    if (!crypto?.subtle) return null;
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    if (pubRaw.length !== 32) return null;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const secret = new Uint8Array(64);
    secret.set(seed, 0);
    secret.set(pubRaw, 32);
    return { address: base58Encode(pubRaw), privateKeyHex: bytesToHex(secret) };
  } catch {
    return null;
  }
}

// ── AES-256-GCM vault (original format: ivHex:encHex:tagHex) ───────────────

let keyPromise = null;

async function vaultKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const hex = await getConfig('BOOSTER_ENCRYPTION_KEY', null);
      if (!hex || !/^[0-9a-fA-F]{64}$/.test(String(hex).trim())) {
        throw new Error('BOOSTER_ENCRYPTION_KEY is not configured as 64 hex chars');
      }
      return crypto.subtle.importKey('raw', hexToBytes(String(hex).trim()), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    })();
  }
  return keyPromise;
}

/** Encrypt a UTF-8 string → 'ivHex:encHex:tagHex' (original farm format). */
export async function vaultEncrypt(plaintext) {
  const key = await vaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(String(plaintext))),
  );
  const enc = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  return `${bytesToHex(iv)}:${bytesToHex(enc)}:${bytesToHex(tag)}`;
}

/** Decrypt an 'ivHex:encHex:tagHex' blob → UTF-8 string. Throws on any
 *  format or GCM authentication failure (that throw IS the integrity proof
 *  used by the migration verification). */
export async function vaultDecrypt(blob) {
  const parts = String(blob).split(':');
  if (parts.length !== 3) throw new Error('ciphertext format invalid');
  const [iv, enc, tag] = parts.map(hexToBytes);
  if (iv.length !== 12 || tag.length !== 16) throw new Error('ciphertext format invalid');
  const combined = new Uint8Array(enc.length + tag.length);
  combined.set(enc, 0);
  combined.set(tag, enc.length);
  const key = await vaultKey();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
  return fromUtf8(new Uint8Array(plain));
}

/** Classify a decrypted plaintext WITHOUT exposing it (verification use):
 *  length + character class only. */
export function classifyPlaintext(s) {
  const str = String(s);
  let kind = 'other';
  if (/^0x[0-9a-fA-F]{64}$/.test(str)) kind = 'evm_pk_0x';
  else if (/^[0-9a-fA-F]{64}$/.test(str)) kind = 'hex_64';
  else if (/^[0-9a-fA-F]{128}$/.test(str)) kind = 'hex_128_sol_secret';
  else if (/^[0-9a-fA-F]+$/.test(str)) kind = 'hex_other';
  else if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(str)) kind = 'base58';
  return { length: str.length, kind };
}

// ══ Part 3: read-only chain RPC + prices ═════════════════════════

// Read-only chain access for the Boost/Airdrop rebuild (design §5.3).
// JSON-RPC over the sdk fetch: native balances, ERC-20/SPL token balances,
// gas price sampling, native USD prices. This part signs and sends
// nothing — the sole eth_sendRawTransaction path is Part 4 below,
// reserved for the capped master-spend engine.
//
// RPC URLs come from PB's config (BASE_RPC_URL was rescued; RH_RPC_URL /
// SOLANA_RPC_URL fall back to the chains' public endpoints — read-only use).
// Chain registry mirrors the original chain-registry.ts. W0 (2026-10-21):
// RH chainId corrected to the live mainnet id 4663 (4660 was the testnet id)
// and RH's native asset corrected to USDG — the chain's gas token at 18
// decimals per the original booster-deposit-watcher/revoke-sweep, priced via
// CoinGecko 'global-dollar' (the port previously mispriced RH as ETH). The
// registry carries all 9 chains; only base/sol/rh are live for airdrop/boost.


export const CHAINS = {
  base: { key: 'base', label: 'Base', chainId: 8453, nativeSymbol: 'ETH', nativeDecimals: 18, coingeckoId: 'ethereum' },
  rh: { key: 'rh', label: 'Robinhood Chain', chainId: 4663, nativeSymbol: 'USDG', nativeDecimals: 18, coingeckoId: 'global-dollar' },
  sol: { key: 'sol', label: 'Solana', chainId: null, nativeSymbol: 'SOL', nativeDecimals: 9, coingeckoId: 'solana' },
  // W0 registry extension (multi-chain spec §3/§9): the six chains below are
  // registered for READ/registry truth only. Airdrop/boost acceptance stays
  // gated by AIRDROP_CHAINS / BOOSTER_CHAINS (base/sol/rh) until each chain's
  // opening wave — presence here enables no money flow.
  ethereum: { key: 'ethereum', label: 'Ethereum', chainId: 1, nativeSymbol: 'ETH', nativeDecimals: 18, coingeckoId: 'ethereum' },
  arbitrum: { key: 'arbitrum', label: 'Arbitrum', chainId: 42161, nativeSymbol: 'ETH', nativeDecimals: 18, coingeckoId: 'ethereum' },
  optimism: { key: 'optimism', label: 'Optimism', chainId: 10, nativeSymbol: 'ETH', nativeDecimals: 18, coingeckoId: 'ethereum' },
  polygon: { key: 'polygon', label: 'Polygon', chainId: 137, nativeSymbol: 'POL', nativeDecimals: 18, coingeckoId: 'polygon-ecosystem-token' },
  bnb: { key: 'bnb', label: 'BNB Smart Chain', chainId: 56, nativeSymbol: 'BNB', nativeDecimals: 18, coingeckoId: 'binancecoin' },
  avalanche: { key: 'avalanche', label: 'Avalanche C-Chain', chainId: 43114, nativeSymbol: 'AVAX', nativeDecimals: 18, coingeckoId: 'avalanche-2' },
};
export const CHAIN_KEYS = Object.keys(CHAINS);
export const isChainKey = (c) => CHAIN_KEYS.includes(c);

const DEFAULT_RPC = {
  base: 'https://mainnet.base.org',
  rh: 'https://rpc.mainnet.chain.robinhood.com',
  sol: 'https://api.mainnet-beta.solana.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  bnb: 'https://bsc-rpc.publicnode.com',
  avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
};
const CONFIG_KEY = {
  base: 'BASE_RPC_URL', rh: 'RH_RPC_URL', sol: 'SOLANA_RPC_URL',
  ethereum: 'ETHEREUM_RPC_URL', arbitrum: 'ARBITRUM_RPC_URL', optimism: 'OPTIMISM_RPC_URL',
  polygon: 'POLYGON_RPC_URL', bnb: 'BNB_RPC_URL', avalanche: 'AVALANCHE_RPC_URL',
};

export async function rpcUrl(chain) {
  const fromConfig = await getConfig(CONFIG_KEY[chain], null).catch(() => null);
  return (fromConfig && String(fromConfig).trim()) || DEFAULT_RPC[chain];
}

let rpcSeq = 1;
async function rpcCall(chain, method, params) {
  const url = await rpcUrl(chain);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcSeq++, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(`RPC ${method}: ${body.error.message ?? 'error'}`);
  return body.result;
}

// ── EVM reads ───────────────────────────────────────────────────────────────

const hexToBig = (h) => BigInt(h ?? '0x0');

/** Native balance of an address → decimal string in native units. */
export async function evmNativeBalance(chain, address) {
  const wei = hexToBig(await rpcCall(chain, 'eth_getBalance', [address, 'latest']));
  return fmtDec(wei * (10n ** BigInt(18 - CHAINS[chain].nativeDecimals)));
}

/** ERC-20 balanceOf → decimal string in token units (needs token decimals). */
export async function evmTokenBalance(chain, token, address, tokenDecimals = 18) {
  const data = '0x70a08231' + address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const raw = hexToBig(await rpcCall(chain, 'eth_call', [{ to: token, data }, 'latest']));
  const scaled = raw * (10n ** BigInt(18 - Math.min(tokenDecimals, 18)));
  return fmtDec(scaled);
}

/** ERC-20 decimals() → number (defaults 18 on any failure is NOT assumed;
 *  throws so money math fails closed). */
export async function evmTokenDecimals(chain, token) {
  const raw = await rpcCall(chain, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);
  const n = Number(hexToBig(raw));
  if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error('token decimals out of range');
  return n;
}

/** ERC-20 symbol() → string|null (best effort, display only). */
export async function evmTokenSymbol(chain, token) {
  try {
    const raw = await rpcCall(chain, 'eth_call', [{ to: token, data: '0x95d89b41' }, 'latest']);
    const hex = String(raw).replace(/^0x/, '');
    if (hex.length < 128) return null;
    const len = Number(BigInt('0x' + hex.slice(64, 128)));
    const bytes = [];
    for (let i = 0; i < len; i++) bytes.push(parseInt(hex.slice(128 + i * 2, 130 + i * 2), 16));
    return new TextDecoder().decode(new Uint8Array(bytes)) || null;
  } catch { return null; }
}

/** Contract code at an EVM address ('0x' / '0x0' = externally owned
 *  account, no code). NO-GO fix 5 (2026-10-26): the refund guard's
 *  contract check. Throws on RPC failure so callers fail visibly, never
 *  on a substituted empty answer. Read-only. */
export async function evmCodeAt(chain, address) {
  const code = await rpcCall(chain, 'eth_getCode', [address, 'latest']);
  return String(code ?? '0x');
}

/** Current gas price (wei) as BigInt — used by reserve estimation. */
export async function evmGasPriceWei(chain) {
  return hexToBig(await rpcCall(chain, 'eth_gasPrice', []));
}

/** Tx receipt status: 'confirmed' | 'reverted' | 'pending' | 'unknown'. */
export async function evmTxStatus(chain, txHash) {
  const r = await rpcCall(chain, 'eth_getTransactionReceipt', [txHash]);
  if (!r) return 'pending';
  return r.status === '0x1' ? 'confirmed' : 'reverted';
}

/** Latest block number (integer). */
export async function evmLatestBlock(chain) {
  return Number(hexToBig(await rpcCall(chain, 'eth_blockNumber', [])));
}

/** Block header read → { number, hash, timestamp } (unix seconds). */
export async function evmBlockByNumber(chain, n) {
  const b = await rpcCall(chain, 'eth_getBlockByNumber', ['0x' + BigInt(n).toString(16), false]);
  if (!b) throw new Error(`block ${n} unavailable`);
  return { number: Number(hexToBig(b.number)), hash: b.hash ?? null, timestamp: Number(hexToBig(b.timestamp)) };
}

/**
 * First block whose timestamp is >= tsSec → { number, hash, timestamp }.
 * Binary search over eth_getBlockByNumber, starting from a lower bound
 * 200,000 blocks behind latest (widened if that block is already at/after
 * the target). Throws on any RPC failure or when even the latest block
 * predates tsSec — callers (the Buy Rewards draw) defer rather than
 * substitute a seed (PB-BUYREWARDS-SPEC §8.2).
 */
export async function evmFirstBlockAtOrAfter(chain, tsSec) {
  const latest = await evmLatestBlock(chain);
  const latestBlock = await evmBlockByNumber(chain, latest);
  if (latestBlock.timestamp < tsSec) throw new Error('seed block not yet produced');
  let lo = Math.max(0, latest - 200000);
  let loBlock = await evmBlockByNumber(chain, lo);
  while (lo > 0 && loBlock.timestamp >= tsSec) {
    lo = Math.max(0, lo - 200000);
    loBlock = await evmBlockByNumber(chain, lo);
  }
  if (loBlock.timestamp >= tsSec) return loBlock; // block 0 itself qualifies
  // Invariant: timestamp(lo) < tsSec <= timestamp(hi); find the first fit.
  let hi = latest;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const midBlock = await evmBlockByNumber(chain, mid);
    if (midBlock.timestamp >= tsSec) hi = mid; else lo = mid;
  }
  return evmBlockByNumber(chain, hi);
}

export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** ERC-20 Transfer logs for a token over an inclusive block range (raw
 *  eth_getLogs rows). Callers bound the range — public RPCs reject wide
 *  spans; the airdrop holder snapshot walks in chunks. */
export async function evmTransferLogs(chain, token, fromBlock, toBlock) {
  const logs = await rpcCall(chain, 'eth_getLogs', [{
    address: token,
    topics: [ERC20_TRANSFER_TOPIC],
    fromBlock: '0x' + BigInt(fromBlock).toString(16),
    toBlock: '0x' + BigInt(toBlock).toString(16),
  }]);
  return Array.isArray(logs) ? logs : [];
}

// ── Solana reads ────────────────────────────────────────────────────────────

/** SOL balance → decimal string. */
export async function solNativeBalance(address) {
  const r = await rpcCall('sol', 'getBalance', [address, { commitment: 'confirmed' }]);
  const lamports = BigInt(r?.value ?? 0);
  return fmtDec(lamports * (10n ** 9n));
}

/** SPL token balance for (owner, mint) summed across token accounts →
 *  decimal string in token units. */
export async function solTokenBalance(owner, mint) {
  const r = await rpcCall('sol', 'getTokenAccountsByOwner', [
    owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  let total = 0n;
  let decimals = null;
  for (const acct of r?.value ?? []) {
    const info = acct?.account?.data?.parsed?.info;
    const amt = info?.tokenAmount;
    if (!amt) continue;
    decimals = amt.decimals;
    total += BigInt(amt.amount);
  }
  if (decimals === null) return '0';
  return fmtDec(total * (10n ** BigInt(18 - Math.min(decimals, 18))));
}

/** SPL mint decimals → number (throws on any failure — money math fails
 *  closed, mirroring evmTokenDecimals). */
export async function solMintDecimals(mint) {
  const r = await rpcCall('sol', 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const n = r?.value?.data?.parsed?.info?.decimals;
  if (!Number.isInteger(n) || n < 0 || n > 18) throw new Error('mint decimals unavailable');
  return n;
}

/** Largest SPL token accounts for a mint, owners resolved (top-20 by
 *  balance — a PARTIAL holder view by construction; callers must label it
 *  as such). Returns [{ owner, amount }] with amount in decimal token units. */
export async function solLargestTokenAccounts(mint) {
  const r = await rpcCall('sol', 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  const out = [];
  for (const acct of r?.value ?? []) {
    const info = await rpcCall('sol', 'getAccountInfo', [acct.address, { encoding: 'jsonParsed', commitment: 'confirmed' }])
      .catch(() => null);
    const owner = info?.value?.data?.parsed?.info?.owner;
    if (!owner) continue;
    out.push({ owner, amount: String(acct.amount?.uiAmountString ?? '0') });
  }
  return out;
}

// ── Unified balance helpers (watchers) ──────────────────────────────────────

/** Native balance for any supported chain, decimal string. */
export async function nativeBalance(chain, address) {
  return chain === 'sol' ? solNativeBalance(address) : evmNativeBalance(chain, address);
}

/** Token balance for any supported chain, decimal string (token units). */
export async function tokenBalance(chain, token, address) {
  if (chain === 'sol') return solTokenBalance(address, token);
  const decimals = await evmTokenDecimals(chain, token);
  return evmTokenBalance(chain, token, address, decimals);
}

// ── Prices (CoinGecko, the original's endpoints) ────────────────────────────
// Quotes FAIL CLOSED when a live price is unavailable (design §5.3 — the
// original's stale fallbacks are deliberately not carried into payment math).

export async function nativeUsdPrice(chain) {
  const id = CHAINS[chain].coingeckoId;
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`price HTTP ${res.status}`);
  const data = await res.json();
  const price = Number(data?.[id]?.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error('native price unavailable');
  return price;
}

// ══ Part 4: signing + raw broadcast primitives ═════════════════════
// Masterspend wave (2026-10-22, Rowdy's capped master-wallet decision).
// These primitives exist for EXACTLY ONE consumer: the spend engine in
// lib/moneyguard.js (masterSpend), which wraps them in the arm flag,
// kill switch, purpose allowlist, USD caps, per-chain lock, and the
// spend ledger. Nothing else in the tree may call them. Private keys
// enter as function arguments (resolved by the engine from PB's config,
// their existing home) and are never stored, logged, or returned here.

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function bigIntToBytes(v) {
  let n = BigInt(v);
  if (n === 0n) return new Uint8Array(0);
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  return new Uint8Array(bytes);
}

/** Public point {x, y} (BigInts) for a 32-byte private key — used by the
 *  engine's BIP32 derivation (non-hardened steps need the parent pubkey). */
export function evmPubkeyPoint(privBytes) {
  if (privBytes.length !== 32) throw new Error('private key must be 32 bytes');
  const k = BigInt('0x' + bytesToHex(privBytes));
  if (k === 0n || k >= SEC_N) throw new Error('private key out of range');
  return scalarMul(k);
}

async function hmacDigest(algo, keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: algo }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
export const hmacSha256 = (keyBytes, data) => hmacDigest('SHA-256', keyBytes, data);
export const hmacSha512 = (keyBytes, data) => hmacDigest('SHA-512', keyBytes, data);

/**
 * ECDSA/secp256k1 sign a 32-byte hash → { r, s, recoveryId } (BigInt r/s).
 * Deterministic nonce per RFC 6979 (HMAC-SHA256), low-s normalized
 * (EIP-2), recoveryId in {0,1,2,3} pre-EIP-155 (caller adds the chain
 * offset). Pure math over the Part-2 point primitives — no key material
 * leaves this function.
 */
export async function evmSignHash(privBytes, hashBytes) {
  if (privBytes.length !== 32) throw new Error('evmSignHash: private key must be 32 bytes');
  if (hashBytes.length !== 32) throw new Error('evmSignHash: hash must be 32 bytes');
  const d = BigInt('0x' + bytesToHex(privBytes));
  if (d === 0n || d >= SEC_N) throw new Error('evmSignHash: private key out of range');
  const z = BigInt('0x' + bytesToHex(hashBytes)) % SEC_N;
  // RFC 6979 §3.2 with bits2octets(h1) = int(h1) mod n as 32 bytes.
  const bx = concatBytes([privBytes, bigIntTo32(z)]);
  let v = new Uint8Array(32).fill(1);
  let k = new Uint8Array(32).fill(0);
  k = await hmacSha256(k, concatBytes([v, Uint8Array.of(0), bx]));
  v = await hmacSha256(k, v);
  k = await hmacSha256(k, concatBytes([v, Uint8Array.of(1), bx]));
  v = await hmacSha256(k, v);
  for (;;) {
    v = await hmacSha256(k, v);
    const cand = BigInt('0x' + bytesToHex(v));
    if (cand >= 1n && cand < SEC_N) {
      const R = scalarMul(cand);
      const r = R.x % SEC_N;
      if (r !== 0n) {
        const s0 = (modInv(cand, SEC_N) * ((z + (r * d) % SEC_N) % SEC_N)) % SEC_N;
        if (s0 !== 0n) {
          let s = s0;
          let recoveryId = Number(R.y & 1n) | (R.x >= SEC_N ? 2 : 0);
          if (s > SEC_N / 2n) { s = SEC_N - s; recoveryId ^= 1; }
          return { r, s, recoveryId };
        }
      }
    }
    k = await hmacSha256(k, concatBytes([v, Uint8Array.of(0)]));
    v = await hmacSha256(k, v);
  }
}

// ── RLP encoding (tx serialization) ─────────────────────────────────────────

function rlpLengthPrefix(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const lb = bigIntToBytes(BigInt(len));
  return concatBytes([Uint8Array.of(offset + 55 + lb.length), lb]);
}
function rlpString(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return concatBytes([rlpLengthPrefix(b.length, 0x80), b]);
}

/** RLP-encode a value: Uint8Array | hex/address string | BigInt/number |
 *  Array (nested). Integers encode as minimal big-endian (0 = empty). */
export function rlpEncode(value) {
  if (Array.isArray(value)) {
    const payload = concatBytes(value.map(rlpEncode));
    return concatBytes([rlpLengthPrefix(payload.length, 0xc0), payload]);
  }
  if (value instanceof Uint8Array) return rlpString(value);
  if (typeof value === 'bigint' || typeof value === 'number') {
    return rlpString(bigIntToBytes(BigInt(value)));
  }
  if (typeof value === 'string') {
    return rlpString(value.startsWith('0x') ? hexToBytes(value) : utf8(value));
  }
  throw new Error('rlpEncode: unsupported value type');
}

// ── Write-side RPC (engine-only) ────────────────────────────────────────────

/** Pending nonce (eth_getTransactionCount 'pending') → integer. */
export async function evmPendingNonce(chain, address) {
  return Number(hexToBig(await rpcCall(chain, 'eth_getTransactionCount', [address, 'pending'])));
}

/** eth_estimateGas → BigInt gas units. Throws on RPC/revert — callers
 *  fail closed (a failed estimate usually means the send would revert). */
export async function evmEstimateGas(chain, tx) {
  return hexToBig(await rpcCall(chain, 'eth_estimateGas', [tx]));
}

/** Broadcast a signed raw transaction → tx hash string. THE only
 *  eth_sendRawTransaction path in the bot; reserved for the capped
 *  master-spend engine (lib/moneyguard.js masterSpend). */
export async function evmSendRawTransaction(chain, rawHex) {
  const hash = await rpcCall(chain, 'eth_sendRawTransaction', [rawHex]);
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error('eth_sendRawTransaction: malformed hash in response');
  }
  return hash;
}

