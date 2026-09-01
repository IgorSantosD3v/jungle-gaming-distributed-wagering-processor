/**
 * A seção 13 exige testes cobrindo "regras de BET, WIN, LOSS, REFUND,
 * ROLLBACK" (obrigatório, nível de unidade/integração). Os testes anteriores
 * cobriam bem BET (inclusive sob concorrência) e o caminho de REFUND chegando
 * ANTES da referência (PENDING_REFERENCE), mas nunca exercitaram o caminho
 * feliz de REFUND/ROLLBACK de verdade, nem as regras de rejeição da seção 7:
 * "REFUND só referencia BET", "ROLLBACK referencia BET, WIN ou REFUND",
 * "uma referência não pode ser revertida duas vezes", "o valor de REFUND/
 * ROLLBACK deve ser igual ao valor da referência", e a distinção entre
 * INSUFFICIENT_BALANCE (aposta) e REVERSAL_WOULD_OVERDRAW (reversão).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { AppDataSource } from '../../src/infra/database/data-source';
import { createWallet } from '../../src/application/wallets/create-wallet.use-case';
import { submitWagerTransaction, SubmitWagerTransactionResult } from '../../src/application/wagering/submit-wager-transaction.use-case';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import { WalletEntity } from '../../src/infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infra/database/entities/wallet-ledger-entry.entity';

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = await AppDataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE');
});

async function openWallet(initial: string): Promise<{ id: string; playerId: string }> {
  const playerId = uuid();
  const wallet = await dataSource.transaction((m) =>
    createWallet(m, { playerId, initialBalance: Money.from({ amount: initial, currency: 'BRL' }), correlationId: 'setup' }),
  );
  return { id: wallet.id, playerId };
}

function submit(
  wallet: { id: string; playerId: string },
  kind: WagerTransactionKind,
  externalId: string,
  amount: string,
  opts: { referenceExternalTransactionId?: string; roundId?: string; walletId?: string } = {},
): Promise<SubmitWagerTransactionResult> {
  return dataSource.transaction((m) =>
    submitWagerTransaction(m, {
      idempotencyKey: `provider-a:${externalId}`,
      providerId: 'provider-a',
      externalTransactionId: externalId,
      playerId: wallet.playerId,
      walletId: opts.walletId ?? wallet.id,
      roundId: opts.roundId ?? 'round-1',
      gameId: 'game-1',
      kind,
      money: Money.from({ amount, currency: 'BRL' }),
      referenceExternalTransactionId: opts.referenceExternalTransactionId,
      correlationId: 'corr',
    }),
  );
}

describe('BET', () => {
  it('debits the wallet and creates exactly one DEBIT ledger entry', async () => {
    const wallet = await openWallet('100.00');
    const result = await submit(wallet, WagerTransactionKind.Bet, 'bet-1', '25.00');
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('75.00');

    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { transactionId: result.transactionId } });
    expect(entries.length).toBe(1);
    expect(entries[0]!.direction).toBe('DEBIT' as any);
  });
});

describe('WIN', () => {
  it('credits the wallet, creates a ledger entry, and can optionally reference the originating BET', async () => {
    const wallet = await openWallet('100.00');
    const bet = await submit(wallet, WagerTransactionKind.Bet, 'win-bet-1', '20.00');
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const win = await submit(wallet, WagerTransactionKind.Win, 'win-1', '50.00', { referenceExternalTransactionId: 'win-bet-1' });
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance.amount).toBe('130.00'); // 100 - 20 + 50

    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { transactionId: win.transactionId } });
    expect(entries.length).toBe(1);
    expect(entries[0]!.direction).toBe('CREDIT' as any);
  });

  it('also works without any reference at all', async () => {
    const wallet = await openWallet('100.00');
    const win = await submit(wallet, WagerTransactionKind.Win, 'win-noref-1', '10.00');
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance.amount).toBe('110.00');
  });
});

describe('LOSS', () => {
  it('does not move the balance and creates no ledger entry', async () => {
    const wallet = await openWallet('100.00');
    const result = await submit(wallet, WagerTransactionKind.Loss, 'loss-1', '15.00');
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('100.00'); // inalterado

    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { transactionId: result.transactionId } });
    expect(entries.length).toBe(0);

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletRow.balance).toBe('100.00');
  });
});

describe('REFUND', () => {
  it('reverses a PROCESSED BET exactly once, crediting the same amount back', async () => {
    const wallet = await openWallet('100.00');
    const bet = await submit(wallet, WagerTransactionKind.Bet, 'refund-bet-1', '30.00');
    expect(bet.status).toBe(WagerTransactionStatus.Processed);

    const refund = await submit(wallet, WagerTransactionKind.Refund, 'refund-1', '30.00', { referenceExternalTransactionId: 'refund-bet-1' });
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe('100.00'); // voltou ao saldo original

    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { transactionId: refund.transactionId } });
    expect(entries.length).toBe(1);
    expect(entries[0]!.direction).toBe('CREDIT' as any);
  });

  it('rejects a second REFUND of the same BET (already reversed)', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'refund-bet-2', '10.00');
    const first = await submit(wallet, WagerTransactionKind.Refund, 'refund-2a', '10.00', { referenceExternalTransactionId: 'refund-bet-2' });
    expect(first.status).toBe(WagerTransactionStatus.Processed);

    const second = await submit(wallet, WagerTransactionKind.Refund, 'refund-2b', '10.00', { referenceExternalTransactionId: 'refund-bet-2' });
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ALREADY_REVERSED);
  });

  it('rejects a REFUND that references a WIN instead of a BET (invalid reference kind)', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Win, 'refund-win-1', '10.00');
    const refund = await submit(wallet, WagerTransactionKind.Refund, 'refund-3', '10.00', { referenceExternalTransactionId: 'refund-win-1' });
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.INVALID_REFERENCE_KIND);
  });

  it('rejects a REFUND whose amount does not match the referenced BET', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'refund-bet-3', '20.00');
    const refund = await submit(wallet, WagerTransactionKind.Refund, 'refund-4', '999.00', { referenceExternalTransactionId: 'refund-bet-3' });
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.AMOUNT_MISMATCH_WITH_REFERENCE);
  });

  it('rejects a REFUND whose reference belongs to a different round (scope mismatch)', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'refund-bet-4', '10.00', { roundId: 'round-A' });
    const refund = await submit(wallet, WagerTransactionKind.Refund, 'refund-5', '10.00', {
      referenceExternalTransactionId: 'refund-bet-4',
      roundId: 'round-B',
    });
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.REFERENCE_SCOPE_MISMATCH);
  });
});

describe('ROLLBACK', () => {
  it('reverses a PROCESSED BET (credit — the inverse of the original debit)', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'rb-bet-1', '40.00');
    const rollback = await submit(wallet, WagerTransactionKind.Rollback, 'rb-1', '40.00', { referenceExternalTransactionId: 'rb-bet-1' });
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance.amount).toBe('100.00');

    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { transactionId: rollback.transactionId } });
    expect(entries[0]!.direction).toBe('CREDIT' as any);
  });

  it('reverses a PROCESSED WIN (debit — the inverse of the original credit)', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Win, 'rb-win-1', '25.00');
    const rollback = await submit(wallet, WagerTransactionKind.Rollback, 'rb-2', '25.00', { referenceExternalTransactionId: 'rb-win-1' });
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance.amount).toBe('100.00');

    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { transactionId: rollback.transactionId } });
    expect(entries[0]!.direction).toBe('DEBIT' as any);
  });

  it('can also reverse a PROCESSED REFUND', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'rb-bet-2', '10.00');
    await submit(wallet, WagerTransactionKind.Refund, 'rb-refund-1', '10.00', { referenceExternalTransactionId: 'rb-bet-2' });
    // saldo de volta a 100.00 depois do refund; agora reverte o próprio refund (debita de novo)
    const rollback = await submit(wallet, WagerTransactionKind.Rollback, 'rb-3', '10.00', { referenceExternalTransactionId: 'rb-refund-1' });
    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance.amount).toBe('90.00');
  });

  it('rejects a second ROLLBACK of the same transaction (already reversed)', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'rb-bet-3', '5.00');
    const first = await submit(wallet, WagerTransactionKind.Rollback, 'rb-4a', '5.00', { referenceExternalTransactionId: 'rb-bet-3' });
    expect(first.status).toBe(WagerTransactionStatus.Processed);

    const second = await submit(wallet, WagerTransactionKind.Rollback, 'rb-4b', '5.00', { referenceExternalTransactionId: 'rb-bet-3' });
    expect(second.status).toBe(WagerTransactionStatus.Rejected);
    expect(second.failureCode).toBe(FailureCode.ALREADY_REVERSED);
  });

  it('rejects a ROLLBACK that would leave the balance negative, with a code distinct from INSUFFICIENT_BALANCE', async () => {
    const wallet = await openWallet('50.00');
    // WIN credita 50 -> saldo 100. Depois, uma BET gasta praticamente tudo.
    await submit(wallet, WagerTransactionKind.Win, 'rb-win-2', '50.00');
    await submit(wallet, WagerTransactionKind.Bet, 'rb-bet-4', '95.00'); // saldo agora 5.00

    // Reverter o WIN de 50.00 exigiria debitar 50.00 de um saldo de apenas 5.00.
    const rollback = await submit(wallet, WagerTransactionKind.Rollback, 'rb-5', '50.00', { referenceExternalTransactionId: 'rb-win-2' });
    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.REVERSAL_WOULD_OVERDRAW);
    expect(rollback.failureCode).not.toBe(FailureCode.INSUFFICIENT_BALANCE); // código distinto, exigido pela seção 7
  });
});

describe('Final invariant: wallet.balance == saldo reconstruído pelo ledger', () => {
  it('holds after a full mix of BET, WIN, LOSS, REFUND and ROLLBACK', async () => {
    const wallet = await openWallet('100.00');
    await submit(wallet, WagerTransactionKind.Bet, 'inv-bet-1', '20.00'); // 80
    await submit(wallet, WagerTransactionKind.Win, 'inv-win-1', '15.00'); // 95
    await submit(wallet, WagerTransactionKind.Loss, 'inv-loss-1', '999.00'); // 95 (sem efeito)
    await submit(wallet, WagerTransactionKind.Refund, 'inv-refund-1', '20.00', { referenceExternalTransactionId: 'inv-bet-1' }); // 115
    await submit(wallet, WagerTransactionKind.Rollback, 'inv-rb-1', '15.00', { referenceExternalTransactionId: 'inv-win-1' }); // 100

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    const entries = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { walletId: wallet.id } });

    let reconstructed = entries
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .reduce((bal, e) => (e.direction === ('CREDIT' as any) ? bal + Number(e.amount) : bal - Number(e.amount)), 0);

    expect(Number(walletRow.balance)).toBe(100);
    expect(reconstructed).toBe(100);
    expect(Number(walletRow.balance)).toBe(reconstructed);
  });
});
