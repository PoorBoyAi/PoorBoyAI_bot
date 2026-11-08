// Airdrop platform — port of the original paid airdrop system (design
// PB-BOOST-AIRDROP-DESIGN §2.2/§2.3/§5). Army Drop + Custom List, signed
// quotes, snapshotted recipients, deposit watching, dry-run distribution
// planning, and the 1,000 PBAI welcome-drop claim ledger.
//
// Source-true to: airdrop-quote.ts, airdrop-distributor.ts,
// airdrop-deposit-watcher.ts, airdrop-network-quote.ts, routes/airdrops.ts,
// lib/constants (fees/caps), welcome-airdrop rules.
//
// PHASE 2 HARD RULE: no signing, no broadcasting exists in this module.
// Funded campaigns are PLANNED (transfer intents persisted as 'planned')
// and parked at 'awaiting_arm'. Fee payment: benefit-covered ($0) fees
// confirm automatically; other fees confirm via owner verification
// (/dropfee). No checkout is wired — XRocket is retired, not a fee path.
// Signer Phase 2 (this build) adds the bridge: claim assembly + outcome
// ingestion for the host-side signer worker (signer-worker DESIGN §1–§3).
// Signing lives ONLY in that worker; this module assembles deposit-class
// claims (ciphertext only) and applies reported outcomes. Every arm gate
// stays exactly as moneyguard defines it — no code here writes the flags.
// Masterspend wave (2026-10-22): this module still signs nothing itself;
// it CALLS the capped master-spend engine (lib/moneyguard.js masterSpend)
// for two PB-funded purposes — welcome_drop fulfilment at claim time and
// deposit_gas_float when claim assembly finds a zero-gas deposit wallet.

import { api, fetch } from 'sdk';
import db, { eq, and, desc, sql, gte, lte, inArray } from 'sdk/db';
import {
  airdrop_campaigns, airdrop_recipients, airdrop_transfers, airdrop_benefits,
  welcome_airdrop_claims, user_wallets, bot_users, pbai_holder_wallets, raid_xp,
  buy_events, buy_watch_state, buy_rewards_days, buy_rewards_ledger,
} from '../schema.js';
import { getConfig, setConfig, getConfigFlag } from './config.js';
import { sha256Hex, hmacHex } from './mcpkeys.js';
import {
  isValidEvmAddress, isValidSolAddress, normalizeEvmAddress,
  base58Encode, base58Decode, generateEvmKeypair, generateSolKeypair,
  vaultEncrypt, tokenBalance, nativeBalance, nativeUsdPrice, evmGasPriceWei,
  evmTokenDecimals, evmLatestBlock, evmTransferLogs, solMintDecimals,
  solLargestTokenAccounts, CHAINS,
  decCmp, decMulInt, decSum, decAdd, decSub, evmFirstBlockAtOrAfter, fmtDec,
} from './walletvault.js';
import {
  isAirdropEnabled, isAirdropArmed, auditMoney,
  alertOwner, checkCaps, maxSendUsd, dailyCapUsd, plannedUsdToday,
  isAirdropChainEnabled, isAirdropChainArmed, requireOwner,
  masterSpend, sendSalesReceipt,
} from './moneyguard.js';
import { fetchTokenByAddress } from './market.js';
import { peekTrialAirdropWaiver, consumeTrialAirdropWaiver, TRIAL_WAIVER_MAX_WALLETS, listCalendar, bookCalendarSlot, getCalendarBooking, calendarSlotLabel } from './tiers.js';

// ── Constants (verbatim: lib/constants/src/index.ts) ────────────────────────

export const AIRDROP_RUN_RECIPIENT_CAP = 10_000;
export const AIRDROP_QUOTE_TTL_SECONDS = 15 * 60;
export const AIRDROP_ARMY_ONE_CHAIN_USD = 49;
export const AIRDROP_ARMY_ALL_THREE_USD = 79;
export const AIRDROP_CUSTOM_BASE_FEE_USD = 9;
export const AIRDROP_CUSTOM_RATE_USD = 0.03;
export const AIRDROP_AGENCY_RATE_USD = 0.02;
export const WELCOME_AIRDROP_AMOUNT = '1000';
export const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e'; // verified $PBAI on Base

// W1 (multi-chain spec §4.6/§9): the six expansion EVM chains are admitted
// to the plumbing. Admission is NOT opening — a chain takes campaigns only
// while its per-chain layer is enabled (airdrop_chain_<key>_enabled, §6.2),
// enforced at creation and again at claim assembly.
export const AIRDROP_CHAINS = ['base', 'sol', 'rh', 'ethereum', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'];
// 'all' stays the original three-chain Army bundle (verbatim pricing:
// AIRDROP_ARMY_ALL_THREE_USD) — the W1 chains join as single-chain options
// only; they are not silently folded into the grouped product.
export const AIRDROP_GROUP_CHAINS = ['base', 'sol', 'rh'];

// ── Recipient parsing (port of airdrop-quote.ts) ────────────────────────────
// EVM canonicalization deviation (design §4): addresses normalize to
// lowercase instead of EIP-55 checksummed — dedupe keys in the original
// were lowercase too; checksumming is display-only. Solana canonical form
// is the base58 re-encode of the decoded 32 bytes (PublicKey equivalent).

const MAX_WALLET_INPUT_CHARS = 2_000_000;
const MAX_WALLET_CELLS = 50_000;

function parseStandardCsv(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let quoteClosed = false;
  let cellStarted = false;
  const finishCell = () => { row.push(cell.trim()); cell = ''; cellStarted = false; quoteClosed = false; };
  const finishRow = () => { finishCell(); if (row.some(Boolean)) rows.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; quoteClosed = true; }
      } else cell += char;
      continue;
    }
    if (char === '"') {
      if (cellStarted || cell.trim()) throw new Error('addresses contains malformed CSV quoting');
      quoted = true; cellStarted = true;
    } else if (quoteClosed && !/\s/.test(char) && char !== ',' && char !== '\n' && char !== '\r') {
      throw new Error('addresses contains malformed CSV quoting');
    } else if (char === ',') finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      finishRow();
    } else {
      cell += char;
      cellStarted = cellStarted || !/\s/.test(char);
    }
    if (rows.length > MAX_WALLET_CELLS || row.length > MAX_WALLET_CELLS) {
      throw new Error('addresses contains too many CSV cells');
    }
  }
  if (quoted) throw new Error('addresses contains an unterminated CSV quote');
  finishRow();
  return rows;
}

function parseWalletInput(input) {
  if (Array.isArray(input)) return {
    values: input.flatMap((v) => (typeof v === 'string' ? [v.trim()] : [])).filter(Boolean),
    csvRows: null,
  };
  if (typeof input !== 'string') throw new Error('addresses must be a string or an array of strings');
  if (input.length > MAX_WALLET_INPUT_CHARS) throw new Error('addresses input is too large');
  const trimmed = input.trim();
  if (!trimmed) return { values: [], csvRows: null };
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error();
      return parseWalletInput(parsed);
    } catch { throw new Error('addresses contains invalid JSON'); }
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  const csvHeaderNames = firstLine.split(',')
    .map((cell) => cell.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const approvedHeaderPresent = csvHeaderNames.some((name) => [
    'address', 'wallet', 'wallet_address', 'recipient', 'recipient_address',
    'destination', 'destination_address',
  ].includes(name));
  const clearlyHeadered = csvHeaderNames.length > 1 &&
    csvHeaderNames.every((name) => /^[a-z][a-z0-9_]*$/i.test(name));
  const clearlySingleColumnHeader = csvHeaderNames.length === 1 &&
    /^[a-z][a-z0-9_]*$/i.test(csvHeaderNames[0]) &&
    csvHeaderNames[0].includes('_');
  const csvLike = trimmed.includes('"') || approvedHeaderPresent || clearlyHeadered || clearlySingleColumnHeader;
  if (csvLike) {
    const csvRows = parseStandardCsv(trimmed);
    return { values: csvRows.flat(), csvRows };
  }
  return { values: trimmed.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean), csvRows: null };
}

export const splitWalletInput = (input) => parseWalletInput(input).values;

function canonicalizeAddress(chain, raw) {
  if (chain === 'sol') {
    const bytes = base58Decode(raw);
    return bytes && bytes.length === 32 ? base58Encode(bytes) : null;
  }
  return normalizeEvmAddress(raw);
}

export function validateWalletInput(chain, input) {
  const parsed = parseWalletInput(input);
  const values = parsed.values;
  const addresses = [];
  const invalid = [];
  const seen = new Set();
  let duplicateCount = 0;
  const accept = (canonical) => {
    const key = chain === 'sol' ? canonical : canonical.toLowerCase();
    if (seen.has(key)) duplicateCount++;
    else { seen.add(key); addresses.push(canonical); }
  };
  if (parsed.csvRows) {
    const normalizedHeader = (cell) => cell.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const recipientHeaders = new Set([
      'address', 'wallet', 'wallet_address', 'recipient', 'recipient_address',
      'destination', 'destination_address',
    ]);
    const header = parsed.csvRows[0] ?? [];
    const recognized = header
      .map(normalizedHeader)
      .map((name, index) => (recipientHeaders.has(name) ? index : -1))
      .filter((index) => index >= 0);
    if (recognized.length > 1) throw new Error('CSV has more than one recipient address column');
    const firstRowHasAddress = header.some((cell) => canonicalizeAddress(chain, cell) !== null);
    const genericHeader = !firstRowHasAddress && header.some((cell) => /[a-z_]/i.test(cell));
    if (genericHeader && recognized.length !== 1) {
      throw new Error('CSV must contain exactly one approved recipient address column');
    }
    const dataRows = recognized.length || genericHeader ? parsed.csvRows.slice(1) : parsed.csvRows;
    for (const row of dataRows) {
      const validCells = recognized.length
        ? [canonicalizeAddress(chain, row[recognized[0]] ?? '')].filter((v) => v !== null)
        : row.map((c) => canonicalizeAddress(chain, c)).filter((v) => v !== null);
      if (validCells.length > 1) throw new Error('CSV row has multiple wallet addresses; choose one recipient column');
      if (validCells.length === 1) accept(validCells[0]);
      else if (recognized.length && (row[recognized[0]] ?? '').trim()) invalid.push(row[recognized[0]]);
      else if (!recognized.length && row.some(Boolean)) invalid.push(row.join(','));
    }
  } else {
    for (const raw of values) {
      const canonical = canonicalizeAddress(chain, raw);
      if (canonical) accept(canonical);
      else invalid.push(raw);
    }
  }
  if (values.length > MAX_WALLET_CELLS) throw new Error('addresses contains too many values');
  if (addresses.length > AIRDROP_RUN_RECIPIENT_CAP) {
    throw new Error(`Airdrop runs are limited to ${AIRDROP_RUN_RECIPIENT_CAP.toLocaleString()} valid unique wallets`);
  }
  return { addresses, inputCount: values.length, validCount: addresses.length, duplicateCount, invalidCount: invalid.length, invalid };
}

export const recipientDigest = (chain, addresses) =>
  sha256Hex(`${chain}\n${addresses.join('\n')}`);

/** Merge registered pool + customer list; stable sorted order (original). */
export function mergeAirdropRecipients(chain, registered, added) {
  const merged = new Map();
  const keyFor = (w) => (chain === 'sol' ? w : w.toLowerCase());
  for (const r of registered) {
    const key = keyFor(r.wallet_address);
    if (!merged.has(key)) merged.set(key, r);
  }
  for (const wallet_address of added) {
    const key = keyFor(wallet_address);
    if (!merged.has(key)) merged.set(key, { wallet_address, telegram_user_id: '' });
  }
  return [...merged.values()].sort((a, b) => keyFor(a.wallet_address).localeCompare(keyFor(b.wallet_address)));
}

export async function recipientSnapshotDigest(chain, recipients) {
  const canonical = recipients.map((r) => ({
    wallet: chain === 'sol' ? base58Encode(base58Decode(r.wallet_address)) : r.wallet_address.toLowerCase(),
    telegramUserId: String(r.telegram_user_id ?? ''),
  })).sort((a, b) => a.wallet.localeCompare(b.wallet) || a.telegramUserId.localeCompare(b.telegramUserId));
  return sha256Hex(JSON.stringify({ version: 1, chain, recipients: canonical }));
}

// ── Fees + tier benefits (verbatim: airdrop-quote.ts tierAirdropBenefit) ───

export function customListGrossFee(validCount, rateUsd = AIRDROP_CUSTOM_RATE_USD) {
  if (!Number.isInteger(validCount) || validCount < 0 || validCount > AIRDROP_RUN_RECIPIENT_CAP) {
    throw new Error('Invalid recipient count');
  }
  return Number((AIRDROP_CUSTOM_BASE_FEE_USD + validCount * rateUsd).toFixed(2));
}

export function tierAirdropBenefit(tier) {
  const canonical = ({
    poor: 'builder', hustler: 'builder', grinder: 'pro',
    chad: 'agency', whale: 'agency', dev_launch: 'agency',
  })[tier] ?? tier;
  const benefits = {
    starter: { customCreditUsd: 0, armyDrops: 0, armyFairUse: false, customRateUsd: AIRDROP_CUSTOM_RATE_USD, creditSharesArmyAllowance: false },
    builder: { customCreditUsd: 20, armyDrops: 0, armyFairUse: false, customRateUsd: AIRDROP_CUSTOM_RATE_USD, creditSharesArmyAllowance: false },
    pro: { customCreditUsd: 40, armyDrops: 1, armyFairUse: false, customRateUsd: AIRDROP_CUSTOM_RATE_USD, creditSharesArmyAllowance: true },
    agency: { customCreditUsd: 0, armyDrops: 0, armyFairUse: true, customRateUsd: AIRDROP_AGENCY_RATE_USD, creditSharesArmyAllowance: false },
    // TRIALPOLICY 2026-11-01 (#13): 'one' IS the paid tier ($29 PB Plan),
    // so it carries the paid-tier per-wallet break: $0.02/wallet (the
    // agency rate), standard $0.03, $9 base unchanged. No monthly
    // credit and no Army benefit are granted here — the decision
    // covers the per-wallet rate only.
    one: { customCreditUsd: 0, armyDrops: 0, armyFairUse: false, customRateUsd: AIRDROP_AGENCY_RATE_USD, creditSharesArmyAllowance: false },
  };
  return benefits[canonical] ?? {
    customCreditUsd: 0, armyDrops: 0, armyFairUse: false,
    customRateUsd: AIRDROP_CUSTOM_RATE_USD, creditSharesArmyAllowance: false,
  };
}

export const currentBenefitMonth = (now = new Date()) =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

export async function getBenefitUsage(tgId, month = currentBenefitMonth()) {
  try {
    const row = await db.select().from(airdrop_benefits)
      .where(and(eq(airdrop_benefits.telegramUserId, String(tgId)), eq(airdrop_benefits.month, month))).get();
    return { customCreditUsedCents: row?.customCreditUsedCents ?? 0, armyUsed: !!row?.armyUsed };
  } catch { return { customCreditUsedCents: 0, armyUsed: false }; }
}

/**
 * Price a campaign's service fee with tier benefits applied.
 * Returns { grossFeeUsd, creditAppliedUsd, serviceFeeUsd, benefit } where
 * benefit describes what CREATING this campaign would consume
 * ({ type: 'army' } | { type: 'credit', usd } | null) — recorded once at
 * campaign creation (recordBenefitUse), never at quote display.
 */
export function priceWithBenefits({ tier, mode, chain, validCount, usage }) {
  const benefit = tierAirdropBenefit(tier);
  if (mode === 'army') {
    const gross = chain === 'all' ? AIRDROP_ARMY_ALL_THREE_USD : AIRDROP_ARMY_ONE_CHAIN_USD;
    const freeViaBenefit = benefit.armyFairUse
      || (benefit.armyDrops > 0 && !usage.armyUsed
        && (!benefit.creditSharesArmyAllowance || usage.customCreditUsedCents === 0));
    return {
      grossFeeUsd: gross,
      creditAppliedUsd: freeViaBenefit ? gross : 0,
      serviceFeeUsd: freeViaBenefit ? 0 : gross,
      benefitUse: freeViaBenefit ? { type: 'army' } : null,
      benefit,
    };
  }
  const gross = customListGrossFee(validCount, benefit.customRateUsd);
  let creditAvailable = Math.max(0, benefit.customCreditUsd - usage.customCreditUsedCents / 100);
  if (benefit.creditSharesArmyAllowance && usage.armyUsed) creditAvailable = 0;
  const creditApplied = Math.min(creditAvailable, gross);
  return {
    grossFeeUsd: gross,
    creditAppliedUsd: Number(creditApplied.toFixed(2)),
    serviceFeeUsd: Number((gross - creditApplied).toFixed(2)),
    benefitUse: creditApplied > 0 ? { type: 'credit', usd: Number(creditApplied.toFixed(2)) } : null,
    benefit,
  };
}

async function recordBenefitUse(tgId, month, benefitUse) {
  if (!benefitUse) return;
  const usage = await getBenefitUsage(tgId, month);
  const next = {
    customCreditUsedCents: usage.customCreditUsedCents + (benefitUse.type === 'credit' ? Math.round(benefitUse.usd * 100) : 0),
    armyUsed: usage.armyUsed || benefitUse.type === 'army',
  };
  const existing = await db.select().from(airdrop_benefits)
    .where(and(eq(airdrop_benefits.telegramUserId, String(tgId)), eq(airdrop_benefits.month, month))).get().catch(() => null);
  if (existing) {
    await db.update(airdrop_benefits).set({
      customCreditUsedCents: next.customCreditUsedCents, armyUsed: next.armyUsed, updatedAt: new Date(),
    }).where(and(eq(airdrop_benefits.telegramUserId, String(tgId)), eq(airdrop_benefits.month, month))).run();
  } else {
    await db.insert(airdrop_benefits).values({
      telegramUserId: String(tgId), month,
      customCreditUsedCents: next.customCreditUsedCents, armyUsed: next.armyUsed,
    }).run();
  }
}

// ── Quote sign/verify (verbatim semantics: airdrop-quote.ts) ────────────────

async function airdropQuoteSecret() {
  const s = (await getConfig('SESSION_SECRET', null)) ?? (await getConfig('BOOSTER_ENCRYPTION_KEY', null));
  if (!s || String(s).trim().length < 16) throw new Error('Airdrop quote signing is unavailable');
  return String(s).trim();
}

export async function signAirdropQuote(payload) {
  return hmacHex(await airdropQuoteSecret(), JSON.stringify(payload));
}

export async function verifyAirdropQuote(payload, signature, now = new Date()) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = await signAirdropQuote(payload);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return false;
  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  return Number.isFinite(issued) && Number.isFinite(expires)
    && issued <= now.getTime() + 30_000
    && expires > now.getTime()
    && expires - issued === AIRDROP_QUOTE_TTL_SECONDS * 1000;
}

// ── Registered pool ("the Army") + reserve estimation ───────────────────────

// §4.3: every EVM key resolves via baseAddress — one EVM address receives
// on all EVM chains. RH keeps its dedicated column per the standing rule
// (RH stays its own field), and sol keeps solAddress.
const POOL_COLUMN = {
  base: 'baseAddress', sol: 'solAddress', rh: 'rhAddress',
  ethereum: 'baseAddress', arbitrum: 'baseAddress', optimism: 'baseAddress',
  polygon: 'baseAddress', bnb: 'baseAddress', avalanche: 'baseAddress',
};

/** The registered receiving-wallet pool for a chain, from user_wallets. */
export async function registeredPool(chain) {
  const col = POOL_COLUMN[chain];
  if (!col) return [];
  const rows = await db.select().from(user_wallets).all().catch(() => []);
  const out = [];
  for (const r of rows) {
    const addr = r[col];
    if (addr) out.push({ wallet_address: addr, telegram_user_id: r.telegramUserId });
  }
  return out;
}

/** Network reserve estimate (port of airdrop-network-quote.ts's model):
 *  EVM — per-recipient ERC-20 transfer gas at live gas price × 1.25 buffer;
 *  Solana — per-recipient signature fee + ATA-creation share for new holders. */
export async function estimateAirdropReserveUsd(chain, recipientCount, deps = {}) {
  const price = await (deps.nativeUsdPrice ?? nativeUsdPrice)(chain);
  if (chain === 'sol') {
    const sol = recipientCount * (0.000005 + 0.002039 * 0.35); // fee + expected-new-ATA share
    return Number((sol * price * 1.25).toFixed(2));
  }
  const gasPrice = await (deps.gasPriceWei ?? evmGasPriceWei)(chain);
  const gasPerTransfer = 50_000n;
  const eth = Number(gasPrice * gasPerTransfer * BigInt(recipientCount)) / 1e18;
  return Number((eth * price * 1.25).toFixed(2));
}

// ── Army pool — the original's three-way merge (routes/airdrops.ts
// snapshotWallets, signer DESIGN §8.3): $PBAI holders ∪ registered ∪
// raid/XP participants, canonicalized + deduped per chain. Telegram
// linkage precedence matches the original's SQL: the registered-wallet
// row wins, then the raid_xp row, then the holder row's own link.
// RH is registered-only, exactly like the original (no holder/raid leg).
// W1 (§4.3): on non-Base EVM chains the holder leg still reads the Base
// $PBAI holder snapshot — those ARE the same addresses on the target
// chain, but the leg is the $PBAI holder set, never holders of the
// campaign's token on that chain (that is tokenHolderSnapshot's job).
export async function armyPool(chain, deps = {}) {
  if (!POOL_COLUMN[chain]) return []; // forged/unknown chain: no pool, ever
  const byKey = new Map();
  const keyFor = (a) => (chain === 'sol' ? a : a.toLowerCase());
  const add = (rawAddr, tgId, source) => {
    if (!rawAddr) return;
    const canonical = canonicalizeAddress(chain, String(rawAddr));
    if (!canonical) return;
    const key = keyFor(canonical);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { wallet_address: canonical, telegram_user_id: tgId ? String(tgId) : '', source });
    } else if (!existing.telegram_user_id && tgId) {
      existing.telegram_user_id = String(tgId);
    }
  };
  const userWallets = deps.userWallets ?? (await db.select().from(user_wallets).all().catch(() => []));
  const registeredByKey = new Map();
  for (const r of userWallets) {
    const addr = r[POOL_COLUMN[chain]];
    if (addr) {
      const canonical = canonicalizeAddress(chain, String(addr));
      if (canonical) registeredByKey.set(keyFor(canonical), r.telegramUserId);
    }
  }
  if (chain === 'rh') {
    // Registered-only, exactly like the original. Keys are the canonical
    // (lowercase) EVM addresses themselves.
    for (const [key, tgId] of registeredByKey) {
      byKey.set(key, { wallet_address: key, telegram_user_id: tgId ? String(tgId) : '', source: 'registered' });
    }
    return [...byKey.values()].sort((a, b) => a.wallet_address.localeCompare(b.wallet_address));
  }
  if (chain !== 'sol') {
    const holders = deps.holders ?? (await db.select().from(pbai_holder_wallets).all().catch(() => []));
    for (const h of holders) add(h.baseAddress, h.telegramUserId, 'holder');
  }
  for (const [key, tgId] of registeredByKey) add(key, tgId, 'registered');
  const raidRows = deps.raidXp ?? (await db.select().from(raid_xp).all().catch(() => []));
  for (const r of raidRows) {
    const addr = r.walletAddress;
    if (!addr) continue;
    const isEvm = String(addr).startsWith('0x');
    if (chain === 'sol' ? isEvm : !isEvm) continue; // original's ILIKE split
    add(addr, r.userId, 'raid_xp');
  }
  return [...byKey.values()].sort((a, b) => keyFor(a.wallet_address).localeCompare(keyFor(b.wallet_address)));
}

// ── Token-holder snapshots (chain data) ─────────────────────────────────────
// "Airdrop to holders of X": a point-in-time holder set for an arbitrary
// token. EVM walks Transfer logs in bounded chunks (the original
// pbai-holder-sync mechanism, generalized) — full history unless the chunk
// budget truncates the walk, which is reported honestly via `complete`.
// Solana has no log-walk equivalent at this weight: the snapshot is the
// mint's largest token accounts (top-20) and is ALWAYS partial.

// Per-chain walk parameters (spec §4.3): the chunk span is bounded by what
// each chain's public RPC tolerates in one eth_getLogs call, the chunk
// budget by the history worth walking at that chain's block time
// (Base ~14d, Ethereum ~83d, Polygon ~14d, BNB ~21d at the legacy spans).
// Arbitrum's 0.25s blocks need far more, smaller-span chunks to cover
// useful history (2M blocks ≈ 6d); BSC/Polygon free endpoints cap ranges
// harder, so their spans shrink and their budgets double. However the
// walk ends, `complete` stays false unless the wanted start was reached.
export const SNAPSHOT_PARAMS = {
  base: { chunkBlocks: 10_000, maxChunks: 60 },
  rh: { chunkBlocks: 10_000, maxChunks: 60 },
  ethereum: { chunkBlocks: 10_000, maxChunks: 60 },
  arbitrum: { chunkBlocks: 2_000, maxChunks: 1_000 },
  optimism: { chunkBlocks: 10_000, maxChunks: 60 },
  polygon: { chunkBlocks: 5_000, maxChunks: 120 },
  bnb: { chunkBlocks: 5_000, maxChunks: 120 },
  avalanche: { chunkBlocks: 10_000, maxChunks: 60 },
};

