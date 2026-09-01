import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { MetricsService } from '../observability/metrics.service';
import { processIncomingMessage, WAGER_TRANSACTIONS_CONSUMER_NAME } from './process-incoming-message';

const MAX_BACKOFF_SECONDS = 60;
const BASE_BACKOFF_SECONDS = 5;

/**
 * Consome `wager-transactions.fifo`. Regras cumpridas aqui (seção 10):
 *  - dedup via inbox persistente por (consumerName, messageId) — checada e marcada
 *    DENTRO da mesma transação do use case, não antes/depois (ver process-incoming-message.ts);
 *  - ack (delete da fila) só depois do commit;
 *  - distingue TRÊS categorias, explicitamente, não duas: erro de negócio (ack — o
 *    resultado já foi persistido), erro transitório (retry com backoff real via
 *    ChangeMessageVisibility, não apenas "esperar o timeout fixo passar"), e erro
 *    permanente (DLQ imediata, publicada pelo próprio código — não esperamos o
 *    maxReceiveCount do SQS esgotar sozinho para um payload que sabemos, de cara,
 *    que nunca vai processar);
 *  - SIGTERM: para de puxar novas mensagens e aguarda as em andamento (ver onModuleDestroy).
 */
@Injectable()
export class WagerTransactionsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WagerTransactionsConsumer.name);
  private readonly sqs: SQSClient;
  private running = false;
  private inFlight = 0;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {
    this.sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION ?? 'us-east-1' });
  }

  onModuleInit(): void {
    this.running = true;
    this.loopPromise = this.pollLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log({ event: 'consumer_shutdown_started' });
    this.running = false;
    await this.loopPromise;
    if (this.inFlight > 0) {
      this.logger.log({ event: 'consumer_shutdown_waiting_in_flight', inFlight: this.inFlight });
    }
    while (this.inFlight > 0) {
      await sleep(100);
    }
    this.logger.log({ event: 'consumer_shutdown_complete' });
  }

  private async pollLoop(): Promise<void> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) {
      this.logger.warn({ event: 'consumer_disabled', reason: 'SQS_QUEUE_URL not set' });
      return;
    }
    while (this.running) {
      try {
        const result = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 5,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        const messages = result.Messages ?? [];
        await Promise.all(messages.map((m) => this.handle(queueUrl, m)));
      } catch (err) {
        this.logger.error({ event: 'poll_loop_error', errorMessage: (err as Error).message });
        await sleep(1000);
      }
    }
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    this.inFlight += 1;
    try {
      if (!message.Body || !message.MessageId) return;

      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const outcome = await processIncomingMessage(this.dataSource, this.metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, message.Body);

      switch (outcome.action) {
        case 'ack': {
          this.logger.log({
            event: outcome.note ? 'message_ack_business_terminal' : 'message_ack_processed',
            messageId: message.MessageId,
            ...outcome.context,
            note: outcome.note,
          });
          if (message.ReceiptHandle) {
            await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          }
          break;
        }
        case 'retry': {
          this.metrics.sqsRedeliveriesTotal.inc();
          const backoffSeconds = Math.min(BASE_BACKOFF_SECONDS * 2 ** receiveCount, MAX_BACKOFF_SECONDS);
          this.logger.warn({
            event: 'message_retry_scheduled',
            messageId: message.MessageId,
            reason: outcome.reason,
            receiveCount,
            backoffSeconds,
            ...outcome.context,
          });
          // Backoff real: em vez de deixar a mensagem reaparecer só depois do
          // VisibilityTimeout fixo da fila (30s sempre), estendemos a visibilidade
          // com um valor que cresce a cada tentativa — a próxima reentrega demora
          // mais quanto mais vezes já falhou.
          if (message.ReceiptHandle) {
            await this.sqs.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: backoffSeconds,
              }),
            );
          }
          break;
        }
        case 'dead_letter': {
          this.logger.error({ event: 'message_dead_lettered', messageId: message.MessageId, reason: outcome.reason, ...outcome.context });
          const dlqUrl = process.env.SQS_DLQ_URL;
          if (dlqUrl) {
            await this.sqs.send(
              new SendMessageCommand({
                QueueUrl: dlqUrl,
                MessageBody: message.Body,
                MessageGroupId: 'dead-lettered-by-consumer',
                MessageDeduplicationId: message.MessageId,
              }),
            );
          }
          if (message.ReceiptHandle) {
            await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          }
          break;
        }
      }
    } finally {
      this.inFlight -= 1;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
