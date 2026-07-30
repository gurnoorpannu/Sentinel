import Fastify, { type FastifyInstance } from 'fastify';

import { registerWorkflowRoutes, type WorkflowStore } from './workflow-routes.js';

export interface DatabaseProbe {
  query(text: string): Promise<unknown>;
}

interface BuildAppOptions {
  database: DatabaseProbe;
  workflows: WorkflowStore;
  logger?: boolean | { level: string };
}

export function buildApp({ database, workflows, logger = true }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/', async () => ({
    name: 'Sentinel API',
    phase: 3,
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

  registerWorkflowRoutes(app, workflows);

  return app;
}
