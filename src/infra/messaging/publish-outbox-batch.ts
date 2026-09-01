import { DataSource } from 'typeorm';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessageEntity } from '../database/entities/messaging.entity';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { MetricsService } from '../observability/metrics.service';

const BATCH_SIZE = 20;

interface OutboxRawRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  attempts: number;
  next_attempt_at: string | null;
  published_at: string | null;
}

export interface PublishBatchLogger {
  warn(entry: Record<string, unknown>): void;
}

const NOOP_LOGGER: PublishBatchLogger = { warn: () => undefined };

/**
 * Pega um lote de eventos pendentes e publica no SQS, dentro de uma transação.
 * `SELECT ... FOR UPDATE SKIP LOCKED` é o que permite chamar esta função a
 * partir de múltiplas instâncias/processos AO MESMO TEMPO sem que uma espere
 * pela outra nem duas peguem a mesma linha: cada chamada concorrente pula
 * qualquer linha já travada por outra e pega um lote disjunto.
 *
 * Extraída do worker (`OutboxPublisherWorker`) para ser testável diretamente —
 * `test/integration/outbox-concurrent-publishers.spec.ts` chama esta função
 * duas vezes em paralelo, com duas conexões reais, e verifica que nenhum
 * evento é publicado duas vezes nem fica sem publicar.
 */
export async function publishOutboxBatch(
  dataSource: DataSource,
  sqs: SQSClient,
  queueUrl: string,
  metrics: MetricsService,
  logger: PublishBatchLogger = NOOP_LOGGER,
): Promise<number> {
  return dataSource.transaction(async (manager) => {
    const now = new Date();
    const rows: OutboxRawRow[] = await manager.query(
      `SELECT * FROM outbox_messages
         WHERE published_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
         ORDER BY occurred_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
      [now, BATCH_SIZE],
    );

    for (const row of rows) {
      const outboxMessage = OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
        publishedAt: row.published_at ? new Date(row.published_at) : undefined,
      });

      try {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(row.payload),
            MessageGroupId: row.aggregate_id, // FIFO: ordena eventos da mesma wallet
            MessageDeduplicationId: row.id,
          }),
        );
        outboxMessage.markPublished(now);
        await manager.update(OutboxMessageEntity, { id: row.id }, { publishedAt: outboxMessage.publishedAt });
        metrics.outboxPublishedTotal.inc();
      } catch (err) {
        outboxMessage.scheduleRetry(now);
        metrics.outboxPublishRetriesTotal.inc();
        await manager.update(
          OutboxMessageEntity,
          { id: row.id },
          { attempts: outboxMessage.attempts, nextAttemptAt: outboxMessage.nextAttemptAt },
        );
        logger.warn({ event: 'outbox_publish_failed', outboxMessageId: row.id, eventType: row.event_type, errorMessage: (err as Error).message });
      }
    }

    return rows.length;
  });
}
