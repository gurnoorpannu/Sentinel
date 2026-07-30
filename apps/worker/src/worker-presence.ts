import { setTimeout as delay } from 'node:timers/promises';

import type { ReportWorkerPresenceInput, WorkerPresenceRepository } from '@sentinel/database';

type PresenceStore = Pick<WorkerPresenceRepository, 'report'>;

interface MaintainWorkerPresenceOptions {
  repository: PresenceStore;
  intervalMs: number;
  signal: AbortSignal;
  snapshot: () => Omit<ReportWorkerPresenceInput, 'stopping'>;
  onError?: (error: unknown) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export async function maintainWorkerPresence({
  repository,
  intervalMs,
  signal,
  snapshot,
  onError,
  wait = async (milliseconds, waitSignal) => {
    await delay(milliseconds, undefined, { signal: waitSignal });
  },
}: MaintainWorkerPresenceOptions): Promise<void> {
  while (!signal.aborted) {
    await report(false);
    try {
      await wait(intervalMs, signal);
    } catch (error) {
      if (!signal.aborted) {
        onError?.(error);
      }
    }
  }
  await report(true);

  async function report(stopping: boolean): Promise<void> {
    try {
      await repository.report({ ...snapshot(), stopping });
    } catch (error) {
      onError?.(error);
    }
  }
}
