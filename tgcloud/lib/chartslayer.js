// lib/chartslayer.js — the Chart Slayer game engine.
// Restored per PB-FORGOTTEN-FEATURES-DESIGNS.md §1 (original:
// telegram-community-bot.ts tables ~886 + the brain prompt's shipped-game
// description; the rigid auto-loop itself had already been retired in the
// source — "Chart Slayer auto-game removed" ~3761 — so the loop semantics
// here follow the design §1 spec, not resurrected code).
//
// Shape (design §1):
// - Per-group opt-in via group_settings.settings.chartSlayer (admin command
//   /slayer on|off in handlers/message.js). Default OFF everywhere.
// - A chartSlayer cycle appended LAST to lib/tick.js CYCLES drives rounds on
//   a ~10-minute cadence (the original's cadence from the 924-row history).
// - SEALED per chat: a round, its guesses and its XP exist inside exactly
//   one chatId. No cross-group board, no other group's data is ever read.
// - Answer pool = global majors only (fixed list below). NEVER a community's
//   call/featured token — the pool is hardcoded majors, so no group's call
//   can leak into another group's game by construction.
// - Charts are REAL GeckoTerminal OHLCV (the source /price already trusts),
//   rendered as a label-stripped text-emoji sparkline (v0 per design §1 —
//   no token name, no numbers, nothing that gives the answer away).
// - Guesses ride a NON-anonymous 4-option poll; handlers/poll_answer.js
//   routes poll_answer updates here (recordPollAnswer). is_correct is
//   computed at reveal, like the award order (by guessed_at).
// - XP via lib/xp.js addXpRaw (flat awards, shared raid_xp balance, NO
//   streak/holder multiplier — game XP is not raid XP): the original awards
//   from the brain prompt quoted in design §1: 🥇 first correct = 150,
//   🥈🥉 2nd & 3rd correct = 100 each, any other guess = 10.
//
// Pool pools: each entry pins a deep-liquidity GeckoTerminal pool, verified
// live 2026-10-19 (tokens endpoint top pool + 24 hourly OHLCV candles each).

import { api, fetch } from 'sdk';
import db, { eq, and, desc, asc } from 'sdk/db';
import { chart_slayer_rounds, chart_slayer_guesses, group_settings } from '../schema.js';
import { fetchOHLCV } from './ta.js';
import { addXpRaw } from './xp.js';
import { getGroupSettings, setGroupSettings } from './groups.js';

export const XP_FIRST = 150;
export const XP_SECOND_THIRD = 100;
export const XP_GUESS = 10;
export const ROUND_MS = 10 * 60_000;      // round lifetime (original cadence)
export const CADENCE_MS = 10 * 60_000;    // gap after a round ends before the next
const POLL_OPEN_SECONDS = 600;            // sendPoll open_period max == round length

// ── Answer pool — global majors ONLY (see header: sealing by construction) ──
export const ANSWER_POOL = [
  { symbol: 'BTC',  name: 'Bitcoin',   network: 'eth',    pool: '0x4585fe77225b41b697c938b018e2ac67ac5a20c0' },
  { symbol: 'ETH',  name: 'Ethereum',  network: 'base',   pool: '0x6c561b446416e1a00e8e93e221854d6ea4171372' },
  { symbol: 'SOL',  name: 'Solana',    network: 'solana', pool: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE' },
  { symbol: 'DOGE', name: 'Dogecoin',  network: 'bsc',    pool: '0xac109c8025f272414fd9e2faa805a583708a017f' },
  { symbol: 'LINK', name: 'Chainlink', network: 'eth',    pool: '0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8' },
  { symbol: 'UNI',  name: 'Uniswap',   network: 'eth',    pool: '0x1d42064fc4beb5f8aaf85f4617ae8b3b5b8bd801' },
  { symbol: 'AAVE', name: 'Aave',      network: 'eth',    pool: '0x5ab53ee1d50eef2c1dd3d5402789cd27bb52c1bb' },
  { symbol: 'BNB',  name: 'BNB',       network: 'bsc',    pool: '0x172fcd41e0913e95784454622d1c3724f546f849' },
  { symbol: 'AVAX', name: 'Avalanche', network: 'avax',   pool: '0xf01449c0ba930b6e2caca3def3ccbd7a3e589534' },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function tsOf(v) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── v0 chart: label-stripped block sparkline (pure; unit-testable) ──────────
// Bucket-averages closes down to `width` points, then maps each to one of 8
// block heights. No numbers, no name, no axis — the shape is the whole clue.
export function sparkline(closes, width = 30) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const vals = (closes ?? []).filter((v) => Number.isFinite(v));
  if (!vals.length) return '';
  const n = Math.max(1, Math.min(width, vals.length));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.floor((i * vals.length) / n);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * vals.length) / n));
    const slice = vals.slice(lo, hi);
    pts.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  return pts.map((v) => blocks[Math.min(7, Math.floor(((v - min) / span) * 8))]).join('');
}

// ── Opt-in (group_settings.settings.chartSlayer, default OFF) ──────────────
export async function isChartSlayerOn(chatId) {
  const s = await getGroupSettings(chatId).catch(() => ({}));
  return s?.chartSlayer === true;
}

