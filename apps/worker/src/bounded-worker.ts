import { setTimeout as delay } from 'node:timers/promises';

import type { Task } from '@sentinel/contracts';
import type { WorkflowRepository } from '@sentinel/database';

import type { LeaseExecutionOutcome } from './lease-executor.js';

type ClaimStore = Pick<WorkflowRepository, 'claimTask'>;

interface RunBoundedWorkerOptions {
  repository: ClaimStore;
  workerId: string;
  concurrency: number;
  leaseDurationMs: number;
  pollIntervalMs: number;
  shouldStop: () => boolean;
  requestStop: (outcome: 'abandoned' | 'fatal') => void;
  execute: (task: Task) => Promise<LeaseExecutionOutcome>;
  onClaim?: (task: Task, inFlight: number) => void;
  onOutcome?: (task: Task, outcome: LeaseExecutionOutcome, inFlight: number) => void;
  onError?: (task: Task, error: unknown) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runBoundedWorker({
  repository,
  workerId,
  concurrency,
  leaseDurationMs,
  pollIntervalMs,
  shouldStop,
  requestStop,
  execute,
  onClaim,
  onOutcome,
  onError,
  wait = async (milliseconds) => await delay(milliseconds),
}: RunBoundedWorkerOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  let fatalError: unknown;

  while (!shouldStop()) {
    let queueWasEmpty = false;

    while (!shouldStop() && inFlight.size < concurrency) {
      const task = await repository.claimTask({ workerId, leaseDurationMs });
      if (!task) {
        queueWasEmpty = true;
        break;
      }

      const execution = execute(task)
        .then((outcome) => {
          onOutcome?.(task, outcome, inFlight.size - 1);
          if (outcome === 'abandoned') {
            requestStop('abandoned');
          }
        })
        .catch((error: unknown) => {
          fatalError ??= error;
          onError?.(task, error);
          requestStop('fatal');
        });
      inFlight.add(execution);
      void execution.then(() => {
        inFlight.delete(execution);
      });
      onClaim?.(task, inFlight.size);
    }

    if (shouldStop()) {
      break;
    }
    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    } else if (inFlight.size > 0 && queueWasEmpty) {
      await Promise.race([Promise.race(inFlight), wait(pollIntervalMs)]);
    } else if (inFlight.size === 0) {
      await wait(pollIntervalMs);
    }
  }

  await Promise.allSettled(inFlight);
  if (fatalError !== undefined) {
    throw fatalError;
  }
}
