import { MemoryStore } from '../persistence/memory.store';
import { JournalRuntime } from './journal.runtime';
import { RestateRuntime } from './restate.runtime';

describe('JournalRuntime', () => {
  it('never re-executes a completed step after a crash', async () => {
    const store = new MemoryStore();
    const rt = new JournalRuntime(store);
    let calls = 0;
    const step = async () => ++calls;

    const ctx = rt.context('exec-1');
    expect(await ctx.run('a', step)).toBe(1);
    await expect(ctx.run('b', async () => { throw new Error('crash'); })).rejects.toThrow('crash');

    const resumed = rt.context('exec-1');
    expect(await resumed.run('a', step)).toBe(1);
    expect(await resumed.run('b', step)).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('RestateRuntime', () => {
  it('delegates to the bound Restate context and fails clearly when unbound', async () => {
    const rt = new RestateRuntime();
    expect(() => rt.context('x')).toThrow(/Restate não configurado/);
    rt.fromRestateContext('x', { run: (_n, fn) => fn() });
    expect(await rt.context('x').run('s', async () => 42)).toBe(42);
  });
});
