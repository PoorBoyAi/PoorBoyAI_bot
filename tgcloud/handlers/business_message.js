// handlers/business_message.js — a customer DM arrives in a connected
// Telegram Business chat (Message payload carrying business_connection_id).
// Port of the business_message branch of the original webhook route
// (routes/webhook.ts): resolve the connection's owner, re-check the tier
// gate live, load the OWNER's settings, and reply per mode —
//   ai                → LLM reply (owner's custom system prompt or the
//                       default PB business persona; <200 words, plain text)
//   fixed             → the configured fixed message, verbatim
//   greeting_then_ai  → the configured greeting first, then the AI reply
// The configured fallback message covers LLM failure. NEVER reply when
// ai_enabled is off, the owner is below the gate tier, the mode's
// message body was never configured (fixed mode with no fixed message is
// an honest no-op, never an invented one), or the sender IS the owner
// (the owner's own outgoing messages arrive at this handler too —
// from.is_bot is false for a human owner, so the owner-sender guard
// below is what stops PB answering its own owner).
// Privacy: the message text is used only to produce the reply. Nothing is
// archived, and no business conversation data surfaces anywhere else.

import {
  getTierForTelegramUser, canUseBusinessBot, loadBizSettings,
  getBusinessConnection, setBusinessConnectionTierAllowed,
  getBusinessAIReply, sendBusinessReply, sendOwnerDM, sendTierBlockNag,
  bizCleanupObserve,
} from '../lib/business.js';
import { decide, recordDecisionOutcome, recordSystemDecision, setPosture, twinConversation } from '../lib/decide.js';

