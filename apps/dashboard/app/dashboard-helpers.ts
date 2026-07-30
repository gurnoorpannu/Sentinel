export interface EventPresentation {
  title: string;
  symbol: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'violet';
}

export function calculateProgress(completed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function shortenId(id: string): string {
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function formatDate(value: string, now = Date.now()): string {
  const date = new Date(value);
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatRelativeTime(value: Date, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - value.getTime()) / 1000));
  return seconds < 5 ? 'just now' : `${seconds}s ago`;
}

export function durationLabel(
  startValue: string,
  endValue: string | null,
  now = Date.now(),
): string {
  const start = new Date(startValue).getTime();
  const end = endValue ? new Date(endValue).getTime() : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function humanize(value: string): string {
  const words = value.replaceAll('_', ' ').replaceAll('-', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatPayloadValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

export function eventPresentation(eventType: string): EventPresentation {
  if (eventType === 'operator.action_applied') {
    return { title: 'Operator action applied', symbol: '◆', tone: 'violet' };
  }
  if (eventType === 'task.canceled') {
    return { title: 'Task canceled', symbol: '×', tone: 'neutral' };
  }
  if (eventType.includes('compensation')) {
    if (eventType.includes('failed')) {
      return { title: 'Compensation failed', symbol: '!', tone: 'danger' };
    }
    if (eventType.includes('retried')) {
      return { title: 'Compensation retried', symbol: '↻', tone: 'warning' };
    }
    if (eventType.includes('ready')) {
      return { title: 'Compensation activated', symbol: '↶', tone: 'violet' };
    }
    return { title: humanize(eventType.split('.')[1] ?? eventType), symbol: '↶', tone: 'violet' };
  }
  if (eventType === 'task.failed') {
    return { title: 'Task failed', symbol: '!', tone: 'danger' };
  }
  if (eventType === 'task.retry_scheduled' || eventType === 'task.retried') {
    return { title: humanize(eventType.split('.')[1] ?? eventType), symbol: '↻', tone: 'warning' };
  }
  if (eventType === 'task.completed') {
    return { title: 'Task completed', symbol: '✓', tone: 'success' };
  }
  if (eventType === 'workflow.status_changed') {
    return { title: 'Workflow status changed', symbol: '◇', tone: 'neutral' };
  }
  return { title: humanize(eventType.replace('.', ' ')), symbol: '·', tone: 'neutral' };
}
