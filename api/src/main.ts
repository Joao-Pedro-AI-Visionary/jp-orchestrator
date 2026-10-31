import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Orchestrator } from './orchestration/orchestrator.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const origin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;
  app.enableCors({ origin, exposedHeaders: ['Idempotent-Replay'] });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  const resumed = process.env.RESUME_ON_BOOT === 'off' ? 0 : await app.get(Orchestrator).resumeActive();
  Logger.log(`JP Orchestrator API em :${port} (tarefas retomadas: ${resumed})`, 'Bootstrap');
}

void bootstrap();
