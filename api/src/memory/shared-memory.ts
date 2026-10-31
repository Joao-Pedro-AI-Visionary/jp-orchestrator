import type Redis from 'ioredis';
import { MemoryEntry } from '../common/types';
import { nowIso } from '../common/util';

/**
 * Shared memory between subagents of the same task (blackboard). A researcher
 * writes findings, the coder and reviewer read them. Namespaced per task.
 */
export interface SharedMemory {
  write(taskId: string, key: string, value: string, agent: string): Promise<void>;
  read(taskId: string, key: string): Promise<MemoryEntry | null>;
  list(taskId: string): Promise<MemoryEntry[]>;
}

export class InMemorySharedMemory implements SharedMemory {
  private data = new Map<string, Map<string, MemoryEntry>>();

  async write(taskId: string, key: string, value: string, agent: string) {
    if (!this.data.has(taskId)) this.data.set(taskId, new Map());
    this.data.get(taskId)!.set(key, { key, value, agent, at: nowIso() });
  }

  async read(taskId: string, key: string) {
    return this.data.get(taskId)?.get(key) ?? null;
  }

  async list(taskId: string) {
    return [...(this.data.get(taskId)?.values() ?? [])];
  }
}

/** Redis hash per task: jp:mem:<taskId> -> key -> JSON entry. */
export class RedisSharedMemory implements SharedMemory {
  constructor(private readonly redis: Redis, private readonly ttlSeconds = 7 * 24 * 3600) {}

  private ns(taskId: string) { return `jp:mem:${taskId}`; }

  async write(taskId: string, key: string, value: string, agent: string) {
    const entry: MemoryEntry = { key, value, agent, at: nowIso() };
    await this.redis.multi().hset(this.ns(taskId), key, JSON.stringify(entry))
      .expire(this.ns(taskId), this.ttlSeconds).exec();
  }

  async read(taskId: string, key: string) {
    const raw = await this.redis.hget(this.ns(taskId), key);
    return raw ? (JSON.parse(raw) as MemoryEntry) : null;
  }

  async list(taskId: string) {
    const all = await this.redis.hgetall(this.ns(taskId));
    return Object.values(all).map((v) => JSON.parse(v) as MemoryEntry)
      .sort((a, b) => a.at.localeCompare(b.at));
  }
}
