// Money guard — the shared rails for the Boost/Airdrop rebuild (design §5.1,
// §6): feature flags, live-arm switches, caps, transition audit, owner alerts.
// Money/admin surfaces are Rowdy-only, enforced here server-side.
//
// The Boost/Airdrop arm flags exist so the planner can label plans honestly
// and so the deposit-class signer path has exactly one place to check.
// Masterspend wave (2026-10-22): this module ALSO hosts the capped
// master-wallet spend engine (masterSpend, below) — the one place in the
// bot that signs and broadcasts, gated by its own arm flag (ships OFF),
// kill switch, purpose allowlist, and USD caps. The deposit-class paths
// above remain untouched by it.

import { api } from 'sdk';
import db, { eq, and, sql } from 'sdk/db';
import { user_activity_log, boost_campaigns, airdrop_campaigns, master_spend_ledger, sales, pb_leads } from '../schema.js';
import { getConfig, setConfig, getConfigFlag, flagValueOn } from './config.js';
import { isOwnerId, ownerIdSet } from './groups.js';
import {
  CHAINS, isChainKey,
  keccak256, rlpEncode, hexToBytes, bytesToHex,
  evmAddressFromPrivkey, evmPubkeyPoint, evmSignHash, hmacSha512,
  evmPendingNonce, evmEstimateGas, evmSendRawTransaction, evmGasPriceWei,
  evmTokenDecimals, evmTxStatus, nativeBalance, tokenBalance, nativeUsdPrice,
  normalizeEvmAddress, parseDec,
} from './walletvault.js';
import { fetchTokenByAddress } from './market.js';

// Byte-identical to MOVING_NOTICE in handlers/message.js — the parked reply
// every money command must give while its feature flag is off (the same
// pattern lib/studio.js uses for STUDIO_MOVING_NOTICE).
export const MONEY_MOVING_NOTICE =
  '🚚 That command is moving into PB\u2019s new home and returns in the next rollout. Core commands (/start /help /price /ca /chart /scan /ask /profile) are live now.';

// Tolerant boolean read (lib/config.js getConfigFlag — audit F19):
// '1'/'true'/'on'/'yes' are ON, everything else OFF. Fail-closed on error,
// exactly as the strict reader was.
const flag = async (key) => {
  try { return await getConfigFlag(key); } catch { return false; }
};

export const isBoostEnabled = () => flag('boost_enabled');
export const isAirdropEnabled = () => flag('airdrop_enabled');

/**
 * Money-wizard routing order (wizard-vs-agent-loop hijack fix,
 * 2026-10-25). Pure: the dispatcher passes liveness + last-touch
 * timestamps (from each wizard's own draft) and gets back the wizards
 * to offer free text to, in order.
 * - Both live: ONLY the most recently touched consumes (a stale draft
 *   must never eat the other wizard's input). Tie → legacy order.
 * - One live: only it. Neither live: legacy order (both decline fast).
 */
export function pickMoneyWizardOrder({ boostLive, boostTouch, airdropLive, airdropTouch }) {
  if (boostLive && airdropLive) {
    const b = boostTouch ?? 0, a = airdropTouch ?? 0;
    if (a !== b) return [a > b ? 'airdrop' : 'boost'];
    return ['boost', 'airdrop'];
  }
  if (boostLive) return ['boost'];
  if (airdropLive) return ['airdrop'];
  return ['boost', 'airdrop'];
}
export const isBoostArmed = () => flag('boost_live_arm');
export const isAirdropArmed = () => flag('airdrop_live_arm');

// ── Per-chain layers (multi-chain spec §6.2) ───────────────────────────────
// Beneath the global product flags sit per-chain gates, config-backed and
// default-closed (absent ≠ '1' = closed): <product>_chain_<key>_enabled
// admits a chain to the product; <product>_chain_<key>_arm is that chain's
// live-send arm (set only via the per-chain two-step in /armairdrop).
// Boost twins exist for matrix symmetry — boost consumes them in W4.
// Unknown/forged chain keys are never enabled and never armed.
const chainFlag = async (product, chain, kind) => {
  if (!isChainKey(chain)) return false;
  return flag(`${product}_chain_${chain}_${kind}`);
};
export const isAirdropChainEnabled = (chain) => chainFlag('airdrop', chain, 'enabled');
export const isAirdropChainArmed = (chain) => chainFlag('airdrop', chain, 'arm');
export const isBoostChainEnabled = (chain) => chainFlag('boost', chain, 'enabled');
export const isBoostChainArmed = (chain) => chainFlag('boost', chain, 'arm');
export const airdropChainEnabledKey = (chain) => `airdrop_chain_${chain}_enabled`;
export const airdropChainArmKey = (chain) => `airdrop_chain_${chain}_arm`;

/** Owner check that throws nothing — for lib-level enforcement. */
export async function requireOwner(userId) {
  try { return await isOwnerId(userId); } catch { return false; }
}

// ── Caps (config, owner-set; USD numbers) ───────────────────────────────────

async function capUsd(key, fallback) {
  const raw = Number(await getConfig(key, String(fallback)).catch(() => fallback));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}
export const maxSendUsd = () => capUsd('money_max_send_usd', 50);
export const dailyCapUsd = () => capUsd('money_daily_cap_usd', 250);
export const maxBoostCapitalUsd = () => capUsd('boost_max_capital_usd', 500);

export async function setMoneyConfig(key, value) {
  await setConfig(key, String(value));
}

// ── Audit ───────────────────────────────────────────────────────────────────
// Every state transition on a money object writes a user_activity_log row.
// kind: 'boost' | 'airdrop' | 'money_admin'. detail is a capped plain-text
// summary — never secrets, never ciphertext, never private keys.

export async function auditMoney(kind, userId, action, detail = '') {
  try {
    // user_activity_log has no action column — the action rides as a
    // 'action:' prefix inside detail (queries match on it, e.g. plannedUsdToday).
    await db.insert(user_activity_log).values({
      telegramUserId: String(userId ?? ''),
      kind,
      detail: `action:${String(action).slice(0, 60)} ${String(detail)}`.slice(0, 400),
    }).run();
  } catch { /* audit must never break the flow */ }
}

// ── Owner alerts (throttled: max 2 per 10 minutes, Studio pattern) ─────────

const alertKey = (scope) => `money_alert:${scope}`;

export async function alertOwner(scope, text) {
  try {
    const now = Date.now();
    const raw = await getConfig(alertKey(scope), '[]');
    const sent = JSON.parse(raw).filter((t) => now - t < 10 * 60 * 1000);
    if (sent.length >= 2) return false;
    const ownerRaw = await getConfig('TELEGRAM_OWNER_ID', '');
    const owner = String(ownerRaw).split(',').map((x) => x.trim()).filter(Boolean)[0];
    if (!owner) return false;
    await api.sendMessage({ chat_id: Number(owner), text: String(text).slice(0, 3800) });
    sent.push(now);
    await setConfig(alertKey(scope), JSON.stringify(sent));
    return true;
  } catch { return false; }
}

// ── Sales-leg owner receipt (2026-11-05) ────────────────────────────────────
// Itemized receipt for a confirmed sale. Once-only: the sales row's
// receiptSentAt is checked first and set on send, so a confirm path that
// runs twice still receipts once. NOT alertOwner — that helper is
// rate-limited (2/scope/10min) and would swallow a second sale.
// The composer is pure (harness-tested in node); the sender does the
// DB + send work and is proven in-isolate.
export function composeSalesReceiptText(sale, camp) {
  const kind = sale?.campaignKind === 'boost' ? 'boost' : 'airdrop';
  const label = kind === 'boost'
    ? `Booster ${camp?.mode ?? ''}`.trim()
    : 'Airdrop Custom List';
  const lines = [
    '💰 NEW PURCHASE',
    '',
    `👤 telegram ${sale?.buyerTelegramId ?? '?'}`,
    `📦 ${label}${camp?.tokenName ? ` — ${camp.tokenName}` : ''}`,
    kind === 'boost'
      ? `💳 Fee: $${sale?.feeUsd ?? '?'} (deposit $${camp?.totalDueUsd ?? '?'} incl. fee)`
      : `💳 Fee: $${sale?.feeUsd ?? '?'} (Base USDC)`,
    `🧾 Campaign: ${sale?.campaignId ?? camp?.id ?? '?'}`,
  ];
  if (kind === 'boost') {
    if (camp?.depositAddress) lines.push(`🏦 Deposit: ${camp.depositAddress}`);
  } else if (sale?.txHash || camp?.feePaymentRef) {
    lines.push(`🔗 Tx: ${String(sale?.txHash || camp?.feePaymentRef).slice(0, 80)}`);
  } else {
    lines.push('🔗 Tx: watcher-confirmed');
  }
  lines.push(`🧾 Receipt #S-${sale?.id ?? '?'}`);
  lines.push('');
  lines.push(kind === 'boost'
    ? '✅ Deposit funded — planning runs on the next tick; live execution opens on the owner live flag.'
    : '✅ Fee confirmed — the deposit wallet is open; the customer funds it with their tokens next.');
  return lines.join('\n');
}

