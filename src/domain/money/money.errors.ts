export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada inválida: NaN, Infinity, notação científica, string vazia, >2 casas, negativo onde não permitido. */
export class InvalidMoneyAmountError extends DomainError {
  constructor(amount: string) {
    super(`Invalid monetary amount: "${amount}"`, 'INVALID_MONEY_AMOUNT');
  }
}

export class InvalidCurrencyError extends DomainError {
  constructor(currency: string) {
    super(`Invalid ISO-4217 currency code: "${currency}"`, 'INVALID_CURRENCY');
  }
}

/** Operação entre Money de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super(`Currency mismatch: "${a}" vs "${b}"`, 'CURRENCY_MISMATCH');
  }
}
