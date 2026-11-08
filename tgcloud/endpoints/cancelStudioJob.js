// Mini App: cancel the caller's OWN Studio job while it is still in a
// pre-pipeline state (pending / script_ready / voice_ready) — mirror
// transition to cancelled (pushed to the queue on the next tick) + exact
// refund. Rendering jobs refuse: the bridge never lands a cancel on a
// claimed job, so offering it would refund AND deliver.
// Scoped ONLY to ctx.initData.user.id. Flag OFF → { parked: true }.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { isStudioEnabled, cancelStudioJob } from '../lib/studio.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const tgId = String(tg.id);
  if (!(await isStudioEnabled())) {
    return { parked: true, enabled: false };
  }
  const jobId = String(input?.jobId ?? input?.id ?? '').trim();
  if (!jobId) throw new EndpointError('jobId is required.', { code: 'BAD_INPUT' });
  try {
    const { job } = await cancelStudioJob(tgId, jobId);
    return { parked: false, enabled: true, job };
  } catch (err) {
    throw new EndpointError(String(err?.message ?? 'Cancel failed.').slice(0, 300), { code: 'CANCEL_FAILED' });
  }
};
