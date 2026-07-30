import { describe, expect, it } from 'vitest';

import { canTransitionTask, canTransitionWorkflow } from './index.js';

describe('state machine contracts', () => {
  it('allows a pending workflow to start but not complete immediately', () => {
    expect(canTransitionWorkflow('pending', 'running')).toBe(true);
    expect(canTransitionWorkflow('pending', 'completed')).toBe(false);
  });

  it('requires a task to be ready before it can be leased', () => {
    expect(canTransitionTask('ready', 'leased')).toBe(true);
    expect(canTransitionTask('blocked', 'leased')).toBe(false);
  });

  it('treats completed workflows as terminal', () => {
    expect(canTransitionWorkflow('completed', 'running')).toBe(false);
  });

  it('leases compensation work before reaching a compensation outcome', () => {
    expect(canTransitionTask('completed', 'compensating')).toBe(true);
    expect(canTransitionTask('compensating', 'leased')).toBe(true);
    expect(canTransitionTask('leased', 'compensated')).toBe(true);
  });
});
