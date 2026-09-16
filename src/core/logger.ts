import pino from 'pino';

/**
 * Redaction paths for anything that looks like a secret. This is deliberately broad
 * (matches by key name, wherever it appears in a logged object) rather than requiring
 * every call site to remember to redact — see docs/THREAT_MODEL.md #2 ("leaked bot
 * key"): a logger that silently prints a config object containing a token is exactly
 * the kind of leak that shouldn't depend on every future call site getting it right.
 */
const REDACTED_KEY_PATTERN = /(key|token|secret|password|mnemonic|privatekey)$/i;

/** Deep-redacts any object key matching REDACTED_KEY_PATTERN before logging. Pino's
 * built-in `redact` option needs static paths; our shape isn't static (arbitrary
 * config/context objects), so we redact in a `formatters.log` hook instead, which runs
 * on every log line's merging object. */
function redactObject(obj: unknown, seen = new WeakSet<object>()): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = REDACTED_KEY_PATTERN.test(key) ? '[REDACTED]' : redactObject(value, seen);
  }
  return result;
}

export interface LoggerOptions {
  level?: pino.LevelWithSilent;
  name?: string;
}

/** `destination` defaults to stdout; tests pass a capture stream instead so redaction
 * behavior can be asserted without parsing process stdout. */
export function createLogger(
  options: LoggerOptions = {},
  destination?: pino.DestinationStream,
): pino.Logger {
  const pinoOptions: pino.LoggerOptions = {
    name: options.name ?? 'sentinel',
    level: options.level ?? (process.env['LOG_LEVEL'] as pino.LevelWithSilent) ?? 'info',
    formatters: {
      log(obj) {
        return redactObject(obj) as Record<string, unknown>;
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}

export type Logger = pino.Logger;