export async function sendSalesReceipt(kind, campaignId, deps = {}) {
  try {
    const k = kind === 'boost' ? 'boost' : 'airdrop';
    const sale = await db.select().from(sales)
      .where(and(eq(sales.campaignKind, k), eq(sales.campaignId, String(campaignId))))
      .get().catch(() => null);
    if (!sale) return { skipped: 'no_sale' };
    if (sale.receiptSentAt) return { skipped: 'already_sent' };
    if (deps.txHash && !sale.txHash) {
      await db.update(sales).set({ txHash: String(deps.txHash).slice(0, 128) })
        .where(eq(sales.id, sale.id)).run().catch(() => {});
      sale.txHash = String(deps.txHash).slice(0, 128);
    }
    const campTable = k === 'boost' ? boost_campaigns : airdrop_campaigns;
    const camp = await db.select().from(campTable).where(eq(campTable.id, String(campaignId))).get().catch(() => null);
    if (!camp) return { skipped: 'no_campaign' };
    const text = composeSalesReceiptText(sale, camp);
    const send = deps.send ?? (async (chatId, t) => { await api.sendMessage({ chat_id: chatId, text: String(t).slice(0, 3800) }); });
    const owners = [...(await ownerIdSet().catch(() => new Set()))];
    let sent = 0;
    for (const ownerId of owners) {
      try { await send(Number(ownerId), text); sent++; } catch { /* best-effort per owner */ }
    }
    if (!sent) return { skipped: 'no_owners' };
    await db.update(sales).set({ status: 'receipt_sent', receiptSentAt: new Date(), updatedAt: new Date() })
      .where(eq(sales.id, sale.id)).run().catch(() => {});
    // The lead is won: the fee/deposit confirmed, so the prospect that
    // became a customer moves contacted -> won. Only from contacted —
    // a dismissed or already-won lead is never rewritten.
    if (sale.leadId) {
      await db.update(pb_leads).set({ status: 'won' })
        .where(and(eq(pb_leads.id, sale.leadId), eq(pb_leads.status, 'contacted'))).run().catch(() => {});
    }
    return { ok: true, sent };
  } catch (err) {
    console.error('[sales receipt]', err?.message ?? err);
    return { error: String(err?.message ?? err) };
  }
}

// ── Daily spend accumulation (planner-side, arm phase re-checks) ───────────

/** Sum of USD value planned today (UTC) for a product, from audit rows the
 *  planners wrote. Used by the daily-cap check; intents carry their USD
 *  estimate in the detail JSON the planner appends. */
export async function plannedUsdToday(kind) {
  try {
    const rows = await db.select().from(user_activity_log)
      .where(eq(user_activity_log.kind, kind)).all();
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    let total = 0;
    for (const r of rows) {
      if (!String(r.detail ?? '').startsWith('action:plan_created')) continue;
      const ts = r.createdAt ? new Date(r.createdAt).getTime() : 0;
      if (ts < start.getTime()) continue;
      const m = /usd=([0-9]+(?:\.[0-9]+)?)/.exec(r.detail ?? '');
      if (m) total += Number(m[1]);
    }
    return total;
  } catch { return 0; }
}

/** Check a proposed plan against caps. Returns { ok } or { ok:false, reason }. */
export async function checkCaps({ perSendUsd, totalUsd, kind }) {
  const maxSend = await maxSendUsd();
  if (perSendUsd > maxSend) {
    return { ok: false, reason: `per-send cap: $${perSendUsd} exceeds $${maxSend} (money_max_send_usd)` };
  }
  const daily = await dailyCapUsd();
  const already = await plannedUsdToday(kind);
  if (already + totalUsd > daily) {
    return { ok: false, reason: `daily cap: $${already} planned today + $${totalUsd} exceeds $${daily} (money_daily_cap_usd)` };
  }
  return { ok: true };
}

// ══ Master-wallet capped spend engine (masterspend wave, 2026-10-22) ══════
// Rowdy's decision: PB's spending wallet IS the master wallet, reachable
// ONLY through this engine — masterSpend() is the single entry point and
// the only caller of the walletvault Part-4 signing/broadcast primitives.
// Enforcement order (fail-closed at every step):
//   arm flag → kill switch → purpose allowlist (+ per-purpose asset rule,
//   Base-only in v1) → USD valuation (no live price = refuse) → per-send
//   cap → rolling-24h daily cap (summed from the ledger) → per-chain lock
//   → ledger row written 'pending' BEFORE signing → key resolve +
//   derivation check → balance checks → sign → broadcast → ledger
//   finalized with the tx hash → owner page (all owners).
// Refusals write a 'refused' ledger row; post-ledger failures finalize
// the row as 'failed'. A broadcast is NEVER retried anywhere — an
// ambiguous outcome parks on its row for the owner, exactly like the
// original's pbai_master_spend_intents discipline.
// The master key is read only from its existing config home
// (BOOSTER_MASTER_PK — raw hex or the original resolver's BIP39 phrase
// form), lives only as a function local during the send, and is never
// logged, returned, or copied anywhere new.

export const MASTER_WALLET_ADDRESS = '0xefa099590c45874e844dec6fc862c7141ecf4139';
const MASTER_SPEND_PBAI = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e'; // $PBAI on Base (public)
const MASTER_SPEND_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // canonical Base USDC (public)
const WATCHER_RECEIVE_ADDRESS = '0x3a4989433b5d6f9a91690711dc6117c4a54670c1'; // PB watcher receive wallet, Base (public, already on site)
const MASTER_SPEND_LOCK_STALE_MS = 120_000;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Purpose allowlist v1 (audit register §4 coverage). assets = the asset
// kinds each purpose may move. treasury_distribution is allowlisted
// (engine-supported) but deliberately has NO caller: the
// RevenueDistributor contract is undeployed and banked, and nothing in
// the tree invokes the purpose.
const MASTER_SPEND_PURPOSES = {
  welcome_drop: { assets: ['pbai'] },
  xp_cashout: { assets: ['pbai'] },
  admin_drop: { assets: ['pbai'] },
  deposit_gas_float: { assets: ['native'] },
  seed_gas_recovery: { assets: ['native'] },
  treasury_distribution: { assets: ['native', 'pbai'] },
  // booster_funding (2026-10-28, Rowdy's explicit tap + live-test order):
  // native ETH only, bot-side to a booster campaign deposit wallet.
  // Adding the purpose creates NO caller — funding sends are explicit
  // owner-invoked steps (the $5 creator-coin canary). Engine caps
  // ($10/send, $25/day), ledger + owner page, arm/kill/chain checks
  // all still apply. The signer worker never touches the master key.
  booster_funding: { assets: ['native'] },
  // smoke_test_internal (FINISH MODE 2026-11-01, Rowdy's standing
  // test-funds order): USDC only, $1 purpose cap on top of the engine
  // $10/$25 caps, recipient allowlist = watcher wallet ONLY. The
  // caller hardcodes 0.01 USDC to the watcher; no args can change
  // amount or recipient. TEST-flagged, never revenue, never announced
  // (the caller + Portal status carry the TEST flag; the engine
  // ledger row carries purpose + detail). Adding the purpose creates
  // exactly one caller below (/smoketest, owner DM only).
  smoke_test_internal: { assets: ['usdc'], maxUsd: 1, allowedTo: [WATCHER_RECEIVE_ADDRESS] },
};
export const masterSpendPurposes = () => Object.keys(MASTER_SPEND_PURPOSES);

export const isMasterSpendArmed = () => flag('master_spend_arm');
export const isMasterSpendKilled = () => flag('master_spend_kill');
export const masterSpendMaxSendUsd = () => capUsd('master_spend_max_send_usd', 10);
export const masterSpendDailyCapUsd = () => capUsd('master_spend_daily_cap_usd', 25);

