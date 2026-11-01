import { Inject, Injectable } from '@nestjs/common';
import { Tier } from '../common/types';
import { PROVIDER_REGISTRY, SEMANTIC_CACHE } from '../common/tokens';
import { envNumber, estimateTokens } from '../common/util';
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
  /** Tenant of the task. Single-tenant deployments use the default. */
  tenantId?: string;
  /** Aborts the call (task timeout or lost lease): no new spend after it fires. */
  signal?: AbortSignal;
}

export const DEFAULT_TENANT = 'default';

/**
 * Cache scope: a cached completion is only served to the same tenant and task
 * (plus agent and tier). Prompts carry task data, so they never cross tasks.
 */
export const cacheScope = (req: Pick<GatewayRequest, 'tenantId' | 'taskId' | 'agent' | 'tier'>): string =>
  [req.tenantId ?? DEFAULT_TENANT, req.taskId, req.agent, req.tier].map(encodeURIComponent).join(':');

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
 *   1. token limit   2. semantic cache (scoped per tenant and task)
 *   3. routing (cheapest model of the tier)   4. per model: atomic budget reservation,
 *      provider call, fallback to the next model on outage
 *   5. usage + cost recorded in billing, settling the reservation
 */
@Injectable()
export class GatewayService {
  readonly stats = { requests: 0, cacheHits: 0, fallbacks: 0, rejectedTokenLimit: 0 };
  private readonly maxPromptTokens = envNumber('GATEWAY_MAX_PROMPT_TOKENS', 8000);
  private readonly maxOutputTokens = envNumber('GATEWAY_MAX_OUTPUT_TOKENS', 512);

  constructor(
    private readonly catalog: ModelCatalog,
    @Inject(PROVIDER_REGISTRY) private readonly providers: StrategyRegistry<LlmProvider>,
    @Inject(SEMANTIC_CACHE) private readonly cache: SemanticCache,
    private readonly billing: BillingService,
    private readonly bus: EventBus,
  ) {}

  async complete(req: GatewayRequest): Promise<GatewayResponse> {
    req.signal?.throwIfAborted();
    this.stats.requests++;
    const promptTokens = estimateTokens(req.prompt);
    if (promptTokens > this.maxPromptTokens) {
      this.stats.rejectedTokenLimit++;
      throw new TokenLimitError(promptTokens, this.maxPromptTokens);
    }
    const maxOut = Math.min(req.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens);
    const scope = cacheScope(req);

    const hit = await this.cache.lookup(scope, req.prompt);
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

    let fallbackFrom: string | null = null;
    for (const model of chain) {
      req.signal?.throwIfAborted();
      // Reserved per model: a fallback to a pricier model is checked against the budget too.
      const reserved = await this.billing.reserve(req.taskId, costOf(model, promptTokens, maxOut));
      let settled = false;
      try {
        const out = await this.providers.resolve(model.provider).complete(model, req.prompt, maxOut, req.signal);
        const costUsd = costOf(model, promptTokens, out.completionTokens);
        await this.billing.record({
          taskId: req.taskId, subtaskId: req.subtaskId, agent: req.agent, model: model.id,
          promptTokens, completionTokens: out.completionTokens, costUsd, savedUsd: 0, cached: false,
        }, reserved);
        settled = true;
        const res = { text: out.text, model: model.id, cached: false, promptTokens, completionTokens: out.completionTokens, costUsd, fallbackFrom };
        await this.cache.store(scope, req.prompt, { text: out.text, model: model.id, promptTokens, completionTokens: out.completionTokens, costUsd });
        this.emitCall(req, model.id, false, fallbackFrom, promptTokens + out.completionTokens, costUsd);
        return res;
      } catch (err) {
        if (!settled) await this.billing.release(req.taskId, reserved);
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
