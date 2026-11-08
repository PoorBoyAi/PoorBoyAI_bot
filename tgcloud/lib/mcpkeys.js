// MCP developer API key lifecycle (phase4-design.md §4.2).
//
// Keys look like `pbai_live_` + 32 hex chars (128 bits from
// crypto.getRandomValues). Only `sha256:v1:` + SHA-256(key) is ever stored —
// a leaked directory reveals hashes of 128-bit random keys, never raw keys.
//
// The signing helpers here (canonicalJSON / hmacHex) are byte-identical to
// the Worker's copies in phase4/_worker.js — the two halves of the
// PB↔Worker bridge must agree exactly or every signature fails.
//
// Runtime probe (2026-10-19, temporary probeCrypto endpoint, since removed):
// crypto, crypto.subtle, crypto.getRandomValues and TextEncoder all exist
// in the tgcloud isolate. The pure-JS SHA-256 below is a fallback only, kept
// because key hashing and bridge HMAC must never hard-fail on crypto.
//
// NEVER log or return a raw key anywhere except the one-time issuance
// response in endpoints/issueMcpKey.js.

export const KEY_PREFIX = 'pbai_live_';
export const KEY_PATTERN = /^pbai_live_[a-f0-9]{32}$/;
export const HASH_PREFIX = 'sha256:v1:';

export function isValidKeyFormat(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function hexEncode(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Pure-JS SHA-256 (fallback only) ──────────────────────────────────────────
// Compact FIPS 180-4 implementation over a Uint8Array. Used solely when
// crypto.subtle is unavailable; verified against known vectors.
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function sha256Bytes(input) {
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const bitLen = input.length * 8;
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  const w = new Int32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3;
    let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K256[i] + w[i]) | 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setInt32(i * 4, v));
  return out;
}

function hmacSha256Bytes(keyBytes, msgBytes) {
  let k = keyBytes;
  if (k.length > 64) k = sha256Bytes(k);
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + msgBytes.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(msgBytes, 64);
  outer.set(sha256Bytes(inner), 64);
  return sha256Bytes(outer);
}

// ── Public helpers ───────────────────────────────────────────────────────────

/** SHA-256 of a UTF-8 string, lowercase hex. crypto.subtle first. */
export async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return hexEncode(digest);
  }
  return hexEncode(sha256Bytes(bytes));
}

/** HMAC-SHA256(secret, message), lowercase hex — the bridge signature. */
export async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(String(secret));
  const msgBytes = enc.encode(String(message));
  if (globalThis.crypto?.subtle) {
    const key = await globalThis.crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, msgBytes);
    return hexEncode(sig);
  }
  return hexEncode(hmacSha256Bytes(keyBytes, msgBytes));
}

/** A fresh raw key: KEY_PREFIX + 32 hex chars (128 bits of entropy). */
export function generateKey() {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // INSECURE fallback — only reachable if the isolate ever loses
    // WebCrypto (the 2026-10-19 probe showed getRandomValues exists, so
    // this is dead code in practice). Never rely on it for real entropy.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return KEY_PREFIX + hexEncode(bytes);
}

/** The storable form of a key: 'sha256:v1:' + SHA-256 hex of the raw key. */
export async function hashKey(key) {
  return HASH_PREFIX + (await sha256Hex(key));
}

/** Display form: pbai_live_ab12••••••••••••••••ef34 (prefix + bullets + last4). */
export function maskKey(prefix, last4) {
  return `${prefix}••••••••••••••••${last4}`;
}

/**
 * Deterministic JSON for bridge signing — keys sorted recursively.
 * MUST stay byte-identical to the Worker version (phase4/_worker.js).
 */
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k]))
      .join(',') +
    '}'
  );
}
