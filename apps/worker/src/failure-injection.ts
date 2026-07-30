import { setTimeout as delay } from 'node:timers/promises';

import type { JsonObject, JsonValue, Task } from '@sentinel/contracts';

import { RetryableTaskError } from './retry-policy.js';

export const failureInjectionModes = [
  'retryable',
  'permanent',
  'hang',
  'crash_before_effect',
  'crash_after_effect',
] as const;

export type FailureInjectionMode = (typeof failureInjectionModes)[number];

export interface FailureInjectionPlan {
  mode: FailureInjectionMode;
  attempts: number;
  delayMs: number;
}

export class InjectedWorkerCrashError extends Error {
  constructor(
    public readonly mode: 'crash_before_effect' | 'crash_after_effect',
    public readonly taskId: string,
  ) {
    super(`Injected worker crash for task ${taskId} (${mode})`);
    this.name = 'InjectedWorkerCrashError';
  }
}

export class InvalidFailureInjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFailureInjectionError';
  }
}

export function readFailureInjection(task: Task): FailureInjectionPlan | null {
  const value = task.payload.sentinelFailure;
  if (value === undefined) {
    return null;
  }
  if (!isJsonObject(value)) {
    throw new InvalidFailureInjectionError('sentinelFailure must be an object');
  }

  const mode = value.mode;
  if (typeof mode !== 'string' || !failureInjectionModes.includes(mode as FailureInjectionMode)) {
    throw new InvalidFailureInjectionError(
      `sentinelFailure.mode must be one of: ${failureInjectionModes.join(', ')}`,
    );
  }

  const attempts = value.attempts ?? 1;
  if (
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 100
  ) {
    throw new InvalidFailureInjectionError(
      'sentinelFailure.attempts must be an integer between 1 and 100',
    );
  }

  const delayMs = value.delayMs ?? 0;
  if (
    typeof delayMs !== 'number' ||
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 300_000
  ) {
    throw new InvalidFailureInjectionError(
      'sentinelFailure.delayMs must be an integer between 0 and 300000',
    );
  }

  return {
    mode: mode as FailureInjectionMode,
    attempts,
    delayMs,
  };
}

export function disablesHeartbeat(plan: FailureInjectionPlan | null): boolean {
  return plan?.mode === 'hang';
}

export async function executeWithFailureInjection(
  task: Task,
  execute: (task: Task) => Promise<JsonValue>,
  sleep: (durationMs: number) => Promise<unknown> = async (durationMs) => await delay(durationMs),
): Promise<JsonValue> {
  const plan = readFailureInjection(task);
  if (!plan || task.attemptCount > plan.attempts) {
    return await execute(task);
  }

  if (plan.delayMs > 0) {
    await sleep(plan.delayMs);
  }

  switch (plan.mode) {
    case 'retryable':
      throw new RetryableTaskError(`Injected retryable failure on attempt ${task.attemptCount}`);
    case 'permanent':
      throw new Error(`Injected permanent failure on attempt ${task.attemptCount}`);
    case 'hang':
      return await execute(task);
    case 'crash_before_effect':
      throw new InjectedWorkerCrashError(plan.mode, task.id);
    case 'crash_after_effect': {
      await execute(task);
      throw new InjectedWorkerCrashError(plan.mode, task.id);
    }
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
