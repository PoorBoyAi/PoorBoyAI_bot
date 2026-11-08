// PB on Telegram Serverless — v1 database schema.
// Ported from: lib/db/src/schema/ (Drizzle) + CREATE TABLE IF NOT EXISTS
// blocks in artifacts/api-server/src/lib/telegram-community-bot.ts,
// pb-memory.ts (pb_conversations), pbai-holder-sync.ts.
// Postgres types translated: SERIAL -> integer PK autoincrement,
// TIMESTAMPTZ -> integer unix-seconds with timestamp mode,
// enums/arrays -> TEXT/JSON. No foreign keys (platform throws on them).

import { table, integer, text, boolean, json, real, index, primaryKey, unique, sql } from 'sdk/db';

const ts = (name) =>
  integer(name, { mode: 'timestamp' }).default(sql`(unixepoch())`);

// ── Bot users: tier + subscription state ──────────────────────────────────────
// Source: lib/db/src/schema/bot-users.ts (TIERS: free/poor/hustler/grinder/
// chad/whale are legacy aliases; starter/builder/pro/agency are canonical.)
export const bot_users = table('bot_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  tier: text('tier').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  subscriptionExpiresAt: integer('subscription_expires_at', { mode: 'timestamp' }),
  referralCode: text('referral_code').unique(),
  referredBy: text('referred_by'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  tgIdx: index('idx_bot_users_tg').on(t.telegramUserId),
  tierIdx: index('idx_bot_users_tier').on(t.tier),
}));

// ── Team member registry (2026-10-27 wave; registry ONLY, no payouts) ───────
// Owner-DM flow: /teamadd proposes (PENDING) → /teamapprove approves (one
// member per owner call) → /teamremove removes (future payments only).
// No unique constraint on address: a REMOVED row must coexist with a
// later re-proposal of the same address, so duplicates among
// PENDING/APPROVED rows are rejected in code, not by the DB. No FKs
// (platform throws on them). This table records approvals ONLY — no
// spend, sweep, or payout path reads or writes it.
export const team_members = table('team_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  address: text('address').notNull(),
  sharePct: real('share_pct').notNull(),
  state: text('state').notNull().default('pending'),
  proposerId: text('proposer_id'),
  proposedAt: ts('proposed_at').notNull(),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
  approvedBy: text('approved_by'),
  effectiveFrom: integer('effective_from', { mode: 'timestamp' }),
  removedAt: integer('removed_at', { mode: 'timestamp' }),
  removedBy: text('removed_by'),
  removeReason: text('remove_reason'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  stateAddrIdx: index('idx_team_members_state_addr').on(t.state, t.address),
}));

// ── Known groups the bot serves ───────────────────────────────────────────────
// Source: lib/db/src/schema/known-groups.ts
export const known_groups = table('known_groups', {
  chatId: text('chat_id').primaryKey(),
  title: text('title'),
  isAdFree: boolean('is_ad_free').notNull().default(true),
  adFreeBy: text('ad_free_by'),
  firstSeen: ts('first_seen').notNull(),
  lastActive: ts('last_active').notNull(),
});

// ── Cross-platform conversation memory ───────────────────────────────────────
// Source: lib/pb-memory.ts (pb_conversations). Roles: 'user' | 'model'.
// v1: user_key is "telegram:{id}" (linking to clerk ids is a v2 migration item).
export const pb_conversations = table('pb_conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userKey: text('user_key').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  platform: text('platform').notNull().default('unknown'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  userKeyIdx: index('idx_pb_conv_user_key').on(t.userKey, t.createdAt),
}));

// ── Raid XP ledger (per user per chat) ───────────────────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE raid_xp
// (+ ALTER TABLE lines 780-783: streak, last_raid_date, pbai_holder, squad_id)
export const raid_xp = table('raid_xp', {
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  username: text('username'),
  displayName: text('display_name'),
  xp: integer('xp').notNull().default(0),
  streak: integer('streak').notNull().default(0),
  lastRaidDate: text('last_raid_date'),
  pbaiHolder: boolean('pbai_holder').notNull().default(false),
  squadId: integer('squad_id'),
  isDisqualified: boolean('is_disqualified').notNull().default(false),
  walletAddress: text('wallet_address'),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  xpPk: primaryKey({ columns: [t.userId, t.chatId] }),
  chatXpIdx: index('idx_raid_xp_chat').on(t.chatId, t.xp),
}));

// ── Raid queue (targets waiting to go live) ───────────────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE raid_queue.
// The queue of targets; live/active raids live in raid_sessions below.
export const raid_queue = table('raid_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  targetUrl: text('target_url').notNull(),
  platform: text('platform').notNull(),
  platformEmoji: text('platform_emoji').notNull().default('⚔️'),
  callToAction: text('call_to_action').notNull(),
  targetCount: integer('target_count'),
  addedBy: integer('added_by').notNull(),
  addedByName: text('added_by_name'),
  status: text('status').notNull().default('queued'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  chatIdx: index('idx_raid_queue_chat').on(t.chatId, t.status),
}));

// ── Raid sessions (live/active raids) ────────────────────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE raid_sessions
// (+ ALTER TABLE lines 775-790: has_photo, ends_at, xp_per_raid, target_count,
//  is_shill_raid, shill_content, thread_id, is_locked)
export const raid_sessions = table('raid_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id'),
  platform: text('platform').notNull(),
  platformEmoji: text('platform_emoji').notNull().default('⚔️'),
  targetUrl: text('target_url').notNull(),
  callToAction: text('call_to_action').notNull(),
  createdBy: integer('created_by').notNull(),
  createdByName: text('created_by_name'),
  startedAt: ts('started_at').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  hasPhoto: boolean('has_photo').notNull().default(false),
  endsAt: integer('ends_at', { mode: 'timestamp' }),
  xpPerRaid: integer('xp_per_raid').notNull().default(10),
  targetCount: integer('target_count'),
  isShillRaid: boolean('is_shill_raid').notNull().default(false),
  shillContent: text('shill_content'),
  threadId: integer('thread_id'),
  isLocked: boolean('is_locked').notNull().default(false),
  // Raid X-metrics tracking (2026-10-23): per-metric engagement targets
  // for X-post raids (likes / reposts / replies the raid must ADD over
  // its baseline) + baseline and latest snapshots of the post's public
  // metrics + the preview facts (text/author) fetched with them, so the
  // tick can auto-complete the raid and render the results card. All
  // nullable — non-X raids and pre-wave rows never touch them.
  // xLastPollAt / xEndedAt are plain ms-epoch integers (not ts mode).
  xLikesTarget: integer('x_likes_target'),
  xRetweetsTarget: integer('x_retweets_target'),
  xRepliesTarget: integer('x_replies_target'),
  xBaseLikes: integer('x_base_likes'),
  xBaseRetweets: integer('x_base_retweets'),
  xBaseReplies: integer('x_base_replies'),
  xLastLikes: integer('x_last_likes'),
  xLastRetweets: integer('x_last_retweets'),
  xLastReplies: integer('x_last_replies'),
  xLastPollAt: integer('x_last_poll_at'),
  xPostText: text('x_post_text'),
  xAuthorName: text('x_author_name'),
  xAuthorHandle: text('x_author_handle'),
  xEndReason: text('x_end_reason'),
  xEndedAt: integer('x_ended_at'),
}, (t) => ({
  chatActiveIdx: index('idx_raid_sessions_chat_active').on(t.chatId, t.isActive),
}));

// ── Raid completions (one row per raider per raid — UNIQUE(raid_id, user_id)) ─
// Source: telegram-community-bot.ts CREATE TABLE raid_completions.
// Uniqueness enforced in code (check-then-insert); index keeps it fast.
export const raid_completions = table('raid_completions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  raidId: integer('raid_id').notNull(),
  userId: integer('user_id').notNull(),
  username: text('username'),
  displayName: text('display_name'),
  xpEarned: integer('xp_earned').notNull().default(0),
  completedAt: ts('completed_at').notNull(),
}, (t) => ({
  raidUserIdx: index('idx_raid_completions_raid_user').on(t.raidId, t.userId),
  raidIdx: index('idx_raid_completions_raid').on(t.raidId),
}));

// ── Raid messages (card locations to refresh on counts / end state) ──────────
// Source: telegram-community-bot.ts CREATE TABLE raid_messages
// (UNIQUE(raid_id, chat_id) enforced in code via upsert.)
export const raid_messages = table('raid_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  raidId: integer('raid_id').notNull(),
  chatId: integer('chat_id').notNull(),
  messageId: integer('message_id').notNull(),
  hasPhoto: boolean('has_photo').notNull().default(false),
}, (t) => ({
  raidChatIdx: index('idx_raid_messages_raid_chat').on(t.raidId, t.chatId),
}));

// ── Raid alert preferences (one-tap DM raid alerts) ──────────────────────────
// Source: raid_subscribe/raid_unsubscribe handlers in telegram-community-bot.ts
export const raid_alert_preferences = table('raid_alert_preferences', {
  telegramUserId: integer('telegram_user_id').primaryKey(),
  isSubscribed: boolean('is_subscribed').notNull().default(false),
  updatedAt: ts('updated_at').notNull(),
});

// ── Raid squads ─────────────────────────────────────────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE raid_squads (+ UNIQUE chat_id, name)
export const raid_squads = table('raid_squads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  name: text('name').notNull(),
  leaderId: integer('leader_id').notNull(),
  squadXp: integer('squad_xp').notNull().default(0),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  chatNameIdx: index('idx_raid_squads_chat_name').on(t.chatId, t.name),
}));

// ── Raid squad members ───────────────────────────────────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE raid_squad_members
export const raid_squad_members = table('raid_squad_members', {
  squadId: integer('squad_id').notNull(),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  joinedAt: ts('joined_at').notNull(),
}, (t) => ({
  squadPk: primaryKey({ columns: [t.squadId, t.userId] }),
  squadIdx: index('idx_raid_squad_members_squad').on(t.squadId, t.userId),
}));

// ── Raid alert subscribers (opt-in DM raid alerts) ───────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE raid_alert_subscribers
export const raid_alert_subscribers = table('raid_alert_subscribers', {
  telegramUserId: integer('telegram_user_id').primaryKey(),
  subscribedAt: ts('subscribed_at').notNull(),
});

// ── $PBAI holder wallets (holder XP perk verification) ───────────────────────
// Source: lib/pbai-holder-sync.ts (pbai_holder_wallets_bootstrap)
export const pbai_holder_wallets = table('pbai_holder_wallets', {
  baseAddress: text('base_address').primaryKey(),
  telegramUserId: text('telegram_user_id'),
  balance: text('balance').notNull().default('0'),
  verifiedAt: ts('verified_at'),
});

// ── Generic credit ledger (shared Studio/API/MCP wallet accounting) ──────────
// Source concept: lib/mcp-credit-ledger.ts (reserve/settle/refund ledger).
// v1: one append-only ledger; kinds: grant | spend | reserve | settle | refund.
export const credit_ledger = table('credit_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userKey: text('user_key').notNull(),
  amount: integer('amount').notNull(),
  kind: text('kind').notNull(),
  purpose: text('purpose'),
  refId: text('ref_id'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  userIdx: index('idx_credit_ledger_user').on(t.userKey, t.createdAt),
}));

// ── Per-group settings (welcome, rules, filters, group token, …) ────────────
// v1 convenience table (the source scattered group settings across several
// stores); one JSON settings object per chat.
export const group_settings = table('group_settings', {
  chatId: text('chat_id').primaryKey(),
  title: text('title'),
  settings: json('settings'),
  updatedAt: ts('updated_at').notNull(),
});

// Source: telegram-community-bot.ts CREATE TABLE group_free_chat
// (per-group free-chat mode toggled by /freechat).
export const group_free_chat = table('group_free_chat', {
  chatId: text('chat_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: ts('updated_at').notNull(),
});

// ── /manage Phase 2 tables (Portal, Whitelist, Banned Words) ────────────────
// Ports of the original api-server tables (telegram-community-bot.ts
// CREATE TABLE statements :839-864 + group_banned_words in src/index.ts:1013).
// Every row is keyed by chat_id — community sealing holds for all three.
export const group_whitelist = table('group_whitelist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  username: text('username'),
  addedBy: integer('added_by'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  wlUnique: unique().on(t.chatId, t.userId),
}));

export const group_banned_words = table('group_banned_words', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  word: text('word').notNull(),
  addedBy: integer('added_by'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  bwUnique: unique().on(t.chatId, t.word),
}));

// Portal verification challenges. expires_at is a plain integer of UNIX
// SECONDS on purpose (not the timestamp-mode ts()): the isolate has no
// timers, so lib/tick.js sweeps rows with expiresAt <= now and kicks the
// still-unverified members (up to one tick late — the panel page says so).
// stage (portal polish, 2026-10-21): NULL/'verify' = step 1 (the group
// tap) still pending; 'holder' = step 1 done in portal_mode 'both' and
// the holder check is the remaining step. The expiry governs BOTH steps.
export const portal_challenges = table('portal_challenges', {
  chatId: text('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  messageId: integer('message_id'),
  expiresAt: integer('expires_at').notNull(),
  stage: text('stage'),
}, (t) => ({
  pk: primaryKey({ columns: [t.chatId, t.userId] }),
}));

// ── /manage Phase 3 table: Cross Protect links ─────────────────────────────
// Source table: telegram-community-bot.ts CREATE TABLE cross_protect_links
// (:859) — (id, group_a_id, group_b_id, UNIQUE pair), stored once per pair
// and read in both directions. DEVIATION (deliberate, Rowdy's sealing
// rule): the source activated a link the moment ONE group's admin ran
// /crosslink, force-enabling the feature on the other group sight unseen.
// The port models two-sided consent explicitly: a_confirmed / b_confirmed
// record each group's own admin opt-in, and a link is ACTIVE only when
// both are true. The pair is stored canonical (numerically smaller chat
// id in group_a_id) so a single row serves both directions.
export const cross_protect_links = table('cross_protect_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupAId: text('group_a_id').notNull(),
  groupBId: text('group_b_id').notNull(),
  aConfirmed: boolean('a_confirmed').notNull().default(false),
  bConfirmed: boolean('b_confirmed').notNull().default(false),
  requestedBy: integer('requested_by'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  cpUnique: unique().on(t.groupAId, t.groupBId),
}));

