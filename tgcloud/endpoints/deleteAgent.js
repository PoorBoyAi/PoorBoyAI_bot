// Mini App M2: delete one of the caller's agents, plus its run log
// (no foreign keys on the platform — cascade is done by hand).
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { user_agents, agent_runs } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  const id = Number(input?.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new EndpointError('PB needs an agent id to delete.', { code: 'VALIDATION', field: 'id' });
  }
  const row = await db.select().from(user_agents)
    .where(and(eq(user_agents.id, id), eq(user_agents.telegramUserId, tgId))).get();
  if (!row) throw new EndpointError('Agent not found.', { code: 'NOT_FOUND' });

  try {
    await db.delete(agent_runs).where(eq(agent_runs.agentId, id)).run();
  } catch { /* run-log cleanup is best effort */ }
  await db.delete(user_agents)
    .where(and(eq(user_agents.id, id), eq(user_agents.telegramUserId, tgId))).run();

  return { deleted: id };
};
