import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MetricsService } from '../observability/metrics.service';
import { publishOutboxBatch } from './publish-outbox-batch';

const POLL_INTERVAL_MS = 500;

/**
 * Publica eventos pendentes da outbox no SQS. Cenário do desafio (seção 11):
 * o Postgres confirma o commit, o processo morre antes de publicar, outra
 * instância assume o trabalho, o evento é publicado, e uma publicação duplicada
 * continua segura para o consumidor (SQS FIFO dedup + o próprio consumidor é
 * idempotente via idempotency_key/inbox).
 *
 * Múltiplos publishers concorrentes: a lógica de fato (`publishOutboxBatch`) usa
 * `SELECT ... FOR UPDATE SKIP LOCKED`, então duas instâncias nunca competem pelo
 * mesmo evento — cada uma pega um lote disjunto. Esse comportamento é testado
 * diretamente em test/integration/outbox-concurrent-publishers.spec.ts, chamando
 * a função extraída duas vezes em paralelo com conexões reais.
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
    this.logger.log({ event: 'outbox_publisher_stopped' });
  }

  private async loop(): Promise<void> {
    // Fila de SAÍDA — deliberadamente diferente de SQS_QUEUE_URL (que é a fila de
    // ENTRADA consumida por WagerTransactionsConsumer). Publicar e consumir os
    // eventos de domínio na mesma fila dos pedidos de entrada criaria um loop —
    // ver ARCHITECTURE.md § 6.
    const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
    while (this.running) {
      try {
        if (queueUrl) {
          const published = await publishOutboxBatch(this.dataSource, this.sqs, queueUrl, this.metrics, this.logger);
          if (published === 0) await sleep(POLL_INTERVAL_MS);
        } else {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (err) {
        this.logger.error({ event: 'outbox_publish_loop_error', errorMessage: (err as Error).message });
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
