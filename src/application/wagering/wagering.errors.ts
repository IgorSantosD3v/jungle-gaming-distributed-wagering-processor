import { DomainError } from '../../domain/money/money.errors';
import { FailureCode } from '../../domain/wager-transaction/failure-code';

/** Mesma Idempotency-Key, payload diferente — HTTP 409, não é replay. */
export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" already used with a different payload`, FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT);
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(`Wallet "${walletId}" not found`, 'WALLET_NOT_FOUND');
  }
}

export class WalletAlreadyExistsError extends DomainError {
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player "${playerId}" and currency "${currency}"`, FailureCode.WALLET_ALREADY_EXISTS);
  }
}
