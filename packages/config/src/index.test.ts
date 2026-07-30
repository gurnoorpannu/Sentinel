import { describe, expect, it } from 'vitest';

import { loadEnvironment } from './index.js';

describe('worker lease configuration', () => {
  it('uses a heartbeat shorter than the default lease', () => {
    const environment = loadEnvironment({});

    expect(environment.LEASE_DURATION_MS).toBe(30_000);
    expect(environment.HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  it('rejects a heartbeat interval that can outlive the lease', () => {
    expect(() =>
      loadEnvironment({
        LEASE_DURATION_MS: '1000',
        HEARTBEAT_INTERVAL_MS: '1000',
      }),
    ).toThrow();
  });

  it('keeps chaos endpoints disabled unless explicitly enabled', () => {
    expect(loadEnvironment({}).CHAOS_MODE_ENABLED).toBe(false);
    expect(loadEnvironment({ CHAOS_MODE_ENABLED: 'true' }).CHAOS_MODE_ENABLED).toBe(true);
  });
});
