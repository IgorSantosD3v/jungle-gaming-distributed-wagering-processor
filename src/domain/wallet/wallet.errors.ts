import { DomainError } from '../money/money.errors';

export class InsufficientBalanceError extends DomainError {
  constructor(walletId: string) {
    super(`Wallet "${walletId}" has insufficient balance for this debit`, 'INSUFFICIENT_BALANCE');
  }
}

export class NegativeBalanceError extends DomainError {
  constructor(walletId: string) {
    super(`Operation on wallet "${walletId}" would result in a negative balance`, 'NEGATIVE_BALANCE');
  }
}
