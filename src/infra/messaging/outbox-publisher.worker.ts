import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessageEntity } from '../database/entities/messaging.entity';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { MetricsService } from '../observability/metrics.service';

const POLL_INTERVAL_MS = 500;
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

/**
 * Publica eventos pendentes da outbox no SQS. Cenário do desafio (seção 11):
 * o Postgres confirma o commit, o processo morre antes de publicar, outra
 * instância assume o trabalho, o evento é publicado, e uma publicação duplicada
 * continua segura para o consumidor (SQS FIFO dedup + o próprio consumidor é
 * idempotente via idempotency_key/inbox).
 *
 * Múltiplos publishers concorrentes: cada tentativa de "pegar" um lote usa
 * `SELECT ... FOR UPDATE SKIP LOCKED`, então duas instâncias nunca competem pelo
 * mesmo evento — cada uma pega um lote disjunto.
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly sqs: SQSClient;
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {
    this.sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1' });
  }

  onModuleInit(): void {
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.logger.log('Outbox publisher stopped');
  }

  private async loop(): Promise<void> {
    // Fila de SAÍDA — deliberadamente diferente de SQS_QUEUE_URL (que é a fila de
    // ENTRADA consumida por WagerTransactionsConsumer). Publicar e consumir os
    // eventos de domínio na mesma fila dos pedidos de entrada criaria um loop:
    // este worker mandaria WagerTransactionProcessed/WalletBalanceChanged/etc. de
    // volta para a fila, e o consumidor os receberia como se fossem novos pedidos
    // de aposta, falhando ao tentar interpretar um envelope de evento como se
    // fosse um WagerTransactionRequested.
    const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
    while (this.running) {
      try {
        if (queueUrl) {
          const published = await this.publishBatch(queueUrl);
          if (published === 0) await sleep(POLL_INTERVAL_MS);
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        this.logger.error(`Outbox publish loop error: ${(err as Error).message}`);
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private async publishBatch(queueUrl: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      // SKIP LOCKED: se outra instância já pegou uma linha, esta pula para a próxima
      // em vez de esperar — é o que permite publishers concorrentes sem se pisarem.
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
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: JSON.stringify(row.payload),
              MessageGroupId: row.aggregate_id, // FIFO: ordena eventos da mesma wallet
              MessageDeduplicationId: row.id,
            }),
          );
          outboxMessage.markPublished(now);
          await manager.update(OutboxMessageEntity, { id: row.id }, { publishedAt: outboxMessage.publishedAt });
          this.metrics.outboxPublishedTotal.inc();
        } catch (err) {
          outboxMessage.scheduleRetry(now);
          this.metrics.outboxPublishRetriesTotal.inc();
          await manager.update(
            OutboxMessageEntity,
            { id: row.id },
            { attempts: outboxMessage.attempts, nextAttemptAt: outboxMessage.nextAttemptAt },
          );
          this.logger.warn(`Failed to publish outbox message ${row.id}: ${(err as Error).message}`);
        }
      }

      return rows.length;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
