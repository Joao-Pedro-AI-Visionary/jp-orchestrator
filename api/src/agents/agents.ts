import { AgentContext, AgentResult, AgentStrategy, call, promptFor } from './agent-strategy';

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
export const TESTS_MARKER = 'testes cobertos';

/** Gathers context and publishes findings to shared memory for the other subagents. */
export class ResearcherAgent implements AgentStrategy {
  readonly key = 'researcher' as const;
  readonly tier = 'cheap' as const;

  async run(ctx: AgentContext): Promise<AgentResult> {
    const res = await call(ctx, this, promptFor(ctx));
    ctx.signal?.throwIfAborted();
    const { result } = await ctx.tools.invoke({ taskId: ctx.task.id, subtaskId: ctx.subtask.id, tool: 'search_docs', args: { query: ctx.task.title } });
    const finding = `Referências: ${(result.hits as string[]).join(', ')}`;
    ctx.signal?.throwIfAborted();
    await ctx.memory.write(ctx.task.id, `research:${ctx.subtask.position}`, finding, this.key);
    return { output: `${res.text} ${finding}`, model: res.model, artifacts: [] };
  }
}

/**
 * Writes code using research from shared memory. On a task describing a bug,
 * the first attempt forgets the regression test, which exercises the
 * reviewer correction loop deterministically.
 */
export class CoderAgent implements AgentStrategy {
  readonly key = 'coder' as const;
  readonly tier = 'balanced' as const;

  async run(ctx: AgentContext): Promise<AgentResult> {
    const research = (await ctx.memory.list(ctx.task.id)).filter((e) => e.key.startsWith('research:')).map((e) => e.value);
    const res = await call(ctx, this, promptFor(ctx, research.map((r) => `CONTEXTO: ${r}`)));
    const missesTest = /\bbug\b/i.test(`${ctx.task.title} ${ctx.task.description}`) && ctx.attempt === 1;
    const note = missesTest ? 'correção aplicada' : `correção aplicada, ${TESTS_MARKER}`;
    const path = `src/${slug(ctx.subtask.title)}.ts`;
    ctx.signal?.throwIfAborted();
    await ctx.tools.invoke({
      taskId: ctx.task.id, subtaskId: ctx.subtask.id, tool: 'write_artifact',
      args: { path, content: `// ${ctx.subtask.title}\n// tentativa ${ctx.attempt}\n` },
    });
    ctx.signal?.throwIfAborted();
    await ctx.memory.write(ctx.task.id, `code:${ctx.subtask.position}`, `${path}: ${note}`, this.key);
    return { output: `${res.text} ${note}.`, model: res.model, artifacts: [path] };
  }
}

export class TesterAgent implements AgentStrategy {
  readonly key = 'tester' as const;
  readonly tier = 'cheap' as const;

  async run(ctx: AgentContext): Promise<AgentResult> {
    const res = await call(ctx, this, promptFor(ctx));
    const suite = `test/${slug(ctx.subtask.title)}.spec.ts`;
    ctx.signal?.throwIfAborted();
    const { result } = await ctx.tools.invoke({ taskId: ctx.task.id, subtaskId: ctx.subtask.id, tool: 'run_tests', args: { suite } });
    const summary = `${result.passed}/${result.total} testes passaram em ${suite}`;
    ctx.signal?.throwIfAborted();
    await ctx.memory.write(ctx.task.id, `tests:${ctx.subtask.position}`, summary, this.key);
    return { output: `${res.text} ${summary}.`, model: res.model, artifacts: [suite] };
  }
}

/**
 * Reviews code entries in shared memory; rejects when a change lacks tests. No
 * evidence is a rejection too: with no code entry, or without the entry of a coder
 * subtask of the plan (memory lost on a restart, expired or deleted), it never approves.
 */
export class ReviewerAgent implements AgentStrategy {
  readonly key = 'reviewer' as const;
  readonly tier = 'balanced' as const;

  async run(ctx: AgentContext): Promise<AgentResult> {
    const code = (await ctx.memory.list(ctx.task.id)).filter((e) => e.key.startsWith('code:'));
    const res = await call(ctx, this, promptFor(ctx, code.map((c) => `CODIGO: ${c.value}`)));
    const absent = (ctx.team ?? []).filter((s) => s.agent === 'coder' && !code.some((c) => c.key === `code:${s.position}`));
    const missing = code.filter((c) => !c.value.includes(TESTS_MARKER));
    const noEvidence = code.length === 0 || absent.length > 0;
    const approved = !noEvidence && missing.length === 0;
    const feedback = approved ? 'Aprovado: mudanças com testes.'
      : noEvidence ? `Reprovado: sem evidência do código${absent.length ? ` de ${absent.map((s) => s.title).join(', ')}` : ''} na memória compartilhada.`
        : `Reprovado: falta teste de regressão em ${missing.map((m) => m.value.split(':')[0]).join(', ')}.`;
    ctx.signal?.throwIfAborted();
    await ctx.memory.write(ctx.task.id, `review:${ctx.attempt}`, feedback, this.key);
    return { output: `${res.text} ${feedback}`, model: res.model, artifacts: [], verdict: { approved, feedback } };
  }
}

export const DEFAULT_AGENTS: AgentStrategy[] = [new ResearcherAgent(), new CoderAgent(), new TesterAgent(), new ReviewerAgent()];
