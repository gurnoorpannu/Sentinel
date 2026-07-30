'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';

import {
  durationLabel,
  eventPresentation,
  formatPayloadValue,
  formatTimestamp,
  humanize,
  shortenId,
} from '../../dashboard-helpers';

type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'compensating'
  | 'completed'
  | 'failed'
  | 'compensated'
  | 'compensation_failed';

type TaskStatus =
  | 'blocked'
  | 'ready'
  | 'leased'
  | 'retry_scheduled'
  | 'completed'
  | 'failed'
  | 'compensating'
  | 'compensated'
  | 'compensation_failed';

interface WorkflowDetail {
  workflow: {
    id: string;
    name: string;
    status: WorkflowStatus;
    payload: Record<string, unknown>;
    version: number;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  tasks: Array<{
    id: string;
    workflowId: string;
    stepNumber: number;
    name: string;
    handler: string;
    compensationHandler: string | null;
    executionMode: 'forward' | 'compensation';
    status: TaskStatus;
    payload: Record<string, unknown>;
    result: unknown;
    maxAttempts: number;
    attemptCount: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    generation: number;
    nextAttemptAt: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  }>;
  events: Array<{
    id: string;
    workflowId: string;
    taskId: string | null;
    sequence: number;
    eventType: string;
    data: Record<string, unknown>;
    occurredAt: string;
  }>;
}

interface HistoryIntegrityReport {
  workflowId: string;
  valid: boolean;
  eventCount: number;
  latestSequence: number;
  replayedWorkflowStatus: WorkflowStatus;
  replayedTaskStatuses: Array<{ taskId: string; status: TaskStatus }>;
  issues: Array<{ code: string; message: string; sequence?: number; taskId?: string }>;
}

const workflowLabels: Record<WorkflowStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  compensating: 'Compensating',
  completed: 'Completed',
  failed: 'Failed',
  compensated: 'Compensated',
  compensation_failed: 'Compensation failed',
};

const taskLabels: Record<TaskStatus, string> = {
  blocked: 'Blocked',
  ready: 'Ready',
  leased: 'Leased',
  retry_scheduled: 'Retry scheduled',
  completed: 'Completed',
  failed: 'Failed',
  compensating: 'Compensating',
  compensated: 'Compensated',
  compensation_failed: 'Compensation failed',
};

export default function WorkflowDetailPage() {
  const parameters = useParams<{ workflowId: string }>();
  const workflowId = parameters.workflowId;
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [historyReport, setHistoryReport] = useState<HistoryIntegrityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (background = false) => {
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const [response, historyResponse] = await Promise.all([
          fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
            cache: 'no-store',
          }),
          fetch(`/api/workflows/${encodeURIComponent(workflowId)}/history-integrity`, {
            cache: 'no-store',
          }),
        ]);
        if (response.status === 404) {
          throw new Error('Workflow not found');
        }
        if (!response.ok) {
          throw new Error('Sentinel API is unavailable');
        }
        setDetail((await response.json()) as WorkflowDetail);
        setHistoryReport(
          historyResponse.ok ? ((await historyResponse.json()) as HistoryIntegrityReport) : null,
        );
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to load workflow');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [workflowId],
  );

  useEffect(() => {
    void loadDetail();
    const interval = window.setInterval(() => void loadDetail(true), 5_000);
    return () => window.clearInterval(interval);
  }, [loadDetail]);

  if (loading) {
    return <DetailLoading />;
  }

  if (!detail) {
    return (
      <DetailShell title="Workflow unavailable">
        <div className="detail-error">
          <span>S</span>
          <h1>{error ?? 'Unable to load workflow'}</h1>
          <p>The workflow may not exist, or the Sentinel API may be temporarily unavailable.</p>
          <div>
            <a href="/">Back to workflows</a>
            <button type="button" onClick={() => void loadDetail()}>
              Try again
            </button>
          </div>
        </div>
      </DetailShell>
    );
  }

  return (
    <DetailShell title={detail.workflow.name}>
      <WorkflowDetailView
        detail={detail}
        historyReport={historyReport}
        refreshing={refreshing}
        onRefresh={() => void loadDetail(true)}
      />
    </DetailShell>
  );
}

function DetailShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="app-shell detail-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Sentinel</strong>
            <span>Orchestration</span>
          </div>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="nav-item active" href="/">
            <span className="nav-icon">⌁</span>
            Workflows
          </a>
          <span className="nav-item muted">
            <span className="nav-icon">◇</span>
            Reliability
            <span className="soon">Soon</span>
          </span>
          <span className="nav-item muted">
            <span className="nav-icon">◎</span>
            Workers
            <span className="soon">Soon</span>
          </span>
        </nav>
        <div className="sidebar-status">
          <div className="status-title">
            <span className="health-dot" />
            Live projection
          </div>
          <p>Refreshes from PostgreSQL every 5 seconds.</p>
        </div>
      </aside>
      <main className="dashboard">
        <header className="topbar">
          <div className="breadcrumb">
            <a href="/">Workflows</a>
            <span>/</span>
            <strong>{title}</strong>
          </div>
          <div className="environment">
            <span className="environment-dot" />
            Development
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function WorkflowDetailView({
  detail,
  historyReport,
  refreshing,
  onRefresh,
}: {
  detail: WorkflowDetail;
  historyReport: HistoryIntegrityReport | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { workflow, tasks, events } = detail;
  const completedTasks = tasks.filter((task) =>
    ['completed', 'compensated'].includes(task.status),
  ).length;
  const totalAttempts = tasks.reduce((total, task) => total + task.attemptCount, 0);
  const duration = durationLabel(workflow.startedAt ?? workflow.createdAt, workflow.completedAt);
  const orderId = typeof workflow.payload.orderId === 'string' ? workflow.payload.orderId : null;
  const reversedEvents = useMemo(() => [...events].reverse(), [events]);

  return (
    <div className="content detail-content">
      <a className="back-link" href="/">
        ← All workflows
      </a>

      <section className="detail-heading">
        <div>
          <div className="detail-title-line">
            <h1>{workflow.name}</h1>
            <WorkflowStatusBadge status={workflow.status} />
          </div>
          <p>
            <span>{orderId ?? shortenId(workflow.id)}</span>
            <span>·</span>
            <code>{workflow.id}</code>
          </p>
        </div>
        <button type="button" className="refresh-button" onClick={onRefresh} disabled={refreshing}>
          <span className={refreshing ? 'refresh-icon spinning' : 'refresh-icon'}>↻</span>
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </section>

      <section className="detail-metrics" aria-label="Workflow metrics">
        <DetailMetric label="Progress" value={`${completedTasks}/${tasks.length}`} detail="steps" />
        <DetailMetric label="Attempts" value={String(totalAttempts)} detail="worker claims" />
        <DetailMetric label="Duration" value={duration} detail="wall-clock time" />
        <DetailMetric label="Version" value={`v${workflow.version}`} detail="projection version" />
      </section>

      <HistoryIntegrity report={historyReport} />

      <div className="detail-grid">
        <section className="execution-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Execution path</p>
              <h2>Durable steps</h2>
            </div>
            <span>{tasks.length} total</span>
          </div>
          <div className="task-list">
            {tasks.map((task, index) => (
              <TaskCard task={task} isLast={index === tasks.length - 1} key={task.id} />
            ))}
          </div>
        </section>

        <aside className="timeline-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Audit history</p>
              <h2>Event timeline</h2>
            </div>
            <span>{events.length} events</span>
          </div>
          <div className="event-list">
            {reversedEvents.map((event) => (
              <EventItem event={event} tasks={tasks} key={event.id} />
            ))}
          </div>
        </aside>
      </div>

      <section className="payload-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Input</p>
            <h2>Workflow payload</h2>
          </div>
        </div>
        <PayloadGrid payload={workflow.payload} />
      </section>
    </div>
  );
}

function HistoryIntegrity({ report }: { report: HistoryIntegrityReport | null }) {
  if (!report) {
    return (
      <section className="integrity-banner integrity-unavailable">
        <span className="integrity-icon">?</span>
        <div>
          <strong>History verification unavailable</strong>
          <p>The live projection is visible, but its event replay could not be checked.</p>
        </div>
      </section>
    );
  }

  return (
    <section className={report.valid ? 'integrity-banner' : 'integrity-banner integrity-failed'}>
      <span className="integrity-icon">{report.valid ? '✓' : '!'}</span>
      <div>
        <strong>
          {report.valid ? 'Event history verified' : 'Projection divergence detected'}
        </strong>
        <p>
          Replayed {report.eventCount} events through sequence {report.latestSequence} · workflow{' '}
          {report.replayedWorkflowStatus}
        </p>
        {report.issues.length > 0 ? (
          <ul>
            {report.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.sequence ?? index}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function DetailMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function TaskCard({ task, isLast }: { task: WorkflowDetail['tasks'][number]; isLast: boolean }) {
  const handler = task.executionMode === 'compensation' ? task.compensationHandler : task.handler;

  return (
    <div className={`task-step task-${task.status}`}>
      <div className="step-rail">
        <span>{String(task.stepNumber).padStart(2, '0')}</span>
        {!isLast ? <i /> : null}
      </div>
      <article className="task-card">
        <div className="task-main">
          <div>
            <h3>{task.name}</h3>
            <code>{handler ?? task.handler}</code>
          </div>
          <TaskStatusBadge status={task.status} />
        </div>
        <div className="task-metadata">
          <Metadata label="Mode" value={task.executionMode} />
          <Metadata label="Attempts" value={`${task.attemptCount}/${task.maxAttempts}`} />
          <Metadata label="Generation" value={String(task.generation)} />
          <Metadata label="Worker" value={task.leaseOwner ?? '—'} />
        </div>
        {task.nextAttemptAt ? (
          <div className="task-notice warning">
            Retry eligible {formatTimestamp(task.nextAttemptAt)}
          </div>
        ) : null}
        {task.leaseExpiresAt ? (
          <div className="task-notice">Lease expires {formatTimestamp(task.leaseExpiresAt)}</div>
        ) : null}
        {task.result !== null ? (
          <details className="task-result">
            <summary>
              {task.status.includes('failed') ? 'Failure detail' : 'Recorded result'}
            </summary>
            <pre>{JSON.stringify(task.result, null, 2)}</pre>
          </details>
        ) : null}
      </article>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function EventItem({
  event,
  tasks,
}: {
  event: WorkflowDetail['events'][number];
  tasks: WorkflowDetail['tasks'];
}) {
  const task = event.taskId ? tasks.find((candidate) => candidate.id === event.taskId) : null;
  const presentation = eventPresentation(event.eventType);

  return (
    <article className={`event-item event-${presentation.tone}`}>
      <span className="event-dot">{presentation.symbol}</span>
      <div>
        <div className="event-title">
          <strong>{presentation.title}</strong>
          <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time>
        </div>
        <p>
          {task ? `Step ${task.stepNumber} · ${task.name}` : 'Workflow'}
          <span> · #{event.sequence}</span>
        </p>
        {event.data.workerId ? <code>{String(event.data.workerId)}</code> : null}
      </div>
    </article>
  );
}

function PayloadGrid({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return <p className="empty-payload">No workflow payload was recorded.</p>;
  }
  return (
    <div className="payload-grid">
      {entries.map(([key, value]) => (
        <div key={key}>
          <span>{humanize(key)}</span>
          <strong>{formatPayloadValue(value)}</strong>
        </div>
      ))}
    </div>
  );
}

function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {workflowLabels[status]}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {taskLabels[status]}
    </span>
  );
}

function DetailLoading() {
  return (
    <DetailShell title="Loading">
      <div className="content detail-content">
        <div className="detail-loading">
          <span />
          <span />
          <span />
          <div>
            <span />
            <span />
          </div>
        </div>
      </div>
    </DetailShell>
  );
}
