// lib/nlcmd.js — PB's plain-English command layer (v1, owner-only, DMs only).
//
// Intercepts non-command DM text from the owner BEFORE normal chat handling,
// classifies it into a tiny structured intent via the brain (single call),
// validates everything deterministically server-side, and executes through
// the same M2 endpoint modules the Mini App uses (tiers + validation ride
// along). Anything the owner asks for publicly posts about requires an
// explicit yes first (inline buttons, state in the config table). Everything
// else falls through to normal chat untouched.
//
// Platform rules observed: no .catch() on query builders (try/catch only),
// import fetch from 'sdk' (unused here), no AbortController/setTimeout.

import { api, EndpointError } from 'sdk';
import db, { eq, and, desc, inArray } from 'sdk/db';
import { price_alerts, whale_watch_wallets, user_agents, pb_leads, bot_users } from '../schema.js';
import { askBrain } from './brain.js';
import { isOwnerId, cleanupNoteSent } from './groups.js';
import { getConfig, setConfig, getConfigFlag } from './config.js';
import { runSkill, SKILL_CATALOG, sendSkillCardCompanion } from './skills.js';
import { prepareVoiceAnswer } from './llm.js';
import { sendReceiptCard } from './verdict.js';
import { decide, recordDecisionOutcome, recordSystemDecision, setPosture, twinConversation } from './decide.js';
import { executeBroadcast, listKnownGroups, broadcastReceiptText, createDmBroadcastJob, validateOutboundText, looksTemplated } from './broadcastcmds.js';
import { resolveUserKey, saveMessage } from './memory.js';
import createAlertEndpoint from '../endpoints/createAlert.js';
import createWatchEndpoint from '../endpoints/createWatch.js';
import createAgentEndpoint from '../endpoints/createAgent.js';
import deleteAlertEndpoint from '../endpoints/deleteAlert.js';
import deleteWatchEndpoint from '../endpoints/deleteWatch.js';
import deleteAgentEndpoint from '../endpoints/deleteAgent.js';

const PBAI_CA = '0x023f98c2f47edb09ee0d0bc9133d236fc82d060e';
const PENDING_TTL_MS = 30 * 60 * 1000;

const pendingKey = (tgId) => `nlcmd_pending_${tgId}`;
const clarifyKey = (tgId) => `nlcmd_clarify_${tgId}`;

async function readJsonKey(key) {
  try {
    const raw = await getConfig(key, '');
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.askedAt || Date.now() - Number(o.askedAt) > PENDING_TTL_MS) return null;
    return o;
  } catch { return null; }
}

async function clearJsonKey(key) {
  try { await setConfig(key, ''); } catch { /* best effort */ }
}

async function sendSafe(chatId, text, extra = {}) {
  try {
    const sent = await api.sendMessage({ chat_id: chatId, text: String(text).slice(0, 4000), ...extra });
    // PB Cleanup capture seam (2026-10-22).
    await cleanupNoteSent(chatId, sent);
    return sent;
  } catch (err) {
    if (err?.code !== 403) console.error('[nlcmd send]', err?.code, err?.description ?? err?.message);
  }
}

// ── Intent classification ─────────────────────────────────────────────────────

const CLASSIFY_PROMPT = `You are a strict intent classifier for a Telegram bot owner's natural-language commands.
Return ONLY a JSON object — no markdown, no other text.
Schema: {"action":"create_alert|create_watch|create_agent|list_jobs|stop_job|broadcast|dm_broadcast|token_scan|price_check|community_stats|my_rank|global_standings|ta_overview|rsi_check|macd_check|bollinger_check|hot_gems|wallet_lookup|security_scan|my_points|my_tier|my_wallet|holder_status|my_alerts|my_watched|my_invite|my_digest|business_status|group_leaderboard|my_squad|contest_status|global_stats|featured_gems|post_writer|debate|moon_moment|my_campaign|none","params":{}}
Actions:
- create_alert: user wants a one-shot price alert. params: {"tokenName":"PBAI", "tokenAddress":"0x…"|null, "direction":"above"|"below"|null, "targetPrice":number|null}. "$PBAI" or "pbai" → tokenName "PBAI", tokenAddress null (server fills the known address).
- create_watch: user wants to watch a wallet. params: {"walletAddress":"0x…"|null}.
- create_agent: user wants a REPEATED/ONGOING agent (shill every N hours, daily recap, repeated alerts). params: {"agentType":"auto_shill"|"daily_recap"|"price_alert"|null, "tokenName":"…", "tokenAddress":"0x…"|null, "intervalHours":number|null, "targetGroupHint":"…"}. targetGroupHint is a chat-id string, or the literal "home" when the user says the main/home/PoorBoyAI group (the server resolves it to the home chat id).
- list_jobs: user asks what agents/alerts/watches are currently running. params: {}.
- broadcast: the owner wants to SEND an announcement to ALL the groups the bot serves ("broadcast …", "announce to all my groups …", "tell all the groups …"). params: {"text":"the announcement text exactly as worded; empty string if none was given"}. Asking to WRITE a post without sending it anywhere is post_writer, not broadcast. (Server shows a confirm step before anything is sent.)
- dm_broadcast: the owner wants to DM an announcement to ALL of the bot's USERS — private messages to everyone who has started the bot ("dm broadcast …", "message all users …", "announce to all users …", "send a dm to everyone …"). params: {"text":"the announcement text exactly as worded; empty string if none was given"}. Announcements to GROUPS are broadcast, not this. (Server shows a confirm step before anything is sent.)
- stop_job: user wants to stop/cancel/delete one. params: {"match":"descriptive words or an id like #3"}.
- token_scan: user wants an AI analysis/opinion of a token ("scan this 0x…", "analyze PBAI", "what do you think of <token>"). params: {"query":"ticker, name, or 0x… (empty string = $PBAI)"}. A request to SET UP a recurring analysis is create_agent, not token_scan.
- price_check: user asks a token's current price ("price of PBAI", "what's 0x… at"). params: {"token":"ticker or 0x…"}.
- community_stats: user asks how the community/group is doing (raid XP, raiders, queue). params: {}.
- my_rank: user asks their own raid rank/standing ("what's my rank", "where do I stand"). params: {}.
- global_standings: user asks about the global leaderboard across communities ("who's winning globally", "global board"). params: {}.
- ta_overview / rsi_check / macd_check / bollinger_check: user wants a technical-analysis read ("ta on PBAI", "rsi of 0x…", "macd check", "bollinger for PBAI"). params: {"query":"ticker or 0x… (empty = $PBAI)"}.
- security_scan: user wants the fast GoPlus security verdict on a contract ("security scan 0x…", "is 0x… safe"). params: {"token":"0x…"}.
- hot_gems: user asks for trending/hot tokens ("hot gems", "trending tokens"). params: {}. (Builder+ gate inside the skill.)
- wallet_lookup: user asks for a wallet's balances ("check wallet 0x…", "portfolio of 0x…"). params: {"address":"0x…"}. (Builder+ gate inside the skill.)
- my_points / my_tier / my_wallet / holder_status / my_alerts / my_watched / my_invite / my_digest / business_status / my_campaign / my_squad: the user asks about their OWN points, tier, wallet, holder status, alerts, watches, invites, digest, business bot, campaign, or squad. params: {}.
- group_leaderboard: user asks for a group's XP leaderboard ("group leaderboard", "points board"). params: {}.
- contest_status: user asks about the active contest ("contest status", "any contest running"). params: {}.
- global_stats: user asks for network-wide totals ("global stats", "bot stats", "how many users"). params: {}.
- featured_gems: user asks for the curated gem list ("featured gems", "gem list"). params: {}.
- post_writer: user wants a shill post WRITTEN (not posted) ("write a bull post about $PBAI"). params: {"kind":"bull|bear|moon|fud|gem|meme|callout|alpha|nft|defi","topic":"…"}. (Per-kind gates inside the skill; the post is returned privately.)
- debate: user wants a bull-vs-bear debate ("debate BTC vs ETH"). params: {"topic":"…"}. (Builder+ gate inside the skill.)
- moon_moment: user wants a moon caption/hype line ("moon line", "hype me"). params: {}. (Builder+ gate inside the skill.)
- none: chit-chat, questions, anything not requesting one of the above.
Rules: never invent addresses, prices, or ids — use null for missing. One message produces ONE action; if mixed, take the first actionable request.`;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function extractJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function normalizeIntent(obj) {
  if (!obj || typeof obj !== 'object') return { action: 'none', params: {} };
  const valid = ['create_alert', 'create_watch', 'create_agent', 'list_jobs', 'stop_job',
    'broadcast', 'dm_broadcast', 'token_scan', 'price_check', 'community_stats', 'my_rank', 'global_standings',
    'ta_overview', 'rsi_check', 'macd_check', 'bollinger_check', 'hot_gems', 'wallet_lookup',
    'security_scan', 'my_points', 'my_tier', 'my_wallet', 'holder_status', 'my_alerts',
    'my_watched', 'my_invite', 'my_digest', 'business_status', 'my_campaign', 'group_leaderboard',
    'my_squad', 'contest_status', 'global_stats', 'featured_gems', 'post_writer',
    'debate', 'moon_moment', 'none'];
  const action = valid.includes(obj.action) ? obj.action : 'none';
  const params = (obj.params && typeof obj.params === 'object') ? obj.params : {};
  return { action, params };
}

/** Deterministic keyword parser — used when the brain is unreachable (quota)
 *  and for unit-style verification. Returns an intent or null. */