// ── Global bans ──────────────────────────────────────────────────────────────
// Source: telegram-community-bot.ts CREATE TABLE global_banned_users
export const global_banned_users = table('global_banned_users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: integer('telegram_user_id'),
  username: text('username'),
  reason: text('reason'),
  bannedAt: ts('banned_at'),
});

// ── Runtime config + secrets (owner-managed key/value store) ─────────────────
// v1 answers the "where do API keys live?" question: in this table, seeded
// post-login by the owner (OPENROUTER_API_KEY, GEMINI_API_KEY,
// TELEGRAM_OWNER_ID, PB_BOT_USERNAME). Never in code.
export const config = table('config', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: ts('updated_at').notNull(),
});

// ── Group message log (Wave 3) ───────────────────────────────────────────────
// Serverless replacement for the source's in-memory recapBuffer Map.
// Feeds /recap, /tldr, /sentiment. Trimmed to 300/chat in lib/groupmsg.js.
export const group_message_log = table('group_message_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  fromName: text('from_name'),
  // Sender id — added for the Contests rebuild (design §4): the original
  // scored messages from user_message_stats keyed by user; this log is its
  // live replacement, so it must know WHO sent each message. Nullable:
  // rows written before this column existed carry no sender and are simply
  // not contest-scorable. Recap/tldr/sentiment only read from_name.
  fromUserId: integer('from_user_id'),
  text: text('text'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  chatIdx: index('idx_group_message_log_chat').on(t.chatId, t.createdAt),
}));

// ── FUD shield state (Wave 3) ────────────────────────────────────────────────
// Serverless replacement for the source's fudBuffer + fudShieldCooldown Maps
// (telegram-community-bot.ts ~21287: 90s window, 3+ unique users, 5-min cooldown).
export const fud_state = table('fud_state', {
  chatId: text('chat_id').primaryKey(),
  messages: json('messages'),   // [{userId, text, ts}] rolling 90s window
  lastFire: integer('last_fire', { mode: 'timestamp' }),
  updatedAt: ts('updated_at').notNull(),
});

// ── Wave 4 tables ─────────────────────────────────────────────────────────────

// User wallets (source: /connect → raid_xp.wallet_address + airdrop_wallets).
// Read-only registrations; no signing material lives here, ever.
export const user_wallets = table('user_wallets', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  baseAddress: text('base_address'),
  solAddress: text('sol_address'),
  // Dedicated Robinhood Chain receiving address (source: airdrop_wallets.rh_address;
  // brain knowledge: RH keeps its own field, never inferred from the Base address).
  rhAddress: text('rh_address'),
  updatedAt: ts('updated_at').notNull(),
});

// Price alerts (source: /alert — fields mirror the source's alert object).
// Evaluation runs on the external tick (clock wave); this table stores them.
// enabled: app on/off toggle (M2); the tick skips disabled rows.
// One-shot semantics kept: the tick fires once, then deletes the row.
export const price_alerts = table('price_alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  chatId: text('chat_id').notNull(),
  tokenAddress: text('token_address').notNull(),
  tokenName: text('token_name'),
  targetPrice: text('target_price').notNull(),
  direction: text('direction').notNull(), // 'above' | 'below'
  enabled: boolean('enabled').notNull().default(true),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  userIdx: index('idx_price_alerts_user').on(t.telegramUserId),
  tokenIdx: index('idx_price_alerts_token').on(t.tokenAddress),
}));

// Whale wallet watches (source: whale_watch_wallets; nonce poller on the clock).
// enabled: app on/off toggle (M2); the tick skips disabled rows.
// lastNonce < 0 seeds on the next cycle; telegramChatId = owner's DM by default.
export const whale_watch_wallets = table('whale_watch_wallets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  telegramChatId: text('telegram_chat_id').notNull(),
  walletAddress: text('wallet_address').notNull(),
  label: text('label'),
  lastNonce: integer('last_nonce').notNull().default(-1),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  userIdx: index('idx_whale_watch_user').on(t.telegramUserId),
}));

// Community events (source: community_events; reminders fire on the clock).
export const community_events = table('community_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  title: text('title').notNull(),
  eventTime: integer('event_time', { mode: 'timestamp' }).notNull(),
  notified1h: boolean('notified_1h').notNull().default(false),
  notified30m: boolean('notified_30m').notNull().default(false),
  fired: boolean('fired').notNull().default(false),
  createdBy: text('created_by'),
}, (t) => ({
  chatIdx: index('idx_community_events_chat').on(t.chatId, t.fired),
}));

// Group price milestones (source: group_price_milestones; celebrations on the clock).
export const group_price_milestones = table('group_price_milestones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  tokenCa: text('token_ca').notNull(),
  tokenName: text('token_name'),
  targetPrice: text('target_price').notNull(),
  label: text('label'),
  triggeredAt: integer('triggered_at', { mode: 'timestamp' }),
}, (t) => ({
  chatIdx: index('idx_milestones_chat').on(t.chatId),
}));

// Business bot settings (source: business_bot_settings; Starter+ feature).
// fallback_message restored 2026-10-19 with the Business bot rebuild — the
// original column was dropped in the v1 port; handlers/business_message.js
// reads it as the configured LLM-failure fallback.
export const business_bot_settings = table('business_bot_settings', {
  ownerTelegramId: text('owner_telegram_id').primaryKey(),
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  replyMode: text('reply_mode').notNull().default('ai'), // ai | fixed | greeting_then_ai
  customSystemPrompt: text('custom_system_prompt'),
  fallbackMessage: text('fallback_message'),
  fixedMessage: text('fixed_message'),
  greetingMessage: text('greeting_message'),
  updatedAt: ts('updated_at').notNull(),
});

// Telegram Business connections (restored 2026-10-19; source:
// business_connections in the original api-server — connection_id PK,
// owner_telegram_id, is_active, tier_allowed, timestamps). One row per
// Business account ↔ bot link. No message content is stored here or
// anywhere — the connection + settings rows are the entire footprint.
export const business_connections = table('business_connections', {
  connectionId: text('connection_id').primaryKey(),
  ownerTelegramId: text('owner_telegram_id').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  tierAllowed: boolean('tier_allowed').notNull().default(false),
  connectedAt: ts('connected_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  ownerIdx: index('idx_business_connections_owner').on(t.ownerTelegramId, t.isActive),
}));

// X handles (source: twitter_handles; on-chain/X verification is v2).
export const twitter_handles = table('twitter_handles', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  twitterHandle: text('twitter_handle'),
  xVerified: boolean('x_verified').notNull().default(false),
  // Wizard-fix wave (2026-10-21): the original Connect Socials wizard's
  // TikTok + Discord legs — same one-row-per-user store as the original.
  tiktokHandle: text('tiktok_handle'),
  discordHandle: text('discord_handle'),
  updatedAt: ts('updated_at').notNull(),
});

// Wizard-fix wave (2026-10-21): the original's Pro+ "your own X API keys"
// store (user_twitter_creds in the original). The original stored the four
// values PLAINTEXT while its copy claimed encryption; here the whole set
// travels as ONE lib/walletvault.js AES-GCM blob (credsEnc) — no plaintext
// credential column exists anywhere in this schema.
export const user_twitter_creds = table('user_twitter_creds', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  screenName: text('screen_name'),
  credsEnc: text('creds_enc').notNull(),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

// Airdrop campaigns (read-only status surface; source: airdrop_campaigns).
// Secrets-carrying columns (encrypted_deposit_pk, recipients_snapshot,
// clerk_user_id, fee plumbing) are deliberately NOT migrated — the status
// fields below are all the bot's /airdropstatus needs.
export const airdrop_campaigns = table('airdrop_campaigns', {
  id: integer('id').primaryKey(),
  telegramUserId: text('telegram_user_id'),
  tokenName: text('token_name'),
  tokenCa: text('token_ca'),
  chain: text('chain'),
  amountPerWallet: text('amount_per_wallet'),
  walletCount: integer('wallet_count'),
  status: text('status'),
  depositAddress: text('deposit_address'),
  serviceFeeUsd: text('service_fee_usd'),
  isWhaleFree: boolean('is_whale_free').notNull().default(false),
  txSuccess: integer('tx_success'),
  txFailed: integer('tx_failed'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  // ── Boost/Airdrop rebuild (2026-10-20): operational columns for the port.
  // The mirror columns above stay untouched; /airdropstatus keeps reading them.
  recipientMode: text('recipient_mode'), // army | custom | legacy
  quoteDigest: text('quote_digest'),
  quoteSig: text('quote_sig'),
  quoteIssuedAt: integer('quote_issued_at'),
  quoteExpiresAt: integer('quote_expires_at'),
  platformFeeUsd: text('platform_fee_usd'),
  networkReserveUsd: text('network_reserve_usd'),
  encryptedDepositPk: text('encrypted_deposit_pk'), // AES-256-GCM ciphertext only; never serialized to users
  depositTokenBalance: text('deposit_token_balance'),
  parentId: integer('parent_id'), // grouped launches: parent campaign id
  launchId: text('launch_id'),
  ownerIdempotencyKey: text('owner_idempotency_key'),
  startAt: integer('start_at'),
  endAt: integer('end_at'),
  feePaymentKind: text('fee_payment_kind'), // xrocket | direct | credit | none
  feePaymentRef: text('fee_payment_ref'),
  benefitMonth: text('benefit_month'),
  dryRun: boolean('dry_run').notNull().default(false),
  failureReason: text('failure_reason'),
  // ── Airdrop Phase 2 (signer bridge, DESIGN §8.8): per-transfer gas ceiling
  // in wei (decimal text), derived at fee-confirm from the network reserve
  // model; gas_reserved_wei is the campaign's outstanding reservation
  // envelope (ceiling × unconfirmed planned transfers), settled down as
  // signer reports confirm. Solana campaigns carry a NULL ceiling (the
  // phase-2 ceiling is EVM-shaped; SOL fees are lamport-denominated).
  gasCeilingWei: text('gas_ceiling_wei'),
  gasReservedWei: text('gas_reserved_wei'),
  // PRICING WAVE (2026-10-31): 1 = this campaign's $0 fee came from the
  // one-time trial airdrop waiver (not a monthly tier benefit) — the
  // auto-confirm path records fee ref 'trial_waiver' for it.
  trialWaiver: integer('trial_waiver').notNull().default(0),
});

// ── Wave 4 tables ─────────────────────────────────────────────────────────────

// Group members (source: group_members — /syncmembers self-registration;
// powers /everyone announcements).
export const group_members = table('group_members', {
  chatId: text('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  firstName: text('first_name'),
  username: text('username'),
  registeredAt: ts('registered_at').notNull(),
}, (t) => ({
  memberPk: primaryKey({ columns: [t.chatId, t.userId] }),
  chatIdx: index('idx_group_members_chat').on(t.chatId),
}));

// Per-user bot settings (source: getUserSettings — shill style, notifications).
export const user_settings = table('user_settings', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  shillStyle: text('shill_style').notNull().default('hype'),
  notifications: json('notifications'),
  updatedAt: ts('updated_at').notNull(),
});

// Ad submissions (source: /advertise — v1 review queue; auto-posting is the clock wave).
export const ad_submissions = table('ad_submissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  projectName: text('project_name').notNull(),
  ticker: text('ticker').notNull(),
  description: text('description').notNull(),
  website: text('website'),
  contractAddress: text('contract_address'),
  status: text('status').notNull().default('pending_review'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  userIdx: index('idx_ad_submissions_user').on(t.telegramUserId),
}));

// ── Wave 5: external clock tables ─────────────────────────────────────────────

// User agents (source: agent-scheduler.ts / agent-executor.ts; DB-as-queue).
// Serverless keeps clerk_user_id out — keyed on telegram_user_id.
// status: active | paused | expired | triggered. tier: entitlement snapshot.
export const user_agents = table('user_agents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  agentType: text('agent_type').notNull(), // auto_shill | price_alert | daily_recap
  config: json('config'),                  // { token_name, token_ticker, contract_address, chain, website_url, telegram_url, target_groups, interval_hours, target_price, direction, fire_once, cooldown_hours, ... }
  status: text('status').notNull().default('active'),
  tier: text('tier').notNull().default('free'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp' }),
  lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
  totalRuns: integer('total_runs').notNull().default(0),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_user_agents_user').on(t.telegramUserId, t.status),
  dueIdx: index('idx_user_agents_due').on(t.status, t.nextRunAt),
}));

// Agent run log (source: agent_runs INSERT in agent-executor.ts).
export const agent_runs = table('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: integer('agent_id').notNull(),
  telegramUserId: text('telegram_user_id'),
  status: text('status').notNull(), // success | failed
  summary: text('summary'),
  error: text('error'),
  groupsPosted: integer('groups_posted').notNull().default(0),
  ranAt: ts('ran_at').notNull(),
}, (t) => ({
  agentIdx: index('idx_agent_runs_agent').on(t.agentId, t.ranAt),
}));

// Scheduled daily messages (source: scheduled_messages CREATE TABLE).
// send_time is "HH:MM" UTC; last_sent is YYYY-MM-DD (source used DATE).
export const scheduled_messages = table('scheduled_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  sendTime: text('send_time').notNull(),
  message: text('message').notNull(),
  createdBy: text('created_by'),
  active: boolean('active').notNull().default(true),
  lastSent: text('last_sent'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  chatIdx: index('idx_scheduled_messages_chat').on(t.chatId, t.active),
}));

// Ad campaigns (source: lib/db ad-campaigns.ts + ALTER drift is_active).
// Status/secret columns from the web dashboard variant are intentionally absent:
// the Serverless clock runs the posting leg only, never touching keys.
export const ad_campaigns = table('ad_campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  projectName: text('project_name').notNull(),
  ticker: text('ticker').notNull(),
  contractAddress: text('contract_address'),
  description: text('description').notNull(),
  website: text('website'),
  telegramUsername: text('telegram_username'),
  active: boolean('active').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true), // ALTER drift — the checker reads this one
  postIntervalOverride: integer('post_interval_override'), // minutes
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_ad_campaigns_user').on(t.telegramUserId, t.isActive),
}));

