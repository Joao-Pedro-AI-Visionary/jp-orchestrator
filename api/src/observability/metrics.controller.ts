import { Controller, Get, Header, Inject } from '@nestjs/common';
import { STORE } from '../common/tokens';
import { TaskStatus } from '../common/types';
import { Store } from '../persistence/store.port';
import { metrics } from './metrics';

const TASK_STATUSES: TaskStatus[] = ['queued', 'planning', 'running', 'awaiting_approval', 'merging', 'completed', 'failed', 'rejected', 'budget_exceeded'];
const OUTBOX_STATUSES = ['pending', 'delivered', 'dead'];
const series = (statuses: string[], counts: Record<string, number>) => statuses.map((status) => ({ labels: { status }, value: counts[status] ?? 0 }));

/**
 * Prometheus scrape endpoint (viewer key: configure the scrape job with
 * `authorization: { credentials: <key> }`). Task and outbox gauges are read from the store at
 * scrape time, so they are global; counters and histograms are per replica.
 */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(STORE) private readonly store: Store) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('cache-control', 'no-store')
  async scrape(): Promise<string> {
    const [tasks, outbox] = await Promise.all([this.store.countTasksByStatus(), this.store.countOutboxByStatus()]);
    return metrics.render([
      { name: 'jpo_tasks', help: 'Tarefas por status', series: series(TASK_STATUSES, tasks) },
      { name: 'jpo_outbox_events', help: 'Eventos do outbox por status (dead precisa de operador)', series: series(OUTBOX_STATUSES, outbox) },
      { name: 'jpo_outbox_dead', help: 'Eventos do outbox mortos (expirados ou sem mais tentativas)', series: [{ labels: {}, value: outbox.dead ?? 0 }] },
    ]);
  }
}
