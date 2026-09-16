/** Jittered exponential backoff for RPC retries (docs/SPEC.md #6.1). Pulled out as a
 * standalone, injectable-sleep function so retry behavior is unit-testable without
 * real timers. */
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.maxAttempts) break;
      const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      const jittered = exponential * (0.5 + random() * 0.5);
      await sleep(jittered);
    }
  }
  throw lastError;
}
