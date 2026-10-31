import { Module } from '@nestjs/common';
import { AgentStrategy } from '../agents/agent-strategy';
import { DEFAULT_AGENTS } from '../agents/agents';
import { ApprovalService } from '../approval/approval.service';
import { AGENT_REGISTRY, DURABLE_RUNTIME, SHARED_MEMORY, STORE, TOOL_REGISTRY } from '../common/tokens';
import { DurableRuntime } from '../durable/durable-runtime';
import { JournalRuntime } from '../durable/journal.runtime';
import { EventBus } from '../events/event-bus';
import { GatewayModule } from '../gateway/gateway.module';
import { GatewayService } from '../gateway/gateway.service';
import { ContextStore } from '../memory/context-store.service';
import { SharedMemory } from '../memory/shared-memory';
import { Store } from '../persistence/store.port';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { BUILTIN_TOOLS } from '../tools/builtin-tools';
import { ToolInvoker } from '../tools/tool-invoker.service';
import { Dispatcher } from './dispatcher';
import { loops } from './loops';
import { Orchestrator } from './orchestrator.service';
import { Planner } from './planner';
import { TasksController } from './tasks.controller';

@Module({
  imports: [GatewayModule],
  controllers: [TasksController],
  providers: [
    ApprovalService,
    ContextStore,
    ToolInvoker,
    { provide: TOOL_REGISTRY, useFactory: () => new StrategyRegistry('tool', BUILTIN_TOOLS) },
    { provide: AGENT_REGISTRY, useFactory: () => new StrategyRegistry<AgentStrategy>('agent', DEFAULT_AGENTS) },
    { provide: DURABLE_RUNTIME, inject: [STORE], useFactory: (store: Store) => new JournalRuntime(store) },
    { provide: Planner, inject: [GatewayService], useFactory: (g: GatewayService) => new Planner(g) },
    {
      provide: Dispatcher,
      inject: [STORE, AGENT_REGISTRY, GatewayService, ToolInvoker, SHARED_MEMORY, EventBus],
      useFactory: (store: Store, agents: StrategyRegistry<AgentStrategy>, g: GatewayService, tools: ToolInvoker, mem: SharedMemory, bus: EventBus) =>
        new Dispatcher(store, agents, g, tools, mem, bus, loops().dispatch),
    },
    {
      provide: Orchestrator,
      inject: [STORE, DURABLE_RUNTIME, Planner, Dispatcher, ContextStore, SHARED_MEMORY, EventBus],
      useFactory: (store: Store, rt: DurableRuntime, p: Planner, d: Dispatcher, c: ContextStore, m: SharedMemory, bus: EventBus) =>
        new Orchestrator(store, rt, p, d, c, m, bus),
    },
  ],
  exports: [Orchestrator],
})
export class OrchestrationModule {}
