// endpoints/tick.js — ops entry point for the external clock.
// `npx tgcloud run endpoints/tick` executes one full due-cycle pass.
// (Serverless can only `run` handlers/ and endpoints/ modules, so the
// lib/tick.js clock is exposed through here. Cycles are idempotent.)
//
// H1 (SECURITY-AUDIT-2026-10-22, M2): this was the one Mini App endpoint
// with no identity check — it ignored ctx entirely, so any authenticated
// Mini App session could force-run the due-cycle pass at will. It now
// applies the same owner check its sibling endpoints use (decideReport's
// pattern): the caller must be a verified platform identity whose id is
// in TELEGRAM_OWNER_ID. The pb-serverless-tick cron drives it with the
// owner's initData (user id in ctx), so the legitimate clock is
// unaffected; internal maybeTick() calls in the handlers never pass
// through this endpoint and are untouched.

import { EndpointError } from 'sdk';
import { runDueCycles, cycleWatcherScan } from '../lib/tick.js';
import { pullOutboxBrainOnly } from '../lib/websync.js';
import { getConfig } from '../lib/config.js';
import { isOwnerId } from '../lib/groups.js';

export default async function (input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId || !(await isOwnerId(userId))) {
    throw new EndpointError('Owner only.', { code: 'FORBIDDEN' });
  }
  // Tick-budget wave (2026-11-06): the watcher scan (~26s) runs in its
  // own invocation via the pb-watcher-scan cron — it takes NO tick lock
  // and runs NO cycles, so a slow scan can never stall the clock. The
  // scan keeps its own cadence (1-min cron) and its own watermarks.
  if (input?.scanOnly === true) {
    const scan = await cycleWatcherScan();
    return { scanOnly: true, ranAt: new Date().toISOString(), scan };
  }
  // Tick-wallclock wave (2026-11-06): the brain outbox rows (~8-25s
  // each through the ladder) drain in their own invocation via the
  // pb-outbox-brain cron — it takes NO tick lock and runs NO cycles,
  // so a slow brain row can never stall the clock. Same shape as the
  // scanOnly branch above. Non-brain rows stay in the tick (fast,
  // uncapped); the brain-only pull stops at the first non-brain row
  // and the tick applies it on its next pass. No new gate is bypassed:
  // without the sync secret the branch reports not_configured, and the
  // outbox pull is the same operation the tick already performs.
  if (input?.outboxBrainOnly === true) {
    const secret = await getConfig('PB_WEB_SYNC_SECRET', '');
    if (!secret) return { outboxBrainOnly: true, ranAt: new Date().toISOString(), outbox: { skipped: 'not_configured' } };
    const outbox = await pullOutboxBrainOnly(secret);
    return { outboxBrainOnly: true, ranAt: new Date().toISOString(), outbox };
  }
  const summary = await runDueCycles();
  return summary ?? { ok: true };
}