// One range read with rejection tolerance (spec §4.3): when a provider
// refuses a span, halve it and read the halves; a span at/below the floor
// that still fails is a real failure and propagates — never swallowed,
// never silently marked covered.
const SNAPSHOT_HALVE_FLOOR = 100;
async function transferLogsRanged(getLogs, chain, tokenCa, start, end) {
  try {
    return await getLogs(chain, tokenCa, start, end);
  } catch (err) {
    if (end - start <= SNAPSHOT_HALVE_FLOOR) throw err;
    const mid = start + Math.floor((end - start) / 2);
    const left = await transferLogsRanged(getLogs, chain, tokenCa, start, mid);
    const right = await transferLogsRanged(getLogs, chain, tokenCa, mid + 1, end);
    return left.concat(right);
  }
}

export async function tokenHolderSnapshot(chain, tokenCa, deps = {}) {
  if (chain === 'sol') {
    const largest = await (deps.largestAccounts ?? solLargestTokenAccounts)(tokenCa);
    const holders = largest
      .filter((a) => Number(a.amount) > 0)
      .map((a) => ({ wallet_address: a.owner, balance: String(a.amount) }));
    return { holders, complete: false, source: 'largest_accounts', token: tokenCa, chain };
  }
  const getLogs = deps.getLogs ?? evmTransferLogs;
  const latestBlock = deps.latestBlock ?? evmLatestBlock;
  const params = SNAPSHOT_PARAMS[chain] ?? SNAPSHOT_PARAMS.base;
  const chunkBlocks = deps.chunkBlocks ?? params.chunkBlocks;
  const maxChunks = deps.maxChunks ?? params.maxChunks;
  const toBlock = deps.toBlock ?? (await latestBlock(chain));
  const fromBlockWanted = deps.fromBlock ?? 0;
  const balances = new Map();
  let chunks = 0;
  let cursor = toBlock;
  let complete = false;
  while (cursor >= fromBlockWanted && chunks < maxChunks) {
    const start = Math.max(fromBlockWanted, cursor - chunkBlocks + 1);
    const logs = await transferLogsRanged(getLogs, chain, tokenCa, start, cursor);
    for (const log of logs) {
      const from = log?.topics?.[1] ? '0x' + String(log.topics[1]).slice(-40) : null;
      const to = log?.topics?.[2] ? '0x' + String(log.topics[2]).slice(-40) : null;
      let value = 0n;
      try { value = BigInt(log?.data ?? '0x0'); } catch { value = 0n; }
      if (from && !/^0x0{40}$/.test(from)) balances.set(from.toLowerCase(), (balances.get(from.toLowerCase()) ?? 0n) - value);
      if (to && !/^0x0{40}$/.test(to)) balances.set(to.toLowerCase(), (balances.get(to.toLowerCase()) ?? 0n) + value);
    }
    chunks++;
    if (start === fromBlockWanted) { complete = true; break; }
    cursor = start - 1;
  }
  const holders = [...balances.entries()]
    .filter(([, bal]) => bal > 0n)
    .map(([wallet_address, bal]) => ({ wallet_address, balance: bal.toString() }))
    .sort((a, b) => a.wallet_address.localeCompare(b.wallet_address));
  return {
    holders, complete, source: 'transfer_logs', token: tokenCa, chain,
    fromBlock: Math.max(fromBlockWanted, toBlock - chunks * chunkBlocks + 1), toBlock, chunks,
  };
}

// ── Campaign creation ───────────────────────────────────────────────────────

export async function getAirdropUserTier(tgId) {
  try {
    const u = await db.select().from(bot_users).where(eq(bot_users.telegramUserId, String(tgId))).get();
    return u?.tier ?? 'free';
  } catch { return 'free'; }
}

async function insertRecipients(campaignId, chain, recipients, amountPerWallet) {
  const BATCH = 200;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const slice = recipients.slice(i, i + BATCH);
    await db.insert(airdrop_recipients).values(slice.map((r) => ({
      campaignId,
      telegramUserId: r.telegram_user_id ? String(r.telegram_user_id) : null,
      walletAddress: r.wallet_address,
      amount: String(amountPerWallet),
      status: 'pending',
      recipientChain: chain,
      dedupeSuppressed: false,
    }))).run();
  }
}

/**
 * Create a campaign + persisted recipient snapshot + signed quote.
 * spec: { mode:'army'|'custom', chain:'base'|'sol'|'rh'|'all', tokenCa,
 *         tokenName, amountPerWallet, addressesInput?, includeRegistered?,
 *         startAt?, endAt?, idempotencyKey? }
 * 'all' creates a grouped parent + one child per chain (Army only in v1,
 * exactly like the original's all-three Army launch).
 */
// PRICING WAVE helpers (single source for the waiver gates — creation
// and the quote panel both call trialWaiverApplies, so they can never
// drift apart):
// - trialWaiverApplies: the pure gate check — Custom List, ≤100 wallets,
//   a fee to waive, waiver unused, and airdrop sends actually armed
//   (global live arm + this chain's arm). Display-safe: never mutates.
// - applyTrialWaiverToPrice: TRIALFIX 2026-11-01 (bugs 12+13) — the
//   waiver is now CLAIMED ATOMICALLY here, before the price is
//   mutated and before any campaign row exists: the conditional
//   consume in lib/tiers.js only lands while waiver_used is still 0,
//   so of two concurrent creations exactly one gets the $0 price.
//   A lost claim (or any claim error) leaves `priced` untouched —
//   the caller falls through to the existing full-fee path, never
//   to a $0 row with the waiver unused. The quote panel does NOT
//   call this function (it uses trialWaiverApplies, display-only),
//   so claiming here burns the waiver only on a real creation.
export async function trialWaiverApplies(tgId, { mode, chain, validCount, serviceFeeUsd, customOnly }) {
  if (mode !== 'custom' || validCount > TRIAL_WAIVER_MAX_WALLETS || !(serviceFeeUsd > 0)) return false;
  // TRIALPOLICY 2026-11-01 (#12): the waiver is "Custom List" by name —
  // PURELY customer-supplied lists only. customOnly=false (merged
  // registered/snapshot sources contributed wallets) refuses, even
  // when the mode is custom. Callers that cannot prove purity must
  // pass false or omit it: an omitted customOnly fails closed here.
  // The creation caller proves purity as merged total == pure custom
  // list size (see createAirdropCampaign); the quote display caller
  // passes !draft.includeRegistered (holders never merge in the
  // wizard), and creation re-checks regardless.
  if (customOnly !== true) return false;
  const peek = await peekTrialAirdropWaiver(tgId).catch(() => ({ eligible: false }));
  if (!peek.eligible) return false;
  if (!(await isAirdropArmed().catch(() => false))) return false;
  return await isAirdropChainArmed(chain).catch(() => false);
}
export async function applyTrialWaiverToPrice(tgId, spec, priced) {
  if (!(await trialWaiverApplies(tgId, {
    mode: spec.mode, chain: spec.chain,
    validCount: spec.totalRecipients ?? spec.validCount ?? 0,
    serviceFeeUsd: priced.serviceFeeUsd,
    customOnly: spec.customOnly,
  }))) return false;
  // TRIALFIX 12+13: claim FIRST, mutate price only on a won claim.
  // The peek above is advisory (both racers can pass it); the
  // conditional consume is authoritative. applied !== true means
  // the waiver is gone (winner took it) or the claim errored — in
  // either case priced stays at full fee and no $0 row is created.
  // No retry: a retry cannot tell this caller's landed-but-
  // unacknowledged claim apart from the winner's, so it could only
  // misreport; fail-closed to full fee is the safe outcome.
  const claim = await consumeTrialAirdropWaiver(tgId).catch(() => ({ applied: false }));
  if (claim.applied !== true) return false;
  priced.serviceFeeUsd = 0;
  priced.creditAppliedUsd = priced.grossFeeUsd;
  priced.benefitUse = null;
  return true;
}
export async function createAirdropCampaign(tgId, spec, deps = {}) {
  const tier = await getAirdropUserTier(tgId);
  const month = currentBenefitMonth();
  const usage = await getBenefitUsage(tgId, month);
  const now = new Date();

  if (spec.idempotencyKey) {
    const existing = await db.select().from(airdrop_campaigns)
      .where(eq(airdrop_campaigns.ownerIdempotencyKey, String(spec.idempotencyKey))).get().catch(() => null);
    if (existing && existing.telegramUserId === String(tgId)) {
      return { replay: true, campaigns: [existing] };
    }
  }

  const chains = spec.chain === 'all' ? [...AIRDROP_GROUP_CHAINS] : [spec.chain];
  if (spec.mode === 'custom' && spec.chain === 'all') {
    throw new Error('Custom List launches are single-chain; all-three is an Army Drop option');
  }

  // Chain admission (W1, spec §6.2): a forged/unknown chain refuses here,
  // before any pool read or quote work — and a registered chain whose
  // per-chain layer is still closed refuses with honest copy. Being in
  // AIRDROP_CHAINS means the plumbing exists, not that the chain is open.
  for (const chain of chains) {
    if (!AIRDROP_CHAINS.includes(chain)) {
      throw new Error(`Unknown airdrop chain: ${String(spec.chain).slice(0, 24)}`);
    }
    if (!(await isAirdropChainEnabled(chain))) {
      throw new Error(`Airdrops aren\u2019t open on ${CHAINS[chain].label} yet \u2014 that chain joins in a later rollout step. Nothing was created and no fee was charged.`);
    }
  }

  // Build + snapshot recipients per chain FIRST (quote binds the snapshot).
  const perChain = [];
  const holderSnapshots = [];
  // TRIALPOLICY 2026-11-01 (#12): the pure customer-supplied count,
  // accumulated across chains (custom is single-chain, so one term in
  // practice). The waiver gate compares the MERGED total against this:
  // equality proves no registered/snapshot wallet survived the merge
  // (a requested-but-empty registered pool, or registered wallets that
  // merely duplicate custom ones, add nothing PB-sourced to the drop).
  let pureCustomCount = 0;
  for (const chain of chains) {
    let recipients;
    if (spec.mode === 'army') {
      // Army = holders ∪ registered ∪ raid/XP (the original's merge,
      // DESIGN §8.3) — NOT just the registered pool.
      const pool = await armyPool(chain);
      recipients = mergeAirdropRecipients(chain, pool, []);
    } else {
      const validated = validateWalletInput(chain, spec.addressesInput ?? '');
      pureCustomCount += validated.addresses.length;
      if (!validated.addresses.length && !spec.includeHolders) throw new Error('No valid unique recipient wallets in the list');
      const registered = spec.includeRegistered ? await registeredPool(chain) : [];
      recipients = mergeAirdropRecipients(chain,
        registered.map((p) => ({
          wallet_address: chain === 'sol' ? p.wallet_address : p.wallet_address.toLowerCase(),
          telegram_user_id: p.telegram_user_id,
        })),
        validated.addresses);
      if (spec.includeHolders) {
        // "Airdrop to holders of X" — X is this campaign's own token.
        const snap = await tokenHolderSnapshot(chain, spec.tokenCa, deps);
        holderSnapshots.push({ chain, complete: snap.complete, source: snap.source, holders: snap.holders.length });
        recipients = mergeAirdropRecipients(chain, recipients, snap.holders.map((h) => h.wallet_address));
      }
      if (recipients.length > AIRDROP_RUN_RECIPIENT_CAP) {
        throw new Error(`Airdrop runs are limited to ${AIRDROP_RUN_RECIPIENT_CAP.toLocaleString()} valid unique wallets`);
      }
    }
    if (!recipients.length) throw new Error(`No registered recipient wallets on ${CHAINS[chain].label} yet`);
    perChain.push({ chain, recipients, digest: await recipientSnapshotDigest(chain, recipients) });
  }

  const totalRecipients = perChain.reduce((n, c) => n + c.recipients.length, 0);
  const priced = priceWithBenefits({
    tier, mode: spec.mode, chain: spec.chain, validCount: totalRecipients, usage,
  });
  // PRICING WAVE: one-time trial airdrop waiver — Custom List only,
  // ≤100 wallets, and ONLY when airdrop sends are actually armed
  // (global live arm + this chain's arm). TRIALFIX 2026-11-01: the
  // waiver is claimed ATOMICALLY inside applyTrialWaiverToPrice
  // (conditional write, waiver_used 0→1) BEFORE this price is final
  // — waiverPending is true only for the claim winner, so a $0 row
  // below always has its waiver already spent. A lost claim leaves
  // the full fee in place (existing full-fee path). It replaces
  // (never stacks with) the monthly tier benefit: benefitUse is
  // nulled so recordBenefitUse stays a no-op for waived campaigns.
  // A $0 fee from tier benefits alone never consumes the waiver.
  // Tradeoff, stated plainly: a claim that wins and whose row insert
  // then throws leaves the waiver spent (same as the monthly benefit
  // below, which is consumed at creation even if the campaign never
  // pays). No release is attempted on that path — a release cannot
  // prove no row landed, so it could resurrect a waiver under a
  // surviving $0 row and re-create the double-waiver bug.
  const waiverPending = await applyTrialWaiverToPrice(tgId, {
    mode: spec.mode, chain: spec.chain, totalRecipients,
    // TRIALPOLICY 2026-11-01 (#12): customOnly is the merged-total
    // equality — a merged registered/snapshot wallet makes the total
    // exceed the pure custom count and refuses the waiver. Army mode
    // never reaches here (trialWaiverApplies refuses non-custom).
    customOnly: spec.mode === 'custom' && totalRecipients === pureCustomCount,
  }, priced);
  const reserveUsd = spec.chain === 'all'
    ? Number((await Promise.all(perChain.map((c) => estimateAirdropReserveUsd(c.chain, c.recipients.length, deps))))
      .reduce((a, b) => a + b, 0).toFixed(2))
    : await estimateAirdropReserveUsd(chains[0], totalRecipients, deps);

  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + AIRDROP_QUOTE_TTL_SECONDS * 1000).toISOString();
  const launchId = spec.chain === 'all' ? `grp_${Math.abs([...issuedAt].reduce((a, c) => a + c.charCodeAt(0), 0))}_${now.getTime().toString(36)}` : null;

  const makeRow = async (chainEntry, parentId) => {
    const isParent = spec.chain === 'all' && !chainEntry;
    const chain = isParent ? 'all' : chainEntry.chain;
    const recipients = isParent ? [] : chainEntry.recipients;
    const payload = {
      version: 2,
      accountId: String(tgId),
      chain,
      recipientMode: spec.mode,
      recipientDigest: isParent ? await recipientSnapshotDigest('base', perChain.flatMap((c) => c.recipients)) : chainEntry.digest,
      validCount: isParent ? totalRecipients : recipients.length,
      baseFeeUsd: spec.mode === 'custom' ? AIRDROP_CUSTOM_BASE_FEE_USD : priced.grossFeeUsd,
      rateUsd: priced.benefit.customRateUsd,
      grossFeeUsd: priced.grossFeeUsd,
      monthlyCreditUsd: priced.creditAppliedUsd,
      serviceFeeUsd: priced.serviceFeeUsd,
      issuedAt, expiresAt,
    };
    const sig = await signAirdropQuote(payload);
    const inserted = await db.insert(airdrop_campaigns).values({
      telegramUserId: String(tgId),
      tokenName: spec.tokenName ?? '',
      tokenCa: spec.chain === 'sol' ? spec.tokenCa : normalizeEvmAddress(spec.tokenCa),
      chain,
      amountPerWallet: String(spec.amountPerWallet),
      walletCount: payload.validCount,
      status: 'fee_pending',
      serviceFeeUsd: String(priced.serviceFeeUsd),
      recipientsSnapshot: recipients.length ? 1 : 0,
      recipientMode: spec.mode,
      quoteDigest: payload.recipientDigest,
      quoteSig: sig,
      quoteIssuedAt: now.getTime(),
      quoteExpiresAt: now.getTime() + AIRDROP_QUOTE_TTL_SECONDS * 1000,
      platformFeeUsd: String(priced.grossFeeUsd),
      networkReserveUsd: String(reserveUsd),
      parentId: parentId ?? null,
      launchId,
      ownerIdempotencyKey: spec.idempotencyKey ? String(spec.idempotencyKey) : null,
      startAt: spec.startAt ?? null,
      endAt: spec.endAt ?? null,
      benefitMonth: month,
      trialWaiver: waiverPending ? 1 : 0,
      dryRun: true,
    }).returning();
    const row = inserted[0];
    if (recipients.length) await insertRecipients(row.id, chain, recipients, spec.amountPerWallet);
    return row;
  };

  let parent = null;
  const created = [];
  if (spec.chain === 'all') {
    parent = await makeRow(null, null);
    created.push(parent);
    for (const entry of perChain) created.push(await makeRow(entry, parent.id));
  } else {
    created.push(await makeRow(perChain[0], null));
  }

  // Benefits are consumed once, at creation (the original binds them to the
  // signed quote; a campaign that never pays still consumed the quote slot —
  // matches the original's monthly-counter semantics).
  // TRIALFIX 13: the trial waiver is NOT re-consumed here. It was
  // already claimed atomically before the price was set, and a second
  // consume would always report applied:false (waiver_used is already
  // 1 — its own claim) — checking that result here and voiding on it
  // would void every legitimate waived campaign. The { applied }
  // check lives at the claim site in applyTrialWaiverToPrice: only a
  // won claim ever produces a $0 row, so no $0 campaign can survive
  // with its waiver unused. This block is audit-only.
  if (waiverPending) {
    await auditMoney('airdrop', tgId, 'trial_waiver_used',
      `campaigns=${created.map((c) => c.id).join(',')} grossFeeUsd=${priced.grossFeeUsd} recipients=${totalRecipients}`).catch(() => {});
  }
  await recordBenefitUse(tgId, month, priced.benefitUse);
  await auditMoney('airdrop', tgId, 'campaign_created',
    `mode=${spec.mode} chain=${spec.chain} campaigns=${created.map((c) => c.id).join(',')} feeUsd=${priced.serviceFeeUsd} recipients=${totalRecipients}`);
  return { campaigns: created, priced, reserveUsd, holderSnapshots };
}

// ── Fee confirmation + deposit wallet ───────────────────────────────────────
// The deposit wallet is created ONLY after the fee is confirmed (original
// rule). Phase-2 confirm paths: tier-benefit $0 fee (automatic), or the
// payments launch's XRocket/direct verification calling confirmAirdropFee.

/**
 * Fee-settled predicate — the bridge's fee gate (signer DESIGN §2/§8.7).
 * The port's lifecycle carries fee state in feePaymentKind + status (the
 * rescued schema's service_fee_status column was deliberately not migrated
 * at rev 72 — see schema.js): a campaign is settled exactly when a fee
 * confirmation has landed (any kind incl. 'credit' $0 tier-benefit and
 * 'none') and it has left fee_pending. Claim assembly checks this
 * explicitly even though fee_pending campaigns structurally have no
 * transfers — defense in depth, proven both directions by the harness.
 */
export function campaignFeeSettled(campaign) {
  return !!campaign && !!campaign.feePaymentKind && campaign.status !== 'fee_pending';
}

export async function confirmAirdropFee(campaignId, kind, ref = null) {
  const row = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, campaignId)).get().catch(() => null);
  if (!row) return { error: 'Campaign not found.' };
  if (row.status === 'deposit_pending' && row.depositAddress) return { replay: true, depositAddress: row.depositAddress };
  // §8.5: the fee already landed and the host-side signer worker is
  // generating this campaign's Solana deposit wallet — a duplicate
  // confirm (payment webhook retry) replays against the pending state.
  if (row.status === 'deposit_generating') return { pending: true, depositGenerating: true, replay: true };
  if (row.status !== 'fee_pending') return { error: `Campaign is ${row.status} — fee cannot be confirmed now.` };
  let keypair;
  if (row.chain === 'sol') {
    keypair = await generateSolKeypair();
    if (!keypair) {
      // §8.5 host-side generation: the isolate has no Ed25519, so the
      // fee settles NOW (kind/ref recorded, campaign fee-gated as paid)
      // and the campaign parks at 'deposit_generating' with NO address.
      // The signer-sync channel requests the keypair from the host-side
      // signer worker over the bridge (depgen channel); when the
      // ciphertext + address land, applyDepositGenResult moves the
      // campaign to 'deposit_pending' and the normal watcher takes
      // over. No address is ever shown before one really exists.
      await db.update(airdrop_campaigns).set({
        status: 'deposit_generating',
        feePaymentKind: kind,
        feePaymentRef: ref,
        gasCeilingWei: null,
      }).where(and(eq(airdrop_campaigns.id, campaignId), eq(airdrop_campaigns.status, 'fee_pending'))).run();
      const afterGen = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, campaignId)).get();
      if (afterGen?.status !== 'deposit_generating') return { error: 'Campaign state changed — reload.' };
      await auditMoney('airdrop', row.telegramUserId, 'fee_confirmed', `campaign=${campaignId} kind=${kind} deposit=host_generating`);
      // Sales leg: a confirmed fee is a sale — receipt once, best-effort.
      await sendSalesReceipt('airdrop', campaignId, { txHash: ref }).catch(() => {});
      return { pending: true, depositGenerating: true };
    }
    keypair = { address: keypair.address, privateKey: keypair.privateKeyHex };
  } else if (row.chain === 'all') {
    return { error: 'Grouped parent has no deposit wallet — confirm each child.' };
  } else {
    keypair = generateEvmKeypair();
  }
  const encrypted = await vaultEncrypt(keypair.privateKey);
  // Phase 2 (signer DESIGN §8.8): derive the per-transfer gas ceiling for
  // EVM campaigns from the live gas price — the reserve model's 120,000-gas
  // assumption for price drift between quote and send.
  // Best-effort: a failed gas read leaves the ceiling NULL (the worker
  // then applies no ceiling) and never blocks the fee confirmation.
  // Solana campaigns stay NULL — the phase-2 ceiling is wei-shaped.
  let gasCeilingWei = null;
  if (row.chain !== 'sol' && row.chain !== 'all') {
    try {
      const gp = await evmGasPriceWei(row.chain);
      gasCeilingWei = String(gp * 120_000n);
    } catch { gasCeilingWei = null; }
  }
  await db.update(airdrop_campaigns).set({
    status: 'deposit_pending',
    depositAddress: keypair.address,
    encryptedDepositPk: encrypted,
    feePaymentKind: kind,
    feePaymentRef: ref,
    gasCeilingWei,
  }).where(and(eq(airdrop_campaigns.id, campaignId), eq(airdrop_campaigns.status, 'fee_pending'))).run();
  const after = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, campaignId)).get();
  if (after?.status !== 'deposit_pending') return { error: 'Campaign state changed — reload.' };
  await auditMoney('airdrop', row.telegramUserId, 'fee_confirmed', `campaign=${campaignId} kind=${kind}`);
  // Sales leg: a confirmed fee is a sale — receipt once, best-effort.
  await sendSalesReceipt('airdrop', campaignId, { txHash: ref }).catch(() => {});
  return { ok: true, depositAddress: keypair.address };
}

/** $0-fee campaigns (fully benefit-covered) confirm automatically. */
export async function autoConfirmFreeFees() {
  const rows = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.status, 'fee_pending')).all().catch(() => []);
  let confirmed = 0;
  for (const row of rows) {
    if (row.parentId === null && row.chain === 'all') continue;
    if (Number(row.serviceFeeUsd ?? 0) > 0) continue;
    // PRICING WAVE: waived campaigns audit as 'trial_waiver', not
    // 'tier_benefit' — the two $0 paths must never be confused.
    const r = await confirmAirdropFee(row.id, 'credit', row.trialWaiver ? 'trial_waiver' : 'tier_benefit');
    if (r.ok) confirmed++;
  }
  return { confirmed };
}

// ── Automatic fee confirmation (watcher-verified, no owner touch) ───────
// DESIGN (feeauto wave, 2026-10-25): the service fee is PB revenue, so it
// rides the EXISTING tier-payment rail — USDC on Base → config
// PAY_RECEIVE_BASE_ADDRESS — which the WW1/WW2 scanner already watches
// (Base USDC Transfer logs). No new rail, no new token, no new checkout
// provider, no D1 claim needed (the bot has no claim-create bridge
// endpoint; claims are created on the Worker side, and fee settlement
// must happen bot-side where confirmAirdropFee lives).
// The customer pays once, from their connected Base wallet; the watcher
// pass (tick.js cycleWatcherScan) matches the transfer to exactly one
// fee_pending campaign and confirms it. /dropfee stays as the exception
// fallback only.
//
// Matching rule — ALL must hold, else the campaign stays fee_pending:
//   1. transfer is base:USDC to the configured fee address (the scanner
//      guarantees the destination; the matcher re-checks token + chain);
//   2. the sender is the campaign owner's REGISTERED Base wallet
//      (user_wallets.base_address) — the receipt-theft binding, mirroring
//      the watcher verifier's declared-sender rule;
//   3. a single transfer (scanner candidates grouped by tx hash + sender,
//      amounts summed) is within the watcher stable tolerance: >= expected,
//      overpay <= +$2.00 (underpay is NEVER valid; partial sums across
//      separate transfers do NOT combine — pay the fee in one transfer);
//   4. exactly one fee_pending campaign matches (ambiguity fails closed);
//   5. the tx hash was never used as any campaign's feePaymentRef
//      (replay protection);
//   6. the injected on-chain verifier passes (receipt success + log match
//      + amount tolerance, via tick.js watcherVerifyBase).
// Residuals, documented not hidden: (a) /connect registration is
// self-asserted (no ownership proof), so sender binding is only as
// strong as registration — ambiguity + tx-uniqueness + tolerance bound
// the exposure; signed-ownership proof on /connect is future hardening.
// (b) a single verifier pass is required, no block-depth gate: the
// scanner's watermarks advance past a tx once scanned, so a depth gate
// would strand early-scanned fee txs forever. Blast radius of a reorged
// fee-confirm is small — the deposit wallet opens, but no money moves
// without customer funding plus the canary / phase-2 / signer-live
// gates. (c) a fee transfer that is ALSO a D1 claim is excluded from
// scanner candidates (claimedTx) and therefore never auto-confirms —
// fail closed, /dropfee covers it. (d) the matcher only runs while the
// watcher is enabled (cycleWatcherVerify is flag-gated); with the
// watcher off, fees fall back to /dropfee + owner tickets.
export const AIRDROP_FEE_ASSET = 'USDC';
export const AIRDROP_FEE_CHAIN = 'base';

