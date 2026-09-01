import { describe, expect, it } from 'bun:test';
import { WalletLedgerEntry, UnbalancedLedgerEntryError } from '../../src/domain/ledger/wallet-ledger-entry';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { Money } from '../../src/domain/money/money';

function money(amount: string) {
  return Money.from({ amount, currency: 'BRL' });
}

describe('WalletLedgerEntry', () => {
  it('creates a balanced CREDIT entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 'tx1',
      direction: LedgerDirection.Credit,
      money: money('10.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('110.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced DEBIT entry', () => {
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 'tx1',
      direction: LedgerDirection.Debit,
      money: money('30.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('70.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects an unbalanced entry at construction time', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e1',
        walletId: 'w1',
        transactionId: 'tx1',
        direction: LedgerDirection.Credit,
        money: money('10.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('999.00'), // errado — deveria ser 110.00
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('is structurally immutable — Object.freeze() prevents any runtime mutation', () => {
    const entry = WalletLedgerEntry.create({
      id: 'e1',
      walletId: 'w1',
      transactionId: 'tx1',
      direction: LedgerDirection.Credit,
      money: money('10.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('110.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as any).direction = LedgerDirection.Debit;
    }).toThrow();
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });
});
