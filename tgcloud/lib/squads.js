// lib/squads.js — raid squads.
// Ported from telegram-community-bot.ts /squad + /squads handlers (line 14469+).
// One squad per user per chat; raids also earn squad_xp via lib/xp.js.

import db, { eq, sql } from 'sdk/db';
import { raid_squads, raid_squad_members, raid_xp } from '../schema.js';

export async function getUserSquad(userId, chatId) {
  const rows = await db.all(sql`
    SELECT s.* FROM raid_squads s
    JOIN raid_squad_members m ON m.squad_id = s.id
    WHERE m.user_id = ${userId} AND m.chat_id = ${chatId}
  `).catch(() => []);
  return rows[0] ?? null;
}

export async function squadByName(chatId, name) {
  const rows = await db.select().from(raid_squads)
    .where(sql`${raid_squads.chatId} = ${chatId} AND lower(${raid_squads.name}) = lower(${name})`)
    .get()
    .catch(() => null);
  return rows;
}

export async function createSquad(chatId, name, leaderId) {
  const existing = await getUserSquad(leaderId, chatId);
  if (existing) return { ok: false, reason: 'already-in-squad' };
  if (await squadByName(chatId, name)) return { ok: false, reason: 'name-taken' };
  const rows = await db.insert(raid_squads).values({
    chatId, name, leaderId, squadXp: 0, createdAt: new Date(),
  }).returning();
  const squad = rows[0];
  await db.insert(raid_squad_members).values({
    squadId: squad.id, userId: leaderId, chatId, joinedAt: new Date(),
  }).run().catch(() => {});
  await db.update(raid_xp)
    .set({ squadId: squad.id })
    .where(sql`${raid_xp.userId} = ${leaderId} AND ${raid_xp.chatId} = ${chatId}`)
    .run()
    .catch(() => {});
  return { ok: true, squad };
}

export async function joinSquad(chatId, name, userId) {
  const existing = await getUserSquad(userId, chatId);
  if (existing) return { ok: false, reason: 'already-in-squad' };
  const squad = await squadByName(chatId, name);
  if (!squad) return { ok: false, reason: 'not-found' };
  await db.insert(raid_squad_members).values({
    squadId: squad.id, userId, chatId, joinedAt: new Date(),
  }).run().catch(() => {});
  await db.update(raid_xp)
    .set({ squadId: squad.id })
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .run()
    .catch(() => {});
  return { ok: true, squad };
}

export async function leaveSquad(chatId, userId) {
  const squad = await getUserSquad(userId, chatId);
  if (!squad) return { ok: false, reason: 'not-in-squad' };
  await db.delete(raid_squad_members)
    .where(sql`${raid_squad_members.squadId} = ${squad.id} AND ${raid_squad_members.userId} = ${userId}`)
    .run()
    .catch(() => {});
  await db.update(raid_xp)
    .set({ squadId: null })
    .where(sql`${raid_xp.userId} = ${userId} AND ${raid_xp.chatId} = ${chatId}`)
    .run()
    .catch(() => {});
  return { ok: true, squad };
}

export async function squadMembers(squadId) {
  return db.select().from(raid_squad_members)
    .where(eq(raid_squad_members.squadId, squadId))
    .all()
    .catch(() => []);
}

export async function listSquads(chatId, limit = 10) {
  const rows = await db.all(sql`
    SELECT s.id, s.name, s.squad_xp AS squadXp,
      (SELECT COUNT(*) FROM raid_squad_members WHERE squad_id = s.id) AS memberCount
    FROM raid_squads s
    WHERE s.chat_id = ${chatId}
    ORDER BY s.squad_xp DESC
    LIMIT ${limit}
  `).catch(() => []);
  return rows;
}
