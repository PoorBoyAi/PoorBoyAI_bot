// Own-data analytics builder (Dashboard wave item 5), shared by the
// getAnalytics / getAnalyticsCsv endpoints. Reads ONLY the caller's rows:
// web_subscriptions (tier grants), credit_ledger (their userKey stream),
// user_activity_log (their activity). Parked features (booster / airdrop /
// video) have no PB-side stores to read — they are reported as literal
// 'parked' markers, never invented rows.

import db, { eq, desc } from 'sdk/db';
import { web_subscriptions, credit_ledger, user_activity_log } from '../schema.js';

export const ANALYTICS_PERIODS = ['7d', '30d', 'all'];

export function toUnix(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

function cutoffUnix(period) {
  if (period === '7d') return Math.floor(Date.now() / 1000) - 7 * 86400;
  if (period === '30d') return Math.floor(Date.now() / 1000) - 30 * 86400;
  return 0;
}

export async function buildOwnAnalytics(tgId, period) {
  const id = String(tgId);
  const cutoff = cutoffUnix(period);
  const inPeriod = (unix) => unix != null && unix >= cutoff;

  let subscriptions = [];
  try {
    const row = await db.select().from(web_subscriptions)
      .where(eq(web_subscriptions.telegramUserId, id)).get();
    if (row && inPeriod(toUnix(row.updatedAt))) {
      subscriptions = [{
        tier: row.tier,
        expiresAt: toUnix(row.expiresAt),
        source: row.source ?? null,
        ref: row.ref ?? null,
        updatedAt: toUnix(row.updatedAt),
      }];
    }
  } catch { /* no web subscription row */ }

  let balance = 0;
  let creditIn = 0;
  let creditOut = 0;
  let entries = [];
  try {
    const rows = await db.select().from(credit_ledger)
      .where(eq(credit_ledger.userKey, 'telegram:' + id))
      .orderBy(desc(credit_ledger.createdAt)).all();
    balance = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const periodRows = rows.filter((r) => inPeriod(toUnix(r.createdAt)));
    for (const r of periodRows) {
      const amt = Number(r.amount) || 0;
      if (amt > 0) creditIn += amt;
      if (amt < 0) creditOut += -amt;
    }
    entries = periodRows.slice(0, 50).map((r) => ({
      ts: toUnix(r.createdAt),
      delta: Number(r.amount) || 0,
      reason: r.purpose ?? r.kind,
      kind: r.kind,
      refId: r.refId ?? null,
    }));
  } catch { /* no ledger rows yet */ }

  let activityTotal = 0;
  const byKind = {};
  try {
    const rows = await db.select().from(user_activity_log)
      .where(eq(user_activity_log.telegramUserId, id)).all();
    for (const r of rows) {
      if (!inPeriod(toUnix(r.createdAt))) continue;
      activityTotal++;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    }
  } catch { /* no activity yet */ }

  return {
    period,
    subscriptions,
    credits: { balance, in: creditIn, out: creditOut, entries },
    activity: { total: activityTotal, byKind },
    parked: { booster: 'parked', airdrop: 'parked', video: 'parked' },
  };
}

/** RFC 4180 field escaping. */
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The same rows as buildOwnAnalytics, as one RFC 4180 CSV string. */
export function analyticsCsv(a) {
  const lines = ['section,ts,kind_or_tier,delta,reason_or_source,ref'];
  for (const s of a.subscriptions) {
    lines.push(['subscription', s.updatedAt ?? '', s.tier, '', s.source ?? '', s.ref ?? ''].map(csvField).join(','));
  }
  for (const e of a.credits.entries) {
    lines.push(['credit', e.ts ?? '', e.kind, e.delta, e.reason ?? '', e.refId ?? ''].map(csvField).join(','));
  }
  for (const [kind, count] of Object.entries(a.activity.byKind)) {
    lines.push(['activity', '', kind, count, '', ''].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
