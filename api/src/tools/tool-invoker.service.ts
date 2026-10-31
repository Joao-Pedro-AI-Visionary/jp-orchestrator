import { Inject, Injectable } from '@nestjs/common';
import { OutboxEvent, ToolCall } from '../common/types';
import { STORE, TOOL_REGISTRY } from '../common/tokens';
import { canonicalJson, newId, nowIso, sha256 } from '../common/util';
import { Store } from '../persistence/store.port';
import { KeyedStrategy, StrategyRegistry } from '../strategy/strategy-registry';

/** A tool a subagent can call. Implementations must be pure functions of args (side effects go to the outbox). */
export interface ToolHandler extends KeyedStrategy {
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolInvocation {
  taskId: string;
  subtaskId: string | null;
  tool: string;
  args: Record<string, unknown>;
  /** Optional explicit key; default is a hash of (task, subtask, tool, args). */
  idempotencyKey?: string;
}

export const outboxEvent = (type: string, payload: Record<string, unknown>): OutboxEvent => ({
  id: newId(), type, payload, status: 'pending', attempts: 0,
  nextAttemptAt: nowIso(), createdAt: nowIso(), deliveredAt: null, lastError: null,
});

/**
 * Idempotency-Key + transactional outbox for tool calls.
 * A retried step (crash, resume, correction) with the same key returns the
 * stored result and never executes the tool twice. The side-effect event is
 * written in the same transaction as the result, and the relay delivers it.
 */
@Injectable()
export class ToolInvoker {
  executions = 0;

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(TOOL_REGISTRY) private readonly tools: StrategyRegistry<ToolHandler>,
  ) {}

  static keyFor(inv: ToolInvocation): string {
    return inv.idempotencyKey ?? sha256(canonicalJson([inv.taskId, inv.subtaskId, inv.tool, inv.args]));
  }

  async invoke(inv: ToolInvocation): Promise<{ result: Record<string, unknown>; replay: boolean; key: string }> {
    const key = ToolInvoker.keyFor(inv);
    const existing = await this.store.findToolCall(key);
    if (existing) return { result: existing.result, replay: true, key };

    const handler = this.tools.resolve(inv.tool);
    this.executions++;
    const result = await handler.execute(inv.args);
    const call: ToolCall = {
      idempotencyKey: key, taskId: inv.taskId, subtaskId: inv.subtaskId, tool: inv.tool,
      args: inv.args, result, createdAt: nowIso(),
    };
    const saved = await this.store.saveToolCallWithOutbox(
      call, outboxEvent('tool.executed', { taskId: inv.taskId, tool: inv.tool, idempotencyKey: key, result }),
    );
    return { result: saved.result, replay: saved.createdAt !== call.createdAt, key };
  }
}
