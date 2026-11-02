import { AgentResult, AgentStrategy } from '../agents/agent-strategy';
import { API_VERSION, nowIso } from '../common/util';
import { HealthController } from '../health/health.controller';
import { loops } from '../orchestration/loops';
import { StrategyRegistry } from '../strategy/strategy-registry';
import { Dispatcher } from '../orchestration/dispatcher';
import { orchestratorHarness } from '../test-utils/harness';
import { MemoryStore } from '../persistence/memory.store';
import { Store } from '../persistence/store.port';
import { JsonLogger } from './json-logger';
import { currentLogContext, withLogContext } from './log-context';
import { MetricsRegistry } from './metrics';
import { openApiEnabled } from './openapi';

describe('MetricsRegistry', () => {
  it('renders counters, histograms and gauges in the Prometheus text format', () => {
    const m = new MetricsRegistry();
    m.inc('jpo_gateway_calls_total', { model: 'mock-fast', cached: 'false' });
    m.inc('jpo_gateway_calls_total', { model: 'mock-fast', cached: 'false' });
    m.observe('jpo_gateway_call_duration_seconds', 0.02, { model: 'mock-fast' });
    const text = m.render([{ name: 'jpo_tasks', help: 'Tarefas', series: [{ labels: { status: 'completed' }, value: 3 }] }]);
    expect(text).toContain('# TYPE jpo_gateway_calls_total counter');
    expect(text).toContain('jpo_gateway_calls_total{cached="false",model="mock-fast"} 2');
    expect(text).toContain('jpo_gateway_call_duration_seconds_bucket{model="mock-fast",le="0.025"} 1');
    expect(text).toContain('jpo_gateway_call_duration_seconds_bucket{model="mock-fast",le="0.01"} 0');
    expect(text).toContain('jpo_gateway_call_duration_seconds_count{model="mock-fast"} 1');
    expect(text).toContain('# TYPE jpo_tasks gauge');
    expect(text).toContain('jpo_tasks{status="completed"} 3');
    expect(m.value('jpo_gateway_calls_total', { cached: 'false', model: 'mock-fast' })).toBe(2);
  });

  it('escapes label values', () => {
    const m = new MetricsRegistry();
    m.inc('x_total', { v: 'a"b\\c\nd' });
    expect(m.render()).toContain('x_total{v="a\\"b\\\\c\\nd"} 1');
  });
});

