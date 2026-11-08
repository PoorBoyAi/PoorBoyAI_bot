// Stage B (MCP core): list the caller's developer API keys (masked).
// Raw keys never leave the issuance response — they are not stored, so
// there is nothing to leak here: prefix/last4/masked power the display.
// Stage D: each row also carries today's call count (dailyCalls, folded
// from the Worker's keys-sync usage report) and the plan's daily read cap
// (dailyCap). The Worker's MCP_DAILY_READ_LIMITS is the source of truth
// for the caps — this mirror just keeps the UI honest.
import db, { eq, desc } from 'sdk/db';
import { mcp_api_keys } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { canonicalTier } from '../lib/tiers.js';
import { maskKey } from '../lib/mcpkeys.js';

// Mirror of the Worker's MCP_DAILY_READ_LIMITS (phase4/_worker.js) — the
// Worker enforces them; the app only displays them.
const DAILY_READ_CAPS = { free: 250, starter: 1000, builder: 2500, pro: 10000, agency: 25000, one: 10000, trial: 10000 };

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  let rows = [];
  try {
    rows = await db.select().from(mcp_api_keys)
      .where(eq(mcp_api_keys.telegramUserId, tgId))
      .orderBy(desc(mcp_api_keys.createdAt)).all();
  } catch { /* db errors read as no keys */ }

  return rows.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.apiKeyPrefix,
    masked: maskKey(k.apiKeyPrefix, k.last4),
    last4: k.last4,
    plan: k.plan,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    status: k.revokedAt ? 'revoked' : 'active',
    dailyCalls: k.dailyCallsDay === today ? (Number(k.dailyCalls) || 0) : 0,
    dailyCap: DAILY_READ_CAPS[canonicalTier(k.plan)] ?? DAILY_READ_CAPS.free,
  }));
};
