/**
 * A seção 8 pede explicitamente correção com "três ou mais instâncias" rodando
 * simultaneamente. Os outros testes de concorrência já exercitam paralelismo
 * real (múltiplas conexões/transações), mas todas dentro do MESMO processo
 * Bun. Este arquivo vai além: cada tentativa roda como um PROCESSO SEPARADO do
 * sistema operacional (via Bun.spawn), cada um abrindo sua própria conexão
 * independente ao Postgres — a interpretação mais literal possível de
 * "instâncias simultâneas" sem precisar subir 3 servidores HTTP completos.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'bun:test';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import { AppDataSource } from '../../src/infra/database/data-source';
import { createWallet } from '../../src/application/wallets/create-wallet.use-case';
import { Money } from '../../src/domain/money/money';
import { WalletEntity } from '../../src/infra/database/entities/wallet.entity';
import { WalletLedgerEntryEntity } from '../../src/infra/database/entities/wallet-ledger-entry.entity';

let dataSource: DataSource;
const FIXTURE = path.join(__dirname, 'fixtures', 'submit-bet-process.ts');

beforeAll(async () => {
  dataSource = await AppDataSource.initialize();
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE');
});

interface ChildResult {
  status?: string;
  failureCode?: string;
  balance?: { amount: string };
  error?: string;
}

async function runAsSeparateProcess(walletId: string, playerId: string, externalId: string, amount: string): Promise<ChildResult> {
  const proc = Bun.spawn(['bun', 'run', FIXTURE, walletId, playerId, externalId, amount], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0 && !stdout.trim()) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Child process failed with no output. stderr: ${stderr}`);
  }
  const lastLine = stdout.trim().split('\n').pop() ?? '{}';
  return JSON.parse(lastLine);
}

describe('Three separate OS processes competing for the same wallet', () => {
  it('exactly one BET of 80.00 processes on a 100.00 wallet contested by 3 real processes; final balance is 20.00', async () => {
    const playerId = uuid();
    const wallet = await dataSource.transaction((m) =>
      createWallet(m, { playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: 'setup' }),
    );

    const results = await Promise.all([
      runAsSeparateProcess(wallet.id, playerId, 'proc-bet-1', '80.00'),
      runAsSeparateProcess(wallet.id, playerId, 'proc-bet-2', '80.00'),
      runAsSeparateProcess(wallet.id, playerId, 'proc-bet-3', '80.00'),
    ]);

    for (const r of results) {
      expect(r.error).toBeUndefined();
    }

    const processed = results.filter((r) => r.status === 'PROCESSED');
    const rejected = results.filter((r) => r.status === 'REJECTED');
    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(2);
    expect(rejected.every((r) => r.failureCode === 'BUSINESS_INSUFFICIENT_BALANCE')).toBe(true);

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(walletRow.balance).toBe('20.00');

    const debitEntries = await dataSource
      .getRepository(WalletLedgerEntryEntity)
      .find({ where: { walletId: wallet.id, direction: 'DEBIT' as any } });
    expect(debitEntries.length).toBe(1);
  }, 30000);

  it('five real processes hitting a 100.00 wallet with 30.00 bets each: at most 3 succeed, balance never negative', async () => {
    const playerId = uuid();
    const wallet = await dataSource.transaction((m) =>
      createWallet(m, { playerId, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: 'setup' }),
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => runAsSeparateProcess(wallet.id, playerId, `proc-multi-${i}`, '30.00')),
    );

    for (const r of results) expect(r.error).toBeUndefined();

    const processedCount = results.filter((r) => r.status === 'PROCESSED').length;
    expect(processedCount).toBeLessThanOrEqual(3); // 100 / 30 = 3.33 -> no máximo 3 cabem

    const walletRow = await dataSource.getRepository(WalletEntity).findOneByOrFail({ id: wallet.id });
    expect(Number(walletRow.balance)).toBeGreaterThanOrEqual(0);
    expect(Number(walletRow.balance)).toBe(100 - processedCount * 30);
  }, 30000);
});