describe('JsonLogger', () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    return { lines, logger: new JsonLogger((line) => lines.push(JSON.parse(line))) };
  };

  it('writes one JSON object per line with the taskId of the current context', async () => {
    const { lines, logger } = capture();
    await withLogContext({ taskId: 't-1' }, async () => {
      await Promise.resolve();
      logger.warn('subagente lento', 'Dispatcher');
    });
    logger.log('fora de contexto', 'Bootstrap');
    expect(lines[0]).toMatchObject({ level: 'warn', context: 'Dispatcher', msg: 'subagente lento', taskId: 't-1' });
    expect(typeof lines[0].ts).toBe('string');
    expect(lines[1]).toMatchObject({ level: 'info', context: 'Bootstrap', msg: 'fora de contexto' });
    expect(lines[1].taskId).toBeUndefined();
  });

  it('lines written by a subagent carry its subtaskId next to the taskId', async () => {
    const { lines, logger } = capture();
    const h = orchestratorHarness();
    const task = await h.createTask();
    const probe: AgentStrategy = {
      key: 'coder', tier: 'cheap',
      run: async (): Promise<AgentResult> => {
        await Promise.resolve();
        logger.log('gerando código', 'Coder');
        return { output: 'ok', model: 'm', artifacts: [] };
      },
    };
    const dispatcher = new Dispatcher(h.store, new StrategyRegistry('agent', [probe]), h.gateway, h.tools, h.memory, h.bus, loops().dispatch);
    const subtasks = ['s-a', 's-b'].map((id, i) => ({ id, taskId: task.id, agent: 'coder' as const, title: id, status: 'pending' as const,
      model: null, output: null, attempt: 1, position: i, startedAt: null, finishedAt: nowIso() }));
    await h.store.saveSubtasks(subtasks);
    await withLogContext({ taskId: task.id }, () => dispatcher.dispatch(task, subtasks, { attempt: 1, feedback: null }));
    expect(lines.map((l) => [l.taskId, l.subtaskId]).sort()).toEqual([[task.id, 's-a'], [task.id, 's-b']]);
    expect(currentLogContext().subtaskId).toBeUndefined();
  });

  it('falls back to the task id in the message and keeps the stack of errors', () => {
    const { lines, logger } = capture();
    logger.error('Tarefa 0f8c2a9e-1b2c-4d5e-8f90-123456789abc: boom', 'Error: boom\n at x', 'Orchestrator');
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Orchestrator', taskId: '0f8c2a9e-1b2c-4d5e-8f90-123456789abc', stack: 'Error: boom\n at x' });
  });

  it('merges structured messages', () => {
    const { lines, logger } = capture();
    withLogContext({ requestId: 'r1' }, () => logger.log({ msg: 'GET /tasks 200', status: 200, ms: 3 }, 'HTTP'));
    expect(lines[0]).toMatchObject({ msg: 'GET /tasks 200', status: 200, ms: 3, requestId: 'r1', context: 'HTTP' });
    logger.log({ msg: 'x', level: 'debug', context: 'forjado', ts: 'ontem' }, 'HTTP');
    expect(lines[1]).toMatchObject({ level: 'info', context: 'HTTP' });
    expect(lines[1].ts).not.toBe('ontem');
  });
});

describe('HealthController', () => {
  const pgDown = Object.assign(new MemoryStore(), { kind: 'postgres', ping: async () => false }) as unknown as Store;
  const pgUp = Object.assign(new MemoryStore(), { kind: 'postgres', ping: async () => true }) as unknown as Store;
  const res = () => ({ code: 200, status(c: number) { this.code = c; } });
  const redis = (ok: boolean) => ({ ping: async () => { if (!ok) throw new Error('ECONNREFUSED'); return 'PONG'; } }) as never;

  it('memory mode is ready and reported as memory, not as down', async () => {
    const h = new HealthController(new MemoryStore(), null);
    const r = res();
    expect(await h.ready(r)).toEqual({ ready: true, services: { postgres: 'memory', redis: 'memory' }, mode: 'in-memory' });
    expect(r.code).toBe(200);
    expect(await h.health()).toMatchObject({
      ok: true, postgres: false, redis: false, services: { postgres: 'memory', redis: 'memory' }, store: 'memory', mode: 'in-memory', version: API_VERSION,
    });
  });

  it('readiness answers 503 when a configured Postgres or Redis is down; liveness stays ok', async () => {
    for (const [store, rd, expected] of [
      [pgDown, null, { postgres: 'down', redis: 'memory' }],
      [pgUp, redis(false), { postgres: 'up', redis: 'down' }],
    ] as const) {
      const h = new HealthController(store, rd);
      const r = res();
      expect(await h.ready(r)).toEqual({ ready: false, services: expected, mode: rd ? 'persistent' : 'mixed' });
      expect(r.code).toBe(503);
      expect((await h.health()).ok).toBe(true);
    }
    const r = res();
    expect(await new HealthController(pgUp, redis(true)).ready(r)).toEqual({ ready: true, services: { postgres: 'up', redis: 'up' }, mode: 'persistent' });
    expect(r.code).toBe(200);
  });
});

describe('openApiEnabled', () => {
  it('is on outside production, off in production unless OPENAPI=on, and OPENAPI=off always wins', () => {
    expect(openApiEnabled({})).toBe(true);
    expect(openApiEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(openApiEnabled({ NODE_ENV: 'production', OPENAPI: 'on' })).toBe(true);
    expect(openApiEnabled({ OPENAPI: 'off' })).toBe(false);
  });
});
