// Stage D: Mini App "Link a purchase" — claim a web checkout (guest or
// subscription) into the caller's Telegram identity via the Worker's
// HMAC-gated claim bridge (phase4-design.md §4.3).
//
// Identity comes ONLY from ctx.initData — the Mini App never names a
// telegram id; the claim binds to whoever is signed into Telegram.
//   {mode:'lookup', ref} → is the checkout claimable, and what would it grant?
//   {mode:'commit', ref} → lookup first (must be claimable), then the atomic
//                          Worker commit, then the grant is applied locally.
// Idempotency: the Worker commit 409s replays (status guard) and every local
// applier is replay-safe (applyClaimGrant → lib/websync.js), so a double tap
// can never double-grant.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { getConfig } from '../lib/config.js';
import { claimLookup, claimCommit, applyClaimGrant } from '../lib/websync.js';

// Checkout ids are UUIDs (Worker's CHECKOUT_UUID_RE) — anything else is a
// user typo, not a lookup.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function bridgeUnavailable() {
  return new EndpointError(
    "PB can't reach the store right now — nothing was claimed. Give it a minute and try again.",
    { code: 'SYNC_UNAVAILABLE' },
  );
}

/** Throw the honest EndpointError for a non-ok claim response. */
function failFrom(res, fallbackCode) {
  // Worker 404 — the receipt code names no purchase on file.
  if (res?.httpStatus === 404 || res?.error === 'not_found') {
    throw new EndpointError(
      "PB can't find that purchase — double-check the code on your receipt page and try again.",
      { code: 'NOT_FOUND' },
    );
  }
  throw bridgeUnavailable();
}

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  const mode = String(input?.mode ?? 'lookup').trim().toLowerCase();
  const ref = String(input?.ref ?? '').trim();
  if (mode !== 'lookup' && mode !== 'commit') {
    throw new EndpointError('PB here — ask for a lookup or a claim, nothing else.', { code: 'BAD_MODE' });
  }
  if (!UUID_RE.test(ref)) {
    throw new EndpointError(
      "PB here — that doesn't look like a checkout code. Paste the full code from your receipt page.",
      { code: 'BAD_REF' },
    );
  }

  const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
  if (!secret) {
    throw new EndpointError(
      'PB here — purchase linking is being wired up. Try again in a bit.',
      { code: 'SYNC_NOT_CONFIGURED' },
    );
  }

  if (mode === 'lookup') {
    const res = await claimLookup(secret, ref);
    if (!res?.ok) failFrom(res, 'LOOKUP_FAILED');
    return {
      checkoutId: res.checkout_id ?? ref,
      status: res.status ?? null,
      claimable: Boolean(res.claimable),
      product: res.product_id ?? null,
      grant: res.grant ?? null,
    };
  }

  // commit: the lookup must say claimable before we ask the Worker to flip.
  const look = await claimLookup(secret, ref);
  if (!look?.ok) failFrom(look, 'LOOKUP_FAILED');
  if (!look.claimable) {
    if (look.status === 'claimed') {
      throw new EndpointError(
        'This purchase was already claimed — your grant is in place, nothing was charged twice.',
        { code: 'ALREADY_CLAIMED' },
      );
    }
    throw new EndpointError(
      `This purchase is ${String(look.status ?? 'unknown').replace(/_/g, ' ')} — it can't be claimed right now. If you just paid, give it a minute and look it up again.`,
      { code: 'NOT_CLAIMABLE', status: look.status ?? null },
    );
  }

  const res = await claimCommit(secret, ref, tgId);
  if (!res?.ok) {
    // Race: someone (or a double tap) committed between lookup and commit.
    if (res?.httpStatus === 409 || res?.error === 'not_claimable') {
      throw new EndpointError(
        'This purchase was already claimed — your grant is in place, nothing was charged twice.',
        { code: 'ALREADY_CLAIMED' },
      );
    }
    failFrom(res, 'COMMIT_FAILED');
  }

  const grant = res.grant ?? look.grant ?? null;
  try {
    await applyClaimGrant(tgId, grant, ref);
  } catch (err) {
    console.error('[linkPurchase] grant applied late:', err?.message ?? err);
    throw new EndpointError(
      'Your purchase is claimed — PB hit a snag applying the grant here, and it will land on the next sync. Nothing was charged twice.',
      { code: 'CLAIM_PARTIAL' },
    );
  }
  return { ok: true, grant };
};
