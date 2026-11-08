// handlers/inline_query.js — runs on `inline_query` updates.
// NOTE: the original bot subscribed to inline_query but never answered it
// (no answerInlineQuery anywhere in the recovered source). This handler is a
// fresh implementation: CA or token query -> live price card; empty query ->
// $PBAI card. Same data paths as /price.

import { api, fetch } from 'sdk';

const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
const GT = 'https://api.geckoterminal.com/api/v2';

async function fetchTokenByAddress(address) {
  const res = await fetch(`${GT}/networks/base/tokens/${address}`);
  if (!res.ok) return null;
  const data = await res.json();
  const a = data?.data?.attributes;
  if (!a) return null;
  return {
    name: a.name, symbol: a.symbol, address,
    priceUsd: Number(a.price_usd),
    change24h: Number(a.price_change_percentage?.h24),
    liquidity: Number(a.total_reserve_in_usd),
    volume24h: Number(a.volume_usd?.h24),
    marketCap: Number(a.market_cap_usd),
  };
}

async function searchToken(query) {
  const res = await fetch(`${GT}/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) return null;
  const data = await res.json();
  const hit = (data?.data ?? []).find((d) => d.type === 'token');
  if (!hit?.attributes?.address) return null;
  return { network: hit.attributes.network ?? 'base', address: hit.attributes.address };
}

function fmtPct(v) {
  if (!isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function fmtUsd(v) {
  if (!isFinite(v) || v === 0) return 'n/a';
  return v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(3)}`;
}

function priceResult(t, idSuffix) {
  const msg = [
    `$${t.symbol} — ${t.name}`,
    `Price: ${fmtUsd(t.priceUsd)}  (24h ${fmtPct(t.change24h)})`,
    `Liq: ${fmtUsd(t.liquidity)}  Vol24h: ${fmtUsd(t.volume24h)}`,
    `CA: ${t.address}`,
  ].join('\n');
  return {
    type: 'article',
    id: `${t.address}-${idSuffix}`,
    title: `$${t.symbol} ${fmtUsd(t.priceUsd)} (${fmtPct(t.change24h)})`,
    description: `${t.name} — tap to share the price card`,
    input_message_content: { message_text: msg },
  };
}

export default async function (inlineQuery, ctx) {
  const q = (inlineQuery.query ?? '').trim();
  let token = null;
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
      token = await fetchTokenByAddress(q);
    } else if (q) {
      const hit = await searchToken(q);
      if (hit) token = await fetchTokenByAddress(hit.address);
    } else {
      token = await fetchTokenByAddress(PBAI_CA);
    }
  } catch (err) {
    console.error('[inline_query]', err?.message ?? err);
  }
  if (!token) {
    await api.answerInlineQuery({ inline_query_id: inlineQuery.id, results: [] }).catch(() => {});
    return;
  }
  await api.answerInlineQuery({
    inline_query_id: inlineQuery.id,
    results: [priceResult(token, '0')],
    cache_time: 60,
  }).catch((err) => console.error('[inline_query answer]', err?.message ?? err));
}
