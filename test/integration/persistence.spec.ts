/**
 * Testes de INTEGRAÇÃO — rodam contra um PostgreSQL real (via docker-compose).
 * Não usam mocks para o banco: é exatamente o que a seção 13 exige
 * ("testes que substituem completamente PostgreSQL e SQS por mocks" é
 * eliminatório). Rode com:
 *
 *   docker compose up -d postgres localstack
 *   bun run migration:run
 *   bun test test/integration
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { AppDataSource } from '../../src/infra/database/data-source';
import { createWallet } from '../../src/application/wallets/create-wallet.use-case';
import { submitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction.use-case';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction';
import { OutboxMessageEntity, InboxMessageEntity } from '../../src/infra/database/entities/messaging.entity';
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
  // Isola cada teste — mais simples e explícito que transações aninhadas para
  // testes que exercitam corrida/concorrência real entre conexões.
  await dataSource.query('TRUNCATE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE');
});

describe('Migrations & schema constraints', () => {
  it('rejects a negative wallet balance at the database level', async () => {
    await expect(
      dataSource.query(`INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, 'BRL', -10.00)`, [uuid(), uuid()]),
    ).rejects.toThrow();
  });

  it('rejects a duplicate wallet for the same (player_id, currency)', async () => {
    const playerId = uuid();
    await dataSource.transaction((m) => createWallet(m, { playerId, initialBalance: Money.zero('BRL'), correlationId: 'c' }));
    await expect(
      dataSource.transaction((m) => createWallet(m, { playerId, initialBalance: Money.zero('BRL'), correlationId: 'c' })),
    ).rejects.toThrow();
  });

  it('rejects a duplicate idempotency_key at the database level', async () => {
    const id = uuid();
    await dataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, 'BRL', 100.00)`,
      [id, uuid()],
    );
    const insertTx = () =>
      dataSource.query(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
         VALUES ($1, 'provider-a', $2, 'same-key', 'hash', $3, $4, 'r1', 'g1', 'BET', 10.00, 'BRL', 'PENDING')`,
        [uuid(), uuid().toString(), id, uuid()],
      );
    await insertTx();
    await expect(insertTx()).rejects.toThrow();
  });
});

describe('Atomicity: wallet + ledger + transaction + outbox in one commit', () => {
  it('persists everything together on a successful BET', async () => {
    const playerId = uuid();
    const wallet = await dataSource.transaction((m) =>
      createWallet(m, { playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: 'c' }),
    );

    const idempotencyKey = 'provider-a:ext-bet-1';
    const result = await dataSource.transaction((m) =>
      submitWagerTransaction(m, {
        idempotencyKey,
        providerId: 'provider-a',
        externalTransactionId: 'ext-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        correlationId: 'corr-1',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('75.00');

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletRow.balance).toBe('75.00');

    const ledgerRows = await dataSource.getRepository(WalletLedgerEntryEntity).find({ where: { walletId: wallet.id } });
    // OPENING (crédito dos 100.00 iniciais) + BET (débito de 25.00) = 2 lançamentos.
    expect(ledgerRows.length).toBe(2);

    const outboxRows = await dataSource.getRepository(OutboxMessageEntity).find();
    expect(outboxRows.length).toBeGreaterThan(0);
  });

  it('idempotent replay returns the same result without creating a second ledger entry', async () => {
    const playerId = uuid();
    const wallet = await dataSource.transaction((m) =>
      createWallet(m, { playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: 'c' }),
    );
    const command = {
      idempotencyKey: 'provider-a:ext-replay-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-replay-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      correlationId: 'corr-1',
    };

    const first = await dataSource.transaction((m) => submitWagerTransaction(m, command));
    const second = await dataSource.transaction((m) => submitWagerTransaction(m, command));

    expect(first.idempotentReplay).toBe(false);
    expect(second.idempotentReplay).toBe(true);
    expect(second.balance).toEqual(first.balance);

    const ledgerRows = await dataSource
      .getRepository(WalletLedgerEntryEntity)
      .find({ where: { transactionId: first.transactionId } });
    expect(ledgerRows.length).toBe(1);
  });

  it('same idempotency key with a different payload is a conflict, not a replay', async () => {
    const playerId = uuid();
    const wallet = await dataSource.transaction((m) =>
      createWallet(m, { playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: 'c' }),
    );
    const base = {
      idempotencyKey: 'provider-a:ext-conflict-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-conflict-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      correlationId: 'corr-1',
    };
    await dataSource.transaction((m) => submitWagerTransaction(m, { ...base, money: Money.from({ amount: '10.00', currency: 'BRL' }) }));
    await expect(
      dataSource.transaction((m) => submitWagerTransaction(m, { ...base, money: Money.from({ amount: '99.00', currency: 'BRL' }) })),
    ).rejects.toThrow();
  });
});

describe('Inbox: dedup and redelivery', () => {
  it('a second insert for the same (consumer, messageId) violates the unique constraint', async () => {
    await dataSource.getRepository(InboxMessageEntity).insert({ consumerName: 'c1', messageId: 'm1', payloadHash: 'h1' });
    await expect(dataSource.getRepository(InboxMessageEntity).insert({ consumerName: 'c1', messageId: 'm1', payloadHash: 'h1' })).rejects.toThrow();
  });
});