export function deterministicClassify(rawText) {
  const text = String(rawText ?? '').trim();
  const low = text.toLowerCase();

  // "the main group" / "home group" / "PoorBoyAI group" → 'home' marker
  // (buildAgentPlan resolves it to the home chat id). Used by both parsers below.
  const HOME_PHRASE = /(the\s+)?(main|home)\s+(group|community)|poorboyai\s+(group|community)|official\s+poorboyai/i;
  const homeOr = (groups) => (HOME_PHRASE.test(text) ? 'home' : (groups[0] ?? null));

  // "alert me if $PBAI drops below $1" / "ping me when 0x… rises above $5"
  {
    const m = /(?:alert|ping|notify|tell)\s+me\s+(?:if|when)\s+(.{1,80}?)\s+(?:(drops?|falls?|dips?|goes?)\s+(below|under|beneath)|(?:below|under|beneath)|(rises?|goes?|climbs?)\s+(above|over|past)|(?:above|over|past)|hits?|reaches?)\s*\$?\s*([\d][\d,]*\.?\d*)/i.exec(text);
    if (m) {
      const tokenStr = m[1].trim();
      const downWords = /drops?|falls?|dips?|goes?|below|under|beneath/i;
      const upWords = /rises?|climbs?|goes?|above|over|past/i;
      const dirWord = (m[2] ?? '') + ' ' + (m[3] ?? '') + ' ' + (m[4] ?? '') + ' ' + (m[5] ?? '');
      const direction = downWords.test(dirWord) ? 'below' : (upWords.test(dirWord) ? 'above' : null);
      const targetPrice = Number(String(m[6]).replace(/,/g, ''));
      const addr = /0x[0-9a-fA-F]{40}/.exec(tokenStr)?.[0] ?? null;
      const isPbai = /\$?pbai\b/i.test(tokenStr);
      return {
        action: 'create_alert',
        params: {
          tokenName: isPbai ? 'PBAI' : (addr ? 'TOKEN' : tokenStr.replace(/^\$/, '').slice(0, 24) || 'TOKEN'),
          tokenAddress: addr,
          direction, targetPrice: Number.isFinite(targetPrice) ? targetPrice : null,
        },
      };
    }
  }

  // "watch 0x…" / "track wallet 0x…"
  {
    const m = /(?:watch|track)(?:\s+(?:this\s+)?wallet)?\s*(0x[0-9a-fA-F]{40})/i.exec(text);
    if (m) return { action: 'create_watch', params: { walletAddress: m[1] } };
  }

  // DM broadcast (owner DM): "dm broadcast …", "message all users …",
  // "announce to all users …". Checked BEFORE the group broadcast below:
  // "broadcast to all users: …" starts with the group pattern's verb, so
  // the users phrasing must win first. Detection only opens the confirm
  // step — nothing sends from here.
  {
    const m = /^\s*(?:dm\s*broadcast|dmbroadcast)\b\s*:?\s*([\s\S]*)$/i.exec(text)
      ?? /\b(?:broadcast|announce|message|send)\b[^.?!]{0,40}?\bto\s+(?:all\s+)?(?:the\s+)?users\b\s*:?\s*([\s\S]*)$/i.exec(text)
      ?? /\b(?:dm|message|text|tell)\s+(?:all\s+)?(?:the\s+)?(?:bot\s+)?users\b\s*:?\s*([\s\S]*)$/i.exec(text)
      ?? /\bsend\s+a\s+dm\s+to\s+everyone\b\s*:?\s*([\s\S]*)$/i.exec(text);
    if (m) return { action: 'dm_broadcast', params: { text: (m[1] ?? '').trim() } };
  }

  // Broadcast (owner DM): "broadcast …", "announce to all my groups: …",
  // "tell all the groups …". Anchored on the command verb + the all-groups
  // phrasing so it never steals post_writer ("write a bull post") or the
  // alert patterns. Runs BEFORE the shill/recap agent patterns: an explicit
  // broadcast instruction wins over keywords inside the announcement text.
  // Detection only opens the confirm step — nothing sends from here.
  {
    const m = /^\s*broadcast\b\s*:?\s*([\s\S]*)$/i.exec(text)
      ?? /\bannounce\s+(?:this\s+|it\s+)?(?:to\s+|in\s+)?(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?groups?\b\s*:?\s*([\s\S]*)$/i.exec(text)
      ?? /\btell\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?groups?\b\s*:?\s*([\s\S]*)$/i.exec(text);
    if (m) return { action: 'broadcast', params: { text: (m[1] ?? '').trim() } };
  }

  // "shill $PBAI every 6 hours" / "auto shill … in group …"
  {
    if (/\bshill\b/i.test(low)) {
      const interval = /every\s+(\d+)\s*hours?/i.exec(low)?.[1] ?? null;
      const addr = /0x[0-9a-fA-F]{40}/.exec(text)?.[0] ?? null;
      const isPbai = /\$?pbai\b/i.test(text);
      const groups = [...text.matchAll(/-?\d{6,}/g)].map((x) => x[0])
        .filter((g) => g !== '8429146850' && g !== '8667050062');
      return {
        action: 'create_agent',
        params: {
          agentType: 'auto_shill',
          tokenName: isPbai ? 'PBAI' : 'TOKEN',
          tokenAddress: isPbai ? PBAI_CA : addr,
          intervalHours: interval ? Number(interval) : null,
          targetGroupHint: homeOr(groups),
        },
      };
    }
  }

  // "post a $PBAI recap" / "daily recap in group …" — recap always means the
  // daily-recap agent in this product's vocabulary; day-words optional.
  // Never claims stop/cancel phrasings ("stop the recap" belongs to stop_job).
  {
    if (/\brecap\b/i.test(low) && !/^\s*(stop|cancel|remove|delete|turn\s+off|disable|pause)\b/i.test(text)) {
      const addr = /0x[0-9a-fA-F]{40}/.exec(text)?.[0] ?? null;
      const isPbai = /\$?pbai\b/i.test(text);
      const groups = [...text.matchAll(/-?\d{6,}/g)].map((x) => x[0])
        .filter((g) => g !== '8429146850' && g !== '8667050062');
      return {
        action: 'create_agent',
        params: {
          agentType: 'daily_recap',
          tokenName: isPbai ? 'PBAI' : 'TOKEN',
          tokenAddress: isPbai ? PBAI_CA : addr,
          intervalHours: null,
          targetGroupHint: homeOr(groups),
        },
      };
    }
  }

  // "what's running?" / "what is running?" / "list my agents"
  if (/\b(what(?:'?s|\s+is)\s+(running|on|active)|show\s+(?:my\s+)?(?:agents?|alerts?|watches?|jobs?|everything)|list\s+(?:my\s+)?(?:agents?|alerts?|watches?|jobs?))\b/i.test(low)) {
    return { action: 'list_jobs', params: {} };
  }

  // ── v2: skills intents (read-only answers; run through lib/skills.js) ──

  // "who's winning globally" / "global board" / "global standings"
  if (/\bglobal\b[^.?!]{0,40}\b(board|standings|leaderboard|rankings?)\b/i.test(low)
    || /who'?s winning globally/i.test(low)
    || /\bglobal board\b/i.test(low)) {
    return { action: 'global_standings', params: {} };
  }

  // "what's my rank" / "where do I stand"
  if (/(what'?s|what is) my (raid )?(rank|standing|position)\b/i.test(low)
    || /where do i stand\b/i.test(low)
    || /\bmy (raid )?rank\b/i.test(low)) {
    return { action: 'my_rank', params: {} };
  }

  // "how's the group doing" / "community stats"
  if (/how'?s (the )?(group|community) doing/i.test(low)
    || /how is (the )?(group|community) doing/i.test(low)
    || /\b(community|group) stats\b/i.test(low)) {
    return { action: 'community_stats', params: {} };
  }

  // ── skills expansion (2026-10-20): the new read skills, plain English ──
  // All read-only / private-generation; gates live inside the skills.

  // "security scan 0x…" / "is 0x… safe" — BEFORE token_scan so the fast
  // GoPlus verdict wins over the AI analysis for these phrasings.
  {
    const addr = /0x[0-9a-fA-F]{40}/.exec(text)?.[0] ?? null;
    if (/\bsecurity (scan|check)\b/i.test(low) || (addr && /\bis\b[^.?!]{0,50}\b(safe|legit|a honeypot|a scam|a rug)\b/i.test(low))) {
      if (addr) return { action: 'security_scan', params: { token: addr } };
    }
  }

  // "ta on PBAI" / "technical analysis of 0x…" / "rsi of PBAI" / "macd check"
  {
    const ta = /\btechnical analysis\b\s*(?:for|on|of)?\s*(\S+)?/i.exec(text)
      ?? /^\s*ta\b\s*(?:for|on|of)?\s*(\S+)?/i.exec(text);
    if (ta) return { action: 'ta_overview', params: { query: (ta[1] ?? '').replace(/[?.!]+$/, '') } };
    const ind = /\b(rsi|macd|bollinger)\b\s*(?:check)?\s*(?:for|on|of)?\s*(\S+)?/i.exec(text);
    if (ind) {
      const action = ind[1].toLowerCase() === 'rsi' ? 'rsi_check'
        : ind[1].toLowerCase() === 'macd' ? 'macd_check' : 'bollinger_check';
      return { action, params: { query: (ind[2] ?? '').replace(/[?.!]+$/, '') } };
    }
  }

  // Own-account reads
  if (/\bmy (points|xp)\b/i.test(low) || /how (many|much) (points|xp) do i have/i.test(low)) {
    return { action: 'my_points', params: {} };
  }
  if (/\bmy tier\b/i.test(low) || /what tier am i/i.test(low) || /\bmy (plan|subscription)\b/i.test(low)) {
    return { action: 'my_tier', params: {} };
  }
  if (/\bmy wallets?\b/i.test(low)) return { action: 'my_wallet', params: {} };
  if (/am i (a |an )?holder/i.test(low) || /\bholder status\b/i.test(low) || /do i hold \$?pbai/i.test(low)) {
    return { action: 'holder_status', params: {} };
  }
  if (/\bmy alerts\b/i.test(low)) return { action: 'my_alerts', params: {} };
  if (/\bmy watched\b/i.test(low) || /\bwatched wallets\b/i.test(low)) return { action: 'my_watched', params: {} };
  if (/\bmy (invite|invites|referrals)\b/i.test(low) || /\breferral stats\b/i.test(low)) {
    return { action: 'my_invite', params: {} };
  }
  if (/\bmy digest\b/i.test(low) || /\bmorning digest\b/i.test(low)) return { action: 'my_digest', params: {} };
  if (/\bmy campaign\b/i.test(low) || /\bcampaign status\b/i.test(low) || /how'?s my campaign/i.test(low)) return { action: 'my_campaign', params: {} };
  if (/\bbusiness (bot )?status\b/i.test(low) || /\bmy business bot\b/i.test(low)) {
    return { action: 'business_status', params: {} };
  }
  if (/\bmy squad\b/i.test(low)) return { action: 'my_squad', params: {} };

  // Community reads
  if (/\bgroup leaderboard\b/i.test(low) || /\bpoints (leaderboard|board|rank)\b/i.test(low)) {
    return { action: 'group_leaderboard', params: {} };
  }
  if (/\bcontest status\b/i.test(low) || /\b(active|running|current) contest\b/i.test(low) || /any contest (running|on|active)/i.test(low)) {
    return { action: 'contest_status', params: {} };
  }
  if (/\bglobal stats\b/i.test(low) || /\bbot stats\b/i.test(low) || /how many (users|groups|raids)/i.test(low)) {
    return { action: 'global_stats', params: {} };
  }
  if (/\bfeatured gems\b/i.test(low) || /\bgem list\b/i.test(low) || /\bcommunity gems\b/i.test(low)) {
    return { action: 'featured_gems', params: {} };
  }
  if (/\bhot gems\b/i.test(low) || /\btrending (gems|tokens)\b/i.test(low)) {
    return { action: 'hot_gems', params: {} };
  }

  // "check wallet 0x…" / "portfolio of 0x…"
  {
    const addr = /0x[0-9a-fA-F]{40}/.exec(text)?.[0] ?? null;
    if (addr && /\b(wallet|portfolio|balance of)\b/i.test(low)) {
      return { action: 'wallet_lookup', params: { address: addr } };
    }
  }

  // "debate BTC vs ETH" / "write a bull post about $PBAI" / "moon line"
  {
    const d = /\bdebate\b\s+(.+)$/i.exec(text);
    if (d) return { action: 'debate', params: { topic: d[1].trim().replace(/[?.!]+$/, '') } };
    const co = /\bcallout\b\s*(?:thread|post)?\s*(?:about\s+)?(.+)?$/i.exec(text);
    if (co) {
      return { action: 'post_writer', params: { kind: 'callout', topic: (co[1] ?? '').trim().replace(/[?.!]+$/, '') } };
    }
    const p = /\b(bull|bear|moon|fud|gem|meme|alpha|nft|defi)\s*post\b\s*(?:about\s+)?(.+)?$/i.exec(text);
    if (p) {
      return { action: 'post_writer', params: { kind: p[1].toLowerCase(), topic: (p[2] ?? '').trim().replace(/[?.!]+$/, '') } };
    }
    if (/\bmoon (line|caption|moment)\b/i.test(low) || /\bhype (line|caption)\b/i.test(low)) {
      return { action: 'moon_moment', params: {} };
    }
  }

  // "scan this 0x…" / "analyze PBAI" / "what do you think of <token>"
  {
    const m = /(?:\bscan\b|\banaly[sz]e\b|deep[\s-]?dive|what do you think of)\s*:?\s*(?:on\s+|this\s+|the\s+)?(\S[\s\S]{0,60})?$/i.exec(text);
    if (m) {
      const q = (m[1] ?? '').trim().replace(/[?.!]+$/, '').trim();
      return { action: 'token_scan', params: { query: q } };
    }
  }

  // "price of PBAI" / "what's <token> at" / "how much is <token>"
  {
    const m = /(?:^|\b)(?:price of|price check(?: on)?|check (?:the )?price(?: of)?)\s+\$?(.{1,60})$/i.exec(text)
      ?? /what'?s\s+(.+?)\s+at\??$/i.exec(text)
      ?? /how much is\s+(.+?)\??$/i.exec(text);
    if (m) {
      const token = m[1].trim().replace(/[?.!]+$/, '').trim();
      if (token) return { action: 'price_check', params: { token } };
    }
  }

  // "stop the recap" / "stop alert #3"
  {
    const m = /\bstop\b\s*(.*)$/i.exec(text);
    if (m && m[1].trim()) return { action: 'stop_job', params: { match: m[1].trim() } };
  }

  return null;
}

/** Single brain call → intent. Throws on brain failure so callers can fall
 *  back to the deterministic parser. `forceDeterministic` skips the brain
 *  (used for quota-independent verification). */
export async function classifyIntent(text, { forceDeterministic = false } = {}) {
  if (forceDeterministic) return normalizeIntent(deterministicClassify(text));
  const raw = await askBrain(`Classify this owner command:\n"""${String(text).slice(0, 500)}"""`, {
    systemPromptOverride: CLASSIFY_PROMPT,
    maxOutputTokens: 400,
  });
  const parsed = extractJson(raw);
  if (!parsed) throw new Error('classifier returned no JSON');
  return normalizeIntent(parsed);
}

// ── Decision layer (PB-DECISION-LAYER-DESIGN) ────────────────────────────────

/**
 * Batch 1 — SHADOW ONLY. Runs the nl_intent question set against the owner's
 * message and logs what decide() would have answered next to the incumbent
 * result that actually executed. Purely observational: nothing in the
 * incumbent path reads these answers, so user-visible behavior is identical
 * with the layer on or off. Also fires the skill_route set in shadow when
 * the owner has explicitly shadow-flagged it (Batch 2 calibration).
 */
async function shadowLogNlIntent(chatId, from, text, incumbent) {
  try {
    const inc = incumbent?.action ?? 'none';
    const out = await decide({
      surface: 'nlcmd', questionSet: 'nl_intent', mode: 'shadow',
      state: { conversation: twinConversation('nlcmd', 1), text: String(text ?? '') },
      actorId: String(from.id), chatId: String(chatId),
    });
    if (out.logId) {
      const decideIntent = out.answers?.intent?.value ?? null;
      await recordDecisionOutcome(out.logId, `incumbent:${inc}`, {
        outcomeNote: !out.ok
          ? `decide-failed:${out.reason}`
          : (decideIntent === inc ? 'agree' : `diverge:decide=${decideIntent ?? '?'}`),
      });
    }
    if (await getConfigFlag('decide_shadow_skill_route')) {
      const r = await decide({
        surface: 'skill_route', questionSet: 'skill_route', mode: 'shadow',
        state: { conversation: twinConversation('nlcmd', 1), text: String(text ?? ''), caller: 'owner' },
        actorId: String(from.id), chatId: String(chatId),
      });
      if (r.logId) {
        await recordDecisionOutcome(r.logId, `incumbent:${inc}`, {
          outcomeNote: r.ok ? `skill=${r.answers?.skill?.value ?? '?'}` : `decide-failed:${r.reason}`,
        });
      }
    }
  } catch (err) {
    console.error('[nlcmd decide shadow]', err?.message ?? err);
  }
}

/**
 * Batch 2 — skill routing, the classifier-of-record path. LIVE ONLY: this
 * returns null unless the skill_route set's posture is 'live' (owner flipped
 * decide_live_skill_route after Batch 1's shadow gate cleared). Ships gated
 * OFF — posture short-circuits before any decide() call, and the incumbent
 * classifier below runs exactly as before. Thresholds per design DP-3:
 * ≥ 0.85 route; 0.65–0.85 route only ungated skills; below → incumbent.
 * runSkill re-checks every gate server-side; the layer never grants access.
 */
async function trySkillRoute(chatId, from, text) {
  try {
    if ((await setPosture('skill_route')) !== 'live') return null;
    const out = await decide({
      surface: 'skill_route', questionSet: 'skill_route',
      state: { conversation: twinConversation('nlcmd', 1), text: String(text ?? ''), caller: 'owner' },
      actorId: String(from.id), chatId: String(chatId),
    });
    if (!out.ok || out.shadow) return null;
    const skill = out.answers?.skill;
    if (!skill) return null;
    const name = skill.value;
    if (!SKILL_ACTIONS.has(name)) {
      // create_flow / chat / other / a create intent → the incumbent
      // classifier owns those paths (creates keep their confirm flows).
      if (out.logId) await recordDecisionOutcome(out.logId, `route:${name}->incumbent`);
      return null;
    }
    const conf = skill.confidence;
    const midBandBlocked = conf < 0.85 && (SKILL_CATALOG[name]?.gate ?? 'none') !== 'none';
    if (conf < 0.65 || midBandBlocked) {
      if (out.logId) await recordDecisionOutcome(out.logId, `route:${name}-below-threshold->incumbent`);
      return null;
    }
    // Slot params: the deterministic parser's, when it lands on the same
    // action (its regex extraction is exact); otherwise address/topic only.
    const det = deterministicClassify(text);
    const addr = /0x[0-9a-fA-F]{40}/.exec(String(text))?.[0] ?? '';
    const params = det?.action === name
      ? det.params
      : { query: '', token: addr, address: addr, topic: String(text ?? '').slice(0, 200), kind: '' };
    if (out.logId) await recordDecisionOutcome(out.logId, `routed:${name}`);
    // Twin wave 1 (C10): a live routing action is memory-worthy — link
    // the memory row to the decide log row. Proposed-only (invisible to
    // retrieval), label-only, fail-open; the incumbent-fallback branches
    // above record no row because no action was taken.
    try {
      await recordSystemDecision({
        scope: 'owner', actorId: String(from.id), chatId: String(chatId),
        topicKey: 'skill-route', title: `Skill routed: ${name}`,
        decision: `Twin link: command routed to skill ${name} (live skill_route action)`,
        reasoning: null, status: 'proposed', reasonState: 'not_stated',
        decisionLogId: out.logId,
      });
    } catch { /* twin link failures never break routing */ }
    return { action: name, params };
  } catch (err) {
    console.error('[nlcmd skill route]', err?.message ?? err);
    return null;
  }
}

// ── Listing ───────────────────────────────────────────────────────────────────

async function ownerJobs(tgId) {
  let alerts = [], watches = [], agents = [];
  try {
    alerts = await db.select().from(price_alerts).where(eq(price_alerts.telegramUserId, tgId)).all();
  } catch { /* read as none */ }
  try {
    watches = await db.select().from(whale_watch_wallets).where(eq(whale_watch_wallets.telegramUserId, tgId)).all();
  } catch { /* read as none */ }
  try {
    agents = await db.select().from(user_agents).where(eq(user_agents.telegramUserId, tgId)).all();
  } catch { /* read as none */ }
  return { alerts, watches, agents };
}

function shortAddr(a) {
  const s = String(a ?? '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function listJobsText(jobs) {
  const lines = ["Here's what's running:"];
  lines.push(`🔔 Price alerts (${jobs.alerts.length}):`);
  for (const a of jobs.alerts) {
    lines.push(`• #${a.id} $${a.tokenName ?? 'TOKEN'} ${a.direction} $${a.targetPrice} (one-shot)`);
  }
  lines.push(`🐋 Whale watches (${jobs.watches.length}):`);
  for (const w of jobs.watches) {
    lines.push(`• #${w.id} ${shortAddr(w.walletAddress)}${w.label ? ` (${w.label})` : ''}`);
  }
  lines.push(`🤖 Agents (${jobs.agents.length}):`);
  for (const a of jobs.agents) {
    const cfg = a.config ?? {};
    lines.push(`• #${a.id} ${a.agentType} $${cfg.token_ticker ?? cfg.token_name ?? '?'} [${a.status}]`);
  }
  lines.push('', 'Say "stop the alert #3" to cancel one, or "stop everything" to clear the board.');
  return lines.join('\n');
}

// ── Execution ─────────────────────────────────────────────────────────────────

function ownerCtx(from) {
  return { initData: { user: from } };
}

function errText(err) {
  if (err instanceof EndpointError) return err.message;
  return 'PB hit a snag doing that — nothing was created. Try again.';
}

function fillPbaiDefaults(params) {
  const p = { ...params };
  if ((p.tokenName ?? '').toUpperCase().replace(/^\$/, '') === 'PBAI' && !p.tokenAddress) {
    p.tokenAddress = PBAI_CA;
  }
  return p;
}

async function executeCreateAlert(chatId, from, params) {
  const p = fillPbaiDefaults(params);
  const missing = [];
  if (!p.tokenAddress || !ADDR_RE.test(p.tokenAddress)) missing.push('tokenAddress');
  if (p.direction !== 'above' && p.direction !== 'below') missing.push('direction');
  if (!Number.isFinite(Number(p.targetPrice)) || Number(p.targetPrice) <= 0) missing.push('targetPrice');
  if (missing.length) return { needClarify: missing, params: p };
  let out;
  try {
    out = await createAlertEndpoint({
      tokenAddress: p.tokenAddress,
      tokenName: p.tokenName ?? 'TOKEN',
      direction: p.direction,
      targetPrice: Number(p.targetPrice),
    }, ownerCtx(from));
  } catch (err) {
    await sendSafe(chatId, `❌ ${errText(err)}`);
    return { done: true };
  }
  await sendSafe(chatId,
    `✅ Alert set — I'll ping you right here when $${out.tokenName ?? 'TOKEN'} goes ${out.direction} $${out.targetPrice}.\n` +
    `One-shot: it deletes itself after it fires. Say "stop the alert" anytime to cancel it.`);
  return { done: true };
}

async function executeCreateWatch(chatId, from, params) {
  const p = { ...params };
  if (!p.walletAddress || !ADDR_RE.test(p.walletAddress)) return { needClarify: ['walletAddress'], params: p };
  let out;
  try {
    out = await createWatchEndpoint({ walletAddress: p.walletAddress, label: p.label ?? '' }, ownerCtx(from));
  } catch (err) {
    await sendSafe(chatId, `❌ ${errText(err)}`);
    return { done: true };
  }
  await sendSafe(chatId,
    `✅ Watching ${shortAddr(out.walletAddress)} — I'll ping you here when it makes moves.\nSay "stop the watch" to cancel.`);
  return { done: true };
}

/**
 * Build the create_agent endpoint input from NL params. Returns
 * { input, problems } — problems is a list of missing/invalid fields.
 * The home community is a normal allowed target: the tick's agent executor
 * posts to it through a sealed single-target send (postAgentTargets in
 * lib/tick.js), while the postToGroups anti-bleed guard stays intact for
 * every other path. The literal marker 'home' resolves to the home chat id.
 */
async function buildAgentPlan(params) {
  const p = fillPbaiDefaults(params);
  const problems = [];
  const type = ['auto_shill', 'price_alert', 'daily_recap'].includes(p.agentType) ? p.agentType : null;
  if (!type) problems.push('agentType');
  if (!p.tokenName) problems.push('tokenName');
  if (!p.tokenAddress || !ADDR_RE.test(p.tokenAddress)) problems.push('tokenAddress');

  const homeId = String(await getConfig('TELEGRAM_HOME_CHAT_ID', ''));
  const groups = [];
  for (const g of [p.targetGroupHint, ...(Array.isArray(p.targetGroups) ? p.targetGroups : [])]) {
    let s = String(g ?? '').trim();
    if (s.toLowerCase() === 'home' && homeId) s = homeId; // 'home' marker → home chat id
    if (/^-?\d+$/.test(s) && !groups.includes(s)) groups.push(s);
  }
  if (!groups.length) problems.push('targetGroups');

  if (problems.length) return { input: null, problems, params: p };

  const input = {
    agentType: type,
    tokenName: String(p.tokenName).slice(0, 64),
    tokenTicker: String(p.tokenName).replace(/^\$/, '').slice(0, 16).toUpperCase() || 'TKN',
    contractAddress: p.tokenAddress,
    chain: 'base',
    targetGroups: groups,
  };
  if (type === 'auto_shill') {
    const ih = Number(p.intervalHours ?? 6);
    input.intervalHours = Number.isFinite(ih) && ih >= 1 && ih <= 168 ? ih : 6;
  }
  if (type === 'price_alert') {
    if (!Number.isFinite(Number(p.targetPrice)) || Number(p.targetPrice) <= 0) problems.push('targetPrice');
    if (p.direction !== 'above' && p.direction !== 'below') problems.push('direction');
    if (problems.length) return { input: null, problems, params: p };
    input.targetPrice = Number(p.targetPrice);
    input.direction = p.direction;
  }
  return { input, problems, params: p };
}

function agentSummary(type, input) {
  const nm = `$${input.tokenTicker} (${shortAddr(input.contractAddress)})`;
  if (type === 'auto_shill') {
    return `auto-shill agent for ${nm}\n• Posts every ${input.intervalHours} hours to: ${input.targetGroups.join(', ')}`;
  }
  if (type === 'daily_recap') {
    return `daily-recap agent for ${nm}\n• Posts a recap every ~24 hours (first one fires within minutes) to: ${input.targetGroups.join(', ')}`;
  }
  return `price-alert agent for ${nm}\n• Pings when price goes ${input.direction} $${input.targetPrice} to: ${input.targetGroups.join(', ')}`;
}

async function executeCreateAgent(chatId, from, params, confirmed) {
  const plan = await buildAgentPlan(params);
  if (plan.problems.length) return { needClarify: plan.problems, params: plan.params ?? params };

  if (!confirmed) {
    const summary = agentSummary(plan.input.agentType, plan.input);
    await setConfig(pendingKey(String(from.id)), JSON.stringify({
      kind: 'confirm_agent', params, askedAt: Date.now(),
    }));
    await sendSafe(chatId, `📝 Here's what I'll set up:\n\n${summary}\n\nReply "yes" to activate, or "no" to cancel — or tap ✏️ Edit and send a revised instruction.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Yes, set it up', callback_data: 'nlcmd:yes' }, { text: '✏️ Edit', callback_data: 'nlcmd:aedit' }, { text: '❌ No', callback_data: 'nlcmd:no' }],
        ],
      },
    });
    return { done: true };
  }

  let out;
  try {
    out = await createAgentEndpoint(plan.input, ownerCtx(from));
  } catch (err) {
    await sendSafe(chatId, `❌ ${errText(err)}`);
    return { done: true };
  }
  await sendSafe(chatId,
    `✅ Agent #${out.id} (${out.type}) is active — the clock picks it up within minutes.\nSay "stop agent #${out.id}" to cancel it.`);
  return { done: true };
}

async function executeListJobs(chatId, tgId) {
  await sendSafe(chatId, listJobsText(await ownerJobs(tgId)));
  return { done: true };
}

// ── Broadcast (plain-English, owner DM) ───────────────────────────────────────
// Detection only OPENS this setup. The announcement goes out exclusively
// from the ✅ Send it button (handleNlcmdBroadcastCallback) — typed text can
// cancel or replace the draft, never fire it. The pending state holds the
// exact text under the shared pending key (30-min TTL via readJsonKey).

async function showBroadcastConfirm(chatId, from, text) {
  let groups;
  try {
    groups = await listKnownGroups();
  } catch (err) {
    await sendSafe(chatId, `❌ DB error fetching groups: ${String(err?.message ?? err)}`);
    return;
  }
  if (!groups.length) {
    await sendSafe(chatId,
      '⚠️ No known groups yet. Groups appear here once the bot is added and active in them.');
    return;
  }
  await setConfig(pendingKey(String(from.id)), JSON.stringify({
    kind: 'confirm_broadcast', text, askedAt: Date.now(),
  }));
  await sendSafe(chatId,
    '📡 Broadcast — here\'s exactly what will go out:\n\n' +
    `"${text}"\n\n` +
    `👥 Will send to ${groups.length} groups.\n\n` +
    (looksTemplated(text) ? '⚠️ Warning: this text looks templated/placeholder-like — check it before tapping Send it. A placeholder is refused at send time even if you tap Send it.\n\n' : '') +
    'Nothing has been sent yet — it only goes out if you tap Send it.', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Send it', callback_data: 'nlcmd:bsend' },
          { text: '✏️ Edit', callback_data: 'nlcmd:bedit' },
          { text: '❌ Cancel', callback_data: 'nlcmd:bcancel' },
        ]],
      },
    });
}

async function executeBroadcastIntent(chatId, from, params) {
  // broadcastText is the clarify-filled field; it wins over the (possibly
  // empty-string) text param the clarify state was seeded with.
  const text = String(params.broadcastText || params.text || '').trim();
  if (!text) return { needClarify: ['broadcastText'], params: { ...params, text: '' } };
  await showBroadcastConfirm(chatId, from, text);
  return { done: true };
}

// ── DM Broadcast (plain-English, owner DM) ────────────────────────────────────
// Same discipline as the group broadcast above: detection only OPENS this
// setup; the job is created exclusively from the ✅ Send it button
// (handleNlcmdDmBroadcastCallback). Typed text can cancel or replace the
// draft, never fire it. The confirm card shows the EXACT text and the true
// bot-user count read at card time; the job snapshots the recipients again
// at creation, so the receipt's Total is the snapshot's own count.

/** The DM broadcast confirm card's exact wording (exported for proofs). */
export function dmBroadcastConfirmText(text, total) {
  return '📨 DM Broadcast — here\'s exactly what will go out:\n\n' +
    `"${text}"\n\n` +
    `👥 Will DM ${total} users (everyone who has started PB).\n\n` +
    'Nothing has been sent yet — it only goes out if you tap Send it.';
}

async function showDmBroadcastConfirm(chatId, from, text) {
  let total;
  try {
    total = await db.$count(bot_users);
  } catch (err) {
    await sendSafe(chatId, `❌ DB error counting users: ${String(err?.message ?? err)}`);
    return;
  }
  if (!total) {
    await sendSafe(chatId, '⚠️ No bot users yet — nobody has started the bot, so there is nobody to DM.');
    return;
  }
  await setConfig(pendingKey(String(from.id)), JSON.stringify({
    kind: 'confirm_dm_broadcast', text, askedAt: Date.now(),
  }));
  await sendSafe(chatId, dmBroadcastConfirmText(text, total), {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Send it', callback_data: 'nlcmd:dbsend' },
        { text: '✏️ Edit', callback_data: 'nlcmd:dbedit' },
        { text: '❌ Cancel', callback_data: 'nlcmd:dbcancel' },
      ]],
    },
  });
}

async function executeDmBroadcastIntent(chatId, from, params) {
  const text = String(params.broadcastText || params.text || '').trim();
  if (!text) return { needClarify: ['broadcastText'], params: { ...params, text: '' } };
  await showDmBroadcastConfirm(chatId, from, text);
  return { done: true };
}

/** Every action that routes to the skills registry (lib/skills.js). The
 *  2026-10-20 expansion added the new read skills; gates live in the
 *  skills themselves, exactly as they do for the bot commands. */
const SKILL_ACTIONS = new Set([
  'token_scan', 'price_check', 'community_stats', 'my_rank', 'global_standings',
  'ta_overview', 'rsi_check', 'macd_check', 'bollinger_check', 'hot_gems', 'wallet_lookup',
  'security_scan', 'my_points', 'my_tier', 'my_wallet', 'holder_status', 'my_alerts',
  'my_watched', 'my_invite', 'my_digest', 'business_status', 'my_campaign', 'group_leaderboard',
  'my_squad', 'contest_status', 'global_stats', 'featured_gems', 'post_writer',
  'debate', 'moon_moment',
]);

/** v2 skill intents: private, read-only answers — execute immediately and
 *  reply with the skill's own plain-English text (that text IS the receipt).
 *  token_scan carries the /analyze tier gate inside the skill; while the
 *  brain quota is out it answers with /analyze's exact failure string. */
async function executeSkillIntent(chatId, from, action, params) {
  // Uniform arg pass-through (skills expansion): each skill reads the keys
  // it understands; unknown keys are ignored by the registry contract.
  const skillArgs = {
    query: params.query ?? params.token ?? '',
    token: params.token ?? params.query ?? '',
    address: params.address ?? '',
    topic: params.topic ?? params.query ?? '',
    kind: params.kind ?? '',
  };
  const res = await runSkill(action, { from, chatId, chatType: 'private' }, skillArgs);
  // Edge wave #2: a token_scan that resolved an address carries the same
  // verdict-card button /analyze attaches (callback in callback_query.js).
  const scanAddr = action === 'token_scan' ? res?.data?.token?.address : null;
  // Gap-2 voice notes: a successful skill answer also carries the 🔊 Hear
  // it button (this path is owner-DM only). prepareVoiceAnswer never
  // throws; gated/failed skill outputs are not answers and get no button.
  const voiceMarkup = res?.ok
    ? await prepareVoiceAnswer(from.id, chatId, res.text).catch(() => null)
    : null;
  const rows = [];
  if (scanAddr) rows.push([{ text: '🪪 Verdict card', callback_data: 'vcard:' + scanAddr }]);
  if (voiceMarkup) rows.push(...voiceMarkup.inline_keyboard);
  if (rows.length) {
    await sendSafe(chatId, res.text, { reply_markup: { inline_keyboard: rows } });
  } else {
    await sendSafe(chatId, res.text);
  }
  // Gap-1 card companion (price / TA / rank): fires only now that the text
  // answer has landed, rendered from the skill's own data. Best-effort —
  // sendSkillCardCompanion never throws.
  await sendSkillCardCompanion(action, res, chatId, from).catch(() => {});
  return true;
}

async function executeStopJob(chatId, from, match) {
  const tgId = String(from.id);
  const m = String(match ?? '').toLowerCase();
  if (/everything|all\b/.test(m) && !/#\d/.test(m) && !/0x/i.test(m)) {
    const jobs = await ownerJobs(tgId);
    const total = jobs.alerts.length + jobs.watches.length + jobs.agents.length;
    if (!total) { await sendSafe(chatId, 'Nothing is running — the board is already clear.'); return { done: true }; }
    let killed = 0;
    for (const a of jobs.alerts) {
      try { await deleteAlertEndpoint({ id: a.id }, ownerCtx(from)); killed++; } catch { /* keep going */ }
    }
    for (const w of jobs.watches) {
      try { await deleteWatchEndpoint({ id: w.id }, ownerCtx(from)); killed++; } catch { /* keep going */ }
    }
    for (const a of jobs.agents) {
      try { await deleteAgentEndpoint({ id: a.id }, ownerCtx(from)); killed++; } catch { /* keep going */ }
    }
    await sendSafe(chatId, `🧹 Cleared — stopped ${killed} job${killed === 1 ? '' : 's'}. The board is empty.`);
    return { done: true };
  }

  const jobs = await ownerJobs(tgId);
  const idNum = /#(\d+)/.exec(m)?.[1];
  const addr = /0x[0-9a-fA-F]{40}/.exec(m)?.[0]?.toLowerCase();
  const cands = [];
  const kindOf = (label) => (/alert/.test(m) ? 'alert' : (/watch/.test(m) ? 'watch'
    : (/recap/.test(m) ? 'recap' : (/shill/.test(m) ? 'shill'
      : (/agent/.test(m) ? 'agent' : label)))));
  for (const a of jobs.alerts) {
    const label = `alert #${a.id} $${a.tokenName ?? 'TOKEN'} ${a.direction} $${a.targetPrice}`;
    if (idNum && Number(idNum) === a.id) cands.push({ kind: 'alert', id: a.id, label });
    else if (addr && String(a.tokenAddress).toLowerCase() === addr) cands.push({ kind: 'alert', id: a.id, label });
    else if (!idNum && !addr && kindOf('alert') === 'alert') cands.push({ kind: 'alert', id: a.id, label });
  }
  for (const w of jobs.watches) {
    const label = `watch #${w.id} ${shortAddr(w.walletAddress)}`;
    if (idNum && Number(idNum) === w.id) cands.push({ kind: 'watch', id: w.id, label });
    else if (addr && String(w.walletAddress).toLowerCase() === addr) cands.push({ kind: 'watch', id: w.id, label });
    else if (!idNum && !addr && kindOf('watch') === 'watch') cands.push({ kind: 'watch', id: w.id, label });
  }
  for (const a of jobs.agents) {
    const cfg = a.config ?? {};
    const label = `agent #${a.id} ${a.agentType} $${cfg.token_ticker ?? cfg.token_name ?? '?'} [${a.status}]`;
    const typeHit = (m.includes('recap') && a.agentType === 'daily_recap')
      || (m.includes('shill') && a.agentType === 'auto_shill')
      || (m.includes('agent') && !m.includes('recap') && !m.includes('shill'));
    if (idNum && Number(idNum) === a.id) cands.push({ kind: 'agent', id: a.id, label });
    else if (addr && String(cfg.contract_address ?? '').toLowerCase() === addr) cands.push({ kind: 'agent', id: a.id, label });
    else if (!idNum && !addr && typeHit) cands.push({ kind: 'agent', id: a.id, label });
  }

  if (!cands.length) {
    await sendSafe(chatId, `Couldn't find anything matching "${match}". Say "what's running?" to see the board.`);
    return { done: true };
  }
  if (cands.length === 1) {
    const c = cands[0];
    try {
      if (c.kind === 'alert') await deleteAlertEndpoint({ id: c.id }, ownerCtx(from));
      else if (c.kind === 'watch') await deleteWatchEndpoint({ id: c.id }, ownerCtx(from));
      else await deleteAgentEndpoint({ id: c.id }, ownerCtx(from));
    } catch (err) {
      await sendSafe(chatId, `❌ ${errText(err)}`);
      return { done: true };
    }
    await sendSafe(chatId, `🛑 Stopped — ${c.label} is gone.`);
    return { done: true };
  }
  await setConfig(clarifyKey(tgId), JSON.stringify({ kind: 'stop_pick', candidates: cands, askedAt: Date.now() }));
  await sendSafe(chatId,
    `That matches ${cands.length} jobs:\n${cands.map((c) => `• ${c.label}`).join('\n')}\n\nWhich one? Reply with the #id.`);
  return { done: true };
}

// ── Clarifying questions ──────────────────────────────────────────────────────

const CLARIFY_Q = {
  broadcastText: 'What should the announcement say?',
  targetPrice: 'What price should trigger it? (e.g. "below $1" or "above $5")',
  direction: 'Above or below that price?',
  tokenAddress: 'Which token? Paste the contract address (0x…), or say PBAI.',
  walletAddress: 'Which wallet? Paste the address (0x…).',
  agentType: 'What kind of agent — auto_shill, daily_recap, or price_alert?',
  tokenName: 'Which token is it for? (name or ticker, e.g. PBAI)',
  targetGroups: 'Which group should it post to? Paste the chat id (numbers, starts with -), or say "home" / "the main group".',
};

function fillFromReply(action, params, missing, text) {
  const p = { ...params };
  const still = [];
  const low = text.toLowerCase();
  for (const f of missing) {
    if (f === 'broadcastText') {
      const t = text.trim();
      if (t) { p.broadcastText = t.slice(0, 2000); continue; }
    }
    if (f === 'targetPrice') {
      const n = /[\d][\d,]*\.?\d*/.exec(text.replace(/,/g, ''))?.[0];
      if (n && Number(n) > 0) { p.targetPrice = Number(n); continue; }
    }
    if (f === 'direction') {
      if (/below|under|beneath|drop|fall|dip/i.test(text)) { p.direction = 'below'; continue; }
      if (/above|over|past|rise|climb/i.test(text)) { p.direction = 'above'; continue; }
    }
    if (f === 'tokenAddress') {
      const a = /0x[0-9a-fA-F]{40}/.exec(text)?.[0];
      if (a) { p.tokenAddress = a; continue; }
      if (/\$?pbai\b/i.test(text)) { p.tokenAddress = PBAI_CA; p.tokenName = 'PBAI'; continue; }
    }
    if (f === 'walletAddress') {
      const a = /0x[0-9a-fA-F]{40}/.exec(text)?.[0];
      if (a) { p.walletAddress = a; continue; }
    }
    if (f === 'tokenName') {
      const t = /\$?[a-z0-9]{2,12}\b/i.exec(text)?.[0];
      if (t) { p.tokenName = t.replace(/^\$/, '').toUpperCase(); continue; }
    }
    if (f === 'agentType') {
      if (/shill/i.test(text)) { p.agentType = 'auto_shill'; continue; }
      if (/recap/i.test(text)) { p.agentType = 'daily_recap'; continue; }
      if (/alert/i.test(text)) { p.agentType = 'price_alert'; continue; }
    }
    if (f === 'targetGroups') {
      if (/(the\s+)?(main|home)\s+(group|community)|poorboyai\s+(group|community)|official\s+poorboyai/i.test(text)) { p.targetGroupHint = 'home'; continue; }
      const g = /-?\d{6,}/.exec(text)?.[0];
      if (g) { p.targetGroupHint = g; continue; }
    }
    still.push(f);
  }
  return { params: p, still };
}

async function askClarify(chatId, tgId, action, params, missing) {
  await setConfig(clarifyKey(tgId), JSON.stringify({ kind: 'clarify', action, params, missing, askedAt: Date.now() }));
  await sendSafe(chatId, `🤔 Almost — I need one thing: ${CLARIFY_Q[missing[0]] ?? 'more detail.'}`);
}

async function resolveClarify(chatId, from, state, text) {
  const tgId = String(from.id);
  if (state.kind === 'stop_pick') {
    const idNum = /#?(\d+)/.exec(text)?.[1];
    const c = (state.candidates ?? []).find((x) => String(x.id) === String(idNum));
    if (!c) {
      await sendSafe(chatId, 'Didn\'t catch which one — reply with the #id.');
      return true;
    }
    await clearJsonKey(clarifyKey(tgId));
    await executeStopJob(chatId, from, `#${c.id}`);
    return true;
  }
  if (state.kind === 'clarify') {
    const { params, still } = fillFromReply(state.action, state.params, state.missing, text);
    if (still.length) {
      await askClarify(chatId, tgId, state.action, params, still);
      return true;
    }
    await clearJsonKey(clarifyKey(tgId));
    await executeIntent(chatId, from, { action: state.action, params }, false);
    return true;
  }
  return false;
}

// ── Intent dispatch ───────────────────────────────────────────────────────────

async function executeIntent(chatId, from, intent, confirmed) {
  const tgId = String(from.id);
  const { action, params } = intent;
  if (action === 'create_alert') {
    const r = await executeCreateAlert(chatId, from, params);
    if (r.needClarify?.length) await askClarify(chatId, tgId, 'create_alert', r.params, r.needClarify);
    return true;
  }
  if (action === 'create_watch') {
    const r = await executeCreateWatch(chatId, from, params);
    if (r.needClarify?.length) await askClarify(chatId, tgId, 'create_watch', r.params, r.needClarify);
    return true;
  }
  if (action === 'create_agent') {
    const r = await executeCreateAgent(chatId, from, params, confirmed);
    if (r.needClarify?.length) await askClarify(chatId, tgId, 'create_agent', r.params, r.needClarify);
    return true;
  }
  if (action === 'broadcast') {
    const r = await executeBroadcastIntent(chatId, from, params);
    if (r.needClarify?.length) await askClarify(chatId, tgId, 'broadcast', r.params, r.needClarify);
    return true;
  }
  if (action === 'dm_broadcast') {
    const r = await executeDmBroadcastIntent(chatId, from, params);
    if (r.needClarify?.length) await askClarify(chatId, tgId, 'dm_broadcast', r.params, r.needClarify);
    return true;
  }
  if (action === 'list_jobs') { await executeListJobs(chatId, tgId); return true; }
  if (action === 'stop_job') { await executeStopJob(chatId, from, params.match ?? ''); return true; }
  if (SKILL_ACTIONS.has(action)) {
    return executeSkillIntent(chatId, from, action, params);
  }
  return false;
}

/**
 * Owner-DM natural-language entry. Returns true when the message was handled
 * (caller should stop); false to fall through to normal chat. Callers must
 * already have verified: private chat + owner + non-command text.
 */
export async function handleOwnerNLCommand(chatId, msg, text) {
  const from = msg.from;
  const tgId = String(from.id);

  // Agent Loop Phase A: an ACTIVE loop owns its control words first
  // (stop/cancel halt it; while it waits on a confirm tap, typed text can
  // cancel it but never fire it — the same rule as the broadcast confirm).
  // With no active loop this returns false instantly and the incumbent
  // single-intent flow below runs byte-identically.
  try {
    if (await handleAgentActiveMessage(chatId, msg, text)) return true;
  } catch (err) {
    console.error('[agentloop active]', err?.message ?? err);
  }

  // A pending confirmation gets yes/no; anything else keeps it and is treated
  // as a new request.
  const pending = await readJsonKey(pendingKey(tgId));
  if (pending?.kind === 'confirm_agent') {
    // Gap-3 edit arm (the broadcast pattern): while an edit is awaited,
    // the owner's next message REPLACES the instruction — it can cancel
    // or rebuild the setup, never fire it. A typed "yes" mid-edit is
    // just edit text and lands in the refusal copy below.
    if (pending.awaitingEdit) {
      const trimmed = text.trim();
      if (/^(n|no|cancel|never ?mind|stop)\b/i.test(trimmed)) {
        await clearJsonKey(pendingKey(tgId));
        await sendSafe(chatId, 'Got it — nothing was created.');
        return true;
      }
      if (trimmed) {
        await applyAgentEdit(chatId, from, trimmed);
        return true;
      }
      return true; // empty edit — keep waiting for the revised instruction
    }
    if (/^(y|yes|do it|confirm|sure|ok|okay|yeah)\b/i.test(text.trim())) {
      await clearJsonKey(pendingKey(tgId));
      await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
      await executeIntent(chatId, from, { action: 'create_agent', params: pending.params }, true);
      return true;
    }
    if (/^(n|no|cancel|never ?mind|stop)\b/i.test(text.trim())) {
      await clearJsonKey(pendingKey(tgId));
      await sendSafe(chatId, 'Got it — nothing was created.');
      return true;
    }
  }

  // A pending broadcast confirm: typed text can cancel it, or — while an
  // edit is awaited — replace the draft. It can NEVER fire it; only the
  // ✅ Send it button executes. Anything else leaves the confirm in place
  // and is treated as a new request below.
  if (pending?.kind === 'confirm_broadcast') {
    const trimmed = text.trim();
    if (/^(cancel|never ?mind|stop)\b/i.test(trimmed)) {
      await clearJsonKey(pendingKey(tgId));
      await sendSafe(chatId, 'Broadcast cancelled — nothing sent.');
      return true;
    }
    if (pending.awaitingEdit) {
      if (trimmed) {
        await showBroadcastConfirm(chatId, from, trimmed);
        return true;
      }
      return true; // empty edit — keep waiting for the new text
    }
  }

  // A pending DM broadcast confirm: same rules as the group one — typed
  // text can cancel it or (mid-edit) replace the draft; only the button
  // can fire it.
  if (pending?.kind === 'confirm_dm_broadcast') {
    const trimmed = text.trim();
    if (/^(cancel|never ?mind|stop)\b/i.test(trimmed)) {
      await clearJsonKey(pendingKey(tgId));
      await sendSafe(chatId, 'DM broadcast cancelled — nothing sent.');
      return true;
    }
    if (pending.awaitingEdit) {
      if (trimmed) {
        await showDmBroadcastConfirm(chatId, from, trimmed);
        return true;
      }
      return true; // empty edit — keep waiting for the new text
    }
  }

  // A pending clarifying question gets answered first.
  const clarify = await readJsonKey(clarifyKey(tgId));
  if (clarify && await resolveClarify(chatId, from, clarify, text)) return true;

  // Agent Loop Phase A: a multi-step goal (2+ actionable steps in one
  // message) starts the loop. Single-intent messages never build a plan
  // and fall through to the incumbent classification below, untouched.
  // Runs after pending/clarify so an answer to an open question can never
  // be mistaken for a new goal, and before the broadcast shortcut so a
  // goal that merely CONTAINS a broadcast step keeps the whole plan
  // together (the broadcast still only fires from its loop confirm tap).
  try {
    if (await maybeStartAgentLoop(chatId, from, text)) return true;
  } catch (err) {
    console.error('[agentloop start]', err?.message ?? err);
  }

  // Broadcast intent is matched deterministically FIRST: it's a public,
  // all-groups action, so opening its setup must not depend on the brain
  // being up or agreeing. This only opens the confirm step — execution
  // still requires the owner's Send tap and nothing else.
  const detBroadcast = deterministicClassify(text);
  if (detBroadcast?.action === 'broadcast' || detBroadcast?.action === 'dm_broadcast') {
    await shadowLogNlIntent(chatId, from, text, detBroadcast);
    return executeIntent(chatId, from, detBroadcast, false);
  }

  // Decision layer, Batch 2 (ships gated OFF): when skill_route is live,
  // decide() routes straight to a read-only skill. Otherwise this is null
  // and the incumbent classification below runs untouched.
  const routed = await trySkillRoute(chatId, from, text);
  if (routed) {
    await shadowLogNlIntent(chatId, from, text, routed);
    return executeIntent(chatId, from, routed, false);
  }

  // Classify: one brain call; deterministic fallback when the brain is down.
  let intent;
  try {
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
    intent = await classifyIntent(text);
  } catch (err) {
    console.error('[nlcmd classify]', err?.message ?? err);
    intent = normalizeIntent(deterministicClassify(text));
  }
  // Decision layer, Batch 1 (SHADOW): log decide()'s nl_intent answers
  // alongside the incumbent result for calibration. Observational only —
  // the incumbent intent is what executes, exactly as before the layer.
  await shadowLogNlIntent(chatId, from, text, intent);
  if (!intent || intent.action === 'none') return false;
  return executeIntent(chatId, from, intent, false);
}

/** Inline-button confirm handler for callback_query.js. */
export async function handleNlcmdCallback(query, yes) {
  const from = query.from;
  const chatId = query.message?.chat?.id ?? from?.id;
  const tgId = String(from?.id);
  const pending = await readJsonKey(pendingKey(tgId));
  // Gap-3: a stale ✅ tap mid-edit must not fire the create with the OLD
  // instruction (the broadcast mid-edit Send rule). The pending survives.
  if (yes && pending?.kind === 'confirm_agent' && pending.awaitingEdit) {
    await sendSafe(chatId, 'You\'re mid-edit on that agent — send the revised instruction first, then tap Yes on the fresh confirm.');
    return;
  }
  await clearJsonKey(pendingKey(tgId));
  if (yes && pending?.kind === 'confirm_agent') {
    await sendSafe(chatId, 'On it — setting it up now.');
    await executeIntent(chatId, from, { action: 'create_agent', params: pending.params }, true);
  } else {
    await sendSafe(chatId, 'Got it — nothing was created.');
  }
}

/**
 * Gap-3: consume a revised instruction for a pending confirm_agent. The
 * owner's sentence IS the instruction — create_agent params are derived
 * from it — so the sentence is re-parsed through the same classifiers
 * that produced the original params, validated by buildAgentPlan, and
 * the pending's params are replaced; the confirm card re-renders with
 * the new summary (executeCreateAgent's unconfirmed path). Anything
 * that doesn't parse as a buildable agent setup is refused with the
 * original pending left intact — the draft survives for another edit.
 */
async function applyAgentEdit(chatId, from, text) {
  let intent = deterministicClassify(text);
  if (intent?.action !== 'create_agent') {
    try { intent = await classifyIntent(text); } catch { intent = null; }
  }
  if (intent?.action !== 'create_agent') {
    await sendSafe(chatId,
      'That doesn\'t read as an agent setup — send the full revised instruction (what to run, for which token, where to post), or say "cancel" to scrap it. Your original setup is still waiting.');
    return;
  }
  const plan = await buildAgentPlan(intent.params);
  if (plan.problems.length) {
    await sendSafe(chatId,
      `I almost have it — still missing: ${plan.problems.join(', ')}. Send the full instruction once more, or say "cancel". Your original setup is still saved.`);
    return;
  }
  await executeIntent(chatId, from, { action: 'create_agent', params: intent.params }, false);
}

/** ✏️ Edit button on the create_agent confirm card (owner-gated in
 *  callback_query.js, exactly like the other nlcmd buttons). Arms the
 *  edit on the pending state; the owner's next message is consumed by
 *  handleOwnerNLCommand's awaitingEdit branch above. */
export async function handleNlcmdAgentEditCallback(query) {
  const from = query.from;
  const chatId = query.message?.chat?.id ?? from?.id;
  const tgId = String(from?.id);
  const pending = await readJsonKey(pendingKey(tgId));
  if (!pending || pending.kind !== 'confirm_agent') {
    await sendSafe(chatId,
      'That agent setup expired — nothing was created. Say the instruction again and I\'ll set it up fresh.');
    return;
  }
  await setConfig(pendingKey(tgId), JSON.stringify({ ...pending, awaitingEdit: true, askedAt: Date.now() }));
  await sendSafe(chatId,
    '✏️ Send me the revised instruction — I\'ll rebuild the setup from it and show it back to you for a final yes before anything is created. (Say "cancel" to scrap it.)');
}

/**
 * Inline-button handler for the broadcast confirm step (Send / Edit /
 * Cancel). callback_query.js gates it to the owner before calling, exactly
 * like handleNlcmdCallback. This is the ONLY path that can execute a
 * plain-English broadcast.
 */
export async function handleNlcmdBroadcastCallback(query, action) {
  const from = query.from;
  const chatId = query.message?.chat?.id ?? from?.id;
  const tgId = String(from?.id);
  const pending = await readJsonKey(pendingKey(tgId));

  if (!pending || pending.kind !== 'confirm_broadcast') {
    await sendSafe(chatId,
      'That broadcast setup expired — nothing was sent. Say the announcement again and I\'ll set it up fresh.');
    return;
  }

  if (action === 'cancel') {
    await clearJsonKey(pendingKey(tgId));
    await sendSafe(chatId, 'Broadcast cancelled — nothing sent.');
    return;
  }

  if (action === 'edit') {
    await setConfig(pendingKey(tgId), JSON.stringify({ ...pending, awaitingEdit: true, askedAt: Date.now() }));
    await sendSafe(chatId,
      '✏️ Send me the new announcement text — I\'ll show it back to you for confirmation before anything goes out. (Say "cancel" to scrap it.)');
    return;
  }

  if (action === 'send') {
    if (pending.awaitingEdit) {
      await sendSafe(chatId,
        'You\'re mid-edit on that broadcast — send me the new text first, then tap Send on the fresh confirm.');
      return;
    }
    // Consume the pending state BEFORE executing: a second tap (or a
    // stale button on an old message) finds nothing and cannot re-send.
    await clearJsonKey(pendingKey(tgId));
    let result;
    try {
      result = await executeBroadcast(String(pending.text ?? ''));
    } catch (err) {
      await sendSafe(chatId, `❌ Broadcast failed — DB error fetching groups: ${String(err?.message ?? err)}`);
      return;
    }
    if (result.refused) {
      await sendSafe(chatId, broadcastReceiptText(result));
      return;
    }
    if (!result.total) {
      await sendSafe(chatId,
        '⚠️ No known groups yet. Groups appear here once the bot is added and active in them.');
      return;
    }
    const receipt = broadcastReceiptText(result);
    await sendSafe(chatId, receipt);
    // Record the system's own receipt in PB's conversation memory, so his
    // later answers about this broadcast report what the system actually
    // did — never his own assumption (Hard Honesty Rule). The [system]
    // label is what lets the brain tell a real system result apart from
    // its own earlier words (see brain.js, BROADCASTS & ANNOUNCEMENTS).
    // Best-effort: the receipt above is the record that matters.
    try {
      const userKey = await resolveUserKey('telegram', from.id);
      await saveMessage(userKey, 'assistant', `[system] Broadcast result posted by the system:\n${receipt}`, 'telegram');
    } catch { /* memory write is best-effort */ }
  }
}

/**
 * Inline-button handler for the DM broadcast confirm step (Send / Edit /
 * Cancel). callback_query.js gates it to the owner before calling, exactly
 * like handleNlcmdBroadcastCallback. This is the ONLY path that can create
 * a DM broadcast job from plain English: Send snapshots the recipients and
 * starts the job; the tick's dmBroadcast cycle does the sending and the
 * receipt DM comes from the engine when the job completes.
 */
export async function handleNlcmdDmBroadcastCallback(query, action) {
  const from = query.from;
  const chatId = query.message?.chat?.id ?? from?.id;
  const tgId = String(from?.id);
  const pending = await readJsonKey(pendingKey(tgId));

  if (!pending || pending.kind !== 'confirm_dm_broadcast') {
    await sendSafe(chatId,
      'That DM broadcast setup expired — nothing was sent. Say the announcement again and I\'ll set it up fresh.');
    return;
  }

  if (action === 'cancel') {
    await clearJsonKey(pendingKey(tgId));
    await sendSafe(chatId, 'DM broadcast cancelled — nothing sent.');
    return;
  }

  if (action === 'edit') {
    await setConfig(pendingKey(tgId), JSON.stringify({ ...pending, awaitingEdit: true, askedAt: Date.now() }));
    await sendSafe(chatId,
      '✏️ Send me the new announcement text — I\'ll show it back to you for confirmation before anything goes out. (Say "cancel" to scrap it.)');
    return;
  }

  if (action === 'send') {
    if (pending.awaitingEdit) {
      await sendSafe(chatId,
        'You\'re mid-edit on that DM broadcast — send me the new text first, then tap Send on the fresh confirm.');
      return;
    }
    // Consume the pending state BEFORE creating the job: a second tap (or
    // a stale button on an old message) finds nothing and cannot re-fire.
    await clearJsonKey(pendingKey(tgId));
    let created;
    try {
      created = await createDmBroadcastJob(String(pending.text ?? ''), from.id);
    } catch (err) {
      await sendSafe(chatId, `❌ DM broadcast failed — DB error creating the job: ${String(err?.message ?? err)}`);
      return;
    }
    if (created.error === 'already_running') {
      await sendSafe(chatId,
        `⏳ Job #${created.job.id} is already running — one DM broadcast at a time. /dmstop halts it first.`);
      return;
    }
    await sendSafe(chatId,
      `📨 DM broadcast started — job #${created.job.id} to ${created.total} users.\n` +
      'It sends in batches on PB\'s clock; I\'ll DM you the receipt when it finishes. /dmstop halts it.');
  }
}

// ══ AGENT LOOP — Phase A (2026-10-21, Rowdy-approved) ════════════════════════
//
// Upgrades the owner-DM plain-English layer from one sentence → one command
// to goal → plan → execute → observe → receipt. OWNER DM ONLY: the sole
// entry points are handleOwnerNLCommand (which handlers/message.js already
// gates to owner + private chat) and handleAgentCallback (owner-gated in
// handlers/callback_query.js). Group chats and other users never reach
// this code and their behavior is byte-identical.
//
// Rails (hard, mirroring the decision layer's Class N discipline):
// - readonly steps (the skills registry + own-data reads): hands-off.
// - internal steps (the owner's own alerts/watches/jobs): hands-off.
// - outward steps (broadcast, posting to a group, creating a posting
//   agent): the loop PAUSES and shows a confirm card with the exact
//   content; execution happens only from the ✅ button — typed text can
//   cancel the loop, never fire an outward step (the broadcast rule).
// - forbidden steps (money / arm / grants / keys / moderation / winners):
//   NEVER executed — the step is marked refused in the plan up front and
//   in the receipt; Rowdy runs those himself.
// - unsupported steps (no real executor exists): named in the plan up
//   front and skipped — never faked, never resurrected as a marker.
// Bounds: MAX_AGENT_STEPS steps per goal, ONE retry per step, durable
// state in the config table under agentloop_<tgId> (same 30-min TTL
// discipline as the nlcmd pending states), plain-English stop + a Stop
// button that actually halt. The finish is a system-posted receipt whose
// numbers are the executors' own outputs, mirrored into memory with the
// [system] label exactly like the broadcast receipt.

const AGENT_KEY = (tgId) => `agentloop_${tgId}`;
const MAX_AGENT_STEPS = 8;
const AGENT_RESULT_SLICE = 500;

// Class N screen: any segment whose words touch money movement, arming,
// grants, keys, moderation, or winners is refused before any planning.
const FORBIDDEN_RE = /\b(arm|disarm|grant|revoke|setkey|api[ _-]?key|secret|private[ _-]?key|seed phrase|mnemonic|send (money|eth|sol|usdc|usdt|tokens?|crypto)|transfer|withdraw|cash[ _-]?out|pay (out|him|her|them|the)|payout|refund (to|him|her|them)|tier (grant|upgrade|change)|set (his|her|their|the) tier|ban|kick|mute|unban|winner|prize (money|cash|tokens?)|delete (the )?(group|user|account)|give (him|her|them|away)|airdrop (arm|send|distribute)|boost (arm|send))\b/i;

// Test seam (harness only): when set, skill steps run through this runner
// instead of the real registry, so in-isolate proofs can assert the receipt
// carries the executors' exact outputs. Production never sets it.
let agentSkillRunner = null;
export function __setAgentSkillRunner(fn) { agentSkillRunner = fn ?? null; }

/** Routing guard helper (hijack fix 2026-10-25): true while the user has
 *  a live agent-loop state (TTL-valid). Read-only; no behavior change. */
export async function isAgentLoopActive(tgId) {
  return (await readAgentState(tgId)) !== null;
}

async function readAgentState(tgId) {
  try {
    const raw = await getConfig(AGENT_KEY(tgId), '');
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.askedAt || Date.now() - Number(o.askedAt) > PENDING_TTL_MS) return null;
    return o;
  } catch { return null; }
}

