// handlers/business_connection.js — a Telegram Business account connects or
// disconnects @PoorBoyAI_bot (BusinessConnection payload).
// Port of the business_connection branch of the original webhook route
// (routes/webhook.ts): store the connection, evaluate the tier gate
// (owner or Starter+, lib/business-bot-access.ts), and DM the owner the
// connected / not-eligible result. Disconnect flips is_active off.
// Privacy: only the connection row is stored — no message content, ever.

import {
  getTierForTelegramUser, canUseBusinessBot,
  upsertBusinessConnection, setBusinessConnectionActive, sendOwnerDM,
} from '../lib/business.js';

export default async function (bc, ctx) {
  try {
    const ownerUserId = bc?.user?.id;
    const connectionId = bc?.id;
    if (!ownerUserId || !connectionId) return { ok: false, reason: 'no-owner-or-connection' };

    if (bc.is_enabled) {
      console.log(`[Business] Connected — owner=${ownerUserId} connection_id=${connectionId}`);

      const tier = await getTierForTelegramUser(ownerUserId);
      const tierAllowed = await canUseBusinessBot(ownerUserId);

      await upsertBusinessConnection(connectionId, ownerUserId, tierAllowed);

      if (tierAllowed) {
        await sendOwnerDM(ownerUserId,
          `🤖 PB Business Bot is now active!\n\n` +
          `When customers DM you, I'll reply on your behalf using AI — 24/7, while you're away.\n\n` +
          `I can handle:\n` +
          `• Crypto questions — price, TA, token info\n` +
          `• General AI chat in any language\n` +
          `• PoorBoyAI ($PBAI) info & how to buy\n\n` +
          `You can take over any chat manually at any time — I only reply when you're not around.\n\n` +
          `PoorBoy Army never sleeps. 💪\n` +
          `poorboyai.pages.dev`
        );
      } else {
        await sendOwnerDM(ownerUserId,
          `🔒 Business Bot requires Starter or above\n\n` +
          `You've connected @PoorBoyAI_bot to your Business account — great move!\n\n` +
          `This feature is included with the PB Plan ($29 USD/mo) and every active paid plan.\n\n` +
          `Your current tier: ${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Free'}\n\n` +
          `Upgrade in the PB app — open @PoorBoyAI_bot and tap the menu button — to activate AI auto-replies for your customers.`
        );
        console.log(`[Business] Tier gate — owner=${ownerUserId} tier=${tier} NOT allowed`);
      }
      return { ok: true, connected: true, tierAllowed };
    }

    console.log(`[Business] Disconnected — owner=${ownerUserId}`);
    await setBusinessConnectionActive(connectionId, false);
    await sendOwnerDM(ownerUserId,
      `👋 PB Business Bot disconnected. Re-add me anytime via your Telegram Business settings.`
    );
    return { ok: true, connected: false };
  } catch (err) {
    console.error('[business_connection]', err?.message ?? err);
    return { ok: false, reason: 'error' };
  }
}