export default async function (bm, ctx) {
  try {
    const connectionId = bm?.business_connection_id;
    const chatId = bm?.chat?.id;
    const text = bm?.text ?? '';

    if (!connectionId || !chatId || !String(text).trim()) {
      return { ok: false, reason: 'no-connection-chat-or-text' };
    }

    // Don't reply to bots. NOTE: this does NOT skip the owner's own
    // outgoing messages — the owner is human, so from.is_bot is false
    // for them; the owner-sender guard below handles that case.
    if (bm.from?.is_bot) return { ok: false, reason: 'bot-sender' };

    const conn = await getBusinessConnection(connectionId);
    if (!conn || !conn.isActive) {
      // Never grant Business Bot capability before the signed connection is
      // persisted and associated with an entitled owner.
      console.warn(`[Business] Unknown or inactive connection_id=${connectionId} — reply blocked`);
      return { ok: false, reason: 'unknown-or-inactive-connection' };
    }

    const ownerTgId = conn.ownerTelegramId;

    // Never reply to the owner's own outgoing messages: in a business
    // connection the owner's messages arrive at this handler too, and
    // from.is_bot cannot catch them (human owner). Without this guard PB
    // treats the owner's message as a customer's and answers it back into
    // the same DM, appearing to speak as the owner. Mirrors the sender
    // guard in bizCleanupObserve (lib/business.js).
    if (String(bm.from?.id) === String(ownerTgId)) return { ok: false, reason: 'owner-sender' };

    // PB Cleanup phase 2 (2026-10-22): record this arrival for the
    // connection owner's business-chat cleanup — metadata only, junk
    // evaluated at arrival, self-gating on the connection's cleanup
    // toggle (owner's own outgoing + bot senders excluded inside).
    // Placed before the tier/AI gates on purpose: the recording serves
    // the owner's tidy rules, not the reply flow, and it must never be
    // able to break that flow.
    await bizCleanupObserve(bm, conn).catch(() => {});

    // Re-check tier live in case they upgraded/downgraded since connecting.
    const tier = await getTierForTelegramUser(ownerTgId);
    const tierAllowed = await canUseBusinessBot(ownerTgId);
    if (tierAllowed !== conn.tierAllowed) {
      await setBusinessConnectionTierAllowed(connectionId, tierAllowed);
    }

    if (!tierAllowed) {
      // Don't respond to the customer. The owner nag is throttled to
      // one per connection per 24h (audit F3 — sendTierBlockNag); the
      // block itself fires on every message, exactly as before.
      console.log(`[Business] Tier gate blocked reply — owner=${ownerTgId} tier=${tier}`);
      await sendTierBlockNag(ownerTgId, connectionId);
      return { ok: false, reason: 'tier-gate', tier: tier ?? null };
    }

    const settings = await loadBizSettings(ownerTgId);
    if (!settings.aiEnabled) {
      console.log(`[Business] AI disabled — owner=${ownerTgId}, skipping reply`);
      return { ok: false, reason: 'ai-disabled' };
    }

    console.log(`[Business] Message — owner=${ownerTgId} mode=${settings.replyMode} connection=${connectionId}`);

    // Decision layer (DP-9, Batch 3c — ships gated OFF/shadow): per-message
    // triage. LIVE actions only, and only these two: intent=spam at ≥ 0.90
    // confidence → no reply (AI/greeting modes only — in fixed mode the
    // layer never alters the configured message, triage just logs);
    // needs_owner ≥ 0.70 → an owner heads-up IN ADDITION to the mode reply
    // below. Shadow/off/failed → today's behavior exactly. Business text
    // is never archived by the layer (biz_triage suppresses state_json).
    if ((await setPosture('biz_triage')) !== 'off') {
      const bOut = await decide({
        surface: 'business', questionSet: 'biz_triage',
        state: { conversation: twinConversation('business', 1), text: String(text), replyMode: settings.replyMode },
        actorId: String(ownerTgId), chatId: String(chatId),
      });
      if (bOut?.ok && !bOut.shadow) {
        const intent = bOut.answers.intent;
        const needsOwner = bOut.answers.needs_owner?.value ?? 0;
        if (intent?.value === 'spam' && intent.confidence >= 0.90 && settings.replyMode !== 'fixed') {
          if (bOut.logId) await recordDecisionOutcome(bOut.logId, 'spam-silence');
          // Twin wave 1 (C10): a live suppression is memory-worthy — link
          // the memory row to the decide log row. Proposed-only, label-only.
          try {
            await recordSystemDecision({
              scope: 'owner', actorId: String(ownerTgId), chatId: String(chatId),
              topicKey: 'biz-triage', title: 'Business triage silenced spam',
              decision: 'Twin link: business triage suppressed a spam reply (live biz_triage action)',
              reasoning: null, status: 'proposed', reasonState: 'not_stated',
              decisionLogId: bOut.logId,
            });
          } catch { /* twin link failures never break triage */ }
          console.log(`[Business] Triage spam-silence — owner=${ownerTgId}`);
          return { ok: true, replied: false, reason: 'triage-spam' };
        }
        if (needsOwner >= 0.70) {
          await sendOwnerDM(ownerTgId,
            '📩 Business heads-up\n\nA customer message looks like it needs you personally ' +
            `(triage: ${intent?.value ?? 'other'}). It is in your business chat — PB is still replying per your configured mode.`);
          if (bOut.logId) await recordDecisionOutcome(bOut.logId, 'owner-heads-up');
          // Twin wave 1 (C10): a live owner alert is memory-worthy — link
          // the memory row to the decide log row. Proposed-only, label-only.
          try {
            await recordSystemDecision({
              scope: 'owner', actorId: String(ownerTgId), chatId: String(chatId),
              topicKey: 'biz-triage', title: 'Business triage owner heads-up',
              decision: 'Twin link: business triage sent an owner heads-up (live biz_triage action)',
              reasoning: null, status: 'proposed', reasonState: 'not_stated',
              decisionLogId: bOut.logId,
            });
          } catch { /* twin link failures never break triage */ }
        } else if (bOut.logId) {
          await recordDecisionOutcome(bOut.logId, 'mode-reply');
        }
      }
    }

    if (settings.replyMode === 'fixed') {
      const msg = settings.fixedMessage?.trim();
      if (!msg) {
        // Nothing configured to send — honest no-op (no invented message).
        console.log(`[Business] Fixed mode with no fixed message — owner=${ownerTgId}, nothing to send`);
        return { ok: true, replied: false, reason: 'fixed-no-message' };
      }
      try {
        await sendBusinessReply(chatId, connectionId, msg);
        return { ok: true, replied: true, mode: 'fixed' };
      } catch (err) {
        console.warn('[Business] Fixed reply failed:', err?.description ?? err?.message);
        return { ok: false, replied: false, reason: 'send-failed', code: err?.code ?? null, description: err?.description ?? null };
      }
    }

    if (settings.replyMode === 'greeting_then_ai') {
      const greeting = settings.greetingMessage?.trim();
      if (greeting) {
        await sendBusinessReply(chatId, connectionId, greeting)
          .catch((err) => console.warn('[Business] Greeting send failed:', err?.description ?? err?.message));
      }
    }

    const reply = await getBusinessAIReply(text, settings);
    try {
      await sendBusinessReply(chatId, connectionId, reply);
      return { ok: true, replied: true, mode: settings.replyMode, replyPreview: reply.slice(0, 80) };
    } catch (err) {
      console.warn('[Business] Reply failed:', err?.description ?? err?.message);
      return { ok: false, replied: false, reason: 'send-failed', code: err?.code ?? null, description: err?.description ?? null, replyPreview: reply.slice(0, 80) };
    }
  } catch (err) {
    console.error('[business_message]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}
