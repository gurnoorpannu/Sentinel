import { describe, expect, it } from 'vitest';

import {
  calculateProgress,
  durationLabel,
  eventPresentation,
  formatDate,
  formatPayloadValue,
  initials,
  shortenId,
} from './dashboard-helpers.js';

describe('dashboard presentation helpers', () => {
  it('calculates bounded workflow progress', () => {
    expect(calculateProgress(2, 4)).toBe(50);
    expect(calculateProgress(0, 0)).toBe(0);
    expect(calculateProgress(6, 4)).toBe(100);
  });

  it('formats stable operational durations and recency', () => {
    const start = '2026-07-30T00:00:00.000Z';
    const end = '2026-07-30T01:02:09.000Z';

    expect(durationLabel(start, end)).toBe('1h 2m');
    expect(formatDate(start, new Date('2026-07-30T00:42:00.000Z').getTime())).toBe('42m ago');
  });

  it('maps retries, failures, and compensation to distinct timeline treatments', () => {
    expect(eventPresentation('task.retry_scheduled')).toMatchObject({
      title: 'Retry scheduled',
      tone: 'warning',
    });
    expect(eventPresentation('task.compensation_ready')).toMatchObject({
      title: 'Compensation activated',
      tone: 'violet',
    });
    expect(eventPresentation('task.compensation_failed')).toMatchObject({
      title: 'Compensation failed',
      tone: 'danger',
    });
    expect(eventPresentation('operator.action_applied')).toMatchObject({
      title: 'Operator action applied',
      tone: 'violet',
    });
  });

  it('formats workflow identity and payload values compactly', () => {
    expect(initials('Order fulfillment')).toBe('OF');
    expect(shortenId('12345678-0000-4000-8000-000000009999')).toBe('12345678…9999');
    expect(formatPayloadValue([{ sku: 'shirt' }, { sku: 'hat' }])).toBe('2 items');
  });
});
