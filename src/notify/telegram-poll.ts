import {
  handleTelegramCommand,
  isAllowedChatId,
  parseTelegramCommand,
  type TelegramCommandDeps,
} from './telegram-commands.js';
import type { Logger } from '../core/logger.js';

/**
 * Telegram `getUpdates` long-polling (docs/SPEC.md #10.1's Telegram commands need
 * something to actually receive incoming messages with — `telegram.ts` only sends).
 * Endpoint shape verified alongside `sendMessage` this session (2026-09-16,
 * `core.telegram.org/bots/api#sendmessage`) — `GET/POST
 * https://api.telegram.org/bot<token>/getUpdates` with `offset`/`limit`/`timeout`,
 * `{ok: boolean, result: Update[]}` where each `Update` has `update_id` and
 * (for a text message) `message: {chat: {id}, text}`.
 */
const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

export interface TelegramPollOptions {
  botToken: string;
  allowedChatIds: string[];
  commandDeps: TelegramCommandDeps;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Long-poll timeout in seconds passed to `getUpdates` — how long Telegram holds
   * the request open waiting for a new message before returning empty. */
  timeoutSeconds?: number;
}

/** One `getUpdates` round trip: fetches new messages since `offset`, handles every
 * command from an allowlisted chat, replies, and returns the offset to pass next
 * time (`undefined` means "no updates, reuse the same offset"). Exported as a single
 * iteration — matching `LiveBlockSource.poll()`'s shape — so it's directly testable
 * with an injected `fetchImpl` instead of needing to run the real long-poll loop. */
export async function pollTelegramUpdatesOnce(
  options: TelegramPollOptions,
  offset: number | undefined,
): Promise<number | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const params = new URLSearchParams({ timeout: String(options.timeoutSeconds ?? 30) });
  if (offset !== undefined) params.set('offset', String(offset));

  const response = await fetchImpl(
    `${TELEGRAM_API_BASE}/bot${options.botToken}/getUpdates?${params.toString()}`,
  );
  const body = (await response.json()) as GetUpdatesResponse;
  if (!body.ok || !body.result || body.result.length === 0) return offset;

  let nextOffset = offset;
  for (const update of body.result) {
    nextOffset = update.update_id + 1;
    const message = update.message;
    if (!message?.text) continue;

    const chatId = String(message.chat.id);
    if (!isAllowedChatId(chatId, options.allowedChatIds)) {
      options.logger?.warn({ chatId }, 'Telegram command from a non-allowlisted chat, ignored');
      continue;
    }

    const command = parseTelegramCommand(message.text);
    const responseText = handleTelegramCommand(command, options.commandDeps);
    await fetchImpl(`${TELEGRAM_API_BASE}/bot${options.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: responseText }),
    });
  }

  return nextOffset;
}
