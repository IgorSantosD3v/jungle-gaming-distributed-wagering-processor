import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/wallet/wallet';
import { Money } from '../../src/domain/money/money';
import { InsufficientBalanceError } from '../../src/domain/wallet/wallet.errors';
import { CurrencyMismatchError } from '../../src/domain/money/money.errors';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';

function money(amount: string, currency = 'BRL') {
  return Money.from({ amount, currency });
}

describe('Wallet', () => {
  it('opens with version 1 and the given initial balance', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  it('debits reduce balance and increment version', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    const result = wallet.debit(money('30.00'));
    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(result.direction).toBe(LedgerDirection.Debit);
    expect(result.balanceBefore.toJSON().amount).toBe('100.00');
    expect(result.balanceAfter.toJSON().amount).toBe('70.00');
  });

  it('rejects a debit that would leave the balance negative — mandatory scenario (100, two bets of 80)', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    wallet.debit(money('80.00'));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(() => wallet.debit(money('80.00'))).toThrow(InsufficientBalanceError);
    // saldo e version não mudam após a rejeição
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('credits increase balance and increment version', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('100.00') });
    wallet.credit(money('25.00'));
    expect(wallet.balance.toJSON().amount).toBe('125.00');
    expect(wallet.version).toBe(2);
  });

  it('never mutates on a rejected operation (no lost update on the failing branch)', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00') });
    const versionBefore = wallet.version;
    expect(() => wallet.debit(money('20.00'))).toThrow(InsufficientBalanceError);
    expect(wallet.version).toBe(versionBefore);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
  });

  it('rejects operations in a different currency than the wallet', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00', 'BRL') });
    expect(() => wallet.debit(money('5.00', 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('reverse() applies credit or debit depending on direction, and can overdraw-reject', () => {
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money('10.00') });
    wallet.reverse(LedgerDirection.Credit, money('5.00'));
    expect(wallet.balance.toJSON().amount).toBe('15.00');
    expect(() => wallet.reverse(LedgerDirection.Debit, money('100.00'))).toThrow(InsufficientBalanceError);
  });
});
