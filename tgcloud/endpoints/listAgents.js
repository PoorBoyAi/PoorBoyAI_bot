// Mini App M2: list the caller's agents with each agent's last run
// (agent_runs rows the tick writes when it executes the agent).
import db, { eq, desc, inArray } from 'sdk/db';
import { user_agents, agent_runs } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);

  let agents = [];
  try {
    agents = await db.select().from(user_agents)
      .where(eq(user_agents.telegramUserId, tgId))
      .orderBy(desc(user_agents.createdAt)).all();
  } catch { /* db errors read as no agents */ }

  const ids = agents.map((a) => a.id);
  const lastRuns = {};
  if (ids.length) {
    let runs = [];
    try {
      runs = await db.select().from(agent_runs)
        .where(inArray(agent_runs.agentId, ids))
        .orderBy(desc(agent_runs.ranAt)).all();
    } catch { /* db errors read as no runs */ }
    for (const r of runs) {
      if (!(r.agentId in lastRuns)) {
        lastRuns[r.agentId] = {
          status: r.status,
          summary: r.summary,
          error: r.error,
          groupsPosted: r.groupsPosted,
          ranAt: r.ranAt,
        };
      }
    }
  }

  return agents.map((a) => ({
    id: a.id,
    type: a.agentType,
    status: a.status,
    tier: a.tier,
    config: a.config ?? {},
    nextRunAt: a.nextRunAt,
    lastRunAt: a.lastRunAt,
    totalRuns: a.totalRuns ?? 0,
    expiresAt: a.expiresAt,
    lastRun: lastRuns[a.id] ?? null,
    createdAt: a.createdAt,
  }));
};
