import { Controller, Get, Header, HttpCode, Inject, Res } from '@nestjs/common';
import type Redis from 'ioredis';
import { Public } from '../auth/auth.decorators';
import { DURABLE_RUNTIME, STORE } from '../common/tokens';
import { API_VERSION, withTimeout } from '../common/util';
import { AnyDurableRuntime, isEngine } from '../durable/durable-runtime';
import { REDIS } from '../infrastructure.module';
import { Store } from '../persistence/store.port';

/** 'memory': the dependency is not configured and the API runs on its in-process adapter (valid, not an outage). */
export type DependencyState = 'up' | 'down' | 'memory';
/** 'in-memory': nothing configured (demo/dev, state is lost on restart); 'persistent': Postgres and Redis; 'mixed': one of them. */
export type RunMode = 'in-memory' | 'persistent' | 'mixed';

export const modeOf = (s: { postgres: DependencyState; redis: DependencyState }): RunMode => {
  const inMemory = [s.postgres, s.redis].filter((x) => x === 'memory').length;
  return inMemory === 2 ? 'in-memory' : inMemory === 0 ? 'persistent' : 'mixed';
};
interface ResLike { status(code: number): void }

/**
 * Active durable runtime. journal: its state is the store's (Postgres, or 'memory'); restate: the
 * ingress answers. A restate that is down makes the API not ready: no task can start or continue.
 */
export interface DurableHealth { runtime: string; state: DependencyState }

@Controller('health')
export class HealthController {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(DURABLE_RUNTIME) private readonly runtime: AnyDurableRuntime,
  ) {}

  async durable(postgres: DependencyState): Promise<DurableHealth> {
    const rt = this.runtime;
    return { runtime: rt.name, state: isEngine(rt) ? await this.check(() => rt.ping()) : postgres };
  }

  async dependencies(): Promise<{ postgres: DependencyState; redis: DependencyState }> {
    const [postgres, redis] = await Promise.all([
      this.store.kind === 'memory' ? 'memory' as const : this.check(() => this.store.ping()),
      this.redis ? this.check(async () => (await this.redis!.ping()) === 'PONG') : 'memory' as const,
    ]);
    return { postgres, redis };
  }

  /**
   * Liveness: the process answers. Always 200 (a dead database must not get the API restarted);
   * postgres/redis are true only when configured and reachable, services says which are in memory.
   */
  @Get()
  @Public()
  async health() {
    const services = await this.dependencies();
    return {
      ok: true, postgres: services.postgres === 'up', redis: services.redis === 'up', services, store: this.store.kind,
      mode: modeOf(services), durable: await this.durable(services.postgres), version: API_VERSION,
    };
  }

  /** Readiness: 503 while a configured Postgres, Redis or the durable engine is unreachable, so the balancer stops routing here. */
  @Get('ready')
  @Public()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async ready(@Res({ passthrough: true }) res: ResLike) {
    const services = await this.dependencies();
    const durable = await this.durable(services.postgres);
    const ready = services.postgres !== 'down' && services.redis !== 'down' && durable.state !== 'down';
    if (!ready) res.status(503);
    return { ready, services, mode: modeOf(services), durable };
  }

  private async check(ping: () => Promise<boolean>): Promise<DependencyState> {
    try {
      return (await withTimeout(ping(), 2_000, 'health')) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
