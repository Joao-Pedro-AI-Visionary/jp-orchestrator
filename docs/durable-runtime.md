# ADR: runtime de execução durável (`DURABLE_RUNTIME`)

- Status: aceito (v0.7.0, 2026-11-02)
- Escopo: `api/src/durable/`, `api/src/orchestration/orchestrator.service.ts`

## Contexto

O loop do orquestrador (plano → ondas de subagentes → revisão/correção → aprovação humana → merge) já era escrito
como passos nomeados (`ctx.run(nome, fn)`) sobre a porta `DurableRuntime`. A única implementação era o
`JournalRuntime`: os resultados vão para a tabela `step_journal`. Lease por tarefa com heartbeat, timeout em
processo e aprovação como "pausa e reexecução" ficam a cargo do próprio orquestrador. Faltava um runtime de execução
durável de verdade atrás da mesma porta, com:

1. passos que não reexecutam no replay (mesma semântica de `ctx.run`);
2. espera de aprovação por sinal (awakeable/promise/signal), sem a tarefa ocupar processo;
3. timer durável para o timeout da tarefa (sobrevive a restart);
4. um único dono por tarefa, garantido pelo próprio runtime;
5. cancelamento que chega como `AbortSignal` aos agentes, gateway e ferramentas;
6. NestJS no mesmo processo, sem reescrever o loop.

## Opções

| | Restate (`@restatedev/restate-sdk` 1.18.2) | Temporal (`@temporalio/*` 1.25.0) | Só o journal |
|---|---|---|---|
| Passos | `ctx.run(nome, fn)`: mesma forma da porta | Activities: o loop vira workflow (sandbox determinístico) + activities separadas | `step_journal` |
| Aprovação | Durable promise do workflow (`ctx.promise`) resolvida por handler compartilhado; pode ser resolvida antes de alguém esperar | Signal + `condition()` | Pausa, linha em `approvals`, reexecução |
| Timeout | `ctx.sleep` (journaled) em corrida com cada passo | Timer do workflow / `CancellationScope` | `setTimeout` em processo |
| Dono único | Um `run` por chave de workflow; submit duplicado responde `PreviouslyAccepted` | Workflow ID único | Lease com fencing token no Postgres |
| Cancelamento | `CancelledError` no `await`; `attemptCompletedSignal` por tentativa | Cancelamento de activity por heartbeat | `AbortController` do orquestrador |
| Encaixe no NestJS | Endpoint HTTP/2 no mesmo processo; o handler chama o `Orchestrator` com DI normal | Worker com bundle webpack + `@temporalio/core-bridge` nativo; código de workflow não pode usar DI nem I/O | já integrado |
| Dev local | Um binário (`@restatedev/restate-server`, no npm) ou uma imagem Docker | `temporal server start-dev` (CLI); `TestWorkflowEnvironment` baixa um binário de teste | nada |

Conferido no registro npm em 2026-11-02: `@temporalio/worker` 1.25.0 depende de `webpack`, `@swc/core` e
`@temporalio/core-bridge`.

## Decisão

**Restate.** A porta já foi desenhada com o formato do contexto do Restate (`ctx.run`). O loop roda sem mudar de
lugar: o handler `run` do workflow `TaskExecution` (chave = id da tarefa) chama `Orchestrator.execute()`, que
reaproveita o mesmo `loop()` do runtime journal. No Temporal, o loop teria que virar código de workflow
determinístico, num sandbox sem DI e sem acesso ao store, e cada leitura e escrita teria que virar activity. Isso dá
uma segunda implementação do orquestrador, não um adaptador. Ele ainda traz bundle webpack e binário nativo no worker.

O `temporal` continua como valor reconhecido de `DURABLE_RUNTIME`, mas o boot falha com mensagem clara: foi avaliado
e não foi implementado.

### Mapeamento

| Porta / orquestrador | Restate |
|---|---|
| `ctx.run(nome, fn)` | `ctx.run(nome, fn)` memoizado por nome dentro da execução: uma segunda passada (após aprovação ou `/resume`) reaproveita o resultado |
| `ctx.effect(rótulo, fn)` (escrita de status, leitura de aprovação) | `ctx.run` posicional: o replay segue o mesmo caminho e não reescreve nada; no journal runtime é chamada direta |
| timeout da tarefa | `ctx.sleep(TASK_TIMEOUT_MS)` por passada, em `RestatePromise.race` com cada passo; ao vencer, aborta o `AbortSignal` da passada com `TimeoutError` |
| aprovação | `ctx.promise('approval:<n>')`, uma por pausa. `ApprovalService` grava a decisão no store e `continueAfterApproval` chama o handler `approve`. O loop relê a decisão do store, então um sinal sem decisão gravada só pausa de novo na próxima promise. Os handlers aceitam entrega repetida ou concorrente |
| `/resume` de tarefa `failed` | a execução espera `ctx.promise('resume:<n>')` (com janela `RESTATE_RESUME_WINDOW_MS`); `/resume` reabre a tarefa no store (lease curto decide entre concorrentes) e chama o handler `resume` uma vez |
| dono único | `workflowSubmit` por chave: duplicado é deduplicado pelo Restate; não há lease do orquestrador nesse modo |
| cancelamento | `CancelledError` → `ExecutionCancelledError` → tarefa `failed`, sem esperar `/resume`; fim da tentativa (`attemptCompletedSignal`) → `ExecutionYieldedError` → nada é escrito, o Restate refaz a tentativa |
| erro de passo | journaled como `TerminalError` com `metadata.kind` (`budget`, `timeout`); no replay volta como `BudgetExceededError`/`TimeoutError` |

