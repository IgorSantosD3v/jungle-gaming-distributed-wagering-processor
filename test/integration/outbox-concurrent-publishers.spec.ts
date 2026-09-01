/**
 * Dois cenários exigidos pela seção 13 que faltavam como testes automatizados:
 *  - "dois publishers concorrentes sobre a mesma outbox";
 *  - "reinício do serviço com comprovação da consistência final".
 *
 * Ambos usam `publishOutboxBatch` diretamente (a função pura por trás do
 * `OutboxPublisherWorker`) contra um PostgreSQL e um SQS (LocalStack) reais —
 * sem mocks de infraestrutura.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DataSource, IsNull } from 'typeorm';
import { SQSClient } from '@aws-sdk/client-sqs';
import { v4 as uuid } from 'uuid';
import { AppDataSource } from '../../src/infra/database/data-source';
import { MetricsService } from '../../src/infra/observability/metrics.service';
import { publishOutboxBatch } from '../../src/infra/messaging/publish-outbox-batch';
import { OutboxMessageEntity } from '../../src/infra/database/entities/messaging.entity';
import { createWallet } from '../../src/application/wallets/create-wallet.use-case';
import { submitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction.use-case';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction';
import { reconcileWallet } from '../../src/application/wallets/reconciliation.use-case';

let dataSource: DataSource;
const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo';

beforeAll(async () => {
  dataSource = await AppDataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE');
});

async function insertSyntheticOutboxRows(aggregateId: string, count: number): Promise<void> {
  const repo = dataSource.getRepository(OutboxMessageEntity);
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      repo.insert({
        id: uuid(),
        aggregateId,
        eventType: 'TestEvent',
        payload: { test: true, index: i },
        occurredAt: new Date(),
        attempts: 0,
      }),
    ),
  );
}

describe('Two concurrent outbox publishers on the same outbox', () => {
  it('every pending event is published exactly once, never duplicated, never lost', async () => {
    const aggregateId = uuid();
    const TOTAL = 30;
    await insertSyntheticOutboxRows(aggregateId, TOTAL);

    // Duas "instâncias" — cada uma com seu próprio SQSClient e seu próprio
    // MetricsService, como se fossem processos separados — chamando
    // publishOutboxBatch AO MESMO TEMPO, repetidamente, até a fila de
    // pendências esvaziar.
    const metricsA = new MetricsService();
    const metricsB = new MetricsService();
    const sqsA = new SQSClient({ endpoint: sqsEndpoint, region: 'us-east-1' });
    const sqsB = new SQSClient({ endpoint: sqsEndpoint, region: 'us-east-1' });

    let totalPublished = 0;
    for (let round = 0; round < 6 && totalPublished < TOTAL; round++) {
      const [publishedByA, publishedByB] = await Promise.all([
        publishOutboxBatch(dataSource, sqsA, eventsQueueUrl, metricsA),
        publishOutboxBatch(dataSource, sqsB, eventsQueueUrl, metricsB),
      ]);
      totalPublished += publishedByA + publishedByB;
    }

    // Se SKIP LOCKED não estivesse funcionando, duas transações concorrentes
    // poderiam pegar a MESMA linha, e o total contado aqui ultrapassaria TOTAL
    // (a mesma linha publicada — e contada — duas vezes).
    expect(totalPublished).toBe(TOTAL);

    const rows = await dataSource.getRepository(OutboxMessageEntity).find({ where: { aggregateId } });
    expect(rows.length).toBe(TOTAL);
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('a batch already picked up by one publisher is skipped, not blocked, by a concurrent one', async () => {
    const aggregateId = uuid();
    await insertSyntheticOutboxRows(aggregateId, 5);

    const metrics = new MetricsService();
    const sqsA = new SQSClient({ endpoint: sqsEndpoint, region: 'us-east-1' });
    const sqsB = new SQSClient({ endpoint: sqsEndpoint, region: 'us-east-1' });

    // Duas chamadas concorrentes competindo pelo MESMO lote pequeno (5 linhas) —
    // SKIP LOCKED garante que uma delas não fica esperando a outra: as duas
    // retornam rápido, dividindo o lote entre si (sem sobreposição).
    const start = Date.now();
    const [a, b] = await Promise.all([
      publishOutboxBatch(dataSource, sqsA, eventsQueueUrl, metrics),
      publishOutboxBatch(dataSource, sqsB, eventsQueueUrl, metrics),
    ]);
    const elapsedMs = Date.now() - start;

    expect(a + b).toBe(5);
    expect(elapsedMs).toBeLessThan(5000); // não ficou preso esperando lock

    const rows = await dataSource.getRepository(OutboxMessageEntity).find({ where: { aggregateId } });
    expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
  });
});

describe('Restart recovery with final consistency proof', () => {
  it('events left pending by a "crashed" instance are picked up after restart, and the wallet stays reconcilable throughout', async () => {
    const playerId = uuid();
    const wallet = await dataSource.transaction((m) =>
      createWallet(m, { playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: 'setup' }),
    );

    // Processa algumas transações reais — cada uma grava eventos na outbox na
    // MESMA transação (seção 11), mas ninguém publica ainda (nenhum worker
    // está rodando neste teste) — simula exatamente "o commit aconteceu, o
    // processo morreu antes de publicar".
    for (let i = 0; i < 3; i++) {
      await dataSource.transaction((m) =>
        submitWagerTransaction(m, {
          idempotencyKey: `provider-a:restart-bet-${i}`,
          providerId: 'provider-a',
          externalTransactionId: `restart-bet-${i}`,
          playerId,
          walletId: wallet.id,
          roundId: 'r1',
          gameId: 'g1',
          kind: WagerTransactionKind.Bet,
          money: Money.from({ amount: '10.00', currency: 'BRL' }),
          correlationId: 'corr',
        }),
      );
    }

    const pendingBefore = await dataSource.getRepository(OutboxMessageEntity).count({ where: { publishedAt: IsNull() } });
    expect(pendingBefore).toBeGreaterThan(0);

    // A wallet já está financeiramente consistente mesmo com eventos pendentes
    // de publicação — outbox lag não é a mesma coisa que inconsistência de saldo.
    const reconciliationDuringOutage = await dataSource.transaction((m) => reconcileWallet(m, wallet.id));
    expect(reconciliationDuringOutage.consistent).toBe(true);

    // "Reinício do serviço": uma instância nova (metrics/SQSClient novos, como
    // se fosse um processo diferente) assume o trabalho de publicar o que ficou
    // pendente.
    const metrics = new MetricsService();
    const sqs = new SQSClient({ endpoint: sqsEndpoint, region: 'us-east-1' });
    let published = 0;
    for (let round = 0; round < 5; round++) {
      published += await publishOutboxBatch(dataSource, sqs, eventsQueueUrl, metrics);
    }
    expect(published).toBe(pendingBefore);

    const pendingAfter = await dataSource.getRepository(OutboxMessageEntity).count({ where: { publishedAt: IsNull() } });
    expect(pendingAfter).toBe(0);

    // Consistência final: depois de todo o processo (transações + outage
    // simulado + recuperação), o saldo materializado ainda bate com o ledger.
    const reconciliationAfter = await dataSource.transaction((m) => reconcileWallet(m, wallet.id));
    expect(reconciliationAfter.consistent).toBe(true);
    expect(reconciliationAfter.storedBalance.amount).toBe('70.00');
  });
});
