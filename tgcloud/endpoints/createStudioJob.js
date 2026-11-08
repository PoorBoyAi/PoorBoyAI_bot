// Mini App: Studio step 1 — generate a script draft for approval.
// NO charge happens here: the draft (script + storyboard + cost + funds
// preview) is held in config state `studiodraft:<uid>` until the caller
// approves via approveStudioJob. Scoped ONLY to ctx.initData.user.id.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { getConfig, setConfig } from '../lib/config.js';
import {
  isStudioEnabled, isStudioPremiumEnabled, generateStudioScript, studioCost,
  studioCostWithPremium, normalizePremium, premiumCost, getStudioEntitlement,
  previewFunds, studioDraftKey,
} from '../lib/studio.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const tgId = String(tg.id);
  if (!(await isStudioEnabled())) {
    return { parked: true, enabled: false };
  }
  const params = {
    brief: String(input?.brief ?? '').trim(),
    tokenName: String(input?.tokenName ?? '').trim(),
    tokenSymbol: String(input?.tokenSymbol ?? '').trim(),
    tokenAddress: String(input?.tokenAddress ?? '').trim() || null,
    tokenChain: String(input?.tokenChain ?? 'base').trim() || 'base',
    vibe: ['hype', 'professional', 'degen'].includes(input?.vibe) ? input.vibe : 'hype',
    durationSec: [15, 20, 30, 45, 60].includes(Number(input?.durationSec ?? input?.duration))
      ? Number(input?.durationSec ?? input?.duration) : 15,
    mascot: input?.mascot ? 1 : 0,
    // Batch 4 premium: carried RAW into the held draft; honored only if
    // the premium flag is on (normalized below + re-gated in
    // lib/studio.js createStudioJob at approve time).
    premium: (input?.premium && typeof input.premium === 'object') ? input.premium : null,
  };
  if (!params.tokenName) throw new EndpointError('Token name is required.', { code: 'BAD_INPUT' });
  if (!params.brief) throw new EndpointError('A short brief is required.', { code: 'BAD_INPUT' });

  let draft;
  try {
    const { script, storyboard } = await generateStudioScript(params);
    draft = { script, storyboard };
  } catch (err) {
    throw new EndpointError('Script generation failed: ' + String(err?.message ?? 'brain error').slice(0, 200), { code: 'SCRIPT_FAILED' });
  }

  const premium = (await isStudioPremiumEnabled())
    ? normalizePremium(params.premium, params.durationSec)
    : null;
  const pCost = premiumCost(premium);
  const cost = studioCostWithPremium(params.durationSec, premium);
  const ent = await getStudioEntitlement(tgId);
  const split = previewFunds(ent, cost, pCost > 0 ? { noTrial: true } : {});
  const draftId = 'draft_' + Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  await setConfig(studioDraftKey(tgId), JSON.stringify({
    draftId, params, script: draft.script, storyboard: draft.storyboard,
    cost, createdAt: Date.now(),
  }));

  return {
    parked: false,
    enabled: true,
    draftId,
    script: draft.script,
    storyboard: draft.storyboard,
    cost,
    // Premium keys exist ONLY on a premium draft (flag on + selected) —
    // every other response is byte-identical to the pre-Batch-4 shape.
    ...(premium ? { premium, premiumCost: pCost } : {}),
    fundsPreview: split
      ? { ...split, wallet: ent.wallet, includedRemaining: ent.includedRemaining, trialAvailable: ent.trialAvailable, ownerUnlimited: ent.ownerUnlimited }
      : null,
    canAfford: Boolean(split),
  };
};
