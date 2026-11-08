// PB command catalog — single source of truth.
// Ported verbatim (data only) from artifacts/api-server/src/lib/command-catalog.ts.
// Registration parity: the message handler must only dispatch names from here.

import { api } from 'sdk';
import { getConfig, setConfig } from './config.js';

export const TELEGRAM_COMMAND_NAMES = [
  "start", "help", "about", "docs", "menu", "socials", "myid", "status",
  "price", "chart", "ta", "scan", "pbai", "ca", "howtobuy", "howtouse", "buy",
  "ask", "raid", "raidrank", "raidsetup", "lb", "profile", "settings", "link",
  "connect", "claimholder", "squad", "squads", "gm", "poor2rich", "rules", "gem",
  "alert", "portfolio", "balance", "idea", "quote", "debate", "recap", "tldr",
  "bullpost", "bearpost", "moonpost", "fudpost", "gempost", "translate",
  "fudshield", "sentiment", "event", "milestone", "advertise", "mytier", "upgrade",
  "everyone", "syncmembers", "analyze", "generate", "meme", "pfp", "create",
  "callout", "alpha", "nftpost", "defipost", "memepost", "mysocials", "mytwitter",
  "setwelcome", "setrules", "ban", "kick", "mute", "unmute", "warn", "warns",
  "pin", "unpin", "note", "get", "notes", "filter", "filters", "groupinfo",
  "settoken", "raidnext", "givexp", "reward", "shillraid", "mygroups",
  "remoteshill", "remoteraid", "remotesay", "watchwallet", "boost", "booster",
  "boosterstatus", "bizsetup", "airdrop", "airdropstatus",
];

export const TELEGRAM_REGISTERED_MENU_COMMAND_COUNT = TELEGRAM_COMMAND_NAMES.length;
export const TELEGRAM_COMMAND_COUNT_COPY =
  `${TELEGRAM_REGISTERED_MENU_COMMAND_COUNT} registered Telegram menu commands`;

export const TELEGRAM_COMMAND_ALIASES = {
  ai: "ask",
  img: "generate",
};

// Commands intentionally omitted from the 100-command menu but valid when typed.
export const TELEGRAM_NON_MENU_COMMAND_NAMES = new Set(["invite", "contest", "conteststatus", "contestwinner", "report", "skills",
  // PB Stars lane (2026-11-01, workspace only): /paysupport is typed
  // only — NEVER added to TELEGRAM_COMMAND_NAMES (the menu is at
  // Telegram's 100-command cap) and NEVER added to /help or the menu
  // button grids. Surfacing options without breaking the cap, for a
  // later decision (not taken here): (a) leave it typed-only, as now,
  // documented in the Stars confirmation + /paysupport is named in
  // the Stars shelf footer; (b) swap out a lower-use menu command
  // for it, which needs Rowdy's explicit pick of which command goes;
  // (c) surface it only as an inline button on Stars receipts, never
  // as a menu command. While the lane is OFF the handler behaves
  // exactly like an unknown command, so the name is undiscoverable
  // to members until arming.
  "paysupport"]);

// Commands whose handlers must redirect the user to a DM.
export const TELEGRAM_DM_ONLY_COMMANDS = new Set([
  "link",
  "boost",
  "mygroups",
  "remoteshill",
  "remoteraid",
  "remotesay",
  "dmbroadcast",
  "dmstop",
  "dmfollowup",
  "email",
  "announce",
  "teamadd",
  "teamapprove",
  "teamremove",
]);

// Canonical onboarding set (name + usage + description), from command-catalog.ts.
export const TELEGRAM_SETUP_COMMANDS = [
  { command: "link", description: "connect Telegram to the dashboard", dmOnly: true },
  { command: "help", description: "show the current registered command guide" },
  { command: "ask", usage: "[prompt]", description: "ask PB a question" },
  { command: "generate", usage: "[prompt]", description: "generate an AI image when the active tier allows it" },
  { command: "scan", usage: "[CA]", description: "run the supported token safety scan" },
  { command: "chart", usage: "[contract]", description: "show a token chart" },
  { command: "price", usage: "[contract or symbol]", description: "request live market data" },
  { command: "bullpost", description: "create an on-demand campaign post (PB Plan)" },
  { command: "booster", description: "open Pup Booster guidance" },
  { command: "airdrop", description: "open Airdrop Eagle guidance" },
  { command: "claimholder", description: "verify the Base holder XP perk" },
  { command: "raid", usage: "[post URL]", description: "start a supported raid" },
  { command: "raidsetup", description: "link an X handle for raid verification" },
];

