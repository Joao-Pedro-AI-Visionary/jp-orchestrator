#!/usr/bin/env node
// Dispara um loop real de orquestração contra a API e acompanha até o estado final.
// Uso: node scripts/run-loop.mjs [--api http://localhost:3001] [--approve]
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const api = arg('api', process.env.API_URL ?? 'http://localhost:3001');
const approve = process.argv.includes('--approve');
const post = (path, body, headers = {}) => fetch(`${api}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
}).then((r) => r.json());

const task = await post('/tasks', {
  title: 'Endpoint REST de pedidos',
  description: 'Pesquisar o padrão atual. Implementar o controller. Implementar o repositório. Escrever testes de integração',
  budgetUsd: 0.05,
  requiresApproval: approve,
}, { 'Idempotency-Key': `run-loop-${Date.now()}` });
console.log(`Tarefa ${task.id} criada`);

let peak = 0;
const deadline = Date.now() + 120_000;
for (;;) {
  const d = await fetch(`${api}/tasks/${task.id}`).then((r) => r.json());
  const running = d.subtasks.filter((s) => s.status === 'running').length;
  peak = Math.max(peak, running);
  process.stdout.write(`\r${d.task.status.padEnd(18)} subagentes rodando: ${running}  gasto: $${d.task.spentUsd.toFixed(6)}   `);
  if (d.task.status === 'awaiting_approval' && approve) {
    await post(`/tasks/${task.id}/approve`, { note: 'aprovado pelo run-loop' });
  }
  if (['completed', 'failed', 'rejected', 'budget_exceeded'].includes(d.task.status)) {
    console.log(`\nEstado final: ${d.task.status}. Pico de subagentes em paralelo: ${peak}. Snapshots: ${d.snapshots.length}.`);
    process.exit(d.task.status === 'completed' && peak >= 2 ? 0 : 1);
  }
  if (Date.now() > deadline) { console.log('\nTimeout'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 150));
}