// Ad send log (source: ad_send_log — powers wasAdRecentlySent dedup).
export const ad_send_log = table('ad_send_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  chatId: text('chat_id').notNull(),
  sentAt: ts('sent_at').notNull(),
}, (t) => ({
  campaignIdx: index('idx_ad_send_log_campaign').on(t.campaignId, t.chatId, t.sentAt),
}));

// ── Stage B (MCP core): developer API keys ───────────────────────────────────
// Phase 4 bridge (phase4-design.md §4.2). Only the SHA-256 hash of a key is
// stored ('sha256:v1:' + hex, see lib/mcpkeys.js); the raw key is returned
// once at issuance and never persisted or logged. prefix/last4 power the
// masked display in the app. plan is a snapshot of the user's canonical tier
// at issuance, refreshed by tier_grant outbox events (lib/websync.js).
export const mcp_api_keys = table('mcp_api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  name: text('name').notNull().default('API key'),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  apiKeyPrefix: text('api_key_prefix').notNull(),
  last4: text('last4').notNull(),
  plan: text('plan').notNull().default('free'),
  createdAt: ts('created_at').notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  // Stage D: today's MCP read counter, folded from the Worker's keys-sync
  // usage report (daily_calls per hash). dailyCallsDay is the UTC day
  // (YYYY-MM-DD, matching the Worker's mcpToday) the count belongs to; the
  // count only ever moves forward within its day and resets on roll.
  dailyCalls: integer('daily_calls').default(0),
  dailyCallsDay: text('daily_calls_day'),
}, (t) => ({
  userIdx: index('idx_mcp_api_keys_user').on(t.telegramUserId),
  hashIdx: index('idx_mcp_api_keys_hash').on(t.apiKeyHash),
}));

// ── Stage B: web-purchase subscription mirror (phase4-design.md §4.3) ──────
// What the Worker granted via its outbox (Stripe / XRocket), keyed by
// telegram id. bot_users stays the tier source the gates read; this row is
// the bridge's audit trail of where a web grant came from.
export const web_subscriptions = table('web_subscriptions', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  tier: text('tier').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  source: text('source'),
  ref: text('ref'),
  updatedAt: ts('updated_at').notNull(),
});

// ── Stage B: outbox idempotency set (phase4-design.md §4.3) ─────────────────
// One row per applied Worker outbox event id; presence = already applied,
// which is what makes outbox replays and re-deliveries safe.
export const processed_outbox_events = table('processed_outbox_events', {
  id: text('id').primaryKey(),
  type: text('type'),
  appliedAt: ts('applied_at').notNull(),
});

// ── Stage D: Telegram ↔ console links ────────────────────────────────────────
// One row per Telegram user who completed the /link code flow in the
// operator console. clerk_user_id is the console account id the Worker
// returned on verify; the row lands here via the Worker's telegram_link
// outbox event (see lib/websync.js applyTelegramLink).
export const telegram_links = table('telegram_links', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  clerkUserId: text('clerk_user_id'),
  linkedAt: ts('linked_at').notNull(),
});

// ── Referral program (restored 2026-10-19; source: referrals table in
// telegram-community-bot.ts — recordReferral ~4149, /invite ~7901) ──────────
// One referrer per referred user: UNIQUE(referred_telegram_id) is the
// first-touch-wins gate — recordReferral inserts ON CONFLICT DO NOTHING and
// only awards XP when the insert actually lands. source ∈ bot | x |
// telegram_group | telegram_message. source_chat_id seals group-channel
// referrals to the group they happened in (group boards read only their own
// chat's rows); bot/x referrals carry the home chat id, as the source did.
export const referrals = table('referrals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  referrerTelegramId: integer('referrer_telegram_id').notNull(),
  referredTelegramId: integer('referred_telegram_id').notNull(),
  source: text('source').notNull().default('bot'),
  referrerUsername: text('referrer_username'),
  referredUsername: text('referred_username'),
  sourceChatId: integer('source_chat_id'),
  sourceMessageId: integer('source_message_id'),
  evidenceText: text('evidence_text'),
  attributedAt: ts('attributed_at').notNull(),
}, (t) => ({
  referredUq: unique('uq_referrals_referred').on(t.referredTelegramId),
  referrerIdx: index('idx_referrals_referrer').on(t.referrerTelegramId),
  chatIdx: index('idx_referrals_chat').on(t.sourceChatId, t.referrerTelegramId),
}));

// Per-user Telegram group invite links (source: community_invite_links).
// One tracked link per user per chat; a join through the link attributes
// the new member to the link's owner (handlers/chat_member.js).
export const community_invite_links = table('community_invite_links', {
  referrerTelegramId: integer('referrer_telegram_id').notNull(),
  chatId: integer('chat_id').notNull(),
  inviteLink: text('invite_link').notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  linkPk: primaryKey({ columns: [t.referrerTelegramId, t.chatId] }),
  linkUq: unique('uq_community_invite_links_link').on(t.inviteLink),
  linkIdx: index('idx_community_invite_links_link').on(t.inviteLink),
}));

// ── Chart Slayer game (restored 2026-10-19; source: chart_slayer_rounds /
// chart_slayer_guesses in telegram-community-bot.ts ~886 + pb_dev_dump.sql
// lines 1611–1628). Rounds are sealed per chat — the tick reads/writes one
// chat at a time and there is no cross-group board. Id mapping per tgcloud
// convention: external identifiers (chat_id, thread_id, message_id) as text;
// internal round_id / telegram user_id as integer (matching raid_xp /
// referrals). poll_id + options are v1 adaptations: the poll created at
// round start is mapped back to its round via poll_id, and the shuffled
// 4-option layout is stored so poll_answer updates (an option INDEX) can
// resolve to a token symbol. thread_id is carried for future forum-topic
// support; v1 posts rounds in the chat itself.
export const chart_slayer_rounds = table('chart_slayer_rounds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  threadId: text('thread_id'),
  answerToken: text('answer_token').notNull(),
  answerName: text('answer_name').notNull(),
  pollId: text('poll_id'),
  options: text('options'), // JSON array of 4 token symbols, in poll order
  startedAt: ts('started_at').notNull(),
  endsAt: integer('ends_at', { mode: 'timestamp' }).notNull(),
  revealedAt: integer('revealed_at', { mode: 'timestamp' }),
  status: text('status').notNull().default('active'), // active | revealed
  messageId: text('message_id'),
}, (t) => ({
  chatStatusIdx: index('idx_chart_slayer_rounds_chat_status').on(t.chatId, t.status),
  pollIdx: index('idx_chart_slayer_rounds_poll').on(t.pollId),
}));

export const chart_slayer_guesses = table('chart_slayer_guesses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  roundId: integer('round_id').notNull(),
  userId: integer('user_id').notNull(),
  username: text('username'),
  displayName: text('display_name'),
  chatId: text('chat_id').notNull(),
  guess: text('guess').notNull(),
  isCorrect: boolean('is_correct').notNull().default(false),
  guessedAt: ts('guessed_at').notNull(),
}, (t) => ({
  roundUserUq: unique('uq_chart_slayer_guesses_round_user').on(t.roundId, t.userId),
  roundIdx: index('idx_chart_slayer_guesses_round').on(t.roundId),
}));

// ── Stage D: Studio access grants (claim bridge) ────────────────────────────
// One row per Telegram user who claimed a Studio access purchase through
// the Mini App "Link a purchase" flow (grant kind studio_access). Upserted
// on claim; the newest claim wins.
export const studio_access_grants = table('studio_access_grants', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  accessDays: integer('access_days'),
  productId: text('product_id'),
  claimedAt: ts('claimed_at').notNull(),
});

// ── TRIALPOLICY 2026-11-01: held grants (trial hold + release) ───────────
// Website pack credits and claimed Studio-access grants that land while
// the 7-day trial is active are HELD here, not granted: trial + purchased
// credits must never stack (decision #1/#2). A held row is pending-only —
// it is never read by any balance/entitlement query, so held money is
// undrawable until release. Release (lib/websync.js releaseHeldGrants)
// runs on conversion (applyTierGrant) and on trial end (tick
// cycleTrialExpiry), and only when weekTrialStatus is inactive; it moves
// each row to its real grant (credit_ledger row / studio_access_grants
// upsert with claimedAt = release time, so the access window starts at
// release and the full term survives the trial) and deletes the held row.
// Release is idempotent: a pack re-release finds its ledger refId and
// just drops the held row. MIGRATE REQUIRED before push: this table does
// not exist in production until `tgcloud migrate` creates it — push the
// schema change and migrate FIRST, then push the code that writes it.
// (Deploying never touches the database; push alone applies nothing.)
export const held_grants = table('held_grants', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  kind: text('kind').notNull(), // 'pack_credits' | 'studio_access'
  credits: integer('credits'),
  accessDays: integer('access_days'),
  productId: text('product_id'),
  refId: text('ref_id'),
  source: text('source'),
  claimedAt: ts('claimed_at').notNull(),
}, (t) => ({
  heldRefIdx: unique().on(t.refId),
}));

// ── Contests (Forgotten Features §4 — ported from pb_dev_dump.sql 2176–2197) ─
// ── PB PRICING WAVE (2026-10-31): 7-day free trial + one-price plan ──────
// pb_trials: one row per Telegram account, EVER (telegramUserId PK = the
// one-per-account enforcement — a second start attempt finds the row and
// refuses; there is no re-trial). The row survives the trial: state flips
// active → ended at day 7, and waiver_used tracks the one-time airdrop
// waiver separately (the waiver stays usable after the trial ends, because
// airdrop arming is parked — otherwise early trial users could never use
// it). Trial credits are NOT ledger credits: credits_used counts against
// TRIAL_CREDIT_CAP (lib/tiers.js) and is checked at every spend site.
// bot_users.tier carries 'trial' while active (the gate vocabulary) and
// the day-7 sweep resets it to 'free' — the trial never changes a paid
// tier, and a user who converts to 'one' mid-trial is never reset.
export const pb_trials = table('pb_trials', {
  telegramUserId: text('telegram_user_id').primaryKey(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  endsAt: integer('ends_at', { mode: 'timestamp' }).notNull(),
  creditsUsed: integer('credits_used').notNull().default(0),
  waiverUsed: integer('waiver_used').notNull().default(0),
  nudgedDay6: integer('nudged_day6').notNull().default(0),
  endedNotified: integer('ended_notified').notNull().default(0),
  state: text('state').notNull().default('active'), // active | ended
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});
// Per-group contest engine: weighted activity score over a window, podium
// announced in-chat, XP prizes via lib/xp.js. Sealed per chat_id — a contest
// is only ever read/written inside its own chat. cash_prize_text is TEXT
// ONLY: PB announces the stated prize; it never holds, moves or pays cash.
// Postgres JSONB → json here; TIMESTAMPTZ → the ts() unix-seconds convention.
export const contests = table('contests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  createdBy: integer('created_by').notNull(),
  contestName: text('contest_name').notNull().default('Community Contest'),
  rulesRaw: text('rules_raw'),
  startAt: integer('start_at', { mode: 'timestamp' }).notNull(),
  endAt: integer('end_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull().default('active'),
  scoringConfig: json('scoring_config').notNull().default({ raids: 40, messages: 30, x_activity: 30 }),
  cashPrizeText: text('cash_prize_text'),
  xpPrizes: json('xp_prizes').notNull().default({ first: 500, second: 300, third: 150 }),
  winnerAnnounced: boolean('winner_announced').notNull().default(false),
  qualificationRules: json('qualification_rules'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  chatStatusIdx: index('idx_contests_chat_status').on(t.chatId, t.status),
  chatCreatedIdx: index('idx_contests_chat_created').on(t.chatId, t.createdAt),
}));

// ── Edge wave: per-user activity log (agent-digest source) ──────────────────
// One row per fired price alert / whale-watch alert. The tick's alert cycles
// are one-shot (rows deleted on fire) and whale watches only mutate
// lastNonce, so without this log an overnight digest could never honestly
// report them. Agent activity is read from agent_runs directly. Rows are
// only ever read back into the SAME user's own DM digest — sealed per
// telegram_user_id, never rendered into any group.
// ── Dashboard wave: named Mini App chat sessions ────────────────────────────
// One row per named chat in the Mini App. The default/legacy conversation
// has NO row — it keeps user_key "telegram:{id}" in pb_conversations. A
// named session's messages use user_key "telegram:{id}:s{sessionId}"
// (see lib/memory.js sessionUserKey). Sealed per telegram_user_id: session
// endpoints only ever read/write the caller's own rows.
export const chat_sessions = table('chat_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  title: text('title').notNull().default('New chat'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_chat_sessions_user').on(t.telegramUserId, t.updatedAt),
}));

export const user_activity_log = table('user_activity_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telegramUserId: text('telegram_user_id').notNull(),
  kind: text('kind').notNull(), // price_alert | whale_watch
  detail: text('detail').notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  userIdx: index('idx_user_activity_user').on(t.telegramUserId, t.createdAt),
}));

