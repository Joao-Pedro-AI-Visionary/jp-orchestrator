import { BillingService } from '../billing/billing.service';
import { EventBus } from '../events/event-bus';
import { GatewayService } from '../gateway/gateway.service';
import { LlmProvider, MockProvider } from '../gateway/llm-provider';
import { DEFAULT_MODELS, ModelCatalog } from '../gateway/model-catalog';
import { InMemorySemanticCache } from '../gateway/semantic-cache';
import { MemoryStore } from '../persistence/memory.store';
import { StrategyRegistry } from '../strategy/strategy-registry';

/** Wires the gateway stack with in-memory adapters for unit tests. */
export function gatewayHarness(provider: LlmProvider = new MockProvider(0)) {
  const store = new MemoryStore();
  const bus = new EventBus();
  const catalog = new ModelCatalog(DEFAULT_MODELS);
  const billing = new BillingService(store, bus);
  const cache = new InMemorySemanticCache(0.92);
  const gateway = new GatewayService(catalog, new StrategyRegistry('provider', [provider]), cache, billing, bus);
  return { store, bus, catalog, billing, cache, gateway };
}

import { DEFAULT_AGENTS } from '../agents/agents';
import { JournalRuntime } from '../durable/journal.runtime';
import { ContextStore } from '../memory/context-store.service';
import { InMemorySharedMemory } from '../memory/shared-memory';
import { Dispatcher } from '../orchestration/dispatcher';
import { loops } from '../orchestration/loops';
import { Orchestrator } from '../orchestration/orchestrator.service';
import { Planner } from '../orchestration/planner';
import { BUILTIN_TOOLS } from '../tools/builtin-tools';
import { ToolInvoker } from '../tools/tool-invoker.service';
import { Task } from '../common/types';
import { newId, nowIso } from '../common/util';

/** Full orchestration stack on in-memory adapters. */
export function orchestratorHarness(provider?: LlmProvider) {
  const g = gatewayHarness(provider);
  const memory = new InMemorySharedMemory();
  const tools = new ToolInvoker(g.store, new StrategyRegistry('tool', BUILTIN_TOOLS));
  const runtime = new JournalRuntime(g.store);
  const dispatcher = new Dispatcher(g.store, new StrategyRegistry('agent', DEFAULT_AGENTS), g.gateway, tools, memory, g.bus, loops().dispatch);
  const context = new ContextStore(g.store, g.bus);
  const orchestrator = new Orchestrator(g.store, runtime, new Planner(g.gateway), dispatcher, context, memory, g.bus);

  const createTask = async (patch: Partial<Task> = {}) => {
    const now = nowIso();
    const { task } = await g.store.createTask({
      id: newId(), title: 'Endpoint de pedidos', status: 'queued', budgetUsd: 1, spentUsd: 0,
      description: 'Pesquisar o padrão atual. Implementar o controller. Implementar o repositório. Escrever testes de integração',
      requiresApproval: false, correctionRounds: 0, result: null, error: null, createdAt: now, updatedAt: now, ...patch,
    }, null);
    return task;
  };
  return { ...g, memory, tools, runtime, dispatcher, context, orchestrator, createTask };
}
