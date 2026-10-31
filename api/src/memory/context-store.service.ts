import { Inject, Injectable } from '@nestjs/common';
import { Snapshot } from '../common/types';
import { STORE } from '../common/tokens';
import { canonicalJson, nowIso, sha256 } from '../common/util';
import { EventBus } from '../events/event-bus';
import { Store } from '../persistence/store.port';

/**
 * Versioned context per task. Each snapshot is append-only and chained:
 * hash = sha256(parentHash + canonical content), like a tiny git log.
 * Any tampering with an older snapshot breaks verifyChain().
 */
@Injectable()
export class ContextStore {
  constructor(@Inject(STORE) private readonly store: Store, private readonly bus: EventBus) {}

  static hashOf(parentHash: string | null, content: Record<string, unknown>): string {
    return sha256(`${parentHash ?? ''}\n${canonicalJson(content)}`);
  }

  async commit(taskId: string, label: string, content: Record<string, unknown>): Promise<Snapshot> {
    const history = await this.store.listSnapshots(taskId);
    const parent = history[history.length - 1] ?? null;
    const parentHash = parent?.hash ?? null;
    const snapshot: Snapshot = {
      taskId,
      version: (parent?.version ?? 0) + 1,
      hash: ContextStore.hashOf(parentHash, content),
      parentHash,
      label,
      content,
      createdAt: nowIso(),
    };
    await this.store.addSnapshot(snapshot);
    this.bus.emit('snapshot.created', taskId, { version: snapshot.version, hash: snapshot.hash, label });
    return snapshot;
  }

  history(taskId: string): Promise<Snapshot[]> {
    return this.store.listSnapshots(taskId);
  }

  async verifyChain(taskId: string): Promise<boolean> {
    let parent: string | null = null;
    for (const s of await this.store.listSnapshots(taskId)) {
      if (s.parentHash !== parent || ContextStore.hashOf(parent, s.content) !== s.hash) return false;
      parent = s.hash;
    }
    return true;
  }
}