// ── Studio jobs mirror (Studio bridge contract — D1 is the queue of record;
// this table mirrors what PB needs: identity, params, script, cost/split,
// terminal state for settle/refund + user DMs). All times are plain unix-
// seconds integers per the contract (NOT the ts() timestamp mode), so tick
// push/pull cursor arithmetic stays exact. Extra PB-only columns beyond the
// D1 contract shape: brief (wizard/Mini App input the script was built
// from), included_part / purchased_part (the recorded entitlement split),
// pushed_at + push_state ('new' | 'pushed' | 'dirty') for the tick push.
export const studio_jobs = table('studio_jobs', {
  id: text('id').primaryKey(), // PB-minted `sj_` + 16 hex (Worker mints for discord)
  surface: text('surface').notNull().default('telegram'), // telegram | discord
  telegramUserId: text('telegram_user_id'),
  discordUserId: text('discord_user_id'),
  discordInteractionId: text('discord_interaction_id').unique(),
  discordChannelId: text('discord_channel_id'),
  status: text('status').notNull().default('pending'), // pending | script_ready | voice_ready | rendering | complete | failed | cancelled
  stage: text('stage'), // resolving_assets | building_timeline | encoding | validating | uploading | completing
  progress: integer('progress').notNull().default(0),
  vibe: text('vibe').notNull().default('hype'), // hype | professional | degen
  durationSec: integer('duration_sec').notNull().default(15),
  tokenName: text('token_name'),
  tokenSymbol: text('token_symbol'),
  tokenAddress: text('token_address'),
  tokenChain: text('token_chain'),
  logoUrl: text('logo_url'),
  mascot: integer('mascot').notNull().default(0), // 0/1 — PB ads only; third-party always 0
  brief: text('brief'),
  scriptText: text('script_text'),
  storyboardJson: text('storyboard_json'),
  costCredits: integer('cost_credits').notNull().default(0),
  fundsSource: text('funds_source'), // free_trial | included | purchased | mixed
  includedPart: integer('included_part').notNull().default(0),
  purchasedPart: integer('purchased_part').notNull().default(0),
  attemptId: text('attempt_id'),
  renderStartedAt: integer('render_started_at'),
  heartbeatAt: integer('heartbeat_at'),
  failureReason: text('failure_reason'),
  deliveryState: text('delivery_state').notNull().default('none'), // none | claimed | sent | failed | pending
  deliveryChatId: text('delivery_chat_id'),
  deliveryMessageId: text('delivery_message_id'),
  outputSize: integer('output_size'),
  outputDuration: integer('output_duration'), // REAL in D1; integer seconds here is enough for mirror display
  outputHash: text('output_hash'),
  outputName: text('output_name'),
  pushedAt: integer('pushed_at'),
  pushState: text('push_state').notNull().default('new'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_studio_jobs_user').on(t.telegramUserId, t.createdAt),
  statusIdx: index('idx_studio_jobs_status').on(t.status, t.pushState),
  discordIdx: index('idx_studio_jobs_discord').on(t.discordInteractionId),
}));

// ── Decision layer: one row per decide() call (see PB-DECISION-LAYER-DESIGN) ──
// The calibration asset: question-set version, typed answers + confidences,
// what the caller actually did, and ground truth when it arrives later.
// Rows are sealed per chat_id like every other community table; DM decisions
// carry chat_id = the actor's own id. state_json is a capped, allow-listed
// snapshot (never secrets, never raw message objects).
export const decision_log = table('decision_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  surface: text('surface').notNull(),          // nlcmd | skill_route | freechat | fud | sentiment | translate | business | tickets | repurpose | contests | whale
  questionSet: text('question_set').notNull(), // registry id, e.g. 'nl_intent'
  setVersion: integer('set_version').notNull(),
  chatId: text('chat_id'),                     // the one chat this decision concerns (sealing scope)
  actorId: text('actor_id'),                   // telegram user id the decision was about/for
  stateJson: json('state_json'),               // capped snapshot the model saw (set's stateCap)
  answersJson: json('answers_json'),           // { name: { type, value, confidence } }; null on failure
  layer: text('layer').notNull(),              // decide | code | brain | human — who actually decided
  modelUsed: text('model_used'),               // 'openrouter:…' / 'gemini:…'; null on failure
  shadow: boolean('shadow').notNull().default(false),
  actionTaken: text('action_taken'),           // caller's outcome: intent executed / incumbent used / escalated / fired / silent …
  groundTruth: text('ground_truth'),           // correct | wrong | partial | unknown — filled asynchronously
  outcomeNote: text('outcome_note'),
  latencyMs: integer('latency_ms'),
  estInputTokens: integer('est_input_tokens'), // estimated ceil(chars/4) — llm.js returns text only
  estOutputTokens: integer('est_output_tokens'),
  failureReason: text('failure_reason'),       // parse | transport | timeout | off; null on success
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  setTimeIdx: index('idx_decision_set_time').on(t.questionSet, t.createdAt),
  surfaceTimeIdx: index('idx_decision_surface_time').on(t.surface, t.createdAt),
  shadowIdx: index('idx_decision_shadow').on(t.shadow, t.createdAt),
}));

// ── Member campaigns (my-campaign — settled in wave-dash-10, built 2026-10-20) ──
// Port of the original user_campaigns / user_campaign_slots /
// campaign_channel_delivery_log (pb_dev_dump.sql), re-keyed from Clerk ids
// to Telegram ids. The original rows are NOT migrated: they are Clerk-keyed
// and no Clerk↔Telegram identity join exists (same call as mission state).
// One campaign per member (original upsert semantics). A slot is a posting
// target: a Telegram group the campaign OWNER admins (enforced in
// lib/campaigns.js via isChatAdmin at add time AND again at fire time) —
// community isolation: a campaign can only ever post into its owner's own
// groups. Telegram groups only in v1; no Discord execution path exists.
// Statuses: campaign 'active' | 'paused'; delivery outcomes live in the log.
export const user_campaigns = table('user_campaigns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerTelegramId: text('owner_telegram_id').notNull().unique(),
  projectName: text('project_name').notNull(),
  ticker: text('ticker').notNull(),
  description: text('description').notNull().default(''),
  website: text('website'),
  contractAddress: text('contract_address'),
  chain: text('chain').notNull().default('base'), // 'base' | 'sol'
  status: text('status').notNull().default('active'), // 'active' | 'paused'
  telegramUsername: text('telegram_username'),
  customButtons: json('custom_buttons').default([]), // [{name,url}] ≤3 (original)
  // Buy Bot (Phase 2, PB-BUYBOT-DESIGN §4.1): the original's per-campaign
  // buy_* column set (pb_dev_dump.sql buy-watcher ensureTables). The tick's
  // cycleBuyWatch reads these at fire time; the /manage Buy Bot panel
  // toggles enabled/paused.
  buyBotEnabled: boolean('buy_bot_enabled').notNull().default(false),
  buyBotPaused: boolean('buy_bot_paused').notNull().default(false),
  buyEmoji: text('buy_emoji').notNull().default('💸'),
  buyMinUsd: real('buy_min_usd').notNull().default(0.5),
  buyMediaFileId: text('buy_media_file_id'), // Telegram file_id; photo/animation/video
  buyMediaType: text('buy_media_type'),
  whaleThresholdUsd: real('whale_threshold_usd').notNull().default(500), // 0 disables whale treatment
  // Buy Bot Phase 3 (§9.2, BuyPop /setstep): one alert emoji per $step
  // bought. NULL = unset → the original's fixed $1→$5000 emoji bar.
  buyStepUsd: real('buy_step_usd'),
  // Buy Bot Phase 4 (§9.5): the KNOWN-WHALE badge threshold — the buyer's
  // total wallet balance (native + this token, USD). Distinct from
  // whaleThresholdUsd above (that one is the buy SIZE). NULL = badge off.
  buyWhaleBalanceUsd: real('buy_whale_balance_usd'),
  postIntervalOverride: integer('post_interval_override'), // minutes, pro+ only (original)
  totalPosts: integer('total_posts').notNull().default(0),
  tokenVerifiedAt: integer('token_verified_at', { mode: 'timestamp' }), // nullable, no default — null = not scanned yet
  verificationSummary: text('verification_summary'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  ownerIdx: index('idx_user_campaigns_owner').on(t.ownerTelegramId),
}));

export const user_campaign_slots = table('user_campaign_slots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  ownerTelegramId: text('owner_telegram_id').notNull(),
  targetChatId: text('target_chat_id').notNull(),
  targetTitle: text('target_title'),
  intervalMinutes: integer('interval_minutes'), // null → campaign override → 720 (12h, original default)
  customText: text('custom_text'),
  customButtons: json('custom_buttons'), // null → campaign buttons
  active: boolean('active').notNull().default(true),
  lastSentAt: integer('last_sent_at', { mode: 'timestamp' }), // nullable, no default — null = never posted
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  campaignIdx: index('idx_uc_slots_campaign').on(t.campaignId, t.active),
  ownerIdx: index('idx_uc_slots_owner').on(t.ownerTelegramId),
  targetIdx: index('idx_uc_slots_target').on(t.campaignId, t.targetChatId),
}));

export const campaign_delivery_log = table('campaign_delivery_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slotId: integer('slot_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: integer('message_id'),
  outcome: text('outcome').notNull(), // 'sent' | 'failed' | 'skipped_not_admin'
  detail: text('detail'),
  sentAt: ts('sent_at').notNull(),
}, (t) => ({
  slotIdx: index('idx_campaign_log_slot').on(t.slotId, t.sentAt),
}));

// ── Boost/Airdrop rebuild (2026-10-20; design: PB-BOOST-AIRDROP-DESIGN) ─────
// Money objects. Live-arm defaults OFF; Phase 2 ships NO broadcast code path —
// the planners persist dry-run intents only. Ciphertext columns hold
// AES-256-GCM material (lib/walletvault.js) and are never serialized to users.

// Pup Booster campaigns (source: booster_campaigns, commercial quote model).
// id: 'bc_' + 16 hex for port-native rows; 'legacy:<pgId>' for migrated history.
export const boost_campaigns = table('boost_campaigns', {
  id: text('id').primaryKey(),
  telegramUserId: text('telegram_user_id'), // null on legacy rows (Clerk-owned history)
  legacyOwner: text('legacy_owner'),
  legacyId: integer('legacy_id'),
  mode: text('mode').notNull().default('volume'), // volume | bump | mcap
  chain: text('chain').notNull().default('base'), // base | sol | rh
  tokenCa: text('token_ca'),
  tokenName: text('token_name'),
  tokenSymbol: text('token_symbol'),
  refundAddress: text('refund_address'),
  status: text('status').notNull().default('draft'),
  // draft | quoted | deposit_pending | deposit_generating | funded |
  // planned | awaiting_arm | executing | settling | completed | expired |
  // refund_pending | refunded | reconciliation_required | cancelled
  platformFeeUsd: text('platform_fee_usd'),
  discountUsd: text('discount_usd'),
  discountRate: text('discount_rate'),
  networkReserveUsd: text('network_reserve_usd'),
  workingCapitalUsd: text('working_capital_usd'),
  totalDueUsd: text('total_due_usd'),
  nativeUsd: text('native_usd'),
  totalDueNative: text('total_due_native'),
  platformFeeNative: text('platform_fee_native'),
  networkReserveNative: text('network_reserve_native'),
  workingCapitalNative: text('working_capital_native'),
  queuePriority: integer('queue_priority').notNull().default(40),
  feeTier: integer('fee_tier'),
  bumpPackage: text('bump_package'), // pulse | push | hold
  targetMcapMinUsd: text('target_mcap_min_usd'),
  targetMcapMaxUsd: text('target_mcap_max_usd'),
  quoteSig: text('quote_sig'),
  quoteIssuedAt: integer('quote_issued_at'),
  quoteExpiresAt: integer('quote_expires_at'),
  quoteConsumedAt: integer('quote_consumed_at'),
  depositAddress: text('deposit_address'),
  encryptedDepositPk: text('encrypted_deposit_pk'),
  depositAmountText: text('deposit_amount_text'),
  depositConfirmedAt: integer('deposit_confirmed_at'),
  feeSweptAt: integer('fee_swept_at'),
  feeCollectedText: text('fee_collected_text'),
  walletCount: integer('wallet_count').notNull().default(0),
  walletsDone: integer('wallets_done').notNull().default(0),
  cyclesDone: integer('cycles_done').notNull().default(0),
  amountReturnedText: text('amount_returned_text'),
  refundStatus: text('refund_status').notNull().default('not_requested'),
  refundAmountText: text('refund_amount_text'),
  resumePhase: text('resume_phase'),
  planJson: text('plan_json'), // dry-run execution plan (planner output)
  error: text('error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  userIdx: index('idx_boost_campaigns_user').on(t.telegramUserId, t.createdAt),
  statusIdx: index('idx_boost_campaigns_status').on(t.status),
}));

// ── Calendar slots (2026-11-01 calendar wave) ───────────────────────────────
// One shared booking table for BOTH products — a booster slot and an
// airdrop slot are never the same booking (product column separates
// them), and a booking is SCHEDULING ONLY: it never arms, funds, or
// executes a send. Booster execution still waits on its arm/executor
// gates; airdrop sends still wait on phase 2 + canary + gas. A slot that
// arrives while its product is still gated simply waits.
// MIGRATE REQUIRED before push: this table does not exist in production
// until `tgcloud migrate` creates it — push the schema change and
// migrate FIRST, then push the code that writes it.
export const product_calendar_bookings = table('product_calendar_bookings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  product: text('product').notNull(), // 'boost' | 'airdrop'
  campaignId: text('campaign_id').notNull(),
  telegramUserId: text('telegram_user_id').notNull(),
  tier: text('tier'), // tier snapshot at booking time, for paid-first ordering
  slotStart: integer('slot_start').notNull(), // epoch ms, UTC slot start
  slotLabel: text('slot_label'), // human label, e.g. 'Tue, Nov 3 · 12:00 UTC'
  status: text('status').notNull().default('active'), // active | cancelled
  createdAt: ts('created_at').notNull(),
  cancelledAt: integer('cancelled_at'),
}, (t) => ({
  productSlotIdx: index('idx_cal_product_slot').on(t.product, t.slotStart, t.status),
  campaignIdx: index('idx_cal_campaign').on(t.product, t.campaignId, t.status),
  userIdx: index('idx_cal_user').on(t.telegramUserId, t.status),
}));

// Booster burner wallets (source: booster_wallets). Migrated rows keep their
// original integer ids; port-native rows use ids above the migrated range.
export const boost_wallets = table('boost_wallets', {
  id: integer('id').primaryKey(),
  campaignRef: text('campaign_ref').notNull(), // boost_campaigns.id
  chain: text('chain').notNull().default('base'),
  address: text('address').notNull(),
  encryptedPk: text('encrypted_pk').notNull(),
  status: text('status').notNull().default('generated'),
  // generated | funding | funded | active | done | swept |
  // reconciliation_required | sweep_reconciliation_required
  fundedTx: text('funded_tx'),
  sweepTx: text('sweep_tx'),
  cycleTx: text('cycle_tx'),
  cycleAction: text('cycle_action'),
  cycleNonce: integer('cycle_nonce'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  campaignIdx: index('idx_boost_wallets_campaign').on(t.campaignRef, t.status),
}));

