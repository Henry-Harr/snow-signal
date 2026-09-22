import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(): Logger {
  return pino({ name: 'stoploss-bot' });
}
