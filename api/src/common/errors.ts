import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Expected failure whose message is written for the user (timeout, budget, review,
 * model outage). Only these messages reach task.error, the SSE stream and webhooks.
 */
export class DomainError extends Error {}

/** The reviewer still rejected after the last correction round. Resuming cannot change that. */
export class ReviewRejectedError extends DomainError {
  constructor(rounds: number, feedback: string | undefined) {
    super(`Revisão reprovada após ${rounds} rodadas de correção: ${feedback ?? 'sem detalhe'}`);
  }
}

const log = new Logger('Errors');

/**
 * Message safe to show and to send out: the domain message, or a generic one with a
 * correlation id. The internal detail (driver errors, hosts, stack) only goes to the log.
 */
export function publicMessage(err: unknown, context: string): string {
  if (err instanceof DomainError) return err.message;
  const ref = randomUUID().slice(0, 8);
  const e = err instanceof Error ? err : new Error(String(err));
  log.error(`[ref ${ref}] ${context}: ${e.message}`, e.stack);
  return `Erro interno (ref ${ref}). Consulte o log da API.`;
}
