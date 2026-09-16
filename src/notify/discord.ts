import { formatAlertText } from './format.js';
import type { Alert, Notifier } from './types.js';
import type { Logger } from '../core/logger.js';

/** Discord webhook notifier (docs/SPEC.md #10.1). Discord webhooks accept a plain
 * `{content: string}` POST — no auth beyond the webhook URL itself being secret
 * (never logged, never put in config directly; the URL comes from an env var per
 * `notify.discordWebhookEnv`, safety rule 1). Discord's own 2000-character message
 * cap is respected by truncating rather than erroring — a truncated-but-delivered
 * alert beats a dropped one. */
const DISCORD_MESSAGE_LIMIT = 2000;

export interface DiscordNotifierOptions {
  webhookUrl: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class DiscordNotifier implements Notifier {
  readonly id = 'discord';
  private readonly webhookUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: DiscordNotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  async send(alert: Alert): Promise<void> {
    let content = '```\n' + formatAlertText(alert) + '\n```';
    if (content.length > DISCORD_MESSAGE_LIMIT) {
      content = content.slice(0, DISCORD_MESSAGE_LIMIT - 4) + '…```';
    }

    const response = await this.fetchImpl(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      this.logger?.error(
        { status: response.status, positionId: alert.positionId },
        'Discord webhook send failed',
      );
    }
  }
}