// Airdrop recipients (source: airdrop_recipients) — the persisted snapshot.
export const airdrop_recipients = table('airdrop_recipients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  campaignId: integer('campaign_id').notNull(),
  telegramUserId: text('telegram_user_id'),
  walletAddress: text('wallet_address').notNull(),
  amount: text('amount').notNull(), // decimal text, token units
  status: text('status').notNull().default('pending'), // pending | sending | sent | failed
  txHash: text('tx_hash'),
  sentAt: integer('sent_at'),
  recipientChain: text('recipient_chain'),
  dedupeSuppressed: boolean('dedupe_suppressed').notNull().default(false),
}, (t) => ({
  campaignIdx: index('idx_airdrop_recipients_campaign').on(t.campaignId, t.status),
  walletIdx: index('idx_airdrop_recipients_wallet').on(t.walletAddress),
}));

// Airdrop transfer intents (source: airdrop_recipient_transfers). Phase 2 rows
// are planner output: status 'planned' + deterministic plannedHash. The
// arm-phase broadcaster consumes intents; 'sending' never returns to 'pending'.
export const airdrop_transfers = table('airdrop_transfers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recipientId: integer('recipient_id').notNull(),
  campaignId: integer('campaign_id').notNull(),
  chain: text('chain').notNull(),
  status: text('status').notNull().default('planned'),
  // planned | intent | sending | sent | confirmed | deferred | recovery_required
  plannedHash: text('planned_hash'),
  txHash: text('tx_hash'),
  amountText: text('amount_text'),
  error: text('error'),
  // ── Airdrop Phase 2 (signer bridge): PB-side record of the signer
  // worker's outcome for this intent — NULL until first pushed, then
  // 'queued' | 'dry_run' | 'refused:<reason>' | 'failed' |
  // 'recovery_required' | 'confirmed' | 'already_executed'. The transfer
  // status itself moves only on real execution reports (DESIGN §3).
  signerOutcome: text('signer_outcome'),
  signerTxHash: text('signer_tx_hash'),
  signerReportedAt: integer('signer_reported_at'),
  broadcastAt: integer('broadcast_at'),
  confirmedAt: integer('confirmed_at'),
  reconciledAt: integer('reconciled_at'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  campaignIdx: index('idx_airdrop_transfers_campaign').on(t.campaignId, t.status),
  recipientIdx: index('idx_airdrop_transfers_recipient').on(t.recipientId),
}));

// Monthly airdrop tier-benefit usage (source: tierAirdropBenefit in
// airdrop-quote.ts — Builder $20 custom credit; Pro EITHER 1 Army Drop OR
// $40 custom credit, one shared counter; Agency fair-use Army + $0.02 rate).
export const airdrop_benefits = table('airdrop_benefits', {
  telegramUserId: text('telegram_user_id').notNull(),
  month: text('month').notNull(), // YYYY-MM (UTC)
  customCreditUsedCents: integer('custom_credit_used_cents').notNull().default(0),
  armyUsed: boolean('army_used').notNull().default(false),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.telegramUserId, t.month] }),
}));

// Welcome airdrop permanent address claims (source: welcome_airdrop_log).
// Address-level dedup: a row here defeats any future claim for that address,
// forever. Migrated rows: status 'sent' with their original tx hashes.
export const welcome_airdrop_claims = table('welcome_airdrop_claims', {
  walletAddress: text('wallet_address').primaryKey(), // normalized lowercase (EVM)
  telegramUserId: text('telegram_user_id'),
  status: text('status').notNull().default('claimed'), // claimed | broadcast | sent | failed_pre_broadcast
  txHash: text('tx_hash'),
  amountText: text('amount_text'),
  claimedAt: ts('claimed_at').notNull(),
  sentAt: integer('sent_at'),
});

// DexScreener boost observations (source: dex_boost_leads; writer was
// dexscreener-stream.ts). Market intel only — no funds, no people.
export const dex_boost_leads = table('dex_boost_leads', {
  id: integer('id').primaryKey(), // original ids preserved on migration
  tokenAddress: text('token_address').notNull(),
  chainId: text('chain_id').notNull(),
  leadType: text('lead_type').notNull().default('boost'),
  boostAmount: text('boost_amount'),
  totalAmount: text('total_amount'),
  description: text('description'),
  url: text('url'),
  icon: text('icon'),
  linksJson: text('links_json'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
}, (t) => ({
  tokenIdx: index('idx_dex_boost_leads_token').on(t.tokenAddress, t.chainId),
  seenIdx: index('idx_dex_boost_leads_seen').on(t.lastSeenAt),
}));

// ── Autonomous Worker Stage 1: Lead Finder (2026-10-20) ─────────────────────
// Worked lead pipeline on top of the raw dex_boost_leads observations.
// One row per prospect, deduped on dedupe_key (UNIQUE): token leads key on
// "chain:address", X-intent leads on "x:handle", group surface leads on
// "group:chatId". status: 'new' (above threshold, awaiting digest) |
// 'digested' | 'raw' (below threshold or already-known seed token — kept
// for dedupe only, never digested) | 'dismissed' | 'do_not_contact' |
// 'contacted' | 'won'. Stage 1 writes ONLY new/digested/raw. 'dismissed'
// and 'do_not_contact' are durable owner-set suppression DATA: an upsert
// on re-sighting never resurrects them, and any future stage must honor
// them. ('contacted'/'won' exist for a later stage; nothing writes them.)
//
// OWNER RULE — NO SPAM, EVER (Rowdy, 2026-10-20): PB never mass-blasts.
// Stage 1 has NO outreach at all (find + score + report only, no send
// paths to leads exist). Any future outreach stage is bound by the rule:
// selective, targeted, relevant, low-volume, one-shot — never uninvited
// into communities PB serves, inbound-first.
// Times are plain unix-seconds integers, matching dex_boost_leads.
export const pb_leads = table('pb_leads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // dex_boost | dex_new | x_intent | pb_surface
  projectName: text('project_name'),
  tokenAddress: text('token_address'),
  chainId: text('chain_id'),
  xHandle: text('x_handle'),
  telegramHandle: text('telegram_handle'),
  signalText: text('signal_text'),
  signalUrl: text('signal_url'),
  score: integer('score').notNull().default(0),
  serviceFit: text('service_fit').notNull().default('multi'), // airdrop | boost | studio | bot_subscription | multi
  status: text('status').notNull().default('new'),
  dedupeKey: text('dedupe_key').notNull().unique(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
}, (t) => ({
  statusScoreIdx: index('idx_pb_leads_status_score').on(t.status, t.score),
  sourceIdx: index('idx_pb_leads_source').on(t.source),
}));

// ── Sales leg (2026-11-05, Rowdy: turn hot leads into paid campaigns) ──────
// One row per sale. The leg sells Custom List airdrops + Booster only
// (Army has no price; Plan/packs are planbuy's). The payment step is gated
// by the sales_leg_live config flag (unset = gated). No XRocket anywhere:
// fees settle through the existing on-chain matcher (airdrop) / deposit
// check (booster). receipt_sent_at is set once, when the itemized owner
// receipt goes out — the sender checks it first, so a sale is receipted
// exactly once even if the confirm path runs twice.
export const sales = table('sales', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  buyerTelegramId: text('buyer_telegram_id').notNull(),
  leadId: integer('lead_id'),
  service: text('service').notNull(), // airdrop_custom | boost_volume | boost_bump | boost_mcap
  campaignKind: text('campaign_kind').notNull(), // airdrop | boost
  campaignId: text('campaign_id'),
  feeUsd: text('fee_usd').notNull(), // TEXT on purpose: exact USD at quote time, never re-derived
  status: text('status').notNull().default('qualifying'), // qualifying | quoted | pending_owner | awaiting_payment | paid | receipt_sent | declined | expired
  specHash: text('spec_hash').notNull(), // buyer+service+spec digest — one live sale per hash (idempotency)
  txHash: text('tx_hash'),
  receiptSentAt: integer('receipt_sent_at', { mode: 'timestamp' }),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  buyerServiceIdx: index('idx_sales_buyer_service').on(t.buyerTelegramId, t.service),
  statusCreatedIdx: index('idx_sales_status_created').on(t.status, t.createdAt),
  campaignIdx: index('idx_sales_campaign').on(t.campaignKind, t.campaignId),
}));

// Legacy booster entitlements (source: booster_grants + booster_packs).
// PRESERVE-ONLY: Clerk-keyed, no telegram link in the rescued data. Never
// auto-activated; honoring one is Rowdy's per-holder call (design §7.6).
export const boost_legacy_entitlements = table('boost_legacy_entitlements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // grant | pack
  legacyId: integer('legacy_id').notNull(),
  clerkUserId: text('clerk_user_id'),
  label: text('label'),
  detailJson: text('detail_json'),
  status: text('status').notNull().default('preserved'),
  createdAt: ts('created_at').notNull(),
});

// ── Buy Bot (Phase 1, 2026-10-21 — PB-BUYBOT-DESIGN §4.1/§6.1) ───────────────
// buy_events: the ported buy_alerts_log, extended into the shared event
// store buy competitions will read (design §5). One row per DETECTED
// qualifying buy per target chat. UNIQUE(tx_hash, chat_id) makes dedupe a
// constraint, not a hope: a replayed GT trades window can never produce a
// second alert for the same buy in the same chat. campaignId is null for
// the home $PBAI watch; member-campaign rows carry their campaignId
// (Phase 2, 2026-10-21 — the seven buy columns on user_campaigns above).
// created_at is plain unix SECONDS (the trade's block time), matching
// pb_leads, so 24h stats + competition windows are simple range scans.
export const buy_events = table('buy_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ca: text('ca').notNull(), // token address (lowercased on EVM; verbatim base58 on Solana)
  chain: text('chain').notNull().default('base'),
  chatId: text('chat_id').notNull(),
  campaignId: integer('campaign_id'), // null = home watch
  txHash: text('tx_hash').notNull(),
  buyerAddress: text('buyer_address'),
  usdAmount: real('usd_amount').notNull().default(0),
  tokAmount: real('tok_amount').notNull().default(0),
  isWhale: boolean('is_whale').notNull().default(false),
  createdAt: integer('created_at').notNull(), // unix seconds
}, (t) => ({
  txChatUq: unique('uq_buy_events_tx_chat').on(t.txHash, t.chatId),
  chatTimeIdx: index('idx_buy_events_chat_time').on(t.chatId, t.createdAt),
  caTimeIdx: index('idx_buy_events_ca_time').on(t.ca, t.createdAt),
}));

// buy_watch_state: one row per watched token — the DB replacement for the
// original watchers' in-memory state (isolates keep nothing between runs).
// lastBlock is the watermark: only trades with block_number > lastBlock are
// fresh. Watermark + the buy_events UNIQUE constraint together give
// exactly-once alerting across isolate restarts.
export const buy_watch_state = table('buy_watch_state', {
  ca: text('ca').primaryKey(), // token address (lowercased on EVM; Solana base58 is case-sensitive and stored verbatim)
  chain: text('chain').notNull().default('base'),
  poolAddress: text('pool_address'),
  symbol: text('symbol'),
  lastBlock: integer('last_block').notNull().default(0),
  lastTradeAt: integer('last_trade_at').notNull().default(0), // unix seconds
  priceUsd: real('price_usd'),
  mcapUsd: real('mcap_usd'),
  resolvedAt: integer('resolved_at').notNull().default(0), // unix seconds
  // Buy Bot §9.6/§9.4 wave (2026-10-21) — graduation + ATH milestones.
  // All additive + nullable: a NULL pool_dex means "not classified yet";
  // pool_curve is the classification verdict (1 = bonding curve,
  // 0 = DEX pool, NULL = unknown) captured WITH the dex id so a curve
  // whose dex id is new to us still classifies via GeckoTerminal's
  // launchpad_details. graduated_at is the durable exactly-once marker.
  poolDex: text('pool_dex'), // GT dex id of pool_address (e.g. 'pump-fun', 'pumpswap')
  poolCurve: integer('pool_curve'), // 1 curve / 0 DEX / NULL unknown — verdict for pool_address
  prevPoolCurve: integer('prev_pool_curve'), // verdict of the pool replaced at an as-yet-unclassified switch (classification-failure bridge)
  graduatedAt: integer('graduated_at'), // unix seconds — set once, before the celebration sends
  // ATH tracking: ath_price_usd ratchets to every new observed max;
  // ath_celebrated_usd/at are the anchor + stamp of the last ATH
  // celebration (the ≥2% + 1h-cooldown gate reads them).
  athPriceUsd: real('ath_price_usd'),
  athAt: integer('ath_at'),
  athCelebratedUsd: real('ath_celebrated_usd'),
  athCelebratedAt: integer('ath_celebrated_at'),
});

// buy_whale_cache (Buy Bot Phase 4, §9.5): per-wallet balance cache for
// the known-whale badge. The balance lookup (public RPC reads) is the
// expensive path BY DESIGN — one row per (chain, wallet), refreshed at
// most every BUY_WHALE_CACHE_TTL_SEC (lib/tick.js). balance_usd NULL =
// the last lookup FAILED (native balance or its price unreadable); a
// failed row suppresses retries for the shorter fail TTL, then the next
// buy retries. The number is a public on-chain balance — it carries no
// per-group data, so one row serves every chat (sealing unaffected).
export const buy_whale_cache = table('buy_whale_cache', {
  chain: text('chain').notNull(), // 'base' | 'sol'
  wallet: text('wallet').notNull(), // lowercased on EVM; verbatim base58 on Solana
  balanceUsd: real('balance_usd'), // NULL = last lookup failed
  checkedAt: integer('checked_at').notNull().default(0), // unix seconds
}, (t) => ({
  pk: primaryKey({ columns: [t.chain, t.wallet] }),
}));

