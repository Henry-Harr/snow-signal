import { describe, expect, it, vi } from 'vitest';

import { DiscordNotifier } from '../../../src/notify/discord.js';
import { testAlert } from './helpers.js';

function mockFetch(response: Partial<Response> = { ok: true }): typeof fetch {
  return vi.fn().mockResolvedValue(response);
}

describe('DiscordNotifier', () => {
  it('POSTs a JSON content payload to the webhook URL', async () => {
    const fetchImpl = mockFetch();
    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      fetchImpl,
    });
    await notifier.send(testAlert());

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://discord.example/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('DANGER');
  });

  it('truncates content past the 2000-character Discord limit rather than erroring', async () => {
    const fetchImpl = mockFetch();
    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      fetchImpl,
    });
    const manySignals = Array.from({ length: 100 }, (_, i) => ({
      detectorId: `D0${i}_test`,
      family: 'pool_flow' as const,
      subject: { kind: 'market' as const, id: 'm' },
      severity: 'watch' as const,
      value: 1,
      threshold: 1,
      evidence: {},
    }));
    await notifier.send(testAlert({ signals: manySignals }));

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content.length).toBeLessThanOrEqual(2000);
  });

  it('logs an error when the webhook request fails, without throwing', async () => {
    const error = vi.fn();
    const fetchImpl = mockFetch({ ok: false, status: 500 });
    const notifier = new DiscordNotifier({
      webhookUrl: 'https://discord.example/webhook',
      fetchImpl,
      logger: { error } as never,
    });
    await expect(notifier.send(testAlert())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
