#!/usr/bin/env node
// Relatório de consumo: tokens e custo por modelo, subagente e tarefa.
// Requer API_KEY no ambiente (a mesma da API).
// Uso: node scripts/billing-report.mjs [--api http://localhost:3001] [--out reports/billing.md]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const api = arg('api', process.env.API_URL ?? 'http://localhost:3001');
const out = arg('out', `reports/billing-${new Date().toISOString().slice(0, 10)}.md`);

const res = await fetch(`${api}/billing/summary`, { headers: { 'x-api-key': process.env.API_KEY ?? '' } });
if (!res.ok) {
  console.error(`Falha ao ler ${api}/billing/summary: HTTP ${res.status}`);
  process.exit(1);
}
const s = await res.json();
const usd = (n) => `$${Number(n).toFixed(6)}`;
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const md = [
  '# Relatório de billing JP Orchestrator',
  '',
  `Gerado em ${new Date().toISOString()} a partir de ${api}`,
  '',
  `Total: ${usd(s.totals.costUsd)} em ${s.totals.calls} chamadas, ${s.totals.tokens} tokens.`,
  `Cache: ${s.totals.cacheHits} acertos, economia de ${usd(s.totals.savedUsd)}.`,
  '',
  '## Por modelo',
  table(['Modelo', 'Chamadas', 'Tokens', 'Custo'], s.byModel.map((m) => [m.model, m.calls, m.tokens, usd(m.costUsd)])),
  '',
  '## Por subagente',
  table(['Subagente', 'Chamadas', 'Tokens', 'Custo'], s.byAgent.map((a) => [a.agent, a.calls, a.tokens, usd(a.costUsd)])),
  '',
  '## Por tarefa',
  table(['Tarefa', 'Status', 'Tokens', 'Custo', 'Orçamento', 'Uso'], s.byTask.map((t) => [
    t.title, t.status, t.tokens, usd(t.costUsd), usd(t.budgetUsd), `${((t.costUsd / t.budgetUsd) * 100).toFixed(1)}%`,
  ])),
  '',
].join('\n');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md);
console.log(md);
console.log(`Relatório salvo em ${out}`);