// PB's action markers — legacy marker names, PARSE-ONLY. No executor exists:
// a marker appearing in brain output triggers no real tool and no action.
// They are recognized for forward-compat only (autonomous execution ships in v2).
export const PB_ACTION_MARKERS = [
  "GENERATE_IMAGE",
  "POST_PRICE",
  "CREATE_POLL",
  "GIVE_XP",
  "START_RAID",
  "HYPE_POST",
  "SEND_ANNOUNCEMENT",
  "START_GAME",
];

export function isPBActionMarker(value) {
  return PB_ACTION_MARKERS.includes(value);
}

export function extractPBActionMarkers(prompt) {
  return [...new Set(
    [...prompt.matchAll(/\[([A-Z][A-Z_]+):/g)].map((match) => match[1]),
  )];
}

export function isSupportedTelegramCommand(name) {
  const lower = String(name ?? "").toLowerCase();
  return TELEGRAM_COMMAND_NAMES.includes(lower)
    || Object.prototype.hasOwnProperty.call(TELEGRAM_COMMAND_ALIASES, lower)
    || TELEGRAM_NON_MENU_COMMAND_NAMES.has(lower);
}

export function resolveCanonicalCommand(name) {
  const lower = String(name ?? "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TELEGRAM_COMMAND_ALIASES, lower)) {
    return TELEGRAM_COMMAND_ALIASES[lower];
  }
  return lower;
}

export function isDmOnlyCommand(name) {
  return TELEGRAM_DM_ONLY_COMMANDS.has(resolveCanonicalCommand(name));
}

// ── Wizard-fix wave (2026-10-21): menu registration + unified help ─────────
// Rowdy's spot-check ("the wizards are missing") traced to discovery, not
// dispatch: the bot had 197+ dispatchable names but NO setMyCommands
// anywhere — the live "/" menu was a frozen pre-move list, full at
// Telegram's 100 cap, with every restored wizard absent from it, and
// /help rendered the same frozen catalog. This section is the single
// source of truth that ends that: ONE description map + ONE section map
// below feed (a) the scoped setMyCommands lists and (b) the /help text,
// so the two surfaces can never drift apart again.
//
// Descriptions for the 100 catalog commands are the original's own menu
// copy (telegram-community-bot.ts telegramMenuCommands), adjusted only
// where the sentence had gone false (help's count claim, /boost's parked
// state). Descriptions for EXTRA_COMMANDS names are new, written to match.
export const COMMAND_DESCRIPTIONS = {
  // Core
  start: 'Welcome & intro',
  help: 'Command guide — everything PB can do',
  about: 'About PoorBoyAI',
  docs: 'White paper, privacy policy & legal docs',
  menu: 'Full feature menu — tap any button to explore',
  socials: 'All official links (clickable)',
  myid: 'Your Telegram user ID & chat ID',
  status: 'Bot status & uptime',
  // Crypto & TA
  price: 'Live $PBAI price (or any token)',
  chart: 'DexScreener chart link',
  ta: 'Full TA — RSI + MACD + Bollinger + S/R',
  scan: 'Security scan — honeypot, taxes, rug check',
  pbai: '$PBAI token info — CA, price, chart & buy links',
  ca: 'Show the $PBAI contract address (Base)',
  howtobuy: 'How to buy $PBAI (Base or any chain)',
  howtouse: 'Full guide — bot commands + dashboard walkthrough',
  buy: 'Buy Studio credit packs — 500 / 2,000 / 5,000 credits',
  ask: 'Ask the AI anything (PB Plan — unlimited)',
  // Raids & community
  raid: 'Launch a live raid — XP, counter, leaderboard',
  raidrank: 'Raid XP Hall of Fame — top raiders all time',
  raidsetup: 'Register your Twitter handle for auto-verified raids',
  lb: 'XP leaderboard — /lb 1D | 7D | 30D | ALL',
  profile: 'Your PB Army rank, XP, streak & squad',
  settings: 'Your settings — notifications, shill style, tier, referral',
  link: 'Link your dashboard subscription to this bot',
  connect: 'Link your wallet address for rewards',
  claimholder: 'Claim $PBAI holder status for 1.5x XP on raids',
  squad: 'PB Army squads — create, join, leave, info',
  squads: 'Top raid squads leaderboard',
  gm: 'GM! — daily degen greeting from the PoorBoy Army',
  poor2rich: 'PoorBoy motivation from the trenches',
  rules: 'Show group rules',
  gem: 'Hot gems trending on Base (PB Plan)',
  alert: 'Set a price alert (PB Plan)',
  kill: 'Delete one of your price alerts',
  portfolio: 'Check wallet holdings (PB Plan)',
  balance: 'ETH balance of wallet (PB Plan)',
  idea: 'Random trading idea (PB Plan)',
  quote: 'Savage or inspiring quote (PB Plan)',
  debate: 'AI bull vs bear debate on any token (PB Plan)',
  recap: 'AI summary of recent chat (PB Plan)',
  tldr: 'Quick TLDR of recent chat (PB Plan)',
  bullpost: 'AI bullish shill post for your token (PB Plan)',
  bearpost: 'AI bear-slayer post — counter FUD (PB Plan)',
  moonpost: 'AI moon-hype post — max WAGMI energy (PB Plan)',
  fudpost: 'AI anti-FUD post — reframe bullish (PB Plan)',
  gempost: 'AI gem call post — hidden alpha drop (PB Plan)',
  translate: 'Auto-translate messages — /translate on/off (PB Plan)',
  fudshield: 'Auto counter coordinated FUD — /fudshield on/off (PB Plan)',
  sentiment: 'Live community mood analysis (PB Plan)',
  event: 'Schedule events with countdown (PB Plan)',
  milestone: 'Price milestone auto-celebrations (PB Plan)',
  advertise: 'Advertise your project in groups (PB Plan)',
  mytier: 'Your subscription tier & daily usage',
  upgrade: 'Upgrade to the PB Plan — $29/mo, 7-day free trial',
  wizbuy: 'Buy with PB — transfer checkout for tiers, packs & Ad Creator (DM only)',
  everyone: 'Tag all registered group members (PB Plan admin)',
  syncmembers: 'Register all members for /everyone — tap-to-enroll (PB Plan admin)',
  analyze: 'Deep AI token analysis (PB Plan)',
  generate: 'Generate an AI image (PB Plan)',
  meme: 'Generate a degen meme (PB Plan)',
  pfp: 'Generate a custom AI profile pic (PB Plan)',
  create: 'Studio — AI video ads, voiceover + captions (1 free trial)',
  callout: 'AI numbered callout thread (PB Plan)',
  alpha: 'AI insider alpha drop post (PB Plan)',
  nftpost: 'AI NFT hype post (PB Plan)',
  defipost: 'AI DeFi content post (PB Plan)',
  memepost: 'AI meme-culture shill post (PB Plan)',
  mysocials: 'Manage linked social accounts — X, TikTok, Discord',
  mytwitter: 'Check linked Twitter/X status',
  // Group management (admins)
  setwelcome: 'Set welcome message for new members (admin)',
  setrules: 'Set group rules (admin)',
  ban: 'Ban a user — reply to their message (admin)',
  kick: 'Kick a user — reply to their message (admin)',
  mute: 'Mute a user — reply to their message (admin)',
  unmute: 'Unmute a user — reply to their message (admin)',
  warn: 'Warn a user — reply to their message (admin)',
  warns: "Check a user's warnings",
  pin: 'Pin a message — reply to it with /pin (admin)',
  unpin: 'Unpin a message (admin)',
  note: 'Save a note (admin)',
  get: 'Get a saved note',
  notes: 'List all saved notes',
  filter: 'Add keyword auto-reply (admin)',
  filters: 'List keyword filters',
  groupinfo: 'View all group settings',
  settoken: "Set group's featured token (admin)",
  raidnext: 'Add a raid to the queue (admin)',
  givexp: 'Give XP to a raider — /givexp @user amount (admin)',
  reward: 'Issue a reward notice with wallet (admin)',
  shillraid: 'AI shill post + live raid in one — community earns XP (PB Plan)',
  mygroups: 'List your linked community groups (DM only)',
  remoteshill: 'Send an AI shill post to YOUR group — /remoteshill #1 (PB Plan)',
  remoteraid: 'Launch a raid in YOUR group — /remoteraid #1 url mission (PB Plan)',
  remotesay: 'Send a custom message to YOUR group — /remotesay #1 text (PB Plan)',
  watchwallet: 'Watch or remove wallets — /watchwallet 0xADDR (PB Plan)',
  boost: 'Volume Booster wizard — live for quotes, deposits, planning',
  booster: 'Check boost status or launch a campaign with an existing pack',
  boosterstatus: 'Check your boost packs, scheduled boosts & running campaigns',
  bizsetup: 'Configure your Business Bot AI settings (PB Plan)',
  airdrop: 'Launch a token airdrop campaign to connected wallets (sends parked until armed)',
  airdropstatus: 'Check the status of your airdrop campaigns',
  // EXTRA_COMMANDS (post-catalog waves) that surface in menus / help
  manage: 'Group Manager — panels for your groups (admin)',
  setup: 'Campaign setup wizard (DM)',
  remote: 'Remote-control wizard — act inside your groups',
  apply: 'Apply to work with PoorBoyAI',
  support: 'Open a support ticket',
  promo: 'Redeem a promo code',
  redeem: 'Redeem a promo / gift code',
  email: 'PB email updates: set / status / off',
  podcast: 'Podcast Studio — AI podcast videos',
  // E4a completeness restores (2026-10-21) — typed commands, not in the
  // "/" menus (cap), exactly like /relay + /email.
  setsupport: 'Toggle support mode in this group (owner)',
  autoread: 'Auto Vision — PB reads group photos automatically (admin, PB Plan)',
  setflood: 'Set anti-flood limit — /setflood <limit> [seconds] (admin)',
  flood: 'Show the anti-flood setting',
  setgoodbye: 'Set the goodbye message for leaving members (admin)',
  resetgoodbye: 'Clear the goodbye message (admin)',
  pbblast: 'Owner blast — PB feature announcement to all groups + users',
  pbnews: 'Owner blast — PB news announcement to all groups + users',
  pbbuynews: 'Owner blast — buy $PBAI from any chain announcement',
  pbbooster: 'Owner blast — Pup Booster promo to free users + groups',
  airdropblast: 'Owner blast — $PBAI airdrop announcement',
  roadmap: 'PoorBoyAI development roadmap',
  ecosystem: 'The PoorBoyAI ecosystem — live status of every piece',
  discord: 'PoorBoyAI on Discord — server invite + bot invite',
  volume: 'Volume profile for a token — /volume [token]',
  calloutnow: 'Publish this group\'s featured token to PoorBoy Callz (admin)',
  setcalloutchannel: 'Set this chat as the PoorBoy Callz channel (owner)',
  mytoken: 'Show this group\'s featured token',
  disqualified: 'List disqualified users in this group',
  scanmods: 'Scan for pre-existing bans/mutes (owner)',
  workerpin: 'Post + pin the Worker Marketplace card (owner)',
  supportrecap: 'AI recap of recent support sessions (owner)',
  testbuy: 'Fire a test $PBAI buy alert here (owner)',
  testcallout: 'Send a test PoorBoy Callz card to the channel (owner)',
  kitregister: 'Register a LaunchPad kit coin + fire its launch announcement (owner)',
  kitlist: 'List registered LaunchPad kit coins (owner)',
  kitraid: 'Book a kit raid slot for a kit coin (owner)',
  kitraidlist: 'List kit raid slots (owner)',
  keep_posting_till_elon_reposts: 'The Elon mission — one signal post a day',
  contest: 'Start a community contest (admin)',
  conteststatus: 'Current contest status',
  contestwinner: 'Draw contest winners (admin)',
  campaign: 'Your campaign panel',
  buycomp: 'Buy competitions — standings & prizes',
  vote: 'Vote a token onto the Trending board',
  trending: 'PB Trending — top voted & bought tokens',
  xprewards: 'XP Rewards — wallet & holder perks',
  mywallet: 'Your linked wallets',
  digest: 'Your PB daily digest',
  voice: 'Voice notes — PB reads his replies aloud (on/off)',
  crosslink: 'Cross Protect — link two groups (admin)',
  wl: 'Group whitelist (admin)',
  addban: 'Ban a word in this group (admin)',
  removeban: 'Unban a word (admin)',
  bans: 'List banned words',
  unban: 'Unban a user (admin)',
  delnote: 'Delete a saved note (admin)',
  unfilter: 'Remove a keyword filter (admin)',
  resetwelcome: 'Clear the welcome message (admin)',
  removetoken: "Clear the group's featured token (admin)",
  setwarnmax: 'Set the warning limit (admin)',
  resetwarn: "Reset a user's warnings (admin)",
  points: 'Your XP points',
  pointsrank: 'XP points ranking',
  invite: 'Your referral link & invite stats',
  mywatched: "Wallets you're watching",
  unwatchwallet: 'Stop watching a wallet',
  queue: 'The raid queue',
  globalboard: 'Global XP leaderboard',
  whitepaper: 'Read the PoorBoyAI whitepaper',
  moonit: 'MoonIt — moon math mode',
  rsi: 'RSI indicator for a token',
  macd: 'MACD indicator for a token',
  bollinger: 'Bollinger Bands for a token',
  ping: 'Ping — is PB awake?',
  skills: 'PB Skills — tap-to-run tools',
  stats: 'PB bot & community stats',
  groupstats: "This group's stats",
  hype: 'Write a hype post',
  gems: 'The featured gems list',
  schedule: 'Schedule a daily group post (admin)',
  schedules: 'List scheduled posts',
  unschedule: 'Remove a scheduled post (admin)',
  freechat: 'Free-chat mode toggle (owner)',
  connecttwitter: 'Connect socials + your own X API keys (PB Plan)',
  disconnecttwitter: 'Disconnect your X API keys',
  menusync: "Re-register the '/' command menus (owner)",
  disqualify: 'Disqualify a buy-competition entry (admin)',
  undisqualify: 'Undo a buy-competition disqualification (admin)',
  setemoji: 'Set the buy-alert emoji (admin)',
  setgif: 'Set the buy-alert GIF (admin)',
  setstep: 'Set the buy-alert step size (admin)',
  setminbuy: 'Set the minimum tracked buy (admin)',
  setwhale: 'Set the whale-buy threshold (admin)',
  setwhalebal: 'Set the whale-badge balance threshold (admin)',
  milestones: 'Toggle buy milestone alerts (admin)',
  hourly: 'Toggle the hourly buy stats card (admin)',
  pause: 'Pause buy alerts (admin)',
  resume: 'Resume buy alerts (admin)',
  cancel: 'Cancel the current setup step',
  tick: "Run PB's clock now (owner)",
  setkey: 'Store a config secret (owner)',
  leads: 'Lead Finder digest (owner)',
  broadcast: 'Broadcast to all PB groups (owner)',
  dmbroadcast: 'DM a broadcast to all bot users (owner)',
  dmstop: 'Stop the running DM broadcast (owner)',
  dmfollowup: 'DM only the users a stopped DM broadcast never reached (owner)',
  relay: 'PB Relay — auto-copy posts between your chats (PB Plan)',
  announce: 'PB Announce — make a graphic announcement post for your project (PB Plan)',
  relaystop: 'Stop all relays touching this chat (admin)',
  relayhere: 'Offer this group to your relay wizard (admin)',
  // PB Shield (2026-10-21) — typed command, not in the "/" menus (cap),
  // exactly like /relay + /email.
  shield: 'PB Shield — scam-bot protection for this group: /shield on|off|status|log (admin)',
  // PB Cleanup (2026-10-22) — typed command, not in the "/" menus (cap),
  // exactly like /shield. The honesty line is part of the description:
  // PB tidies what it sees and its own replies — it can't rewind or
  // scan old chat history.
  cleanup: 'PB Cleanup — auto-tidy for this group: member command clutter + PB replies auto-delete after a TTL (default 6h). PB tidies what it sees and its own replies — it can\'t rewind or scan old chat history: /cleanup on|off|status|now|ttl (admin)',
  // Signal Inlet (2026-10-23) — typed command, not in the "/" menus
  // (cap), exactly like /shield + /cleanup.
  signals: 'Signal Inlet — pipe your own TradingView / webhook alerts into this group, sealed to this chat only (per-group secret, shown once; signals are display-only, PB never trades on them): /signals create|rotate|status|setup|topic|rate|on|off (admin, PB Plan)',
  // PB Cleanup phase 2 (2026-10-22) — typed command, not in the "/"
  // menus (cap), exactly like /cleanup. The honesty line is part of the
  // description: PB only sees messages that arrive while it's connected.
  bizclean: 'PB Cleanup for your Business chats — junk in the chats PB manages for you is flagged as it arrives and auto-deleted after a grace period; PB only sees messages that arrive while it\'s connected — it can\'t scan or clean chats from before the connection: /bizclean status|on|off|rules|grace|sweep (DM, needs PB connected in Telegram Settings → Business → Chatbots)',
  // PB Research packaging wave (2026-10-22) — typed command, not in the
  // "/" menus (cap), exactly like /relay + /email + /shield.
  research: 'PB Research — the whole research suite on one card: discover → investigate → monitor → act',
};

// Scoped menu lists (ordered by user value; each ≤ Telegram's 100 cap).
// The private list carries EVERY wizard entry command; the group list
// carries the group/admin working set. The default scope mirrors the
// private list (most users meet PB in DM; group chats are overridden by
// the all_group_chats scope).
export const MENU_PRIVATE_COMMANDS = [
  // Core, AI & markets
  'start', 'help', 'menu', 'about', 'docs', 'ask', 'price', 'chart', 'ta',
  'rsi', 'macd', 'bollinger', 'scan', 'analyze', 'generate', 'meme', 'pfp',
  'pbai', 'ca', 'howtobuy', 'howtouse', 'buy', 'upgrade', 'mytier', 'myid',
  'status', 'profile', 'settings', 'link', 'connect', 'mywallet',
  'claimholder', 'portfolio', 'balance', 'watchwallet', 'mywatched',
  'unwatchwallet', 'alert', 'gem', 'gems', 'trending', 'vote', 'buycomp',
  // Raids & community
  'raid', 'raidsetup', 'raidrank', 'lb', 'squad', 'squads', 'gm',
  'poor2rich', 'rules', 'idea', 'quote', 'debate', 'recap', 'tldr',
  'bullpost', 'bearpost', 'moonpost', 'fudpost', 'gempost', 'nftpost',
  'defipost', 'memepost', 'alpha', 'callout', 'sentiment', 'translate',
  'event', 'milestone', 'digest', 'points', 'invite',
  // Wizards & panels
  'create', 'podcast', 'setup', 'remote', 'campaign', 'manage', 'apply',
  'support', 'promo', 'redeem', 'contest', 'xprewards', 'socials',
  'mysocials', 'mytwitter', 'connecttwitter', 'disconnecttwitter',
  'bizsetup', 'boost', 'booster', 'boosterstatus', 'airdrop',
  'airdropstatus', 'voice', 'advertise', 'menusync',
];

export const MENU_GROUP_COMMANDS = [
  'start', 'help', 'menu', 'ask', 'price', 'chart', 'ta', 'scan', 'pbai',
  'ca', 'raid', 'raidsetup', 'raidrank', 'lb', 'profile', 'squad', 'squads',
  'gm', 'rules', 'idea', 'quote', 'sentiment', 'fudshield', 'translate',
  'event', 'milestone', 'trending', 'vote', 'buycomp', 'bullpost',
  'bearpost', 'moonpost', 'fudpost', 'gempost', 'shillraid', 'raidnext',
  'queue', 'everyone', 'syncmembers', 'manage', 'setwelcome', 'setrules',
  'ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'warns', 'setwarnmax',
  'resetwarn', 'pin', 'unpin', 'note', 'get', 'notes', 'delnote', 'filter',
  'unfilter', 'filters', 'groupinfo', 'settoken', 'removetoken', 'givexp',
  'reward', 'disqualify', 'undisqualify', 'wl', 'addban', 'removeban',
  'bans', 'crosslink', 'setemoji', 'setgif', 'setstep', 'setminbuy',
  'setwhale', 'setwhalebal', 'milestones', 'hourly', 'pause', 'resume',
  'cancel', 'schedule', 'schedules', 'unschedule', 'freechat',
  'globalboard', 'claimholder', 'points', 'pointsrank', 'groupstats',
  'contest', 'conteststatus', 'contestwinner', 'gem', 'alert', 'kill',
  'watchwallet',
];

// /help sections: every dispatchable command name appears in exactly one
// section (the harness asserts set-equality against the live registry);
// registration-only aliases (ai, img, save, tagall, manager) render in the
// aliases line instead. The "/" menus above carry the per-command
// descriptions (COMMAND_DESCRIPTIONS); /help is the grouped index.
export const HELP_SECTIONS = [
  ['🚀 Start here', ['start', 'help', 'menu', 'about', 'docs', 'socials', 'howtouse', 'myid', 'status', 'ping', 'whitepaper', 'roadmap', 'ecosystem', 'discord', 'skills']],
  ['🤖 Ask PB & AI content', ['ask', 'generate', 'meme', 'pfp', 'analyze', 'idea', 'quote', 'debate', 'recap', 'tldr', 'sentiment', 'translate', 'moonit', 'hype']],
  ['📈 Markets & TA', ['price', 'chart', 'ta', 'rsi', 'macd', 'bollinger', 'volume', 'scan', 'pbai', 'ca', 'howtobuy', 'buy', 'gem', 'gems', 'addgem', 'removegem', 'alert', 'kill', 'portfolio', 'balance', 'stats', 'groupstats', 'mytoken', 'research']],
  ['⚔️ Raids & XP', ['raid', 'raidsetup', 'raidrank', 'raidnext', 'queue', 'delnext', 'clearnext', 'lb', 'profile', 'squad', 'squads', 'points', 'pointsrank', 'xprewards', 'claimholder', 'givexp', 'reward', 'disqualify', 'undisqualify', 'disqualified', 'lbreset', 'remxp']],
  ['🎉 Community & posts', ['gm', 'poor2rich', 'rules', 'bullpost', 'bearpost', 'moonpost', 'fudpost', 'gempost', 'nftpost', 'defipost', 'memepost', 'alpha', 'callout', 'calloutnow', 'event', 'milestone', 'advertise', 'shillraid', 'keep_posting_till_elon_reposts', 'announce']],
  ['🏆 Trending, votes & contests', ['trending', 'vote', 'buycomp', 'contest', 'conteststatus', 'contestwinner', 'globalboard']],
  ['🎬 Studio, podcasts & campaigns', ['create', 'podcast', 'campaign', 'setup', 'bizsetup', 'bizclean']],
  ['📡 Relay (PB Plan)', ['relay', 'relaystop', 'relayhere']],
  ['💸 Boost & airdrops (sends parked until armed)', ['boost', 'booster', 'boosterstatus', 'boostquote', 'myboosts', 'boostdetail', 'airdrop', 'airdropstatus', 'mydrop' + 's', 'dropdetail']],
  ['🔗 Accounts, wallets & socials', ['link', 'connect', 'mywallet', 'mywatched', 'watchwallet', 'unwatchwallet', 'mysocials', 'mytwitter', 'connecttwitter', 'disconnecttwitter', 'promo', 'redeem', 'email', 'voice', 'digest', 'invite', 'mytier', 'upgrade', 'wizbuy', 'settings']],
  ['🛡️ Group admin', ['manage', 'crosslink', 'wl', 'addban', 'removeban', 'bans', 'setwelcome', 'resetwelcome', 'setrules', 'ban', 'unban', 'kick', 'mute', 'unmute', 'warn', 'warns', 'setwarnmax', 'resetwarn', 'pin', 'unpin', 'note', 'get', 'notes', 'delnote', 'filter', 'unfilter', 'filters', 'groupinfo', 'settoken', 'removetoken', 'everyone', 'syncmembers', 'schedule', 'schedules', 'unschedule', 'noads', 'enableads', 'checkuser', 'modlist', 'fudshield', 'shield', 'cleanup', 'signals', 'setflood', 'flood', 'setgoodbye', 'resetgoodbye', 'autoread']],
  ['💎 Buy Bot (group admins)', ['setemoji', 'setgif', 'setstep', 'setminbuy', 'setwhale', 'setwhalebal', 'milestones', 'hourly', 'pause', 'resume', 'cancel']],
  ['🛰️ Remote control & help desk', ['mygroups', 'remoteshill', 'remoteraid', 'remotesay', 'remote', 'apply', 'support']],
  ['👑 Owner', ['tick', 'setkey', 'menusync', 'leads', 'broadcast', 'dmbroadcast', 'dmstop', 'dmfollowup', 'globalban', 'globalunban', 'settier', 'slayer', 'freechat', 'setsupport', 'supportrecap', 'pbblast', 'pbnews', 'pbbuynews', 'pbbooster', 'airdropblast', 'scanmods', 'workerpin', 'setcalloutchannel', 'testbuy', 'testcallout', 'kitregister', 'kitlist', 'kitraid', 'kitraidlist', 'armairdrop', 'armboost', 'moneycaps', 'moneyops', 'dropfee', 'buyrewards', 'admindrop', 'seedgas', 'smoketest', 'teamadd', 'teamapprove', 'teamremove']],
];

export const HELP_ALIASES = [
  ['ai', 'ask'], ['img', 'generate'], ['save', 'note'], ['tagall', 'everyone'], ['manager', 'manage'],
];

/** The one /help renderer — message.js /help and the /menu "All
 *  Commands" button both send exactly this text. */
export function renderHelpText() {
  const setup = TELEGRAM_SETUP_COMMANDS
    .map((c) => `/${c.command}${c.usage ? ' ' + c.usage : ''} — ${c.description}${c.dmOnly ? ' (DM only)' : ''}`)
    .join('\n');
  const sections = HELP_SECTIONS
    .map(([title, names]) => `${title}\n${names.map((n) => '/' + n).join(' · ')}`)
    .join('\n\n');
  const aliases = HELP_ALIASES.map(([a, c]) => `/${a} → /${c}`).join(' · ');
  return [
    '🤖 PB — PoorBoyAI command guide',
    '',
    sections,
    '',
    // Fix 1 (2026-10-29): broadcast marking, one short line. The /help
    // split itself is fix 6 and is NOT attempted here.
    '📡 Broadcasts — preview + confirm first: /hype /broadcast /dmbroadcast /dmfollowup /remoteshill /remoteraid /remotesay /pbblast /pbnews /pbbuynews /pbbooster /airdropblast',
    '',
    `Aliases: ${aliases}`,
    '',
    'Quick start:',
    setup,
    '',
    '⭐ Leave a review or 💬 send feedback — tap the buttons in /menu.',
    '',
    'Tip: most commands are in the "/" menu — tap "/" and search. A few are not (like /ping and /relay): type one you don\'t see and PB will run it. Owner & wizard commands live in DM.',
  ].join('\n');
}

// FIX 6 (2026-10-29): /help renders 4195 chars, but both send sites
// slice at 4000 — so it always cut off mid-Tip at "Owner & wizar".
// Split on blank-line boundaries into chunks that fit under the slice
// (3800, with margin), never mid-line; a single over-long paragraph
// falls back to a hard split (no paragraph is that long today, so the
// chunks rejoin with '\n\n' to the exact full text).
export function renderHelpChunks(maxLen = 3800) {
  const text = renderHelpText();
  if (text.length <= maxLen) return [text];
  const paras = text.split('\n\n');
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    const add = cur ? `\n\n${p}` : p;
    if (cur && cur.length + add.length > maxLen) { chunks.push(cur); cur = p; continue; }
    if (add.length > maxLen) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < add.length; i += maxLen) chunks.push(add.slice(i, i + maxLen));
      continue;
    }
    cur += add;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ── Menu registration (self-healing, version-gated) ─────────────────────────
