// Runtime config + secrets store (owner-managed key/value rows).
// Answers "where do API keys live?" — seeded post-login by the owner via a
// DM-only admin flow. Keys: OPENROUTER_API_KEY, GEMINI_API_KEY, XAI_API_KEY,
// TELEGRAM_OWNER_ID (comma-separated), PB_BOT_USERNAME.

import db, { eq } from 'sdk/db';
import { config } from '../schema.js';

export async function getConfig(key, fallback = null) {
  const row = await db.select().from(config).where(eq(config.key, key)).get();
  return row?.value ?? fallback;
}

export async function setConfig(key, value) {
  await db.insert(config).values({ key, value: String(value) })
    .onConflictDoUpdate({ target: config.key, set: { value: String(value) } })
    .run();
}

// ── Broadcast preview store (2026-10-29, fix 1) ────────────────────────────
// A pending broadcast preview is a config-table JSON row, NOT in-memory
// state (the isolate is stateless — an in-memory confirm could never
// survive to the button tap). One pending preview per user: a newer
// preview replaces an older one, and every preview carries a token that
// its Confirm/Cancel buttons must present back, so a superseded preview's
// buttons can never fire the newer one. takeBroadcastPreview reads AND
// clears, so a record can execute at most once (double-Confirm safety).
export const broadcastPreviewKey = (userId) => `bprev:${String(userId)}`;

export async function saveBroadcastPreview(userId, record) {
  await setConfig(broadcastPreviewKey(userId), JSON.stringify(record));
}

