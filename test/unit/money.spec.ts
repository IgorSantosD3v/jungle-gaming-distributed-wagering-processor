import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyAmountError } from '../../src/domain/money/money.errors';

describe('Money', () => {
  it('creates from a valid decimal string', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('adds and subtracts preserving scale', () => {
    const a = Money.from({ amount: '10.10', currency: 'BRL' });
    const b = Money.from({ amount: '5.05', currency: 'BRL' });
    expect(a.add(b).toJSON().amount).toBe('15.15');
    expect(a.subtract(b).toJSON().amount).toBe('5.05');
  });

  it('is immutable — operations return new instances', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '1.00', currency: 'BRL' });
    const c = a.add(b);
    expect(a.toJSON().amount).toBe('10.00');
    expect(c.toJSON().amount).toBe('11.00');
  });

  it('rejects operations between different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  it('rejects NaN / Infinity / scientific notation / empty string / >2 decimals', () => {
    const bad = ['NaN', 'Infinity', '1e10', '', '10.001', '10,00', 'abc', ' 10.00'];
    for (const amount of bad) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyAmountError);
    }
  });

  it('rejects invalid currency codes', () => {
    expect(() => Money.from({ amount: '10.00', currency: 'brl' })).toThrow(InvalidCurrencyError);
    expect(() => Money.from({ amount: '10.00', currency: 'BR' })).toThrow(InvalidCurrencyError);
  });

  it('zero() builds a zero-value Money for a currency', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  it('isLessThan / equals work as expected', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '20.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
    expect(a.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
  });

  it('negate() flips the sign', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.negate().isNegative()).toBe(true);
  });
});
