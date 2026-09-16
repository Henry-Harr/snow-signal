import { describe, expect, it, vi } from 'vitest';

import { TelegramNotifier } from '../../../src/notify/telegram.js';
import { testAlert } from './helpers.js';

function mockFetch(ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok }) });
}

describe('TelegramNotifier', () => {
  it('sends one message per allowlisted chat id', async () => {
    const fetchImpl = mockFetch();
    const notifier = new TelegramNotifier({ botToken: 'tok', chatIds: ['111', '222'], fetchImpl });
    await notifier.send(testAlert());

    const mock = fetchImpl as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0]![0]).toBe('https://api.telegram.org/bottok/sendMessage');
    const body = JSON.parse((mock.mock.calls[0]![1] as RequestInit).body as string) as {
      chat_id: string;
      text: string;
    };
    expect(body.chat_id).toBe('111');
    expect(body.text).toContain('DANGER');
  });

  it('logs an error per chat when the API reports failure, without throwing', async () => {
    const error = vi.fn();
    const fetchImpl = mockFetch(false);
    const notifier = new TelegramNotifier({
      botToken: 'tok',
      chatIds: ['111'],
      fetchImpl,
      logger: { error } as never,
    });
    await expect(notifier.send(testAlert())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when no chat ids are configured', async () => {
    const fetchImpl = mockFetch();
    const notifier = new TelegramNotifier({ botToken: 'tok', chatIds: [], fetchImpl });
    await notifier.send(testAlert());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
