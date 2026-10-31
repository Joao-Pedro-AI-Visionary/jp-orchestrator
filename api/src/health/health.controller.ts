import { Controller, Get, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import { STORE } from '../common/tokens';
import { REDIS } from '../infrastructure.module';
import { PgStore } from '../persistence/pg.store';
import { Store } from '../persistence/store.port';

@Controller('health')
export class HealthController {
  constructor(@Inject(STORE) private readonly store: Store, @Inject(REDIS) private readonly redis: Redis | null) {}

  @Get()
  async health() {
    const postgres = this.store instanceof PgStore && (await this.store.ping());
    let redis = false;
    try { redis = Boolean(this.redis) && (await this.redis!.ping()) === 'PONG'; } catch { redis = false; }
    return { ok: true, postgres, redis, store: this.store.constructor.name };
  }
}
