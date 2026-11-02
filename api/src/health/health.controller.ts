import { Controller, Get, Header, HttpCode, Inject, Res } from '@nestjs/common';
import type Redis from 'ioredis';
import { Public } from '../auth/auth.decorators';
import { STORE } from '../common/tokens';
import { API_VERSION, withTimeout } from '../common/util';
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

@Controller('health')
export class HealthController {
  constructor(@Inject(STORE) private readonly store: Store, @Inject(REDIS) private readonly redis: Redis | null) {}

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
      mode: modeOf(services), version: API_VERSION,
    };
  }

  /** Readiness: 503 while a configured Postgres or Redis is unreachable, so the balancer stops routing here. */
  @Get('ready')
  @Public()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async ready(@Res({ passthrough: true }) res: ResLike) {
    const services = await this.dependencies();
    const ready = services.postgres !== 'down' && services.redis !== 'down';
    if (!ready) res.status(503);
    return { ready, services, mode: modeOf(services) };
  }

  private async check(ping: () => Promise<boolean>): Promise<DependencyState> {
    try {
      return (await withTimeout(ping(), 2_000, 'health')) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
