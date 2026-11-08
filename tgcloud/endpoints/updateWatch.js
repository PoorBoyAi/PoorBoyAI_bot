// Mini App M2: update one of the caller's whale watches.
// Patch: { id, label?, enabled?, walletAddress? }. Changing the wallet
// address resets lastNonce to -1 so the tick re-seeds instead of diffing
// against the old wallet's nonce.
import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { whale_watch_wallets } from '../schema.js';
import { caller, ensureUser } from '../lib/miniapp.js';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export default async (input, ctx) => {
  const tg = caller(ctx);
  const tgId = String(tg.id);
  await ensureUser(tg);
  if (input == null) input = {};

  const id = Number(input.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new EndpointError('PB needs a watch id to update.', { code: 'VALIDATION', field: 'id' });
  }
  const row = await db.select().from(whale_watch_wallets)
    .where(and(eq(whale_watch_wallets.id, id), eq(whale_watch_wallets.telegramUserId, tgId))).get();
  if (!row) throw new EndpointError('Watch not found.', { code: 'NOT_FOUND' });

  const patch = {};
  if (input.label !== undefined) {
    patch.label = String(input.label ?? '').trim().slice(0, 64) || null;
  }
  if (input.enabled !== undefined) {
    patch.enabled = input.enabled !== false;
  }
  if (input.walletAddress !== undefined) {
    const addr = String(input.walletAddress ?? '').trim();
    if (!ADDR_RE.test(addr)) {
      throw new EndpointError('That wallet address does not look like a 0x… address (40 hex chars).', { code: 'VALIDATION', field: 'walletAddress' });
    }
    if (addr !== row.walletAddress) {
      patch.walletAddress = addr;
      patch.lastNonce = -1; // re-seed against the new wallet on the next cycle
    }
  }
  if (!Object.keys(patch).length) {
    throw new EndpointError('Nothing to update.', { code: 'VALIDATION' });
  }

  await db.update(whale_watch_wallets).set(patch)
    .where(and(eq(whale_watch_wallets.id, id), eq(whale_watch_wallets.telegramUserId, tgId))).run();

  const updated = await db.select().from(whale_watch_wallets)
    .where(and(eq(whale_watch_wallets.id, id), eq(whale_watch_wallets.telegramUserId, tgId))).get();
  return {
    id: updated.id,
    walletAddress: updated.walletAddress,
    label: updated.label,
    enabled: updated.enabled !== false,
  };
};
