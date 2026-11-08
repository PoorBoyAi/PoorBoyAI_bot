// Mini App: the caller's OWN Business Bot settings (Dashboard wave item 1).
// Identity comes ONLY from ctx.initData; the view is scoped to that id and
// ineligible callers get empty fields — never another user's settings.
import { caller, ensureUser } from '../lib/miniapp.js';
import { businessSettingsView } from '../lib/business.js';

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  return await businessSettingsView(tg.id);
};
