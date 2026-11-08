// handlers/channel_post.js — channel posts (PB Relay Wave 1, 2026-10-21).
//
// Before PB Relay, channel posts reached no PB code at all: Telegram
// delivers `channel_post` updates only for channels where the bot is an
// ADMINISTRATOR (§3.1 of PB-RELAY-SPEC — no admin, no posts, which is
// why the consent model and the platform agree that relay sources are
// always chats PB was deliberately placed in). The payload is the
// channel's Message; the full Update rides ctx.update.
//
// The handler does exactly one thing: hand the post to the relay
// intake, which is inert unless an active, consent-proven, in-quota
// rule names this channel as its source. It never throws — a relay
// failure must never break update processing.
import { relayChannelPost } from '../lib/relay.js';
import { maybeTick } from '../lib/tick.js';
import { xPostStatsNoteChannelViews } from '../lib/repurpose.js';

export default async function (message, ctx) {
  // X post analytics, per-place reach (2026-11-06): if a channel-post
  // update ever carries a `views` field on a tracked ads-channel leg,
  // record it as "last seen". No views field (the normal case — the Bot
  // API documents none) → the call returns before any config read.
  // Never throws; never affects relay.
  try { await xPostStatsNoteChannelViews(message); } catch (err) {
    console.error('[xpost-views]', err?.message ?? err);
  }
  try {
    await relayChannelPost(message);
  } catch (err) {
    console.error('[relay-channel-post]', err?.message ?? err);
  }
  // Opportunistic clock, same as every other handler.
  maybeTick().catch(() => {});
}
