import { Inject, Injectable } from '@nestjs/common';
import { Tier } from '../common/types';
import { PROVIDER_REGISTRY, SEMANTIC_CACHE } from '../common/tokens';
import { envNumber, estimateTokens, throwIfAborted } from '../common/util';
import { BillingService } from '../billing/billing.service';
import { EventBus } from '../events/event-bus';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { LlmProvider, ProviderUnavailableError } from './llm-provider';
import { costOf, ModelCatalog } from './model-catalog';
import { SemanticCache } from './semantic-cache';

export interface GatewayRequest {
  taskId: string;
  subtaskId: string | null;
  agent: string;
  prompt: string;
  tier: Tier;
  maxOutputTokens?: number;
  /** Correction round of the caller (1 = first try). A retry must not get the answer that was just rejected. */
  attempt?: number;
  /** Reviewer feedback being addressed; any feedback bypasses the cache. */
  feedback?: string | null;
  /** Cancels the call: checked before each stage and forwarded to the provider. */
  signal?: AbortSignal;
}

export interface GatewayResponse {
  text: string;
  model: string;
  cached: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  fallbackFrom: string | null;
}

export class TokenLimitError extends Error {
  constructor(readonly tokens: number, readonly limit: number) {
    super(`Prompt com ${tokens} tokens excede o limite de ${limit}`);
  }
}

export class AllModelsUnavailableError extends Error {
  constructor(tier: Tier) {
    super(`Nenhum modelo disponível para o tier ${tier}`);
  }
}

/**
 * AI Gateway: single entry point for every model call.
 * Order of the pipeline (cheapest checks first):
 *   1. token limit   2. cache (exact hash, then semantic)   3. budget guard
 *   4. routing (cheapest model of the tier)   5. fallback chain on outage
 *   6. usage + cost recorded in billing
 * The cache is scoped per task (task:agent:tier), so one task never gets another
 * task's answer, and it is bypassed (neither read nor written) on a correction
 * attempt (attempt > 1 or feedback present): the retry must reach the model.
 */
@Injectable()
export class GatewayService {
  readonly stats = { requests: 0, cacheHits: 0, cacheBypasses: 0, fallbacks: 0, rejectedTokenLimit: 0 };
  private readonly maxPromptTokens = envNumber('GATEWAY_MAX_PROMPT_TOKENS', 8000);
  private readonly maxOutputTokens = envNumber('GATEWAY_MAX_OUTPUT_TOKENS', 512);

  constructor(
    private readonly catalog: ModelCatalog,
    @Inject(PROVIDER_REGISTRY) private readonly providers: StrategyRegistry<LlmProvider>,
    @Inject(SEMANTIC_CACHE) private readonly cache: SemanticCache,
    private readonly billing: BillingService,
    private readonly bus: EventBus,
  ) {}

  /** Correction attempts skip the cache entirely. */
  static bypassesCache(req: Pick<GatewayRequest, 'attempt' | 'feedback'>): boolean {
    return (req.attempt ?? 1) > 1 || !!req.feedback;
  }

  static cacheScope(req: Pick<GatewayRequest, 'taskId' | 'agent' | 'tier'>): string {
    return `${req.taskId}:${req.agent}:${req.tier}`;
  }

  async complete(req: GatewayRequest): Promise<GatewayResponse> {
    throwIfAborted(req.signal);
    this.stats.requests++;
    const promptTokens = estimateTokens(req.prompt);
    if (promptTokens > this.maxPromptTokens) {
      this.stats.rejectedTokenLimit++;
      throw new TokenLimitError(promptTokens, this.maxPromptTokens);
    }
    const maxOut = Math.min(req.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens);
    const scope = GatewayService.cacheScope(req);
    const bypass = GatewayService.bypassesCache(req);
    if (bypass) this.stats.cacheBypasses++;

    const hit = bypass ? null : await this.cache.lookup(scope, req.prompt);
    if (hit) {
      this.stats.cacheHits++;
      await this.billing.record({
        taskId: req.taskId, subtaskId: req.subtaskId, agent: req.agent, model: hit.entry.model,
        promptTokens: 0, completionTokens: 0, costUsd: 0, savedUsd: hit.entry.costUsd, cached: true,
      });
      this.emitCall(req, hit.entry.model, true, null, 0, 0);
      return { ...hit.entry, cached: true, costUsd: 0, fallbackFrom: null };
    }

    const chain = this.catalog.chainFor(req.tier).filter((m) => m.maxContextTokens >= promptTokens + maxOut);
    if (!chain.length) throw new AllModelsUnavailableError(req.tier);
    await this.billing.assertBudget(req.taskId, costOf(chain[0], promptTokens, maxOut));

    let fallbackFrom: string | null = null;
    for (const model of chain) {
      throwIfAborted(req.signal);
      try {
        const out = await this.providers.resolve(model.provider).complete(model, req.prompt, maxOut, req.signal);
        const costUsd = costOf(model, promptTokens, out.completionTokens);
        await this.billing.record({
          taskId: req.taskId, subtaskId: req.subtaskId, agent: req.agent, model: model.id,
          promptTokens, completionTokens: out.completionTokens, costUsd, savedUsd: 0, cached: false,
        });
        const res = { text: out.text, model: model.id, cached: false, promptTokens, completionTokens: out.completionTokens, costUsd, fallbackFrom };
        if (!bypass) await this.cache.store(scope, req.prompt, { text: out.text, model: model.id, promptTokens, completionTokens: out.completionTokens, costUsd });
        this.emitCall(req, model.id, false, fallbackFrom, promptTokens + out.completionTokens, costUsd);
        return res;
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        this.stats.fallbacks++;
        fallbackFrom = fallbackFrom ?? model.id;
      }
    }
    throw new AllModelsUnavailableError(req.tier);
  }

  private emitCall(req: GatewayRequest, model: string, cached: boolean, fallbackFrom: string | null, tokens: number, costUsd: number) {
    this.bus.emit('gateway.call', req.taskId, { model, cached, fallbackFrom, tokens, costUsd, agent: req.agent, tier: req.tier });
  }

  snapshotStats() {
    return { ...this.stats, budgetBlocks: this.billing.budgetBlocks };
  }
}
