// handlers/chat_member.js — member status changes in groups.
// Port of the chat_member handler in telegram-community-bot.ts (~25247).
// Telegram routes member joins here as ChatMemberUpdated; when a member
// joins through a tracked per-user invite link, the update carries
// invite_link — credit the link's owner with a telegram_group referral
// (source design §5: "join attribution … crediting the link owner — INSIDE
// THAT GROUP ONLY"). The referral row, both XP awards, and the referrer DM
// all key off THIS chat; no other group's data is read or shown.
//
// (handlers/my_chat_member.js covers the bot's own membership changes —
//  those updates contain neither the joining user nor an invite link, so
//  referral attribution cannot live there.)

import { api } from 'sdk';
import db, { eq } from 'sdk/db';
import { community_invite_links } from '../schema.js';
import { recordReferral, notifyReferrer } from '../lib/referrals.js';
import { shieldJoinHook } from '../lib/groups.js';

export default async function (memberUpdate, ctx) {
  try {
    const chatId = memberUpdate?.chat?.id;
    const newMember = memberUpdate?.new_chat_member;
    if (!chatId || !newMember) return;
    if (memberUpdate.chat?.type !== 'group' && memberUpdate.chat?.type !== 'supergroup') return;

    // PB Shield (2026-10-21): feed join transitions to the shield join
    // hook (burst detection + new-joiner watch). Some joins surface only
    // here (no new_chat_members service post); the hook dedupes against
    // the message seam on a 30s window, so a join seen on both seams is
    // processed exactly once. The hook self-gates on shieldEnabled.
    try {
      const joined = newMember.user;
      const wasOut = !memberUpdate.old_chat_member
        || ['left', 'kicked'].includes(memberUpdate.old_chat_member.status);
      if (joined?.id && wasOut && (newMember.status === 'member' || newMember.status === 'restricted')) {
        await shieldJoinHook(chatId, joined);
      }
    } catch { /* shield failures never break attribution */ }

    const { status } = newMember;
    const inviteLink = memberUpdate?.invite_link?.invite_link;
    const joinedUser = newMember.user;
    if (
      !inviteLink || !joinedUser?.id || joinedUser.is_bot ||
      (status !== 'member' && status !== 'restricted') ||
      memberUpdate.old_chat_member?.status !== 'left'
    ) return;

    const linkRow = await db.select().from(community_invite_links)
      .where(eq(community_invite_links.inviteLink, inviteLink))
      .get()
      .catch(() => null);
    if (!linkRow) return;
    // Sealed: only credit joins into the very group the link was issued for.
    if (Number(linkRow.chatId) !== Number(chatId)) return;

    const referrerId = Number(linkRow.referrerTelegramId);
    if (referrerId === joinedUser.id) return;

    const inserted = await recordReferral({
      referrerId,
      referredId: joinedUser.id,
      source: 'telegram_group',
      chatId: Number(chatId),
      referrerUsername: null,
      referredUsername: joinedUser.username ?? null,
    }).catch((err) => {
      console.error(`[chat_member] Telegram invite attribution failed for ${joinedUser.id}:`, err?.message ?? err);
      return false;
    });

    if (!inserted) {
      console.log(`[chat_member] ${joinedUser.id} already has a referrer; skipped duplicate Telegram invite credit`);
      return;
    }
    console.log(`[chat_member] ${joinedUser.id} joined ${chatId} via invite link of ${referrerId}`);
    const joinerHandle = joinedUser.username
      ? `@${joinedUser.username}`
      : (joinedUser.first_name ?? 'Someone');
    await notifyReferrer(referrerId, 'your Telegram invite link', joinerHandle, joinedUser.username ?? null);
  } catch (err) {
    console.error('[chat_member]', err?.message ?? err);
  }
}
