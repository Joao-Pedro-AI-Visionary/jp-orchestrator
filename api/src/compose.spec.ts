import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static checks on the root docker-compose.yml (no YAML dependency: plain text per service block).
 * Guards the hardening: required passwords, auth on Redis and on the healthchecks, loopback-only ports.
 */
const compose = readFileSync(join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');

function service(name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`service ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('docker-compose.yml', () => {
  const services = ['postgres', 'redis', 'api', 'web'];

  it('publishes every port on the host loopback only', () => {
    const ports = [...compose.matchAll(/ports:\s*\[([^\]]*)\]/g)].flatMap((m) => m[1].split(',').map((p) => p.trim()));
    expect(ports).toHaveLength(services.length);
    for (const p of ports) expect(p).toMatch(/^"127\.0\.0\.1:\d+:\d+"$/);
    expect(compose).not.toMatch(/^\s*-\s*"?\d+:\d+"?\s*$/m);
  });

  it('requires POSTGRES_PASSWORD and REDIS_PASSWORD, with no literal default', () => {
    expect(service('postgres')).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?[^}]+\}/);
    expect(service('redis')).toMatch(/REDIS_PASSWORD: \$\{REDIS_PASSWORD:\?[^}]+\}/);
    expect(compose).not.toMatch(/POSTGRES_PASSWORD: jp\b/);
    expect(compose).not.toMatch(/jp:jp@/);
  });

  it('runs Redis with requirepass and authenticates both healthchecks', () => {
    const redis = service('redis');
    expect(redis).toContain('--requirepass \\"$$REDIS_PASSWORD\\"');
    expect(redis).toMatch(/healthcheck:\s*\n\s*test: .*redis-cli .*-a \\"\$\$REDIS_PASSWORD\\" ping/);
    expect(service('postgres')).toMatch(/healthcheck:[\s\S]*PGPASSWORD=\\"\$\$POSTGRES_PASSWORD\\" psql -h 127\.0\.0\.1/);
  });

  it('builds the API connection URLs from the same passwords', () => {
    const api = service('api');
    expect(api).toMatch(/DATABASE_URL: postgres:\/\/jp:\$\{POSTGRES_PASSWORD:\?[^}]+\}@postgres:5432\/orchestrator/);
    expect(api).toMatch(/REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]+\}@redis:6379/);
  });

  it('keeps the API auth, CORS and readiness settings', () => {
    const api = service('api');
    expect(api).toMatch(/API_KEYS: \$\{API_KEYS:\?[^}]+\}/);
    expect(api).toMatch(/WEBHOOK_SECRET: \$\{WEBHOOK_SECRET:\?[^}]+\}/);
    expect(api).toContain('CORS_ORIGINS: ${CORS_ORIGINS:-http://localhost:3000}');
    expect(api).toContain('http://127.0.0.1:3001/health/ready');
    expect(service('web')).toMatch(/NEXT_PUBLIC_API_KEY: \$\{NEXT_PUBLIC_API_KEY:\?[^}]+\}/);
  });
});