// ── Small local helpers ────────────────────────────────────────────────────

const catBytes = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};
const bigTo32 = (n) => {
  const out = new Uint8Array(32);
  let v = BigInt(n);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};
const utf8Bytes = (s) => new TextEncoder().encode(s);
const ser32 = (i) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i >>> 0);
  return b;
};
function compressedPubkey(privBytes) {
  const pt = evmPubkeyPoint(privBytes);
  const out = new Uint8Array(33);
  out[0] = (pt.y & 1n) === 1n ? 0x03 : 0x02;
  out.set(bigTo32(pt.x), 1);
  return out;
}

async function capFrom(d, key, fallback) {
  const raw = Number(await d.getConfig(key, String(fallback)).catch(() => fallback));
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// ── Deps (house seam pattern — production defaults, harness overrides) ────

function spendDeps(deps = {}) {
  return {
    getConfig: deps.getConfig ?? getConfig,
    setConfig: deps.setConfig ?? setConfig,
    priceUsd: deps.priceUsd ?? defaultSpendPriceUsd,
    nativeBalance: deps.nativeBalance ?? nativeBalance,
    tokenBalance: deps.tokenBalance ?? tokenBalance,
    tokenDecimals: deps.tokenDecimals ?? evmTokenDecimals,
    pendingNonce: deps.pendingNonce ?? evmPendingNonce,
    gasPriceWei: deps.gasPriceWei ?? evmGasPriceWei,
    estimateGas: deps.estimateGas ?? evmEstimateGas,
    sendRaw: deps.sendRaw ?? evmSendRawTransaction,
    txStatus: deps.txStatus ?? evmTxStatus,
    sign: deps.sign ?? evmSignHash,
    expectedMasterAddress: deps.expectedMasterAddress ?? MASTER_WALLET_ADDRESS,
    ledgerInsert: deps.ledgerInsert ?? ledgerInsertRow,
    ledgerUpdate: deps.ledgerUpdate ?? ledgerUpdateRow,
    ledgerDailyUsd: deps.ledgerDailyUsd ?? ledgerDailyUsdSince,
    pageOwners: deps.pageOwners ?? pageOwnersSpend,
    now: deps.now ?? (() => Date.now()),
  };
}

async function defaultSpendPriceUsd({ chain, assetKind }) {
  try {
    if (assetKind === 'native') return await nativeUsdPrice(chain);
    // FINISH MODE 2026-11-01: USDC is a stablecoin, valued at $1
    // exactly, never a live price lookup that could drift a cap.
    if (assetKind === 'usdc') return 1;
    const t = await fetchTokenByAddress(MASTER_SPEND_PBAI, 'base');
    const p = Number(t?.priceUsd);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

// ── Ledger (master_spend_ledger) ───────────────────────────────────────────

async function ledgerInsertRow(row) {
  const inserted = await db.insert(master_spend_ledger).values(row).returning();
  return inserted?.[0]?.id ?? null;
}
async function ledgerUpdateRow(id, patch) {
  await db.update(master_spend_ledger).set({ ...patch, updatedAt: new Date() })
    .where(eq(master_spend_ledger.id, id)).run();
}
async function ledgerDailyUsdSince(sinceSec) {
  const row = await db.get(sql`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM master_spend_ledger WHERE status IN ('pending', 'sent', 'confirmed') AND created_at >= ${sinceSec}`);
  return Number(row?.total ?? 0);
}

/** Rolling-24h USD already committed by the engine (pending+sent+confirmed). */
export async function masterSpendUsd24h(deps = {}) {
  const d = spendDeps(deps);
  return d.ledgerDailyUsd(Math.floor((d.now() - 24 * 3600_000) / 1000));
}

// ── Owner page (every spend; all owners; best effort) ─────────────────────

async function pageOwnersSpend(text) {
  const owners = await ownerIdSet().catch(() => new Set());
  let delivered = 0;
  for (const id of owners) {
    try {
      await api.sendMessage({ chat_id: Number(id), text: String(text).slice(0, 3800) });
      delivered++;
    } catch { /* try the next owner */ }
  }
  return delivered;
}

// ── Master key resolution (config home only; shape-checked) ───────────────

/**
 * Resolve the master private key from PB's config → 32 bytes, or null.
 * Accepts the two forms the original resolver accepted (raw 64-hex with
 * optional 0x, or the wallet's BIP39 phrase → m/44'/60'/0'/0/0). The
 * value is never logged or returned anywhere else; the bytes live only
 * in the caller's local scope for the duration of one send.
 */
async function resolveMasterPrivBytes(d) {
  const raw = String((await d.getConfig('BOOSTER_MASTER_PK', '')) ?? '').trim();
  if (!raw) return null;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return hexToBytes(raw);
  const words = raw.split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]+$/.test(w))) {
    const seedKey = await crypto.subtle.importKey('raw', utf8Bytes(words.join(' ')), 'PBKDF2', false, ['deriveBits']);
    const seed = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: utf8Bytes('mnemonic'), iterations: 2048, hash: 'SHA-512' }, seedKey, 512));
    const I = await hmacSha512(utf8Bytes('Bitcoin seed'), seed);
    let k = I.subarray(0, 32);
    let c = I.subarray(32);
    for (const idx of [44 + 0x80000000, 60 + 0x80000000, 0 + 0x80000000, 0, 0]) {
      const data = idx >= 0x80000000
        ? catBytes([Uint8Array.of(0), k, ser32(idx)])
        : catBytes([compressedPubkey(k), ser32(idx)]);
      const J = await hmacSha512(c, data);
      const il = BigInt('0x' + bytesToHex(J.subarray(0, 32)));
      if (il >= SECP256K1_N) return null;
      const child = (il + BigInt('0x' + bytesToHex(k))) % SECP256K1_N;
      if (child === 0n) return null;
      k = bigTo32(child);
      c = J.subarray(32);
    }
    return k;
  }
  return null;
}

/** Key posture for status surfaces: existence + derivation truth only. */
export async function masterKeyStatus(deps = {}) {
  const d = spendDeps(deps);
  const rawVal = await d.getConfig('BOOSTER_MASTER_PK', '').catch(() => '');
  const raw = String(rawVal ?? '').trim();
  if (!raw) return { configured: false, derivesToMaster: false };
  let priv = null;
  try { priv = await resolveMasterPrivBytes(d); } catch { priv = null; }
  if (!priv) return { configured: true, derivesToMaster: false };
  let addr = null;
  try { addr = evmAddressFromPrivkey(priv); } catch { addr = null; }
  return { configured: true, derivesToMaster: addr === d.expectedMasterAddress };
}

// ── Per-chain lock (config-row, tick_lock pattern) ─────────────────────────

async function acquireSpendLock(chain, d) {
  const key = `master_spend_lock:${chain}`;
  const now = d.now();
  const raw = String((await d.getConfig(key, '')) ?? '');
  const prevTs = Number(raw.split(':')[0]) || 0;
  if (prevTs && now - prevTs < MASTER_SPEND_LOCK_STALE_MS) return null;
  const token = `${now}:${Math.floor(Math.random() * 1e9)}`;
  await d.setConfig(key, token);
  const check = String((await d.getConfig(key, '')) ?? '');
  return check === token ? token : null;
}
async function releaseSpendLock(chain, token, d) {
  if (!token) return;
  try {
    const key = `master_spend_lock:${chain}`;
    const cur = String((await d.getConfig(key, '')) ?? '');
    if (cur === token) await d.setConfig(key, '');
  } catch { /* a stale lock self-heals via the staleness window */ }
}

// ── Tx builder (legacy EIP-155; exported for harness known-answer tests) ──

export async function buildSignedLegacyTx({ privBytes, chainId, nonce, gasPriceWei, gasLimit, to, valueWei, dataHex }, deps = {}) {
  const sign = deps.sign ?? evmSignHash;
  const data = dataHex && dataHex !== '0x' ? hexToBytes(dataHex) : new Uint8Array(0);
  const fields = [BigInt(nonce), BigInt(gasPriceWei), BigInt(gasLimit), String(to).toLowerCase(), BigInt(valueWei), data];
  const sighash = keccak256(rlpEncode([...fields, BigInt(chainId), 0n, 0n]));
  const { r, s, recoveryId } = await sign(privBytes, sighash);
  const v = BigInt(chainId) * 2n + 35n + BigInt(recoveryId);
  const raw = rlpEncode([...fields, v, r, s]);
  return { rawHex: '0x' + bytesToHex(raw), sighashHex: '0x' + bytesToHex(sighash), v, r, s };
}

