// handlers/poll_answer.js — poll votes (Telegram PollAnswer updates).
// Chart Slayer guess capture: the game posts NON-anonymous 4-option polls
// (lib/chartslayer.js), and a vote arrives here as a poll_answer update
// carrying { poll_id, user, option_ids }. The vote is recorded against the
// round that owns that poll_id — sealed to the round's own chat; the
// voter's identity never leaves it.
// (The platform derives the bot's webhook allowed_updates from handlers/*,
// so this module existing is what subscribes the bot to poll_answer.)

import { recordPollAnswer } from '../lib/chartslayer.js';

export default async function (pollAnswer, ctx) {
  try {
    const res = await recordPollAnswer(pollAnswer);
    if (!res.ok && res.reason !== 'no-live-round') {
      console.log('[poll_answer]', res.reason ?? 'ignored', pollAnswer?.poll_id ?? '');
    }
    return res;
  } catch (err) {
    console.error('[poll_answer]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}
