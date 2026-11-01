import { INestApplication } from '@nestjs/common';
import { SecurityConfig } from './security.config';

/** CORS with a closed allowlist. Shared by main.ts and the HTTP tests. */
export function configureHttp(app: INestApplication, cfg: SecurityConfig): void {
  app.enableCors({
    origin: cfg.corsOrigins,
    allowedHeaders: ['content-type', 'idempotency-key', 'x-api-key', 'authorization'],
    exposedHeaders: ['Idempotent-Replay', 'Retry-After'],
  });
}
