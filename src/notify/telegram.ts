import { formatAlertText } from './format.js';
import type { Alert, Notifier } from './types.js';
import type { Logger } from '../core/logger.js';

/**
 * Telegram Bot API notifier (docs/SPEC.md #10.1, primary notifier). Endpoint shape
 * verified directly against the official docs this session (2026-09-16,
 * `core.telegram.org/bots/api#sendmessage`): `POST
 * https://api.telegram.org/bot<token>/sendMessage` with `chat_id`/`text` (plus
 * `parse_mode`), responding `{ok: boolean, result?, description?, error_code?}`.
 * `getUpdates` (the long-poll endpoint `src/notify/telegram-poll.ts` uses) is the
 * same base URL/response shape with `offset`/`limit`/`timeout`.
 */
const TELEGRAM_API_BASE = 'https://api.telegram.org';

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
}

export interface TelegramNotifierOptions {
  botToken: string;
  chatIds: string[];
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class TelegramNotifier implements Notifier {
  readonly id = 'telegram';
  private readonly botToken: string;
  private readonly chatIds: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: TelegramNotifierOptions) {
    this.botToken = options.botToken;
    this.chatIds = options.chatIds;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async send(alert: Alert): Promise<void> {
    const text = formatAlertText(alert);
    await Promise.all(this.chatIds.map((chatId) => this.sendToChat(chatId, text)));
  }

  private async sendToChat(chatId: string, text: string): Promise<void> {
    const response = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = (await response.json()) as TelegramApiResponse;
    if (!body.ok) {
      this.logger?.error(
        { chatId, description: body.description, errorCode: body.error_code },
        'Telegram sendMessage failed',
      );
    }
  }
}
