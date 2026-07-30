/* global fetch */

import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

const apiUrl = new URL(process.env.SENTINEL_API_URL ?? 'http://localhost:4000');
const timeoutMs = integerSetting('DEMO_TIMEOUT_MS', 60_000, 1_000, 600_000);
const orderId = process.env.DEMO_ORDER_ID ?? `demo-${Date.now()}`;
const terminalStatuses = new Set([
  'completed',
  'failed',
  'compensated',
  'compensation_failed',
  'canceled',
]);

const readiness = await request('/ready');
if (readiness.response.status !== 200) {
  throw new Error(`Sentinel is not ready: HTTP ${readiness.response.status}`);
}

const created = await request('/workflows/ecommerce', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    orderId,
    customerEmail: 'demo@example.com',
    totalCents: 4299,
    currency: 'USD',
    items: [
      { sku: 'sentinel-shirt', quantity: 1 },
      { sku: 'sentinel-cap', quantity: 1 },
    ],
  }),
});
if (created.response.status !== 201) {
  throw new Error(`Workflow creation failed: HTTP ${created.response.status} ${created.text}`);
}

const workflowId = created.body?.workflow?.id;
if (typeof workflowId !== 'string') {
  throw new Error('Sentinel returned no workflow ID');
}

process.stdout.write(`Created workflow ${workflowId} for ${orderId}\n`);
const deadline = Date.now() + timeoutMs;
let lastStatus;
let detail;

while (Date.now() < deadline) {
  const current = await request(`/workflows/${encodeURIComponent(workflowId)}`);
  if (current.response.status !== 200) {
    throw new Error(`Workflow lookup failed: HTTP ${current.response.status}`);
  }
  detail = current.body;
  const status = detail?.workflow?.status;
  if (status !== lastStatus) {
    process.stdout.write(`Workflow status: ${String(status)}\n`);
    lastStatus = status;
  }
  if (terminalStatuses.has(status)) {
    break;
  }
  await delay(500);
}

if (!detail || !terminalStatuses.has(detail.workflow?.status)) {
  throw new Error(`Workflow did not become terminal within ${timeoutMs}ms`);
}

const integrity = await request(`/workflows/${encodeURIComponent(workflowId)}/history-integrity`);
if (integrity.response.status !== 200 || integrity.body?.valid !== true) {
  throw new Error(`Event-history integrity failed for workflow ${workflowId}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      workflowId,
      status: detail.workflow.status,
      tasks: detail.tasks.map((task) => ({
        step: task.stepNumber,
        name: task.name,
        status: task.status,
        attempts: task.attemptCount,
        generation: task.generation,
      })),
      events: detail.events.length,
      historyIntegrity: 'verified',
      dashboard: `http://localhost:3000/workflows/${workflowId}`,
    },
    null,
    2,
  )}\n`,
);

async function request(pathname, init) {
  const response = await fetch(new URL(pathname, apiUrl), init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { response, text, body };
}

function integerSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
