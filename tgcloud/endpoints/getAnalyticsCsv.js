// Mini App: CSV export of the caller's OWN analytics (Dashboard wave
// item 5) — the same rows getAnalytics returns, as an RFC 4180 string.
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { buildOwnAnalytics, analyticsCsv, ANALYTICS_PERIODS } from '../lib/analytics.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const period = String(input?.period ?? '30d');
  if (!ANALYTICS_PERIODS.includes(period)) {
    throw new EndpointError("period must be '7d', '30d' or 'all'", { code: 'BAD_PERIOD' });
  }
  const data = await buildOwnAnalytics(tg.id, period);
  return { filename: 'pb-analytics.csv', csv: analyticsCsv(data) };
};
