import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { InboxMessageEntity } from '../database/entities/messaging.entity';
import { submitWagerTransaction } from '../../application/wagering/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction';
import { Money } from '../../domain/money/money';
import { IdempotencyConflictError } from '../../application/wagering/wagering.errors';
import { DomainError } from '../../domain/money/money.errors';
import { MetricsService } from '../observability/metrics.service';
import { recordTransactionMetrics } from '../observability/record-transaction-metrics';

const CONSUMER_NAME = 'wager-transactions-consumer';

interface WagerTransactionRequestedEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

/**
 * Consome `wager-transactions.fifo`. Regras cumpridas aqui (seção 10):
 *  - dedup via inbox persistente por (consumerName, messageId) — checada e marcada
 *    DENTRO da mesma transação do use case, não antes/depois;
 *  - ack (delete da fila) só depois do commit;
 *  - distingue erro de negócio (terminal -> ack, o resultado já foi persistido como
 *    REJECTED/PROCESSED) de erro transitório (não deleta -> SQS reentrega) e erro
 *    permanente de payload (ack + loga, não faz sentido reenviar um payload inválido
 *    indefinidamente — depois de N tentativas o próprio SQS manda para a DLQ via
 *    redrive policy configurada no LocalStack, ver docker/localstack-init.sh);
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
    this.logger.log('Shutdown signal received — no longer polling for new messages');
    this.running = false;
    await this.loopPromise;
    // Espera as mensagens em processamento terminarem antes de deixar o processo morrer,
    // em vez de devolver a visibilidade e potencialmente processar duas vezes ao mesmo tempo.
    if (this.inFlight > 0) {
      this.logger.log(`Waiting for ${this.inFlight} in-flight message(s) to finish before shutting down`);
    }
    while (this.inFlight > 0) {
      await sleep(100);
    }
    this.logger.log('Shutdown complete — no messages left in flight');
  }

  private async pollLoop(): Promise<void> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) {
      this.logger.warn('SQS_QUEUE_URL not set — consumer disabled');
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
          }),
        );
        const messages = result.Messages ?? [];
        await Promise.all(messages.map((m) => this.handle(queueUrl, m)));
      } catch (err) {
        this.logger.error(`Poll loop error: ${(err as Error).message}`);
        await sleep(1000);
      }
    }
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    this.inFlight += 1;
    try {
      if (!message.Body || !message.MessageId) return;

      let shouldAck = true;
      let envelope: WagerTransactionRequestedEnvelope | undefined;
      try {
        envelope = JSON.parse(message.Body);
        if (!envelope) throw new Error('Empty envelope');
        const payloadHash = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');

        await this.dataSource.transaction(async (manager) => {
          const inboxRepo = manager.getRepository(InboxMessageEntity);
          const existingInbox = await inboxRepo.findOneBy({ consumerName: CONSUMER_NAME, messageId: envelope!.messageId });
          if (existingInbox?.processedAt) {
            // Redelivery de uma mensagem que já processamos por completo — ack sem reprocessar.
            return;
          }
          if (!existingInbox) {
            await inboxRepo.insert({ consumerName: CONSUMER_NAME, messageId: envelope!.messageId, payloadHash, receivedAt: new Date() });
          }

          const result = await submitWagerTransaction(manager, {
            idempotencyKey: envelope!.data.idempotencyKey,
            providerId: envelope!.data.providerId,
            externalTransactionId: envelope!.data.externalTransactionId,
            playerId: envelope!.data.playerId,
            walletId: envelope!.data.walletId,
            roundId: envelope!.data.roundId,
            gameId: envelope!.data.gameId,
            kind: envelope!.data.kind,
            money: Money.from(envelope!.data.money),
            referenceExternalTransactionId: envelope!.data.referenceExternalTransactionId,
            correlationId: envelope!.messageId,
          });
          recordTransactionMetrics(this.metrics, envelope!.data.kind, result);

          await inboxRepo.update({ consumerName: CONSUMER_NAME, messageId: envelope!.messageId }, { processedAt: new Date() });
        });
      } catch (err) {
        if (err instanceof IdempotencyConflictError || err instanceof DomainError) {
          // Erro de negócio/validação — não é transitório, reenviar não vai ajudar.
          // O resultado (se houver) já foi persistido pelo use case; aqui só logamos e damos ack.
          this.logger.warn(`Business/validation error for message ${envelope?.messageId ?? message.MessageId}: ${err.message}`);
        } else {
          if (this.metrics.isDeadlockError(err)) this.metrics.lockConflictsTotal.inc();
          // Falha transitória (Postgres fora do ar, timeout de lock) OU payload malformado
          // (JSON inválido, campos ausentes) — em ambos os casos NÃO ack. Um payload
          // malformado não deve travar o consumidor nem ser descartado silenciosamente:
          // ele fica visível de novo, é reentregue, e depois de maxReceiveCount tentativas
          // o próprio SQS o move para a DLQ via redrive policy — ver docker/localstack-init.sh.
          this.logger.error(`Transient/malformed message ${envelope?.messageId ?? message.MessageId}: ${(err as Error).message}`);
          this.metrics.sqsRedeliveriesTotal.inc();
          shouldAck = false;
        }
      }

      if (shouldAck && message.ReceiptHandle) {
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
    } finally {
      this.inFlight -= 1;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