export async function setChartSlayer(chatId, on) {
  await setGroupSettings(chatId, { chartSlayer: !!on });
}

// ── OHLCV for an answer token (GeckoTerminal pool candles, via lib/ta.js) ──
async function answerCandles(entry) {
  const candles = await fetchOHLCV(entry.pool, fetch, entry.network, 'hour', 24);
  if (!candles || candles.length < 12) throw new Error(`thin candles for ${entry.symbol}`);
  return candles;
}

// ── Start a round in one chat ───────────────────────────────────────────────
export async function startRound(chatId) {
  const cid = String(chatId);
  const last = await db.select().from(chart_slayer_rounds)
    .where(eq(chart_slayer_rounds.chatId, cid))
    .orderBy(desc(chart_slayer_rounds.id)).limit(1).get().catch(() => null);
  const pool = ANSWER_POOL.filter((p) => !last || p.symbol !== String(last.answerToken ?? '').toUpperCase());
  const answer = pool[Math.floor(Math.random() * pool.length)];
  const distractors = shuffle(ANSWER_POOL.filter((p) => p.symbol !== answer.symbol)).slice(0, 3);
  const options = shuffle([answer, ...distractors]);

  const candles = await answerCandles(answer);
  const closes = candles.map((c) => c.close);
  const chart = sparkline(closes, 30);

  const now = Date.now();
  const text = [
    '🎮 CHART SLAYER',
    '',
    'Guess the token from its mystery 24h chart! 👇',
    '',
    chart,
    '',
    `⏳ Poll closes in ~10 min · 🥇 ${XP_FIRST} XP · 🥈🥉 ${XP_SECOND_THIRD} XP · 🎮 ${XP_GUESS} XP just for guessing`,
  ].join('\n');
  await api.sendMessage({ chat_id: Number(cid), text, disable_web_page_preview: true });
  const pollMsg = await api.sendPoll({
    chat_id: Number(cid),
    question: 'Which token is this? 🎯',
    options: options.map((p) => `${p.symbol} — ${p.name}`),
    is_anonymous: false,
    allows_multiple_answers: false,
    open_period: POLL_OPEN_SECONDS,
  });
  const rows = await db.insert(chart_slayer_rounds).values({
    chatId: cid,
    threadId: null,
    answerToken: answer.symbol,
    answerName: answer.name,
    pollId: pollMsg?.poll?.id != null ? String(pollMsg.poll.id) : null,
    options: JSON.stringify(options.map((p) => p.symbol)),
    startedAt: new Date(now),
    endsAt: new Date(now + ROUND_MS),
    status: 'active',
    messageId: pollMsg?.message_id != null ? String(pollMsg.message_id) : null,
  }).returning().run().catch(() => []);
  return { roundId: rows?.[0]?.id ?? null, answer: answer.symbol, pollId: pollMsg?.poll?.id ?? null };
}

// ── Reveal a round: close poll, mark guesses, award XP, announce ───────────
function who(g) {
  return g.username ? `@${g.username}` : (g.displayName ?? 'A player');
}

export async function revealRound(round) {
  const cid = String(round.chatId);
  if (round.pollId && round.messageId) {
    await api.stopPoll({ chat_id: Number(cid), message_id: Number(round.messageId) }).catch(() => {});
  }
  const guesses = await db.select().from(chart_slayer_guesses)
    .where(eq(chart_slayer_guesses.roundId, round.id))
    .orderBy(asc(chart_slayer_guesses.guessedAt), asc(chart_slayer_guesses.id))
    .all().catch(() => []);
  const answer = String(round.answerToken ?? '').toUpperCase();
  for (const g of guesses) {
    const correct = String(g.guess ?? '').toUpperCase() === answer;
    g.isCorrect = correct;
    await db.update(chart_slayer_guesses).set({ isCorrect: correct })
      .where(eq(chart_slayer_guesses.id, g.id)).run().catch(() => {});
  }
  const correctOnes = guesses.filter((g) => g.isCorrect);
  const awards = new Map();
  if (correctOnes[0]) awards.set(correctOnes[0].userId, XP_FIRST);
  if (correctOnes[1]) awards.set(correctOnes[1].userId, XP_SECOND_THIRD);
  if (correctOnes[2]) awards.set(correctOnes[2].userId, XP_SECOND_THIRD);
  for (const g of guesses) if (!awards.has(g.userId)) awards.set(g.userId, XP_GUESS);
  for (const g of guesses) {
    await addXpRaw(Number(g.userId), Number(cid), g.username ?? null, g.displayName ?? null, awards.get(g.userId))
      .catch((err) => console.error('[chartSlayer xp]', err?.message ?? err));
  }
  await db.update(chart_slayer_rounds)
    .set({ status: 'revealed', revealedAt: new Date() })
    .where(eq(chart_slayer_rounds.id, round.id)).run().catch(() => {});

  const lines = [
    '🎯 CHART SLAYER — revealed!',
    '',
    `The mystery chart was ${round.answerToken} — ${round.answerName}! 📊`,
  ];
  if (correctOnes.length) {
    lines.push('');
    const medals = ['🥇', '🥈', '🥉'];
    correctOnes.slice(0, 3).forEach((g, i) => {
      lines.push(`${medals[i]} ${who(g)} — ${i === 0 ? 'first correct!' : 'correct!'} +${awards.get(g.userId)} XP`);
    });
    const others = guesses.length - Math.min(3, correctOnes.length);
    if (others > 0) lines.push(`🎮 ${others} more player${others === 1 ? '' : 's'} guessed — +${XP_GUESS} XP each`);
  } else if (guesses.length) {
    lines.push('', `😅 Nobody got it — ${guesses.length} guess${guesses.length === 1 ? '' : 'es'} still earned +${XP_GUESS} XP each.`);
  } else {
    lines.push('', '😴 No guesses this round. The next chart drops soon!');
  }
  lines.push('', 'Next round starts in ~10 min. Think you can read charts? Prove it 😤');
  await api.sendMessage({ chat_id: Number(cid), text: lines.join('\n'), disable_web_page_preview: true })
    .catch((err) => { if (err?.code !== 403) console.error('[chartSlayer reveal]', err?.code, err?.description ?? err?.message); });
  return { guesses: guesses.length, correct: correctOnes.length };
}