## Consequências

- **Positivas:** timeout, aprovação e retomada sobrevivem a restart sem varredura; a tarefa não ocupa processo
  enquanto espera (a invocação suspende); um dono por tarefa sem lease; o journal runtime segue padrão e sem mudança
  de comportamento (o mesmo contrato roda nos dois, em `durable.contract.spec.ts`).
- **Custos:** mais um serviço para operar (Restate); a API expõe um endpoint HTTP/2 (`RESTATE_ENDPOINT_HOST`:`RESTATE_ENDPOINT_PORT`).
  O boot exige `RESTATE_IDENTITY_KEYS`, a assinatura das requisições do Restate. Só em dev local dá para dispensá-la,
  com `RESTATE_ALLOW_UNSIGNED=true`, que é recusado em produção. Resultados de passo (saídas de LLM) ficam no journal
  do Restate até a retenção do workflow.
- **Limites conhecidos:**
  - `/resume` só vale enquanto a execução espera, dentro de `RESTATE_RESUME_WINDOW_MS` (7 dias). Depois disso o
    workflow fecha e a chave não roda de novo enquanto o Restate a retiver (409). Tarefa `failed` sem execução no
    Restate (por exemplo, que falhou sob o journal antes da troca de runtime) também dá 409. Tarefas em andamento na
    troca `journal` → `restate` recomeçam do zero no Restate: o journal de passos não é migrado.
  - Se o sinal de `/resume` perde a corrida com o fim da janela, a tarefa é devolvida a `failed`. A varredura também
    marca `failed` uma tarefa ativa cuja execução já fechou.
  - O Restate manda invocações novas (inclusive os sinais `approve`/`resume`) para o deployment registrado por último.
    Cada ambiente da API precisa do seu Restate (ou de nomes de serviço distintos). O registro automático
    (`RESTATE_ADMIN_URL`) só sobrescreve com `RESTATE_REGISTER_FORCE=true`, que é recusado em produção.
  - O store continua sendo a fonte do estado da tarefa. Com `DURABLE_RUNTIME=restate` e store em memória, o boot só
    avisa.
  - O código fora de `ctx.run`/`ctx.effect` reexecuta no replay. Hoje isso se limita a eventos em memória já
    cobertos por efeitos.
- **Testes:** o harness oficial (`@restatedev/restate-sdk-testcontainers`) precisa de Docker. Os testes unitários usam
  `FakeRestate` (`api/src/test-utils/restate-fake.ts`), que reproduz journal posicional, replay com detecção de não
  determinismo, durable promises, sleeps duráveis, corrida journaled, cancelamento e fim de tentativa. Contra o
  servidor real roda `restate.integration.spec.ts`, ignorado sem `RESTATE_INGRESS_URL` e `RESTATE_ADMIN_URL`.

## Como rodar localmente

```bash
# 1. Restate. Testado com o binário do npm (1.8.1), que sobe ingress em :8080 e admin em :9070:
npx @restatedev/restate-server@1.8.1
#    ou Docker (mesma versão; caminho não exercitado nesta máquina, que não tinha Docker):
# docker run --rm -p 8080:8080 -p 9070:9070 --add-host=host.docker.internal:host-gateway docker.restate.dev/restatedev/restate:1.8.1

# 2. API com o adaptador (registra o próprio endpoint no Restate ao subir)
DURABLE_RUNTIME=restate RESTATE_ALLOW_UNSIGNED=true RESTATE_REGISTER_FORCE=true \
RESTATE_INGRESS_URL=http://localhost:8080 \
RESTATE_ADMIN_URL=http://localhost:9070 \
RESTATE_ENDPOINT_PORT=9080 \
RESTATE_DEPLOYMENT_URL=http://host.docker.internal:9080 \
npm --prefix api run dev
# Com o binário local (fora do Docker), RESTATE_DEPLOYMENT_URL pode ficar no padrão http://localhost:9080.

# 3. Conferir
curl -s localhost:3001/health | jq .durable      # { "runtime": "restate", "state": "up" }

# 4. Teste de integração contra o servidor real
RESTATE_INGRESS_URL=http://localhost:8080 RESTATE_ADMIN_URL=http://localhost:9070 \
  RESTATE_ENDPOINT_PORT=9081 RESTATE_DEPLOYMENT_URL=http://host.docker.internal:9081 \
  npm --prefix api test -- restate.integration
```

Cancelar uma execução: `restate invocations cancel <id>` (CLI) ou `PATCH /invocations/<id>/cancel` na API admin.
A tarefa termina `failed` com "Execução cancelada no runtime durável".