// buy_competitions (Buy Bot Phase 5, 2026-10-21 — PB-BUYBOT-DESIGN §5):
// Bubble-style buy competitions over buy_events. An admin sets a prize
// (TEXT ONLY — the project chooses and distributes prizes; PB never
// holds or moves funds here, the contests MONEY RULE), a minimum
// qualifying buy and a duration. Qualifying buys are the buy_events
// rows for this chat + token (+ campaign) inside [start_at, end_at)
// at/above min_buy_usd: kind 'biggest' = the single largest qualifying
// buy wins; kind 'raffle' = one ticket per qualifying buy row, one
// ticket drawn at finalisation. The winning buy IS the proof record:
// winner_tx_hash points at the buy_events row that won (for raffle,
// the drawn ticket). start_at/end_at are plain unix SECONDS, matching
// buy_events.created_at, so window scans are simple range checks.
// status: 'active' → 'ended' (finalised, winner recorded) |
// 'cancelled' (an admin retired it — no announcement). The status
// transition is the finalise gate: the tick cycle only ever selects
// 'active' rows, so a competition can never finalise twice.
// ca is stored exactly as buy_events.ca carries it (lowercased on EVM;
// verbatim base58 on Solana — the Phase 4 casing rule).
export const buy_competitions = table('buy_competitions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  campaignId: integer('campaign_id'), // the campaign the /manage panel resolved; scoring also matches buy_events.campaign_id
  ca: text('ca').notNull(),
  kind: text('kind').notNull().default('biggest'), // 'biggest' | 'raffle'
  minBuyUsd: real('min_buy_usd').notNull().default(0),
  prizeText: text('prize_text'),
  startAt: integer('start_at').notNull(), // unix seconds
  endAt: integer('end_at').notNull(), // unix seconds
  status: text('status').notNull().default('active'), // 'active' | 'ended' | 'cancelled'
  winnerAddress: text('winner_address'),
  winnerTxHash: text('winner_tx_hash'),
  createdBy: text('created_by'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  chatStatusIdx: index('idx_buy_competitions_chat_status').on(t.chatId, t.status),
  dueIdx: index('idx_buy_competitions_due').on(t.status, t.endAt),
}));

// trending_votes (Trending votes + rank power, 2026-10-21 — Skeleton
// Price Bot benchmark): one row per CAST vote. A member's vote counts
// once per token per rolling 24h window — the window is enforced in
// the store layer (lib/xp.js castVote) because a UNIQUE constraint
// cannot express a rolling window. weight is the voter's rank power
// AT CAST TIME (rank index + 1 → 1..8; 8 = PoorBoy Legend, or the
// holder fast-track), snapshotted so later rank changes never rewrite
// history. chat_id records the origin group for the per-group rank
// context and dedupe audit ONLY — it is never selected by any board
// query (community sealing: boards publish tokens + aggregates,
// never which community produced them). ca follows the buy_events
// casing rule (lowercased on EVM; verbatim base58 on Solana).
// created_at is plain unix SECONDS, matching buy_events.
export const trending_votes = table('trending_votes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  chatId: text('chat_id').notNull(),
  ca: text('ca').notNull(),
  chain: text('chain').notNull().default('base'), // 'base' | 'sol'
  symbol: text('symbol'), // resolved at cast time, best effort
  weight: integer('weight').notNull(), // 1..8 rank power snapshot
  fastTrack: boolean('fast_track').notNull().default(false),
  createdAt: integer('created_at').notNull(), // unix seconds
}, (t) => ({
  userCaIdx: index('idx_trending_votes_user_ca').on(t.userId, t.ca, t.createdAt),
  caTimeIdx: index('idx_trending_votes_ca_time').on(t.ca, t.createdAt),
}));

// ── Buy Rewards campaign (2026-10-21 — PB-BUYREWARDS-SPEC §10) ─────────────
// Daily ladder + lucky-draw rewards over home-pool $PBAI buys (buy_events),
// paid through ONE ordinary airdrop campaign per batched day from a standing
// deposit wallet. buy_rewards_days is one row per America/Los_Angeles day in
// a run and doubles as the batch lock + the draw's verification record;
// buy_rewards_ledger is one row per (day, buy) for ladder bonuses plus one
// prize row per day (carrying the winning buy's event id, kind='prize').
// USD columns are REAL (matching buy_events); token amounts are TEXT decimal
// strings (matching airdrop_recipients) — the ledger's bonus_pbai string is
// the exact figure that flows into the recipient row, transfer and claim.
export const buy_rewards_days = table('buy_rewards_days', {
  dayKey: text('day_key').primaryKey(), // YYYY-MM-DD (America/Los_Angeles)
  status: text('status').notNull().default('batching'), // batching | batched | no_buys | unfunded | deferred | payout_issue
  qualifyingBuys: integer('qualifying_buys').notNull().default(0),
  entries: integer('entries').notNull().default(0), // draw entries (= qualifying buys)
  eligibleEntries: integer('eligible_entries').notNull().default(0), // after the holding filter
  uniqueWallets: integer('unique_wallets').notNull().default(0),
  ladderUsd: real('ladder_usd').notNull().default(0), // total ladder paid (post-clip, post-cap)
  prizeUsd: real('prize_usd').notNull().default(0), // 2.00 or 0
  totalPbai: text('total_pbai'), // Σ recipient amounts (decimal string)
  drawPriceUsd: real('draw_price_usd'), // GT price used for the prize
  seedBlock: integer('seed_block'), // first Base block at/after day close
  seedHash: text('seed_hash'),
  winnerWallet: text('winner_wallet'),
  winnerBuyTx: text('winner_buy_tx'), // the winning entry's buy tx hash
  drawEntries: json('draw_entries'), // ordered eligible entry tx hashes (verification record)
  campaignId: integer('campaign_id'), // the payout airdrop campaign
  announced: integer('announced').notNull().default(0), // winner post sent (0/1)
  batchedAt: integer('batched_at'), // unix seconds — last batch attempt / batch time
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const buy_rewards_ledger = table('buy_rewards_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dayKey: text('day_key').notNull(),
  wallet: text('wallet').notNull(), // lowercased buyer
  buyEventId: integer('buy_event_id'), // buy_events.id; the prize row carries the winning buy's id
  buyTxHash: text('buy_tx_hash'),
  kind: text('kind').notNull().default('ladder'), // ladder | prize
  buyUsd: real('buy_usd'), // the buy's USD (ladder rows)
  tierBps: integer('tier_bps'), // 1000 / 2000 / 3500 actually applied
  bonusUsd: real('bonus_usd'), // post-clip USD value
  bonusPbai: text('bonus_pbai'), // decimal string — the exact recipient amount
  status: text('status').notNull().default('accrued'), // accrued | forfeited_cap | forfeited_sold | forfeited_balance | deferred | queued | paid | unpaid_failed
  forfeitReason: text('forfeit_reason'),
  campaignId: integer('campaign_id'),
  recipientId: integer('recipient_id'),
  paidTxHash: text('paid_tx_hash'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  dayBuyUq: unique('uq_buy_rewards_day_buy').on(t.dayKey, t.buyEventId, t.kind),
  dayWalletIdx: index('idx_buy_rewards_day_wallet').on(t.dayKey, t.wallet),
  statusIdx: index('idx_buy_rewards_status').on(t.status),
}));

// ── DM broadcast jobs (owner DM blast, restored 2026-10-21) ──────────────────
// The original Replit bot's /broadcast DMed every bot_users row; the
// serverless port re-targeted broadcasts at groups only (lib/broadcastcmds.js
// PORT DEVIATIONS). These two tables back the restored DM mode: a job row
// (the confirmed announcement + lifecycle) and one recipient row per
// snapshotted bot user, claimed atomically by the tick's dmBroadcast cycle
// so overlapping runs can never double-send. No foreign keys (platform).
export const dm_broadcast_jobs = table('dm_broadcast_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  text: text('text').notNull(),
  status: text('status').notNull().default('running'), // running | stopped | done
  total: integer('total').notNull().default(0),
  sentCount: integer('sent_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  createdBy: text('created_by').notNull(), // owner telegram id (receipt goes here)
  receiptSent: boolean('receipt_sent').notNull().default(false),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
}, (t) => ({
  statusIdx: index('idx_dmb_jobs_status').on(t.status),
}));

export const dm_broadcast_recipients = table('dm_broadcast_recipients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull(),
  telegramUserId: text('telegram_user_id').notNull(),
  status: text('status').notNull().default('queued'), // queued | sending | sent | failed
  failClass: text('fail_class'), // permanent | retryable (set when status = failed)
  attempts: integer('attempts').notNull().default(0),
  claimToken: text('claim_token'), // set while status = sending; encodes claim time
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  jobStatusIdx: index('idx_dmb_recips_job_status').on(t.jobId, t.status),
  jobIdIdx: index('idx_dmb_recips_job_id').on(t.jobId, t.id),
}));

// ── PB Relay (consent-based channel/group auto-forwarder, 2026-10-21) ──────
// PB-RELAY-SPEC §7. A rule (one source chat → N destination chats, owned by
// one user, tier-gated via TIER_LIMITS.relayRules) copies each new source
// post into its destinations — but only across chats the owner admins
// (consent Path A; Path B Cross-Protect links land in Wave 3). Rules are
// per-user multi-destination entities, so they get their own tables rather
// than group_settings (the DM broadcast call, spec §1.2). Deliveries are
// the engine's queue + dedupe ledger + the source→destination message-id
// map (destMsgId) that Wave 4 edit-mirroring will read. No foreign keys.
export const relay_rules = table('relay_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerId: text('owner_id').notNull(), // telegram user id (accountable owner)
  name: text('name'),
  sourceChatId: text('source_chat_id').notNull(),
  sourceTitle: text('source_title'),
  sourceKind: text('source_kind').notNull().default('group'), // channel | group | supergroup
  // Group-source scope: 'admins' (default — only admin/anonymous posts
  // relay) | 'all' (per-rule opt-in: every non-command post relays).
  scope: text('scope').notNull().default('admins'),
  status: text('status').notNull().default('active'), // active | paused_owner | paused_tier | paused_consent | paused_source_lost | deleted
  attribution: text('attribution').notNull().default('copy'), // copy | forward
  filtersJson: json('filters_json'), // Wave 2 filter chain (spec §4.2b)
  cleanJson: json('clean_json'), // Wave 2 auto-clean (spec §4.2c)
  brandingJson: json('branding_json'), // Wave 2 footer (spec §4.2d)
  relayedCount: integer('relayed_count').notNull().default(0), // cache — delivery rows are truth
  filteredCount: integer('filtered_count').notNull().default(0),
  cleanedCount: integer('cleaned_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  lastRelayAt: integer('last_relay_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  ownerIdx: index('idx_relay_rules_owner').on(t.ownerId, t.status),
  sourceIdx: index('idx_relay_rules_source').on(t.sourceChatId, t.status),
}));

export const relay_rule_destinations = table('relay_rule_destinations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ruleId: integer('rule_id').notNull(),
  destChatId: text('dest_chat_id').notNull(),
  destTitle: text('dest_title'),
  consentMode: text('consent_mode').notNull().default('owner_admin'), // owner_admin (Path A) | cp_link (Path B, Wave 3)
  status: text('status').notNull().default('active'), // active | paused | dead
  // Wave 3: why a 'paused' destination waits — relaystop (a destination
  // admin revoked it; only that side can re-consent) | failure (the
  // failure lifecycle auto-paused it) | consent (Path B link or Path A
  // admin proof lapsed). Owner resume re-validates + reactivates
  // 'failure'/'consent'; 'relaystop' needs the destination side.
  pauseReason: text('pause_reason'),
  failCount: integer('fail_count').notNull().default(0), // consecutive failures; reset on success
  nextRetryAt: integer('next_retry_at', { mode: 'timestamp' }), // 429 back-off stamp (spec §9.2)
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  ruleIdx: index('idx_relay_dests_rule').on(t.ruleId, t.status),
  destUq: unique('uq_relay_dests_rule_dest').on(t.ruleId, t.destChatId),
}));

export const relay_deliveries = table('relay_deliveries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ruleId: integer('rule_id').notNull(),
  destId: integer('dest_id'), // relay_rule_destinations.id; NULL on the per-post 'filtered' record
  destChatId: text('dest_chat_id'), // denormalized: the own-copy loop guard reads it (spec §9.5)
  sourceChatId: text('source_chat_id').notNull(),
  sourceMsgId: integer('source_msg_id').notNull(),
  mediaGroupId: text('media_group_id'), // album staging key (Wave 2)
  status: text('status').notNull().default('queued'), // staging | queued | sending | sent | filtered | failed | dead
  filterReason: text('filter_reason'), // protected (W1) | media_type | link_block | keyword | no_allow_match | cleaned_empty (W2)
  // Wave 2 send plan, computed at intake (the drain can't re-read the
  // source post — the Bot API has no getMessage): { kind: 'text'|'media'|
  // 'album', text?, caption?, media?: {type, fileId}, footer? }. NULL on
  // W1-era rows (plain copyMessage, byte-faithful).
  payloadJson: json('payload_json'),
  destMsgId: integer('dest_msg_id'), // the copy's id in the destination — the Wave 4 edit-mirror key
  cleaned: boolean('cleaned').notNull().default(false),
  claimToken: text('claim_token'), // drain claim (broadcast idiom)
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  // The dedupe guarantee (spec §9.5): one delivery per (rule, source
  // post, destination). NULL destId (filtered records) stays exempt —
  // SQLite treats NULLs as distinct; code writes at most one per post.
  dedupeUq: unique('uq_relay_deliveries_dedupe').on(t.ruleId, t.sourceChatId, t.sourceMsgId, t.destId),
  statusIdx: index('idx_relay_deliveries_status').on(t.status, t.createdAt),
  ruleIdx: index('idx_relay_deliveries_rule').on(t.ruleId, t.createdAt),
  destMsgIdx: index('idx_relay_deliveries_dest_msg').on(t.destChatId, t.destMsgId),
}));

