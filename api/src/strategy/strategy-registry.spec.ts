import { StrategyRegistry, UnknownStrategyError } from './strategy-registry';

describe('StrategyRegistry', () => {
  const a = { key: 'a', run: () => 1 };
  const b = { key: 'b', run: () => 2 };

  it('resolves a strategy by key', () => {
    const reg = new StrategyRegistry('agent', [a, b]);
    expect(reg.resolve('b').run()).toBe(2);
    expect(reg.keys()).toEqual(['a', 'b']);
  });

  it('fails loudly on unknown keys', () => {
    const reg = new StrategyRegistry('agent', [a]);
    expect(() => reg.resolve('x')).toThrow(UnknownStrategyError);
  });

  it('rejects duplicated keys', () => {
    expect(() => new StrategyRegistry('agent', [a, { ...a }])).toThrow(/duplicada/);
  });
});
