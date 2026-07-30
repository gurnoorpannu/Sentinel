import type { Pool } from 'pg';

export interface ReportWorkerPresenceInput {
  workerId: string;
  concurrency: number;
  inFlight: number;
  stopping: boolean;
  startedAt: Date;
}

export class WorkerPresenceRepository {
  constructor(private readonly pool: Pool) {}

  async report(input: ReportWorkerPresenceInput): Promise<void> {
    validatePresence(input);
    await this.pool.query(
      `
        INSERT INTO worker_heartbeats (
          worker_id, concurrency, in_flight, stopping, started_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (worker_id)
        DO UPDATE SET
          concurrency = EXCLUDED.concurrency,
          in_flight = EXCLUDED.in_flight,
          stopping = EXCLUDED.stopping,
          started_at = EXCLUDED.started_at,
          updated_at = now()
      `,
      [input.workerId, input.concurrency, input.inFlight, input.stopping, input.startedAt],
    );
  }
}

function validatePresence(input: ReportWorkerPresenceInput): void {
  if (input.workerId.trim().length === 0 || input.workerId.length > 200) {
    throw new RangeError('workerId must contain 1 to 200 characters');
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 64) {
    throw new RangeError('concurrency must be an integer between 1 and 64');
  }
  if (
    !Number.isInteger(input.inFlight) ||
    input.inFlight < 0 ||
    input.inFlight > input.concurrency
  ) {
    throw new RangeError('inFlight must be an integer between 0 and concurrency');
  }
  if (Number.isNaN(input.startedAt.getTime())) {
    throw new RangeError('startedAt must be a valid date');
  }
}