async function saveAgentState(tgId, state) {
  state.askedAt = Date.now();
  try { await setConfig(AGENT_KEY(tgId), JSON.stringify(state)); } catch { /* best effort */ }
}

async function clearAgentState(tgId) { await clearJsonKey(AGENT_KEY(tgId)); }

function skillArgsFor(params = {}) {
  return {
    query: params.query ?? params.token ?? '',
    token: params.token ?? params.query ?? '',
    address: params.address ?? '',
    topic: params.topic ?? params.query ?? '',
    kind: params.kind ?? '',
  };
}

const POST_WRITER_KINDS = ['bull', 'bear', 'moon', 'fud', 'gem', 'meme', 'callout', 'alpha', 'nft', 'defi'];

/** Pricing truth for direct answers (answer-fix wave 2026-11-05). Sourced
 *  from tgcloud/lib/tiers.js (TIER_LIMITS) + the verified pricing record.
 *  The $29 PB Plan gets 10 API/MCP keys; the 7-day trial gets 0. */
const ANSWER_QUESTION_SYSTEM_PROMPT = `You are PB, the PoorBoyAI assistant, answering the owner's factual question directly. Use ONLY these verified facts for anything about plans, API, MCP, or credits — never invent prices, limits, or features; if the question goes beyond them, say what you know and that the rest is unconfirmed.
- PB Plan — $29 USD / 30 days ($290 / 360 days): 10 API/MCP keys, 500 Studio credits a month, everything unlocked.
- 7-day free trial: 100 trial credits, standard renders only, NO API/MCP keys (0) — API and MCP are PB Plan only.
- Free: 0 AI commands a day, 0 API/MCP keys — Free is raids and group moderation only; AI commands, price, TA and token-safety scans need the PB Plan (or the 7-day trial).
- Studio credit packs (bought with crypto, never expire): 500 for $15, 2,000 for $49, 5,000 for $99.
- Pay-exact top-ups at $0.03/credit are PLANNED, not live yet — never present them as available today.
- API/MCP use burns shared Studio credits; the keys themselves cost nothing extra beyond the plan.
Answer in 2-4 short sentences, plain words, no hype.`;

