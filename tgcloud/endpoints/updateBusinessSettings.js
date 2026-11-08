// Mini App: update ONE of the caller's OWN Business Bot settings fields
// (Dashboard wave item 1). Owner-or-Starter+ is enforced server-side via
// canUseBusinessBot — the same gate business_message applies live. Writes
// go through saveBizSettings, which writes exactly the store
// loadBizSettings reads (settings table, or the business_bot_* config
// keys for the owner's migrated pattern).
import { EndpointError } from 'sdk';
import { caller, ensureUser } from '../lib/miniapp.js';
import { canUseBusinessBot, saveBizSettings, businessSettingsView, BIZ_MODES } from '../lib/business.js';

const STRING_FIELDS = {
  systemPrompt: 'customSystemPrompt',
  greetingMessage: 'greetingMessage',
  fixedMessage: 'fixedMessage',
  fallbackMessage: 'fallbackMessage',
};
const MAX_LEN = 2000;

export default async (input, ctx) => {
  const tg = caller(ctx);
  await ensureUser(tg);
  if (!(await canUseBusinessBot(tg.id).catch(() => false))) {
    throw new EndpointError('Business Bot needs a Starter plan or higher.', { code: 'NOT_ELIGIBLE' });
  }
  const field = String(input?.field ?? '');
  const value = input?.value;
  if (field === 'mode') {
    if (!BIZ_MODES.includes(value)) {
      throw new EndpointError('Mode must be one of: ' + BIZ_MODES.join(', '), { code: 'BAD_MODE' });
    }
    await saveBizSettings(tg.id, { replyMode: value });
  } else if (field === 'aiEnabled') {
    if (typeof value !== 'boolean') {
      throw new EndpointError('aiEnabled must be a boolean.', { code: 'BAD_VALUE' });
    }
    await saveBizSettings(tg.id, { aiEnabled: value });
  } else if (STRING_FIELDS[field]) {
    if (typeof value !== 'string') {
      throw new EndpointError(field + ' must be a string.', { code: 'BAD_VALUE' });
    }
    if (value.length > MAX_LEN) {
      throw new EndpointError(field + ' is capped at ' + MAX_LEN + ' characters.', { code: 'TOO_LONG' });
    }
    const clean = value.trim();
    await saveBizSettings(tg.id, { [STRING_FIELDS[field]]: clean || null });
  } else {
    throw new EndpointError('Unknown settings field: ' + field, { code: 'BAD_FIELD' });
  }
  return await businessSettingsView(tg.id);
};
