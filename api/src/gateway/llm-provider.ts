import { KeyedStrategy } from '../strategy/strategy-registry';
import { envNumber, estimateTokens, sha256, sleep } from '../common/util';
import { DomainError } from '../common/errors';
import { ModelSpec } from './model-catalog';

export interface Completion { text: string; completionTokens: number }

/** Strategy for the provider axis: one implementation per vendor (mock, openai-compatible, ...). */
export interface LlmProvider extends KeyedStrategy {
  /** Must stop (reject with signal.reason) when `signal` aborts. */
  complete(model: ModelSpec, prompt: string, maxOutputTokens: number, signal?: AbortSignal): Promise<Completion>;
}

export class ProviderUnavailableError extends DomainError {
  constructor(readonly modelId: string) {
    super(`Modelo indisponível: ${modelId}`);
  }
}

/**
 * Deterministic offline provider. Latency is configurable (MOCK_LATENCY_MS +
 * jitter) so parallel subagents are visible in the dashboard. A model marked
 * unhealthy in the catalog behaves like a provider outage.
 */
export class MockProvider implements LlmProvider {
  readonly key = 'mock';

  constructor(private readonly latencyMs = envNumber('MOCK_LATENCY_MS', 0)) {}

  async complete(model: ModelSpec, prompt: string, maxOutputTokens: number, signal?: AbortSignal): Promise<Completion> {
    signal?.throwIfAborted();
    if (this.latencyMs > 0) {
      const jitter = parseInt(sha256(prompt).slice(0, 4), 16) % Math.max(1, this.latencyMs);
      await sleep(this.latencyMs + jitter, signal);
    }
    if (!model.healthy) throw new ProviderUnavailableError(model.id);
    const focus = prompt.split('\n').find((l) => l.startsWith('TAREFA:'))?.slice(7).trim() ?? 'tarefa';
    const text = `[${model.id}] Plano de execução para "${focus}": analisado, implementado e documentado.`;
    return { text, completionTokens: Math.min(maxOutputTokens, estimateTokens(text) + 40) };
  }
}