// ── LLM borrowed-credit ledger (Free-Ladder W1, spec PB-FREE-LADDER-SPEC §7) ─
// One row per ladder attempt written by the routing wrapper in lib/llm.js:
// who served the call, what it would have cost on the paid reference route,
// what it actually cost. Bot-side store (consumer='bot'); the Studio worker
// keeps its own store in the same shape (W2). ts is raw unix SECONDS (the
// spec field), distinct from the mode-'timestamp' createdAt beside it.
export const llm_ledger = table('llm_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(), // unix seconds (spec §7)
  surface: text('surface').notNull(), // chat | decide | bulk
  consumer: text('consumer').notNull().default('bot'),
  jobId: text('job_id'), // bot chat calls carry no job id (NULL)
  tier: text('tier').notNull().default('standard'), // standard | internal
  provider: text('provider').notNull(), // xai | gemini | groq | workersai | openrouter
  model: text('model').notNull(),
  rungReason: text('rung_reason').notNull(), // primary | failover
  units: integer('units').notNull().default(0), // est. total tokens (unitType 'tokens')
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  unitType: text('unit_type').notNull().default('tokens'),
  estPaidEquivUsd: real('est_paid_equiv_usd').notNull().default(0),
  actualCostUsd: real('actual_cost_usd').notNull().default(0),
  priceBookVersion: text('price_book_version').notNull(),
  trainsOnInputs: boolean('trains_on_inputs').notNull().default(false),
  outcome: text('outcome').notNull(), // ok | error | quota_exhausted
  latencyMs: integer('latency_ms').notNull().default(0),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  tsIdx: index('idx_llm_ledger_ts').on(t.ts),
  providerIdx: index('idx_llm_ledger_provider').on(t.provider, t.ts),
}));

// ── Master-wallet spend ledger (masterspend wave, 2026-10-22) ──────────────
// One row per masterSpend() invocation that passed basic shape checks
// (lib/moneyguard.js): refusals are rows too (status 'refused' + reason),
// so the ledger is the complete audit trail of what the capped engine
// was asked to do and what it did. A send writes its row as 'pending'
// BEFORE signing; the row is then finalized to 'sent'/'confirmed' with
// the tx hash, or 'failed' with the stage's reason. The rolling-24h
// daily cap sums amount_usd over pending/sent/confirmed rows. NO key
// material ever lands here — amounts, addresses, purposes only.
export const master_spend_ledger = table('master_spend_ledger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  purpose: text('purpose').notNull(), // welcome_drop | xp_cashout | admin_drop | deposit_gas_float | seed_gas_recovery | treasury_distribution
  chain: text('chain').notNull().default('base'),
  asset: text('asset').notNull(), // 'native' | token contract address (lowercase)
  toAddress: text('to_address').notNull(),
  amountText: text('amount_text').notNull(), // decimal string in asset units
  amountUsd: real('amount_usd').notNull().default(0), // valued at decision time
  usdPrice: real('usd_price'), // unit price used (null on pre-valuation refusals)
  status: text('status').notNull(), // pending | sent | confirmed | refused | failed
  refusalReason: text('refusal_reason'),
  txHash: text('tx_hash'),
  initiatedBy: text('initiated_by'), // telegram id, or 'system:<caller>'
  detail: text('detail'), // short caller note (e.g. campaign=<id>) — never secrets
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  createdIdx: index('idx_master_spend_created').on(t.createdAt),
  statusIdx: index('idx_master_spend_status').on(t.status),
}));

// ── Command-error capture (Watchdog wave, 2026-10-22) ─────────────────────
// One row per error that escapes to the top level of the message /
// callback_query handlers (lib/groups.js captureCommandError, fail-open).
// Deliberately content-free: the command NAME or callback PREFIX only —
// never message text, args, or any user content — plus the error's class
// (err.name, with the Bot API code appended when present, e.g.
// 'BotApiError:403'). ts is raw unix SECONDS (llm_ledger precedent).
// Read by the owner-gated health snapshot (getDashboard 'healthSnapshot').
export const command_errors = table('command_errors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(), // unix seconds
  chatId: text('chat_id'), // chat the update concerned; null when unknown
  surface: text('surface').notNull(), // message | callback
  label: text('label').notNull(), // command name | callback prefix | 'message' | 'callback'
  errorClass: text('error_class').notNull(), // err.name (+ ':code' for BotApiError)
}, (t) => ({
  tsIdx: index('idx_command_errors_ts').on(t.ts),
  surfaceIdx: index('idx_command_errors_surface').on(t.surface, t.ts),
}));

// ── Signal Inlet audit log (Superpower Sweep wave, 2026-10-23) ──────────────
// One row per inlet delivery attempt that resolved to a group (accepted,
// rate-limited, killed, or send-failed) — written by lib/groups.js
// processSignalInlet. Deliberately content-free: the group, a unix-second
// timestamp, the payload's SHA-256 (never the raw payload), a short title
// label (operator-supplied alert name, capped in code), the outcome, and
// the Telegram message id when a card landed. Unattributable attempts
// (unknown secret) write NO row — there is no group to seal them to.
// Sealed per chat like every other table: readers must filter by chatId.
export const signal_inlet_log = table('signal_inlet_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  ts: integer('ts').notNull(), // unix seconds
  payloadHash: text('payload_hash').notNull(), // sha256 hex of the canonical payload
  title: text('title'), // operator-supplied alert name, ≤120 chars in code
  status: text('status').notNull(), // sent | send_failed | rate_limited | killed | disabled | rejected
  messageId: integer('message_id'), // Telegram message id when the card landed
}, (t) => ({
  chatTsIdx: index('idx_signal_inlet_log_chat_ts').on(t.chatId, t.ts),
}));

// ── Guarded autonomous X loop audit log (X-loop wave, 2026-10-23) ─────────
// One row per loop decision that touched (or refused to touch) X: sends
// with their tweet id, and every drop/skip with its reason — the loop's
// complete audit trail (lib/repurpose.js cycleXLoop). text is PB's OWN
// outbound copy (public by definition once sent; queued/milestone text
// is the owner's or PB's own words), capped in code. Statuses:
// sent | failed | dropped_overlength | dropped_guard | dropped_duplicate
// | dropped_overflow | dropped_failed | dropped_spam | skipped_budget
// | skipped_killswitch | skipped_self | skipped_repeat_author
// | skipped_empty.
export const x_loop_log = table('x_loop_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(), // unix seconds
  kind: text('kind').notNull(), // queue | milestone | reply
  status: text('status').notNull(),
  tweetId: text('tweet_id'), // X id of the sent post (status 'sent')
  inReplyTo: text('in_reply_to'), // mention tweet id a reply answered
  authorId: text('author_id'), // X user id (replies: the mention author)
  text: text('text'), // the post text (≤280) or the dropped draft
  detail: text('detail'), // milestone key / queue id / skip reason detail
}, (t) => ({
  tsIdx: index('idx_x_loop_log_ts').on(t.ts),
  kindTsIdx: index('idx_x_loop_log_kind_ts').on(t.kind, t.ts),
}));

// ── Telegram ↔ Discord mirror queue (Mirror wave, 2026-10-23) ─────────────
// One row per relayable member message in the single approved pair:
// Telegram home group -1003931169299 ↔ Discord #general-chat. This table is
// the mirror's queue AND its dedupe map AND its rate counter — three jobs,
// one table, so no second store can disagree with it:
//   · tg_dc rows are written PENDING by the Telegram message hook
//     (lib/relay.js mirrorGroupHook) and claimed DONE by the mirror daemon
//     after it posts them to Discord (mirrorAckAction).
//   · dc_tg rows are written DONE (or DEAD on a logged drop) by the relay
//     endpoint the moment it sends (or refuses) to Telegram — the daemon
//     never re-offers an id that already has a row here.
// The (direction, source_msg_id) unique key is the loop/dup backstop: a
// relayed message re-entering either side resolves to a row that already
// exists, so it can never be queued or sent twice. Deliberately NOT
// cross_comm_bridges: that table stays at 0 active rows (watchdog
// invariant); the mirror owns its own state. Payloads are member chat
// text only (≤4000 chars) or a media-kind placeholder — never files.
// Statuses: pending | done | dead. attempts counts failed Discord posts
// (tg_dc) before a row is declared dead (3 strikes).
export const mirror_queue = table('mirror_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  direction: text('direction').notNull(), // tg_dc | dc_tg
  sourceMsgId: text('source_msg_id').notNull(), // Telegram int id / Discord snowflake, as text
  sourceSender: text('source_sender'), // display name at intake (attribution)
  text: text('text'), // member text/caption (NULL on media placeholders)
  mediaKind: text('media_kind'), // photo | video | sticker | file | audio | voice | gif | NULL
  status: text('status').notNull().default('pending'), // pending | done | dead
  attempts: integer('attempts').notNull().default(0),
  destMsgId: text('dest_msg_id'), // relayed message id on the far side
  detail: text('detail'), // drop/failure reason (rate | stale | marker | command | bot | send_failed …)
  tsSec: integer('ts_sec').notNull(), // unix seconds (rate window + staleness, same idiom as x_loop_log.ts)
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  dedupeUq: unique('uq_mirror_queue_dedupe').on(t.direction, t.sourceMsgId),
  statusIdx: index('idx_mirror_queue_status').on(t.status, t.tsSec),
  dirTsIdx: index('idx_mirror_queue_dir_ts').on(t.direction, t.tsSec),
}));

// ── Group daily rollup (group report wave 2026-10-24) ─────────────────────
// One row per chat per LA-calendar day. Written by the message-hook sites
// in handlers/message.js via lib/groupmsg.js tallyRollup(); read by the
// /report card builder. Additive only. Day keys are 'YYYY-MM-DD' strings
// (America/Los_Angeles) so chart windows never depend on ts() units.
// A day with no row means "no data yet" — never zero-filled by the writer;
// the card renders pre-launch days as gaps, not zeros. NOTE: schema sync
// is separate from push (see project AGENTS.md) — this table lands only
// when `tgcloud migrate` runs; all readers fail-open until then.
export const group_daily_rollup = table('group_daily_rollup', {
  chatId: text('chat_id').notNull(),
  day: text('day').notNull(), // YYYY-MM-DD, America/Los_Angeles
  messages: integer('messages').notNull().default(0),
  joins: integer('joins').notNull().default(0),
  leaves: integer('leaves').notNull().default(0),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  chatDayUq: unique('uq_group_daily_rollup_chat_day').on(t.chatId, t.day),
  chatIdx: index('idx_group_daily_rollup_chat').on(t.chatId, t.day),
}));

// ── Second Brain S1 — Temporal decision memory (PB-SECOND-BRAIN-SPEC §2) ──
// Build preparation ONLY (2026-10-24): this table lands in the live D1
// only when `tgcloud migrate` runs; all readers fail-open until then.
// Sibling, NOT an extension, of decision_log: decision_log stays the
// flip gate's calibration asset (typed answers, scored agreement); this
// table holds narrative decisions — prose reasoning, evidence links, and
// supersession chains. Never merge the two; never write decision_log
// rows from this wave. FTS5: the platform DSL has no virtual-table
// declaration, so the FTS5 index is NOT a schema table — lib/decide.js
// ensureDecisionMemoryFts() creates decision_memory_fts (external-content
// FTS5 over title/decision/reasoning) lazily at first write/read, and
// retrieval falls back to LIKE when that creation is unavailable. The
// main table below is the migrate artifact; the FTS index is runtime.
export const decision_memory = table('decision_memory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scope: text('scope').notNull(), // owner | project | group
  chatId: text('chat_id'), // seal: required for scope='group'; DM rows carry the actor's own id (decision_log convention)
  actorId: text('actor_id'), // telegram id of the decider (owner id for owner/project rows)
  topicKey: text('topic_key').notNull(), // normalized slug: 'launch-fee'
  title: text('title').notNull(), // one line
  decision: text('decision').notNull(), // what was decided (capped ~1,000 chars in code)
  reasoning: text('reasoning'), // WHY (capped ~2,000 chars in code)
  evidenceJson: json('evidence_json'), // capped allow-listed list [{kind, ref, note}]
  status: text('status').notNull().default('active'), // active | superseded | reversed | expired | proposed
  supersedesId: integer('supersedes_id'), // row this one replaces
  supersededById: integer('superseded_by_id'), // filled when a later row replaces this one
  decisionLogId: integer('decision_log_id'), // optional link to a decision_log row
  source: text('source').notNull().default('owner_chat'), // owner_command | owner_chat | system_event | agent_loop | proposal | backfill
  reasonState: text('reason_state').notNull().default('stated'), // stated | not_stated (never fabricate a reason)
  validFrom: ts('valid_from').notNull(), // when the decision took effect (may precede created_at for backfills)
  validTo: ts('valid_to'), // null while active; set when superseded/reversed/expired
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  scopeChatTopicStatusIdx: index('idx_decision_memory_scope_chat_topic_status').on(t.scope, t.chatId, t.topicKey, t.status),
  topicValidIdx: index('idx_decision_memory_topic_valid').on(t.topicKey, t.validFrom),
}));

// ── Shield link check (2026-10-31 wave) ────────────────────────────────────
// Verdict cache + PB's own threat list. The verdict cache stays hash-keyed
// ONLY (sealing rule: no URL, no message text, ever). The own-list gains
// ONE nullable display column in the 2026-10-31 wizard wave (see below) —
// the recorded admin-view exception; every other stored row still carries
// verdict + threat + source + timestamps and nothing else.
// checkedAt/firstSeen are plain unix seconds (not ts()) on purpose: the
// 7-day cache TTL is arithmetic on raw seconds.
// These tables land in the live D1 only when `tgcloud migrate` runs; all
// readers fail-open until then.
export const shield_link_verdicts = table('shield_link_verdicts', {
  urlHash: text('url_hash').primaryKey(),
  verdict: text('verdict').notNull(), // 'clean' | 'malicious'
  threat: text('threat'), // URLhaus threat (e.g. 'malware_download') or 'goplus:EXTREME ...'
  source: text('source').notNull(), // 'urlhaus' | 'goplus'
  checkedAt: integer('checked_at').notNull(), // unix seconds
});
export const shield_link_ownlist = table('shield_link_ownlist', {
  urlHash: text('url_hash').primaryKey(),
  threat: text('threat').notNull(),
  source: text('source').notNull(), // 'urlhaus' | 'goplus'
  firstSeen: integer('first_seen').notNull(), // unix seconds
  hitCount: integer('hit_count').notNull().default(1), // live malicious confirmations
  // Shield link WIZARD (2026-10-31, add-only): the display URL for the
  // admin enforcement view ONLY. Nullable on purpose — pre-wizard rows
  // keep NULL (they still list and are still removable by tap) and only
  // NEW own-list writes store it. Stored log rows/tallies still carry
  // verdict + threat only, never URLs; this column is never shown to
  // members and never crosses groups to members. Deliberate, recorded
  // extension of the rev 497 hash-only sealing posture (see the wizard
  // notes file), not a quiet weakening: the same trusted parties who
  // already receive the action-time alert card naming the flagged URL.
  urlDisplay: text('url_display'),
});