export function buildAnswerQuestionPrompt(question) {
  return { system: ANSWER_QUESTION_SYSTEM_PROMPT, question: String(question ?? '').trim() };
}

/** True when the text is a factual question about PB's plans, pricing, or
 *  features — the shape the agent loop used to mis-route into post_writer.
 *  Conservative by design: false negatives are safe (the brain planner
 *  still runs); callers only consult it after deterministicClassify said
 *  'none', so no skill action can be stolen. */
export function looksLikeFactualQuestion(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return false;
  const low = text.toLowerCase();
  const isQuestion = /\?\s*$/.test(text)
    || /^(does|do|is|are|can|could|will|would|what|how|why|when|which|who|should)\b/i.test(text)
    || /\bmy question is\b/i.test(text);
  if (!isQuestion) return false;
  const aboutPb = /\b(plan|trial|api|mcp|credit|pricing|price|subscription|booster|airdrop|studio|tier|feature|access|cost)\b/i.test(text)
    || /\bhow (do|can|to) i\b/i.test(text)
    || /\bdoes the\b/i.test(text)
    || /\bdo (i|we) get\b/i.test(text)
    || /\bcan i\b/i.test(text);
  if (!aboutPb) return false;
  // Never a post-writing, broadcast, or job request in question clothing.
  if (/\b(write|draft|compose|shill)\b[^.]{0,40}?\bpost\b/i.test(text)) return false;
  if (/\b(broadcast|announce)\b/i.test(text)) return false;
  if (/\b(alert me|watch (this )?wallet|create (an? )?agent)\b/i.test(text)) return false;
  return true;
}

