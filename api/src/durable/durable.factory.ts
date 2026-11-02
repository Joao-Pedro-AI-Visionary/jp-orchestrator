import { Logger } from '@nestjs/common';
import { Store } from '../persistence/store.port';
import { DurableConfig, durableConfig } from './durable.config';
import { AnyDurableRuntime } from './durable-runtime';
import { JournalRuntime } from './journal.runtime';
import { RestateRuntime } from './restate.runtime';

/** Builds the runtime selected by DURABLE_RUNTIME. Throws DurableConfigError when misconfigured (boot fails). */
export function createDurableRuntime(store: Store, cfg: DurableConfig = durableConfig()): AnyDurableRuntime {
  if (cfg.runtime === 'journal') return new JournalRuntime(store);
  if (store.kind === 'memory') {
    // Restate keeps the execution, but the task rows would vanish on restart and the replay would find nothing.
    Logger.warn('DURABLE_RUNTIME=restate com store em memória: tarefas somem no restart; use DATABASE_URL fora de dev', 'DurableRuntime');
  }
  return new RestateRuntime(cfg.restate);
}
