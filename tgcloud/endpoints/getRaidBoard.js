// Mini App: Raids tab — the real raid board for the home community.
// Scoped ONLY to the home group chat id (community sealing: no other
// group's raids, queue, or XP ever leaves this endpoint).
import db, { eq, desc, sql } from 'sdk/db';
import { raid_sessions, raid_queue, raid_xp, raid_squads, raid_squad_members } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { getConfig } from '../lib/config.js';

function joinUrl(chatId, messageId) {
  if (!messageId) return null;
  const short = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${short}/${messageId}`;
}

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const home = await getConfig('TELEGRAM_HOME_CHAT_ID', '-1003931169299');
  const now = new Date();

  // ── Live raids: active sessions for the home group, not yet ended ──
  let live = [];
  try {
    const rows = await db.select().from(raid_sessions)
      .where(sql`${raid_sessions.chatId} = ${home} AND ${raid_sessions.isActive} = 1`)
      .orderBy(desc(raid_sessions.id)).all();
    live = rows
      .filter((r) => !r.endsAt || new Date(r.endsAt) > now)
      .map((r) => ({
        id: r.id,
        platform: r.platform,
        platformEmoji: r.platformEmoji ?? '⚔️',
        targetUrl: r.targetUrl,
        callToAction: r.callToAction,
        startedAt: new Date(r.startedAt).toISOString(),
        endsAt: r.endsAt ? new Date(r.endsAt).toISOString() : null,
        xpPerRaid: r.xpPerRaid,
        targetCount: r.targetCount ?? null,
        createdByName: r.createdByName ?? null,
        joinUrl: joinUrl(home, r.messageId),
      }));
  } catch { live = []; }

  // ── Up next: queued targets for the home group, oldest first ──
  let queue = [];
  try {
    const rows = await db.select().from(raid_queue)
      .where(sql`${raid_queue.chatId} = ${home} AND ${raid_queue.status} = 'queued'`)
      .orderBy(raid_queue.id).limit(10).all();
    queue = rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      platformEmoji: r.platformEmoji ?? '⚔️',
      targetUrl: r.targetUrl,
      callToAction: r.callToAction,
      targetCount: r.targetCount ?? null,
      addedByName: r.addedByName ?? null,
    }));
  } catch { queue = []; }

  // ── Leaderboard: top 15 raid XP for the home group ──
  let leaderboard = [];
  try {
    const rows = await db.select().from(raid_xp)
      .where(sql`${raid_xp.chatId} = ${home} AND ${raid_xp.isDisqualified} = 0`)
      .orderBy(desc(raid_xp.xp)).limit(15).all();
    leaderboard = rows.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      name: r.displayName || r.username || `Raider ${r.userId}`,
      xp: r.xp,
      streak: r.streak,
      squadId: r.squadId ?? null,
    }));
  } catch { leaderboard = []; }

  // ── My stats: the caller's own raid XP + rank ──
  let me = null;
  try {
    const row = await db.select().from(raid_xp)
      .where(sql`${raid_xp.chatId} = ${home} AND ${raid_xp.userId} = ${tg.id}`).get();
    if (row) {
      let rank = null;
      try {
        const ahead = await db
          .select({ n: sql`COUNT(*)` }).from(raid_xp)
          .where(sql`${raid_xp.chatId} = ${home} AND ${raid_xp.isDisqualified} = 0 AND ${raid_xp.xp} > ${row.xp}`).get();
        rank = (ahead?.n ?? 0) + 1;
      } catch { rank = null; }
      me = { userId: tg.id, xp: row.xp, streak: row.streak, squadId: row.squadId ?? null, rank };
    }
  } catch { me = null; }

  // ── Squads: standings for the home group ──
  let squads = [];
  try {
    const rows = await db.select().from(raid_squads)
      .where(sql`${raid_squads.chatId} = ${home}`)
      .orderBy(desc(raid_squads.squadXp)).limit(8).all();
    for (const s of rows) {
      let members = 0;
      try {
        const c = await db
          .select({ n: sql`COUNT(*)` }).from(raid_squad_members)
          .where(eq(raid_squad_members.squadId, s.id)).get();
        members = c?.n ?? 0;
      } catch { members = 0; }
      squads.push({ id: s.id, name: s.name, xp: s.squadXp, members });
    }
  } catch { squads = []; }

  return { live, queue, leaderboard, me, squads };
};
