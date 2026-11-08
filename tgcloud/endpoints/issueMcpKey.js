// Stage B (MCP core): issue a developer API key (phase4-design.md §4.2).
// Identity comes ONLY from ctx.initData. The RAW key is returned exactly
// once — only its sha256:v1: hash is stored, and the raw key is never
// logged. Eligibility: owner bypasses; everyone else needs Starter+ and
// must stay under their tier's mcpKeys cap (tiers.js).
import { EndpointError } from 'sdk';
import db, { eq, and, isNull } from 'sdk/db';
import { mcp_api_keys } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { canonicalTier, enforceGate } from '../lib/tiers.js';
import { isOwnerId } from '../lib/groups.js';
import { generateKey, hashKey, maskKey } from '../lib/mcpkeys.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  const user = await ensureUser(tg);
  const plan = canonicalTier(user?.tier ?? 'free');

  const name = String(input?.name ?? '').trim().slice(0, 64) || 'API key';

  // Starter+ eligibility (original isDeveloperApiEligibleTier semantics).
  const owner = await isOwnerId(tgId).catch(() => false);
  if (!owner && plan === 'free') {
    throw new EndpointError(
      'PB here — Developer API keys need a Starter plan or higher. Upgrade to issue keys.',
      { code: 'TIER_LIMIT', resource: 'mcpKeys', tier: plan, limit: 0, current: 0 },
    );
  }

  // Per-tier cap counts non-revoked keys only (revoked keys free up the slot).
  let mine = [];
  try {
    mine = await db.select().from(mcp_api_keys)
      .where(and(eq(mcp_api_keys.telegramUserId, tgId), isNull(mcp_api_keys.revokedAt))).all();
  } catch { /* db errors read as no existing keys */ }
  await enforceGate(tgId, user?.tier ?? 'free', 'mcpKeys', mine.length);

  // Generate first; the raw key NEVER touches logs or storage.
  const raw = generateKey();
  const apiKeyHash = await hashKey(raw);

  let inserted = [];
  let insertError = null;
  try {
    inserted = await db.insert(mcp_api_keys).values({
      telegramUserId: tgId,
      name,
      apiKeyHash,
      apiKeyPrefix: raw.slice(0, 14),
      last4: raw.slice(-4),
      plan,
    }).returning();
  } catch (err) {
    insertError = err?.message ?? String(err);
    console.error('[issueMcpKey] insert failed:', insertError);
  }
  const row = inserted[0];
  if (!row) {
    throw new EndpointError('PB could not create that key. Try again.', {
      code: 'DB_ERROR',
      cause: insertError ? String(insertError).slice(0, 200) : 'no row returned',
    });
  }

  return {
    key: raw, // RAW ONCE — the app must show and keep it now; it is not stored.
    id: row.id,
    name: row.name,
    prefix: row.apiKeyPrefix,
    masked: maskKey(row.apiKeyPrefix, row.last4),
    plan: row.plan,
  };
};
