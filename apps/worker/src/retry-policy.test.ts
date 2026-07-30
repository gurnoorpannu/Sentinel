import { describe, expect, it } from 'vitest';

import { calculateBackoff } from './retry-policy.js';

describe('exponential retry backoff', () => {
  it('doubles delay by attempt and caps it', () => {
    const policy = {
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      jitterRatio: 0,
    };

    expect(calculateBackoff(1, policy)).toBe(1_000);
    expect(calculateBackoff(2, policy)).toBe(2_000);
    expect(calculateBackoff(3, policy)).toBe(4_000);
    expect(calculateBackoff(4, policy)).toBe(8_000);
    expect(calculateBackoff(10, policy)).toBe(8_000);
  });

  it('applies bounded jitter', () => {
    const policy = {
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.2,
    };

    expect(calculateBackoff(1, { ...policy, random: () => 0 })).toBe(800);
    expect(calculateBackoff(1, { ...policy, random: () => 1 })).toBe(1_200);
  });
});
