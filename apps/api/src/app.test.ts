import { describe, expect, it, vi } from 'vitest';

import { buildApp } from './app.js';

describe('API health endpoint', () => {
  it('reports a healthy database connection', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const app = buildApp({ database, logger: false });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: 'connected',
    });
    expect(database.query).toHaveBeenCalledWith('SELECT 1');
    await app.close();
  });

  it('returns 503 when PostgreSQL cannot be reached', async () => {
    const database = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const app = buildApp({ database, logger: false });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      database: 'disconnected',
    });
    await app.close();
  });
});
