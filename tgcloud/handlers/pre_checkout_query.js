// PB Stars lane — pre-checkout handler, LIVE (combined wave 2026-11-02).
// Landed by the approved Stars-slot merge: lib/chatsessions.js was
// merged into lib/miniapp.js, freeing exactly one module slot, so the
// tree stays at 100 modules (43 endpoints + 46 lib + 10 handlers +
// schema.js). Handler names match Telegram update types; the platform
// derives webhook allowed_updates from handlers/* on push, so this
// file subscribes the bot to pre_checkout_query updates.
//
// The validation logic lives in lib/websync.js (answerStarsPreCheckout,
// harnessed in harness-stars.mjs s06-s10). This handler is only the
// thin platform seam: it answers the query through that function and
// never throws, never pages — a pre-checkout rejection is not an error.
//
// SDK NOTE: api.answerPreCheckoutQuery follows the SDK's api.<method>
// convention (cf. api.sendMessage, api.getChatMember used throughout
// the tree). Method-name confirmation in the isolate is a post-push
// step; if the SDK names it differently, change ONLY this seam and
// the default in answerStarsPreCheckout, never the validation.
import { answerStarsPreCheckout } from '../lib/websync.js';

export default async function (preCheckout, ctx) {
  try {
    await answerStarsPreCheckout(preCheckout);
  } catch (err) {
    console.error('[stars:precheckout-handler]', err?.message ?? err);
  }
}
