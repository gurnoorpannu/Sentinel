import { describe, expect, it, vi } from 'vitest';

import { maintainWorkerPresence } from './worker-presence.js';

describe('worker presence heartbeat', () => {
  it('reports immediately and records a final draining snapshot', async () => {
    const controller = new AbortController();
    const repository = { report: vi.fn().mockResolvedValue(undefined) };
    let inFlight = 2;

    await maintainWorkerPresence({
      repository,
      intervalMs: 5_000,
      signal: controller.signal,
      snapshot: () => ({
        workerId: 'worker-a',
        concurrency: 4,
        inFlight,
        startedAt: new Date('2026-07-30T00:00:00.000Z'),
      }),
      wait: async () => {
        inFlight = 1;
        controller.abort();
      },
    });

    expect(repository.report).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inFlight: 2, stopping: false }),
    );
    expect(repository.report).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inFlight: 1, stopping: true }),
    );
  });

  it('keeps heartbeat failures observable without crashing task execution', async () => {
    const controller = new AbortController();
    const error = new Error('database busy');
    const repository = {
      report: vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined),
    };
    const onError = vi.fn();

    await maintainWorkerPresence({
      repository,
      intervalMs: 5_000,
      signal: controller.signal,
      snapshot: () => ({
        workerId: 'worker-a',
        concurrency: 4,
        inFlight: 0,
        startedAt: new Date('2026-07-30T00:00:00.000Z'),
      }),
      onError,
      wait: async () => controller.abort(),
    });

    expect(onError).toHaveBeenCalledWith(error);
    expect(repository.report).toHaveBeenCalledTimes(2);
  });
});
