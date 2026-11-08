// Mini App skills catalog for the caller — registry order, display metadata
// from SKILL_CATALOG (lib/skills.js is the single source of truth), and a
// per-skill lock state computed from the catalog's gate spec via
// gateLockedFor() — the exact tier sets skillGateText() enforces server-side
// in runSkill, so the badge and the wall can never drift apart.
import { caller, ensureUser } from '../lib/miniapp.js';
import { SKILLS, SKILL_CATALOG, SKILL_CATEGORIES, gateLockedFor } from '../lib/skills.js';
import { effectiveTier } from '../lib/posts.js';
import { canonicalTier } from '../lib/tiers.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  let user = null;
  try {
    user = await ensureUser(tg);
  } catch { user = null; }

  let effTier = 'free';
  try {
    effTier = await effectiveTier(tg.id, user);
  } catch { effTier = String(user?.tier ?? 'free').toLowerCase(); }

  let tier = 'free';
  try {
    tier = canonicalTier(effTier);
  } catch { tier = 'free'; }

  const skills = Object.keys(SKILLS).map((name) => {
    const meta = SKILL_CATALOG[name] ?? {
      title: name, blurb: '', category: 'more', gate: 'none', gateSet: 'none',
      needsInput: 'none', inputHint: null,
    };
    const locked = gateLockedFor(meta.gateSet ?? 'none', effTier);
    const entry = {
      name,
      title: meta.title,
      blurb: meta.blurb,
      category: meta.category ?? 'more',
      categoryLabel: SKILL_CATEGORIES[meta.category] ?? 'More',
      gate: meta.gate ?? 'none',
      needsInput: meta.needsInput,
      inputHint: meta.inputHint ?? null,
      locked,
      lockLabel: locked ? (meta.lockLabel ?? null) : null,
    };
    if (Array.isArray(meta.kinds)) {
      entry.kinds = meta.kinds.map((k) => ({
        id: k.id,
        label: k.label,
        locked: gateLockedFor(k.gateSet, effTier),
        lockLabel: k.lockLabel ?? null,
      }));
    }
    return entry;
  });

  return { tier, skills };
};
