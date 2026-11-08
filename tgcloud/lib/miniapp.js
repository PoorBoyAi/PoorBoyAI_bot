// Shared helpers for Mini App endpoints.
// Identity comes ONLY from ctx.initData (platform-verified by Telegram
// Serverless before the endpoint runs) — never from input fields.
//
// MERGE 2026-11-01 (Rowdy-approved, Stars slot): tgcloud/lib/chatsessions.js
// was merged INTO this file to free exactly one module slot for
// tgcloud/handlers/pre_checkout_query.js. Every export from both files is
// preserved below, bodies verbatim; only the import block is unified.
// chatsessions.js no longer exists; import its exports from here.

import { EndpointError } from 'sdk';
import db, { eq, and } from 'sdk/db';
import { bot_users, chat_sessions, pb_sites, pb_site_files } from '../schema.js';

/** The Telegram user calling the endpoint, or an EndpointError. */
export function caller(ctx) {
  const tg = ctx?.initData?.user;
  if (!tg?.id) throw new EndpointError('No Telegram identity on this call', { code: 'NO_IDENTITY' });
  return tg;
}

/** Ensure the caller has a bot_users row (same shape as the bot's own
 *  getOrCreateUser) and return it. */
export async function ensureUser(tg) {
  const tgId = String(tg.id);
  let row = await db.select().from(bot_users)
    .where(eq(bot_users.telegramUserId, tgId)).get();
  if (!row) {
    const inserted = await db.insert(bot_users).values({
      telegramUserId: tgId,
      username: tg.username ?? null,
      firstName: tg.first_name ?? null,
    }).returning();
    row = inserted[0] ?? null;
  }
  return row;
}

// --- Merged from tgcloud/lib/chatsessions.js (verbatim bodies) ---
// Named Mini App chat sessions (Dashboard wave item 12). A session is a
// chat_sessions row owned by ONE telegram user; its messages live in
// pb_conversations under user_key "telegram:{id}:s{sessionId}"
// (lib/memory.js sessionUserKey). Every read/write here is scoped by
// telegram_user_id — a session id alone never grants access.

export const MAX_CHAT_SESSIONS = 10;
export const MAX_SESSION_TITLE = 80;

export function sessionToUnix(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

export function sessionView(row, messageCount) {
  return {
    id: row.id,
    title: row.title,
    createdAt: sessionToUnix(row.createdAt),
    updatedAt: sessionToUnix(row.updatedAt),
    ...(messageCount !== undefined ? { messageCount } : {}),
  };
}

/** The session row ONLY if it belongs to this user, else null. */
export async function getOwnedSession(tgId, sessionId) {
  const sid = Number(sessionId);
  if (!Number.isSafeInteger(sid) || sid <= 0) return null;
  try {
    const row = await db.select().from(chat_sessions)
      .where(and(eq(chat_sessions.id, sid), eq(chat_sessions.telegramUserId, String(tgId)))).get();
    return row ?? null;
  } catch {
    return null;
  }
}

/** getOwnedSession, or an EndpointError — for endpoints acting on a session. */
export async function requireOwnedSession(tgId, sessionId) {
  const row = await getOwnedSession(tgId, sessionId);
  if (!row) throw new EndpointError('Chat session not found.', { code: 'SESSION_NOT_FOUND' });
  return row;
}

export function cleanSessionTitle(input) {
  const title = String(input ?? '').trim().slice(0, MAX_SESSION_TITLE);
  return title || 'New chat';
}

// ── Site builder v1 (2026-11-05, Rowdy: build a website builder) ───────────
// Template assembly only — the buyer describes, the brain writes copy, the
// generator assembles pre-built sections into a self-contained static
// bundle (index.html, inline CSS, no external deps, no build step).
// NO raw HTML/JS injection, ever: every buyer-supplied value is escaped
// (spec §5 phishing rule — a customer who can inject code can inject a
// wallet drainer). Accents come from a fixed palette, never free-form.
// v1 templates: T5 link page + T1 token launch page. v1 is OWNER-ONLY.

export const SITE_TEMPLATES = {
  t1_launch: { key: 't1_launch', label: '🚀 Token launch page', blurb: 'Hero, contract, tokenomics, links, roadmap, FAQ.' },
  t5_links: { key: 't5_links', label: '🔗 Link page', blurb: 'One clean page: all your links, one call to action.' },
};

export const SITE_ACCENTS = {
  gold: '#f5b942',
  violet: '#8b7cff',
  teal: '#2dd4bf',
  rose: '#fb7185',
  sky: '#38bdf8',
};

export const SITE_RESERVED_SLUGS = new Set([
  'poorboyai', 'api', 'www', 'admin', 'pb', 'support', 'app', 'dashboard',
  'static', 'mail', 'blog', 'shop', 'mcp', 'launchpad', 'studio', 'bot',
  'login', 'signup', 'assets', 'cdn', 'staging', 'preview',
]);

const URL_SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'buff.ly',
  'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'ow.ly', 's.id',
]);

