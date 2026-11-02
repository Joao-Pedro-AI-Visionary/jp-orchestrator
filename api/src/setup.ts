import type { NestExpressApplication } from '@nestjs/platform-express';
import { corsOrigins } from './auth/auth.config';
import { httpLogging } from './observability/http-logging';

/**
 * HTTP setup shared by main.ts and the HTTP tests. Call before listen/init: the parsers
 * registered here replace Nest's defaults (100kb), so an oversized body gets 413.
 */
export function configureApp(app: NestExpressApplication, env: NodeJS.ProcessEnv = process.env): string[] {
  const limit = env.BODY_LIMIT ?? '64kb';
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { limit, extended: false });
  app.use(httpLogging);
  const origins = corsOrigins(env);
  app.enableCors({
    origin: origins.includes('*') ? true : origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Idempotency-Key', 'X-Request-Id', 'Last-Event-ID'],
    exposedHeaders: ['Idempotent-Replay', 'Retry-After', 'X-Request-Id'],
  });
  return origins;
}