const erc20TransferData = (to, rawAmount) =>
  '0xa9059cbb' + to.replace(/^0x/, '').padStart(64, '0') + rawAmount.toString(16).padStart(64, '0');

// ── The engine ─────────────────────────────────────────────────────────────

/**
 * masterSpend({ purpose, chain='base', asset, to, amountText, initiatedBy, detail }, deps?)
 * asset: 'native' | token contract address (v1: only $PBAI is priced/allowed).
 * amountText: decimal string in ASSET units ('1000' = 1,000 $PBAI; '0.001' = 0.001 ETH).
 * Returns { ok, status, reason?, phase?, txHash?, ledgerId?, usd?, paged? }.
 * phase: 'checks' (refused before any send machinery) | 'pre_broadcast'
 * (ledgered, failed before broadcast) | 'broadcast' (failed at/after
 * broadcast — final, never retried).
 */
export async function masterSpend(req, deps = {}) {
  const d = spendDeps(deps);
  const purpose = String(req?.purpose ?? '');
  const chain = String(req?.chain ?? 'base');
  const to = normalizeEvmAddress(String(req?.to ?? ''));
  const amountText = String(req?.amountText ?? '').trim();
  const assetRaw = String(req?.asset ?? '');
  const assetKind = assetRaw === 'native' ? 'native' : (assetRaw.toLowerCase() === MASTER_SPEND_PBAI ? 'pbai' : (assetRaw.toLowerCase() === MASTER_SPEND_USDC ? 'usdc' : 'other'));
  const tokenContract = assetKind === 'usdc' ? MASTER_SPEND_USDC : MASTER_SPEND_PBAI;
  const assetStored = assetKind === 'native' ? 'native' : assetRaw.toLowerCase();
  let amount = null;
  try { amount = parseDec(amountText); } catch { amount = null; }
  if (!purpose || !to || amount === null || amount <= 0n) {
    return { ok: false, status: 'refused', reason: 'invalid_request', phase: 'checks' };
  }
  const baseRow = {
    purpose, chain, asset: assetStored, toAddress: to, amountText,
    initiatedBy: req?.initiatedBy != null ? String(req.initiatedBy) : null,
    detail: req?.detail ? String(req.detail).slice(0, 200) : null,
  };
  const refuse = async (reason, usdInfo = {}) => {
    let ledgerId = null;
    try {
      ledgerId = await d.ledgerInsert({
        ...baseRow,
        amountUsd: usdInfo.usd ?? 0, usdPrice: usdInfo.price ?? null,
        status: 'refused', refusalReason: reason,
      });
    } catch { /* the refusal stands even if its ledger row cannot land */ }
    return { ok: false, status: 'refused', reason, phase: 'checks', ledgerId, ...(usdInfo.usd != null ? { usd: usdInfo.usd } : {}) };
  };

  // 1–2. Arm flag, then kill switch.
  if (!flagValueOn(await d.getConfig('master_spend_arm', null).catch(() => null))) return refuse('not_armed');
  if (flagValueOn(await d.getConfig('master_spend_kill', null).catch(() => null))) return refuse('kill_switch_on');
  // 3. Purpose allowlist + asset rule + chain (v1 callers are Base-only).
  const rule = MASTER_SPEND_PURPOSES[purpose];
  if (!rule) return refuse('purpose_not_allowlisted');
  if (chain !== 'base') return refuse('chain_not_enabled_v1');
  if (!rule.assets.includes(assetKind)) return refuse('asset_not_allowed_for_purpose');
  // FINISH MODE 2026-11-01 (smoke-test wave, add-only): recipient
  // allowlist — a purpose with allowedTo may only pay those addresses.
  // Addresses are normalized by normalizeEvmAddress above, and the
  // allowlist entries are stored lowercase, so compare lowercase.
  if (Array.isArray(rule.allowedTo) && !rule.allowedTo.map((a) => String(a).toLowerCase()).includes(to.toLowerCase())) {
    return refuse('recipient_not_allowed_for_purpose');
  }
  // 4. USD valuation — no live price, no spend.
  let price = null;
  try { price = await d.priceUsd({ chain, assetKind }); } catch { price = null; }
  if (!Number.isFinite(price) || price <= 0) return refuse('price_unavailable');
  const usd = Number(amountText) * price;
  // FINISH MODE 2026-11-01 (smoke-test wave, add-only): per-purpose
  // cap, checked before the general caps so it can only tighten them.
  if (Number.isFinite(rule.maxUsd) && usd > rule.maxUsd) return refuse('purpose_cap', { usd, price });
  // 5–6. Caps (per-send, then rolling-24h daily from the ledger).
  const maxSend = await capFrom(d, 'master_spend_max_send_usd', 10);
  if (usd > maxSend) return refuse('per_send_cap', { usd, price });
  const dailyCap = await capFrom(d, 'master_spend_daily_cap_usd', 25);
  let spent = NaN;
  try { spent = await d.ledgerDailyUsd(Math.floor((d.now() - 24 * 3600_000) / 1000)); } catch { spent = NaN; }
  if (!Number.isFinite(spent)) return refuse('ledger_unavailable', { usd, price });
  if (spent + usd > dailyCap) return refuse('daily_cap', { usd, price });
  // 7. Per-chain lock — one in-flight send per chain, ever.
  const lockToken = await acquireSpendLock(chain, d);
  if (!lockToken) return refuse('chain_lock_held', { usd, price });

  let ledgerId = null;
  try {
    // 8. Ledger row BEFORE signing. No row, no send.
    try {
      ledgerId = await d.ledgerInsert({
        ...baseRow, amountUsd: usd, usdPrice: price, status: 'pending', refusalReason: null,
      });
    } catch { ledgerId = null; }
    if (ledgerId == null) {
      return { ok: false, status: 'refused', reason: 'ledger_write_failed', phase: 'checks', usd };
    }
    const fail = async (reason, phase) => {
      await d.ledgerUpdate(ledgerId, { status: 'failed', refusalReason: reason }).catch(() => {});
      return { ok: false, status: 'failed', reason, phase, ledgerId, usd };
    };
    // 9. Key resolve + derivation check (the address is public; the key
    // itself never leaves this scope).
    let priv = null;
    try { priv = await resolveMasterPrivBytes(d); } catch { priv = null; }
    if (!priv) return fail('master_key_unavailable', 'pre_broadcast');
    let from = null;
    try { from = evmAddressFromPrivkey(priv); } catch { from = null; }
    if (from !== d.expectedMasterAddress) return fail('master_key_mismatch', 'pre_broadcast');
    // 10. Amounts, gas, nonce, balances — every read fails closed.
    const chainId = CHAINS[chain].chainId;
    let valueWei = 0n;
    let dataHex = '0x';
    if (assetKind === 'native') {
      valueWei = amount; // parseDec is 18dp-scaled; Base's native is 18dp — this IS wei.
    } else {
      let decimals = null;
      try { decimals = await d.tokenDecimals(chain, tokenContract); } catch { decimals = null; }
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return fail('token_decimals_unavailable', 'pre_broadcast');
      const scaleDown = 10n ** BigInt(18 - decimals);
      if (amount % scaleDown !== 0n) return fail('amount_precision', 'pre_broadcast');
      dataHex = erc20TransferData(to, amount / scaleDown);
    }
    let gasPrice = null;
    try { gasPrice = await d.gasPriceWei(chain); } catch { gasPrice = null; }
    if (gasPrice == null || gasPrice <= 0n) return fail('gas_price_unavailable', 'pre_broadcast');
    gasPrice = (gasPrice * 11n) / 10n + 1n; // 10% headroom over the sampled price
    let nonce = null;
    try { nonce = await d.pendingNonce(chain, from); } catch { nonce = null; }
    if (!Number.isInteger(nonce) || nonce < 0) return fail('nonce_unavailable', 'pre_broadcast');
    let gasLimit = 21000n;
    if (assetKind !== 'native') {
      try { gasLimit = await d.estimateGas(chain, { from, to: tokenContract, data: dataHex }); }
      catch { return fail('gas_estimate_failed', 'pre_broadcast'); }
      gasLimit = (gasLimit * 12n) / 10n + 1000n; // 20% headroom + slack
    }
    const gasCost = gasPrice * gasLimit;
    let nativeBal = null;
    try { nativeBal = parseDec(await d.nativeBalance(chain, from)); } catch { nativeBal = null; }
    if (nativeBal === null) return fail('balance_read_failed', 'pre_broadcast');
    if (assetKind === 'native') {
      if (nativeBal < valueWei + gasCost) return fail('insufficient_master_balance', 'pre_broadcast');
    } else {
      if (nativeBal < gasCost) return fail('insufficient_master_gas', 'pre_broadcast');
      let tokBal = null;
      try { tokBal = parseDec(await d.tokenBalance(chain, tokenContract, from)); } catch { tokBal = null; }
      if (tokBal === null) return fail('balance_read_failed', 'pre_broadcast');
      if (tokBal < amount) return fail('insufficient_master_balance', 'pre_broadcast');
    }
    // 11. Sign + broadcast (single attempt; a throw here is final).
    const built = await buildSignedLegacyTx({
      privBytes: priv, chainId, nonce, gasPriceWei: gasPrice, gasLimit,
      to: assetKind === 'native' ? to : tokenContract, valueWei, dataHex,
    }, { sign: d.sign });
    let txHash = null;
    try { txHash = await d.sendRaw(chain, built.rawHex); }
    catch { return fail('broadcast_error', 'broadcast'); }
    // 12. Finalize the row; one receipt look (no timers exist in the
    // isolate — a still-pending receipt honestly stays 'sent').
    let finalStatus = 'sent';
    try {
      const st = await d.txStatus(chain, txHash);
      if (st === 'confirmed') finalStatus = 'confirmed';
      else if (st === 'reverted') finalStatus = 'failed';
    } catch { /* stays 'sent' */ }
    await d.ledgerUpdate(ledgerId, {
      status: finalStatus, txHash,
      ...(finalStatus === 'failed' ? { refusalReason: 'tx_reverted' } : {}),
    }).catch(() => {});
    if (finalStatus === 'failed') {
      return { ok: false, status: 'failed', reason: 'tx_reverted', phase: 'broadcast', txHash, ledgerId, usd };
    }
    // 13. Owner page — amount, purpose, recipient, tx link.
    const symbol = assetKind === 'native' ? CHAINS[chain].nativeSymbol : (assetKind === 'usdc' ? 'USDC' : '$PBAI');
    const page = [
      '💸 PB master spend',
      `Purpose: ${purpose}`,
      `Amount: ${amountText} ${symbol} (~$${usd.toFixed(2)})`,
      `To: ${to}`,
      `Status: ${finalStatus}`,
      `Tx: https://basescan.org/tx/${txHash}`,
    ].join('\n');
    let paged = 0;
    try { paged = await d.pageOwners(page); } catch { paged = 0; }
    return { ok: true, status: finalStatus, txHash, ledgerId, usd, paged };
  } finally {
    await releaseSpendLock(chain, lockToken, d);
  }
}

