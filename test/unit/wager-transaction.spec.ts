import { describe, expect, it } from 'bun:test';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction';
import { MissingReferenceError, InvalidTransactionStateError } from '../../src/domain/wager-transaction/wager-transaction.errors';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import { Money } from '../../src/domain/money/money';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';

function baseProps(overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  return {
    id: 'tx1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('WagerTransaction', () => {
  it('is born PENDING', () => {
    const tx = WagerTransaction.create(baseProps());
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  it('REFUND and ROLLBACK require a reference; BET/WIN/LOSS do not', () => {
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund }))).toThrow(MissingReferenceError);
    expect(() => WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Rollback }))).toThrow(MissingReferenceError);
    expect(() =>
      WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ext-0' })),
    ).not.toThrow();
  });

  it('terminal states cannot transition again', () => {
    const tx = WagerTransaction.create(baseProps());
    tx.markProcessed(undefined, new Date());
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.reject(FailureCode.INSUFFICIENT_BALANCE)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.INFRA_UNAVAILABLE)).toThrow(InvalidTransactionStateError);
  });

  it('LOSS does not affect balance; REJECTED never affects balance regardless of kind', () => {
    const loss = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Loss }));
    expect(loss.affectsBalance()).toBe(false);

    const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    bet.reject(FailureCode.INSUFFICIENT_BALANCE);
    expect(bet.affectsBalance()).toBe(false);
  });

  it('ledgerDirectionFor: BET->DEBIT, WIN/REFUND->CREDIT, ROLLBACK flips the referenced direction', () => {
    const bet = WagerTransaction.create(baseProps({ kind: WagerTransactionKind.Bet }));
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);

    const win = WagerTransaction.create(baseProps({ id: 'tx2', externalTransactionId: 'ext-2', idempotencyKey: 'k2', kind: WagerTransactionKind.Win }));
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const rollbackOfBet = WagerTransaction.create(
      baseProps({ id: 'tx3', externalTransactionId: 'ext-3', idempotencyKey: 'k3', kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-1' }),
    );
    // Reverter uma BET (que foi DEBIT) deve gerar CREDIT.
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const rollbackOfWin = WagerTransaction.create(
      baseProps({ id: 'tx4', externalTransactionId: 'ext-4', idempotencyKey: 'k4', kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ext-2' }),
    );
    // Reverter um WIN (que foi CREDIT) deve gerar DEBIT.
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('matchesPayload compares the stored payloadHash', () => {
    const tx = WagerTransaction.create(baseProps({ payloadHash: 'abc' }));
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });

  it('rehydrate does not revalidate transitions', () => {
    const tx = WagerTransaction.rehydrate({
      ...baseProps({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: undefined }),
      status: WagerTransactionStatus.Processed,
    } as any);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });
});
