// Mini App M2: update one of the caller's agents.
// Patch: { id, status?, <agent input fields…> }. Status may only move
// between 'active' and 'paused' here (expired|triggered are system states).
// Reactivating re-checks the tier gate, refreshes the tier snapshot, and
// sets nextRunAt = now so the next tick cycle picks it up.
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { user_agents } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { enforceGate, canonicalTier } from '../lib/tiers.js';
import { buildAgentConfig, flattenAgentConfig, AGENT_STATUSES_USER } from '../lib/agentInput.js';

const FLAT_FIELDS = [
  'tokenName', 'tokenTicker', 'contractAddress', 'chain',
  'websiteUrl', 'telegramUrl', 'targetGroups',
  'intervalHours', 'targetPrice', 'direction', 'fireOnce', 'cooldownHours',
];

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  const user = await ensureUser(tg);
  const tier = user?.tier ?? 'free';
  if (input == null) input = {};

  const id = Number(input.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new EndpointError('PB needs an agent id to update.', { code: 'VALIDATION', field: 'id' });
  }
  const row = await db.select().from(user_agents)
    .where(and(eq(user_agents.id, id), eq(user_agents.telegramUserId, tgId))).get();
  if (!row) throw new EndpointError('Agent not found.', { code: 'NOT_FOUND' });

  const patch = {};

  if (input.status !== undefined) {
    const s = String(input.status).trim();
    if (!AGENT_STATUSES_USER.includes(s)) {
      throw new EndpointError('Status can only be "active" or "paused" here.', { code: 'VALIDATION', field: 'status' });
    }
    if (s === 'active' && row.status !== 'active') {
      let mine = [];
      try {
        mine = await db.select().from(user_agents)
          .where(eq(user_agents.telegramUserId, tgId)).all();
      } catch { /* db errors read as no existing agents */ }
      await enforceGate(tgId, tier, 'agentsRunning', mine.filter((a) => a.status === 'active').length);
      patch.nextRunAt = new Date();
      patch.tier = canonicalTier(tier);
    }
    patch.status = s;
  }

  const provided = FLAT_FIELDS.filter((f) => input[f] !== undefined);
  if (provided.length) {
    const merged = { ...flattenAgentConfig(row.config ?? {}) };
    for (const f of provided) merged[f] = input[f];
    patch.config = buildAgentConfig(row.agentType, merged); // throws VALIDATION
  }

  if (!Object.keys(patch).length) {
    throw new EndpointError('Nothing to update — send a status or agent fields.', { code: 'VALIDATION' });
  }
  patch.updatedAt = new Date();

  await db.update(user_agents).set(patch)
    .where(and(eq(user_agents.id, id), eq(user_agents.telegramUserId, tgId))).run();

  const updated = await db.select().from(user_agents)
    .where(and(eq(user_agents.id, id), eq(user_agents.telegramUserId, tgId))).get();
  return {
    id: updated.id,
    type: updated.agentType,
    status: updated.status,
    tier: updated.tier,
    config: updated.config ?? {},
    nextRunAt: updated.nextRunAt,
    lastRunAt: updated.lastRunAt,
    totalRuns: updated.totalRuns ?? 0,
  };
};
