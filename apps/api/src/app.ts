import Fastify, { type FastifyInstance } from 'fastify';

import { ApiMetrics } from './metrics.js';
import { registerWorkflowRoutes, type WorkflowStore } from './workflow-routes.js';

export interface DatabaseProbe {
  query(text: string): Promise<unknown>;
}

interface BuildAppOptions {
  database: DatabaseProbe;
  workflows: WorkflowStore;
  logger?: boolean | { level: string };
  chaosEnabled?: boolean;
  isShuttingDown?: () => boolean;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  metricsToken?: string | undefined;
  operatorToken?: string | undefined;
}

const readinessQuery = `
  SELECT
    to_regclass('public.schema_migrations') IS NOT NULL
    AND to_regclass('public.workflows') IS NOT NULL
    AND to_regclass('public.tasks') IS NOT NULL
    AND to_regclass('public.workflow_events') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM schema_migrations
      WHERE name = '007_worker_capacity.sql'
    ) AS schema_ready
`;

export function buildApp({
  database,
  workflows,
  logger = true,
  chaosEnabled = false,
  isShuttingDown = () => false,
  requestTimeoutMs = 30_000,
  keepAliveTimeoutMs = 72_000,
  metricsToken,
  operatorToken,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    requestTimeout: requestTimeoutMs,
    keepAliveTimeout: keepAliveTimeoutMs,
  });
  const metrics = new ApiMetrics();

  app.addHook('onResponse', (request, reply, done) => {
    if (request.routeOptions.url !== '/metrics') {
      metrics.recordRequest(
        request.method,
        request.routeOptions.url ?? 'unknown',
        reply.statusCode,
        reply.elapsedTime,
      );
    }
    done();
  });

  app.get('/', async () => ({
    name: 'Sentinel API',
    phase: 11,
    status: 'running',
  }));

  app.get('/health', async (_request, reply) => {
    try {
      await database.query('SELECT 1');
      return {
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      app.log.error(error, 'Database health check failed');
      return reply.status(503).send({
        status: 'unavailable',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/live', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    if (isShuttingDown()) {
      return reply.status(503).send({
        status: 'unavailable',
        database: 'unknown',
        schema: 'unknown',
        reason: 'shutting_down',
        timestamp: new Date().toISOString(),
      });
    }

    try {
      const result = await database.query(readinessQuery);
      if (!hasReadySchema(result)) {
        return reply.status(503).send({
          status: 'unavailable',
          database: 'connected',
          schema: 'outdated',
          timestamp: new Date().toISOString(),
        });
      }
      return {
        status: 'ready',
        database: 'connected',
        schema: 'current',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      app.log.error(error, 'Readiness check failed');
      return reply.status(503).send({
        status: 'unavailable',
        database: 'disconnected',
        schema: 'unknown',
        timestamp: new Date().toISOString(),
      });
    }
  });

  if (metricsToken) {
    app.get('/metrics', async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${metricsToken}`) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'A valid metrics bearer token is required',
          },
        });
      }

      const body = await metrics.render(database);
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
    });
  }

  registerWorkflowRoutes(app, workflows, { chaosEnabled, operatorToken });

  return app;
}

function hasReadySchema(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return false;
  }
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }
  const row = rows[0];
  return (
    typeof row === 'object' && row !== null && 'schema_ready' in row && row.schema_ready === true
  );
}
