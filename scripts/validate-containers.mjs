import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCKERFILES = [
  'infra/docker/node-service.Dockerfile',
  'infra/docker/web-app.Dockerfile',
  'services-py/forecast-service/Dockerfile',
  'services-py/analytics-simulator/Dockerfile',
  'services-py/swap-matcher/Dockerfile',
];

const errors = [];

for (const rel of DOCKERFILES) {
  const full = resolve(rel);
  if (!existsSync(full)) {
    errors.push(`Missing Dockerfile: ${rel}`);
    continue;
  }
  const text = readFileSync(full, 'utf8');
  const fromLines = text.match(/^FROM\s+.+$/gm) ?? [];

  if (fromLines.length < 2) {
    errors.push(`${rel}: must be multi-stage (found ${fromLines.length} FROM stages)`);
  }
  for (const line of fromLines) {
    if (/:latest(\s|$)/i.test(line)) {
      errors.push(`${rel}: unpinned :latest base image found -> ${line}`);
    }
  }
  if (!/^USER\s+(?!root\b)\S+/m.test(text)) {
    errors.push(`${rel}: missing non-root USER instruction`);
  }
  if (!/^HEALTHCHECK\s+/m.test(text)) {
    errors.push(`${rel}: missing HEALTHCHECK instruction`);
  }
}

const nginxConf = readFileSync(resolve('infra/nginx/default.conf'), 'utf8');
for (const required of [
  'gzip on;',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'proxy_buffering off;',
  'proxy_pass http://api-gateway:3001;',
  'location = /healthz',
]) {
  if (!nginxConf.includes(required)) {
    errors.push(`infra/nginx/default.conf: missing required directive '${required}'`);
  }
}

const composeText = readFileSync(resolve('infra/docker-compose.prod.yml'), 'utf8');
for (const svc of [
  'api-gateway:',
  'auth-service:',
  'shop-service:',
  'catalog-service:',
  'inventory-service:',
  'forecast-service:',
  'swap-service:',
  'swap-matcher:',
  'saga-orchestrator:',
  'groupbuy-service:',
  'notification-service:',
  'analytics-simulator:',
  'web-app:',
  'postgres:',
  'redis:',
  'rabbitmq:',
]) {
  if (!composeText.includes(svc)) {
    errors.push(`infra/docker-compose.prod.yml: missing service definition '${svc}'`);
  }
}

if (errors.length > 0) {
  console.error('CONTAINER VALIDATION FAILED:');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log(
  `CONTAINER VALIDATION PASSED: verified ${DOCKERFILES.length} multi-stage non-root Dockerfiles, Nginx config, and 16 Compose services.`,
);