// ── Guess capture (handlers/poll_answer.js routes here) ────────────────────
// PollAnswer payload: { poll_id, voter_chat?, user, option_ids }. Our polls
// are non-anonymous, so `user` is present. A re-vote fires again with the new
// option (the UNIQUE(round_id, user_id) row is updated — one guess per
// player, latest vote counts); an empty option_ids is a retraction (row
// deleted). Sealed: the round is found by poll_id alone, and the guess is
// written against the round's own chatId — never the voter's chat.
export async function recordPollAnswer(pa) {
  const pollId = pa?.poll_id != null ? String(pa.poll_id) : null;
  const user = pa?.user;
  const opts = pa?.option_ids ?? [];
  if (!pollId || !user?.id) return { ok: false, reason: 'bad-payload' };
  const round = await db.select().from(chart_slayer_rounds)
    .where(eq(chart_slayer_rounds.pollId, pollId)).get().catch(() => null);
  if (!round || round.status !== 'active') return { ok: false, reason: 'no-live-round' };
  if (!opts.length) {
    await db.delete(chart_slayer_guesses)
      .where(and(eq(chart_slayer_guesses.roundId, round.id), eq(chart_slayer_guesses.userId, Number(user.id))))
      .run().catch(() => {});
    return { ok: true, retracted: true, roundId: round.id };
  }
  let options = [];
  try { options = JSON.parse(round.options ?? '[]'); } catch { options = []; }
  const symbol = options[opts[0]];
  if (!symbol) return { ok: false, reason: 'bad-option' };
  await db.insert(chart_slayer_guesses).values({
    roundId: round.id,
    userId: Number(user.id),
    username: user.username ?? null,
    displayName: user.first_name ?? null,
    chatId: String(round.chatId),
    guess: symbol,
    isCorrect: false,
    guessedAt: new Date(),
  }).onConflictDoUpdate({
    target: [chart_slayer_guesses.roundId, chart_slayer_guesses.userId],
    set: {
      guess: symbol,
      username: user.username ?? null,
      displayName: user.first_name ?? null,
      guessedAt: new Date(),
    },
  }).run().catch((err) => console.error('[chartSlayer guess]', err?.message ?? err));
  return { ok: true, roundId: round.id, guess: symbol };
}

// ── Tick cycle (appended LAST in lib/tick.js CYCLES) ────────────────────────
// For each opted-in chat: reveal a live round past its deadline, else start
// a new round when the cadence is due. Per-chat failure-isolated.
export async function cycleChartSlayer() {
  const rows = await db.select().from(group_settings).all().catch(() => []);
  const opted = rows
    .filter((r) => r?.settings?.chartSlayer === true)
    .map((r) => String(r.chatId));
  let started = 0, revealed = 0, waiting = 0;
  for (const chatId of opted) {
    try {
      const live = await db.select().from(chart_slayer_rounds)
        .where(and(eq(chart_slayer_rounds.chatId, chatId), eq(chart_slayer_rounds.status, 'active')))
        .orderBy(desc(chart_slayer_rounds.id)).limit(1).get().catch(() => null);
      if (live) {
        if (tsOf(live.endsAt) <= Date.now()) {
          await revealRound(live);
          revealed++;
        } else waiting++;
        continue;
      }
      const last = await db.select().from(chart_slayer_rounds)
        .where(eq(chart_slayer_rounds.chatId, chatId))
        .orderBy(desc(chart_slayer_rounds.id)).limit(1).get().catch(() => null);
      if (!last || Date.now() - tsOf(last.endsAt) >= CADENCE_MS) {
        await startRound(chatId);
        started++;
      } else waiting++;
    } catch (err) {
      console.error('[chartSlayer cycle]', chatId, err?.message ?? err);
    }
  }
  return { chats: opted.length, started, revealed, waiting };
}
