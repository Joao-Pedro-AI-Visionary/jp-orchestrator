import { EventBus } from '../events/event-bus';
import { MemoryStore } from '../persistence/memory.store';
import { ContextStore } from './context-store.service';
import { InMemorySharedMemory } from './shared-memory';

describe('ContextStore', () => {
  it('versions snapshots as a hash chain and detects tampering', async () => {
    const store = new MemoryStore();
    const ctx = new ContextStore(store, new EventBus());
    const v1 = await ctx.commit('t1', 'plan', { steps: 2 });
    const v2 = await ctx.commit('t1', 'dispatch', { steps: 2, done: 1 });

    expect(v1.version).toBe(1);
    expect(v1.parentHash).toBeNull();
    expect(v2.version).toBe(2);
    expect(v2.parentHash).toBe(v1.hash);
    expect(await ctx.verifyChain('t1')).toBe(true);

    // same content in a different key order hashes the same (canonical JSON)
    expect(ContextStore.hashOf(null, { a: 1, b: 2 })).toBe(ContextStore.hashOf(null, { b: 2, a: 1 }));

    (await store.listSnapshots('t1'))[0].content.steps = 99;
    const tampered = new MemoryStore();
    for (const s of [{ ...v1, content: { steps: 99 } }, v2]) await tampered.addSnapshot(s);
    expect(await new ContextStore(tampered, new EventBus()).verifyChain('t1')).toBe(false);
  });
});

describe('InMemorySharedMemory', () => {
  it('isolates entries per task', async () => {
    const mem = new InMemorySharedMemory();
    await mem.write('t1', 'finding', 'use pg', 'researcher');
    await mem.write('t2', 'finding', 'other', 'researcher');
    expect((await mem.read('t1', 'finding'))?.value).toBe('use pg');
    expect(await mem.list('t1')).toHaveLength(1);
  });
});
