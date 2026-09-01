import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';

/**
 * Métricas exigidas pela seção 12 do desafio: transações por status, duplicatas
 * detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e latência
 * de processamento. Um único registry central, injetado onde for preciso —
 * nunca acessado como singleton global, pra manter testável.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly transactionsTotal = new Counter({
    name: 'wager_transactions_total',
    help: 'Total de transações processadas, por kind e status final',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });

  readonly idempotentReplaysTotal = new Counter({
    name: 'wager_idempotent_replays_total',
    help: 'Total de respostas que foram replays idempotentes (duplicata de negócio detectada)',
    registers: [this.registry],
  });

  readonly pendingReferenceRetriesTotal = new Counter({
    name: 'wager_pending_reference_retries_total',
    help: 'Total de tentativas de reprocessamento de transações PENDING_REFERENCE',
    registers: [this.registry],
  });

  readonly pendingReferenceTimeoutsTotal = new Counter({
    name: 'wager_pending_reference_timeouts_total',
    help: 'Total de transações que esgotaram o limite de tentativas de referência e foram rejeitadas por timeout',
    registers: [this.registry],
  });

  readonly outboxPublishedTotal = new Counter({
    name: 'outbox_published_total',
    help: 'Total de eventos publicados com sucesso a partir da outbox',
    registers: [this.registry],
  });

  readonly outboxPublishRetriesTotal = new Counter({
    name: 'outbox_publish_retries_total',
    help: 'Total de falhas de publicação da outbox que geraram um retry agendado',
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade em segundos do evento pendente mais antigo na outbox (0 se não há pendências)',
    registers: [this.registry],
  });

  readonly lockConflictsTotal = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Total de deadlocks detectados pelo Postgres (SQLSTATE 40P01) em transações financeiras',
    registers: [this.registry],
  });

  readonly sqsRedeliveriesTotal = new Counter({
    name: 'sqs_redeliveries_total',
    help: 'Total de mensagens SQS não confirmadas (ack) e deixadas para reentrega',
    registers: [this.registry],
  });

  readonly dlqDepth = new Gauge({
    name: 'sqs_dlq_depth',
    help: 'Número aproximado de mensagens atualmente na dead-letter queue',
    registers: [this.registry],
  });

  readonly transactionProcessingDurationSeconds = new Gauge({
    name: 'wager_transaction_processing_duration_seconds',
    help: 'Duração da última chamada a submitWagerTransaction (latência de processamento)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  /** Postgres SQLSTATE 40P01 = deadlock_detected. */
  isDeadlockError(err: unknown): boolean {
    const e = err as { code?: string; driverError?: { code?: string } };
    return (e?.driverError?.code ?? e?.code) === '40P01';
  }
}
