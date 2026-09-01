/**
 * "Worker morto depois do commit e antes do ack" (seção 13) — testado no nível
 * exato onde a garantia precisa valer: processIncomingMessage() é a função pura
 * que o consumidor real chama; o "ack" em si (DeleteMessage no SQS) é uma
 * camada fina por cima dela. Simulamos o crash simplesmente NUNCA avançando
 * para esse passo depois da primeira chamada, e então chamando a função de
 * novo com o EXATO mesmo corpo de mensagem — exatamente o que o SQS faz ao
 * reentregar uma mensagem que nunca recebeu ack.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { AppDataSource } from '../../src/infra/database/data-source';
import { MetricsService } from '../../src/infra/observability/metrics.service';
import { processIncomingMessage, WAGER_TRANSACTIONS_CONSUMER_NAME } from '../../src/infra/messaging/process-incoming-message';
import { createWallet } from '../../src/application/wallets/create-wallet.use-case';
import { Money } from '../../src/domain/money/money';
import { WalletEntity } from '../../src/infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infra/database/entities/wallet-ledger-entry.entity';
import { InboxMessageEntity } from '../../src/infra/database/entities/messaging.entity';

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

describe('Consumer crash recovery: worker dies after commit, before ack', () => {
  it('a second delivery of the same message after a simulated crash does not double-process', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();

    const messageBody = JSON.stringify({
      messageId: 'msg-crash-test-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'crash-bet-1',
        idempotencyKey: 'provider-a:crash-bet-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    });

    // 1ª entrega: processa de verdade. O commit acontece aqui dentro. Depois
    // disso, em produção, o worker chamaria DeleteMessage — mas "morre" antes.
    const firstOutcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, messageBody);
    expect(firstOutcome.action).toBe('ack');

    const walletAfterFirst = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletAfterFirst.balance).toBe('70.00');

    const inboxRow = await dataSource
      .getRepository(InboxMessageEntity)
      .findOneByOrFail({ consumerName: WAGER_TRANSACTIONS_CONSUMER_NAME, messageId: 'msg-crash-test-1' });
    expect(inboxRow.processedAt).not.toBeNull();

    // 2ª entrega: o SQS reentrega a MESMA mensagem (nunca recebeu ack). Uma nova
    // "instância" do worker (ou a mesma, reiniciada) processa de novo.
    const secondOutcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, messageBody);
    expect(secondOutcome.action).toBe('ack'); // seguro dar ack agora — nada foi reprocessado

    const walletAfterSecond = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletAfterSecond.balance).toBe('70.00'); // NÃO debitou de novo

    const debitEntries = await dataSource
      .getRepository(WalletLedgerEntryEntity)
      .find({ where: { walletId: wallet.id, direction: 'DEBIT' as any } });
    expect(debitEntries.length).toBe(1); // exatamente um lançamento, não dois
  });

  it('three redeliveries of the same message still result in exactly one debit', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();

    const messageBody = JSON.stringify({
      messageId: 'msg-crash-test-2',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'crash-bet-2',
        idempotencyKey: 'provider-a:crash-bet-2',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });

    for (let i = 0; i < 3; i++) {
      const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, messageBody);
      expect(outcome.action).toBe('ack');
    }

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletRow.balance).toBe('90.00'); // 100 - 10, uma única vez
  });
});

describe('Consumer: malformed payload goes straight to dead_letter, never to retry', () => {
  it('invalid JSON returns dead_letter without touching the database', async () => {
    const metrics = new MetricsService();
    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, '{not valid json');
    expect(outcome.action).toBe('dead_letter');
  });

  it('valid JSON missing required envelope fields also goes to dead_letter', async () => {
    const metrics = new MetricsService();
    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, JSON.stringify({ foo: 'bar' }));
    expect(outcome.action).toBe('dead_letter');
  });

  it('a message with kind "OPENING" is dead-lettered and NEVER credits the wallet (OPENING is internal-only, seção 6.3)', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();
    const maliciousBody = JSON.stringify({
      messageId: 'msg-opening-attack',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'free-money-1',
        idempotencyKey: 'provider-a:free-money-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'OPENING',
        money: { amount: '999999.00', currency: 'BRL' },
      },
    });

    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, maliciousBody);
    expect(outcome.action).toBe('dead_letter');

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletRow.balance).toBe('100.00'); // inalterado — nenhum crédito indevido
  });

  it('a message with a bogus kind string is also dead-lettered', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();
    const body = JSON.stringify({
      messageId: 'msg-bogus-kind',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'bogus-1',
        idempotencyKey: 'provider-a:bogus-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'NOT_A_REAL_KIND',
        money: { amount: '5.00', currency: 'BRL' },
      },
    });

    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, body);
    expect(outcome.action).toBe('dead_letter');
  });

  it('a message with a non-UUID walletId goes to dead_letter, not retry (seção 2: fila sujeita às mesmas validações de domínio)', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();
    const body = JSON.stringify({
      messageId: 'msg-bad-wallet-id',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'bad-wallet-1',
        idempotencyKey: 'provider-a:bad-wallet-1',
        playerId: wallet.playerId,
        walletId: 'not-a-real-uuid',
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    });

    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, body);
    // Sem a validação explícita, isso estouraria como um erro cru do Postgres
    // ("invalid input syntax for type uuid") e cairia em "retry" por engano —
    // um erro permanente sendo tratado como transitório.
    expect(outcome.action).toBe('dead_letter');
  });

  it('a message with a non-UUID playerId also goes to dead_letter', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();
    const body = JSON.stringify({
      messageId: 'msg-bad-player-id',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'bad-player-1',
        idempotencyKey: 'provider-a:bad-player-1',
        playerId: 'also-not-a-uuid',
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    });

    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, body);
    expect(outcome.action).toBe('dead_letter');
  });

  it('a message missing providerId goes to dead_letter', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new MetricsService();
    const body = JSON.stringify({
      messageId: 'msg-missing-provider',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        externalTransactionId: 'no-provider-1',
        idempotencyKey: 'provider-a:no-provider-1',
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r1',
        gameId: 'g1',
        kind: 'BET',
        money: { amount: '5.00', currency: 'BRL' },
      },
    });

    const outcome = await processIncomingMessage(dataSource, metrics, WAGER_TRANSACTIONS_CONSUMER_NAME, body);
    expect(outcome.action).toBe('dead_letter');
  });
});