/** HTML-escape a buyer-supplied value. Never emit raw buyer text. */
export function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Slug rules for the Pages project name (URL is <slug>.pages.dev). */
export function validateSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (slug.length < 3 || slug.length > 32) return { ok: false, reason: 'Slug must be 3–32 characters.' };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.includes('--')) {
    return { ok: false, reason: 'Slug must be lowercase letters, numbers and single dashes only.' };
  }
  if (SITE_RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'That slug is reserved.' };
  return { ok: true, slug };
}

/** https only, real hostname, no URL shorteners (same rule as Ads).
 * NOTE: the tgcloud isolate has NO `URL` global (ReferenceError) — this
 * validates with string parsing only. Proven in-isolate 2026-11-05:
 * `new URL()` throws there and a try/catch validator silently rejects
 * EVERY link, including good ones. */
export function isValidHttpsUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('https://')) return false;
  if (/[\s<>"'\\]/.test(s)) return false;
  const host = s.slice('https://'.length).split(/[/ ?#]/)[0].toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false;
  if (URL_SHORTENERS.has(host)) return false;
  return true;
}

/** Contract shape only — 0x + 40 hex. Liveness is verifyContractLive. */
export function isValidContract(raw) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(raw ?? '').trim());
}

/**
 * Contract liveness check: DexScreener first, GeckoTerminal fallback.
 * fetchFn is injected so the harness can fake it (the harness stub fetch
 * throws). Returns { verified, providerDown, name?, symbol? }.
 * Verified if EITHER provider resolves the address. providerDown only
 * when BOTH error — a single provider's gap must not block a publish:
 * DexScreener returns [] for $PBAI itself (tiny pool, unindexed) while
 * GeckoTerminal — PB's own live price path — resolves it (proven live
 * 2026-11-05). An address NEITHER provider resolves blocks.
 */
export async function verifyContractLive(addr, fetchFn) {
  try {
    const res = await fetchFn(`https://api.dexscreener.com/tokens/v1/base/${addr}`);
    if (res?.ok) {
      const pairs = await res.json();
      if (Array.isArray(pairs) && pairs.length > 0) {
        const base = pairs[0]?.baseToken ?? {};
        return { verified: true, providerDown: false, name: base.name ?? null, symbol: base.symbol ?? null };
      }
    }
  } catch { /* fall through to GeckoTerminal */ }
  try {
    const res = await fetchFn(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${addr}`);
    if (res?.ok) {
      const j = await res.json();
      const a = j?.data?.attributes;
      if (a?.address) return { verified: true, providerDown: false, name: a.name ?? null, symbol: a.symbol ?? null };
      return { verified: false, providerDown: false };
    }
    if (res?.status === 404) return { verified: false, providerDown: false };
    return { verified: false, providerDown: true };
  } catch {
    return { verified: false, providerDown: true };
  }
}

function siteShell({ title, accent, body }) {
  const a = SITE_ACCENTS[accent] ?? SITE_ACCENTS.gold;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
:root{--acc:${a};--bg:#0b0e14;--card:#141926;--txt:#eef1f6;--mut:#9aa4b2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 18px 48px}
.hero{text-align:center;padding:36px 0 8px}
.hero h1{font-size:40px;line-height:1.05;margin:0 0 10px}
.hero p{color:var(--mut);font-size:17px;line-height:1.5;margin:0}
.tag{display:inline-block;border:1px solid var(--acc);color:var(--acc);border-radius:999px;padding:4px 12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px}
.card{background:var(--card);border:1px solid #232a3d;border-radius:16px;padding:18px;margin-top:18px}
.card h2{margin:0 0 10px;font-size:18px}
.card p{color:var(--mut);line-height:1.6;margin:0}
.addr{font-family:ui-monospace,Menlo,monospace;font-size:13px;word-break:break-all;background:#0b0e14;border:1px solid #232a3d;border-radius:10px;padding:10px 12px;margin-top:10px}
.addr button{background:var(--acc);border:0;border-radius:8px;padding:6px 12px;font-weight:700;cursor:pointer;margin-left:8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
.cell{background:#0b0e14;border:1px solid #232a3d;border-radius:12px;padding:12px}
.cell b{display:block;font-size:20px;margin-bottom:2px}
.cell span{color:var(--mut);font-size:13px}
.links{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.links a{display:block;text-align:center;background:var(--acc);color:#0b0e14;font-weight:700;text-decoration:none;border-radius:12px;padding:14px}
.links a.ghost{background:transparent;color:var(--txt);border:1px solid #2b3348}
ul{margin:6px 0 0;padding-left:20px;color:var(--mut);line-height:1.7}
.faq b{color:var(--txt)} .faq p{margin:2px 0 12px}
.foot{text-align:center;color:var(--mut);font-size:13px;margin-top:28px}
.foot a{color:var(--acc)}
</style>
</head>
<body><div class="wrap">
${body}
<div class="foot">Built by PB — demo site. <a href="https://t.me/PoorBoyAI_bot">Talk to PB</a> to build yours.</div>
</div>
<script>
function copyAddr(el){var t=el.parentNode.querySelector('span').textContent;if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){el.textContent='Copied!';});}}
var cd=document.getElementById('countdown');if(cd){var target=new Date(cd.dataset.until).getTime();var tick=function(){var d=target-Date.now();if(d<=0){cd.textContent='Live now';return;}var days=Math.floor(d/86400000),h=Math.floor(d%86400000/3600000),m=Math.floor(d%3600000/60000);cd.textContent=days+'d '+h+'h '+m+'m to go';};tick();setInterval(tick,60000);}
</script>
</body>
</html>`;
}

function renderLinksList(links) {
  const rows = (links ?? []).filter((l) => l && l.label && isValidHttpsUrl(l.url));
  if (rows.length === 0) return '<p>No links yet.</p>';
  return `<div class="links">${rows.map((l, i) => `<a href="${escHtml(l.url)}"${i === 0 ? '' : ' class="ghost"'}>${escHtml(l.label)}</a>`).join('')}</div>`;
}

function buildT5(data) {
  const title = String(data.title ?? 'My links').slice(0, 80);
  const tagline = String(data.tagline ?? '').slice(0, 200);
  const body = `<div class="hero"><div class="tag">Links</div><h1>${escHtml(title)}</h1>${tagline ? `<p>${escHtml(tagline)}</p>` : ''}</div>
<div class="card">${renderLinksList(data.links)}</div>`;
  return siteShell({ title, accent: data.accent, body });
}

function buildT1(data) {
  const name = String(data.name ?? 'Token').slice(0, 80);
  const headline = String(data.copy?.headline ?? data.tagline ?? '').slice(0, 200);
  const about = String(data.copy?.about ?? data.tagline ?? '').slice(0, 500);
  const contract = String(data.contract ?? '');
  const tok = data.tokenomics ?? {};
  const links = data.links ?? {};
  const roadmap = (data.roadmap ?? []).slice(0, 5);
  const faq = (data.faq ?? []).slice(0, 5);
  const countdown = data.countdown ? new Date(data.countdown) : null;
  const countdownOk = countdown && !Number.isNaN(countdown.getTime()) ? countdown.toISOString() : null;

  const linkRows = [];
  if (links.buy && isValidHttpsUrl(links.buy)) linkRows.push({ label: '🛒 Buy', url: links.buy, primary: true });
  if (links.chart && isValidHttpsUrl(links.chart)) linkRows.push({ label: '📈 Chart', url: links.chart });
  if (links.x && isValidHttpsUrl(links.x)) linkRows.push({ label: '𝕏 X', url: links.x });
  if (links.telegram && isValidHttpsUrl(links.telegram)) linkRows.push({ label: '✈️ Telegram', url: links.telegram });
  if (links.website && isValidHttpsUrl(links.website)) linkRows.push({ label: '🌐 Website', url: links.website });

  const body = `<div class="hero"><div class="tag">Token launch · Base</div><h1>${escHtml(name)}</h1>${headline ? `<p>${escHtml(headline)}</p>` : ''}${countdownOk ? `<p id="countdown" data-until="${countdownOk}">…</p>` : ''}</div>
<div class="card"><h2>Contract</h2><div class="addr"><span>${escHtml(contract)}</span><button onclick="copyAddr(this)">Copy</button></div></div>
${about ? `<div class="card"><h2>About</h2><p>${escHtml(about)}</p></div>` : ''}
${(tok.supply || tok.tax) ? `<div class="card"><h2>Tokenomics</h2><div class="grid">${tok.supply ? `<div class="cell"><b>${escHtml(tok.supply)}</b><span>Supply</span></div>` : ''}${tok.tax ? `<div class="cell"><b>${escHtml(tok.tax)}</b><span>Tax</span></div>` : ''}</div></div>` : ''}
${linkRows.length ? `<div class="card"><h2>Links</h2><div class="links">${linkRows.map((l) => `<a href="${escHtml(l.url)}"${l.primary ? '' : ' class="ghost"'}>${escHtml(l.label)}</a>`).join('')}</div></div>` : ''}
${roadmap.length ? `<div class="card"><h2>Roadmap</h2><ul>${roadmap.map((r) => `<li>${escHtml(r)}</li>`).join('')}</ul></div>` : ''}
${faq.length ? `<div class="card faq"><h2>FAQ</h2>${faq.map((f) => `<b>${escHtml(f.q)}</b><p>${escHtml(f.a)}</p>`).join('')}</div>` : ''}`;
  return siteShell({ title: `${name} — Token launch`, accent: data.accent, body });
}

/**
 * Assemble a site bundle from a template + interview data. Deterministic:
 * the same data always yields the same bytes. Throws a plain Error on bad
 * input (unknown template, bad slug data, bad contract, bad links).
 * Returns { files: [{ path, content }], title, byteSize }.
 */
export function buildSiteBundle(template, data) {
  if (!SITE_TEMPLATES[template]) throw new Error('Unknown template.');
  const d = data ?? {};
  if (template === 't5_links') {
    if (!String(d.title ?? '').trim()) throw new Error('A title is required.');
    if (!Array.isArray(d.links) || d.links.length === 0) throw new Error('At least one link is required.');
    for (const l of d.links) {
      if (!l?.label || !isValidHttpsUrl(l.url)) throw new Error('Each link needs a label and a valid https URL.');
    }
    const content = buildT5(d);
    return { files: [{ path: 'index.html', content }], title: String(d.title), byteSize: content.length };
  }
  // t1_launch
  if (!String(d.name ?? '').trim()) throw new Error('A project name is required.');
  if (!isValidContract(d.contract)) throw new Error('That contract address does not look right (0x + 40 hex).');
  for (const [k, v] of Object.entries(d.links ?? {})) {
    if (v && !isValidHttpsUrl(v)) throw new Error(`The ${k} link must be a valid https URL.`);
  }
  const content = buildT1(d);
  return { files: [{ path: 'index.html', content }], title: `${d.name} — Token launch`, byteSize: content.length };
}

// ── Registry (owner-sealed; a site id alone never grants access) ───────────

export async function createSite({ ownerTgId, slug, template, name, data }) {
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db.insert(pb_sites).values({
    ownerTgId: String(ownerTgId), slug, template, name,
    dataJson: JSON.stringify(data ?? {}), status: 'draft',
    createdAt: now, updatedAt: now,
  }).returning();
  return inserted[0] ?? null;
}

export async function saveSiteFiles(siteId, files) {
  for (const f of files) {
    await db.insert(pb_site_files).values({
      siteId: Number(siteId), path: f.path, content: f.content,
      createdAt: Math.floor(Date.now() / 1000),
    }).run();
  }
}

export async function getOwnedSite(tgId, siteId) {
  const sid = Number(siteId);
  if (!Number.isSafeInteger(sid) || sid <= 0) return null;
  try {
    const row = await db.select().from(pb_sites)
      .where(and(eq(pb_sites.id, sid), eq(pb_sites.ownerTgId, String(tgId)))).get();
    return row ?? null;
  } catch { return null; }
}

export async function getSiteBySlug(slug) {
  try {
    const row = await db.select().from(pb_sites)
      .where(eq(pb_sites.slug, String(slug))).get();
    return row ?? null;
  } catch { return null; }
}

export async function listOwnedSites(tgId) {
  try {
    return await db.select().from(pb_sites)
      .where(eq(pb_sites.ownerTgId, String(tgId))).all();
  } catch { return []; }
}

export async function getSiteFiles(siteId) {
  try {
    return await db.select().from(pb_site_files)
      .where(eq(pb_site_files.siteId, Number(siteId))).all();
  } catch { return []; }
}

export async function setSiteStatus(siteId, status, extra = {}) {
  try {
    await db.update(pb_sites).set({
      status, ...extra, updatedAt: Math.floor(Date.now() / 1000),
    }).where(eq(pb_sites.id, Number(siteId))).run();
    return true;
  } catch { return false; }
}

export async function listPendingDeploySites() {
  try {
    return await db.select().from(pb_sites)
      .where(eq(pb_sites.status, 'pending_deploy')).all();
  } catch { return []; }
}