/** USD decimal string → USDC base units (6dp), integer string math only. */
export function usdToUsdcUnits(usd) {
  const s = String(usd ?? '').trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`bad USD amount: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** Configured fee wallet (lowercased), or '' when unconfigured. */
export async function airdropFeePayAddress() {
  const raw = await getConfig('PAY_RECEIVE_BASE_ADDRESS', '').catch(() => '');
  return String(raw ?? '').trim().toLowerCase();
}

/** Customer-facing fee instruction lines. Pure; feeAddress '' = unconfigured. */
export function airdropFeePayLines(feeUsd, feeAddress) {
  const fee = String(feeUsd ?? '0');
  let n = 0;
  try { n = Number(fee); } catch { n = 0; }
  if (!(n > 0)) return ['Your tier benefit covered the fee — the deposit wallet opens on the next check.'];
  if (!feeAddress) {
    return [
      `Service fee $${fee} is due before the deposit wallet opens.`,
      'Fee payments aren\u2019t configured yet — the owner needs to set the fee wallet first.',
    ];
  }
  return [
    `Service fee $${fee} — pay it in one USDC transfer on Base from your connected Base wallet (/connect <wallet> to link one) to:`,
    feeAddress,
    'The watcher confirms it automatically — no need to send anything else. The deposit wallet opens once confirmed.',
    'If you pay from a different wallet, or it doesn\u2019t confirm within a few minutes, it stays visible to the owner for manual confirmation.',
  ];
}

/**
 * Match scanner candidates against fee_pending campaigns and confirm the
 * unambiguous ones. deps: { verifyBase, usdcSpec, amountReject } are
 * REQUIRED (injected from tick.js, which owns the verifier); without
 * them this fails closed and confirms nothing. confirmFee defaults to
 * the real confirmAirdropFee. Returns { confirmed: [{campaignId,
 * txHash}], matchedTx: Set<lowercased txHash> } — matchedTx is used by
 * the scanner to withhold auto-confirmed transfers from the unclaimed
 * report, so the owner is never ticketed for a fee that confirmed.
 */
export async function matchAirdropFeePayments(candidates, deps = {}) {
  const confirmed = [];
  const matchedTx = new Set();
  const verifyBase = deps.verifyBase;
  const usdcSpec = deps.usdcSpec;
  const amountReject = deps.amountReject;
  const confirmFee = deps.confirmFee ?? confirmAirdropFee;
  if (typeof verifyBase !== 'function' || !usdcSpec || typeof amountReject !== 'function') {
    return { confirmed, matchedTx };
  }
  const feeAddr = (await airdropFeePayAddress().catch(() => '')).toLowerCase();
  if (!feeAddr) return { confirmed, matchedTx };
  // Group base:USDC candidates by (txHash, sender); sum per group.
  const groups = new Map();
  for (const c of candidates ?? []) {
    if (c?.chain !== 'base' || c?.token !== 'USDC') continue;
    const tx = String(c.txHash ?? '').toLowerCase();
    const from = String(c.fromAddress ?? '').toLowerCase();
    if (!tx || !from) continue;
    let amount = 0n;
    try { amount = BigInt(c.amountUnits ?? '0'); } catch { continue; }
    const key = tx + '|' + from;
    const g = groups.get(key) ?? { txHash: tx, fromAddress: from, amount: 0n };
    g.amount += amount;
    groups.set(key, g);
  }
  if (!groups.size) return { confirmed, matchedTx };
  const pending = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.status, 'fee_pending')).all().catch(() => []);
  const live = pending.filter((r) => {
    if (r.parentId === null && r.chain === 'all') return false;
    try { return usdToUsdcUnits(r.serviceFeeUsd) > 0n; } catch { return false; }
  });
  if (!live.length) return { confirmed, matchedTx };
  const usedRefs = new Set();
  try {
    const all = await db.select().from(airdrop_campaigns).all().catch(() => []);
    for (const r of all) if (r.feePaymentRef) usedRefs.add(String(r.feePaymentRef).toLowerCase());
  } catch { /* incomplete set still safe: confirmAirdropFee guards status */ }
  const walletCache = new Map();
  const ownerBaseWallet = async (ownerId) => {
    if (walletCache.has(ownerId)) return walletCache.get(ownerId);
    const row = await db.select().from(user_wallets)
      .where(eq(user_wallets.telegramUserId, String(ownerId))).get().catch(() => null);
    const addr = String(row?.baseAddress ?? '').trim().toLowerCase();
    walletCache.set(ownerId, addr);
    return addr;
  };
  for (const g of groups.values()) {
    if (usedRefs.has(g.txHash)) continue;
    const matches = [];
    for (const row of live) {
      const wallet = await ownerBaseWallet(row.telegramUserId);
      if (!wallet || wallet !== g.fromAddress) continue;
      let expected;
      try { expected = usdToUsdcUnits(row.serviceFeeUsd); } catch { continue; }
      if (amountReject(g.amount, expected, usdcSpec) !== null) continue;
      matches.push({ row, expected });
    }
    if (matches.length !== 1) continue; // 0 = not a fee; 2+ = ambiguous, fail closed
    const { row, expected } = matches[0];
    let verdict;
    try {
      verdict = await verifyBase({
        chain: 'base', token: 'USDC', txHash: g.txHash,
        receiveAddress: feeAddr, payerAddress: g.fromAddress,
        tokenContract: usdcSpec.contract, expectedAmount: expected.toString(),
      }, usdcSpec);
    } catch { continue; }
    if (verdict?.outcome !== 'pass') continue;
    let res;
    try { res = await confirmFee(row.id, 'watcher', g.txHash); }
    catch { continue; }
    if (res?.ok || res?.pending) {
      confirmed.push({ campaignId: row.id, txHash: g.txHash });
      matchedTx.add(g.txHash);
      usedRefs.add(g.txHash);
    } else if (res?.replay) {
      // Already confirmed by another path — consume the tx so the
      // unclaimed report doesn't ticket the owner for it.
      matchedTx.add(g.txHash);
      usedRefs.add(g.txHash);
    }
    // res?.error → fail closed: leave unmatched, owner ticket fires.
  }
  return { confirmed, matchedTx };
}

// ── Deposit watcher (read-only) ─────────────────────────────────────────────

export async function checkAirdropDeposit(campaign, deps = {}) {
  if (campaign.status !== 'deposit_pending' || !campaign.depositAddress) return { skipped: 'not_pending' };
  if (campaign.chain === 'all') return { skipped: 'parent' };
  const balanceOf = deps.tokenBalance ?? tokenBalance;
  const balance = await balanceOf(campaign.chain, campaign.tokenCa, campaign.depositAddress);
  // Buy Rewards (PB-BUYREWARDS-SPEC §7.3): per-wallet variable amounts —
  // amountPerWallet on those campaigns is the largest single payout, not a
  // unit, so the requirement is the exact sum of the recipient rows. Every
  // other recipient mode keeps the original formula byte-for-byte.
  let required;
  if (campaign.recipientMode === 'buyrewards') {
    const recips = await db.select().from(airdrop_recipients)
      .where(eq(airdrop_recipients.campaignId, campaign.id)).all().catch(() => []);
    required = decSum(recips.map((r) => r.amount));
  } else {
    required = decMulInt(String(campaign.amountPerWallet), campaign.walletCount);
  }
  if (decCmp(balance, required) < 0) return { pending: true, balance, required };
  await db.update(airdrop_campaigns).set({
    status: 'funded', depositTokenBalance: balance,
  }).where(and(eq(airdrop_campaigns.id, campaign.id), eq(airdrop_campaigns.status, 'deposit_pending'))).run();
  const after = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, campaign.id)).get();
  if (after?.status !== 'funded') return { skipped: 'lost_claim' };
  await auditMoney('airdrop', campaign.telegramUserId, 'deposit_confirmed',
    `campaign=${campaign.id} balance=${balance} required=${required}`);
  await alertOwner('airdrop', `🪂 Airdrop deposit confirmed\nCampaign ${campaign.id} (${campaign.tokenName || campaign.tokenCa} on ${campaign.chain})\n${balance} tokens for ${campaign.walletCount} wallets. Planning runs on the next tick; sends stay ${await isAirdropArmed() ? 'ARMED' : 'OFF (dry-run)'}.`);
  return { funded: true, balance };
}

export async function cycleAirdropWatch(deps = {}) {
  if (!(await isAirdropEnabled())) return { skipped: 'airdrop_disabled' };
  const free = await autoConfirmFreeFees();
  const rows = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.status, 'deposit_pending')).limit(25).all().catch(() => []);
  let funded = 0;
  for (const row of rows) {
    try { const r = await checkAirdropDeposit(row, deps); if (r.funded) funded++; }
    catch (err) { console.error('[airdropWatch]', row.id, err?.message ?? err); }
  }
  return { freeConfirmed: free.confirmed, checked: rows.length, funded };
}

// ── Dry-run distribution planner ────────────────────────────────────────────
// Persists one transfer intent per eligible recipient (status 'planned',
// deterministic plannedHash), exactly the rows the arm-phase broadcaster
// will consume. Schedule window is enforced HERE (the authoritative claim
// boundary, per the original's schedule-enforcement rule).

export async function tokenUsdPrice(chain, tokenCa, deps = {}) {
  try {
    const fetchFn = deps.fetchFn ?? fetch;
    const res = await fetchFn(`https://api.dexscreener.com/latest/dex/tokens/${tokenCa}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = (data?.pairs ?? []).filter((p) => Number(p.priceUsd) > 0);
    if (!pairs.length) return null;
    const top = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return Number(top.priceUsd);
  } catch { return null; }
}

export async function planAirdropCampaign(campaign, deps = {}) {
  if (campaign.status !== 'funded') return { skipped: 'not_funded' };
  if (campaign.chain === 'all') return { skipped: 'parent' };
  const now = deps.now ?? Date.now();
  if (campaign.startAt && now < campaign.startAt * 1000) return { waiting: 'before_window' };
  if (campaign.endAt && now > campaign.endAt * 1000) {
    await db.update(airdrop_campaigns).set({ status: 'expired' })
      .where(and(eq(airdrop_campaigns.id, campaign.id), eq(airdrop_campaigns.status, 'funded'))).run();
    await auditMoney('airdrop', campaign.telegramUserId, 'campaign_expired', `campaign=${campaign.id} reason=window_passed`);
    return { expired: true };
  }
  const recipients = await db.select().from(airdrop_recipients)
    .where(and(eq(airdrop_recipients.campaignId, campaign.id), eq(airdrop_recipients.status, 'pending'),
      eq(airdrop_recipients.dedupeSuppressed, false))).all().catch(() => []);
  let created = 0;
  for (const r of recipients) {
    const existing = await db.select().from(airdrop_transfers)
      .where(eq(airdrop_transfers.recipientId, r.id)).get().catch(() => null);
    if (existing) continue;
    const plannedHash = await sha256Hex(`${campaign.chain}|${campaign.id}|${r.id}|${r.walletAddress}|${r.amount}`);
    await db.insert(airdrop_transfers).values({
      recipientId: r.id, campaignId: campaign.id, chain: campaign.chain,
      status: 'planned', plannedHash, amountText: r.amount,
    }).run();
    created++;
  }
  // Phase 2 (signer DESIGN §8.8): refresh the campaign's gas reservation
  // envelope = per-transfer ceiling × all planned transfers. Confirmed
  // signer reports settle it back down (ingestSignerOutcomes).
  if (campaign.gasCeilingWei) {
    try {
      const all = await db.select().from(airdrop_transfers)
        .where(eq(airdrop_transfers.campaignId, campaign.id)).all();
      const reserved = String(BigInt(campaign.gasCeilingWei) * BigInt(all.length));
      await db.update(airdrop_campaigns).set({ gasReservedWei: reserved })
        .where(eq(airdrop_campaigns.id, campaign.id)).run();
    } catch { /* reservation bookkeeping never blocks planning */ }
  }
  const price = await tokenUsdPrice(campaign.chain, campaign.tokenCa, deps);
  const perSendUsd = price ? Number(campaign.amountPerWallet) * price : null;
  const totalUsd = perSendUsd !== null ? perSendUsd * campaign.walletCount : null;
  const armed = await isAirdropArmed();
  if (perSendUsd !== null) {
    const caps = await checkCaps({ perSendUsd, totalUsd, kind: 'airdrop' });
    if (!caps.ok) {
      await alertOwner('airdrop', `⚠️ Airdrop plan over cap\nCampaign ${campaign.id}: ${caps.reason}\nIntents recorded; campaign stays funded, nothing sent.`);
      await auditMoney('airdrop', campaign.telegramUserId, 'plan_over_cap', `campaign=${campaign.id} reason=${caps.reason}`);
      return { overCap: caps.reason, intents: created };
    }
  }
  await db.update(airdrop_campaigns).set({ status: armed ? 'planned' : 'awaiting_arm', dryRun: !armed })
    .where(and(eq(airdrop_campaigns.id, campaign.id), eq(airdrop_campaigns.status, 'funded'))).run();
  await auditMoney('airdrop', campaign.telegramUserId, 'plan_created',
    `campaign=${campaign.id} usd=${totalUsd ?? 'unpriced'} intents=${created} mode=${armed ? 'armed' : 'dry_run'}`);
  if (perSendUsd === null) {
    await alertOwner('airdrop', `🪂 Airdrop planned (unpriced token)\nCampaign ${campaign.id} — ${created} intents. No USD price found, so caps were recorded as unpriced; the broadcaster re-checks at arm time.`);
  }
  return { planned: true, intents: created, armed };
}

export async function cycleAirdropPlan(deps = {}) {
  if (!(await isAirdropEnabled())) return { skipped: 'airdrop_disabled' };
  const rows = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.status, 'funded')).limit(10).all().catch(() => []);
  let planned = 0;
  for (const row of rows) {
    try { const r = await planAirdropCampaign(row, deps); if (r.planned) planned++; }
    catch (err) { console.error('[airdropPlan]', row.id, err?.message ?? err); }
  }
  // Grouped-parent rollup (shared predicate — see
  // rollupAirdropParentById): a cancelled child never stalls the parent.
  // Parents in awaiting_arm/planned are revisited too, so a parent whose
  // children all resolve terminal after it planned still resolves.
  const parents = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.chain, 'all')).all().catch(() => []);
  for (const p of parents) {
    if (!['funded', 'deposit_pending', 'fee_pending', 'awaiting_arm', 'planned'].includes(p.status)) continue;
    await rollupAirdropParentById(p.id).catch((err) => console.error('[airdropRollup]', p.id, err?.message ?? err));
  }
  return { checked: rows.length, planned };
}

// ── Hygiene ─────────────────────────────────────────────────────────────────
// fee_pending expiry uses quote expiry + 24h grace while the payments
// launch is pending (documented deviation — the fee step needs a live
// XRocket rail; campaigns must not die in 15 minutes before it exists).

export async function cycleAirdropHygiene(deps = {}) {
  const now = deps.now ?? Date.now();
  let expired = 0;
  const feeRows = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.status, 'fee_pending')).limit(50).all().catch(() => []);
  for (const row of feeRows) {
    if (row.chain === 'all') continue;
    if ((row.quoteExpiresAt ?? 0) + 24 * 3600 * 1000 < now) {
      await db.update(airdrop_campaigns).set({ status: 'expired' })
        .where(and(eq(airdrop_campaigns.id, row.id), eq(airdrop_campaigns.status, 'fee_pending'))).run();
      expired++;
      await auditMoney('airdrop', row.telegramUserId, 'campaign_expired', `campaign=${row.id} from=fee_pending`);
    }
  }
  return { expired };
}

// ── Signer bridge (Phase 2 — signer-worker DESIGN §1–§3) ───────────────────
// PB-side half of the bridge: assemble claim intents from planned
// transfers, push them to the site Worker (which the host-side signer
// worker polls), and ingest outcome reports back into transfer /
// recipient / campaign state. Transport is injected ({ poster, getter }
// from websync's signed helpers) so the harness can prove the mechanics
// in-isolate against a scripted bridge without touching the live Worker.

const SIGNER_PUSH_CHUNK = 400;
const SIGNER_PULL_CURSOR_KEY = 'signer_pull_cursor';

// ── Explorer links (§4.5) ──────────────────────────────────────────────────
// The only display change the expansion needs: per-chain tx URLs in the
// spec §3 formats. Unknown chain or missing hash → null (callers omit the
// link rather than guess one).
const EXPLORER_TX_BASE = {
  base: 'https://basescan.org/tx/',
  rh: 'https://explorer.robinhood.com/tx/',
  sol: 'https://solscan.io/tx/',
  ethereum: 'https://etherscan.io/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
  bnb: 'https://bscscan.com/tx/',
  avalanche: 'https://snowtrace.io/tx/',
};
export function explorerTxUrl(chain, hash) {
  const base = EXPLORER_TX_BASE[chain];
  return base && hash ? base + String(hash) : null;
}

/** The bridge's broadcast signal (DESIGN §4 gate 2 + spec §6.2 layers):
 *  with no chain argument it is the global product signal — feature
 *  enabled AND the global live arm on. With a chain, that chain's own two
 *  layers must also be open (enabled + per-chain arm); a chain that is
 *  not enabled never signals, and an unknown chain never signals.
 *  Read at assembly time. */
export async function signerBroadcastSignal(chain) {
  if (!(await isAirdropEnabled()) || !(await isAirdropArmed())) return false;
  if (chain == null) return true;
  return (await isAirdropChainEnabled(chain)) && (await isAirdropChainArmed(chain));
}

async function signerTokenDecimals(chain, tokenCa, deps) {
  if (deps.tokenDecimals) {
    try { return await deps.tokenDecimals(chain, tokenCa); } catch { return null; }
  }
  try {
    return chain === 'sol' ? await solMintDecimals(tokenCa) : await evmTokenDecimals(chain, tokenCa);
  } catch { return null; }
}

/**
 * Assemble claim intents for every eligible planned transfer.
 * Eligibility (ALL must hold): the transfer is 'planned'; its campaign is
 * 'awaiting_arm' or 'planned'; the transfer's chain layer is ENABLED
 * (spec §6.2 — closed-chain transfers are skipped as chainClosed and stay
 * 'planned'); the campaign's fee is SETTLED (the fee gate
 * — DESIGN §2/§8.7, checked explicitly even though unpaid campaigns
 * structurally have no transfers); the campaign carries a deposit wallet
 * (address + ciphertext); and the transfer's signer outcome is fresh
 * (never pushed) — or, when the broadcast signal is on, a prior dry-run /
 * refusal being upgraded to the real send. Deposit-class ONLY: key_class
 * is hardcoded 'deposit' here; the master class is never assembled.
 */
export async function assembleSignerClaims(deps = {}) {
  const broadcastAll = await signerBroadcastSignal();
  // Per-chain layers (spec §6.2), cached per assembly pass: a transfer
  // assembles as a REAL send only when its own chain signals; a transfer
  // on a chain whose layer is closed does not assemble at all (below).
  const signals = new Map();
  const signalFor = async (chain) => {
    if (!signals.has(chain)) signals.set(chain, await signerBroadcastSignal(chain));
    return signals.get(chain);
  };
  const enabledCache = new Map();
  const chainEnabled = async (chain) => {
    if (!enabledCache.has(chain)) enabledCache.set(chain, await isAirdropChainEnabled(chain));
    return enabledCache.get(chain);
  };
  const caps = {
    max_send_usd: await maxSendUsd(),
    daily_cap_usd: await dailyCapUsd(),
    daily_spent_usd: await plannedUsdToday('airdrop'),
  };
  const transfers = await db.select().from(airdrop_transfers)
    .where(eq(airdrop_transfers.status, 'planned')).limit(500).all().catch(() => []);
  const campaigns = new Map();
  const recipients = new Map();
  const decimals = new Map();
  const prices = new Map();
  const gasByCampaign = new Map();
  const noGasCampaigns = [];
  const noGasSeen = new Set();
  const claims = [];
  const skipped = { campaignState: 0, unpaid: 0, noDeposit: 0, noGas: 0, outcome: 0, missing: 0, chainClosed: 0 };
  for (const t of transfers) {
    if (!campaigns.has(t.campaignId)) {
      campaigns.set(t.campaignId, await db.select().from(airdrop_campaigns)
        .where(eq(airdrop_campaigns.id, t.campaignId)).get().catch(() => null));
    }
    const campaign = campaigns.get(t.campaignId);
    if (!campaign) { skipped.missing++; continue; }
    if (!['awaiting_arm', 'planned'].includes(campaign.status)) { skipped.campaignState++; continue; }
    // Chain layer (§6.2): transfers on a chain that is not enabled never
    // assemble — they stay 'planned', untouched, for if/when it opens.
    if (!(await chainEnabled(t.chain))) { skipped.chainClosed++; continue; }
    if (!campaignFeeSettled(campaign)) { skipped.unpaid++; continue; }
    if (!campaign.depositAddress || !campaign.encryptedDepositPk) { skipped.noDeposit++; continue; }
    // Gas pre-flight (DESIGN §8.6): a deposit wallet holding ZERO native
    // currency can never pay transfer gas — skip loudly here instead of
    // failing silently at the worker. A failed balance READ never blocks
    // (unknown is not zero); the worker's own gates remain the backstop.
    if (!gasByCampaign.has(t.campaignId)) {
      let gas = 'unknown';
      try {
        const bal = await (deps.nativeBalance ?? nativeBalance)(campaign.chain, campaign.depositAddress);
        gas = decCmp(String(bal), '0') <= 0 ? 'zero' : 'ok';
      } catch { gas = 'unknown'; }
      gasByCampaign.set(t.campaignId, gas);
    }
    if (gasByCampaign.get(t.campaignId) === 'zero') {
      skipped.noGas++;
      if (!noGasSeen.has(t.campaignId)) {
        noGasSeen.add(t.campaignId);
        noGasCampaigns.push({ campaignId: t.campaignId, chain: campaign.chain, depositAddress: campaign.depositAddress });
      }
      continue;
    }
    const outcome = t.signerOutcome ?? null;
    const chainSignal = await signalFor(t.chain);
    const eligible = outcome === null
      || (chainSignal && (outcome === 'dry_run' || outcome.startsWith('refused:')));
    if (!eligible) { skipped.outcome++; continue; }
    if (!recipients.has(t.recipientId)) {
      recipients.set(t.recipientId, await db.select().from(airdrop_recipients)
        .where(eq(airdrop_recipients.id, t.recipientId)).get().catch(() => null));
    }
    const recipient = recipients.get(t.recipientId);
    if (!recipient?.walletAddress) { skipped.missing++; continue; }
    if (!decimals.has(t.campaignId)) {
      decimals.set(t.campaignId, await signerTokenDecimals(campaign.chain, campaign.tokenCa, deps));
    }
    if (!prices.has(t.campaignId)) {
      prices.set(t.campaignId, await tokenUsdPrice(campaign.chain, campaign.tokenCa, deps));
    }
    const price = prices.get(t.campaignId);
    const usdEstimate = price != null && Number.isFinite(Number(t.amountText))
      ? Number((Number(t.amountText) * price).toFixed(2)) : null;
    claims.push({
      broadcast: chainSignal,
      caps,
      intent: {
        intent_id: t.id,
        idempotency_key: t.plannedHash,
        chain: t.chain,
        campaign_id: t.campaignId,
        recipient_id: t.recipientId,
        key_class: 'deposit',
        fee_status: 'paid',
        gas_ceiling_wei: campaign.gasCeilingWei ?? null,
        to: recipient.walletAddress,
        token: campaign.tokenCa,
        amount_text: t.amountText,
        token_decimals: decimals.get(t.campaignId),
        usd_estimate: usdEstimate,
        deposit: { address: campaign.depositAddress, encrypted_pk: campaign.encryptedDepositPk },
      },
    });
  }
  return { claims, skipped, broadcast: broadcastAll, noGasCampaigns };
}

/**
 * Masterspend caller — deposit_gas_float. When claim assembly finds a
 * campaign deposit wallet with ZERO native gas, the capped master-spend
 * engine is asked to float it (Base only in v1, ≤3 campaigns per pass,
 * one attempt per campaign per 24h via a config marker — the engine's
 * own ledger records every attempt's outcome). Sizing follows the
 * original's shortfall shape: remaining planned transfers × 65k gas ×
 * the live gas price, floored at 0.0005 ETH; the engine's USD caps are
 * the binding ceiling. Alert-first: pushSignerClaims' existing owner
 * alert fires for the stuck campaign regardless of the float's outcome,
 * and a landed float pages the owner again as part of the spend.
 */
