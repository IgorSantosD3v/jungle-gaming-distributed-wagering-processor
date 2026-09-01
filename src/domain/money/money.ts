import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyAmountError } from './money.errors';

// Decimal.js configurado para nunca usar notação exponencial e nunca arredondar
// silenciosamente em operações que exijam precisão exata de 2 casas.
Decimal.set({ toExpPos: 30, toExpNeg: -30, rounding: Decimal.ROUND_HALF_UP });

export interface MoneyProps {
  /** decimal string, ex.: "25.00" — sempre com escala fixa de 2 casas na entrada de contratos externos */
  amount: string;
  /** ISO-4217, ex.: "BRL" */
  currency: string;
}

const SCALE = 2;

// Aceita apenas dígitos, um único ponto decimal opcional, sinal de menos opcional.
// Rejeita: notação científica (1e10), vírgula, espaços, string vazia, mais de 2 casas.
const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Money é um Value Object imutável. Toda operação retorna uma NOVA instância.
 * Nunca usa number/float para representar o valor monetário — internamente usa
 * Decimal (decimal.js) construído a partir de uma string, e é serializado de volta
 * como string decimal com escala fixa de 2 casas.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);
    Money.assertValidAmountString(props.amount);
    return new Money(new Decimal(props.amount), props.currency);
  }

  /**
   * Uso interno/infra: construir Money a partir de um Decimal já validado
   * (ex.: vindo do banco). Não deve ser usado para validar entrada de contratos externos.
   */
  static fromDecimal(value: Decimal | string, currency: string): Money {
    Money.assertValidCurrency(currency);
    const decimal = value instanceof Decimal ? value : new Decimal(value);
    if (!decimal.isFinite()) {
      throw new InvalidMoneyAmountError(String(value));
    }
    return new Money(decimal.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_UP), currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThanOrEqualTo(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  /** Acesso controlado ao Decimal interno — usado apenas pela camada de persistência. */
  toDecimal(): Decimal {
    return this.value;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError(currency);
    }
  }

  private static assertValidAmountString(amount: string): void {
    if (typeof amount !== 'string' || amount.length === 0) {
      throw new InvalidMoneyAmountError(String(amount));
    }
    // Rejeita NaN, Infinity, notação científica, vírgula, espaços, >2 casas — tudo
    // que não bater exatamente com o padrão de string decimal simples.
    if (!DECIMAL_STRING_PATTERN.test(amount)) {
      throw new InvalidMoneyAmountError(amount);
    }
  }
}
