// Mini App: the caller's OWN workspace (Dashboard wave item 4) — their
// managed groups, Telegram↔console link state, masked active MCP key, and
// their own recent activity. Scoped to ctx.initData.user.id throughout.
// Telegram link state: PB's local record is the telegram_links row the
// telegram_link outbox applier writes (lib/websync.js). With no local row
// PB cannot confirm a link either way, so it reports unavailable rather
// than guessing. The discord-style Worker check is NOT reused here —
// tg_links lives Worker-side (D1) and PB only knows what was applied.
import db, { eq, desc, isNull, and } from 'sdk/db';
import { mcp_api_keys, telegram_links, user_activity_log } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { getMyGroupsFor } from '../lib/groups.js';
import { maskKey } from '../lib/mcpkeys.js';

const MCP_ENDPOINT = 'https://poorboyai.pages.dev/mcp';

function toUnix(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  const tgId = String(tg.id);

  const groups = await getMyGroupsFor(tg.id).catch(() => []);

  let telegramLink;
  try {
    const link = await db.select().from(telegram_links)
      .where(eq(telegram_links.telegramUserId, tgId)).get();
    telegramLink = link ? { linked: true } : { linked: false, unavailable: true };
  } catch {
    telegramLink = { linked: false, unavailable: true };
  }

  let activeKey = null;
  try {
    const rows = await db.select().from(mcp_api_keys)
      .where(and(eq(mcp_api_keys.telegramUserId, tgId), isNull(mcp_api_keys.revokedAt)))
      .orderBy(desc(mcp_api_keys.createdAt)).all();
    const k = rows[0];
    if (k) activeKey = { prefix: k.apiKeyPrefix, last4: k.last4, plan: k.plan };
  } catch { /* no keys */ }

  const masked = activeKey ? maskKey(activeKey.prefix, activeKey.last4) : '<issue-a-key-first>';
  const clientConfig = JSON.stringify({
    mcpServers: {
      poorboyai: {
        url: MCP_ENDPOINT,
        headers: { Authorization: 'Bearer ' + masked },
      },
    },
  }, null, 2);

  let activity = [];
  try {
    const rows = await db.select().from(user_activity_log)
      .where(eq(user_activity_log.telegramUserId, tgId))
      .orderBy(desc(user_activity_log.createdAt)).limit(20).all();
    activity = rows.map((r) => ({ ts: toUnix(r.createdAt), kind: r.kind, text: r.detail }));
  } catch { /* no activity yet */ }

  return {
    groups,
    telegramLink,
    mcp: { activeKey, endpoint: MCP_ENDPOINT, clientConfig },
    activity,
  };
};
