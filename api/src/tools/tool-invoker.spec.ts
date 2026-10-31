import { MemoryStore } from '../persistence/memory.store';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { BUILTIN_TOOLS } from './builtin-tools';
import { ToolInvoker } from './tool-invoker.service';

describe('ToolInvoker', () => {
  const setup = () => {
    const store = new MemoryStore();
    return { store, invoker: new ToolInvoker(store, new StrategyRegistry('tool', BUILTIN_TOOLS)) };
  };
  const inv = { taskId: 't1', subtaskId: 's1', tool: 'write_artifact', args: { path: 'a.ts', content: 'x' } };

  it('executes once per idempotency key and writes one outbox event', async () => {
    const { store, invoker } = setup();
    const first = await invoker.invoke(inv);
    const second = await invoker.invoke({ ...inv, args: { content: 'x', path: 'a.ts' } });
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(invoker.executions).toBe(1);
    const outbox = await store.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].type).toBe('tool.executed');
  });

  it('honors an explicit Idempotency-Key', async () => {
    const { invoker } = setup();
    await invoker.invoke({ ...inv, idempotencyKey: 'k1' });
    const again = await invoker.invoke({ ...inv, args: { path: 'b.ts' }, idempotencyKey: 'k1' });
    expect(again.replay).toBe(true);
    expect(again.result.path).toBe('a.ts');
  });
});
