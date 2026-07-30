import type { DatabaseProbe } from './app.js';

interface RequestMetric {
  method: string;
  route: string;
  status: number;
  count: number;
  durationSeconds: number;
}

const operationalMetricsQuery = `
  SELECT
    (SELECT count(*) FROM workflows) AS workflows_total,
    (SELECT count(*) FROM workflows WHERE status = 'pending') AS workflows_pending,
    (SELECT count(*) FROM workflows WHERE status = 'running') AS workflows_running,
    (SELECT count(*) FROM workflows WHERE status = 'compensating') AS workflows_compensating,
    (SELECT count(*) FROM workflows WHERE status = 'completed') AS workflows_completed,
    (SELECT count(*) FROM workflows WHERE status = 'failed') AS workflows_failed,
    (SELECT count(*) FROM workflows WHERE status = 'compensated') AS workflows_compensated,
    (SELECT count(*) FROM workflows WHERE status = 'compensation_failed')
      AS workflows_compensation_failed,
    (SELECT count(*) FROM tasks WHERE status = 'ready') AS tasks_ready,
    (SELECT count(*) FROM tasks WHERE status = 'leased') AS tasks_leased,
    (SELECT count(*) FROM tasks WHERE status = 'retry_scheduled') AS tasks_retry_scheduled,
    (SELECT count(*) FROM tasks WHERE status = 'compensating') AS tasks_compensating,
    (SELECT count(*) FROM tasks WHERE status = 'leased' AND lease_expires_at <= now())
      AS tasks_expired_leases,
    (SELECT count(*) FROM workflow_events) AS workflow_events_total,
    (SELECT count(*) FROM idempotency_records) AS idempotency_records_total
`;

const workflowStatuses = [
  'pending',
  'running',
  'compensating',
  'completed',
  'failed',
  'compensated',
  'compensation_failed',
] as const;

export class ApiMetrics {
  private readonly requests = new Map<string, RequestMetric>();

  recordRequest(method: string, route: string, status: number, durationMs: number): void {
    const key = `${method}\u0000${route}\u0000${status}`;
    const current = this.requests.get(key) ?? {
      method,
      route,
      status,
      count: 0,
      durationSeconds: 0,
    };
    current.count += 1;
    current.durationSeconds += durationMs / 1000;
    this.requests.set(key, current);
  }

  async render(database: DatabaseProbe): Promise<string> {
    const result = await database.query(operationalMetricsQuery);
    const row = firstRow(result);
    const lines = [
      '# HELP sentinel_api_requests_total Total HTTP requests handled by the Sentinel API.',
      '# TYPE sentinel_api_requests_total counter',
    ];

    for (const metric of [...this.requests.values()].sort(compareRequestMetrics)) {
      const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${metric.status}"`;
      lines.push(`sentinel_api_requests_total{${labels}} ${metric.count}`);
    }

    lines.push(
      '# HELP sentinel_api_request_duration_seconds_sum Cumulative API request duration.',
      '# TYPE sentinel_api_request_duration_seconds_sum counter',
    );
    for (const metric of [...this.requests.values()].sort(compareRequestMetrics)) {
      const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${metric.status}"`;
      lines.push(
        `sentinel_api_request_duration_seconds_sum{${labels}} ${metric.durationSeconds.toFixed(6)}`,
      );
    }

    lines.push(
      '# HELP sentinel_workflows Current workflows by durable status.',
      '# TYPE sentinel_workflows gauge',
    );
    for (const status of workflowStatuses) {
      lines.push(`sentinel_workflows{status="${status}"} ${numeric(row, `workflows_${status}`)}`);
    }

    lines.push(
      '# HELP sentinel_tasks Current operational tasks by queue state.',
      '# TYPE sentinel_tasks gauge',
      `sentinel_tasks{status="ready"} ${numeric(row, 'tasks_ready')}`,
      `sentinel_tasks{status="leased"} ${numeric(row, 'tasks_leased')}`,
      `sentinel_tasks{status="retry_scheduled"} ${numeric(row, 'tasks_retry_scheduled')}`,
      `sentinel_tasks{status="compensating"} ${numeric(row, 'tasks_compensating')}`,
      '# HELP sentinel_expired_leases Tasks whose worker lease has expired.',
      '# TYPE sentinel_expired_leases gauge',
      `sentinel_expired_leases ${numeric(row, 'tasks_expired_leases')}`,
      '# HELP sentinel_workflow_events_total Durable workflow events stored.',
      '# TYPE sentinel_workflow_events_total gauge',
      `sentinel_workflow_events_total ${numeric(row, 'workflow_events_total')}`,
      '# HELP sentinel_idempotency_records_total Durable external-effect records stored.',
      '# TYPE sentinel_idempotency_records_total gauge',
      `sentinel_idempotency_records_total ${numeric(row, 'idempotency_records_total')}`,
    );

    return `${lines.join('\n')}\n`;
  }
}

function firstRow(result: unknown): Record<string, unknown> {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('rows' in result) ||
    !Array.isArray(result.rows) ||
    result.rows.length === 0 ||
    typeof result.rows[0] !== 'object' ||
    result.rows[0] === null
  ) {
    throw new Error('Operational metrics query returned no row');
  }
  return result.rows[0] as Record<string, unknown>;
}

function numeric(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function compareRequestMetrics(left: RequestMetric, right: RequestMetric): number {
  return (
    left.route.localeCompare(right.route) ||
    left.method.localeCompare(right.method) ||
    left.status - right.status
  );
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
