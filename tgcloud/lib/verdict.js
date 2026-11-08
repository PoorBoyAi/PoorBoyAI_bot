// lib/verdict.js — shareable scan verdict cards (Edge wave, item 2).
//
// fetchVerdict: GoPlus token_security (Base, 8453). Field reads and score
// weights follow the website Worker's scanTokenSecurity EVM branch
// (phase4/_worker.js — the canonical port of the original
// token-security.ts); buy/sell tax are FRACTIONS in the GoPlus payload
// and are multiplied by 100 (the older in-bot /scan text treats them as
// already-percent — that display is left untouched; the card follows the
// Worker). GoPlus holder `percent` fields are likewise fractions
// (e.g. 0.9665 = 96.65%), corroborated live on $PBAI 2026-10-20.
//
// INTERPRETATION LAYER (2026-10-22 — Scam Radar honesty fix,
// interpretGoPlus below): two artifacts the raw reads manufactured are
// corrected BEFORE scoring. (1) Holder concentration is computed over
// real wallets only: GoPlus lists the token's own DEX pair contracts as
// top "holders" (that balance is the token side sitting inside the
// liquidity position — no wallet can sell it) and dead-address balances
// are supply that can never move; counting either fabricates an
// "extreme concentration" warning. (2) LP lock status is read from
// lp_holders CUSTODY (burned / recognized locker / platform contract /
// creator-held), not from is_locked alone: for position-based (UniV3/V4)
// pools the whole LP is one NFT position, and when a platform contract
// holds it GoPlus still reports is_locked=0 — the old read branded every
// such token "NOT locked - rug risk" (there is not even a top-level
// lp_locked field in the payload). $PBAI was the proof case: one V3
// position NFT, 100% in Ape.Store custody, pool contract = 96.66% of
// "holders" → raw score 55 MEDIUM on an otherwise clean token.
// The website Worker still applies the raw reads — site follow-up owed.
//
// sendVerdictCard NEVER throws and NEVER fabricates: no GoPlus data → no card.

import { fetch, api, InputFile } from 'sdk';
import {
  renderVerdictCard, renderPriceCard, renderTaCard, renderReceiptCard, renderRankCard,
} from './pngcard.js';
import { noteScan } from './digest.js';
import { cleanupNoteSent } from './groups.js';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const DEAD_ADDR = '0x000000000000000000000000000000000000dead';

// Addresses that can never sell, vote, or pull anything. Excluded from the
// holder-concentration math (dead supply can't dump); holding the LP at
// one of these reads as a burn.
const NON_WALLET_ADDRS = new Set([ZERO_ADDR, DEAD_ADDR]);

// Known LP-custody contracts: lp_holders owners that are platform custody
// rather than a locker GoPlus recognizes. Seeded with the ONE entry
// verified live on $PBAI (2026-10-22): Ape.Store's Base custody contract,
// sole holder of the token's UniV3 position NFT — Ape.Store's published
// rule is that LP is burned automatically at graduation. Any OTHER
// custody contract gets only the generic wording in assessLp — never
// invent a platform name.
const KNOWN_LP_CUSTODY = {
  '0xb1900f41d78d330a2a35c6771b3a6088a1b51309':
    "Liquidity held by Ape.Store's platform contract (LP is burned at graduation under Ape.Store's rules)",
};

// ── LP custody assessment ─────────────────────────────────────────────────
// Reads raw.lp_holders (GoPlus's per-holder LP rows) and decides what the
// LP picture actually means. Shares are fractions of the LISTED LP (the
// rows GoPlus returned); "dominant" = at least half of it.
//   burned   — a dead address holds the dominant share: permanent.
//   locked   — recognized lockers (is_locked=1) hold the dominant share.
//   custody  — the dominant holder is a CONTRACT that is neither the
//              token creator nor the owner: platform custody. The creator
//              cannot pull liquidity they do not hold, so this is a
//              neutral-positive finding, NOT a rug-risk warning.
//   unlocked — an EOA (anyone's, incl. the creator's) or the creator /
//              owner in contract form holds it unlocked: the genuine
//              rug-risk case, warned at full strength. Also the fallback
//              when GoPlus returns no LP rows at all (the pre-fix read).
function assessLp(raw) {
  const creator = String(raw?.creator_address ?? '').toLowerCase() || null;
  const owner = String(raw?.owner_address ?? '').toLowerCase() || null;
  const rows = (Array.isArray(raw?.lp_holders) ? raw.lp_holders : []).map((h) => ({
    address: String(h?.address ?? '').toLowerCase(),
    pct: parseFloat(h?.percent ?? '0') || 0,
    isLocked: h?.is_locked === 1 || h?.is_locked === '1',
    isContract: h?.is_contract === 1 || h?.is_contract === '1',
  })).filter((h) => h.address);
  const listed = rows.reduce((s, h) => s + h.pct, 0);
  if (!(listed > 0)) {
    // No LP rows to interpret — legacy fallback (top-level lp_locked is
    // absent on Base, so in practice this preserves the old warning).
    return raw?.lp_locked === '1'
      ? { state: 'locked', positive: 'Liquidity locked', warning: null }
      : { state: 'unlocked', positive: null, warning: 'Liquidity NOT locked - rug risk' };
  }
  const shareOf = (pred) => rows.filter(pred).reduce((s, h) => s + h.pct, 0) / listed;
  if (shareOf((h) => NON_WALLET_ADDRS.has(h.address)) >= 0.5) {
    return { state: 'burned', positive: 'Liquidity burned (permanent)', warning: null };
  }
  if (shareOf((h) => h.isLocked) >= 0.5 || raw?.lp_locked === '1') {
    return { state: 'locked', positive: 'Liquidity locked', warning: null };
  }
  const top = rows.reduce((a, b) => (b.pct > (a?.pct ?? -1) ? b : a), null);
  if (top && top.pct / listed >= 0.5 && top.isContract
      && top.address !== creator && top.address !== owner) {
    return {
      state: 'custody',
      positive: KNOWN_LP_CUSTODY[top.address]
        ?? "Liquidity position held by a platform contract — not in the creator's wallet",
      warning: null,
    };
  }
  return { state: 'unlocked', positive: null, warning: 'Liquidity NOT locked - rug risk' };
}

