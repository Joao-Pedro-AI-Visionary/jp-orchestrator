import { MemoryStore } from '../persistence/memory.store';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { crashOn, ProcessCrash } from '../test-utils/crash';
import { BUILTIN_TOOLS } from './builtin-tools';
import { outboxEvent, ToolCallRefusedError, ToolContext, ToolHandler, ToolInvoker } from './tool-invoker.service';

/** Fake external API that honors Idempotency-Key, like a payment provider. */
class PaymentsApi {
  calls: string[] = [];
  charges = new Map<string, number>();
  charge(idempotencyKey: string, amount: number) {
    this.calls.push(idempotencyKey);
    if (!this.charges.has(idempotencyKey)) this.charges.set(idempotencyKey, amount);
    return { chargeId: `ch_${idempotencyKey.slice(0, 8)}`, amount: this.charges.get(idempotencyKey)! };
  }
}

class ChargeTool implements ToolHandler {
  readonly key = 'charge';
  contexts: Omit<ToolContext, 'signal'>[] = [];
  constructor(private readonly api: PaymentsApi) {}
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    this.contexts.push({ idempotencyKey: ctx.idempotencyKey, attempt: ctx.attempt });
    return this.api.charge(ctx.idempotencyKey, Number(args.amount));
  }
}

describe('ToolInvoker', () => {
  afterEach(() => jest.useRealTimers());

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
    expect(await store.findToolCall(first.key)).toMatchObject({ status: 'completed', attempts: 1, leaseUntil: null });
  });

  it('honors an explicit Idempotency-Key', async () => {
    const { invoker } = setup();
    await invoker.invoke({ ...inv, idempotencyKey: 'k1' });
    const again = await invoker.invoke({ ...inv, args: { path: 'b.ts' }, idempotencyKey: 'k1' });
    expect(again.replay).toBe(true);
    expect(again.result.path).toBe('a.ts');
  });

  it('persists a started row with a lease before the handler runs and passes the idempotency key to it', async () => {
    const store = new MemoryStore();
    const seen: { row: unknown; ctx: ToolContext }[] = [];
    const probe: ToolHandler = {
      key: 'probe',
      async execute(_args, ctx) {
        seen.push({ row: await store.findToolCall(ctx.idempotencyKey), ctx });
        return { ok: true };
      },
    };
    const invoker = new ToolInvoker(store, new StrategyRegistry('tool', [probe]));
    const { key } = await invoker.invoke({ taskId: 't1', subtaskId: null, tool: 'probe', args: {}, idempotencyKey: 'k-probe' });
    expect(key).toBe('k-probe');
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx).toMatchObject({ idempotencyKey: 'k-probe', attempt: 1 });
    expect(seen[0].ctx.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].row).toMatchObject({ status: 'started', result: null, attempts: 1 });
    expect((seen[0].row as { leaseUntil: string }).leaseUntil).toEqual(expect.any(String));
  });

  it('a clean failure releases the lease: the retry runs right away and does not consume an attempt', async () => {
    const store = new MemoryStore();
    let fail = true;
    const flaky: ToolHandler = {
      key: 'flaky',
      async execute(_args, ctx) {
        if (fail) { fail = false; throw new Error('upstream 503'); }
        return { attempt: ctx.attempt };
      },
    };
    const invoker = new ToolInvoker(store, new StrategyRegistry('tool', [flaky]));
    const call = { taskId: 't1', subtaskId: null, tool: 'flaky', args: {} };
    await expect(invoker.invoke(call)).rejects.toThrow('upstream 503');
    expect(await store.findToolCall(ToolInvoker.keyFor(call))).toMatchObject({ status: 'started', attempts: 1, leaseUntil: null, error: 'upstream 503' });
    expect((await invoker.invoke(call)).result).toEqual({ attempt: 1 });
    expect(await store.findToolCall(ToolInvoker.keyFor(call))).toMatchObject({ status: 'completed', attempts: 1 });
    expect(await store.listOutbox()).toHaveLength(1);
  });

  it('crash between the side effect and the commit: retry after the lease reconciles with the same key and the charge is applied once', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const db = new MemoryStore();
    const api = new PaymentsApi();
    const tool = new ChargeTool(api);
    const registry = new StrategyRegistry('tool', [tool]);
    const call = { taskId: 't1', subtaskId: 's1', tool: 'charge', args: { amount: 42 } };

    // Process A: the charge goes through, then the process dies before the result is committed.
    await expect(new ToolInvoker(crashOn(db, 'completeToolCallWithOutbox'), registry).invoke(call)).rejects.toBeInstanceOf(ProcessCrash);
    const key = ToolInvoker.keyFor(call);
    expect(api.charges.size).toBe(1);
    expect(await db.findToolCall(key)).toMatchObject({ status: 'started', attempts: 1, result: null });
    expect(await db.listOutbox()).toHaveLength(0);

    // Process B (e.g. boot resume) retries while A's lease is still live: it waits instead of failing the task,
    // and the handler does not run until the lease expires.
    const invokerB = new ToolInvoker(db, registry);
    const retry = invokerB.invoke(call);
    await jest.advanceTimersByTimeAsync(9_000);
    expect(api.calls).toHaveLength(1);

    // Lease expires: B takes over and re-runs the handler with the same idempotency key.
    await jest.advanceTimersByTimeAsync(1_100);
    const recovered = await retry;
    expect(recovered).toEqual({ result: { chargeId: `ch_${key.slice(0, 8)}`, amount: 42 }, replay: false, key });
    expect(tool.contexts).toEqual([{ idempotencyKey: key, attempt: 1 }, { idempotencyKey: key, attempt: 2 }]);
    expect(api.calls).toEqual([key, key]);
    expect(api.charges.size).toBe(1);
    expect(await db.findToolCall(key)).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await db.listOutbox()).toHaveLength(1);

    // Any later retry is a pure replay.
    expect((await new ToolInvoker(db, registry).invoke(call)).replay).toBe(true);
    expect(api.calls).toHaveLength(2);
  });

  it('caps lease takeovers at TOOL_MAX_ATTEMPTS, then the call is terminal failed and refused at once', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const db = new MemoryStore();
    const tool = new ChargeTool(new PaymentsApi());
    const registry = new StrategyRegistry('tool', [tool]);
    const call = { taskId: 't1', subtaskId: 's1', tool: 'charge', args: { amount: 42 } };

    // Three processes each crash after the effect: attempts 1, 2 and 3 all run the handler.
    for (let i = 0; i < 3; i++) {
      await expect(new ToolInvoker(crashOn(db, 'completeToolCallWithOutbox'), registry).invoke(call)).rejects.toBeInstanceOf(ProcessCrash);
      jest.setSystemTime(Date.now() + 10_001);
    }
    expect(tool.contexts.map((c) => c.attempt)).toEqual([1, 2, 3]);

    // The fourth takeover is refused before the handler runs.
    const refused = new ToolInvoker(db, registry).invoke(call);
    await expect(refused).rejects.toBeInstanceOf(ToolCallRefusedError);
    await expect(refused).rejects.toThrow(/TOOL_MAX_ATTEMPTS \(3\)/);
    expect(tool.contexts).toHaveLength(3);
    const key = ToolInvoker.keyFor(call);
    expect(await db.findToolCall(key)).toMatchObject({ status: 'failed', result: null, attempts: 4, leaseUntil: null, error: expect.stringMatching(/TOOL_MAX_ATTEMPTS/) });
    expect(await db.listOutbox()).toHaveLength(0);

    // Terminal: a later invoke (dispatcher retry, /resume) is refused without claiming or running anything.
    await expect(new ToolInvoker(db, registry).invoke(call)).rejects.toBeInstanceOf(ToolCallRefusedError);
    expect(tool.contexts).toHaveLength(3);
    expect((await db.findToolCall(key))!.attempts).toBe(4);
  });

  it('transient clean failures (2 dispatcher calls + a resume) never exhaust TOOL_MAX_ATTEMPTS', async () => {
    const store = new MemoryStore();
    let failures = 4;
    const flaky: ToolHandler = {
      key: 'flaky',
      async execute(_args, ctx) {
        if (failures-- > 0) throw new Error('upstream 503');
        return { attempt: ctx.attempt };
      },
    };
    const invoker = new ToolInvoker(store, new StrategyRegistry('tool', [flaky]));
    const call = { taskId: 't1', subtaskId: null, tool: 'flaky', args: {} };
    for (let i = 0; i < 4; i++) await expect(invoker.invoke(call)).rejects.toThrow('upstream 503');
    expect((await invoker.invoke(call)).result).toEqual({ attempt: 1 });
    expect(await store.findToolCall(ToolInvoker.keyFor(call))).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('an aborted caller stops the handler through ctx.signal and keeps the lease (effect uncertain)', async () => {
    const store = new MemoryStore();
    const seen: AbortSignal[] = [];
    const slow: ToolHandler = {
      key: 'slow',
      execute: (_args, ctx) => new Promise((_, reject) => {
        seen.push(ctx.signal);
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
      }),
    };
    const invoker = new ToolInvoker(store, new StrategyRegistry('tool', [slow]));
    const ac = new AbortController();
    const call = invoker.invoke({ taskId: 't1', subtaskId: null, tool: 'slow', args: {}, idempotencyKey: 'k-slow' }, ac.signal);
    await new Promise((r) => setImmediate(r));
    ac.abort(new Error('tarefa cancelada'));
    await expect(call).rejects.toThrow('tarefa cancelada');
    expect(seen[0].aborted).toBe(true);
    const row = await store.findToolCall('k-slow');
    expect(row).toMatchObject({ status: 'started', attempts: 1 });
    expect(Date.parse(row!.leaseUntil!)).toBeGreaterThan(Date.now());
  });

  it('refuses to re-run a started call older than IDEMPOTENCY_KEY_TTL_MS', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const db = new MemoryStore();
    const tool = new ChargeTool(new PaymentsApi());
    const registry = new StrategyRegistry('tool', [tool]);
    const call = { taskId: 't1', subtaskId: 's1', tool: 'charge', args: { amount: 42 } };
    await expect(new ToolInvoker(crashOn(db, 'completeToolCallWithOutbox'), registry).invoke(call)).rejects.toBeInstanceOf(ProcessCrash);

    jest.setSystemTime(Date.now() + 86_400_001);
    await expect(new ToolInvoker(db, registry).invoke(call)).rejects.toThrow(/IDEMPOTENCY_KEY_TTL_MS \(86400000ms\)/);
    expect(tool.contexts).toHaveLength(1);
    expect(await db.listOutbox()).toHaveLength(0);
  });

  it('a handler slower than the lease times out and keeps its lease, so no other worker overlaps it', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const store = new MemoryStore();
    const hang: ToolHandler = { key: 'hang', execute: () => new Promise(() => undefined) };
    const invoker = new ToolInvoker(store, new StrategyRegistry('tool', [hang]));
    const call = invoker.invoke({ taskId: 't1', subtaskId: null, tool: 'hang', args: {}, idempotencyKey: 'k-hang' });
    const failed = expect(call).rejects.toThrow('ferramenta hang excedeu o timeout');
    await jest.advanceTimersByTimeAsync(10_000);
    await failed;
    const row = await store.findToolCall('k-hang');
    expect(row).toMatchObject({ status: 'started', attempts: 1 });
    expect(Date.parse(row!.leaseUntil!)).toBeLessThanOrEqual(Date.now());
  });

  it('crash takeover race: a stale attempt finishing after the takeover cannot commit a second result or event', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const db = new MemoryStore();
    const claim = { idempotencyKey: 'k', taskId: 't1', subtaskId: null, tool: 'x', args: {}, createdAt: new Date().toISOString() };
    const stale = await db.claimToolCall(claim, 1000);
    expect(await db.claimToolCall(claim, 1000)).toBeNull();
    jest.setSystemTime(Date.now() + 1001);
    const fresh = await db.claimToolCall(claim, 1000);
    expect(fresh?.attempts).toBe(2);

    await db.completeToolCallWithOutbox('k', fresh!.attempts, { by: 'fresh' }, outboxEvent('tool.executed', {}));
    const late = await db.completeToolCallWithOutbox('k', stale!.attempts, { by: 'stale' }, outboxEvent('tool.executed', {}));
    expect(late).toMatchObject({ status: 'completed', attempts: 2, result: { by: 'fresh' } });
    expect(await db.listOutbox()).toHaveLength(1);
  });
});
