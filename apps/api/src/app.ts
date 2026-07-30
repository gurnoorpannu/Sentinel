import Fastify, { type FastifyInstance } from 'fastify';

export interface DatabaseProbe {
  query(text: string): Promise<unknown>;
}

interface BuildAppOptions {
  database: DatabaseProbe;
  logger?: boolean | { level: string };
}

export function buildApp({ database, logger = true }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/', async () => ({
    name: 'Sentinel API',
    phase: 1,
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

  return app;
}
