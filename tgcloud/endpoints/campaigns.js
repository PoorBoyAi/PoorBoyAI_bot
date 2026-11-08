// Mini App: member campaigns — ONE action-routed endpoint for the whole
// surface (get / save / setStatus / addSlot / updateSlot / deleteSlot).
// Why one file: the platform caps modules per app and PB is at the cap;
// the other waves' endpoints follow the one-verb-per-file convention, this
// surface consolidates instead. All enforcement is server-side in
// lib/campaigns.js; every action is scoped to ctx.initData.user.id —
// members only ever see and touch their OWN campaign.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import {
  getCampaignView, saveOwnCampaign, setOwnCampaignStatus,
  addOwnSlot, updateOwnSlot, deleteOwnSlot, getOwnCampaign,
  campaignPublic, slotPublic,
} from '../lib/campaigns.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const action = String(input?.action ?? 'get');
  try {
    switch (action) {
      case 'get':
        return await getCampaignView(tg.id);
      case 'save': {
        const row = await saveOwnCampaign(tg.id, {
          projectName: input?.projectName,
          ticker: input?.ticker,
          description: input?.description,
          website: input?.website,
          contractAddress: input?.contractAddress,
          chain: input?.chain,
          telegramUsername: input?.telegramUsername,
          customButtons: input?.customButtons,
          postIntervalOverride: input?.postIntervalOverride,
        });
        return { ok: true, campaign: campaignPublic(row) };
      }
      case 'setStatus': {
        const row = await setOwnCampaignStatus(tg.id, String(input?.status ?? ''));
        return { ok: true, campaign: campaignPublic(row) };
      }
      case 'addSlot': {
        const row = await addOwnSlot(tg.id, {
          targetChatId: input?.targetChatId,
          intervalMinutes: input?.intervalMinutes,
          customText: input?.customText,
          customButtons: input?.customButtons,
        });
        const campaign = await getOwnCampaign(tg.id);
        return { ok: true, slot: slotPublic(row, campaign) };
      }
      case 'updateSlot': {
        const row = await updateOwnSlot(tg.id, input?.slotId, {
          active: input?.active,
          intervalMinutes: input?.intervalMinutes,
          customText: input?.customText,
          customButtons: input?.customButtons,
        });
        const campaign = await getOwnCampaign(tg.id);
        return { ok: true, slot: slotPublic(row, campaign) };
      }
      case 'deleteSlot':
        return await deleteOwnSlot(tg.id, input?.slotId);
      default:
        throw new EndpointError(`Unknown campaign action: ${action}`, { code: 'BAD_ACTION' });
    }
  } catch (err) {
    if (err instanceof EndpointError) throw err; // enforceGate refusals pass through verbatim
    throw new EndpointError(String(err?.message ?? 'Campaign action failed.').slice(0, 300),
      { code: err?.code ?? 'CAMPAIGN_FAILED' });
  }
};
