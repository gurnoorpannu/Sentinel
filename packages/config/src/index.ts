import 'dotenv/config';
import { z } from 'zod';

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z
      .string()
      .url()
      .default('postgresql://sentinel:sentinel@localhost:5432/sentinel'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
    API_KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(72_000),
    SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().min(1_000).default(30_000),
    WORKER_ID: z.string().min(1).default('worker-local'),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    LEASE_DURATION_MS: z.coerce.number().int().min(100).default(30_000),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(50).default(10_000),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).default(1_000),
    RETRY_MAX_DELAY_MS: z.coerce.number().int().min(100).default(30_000),
    RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.2),
    CHAOS_MODE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((environment, context) => {
    if (environment.HEARTBEAT_INTERVAL_MS >= environment.LEASE_DURATION_MS) {
      context.addIssue({
        code: 'custom',
        message: 'HEARTBEAT_INTERVAL_MS must be shorter than LEASE_DURATION_MS',
        path: ['HEARTBEAT_INTERVAL_MS'],
      });
    }
    if (environment.RETRY_BASE_DELAY_MS > environment.RETRY_MAX_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        message: 'RETRY_BASE_DELAY_MS must not exceed RETRY_MAX_DELAY_MS',
        path: ['RETRY_BASE_DELAY_MS'],
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}
