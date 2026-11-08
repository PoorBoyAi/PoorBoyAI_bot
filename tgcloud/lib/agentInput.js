// Shared input handling for the Mini App agent endpoints (M2).
//
// Maps the app's flat field names to the snake_case config keys the tick's
// executor (lib/tick.js runAgentTool) actually reads, and validates them.
// Agent types are the three the tick can execute: auto_shill | price_alert
// | daily_recap.
//
// NOTE (spec vs. tick disagreement): PB-MINI-APP-SPEC.md §3.3 lists agent
// kinds "price watch, wallet watch, keyword watch". The tick's executor only
// knows auto_shill / price_alert / daily_recap — anything else throws
// "Unknown agent type" on every cycle, so creating wallet/keyword-watch rows
// would spawn permanently broken agents. We accept the three real types; the
// app UI can label price_alert as "Price watch".

import { EndpointError } from 'sdk';

export const AGENT_TYPES = ['auto_shill', 'price_alert', 'daily_recap'];
export const AGENT_STATUSES_USER = ['active', 'paused']; // user-settable; expired|triggered are system states

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function bad(message, field) {
  throw new EndpointError(message, { code: 'VALIDATION', field });
}

function needString(input, field, label, maxLen = 128) {
  const s = String(input[field] ?? '').trim();
  if (!s) bad(`PB needs a ${label} for this agent.`, field);
  if (s.length > maxLen) bad(`That ${label} is too long (max ${maxLen} characters).`, field);
  return s;
}

function optString(input, field, maxLen = 256) {
  const s = String(input[field] ?? '').trim();
  if (s.length > maxLen) bad(`That value is too long (max ${maxLen} characters).`, field);
  return s;
}

function needAddress(input, field) {
  const s = needString(input, field, 'contract address', 64);
  if (!ADDR_RE.test(s)) bad('That contract address does not look like a 0x… address (40 hex chars).', field);
  return s;
}

function needPrice(input, field) {
  const n = Number(input[field]);
  if (!Number.isFinite(n) || n <= 0) bad('Target price must be a number greater than 0.', field);
  return n;
}

function needDirection(input, field) {
  const d = String(input[field] ?? 'above').toLowerCase().trim();
  if (d !== 'above' && d !== 'below') bad('Direction must be "above" or "below".', field);
  return d;
}

function optUrl(input, field) {
  const s = optString(input, field);
  if (s && !/^https?:\/\//i.test(s)) bad('That URL must start with http:// or https://.', field);
  return s;
}

function needGroups(input, field) {
  const g = input[field] ?? [];
  if (!Array.isArray(g)) bad('Target groups must be a list of chat ids.', field);
  return g.map((x) => {
    const s = String(x).trim();
    if (!s) bad('Target groups must not contain empty entries.', field);
    return s;
  });
}

/**
 * Validate flat app input and return the tick-shaped snake_case config.
 * Throws EndpointError(VALIDATION/UNKNOWN_TYPE) on bad input.
 */
export function buildAgentConfig(agentType, input = {}) {
  input = input ?? {};
  const type = String(agentType ?? '').trim();
  if (!AGENT_TYPES.includes(type)) {
    throw new EndpointError(
      `Unknown agent type "${type}". PB can run: auto_shill, price_alert, daily_recap.`,
      { code: 'UNKNOWN_TYPE' },
    );
  }

  const chain = String(input.chain ?? 'base').toLowerCase().trim();
  if (chain !== 'base' && chain !== 'sol') bad('Chain must be "base" or "sol".', 'chain');

  const cfg = {
    chain,
    target_groups: needGroups(input, 'targetGroups'),
  };

  if (type === 'auto_shill') {
    cfg.token_name = needString(input, 'tokenName', 'token name', 64);
    cfg.token_ticker = (optString(input, 'tokenTicker', 16) || 'TKN').toUpperCase();
    cfg.contract_address = needAddress(input, 'contractAddress');
    const ih = Number(input.intervalHours ?? 6);
    if (!Number.isFinite(ih) || ih <= 0 || ih > 168) bad('Interval must be between 1 and 168 hours.', 'intervalHours');
    cfg.interval_hours = ih;
    const wu = optUrl(input, 'websiteUrl');
    const tu = optUrl(input, 'telegramUrl');
    if (wu) cfg.website_url = wu;
    if (tu) cfg.telegram_url = tu;
  }

  if (type === 'price_alert') {
    cfg.contract_address = needAddress(input, 'contractAddress');
    cfg.token_name = (optString(input, 'tokenName', 64) || 'TOKEN').toUpperCase();
    cfg.target_price = needPrice(input, 'targetPrice');
    cfg.direction = needDirection(input, 'direction');
    cfg.fire_once = input.fireOnce !== false;
    const ch = Number(input.cooldownHours ?? 24);
    if (!Number.isFinite(ch) || ch <= 0) bad('Cooldown must be a positive number of hours.', 'cooldownHours');
    cfg.cooldown_hours = ch;
  }

  if (type === 'daily_recap') {
    cfg.token_name = needString(input, 'tokenName', 'token name', 64);
    cfg.token_ticker = (optString(input, 'tokenTicker', 16) || 'TKN').toUpperCase();
    cfg.contract_address = needAddress(input, 'contractAddress');
  }

  return cfg;
}

/** Flatten a stored tick config back to flat app field names (for edits). */
export function flattenAgentConfig(config = {}) {
  return {
    tokenName: config.token_name ?? '',
    tokenTicker: config.token_ticker ?? '',
    contractAddress: config.contract_address ?? '',
    chain: config.chain ?? 'base',
    websiteUrl: config.website_url ?? '',
    telegramUrl: config.telegram_url ?? '',
    targetGroups: Array.isArray(config.target_groups) ? [...config.target_groups] : [],
    intervalHours: config.interval_hours ?? 6,
    targetPrice: config.target_price ?? '',
    direction: config.direction ?? 'above',
    fireOnce: config.fire_once !== false,
    cooldownHours: config.cooldown_hours ?? 24,
  };
}
