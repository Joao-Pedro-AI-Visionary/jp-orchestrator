import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { STORE } from '../common/tokens';
import { REDIS } from '../infrastructure.module';
import { PgStore } from '../persistence/pg.store';
import { Public } from '../security/security.guards';
import { Store } from '../persistence/store.port';

export type DependencyState = 'up' | 'down' | 'disabled';

@Controller('health')
export class HealthController {
  constructor(@Inject(STORE) private readonly store: Store, @Inject(REDIS) private readonly redis: Redis | null) {}

  /**
   * Public: container healthchecks call it without a key. Each dependency reports
   * 'up', 'down' or 'disabled' (not configured: the in-memory adapter is in use).
   */
  @Public()
  @Get()
  async health(): Promise<{ ok: true; postgres: DependencyState; redis: DependencyState; store: string }> {
    const postgres: DependencyState = this.store instanceof PgStore ? ((await this.store.ping()) ? 'up' : 'down') : 'disabled';
    let redis: DependencyState = 'disabled';
    if (this.redis) {
      try { redis = (await this.redis.ping()) === 'PONG' ? 'up' : 'down'; } catch { redis = 'down'; }
    }
    return { ok: true, postgres, redis, store: this.store.constructor.name };
  }
}
