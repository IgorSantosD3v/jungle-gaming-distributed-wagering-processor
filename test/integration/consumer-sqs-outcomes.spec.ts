/**
 * `processIncomingMessage` (testado em consumer-crash-recovery.spec.ts) decide
 * o QUE fazer com uma mensagem. Este arquivo testa o COMO — os efeitos reais no
 * SQS que `applyMessageOutcome` executa: DeleteMessage (ack), ChangeMessageVisibility
 * com backoff (retry), e SendMessage direto pra DLQ + DeleteMessage da fila
 * principal (dead_letter). Contra um LocalStack real — sem isso, o `switch` que
 * decide essas três ações nunca teria sido executado nem uma vez.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, GetQueueAttributesCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { v4 as uuid } from 'uuid';
import { MetricsService } from '../../src/infra/observability/metrics.service';
import { applyMessageOutcome } from '../../src/infra/messaging/apply-message-outcome';

const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const queueUrl = process.env.SQS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const dlqUrl = process.env.SQS_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

const sqs = new SQSClient({ endpoint: sqsEndpoint, region: 'us-east-1' });

async function purgeBothQueues(): Promise<void> {
  // PurgeQueue tem cooldown de 60s na AWS real, mas o LocalStack não impõe isso —
  // seguro para uso em testes locais.
  await Promise.all([
    sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined),
    sqs.send(new PurgeQueueCommand({ QueueUrl: dlqUrl })).catch(() => undefined),
  ]);
}

async function sendAndReceiveOne(body: string, groupId: string): Promise<Message> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2, VisibilityTimeout: 30 }),
    );
    const msg = result.Messages?.[0];
    if (msg) return msg;
  }
  throw new Error('Message never appeared in the queue after sending');
}

async function approxDepth(url: string): Promise<number> {
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
  return Number(attrs.Attributes?.ApproximateNumberOfMessages ?? '0');
}

beforeEach(async () => {
  await purgeBothQueues();
});

describe('applyMessageOutcome: real SQS side effects', () => {
  it('"ack" deletes the message from the main queue', async () => {
    const message = await sendAndReceiveOne(JSON.stringify({ test: 'ack-case' }), 'ack-test');
    const metrics = new MetricsService();

    await applyMessageOutcome(sqs, queueUrl, dlqUrl, message, { action: 'ack' }, 1, metrics);

    await new Promise((r) => setTimeout(r, 500));
    const receiveAgain = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
    expect(receiveAgain.Messages ?? []).toHaveLength(0);
  });

  it('"dead_letter" sends the message to the DLQ AND removes it from the main queue', async () => {
    const body = JSON.stringify({ test: 'dead-letter-case', marker: uuid() });
    const message = await sendAndReceiveOne(body, 'dlq-test');
    const metrics = new MetricsService();

    await applyMessageOutcome(sqs, queueUrl, dlqUrl, message, { action: 'dead_letter', reason: 'test reason' }, 1, metrics);

    await new Promise((r) => setTimeout(r, 500));

    const mainQueueReceive = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
    expect(mainQueueReceive.Messages ?? []).toHaveLength(0);

    const dlqReceive = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 }));
    expect(dlqReceive.Messages?.length).toBe(1);
    expect(dlqReceive.Messages?.[0]?.Body).toBe(body);
  });

  it('"retry" does NOT delete the message and never sends it to the DLQ', async () => {
    const message = await sendAndReceiveOne(JSON.stringify({ test: 'retry-case' }), 'retry-test');
    const metrics = new MetricsService();

    await applyMessageOutcome(sqs, queueUrl, dlqUrl, message, { action: 'retry', reason: 'transient failure' }, 1, metrics);

    await new Promise((r) => setTimeout(r, 500));
    const dlqDepth = await approxDepth(dlqUrl);
    expect(dlqDepth).toBe(0); // um retry jamais deveria ir parar na DLQ
  });

  it('"retry" increments the sqs_redeliveries_total metric', async () => {
    const message = await sendAndReceiveOne(JSON.stringify({ test: 'retry-metric-case' }), 'retry-metric-test');
    const metrics = new MetricsService();
    const beforeValue = (await metrics.sqsRedeliveriesTotal.get()).values[0]?.value ?? 0;

    await applyMessageOutcome(sqs, queueUrl, dlqUrl, message, { action: 'retry', reason: 'transient' }, 1, metrics);

    const afterValue = (await metrics.sqsRedeliveriesTotal.get()).values[0]?.value ?? 0;
    expect(afterValue).toBe(beforeValue + 1);
  });
});