// PB Stars lane (2026-11-01, workspace only, flags OFF, NOT pushed):
// wizard_orders + audit, spec PB-STARS-RESPEC-2026-11-01 §1.4/§5.
// These tables land in the live DB only when `tgcloud migrate` runs;
// all Stars readers fail-open until then (a missing table means the
// lane cannot create or settle an order — it never grants blind).
// No foreign keys (platform throws on them); integrity is enforced in
// app code (lib/websync.js Stars section). telegram_payment_charge_id
// is UNIQUE: a replayed successful_payment inserts no second row and
// grants nothing twice — the UNIQUE index IS the replay gate.
export const wizard_orders = table('wizard_orders', {
  id: text('id').primaryKey(), // Stars order id, also the invoice payload
  buyerTelegramId: text('buyer_telegram_id').notNull(),
  productId: text('product_id').notNull(), // sub_one_m | sub_one_a | studio_credits_500 | studio_credits_2000 | studio_credits_5000
  lane: text('lane').notNull().default('stars'),
  usdSnapshot: text('usd_snapshot').notNull(), // TEXT on purpose: exact catalog USD at order creation, never re-derived
  starsAmount: integer('stars_amount').notNull(), // whole Stars, ceil(usd * 76.93) at order creation
  currency: text('currency').notNull().default('XTR'),
  status: text('status').notNull().default('created'), // created | paid | applied | apply_failed | owner_review | expired
  telegramPaymentChargeId: text('telegram_payment_charge_id').unique(),
  failureReason: text('failure_reason'),
  refundReference: text('refund_reference'), // owner-ordered refundStarPayment reference only; NEVER auto-filled
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(), // 24h after creation
  paidAt: integer('paid_at', { mode: 'timestamp' }),
  appliedAt: integer('applied_at', { mode: 'timestamp' }),
}, (t) => ({
  buyerIdx: index('idx_wizard_orders_buyer').on(t.buyerTelegramId),
  statusIdx: index('idx_wizard_orders_status').on(t.status),
}));
export const wizard_order_audit = table('wizard_order_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('order_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  chargeId: text('charge_id'),
  note: text('note'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  orderIdx: index('idx_wizard_order_audit_order').on(t.orderId),
}));

// Shield link WIZARD (2026-10-31, add-only): pending member reports.
// A member report NEVER writes the own-list directly — it lands here as
// 'pending' and only an admin approval writes the own-list (via a fresh
// judge). urlDisplay is the reporter-pasted URL, shown to group
// admins/owner only in the DM manage view and the admin endpoint
// responses — never to members, never in stored log rows/tallies.
export const shield_link_reports = table('shield_link_reports', {
  id: text('id').primaryKey(), // sha256 of chat + url hash + created second
  urlHash: text('url_hash').notNull(),
  urlDisplay: text('url_display'),
  reporterId: text('reporter_id').notNull(),
  chatId: text('chat_id').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'dismissed'
  threat: text('threat'),
  createdAt: integer('created_at').notNull(), // unix seconds
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at'), // unix seconds
});

// ── Feedback + reviews (2026-11-05, add-only) ─────────────────────────────
// User-submitted feedback ('feedback', text only) and star reviews
// ('review', 1–5 stars + text), collected in-bot via the /menu buttons.
// Owner-only read surface: lib/statscmds.js listFeedbackForOwner +
// fb:owner:* callbacks. status: 'new' | 'read' | 'approved' | 'hidden'.
// 'approved' only marks a row eligible for a future public surface —
// NOTHING publishes automatically; public display of user-submitted
// reviews needs Rowdy's word (moderation + authenticity). The site
// testimonials section is hardcoded today (Replit
// artifacts/poorboyai-com/src/components/testimonials.tsx).
// MIGRATE REQUIRED before push: run `tgcloud migrate` after pushing the
// schema change, BEFORE pushing the code that writes it (same rule as
// held_grants). Push alone applies nothing.
export const pb_feedback = table('pb_feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(), // 'review' | 'feedback'
  userId: text('user_id').notNull(),
  username: text('username'),
  displayName: text('display_name'),
  stars: integer('stars'), // 1–5 for reviews, null for feedback
  text: text('text').notNull(),
  status: text('status').notNull().default('new'), // new | read | approved | hidden
  createdAt: ts('created_at').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at', { mode: 'timestamp' }),
}, (t) => ({
  userKindIdx: index('idx_pb_feedback_user_kind').on(t.userId, t.kind),
  statusCreatedIdx: index('idx_pb_feedback_status_created').on(t.status, t.createdAt),
}));

// ── Website builder v1 (2026-11-05, Rowdy: build a website builder) ────────
// One row per customer site: a site is a registry row, not a deployment of
// PB's own site. Owner-sealed (owner_tg_id on every read). v1 is OWNER-ONLY
// (Rowdy) — no checkout, no prices, no public creation. Templates T5 (link
// page) + T1 (token launch page). Template-only: no raw HTML/JS injection,
// ever — the generator HTML-escapes every buyer-supplied value. Status:
// draft | pending_deploy | live | failed | suspended | unpublished.
// MIGRATE REQUIRED before push: apply migration/pb_sites.sql in-isolate
// BEFORE pushing the code that writes these tables (sales-wave shape).
export const pb_sites = table('pb_sites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerTgId: text('owner_tg_id').notNull(),
  slug: text('slug').notNull().unique(), // Pages project name; URL is <slug>.pages.dev
  template: text('template').notNull(), // 't1_launch' | 't5_links'
  name: text('name').notNull(), // display name (project/token name)
  dataJson: text('data_json').notNull(), // interview answers (JSON)
  status: text('status').notNull().default('draft'), // draft | pending_deploy | live | failed | suspended | unpublished
  pagesUrl: text('pages_url'), // live URL once deployed
  deploymentId: text('deployment_id'), // Cloudflare deployment id
  lastError: text('last_error'), // deploy failure reason (plain words)
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  ownerStatusIdx: index('idx_pb_sites_owner_status').on(t.ownerTgId, t.status),
  statusCreatedIdx: index('idx_pb_sites_status_created').on(t.status, t.createdAt),
}));

// Static bundle files for one site (the generator's output, stored so the
// VM-side deploy runner can rebuild the directory). One row per file.
// Content is plain text (HTML/CSS) — no binary assets in v1.
export const pb_site_files = table('pb_site_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull(),
  path: text('path').notNull(), // e.g. 'index.html'
  content: text('content').notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  sitePathIdx: index('idx_pb_site_files_site_path').on(t.siteId, t.path),
}));

// ── P2P marketplace Wave 2 (2026-11-07, go word Rowdy ~19:46) ──────────────
// Deal-record tables ONLY — the bot never writes on-chain from here and
// never holds fiat. Mirrors the Wave 1 escrow contract
// (~/workspace/pb-own-p2p/contracts/PbP2PEscrow.sol, states Created,
// Funded, PaidMarked, Released, Refunded, Disputed, Cancelled) in
// lowercase-snake DB spelling. NO message-content column exists in any
// of these three tables, ever: dispute evidence is terms + timestamps +
// taps only (spec §"Dispute evidence model"). paymentLabel is the
// seller's free-text payment-method LABEL ("Cash App") — display only,
// never verified, never credentials. resolutionNote is Rowdy's own
// decision note from the dispute console, not chat text. Publish stays
// DISABLED; these tables record deals, they do not publish ads.
// MIGRATE REQUIRED before push: these tables do not exist in production
// until `tgcloud migrate` creates them — push the schema change and
// migrate FIRST, then push the code that writes them (same rule as
// held_grants / pb_sites). Push alone applies nothing.
export const p2p_deals = table('p2p_deals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Site-minted idempotency key for the deal intent (one per deal, ever);
  // the outbox applier dedupes creates on it, so a replayed create event
  // can never open a second deal row.
  idempotencyKey: text('idempotency_key').notNull().unique(),
  chain: text('chain').notNull().default('base-sepolia'), // 'base-sepolia' (Wave 2 testnet) | 'base'
  escrowAddress: text('escrow_address'), // PbP2PEscrow contract address (lowercase); null until the create tx lands
  chainDealId: integer('chain_deal_id'), // on-chain uint deal id within that escrow; null until the create tx lands
  adId: text('ad_id'), // Mini App ad ref, if the deal opened from an ad
  sellerTelegramId: text('seller_telegram_id').notNull(),
  buyerTelegramId: text('buyer_telegram_id').notNull(),
  sellerWallet: text('seller_wallet').notNull(), // lowercase EVM address
  buyerWallet: text('buyer_wallet').notNull(), // lowercase EVM address
  token: text('token').notNull(), // token contract address (lowercase)
  tokenSymbol: text('token_symbol').notNull(), // 'USDC' | 'PBAI' — first assets only; new assets need Rowdy's tap
  cryptoAmountText: text('crypto_amount_text').notNull(), // exact decimal string in token units — never a float
  fiatAmountText: text('fiat_amount_text').notNull(), // reference only, never verified
  fiatCurrency: text('fiat_currency').notNull().default('USD'), // currency label, reference only
  paymentLabel: text('payment_label'), // seller's free-text payment-method label, display only
  payWindowSec: integer('pay_window_sec').notNull(), // 3600–604800, validated in code
  confirmWindowSec: integer('confirm_window_sec').notNull(), // 3600–604800, validated in code
  payDeadline: integer('pay_deadline'), // unix seconds; set at fund
  confirmDeadline: integer('confirm_deadline'), // unix seconds; set at markPaid
  state: text('state').notNull().default('created'), // created | funded | paid_marked | released | refunded | disputed | cancelled
  createTxHash: text('create_tx_hash'),
  fundTxHash: text('fund_tx_hash'),
  markPaidTxHash: text('mark_paid_tx_hash'),
  releaseTxHash: text('release_tx_hash'),
  refundTxHash: text('refund_tx_hash'),
  disputeTxHash: text('dispute_tx_hash'),
  resolveTxHash: text('resolve_tx_hash'),
  resolvedBy: text('resolved_by'), // arbitrator telegram id (Rowdy) on resolve
  resolutionNote: text('resolution_note'), // Rowdy's dispute-console decision note (≤500 chars in code)
  createdAt: ts('created_at').notNull(),
  fundedAt: integer('funded_at', { mode: 'timestamp' }),
  paidMarkedAt: integer('paid_marked_at', { mode: 'timestamp' }),
  releasedAt: integer('released_at', { mode: 'timestamp' }),
  refundedAt: integer('refunded_at', { mode: 'timestamp' }),
  disputedAt: integer('disputed_at', { mode: 'timestamp' }),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  cancelledAt: integer('cancelled_at', { mode: 'timestamp' }),
  updatedAt: ts('updated_at').notNull(),
}, (t) => ({
  // One on-chain deal = one bot row. NULL chainDealId rows (pre-chain
  // creates) stay distinct under SQLite's NULL-unique rule, so the
  // idempotencyKey above is the pre-chain dedupe and this is the
  // post-chain one.
  chainDealUq: unique('uq_p2p_deals_chain_deal').on(t.chain, t.escrowAddress, t.chainDealId),
  stateIdx: index('idx_p2p_deals_state').on(t.state, t.createdAt),
  sellerIdx: index('idx_p2p_deals_seller').on(t.sellerTelegramId, t.createdAt),
  buyerIdx: index('idx_p2p_deals_buyer').on(t.buyerTelegramId, t.createdAt),
}));

// Every tap on a deal (who, when, what) — the dispute-evidence ledger.
// Written by the outbox applier (lib/websync.js applyP2pDealEvent) next
// to every state transition, and on review. No message content, no
// screenshots, no payment details: action + actor + timestamp + tx hash.
export const p2p_deal_taps = table('p2p_deal_taps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: integer('deal_id').notNull(), // p2p_deals.id (no FKs — platform rule; integrity in code)
  actorTelegramId: text('actor_telegram_id').notNull(),
  actorRole: text('actor_role').notNull(), // 'seller' | 'buyer' | 'arbitrator' | 'system'
  action: text('action').notNull(), // create | fund | mark_paid | release | refund | dispute | resolve_release | resolve_refund | cancel | review
  txHash: text('tx_hash'), // on-chain tx for this tap, when the tap has one
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  dealCreatedIdx: index('idx_p2p_deal_taps_deal').on(t.dealId, t.createdAt),
}));

// Post-deal reviews: 1–5 stars per counterparty, one per reviewer per
// deal. completedCount / volumeText / medianTimeToPaySec are a snapshot
// of the REVIEWER's public trader stats at review time (completed deals,
// total fiat volume as a decimal string, median funded→paidMarked
// seconds; null until the reviewer has a timed deal) — the console and
// the trader board read the snapshot, so later deals never rewrite a
// past review's context. No review text column by design (spec: terms,
// timestamps, taps only — a free-text review box is a message-content
// store and is NOT built in Wave 2).
export const p2p_reviews = table('p2p_reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dealId: integer('deal_id').notNull(), // p2p_deals.id (no FKs — platform rule)
  reviewerTelegramId: text('reviewer_telegram_id').notNull(),
  counterpartyTelegramId: text('counterparty_telegram_id').notNull(),
  stars: integer('stars').notNull(), // 1–5, validated in code
  completedCount: integer('completed_count').notNull().default(0),
  volumeText: text('volume_text'), // decimal string, fiat volume snapshot
  medianTimeToPaySec: integer('median_time_to_pay_sec'),
  createdAt: ts('created_at').notNull(),
}, (t) => ({
  dealReviewerUq: unique('uq_p2p_reviews_deal_reviewer').on(t.dealId, t.reviewerTelegramId),
  reviewerIdx: index('idx_p2p_reviews_reviewer').on(t.reviewerTelegramId, t.createdAt),
}));