/** Map ONE brain-planned step into a loop step (extracted pure for the
 *  harness). The post_writer param guard is the answer-fix wave's second
 *  line of defence: a brain-planned post_writer without a valid kind can
 *  never execute — it maps to 'unsupported' instead of failing at run time
 *  with "Pick a post kind first". (An empty topic is fine — the skill
 *  defaults it to $PBAI.) */
export function mapBrainPlanStep(bs) {
  const action = String(bs?.action ?? '');
  const params = (bs?.params && typeof bs.params === 'object') ? bs.params : {};
  const label = String(bs?.label ?? action).slice(0, 120);
  const base = { params, label, status: 'pending', result: '', attempts: 0 };
  if (action === 'forbidden' || FORBIDDEN_RE.test(label)) return { ...base, action: 'forbidden', kind: 'forbidden' };
  if (action === 'answer_question') {
    const q = String(params.question ?? label ?? '').trim();
    return { ...base, action: 'answer_question', kind: 'readonly', params: { question: q } };
  }
  if (action === 'post_writer') {
    const kindOk = POST_WRITER_KINDS.includes(String(params.kind ?? '').toLowerCase());
    if (!kindOk) return { ...base, action: 'unsupported', kind: 'unsupported' };
    return { ...base, action, kind: 'readonly' };
  }
  if (SKILL_ACTIONS.has(action) || action === 'list_jobs' || action === 'leads') return { ...base, action, kind: 'readonly' };
  if (action === 'create_alert' || action === 'create_watch' || action === 'stop_job') return { ...base, action, kind: 'internal' };
  if (action === 'broadcast' || action === 'group_post' || action === 'create_agent') return { ...base, action, kind: 'outward' };
  return { ...base, action: 'unsupported', kind: 'unsupported' };
}

