import { v4 as uuid } from 'uuid';
import { WagerTransaction } from '../wager-transaction/wager-transaction';
import { FailureCode } from '../wager-transaction/failure-code';
import { MoneyProps } from '../money/money';
import { EventContext, IntegrationEvent } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) {
      throw new Error('Cannot build WagerTransactionRejected without a failureCode');
    }
    return new WagerTransactionRejected({
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
        failureCode: tx.failureCode,
      },
    });
  }
}
