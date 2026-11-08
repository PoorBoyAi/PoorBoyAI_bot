// Mini App: run one PB skill for the caller (private/DM ctx). The skill
// registry itself never throws; unknown names are refused here with a
// clean EndpointError so the Mini App can surface it.
//
// Gate enforcement is layered (design §6.3): skillGateText() runs here as
// a pre-check AND inside each gated skill's run() — a hand-crafted request
// hits the same wall as the bot command. Skill results may carry URL-only
// `buttons` (share / invite links), passed through untouched.
import { EndpointError } from 'sdk';
import { caller } from '../lib/miniapp.js';
import { SKILLS, runSkill as runSkillLib, skillGateText, sendSkillCardCompanion } from '../lib/skills.js';
import { sendVerdictCard } from '../lib/verdict.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const name = String(input?.name ?? '').trim();
  if (!name || !SKILLS[name]) {
    throw new EndpointError('Unknown skill', { code: 'UNKNOWN_SKILL' });
  }
  const args = (input?.args && typeof input.args === 'object') ? input.args : {};
  const from = { id: tg.id, first_name: tg.first_name, username: tg.username };

  const gateText = await skillGateText(name, from, args);
  if (gateText) {
    return { ok: false, text: gateText, gated: true, skill: name, cardSent: false };
  }

  const skillCtx = { from, chatId: tg.id, chatType: 'private' };
  const res = await runSkillLib(name, skillCtx, args);
  // Verdict card (Edge wave #2 integration): whenever a token_scan resolved
  // a token address, the branded GoPlus card is sent to the caller's own DM.
  // It fires even when the brain-written analysis failed (quota) — the card
  // is market/security data, not brain text, so it stays honest either way.
  // sendVerdictCard never throws and sends nothing when GoPlus has no data.
  // The verdict_card skill is the card-first slice of the same path.
  let cardSent = false;
  const cardAddr = name === 'token_scan'
    ? res?.data?.token?.address
    : name === 'verdict_card'
      ? (res?.ok ? res?.data?.address : null)
      : null;
  if (cardAddr) {
    const card = await sendVerdictCard(tg.id, cardAddr).catch(() => ({ sent: false }));
    cardSent = Boolean(card?.sent);
  }
  // Gap-1 card companions (price / TA / rank): rendered from the skill's
  // own returned data — the same fetch that built the text — and sent to
  // the caller's DM. Senders never throw and send nothing on empty data.
  if (!cardSent) {
    const companion = await sendSkillCardCompanion(name, res, tg.id, from).catch(() => ({ sent: false }));
    cardSent = Boolean(companion?.sent);
  }
  return {
    ok: Boolean(res?.ok),
    text: res?.text ?? '',
    gated: Boolean(res?.gated),
    skill: name,
    cardSent,
    buttons: Array.isArray(res?.buttons) ? res.buttons : [],
  };
};
