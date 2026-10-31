#!/usr/bin/env node
// Verifica consumo de orçamento por tarefa. Sai com código 1 se alguma tarefa
// passou do limite de alerta (padrão 80%) ou foi cortada por orçamento.
// Uso: node scripts/budget-check.mjs [--api http://localhost:3001] [--warn 0.8] [--max-total 1.00]
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const api = arg('api', process.env.API_URL ?? 'http://localhost:3001');
const warn = Number(arg('warn', '0.8'));
const maxTotal = arg('max-total', null);

const res = await fetch(`${api}/billing/summary`);
if (!res.ok) {
  console.error(`Falha ao ler ${api}/billing/summary: HTTP ${res.status}`);
  process.exit(2);
}
const s = await res.json();
const alerts = s.byTask.filter((t) => t.status === 'budget_exceeded' || t.costUsd / t.budgetUsd >= warn);

for (const t of s.byTask) {
  const pct = (t.costUsd / t.budgetUsd) * 100;
  const flag = t.status === 'budget_exceeded' ? 'CORTADA' : pct >= warn * 100 ? 'ALERTA' : 'ok';
  console.log(`${flag.padEnd(8)} ${pct.toFixed(1).padStart(6)}%  $${t.costUsd.toFixed(6)} / $${t.budgetUsd.toFixed(6)}  ${t.title}`);
}
let failed = alerts.length > 0;
if (maxTotal !== null && s.totals.costUsd > Number(maxTotal)) {
  console.log(`ALERTA total $${s.totals.costUsd.toFixed(6)} acima de $${Number(maxTotal).toFixed(6)}`);
  failed = true;
}
console.log(failed ? `${alerts.length} tarefa(s) acima de ${warn * 100}% do orçamento` : 'Todas as tarefas dentro do orçamento');
process.exit(failed ? 1 : 0);
