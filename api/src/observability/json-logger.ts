import { LoggerService } from '@nestjs/common';
import { currentLogContext } from './log-context';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'fatal';
const TASK_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * One JSON object per line on stdout (stderr for errors): ts, level, context, msg plus the
 * correlation fields of the current log context (taskId, subtaskId, requestId, principal). When no
 * context carries a taskId, the first UUID in the message is used ("Tarefa <id>: ...").
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string, level: Level) => void = (line, level) => {
    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
  }) {}

  log(message: unknown, ...rest: unknown[]) { this.emit('info', message, rest); }
  error(message: unknown, ...rest: unknown[]) { this.emit('error', message, rest); }
  warn(message: unknown, ...rest: unknown[]) { this.emit('warn', message, rest); }
  debug(message: unknown, ...rest: unknown[]) { this.emit('debug', message, rest); }
  verbose(message: unknown, ...rest: unknown[]) { this.emit('verbose', message, rest); }
  fatal(message: unknown, ...rest: unknown[]) { this.emit('fatal', message, rest); }

  private emit(level: Level, message: unknown, rest: unknown[]) {
    // Nest passes (message, context) or, for errors, (message, stack, context).
    const context = typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    const stack = level === 'error' && rest.length > 1 && typeof rest[0] === 'string' ? rest[0] : undefined;
    const entry: Record<string, unknown> = {};
    if (message instanceof Error) {
      entry.msg = message.message;
      entry.stack = message.stack;
    } else if (typeof message === 'object' && message !== null) {
      Object.assign(entry, message);
    } else {
      entry.msg = String(message);
    }
    // Fixed fields last: a structured message cannot overwrite ts, level or context.
    Object.assign(entry, { ts: new Date().toISOString(), level, context });
    if (stack) entry.stack = stack;
    const ctx = currentLogContext();
    const taskId = ctx.taskId ?? (typeof entry.msg === 'string' ? entry.msg.match(TASK_ID)?.[0] : undefined);
    Object.assign(entry, { ...ctx, ...(taskId ? { taskId } : {}) });
    this.write(JSON.stringify(entry), level);
  }
}
