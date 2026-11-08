// Mini App M2: create an agent. Writes the row in exactly the shape the
// tick's cycleUserAgents consumes: status 'active', the caller's tier as the
// entitlement snapshot, nextRunAt = now (so the next 5-minute cycle picks it
// up), and a tick-shaped snake_case config. Server-side tier gate enforced.
import { EndpointError } from 'sdk';
import db, { eq } from 'sdk/db';
import { user_agents } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { enforceGate, canonicalTier } from '../lib/tiers.js';
import { buildAgentConfig } from '../lib/agentInput.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  const user = await ensureUser(tg);
  const tier = user?.tier ?? 'free';
  if (input == null) input = {};

  const type = String(input.agentType ?? '').trim();
  const config = buildAgentConfig(type, input); // throws VALIDATION / UNKNOWN_TYPE

  let mine = [];
  try {
    mine = await db.select().from(user_agents)
      .where(eq(user_agents.telegramUserId, tgId)).all();
  } catch { /* db errors read as no existing agents */ }
  await enforceGate(tgId, tier, 'agentsRunning', mine.filter((a) => a.status === 'active').length);

  let inserted = [];
  let insertError = null;
  try {
    inserted = await db.insert(user_agents).values({
      telegramUserId: tgId,
      agentType: type,
      config,
      status: 'active',
      tier: canonicalTier(tier),
      nextRunAt: new Date(),
    }).returning();
  } catch (err) {
    insertError = err?.message ?? String(err);
    console.error('[createAgent] insert failed:', insertError);
  }
  const row = inserted[0];
  if (!row) {
    throw new EndpointError('PB could not save that agent. Try again.', {
      code: 'DB_ERROR',
      cause: insertError ? String(insertError).slice(0, 200) : 'no row returned',
    });
  }

  return {
    id: row.id,
    type: row.agentType,
    status: row.status,
    tier: row.tier,
    config: row.config ?? {},
    nextRunAt: row.nextRunAt,
  };
};
