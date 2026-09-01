import { DomainError } from '../money/money.errors';

/** Tentativa de transicionar uma transação que já está em estado terminal — erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  constructor(currentStatus: string, attemptedTransition: string) {
    super(
      `Cannot apply transition "${attemptedTransition}" to transaction in terminal state "${currentStatus}"`,
      'INVALID_TRANSACTION_STATE',
    );
  }
}

export class MissingReferenceError extends DomainError {
  constructor(kind: string) {
    super(`Transaction kind "${kind}" requires referenceExternalTransactionId`, 'MISSING_REFERENCE');
  }
}
