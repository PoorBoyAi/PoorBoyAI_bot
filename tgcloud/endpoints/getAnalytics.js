// Mini App: the caller's OWN analytics (Dashboard wave item 5) — their
// subscription grants, credit ledger movement, and activity counts for a
// period. Scoped to ctx.initData.user.id via lib/analytics.js; parked
// features are honest literal markers, not invented data.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { buildOwnAnalytics, ANALYTICS_PERIODS } from '../lib/analytics.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const period = String(input?.period ?? '30d');
  if (!ANALYTICS_PERIODS.includes(period)) {
    throw new EndpointError("period must be '7d', '30d' or 'all'", { code: 'BAD_PERIOD' });
  }
  return await buildOwnAnalytics(tg.id, period);
};