/** Engine posture for /moneyops: flags, caps, 24h spend, key truth. */
export async function masterSpendStatus(deps = {}) {
  const d = spendDeps(deps);
  const armed = flagValueOn(await d.getConfig('master_spend_arm', null).catch(() => null));
  const killed = flagValueOn(await d.getConfig('master_spend_kill', null).catch(() => null));
  const maxSend = await capFrom(d, 'master_spend_max_send_usd', 10);
  const dailyCap = await capFrom(d, 'master_spend_daily_cap_usd', 25);
  const spent24h = await d.ledgerDailyUsd(Math.floor((d.now() - 24 * 3600_000) / 1000)).catch(() => NaN);
  const key = await masterKeyStatus(deps).catch(() => ({ configured: false, derivesToMaster: false }));
  return { armed, killed, maxSend, dailyCap, spent24h, keyConfigured: key.configured, keyDerivesToMaster: key.derivesToMaster };
}

function spendResultText(label, res, amountText, sym, to) {
  if (res?.ok) {
    return `✅ ${label} sent: ${amountText} ${sym} → ${to}\nTx: https://basescan.org/tx/${res.txHash}\nStatus: ${res.status} · ~$${Number(res.usd ?? 0).toFixed(2)} · owners paged: ${res.paged ?? 0}`;
  }
  if (res?.status === 'failed') {
    return `⚠️ ${label} FAILED after checks (${res.reason ?? 'unknown'}) — see master_spend_ledger row ${res.ledgerId ?? '?'}. Nothing was retried.`;
  }
  return `⛔ ${label} refused — nothing sent.\nReason: ${res?.reason ?? 'unknown'}`;
}

// ══ Owner money-admin commands (merged under the module cap) ══════

async function sendDm(uid, text) {
  try { await api.sendMessage({ chat_id: uid, text: String(text).slice(0, 4000) }); } catch { /* closed */ }
}

async function countSql(query) {
  try {
    const row = await db.get(query);
    return Number(row?.n ?? 0);
  } catch { return -1; }
}

async function statusCounts(tableObj) {
  try {
    const rows = await db.select({ status: tableObj.status, n: sql`COUNT(*)` })
      .from(tableObj).groupBy(tableObj.status).all();
    return rows.map((r) => `${r.status}:${r.n}`).join(' · ') || 'none';
  } catch { return 'unavailable'; }
}

const onOff = (b) => (b ? 'ON' : 'off');

