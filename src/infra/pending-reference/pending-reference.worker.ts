import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WagerTransactionEntity } from '../database/entities/wager-transaction.entity';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction';
import { FailureCode } from '../../domain/wager-transaction/failure-code';
import { wagerTransactionToDomain } from '../database/mappers';
import { submitWagerTransaction } from '../../application/wagering/submit-wager-transaction.use-case';
import { writeToOutbox } from '../messaging/outbox-writer';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected.event';
import { MetricsService } from '../observability/metrics.service';

const POLL_INTERVAL_MS = 2000;
const BATCH_SIZE = 20;
/** Limite de tentativas antes de desistir e marcar REJECTED — justificativa em ARCHITECTURE.md. */
const MAX_REFERENCE_ATTEMPTS = 8;
const BASE_BACKOFF_SECONDS = 3;
const MAX_BACKOFF_SECONDS = 120;

/**
 * Reprocessa transações em PENDING_REFERENCE: a referência pode ter chegado
 * entre a primeira tentativa e agora (entrega fora de ordem, seção 7.1).
 * Reutiliza o MESMO submitWagerTransaction — a lógica de resolução de
 * referência já sabe lidar com "referência ainda não existe" (permanece
 * PENDING_REFERENCE) vs "referência existe" (processa) vs "esgotou tentativas"
 * (aqui, neste worker, que decide o REJECTED por timeout).
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.logger.log({ event: 'pending_reference_worker_stopped' });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.processDueBatch();
        if (processed === 0) await sleep(POLL_INTERVAL_MS);
      } catch (err) {
        this.logger.error({ event: 'pending_reference_loop_error', errorMessage: (err as Error).message });
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private async processDueBatch(): Promise<number> {
    const repo = this.dataSource.getRepository(WagerTransactionEntity);
    const now = new Date();
    const due = await repo
      .createQueryBuilder('tx')
      .where('tx.status = :status', { status: WagerTransactionStatus.PendingReference })
      .andWhere('(tx.nextReferenceAttemptAt IS NULL OR tx.nextReferenceAttemptAt <= :now)', { now })
      .orderBy('tx.createdAt', 'ASC')
      .limit(BATCH_SIZE)
      .getMany();

    for (const row of due) {
      await this.retryOne(row);
    }
    return due.length;
  }

  private async retryOne(row: WagerTransactionEntity): Promise<void> {
    if (row.referenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
      await this.giveUp(row);
      return;
    }

    try {
      // Reenvia como se fosse a mesma requisição original (mesma idempotencyKey) —
      // o INSERT vai colidir com a linha PENDING_REFERENCE existente, então na
      // prática este caminho é tratado dentro do próprio use case pela resolução
      // de referência: se ainda não encontrar, apenas mantemos PENDING_REFERENCE
      // e incrementamos attempts/backoff aqui.
      const tx = wagerTransactionToDomain(row);
      this.metrics.pendingReferenceRetriesTotal.inc();
      this.logger.log({
        event: 'pending_reference_retry_attempt',
        transactionId: row.id,
        providerId: row.providerId,
        walletId: row.walletId,
        attempt: row.referenceAttempts + 1,
      });
      const result = await this.dataSource.transaction((manager) =>
        submitWagerTransaction(manager, {
          idempotencyKey: tx.idempotencyKey,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          playerId: tx.playerId,
          walletId: tx.walletId,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          money: tx.money,
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          correlationId: `pending-reference-worker:${tx.id}`,
        }),
      );

      if (result.status === WagerTransactionStatus.PendingReference) {
        await this.scheduleNextAttempt(row);
      }
      // Se saiu de PENDING_REFERENCE (PROCESSED ou REJECTED por outro motivo de
      // negócio), o próprio use case já persistiu tudo e publicou o evento certo.
    } catch (err) {
      this.logger.warn({ event: 'pending_reference_retry_failed', transactionId: row.id, providerId: row.providerId, walletId: row.walletId, errorMessage: (err as Error).message });
      await this.scheduleNextAttempt(row);
    }
  }

  private async scheduleNextAttempt(row: WagerTransactionEntity): Promise<void> {
    const attempts = row.referenceAttempts + 1;
    const backoffSeconds = Math.min(BASE_BACKOFF_SECONDS * 2 ** attempts, MAX_BACKOFF_SECONDS);
    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);
    await this.dataSource
      .getRepository(WagerTransactionEntity)
      .update({ id: row.id }, { referenceAttempts: attempts, nextReferenceAttemptAt: nextAttemptAt });
  }

  private async giveUp(row: WagerTransactionEntity): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WagerTransactionEntity);
      // Releitura dentro da transação para evitar rejeitar uma linha que outra
      // instância já processou entre a leitura do batch e agora.
      const fresh = await repo.findOneBy({ id: row.id });
      if (!fresh || fresh.status !== WagerTransactionStatus.PendingReference) return;

      const tx = wagerTransactionToDomain(fresh);
      tx.reject(FailureCode.REFERENCE_NOT_FOUND_TIMEOUT);
      await repo.update({ id: tx.id }, { status: tx.status, failureCode: tx.failureCode });
      await writeToOutbox(manager, WagerTransactionRejected.from(tx, { correlationId: `pending-reference-worker:${tx.id}` }));
    });
    this.metrics.pendingReferenceTimeoutsTotal.inc();
    this.logger.warn({
      event: 'pending_reference_timeout',
      transactionId: row.id,
      providerId: row.providerId,
      walletId: row.walletId,
      maxAttempts: MAX_REFERENCE_ATTEMPTS,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
