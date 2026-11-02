import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertSecurityConfig, authConfig } from './auth/auth.config';
import { assertRetryHorizon, retryConfig } from './common/retry-horizon';
import { JsonLogger } from './observability/json-logger';
import { Orchestrator } from './orchestration/orchestrator.service';
import { assertRetentionConfig, retentionConfig } from './retention/retention.service';
import { configureApp } from './setup';

async function bootstrap() {
  // Fail fast: no redelivery or tool retry may outlive the idempotency key, and production
  // never runs without API keys, with the public signing secret or with CORS open to all.
  assertRetryHorizon(retryConfig());
  assertRetentionConfig(retentionConfig());
  assertSecurityConfig();
  const logger = process.env.LOG_FORMAT === 'text' ? undefined : new JsonLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, ...(logger ? { logger } : {}) });
  const origins = configureApp(app);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  const orchestrator = app.get(Orchestrator);
  // Resume on boot, then sweep every TASK_LEASE_MS: a task whose owner died is picked up
  // once its lease expires. The lease keeps replicas from running the same task twice.
  const resumed = process.env.RESUME_ON_BOOT === 'off' ? 0 : await orchestrator.resumeActive();
  if (process.env.RESUME_ON_BOOT !== 'off') orchestrator.startSweep();
  const auth = authConfig();
  if (auth.open) Logger.warn('API_KEYS vazio: modo aberto, sem autenticação (só fora de produção)', 'Bootstrap');
  Logger.log(`JP Orchestrator API em :${port} (tarefas retomadas: ${resumed}, chaves: ${auth.keys.size}, CORS: ${origins.join(' ') || 'nenhuma origem'})`, 'Bootstrap');
}

void bootstrap();