// Product × chain matrix order (spec §6.2): legacy live chains first, then
// the W1 expansion chains in rollout order.
export const CHAIN_MATRIX_ORDER = ['base', 'sol', 'rh', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'];

async function chainMatrixLine(product) {
  const parts = [];
  for (const key of CHAIN_MATRIX_ORDER) {
    const en = await chainFlag(product, key, 'enabled');
    const arm = await chainFlag(product, key, 'arm');
    parts.push(`${key} ${en ? 'on' : 'off'}/${arm ? 'ARM' : '—'}`);
  }
  return parts.join(' · ');
}

export async function moneyopsText() {
  const [be, ba, ae, aa] = await Promise.all([isBoostEnabled(), isBoostArmed(), isAirdropEnabled(), isAirdropArmed()]);
  const ms = await masterSpendStatus().catch(() => null);
  const lines = [
    '🛠️ Money Ops — operator only',
    '',
    `Booster: feature ${onOff(be)} · live-arm ${onOff(ba)}`,
    `Airdrop: feature ${onOff(ae)} · live-arm ${onOff(aa)}`,
    `Caps: per-send $${await maxSendUsd()} · daily $${await dailyCapUsd()} · boost capital $${await maxBoostCapitalUsd()}`,
    '',
    ...(ms ? [
      `Master spend (capped engine): arm ${onOff(ms.armed)}${ms.killed ? ' · KILL SWITCH ON 🛑' : ''} · caps $${ms.maxSend}/send · $${ms.dailyCap}/day · spent 24h $${Number.isFinite(ms.spent24h) ? ms.spent24h.toFixed(2) : '?'}`,
      `Master key: ${ms.keyConfigured ? (ms.keyDerivesToMaster ? 'configured · derives to the master wallet ✓' : 'configured · ⚠️ does NOT derive to the master wallet') : 'NOT configured'}`,
      'Master spend commands: /admindrop <addr> <PBAI amount> · /seedgas <addr> <ETH amount> · arm: /setkey MASTER_SPEND_ARM 1 · kill: /setkey MASTER_SPEND_KILL 1 · caps: /moneycaps ms_max_send|ms_daily <usd>',
      '',
    ] : ['Master spend: status unavailable', '']),
    'Airdrop chains — enabled/arm:',
    `  ${await chainMatrixLine('airdrop')}`,
    'Boost chains — enabled/arm:',
    `  ${await chainMatrixLine('boost')}`,
    '',
    `Boost campaigns: ${await statusCounts(boost_campaigns)}`,
    `Airdrop campaigns: ${await statusCounts(airdrop_campaigns)}`,
    '',
    `Boost wallets (migrated + native): ${await countSql(sql`SELECT COUNT(*) AS n FROM boost_wallets`)}`,
    `Welcome claims: ${await countSql(sql`SELECT COUNT(*) AS n FROM welcome_airdrop_claims`)}`,
    `Dex boost leads: ${await countSql(sql`SELECT COUNT(*) AS n FROM dex_boost_leads`)}`,
    `Legacy entitlements preserved: ${await countSql(sql`SELECT COUNT(*) AS n FROM boost_legacy_entitlements`)}`,
    `Legacy open refunds: ${await countSql(sql`SELECT COUNT(*) AS n FROM boost_campaigns WHERE legacy_id IS NOT NULL AND refund_status = 'refund_requested'`)}`,
    '',
    'Arming sends is a two-step: /armboost on → /armboost confirm (same for /armairdrop). Disarming is instant: /armboost off.',
    'Per-chain (airdrop): /armairdrop enable|disable <chain> flips the chain layer; /armairdrop on|confirm|off <chain> arms one chain under the global arm.',
  ];
  return lines.join('\n');
}

// ── Arm switch with two-step confirm ────────────────────────────────────────

const PRODUCTS = {
  boost: { flagKey: 'boost_live_arm', label: 'Booster', isArmed: isBoostArmed },
  airdrop: { flagKey: 'airdrop_live_arm', label: 'Airdrop', isArmed: isAirdropArmed },
};

// ── Per-chain airdrop verbs (spec §6.2): /armairdrop <verb> <chain> ───────
// The bare verbs keep their original global meaning (the global arm flow
// below is untouched); a trailing chain key scopes the verb to one chain's
// layers. enable|disable flip airdrop_chain_<key>_enabled; on|confirm|off
// drive airdrop_chain_<key>_arm with the same two-step discipline as the
// global arm. Returns true when the invocation was chain-scoped (handled),
// false when it is a bare global invocation for armCommand to run.
const CHAIN_VERBS = new Set(['on', 'confirm', 'off', 'enable', 'disable']);

async function armAirdropChainVerb(args, msg) {
  const parts = String(args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false; // no chain token — global flow handles it
  // Paste trap (2026-10-25): a pasted multi-command message arrives with
  // extra tokens after the chain ("enable base /armairdrop on base ...").
  // Only the first verb ran and the rest vanished silently. Refuse.
  if (parts.length > 2 || /[\n\r/]/.test(String(args ?? ''))) {
    await sendDm(uid, '⚠️ That looks like more than one command pasted into one message — I only read the first command per message, so nothing was armed. Send one command per message: /armairdrop on base on its own, then /armairdrop confirm base on its own (same shape without the chain for the global arm).');
    return true;
  }
  const [verb, chain] = parts;
  const uid = msg.from.id;
  if (!isChainKey(chain)) {
    await sendDm(uid, `Unknown chain "${chain}". Chains: ${CHAIN_MATRIX_ORDER.join(', ')}.\nUsage: /armairdrop on|confirm|off <chain> · /armairdrop enable|disable <chain>`);
    return true;
  }
  if (!CHAIN_VERBS.has(verb)) {
    await sendDm(uid, 'Usage: /armairdrop on|confirm|off <chain> · /armairdrop enable|disable <chain>');
    return true;
  }
  const label = CHAINS[chain].label;
  const enabled = await isAirdropChainEnabled(chain);
  const armed = await isAirdropChainArmed(chain);
  if (verb === 'enable') {
    if (enabled) { await sendDm(uid, `${label} is already enabled for airdrops (sends still need the global arm + ${label}\u2019s own arm).`); return true; }
    await setMoneyConfig(airdropChainEnabledKey(chain), '1');
    await auditMoney('money_admin', uid, 'chain_enable', `product=airdrop chain=${chain}`);
    await sendDm(uid, `✅ ${label} ENABLED for airdrops.\nCampaigns can now be created on ${label}; sends still need the global arm (/armairdrop on \u2192 confirm) AND this chain\u2019s arm (/armairdrop on ${chain} \u2192 confirm).`);
    return true;
  }
  if (verb === 'disable') {
    if (!enabled && !armed) { await sendDm(uid, `${label} is already disabled for airdrops.`); return true; }
    await setMoneyConfig(airdropChainEnabledKey(chain), '0');
    if (armed) await setMoneyConfig(airdropChainArmKey(chain), '0');
    await auditMoney('money_admin', uid, 'chain_disable', `product=airdrop chain=${chain}`);
    await sendDm(uid, `🛑 ${label} DISABLED for airdrops${armed ? ' (its chain arm was dropped too)' : ''}. New campaigns on ${label} refuse; its planned sends no longer assemble.`);
    return true;
  }
  if (verb === 'off') {
    if (!armed) { await sendDm(uid, `${label} airdrop sends are already disarmed.`); return true; }
    await setMoneyConfig(airdropChainArmKey(chain), '0');
    await auditMoney('money_admin', uid, 'disarm_chain', `product=airdrop chain=${chain}`);
    await sendDm(uid, `🛑 ${label} airdrop sends DISARMED (chain layer). The global arm is untouched.`);
    return true;
  }
  if (verb === 'on') {
    if (armed) { await sendDm(uid, `${label} airdrop sends are already ARMED (chain layer).`); return true; }
    if (!enabled) {
      await sendDm(uid, `${label} isn\u2019t enabled for airdrops yet \u2014 arming a disabled chain does nothing.\nEnable it first: /armairdrop enable ${chain}`);
      return true;
    }
    await setConfig(`arm_pending:airdrop_chain:${chain}:${uid}`, String(Date.now()));
    await sendDm(uid, [
      `⚠️ Arm ${label} airdrop sends (chain layer)?`,
      '',
      'The global airdrop arm must also be on for anything to broadcast; caps still apply.',
      `Reply /armairdrop confirm ${chain} within 60 seconds to arm. Anything else cancels.`,
    ].join('\n'));
    return true;
  }
  // verb === 'confirm'
  const pending = Number(await getConfig(`arm_pending:airdrop_chain:${chain}:${uid}`, '0'));
  if (!pending || Date.now() - pending > 60_000) {
    await sendDm(uid, `No fresh ${label} arm request to confirm. Run /armairdrop on ${chain} first.`);
    return true;
  }
  await setConfig(`arm_pending:airdrop_chain:${chain}:${uid}`, '0');
  await setMoneyConfig(airdropChainArmKey(chain), '1');
  await auditMoney('money_admin', uid, 'arm_chain', `product=airdrop chain=${chain}`);
  await alertOwner('money', `🟢 Airdrop sends ARMED for ${label} (chain layer) by operator command. The global arm still gates broadcast.`);
  await sendDm(uid, `🟢 ${label} airdrop sends ARMED (chain layer). Broadcast still needs the global arm too. /armairdrop off ${chain} disarms this chain instantly.`);
  return true;
}

async function armCommand(productKey, args, msg) {
  const uid = msg.from.id;
  const product = PRODUCTS[productKey];
  if (productKey === 'airdrop' && (await armAirdropChainVerb(args, msg))) return;
  const verb = String(args ?? '').trim().toLowerCase();
  // Paste trap (2026-10-25): a pasted multi-command message arrives as
  // one args blob ("on /armboost confirm ..."). The old code fell through
  // to a confusing "disarmed + usage" reply and armed nothing. Refuse.
  if (/[\n\r/]/.test(String(args ?? '')) || verb.split(/\s+/).filter(Boolean).length > 1) {
    await sendDm(uid, '⚠️ That looks like more than one command pasted into one message — I only read the first command per message, so nothing was armed. Send one command per message: /armboost on on its own, then /armboost confirm on its own (same for /armairdrop).');
    return;
  }
  const armed = await product.isArmed();
  if (verb === 'off') {
    if (!armed) { await sendDm(uid, `${product.label} sends are already disarmed.`); return; }
    await setMoneyConfig(product.flagKey, '0');
    await auditMoney('money_admin', uid, 'disarm', `product=${productKey}`);
    await sendDm(uid, `🛑 ${product.label} live sends DISARMED. Planners keep producing dry-run plans; nothing can broadcast.`);
    return;
  }
  if (verb === 'on') {
    if (armed) { await sendDm(uid, `${product.label} sends are already ARMED.`); return; }
    await setConfig(`arm_pending:${productKey}:${uid}`, String(Date.now()));
    await sendDm(uid, [
      `⚠️ Arm ${product.label} live sends?`,
      '',
      'Arming means funded campaigns can move real funds (subject to caps).',
      `Reply /arm${productKey} confirm within 60 seconds to arm. Anything else cancels.`,
    ].join('\n'));
    return;
  }
  if (verb === 'confirm') {
    const pending = Number(await getConfig(`arm_pending:${productKey}:${uid}`, '0'));
    if (!pending || Date.now() - pending > 60_000) {
      await sendDm(uid, 'No fresh arm request to confirm. Run the arm command with "on" first.');
      return;
    }
    await setConfig(`arm_pending:${productKey}:${uid}`, '0');
    await setMoneyConfig(product.flagKey, '1');
    await auditMoney('money_admin', uid, 'arm', `product=${productKey}`);
    await alertOwner('money', `🟢 ${product.label} live sends ARMED by operator command.`);
    await sendDm(uid, `🟢 ${product.label} live sends ARMED. Caps still apply. /arm${productKey} off disarms instantly.`);
    return;
  }
  await sendDm(uid, `${product.label} sends: ${armed ? 'ARMED 🟢' : 'disarmed 🛑'}\nUsage: /arm${productKey} on|confirm|off`);
}

// ── Commands ────────────────────────────────────────────────────────────────

const CAP_KEYS = {
  max_send: 'money_max_send_usd',
  daily: 'money_daily_cap_usd',
  boost_capital: 'boost_max_capital_usd',
  ms_max_send: 'master_spend_max_send_usd',
  ms_daily: 'master_spend_daily_cap_usd',
};

async function ownerGate(msg) {
  if (msg?.chat?.type !== 'private') return false;
  return requireOwner(msg.from?.id);
}

// W4 refusal polish (Class B): like ownerGate, but a non-owner in DM gets
// the uniform "🔒 Owner only." line instead of silence. (An owner using
// these in a group stays silent — they are DM-only by design.)
async function ownerGateRefuse(msg) {
  if (await ownerGate(msg)) return true;
  if (msg?.chat?.type === 'private' && msg?.from?.id && !(await requireOwner(msg.from.id))) {
    await sendDm(msg.from.id, '🔒 Owner only.');
  }
  return false;
}

export const MONEY_ADMIN_COMMANDS = {
  moneyops: async (chatId, _args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    await sendDm(msg.from.id, await moneyopsText());
  },
  // ── Master spend (capped engine) — owner DM only, catalog + /help only ──
  admindrop: async (chatId, args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    const uid = msg.from.id;
    const [addr, amt] = String(args ?? '').trim().split(/\s+/);
    const to = normalizeEvmAddress(String(addr ?? ''));
    const amountText = String(amt ?? '');
    let valid = !!to;
    try { valid = valid && parseDec(amountText) > 0n; } catch { valid = false; }
    if (!valid) {
      await sendDm(uid, 'Usage: /admindrop <0x address> <amount of $PBAI>\nSends $PBAI from the PB master wallet through the capped spend engine — arm flag, kill switch, allowlist and caps all apply.');
      return;
    }
    const res = await masterSpend({
      purpose: 'admin_drop', chain: 'base', asset: MASTER_SPEND_PBAI, to, amountText,
      initiatedBy: String(uid), detail: 'owner /admindrop',
    }).catch(() => ({ ok: false, status: 'failed', reason: 'engine_error' }));
    await auditMoney('money_admin', uid, 'admin_drop', `to=${to.slice(0, 10)}… amount=${amountText} ok=${!!res?.ok} reason=${res?.reason ?? ''}`);
    await sendDm(uid, spendResultText('Admin drop', res, amountText, '$PBAI', to));
  },
  seedgas: async (chatId, args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    const uid = msg.from.id;
    const [addr, amt] = String(args ?? '').trim().split(/\s+/);
    const to = normalizeEvmAddress(String(addr ?? ''));
    const amountText = String(amt ?? '');
    let valid = !!to;
    try { valid = valid && parseDec(amountText) > 0n; } catch { valid = false; }
    if (!valid) {
      await sendDm(uid, 'Usage: /seedgas <0x address> <ETH amount>\nSeeds gas from the PB master wallet through the capped spend engine (seed_gas_recovery) — arm flag, kill switch and caps all apply.');
      return;
    }
    const res = await masterSpend({
      purpose: 'seed_gas_recovery', chain: 'base', asset: 'native', to, amountText,
      initiatedBy: String(uid), detail: 'owner /seedgas',
    }).catch(() => ({ ok: false, status: 'failed', reason: 'engine_error' }));
    await auditMoney('money_admin', uid, 'seed_gas', `to=${to.slice(0, 10)}… amount=${amountText} ok=${!!res?.ok} reason=${res?.reason ?? ''}`);
    await sendDm(uid, spendResultText('Seed gas', res, amountText, 'ETH', to));
  },
  // FINISH MODE 2026-11-01 (smoke-test wave, add-only): owner DM only,
  // NO args by design — amount and recipient are hardcoded here so no
  // caller input can redirect a test send. 0.01 USDC, master -> watcher
  // receive wallet only, purpose smoke_test_internal (USDC-only, $1
  // purpose cap, watcher-only recipient guard, engine $10/$25 caps,
  // ledger + owner page all still apply). TEST-flagged in the detail
  // and in the Portal status; never revenue, never announced. NOT a
  // public command: it is only dispatched when added to the owner
  // dispatch list, exactly like admindrop/seedgas (see task note on
  // catalog). Do NOT run live until the wave's push is unblocked.
  smoketest: async (chatId, _args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    const uid = msg.from.id;
    const to = WATCHER_RECEIVE_ADDRESS;
    const amountText = '0.01';
    const res = await masterSpend({
      purpose: 'smoke_test_internal', chain: 'base', asset: MASTER_SPEND_USDC, to, amountText,
      initiatedBy: String(uid), detail: 'owner /smoketest TEST',
    }).catch(() => ({ ok: false, status: 'failed', reason: 'engine_error' }));
    await auditMoney('money_admin', uid, 'smoke_test', `to=${to.slice(0, 10)}… amount=${amountText} TEST ok=${!!res?.ok} reason=${res?.reason ?? ''}`);
    await sendDm(uid, spendResultText('Smoke test (TEST)', res, amountText, 'USDC', to));
  },
  armboost: async (chatId, args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    await armCommand('boost', args, msg);
  },
  armairdrop: async (chatId, args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    await armCommand('airdrop', args, msg);
  },
  moneycaps: async (chatId, args, msg) => {
    if (!(await ownerGateRefuse(msg))) return;
    const uid = msg.from.id;
    const [key, value] = String(args ?? '').trim().split(/\s+/);
    if (!key) {
      await sendDm(uid, [
        '💲 Money caps',
        `per-send (max_send): $${await maxSendUsd()}`,
        `daily (daily): $${await dailyCapUsd()}`,
        `boost capital (boost_capital): $${await maxBoostCapitalUsd()}`,
        `master spend per-send (ms_max_send): $${await masterSpendMaxSendUsd()}`,
        `master spend daily (ms_daily): $${await masterSpendDailyCapUsd()}`,
        '',
        'Set with: /moneycaps <name> <usd>',
      ].join('\n'));
      return;
    }
    const configKey = CAP_KEYS[key];
    const n = Number(value);
    if (!configKey || !Number.isFinite(n) || n < 0) {
      await sendDm(uid, 'Usage: /moneycaps <max_send|daily|boost_capital|ms_max_send|ms_daily> <usd amount ≥ 0>');
      return;
    }
    await setMoneyConfig(configKey, n);
    await auditMoney('money_admin', uid, 'cap_set', `${configKey}=${n}`);
    await sendDm(uid, `✅ Cap updated: ${key} = $${n}`);
  },
};

// ══ Revenue-to-master seeding — RECORD + GATE ONLY (overnight build, 2026-10-25) ══
// Local only, unpushed. Read this header before wiring it anywhere:
//   - A verified settled customer payment is the ONLY input that can create
//     a seed record. The caller must pass the Worker's settle proof (checkout
//     id, settle status, tx hash, amount, currency, chain) and this function
//     re-checks every field below. An unverified / unsettled / mismatched
//     payment is refused, never recorded.
//   - This function MOVES NO FUNDS and signs NOTHING. The watcher is
//     receive-only by design and no receive-wallet signer exists in this
//     tree, so the actual sweep from the receiving wallet into the master
//     is a separate, owner-executed step that is NOT automated here.
//     recordRevenueSeed() proves eligibility, caps the amount, writes one
//     ledger row per seed, and returns status 'recorded_pending_sweep'.
//     Anyone who wires an automatic sweep onto this record without a
//     Rowdy-approved receive-wallet signing key has built a new power,
//     which this build deliberately does not do.
//   - Treasury $PBAI is NEVER a seed asset: a $PBAI settlement is refused
//     outright (treasury_never). Destination is ALWAYS the master wallet;
//     any other destination is refused (wrong_destination).
//   - Caps reuse the masterSpend caps ($10/send, $25/day by default) and
//     stablecoins only (USDC/USDT): SOL/native settlements are refused in
//     v1 because their USD value needs a live price this gate does not
//     invent (stablecoin_usd_only).
//   - Kill switch: config 'revenue_seed_kill' ON refuses everything.
//     Enable flag: config 'revenue_seed_enabled' — ships OFF (unset = OFF).
//   - Idempotency: one seed record per checkout id, ever. A second call
//     for the same checkout returns the existing record, never a second row.
//   - Auto-arm: this build does NOT flip any arm flag. seedArmReadiness()
//     only EVALUATES readiness and returns armAction 'none': no tool's
//     individual gate (boost/airdrop canary, Studio BFM) may be bypassed
//     by a seed, and the USD threshold that would count as "seeded enough"
//     is config 'revenue_seed_arm_threshold_usd' with NO default — Rowdy
//     must name it. Until he does, armReady is always false.
//   - State lives in the existing config table (revenue_seed:<checkoutId>
//     JSON + revenue_seed_day:<YYYY-MM-DD> USD total) so this build needs
//     NO schema change and NO migrate. The ledger row goes to the existing
//     master_spend_ledger with purpose 'revenue_seed' and status 'seeded',
//     which the spend-cap sums exclude (they count pending/sent/confirmed
//     only), so a seed record can never inflate or consume spend caps.
// Stablecoin settlements only, in USD. Amounts are decimal strings; compare
// in integer cents to avoid float drift.
const REVENUE_SEED_STABLES = new Set(['USDC', 'USDT']);
const REVENUE_SEED_CHAINS = new Set(['base', 'solana']);

function seedCents(amountUsd) {
  const s = String(amountUsd ?? '').trim();
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

function seedDayKey(nowMs) {
  const d = new Date(nowMs);
  return `revenue_seed_day:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function defaultSeedStore() {
  return {
    get: async (checkoutId) => {
      const raw = await getConfig(`revenue_seed:${checkoutId}`, null).catch(() => null);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    set: async (checkoutId, record) => {
      await setConfig(`revenue_seed:${checkoutId}`, JSON.stringify(record));
    },
    dayTotalCents: async (dayKey) => {
      const raw = await getConfig(dayKey, '0').catch(() => '0');
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    },
    addDayTotalCents: async (dayKey, cents) => {
      const cur = await defaultSeedStore().dayTotalCents(dayKey);
      await setConfig(dayKey, String(cur + cents));
    },
    ledgerInsert: async (row) => ledgerInsertRow(row),
  };
}

function seedDeps(deps = {}) {
  return {
    store: deps.store ?? defaultSeedStore(),
    getFlag: deps.getFlag ?? flag,
    maxSendUsd: deps.maxSendUsd ?? masterSpendMaxSendUsd,
    dailyCapUsd: deps.dailyCapUsd ?? masterSpendDailyCapUsd,
    getThresholdUsd: deps.getThresholdUsd ?? (async () => {
      const raw = await getConfig('revenue_seed_arm_threshold_usd', null).catch(() => null);
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    }),
    cumulativeSeedUsd: deps.cumulativeSeedUsd ?? (async () => {
      const raw = await getConfig('revenue_seed_cumulative_usd', '0').catch(() => '0');
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }),
    addCumulativeUsd: deps.addCumulativeUsd ?? (async (usd) => {
      const raw = await getConfig('revenue_seed_cumulative_usd', '0').catch(() => '0');
      const cur = Number(raw);
      await setConfig('revenue_seed_cumulative_usd', String((Number.isFinite(cur) ? cur : 0) + usd));
    }),
    now: deps.now ?? (() => Date.now()),
    audit: deps.audit ?? auditMoney,
  };
}

/** Evaluate whether seeded revenue reaches the (owner-named) arm threshold. Never flips a flag. */
export async function seedArmReadiness(deps = {}) {
  const d = seedDeps(deps);
  const threshold = await d.getThresholdUsd();
  if (threshold == null) return { armReady: false, reason: 'threshold_unset', armAction: 'none' };
  const cumulative = await d.cumulativeSeedUsd();
  return {
    armReady: cumulative >= threshold,
    cumulativeUsd: cumulative,
    thresholdUsd: threshold,
    armAction: 'none',
    reason: cumulative >= threshold ? 'threshold_met_flags_not_flipped' : 'below_threshold',
  };
}

/**
 * Record a verified revenue seed. settled = { checkoutId, status, amountUsd,
 * currency, chain, txHash, customerTelegramId?, toAddress? }.
 * status must be the Worker's settle status for a PAID checkout
 * ('paid' | 'settled' | 'paid_unclaimed' — the claim-bridge state, settled
 * at the Worker, is still a settled payment; 'claimed' alone is not).
 * Returns { ok, status, reason?, seed? } — never throws on a refusal.
 */
export async function recordRevenueSeed(settled = {}, deps = {}) {
  const d = seedDeps(deps);
  const checkoutId = String(settled?.checkoutId ?? '').trim();
  const fail = (reason) => ({ ok: false, status: 'refused', reason });
  if (await d.getFlag('revenue_seed_kill')) return fail('seed_kill_on');
  if (!(await d.getFlag('revenue_seed_enabled'))) return fail('seed_disabled');
  if (!checkoutId) return fail('missing_checkout_id');
  if (!['paid', 'settled', 'paid_unclaimed'].includes(String(settled?.status ?? ''))) return fail('not_settled');
  if (!String(settled?.txHash ?? '').trim()) return fail('missing_tx_hash');
  const currency = String(settled?.currency ?? '').toUpperCase();
  if (!REVENUE_SEED_STABLES.has(currency)) return fail('stablecoin_usd_only');
  const chain = String(settled?.chain ?? '').toLowerCase();
  if (!REVENUE_SEED_CHAINS.has(chain)) return fail('chain_not_supported');
  const asset = String(settled?.asset ?? settled?.token ?? currency);
  if (asset.toLowerCase() === MASTER_SPEND_PBAI) return fail('treasury_never');
  const to = String(settled?.toAddress ?? MASTER_WALLET_ADDRESS).toLowerCase();
  if (to !== MASTER_WALLET_ADDRESS) return fail('wrong_destination');
  const cents = seedCents(settled?.amountUsd);
  if (cents == null || cents <= 0) return fail('bad_amount');
  const usd = cents / 100;
  const existing = await d.store.get(checkoutId).catch(() => null);
  if (existing) return { ok: true, status: 'already_recorded', seed: existing };
  const maxSend = await d.maxSendUsd();
  if (usd > maxSend) return fail('per_send_cap');
  const dailyCap = await d.dailyCapUsd();
  const dayKey = seedDayKey(d.now());
  const dayTotal = await d.store.dayTotalCents(dayKey).catch(() => 0);
  if ((dayTotal + cents) / 100 > dailyCap) return fail('daily_cap');
  const seed = {
    checkoutId, status: 'recorded_pending_sweep', amountUsd: usd, currency, chain,
    txHash: String(settled.txHash), customerTelegramId: settled?.customerTelegramId != null ? String(settled.customerTelegramId) : null,
    toAddress: MASTER_WALLET_ADDRESS, recordedAt: new Date(d.now()).toISOString(),
  };
  try {
    await d.store.ledgerInsert({
      purpose: 'revenue_seed', chain, asset: currency.toLowerCase(), toAddress: MASTER_WALLET_ADDRESS,
      amountText: String(usd), amountUsd: usd, usdPrice: 1, status: 'seeded', refusalReason: null,
      txHash: String(settled.txHash), initiatedBy: 'system:revenue_seed', detail: `checkout:${checkoutId}`,
    });
  } catch { return fail('ledger_write_failed'); }
  await d.store.set(checkoutId, seed).catch(() => {});
  await d.store.addDayTotalCents(dayKey, cents).catch(() => {});
  await d.addCumulativeUsd(usd).catch(() => {});
  await d.audit('money_admin', settled?.customerTelegramId ?? 'system', 'revenue_seed_recorded',
    `checkout=${checkoutId} amount=${usd} ${currency} chain=${chain} tx=${String(settled.txHash).slice(0, 16)}`).catch(() => {});
  const readiness = await seedArmReadiness({ ...deps, cumulativeSeedUsd: d.cumulativeSeedUsd, getThresholdUsd: d.getThresholdUsd }).catch(() => ({ armReady: false, armAction: 'none' }));
  return { ok: true, status: 'recorded_pending_sweep', seed, armReady: readiness.armReady, armAction: 'none' };
}
