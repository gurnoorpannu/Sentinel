'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'compensating'
  | 'completed'
  | 'failed'
  | 'compensated'
  | 'compensation_failed';

interface WorkflowSummary {
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
  taskCount: number;
  completedTaskCount: number;
  activeTaskCount: number;
  failedTaskCount: number;
}

const statusFilters: Array<{ label: string; value: 'all' | WorkflowStatus }> = [
  { label: 'All workflows', value: 'all' },
  { label: 'In progress', value: 'running' },
  { label: 'Compensating', value: 'compensating' },
  { label: 'Failed', value: 'failed' },
  { label: 'Completed', value: 'completed' },
  { label: 'Compensated', value: 'compensated' },
];

const statusLabels: Record<WorkflowStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  compensating: 'Compensating',
  completed: 'Completed',
  failed: 'Failed',
  compensated: 'Compensated',
  compensation_failed: 'Compensation failed',
};

export default function Home() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [status, setStatus] = useState<'all' | WorkflowStatus>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadWorkflows = useCallback(async (background = false) => {
    if (background) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const response = await fetch('/api/workflows?limit=100', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Sentinel API is unavailable');
      }
      const body = (await response.json()) as { workflows: WorkflowSummary[] };
      setWorkflows(body.workflows);
      setError(null);
      setLastUpdated(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load workflows');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
    const interval = window.setInterval(() => void loadWorkflows(true), 10_000);
    return () => window.clearInterval(interval);
  }, [loadWorkflows]);

  const filteredWorkflows = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return workflows.filter(({ workflow }) => {
      const matchesStatus = status === 'all' || workflow.status === status;
      const matchesSearch =
        normalizedSearch.length === 0 ||
        workflow.name.toLowerCase().includes(normalizedSearch) ||
        workflow.id.toLowerCase().includes(normalizedSearch) ||
        String(workflow.payload.orderId ?? '')
          .toLowerCase()
          .includes(normalizedSearch);
      return matchesStatus && matchesSearch;
    });
  }, [search, status, workflows]);

  const runningCount = workflows.filter(({ workflow }) =>
    ['pending', 'running', 'compensating'].includes(workflow.status),
  ).length;
  const attentionCount = workflows.filter(({ workflow }) =>
    ['failed', 'compensation_failed'].includes(workflow.status),
  ).length;
  const recoveredCount = workflows.filter(
    ({ workflow }) => workflow.status === 'compensated',
  ).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <div>
            <strong>Sentinel</strong>
            <span>Orchestration</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="nav-item active" href="/">
            <span className="nav-icon">⌁</span>
            Workflows
            <span className="nav-count">{workflows.length}</span>
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
            <span className={error ? 'health-dot error' : 'health-dot'} />
            {error ? 'Connection issue' : 'System operational'}
          </div>
          <p>PostgreSQL is the durable source of truth.</p>
        </div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Operations</span>
            <span>/</span>
            <strong>Workflows</strong>
          </div>
          <div className="environment">
            <span className="environment-dot" />
            Development
          </div>
        </header>

        <div className="content">
          <section className="page-heading">
            <div>
              <p className="eyebrow">Live operations</p>
              <h1>Workflow control room</h1>
              <p className="page-description">
                Track every durable transition, retry, lease, and compensation from one place.
              </p>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void loadWorkflows(true)}
              disabled={refreshing}
            >
              <span className={refreshing ? 'refresh-icon spinning' : 'refresh-icon'}>↻</span>
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
          </section>

          <section className="metrics" aria-label="Workflow overview">
            <MetricCard
              label="Total workflows"
              value={workflows.length}
              detail="Last 100 created"
            />
            <MetricCard
              label="In flight"
              value={runningCount}
              detail="Pending, running, or reversing"
              tone="accent"
            />
            <MetricCard
              label="Needs attention"
              value={attentionCount}
              detail="Terminal failures"
              tone={attentionCount > 0 ? 'danger' : undefined}
            />
            <MetricCard
              label="Recovered"
              value={recoveredCount}
              detail="Successfully compensated"
              tone="violet"
            />
          </section>

          <section className="workflow-panel">
            <div className="panel-toolbar">
              <div className="filter-tabs" role="tablist" aria-label="Filter workflows">
                {statusFilters.map((filter) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={status === filter.value}
                    className={status === filter.value ? 'filter-tab selected' : 'filter-tab'}
                    onClick={() => setStatus(filter.value)}
                    key={filter.value}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <label className="search">
                <span aria-hidden="true">⌕</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, ID, or order"
                  aria-label="Search workflows"
                />
              </label>
            </div>

            <div className="table-heading">
              <div>
                <h2>Recent workflows</h2>
                <p>
                  {filteredWorkflows.length} result{filteredWorkflows.length === 1 ? '' : 's'}
                  {lastUpdated ? ` · Updated ${formatRelativeTime(lastUpdated)}` : ''}
                </p>
              </div>
              <span className="auto-refresh">
                <span className="pulse" />
                Auto-refresh · 10s
              </span>
            </div>

            {loading ? (
              <WorkflowSkeleton />
            ) : error && workflows.length === 0 ? (
              <EmptyState
                title="Unable to reach Sentinel"
                description="Check that the API and PostgreSQL services are running, then try again."
                action={() => void loadWorkflows()}
              />
            ) : filteredWorkflows.length === 0 ? (
              <EmptyState
                title="No matching workflows"
                description="Adjust the filter or create an e-commerce workflow through the API."
              />
            ) : (
              <div className="workflow-table" role="table" aria-label="Recent workflows">
                <div className="workflow-row table-labels" role="row">
                  <span>Workflow</span>
                  <span>Status</span>
                  <span>Progress</span>
                  <span>Attempts</span>
                  <span>Updated</span>
                  <span aria-hidden="true" />
                </div>
                {filteredWorkflows.map((summary) => (
                  <WorkflowRow summary={summary} key={summary.workflow.id} />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  tone?: 'accent' | 'danger' | 'violet';
}) {
  return (
    <article className={`metric-card ${tone ?? ''}`}>
      <p>{label}</p>
      <strong>{value.toLocaleString()}</strong>
      <span>{detail}</span>
    </article>
  );
}

function WorkflowRow({ summary }: { summary: WorkflowSummary }) {
  const { workflow } = summary;
  const progress =
    summary.taskCount === 0
      ? 0
      : Math.round((summary.completedTaskCount / summary.taskCount) * 100);
  const orderId = workflow.payload.orderId;

  return (
    <a className="workflow-row data-row" role="row" href={`/workflows/${workflow.id}`}>
      <div className="workflow-identity">
        <span className="workflow-symbol">{initials(workflow.name)}</span>
        <div>
          <strong>{workflow.name}</strong>
          <span>
            {typeof orderId === 'string' ? orderId : shortenId(workflow.id)} · v{workflow.version}
          </span>
        </div>
      </div>
      <div>
        <StatusBadge status={workflow.status} />
      </div>
      <div className="progress-cell">
        <div className="progress-copy">
          <span>
            {summary.completedTaskCount}/{summary.taskCount} steps
          </span>
          <strong>{progress}%</strong>
        </div>
        <div className="progress-track">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="attempt-cell">
        <strong>{summary.activeTaskCount}</strong>
        <span> active</span>
        {summary.failedTaskCount > 0 ? (
          <small>{summary.failedTaskCount} failed</small>
        ) : (
          <small>healthy</small>
        )}
      </div>
      <time dateTime={workflow.updatedAt}>{formatDate(workflow.updatedAt)}</time>
      <span className="row-arrow" aria-hidden="true">
        →
      </span>
    </a>
  );
}

function StatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}

function WorkflowSkeleton() {
  return (
    <div className="skeleton-list" aria-label="Loading workflows">
      {[0, 1, 2, 3].map((item) => (
        <div className="skeleton-row" key={item}>
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-mark">S</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? (
        <button type="button" onClick={action}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function shortenId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  const elapsed = Date.now() - date.getTime();
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatRelativeTime(value: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000));
  return seconds < 5 ? 'just now' : `${seconds}s ago`;
}
