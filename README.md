# Distributed Wagering Processor

Serviço financeiro distribuído de apostas, desafio técnico Jungle Gaming.

Processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos
provedores de jogos, garantindo correção financeira, concorrência entre múltiplas
instâncias, idempotência persistente e recuperação após falhas, mesmo quando mensagens
chegam duplicadas, fora de ordem ou simultaneamente. Decisões técnicas, trade-offs e
limitações estão documentados em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Stack

Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · AWS SQS (LocalStack) · TypeORM · Docker Compose · Prometheus (`prom-client`).

## Rodando localmente

### 1. Pré-requisitos

- [Bun](https://bun.sh) 1.x instalado
- Docker + Docker Compose

### 2. Subir a infraestrutura (Postgres + LocalStack)

```bash
docker compose up -d postgres localstack
```

Aguarde os dois ficarem `healthy` (`docker compose ps`). O LocalStack já cria as filas
`wager-transactions.fifo` e `wager-transactions-dlq.fifo` automaticamente via
`docker/localstack-init.sh`, e também `wager-events.fifo`, a fila separada onde
o serviço publica seus próprios eventos de domínio (ver `ARCHITECTURE.md` § 6).

> Se `docker compose` der erro de permissão (`permission denied ... docker.sock`), seu
> usuário provavelmente não está no grupo `docker` ainda nesta sessão de terminal. Veja
> a seção [Troubleshooting](#troubleshooting) no fim deste documento.

### 3. Instalar dependências

```bash
bun install
```

### 4. Configurar ambiente e rodar as migrations

```bash
cp .env.example .env
bun run migration:run
```

Ver a seção [Variáveis de ambiente](#variáveis-de-ambiente) para o que cada uma significa.

### 5. Subir a aplicação

```bash
bun run start:dev
```

A API sobe em `http://localhost:3000`.

### 6. Rodar tudo via Docker Compose (alternativa)

```bash
docker compose up --build
```

## Testes

```bash
bun run test:unit          # domínio puro, sem infra, roda em qualquer ambiente (~40ms, 34 testes)
bun run test:integration   # precisa de postgres + localstack rodando (passo 2) e migrations aplicadas (passo 4)
bun run test:concurrency   # idem, inclui o cenário obrigatório da seção 8 e 3-5 processos reais do SO
bun run test:all           # os três juntos
```

82 testes automatizados no total, todos contra Postgres/SQS reais, nenhum mock de
infraestrutura (ver `ARCHITECTURE.md` § 12 para o mapa completo de qual arquivo cobre
qual cenário da seção 13 do desafio).

## Endpoints da API

Autenticação: nenhum endpoint exige autenticação nesta entrega (decisão documentada em
`ARCHITECTURE.md` § 1). `/health/*` e `/metrics` são sempre abertos, por definição.

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/wallets` | Cria uma wallet, com saldo inicial opcional |
| `GET` | `/wallets/:walletId` | Consulta saldo e versão |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Extrato paginado (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | Confere saldo materializado x saldo reconstruído pelo ledger |
| `POST` | `/wagering/transactions` | Submete uma transação (`BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta uma transação pelo ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo ID do provedor |
| `GET` | `/health/live` | Liveness: o processo está vivo? |
| `GET` | `/health/ready` | Readiness: Postgres e SQS estão alcançáveis? |
| `GET` | `/metrics` | Métricas Prometheus (texto plano) |

## Exemplos de uso da API

### Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

### Submeter uma aposta (BET)

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<id retornado na criação da wallet>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

Reenviar exatamente a mesma requisição (mesmo `Idempotency-Key` e mesmo corpo) retorna
`idempotentReplay: true` com o mesmo resultado, nunca debita duas vezes.

### O cenário obrigatório da seção 8: saldo 100.00, duas apostas de 80.00 em paralelo

```bash
PLAYER_ID=$(uuidgen)
WALLET_ID=$(curl -s -X POST http://localhost:3000/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\": \"$PLAYER_ID\", \"initialBalance\": {\"amount\": \"100.00\", \"currency\": \"BRL\"}}" | jq -r .id)

curl -s -X POST http://localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-1\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}" &

curl -s -X POST http://localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-2' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-2\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}" &

wait
curl -s http://localhost:3000/wallets/$WALLET_ID | jq
```

Esperado: uma `PROCESSED`, outra `REJECTED` com `failureCode: "BUSINESS_INSUFFICIENT_BALANCE"`,
saldo final `20.00`. Ver `ARCHITECTURE.md` § 2 para a explicação de como o lock pessimista
garante isso mesmo sob concorrência real.

### Consultar transação (por ID interno ou por provedor)

```bash
curl http://localhost:3000/wagering/transactions/<transactionId>
curl http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

### Consultar saldo e ledger

```bash
curl http://localhost:3000/wallets/<walletId>
curl http://localhost:3000/wallets/<walletId>/ledger?limit=50
```

### Reconciliação

```bash
curl -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```

Divergências (se houver) são sinalizadas na resposta (`consistent: false`), logadas em
JSON estruturado e contabilizadas na métrica `wallet_reconciliation_divergences_total`.

### Métricas e health checks

```bash
curl http://localhost:3000/metrics
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

## Testando cenários avançados

Estes cenários já são cobertos pelos testes automatizados (`test:integration` e
`test:concurrency`), mas também podem ser reproduzidos manualmente. Útil para
demonstração ao vivo.

### Múltiplas instâncias

```bash
PORT=3001 bun run start:dev   # em outro terminal, com a instância da porta 3000 já rodando
```

Repita o cenário obrigatório acima mandando uma requisição para `localhost:3000` e outra
para `localhost:3001`. O resultado precisa ser idêntico, provando que a correção não
depende de estado em memória de um único processo.

### Dead-letter queue (DLQ)

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "dlq-test" --message-deduplication-id "dlq-test-1" \
  --message-body '{"isto": "nao e um envelope valido"}'

docker compose exec localstack awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names ApproximateNumberOfMessages
```

Payloads permanentemente inválidos (JSON malformado, campos obrigatórios ausentes,
`kind` inválido ou `OPENING`, UUIDs malformados) vão para a DLQ **imediatamente**,
sem esperar o `maxReceiveCount` do SQS esgotar sozinho (ver `ARCHITECTURE.md` § 7.1).

### Shutdown gracioso

Com a aplicação rodando (`bun run start:dev`), aperte `Ctrl+C` e observe o log: o
consumidor para de puxar mensagens novas, espera as que já estão em processamento
terminarem, e só então o processo encerra, sem travar, em poucos segundos.

### Recuperação da outbox após falha

```bash
# com a aplicação PARADA, insira um evento pendente direto no banco
# (simula "o commit aconteceu, o processo morreu antes de publicar"):
docker compose exec postgres psql -U wagering -d wagering -c "
INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
VALUES (gen_random_uuid(), '<walletId>', 'WalletBalanceChanged', '{\"note\": \"evento simulado\"}'::jsonb, now(), 0);"

bun run start:dev   # suba a aplicação de novo

# depois de alguns segundos, confirme que foi publicado sozinho:
docker compose exec postgres psql -U wagering -d wagering -c \
  "SELECT id, published_at FROM outbox_messages WHERE published_at IS NULL;"
```
A segunda consulta deve vir vazia: o `OutboxPublisherWorker` encontra o evento
pendente ao subir e publica sem intervenção manual.

## Variáveis de ambiente

Ver [`.env.example`](./.env.example) para os valores padrão (já compatíveis com o
`docker-compose.yml`, não precisa editar nada para rodar localmente).

| Variável | O que é |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexão com o PostgreSQL |
| `SQS_ENDPOINT` | Endpoint do LocalStack |
| `SQS_QUEUE_URL` | Fila de **entrada**: pedidos de transação dos provedores |
| `SQS_DLQ_URL` | Dead-letter queue da fila de entrada (usada pela métrica `sqs_dlq_depth`) |
| `SQS_EVENTS_QUEUE_URL` | Fila de **saída**: eventos de domínio publicados pela aplicação (separada de propósito, ver `ARCHITECTURE.md` § 6) |
| `PORT` | Porta HTTP da aplicação |

## Estrutura do projeto

```
src/
  domain/           # regras de negócio puras, sem NestJS, sem TypeORM, sem I/O
  application/       # casos de uso, orquestram domínio + persistência dentro de transações
  infra/             # TypeORM, migrations, consumidor SQS, workers de outbox/pending-reference, observabilidade
  interfaces/http/   # controllers, DTOs, filtro de exceção
  common/            # payload hash de idempotência, auth guard (no-op documentado)
test/
  unit/              # domínio puro, sem banco, sem fila
  integration/       # Postgres + LocalStack reais via docker-compose
  concurrency/       # paralelismo real, cenário obrigatório da seção 8, 3-5 processos do SO
```

Ver [`ARCHITECTURE.md`](./ARCHITECTURE.md) para as decisões de design, trade-offs,
bugs reais encontrados durante o desenvolvimento e limitações conhecidas.

## Troubleshooting

**`permission denied` ao rodar `docker compose`**
Seu usuário foi adicionado ao grupo `docker`, mas essa sessão de terminal foi aberta
antes disso. Rode `newgrp docker` ou abra um terminal novo.

**Migration falha com `ECONNREFUSED`**
O Postgres ainda não está `healthy`. Confira com `docker compose ps` e espere.

**Porta 3000 já em uso**
`PORT=3001 bun run start:dev` para subir em outra porta.

**Quero resetar tudo do zero**
```bash
docker compose down -v   # apaga os volumes, perde os dados do Postgres também
docker compose up -d postgres localstack
bun run migration:run
```
