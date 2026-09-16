import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../../src/core/logger.js';

function captureStream(): { lines: Record<string, unknown>[]; stream: Writable } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger redaction', () => {
  it('redacts keys that look like secrets, anywhere in the logged object', () => {
    const { lines, stream } = captureStream();
    const logger = createLogger({}, stream);

    logger.info({ apiKey: 'super-secret', nested: { token: 'abc', ok: 'fine' } }, 'hello');

    expect(lines).toHaveLength(1);
    const line = lines[0] as unknown as {
      apiKey: string;
      nested: { token: string; ok: string };
    };
    expect(line.apiKey).toBe('[REDACTED]');
    expect(line.nested.token).toBe('[REDACTED]');
    expect(line.nested.ok).toBe('fine');
  });

  it('leaves non-secret-looking keys untouched', () => {
    const { lines, stream } = captureStream();
    const logger = createLogger({}, stream);

    logger.info({ chainId: 1, blockNumber: '123' }, 'block processed');

    expect(lines[0]).toMatchObject({ chainId: 1, blockNumber: '123' });
  });
});