/** Classify ONE goal segment into a loop step. Deterministic first; the
 *  loop-local mappings (health, leads, draft-a-post) exist so the brief's
 *  own example phrasings plan without depending on the brain being up. */
function classifyAgentSegment(seg) {
  const text = String(seg ?? '').trim();
  if (!text) return null;
  const low = text.toLowerCase();
  const label = text.slice(0, 120);
  if (FORBIDDEN_RE.test(text)) {
    return { action: 'forbidden', kind: 'forbidden', params: {}, label, status: 'pending', result: '', attempts: 0 };
  }
  // Broadcast segment → outward (fires only from the loop confirm tap).
  const detB = deterministicClassify(text);
  if (detB?.action === 'broadcast') {
    return { action: 'broadcast', kind: 'outward', params: detB.params, label, status: 'pending', result: '', attempts: 0 };
  }
  // "post/send <text> to the home/main group" → outward group post.
  {
    const m = /^(?:please\s+)?(?:post|send|publish)\s+(.+?)\s+(?:to|in)\s+(?:the\s+)?(home|main)\s+group\s*$/i.exec(text)
      ?? /^(?:please\s+)?(?:post|send|publish)\s+(.+?)\s+(?:to|in)\s+group\s+(-?\d{6,})\s*$/i.exec(text);
    if (m) {
      const target = /^-?\d+$/.test(m[2]) ? m[2] : 'home';
      return { action: 'group_post', kind: 'outward', params: { text: m[1].trim().slice(0, 2000), target }, label, status: 'pending', result: '', attempts: 0 };
    }
    if (/^(?:please\s+)?(?:post|send|publish)\b/i.test(text) && /\bgroup\b/i.test(low)) {
      return { action: 'group_post', kind: 'unsupported', params: {}, label, status: 'pending', result: '', attempts: 0 };
    }
  }
  // Loop-local read mappings.
  if (/\b(bot health|health check|health of the bot|is the bot (ok|up|healthy|alive))\b/i.test(low)) {
    return { action: 'global_stats', kind: 'readonly', params: {}, label, status: 'pending', result: '', attempts: 0 };
  }
  if (/\b(leads|lead finder)\b/i.test(low) && /\b(check|show|list|top|new)\b/i.test(low)) {
    return { action: 'leads', kind: 'readonly', params: {}, label, status: 'pending', result: '', attempts: 0 };
  }
  // "draft/write a <kind> post about <topic>" → private draft (post_writer
  // returns the post to the DM only — drafting is NOT posting).
  {
    const m = /\b(?:draft|write|compose)\b[^.]{0,40}?\b(bull|bear|moon|fud|gem|meme|callout|alpha|nft|defi|raid|shill)?\s*post\b\s*(?:about|for|on)?\s*(.*)$/i.exec(text);
    if (m) {
      const kindWord = (m[1] ?? '').toLowerCase();
      const kind = ['bull', 'bear', 'moon', 'fud', 'gem', 'meme', 'callout', 'alpha', 'nft', 'defi'].includes(kindWord) ? kindWord : 'bull';
      let topic = (m[2] ?? '').trim().replace(/[?.!]+$/, '') || '$PBAI';
      if (/^(the\s+)?(home|main)\s+group$/i.test(topic)) topic = '$PBAI'; // "a raid post for the home group" drafts a $PBAI post
      return { action: 'post_writer', kind: 'readonly', params: { kind, topic }, label, status: 'pending', result: '', attempts: 0 };
    }
  }
  const det = detB ?? deterministicClassify(text);
  if (det && det.action !== 'none') {
    if (SKILL_ACTIONS.has(det.action)) {
      return { action: det.action, kind: 'readonly', params: det.params, label, status: 'pending', result: '', attempts: 0 };
    }
    if (det.action === 'list_jobs') {
      return { action: 'list_jobs', kind: 'readonly', params: {}, label, status: 'pending', result: '', attempts: 0 };
    }
    if (det.action === 'create_alert' || det.action === 'create_watch' || det.action === 'stop_job') {
      return { action: det.action, kind: 'internal', params: det.params, label, status: 'pending', result: '', attempts: 0 };
    }
    if (det.action === 'create_agent') {
      // A created agent POSTS to groups on a schedule — outward by effect,
      // so it confirms like one (the incumbent flow confirms it too).
      return { action: 'create_agent', kind: 'outward', params: det.params, label, status: 'pending', result: '', attempts: 0 };
    }
  }
  // Factual question (answer-fix wave 2026-11-05): a question about PB's
  // plans, pricing, or features that no deterministic action claimed —
  // answer it directly instead of letting the brain planner shoehorn it
  // into post_writer. Reached only when deterministicClassify said 'none',
  // so no skill action can be stolen here.
  if ((!det || det.action === 'none') && looksLikeFactualQuestion(text)) {
    return { action: 'answer_question', kind: 'readonly', params: { question: text }, label, status: 'pending', result: '', attempts: 0 };
  }
  return { action: 'unsupported', kind: 'unsupported', params: {}, label, status: 'pending', result: '', attempts: 0 };
}

