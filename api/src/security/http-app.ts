import { INestApplication } from '@nestjs/common';
import { SecurityConfig } from './security.config';

interface HeaderRes { setHeader(name: string, value: string): void }

/** JSON API: nothing to render, frame or sniff. Same set helmet sets for an API. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** CORS with a closed allowlist and security headers. Shared by main.ts and the HTTP tests. */
export function configureHttp(app: INestApplication, cfg: SecurityConfig): void {
  (app.getHttpAdapter().getInstance() as { disable?(name: string): void }).disable?.('x-powered-by');
  app.use((_req: unknown, res: HeaderRes, next: () => void) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    next();
  });
  app.enableCors({
    origin: cfg.corsOrigins,
    allowedHeaders: ['content-type', 'idempotency-key', 'x-api-key', 'authorization'],
    exposedHeaders: ['Idempotent-Replay', 'Retry-After'],
  });
}
