/**
 * Strategy pattern core, same shape used in strategy-pattern-checkout:
 * every strategy exposes a key, and a registry per axis resolves the key from
 * the request. Adding a new behavior means adding a class, never an if/else.
 */
export interface KeyedStrategy {
  readonly key: string;
}

export class UnknownStrategyError extends Error {
  constructor(axis: string, key: string, known: string[]) {
    super(`Estratégia desconhecida para ${axis}: "${key}". Disponíveis: ${known.join(', ')}`);
  }
}

export class StrategyRegistry<T extends KeyedStrategy> {
  private readonly byKey = new Map<string, T>();

  constructor(readonly axis: string, strategies: T[]) {
    for (const s of strategies) {
      if (this.byKey.has(s.key)) throw new Error(`Chave duplicada em ${axis}: ${s.key}`);
      this.byKey.set(s.key, s);
    }
  }

  resolve(key: string): T {
    const found = this.byKey.get(key);
    if (!found) throw new UnknownStrategyError(this.axis, key, this.keys());
    return found;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }
}
