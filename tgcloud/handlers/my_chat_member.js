// handlers/my_chat_member.js — runs when the bot's membership in a chat changes.
// Port of the my_chat_member handler in telegram-community-bot.ts (~27022):
// on being added (member/administrator) to a new group, announce it to the
// home group (TELEGRAM_HOME_CHAT_ID config) and record the group in
// known_groups. Home group from config; if unset, only tracking runs.

import { api } from 'sdk';
import db from 'sdk/db';
import { known_groups } from '../schema.js';
import { getConfig } from '../lib/config.js';
import { handleRelayBotRemoved } from '../lib/relay.js';

export default async function (memberUpdate, ctx) {
  try {
    const newStatus = memberUpdate?.new_chat_member?.status;
    const chat = memberUpdate?.chat;
    if (!chat || !newStatus) return;
    // PB Relay Wave 3 (spec §9.3): PB was kicked/removed — relay
    // destinations in this chat die and rules sourced here pause as
    // source-lost, owners DM'd once per flip. Any chat type (channels
    // included). Failure-isolated: never break this handler.
    if (newStatus === 'left' || newStatus === 'kicked') {
      try { await handleRelayBotRemoved(chat); }
      catch (err) { console.error('[my_chat_member] relay removal hook failed:', err?.message ?? err); }
      return;
    }
    if (newStatus !== 'member' && newStatus !== 'administrator') return;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    // Track the group in known_groups (upsert).
    try {
      await db.insert(known_groups).values({
        chatId: String(chat.id),
        title: chat.title ?? 'unknown',
        lastActive: new Date(),
      })
        .onConflictDoUpdate({ target: known_groups.chatId, set: { title: chat.title ?? 'unknown', lastActive: new Date() } })
        .run();
    } catch (err) {
      console.error('[my_chat_member] track failed:', err?.message ?? err);
    }

    const homeId = await getConfig('TELEGRAM_HOME_CHAT_ID');
    if (!homeId || String(chat.id) === String(homeId)) return;

    // Setup Wizard pointer (2026-11-04): new groups get ONE in-group note
    // so admins can find setup — the handler previously posted nothing
    // here. Placed AFTER the home early-return above, so the home group
    // can never receive it. Failure-isolated: never breaks this handler.
    await api.sendMessage({
      chat_id: chat.id,
      text: '👋 PB is here! Group admins: run /manage → 🧭 Setup Wizard to set this group\'s welcome, goodbye, rules, and social links.',
    }).catch((err) => console.error('[my_chat_member] join note failed:', err?.message ?? err));

    let memberCount = 0;
    try {
      memberCount = await api.getChatMemberCount({ chat_id: chat.id }) ?? 0;
    } catch { /* non-fatal */ }

    const groupName = chat.title ?? 'a new group';
    await api.sendMessage({
      chat_id: Number(homeId),
      text: `🎉 Great news! I found a new home in ${groupName} with ${memberCount.toLocaleString()} members! 🎉\n\nThe PoorBoy Army keeps growing! LFG 🚀🐳`,
    }).catch((err) => console.error('[my_chat_member] announce failed:', err?.message ?? err));
  } catch (err) {
    console.error('[my_chat_member]', err?.message ?? err);
  }
}
