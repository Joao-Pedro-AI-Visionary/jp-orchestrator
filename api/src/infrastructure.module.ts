import { Global, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { HTTP_POST, SEMANTIC_CACHE, SHARED_MEMORY, STORE } from './common/tokens';
import { envNumber } from './common/util';
import { EventBus } from './events/event-bus';
import { fetchPost } from './events/outbox-relay.service';
import { InMemorySemanticCache, RedisSemanticCache } from './gateway/semantic-cache';
import { InMemorySharedMemory, RedisSharedMemory } from './memory/shared-memory';
import { MemoryStore } from './persistence/memory.store';
import { PgStore } from './persistence/pg.store';

export const REDIS = Symbol('REDIS');
const log = new Logger('Infrastructure');

/**
 * The in-memory store loses every task on restart and is bounded (MEMORY_STORE_MAX_TASKS),
 * so production refuses it unless ALLOW_MEMORY_STORE=true says the demo is on purpose.
 */
export function assertMemoryStoreAllowed(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV === 'production' && env.ALLOW_MEMORY_STORE !== 'true') {
    throw new Error('DATABASE_URL ausente em produção: configure o Postgres (ou ALLOW_MEMORY_STORE=true para uma demo descartável)');
  }
}

/**
 * Adapters chosen by environment: DATABASE_URL -> Postgres, REDIS_URL -> Redis.
 * Without them the API still runs fully in memory (useful for demos and tests).
 */
@Global()
@Module({
  providers: [
    EventBus,
    { provide: HTTP_POST, useValue: fetchPost },
    {
      provide: STORE,
      useFactory: async () => {
        if (!process.env.DATABASE_URL) {
          assertMemoryStoreAllowed();
          log.warn('DATABASE_URL ausente: usando MemoryStore');
          return new MemoryStore();
        }
        return PgStore.connect(process.env.DATABASE_URL);
      },
    },
    {
      provide: REDIS,
      useFactory: async () => {
        if (!process.env.REDIS_URL) return null;
        const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
        await redis.ping();
        return redis;
      },
    },
    {
      provide: SHARED_MEMORY,
      inject: [REDIS],
      useFactory: (redis: Redis | null) => {
        if (redis) return new RedisSharedMemory(redis);
        if (process.env.DATABASE_URL) {
          // Tasks survive a restart in Postgres, the blackboard does not: the reviewer then
          // finds no evidence and sends the task to another correction round.
          log.warn('REDIS_URL ausente com DATABASE_URL: memória compartilhada em processo, perdida num restart');
        }
        return new InMemorySharedMemory();
      },
    },
    {
      provide: SEMANTIC_CACHE,
      inject: [REDIS],
      useFactory: (redis: Redis | null) => {
        const threshold = envNumber('CACHE_SIMILARITY', 0.92);
        return redis ? new RedisSemanticCache(redis, threshold) : new InMemorySemanticCache(threshold);
      },
    },
  ],
  exports: [EventBus, HTTP_POST, STORE, REDIS, SHARED_MEMORY, SEMANTIC_CACHE],
})
export class InfrastructureModule {}
