// Pure conversation-routing rules for PB's group replies.
// Ported from artifacts/api-server/src/lib/telegram-conversation-routing.ts.
// A group reply is not an invitation for PB to join member-to-member chatter;
// directly addressing PB remains an explicit override.

function entityMentions(text, entities) {
  if (!text || !entities) return [];
  return entities.flatMap((entity) => {
    if (entity.type === 'mention') {
      return [{ handle: text.slice(entity.offset, entity.offset + entity.length), isNamedUser: false }];
    }
    // Telegram uses text_mention for an explicitly selected user with no @handle.
    if (entity.type === 'text_mention') return [{ isNamedUser: true }];
    return [];
  });
}

function isPbNameInvocation(text) {
  const value = (text ?? '').trim();
  // "PB" at the start counts as talking to PB in Telegram — including bare
  // "PB" on its own (2026-10-24: previously /^pb[,:\s!?]/ required a
  // following character, so a lone "PB" was silently ignored).
  // \b after PB keeps "PBs"/"PBai" from triggering.
  return /\b(hey|yo|sup|hi|hello|wassup)\s+pb\b/i.test(value) ||
    /^pb\b/i.test(value);
}

const PRIVATE_SUPPORT_TOPIC =
  /\b(poorboyai|poorboy|pb|bot|dashboard|account|tier|subscription|payment|pay|upgrade|sign[\s-]?up|link|connect|setup|command|wallet|airdrop|booster|campaign|mission|studio|credit|developer api|api|mcp|raid|xp|holder|token|price|buy)\b/i;

/**
 * Regular-user DMs may answer short product-support questions, but must not
 * become an open-ended private AI chat surface.
 */
export function isQuickPrivateSupportQuestion(text) {
  const value = (text ?? '').trim();
  if (!value || value.length > 280) return false;
  if (/\bhow (?:does|do) (?:this|that|it) work\b/i.test(value)) return true;
  if (/\bwhat can (?:you|pb|the bot) do\b/i.test(value)) return true;
  const isQuestion =
    /\b(?:how (?:does|do|can|to)|what (?:is|are|does|can)|where (?:is|are|do|can)|why (?:is|are|does|do|can)|when (?:is|are|does|do|can|will)|can i|do i|is there|are there)\b/i.test(value);
  return isQuestion && PRIVATE_SUPPORT_TOPIC.test(value);
}

/**
 * Decides whether PB may enter a conversation. Reply-to-PB intentionally uses
 * the numeric Telegram user ID: usernames can be absent or changed.
 *
 * input: { chatType, text, caption, entities, captionEntities,
 *          replyTo: { senderId, isBot }, botUsername, botId,
 *          freeChatEnabled, allowPrivateConversation }
 */
export function routeTelegramConversation(input) {
  const mentions = [
    ...entityMentions(input.text, input.entities),
    ...entityMentions(input.caption, input.captionEntities),
  ];
  const pbHandle = `@${input.botUsername}`.toLowerCase();
  const hasPbMention = mentions.some((m) => m.handle?.toLowerCase() === pbHandle);
  const isReplyToPb = input.botId !== undefined && input.replyTo?.senderId === input.botId;
  const isDirectPbAddress = hasPbMention || isReplyToPb || isPbNameInvocation(input.text) || isPbNameInvocation(input.caption);

  const hasHumanMention = mentions.some(
    (m) => m.isNamedUser || (m.handle !== undefined && m.handle.toLowerCase() !== pbHandle),
  );
  const isReplyToHuman = input.replyTo?.isBot === false;
  const isDirectedAtHuman = hasHumanMention || isReplyToHuman;
  const isPrivate = input.chatType === 'private';
  const privateConversationAllowed = isPrivate && input.allowPrivateConversation === true;

  return {
    isDirectPbAddress,
    isDirectedAtHuman,
    shouldHandleConversation: privateConversationAllowed || isDirectPbAddress ||
      (!!input.freeChatEnabled && !isDirectedAtHuman),
    // Gate for an already-matched casual pattern (gm, wagmi, etc.),
    // not a trigger on its own.
    shouldHandleBroadCasualReply: isPrivate
      ? privateConversationAllowed
      : isDirectPbAddress || !isDirectedAtHuman,
  };
}
