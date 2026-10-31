import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { nowIso } from '../common/util';

export interface LiveEvent {
  type: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

/** In-process live event stream feeding the dashboard over SSE. Not durable by design: the outbox is. */
@Injectable()
export class EventBus {
  private readonly subject = new Subject<LiveEvent>();
  readonly history: LiveEvent[] = [];

  emit(type: string, taskId: string | null, payload: Record<string, unknown> = {}): void {
    const ev = { type, taskId, payload, at: nowIso() };
    this.history.push(ev);
    if (this.history.length > 500) this.history.shift();
    this.subject.next(ev);
  }

  stream(): Observable<LiveEvent> {
    return this.subject.asObservable();
  }
}
