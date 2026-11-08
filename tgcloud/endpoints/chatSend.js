// Mini App: one brain turn from the Chat tab. Mirrors the bot's
// handleBrainReply — same persona, same memory stream as Telegram DMs.
// Community-chat wave 2026-11-01 (decided shape, owner-only per
// community): the same endpoint ALSO serves the Chat tab's community
// destination, via reusable helpers in lib/groups.js (not hard-wired to
// this screen — a future dashboard surface can import them). The
// community branches run BEFORE the brain path, consume no AI cap,
// touch no brain history, and never execute a slash command: a
// community post goes out as PB to exactly one owner-verified,
// re-verified community, or it does not go out at all. Default
// destination remains the private brain turn below, unchanged.
import { EndpointError } from 'sdk';
import db, { eq } from 'sdk/db';
import { chat_sessions } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { resolveUserKey, sessionUserKey, loadHistory, saveMessage } from '../lib/memory.js';
import { requireOwnedSession } from '../lib/miniapp.js';
import { askBrain } from '../lib/brain.js';
import { recallDecisionContext, recordChatOutcome } from '../lib/decide.js';
import { isOwnerId, listOwnedCommunities, postToOwnedCommunity } from '../lib/groups.js';
import { consumeAiCommand, aiCapReachedText } from '../lib/tiers.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  // Community destination branches (before any brain/cap work).
  if (input?.action === 'listCommunities') {
    try {
      return { communities: await listOwnedCommunities(tg.id) };
    } catch (err) {
      console.error('[chatSend] listCommunities failed:', err?.message ?? err);
      throw new EndpointError('Owned communities are unavailable right now — private chat still works.', { code: 'LIST_FAILED' });
    }
  }
  if (input?.action === 'postCommunity') {
    try {
      return await postToOwnedCommunity(tg.id, input?.chatId, input?.text);
    } catch (err) {
      throw new EndpointError(err?.message ?? 'PB could not post to that community right now.', { code: err?.code ?? 'POST_FAILED' });
    }
  }
  const text = String(input?.text ?? '').trim();
  if (!text) throw new EndpointError('Empty message', { code: 'EMPTY' });
  // Fail-open identity (Fix PB, 2026-10-25): ensureUser's DB read was the
  // only unguarded throw before the brain call, so a transient DB blip
  // surfaced as a bare HTTP 500 ("didn't reach my brain"). A failed
  // identity read now degrades to an anonymous turn (the owner still
  // resolves unlimited via isOwnerId in the cap check) instead of a 500.
  let user = null;
  try { user = await ensureUser(tg); } catch (err) { console.error('[chatSend] ensureUser failed:', err?.message ?? err); }
  // Audit F1: the advertised AI daily cap applies here too — same
  // counter, same limit as the Telegram brain paths (lib/tiers.js).
  // Checked before any session/history work and before the LLM call;
  // a capped turn saves nothing and calls nothing. Counter failure
  // fails open (chat keeps working), never silently.
  const cap = await consumeAiCommand(user?.tier, tg.id).catch((err) => {
    console.error('[aicap]', err?.message ?? err);
    return null;
  });
  if (cap && !cap.allowed) return { reply: aiCapReachedText(cap) };
  // Item 12: an optional sessionId routes this turn to that named
  // session's own memory stream (ownership verified server-side). No
  // sessionId → the default stream, exactly as before.
  let session = null;
  if (input?.sessionId != null) {
    // Same fail-open: a transient session read degrades to the default
    // stream for this turn instead of a 500. Logged, never silent.
    try { session = await requireOwnedSession(tg.id, input.sessionId); } catch (err) { console.error('[chatSend] requireOwnedSession failed:', err?.message ?? err); session = null; }
  }
  const userKey = session
    ? sessionUserKey(tg.id, session.id)
    : await resolveUserKey('telegram', tg.id);
  const history = await loadHistory(userKey, 20);
  const context = [
    `User: ${tg.first_name ?? 'unknown'}${tg.username ? ' (@' + tg.username + ')' : ''} (tg id ${tg.id})`,
    `Tier: ${user?.tier ?? 'free'}`,
    'Chat: PB App (Mini App)',
    'Platform: Telegram',
  ].join('\n');
  // Twin wave 1 (C1 Mini App parity + C7 scope): the Mini App Chat tab
  // is the owner's private surface, so owner turns get the same
  // decision-recall injection as owner DMs — and the same outcome-hook
  // scope below. Non-owner turns get no recall and no outcome row: the
  // owner gate is enforced here AND inside recallDecisionContext, and
  // this endpoint never runs for group surfaces. Recall failures never
  // break the reply.
  let twinOwner = false;
  try { twinOwner = await isOwnerId(tg.id); } catch { twinOwner = false; }
  let brainContext = context;
  try {
    if (twinOwner) {
      const recall = await recallDecisionContext({ question: text, isOwnerDm: true });
      if (recall) brainContext = `${context}\n\n${recall}`;
    }
  } catch { /* recall failures never break the reply */ }
  let reply;
  try {
    reply = await askBrain(text.slice(0, 2000), { history, context: brainContext, maxOutputTokens: 1500 });
  } catch (err) {
    console.error('[chatSend]', err?.message ?? err);
    // Twin wave 1 (C7): brain failure outcome, owner turns only.
    if (twinOwner) await recordChatOutcome({ scope: 'owner', actorId: tg.id, outcome: 'failed' }).catch(() => {});
    return { reply: '🧠 My brain glitched for a sec — run it back and I got you.' };
  }
  if (!reply || !reply.trim()) {
    // Twin wave 1 (C7): empty reply is a failed outcome (no answer made).
    if (twinOwner) await recordChatOutcome({ scope: 'owner', actorId: tg.id, outcome: 'failed' }).catch(() => {});
    return { reply: '🧠 Came up empty on that one — ask me something else.' };
  }
  const out = reply.trim().slice(0, 4000);
  await saveMessage(userKey, 'user', text, 'miniapp');
  await saveMessage(userKey, 'assistant', out, 'miniapp');
  if (session) {
    await db.update(chat_sessions).set({ updatedAt: new Date() })
      .where(eq(chat_sessions.id, session.id)).run().catch(() => {});
  }
  return { reply: out };
};