async function maybeFloatDepositGas(noGasCampaigns) {
  const list = (noGasCampaigns ?? [])
    .filter((c) => c && c.chain === 'base' && c.depositAddress)
    .slice(0, 3);
  for (const c of list) {
    const markerKey = `masterspend_float_try:${c.campaignId}`;
    const last = Number(await getConfig(markerKey, '0').catch(() => '0')) || 0;
    if (Date.now() - last < 24 * 3600_000) continue;
    await setConfig(markerKey, String(Date.now())).catch(() => {});
    let amountText = '0.0005';
    try {
      const pending = await db.select().from(airdrop_transfers)
        .where(and(eq(airdrop_transfers.campaignId, c.campaignId), eq(airdrop_transfers.status, 'planned')))
        .all();
      const gp = await evmGasPriceWei('base');
      const need = gp * 65000n * BigInt(Math.max(1, pending.length));
      const floorWei = 500000000000000n; // 0.0005 ETH
      amountText = fmtDec(need > floorWei ? need : floorWei);
    } catch { /* keep the floor amount */ }
    await masterSpend({
      purpose: 'deposit_gas_float', chain: 'base', asset: 'native',
      to: c.depositAddress, amountText,
      initiatedBy: 'system:signer_claims', detail: `campaign=${c.campaignId}`,
    }).catch(() => null);
  }
}

/** Assemble + push claims to the Worker; mark pushed transfers 'queued'. */
export async function pushSignerClaims({ poster }, deps = {}) {
  const { claims, skipped, broadcast, noGasCampaigns } = await assembleSignerClaims(deps);
  let pushed = 0;
  for (let i = 0; i < claims.length; i += SIGNER_PUSH_CHUNK) {
    const chunk = claims.slice(i, i + SIGNER_PUSH_CHUNK);
    const resp = await poster('/api/internal/signer/push', { intents: chunk });
    if (!resp || resp.ok !== true) {
      return { error: resp?.error ?? 'push_failed', assembled: claims.length, pushed, skipped, broadcast };
    }
    for (const c of chunk) {
      await db.update(airdrop_transfers).set({ signerOutcome: 'queued' })
        .where(eq(airdrop_transfers.id, c.intent.intent_id)).run().catch(() => {});
      pushed++;
    }
  }
  if (skipped.noGas) {
    await alertOwner('airdrop', `⛽ Airdrop sends held: ${skipped.noGas} intent(s) sit on deposit wallets with ZERO native gas balance.\nFund the campaign deposit wallet(s) with gas — the intents stay planned and assemble automatically once funded.`);
    await auditMoney('airdrop', '', 'signer_claims_gas_held', `count=${skipped.noGas}`);
    // Masterspend: ask the capped engine to float the gas itself (it
    // refuses while disarmed — the shipped default — and the alert
    // above remains the owner's signal either way).
    await maybeFloatDepositGas(noGasCampaigns).catch(() => {});
  }
  if (pushed) {
    await auditMoney('airdrop', '', 'signer_claims_pushed', `count=${pushed} broadcast=${broadcast}`);
  }
  return { assembled: claims.length, pushed, skipped, broadcast };
}

async function settleGasReservation(campaign) {
  // One confirmed send settles one ceiling-share of the reservation.
  if (!campaign?.gasCeilingWei || campaign.gasReservedWei == null) return;
  try {
    const next = BigInt(campaign.gasReservedWei) - BigInt(campaign.gasCeilingWei);
    await db.update(airdrop_campaigns)
      .set({ gasReservedWei: String(next > 0n ? next : 0n) })
      .where(eq(airdrop_campaigns.id, campaign.id)).run();
  } catch { /* bookkeeping only */ }
}

async function maybeCompleteCampaign(campaign) {
  if (!campaign || !['awaiting_arm', 'planned'].includes(campaign.status)) return false;
  const transfers = await db.select().from(airdrop_transfers)
    .where(eq(airdrop_transfers.campaignId, campaign.id)).all().catch(() => []);
  if (!transfers.length) return false;
  if (!transfers.every((t) => ['sent', 'confirmed'].includes(t.status))) return false;
  await db.update(airdrop_campaigns).set({ status: 'completed' })
    .where(and(eq(airdrop_campaigns.id, campaign.id), eq(airdrop_campaigns.status, campaign.status))).run();
  await auditMoney('airdrop', campaign.telegramUserId, 'campaign_completed', `campaign=${campaign.id} via=signer_reports`);
  return true;
}

/**
 * Apply ONE pulled signer outcome to PB state (DESIGN §3 mapping).
 * Idempotent: re-applying the same outcome is a no-op 'duplicate'.
 */
export async function applySignerOutcome(outcome) {
  const transferId = Number(outcome?.intent_id);
  if (!Number.isFinite(transferId)) return { bad: 'intent_id' };
  const transfer = await db.select().from(airdrop_transfers)
    .where(eq(airdrop_transfers.id, transferId)).get().catch(() => null);
  if (!transfer) return { missing: transferId };
  // Cancel is terminal: a cancelled transfer never processes an outcome.
  // The one exception is evidence — a broadcast that already happened
  // (confirmed / failed-with-hash / already_executed-with-hash) is
  // surfaced to the owner for manual reconciliation, never applied, so
  // a real send is never silently hidden by the cancel.
  if (transfer.status === 'cancelled') {
    const st = String(outcome.status ?? '');
    const txHash = outcome.tx_hash ? String(outcome.tx_hash) : null;
    if (st === 'confirmed' || st === 'already_executed' || (st === 'failed' && txHash)) {
      const campaign = await db.select().from(airdrop_campaigns)
        .where(eq(airdrop_campaigns.id, transfer.campaignId)).get().catch(() => null);
      await auditMoney('airdrop', campaign?.telegramUserId, 'signer_outcome_on_cancelled',
        `campaign=${transfer.campaignId} transfer=${transferId} status=${st} hash=${(txHash ?? '').slice(0, 18)}`);
      await alertOwner('airdrop', `⚠️ Airdrop send landed for a cancelled campaign\nCampaign ${transfer.campaignId} transfer ${transferId} reported ${st}${txHash ? ` (tx ${txHash})` : ''} after cancellation.\nThe transfer stays cancelled in PB — reconcile this send against the chain manually; it was not re-sent by PB.`);
    }
    return { ignored: 'cancelled_transfer' };
  }
  const status = String(outcome.status ?? '');
  const reason = outcome.reason ? String(outcome.reason) : null;
  const txHash = outcome.tx_hash ? String(outcome.tx_hash) : null;
  const reportedAt = Number(outcome.reported_at ?? outcome.updated_at ?? 0) || null;
  const outcomeLabel = status === 'refused' ? `refused:${reason ?? 'unknown'}` : status;
  if (transfer.signerOutcome === outcomeLabel && (transfer.signerTxHash ?? null) === txHash) {
    return { duplicate: true };
  }
  const campaign = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.id, transfer.campaignId)).get().catch(() => null);
  const baseSet = { signerOutcome: outcomeLabel, signerReportedAt: reportedAt };
  if (txHash) baseSet.signerTxHash = txHash;

  if (status === 'dry_run') {
    await db.update(airdrop_transfers).set(baseSet).where(eq(airdrop_transfers.id, transferId)).run();
    await auditMoney('airdrop', campaign?.telegramUserId, 'signer_dry_run',
      `campaign=${transfer.campaignId} transfer=${transferId} hash=${(txHash ?? '').slice(0, 18)}`);
    return { applied: 'dry_run' };
  }
  if (status === 'refused') {
    await db.update(airdrop_transfers).set(baseSet).where(eq(airdrop_transfers.id, transferId)).run();
    await auditMoney('airdrop', campaign?.telegramUserId, 'signer_refused',
      `campaign=${transfer.campaignId} transfer=${transferId} reason=${reason ?? 'unknown'}`);
    if (reason === 'fee_unpaid') {
      // A fee_unpaid refusal means the bridge assembled a claim it should
      // never have — an alarm, not a routine event (DESIGN §3).
      await alertOwner('airdrop', `🚨 Signer refused a claim as FEE UNPAID\nCampaign ${transfer.campaignId} transfer ${transferId}.\nThe fee gate should have stopped this PB-side — investigate before arming.`);
    } else {
      await alertOwner('airdrop', `⚠️ Signer refused an airdrop send\nCampaign ${transfer.campaignId} transfer ${transferId}: ${reason ?? 'unknown'}\nThe intent stays planned; fix the configuration and it re-queues.`);
    }
    return { applied: 'refused' };
  }
  if (status === 'confirmed') {
    if (transfer.status === 'sent') {
      await db.update(airdrop_transfers).set(baseSet).where(eq(airdrop_transfers.id, transferId)).run();
      return { duplicate: true };
    }
    await db.update(airdrop_transfers).set({
      ...baseSet, status: 'sent', txHash: txHash ?? transfer.txHash,
      broadcastAt: transfer.broadcastAt ?? reportedAt, confirmedAt: reportedAt,
    }).where(eq(airdrop_transfers.id, transferId)).run();
    await db.update(airdrop_recipients).set({
      status: 'sent', txHash: txHash ?? transfer.txHash, sentAt: reportedAt,
    }).where(eq(airdrop_recipients.id, transfer.recipientId)).run().catch(() => {});
    if (campaign) {
      await db.update(airdrop_campaigns).set({ txSuccess: (campaign.txSuccess ?? 0) + 1 })
        .where(eq(airdrop_campaigns.id, campaign.id)).run().catch(() => {});
      await settleGasReservation(campaign);
      await maybeCompleteCampaign({ ...campaign, status: campaign.status });
    }
    await auditMoney('airdrop', campaign?.telegramUserId, 'signer_confirmed',
      `campaign=${transfer.campaignId} transfer=${transferId} hash=${(txHash ?? '').slice(0, 18)}`);
    return { applied: 'confirmed' };
  }
  if (status === 'failed') {
    if (txHash) {
      // Broadcast happened but confirmation failed — NEVER auto-retried;
      // the row parks at recovery_required for read-only reconciliation.
      await db.update(airdrop_transfers).set({
        ...baseSet, signerOutcome: 'recovery_required', status: 'recovery_required', txHash,
        error: outcome.error ? String(outcome.error).slice(0, 300) : 'post-broadcast failure',
      }).where(eq(airdrop_transfers.id, transferId)).run();
      await auditMoney('airdrop', campaign?.telegramUserId, 'signer_recovery_required',
        `campaign=${transfer.campaignId} transfer=${transferId} hash=${txHash.slice(0, 18)}`);
      const link = explorerTxUrl(transfer.chain, txHash);
      await alertOwner('airdrop', `🛠️ Airdrop send needs recovery review\nCampaign ${transfer.campaignId} transfer ${transferId} broadcast as ${txHash} but did not confirm.\nIt will NOT be re-sent automatically — reconcile against the chain first.${link ? `\n${link}` : ''}`);
      return { applied: 'recovery_required' };
    }
    await db.update(airdrop_transfers).set({
      ...baseSet, status: 'failed',
      error: outcome.error ? String(outcome.error).slice(0, 300) : 'signer failure',
    }).where(eq(airdrop_transfers.id, transferId)).run();
    if (campaign) {
      await db.update(airdrop_campaigns).set({ txFailed: (campaign.txFailed ?? 0) + 1 })
        .where(eq(airdrop_campaigns.id, campaign.id)).run().catch(() => {});
    }
    await auditMoney('airdrop', campaign?.telegramUserId, 'signer_failed',
      `campaign=${transfer.campaignId} transfer=${transferId} stage=${outcome.stage ?? ''}`);
    return { applied: 'failed' };
  }
  if (status === 'already_executed') {
    // The worker's ledger already holds this send (DESIGN §3): no state
    // change — reconcile the hash onto the row and move on.
    const set = { ...baseSet };
    if (txHash && !transfer.txHash) set.txHash = txHash;
    await db.update(airdrop_transfers).set(set).where(eq(airdrop_transfers.id, transferId)).run();
    await auditMoney('airdrop', campaign?.telegramUserId, 'signer_reconciled',
      `campaign=${transfer.campaignId} transfer=${transferId} hash=${(txHash ?? '').slice(0, 18)}`);
    return { applied: 'already_executed' };
  }
  return { ignored: status };
}

/** Pull outcome deltas from the Worker and apply them, cursor-tracked. */
export async function ingestSignerOutcomes({ getter }) {
  let cursor = Number(await getConfig(SIGNER_PULL_CURSOR_KEY, '0').catch(() => '0')) || 0;
  const counts = {};
  let applied = 0;
  for (let page = 0; page < 5; page++) {
    const data = await getter('/api/internal/signer/pull', { cursor });
    const outcomes = Array.isArray(data?.outcomes) ? data.outcomes : [];
    if (!outcomes.length) break;
    for (const outcome of outcomes) {
      try {
        const r = await applySignerOutcome(outcome);
        const key = r.applied ?? (r.duplicate ? 'duplicate' : r.missing ? 'missing' : 'other');
        counts[key] = (counts[key] ?? 0) + 1;
        if (r.applied) applied++;
      } catch (err) {
        console.error('[signerPull]', outcome?.intent_id, err?.message ?? err);
        counts.error = (counts.error ?? 0) + 1;
      }
    }
    const next = Number(data?.cursor ?? cursor);
    if (Number.isFinite(next) && next !== cursor) {
      cursor = next;
      await setConfig(SIGNER_PULL_CURSOR_KEY, String(cursor)).catch(() => {});
    }
    if (outcomes.length < 1000) break;
  }
  return { applied, counts, cursor };
}

// ── Deposit-gen sync (§8.5: host-side Solana deposit keypairs) ──────────────
// Campaigns parked at 'deposit_generating' (fee settled, no wallet yet)
// are requested over the bridge depgen channel; the host-side signer
// worker generates the keypair and reports back address + vault
// ciphertext. Results apply ONLY to a campaign still waiting with no
// deposit address — a stale or second result can never overwrite a
// wallet (idempotent, like applySignerOutcome). While the bridge route
// is not yet deployed the poster returns an error (signedPost) or the
// getter throws (signedGet) and the campaign simply stays parked —
// fail-closed and honest, exactly how the signer sync behaved
// pre-deploy. Generation failures leave the campaign parked too: the
// next sync re-pushes and the bridge re-queues the failed request.
const DEPGEN_PULL_CURSOR_KEY = 'depgen_pull_cursor';

export async function assembleDepositGenRequests() {
  const rows = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.status, 'deposit_generating')).limit(100).all().catch(() => []);
  const requests = [];
  for (const c of rows) {
    if (c.chain !== 'sol' || c.depositAddress) continue; // defensive: sol-only, wallet-less
    requests.push({ campaign_id: c.id, chain: 'sol' });
  }
  return requests;
}

/** Push pending deposit-gen requests to the Worker; a bridge that does
 *  not know the route yet (404/501) is an honest park, not an error
 *  state — the campaigns simply wait for the next sync. */
export async function pushDepositGenRequests({ poster }) {
  const requests = await assembleDepositGenRequests();
  if (!requests.length) return { requested: 0 };
  const resp = await poster('/api/internal/signer/depgen/push', { requests });
  if (!resp || resp.ok !== true) {
    return { error: resp?.error ?? 'depgen_push_failed', requested: 0, waiting: requests.length };
  }
  return { requested: requests.length, queued: resp.queued ?? 0, requeued: resp.requeued ?? 0 };
}

/**
 * Apply ONE pulled deposit-gen result. Idempotent: anything for a
 * campaign that is no longer waiting (or already has a wallet) is a
 * no-op 'duplicate' — the FIRST wallet a campaign gets is the only one
 * it ever gets.
 */
export async function applyDepositGenResult(result) {
  const campaignId = Number(result?.campaign_id);
  if (!Number.isFinite(campaignId)) return { bad: 'campaign_id' };
  const campaign = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.id, campaignId)).get().catch(() => null);
  if (!campaign) return { missing: campaignId };
  if (campaign.status !== 'deposit_generating' || campaign.depositAddress) {
    return { duplicate: true };
  }
  const status = String(result.status ?? '');
  if (status === 'generated') {
    const address = String(result.deposit_address ?? '');
    const encrypted = String(result.encrypted_pk ?? '');
    const parts = encrypted.split(':');
    const shapeOk = isValidSolAddress(address)
      && parts.length === 3 && parts.every((p) => /^[0-9a-fA-F]+$/.test(p));
    if (!shapeOk) {
      // A malformed "result" is a bridge/worker bug — never store it;
      // the campaign stays parked and the owner hears about it.
      await auditMoney('airdrop', campaign.telegramUserId, 'deposit_gen_bad_result', `campaign=${campaignId}`);
      await alertOwner('airdrop', `🚨 Solana deposit generation returned a malformed result\nCampaign ${campaignId}. The campaign stays parked with NO deposit wallet — investigate the signer worker before retrying.`);
      return { bad: 'result_shape' };
    }
    await db.update(airdrop_campaigns).set({
      status: 'deposit_pending', depositAddress: address, encryptedDepositPk: encrypted,
    }).where(and(eq(airdrop_campaigns.id, campaignId), eq(airdrop_campaigns.status, 'deposit_generating'))).run();
    const after = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, campaignId)).get();
    if (after?.status !== 'deposit_pending' || after?.depositAddress !== address) return { skipped: 'lost_claim' };
    await auditMoney('airdrop', campaign.telegramUserId, 'deposit_generated', `campaign=${campaignId} via=host_signer`);
    return { applied: 'generated', depositAddress: address };
  }
  if (status === 'failed') {
    await auditMoney('airdrop', campaign.telegramUserId, 'deposit_gen_failed',
      `campaign=${campaignId} error=${String(result.error ?? 'unknown').slice(0, 120)}`);
    await alertOwner('airdrop', `⚠️ Solana deposit wallet generation failed\nCampaign ${campaignId}: ${String(result.error ?? 'unknown').slice(0, 200)}\nThe fee is settled and the campaign stays parked — generation retries automatically on the next sync.`);
    return { applied: 'failed' };
  }
  return { ignored: status };
}

/** Pull deposit-gen result deltas from the Worker, cursor-tracked. */
export async function ingestDepositGenResults({ getter }) {
  let cursor = Number(await getConfig(DEPGEN_PULL_CURSOR_KEY, '0').catch(() => '0')) || 0;
  const counts = {};
  let applied = 0;
  for (let page = 0; page < 5; page++) {
    const data = await getter('/api/internal/signer/depgen/pull', { cursor });
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) break;
    for (const result of results) {
      try {
        const r = await applyDepositGenResult(result);
        const key = r.applied ?? (r.duplicate ? 'duplicate' : r.missing ? 'missing' : r.bad ? 'bad' : 'other');
        counts[key] = (counts[key] ?? 0) + 1;
        if (r.applied) applied++;
      } catch (err) {
        console.error('[depgenPull]', result?.campaign_id, err?.message ?? err);
        counts.error = (counts.error ?? 0) + 1;
      }
    }
    const next = Number(data?.cursor ?? cursor);
    if (Number.isFinite(next) && next !== cursor) {
      cursor = next;
      await setConfig(DEPGEN_PULL_CURSOR_KEY, String(cursor)).catch(() => {});
    }
    if (results.length < 1000) break;
  }
  return { applied, counts, cursor };
}

/** One full signer bridge pass (websync channel; failure-isolated halves). */
export async function runSignerSync(secret, deps = {}) {
  let push, pull, depgenPush, depgenPull;
  try { push = await pushSignerClaims(deps); } catch (err) { push = { error: err?.message ?? 'unknown' }; }
  try { pull = await ingestSignerOutcomes(deps); } catch (err) { pull = { error: err?.message ?? 'unknown' }; }
  // §8.5 deposit-gen halves: independently failure-isolated — a missing
  // bridge route or a dead worker never disturbs claim sync, and claim
  // sync never disturbs deposit generation.
  try { depgenPush = await pushDepositGenRequests(deps); } catch (err) { depgenPush = { error: err?.message ?? 'unknown' }; }
  try { depgenPull = await ingestDepositGenResults(deps); } catch (err) { depgenPull = { error: err?.message ?? 'unknown' }; }
  return { push, pull, depgenPush, depgenPull };
}

// ── Migrated-campaign re-key (bookkeeping, agreed 2026-10-20) ───────────────
// The 4 migrated campaigns are Rowdy's own: in pb_dev_dump.sql every one is
// clerk_user_id='admin' (the operator's website identity) with a $0 waived
// fee. The rev-76 migration deliberately carried NO owner key, so they are
// invisible to /mydrops + the Mini App (which filter on telegramUserId).
// This re-key writes telegramUserId ONLY for rows whose live state still
// matches the dump evidence exactly (deposit address per id + $PBAI + Base
// + completed + currently unkeyed). Anything else is reported, never forced.
const MIGRATED_CAMPAIGN_EVIDENCE = {
  1: '0x94370002f0Fbf199f7312AAC69807c4E5D6DFac5',
  2: '0x6086016eC84199E8587594fB4C84C4BecF5e91dE',
  3: '0x0Ce936E37B96B0bab51a46e2DBd15107bFbB642d',
  4: '0xfF735b3A2B26965292Bb272715fEd45F72393B84',
};

export async function rekeyMigratedCampaigns(ownerTgId = '8429146850') {
  const verdicts = [];
  for (const [idStr, deposit] of Object.entries(MIGRATED_CAMPAIGN_EVIDENCE)) {
    const id = Number(idStr);
    const row = await db.select().from(airdrop_campaigns)
      .where(eq(airdrop_campaigns.id, id)).get().catch(() => null);
    if (!row) { verdicts.push({ id, verdict: 'missing' }); continue; }
    if (row.telegramUserId === String(ownerTgId)) { verdicts.push({ id, verdict: 'already_keyed' }); continue; }
    const evidenceOk = !row.telegramUserId
      && String(row.tokenCa ?? '').toLowerCase() === PBAI_CA
      && row.chain === 'base'
      && row.status === 'completed'
      && String(row.depositAddress ?? '').toLowerCase() === deposit.toLowerCase();
    if (!evidenceOk) {
      verdicts.push({
        id, verdict: 'evidence_mismatch',
        telegramUserId: row.telegramUserId, tokenCa: row.tokenCa, chain: row.chain,
        status: row.status, depositAddress: row.depositAddress,
      });
      continue;
    }
    await db.update(airdrop_campaigns).set({ telegramUserId: String(ownerTgId) })
      .where(eq(airdrop_campaigns.id, id)).run();
    await auditMoney('airdrop', ownerTgId, 'campaign_rekeyed', `campaign=${id} evidence=dump_admin_row`);
    verdicts.push({ id, verdict: 'rekeyed' });
  }
  return { verdicts };
}

// ── Welcome airdrop claims (1,000 PBAI; permanent address dedup) ───────────

export async function claimWelcomeAirdrop(tgId, rawAddress) {
  const address = normalizeEvmAddress(String(rawAddress ?? ''));
  if (!address) return { error: 'not an EVM address' };
  const existing = await db.select().from(welcome_airdrop_claims)
    .where(eq(welcome_airdrop_claims.walletAddress, address)).get().catch(() => null);
  if (existing) return { already: true, status: existing.status };
  try {
    await db.insert(welcome_airdrop_claims).values({
      walletAddress: address,
      telegramUserId: String(tgId),
      status: 'claimed',
      amountText: WELCOME_AIRDROP_AMOUNT,
    }).run();
  } catch {
    return { already: true, status: 'claimed' }; // lost an insert race — the claim stands
  }
  await auditMoney('airdrop', tgId, 'welcome_claimed', `address=${address.slice(0, 10)}… amount=${WELCOME_AIRDROP_AMOUNT}`);
  // Masterspend wave: the fulfilment path the claim always pointed at.
  // The capped master-spend engine is attempted FIRST (it refuses
  // instantly while its arm flag is off — the shipped default — leaving
  // the claim queued exactly as before). On a landed send the claim is
  // finalized with the tx hash and the user hears "sent", not "queued".
  let spend = null;
  try {
    spend = await masterSpend({
      purpose: 'welcome_drop', chain: 'base', asset: PBAI_CA, to: address,
      amountText: WELCOME_AIRDROP_AMOUNT, initiatedBy: String(tgId), detail: 'welcome claim',
    });
  } catch { spend = null; }
  if (spend?.ok && spend.txHash) {
    await db.update(welcome_airdrop_claims)
      .set({ status: 'sent', txHash: spend.txHash, sentAt: Math.floor(Date.now() / 1000) })
      .where(eq(welcome_airdrop_claims.walletAddress, address)).run().catch(() => {});
    try {
      await api.sendMessage({
        chat_id: Number(tgId),
        text: `🎁 Welcome drop sent!\n\n${WELCOME_AIRDROP_AMOUNT} $PBAI is on its way to ${address}.\nTx: https://basescan.org/tx/${spend.txHash}`,
      });
    } catch { /* DM closed */ }
    return { claimed: true, sent: true, txHash: spend.txHash };
  }
  try {
    await api.sendMessage({
      chat_id: Number(tgId),
      text: `🎁 Welcome drop claimed!\n\n${WELCOME_AIRDROP_AMOUNT} $PBAI is queued for ${address}.\nDrops send when the operator arms live airdrops — your claim is permanent and address-locked, it can't be claimed twice.`,
    });
  } catch { /* DM closed */ }
  return { claimed: true };
}

// ── Campaign cancel (2026-10-26 wave) ───────────────────────────────────────
// Cancelling NEVER moves funds, never auto-refunds, never auto-sweeps.
// It only flips state (terminal, one-way) and marks planned transfers
// cancelled, so every status-filtered scan drops the campaign on its
// own: deposit watcher (deposit_pending), plan cycle (funded), parent
// rollup (see rollupAirdropParentById), assembly (awaiting_arm/planned
// + transfer planned), depgen assemble (deposit_generating), fee
// matcher + autoConfirmFreeFees + /dropfee (fee_pending). A paid fee
// stays non-refundable on cancel unless Rowdy orders otherwise.

export const AIRDROP_CANCELLABLE_STATUSES = [
  'fee_pending', 'deposit_generating', 'deposit_pending',
  'funded', 'planned', 'awaiting_arm',
];

