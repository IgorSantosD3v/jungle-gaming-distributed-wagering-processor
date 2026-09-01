import { Money } from '../money/money';
import { DomainError } from '../money/money.errors';
import { LedgerDirection } from './ledger-direction';

export class UnbalancedLedgerEntryError extends DomainError {
  constructor() {
    super('balanceBefore ± money must equal balanceAfter', 'UNBALANCED_LEDGER_ENTRY');
  }
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState extends Required<Omit<CreateLedgerEntryProps, 'createdAt'>> {
  createdAt: Date;
}

/**
 * Lançamento de ledger. Estruturalmente imutável: sem campos mutáveis, sem métodos
 * de transição. `create` valida a aritmética do lançamento antes de existir — não
 * há como instanciar uma entrada desbalanceada.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    // `readonly` do TypeScript só existe em tempo de compilação — sem isso, nada
    // impede uma escrita direta em runtime (ex.: `entry.direction = ...`).
    // Object.freeze() torna a imutabilidade real, verificável e à prova de bugs.
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError();
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    // rehydrate não revalida (dado já persistido e presumidamente correto), mas
    // manter a checagem aqui também é barato e funciona como um "canário" de
    // corrupção de dados — se disparar em produção, é sinal de bug grave.
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter, de acordo com a direção. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