// Bump MENU_CATALOG_VERSION whenever the lists/descriptions above change:
// the tick's menuSync cycle then re-registers exactly once. The owner can
// also force it any time with /menusync in DM. Steady state costs one
// config read per tick — the Bot API is only touched on a version change
// or a manual trigger.
export const MENU_CATALOG_VERSION = 12;
const MENU_VERSION_KEY = 'menu_registered_version';

export function buildMenuLists() {
  const toCmds = (names) => names.map((name) => ({
    command: name,
    description: COMMAND_DESCRIPTIONS[name] ?? name,
  }));
  const priv = toCmds(MENU_PRIVATE_COMMANDS);
  return {
    default: priv,
    private: priv,
    group: toCmds(MENU_GROUP_COMMANDS),
  };
}

export async function registerBotMenus(opts = {}) {
  try {
    const cur = Number(await getConfig(MENU_VERSION_KEY, '0')) || 0;
    if (!opts.force && cur >= MENU_CATALOG_VERSION) {
      return { registered: false, skipped: 'current', version: cur };
    }
    const lists = buildMenuLists();
    await api.setMyCommands({ commands: lists.default });
    await api.setMyCommands({ commands: lists.private, scope: { type: 'all_private_chats' } });
    await api.setMyCommands({ commands: lists.group, scope: { type: 'all_group_chats' } });
    await setConfig(MENU_VERSION_KEY, String(MENU_CATALOG_VERSION));
    await setConfig('menu_registered_at', new Date().toISOString());
    return {
      registered: true,
      version: MENU_CATALOG_VERSION,
      counts: {
        default: lists.default.length,
        private: lists.private.length,
        group: lists.group.length,
      },
    };
  } catch (err) {
    return { registered: false, error: err?.message ?? 'unknown' };
  }
}
