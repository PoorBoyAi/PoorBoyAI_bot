// Mini App: Raids tab — GLOBAL leaderboard across opted-in communities.
// Only communities with globalBoard=true in their group_settings JSON appear.
// Stats only: total raid XP, completed raid sessions, active raiders — never
// calls, token addresses, wallets, member lists, or message content.
// Disqualified raiders (is_disqualified) are excluded from ALL aggregates.
import db, { eq, desc, sql } from 'sdk/db';
import { group_settings, known_groups, raid_sessions, raid_xp } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);

  // ── Opted-in chats: boolean flag in the group_settings JSON ──
  let optedIn = [];
  try {
    const rows = await db.select().from(group_settings).all();
    optedIn = rows
      .filter((r) => r?.settings?.globalBoard === true)
      .map((r) => String(r.chatId));
  } catch { optedIn = []; }

  // ── Stored community titles (no chat ids leave the server beyond the key) ──
  const titles = new Map();
  try {
    const rows = await db.select().from(known_groups).all();
    for (const g of rows) titles.set(String(g.chatId), g.title ?? 'Community');
  } catch { /* fall through */ }

  const communities = [];
  for (let i = 0; i < optedIn.length; i++) {
    const chatId = optedIn[i];
    let totalXp = 0, raiders = 0, raidsCompleted = 0;
    try {
      const xpRow = await db
        .select({
          total: sql`COALESCE(SUM(${raid_xp.xp}), 0)`,
          raiders: sql`COUNT(DISTINCT ${raid_xp.userId})`,
        })
        .from(raid_xp)
        .where(sql`${raid_xp.chatId} = ${chatId} AND ${raid_xp.isDisqualified} = 0`)
        .get();
      totalXp = Number(xpRow?.total ?? 0);
      raiders = Number(xpRow?.raiders ?? 0);
    } catch { /* stats default to 0 */ }
    try {
      const doneRow = await db
        .select({ n: sql`COUNT(*)` })
        .from(raid_sessions)
        .where(sql`${raid_sessions.chatId} = ${chatId} AND ${raid_sessions.isActive} = 0`)
        .get();
      raidsCompleted = Number(doneRow?.n ?? 0);
    } catch { /* default 0 */ }
    communities.push({
      key: i,
      name: titles.get(chatId) ?? `Community ${i + 1}`,
      totalXp,
      raidsCompleted,
      raiders,
      xpPerRaider: raiders > 0 ? Math.round(totalXp / raiders) : 0,
    });
  }

  // ── Top 15 individuals across opted-in communities (names only) ──
  let topRaiders = [];
  try {
    if (optedIn.length > 0) {
      const orList = optedIn
        .map((c) => sql`${raid_xp.chatId} = ${c}`)
        .reduce((acc, cond) => sql`${acc} OR ${cond}`);
      const rows = await db.select().from(raid_xp)
        .where(sql`(${orList}) AND ${raid_xp.isDisqualified} = 0`)
        .orderBy(desc(raid_xp.xp)).limit(15).all();
      topRaiders = rows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        name: r.displayName || r.username || `Raider ${r.userId}`,
        xp: r.xp,
        community: titles.get(String(r.chatId)) ?? 'Community',
      }));
    }
  } catch { topRaiders = []; }

  return { communities, topRaiders };
};
