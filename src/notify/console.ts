import { formatAlertText } from './format.js';
import type { Alert, Notifier } from './types.js';
import type { Logger } from '../core/logger.js';

/** Console notifier (docs/SPEC.md #10.1) — always available, no config/secrets
 * needed. Primarily for local development and as the fallback that always works
 * even if Telegram/Discord are misconfigured or unreachable. */
export class ConsoleNotifier implements Notifier {
  readonly id = 'console';
  private readonly logger: Logger | undefined;

  constructor(options: { logger?: Logger } = {}) {
    this.logger = options.logger;
  }

  send(alert: Alert): Promise<void> {
    const text = formatAlertText(alert);
    if (this.logger) {
      this.logger.warn({ alert: text }, 'alert');
    } else {
      console.log(text);
    }
    return Promise.resolve();
  }
}