/** Split a goal into segments on the natural step joins. */
export function splitAgentGoal(text) {
  return String(text ?? '')
    .split(/\s*;\s*|\s+and then\s+|\s*,\s*and\s+|\s*,\s+|\s+then\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

const AGENT_PLAN_PROMPT = `You plan a Telegram bot owner's multi-step goal into steps. Return ONLY a JSON object: {"steps":[{"action":"...","params":{},"label":"short step name"}]} — no markdown.
Allowed actions (use ONLY these; anything else must be action "unsupported"):
- Read-only skills: price_check, token_scan, security_scan, ta_overview, rsi_check, macd_check, bollinger_check, hot_gems, wallet_lookup, community_stats, my_rank, global_standings, my_points, my_tier, my_wallet, holder_status, my_alerts, my_watched, my_invite, my_digest, business_status, my_campaign, group_leaderboard, my_squad, contest_status, global_stats, featured_gems, post_writer, debate, moon_moment, list_jobs, leads, answer_question
- Internal (owner's own): create_alert {tokenName, tokenAddress, direction, targetPrice}, create_watch {walletAddress}, stop_job {match}
- Outward (will need the owner's confirm tap): broadcast {text}, group_post {text, target:"home"}, create_agent {agentType, tokenName, tokenAddress, intervalHours, targetGroupHint}
- NEVER plan money, arming, grants, keys, moderation, or winner steps — label those action "forbidden".
- answer_question: user asks a factual question (pricing, plans, features, how something works, what something costs) — answer it directly from PB's own knowledge. params: {"question":"the question text"}. NEVER plan post_writer for a question — post_writer is only when the user explicitly asks for a post to be written (draft/write/compose + a post kind/topic).
Params: token_scan/security_scan take {query}/{token}; price_check {token}; post_writer {kind, topic}; wallet_lookup {address}. Never invent addresses or prices. Max 8 steps.
Never write placeholder text in params: no bracketed tokens like [Generated promo content], no TODO/TBD/lorem text, no {{...}} templates. For broadcast/group_post text, use ONLY text the owner actually gave in the goal; if none was given, use an empty string.`;

/** Build a plan for a goal, or null when it is not a multi-step goal.
 *  Deterministic segmentation first; the brain planner only fills gaps
 *  (unmatched segments, or a goal the splitter could not divide). A plan
 *  needs 2+ steps with at least one executable step. */
async function buildAgentLoopPlan(text) {
  let segments = splitAgentGoal(text);
  if (segments.length === 1) {
    // Bare-"and" goals ("check the price and post GM to the home group"):
    // accept the split ONLY when every part classifies to a real step, so
    // ordinary single-intent sentences keep their incumbent path.
    const alt = String(text).split(/\s+and\s+/i).map((s) => s.trim()).filter((s) => s.length > 1);
    if (alt.length >= 2) {
      const altSteps = alt.map(classifyAgentSegment).filter(Boolean);
      if (altSteps.length === alt.length && altSteps.every((s) => s.kind !== 'unsupported')) segments = alt;
    }
  }
  let steps = segments.map(classifyAgentSegment).filter(Boolean);
  // Answer-fix wave (2026-11-05): a goal made ONLY of factual questions is
  // not a multi-step goal — return null so the message falls through to
  // normal chat, which answers it directly. Without this the brain planner
  // shoehorns the question into post_writer (no kind/topic) and the loop
  // fails 0/2.
  if (steps.length > 0 && steps.every((s) => s.action === 'answer_question')) return null;
  const needsBrain = steps.length < 2 || steps.some((s) => s.kind === 'unsupported');
  if (needsBrain) {
    try {
      const raw = await askBrain(`Plan this owner goal:\n"""${String(text).slice(0, 800)}"""`, {
        systemPromptOverride: AGENT_PLAN_PROMPT,
        maxOutputTokens: 700,
      });
      const parsed = extractJson(raw);
      const brainSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const mapped = brainSteps.slice(0, MAX_AGENT_STEPS).map(mapBrainPlanStep);
      // Prefer the brain plan only when it is at least as actionable.
      const detActionable = steps.filter((s) => s.kind === 'readonly' || s.kind === 'internal' || s.kind === 'outward').length;
      const brainActionable = mapped.filter((s) => s.kind === 'readonly' || s.kind === 'internal' || s.kind === 'outward').length;
      if (mapped.length >= 2 && brainActionable >= detActionable) steps = mapped;
    } catch { /* deterministic plan stands */ }
  }
  if (steps.length < 2) return null;
  const actionable = steps.filter((s) => s.kind === 'readonly' || s.kind === 'internal' || s.kind === 'outward').length;
  if (!actionable) return null;
  return steps.slice(0, MAX_AGENT_STEPS);
}

const KIND_ICON = { readonly: '🔎', internal: '🔧', outward: '📣', forbidden: '⛔', unsupported: '⚠️' };

function agentPlanText(state) {
  const lines = [`🧭 Agent loop — goal: ${state.goal}`, '', 'Plan:'];
  state.steps.forEach((s, i) => {
    const note = s.kind === 'outward' ? ' (needs your confirm before it runs)'
      : s.kind === 'forbidden' ? ' (owner-manual — I will NOT run this)'
      : s.kind === 'unsupported' ? ' (no real executor exists — will be skipped, not faked)'
      : '';
    lines.push(`${i + 1}. ${KIND_ICON[s.kind] ?? '•'} ${s.label}${note}`);
  });
  lines.push('', 'Read-only steps run hands-off. Say "stop" anytime, or tap Stop, to halt.');
  return lines.join('\n');
}

const AGENT_STOP_KB = { reply_markup: { inline_keyboard: [[{ text: '🛑 Stop the loop', callback_data: 'agent:stop' }]] } };

function outwardPreview(step) {
  if (step.action === 'broadcast') return `Broadcast to all groups:\n"${String(step.params.text ?? '').slice(0, 1500)}"`;
  if (step.action === 'group_post') return `Post to ${step.params.target === 'home' ? 'the home group' : `group ${step.params.target}`}:\n"${String(step.params.text ?? '').slice(0, 1500)}"`;
  if (step.action === 'create_agent') return `Create agent: ${JSON.stringify(step.params).slice(0, 800)}`;
  return step.label;
}

/** Execute ONE step's real executor. Returns { ok, text } — text is the
 *  executor's own output; the receipt quotes it, never a paraphrase. */
async function executeAgentStep(chatId, from, step) {
  const tgId = String(from.id);
  // Answer-fix wave (2026-11-05): a factual question step answers directly
  // from the brain with the verified pricing truth — never routed to the
  // post generator. A failed brain call fails clean, never fakes an answer.
  if (step.action === 'answer_question') {
    const q = String(step.params?.question ?? step.label ?? '').trim();
    if (!q) return { ok: false, text: 'No question was given to answer.' };
    try {
      const answer = await askBrain(q, { systemPromptOverride: ANSWER_QUESTION_SYSTEM_PROMPT, maxOutputTokens: 500 });
      const text = String(answer ?? '').trim();
      if (!text) return { ok: false, text: '❌ Could not answer that right now. Try again shortly.' };
      return { ok: true, text: text.slice(0, AGENT_RESULT_SLICE) };
    } catch {
      return { ok: false, text: '❌ Could not answer that right now. Try again shortly.' };
    }
  }
  if (SKILL_ACTIONS.has(step.action)) {
    const ctx = { from, chatId, chatType: 'private' };
    const args = skillArgsFor(step.params);
    const res = agentSkillRunner
      ? await agentSkillRunner(step.action, ctx, args)
      : await runSkill(step.action, ctx, args);
    return { ok: Boolean(res?.ok), text: String(res?.text ?? '').slice(0, AGENT_RESULT_SLICE) };
  }
  if (step.action === 'list_jobs') {
    return { ok: true, text: listJobsText(await ownerJobs(tgId)).slice(0, AGENT_RESULT_SLICE) };
  }
  if (step.action === 'leads') {
    const rows = await db.select().from(pb_leads)
      .where(inArray(pb_leads.status, ['new', 'digested']))
      .orderBy(desc(pb_leads.score)).limit(5).all().catch(() => []);
    if (!rows.length) return { ok: true, text: '🎯 No leads over the bar yet. Run /leads scan to scan now.' };
    const lines = rows.map((l) => `• ${l.projectName ?? 'Unknown project'} · score ${l.score} · ${l.source}`);
    return { ok: true, text: [`🎯 Top leads (${rows.length})`, ...lines].join('\n').slice(0, AGENT_RESULT_SLICE), };
  }
  if (step.action === 'create_alert') {
    const p = fillPbaiDefaults(step.params);
    const missing = [];
    if (!p.tokenAddress || !ADDR_RE.test(p.tokenAddress)) missing.push('tokenAddress');
    if (p.direction !== 'above' && p.direction !== 'below') missing.push('direction');
    if (!Number.isFinite(Number(p.targetPrice)) || Number(p.targetPrice) <= 0) missing.push('targetPrice');
    if (missing.length) return { ok: false, text: `Alert step is missing: ${missing.join(', ')} — not created.` };
    const out = await createAlertEndpoint({
      tokenAddress: p.tokenAddress, tokenName: p.tokenName ?? 'TOKEN',
      direction: p.direction, targetPrice: Number(p.targetPrice),
    }, ownerCtx(from));
    return { ok: true, text: `Alert set — $${out.tokenName ?? 'TOKEN'} ${out.direction} $${out.targetPrice} (one-shot).` };
  }
  if (step.action === 'create_watch') {
    const p = { ...step.params };
    if (!p.walletAddress || !ADDR_RE.test(p.walletAddress)) return { ok: false, text: 'Watch step is missing a valid walletAddress — not created.' };
    const out = await createWatchEndpoint({ walletAddress: p.walletAddress, label: p.label ?? '' }, ownerCtx(from));
    return { ok: true, text: `Watching ${shortAddr(out.walletAddress)}.` };
  }
  if (step.action === 'stop_job') {
    await executeStopJob(chatId, from, step.params.match ?? '');
    return { ok: true, text: 'Stop request executed — its own confirmation is posted above.' };
  }
  if (step.action === 'broadcast') {
    const text = String(step.params.text ?? '').trim();
    if (!text) return { ok: false, text: 'Broadcast step had no text — nothing sent.' };
    const check = validateOutboundText(text);
    if (!check.ok) return { ok: false, text: `Broadcast refused — the text looks like a ${check.reason} — nothing sent. Fix the text and run the loop again.` };
    const result = await executeBroadcast(text);
    if (result.refused) return { ok: false, text: 'Broadcast refused by the outbound guard — nothing sent.' };
    if (!result.total) return { ok: false, text: 'No known groups yet — nothing sent.' };
    return { ok: true, text: broadcastReceiptText(result) };
  }
  if (step.action === 'group_post') {
    let target = String(step.params.target ?? 'home');
    if (target === 'home') target = String(await getConfig('TELEGRAM_HOME_CHAT_ID', ''));
    if (!/^-?\d+$/.test(target)) return { ok: false, text: 'Group target could not be resolved — nothing posted.' };
    const check = validateOutboundText(String(step.params.text ?? ''));
    if (!check.ok) return { ok: false, text: `Group post refused — the text looks like a ${check.reason} — nothing posted. Fix the text and run the loop again.` };
    const sent = await api.sendMessage({ chat_id: target, text: String(step.params.text ?? '').slice(0, 4000) });
    return { ok: true, text: `Posted to group ${target} (message ${sent?.message_id ?? '?'}).` };
  }
  if (step.action === 'create_agent') {
    const plan = await buildAgentPlan(step.params);
    if (plan.problems.length) return { ok: false, text: `Agent step is missing: ${plan.problems.join(', ')} — not created.` };
    const out = await createAgentEndpoint(plan.input, ownerCtx(from));
    return { ok: true, text: `Agent #${out.id} (${out.type}) is active.` };
  }
  return { ok: false, text: `No executor for action "${step.action}".` };
}

/** Run one step with the one-retry rule. Mutates the step in place. */
async function runAgentStepWithRetry(chatId, from, step) {
  for (let attempt = 0; attempt < 2; attempt++) {
    step.attempts = attempt + 1;
    try {
      const res = await executeAgentStep(chatId, from, step);
      step.result = res.text;
      if (res.ok) { step.status = 'done'; return; }
      if (attempt === 1) step.status = 'failed';
    } catch (err) {
      step.result = `Executor error: ${String(err?.message ?? err).slice(0, 300)}`;
      if (attempt === 1) step.status = 'failed';
    }
  }
}

const STEP_ICON = { done: '✅', failed: '❌', refused: '⛔', unsupported: '⚠️', skipped: '⏭️', pending: '🛑' };

function agentReceiptText(state, ending) {
  const lines = [`🧾 Agent loop receipt — ${ending}`, '', `Goal: ${state.goal}`, ''];
  state.steps.forEach((s, i) => {
    const icon = STEP_ICON[s.status] ?? '•';
    const res = s.result ? ` — ${String(s.result).replace(/\s*\n\s*/g, ' · ').slice(0, 300)}` : '';
    lines.push(`${i + 1}. ${icon} ${s.label}${res}`);
  });
  const done = state.steps.filter((s) => s.status === 'done').length;
  lines.push('', `Done: ${done}/${state.steps.length} steps. This receipt is the system's record — the counts and outputs above are the executors' own.`);
  return lines.join('\n').slice(0, 3900);
}

async function finishAgentLoop(chatId, from, state, ending) {
  await clearAgentState(String(from.id));
  const receipt = agentReceiptText(state, ending);
  await sendSafe(chatId, receipt);
  try {
    const userKey = await resolveUserKey('telegram', from.id);
    await saveMessage(userKey, 'assistant', `[system] Agent loop result posted by the system:\n${receipt}`, 'telegram');
  } catch { /* memory write is best-effort */ }
  // Gap-1 receipt card: a rendering of this same receipt (same steps, same
  // executor snippets) following the text, which stays the full record.
  // Best-effort — the sender never throws.
  try {
    const done = state.steps.filter((s) => s.status === 'done').length;
    await sendReceiptCard(chatId, {
      goal: state.goal, ending, steps: state.steps,
      done, total: state.steps.length, when: new Date(),
    });
  } catch { /* card is best-effort */ }
}

/** Advance the loop from state.idx until it finishes, pauses on an
 *  outward step (confirm card), or is halted. Persists after every step
 *  so state survives across messages and invocations. */
async function runAgentLoop(chatId, from) {
  const tgId = String(from.id);
  let state = await readAgentState(tgId);
  if (!state || state.status === 'done' || state.status === 'cancelled') return;
  state.status = 'running';
  while (state.idx < state.steps.length) {
    const step = state.steps[state.idx];
    if (step.kind === 'forbidden') {
      step.status = 'refused';
      step.result = 'Money / arm / grant / key / moderation / winner step — the loop never runs these. This one is yours to run yourself.';
      state.idx++;
      await saveAgentState(tgId, state);
      continue;
    }
    if (step.kind === 'unsupported') {
      step.status = 'unsupported';
      step.result = 'No real executor exists for this step — skipped, not faked.';
      state.idx++;
      await saveAgentState(tgId, state);
      continue;
    }
    if (step.kind === 'outward' && step.status === 'pending') {
      // Placeholder-guard chaining rule (2026-10-30): an outward step never
      // runs after a failed earlier step — the incident path was a broadcast
      // whose producer step had failed, with planner-written placeholder
      // text. Refuse, record it, and move on; never guess replacement text.
      const failedEarlier = state.steps.slice(0, state.idx).find((s) => s.status === 'failed');
      if (failedEarlier) {
        step.status = 'refused';
        step.result = `Refused: an earlier step failed ("${failedEarlier.label}") — the loop never sends an outward step after a failed step, and it will not guess replacement text. Nothing sent.`;
        state.idx++;
        await saveAgentState(tgId, state);
        continue;
      }
      const cardText = (step.action === 'broadcast' || step.action === 'group_post')
        ? String(step.params.text ?? '') : '';
      const templatedWarn = (cardText.trim() && looksTemplated(cardText))
        ? '\n\n⚠️ Warning: this text looks templated/placeholder-like — check it carefully before tapping Run it. A placeholder is refused at send time even if you tap Run it.'
        : '';
      step.status = 'awaiting';
      state.status = 'awaiting_confirm';
      await saveAgentState(tgId, state);
      await sendSafe(chatId,
        `📣 Step ${state.idx + 1}/${state.steps.length} needs your confirm — nothing has been sent yet.\n\n${outwardPreview(step)}${templatedWarn}\n\nTap ✅ Run it to execute exactly this, ⏭️ Skip to move on, or 🛑 Stop to halt the loop.`, {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Run it', callback_data: 'agent:go' },
              { text: '⏭️ Skip', callback_data: 'agent:skip' },
              { text: '🛑 Stop', callback_data: 'agent:stop' },
            ]],
          },
        });
      return;
    }
    if (step.status === 'pending') {
      await runAgentStepWithRetry(chatId, from, step);
      state.idx++;
      await saveAgentState(tgId, state);
      continue;
    }
    // A step left 'awaiting' without a callback (expired card) — hold.
    return;
  }
  state.status = 'done';
  await finishAgentLoop(chatId, from, state, 'complete');
}

