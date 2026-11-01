import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertRetryHorizon, retryConfig } from './common/retry-horizon';
import { Orchestrator } from './orchestration/orchestrator.service';
import { configureHttp } from './security/http-app';
import { assertSecurityConfig } from './security/security.config';

async function bootstrap() {
  // Fail fast: no redelivery or tool retry may outlive the idempotency key.
  assertRetryHorizon(retryConfig());
  // Fail fast: API key, CORS allowlist and webhook secret.
  const security = assertSecurityConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureHttp(app, security);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, security.host);
  const resumed = process.env.RESUME_ON_BOOT === 'off' ? 0 : await app.get(Orchestrator).resumeActive();
  Logger.log(`JP Orchestrator API em ${security.host}:${port} (tarefas retomadas: ${resumed})`, 'Bootstrap');
}

void bootstrap();
