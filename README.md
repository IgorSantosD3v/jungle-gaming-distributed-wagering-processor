# Distributed Wagering Processor

Serviço financeiro distribuído de apostas — desafio técnico Jungle Gaming.

## Stack

Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · AWS SQS (LocalStack) · TypeORM · Docker Compose.

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
`docker/localstack-init.sh` — e também `wager-events.fifo`, a fila separada onde
o serviço publica seus próprios eventos de domínio (ver `ARCHITECTURE.md` § 6).

### 3. Instalar dependências

```bash
bun install
```

### 4. Rodar as migrations

```bash
cp .env.example .env
bun run migration:run
```

### 5. Subir a aplicação

```bash
bun run start:dev
```

A API sobe em `http://localhost:3000`. Health checks: `GET /health/live`, `GET /health/ready`.

### 6. Rodar tudo via Docker Compose (alternativa)

```bash
docker compose up --build
```

## Testes

```bash
bun run test:unit          # domínio puro, sem infra — roda em qualquer ambiente
bun run test:integration   # precisa de postgres + localstack rodando (passo 2) e migrations aplicadas (passo 4)
bun run test:concurrency   # idem — este é o que exercita o cenário obrigatório da seção 8
bun run test:all           # os três juntos
```

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
`idempotentReplay: true` com o mesmo resultado — nunca debita duas vezes.

### Consultar saldo e ledger

```bash
curl http://localhost:3000/wallets/<walletId>
curl http://localhost:3000/wallets/<walletId>/ledger?limit=50
```

### Reconciliação

```bash
curl -X POST http://localhost:3000/wallets/<walletId>/reconciliation
```

## Estrutura do projeto

```
src/
  domain/           # regras de negócio puras — sem NestJS, sem TypeORM, sem I/O
  application/       # casos de uso — orquestram domínio + persistência dentro de transações
  infra/             # TypeORM, migrations, consumidor SQS, workers de outbox/pending-reference
  interfaces/http/   # controllers, DTOs, filtro de exceção
  common/            # payload hash de idempotência, auth guard (no-op documentado)
test/
  unit/              # domínio puro — sem banco, sem fila
  integration/        # Postgres real via docker-compose
  concurrency/         # paralelismo real — cenário obrigatório da seção 8 e afins
```

Ver `ARCHITECTURE.md` para as decisões de design, trade-offs e limitações conhecidas.