export async function readBroadcastPreview(userId) {
  try {
    const raw = await getConfig(broadcastPreviewKey(userId), '');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

export async function takeBroadcastPreview(userId) {
  const record = await readBroadcastPreview(userId);
  try { await setConfig(broadcastPreviewKey(userId), ''); } catch { /* best effort */ }
  return record;
}

// ── Boolean config flags (audit F19 fix) ───────────────────────────────────
// The studio_premium_enabled incident class: flag readers compared the
// stored value to the literal '1' while /setkey stored the owner's typed
// value verbatim — typing the natural `true` silently turned a product
// OFF. Two systemic fixes live here so no future reader/writer pair can
// reintroduce it:
//   1. flagValueOn/getConfigFlag — the ONE tolerant boolean reader:
//      '1'/'true'/'on'/'yes' (any case, trimmed) are ON; '0'/'false'/
//      anything else/unset are OFF. It agrees with the pre-existing
//      lenient readers (tick.js buyFlagOn, airdrop.js brFlagOn) on every
//      value, so swapping a strict reader for it never changes a key's
//      effective value as currently stored.
//   2. canonicalBooleanConfigKey — the registry of known boolean keys,
//      used by /setkey to normalize a typed boolean to '1'/'0' AND to
//      write the canonical (lowercase) key the readers actually read —
//      /setkey uppercases the typed name, so without this the write
//      landed on a differently-cased row no reader ever sees.
// Deliberately NOT in the registry: business_bot_ai_enabled (its reader
// is `!== 'false'` with a 'true'/'false' writer in lib/business.js — a
// consistent lenient pair; normalizing 'false'→'0' would flip it ON),
// decide_sample_<set> (a numeric rate, not a boolean), and per-user
// state keys (voice_auto_<id>, askpb_daily:*, aicap_daily:* — code-written
// counters/toggles, never /setkey targets).

export function flagValueOn(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

/** Read a config key as a boolean flag (tolerant reader, see above). */
export async function getConfigFlag(key) {
  return flagValueOn(await getConfig(key, null));
}

const BOOLEAN_CONFIG_KEYS = new Set([
  'studio_enabled',
  'studio_premium_enabled',
  'podcast_enabled',
  'boost_enabled',
  'airdrop_enabled',
  'boost_live_arm',
  'airdrop_live_arm',
  'buyrewards_armed',
  'buy_home_enabled',
  'decide_off_all',
  'decide_shadow_skill_route',
  'watcher_enabled',
  // Tick-budget wave (2026-11-06): registered so /setkey normalizes
  // WATCHER_SCAN_SEPARATE to this canonical lowercase key. WITHOUT this
  // row, /setkey writes the UPPERCASED row (no reader ever sees it) while
  // cycleWatcherVerify reads the lowercase key — the flip silently does
  // nothing. Ships OFF (unset = scan rides the tick); flip ON only after
  // the pb-watcher-scan cron proves one scanOnly run.
  'watcher_scan_separate',
  // Tick-wallclock wave (2026-11-06): registered so /setkey normalizes
  // OUTBOX_BRAIN_SEPARATE to this canonical lowercase key — same D1
  // lesson as watcher_scan_separate. Ships OFF (unset = the tick keeps
  // applying up to 1 brain outbox row/pull); flip ON only after the
  // pb-outbox-brain cron proves one lockless outboxBrainOnly run.
  'outbox_brain_separate',
  'raid_autotrack_enabled',
  // Leads hold (Rowdy 2026-11-07 "stop the leads"): registered so /setkey
  // normalizes LEADS_ENABLED to this canonical lowercase key. WITHOUT this
  // row, /setkey writes the UPPERCASED row (no reader ever sees it) while
  // cycleLeadFinder reads the lowercase key — the re-arm would silently do
  // nothing (same D1 lesson as watcher_scan_separate). Ships ON (unset =
  // scans run); flipped OFF live 2026-11-07 ~18:43 PT via temp endpoint
  // (pre-armed before the push — re-setting '0' is idempotent); re-arm
  // with /setkey LEADS_ENABLED 1 (or delete the key).
  'leads_enabled',
  // DexScreener boost stream hold (Rowdy 2026-11-07, same order as the
  // leads hold): registered so /setkey normalizes DEX_STREAM_ENABLED to
  // this canonical lowercase key — same D1 lesson as watcher_scan_separate
  // (an unregistered key would land on the UPPERCASED row no reader sees,
  // and the re-arm would silently do nothing). Ships ON (unset = stream
  // runs hourly); flipped OFF live 2026-11-07 ~18:47 PT via temp endpoint
  // (pre-armed before the push — re-setting '0' is idempotent); re-arm
  // with /setkey DEX_STREAM_ENABLED 1 (or delete the key).
  'dex_stream_enabled',
  'master_spend_arm',
  'master_spend_kill',
  'signal_inlet_global',
  'x_loop_off',
  // Outage-X suppression (video-automatic wave 2026-11-06): registered so
  // /setkey normalizes X_OUTAGE_OFF to this canonical key. Ships OFF
  // (unset = OFF); this wave flips it ON after the push.
  'x_outage_off',
  'mirror_off',
  'decision_memory_enabled',
  // /wizbuy gate (Rowdy's call 2026-10-26, until WW3): registered so
  // /setkey normalizes WIZBUY_GATED to this canonical key. The gate
  // reader (isWizbuyGated in lib/websync.js) is FAIL-CLOSED and does
  // NOT use getConfigFlag — unset must mean gated, not OFF. Lifting is
  // a separate explicit step (owner /setkey WIZBUY_GATED 0 after WW3);
  // nothing in code writes this key, so nothing auto-ungates.
  'wizbuy_gated',
  // Overnight build 2026-10-25 (local only, unpushed): outreach kill switch
  // + revenue-seed gates. All three ship OFF (unset = OFF); registering them
  // here only makes /setkey normalize the typed name to the canonical key.
  'outreach_off',
  'revenue_seed_enabled',
  'revenue_seed_kill',
  // PB Stars lane (2026-11-01, workspace only, flags OFF): both ship
  // OFF and arm only on Rowdy's tap, in order catalog → lane flag →
  // master flag last. Registering them here only makes /setkey
  // normalize the typed name to the canonical lowercase key the
  // readers actually read; this wave NEVER flips either flag.
  'wizard_enabled',
  'wizard_stars_enabled',
  // Lifecycle comms wave (2026-10-27): ONE default-OFF flag gates every
  // NEW lifecycle send (receipts, welcomes beyond /start, warning emails,
  // lapse notices, restore notes, the Resubscribe button). Registered so
  // /setkey normalizes LIFECYCLE_COMMS_ENABLED to this canonical key —
  // without this, the owner's flip would land on a differently-cased row
  // no reader ever sees. This wave NEVER flips it; the flip is Rowdy's
  // separate final send-go tap.
  'lifecycle_comms_enabled',
]);

const BOOLEAN_CONFIG_PATTERNS = [
  /^decide_(off|shadow|live)_.+$/,                    // decide posture per question set
  /^(airdrop|boost)_chain_[a-z]+_(enabled|arm)$/,     // moneyguard per-chain layers
];

/**
 * If `name` (any case — /setkey uppercases what the owner typed) names a
 * known boolean config key, return its canonical stored key; else null.
 */
export function canonicalBooleanConfigKey(name) {
  const k = String(name ?? '').trim().toLowerCase();
  if (!k) return null;
  if (BOOLEAN_CONFIG_KEYS.has(k)) return k;
  for (const re of BOOLEAN_CONFIG_PATTERNS) if (re.test(k)) return k;
  return null;
}
