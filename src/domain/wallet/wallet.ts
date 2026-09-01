import { Money } from '../money/money';
import { LedgerDirection } from '../ledger/ledger-direction';
import { InsufficientBalanceError, NegativeBalanceError } from './wallet.errors';
import { CurrencyMismatchError } from '../money/money.errors';

export interface WalletMutationResult {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Cria uma nova wallet. O crédito de abertura (se initialBalance > 0) é modelado
   * como uma WagerTransaction OPENING + WalletLedgerEntry pela camada de aplicação,
   * na MESMA transação SQL que insere esta wallet — não aqui no construtor, para
   * manter o aggregate livre de efeitos colaterais de persistência.
   */
  static open(props: OpenWalletProps): Wallet {
    const now = props.createdAt ?? new Date();
    // version começa em 1 após a criação (a criação em si já conta como a primeira "versão").
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reidratação a partir da persistência — não revalida regras de transição. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Debita `amount` do saldo. Lança InsufficientBalanceError se o saldo resultante
   * seria negativo — o chamador decide se isso vira REJECTED (regra de negócio) ou
   * outro tratamento; o aggregate apenas garante que NUNCA aplica um débito que
   * deixaria o saldo negativo.
   */
  debit(amount: Money, at: Date = new Date()): WalletMutationResult {
    this.assertSameCurrency(amount);
    const balanceBefore = this._balance;
    if (balanceBefore.isLessThan(amount)) {
      throw new InsufficientBalanceError(this.id);
    }
    const balanceAfter = balanceBefore.subtract(amount);
    this.applyNewBalance(balanceAfter, at);
    return { direction: LedgerDirection.Debit, money: amount, balanceBefore, balanceAfter };
  }

  /** Credita `amount` no saldo. Um crédito nunca pode, por si só, gerar saldo negativo. */
  credit(amount: Money, at: Date = new Date()): WalletMutationResult {
    this.assertSameCurrency(amount);
    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(amount);
    if (balanceAfter.isNegative()) {
      // Defensivo: nunca deveria acontecer com um `amount` não-negativo, mas mantemos
      // a invariante explícita e testável no aggregate.
      throw new NegativeBalanceError(this.id);
    }
    this.applyNewBalance(balanceAfter, at);
    return { direction: LedgerDirection.Credit, money: amount, balanceBefore, balanceAfter };
  }

  /**
   * Aplica uma reversão (ROLLBACK) na direção oposta à transação original.
   * Usa debit/credit internamente para preservar a invariante de saldo não-negativo —
   * uma reversão que deixaria o saldo negativo é rejeitada aqui, e o caller deve
   * traduzir isso para o failureCode REVERSAL_WOULD_OVERDRAW (distinto de
   * INSUFFICIENT_BALANCE de uma aposta comum).
   */
  reverse(direction: LedgerDirection, amount: Money, at: Date = new Date()): WalletMutationResult {
    return direction === LedgerDirection.Credit ? this.credit(amount, at) : this.debit(amount, at);
  }

  private applyNewBalance(balanceAfter: Money, at: Date): void {
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
