// Signal Inlet — the public webhook door (Superpower Sweep wave,
// 2026-10-23; lib/groups.js processSignalInlet is the whole engine).
//
// A group's OWN alert sources (TradingView, exchange/whale webhooks,
// any tool that can POST JSON) send:
//   { secret, title?, text, route?, ticker?, close?, price? }
// The secret is the ONLY credential and the ONLY routing information:
// it resolves to exactly one group (stored hashed; shown once to the
// creating admin via /signals), and the rendered card lands in that
// group and nowhere else. There is deliberately no chatId field — a
// sender cannot aim a signal at a group whose secret it does not hold.
//
// Auth model note: Mini App endpoints normally identify the caller from
// platform-verified initData. This endpoint's caller is an external
// webhook, not a Telegram user, so it performs NO initData check — the
// per-group secret (128+ bits, hashed at rest, constant-time compare,
// rate-limited per group, revocable by rotation, global kill flag) is
// the authentication, exactly like the fabston pattern it reimplements.
// Refusals are uniform: an unknown secret, a disabled inlet, the kill
// flag, and a rate-limit trip are indistinguishable from the outside
// beyond the machine code, and an unknown secret writes no audit row
// (there is no group to seal it to). Signals are DISPLAY-ONLY — PB
// never trades on an inlet signal. No outbound fetch happens here.
import { EndpointError } from 'sdk';
import { processSignalInlet } from '../lib/groups.js';
import { MIRROR_ACTIONS, mirrorVerifyAction } from '../lib/relay.js';

export default async function (input, ctx) {
  if (!input || typeof input !== 'object') {
    throw new EndpointError('JSON body required.', { code: 'VALIDATION' });
  }
  // Telegram ↔ Discord mirror actions (Mirror wave, 2026-10-23) — folded
  // into this endpoint rather than a new module (the app sits AT the
  // 100-module cap). Called ONLY by the mirror daemon via `tgcloud run`
  // with owner --ctx: every action requires owner initData AND a
  // websync-shaped HMAC (mirrorVerifyAction). Anything else gets the
  // same uniform refusal as an unknown signal secret — the door reveals
  // nothing about whether mirroring exists or what state it is in.
  // NOTE: this endpoint is 401-gated for direct external POSTs (platform
  // initData gate, proven 2026-10-23); the daemon's CLI run is the only
  // path that reaches these actions.
  if (typeof input.action === 'string' && Object.prototype.hasOwnProperty.call(MIRROR_ACTIONS, input.action)) {
    if (!(await mirrorVerifyAction(input, ctx))) {
      throw new EndpointError('Signal not accepted.', { code: 'NOT_ACCEPTED' });
    }
    return MIRROR_ACTIONS[input.action](input);
  }
  const r = await processSignalInlet(input);
  if (r.ok) return { ok: true, delivered: true, messageId: r.messageId ?? null };
  if (r.code === 'VALIDATION') {
    throw new EndpointError('A non-empty "text" field is required.', { code: 'VALIDATION', field: r.field ?? 'text' });
  }
  if (r.code === 'PAYLOAD_TOO_LARGE') {
    throw new EndpointError(`Signal text is capped at ${r.max} characters.`, { code: 'PAYLOAD_TOO_LARGE', max: r.max });
  }
  if (r.code === 'RATE_LIMITED') {
    throw new EndpointError('This group\'s signal rate limit is reached. Try later.', { code: 'RATE_LIMITED', ratePerHour: r.ratePerHour });
  }
  // NOT_FOUND / INLET_OFF / INLET_DISABLED / SEND_FAILED / UNAVAILABLE —
  // one uniform refusal so the door reveals nothing about which groups
  // have inlets or what state they are in.
  throw new EndpointError('Signal not accepted.', { code: 'NOT_ACCEPTED' });
}
