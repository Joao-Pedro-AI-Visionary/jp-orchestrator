import type Redis from 'ioredis';
import { sha256 } from '../common/util';

export interface CachedCompletion {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface SemanticCache {
  lookup(scope: string, prompt: string): Promise<{ entry: CachedCompletion; similarity: number } | null>;
  store(scope: string, prompt: string, entry: CachedCompletion): Promise<void>;
}

const DIMS = 256;

/**
 * Local embedding: hashed bag of words + bigrams, L2 normalized. No external
 * call, so a cache lookup costs zero tokens. Swap for a real embedding model
 * behind this same function when needed.
 */
export function embed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const words = text.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const grams = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
  for (const g of grams) v[parseInt(sha256(g).slice(0, 8), 16) % DIMS] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const cosine = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0);

interface Item { vec: number[]; entry: CachedCompletion }

export class InMemorySemanticCache implements SemanticCache {
  private scopes = new Map<string, Item[]>();

  constructor(private readonly threshold = 0.92, private readonly maxPerScope = 200) {}

  async lookup(scope: string, prompt: string) {
    const vec = embed(prompt);
    let best: { entry: CachedCompletion; similarity: number } | null = null;
    for (const it of this.scopes.get(scope) ?? []) {
      const sim = cosine(vec, it.vec);
      if (sim >= this.threshold && (!best || sim > best.similarity)) best = { entry: it.entry, similarity: sim };
    }
    return best;
  }

  async store(scope: string, prompt: string, entry: CachedCompletion) {
    const list = this.scopes.get(scope) ?? [];
    list.unshift({ vec: embed(prompt), entry });
    this.scopes.set(scope, list.slice(0, this.maxPerScope));
  }
}

/** Redis list per scope (newest first, trimmed). Linear scan is fine for a few hundred entries. */
export class RedisSemanticCache implements SemanticCache {
  constructor(
    private readonly redis: Redis,
    private readonly threshold = 0.92,
    private readonly maxPerScope = 200,
    private readonly ttlSeconds = 24 * 3600,
  ) {}

  private key(scope: string) { return `jp:cache:${scope}`; }

  async lookup(scope: string, prompt: string) {
    const vec = embed(prompt);
    const raw = await this.redis.lrange(this.key(scope), 0, this.maxPerScope - 1);
    let best: { entry: CachedCompletion; similarity: number } | null = null;
    for (const r of raw) {
      const it = JSON.parse(r) as Item;
      const sim = cosine(vec, it.vec);
      if (sim >= this.threshold && (!best || sim > best.similarity)) best = { entry: it.entry, similarity: sim };
    }
    return best;
  }

  async store(scope: string, prompt: string, entry: CachedCompletion) {
    const k = this.key(scope);
    await this.redis.multi().lpush(k, JSON.stringify({ vec: embed(prompt), entry }))
      .ltrim(k, 0, this.maxPerScope - 1).expire(k, this.ttlSeconds).exec();
  }
}