async function getAirdropCampaignRow(id) {
  return db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.id, Number(id))).get().catch(() => null);
}

/** Deposit-wallet balance check for cancel (fail-closed): { zero: true }
 *  when provably empty, { positive: true } when any leg holds funds,
 *  { unreadable: true } when a leg cannot be read. The token leg is
 *  skipped when no token is designated (empty tokenCa) — there is no
 *  token to measure; the native leg still decides. No address →
 *  trivially zero (no wallet exists yet). */
async function airdropCancelBalance(row, deps = {}) {
  if (!row.depositAddress) return { zero: true };
  try {
    if (row.tokenCa) {
      const bal = await (deps.tokenBalance ?? tokenBalance)(row.chain, row.tokenCa, row.depositAddress);
      if (decCmp(String(bal), '0') > 0) return { positive: true };
    }
    const nat = await (deps.nativeBalance ?? nativeBalance)(row.chain, row.depositAddress);
    if (decCmp(String(nat), '0') > 0) return { positive: true };
  } catch { return { unreadable: true }; }
  return { zero: true };
}

/** Grouped-parent rollup (single predicate, shared by the plan tick and
 *  cancel): a parent mirrors its children once all are planned, and
 *  resolves terminal once all are terminal — a cancelled child can
 *  never stall the parent forever. All-cancelled → 'cancelled';
 *  mixed completed+cancelled → 'completed' (the group finished). */
export async function rollupAirdropParentById(parentId) {
  const p = await getAirdropCampaignRow(parentId);
  if (!p) return { skipped: 'missing' };
  const kids = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.parentId, p.id)).all().catch(() => []);
  if (!kids.length) return { skipped: 'no_kids' };
  if (kids.every((k) => ['awaiting_arm', 'planned', 'completed'].includes(k.status))) {
    if (p.status !== kids[0].status) {
      await db.update(airdrop_campaigns).set({ status: kids[0].status })
        .where(eq(airdrop_campaigns.id, p.id)).run();
    }
    return { mirrored: kids[0].status };
  }
  if (kids.every((k) => ['completed', 'cancelled'].includes(k.status))) {
    const to = kids.every((k) => k.status === 'cancelled') ? 'cancelled' : 'completed';
    if (p.status !== to) {
      await db.update(airdrop_campaigns).set({ status: to })
        .where(eq(airdrop_campaigns.id, p.id)).run();
    }
    return { terminal: to };
  }
  return { waiting: true };
}

/** Cancel a campaign (its owner, or Rowdy for any campaign). Terminal
 *  one-way: status 'cancelled', no path back, ever. Planned transfers
 *  are marked cancelled too — never rely on a single filter to keep a
 *  cancelled campaign's sends dead. Deposit wallets: fee_pending /
 *  deposit_generating (no wallet/funds) cancel freely;
 *  deposit_pending with verified-zero balance cancels and retires the
 *  wallet (key zeroed, booster unfunded-key hygiene); deposit_pending
 *  with balance > 0 or unreadable REFUSES (never strand funds, never
 *  zero a key whose wallet state is unknown); funded / planned /
 *  awaiting_arm cancel with the balance STAYING in place and the key
 *  KEPT (the refund route needs it) — disposition is Rowdy's decision,
 *  surfaced at cancel time, never an automated move. In-flight guard:
 *  a transfer already pushed to the signer (signerOutcome 'queued')
 *  refuses the cancel until the next sync ingests its outcome — the
 *  worker holds that claim and the tree cannot recall it. Grouped
 *  parents cascade: cancellable children cancel with the parent (all
 *  checks run first, so a refused child refuses the whole group and
 *  nothing half-applies); terminal children (completed/expired/
 *  cancelled) are left alone. Campaign #5 is NOT cancelled here — it
 *  becomes one button press away; its actual cancel is the owner's or
 *  Rowdy's press, never a build side effect. */
export async function cancelAirdropCampaign(tgId, campaignId, deps = {}) {
  const row = await getAirdropCampaignRow(campaignId);
  if (!row) return { error: 'Campaign not found.' };
  const isOwner = row.telegramUserId === String(tgId);
  const isRowdy = await requireOwner(tgId).catch(() => false);
  if (!isOwner && !isRowdy) return { error: 'Campaign not found.' };
  if (!AIRDROP_CANCELLABLE_STATUSES.includes(row.status)) {
    return { error: `A ${String(row.status).replace(/_/g, ' ')} campaign can't be cancelled.` };
  }
  let targets = [row];
  if (row.chain === 'all') {
    const kids = await db.select().from(airdrop_campaigns)
      .where(eq(airdrop_campaigns.parentId, row.id)).all().catch(() => []);
    for (const k of kids) {
      if (['completed', 'expired', 'cancelled'].includes(k.status)) continue;
      if (!AIRDROP_CANCELLABLE_STATUSES.includes(k.status)) {
        return { error: `Child campaign #${k.id} is ${String(k.status).replace(/_/g, ' ')} — the group can't be cancelled while a child is in that state.` };
      }
      targets.push(k);
    }
  }
  // CHECK PHASE — no writes yet.
  for (const t of targets) {
    const queued = await db.select().from(airdrop_transfers)
      .where(and(eq(airdrop_transfers.campaignId, t.id), eq(airdrop_transfers.signerOutcome, 'queued'))).all().catch(() => []);
    if (queued.some((x) => x.status !== 'cancelled')) {
      return { error: `Campaign #${t.id} has sends still in flight to the signing service — wait for the next sync and try again.` };
    }
    if (t.status === 'deposit_pending' && t.depositAddress) {
      const bal = await airdropCancelBalance(t, deps);
      if (bal.unreadable) return { error: 'Deposit balance could not be checked — cancellation refused rather than risk stranding funds. Try again shortly.' };
      if (bal.positive) return { error: 'This deposit wallet already holds funds — cancelling would strand them. The campaign stays open; funds are handled through the refund path, never by deleting the key.' };
    }
  }
  // WRITE PHASE — guarded transitions, then transfer marking.
  const cancelledIds = [];
  let fundsStay = false;
  let feeKept = false;
  for (const t of targets) {
    if (['funded', 'planned', 'awaiting_arm'].includes(t.status)) fundsStay = true;
    if (t.status !== 'fee_pending' && Number(t.serviceFeeUsd ?? 0) > 0) feeKept = true;
    const zeroKey = ['fee_pending', 'deposit_generating', 'deposit_pending'].includes(t.status);
    await db.update(airdrop_campaigns).set({
      status: 'cancelled', ...(zeroKey ? { encryptedDepositPk: null } : {}),
    }).where(and(eq(airdrop_campaigns.id, t.id), eq(airdrop_campaigns.status, t.status))).run();
    const after = await getAirdropCampaignRow(t.id);
    if (after?.status !== 'cancelled') {
      return { error: 'Campaign state changed — please reload.', partial: cancelledIds };
    }
    await db.update(airdrop_transfers).set({ status: 'cancelled' })
      .where(and(eq(airdrop_transfers.campaignId, t.id), eq(airdrop_transfers.status, 'planned'))).run();
    await auditMoney('airdrop', t.telegramUserId, 'campaign_cancelled', `campaign=${t.id} from=${t.status}`);
    cancelledIds.push(t.id);
  }
  // A cancelled child must never stall its parent: roll the parent up
  // immediately (the plan tick re-runs the same predicate next minute).
  if (row.parentId) await rollupAirdropParentById(row.parentId).catch(() => {});
  if (fundsStay) {
    await alertOwner('airdrop', `🛑 Airdrop campaign #${row.id} cancelled\n${cancelledIds.length > 1 ? `${cancelledIds.length} campaigns cancelled (group). ` : ''}Any balance stays in the deposit wallet — refunds are the owner's decision, never automatic.`);
  }
  return { ok: true, cancelledIds, fundsStay, feeKept };
}

function cancelAirdropSuccessText(res, firstId) {
  const lines = [`🛑 Campaign #${firstId} cancelled.`];
  if (res.cancelledIds.length > 1) lines.push(`Group cancel: ${res.cancelledIds.length} campaigns cancelled (${res.cancelledIds.join(', ')}).`);
  if (res.fundsStay) lines.push('Any balance stays in the deposit wallet — refunds are the owner\u2019s decision, never automatic.');
  if (res.feeKept) lines.push('A paid service fee stays non-refundable unless the owner orders otherwise.');
  return lines.join('\n');
}

// ── Rendering ───────────────────────────────────────────────────────────────

const AIRDROP_STATUS_ICON = {
  pending_review: '🔍', pending_deposit: '💳', funded: '💰', distributing: '📤',
  completed: '✅', failed: '❌', cancelled: '🚫', fee_pending: '🧾',
  deposit_pending: '💳', planned: '🗺️', awaiting_arm: '⏸️', expired: '⌛',
  deposit_generating: '⏳',
  recovery_required: '🛠️', draft: '📝', quote_ready: '🧾',
};

export function renderAirdropLine(c) {
  const icon = AIRDROP_STATUS_ICON[c.status] ?? '❓';
  const token = c.tokenName ?? (c.tokenCa ? c.tokenCa.slice(0, 10) + '…' : 'Unknown');
  const stats = c.status === 'completed' ? ` — ${c.txSuccess ?? 0} sent` : '';
  const line = `${icon} ${token} (${c.chain ?? 'base'}) — ${(c.status ?? 'unknown').replace(/_/g, ' ')}${stats}`;
  // 2026-10-27 mydrops fix: /mydrops is the command the wizard points to
  // for the deposit address ("Run /mydrops for the deposit address"), but
  // this line never included one — a deposit_pending campaign showed no
  // address anywhere in the list, so users had nowhere to send. The
  // address is public-facing by design (customers send tokens TO it), so
  // it renders in full here — never truncated, truncation breaks copy.
  // fee_pending shows nothing (no address exists yet — correct).
  if (c.status === 'deposit_pending' && c.depositAddress) {
    return `${line}\n   📥 Deposit: ${c.depositAddress}`;
  }
  return line;
}

// 2026-10-27 mydrops copy fix: Telegram copies a whole message on
// long-press, so a bare address inside /mydrops output cannot be copied
// alone — and copying the address is the entire point of that screen
// (users send tokens TO it). copy_text is Telegram's native tap-to-copy
// affordance, same pattern as the '📋 Copy Base CA' button in
// handlers/message.js: tapping copies just the address, no callback
// round-trip, no whole-message copy. Pure function (harness-tested):
// one row per deposit_pending campaign WITH an address, labelled by id
// so multiple pending campaigns are never ambiguous. EVM (42) and
// Solana (44) addresses are both far under copy_text's 256-char limit.
export function airdropDepositCopyRows(rows) {
  return (rows ?? [])
    .filter((r) => r.status === 'deposit_pending' && r.depositAddress)
    .map((r) => ([{ text: `📋 Copy deposit #${r.id}`, copy_text: { text: r.depositAddress } }]));
}

export function renderAirdropDetail(c, feePayAddress = null) {
  // Army price kill (2026-10-26): never quote an Army $49/$79 fee. Army
  // rows show the benefit-covered line at $0, and no fee line at all when
  // a fee is due (fee computation untouched — see wave report).
  const armyDetail = c.recipientMode === 'army' || c.chain === 'all';
  const detailFeeLine = !armyDetail
    ? `Service fee: $${c.serviceFeeUsd ?? '0'}${c.platformFeeUsd && c.platformFeeUsd !== c.serviceFeeUsd ? ` (list $${c.platformFeeUsd}, tier benefit applied)` : ''}`
    : (Number(c.serviceFeeUsd ?? 0) > 0 ? null : 'Service fee: covered by your tier benefit.');
  const lines = [
    `🪂 Airdrop #${c.id} — ${c.recipientMode ?? 'legacy'} on ${(c.chain ?? 'base').toUpperCase()}`,
    `Status: ${(c.status ?? '').replace(/_/g, ' ')}`,
    `Token: ${c.tokenCa ?? '—'}`,
    `Per wallet: ${c.amountPerWallet ?? '?'} × ${c.walletCount ?? 0} wallets`,
    ...(detailFeeLine ? [detailFeeLine] : []),
    `Network reserve: $${c.networkReserveUsd ?? '0'}`,
  ];
  if (c.status === 'deposit_pending' && c.depositAddress) {
    lines.push('', `Send the distribution tokens to:`, c.depositAddress, '', 'Detection is automatic (checked every few minutes).');
  }
  if (c.status === 'deposit_generating') {
    lines.push('', 'Fee confirmed ✅ — your Solana deposit wallet is being prepared by PB\u2019s signing service (usually a few minutes). The deposit address will appear here as soon as it is ready — check /mydrops again shortly. No address exists yet, so don\u2019t send tokens anywhere yet.');
  }
  if (c.status === 'fee_pending' && !(armyDetail && Number(c.serviceFeeUsd ?? 0) > 0)) {
    lines.push('', ...airdropFeePayLines(c.serviceFeeUsd ?? '0', feePayAddress));
  }
  if (c.status === 'funded') {
    lines.push('', 'Funded ✅ — planning runs on the next tick; distribution opens when the operator arms live sends. Nothing has been broadcast.');
  }
  if (c.status === 'planned') {
    lines.push('', 'Planned — distribution opens when the operator arms live sends. Nothing has been broadcast.');
  }
  if (c.status === 'awaiting_arm') {
    lines.push('', 'Funded and fully planned — distribution opens when the operator arms live sends. Nothing has been broadcast.');
  }
  if (c.status === 'cancelled') {
    lines.push('', 'Cancelled — no further sends. Any balance stays in the deposit wallet pending the owner\u2019s decision.');
  }
  return lines.join('\n');
}

export async function listOwnAirdropCampaigns(tgId, limit = 10) {
  return db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.telegramUserId, String(tgId)))
    .orderBy(desc(airdrop_campaigns.createdAt)).limit(limit).all().catch(() => []);
}

// ── Wizard (DM-only; draft in config, Studio pattern) ───────────────────────

const WIZ_TTL_MS = 30 * 60 * 1000;
const wizKey = (uid) => `airdropwiz:${uid}`;
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
  await setConfig(wizKey(uid), JSON.stringify(draft)).catch(() => {}); }
async function clearWiz(uid) { await setConfig(wizKey(uid), JSON.stringify({ createdAt: 0 })).catch(() => {}); }

/** Live session predicate (single source of truth for the dispatcher):
 *  flag on AND a TTL-valid draft, any stage — a quoted wizard still
 *  awaits its Create/Cancel tap, so it counts as live. */
export async function isAirdropWizardActive(uid) {
  if (!(await isAirdropEnabled())) return false;
  return (await loadWiz(uid)) !== null;
}

/** Last-touch timestamp for routing order (0 = no live draft). */
export async function airdropWizardTouch(uid) {
  const draft = await loadWiz(uid);
  if (!draft) return 0;
  return draft.lastTouchAt ?? draft.createdAt ?? 0;
}

/** Next prompt for the routing guard's re-prompt (null = no session). */
export async function airdropWizardNextPrompt(uid) {
  const draft = await loadWiz(uid);
  if (!draft) return null;
  if (draft.stage === 'quoted') return '✅ Your airdrop campaign is already created — run /mydrops to track it, or /airdrop to start a new one.';
  if (draft.listCollecting) return '📋 Paste more recipient wallets, or send DONE when finished (CANCEL to stop).';
  if (!draft.tokenCa) return 'Send the token contract/mint address.';
  if (!draft.amountPerWallet) return 'How many tokens should each wallet receive? (e.g. 1000)';
  return 'Tap ✅ Create campaign or ❌ Cancel on the quote above.';
}

async function sendDm(uid, text, extra = {}) {
  try { await api.sendMessage({ chat_id: uid, text: String(text).slice(0, 4000), ...extra }); } catch { /* closed */ }
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

function productPanel() {
  return {
    text: '🪂 <b>Airdrop</b>\nStep 1 — pick a product\n────────────────\n🎖️ <b>Army Drop</b> — send to the registered PoorBoyAI Army (everyone who registered a receiving wallet).\n📋 <b>Custom List</b> — your own wallet list. $9 + $0.03 per valid unique wallet (Agency / PB Plan $0.02), up to 10,000.\n\nPB Plan: Custom Lists at $0.02 per wallet, applied automatically.',
    reply_markup: { inline_keyboard: [
      [{ text: '🎖️ Army Drop', callback_data: 'adrop:mode:army' }, { text: '📋 Custom List', callback_data: 'adrop:mode:custom' }],
      [{ text: '❌ Cancel', callback_data: 'adrop:cancel' }],
    ] },
  };
}

function chainPanel(draft) {
  const buttons = AIRDROP_CHAINS.map((c) => ({ text: CHAINS[c].label, callback_data: `adrop:chain:${c}` }));
  if (draft.mode === 'army') buttons.push({ text: '🌐 All three', callback_data: 'adrop:chain:all' });
  // Nine chains no longer fit one keyboard row — chunk into rows of 3.
  // Picking a chain whose layer is still closed refuses honestly in the
  // callback (and again at creation); the panel itself stays static.
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  rows.push([{ text: '❌ Cancel', callback_data: 'adrop:cancel' }]);
  return {
    text: `🪂 <b>${draft.mode === 'army' ? 'Army Drop' : 'Custom List'}</b>\nStep 2 — pick a chain\n────────────────`,
    reply_markup: { inline_keyboard: rows },
  };
}

async function quotePanel(uid, draft) {
  const tier = await getAirdropUserTier(uid);
  const usage = await getBenefitUsage(uid);
  let validCount = draft.validCount ?? 0;
  if (draft.mode === 'army') {
    const chains = draft.chain === 'all' ? AIRDROP_GROUP_CHAINS : [draft.chain];
    validCount = 0;
    for (const c of chains) validCount += (await armyPool(c)).length;
    if (!validCount) return { error: 'The Army pool is empty on the selected chain(s) — no holder, registered, or raid wallets yet.' };
  }
  const priced = priceWithBenefits({ tier, mode: draft.mode, chain: draft.chain, validCount, usage });
  draft.pricedFee = priced.serviceFeeUsd;
  draft.validCount = validCount;
  await saveWiz(uid, draft);
  // PRICING WAVE: show the trial waiver on the quote when it will
  // apply at creation (same gates as createAirdropCampaign via
  // trialWaiverApplies). Display only — creation re-checks and consumes.
  const waiverShown = await trialWaiverApplies(uid, {
    mode: draft.mode, chain: draft.chain, validCount, serviceFeeUsd: priced.serviceFeeUsd,
    // TRIALPOLICY 2026-11-01 (#12, display): the wizard never merges
    // holder snapshots, so registered-merge is the only impurity the
    // display can know. Display fails closed (merged → no waiver
    // shown); creation re-checks with the merged-total equality and
    // may still waive when the pool added nothing.
    customOnly: !draft.includeRegistered,
  });
  // Army price kill (2026-10-26): Army Drops have no standalone checkout
  // price — never quote $49/$79. Benefit-covered Army shows the covered
  // line; payable Army shows no amount (fee computation untouched — see
  // wave report: standalone Army purchase is a dead end until the parent
  // decides benefit-only vs a real checkout).
  const isArmyQuote = draft.mode === 'army';
  const feeLine = !isArmyQuote
    ? (waiverShown
      ? `Service fee: <b>$0</b> — your one trial waiver covers this drop (list $${priced.grossFeeUsd}). You still fund your own tokens and pay gas.`
      : `Service fee: <b>$${priced.serviceFeeUsd}</b>${priced.creditAppliedUsd ? ` (list $${priced.grossFeeUsd} − $${priced.creditAppliedUsd} tier benefit)` : ''}`)
    : (Number(priced.serviceFeeUsd) > 0 ? null : 'Service fee: covered by your tier benefit.');
  const confirmLine = (isArmyQuote && Number(priced.serviceFeeUsd) > 0)
    ? 'Confirm to create the campaign and lock this recipient snapshot.'
    : 'Confirm to create the campaign and lock this recipient snapshot. The deposit wallet opens once the service fee is confirmed.';
  const text = [
    '🧾 <b>Your airdrop quote</b> (15 minutes)',
    '',
    `${draft.mode === 'army' ? '🎖️ Army Drop' : '📋 Custom List'} on ${draft.chain === 'all' ? 'all three chains' : CHAINS[draft.chain].label}`,
    `Token: <code>${esc(draft.tokenCa)}</code>`,
    `Per wallet: <b>${esc(draft.amountPerWallet)}</b> · Recipients: <b>${validCount}</b>`,
    ...(feeLine ? [feeLine] : []),
    '',
    confirmLine,
  ].join('\n');
  return {
    text,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Create campaign', callback_data: 'adrop:create' }],
      [{ text: '❌ Cancel', callback_data: 'adrop:cancel' }],
    ] },
  };
}

export async function handleAirdropWizardText(chatId, user, text) {
  const uid = user?.id;
  if (!uid || !(await isAirdropEnabled())) return false;
  const draft = await loadWiz(uid);
  if (!draft) return false;
  // Quoted stage (hijack fix 2026-10-25): the wizard still owns the DM
  // while the created campaign awaits nothing further — typed text used
  // to decline here and fall through to the agent loop. Consume + nudge.
  if (draft.stage === 'quoted') {
    await sendDm(uid, '✅ Your airdrop campaign is already created — run /mydrops to track it, or /airdrop to start a new one.');
    return true;
  }
  const value = String(text ?? '').trim();
  if (draft.listCollecting) {
    if (value.toUpperCase() === 'DONE') {
      draft.listCollecting = false;
      try {
        const validated = validateWalletInput(draft.chain, draft.listText ?? '');
        draft.validCount = validated.validCount;
        draft.duplicateCount = validated.duplicateCount;
        draft.invalidCount = validated.invalidCount;
        if (!validated.addresses.length) {
          await sendDm(uid, 'No valid wallets found in that list — paste again, or type CANCEL to stop.');
          draft.listCollecting = true;
          await saveWiz(uid, draft);
          return true;
        }
        await saveWiz(uid, draft);
        await sendDm(uid, `📋 List checked: ${validated.validCount} valid unique · ${validated.duplicateCount} duplicates · ${validated.invalidCount} invalid.`);
        const panel = await quotePanel(uid, draft);
        if (panel.error) { await sendDm(uid, `⚠️ ${panel.error}`); return true; }
        await sendDm(uid, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
      } catch (err) {
        await sendDm(uid, `⚠️ ${err?.message ?? 'List problem'} — paste again or type CANCEL.`);
        draft.listCollecting = true;
        await saveWiz(uid, draft);
      }
      return true;
    }
    if (value.toUpperCase() === 'CANCEL') { await clearWiz(uid); await sendDm(uid, '❌ Airdrop wizard cancelled.'); return true; }
    draft.listText = `${draft.listText ?? ''}\n${value}`.slice(0, MAX_WALLET_INPUT_CHARS);
    await saveWiz(uid, draft);
    return true; // silently accumulate
  }
  if (!draft.tokenCa) {
    if (draft.chain !== 'all' && !(draft.chain === 'sol' ? isValidSolAddress(value) : isValidEvmAddress(value))) {
      await sendDm(uid, 'That token address isn\u2019t valid for this chain — send the token contract/mint address again.');
      return true;
    }
    if (draft.chain === 'all' && !isValidEvmAddress(value) && !isValidSolAddress(value)) {
      await sendDm(uid, 'Send the token address (the same token must exist on the chains you launch).');
      return true;
    }
    draft.tokenCa = value;
    await saveWiz(uid, draft);
    await sendDm(uid, 'How many tokens should each wallet receive? (e.g. 1000)');
    return true;
  }
  if (!draft.amountPerWallet) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(value) || Number(value) <= 0) {
      await sendDm(uid, 'Send the per-wallet amount as a number (e.g. 1000).');
      return true;
    }
    draft.amountPerWallet = value;
    await saveWiz(uid, draft);
    if (draft.mode === 'army') {
      // Quote-build throw containment (hijack fix 2026-10-25): a throw
      // here used to fall through to the agent loop. Reset the amount
      // so the next message retries the quote cleanly, and consume.
      let panel;
      try {
        panel = await quotePanel(uid, draft);
      } catch (err) {
        draft.amountPerWallet = null;
        await saveWiz(uid, draft);
        await sendDm(uid, '⚠️ The quote hit a snag — send the per-wallet amount again to retry.');
        return true;
      }
      if (panel.error) { await sendDm(uid, `⚠️ ${panel.error}`); await clearWiz(uid); return true; }
      await sendDm(uid, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
    } else {
      draft.listCollecting = true;
      draft.listText = '';
      await saveWiz(uid, draft);
      await sendDm(uid, [
        '📋 Paste your recipient wallets — one per line, comma-separated, or a CSV with an address column.',
        'You can send several messages; they accumulate. Send DONE when finished (CANCEL to stop).',
        draft.includeRegistered ? 'Registered Army wallets will be merged in and deduped.' : 'Tip: /airdrop again later with "include registered" to merge the Army pool.',
      ].join('\n'));
    }
    return true;
  }
  // Quote-shown state (hijack fix 2026-10-25): army amount step and custom
  // DONE both send the quote panel without setting stage 'quoted' (the
  // 'create' tap does that). Typed text in this state used to decline
  // and fall through to the agent loop. Consume + nudge instead.
  if (draft.tokenCa && draft.amountPerWallet && !draft.listCollecting) {
    await sendDm(uid, 'Tap ✅ Create campaign or ❌ Cancel on the quote above — typed words can\'t create it.');
    return true;
  }
  return false;
}

