// Mini App M2: create a whale wallet watch. Writes the row in exactly the
// shape the tick's cycleWhaleWatches consumes: lastNonce = -1 so the first
// cycle seeds the current nonce, telegramChatId = the caller's DM (that is
// where the tick sends the activity ping). Server-side tier gate enforced.
import { EndpointError } from 'sdk';
import db, { eq } from 'sdk/db';
import { whale_watch_wallets } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';
import { enforceGate } from '../lib/tiers.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  const user = await ensureUser(tg);
  const tier = user?.tier ?? 'free';

  const walletAddress = String(input?.walletAddress ?? '').trim();
  if (!ADDR_RE.test(walletAddress)) {
    throw new EndpointError('That wallet address does not look like a 0x… address (40 hex chars).', { code: 'VALIDATION', field: 'walletAddress' });
  }
  const label = String(input?.label ?? '').trim().slice(0, 64) || null;

  let mine = [];
  try {
    mine = await db.select().from(whale_watch_wallets)
      .where(eq(whale_watch_wallets.telegramUserId, tgId)).all();
  } catch { /* db errors read as no existing watches */ }
  // FIX 5 (2026-10-29): this endpoint had NO dup check at all — the
  // hole that created the live triple-watch (rows 10/11/12, same
  // user + address). Unique key is user + lowercased address (the
  // table has no chain column; watches are Base by construction).
  // A re-add returns the existing row (idempotent, honest) instead
  // of a second row, and never counts toward the tier cap.
  const normalized = walletAddress.toLowerCase();
  const existing = mine.find((w) => String(w.walletAddress ?? '').toLowerCase() === normalized);
  if (existing) {
    return {
      id: existing.id,
      walletAddress: existing.walletAddress,
      label: existing.label,
      enabled: existing.enabled !== false,
      alreadyWatched: true,
    };
  }
  await enforceGate(tgId, tier, 'whaleWatches', mine.length);

  let inserted = [];
  let insertError = null;
  try {
    inserted = await db.insert(whale_watch_wallets).values({
      telegramUserId: tgId,
      telegramChatId: tgId,
      walletAddress: normalized,
      label,
      lastNonce: -1,
      enabled: true,
    }).returning();
  } catch (err) {
    insertError = err?.message ?? String(err);
    console.error('[createWatch] insert failed:', insertError);
  }
  const row = inserted[0];
  if (!row) {
    throw new EndpointError('PB could not save that watch. Try again.', {
      code: 'DB_ERROR',
      cause: insertError ? String(insertError).slice(0, 200) : 'no row returned',
    });
  }

  return {
    id: row.id,
    walletAddress: row.walletAddress,
    label: row.label,
    enabled: row.enabled !== false,
  };
};