const VERDICT_TEXT = {
  EXTREME: 'EXTREME DANGER - DO NOT BUY',
  HIGH: 'HIGH RISK - STRONG CAUTION',
  MEDIUM: 'MEDIUM RISK - PROCEED WITH CAUTION',
  LOW: 'LOOKS SAFU - ALWAYS DYOR',
};

export async function fetchVerdict(address) {
  try {
    const addr = String(address ?? '');
    const res = await fetch(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${addr.toLowerCase()}`);
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.result;
    // GoPlus may return the key in different casing — try all variants
    // (mirrors handlers/message.js handleScan + the Worker).
    const raw = (result && (result[addr.toLowerCase()] ?? result[addr] ?? result[addr.toLowerCase()])) || null;
    if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return null;
    return interpretGoPlus(raw, addr);
  } catch {
    return null;
  }
}

// The interpretation layer: one raw GoPlus token_security entry → the
// verdict object every surface renders (verdict card, Mini App Scam
// Radar, security_scan skill, campaign verification). Pure — the proof
// harness feeds it captured-shape payloads directly. Scoring weights and
// flag order follow the website Worker; the LP and concentration inputs
// are the corrected reads documented at the top of this file.
export function interpretGoPlus(raw, address) {
  const addr = String(address ?? '');

    // ── EVM branch — identical field reads to the Worker ──────────────────
    const isHoneypot = raw.is_honeypot === '1';
    const isOpenSource = raw.is_open_source === '1';
    const isProxy = raw.is_proxy === '1';
    const ownerRenounced = !raw.owner_address || raw.owner_address === ZERO_ADDR;
    const buyTax = parseFloat(raw.buy_tax ?? '0') * 100;
    const sellTax = parseFloat(raw.sell_tax ?? '0') * 100;
    const holderCount = parseInt(raw.holder_count ?? '0', 10);
    const lp = assessLp(raw);
    // Concentration over REAL wallets only: drop the token's own DEX pair
    // contracts (their balance is the token side of the LP position) and
    // dead addresses (supply that can never move) before taking the top
    // 10 — see the header note.
    const pairAddrs = new Set((Array.isArray(raw.dex) ? raw.dex : [])
      .map((d) => String(d?.pair ?? '').toLowerCase()).filter(Boolean));
    const realHolders = (raw.holders ?? []).filter((h) => {
      const a = String(h?.address ?? '').toLowerCase();
      return a && !pairAddrs.has(a) && !NON_WALLET_ADDRS.has(a);
    });
    const top10HolderPercent = realHolders.slice(0, 10)
      .reduce((s, h) => s + parseFloat(h.percent ?? '0'), 0) * 100;

    // ── Scoring + flags — same order/amounts as the Worker; flags are the
    // plain-text versions of the Worker's (emoji stripped). LP contributes
    // its corrected verdict: a warning deducts 25 exactly as before; a
    // locked / burned / platform-custody read deducts nothing and is
    // reported as a positive finding instead. ────────────────────────────
    const flags = [];
    const positives = lp.positive ? [lp.positive] : [];
    let score = 100;
    if (isHoneypot) { flags.push('HONEYPOT - cannot sell'); score -= 80; }
    if (!isOpenSource) { flags.push('Source code NOT verified'); score -= 15; }
    if (!ownerRenounced) { flags.push('Ownership NOT renounced - team can rug'); score -= 20; }
    if (lp.warning) { flags.push(lp.warning); score -= 25; }
    if (isProxy) { flags.push('Proxy contract - code can change'); score -= 5; }
    if (sellTax > 10) { flags.push(`High sell tax: ${sellTax.toFixed(1)}%`); score -= 20; }
    else if (sellTax > 5) { flags.push(`Elevated sell tax: ${sellTax.toFixed(1)}%`); score -= 10; }
    if (buyTax > 10) { flags.push(`High buy tax: ${buyTax.toFixed(1)}%`); score -= 10; }
    if (top10HolderPercent > 80) { flags.push(`Top 10 wallets hold ${top10HolderPercent.toFixed(1)}% - extreme concentration`); score -= 20; }
    else if (top10HolderPercent > 50) { flags.push(`Top 10 wallets hold ${top10HolderPercent.toFixed(1)}%`); score -= 10; }
    if (holderCount < 100) { flags.push(`Low holder count: ${holderCount}`); score -= 5; }

    score = Math.max(0, Math.min(100, score));

    let riskLevel = 'LOW';
    if (score < 20 || isHoneypot) riskLevel = 'EXTREME';
    else if (score < 40) riskLevel = 'HIGH';
    else if (score < 65) riskLevel = 'MEDIUM';

    return {
      name: raw.token_name ?? 'Unknown',
      symbol: raw.token_symbol ?? '???',
      address: addr,
      chain: 'Base',
      score,
      riskLevel,
      verdictText: VERDICT_TEXT[riskLevel],
      flags,
      positives,
      lpState: lp.state,
      buyTax,
      sellTax,
      holderCount,
      scannedAt: new Date(),
    };
}

export async function sendVerdictCard(chatId, address) {
  try {
    const verdict = await fetchVerdict(address);
    if (!verdict) return { sent: false, reason: 'no-data' };
    const bytes = renderVerdictCard(verdict);
    const caption =
      `🪪 $${verdict.symbol} scan verdict — ${verdict.verdictText} (score ${verdict.score}/100)\n` +
      `${address}\nNot financial advice. DYOR.`;
    const sent = await api.sendPhoto({
      chat_id: chatId,
      photo: new InputFile(bytes, 'pb-verdict.png', { type: 'image/png' }),
      caption,
    });
    // PB Cleanup capture seam (2026-10-22): a verdict card sent as the
    // reply to a member's /scan records like any other reply.
    await cleanupNoteSent(chatId, sent);
    // Lead Finder (Stage 1): a token someone bothered to scan is a warm
    // PB-surface signal. Best-effort note; never breaks the card flow.
    await noteScan(address).catch(() => {});
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: String(err?.description ?? err?.message ?? err) };
  }
}

// ── Gap-1 card senders (price / TA / receipt / rank) ────────────────────────
// The sendVerdictCard contract, generalized: NEVER throw, NEVER fabricate.
// The data object arrives PRE-FETCHED from the caller's own pipeline — a
// card reuses that fetch, it never refetches — and an empty source sends
// nothing. Callers fire these only AFTER the text answer has landed.

async function sendCardPhoto(chatId, bytes, filename, caption) {
  const sent = await api.sendPhoto({
    chat_id: chatId,
    photo: new InputFile(bytes, filename, { type: 'image/png' }),
    caption,
  });
  // PB Cleanup capture seam (2026-10-22).
  await cleanupNoteSent(chatId, sent);
  return { sent: true };
}

function cardErr(err) {
  return { sent: false, reason: String(err?.description ?? err?.message ?? err) };
}

export async function sendPriceCard(chatId, t) {
  try {
    if (!t || !Number.isFinite(Number(t.priceUsd))) return { sent: false, reason: 'no-data' };
    const caption =
      `📈 $${t.symbol ?? 'TOKEN'} price card — live GeckoTerminal data.\n` +
      `${t.address ?? ''}\nNot financial advice. DYOR.`;
    return await sendCardPhoto(chatId, renderPriceCard(t), 'pb-price.png', caption);
  } catch (err) { return cardErr(err); }
}

export async function sendTaCard(chatId, d) {
  try {
    if (!d || (d.rsi == null && !d.macd && !d.bollinger)) return { sent: false, reason: 'no-data' };
    const caption =
      `📊 $${d.symbol ?? 'TOKEN'} TA card — RSI / MACD / Bollinger, hourly candles.\n` +
      'Not financial advice. DYOR.';
    return await sendCardPhoto(chatId, renderTaCard(d), 'pb-ta.png', caption);
  } catch (err) { return cardErr(err); }
}

export async function sendReceiptCard(chatId, r) {
  try {
    if (!r || !Array.isArray(r.steps) || !r.steps.length) return { sent: false, reason: 'no-data' };
    const caption =
      `🧾 Agent loop receipt — ${r.done ?? 0}/${r.total ?? r.steps.length} steps done. ` +
      'The text receipt above is the full record.';
    return await sendCardPhoto(chatId, renderReceiptCard(r), 'pb-receipt.png', caption);
  } catch (err) { return cardErr(err); }
}

export async function sendRankCard(chatId, r) {
  try {
    if (!r || !(Number(r.xp) > 0) || !r.rankName) return { sent: false, reason: 'no-data' };
    const caption =
      `🎖️ ${r.displayName ?? 'Raider'} — ${r.rankName}, ${Number(r.xp).toLocaleString('en-US')} XP. Keep raiding.`;
    return await sendCardPhoto(chatId, renderRankCard(r), 'pb-rank.png', caption);
  } catch (err) { return cardErr(err); }
}