// ── Calendar slot wizard (2026-11-01 calendar wave) ─────────────────────────
// Same shared calendar as booster, inside the EXISTING airdrop wizard —
// no new command, no new card row. Steps, phone-simple, names/dates only:
//  1. Product is the wizard you are already in (Airdrop here; run /boost
//     in this DM to schedule a booster instead — products are never
//     mixed, and an airdrop slot is not a booster slot).
//  2. Pick a date, then a time slot. Full slots show as full and are
//     not buttons — pick around them to another open slot.
//  3. Preview: exact product, exact date/time, exact campaign, plus
//     the plain note that booking is scheduling only and sends still
//     wait for their gates.
//  4. Confirm / Cancel — Cancel books nothing; Confirm claims the slot
//     with a re-check at confirm time, so a slot that filled since the
//     view never double-books.
//  5. Confirmation naming the product and slot only.
// Booking a drop slot does NOT arm or execute a send. Airdrop sends
// stay gated exactly as before (phase 2 + passed canary + gas, Base
// first, Solana later, deposit-class keys only, master key never to a
// signer). A booked slot that arrives while still gated simply waits —
// it never auto-sends on gate status alone. Paid customers book ahead
// of trial users in execution order within a slot; trial airdrop
// campaigns (e.g. waiver-covered Custom Lists) may book, behind paid.
async function calDatePanelAdrop(campaignId) {
  const cal = await listCalendar('airdrop');
  if (cal.error) return { text: `⚠️ ${cal.error}`, reply_markup: null };
  const rows = cal.days.map((d) => ([{ text: `📅 ${d.date}`, callback_data: `adrop:slotdate:${campaignId}_${d.dateKey}` }]));
  rows.push([{ text: '❌ Cancel', callback_data: `adrop:slotcancel:${campaignId}` }]);
  return {
    text: `📅 <b>Airdrop — book a slot</b>\nStep 1 of 3 — pick a date\n────────────────\nCampaign #${campaignId}\nPick a day, then a time slot.\nFull slots are marked full and can't be picked.\n\nBooking a slot schedules your drop window only — sends run once the campaign is funded and its fee is paid.`,
    reply_markup: { inline_keyboard: rows },
  };
}
async function calTimePanelAdrop(campaignId, dateKey) {
  const cal = await listCalendar('airdrop');
  if (cal.error) return { text: `⚠️ ${cal.error}`, reply_markup: null };
  const day = (cal.days ?? []).find((d) => d.dateKey === dateKey);
  if (!day) return { text: 'That date is no longer on the calendar — pick another date.', reply_markup: { inline_keyboard: [[{ text: '📅 Back to dates', callback_data: `adrop:slot:${campaignId}` }]] } };
  const rows = day.slots.map((s) => (s.full
    ? [{ text: `❌ ${s.label} — Full`, callback_data: `adrop:slotfull:${campaignId}` }]
    : [{ text: `🟢 ${s.label} — Open`, callback_data: `adrop:slottime:${campaignId}_${s.start}` }]));
  rows.push([{ text: '📅 Back to dates', callback_data: `adrop:slot:${campaignId}` }]);
  rows.push([{ text: '❌ Cancel', callback_data: `adrop:slotcancel:${campaignId}` }]);
  return {
    text: `📅 <b>Airdrop — ${day.date}</b>\nStep 2 of 3 — pick a time slot\n────────────────\nOpen slots can be picked.\nFull slots are shown as full and can't be picked.`,
    reply_markup: { inline_keyboard: rows },
  };
}
function calPreviewPanelAdrop(campaignId, slotStart) {
  const label = calendarSlotLabel(slotStart);
  return {
    text: `📅 <b>Airdrop — confirm your slot</b>\nStep 3 of 3 — confirm\n────────────────\nProduct: Airdrop\nCampaign: #${campaignId}\nSlot: ${label}\n\nBooking is scheduling only — sends run once the campaign is funded and its fee is paid. Confirm to claim this slot, or cancel to book nothing.`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Confirm this slot', callback_data: `adrop:slotconfirm:${campaignId}_${slotStart}` }],
      [{ text: '❌ Cancel', callback_data: `adrop:slotcancel:${campaignId}` }],
    ] },
  };
}
async function handleCalendarSlotCallbackAdrop({ userId, data, messageId }) {
  const uid = userId;
  const [, sub, arg] = String(data).split(':');
  if (sub === 'slotcancel') {
    await editPanel(uid, messageId, '❌ Nothing booked — no slot was claimed.', null);
    return { text: 'Cancelled' };
  }
  if (sub === 'slotcancelbook') {
    const res = await cancelCalendarSlot({ product: 'airdrop', campaignId: arg, telegramUserId: uid });
    if (res.error) return { text: res.error, alert: true };
    await editPanel(uid, messageId, `❌ Airdrop booking cancelled (${res.slotLabel}). Pick another slot when ready.`, { inline_keyboard: [[{ text: '📅 Pick a slot', callback_data: `adrop:slot:${arg}` }]] });
    return { text: 'Booking cancelled' };
  }
  if (sub === 'slotfull') return { text: 'That slot is full — pick another open slot.', alert: true };
  if (sub === 'slot') {
    const row = await getAirdropCampaignRow(arg);
    if (!row || row.telegramUserId !== String(uid)) return { text: 'Campaign not found.', alert: true };
    const existing = await getCalendarBooking('airdrop', arg);
    if (existing) {
      await editPanel(uid, messageId, `📅 This campaign already has an Airdrop slot booked: <b>${existing.slotLabel}</b>.\n\nTo pick a different slot, cancel that booking first, then pick again.`, { inline_keyboard: [[{ text: '❌ Cancel this booking', callback_data: `adrop:slotcancelbook:${arg}` }]] });
      return { text: 'Already booked' };
    }
    const panel = await calDatePanelAdrop(arg);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Pick a date' };
  }
  if (sub === 'slotdate') {
    const [campaignId, dateKey] = String(arg).split('_');
    const panel = await calTimePanelAdrop(campaignId, dateKey);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Pick a time' };
  }
  if (sub === 'slottime') {
    const [campaignId, slotStart] = String(arg).split('_');
    const panel = calPreviewPanelAdrop(campaignId, Number(slotStart));
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: 'Preview' };
  }
  if (sub === 'slotconfirm') {
    const [campaignId, slotStart] = String(arg).split('_');
    const row = await getAirdropCampaignRow(campaignId);
    if (!row || row.telegramUserId !== String(uid)) return { text: 'Campaign not found.', alert: true };
    const tier = await getAirdropUserTier(uid);
    const res = await bookCalendarSlot({ product: 'airdrop', campaignId, telegramUserId: uid, tier, slotStart: Number(slotStart) });
    if (res.error) {
      await editPanel(uid, messageId, `⚠️ ${res.error}`, null);
      return { text: 'Slot problem', alert: true };
    }
    await editPanel(uid, messageId, `✅ <b>Airdrop slot booked: ${res.booking.slotLabel}</b>\n\nCampaign #${campaignId} is scheduled for that window. Sends run once the campaign is funded and its fee is paid.`, null);
    return { text: 'Slot booked' };
  }
  return null;
}

export async function handleAirdropCallback({ userId, data, messageId }) {
  const uid = userId;
  const [, sub, arg] = String(data).split(':');
  // Cancel branches run BEFORE the parked gate: cancelling is a safety
  // action, and a parked product must never strand a user in a campaign
  // they want out of (same rationale as the read-only commands, which
  // answer from the DB regardless of the flag).
  if (sub === 'cancelcamp') {
    const row = await getAirdropCampaignRow(arg);
    const isOwner = row && row.telegramUserId === String(uid);
    const isRowdy = await requireOwner(uid).catch(() => false);
    if (!row || (!isOwner && !isRowdy)) return { text: 'Campaign not found.', alert: true };
    if (!AIRDROP_CANCELLABLE_STATUSES.includes(row.status)) return { text: `A ${String(row.status).replace(/_/g, ' ')} campaign can't be cancelled.`, alert: true };
    await editPanel(uid, messageId, `Cancel airdrop campaign #${row.id}? This is final — the campaign stops and can't be restarted. No funds move: a paid fee stays non-refundable, and any balance stays in the deposit wallet pending the owner's decision.`, { inline_keyboard: [
      [{ text: '✅ Yes, cancel it', callback_data: `adrop:cancelgo:${row.id}` }],
      [{ text: '❌ Keep it', callback_data: `adrop:cancelkeep:${row.id}` }],
    ] });
    return { text: 'Confirm cancel' };
  }
  if (sub === 'cancelgo') {
    const res = await cancelAirdropCampaign(uid, arg);
    if (res?.error) return { text: res.error, alert: true };
    await editPanel(uid, messageId, cancelAirdropSuccessText(res, arg), null);
    return { text: 'Cancelled' };
  }
  if (sub === 'cancelkeep') {
    await editPanel(uid, messageId, 'Campaign kept — nothing changed.', null);
    return { text: 'Kept' };
  }
  // Calendar slot wizard branches run BEFORE the parked gate (like
  // cancel): booking a slot is scheduling only, never a send, so a
  // parked product can still be scheduled — with the gates copy in
  // the panels, never a promise that it sends.
  if (['slot', 'slotdate', 'slottime', 'slotconfirm', 'slotcancel', 'slotcancelbook', 'slotfull'].includes(sub)) {
    const handled = await handleCalendarSlotCallbackAdrop({ userId, data, messageId });
    if (handled) return handled;
  }
  if (!(await isAirdropEnabled())) return { text: '🪂 Airdrops are parked right now.', alert: true };
  const draft = (await loadWiz(uid)) ?? { createdAt: Date.now(), stage: 'start' };
  if (sub === 'cancel') {
    await clearWiz(uid);
    await editPanel(uid, messageId, '❌ Airdrop wizard cancelled.', null);
    return { text: 'Cancelled' };
  }
  if (sub === 'mode') {
    draft.mode = arg; draft.createdAt = Date.now(); draft.stage = 'chain';
    await saveWiz(uid, draft);
    const panel = chainPanel(draft);
    await editPanel(uid, messageId, panel.text, panel.reply_markup);
    return { text: arg === 'army' ? 'Army Drop' : 'Custom List' };
  }
  if (sub === 'chain') {
    if (arg !== 'all' && !AIRDROP_CHAINS.includes(arg)) return { text: 'Unknown chain', alert: true };
    // Chain layer (§6.2): a registered-but-closed chain refuses here with
    // honest copy — creation enforces the same gate again downstream.
    if (arg === 'all') {
      const closed = [];
      for (const c of AIRDROP_GROUP_CHAINS) if (!(await isAirdropChainEnabled(c))) closed.push(CHAINS[c].label);
      if (closed.length) {
        await sendDm(uid, `⏳ The all-three Army Drop isn\u2019t fully open yet \u2014 ${closed.join(', ')} ${closed.length === 1 ? 'hasn\u2019t' : 'haven\u2019t'} been enabled for airdrops. Pick a single open chain instead.`);
        return { text: 'Not fully open yet', alert: true };
      }
    } else if (!(await isAirdropChainEnabled(arg))) {
      await sendDm(uid, `⏳ Airdrops aren\u2019t open on ${CHAINS[arg].label} yet \u2014 that chain joins in a later rollout step. Pick an open chain instead.`);
      return { text: 'Chain not open yet', alert: true };
    }
    draft.chain = arg; draft.stage = 'text';
    await saveWiz(uid, draft);
    await editPanel(uid, messageId, `Chain set: <b>${arg === 'all' ? 'All three' : CHAINS[arg].label}</b>`, null);
    await sendDm(uid, draft.mode === 'custom'
      ? 'Send the token contract/mint address for this chain. (Custom launches are single-chain; for all-three use Army Drop.)'
      : 'Send the token contract/mint address.');
    return { text: 'Chain set' };
  }
  if (sub === 'create') {
    try {
      const spec = {
        mode: draft.mode, chain: draft.chain, tokenCa: draft.tokenCa,
        tokenName: draft.tokenName ?? '', amountPerWallet: draft.amountPerWallet,
        addressesInput: draft.mode === 'custom' ? (draft.listText ?? '') : undefined,
        includeRegistered: !!draft.includeRegistered,
      };
      const { campaigns } = await createAirdropCampaign(uid, spec);
      draft.campaignIds = campaigns.map((c) => c.id);
      draft.stage = 'quoted';
      await saveWiz(uid, draft);
      const lines = ['✅ <b>Campaign created</b>', ''];
      const isArmyCreate = draft.mode === 'army';
      for (const c of campaigns) {
        lines.push(`#${c.id} · ${c.chain.toUpperCase()} · ${c.walletCount} wallets${isArmyCreate ? '' : ` · fee $${c.serviceFeeUsd}`} · status ${String(c.status).replace(/_/g, ' ')}`);
      }
      lines.push('');
      const needsFee = campaigns.some((c) => Number(c.serviceFeeUsd ?? 0) > 0 && c.status === 'fee_pending');
      if (!needsFee) {
        lines.push('Your tier benefit covered the fee — deposit wallets open on the next check (within a few minutes). Run /mydrops for the deposit address.');
      } else {
        const feeAddr = await airdropFeePayAddress().catch(() => '');
        if (feeAddr) {
          if (isArmyCreate) {
            lines.push('Your campaign is saved and the snapshot is locked. Run /mydrops to track it.');
          } else {
            lines.push(`Next: pay the service fee — $${campaigns[0]?.serviceFeeUsd ?? '0'} USDC on Base (one transfer) from your connected wallet to ${feeAddr}. The watcher confirms it automatically, then deposit wallets open. Your campaign is saved and the snapshot is locked. Run /mydrops to track it.`);
          }
        } else {
          lines.push('Next: the service fee on each campaign above. Fee payments aren\u2019t configured yet — the owner needs to set the fee wallet first. Your campaign is saved and the snapshot is locked. Run /mydrops to track it.');
        }
      }
      lines.push('');
      lines.push('📅 Want a drop time? Pick a slot on the calendar — full slots are shown, so you can pick around them. Booking is scheduling only; sends run once the campaign is funded and its fee is paid.');
      await editPanel(uid, messageId, lines.join('\n'), { inline_keyboard: [
        ...campaigns.map((c) => ([{ text: `📅 Pick a slot for #${c.id}`, callback_data: `adrop:slot:${c.id}` }])),
      ] });
      return { text: 'Campaign created' };
    } catch (err) {
      await sendDm(uid, `⚠️ ${err?.message ?? 'Could not create the campaign.'}`);
      return { text: 'Creation failed', alert: true };
    }
  }
  return { text: 'Unknown step' };
}

// ══ Buy Rewards campaign (PB-BUYREWARDS-SPEC, 2026-10-21) ═════════════════
// Hybrid ladder + daily lucky draw over home-pool $PBAI buys (buy_events),
// paid once a day through ONE ordinary airdrop campaign per batched day
// (recipientMode='buyrewards', per-wallet amounts) created against a
// STANDING deposit wallet. No parallel money path: the payout campaign
// rides the deposit watcher → planner → signer-claim rail unchanged, the
// global arm gates every send, and this campaign's own flag
// (buyrewards_armed, default OFF) gates creation. The master wallet is
// never read or touched by any code path here (spec §2 L3/L7/L8).

export const BR_MIN_BUY_USD = 2;
export const BR_LADDER_POOL_USD = 3;
export const BR_PRIZE_USD = 2;
export const BR_DAILY_CAP_USD = 5;
export const BR_HOLD_TOLERANCE = 0.99;
export const BR_BATCH_GRACE_SEC = 3600;
export const BR_MAX_WALLETS_PER_BATCH = 250;
export const BR_RUN_DAYS_DEFAULT = 7;
export const BR_PBAI_POOL = '0x561330e99a7fd2710d8d32960e22d5f8f6fe2f94';
export const BR_MASTER_WALLET = '0xefa099590c45874e844dec6fc862c7141ecf4139';
const BR_Q6 = (x) => Number(x).toFixed(6);

function brTier(usd) {
  if (usd >= 10) return { rate: 0.35, bps: 3500 };
  if (usd >= 5) return { rate: 0.20, bps: 2000 };
  return { rate: 0.10, bps: 1000 };
}

const brFlagOn = (v) => ['1', 'true', 'on', 'yes'].includes(String(v ?? '').trim().toLowerCase());
export const isBuyRewardsArmed = async () => {
  // Tolerant reader (lib/config.js getConfigFlag — audit F19); brFlagOn
  // above has identical value semantics, so no stored value changes
  // meaning. buy_home_enabled keeps reading through brFlagOn directly.
  try { return await getConfigFlag('buyrewards_armed'); } catch { return false; }
};

async function brOwnerId() {
  const raw = await getConfig('TELEGRAM_OWNER_ID', '').catch(() => '');
  return String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)[0] ?? '';
}

// ── LA day math (spec §4.3) ────────────────────────────────────────────────
// Day keys are America/Los_Angeles calendar dates via Intl (DST-correct;
// never hand-rolled offsets). Midnight derivation is a binary search over
// the formatter — exact to the second at any volume this campaign sees.

const brLaFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const laDayKeyOf = (unixSec) => brLaFmt.format(new Date(unixSec * 1000));

export function laMidnightSec(dayKey) {
  let lo = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 1000) - 36 * 3600;
  let hi = lo + 72 * 3600;
  // Invariant: laDayKeyOf(lo) < dayKey <= laDayKeyOf(hi) (string compare is
  // chronological for YYYY-MM-DD). Find the first second of dayKey.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (laDayKeyOf(mid) < dayKey) lo = mid; else hi = mid;
  }
  return hi;
}

export const brNextDayKey = (dayKey) =>
  new Date(Date.parse(`${dayKey}T00:00:00Z`) + 86400 * 1000).toISOString().slice(0, 10);
export const brAddDaysKey = (dayKey, n) =>
  new Date(Date.parse(`${dayKey}T00:00:00Z`) + n * 86400 * 1000).toISOString().slice(0, 10);
const brDayDiff = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ── Exclusions (spec §4.4) ─────────────────────────────────────────────────
// Pool + master + the campaign deposit wallet by default; Rowdy can extend
// via config buyrewards_exclude (comma-separated) without a code change.

export async function buyRewardsExclusions() {
  const raw = await getConfig('buyrewards_exclude', null).catch(() => null);
  const list = raw
    ? String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [BR_PBAI_POOL, BR_MASTER_WALLET];
  const dep = await getConfig('buyrewards_deposit_address', null).catch(() => null);
  if (dep && !list.includes(String(dep).toLowerCase())) list.push(String(dep).toLowerCase());
  return list;
}

// ── Pure accrual (spec §4.1/§4.2/§5.2) — shared by the batch and the
// status estimator so there is exactly ONE implementation of the money
// math. Input: buy_events rows for one LA day (any subset; home/base/
// campaign-less filtering happens inside). Output ladder records carry
// the exact bonusPbai string that becomes the recipient amount.

export function computeDayAccrual(buyRows, opts = {}) {
  const exclude = new Set((opts.exclude ?? []).map((a) => String(a).toLowerCase()));
  const sorted = [...buyRows].sort((a, b) =>
    (a.createdAt - b.createdAt) ||
    String(a.txHash).localeCompare(String(b.txHash)) ||
    (a.id - b.id));
  const home = sorted.filter((r) => r.ca === PBAI_CA && r.chain === 'base' && r.campaignId == null);
  const boughtByWallet = new Map();
  for (const r of home) {
    if (!r.buyerAddress) continue;
    const w = String(r.buyerAddress).toLowerCase();
    boughtByWallet.set(w, (boughtByWallet.get(w) ?? 0) + Number(r.tokAmount || 0));
  }
  let skippedNoBuyer = 0;
  const entries = [];
  for (const r of home) {
    if (Number(r.usdAmount) < BR_MIN_BUY_USD) continue;
    if (!r.buyerAddress) { skippedNoBuyer++; continue; }
    if (exclude.has(String(r.buyerAddress).toLowerCase())) continue;
    entries.push(r);
  }
  let poolLeft = opts.poolUsd ?? BR_LADDER_POOL_USD;
  const ladder = entries.map((r) => {
    const usd = Number(r.usdAmount);
    const { rate, bps } = brTier(usd);
    const rawUsd = usd * rate;
    let appliedUsd = 0;
    let status = 'accrued';
    if (poolLeft <= 1e-9) {
      status = 'forfeited_cap';
    } else {
      appliedUsd = Math.min(rawUsd, poolLeft);
      poolLeft = Math.max(0, poolLeft - appliedUsd);
    }
    const bonusPbai = appliedUsd > 0 && usd > 0 && Number(r.tokAmount) > 0
      ? BR_Q6(appliedUsd * Number(r.tokAmount) / usd) : '0';
    return {
      buyEventId: r.id, buyTxHash: r.txHash, wallet: String(r.buyerAddress).toLowerCase(),
      buyUsd: usd, tierBps: bps, bonusUsd: Math.round(appliedUsd * 1e6) / 1e6,
      bonusPbai, status, createdAt: r.createdAt,
    };
  });
  return { ladder, entries, boughtByWallet, skippedNoBuyer, qualifyingCount: entries.length };
}

// ── Day / ledger row helpers ───────────────────────────────────────────────

async function brGetDay(dayKey) {
  return db.select().from(buy_rewards_days).where(eq(buy_rewards_days.dayKey, dayKey)).get().catch(() => null);
}

async function brUpsertDay(dayKey, set) {
  const existing = await brGetDay(dayKey);
  if (existing) {
    await db.update(buy_rewards_days).set(set).where(eq(buy_rewards_days.dayKey, dayKey)).run();
  } else {
    await db.insert(buy_rewards_days).values({ dayKey, ...set }).run();
  }
  return brGetDay(dayKey);
}

async function brUpsertLedger(rec) {
  const existing = await db.select().from(buy_rewards_ledger)
    .where(and(eq(buy_rewards_ledger.dayKey, rec.dayKey),
      eq(buy_rewards_ledger.buyEventId, rec.buyEventId),
      eq(buy_rewards_ledger.kind, rec.kind))).get().catch(() => null);
  if (existing) {
    // A row already linked to a payout campaign (or paid) is final — a
    // batch resume never rewrites money that is already queued/sent.
    if (['queued', 'paid'].includes(existing.status)) return existing;
    await db.update(buy_rewards_ledger).set({
      wallet: rec.wallet, buyTxHash: rec.buyTxHash, buyUsd: rec.buyUsd ?? null,
      tierBps: rec.tierBps ?? null, bonusUsd: rec.bonusUsd ?? null,
      bonusPbai: rec.bonusPbai ?? null, status: rec.status,
      forfeitReason: rec.forfeitReason ?? null,
    }).where(eq(buy_rewards_ledger.id, existing.id)).run();
    return { ...existing, ...rec };
  }
  const inserted = await db.insert(buy_rewards_ledger).values(rec).returning();
  return inserted[0];
}

async function brLedgerRows(dayKey) {
  return db.select().from(buy_rewards_ledger)
    .where(eq(buy_rewards_ledger.dayKey, dayKey)).all().catch(() => []);
}

/** Σ bonusPbai still owed from PRIOR days (created, not yet confirmed
 *  paid) — subtracted from the live deposit balance before new accrual so
 *  funds are never promised twice (spec §5.3). */
async function brUnpaidObligations(exceptDayKey) {
  const rows = await db.select().from(buy_rewards_ledger)
    .where(inArray(buy_rewards_ledger.status, ['accrued', 'queued'])).all().catch(() => []);
  return decSum(rows.filter((r) => r.dayKey !== exceptDayKey).map((r) => r.bonusPbai ?? '0'));
}

// ── The payout campaign creator (spec §7.2) ────────────────────────────────
// Internal on purpose: no wizard, no quote, no user surface — but it writes
// the SAME rows the normal path writes, with per-wallet recipient amounts,
// against the standing program wallet (§7.1). Replay-safe via
// ownerIdempotencyKey 'buyrewards:<dayKey>'.

export async function createBuyRewardsPayoutCampaign(dayKey, payouts, deps = {}) {
  const idem = `buyrewards:${dayKey}`;
  const existing = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.ownerIdempotencyKey, idem)).get().catch(() => null);
  if (existing) {
    const recipients = await db.select().from(airdrop_recipients)
      .where(eq(airdrop_recipients.campaignId, existing.id)).all().catch(() => []);
    return { campaign: existing, recipients, replay: true };
  }
  const depositAddress = await getConfig('buyrewards_deposit_address', null).catch(() => null);
  const depositPk = await getConfig('buyrewards_deposit_pk', null).catch(() => null);
  if (!depositAddress || !depositPk) return { error: 'not_setup' };
  const ownerId = await brOwnerId();
  let gasCeilingWei = null;
  try {
    const gp = await (deps.gasPriceWei ?? evmGasPriceWei)('base');
    gasCeilingWei = String(gp * 120_000n);
  } catch { gasCeilingWei = null; }
  const maxAmount = payouts.reduce((m, p) => (decCmp(p.amount, m) > 0 ? p.amount : m), '0');
  const inserted = await db.insert(airdrop_campaigns).values({
    telegramUserId: ownerId,
    tokenName: 'PBAI Buy Rewards',
    tokenCa: PBAI_CA,
    chain: 'base',
    amountPerWallet: maxAmount,
    walletCount: payouts.length,
    status: 'deposit_pending',
    serviceFeeUsd: '0',
    recipientsSnapshot: 1,
    recipientMode: 'buyrewards',
    depositAddress,
    encryptedDepositPk: depositPk,
    feePaymentKind: 'none',
    feePaymentRef: idem,
    gasCeilingWei,
    ownerIdempotencyKey: idem,
    dryRun: true,
  }).returning();
  const campaign = inserted[0];
  const recipients = [];
  const BATCH = 200;
  for (let i = 0; i < payouts.length; i += BATCH) {
    const slice = payouts.slice(i, i + BATCH);
    const rows = await db.insert(airdrop_recipients).values(slice.map((p) => ({
      campaignId: campaign.id,
      telegramUserId: null,
      walletAddress: p.wallet,
      amount: String(p.amount),
      status: 'pending',
      recipientChain: 'base',
      dedupeSuppressed: false,
    }))).returning();
    recipients.push(...rows);
  }
  await auditMoney('airdrop', ownerId, 'campaign_created',
    `mode=buyrewards day=${dayKey} campaign=${campaign.id} recipients=${payouts.length} total=${decSum(payouts.map((p) => p.amount))}`);
  return { campaign, recipients };
}

