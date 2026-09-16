import { describe, expect, it, vi } from 'vitest';

import { ConsoleNotifier } from '../../../src/notify/console.js';
import { testAlert } from './helpers.js';

describe('ConsoleNotifier', () => {
  it('writes the formatted alert via the injected logger when given one', async () => {
    const warn = vi.fn();
    const notifier = new ConsoleNotifier({ logger: { warn } as never });
    await notifier.send(testAlert());
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload] = warn.mock.calls[0] as [{ alert: string }];
    expect(payload.alert).toContain('DANGER');
  });

  it('falls back to console.log without a logger', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const notifier = new ConsoleNotifier();
    await notifier.send(testAlert());
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });
});
