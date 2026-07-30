import { describe, expect, it } from 'vitest';

import { hasValidOperatorToken } from './operator-auth.js';

describe('operator authentication', () => {
  const token = 'sentinel-operator-token-with-32-chars';

  it('accepts the exact bearer token', () => {
    expect(hasValidOperatorToken(`Bearer ${token}`, token)).toBe(true);
  });

  it('rejects missing, malformed, and incorrect credentials', () => {
    expect(hasValidOperatorToken(undefined, token)).toBe(false);
    expect(hasValidOperatorToken(token, token)).toBe(false);
    expect(hasValidOperatorToken('Basic sentinel', token)).toBe(false);
    expect(hasValidOperatorToken('Bearer incorrect', token)).toBe(false);
    expect(hasValidOperatorToken(`Bearer ${token}x`, token)).toBe(false);
  });
});