// ── Draw price (spec §1.4/§8.4): GeckoTerminal is the source of truth for
// $PBAI (DexScreener returns 0 pairs for the CA); the buy watch's GT-fed
// state row is the fallback. No price ⇒ the batch defers — never a guess.

async function brDrawPrice(deps = {}) {
  if (deps.gtPrice) {
    try { const p = Number(await deps.gtPrice()); return Number.isFinite(p) && p > 0 ? p : null; }
    catch { return null; }
  }
  try {
    const t = await fetchTokenByAddress(PBAI_CA, 'base');
    const p = Number(t?.priceUsd);
    if (Number.isFinite(p) && p > 0) return p;
  } catch { /* fall through to the watch state */ }
  const st = await db.select().from(buy_watch_state)
    .where(eq(buy_watch_state.ca, PBAI_CA)).get().catch(() => null);
  const p2 = Number(st?.priceUsd);
  return Number.isFinite(p2) && p2 > 0 ? p2 : null;
}

async function brNoteDefer(dayKey, what) {
  const key = `buyrewards_batch_tries:${dayKey}`;
  const tries = (Number(await getConfig(key, '0').catch(() => '0')) || 0) + 1;
  await setConfig(key, String(tries)).catch(() => {});
  if (tries === 3) {
    await alertOwner('buyrewards', `🎁 Buy Rewards: the ${dayKey} batch has deferred 3 times (${what}). It keeps retrying each tick — check /buyrewards status.`);
  }
  return tries;
}

// ── The daily batch (spec §9.2) ────────────────────────────────────────────

export async function batchBuyRewardsDay(dayKey, deps = {}) {
  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  const balanceOf = deps.tokenBalance ?? tokenBalance;
  const dayRow = await brGetDay(dayKey);
  if (dayRow && ['batched', 'no_buys', 'payout_issue'].includes(dayRow.status)) {
    return { skipped: `already_${dayRow.status}`, day: dayKey };
  }
  if (dayRow?.status === 'batching' && dayRow.batchedAt && nowSec - dayRow.batchedAt < 1800) {
    return { skipped: 'batching', day: dayKey };
  }
  // Resume: a prior attempt created the payout campaign but died before the
  // day was marked. Finalize from the ledger — never re-decide money.
  const prior = await db.select().from(airdrop_campaigns)
    .where(eq(airdrop_campaigns.ownerIdempotencyKey, `buyrewards:${dayKey}`)).get().catch(() => null);
  if (prior) {
    const rows = await brLedgerRows(dayKey);
    const live = rows.filter((r) => ['queued', 'paid'].includes(r.status));
    const prizeRow = rows.find((r) => r.kind === 'prize');
    await brUpsertDay(dayKey, {
      status: 'batched', campaignId: prior.id, batchedAt: nowSec,
      totalPbai: decSum(live.map((r) => r.bonusPbai ?? '0')),
      ladderUsd: Math.round(live.filter((r) => r.kind === 'ladder').reduce((s, r) => s + (r.bonusUsd ?? 0), 0) * 1e6) / 1e6,
      prizeUsd: prizeRow?.bonusUsd ?? 0,
      winnerWallet: prizeRow?.wallet ?? null, winnerBuyTx: prizeRow?.buyTxHash ?? null,
    });
    return { batched: true, resumed: true, day: dayKey, campaignId: prior.id };
  }

  await brUpsertDay(dayKey, { status: 'batching', batchedAt: nowSec });
  const depositAddress = await getConfig('buyrewards_deposit_address', null).catch(() => null);
  const depositPk = await getConfig('buyrewards_deposit_pk', null).catch(() => null);
  if (!depositAddress || !depositPk) {
    await brUpsertDay(dayKey, { status: 'deferred' });
    return { deferred: 'not_setup', day: dayKey };
  }
  const ownerId = await brOwnerId();
  const start = laMidnightSec(dayKey);
  const end = laMidnightSec(brNextDayKey(dayKey));
  const scanned = await db.select().from(buy_events)
    .where(and(eq(buy_events.ca, PBAI_CA), eq(buy_events.chain, 'base'),
      gte(buy_events.createdAt, start - 48 * 3600), lte(buy_events.createdAt, end + 48 * 3600)))
    .all().catch(() => []);
  const dayRows = scanned.filter((r) => r.createdAt >= start && r.createdAt < end);
  const acc = computeDayAccrual(dayRows, { exclude: await buyRewardsExclusions() });
  if (!acc.qualifyingCount) {
    await brUpsertDay(dayKey, {
      status: 'no_buys', qualifyingBuys: 0, entries: 0, eligibleEntries: 0,
      uniqueWallets: 0, batchedAt: nowSec,
    });
    await setConfig(`buyrewards_batch_tries:${dayKey}`, '0').catch(() => {});
    return { noBuys: true, day: dayKey, skippedNoBuyer: acc.skippedNoBuyer };
  }

  // Ledger first (spec §9.4): every decision persists before any campaign.
  const saved = new Map();
  for (const rec of acc.ladder) {
    const row = await brUpsertLedger({
      dayKey, wallet: rec.wallet, buyEventId: rec.buyEventId, buyTxHash: rec.buyTxHash,
      kind: 'ladder', buyUsd: rec.buyUsd, tierBps: rec.tierBps,
      bonusUsd: rec.bonusUsd, bonusPbai: rec.bonusPbai, status: rec.status,
      forfeitReason: rec.status === 'forfeited_cap' ? 'ladder_pool' : null,
    });
    saved.set(rec.buyEventId, row);
  }
  const setRow = async (row, set) => {
    await db.update(buy_rewards_ledger).set(set).where(eq(buy_rewards_ledger.id, row.id)).run();
    Object.assign(row, set);
  };

  // Deposit balance + prior obligations (spec §5.3).
  let depBal;
  try { depBal = String(await balanceOf('base', PBAI_CA, depositAddress)); }
  catch {
    await brUpsertDay(dayKey, { status: 'deferred' });
    const tries = await brNoteDefer(dayKey, 'deposit balance read');
    return { deferred: 'deposit_balance', day: dayKey, tries };
  }
  const obligations = await brUnpaidObligations(dayKey);
  let effective = decSub(depBal, obligations);
  if (decCmp(effective, '0') < 0) effective = '0';
  if (decCmp(effective, '0') <= 0) {
    await brUpsertDay(dayKey, {
      status: 'unfunded', qualifyingBuys: acc.qualifyingCount, entries: acc.qualifyingCount,
      uniqueWallets: new Set(acc.entries.map((r) => String(r.buyerAddress).toLowerCase())).size,
      batchedAt: nowSec,
    });
    await setConfig(`buyrewards_batch_tries:${dayKey}`, '0').catch(() => {});
    await alertOwner('buyrewards', `🎁 Buy Rewards: ${dayKey} is UNFUNDED — the deposit wallet's effective balance is 0 (balance ${depBal}, prior obligations ${obligations}). The day's rewards stay accrued and re-batch after a top-up.`);
    await auditMoney('buyrewards', ownerId, 'day_unfunded', `day=${dayKey} balance=${depBal} obligations=${obligations}`);
    return { unfunded: true, day: dayKey, balance: depBal, obligations };
  }
  // Balance cap: clip ladder in REVERSE trade order (first-come fairness).
  const accruedRows = () => acc.ladder
    .map((rec) => saved.get(rec.buyEventId))
    .filter((r) => r && r.status === 'accrued');
  let totalWanted = decSum(accruedRows().map((r) => r.bonusPbai ?? '0'));
  if (decCmp(totalWanted, effective) > 0) {
    let excess = decSub(totalWanted, effective);
    for (const rec of [...acc.ladder].reverse()) {
      if (decCmp(excess, '0') <= 0) break;
      const row = saved.get(rec.buyEventId);
      if (!row || row.status !== 'accrued') continue;
      const cur = row.bonusPbai ?? '0';
      if (decCmp(cur, '0') <= 0) continue;
      const cut = decCmp(cur, excess) <= 0 ? cur : excess;
      const next = decSub(cur, cut);
      excess = decSub(excess, cut);
      const zeroed = decCmp(next, '0') <= 0;
      await setRow(row, {
        bonusPbai: BR_Q6(next),
        bonusUsd: Math.round((row.bonusUsd ?? 0) * (Number(cur) > 0 ? Number(next) / Number(cur) : 0) * 1e6) / 1e6,
        status: zeroed ? 'forfeited_balance' : 'accrued',
        forfeitReason: zeroed ? 'balance_cap' : 'balance_cap_trim',
      });
    }
    totalWanted = decSum(accruedRows().map((r) => r.bonusPbai ?? '0'));
  }

  // Holding checks (spec §6): one balance read per unique wallet; a failed
  // read defers the wallet (never forfeits, never pays). Wallets past the
  // 250 bound defer too. Any deferred wallet holds the whole day (one
  // campaign per day); past day-close + 24h the deferred are written off
  // as unpaid and the day proceeds without them.
  const walletsInOrder = [...new Set(acc.entries.map((r) => String(r.buyerAddress).toLowerCase()))];
  const processed = walletsInOrder.slice(0, BR_MAX_WALLETS_PER_BATCH);
  const overflow = new Set(walletsInOrder.slice(BR_MAX_WALLETS_PER_BATCH));
  const hold = new Map();
  for (const w of processed) {
    let held;
    try { held = Number(await balanceOf('base', PBAI_CA, w)); }
    catch { hold.set(w, 'deferred'); continue; }
    const bought = acc.boughtByWallet.get(w) ?? 0;
    hold.set(w, held >= bought * BR_HOLD_TOLERANCE ? 'pass' : 'sold');
  }
  for (const w of overflow) hold.set(w, 'deferred');
  let anyDeferred = false;
  for (const rec of acc.ladder) {
    const row = saved.get(rec.buyEventId);
    if (!row) continue;
    const hr = hold.get(rec.wallet);
    if (hr === 'deferred') {
      anyDeferred = true;
      if (row.status === 'accrued') {
        await setRow(row, { status: 'deferred', forfeitReason: overflow.has(rec.wallet) ? 'wallet_overflow' : 'balance_read' });
      }
    } else if (hr === 'sold' && row.status === 'accrued') {
      await setRow(row, { status: 'forfeited_sold', forfeitReason: 'sold_before_batch' });
    }
  }
  if (anyDeferred) {
    if (nowSec > end + 24 * 3600) {
      for (const rec of acc.ladder) {
        const row = saved.get(rec.buyEventId);
        if (row && row.status === 'deferred') {
          await setRow(row, { status: 'unpaid_failed', forfeitReason: 'deferred_expired' });
          hold.set(rec.wallet, 'failed');
        }
      }
      await alertOwner('buyrewards', `🎁 Buy Rewards: ${dayKey} had wallet(s) whose balance stayed unreadable for 24h — written off as unpaid (never silently paid). The rest of the day batches normally.`);
    } else {
      await brUpsertDay(dayKey, {
        status: 'deferred', qualifyingBuys: acc.qualifyingCount, entries: acc.qualifyingCount,
        batchedAt: nowSec,
      });
      const tries = await brNoteDefer(dayKey, 'wallet balance reads');
      return { deferred: 'wallets', day: dayKey, tries };
    }
  }

  // The draw (spec §8): eligibility filtered BEFORE the seeded index, so
  // exactly one draw is ever made and anyone can re-derive it.
  const eligibleEntries = acc.entries.filter((r) => hold.get(String(r.buyerAddress).toLowerCase()) === 'pass');
  let seed = null;
  let drawPrice = null;
  let winner = null;
  let prizePbai = '0';
  let prizeUsdFinal = 0;
  if (eligibleEntries.length) {
    try { seed = await (deps.firstBlock ?? evmFirstBlockAtOrAfter)('base', end); }
    catch {
      await brUpsertDay(dayKey, { status: 'deferred' });
      const tries = await brNoteDefer(dayKey, 'seed block');
      return { deferred: 'seed', day: dayKey, tries };
    }
    if (!seed?.hash) {
      await brUpsertDay(dayKey, { status: 'deferred' });
      const tries = await brNoteDefer(dayKey, 'seed block');
      return { deferred: 'seed', day: dayKey, tries };
    }
    drawPrice = await brDrawPrice(deps);
    if (!drawPrice) {
      await brUpsertDay(dayKey, { status: 'deferred' });
      const tries = await brNoteDefer(dayKey, 'draw price');
      return { deferred: 'price', day: dayKey, tries };
    }
    const idx = Number(BigInt(seed.hash) % BigInt(eligibleEntries.length));
    const winRow = eligibleEntries[idx];
    winner = {
      wallet: String(winRow.buyerAddress).toLowerCase(),
      buyTxHash: winRow.txHash, buyEventId: winRow.id,
    };
    prizePbai = BR_Q6(BR_PRIZE_USD / drawPrice);
    const ladderTotal = decSum(accruedRows().map((r) => r.bonusPbai ?? '0'));
    const room = decSub(effective, ladderTotal);
    if (decCmp(prizePbai, room) > 0) prizePbai = decCmp(room, '0') > 0 ? BR_Q6(room) : '0';
    prizeUsdFinal = Math.round(Number(prizePbai) * drawPrice * 1e6) / 1e6;
    // A re-run after a deferral can legitimately re-draw (eligibility is
    // re-checked): clear any still-unqueued prize row from the earlier
    // attempt so a day never carries two prizes. Queued/paid prize rows
    // imply the campaign exists and are unreachable here (the resume path
    // at the top of the batch returns first).
    for (const stale of await brLedgerRows(dayKey)) {
      if (stale.kind === 'prize' && ['accrued', 'forfeited_balance'].includes(stale.status)
        && stale.buyEventId !== winner.buyEventId) {
        await db.delete(buy_rewards_ledger).where(eq(buy_rewards_ledger.id, stale.id)).run();
      }
    }
    const prizeRow = await brUpsertLedger({
      dayKey, wallet: winner.wallet, buyEventId: winner.buyEventId, buyTxHash: winner.buyTxHash,
      kind: 'prize', buyUsd: null, tierBps: null, bonusUsd: prizeUsdFinal, bonusPbai: prizePbai,
      status: decCmp(prizePbai, '0') > 0 ? 'accrued' : 'forfeited_balance',
      forfeitReason: decCmp(prizePbai, '0') > 0 ? null : 'balance_cap',
    });
    saved.set(`prize:${winner.buyEventId}`, prizeRow);
  }

  // Payouts: per wallet, ladder + prize merged into ONE transfer (L3).
  const finalRows = await brLedgerRows(dayKey);
  const payoutMap = new Map();
  for (const row of finalRows) {
    if (row.status !== 'accrued' || !row.bonusPbai || decCmp(row.bonusPbai, '0') <= 0) continue;
    payoutMap.set(row.wallet, payoutMap.has(row.wallet)
      ? decAdd(payoutMap.get(row.wallet), row.bonusPbai) : row.bonusPbai);
  }
  const payouts = [...payoutMap.entries()].map(([wallet, amount]) => ({ wallet, amount }));
  const ladderUsdPaid = Math.round(finalRows
    .filter((r) => r.kind === 'ladder' && payoutMap.has(r.wallet) && r.status === 'accrued'
      && r.bonusPbai && decCmp(r.bonusPbai, '0') > 0)
    .reduce((s, r) => s + (r.bonusUsd ?? 0), 0) * 1e6) / 1e6;
  let campaign = null;
  if (payouts.length) {
    const created = await createBuyRewardsPayoutCampaign(dayKey, payouts, deps);
    if (created.error) {
      await brUpsertDay(dayKey, { status: 'deferred' });
      return { deferred: created.error, day: dayKey };
    }
    campaign = created.campaign;
    const recByWallet = new Map(created.recipients.map((r) => [r.walletAddress, r.id]));
    for (const row of finalRows) {
      if (row.status === 'accrued' && payoutMap.has(row.wallet)) {
        await db.update(buy_rewards_ledger).set({
          status: 'queued', campaignId: campaign.id,
          recipientId: recByWallet.get(row.wallet) ?? null,
        }).where(eq(buy_rewards_ledger.id, row.id)).run();
      }
    }
  }
  await brUpsertDay(dayKey, {
    status: 'batched',
    qualifyingBuys: acc.qualifyingCount, entries: acc.qualifyingCount,
    eligibleEntries: eligibleEntries.length, uniqueWallets: walletsInOrder.length,
    ladderUsd: ladderUsdPaid, prizeUsd: prizeUsdFinal,
    totalPbai: payouts.length ? decSum(payouts.map((p) => p.amount)) : '0',
    drawPriceUsd: drawPrice, seedBlock: seed?.number ?? null, seedHash: seed?.hash ?? null,
    winnerWallet: winner?.wallet ?? null, winnerBuyTx: winner?.buyTxHash ?? null,
    drawEntries: eligibleEntries.map((r) => r.txHash),
    campaignId: campaign?.id ?? null, batchedAt: nowSec,
  });
  await setConfig(`buyrewards_batch_tries:${dayKey}`, '0').catch(() => {});
  if (campaign) {
    try {
      const eth = String(await (deps.nativeBalance ?? nativeBalance)('base', depositAddress));
      if (decCmp(eth, '0') <= 0) {
        await alertOwner('buyrewards', `🎁 Buy Rewards: ${dayKey} batched (campaign ${campaign.id}) but the deposit wallet holds ZERO ETH — signer claims will gas-hold until the gas float lands.`);
      }
    } catch { /* unknown is not zero — never alert on a failed read */ }
  }
  const forfeits = {};
  for (const r of await brLedgerRows(dayKey)) {
    if (String(r.status).startsWith('forfeited')) forfeits[r.status] = (forfeits[r.status] ?? 0) + 1;
  }
  await auditMoney('buyrewards', ownerId, 'day_batched',
    `day=${dayKey} wallets=${payouts.length} ladderUsd=${ladderUsdPaid} prizeUsd=${prizeUsdFinal} campaign=${campaign?.id ?? 'none'} skippedNoBuyer=${acc.skippedNoBuyer}`);
  return {
    batched: true, day: dayKey, wallets: payouts.length,
    ladderUsd: ladderUsdPaid, prizeUsd: prizeUsdFinal,
    campaignId: campaign?.id ?? null, forfeits, skippedNoBuyer: acc.skippedNoBuyer,
  };
}

// ── Reconciliation (spec §9.3): mirror signer outcomes into the ledger
// and fire the winner announcement once the winner's transfer confirms.

