import { ChangeMessageVisibilityCommand, DeleteMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { MetricsService } from '../observability/metrics.service';
import { MessageProcessingOutcome } from './process-incoming-message';

export const MAX_BACKOFF_SECONDS = 60;
export const BASE_BACKOFF_SECONDS = 5;

export interface ApplyOutcomeLogger {
  log(entry: Record<string, unknown>): void;
  warn(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

const NOOP_LOGGER: ApplyOutcomeLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Único lugar onde os efeitos colaterais REAIS no SQS acontecem depois que
 * `processIncomingMessage` decidiu o que fazer com uma mensagem: `ack`
 * (DeleteMessage), `retry` (ChangeMessageVisibility com backoff real) ou
 * `dead_letter` (SendMessage direto pra DLQ + DeleteMessage da fila principal).
 *
 * Extraída de `WagerTransactionsConsumer.handle()` para ser testável contra um
 * LocalStack real sem precisar do loop de polling inteiro do NestJS — ver
 * `test/integration/consumer-sqs-outcomes.spec.ts`.
 */
export async function applyMessageOutcome(
  sqs: SQSClient,
  queueUrl: string,
  dlqUrl: string | undefined,
  message: Message,
  outcome: MessageProcessingOutcome,
  receiveCount: number,
  metrics: MetricsService,
  logger: ApplyOutcomeLogger = NOOP_LOGGER,
): Promise<void> {
  switch (outcome.action) {
    case 'ack': {
      logger.log({
        event: outcome.note ? 'message_ack_business_terminal' : 'message_ack_processed',
        messageId: message.MessageId,
        ...outcome.context,
        note: outcome.note,
      });
      if (message.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
      return;
    }
    case 'retry': {
      metrics.sqsRedeliveriesTotal.inc();
      const backoffSeconds = Math.min(BASE_BACKOFF_SECONDS * 2 ** receiveCount, MAX_BACKOFF_SECONDS);
      logger.warn({
        event: 'message_retry_scheduled',
        messageId: message.MessageId,
        reason: outcome.reason,
        receiveCount,
        backoffSeconds,
        ...outcome.context,
      });
      // Backoff real: em vez de deixar a mensagem reaparecer só depois do
      // VisibilityTimeout fixo da fila (30s sempre), estendemos a visibilidade
      // com um valor que cresce a cada tentativa.
      if (message.ReceiptHandle) {
        await sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: backoffSeconds }),
        );
      }
      return;
    }
    case 'dead_letter': {
      logger.error({ event: 'message_dead_lettered', messageId: message.MessageId, reason: outcome.reason, ...outcome.context });
      if (dlqUrl) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: dlqUrl,
            MessageBody: message.Body,
            MessageGroupId: 'dead-lettered-by-consumer',
            MessageDeduplicationId: message.MessageId,
          }),
        );
      }
      if (message.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
      return;
    }
  }
}
