import { Injectable } from '@nestjs/common';
import { Tier } from '../common/types';

export interface ModelSpec {
  id: string;
  provider: string;
  tier: Tier;
  /** USD per 1k tokens */
  inputPer1k: number;
  outputPer1k: number;
  maxContextTokens: number;
  healthy: boolean;
}

export const TIER_RANK: Record<Tier, number> = { cheap: 0, balanced: 1, premium: 2 };

/** Default catalog of mock models. Prices are illustrative, in the range of real cheap/mid/top models. */
export const DEFAULT_MODELS: ModelSpec[] = [
  { id: 'mock-mini', provider: 'mock', tier: 'cheap', inputPer1k: 0.00015, outputPer1k: 0.0006, maxContextTokens: 16000, healthy: true },
  { id: 'mock-lite', provider: 'mock', tier: 'cheap', inputPer1k: 0.0003, outputPer1k: 0.0012, maxContextTokens: 16000, healthy: true },
  { id: 'mock-standard', provider: 'mock', tier: 'balanced', inputPer1k: 0.0025, outputPer1k: 0.01, maxContextTokens: 64000, healthy: true },
  { id: 'mock-pro', provider: 'mock', tier: 'premium', inputPer1k: 0.015, outputPer1k: 0.075, maxContextTokens: 200000, healthy: true },
];

@Injectable()
export class ModelCatalog {
  private readonly models: ModelSpec[];

  constructor(models: ModelSpec[] = DEFAULT_MODELS) {
    this.models = models.map((m) => ({ ...m }));
  }

  list(): ModelSpec[] {
    return this.models.map((m) => ({ ...m }));
  }

  get(id: string): ModelSpec | undefined {
    return this.models.find((m) => m.id === id);
  }

  setHealthy(id: string, healthy: boolean): ModelSpec {
    const m = this.get(id);
    if (!m) throw new Error(`Modelo desconhecido: ${id}`);
    m.healthy = healthy;
    return { ...m };
  }

  /**
   * Fallback chain for a requested tier, cheapest first (economy):
   * same or higher tiers by (tier, price), then lower tiers as degraded fallback.
   */
  chainFor(tier: Tier): ModelSpec[] {
    const rank = TIER_RANK[tier];
    const byCost = (a: ModelSpec, b: ModelSpec) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.inputPer1k + a.outputPer1k - (b.inputPer1k + b.outputPer1k);
    const up = this.models.filter((m) => TIER_RANK[m.tier] >= rank).sort(byCost);
    const down = this.models.filter((m) => TIER_RANK[m.tier] < rank).sort(byCost).reverse();
    return [...up, ...down].map((m) => ({ ...m }));
  }
}

export const costOf = (m: Pick<ModelSpec, 'inputPer1k' | 'outputPer1k'>, promptTokens: number, completionTokens: number): number =>
  (promptTokens / 1000) * m.inputPer1k + (completionTokens / 1000) * m.outputPer1k;