async function postWinnerAnnouncement(day, transfer, deps = {}) {
  const home = String(await getConfig('TELEGRAM_HOME_CHAT_ID', '').catch(() => '') || '').trim();
  if (!home) return false;
  const hash = transfer.signerTxHash ?? transfer.txHash;
  if (!hash) return false;
  const rows = await brLedgerRows(day.dayKey);
  const prizeRow = rows.find((r) => r.kind === 'prize');
  const paidWallets = new Set(rows.filter((r) => r.kind === 'ladder' && r.status === 'paid').map((r) => r.wallet)).size;
  const link = explorerTxUrl('base', hash);
  const shortWallet = day.winnerWallet
    ? `${day.winnerWallet.slice(0, 6)}…${day.winnerWallet.slice(-4)}` : '—';
  let daysLine = '';
  const runStart = await getConfig('buyrewards_run_start_day', null).catch(() => null);
  const runDays = Number(await getConfig('buyrewards_run_days', String(BR_RUN_DAYS_DEFAULT)).catch(() => '')) || BR_RUN_DAYS_DEFAULT;
  if (runStart) {
    const idx = brDayDiff(runStart, day.dayKey) + 1;
    daysLine = idx >= runDays
      ? "That's the final day of this run — thanks for buying! 🎁"
      : `Day ${idx} of ${runDays} — rewards continue tomorrow.`;
  }
  const text = [
    '🎰 <b>Buy Rewards — Lucky Draw winner!</b>',
    '',
    `🏆 <b>${esc(shortWallet)}</b> takes <b>${esc(fmtPbai(prizeRow?.bonusPbai ?? '0'))} $PBAI</b> (~$2.00)!`,
    `🎟️ Entries: ${day.eligibleEntries ?? 0} eligible of ${day.entries ?? 0} buys · Seed: Base block #${day.seedBlock ?? '?'}`,
    `💸 Payout: ${link ? `<a href="${link}">${esc(String(hash).slice(0, 18))}…</a>` : esc(String(hash))}`,
    '',
    `${paidWallets} wallet${paidWallets === 1 ? '' : 's'} also earned ladder bonuses today — check your wallet. ${daysLine}`,
  ].join('\n');
  if (deps.sendHome) return !!(await deps.sendHome(home, text));
  try {
    await api.sendMessage({ chat_id: home, text, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch { return false; }
}

async function reconcileBuyRewards(deps = {}) {
  const batched = await db.select().from(buy_rewards_days)
    .where(eq(buy_rewards_days.status, 'batched')).limit(25).all().catch(() => []);
  const issued = await db.select().from(buy_rewards_days)
    .where(eq(buy_rewards_days.status, 'payout_issue')).limit(25).all().catch(() => []);
  const dayRows = [...batched, ...issued].filter((d) => d.campaignId);
  let paid = 0;
  let announced = 0;
  let issues = 0;
  const terminalBad = (t) => !!t && (
    (t.signerOutcome && (t.signerOutcome.startsWith('refused:') || t.signerOutcome === 'recovery_required')) ||
    t.status === 'failed' || t.status === 'recovery_required');
  for (const day of dayRows) {
    const transfers = await db.select().from(airdrop_transfers)
      .where(eq(airdrop_transfers.campaignId, day.campaignId)).all().catch(() => []);
    const tByRec = new Map(transfers.map((t) => [t.recipientId, t]));
    const rows = await brLedgerRows(day.dayKey);
    let newIssue = false;
    for (const row of rows) {
      if (row.status !== 'queued' || !row.recipientId) continue;
      const t = tByRec.get(row.recipientId);
      if (!t) continue;
      if (t.signerOutcome === 'confirmed') {
        await db.update(buy_rewards_ledger).set({
          status: 'paid', paidTxHash: t.signerTxHash ?? t.txHash ?? null,
        }).where(eq(buy_rewards_ledger.id, row.id)).run();
        row.status = 'paid';
        row.paidTxHash = t.signerTxHash ?? t.txHash ?? null;
        paid++;
      } else if (terminalBad(t)) {
        await db.update(buy_rewards_ledger).set({
          status: 'unpaid_failed', forfeitReason: t.signerOutcome ?? t.status,
        }).where(eq(buy_rewards_ledger.id, row.id)).run();
        row.status = 'unpaid_failed';
        newIssue = true;
      }
    }
    if (day.winnerWallet && !day.announced) {
      const wRow = rows.find((r) => r.wallet === day.winnerWallet && r.recipientId);
      const wt = wRow ? tByRec.get(wRow.recipientId) : null;
      if (wt?.signerOutcome === 'confirmed' && (wt.signerTxHash || wt.txHash)) {
        if (await postWinnerAnnouncement(day, wt, deps)) {
          await brUpsertDay(day.dayKey, { announced: 1 });
          announced++;
        }
      } else if (terminalBad(wt)) {
        newIssue = true;
      }
    }
    if (newIssue) {
      issues++;
      if (day.status !== 'payout_issue') {
        await brUpsertDay(day.dayKey, { status: 'payout_issue' });
        await alertOwner('buyrewards', `🎁 Buy Rewards: a payout for ${day.dayKey} (campaign ${day.campaignId}) ended refused/failed — marked unpaid, never auto-retried. See /buyrewards status.`);
      }
    }
  }
  return { days: dayRows.length, paid, announced, issues };
}

// ── The cycle (spec §9.1): reconcile first (runs even while disarmed —
// it reports on money already sent), then batch the oldest due day.

export async function cycleBuyRewards(deps = {}) {
  const out = { reconciled: null, batch: null };
  try { out.reconciled = await reconcileBuyRewards(deps); }
  catch (err) { out.reconciled = { error: err?.message ?? 'unknown' }; }
  if (!(await isBuyRewardsArmed())) { out.batch = { skipped: 'flag_off' }; return out; }
  if (!(await isAirdropEnabled())) { out.batch = { skipped: 'airdrop_disabled' }; return out; }
  const runStart = await getConfig('buyrewards_run_start_day', null).catch(() => null);
  if (!runStart) { out.batch = { skipped: 'no_run' }; return out; }
  const runDays = Number(await getConfig('buyrewards_run_days', String(BR_RUN_DAYS_DEFAULT)).catch(() => '')) || BR_RUN_DAYS_DEFAULT;
  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  const todayKey = laDayKeyOf(nowSec);
  const lastRunDay = brAddDaysKey(runStart, runDays - 1);
  for (let d = runStart; d <= lastRunDay && d < todayKey; d = brNextDayKey(d)) {
    const row = await brGetDay(d);
    if (row && ['batched', 'no_buys', 'payout_issue'].includes(row.status)) continue;
    if (row?.status === 'batching' && row.batchedAt && nowSec - row.batchedAt < 1800) {
      out.batch = { skipped: 'batching', day: d };
      return out;
    }
    if (nowSec < laMidnightSec(brNextDayKey(d)) + BR_BATCH_GRACE_SEC) {
      out.batch = { waiting: d };
      return out;
    }
    if (row?.status === 'unfunded') {
      // Re-batch an unfunded day only when the wallet actually holds
      // something again — otherwise every tick would re-run the batch and
      // re-alert on a dry wallet. A failed read falls through to the
      // batch, which handles it.
      try {
        const bal = String(await (deps.tokenBalance ?? tokenBalance)('base', PBAI_CA,
          await getConfig('buyrewards_deposit_address', '')));
        if (decCmp(bal, '0') <= 0) { out.batch = { waiting_funds: d }; return out; }
      } catch { /* fall through */ }
    }
    out.batch = await batchBuyRewardsDay(d, deps);
    return out;
  }
  out.batch = { skipped: 'nothing_due' };
  return out;
}

// ── Owner status view (spec §11.2) ─────────────────────────────────────────

const fmtPbai = (s) => {
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(s);
};

export async function buyRewardsStatusText(deps = {}) {
  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  const lines = ['🎁 <b>Buy Rewards — operator status</b>', ''];
  const address = await getConfig('buyrewards_deposit_address', null).catch(() => null);
  const armed = await isBuyRewardsArmed();
  const ae = await isAirdropEnabled();
  const aa = await isAirdropArmed();
  const chainEn = await isAirdropChainEnabled('base');
  const chainArm = await isAirdropChainArmed('base');
  const signal = await signerBroadcastSignal('base');
  lines.push(`Program: ${address ? 'set up' : '<b>NOT set up</b> — /buyrewards setup'}`);
  if (address) lines.push(`Deposit wallet: <code>${esc(address)}</code>`);
  lines.push(`Campaign: ${armed ? 'ARMED' : 'off'} · Airdrop: ${ae ? 'enabled' : 'disabled'} · Global arm: ${aa ? 'ARMED' : 'off'} · Base: ${chainEn ? 'enabled' : 'closed'}/${chainArm ? 'ARMED' : 'unarmed'}`);
  lines.push(armed && signal
    ? 'Sends: <b>LIVE</b> — every gate is open.'
    : 'Sends: PARKED — nothing can broadcast until the campaign AND the airdrop gates are all open.');
  const runStart = await getConfig('buyrewards_run_start_day', null).catch(() => null);
  const runDays = Number(await getConfig('buyrewards_run_days', String(BR_RUN_DAYS_DEFAULT)).catch(() => '')) || BR_RUN_DAYS_DEFAULT;
  const todayKey = laDayKeyOf(nowSec);
  if (runStart) {
    const idx = brDayDiff(runStart, todayKey) + 1;
    lines.push(`Run: started ${runStart} · ${idx >= 1 && idx <= runDays
      ? `day ${idx} of ${runDays} (${runDays - idx} left after today)` : (idx > runDays ? 'complete' : 'not started')}`);
  } else {
    lines.push('Run: none started (arming starts a fresh 7-day run)');
  }
  if (address) {
    const balanceOf = deps.tokenBalance ?? tokenBalance;
    let pbai = null;
    let eth = null;
    try { pbai = String(await balanceOf('base', PBAI_CA, address)); } catch { /* unreadable */ }
    try { eth = String(await (deps.nativeBalance ?? nativeBalance)('base', address)); } catch { /* unreadable */ }
    const obligations = await brUnpaidObligations('__none__');
    lines.push(`Wallet: ${pbai != null ? `${fmtPbai(pbai)} $PBAI` : '$PBAI balance unreadable'} · gas ${eth != null ? `${eth} ETH` : 'unreadable'}${eth != null && decCmp(eth, '0') <= 0 ? ' ⚠️ <b>ZERO — sends will gas-hold</b>' : ''}`);
    if (pbai != null) {
      let eff = decSub(pbai, obligations);
      if (decCmp(eff, '0') < 0) eff = '0';
      lines.push(`Unpaid obligations: ${fmtPbai(obligations)} $PBAI · Effective balance: ${fmtPbai(eff)} $PBAI`);
      const price = await brDrawPrice(deps);
      if (price) {
        const cover = Number(eff) * price / BR_DAILY_CAP_USD;
        lines.push(`Cover: ~${cover.toFixed(1)} days at the $5/day cap (live GT price $${price})${cover < 2 ? ' ⚠️ <b>under 2 days — top up soon</b>' : ''}`);
      }
    }
  }
  // Today so far — live estimate through the SAME pure accrual (§4.5).
  const start = laMidnightSec(todayKey);
  const end = laMidnightSec(brNextDayKey(todayKey));
  const scanned = await db.select().from(buy_events)
    .where(and(eq(buy_events.ca, PBAI_CA), eq(buy_events.chain, 'base'),
      gte(buy_events.createdAt, start), lte(buy_events.createdAt, end)))
    .all().catch(() => []);
  const est = computeDayAccrual(scanned.filter((r) => r.createdAt >= start && r.createdAt < end),
    { exclude: await buyRewardsExclusions() });
  const estUsd = est.ladder.reduce((s, r) => s + r.bonusUsd, 0);
  lines.push(`Today so far (estimate — final at tonight's batch, holding checks pending): ${est.qualifyingCount} qualifying buys · ${est.entries.length} entries · ${new Set(est.entries.map((r) => String(r.buyerAddress).toLowerCase())).size} wallets · ~$${estUsd.toFixed(2)} ladder accrued${estUsd >= BR_LADDER_POOL_USD - 1e-9 ? ' · ⚠️ ladder pool exhausted' : ''}`);
  // To date.
  const paidRows = await db.select().from(buy_rewards_ledger)
    .where(eq(buy_rewards_ledger.status, 'paid')).all().catch(() => []);
  const paidUsd = paidRows.reduce((s, r) => s + (r.bonusUsd ?? 0), 0);
  const countStatus = async (st) => {
    const row = await db.select({ n: sql`COUNT(*)` }).from(buy_rewards_ledger)
      .where(eq(buy_rewards_ledger.status, st)).get().catch(() => null);
    return Number(row?.n ?? 0);
  };
  const days = await db.select().from(buy_rewards_days)
    .orderBy(desc(buy_rewards_days.dayKey)).limit(60).all().catch(() => []);
  const lastBatched = days.find((d) => d.campaignId);
  lines.push(`To date: ${days.filter((d) => d.status === 'batched' || d.status === 'payout_issue').length} days batched · paid $${paidUsd.toFixed(2)} (${fmtPbai(decSum(paidRows.map((r) => r.bonusPbai ?? '0')))} $PBAI) · forfeited cap ${await countStatus('forfeited_cap')} / sold ${await countStatus('forfeited_sold')} · deferred ${await countStatus('deferred')} · unpaid-failed ${await countStatus('unpaid_failed')}`);
  if (lastBatched) {
    lines.push(`Last batched day: ${lastBatched.dayKey}${lastBatched.winnerWallet ? ` · winner ${lastBatched.winnerWallet.slice(0, 6)}…${lastBatched.winnerWallet.slice(-4)}` : ''}`);
  }
  // Health warnings (spec §15-F3: rewards starve silently if the watch is off).
  const warnings = [];
  if (!brFlagOn(await getConfig('buy_home_enabled', '').catch(() => ''))) {
    warnings.push('⚠️ Home buy watch is OFF — no buys are being recorded; rewards starve until it is re-armed.');
  }
  const minUsd = Number(await getConfig('buy_home_min_usd', '').catch(() => '')) || 0;
  if (minUsd > BR_MIN_BUY_USD) {
    warnings.push(`⚠️ buy_home_min_usd is $${minUsd} — buys between $2.00 and $${minUsd} are never recorded and earn nothing.`);
  }
  const pendingDays = days.filter((d) => d.status === 'deferred' || d.status === 'unfunded');
  if (pendingDays.length) {
    warnings.push(`⚠️ Pending days: ${pendingDays.map((d) => `${d.dayKey} (${d.status})`).join(', ')}`);
  }
  if (warnings.length) lines.push('', ...warnings);
  return lines.join('\n');
}

// ── Public copy (spec §12 — HTML, home group) ─────────────────────────────

const BR_ANNOUNCE_TEXT = [
  '🎁 <b>$PBAI Buy Rewards are LIVE — 7 days!</b>',
  '',
  'Every buy of $PBAI on our Base pool earns you bonus $PBAI — paid by our own airdrop engine, straight to the wallet you bought with. No forms, no claiming.',
  '',
  '💸 <b>Buy $2.00–$4.99</b> → +10% bonus',
  '💸 <b>Buy $5.00–$9.99</b> → +20% bonus',
  '🚀 <b>Buy $10.00+</b> → +35% bonus',
  '',
  '🎰 <b>Daily Lucky Draw:</b> every qualifying buy ($2+) is one entry. One winner a day takes <b>$2.00 in $PBAI</b> — drawn from a public block hash, fully verifiable.',
  '',
  'Rules in the next message 👇 — read the holding rule, it matters.',
].join('\n');

const BR_RULES_TEXT = [
  '📜 <b>Buy Rewards — the rules, straight:</b>',
  '',
  '• Buy $PBAI (Base) with any wallet. Buys of <b>$2.00+</b> qualify. Bonuses are % of your buy\u2019s value, paid in $PBAI at your buy\u2019s price.',
  '• <b>Hold what you bought.</b> At payout time (after midnight PT) we check your wallet: if you sold what you bought that day, that day\u2019s bonus AND draw entries are gone. Holders get paid — flippers don\u2019t.',
  '• <b>One payout per wallet per day.</b> The day\u2019s bonuses + any draw prize arrive as a single $PBAI transfer the next day.',
  '• <b>The daily pool is $5.00 total</b> ($3.00 ladder + $2.00 draw prize). Bonuses pay in buy order until the ladder pool runs dry — the last bonus of the day may be trimmed to what\u2019s left, and buys after that earn nothing that day. When it\u2019s gone, it\u2019s gone.',
  '• Draw eligibility = you entered AND you\u2019re still holding at payout time. Winner is picked by Base block hash (first block after midnight PT) — anyone can re-run the math.',
  '• The run lasts <b>7 days</b>. PB\u2019s engine sends every payout on-chain — winners are announced here with the transaction link.',
].join('\n');

// ── Commands (spec §11) ────────────────────────────────────────────────────

async function brSetup(uid) {
  const existing = await getConfig('buyrewards_deposit_address', null).catch(() => null);
  if (existing) {
    let pbai = null;
    let eth = null;
    try { pbai = String(await tokenBalance('base', PBAI_CA, existing)); } catch { /* unreadable */ }
    try { eth = String(await nativeBalance('base', existing)); } catch { /* unreadable */ }
    await sendDm(uid, [
      '🎁 Buy Rewards is already set up — the deposit wallet is never regenerated (a new one would orphan funded tokens).',
      '',
      `Deposit wallet: <code>${esc(existing)}</code>`,
      `Balances: ${pbai != null ? `${fmtPbai(pbai)} $PBAI` : '$PBAI unreadable'} · ${eth != null ? `${eth} ETH` : 'ETH unreadable'}`,
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }
  let kp;
  let enc;
  try {
    kp = generateEvmKeypair();
    enc = await vaultEncrypt(kp.privateKey);
  } catch (err) {
    await sendDm(uid, `⚠️ Setup failed: ${err?.message ?? 'vault unavailable'} — nothing was written.`);
    return;
  }
  await setConfig('buyrewards_deposit_address', kp.address);
  await setConfig('buyrewards_deposit_pk', enc);
  await setConfig('buyrewards_setup_at', String(Math.floor(Date.now() / 1000)));
  await auditMoney('buyrewards', uid, 'setup', `address=${kp.address}`);
  const price = await brDrawPrice({});
  await sendDm(uid, [
    '🎁 <b>Buy Rewards deposit wallet created</b> (dedicated to this campaign — the master wallet is never touched).',
    '',
    `<code>${esc(kp.address)}</code>`,
    '',
    'Fund it with:',
    `• <b>$PBAI</b> — 13,000,000 covers a full 7-day run at the $5/day cap at the draft rate${price ? ` (live GT price now $${price}: the run's worst case is ~${fmtPbai(String(BR_DAILY_CAP_USD * BR_RUN_DAYS_DEFAULT / price))} $PBAI)` : ''}; 6,500,000 is the leaner start (the batch shrinks gracefully, then marks days unfunded). Unspent funds stay in this wallet.`,
    '• <b>0.005 ETH</b> on Base — the gas float. Without it, signer claims gas-hold and nothing sends.',
    '',
    'Then: /buyrewards announce (public start) → /buyrewards arm → confirm. The campaign arm goes LAST, after the airdrop canary + global arm.',
  ].join('\n'), { parse_mode: 'HTML' });
}

async function brArm(uid, sub) {
  const todayKey = laDayKeyOf(Math.floor(Date.now() / 1000));
  const runDays = Number(await getConfig('buyrewards_run_days', String(BR_RUN_DAYS_DEFAULT)).catch(() => '')) || BR_RUN_DAYS_DEFAULT;
  if (sub === 'confirm') {
    const pending = Number(await getConfig(`buyrewards_arm_pending:${uid}`, '0'));
    if (!pending || Date.now() - pending > 60_000) {
      await sendDm(uid, 'No fresh Buy Rewards arm request to confirm. Run /buyrewards arm first.');
      return;
    }
    await setConfig(`buyrewards_arm_pending:${uid}`, '0');
    await setConfig('buyrewards_armed', '1');
    const runStart = await getConfig('buyrewards_run_start_day', null).catch(() => null);
    const diff = runStart ? brDayDiff(runStart, todayKey) : null;
    let runNote;
    if (!runStart || diff < 0 || diff >= runDays) {
      await setConfig('buyrewards_run_start_day', todayKey);
      if (!(await getConfig('buyrewards_run_days', null).catch(() => null))) {
        await setConfig('buyrewards_run_days', String(BR_RUN_DAYS_DEFAULT));
      }
      runNote = `A NEW ${runDays}-day run starts today (${todayKey}) — a fresh funding exposure.`;
    } else {
      runNote = `The active run (${runStart}, day ${diff + 1} of ${runDays}) continues.`;
    }
    await auditMoney('buyrewards', uid, 'arm', `run_start=${await getConfig('buyrewards_run_start_day', '')}`);
    await alertOwner('buyrewards', '🟢 Buy Rewards ARMED by operator command (campaign layer). Sends still need Airdrop enabled + the global arm + the Base chain layers.');
    await sendDm(uid, [
      '🟢 <b>Buy Rewards ARMED.</b>',
      runNote,
      '',
      'Layering: Buy Rewards can only send while Airdrop is enabled AND globally armed (and Base\u2019s chain layers are open). /buyrewards off stops new batches instantly.',
    ].join('\n'), { parse_mode: 'HTML' });
    return;
  }
  if (await isBuyRewardsArmed()) {
    await sendDm(uid, 'Buy Rewards is already ARMED. /buyrewards status for the full picture.');
    return;
  }
  const runStart = await getConfig('buyrewards_run_start_day', null).catch(() => null);
  const diff = runStart ? brDayDiff(runStart, todayKey) : null;
  const freshRun = !runStart || diff < 0 || diff >= runDays;
  await setConfig(`buyrewards_arm_pending:${uid}`, String(Date.now()));
  await sendDm(uid, [
    '⚠️ Arm Buy Rewards?',
    '',
    'Arming starts the daily batch: ladder bonuses + the lucky draw accrue against the campaign deposit wallet, and payouts ride the airdrop rail.',
    freshRun
      ? `Confirming starts a NEW ${runDays}-day run today — a fresh funding exposure against the deposit wallet.`
      : `Confirming re-enables batching inside the active run (${runStart}, day ${diff + 1} of ${runDays}).`,
    'Sends still need the global airdrop arm — arming this campaign alone broadcasts nothing.',
    '',
    'Reply /buyrewards arm confirm within 60 seconds to arm. Anything else cancels.',
  ].join('\n'));
}

async function brOff(uid) {
  if (!(await isBuyRewardsArmed())) {
    await sendDm(uid, 'Buy Rewards is already off.');
    return;
  }
  await setConfig('buyrewards_armed', '0');
  await auditMoney('buyrewards', uid, 'disarm', '');
  await sendDm(uid, '🛑 Buy Rewards DISARMED. New batches stop now. Payout campaigns already created are ordinary airdrop campaigns — they still follow the global arm and are NOT clawed back. Reconciliation of sent payouts continues.');
}

async function brAnnounce(uid) {
  const home = String(await getConfig('TELEGRAM_HOME_CHAT_ID', '').catch(() => '') || '').trim();
  if (!home) {
    await sendDm(uid, '⚠️ TELEGRAM_HOME_CHAT_ID is not configured — nowhere to announce.');
    return;
  }
  try {
    await api.sendMessage({ chat_id: home, text: BR_ANNOUNCE_TEXT, parse_mode: 'HTML' });
    await api.sendMessage({ chat_id: home, text: BR_RULES_TEXT, parse_mode: 'HTML' });
    await auditMoney('buyrewards', uid, 'announce', `chat=${home}`);
    await sendDm(uid, '📣 Announcement + rules posted to the home group.');
  } catch (err) {
    await sendDm(uid, `⚠️ Announcement failed: ${err?.description ?? err?.message ?? 'unknown'}`);
  }
}

const brOwnerGate = async (msg) => {
  if (msg?.chat?.type !== 'private') return false;
  return requireOwner(msg.from?.id);
};

// ── Owner fee confirmation (no checkout wired; XRocket retired) ───────────
// Owner-only: records a verified service-fee payment via confirmAirdropFee.
// Advances fee_pending → deposit_pending (Solana: deposit_generating) ONLY.
// Moves no money, arms nothing, provisions nothing, touches no sends — those
// still need the global + chain arms, the canary, phase 2, and a live signer.
export const AIRDROP_ADMIN_COMMANDS = {
  dropfee: async (chatId, args, msg) => {
    if (msg?.chat?.type !== 'private' || !(await requireOwner(msg.from?.id))) {
      if (msg?.chat?.type === 'private' && msg?.from?.id && !(await requireOwner(msg.from.id))) {
        await sendDm(msg.from.id, '🔒 Owner only.');
      }
      return;
    }
    const uid = msg.from.id;
    const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean);
    const id = Number(parts[0]);
    const ref = parts.slice(1).join(' ').slice(0, 120);
    if (!Number.isInteger(id) || id <= 0) {
      await sendDm(uid, 'Usage: /dropfee <campaign id> [payment reference]\nConfirms a verified service-fee payment for a fee-pending campaign and opens its deposit wallet. This confirms the fee only — sends stay gated.');
      return;
    }
    const row = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, id)).get().catch(() => null);
    if (!row) { await sendDm(uid, `Campaign #${id} not found.`); return; }
    if (row.status === 'deposit_pending' && row.depositAddress) {
      await sendDm(uid, `Campaign #${id} is already fee-confirmed — deposit wallet:\n${row.depositAddress}`);
      return;
    }
    if (row.status === 'deposit_generating') {
      await sendDm(uid, `Campaign #${id} fee is already confirmed — its Solana deposit wallet is still being prepared. Check /mydrops again shortly.`);
      return;
    }
    if (row.status !== 'fee_pending') {
      await sendDm(uid, `Campaign #${id} is ${row.status} — fee cannot be confirmed now.`);
      return;
    }
    const r = await confirmAirdropFee(id, 'manual', ref || 'owner_confirm').catch((e) => ({ error: e?.message ?? 'confirm failed' }));
    await auditMoney('money_admin', uid, 'drop_fee_confirm', `campaign=${id} ok=${!!r?.ok} pending=${!!r?.pending} ref=${ref || 'owner_confirm'}`);
    if (r?.error) { await sendDm(uid, `⚠️ ${r.error}`); return; }
    if (r?.pending) {
      await sendDm(uid, `✅ Fee confirmed for campaign #${id} — its Solana deposit wallet is being prepared. The address appears in /mydrops when ready; no address exists yet, so don't share one.`);
      return;
    }
    await sendDm(uid, `✅ Fee confirmed for campaign #${id} — deposit wallet:\n${r.depositAddress}\nThe customer sends the distribution tokens there; detection is automatic.`);
  },
};

export const BUYREWARDS_COMMANDS = {
  buyrewards: async (chatId, args, msg) => {
    if (!(await brOwnerGate(msg))) {
      // W4 refusal polish (Class B): a non-owner in DM gets the uniform
      // line instead of silence. (Owner-in-group stays silent — DM-only.)
      if (msg?.chat?.type === 'private' && msg?.from?.id && !(await requireOwner(msg.from.id))) {
        await sendDm(msg.from.id, '🔒 Owner only.');
      }
      return;
    }
    const uid = msg.from.id;
    const parts = String(args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const verb = parts[0] ?? 'status';
    if (verb === 'setup') return brSetup(uid);
    if (verb === 'status') {
      await sendDm(uid, await buyRewardsStatusText(), { parse_mode: 'HTML' });
      return;
    }
    if (verb === 'arm') return brArm(uid, parts[1]);
    if (verb === 'off') return brOff(uid);
    if (verb === 'announce') return brAnnounce(uid);
    await sendDm(uid, [
      '🎁 Buy Rewards — operator commands',
      '/buyrewards status — program, wallet, today\u2019s estimate, totals',
      '/buyrewards setup — create the standing deposit wallet (once)',
      '/buyrewards arm → /buyrewards arm confirm — two-step arm (starts/continues the 7-day run)',
      '/buyrewards off — disarm instantly',
      '/buyrewards announce — post the launch announcement + rules to the home group',
    ].join('\n'));
  },
};

// ── Commands ────────────────────────────────────────────────────────────────

const dmOnly = async (chatId, msg) => {
  if (msg?.chat?.type === 'private') return true;
  await api.sendMessage({ chat_id: chatId, text: '🔒 That one needs a private chat — open a DM with me and run it there.' }).catch(() => {});
  return false;
};
// Honest parked copy (audit F7): Airdrops are BUILT and parked pending
// the owner's arm call — never the old "moving to a new home" notice.
// Only the create path lands here; the read-only status commands
// (mydrops / dropdetail) answer from the DB regardless of the flag.
const AIRDROP_PARKED_TEXT =
  '🪂 Airdrops are built and parked — live sends arm when the owner arms them. Your existing campaigns are safe.';
const parked = async (chatId) => { await api.sendMessage({ chat_id: chatId, text: AIRDROP_PARKED_TEXT }).catch(() => {}); };

export async function startAirdropWizard(uid, includeRegistered = false) {
  if (!(await isAirdropEnabled())) return null;
  await saveWiz(uid, { createdAt: Date.now(), stage: 'mode', includeRegistered });
  return productPanel();
}

export const AIRDROP_COMMANDS = {
  airdrop: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const panel = await startAirdropWizard(msg.from.id, /\binclude\b/i.test(String(args ?? '')));
    if (!panel) return parked(chatId);
    await sendDm(msg.from.id, panel.text, { parse_mode: 'HTML', reply_markup: panel.reply_markup });
  },
  mydrops: async (chatId, _args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const rows = await listOwnAirdropCampaigns(msg.from.id, 10);
    if (!rows.length) { await sendDm(msg.from.id, '🪂 No airdrop campaigns yet — /airdrop to launch one.'); return; }
    let footer = 'Details: /dropdetail <id>';
    if (rows.some((r) => r.status === 'fee_pending' && Number(r.serviceFeeUsd ?? 0) > 0)) {
      const feeAddr = await airdropFeePayAddress().catch(() => '');
      if (feeAddr) footer = `Fee due? Pay it in USDC on Base from your connected wallet to ${feeAddr} — confirmed automatically.\n${footer}`;
    }
    const cancellable = rows.filter((r) => AIRDROP_CANCELLABLE_STATUSES.includes(r.status));
    const copyRows = airdropDepositCopyRows(rows);
    const keyboard = [...copyRows, ...cancellable.map((r) => ([{ text: `🚫 Cancel #${r.id}`, callback_data: `adrop:cancelcamp:${r.id}` }]))];
    const extra = keyboard.length
      ? { reply_markup: { inline_keyboard: keyboard } }
      : {};
    await sendDm(msg.from.id, `🪂 Your Airdrop Campaigns\n\n${rows.map(renderAirdropLine).join('\n')}\n\n${footer}`, extra);
  },
  dropdetail: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const id = Number(String(args ?? '').trim());
    const row = await db.select().from(airdrop_campaigns).where(eq(airdrop_campaigns.id, id)).get().catch(() => null);
    if (!row || row.telegramUserId !== String(msg.from.id)) { await sendDm(msg.from.id, 'Campaign not found.'); return; }
    const feeAddr = await airdropFeePayAddress().catch(() => '');
    const copyRows = airdropDepositCopyRows([row]);
    const cancelRows = AIRDROP_CANCELLABLE_STATUSES.includes(row.status)
      ? [[{ text: '🚫 Cancel this campaign', callback_data: `adrop:cancelcamp:${row.id}` }]]
      : [];
    const keyboard = [...copyRows, ...cancelRows];
    const extra = keyboard.length
      ? { reply_markup: { inline_keyboard: keyboard } }
      : {};
    await sendDm(msg.from.id, renderAirdropDetail(row, feeAddr), extra);
  },
  dropcancel: async (chatId, args, msg) => {
    if (!(await dmOnly(chatId, msg))) return;
    const id = Number(String(args ?? '').trim());
    if (!Number.isInteger(id) || id <= 0) { await sendDm(msg.from.id, 'Usage: /dropcancel <campaign id>\nCancels your campaign (or, for the owner, any campaign) — never moves funds.'); return; }
    const res = await cancelAirdropCampaign(msg.from.id, id);
    if (res?.error) { await sendDm(msg.from.id, `⚠️ ${res.error}`); return; }
    await sendDm(msg.from.id, cancelAirdropSuccessText(res, id));
  },
};
