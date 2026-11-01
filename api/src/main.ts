import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertRetryHorizon, retryConfig } from './common/retry-horizon';
import { Orchestrator } from './orchestration/orchestrator.service';

async function bootstrap() {
  // Fail fast: no redelivery or tool retry may outlive the idempotency key.
  assertRetryHorizon(retryConfig());
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const origin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;
  app.enableCors({ origin, exposedHeaders: ['Idempotent-Replay'] });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  const orchestrator = app.get(Orchestrator);
  // Resume on boot, then sweep every TASK_LEASE_MS: a task whose owner died is picked up
  // once its lease expires. The lease keeps replicas from running the same task twice.
  const resumed = process.env.RESUME_ON_BOOT === 'off' ? 0 : await orchestrator.resumeActive();
  if (process.env.RESUME_ON_BOOT !== 'off') orchestrator.startSweep();
  Logger.log(`JP Orchestrator API em :${port} (tarefas retomadas: ${resumed})`, 'Bootstrap');
}

void bootstrap();
