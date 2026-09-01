import { v4 as uuid } from 'uuid';
import { WagerTransaction } from '../wager-transaction/wager-transaction';
import { MoneyProps } from '../money/money';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

/** Publicado para QUALQUER transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: uuid(),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: new Date(),
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
        processedAt: (tx.processedAt ?? new Date()).toISOString(),
      },
    });
  }
}