/** Start a loop for a fresh goal. Returns true when a loop started. */
async function maybeStartAgentLoop(chatId, from, text) {
  const tgId = String(from.id);
  if (await readAgentState(tgId)) return false; // one loop at a time
  const steps = await buildAgentLoopPlan(text);
  if (!steps) return false;
  const state = {
    goal: String(text).slice(0, 300),
    steps, idx: 0, status: 'running', askedAt: Date.now(),
  };
  await saveAgentState(tgId, state);
  await sendSafe(chatId, agentPlanText(state), AGENT_STOP_KB);
  await runAgentLoop(chatId, from);
  return true;
}

/** Message-side control for an ACTIVE loop. Returns true when consumed. */
async function handleAgentActiveMessage(chatId, msg, text) {
  const from = msg.from;
  const tgId = String(from.id);
  const state = await readAgentState(tgId);
  if (!state) return false;
  const trimmed = String(text ?? '').trim();
  if (/^(stop|cancel|halt|never ?mind)\b/i.test(trimmed)) {
    state.status = 'cancelled';
    for (const s of state.steps) if (s.status === 'pending' || s.status === 'awaiting') s.status = 'pending';
    await finishAgentLoop(chatId, from, state, 'halted by you');
    return true;
  }
  if (state.status === 'awaiting_confirm') {
    await sendSafe(chatId,
      '⏸️ The loop is paused on a step that needs your tap — ✅ Run it, ⏭️ Skip, or 🛑 Stop on the confirm card above. Typed words can\'t fire it; "stop" cancels the loop.');
    return true;
  }
  if (/^(continue|go|resume|carry on)\b/i.test(trimmed)) {
    await runAgentLoop(chatId, from);
    return true;
  }
  await sendSafe(chatId,
    `🧭 A goal is already in progress (step ${Math.min(state.idx + 1, state.steps.length)}/${state.steps.length}). Say "continue" to resume it or "stop" to halt it — then give me the new goal.`);
  return true;
}

/** Button handler for the loop's confirm + stop controls. Owner-gated by
 *  handlers/callback_query.js before calling, like the broadcast handler.
 *  This is the ONLY path that can execute an outward loop step. */
export async function handleAgentCallback(query, action) {
  const from = query.from;
  const chatId = query.message?.chat?.id ?? from?.id;
  const tgId = String(from?.id);
  const state = await readAgentState(tgId);

  if (action === 'stop') {
    if (!state) { await sendSafe(chatId, 'That loop already finished — nothing to stop.'); return; }
    state.status = 'cancelled';
    for (const s of state.steps) if (s.status === 'pending' || s.status === 'awaiting') s.status = 'pending';
    await finishAgentLoop(chatId, from, state, 'halted by you');
    return;
  }

  if (!state || state.status !== 'awaiting_confirm') {
    await sendSafe(chatId, 'That loop step expired — nothing was sent. Give me the goal again and I\'ll set it up fresh.');
    return;
  }
  const step = state.steps[state.idx];
  if (!step || step.status !== 'awaiting') {
    await sendSafe(chatId, 'That loop step expired — nothing was sent. Give me the goal again and I\'ll set it up fresh.');
    return;
  }
  if (action === 'skip') {
    step.status = 'skipped';
    step.result = 'Skipped by you at the confirm step — nothing sent.';
    state.idx++;
    state.status = 'running';
    await saveAgentState(tgId, state);
    await runAgentLoop(chatId, from);
    return;
  }
  if (action === 'go') {
    // Placeholder-guard chaining at tap time (2026-10-30): a loop left
    // 'awaiting' on the OLD code and tapped after this push is still
    // caught here, even though the card-time check never ran for it.
    const failedEarlier = state.steps.slice(0, state.idx).find((s) => s.status === 'failed');
    if (failedEarlier) {
      step.status = 'refused';
      step.result = `Refused at tap time: an earlier step failed ("${failedEarlier.label}") — nothing sent.`;
      state.idx++;
      state.status = 'running';
      await saveAgentState(tgId, state);
      await runAgentLoop(chatId, from);
      return;
    }
    // Consume the awaiting state BEFORE executing: a second tap finds the
    // step no longer awaiting and cannot re-run it.
    step.status = 'running';
    state.status = 'running';
    await saveAgentState(tgId, state);
    await runAgentStepWithRetry(chatId, from, step);
    state.idx++;
    await saveAgentState(tgId, state);
    await runAgentLoop(chatId, from);
    return;
  }
}

/** Test seams for the agent loop (harness + in-isolate proofs). */
export const __agentLoopTest = {
  executeAgentStep,
  buildAgentLoopPlan,
  classifyAgentSegment,
  looksLikeFactualQuestion,
  mapBrainPlanStep,
  buildAnswerQuestionPrompt,
};
