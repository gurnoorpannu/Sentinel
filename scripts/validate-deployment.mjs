import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const dockerfile = await read('Dockerfile');
const compose = await read('compose.yaml');
const kustomization = await read('deploy/kubernetes/kustomization.yaml');
const dashboardManifest = await read('deploy/kubernetes/dashboard.yaml');
const secretExample = await read('deploy/kubernetes/secret.example.yaml');

assert(dockerfile.includes('FROM node:22-alpine AS build'), 'Docker build must use Node 22');
assert(count(dockerfile, 'USER node') === 2, 'Both runtime images must run as the node user');
assert(
  dockerfile.includes('npm prune --omit=dev'),
  'Service runtime dependencies must exclude development packages',
);
assert(compose.includes('read_only: true'), 'Compose application containers must be read-only');
assert(compose.includes('no-new-privileges:true'), 'Compose must prevent privilege escalation');
assert(compose.includes('cap_drop:\n    - ALL'), 'Compose must drop Linux capabilities');
assert(
  dashboardManifest.includes('key: OPERATOR_TOKEN'),
  'Dashboard must receive the server-only operator token from a Secret',
);
assert(
  secretExample.includes('OPERATOR_TOKEN:'),
  'Deployment secret example must declare the operator token',
);

const resources = [...kustomization.matchAll(/^\s*-\s+([a-z0-9.-]+\.yaml)$/gim)].map(
  ([, resource]) => resource,
);
assert(resources.length >= 6, 'Kustomization must include every production workload');
assert(
  !resources.includes('secret.example.yaml'),
  'Example credentials must never be included by kustomization',
);

for (const resource of resources) {
  await access(path.join(root, 'deploy/kubernetes', resource));
}

for (const manifest of ['api.yaml', 'worker.yaml', 'dashboard.yaml', 'migrate-job.yaml']) {
  const contents = await read(path.join('deploy/kubernetes', manifest));
  assert(contents.includes('runAsNonRoot: true'), `${manifest} must require a non-root runtime`);
  assert(
    contents.includes('readOnlyRootFilesystem: true'),
    `${manifest} must use a read-only root filesystem`,
  );
  assert(
    /drop:\s*(?:\[['"]ALL['"]\]|-\s*ALL)/.test(contents),
    `${manifest} must drop Linux capabilities`,
  );
  assert(contents.includes('resources:'), `${manifest} must declare resource requests and limits`);
}

const api = await read('deploy/kubernetes/api.yaml');
assert(api.includes('path: /live'), 'API deployment must configure a liveness probe');
assert(api.includes('path: /ready'), 'API deployment must configure a readiness probe');

process.stdout.write(
  `Validated ${resources.length} Kubernetes resources and both runtime images\n`,
);

async function read(relativePath) {
  return await readFile(path.join(root, relativePath), 'utf8');
}

function count(value, search) {
  return value.split(search).length - 1;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
