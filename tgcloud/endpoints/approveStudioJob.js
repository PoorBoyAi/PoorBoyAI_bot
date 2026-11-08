// Mini App: Studio step 2 — approve the held draft: create the job and
// reserve its credits (trial → included → purchased, refId-keyed). The
// draft is consumed on success; an insufficient balance is a clean
// EndpointError and the draft stays held for a retry after top-up.
// Scoped ONLY to ctx.initData.user.id.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { getConfig, setConfig } from '../lib/config.js';
import { isStudioEnabled, createStudioJob, studioDraftKey } from '../lib/studio.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const tgId = String(tg.id);
  if (!(await isStudioEnabled())) {
    return { parked: true, enabled: false };
  }
  const raw = await getConfig(studioDraftKey(tgId), null);
  const held = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  if (!held?.script || (held.createdAt && Date.now() - held.createdAt > 30 * 60_000)) {
    throw new EndpointError('No script draft is waiting — generate one first.', { code: 'NO_DRAFT' });
  }
  if (input?.draftId && held.draftId && input.draftId !== held.draftId) {
    throw new EndpointError('That draft is stale — generate a fresh one.', { code: 'STALE_DRAFT' });
  }
  try {
    const { job } = await createStudioJob(tgId, held.params, {
      script: held.script,
      storyboard: held.storyboard,
    });
    await setConfig(studioDraftKey(tgId), JSON.stringify({ createdAt: 0 }));
    return { parked: false, enabled: true, job };
  } catch (err) {
    if (/insufficient/i.test(String(err?.message ?? ''))) {
      throw new EndpointError(String(err.message).slice(0, 300), { code: 'INSUFFICIENT_CREDITS' });
    }
    throw new EndpointError(String(err?.message ?? 'Could not create the job.').slice(0, 300), { code: 'CREATE_FAILED' });
  }
};
