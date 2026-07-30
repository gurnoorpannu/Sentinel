import { describe, expect, it } from 'vitest';

import { loadEnvironment } from './index.js';

describe('worker lease configuration', () => {
  it('uses a heartbeat shorter than the default lease', () => {
    const environment = loadEnvironment({});

    expect(environment.LEASE_DURATION_MS).toBe(30_000);
    expect(environment.HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(environment.SHUTDOWN_GRACE_PERIOD_MS).toBe(30_000);
    expect(environment.WORKER_CONCURRENCY).toBe(4);
    expect(environment.WORKER_HEARTBEAT_INTERVAL_MS).toBe(5_000);
    expect(environment.DATABASE_POOL_MAX).toBe(10);
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

  it('reserves database connections beyond worker execution slots', () => {
    expect(() =>
      loadEnvironment({
        WORKER_CONCURRENCY: '8',
        DATABASE_POOL_MAX: '9',
      }),
    ).toThrow();
    expect(
      loadEnvironment({
        WORKER_CONCURRENCY: '8',
        DATABASE_POOL_MAX: '12',
      }).WORKER_CONCURRENCY,
    ).toBe(8);
  });

  it('rejects short metrics tokens', () => {
    expect(() => loadEnvironment({ METRICS_TOKEN: 'too-short' })).toThrow();
    expect(loadEnvironment({ METRICS_TOKEN: 'long-enough-token' }).METRICS_TOKEN).toBe(
      'long-enough-token',
    );
  });

  it('requires a strong operator token when operator controls are enabled', () => {
    expect(() => loadEnvironment({ OPERATOR_TOKEN: 'too-short' })).toThrow();
    expect(
      loadEnvironment({ OPERATOR_TOKEN: 'sentinel-operator-token-with-32-chars' }).OPERATOR_TOKEN,
    ).toBe('sentinel-operator-token-with-32-chars');
  });
});
