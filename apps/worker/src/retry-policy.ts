export class RetryableTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableTaskError';
  }
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  random?: () => number;
}

export function calculateBackoff(
  attemptCount: number,
  { baseDelayMs, maxDelayMs, jitterRatio, random = Math.random }: RetryPolicy,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attemptCount - 1));
  const jitter = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.min(maxDelayMs, Math.round(exponential * jitter)));
}
